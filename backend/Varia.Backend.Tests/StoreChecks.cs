using System.Text.Json;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

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
        var a = store.BeginQuery("s1", "c1");
        var b = store.BeginQuery("s2", "c1");
        check(store.TryReserve(a, 500, true, out _) && !store.TryReserve(a, 200, true, out var queryFull) && queryFull == TruncationReason.QueryBudget
            && store.TryReserve(b, 400, false, out _) && !store.TryReserve(b, 200, false, out var globalFull) && globalFull == TruncationReason.GlobalBudget,
            "reservations stop at the query's half of the budget first, then at the global budget");
        low = true;
        check(!store.TryReserve(b, 1, true, out var system) && system == TruncationReason.SystemMemory && store.TryReserve(b, 1, false, out _),
            "high memory load refuses reservations checked at a seal, before any budget");
        store.Return(a, 500);
        store.Return(b, 401);
        check(store.UsedBytes == 0 && a.UsedBytes == 0 && b.UsedBytes == 0, "returned bytes leave both counters at zero");

        // Sealing: the first page at 64 rows, then at 4,096 rows or 256 KiB, and the rest when the set completes.
        store = new ResultStore(1L << 30, 1L << 29);
        var query = store.BeginQuery("s", "c");
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
        query = store.BeginQuery("s", "c");
        set = Open(store, query);
        Fill(set, 0, 20_000);
        set.Complete();
        var later = store.Open(query, 1, 1, 1, "rows", W1Columns, W1Wires);
        var truncated = set.Describe();
        check(truncated.Truncated == "queryBudget" && truncated.RowsRead == 20_000 && truncated.RowsStored < 20_000 && truncated.RowsStored == StoredRows(set) && truncated.RowsAvailable == truncated.RowsStored
            && later is null && query.UsedBytes <= store.QueryBytes,
            "one query stores at most half the budget: whole rows only, later sets of the query are not kept, and the reason is reported (" + truncated.RowsStored + " rows kept)");
        var other = Open(store, store.BeginQuery("s2", "c"));
        Fill(other, 0, 20_000);
        other.Complete();
        check(other.Describe() is { Truncated: "globalBudget", RowsStored: > 0 and < 20_000 } && store.UsedBytes <= store.GlobalBytes, "another query stops at the global budget");

        // Column metadata is reserved like rows: a set whose metadata does not fit is not kept, and its query stops.
        store = new ResultStore(64 * 1024, 64 * 1024);
        query = store.BeginQuery("s", "c");
        IReadOnlyList<ResultColumn> wide = [.. Enumerable.Range(0, 4096).Select(i => new ResultColumn("column_" + i, "int", "text"))];
        var refused = store.Open(query, 0, 1, 1, "rows", wide, [.. wide.Select(_ => WireKind.Text)]);
        check(refused is null && query.Stopped == TruncationReason.QueryBudget && store.UsedBytes == 0 && store.Count == 0 && store.Open(query, 1, 1, 1, "rows", W1Columns, W1Wires) is null,
            "a result set whose column metadata exceeds the budget is not kept, and the query keeps no later sets");

        // Memory pressure is checked at each seal: the page just sealed is kept, nothing after it is stored.
        low = false;
        store = new ResultStore(1L << 30, 1L << 29, () => (low ? 100 : 0, 50));
        query = store.BeginQuery("s", "c");
        set = Open(store, query);
        Fill(set, 0, 64);
        low = true;
        Fill(set, 64, 9000);
        set.Complete();
        check(set.Describe() is { Truncated: "systemMemory", RowsStored: < 9064 } && set.RowsAvailable == StoredRows(set) && set.RowsAvailable >= 64, "high memory load stops storing rows after the current page");

        // Releases: re-executing on a session, closing it, disconnecting, and results.close all return the memory.
        store = new ResultStore(1L << 30, 1L << 29);
        var first1 = Open(store, store.BeginQuery("tab-1", "server-1"));
        Fill(first1, 0, 100);
        first1.Complete();
        var first2 = Open(store, store.BeginQuery("tab-2", "server-1"));
        Fill(first2, 0, 100);
        var third = Open(store, store.BeginQuery("tab-3", "server-2"));
        Fill(third, 0, 100);
        third.Complete();
        var rerun = store.BeginQuery("tab-1", "server-1");
        check(store.Find(first1.ResultId) is null && first1.IsReleased && store.WasReleased(first1.ResultId) && !store.WasReleased(999), "a new query on a session releases the session's earlier results");
        Fill(first2, 100, 100);
        check(first2.Describe().RowsStored == 200 && store.ReleaseSession("tab-2") == 1 && first2.Describe().State == "released" && first2.PagesFor(0, int.MaxValue).Count == 0,
            "closing a session releases its results, even while they are being written");
        var fourth = Open(store, rerun);
        Fill(fourth, 0, 100);
        fourth.Complete();
        check(store.ReleaseConnection("server-1") == 1 && store.Release(third.ResultId) && !store.Release(third.ResultId) && store.Count == 0 && store.UsedBytes == 0,
            "disconnecting and closing results return every byte to the budget");

        Collection(check);
        Events(check);
        HostReads(check);
    }

    /// <summary>Released pages are large arrays that only a gen2 collection frees; the store triggers one itself.</summary>
    private static void Collection(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 30);
        var set = Open(store, store.BeginQuery("s", "c"));
        Fill(set, 0, 600_000);
        set.Complete();
        var held = GC.GetTotalMemory(false);
        var collections = GC.CollectionCount(2);
        var stored = store.UsedBytes;
        store.Release(set.ResultId);
        SpinWait.SpinUntil(() => GC.CollectionCount(2) > collections, 5000);
        var after = GC.GetTotalMemory(false);
        check(stored > 64L * 1024 * 1024 && GC.CollectionCount(2) > collections && held - after > stored / 2,
            "releasing more than 64 MiB of results collects them (" + held / 1048576 + " MB held, " + after / 1048576 + " MB after)");
    }

    private static void Events(Action<bool, string> check)
    {
        var events = new List<(string Type, bool Droppable)>();
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Open(store, store.BeginQuery("s", "c"));
        using (var sink = new QueryEventSink((value, droppable) => { lock (events) events.Add((JsonSerializer.SerializeToElement(value, HostChecks.Json).GetProperty("type").GetString()!, droppable)); }))
        {
            sink.Opened(set);
            Fill(set, 0, PageBuilder.FirstPageRows);
            sink.Sealed();
            int immediate;
            lock (events) immediate = events.Count(item => item.Type == "progress");
            check(set.RowsAvailable == PageBuilder.FirstPageRows && immediate == 1, "the first sealed page is reported at once, not at the next progress tick");
            sink.Progress(0, 1, 1, 1);
            for (var i = 0; i < 50; i++)
            {
                Fill(set, i, 1);
                sink.RowsChanged();
                sink.Message("message " + i);
                Thread.Sleep(10);
            }
            set.Complete();
            sink.Closed(set);
            sink.Message("after close");
        }
        var types = events.Select(item => item.Type).ToList();
        var progress = types.Count(type => type == "progress");
        check(types[0] == "resultSet.opened" && types.IndexOf("resultSet.closed") > types.LastIndexOf("progress") && types.Last() == "messages"
            && progress is >= 1 and <= 8 && events.All(item => item.Droppable == item.Type is "progress" or "messages"),
            "query events: opened first, progress coalesced to 10 a second (" + progress + " in 0.5 s), messages batched and droppable, closed with the final descriptor");
        var count = events.Count;
        Thread.Sleep(250);
        check(events.Count == count, "nothing is emitted after the sink is disposed");
    }

    /// <summary>results.read and results.close through ProtocolHost with the real service and synthetic results.</summary>
    private static void HostReads(Action<bool, string> check)
    {
        using var host = new HostHarness(dispatcher: () => new SqlService(new ResultStore(1L << 30, 1L << 29), hooks: true));
        var hello = host.Hello();
        check(hello.GetProperty("methods").EnumerateArray().Any(method => method.GetString() == SqlService.SynthesizeMethod), "test hooks announce debug.results.synthesize");
        host.Request(1, SqlService.SynthesizeMethod, new { shape = "W1", rows = 10_000 });
        var synthesized = JsonBridge.ParseControl(host.Next(FrameKind.Response)!.Value.Body).GetProperty("result");
        var id = synthesized.GetProperty("resultId").GetUInt32();
        check(synthesized.GetProperty("rowsAvailable").GetInt64() == 10_000 && synthesized.GetProperty("state").GetString() == "complete", "synthetic rows are stored through the budgeted path");
        host.Request(2, "results.read", new { resultId = id, firstRow = 4000, maxRows = 5000 }, credit: 64 * 1024);
        var frames = new List<Frame>();
        while (host.Next(FrameKind.Data, 300) is { } data) frames.Add(data);
        var stalled = frames.Count;
        host.Send(FrameKind.Credit, 2, 16 * 1024 * 1024, []);
        while (host.Next(FrameKind.Data, 300) is { } data) frames.Add(data);
        var end = JsonBridge.ParseControl(host.Next(FrameKind.Response)!.Value.Body).GetProperty("result");
        var decoded = frames.Select(frame => PageReader.Read(frame.Body, W1Wires)).ToList();
        var contiguous = decoded.Select((page, i) => i == 0 || page.FirstRow == decoded[i - 1].FirstRow + decoded[i - 1].Rows.Length).All(ok => ok);
        check(stalled is >= 1 and < 4 && frames.Select(frame => frame.Header.Arg).SequenceEqual(Enumerable.Range(1, frames.Count).Select(i => (uint)i)) && contiguous
            && decoded[0].FirstRow <= 4000 && decoded[^1].FirstRow + decoded[^1].Rows.Length >= 9000 && decoded[0].Rows[0][0].Text == decoded[0].FirstRow.ToString(System.Globalization.CultureInfo.InvariantCulture)
            && end.GetProperty("nextRow").GetInt64() == decoded[^1].FirstRow + decoded[^1].Rows.Length && end.GetProperty("pages").GetInt32() == frames.Count && !end.GetProperty("complete").GetBoolean(),
            "results.read streams the stored pages covering a range, in sequence, within credit (" + stalled + " pages before more credit)");
        host.Request(3, "results.read", new { resultId = id, firstRow = 9000, maxRows = 65_536 }, credit: 16 * 1024 * 1024);
        while (host.Next(FrameKind.Data, 300) is not null) { }
        var tail = JsonBridge.ParseControl(host.Next(FrameKind.Response)!.Value.Body).GetProperty("result");
        check(tail.GetProperty("complete").GetBoolean() && tail.GetProperty("nextRow").GetInt64() == 10_000, "reading to the end of a complete result reports complete");
        string? Code(uint request, string method, object parameters, long? credit = null)
        {
            host.Request(request, method, parameters, credit: credit);
            var body = JsonBridge.ParseControl(host.Next(FrameKind.Response)!.Value.Body);
            return body.TryGetProperty("error", out var error) ? error.GetProperty("code").GetString() : null;
        }
        check(Code(4, "results.read", new { resultId = id, firstRow = 0, maxRows = 10 }) == "INVALID_REQUEST" && Code(5, "results.read", new { resultId = 999, firstRow = 0, maxRows = 10 }, 65_536) == "RESULT_NOT_FOUND"
            && Code(6, "results.read", new { resultId = id, firstRow = 0, maxRows = 65_537 }, 65_536) == "INVALID_PARAMS", "results.read needs credit, an existing result, and a bounded range");
        host.Request(7, "results.close", new { resultIds = new[] { id, 12345u } });
        var closed = JsonBridge.ParseControl(host.Next(FrameKind.Response)!.Value.Body).GetProperty("result");
        check(closed.GetProperty("closed").GetInt32() == 1 && closed.GetProperty("usedBytes").GetInt64() == 0 && Code(8, "results.read", new { resultId = id, firstRow = 0, maxRows = 10 }, 65_536) == "RESULT_RELEASED",
            "results.close returns the memory, and later reads answer RESULT_RELEASED");
        check(Code(9, "results.close", new { resultIds = Array.Empty<uint>() }) == "INVALID_PARAMS", "results.close needs 1 to 1024 ids");
    }
}
