using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Varia.Backend.Designer;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>New Database's SQL (D1b): the preflight's facts in master, the CREATE DATABASE statement, its script, and the builder batch
/// OK runs. OK never sends statement text: C# turns the validated plan into one JSON document (@design), and the constant builder has
/// SQL Server shred it with OPENJSON and compose the statement from QUOTENAME'd names, file names and paths quoted on the server
/// (REPLACE under a binary collation, critic A9's form 5), CONVERT of typed numbers, keyword text, and a collation only as
/// sys.fn_helpcollations() names it, then run it in master through QUOTENAME(@db)'s sp_executesql. <see cref="Statement"/> is what the
/// builder composes, which the live dry run proves for hostile names. The options, filegroup changes and owner after CREATE are
/// Database Properties' own ALTER statements (DatabaseAlter).</summary>
internal static partial class CreateDatabaseSql
{
    private static string NL => ScriptFormatter.NewLine;
    private static string Quote(string name) => ScriptFormatter.Quote(name);
    private static string Literal(string text) => "N'" + text.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Number(long value) => value.ToString(CultureInfo.InvariantCulture);

    /// <summary>In master: the default folders, the server's collation, whether the login may create a database (CREATE ANY DATABASE, or
    /// CREATE DATABASE in master; unknown counts as yes, as the server decides), master's compatibility level (the builder's OPENJSON needs
    /// 130), model's Auto Create Statistics, FILESTREAM's level, contained database authentication, the version and edition, whether
    /// the name is taken, whether a new owner's login and the collation exist, and whether sys.dm_os_file_exists does (SQL Server 2017).</summary>
    public const string Facts = "SELECT CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultDataPath')) AS data_path, CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultLogPath')) AS log_path, "
        + "CONVERT(nvarchar(128), SERVERPROPERTY('Collation')) AS server_collation, "
        + "CONVERT(bit, CASE WHEN ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'CREATE ANY DATABASE'), 1) = 1 OR ISNULL(HAS_PERMS_BY_NAME(NULL, N'DATABASE', N'CREATE DATABASE'), 1) = 1 THEN 1 ELSE 0 END) AS can_create, "
        + "(SELECT m.compatibility_level FROM sys.databases AS m WHERE m.database_id = 1) AS master_level, "
        + "(SELECT m.is_auto_create_stats_on FROM sys.databases AS m WHERE m.database_id = 3) AS model_auto_create, "
        + "CONVERT(int, SERVERPROPERTY('FilestreamEffectiveLevel')) AS filestream_level, "
        + "CONVERT(bit, ISNULL((SELECT CONVERT(int, c.value_in_use) FROM sys.configurations AS c WHERE c.name = N'contained database authentication'), 0)) AS contained_authentication, "
        + "CONVERT(int, SERVERPROPERTY('ProductMajorVersion')) AS major, CONVERT(int, SERVERPROPERTY('EngineEdition')) AS engine_edition, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.databases AS x WHERE x.name = @name) THEN 1 ELSE 0 END) AS name_in_use, "
        + "CONVERT(bit, CASE WHEN @owner IS NULL OR EXISTS (SELECT 1 FROM sys.server_principals AS p WHERE p.name = @owner) THEN 1 ELSE 0 END) AS owner_exists, "
        + "CONVERT(bit, CASE WHEN @collation IS NULL OR EXISTS (SELECT 1 FROM sys.fn_helpcollations() AS h WHERE h.name COLLATE Latin1_General_BIN2 = @collation) THEN 1 ELSE 0 END) AS collation_exists, "
        + "(SELECT COUNT(*) FROM sys.system_objects AS o WHERE o.name = N'dm_os_file_exists') AS file_exists_view;";

    // --- The statement ---------------------------------------------------------------------------------------------------

