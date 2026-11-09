using Microsoft.Data.SqlClient;
using Varia.Backend.Activity;
using Varia.Backend.Explorer;
using Varia.Backend.Live;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the query statistics probe (Recent Expensive Queries): per-statement totals kept between samples
/// within queryDeltaKeys (the one seen least recently dropped first), grouping by query_hash with rates over the window, a
/// first sample without rates, the text cache filled textBatch per statement and textBatchesPerTick statements per sample, and
/// the reader's statements and parameters. Results are built by hand, as the statements return them.</summary>
internal static class ActivityQueryChecks
{
    private static readonly ActivityCatalog Catalog = ActivityCatalog.Current;
    private static readonly DateTime Noon = new(2026, 11, 9, 12, 0, 0, DateTimeKind.Unspecified);
    private static readonly ActivityRender Render = new(17, "box", TotalSpills: true);

    public static void Run(Action<bool, string> check)
    {
        Deltas(check);
        Texts(check);
        Grouping(check);
        Batching(check);
        Reader(check);
    }

    private static ActivityStatement Statement(string id, ActivityRender? render = null) =>
        ActivitySql.Statements(ActivityReader.QueriesProbe, render ?? Render).Single(statement => statement.Id == id);

    private static ActivityResult Result(ActivityStatement statement, IEnumerable<Dictionary<string, object?>> rows) =>
        new(statement.Columns, [.. rows.Select(row => statement.Columns.Select(column => row.GetValueOrDefault(column)).ToArray())]);

    private static byte[] Bytes(int value, int length = 8)
    {
        var bytes = new byte[length];
        BitConverter.GetBytes(value).CopyTo(bytes, 0);
        return bytes;
    }

    /// <summary>A stats row: statement <paramref name="id"/> of query hash <paramref name="hash"/> under plan <paramref name="plan"/>,
    /// with totals scaled from its executions (each 10 ms of CPU, 20 ms elapsed, 100 logical reads, 2 physical, 1 write, 5 rows,
    /// 1,024 KB of grant, 3 spilled pages).</summary>
    private static Dictionary<string, object?> Row(int id, int hash, long executions, int plan = 1, DateTime? created = null, DateTime? lastRun = null, long cpuEach = 10_000) => new()
    {
        ["query_hash"] = Bytes(hash), ["query_plan_hash"] = Bytes(plan), ["sql_handle"] = Bytes(id, 44), ["plan_handle"] = Bytes(id * 100 + plan, 64),
        ["statement_start_offset"] = 0, ["statement_end_offset"] = -1, ["creation_time"] = created ?? Noon.AddHours(-1), ["last_execution_time"] = lastRun ?? Noon,
        ["execution_count"] = executions, ["total_worker_time"] = executions * cpuEach, ["total_elapsed_time"] = executions * 20_000, ["total_logical_reads"] = executions * 100,
        ["total_physical_reads"] = executions * 2, ["total_logical_writes"] = executions, ["total_rows"] = executions * 5, ["total_grant_kb"] = executions * 1_024,
        ["max_elapsed_time"] = 50_000L, ["total_spills"] = executions * 3
    };

    private static string? Cell(ActivityQueryRows rows, LiveRow row, string column) => rows.Writer.Reader(row)(column);

    private static void Deltas(Action<bool, string> check)
    {
        var deltas = new QueryDeltas(3);
        var created = Noon.AddHours(-1);
        foreach (var key in new[] { "a", "b", "c" }) deltas.Apply(key, [1, 10], created, whole: false);
        var changed = deltas.Apply("b", [3, 40], created, whole: false);
        deltas.Apply("d", [1, 1], created, whole: false);
        check(changed is [2, 30] && deltas.Count == 3 && !deltas.Contains("a") && deltas.Contains("b") && deltas.Contains("c") && deltas.Contains("d"),
            "a statement's change is measured from its kept totals, and past queryDeltaKeys the statement seen least recently goes first (a, not b, which was just seen)");
        var recached = deltas.Apply("c", [5, 50], created.AddMinutes(30), whole: false);
        var fell = deltas.Apply("d", [0, 0], created, whole: false);
        var cachedInWindow = deltas.Apply("e", [4, 8], Noon, whole: true);
        check(recached is null && fell is null && cachedInWindow is [4, 8] && deltas.Apply("e", [6, 9], Noon, whole: true) is [2, 1],
            "a plan cached again or totals that went down start again (no change known), a plan cached within the window counts whole, and then from its kept totals");
        check(Catalog.Limit("queryDeltaKeys") == 20_000 && Catalog.Limit("textCache") == 2_000 && Catalog.Limit("textBatch") == ActivitySql.TextSlots && ActivityQueryRows.FirstLookback == TimeSpan.FromMinutes(10),
            "the statements kept, the text cache and the text statement's slots come from the catalogue's limits, and a first sample reads the last 10 minutes (as docs/activity-monitor.md says)");
    }

