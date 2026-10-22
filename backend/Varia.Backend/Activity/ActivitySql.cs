using System.Data;
using System.Text.RegularExpressions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Activity;

/// <summary>Everything a statement's text depends on: the version band (13 = SQL Server 2016 to 17 = 2025), the kind of
/// server, and whether sys.dm_exec_query_stats has total_spills (2016 SP2 and 2017 CU3 onward).</summary>
internal readonly record struct ActivityRender(int Band, string Edition, bool TotalSpills = false);

/// <summary>A typed parameter of a statement; values never reach the text.</summary>
internal sealed record ActivityParameter(string Name, SqlDbType Type, int Size = 0);

/// <summary>One statement of a probe's sample. Statements run in order on the probe's connection, each on its own, so a
/// permission error on one marks only what it <see cref="Feeds"/> (tables, series, or "clock" for the time base) and the
/// sample goes on. <see cref="Columns"/> are the names it returns, in order; the live checks compare them with the server.</summary>
internal sealed record ActivityStatement(string Probe, string Id, string Text, IReadOnlyList<string> Columns, IReadOnlyList<ActivityParameter> Parameters, IReadOnlyList<string> Feeds,
    IReadOnlySet<string> Literals)
{
    /// <summary>What runs: the prologue, then the statement (a pooled connection can carry another command's SET state).</summary>
    public string Batch => ActivitySql.Prologue + Text;
}

/// <summary>The Activity Monitor's constant SQL: one text per probe, statement and render, written from Microsoft Learn's
/// documented DMV columns (never SSMS's). Values are parameters; no metadata built-ins, temp tables, tempdb writes,
/// sys.sysprocesses or locks DMV; every TOP is ordered. The offline lint renders and checks every variant; the kill and
/// details statements (AM-K) and the capability probe (AM1) join with their own exemptions.</summary>
internal static partial class ActivitySql
{
    /// <summary>A probe never waits more than a second behind a lock and loses deadlocks (D-live's live prologue).</summary>
    public const string Prologue = "SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SET LOCK_TIMEOUT 1000; SET DEADLOCK_PRIORITY LOW;\n";
    /// <summary>Statement texts Recent Expensive Queries fetches per statement (TypeScript's activityLimits.textBatch).</summary>
    public const int TextSlots = 50;

    private static ActivityParameter Int(string name) => new(name, SqlDbType.Int);
    private static ActivityParameter Handle(string name) => new(name, SqlDbType.VarBinary, 64);
    private static readonly HashSet<string> NoLiterals = [];
    // Text sizes and the lead blockers' TOP come from the catalogue's limits, so docs/activity-monitor.md states what runs.
    private static long Limit(string key) => ActivityCatalog.Current.Limit(key);

    // --- Statements -----------------------------------------------------------------------------------------------------

    private static ActivityStatement Clock(string probe) => new(probe, "clock",
        "SELECT i.ms_ticks, i.sqlserver_start_time_ms_ticks, i.sqlserver_start_time, i.cpu_count, i.scheduler_count, @@SPID AS monitor_spid,\n"
        + "       SYSDATETIMEOFFSET() AS server_time, GETDATE() AS server_local_time\nFROM sys.dm_os_sys_info AS i;",
        ["ms_ticks", "sqlserver_start_time_ms_ticks", "sqlserver_start_time", "cpu_count", "scheduler_count", "monitor_spid", "server_time", "server_local_time"], [], ["clock"], NoLiterals);

    // Object names carry an instance prefix (SQLServer:, MSSQL$NAME:) and are padded nchar(128), so they are matched with
    // a % on both sides: LIKE N'%:SQL Statistics' matches nothing.
    private static readonly HashSet<string> CounterLiterals =
    [
        "N'%:SQL Statistics%'", "N'Batch Requests/sec'", "N'SQL Compilations/sec'", "N'SQL Re-Compilations/sec'", "N'%:Memory Manager%'", "N'Memory Grants Pending'",
        "N'Memory Grants Outstanding'", "N'%:Locks%'", "N'_Total'", "N'Lock Waits/sec'", "N'Number of Deadlocks/sec'", "N'%:Buffer Manager%'", "N'Page life expectancy'",
        "N'%:General Statistics%'", "N'Logins/sec'"
    ];

