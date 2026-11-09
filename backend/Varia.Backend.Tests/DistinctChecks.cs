using System.Globalization;
using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Distinct values (results.distinct, the header funnel's checklist): collation equality, NULL counted apart,
/// counts and the two orders, representative rows an In filter keeps exactly, a search, a view's rows, explicit truncation,
/// long values cut, and the method's limits and budget.</summary>
internal static class DistinctChecks
{
    // Latin1_General_CI_AS and Latin1_General_BIN2.
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);
    private static readonly ResultCollation Bin2 = new(1033, 0, 1252, false, 16384);

    private static readonly ResultColumn[] Columns =
    [
        new("name", "nvarchar", "text", Collation: CaseInsensitive), new("code", "varchar", "text", Collation: Bin2),
        new("amount", "decimal", "text", Precision: 10, Scale: 2), new("blob", "varbinary", "binary")
    ];

    private static readonly object?[][] Rows =
    [
        ["b", "b", "1.50", new byte[] { 2 }],
        ["A", "A", "1.5", new byte[] { 1 }],
        ["a  ", "a  ", null, null],
        [null, null, "0", new byte[] { 1 }],
        ["B", "B", "-0.00", new byte[] { 1 }],
        ["a", "a", "2", null]
    ];

    public static void Run(Action<bool, string> check)
    {
        Values(check);
        Filters(check);
        Truncation(check);
        Requests(check);
    }

    private static ResultSetBuffer Fill(ResultStore store, ResultColumn[] columns, IEnumerable<object?[]> rows)
    {
        var wires = columns.Select(column => column.Wire == "binary" ? WireKind.Binary : WireKind.Text).ToArray();
        var set = store.Open(store.BeginQuery("distinct-" + columns[0].Name), 0, 1, 1, "rows", columns, wires) ?? throw new InvalidOperationException("The result set was not kept.");
        foreach (var row in rows)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            for (var c = 0; c < row.Length; c++)
            {
                if (row[c] is null) builder.AppendNull();
                else if (row[c] is byte[] bytes) builder.AppendBinary(bytes);
                else builder.AppendText((string)row[c]!);
            }
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    private static DistinctOutcome Distinct(ResultSetBuffer set, int column, DistinctOrder order = DistinctOrder.Count, string? search = null, int max = ViewSorter.MaxDistinctValues, ResultView? view = null) =>
        ViewSorter.DistinctValues(set, set.SealedSnapshot(), view, column, order, search, max, CancellationToken.None);

    private static string Describe(DistinctOutcome outcome) =>
        $"rows {outcome.Rows}, nulls {outcome.Nulls}, distinct {outcome.Distinct}: " + string.Join(", ", outcome.Values.Select(value => $"{value.Text}@{value.Row}×{value.Count}"));

    private static void Values(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store, Columns, Rows);
        var name = Distinct(set, 0);
        check(name.Rows == 6 && name.Nulls == 1 && name.Distinct == 2 && name.Values is [{ Row: 1, Text: "A", Count: 3 }, { Row: 0, Text: "b", Count: 2 }],
            "a case-insensitive column counts a, A and 'a  ' as one value, shown by its lowest row, and NULL apart: " + Describe(name));
        var code = Distinct(set, 1, DistinctOrder.Value);
        check(code.Distinct == 4 && code.Values.Select(value => value.Text).SequenceEqual(["A", "B", "a  ", "b"]) && code.Values[2].Count == 2,
            "a _BIN2 column tells case apart, orders by code point and still ignores trailing spaces: " + Describe(code));
        var amount = Distinct(set, 2, DistinctOrder.Value);
        check(amount.Values is [{ Text: "0", Count: 2 }, { Text: "1.50", Count: 2 }, { Text: "2", Count: 1 }] && amount.Nulls == 1,
            "exact numerics are equal by value (1.50 and 1.5, -0.00 and 0), in numeric order: " + Describe(amount));
        var counted = Distinct(set, 2);
        check(counted.Values.Select(value => value.Text).SequenceEqual(["0", "1.50", "2"]), "equal counts keep value order when ordered by count: " + Describe(counted));
        var blob = Distinct(set, 3);
        check(blob.Values is [{ Text: "0x01", Count: 3 }, { Text: "0x02", Count: 1 }] && blob.Nulls == 2, "binary values are compared by bytes and shown as hex: " + Describe(blob));
        var searched = Distinct(set, 0, search: "B");
        check(searched.Distinct == 1 && searched.Values is [{ Text: "b", Count: 2 }] && searched.Nulls == 1,
            "a search keeps the values containing it, by the column's collation (b for B), and still counts NULLs: " + Describe(searched));
        check(Distinct(set, 1, search: "B").Values is [{ Text: "B", Count: 1 }] && Distinct(set, 3, search: "zz").Distinct == 0 && Distinct(set, 3, search: "02").Values is [{ Text: "0x02" }],
            "a _BIN2 search tells case apart, and a binary column matches hex only");
        var view = store.AddView(set, [5, 4, 3], [new ViewKey(0, false, SortMode.Value)], false, true, 0, null);
        var viewed = Distinct(set, 0, view: view);
        check(viewed.Rows == 3 && viewed.Nulls == 1 && viewed.Values is [{ Row: 5, Text: "a", Count: 1 }, { Row: 4, Text: "B", Count: 1 }],
            "through a view only its rows count, each value shown by the lowest of them: " + Describe(viewed));
        var cancelled = false;
        try { ViewSorter.DistinctValues(set, set.SealedSnapshot(), null, 0, DistinctOrder.Count, null, 10, new CancellationToken(true)); }
        catch (OperationCanceledException) { cancelled = true; }
        check(cancelled, "a cancelled distinct-values request stops");
    }

    /// <summary>The checklist's filter: In by the representative rows keeps exactly the rows counted for those values.</summary>
    private static void Filters(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store, Columns, Rows);
        var name = Distinct(set, 0);
        var kept = ViewSorter.Build(set, set.SealedSnapshot(), [], [new ViewFilter(FilterOp.In, 0, [name.Values[0].Row], false, null, [])], CancellationToken.None).Order;
        check(kept.Length == name.Values[0].Count && kept.SequenceEqual([1, 2, 5]), "an In filter by a value's representative row keeps the rows it counted: " + string.Join(",", kept));
        var excluded = ViewSorter.Build(set, set.SealedSnapshot(), [], [new ViewFilter(FilterOp.NotIn, 0, [name.Values[1].Row], true, null, [])], CancellationToken.None).Order;
        check(excluded.SequenceEqual([1, 2, 5]), "NotIn by a representative row with NULL excludes that value and NULL: " + string.Join(",", excluded));
    }

    private static void Truncation(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        const int count = 10_000;
        var set = Fill(store, [new("n", "int", "text")], Enumerable.Range(0, count).Select(i => new object?[] { (i % 5000).ToString(CultureInfo.InvariantCulture) }));
        var some = Distinct(set, 0, DistinctOrder.Value, max: 100);
        check(set.SealedSnapshot().Length > 1 && some.Distinct == 5000 && some.Values.Length == 100 && some.Values[0] is { Text: "0", Row: 0, Count: 2 } && some.Values[99].Text == "99",
            "values past the cap are left out, and Distinct still counts all of them: " + some.Distinct);
        var longText = new string('x', 300) + "\U0001F600";
        var wide = Fill(store, [new("text", "nvarchar(max)", "text", Collation: Bin2), new("bin", "varbinary(max)", "binary")], [[longText, Enumerable.Repeat((byte)0xAB, 200).ToArray()]]);
        var text = Distinct(wide, 0).Values[0].Text;
        var hex = Distinct(wide, 1).Values[0].Text;
        check(text.Length == ViewSorter.DistinctValueChars + 1 && text.EndsWith('…') && hex.StartsWith("0xABAB", StringComparison.Ordinal) && hex.EndsWith('…') && hex.Length <= ViewSorter.DistinctValueChars + 1,
            "a long value's text is cut to 256 characters and marked");
    }

    private static void Requests(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var set = Fill(store, Columns, Rows);
        var baseline = store.UsedBytes;
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        string? Code(object args)
        {
            try { Call<object>("results.distinct", args); return null; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "INVALID_PARAMS"; }
        }
        var result = Call<ResultsDistinctResult>("results.distinct", new { resultId = set.ResultId, column = 0, order = "count", maxValues = 1 });
        check(SqlService.MethodNames.Contains("results.distinct") && service.LaneOf("results.distinct") == RequestLane.Results && result is { Rows: 6, Complete: true, Nulls: 1, Distinct: 2, Truncated: true }
            && result.Values is [{ Text: "A", Count: 3 }] && store.UsedBytes == baseline, "results.distinct answers the values asked, says it truncated, and returns its working memory");
        var view = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = Array.Empty<object>(), filters = new[] { new { op = "in", column = 0, rows = new[] { 0 } } } });
        var viewed = Call<ResultsDistinctResult>("results.distinct", new { resultId = set.ResultId, column = 1, order = "value", maxValues = 10, viewId = view.ViewId, search = "b" });
        check(viewed is { Rows: 2, Distinct: 1, Truncated: false } && viewed.Values is [{ Row: 0, Text: "b", Count: 1 }],
            "results.distinct reads through a filtered view and searches its values");
        var codes = new[]
        {
            Code(new { resultId = set.ResultId, column = 4, order = "count", maxValues = 10 }),
            Code(new { resultId = set.ResultId, column = -1, order = "count", maxValues = 10 }),
            Code(new { resultId = set.ResultId, column = 0, order = "random", maxValues = 10 }),
            Code(new { resultId = set.ResultId, column = 0, order = "count", maxValues = 0 }),
            Code(new { resultId = set.ResultId, column = 0, order = "count", maxValues = ViewSorter.MaxDistinctValues + 1 }),
            Code(new { resultId = set.ResultId, column = 0, order = "count", maxValues = 10, search = "" }),
            Code(new { resultId = set.ResultId, column = 0, order = "count", maxValues = 10, search = new string('x', ResultSearcher.MaxText + 1) }),
            Code(new { resultId = set.ResultId, column = 0, order = "count", maxValues = 10, extra = 1 }),
            Code(new { resultId = set.ResultId, column = 0, order = "count", maxValues = 10, viewId = 0 }),
            Code(new { resultId = set.ResultId, column = 0, order = "count", maxValues = 10, viewId = 12345 }),
            Code(new { resultId = 999, column = 0, order = "count", maxValues = 10 })
        };
        check(string.Join(",", codes) == "INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,VIEW_NOT_FOUND,RESULT_NOT_FOUND",
            "results.distinct takes a column of the result, count or value, 1 to 4,096 values and 1 to 1,024 search characters: " + string.Join(",", codes));
        var tight = new ResultStore(4096, 4096);
        using var small = new SqlService(tight);
        var cramped = Fill(tight, [new("id", "int", "text")], [["1"]]);
        var before = tight.UsedBytes;
        string? refused;
        try { small.DispatchAsync("results.distinct", JsonSerializer.SerializeToElement(new { resultId = cramped.ResultId, column = 0, order = "count", maxValues = 10 }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); refused = null; }
        catch (RequestException error) { refused = error.Code; }
        check(refused == "TOO_LARGE" && tight.UsedBytes == before, "distinct values the budget has no room for answer TOO_LARGE and take nothing");
    }
}
