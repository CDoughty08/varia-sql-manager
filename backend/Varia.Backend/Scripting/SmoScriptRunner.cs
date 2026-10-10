using System.Data;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.Management.Common;
using Microsoft.SqlServer.Management.Smo;
using Microsoft.SqlServer.Management.Sdk.Sfc;

namespace Varia.Backend.Scripting;

/// <summary>SMO refused to find the object the preflight found (it was dropped in between).</summary>
internal sealed class SmoObjectMissingException() : Exception("The object no longer exists.");

/// <summary>DDL through SMO's Scripter (spec C4), as sqltoolsservice's Script As runs it: a fresh Server per job, so a
/// definition changed in a query tab is never served from a cache, and prefetch only for the object's own children
/// (<see cref="PrefetchKinds"/>). Runs on the job's dedicated thread.</summary>
internal sealed class SmoScriptRunner
{
    /// <summary>Child collections SMO otherwise reads property by property; never Server, Database or Table, whose
    /// full property sets would be read for every object of the type.</summary>
    internal static readonly Type[] ChildInitTypes =
    [
        typeof(Column), typeof(Microsoft.SqlServer.Management.Smo.Index), typeof(IndexedColumn), typeof(ForeignKey), typeof(ForeignKeyColumn), typeof(Check),
        typeof(DefaultConstraint), typeof(ExtendedProperty), typeof(Trigger), typeof(Statistic), typeof(StatisticColumn), typeof(StoredProcedureParameter),
        typeof(UserDefinedFunctionParameter), typeof(EdgeConstraint)
    ];

    private readonly ScriptSession session;
    private readonly CancellationToken token;
    private Server? server;

    public SmoScriptRunner(ScriptSession session, CancellationToken token)
    {
        this.session = session;
        this.token = token;
    }

    /// <summary>The script's version for messages about SMO's refusals.</summary>
    public SqlServerVersion? Target { get; private set; }

    /// <summary>ScriptingServiceOptions.BeforeDependencies: runs with the target's database just before SMO's dependency
    /// walk (live checks change the database's state there).</summary>
    internal Action<string>? BeforeDependencies { get; init; }

    private Server Server()
    {
        if (server is not null) return server;
        var connection = new ServerConnection(session.Connection) { StatementTimeout = 30, LockTimeout = 10, AutoDisconnectMode = AutoDisconnectMode.NoAutoDisconnect };
        server = new Server(connection);
        var edition = SmoOptionsMapper.Edition(session.Profile.EngineEdition);
        foreach (var type in ChildInitTypes) server.SetDefaultInitFields(type, true, edition);
        return server;
    }

    /// <summary>One target's batches, framed, at most <paramref name="max"/> characters. A header that fails HeaderGuard
    /// makes SMO script the target again without headers; the headers stay when they are all the two scripts differ in.
    /// SMO 181 writes no header when asked for none (a live check pins this for every kind), so a script without headers
    /// is not guarded: any "/****** Object:" in it is a definition's own text, which SMO keeps as stored. SMO's comment
    /// for an unresolved reference, written with headers on or off, is left out (<see cref="Run"/>), with a warning
    /// naming the references; any other comment batch of SMO's that a name breaks refuses the script.</summary>
    public string Script(ResolvedTarget target, ScriptVerb verb, ScriptingOptionsDto dto, long max, List<string> warnings)
    {
        CultureInfo.CurrentCulture = ScriptingCulture.Formatting;
        CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo("en-US");
        if (target.Kind == "credential") return Credential(target, verb, dto, max, warnings);
        var smo = Server();
        var urn = new Urn(UrnBuilder.Build(smo.Urn.Value, target.Kind, target.Row.Urn, target.Ref, target.ParentUrnType, target.Column));
        var dependencies = dto.GenerateDependentObjects && SmoOptionsMapper.Dependencies(target.Row.Urn, target.ParentUrnType, target.Ref.Database is null);
        // The pass that reads definitions: CREATE (DROP And CREATE's second pass too), ALTER or CREATE OR ALTER.
        var reading = SmoOptionsMapper.Passes(verb)[^1];
        var scripted = new ScriptedObjects();
        scripted.Add(target.Row.Urn, target.Ref.Name);
        if (reading != ScriptVerb.Drop) CheckDefinitions(smo, urn, target, dto, reading, dependencies ? SmoOptionsMapper.Walk(reading) : null, max, scripted);
        if (verb == ScriptVerb.Alter)
        {
            // Without Touch, SMO writes nothing for ALTER (sqltoolsservice does the same).
            (smo.GetSmoObject(urn) ?? throw new SmoObjectMissingException()).Touch();
        }
        var unresolved = new List<Urn>();
        var batches = Run(smo, urn, target, verb, dto, max, dto.IncludeHeaders, dependencies, warnings, unresolved, scripted);
        if (dto.IncludeHeaders && !batches.All(HeaderGuard.Safe))
        {
            var plain = Run(smo, urn, target, verb, dto, max, headers: false, dependencies, warnings, unresolved, scripted);
            if (!HeaderGuard.Aligned(batches, plain))
            {
                batches = plain;
                if (!warnings.Contains(HeaderGuard.Warning)) warnings.Add(HeaderGuard.Warning);
            }
        }
        // The last line of defence for a comment kind SMO may add: none of its comment batches may hold a name that ends
        // the comment early or breaks it over lines. A definition of an object the script creates keeps its own text,
        // whose comments may look like SMO's at both ends.
        if (!HeaderGuard.Closed(batches, module => scripted.Defines(module, dto.ScriptTriggers))) throw new ScriptRefusedException(BrokenComment);
        if (unresolved.Count > 0 && UnresolvedWarning(unresolved, urn) is var notice && !warnings.Contains(notice)) warnings.Add(notice);
        var text = new StringBuilder();
        foreach (var batch in batches)
        {
            if (!warnings.Contains(SplitWarning) && Splits(batch)) warnings.Add(SplitWarning);
            text.Append(ScriptFormatter.Frame(batch, dto.DelimitStatements));
            if (text.Length > max) throw new ScriptTooLargeException();
        }
        return text.ToString();
    }