    private static IReadOnlyList<ActivityStatement> Overview() =>
    [
        Clock("activity.overview"),
        new("activity.overview", "cpu",
            "SELECT SUM(s.total_cpu_usage_ms) AS cpu_ms, COUNT(*) AS schedulers, SUM(s.runnable_tasks_count) AS runnable_tasks, SUM(s.work_queue_count) AS work_queue,\n"
            + "       SUM(s.current_workers_count) AS workers, SUM(s.active_workers_count) AS active_workers, SUM(s.total_scheduler_delay_ms) AS scheduler_delay_ms\n"
            + "FROM sys.dm_os_schedulers AS s WHERE s.status = N'VISIBLE ONLINE';",
            ["cpu_ms", "schedulers", "runnable_tasks", "work_queue", "workers", "active_workers", "scheduler_delay_ms"], [], ["cpuPercent", "schedulerDelay", "runnablePerScheduler", "workQueue"],
            new HashSet<string> { "N'VISIBLE ONLINE'" }),
        new("activity.overview", "counters",
            "SELECT RTRIM(p.object_name) AS object_name, RTRIM(p.counter_name) AS counter_name, RTRIM(p.instance_name) AS instance_name, p.cntr_value, p.cntr_type\n"
            + "FROM sys.dm_os_performance_counters AS p\n"
            + "WHERE (p.object_name LIKE N'%:SQL Statistics%' AND p.counter_name IN (N'Batch Requests/sec', N'SQL Compilations/sec', N'SQL Re-Compilations/sec'))\n"
            + "   OR (p.object_name LIKE N'%:Memory Manager%' AND p.counter_name IN (N'Memory Grants Pending', N'Memory Grants Outstanding'))\n"
            + "   OR (p.object_name LIKE N'%:Locks%' AND p.instance_name = N'_Total' AND p.counter_name IN (N'Lock Waits/sec', N'Number of Deadlocks/sec'))\n"
            + "   OR (p.object_name LIKE N'%:Buffer Manager%' AND p.counter_name = N'Page life expectancy')\n"
            + "   OR (p.object_name LIKE N'%:General Statistics%' AND p.counter_name = N'Logins/sec');",
            ["object_name", "counter_name", "instance_name", "cntr_value", "cntr_type"], [],
            ["batchRequests", "compilations", "recompilations", "grantsPending", "grantsOutstanding", "lockWaits", "deadlocks", "pageLifeExpectancy", "logins"], CounterLiterals),
        new("activity.overview", "io",
            "SELECT SUM(f.num_of_bytes_read) AS bytes_read, SUM(f.num_of_bytes_written) AS bytes_written, SUM(f.num_of_reads) AS reads, SUM(f.num_of_writes) AS writes,\n"
            + "       SUM(f.io_stall_read_ms) AS read_stall_ms, SUM(f.io_stall_write_ms) AS write_stall_ms\nFROM sys.dm_io_virtual_file_stats(NULL, NULL) AS f;",
            ["bytes_read", "bytes_written", "reads", "writes", "read_stall_ms", "write_stall_ms"], [], ["ioMegabytes", "readLatency", "writeLatency"], NoLiterals),
        // Classified in C# by the catalogue's map; only rows with time.
        new("activity.overview", "waits",
            "SELECT w.wait_type, w.wait_time_ms, w.signal_wait_time_ms FROM sys.dm_os_wait_stats AS w WHERE w.wait_time_ms > 0;",
            ["wait_type", "wait_time_ms", "signal_wait_time_ms"], [], ["waitingTasks"], NoLiterals),
        new("activity.overview", "blocked",
            "SELECT COUNT(DISTINCT w.session_id) AS blocked_sessions, MAX(w.wait_duration_ms) AS longest_wait_ms\n"
            + "FROM sys.dm_os_waiting_tasks AS w WHERE w.session_id IS NOT NULL AND w.blocking_session_id > 0 AND w.blocking_session_id <> w.session_id;",
            ["blocked_sessions", "longest_wait_ms"], [], ["blockedSessions", "longestBlock"], NoLiterals),
        // A MARS session has several requests, so requests are folded per session before the count; the monitor's own is left out.
        new("activity.overview", "requests",
            "SELECT SUM(CASE WHEN s.is_user_process = 1 THEN 1 ELSE 0 END) AS user_sessions,\n"
            + "       SUM(CASE WHEN s.is_user_process = 1 AND r.session_id IS NOT NULL THEN 1 ELSE 0 END) AS active_requests\n"
            + "FROM sys.dm_exec_sessions AS s\nLEFT JOIN (SELECT DISTINCT q.session_id FROM sys.dm_exec_requests AS q) AS r ON r.session_id = s.session_id\n"
            + "WHERE s.session_id <> @@SPID;",
            ["user_sessions", "active_requests"], [], ["activeRequests", "userSessions"], NoLiterals)
    ];

