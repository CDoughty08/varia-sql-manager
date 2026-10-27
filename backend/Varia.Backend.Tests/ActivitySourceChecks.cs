using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Activity;
using Varia.Backend.Explorer;
using Varia.Backend.Live;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the Activity Monitor's live source: the capability probe and the statement without server state,
/// the overview's raw series from statement results and its I/O totals, the sessions probe's rows (Processes, the blocking
/// chains, Active Expensive Queries) with their rates, statuses, blocked-by and head-blocker marks, Varia's own sessions and
/// the ledger of their ids, the filters and focus series, the args the live layer checks as zod does and applies, and the
/// reader's permission and refused-statement rules. Results are built by hand, as the statements return them.</summary>
internal static class ActivitySourceChecks
{
    private static readonly ActivityCatalog Catalog = ActivityCatalog.Current;
    private static readonly DateTime Login = new(2026, 10, 22, 9, 0, 0, DateTimeKind.Unspecified);
    /// <summary>The workstation this backend's connections send (Session's host_name).</summary>
    private const string Host = "WEB01";

    /// <summary>Varia's sessions as this backend (process 4242 on <see cref="Host"/>) knows them: its connections' Application
    /// Names and the session ids its pooled connections were given.</summary>
    private static VariaSessions Own(string[] applications, params int[] own) => new(Catalog, 4242, [.. applications.Select(name => new VariaClient(name, Host))], own.ToHashSet());

    public static void Run(Action<bool, string> check)
    {
        Statements(check);
        Overview(check);
        IoTotals(check);
        Sessions(check);
        Mars(check);
        SampleTimes(check);
        Blocking(check);
        Varia(check);
        Filters(check);
        Args(check);
        Errors(check);
        Reader(check);
        Ledger(check);
    }

    /// <summary>A statement's result with these rows; columns a row leaves out are NULL.</summary>
    private static ActivityResult Result(ActivityStatement statement, params Dictionary<string, object?>[] rows) =>
        new(statement.Columns, [.. rows.Select(row => statement.Columns.Select(column => row.GetValueOrDefault(column)).ToArray())]);

    private static ActivityStatement Statement(string probe, string id, bool serverState = true) =>
        ActivitySql.Statements(probe, new(17, "box", ServerState: serverState)).Single(statement => statement.Id == id);

    private static void Statements(Action<bool, string> check)
    {
        var limited = ActivitySql.Statements("activity.sessions", new(17, "box", ServerState: false));
        var full = Statement("activity.sessions", "sessions");
        check(limited is [{ Id: "sessions" } only] && only.Columns.SequenceEqual(full.Columns) && only.Feeds.SequenceEqual(["sessions", "focus.cpuRate", "focus.logicalReadsRate"])
            && !only.Text.Contains("dm_exec_connections", StringComparison.Ordinal) && !only.Text.Contains("dm_os_waiting_tasks", StringComparison.Ordinal)
            && !only.Text.Contains("dm_resource_governor", StringComparison.Ordinal) && ActivitySql.Lint(only, new(17, "box", ServerState: false)).Count == 0,
            "without server state the sessions probe reads one statement with the same columns, and none of the DMVs SQL Server refuses such a login (connections, waiting tasks, workload groups)");
        var capabilities = ActivitySql.Capabilities;
        var mutated = capabilities with { Text = capabilities.Text.Replace("@@SPID AS spid", "@@SPID AS spid, DB_NAME() AS db", StringComparison.Ordinal), Columns = [.. capabilities.Columns, "db"] };
        var smuggled = full with { Text = full.Text.Replace("d.name AS database_name", "HAS_PERMS_BY_NAME(NULL, NULL, N'X') AS database_name", StringComparison.Ordinal) };
        check(ActivitySql.Lint(capabilities, new(13, "box")).Count == 0 && capabilities.Columns.SequenceEqual(["spid", "server_state", "alter_any_connection", "view_any_definition", "spills"])
            && capabilities.Parameters is [{ Name: "@permission" }] && ActivitySql.Lint(mutated, new(13, "box")).Contains("uses DB_NAME(")
            && ActivitySql.Lint(smuggled, new(17, "box")).Contains("uses HAS_PERMS_BY_NAME("),
            "the capability probe alone may ask what the login may do (HAS_PERMS_BY_NAME, COL_LENGTH), the permission name a parameter; any other statement, or another built-in in it, is refused");
    }

