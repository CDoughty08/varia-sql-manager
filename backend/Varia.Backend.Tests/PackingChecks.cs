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

    private static ResultSetBuffer Filled(ResultStore store, string session, long rows, QueryBudget? query = null, int index = 0)
    {
        var set = store.Open(query ?? store.BeginQuery(session), index, 1, 1, "rows", W1Columns, W1Wires) ?? throw new InvalidOperationException("The result set was not kept.");
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

    /// <summary>A set of one binary column of random bytes, which Zstandard cannot shrink. Cells larger than a page make
    /// pages of one row, which grow when packed: the codec's framing outweighs the one offset the lengths form saves.</summary>
    private static ResultSetBuffer Random(ResultStore store, string session, int rows, int cellBytes = 2000)
    {
        var set = store.Open(store.BeginQuery(session), 0, 1, 1, "rows", [new ResultColumn("b", "varbinary", "binary")], [WireKind.Binary])!;
        var random = new Random(7);
        var cell = new byte[cellBytes];
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
        + set.SealedSnapshot().Sum(page => (page.Stored is PackedPage packed ? packed.Charged : page.Length) + ResultStore.PageOverhead + page.Lengths.MemoryBytes);

    public static void Run(Action<bool, string> check)
    {
        Codec(check);
        LengthsForm(check);
        Switch(check);
        Packs(check);
        KeepsRaw(check);
        Cache(check);
        UnpacksWhole(check);
        ViewReads(check);
        Service(check);
    }

    /// <summary>A page with every kind of column the lengths form treats apart: one width (with and without NULLs), many
    /// widths, all NULL, all empty, binary, failed and truncated cells, at row counts that end bitmaps mid-byte. With
    /// <paramref name="emptyLast"/> a last column of NULLs and empty strings holds no data, so at an even row count the
    /// blob ends in padding after its offsets.</summary>
    private static byte[] MixedPage(int rows, bool emptyLast = false)
    {
        var builder = new PageBuilder(1, [WireKind.Text, WireKind.Text, WireKind.Text, WireKind.Text, WireKind.Text, WireKind.Binary, WireKind.Text, .. emptyLast ? new[] { WireKind.Text } : []]);
        for (var row = 0; row < rows; row++)
        {
            builder.BeginRow();
            builder.AppendText($"2026-11-{row % 28 + 1:00}");
            if (row % 5 == 0) builder.AppendNull(); else builder.AppendText($"{row * 37 % 1000:000}");
            builder.AppendText(row % 3 == 0 ? "" : "order " + row * 7919 % 100_003 + new string('x', row % 40));
            builder.AppendNull(error: row % 11 == 0);
            builder.AppendText("");
            builder.AppendBinary(BitConverter.GetBytes((long)row * 2654435761)[..(1 + row % 8)]);
            builder.AppendText("note " + row, truncated: row % 13 == 0);
            if (emptyLast) { if (row % 2 == 0) builder.AppendNull(); else builder.AppendText(""); }
            builder.CommitRow();
        }
        return builder.Seal();
    }

    private static void LengthsForm(Action<bool, string> check)
    {
        var pages = new[] { 1, 7, 64, 1000, PageBuilder.MaxRows }.Select(rows => MixedPage(rows)).ToList();
        var formed = pages.All(page => PageCodec.Pack(page) is { } packed && packed[0] == 1 && PageCodec.Unpack(packed, page.Length).AsSpan().SequenceEqual(page));
        var room = new byte[pages[^1].Length];
        PageCodec.UnpackInto(PageCodec.Pack(pages[^1])!, room);
        check(formed && room.AsSpan().SequenceEqual(pages[^1]),
            "a sealed page packs in its lengths form and unpacks to its bytes as sealed, alone or into a fused read's room");
        var emptyLast = new[] { 1, 2, 7, 64, 1000, PageBuilder.MaxRows }.Select(rows => MixedPage(rows, emptyLast: true)).ToList();
        check(emptyLast.All(page => PageCodec.Pack(page) is { } packed && packed[0] == 1 && PageCodec.Unpack(packed, page.Length).AsSpan().SequenceEqual(page)),
            "a page whose last column holds no data packs in its lengths form too, at odd and even row counts");

        // A lengths form changed anywhere unpacks to some bytes or fails as unreadable, never with another error.
        var formed1000 = PageCodec.Pack(pages[3])!;
        var formAt = 1;
        while (formed1000[formAt++] >= 0x80) { }
        var form = new byte[pages[3].Length];
        System.IO.Compression.ZstandardDecoder.TryDecompress(formed1000.AsSpan(formAt), form, out var formLength);
        var corrupt = new Random(5);
        var failures = 0;
        var unexpected = new List<string>();
        for (var trial = 0; trial < 2000; trial++)
        {
            var changed = form.AsSpan(0, formLength).ToArray();
            // Half the changes land in the header and the first columns' regions, where most of the layout and lengths are.
            changed[corrupt.Next(trial % 2 == 0 ? changed.Length : 1024)] ^= (byte)(1 + corrupt.Next(255));
            var frame = new byte[System.IO.Compression.ZstandardEncoder.GetMaxCompressedLength(changed.Length)];
            System.IO.Compression.ZstandardEncoder.TryCompress(changed, frame, out var frameLength, PageCodec.Quality, PageCodec.Window);
            byte[] repacked = [.. formed1000.AsSpan(0, formAt), .. frame.AsSpan(0, frameLength)];
            try { PageCodec.Unpack(repacked, pages[3].Length); }
            catch (InvalidDataException) { failures++; }
            catch (Exception error) { unexpected.Add(error.GetType().Name); }
        }
        // A form cut short anywhere, its prefix saying the shorter length, fails as unreadable too.
        var cutFailures = 0;
        for (var cut = 1; cut < formLength; cut += Math.Max(1, cut / 2))
        {
            var shorter = form.AsSpan(0, formLength - cut).ToArray();
            var frame = new byte[System.IO.Compression.ZstandardEncoder.GetMaxCompressedLength(Math.Max(1, shorter.Length))];
            System.IO.Compression.ZstandardEncoder.TryCompress(shorter, frame, out var frameLength, PageCodec.Quality, PageCodec.Window);
            var prefix = new List<byte> { 1 };
            for (var value = (uint)shorter.Length; ; value >>= 7)
            {
                if (value < 0x80) { prefix.Add((byte)value); break; }
                prefix.Add((byte)(value | 0x80));
            }
            try { PageCodec.Unpack([.. prefix, .. frame.AsSpan(0, frameLength)], pages[3].Length); unexpected.Add("none"); }
            catch (InvalidDataException) { cutFailures++; }
            catch (Exception error) { unexpected.Add(error.GetType().Name); }
        }
        // A damaged prefix or frame: an unknown marker, a form longer than the page, a page as sealed of the wrong length,
        // a frame cut short.
        byte[][] damaged =
        [
            [2, .. formed1000.AsSpan(1)],
            [1, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F, .. formed1000.AsSpan(formAt)],
            [0, .. formed1000.AsSpan(1)],
            formed1000[..(formed1000.Length - 8)],
            formed1000[..formAt],
        ];
        foreach (var bytes in damaged)
        {
            try { PageCodec.Unpack(bytes, pages[3].Length); unexpected.Add("none"); }
            catch (InvalidDataException) { }
            catch (Exception error) { unexpected.Add(error.GetType().Name); }
        }
        check(unexpected.Count == 0 && failures >= 200 && cutFailures > 10,
            $"a changed or shortened lengths form unpacks or fails as unreadable ({failures} of 2000 changed and {cutFailures} shortened unreadable; other outcomes: {string.Join(", ", unexpected.Distinct())})");

        // Offsets as lengths: a page of short numbers packs well under Zstandard over the page as sealed.
        var numbers = new PageBuilder(1, [WireKind.Text, WireKind.Text, WireKind.Text]);
        for (var row = 0; row < 4000; row++)
        {
            numbers.BeginRow();
            numbers.AppendText((row * 7919 % 100_000).ToString());
            numbers.AppendText((row * 104_729L % 1_000_000_007).ToString());
            numbers.AppendText($"{row % 1000 / 10.0:0.00}");
            numbers.CommitRow();
        }
        var sealedPage = numbers.Seal();
        var plain = new byte[sealedPage.Length * 2];
        System.IO.Compression.ZstandardEncoder.TryCompress(sealedPage, plain, out var plainLength, PageCodec.Quality, PageCodec.Window);
        var asLengths = PageCodec.Pack(sealedPage)!.Length;
        check(asLengths < plainLength * 0.8, $"offsets packed as lengths take under four fifths of the page packed as sealed ({asLengths} of {plainLength} bytes)");

        // Bytes that are not exactly a sealed page (a byte changed anywhere, a page cut short or doubled) still unpack to
        // themselves: the codec packs them as they are when the form could not restore them.
        var random = new Random(11);
        var page = pages[2];
        var exact = true;
        for (var trial = 0; trial < 400 && exact; trial++)
        {
            var changed = page.ToArray();
            changed[random.Next(changed.Length)] ^= (byte)(1 + random.Next(255));
            exact = PageCodec.Pack(changed) is { } packed && PageCodec.Unpack(packed, changed.Length).AsSpan().SequenceEqual(changed);
        }
        foreach (var odd in new[] { page[..(page.Length / 2)], [.. page, .. page], [.. page, 0], [] })
            exact &= PageCodec.Pack(odd) is { } packed && PageCodec.Unpack(packed, odd.Length).AsSpan().SequenceEqual(odd);
        check(exact, "bytes that are not exactly a sealed page unpack to themselves");
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
        // A packed page is charged its bytes and its Find filter's (PageFilter).
        var packedBytes = pages.Sum(page => ((PackedPage)page.Stored).Charged);
        check(pages.Any(page => page.Filter is not null), "packing builds Find filters for the result's pages");
        check(saved > logical / 2 && pages.All(page => page.Stored is PackedPage) && set.HasPacked && usedPacked == used - saved
            && usedPacked - open.Budget.UsedBytes == charges && saved == logical - packedBytes,
            "packing a complete result charges each page its packed length, filter, overhead and sidecar, and gives the saving back to the budget at once: " + saved + " of " + logical);
        check(store.FreedSinceCollect == collect + saved && store.FreedSinceCompact == compact,
            "the saving counts toward the next collection but never toward a compacting one");
        check(before.Length == after.Length && before.Zip(after).All(pair => pair.First.AsSpan().SequenceEqual(pair.Second)),
            "a packed page reads through the accessor as the bytes it sealed");
        check(counters is { PagesPacked: > 0, PagesKeptRaw: 0 } && counters.PackedBytes == packedBytes && counters.PackedLogicalBytes == logical && counters.PackTicks > 0
            && counters.PackedInBytes == logical && counters.PackedOutBytes == pages.Sum(page => (long)((PackedPage)page.Stored).Bytes.Length) && counters.UnpackTicks > 0 && counters.PagesUnpacked >= pages.Length,
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
        var forced = Random(every, "every", 4, PageBuilder.SealBytes + 1000);
        check(forced.SealedSnapshot().All(page => page.Stored is PackedPage packed && packed.Bytes.Length > page.Length) && every.UsedBytes - 0 == PageCharges(forced) && Bodies(forced).Length > 0,
            "the checks' mode packs every page of a complete result, even one that grows, and charges what it holds");
        // Unpacking pages that grew needs no bytes, but they are unpacked all the same, and give back what they grew by.
        bool grownUnpacked;
        using (forced.Pin())
        {
            grownUnpacked = forced.UnpackNeed() == 0 && forced.TryUnpackAll() && forced.SealedSnapshot().All(page => page.Stored is byte[]) && !forced.HasPacked
                && every.UsedBytes == PageCharges(forced);
        }
        check(grownUnpacked, "an operation unpacks a result whose packed pages grew, though unpacking needs no bytes");
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
        check(filled && refused && big.HasPacked && big.SealedSnapshot().All(page => page.Stored is PackedPage) && read.Length > 0 && tight.UsedBytes == used
            && tight.PackingSnapshot().CacheBytes == 0,
            "a refused unpack changes nothing, and the result still reads, unpacked for the read alone: a full budget keeps no cached page");
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

        // A cancelled group read gives back what it reserved and reports nothing held, so its caller returns nothing twice.
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        long held = -1;
        var threw = false;
        using (set.Pin())
        {
            try { set.BodiesTogether([.. set.SealedSnapshot().Take(8)], out held, cancelled.Token); }
            catch (OperationCanceledException) { threw = true; }
        }
        check(threw && held == 0 && store.UsedBytes == used, "a cancelled group read returns its working memory and reports none held");

        var tight = Store(PagePacking.OnRequest, 64L << 20);
        var big = Filled(tight, "tight", 60_000);
        var bigView = tight.AddView(big, order, [], false, true, 0, null);
        var expected = ViewPages.Build(bigView, 0, 3000).Select(page => page.Body()).ToArray();
        big.Pack();
        tight.TryReserve(tight.BeginQuery("filler"), tight.GlobalBytes - tight.UsedBytes - 4 * 1024 * 1024, false, out _);
        var narrow = ViewPages.Build(bigView, 0, 3000).Select(page => page.Body()).ToArray();
        check(narrow.Zip(expected).All(pair => pair.First.AsSpan().SequenceEqual(pair.Second)) && narrow.Length == expected.Length,
            "with no room to unpack pages together a view read still reads them one at a time");

        // With no room for a group or the cache, a view in base order unpacks each page once (again after each output page,
        // which keeps nothing across a wait for credit), not once a row.
        tight.TryReserve(tight.BeginQuery("filler"), tight.GlobalBytes - tight.UsedBytes - 64 * 1024, false, out _);
        var baseView = tight.AddView(big, [.. Enumerable.Range(0, (int)big.RowsAvailable)], [], false, true, 0, null);
        var unpackedBefore = tight.PackingSnapshot().PagesUnpacked;
        var inOrder = ViewPages.Build(baseView, 0, 20_000).Select(page => page.Body()).ToArray();
        var touched = big.SealedSnapshot().Count(page => page.FirstRow < 20_000);
        check(inOrder.Length > 0 && touched > 1 && tight.PackingSnapshot().PagesUnpacked - unpackedBefore <= touched + inOrder.Length && tight.PackingSnapshot().CacheBytes == 0,
            "a view read refused room for groups and the cache unpacks each base page once an output page, not once a row");
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
        // A search in the result's own order reads it fused and leaves it packed (FusedReadChecks); through a view far from
        // its pages' order (sorted by amount) it reads it in page order, and leaves it packed too.
        Call<object>("results.search", new { resultId = set.ResultId, text = "59999", fromRow = 0, maxMatches = 1 });
        check(set.HasPacked && set.SealedSnapshot().All(page => page.Stored is PackedPage) && store.UsedBytes - (set.SearchMemo?.Bytes ?? 0) == packed,
            "a search of a packed result in its own order reads it fused and leaves it packed (holding only its type-ahead memo)");
        var byAmount = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 3, descending = false, mode = "value" } } });
        packed = store.UsedBytes - (set.SearchMemo?.Bytes ?? 0);
        Call<object>("results.search", new { resultId = set.ResultId, viewId = byAmount.ViewId, text = "59999", fromRow = 0, maxMatches = 1 });
        check(set.HasPacked && set.SealedSnapshot().All(page => page.Stored is PackedPage) && store.UsedBytes - (set.SearchMemo?.Bytes ?? 0) == packed && set.Unpacks == 0,
            "a search through a sorted view of a packed result reads it in page order, leaves it packed and holds nothing afterwards");
        // Unpacked, for the transposed Copy's raw estimate below.
        using (set.Pin()) check(set.TryUnpackAll() && !set.HasPacked, "the fixture: the result unpacked");
        // A transposed Copy keeps the pages its rows lie on: it unpacks only those, as working memory returned when it ends.
        CopyPartArgs[] scattered = [new([[0, 0], [8000, 8000], [16000, 16000], [24000, 24000], [32000, 32000], [40000, 40000], [48000, 48000], [56000, 56000]], [[0, 1]])];
        var rawTurned = ResultJobs.EstimateCopy(set, scattered, true, false, transposed: true);
        set.Pack();
        packed = store.UsedBytes;
        var turnedBytes = ResultJobs.EstimateCopy(set, scattered, true, false, transposed: true);
        check(turnedBytes == rawTurned && turnedBytes > 0 && set.HasPacked && set.SealedSnapshot().All(page => page.Stored is PackedPage) && store.UsedBytes == packed,
            "a transposed Copy of a packed result reads its rows' pages unpacked, leaves the result packed and returns the working memory");
        var sorted = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 0, descending = true, mode = "value" } } });
        check(sorted.Rows == set.RowsAvailable && set.HasPacked && store.UsedBytes == packed + 4 * set.RowsAvailable + ResultStore.ViewOverhead,
            "a sort of a packed result reads it fused (FusedReadChecks): it stays packed and holds only the view's order afterwards");
        set.Pack();
        var filler = store.BeginQuery("filler");
        store.TryReserve(filler, store.GlobalBytes - store.UsedBytes - 1024, false, out _);
        var code = Code("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 1, descending = false, mode = "value" } } });
        check(code == "TOO_LARGE" && set.HasPacked, "an operation whose result cannot be unpacked for want of budget answers TOO_LARGE and leaves it packed");
        string? turnedCode = null;
        try { ResultJobs.EstimateCopy(set, scattered, true, false, transposed: true); }
        catch (RequestException error) { turnedCode = error.Code; }
        check(turnedCode == "TOO_LARGE" && set.HasPacked, "a transposed Copy that cannot unpack the result answers TOO_LARGE and leaves it packed");

        // A diff reads both results fused: with room to unpack only one of them (which answered TOO_LARGE when a diff unpacked
        // both first), it answers and both stay packed.
        var pair = Store(PagePacking.OnRequest, 96L << 20);
        using var pairService = new SqlService(pair);
        var query = pair.BeginQuery("pair");
        var left = Filled(pair, "pair", 40_000, query, 0);
        var right = Filled(pair, "pair", 40_000, query, 1);
        left.Pack();
        right.Pack();
        long leftNeed, rightNeed;
        using (left.Pin()) leftNeed = left.UnpackNeed();
        using (right.Pin()) rightNeed = right.UnpackNeed();
        var pairFiller = pair.BeginQuery("filler");
        var pairFilled = pair.TryReserve(pairFiller, pair.GlobalBytes - pair.UsedBytes - leftNeed - rightNeed / 2, false, out _);
        var pairUsed = pair.UsedBytes;
        var diff = (ResultsDiffResult)pairService.DispatchAsync("results.diff", JsonSerializer.SerializeToElement(new { left = left.ResultId, right = right.ResultId, context = 0 }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        pair.Release([diff.Descriptor.ResultId]);
        check(pairFilled && leftNeed > 0 && rightNeed > 0 && diff.Same == 40_000 && diff.Changed + diff.Added + diff.Removed == 0 && left.HasPacked && right.HasPacked
            && left.SealedSnapshot().All(page => page.Stored is PackedPage) && right.SealedSnapshot().All(page => page.Stored is PackedPage) && pair.UsedBytes == pairUsed,
            "a diff with room to unpack only one of its results reads both fused, answers and leaves both packed");
    }
}