    private static IReadOnlyList<ActivityStatement> Sessions() =>
    [
        Clock("activity.sessions"),
        // One row per session, so @rowCap (the cap plus one, to see truncation) counts sessions. MARS requests fold here: a
        // blocked request (else the lowest) gives the request columns, and the request count, CPU and reads cover them all.
        // Sessions in a blocking wait, as waiter or blocker, come first and then sessions with a request, so truncation drops
        // idle sessions and never a session the edges name.
        new("activity.sessions", "sessions",
            "SELECT TOP (@rowCap) s.session_id, s.login_time, s.host_process_id, s.is_user_process, s.login_name, s.original_login_name, s.host_name,\n"
            + "       s.program_name, s.client_interface_name, s.status, s.database_id, d.name AS database_name, s.cpu_time, s.reads, s.writes, s.logical_reads,\n"
            + "       s.memory_usage, s.open_transaction_count, s.last_request_start_time, s.last_request_end_time, s.transaction_isolation_level,\n"
            + "       g.name AS workload_group, c.client_net_address, c.net_transport, c.encrypt_option, c.auth_scheme,\n"
            + "       r.request_id, r.request_count, r.lowest_request_id, r.status AS request_status, r.command, r.start_time, r.total_elapsed_time, r.request_cpu_ms,\n"
            + "       r.request_logical_reads, r.request_reads, r.request_writes, r.blocking_session_id, r.wait_type, r.wait_time,\n"
            + "       r.wait_resource, r.last_wait_type, r.open_transaction_count AS request_open_transactions, r.percent_complete, r.granted_query_memory,\n"
            + "       r.dop, r.query_hash, r.database_id AS request_database_id\n"
            + "FROM sys.dm_exec_sessions AS s\n"
            + "LEFT JOIN sys.dm_exec_connections AS c ON c.session_id = s.session_id AND c.parent_connection_id IS NULL\n"
            + "LEFT JOIN (SELECT q.session_id, q.request_id, q.status, q.command, q.start_time, q.total_elapsed_time, q.blocking_session_id, q.wait_type, q.wait_time,\n"
            + "                  q.wait_resource, q.last_wait_type, q.open_transaction_count, q.percent_complete, q.granted_query_memory, q.dop, q.query_hash, q.database_id,\n"
            + "                  ROW_NUMBER() OVER (PARTITION BY q.session_id ORDER BY CASE WHEN q.blocking_session_id > 0 THEN 0 ELSE 1 END, q.request_id) AS request_rank,\n"
            + "                  COUNT(*) OVER (PARTITION BY q.session_id) AS request_count, MIN(q.request_id) OVER (PARTITION BY q.session_id) AS lowest_request_id,\n"
            + "                  SUM(q.cpu_time) OVER (PARTITION BY q.session_id) AS request_cpu_ms, SUM(q.logical_reads) OVER (PARTITION BY q.session_id) AS request_logical_reads,\n"
            + "                  SUM(q.reads) OVER (PARTITION BY q.session_id) AS request_reads, SUM(q.writes) OVER (PARTITION BY q.session_id) AS request_writes\n"
            + "           FROM sys.dm_exec_requests AS q) AS r ON r.session_id = s.session_id AND r.request_rank = 1\n"
            + "LEFT JOIN (SELECT DISTINCT v.session_id FROM sys.dm_os_waiting_tasks AS w CROSS APPLY (VALUES (w.session_id), (w.blocking_session_id)) AS v(session_id)\n"
            + "           WHERE w.session_id IS NOT NULL AND w.blocking_session_id IS NOT NULL AND w.blocking_session_id <> w.session_id) AS e ON e.session_id = s.session_id\n"
            + "LEFT JOIN sys.databases AS d ON d.database_id = COALESCE(r.database_id, s.database_id)\n"
            + "LEFT JOIN sys.dm_resource_governor_workload_groups AS g ON g.group_id = s.group_id\n"
            + "ORDER BY CASE WHEN e.session_id IS NOT NULL OR r.blocking_session_id <> 0 THEN 0 WHEN r.session_id IS NOT NULL THEN 1 ELSE 2 END, s.session_id;",
            ["session_id", "login_time", "host_process_id", "is_user_process", "login_name", "original_login_name", "host_name", "program_name", "client_interface_name", "status",
                "database_id", "database_name", "cpu_time", "reads", "writes", "logical_reads", "memory_usage", "open_transaction_count", "last_request_start_time", "last_request_end_time",
                "transaction_isolation_level", "workload_group", "client_net_address", "net_transport", "encrypt_option", "auth_scheme", "request_id", "request_count", "lowest_request_id",
                "request_status", "command", "start_time", "total_elapsed_time", "request_cpu_ms", "request_logical_reads", "request_reads", "request_writes", "blocking_session_id", "wait_type",
                "wait_time", "wait_resource", "last_wait_type", "request_open_transactions", "percent_complete", "granted_query_memory", "dop", "query_hash", "request_database_id"],
            [Int("@rowCap")], ["sessions", "blocking", "activeQueries", "focus.cpuRate", "focus.logicalReadsRate"], NoLiterals),
        // Task-level blocking waits; a parallel query's waits on itself are left out.
        new("activity.sessions", "edges",
            "SELECT TOP (@edgeCap) w.session_id, w.exec_context_id, w.blocking_session_id, w.blocking_exec_context_id, w.wait_type, w.wait_duration_ms,\n"
            + $"       LEFT(w.resource_description, {Limit("resourceChars")}) AS resource_description\n"
            + "FROM sys.dm_os_waiting_tasks AS w\n"
            + "WHERE w.session_id IS NOT NULL AND w.blocking_session_id IS NOT NULL AND w.blocking_session_id <> w.session_id\n"
            + "ORDER BY w.wait_duration_ms DESC, w.session_id, w.exec_context_id;",
            ["session_id", "exec_context_id", "blocking_session_id", "blocking_exec_context_id", "wait_type", "wait_duration_ms", "resource_description"],
            [Int("@edgeCap")], ["sessions", "blocking"], NoLiterals),
        // The last batch of lead blockers (blockers no session blocks), at most leadBlockerBatches.
        new("activity.sessions", "leadBatches",
            $"SELECT TOP ({Limit("leadBlockerBatches")}) b.blocking_session_id AS session_id, ib.event_type, LEFT(ib.event_info, {Limit("inputBufferChars")}) AS event_info\n"
            + "FROM (SELECT DISTINCT w.blocking_session_id FROM sys.dm_os_waiting_tasks AS w WHERE w.blocking_session_id > 0 AND w.blocking_session_id <> w.session_id) AS b\n"
            + "CROSS APPLY sys.dm_exec_input_buffer(b.blocking_session_id, NULL) AS ib\n"
            + "WHERE NOT EXISTS (SELECT 1 FROM sys.dm_os_waiting_tasks AS x\n"
            + "                  WHERE x.session_id = b.blocking_session_id AND x.blocking_session_id > 0 AND x.blocking_session_id <> x.session_id)\n"
            + "ORDER BY b.blocking_session_id;",
            ["session_id", "event_type", "event_info"], [], ["blocking"], NoLiterals),
        // Ordered by CPU explicitly (SSMS takes an unordered TOP 10).
        new("activity.sessions", "activeQueries",
            "SELECT TOP (@take) r.session_id, r.request_id, r.start_time, r.status, r.command, r.total_elapsed_time, r.cpu_time, r.logical_reads, r.reads, r.writes,\n"
            + "       r.row_count, r.dop, r.wait_type, r.blocking_session_id, r.percent_complete, r.database_id, d.name AS database_name,\n"
            + "       mg.requested_memory_kb, mg.granted_memory_kb, mg.required_memory_kb, mg.used_memory_kb, mg.max_used_memory_kb, mg.wait_time_ms AS grant_wait_ms,\n"
            + "       r.query_hash, r.plan_handle, r.statement_start_offset, r.statement_end_offset,\n"
            + "       LEFT(SUBSTRING(t.text, r.statement_start_offset / 2 + 1,\n"
            + $"            CASE WHEN r.statement_end_offset = -1 THEN 2147483647 ELSE (r.statement_end_offset - r.statement_start_offset) / 2 + 1 END), {Limit("statementChars")}) AS statement_text\n"
            + "FROM sys.dm_exec_requests AS r\n"
            + "JOIN sys.dm_exec_sessions AS s ON s.session_id = r.session_id AND s.is_user_process = 1\n"
            + "LEFT JOIN sys.databases AS d ON d.database_id = r.database_id\n"
            + "LEFT JOIN sys.dm_exec_query_memory_grants AS mg ON mg.session_id = r.session_id AND mg.request_id = r.request_id\n"
            + "OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) AS t\n"
            + "WHERE r.session_id <> @@SPID\n"
            + "ORDER BY r.cpu_time DESC, r.session_id, r.request_id;",
            ["session_id", "request_id", "start_time", "status", "command", "total_elapsed_time", "cpu_time", "logical_reads", "reads", "writes", "row_count", "dop", "wait_type",
                "blocking_session_id", "percent_complete", "database_id", "database_name", "requested_memory_kb", "granted_memory_kb", "required_memory_kb", "used_memory_kb",
                "max_used_memory_kb", "grant_wait_ms", "query_hash", "plan_handle", "statement_start_offset", "statement_end_offset", "statement_text"],
            [Int("@take")], ["activeQueries"], NoLiterals)
    ];