    private static void Overview(Action<bool, string> check)
    {
        var series = LiveCatalog.Current.Probes[ActivityReader.OverviewProbe].Series.Select(item => item.Id).ToList();
        double? At(LiveRawSample raw, string id, bool baseValue = false) => (baseValue ? raw.Bases : raw.Values)[series.IndexOf(id)];
        var results = new Dictionary<string, ActivityResult>
        {
            ["clock"] = Result(Statement("activity.overview", "clock"), new Dictionary<string, object?> { ["ms_ticks"] = 5_000L, ["sqlserver_start_time_ms_ticks"] = 100L }),
            ["cpu"] = Result(Statement("activity.overview", "cpu"), new Dictionary<string, object?> { ["cpu_ms"] = 900L, ["schedulers"] = 4, ["runnable_tasks"] = 6, ["work_queue"] = 1L, ["scheduler_delay_ms"] = 12L }),
            ["counters"] = Result(Statement("activity.overview", "counters"),
                new Dictionary<string, object?> { ["counter_name"] = "Batch Requests/sec", ["cntr_value"] = 700L }, new Dictionary<string, object?> { ["counter_name"] = "Page life expectancy", ["cntr_value"] = 5_412L },
                new Dictionary<string, object?> { ["counter_name"] = "Lock Waits/sec", ["cntr_value"] = 3L }, new Dictionary<string, object?> { ["counter_name"] = "Lock Waits/sec", ["cntr_value"] = 4L }, new Dictionary<string, object?> { ["counter_name"] = "Something else", ["cntr_value"] = 9L }),
            ["io"] = Result(Statement("activity.overview", "io"), new Dictionary<string, object?> { ["database_id"] = 1, ["bytes_read"] = 1_000L, ["bytes_written"] = 500L, ["reads"] = 10L, ["writes"] = 5L, ["read_stall_ms"] = 40L, ["write_stall_ms"] = 15L }),
            ["waits"] = Result(Statement("activity.overview", "waits"),
                new Dictionary<string, object?> { ["wait_type"] = "LCK_M_X", ["wait_time_ms"] = 100L, ["signal_wait_time_ms"] = 10L }, new Dictionary<string, object?> { ["wait_type"] = "LAZYWRITER_SLEEP", ["wait_time_ms"] = 9_000L, ["signal_wait_time_ms"] = 0L },
                new Dictionary<string, object?> { ["wait_type"] = "NEW_WAIT_2030", ["wait_time_ms"] = 50L, ["signal_wait_time_ms"] = 5L }, new Dictionary<string, object?> { ["wait_type"] = "SOS_WORK_DISPATCHER", ["wait_time_ms"] = 7_000L, ["signal_wait_time_ms"] = 0L }),
            ["blocked"] = Result(Statement("activity.overview", "blocked"), new Dictionary<string, object?> { ["blocked_sessions"] = 0, ["longest_wait_ms"] = null }),
            ["requests"] = Result(Statement("activity.overview", "requests"), new Dictionary<string, object?> { ["user_sessions"] = 12, ["active_requests"] = 3 })
        };
        var raw = ActivityOverview.Raw(series, results, Catalog, new());
        check(raw is { MsTicks: 5_000, StartTicks: 100 } && At(raw, "cpuPercent") == 900 && At(raw, "cpuPercent", true) == 4 && At(raw, "runnablePerScheduler") == 1.5 && At(raw, "workQueue") == 1
            && At(raw, "schedulerDelay") == 12 && At(raw, "batchRequests") == 700 && At(raw, "pageLifeExpectancy") == 5_412 && At(raw, "lockWaits") == 7 && At(raw, "ioMegabytes") == 1_500
            && At(raw, "readLatency") == 40 && At(raw, "readLatency", true) == 10 && At(raw, "writeLatency", true) == 5 && At(raw, "blockedSessions") == 0 && At(raw, "longestBlock") == 0
            && At(raw, "userSessions") == 12 && At(raw, "activeRequests") == 3,
            "the overview's raw values come from its statements: CPU with its scheduler count, runnable tasks per scheduler, counters by name (summed), I/O with its read and write counts, no blocking as 0 ms");
        check(At(raw, "waitingTasks") == 90 + 45, "Waiting Tasks sums wait less signal wait of every type that counts as waiting: Unknown types count, Idle and Varia's benign waits never do");
        results.Remove("counters");
        results.Remove("clock");
        var partial = ActivityOverview.Raw(series, results, Catalog, new());
        check(partial is { MsTicks: null, StartTicks: null } && At(partial, "batchRequests") is null && At(partial, "pageLifeExpectancy") is null && At(partial, "cpuPercent") == 900,
            "a statement that did not run (no permission) leaves only its own series empty, and without the clock rates fall back to the backend's");
        // Without server state SQL Server shows the login only its own session, which the statement leaves out: no rows to sum.
        results["requests"] = Result(Statement("activity.overview", "requests"), new Dictionary<string, object?> { ["user_sessions"] = null, ["active_requests"] = null });
        var unknown = ActivityOverview.Raw(series, results, Catalog, new());
        check(At(unknown, "userSessions") is null && At(unknown, "activeRequests") is null, "sessions and requests the statement had no rows to count are unknown, never 0");
    }

    private static void IoTotals(Action<bool, string> check)
    {
        var spec = LiveCatalog.Current.Probes[ActivityReader.OverviewProbe];
        var series = spec.Series.Select(item => item.Id).ToList();
        var statement = Statement("activity.overview", "io");
        Dictionary<string, object?> Database(int id, long read, long written, long reads, long writes, long readStall, long writeStall) => new()
        {
            ["database_id"] = id, ["bytes_read"] = read, ["bytes_written"] = written, ["reads"] = reads, ["writes"] = writes, ["read_stall_ms"] = readStall, ["write_stall_ms"] = writeStall
        };
        var totals = new ActivityIoTotals();
        var deltas = new LiveDeltas([.. spec.Series.Select(item => item.Counter)]);
        LiveDeltaResult Sample(long ticks, string? gap, params Dictionary<string, object?>[] databases) => deltas.Apply(ActivityOverview.Raw(series, new Dictionary<string, ActivityResult>
        {
            ["clock"] = Result(Statement("activity.overview", "clock"), new Dictionary<string, object?> { ["ms_ticks"] = ticks, ["sqlserver_start_time_ms_ticks"] = 1L }),
            ["io"] = Result(statement, databases)
        }, Catalog, totals), null, 1_000, gap);
        double? At(LiveDeltaResult result, string id) => result.Values[series.IndexOf(id)];
        Sample(10_000, "baseline", Database(1, 1_000, 500, 10, 5, 40, 15), Database(5, 38_817_792, 1_000_000, 900, 300, 9_000, 2_000));
        // Database 5 is dropped (its counts leave the view) and database 7 appears; database 1 read 2 MB in 4 reads, 20 ms of stall.
        var next = Sample(11_000, null, Database(1, 2_001_000, 500, 14, 5, 60, 15), Database(7, 50_000, 0, 3, 0, 9, 0));
        // Database 7 reads 1 MB in 2 reads, and database 1's counts go down (its files reopened): it starts again from there.
        var after = Sample(12_000, null, Database(1, 100, 0, 1, 0, 1, 0), Database(7, 1_050_000, 0, 5, 0, 19, 0));
        check(next.Gap is null && At(next, "ioMegabytes") == 2_000_000 && At(next, "readLatency") == 5 && At(next, "writeLatency") is null
            && after.Gap is null && At(after, "ioMegabytes") == 1_000_000 && At(after, "readLatency") == 5,
            "the overview's I/O moves only by databases read in both samples: one dropped takes its counts with it (no reset gap, no less I/O than ran), and one that appears or whose counts went down starts from its reading: "
            + At(next, "ioMegabytes") + " " + next.Gap + ", " + At(after, "ioMegabytes") + " " + after.Gap);
    }

    private static Dictionary<string, object?> Session(int id, string program = "App", int? pid = 4242, bool user = true, string status = "sleeping", int openTransactions = 0, long cpu = 0, long reads = 0,
        DateTime? login = null) => new()
    {
        ["session_id"] = id, ["login_time"] = login ?? Login, ["host_process_id"] = pid, ["is_user_process"] = user, ["login_name"] = "app_user", ["original_login_name"] = "app_user",
        ["host_name"] = Host, ["program_name"] = program, ["client_interface_name"] = ".Net SqlClient Data Provider", ["status"] = status, ["database_id"] = 5, ["database_name"] = "Sales",
        ["cpu_time"] = cpu, ["reads"] = 64L, ["writes"] = 64L, ["logical_reads"] = reads, ["memory_usage"] = 3, ["open_transaction_count"] = openTransactions,
        ["last_request_start_time"] = Login.AddMinutes(1), ["last_request_end_time"] = Login.AddMinutes(1), ["transaction_isolation_level"] = (short)2, ["workload_group"] = "default",
        ["client_net_address"] = "10.0.0.5", ["net_transport"] = "TCP", ["encrypt_option"] = "TRUE", ["auth_scheme"] = "NTLM"
    };

