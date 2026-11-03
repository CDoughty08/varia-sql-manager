using System.Text.Json;
using System.Text.RegularExpressions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Actions;

/// <summary>One database an attach plans (ActionArgs.Databases, validated): its name, its files in order and whether SQL Server
/// rebuilds the log.</summary>
internal sealed record AttachStatement(string Name, IReadOnlyList<string> Files, bool RebuildLog);

/// <summary>Attach Databases' SQL (D1d). The describe reads a detached primary data file with DBCC CHECKPRIMARYFILE, its path
/// bound as a parameter (critic A10): no dynamic SQL and no INSERT … EXEC, the result sets read here. The attach itself is a
/// builder batch: SQL Server builds CREATE DATABASE … FOR ATTACH from @p1 (the name, through QUOTENAME) and one JSON array of
/// paths (@design), each quoted on the server by REPLACE in a binary collation (QUOTENAME stops at 128 characters, and a path
/// may have 260), joined in order by a WHILE loop rather than STRING_AGG, which SQL Server 2016 lacks (critic A8), and run
/// through QUOTENAME(@db)'s sp_executesql (critic A9). The keyword comes from one of two constant batches. Nothing here logs a
/// path, a name or SQL.</summary>
internal static partial class AttachSql
{
    /// <summary>In master: the logins Owner offers (at most @logins + 1, as Database Properties lists them), then the default data
    /// folder and the newest database version the server opens (master's).</summary>
    public const string Facts = "SELECT TOP (@logins) p.name AS name FROM sys.server_principals AS p WHERE p.type IN ('S', 'U', 'G', 'E', 'X') AND p.name NOT LIKE N'##%' ORDER BY p.name;\n"
        + "SELECT CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultDataPath')) AS data_path, " + ActionSql.MasterVersion + " AS server_version;";

    /// <summary>Whether @mdf is a primary data file (1).</summary>
    public const string IsPrimary = "DBCC CHECKPRIMARYFILE (@mdf, 0);";
    /// <summary>Its database's properties (Database name, Database version, Collation), then its files (status, fileid, name, filename).</summary>
    public const string Primary = "DBCC CHECKPRIMARYFILE (@mdf, 2);\nDBCC CHECKPRIMARYFILE (@mdf, 3);";
    /// <summary>Its database's properties alone: OK reads the version again before it attaches anything.</summary>
    public const string Properties = "DBCC CHECKPRIMARYFILE (@mdf, 2);";

    /// <summary>The preflight, in master, per database: whether a database has the name, whether the owner's login exists, the
    /// advisory CREATE ANY DATABASE, master's compatibility level (the builder's OPENJSON needs 130) and the newest database
    /// version the server opens.</summary>
    public const string Preflight = "SELECT CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.databases AS d WHERE d.name = @name) THEN 1 ELSE 0 END) AS name_in_use, "
        + "CONVERT(bit, CASE WHEN @owner IS NULL OR EXISTS (SELECT 1 FROM sys.server_principals AS p WHERE p.name = @owner AND p.type IN ('S', 'U', 'G', 'E', 'X')) THEN 1 ELSE 0 END) AS owner_exists, "
        + "CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'CREATE ANY DATABASE'), 1)) AS can_create, "
        + "(SELECT m.compatibility_level FROM sys.databases AS m WHERE m.database_id = 1) AS master_level, " + ActionSql.MasterVersion + " AS server_version;";

    /// <summary>Whether the database @name is the one an attach of @mdf made: its primary file is @mdf. Stop can reach a CREATE
    /// DATABASE … FOR ATTACH after SQL Server finished it but before its answer was read, so the step reads cancelled although the
    /// database is attached; Detach the database again then runs only if this finds it (decision 5: only what this OK attached).</summary>
    public const string Attached = "SELECT CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.databases AS d JOIN sys.master_files AS f ON f.database_id = d.database_id "
        + "WHERE d.name = @name AND f.file_id = 1 AND f.physical_name = @mdf) THEN 1 ELSE 0 END) AS attached;";

    /// <summary>The fixed messages and fragments a builder batch may hold (Lint).</summary>
    public static readonly IReadOnlySet<string> Literals = new HashSet<string>(StringComparer.Ordinal)
    {
        "N'The design could not be read.'", "N'A file could not be read.'", "N'A name could not be quoted.'", "N'.sys.sp_executesql'", "N'CREATE DATABASE '", "N' ON '",
        "N'( FILENAME = N'''", "N''' )'", "N''''", "N''''''", "N''", "N', '", "N' FOR ATTACH'", "N' FOR ATTACH_REBUILD_LOG'"
    };

    private static string Keyword(bool rebuildLog) => rebuildLog ? " FOR ATTACH_REBUILD_LOG" : " FOR ATTACH";

