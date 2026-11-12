using System.Diagnostics;
using System.Text.Json;
using Varia.Backend.Protocol;
using Varia.Backend.Results;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the result store: budgets and their truncation reasons, page sealing, the page directory,
/// releases, query events, and results.read / results.close through the protocol host.</summary>
internal static class StoreChecks
{
    private static readonly IReadOnlyList<ResultColumn> W1Columns = [.. SyntheticRows.Columns("W1").Select(column => new ResultColumn(column.Name, column.DataType, column.Wire == WireKind.Text ? "text" : "binary"))];
    private static readonly IReadOnlyList<WireKind> W1Wires = [.. SyntheticRows.Columns("W1").Select(column => column.Wire)];

    private static ResultSetBuffer Open(ResultStore store, QueryBudget query, int index = 0) => store.Open(query, index, 1, 1, "rows", W1Columns, W1Wires)
        ?? throw new InvalidOperationException("The result set was not kept.");

    /// <summary>Ingests synthetic W1 rows as a query would: rows past a failed reservation are counted, not stored.</summary>
    private static void Fill(ResultSetBuffer set, long first, long count)
    {
        for (var row = first; row < first + count; row++)
        {
            set.CountRow();
            if (set.BeginRow() is not { } builder) continue;
            SyntheticRows.WriteCells("W1", row, builder);
            set.TryCommitRow();
        }
    }

    private static int StoredRows(ResultSetBuffer set) => set.PagesFor(0, int.MaxValue).Sum(page => PageReader.Read(page.Body, set.Wires).Rows.Length);

