using Varia.Backend.Activity;

namespace Varia.Backend.Tests;

/// <summary>Offline Activity Monitor checks: the embedded catalogue, the wait map (the same names as
/// tests/activity-waits.test.ts), the SQL's lint over every probe and render with mutations it must catch, what each
/// statement feeds, version bands, the blocking graph, and the filter engine with its bounds.</summary>
internal static class ActivityChecks
{
    private static readonly ActivityCatalog Catalog = ActivityCatalog.Current;

    public static void Run(Action<bool, string> check)
    {
        CatalogChecks(check);
        Waits(check);
        Statements(check);
        Lint(check);
        Sizes(check);
        Bands(check);
        Blocking(check);
        Filters(check);
    }

    private static void CatalogChecks(Action<bool, string> check)
    {
        check(ActivityCatalog.Version == 1 && Catalog.Source == "activity" && Catalog.PoolSuffix == " - Activity Monitor" && Catalog.MinBand == 13 && Catalog.MaxBand == 17
            && Catalog.Probes.Keys.Order(StringComparer.Ordinal).SequenceEqual(["activity.overview", "activity.queries", "activity.resources", "activity.sessions"])
            && Catalog.Tables.Count == 7 && Catalog.WaitCategories.Count == 24 && Catalog.WaitCategories[0] == "unknown" && Catalog.Views.SequenceEqual(["all", "active", "blocked", "blocking", "idleOpenTransaction", "rollingBack"]),
            "the embedded Activity Monitor catalogue is version 1: one source of four probes on the \" - Activity Monitor\" pool, seven tables, Query Store's 24 wait categories and six views");
        var sessions = Catalog.Table("sessions");
        check(sessions.RowCap == 10_000 && sessions.Key.SequenceEqual(["sessionId"]) && sessions.Identity.SequenceEqual(["loginTime"]) && sessions.DepartedLinger
            && sessions.FacetColumns.SetEquals(["login", "database", "application", "hostName", "waitType", "command", "status"]) && sessions.Columns[0] == new ActivityColumn("sessionId", "int", null)
            && Catalog.Table("recentQueries").Columns.Single(column => column.Capability is not null) == new ActivityColumn("spills", "bigint", "totalSpills")
            && Catalog.Probes["activity.queries"] is { Maxdop1: true, MinGapMs: 15_000, DefaultIntervalMs: 30_000, MinIntervalMs: 15_000 } && Catalog.Probes["activity.resources"].FloorMs == 5_000,
            "the tables keep their keys, caps and facets, and the query statistics run every 30 s at MAXDOP 1, never twice within 15 s");
        check(Catalog.Probes.Values.All(probe => probe.Hidden == "pause" && probe.FilterMode == (probe.Tables.Count > 0 ? "memory" : null)) && Catalog.LoadGuard == (3, 10)
            && Catalog.HideBenignDefault && Catalog.HideBenignTables.SetEquals(["waitCategories", "waitTypes"]),
            "probes pause while hidden and filter in memory where they have tables; the load guard counts and Hide benign waits come from the catalogue");
        check(Catalog.Limit("sessions") == 10_000 && Catalog.Limit("blockingEdges") == 20_000 && Catalog.Limit("blockingRows") == 2_000 && Catalog.Limit("blockingDepth") == 32
            && Catalog.Limit("filterText") == 400 && Catalog.Limit("columnFilters") == 8 && Catalog.Limit("columnFilterValues") == 50 && Catalog.Limit("columnFilterChars") == 256
            && Catalog.Limit("textBatch") == ActivitySql.TextSlots && Catalog.Limit("killSessions") == 64 && Catalog.BlockerLabels[-2] == "Orphaned DTC" && Catalog.BlockerLabels.Count == 4
            && Catalog.Tones["blocked"] == "error" && Catalog.VariaSuffixes.Count(entry => entry.Kind == "queryTab") == 1 && Catalog.VariaSuffixes.Any(entry => entry.Suffix == Catalog.PoolSuffix),
            "the limits, negative blocker ids, tones and Varia's session suffixes equal TypeScript's");
        check(Catalog.EditionOf(2) == "box" && Catalog.EditionOf(8) == "managedInstance" && Catalog.EditionOf(5) == "azureSqlDatabase" && Catalog.EditionOf(6) is null && Catalog.EditionOf(11) is null
            && Catalog.Available("box") && Catalog.Available("managedInstance") && !Catalog.Available("azureSqlDatabase"),
            "the monitor serves box servers and Managed Instance now, Azure SQL Database later, and no other engine edition");
    }