    private static IReadOnlyList<ActivityStatement> Resources() =>
    [
        Clock("activity.resources"),
        new("activity.resources", "waitStats",
            "SELECT w.wait_type, w.waiting_tasks_count, w.wait_time_ms, w.max_wait_time_ms, w.signal_wait_time_ms\n"
            + "FROM sys.dm_os_wait_stats AS w WHERE w.wait_time_ms > 0 OR w.waiting_tasks_count > 0;",
            ["wait_type", "waiting_tasks_count", "wait_time_ms", "max_wait_time_ms", "signal_wait_time_ms"], [], ["waitCategories", "waitTypes", "wait.*", "wait.signal"], NoLiterals),
        new("activity.resources", "waiters",
            "SELECT w.wait_type, COUNT(*) AS waiters, SUM(w.wait_duration_ms) AS wait_ms, MAX(w.wait_duration_ms) AS max_wait_ms\n"
            + "FROM sys.dm_os_waiting_tasks AS w WHERE w.session_id IS NOT NULL GROUP BY w.wait_type;",
            ["wait_type", "waiters", "wait_ms", "max_wait_ms"], [], ["waitCategories", "waitTypes"], NoLiterals),
        // Names need VIEW ANY DEFINITION (or CREATE or ALTER ANY DATABASE); the LEFT JOINs then degrade to ids.
        new("activity.resources", "files",
            "SELECT TOP (@rowCap) f.database_id, f.file_id, f.num_of_reads, f.num_of_bytes_read, f.io_stall_read_ms, f.num_of_writes, f.num_of_bytes_written,\n"
            + "       f.io_stall_write_ms, f.io_stall_queued_read_ms, f.io_stall_queued_write_ms, f.size_on_disk_bytes,\n"
            + "       mf.type_desc, mf.name AS file_name, mf.physical_name, d.name AS database_name\n"
            + "FROM sys.dm_io_virtual_file_stats(NULL, NULL) AS f\n"
            + "LEFT JOIN sys.master_files AS mf ON mf.database_id = f.database_id AND mf.file_id = f.file_id\n"
            + "LEFT JOIN sys.databases AS d ON d.database_id = f.database_id\n"
            + "ORDER BY f.database_id, f.file_id;",
            ["database_id", "file_id", "num_of_reads", "num_of_bytes_read", "io_stall_read_ms", "num_of_writes", "num_of_bytes_written", "io_stall_write_ms", "io_stall_queued_read_ms",
                "io_stall_queued_write_ms", "size_on_disk_bytes", "type_desc", "file_name", "physical_name", "database_name"],
            [Int("@rowCap")], ["files"], NoLiterals)
    ];