    /// <summary>The batch that attaches one database in master (@db), from @p1 and @design. <paramref name="dryRun"/> (the live
    /// checks only, never the wire) selects the statement instead of running it.</summary>
    public static string Executable(bool rebuildLog, bool dryRun = false) =>
        "IF @p1 IS NULL OR ISNULL(ISJSON(@design), 0) = 0 THROW 50000, N'The design could not be read.', 1;\n"
        + "DECLARE @f TABLE (ordinal int PRIMARY KEY, quoted nvarchar(max) NULL);\n"
        + "INSERT @f (ordinal, quoted) SELECT CONVERT(int, a.[key]), CASE WHEN a.[type] = 1 AND DATALENGTH(a.value) BETWEEN 2 AND 520 "
        + "THEN N'( FILENAME = N''' + REPLACE(a.value COLLATE Latin1_General_BIN2, N'''', N'''''') + N''' )' END FROM OPENJSON(@design) AS a;\n"
        + "IF NOT EXISTS (SELECT 1 FROM @f) OR EXISTS (SELECT 1 FROM @f AS q WHERE q.quoted IS NULL) THROW 50000, N'A file could not be read.', 1;\n"
        + "DECLARE @i int = 0, @n int = (SELECT COUNT(*) FROM @f), @list nvarchar(max) = N'';\n"
        + "WHILE @i < @n BEGIN SELECT @list = @list + CASE WHEN @i = 0 THEN N'' ELSE N', ' END + x.quoted FROM @f AS x WHERE x.ordinal = @i; SET @i = @i + 1; END;\n"
        + "DECLARE @stmt nvarchar(max) = N'CREATE DATABASE ' + QUOTENAME(@p1) + N' ON ' + @list + N'" + Keyword(rebuildLog) + "';\n"
        + ActionSql.Guard
        + (dryRun ? "SELECT @stmt AS stmt;" : "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;");

    /// <summary>The JSON array of paths @design carries.</summary>
    public static string Design(AttachStatement statement) => JsonSerializer.Serialize(statement.Files);

    /// <summary>The statement as the server builds it, names and paths quoted by C#: one line, files in order.</summary>
    public static string Statement(AttachStatement statement) =>
        "CREATE DATABASE " + ActionSql.Quote(statement.Name) + " ON " + string.Join(", ", statement.Files.Select(file => "( FILENAME = N'" + file.Replace("'", "''", StringComparison.Ordinal) + "' )"))
        + Keyword(statement.RebuildLog);

    /// <summary>Script Action's text: USE [master], the statement, GO.</summary>
    public static string ScriptText(AttachStatement statement) => "USE [master]" + ActionSql.NL + "GO" + ActionSql.NL + Statement(statement) + ActionSql.NL + "GO" + ActionSql.NL;

    // --- Lint -----------------------------------------------------------------------------------------------------------

    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    [GeneratedRegex(@"@\w+")]
    private static partial Regex Variable();
    [GeneratedRegex(@"DECLARE ([^;]*);")]
    private static partial Regex Declaration();
    [GeneratedRegex(@"(?:^|, )(@\w+) ")]
    private static partial Regex DeclaredName();
    /// <summary>The one form a path takes: a JSON string value, its quotes doubled on the server in a binary collation.</summary>
    private const string PathQuote = "REPLACE(a.value COLLATE Latin1_General_BIN2, N'''', N'''''')";
    /// <summary>The one other place a JSON value appears: its type and length checks.</summary>
    private const string PathCheck = "a.[type] = 1 AND DATALENGTH(a.value) BETWEEN 2 AND 520";
    /// <summary>The one OPENJSON the batch reads paths through, without a WITH clause, so a path is only ever a.value.</summary>
    private const string PathSource = "FROM OPENJSON(@design) AS a;";
    /// <summary>A JSON value however T-SQL spells it: any alias, any case, bracketed or not.</summary>
    [GeneratedRegex(@"(?<![\w\]])\[?value\]?(?![\w\[])", RegexOptions.IgnoreCase)]
    private static partial Regex ValueToken();
    [GeneratedRegex("OPENJSON", RegexOptions.IgnoreCase)]
    private static partial Regex OpenJson();