    private static void Waits(Action<bool, string> check)
    {
        var expected = new Dictionary<string, string>
        {
            ["SOS_SCHEDULER_YIELD"] = "cpu", ["THREADPOOL"] = "workerThread", ["LCK_M_X_LOW_PRIORITY"] = "lock", ["LCK_M_SCH_M_ABORT_BLOCKERS"] = "lock", ["PAGEIOLATCH_SH"] = "bufferIo",
            ["PAGELATCH_EX"] = "bufferLatch", ["LATCH_EX"] = "latch", ["CXCONSUMER"] = "parallelism", ["CXSYNC_PORT"] = "parallelism", ["CXPACKET"] = "parallelism", ["HADR_SYNC_COMMIT"] = "replication",
            ["PREEMPTIVE_OS_WRITEFILE"] = "preemptive", ["MEMORY_ALLOCATION_EXT"] = "memory", ["RESOURCE_SEMAPHORE"] = "memory", ["WRITELOG"] = "tranLogIo", ["ASYNC_NETWORK_IO"] = "networkIo",
            ["IO_QUEUE_LIMIT"] = "otherDiskIo", ["POOL_LOG_RATE_GOVERNOR"] = "logRateGovernor", ["RBIO_RG_STORAGE"] = "logRateGovernor", ["RESOURCE_SEMAPHORE_QUERY_COMPILE"] = "compilation",
            ["SQLCLR_QUANTUM_PUNISHMENT"] = "sqlClr", ["XACT_OWN_TRANSACTION"] = "transaction", ["DTC_STATE"] = "transaction", ["FULLTEXT GATHERER"] = "fullTextSearch", ["TRACEWRITE"] = "tracing",
            ["WAITFOR"] = "userWait", ["BROKER_TRANSMISSION_WORK"] = "serviceBroker", ["DBMIRROR_SEND"] = "mirroring", ["PWAIT_HADRSIM"] = "replication", ["EXTERNAL_SCRIPT_NETWORK_IO"] = "networkIo",
            ["BROKER_RECEIVE_WAITFOR"] = "userWait", ["HADR_THROTTLE_LOG_RATE_GOVERNOR"] = "logRateGovernor", ["LOGMGR"] = "tranLogIo",
            ["NEW_WAIT_2030"] = "unknown", ["MSQL_XP"] = "unknown", [""] = "unknown", ["lck_m_x"] = "unknown", ["LCK_M"] = "unknown"
        };
        var wrong = expected.Where(entry => Catalog.Classify(entry.Key) != new WaitClass(entry.Value, false)).Select(entry => entry.Key).ToList();
        check(wrong.Count == 0 && expected.Keys.All(name => Catalog.Classify(name).CountsAsWaiting),
            "wait types map to Query Store's categories, exceptions before patterns, and unknown types stay Unknown and count as waiting, as in TypeScript: " + string.Join(", ", wrong));
        var benign = Catalog.BenignWaits.ToList();
        check(benign.Count == 47 && benign.All(name => Catalog.Classify(name) == new WaitClass("idle", true))
            && new[] { "CLR_AUTO_EVENT", "HADR_FILESTREAM_IOMGR_IOCOMPLETION", "BROKER_TO_FLUSH", "PREEMPTIVE_XE_GETTARGETSTATE", "SOS_WORK_DISPATCHER" }.All(name => Catalog.Classify(name).Benign),
            "Varia's benign waits count as Idle before any pattern can claim them");
        // Query Store's own Idle waits accrue about 11 s per second on an idle server; counted, they would show 11 waiting tasks.
        string[] idle = ["LAZYWRITER_SLEEP", "SLEEP_TASK", "LOGMGR_QUEUE", "CHECKPOINT_QUEUE", "XE_TIMER_EVENT", "XE_DISPATCHER_WAIT", "SQLTRACE_INCREMENTAL_FLUSH_SLEEP", "REQUEST_FOR_DEADLOCK_SEARCH"];
        check(Catalog.BenignCategories.SequenceEqual(["idle"]) && idle.All(name => Catalog.Classify(name) == new WaitClass("idle", true) && !Catalog.Classify(name).CountsAsWaiting)
            && benign.All(name => !Catalog.Classify(name).CountsAsWaiting),
            "every Idle wait is benign and never counts in Waiting Tasks, whether Varia's list or Query Store's names claim it");
    }