    public static void Run(Action<bool, string> check)
    {
        var low = false;
        var store = new ResultStore(1000, 600, () => (low ? 100 : 0, 50));
        var a = store.BeginQuery("s1");
        var b = store.BeginQuery("s2");
        check(store.TryReserve(a, 500, true, out _) && !store.TryReserve(a, 200, true, out var queryFull) && queryFull == TruncationReason.QueryBudget
            && store.TryReserve(b, 400, false, out _) && !store.TryReserve(b, 200, false, out var globalFull) && globalFull == TruncationReason.GlobalBudget,
            "reservations stop at the query's half of the budget first, then at the global budget");
        low = true;
        check(!store.TryReserve(b, 1, true, out var system) && system == TruncationReason.SystemMemory && store.TryReserve(b, 1, false, out _),
            "high memory load refuses reservations checked at a seal, before any budget");
        check(!new ResultStore(1000, 600).ChecksSystemMemory && !ResultStore.FromSystem(4L << 20).ChecksSystemMemory && ResultStore.FromSystem().ChecksSystemMemory && store.ChecksSystemMemory,
            "only the process's own store watches the machine's memory load: stores built for checks, and the test hooks' budget override, keep to their budgets however busy the machine is");
        store.Return(a, 500);
        store.Return(b, 401);
        check(store.UsedBytes == 0 && a.UsedBytes == 0 && b.UsedBytes == 0, "returned bytes leave both counters at zero");

        // Sealing: the first page at 64 rows, then at 4,096 rows or 256 KiB, and the rest when the set completes.
        store = new ResultStore(1L << 30, 1L << 29);
        var query = store.BeginQuery("s");
        var set = Open(store, query);
        Fill(set, 0, 63);
        var sealDelay = set.SealDelay;
        check(set.RowsAvailable == 0 && set.HasPendingRows && sealDelay is { } first && first <= TimeSpan.FromMilliseconds(20), "rows wait in the builder until the first page fills (64 rows) or 20 ms pass");
        Fill(set, 63, 1);
        check(set.RowsAvailable == 64 && !set.HasPendingRows, "the first page is sealed at 64 rows, so the first rows are readable at once");
        Fill(set, 64, 10_000);
        var pages = set.PagesFor(0, int.MaxValue);
        check(pages.Skip(1).All(page => page.Rows == PageBuilder.MaxRows || page.Body.Length >= PageBuilder.SealBytes) && set.SealDelay == TimeSpan.FromMilliseconds(200),
            "later pages seal at 4,096 rows or 256 KiB, and idle rows after 200 ms (" + string.Join(",", pages.Select(page => page.Rows)) + ")");
        set.Complete();
        pages = set.PagesFor(0, int.MaxValue);
        var contiguous = pages.Select((page, i) => i == 0 ? page.FirstRow == 0 : page.FirstRow == pages[i - 1].FirstRow + pages[i - 1].Rows).All(ok => ok);
        check(set.IsComplete && set.RowsAvailable == 10_064 && StoredRows(set) == 10_064 && contiguous, "completing a set seals its last rows into contiguous pages");
        var random = new Random(7);
        var lookups = true;
        for (var i = 0; i < 200; i++)
        {
            var firstRow = random.NextInt64(0, 11_000);
            var maxRows = random.Next(1, 6000);
            var expected = pages.Where(page => page.FirstRow < firstRow + maxRows && page.FirstRow + page.Rows > firstRow).ToList();
            lookups &= set.PagesFor(firstRow, maxRows).SequenceEqual(expected);
        }
        check(lookups, "the page directory finds exactly the pages that overlap a row range");
        var descriptor = set.Describe();
        check(descriptor is { State: "complete", RowsRead: 10_064, RowsStored: 10_064, RowsAvailable: 10_064, Truncated: null } && descriptor.BytesStored == pages.Sum(page => (long)page.Body.Length)
            && query.UsedBytes == store.UsedBytes && store.UsedBytes >= descriptor.BytesStored + pages.Count * ResultStore.PageOverhead && store.UsedBytes < descriptor.BytesStored + 256 * 1024,
            "a complete set is charged its pages plus overhead and metadata (" + store.UsedBytes + " for " + descriptor.BytesStored + " bytes)");

        // A full budget rolls back the row being written, stops the query, and later sets store nothing.
        store = new ResultStore(2L << 20, 3L << 19);
        query = store.BeginQuery("s");
        set = Open(store, query);
        Fill(set, 0, 20_000);
        set.Complete();
        var later = store.Open(query, 1, 1, 1, "rows", W1Columns, W1Wires);
        var truncated = set.Describe();
        check(truncated.Truncated == "queryBudget" && truncated.RowsRead == 20_000 && truncated.RowsStored < 20_000 && truncated.RowsStored == StoredRows(set) && truncated.RowsAvailable == truncated.RowsStored
            && later is null && query.UsedBytes <= store.QueryBytes,
            "one query stores at most half the budget: whole rows only, later sets of the query are not kept, and the reason is reported (" + truncated.RowsStored + " rows kept)");
        var other = Open(store, store.BeginQuery("s2"));
        Fill(other, 0, 20_000);
        other.Complete();
        check(other.Describe() is { Truncated: "globalBudget", RowsStored: > 0 and < 20_000 } && store.UsedBytes <= store.GlobalBytes, "another query stops at the global budget");

        // Column metadata is reserved like rows: a set whose metadata does not fit is not kept, and its query stops.
        store = new ResultStore(64 * 1024, 64 * 1024);
        query = store.BeginQuery("s");
        IReadOnlyList<ResultColumn> wide = [.. Enumerable.Range(0, 4096).Select(i => new ResultColumn("column_" + i, "int", "text"))];
        var refused = store.Open(query, 0, 1, 1, "rows", wide, [.. wide.Select(_ => WireKind.Text)]);
        check(refused is null && query.Stopped == TruncationReason.QueryBudget && store.UsedBytes == 0 && store.Count == 0 && store.Open(query, 1, 1, 1, "rows", W1Columns, W1Wires) is null,
            "a result set whose column metadata exceeds the budget is not kept, and the query keeps no later sets");

        // Memory pressure is checked at each seal: the page just sealed is kept, nothing after it is stored.
        low = false;
        store = new ResultStore(1L << 30, 1L << 29, () => (low ? 100 : 0, 50));
        query = store.BeginQuery("s");
        set = Open(store, query);
        Fill(set, 0, 64);
        low = true;
        Fill(set, 64, 9000);
        set.Complete();
        check(set.Describe() is { Truncated: "systemMemory", RowsStored: < 9064 } && set.RowsAvailable == StoredRows(set) && set.RowsAvailable >= 64 && query.Stopped == TruncationReason.SystemMemory,
            "high memory load stops storing rows after the current page, and stops the query");
        // A query's own set stops its query at its last seal too: the set is whole, and later sets store nothing.
        query = store.BeginQuery("last");
        set = Open(store, query);
        Fill(set, 0, 10);
        set.Complete();
        check(set.Describe() is { Truncated: null, RowsStored: 10, State: "complete" } && query.Stopped == TruncationReason.SystemMemory && store.Open(query, 1, 1, 1, "rows", W1Columns, W1Wires) is null,
            "high memory load at a query set's final seal keeps the set whole and stops the query");
        // A derived set (a pivot, a diff) stops only itself, at the row after the page sealed under pressure.
        query = store.BeginQuery("derived");
        var derived = store.Open(query, 0, 1, 1, "pivot", W1Columns, W1Wires, derived: true)!;
        Fill(derived, 0, 9000);
        derived.Complete();
        check(derived.Describe() is { Truncated: "systemMemory", RowsStored: 64 } && derived.RowsAvailable == 64 && query.Stopped == TruncationReason.None,
            $"high memory load stops a derived set after the current page and leaves its query's budget open: {derived.Describe().RowsStored} {query.Stopped}");
        // Its last seal has no row after it: the set is whole, so nothing marks it.
        var last = store.Open(query, 1, 1, 1, "pivot", W1Columns, W1Wires, derived: true)!;
        Fill(last, 0, 10);
        last.Complete();
        var exact = store.Open(query, 2, 1, 1, "pivot", W1Columns, W1Wires, derived: true)!;
        Fill(exact, 0, 64);
        exact.Complete();
        check(last.Describe() is { Truncated: null, RowsStored: 10, State: "complete" } && exact.Describe() is { Truncated: null, RowsStored: 64, State: "complete" } && query.Stopped == TruncationReason.None,
            "a derived set whose last page is sealed under high memory load is kept whole and not marked truncated");
        low = false;
        var after = store.Open(query, 3, 1, 1, "pivot", W1Columns, W1Wires, derived: true)!;
        Fill(after, 0, 200);
        after.Complete();
        check(after.Describe() is { Truncated: null, RowsStored: 200 }, "the query stores another derived set once memory is free again");
        // A derived set's first refusal ends it, as it ends a query's: a smaller row that would fit is not stored after
        // the gap, so its stored rows stay a prefix of the rows read.
        store = new ResultStore(16 * 1024, 16 * 1024);
        query = store.BeginQuery("gap");
        var gap = store.Open(query, 0, 1, 1, "pivot", [new ResultColumn("t", "nvarchar(max)", "text")], [WireKind.Text], derived: true)!;
        var kept = 0;
        for (; kept < 1000; kept++)
        {
            gap.CountRow();
            if (gap.BeginRow() is not { } builder) break;
            builder.AppendText(new string('x', 1000));
            if (!gap.TryCommitRow()) break;
        }
        var room = store.TryReserve(query, 64, false, out _);
        if (room) store.Return(query, 64);
        gap.CountRow();
        var next = gap.BeginRow();
        check(kept is > 0 and < 1000 && room && next is null && !gap.TryReserveRows(1) && gap.Describe() is { Truncated: "queryBudget" } described && described.RowsStored == kept && query.Stopped == TruncationReason.None,
            $"a derived set stores nothing after the first row the budget refuses, though a smaller one would fit: {kept} {room} {next is null} {query.Stopped}");

        // Releases: re-executing on a session and results.close return the memory (closing a session or disconnecting does not
        // release anything; SqlService no longer calls the store then).
        store = new ResultStore(1L << 30, 1L << 29);
        var first1 = Open(store, store.BeginQuery("tab-1"));
        Fill(first1, 0, 100);
        first1.Complete();
        var first2 = Open(store, store.BeginQuery("tab-2"));
        Fill(first2, 0, 100);
        var third = Open(store, store.BeginQuery("tab-3"));
        Fill(third, 0, 100);
        third.Complete();
        var rerun = store.BeginQuery("tab-1");
        check(store.Find(first1.ResultId) is null && first1.IsReleased && store.WasReleased(first1.ResultId) && !store.WasReleased(999), "a new query on a session releases the session's earlier results");
        Fill(first2, 100, 100);
        check(first2.Describe().RowsStored == 200 && store.ReleaseSession("tab-2") == 1 && first2.Describe().State == "released" && first2.PagesFor(0, int.MaxValue).Count == 0,
            "closing a session releases its results, even while they are being written");
        var fourth = Open(store, rerun);
        Fill(fourth, 0, 100);
        fourth.Complete();
        check(store.Count == 2 && store.Release(fourth.ResultId) && store.Release(third.ResultId) && !store.Release(third.ResultId) && store.Count == 0 && store.UsedBytes == 0,
            "closing results returns every byte to the budget");

        Leases(check);
        Collection(check);
        Events(check);
        MemoryReports(check);
        HostReads(check);
    }