    /// <summary>Problems with one attach builder batch: a format hole, a password use, no quoting guard, @db or @p1 outside
    /// QUOTENAME, @design outside ISJSON and OPENJSON, a JSON value anywhere but the path quoting (and its type and length
    /// checks), STRING_AGG (SQL Server 2017), dynamic SQL other than the module EXEC, an undeclared variable, and a literal
    /// beyond <see cref="Literals"/>.</summary>
    public static List<string> Lint(string text)
    {
        var problems = new List<string>();
        if (text.Contains('{', StringComparison.Ordinal) || text.Contains('}', StringComparison.Ordinal)) problems.Add("has a format hole");
        problems.AddRange(CatalogSql.SecretUses(text));
        if (!text.Contains(ActionSql.Guard, StringComparison.Ordinal)) problems.Add("has no quoting guard");
        if (text.Contains("STRING_AGG", StringComparison.OrdinalIgnoreCase)) problems.Add("uses STRING_AGG, which SQL Server 2016 lacks");
        if (text.Contains("EXEC (", StringComparison.Ordinal) || text.Contains("EXEC(", StringComparison.Ordinal) || text.Contains("sp_executesql @", StringComparison.Ordinal)) problems.Add("runs dynamic SQL");
        if (Variable().Matches(text.Replace("QUOTENAME(@db)", "", StringComparison.Ordinal)).Any(used => used.Value == "@db")) problems.Add("uses @db outside QUOTENAME");
        if (Variable().Matches(text.Replace("QUOTENAME(@p1)", "", StringComparison.Ordinal).Replace("IF @p1 IS NULL", "", StringComparison.Ordinal)).Any(used => used.Value == "@p1"))
            problems.Add("uses @p1 outside QUOTENAME");
        if (Variable().Matches(text.Replace("ISJSON(@design)", "", StringComparison.Ordinal).Replace("OPENJSON(@design)", "", StringComparison.Ordinal)).Any(used => used.Value == "@design"))
            problems.Add("uses @design outside ISJSON or OPENJSON");
        // A path reaches the statement only quoted: once the quoting and its checks are taken out no JSON value is left, whatever
        // its alias, case or brackets, and the one OPENJSON has no WITH clause to read one under another name.
        var values = text.Replace(PathQuote, "", StringComparison.Ordinal).Replace(PathCheck, "", StringComparison.Ordinal);
        if (ValueToken().IsMatch(values)) problems.Add("uses a JSON value outside the path quoting");
        if (OpenJson().Matches(text).Count != 1 || !text.Contains(PathSource, StringComparison.Ordinal)) problems.Add("reads the design other than " + PathSource);
        var declared = Declaration().Matches(text).SelectMany(match => DeclaredName().Matches(match.Groups[1].Value).Select(name => name.Groups[1].Value)).ToHashSet(StringComparer.Ordinal);
        foreach (Match used in Variable().Matches(text)) if (used.Value is not ("@db" or "@p1" or "@design") && !declared.Contains(used.Value)) problems.Add("uses the undeclared " + used.Value);
        foreach (Match literal in LiteralPattern().Matches(text)) if (!Literals.Contains(literal.Value)) problems.Add("has the literal " + literal.Value);
        return problems;
    }

    /// <summary>Problems with a CHECKPRIMARYFILE batch: anything but DBCC CHECKPRIMARYFILE (@mdf, n) with SMO's options 0, 2 and 3.</summary>
    public static List<string> LintPrimary(string text)
    {
        var problems = new List<string>();
        var rest = text;
        foreach (var option in new[] { "0", "2", "3" }) rest = rest.Replace("DBCC CHECKPRIMARYFILE (@mdf, " + option + ");", "", StringComparison.Ordinal);
        if (rest.Trim().Length > 0) problems.Add("holds more than DBCC CHECKPRIMARYFILE (@mdf, 0, 2 or 3)");
        if (LiteralPattern().IsMatch(text)) problems.Add("has a literal");
        return problems;
    }

    /// <summary>Every attach statement with its lint problems (AttachChecks): the four builder variants, the CHECKPRIMARYFILE
    /// batches, and the catalog statements for every band.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> LintAll()
    {
        foreach (var rebuild in new[] { false, true })
            foreach (var dry in new[] { false, true })
                yield return ("attach" + (rebuild ? " rebuild log" : "") + (dry ? " (dry run)" : ""), Lint(Executable(rebuild, dry)));
        yield return ("attach is primary", LintPrimary(IsPrimary));
        yield return ("attach primary", LintPrimary(Primary));
        yield return ("attach properties", LintPrimary(Properties));
        for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
        {
            yield return ("attach facts band " + band, ActionSql.LintCatalog(Facts, band, database: false));
            yield return ("attach preflight band " + band, ActionSql.LintCatalog(Preflight, band, database: false));
            yield return ("attach identity band " + band, ActionSql.LintCatalog(Attached, band, database: false));
        }
    }

    /// <summary>The design's paths as the batch reads them, for the offline checks: a JSON array of strings.</summary>
    internal static IReadOnlyList<string> Paths(string design)
    {
        using var document = JsonDocument.Parse(design);
        var paths = new List<string>();
        foreach (var item in document.RootElement.EnumerateArray()) paths.Add(item.GetString() ?? throw new InvalidOperationException("A path is not a string."));
        return paths;
    }
}
