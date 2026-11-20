using System.Globalization;
using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>The change index (comparison plan PR 5): its kinds, units, overview and partners as the writer records them,
/// its charge and release with the diff, the refusal of a diff whose index the budget has no room for, the kind filter,
/// results.diffSeek in stored and view order (block skipping and wrapping), partner lookup under a view, and cut rows.</summary>
internal static partial class DiffChecks
{
    private static void IndexChecks(Action<bool, string> check)
    {
        Positions(check);
        IndexHost(check);
        IndexCharge(check);
        Partners(check);
        CutRows(check);
    }

    /// <summary>Seeking over more than one block: empty blocks are skipped, a seek wraps round, and a view's own running
    /// totals count in its order.</summary>
    private static void Positions(Action<bool, string> check)
    {
        const int rows = 3 * DiffIndex.BlockRows + 100;
        var builder = new DiffIndex.Builder(rows, 0, 0);
        for (var row = 0; row < rows; row++)
        {
            if (row == 5) builder.Add(DiffRowKind.Added, false, false, 1);
            else if (row == 2 * DiffIndex.BlockRows + 7) builder.Add(DiffRowKind.ChangedNew, false, false, 3);
            else builder.Add(DiffRowKind.Same, false, false, 0);
        }
        var index = builder.Build()!;
        var stored = index.Over();
        var far = 2 * DiffIndex.BlockRows + 7;
        check(index.Units == 4 && stored.Total == 4 && stored.Seek(-1, true) == 5 && stored.Seek(5, true) == far && stored.Seek(far, true) == 5
            && stored.Seek(-1, false) == far && stored.Seek(far, false) == 5 && stored.Seek(5, false) == far && stored.Seek(rows, false) == far && stored.Before(far) == 1 && stored.Before(rows - 1) == 4,
            "a stored-order seek skips empty blocks, wraps round both ways, and counts the units before a row from its block's running total");
        // Reversed: the far change comes first in view order.
        var order = Enumerable.Range(0, rows).Reverse().ToArray();
        var view = index.Over(order, index.ViewBlocks(order, CancellationToken.None));
        var farAt = rows - 1 - far;
        check(view.Total == 4 && view.Seek(-1, true) == farAt && view.Seek(farAt, true) == rows - 1 - 5 && view.Before(farAt) == 0 && view.Before(rows - 1 - 5) == 3,
            "a view's running totals follow its order, so a seek and the units before a position are the view's");
        var none = new DiffIndex.Builder(3, 0, 0);
        for (var row = 0; row < 3; row++) none.Add(DiffRowKind.Same, false, false, 0);
        check(none.Build()!.Over().Seek(-1, true) == -1 && new DiffIndex.Builder(0, 0, 0).Build()!.Over().Seek(-1, false) == -1, "with no change units nothing is found");
        var shortBuilder = new DiffIndex.Builder(2, 0, 0);
        shortBuilder.Add(DiffRowKind.Same, false, false, 0);
        check(shortBuilder.Build() is null, "an index of a diff cut short is never built");
        check(DiffIndex.Column(DiffRowKind.ChangedNew, false, "changedNew dup gap=3 ~0 2-4 7", true) == 2 && DiffIndex.Column(DiffRowKind.ChangedNew, false, "changedNew 2-4 7 ~9", false) == 7
            && DiffIndex.Column(DiffRowKind.ChangedNew, true, "changedNew 2 4 …", false) == 0 && DiffIndex.Column(DiffRowKind.Added, false, "added poss=3", true) == 0,
            "a seek lands on the first or last changed cell a tone lists, skipping flags and soft cells; a cut or added row lands on the first column");
    }

