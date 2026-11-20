using System.Globalization;
using System.Text;
using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>The one-row layout (comparison plan PR 6): its columns (previous values with the first result's type), rows and
/// tones, the 2,046-pair refusal, cut rows' changed-pair lists in the change index, the 8 MiB row limit, Save writing each
/// changed cell's old value (an old NULL as NULL even with empty NULL text, and past a cut) while Copy writes none, and which
/// refusals answer DIFF_ROWS_TOO_LARGE.</summary>
internal static partial class DiffChecks
{
    private static void LayoutChecks(Action<bool, string> check)
    {
        EntryRows(check);
        EntryWidth(check);
        EntryCutRows(check);
        EntryRowLimit(check);
        EntryRefusals(check);
    }

    private static T Call<T>(SqlService service, string method, object args) =>
        (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult()!;

    private static string? Refusal(SqlService service, string method, object args)
    {
        try { Call<object>(service, method, args); return null; }
        catch (RequestException error) { return error.Code + ": " + error.Message; }
    }

    /// <summary>A one-row diff's columns and rows, its answer and index, and Save and Copy of it.</summary>
    private static void EntryRows(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        // The second result's Price is money: the data column takes its type, the previous-value column the first's.
        ResultColumn[] money = [Columns[0], Columns[1], new("Price", "money", "text")];
        // Same 1; changed 2 (Name only by collation, Price 2.00 to 3.00); changed 3 (Price NULL to 5.00); removed 4; added 5.
        var (left, right) = Pair(store, [["1", "a", "1.00"], ["2", "b", "2.00"], ["3", "c", null], ["4", "d", "4.00"]],
            [["1", "a", "1.00"], ["2", "B", "3.00"], ["3", "c", "5.00"], ["5", "e", "5.00"]], money);
        var diff = Call<ResultsDiffResult>(service, "results.diff", new { left = left.ResultId, right = right.ResultId, context = -1, layout = "entry" });
        var set = store.Find(diff.Descriptor.ResultId)!;
        var columns = set.Columns;
        check(diff.Layout == "entry" && columns.Count == 10 && columns.Take(3).Select(column => column.Name).SequenceEqual(["ItemId", "Name", "Price"]) && columns[2].DataType == "money"
            && columns.Skip(3).Take(3).All(column => column.Role == "old") && columns[3].Of == 0 && columns[5].Of == 2 && columns[5].Name == "Price (old)" && columns[5].DataType == "decimal"
            && columns[5].SortKind == ColumnTypes.Decimal && columns[4].Collation == CaseInsensitive && columns.Skip(6).Select(column => column.Role).SequenceEqual(["mark", "leftRow", "rightRow", "tone"]),
            "a one-row diff's columns are the data (second result's types), a previous-value column per pair (role old, of its pair, the first result's type and collation), then the suffix: "
            + string.Join(",", columns.Select(column => column.Name + ":" + column.DataType + ":" + column.Role)));
        var rows = Text(set);
        string[] expected =
        [
            "1|a|1.00|NULL|NULL|NULL| |1|1|NULL",
            "2|B|3.00|NULL|NULL|2.00|~|2|2|changed ~1 2",
            "3|c|5.00|NULL|NULL|NULL|~|3|3|changed 2",
            "4|d|4.00|NULL|NULL|NULL|−|4|NULL|removed",
            "5|e|5.00|NULL|NULL|NULL|+|NULL|4|added"
        ];
        check(rows.SequenceEqual(expected), "a one-row diff stores each entry once: a change's new values with the old one in each changed (not soft) pair, NULL elsewhere: " + string.Join(" / ", rows));
        var index = set.DiffIndex!;
        check(diff.Descriptor.RowsStored == 5 && index.Rows == 5 && index.KindOf(1) == DiffRowKind.Changed && index.UnitsOf(1) == 1 && index.UnitsOf(2) == 1 && diff.Units == 4 && index.CutLists == 0
            && diff.Overview is [0, DiffIndex.ChangedBit, DiffIndex.ChangedBit, DiffIndex.RemovedBit, DiffIndex.AddedBit],
            $"a one-row diff's index has one changed row an entry with its units, and the same totals as two rows: {diff.Units} {string.Join(",", diff.Overview)}");
        var unified = Call<ResultsDiffResult>(service, "results.diff", new { left = left.ResultId, right = right.ResultId, context = -1 });
        check(unified.Layout == "unified" && unified.Descriptor.Columns.Count == 7 && unified.Units == diff.Units && unified.Descriptor.RowsStored == 7,
            "without a layout a diff is written in two rows, as before, with the same change units");
        var changesOnly = Call<ResultsDiffResult>(service, "results.diff", new { left = left.ResultId, right = right.ResultId, context = 0, layout = "entry" });
        check(Text(store.Find(changesOnly.Descriptor.ResultId)!).Select(row => row.Split('|')[9]).SequenceEqual(["changed gap=1 ~1 2", "changed 2", "removed", "added"]),
            "a one-row diff of changes only carries the gap flag on the changed row after the omitted run");
        // A kind filter keeps the one changed row an entry.
        var changed = Call<ResultsViewResult>(service, "results.view", new { resultId = set.ResultId, sort = Array.Empty<object>(), filters = new[] { new { op = "kind", kinds = new[] { "changed" } } } });
        check(changed.Rows == 2 && store.FindView(set.ResultId, changed.ViewId)!.Order is [1, 2], "a kind filter on a one-row diff keeps its changed rows");
        var seek = Call<ResultsDiffSeekResult>(service, "results.diffSeek", new { resultId = set.ResultId, from = -1, direction = "next" });
        check(seek is { Row: 1, Column: 2, Index: 1, Total: 4 }, "a seek on a one-row diff lands on a changed row's listed cell");
        check(Refusal(service, "results.view", new { resultId = set.ResultId, sort = new[] { new { column = 5, descending = false, mode = "value" } } })?.StartsWith("INVALID_PARAMS", StringComparison.Ordinal) == true
            && Refusal(service, "results.distinct", new { resultId = set.ResultId, column = 4 })?.StartsWith("INVALID_PARAMS", StringComparison.Ordinal) == true,
            "a previous-value column is hidden: sorting by it or listing its values is refused");

        var folder = Directory.CreateTempSubdirectory("varia-diff-entry");
        try
        {
            var jobs = new ResultJobs(store);
            string Save(string format, string nullText, uint? viewId = null)
            {
                var path = Path.Combine(folder.FullName, "diff." + format);
                jobs.ExportAsync(new ResultsExportArgs(set.ResultId, path, format, true, nullText, Guid.NewGuid().ToString("N"), ViewId: viewId), null).GetAwaiter().GetResult();
                return File.ReadAllText(path);
            }
            var csv = Save("csv", "empty").Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(line => line.TrimEnd('\r')).ToArray();
            string[] lines =
            [
                "Change,Old row,New row,ItemId,ItemId (old),Name,Name (old),Price,Price (old)",
                " ,1,1,1,,a,,1.00,",
                "~,2,2,2,,B,,3.00,2.00",
                "~,3,3,3,,c,,5.00,NULL",
                "−,4,,4,,d,,4.00,",
                "+,,4,5,,e,,5.00,"
            ];
            check(csv.SequenceEqual(lines), "Save of a one-row diff follows each data column with its old values, written only where it changed, an old NULL as NULL even with empty NULL text: " + string.Join(" / ", csv));
            var nulls = Save("csv", "NULL").Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(line => line.TrimEnd('\r')).ToArray();
            check(nulls[1] == " ,1,1,1,,a,,1.00," && nulls[4] == "−,4,NULL,4,,d,,4.00,", "with NULL text the unchanged cells' old fields stay empty while NULL data says NULL: " + nulls[1] + " / " + nulls[4]);
            using var json = JsonDocument.Parse(Save("json", "empty"));
            var objects = json.RootElement.EnumerateArray().ToArray();
            check(objects.Length == 5 && !objects[0].TryGetProperty("Price (old)", out _) && objects[1].GetProperty("Price (old)").GetRawText() == "2.00" && !objects[1].TryGetProperty("Name (old)", out _)
                && objects[2].GetProperty("Price (old)").ValueKind == JsonValueKind.Null && objects[0].GetProperty("Change").GetString() == " ",
                "JSON Save leaves an unchanged cell's old key out and writes a changed one, an old NULL as null: " + objects[1].GetRawText() + " " + objects[2].GetRawText());
            // Sorted by ItemId descending: the changed pairs follow each stored row, not its place in the view.
            var sorted = Call<ResultsViewResult>(service, "results.view", new { resultId = set.ResultId, sort = new[] { new { column = 0, descending = true, mode = "value" } } });
            var viewed = Save("csv", "empty", sorted.ViewId).Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(line => line.TrimEnd('\r')).ToArray();
            check(viewed.Length == 6 && viewed[3] == "~,3,3,3,,c,,5.00,NULL" && viewed[4] == "~,2,2,2,,B,,3.00,2.00", "Save through a sorted view writes each row's own old values: " + string.Join(" / ", viewed));
            var copied = Encoding.UTF8.GetString(TextChecks.Copy(jobs, new ResultsCopyArgs(set.ResultId, [new([[0, 4]], [[0, 9]])], true, "lf", 1 << 20)).GetAwaiter().GetResult().Text);
            check(copied.StartsWith("ItemId\tName\tPrice\n1\ta\t1.00\n2\tB\t3.00\n", StringComparison.Ordinal) && !copied.Contains("(old)", StringComparison.Ordinal) && !copied.Contains("2.00", StringComparison.Ordinal) && !copied.Contains('~'),
                "Copy of a one-row diff writes shown values only: no markers and no old values: " + copied.Replace("\n", " / ", StringComparison.Ordinal));
        }
        finally { folder.Delete(true); }
    }

    /// <summary>Past 2,046 pairs the one-row layout is refused (the renderer asks for two rows itself); at 2,046 it is written.</summary>
    private static void EntryWidth(Action<bool, string> check)
    {
        static ResultColumn[] Wide(int count) => [.. Enumerable.Range(0, count).Select(i => new ResultColumn("c" + i.ToString(CultureInfo.InvariantCulture), "int", "text"))];
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        string? Entry(int pairs, string layout)
        {
            var columns = Wide(pairs);
            string?[] row = [.. columns.Select(_ => (string?)"1")];
            string?[] other = [.. columns.Select((_, at) => (string?)(at == pairs - 1 ? "2" : "1"))];
            var (left, right) = Pair(store, [row], [other], columns, columns);
            try
            {
                var diff = Call<ResultsDiffResult>(service, "results.diff", new { left = left.ResultId, right = right.ResultId, context = -1, layout });
                return diff.Layout + ":" + diff.Descriptor.Columns.Count;
            }
            catch (RequestException error) { return error.Code; }
        }
        var widest = Entry(UnifiedDiff.MaxEntryPairs, "entry");
        var wider = Entry(UnifiedDiff.MaxEntryPairs + 1, "entry");
        var unified = Entry(UnifiedDiff.MaxEntryPairs + 1, "unified");
        check(UnifiedDiff.MaxEntryPairs == 2046 && widest == "entry:" + PageBuilder.MaxColumns && wider == "INVALID_PARAMS" && unified == "unified:" + (UnifiedDiff.MaxEntryPairs + 1 + UnifiedDiff.SuffixColumns),
            $"the one-row layout takes up to 2,046 pairs (4,096 columns) and refuses more, which two rows still writes: {widest} {wider} {unified}");
        var (a, b) = Pair(store, [["1", "a", "1"]], [["1", "a", "1"]]);
        var codes = new[]
        {
            Refusal(service, "results.diff", new { left = a.ResultId, right = b.ResultId, layout = "rows" }),
            Refusal(service, "results.diff", new { left = a.ResultId, right = b.ResultId, layout = "" }),
            Refusal(service, "results.diff", new { left = a.ResultId, right = b.ResultId, replaces = 0 })
        };
        check(codes.All(code => code?.StartsWith("INVALID_PARAMS", StringComparison.Ordinal) == true), "a layout other than unified or entry, and replaces 0, are refused: " + string.Join(" | ", codes));
    }

    /// <summary>A one-row diff's cut row keeps its full changed-pair list in the change index, found by stored row through the
    /// sorted list of cut rows, so Save writes every changed cell's old value, past the cut too; the list is charged with the
    /// index and returned with it.</summary>
    private static void EntryCutRows(Action<bool, string> check)
    {
        const int width = 600;
        ResultColumn[] columns = [new("Id", "int", "text"), .. Enumerable.Range(1, width).Select(c => new ResultColumn("c" + c.ToString(CultureInfo.InvariantCulture), "int", "text"))];
        // Row 1 changes every odd column (more than a tone lists); row 2 is the same; row 3 changes one column.
        string?[] Row(string id, int value, bool scattered) => [id, .. Enumerable.Range(1, width).Select(c => (scattered && c % 2 == 1 ? value : c == 5 && id == "3" ? value : 0).ToString(CultureInfo.InvariantCulture))];
        var store = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.Off };
        using var service = new SqlService(store);
        var (left, right) = Pair(store, [Row("1", 1, true), Row("2", 1, false), Row("3", 1, false)], [Row("1", 2, true), Row("2", 1, false), Row("3", 2, false)], columns, columns);
        var before = Held.Bytes(store);
        var diff = Call<ResultsDiffResult>(service, "results.diff", new { left = left.ResultId, right = right.ResultId, context = -1, layout = "entry" });
        var set = store.Find(diff.Descriptor.ResultId)!;
        var index = set.DiffIndex!;
        var pairs = width + 1;
        var bits = index.ChangedPairs(0).ToArray();
        var listed = Enumerable.Range(0, pairs).Count(p => bits.Length > 0 && (bits[p / 64] & (1UL << (p % 64))) != 0);
        string? tone;
        using (set.Pin()) tone = DiffIndex.ToneOf(set, 0);
        check(index.IsCut(0) && index.CutLists == 1 && listed == width / 2 && index.ChangedPairs(1).IsEmpty && index.ChangedPairs(2).IsEmpty && tone!.EndsWith(" …", StringComparison.Ordinal)
            && index.Bytes == DiffIndex.BytesFor(3, 0) + DiffIndex.CutBytes(pairs) && DiffIndex.CutBytes(pairs) == 4 + 8 * 10,
            $"a one-row diff's cut row keeps its full list of changed pairs (and only it), charged with the index: {listed} pairs, {index.CutLists} lists, {index.Bytes} bytes");
        // Every changed cell holds its old value, listed by the tone or past its cut.
        var stored = Text(set)[0].Split('|');
        check(Enumerable.Range(1, width).All(c => stored[pairs + c] == (c % 2 == 1 ? "1" : "NULL")), "a cut row holds the old value in every changed cell, past the cut too");
        var folder = Directory.CreateTempSubdirectory("varia-diff-cut");
        try
        {
            var path = Path.Combine(folder.FullName, "cut.csv");
            new ResultJobs(store).ExportAsync(new ResultsExportArgs(set.ResultId, path, "csv", true, "empty", Guid.NewGuid().ToString("N")), null).GetAwaiter().GetResult();
            var line = File.ReadAllLines(path)[1].Split(',');
            // Change, Old row, New row, then Id, Id (old), c1, c1 (old), ...
            var olds = Enumerable.Range(1, width).Select(c => line[3 + 2 * c + 1]).ToArray();
            check(olds.Where((_, at) => (at + 1) % 2 == 1).All(old => old == "1") && olds.Where((_, at) => (at + 1) % 2 == 0).All(old => old == "") && line[4] == "",
                "Save of a cut row writes every changed cell's old value from the index's list, past the tone's cut, and leaves unchanged ones empty");
        }
        finally { folder.Delete(true); }
        store.Release(set.ResultId);
        check(Held.Bytes(store) == before, "releasing a one-row diff returns its rows, index and cut rows' lists: " + (Held.Bytes(store) - before));

        // A cut row's list the budget refuses stops the writer: the index is never built and the builder says why.
        var refusing = new DiffIndex.Builder(1, 0, 0, pairs, _ => false);
        check(!refusing.TryCut() && refusing.Refused && refusing.Bytes == 0, "a cut row's list refused by the budget marks the index refused and holds nothing");
    }

    /// <summary>A previous value is not measured but counts toward the 8 MiB row limit: past it, it is stored truncated and
    /// marked so, and the row's suffix is still whole.</summary>
    private static void EntryRowLimit(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        const int size = 5 << 20;
        var (left, right) = Pair(store, [["1", new string('x', size), "1"]], [["1", new string('y', size), "1"]]);
        var diff = Call<ResultsDiffResult>(service, "results.diff", new { left = left.ResultId, right = right.ResultId, context = -1, layout = "entry" });
        var set = store.Find(diff.Descriptor.ResultId)!;
        bool dataCut, oldCut;
        int dataBytes, oldBytes;
        string suffix;
        long rowLength;
        using (set.Pin())
        {
            var page = set.SealedSnapshot()[0];
            var view = PageView.Parse(PinnedPage.Body(page), set.Wires.Count);
            (dataCut, oldCut) = (view.IsTruncated(1, 0), view.IsTruncated(4, 0));
            (dataBytes, oldBytes) = (view.Span(1, 0).Length, view.Span(4, 0).Length);
            suffix = Encoding.UTF8.GetString(view.Span(6, 0)) + "|" + Encoding.UTF8.GetString(view.Span(9, 0));
            rowLength = page.Lengths.RowBytes(0);
        }
        check(!dataCut && dataBytes == size && oldCut && oldBytes > 0 && dataBytes + oldBytes <= PageBuilder.MaxRowBytes && suffix == "~|changed 1" && diff.Descriptor.TruncatedCells == 1
            && rowLength >= 2L * size && rowLength < 2L * size + 64,
            $"a previous value past the 8 MiB row limit is stored truncated and marked, after whole data and before a whole suffix, and the row-size bar counts only the data: {dataBytes} + {oldBytes} {oldCut} {suffix} {rowLength}");
    }

    /// <summary>Which refusals answer DIFF_ROWS_TOO_LARGE: only one of what grows with the rows stored (the rows, their previous
    /// values, the change index, its cut rows' lists) for All rows; Changes only, low system memory and other causes keep
    /// TOO_LARGE.</summary>
    private static void EntryRefusals(Action<bool, string> check)
    {
        const string sentence = "There is not enough result memory to show the differences. Close other results and try again.";
        var rows = SqlService.DiffRefusal(-1, true, false, sentence);
        var changes = SqlService.DiffRefusal(0, true, false, sentence);
        var low = SqlService.DiffRefusal(-1, true, true, sentence);
        var other = SqlService.DiffRefusal(-1, false, false, sentence);
        check(rows.Code == "DIFF_ROWS_TOO_LARGE" && changes.Code == "TOO_LARGE" && changes.Message == sentence && low is { Code: "TOO_LARGE", Message: SqlService.LowMemory } && other.Code == "TOO_LARGE",
            "a refusal of stored rows answers DIFF_ROWS_TOO_LARGE only for All rows; Changes only, low system memory and other causes keep TOO_LARGE");

        // Rows and previous values: every row changed, so Changes only stores the same rows. The old values are long and the
        // new ones short, so most of a one-row diff's bytes are its previous values.
        static string?[][] Rows(int count, bool old) => [.. Enumerable.Range(1, count).Select(i => new[] { i.ToString(CultureInfo.InvariantCulture), old ? new string('o', 400) : "n", old ? "1.00" : "2.00" })];
        var roomy = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.Off };
        var sizes = Pair(roomy, Rows(300, true), Rows(300, false));
        var sources = Held.Bytes(roomy);
        using (var measuring = new SqlService(roomy))
        {
            var whole = Call<ResultsDiffResult>(measuring, "results.diff", new { left = sizes.Left.ResultId, right = sizes.Right.ResultId, context = -1, layout = "entry" });
            var held = Held.Bytes(roomy) - sources;
            // Room for the sources, the alignment and its cells, the index, and half the one-row diff.
            var budget = sources + ResultDiffer.WorkingBytes(300, 300) + ResultDiffer.CellChunk * ResultDiffer.CellBytes + DiffIndex.BytesFor(300, 0) + held / 2;
            check(whole.Descriptor.RowsStored == 300, "the one-row diff measured stores a row an entry");
            var store = new ResultStore(1L << 30, budget) { Packing = PagePacking.Off };
            using var service = new SqlService(store);
            var (left, right) = Pair(store, Rows(300, true), Rows(300, false));
            var used = Held.Bytes(store);
            var all = Refusal(service, "results.diff", new { left = left.ResultId, right = right.ResultId, context = -1, layout = "entry" });
            var only = Refusal(service, "results.diff", new { left = left.ResultId, right = right.ResultId, context = 0, layout = "entry" });
            check(all == "DIFF_ROWS_TOO_LARGE: " + SqlService.DiffRowsTooLarge && only == "TOO_LARGE: " + sentence && Held.Bytes(store) == used && left.Budget.Stopped == TruncationReason.None,
                $"a one-row diff whose rows with their previous values the budget refuses answers DIFF_ROWS_TOO_LARGE for All rows and TOO_LARGE for Changes only, keeping nothing: {all} / {only}");
            // Refused working memory for the alignment is not about the rows stored: TOO_LARGE either way.
            var cramped = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.Off };
            using var crampedService = new SqlService(cramped);
            var few = Pair(cramped, Rows(300, true), Rows(300, false));
            cramped.Resize(1L << 30, Held.Bytes(cramped) + ResultDiffer.WorkingBytes(300, 300) / 2);
            var aligned = Refusal(crampedService, "results.diff", new { left = few.Left.ResultId, right = few.Right.ResultId, context = -1, layout = "entry" });
            check(aligned == "TOO_LARGE: " + ResultDiffer.TooLarge, "a diff refused memory to align its rows keeps TOO_LARGE for All rows too: " + aligned);
        }
    }
}
