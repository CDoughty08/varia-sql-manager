using System.Globalization;
using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Fused per-page reads (ViewSorter.PageSource, PageRooms): sorts, filters, profiles and pivots of a packed result
/// read its pages fused, each worker unpacking the page it reads into a room reserved from the budget, and give exactly
/// what they give over the same rows unpacked. Ties that go back to cells read an extract of their column, not a page
/// unpacked a comparison. Cancellation and refused rooms or extracts leave the result packed and the budget as it was.
/// The suite sets each store's packing itself, so it is not in the packed pass.</summary>
internal static partial class FusedReadChecks
{
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);

    /// <summary>id, grp (6 values, collated, some NULL), dec (decimal(38,10), 40 values of long text: ties a double cannot
    /// break), txt (collated text sharing a long start, 3,000 values), f (float), note (prose-like text, 20 % NULL).</summary>
    private static readonly IReadOnlyList<ResultColumn> Columns =
    [
        new("id", "int", "text", Nullable: false),
        new("grp", "nvarchar(20)", "text", Collation: CaseInsensitive),
        new("dec", "decimal(38,10)", "text", Precision: 38, Scale: 10),
        new("txt", "nvarchar(80)", "text", Collation: CaseInsensitive),
        new("f", "float", "text", Precision: 53),
        new("note", "nvarchar(400)", "text", Collation: CaseInsensitive),
    ];
    private static readonly IReadOnlyList<WireKind> Wires = [.. Columns.Select(_ => WireKind.Text)];
    private static readonly string[] Groups = ["Open", "open", "Shipped", "Pending", "Cancelled", "Returned"];
    private const int Rows = 40_000;

    private static ulong Mix(long row, ulong salt)
    {
        var z = (ulong)row * 0x9E3779B97F4A7C15UL + salt;
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
        return z ^ (z >> 31);
    }

    /// <param name="query">The query the set is a result of (a new one when null): a diff's two results share one.</param>
    /// <param name="rowAt">Which fixture row the k-th row stored is (its own by default): another order of the same rows.</param>
    /// <param name="changed">Whether a fixture row's values change (a diff's second result): its <c>grp</c> in case only (a
    /// soft difference) and its <c>dec</c>.</param>
    private static ResultSetBuffer Filled(ResultStore store, string session, int rows = Rows, QueryBudget? query = null, int index = 0, Func<int, int>? rowAt = null,
        Func<int, bool>? changed = null, IReadOnlyList<ResultColumn>? columns = null)
    {
        var set = store.Open(query ?? store.BeginQuery(session), index, 1, 1, "rows", columns ?? Columns, Wires) ?? throw new InvalidOperationException("The result set was not kept.");
        for (var k = 0; k < rows; k++)
        {
            var row = rowAt?.Invoke(k) ?? k;
            var change = changed?.Invoke(row) == true;
            set.CountRow();
            if (set.BeginRow() is not { } builder) continue;
            builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), row));
            if (Mix(row, 1) % 17 == 0) builder.AppendNull();
            else if (change) builder.AppendText(Groups[Mix(row, 2) % (ulong)Groups.Length].ToUpperInvariant());
            else builder.AppendText(Groups[Mix(row, 2) % (ulong)Groups.Length]);
            var whole = (long)(Mix(row, 3) % 40) * 1_000_000_007L - 9_000_000_000L + (change ? 1 : 0);
            builder.AppendText(whole.ToString(CultureInfo.InvariantCulture) + ".1234567891");
            builder.AppendText("CUSTOMER-ACCOUNT-REFERENCE-" + (Mix(row, 4) % 3000).ToString("D6", CultureInfo.InvariantCulture));
            builder.EndFormatted(CellFormat.WriteFloat(builder.BeginFormatted(), (Mix(row, 5) % 100_000) / 7.0));
            if (Mix(row, 6) % 5 == 0) builder.AppendNull();
            else builder.AppendText(string.Join(' ', Enumerable.Range(0, (int)(Mix(row, 7) % 30) + 3).Select(word => "word" + Mix(row * 31 + word, 8) % 500)));
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    /// <summary>A store whose sets stay as sealed, and one whose sets are all packed (every page, at once).</summary>
    private static ResultStore Raw(long bytes = 1L << 30) => new(bytes, bytes) { Packing = PagePacking.Off };
    private static ResultStore Packed(long bytes = 1L << 30) => new(bytes, bytes) { Packing = PagePacking.EveryComplete };

    private static string Json(object value) => JsonSerializer.Serialize(value, HostChecks.Json);

    public static void Run(Action<bool, string> check)
    {
        // Several workers whatever the machine, so the fused paths run in parallel on a small runner too.
        using (ViewSorter.WorkersHere(4))
        {
            Same(check);
            Mixed(check);
            Ties(check);
        }
        Cancelled(check);
        Refused(check);
    }

    /// <summary>Run from Store's isolated lane: returning a room keeps it reusable and charged until disposal, which must
    /// drop its unpooled buffer even while the disposed owner stays reachable (PageSource.Rehydrate keeps that owner).</summary>
    public static void ReturnedRooms(Action<bool, string> check)
    {
        var store = Raw();
        var set = Filled(store, "room ownership", rows: 1);
        var before = store.UsedBytes;
        const int bytes = 128 << 10;
        using var rooms = new PageRooms(set, bytes, 0, () => new InvalidOperationException("The room was refused."));
        var buffer = ReturnedRoom(rooms);
        GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true);
        check(buffer.IsAlive && rooms.Made == 1 && rooms.Reserved == bytes && store.UsedBytes == before + bytes,
            "a returned fused-read room stays reusable and charged while its owner is open");
        rooms.Dispose();
        rooms.Dispose();
        GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true);
        check(!buffer.IsAlive && rooms.Made == 0 && rooms.Reserved == 0 && store.UsedBytes == before,
            "a still-reachable disposed fused-read rooms owner drops its returned buffer and returns its reservation exactly once");
        var refused = false;
        try { rooms.Rent(); }
        catch (ObjectDisposedException) { refused = true; }
        check(refused && store.UsedBytes == before, "disposed fused-read rooms refuse new rentals without taking budget");
        GC.KeepAlive(rooms);
    }

    // The renting frame must end before collection, so no JIT-kept local can retain the room or its buffer.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static WeakReference ReturnedRoom(PageRooms rooms)
    {
        using var room = rooms.Rent();
        return new WeakReference(room.Bytes);
    }

    private static (int[] Order, bool Approximate, string Filters) View(ResultSetBuffer set, ViewKey[] keys, ViewFilter[] filters, ViewSorter.KeyMemory? memory = null, CancellationToken token = default)
    {
        var built = ViewSorter.Build(set, set.SealedSnapshot(), keys, filters, token, memory);
        return (built.Order, built.Approximate, Json(built.Filters.Select(filter => new { filter.Op, filter.Column, filter.Rows, filter.Nulls })));
    }

    private static PivotSpec Spec => new([1], -1, [new(PivotAggregate.Count, -1), new(PivotAggregate.Sum, 2), new(PivotAggregate.Avg, 4), new(PivotAggregate.Max, 3),
        new(PivotAggregate.Min, 5), new(PivotAggregate.CountDistinct, 3)]);

    /// <summary>A pivot of the set written out as a derived result, and its pages' bytes.</summary>
    private static byte[][] Pivot(ResultStore store, ResultSetBuffer set, PivotSpec spec, CancellationToken token = default, Func<long, bool>? reserve = null)
    {
        var pages = set.SealedSnapshot();
        var model = ResultPivoter.Build(set, pages, null, spec, token, reserve ?? (_ => true));
        var (columns, wires, lengths) = PivotOutput.Shape(set, pages, spec, model);
        var pivot = store.Open(set.Budget, 0, 1, 1, "pivot", columns, wires, lengths: lengths, derived: true)!;
        PivotOutput.Write(pivot, set, pages, spec, model, token);
        byte[][] bodies;
        using (pivot.Pin()) bodies = [.. pivot.SealedSnapshot().Select(page => page.Body())];
        store.Release(pivot.ResultId);
        return bodies;
    }

    private static void Same(Action<bool, string> check)
    {
        var rawStore = Raw();
        var packedStore = Packed();
        var raw = Filled(rawStore, "raw");
        var packed = Filled(packedStore, "packed");
        var packedBytes = packedStore.PackingSnapshot().PackedBytes;
        var used = packedStore.UsedBytes;
        check(packed.HasPacked && !raw.HasPacked && packed.SealedSnapshot().Length > 8 && packedBytes > 0, "the fused checks' packed copy is packed and its raw copy is not");
        // A read that unpacked the result whole would leave it alike once repacked (the store packs every complete result
        // as its last pin goes), but would pack its pages again: the pages packed must not move.
        var pagesPacked = packedStore.PackingSnapshot().PagesPacked;
        bool Kept() => packed.HasPacked && packedStore.PackingSnapshot() is { CacheBytes: 0 } counters && counters.PackedBytes == packedBytes
            && counters.PagesPacked == pagesPacked && packedStore.UsedBytes == used;

        ViewKey[][] sorts =
        [
            [new(0, true, SortMode.Value)],
            [new(1, false, SortMode.Value), new(4, true, SortMode.Value)],
            [new(2, false, SortMode.Value)],
            [new(3, false, SortMode.Value)],
            [new(5, true, SortMode.Value), new(0, false, SortMode.Value)],
            [new(5, false, SortMode.Chars)],
        ];
        foreach (var keys in sorts)
        {
            var name = string.Join(",", keys.Select(key => key.Column + (key.Descending ? "d" : "a") + key.Mode));
            // With key memory and without: whole values kept, or 8 bytes and ties read from cells.
            var expected = View(raw, keys, []);
            var memory = new ViewSorter.KeyMemory(_ => false, _ => { });
            var unpackedBefore = packedStore.PackingSnapshot().PagesUnpacked;
            var actual = View(packed, keys, []);
            var narrow = View(packed, keys, [], memory);
            var narrowExpected = View(raw, keys, [], new ViewSorter.KeyMemory(_ => false, _ => { }));
            check(actual.Order.SequenceEqual(expected.Order) && actual.Approximate == expected.Approximate && narrow.Order.SequenceEqual(narrowExpected.Order) && narrow.Order.SequenceEqual(expected.Order) && Kept(),
                "a sort by " + name + " of a packed result gives the order it gives unpacked, with and without room for whole keys, and leaves the result packed and the budget as it was");
            var unpacked = packedStore.PackingSnapshot().PagesUnpacked - unpackedBefore;
            // Each pass reads a page once: a key built, filled again or extracted. Never a page a comparison.
            check(unpacked <= 12L * packed.SealedSnapshot().Length * keys.Length, "a sort by " + name + " of a packed result unpacks a bounded number of pages, not one a comparison: " + unpacked);
        }

        ViewFilter[][] filterSets =
        [
            [new(FilterOp.In, 1, [0, 3], false, null, [])],
            [new(FilterOp.NotIn, 2, [0], true, null, [])],
            [new(FilterOp.Between, 3, [1, 2], false, null, []), new(FilterOp.In, 1, [5], true, null, [])],
            [new(FilterOp.Duplicates, -1, null, false, null, [1, 2])],
            [new(FilterOp.In, 5, [0, 7, 9], false, null, [])],
        ];
        foreach (var filters in filterSets)
        {
            var name = string.Join(",", filters.Select(filter => filter.Op + ":" + filter.Column));
            var expected = View(raw, [new(0, true, SortMode.Value)], filters);
            var actual = View(packed, [new(0, true, SortMode.Value)], filters);
            check(actual.Order.SequenceEqual(expected.Order) && actual.Filters == expected.Filters && actual.Approximate == expected.Approximate && Kept(),
                "a filter (" + name + ") of a packed result keeps the rows it keeps unpacked, resolved alike, and leaves the result packed");
        }

        int[] profiled = [0, 1, 2, 3, 4, 5];
        var rawProfile = Json(ColumnProfiler.Profile(raw, raw.SealedSnapshot(), null, profiled, true, CancellationToken.None));
        var packedProfile = Json(ColumnProfiler.Profile(packed, packed.SealedSnapshot(), null, profiled, true, CancellationToken.None));
        var oneThread = Json(ColumnProfiler.Profile(packed, packed.SealedSnapshot(), null, profiled, true, CancellationToken.None, workers: 1));
        var sizes = Json(ColumnProfiler.Profile(packed, packed.SealedSnapshot(), null, [], true, CancellationToken.None));
        check(packedProfile == rawProfile && oneThread == rawProfile && sizes == Json(ColumnProfiler.Profile(raw, raw.SealedSnapshot(), null, [], true, CancellationToken.None)) && Kept(),
            "a profile of a packed result, on the workers or one thread, is the profile of it unpacked, and leaves it packed");

        PivotSpec[] specs = [Spec, new([1, 3], 1, [new(PivotAggregate.Count, -1), new(PivotAggregate.Min, 2)]), new([], -1, [new(PivotAggregate.Max, 5)])];
        foreach (var spec in specs)
        {
            var expected = Pivot(rawStore, raw, spec);
            var packedBefore = packedStore.PackingSnapshot().PagesPacked;
            var actual = Pivot(packedStore, packed, spec);
            // The pivot's own pages are packed as it completes (and go with it); the source's are not packed again.
            var outputPacked = packedStore.PackingSnapshot().PagesPacked - packedBefore <= actual.Length;
            pagesPacked = packedStore.PackingSnapshot().PagesPacked;
            check(outputPacked && actual.Length == expected.Length && actual.Zip(expected).All(pair => pair.First.AsSpan().SequenceEqual(pair.Second)) && Kept(),
                "a pivot of a packed result writes the pages it writes unpacked, its rows copied from pages read together, and leaves the result packed");
        }

        // A plain Copy's size (and its writing, which reads alike) unpacks each packed page into one room of its own, not
        // through the read cache, and gives the room back.
        CopyPartArgs[] whole = [new([[0, Rows - 1]], [[0, 5]])];
        var unpackedBeforeCopy = packedStore.PackingSnapshot().PagesUnpacked;
        var copied = ResultJobs.EstimateCopy(packed, whole, true, false);
        check(copied == ResultJobs.EstimateCopy(raw, whole, true, false) && copied > 0 && packedStore.PackingSnapshot().PagesUnpacked - unpackedBeforeCopy == packed.SealedSnapshot().Length && Kept(),
            "a plain Copy of a packed result reads each page once through a room of its own, leaves no page cached and gives the room back");

        // Through the service: a sort, a profile and a pivot of a packed result leave it packed and the budget as it was.
        using var service = new SqlService(packedStore);
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        var viewed = Call<ResultsViewResult>("results.view", new { resultId = packed.ResultId, sort = new[] { new { column = 3, descending = false, mode = "value" } } });
        var viewUsed = packedStore.UsedBytes;
        packedStore.CloseViews(packed.ResultId, [viewed.ViewId]);
        Call<ResultsProfileResult>("results.profile", new { resultId = packed.ResultId, columns = new[] { 2, 3, 5 } });
        var servicePackedBefore = packedStore.PackingSnapshot().PagesPacked;
        var pivoted = Call<ResultsPivotResult>("results.pivot", new { resultId = packed.ResultId, rows = new[] { 1 }, values = new object[] { new { aggregate = "count" }, new { aggregate = "max", column = 3 } } });
        // Its pivot's pages are packed as it completes (a page or two); the source's would be all of them again.
        var pivotPacked = packedStore.PackingSnapshot().PagesPacked - servicePackedBefore;
        packedStore.Release([pivoted.Descriptor.ResultId]);
        pagesPacked += pivotPacked <= 2 ? pivotPacked : 0;
        check(viewed.Rows == Rows && viewUsed == used + 4L * Rows + ResultStore.ViewOverhead && pivoted.RowGroups == Groups.Length && Kept(),
            "results.view, results.profile and results.pivot of a packed result read it fused: it stays packed and holds only the view's order afterwards");
    }

    /// <summary>A result packed on request, whose incompressible pages stay as sealed beside packed ones: those read in
    /// place, the others fused, and every operation gives what it gives unpacked.</summary>
    private static readonly IReadOnlyList<ResultColumn> MixedColumns = [new("id", "int", "text", Nullable: false), new("grp", "nvarchar(20)", "text"), new("data", "varbinary(400)", "binary")];
    private static readonly IReadOnlyList<WireKind> MixedWires = [WireKind.Text, WireKind.Text, WireKind.Binary];

    /// <summary>8,000 rows in runs of 1,500: noise (a page of it saves nothing, so packing on request leaves it as sealed),
    /// then a few repeated values (it packs). <paramref name="changed"/> rows (a diff's second result) change their group.</summary>
    private static ResultSetBuffer MixedFilled(ResultStore store, string session, QueryBudget? query = null, int index = 0, Func<int, bool>? changed = null)
    {
        var set = store.Open(query ?? store.BeginQuery(session), index, 1, 1, "rows", MixedColumns, MixedWires) ?? throw new InvalidOperationException("The result set was not kept.");
        var bytes = new byte[300];
        for (var row = 0; row < 8_000; row++)
        {
            set.CountRow();
            if (set.BeginRow() is not { } builder) continue;
            builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), row));
            builder.AppendText(Groups[(Mix(row, 2) + (changed?.Invoke(row) == true ? 1UL : 0)) % (ulong)Groups.Length]);
            if (row / 1_500 % 2 == 0)
                for (var k = 0; k < bytes.Length; k += 8) BitConverter.TryWriteBytes(bytes.AsSpan(k), Mix(row * 64L + k / 8, 9));
            else
            {
                Array.Clear(bytes);
                bytes[0] = (byte)(Mix(row, 10) % 7);
            }
            builder.AppendBinary(bytes);
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    private static void Mixed(Action<bool, string> check)
    {
        ResultSetBuffer Fill(ResultStore store, string session) => MixedFilled(store, session);
        var rawStore = Raw();
        var raw = Fill(rawStore, "raw");
        var store = new ResultStore(1L << 30, 1L << 30) { Packing = PagePacking.OnRequest };
        var mixed = Fill(store, "mixed");
        mixed.Pack();
        var used = store.UsedBytes;
        var pagesPacked = store.PackingSnapshot().PagesPacked;
        int packedCount, rawCount;
        using (mixed.Pin())
        {
            var pages = mixed.SealedSnapshot();
            packedCount = pages.Count(page => mixed.Raw(page) is null);
            rawCount = pages.Length - packedCount;
        }
        bool Kept() => store.UsedBytes == used && store.PackingSnapshot() is { CacheBytes: 0 } counters && counters.PagesPacked == pagesPacked;
        check(packedCount >= 1 && rawCount >= 1, "the mixed result holds packed pages and pages left as sealed: " + packedCount + " packed, " + rawCount + " not");
        ViewKey[][] sorts = [[new(2, false, SortMode.Value)], [new(2, true, SortMode.Value)], [new(1, false, SortMode.Value), new(0, true, SortMode.Value)]];
        foreach (var keys in sorts)
        {
            var narrow = new ViewSorter.KeyMemory(_ => false, _ => { });
            check(View(mixed, keys, []).Order.SequenceEqual(View(raw, keys, []).Order) && View(mixed, keys, [], narrow).Order.SequenceEqual(View(raw, keys, []).Order) && Kept(),
                "a sort of a partly packed result by " + keys[0].Column + " gives the order it gives unpacked, with and without room for whole keys");
        }
        ViewFilter[] filters = [new(FilterOp.In, 1, [0, 2], true, null, [])];
        var filtered = View(mixed, [new(2, false, SortMode.Value)], filters);
        var filteredRaw = View(raw, [new(2, false, SortMode.Value)], filters);
        check(filtered.Order.SequenceEqual(filteredRaw.Order) && filtered.Filters == filteredRaw.Filters && Kept(), "a filter of a partly packed result keeps the rows it keeps unpacked");
        var profile = Json(ColumnProfiler.Profile(mixed, mixed.SealedSnapshot(), null, [0, 1, 2], true, CancellationToken.None));
        check(profile == Json(ColumnProfiler.Profile(raw, raw.SealedSnapshot(), null, [0, 1, 2], true, CancellationToken.None)) && Kept(), "a profile of a partly packed result is the profile of it unpacked");
        PivotSpec spec = new([1], -1, [new(PivotAggregate.Count, -1), new(PivotAggregate.Max, 0), new(PivotAggregate.Sum, 0)]);
        var pivot = Pivot(store, mixed, spec);
        var pivotRaw = Pivot(rawStore, raw, spec);
        check(pivot.Length == pivotRaw.Length && pivot.Zip(pivotRaw).All(pair => pair.First.AsSpan().SequenceEqual(pair.Second)) && Kept(), "a pivot of a partly packed result writes what it writes unpacked");
        CopyPartArgs[] whole = [new([[0, 7_999]], [[0, 2]])];
        check(ResultJobs.EstimateCopy(mixed, whole, true, false) == ResultJobs.EstimateCopy(raw, whole, true, false) && Kept(), "a plain Copy of a partly packed result is the size it is unpacked");
    }

    /// <summary>Ties that go back to cells read an extract of the column, made once, not a page unpacked a comparison.</summary>
    private static void Ties(Action<bool, string> check)
    {
        var store = Packed();
        var set = Filled(store, "ties");
        var pages = set.SealedSnapshot();
        using var pin = set.Pin();
        using var source = new ViewSorter.PageSource(pages, Columns.Count);
        var approximate = false;
        var before = store.PackingSnapshot().PagesUnpacked;
        var used = store.UsedBytes;
        // decimal(38,10) of 40 values whose text is longer than a double's digits: every equal double compares text.
        var key = ViewSorter.Build(set, source, new ViewKey(2, false, SortMode.Value), null, Rows, CancellationToken.None, ref approximate);
        var built = store.PackingSnapshot().PagesUnpacked - before;
        var extracted = source.ExtractedBytes;
        var rooms = source.Rooms!;
        var order = Enumerable.Range(0, Rows).ToArray();
        ViewSorter.Sort(order, 0, order.Length, new ViewSorter.Comparer([key], null, CancellationToken.None));
        var sorted = store.PackingSnapshot().PagesUnpacked - before - built;
        check(key.ReadsCells && extracted > 0 && built <= 2L * pages.Length && sorted == 0 && store.UsedBytes == used + extracted + rooms.Reserved
            && rooms.Made >= 1 && rooms.Made <= ViewSorter.Workers + 1,
            "a key whose ties compare cells extracts its column once (" + built + " pages unpacked for " + pages.Length + "), its sort unpacks none, and the extract and rooms ("
            + rooms.Made + ") are charged");
        source.Dispose();
        check(store.UsedBytes == used, "a page source gives its rooms and extracts back when disposed");

        // An extract refused (here by its allowance, the budget having room) unpacks the result in place instead, as before
        // fused reads, after giving back the rooms and an earlier column's extract: the sort is the same, reads the pages
        // as sealed, and the result holds only what unpacking added.
        var raw = Filled(Raw(), "ties raw");
        var expected = View(raw, [new(2, false, SortMode.Value)], []);
        var growth = Held.Unpacking(set);
        using (var fallback = new ViewSorter.PageSource(pages, Columns.Count))
        {
            fallback.Extract(3, CancellationToken.None);
            var earlier = fallback.ExtractedBytes;
            fallback.ExtractAllowance = 0;
            var fallbackKey = ViewSorter.Build(set, fallback, new ViewKey(2, false, SortMode.Value), null, Rows, CancellationToken.None, ref approximate);
            var fallbackOrder = Enumerable.Range(0, Rows).ToArray();
            var unpackedBefore = store.PackingSnapshot().PagesUnpacked;
            ViewSorter.Sort(fallbackOrder, 0, fallbackOrder.Length, new ViewSorter.Comparer([fallbackKey], null, CancellationToken.None));
            check(fallbackKey.ReadsCells && !set.HasPacked && fallback.ExtractedBytes == 0 && fallbackOrder.SequenceEqual(expected.Order)
                && store.PackingSnapshot().PagesUnpacked == unpackedBefore && Enumerable.Range(0, pages.Length).All(fallback.IsRaw)
                && earlier > 0 && fallback.Rooms!.Reserved == 0 && store.UsedBytes == used + growth,
                "a sort whose column extract is refused gives back its rooms and earlier extracts, unpacks the result in place, reads its pages as sealed and sorts as unpacked");
        }

        // An extract asks the system's memory load as it grows (once for every ExtractCheckBytes taken, here every byte):
        // while it is high the extract is refused and the result unpacked in place instead.
        var lowNow = false;
        var busy = new ResultStore(1L << 30, 1L << 30, () => (lowNow ? 100 : 0, 50)) { Packing = PagePacking.EveryComplete };
        var busySet = Filled(busy, "busy", 20_000);
        using (busySet.Pin())
        {
            long calm;
            using (var asked = new ViewSorter.PageSource(busySet.SealedSnapshot(), Columns.Count) { ExtractCheckBytes = 1 })
            {
                asked.Extract(2, CancellationToken.None);
                calm = asked.ExtractedBytes;
            }
            using var pressedSource = new ViewSorter.PageSource(busySet.SealedSnapshot(), Columns.Count) { ExtractCheckBytes = 1 };
            lowNow = true;
            pressedSource.Extract(2, CancellationToken.None);
            lowNow = false;
            check(calm > 0 && pressedSource.ExtractedBytes == 0 && !busySet.HasPacked && Enumerable.Range(0, pressedSource.Count).All(pressedSource.IsRaw),
                "an extract asks the system's memory load as it grows, and refused for it unpacks the result in place instead");
        }

        // A pivot's output refused room to hold the pages its rows lie on unpacks the result in place instead, which adds
        // only what packing saved; refused that too, TOO_LARGE.
        var holdStore = Packed(64L << 20);
        var holdSet = Filled(holdStore, "hold", 20_000);
        var holdFiller = holdStore.BeginQuery("filler");
        using (holdSet.Pin())
        {
            var holdPages = holdSet.SealedSnapshot();
            var firsts = holdPages.Select(page => (int)page.FirstRow).ToArray();
            var need = Held.Unpacking(holdSet);
            var whole = holdPages.Sum(page => (long)page.Length);
            check(holdStore.TryReserve(holdFiller, holdStore.GlobalBytes - holdStore.UsedBytes - 1024, false, out _), "the hold checks fill the budget");
            var holdUsed = holdStore.UsedBytes;
            string? neither = null;
            try { new RowAccess(holdPages, Columns.Count).Hold(holdSet, firsts, "no room", CancellationToken.None); }
            catch (RequestException error) { neither = error.Code + ": " + error.Message; }
            check(neither == "TOO_LARGE: no room" && holdSet.HasPacked && holdStore.UsedBytes == holdUsed, "rows held with room neither to hold their pages nor to unpack the result are refused and nothing is held");
            holdStore.Return(holdFiller, need);
            holdUsed = holdStore.UsedBytes;
            var held = new RowAccess(holdPages, Columns.Count).Hold(holdSet, firsts, "no room", CancellationToken.None);
            check(whole > need + 1024 && held == 0 && !holdSet.HasPacked && holdStore.UsedBytes == holdUsed + need,
                "rows held with room to unpack the result but not to hold their pages whole unpack it in place, charging only what packing saved");
        }
    }

    private static void Cancelled(Action<bool, string> check)
    {
        var store = Packed();
        var set = Filled(store, "cancel");
        var used = store.UsedBytes;
        bool Kept() => set.HasPacked && store.UsedBytes == used;

        // A sort cancelled while its keys are built (the key memory's third reservation cancels it).
        using var sortCancel = new CancellationTokenSource();
        var calls = 0;
        var memory = new ViewSorter.KeyMemory(bytes => { if (Interlocked.Increment(ref calls) == 3) sortCancel.Cancel(); return store.TryReserveSpare(set.Budget, bytes); }, bytes => store.Return(set.Budget, bytes));
        var sortThrew = false;
        try { View(set, [new(5, false, SortMode.Value)], [], memory, sortCancel.Token); }
        catch (OperationCanceledException) { sortThrew = true; }
        check(sortThrew && calls >= 3 && Kept(), "a sort of a packed result cancelled while its keys are read stops, gives back its rooms and key memory, and leaves the result packed");

        // A pivot cancelled after its groups, as it starts to read the pages in order.
        using var pivotCancel = new CancellationTokenSource();
        var pivotThrew = false;
        // No Min or Max: their keys would be built (and cancelled) before the in-order pass.
        PivotSpec plain = new([1], -1, [new(PivotAggregate.Count, -1), new(PivotAggregate.Sum, 2)]);
        try { ResultPivoter.Build(set, set.SealedSnapshot(), null, plain, pivotCancel.Token, _ => { pivotCancel.Cancel(); return true; }); }
        catch (OperationCanceledException) { pivotThrew = true; }
        check(pivotThrew && Kept(), "a pivot of a packed result cancelled as it reads its pages in order gives back its rooms and extracts and leaves the result packed");

        // A profile cancelled as its workers start.
        using var profileCancel = new CancellationTokenSource();
        var gate = new ViewSorter.WorkerGate(() => 4, item => { profileCancel.Cancel(); ThreadPool.UnsafeQueueUserWorkItem(item, preferLocal: false); });
        var profileThrew = false;
        try { ColumnProfiler.Profile(set, set.SealedSnapshot(), null, [3, 5], true, profileCancel.Token, workers: 4, gate: gate); }
        catch (OperationCanceledException) { profileThrew = true; }
        check(profileThrew && gate.Busy == 0 && Kept(), "a profile of a packed result cancelled as its workers start gives back its rooms and leaves the result packed");

        // The in-order pass cancelled while it reads, with the next batch being unpacked behind it.
        using var orderCancel = new CancellationTokenSource();
        var read = 0;
        var orderThrew = false;
        using (set.Pin())
        using (ViewSorter.WorkersHere(2))
        {
            using var source = new ViewSorter.PageSource(set.SealedSnapshot(), Columns.Count);
            try { source.InOrder((index, page, view) => { if (++read == 3) orderCancel.Cancel(); }, orderCancel.Token); }
            catch (OperationCanceledException) { orderThrew = true; }
        }
        check(orderThrew && read >= 3 && read < set.SealedSnapshot().Length && Kept(), "an in-order pass over a packed result cancelled while it reads waits for the batch unpacked ahead and gives back both batches' rooms: " + read);
    }

    private static void Refused(Action<bool, string> check)
    {
        var store = Packed(64L << 20);
        var set = Filled(store, "refused", 20_000);
        var filler = store.BeginQuery("filler");
        // Room for less than one page: the first room is refused.
        check(store.TryReserve(filler, store.GlobalBytes - store.UsedBytes - 64 * 1024, false, out _), "the refusal checks fill the budget");
        var used = store.UsedBytes;
        bool Kept() => set.HasPacked && store.UsedBytes == used;
        string? Code(Action run)
        {
            try { run(); return null; }
            catch (RequestException error) { return error.Code + ": " + error.Message; }
            catch (ColumnProfiler.ProfileTooLargeException) { return "profile"; }
        }
        var sort = Code(() => View(set, [new(0, false, SortMode.Value)], []));
        var filter = Code(() => View(set, [], [new(FilterOp.In, 1, [0], false, null, [])]));
        var pivot = Code(() => ResultPivoter.Build(set, set.SealedSnapshot(), null, Spec, CancellationToken.None, _ => true));
        var profile = Code(() => ColumnProfiler.Profile(set, set.SealedSnapshot(), null, [3], true, CancellationToken.None));
        check(sort == "TOO_LARGE: " + ViewSorter.SortTooLarge && filter == "TOO_LARGE: " + ViewSorter.FilterTooLarge && pivot == "TOO_LARGE: " + ResultPivoter.TooLarge && profile == "profile" && Kept(),
            "with no room for a fused read's room, a sort, a filter, a pivot and a profile of a packed result are refused with their own sentences, and nothing is held: "
            + sort + " | " + filter + " | " + pivot + " | " + profile);
        // A plain Copy refused its room reads each page through the set's accessor, as before, and still gives its size.
        var rawTwin = Filled(Raw(), "refused raw", 20_000);
        CopyPartArgs[] whole = [new([[0, 19_999]], [[0, 5]])];
        var copyRefused = ResultJobs.EstimateCopy(set, whole, true, false);
        check(copyRefused == ResultJobs.EstimateCopy(rawTwin, whole, true, false) && copyRefused > 0 && Kept() && store.PackingSnapshot().CacheBytes == 0,
            "a plain Copy of a packed result with no room for a page reads through the accessor and gives the size it gives unpacked");

        // Room for the rooms but not for a column's extract.
        store.Return(filler, filler.UsedBytes);
        long pageLength;
        using (set.Pin()) pageLength = set.SealedSnapshot().Max(page => (long)page.Length);
        // One worker, so one room: what is left after it holds one page's extract at most.
        store.TryReserve(filler, store.GlobalBytes - store.UsedBytes - pageLength - 64 * 1024, false, out _);
        used = store.UsedBytes;
        string? ties;
        (int[] Order, bool Approximate, string Filters) plain;
        using (ViewSorter.WorkersHere(1))
        {
            ties = Code(() => View(set, [new(2, false, SortMode.Value)], []));
            plain = View(set, [new(0, true, SortMode.Value)], []);
        }
        check(ties == "TOO_LARGE: " + ViewSorter.SortTooLarge && plain.Order.Length == 20_000 && plain.Order[0] == 19_999 && Kept(),
            "with room for the rooms but neither a column's extract nor unpacking the result, a sort whose ties compare cells is refused and one that needs no extract still sorts: " + ties);

        // Room for one batch of an in-order pass's rooms but not the next, refused as the next is unpacked behind the read.
        store.Return(filler, filler.UsedBytes);
        store.TryReserve(filler, store.GlobalBytes - store.UsedBytes - 3 * pageLength, false, out _);
        used = store.UsedBytes;
        string? ahead;
        var pagesRead = 0;
        using (set.Pin())
        using (ViewSorter.WorkersHere(2))
        {
            using var source = new ViewSorter.PageSource(set.SealedSnapshot(), Columns.Count);
            ahead = Code(() => source.InOrder((index, page, view) => pagesRead++, CancellationToken.None));
        }
        check(ahead == "TOO_LARGE: " + ViewSorter.NoRoomToRead && pagesRead == 2 && Kept(),
            "an in-order pass refused the rooms for the batch it unpacks ahead stops with the refusal and gives back the rooms it had: " + ahead + " after " + pagesRead + " pages");

        // Through the service, a fused read refused while the computer is low on memory says so, as any refusal there does.
        var low = false;
        // Two workers whatever the machine, so the rooms Held.Rooms allows for are the rooms the service's sort makes even
        // while another suite changes ViewSorter.Workers (the scope flows into the service's operation).
        using var workersHere = ViewSorter.WorkersHere(2);
        var pressed = new ResultStore(64L << 20, 64L << 20, () => (low ? 100 : 0, 50)) { Packing = PagePacking.EveryComplete };
        var lowSet = Filled(pressed, "low", 20_000);
        var room = ViewSorter.WorkingBytes(20_000, 1) + 4L * 20_000 + ResultStore.ViewOverhead + 1024;
        var lowFiller = pressed.BeginQuery("filler");
        check(pressed.TryReserve(lowFiller, pressed.GlobalBytes - pressed.UsedBytes - room, false, out _), "the low-memory check fills the budget but the sort's own room");
        var lowUsed = pressed.UsedBytes;
        using var service = new SqlService(pressed);
        string? Asked(object args)
        {
            try { service.DispatchAsync("results.view", JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); return null; }
            catch (RequestException error) { return error.Code + ": " + error.Message; }
        }
        object Sorted() => new { resultId = lowSet.ResultId, sort = new[] { new { column = 0, descending = false, mode = "value" } } };
        var budgetOnly = Asked(Sorted());
        low = true;
        var lowAnswer = Asked(Sorted());
        low = false;
        check(budgetOnly == "TOO_LARGE: " + ViewSorter.SortTooLarge && lowAnswer == "TOO_LARGE: " + SqlService.LowMemory && lowSet.HasPacked && pressed.UsedBytes == lowUsed,
            "a sort refused its rooms through the service names the budget, or the computer's memory when that is low, and holds nothing: " + budgetOnly + " | " + lowAnswer);
        // It was the rooms that were refused: with room for them as well, the same sort is answered.
        using (lowSet.Pin()) pressed.Return(lowFiller, Held.Rooms(lowSet));
        check(Asked(Sorted()) is null, "the same sort is answered once there is room for its rooms too");

        // A profile refused its rooms even on one thread says so the same way.
        pressed.Return(lowFiller, lowFiller.UsedBytes);
        var profileRoom = ColumnProfiler.WorkingBytes(20_000, 1) + 1024;
        check(pressed.TryReserve(lowFiller, pressed.GlobalBytes - pressed.UsedBytes - profileRoom, false, out _), "the profile's low-memory check fills the budget but its figures' room");
        var profileUsed = pressed.UsedBytes;
        string? Profiled()
        {
            try { service.DispatchAsync("results.profile", JsonSerializer.SerializeToElement(new { resultId = lowSet.ResultId, columns = new[] { 3 } }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); return null; }
            catch (RequestException error) { return error.Code + ": " + error.Message; }
        }
        var profileBudget = Profiled();
        low = true;
        var profileLow = Profiled();
        low = false;
        check(profileBudget is not null && profileBudget.StartsWith("TOO_LARGE: There is not enough result memory to profile", StringComparison.Ordinal) && profileLow == "TOO_LARGE: " + SqlService.LowMemory
            && pressed.UsedBytes == profileUsed && lowSet.HasPacked,
            "a profile refused its rooms on one thread names the budget, or the computer's memory when that is low, and holds nothing: " + profileBudget + " | " + profileLow);
    }
}