    /// <summary>The preflight bounds the target's own definition; Script triggers and Generate script for dependent
    /// objects make SMO read other modules too, which are bounded here before SMO runs (spec F: no definition over
    /// 8,000,000 bytes reaches managed memory, and none that could not fit in the script together). The dependencies are
    /// SMO's own walk in the direction the pass takes (<see cref="SmoOptionsMapper.Walk"/>: none for ALTER), which the
    /// scripter repeats, and may lie in other databases (three-part names, synonyms). SMO reads no definition for a
    /// reference it could not resolve (a missing object or database) or one on a linked server, so neither is checked: it
    /// writes a comment for each instead, which <see cref="Run"/> leaves out. The walk's objects go to
    /// <paramref name="scripted"/>.</summary>
    private void CheckDefinitions(Server smo, Urn urn, ResolvedTarget target, ScriptingOptionsDto dto, ScriptVerb pass, DependencyType? walk, long max, ScriptedObjects scripted)
    {
        // A table's or view's triggers come with the object itself, not with one of its indexes or keys; SMO's ALTER of a
        // view writes the view alone.
        var triggered = dto.ScriptTriggers && target.Kind is "table" or "view" && pass != ScriptVerb.Alter;
        if (target.Ref.Database is not { } database || !triggered && walk is null) return;
        var objects = new Dictionary<(string Database, string Schema, string Name), bool>();
        // SQL Server compares database names in its own collation, so a three-part name may spell the target's database
        // differently; such a dependent is in the target's database, not another one.
        var names = new Dictionary<string, string>(StringComparer.Ordinal) { [database] = database };
        string Database(string db) => names.TryGetValue(db, out var known) ? known : names[db] = SameDatabase(db, database) ? database : db;
        void Add(string db, string schema, string name, bool triggers)
        {
            var key = (Database(db), schema, name);
            objects[key] = triggers || objects.GetValueOrDefault(key);
        }
        if (target.Ref is { Schema: { } schema, Name: { } name }) Add(database, schema, name, triggered);
        if (walk is { } direction)
        {
            BeforeDependencies?.Invoke(database);
            var walker = new DependencyWalker(smo);
            walker.DiscoveryProgress += (_, _) => token.ThrowIfCancellationRequested();
            List<Urn> nodes;
            try { nodes = [.. walker.WalkDependencies(walker.DiscoverDependencies(new[] { urn }, direction)).Select(node => node.Urn)]; }
            catch (Exception error) when (ScriptingErrors.UnavailableText(error) is { } text)
            {
                // The walk enters the target's database again (USE) after the preflight read it: when that database is the
                // one that went away in between, the error is the target's, else a dependent's database failed.
                if (session.Cloud) throw;
                EnterTargetDatabase(database);
                throw new DependentDatabaseException(null, text);
            }
            var server = urn.GetAttribute("Name", "Server");
            foreach (var node in nodes)
            {
                if (node.Type == "UnresolvedEntity" || !string.Equals(node.GetAttribute("Name", "Server"), server, StringComparison.OrdinalIgnoreCase)
                    || node.GetAttribute("Name") is not { } n) continue;
                scripted.Add(node.Type, n);
                // What refers to the object includes DML triggers, schema objects in their table's or view's schema.
                if ((node.GetAttribute("Schema") ?? (node.Type == "Trigger" ? node.Parent.GetAttribute("Schema") : null)) is { } s && node.GetAttribute("Name", "Database") is { } db)
                    Add(db, s, n, dto.ScriptTriggers && node.Type is "Table" or "View");
            }
        }
        // A trigger target is no schema object; the preflight read its definition's size.
        var total = target.Ref.Schema is null ? target.DefinitionBytes ?? 0 : 0;
        foreach (var group in objects.GroupBy(item => item.Key.Database, StringComparer.Ordinal))
        {
            // A cloud database reaches no other one, so a definition there could not be checked.
            if (session.Cloud && group.Key != database)
                throw new ScriptRefusedException("it depends on an object in another database, which Generate script for dependent objects cannot check here. Turn it off in Tools › Options › Scripting and try again.");
            var list = new StringBuilder("<d>");
            foreach (var ((_, s, n), triggers) in group) list.Append("<o s=\"").Append(Hex(s)).Append("\" n=\"").Append(Hex(n)).Append("\" t=\"").Append(triggers ? '1' : '0').Append("\"/>");
            using var command = session.Connection.CreateCommand();
            command.CommandTimeout = 30;
            if (session.Cloud) command.CommandText = ScriptPreflight.DefinitionCheck;
            else
            {
                command.CommandText = ScriptPreflight.DefinitionCall;
                command.Parameters.Add(new SqlParameter("@db", SqlDbType.NVarChar, 128) { Value = group.Key });
                command.Parameters.Add(new SqlParameter("@stmt", SqlDbType.NVarChar, -1) { Value = ScriptPreflight.DefinitionCheck });
            }
            command.Parameters.Add(new SqlParameter("@objects", SqlDbType.NVarChar, -1) { Value = list.Append("</d>").ToString() });
            var elsewhere = group.Key != database ? group.Key : null;
            using var reader = Execute(command, elsewhere);
            if (!reader.Read()) continue;
            var parent = reader.IsDBNull(2) ? null : reader.GetString(2);
            if (reader.GetBoolean(3) || !reader.IsDBNull(4) && reader.GetInt64(4) > ScriptPreflight.MaxDefinitionBytes)
                throw new DependentDefinitionException(reader.GetBoolean(3) ? "ENCRYPTED" : "TOO_LARGE", reader.GetString(0), reader.GetString(1), parent,
                    parent is null ? "Generate script for dependent objects" : "Script triggers", elsewhere);
            total += reader.IsDBNull(5) ? 0 : reader.GetInt64(5);
        }
        // Each definition appears in the script whole (two bytes a character), so together they could not fit in it.
        if (total > 2 * max) throw new ScriptTooLargeException();
    }