    private static IReadOnlyList<ActivityStatement> Queries(bool spills)
    {
        // Per-statement rows that ran since the last sample; deltas are per statement in C# and summed per query_hash, since
        // grouping in SQL would make a sum depend on which rows a window happens to include.
        var columns = new List<string>
        {
            "query_hash", "query_plan_hash", "sql_handle", "plan_handle", "statement_start_offset", "statement_end_offset", "creation_time", "last_execution_time", "execution_count",
            "total_worker_time", "total_elapsed_time", "total_logical_reads", "total_physical_reads", "total_logical_writes", "total_rows", "total_grant_kb", "max_elapsed_time",
            "last_worker_time", "last_elapsed_time", "last_logical_reads", "last_physical_reads", "last_logical_writes", "last_rows"
        };
        if (spills) columns.AddRange(["total_spills", "last_spills"]);
        var stats = new ActivityStatement("activity.queries", "stats",
            "SELECT TOP (@rowCap) " + string.Join(", ", columns.Select(column => "q." + column)) + "\n"
            + "FROM sys.dm_exec_query_stats AS q\nWHERE q.last_execution_time >= @since\nORDER BY q.last_execution_time DESC\nOPTION (MAXDOP 1);",
            columns, [Int("@rowCap"), new("@since", SqlDbType.DateTime)], ["recentQueries"], NoLiterals);
        // Statement text and database only for shown hashes missing from the text cache; unused slots pass NULL handles.
        var slots = string.Join(",\n       ", Enumerable.Range(0, TextSlots).Select(slot => $"({slot}, @h{slot}, @p{slot}, @s{slot}, @e{slot})"));
        var parameters = Enumerable.Range(0, TextSlots).SelectMany(slot => new[] { Handle($"@h{slot}"), Handle($"@p{slot}"), Int($"@s{slot}"), Int($"@e{slot}") }).ToList();
        var text = new ActivityStatement("activity.queries", "text",
            $"SELECT h.slot, LEFT(SUBSTRING(t.text, h.s / 2 + 1, CASE WHEN h.e = -1 THEN 2147483647 ELSE (h.e - h.s) / 2 + 1 END), {Limit("statementChars")}) AS statement_text,\n"
            + "       pa.dbid, d.name AS database_name\n"
            + "FROM (VALUES " + slots + ") AS h(slot, handle, plan_handle, s, e)\n"
            + "OUTER APPLY sys.dm_exec_sql_text(h.handle) AS t\n"
            + "OUTER APPLY (SELECT CONVERT(int, a.value) AS dbid FROM sys.dm_exec_plan_attributes(h.plan_handle) AS a WHERE a.attribute = N'dbid') AS pa\n"
            + "LEFT JOIN sys.databases AS d ON d.database_id = pa.dbid\n"
            + "WHERE h.handle IS NOT NULL\nOPTION (MAXDOP 1);",
            ["slot", "statement_text", "dbid", "database_name"], parameters, ["recentQueries"], new HashSet<string> { "N'dbid'" });
        return [Clock("activity.queries"), stats, text];
    }

