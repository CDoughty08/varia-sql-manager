using System.Globalization;
using System.Text.Json;
using Varia.Backend.Live;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live SQL checks of the live tables (VARIA_TEST_SQL_SERVER with VARIA_TEST_SQL_SCRATCH=1): test-only probes,
/// registered through LiveService's internal TestSql hook (never a request field), read a marked VariaScratch_…_live
/// database. A snapshot probe's two tables come from one batch, with SQL Server's display text, a diff, tracking and facets;
/// one failing statement names its table while the other arrives. An append probe tails a message log: under READ
/// COMMITTED without READ_COMMITTED_SNAPSHOT another session's uncommitted insert makes it BLOCKED (1222) while it keeps
/// ticking, and READ UNCOMMITTED reads through; with READ_COMMITTED_SNAPSHOT, ids committed out of order arrive exactly once;
/// a tail start writes its note row; a restart filter starts the table again. Only this run's sessions and database are
/// touched; the database is dropped in finally.</summary>
internal static class LiveTableDataChecks
{
    private const string Source = "test.scratch";
    private const string ItemsProbe = "test.scratch.items";
    private const string LogProbe = "test.scratch.log";
    private const string Escape = " ESCAPE N'\\'";

    private static LiveCatalog Catalog()
    {
        static LiveColumnJson Column(string id, string type) => new(id, id, type);
        var interval = new LiveIntervalJson(1000, 1000, 3_600_000);
        LiveProbeJson[] probes =
        [
            new(ItemsProbe, Source, "Items", "Items", interval, [],
                [new("items", "snapshot", [Column("id", "int"), Column("label", "nvarchar"), Column("amount", "int"), Column("seen", "datetime2")], ["id"], 100, true, ["label"]),
                 new("ratios", "snapshot", [Column("cid", "int"), Column("ratio", "int")], ["cid"], 100)], [], [], "memory"),
            new(LogProbe, Source, "Log", "Log", interval, [],
                [new("log", "append", [Column("id", "bigint"), Column("level", "int"), Column("message", "nvarchar")], ["id"], Settle: new(2, 5000), BatchRows: 100)], [], [], "restart")
        ];
        return LiveCatalog.Create(LiveCatalog.Current.Limits, probes, [new LiveSourceJson(Source, "Scratch", "Scratch", "server", false, [ItemsProbe, LogProbe])]);
    }

    private const string ItemsSql =
        "SELECT TOP (100) i.id, i.label, i.amount, CONVERT(datetime2(3), '2026-10-08T12:34:56.123') AS seen FROM dbo.VariaLiveItems AS i ORDER BY i.id;\n"
        + "SELECT TOP (100) c.id AS cid, CONVERT(int, 100 / c.amount) AS ratio FROM dbo.VariaLiveItems AS c ORDER BY c.id;";
    private const string Predicate = "(@before0 IS NULL OR l.id < @before0) AND (@filter IS NULL OR l.message LIKE @filter" + Escape + ")";
    private const string LogSql = "SELECT TOP (@top0) l.id, l.level, l.message FROM dbo.VariaLiveLog AS l WHERE l.id > @after0 AND " + Predicate + " ORDER BY l.id;";
    private const string TailSql =
        "SELECT a.id AS after_id, (SELECT COUNT_BIG(*) FROM dbo.VariaLiveLog AS l WHERE l.id <= a.id AND " + Predicate + ") AS earlier\n"
        + "FROM (SELECT l.id FROM dbo.VariaLiveLog AS l WHERE " + Predicate + " ORDER BY l.id DESC OFFSET @tail0 ROWS FETCH NEXT 1 ROWS ONLY) AS a;";

    private static LiveQuery? Query(string probe, int band) => probe switch
    {
        ItemsProbe => new LiveQuery(probe, band, ItemsSql, [], null, null, []) { Tables = [new(0), new(1)] },
        LogProbe => new LiveQuery(probe, band, LogSql, [], null, null, []) { Tables = [new(0, TailSql)], Filtered = true },
        _ => null
    };

    public static async Task RunAsync(Action<bool, string> check, SqlService service, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Live table SQL checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named database on a disposable development server.");
            return;
        }
        var catalog = Catalog();
        var lint = new[] { ItemsSql, LogSql, TailSql }.SelectMany(text => LiveSql.Lint(LiveSql.UncommittedPrologue + text)).ToList();
        check(lint.Count == 0 && Query(ItemsProbe, 17)!.Problems(catalog.Probes[ItemsProbe]).Count == 0 && Query(LogProbe, 17)!.Problems(catalog.Probes[LogProbe]).Count == 0,
            "the live table checks' probe SQL passes the live lint and fits its catalogue entries: " + string.Join("; ", lint));

