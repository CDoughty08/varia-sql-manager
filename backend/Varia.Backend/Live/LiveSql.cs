using System.Text.RegularExpressions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Live;

/// <summary>How one series of a probe is read from its query's single row: the column holding its raw value, and for a
/// ratio or cpuPercent series the column holding its base (the base counter, or the scheduler count).</summary>
internal sealed record LiveSeriesColumn(string Series, string Column, string? Base = null);

/// <summary>A status value of a probe read from its query's single row: the catalogue's status id and its column.</summary>
internal sealed record LiveStatusColumn(string Status, string Column);

/// <summary>One probe's constant text for one band: the statement after the prologue, the columns its one row has (in
/// order), the server clock columns (ms_ticks and the start time in ticks, null where the probe cannot read them), where
/// each catalogue series comes from, and each status value (whole numbers).</summary>
internal sealed record LiveQuery(string Probe, int Band, string Body, string[] Columns, string? MsTicks, string? StartTicks, LiveSeriesColumn[] Series, LiveStatusColumn[]? Status = null)
{
    public string Text(string prologue) => prologue + Body;

    private static readonly Type[] Numeric = [typeof(byte), typeof(short), typeof(int), typeof(long), typeof(decimal), typeof(float), typeof(double)];

    /// <summary>Whether a result's columns are the ones declared, by name and in order, each a number: values are read by
    /// their declared position, so a SELECT list edited without its declaration would put one series' value in another's.</summary>
    public bool Returns(IReadOnlyList<(string Name, Type Type)> columns) =>
        columns.Count == Columns.Length && columns.Select((column, index) => column.Name == Columns[index] && Numeric.Contains(column.Type)).All(match => match);
}

/// <summary>The SQL of every live probe that reads SQL Server (docs/live.md): constant text per probe and band, values only
/// as parameters, no metadata built-ins (they ignore LOCK_TIMEOUT and the isolation level), no temporary tables, writes,
/// transactions, waits or dynamic SQL. Every command starts with its scope's prologue, since a pooled connection can carry
/// another command's SET state. Lint renders every variant; the checks run it offline. Every read checks the columns it got
/// against the declaration (LiveQuery.Returns), and the live checks run every query at the server's band to compare them.</summary>
internal static partial class LiveSql
{
    /// <summary>SQL Server 2016, the oldest supported version, and 2025.</summary>
    public const int MinBand = 13;
    public const int MaxBand = 17;
    public const int LockTimeoutMs = 1000;

    /// <summary>Server DMVs, and SSISDB without READ_COMMITTED_SNAPSHOT: dirty reads are accepted, a lock wait is cut at 1 s
    /// (a BLOCKED value; the probe retries), and a live read loses any deadlock.</summary>
    public const string UncommittedPrologue = "SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SET LOCK_TIMEOUT 1000; SET DEADLOCK_PRIORITY LOW;\n";
    /// <summary>SSISDB with READ_COMMITTED_SNAPSHOT: versioned reads never wait on writers.</summary>
    public const string CommittedPrologue = "SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SET LOCK_TIMEOUT 1000; SET DEADLOCK_PRIORITY LOW;\n";

    /// <summary>Once per opened connection: its session id, whether the login may read server state (the permission name
    /// is a parameter: VIEW SERVER PERFORMANCE STATE from SQL Server 2022, VIEW SERVER STATE before and on Managed Instance),
    /// and for an SSISDB source whether the catalog's database has READ_COMMITTED_SNAPSHOT on (@catalog; NULL for server
    /// DMVs, which reads no row), which picks the prologue of its later commands.</summary>
    public const string Session = "SELECT @@SPID, CONVERT(int, ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, @permission), 0)),"
        + " (SELECT CONVERT(int, d.is_read_committed_snapshot_on) FROM sys.databases AS d WHERE d.name = @catalog);";

    /// <summary>An SSISDB source whose connection could not open the catalog's database: its state and user access, read on
    /// a connection in the login's own database. No row: there is no catalog.</summary>
    public const string CatalogState = "SELECT d.state, d.user_access FROM sys.databases AS d WHERE d.name = @catalog;";

    public const string OverviewProbe = "activity.overview";
    public const string CatalogProbe = "ssis.catalogProbe";