    private static IEnumerable<ActivityStatement> All(ActivityRender render) => Catalog.Probes.Keys.SelectMany(probe => ActivitySql.Statements(probe, render));

    private static void Statements(Action<bool, string> check)
    {
        var render = new ActivityRender(17, "box", true);
        var problems = new List<string>();
        foreach (var (name, probe) in Catalog.Probes)
        {
            var statements = ActivitySql.Statements(name, render);
            if (statements[0].Id != "clock") problems.Add(name + " does not start with the clock");
            var feeds = statements.SelectMany(statement => statement.Feeds).ToHashSet(StringComparer.Ordinal);
            bool Known(string feed) => feed == "clock" || probe.Tables.Contains(feed) || probe.Series.Contains(feed) || feed == "wait.*" && probe.Series.Any(series => series.StartsWith("wait.", StringComparison.Ordinal));
            problems.AddRange(feeds.Where(feed => !Known(feed)).Select(feed => name + " feeds the unknown " + feed));
            problems.AddRange(probe.Tables.Where(table => !feeds.Contains(table)).Select(table => name + " feeds no statement to " + table));
            problems.AddRange(probe.Series.Where(series => !feeds.Contains(series) && !(series.StartsWith("wait.", StringComparison.Ordinal) && feeds.Contains("wait.*"))).Select(series => name + " feeds no statement to " + series));
            if (statements.Select(statement => statement.Id).Distinct().Count() != statements.Count) problems.Add(name + " repeats a statement id");
            foreach (var statement in statements)
                if (statement.Parameters.Select(parameter => parameter.Name).Distinct(StringComparer.Ordinal).Count() != statement.Parameters.Count) problems.Add(name + " " + statement.Id + " repeats a parameter");
        }
        check(problems.Count == 0, "every probe starts with the clock, and its statements feed exactly its tables and series, so a permission error names what it affects: " + string.Join("; ", problems.Take(3)));
        var spills = ActivitySql.Statements("activity.queries", render).Single(statement => statement.Id == "stats");
        var plain = ActivitySql.Statements("activity.queries", render with { TotalSpills = false }).Single(statement => statement.Id == "stats");
        var text = ActivitySql.Statements("activity.queries", render).Single(statement => statement.Id == "text");
        check(spills.Columns.Count == plain.Columns.Count + 2 && spills.Text.Contains("q.total_spills, q.last_spills", StringComparison.Ordinal) && !plain.Text.Contains("spills", StringComparison.Ordinal)
            && text.Parameters.Count == 4 * ActivitySql.TextSlots && text.Text.Contains("(49, @h49, @p49, @s49, @e49)", StringComparison.Ordinal)
            && spills.Batch.StartsWith(ActivitySql.Prologue, StringComparison.Ordinal) && ActivitySql.Prologue.Contains("LOCK_TIMEOUT 1000", StringComparison.Ordinal),
            "the query statistics read spills only with the capability, fetch 50 texts per statement, and every batch starts with the live prologue");
        var threw = 0;
        foreach (var bad in new[] { new ActivityRender(12, "box"), new ActivityRender(18, "box"), new ActivityRender(17, "azureSqlDatabase") })
        {
            try { ActivitySql.Statements("activity.overview", bad); }
            catch (RequestException error) when (error.Code == "BACKEND_ERROR") { threw++; }
        }
        check(threw == 3, "no SQL is rendered below SQL Server 2016, above the newest band, or for Azure SQL Database yet");
    }

