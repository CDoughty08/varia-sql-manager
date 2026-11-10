using Microsoft.Data.SqlClient;
using Varia.Backend.Activity;
using Varia.Backend.Explorer;
using Varia.Backend.Live;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the query statistics probe (Recent Expensive Queries): per-statement totals kept between samples
/// within queryDeltaKeys (the one seen least recently dropped first, and none charged across a cut sample), grouping by
/// query_hash with rates over the window, a first sample without rates, plan facts from every kept statement, the text cache
/// filled textBatch per statement and textBatchesPerTick statements per sample, and the reader's statements, parameters,
/// refused texts and filter box. Results are built by hand, as the statements return them.</summary>
internal static class ActivityQueryChecks
{
    private static readonly ActivityCatalog Catalog = ActivityCatalog.Current;
    private static readonly DateTime Noon = new(2026, 11, 9, 12, 0, 0, DateTimeKind.Unspecified);
    private static readonly ActivityRender Render = new(17, "box", TotalSpills: true);

    public static void Run(Action<bool, string> check)
    {
        Statements(check);
        Deltas(check);
        Texts(check);
        Grouping(check);
        Cuts(check);
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
    private static Dictionary<string, object?> Row(int id, int hash, long executions, int plan = 1, DateTime? created = null, DateTime? lastRun = null, long cpuEach = 10_000, long maxElapsed = 50_000) => new()
    {
        ["query_hash"] = Bytes(hash), ["query_plan_hash"] = Bytes(plan), ["sql_handle"] = Bytes(id, 44), ["plan_handle"] = Bytes(id * 100 + plan, 64),
        ["statement_start_offset"] = 0, ["statement_end_offset"] = -1, ["creation_time"] = created ?? Noon.AddHours(-1), ["last_execution_time"] = lastRun ?? Noon,
        ["execution_count"] = executions, ["total_worker_time"] = executions * cpuEach, ["total_elapsed_time"] = executions * 20_000, ["total_logical_reads"] = executions * 100,
        ["total_physical_reads"] = executions * 2, ["total_logical_writes"] = executions, ["total_rows"] = executions * 5, ["total_grant_kb"] = executions * 1_024,
        ["max_elapsed_time"] = maxElapsed, ["total_spills"] = executions * 3
    };

    private static string? Cell(ActivityQueryRows rows, LiveRow row, string column) => rows.Writer.Reader(row)(column);

    private static void Statements(Action<bool, string> check)
    {
        var text = Statement("stats").Text;
        check(text.Contains("DATEADD(second, CONVERT(int, q.last_elapsed_time / 1000000) + 1, q.last_execution_time) AS last_end", StringComparison.Ordinal)
            && text.Contains("WHERE e.last_end >= @since", StringComparison.Ordinal) && text.Contains("ORDER BY e.last_end DESC", StringComparison.Ordinal)
            && !text.Contains("q.last_execution_time >= @since", StringComparison.Ordinal),
            "the stats statement reads statements by when their last execution ended (its start plus its elapsed time, rounded up), so one that ran longer than a window is read when it ends, and the newest ends survive a cut");
    }

    private static StatementKey Key(int id) => new(Bytes(id, 44), 0, -1, Bytes(id, 64));

    private static QueryStatement Statement(int id, double[] totals, DateTime? created = null, int hash = 1) =>
        new(Key(id), (ulong)hash, 1, created ?? Noon.AddHours(-1), Noon, totals, null);

    private static void Deltas(Action<bool, string> check)
    {
        var deltas = new QueryDeltas(3);
        deltas.Next(cut: false);
        foreach (var id in new[] { 1, 2, 3 }) deltas.Apply(Statement(id, [1, 10]), whole: false);
        deltas.Next(cut: false);
        var changed = deltas.Apply(Statement(2, [3, 40]), whole: false);
        deltas.Apply(Statement(4, [1, 1]), whole: false);
        check(changed is [2, 30] && deltas.Count == 3 && !deltas.Contains(Key(1)) && deltas.Contains(Key(2)) && deltas.Contains(Key(3)) && deltas.Contains(Key(4)),
            "a statement's change is measured from its kept totals, and past queryDeltaKeys the statement seen least recently goes first (1, not 2, which was just seen)");
        var recached = deltas.Apply(Statement(3, [5, 50], Noon.AddMinutes(-30)), whole: false);
        var fell = deltas.Apply(Statement(4, [0, 0]), whole: false);
        var cachedInWindow = deltas.Apply(Statement(5, [4, 8], Noon), whole: true);
        deltas.Next(cut: false);
        check(recached is null && fell is null && cachedInWindow is [4, 8] && deltas.Apply(Statement(5, [6, 9], Noon), whole: true) is [2, 1],
            "a plan cached again or totals that went down start again (no change known), a plan cached within the window counts whole, and then from its kept totals");
        check(Catalog.Limit("queryDeltaKeys") == 20_000 && Catalog.Limit("textCache") == 2_000 && Catalog.Limit("textBatch") == ActivitySql.TextSlots && ActivityQueryRows.FirstLookback == TimeSpan.FromMinutes(10),
            "the statements kept, the text cache and the text statement's slots come from the catalogue's limits, and a first sample reads the last 10 minutes (as docs/activity-monitor.md says)");
        check(new StatementKey(Bytes(7, 44), 2, 40, null).Equals(new StatementKey(Bytes(7, 44), 2, 40, null)) && !Key(7).Equals(new StatementKey(Bytes(7, 44), 0, -1, null))
            && Key(7).GetHashCode() == Key(7).GetHashCode() && QueryStatement.HashText(0x0800000000000000) == "0x0800000000000000",
            "a statement's key compares its handles' bytes and offsets (no hex text kept per statement), and a hash shows as 0x and 16 hex digits");
    }

    private static void Texts(Action<bool, string> check)
    {
        var texts = new LruMap<string, QueryText>(2);
        texts.Set("a", new("SELECT 1", "db"));
        texts.Set("b", new("SELECT 2", "db"));
        texts.TryGet("a", out _);
        texts.Set("c", new(null, null));
        check(texts.Count == 2 && texts.TryGet("a", out var a) && a.Statement == "SELECT 1" && !texts.Contains("b") && texts.TryGet("c", out var c) && c.Statement is null,
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

        // 30 s later: hash 7's first statement ran 30 more times (its second did not run, so the stats statement does not read
        // it), hash 8 not at all; a plan of hash 9 was cached in the window, and a statement of hash 10 that the kept totals never
        // saw ran in it, from an old plan.
        var later = Noon.AddSeconds(30);
        var second = rows.Since(later);
        var window = rows.Apply(Result(stats,
        [
            Row(1, 7, 40, plan: 1, lastRun: later, maxElapsed: 30_000), Row(4, 9, 6, created: Noon.AddSeconds(10), lastRun: later, cpuEach: 1_000_000),
            Row(5, 10, 1_000, created: Noon.AddHours(-2), lastRun: later)
        ]), 30_000, later, spills: true);
        var shown = rows.Rows(window);
        string? Of(string hash, string column) => shown.Where(row => Cell(rows, row, "queryHash") == hash).Select(row => Cell(rows, row, column)).SingleOrDefault();
        const string Seven = "0x0700000000000000", Nine = "0x0900000000000000";
        check(second == Noon - ActivityQueryRows.Overlap && window.WindowMs == 30_000 && shown.Select(row => Cell(rows, row, "queryHash")).SequenceEqual([Nine, Seven]),
            "a later sample reads from the previous one's clock (less a small overlap), shows only the groups that ran in the window, most CPU first, and leaves out a statement it has no totals for (counted from its next run): "
            + string.Join(",", shown.Select(row => Cell(rows, row, "queryHash"))));
        // Hash 7: 30 executions in 30 s, 300 ms of CPU: 60/min, 10 ms/s, 100 logical reads/s.
        check(Of(Seven, "executionsPerMinute") == "60.0" && Of(Seven, "cpuRate") == "10.0" && Of(Seven, "avgCpuMs") == "10.0" && Of(Seven, "logicalReadsRate") == "100.0"
            && Of(Seven, "physicalReadsRate") == "2.0" && Of(Seven, "logicalWritesRate") == "1.0" && Of(Seven, "averageDurationMs") == "20.0" && Of(Seven, "rowsPerExecution") == "5.0"
            && Of(Seven, "avgGrantKb") == "1024.0" && Of(Seven, "spills") == "90"
            && Of(Seven, "lastExecution") is { } last && last.StartsWith("2026-11-09 12:00:30", StringComparison.Ordinal),
            "a group's values are its statements' changes summed and divided by the window: executions per minute, CPU ms/s, reads and writes per second, per-execution averages, spilled pages: "
            + string.Join(" ", rows.Writer.Spec.Columns.Select(column => column.Id + "=" + Of(Seven, column.Id))));
        check(Of(Seven, "planCount") == "2" && Of(Seven, "maxDurationMs") == "50.0" && Of(Seven, "cachedSince") is { } cached && cached.StartsWith("2026-11-09 11:00:00", StringComparison.Ordinal),
            "Plan Count, Max Duration and Cached Since come from every kept statement of the query, not only those that ran in the window (the second plan, idle now, still counts): "
            + Of(Seven, "planCount") + " " + Of(Seven, "maxDurationMs"));
        check(Of(Nine, "executionsPerMinute") == "12.0" && Of(Nine, "cpuRate") == "200.0",
            "a plan cached since the previous sample counts whole: its 6 executions are the window's");

        // A login that may not read the texts: rows without one are blank, not loading; the filter box never matches the
        // placeholder.
        var refused = rows.Rows(window, textsRefused: true);
        check(refused.All(row => Cell(rows, row, "query") is null), "when the login may not read statement texts a row's text is blank, never Loading text… for ever");
        var loading = rows.Rows(window);
        var filter = ActivityFilter.Compile(Catalog, new("recentQueries", Text: "load"));
        check(loading.All(row => Cell(rows, row, "query") == ActivityQueryRows.Loading) && !loading.Any(row => filter.Matches(rows.FilterCells(row))),
            "the filter box does not match Loading text…, so typing \"load\" keeps no row whose text has not arrived");

        // Without total_spills the column stays blank.
        var plain = new ActivityQueryRows(Catalog);
        var plainStats = Statement("stats", Render with { TotalSpills = false });
        plain.Apply(Result(plainStats, [Row(1, 7, 1)]), 0, Noon, spills: false);
        var noSpills = plain.Rows(plain.Apply(Result(plainStats, [Row(1, 7, 2, lastRun: later)]), 30_000, later, spills: false));
        check(noSpills is [var only] && Cell(plain, only, "spills") is null && Cell(plain, only, "cpuRate") is not null, "without total_spills the Spills column is blank, never zero");

        // A reset (baseline, resume, restart) starts again as a first sample.
        rows.Reset();
        var again = rows.Apply(Result(stats, [Row(1, 7, 50, lastRun: later)]), 60_000, later, spills: true);
        check(again.WindowMs is null && rows.Since(later) == later - ActivityQueryRows.Overlap && rows.Baselines == 1, "after a reset the next sample is a first sample again, its baselines only what it read");
    }

    private static void Cuts(Action<bool, string> check)
    {
        // A sample whose stats rows were cut at queryStatsRows may have missed a statement's run; the next change of a statement it
        // did not read is not charged to one window.
        var stats = Statement("stats");
        var rows = new ActivityQueryRows(Catalog);
        var cap = (int)Catalog.Limit("queryStatsRows");
        rows.Apply(Result(stats, [Row(1, 7, 10), Row(2, 8, 10)]), 0, Noon, spills: true);
        var later = Noon.AddSeconds(30);
        // Statement 1 ran (read); statement 2 ran too, but the cut left it out. Filler rows make the cut.
        var filler = Enumerable.Range(1_000, cap).Select(id => Row(id, id, 1, created: Noon.AddMinutes(-30), lastRun: later));
        var cut = rows.Apply(Result(stats, [Row(1, 7, 20, lastRun: later), .. filler]), 30_000, later, spills: true);
        var after = Noon.AddSeconds(60);
        var next = rows.Rows(rows.Apply(Result(stats, [Row(1, 7, 30, lastRun: after), Row(2, 8, 100, lastRun: after)]), 60_000, after, spills: true));
        string? Rate(string hash) => next.Where(row => Cell(rows, row, "queryHash") == hash).Select(row => Cell(rows, row, "executionsPerMinute")).SingleOrDefault();
        check(cut.More >= 1 && Rate("0x0700000000000000") == "20.0" && Rate("0x0800000000000000") is null,
            "after a cut sample, a statement read in it keeps its rate, while one it left out starts again rather than charging 90 executions to one window: "
            + Rate("0x0700000000000000") + " " + Rate("0x0800000000000000"));
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
            rows.AddTexts(batch, Result(text, batch.Select(request => new Dictionary<string, object?> { ["slot"] = request.Slot, ["statement_text"] = "SELECT\n  " + QueryStatement.HashText(request.Statement.Hash), ["database_name"] = "Sales" })));
        var next = rows.Apply(Result(stats, many), 0, Noon, spills: true);
        var rest = rows.TextBatches(next);
        var built = rows.Rows(next);
        check(rest.Count == 2 && rows.Texts == 100 && built.Count(row => Cell(rows, row, "query") == ActivityQueryRows.Loading) == shownCap - 100
            && Cell(rows, built[0], "query") == "SELECT " + Cell(rows, built[0], "queryHash") && Cell(rows, built[0], "database") == "Sales",
            "texts that arrived are cached and not asked for again; their rows show the statement on one line and its database, and the rest still say Loading text…");
        var sales = ActivityFilter.Compile(Catalog, new("recentQueries", Text: "select"));
        check(built.Count(row => sales.Matches(rows.FilterCells(row))) == 100, "the filter box matches the texts that arrived");
        // A slot the statement did not return (no handle) is kept empty, not asked for again.
        rows.AddTexts(rest[0], Result(text, []));
        check(rows.TextBatches(next).Count == 1 && rows.Rows(next).Count(row => Cell(rows, row, "query") is null) == 50,
            "a text SQL Server no longer has stays blank and is not asked for again");
    }

    private static void Reader(Action<bool, string> check)
    {
        var ran = new List<(string Id, IReadOnlyDictionary<string, object> Values)>();
        var local = Noon;
        long ticks = 10_000;
        var refuseTexts = false;
        var stats = new List<Dictionary<string, object?>>();
        Task<ActivityResult> Run(ActivityStatement statement, IReadOnlyDictionary<string, object> values)
        {
            ran.Add((statement.Id, values));
            if (statement.Id == "text" && refuseTexts) throw ConnectionFailureChecks.Sql(300);
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
        var reader = new ActivityReader(new ActivitySourceChecks.NoHost(), "c") { TestRun = Run };
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
        string? Column(LiveRow row, string column) => row.Cells[spec.Tables[0].Columns.FindIndex(entry => entry.Id == column)].Text;
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
        var cpu = rows.Count == 1 ? Column(rows[0], "cpuRate") : null;
        check(ran.Select(entry => entry.Id).SequenceEqual(["clock", "stats"]) && ran[1].Values["@since"] is DateTime then && then == Noon - ActivityQueryRows.Overlap && cpu == "6.7",
            "the next sample reads from the previous one's clock, rates over the server's 30 s window, and asks for no text it has: " + cpu + " " + string.Join(",", ran.Select(entry => entry.Id)));

        // The filter box narrows the rows in memory.
        reader.Apply(ActivityReader.Check(new(Filters: [new("recentQueries", Text: "no such text")]), Catalog));
        ticks += 30_000;
        local = local.AddSeconds(30);
        stats.Clear();
        stats.Add(Row(5, 5, 40, lastRun: local));
        var filtered = Read().Tables.Single();
        check(filtered.Rows.Count == 1 && filtered.View is { } view && !view(filtered.Rows[0]), "the filter box keeps rows by their text and database in memory, so the SQL never changes");

        // A login refused the text statement: the rows still arrive, their texts blank rather than loading, and the refusal is
        // reported each sample without running the statement again.
        reader.Apply(ActivityReader.Check(new(Filters: [new("recentQueries")]), Catalog));
        refuseTexts = true;
        ticks += 30_000;
        local = local.AddSeconds(30);
        stats.Clear();
        stats.Add(Row(5, 5, 50, lastRun: local));
        stats.Add(Row(900, 900, 5, lastRun: local, created: Noon.AddMinutes(-20)));
        stats.Add(Row(901, 901, 5, lastRun: local, created: local.AddSeconds(-5)));
        ran.Clear();
        var refused = Read();
        var refusedRows = refused.Tables.Single().Rows;
        var textRuns = ran.Count(entry => entry.Id == "text");
        ticks += 30_000;
        local = local.AddSeconds(30);
        stats.Clear();
        stats.Add(Row(902, 902, 5, lastRun: local, created: local.AddSeconds(-5)));
        ran.Clear();
        var again = Read();
        check(refused is { Sampled: true, Errors: [{ Code: "PERMISSION_DENIED" }] } && refusedRows.Any(row => Column(row, "queryHash") == "0x8503000000000000" && Column(row, "query") is null)
            && refusedRows.Any(row => Column(row, "query") == "SELECT 1") && textRuns == 1 && !ran.Any(entry => entry.Id == "text") && again.Errors is [{ Code: "PERMISSION_DENIED" }]
            && again.Tables.Single().Rows is [var lone] && Column(lone, "query") is null,
            "a refused text statement leaves rows without a text blank (never Loading text… for ever), keeps the texts it had, and is reported each sample without running again: "
            + string.Join(",", refusedRows.Select(row => Column(row, "queryHash") + "=" + Column(row, "query"))));
    }
}
