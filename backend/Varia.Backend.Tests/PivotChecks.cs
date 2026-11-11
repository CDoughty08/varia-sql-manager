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
                else if (cell == Unreadable) builder.AppendNull(error: true);
                else if (wires[c] == WireKind.Binary) builder.AppendBinary(Encoding.UTF8.GetBytes(cell));
                else builder.AppendText(cell);
            }
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    /// <summary>A source cell stored as one that could not be read (NULL with the error flag).</summary>
    private const string Unreadable = "\u0000ERR";

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
        check(Names(pivot) == "Region,NULL,2024,2025,Total" && model.ColumnGroups == 3,
            "column groups name their columns by value, NULL first, then Total: " + Names(pivot));
        check(string.Join(";", Text(pivot)) == "NULL|0|0|1|1;East|0|2|1|3;West|1|1|0|2", "each cell counts its rows and the total counts the row group's: " + string.Join(";", Text(pivot)));
        List<string> clashing = ["NULL", "NULL", "Total", "x", "x", "X", "(blank)", "Total"];
        PivotOutput.Distinguish(clashing, total: true);
        check(string.Join(",", clashing) == "NULL,NULL (2),Total (2),x,x (2),X (3),(blank),Total",
            "column groups get distinct names: the NULL group and Total keep theirs, and a text 'NULL' or 'Total' or values sharing a prefix are numbered: " + string.Join(",", clashing));
        List<ResultColumn> named = [new("Total", "int", "text"), new("total", "int", "text"), new("x", "bigint", "text"), new("Total", "bigint", "text"), new("Count of rows", "bigint", "text"), new("Count of rows", "bigint", "text")];
        PivotOutput.Unique(named, rows: 2, values: 2);
        check(string.Join(",", named.Select(column => column.Name)) == "Total,total (2),x,Total (3),Count of rows,Count of rows (2)",
            "every column's name is distinct: the row columns keep the source's, then the totals, then the column groups' are numbered: " + string.Join(",", named.Select(column => column.Name)));
        var (_, clash) = Pivot(store, Source(store, [["a", "Total"], ["b", "x"]], [new("Total", "nvarchar(5)", "text", Collation: CaseInsensitive), new("g", "nvarchar(5)", "text", Collation: CaseInsensitive)]), new PivotSpec([0], 1, [Rows()]));
        check(Names(clash) == "Total,Total (2),x,Total (3)",
            "a row column named like a column group or Total keeps its name, and the others are numbered: " + Names(clash));
        var (_, unreadable) = Pivot(store, Source(store, [[Unreadable, "1"], ["a", "2"]], [new("k", "nvarchar(5)", "text", Collation: CaseInsensitive), new("v", "int", "text")]), new PivotSpec([0], -1, [new(PivotAggregate.Max, 1)]));
        check(string.Join(";", Text(unreadable)) == "NULL|1;a|2", "a row group of cells that could not be read shows as the NULL group, not as an error: " + string.Join(";", Text(unreadable)));
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

    /// <summary>Exact numerics group as numbers (1.5 and 1.50 together, -0 with 0), integer sums are bigint, other exact sums
    /// keep all of decimal(38, s)'s digits, and a sum past them is a cell that could not be read rather than a wrong figure.</summary>
    private static void Numbers(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        ResultColumn[] columns = [new("d", "decimal(38,2)", "text", Precision: 38, Scale: 2), new("n", "int", "text")];
        var set = Source(store, [["1.50", "2147483647"], ["1.5", "2147483647"], ["-0.00", "1"], ["0", "1"], ["50000000000000000000000000000.00", "1"], ["50000000000000000000000000000.00", "1"]], columns);
        var (model, pivot) = Pivot(store, set, new PivotSpec([0], -1, [new(PivotAggregate.Sum, 1), new(PivotAggregate.Sum, 0)]));
        var rows = Text(pivot);
        check(model.RowGroups == 3 && rows[0] == "-0.00|2|0.00" && rows[1] == "1.50|4294967294|3.00" && rows[2] == "50000000000000000000000000000.00|2|100000000000000000000000000000.00"
            && pivot.Columns[1].DataType == "bigint" && pivot.Columns[2].DataType == "decimal(38,2)",
            "exact numerics group by value, integer sums widen to bigint, and decimal sums keep 38 digits, past System.Decimal's 28: " + string.Join(";", rows));
        var nines = new string('9', 36) + ".99";
        var (_, edge) = Pivot(store, Source(store, [["1", nines], ["1", "0.01"], ["2", nines], ["2", "-" + nines], ["3", nines]], [new("g", "int", "text"), columns[0]]),
            new PivotSpec([0], -1, [new(PivotAggregate.Sum, 1), new(PivotAggregate.Avg, 1)]));
        check(string.Join(";", Text(edge)) == $"1|ERR|ERR;2|0.00|0.000000;3|{nines}|ERR",
            "a sum reaching decimal(38)'s 10^38 is an error cell, and so is an average whose decimals would pass 38 digits: " + string.Join(";", Text(edge)));
        var (_, whole) = Pivot(store, Source(store, [["1", "12345678901234567890"], ["1", "1"]], [new("g", "int", "text"), new("d", "decimal(20,0)", "text", Precision: 20, Scale: 0)]),
            new PivotSpec([0], -1, [new(PivotAggregate.Sum, 1)]));
        check(whole.Columns[1].DataType == "decimal(38,0)" && Text(whole)[0] == "1|12345678901234567891",
            "a decimal(p,0) sum is decimal(38,0), not bigint, so it is not held to bigint's range: " + whole.Columns[1].DataType + " " + Text(whole)[0]);
        static string Scaled(Int128 value, int scale) { var buffer = new byte[64]; return Encoding.ASCII.GetString(buffer, 0, PivotOutput.WriteScaled(buffer, value, scale)); }
        check(ResultPivoter.TryScaled("-12.5"u8, 2, out var parsed) && parsed == -1250 && ResultPivoter.TryScaled("7"u8, 4, out var seven) && seven == 70000
            && !ResultPivoter.TryScaled("1.234"u8, 2, out _) && !ResultPivoter.TryScaled("1e5"u8, 2, out _) && !ResultPivoter.TryScaled("-"u8, 0, out _) && !ResultPivoter.TryScaled(""u8, 0, out _)
            && !ResultPivoter.TryScaled(System.Text.Encoding.ASCII.GetBytes("1" + new string('0', 38)), 0, out _)
            // 38 digits with fewer decimals than the scale: padding them would pass Int128's range, so they are refused, not wrapped.
            && !ResultPivoter.TryScaled(System.Text.Encoding.ASCII.GetBytes("17" + new string('0', 36)), 1, out _) && !ResultPivoter.TryScaled(System.Text.Encoding.ASCII.GetBytes("1" + new string('0', 37)), 1, out _)
            && ResultPivoter.TryScaled(System.Text.Encoding.ASCII.GetBytes(new string('9', 37)), 1, out var padded) && padded == Int128.Parse(new string('9', 37) + "0", CultureInfo.InvariantCulture),
            "exact text parses to whole units of its scale, and anything else, more decimals or 10^38 is refused");
        check(Scaled(250, 2) == "2.50" && Scaled(-5, 2) == "-0.05" && Scaled(42, 0) == "42" && PivotOutput.Average(5, 2, 0, 6) == 2_500_000 && PivotOutput.Average(-25555, 10, 4, 6) == -255_550
            && PivotOutput.Average(2, 3, 0, 6) == 666_667 && PivotOutput.Average(-2, 3, 0, 6) == -666_667,
            "a figure is shown at its type's scale, and an average rounds half away from zero");
        ResultColumn[] big = [new("g", "int", "text"), new("b", "bigint", "text")];
        var (_, wide) = Pivot(store, Source(store, [["1", "9000000000000000000"], ["1", "9000000000000000000"], ["2", "-9223372036854775808"]], big), new PivotSpec([0], -1, [new(PivotAggregate.Sum, 1)]));
        check(string.Join(";", Text(wide)) == "1|ERR;2|-9223372036854775808" && wide.Columns[1].DataType == "bigint",
            "an integer sum past bigint's range is an error cell, as SQL Server's SUM overflows: " + string.Join(";", Text(wide)));
        check(ResultPivoter.IsNumeric(Sales[2], WireKind.Text) && ResultPivoter.IsNumeric(Sales[3], WireKind.Text) && !ResultPivoter.IsNumeric(Sales[0], WireKind.Text)
            && !ResultPivoter.IsNumeric(Sales[5], WireKind.Text) && !ResultPivoter.IsNumeric(new ResultColumn("b", "varbinary(4)", "binary"), WireKind.Binary),
            "only exact and approximate numerics (not bit, text or binary) can be summed or averaged");
    }

    /// <summary>A pivot past its column groups (256, fewer when its values would pass a page's 4,096 columns), its row groups
    /// (100,000) or its figures (4,000,000) is refused once its groups are known, before any figure is reserved, with a message
    /// that says which bound and how many; one at the bounds is built whole.</summary>
    private static void Limits(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        ResultColumn[] columns = [new("g", "int", "text"), new("c", "int", "text")];
        ResultSetBuffer Rows(int count, int groups) => Source(store, [.. Enumerable.Range(0, count).Select(i => new string?[] { i.ToString(CultureInfo.InvariantCulture), (i % groups).ToString(CultureInfo.InvariantCulture) })], columns);
        (string? Code, string? Message, long Asked) Refusal(ResultSetBuffer set, PivotSpec spec)
        {
            long asked = -1;
            try { ResultPivoter.Build(set, set.SealedSnapshot(), null, spec, CancellationToken.None, bytes => { asked = bytes; return true; }); return (null, null, asked); }
            catch (RequestException error) { return (error.Code, error.Message, asked); }
        }
        var sixteen = Enumerable.Repeat(PivotChecks.Rows(), ResultPivoter.MaxValues).ToArray();

        var wide = Refusal(Rows(1000, 300), new PivotSpec([0], 1, [PivotChecks.Rows()]));
        check(wide is { Code: "INVALID_PARAMS", Asked: -1 } && wide.Message == "The column group has 300 distinct values, and a pivot can have at most 256 column groups. Choose a column with fewer values, or move it to Rows.",
            "past 256 column groups the pivot is refused before any figure is reserved: " + wide.Message);
        var (full, fullPivot) = Pivot(store, Rows(1000, 256), new PivotSpec([0], 1, [PivotChecks.Rows()]));
        check(full is { RowGroups: 1000, ColumnGroups: 256 } && fullPivot.Columns.Count == 1 + 256 + 1 && Text(fullPivot).Count == 1000 && Text(fullPivot)[999].EndsWith("|1", StringComparison.Ordinal),
            "256 column groups are built whole, each row group with its total");
        var paged = Refusal(Rows(980, 256), new PivotSpec([0], 1, sixteen));
        check(ResultPivoter.ColumnGroupLimit(new PivotSpec([0], 1, sixteen)) == 254 && paged.Message == "The column group has 256 distinct values, and a pivot can have at most 254 column groups with 16 values. Choose a column with fewer values, or move it to Rows.",
            "16 values lower the column groups to what a page's 4,096 columns hold: " + paged.Message);
        var (widest, widestPivot) = Pivot(store, Rows(980, 254), new PivotSpec([0], 1, sixteen));
        check(widest is { RowGroups: 980, ColumnGroups: 254 } && widestPivot.Columns.Count == 1 + 255 * 16 && widestPivot.Columns.Count <= PageBuilder.MaxColumns && Text(widestPivot).Count == 980,
            $"16 values of 254 column groups fill a page's columns and stay within {ResultPivoter.MaxCells:N0} figures");
        var cells = Refusal(Rows(1000, 254), new PivotSpec([0], 1, sixteen));
        check(cells is { Code: "INVALID_PARAMS", Asked: -1 } && cells.Message == "This pivot would have 4,080,000 figures, and a pivot can have at most 4,000,000. Use fewer values, row groups or column groups.",
            "past 4,000,000 figures the pivot is refused: " + cells.Message);
        var tall = Refusal(Rows(ResultPivoter.MaxRowGroups + 1, 2), new PivotSpec([0], -1, [PivotChecks.Rows()]));
        check(tall is { Code: "INVALID_PARAMS", Asked: -1 } && tall.Message == "The row groups make 100,001 rows, and a pivot can have at most 100,000. Group by fewer columns, or filter the rows first.",
            "past 100,000 row groups the pivot is refused: " + tall.Message);
        var source = Rows(980, 254);
        long asked = -1;
        string? refused = null;
        try { ResultPivoter.Build(source, source.SealedSnapshot(), null, new PivotSpec([0], 1, sixteen), CancellationToken.None, bytes => { asked = bytes; return false; }); }
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
        // Nearly full, not stopped: a stopped query answers BUDGET_STOPPED instead (Pressure).
        for (var row = 0; row < 100_000 && tight.UsedBytes < 56 * 1024; row++)
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
        check(refused == "TOO_LARGE" && budget.Stopped == TruncationReason.None && tight.UsedBytes == used, "a pivot the budget has no room for answers TOO_LARGE and takes nothing: " + refused + " " + budget.Stopped);
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
        check(SqlService.MethodNames.Contains("results.pivot") && pivot.Descriptor is { Kind: "pivot", State: "complete", RowsStored: 3 } && pivot is { Rows: 6, RowGroups: 3, ColumnGroups: 3, Approximate: false }
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
        // Only a query's rows or another pivot: a diff is refused.
        var diff = store.Open(set.Budget, 1, 1, 1, "diff", Sales, [.. Sales.Select(_ => WireKind.Text)])!;
        diff.Complete();
        check(Code(new { resultId = diff.ResultId, rows = new[] { 0 }, values = new object[] { new { aggregate = "count" } } }) == "INVALID_PARAMS", "a diff cannot be pivoted");
        Partial(check);
        Pressure(check);
    }

    /// <summary>Low system memory while a pivot is written fails only that pivot, and one whose last page is sealed under it
    /// is whole. A query that stopped storing answers BUDGET_STOPPED with the sentence for why it stopped.</summary>
    private static void Pressure(Action<bool, string> check)
    {
        var low = false;
        // The probe runs at every page seal: what happens to the query while a pivot's first page is sealed.
        Action? sealing = null;
        var store = new ResultStore(1L << 30, 1L << 29, () =>
        {
            var action = sealing;
            sealing = null;
            action?.Invoke();
            return (low ? 100 : 0, 50);
        });
        using var service = new SqlService(store);
        T Call<T>(object args) => (T)service.DispatchAsync("results.pivot", JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        string? Message(object args)
        {
            try { Call<object>(args); return null; }
            catch (RequestException error) { return error.Code + ": " + error.Message; }
        }
        static object Grouped(ResultSetBuffer of) => new { resultId = of.ResultId, rows = new[] { 0 }, values = new object[] { new { aggregate = "count" } } };
        static object Total(ResultSetBuffer of) => new { resultId = of.ResultId, rows = Array.Empty<int>(), values = new object[] { new { aggregate = "count" } } };
        // 200 groups: the pivot's first page seals after 64 rows, with 136 still to store.
        var set = Source(store, [.. Enumerable.Range(0, 200).Select(i => new string?[] { i.ToString(CultureInfo.InvariantCulture) })], [new("g", "int", "text")]);
        var used = store.UsedBytes;
        low = true;
        var pressed = Message(Grouped(set));
        check(pressed == "TOO_LARGE: There is not enough result memory to pivot these rows. Close other results and try again." && set.Budget.Stopped == TruncationReason.None && store.UsedBytes == used,
            $"a pivot cut short by low system memory is refused whole and leaves its query's budget open: {pressed} {set.Budget.Stopped} {store.UsedBytes - used}");
        var whole = Call<ResultsPivotResult>(Total(set));
        check(whole.Descriptor is { RowsStored: 1, Truncated: null, State: "complete" } && set.Budget.Stopped == TruncationReason.None,
            $"a pivot whose last page is sealed under low system memory is kept whole and not marked truncated: {whole.Descriptor.RowsStored} {whole.Descriptor.Truncated} {set.Budget.Stopped}");
        low = false;
        var again = Call<ResultsPivotResult>(Grouped(set));
        check(again is { RowGroups: 200 } && again.Descriptor is { RowsStored: 200, Truncated: null }, "the same pivot is stored once memory is free again: " + again.Descriptor.RowsStored);
        // A query's own set stops its query at any seal under low memory, its last one too, though every row was stored.
        low = true;
        var stopped = Source(store);
        low = false;
        var lowMemory = Message(Grouped(stopped));
        check(stopped.Budget.Stopped == TruncationReason.SystemMemory && stopped.Truncated == TruncationReason.None
            && lowMemory == "BUDGET_STOPPED: The computer was low on memory while this query ran, so it can store nothing more. Run the query again.",
            $"a pivot of a query stopped by low system memory at its final seal answers BUDGET_STOPPED and says to run it again: {lowMemory} {stopped.Budget.Stopped}");
        var full = Source(store);
        full.Budget.Stop(TruncationReason.QueryBudget);
        var filled = Message(Grouped(full));
        check(filled == "BUDGET_STOPPED: This query's results filled its result memory, so it can store nothing more. Run the query again returning fewer rows." && filled == "BUDGET_STOPPED: " + SqlService.BudgetStoppedFull,
            "a pivot of a query that filled its result memory answers BUDGET_STOPPED and says to return fewer rows: " + filled);
        // The source is complete, but its query may still be reading later sets, and its tab may run again: one that
        // stops or goes while the pivot is written is the reason the pivot was not kept, not the memory left.
        used = store.UsedBytes;
        sealing = () => set.Budget.Stop(TruncationReason.GlobalBudget);
        var during = Message(Grouped(set));
        check(sealing is null && during == "BUDGET_STOPPED: " + SqlService.BudgetStoppedFull && store.UsedBytes == used,
            $"a pivot whose query stops storing while it is written answers BUDGET_STOPPED and keeps nothing: {during} {store.UsedBytes - used}");
        var closing = Source(store, [.. Enumerable.Range(0, 200).Select(i => new string?[] { i.ToString(CultureInfo.InvariantCulture) })], [new("g", "int", "text")]);
        // As the tab running again does: the source and the pivot being written both go.
        sealing = () => store.ReleaseSession(closing.Budget.SessionId);
        var gone = Message(Grouped(closing));
        check(sealing is null && gone == "RESULT_RELEASED: These results were closed. Execute the query again to see them.",
            "a pivot whose source is released while it is written answers RESULT_RELEASED: " + gone);
        // The same while it groups: stopped, the pivot is not opened; stopped with the budget full, its figures are refused.
        (Tripwire Columns, ResultSetBuffer Set) Wired()
        {
            var columns = new Tripwire([new("g", "int", "text")]) { Within = nameof(ResultPivoter) };
            var wired = store.Open(store.BeginQuery("pivot" + Guid.NewGuid()), 0, 1, 1, "rows", columns, [WireKind.Text])!;
            for (var i = 0; i < 10; i++)
            {
                wired.CountRow();
                wired.BeginRow()!.AppendText(i.ToString(CultureInfo.InvariantCulture));
                wired.TryCommitRow();
            }
            wired.Complete();
            return (columns, wired);
        }
        var grouping = Wired();
        used = store.UsedBytes;
        grouping.Columns.OnRead = () => grouping.Set.Budget.Stop(TruncationReason.SystemMemory);
        var unopened = Message(Grouped(grouping.Set));
        check(grouping.Columns.OnRead is null && unopened == "BUDGET_STOPPED: " + SqlService.BudgetStoppedLowMemory && store.UsedBytes == used,
            $"a pivot whose query stops storing while it groups answers BUDGET_STOPPED and keeps nothing: {unopened} {store.UsedBytes - used}");
        var filling = Wired();
        used = store.UsedBytes;
        long taken = 0;
        filling.Columns.OnRead = () =>
        {
            taken = store.QueryBytes - filling.Set.Budget.UsedBytes;
            store.TryReserve(filling.Set.Budget, taken, false, out _);
            filling.Set.Budget.Stop(TruncationReason.QueryBudget);
        };
        var figures = Message(Grouped(filling.Set));
        store.Return(filling.Set.Budget, taken);
        check(filling.Columns.OnRead is null && taken > 0 && figures == "BUDGET_STOPPED: " + SqlService.BudgetStoppedFull && store.UsedBytes == used,
            $"a pivot refused memory for its figures because its query filled the budget answers BUDGET_STOPPED: {figures} {store.UsedBytes - used}");
    }

    /// <summary>A pivot whose rows run out of the query's budget part-way is refused and released, never kept in part.</summary>
    private static void Partial(Action<bool, string> check)
    {
        ResultColumn[] columns = [new("g", "int", "text"), new("t", "nvarchar(100)", "text")];
        var rows = Enumerable.Range(0, 20_000).Select(i => new string?[] { i.ToString(CultureInfo.InvariantCulture), new string('x', 90) + i.ToString(CultureInfo.InvariantCulture) }).ToArray();
        // The source's bytes, measured in a roomy store; the tight one leaves room for the grouping and about half the pivot.
        var roomy = new ResultStore(1L << 30, 1L << 29);
        Source(roomy, rows, columns);
        var source = roomy.UsedBytes;
        var spec = new PivotSpec([0], -1, [new(PivotAggregate.Max, 1)]);
        var grouping = ResultPivoter.WorkingBytes(rows.Length, ResultPivoter.KeyColumns(spec)) + 4L * rows.Length;
        var store = new ResultStore(1L << 30, source + grouping + source / 2);
        using var service = new SqlService(store);
        var set = Source(store, rows, columns);
        var used = store.UsedBytes;
        string? code = null;
        try { service.DispatchAsync("results.pivot", JsonSerializer.SerializeToElement(new { resultId = set.ResultId, rows = new[] { 0 }, values = new object[] { new { aggregate = "max", column = 1 } } }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); }
        catch (RequestException error) { code = error.Code; }
        check(code == "TOO_LARGE" && store.UsedBytes == used, $"a pivot cut short by the budget is refused and releases what it stored: {code} {store.UsedBytes - used}");
        // The refusal fails only that pivot: the query is not stopped, so a smaller one still fits.
        var small = service.DispatchAsync("results.pivot", JsonSerializer.SerializeToElement(new { resultId = set.ResultId, rows = Array.Empty<int>(), values = new object[] { new { aggregate = "count" } } }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult() as ResultsPivotResult;
        check(set.Budget.Stopped == TruncationReason.None && small is { RowGroups: 1 } && small.Descriptor.RowsStored == 1,
            $"a refused pivot leaves its query able to store a smaller one: {set.Budget.Stopped}");
    }
}
