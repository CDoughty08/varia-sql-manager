using System.Text;
using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Result diffs (results.diff): rows aligned by a key both results share or by whole rows, the unified order,
/// collation-aware equality with soft differences, the unified result's rows and tones, context, and the host method's
/// checks, budget and lifetime.</summary>
internal static class DiffChecks
{
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);
    private static readonly ResultColumn[] Columns =
    [
        new("ItemId", "int", "text"), new("Name", "nvarchar", "text", Collation: CaseInsensitive), new("Price", "decimal", "text", Precision: 10, Scale: 2)
    ];
    private static readonly WireKind[] Wires = [WireKind.Text, WireKind.Text, WireKind.Text];

    public static void Run(Action<bool, string> check)
    {
        Keyed(check);
        WholeRows(check);
        Context(check);
        CellMemory(check);
        WireMismatch(check);
        Rules(check);
        Tones(check);
        Halves(check);
        Sizes(check);
        Host(check);
        Refusals(check);
    }

    private static ResultSetBuffer Fill(ResultStore store, QueryBudget budget, int index, string?[][] rows, ResultColumn[]? columns = null)
    {
        columns ??= Columns;
        var wires = columns.Select(column => column.Wire == "binary" ? WireKind.Binary : WireKind.Text).ToArray();
        var set = store.Open(budget, index, 1, 1, "rows", columns, wires) ?? throw new InvalidOperationException("The result set was not kept.");
        foreach (var row in rows)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            for (var c = 0; c < row.Length; c++)
            {
                var cell = row[c];
                if (cell is null) builder.AppendNull();
                else if (wires[c] == WireKind.Binary) builder.AppendBinary(Encoding.UTF8.GetBytes(cell));
                else builder.AppendText(cell);
            }
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    /// <summary>Each stored row as its cells joined by "|", NULL as "NULL".</summary>
    private static List<string> Text(ResultSetBuffer set)
    {
        var rows = new List<string>();
        foreach (var page in set.SealedSnapshot())
        {
            var view = PageView.Parse(page.Body, set.Wires.Count);
            for (var r = 0; r < page.Rows; r++)
            {
                var cells = new string[set.Wires.Count];
                for (var c = 0; c < cells.Length; c++) cells[c] = view.IsNull(c, r) ? "NULL" : Encoding.UTF8.GetString(view.Span(c, r));
                rows.Add(string.Join("|", cells));
            }
        }
        return rows;
    }

    private static string Entries(DiffModel model) => string.Join(" ", model.Entries.Select(entry => entry.Kind switch
    {
        DiffKind.Same => "=",
        DiffKind.Changed => "~",
        DiffKind.Added => "+",
        _ => "-"
    } + (entry.Left < 0 ? "" : entry.Left.ToString(System.Globalization.CultureInfo.InvariantCulture)) + ":" + (entry.Right < 0 ? "" : entry.Right.ToString(System.Globalization.CultureInfo.InvariantCulture))));

    private static (ResultSetBuffer Left, ResultSetBuffer Right) Pair(ResultStore store, string?[][] left, string?[][] right, ResultColumn[]? rightColumns = null,
        ResultColumn[]? leftColumns = null)
    {
        var budget = store.BeginQuery("diff" + Guid.NewGuid());
        return (Fill(store, budget, 0, left, leftColumns), Fill(store, budget, 1, right, rightColumns));
    }

    private static ResultSetBuffer Unified(ResultStore store, ResultSetBuffer left, ResultSetBuffer right, DiffModel model, int context = -1)
    {
        var unified = store.Open(left.Budget, 2, 1, 1, "diff", UnifiedDiff.Columns(right, model), UnifiedDiff.Wires(right, model), lengths: UnifiedDiff.Lengths(right, model))
            ?? throw new InvalidOperationException("The diff was not kept.");
        UnifiedDiff.Write(unified, left, left.SealedSnapshot(), right, right.SealedSnapshot(), model, context, CancellationToken.None);
        return unified;
    }

    /// <summary>A column of one name that holds binary in one result and text in the other is not compared (its cells could
    /// not share the unified result's column) but listed as one-sided; too many shared columns are refused up front.</summary>
    private static void WireMismatch(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        ResultColumn[] binary = [new("ItemId", "int", "text"), new("v", "varbinary(10)", "binary")];
        ResultColumn[] text = [new("ItemId", "int", "text"), new("v", "varchar(10)", "text", Collation: CaseInsensitive)];
        var (left, right) = Pair(store, [["1", "a"], ["2", "b"]], [["1", "a"], ["3", "c"]], text, binary);
        var model = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None);
        string? failure = null;
        try { Unified(store, left, right, model); }
        catch (Exception error) { failure = error.GetType().Name; }
        check(model.Pairs is [(0, 0)] && failure is null, "a column that is binary in one result and text in the other is left out of the comparison, so the diff is written: " + failure);
        using var service = new SqlService(store);
        var diff = (ResultsDiffResult)service.DispatchAsync("results.diff", JsonSerializer.SerializeToElement(new { left = left.ResultId, right = right.ResultId }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        check(diff.LeftOnly is ["v"] && diff.RightOnly is ["v"] && diff is { Removed: 1, Added: 1, Same: 1 }, "results.diff lists such a column as not compared on both sides");
        var (onlyBinary, onlyText) = Pair(store, [["a"]], [["a"]], [text[1]], [binary[1]]);
        string? message = null;
        try { ResultDiffer.Compare(onlyBinary, onlyBinary.SealedSnapshot(), onlyText, onlyText.SealedSnapshot(), false, CancellationToken.None); }
        catch (RequestException error) { message = error.Message; }
        check(message == "The columns these results share hold binary data in one and text in the other, so they cannot be compared.",
            "results whose only shared column differs in kind say so, rather than that they share no names: " + message);

        var wide = Enumerable.Range(0, ResultDiffer.MaxPairs + 1).Select(i => new ResultColumn("c" + i.ToString(System.Globalization.CultureInfo.InvariantCulture), "int", "text")).ToArray();
        var row = wide.Select(_ => (string?)"1").ToArray();
        var (wideLeft, wideRight) = Pair(store, [row], [row], wide, wide);
        string? code = null;
        try { ResultDiffer.Compare(wideLeft, wideLeft.SealedSnapshot(), wideRight, wideRight.SealedSnapshot(), false, CancellationToken.None); }
        catch (RequestException error) { code = error.Code; }
        check(code == "INVALID_PARAMS", "results sharing more columns than a diff can show are refused with INVALID_PARAMS, not a failure in the store: " + code);
    }

    /// <summary>A shared column's values compare by the first result's type and collation, so rows still match when the second
    /// result's column changed collation or type; values compare themselves, not only their hashes.</summary>
    private static void Rules(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        ResultColumn[] collated = [new("Name", "nvarchar", "text", Collation: CaseInsensitive), new("Qty", "int", "text")];
        ResultColumn[] other = [new("Name", "varchar", "text"), new("Qty", "bigint", "text")];
        // Repeated rows: no key is unique, so whole rows match.
        string?[][] rows = [["apple", "1"], ["apple", "1"], ["pear", "2"]];
        var (left, right) = Pair(store, rows, [["apple", "01"], ["apple", "1"], ["PEAR", "2"]], other, collated);
        var model = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None);
        check(model.KeyPair == -1 && Entries(model) == "=0:0 =1:1 =2:2" && model.Counts().Soft == 1,
            "whole rows match when the second result's column has another collation or type, compared by the first's: " + Entries(model));

        var budget = store.BeginQuery("same");
        var a = Fill(store, budget, 0, [["Apple ", "2.0"]], [collated[0], new("Price", "decimal", "text")]);
        var b = Fill(store, budget, 1, [["APPLE", "2.00"], ["Apples", "2.01"]], [collated[0], new("Price", "decimal", "text")]);
        var left2 = new CellHasher(a.Columns, a.Wires);
        var right2 = new CellHasher(b.Columns, b.Wires);
        var va = PageView.Parse(a.SealedSnapshot()[0].Body, 2);
        var vb = PageView.Parse(b.SealedSnapshot()[0].Body, 2);
        check(left2.Same(va, 0, 0, right2, vb, 0, 0) && left2.Same(va, 1, 0, right2, vb, 1, 0) && !left2.Same(va, 0, 0, right2, vb, 0, 1) && !left2.Same(va, 1, 0, right2, vb, 1, 1)
            , "values compare by value (collation, trailing spaces, numeric form), so a hash collision cannot make different values equal");
    }

    /// <summary>A row that differs in every one of many columns lists each of them in its tone.</summary>
    private static void Tones(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        const int width = 150;
        var columns = new[] { new ResultColumn("ItemId", "int", "text") }.Concat(Enumerable.Range(1, width).Select(i => new ResultColumn("c" + i.ToString(System.Globalization.CultureInfo.InvariantCulture), "int", "text"))).ToArray();
        string?[] Row(string value) => [.. new[] { "1" }.Concat(Enumerable.Repeat(value, width))];
        var (left, right) = Pair(store, [Row("1")], [Row("2")], columns, columns);
        var model = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None);
        var tones = Text(Unified(store, left, right, model)).Select(row => row.Split('|')[^1]).ToArray();
        check(tones is ["removed 4-153", "added 4-153"], "a row's tone lists a run of adjacent differing columns as a range: " + string.Join(" / ", tones));
        // Runs of either kind, and a tone too long for what the grid reads of a cell, cut at a whole entry.
        var builder = new StringBuilder();
        check(UnifiedDiff.Tone(builder, "same", [0, 1, ~2, ~3, 5]) == "same 3-4 ~5-6 8", "a soft run is listed apart from a changed one");
        var scattered = Enumerable.Range(0, 2000).Where(c => c % 2 == 0).ToArray();
        var cut = UnifiedDiff.Tone(builder, "removed", scattered);
        var tokens = cut.Split(' ');
        check(cut.Length <= UnifiedDiff.MaxToneChars && UnifiedDiff.MaxToneChars < 512 && tokens[^1] == "…" && tokens[1..^1].All(token => int.TryParse(token, out _))
            && int.Parse(tokens[^2], System.Globalization.CultureInfo.InvariantCulture) == scattered[tokens.Length - 3] + 3,
            "a tone longer than the grid reads of a cell stops at a whole entry and ends with an ellipsis: " + cut.Length + " characters");
    }

    /// <summary>When the budget fills, it never does so between a changed row's "−" and "+" rows.</summary>
    private static void Halves(Action<bool, string> check)
    {
        var split = new List<int>();
        string?[][] Rows(string price) => [.. Enumerable.Range(1, 400).Select(i => new[] { i.ToString(System.Globalization.CultureInfo.InvariantCulture), "name " + i.ToString(System.Globalization.CultureInfo.InvariantCulture), price })];
        var big = new ResultStore(1L << 30, 1L << 29);
        var source = big.BeginQuery("source");
        var left = Fill(big, source, 0, Rows("1.00"));
        var right = Fill(big, source, 1, Rows("2.00"));
        var model = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None);
        for (var budget = 24 * 1024; budget <= 96 * 1024; budget += 1024 + 136)
        {
            var store = new ResultStore(budget, budget);
            var query = store.BeginQuery("halves" + budget.ToString(System.Globalization.CultureInfo.InvariantCulture));
            var unified = store.Open(query, 2, 1, 1, "diff", UnifiedDiff.Columns(right, model), UnifiedDiff.Wires(right, model), lengths: UnifiedDiff.Lengths(right, model));
            if (unified is null) continue;
            UnifiedDiff.Write(unified, left, left.SealedSnapshot(), right, right.SealedSnapshot(), model, -1, CancellationToken.None);
            var rows = Text(unified);
            if (rows.Count % 2 != 0 || rows.Where((row, at) => row.StartsWith(at % 2 == 0 ? UnifiedDiff.Removed : UnifiedDiff.Added, StringComparison.Ordinal)).Count() != rows.Count) split.Add(budget);
            if (rows.Count < 800 && unified.Truncated == TruncationReason.None) split.Add(-budget);
        }
        check(split.Count == 0, "a full budget stops a diff before a changed row's two halves, never between them, and says it was truncated: " + string.Join(",", split));
    }

    /// <summary>A diff row's bytes (the row-size bar) are its source row's shared values, not its marker, row numbers or tone.</summary>
    private static void Sizes(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var (left, right) = Pair(store, [["1", "apple", "1.50"], ["2", "pear", "2.00"]], [["1", "apple", "1.75"], ["2", "pear", "2.00"]]);
        var model = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None);
        var unified = Unified(store, left, right, model);
        var bytes = unified.RowBytes(0, 3);
        // Utf16 text, 2 bytes a character: "1" "apple" "1.50" is 10 characters; "2" "pear" "2.00" 9.
        check(bytes is [20, 20, 18], "a diff row's bytes are its shared values' (the source row's), without the marker, row numbers and tone: " + string.Join(",", bytes));
    }

    /// <summary>A key both results share aligns moved and changed rows; removed rows follow the row they followed; a value
    /// equal only by collation is a soft difference, which leaves its row unchanged, unless Exact.</summary>
    private static void Keyed(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var (left, right) = Pair(store,
            [["1", "apple", "1.50"], ["2", "pear", "2.00"], ["3", "plum", "3.00"], ["4", "fig", "4.00"], ["6", "lime", "6.00"]],
            [["2", "PEAR", "2.0"], ["1", "apple", "1.75"], ["5", "kiwi", "5.00"], ["4", "fig", NULL], ["6", "lime", "6.00"]]);
        var model = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None);
        check(model.KeyPair == 0 && Entries(model) == "=1:0 -2: ~0:1 +:2 ~3:3 =4:4",
            "rows match by the shared key in the second result's order, a removed row after the row it followed: " + Entries(model));
        check(model.CellsOf(model.Entries[0]).ToArray() is [~1] && model.CellsOf(model.Entries[2]).ToArray() is [2] && model.CellsOf(model.Entries[4]).ToArray() is [2],
            "PEAR and pear differ only by collation (soft), 2.00 and 2.0 are the same number, a price and a NULL differ");
        var (same, changed, added, removed, soft) = model.Counts();
        check(same == 2 && changed == 2 && added == 1 && removed == 1 && soft == 1, "the counts add up");
        var exact = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), true, CancellationToken.None);
        check(exact.Entries[0].Kind == DiffKind.Changed && exact.CellsOf(exact.Entries[0]).ToArray() is [1], "Exact compares text character for character");
        var budget = left.Budget;
        var unified = store.Open(budget, 1, 1, 1, "diff", UnifiedDiff.Columns(right, model), UnifiedDiff.Wires(right, model))!;
        UnifiedDiff.Write(unified, left, left.SealedSnapshot(), right, right.SealedSnapshot(), model, -1, CancellationToken.None);
        var rows = Text(unified);
        var expected = new[]
        {
            " |2|1|2|PEAR|2.0|same ~4",
            "−|3|NULL|3|plum|3.00|removed",
            "−|1|NULL|1|apple|1.50|removed 5",
            "+|NULL|2|1|apple|1.75|added 5",
            "+|NULL|3|5|kiwi|5.00|added",
            "−|4|NULL|4|fig|4.00|removed 5",
            "+|NULL|4|4|fig|NULL|added 5",
            " |5|5|6|lime|6.00|NULL"
        };
        check(unified.IsComplete && rows.SequenceEqual(expected) && unified.Columns[^1].Role == "tone" && string.Join(",", unified.Columns.Select(column => column.Name)) == "Change,R1,R2,ItemId,Name,Price,",
            "the unified result shows a change as its old row (−) then its new one (+), with row numbers and the differing cells in the hidden tone: " + string.Join(" / ", rows));
    }

    private const string? NULL = null;

    /// <summary>Without a key both results share, whole rows match, the k-th copy with the k-th copy; columns pair by name.</summary>
    private static void WholeRows(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        ResultColumn[] renamed = [new("itemid", "int", "text"), new("Price", "decimal", "text", Precision: 10, Scale: 2), new("Extra", "int", "text")];
        var (left, right) = Pair(store,
            [["1", "a", "1"], ["1", "a", "1"], ["1", "b", "2"]],
            [["1", "1", "9"], ["1", "2", "9"], ["1", "3", "9"]], renamed);
        var model = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None);
        check(model.KeyPair == -1 && model.Pairs is [(0, 0), (2, 1)] && Entries(model) == "=0:0 -1: =2:1 +:2",
            "whole rows (their shared columns, by name) match when no key is unique, copy by copy: " + Entries(model));
    }

    /// <summary>Context keeps that many unchanged rows on each side of a change.</summary>
    private static void Context(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        string?[][] Rows(int changed) => [.. Enumerable.Range(1, 10).Select(i => new[] { i.ToString(System.Globalization.CultureInfo.InvariantCulture), "n", i == changed ? "0" : "1" })];
        var (left, right) = Pair(store, Rows(-1), Rows(5));
        var model = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None);
        var shown = UnifiedDiff.Shown(model, 1);
        check(string.Concat(shown.Select(item => item ? '1' : '0')) == "0001110000" && UnifiedDiff.Shown(model, 0).Count(item => item) == 1 && UnifiedDiff.Shown(model, -1).All(item => item),
            "one row of context shows the rows next to a change; none shows only the change; -1 shows every row");
    }

    /// <summary>Differing cells are charged as they are found, so two results whose every value differs fail with TOO_LARGE
    /// once the budget refuses, instead of holding memory nothing counts.</summary>
    private static void CellMemory(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var rows = ResultDiffer.CellChunk + 1;
        string?[][] Rows(string price) => [.. Enumerable.Range(1, rows).Select(i => new[] { i.ToString(System.Globalization.CultureInfo.InvariantCulture), "n", price })];
        var (left, right) = Pair(store, Rows("1"), Rows("2"));
        var asked = new List<long>();
        var model = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None, bytes => { asked.Add(bytes); return true; });
        check(model.Cells.Length == rows && asked.Count == 2 && asked.All(bytes => bytes == ResultDiffer.CellChunk * ResultDiffer.CellBytes),
            "a diff charges its differing cells a chunk at a time (" + asked.Count + " chunks for " + model.Cells.Length + " cells)");
        var calls = 0;
        string? code = null;
        try { ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None, _ => ++calls < 2); }
        catch (RequestException error) { code = error.Code; }
        check(code == "TOO_LARGE" && calls == 2, "a diff whose differing cells the budget refuses fails with TOO_LARGE");
        check(ResultDiffer.WorkingBytes(10, 10) == 40 * 10 + 12 * 10 + 2 * 20 * 20, "a diff reserves its identities, match tables and entries, held twice while the model is built");
    }

    private static void Host(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var (left, right) = Pair(store, [["1", "a", "1"], ["2", "b", "2"]], [["1", "a", "1"], ["2", "B", "3"], ["3", "c", "3"]]);
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
        string? Code(string method, object args)
        {
            try { Call<object>(method, args); return null; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "INVALID_PARAMS"; }
        }
        var before = store.UsedBytes;
        var diff = Call<ResultsDiffResult>("results.diff", new { left = left.ResultId, right = right.ResultId });
        var stored = store.Find(diff.Descriptor.ResultId);
        check(SqlService.MethodNames.Contains("results.diff") && diff.Key == "ItemId" && diff is { Same: 1, Changed: 1, Added: 1, Removed: 0, Soft: 1 } && diff.Descriptor.Kind == "diff"
            && diff.Descriptor.State == "complete" && diff.Descriptor.RowsStored == 4 && stored is not null && ReferenceEquals(stored.Budget, left.Budget) && store.UsedBytes > before,
            "results.diff stores the unified diff as a complete result of the same query and counts each kind");
        var otherBudget = store.BeginQuery("other");
        var other = Fill(store, otherBudget, 0, [["1", "a", "1"]]);
        var open = store.Open(otherBudget, 1, 1, 1, "rows", Columns, Wires)!;
        ResultColumn[] unrelated = [new("x", "int", "text")];
        var otherPair = Pair(store, [["1", "a", "1"]], [["1"]], unrelated);
        var codes = new[]
        {
            Code("results.diff", new { left = left.ResultId, right = left.ResultId }),
            Code("results.diff", new { left = left.ResultId, right = right.ResultId, context = 101 }),
            Code("results.diff", new { left = left.ResultId, right = 999 }),
            Code("results.diff", new { left = other.ResultId, right = open.ResultId }),
            Code("results.diff", new { left = otherPair.Left.ResultId, right = otherPair.Right.ResultId }),
            Code("results.diff", new { left = left.ResultId, right = diff.Descriptor.ResultId })
        };
        check(string.Join(",", codes) == "INVALID_PARAMS,INVALID_PARAMS,RESULT_NOT_FOUND,RESULT_OPEN,INVALID_PARAMS,INVALID_PARAMS",
            "results.diff checks its results: two different, complete, comparable results of one query: " + string.Join(",", codes));
        check(Code("results.diff", new { left = left.ResultId, right = other.ResultId }) == "INVALID_PARAMS", "results of different queries are not compared");
        store.BeginQuery(left.Budget.SessionId);
        check(store.Find(diff.Descriptor.ResultId) is null, "a diff is released with its query's other results");
        var tight = new ResultStore(8192, 8192);
        using var small = new SqlService(tight);
        var budget = tight.BeginQuery("tight");
        var a = tight.Open(budget, 0, 1, 1, "rows", [new("id", "int", "text")], [WireKind.Text])!;
        var b = tight.Open(budget, 1, 1, 1, "rows", [new("id", "int", "text")], [WireKind.Text])!;
        foreach (var set in new[] { a, b })
        {
            // Nearly full, not stopped: a stopped query answers BUDGET_STOPPED instead (Refusals).
            for (var row = 0; row < 10_000 && tight.UsedBytes < (set == a ? 3500 : 7000); row++)
            {
                if (set.BeginRow() is not { } builder) break;
                builder.AppendText(row.ToString(System.Globalization.CultureInfo.InvariantCulture));
                if (!set.TryCommitRow()) break;
            }
            set.Complete();
        }
        var used = tight.UsedBytes;
        string? refused;
        try { small.DispatchAsync("results.diff", JsonSerializer.SerializeToElement(new { left = a.ResultId, right = b.ResultId }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); refused = null; }
        catch (RequestException error) { refused = error.Code; }
        check(refused == "TOO_LARGE" && budget.Stopped == TruncationReason.None && tight.UsedBytes == used, "a diff the budget has no room for answers TOO_LARGE and takes nothing: " + refused + " " + budget.Stopped);
    }

    /// <summary>A diff is a derived set, stored whole or not at all: one the budget or low system memory cuts short is refused
    /// and leaves its query able to store another; a query that stopped storing answers BUDGET_STOPPED; a source released
    /// while it was compared ends the diff.</summary>
    private static void Refusals(Action<bool, string> check)
    {
        static string?[][] Rows(int count, string price, int pad = 0) => [.. Enumerable.Range(1, count).Select(i => new[] { i.ToString(System.Globalization.CultureInfo.InvariantCulture), new string('n', pad) + i.ToString(System.Globalization.CultureInfo.InvariantCulture), price })];
        static string? Message(SqlService service, ResultSetBuffer left, ResultSetBuffer right)
        {
            try { service.DispatchAsync("results.diff", JsonSerializer.SerializeToElement(new { left = left.ResultId, right = right.ResultId, context = -1 }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); return null; }
            catch (RequestException error) { return error.Code + ": " + error.Message; }
        }
        const string tooLarge = "TOO_LARGE: There is not enough result memory to show the differences. Close other results and try again.";

        // The budget runs out part-way: the sources, the alignment and about half the diff's rows fit.
        var roomy = new ResultStore(1L << 30, 1L << 29);
        Pair(roomy, Rows(400, "1.00", 200), Rows(400, "2.00", 200));
        var sources = roomy.UsedBytes;
        var working = ResultDiffer.WorkingBytes(400, 400) + ResultDiffer.CellChunk * ResultDiffer.CellBytes;
        var store = new ResultStore(1L << 30, sources + working + sources / 2);
        using (var service = new SqlService(store))
        {
            var (left, right) = Pair(store, Rows(400, "1.00", 200), Rows(400, "2.00", 200));
            var used = store.UsedBytes;
            // What the writer leaves under this budget: some of the rows, which results.diff must not answer with.
            var model = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None);
            store.TryReserve(left.Budget, working, false, out _);
            var part = store.Open(left.Budget, 2, 1, 1, "diff", UnifiedDiff.Columns(right, model), UnifiedDiff.Wires(right, model), lengths: UnifiedDiff.Lengths(right, model), derived: true)!;
            UnifiedDiff.Write(part, left, left.SealedSnapshot(), right, right.SealedSnapshot(), model, -1, CancellationToken.None);
            var written = part.Describe();
            store.Release(part.ResultId);
            store.Return(left.Budget, working);
            var refused = Message(service, left, right);
            check(written is { RowsStored: > 0 and < 800 } && written.RowsStored < written.RowsRead && refused == tooLarge && store.UsedBytes == used && left.Budget.Stopped == TruncationReason.None,
                $"a diff the budget cuts short is refused whole, releases what it stored and leaves its query's budget open: {written.RowsStored}/{written.RowsRead} {refused} {store.UsedBytes - used} {left.Budget.Stopped}");
        }

        // Low system memory: the diff's first page seals after 64 rows.
        var low = false;
        // The probe runs at every page seal: what happens to the query while a diff's first page is sealed.
        Action? sealing = null;
        var probed = new ResultStore(1L << 30, 1L << 29, () =>
        {
            var action = sealing;
            sealing = null;
            action?.Invoke();
            return (low ? 100 : 0, 50);
        });
        using (var service = new SqlService(probed))
        {
            var written = Pair(probed, Rows(100, "1.00"), Rows(100, "2.00"));
            var before = probed.UsedBytes;
            sealing = () => written.Left.Budget.Stop(TruncationReason.QueryBudget);
            var cut = Message(service, written.Left, written.Right);
            check(sealing is null && cut == "BUDGET_STOPPED: " + SqlService.BudgetStoppedFull && probed.UsedBytes == before,
                $"a diff whose query stops storing while it is written answers BUDGET_STOPPED and keeps nothing: {cut} {probed.UsedBytes - before}");

            var (left, right) = Pair(probed, Rows(100, "1.00"), Rows(100, "2.00"));
            var few = Pair(probed, Rows(2, "1.00"), Rows(2, "2.00"));
            var used = probed.UsedBytes;
            low = true;
            var pressed = Message(service, left, right);
            check(pressed == tooLarge && left.Budget.Stopped == TruncationReason.None && probed.UsedBytes == used,
                $"a diff cut short by low system memory is refused whole and leaves its query's budget open: {pressed} {left.Budget.Stopped} {probed.UsedBytes - used}");
            var whole = (ResultsDiffResult)service.DispatchAsync("results.diff", JsonSerializer.SerializeToElement(new { left = few.Left.ResultId, right = few.Right.ResultId }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;
            check(whole.Descriptor is { RowsStored: 4, Truncated: null, State: "complete" } && few.Left.Budget.Stopped == TruncationReason.None,
                $"a diff whose last page is sealed under low system memory is kept whole and not marked truncated: {whole.Descriptor.RowsStored} {whole.Descriptor.Truncated}");
            low = false;
            var again = Message(service, left, right);
            check(again is null, "the same diff is stored once memory is free again: " + again);
            left.Budget.Stop(TruncationReason.SystemMemory);
            few.Left.Budget.Stop(TruncationReason.GlobalBudget);
            var lowMemory = Message(service, left, right);
            var filled = Message(service, few.Left, few.Right);
            check(lowMemory == "BUDGET_STOPPED: " + SqlService.BudgetStoppedLowMemory && filled == "BUDGET_STOPPED: " + SqlService.BudgetStoppedFull,
                $"a diff of a query that stopped storing answers BUDGET_STOPPED with why: {lowMemory} / {filled}");
        }

        // A source released while it was compared: the diff ends rather than describe results that are gone.
        var open = new ResultStore(1L << 30, 1L << 29);
        using (var service = new SqlService(open))
        {
            (Tripwire Columns, ResultSetBuffer Left, ResultSetBuffer Right) Wired(string session)
            {
                var budget = open.BeginQuery(session);
                var columns = new Tripwire(Columns) { Within = nameof(ResultDiffer) };
                var left = open.Open(budget, 0, 1, 1, "rows", columns, Wires)!;
                left.CountRow();
                var builder = left.BeginRow()!;
                foreach (var cell in new[] { "1", "a", "1.00" }) builder.AppendText(cell);
                left.TryCommitRow();
                left.Complete();
                return (columns, left, Fill(open, budget, 1, [["1", "a", "2.00"]]));
            }
            var gone = Wired("released");
            var count = open.Count;
            gone.Columns.OnRead = () => open.Release(gone.Left.ResultId);
            var released = Message(service, gone.Left, gone.Right);
            check(gone.Columns.OnRead is null && released == "RESULT_RELEASED: These results were closed. Execute the query again to see them." && open.Count == count - 1,
                $"a diff whose source is released while it is compared answers RESULT_RELEASED and stores nothing: {released} {open.Count - count}");
            // The sources are complete, but their query may still be reading later sets: one that stops storing while they
            // are compared is why the diff was not kept, not the memory left.
            var stopping = Wired("stopping");
            var used = open.UsedBytes;
            stopping.Columns.OnRead = () => stopping.Left.Budget.Stop(TruncationReason.SystemMemory);
            var during = Message(service, stopping.Left, stopping.Right);
            check(stopping.Columns.OnRead is null && during == "BUDGET_STOPPED: " + SqlService.BudgetStoppedLowMemory && open.UsedBytes == used,
                $"a diff whose query stops storing while it is compared answers BUDGET_STOPPED and keeps nothing: {during} {open.UsedBytes - used}");
            // The same while it compares, with the budget full: the differing cells are refused their memory.
            var filling = Wired("filling");
            used = open.UsedBytes;
            long taken = 0;
            filling.Columns.OnRead = () =>
            {
                taken = open.QueryBytes - filling.Left.Budget.UsedBytes;
                open.TryReserve(filling.Left.Budget, taken, false, out _);
                filling.Left.Budget.Stop(TruncationReason.QueryBudget);
            };
            var cells = Message(service, filling.Left, filling.Right);
            open.Return(filling.Left.Budget, taken);
            check(filling.Columns.OnRead is null && taken > 0 && cells == "BUDGET_STOPPED: " + SqlService.BudgetStoppedFull && open.UsedBytes == used,
                $"a diff refused memory for its differing cells because its query filled the budget answers BUDGET_STOPPED: {cells} {open.UsedBytes - used}");
        }
    }
}
