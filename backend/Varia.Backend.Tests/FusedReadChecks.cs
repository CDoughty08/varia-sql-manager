using System.Globalization;
using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Fused per-page reads (ViewSorter.PageSource, PageRooms): sorts, filters, profiles and pivots of a packed result
/// read its pages fused, each worker unpacking the page it reads into a room reserved from the budget, and give exactly
/// what they give over the same rows unpacked. Ties that go back to cells read an extract of their column, not a page
/// unpacked a comparison. Cancellation and refused rooms or extracts leave the result packed and the budget as it was.
/// The suite sets each store's packing itself, so it is not in the packed pass.</summary>
internal static class FusedReadChecks
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

    private static ResultSetBuffer Filled(ResultStore store, string session, int rows = Rows)
    {
        var set = store.Open(store.BeginQuery(session), 0, 1, 1, "rows", Columns, Wires) ?? throw new InvalidOperationException("The result set was not kept.");
        for (var row = 0; row < rows; row++)
        {
            set.CountRow();
            if (set.BeginRow() is not { } builder) continue;
            builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), row));
            if (Mix(row, 1) % 17 == 0) builder.AppendNull();
            else builder.AppendText(Groups[Mix(row, 2) % (ulong)Groups.Length]);
            var whole = (long)(Mix(row, 3) % 40) * 1_000_000_007L - 9_000_000_000L;
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
        Same(check);
        Ties(check);
        Cancelled(check);
        Refused(check);
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
        bool Kept() => packed.HasPacked && packedStore.PackingSnapshot().PackedBytes == packedBytes && packedStore.UsedBytes == used && packedStore.PackingSnapshot().CacheBytes == 0;

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
            var actual = Pivot(packedStore, packed, spec);
            check(actual.Length == expected.Length && actual.Zip(expected).All(pair => pair.First.AsSpan().SequenceEqual(pair.Second)) && Kept(),
                "a pivot of a packed result writes the pages it writes unpacked, its rows copied from pages read together, and leaves the result packed");
        }

        // A plain Copy's size (and its writing, which reads alike) unpacks each packed page into one room of its own, not
        // through the read cache, and gives the room back.
        CopyPartArgs[] whole = [new([[0, Rows - 1]], [[0, 5]])];
        var unpackedBeforeCopy = packedStore.PackingSnapshot().PagesUnpacked;
        var copied = ResultJobs.EstimateCopy(packed, whole, true, false);
        check(copied == ResultJobs.EstimateCopy(raw, whole, true, false) && copied > 0 && packedStore.PackingSnapshot().PagesUnpacked - unpackedBeforeCopy == packed.SealedSnapshot().Length && Kept(),
            "a plain Copy of a packed result reads each page once through a room of its own, leaves no page cached and gives the room back");

        // Pages the codec kept raw beside packed ones (a result packed on request) read in place, the others fused.
        var mixedStore = new ResultStore(1L << 30, 1L << 30) { Packing = PagePacking.OnRequest };
        var mixed = Filled(mixedStore, "mixed");
        var mixedPages = mixed.SealedSnapshot();
        mixed.Pack();
        bool partly;
        using (mixed.Pin()) partly = mixedPages.Any(page => mixed.Raw(page) is null);
        var mixedOrder = View(mixed, [new(3, false, SortMode.Value), new(0, true, SortMode.Value)], [new(FilterOp.In, 1, [0, 2], true, null, [])]);
        var rawOrder = View(raw, [new(3, false, SortMode.Value), new(0, true, SortMode.Value)], [new(FilterOp.In, 1, [0, 2], true, null, [])]);
        check(partly && mixedOrder.Order.SequenceEqual(rawOrder.Order), "a result packed on request, whose pages may be raw or packed, sorts and filters as unpacked");

        // Through the service: a sort, a profile and a pivot of a packed result leave it packed and the budget as it was.
        using var service = new SqlService(packedStore);
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        var viewed = Call<ResultsViewResult>("results.view", new { resultId = packed.ResultId, sort = new[] { new { column = 3, descending = false, mode = "value" } } });
        var viewUsed = packedStore.UsedBytes;
        packedStore.CloseViews(packed.ResultId, [viewed.ViewId]);
        Call<ResultsProfileResult>("results.profile", new { resultId = packed.ResultId, columns = new[] { 2, 3, 5 } });
        var pivoted = Call<ResultsPivotResult>("results.pivot", new { resultId = packed.ResultId, rows = new[] { 1 }, values = new object[] { new { aggregate = "count" }, new { aggregate = "max", column = 3 } } });
        packedStore.Release([pivoted.Descriptor.ResultId]);
        check(viewed.Rows == Rows && viewUsed == used + 4L * Rows + ResultStore.ViewOverhead && pivoted.RowGroups == Groups.Length && Kept(),
            "results.view, results.profile and results.pivot of a packed result read it fused: it stays packed and holds only the view's order afterwards");
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
        try { ResultPivoter.Build(set, set.SealedSnapshot(), null, Spec, pivotCancel.Token, _ => { pivotCancel.Cancel(); return true; }); }
        catch (OperationCanceledException) { pivotThrew = true; }
        check(pivotThrew && Kept(), "a pivot of a packed result cancelled as it reads its pages in order gives back its rooms and extracts and leaves the result packed");

        // A profile cancelled as its workers start.
        using var profileCancel = new CancellationTokenSource();
        var gate = new ViewSorter.WorkerGate(() => 4, item => { profileCancel.Cancel(); ThreadPool.UnsafeQueueUserWorkItem(item, preferLocal: false); });
        var profileThrew = false;
        try { ColumnProfiler.Profile(set, set.SealedSnapshot(), null, [3, 5], true, profileCancel.Token, workers: 4, gate: gate); }
        catch (OperationCanceledException) { profileThrew = true; }
        check(profileThrew && gate.Busy == 0 && Kept(), "a profile of a packed result cancelled as its workers start gives back its rooms and leaves the result packed");
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
            "with room for the rooms but not a column's extract, a sort whose ties compare cells is refused and one that needs no extract still sorts: " + ties);

        // Through the service, a fused read refused while the computer is low on memory says so, as any refusal there does.
        var low = false;
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
    }
}
