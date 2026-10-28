using System.Text.RegularExpressions;
using Varia.Backend.Explorer;
using Varia.Backend.Ssis;

namespace Varia.Backend.Live;

/// <summary>How one series of a probe is read from its query's single row: the column holding its raw value, and for a
/// ratio or cpuPercent series the column holding its base (the base counter, or the scheduler count).</summary>
internal sealed record LiveSeriesColumn(string Series, string Column, string? Base = null);

/// <summary>One result set of a probe's batch that fills a table: the table's index in the catalogue entry, whose columns it
/// returns by name and type in catalogue order. An append table's read takes @after{i} (the settled id), @top{i} (how many
/// rows) and @before{i} (where the table ends, or NULL), i its index, and orders by its keyset id. Tail, for an append
/// table that can start at its last rows, is a statement returning one row (after_id, earlier) for @tail{i} rows before
/// @before{i}: the id to read after, and how many matching rows that leaves out. View gives the predicate of a view id the
/// probe declares (rows filtered in memory), or null for all rows.</summary>
internal sealed record LiveTableRead(int Table, string? Tail = null, Func<string, LiveRow, bool>? View = null);

/// <summary>One probe's constant text for one band: the statement after the prologue, the columns its one metrics row has (in
/// order; none when the probe has no series), the server clock columns (ms_ticks and the start time in ticks, null where the
/// probe cannot read them), where each catalogue series comes from, and the result sets that follow it, one per table, in
/// order. Filtered: the text takes @filter, a LIKE pattern of a restart-mode filter's text (NULL without one), so the
/// statement's own columns are the ones it filters.</summary>
internal sealed record LiveQuery(string Probe, int Band, string Body, string[] Columns, string? MsTicks, string? StartTicks, LiveSeriesColumn[] Series)
{
    public LiveTableRead[] Tables { get; init; } = [];
    public bool Filtered { get; init; }

    public string Text(string prologue) => prologue + Body;

    /// <summary>Every command the probe runs: its batch, and each append table's tail statement.</summary>
    public IEnumerable<string> Texts(string prologue) => [Text(prologue), .. Tables.Where(table => table.Tail is not null).Select(table => prologue + table.Tail)];

    /// <summary>Why this query does not fit its catalogue entry: its tables, in order, by index and mode, a tail only for an
    /// append table, and only column types live tables store.</summary>
    public List<string> Problems(LiveProbeJson spec)
    {
        var problems = new List<string>();
        if (Columns.Length == 0 != (spec.Series.Count == 0)) problems.Add("has a metrics row without series, or series without one");
        var indexes = Tables.Select(table => table.Table).ToList();
        if (!indexes.SequenceEqual(Enumerable.Range(0, spec.Tables.Count))) problems.Add("does not read every table once, in order");
        foreach (var table in Tables.Where(table => table.Table >= 0 && table.Table < spec.Tables.Count))
        {
            var catalogTable = spec.Tables[table.Table];
            if (table.Tail is not null && catalogTable.Mode != "append") problems.Add("has a tail for a snapshot table");
            if (catalogTable.Columns.FirstOrDefault(column => !LiveCells.Supports(column.DataType)) is { } column) problems.Add("stores a type live tables do not: " + column.DataType);
        }
        return problems;
    }

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

    /// <summary>Once per opened connection: its session id and whether the login may read server state (the permission name
    /// is a parameter: VIEW SERVER PERFORMANCE STATE from SQL Server 2022, VIEW SERVER STATE before and on Managed Instance).</summary>
    public const string Session = "SELECT @@SPID, CONVERT(int, ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, @permission), 0));";

    /// <summary>An SSISDB source's session probe, in the catalog's database: its session id and whether that database has
    /// READ_COMMITTED_SNAPSHOT on (@catalog), which picks the prologue of its later commands. Catalog views need no server
    /// permission: row-level security shows the login what it may read.</summary>
    public const string SsisSession = "SELECT @@SPID, (SELECT CONVERT(int, d.is_read_committed_snapshot_on) FROM sys.databases AS d WHERE d.name = @catalog);";

    /// <summary>An SSISDB source whose connection could not open the catalog's database: its state and user access, read on
    /// a connection in the login's own database, and whether the login sees every database's row (VIEW ANY DATABASE). No row
    /// says there is no catalog only when it does: without the permission a login sees no row of a database it cannot open.</summary>
    public const string CatalogState = "SELECT d.state, d.user_access, x.sees_all FROM (SELECT CONVERT(int, ISNULL(HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW ANY DATABASE'), 0)) AS sees_all) AS x\n"
        + "LEFT JOIN sys.databases AS d ON d.name = @catalog;";

    public const string OperationsProbe = "ssis.operations.list";

    /// <summary>An operation's folder and project as the Operations view shows and filters them: an execution's, a validation's,
    /// and a deployment's project (its object). Package is an execution's only.</summary>
    private const string OperationNames = "CROSS APPLY (SELECT COALESCE(e.folder_name, v.folder_name) AS folder_name,\n"
        + "    COALESCE(e.project_name, v.project_name, CASE WHEN o.operation_type = 101 THEN o.object_name END) AS project_name) AS n\n";
    private const string OperationsFrom = "FROM [catalog].[operations] AS o LEFT JOIN [catalog].[executions] AS e ON e.execution_id = o.operation_id\n"
        + "LEFT JOIN [catalog].[validations] AS v ON v.validation_id = o.operation_id\n" + OperationNames;
    private const string OperationColumns = "SELECT TOP (@take) o.operation_id, o.operation_type, o.status, o.created_time, o.start_time, o.end_time, o.object_name, n.folder_name, n.project_name, e.package_name,\n"
        + "    o.caller_name, o.stopped_by_name, o.server_name, o.machine_name, DATEDIFF_BIG(millisecond, o.start_time, ISNULL(o.end_time, SYSDATETIMEOFFSET())) AS duration_ms\n";