    /// <summary>The answer's units and overview, the stored kinds, the kind filter and seeks through the host.</summary>
    private static void IndexHost(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        string? Code(string method, object args)
        {
            try { Call<object>(method, args); return null; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "INVALID_PARAMS"; }
        }
        // Same, changed (a soft Name and a changed Price), added: stored as same, changedOld, changedNew, added.
        var (left, right) = Pair(store, [["1", "a", "1"], ["2", "b", "2"]], [["1", "a", "1"], ["2", "B", "3"], ["3", "c", "3"]]);
        var diff = Call<ResultsDiffResult>("results.diff", new { left = left.ResultId, right = right.ResultId, context = -1 });
        var id = diff.Descriptor.ResultId;
        var index = store.Find(id)!.DiffIndex!;
        check(diff.Units == 2 && diff.Overview is [0, DiffIndex.ChangedBit, DiffIndex.ChangedBit, DiffIndex.AddedBit] && index.Rows == 4
            && index.KindOf(1) == DiffRowKind.ChangedOld && index.UnitsOf(1) == 0 && index.KindOf(2) == DiffRowKind.ChangedNew && index.UnitsOf(2) == 1 && index.UnitsOf(3) == 1,
            "results.diff answers its change units (listed changed cells, not soft ones, and added rows; a change's on its new half) and an overview of the kinds: " + diff.Units + " " + string.Join(",", diff.Overview));

        ResultsDiffSeekResult Seek(object args) => Call<ResultsDiffSeekResult>("results.diffSeek", args);
        var first = Seek(new { resultId = id, from = -1, direction = "next" });
        var second = Seek(new { resultId = id, from = 2, direction = "next" });
        var wrapped = Seek(new { resultId = id, from = 3, direction = "next" });
        var back = Seek(new { resultId = id, from = 2, direction = "previous" });
        check(first is { Row: 2, Column: 2, Index: 1, Total: 2 } && second is { Row: 3, Column: 0, Index: 2, Total: 2 } && wrapped is { Row: 2, Index: 1 } && back is { Row: 3, Index: 2 },
            "results.diffSeek steps by change unit in stored order, landing on a changed half's cell or an added row's first column, and wraps round");

        // A view sorted by ItemId descending: the added row (3) first, then the changed halves (2), then the unchanged row.
        var sorted = Call<ResultsViewResult>("results.view", new { resultId = id, sort = new[] { new { column = 0, descending = true, mode = "value" } } });
        var inView = Seek(new { resultId = id, viewId = sorted.ViewId, from = -1, direction = "next" });
        var nextInView = Seek(new { resultId = id, viewId = sorted.ViewId, from = 0, direction = "next" });
        check(store.FindView(id, sorted.ViewId)!.UnitBlocks is [0, 2] && inView is { Row: 0, Column: 0, Index: 1, Total: 2 } && nextInView is { Row: 2, Column: 2, Index: 2, Total: 2 },
            "under a sorted view a seek goes in view order, its positions and numbers the view's");

        // The kind filter, alone and under a sort; its resolved form lists the kinds in order.
        var changes = Call<ResultsViewResult>("results.view", new { resultId = id, sort = Array.Empty<object>(), filters = new[] { new { op = "kind", kinds = new[] { "added", "changed" } } } });
        var view = store.FindView(id, changes.ViewId)!;
        check(changes.Rows == 3 && view.Order is [1, 2, 3] && changes.Filters is [{ Op: "kind", Kinds: ["changed", "added"] }],
            "a kind filter keeps a comparison's rows of those kinds, a change's two halves as changed, and answers its kinds in order");
        var added = Call<ResultsViewResult>("results.view", new { resultId = id, sort = Array.Empty<object>(), filters = new[] { new { op = "kind", kinds = new[] { "added" } } } });
        var same = Call<ResultsViewResult>("results.view", new { resultId = id, sort = Array.Empty<object>(), filters = new[] { new { op = "kind", kinds = new[] { "same" } } } });
        var addedSeek = Seek(new { resultId = id, viewId = added.ViewId, from = -1, direction = "next" });
        check(added.Rows == 1 && addedSeek is { Row: 0, Index: 1, Total: 1 } && same.Rows == 1 && Seek(new { resultId = id, viewId = same.ViewId, from = -1, direction = "previous" }) is { None: true },
            "a filtered view's totals are its own rows' units; one with none finds nothing");
        var plain = left.ResultId;
        var codes = new[]
        {
            Code("results.view", new { resultId = plain, sort = Array.Empty<object>(), filters = new[] { new { op = "kind", kinds = new[] { "added" } } } }),
            Code("results.view", new { resultId = id, sort = Array.Empty<object>(), filters = new[] { new { op = "kind", kinds = new[] { "added", "added" } } } }),
            Code("results.view", new { resultId = id, sort = Array.Empty<object>(), filters = new[] { new { op = "kind", kinds = new[] { "moved" } } } }),
            Code("results.view", new { resultId = id, sort = Array.Empty<object>(), filters = new[] { new { op = "kind", kinds = Array.Empty<string>() } } }),
            Code("results.view", new { resultId = id, sort = Array.Empty<object>(), filters = new[] { new { op = "kind", kinds = new[] { "added" }, column = 0 } } }),
            Code("results.view", new { resultId = id, sort = Array.Empty<object>(), filters = new object[] { new { op = "duplicates", columns = new[] { 0 }, kinds = new[] { "added" } } } }),
            Code("results.diffSeek", new { resultId = plain, from = -1, direction = "next" }),
            Code("results.diffSeek", new { resultId = id, from = -2, direction = "next" }),
            Code("results.diffSeek", new { resultId = id, from = 0, direction = "up" }),
            Code("results.diffSeek", new { resultId = id, from = 0 }),
            Code("results.diffSeek", new { resultId = id, from = 0, direction = "next", partnerOf = 1 }),
            Code("results.diffSeek", new { resultId = id }),
            Code("results.diffSeek", new { resultId = id, partnerOf = -1 }),
            Code("results.diffSeek", new { resultId = id, viewId = 9999, from = 0, direction = "next" }),
            Code("results.diffSeek", new { resultId = 9999, from = 0, direction = "next" })
        };
        check(string.Join(",", codes) == "INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,VIEW_NOT_FOUND,RESULT_NOT_FOUND",
            "a kind filter is a comparison's only, with 1 to 4 distinct known kinds and nothing else; a seek names a comparison, and either a position and direction or a partner's position: " + string.Join(",", codes));
        check(SqlService.MethodNames.Contains("results.diffSeek") && service.LaneOf("results.diffSeek") == RequestLane.Results && Providers.Of("results.diffSeek").Count == 2,
            "results.diffSeek is a method of the results lane, for both engines");

        // Under a sort (ItemId descending: the added row, then the change's halves) and before another filter (duplicate
        // ItemIds: the change's two halves), a kind filter keeps its rows and a seek goes in the view's order.
        var sortedChanges = Call<ResultsViewResult>("results.view", new { resultId = id, sort = new[] { new { column = 0, descending = true, mode = "value" } }, filters = new[] { new { op = "kind", kinds = new[] { "changed", "added" } } } });
        var halves = Call<ResultsViewResult>("results.view", new { resultId = id, sort = Array.Empty<object>(), filters = new object[] { new { op = "kind", kinds = new[] { "changed", "added" } }, new { op = "duplicates", columns = new[] { 0 } } } });
        check(store.FindView(id, sortedChanges.ViewId)!.Order is [3, 1, 2] && Seek(new { resultId = id, viewId = sortedChanges.ViewId, from = 0, direction = "next" }) is { Row: 2, Column: 2, Index: 2, Total: 2, Rows: 3 }
            && store.FindView(id, halves.ViewId)!.Order is [1, 2] && halves.Filters is [{ Op: "kind" }, { Op: "duplicates" }],
            "a kind filter under a sort keeps its rows in the sort's order, and a later filter sees only its rows");

        store.Release(id);
        check(Code("results.diffSeek", new { resultId = id, from = -1, direction = "next" }) == "RESULT_RELEASED", "a seek on a released comparison answers RESULT_RELEASED");

        // More stored rows than buckets: a change first, the added row last, each in its own end bucket of 512.
        static string?[][] Rows(int count) => [.. Enumerable.Range(1, count).Select(i => new[] { i.ToString(CultureInfo.InvariantCulture), "n" + i.ToString(CultureInfo.InvariantCulture), "1" })];
        var leftRows = Rows(1000);
        string?[][] rightRows = [["1", "n1", "2"], .. leftRows.Skip(1), ["1001", "n1001", "1"]];
        var (big, bigger) = Pair(store, leftRows, rightRows);
        var wide = Call<ResultsDiffResult>("results.diff", new { left = big.ResultId, right = bigger.ResultId, context = -1 });
        check(wide.Overview.Length == DiffIndex.OverviewBuckets && wide.Overview[0] == DiffIndex.ChangedBit && wide.Overview[^1] == DiffIndex.AddedBit && wide.Overview[1..^1].All(bits => bits == 0) && wide.Units == 2,
            "past 512 stored rows the overview has 512 even buckets, each the kinds of its rows: " + string.Join(",", wide.Overview.Take(3)) + " … " + wide.Overview[^1]);
    }

