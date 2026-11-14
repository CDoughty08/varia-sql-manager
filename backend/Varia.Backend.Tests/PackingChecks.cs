using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Packed pages (ResultSetBuffer.Pack, PageCodec): Zstandard per page behind an internal switch, the unpacked-page
/// cache, unpacking whole for operations, view reads that unpack together, the budget's charges and the store's counters.
/// The second pass of the result suites (Program.cs) runs them all against packed pages; these check the mechanism.</summary>
internal static class PackingChecks
{
    private static readonly IReadOnlyList<ResultColumn> W1Columns = [.. SyntheticRows.Columns("W1").Select(column => new ResultColumn(column.Name, column.DataType, column.Wire == WireKind.Text ? "text" : "binary"))];
    private static readonly IReadOnlyList<WireKind> W1Wires = [.. SyntheticRows.Columns("W1").Select(column => column.Wire)];

    /// <summary>A store whose one query may take the whole budget, so a check can fill what is left with another.</summary>
    private static ResultStore Store(PagePacking packing, long global = 1L << 30) => new(global, global) { Packing = packing };

    private static ResultSetBuffer Filled(ResultStore store, string session, long rows)
    {
        var set = store.Open(store.BeginQuery(session), 0, 1, 1, "rows", W1Columns, W1Wires) ?? throw new InvalidOperationException("The result set was not kept.");
        for (var row = 0L; row < rows; row++)
        {
            set.CountRow();
            if (set.BeginRow() is not { } builder) continue;
            SyntheticRows.WriteCells("W1", row, builder);
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    /// <summary>A set of one binary column of random bytes, which Zstandard cannot shrink.</summary>
    private static ResultSetBuffer Random(ResultStore store, string session, int rows)
    {
        var set = store.Open(store.BeginQuery(session), 0, 1, 1, "rows", [new ResultColumn("b", "varbinary", "binary")], [WireKind.Binary])!;
        var random = new Random(7);
        var cell = new byte[2000];
        for (var row = 0; row < rows; row++)
        {
            set.CountRow();
            random.NextBytes(cell);
            set.BeginRow()!.AppendBinary(cell);
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    private static byte[][] Bodies(ResultSetBuffer set)
    {
        using var pin = set.Pin();
        return [.. set.SealedSnapshot().Select(page => page.Body())];
    }

    /// <summary>What the set's pages are charged now, packed or not, with its metadata (W1's) and no cache.</summary>
    private static long PageCharges(ResultSetBuffer set) => 512 + set.Columns.Sum(column => 2L * column.Name.Length + 64)
        + set.SealedSnapshot().Sum(page => (page.Stored is PackedPage packed ? packed.Bytes.Length : page.Length) + ResultStore.PageOverhead + page.Lengths.MemoryBytes);

    public static void Run(Action<bool, string> check)
    {
        Codec(check);
        Switch(check);
        Packs(check);
        KeepsRaw(check);
        Cache(check);
        UnpacksWhole(check);
        ViewReads(check);
        Service(check);
    }

    private static void Codec(Action<bool, string> check)
    {
        var page = new byte[256 * 1024];
        for (var i = 0; i < page.Length; i++) page[i] = (byte)(i % 251 < 120 ? 'a' + i % 7 : i * 31);
        var packed = PageCodec.Pack(page)!;
        var threw = false;
        try { PageCodec.Unpack([1, 2, 3, 4], 100); } catch (InvalidDataException) { threw = true; }
        check(packed.Length < page.Length / 2 && PageCodec.Unpack(packed, page.Length).AsSpan().SequenceEqual(page) && threw && PageCodec.Quality == 2 && PageCodec.Window == 18,
            "a page packs with Zstandard level 2 and a one-page window and unpacks to its bytes; bytes that are no packed page fail to read");
    }

    private static void Switch(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Filled(store, "off", 20_000);
        var used = store.UsedBytes;
        check(ResultStore.DefaultPacking == PagePacking.Off && store.Packing == PagePacking.Off && set.Pack() == 0 && !set.HasPacked && store.UsedBytes == used
            && store.PackingSnapshot() is { PagesPacked: 0, PackedBytes: 0 },
            "packing is off by default: a store packs nothing until its switch allows it");
        var live = Store(PagePacking.OnRequest);
        var table = live.Open(new QueryBudget("live", new LiveBudget(64L << 20)), 0, 1, 1, "rows", W1Columns, W1Wires)!;
        for (var row = 0L; row < 5000; row++) { table.CountRow(); SyntheticRows.WriteCells("W1", row, table.BeginRow()!); table.TryCommitRow(); }
        table.Complete();
        check(table.Pack() == 0 && !table.HasPacked, "a live table is never packed");
    }

    private static void Packs(Action<bool, string> check)
    {
        var store = Store(PagePacking.OnRequest);
        var set = Filled(store, "packs", 40_000);
        var open = store.Open(store.BeginQuery("open"), 0, 1, 1, "rows", W1Columns, W1Wires)!;
        SyntheticRows.WriteCells("W1", 0, open.BeginRow()!);
        open.TryCommitRow();
        open.Seal();
        var before = Bodies(set);
        var used = store.UsedBytes;
        var collect = store.FreedSinceCollect;
        var compact = store.FreedSinceCompact;
        var pinned = set.Pin();
        var whilePinned = set.Pack();
        pinned.Dispose();
        check(set.TryLease(), "a complete result can be leased");
        var whileLeased = set.Pack();
        set.ReleaseLease();
        check(whilePinned == 0 && whileLeased == 0 && open.Pack() == 0 && !set.HasPacked && store.UsedBytes == used,
            "a pinned, leased or open result is not packed");
        var saved = set.Pack();
        var usedPacked = store.UsedBytes;
        var pages = set.SealedSnapshot();
        var charges = PageCharges(set);
        var after = Bodies(set);
        var counters = store.PackingSnapshot();
        var logical = pages.Sum(page => (long)page.Length);
        var packedBytes = pages.Sum(page => (long)((PackedPage)page.Stored).Bytes.Length);
        check(saved > logical / 2 && pages.All(page => page.Stored is PackedPage) && set.HasPacked && usedPacked == used - saved
            && usedPacked - open.Budget.UsedBytes == charges && saved == logical - packedBytes,
            "packing a complete result charges each page its packed length, overhead and sidecar, and gives the saving back to the budget at once: " + saved + " of " + logical);
        check(store.FreedSinceCollect == collect + saved && store.FreedSinceCompact == compact,
            "the saving counts toward the next collection but never toward a compacting one");
        check(before.Length == after.Length && before.Zip(after).All(pair => pair.First.AsSpan().SequenceEqual(pair.Second)),
            "a packed page reads through the accessor as the bytes it sealed");
        check(counters is { PagesPacked: > 0, PagesKeptRaw: 0 } && counters.PackedBytes == packedBytes && counters.PackedLogicalBytes == logical && counters.PackTicks > 0
            && counters.PackedInBytes == logical && counters.PackedOutBytes == packedBytes && counters.UnpackTicks > 0 && counters.PagesUnpacked >= pages.Length,
            "the store counts what it packed and unpacked, and the time it took");
        check(set.Pack() == 0 && store.PackingSnapshot().PagesPacked == counters.PagesPacked, "packing again finds nothing to pack");
        var freed = store.Release(set.ResultId);
        check(freed && store.UsedBytes == open.Budget.UsedBytes && store.PackingSnapshot() is { PackedBytes: 0, PackedLogicalBytes: 0, CacheBytes: 0 },
            "releasing a packed result returns every byte it holds, packed and cached");
    }

    private static void KeepsRaw(Action<bool, string> check)
    {
        var store = Store(PagePacking.OnRequest);
        var set = Random(store, "random", 600);
        var used = store.UsedBytes;
        var saved = set.Pack();
        var kept = store.PackingSnapshot();
        var again = set.Pack();
        check(saved == 0 && again == 0 && !set.HasPacked && store.UsedBytes == used && set.SealedSnapshot().All(page => page.Stored is byte[] && page.KeptRaw)
            && kept.PagesKeptRaw == set.SealedSnapshot().Length && store.PackingSnapshot().PackedInBytes == kept.PackedInBytes,
            "a page that packing saves less than a tenth of stays raw, and is not tried again");
        var every = Store(PagePacking.EveryComplete);
        var forced = Random(every, "every", 600);
        check(forced.SealedSnapshot().All(page => page.Stored is PackedPage) && every.UsedBytes - 0 == PageCharges(forced) && Bodies(forced).Length > 0,
            "the checks' mode packs every page of a complete result, even one that grows, and charges what it holds");
    }

    private static void Cache(Action<bool, string> check)
    {
        var store = Store(PagePacking.OnRequest);
        var set = Filled(store, "cache", 120_000);
        set.Pack();
        var pages = set.SealedSnapshot();
        var charged = store.UsedBytes;
        var hits = store.PackingSnapshot().CacheHits;
        long cached;
        using (set.Pin())
        {
            foreach (var page in pages.Take(ResultSetBuffer.CachePages + 2)) page.Body();
            cached = pages.Skip(2).Take(ResultSetBuffer.CachePages).Sum(page => (long)page.Length);
            pages[^1].Body();
        }
        var afterReads = store.UsedBytes;
        var snapshot = store.PackingSnapshot();
        using (set.Pin()) pages[^1].Body();
        check(pages.Length > ResultSetBuffer.CachePages + 3 && snapshot.CacheBytes == cached - pages[2].Length + pages[^1].Length && afterReads == charged + snapshot.CacheBytes
            && store.PackingSnapshot().CacheHits == hits + 1,
            "the pages read from packed ones are kept unpacked, the newest six, charged as working memory, and a read of one kept is a hit");
        store.Release(set.ResultId);
        check(store.UsedBytes == 0 && store.PackingSnapshot() is { CacheBytes: 0, PackedBytes: 0 }, "the cache goes with its result");
    }

    private static void UnpacksWhole(Action<bool, string> check)
    {
        var store = Store(PagePacking.OnRequest);
        var set = Filled(store, "whole", 60_000);
        var raw = store.UsedBytes;
        var before = Bodies(set);
        set.Pack();
        var packed = store.UsedBytes;
        var threw = false;
        try { set.TryUnpackAll(); } catch (InvalidOperationException) { threw = true; }
        bool unpacked;
        using (set.Pin())
        {
            set.SealedSnapshot()[0].Body();
            unpacked = set.TryUnpackAll();
        }
        check(threw && unpacked && !set.HasPacked && store.UsedBytes == raw && set.SealedSnapshot().All(page => page.Stored is byte[]) && store.PackingSnapshot() is { CacheBytes: 0, PackedBytes: 0 }
            && Bodies(set).Zip(before).All(pair => pair.First.AsSpan().SequenceEqual(pair.Second)),
            "unpacking a result whole needs a pin, charges its pages as sealed again, drops their cached copies and reads the same bytes: " + packed + " -> " + store.UsedBytes);

        // The budget refuses the bytes unpacking adds: nothing changes, and plain reads still work.
        var tight = Store(PagePacking.OnRequest, 64L << 20);
        var big = Filled(tight, "tight", 60_000);
        big.Pack();
        var other = tight.BeginQuery("filler");
        var room = tight.GlobalBytes - tight.UsedBytes - 1024;
        var filled = tight.TryReserve(other, room, false, out _);
        var used = tight.UsedBytes;
        bool refused;
        byte[] read;
        using (big.Pin())
        {
            refused = !big.TryUnpackAll();
            read = big.SealedSnapshot()[0].Body();
        }
        check(filled && refused && big.HasPacked && big.SealedSnapshot().All(page => page.Stored is PackedPage) && tight.UsedBytes == used + read.Length,
            "a refused unpack changes nothing, and the result still reads through the cache");
    }

    private static void ViewReads(Action<bool, string> check)
    {
        var store = Store(PagePacking.OnRequest);
        var set = Filled(store, "views", 60_000);
        var rows = (int)set.RowsAvailable;
        var order = Enumerable.Range(0, rows).OrderBy(row => (row * 2654435761u) % 1000003).ToArray();
        var view = store.AddView(set, order, [], false, true, 0, null);
        byte[][] Read() => [.. ViewPages.Build(view, 1000, 6000).Select(page => page.Body())];
        var raw = Read();
        set.Pack();
        var used = store.UsedBytes;
        var unpacked = store.PackingSnapshot().PagesUnpacked;
        var packed = Read();
        check(raw.Length == packed.Length && raw.Zip(packed).All(pair => pair.First.AsSpan().SequenceEqual(pair.Second)) && store.UsedBytes == used
            && store.PackingSnapshot().PagesUnpacked - unpacked >= set.SealedSnapshot().Length / 2,
            "a view read of a packed result unpacks its base pages together, reads the same pages, and returns the working memory");

        var tight = Store(PagePacking.OnRequest, 64L << 20);
        var big = Filled(tight, "tight", 60_000);
        var bigView = tight.AddView(big, order, [], false, true, 0, null);
        var expected = ViewPages.Build(bigView, 0, 3000).Select(page => page.Body()).ToArray();
        big.Pack();
        tight.TryReserve(tight.BeginQuery("filler"), tight.GlobalBytes - tight.UsedBytes - 4 * 1024 * 1024, false, out _);
        var narrow = ViewPages.Build(bigView, 0, 3000).Select(page => page.Body()).ToArray();
        check(narrow.Zip(expected).All(pair => pair.First.AsSpan().SequenceEqual(pair.Second)) && narrow.Length == expected.Length,
            "with no room to unpack pages together a view read still reads them one at a time");
    }

    private static void Service(Action<bool, string> check)
    {
        var store = Store(PagePacking.OnRequest, 64L << 20);
        using var service = new SqlService(store);
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        string? Code(string method, object args)
        {
            try { Call<object>(method, args); return null; }
            catch (RequestException error) { return error.Code; }
        }
        var set = Filled(store, "service", 60_000);
        set.Pack();
        var packed = store.UsedBytes;
        var sorted = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 0, descending = true, mode = "value" } } });
        check(sorted.Rows == set.RowsAvailable && !set.HasPacked && store.UsedBytes > packed,
            "an operation on the whole result unpacks it first and leaves it unpacked for the stage-1 policy to pack again");
        set.Pack();
        var filler = store.BeginQuery("filler");
        store.TryReserve(filler, store.GlobalBytes - store.UsedBytes - 1024, false, out _);
        var code = Code("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 1, descending = false, mode = "value" } } });
        check(code == "TOO_LARGE" && set.HasPacked, "an operation whose result cannot be unpacked for want of budget answers TOO_LARGE and leaves it packed");
    }
}