        var sessions = new List<string>();
        ConnectionInfo? connection = null;
        async Task<SqlRun> Sql(string text, string database, string? session = null)
        {
            var id = session ?? Guid.NewGuid().ToString();
            if (session is not null && !sessions.Contains(session)) sessions.Add(session);
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(connection!.Id, id, database, text, Guid.NewGuid().ToString(), 1000, 60, StopOnError: true), json), json);
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { if (session is null) await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(id), json), json); }
        }
        async Task<ConnectionInfo> Connect() => connection = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(live("master"), json), json);
        async Task Disconnect()
        {
            if (connection is not null) await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(connection.Id), json), json);
        }
        await Connect();
        var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        var liveService = new LiveService(service, catalog);
        uint next = 9500;
        (Task<LiveEnd> Task, LiveRecorder Recorder, string Id) Subscribe(string probe, int intervalMs = 1000)
        {
            var recorder = new LiveRecorder(++next);
            var id = Guid.NewGuid().ToString();
            return (liveService.SubscribeAsync(new LiveSubscribeArgs(id, connection!.Id, Source, [new LiveProbeArgs(probe, intervalMs)]), recorder.Context, json), recorder, id);
        }
        static async Task<LiveEnd> Stop((Task<LiveEnd> Task, LiveRecorder Recorder, string Id) view)
        {
            view.Recorder.Context.Cancel(CancelReason.User);
            var end = await view.Task.WaitAsync(TimeSpan.FromSeconds(10));
            view.Recorder.Dispose();
            return end;
        }
        try
        {
            var database = await scratch.CreateLiveAsync();
            await Sql("CREATE TABLE dbo.VariaLiveItems (id int PRIMARY KEY, label nvarchar(50) NOT NULL, amount int NOT NULL);\n"
                + "CREATE TABLE dbo.VariaLiveLog (id bigint IDENTITY PRIMARY KEY, level int NOT NULL, message nvarchar(400) NOT NULL);\n"
                + "INSERT dbo.VariaLiveItems VALUES (1, N'red', 10), (2, N'blue', 20), (3, N'red', 30);", database);
            liveService.TestSql = new LiveTestSql(Query, database);
            await SnapshotAsync(check, liveService, Subscribe, Stop, text => Sql(text, database), json);
            await BlockedAsync(check, liveService, database, Subscribe, Stop, Sql);
            // READ_COMMITTED_SNAPSHOT needs the database to itself: this run's live and query sessions in it go first.
            foreach (var session in sessions) await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(session), json), json);
            sessions.Clear();
            await Disconnect();
            await Connect();
            var rcsi = await Sql("ALTER DATABASE " + Bracket(database) + " SET READ_COMMITTED_SNAPSHOT ON WITH ROLLBACK IMMEDIATE;", "master");
            check(rcsi.Status == "completed", "the scratch live database turns READ_COMMITTED_SNAPSHOT on: " + rcsi.Error);
            await OutOfOrderAsync(check, liveService, database, Subscribe, Stop, Sql);
            await StartAsync(check, liveService, database, Subscribe, Stop, text => Sql(text, database), json);
        }
        finally
        {
            foreach (var session in sessions)
            {
                await Sql("IF @@TRANCOUNT > 0 ROLLBACK;", "master", session);
                await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(session), json), json);
            }
            liveService.Dispose();
            await Disconnect();
            await Connect();
            await scratch.DisposeAsync();
            await Disconnect();
        }
    }

    private static string Bracket(string name) => "[" + name.Replace("]", "]]") + "]";

    private static LiveSample? SampleOf(LiveTickEvent tick, string probe) => tick.Samples.FirstOrDefault(sample => sample.Probe == probe);

    /// <summary>Two tables from one batch, with SQL Server's own display text; a diff and tracking across revisions; facets; and
    /// a statement that fails (a division by zero) naming its table while the other arrives.</summary>
    private static async Task SnapshotAsync(Action<bool, string> check, LiveService live, Func<string, int, (Task<LiveEnd> Task, LiveRecorder Recorder, string Id)> subscribe,
        Func<(Task<LiveEnd>, LiveRecorder, string), Task<LiveEnd>> stop, Func<string, Task<SqlRun>> sql, JsonSerializerOptions json)
    {
        var view = subscribe(ItemsProbe, 1000);
        try
        {
            await view.Recorder.WaitAsync(recorder => recorder.Ticks.Count >= 1, 20_000);
            var first = view.Recorder.Ticks.FirstOrDefault();
            var items = first is null ? null : SampleOf(first, ItemsProbe);
            check(view.Recorder.Opened is { Isolation: "readUncommitted", Spid: > 0, Probes: [{ State: "ok" }] } && items?.Tables is [{ Table: 0 } table0, { Table: 1 } table1]
                && table0.Facets is [{ Column: "label", Values: [{ Text: "red", Count: 2 }, { Text: "blue", Count: 1 }] }]
                && LiveResultChecks.RowsOf(live.Store, table0.Descriptor) is [["1", "red", "10", "2026-10-08 12:34:56.123"], ["2", "blue", "20", _], ["3", "red", "30", _]]
                && LiveResultChecks.RowsOf(live.Store, table1.Descriptor) is [["1", "10"], ["2", "5"], ["3", "3"]],
                "a SQL snapshot probe stores two tables from one batch, each cell as a query shows it (datetime2(3) with its scale), with the facets of the whole table: "
                + string.Join(" | ", first?.Errors?.Select(error => error.Code + " " + error.Message) ?? []));

            // Paused while the server changes, so the next revision sees all of the change and nothing samples half of it.
            live.Update(new LiveUpdateArgs(view.Id, Source, Paused: true, Track: [new LiveTrackArgs(ItemsProbe, 0, 4, ["2", "9"])]), json);
            await Task.Delay(300);
            await sql("DELETE dbo.VariaLiveItems WHERE id = 1; UPDATE dbo.VariaLiveItems SET amount = 25 WHERE id = 2; INSERT dbo.VariaLiveItems VALUES (4, N'green', 40);");
            var seen = view.Recorder.Ticks.Count;
            live.Update(new LiveUpdateArgs(view.Id, Source, Paused: false), json);
            await view.Recorder.WaitAsync(recorder => recorder.Ticks.Skip(seen).Any(tick => SampleOf(tick, ItemsProbe)?.Tables?.FirstOrDefault()?.Tracked is { Seq: 4 }), 20_000);
            var changed = view.Recorder.Ticks.Skip(seen).Select(tick => SampleOf(tick, ItemsProbe)?.Tables?.FirstOrDefault()).FirstOrDefault(table => table?.Tracked is { Seq: 4 });
            check(changed is { Diff: { Added: 1, Removed: 1, Changed: 1 }, Tracked.Rows: [0, -1] },
                "the next revision's diff counts the row the server added, removed and changed, and a tracked key finds its row (−1 when gone)");

            await sql("INSERT dbo.VariaLiveItems VALUES (5, N'zero', 0);");
            seen = view.Recorder.Ticks.Count;
            live.Update(new LiveUpdateArgs(view.Id, Source, Refresh: true), json);
            await view.Recorder.WaitAsync(recorder => recorder.Ticks.Skip(seen).Any(tick => tick.Errors is not null), 20_000);
            var failed = view.Recorder.Ticks.Skip(seen).FirstOrDefault(tick => tick.Errors is not null);
            check(failed is { Errors: [{ Code: "SQL_ERROR", Number: 8134, Tables: [1], Terminal: false }] } && SampleOf(failed, ItemsProbe)?.Tables is [{ Table: 0, Descriptor.RowsAvailable: 4 }],
                "one statement of a probe's batch that fails names its table, and the table read before it still arrives: "
                + string.Join(" | ", failed?.Errors?.Select(error => error.Code + " " + error.Number + " " + string.Join(",", error.Tables ?? [])) ?? []));
            await sql("DELETE dbo.VariaLiveItems WHERE id = 5;");
        }
        finally { await stop(view); }
    }

    private static async Task<long> InsertAsync(Func<string, string, string?, Task<SqlRun>> sql, string database, string text, string? session = null) =>
        long.Parse((await sql("INSERT dbo.VariaLiveLog (level, message) VALUES (1, N'" + text + "'); SELECT CONVERT(bigint, SCOPE_IDENTITY());", database, session)).Scalar!, CultureInfo.InvariantCulture);

    private static List<long> Ids(LiveService live, LiveTickEvent tick) =>
        SampleOf(tick, LogProbe)?.Append?.FirstOrDefault() is { } append ? [.. LiveResultChecks.RowsOf(live.Store, append.Descriptor).Where(row => row[0] is not null).Select(row => long.Parse(row[0]!, CultureInfo.InvariantCulture))] : [];

    /// <summary>Another session's uncommitted insert: under READ COMMITTED (READ_COMMITTED_SNAPSHOT off) the tail waits on its
    /// lock and reports BLOCKED (1222) while the view keeps ticking, then appends the row once it commits; under READ
    /// UNCOMMITTED it reads through at once.</summary>
    private static async Task BlockedAsync(Action<bool, string> check, LiveService live, string database, Func<string, int, (Task<LiveEnd> Task, LiveRecorder Recorder, string Id)> subscribe,
        Func<(Task<LiveEnd>, LiveRecorder, string), Task<LiveEnd>> stop, Func<string, string, string?, Task<SqlRun>> sql)
    {
        var holder = Guid.NewGuid().ToString();
        var committedFirst = await InsertAsync(sql, database, "before");
        await sql("BEGIN TRANSACTION;", database, holder);
        var held = await InsertAsync(sql, database, "held", holder);
        live.TestSql = live.TestSql! with { ReadCommitted = true };
        var view = subscribe(LogProbe, 2000);
        try
        {
            var blocked = await view.Recorder.WaitAsync(recorder => recorder.Ticks.Count(tick => tick.Errors is not null) >= 2, 20_000);
            var errors = view.Recorder.Ticks.SelectMany(tick => tick.Errors ?? []).ToList();
            check(view.Recorder.Opened?.Isolation == "readCommitted" && blocked && errors.Take(2).All(error => error is { Code: "BLOCKED", Number: 1222, Terminal: false }) && !view.Task.IsCompleted,
                "a READ COMMITTED tail that waits on another session's uncommitted insert reports BLOCKED (1222 after LOCK_TIMEOUT) and keeps ticking: "
                + string.Join(", ", errors.Take(2).Select(error => error.Code + " " + error.Number)));
            await sql("COMMIT;", database, holder);
            var before = view.Recorder.Ticks.Count;
            var appended = await view.Recorder.WaitAsync(recorder => recorder.Ticks.Skip(before).Any(tick => Ids(live, tick).Contains(held)), 30_000);
            var ids = view.Recorder.Ticks.Skip(before).Select(tick => Ids(live, tick)).LastOrDefault(list => list.Count > 0) ?? [];
            check(appended && ids.Contains(committedFirst) && ids.Count(id => id == held) == 1, "once the writer commits, the tail appends its row, once: " + string.Join(",", ids));
        }
        finally { await stop(view); }

        await sql("BEGIN TRANSACTION;", database, holder);
        var dirty = await InsertAsync(sql, database, "dirty", holder);
        live.TestSql = live.TestSql with { ReadCommitted = false };
        view = subscribe(LogProbe, 2000);
        try
        {
            var read = await view.Recorder.WaitAsync(recorder => recorder.Ticks.Any(tick => Ids(live, tick).Contains(dirty)), 20_000);
            check(view.Recorder.Opened?.Isolation == "readUncommitted" && read && view.Recorder.Ticks.All(tick => tick.Errors is null),
                "a READ UNCOMMITTED tail reads through another session's uncommitted insert without waiting");
        }
        finally
        {
            await stop(view);
            await sql("ROLLBACK;", database, holder);
        }
    }

    /// <summary>With READ_COMMITTED_SNAPSHOT: one session holds an insert (a lower id) uncommitted while another commits a
    /// higher one. The tail sees the higher id first, never waits, and appends the lower one once it commits, exactly once.</summary>
    private static async Task OutOfOrderAsync(Action<bool, string> check, LiveService live, string database, Func<string, int, (Task<LiveEnd> Task, LiveRecorder Recorder, string Id)> subscribe,
        Func<(Task<LiveEnd>, LiveRecorder, string), Task<LiveEnd>> stop, Func<string, string, string?, Task<SqlRun>> sql)
    {
        var slow = Guid.NewGuid().ToString();
        live.TestSql = live.TestSql! with { ReadCommitted = true };
        var view = subscribe(LogProbe, 1000);
        try
        {
            await view.Recorder.WaitAsync(recorder => recorder.Ticks.Count >= 1, 20_000);
            await sql("BEGIN TRANSACTION;", database, slow);
            var lower = await InsertAsync(sql, database, "slow writer", slow);
            var higher = await InsertAsync(sql, database, "fast writer");
            var before = view.Recorder.Ticks.Count;
            var sawHigher = await view.Recorder.WaitAsync(recorder => recorder.Ticks.Skip(before).Any(tick => Ids(live, tick).Contains(higher)), 20_000);
            var early = view.Recorder.Ticks.Skip(before).Select(tick => Ids(live, tick)).LastOrDefault(list => list.Count > 0) ?? [];
            await sql("COMMIT;", database, slow);
            var sawLower = await view.Recorder.WaitAsync(recorder => recorder.Ticks.Skip(before).Any(tick => Ids(live, tick).Contains(lower)), 20_000);
            var more = await InsertAsync(sql, database, "after");
            await view.Recorder.WaitAsync(recorder => recorder.Ticks.Skip(before).Any(tick => Ids(live, tick).Contains(more)), 20_000);
            var ids = view.Recorder.Ticks.Select(tick => Ids(live, tick)).Last(list => list.Count > 0);
            check(view.Recorder.Opened?.Isolation == "readCommitted" && sawHigher && !early.Contains(lower) && sawLower && ids.Count == ids.Distinct().Count()
                && ids.IndexOf(lower) > ids.IndexOf(higher) && ids.Contains(more) && view.Recorder.Ticks.All(tick => tick.Errors is null),
                "with READ_COMMITTED_SNAPSHOT, ids committed out of order arrive without waiting: the higher first, the lower once it commits, each exactly once: " + string.Join(",", ids));
        }
        finally
        {
            await stop(view);
            await sql("IF @@TRANCOUNT > 0 ROLLBACK;", database, slow);
        }
    }

    /// <summary>A tail start: the last rows after a note row naming the rows left out; then a restart filter starts the table
    /// again with only the matching rows, retiring what it had.</summary>
    private static async Task StartAsync(Action<bool, string> check, LiveService live, string database, Func<string, int, (Task<LiveEnd> Task, LiveRecorder Recorder, string Id)> subscribe,
        Func<(Task<LiveEnd>, LiveRecorder, string), Task<LiveEnd>> stop, Func<string, Task<SqlRun>> sql, JsonSerializerOptions json)
    {
        var count = (await sql("SELECT COUNT_BIG(*) FROM dbo.VariaLiveLog;")).Scalar;
        live.TestSql = live.TestSql! with { ReadCommitted = false, Start = new LiveStart("tail", 2) };
        var view = subscribe(LogProbe, 1000);
        try
        {
            await view.Recorder.WaitAsync(recorder => recorder.Ticks.Count >= 1, 20_000);
            var first = SampleOf(view.Recorder.Ticks[0], LogProbe)?.Append?.FirstOrDefault();
            var rows = first is null ? [] : LiveResultChecks.RowsOf(live.Store, first.Descriptor);
            var earlier = long.Parse(count!, CultureInfo.InvariantCulture) - 2;
            check(rows.Count == 3 && rows[0] is [null, null, { } note] && note == LiveStart.Note(earlier) && rows.Skip(1).All(row => row[0] is not null),
                "a tail start shows the last rows after a note row that says how many earlier rows are left out: " + string.Join(" | ", rows.Select(row => string.Join(",", row))));
            live.Update(new LiveUpdateArgs(view.Id, Source, Probes: [new LiveProbeArgs(LogProbe, Filter: new LiveFilterArgs("writer"))]), json);
            var seen = view.Recorder.Ticks.Count;
            await view.Recorder.WaitAsync(recorder => recorder.Ticks.Skip(seen).Any(tick => SampleOf(tick, LogProbe)?.Append?.FirstOrDefault()?.Restarted == true), 20_000);
            var restarted = view.Recorder.Ticks.Skip(seen).Select(tick => SampleOf(tick, LogProbe)?.Append?.FirstOrDefault()).FirstOrDefault(append => append?.Restarted == true);
            var filtered = restarted is null ? [] : LiveResultChecks.RowsOf(live.Store, restarted.Descriptor);
            check(restarted is { Retired.Length: >= 1 } && filtered.Count == 2 && filtered.All(row => row[2]!.EndsWith("writer", StringComparison.Ordinal)),
                "a new restart filter starts the tail again in SQL (the LIKE pattern a parameter), retiring the segment it had: " + string.Join(" | ", filtered.Select(row => string.Join(",", row))));
        }
        finally
        {
            await stop(view);
            live.TestSql = live.TestSql with { Start = null };
        }
    }
}