    /// <summary>MAXSIZE: none (a container, or no autogrowth), UNLIMITED (a data file), a size in KB, or 2048GB (an unlimited log file,
    /// SQL Server's ceiling for one). A log limited to that ceiling is written as SSMS writes it: 2048GB, whose KB would not fit in an
    /// int (model's log reads back as limited to 2097152 MB, so every New Database that copies it meets this).</summary>
    internal static int MaxKind(NewFilePlan file) => file.Container || !file.Growth.Enabled ? 0
        : file.Growth.MaxMb is not { } max ? file.Log ? 3 : 1
        : file.Log && max >= LogCeilingMb ? 3 : 2;
    /// <summary>A log file's largest size, 2 TB, in MB.</summary>
    internal const long LogCeilingMb = 2_097_152;
    /// <summary>FILEGROWTH: none (a container), in KB, in percent, or 0 (no autogrowth).</summary>
    private static int GrowthKind(NewFilePlan file) => file.Container ? 0 : !file.Growth.Enabled ? 3 : file.Growth.Unit == "mb" ? 1 : 2;
    private static long GrowthValue(NewFilePlan file) => file.Growth.Unit == "mb" ? file.Growth.By!.Value * 1024 : file.Growth.By!.Value;
    private static int GroupKind(NewFilegroupPlan group) => group.Type switch { "rows" => 0, "filestream" => 1, _ => 2 };
    /// <summary>CREATE DATABASE writes DEFAULT only for a FILESTREAM filegroup; a rows one becomes the default after CREATE, as SSMS does.</summary>
    private static bool CreateDefault(NewFilegroupPlan group) => group.Type == "filestream" && group.IsDefault;

    private static string Spec(NewFilePlan file, char separator)
    {
        var text = new StringBuilder("( NAME = ").Append(Literal(file.Name)).Append(", FILENAME = ").Append(Literal(NewDatabaseValidator.FullPath(file, separator)));
        if (file.SizeMb is { } size) text.Append(", SIZE = ").Append(Number(size * 1024)).Append("KB");
        text.Append(MaxKind(file) switch { 1 => ", MAXSIZE = UNLIMITED", 2 => ", MAXSIZE = " + Number(file.Growth.MaxMb!.Value * 1024) + "KB", 3 => ", MAXSIZE = 2048GB", _ => "" });
        text.Append(GrowthKind(file) switch { 1 => ", FILEGROWTH = " + Number(GrowthValue(file)) + "KB", 2 => ", FILEGROWTH = " + Number(GrowthValue(file)) + "%", 3 => ", FILEGROWTH = 0", _ => "" });
        return text.Append(" )").ToString();
    }

    private static string GroupClause(NewFilegroupPlan group) => "FILEGROUP " + Quote(group.Name)
        + (group.Type switch { "filestream" => " CONTAINS FILESTREAM", "memoryOptimized" => " CONTAINS MEMORY_OPTIMIZED_DATA", _ => "" }) + (CreateDefault(group) ? " DEFAULT" : "");

    /// <summary>Each file's lead: 1 the primary file (after ON PRIMARY), 2 a filegroup's first file, 3 the first log file (after LOG ON),
    /// 0 a file after another in the same section.</summary>
    private static List<(int Lead, NewFilegroupPlan? Group, NewFilePlan File)> Layout(NewDatabasePlan plan)
    {
        var groups = plan.Filegroups.ToDictionary(group => group.Name, StringComparer.OrdinalIgnoreCase);
        var layout = new List<(int, NewFilegroupPlan?, NewFilePlan)>();
        string? section = null;
        foreach (var file in plan.Files)
        {
            var group = file.Log ? null : groups[file.Filegroup!];
            var at = file.Log ? "\0log" : group!.Name;
            var lead = layout.Count == 0 ? 1 : at == section ? 0 : file.Log ? 3 : 2;
            layout.Add((lead, group, file));
            section = at;
        }
        return layout;
    }