    // One row from four DMVs, so a sample is one round trip. total_cpu_usage_ms (2016 and later) counts only
    // non-preemptive time, as the series' label says. The counters' object name carries the instance prefix
    // (SQLServer: or MSSQL$NAME:), hence the suffix match.
    private const string Overview =
        "SELECT i.ms_ticks, i.sqlserver_start_time_ms_ticks AS start_ticks, s.cpu_ms, s.schedulers, s.runnable_tasks,\n"
        + "    c.batch_requests, c.compilations, c.recompilations, u.user_sessions\n"
        + "FROM sys.dm_os_sys_info AS i\n"
        + "CROSS JOIN (SELECT SUM(o.total_cpu_usage_ms) AS cpu_ms, COUNT(*) AS schedulers, SUM(o.runnable_tasks_count) AS runnable_tasks\n"
        + "    FROM sys.dm_os_schedulers AS o WHERE o.status = N'VISIBLE ONLINE') AS s\n"
        + "CROSS JOIN (SELECT SUM(CASE WHEN p.counter_name = N'Batch Requests/sec' THEN p.cntr_value END) AS batch_requests,\n"
        + "        SUM(CASE WHEN p.counter_name = N'SQL Compilations/sec' THEN p.cntr_value END) AS compilations,\n"
        + "        SUM(CASE WHEN p.counter_name = N'SQL Re-Compilations/sec' THEN p.cntr_value END) AS recompilations\n"
        + "    FROM sys.dm_os_performance_counters AS p\n"
        + "    WHERE p.object_name LIKE N'%:SQL Statistics%' AND p.counter_name IN (N'Batch Requests/sec', N'SQL Compilations/sec', N'SQL Re-Compilations/sec')) AS c\n"
        + "CROSS JOIN (SELECT COUNT(*) AS user_sessions FROM sys.dm_exec_sessions AS e WHERE e.is_user_process = 1) AS u;";

    private static readonly string[] OverviewColumns =
        ["ms_ticks", "start_ticks", "cpu_ms", "schedulers", "runnable_tasks", "batch_requests", "compilations", "recompilations", "user_sessions"];
    private static readonly LiveSeriesColumn[] OverviewSeries =
    [
        new("cpuPercent", "cpu_ms", "schedulers"), new("runnableTasks", "runnable_tasks"), new("batchRequests", "batch_requests"),
        new("compilations", "compilations"), new("recompilations", "recompilations"), new("userSessions", "user_sessions")
    ];

    /// <summary>What ssis.catalogProbe fingerprints, in the catalogue's order (src/shared/ssis/catalog.ts catalogFingerprints):
    /// each view's columns that the tree and its documents show, as text, and its sql_variant values as their bytes (text would
    /// round a datetime to the minute).</summary>
    private static readonly (string Id, string From, string Text, string[] Values)[] Fingerprints =
    [
        ("folders", "[catalog].[folders]", "x.folder_id, x.name, x.description", []),
        ("projects", "[catalog].[projects]", "x.project_id, x.folder_id, x.name, x.description, x.deployed_by_name, x.last_deployed_time, x.object_version_lsn", []),
        ("packages", "[catalog].[packages]", "x.package_id, x.project_id, x.name, x.entry_point, x.description", []),
        ("environments", "[catalog].[environments]", "x.environment_id, x.folder_id, x.name, x.description", []),
        ("variables", "[catalog].[environment_variables]", "x.variable_id, x.environment_id, x.name, x.description, x.type, x.sensitive", ["x.value"]),
        ("references", "[catalog].[environment_references]", "x.reference_id, x.project_id, x.reference_type, x.environment_folder_name, x.environment_name", []),
        ("parameters", "[catalog].[object_parameters]",
            "x.parameter_id, x.project_id, x.object_type, x.object_name, x.parameter_name, x.data_type, x.required, x.sensitive, x.description, x.value_type, x.value_set, x.referenced_variable_name",
            ["x.design_default_value", "x.default_value"]),
        ("properties", "[catalog].[catalog_properties]", "x.property_name, x.property_value", [])
    ];

    /// <summary>The view ids ssis.catalogProbe fingerprints, in order (the checks compare them with the catalogue).</summary>
    public static IEnumerable<string> FingerprintIds => Fingerprints.Select(view => view.Id);