    /// <summary>results.memory reports small increases without a query summary, and reports memory released by
    /// results.close before the response.</summary>
    private static void MemoryReports(Action<bool, string> check)
    {
        var reports = new List<long>();
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store, publish: value =>
        {
            var report = JsonSerializer.SerializeToElement(value, HostChecks.Json);
            if (report.GetProperty("type").GetString() == "results.memory")
                lock (reports) reports.Add(report.GetProperty("usedBytes").GetInt64());
            return true;
        });
        long? Last() { lock (reports) return reports.Count > 0 ? reports[^1] : null; }
        var first = Open(store, store.BeginQuery("s1"));
        Fill(first, 0, 1000);
        first.Complete();
        service.ReportMemory();
        var reported = store.UsedBytes;
        var afterFirst = Last();
        var second = Open(store, store.BeginQuery("s2"));
        Fill(second, 0, 1000);
        second.Complete();
        service.ReportMemory();
        var afterRise = Last();
        var usedAfterRise = store.UsedBytes;
        var close = JsonSerializer.SerializeToElement(new { resultIds = new[] { first.ResultId, second.ResultId } }, HostChecks.Json);
        var closed = (ResultsCloseResult)service.DispatchAsync("results.close", close, HostChecks.Json).GetAwaiter().GetResult();
        check(reported > 0 && afterFirst == reported && afterRise == usedAfterRise
            && usedAfterRise > reported && usedAfterRise - reported < 64L * 1024 * 1024 && closed.Closed == 2 && Last() == 0,
            "results.memory reports a small rise and the fall to 0 before results.close answers: " + afterFirst + ", " + afterRise + ", " + Last());