    /// <summary>The statement as clauses: Statement joins them with spaces, Script with line breaks as SSMS lays it out.</summary>
    private static List<(string Text, bool Spec)> Clauses(NewDatabasePlan plan, bool linux)
    {
        var separator = linux ? '/' : '\\';
        var clauses = new List<(string, bool)> { ("CREATE DATABASE " + Quote(plan.Name), false), ("CONTAINMENT = " + plan.Containment, false) };
        var layout = Layout(plan);
        for (var index = 0; index < layout.Count; index++)
        {
            var (lead, group, file) = layout[index];
            if (lead == 1) clauses.Add(("ON PRIMARY", false));
            else if (lead == 2) clauses.Add((GroupClause(group!), false));
            else if (lead == 3) clauses.Add(("LOG ON", false));
            var comma = index + 1 < layout.Count && layout[index + 1].Lead != 3;
            clauses.Add((Spec(file, separator) + (comma ? "," : ""), true));
        }
        if (plan.Collation is { } collation) clauses.Add(("COLLATE " + collation, false));
        if (plan.Ledger) clauses.Add(("WITH LEDGER = ON", false));
        return clauses;
    }

    /// <summary>The CREATE DATABASE statement, names bracketed and file names and paths as N'' literals: what the builder composes.</summary>
    public static string Statement(NewDatabasePlan plan, bool linux) => string.Join(" ", Clauses(plan, linux).Select(clause => clause.Text));

    /// <summary>Script's CREATE DATABASE as SSMS lays it out (each clause on its own line, a file's spec in parentheses), then GO. It
    /// differs from <see cref="Statement"/> only in white space.</summary>
    public static string Script(NewDatabasePlan plan, bool linux) =>
        string.Join(NL, Clauses(plan, linux).Select(clause => clause.Spec ? clause.Text : " " + clause.Text)).TrimStart() + NL + "GO" + NL;

    /// <summary>The builder's one parameter: the database's name, containment, ledger, the collation, and each file with its lead, filegroup,
    /// kinds and numbers (sizes in KB, typed).</summary>
    public static string DesignJson(NewDatabasePlan plan, bool linux)
    {
        var separator = linux ? '/' : '\\';
        using var buffer = new MemoryStream();
        using (var json = new Utf8JsonWriter(buffer))
        {
            json.WriteStartObject();
            json.WriteString("name", plan.Name);
            json.WriteNumber("containment", plan.Containment == "PARTIAL" ? 1 : 0);
            json.WriteBoolean("ledger", plan.Ledger);
            json.WriteBoolean("collated", plan.Collation is not null);
            if (plan.Collation is { } collation) json.WriteString("collation", collation); else json.WriteNull("collation");
            json.WriteStartArray("files");
            foreach (var (lead, group, file) in Layout(plan))
            {
                json.WriteStartObject();
                json.WriteNumber("lead", lead);
                if (group is not null) json.WriteString("group", group.Name); else json.WriteNull("group");
                json.WriteNumber("kind", group is null ? 0 : GroupKind(group));
                json.WriteBoolean("default", group is not null && CreateDefault(group));
                json.WriteString("name", file.Name);
                json.WriteString("file", NewDatabaseValidator.FullPath(file, separator));
                if (file.SizeMb is { } size) json.WriteNumber("size", size * 1024); else json.WriteNull("size");
                json.WriteNumber("maxKind", MaxKind(file));
                if (MaxKind(file) == 2) json.WriteNumber("max", file.Growth.MaxMb!.Value * 1024); else json.WriteNull("max");
                json.WriteNumber("growthKind", GrowthKind(file));
                if (GrowthKind(file) is 1 or 2) json.WriteNumber("growth", GrowthValue(file)); else json.WriteNull("growth");
                json.WriteEndObject();
            }
            json.WriteEndArray();
            json.WriteEndObject();
        }
        return Encoding.UTF8.GetString(buffer.ToArray());
    }

    // --- The builder -----------------------------------------------------------------------------------------------------

    /// <summary>The fixed messages and module suffix the builder holds besides keyword text.</summary>
    public static readonly IReadOnlySet<string> Messages = new HashSet<string>(StringComparer.Ordinal)
        { "N'A name could not be quoted.'", "N'The design could not be read.'", "N'A file could not be built.'", "N'.sys.sp_executesql'" };