    private static Dictionary<string, object?> WithRequest(Dictionary<string, object?> session, string status = "running", string? command = "SELECT", long cpu = 0, long reads = 0, int count = 1,
        int blocker = 0, string? waitType = null, long waitTime = 0, float percent = 0, short dop = 1)
    {
        var row = new Dictionary<string, object?>(session)
        {
            ["request_id"] = 0, ["request_rank"] = 1L, ["request_count"] = count, ["lowest_request_id"] = 0, ["request_status"] = status, ["command"] = command, ["start_time"] = Login.AddMinutes(2),
            ["total_elapsed_time"] = 1_500, ["request_cpu_time"] = (int)cpu, ["request_logical_reads"] = reads, ["blocking_session_id"] = (short)blocker,
            ["wait_type"] = waitType, ["wait_time"] = (int)waitTime, ["wait_resource"] = waitType is null ? "" : "KEY: 5:72057594043236352 (8194443284a0)", ["percent_complete"] = percent,
            ["granted_query_memory"] = 0, ["dop"] = (int)dop, ["query_hash"] = new byte[] { 0x0A, 0xB1, 0, 0, 0, 0, 0, 0xFF }, ["request_database_id"] = 5
        };
        return row;
    }

    private static Dictionary<string, ActivityResult> SessionResults(IEnumerable<Dictionary<string, object?>> sessions, IEnumerable<Dictionary<string, object?>>? edges = null,
        IEnumerable<Dictionary<string, object?>>? leads = null, IEnumerable<Dictionary<string, object?>>? active = null, long ticks = 10_000) => new()
    {
        ["clock"] = Result(Statement("activity.sessions", "clock"), new Dictionary<string, object?> { ["ms_ticks"] = ticks, ["sqlserver_start_time_ms_ticks"] = 1L }),
        ["sessions"] = Result(Statement("activity.sessions", "sessions"), [.. sessions]),
        ["edges"] = Result(Statement("activity.sessions", "edges"), [.. edges ?? []]),
        ["leadBatches"] = Result(Statement("activity.sessions", "leadBatches"), [.. leads ?? []]),
        ["activeQueries"] = Result(Statement("activity.sessions", "activeQueries"), [.. active ?? []])
    };

    private static string? Cell(ActivityRowWriter writer, LiveRow row, string column) => writer.Reader(row)(column);

    private static void Sessions(Action<bool, string> check)
    {
        var builder = new ActivitySessionRows(Catalog);
        var varia = Own(["Varia SQL Manager"]);
        var first = SessionResults([
            WithRequest(Session(51, cpu: 1_000, reads: 100), cpu: 200, reads: 50, count: 2),
            Session(52, status: "sleeping", openTransactions: 1),
            WithRequest(Session(53), command: "KILLED/ROLLBACK", status: "suspended", percent: 41.6f),
            Session(54, cpu: 70)
        ]);
        var sample = builder.Build(first, 10_000, varia, 99, focusSession: 51);
        var writer = builder.SessionsWriter;
        LiveRow Row(ActivitySessionsSample built, int id) => built.Sessions.Single(row => Cell(writer, row, "sessionId") == id.ToString());
        var r51 = Row(sample, 51);
        check(Cell(writer, r51, "status") == "running" && Cell(writer, Row(sample, 52), "status") == "sleeping · 1 open tran" && Cell(writer, Row(sample, 53), "status") == "rolling back 42 %"
            && Cell(writer, Row(sample, 54), "status") == "sleeping" && Cell(writer, r51, "requestId") == "0 +1" && Cell(writer, Row(sample, 54), "requestId") is null,
            "Processes' status shows rollback progress and an idle session's open transactions, and Request ID folds a MARS session's requests (\"0 +1\")");
        check(Cell(writer, r51, "isolationLevel") == "Read Committed" && Cell(writer, r51, "encrypted") == "1" && Cell(writer, r51, "queryHash") == "0x0AB10000000000FF"
            && Cell(writer, r51, "physicalIoMb") == "1.00" && Cell(writer, r51, "memoryKb") == "24" && Cell(writer, r51, "elapsedSeconds") == "1.500" && Cell(writer, r51, "totalCpuMs") == "1000"
            && Cell(writer, r51, "loginTime") == "2026-10-22 09:00:00.000" && Cell(writer, Row(sample, 52), "elapsedSeconds") is null,
            "Processes' cells read as the grid shows them: isolation by name, encryption as a flag, the query hash in hex, pages as MB and KB, elapsed seconds only with a request");
        check(Cell(writer, r51, "cpuRate") is null && sample.FocusCpuRate is null && sample.Sessions.Count == 4 && sample.SessionsMore == 0,
            "a first sample has no per-session rates");
        // One second later: 51 used 500 ms more (session plus request CPU), 54 is a new session under a reused id.
        var second = SessionResults([
            WithRequest(Session(51, cpu: 1_300, reads: 100), cpu: 400, reads: 250, count: 2),
            Session(54, cpu: 10, login: Login.AddHours(1))
        ], ticks: 11_000);
        var next = builder.Build(second, 11_000, varia, 99, focusSession: 51);
        check(Cell(writer, Row(next, 51), "cpuRate") == "500.0" && Cell(writer, Row(next, 51), "logicalReadsRate") == "200.0" && next.FocusCpuRate == 500 && next.FocusReadsRate == 200
            && Cell(writer, Row(next, 54), "cpuRate") is null,
            "per-session rates add the session's CPU and its running requests', follow the Details flyout's session, and never span a reused session id (another login time)");
        // The sequence a 1.2 s CPU loop gave on SQL Server 2025, two batches then idle: the session takes in less than its
        // requests reported (813 against 1,096 ms), so session plus request would fall at each batch end.
        var cpu = new SessionRates(10);
        var clock = 0L;
        DateTime A = Login, B = Login.AddSeconds(2);
        double?[] Rate(double session, double? request, DateTime? running) =>
            cpu.Apply(70, Login, new(session, 0, running is { } start ? [new RequestCounters(0, start, request ?? 0, 0)] : []), clock += 1_000);
        var observed = new[] { Rate(0, 3, A), Rate(0, 1_096, A), Rate(813, 5, B), Rate(813, 1_096, B), Rate(1_813, null, null), Rate(1_813, null, null) }.Select(rate => rate[0]).ToList();
        var once = new SessionRates(10);
        once.Apply(71, Login, new(0, 0, [new RequestCounters(0, A, 500, 40)]), 1_000);
        var ended = once.Apply(71, Login, new(800, 90, []), 2_000);
        check(observed.SequenceEqual([null, 1_093, 5, 1_091, 0, 0]) && ended is [300, 50],
            "a session's CPU rate counts a running request by its own change, a new request whole, and an ended one only beyond what it had counted: never negative where session plus request falls, never twice");
        var many = SessionResults(Enumerable.Range(1, (int)Catalog.Limit("sessions") + 1).Select(id => Session(id)));
        var capped = new ActivitySessionRows(Catalog).Build(many, 0, varia, 99, 0);
        check(capped.Sessions.Count == Catalog.Limit("sessions") && capped.SessionsMore == 1, "Processes keeps the catalogue's 10,000 sessions and counts the one read past them as cut");
        // A full row: every column has a value, so no column of the live table is left unwritten.
        var everything = WithRequest(Session(60, cpu: 10, reads: 10), cpu: 1, reads: 1, blocker: 61, waitType: "LCK_M_S", waitTime: 900, percent: 5);
        var filled = new ActivitySessionRows(Catalog);
        filled.Build(SessionResults([everything, Session(61)]), 10_000, Own(["App"]), 99, 0);
        var row = filled.Build(SessionResults([everything, Session(61)], ticks: 11_000), 11_000, Own(["App"]), 99, 0).Sessions[0];
        var empty = Catalog.Table("sessions").Columns.Where(column => Cell(writer, row, column.Id) is null).Select(column => column.Id).ToList();
        check(empty.Count == 0, "a session with a request, a blocker and a Varia label fills every Processes column: " + string.Join(", ", empty));
    }

