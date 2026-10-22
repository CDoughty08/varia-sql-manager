using Varia.Backend.Activity;
using Varia.Backend.Live;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the Activity Monitor's live source: the capability probe and the statement without server state,
/// the overview's raw series from statement results, the sessions probe's rows (Processes, the blocking chains, Active
/// Expensive Queries) with their rates, statuses, blocked-by and head-blocker marks, Varia's own sessions, the filters and
/// focus series, and the args the live layer checks as zod does. Results are built by hand, as the statements return them.</summary>
internal static class ActivitySourceChecks
{
    private static readonly ActivityCatalog Catalog = ActivityCatalog.Current;
    private static readonly DateTime Login = new(2026, 10, 22, 9, 0, 0, DateTimeKind.Unspecified);

    public static void Run(Action<bool, string> check)
    {
        Statements(check);
        Overview(check);
        Sessions(check);
        Blocking(check);
        Varia(check);
        Filters(check);
        Args(check);
        Errors(check);
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
            ["io"] = Result(Statement("activity.overview", "io"), new Dictionary<string, object?> { ["bytes_read"] = 1_000L, ["bytes_written"] = 500L, ["reads"] = 10L, ["writes"] = 5L, ["read_stall_ms"] = 40L, ["write_stall_ms"] = 15L }),
            ["waits"] = Result(Statement("activity.overview", "waits"),
                new Dictionary<string, object?> { ["wait_type"] = "LCK_M_X", ["wait_time_ms"] = 100L, ["signal_wait_time_ms"] = 10L }, new Dictionary<string, object?> { ["wait_type"] = "LAZYWRITER_SLEEP", ["wait_time_ms"] = 9_000L, ["signal_wait_time_ms"] = 0L },
                new Dictionary<string, object?> { ["wait_type"] = "NEW_WAIT_2030", ["wait_time_ms"] = 50L, ["signal_wait_time_ms"] = 5L }, new Dictionary<string, object?> { ["wait_type"] = "SOS_WORK_DISPATCHER", ["wait_time_ms"] = 7_000L, ["signal_wait_time_ms"] = 0L }),
            ["blocked"] = Result(Statement("activity.overview", "blocked"), new Dictionary<string, object?> { ["blocked_sessions"] = 0, ["longest_wait_ms"] = null }),
            ["requests"] = Result(Statement("activity.overview", "requests"), new Dictionary<string, object?> { ["user_sessions"] = 12, ["active_requests"] = 3 })
        };
        var raw = ActivityOverview.Raw(series, results, Catalog);
        check(raw is { MsTicks: 5_000, StartTicks: 100 } && At(raw, "cpuPercent") == 900 && At(raw, "cpuPercent", true) == 4 && At(raw, "runnablePerScheduler") == 1.5 && At(raw, "workQueue") == 1
            && At(raw, "schedulerDelay") == 12 && At(raw, "batchRequests") == 700 && At(raw, "pageLifeExpectancy") == 5_412 && At(raw, "lockWaits") == 7 && At(raw, "ioMegabytes") == 1_500
            && At(raw, "readLatency") == 40 && At(raw, "readLatency", true) == 10 && At(raw, "writeLatency", true) == 5 && At(raw, "blockedSessions") == 0 && At(raw, "longestBlock") == 0
            && At(raw, "userSessions") == 12 && At(raw, "activeRequests") == 3,
            "the overview's raw values come from its statements: CPU with its scheduler count, runnable tasks per scheduler, counters by name (summed), I/O with its read and write counts, no blocking as 0 ms");
        check(At(raw, "waitingTasks") == 90 + 45, "Waiting Tasks sums wait less signal wait of every type that counts as waiting: Unknown types count, Idle and Varia's benign waits never do");
        results.Remove("counters");
        results.Remove("clock");
        var partial = ActivityOverview.Raw(series, results, Catalog);
        check(partial is { MsTicks: null, StartTicks: null } && At(partial, "batchRequests") is null && At(partial, "pageLifeExpectancy") is null && At(partial, "cpuPercent") == 900,
            "a statement that did not run (no permission) leaves only its own series empty, and without the clock rates fall back to the backend's");
    }

    private static Dictionary<string, object?> Session(int id, string program = "App", int? pid = 4242, bool user = true, string status = "sleeping", int openTransactions = 0, long cpu = 0, long reads = 0,
        DateTime? login = null) => new()
    {
        ["session_id"] = id, ["login_time"] = login ?? Login, ["host_process_id"] = pid, ["is_user_process"] = user, ["login_name"] = "app_user", ["original_login_name"] = "app_user",
        ["host_name"] = "WEB01", ["program_name"] = program, ["client_interface_name"] = ".Net SqlClient Data Provider", ["status"] = status, ["database_id"] = 5, ["database_name"] = "Sales",
        ["cpu_time"] = cpu, ["reads"] = 64L, ["writes"] = 64L, ["logical_reads"] = reads, ["memory_usage"] = 3, ["open_transaction_count"] = openTransactions,
        ["last_request_start_time"] = Login.AddMinutes(1), ["last_request_end_time"] = Login.AddMinutes(1), ["transaction_isolation_level"] = (short)2, ["workload_group"] = "default",
        ["client_net_address"] = "10.0.0.5", ["net_transport"] = "TCP", ["encrypt_option"] = "TRUE", ["auth_scheme"] = "NTLM"
    };

    private static Dictionary<string, object?> WithRequest(Dictionary<string, object?> session, string status = "running", string? command = "SELECT", long cpu = 0, long reads = 0, int count = 1,
        int blocker = 0, string? waitType = null, long waitTime = 0, float percent = 0, short dop = 1)
    {
        var row = new Dictionary<string, object?>(session)
        {
            ["request_id"] = 0, ["request_count"] = count, ["lowest_request_id"] = 0, ["request_status"] = status, ["command"] = command, ["start_time"] = Login.AddMinutes(2),
            ["total_elapsed_time"] = 1_500, ["request_cpu_ms"] = cpu, ["request_logical_reads"] = reads, ["request_reads"] = 0L, ["request_writes"] = 0L, ["blocking_session_id"] = (short)blocker,
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
        var varia = new VariaSessions(Catalog, 4242, ["Varia SQL Manager"]);
        var first = SessionResults([
            WithRequest(Session(51, cpu: 1_000, reads: 100), cpu: 200, reads: 50, count: 2),
            Session(52, status: "sleeping", openTransactions: 1),
            WithRequest(Session(53), command: "KILLED/ROLLBACK", status: "suspended", percent: 41.6f),
            Session(54, cpu: 70)
        ]);
        var sample = builder.Build(first, null, varia, 99, focusSession: 51);
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
        var next = builder.Build(second, 1_000, varia, 99, focusSession: 51);
        check(Cell(writer, Row(next, 51), "cpuRate") == "500.0" && Cell(writer, Row(next, 51), "logicalReadsRate") == "200.0" && next.FocusCpuRate == 500 && next.FocusReadsRate == 200
            && Cell(writer, Row(next, 54), "cpuRate") is null,
            "per-session rates add the session's CPU and its running requests', follow the Details flyout's session, and never span a reused session id (another login time)");
        // The sequence a 1.2 s CPU loop gave on SQL Server 2025, two batches then idle: the session takes in less than its
        // requests reported (813 against 1,096 ms), so session plus request would fall at each batch end.
        var cpu = new SessionRates(10);
        (int?, DateTime?) A = (0, Login), B = (0, Login.AddSeconds(2));
        double?[] Rate(double session, double? request, (int?, DateTime?)? running) => cpu.Apply(70, Login, new(session, request, 0, null, running), 1_000);
        var observed = new[] { Rate(0, 3, A), Rate(0, 1_096, A), Rate(813, 5, B), Rate(813, 1_096, B), Rate(1_813, null, null), Rate(1_813, null, null) }.Select(rate => rate[0]).ToList();
        var once = new SessionRates(10);
        once.Apply(71, Login, new(0, 500, 0, 40, A), 1_000);
        var ended = once.Apply(71, Login, new(800, null, 90, null, null), 1_000);
        check(observed.SequenceEqual([null, 1_093, 5, 1_091, 0, 0]) && ended is [300, 50],
            "a session's CPU rate counts a running request by its own change, a new request whole, and an ended one only beyond what it had counted: never negative where session plus request falls, never twice");
        var many = SessionResults(Enumerable.Range(1, (int)Catalog.Limit("sessions") + 1).Select(id => Session(id)));
        var capped = new ActivitySessionRows(Catalog).Build(many, null, varia, 99, 0);
        check(capped.Sessions.Count == Catalog.Limit("sessions") && capped.SessionsMore == 1, "Processes keeps the catalogue's 10,000 sessions and counts the one read past them as cut");
        // A full row: every column has a value, so no column of the live table is left unwritten.
        var everything = WithRequest(Session(60, cpu: 10, reads: 10), cpu: 1, reads: 1, blocker: 61, waitType: "LCK_M_S", waitTime: 900, percent: 5);
        var filled = new ActivitySessionRows(Catalog);
        filled.Build(SessionResults([everything, Session(61)]), null, new VariaSessions(Catalog, 4242, ["App"]), 99, 0);
        var row = filled.Build(SessionResults([everything, Session(61)], ticks: 11_000), 1_000, new VariaSessions(Catalog, 4242, ["App"]), 99, 0).Sessions[0];
        var empty = Catalog.Table("sessions").Columns.Where(column => Cell(writer, row, column.Id) is null).Select(column => column.Id).ToList();
        check(empty.Count == 0, "a session with a request, a blocker and a Varia label fills every Processes column: " + string.Join(", ", empty));
    }

    private static void Blocking(Action<bool, string> check)
    {
        var builder = new ActivitySessionRows(Catalog);
        var varia = new VariaSessions(Catalog, 4242, []);
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
        var sample = builder.Build(results, null, varia, 99, 0);
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
        var varia = new VariaSessions(Catalog, 4242, ["Varia SQL Manager", "Reports - Scripting"]);
        check(varia.Classify(1, 4242, "Varia SQL Manager - Object Explorer", 99) == ("Varia Object Explorer", true) && varia.Classify(2, 4242, "Varia SQL Manager", 99) == ("Query tab", false)
            && varia.Classify(3, 4242, "Varia SQL Manager - Activity Monitor", 99) == ("Varia Activity Monitor", true) && varia.Classify(4, 7, "Varia SQL Manager - Object Explorer", 99) == (null, false)
            && varia.Classify(5, 4242, "Reports - Scripting", 99) == ("Query tab", false)
            && new VariaSessions(Catalog, 4242, ["Reports - Scripting", "Reports"]).Classify(5, 4242, "Reports - Scripting", 99) == ("Varia Scripting", true) && varia.Classify(6, 4242, "SSMS", 99) == (null, false)
            && varia.Classify(99, null, null, 99) == ("Varia Activity Monitor", true) && varia.Classify(7, 4242, "Varia SQL Manager - Integration Services Actions", 99) == ("Varia Integration Services Actions", true),
            "Varia's own sessions are this process's under a connection's program name: its pools by suffix, its query tabs by the plain name (a pool wins when names collide), and the monitor's own session always");
        var builder = new ActivitySessionRows(Catalog);
        var results = SessionResults([Session(99, "Varia SQL Manager - Activity Monitor"), Session(100, "Varia SQL Manager"), Session(101, "Varia SQL Manager - Object Explorer"), Session(1, "", null, user: false)]);
        var sample = builder.Build(results, null, new VariaSessions(Catalog, 4242, ["Varia SQL Manager"]), 99, 0);
        var defaults = ActivityFilter.Compile(Catalog, new("sessions"));
        string Shown(ActivitySessionsSample built, ActivityFilter filter) => string.Join(",", built.Sessions.Where(row => filter.Matches(builder.SessionsWriter.Reader(row), built.Facts[row]))
            .Select(row => Cell(builder.SessionsWriter, row, "sessionId")));
        check(Shown(sample, defaults) == "100" && Shown(sample, ActivityFilter.Compile(Catalog, new("sessions", ShowSystem: true, ShowVaria: true))) == "99,100,101,1"
            && Cell(builder.SessionsWriter, sample.Sessions[1], "varia") == "Query tab" && Cell(builder.SessionsWriter, sample.Sessions[0], "varia") == "Varia Activity Monitor",
            "by default Processes hides SQL Server's sessions and Varia's pools, the monitor's own included, and always shows this window's query tabs, labelled");
        var limited = new ActivitySessionRows(Catalog).Build(SessionResults([Session(99, "Varia SQL Manager - Activity Monitor")]), null, new VariaSessions(Catalog, 4242, ["Varia SQL Manager"]), 99, 0, hideMonitor: false);
        check(Shown(limited, defaults) == "99", "without server state the monitor's own session, the only one SQL Server shows, is not hidden as a pool");
    }

    private static void Filters(Action<bool, string> check)
    {
        var builder = new ActivitySessionRows(Catalog);
        var results = SessionResults([WithRequest(Session(51), status: "running"), Session(52, openTransactions: 2), WithRequest(Session(53), status: "suspended", blocker: 51, waitType: "LCK_M_S", waitTime: 50)],
            [new Dictionary<string, object?> { ["session_id"] = 53, ["exec_context_id"] = 0, ["blocking_session_id"] = 51, ["blocking_exec_context_id"] = 0, ["wait_type"] = "LCK_M_S", ["wait_duration_ms"] = 50L, ["resource_description"] = "x" }]);
        var sample = builder.Build(results, null, new VariaSessions(Catalog, 4242, []), 99, 0);
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
}
