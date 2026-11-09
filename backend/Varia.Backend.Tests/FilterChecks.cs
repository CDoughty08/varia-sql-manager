using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Filtered views (results.view's filters): In, NotIn and Between from selected cells or base rows, equal by the
/// column's collation; NULL among the values; duplicates on one column, several and every column; filters before the sort;
/// resolved filters rebuilding the same view; the distinct value limit; and the request's checks and budget through the host.</summary>
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
        Limits(check);
        HostRequests(check);
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
        check(Code(Ask(12, new { resultId = id, sort = Array.Empty<object>(), filters = new object[] { new { op = "in", column = 0, rows = new[] { 1 }, extra = true } } })) is not null,
            "a filter with an unknown member is refused");
    }
}