    /// <summary>The definition check in one database; one a dependent lives in that the login cannot open is named.</summary>
    private static SqlDataReader Execute(SqlCommand command, string? elsewhere)
    {
        try { return command.ExecuteReader(); }
        catch (SqlException error) when (elsewhere is not null && ScriptingErrors.UnavailableText(error) is { } text) { throw new DependentDatabaseException(elsewhere, text); }
    }

    /// <summary>Whether two database names name the same database, as SQL Server resolves them.</summary>
    private bool SameDatabase(string name, string database)
    {
        using var command = session.Connection.CreateCommand();
        command.CommandTimeout = 30;
        command.CommandText = "SELECT CONVERT(bit, CASE WHEN DB_ID(@name) = DB_ID(@database) THEN 1 ELSE 0 END);";
        command.Parameters.Add(new SqlParameter("@name", SqlDbType.NVarChar, 128) { Value = name });
        command.Parameters.Add(new SqlParameter("@database", SqlDbType.NVarChar, 128) { Value = database });
        return command.ExecuteScalar() is true;
    }

    /// <summary>Enters the target's database as the preflight does; SQL Server's error when it cannot, which then names the
    /// target's database (and a database dropped since the preflight makes the target missing).</summary>
    private void EnterTargetDatabase(string database)
    {
        using var command = session.Connection.CreateCommand();
        command.CommandTimeout = 30;
        command.CommandText = "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module N'SELECT 1;';";
        command.Parameters.Add(new SqlParameter("@db", SqlDbType.NVarChar, 128) { Value = database });
        try { command.ExecuteNonQuery(); }
        catch (SqlException error) when (error.Number is 2812 or 911) { throw new SmoObjectMissingException(); }
    }