    /// <summary>The probe's statements for a render, in the order they run. Azure SQL Database's variants arrive with AM6.</summary>
    public static IReadOnlyList<ActivityStatement> Statements(string probe, ActivityRender render)
    {
        if (render.Band < ActivityCatalog.Current.MinBand || render.Band > ActivityCatalog.Current.MaxBand) throw new InvalidOperationException("No Activity Monitor SQL for this version band.");
        if (!ActivityCatalog.Current.Available(render.Edition)) throw new InvalidOperationException("No Activity Monitor SQL for this kind of server yet.");
        return probe switch
        {
            "activity.overview" => Overview(),
            "activity.sessions" => Sessions(),
            "activity.resources" => Resources(),
            "activity.queries" => Queries(render.TotalSpills),
            _ => throw new InvalidOperationException("Unknown Activity Monitor probe.")
        };
    }

    /// <summary>The version band the SQL is written for, or null when the monitor cannot serve the server: box editions by
    /// their major version (2016 onward), Managed Instance by the catalog it has (it reports 12).</summary>
    public static int? BandOf(int major, int engineEdition, int catalogBand)
    {
        var catalog = ActivityCatalog.Current;
        var edition = catalog.EditionOf(engineEdition);
        if (edition is null || !catalog.Available(edition)) return null;
        if (edition == "managedInstance") return Math.Clamp(Math.Max(major, catalogBand), catalog.MinBand, catalog.MaxBand);
        return major < catalog.MinBand ? null : Math.Min(major, catalog.MaxBand);
    }