    /// <summary>The index is charged to the query budget with its diff, exactly its bytes, a diff's views charge their running
    /// totals, both are returned on release, and a diff whose index the budget has no room for is refused whole.</summary>
    private static void IndexCharge(Action<bool, string> check)
    {
        static string?[][] Rows(int count) => [.. Enumerable.Range(1, count).Select(i => new[] { i.ToString(CultureInfo.InvariantCulture), "n" + i.ToString(CultureInfo.InvariantCulture), "1.00" })];
        var store = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.Off };
        using (var service = new SqlService(store))
        {
            T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
            var (left, right) = Pair(store, Rows(300), [.. Rows(300).Select((row, at) => at % 3 == 0 ? new[] { row[0], row[1], "2.00" } : row)]);
            // The same rows written without an index: what the diff holds besides it.
            var model = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None);
            var before = Held.Bytes(store);
            var bare = Unified(store, left, right, model);
            var rowsOnly = Held.Bytes(store) - before;
            store.Release(bare.ResultId);
            check(Held.Bytes(store) == before, "a diff written without an index returns what it held");
            var diff = Call<ResultsDiffResult>("results.diff", new { left = left.ResultId, right = right.ResultId, context = -1 });
            var set = store.Find(diff.Descriptor.ResultId)!;
            var withIndex = Held.Bytes(store) - before;
            check(set.DiffIndex is { Rows: 400 } index && index.Bytes == DiffIndex.BytesFor(400, 0) && withIndex == rowsOnly + index.Bytes && diff.Units == 100,
                $"the change index is charged with its diff, exactly its bytes: {withIndex} = {rowsOnly} + {set.DiffIndex?.Bytes}");
            var sorted = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 2, descending = true, mode = "value" } } });
            var withView = Held.Bytes(store) - before;
            check(withView - withIndex == 4L * 400 + ResultStore.ViewOverhead + DiffIndex.ViewBlockBytes(400) && store.FindView(set.ResultId, sorted.ViewId)!.UnitBlocks!.Length == 2,
                $"a diff's view charges its order and its running totals: {withView - withIndex}");
            store.Release(set.ResultId);
            check(Held.Bytes(store) == before && set.DiffIndex is null, "releasing the diff returns its rows, its index and its views' totals: " + (Held.Bytes(store) - before));
        }

        // A budget with room for the sources and the alignment (identical rows: no differing cells) but not the index.
        var roomy = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.Off };
        Pair(roomy, Rows(400), Rows(400));
        var sources = Held.Bytes(roomy);
        var tight = new ResultStore(1L << 30, sources + ResultDiffer.WorkingBytes(400, 400) + DiffIndex.BytesFor(400, 0) - 1) { Packing = PagePacking.Off };
        using (var service = new SqlService(tight))
        {
            var (left, right) = Pair(tight, Rows(400), Rows(400));
            var used = Held.Bytes(tight);
            var count = tight.Count;
            string? refused;
            try { service.DispatchAsync("results.diff", JsonSerializer.SerializeToElement(new { left = left.ResultId, right = right.ResultId, context = -1 }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); refused = null; }
            catch (RequestException error) { refused = error.Code + ": " + error.Message; }
            check(used == sources && refused == "TOO_LARGE: There is not enough result memory to show the differences. Close other results and try again." && Held.Bytes(tight) == used && tight.Count == count
                && left.Budget.Stopped == TruncationReason.None,
                $"a diff whose change index the budget refuses is refused whole and keeps nothing: {refused} {Held.Bytes(tight) - used}");
        }
    }

    /// <summary>A look-alike row's partner: a stored row in stored order, a view position under a sort, hidden under a kind
    /// filter that leaves it out, and none for a row without one.</summary>
    private static void Partners(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        // The diff's rows: same (1), removed (2, poss), added (9, poss).
        var (left, right) = Pair(store, [["1", "x", "1"], ["2", "plum", "3"]], [["1", "x", "1"], ["9", "plum", "3"]]);
        var diff = Call<ResultsDiffResult>("results.diff", new { left = left.ResultId, right = right.ResultId, context = -1, match = new { mode = "columns", columns = new[] { 0 } } });
        var id = diff.Descriptor.ResultId;
        var index = store.Find(id)!.DiffIndex!;
        ResultsDiffSeekResult Partner(long of, uint? view = null) => Call<ResultsDiffSeekResult>("results.diffSeek", view is null ? new { resultId = id, partnerOf = of } : (object)new { resultId = id, viewId = view, partnerOf = of });
        check(diff.Possible == 1 && index.PartnerOf(1) == 2 && index.PartnerOf(2) == 1 && index.PartnerOf(0) == -1
            && Partner(1) is { Row: 2, Column: 0, Index: 2, Total: 2, Rows: 3 } && Partner(2) is { Row: 1, Index: 1 } && Partner(0) is { None: true } && Partner(7) is { None: true },
            "a look-alike row's partner is its stored row in the diff, found without a search; a row without one, or past the rows, has none");
        // Sorted by ItemId descending: added (9) at 0, removed (2) at 1, same (1) at 2.
        var sorted = Call<ResultsViewResult>("results.view", new { resultId = id, sort = new[] { new { column = 0, descending = true, mode = "value" } } });
        check(Partner(1, sorted.ViewId) is { Row: 0, Index: 1, Total: 2 } && Partner(0, sorted.ViewId) is { Row: 1, Index: 2 },
            "under a sorted view a partner is found by view position, and its position is the view's");
        var removedOnly = Call<ResultsViewResult>("results.view", new { resultId = id, sort = Array.Empty<object>(), filters = new[] { new { op = "kind", kinds = new[] { "removed" } } } });
        check(Partner(0, removedOnly.ViewId) is { Hidden: true } && Call<ResultsDiffSeekResult>("results.diffSeek", new { resultId = id, viewId = removedOnly.ViewId, from = -1, direction = "next" }) is { Row: 0, Rows: 1 }, "a partner the view's filter leaves out is hidden, not missing");
        // A diff freed while a view of it builds has no index at the kind step: the build is cancelled (UntilReleased answers
        // RESULT_RELEASED), not refused as if the result were not a comparison.
        var freed = store.Find(id)!;
        var pages = freed.SealedSnapshot();
        store.Release(id);
        string? outcome;
        try { ViewSorter.Build(freed, pages, [], [new ViewFilter(FilterOp.Kind, -1, null, false, null, [], Kinds: DiffKindSet.Removed)], CancellationToken.None); outcome = "built"; }
        catch (OperationCanceledException) { outcome = "cancelled"; }
        catch (RequestException error) { outcome = error.Code; }
        check(outcome == "cancelled", "a kind filter on a diff freed mid-build is cancelled, answered as released: " + outcome);
    }

    /// <summary>A row with more scattered changes than its tone lists: both halves are flagged cut, the new half counts one more unit for it, and a seek
    /// backwards lands on it at the first column.</summary>
    private static void CutRows(Action<bool, string> check)
    {
        const int width = 600;
        ResultColumn[] columns = [new("Id", "int", "text"), .. Enumerable.Range(1, width).Select(c => new ResultColumn("c" + c.ToString(CultureInfo.InvariantCulture), "int", "text"))];
        string?[] Row(int value) => [.. new[] { "1" }.Concat(Enumerable.Range(1, width).Select(c => (c % 2 == 0 ? 0 : value).ToString(CultureInfo.InvariantCulture)))];
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var (left, right) = Pair(store, [Row(1)], [Row(2)], columns, columns);
        var diff = (ResultsDiffResult)service.DispatchAsync("results.diff", JsonSerializer.SerializeToElement(new { left = left.ResultId, right = right.ResultId, context = -1 }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        var set = store.Find(diff.Descriptor.ResultId)!;
        var index = set.DiffIndex!;
        string? tone;
        using (set.Pin()) tone = DiffIndex.ToneOf(set, 1);
        var listed = DiffIndex.ListedCells(tone!).Sum(cells => cells.Last - cells.First + 1);
        T Call<T>(object args) => (T)service.DispatchAsync("results.diffSeek", JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        var next = Call<ResultsDiffSeekResult>(new { resultId = set.ResultId, from = -1, direction = "next" });
        var previous = Call<ResultsDiffSeekResult>(new { resultId = set.ResultId, from = -1, direction = "previous" });
        check(tone!.EndsWith(" …", StringComparison.Ordinal) && index.IsCut(1) && index.IsCut(0) && index.UnitsOf(0) == 0 && listed is > 0 and < width / 2 && index.UnitsOf(1) == listed + 1 && diff.Units == listed + 1
            && diff.ColumnChanges.Sum(change => change.Changed) == width / 2 && next is { Row: 1, Column: 1, Index: 1 } && previous is { Row: 1, Column: 0 } && previous.Index == listed + 1,
            $"a cut row's units are its listed cells and one for the cut, which a backward seek lands on at the first column: {listed} listed, {index.UnitsOf(1)} units, {diff.Units} total, {diff.ColumnChanges.Sum(change => change.Changed)} changed, next {next.Row}/{next.Column}/{next.Index}, previous {previous.Row}/{previous.Column}/{previous.Index}");
    }
}