    /// <summary>A name's UTF-16 code units as hex, unpaired surrogates included.</summary>
    internal static string Hex(string name) => Convert.ToHexString(MemoryMarshal.AsBytes(name.AsSpan()));

    /// <summary>A stored definition with a line the query window reads as GO (valid T-SQL, as a column alias) or as a
    /// SQLCMD command: SSMS scripts it as is too, but whoever runs the script would run the rest as a batch of its own.</summary>
    public const string SplitWarning = "A definition in this script has a line the query window reads as GO or as a SQLCMD command, so running the script "
        + "would split that definition into separate batches. Review the script before running it.";

    internal static bool Splits(string batch)
    {
        try { return SqlScript.Parse(batch).Count > 1; }
        catch (RequestException) { return true; }
    }

    /// <summary>Why a script is refused when one of SMO's comment batches fails <see cref="HeaderGuard.Closed"/>.</summary>
    public const string BrokenComment = "SQL Server Management Objects wrote a comment that a name in it ends early or breaks over lines, so running the script "
        + "could run part of that name as SQL.";

    /// <summary>The warning for the references SMO could not resolve, whose comments <see cref="Run"/> left out: up to three
    /// of them by name (shown as Object Explorer shows names), with their database, and their server when it is a linked
    /// one. SMO resolves no reference that is missing, that the login cannot see, or that names a server (even this one).</summary>
    internal static string UnresolvedWarning(IReadOnlyList<Urn> entities, Urn target)
    {
        var server = target.GetAttribute("Name", "Server");
        string Name(Urn entity)
        {
            var schema = entity.GetAttribute("Schema");
            var name = ScriptingErrors.Display(string.IsNullOrEmpty(schema) ? entity.GetAttribute("Name") ?? "" : schema + "." + entity.GetAttribute("Name"));
            var at = entity.GetAttribute("Name", "Server") is { } linked && !string.Equals(linked, server, StringComparison.OrdinalIgnoreCase)
                ? " on server " + ScriptingErrors.Display(linked) : "";
            return entity.GetAttribute("Name", "Database") is { Length: > 0 } database ? name + " in database " + ScriptingErrors.Display(database) + at : name + at;
        }
        var names = string.Join(", ", entities.Take(3).Select(Name)) + (entities.Count > 3 ? " and " + (entities.Count - 3).ToString(CultureInfo.InvariantCulture) + " more" : "");
        return "The script does not create objects that a definition in it refers to but that SQL Server Management Objects could not resolve (they do not exist, "
            + "you cannot see them, or they are named with a server): " + names + ".";
    }

    /// <summary>Kinds whose script lists child collections. Without prefetch SMO reads each column's and each index's
    /// extended properties with a query of its own (713 commands for 300 columns and 20 indexes); Scripter's prefetch
    /// for a list of URNs filters every query by the listed objects' names, so it reads only this object's children,
    /// set-based (47 commands), whatever else the database holds.</summary>
    internal static readonly HashSet<string> PrefetchKinds = ["table", "view", "tableType"];

