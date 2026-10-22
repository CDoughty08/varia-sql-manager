using System.Text.RegularExpressions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Live;

/// <summary>How one series of a probe is read from its query's single row: the column holding its raw value, and for a
/// ratio or cpuPercent series the column holding its base (the base counter, or the scheduler count).</summary>
internal sealed record LiveSeriesColumn(string Series, string Column, string? Base = null);

/// <summary>One probe's constant text for one band: the statement after the prologue, the columns its one row has (in
/// order), the server clock columns (ms_ticks and the start time in ticks, null where the probe cannot read them) and where
/// each catalogue series comes from.</summary>
internal sealed record LiveQuery(string Probe, int Band, string Body, string[] Columns, string? MsTicks, string? StartTicks, LiveSeriesColumn[] Series)
{
    public string Text(string prologue) => prologue + Body;
}

/// <summary>The SQL of every live probe that reads SQL Server (docs/live.md): constant text per probe and band, values only
/// as parameters, no metadata built-ins (they ignore LOCK_TIMEOUT and the isolation level), no temporary tables, writes,
/// transactions, waits or dynamic SQL. Every command starts with its scope's prologue, since a pooled connection can carry
/// another command's SET state. Lint renders every variant; the checks run it offline, and the live checks compare each
/// query's columns with what SQL Server returns.</summary>
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

    [GeneratedRegex(@"\b(CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|MERGE|GRANT|REVOKE|DENY|INTO|EXEC|EXECUTE|WAITFOR|USE|KILL|SHUTDOWN|DBCC|RECONFIGURE|BACKUP|RESTORE)\b", RegexOptions.IgnoreCase)]
    private static partial Regex Forbidden();
    [GeneratedRegex(@"\bBEGIN\s+(TRAN|TRANSACTION|DISTRIBUTED)\b|\bSAVE\s+TRAN|\bCOMMIT\b|\bROLLBACK\b", RegexOptions.IgnoreCase)]
    private static partial Regex Transaction();
    [GeneratedRegex(@"\bTOP\s*\(", RegexOptions.IgnoreCase)]
    private static partial Regex Top();
    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex Literal();

    /// <summary>Problems with one command's full text (prologue and statement); empty when it passes.</summary>
    public static List<string> Lint(string text)
    {
        var problems = new List<string>();
        if (!text.StartsWith(UncommittedPrologue, StringComparison.Ordinal) && !text.StartsWith(CommittedPrologue, StringComparison.Ordinal)) problems.Add("does not start with a live prologue");
        // Literals are constant text, but a keyword inside one must not hide from the checks below, nor one outside pass.
        var code = Literal().Replace(text, "''");
        foreach (var builtin in Builtins) if (code.Contains(builtin, StringComparison.OrdinalIgnoreCase)) problems.Add("uses " + builtin);
        if (code.Contains('#')) problems.Add("uses a temporary table");
        if (code.Contains("sp_executesql", StringComparison.OrdinalIgnoreCase)) problems.Add("runs dynamic SQL");
        foreach (Match match in Forbidden().Matches(code)) problems.Add("uses " + match.Value.ToUpperInvariant());
        if (Transaction().IsMatch(code)) problems.Add("controls a transaction");
        if (Top().IsMatch(code) && !code.Contains("ORDER BY", StringComparison.OrdinalIgnoreCase)) problems.Add("takes TOP without ORDER BY");
        if (code.Contains("@@SPID", StringComparison.OrdinalIgnoreCase) && !text.EndsWith(Session, StringComparison.Ordinal)) problems.Add("reads @@SPID outside the session probe");
        return problems;
    }
}
