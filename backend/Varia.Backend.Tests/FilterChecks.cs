using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Filtered views (results.view's filters): In, NotIn and Between from selected cells or base rows, equal by the
/// column's collation; NULL among the values; duplicates on one column, several and every column; filters before the sort;
/// resolved filters rebuilding the same view; the distinct value limit; Keep Selected Rows (keepRows: the rows of a
/// selection themselves, over sorted and filtered views, its limits, and while rows stream); and the request's checks and
/// budget through the host.</summary>
internal static class FilterChecks
{
    // Latin1_General_CI_AS and Latin1_General_BIN2.
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);
    private static readonly ResultCollation Bin2 = new(1033, 0, 1252, false, 16384);

    private static readonly ResultColumn[] Columns =
    [
        new("id", "int", "text"), new("name", "nvarchar", "text", Collation: CaseInsensitive), new("code", "varchar", "text", Collation: Bin2), new("score", "float", "text")
    ];
    private static readonly WireKind[] Wires = [.. Columns.Select(_ => WireKind.Text)];

    /// <summary>Rows: id, name, code, score (null for NULL).</summary>
    private static readonly string?[][] Rows =
    [
        ["0", "a", "a", "1"],
        ["1", "B", "B", "2"],
        ["2", "A  ", "A", "1"],
        ["3", null, null, "3"],
        ["4", "b", "b", null],
        ["5", "a", "a", "1"],
        ["6", "c", "c", "2.0"]
    ];

    public static void Run(Action<bool, string> check)
    {
        Filtering(check);
        Duplicates(check);
        SharedKeys(check);
        KeepRows(check);
        Limits(check);
        HostRequests(check);
        Streaming(check);
    }

    private static int fills;

    private static ResultSetBuffer Fill(ResultStore store, string?[][] rows, ResultColumn[]? columns = null)
    {
        columns ??= Columns;
        var set = store.Open(store.BeginQuery("filters" + Interlocked.Increment(ref fills)), 0, 1, 1, "rows", columns, [.. columns.Select(_ => WireKind.Text)]) ?? throw new InvalidOperationException("The result set was not kept.");
        foreach (var row in rows)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            foreach (var cell in row)
            {
                if (cell is null) builder.AppendNull();
                else builder.AppendText(cell);
            }
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    private static (int[] Order, ViewFilter[] Filters) Build(ResultSetBuffer set, ViewKey[] keys, params ViewFilter[] filters)
    {
        var built = ViewSorter.Build(set, set.SealedSnapshot(), keys, filters, CancellationToken.None);
        return (built.Order, built.Filters);
    }

    private static ViewFilter Cells(FilterOp op, int column, int[]? order, params (long, long)[] ranges) => new(op, column, null, false, new ViewCells(order, ranges), []);

    private static ViewFilter Named(FilterOp op, int column, int[] rows, bool nulls = false) => new(op, column, rows, nulls, null, []);

    private static ViewFilter Dups(params int[] columns) => new(FilterOp.Duplicates, -1, null, false, null, columns);

    private static ViewFilter Keep(int[]? order, params (long, long)[] ranges) => new(FilterOp.KeepRows, -1, null, false, new ViewCells(order, ranges), []);

    private static ViewFilter KeepNamed(params int[] rows) => new(FilterOp.KeepRows, -1, rows, false, null, []);

    private static string Show(int[] order) => string.Join(",", order);

    private static void Filtering(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store, Rows);
        var (inCi, resolved) = Build(set, [], Cells(FilterOp.In, 1, null, (0, 1)));
        check(Show(inCi) == "0,2,5" && resolved[0] is { Cells: null, Nulls: false, Rows: [0] },
            "In from one selected cell keeps the rows its collation calls equal (case and trailing spaces ignored) and resolves to one row per value");
        check(Show(Build(set, [], Cells(FilterOp.In, 2, null, (0, 1))).Order) == "0,5", "In on a _BIN2 column keeps only the same code points");
        var (notIn, notResolved) = Build(set, [], Cells(FilterOp.NotIn, 1, null, (1, 3)));
        check(Show(notIn) == "6" && notResolved[0] is { Nulls: true, Rows.Length: 2 },
            "NotIn from cells holding B, A and NULL drops those values by collation (b and a too) and NULL, keeping the rest");
        check(Show(Build(set, [], Named(FilterOp.NotIn, 1, [], nulls: true)).Order) == "0,1,2,4,5,6", "Exclude NULLs (NotIn with only NULL) drops just the NULL rows");
        check(Show(Build(set, [], Named(FilterOp.In, 1, [], nulls: true)).Order) == "3", "In with only NULL keeps just the NULL rows");
        // A view sorted by score descending (id order 3,1,6,0,2,5,4): its positions 1 and 2 are ids 1 and 6 (scores 2 and 2.0).
        var sorted = Build(set, [new ViewKey(3, true, SortMode.Value)]).Order;
        var (fromView, viewResolved) = Build(set, [], Cells(FilterOp.In, 3, sorted, (1, 2)));
        check(Show(sorted) == "3,1,6,0,2,5,4" && Show(fromView) == "1,6" && viewResolved[0].Rows is [1],
            "cells in a sorted view name that view's rows, and a float column's equal values (2 and 2.0) are one value");
        var (between, betweenResolved) = Build(set, [], Cells(FilterOp.Between, 3, null, (0, 4)));
        check(Show(between) == "0,1,2,3,5,6" && betweenResolved[0] is { Rows: [0, 3], Nulls: false },
            "Between keeps the rows from the selection's lowest value to its highest, without NULL, resolved to those two rows");
        // Overlapping and out-of-range cells read each position once (the request's 256 ranges cannot multiply the rows).
        var (overlapped, overlappedResolved) = Build(set, [], Cells(FilterOp.In, 1, null, [.. Enumerable.Repeat((0L, (long)int.MaxValue), 256)]));
        check(Show(overlapped) == "0,1,2,3,4,5,6" && overlappedResolved[0] is { Nulls: true, Rows.Length: 3 },
            "256 overlapping ranges over every row filter once by each distinct value and NULL");
        check(string.Join(" ", ViewSorter.Merge([(5, 3), (0, 2), (1, 2), (20, 4), (7, 1), (30, 1)], 22)) == "(0, 3) (5, 8) (20, 22)",
            "cell ranges merge into sorted, disjoint spans clipped to the positions there are");
        check(Show(Build(set, [], betweenResolved).Order) == Show(between) && Show(Build(set, [], resolved).Order) == Show(inCi) && Show(Build(set, [], notResolved).Order) == Show(notIn),
            "resolved filters build the same views again (as the renderer rebuilds them once more rows arrive)");
        var (sortedFilter, _) = Build(set, [new ViewKey(0, true, SortMode.Value)], Cells(FilterOp.In, 1, null, (0, 1)));
        check(Show(sortedFilter) == "5,2,0", "a sort orders only the rows the filters kept");
        var (both, _) = Build(set, [], Cells(FilterOp.In, 1, null, (0, 2)), Named(FilterOp.In, 3, [0]));
        check(Show(both) == "0,2,5", "filters combine: each keeps rows among those the ones before it kept");
        var single = Build(set, [], Cells(FilterOp.Between, 3, null, (0, 1)));
        check(Show(single.Order) == "0,2,5" && single.Filters[0].Rows is [0, 0] && Show(Build(set, [], single.Filters).Order) == "0,2,5",
            "Between over one value keeps that value, and its resolved rows (the same row twice) build it again");
        var threw = Throws(() => Build(set, [], Cells(FilterOp.Between, 1, null, (3, 1))));
        check(threw == "INVALID_PARAMS", "Between over only NULL cells is refused");
        check(Throws(() => Build(set, [], Named(FilterOp.In, 1, [99]))) == "INVALID_PARAMS", "a filter row beyond the result is refused");
    }

    private static void Duplicates(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store, Rows);
        check(Show(Build(set, [], Dups(1)).Order) == "0,2,5,1,4", "duplicates in a collated column group equal values (a, A  , a then B, b) in the order of their first rows");
        check(Show(Build(set, [], Dups(2)).Order) == "0,5", "duplicates in a _BIN2 column count only identical values");
        check(Show(Build(set, [], Dups(1, 3)).Order) == "0,2,5", "duplicates in several columns compare them together");
        var rows = Rows.Select(row => row.ToArray()).Append(["3", null, null, "3"]).Append(["6", "C", "c", "2"]).ToArray();
        var withNulls = Fill(store, rows);
        check(Show(Build(withNulls, [], Dups(0, 1, 2, 3)).Order) == "3,7,6,8", "duplicate rows compare every column, NULL equal to NULL as GROUP BY has it");
        var sortedDups = Show(Build(set, [new ViewKey(0, true, SortMode.Value)], Dups(1)).Order);
        check(sortedDups == "5,4,2,1,0", "a sort orders duplicate rows like any others");
    }

    /// <summary>A Value sort key on a filtered column is the filter's key, and sort keys are built over only the rows the
    /// filters kept: either way the view is the sorted rows the filters keep, in either direction, and the filters resolve as
    /// they do alone (they compare ascending whatever the sort's direction).</summary>
    private static void SharedKeys(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var small = Fill(store, Rows);
        // Over two pages (4,096 rows each): long values share their 8-byte prefixes, so ties read the stored cells again; texts
        // differ in length (for a Chars key), and a decimal column repeats values written two ways (1 and 1.00), so its ties
        // compare the stored text of rows a key built over only the kept rows indexes by their place.
        string Text(int value) => value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var big = Fill(store, [.. Enumerable.Range(0, 10_000).Select(i => new string?[]
        {
            Text(i), i % 17 == 0 ? null : $"name-prefix-{i % 13:D2}" + new string('x', i % 3), $"code-prefix-{i % 11:D2}" + new string('y', i % 4),
            i % 5 == 4 ? "2.0" : Text(i % 5), i % 2 == 0 ? Text(i % 7) : Text(i % 7) + ".00"
        })], [.. Columns, new("amount", "decimal(9,2)", "text")]);
        // Each case: the filtered column, another Value key, and a column a Chars key sorts by (or -1).
        (ResultSetBuffer Set, string Name, int Column, int Other, int Length, ViewFilter[] Filters)[] cases =
        [
            (small, "a collated column", 1, 0, -1, [Named(FilterOp.In, 1, [0]), Named(FilterOp.NotIn, 1, [1], nulls: true), Named(FilterOp.Between, 1, [0, 1]), Dups(1)]),
            (small, "a float column", 3, 1, -1, [Named(FilterOp.In, 3, [1]), Named(FilterOp.NotIn, 3, [0], nulls: true), Named(FilterOp.Between, 3, [0, 1]), Dups(3)]),
            (big, "a collated column over two pages", 1, 4, 2, [Named(FilterOp.In, 1, [1, 2, 3]), Named(FilterOp.NotIn, 1, [1, 2], nulls: true), Named(FilterOp.Between, 1, [3, 8]), Dups(1, 3)]),
            // Duplicates in the codes keep every row (each repeats): the sort then takes the whole, grouped order.
            (big, "a _BIN2 column over two pages", 2, 4, 1, [Named(FilterOp.In, 2, [1, 2]), Named(FilterOp.NotIn, 2, [1]), Named(FilterOp.Between, 2, [3, 8]), Dups(2)])
        ];
        check(Build(big, [], Dups(2)).Order.Length == 10_000, "the duplicates case keeps every row");
        foreach (var (set, name, column, other, length, filters) in cases)
        {
            foreach (var filter in filters)
            {
                var (alone, aloneResolved) = Build(set, [], filter);
                var keptRows = alone.ToHashSet();
                foreach (var descending in new[] { true, false })
                {
                    ViewKey[] keys = length < 0
                        ? [new ViewKey(column, descending, SortMode.Value), new ViewKey(other, !descending, SortMode.Value), new ViewKey(0, false, SortMode.Value)]
                        : [new ViewKey(column, descending, SortMode.Value), new ViewKey(length, descending, SortMode.Chars), new ViewKey(other, !descending, SortMode.Value), new ViewKey(0, false, SortMode.Value)];
                    var expected = Build(set, keys).Order.Where(keptRows.Contains);
                    var (order, resolved) = Build(set, keys, filter);
                    check(order.SequenceEqual(expected) && (resolved[0].Rows ?? []).SequenceEqual(aloneResolved[0].Rows ?? []) && resolved[0].Nulls == aloneResolved[0].Nulls,
                        $"{filter.Op} on {name} sorted {(descending ? "descending" : "ascending")} by it is the sorted rows the filter keeps, resolved as alone");
                }
            }
        }
        check(ViewSorter.KeyCount([new ViewKey(1, true, SortMode.Value), new ViewKey(2, false, SortMode.Chars), new ViewKey(3, false, SortMode.Value)], [Named(FilterOp.In, 1, [0]), Dups(1, 2)]) == 4,
            "a view's keys count a Value sort key on a filtered column once, and a Chars key on one again");
    }

    /// <summary>Keep Selected Rows: the rows a selection covers in the view it was made on, resolved to base rows, whatever
    /// their values (rows 0, 2 and 5 hold equal names; keeping row 0 keeps only it).</summary>
    private static void KeepRows(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store, Rows);
        var (plain, plainResolved) = Build(set, [], Keep(null, (5, 1), (0, 2)));
        check(Show(plain) == "0,1,5" && plainResolved[0] is { Op: FilterOp.KeepRows, Cells: null, Column: -1, Nulls: false, Rows: [0, 1, 5] },
            "keepRows over the result's own order keeps the selected rows and resolves to them as base rows, ascending");
        check(Show(Build(set, [], Keep(null, (0, 1))).Order) == "0", "keepRows keeps the row, not the rows that share its values");
        // A view sorted by score descending is ids 3,1,6,0,2,5,4: its positions 1 and 2 are base rows 1 and 6.
        var sorted = Build(set, [new ViewKey(3, true, SortMode.Value)]).Order;
        var (fromSorted, sortedResolved) = Build(set, [new ViewKey(0, true, SortMode.Value)], Keep(sorted, (1, 2)));
        check(Show(fromSorted) == "6,1" && sortedResolved[0].Rows is [1, 6], "keepRows over a sorted view names that view's rows, and the new view's sort orders them");
        // Sorted by id descending and filtered to the name a (rows 5,2,0): positions 0 and 1 are base rows 5 and 2.
        var named = Named(FilterOp.In, 1, [0]);
        var filtered = Build(set, [new ViewKey(0, true, SortMode.Value)], named).Order;
        var (kept, keptResolved) = Build(set, [new ViewKey(0, true, SortMode.Value)], named, Keep(filtered, (0, 2)));
        check(Show(filtered) == "5,2,0" && Show(kept) == "5,2" && keptResolved[1].Rows is [2, 5] && keptResolved[0].Rows is [0],
            "keepRows over a sorted and filtered view resolves its positions to base rows, after the filters before it");
        check(Show(Build(set, [new ViewKey(0, true, SortMode.Value)], keptResolved).Order) == "5,2" && Show(Build(set, [], plainResolved).Order) == "0,1,5",
            "a resolved keepRows builds the same view again");
        check(Show(Build(set, [], Dups(1), KeepNamed(1, 0, 5)).Order) == "0,5,1", "keepRows keeps the order the filters before it gave (duplicates' groups)");
        check(Show(Build(set, [], KeepNamed(0, 1, 5), Dups(1)).Order) == "0,5", "a filter after keepRows sees only the rows it kept, so the view may show fewer than it names");
        var twice = Build(set, [], KeepNamed(5, 5, 0));
        check(Show(twice.Order) == "0,5" && twice.Filters[0].Rows is [0, 5], "rows named twice are kept once");
        check(Throws(() => Build(set, [], KeepNamed(7))) == "INVALID_PARAMS" && Throws(() => Build(set, [], KeepNamed(-1))) == "INVALID_PARAMS", "a keepRows row outside the result is refused");
        check(Throws(() => Build(set, [], KeepNamed())) == "INVALID_PARAMS", "a keepRows filter of no rows is refused");
        check(Throws(() => Build(set, [], Keep(null, (7, 3)))) == "INVALID_PARAMS" && Throws(() => Build(set, [], Keep(filtered, (3, 1)))) == "INVALID_PARAMS",
            "a selection past the view's rows keeps nothing and is refused");
        check(ViewSorter.KeyCount([new ViewKey(1, false, SortMode.Value)], [KeepNamed(0)]) == 1 && ViewSorter.KeyCount([], [KeepNamed(0), Keep(null, (0, 1))]) == 0
            && ViewSorter.KeyCount([], [Named(FilterOp.In, 1, [0]), KeepNamed(0)]) == 1,
            "keepRows compares no column: it is not one of a view's keys");
        var limit = ViewSorter.MaxKeepRows;
        var many = Fill(store, [.. Enumerable.Range(0, limit + 2).Select(i => new string?[] { i.ToString(System.Globalization.CultureInfo.InvariantCulture), "x", "x", "1" })]);
        check(limit == 4095 && Build(many, [], Keep(null, (1, limit))).Order.Length == limit, "keepRows takes 4,095 rows");
        check(Throws(() => Build(many, [], Keep(null, (0, limit + 1)))) == "TOO_LARGE", "keepRows over more than 4,095 rows answers TOO_LARGE");
        check(Throws(() => Build(many, [], Keep(null, (0, limit), (limit, 1)))) == "TOO_LARGE", "the row limit counts every range's rows");
        check(Build(many, [], Keep(null, [.. Enumerable.Repeat((0L, (long)limit), ViewSorter.MaxFilterRanges)])).Order.Length == limit,
            "256 overlapping ranges count each row once");
        check(Build(many, [], KeepNamed([.. Enumerable.Range(2, limit)])).Order.Length == limit && Throws(() => Build(many, [], KeepNamed([.. Enumerable.Range(0, limit + 1)]))) == "INVALID_PARAMS",
            "resolved keepRows rows are at most 4,095");
    }

    private static void Limits(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var many = Fill(store, [.. Enumerable.Range(0, ViewSorter.MaxFilterValues + 1).Select(i => new string?[] { i.ToString(System.Globalization.CultureInfo.InvariantCulture), "x", "x", "1" })]);
        check(Throws(() => Build(many, [], Cells(FilterOp.In, 0, null, (0, ViewSorter.MaxFilterValues + 1)))) == "TOO_LARGE", "In over more than 4,096 distinct values answers TOO_LARGE");
        check(Build(many, [], Cells(FilterOp.In, 1, null, (0, ViewSorter.MaxFilterValues + 1))).Order.Length == ViewSorter.MaxFilterValues + 1,
            "In over many cells of one value is one value");
        check(Build(many, [], Cells(FilterOp.Between, 0, null, (0, ViewSorter.MaxFilterValues + 1))).Order.Length == ViewSorter.MaxFilterValues + 1,
            "Between takes any number of selected values (only its lowest and highest are kept)");
    }

    /// <summary>A view built while rows stream answers the base rows it looked at (those sealed then), not the set's count.</summary>
    private static void Streaming(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var set = store.Open(store.BeginQuery("filters" + Interlocked.Increment(ref fills)), 0, 1, 1, "rows", Columns, Wires) ?? throw new InvalidOperationException("The result set was not kept.");
        void Add(string?[] row)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            foreach (var cell in row)
            {
                if (cell is null) builder.AppendNull();
                else builder.AppendText(cell);
            }
            set.TryCommitRow();
        }
        foreach (var row in Rows) Add(row);
        set.Seal();
        // Rows committed after the seal wait in the builder: the view does not see them.
        foreach (var row in Rows) Add(row);
        var view = (ResultsViewResult)service.DispatchAsync("results.view", JsonSerializer.SerializeToElement(new { resultId = set.ResultId, sort = Array.Empty<object>(), filters = new object[] { new { op = "in", column = 3, rows = new[] { 0 } } } }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        check(view.BaseRows == Rows.Length && view.Rows == 3 && !view.Complete && set.RowsRead == 2 * Rows.Length,
            "a view of a streaming set answers the sealed rows it was built from as baseRows, not the rows read since");
        set.Complete();
        var whole = (ResultsViewResult)service.DispatchAsync("results.view", JsonSerializer.SerializeToElement(new { resultId = set.ResultId, sort = Array.Empty<object>(), filters = new object[] { new { op = "in", column = 3, rows = new[] { 0 } } } }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        check(whole.BaseRows == 2 * Rows.Length && whole.Rows == 6 && whole.Complete, "once the set completes a view is built from all its rows");
        KeepWhileStreaming(check, store, service);
    }

    /// <summary>keepRows made while rows stream keeps the rows it resolved: re-sent once the set completes, it keeps those and
    /// none of the rows that arrived since.</summary>
    private static void KeepWhileStreaming(Action<bool, string> check, ResultStore store, SqlService service)
    {
        var set = store.Open(store.BeginQuery("filters" + Interlocked.Increment(ref fills)), 0, 1, 1, "rows", Columns, Wires) ?? throw new InvalidOperationException("The result set was not kept.");
        void Add(string?[] row)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            foreach (var cell in row)
            {
                if (cell is null) builder.AppendNull();
                else builder.AppendText(cell);
            }
            set.TryCommitRow();
        }
        ResultsViewResult View(object filter) => (ResultsViewResult)service.DispatchAsync("results.view", JsonSerializer.SerializeToElement(new { resultId = set.ResultId, sort = Array.Empty<object>(), filters = new[] { filter } }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        foreach (var row in Rows) Add(row);
        set.Seal();
        foreach (var row in Rows) Add(row);
        // The selection reaches past the rows sealed: only those are there to keep.
        var streaming = View(new { op = "keepRows", cells = new { ranges = new[] { new long[] { 2, 100 } } } });
        var resolved = streaming.Filters![0].Rows!;
        check(streaming is { Rows: 5, BaseRows: 7, Complete: false } && resolved.SequenceEqual([2, 3, 4, 5, 6]) && streaming.Filters[0] is { Op: "keepRows", Column: null, Nulls: null },
            "keepRows on a streaming set resolves to the sealed rows the selection covers");
        check(Throws(() => View(new { op = "keepRows", rows = new[] { Rows.Length } })) == "INVALID_PARAMS", "a row not yet sealed cannot be named");
        set.Complete();
        var whole = View(new { op = "keepRows", rows = resolved });
        check(whole is { Rows: 5, BaseRows: 14, Complete: true } && whole.Filters![0].Rows!.SequenceEqual(resolved),
            "re-sent once the set completes, keepRows keeps the rows it resolved and none that arrived later");
    }

    private static string? Throws(Action action)
    {
        try { action(); return null; }
        catch (RequestException error) { return error.Code; }
    }

    private static void HostRequests(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var host = new HostHarness(dispatcher: () => new SqlService(store, hooks: true));
        host.Hello();
        host.Request(1, SqlService.SynthesizeMethod, new { shape = "W1", rows = 1000 });
        var id = JsonBridge.ParseControl(host.Next(FrameKind.Response, 15_000)!.Value.Body).GetProperty("result").GetProperty("resultId").GetUInt32();
        JsonElement Ask(uint request, object args)
        {
            host.Request(request, "results.view", args);
            return JsonBridge.ParseControl(host.Next(FrameKind.Response, 15_000)!.Value.Body);
        }
        string? Code(JsonElement answer) => answer.TryGetProperty("error", out var error) ? error.GetProperty("code").GetString() : null;
        var sorted = Ask(2, new { resultId = id, sort = new[] { new { column = 0, descending = true, mode = "value" } } }).GetProperty("result");
        var sortedId = sorted.GetProperty("viewId").GetUInt32();
        check(!sorted.TryGetProperty("filters", out _), "a view without filters answers no filters");
        // Positions 0 to 9 of the descending view are ids 999 down to 990: Between keeps those ten rows.
        var filtered = Ask(3, new { resultId = id, sort = Array.Empty<object>(), filters = new object[] { new { op = "between", column = 0, cells = new { viewId = sortedId, ranges = new[] { new long[] { 0, 10 } } } } } }).GetProperty("result");
        var echoed = filtered.GetProperty("filters")[0];
        var before = store.UsedBytes;
        Ask(30, new { resultId = id, sort = Array.Empty<object>(), filters = new object[] { new { op = "in", column = 0, rows = new[] { 7 } } } });
        check(store.UsedBytes - before == 4 + ResultStore.ViewOverhead, "a filtered view keeps only its rows' order in the budget, and returns what filtering needed");
        check(filtered.GetProperty("rows").GetInt64() == 10 && filtered.GetProperty("complete").GetBoolean() && echoed.GetProperty("op").GetString() == "between"
            && echoed.GetProperty("column").GetInt32() == 0 && echoed.GetProperty("rows").EnumerateArray().Select(row => row.GetInt32()).SequenceEqual([990, 999]) && !echoed.TryGetProperty("cells", out _),
            "results.view filters a result with no sort keys, by cells of another view, and answers the filter resolved to base rows");
        var dups = Ask(4, new { resultId = id, sort = Array.Empty<object>(), filters = new object[] { new { op = "duplicates", columns = new[] { 0 } } } });
        check(dups.GetProperty("result").GetProperty("rows").GetInt64() == 0, "duplicates in a unique column keep no rows");
        check(Code(Ask(5, new { resultId = id, sort = Array.Empty<object>() })) == "INVALID_PARAMS", "a view with neither sort keys nor filters is refused");
        check(Code(Ask(6, new { resultId = id, sort = Array.Empty<object>(), filters = new object[] { new { op = "duplicates", columns = new[] { 0, 0 } } } })) == "INVALID_PARAMS",
            "a duplicates filter naming a column twice is refused");
        check(Code(Ask(7, new { resultId = id, sort = Array.Empty<object>(), filters = new object[] { new { op = "in", column = 0, rows = new[] { 1 }, cells = new { ranges = new[] { new long[] { 0, 1 } } } } } })) == "INVALID_PARAMS",
            "a filter naming both rows and cells is refused");
        check(Code(Ask(8, new { resultId = id, sort = Array.Empty<object>(), filters = new object[] { new { op = "in", column = 0, cells = new { ranges = new[] { new long[] { 0 } } } } } })) == "INVALID_PARAMS",
            "a cell range that is not [first, count] is refused");
        check(Code(Ask(9, new { resultId = id, sort = Array.Empty<object>(), filters = new object[] { new { op = "like", column = 0, rows = new[] { 1 } } } })) == "INVALID_PARAMS",
            "an unknown filter op is refused");
        check(Code(Ask(10, new { resultId = id, sort = Array.Empty<object>(), filters = Enumerable.Range(0, ViewSorter.MaxFilters + 1).Select(_ => (object)new { op = "in", column = 0, rows = new[] { 1 } }).ToArray() })) == "INVALID_PARAMS",
            "more than 16 filters are refused");
        check(Code(Ask(11, new { resultId = id, sort = Array.Empty<object>(), filters = new object[] { new { op = "in", column = 0, cells = new { viewId = 999_999u, ranges = new[] { new long[] { 0, 1 } } } } } })) == "VIEW_NOT_FOUND",
            "cells of a closed view answer VIEW_NOT_FOUND");
        // Room for one key of the sort and filter on column 0, not two: a Value key on the filtered column fits, a Chars key does not.
        var set = store.Find(id)!;
        var once = ViewSorter.WorkingBytes(1000, 1) + ViewSorter.FilterBytes * 1000 + 4 * 1000 + ResultStore.ViewOverhead;
        var filler = Math.Min(store.QueryBytes, set.Budget.MaxBytes) - set.Budget.UsedBytes - once;
        check(store.TryReserve(set.Budget, filler, false, out _), "the budget check reserves all but one shared key's room");
        object Shared(string mode) => new { resultId = id, sort = new[] { new { column = 0, descending = true, mode } }, filters = new object[] { new { op = "in", column = 0, rows = new[] { 7, 8 } } } };
        check(Code(Ask(40, Shared("chars"))) == "TOO_LARGE", "a sort key in another mode on a filtered column needs a key of its own");
        var shared = Ask(41, Shared("value"));
        check(Code(shared) is null && shared.GetProperty("result").GetProperty("rows").GetInt64() == 2, "the budget counts a Value sort key on a filtered column once");
        store.Return(set.Budget, filler);
        check(Code(Ask(12, new { resultId = id, sort = Array.Empty<object>(), filters = new object[] { new { op = "in", column = 0, rows = new[] { 1 }, extra = true } } })) is not null,
            "a filter with an unknown member is refused");
        // Keep Selected Rows: positions 2 to 4 of the descending view are ids 997, 996 and 995.
        object[] KeepOf(object filter) => [filter];
        var keep = Ask(50, new { resultId = id, sort = new[] { new { column = 0, descending = false, mode = "value" } }, filters = KeepOf(new { op = "keepRows", cells = new { viewId = sortedId, ranges = new[] { new long[] { 2, 3 } } } }) }).GetProperty("result");
        var keepEcho = keep.GetProperty("filters")[0];
        check(keep.GetProperty("rows").GetInt64() == 3 && keepEcho.GetProperty("op").GetString() == "keepRows" && keepEcho.GetProperty("rows").EnumerateArray().Select(row => row.GetInt32()).SequenceEqual([995, 996, 997])
            && !keepEcho.TryGetProperty("column", out _) && !keepEcho.TryGetProperty("nulls", out _) && !keepEcho.TryGetProperty("cells", out _),
            "results.view keeps the rows a selection of another view covers and answers them as base rows, with no column");
        var kept = Ask(51, new { resultId = id, sort = Array.Empty<object>(), filters = new object[] { new { op = "between", column = 0, rows = new[] { 996, 999 } }, new { op = "keepRows", rows = new[] { 997, 995, 996 } } } }).GetProperty("result");
        check(kept.GetProperty("rows").GetInt64() == 2 && kept.GetProperty("filters")[1].GetProperty("rows").GetArrayLength() == 3, "a resolved keepRows applies with the other filters, and still names its rows");
        string? KeepCode(uint request, object filter) => Code(Ask(request, new { resultId = id, sort = Array.Empty<object>(), filters = KeepOf(filter) }));
        check(KeepCode(52, new { op = "keepRows", column = 0, rows = new[] { 1 } }) == "INVALID_PARAMS" && KeepCode(53, new { op = "keepRows", rows = new[] { 1 }, nulls = false }) == "INVALID_PARAMS"
            && KeepCode(54, new { op = "keepRows", rows = new[] { 1 }, columns = new[] { 0 } }) == "INVALID_PARAMS" && KeepCode(55, new { op = "keepRows", rows = new[] { 1 }, snapshotId = 1 }) == "INVALID_PARAMS",
            "a keepRows filter naming a column, NULL, columns or a value list is refused");
        check(KeepCode(56, new { op = "keepRows" }) == "INVALID_PARAMS" && KeepCode(57, new { op = "keepRows", rows = new[] { 1 }, cells = new { ranges = new[] { new long[] { 0, 1 } } } }) == "INVALID_PARAMS",
            "a keepRows filter needs rows or cells, not both");
        check(KeepCode(58, new { op = "keepRows", rows = Array.Empty<int>() }) == "INVALID_PARAMS" && KeepCode(59, new { op = "keepRows", rows = Enumerable.Range(0, ViewSorter.MaxKeepRows + 1).ToArray() }) == "INVALID_PARAMS",
            "a keepRows filter names 1 to 4,095 rows");
        check(KeepCode(60, new { op = "keepRows", cells = new { ranges = Enumerable.Repeat(new long[] { 0, 1 }, ViewSorter.MaxFilterRanges + 1).ToArray() } }) == "INVALID_PARAMS",
            "a keepRows selection of more than 256 ranges is refused");
        var all = Ask(61, new { resultId = id, sort = Array.Empty<object>(), filters = KeepOf(new { op = "keepRows", cells = new { ranges = new[] { new long[] { 0, 5000 } } } }) });
        check(Code(all) is null && all.GetProperty("result").GetProperty("rows").GetInt64() == 1000, "a keepRows selection is clipped to the rows there are before its rows are counted");
        check(KeepCode(62, new { op = "keepRows", cells = new { viewId = 999_999u, ranges = new[] { new long[] { 0, 1 } } } }) == "VIEW_NOT_FOUND", "a keepRows selection of a closed view answers VIEW_NOT_FOUND");
        check(KeepCode(63, new { op = "keepRows", rows = new[] { 1000 } }) == "INVALID_PARAMS", "a keepRows row beyond the result is refused through the host");
    }
}