    /// <summary>A text from the design as an N'' literal, quoted on the server: the one form a file's name or path reaches the statement.</summary>
    private static string Quoted(string column) => "N'N''' + REPLACE(j.[" + column + "] COLLATE Latin1_General_BIN2, N'''', N'''''') + N''''";

    private const string Shred = "IF ISNULL(ISJSON(@design), 0) = 0 THROW 50000, N'The design could not be read.', 1;\n"
        + "DECLARE @name nvarchar(max), @containment nvarchar(max), @ledger nvarchar(max), @files nvarchar(max), @collate nvarchar(max);\n"
        + "SELECT @name = QUOTENAME(d.[name]), @containment = CASE d.containment WHEN 0 THEN N' CONTAINMENT = NONE' WHEN 1 THEN N' CONTAINMENT = PARTIAL' END, "
        + "@ledger = CASE d.ledger WHEN 1 THEN N' WITH LEDGER = ON' WHEN 0 THEN N'' END, @files = d.files "
        + "FROM OPENJSON(@design) WITH ([name] nvarchar(max), containment int, ledger bit, files nvarchar(max) AS JSON) AS d;\n"
        // A collation the server does not have leaves @collate NULL, which the guard refuses.
        + "SELECT @collate = CASE d.collated WHEN 0 THEN N'' WHEN 1 THEN N' COLLATE ' + c.name END "
        + "FROM OPENJSON(@design) WITH (collated bit, collation nvarchar(max)) AS d LEFT JOIN sys.fn_helpcollations() AS c ON " + CollationJoin + ";\n"
        + "IF @name IS NULL OR @containment IS NULL OR @ledger IS NULL OR @files IS NULL OR @collate IS NULL THROW 50000, N'A name could not be quoted.', 1;\n";

    /// <summary>The one place the design's collation is read: matched, exactly, against the server's own names.</summary>
    private const string CollationJoin = "c.name COLLATE Latin1_General_BIN2 = d.collation COLLATE Latin1_General_BIN2";

    private static readonly string Files = "DECLARE @f TABLE (ordinal int PRIMARY KEY, spec nvarchar(max) NULL);\n"
        + "INSERT @f (ordinal, spec) SELECT CONVERT(int, a.[key]), CASE j.lead WHEN 0 THEN N', ' WHEN 1 THEN N' ON PRIMARY ' "
        + "WHEN 2 THEN N', FILEGROUP ' + QUOTENAME(j.[group]) + CASE j.kind WHEN 0 THEN N'' WHEN 1 THEN N' CONTAINS FILESTREAM' WHEN 2 THEN N' CONTAINS MEMORY_OPTIMIZED_DATA' END "
        + "+ CASE j.[default] WHEN 1 THEN N' DEFAULT' WHEN 0 THEN N'' END + N' ' WHEN 3 THEN N' LOG ON ' END "
        + "+ N'( NAME = ' + " + Quoted("name") + " + N', FILENAME = ' + " + Quoted("file") + " "
        + "+ CASE WHEN j.size IS NULL THEN N'' ELSE N', SIZE = ' + CONVERT(nvarchar(20), j.size) + N'KB' END "
        + "+ CASE j.maxKind WHEN 0 THEN N'' WHEN 1 THEN N', MAXSIZE = UNLIMITED' WHEN 2 THEN N', MAXSIZE = ' + CONVERT(nvarchar(20), j.[max]) + N'KB' WHEN 3 THEN N', MAXSIZE = 2048GB' END "
        + "+ CASE j.growthKind WHEN 0 THEN N'' WHEN 1 THEN N', FILEGROWTH = ' + CONVERT(nvarchar(20), j.growth) + N'KB' WHEN 2 THEN N', FILEGROWTH = ' + CONVERT(nvarchar(20), j.growth) + N'%' "
        + "WHEN 3 THEN N', FILEGROWTH = 0' END + N' )' "
        + "FROM OPENJSON(@files) AS a CROSS APPLY OPENJSON(a.value) WITH (lead int, [group] nvarchar(max), kind int, [default] bit, [name] nvarchar(max), [file] nvarchar(max), "
        + "size bigint, maxKind int, [max] bigint, growthKind int, growth bigint) AS j;\n"
        + "IF NOT EXISTS (SELECT 1 FROM @f) OR EXISTS (SELECT 1 FROM @f AS x WHERE x.spec IS NULL) THROW 50000, N'A file could not be built.', 1;\n";