    // One row: per view, its row count and a checksum, the sum of the first 3 bytes of each row's SHA-256 (under 2^53 for any
    // row count below 2^29, so it is exact in JavaScript). CHECKSUM_AGG would be cheaper, but it XORs: two equal rows cancel,
    // and BINARY_CHECKSUM misses changes past a long string's first characters. Rows are what row-level security shows the
    // login, so a fingerprint changes only when something it may see does.
    private static readonly string Catalog = BuildCatalog();
    private static readonly string[] CatalogColumns = [.. Fingerprints.SelectMany(view => new[] { view.Id + "_count", view.Id + "_checksum" })];
    private static readonly LiveStatusColumn[] CatalogStatus = [.. Fingerprints.SelectMany(view => new LiveStatusColumn[] { new(view.Id + "Count", view.Id + "_count"), new(view.Id + "Checksum", view.Id + "_checksum") })];

    private static string BuildCatalog()
    {
        static string Row((string Id, string From, string Text, string[] Values) view)
        {
            var text = "CONVERT(varbinary(max), CONCAT(" + string.Join(", NCHAR(31), ", view.Text.Split(", ")) + "))";
            return string.Concat(view.Values.Select(value => " + 0x1F + ISNULL(CONVERT(varbinary(8000), " + value + "), 0x)").Prepend(text));
        }
        var selects = Fingerprints.Select((view, index) => "v" + (index + 1) + ".n AS " + view.Id + "_count, v" + (index + 1) + ".h AS " + view.Id + "_checksum");
        var sources = Fingerprints.Select((view, index) => "(SELECT COUNT_BIG(*) AS n, ISNULL(SUM(CONVERT(bigint, SUBSTRING(HASHBYTES('SHA2_256', " + Row(view) + "), 1, 3))), 0) AS h\n"
            + "    FROM " + view.From + " AS x) AS v" + (index + 1));
        return "SELECT " + string.Join(",\n    ", selects) + "\nFROM " + string.Join("\nCROSS JOIN ", sources) + ";";
    }

    /// <summary>The probe's query at a band, or null when the probe has none there (not a SQL probe, or below its gate). The
    /// SSIS Catalog's views are the same on every version, and Azure SQL Database reports 12, so its probe runs at any band.</summary>
    public static LiveQuery? For(string probe, int band) => probe switch
    {
        OverviewProbe when band is >= MinBand and <= MaxBand => new(probe, band, Overview, OverviewColumns, "ms_ticks", "start_ticks", OverviewSeries),
        CatalogProbe when band is >= MinBand - 1 and <= MaxBand => new(probe, band, Catalog, CatalogColumns, null, null, [], CatalogStatus),
        _ => null
    };

    /// <summary>The prologue of a scope: server DMVs always read uncommitted; SSISDB reads committed when it has
    /// READ_COMMITTED_SNAPSHOT on.</summary>
    public static string Prologue(string scope, bool readCommittedSnapshot) => scope == "ssisdb" && readCommittedSnapshot ? CommittedPrologue : UncommittedPrologue;

    public static string Isolation(string prologue) => prologue == CommittedPrologue ? "readCommitted" : "readUncommitted";

    /// <summary>Every query the catalogue's SQL probes run, at every band.</summary>
    public static IEnumerable<LiveQuery> All(LiveCatalog catalog)
    {
        foreach (var probe in catalog.Probes.Values)
            for (var band = MinBand; band <= MaxBand; band++)
                if (For(probe.Id, band) is { } query) yield return query;
    }

    private static readonly string[] Builtins = [.. CatalogSql.Builtins, "DB_NAME(", "DB_ID(", "OBJECT_ID(", "FILE_NAME(", "FILE_ID(", "INDEXPROPERTY(", "COLUMNPROPERTY(", "SCHEMA_ID("];
    /// <summary>The built-ins as words, so a space before the parenthesis hides none (OBJECTPROPERTY also covers OBJECTPROPERTYEX).</summary>
    private static readonly (string Name, Regex Pattern)[] BuiltinPatterns = [.. Builtins.Select(builtin => (builtin.TrimEnd('('),
        new Regex(@"\b" + Regex.Escape(builtin.TrimEnd('(')) + (builtin.EndsWith('(') ? @"\s*\(" : ""), RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)))];