    private static void Texts(Action<bool, string> check)
    {
        var texts = new QueryTexts(2);
        texts.Set("a", new("SELECT 1", "db"));
        texts.Set("b", new("SELECT 2", "db"));
        texts.Get("a");
        texts.Set("c", new(null, null));
        check(texts.Count == 2 && texts.Get("a")?.Statement == "SELECT 1" && texts.Get("b") is null && texts.Get("c") is { Statement: null },
            "the text cache keeps textCache texts, dropping the one used least recently, and keeps a text SQL Server no longer has as null so it is not asked for again");
    }

    private static void Grouping(Action<bool, string> check)
    {
        var stats = Statement("stats");
        var rows = new ActivityQueryRows(Catalog);
        // First sample: hash 7 has two statements (two plans), hash 8 one; no window, so no rates.
        var since = rows.Since(Noon);
        var first = rows.Apply(Result(stats, [Row(1, 7, 10, plan: 1), Row(2, 7, 10, plan: 2), Row(3, 8, 100)]), 0, Noon, spills: true);
        var firstRows = rows.Rows(first);
        check(since == Noon - ActivityQueryRows.FirstLookback && first.WindowMs is null && firstRows.Count == 2 && Cell(rows, firstRows[0], "queryHash") == "0x0800000000000000"
            && firstRows.All(row => Cell(rows, row, "cpuRate") is null && Cell(rows, row, "executionsPerMinute") is null && Cell(rows, row, "spills") is null)
            && Cell(rows, firstRows[1], "avgCpuMs") == "10.0" && Cell(rows, firstRows[1], "planCount") == "2" && Cell(rows, firstRows[1], "query") == ActivityQueryRows.Loading,
            "a first sample reads the last 10 minutes and shows its groups by their plans' total CPU with no rate (blank, not zero), per-execution values from the totals, and Loading text… until the texts arrive");

        // 30 s later: hash 7's statements ran 30 and 0 more times, hash 8 not at all; a plan of hash 9 was cached in the window,
        // and a statement of hash 10 that the kept totals never saw ran in it, from an old plan.
        var later = Noon.AddSeconds(30);
        var second = rows.Since(later);
        var window = rows.Apply(Result(stats,
        [
            Row(1, 7, 40, plan: 1, lastRun: later), Row(2, 7, 10, plan: 2), Row(3, 8, 100), Row(4, 9, 6, created: Noon.AddSeconds(10), lastRun: later, cpuEach: 1_000_000),
            Row(5, 10, 1_000, created: Noon.AddHours(-2), lastRun: later)
        ]), 30_000, later, spills: true);
        var shown = rows.Rows(window);
        string? Of(string hash, string column) => shown.Where(row => Cell(rows, row, "queryHash") == hash).Select(row => Cell(rows, row, column)).SingleOrDefault();
        const string Seven = "0x0700000000000000", Nine = "0x0900000000000000";
        check(second == Noon.AddSeconds(-30) && window.WindowMs == 30_000 && shown.Select(row => Cell(rows, row, "queryHash")).SequenceEqual([Nine, Seven]),
            "a later sample reads from one window before the previous one, shows only the groups that ran in the window, most CPU first, and leaves out a statement it has no totals for (counted from its next run): "
            + string.Join(",", shown.Select(row => Cell(rows, row, "queryHash"))));
        // Hash 7: 30 executions in 30 s, 300 ms of CPU: 60/min, 10 ms/s, 100 logical reads/s.
        check(Of(Seven, "executionsPerMinute") == "60.0" && Of(Seven, "cpuRate") == "10.0" && Of(Seven, "avgCpuMs") == "10.0" && Of(Seven, "logicalReadsRate") == "100.0"
            && Of(Seven, "physicalReadsRate") == "2.0" && Of(Seven, "logicalWritesRate") == "1.0" && Of(Seven, "averageDurationMs") == "20.0" && Of(Seven, "rowsPerExecution") == "5.0"
            && Of(Seven, "avgGrantKb") == "1024.0" && Of(Seven, "spills") == "90" && Of(Seven, "planCount") == "2" && Of(Seven, "maxDurationMs") == "50.0"
            && Of(Seven, "lastExecution") is { } last && last.StartsWith("2026-11-09 12:00:30", StringComparison.Ordinal),
            "a group's values are its statements' changes summed and divided by the window: executions per minute, CPU ms/s, reads and writes per second, per-execution averages, spilled pages: "
            + string.Join(" ", rows.Writer.Spec.Columns.Select(column => column.Id + "=" + Of(Seven, column.Id))));
        check(Of(Nine, "executionsPerMinute") == "12.0" && Of(Nine, "cpuRate") == "200.0",
            "a plan cached since the previous sample counts whole: its 6 executions are the window's");

        // Without total_spills the column stays blank.
        var plain = new ActivityQueryRows(Catalog);
        var plainStats = Statement("stats", Render with { TotalSpills = false });
        plain.Apply(Result(plainStats, [Row(1, 7, 1)]), 0, Noon, spills: false);
        var noSpills = plain.Rows(plain.Apply(Result(plainStats, [Row(1, 7, 2, lastRun: later)]), 30_000, later, spills: false));
        check(noSpills is [var only] && Cell(plain, only, "spills") is null && Cell(plain, only, "cpuRate") is not null, "without total_spills the Spills column is blank, never zero");

        // A reset (baseline, resume, restart) starts again as a first sample.
        rows.Reset();
        var again = rows.Apply(Result(stats, [Row(1, 7, 50, lastRun: later)]), 60_000, later, spills: true);
        check(again.WindowMs is null && rows.Since(later) == later && rows.Baselines == 1, "after a reset the next sample is a first sample again, its baselines only what it read");
    }