    /// <summary>The single execution form (critic A9): the statement runs in @db (master) through its sp_executesql.</summary>
    public const string Execution = "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;";

    /// <summary>The batch that creates the database from @design in @db (master). <paramref name="dryRun"/> (the live checks only, never
    /// the wire) selects the statement instead.</summary>
    public static string Builder(bool dryRun = false) => Shred + Files + DesignerSql.Join("@f", "ordinal", "spec", "@body", comma: false)
        + "DECLARE @stmt nvarchar(max) = N'CREATE DATABASE ' + @name + @containment + @body + @collate + @ledger;\n" + ActionSql.Guard
        + (dryRun ? "SELECT @stmt AS stmt;" : Execution);

    // --- Lint (form 5) ---------------------------------------------------------------------------------------------------

    [GeneratedRegex(@"@\w+")]
    private static partial Regex Variable();
    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    /// <summary>Keyword text: letters, digits, underscores, spaces and the punctuation a file spec uses. No quote, bracket, comment or line break.</summary>
    [GeneratedRegex(@"^N'[A-Za-z0-9_ ():=;,%]*'$")]
    private static partial Regex KeywordLiteral();
    /// <summary>An OPENJSON WITH clause: its columns and its one-letter alias.</summary>
    [GeneratedRegex(@"OPENJSON\([^)]*\) WITH \((.*?)\) AS ([a-z])(?=[ ;\n])")]
    private static partial Regex WithClause();
    [GeneratedRegex(@"(\[?\w+\]?) nvarchar\(max\)(?! AS JSON)")]
    private static partial Regex JsonText();
    [GeneratedRegex(@"\b([a-z])\.(\[?\w+\]?)")]
    private static partial Regex Qualified();
    /// <summary>The quoted-literal form of a design text: N'N''' + REPLACE(alias.column COLLATE Latin1_General_BIN2, N'''', N'''''') + N''''.</summary>
    [GeneratedRegex(@"N'N''' \+ REPLACE\(([a-z]\.\[?\w+\]?) COLLATE Latin1_General_BIN2, N'''', N''''''\) \+ N''''")]
    private static partial Regex QuotedForm();
    [GeneratedRegex(@"DECLARE ([^;]*);")]
    private static partial Regex Declaration();
    [GeneratedRegex(@"(?:^|, )(@\w+) ")]
    private static partial Regex DeclaredName();