    // OPENQUERY, OPENROWSET and OPENDATASOURCE run text on another server (or through a provider), inside a literal the lint blanks.
    [GeneratedRegex(@"\b(CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|MERGE|GRANT|REVOKE|DENY|INTO|EXEC|EXECUTE|WAITFOR|USE|KILL|SHUTDOWN|DBCC|RECONFIGURE|BACKUP|RESTORE|OPENQUERY|OPENROWSET|OPENDATASOURCE)\b", RegexOptions.IgnoreCase)]
    private static partial Regex Forbidden();
    [GeneratedRegex(@"\bBEGIN\s+(TRAN|TRANSACTION|DISTRIBUTED)\b|\bSAVE\s+TRAN|\bCOMMIT\b|\bROLLBACK\b", RegexOptions.IgnoreCase)]
    private static partial Regex Transaction();
    [GeneratedRegex(@"\bTOP\b", RegexOptions.IgnoreCase)]
    private static partial Regex Top();
    [GeneratedRegex(@"\bORDER\s+BY\b", RegexOptions.IgnoreCase)]
    private static partial Regex OrderBy();
    /// <summary>One token the lint must not read as code, scanned left to right so each hides only what SQL Server would: a
    /// line or block comment, a string literal, or a bracketed or quoted identifier (any of which can hold a quote).</summary>
    [GeneratedRegex(@"--[^\r\n]*|/\*[\s\S]*?\*/|N?'(?:[^']|'')*'|\[(?:[^\]]|\]\])*\]|""(?:[^""]|"""")*""")]
    private static partial Regex Token();

    /// <summary>Problems with one command's full text (prologue and statement); empty when it passes.</summary>
    public static List<string> Lint(string text)
    {
        var problems = new List<string>();
        if (!text.StartsWith(UncommittedPrologue, StringComparison.Ordinal) && !text.StartsWith(CommittedPrologue, StringComparison.Ordinal)) problems.Add("does not start with a live prologue");
        // Literals and identifiers are constant text, but a keyword inside one must not hide from the checks below, nor one
        // outside pass. Comments are refused (they belong in C#), and blanked first so a quote in one hides no code after it.
        var commented = false;
        var code = Token().Replace(text, token => token.Value[0] switch
        {
            '-' or '/' => Comment(),
            '[' or '"' => "[x]",
            _ => "''"
        });
        string Comment()
        {
            commented = true;
            return " ";
        }
        if (commented || code.Contains("/*", StringComparison.Ordinal)) problems.Add("has a comment");
        foreach (var (name, pattern) in BuiltinPatterns) if (pattern.IsMatch(code)) problems.Add("uses " + name);
        if (code.Contains('#')) problems.Add("uses a temporary table");
        if (code.Contains("sp_executesql", StringComparison.OrdinalIgnoreCase)) problems.Add("runs dynamic SQL");
        foreach (Match match in Forbidden().Matches(code)) problems.Add("uses " + match.Value.ToUpperInvariant());
        if (Transaction().IsMatch(code)) problems.Add("controls a transaction");
        if (!TopsOrdered(code)) problems.Add("takes TOP without ORDER BY");
        if (code.Contains("@@SPID", StringComparison.OrdinalIgnoreCase) && !text.EndsWith(Session, StringComparison.Ordinal)) problems.Add("reads @@SPID outside the session probe");
        return problems;
    }

    /// <summary>Every TOP has an ORDER BY after it at its own level: in its parenthesised query, or in its statement (up to
    /// the next semicolon outside parentheses). An ORDER BY nested deeper, such as a window's OVER (ORDER BY …), orders
    /// nothing TOP takes.</summary>
    private static bool TopsOrdered(string code)
    {
        var depth = new int[code.Length + 1];
        for (int i = 0, level = 0; i < code.Length; i++)
        {
            if (code[i] == ')') level--;
            depth[i] = level;
            if (code[i] == '(') level++;
        }
        var orders = OrderBy().Matches(code).Select(match => match.Index).ToList();
        foreach (Match top in Top().Matches(code))
        {
            var level = depth[top.Index];
            var end = top.Index;
            while (end < code.Length && depth[end] >= level && !(code[end] == ';' && depth[end] == level)) end++;
            if (!orders.Any(order => order > top.Index && order < end && depth[order] == level)) return false;
        }
        return true;
    }
}