        // A summary counts as a report, so the same sample is deduplicated and a subsequent close still reports 0.
        int Count() { lock (reports) return reports.Count; }
        var third = Open(store, store.BeginQuery("s3"));
        Fill(third, 0, 1000);
        third.Complete();
        var summary = service.SummaryBudget();
        var before = Count();
        service.ReportMemory();
        var afterSummary = Count();
        close = JsonSerializer.SerializeToElement(new { resultIds = new[] { third.ResultId } }, HostChecks.Json);
        closed = (ResultsCloseResult)service.DispatchAsync("results.close", close, HostChecks.Json).GetAwaiter().GetResult();
        check(summary.UsedBytes > 0 && afterSummary == before && closed.Closed == 1 && Count() == before + 1 && Last() == 0,
            "results.memory deduplicates a summary's sample and reports the fall to 0 when the results are closed: " + before + ", " + afterSummary + ", " + Count() + ", " + Last());

        MemoryBudgetReports(check);
    }

    private static void MemoryBudgetReports(Action<bool, string> check)
    {
        var reports = new List<(long Used, long Limit, long Seq)>();
        var store = new ResultStore(1L << 30, 1L << 29);
        long resultsUsed = -1;
        using var service = new SqlService(store, publish: value =>
        {
            var report = JsonSerializer.SerializeToElement(value, HostChecks.Json);
            var used = report.GetProperty("usedBytes").GetInt64();
            if (report.GetProperty("type").GetString() == "results.memory")
            {
                Interlocked.Exchange(ref resultsUsed, used);
                return true;
            }
            lock (reports)
            {
                reports.Add((used, report.GetProperty("globalBytes").GetInt64(), report.GetProperty("seq").GetInt64()));
                return reports.Count != 1;
            }
        });
        service.ReportMemory();
        check(Interlocked.Read(ref resultsUsed) == 0, "results.memory reports the initial empty store");
        var pool = service.Search.Pool;
        service.ReportIndexMemory(); // Refused by the control lane.
        service.ReportIndexMemory(); // Retried with the same sequence.
        var name = pool.TryAcquire("dbo.Orders");
        service.ReportIndexMemory();
        service.ReportIndexMemory(); // No change to report.
        pool.Release([name]);
        service.ReportIndexMemory();
        var limit = service.Search.Limits.MemoryBytes;
        lock (reports)
            check(reports.SequenceEqual([(0L, limit, 1L), (0L, limit, 1L), (StringPool.Cost("dbo.Orders"), limit, 2L), (0L, limit, 3L)]),
                "explorer.index.memory reports the shared index budget, retries refused samples, and reports bytes released");
    }

    /// <summary>Released pages are large arrays that only a gen2 collection frees; the store triggers one itself.</summary>
    private static void Collection(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 30);
        var set = Open(store, store.BeginQuery("s"));
        Fill(set, 0, 600_000);
        set.Complete();
        var held = GC.GetTotalMemory(false);
        var collections = GC.CollectionCount(2);
        var stored = store.UsedBytes;
        store.Release(set.ResultId);
        SpinWait.SpinUntil(() => GC.CollectionCount(2) > collections, 15_000);
        var after = GC.GetTotalMemory(false);
        check(stored > 64L * 1024 * 1024 && GC.CollectionCount(2) > collections && held - after > stored / 2,
            "releasing more than 64 MiB of results collects them (" + held / 1048576 + " MB held, " + after / 1048576 + " MB after)");

        // results.close releases one id per call, and four results of about 25 MiB each are each below the threshold.
        foreach (var together in new[] { false, true })
        {
            store = new ResultStore(1L << 30, 1L << 30);
            List<ResultSetBuffer> sets = [];
            for (var i = 0; i < 4; i++)
            {
                var small = Open(store, store.BeginQuery("s" + i));
                Fill(small, 0, 120_000);
                small.Complete();
                sets.Add(small);
            }
            held = GC.GetTotalMemory(false);
            collections = GC.CollectionCount(2);
            stored = store.UsedBytes;
            var largest = sets.Max(item => item.Describe().BytesStored);
            var released = together ? store.Release(sets.Select(item => item.ResultId)) : sets.Count(item => store.Release(item.ResultId));
            SpinWait.SpinUntil(() => GC.CollectionCount(2) > collections, 15_000);
            after = GC.GetTotalMemory(false);
            check(largest < 64L * 1024 * 1024 && stored > 64L * 1024 * 1024 && released == 4 && store.UsedBytes == 0 && GC.CollectionCount(2) > collections && held - after > stored / 2,
                "releasing more than 64 MiB in results under 64 MiB each, " + (together ? "in one call" : "one at a time") + ", collects them ("
                + held / 1048576 + " MB held, " + after / 1048576 + " MB after)");
        }

        // Only a compacting collection returns memory to the operating system. Closing a large result while a small one
        // remains compacts (it copies little), and so does closing the last one, although it releases less than 64 MiB.
        store = new ResultStore(1L << 30, 1L << 30);
        var kept = Open(store, store.BeginQuery("kept"));
        Fill(kept, 0, 120_000);
        kept.Complete();
        var large = Open(store, store.BeginQuery("large"));
        Fill(large, 0, 600_000);
        large.Complete();
        // The working set, not GC.GetGCMemoryInfo(), which describes the heap as of the last collection.
        held = Environment.WorkingSet;
        var keptBytes = kept.Describe().BytesStored;
        var largeBytes = large.Describe().BytesStored;
        // Whether the release was followed by a full blocking collection that compacted.
        bool Compacts(Action release)
        {
            var index = GC.GetGCMemoryInfo(GCKind.FullBlocking).Index;
            release();
            SpinWait.SpinUntil(() => GC.GetGCMemoryInfo(GCKind.FullBlocking).Index > index, 15_000);
            var info = GC.GetGCMemoryInfo(GCKind.FullBlocking);
            return info.Index > index && info.Compacted;
        }
        var first = Compacts(() => store.Release(large.ResultId));
        var second = Compacts(() => store.Release(kept.ResultId));
        var left = Environment.WorkingSet;
        check(keptBytes is > 16L * 1024 * 1024 and < 64L * 1024 * 1024 && largeBytes > 64L * 1024 * 1024 && first && second && held - left > (keptBytes + largeBytes) / 2,
            "closing a large result, then the last small one, compacts both times and returns the memory (" + first + "/" + second + ", working set " + held / 1048576 + " MB, then " + left / 1048576 + " MB)");
    }

    private static void Events(Action<bool, string> check)
    {
        var events = new List<(JsonElement Body, bool Droppable)>();
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Open(store, store.BeginQuery("s"));
        var clock = Stopwatch.StartNew();
        using (var sink = new QueryEventSink((value, droppable) => { lock (events) events.Add((JsonSerializer.SerializeToElement(value, HostChecks.Json), droppable)); }))
        {
            sink.Opened(set);
            Fill(set, 0, PageBuilder.FirstPageRows);
            sink.Sealed(set);
            int immediate;
            lock (events) immediate = events.Count(item => Type(item.Body) == "progress");
            check(set.RowsAvailable == PageBuilder.FirstPageRows && immediate == 1, "the first sealed page is reported at once, not at the next progress tick");
            sink.Progress(0, 1, 1, 1);
            for (var i = 0; i < 50; i++)
            {
                Fill(set, i, 1);
                sink.RowsChanged();
                sink.Message(new("message " + i, i % 2 == 0 ? "info" : "error"));
                Thread.Sleep(10);
            }
            set.Complete();
            sink.Closed(set);
            // The tick is still live until the sink is disposed and may report progress for the sets still open (none here).
            Thread.Sleep(130);
            sink.Message(new("after close", "info"));
        }
        var elapsed = clock.ElapsedMilliseconds;
        var types = events.Select(item => Type(item.Body)).ToList();
        var closed = types.IndexOf("resultSet.closed");
        var progress = types.Count(type => type == "progress");
        var lastMessages = types.LastIndexOf("messages");
        check(types[0] == "resultSet.opened" && closed > 0 && types.LastIndexOf("resultSet.closed") == closed
            && events[closed].Body.GetProperty("descriptor").GetProperty("rowsAvailable").GetInt64() == set.RowsAvailable
            && events.Skip(closed + 1).Where(item => Type(item.Body) == "progress").All(item => item.Body.GetProperty("results").GetArrayLength() == 0)
            && lastMessages > closed && events[lastMessages].Body.GetProperty("messages").EnumerateArray().Last().GetProperty("text").GetString() == "after close"
            && events.Where(item => Type(item.Body) == "messages").SelectMany(item => item.Body.GetProperty("messages").EnumerateArray()).Any(entry => entry.GetProperty("kind").GetString() == "error")
            && progress >= 1 && progress <= elapsed / 100 + 2 && events.All(item => item.Droppable == Type(item.Body) is "progress" or "messages"),
            "query events: opened first, progress coalesced to 10 a second (" + progress + " in " + elapsed + " ms), messages batched and droppable, closed once with the final descriptor and never reported by later progress");
        var count = events.Count;
        Thread.Sleep(250);
        check(events.Count == count, "nothing is emitted after the sink is disposed");

        // Every set's first page is reported at once, within the 100 ms spacing too, so a script of one-row sets shows each
        // set's row without waiting for a tick; a set's later pages still wait for the spacing. A first page is reported
        // before Sealed returns (by Sealed, or by a tick that got there first); a later page may be reported once 100 ms
        // passed since the first, which a starved CI runner can make happen between two calls, so only sets whose two seals
        // fell within 100 ms judge the spacing.
        var reports = new List<(uint ResultId, long RowsAvailable)>();
        using (var sink = new QueryEventSink((value, _) =>
        {
            var body = JsonSerializer.SerializeToElement(value, HostChecks.Json);
            if (body.GetProperty("type").GetString() != "progress") return;
            lock (reports) foreach (var result in body.GetProperty("results").EnumerateArray()) reports.Add((result.GetProperty("resultId").GetUInt32(), result.GetProperty("rowsAvailable").GetInt64()));
        }))
        {
            bool Reported(uint id, long rows) { lock (reports) return reports.Any(item => item.ResultId == id && item.RowsAvailable >= rows); }
            var query = store.BeginQuery("one-row sets");
            int sets = 0, firstAtOnce = 0, spaced = 0, laterAtOnce = 0;
            for (var i = 0; i < 20 && (i < 3 || spaced == 0); i++)
            {
                var single = Open(store, query, i);
                sets++;
                sink.Opened(single);
                Fill(single, 0, 1);
                single.Seal();
                var before = Environment.TickCount64;
                sink.Sealed(single);
                if (Reported(single.ResultId, 1)) firstAtOnce++;
                Fill(single, 1, 1);
                single.Seal();
                sink.Sealed(single);
                var later = Reported(single.ResultId, 2);
                if (Environment.TickCount64 - before < 100) { spaced++; if (later) laterAtOnce++; }
                single.Complete();
                sink.Closed(single);
            }
            check(firstAtOnce == sets && spaced > 0 && laterAtOnce == 0, "each set's first sealed page is reported at once, bypassing the coalescing; its later pages are not ("
                + firstAtOnce + " of " + sets + " first pages at once, " + laterAtOnce + " of " + spaced + " later pages within 100 ms)");
        }

        // A set that stopped storing says why in its progress, not only when it closes: the statement may read on for minutes.
        var said = new List<(uint ResultId, string? Truncated, long RowsRead, long RowsStored)>();
        using (var sink = new QueryEventSink((value, _) =>
        {
            var body = JsonSerializer.SerializeToElement(value, HostChecks.Json);
            if (body.GetProperty("type").GetString() != "progress") return;
            lock (said) foreach (var result in body.GetProperty("results").EnumerateArray())
                said.Add((result.GetProperty("resultId").GetUInt32(), result.TryGetProperty("truncated", out var reason) ? reason.GetString() : null, result.GetProperty("rowsRead").GetInt64(), result.GetProperty("rowsStored").GetInt64()));
        }))
        {
            var small = new ResultStore(4L << 20, 1L << 20);
            var query = small.BeginQuery("full");
            var whole = Open(small, query);
            sink.Opened(whole);
            Fill(whole, 0, 1);
            whole.Seal();
            sink.Sealed(whole);
            var full = Open(small, query, 1);
            sink.Opened(full);
            Fill(full, 0, 200_000);
            full.Seal();
            sink.Sealed(full);
            List<(uint ResultId, string? Truncated, long RowsRead, long RowsStored)> seen;
            lock (said) seen = [.. said];
            check(query.Stopped == TruncationReason.QueryBudget && seen.Where(item => item.ResultId == whole.ResultId).All(item => item.Truncated is null)
                && seen.Any(item => item.ResultId == full.ResultId && item.Truncated == "queryBudget" && item.RowsRead == 200_000 && item.RowsStored < item.RowsRead),
                "progress says why a set stopped storing rows while it is still open, and nothing for a set that stores them all");
        }
    }

    private static string Type(JsonElement body) => body.GetProperty("type").GetString()!;

    /// <summary>A copy or export leases its result: a release meanwhile stops reads and storage at once, but the pages and
    /// budget stay until the last lease ends.</summary>
    private static void Leases(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Open(store, store.BeginQuery("tab"));
        Fill(set, 0, 5000);
        var used = store.UsedBytes;
        check(set.TryLease() && set.TryLease() && set.Leases == 2, "a result can be leased more than once");
        var released = store.Release(set.ResultId);
        var pagesKept = set.PagesFor(0, int.MaxValue).Count;
        check(released && set.IsReleased && store.Find(set.ResultId) is null && store.WasReleased(set.ResultId) && pagesKept > 0 && store.UsedBytes == used && !set.TryLease()
            && set.BeginRow() is null, "releasing a leased result removes it from lookup and stops storing, but keeps its pages and budget (" + pagesKept + " pages)");
        set.ReleaseLease();
        check(store.UsedBytes == used && set.PagesFor(0, int.MaxValue).Count == pagesKept, "the pages stay while any lease remains");
        set.ReleaseLease();
        check(store.UsedBytes == 0 && set.PagesFor(0, int.MaxValue).Count == 0 && set.Leases == 0, "the last lease frees the pages and returns every byte");
        var plain = Open(store, store.BeginQuery("other"));
        Fill(plain, 0, 100);
        plain.Complete();
        check(plain.TryLease() && plain.IsComplete, "a complete result can be leased");
        plain.ReleaseLease();
        check(store.Release(plain.ResultId) && store.UsedBytes == 0, "a result whose leases ended is freed at once when released");
        var threw = false;
        try { plain.ReleaseLease(); } catch (InvalidOperationException) { threw = true; }
        check(threw, "ending a lease that was never taken is a bug, not a silent no-op");
    }

    /// <summary>results.read and results.close through ProtocolHost with the real service and synthetic results.</summary>
    private static void HostReads(Action<bool, string> check)
    {
        using var host = new HostHarness(dispatcher: () => new SqlService(new ResultStore(1L << 30, 1L << 29), hooks: true));
        var hello = host.Hello();
        check(hello.GetProperty("methods").EnumerateArray().Any(method => method.GetString() == SqlService.SynthesizeMethod), "test hooks announce debug.results.synthesize");
        host.Request(1, SqlService.SynthesizeMethod, new { shape = "W1", rows = 10_000 });
        var synthesized = JsonBridge.ParseControl(host.Next(FrameKind.Response, 15_000)!.Value.Body).GetProperty("result");
        var id = synthesized.GetProperty("resultId").GetUInt32();
        check(synthesized.GetProperty("rowsAvailable").GetInt64() == 10_000 && synthesized.GetProperty("state").GetString() == "complete", "synthetic rows are stored through the budgeted path");
        host.Request(2, "results.read", new { resultId = id, firstRow = 4000, maxRows = 5000 }, credit: 64 * 1024);
        // The first page may be late on a starved CI runner; a later one that misses the 300 ms of quiet only lowers the
        // count before more credit, and the frames after the credit are taken up to the response, not until a quiet spell.
        var frames = new List<Frame>();
        if (host.Next(FrameKind.Data, 15_000) is { } firstData) frames.Add(firstData);
        while (host.Next(FrameKind.Data, 300) is { } data) frames.Add(data);
        var stalled = frames.Count;
        host.Send(FrameKind.Credit, 2, 16 * 1024 * 1024, []);
        var endFrame = host.Next(FrameKind.Response, 15_000);
        while (host.Next(FrameKind.Data, 0) is { } data) frames.Add(data);
        var end = JsonBridge.ParseControl(endFrame!.Value.Body).GetProperty("result");
        var decoded = frames.Select(frame => PageReader.Read(frame.Body, W1Wires)).ToList();
        var contiguous = decoded.Select((page, i) => i == 0 || page.FirstRow == decoded[i - 1].FirstRow + decoded[i - 1].Rows.Length).All(ok => ok);
        check(stalled is >= 1 and < 4 && frames.Select(frame => frame.Header.Arg).SequenceEqual(Enumerable.Range(1, frames.Count).Select(i => (uint)i)) && contiguous
            && decoded[0].FirstRow <= 4000 && decoded[^1].FirstRow + decoded[^1].Rows.Length >= 9000 && decoded[0].Rows[0][0].Text == decoded[0].FirstRow.ToString(System.Globalization.CultureInfo.InvariantCulture)
            && end.GetProperty("nextRow").GetInt64() == decoded[^1].FirstRow + decoded[^1].Rows.Length && end.GetProperty("pages").GetInt32() == frames.Count && !end.GetProperty("complete").GetBoolean(),
            "results.read streams the stored pages covering a range, in sequence, within credit (" + stalled + " pages before more credit)");
        host.Request(3, "results.read", new { resultId = id, firstRow = 9000, maxRows = 65_536 }, credit: 16 * 1024 * 1024);
        var tailFrame = host.Next(FrameKind.Response, 15_000);
        while (host.Next(FrameKind.Data, 0) is not null) { }
        var tail = JsonBridge.ParseControl(tailFrame!.Value.Body).GetProperty("result");
        check(tail.GetProperty("complete").GetBoolean() && tail.GetProperty("nextRow").GetInt64() == 10_000, "reading to the end of a complete result reports complete");
        string? Code(uint request, string method, object parameters, long? credit = null)
        {
            host.Request(request, method, parameters, credit: credit);
            var body = JsonBridge.ParseControl(host.Next(FrameKind.Response, 15_000)!.Value.Body);
            return body.TryGetProperty("error", out var error) ? error.GetProperty("code").GetString() : null;
        }
        check(Code(4, "results.read", new { resultId = id, firstRow = 0, maxRows = 10 }) == "INVALID_REQUEST" && Code(5, "results.read", new { resultId = 999, firstRow = 0, maxRows = 10 }, 65_536) == "RESULT_NOT_FOUND"
            && Code(6, "results.read", new { resultId = id, firstRow = 0, maxRows = 65_537 }, 65_536) == "INVALID_PARAMS", "results.read needs credit, an existing result, and a bounded range");
        host.Request(7, "results.close", new { resultIds = new[] { id, 12345u } });
        var closed = JsonBridge.ParseControl(host.Next(FrameKind.Response, 15_000)!.Value.Body).GetProperty("result");
        check(closed.GetProperty("closed").GetInt32() == 1 && closed.GetProperty("usedBytes").GetInt64() == 0 && Code(8, "results.read", new { resultId = id, firstRow = 0, maxRows = 10 }, 65_536) == "RESULT_RELEASED",
            "results.close returns the memory, and later reads answer RESULT_RELEASED");
        check(Code(9, "results.close", new { resultIds = Array.Empty<uint>() }) == "INVALID_PARAMS", "results.close needs 1 to 1024 ids");
    }
}