    /// <summary>SMO 181's Scripter refuses credentials (they are not scriptable objects to it), so they are written here as
    /// SMO writes the rest: USE, then for each pass a header and the statement. The identity is a string literal; the
    /// secret is in no catalog view and never in a script.</summary>
    private string Credential(ResolvedTarget target, ScriptVerb verb, ScriptingOptionsDto dto, long max, List<string> warnings)
    {
        var name = target.Ref.Name!;
        static string Literal(string value) => "N'" + value.Replace("'", "''") + "'";
        var exists = "SELECT * FROM sys.credentials WHERE name = " + Literal(name);
        var header = "/****** Object:  Credential " + ScriptFormatter.Quote(name) + "    Script Date: " + DateTime.Now.ToString(CultureInfo.CurrentCulture) + " ******/" + ScriptFormatter.NewLine;
        var headers = dto.IncludeHeaders && HeaderGuard.Safe(header);
        if (dto.IncludeHeaders && !headers) warnings.Add(HeaderGuard.Warning);
        var text = new StringBuilder();
        if (dto.ScriptUseDatabase && !session.Cloud) text.Append(ScriptFormatter.Frame(ScriptFormatter.Use("master"), dto.DelimitStatements));
        foreach (var pass in SmoOptionsMapper.Passes(verb))
        {
            var statement = pass == ScriptVerb.Drop ? "DROP CREDENTIAL " + ScriptFormatter.Quote(name)
                : "CREATE CREDENTIAL " + ScriptFormatter.Quote(name) + " WITH IDENTITY = " + Literal(target.Identity ?? "")
                    + (target.Provider is { } provider ? " FOR CRYPTOGRAPHIC PROVIDER " + ScriptFormatter.Quote(provider) : "");
            var guard = dto.CheckExistence ? (pass == ScriptVerb.Drop ? "IF EXISTS (" : "IF NOT EXISTS (") + exists + ")" + ScriptFormatter.NewLine : "";
            text.Append(ScriptFormatter.Frame((headers ? header : "") + guard + statement, dto.DelimitStatements));
        }
        if (text.Length > max) throw new ScriptTooLargeException();
        return text.ToString();
    }

    /// <summary>Ledger tables and views, which SMO 181 scripts for an older version by dropping the LEDGER clause and
    /// keeping the ledger columns: a script no older server runs.</summary>
    private static readonly HashSet<string> LedgerSubtypes = ["updatableLedger", "appendOnlyLedger", "ledgerHistory", "ledger"];

    /// <summary>SMO's batches for every pass of the verb, unframed, at most <paramref name="max"/> characters in all. The
    /// comment SMO writes as a batch for each reference it could not resolve is left out: it holds the referenced name
    /// unescaped, so a name could end it and run the rest as SQL. Which batches those are comes from SMO itself (its
    /// progress event for the unresolved entity), and each one's URN is added to <paramref name="unresolved"/>. The objects
    /// SMO reports creating go to <paramref name="scripted"/> (it reports none for ALTER or CREATE OR ALTER).</summary>
    private List<string> Run(Server smo, Urn urn, ResolvedTarget target, ScriptVerb verb, ScriptingOptionsDto dto, long max, bool headers, bool dependencies, List<string> warnings,
        List<Urn> unresolved, ScriptedObjects scripted)
    {
        var batches = new List<string>();
        long total = 0;
        string? use = null;
        var passes = SmoOptionsMapper.Passes(verb);
        for (var index = 0; index < passes.Count; index++)
        {
            var pass = passes[index];
            var mapped = SmoOptionsMapper.Map(dto, pass, session.Profile, headers, session.Cloud, dependencies);
            Target = mapped.Target;
            if (pass != ScriptVerb.Drop && LedgerSubtypes.Contains(target.Subtype) && SmoOptionsMapper.Known.First(item => item.Value == mapped.Target).Number < 160)
                throw new UnsupportedVersionException("Ledger tables and views need SQL Server 2022 or later.");
            foreach (var warning in mapped.Warnings) if (!warnings.Contains(warning)) warnings.Add(warning);
            // Prefetch over a CREATE's or DROP's dependency list reads every table's columns for each type and XML schema
            // collection in it (over 30 s in a database with 2,500 tables); without it the list scripts in about a second.
            // ALTER walks nothing, and CREATE OR ALTER only what refers to the object (no type is among them); there SMO 181
            // needs prefetch to write a view's SET ANSI_NULLS and SET QUOTED_IDENTIFIER.
            var prefetch = PrefetchKinds.Contains(target.Kind) && (!dependencies || pass is ScriptVerb.Alter or ScriptVerb.CreateOrAlter);
            var scripter = new Scripter(smo) { Options = mapped.Options, PrefetchObjects = prefetch };
            scripter.ScriptingProgress += (_, _) => token.ThrowIfCancellationRequested();
            var comments = new List<(string Text, Urn Entity)>();
            scripter.ScriptingProgress += (_, progress) =>
            {
                if (progress.Current is { Type: "UnresolvedEntity" } entity) comments.Add((HeaderGuard.Unresolved(entity.ToString()), entity));
                else if (progress.Current is { } current && pass != ScriptVerb.Drop) scripted.Add(current.Type, current.GetAttribute("Name"));
            };
            var written = 0;
            foreach (var batch in scripter.EnumScript(new[] { urn }))
            {
                token.ThrowIfCancellationRequested();
                // SMO ends some scripts (Database ALTER) with an empty batch, which would frame as a lone GO.
                if (string.IsNullOrWhiteSpace(batch)) continue;
                // Bounded before anything else reads it: SMO hands over a dependent's definition whole.
                total += batch.Length;
                if (total > max) throw new ScriptTooLargeException();
                if (comments.FindIndex(item => item.Text == batch) is var comment and >= 0)
                {
                    var entity = comments[comment].Entity;
                    if (!unresolved.Any(item => item.ToString() == entity.ToString())) unresolved.Add(entity);
                    comments.RemoveAt(comment);
                    continue;
                }
                // A later pass opens with the USE the script is already in, which SSMS writes once; the USE batches it
                // switches databases with inside (a database's extended properties) stay.
                if (written == 0 && index > 0 && batch == use) continue;
                if (batch.StartsWith("USE [", StringComparison.Ordinal) && batch.IndexOfAny(['\r', '\n']) < 0) use = batch;
                batches.Add(batch);
                written++;
            }
            // Each pass must write something: DROP And CREATE without its CREATE (a fixed role) is no script.
            if (written == 0) throw new EmptyScriptException();
        }
        return batches;
    }
}