    /// <summary>A MARS session's requests: one row each, ranked as the statement ranks them.</summary>
    private static Dictionary<string, object?> Mars(Dictionary<string, object?> session, int request, long rank, int count, long cpu, DateTime start, int blocker = 0) =>
        new(WithRequest(session, cpu: cpu, count: count, blocker: blocker)) { ["request_id"] = request, ["request_rank"] = rank, ["start_time"] = start };

    private static void Mars(Action<bool, string> check)
    {
        var builder = new ActivitySessionRows(Catalog);
        DateTime first = Login.AddMinutes(2), second = Login.AddMinutes(3);
        var clock = 9_000L;
        string? Rate(int session, params Dictionary<string, object?>[] rows)
        {
            var built = builder.Build(SessionResults(rows), clock += 1_000, Own([]), 99, 0);
            return Cell(builder.SessionsWriter, built.Sessions.Single(row => Cell(builder.SessionsWriter, row, "sessionId") == session.ToString()), "cpuRate");
        }
        // Session 60's request 0 has used 30 s; request 1 starts blocked, so it ranks first; then request 0 ends, and the
        // session takes in less than it reported.
        var blocked = new[]
        {
            Rate(60, Mars(Session(60), 0, 1, 1, 30_000, first)),
            Rate(60, Mars(Session(60), 0, 1, 1, 30_500, first)),
            Rate(60, Mars(Session(60), 1, 1, 2, 0, second, blocker: 61), Mars(Session(60), 0, 2, 2, 31_000, first)),
            Rate(60, Mars(Session(60, cpu: 20_000), 1, 1, 1, 300, second))
        };
        // Session 70's requests both run; the lowest ends while the other goes on.
        var switched = new[]
        {
            Rate(70, Mars(Session(70), 0, 1, 2, 5_000, first), Mars(Session(70), 1, 2, 2, 2_000, second)),
            Rate(70, Mars(Session(70), 0, 1, 2, 5_100, first), Mars(Session(70), 1, 2, 2, 2_050, second)),
            Rate(70, Mars(Session(70, cpu: 4_000), 1, 1, 1, 2_500, second))
        };
        check(blocked.SequenceEqual([null, "500.0", "500.0", "300.0"]) && switched.SequenceEqual([null, "150.0", "450.0"]),
            "a MARS session's CPU rate follows each request: a blocked request ranked first or the lowest one ending neither adds a request's whole CPU again nor hides the others' ("
            + string.Join(",", blocked) + " | " + string.Join(",", switched) + ")");
        var many = new ActivitySessionRows(Catalog).Build(SessionResults([Mars(Session(1), 0, 1, 2, 0, first), Mars(Session(1), 1, 2, 2, 0, second), .. Enumerable.Range(2, (int)Catalog.Limit("sessions")).Select(id => Session(id))]),
            0, Own([]), 99, 0);
        check(many.Sessions.Count == Catalog.Limit("sessions") && many.SessionsMore == 1 && Cell(builder.SessionsWriter, many.Sessions[0], "requestId") == "0 +1",
            "Processes counts sessions, not request rows: a MARS session is one row, and the cap cuts the one session read past it");
    }

    /// <summary>A live host the sample clock never calls.</summary>
    private sealed class NoHost : ILiveHost
    {
        public bool TestHooks => false;
        public bool IsConnected(string connectionId) => false;
        public string? ServerOf(string connectionId) => null;
        public Varia.Backend.Results.ResultStore Store => throw new NotSupportedException();
        public Varia.Backend.Explorer.ServerProfile? Profile(string connectionId) => null;
        public Microsoft.Data.SqlClient.SqlConnection PoolConnection(string connectionId, string? database, string suffix) => throw new NotSupportedException();
        public Task OpenAsync(Microsoft.Data.SqlClient.SqlConnection connection, CancellationToken token) => throw new NotSupportedException();
    }