    private static void Lint(Action<bool, string> check)
    {
        var results = ActivitySql.Lint().ToList();
        var failing = results.Where(result => result.Problems.Count > 0).Select(result => result.Name + ": " + string.Join("; ", result.Problems)).ToList();
        var renders = ActivitySql.Renders().ToList();
        // Without server state the sessions probe reads one statement (the caller's own session); Details' eight statements and
        // Kill's one are linted with every render; the capability probe is linted once.
        check(failing.Count == 0 && renders.Count == 5 * 2 * 2 * 2 && results.Count == renders.Count / 2 * (7 + 5 + 4 + 3 + 8 + 1) + renders.Count / 2 * (7 + 1 + 4 + 3 + 8 + 1) + 1,
            "every Activity Monitor statement, Details' and Kill's included, passes its lint for every band, kind of server, capability and permission, with the capability probe: " + string.Join(" | ", failing.Take(3)));
        var render = new ActivityRender(17, "box");
        var sessions = ActivitySql.Statements("activity.sessions", render).Single(statement => statement.Id == "sessions");
        var counters = ActivitySql.Statements("activity.overview", render).Single(statement => statement.Id == "counters");
        var stats = ActivitySql.Statements("activity.queries", render).Single(statement => statement.Id == "stats");
        ActivityStatement With(ActivityStatement statement, string from, string to) => statement with { Text = statement.Text.Replace(from, to, StringComparison.Ordinal) };
        var mutations = new (string Name, ActivityStatement Statement, ActivityRender Render)[]
        {
            ("DB_NAME", With(sessions, "d.name AS database_name", "DB_NAME(s.database_id) AS database_name"), render),
            ("OBJECT_NAME", With(sessions, "d.name AS database_name", "OBJECT_NAME(1) AS database_name"), render),
            ("a temp table", With(sessions, "FROM sys.dm_exec_sessions AS s", "FROM #sessions AS s"), render),
            ("SELECT INTO", With(sessions, "\nFROM sys.dm_exec_sessions AS s", " INTO dbo.copy\nFROM sys.dm_exec_sessions AS s"), render),
            ("sys.sysprocesses", With(sessions, "sys.dm_exec_sessions AS s", "sys.sysprocesses AS s"), render),
            ("the locks DMV", With(sessions, "sys.dm_resource_governor_workload_groups", "sys.dm_tran_locks"), render),
            ("EXEC", sessions with { Text = sessions.Text + "\nEXEC (N'x');" }, render),
            ("DDL", sessions with { Text = "DROP TABLE t;\n" + sessions.Text }, render),
            ("WAITFOR", sessions with { Text = "WAITFOR DELAY '00:00:01';\n" + sessions.Text }, render),
            ("SELECT *", With(sessions, "SELECT x.session_id,", "SELECT *, x.session_id,"), render),
            // The windows' ORDER BYs that remain order no TOP.
            ("a TOP without ORDER BY", With(With(sessions, "SELECT x.session_id", "SELECT TOP (@rowCap) x.session_id"), "\nORDER BY x.session_order, x.request_rank;", ";"), render),
            ("a TOP literal above 20", With(sessions, "SELECT x.session_id", "SELECT TOP (21) x.session_id"), render),
            ("a bare TOP", With(sessions, "SELECT x.session_id", "SELECT TOP 5 x.session_id"), render),
            ("an undeclared parameter", With(sessions, "@rowCap", "@cap"), render),
            ("an unused parameter", sessions with { Parameters = [.. sessions.Parameters, new("@unused", System.Data.SqlDbType.Int)] }, render),
            ("an unlisted literal", With(counters, "N'Logins/sec'", "N'Logouts/sec'"), render),
            ("a literal outside its statement", With(sessions, "c.parent_connection_id IS NULL", "c.net_transport = N'TCP'"), render),
            ("spills without the capability", With(stats, "q.last_rows", "q.last_rows, q.total_spills"), render),
            ("no MAXDOP 1", With(stats, "\nOPTION (MAXDOP 1);", ";"), render),
            ("a band gate", sessions, render with { Band = 12 }),
            ("an Azure-only view on a box server", With(sessions, "sys.dm_resource_governor_workload_groups", "sys.dm_db_resource_stats"), render),
            ("master_files on Azure", ActivitySql.Statements("activity.resources", render).Single(statement => statement.Id == "files"), render with { Edition = "azureSqlDatabase" }),
            ("no semicolon", sessions with { Text = sessions.Text.TrimEnd(';') }, render),
            ("a duplicate column", sessions with { Columns = [.. sessions.Columns, "session_id"] }, render),
            ("an unknown probe", sessions with { Probe = "activity.other" }, render)
        };
        var missed = mutations.Where(mutation => (mutation.Statement == sessions && mutation.Render == render) || ActivitySql.Lint(mutation.Statement, mutation.Render).Count == 0).Select(mutation => mutation.Name).ToList();
        check(missed.Count == 0 && ActivitySql.Lint(sessions, render).Count == 0, "the Activity Monitor lint catches every mutation: " + string.Join(", ", missed));
        var unflagged = ActivitySql.ForbiddenTokens.Where(token => !ActivitySql.Lint(With(sessions, "d.name AS database_name", token + "1) AS database_name"), render).Contains("uses " + token)).ToList();
        check(ActivitySql.ForbiddenTokens.Count >= 25 && unflagged.Count == 0, "the lint refuses each forbidden built-in, view and token on its own: " + string.Join(", ", unflagged));
    }

