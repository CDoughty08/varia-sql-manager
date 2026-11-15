using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Fused reads of the operations that used to unpack a packed result whole first: a diff (either or both results
/// packed, matched by a key or by whole rows), a distinct list and its later reads, row identities and a search. Each
/// gives exactly what it gives over the same rows unpacked, leaves the results packed and the budget as it was, unpacks
/// a bounded number of pages (a diff's revisits served by its readers' kept pages, a snapshot's search reading each page
/// once), and gives its rooms back when cancelled or refused, with the operation's own sentence. A diff whose first
/// result is read far from its pages' order unpacks that result in place instead, as before, and a search through a sorted
/// view does too. The suite sets each store's packing itself, so it is not in the packed pass.</summary>
internal static partial class FusedReadChecks
{
    public static void RunWhole(Action<bool, string> check)
    {
        using (ViewSorter.WorkersHere(4))
        {
            Diffs(check);
            Distincts(check);
            IdentitiesAndSearches(check);
            MixedWhole(check);
            Services(check);
        }
        CancelledWhole(check);
        RefusedWhole(check);
    }

    private static readonly int[] Kept500 = [.. Enumerable.Range(0, Rows).Where(row => row % 500 != 7), .. Enumerable.Range(Rows, 40)];

    /// <summary>The second result's rows: a row in 500 gone and 40 new ones, in the first result's order, shuffled, or
    /// interleaved (each 3,000 rows' two halves taken in turn, so the first result is read from two pages about one apart,
    /// alternately: near its pages' order for a reader that keeps a few pages, an unpack a row for one that keeps one).</summary>
    private static int[] RightRows(bool shuffled, bool interleaved = false) =>
        shuffled ? [.. Kept500.OrderBy(row => Mix(row, 77))]
        : interleaved ? [.. Enumerable.Range(0, Kept500.Length).OrderBy(k => k / 3000).ThenBy(k => k % 1500).ThenBy(k => k % 3000 / 1500).Select(k => Kept500[k])]
        : Kept500;

    /// <summary>Two results of one query, packed on request as asked: the second has a row in 37 changed (one soft difference
    /// and one exact), a row in 500 gone and 40 added. Keyless, their first columns have different names, so no column
    /// they share is a key and whole rows match.</summary>
    private static (ResultStore Store, ResultSetBuffer Left, ResultSetBuffer Right) PairOf(bool packLeft, bool packRight, bool shuffled = false, bool keyless = false, long bytes = 1L << 30, bool interleaved = false)
    {
        var store = new ResultStore(bytes, bytes) { Packing = PagePacking.OnRequest };
        var query = store.BeginQuery("pair");
        IReadOnlyList<ResultColumn>? leftColumns = keyless ? [new("ref", "int", "text", Nullable: false), .. Columns.Skip(1)] : null;
        var left = Filled(store, "pair", Rows, query, 0, columns: leftColumns);
        var rows = RightRows(shuffled, interleaved);
        var right = Filled(store, "pair", rows.Length, query, 1, k => rows[k], row => row % 37 == 3);
        if (packLeft) left.Pack();
        if (packRight) right.Pack();
        return (store, left, right);
    }

    private static string Model(DiffModel model) =>
        model.KeyPair + "|" + model.Approximate + "|" + string.Join(",", model.Pairs.Select(pair => pair.Left + ":" + pair.Right)) + "|"
        + string.Join(";", model.Entries.Select(entry => $"{(int)entry.Kind}:{entry.Left}:{entry.Right}:{entry.CellStart}:{entry.CellCount}")) + "|" + string.Join(",", model.Cells);

    private static bool SamePages(byte[][] a, byte[][] b) => a.Length == b.Length && a.Zip(b).All(pair => pair.First.AsSpan().SequenceEqual(pair.Second));

    /// <summary>A diff's model and its unified result's pages (written whole, then released).</summary>
    private static (string Model, byte[][] Unified) Diffed(ResultStore store, ResultSetBuffer left, ResultSetBuffer right, DiffStages? stages = null, int context = -1)
    {
        var model = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None, null, stages);
        var unified = store.Open(left.Budget, right.Index, right.BatchNumber, right.Iteration, "diff", UnifiedDiff.Columns(right, model), UnifiedDiff.Wires(right, model),
            lengths: UnifiedDiff.Lengths(right, model), derived: true) ?? throw new InvalidOperationException("The diff was not kept.");
        UnifiedDiff.Write(unified, left, left.SealedSnapshot(), right, right.SealedSnapshot(), model, context, CancellationToken.None, ResultDiffer.TooLarge, stages);
        byte[][] bodies;
        using (unified.Pin()) bodies = [.. unified.SealedSnapshot().Select(page => page.Body())];
        store.Release([unified.ResultId]);
        return (Model(model), bodies);
    }

    private static int PageCount(ResultSetBuffer set) => set.SealedSnapshot().Length;

    private static void Diffs(Action<bool, string> check)
    {
        foreach (var keyless in new[] { false, true })
        foreach (var shuffled in new[] { false, true })
        {
            var raw = PairOf(false, false, shuffled, keyless);
            var expected = Diffed(raw.Store, raw.Left, raw.Right);
            var kind = (keyless ? "whole rows" : "a key") + (shuffled ? ", the second result shuffled" : "");
            check((keyless || expected.Model.Contains(";1:", StringComparison.Ordinal)) && expected.Model.Contains(";2:", StringComparison.Ordinal) && expected.Model.Contains(";3:", StringComparison.Ordinal)
                && expected.Model.StartsWith(keyless ? "-1|" : "0|", StringComparison.Ordinal),
                "the fused diff fixture (" + kind + ") has added and removed rows, and changed ones matched by a key, and matches as intended");
            foreach (var (packLeft, packRight) in new[] { (true, true), (true, false), (false, true) })
            {
                var pair = PairOf(packLeft, packRight, shuffled, keyless);
                var used = pair.Store.UsedBytes;
                long growth;
                using (pair.Left.Pin()) growth = Held.Unpacking(pair.Left);
                var packedBefore = pair.Store.PackingSnapshot().PagesPacked;
                var unpackedBefore = pair.Store.PackingSnapshot().PagesUnpacked;
                var stages = new DiffStages();
                var actual = Diffed(pair.Store, pair.Left, pair.Right, stages);
                var unpacked = pair.Store.PackingSnapshot().PagesUnpacked - unpackedBefore;
                var pages = PageCount(pair.Left) + PageCount(pair.Right);
                var name = (packLeft ? "packed" : "raw") + "/" + (packRight ? "packed" : "raw") + ", " + kind;
                // A first result read far from its pages' order is unpacked in place instead (it holds what that adds);
                // otherwise both stay packed and the budget is as it was.
                var leftUnpacked = packLeft && shuffled;
                check(actual.Model == expected.Model && SamePages(actual.Unified, expected.Unified),
                    "a diff of a " + name + " pair gives the model and unified result it gives unpacked");
                check(stages.Unpacked == leftUnpacked && pair.Left.HasPacked == (packLeft && !leftUnpacked) && pair.Right.HasPacked == packRight
                    && pair.Store.PackingSnapshot() is { CacheBytes: 0 } counters && counters.PagesPacked == packedBefore
                    && pair.Store.UsedBytes == used + (leftUnpacked ? growth : 0),
                    "a diff of a " + name + " pair " + (leftUnpacked ? "unpacks its first result in place, read far from its pages' order, and keeps the second packed" : "leaves both results as they were and the budget too"));
                // Each pass reads a page once (a candidate tried, whole rows hashed, the alignment, the unified result), and
                // revisits are served by the readers' kept pages: never a page a row.
                check(unpacked <= 5L * pages, "a diff of a " + name + " pair unpacks a bounded number of pages, not one a row: " + unpacked + " for " + pages);
                // One thread writes the unified result: its packed pages are unpacked ahead on the workers, in the order it reads them.
                check(stages.WrittenAhead > 0 == (packLeft && !leftUnpacked || packRight) && (shuffled || stages.WrittenBehind == 0) && stages.WrittenAhead + stages.WrittenBehind <= 5L * pages,
                    "a diff of a " + name + " pair writes its unified result with the packed pages unpacked ahead: " + stages.WrittenAhead + " ahead, " + stages.WrittenBehind + " by the writer");
            }
        }

        // Interleaved: the first result read two pages at a time, alternately, stays fused, each page unpacked about once.
        var nearRaw = PairOf(false, false, interleaved: true);
        var nearExpected = Diffed(nearRaw.Store, nearRaw.Left, nearRaw.Right);
        var near = PairOf(true, true, interleaved: true);
        var nearBefore = near.Store.PackingSnapshot().PagesUnpacked;
        var nearStages = new DiffStages();
        var nearActual = Diffed(near.Store, near.Left, near.Right, nearStages);
        var nearUnpacked = near.Store.PackingSnapshot().PagesUnpacked - nearBefore;
        var nearPages = PageCount(near.Left) + PageCount(near.Right);
        check(nearActual.Model == nearExpected.Model && SamePages(nearActual.Unified, nearExpected.Unified) && !nearStages.Unpacked && near.Left.HasPacked && nearUnpacked <= 5L * nearPages
            && nearStages.WrittenAhead + nearStages.WrittenBehind <= nearPages + 2L * PageAhead.Batch,
            "a diff whose second result reads the first from two pages at a time, alternately, gives what it gives unpacked, stays fused and unpacks each page a few times (its unified result's writer about once): " + nearUnpacked + " for " + nearPages + ", " + (nearStages.WrittenAhead + nearStages.WrittenBehind) + " writing");

        // A reader that goes back and forth between two packed pages has each unpacked ahead once: a page its batch lists
        // is not listed again.
        using (near.Left.Pin())
        {
            var leftPages = near.Left.SealedSnapshot();
            using var rooms = PageRooms.Over(leftPages, near.Left.Wires.Count, () => new RequestException("TOO_LARGE", ResultDiffer.TooLarge))!;
            var access = new RowAccess(leftPages, near.Left.Wires.Count);
            using var reader = access.Reader(rooms, ResultDiffer.LeftSlots);
            int[] alternate = [.. Enumerable.Range(0, 400).Select(i => i % 2 == 0 ? i / 2 : 1500 + i / 2)];
            reader.Ahead(alternate, CancellationToken.None);
            foreach (var row in alternate) reader.At(row, out _);
            var touched = alternate.Select(row => access.PageOf(row, out _)).Distinct().Count();
            check(touched <= PageAhead.Batch && reader.AheadUnpacked == touched && reader.Behind == 0,
                "a writer reading back and forth between two packed pages has each unpacked ahead once: " + touched + " pages, " + reader.AheadUnpacked + " ahead, " + reader.Behind + " by the writer");
        }

        // The locality estimate alone: the second result's order of the first result's rows decides it, counted from the rows.
        var local = PairOf(true, true);
        var far = PairOf(true, true, shuffled: true);
        bool Local((ResultStore Store, ResultSetBuffer Left, ResultSetBuffer Right) pair, int[] rightMatch)
        {
            using var pin = pair.Left.Pin();
            return ResultDiffer.Local(pair.Left.SealedSnapshot(), rightMatch, CancellationToken.None);
        }
        int[] Matches(int[] rights) => [.. rights.Select(row => row < Rows ? row : -1)];
        check(Local(local, Matches(RightRows(false))) && !Local(far, Matches(RightRows(true))) && Local(far, [.. Enumerable.Range(0, Rows).Reverse()]),
            "the diff's locality estimate takes the first result's rows read in its own order or backwards as near its pages and shuffled as far");
    }

    /// <summary>Rows of the fixture whose groups differ (case ignored, as the column's collation does) and are not NULL, from
    /// the <paramref name="skip"/>th such group: an In filter on the group column keeps those groups.</summary>
    private static int[] GroupRows(int count, int skip = 0) =>
        [.. Enumerable.Range(0, 200).Where(row => Mix(row, 1) % 17 != 0).DistinctBy(row => Groups[Mix(row, 2) % (ulong)Groups.Length].ToUpperInvariant()).Skip(skip).Take(count)];

    private static string Listed(DistinctSnapshot snapshot)
    {
        var parts = new List<string> { $"{snapshot.Rows}|{snapshot.Nulls}|{snapshot.Distinct}|{snapshot.Approximate}|{snapshot.Complete}" };
        string Values(DistinctValue[] values) => string.Join(";", values.Select(value => $"{value.Group}@{value.Row}x{value.Count}:{value.Text}:{value.Checked}"));
        foreach (var order in new[] { DistinctOrder.Count, DistinctOrder.Value })
            for (var offset = 0; offset < snapshot.Distinct; offset += ViewSorter.MaxDistinctWindow)
                parts.Add(Values(snapshot.Read(order, offset, ViewSorter.MaxDistinctWindow, null, CancellationToken.None).Values));
        foreach (var search in new[] { "word1", "OPEN", "REFERENCE-0001", "99999", "no such text" })
        {
            var (total, values, _, _) = snapshot.Read(DistinctOrder.Count, 0, ViewSorter.MaxDistinctWindow, search, CancellationToken.None);
            parts.Add(search + "=" + total + ":" + Values(values));
        }
        snapshot.Tick(false, null, true, "word2", null, CancellationToken.None);
        var (op, rows, nulls) = snapshot.Freeze();
        parts.Add(op + ":" + nulls + ":" + string.Join(",", rows) + ":" + snapshot.Digest());
        return string.Join("\n", parts);
    }

    private static void Distincts(Action<bool, string> check)
    {
        var rawStore = Raw();
        var raw = Filled(rawStore, "distinct raw");
        var store = Packed();
        var packed = Filled(store, "distinct packed");
        var used = store.UsedBytes;
        var pagesPacked = store.PackingSnapshot().PagesPacked;
        bool Kept() => packed.HasPacked && store.UsedBytes == used && store.PackingSnapshot() is { CacheBytes: 0 } counters && counters.PagesPacked == pagesPacked;
        // A view filtered to two groups, and a kept view of three, in each store.
        ResultView Filtered(ResultStore owner, ResultSetBuffer set, int[] groups) =>
            owner.AddView(set, ViewSorter.Build(set, set.SealedSnapshot(), [], [new ViewFilter(FilterOp.In, 1, groups, false, null, [])], CancellationToken.None).Order, [], false, true, 0, null);
        var views = (Raw: (View: Filtered(rawStore, raw, GroupRows(2)), Kept: Filtered(rawStore, raw, GroupRows(3, 2))), Packed: (View: Filtered(store, packed, GroupRows(2)), Kept: Filtered(store, packed, GroupRows(3, 2))));
        used = store.UsedBytes;
        pagesPacked = store.PackingSnapshot().PagesPacked;
        foreach (var column in new[] { 1, 2, 3, 5 })
        foreach (var viewed in new[] { false, true })
        {
            var name = "column " + column + (viewed ? " through a view, ticked from another" : "");
            var expected = Listed(ViewSorter.DistinctValues(raw, raw.SealedSnapshot(), viewed ? views.Raw.View : null, column, true, CancellationToken.None, viewed ? views.Raw.Kept : null));
            var unpackedBefore = store.PackingSnapshot().PagesUnpacked;
            var snapshot = ViewSorter.DistinctValues(packed, packed.SealedSnapshot(), viewed ? views.Packed.View : null, column, true, CancellationToken.None, viewed ? views.Packed.Kept : null);
            var built = store.PackingSnapshot().PagesUnpacked - unpackedBefore;
            var builtKept = Kept();
            // A search of the packed result's values reads each page once (in row order), not once a value.
            unpackedBefore = store.PackingSnapshot().PagesUnpacked;
            snapshot.Read(DistinctOrder.Value, 0, 1, "zzz", CancellationToken.None);
            var searched = store.PackingSnapshot().PagesUnpacked - unpackedBefore;
            // So does a window of values in value order: its rows are read in row order.
            unpackedBefore = store.PackingSnapshot().PagesUnpacked;
            snapshot.Read(DistinctOrder.Value, 0, ViewSorter.MaxDistinctWindow, null, CancellationToken.None);
            var windowed = store.PackingSnapshot().PagesUnpacked - unpackedBefore;
            var actual = Listed(snapshot);
            check(actual == expected && builtKept && Kept(),
                "a distinct list of a packed result's " + name + " lists, counts, searches, ticks and freezes as it does unpacked, and leaves the result packed and the budget as it was");
            check(built <= 4L * PageCount(packed) && searched <= PageCount(packed) && windowed <= PageCount(packed) && snapshot.Distinct >= 2 && searched > 0,
                "a distinct list of a packed result's " + name + " unpacks each page a bounded number of times: " + built + " to build, " + searched + " to search " + snapshot.Distinct + " values, " + windowed + " for a window, on " + PageCount(packed) + " pages");
        }
    }

    private static void IdentitiesAndSearches(Action<bool, string> check)
    {
        var rawStore = Raw();
        var raw = Filled(rawStore, "identify raw");
        var store = Packed();
        var packed = Filled(store, "identify packed");
        var used = store.UsedBytes;
        bool Kept() => packed.HasPacked && store.UsedBytes == used && store.PackingSnapshot().CacheBytes == 0;
        string Identity(ResultSetBuffer set, IdentityBy by, int column)
        {
            var (chosen, unique, approximate, ids) = RowIdentity.Build(set, set.SealedSnapshot(), by, column, CancellationToken.None);
            return chosen + "|" + unique + "|" + approximate + "|" + string.Join(",", ids);
        }
        foreach (var (by, column) in new[] { (IdentityBy.Auto, -1), (IdentityBy.Column, 3), (IdentityBy.Column, 0), (IdentityBy.Row, -1) })
        {
            var unpackedBefore = store.PackingSnapshot().PagesUnpacked;
            var actual = Identity(packed, by, column);
            var unpacked = store.PackingSnapshot().PagesUnpacked - unpackedBefore;
            check(actual == Identity(raw, by, column) && Kept() && unpacked <= 2L * PageCount(packed),
                "row identities by " + by + (column >= 0 ? " " + column : "") + " of a packed result are those of it unpacked, read page by page, and leave it packed: " + unpacked + " pages unpacked");
        }

        string Found(ResultSetBuffer set, ResultView? view, string text, long from, bool backward) =>
            ResultSearcher.Search(set, set.SealedSnapshot(), view, text, from, backward, 50, CancellationToken.None) is { } found
                ? $"{found.Searched}|{found.Total}|{found.First}|{found.Approximate}|{string.Join(",", found.Rows)}|{string.Join(",", found.Columns)}" : "stopped";
        ResultView FilteredView(ResultStore owner, ResultSetBuffer set) =>
            owner.AddView(set, ViewSorter.Build(set, set.SealedSnapshot(), [], [new ViewFilter(FilterOp.In, 1, GroupRows(2), false, null, [])], CancellationToken.None).Order, [], false, true, 0, null);
        var rawView = FilteredView(rawStore, raw);
        var packedView = FilteredView(store, packed);
        used = store.UsedBytes;
        foreach (var (text, from, backward) in new[] { ("word12", 1000L, false), ("open", 30_000L, true), ("REFERENCE-00042", 0L, false), ("no such text", 0L, false) })
        {
            var unpackedBefore = store.PackingSnapshot().PagesUnpacked;
            var baseOrder = Found(packed, null, text, from, backward);
            var viewed = Found(packed, packedView, text, from / 2, backward);
            var unpacked = store.PackingSnapshot().PagesUnpacked - unpackedBefore;
            check(baseOrder == Found(raw, null, text, from, backward) && viewed == Found(raw, rawView, text, from / 2, backward) && Kept() && unpacked <= 4L * PageCount(packed),
                "a search for '" + text + "' of a packed result, in its own order and through a filtered view, finds what it finds unpacked, page by page, and leaves it packed: " + unpacked + " pages unpacked");
        }
        using (packed.Pin())
        {
            var pages = packed.SealedSnapshot();
            int[] sorted = [.. Enumerable.Range(0, Rows).OrderBy(row => Mix(row, 5))];
            check(ResultSearcher.Local(pages, packedView.Order) && ResultSearcher.Local(pages, [.. Enumerable.Range(0, Rows)]) && !ResultSearcher.Local(pages, sorted),
                "a search takes base order and a filtered view as near the pages and a sorted view as far from them");
        }
        // Through a sorted view, called without SqlService's unpack first, it reads the pages through the set's accessor:
        // what it finds unpacked, and the result still packed.
        ResultView SortedView(ResultStore owner, ResultSetBuffer set) =>
            owner.AddView(set, ViewSorter.Build(set, set.SealedSnapshot(), [new ViewKey(3, false, SortMode.Value)], [], CancellationToken.None).Order, [], false, true, 0, null);
        var rawSorted = SortedView(rawStore, raw);
        var packedSorted = SortedView(store, packed);
        var sortedBefore = store.PackingSnapshot().PagesUnpacked;
        var sortedFound = Found(packed, packedSorted, "word12", 500, false);
        check(sortedFound == Found(raw, rawSorted, "word12", 500, false) && packed.HasPacked,
            "a search through a sorted view of a packed result, unpacked by nobody first, finds what it finds unpacked and leaves it packed: "
            + (store.PackingSnapshot().PagesUnpacked - sortedBefore) + " pages unpacked");
        {
        }
    }


    /// <summary>Partly packed results (incompressible pages kept as sealed beside packed ones): diff, distinct list, identities
    /// and search give what they give unpacked.</summary>
    private static void MixedWhole(Action<bool, string> check)
    {
        var rawStore = Raw();
        var rawQuery = rawStore.BeginQuery("mixed raw");
        var rawLeft = MixedFilled(rawStore, "mixed raw", rawQuery, 0);
        var rawRight = MixedFilled(rawStore, "mixed raw", rawQuery, 1, row => row % 41 == 5);
        var store = new ResultStore(1L << 30, 1L << 30) { Packing = PagePacking.OnRequest };
        var query = store.BeginQuery("mixed");
        var left = MixedFilled(store, "mixed", query, 0);
        var right = MixedFilled(store, "mixed", query, 1, row => row % 41 == 5);
        left.Pack();
        right.Pack();
        var used = store.UsedBytes;
        int packedPages, rawPages;
        using (left.Pin())
        {
            packedPages = left.SealedSnapshot().Count(page => left.Raw(page) is null);
            rawPages = PageCount(left) - packedPages;
        }
        check(packedPages >= 1 && rawPages >= 1, "the mixed pair holds packed pages and pages left as sealed: " + packedPages + " packed, " + rawPages + " not");
        var expected = Diffed(rawStore, rawLeft, rawRight);
        var actual = Diffed(store, left, right);
        check(actual.Model == expected.Model && SamePages(actual.Unified, expected.Unified) && left.HasPacked && right.HasPacked && store.UsedBytes == used,
            "a diff of two partly packed results gives what it gives unpacked and leaves them packed");
        var distinct = Listed(ViewSorter.DistinctValues(left, left.SealedSnapshot(), null, 2, true, CancellationToken.None));
        check(distinct == Listed(ViewSorter.DistinctValues(rawLeft, rawLeft.SealedSnapshot(), null, 2, true, CancellationToken.None)) && store.UsedBytes == used,
            "a distinct list of a partly packed result's binary column lists and searches what it does unpacked");
        var ids = RowIdentity.Build(left, left.SealedSnapshot(), IdentityBy.Row, -1, CancellationToken.None).Ids;
        check(ids.SequenceEqual(RowIdentity.Build(rawLeft, rawLeft.SealedSnapshot(), IdentityBy.Row, -1, CancellationToken.None).Ids) && store.UsedBytes == used,
            "row identities of a partly packed result are those of it unpacked");
        var found = ResultSearcher.Search(left, left.SealedSnapshot(), null, "0A", 0, false, 100, CancellationToken.None)!;
        var foundRaw = ResultSearcher.Search(rawLeft, rawLeft.SealedSnapshot(), null, "0A", 0, false, 100, CancellationToken.None)!;
        check(found.Total == foundRaw.Total && found.Rows.SequenceEqual(foundRaw.Rows) && found.Columns.SequenceEqual(foundRaw.Columns) && store.UsedBytes == used,
            "a search of a partly packed result finds what it finds unpacked: " + found.Total);
    }

    private static void Services(Action<bool, string> check)
    {
        T Call<T>(SqlService service, string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        var raw = PairOf(false, false);
        var pair = PairOf(true, true);
        using var rawService = new SqlService(raw.Store);
        using var service = new SqlService(pair.Store);
        var used = pair.Store.UsedBytes;
        var expected = Call<ResultsDiffResult>(rawService, "results.diff", new { left = raw.Left.ResultId, right = raw.Right.ResultId, context = 3 });
        var diffed = Call<ResultsDiffResult>(service, "results.diff", new { left = pair.Left.ResultId, right = pair.Right.ResultId, context = 3 });
        var diffBytes = pair.Store.UsedBytes - used;
        pair.Store.Release([diffed.Descriptor.ResultId]);
        check(diffed.Same == expected.Same && diffed.Changed == expected.Changed && diffed.Added == expected.Added && diffed.Removed == expected.Removed && diffed.Soft == expected.Soft
            && diffed.Descriptor.RowsStored == expected.Descriptor.RowsStored && diffBytes > 0 && pair.Left.HasPacked && pair.Right.HasPacked && pair.Store.UsedBytes == used,
            "results.diff of two packed results answers what it answers unpacked, holds only the diff afterwards and leaves both packed");

        var distinct = Call<ResultsDistinctResult>(service, "results.distinct", new { resultId = pair.Left.ResultId, column = 3 });
        var snapshot = pair.Store.FindSnapshot(pair.Left.ResultId, distinct.SnapshotId)!;
        check(distinct.Distinct == 3000 && pair.Left.HasPacked && pair.Store.UsedBytes == used + snapshot.Charged,
            "results.distinct of a packed result reads it fused: it stays packed and holds only the snapshot afterwards");
        var identified = Call<ResultsIdentifyResult>(service, "results.identify", new { resultId = pair.Left.ResultId, by = "auto" });
        check(identified.Unique && identified.Column == 0 && pair.Left.HasPacked && pair.Store.UsedBytes == used + snapshot.Charged + 8L * Rows + ResultStore.ViewOverhead,
            "results.identify of a packed result reads it fused: it stays packed and holds only the identities afterwards");
        var searched = Call<ResultsSearchResult>(service, "results.search", new { resultId = pair.Left.ResultId, text = "word7", fromRow = 0, maxMatches = 10 });
        var before = pair.Store.UsedBytes;
        check(searched.Total > 0 && pair.Left.HasPacked && pair.Store.UsedBytes == before, "results.search of a packed result in its own order reads it fused and leaves it packed");
        // Through a sorted view, its rows far from their pages' order, the search unpacks the result first.
        var view = Call<ResultsViewResult>(service, "results.view", new { resultId = pair.Left.ResultId, sort = new[] { new { column = 3, descending = false, mode = "value" } } });
        var sortedSearch = Call<ResultsSearchResult>(service, "results.search", new { resultId = pair.Left.ResultId, viewId = view.ViewId, text = "word7", fromRow = 0, maxMatches = 10 });
        check(sortedSearch.Total == searched.Total && !pair.Left.HasPacked, "results.search through a sorted view of a packed result unpacks it first, and finds as many matches");
    }

    private static void CancelledWhole(Action<bool, string> check)
    {
        // A diff cancelled while it aligns, its readers holding rooms in both results.
        var pair = PairOf(true, true);
        var used = pair.Store.UsedBytes;
        using var diffCancel = new CancellationTokenSource();
        var diffThrew = false;
        try { ResultDiffer.Compare(pair.Left, pair.Left.SealedSnapshot(), pair.Right, pair.Right.SealedSnapshot(), false, diffCancel.Token, _ => { diffCancel.Cancel(); return true; }); }
        catch (OperationCanceledException) { diffThrew = true; }
        check(diffThrew && pair.Left.HasPacked && pair.Right.HasPacked && pair.Store.UsedBytes == used,
            "a diff of two packed results cancelled while it aligns gives back its readers' rooms and leaves both packed");

        // A distinct list cancelled while its key is read.
        var store = Packed();
        var set = Filled(store, "distinct cancel");
        used = store.UsedBytes;
        using var distinctCancel = new CancellationTokenSource();
        var calls = 0;
        var memory = new ViewSorter.KeyMemory(bytes => { if (Interlocked.Increment(ref calls) == 3) distinctCancel.Cancel(); return store.TryReserveSpare(set.Budget, bytes); }, bytes => store.Return(set.Budget, bytes));
        var distinctThrew = false;
        try { ViewSorter.DistinctValues(set, set.SealedSnapshot(), null, 5, true, distinctCancel.Token, null, memory); }
        catch (OperationCanceledException) { distinctThrew = true; }
        check(distinctThrew && calls >= 3 && set.HasPacked && store.UsedBytes == used,
            "a distinct list of a packed result cancelled while its key is read gives back its rooms and key memory and leaves the result packed");

        // A search cancelled between two checkpoints of its scan.
        using var searchCancel = new CancellationTokenSource();
        var searchThrew = false;
        try { ResultSearcher.Search(set, set.SealedSnapshot(), null, "word", 0, false, 10, searchCancel.Token, () => { searchCancel.Cancel(); return false; }); }
        catch (OperationCanceledException) { searchThrew = true; }
        check(searchThrew && set.HasPacked && store.UsedBytes == used, "a search of a packed result cancelled as it scans gives back its rooms and leaves the result packed");
    }

    private static void RefusedWhole(Action<bool, string> check)
    {
        string? Code(Action run)
        {
            try { run(); return null; }
            catch (RequestException error) { return error.Code + ": " + error.Message; }
        }
        // The sentences each operation answered when it unpacked first, unchanged.
        const string Close = " Close other results and try again.";
        check(ResultDiffer.TooLarge == "There is not enough result memory to compare these results." + Close
            && ViewSorter.DistinctTooLarge == "There is not enough result memory to list this column's values." + Close
            && RowIdentity.TooLarge == "There is not enough result memory to tell these rows apart." + Close
            && ResultSearcher.TooLarge == "There is not enough result memory to search these rows." + Close,
            "a diff, a distinct list, row identities and a search refused room to read fused answer the sentences they answered before");
        // Room for less than one page: the first room is refused.
        var pair = PairOf(true, true, bytes: 64L << 20);
        var filler = pair.Store.BeginQuery("filler");
        check(pair.Store.TryReserve(filler, pair.Store.GlobalBytes - pair.Store.UsedBytes - 64 * 1024, false, out _), "the whole-result refusal checks fill the budget");
        var used = pair.Store.UsedBytes;
        bool Kept() => pair.Left.HasPacked && pair.Right.HasPacked && pair.Store.UsedBytes == used;
        var diff = Code(() => ResultDiffer.Compare(pair.Left, pair.Left.SealedSnapshot(), pair.Right, pair.Right.SealedSnapshot(), false, CancellationToken.None));
        var distinct = Code(() => ViewSorter.DistinctValues(pair.Left, pair.Left.SealedSnapshot(), null, 3, true, CancellationToken.None));
        var identify = Code(() => RowIdentity.Build(pair.Left, pair.Left.SealedSnapshot(), IdentityBy.Auto, -1, CancellationToken.None));
        var search = Code(() => ResultSearcher.Search(pair.Left, pair.Left.SealedSnapshot(), null, "word", 0, false, 10, CancellationToken.None));
        check(diff == "TOO_LARGE: " + ResultDiffer.TooLarge && distinct == "TOO_LARGE: " + ViewSorter.DistinctTooLarge && identify == "TOO_LARGE: " + RowIdentity.TooLarge
            && search == "TOO_LARGE: " + ResultSearcher.TooLarge && Kept(),
            "with no room for a fused read's room, a diff, a distinct list, row identities and a search of packed results are refused with their own sentences, and nothing is held: "
            + diff + " | " + distinct + " | " + identify + " | " + search);

        // The unified result refused its rooms, its comparison made with room to spare.
        pair.Store.Return(filler, filler.UsedBytes);
        var model = ResultDiffer.Compare(pair.Left, pair.Left.SealedSnapshot(), pair.Right, pair.Right.SealedSnapshot(), false, CancellationToken.None);
        var unified = pair.Store.Open(pair.Left.Budget, 1, 1, 1, "diff", UnifiedDiff.Columns(pair.Right, model), UnifiedDiff.Wires(pair.Right, model), lengths: UnifiedDiff.Lengths(pair.Right, model), derived: true)!;
        pair.Store.TryReserve(filler, pair.Store.GlobalBytes - pair.Store.UsedBytes - 64 * 1024, false, out _);
        used = pair.Store.UsedBytes;
        var written = Code(() => UnifiedDiff.Write(unified, pair.Left, pair.Left.SealedSnapshot(), pair.Right, pair.Right.SealedSnapshot(), model, -1, CancellationToken.None, "no room to show"));
        check(written == "TOO_LARGE: no room to show" && unified.RowsAvailable == 0 && unified.IsComplete && Kept(), "a unified diff refused room to read packed results is refused with the sentence it is given, writes nothing and completes its result");
        pair.Store.Release([unified.ResultId]);

        // Room to work but none to spare: the writer unpacks its pages itself, ahead of nothing, and writes the same rows.
        pair.Store.Return(filler, filler.UsedBytes);
        // The rows as text: each result's pages carry its own id.
        string Written(long free, DiffStages stages)
        {
            var into = pair.Store.Open(pair.Left.Budget, 1, 1, 1, "diff", UnifiedDiff.Columns(pair.Right, model), UnifiedDiff.Wires(pair.Right, model), lengths: UnifiedDiff.Lengths(pair.Right, model), derived: true)!;
            if (free > 0) pair.Store.TryReserve(filler, pair.Store.GlobalBytes - pair.Store.UsedBytes - free, false, out _);
            UnifiedDiff.Write(into, pair.Left, pair.Left.SealedSnapshot(), pair.Right, pair.Right.SealedSnapshot(), model, 0, CancellationToken.None, ResultDiffer.TooLarge, stages);
            pair.Store.Return(filler, filler.UsedBytes);
            string rows;
            using (into.Pin()) rows = string.Join('\n', into.SealedSnapshot().SelectMany(page => PageReader.Read(page.Body(), into.Wires).Rows).Select(row => string.Join("|", row.Select(cell => cell.Flags + ":" + cell.Text))));
            pair.Store.Release([into.ResultId]);
            return rows;
        }
        var roomy = new DiffStages();
        var tight = new DiffStages();
        var withRoom = Written(0, roomy);
        // Free room for the writer's rooms and half its rooms ahead beyond the eighth spare memory leaves.
        long aheadBytes;
        using (pair.Left.Pin()) aheadBytes = 2L * Math.Min(PageAhead.Batch, PageCount(pair.Left)) * pair.Left.SealedSnapshot().Max(page => (long)page.Length);
        var withoutSpare = Written(pair.Store.GlobalBytes / 8 + aheadBytes / 2 + 8 * aheadBytes / Math.Max(1, 2 * Math.Min(PageAhead.Batch, PageCount(pair.Left))), tight);
        check(withRoom == withoutSpare && withRoom.Length > 0 && roomy.WrittenAhead > 0 && tight.WrittenAhead == 0 && tight.WrittenBehind > 0 && pair.Left.HasPacked && pair.Right.HasPacked,
            "a unified diff with room to work but none to spare unpacks its pages itself and writes the rows it writes with room ahead: "
            + roomy.WrittenAhead + " ahead with room, " + tight.WrittenBehind + " by the writer without");

        // Room for the rooms but not to unpack a first result read far from its pages' order: refused, nothing held.
        var far = PairOf(true, true, shuffled: true, bytes: 64L << 20);
        var farFiller = far.Store.BeginQuery("filler");
        long pageLength;
        using (far.Left.Pin()) pageLength = far.Left.SealedSnapshot().Max(page => (long)page.Length);
        var growth = Held.Unpacking(far.Left);
        // One worker: the probe's and a pass's reader and one run's six kept pages, well under the first result's growth.
        using var one = ViewSorter.WorkersHere(1);
        var room = 12 * pageLength;
        far.Store.TryReserve(farFiller, far.Store.GlobalBytes - far.Store.UsedBytes - room, false, out _);
        var farUsed = far.Store.UsedBytes;
        var farCode = Code(() => ResultDiffer.Compare(far.Left, far.Left.SealedSnapshot(), far.Right, far.Right.SealedSnapshot(), false, CancellationToken.None));
        check(growth > room && farCode == "TOO_LARGE: " + ResultDiffer.TooLarge && far.Left.HasPacked && far.Right.HasPacked && far.Store.UsedBytes == farUsed,
            "a diff with room for its rooms but not to unpack a first result read far from its pages' order is refused with its sentence and holds nothing: " + farCode + ", " + growth + " to unpack, " + room + " free");

        // On one worker, room for three pages: row identities (a pass per candidate, its reader's room given back between
        // them) and a search through a filtered view (two rooms a run) both run.
        var few = PairOf(true, true, bytes: 64L << 20);
        var nearView = few.Store.AddView(few.Left, ViewSorter.Build(few.Left, few.Left.SealedSnapshot(), [], [new ViewFilter(FilterOp.In, 1, GroupRows(2), false, null, [])], CancellationToken.None).Order, [], false, true, 0, null);
        var fewFiller = few.Store.BeginQuery("filler");
        few.Store.TryReserve(fewFiller, few.Store.GlobalBytes - few.Store.UsedBytes - 3 * pageLength, false, out _);
        var fewIdentity = Code(() => RowIdentity.Build(few.Left, few.Left.SealedSnapshot(), IdentityBy.Auto, -1, CancellationToken.None));
        var fewSearch = Code(() => ResultSearcher.Search(few.Left, few.Left.SealedSnapshot(), nearView, "word", 0, false, 10, CancellationToken.None, null, 1));
        check(fewIdentity is null && fewSearch is null && few.Left.HasPacked,
            "with room for three pages on one worker, row identities and a search through a filtered view of a packed result read it fused: " + fewIdentity + " | " + fewSearch);

        // A distinct list's later reads are never refused: with no room for a page, its values are read through the cache.
        var store = Packed();
        var set = Filled(store, "full reads");
        var snapshot = ViewSorter.DistinctValues(set, set.SealedSnapshot(), null, 3, true, CancellationToken.None);
        var listed = snapshot.Read(DistinctOrder.Value, 0, ViewSorter.MaxDistinctWindow, null, CancellationToken.None).Values;
        var full = store.BeginQuery("filler");
        store.TryReserve(full, store.GlobalBytes - store.UsedBytes - 1024, false, out _);
        var fullUsed = store.UsedBytes;
        var again = snapshot.Read(DistinctOrder.Value, 0, ViewSorter.MaxDistinctWindow, null, CancellationToken.None).Values;
        var searched = snapshot.Read(DistinctOrder.Value, 0, ViewSorter.MaxDistinctWindow, "REFERENCE-0002", CancellationToken.None);
        check(again.Select(value => value.Text).SequenceEqual(listed.Select(value => value.Text)) && searched.Total == 100 && store.UsedBytes == fullUsed,
            "a distinct list of a packed result reads and searches its values with no room for a page, through the set's accessor: " + searched.Total + " found, " + (store.UsedBytes - fullUsed) + " bytes held");

        // Rooms ask the system's memory load as they grow, once for every CheckBytes taken (here every byte).
        var low = false;
        var busy = new ResultStore(1L << 30, 1L << 30, () => (low ? 100 : 0, 50)) { Packing = PagePacking.EveryComplete };
        var busySet = Filled(busy, "busy rooms", 2_000);
        using (busySet.Pin())
        {
            using var calm = new PageRooms(busySet, 4096, 0, () => new RequestException("TOO_LARGE", "refused")) { CheckBytes = 1 };
            calm.Rent().Dispose();
            low = true;
            using var pressed = new PageRooms(busySet, 4096, 0, () => new RequestException("TOO_LARGE", "refused")) { CheckBytes = 1 };
            var refused = Code(() => pressed.Rent());
            using var small = new PageRooms(busySet, 4096, 0, () => new RequestException("TOO_LARGE", "refused"));
            var unasked = Code(() => small.Rent().Dispose());
            low = false;
            check(calm.Made == 1 && refused == "TOO_LARGE: refused" && pressed.Reserved == 0 && unasked is null && small.Made == 1,
                "fused-read rooms ask the system's memory load once for every WorkCheckBytes they take together, and are refused while it is high");
        }
    }

    /// <summary>Run from Store's isolated lane (it collects the heap): a distinct snapshot keeps its result's pages, not their
    /// bytes, so a result packed after the snapshot was built holds only its packed bytes, and the snapshot still reads it.</summary>
    public static void SnapshotKeepsNoBodies(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 30) { Packing = PagePacking.OnRequest };
        var set = Filled(store, "snapshot bodies", 20_000);
        var snapshot = ViewSorter.DistinctValues(set, set.SealedSnapshot(), null, 3, true, CancellationToken.None);
        var listed = snapshot.Read(DistinctOrder.Value, 0, ViewSorter.MaxDistinctWindow, null, CancellationToken.None).Values.Select(value => value.Text).ToArray();
        var body = FirstBody(set);
        set.Pack();
        GC.Collect(GC.MaxGeneration, GCCollectionMode.Forced, blocking: true);
        var again = snapshot.Read(DistinctOrder.Value, 0, ViewSorter.MaxDistinctWindow, null, CancellationToken.None).Values.Select(value => value.Text).ToArray();
        check(set.HasPacked && !body.IsAlive && again.SequenceEqual(listed),
            "a distinct snapshot keeps no page bytes of its result, so packing the result frees them, and it reads its values from the packed pages");
        GC.KeepAlive(snapshot);
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static WeakReference FirstBody(ResultSetBuffer set)
    {
        using var pin = set.Pin();
        return new WeakReference(set.Raw(set.SealedSnapshot()[0]));
    }
}