    private static void SampleTimes(Action<bool, string> check)
    {
        // A sample whose sessions statement failed after the clock read: the next rate spans both intervals.
        var builder = new ActivitySessionRows(Catalog);
        string? Rate(ActivitySessionsSample built) => Cell(builder.SessionsWriter, built.Sessions.Single(), "cpuRate");
        builder.Build(SessionResults([WithRequest(Session(51), cpu: 1_000)]), 10_000, Own([]), 99, 0);
        var steady = Rate(builder.Build(SessionResults([WithRequest(Session(51), cpu: 2_000)], ticks: 12_000), 12_000, Own([]), 99, 0));
        var clockOnly = new Dictionary<string, ActivityResult> { ["clock"] = SessionResults([], ticks: 14_000)["clock"] };
        var missed = builder.Build(clockOnly, 14_000, Own([]), 99, 0);
        var after = Rate(builder.Build(SessionResults([WithRequest(Session(51), cpu: 4_000)], ticks: 16_000), 16_000, Own([]), 99, 0));
        check(steady == "500.0" && missed.Sessions.Count == 0 && after == "500.0",
            "a session missing from a sample (its statement failed after the clock read) gets a rate over its own four seconds when it returns, never two intervals over one: " + steady + ", " + after);

        // The sessions probe's clock: the server's between samples that read it, else the schedule's; a restart starts again.
        var reader = new ActivityReader(new NoHost(), "c");
        var spec = LiveCatalog.Current.Probes[ActivityReader.SessionsProbe];
        long Time(string? gap, long takenAt, long? ticks, long start = 1)
        {
            var results = ticks is { } now ? new Dictionary<string, ActivityResult> { ["clock"] = Result(Statement("activity.sessions", "clock"), new Dictionary<string, object?> { ["ms_ticks"] = now, ["sqlserver_start_time_ms_ticks"] = start }) } : [];
            return reader.SampleTime(spec.Id, results, new LiveDue(new LiveProbeState(spec, 2_000), gap, null, null, null, new Dictionary<int, LiveTrackArgs>(), TakenAt: takenAt));
        }
        var times = new[] { Time("baseline", 100_000, 10_000), Time(null, 102_050, 12_000), Time(null, 104_100, null), Time(null, 106_000, 16_000), Time(null, 108_000, 18_000),
            Time(null, 110_000, 20_000, start: 2), Time("resumed", 200_000, 99_000, start: 2), Time(null, 202_000, 101_000, start: 2) };
        check(times.SequenceEqual([0, 2_000, 4_050, 5_950, 7_950, 7_950, 7_950, 9_950]),
            "the sessions probe's sample clock moves by the server's ms_ticks between samples that read it and by the schedule's otherwise, and stands still at a restart or a resume: " + string.Join(",", times));
    }

    private static void Blocking(Action<bool, string> check)
    {
        var builder = new ActivitySessionRows(Catalog);
        var varia = Own([]);
        Dictionary<string, object?> Edge(int waiter, int blocker, long ms, string type = "LCK_M_X", short context = 0) => new()
        {
            ["session_id"] = waiter, ["exec_context_id"] = (int)context, ["blocking_session_id"] = blocker, ["blocking_exec_context_id"] = 0, ["wait_type"] = type, ["wait_duration_ms"] = ms,
            ["resource_description"] = "keylock hobtid=72057594043236352"
        };
        var results = SessionResults(
            [Session(60, openTransactions: 1), WithRequest(Session(69), status: "suspended", blocker: 60, waitType: "LCK_M_X", waitTime: 5_000),
                WithRequest(Session(70), status: "suspended", waitType: "CXPACKET", waitTime: 10, dop: 4), WithRequest(Session(71), status: "suspended", blocker: -5, waitType: "PAGELATCH_SH")],
            [Edge(69, 60, 5_000), Edge(70, 69, 4_000), Edge(70, 69, 3_000, context: 2), Edge(70, 70, 9_000, "CXPACKET", 1)],
            [new Dictionary<string, object?> { ["session_id"] = 60, ["event_type"] = "Language Event", ["event_info"] = "BEGIN TRAN;\n\tUPDATE dbo.t\n   SET x = 1 " + new string('y', 400) }],
            [new Dictionary<string, object?> { ["session_id"] = 69, ["request_id"] = 0, ["start_time"] = Login, ["status"] = "suspended", ["cpu_time"] = 5, ["statement_text"] = "SELECT *\nFROM   dbo.t", ["blocking_session_id"] = (short)60,
                ["query_hash"] = new byte[] { 1, 2 } }]);
        var sample = builder.Build(results, 0, varia, 99, 0);
        var sessions = builder.SessionsWriter;
        string? P(int id, string column) => Cell(sessions, sample.Sessions.Single(row => Cell(sessions, row, "sessionId") == id.ToString()), column);
        check(P(60, "headBlocker") == "1" && P(60, "blocking") == "2" && P(60, "blockedBy") is null && P(69, "blockedBy") == "60" && P(69, "headBlocker") == "0" && P(70, "blockedBy") == "69"
            && P(71, "blockedBy") == "-5" && P(71, "blocking") == "0" && sample.BlockedSessions == 2,
            "Processes marks the idle lead blocker (Head Blocker, two sessions downstream), each waiter's blocker once, and keeps a latch owner's negative id without counting it blocked");
        check(P(70, "waitType") == "LCK_M_X" && P(70, "waitTimeMs") == "4000" && P(69, "waitResource")!.StartsWith("KEY: 5:", StringComparison.Ordinal),
            "a parallel request shows the longest blocking wait of its tasks, not its own CXPACKET");
        var chain = builder.BlockingWriter;
        var rows = sample.Blocking;
        check(rows.Select(row => Cell(chain, row, "session")).SequenceEqual(["60", "└─ 69", "  └─ 70"]) && Cell(chain, rows[0], "depth") == "0" && Cell(chain, rows[0], "blockedSessions") == "2"
            && Cell(chain, rows[0], "waitType") is null && Cell(chain, rows[1], "waitType") == "LCK_M_X" && Cell(chain, rows[1], "waitTimeMs") == "5000" && Cell(chain, rows[0], "status") == "sleeping · 1 open tran"
            && Cell(chain, rows[0], "lastBatch") is { Length: 200 } batch && batch.StartsWith("BEGIN TRAN; UPDATE dbo.t SET x = 1 yyy", StringComparison.Ordinal) && Cell(chain, rows[1], "lastBatch") is null
            && Cell(chain, rows[0], "cycle") == "0" && Cell(chain, rows[0], "openTransactions") == "1",
            "the Blocking table is the chain as rows with text guides, each session's wait on its parent, and the lead blocker's last batch on one line, 200 characters");
        var active = builder.ActiveWriter;
        check(sample.Active is [{ } query] && Cell(active, query, "query") == "SELECT * FROM dbo.t" && Cell(active, query, "blockedBy") == "60" && Cell(active, query, "queryHash") == "0x0102"
            && Cell(active, query, "percentComplete") is null,
            "Active Expensive Queries show the statement on one line and the session the request waits on");
    }