    /// <summary>Every render the lint checks: each band, each available kind of server, and both spill variants.</summary>
    public static IEnumerable<ActivityRender> Renders()
    {
        var catalog = ActivityCatalog.Current;
        foreach (var edition in new[] { "box", "managedInstance", "azureSqlDatabase" }.Where(catalog.Available))
            for (var band = catalog.MinBand; band <= catalog.MaxBand; band++)
                foreach (var spills in new[] { false, true }) yield return new(band, edition, spills);
    }

    // --- Lint -----------------------------------------------------------------------------------------------------------

    /// <summary>Metadata built-ins ignore the isolation level and LOCK_TIMEOUT; the others read or change state no sample may.</summary>
    internal static IReadOnlyList<string> ForbiddenTokens => Forbidden;
    private static readonly string[] Forbidden =
    [
        .. CatalogSql.Builtins, "DB_NAME(", "FILE_NAME(", "OBJECT_ID(", "INDEXPROPERTY(", "SERVERPROPERTY(", "HAS_PERMS_BY_NAME(", "COL_LENGTH(", "sys.sysprocesses", "sys.sysperfinfo",
        "fn_varbintohexstr", "dm_tran_locks", "sp_executesql", "tempdb"
    ];
    /// <summary>Columns and views that appear only from a version band, or with a capability, or on one kind of server.</summary>
    private static readonly (string Token, int Since)[] Gates = [("total_cpu_usage_ms", 13), ("total_scheduler_delay_ms", 13), ("r.dop", 13), ("total_grant_kb", 13), ("dm_exec_input_buffer", 13)];
    private static readonly string[] SpillTokens = ["total_spills", "last_spills"];
    private static readonly string[] AzureOnly = ["dm_db_resource_stats", "sys.database_files", "dm_db_wait_stats"];
    private static readonly string[] NeverOnAzure = ["sys.master_files"];

    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    [GeneratedRegex(@"\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|CREATE|ALTER|DROP|GRANT|DENY|REVOKE|KILL|BACKUP|RESTORE|DBCC|WAITFOR|EXEC|EXECUTE|INTO|USE|SET|BEGIN|COMMIT|ROLLBACK|SAVE|RECONFIGURE|SHUTDOWN|OPENROWSET|OPENQUERY|OPENDATASOURCE)\b", RegexOptions.IgnoreCase)]
    private static partial Regex Keyword();
    [GeneratedRegex(@"\bSELECT\s+(?:DISTINCT\s+)?(?:TOP\s*\([^)]*\)\s*)?(?:\w+\.)?\*", RegexOptions.IgnoreCase)]
    private static partial Regex SelectStar();
    [GeneratedRegex(@"\bTOP\b(?:\s*\(\s*(?<arg>@\w+|\d+)\s*\))?", RegexOptions.IgnoreCase)]
    private static partial Regex Top();
    [GeneratedRegex(@"\bORDER\s+BY\b", RegexOptions.IgnoreCase)]
    private static partial Regex OrderBy();
    // A window's ORDER BY orders no TOP; parentheses nest two deep inside one at most.
    [GeneratedRegex(@"\bOVER\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)", RegexOptions.IgnoreCase)]
    private static partial Regex OverClause();
    [GeneratedRegex(@"(?<!@)@(?!@)\w+")]
    private static partial Regex Variable();

