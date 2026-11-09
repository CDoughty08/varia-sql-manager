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
        Host(check);
    }

    private static ResultSetBuffer Fill(ResultStore store, QueryBudget budget, int index, string?[][] rows, ResultColumn[]? columns = null)
    {
        columns ??= Columns;
        var set = store.Open(budget, index, 1, 1, "rows", columns, [.. columns.Select(_ => WireKind.Text)]) ?? throw new InvalidOperationException("The result set was not kept.");
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

    private static (ResultSetBuffer Left, ResultSetBuffer Right) Pair(ResultStore store, string?[][] left, string?[][] right, ResultColumn[]? rightColumns = null)
    {
        var budget = store.BeginQuery("diff" + Guid.NewGuid());
        return (Fill(store, budget, 0, left), Fill(store, budget, 1, right, rightColumns));
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
            for (var row = 0; row < 10_000; row++)
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
        check(refused == "TOO_LARGE" && tight.UsedBytes == used, "a diff the budget has no room for answers TOO_LARGE and takes nothing");
    }
}