    private static void Varia(Action<bool, string> check)
    {
        // Sessions 1, 3, 5 and 7 are ones this backend's pooled connections were given.
        var varia = Own(["Varia SQL Manager", "Reports - Scripting"], 1, 3, 5, 7);
        (string?, bool) C(int id, int? pid, string? program, string? host = Host) => varia.Classify(id, pid, host, program, 99);
        check(C(1, 4242, "Varia SQL Manager - Object Explorer") == ("Varia Object Explorer", true) && C(2, 4242, "Varia SQL Manager") == ("Query tab", false)
            && C(3, 4242, "Varia SQL Manager - Activity Monitor") == ("Varia Activity Monitor", true) && C(4, 7, "Varia SQL Manager - Object Explorer") == (null, false)
            && C(5, 4242, "Reports - Scripting") == ("Query tab", false)
            && Own(["Reports - Scripting", "Reports"], 5).Classify(5, 4242, Host, "Reports - Scripting", 99) == ("Varia Scripting", true) && C(6, 4242, "SSMS") == (null, false)
            && varia.Classify(99, null, null, null, 99) == ("Varia Activity Monitor", true) && C(7, 4242, "Varia SQL Manager - Integration Services Actions") == ("Varia Integration Services Actions", true)
            && C(2, 4242, "Varia SQL Manager", "web01") == ("Query tab", false),
            "Varia's own sessions are this process's from this machine under a connection's program name: its pools by suffix, its query tabs by the plain name (a pool wins when names collide), and the monitor's own session always");
        // What a client claims at login (process id, machine, program name) is not enough for a pool, which the default filter hides.
        check(C(1, 4242, "Varia SQL Manager - Object Explorer", "OTHER-PC") == (null, false) && C(2, 4242, "Varia SQL Manager", "OTHER-PC") == (null, false)
            && C(8, 4242, "Varia SQL Manager - Object Explorer") == (null, false) && C(8, 4242, "Varia SQL Manager - Scripting", null) == (null, false),
            "a session from another machine under this backend's process id and program name is not Varia's, nor is a pool session under an id none of Varia's connections were given");
        // SQL Server keeps 128 characters of a program name, as SqlService cuts the pool's.
        var longName = new string('V', 120);
        check(Own([longName], 9).Classify(9, 4242, Host, (longName + " - Object Explorer")[..128], 99) == ("Varia Object Explorer", true),
            "a 120-character Application Name's pool session, its program name cut to 128 characters, is still Varia's Object Explorer");
        var builder = new ActivitySessionRows(Catalog);
        var results = SessionResults([Session(99, "Varia SQL Manager - Activity Monitor"), Session(100, "Varia SQL Manager"), Session(101, "Varia SQL Manager - Object Explorer"), Session(1, "", null, user: false)]);
        var sample = builder.Build(results, 0, Own(["Varia SQL Manager"], 101), 99, 0);
        var defaults = ActivityFilter.Compile(Catalog, new("sessions"));
        string Shown(ActivitySessionsSample built, ActivityFilter filter) => string.Join(",", built.Sessions.Where(row => filter.Matches(builder.SessionsWriter.Reader(row), built.Facts[row]))
            .Select(row => Cell(builder.SessionsWriter, row, "sessionId")));
        check(Shown(sample, defaults) == "100" && Shown(sample, ActivityFilter.Compile(Catalog, new("sessions", ShowSystem: true, ShowVaria: true))) == "99,100,101,1"
            && Cell(builder.SessionsWriter, sample.Sessions[1], "varia") == "Query tab" && Cell(builder.SessionsWriter, sample.Sessions[0], "varia") == "Varia Activity Monitor",
            "by default Processes hides SQL Server's sessions and Varia's pools, the monitor's own included, and always shows this window's query tabs, labelled");
        var limited = new ActivitySessionRows(Catalog).Build(SessionResults([Session(99, "Varia SQL Manager - Activity Monitor")]), 0, Own(["Varia SQL Manager"]), 99, 0, hideMonitor: false);
        check(Shown(limited, defaults) == "99", "without server state the monitor's own session, the only one SQL Server shows, is not hidden as a pool");
    }

    private static void Filters(Action<bool, string> check)
    {
        var builder = new ActivitySessionRows(Catalog);
        var results = SessionResults([WithRequest(Session(51), status: "running"), Session(52, openTransactions: 2), WithRequest(Session(53), status: "suspended", blocker: 51, waitType: "LCK_M_S", waitTime: 50)],
            [new Dictionary<string, object?> { ["session_id"] = 53, ["exec_context_id"] = 0, ["blocking_session_id"] = 51, ["blocking_exec_context_id"] = 0, ["wait_type"] = "LCK_M_S", ["wait_duration_ms"] = 50L, ["resource_description"] = "x" }]);
        var sample = builder.Build(results, 0, Own([]), 99, 0);
        string Shown(string? view, string? text = null)
        {
            var filter = ActivityFilter.Compile(Catalog, new("sessions", view, Text: text));
            return string.Join(",", sample.Sessions.Where(row => filter.Matches(builder.SessionsWriter.Reader(row), sample.Facts[row])).Select(row => Cell(builder.SessionsWriter, row, "sessionId")));
        }
        check(Shown("active") == "51,53" && Shown("blocked") == "53" && Shown("blocking") == "51" && Shown("idleOpenTransaction") == "52" && Shown(null, "lck_m_s") == "53" && Shown(null, "OPEN TRAN") == "52",
            "the view chips and the filter box work on the rows the sessions probe builds: what each row's facts and cells say");
    }