    private static void Sizes(Action<bool, string> check)
    {
        var render = new ActivityRender(17, "box", true);
        string Text(string probe, string id) => ActivitySql.Statements(probe, render).Single(statement => statement.Id == id).Text;
        var sessions = Text("activity.sessions", "sessions");
        check(Text("activity.sessions", "edges").Contains($"LEFT(w.resource_description, {Catalog.Limit("resourceChars")}) AS resource_description", StringComparison.Ordinal)
            && Text("activity.sessions", "leadBatches").StartsWith($"SELECT TOP ({Catalog.Limit("leadBlockerBatches")}) ", StringComparison.Ordinal)
            && Text("activity.sessions", "leadBatches").Contains($"LEFT(ib.event_info, {Catalog.Limit("inputBufferChars")}) AS event_info", StringComparison.Ordinal)
            && Text("activity.sessions", "activeQueries").Contains($"END), {Catalog.Limit("statementChars")}) AS statement_text", StringComparison.Ordinal)
            && Text("activity.queries", "text").Contains($"END), {Catalog.Limit("statementChars")}) AS statement_text", StringComparison.Ordinal)
            && Catalog.Limit("textBatch") == ActivitySql.TextSlots,
            "the SQL reads the text sizes and lead blocker batches the catalogue's limits (and docs/activity-monitor.md) state");
        // One row per request from one read of the requests DMV, ranked within the session; the cap counts sessions.
        check(sessions.Split("sys.dm_exec_requests").Length == 2 && sessions.Contains(") AS r ON r.session_id = s.session_id\n", StringComparison.Ordinal)
            && sessions.Contains("COUNT(*) OVER (PARTITION BY q.session_id) AS request_count", StringComparison.Ordinal)
            && sessions.Contains("DENSE_RANK() OVER (ORDER BY CASE WHEN e.session_id IS NOT NULL OR r.session_blocked = 1 THEN 0 WHEN r.session_id IS NOT NULL THEN 1 ELSE 2 END, s.session_id) AS session_order", StringComparison.Ordinal)
            && sessions.EndsWith("WHERE x.session_order <= @rowCap\nORDER BY x.session_order, x.request_rank;", StringComparison.Ordinal),
            "the sessions statement returns each MARS request as its own row, its cap counts sessions (never cutting a session's requests apart), and blocking sessions come first");
    }

    private static void Bands(Action<bool, string> check)
    {
        check(ActivitySql.BandOf(13, 2, 12) == 13 && ActivitySql.BandOf(16, 3, 16) == 16 && ActivitySql.BandOf(17, 4, 17) == 17 && ActivitySql.BandOf(18, 2, 17) == 17
            && ActivitySql.BandOf(12, 3, 12) is null && ActivitySql.BandOf(12, 8, 16) == 16 && ActivitySql.BandOf(12, 8, 12) == 13 && ActivitySql.BandOf(12, 5, 16) is null && ActivitySql.BandOf(16, 6, 16) is null,
            "the SQL band follows a box server's version from SQL Server 2016, and Managed Instance's catalog (it reports 12); Azure SQL Database and other engines get none yet");
    }

    private static BlockingWait W(int waiter, int blocker, long ms = 1_000, string type = "LCK_M_X", bool task = true) => new(waiter, blocker, type, ms, "resource", task);