    /// <summary>The Operations view's scope, as SsisOperationsReader binds it (NULL: no filter). Kinds are the operation types
    /// they name (@types, an xml list) plus every type no kind names when Other is on (@other); names match by LIKE with their
    /// wildcards escaped, from the start when a prefix asks for it; the caller exactly. The status filter and the window are
    /// not part of it.</summary>
    private static readonly string OperationScope =
        "    AND (@types IS NULL OR o.operation_type IN (SELECT t.i.value('.', 'int') FROM @types.nodes('/i') AS t(i))\n"
        + "        OR (@other = 1 AND o.operation_type NOT IN (" + string.Join(", ", SsisCatalog.Current.OperationKinds.Values.SelectMany(types => types)) + ")))\n"
        + "    AND (@folder IS NULL OR n.folder_name LIKE @folder ESCAPE N'\\') AND (@project IS NULL OR n.project_name LIKE @project ESCAPE N'\\')\n"
        + "    AND (@package IS NULL OR e.package_name LIKE @package ESCAPE N'\\') AND (@caller IS NULL OR o.caller_name = @caller)\n";

    private static string OpenStatuses => string.Join(", ", SsisCatalog.Current.OpenStatuses.Order());
    private static string CountOf(OperationTile tile) => "COUNT_BIG(CASE WHEN o.status IN (" + string.Join(", ", tile.Statuses) + ") THEN 1 END) AS " + tile.Series;

    /// <summary>One Operations sample (SsisOperationsReader), in the catalog's database, its result sets in this order:
    /// <list type="number">
    /// <item>the newest @take operations above @after in the scope that are open, or were created in the last @window hours and
    /// pass the status filter (@statuses, an xml list; an open one that does not pass it is read too, since it can still end in a
    /// status that does, and the window follows it unseen);</item>
    /// <item>on a <paramref name="baseline"/> only, the newest @take open operations in the scope whatever their age, so finished
    /// ones never crowd a long run out of a new window;</item>
    /// <item>the open ones the window holds (@open, an xml list of ids) as they are now;</item>
    /// <item>the server's time;</item>
    /// <item>the open tiles' counts (Running, Pending) over every operation the login may see, whatever the scope;</item>
    /// <item>when <paramref name="counts"/>, each final tile's count over its hours, also whatever the scope.</item>
    /// </list>
    /// An execution and a validation share their id with their operation. Durations are the server's, to its own time while an
    /// operation runs. Times stay datetimeoffset.</summary>
    public static string Operations(bool counts, bool baseline)
    {
        var tiles = SsisCatalog.Current.OperationTiles;
        var text = OperationColumns + OperationsFrom
            + "WHERE o.operation_id > @after AND (o.status IN (" + OpenStatuses + ")\n"
            + "    OR o.created_time >= DATEADD(hour, -@window, SYSDATETIMEOFFSET()) AND (@statuses IS NULL OR o.status IN (SELECT s.i.value('.', 'int') FROM @statuses.nodes('/i') AS s(i))))\n"
            + OperationScope
            + "ORDER BY o.operation_id DESC;\n";
        if (baseline) text += OperationColumns + OperationsFrom + "WHERE o.status IN (" + OpenStatuses + ")\n" + OperationScope + "ORDER BY o.operation_id DESC;\n";
        var open = tiles.Where(tile => tile.LastHours is null).ToList();
        text += "SELECT o.operation_id, o.status, o.start_time, o.end_time, o.stopped_by_name, DATEDIFF_BIG(millisecond, o.start_time, ISNULL(o.end_time, SYSDATETIMEOFFSET())) AS duration_ms\n"
            + "FROM [catalog].[operations] AS o WHERE o.operation_id IN (SELECT r.i.value('.', 'bigint') FROM @open.nodes('/i') AS r(i));\n"
            + "SELECT SYSDATETIMEOFFSET() AS server_now;\n"
            + "SELECT " + string.Join(", ", open.Select(CountOf)) + " FROM [catalog].[operations] AS o WHERE o.status IN (" + string.Join(", ", open.SelectMany(tile => tile.Statuses).Order()) + ");";
        if (!counts) return text;
        // The catalogue gives every final tile the same hours, so one read counts them all.
        var final = tiles.Where(tile => tile.LastHours is not null).ToList();
        var hours = final.Select(tile => tile.LastHours!.Value).Distinct().Single();
        return text + "\nSELECT " + string.Join(", ", final.Select(CountOf)) + " FROM [catalog].[operations] AS o\n"
            + "WHERE o.created_time >= DATEADD(hour, -" + hours.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", SYSDATETIMEOFFSET());";
    }

    public const string OverviewProbe = "activity.overview";

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

    /// <summary>The probe's query at a band, or null when the probe has none there (not a SQL probe, or below its gate).</summary>
    public static LiveQuery? For(string probe, int band) => probe switch
    {
        OverviewProbe when band is >= MinBand and <= MaxBand => new(probe, band, Overview, OverviewColumns, "ms_ticks", "start_ticks", OverviewSeries),
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
        if (code.Contains("@@SPID", StringComparison.OrdinalIgnoreCase) && !text.EndsWith(Session, StringComparison.Ordinal) && !text.EndsWith(SsisSession, StringComparison.Ordinal))
            problems.Add("reads @@SPID outside the session probe");
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