    /// <summary>Problems with one New Database builder batch (form 5, which D1d's file changes reuse): a format hole, a secret, no quoting
    /// guard, @db outside QUOTENAME, @design outside ISJSON or OPENJSON, a JSON array outside OPENJSON, STRING_AGG (SQL Server 2017), any
    /// execution but the single QUOTENAME(@db) sp_executesql form (none in a dry run), a design text anywhere but QUOTENAME, the
    /// server-side quoted-literal form or the collation lookup, a quote literal outside that form, an undeclared variable, and a literal
    /// that is neither one of <paramref name="messages"/> nor keyword text.</summary>
    public static List<string> Lint(string text, IReadOnlySet<string> messages, bool dryRun)
    {
        var problems = new List<string>();
        if (text.Contains('{', StringComparison.Ordinal) || text.Contains('}', StringComparison.Ordinal)) problems.Add("has a format hole");
        problems.AddRange(CatalogSql.SecretUses(text));
        if (!text.Contains(ActionSql.Guard, StringComparison.Ordinal)) problems.Add("has no quoting guard");
        if (text.Contains("STRING_AGG", StringComparison.OrdinalIgnoreCase)) problems.Add("uses STRING_AGG");
        // The single execution form, and nothing else that runs text.
        var executions = text.Split(Execution).Length - 1;
        var rest = text.Replace(Execution, "", StringComparison.Ordinal);
        if (dryRun ? executions != 0 || !text.EndsWith("SELECT @stmt AS stmt;", StringComparison.Ordinal) : executions != 1 || !text.EndsWith(Execution, StringComparison.Ordinal))
            problems.Add(dryRun ? "runs a statement in a dry run" : "does not end with the single execution form");
        if (Regex.IsMatch(rest, @"\bEXEC(UTE)?\b|sp_executesql", RegexOptions.IgnoreCase)) problems.Add("runs text outside the single execution form");
        if (Variable().Matches(text.Replace("QUOTENAME(@db)", "", StringComparison.Ordinal)).Any(used => used.Value == "@db")) problems.Add("uses @db outside QUOTENAME");
        if (Variable().Matches(text.Replace("ISJSON(@design)", "", StringComparison.Ordinal).Replace("OPENJSON(@design)", "", StringComparison.Ordinal)).Any(used => used.Value == "@design"))
            problems.Add("uses @design outside ISJSON or OPENJSON");
        var arrays = text.Replace("OPENJSON(@files)", "", StringComparison.Ordinal).Replace("@files = d.", "", StringComparison.Ordinal).Replace("@files IS NULL", "", StringComparison.Ordinal)
            .Replace("@files nvarchar(max)", "", StringComparison.Ordinal);
        if (Variable().Matches(arrays).Any(used => used.Value == "@files")) problems.Add("uses @files outside OPENJSON");
        // Design texts (alias, column): only QUOTENAME(x.c), the quoted-literal form, or the collation lookup reach the statement.
        var texts = WithClause().Matches(text).SelectMany(clause => JsonText().Matches(clause.Groups[1].Value).Select(match => clause.Groups[2].Value + "." + match.Groups[1].Value.Trim('[', ']')))
            .ToHashSet(StringComparer.Ordinal);
        var lookups = text.Contains("LEFT JOIN sys.fn_helpcollations() AS c ON " + CollationJoin, StringComparison.Ordinal) ? 1 : 0;
        var safe = QuotedForm().Replace(text, match => "QUOTENAME(" + match.Groups[1].Value + ")");
        if (lookups == 1) safe = safe.Replace(CollationJoin, "", StringComparison.Ordinal);
        foreach (Match used in Qualified().Matches(safe))
        {
            var key = used.Groups[1].Value + "." + used.Groups[2].Value.Trim('[', ']');
            if (texts.Contains(key) && !(safe[..used.Index].EndsWith("QUOTENAME(", StringComparison.Ordinal) && safe[(used.Index + used.Length)..].StartsWith(')')))
                problems.Add("uses the design text " + used.Value + " outside QUOTENAME, the quoted-literal form or the collation lookup");
            if (used.Groups[2].Value == "value" && !safe[..used.Index].EndsWith("OPENJSON(", StringComparison.Ordinal)) problems.Add("uses " + used.Value + " outside OPENJSON");
        }
        var declared = Declaration().Matches(text).SelectMany(match => DeclaredName().Matches(match.Groups[1].Value).Select(name => name.Groups[1].Value)).ToHashSet(StringComparer.Ordinal);
        foreach (Match used in Variable().Matches(text)) if (used.Value is not ("@db" or "@design") && !declared.Contains(used.Value)) problems.Add("uses the undeclared " + used.Value);
        // Quote literals are legal only inside the quoted-literal form, which `safe` no longer holds.
        foreach (Match literal in LiteralPattern().Matches(safe))
            if (!messages.Contains(literal.Value) && !KeywordLiteral().IsMatch(literal.Value)) problems.Add("has the literal " + literal.Value);
        return problems;
    }

    /// <summary>The builder (run and dry run) with its form, and the facts with ActionSql's catalog form for every band.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> LintAll()
    {
        foreach (var dry in new[] { false, true }) yield return ("new database builder" + (dry ? " (dry run)" : ""), Lint(Builder(dry), Messages, dry));
        for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++) yield return ("new database facts band " + band, ActionSql.LintCatalog(Facts, band, database: false));
    }
}
