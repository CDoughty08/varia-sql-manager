using System.Globalization;
using System.Text;
using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Pivots (results.pivot): grouping by collation with NULL as its own group, column groups and totals, each
/// aggregate's figures and types, limits and their truncation, the budget, cancellation, views, and the host method's checks
/// and lifetime.</summary>
internal static class PivotChecks
{
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);
    private static readonly ResultCollation Binary = new(1033, 0, 1252, false, 32768);
    private static readonly ResultColumn[] Sales =
    [
        new("Region", "nvarchar(20)", "text", Collation: CaseInsensitive), new("Year", "int", "text"), new("Amount", "decimal(10,2)", "text", Precision: 10, Scale: 2),
        new("Rate", "float", "text"), new("Note", "nvarchar(20)", "text", Collation: CaseInsensitive), new("Flag", "bit", "text")
    ];
    private static readonly string?[][] SalesRows =
    [
        ["East", "2024", "10.50", "1.5", "a", "1"],
        ["east", "2025", "4.25", "2.5", "b", "0"],
        ["West", "2024", "1.00", null, "A", "1"],
        [null, "2025", "2.00", "0.5", null, "0"],
        ["EAST", "2024", "0.25", "1", "c", "1"],
        ["West", null, null, "3", "b", "0"]
    ];

    public static void Run(Action<bool, string> check)
    {
        Collation(check);
        Columns(check);
        Aggregates(check);
        Numbers(check);
        Limits(check);
        Budget(check);
        Cancellation(check);
        Host(check);
    }

    private static ResultSetBuffer Fill(ResultStore store, QueryBudget budget, string?[][] rows, ResultColumn[] columns, int index = 0)
    {
        var wires = columns.Select(column => column.Wire == "binary" ? WireKind.Binary : WireKind.Text).ToArray();
        var set = store.Open(budget, index, 1, 1, "rows", columns, wires) ?? throw new InvalidOperationException("The result set was not kept.");
        foreach (var row in rows)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            for (var c = 0; c < row.Length; c++)
            {
                if (row[c] is not { } cell) builder.AppendNull();
                else if (wires[c] == WireKind.Binary) builder.AppendBinary(Encoding.UTF8.GetBytes(cell));
                else builder.AppendText(cell);
            }
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    private static ResultSetBuffer Source(ResultStore store, string?[][]? rows = null, ResultColumn[]? columns = null) =>
        Fill(store, store.BeginQuery("pivot" + Guid.NewGuid()), rows ?? SalesRows, columns ?? Sales);

    /// <summary>Pivots in memory as the host does, returning the model and the stored pivot.</summary>
    private static (PivotModel Model, ResultSetBuffer Pivot) Pivot(ResultStore store, ResultSetBuffer set, PivotSpec spec, int[]? order = null, CancellationToken token = default)
    {
        var pages = set.SealedSnapshot();
        var model = ResultPivoter.Build(set, pages, order, spec, token, _ => true);
        var (columns, wires, lengths) = PivotOutput.Shape(set, pages, spec, model);
        var pivot = store.Open(set.Budget, set.Index, 1, 1, "pivot", columns, wires, lengths: lengths) ?? throw new InvalidOperationException("The pivot was not kept.");
        PivotOutput.Write(pivot, set, pages, spec, model, token);
        return (model, pivot);
    }

    /// <summary>Each stored row as its cells joined by "|", NULL as "NULL" (a cell that could not be read as "ERR").</summary>
    private static List<string> Text(ResultSetBuffer set)
    {
        var rows = new List<string>();
        foreach (var page in set.SealedSnapshot())
        {
            var view = PageView.Parse(page.Body, set.Wires.Count);
            for (var r = 0; r < page.Rows; r++)
            {
                var cells = new string[set.Wires.Count];
                for (var c = 0; c < cells.Length; c++) cells[c] = view.IsError(c, r) ? "ERR" : view.IsNull(c, r) ? "NULL" : Encoding.UTF8.GetString(view.Span(c, r));
                rows.Add(string.Join("|", cells));
            }
        }
        return rows;
    }

    private static string Names(ResultSetBuffer set) => string.Join(",", set.Columns.Select(column => column.Name));
    private static PivotValue Rows() => new(PivotAggregate.Count, -1);

    /// <summary>Row groups follow the column's collation (a case-insensitive one puts East, east and EAST together; a binary
    /// one keeps them apart), NULL is a group of its own and sorts first, and a group's name is its first row's value.</summary>
    private static void Collation(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Source(store);
        var (model, pivot) = Pivot(store, set, new PivotSpec([0], -1, [Rows()]));
        check(string.Join(";", Text(pivot)) == "NULL|1;East|3;West|2" && model is { RowGroups: 3, ColumnGroups: 0, Rows: 6 } && Names(pivot) == "Region,Count of rows",
            "a case-insensitive column groups its values by collation, NULL first as its own group, named by each group's first row: " + string.Join(";", Text(pivot)));
        ResultColumn[] binary = [Sales[0] with { Collation = Binary }];
        var exact = Source(store, [["East"], ["east"], ["EAST"], ["East "], [null]], binary);
        var (_, apart) = Pivot(store, exact, new PivotSpec([0], -1, [Rows()]));
        check(string.Join(";", Text(apart)) == "NULL|1;EAST|1;East|2;east|1",
            "a binary collation keeps case apart, and trailing spaces still compare equal, as SQL Server's GROUP BY: " + string.Join(";", Text(apart)));
        var (two, both) = Pivot(store, set, new PivotSpec([0, 4], -1, [Rows()]));
        check(two.RowGroups == 6 && Text(both)[0] == "NULL|NULL|1" && Text(both)[1] == "East|a|1" && Text(both)[2] == "east|b|1",
            "several row columns group by all their values, in order: " + string.Join(";", Text(both)));
    }

    /// <summary>A column group spreads each value across its distinct values, in ascending order with NULL first, then a total
    /// over the row group; with one value the columns take the group's name, with more each says its value.</summary>
    private static void Columns(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Source(store);
        var (model, pivot) = Pivot(store, set, new PivotSpec([0], 1, [Rows()]));
        check(Names(pivot) == "Region,NULL,2024,2025,Total" && model.ColumnGroups == 3 && model.ColumnGroupsShown == 3,
            "column groups name their columns by value, NULL first, then Total: " + Names(pivot));
        check(string.Join(";", Text(pivot)) == "NULL|0|0|1|1;East|0|2|1|3;West|1|1|0|2", "each cell counts its rows and the total counts the row group's: " + string.Join(";", Text(pivot)));
        var (_, two) = Pivot(store, set, new PivotSpec([], 1, [Rows(), new(PivotAggregate.Sum, 2)]));
        check(Names(two) == "NULL · Count of rows,NULL · Sum of Amount,2024 · Count of rows,2024 · Sum of Amount,2025 · Count of rows,2025 · Sum of Amount,Total · Count of rows,Total · Sum of Amount"
            && string.Join(";", Text(two)) == "1|NULL|3|11.75|2|6.25|6|18.00",
            "without row columns the pivot is one row, and several values each name theirs: " + Names(two) + " " + string.Join(";", Text(two)));
        var blanks = Source(store, [["a", ""], ["b", "  "], ["c", "x"]], [new("k", "nvarchar(5)", "text", Collation: CaseInsensitive), new("v", "nvarchar(5)", "text", Collation: CaseInsensitive)]);
        var (_, blank) = Pivot(store, blanks, new PivotSpec([0], 1, [Rows()]));
        check(Names(blank) == "k,(blank),x,Total", "empty and blank values name their column (blank), and equal by trailing-space rules: " + Names(blank));
    }

    /// <summary>Each aggregate: COUNT(column) skips NULLs, COUNT(DISTINCT) counts by collation, SUM and AVG by value with their
    /// types, MIN and MAX by the column's order, copying the source value and type.</summary>
    private static void Aggregates(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Source(store);
        PivotValue[] values =
        [
            new(PivotAggregate.Count, 2), new(PivotAggregate.CountDistinct, 4), new(PivotAggregate.Sum, 2), new(PivotAggregate.Avg, 2),
            new(PivotAggregate.Min, 4), new(PivotAggregate.Max, 2), new(PivotAggregate.Sum, 3), new(PivotAggregate.Avg, 3)
        ];
        var (_, pivot) = Pivot(store, set, new PivotSpec([0], -1, values));
        var rows = Text(pivot);
        check(Names(pivot) == "Region,Count of Amount,Distinct Count of Note,Sum of Amount,Average of Amount,Min of Note,Max of Amount,Sum of Rate,Average of Rate",
            "values are named as a spreadsheet names them: " + Names(pivot));
        check(rows.Count == 3 && rows[0] == "NULL|1|0|2.00|2.000000|NULL|2.00|0.5|0.5" && rows[1] == "East|3|3|15.00|5.000000|a|10.50|5|1.66666666666667"
            && rows[2] == "West|1|2|1.00|1.000000|A|1.00|3|3",
            "counts skip NULLs, distinct counts follow the collation, sums keep the scale, averages keep 6 decimals, float figures show as SSMS shows floats, min and max copy the source value: " + string.Join(";", rows));
        var types = pivot.Columns.Select(column => column.DataType).ToArray();
        check(types is ["nvarchar(20)", "bigint", "bigint", "decimal(38,2)", "decimal(38,6)", "nvarchar(20)", "decimal(10,2)", "float", "float"] && pivot.Columns[5].Collation == CaseInsensitive,
            "figures carry their SQL types and min and max the source column's, collation included: " + string.Join(",", types));
        var (_, empty) = Pivot(store, set, new PivotSpec([0], 1, [new(PivotAggregate.Count, 2), new(PivotAggregate.Sum, 2)]));
        check(Text(empty)[0].StartsWith("NULL|0|NULL|0|NULL|1|2.00", StringComparison.Ordinal),
            "a cell without rows counts 0 and sums NULL, as T-SQL's PIVOT has them: " + Text(empty)[0]);
    }

    /// <summary>Exact numerics group as numbers (1.5 and 1.50 together, -0 with 0), integer sums are bigint, and a sum past
    /// System.Decimal's 28 digits is a cell that could not be read rather than a wrong figure.</summary>
    private static void Numbers(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        ResultColumn[] columns = [new("d", "decimal(38,2)", "text", Precision: 38, Scale: 2), new("n", "int", "text")];
        var set = Source(store, [["1.50", "2147483647"], ["1.5", "2147483647"], ["-0.00", "1"], ["0", "1"], ["50000000000000000000000000000.00", "1"], ["50000000000000000000000000000.00", "1"]], columns);
        var (model, pivot) = Pivot(store, set, new PivotSpec([0], -1, [new(PivotAggregate.Sum, 1), new(PivotAggregate.Sum, 0)]));
        var rows = Text(pivot);
        check(model.RowGroups == 3 && rows[0] == "-0.00|2|0.00" && rows[1] == "1.50|4294967294|3.00" && rows[2] == "50000000000000000000000000000.00|2|ERR"
            && pivot.Columns[1].DataType == "bigint",
            "exact numerics group by value, integer sums widen to bigint, and an overflowing sum is an error cell: " + string.Join(";", rows));
        var avg = ResultPivoter.Build(set, set.SealedSnapshot(), null, new PivotSpec([], -1, [new(PivotAggregate.Avg, 1)]), CancellationToken.None, _ => true);
        check(PivotOutput.Rescale(2.5m, 2).ToString(CultureInfo.InvariantCulture) == "2.50" && PivotOutput.Rescale(2.555m, 2).ToString(CultureInfo.InvariantCulture) == "2.56"
            && avg.Figures[0].Counts[0] == 6, "a figure is shown at its type's scale, rounded half away from zero");
        check(ResultPivoter.IsNumeric(Sales[2], WireKind.Text) && ResultPivoter.IsNumeric(Sales[3], WireKind.Text) && !ResultPivoter.IsNumeric(Sales[0], WireKind.Text)
            && !ResultPivoter.IsNumeric(Sales[5], WireKind.Text) && !ResultPivoter.IsNumeric(new ResultColumn("b", "varbinary(4)", "binary"), WireKind.Binary),
            "only exact and approximate numerics (not bit, text or binary) can be summed or averaged");
    }

    /// <summary>Past the column groups a pivot shows (256, fewer when its values would pass a page's 4,096 columns) and the
    /// figures it keeps (4,000,000), the first groups are shown and the model says how many there were; a truncated column
    /// group still counts in its row's total.</summary>
    private static void Limits(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        ResultColumn[] columns = [new("g", "int", "text"), new("c", "int", "text")];
        var rows = Enumerable.Range(0, 1000).Select(i => new string?[] { i.ToString(CultureInfo.InvariantCulture), (i % 300).ToString(CultureInfo.InvariantCulture) }).ToArray();
        var set = Source(store, rows, columns);
        var (one, pivot) = Pivot(store, set, new PivotSpec([0], 1, [Rows()]));
        check(one is { RowGroups: 1000, RowGroupsShown: 1000, ColumnGroups: 300, ColumnGroupsShown: ResultPivoter.MaxColumnGroups } && pivot.Columns.Count == 1 + 256 + 1
            && Text(pivot)[299].EndsWith("|1", StringComparison.Ordinal) && Text(pivot)[299].Split('|').Skip(1).SkipLast(1).All(cell => cell == "0"),
            "past 256 column groups the first are shown, and a row in a column group not shown still counts in its total");
        var sixteen = Enumerable.Repeat(Rows(), ResultPivoter.MaxValues).ToArray();
        var (wide, widePivot) = Pivot(store, set, new PivotSpec([0], 1, sixteen));
        check(wide is { ColumnGroupsShown: 254, RowGroupsShown: 980, RowGroups: 1000 } && widePivot.Columns.Count == 1 + 255 * 16 && widePivot.Columns.Count <= PageBuilder.MaxColumns
            && Text(widePivot).Count == 980,
            $"16 values keep the columns within a page's and the figures within {ResultPivoter.MaxCells:N0}, truncating row groups: {wide.ColumnGroupsShown} {wide.RowGroupsShown}");
        long asked = -1;
        string? refused = null;
        try { ResultPivoter.Build(set, set.SealedSnapshot(), null, new PivotSpec([0], 1, sixteen), CancellationToken.None, bytes => { asked = bytes; return false; }); }
        catch (PivotTooLargeException) { refused = "TOO_LARGE"; }
        check(refused == "TOO_LARGE" && asked == 980L * 255 * 8 * 16, "the figures are asked of the budget once the groups are known, and a refusal stops the pivot: " + asked);
    }

    /// <summary>The host charges the keys and figures to the result's query budget while it runs and returns them after; a
    /// budget without room answers TOO_LARGE and takes nothing.</summary>
    private static void Budget(Action<bool, string> check)
    {
        check(ResultPivoter.WorkingBytes(10, 2) == ViewSorter.WorkingBytes(10, 2) + 120 && ResultPivoter.KeyColumns(new PivotSpec([0, 1], 1, [new(PivotAggregate.Min, 2), new(PivotAggregate.Sum, 3), new(PivotAggregate.CountDistinct, 0)])) == 3,
            "a pivot reserves a key per grouped, lowest, highest or distinct column and three numbers a row");
        var tight = new ResultStore(64 * 1024, 64 * 1024);
        using var service = new SqlService(tight);
        var budget = tight.BeginQuery("tight");
        var set = tight.Open(budget, 0, 1, 1, "rows", [new("id", "int", "text")], [WireKind.Text])!;
        for (var row = 0; row < 100_000; row++)
        {
            if (set.BeginRow() is not { } builder) break;
            builder.AppendText(row.ToString(CultureInfo.InvariantCulture));
            if (!set.TryCommitRow()) break;
        }
        set.Complete();
        var used = tight.UsedBytes;
        string? refused;
        try { service.DispatchAsync("results.pivot", JsonSerializer.SerializeToElement(new { resultId = set.ResultId, rows = new[] { 0 }, values = new[] { new { aggregate = "count" } } }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); refused = null; }
        catch (RequestException error) { refused = error.Code; }
        check(refused == "TOO_LARGE" && tight.UsedBytes == used, "a pivot the budget has no room for answers TOO_LARGE and takes nothing: " + refused);
    }

    /// <summary>A cancelled pivot stops while it groups and while it writes.</summary>
    private static void Cancellation(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        ResultColumn[] columns = [new("g", "int", "text")];
        var set = Source(store, [.. Enumerable.Range(0, 50_000).Select(i => new string?[] { (i % 7000).ToString(CultureInfo.InvariantCulture) })], columns);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        string? stopped = null;
        try { ResultPivoter.Build(set, set.SealedSnapshot(), null, new PivotSpec([0], -1, [Rows()]), cancelled.Token, _ => true); }
        catch (OperationCanceledException) { stopped = "grouping"; }
        var model = ResultPivoter.Build(set, set.SealedSnapshot(), null, new PivotSpec([0], -1, [Rows()]), CancellationToken.None, _ => true);
        var (shape, wires, lengths) = PivotOutput.Shape(set, set.SealedSnapshot(), new PivotSpec([0], -1, [Rows()]), model);
        var pivot = store.Open(set.Budget, 1, 1, 1, "pivot", shape, wires, lengths: lengths)!;
        try { PivotOutput.Write(pivot, set, set.SealedSnapshot(), new PivotSpec([0], -1, [Rows()]), model, cancelled.Token); }
        catch (OperationCanceledException) { stopped += ",writing"; }
        check(stopped == "grouping,writing" && pivot.IsComplete && pivot.RowsAvailable < 7000, "a cancelled pivot stops grouping and writing, and the part written is completed: " + stopped);
    }

    private static void Host(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var set = Source(store);
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        string? Code(object args)
        {
            try { Call<object>("results.pivot", args); return null; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "INVALID_PARAMS"; }
        }
        var before = store.UsedBytes;
        var pivot = Call<ResultsPivotResult>("results.pivot", new { resultId = set.ResultId, rows = new[] { 0 }, column = 1, values = new object[] { new { aggregate = "sum", column = 2 } } });
        var stored = store.Find(pivot.Descriptor.ResultId);
        check(SqlService.MethodNames.Contains("results.pivot") && pivot.Descriptor is { Kind: "pivot", State: "complete", RowsStored: 3 } && pivot is { Rows: 6, RowGroups: 3, RowGroupsShown: 3, ColumnGroups: 3, ColumnGroupsShown: 3, Approximate: false }
            && stored is not null && ReferenceEquals(stored.Budget, set.Budget) && store.UsedBytes > before && string.Join(";", Text(stored)) == "NULL|NULL|NULL|2.00|2.00;East|NULL|10.75|4.25|15.00;West|NULL|1.00|NULL|1.00",
            "results.pivot stores the pivot as a complete result of the same query: " + (stored is null ? "" : string.Join(";", Text(stored))));
        var filtered = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = Array.Empty<object>(), filters = new object[] { new { op = "in", column = 0, rows = new[] { 2 } } } });
        var viewed = Call<ResultsPivotResult>("results.pivot", new { resultId = set.ResultId, viewId = filtered.ViewId, rows = Array.Empty<int>(), values = new object[] { new { aggregate = "count" } } });
        check(viewed.Rows == 2 && Text(store.Find(viewed.Descriptor.ResultId)!) is ["2"], "a pivot through a view counts only the rows its filters keep");
        var open = store.Open(store.BeginQuery("open"), 0, 1, 1, "rows", Sales, [.. Sales.Select(_ => WireKind.Text)])!;
        var codes = new[]
        {
            Code(new { resultId = set.ResultId, rows = new[] { 0 }, values = new object[] { new { aggregate = "sum", column = 0 } } }),
            Code(new { resultId = set.ResultId, rows = new[] { 0 }, values = new object[] { new { aggregate = "avg", column = 5 } } }),
            Code(new { resultId = set.ResultId, rows = new[] { 0, 0 }, values = new object[] { new { aggregate = "count" } } }),
            Code(new { resultId = set.ResultId, rows = new[] { 0 }, column = 0, values = new object[] { new { aggregate = "count" } } }),
            Code(new { resultId = set.ResultId, rows = new[] { 9 }, values = new object[] { new { aggregate = "count" } } }),
            Code(new { resultId = set.ResultId, rows = new[] { 0 }, values = Array.Empty<object>() }),
            Code(new { resultId = set.ResultId, rows = new[] { 0 }, values = new object[] { new { aggregate = "median", column = 2 } } }),
            Code(new { resultId = set.ResultId, rows = new[] { 0 }, values = new object[] { new { aggregate = "min" } } }),
            Code(new { resultId = set.ResultId, rows = Enumerable.Range(0, 9).ToArray(), values = new object[] { new { aggregate = "count" } } }),
            Code(new { resultId = set.ResultId, rows = new[] { 0 }, values = Enumerable.Repeat<object>(new { aggregate = "count" }, 17).ToArray() }),
            Code(new { resultId = set.ResultId, viewId = 999, rows = new[] { 0 }, values = new object[] { new { aggregate = "count" } } }),
            Code(new { resultId = 999, rows = new[] { 0 }, values = new object[] { new { aggregate = "count" } } }),
            Code(new { resultId = open.ResultId, rows = new[] { 0 }, values = new object[] { new { aggregate = "count" } } })
        };
        check(string.Join(",", codes) == "INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,VIEW_NOT_FOUND,RESULT_NOT_FOUND,RESULT_OPEN",
            "results.pivot checks its request: numeric sums, distinct columns, a column group that is not a row column, columns of the result, 1 to 16 values, known aggregates, the limits, the view and a complete result: " + string.Join(",", codes));
        Call<ResultsCloseResult>("results.close", new { resultIds = new[] { viewed.Descriptor.ResultId } });
        check(store.Find(viewed.Descriptor.ResultId) is null, "results.close releases a pivot");
        store.BeginQuery(set.Budget.SessionId);
        check(store.Find(pivot.Descriptor.ResultId) is null && store.UsedBytes <= before, "a pivot is released with its query's other results, and with it all it charged");
    }
}
