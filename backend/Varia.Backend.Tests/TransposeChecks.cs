using System.Globalization;
using System.Text;
using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Transposes (results.transpose): the shape and its names, a header column (duplicates, NULL, blank, binary), a
/// view's order and filters, selected ranges, the hidden tone column, kept NULL, error and truncation flags, the row limit
/// and its truncation, the budget, cancellation, the kinds refused, and the host method's checks and lifetime.</summary>
internal static class TransposeChecks
{
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);
    private static readonly ResultColumn[] People =
    [
        new("Name", "nvarchar(20)", "text", Collation: CaseInsensitive), new("Age", "int", "text"), new("Photo", "varbinary(8)", "binary")
    ];
    private static readonly string?[][] PeopleRows =
    [
        ["Ann", "31", "AB"],
        ["bob", "45", null],
        ["ann", null, "C"],
        [null, "7", ""],
        ["  ", "60", "D"]
    ];

    public static void Run(Action<bool, string> check)
    {
        Shape(check);
        Headers(check);
        Ranges(check);
        Flags(check);
        Limits(check);
        Budget(check);
        Cancellation(check);
        Host(check);
    }

    /// <summary>A source cell stored as one that could not be read (NULL with the error flag).</summary>
    private const string Unreadable = "\u0000ERR";
    /// <summary>A source cell stored truncated (its text after the marker).</summary>
    private const string Cut = "\u0000CUT";

    private static ResultSetBuffer Fill(ResultStore store, QueryBudget budget, string?[][] rows, ResultColumn[] columns, string kind = "rows")
    {
        var wires = columns.Select(column => column.Wire == "binary" ? WireKind.Binary : WireKind.Text).ToArray();
        var set = store.Open(budget, 0, 1, 1, kind, columns, wires) ?? throw new InvalidOperationException("The result set was not kept.");
        foreach (var row in rows)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            for (var c = 0; c < row.Length; c++)
            {
                if (row[c] is not { } cell) builder.AppendNull();
                else if (cell == Unreadable) builder.AppendNull(error: true);
                else if (cell.StartsWith(Cut, StringComparison.Ordinal)) builder.AppendText(cell.AsSpan(Cut.Length), truncated: true);
                else if (wires[c] == WireKind.Binary) builder.AppendBinary(Encoding.UTF8.GetBytes(cell));
                else builder.AppendText(cell);
            }
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    private static ResultSetBuffer Source(ResultStore store, string?[][]? rows = null, ResultColumn[]? columns = null, string kind = "rows") =>
        Fill(store, store.BeginQuery("transpose" + Guid.NewGuid()), rows ?? PeopleRows, columns ?? People, kind);

    /// <summary>Transposes in memory as the host does.</summary>
    private static (TransposePlan Plan, ResultSetBuffer Output) Transpose(ResultStore store, ResultSetBuffer set, int[]? order = null, (long, long)[]? ranges = null, int header = -1, CancellationToken token = default)
    {
        var pages = set.SealedSnapshot();
        var plan = ResultTransposer.Plan(set, pages, order, ranges, header);
        var (columns, wires, lengths) = ResultTransposer.Shape(set, pages, plan);
        var output = store.Open(set.Budget, set.Index, 1, 1, "transpose", columns, wires, lengths: lengths, derived: true) ?? throw new InvalidOperationException("The transpose was not kept.");
        ResultTransposer.Write(output, set, pages, plan, token);
        return (plan, output);
    }

    /// <summary>Each stored row as its cells joined by "|", NULL as "NULL" (a cell that could not be read as "ERR", a
    /// truncated one followed by "…").</summary>
    private static List<string> Text(ResultSetBuffer set)
    {
        var rows = new List<string>();
        foreach (var page in set.SealedSnapshot())
        {
            var view = PageView.Parse(page.Body, set.Wires.Count);
            for (var r = 0; r < page.Rows; r++)
            {
                var cells = new string[set.Wires.Count];
                for (var c = 0; c < cells.Length; c++)
                    cells[c] = view.IsError(c, r) ? "ERR" : view.IsNull(c, r) ? "NULL" : Encoding.UTF8.GetString(view.Span(c, r)) + (view.IsTruncated(c, r) ? "…" : "");
                rows.Add(string.Join("|", cells));
            }
        }
        return rows;
    }

    private static string Names(ResultSetBuffer set) => string.Join(",", set.Columns.Select(column => column.Name));

    /// <summary>Columns become rows, the first column naming them; rows become columns "Row 1"…; every column is text, and a
    /// binary value shows as 0x hex.</summary>
    private static void Shape(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Source(store);
        var (plan, output) = Transpose(store, set);
        check(Names(output) == "Column,Row 1,Row 2,Row 3,Row 4,Row 5" && plan is { Available: 5, Truncated: false } && output.IsComplete && output.Kind == "transpose",
            "a transpose has a Column column, then a column per source row named by its position: " + Names(output));
        check(string.Join(";", Text(output)) == "Name|Ann|bob|ann|NULL|  ;Age|31|45|NULL|7|60;Photo|0x4142|NULL|0x43|0x|0x44",
            "each source column becomes a row of its cells' display text, binary as 0x hex: " + string.Join(";", Text(output)));
        check(output.Wires.All(wire => wire == WireKind.Text) && output.Columns.Skip(1).All(column => column.DataType == "nvarchar(max)" && column.Nullable)
            && output.Columns[0] is { DataType: "nvarchar(128)", Nullable: false },
            "a transpose's columns are text, since each one mixes the source's types");
        var (_, twice) = Transpose(store, output);
        check(Names(twice) == "Column,Row 1,Row 2,Row 3" && Text(twice)[1] == "Row 1|Ann|31|0x4142" && Text(twice)[0] == "Column|Name|Age|Photo",
            "a transpose can be transposed again: " + string.Join(";", Text(twice)));
        var empty = Source(store, [], People);
        var (_, none) = Transpose(store, empty);
        check(Names(none) == "Column" && string.Join(";", Text(none)) == "Name;Age;Photo", "a result without rows transposes to its column names");
    }

    /// <summary>A header column names the columns by its values, as a pivot names its column groups: NULL, (blank) and 0x
    /// hex, all made distinct ignoring case, and "Column" keeps its name.</summary>
    private static void Headers(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Source(store);
        var (_, named) = Transpose(store, set, header: 0);
        check(Names(named) == "Column,Ann,bob,ann (2),NULL,(blank)", "a header column's values name the columns, numbered when they repeat ignoring case: " + Names(named));
        var (_, binary) = Transpose(store, set, header: 2);
        check(Names(binary) == "Column,0x4142,NULL,0x43,0x,0x44", "binary header values show as hex, as a pivot names its groups: " + Names(binary));
        var clash = Source(store, [["Column"], ["column"], ["NULL"], [null]], [new("Name", "nvarchar(20)", "text", Collation: CaseInsensitive)]);
        var (_, clashing) = Transpose(store, clash, header: 0);
        check(Names(clashing) == "Column,Column (2),column (3),NULL,NULL (2)", "a header value named Column or repeated is numbered: " + Names(clashing));
    }

    /// <summary>A view's order and filters decide the rows and their order; ranges take only those positions, merged.</summary>
    private static void Ranges(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Source(store);
        var (_, ordered) = Transpose(store, set, order: [3, 1, 0]);
        check(Names(ordered) == "Column,Row 1,Row 2,Row 3" && Text(ordered)[0] == "Name|NULL|bob|Ann", "a view's rows transpose in its order: " + string.Join(";", Text(ordered)));
        var (plan, picked) = Transpose(store, set, ranges: [(4, 1), (0, 2), (1, 1), (9, 3)]);
        check(Names(picked) == "Column,Row 1,Row 2,Row 5" && Text(picked)[1] == "Age|31|45|60" && plan.Available == 3,
            "selected ranges take only their rows, merged and in order, named by their positions: " + Names(picked));
        var (_, both) = Transpose(store, set, order: [4, 2, 0], ranges: [(1, 2)]);
        check(Names(both) == "Column,Row 2,Row 3" && Text(both)[0] == "Name|ann|Ann", "ranges name a view's positions: " + string.Join(";", Text(both)));
        ResultColumn[] toned = [new("k", "int", "text"), new("tone", "nvarchar(8)", "text", Role: "tone"), new("v", "int", "text")];
        var hidden = Source(store, [["1", "added", "2"], ["3", "removed", "4"]], toned);
        var (tonePlan, noTone) = Transpose(store, hidden);
        check(string.Join(";", Text(noTone)) == "k|1|3;v|2|4" && tonePlan.Columns.SequenceEqual([0, 2]), "a hidden tone column is never a row: " + string.Join(";", Text(noTone)));
    }

    /// <summary>A cell keeps its NULL, error and truncation flags, so a truncated value stays marked.</summary>
    private static void Flags(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Source(store, [["a", Unreadable], [Cut + "long", null]], [new("x", "nvarchar(max)", "text"), new("y", "int", "text")]);
        var (_, output) = Transpose(store, set);
        check(string.Join(";", Text(output)) == "x|a|long…;y|ERR|NULL" && output.Describe().TruncatedCells == 1,
            "a transposed cell keeps its NULL, error and truncation flags: " + string.Join(";", Text(output)));
    }

    /// <summary>Rows become columns: at most a page's columns less one, the first ones taken and the rest counted.</summary>
    private static void Limits(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Source(store, [.. Enumerable.Range(0, ResultTransposer.MaxRows + 5).Select(i => new string?[] { i.ToString(CultureInfo.InvariantCulture) })], [new("n", "int", "text")]);
        var (plan, output) = Transpose(store, set);
        check(plan is { Available: ResultTransposer.MaxRows + 5, Truncated: true } && plan.Positions.Length == ResultTransposer.MaxRows && output.Columns.Count == PageBuilder.MaxColumns
            && output.Columns[^1].Name == "Row 4095" && Text(output)[0].EndsWith("|4094", StringComparison.Ordinal),
            "a transpose takes the first 4,095 rows, so its columns fit a page, and counts the others");
        check(ResultTransposer.MaxCells / 2000 < ResultTransposer.MaxRows && ResultTransposer.Plan(set, set.SealedSnapshot(), null, [(0, 10)], -1) is { Available: 10, Truncated: false },
            "a wide result takes fewer rows (the cell bound), and a selection within the limit is whole");
    }

    /// <summary>A transpose the budget has no room for is refused whole and takes nothing.</summary>
    private static void Budget(Action<bool, string> check)
    {
        var tight = new ResultStore(96 * 1024, 96 * 1024);
        using var service = new SqlService(tight);
        var budget = tight.BeginQuery("tight");
        var set = tight.Open(budget, 0, 1, 1, "rows", [.. Enumerable.Range(0, 40).Select(i => new ResultColumn("c" + i.ToString(CultureInfo.InvariantCulture), "nvarchar(100)", "text"))], [.. Enumerable.Repeat(WireKind.Text, 40)])!;
        // The source takes most of the budget, so a transpose of it (as large) cannot fit beside it.
        for (var row = 0; row < 10_000 && tight.UsedBytes < 60 * 1024; row++)
        {
            if (set.BeginRow() is not { } builder) break;
            for (var c = 0; c < 40; c++) builder.AppendText("value" + row.ToString(CultureInfo.InvariantCulture));
            if (!set.TryCommitRow()) break;
        }
        set.Complete();
        var used = tight.UsedBytes;
        string? refused;
        try { service.DispatchAsync("results.transpose", JsonSerializer.SerializeToElement(new { resultId = set.ResultId }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); refused = null; }
        catch (RequestException error) { refused = error.Code + ": " + error.Message; }
        check(refused?.StartsWith("TOO_LARGE: There is not enough result memory to transpose", StringComparison.Ordinal) == true && tight.UsedBytes == used,
            "a transpose the budget has no room for answers TOO_LARGE and takes nothing: " + refused);
    }

    /// <summary>A cancelled transpose stops while it writes, and the part written is completed (then released).</summary>
    private static void Cancellation(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Source(store, [.. Enumerable.Range(0, 100).Select(i => new string?[] { "a", "b", "c" })], [new("x", "int", "text"), new("y", "int", "text"), new("z", "int", "text")]);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var pages = set.SealedSnapshot();
        var plan = ResultTransposer.Plan(set, pages, null, null, -1);
        var (columns, wires, lengths) = ResultTransposer.Shape(set, pages, plan);
        var output = store.Open(set.Budget, 1, 1, 1, "transpose", columns, wires, lengths: lengths, derived: true)!;
        string? stopped = null;
        try { ResultTransposer.Write(output, set, pages, plan, cancelled.Token); }
        catch (OperationCanceledException) { stopped = "writing"; }
        check(stopped == "writing" && output.IsComplete && output.RowsAvailable < 3, "a cancelled transpose stops writing, and the part written is completed");
    }

    private static void Host(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var set = Source(store);
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        string? Code(object args)
        {
            try { Call<object>("results.transpose", args); return null; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "INVALID_PARAMS"; }
        }
        var before = store.UsedBytes;
        var whole = Call<ResultsTransposeResult>("results.transpose", new { resultId = set.ResultId, headerColumn = 0 });
        var stored = store.Find(whole.Descriptor.ResultId);
        check(SqlService.MethodNames.Contains("results.transpose") && whole.Descriptor is { Kind: "transpose", State: "complete", RowsStored: 3 } && whole is { Rows: 5, Transposed: 5, Columns: 3 }
            && whole.Descriptor.Columns.Count == 6 && stored is not null && ReferenceEquals(stored.Budget, set.Budget) && store.UsedBytes > before,
            "results.transpose stores the transpose as a complete result of the same query");
        var view = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 1, descending = true, mode = "value" } },
            filters = new object[] { new { op = "notIn", column = 1, rows = Array.Empty<int>(), nulls = true } } });
        var viewed = Call<ResultsTransposeResult>("results.transpose", new { resultId = set.ResultId, viewId = view.ViewId, rows = new[] { new long[] { 0, 2 } } });
        check(viewed is { Rows: 2, Transposed: 2 } && Text(store.Find(viewed.Descriptor.ResultId)!)[1] == "Age|60|45",
            "a transpose through a view takes its sorted, filtered rows, and ranges its positions: " + string.Join(";", Text(store.Find(viewed.Descriptor.ResultId)!)));
        var again = Call<ResultsTransposeResult>("results.transpose", new { resultId = whole.Descriptor.ResultId });
        check(again.Descriptor.Kind == "transpose" && again is { Transposed: 3, Columns: 6 }, "a transpose can be transposed");
        var open = store.Open(store.BeginQuery("open"), 0, 1, 1, "rows", People, [WireKind.Text, WireKind.Text, WireKind.Binary])!;
        var codes = new[]
        {
            Code(new { resultId = set.ResultId, headerColumn = 3 }),
            Code(new { resultId = set.ResultId, headerColumn = -1 }),
            Code(new { resultId = set.ResultId, rows = Array.Empty<long[]>() }),
            Code(new { resultId = set.ResultId, rows = new[] { new long[] { 0, 0 } } }),
            Code(new { resultId = set.ResultId, rows = new[] { new long[] { -1, 1 } } }),
            Code(new { resultId = set.ResultId, rows = new[] { new long[] { 0 } } }),
            Code(new { resultId = set.ResultId, rows = Enumerable.Repeat(new long[] { 0, 1 }, 257).ToArray() }),
            Code(new { resultId = set.ResultId, viewId = 0 }),
            Code(new { resultId = set.ResultId, viewId = 999 }),
            Code(new { resultId = 999 }),
            Code(new { resultId = open.ResultId })
        };
        check(string.Join(",", codes) == "INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,VIEW_NOT_FOUND,RESULT_NOT_FOUND,RESULT_OPEN",
            "results.transpose checks its request: a header column of the result, 1 to 256 well-formed ranges, the view and a complete result: " + string.Join(",", codes));
        foreach (var kind in new[] { "diff", "executionPlan" })
        {
            var refused = store.Open(set.Budget, 1, 1, 1, kind, People, [WireKind.Text, WireKind.Text, WireKind.Binary])!;
            refused.Complete();
            check(Code(new { resultId = refused.ResultId }) == "INVALID_PARAMS", "a " + kind + " cannot be transposed");
        }
        Call<ResultsCloseResult>("results.close", new { resultIds = new[] { viewed.Descriptor.ResultId } });
        check(store.Find(viewed.Descriptor.ResultId) is null, "results.close releases a transpose");
        store.BeginQuery(set.Budget.SessionId);
        check(store.Find(whole.Descriptor.ResultId) is null && store.Find(again.Descriptor.ResultId) is null && store.UsedBytes <= before,
            "a transpose is released with its query's other results, and with it all it charged");
        var limited = Source(store);
        limited.Budget.Stop(TruncationReason.RowLimit);
        string? message;
        try { Call<object>("results.transpose", new { resultId = limited.ResultId }); message = null; }
        catch (RequestException error) { message = error.Code + ": " + error.Message; }
        check(message == "TOO_LARGE: This query stored as many rows as its limit allows, so it cannot store a transpose. Raise the limit or return fewer rows, then run it again.",
            "a transpose of a query stopped at its row limit says so");
    }
}