    private static void Batching(Action<bool, string> check)
    {
        var stats = Statement("stats");
        var text = Statement("text");
        var rows = new ActivityQueryRows(Catalog);
        var many = Enumerable.Range(1, 260).Select(id => Row(id, id, id)).ToList();
        var sample = rows.Apply(Result(stats, many), 0, Noon, spills: true);
        var batches = rows.TextBatches(sample);
        var shownCap = (int)Catalog.Limit("shownHashes");
        var perTick = (int)(Catalog.Limit("textBatch") * Catalog.Limit("textBatchesPerTick"));
        check(sample.Shown.Count == shownCap && sample.More == 260 - shownCap && batches.Count == Catalog.Limit("textBatchesPerTick") && batches.All(batch => batch.Length == Catalog.Limit("textBatch"))
            && batches.SelectMany(batch => batch).Select(request => request.Statement.Hash).SequenceEqual(sample.Shown.Take(perTick).Select(group => group.Hash)),
            "at most shownHashes rows (the rest counted as cut), and their missing texts asked for most expensive first, textBatch per text statement and textBatchesPerTick statements per sample");

        // Slot values: each slot's handles and offsets, the unused ones NULL.
        var partial = new[] { batches[0][0], batches[0][1] };
        var values = ActivityQueryRows.TextValues(partial);
        var filled = text.Parameters.ToDictionary(parameter => parameter.Name, values);
        check(filled["@h0"] is byte[] { Length: 44 } && filled["@p1"] is byte[] { Length: 64 } && filled["@s0"] is 0 && filled["@e1"] is -1 && filled["@h2"] == DBNull.Value && filled["@p49"] == DBNull.Value,
            "the text statement's slots carry each statement's sql_handle, plan_handle and offsets as parameters, and the unused slots pass NULL handles");

        // Two batches arrive; the next sample asks only for the rest. A row whose text arrived shows it, one-lined.
        foreach (var batch in batches.Take(2))
            rows.AddTexts(batch, Result(text, batch.Select(request => new Dictionary<string, object?> { ["slot"] = request.Slot, ["statement_text"] = "SELECT\n  " + request.Statement.Hash, ["database_name"] = "Sales" })));
        var next = rows.Apply(Result(stats, many), 0, Noon, spills: true);
        var rest = rows.TextBatches(next);
        var built = rows.Rows(next);
        check(rest.Count == 2 && rows.Texts == 100 && built.Count(row => Cell(rows, row, "query") == ActivityQueryRows.Loading) == shownCap - 100
            && Cell(rows, built[0], "query") == "SELECT " + Cell(rows, built[0], "queryHash") && Cell(rows, built[0], "database") == "Sales",
            "texts that arrived are cached and not asked for again; their rows show the statement on one line and its database, and the rest still say Loading text…");
        // A slot the statement did not return (no handle) is kept empty, not asked for again.
        rows.AddTexts(rest[0], Result(text, []));
        check(rows.TextBatches(next).Count == 1 && rows.Rows(next).Count(row => Cell(rows, row, "query") is null) == 50,
            "a text SQL Server no longer has stays blank and is not asked for again");
    }

    private sealed class NoHost : ILiveHost
    {
        public bool TestHooks => false;
        public bool IsConnected(string connectionId) => false;
        public string? ServerOf(string connectionId) => null;
        public Varia.Backend.Results.ResultStore Store => throw new NotSupportedException();
        public ServerProfile? Profile(string connectionId) => null;
        public SqlConnection PoolConnection(string connectionId, string? database, string suffix) => throw new NotSupportedException();
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => throw new NotSupportedException();
    }