/// <summary>The objects a script creates or alters, as far as Varia knows them: the target, the objects of the dependency
/// walk, and those SMO reports creating. A batch shaped like SMO's own comment passes the comment check only as the
/// definition of one of them (<see cref="HeaderGuard.Closed(IReadOnlyList{string}, Func{HeaderGuard.Module, bool})"/>).</summary>
internal sealed class ScriptedObjects
{
    private readonly HashSet<(string Keyword, string Name)> modules = [];
    private readonly HashSet<string> parents = new(StringComparer.Ordinal);

    /// <param name="urnType">The object's URN type, as SMO and the catalogue name it.</param>
    public void Add(string urnType, string? name)
    {
        if (name is null) return;
        if (HeaderGuard.Keyword(urnType) is { } keyword) modules.Add((keyword, name));
        if (urnType is "Table" or "View") parents.Add(name);
    }

    /// <summary>Whether the statement defines one of these modules or, with Script triggers, a trigger on one of these
    /// tables or views (SMO reports no object it writes for CREATE OR ALTER).</summary>
    public bool Defines(HeaderGuard.Module module, bool triggers) => modules.Contains((module.Keyword, module.Name))
        || triggers && module.Keyword == "TRIGGER" && module.On is { } on && parents.Contains(on);
}

/// <summary>SMO wrote no batch for the verb, or for one pass of DROP And CREATE.</summary>
internal sealed class EmptyScriptException() : Exception("SMO produced no script.");

/// <summary>A script Varia will not hand over, with the reason a message gives after the object's name.</summary>
internal sealed class ScriptRefusedException(string reason) : Exception("The script was refused.")
{
    public string Reason { get; } = reason;
}

/// <summary>A trigger or dependent object SMO would script with the target is encrypted or over the definition limit.</summary>
/// <param name="parent">For a trigger, the table or view it is on (in <paramref name="schema"/>).</param>
/// <param name="option">The scripting option that brought it in.</param>
/// <param name="database">The database it lives in when that is not the target's (three-part names, synonyms).</param>
internal sealed class DependentDefinitionException(string code, string schema, string name, string? parent, string option, string? database = null)
    : Exception("A trigger or dependent object cannot be scripted.")
{
    public string Code { get; } = code;
    public string Schema { get; } = schema;
    public string Name { get; } = name;
    public string? Parent { get; } = parent;
    public string Option { get; } = option;
    public string? Database { get; } = database;
}

/// <summary>Generate script for dependent objects reached a database other than the target's that the login cannot open,
/// that is not online, or that does not exist.</summary>
/// <param name="database">That database, or null when SMO's dependency walk failed in it: SMO reports no name, but
/// SQL Server's text in <paramref name="detail"/> carries it.</param>
internal sealed class DependentDatabaseException(string? database, string detail) : Exception("A dependent object's database is not available.")
{
    public string? Database { get; } = database;
    public string Detail { get; } = detail;
}