    /// <summary>Problems with one rendered statement; empty when it passes.</summary>
    public static List<string> Lint(ActivityStatement statement, ActivityRender render)
    {
        var text = statement.Text;
        var problems = new List<string>();
        var code = Regex.Replace(LiteralPattern().Replace(text, "''"), @"--[^\n]*|/\*.*?\*/", " ", RegexOptions.Singleline);
        foreach (var token in Forbidden) if (code.Contains(token, StringComparison.OrdinalIgnoreCase)) problems.Add("uses " + token);
        if (code.Contains('#')) problems.Add("names a temporary object");
        foreach (Match keyword in Keyword().Matches(code)) problems.Add("uses " + keyword.Value.ToUpperInvariant());
        if (SelectStar().IsMatch(code)) problems.Add("selects *");
        var tops = Top().Matches(code);
        foreach (Match top in tops)
        {
            var arg = top.Groups["arg"];
            if (!arg.Success) problems.Add("has a TOP without a parenthesised parameter or literal");
            else if (!arg.Value.StartsWith('@') && int.Parse(arg.Value, System.Globalization.CultureInfo.InvariantCulture) > 20) problems.Add("has a TOP literal above 20");
        }
        if (OrderBy().Matches(OverClause().Replace(code, " ")).Count < tops.Count) problems.Add("has a TOP without an ORDER BY");
        if (ActivityCatalog.Current.Probes.TryGetValue(statement.Probe, out var probe))
        {
            if (probe.Maxdop1 && statement.Id != "clock" && !text.EndsWith("OPTION (MAXDOP 1);", StringComparison.Ordinal)) problems.Add("does not end with OPTION (MAXDOP 1)");
        }
        else problems.Add("belongs to no probe");
        if (!text.TrimEnd().EndsWith(';')) problems.Add("does not end with a semicolon");
        foreach (Match literal in LiteralPattern().Matches(text))
            if (!statement.Literals.Contains(literal.Value)) problems.Add("has the literal " + literal.Value);
        var declared = statement.Parameters.Select(parameter => parameter.Name).ToHashSet(StringComparer.Ordinal);
        var used = Variable().Matches(code).Select(match => match.Value).ToHashSet(StringComparer.Ordinal);
        foreach (var name in used.Except(declared)) problems.Add("uses the undeclared " + name);
        foreach (var name in declared.Except(used)) problems.Add("declares the unused " + name);
        foreach (var (token, since) in Gates) if (render.Band < since && code.Contains(token, StringComparison.Ordinal)) problems.Add("uses " + token + " below band " + since);
        if (!render.TotalSpills) foreach (var token in SpillTokens) if (code.Contains(token, StringComparison.Ordinal)) problems.Add("uses " + token + " without the capability");
        var azure = render.Edition == "azureSqlDatabase";
        foreach (var token in AzureOnly) if (!azure && code.Contains(token, StringComparison.OrdinalIgnoreCase)) problems.Add("uses " + token + " outside Azure SQL Database");
        foreach (var token in NeverOnAzure) if (azure && code.Contains(token, StringComparison.OrdinalIgnoreCase)) problems.Add("uses " + token + " on Azure SQL Database");
        if (statement.Columns.Count == 0 || statement.Columns.Distinct(StringComparer.OrdinalIgnoreCase).Count() != statement.Columns.Count) problems.Add("has no or duplicate column names");
        return problems;
    }

    /// <summary>Every statement of every probe and render, with its problems.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> Lint()
    {
        foreach (var render in Renders())
            foreach (var probe in ActivityCatalog.Current.Probes.Keys)
                foreach (var statement in Statements(probe, render))
                    yield return ($"{probe} {statement.Id} ({render.Edition} band {render.Band}{(render.TotalSpills ? ", spills" : "")})", Lint(statement, render));
    }
}