    private static void Blocking(Action<bool, string> check)
    {
        // SSMS's case (U4 §5.3): 60 idle with a transaction; 69 waits on it; 70 and 71 queue behind 69.
        var chain = BlockingGraph.Build([W(69, 60, 5_000), W(70, 69, 4_000), W(71, 69, 3_000), W(70, 69, 1_000)], 32, 2_000);
        check(chain.Rows.Select(row => (row.Node.SessionId, row.Depth)).SequenceEqual([(60, 0), (69, 1), (70, 2), (71, 2)]) && chain.Of(60) is { HeadBlocker: true, Downstream: 3, BlockedBy: null }
            && chain.Of(69) is { HeadBlocker: false, Downstream: 2, BlockedBy: 60 } && chain.Of(70) is { BlockedBy: 69, WaitMs: 4_000 } && chain.BlockedSessions == 3 && !chain.Truncated
            && chain.Rows.Count(row => row.Depth == 0) == 1,
            "a chain 60 → 69 → {70, 71} has one lead blocker, an idle one, and each session once, in order");
        var fan = BlockingGraph.Build(Enumerable.Range(61, 5).Select(waiter => W(waiter, 60, waiter)), 32, 2_000);
        check(fan.Rows.Count == 6 && fan.Rows.Select(row => row.Node.SessionId).Distinct().Count() == 6 && fan.Of(60)!.Downstream == 5
            && fan.Rows.Skip(1).Select(row => row.Node.SessionId).SequenceEqual([65, 64, 63, 62, 61]),
            "a session blocking five others is one row (SSMS lists it five times), its waiters longest wait first");
        var parallel = BlockingGraph.Build([W(80, 80, type: "CXPACKET"), W(90, 91, 100), W(90, 92, 500), W(90, 92, 200), W(90, 91, 9_999, task: false), W(95, 96, 700, task: false), W(97, 0)], 32, 2_000);
        check(parallel.Of(80) is null && parallel.Of(97) is null && parallel.Of(90) is { BlockedBy: 92, WaitMs: 500 } && parallel.Of(91) is null && parallel.Of(95)!.BlockedBy == 96 && parallel.Of(96)!.HeadBlocker,
            "a parallel query's waits on itself are no blocking; a session hangs under its longest task wait, deduplicated, and a request's blocker counts only without task waits");
        var special = BlockingGraph.Build([W(100, -2, 9_000), W(101, -4, 9_000), W(101, 102, 10), W(103, 100)], 32, 2_000);
        check(special.Of(100) is { BlockedBy: -2, HeadBlocker: true, Downstream: 1 } && special.Of(-2) is null && special.Of(101)!.BlockedBy == 102
            && special.Rows.Where(row => row.Depth == 0).Select(row => row.Node.SessionId).SequenceEqual([100, 102]) && special.BlockedSessions == 2,
            "a negative blocker (orphaned DTC, latch owner) is shown, never a node; a session blocker wins over it, and the waiter heads its own chain");
        // Under PAGELATCH contention every SH latch waiter waits on -5: no chain, no blocked session, and a lead blocker keeps its mark.
        var latch = BlockingGraph.Build([W(70, 60, 2_000), W(60, -5, 9_000, "PAGELATCH_SH"), W(80, -5, 50, "PAGELATCH_SH"), W(81, -4, 50, "LATCH_EX")], 32, 2_000);
        check(latch.Of(60) is { BlockedBy: -5, HeadBlocker: true, Downstream: 1 } && latch.Of(80) is { BlockedBy: -5, HeadBlocker: false } && latch.Of(81)!.BlockedBy == -4
            && latch.Rows.Select(row => (row.Node.SessionId, row.Depth)).SequenceEqual([(60, 0), (70, 1)]) && latch.BlockedSessions == 1,
            "latch-only waiters keep their negative Blocked By but are no Blocking rows and not blocked, and a lead blocker waiting on a latch stays the head blocker");
        var ties = BlockingGraph.Build([W(130, 132, 500), W(130, 131, 500), W(140, -2, 500), W(140, -5, 500)], 32, 2_000);
        check(ties.Of(130)!.BlockedBy == 131 && ties.Of(140)!.BlockedBy == -2, "equal waits hang a session under the lowest blocker id (by magnitude for negative ids)");
        var cycle = BlockingGraph.Build([W(110, 111, 50), W(111, 112, 60), W(112, 110, 70), W(113, 111, 10)], 32, 2_000);
        check(cycle.Rows.Select(row => (row.Node.SessionId, row.Depth)).SequenceEqual([(110, 0), (112, 1), (111, 2), (113, 3)]) && new[] { 110, 111, 112 }.All(id => cycle.Of(id)!.Cycle)
            && !cycle.Of(113)!.Cycle && cycle.Of(110) is { BlockedBy: 111, HeadBlocker: false, Downstream: 3 },
            "a cycle is cut at its lowest session id, which keeps what it waits on, and every member is marked");
        var deep = BlockingGraph.Build(Enumerable.Range(1, 10_000).Select(id => W(id + 1, id)), 32, 2_000);
        check(deep.Rows.Count == 33 && deep.Rows[^1].Depth == 32 && deep.Truncated && deep.Of(1)!.Downstream == 10_000,
            "a chain deeper than 32 is cut and marked truncated, and 10,000 deep builds without recursion");
        var wide = BlockingGraph.Build(Enumerable.Range(2, 3_000).Select(id => W(id, 1)), 32, 2_000);
        check(wide.Rows.Count == 2_000 && wide.Truncated && wide.Of(1)!.Downstream == 3_000, "the Blocking rows stop at 2,000, marked truncated, while counts cover every session");
        var order = BlockingGraph.Build([W(2, 1, 10), W(3, 1, 20), W(5, 4, 10), W(6, 4, 10), W(7, 4, 10), W(9, 8, 10), W(10, 8, 90)], 32, 2_000);
        check(order.Rows.Where(row => row.Depth == 0).Select(row => row.Node.SessionId).SequenceEqual([4, 8, 1]),
            "lead blockers come by sessions downstream, then by their chain's longest wait");
        check(BlockingGraph.Build([], 32, 2_000) is { Rows.Count: 0, Nodes.Count: 0, Truncated: false, BlockedSessions: 0 }, "no blocking is an empty graph");
    }