    private static void Reader(Action<bool, string> check)
    {
        var ran = new List<(string Id, IReadOnlyDictionary<string, object> Values)>();
        var local = Noon;
        long ticks = 10_000;
        var stats = new List<Dictionary<string, object?>>();
        Task<ActivityResult> Run(ActivityStatement statement, IReadOnlyDictionary<string, object> values)
        {
            ran.Add((statement.Id, values));
            IEnumerable<Dictionary<string, object?>> rows = statement.Id switch
            {
                "capabilities" => [new() { ["spid"] = 99, ["server_state"] = 1, ["alter_any_connection"] = 0, ["view_any_definition"] = 0, ["spills"] = 1 }],
                "clock" => [new() { ["ms_ticks"] = ticks, ["sqlserver_start_time_ms_ticks"] = 1L, ["server_local_time"] = local }],
                "stats" => stats,
                "text" => Enumerable.Range(0, ActivitySql.TextSlots).Where(slot => values[$"@h{slot}"] is byte[])
                    .Select(slot => new Dictionary<string, object?> { ["slot"] = slot, ["statement_text"] = "SELECT 1", ["database_name"] = "master" }),
                _ => []
            };
            return Task.FromResult(Result(statement, rows));
        }
        var reader = new ActivityReader(new NoHost(), "c") { TestRun = Run };
        var spec = LiveCatalog.Current.Probes[ActivityReader.QueriesProbe];
        var box = new ServerProfile(17, "17.0.1000.0", 3, "app_user", false, true, false);
        check(reader.Unavailable(spec, box) is null, "the query statistics probe runs on a box server (it is no longer pending)");
        using var connection = new SqlConnection();
        reader.SessionAsync(connection, "", "VIEW SERVER PERFORMANCE STATE", CancellationToken.None).GetAwaiter().GetResult();
        LiveReaderSample Read(string? gap = null)
        {
            var due = new LiveDue(new LiveProbeState(spec, 30_000), gap, null, null, null, new Dictionary<int, LiveTrackArgs>(), TakenAt: ticks);
            return reader.ReadAsync(connection, "", due, null, CancellationToken.None).GetAwaiter().GetResult();
        }
        stats.AddRange(Enumerable.Range(1, 120).Select(id => Row(id, id, 10)));
        ran.Clear();
        var first = Read("baseline");
        var statsRun = ran.Single(entry => entry.Id == "stats").Values;
        var table = first.Tables.SingleOrDefault();
        check(first is { Sampled: true, Raw: null, Errors: [] } && table is { Table: 0, More: 0 } && table.Rows.Count == 120
            && ran.Select(entry => entry.Id).SequenceEqual(["clock", "stats", "text", "text", "text"])
            && statsRun["@rowCap"] is int cap && cap == Catalog.Limit("queryStatsRows") + 1 && statsRun["@since"] is DateTime since && since == Noon - ActivityQueryRows.FirstLookback,
            "the reader runs the clock, then the stats from the last 10 minutes (capped at queryStatsRows plus one), then one text statement per batch of the shown rows' missing texts: "
            + string.Join(",", ran.Select(entry => entry.Id)));

        // 30 s later: one statement ran 20 more times; the texts are cached, so no text statement runs.
        ticks += 30_000;
        local = Noon.AddSeconds(30);
        stats.Clear();
        stats.Add(Row(5, 5, 30, lastRun: local));
        ran.Clear();
        var second = Read();
        var rows = second.Tables.Single().Rows;
        var cpu = rows.Count == 1 ? rows[0].Cells[spec.Tables[0].Columns.FindIndex(column => column.Id == "cpuRate")].Text : null;
        check(ran.Select(entry => entry.Id).SequenceEqual(["clock", "stats"]) && ran[1].Values["@since"] is DateTime then && then == Noon.AddSeconds(-30) && cpu == "6.7",
            "the next sample reads from one window before the previous one, rates over the server's 30 s window, and asks for no text it has: " + cpu + " " + string.Join(",", ran.Select(entry => entry.Id)));

        // The filter box narrows the rows in memory.
        reader.Apply(ActivityReader.Check(new(Filters: [new("recentQueries", Text: "no such text")]), Catalog));
        ticks += 30_000;
        local = local.AddSeconds(30);
        stats.Clear();
        stats.Add(Row(5, 5, 40, lastRun: local));
        var filtered = Read().Tables.Single();
        check(filtered.Rows.Count == 1 && filtered.View is { } view && !view(filtered.Rows[0]), "the filter box keeps rows by their text and database in memory, so the SQL never changes");
    }
}