    private static void Args(Action<bool, string> check)
    {
        string Outcome(ActivityLiveArgs args)
        {
            try { ActivityReader.Check(args, Catalog); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var refused = new (string Name, ActivityLiveArgs Args)[]
        {
            ("nothing", new()), ("no filters", new(Filters: [])), ("a null filter", new(Filters: [null])), ("an unknown table", new(Filters: [new("nope")])),
            ("one table twice", new(Filters: [new("sessions"), new("sessions", "active")])), ("a negative session", new(FocusSession: -1)), ("session 32,768", new(FocusSession: 32_768)),
            ("a bad filter", new(Filters: [new("files", View: "all")])), ("eight filters", new(Filters: [.. Catalog.Tables.Keys.Select(table => new ActivityFilterDto(table)), new("sessions")]))
        }.Where(entry => Outcome(entry.Args) != "INVALID_PARAMS").Select(entry => entry.Name).ToList();
        check(refused.Count == 0 && Outcome(new(FocusSession: 0)) == "accepted" && Outcome(new([new("sessions", "blocked"), new("waitTypes", HideBenign: false)], 32_767)) == "accepted",
            "the activity args are refused as zod refuses them: empty, a null or repeated or invalid filter, a session id out of range: " + string.Join(", ", refused));
        // Strict on the wire: unknown members are refused as the backend's options read them.
        var wire = new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web) { UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow };
        var strict = false;
        try { System.Text.Json.JsonSerializer.Deserialize<ActivityLiveArgs>("""{"focusSession":1,"columns":["a"]}""", wire); }
        catch (System.Text.Json.JsonException) { strict = true; }
        check(strict, "the activity args refuse members they do not know (projection is not one)");
    }

    private static void Errors(Action<bool, string> check)
    {
        var spec = LiveCatalog.Current.Probes[ActivityReader.SessionsProbe];
        var overview = LiveCatalog.Current.Probes[ActivityReader.OverviewProbe];
        var error = LiveErrors.Create(spec.Id, "PERMISSION_DENIED", LiveErrors.PermissionMessage);
        var edges = ActivityReader.Named(error, spec, [Statement("activity.sessions", "edges")]);
        var active = ActivityReader.Named(error, spec, [Statement("activity.sessions", "activeQueries")]);
        var clock = ActivityReader.Named(error, spec, [Statement("activity.sessions", "clock")]);
        var counters = ActivityReader.Named(error, overview, [Statement("activity.overview", "counters")]);
        var names = overview.Series.Select(series => series.Id).ToList();
        check(edges is { Tables: [0, 1], Series: null } && active is { Tables: [2], Series: null } && clock is { Tables: null, Series: null }
            && counters.Tables is null && counters.Series!.Select(at => names[at]).Order(StringComparer.Ordinal).SequenceEqual(["batchRequests", "compilations", "deadlocks", "grantsOutstanding", "grantsPending", "lockWaits", "logins", "pageLifeExpectancy", "recompilations"]),
            "a statement's error names the tables and series it feeds by their place in the probe's catalogue entry, and the clock's names none");
    }

    private static readonly ServerProfile Box = new(17, "17.0.1000.0", 3, "app_user", false, true, false);

    private static bool IsLimited(ActivityStatement statement) => statement.Id == "sessions" && !statement.Text.Contains("dm_exec_connections", StringComparison.Ordinal);

    /// <summary>A reader whose statements the check answers, on a connection that never opens: Ran lists each statement run
    /// (the limited sessions statement marked), and Fails says which SQL Server refuses with Msg 300.</summary>
    private sealed class Scripted
    {
        public readonly List<string> Ran = [];
        public bool ServerState = true;
        public Func<ActivityStatement, bool> Fails = _ => false;
        public long Ticks = 10_000;
        public List<Dictionary<string, object?>> SessionRows = [];
        public List<Dictionary<string, object?>> Edges = [];
        public List<Dictionary<string, object?>> Active = [];
        public readonly ActivityReader Reader;
        private readonly SqlConnection connection = new();

        public Scripted()
        {
            Reader = new ActivityReader(new NoHost(), "c") { TestRun = Run };
            Reader.Unavailable(LiveCatalog.Current.Probes[ActivityReader.OverviewProbe], Box);
            Reader.Unavailable(LiveCatalog.Current.Probes[ActivityReader.SessionsProbe], Box);
        }

        private Task<ActivityResult> Run(ActivityStatement statement, IReadOnlyDictionary<string, object> values)
        {
            Ran.Add(statement.Probe + " " + statement.Id + (IsLimited(statement) ? " limited" : ""));
            if (Fails(statement)) throw ConnectionFailureChecks.Sql(300, 1, 14, "server", "VIEW SERVER PERFORMANCE STATE permission was denied on object 'server', database 'master'.");
            Dictionary<string, object?>[] rows = statement.Id switch
            {
                "capabilities" => [new() { ["spid"] = 99, ["server_state"] = ServerState ? 1 : 0, ["alter_any_connection"] = 0, ["view_any_definition"] = 0, ["spills"] = 1 }],
                "clock" => [new() { ["ms_ticks"] = Ticks, ["sqlserver_start_time_ms_ticks"] = 1L }],
                "sessions" => [.. SessionRows],
                "edges" => [.. Edges],
                "activeQueries" => [.. Active],
                "requests" => [new() { ["user_sessions"] = null, ["active_requests"] = null }],
                _ => []
            };
            return Task.FromResult(Result(statement, rows));
        }

        /// <summary>A new connection's capability probe.</summary>
        public void Connect() => Reader.SessionAsync(connection, "", "VIEW SERVER PERFORMANCE STATE", CancellationToken.None).GetAwaiter().GetResult();

        public LiveReaderSample Read(string probe, string? gap = null)
        {
            var due = new LiveDue(new LiveProbeState(LiveCatalog.Current.Probes[probe], 2_000), gap, null, null, null, new Dictionary<int, LiveTrackArgs>(), TakenAt: Ticks);
            return Reader.ReadAsync(connection, "", due, null, CancellationToken.None).GetAwaiter().GetResult();
        }
    }

    private static void Reader(Action<bool, string> check)
    {
        // A login without server state whose capability probe ran only at the first tick (the source opened paused): SQL
        // Server refuses every overview statement but one, whose sums are then NULL.
        var denied = new Scripted { ServerState = false };
        denied.Fails = statement => statement.Probe == ActivityReader.OverviewProbe && statement.Id != "requests";
        denied.Connect();
        var overview = denied.Read(ActivityReader.OverviewProbe, "baseline");
        var sessions = denied.Read(ActivityReader.SessionsProbe, "baseline");
        check(overview is { Sampled: false, Raw: null, Errors: [{ Code: "PERMISSION_DENIED", Terminal: true, Tables: null, Series: null }] }
            && !denied.Ran.Any(entry => entry.StartsWith(ActivityReader.OverviewProbe, StringComparison.Ordinal)) && sessions.Sampled && denied.Ran.Contains("activity.sessions sessions limited"),
            "without server state the overview runs nothing and stops (PERMISSION_DENIED, terminal) even when the capability probe ran after it opened, while the sessions probe reads its limited statement: "
            + string.Join(", ", denied.Ran));

        // Server state lost mid-run: every full statement is refused, and skipped on that connection.
        var lost = new Scripted();
        lost.Connect();
        lost.Fails = statement => statement.Probe == ActivityReader.SessionsProbe && !IsLimited(statement);
        var refused = lost.Read(ActivityReader.SessionsProbe, "baseline");
        lost.Ran.Clear();
        var again = lost.Read(ActivityReader.SessionsProbe);
        check(!refused.Sampled && !again.Sampled && lost.Ran.Count == 0, "statements refused for good are not run again on that connection: " + string.Join(", ", lost.Ran));
        // A new connection's capability probe finds it gone: the limited statement, under the full one's id, runs.
        lost.ServerState = false;
        lost.Connect();
        var limited = lost.Read(ActivityReader.SessionsProbe);
        check(limited.Sampled && lost.Ran.Contains("activity.sessions sessions limited"),
            "after server state is lost, the next connection runs the limited sessions statement, though the full one under its id was refused: " + string.Join(", ", lost.Ran));
        // A new connection runs again what the last refused: its login may since hold the permission.
        var granted = new Scripted();
        granted.Connect();
        granted.Fails = statement => statement.Id == "edges";
        granted.Read(ActivityReader.SessionsProbe, "baseline");
        granted.Fails = _ => false;
        granted.Connect();
        granted.Ran.Clear();
        var regained = granted.Read(ActivityReader.SessionsProbe);
        check(granted.Ran.Contains("activity.sessions edges") && regained.Errors.Count == 0, "a statement refused on one connection runs again on the next: " + string.Join(", ", granted.Ran));

        // Args: an update replaces only the filters of the tables it names, and the focus session stays until one names another.
        var args = new Scripted
        {
            SessionRows = [WithRequest(Session(51, cpu: 1_000)), WithRequest(Session(53), status: "suspended", blocker: 51, waitType: "LCK_M_S", waitTime: 50)],
            Edges = [new() { ["session_id"] = 53, ["exec_context_id"] = 0, ["blocking_session_id"] = 51, ["blocking_exec_context_id"] = 0, ["wait_type"] = "LCK_M_S", ["wait_duration_ms"] = 50L, ["resource_description"] = "x" }],
            Active =
            [
                new() { ["session_id"] = 51, ["request_id"] = 0, ["start_time"] = Login, ["status"] = "running", ["cpu_time"] = 5, ["statement_text"] = "SELECT * FROM dbo.orders", ["blocking_session_id"] = (short)0 },
                new() { ["session_id"] = 53, ["request_id"] = 0, ["start_time"] = Login, ["status"] = "suspended", ["cpu_time"] = 5, ["statement_text"] = "SELECT * FROM dbo.lines", ["blocking_session_id"] = (short)51 }
            ]
        };
        args.Connect();
        var reader = args.Reader;
        reader.Apply(ActivityReader.Check(new(Filters: [new("sessions", "blocked")]), Catalog));
        reader.Apply(ActivityReader.Check(new(Filters: [new("activeQueries", Text: "orders")]), Catalog));
        reader.Apply(ActivityReader.Check(new(FocusSession: 51), Catalog));
        var spec = LiveCatalog.Current.Probes[ActivityReader.SessionsProbe];
        string Shown(LiveReaderSample sample, string table, string column)
        {
            var at = spec.Tables.FindIndex(entry => entry.Id == table);
            var cell = spec.Tables[at].Columns.FindIndex(entry => entry.Id == column);
            var read = sample.Tables.Single(entry => entry.Table == at);
            return string.Join(",", read.Rows.Where(row => read.View?.Invoke(row) ?? true).Select(row => row.Cells[cell].Text));
        }
        double? Focus(LiveReaderSample sample) => sample.Raw!.Values[0];
        LiveReaderSample Next(long cpu)
        {
            args.Ticks += 1_000;
            args.SessionRows[0] = WithRequest(Session(51, cpu: cpu));
            return args.Read(ActivityReader.SessionsProbe);
        }
        var first = args.Read(ActivityReader.SessionsProbe, "baseline");
        var second = Next(1_500);
        reader.Apply(ActivityReader.Check(new(Filters: [new("blocking")]), Catalog));
        var third = Next(2_000);
        var filtersAfter = reader.Current.Filters.Keys.Order(StringComparer.Ordinal).ToList();
        reader.Apply(ActivityReader.Check(new(FocusSession: 0), Catalog));
        var fourth = Next(2_500);
        check(Shown(first, "sessions", "sessionId") == "53" && Shown(first, "activeQueries", "activeSessionId") == "51" && Shown(third, "sessions", "sessionId") == "53"
            && filtersAfter.SequenceEqual(["activeQueries", "blocking", "sessions"]),
            "an args update replaces the filters of the tables it names and keeps the others' (Processes stays on Blocked while Active Expensive Queries takes a text): "
            + Shown(first, "sessions", "sessionId") + " | " + Shown(first, "activeQueries", "activeSessionId") + " | " + string.Join(",", filtersAfter));
        check(Focus(first) is null && Focus(second) == 500 && Focus(third) == 500 && Focus(fourth) is null && reader.Current.Focus == 0,
            "the focus series follow the session focusSession names, through updates that name only filters, until one names another (0: none): "
            + string.Join(",", new[] { first, second, third, fourth }.Select(sample => Focus(sample)?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "-")));
    }

    private static void Ledger(Action<bool, string> check)
    {
        var time = 0L;
        var ledger = new OwnSessionLedger(() => time);
        var servers = new Dictionary<string, string> { ["a1"] = "server:A", ["a2"] = "server:A", ["b"] = "server:B" };
        string? ServerOf(string id) => servers.GetValueOrDefault(id);
        string Own(string id) => string.Join(",", ledger.Sessions(id, ServerOf).Order());
        ledger.Opened("a1", 63, pooled: true);
        ledger.Opened("a2", 64, pooled: true);
        ledger.Opened("b", 70, pooled: true);
        check(Own("a1") == "63,64" && Own("a2") == "63,64" && Own("b") == "70" && Own("nope") == "",
            "Varia's own sessions are those of every connection to the monitor's server, never another server's: " + Own("a1") + " | " + Own("b"));
        // An unpooled Object Actions connection's session ends as it closes; SQL Server may hand its id to anyone after.
        ledger.Opened("a1", 87, pooled: false);
        var held = Own("a1");
        ledger.Closed("a1", 87);
        // A pooled session stays while its connection waits in the pool, and goes once SqlClient would have pruned it.
        ledger.Closed("a1", 63);
        ledger.Closed("a2", 64);
        time += OwnSessionLedger.IdleMs - 1;
        var pooled = Own("a1");
        ledger.Opened("a2", 64, pooled: true);
        ledger.Closed("a2", 64);
        time += 2;
        var pruned = Own("a1");
        check(held == "63,64,87" && pooled == "63,64" && pruned == "64",
            "an id counts as Varia's only while it can be: an unpooled session until it closes, a pooled one until its idle connection would have been pruned, each open refreshing it: "
            + held + " | " + pooled + " | " + pruned);
        // So a client that takes a freed id and claims Varia's process, machine and program name is not a pool session.
        var varia = new VariaSessions(Catalog, 4242, [new VariaClient("Varia SQL Manager", Host)], ledger.Sessions("a1", ServerOf));
        check(varia.Classify(87, 4242, Host, "Varia SQL Manager - Object Actions", 99) == (null, false) && varia.Classify(63, 4242, Host, "Varia SQL Manager - Object Explorer", 99) == (null, false)
            && varia.Classify(64, 4242, Host, "Varia SQL Manager - Object Explorer", 99) == ("Varia Object Explorer", true),
            "a session under the id of a closed Object Actions connection or a pruned pool session, claiming Varia's process, machine and program name, shows as itself");
        // Disconnecting a connection id forgets its sessions.
        using var service = new SqlService();
        service.OwnSessions.Opened("gone", 63, pooled: true);
        var before = service.OwnSessions.Sessions("gone", _ => "server:A").Count;
        service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new { connectionId = "gone" }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        check(before == 1 && service.OwnSessions.Sessions("gone", _ => "server:A").Count == 0, "connections.disconnect forgets the session ids its pooled and Object Actions connections were given");
    }
}
