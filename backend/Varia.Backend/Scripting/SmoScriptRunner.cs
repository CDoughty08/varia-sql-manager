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
    /// makes SMO script the target again without headers; the headers stay when they are all the two scripts differ in.</summary>
    public string Script(ResolvedTarget target, ScriptVerb verb, ScriptingOptionsDto dto, long max, List<string> warnings)
    {
        CultureInfo.CurrentCulture = ScriptingCulture.Formatting;
        CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo("en-US");
        if (target.Kind == "credential") return Credential(target, verb, dto, max, warnings);
        var smo = Server();
        var urn = new Urn(UrnBuilder.Build(smo.Urn.Value, target.Kind, target.Row.Urn, target.Ref, target.ParentUrnType, target.Column));
        var dependencies = dto.GenerateDependentObjects && SmoOptionsMapper.Dependencies(target.Row.Urn, target.ParentUrnType, target.Ref.Database is null);
        if (SmoOptionsMapper.Passes(verb).Any(pass => pass != ScriptVerb.Drop)) CheckDefinitions(smo, urn, target, dto, dependencies, max);
        if (verb == ScriptVerb.Alter)
        {
            // Without Touch, SMO writes nothing for ALTER (sqltoolsservice does the same).
            (smo.GetSmoObject(urn) ?? throw new SmoObjectMissingException()).Touch();
        }
        var batches = Run(smo, urn, target, verb, dto, max, dto.IncludeHeaders, dependencies, warnings);
        if (!dto.IncludeHeaders) Unheaded(batches);
        else if (!batches.All(HeaderGuard.Safe))
        {
            var plain = Run(smo, urn, target, verb, dto, max, headers: false, dependencies, warnings);
            Unheaded(plain);
            if (!HeaderGuard.Aligned(batches, plain))
            {
                batches = plain;
                if (!warnings.Contains(HeaderGuard.Warning)) warnings.Add(HeaderGuard.Warning);
            }
        }
        var text = new StringBuilder();
        foreach (var batch in batches)
        {
            if (!warnings.Contains(SplitWarning) && Splits(batch)) warnings.Add(SplitWarning);
            text.Append(ScriptFormatter.Frame(batch, dto.DelimitStatements));
            if (text.Length > max) throw new ScriptTooLargeException();
        }
        return text.ToString();
    }

    /// <summary>SMO 181 writes no header when asked for none, so a batch that starts with a broken one is refused.</summary>
    private static void Unheaded(List<string> batches)
    {
        if (!batches.All(HeaderGuard.Unheaded))
            throw new ScriptRefusedException("a batch starts with a descriptive header comment that is split over lines or ends early, so running the script could run part of a name as SQL.");
    }

    /// <summary>The preflight bounds the target's own definition; Script triggers and Generate script for dependent
    /// objects make SMO read other modules too, which are bounded here before SMO runs (spec F: no definition over
    /// 8,000,000 bytes reaches managed memory, and none that could not fit in the script together). The dependencies are
    /// SMO's own walk, which the scripter repeats, and may lie in other databases (three-part names, synonyms).</summary>
    private void CheckDefinitions(Server smo, Urn urn, ResolvedTarget target, ScriptingOptionsDto dto, bool dependencies, long max)
    {
        // A table's or view's triggers come with the object itself, not with one of its indexes or keys.
        var triggered = dto.ScriptTriggers && target.Kind is "table" or "view";
        if (target.Ref.Database is not { } database || !triggered && !dependencies) return;
        var objects = new Dictionary<(string Database, string Schema, string Name), bool>();
        void Add(string db, string schema, string name, bool triggers) => objects[(db, schema, name)] = triggers || objects.GetValueOrDefault((db, schema, name));
        if (target.Ref is { Schema: { } schema, Name: { } name }) Add(database, schema, name, triggered);
        if (dependencies)
        {
            var walker = new DependencyWalker(smo);
            walker.DiscoveryProgress += (_, _) => token.ThrowIfCancellationRequested();
            foreach (var node in walker.WalkDependencies(walker.DiscoverDependencies(new[] { urn }, DependencyType.Parents)))
                if (node.Urn.GetAttribute("Schema") is { } s && node.Urn.GetAttribute("Name") is { } n && node.Urn.GetAttribute("Name", "Database") is { } db)
                    Add(db, s, n, dto.ScriptTriggers && node.Urn.Type is "Table" or "View");
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
            using var reader = command.ExecuteReader();
            if (!reader.Read()) continue;
            var parent = reader.IsDBNull(2) ? null : reader.GetString(2);
            if (reader.GetBoolean(3) || !reader.IsDBNull(4) && reader.GetInt64(4) > ScriptPreflight.MaxDefinitionBytes)
                throw new DependentDefinitionException(reader.GetBoolean(3) ? "ENCRYPTED" : "TOO_LARGE", reader.GetString(0), reader.GetString(1), parent,
                    parent is null ? "Generate script for dependent objects" : "Script triggers");
            total += reader.IsDBNull(5) ? 0 : reader.GetInt64(5);
        }
        // Each definition appears in the script whole (two bytes a character), so together they could not fit in it.
        if (total > 2 * max) throw new ScriptTooLargeException();
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

    /// <summary>SMO's batches for every pass of the verb, unframed, at most <paramref name="max"/> characters in all.</summary>
    private List<string> Run(Server smo, Urn urn, ResolvedTarget target, ScriptVerb verb, ScriptingOptionsDto dto, long max, bool headers, bool dependencies, List<string> warnings)
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
            // Prefetch over a dependency list reads every table's columns for each type and XML schema collection in it
            // (over 30 s in a database with 2,500 tables); without it the list scripts in about a second.
            var scripter = new Scripter(smo) { Options = mapped.Options, PrefetchObjects = PrefetchKinds.Contains(target.Kind) && !dependencies };
            scripter.ScriptingProgress += (_, _) => token.ThrowIfCancellationRequested();
            var written = 0;
            foreach (var batch in scripter.EnumScript(new[] { urn }))
            {
                token.ThrowIfCancellationRequested();
                // SMO ends some scripts (Database ALTER) with an empty batch, which would frame as a lone GO.
                if (string.IsNullOrWhiteSpace(batch)) continue;
                // Bounded before anything else reads it: SMO hands over a dependent's definition whole.
                total += batch.Length;
                if (total > max) throw new ScriptTooLargeException();
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
internal sealed class DependentDefinitionException(string code, string schema, string name, string? parent, string option) : Exception("A trigger or dependent object cannot be scripted.")
{
    public string Code { get; } = code;
    public string Schema { get; } = schema;
    public string Name { get; } = name;
    public string? Parent { get; } = parent;
    public string Option { get; } = option;
}