    private static void Filters(Action<bool, string> check)
    {
        string Refused(ActivityFilterDto dto)
        {
            try { ActivityFilter.Compile(Catalog, dto); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var invalid = new (string Name, ActivityFilterDto Filter)[]
        {
            ("an unknown table", new("nope")), ("a view on files", new("files", View: "all")), ("toggles on waits", new("waitTypes", ShowSystem: true)), ("an unknown view", new("sessions", View: "sleeping")),
            ("401 characters of text", new("sessions", Text: new string('x', 401))), ("nine column filters", new("sessions", ColumnFilters: [.. Enumerable.Repeat(new ActivityColumnFilterDto("login", ["a"]), 9)])),
            ("a column without facets", new("sessions", ColumnFilters: [new("sessionId", ["1"])])), ("a column twice", new("sessions", ColumnFilters: [new("login", ["a"]), new("login", ["b"])])),
            ("no choice", new("sessions", ColumnFilters: [new("login")])), ("51 values", new("sessions", ColumnFilters: [new("login", [.. Enumerable.Range(0, 51).Select(index => index.ToString())])])),
            ("a 257-character value", new("sessions", ColumnFilters: [new("login", [new string('v', 257)])])), ("a 65-character column", new("sessions", ColumnFilters: [new(new string('c', 65), ["a"])])),
            ("a facet of another table", new("files", ColumnFilters: [new("login", ["a"])]))
        };
        var accepted = invalid.Where(entry => Refused(entry.Filter) != "INVALID_PARAMS").Select(entry => entry.Name).ToList();
        check(accepted.Count == 0 && Refused(new("sessions", "blocked", true, true, new string('x', 400), [new("login", [new string('v', 256)]), new("database", Blanks: true)])) == "accepted",
            "the filter engine refuses what zod refuses, at the catalogue's bounds: " + string.Join(", ", accepted));
        // Bodies as the wire delivers them, deserialized with the backend's options: nulls are refused as values, never thrown.
        var wire = new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)
        {
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
            UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
        };
        string RefusedJson(string json)
        {
            try { return Refused(System.Text.Json.JsonSerializer.Deserialize<ActivityFilterDto>(json, wire)!); }
            catch (Exception error) when (error is not RequestException) { return error.GetType().Name; }
        }
        var nulls = new[]
        {
            """{"table":null}""", """{"table":"sessions","columnFilters":[{"column":null,"values":["a"]}]}""", """{"table":"sessions","columnFilters":[{"column":"login","values":[null]}]}""",
            """{"table":"sessions","columnFilters":[null]}"""
        }.Where(json => RefusedJson(json) != "INVALID_PARAMS").ToList();
        check(nulls.Count == 0, "the filter engine refuses null members as INVALID_PARAMS: " + string.Join(", ", nulls));
        check(Refused(new("waitTypes", HideBenign: false)) == "accepted" && Refused(new("waitCategories", HideBenign: true)) == "accepted" && Refused(new("sessions", HideBenign: true)) == "INVALID_PARAMS"
            && Refused(new("files", HideBenign: false)) == "INVALID_PARAMS",
            "Hide benign waits applies to Resource Waits' two tables only, as zod has it");
        bool Passes(ActivityFilterDto dto, bool benign) => ActivityFilter.Compile(Catalog, dto).Matches(_ => "x", benign: benign);
        check(!Passes(new("waitTypes"), true) && Passes(new("waitTypes"), false) && Passes(new("waitTypes", HideBenign: false), true) && !Passes(new("waitCategories"), true)
            && Passes(new("files"), true),
            "Resource Waits hides benign rows unless Hide benign waits is turned off");

        var rows = new (string Name, Dictionary<string, string?> Cells, SessionFacts Facts)[]
        {
            ("app", new() { ["login"] = "app_user", ["database"] = "Sales", ["application"] = "Web", ["hostName"] = "WEB01", ["status"] = "running", ["sessionId"] = "60" }, new(Active: true, Blocking: true)),
            ("idle", new() { ["login"] = "app_user", ["database"] = "Sales", ["application"] = "", ["hostName"] = "WEB02", ["status"] = "sleeping · 1 open tran" }, new(IdleOpenTransaction: true)),
            ("blocked", new() { ["login"] = "report", ["database"] = null, ["application"] = "Reports", ["hostName"] = "BI01", ["waitType"] = "LCK_M_S", ["status"] = "suspended" }, new(Active: true, Blocked: true)),
            ("system", new() { ["login"] = "sa", ["status"] = "background" }, new(System: true)),
            ("pool", new() { ["login"] = "me", ["application"] = "Varia - Object Explorer", ["status"] = "sleeping" }, new(VariaPool: true)),
            ("tab", new() { ["login"] = "me", ["application"] = "Varia", ["status"] = "sleeping" }, new()),
            ("rollback", new() { ["login"] = "etl", ["database"] = "Stage", ["command"] = "KILLED/ROLLBACK", ["status"] = "rolling back 42 %" }, new(Active: true, RollingBack: true))
        };
        string Shown(ActivityFilterDto dto)
        {
            var filter = ActivityFilter.Compile(Catalog, dto);
            return string.Join(",", rows.Where(row => filter.Matches(column => row.Cells.GetValueOrDefault(column), row.Facts)).Select(row => row.Name));
        }
        check(Shown(new("sessions")) == "app,idle,blocked,tab,rollback" && Shown(new("sessions", ShowSystem: true, ShowVaria: true)) == "app,idle,blocked,system,pool,tab,rollback",
            "Processes hides SQL Server's and Varia's pool sessions by default, and always shows this window's query tabs");
        check(Shown(new("sessions", "active")) == "app,blocked,rollback" && Shown(new("sessions", "blocked")) == "blocked" && Shown(new("sessions", "blocking")) == "app"
            && Shown(new("sessions", "idleOpenTransaction")) == "idle" && Shown(new("sessions", "rollingBack")) == "rollback" && Shown(new("sessions", "all")) == Shown(new("sessions")),
            "each view chip shows its sessions");
        check(Shown(new("sessions", Text: "SALES")) == "app,idle" && Shown(new("sessions", Text: "lck_m")) == "blocked" && Shown(new("sessions", Text: "60")) == "" && Shown(new("sessions", Text: "")) == Shown(new("sessions"))
            && Shown(new("sessions", Text: "open tran")) == "idle",
            "the filter box matches the text columns case-insensitively, and not the session id");
        check(Shown(new("sessions", ColumnFilters: [new("login", ["app_user", "report"])])) == "app,idle,blocked" && Shown(new("sessions", ColumnFilters: [new("login", ["app_user"]), new("hostName", ["WEB02"])])) == "idle"
            && Shown(new("sessions", ColumnFilters: [new("application", Blanks: true)])) == "idle,rollback" && Shown(new("sessions", ColumnFilters: [new("database", NonBlanks: true)])) == "app,idle,rollback"
            && Shown(new("sessions", ColumnFilters: [new("database", ["Stage"], Blanks: true)])) == "blocked,tab,rollback" && Shown(new("sessions", ColumnFilters: [new("login", ["APP_USER"])])) == "",
            "column filters match values exactly, any value within a column and every column together, with (Blanks) for NULL and empty text");
        var files = ActivityFilter.Compile(Catalog, new("files", Text: "tempdb"));
        check(files.Matches(column => column == "database" ? "tempdb" : null) && !files.Matches(column => column == "type" ? "tempdb" : null) && files.Table == "files",
            "other tables filter by their own text columns only");
    }
}
