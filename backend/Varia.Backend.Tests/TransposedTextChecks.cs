using System.Text;
using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of transposed Copy and Save Results As (a grid drawn transposed, written as drawn): the row cap
/// and its count, a sorted and filtered view, blocks, a set still loading, a line longer than a chunk, the size estimate,
/// progress in lines, cancellation, and the request's checks. The golden text of each format is in cases.json
/// (<see cref="TextChecks"/>).</summary>
internal static class TransposedTextChecks
{
    private const long End = ResultJobs.MaxSafeInteger;
    private const int Cap = ResultTextWriter.MaxTransposedRows;

    public static async Task RunAsync(Action<bool, string> check)
    {
        var folder = Directory.CreateTempSubdirectory("varia-transposed-");
        try
        {
            await CapAsync(check, folder.FullName);
            await ViewAsync(check, folder.FullName);
            await StreamAsync(check, folder.FullName);
            await EstimatesAsync(check);
            Names(check);
            await RequestsAsync(check, folder.FullName);
        }
        finally { folder.Delete(true); }
    }

    private static CopyPartArgs Part(long first, long last, int firstColumn, int lastColumn) => new([[first, last]], [[firstColumn, lastColumn]]);
    private static ResultsCopyArgs Turned(ResultSetBuffer set, CopyPartArgs[] parts, bool headers = false, uint? viewId = null, int? headerColumn = null) =>
        new(set.ResultId, parts, headers, "lf", ResultJobs.MaxCopyBytes, viewId, Transposed: true, HeaderColumn: headerColumn);
    private static ResultsExportArgs Saved(ResultSetBuffer set, string path, string format, bool headers = true, uint? viewId = null, int? headerColumn = null) =>
        new(set.ResultId, path, format, headers, "NULL", Guid.NewGuid().ToString("N"), viewId, Transposed: true, HeaderColumn: headerColumn);
    private static string Text(byte[] bytes) => Encoding.UTF8.GetString(bytes);

    private static async Task<string?> Code(Func<Task> action)
    {
        try { await action(); return null; }
        catch (RequestException error) { return error.Code; }
    }

    /// <summary>The rows a transposed grid draws are written, and the rest counted, for a save, a whole copy and blocks.</summary>
    private static async Task CapAsync(Action<bool, string> check, string folder)
    {
        check(Cap == 4095 && ResultTextWriter.MaxTransposedRows == Cap && ViewSorter.MaxKeepRows == Cap, "transposed text writes at most the 4,095 rows a transposed grid draws");
        var store = new ResultStore(1L << 30, 1L << 29);
        var jobs = new ResultJobs(store);
        var set = TextChecks.Synthetic(store, "W1", 5000);
        var path = Path.Combine(folder, "cap.txt");
        var saved = await jobs.ExportAsync(Saved(set, path, "tsv"), null);
        var lines = Text(File.ReadAllBytes(path)).Split("\r\n");
        var names = lines[0].Split('\t');
        var ids = lines[1].Split('\t');
        check(saved is { Rows: Cap, Capped: 5000 - Cap, Partial: false } && saved.Bytes == new FileInfo(path).Length && lines.Length == 10 && lines[^1] == ""
            && names.Length == Cap + 1 && names[0] == "﻿Column" && names[1] == "Row 1" && names[^1] == "Row 4095"
            && ids.Length == Cap + 1 && ids[0] == "id" && ids[1] == "0" && ids[^1] == "4094" && lines.Skip(1).Take(8).Select(line => line.Split('\t')[0]).SequenceEqual(set.Columns.Select(column => column.Name)),
            "a transposed save writes a line per column for the first 4,095 rows and counts the rest (" + saved + ")");

        var all = await TextChecks.Copy(jobs, Turned(set, [Part(0, End, 0, 7)]));
        var copied = Text(all.Text).Split('\n');
        var allEstimate = ResultJobs.EstimateCopy(set, [Part(0, End, 0, 7)], headers: false, crlf: false, transposed: true);
        check(all.Result is { Rows: Cap, Capped: 5000 - Cap } && copied.Length == 8 && copied.All(line => line.Split('\t').Length == Cap) && copied[0].EndsWith("\t4094", StringComparison.Ordinal)
            && allEstimate >= all.Text.Length && allEstimate < all.Text.Length * 2L,
            "a transposed copy of everything writes the rows drawn and says how many it left out (" + all.Result + ")");

        // A block that straddles the cap keeps its drawn rows; one wholly past it writes no values: nothing at all without
        // headers, and with them the names alone.
        var straddling = await TextChecks.Copy(jobs, Turned(set, [Part(Cap - 2, Cap + 3, 0, 0), Part(Cap + 10, Cap + 19, 0, 1)]));
        var past = await TextChecks.Copy(jobs, Turned(set, [Part(Cap, End, 0, 1)], headers: true));
        check(Text(straddling.Text) == "4093\t4094" && straddling.Result is { Rows: 2, Capped: 14 } && Text(past.Text) == "Column\nid\nname" && past.Result is { Rows: 0, Capped: 5000 - Cap },
            "a block past the rows drawn is left out and counted (" + JsonSerializer.Serialize(Text(straddling.Text)) + ", " + straddling.Result + "; " + JsonSerializer.Serialize(Text(past.Text)) + ")");

        // Under the cap nothing is left out, and the same request untransposed is unchanged.
        var block = await TextChecks.Copy(jobs, Turned(set, [new([[2, 3], [7, 7]], [[0, 0], [6, 7]])], headers: true));
        var table = await TextChecks.Copy(jobs, Turned(set, [new([[2, 3], [7, 7]], [[0, 0], [6, 7]])], headers: true) with { Transposed = false });
        check(Text(block.Text) == "Column\tRow 3\tRow 4\tRow 8\nid\t2\t3\t7\nactive\t0\t1\t0\nscore\t62\t93\t217" && block.Result is { Rows: 3, Capped: 0 }
            && Text(table.Text) == "id\tactive\tscore\n2\t0\t62\n3\t1\t93\n7\t0\t217" && table.Result is { Rows: 3, Capped: 0 },
            "a selected block copies turned, its rows named by their place in the view (" + JsonSerializer.Serialize(Text(block.Text)) + ")");
        check(set.Leases == 0, "transposed jobs end their leases");
    }

    /// <summary>Through a view the fields are its rows, in its order and with its filters; a header column reads them too.</summary>
    private static async Task ViewAsync(Action<bool, string> check, string folder)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var jobs = new ResultJobs(store);
        var set = TextChecks.Synthetic(store, "W1", 20);
        // The rows whose bit is 1 (every third: 0, 3 … 18), by id descending.
        var view = (ResultsViewResult)(await service.DispatchAsync("results.view", JsonSerializer.SerializeToElement(new
        {
            resultId = set.ResultId, sort = new[] { new { column = 0, descending = true, mode = "value" } }, filters = new object[] { new { op = "in", column = 6, rows = new[] { 0 } } }
        }, HostChecks.Json), HostChecks.Json))!;
        var copied = await TextChecks.Copy(jobs, Turned(set, [Part(0, End, 0, 0), Part(1, 2, 6, 7)], headers: true, viewId: view.ViewId));
        var named = await TextChecks.Copy(jobs, Turned(set, [Part(1, 3, 0, 0)], headers: true, viewId: view.ViewId, headerColumn: 7));
        check(view.Rows == 7 && Text(copied.Text) == "Column\tRow 1\tRow 2\tRow 3\tRow 4\tRow 5\tRow 6\tRow 7\nid\t18\t15\t12\t9\t6\t3\t0\nColumn\tRow 2\tRow 3\nactive\t1\t1\nscore\t465\t372" && copied.Result is { Rows: 9, Capped: 0, Partial: false },
            "a transposed copy through a view writes its rows in its order, filtered (" + JsonSerializer.Serialize(Text(copied.Text)) + ")");
        // Row 9's score is NULL (every fifth from 4): the header column names fields from the view's rows, not the result's.
        check(Text(named.Text) == "Column\t465\t372\tNULL\nid\t15\t12\t9", "a header column names the fields by the view's rows (" + JsonSerializer.Serialize(Text(named.Text)) + ")");
        // The estimate reads the same rows through the view's order, where neighbours are not neighbours in a page.
        var stored = store.FindView(set.ResultId, view.ViewId)!;
        var whole = ResultJobs.EstimateCopy(set, [Part(0, End, 0, 0), Part(1, 2, 6, 7)], headers: true, crlf: false, transposed: true, view: stored);
        var headed = ResultJobs.EstimateCopy(set, [Part(1, 3, 0, 0)], headers: true, crlf: false, transposed: true, headerColumn: 7, view: stored);
        check(whole >= copied.Text.Length && whole <= copied.Text.Length + 8 && headed >= named.Text.Length && headed <= named.Text.Length + 8,
            "the transposed estimate through a view bounds the text closely (" + whole + " for " + copied.Text.Length + ", " + headed + " for " + named.Text.Length + ")");

        var path = Path.Combine(folder, "view.json");
        var saved = await jobs.ExportAsync(Saved(set, path, "json", viewId: view.ViewId, headerColumn: 0), null);
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        var first = document.RootElement[0];
        check(saved is { Rows: 7, Capped: 0 } && document.RootElement.GetArrayLength() == 8 && string.Join(",", first.EnumerateObject().Select(item => item.Name)) == "Column,18,15,12,9,6,3,0"
            && first.GetProperty("18").GetString() == "18" && document.RootElement[6].GetProperty("Column").GetString() == "active" && document.RootElement[6].GetProperty("9").GetString() == "1"
            && document.RootElement[7].GetProperty("9").ValueKind == JsonValueKind.Null,
            "a transposed JSON save through a view is an object per column, keyed by the header column's values, every value text");

        store.CloseViews(set.ResultId, [view.ViewId]);
        check(await Code(() => TextChecks.Copy(jobs, Turned(set, [Part(0, 0, 0, 0)], viewId: view.ViewId))) == "VIEW_NOT_FOUND" && set.Leases == 0, "a transposed copy through a closed view is VIEW_NOT_FOUND");
    }

    /// <summary>A line longer than a chunk is sent as it is written; a copy stops inside it; a save cancelled between lines
    /// leaves its target; a set still loading copies what it has.</summary>
    private static async Task StreamAsync(Action<bool, string> check, string folder)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var jobs = new ResultJobs(store);
        // Each row's first value is 4,096 characters: the first line alone is some 16 MiB.
        var wide = TextChecks.Synthetic(store, "B1", 5000);
        var args = Turned(wide, [Part(0, End, 0, 1)], headers: true);
        var run = await TextChecks.Copy(jobs, args);
        var lines = Text(run.Text).Split('\n');
        check(run.Chunks.Count > 16 && run.Chunks.SkipLast(1).All(chunk => chunk.Length == ChunkedBuffer.DefaultSize) && lines.Length == 3 && lines[1].Split('\t').Length == Cap + 1
            && lines[1].StartsWith("first\t0000000000", StringComparison.Ordinal) && run.Result is { Rows: Cap, Capped: 5000 - Cap } && run.Result.Bytes == run.Text.Length,
            "a transposed line longer than a chunk streams in 1 MiB chunks (" + run.Chunks.Count + " chunks, " + lines.Length + " lines)");
        // Every report, not only those 250 ms apart: the total is the lines, and the count ends at them, never at rows.
        var reporting = new ResultJobs(store) { ProgressInterval = TimeSpan.Zero };
        var reported = await TextChecks.Copy(reporting, args);
        check(reported.Events.Count > 16 && reported.Events.All(item => item.GetProperty("type").GetString() == "job.progress" && item.GetProperty("rowsTotal").GetInt64() == 2 && item.GetProperty("rowsDone").GetInt64() <= 2)
            && reported.Events[0].GetProperty("rowsDone").GetInt64() == 0 && reported.Events[^1].GetProperty("rowsDone").GetInt64() == 2,
            "a transposed copy's progress counts its lines (" + reported.Events.Count + " events)");
        var saveEvents = new List<JsonElement>();
        using (var context = new RequestContext(3, "results.export", RequestLane.Results, 0, sendEvent: (_, value, _) => { lock (saveEvents) saveEvents.Add(JsonSerializer.SerializeToElement(value, HostChecks.Json)); }))
        {
            var progressed = await reporting.ExportAsync(Saved(TextChecks.Synthetic(store, "W1", 50), Path.Combine(folder, "progress.csv"), "csv"), context);
            check(progressed.Rows == 50 && saveEvents.Count >= 8 && saveEvents.All(item => item.GetProperty("rowsTotal").GetInt64() == 8) && saveEvents[^1].GetProperty("rowsDone").GetInt64() == 8,
                "a transposed save's progress counts its lines (" + saveEvents.Count + " events)");
        }
        check(await Code(() => TextChecks.Copy(jobs, args with { MaxBytes = 1024 * 1024 })) == "TOO_LARGE", "a transposed copy whose estimate is over the limit is refused");

        // Without credit the copy waits inside the first line, where a cancel stops it.
        RequestContext? waiting = null;
        var sent = new List<byte[]>();
        var stalled = TextChecks.Copy(jobs, args, credit: 64 * 1024, grant: false, started: context => waiting = context, chunks: sent);
        var first = SpinWait.SpinUntil(() => { lock (sent) return sent.Count >= 1; }, TimeSpan.FromSeconds(60));
        var early = stalled.IsCompleted;
        waiting!.Cancel(CancelReason.User);
        var stopped = false;
        try { await stalled; } catch (OperationCanceledException) { stopped = true; }
        int sentChunks;
        lock (sent) sentChunks = sent.Count;
        check(first && !early && stopped && sentChunks <= 2 && wide.Leases == 0, "a transposed copy cancelled inside a line stops and ends its lease (" + sentChunks + " chunks sent)");

        // A save cancelled after its first line removes its temporary file and leaves the target as it was.
        var target = Path.Combine(folder, "cancelled.csv");
        File.WriteAllText(target, "old");
        RequestContext? exportContext = null;
        var written = 0;
        var cancelling = new ResultJobs(store) { AfterPage = () => { if (++written == 1) exportContext!.Cancel(CancelReason.User); } };
        using (var context = exportContext = new RequestContext(2, "results.export", RequestLane.Results, 0))
        {
            stopped = false;
            try { await cancelling.ExportAsync(Saved(wide, target, "csv"), context); } catch (OperationCanceledException) { stopped = true; }
            check(stopped && written == 1 && File.ReadAllText(target) == "old" && Directory.GetFiles(folder, ".varia-*.tmp").Length == 0 && wide.Leases == 0,
                "a transposed save cancelled between lines removes its temporary file and leaves the target untouched");
        }

        // A release during a transposed save takes effect when it ends: the stored pages it reads stay until then.
        var releasing = TextChecks.Synthetic(store, "W1", 300);
        var released = false;
        var jobsReleasing = new ResultJobs(store) { AfterPage = () => { if (!released) released = store.Release(releasing.ResultId); } };
        var kept = Path.Combine(folder, "released.txt");
        var result = await jobsReleasing.ExportAsync(Saved(releasing, kept, "tsv"), null);
        check(released && result.Rows == 300 && File.ReadAllText(kept).Split("\r\n")[1].EndsWith("\t298\t299", StringComparison.Ordinal) && store.Find(releasing.ResultId) is null,
            "a result released during a transposed save is written whole, then freed");

        var open = TextChecks.Synthetic(store, "W1", 100, complete: false);
        var partial = await TextChecks.Copy(jobs, Turned(open, [Part(0, End, 0, 0)]));
        check(partial.Result is { Rows: 100, Partial: true, Capped: 0 } && Text(partial.Text).Split('\t').Length == 100, "a transposed copy of a set still loading is partial and ends at its available rows");
        check(await Code(() => jobs.ExportAsync(Saved(open, Path.Combine(folder, "open.csv"), "csv"), null)) == "RESULT_OPEN", "a transposed save of a set still loading is refused (RESULT_OPEN)");
    }

    private static async Task EstimatesAsync(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var jobs = new ResultJobs(store);
        var sets = new[] { TextChecks.Synthetic(store, "N1", 600), TextChecks.Synthetic(store, "W1", 600) };
        var random = new Random(11);
        var below = new List<string>();
        long tightest = long.MaxValue;
        for (var i = 0; i < 300; i++)
        {
            var set = sets[i % 2];
            var columns = set.Columns.Count;
            var parts = Enumerable.Range(0, random.Next(1, 4)).Select(_ =>
            {
                long row = random.Next(0, 100);
                var rows = new List<long[]>();
                for (var r = random.Next(1, 4); r > 0 && row < 700; r--)
                {
                    var last = random.Next(4) == 0 ? End : row + random.Next(0, 200);
                    rows.Add([row, last]);
                    if (last == End) break;
                    row = last + 1 + random.Next(0, 100);
                }
                var first = random.Next(0, columns);
                return new CopyPartArgs([.. rows], [[first, Math.Min(columns - 1, first + random.Next(0, 4))]]);
            }).ToArray();
            var headers = random.Next(2) == 0;
            int? header = random.Next(3) == 0 ? random.Next(0, columns) : null;
            var estimate = ResultJobs.EstimateCopy(set, parts, headers, crlf: i % 4 == 0, transposed: true, headerColumn: header);
            var run = await TextChecks.Copy(jobs, Turned(set, parts, headers, headerColumn: header) with { Eol = i % 4 == 0 ? "crlf" : "lf" });
            if (estimate < run.Text.Length) below.Add(i + ": " + estimate + " < " + run.Text.Length);
            if (run.Text.Length > 0) tightest = Math.Min(tightest, estimate * 100 / run.Text.Length);
        }
        check(below.Count == 0, "the transposed copy estimate is at least the text written for 300 random part sets (tightest " + tightest + " %)" + (below.Count == 0 ? "" : ": " + string.Join(", ", below.Take(5))));
    }

    /// <summary>A header column of one value names 4,095 fields without trying every suffix for each, and distinct names
    /// stay distinct once tab-separated text has turned their tabs and line breaks into spaces.</summary>
    private static void Names(Action<bool, string> check)
    {
        var names = ResultTextWriter.UniqueFields([.. Enumerable.Repeat("NULL", Cap), "NULL_3", "Column", "NULL"]);
        check(names[0] == "NULL" && names[1] == "NULL_2" && names[Cap - 1] == "NULL_" + Cap && names[Cap] == "NULL_3_2" && names[Cap + 1] == "Column_2" && names[Cap + 2] == "NULL_" + (Cap + 1)
            && names.Distinct(StringComparer.Ordinal).Count() == names.Length, "repeated field names are numbered in order, past the names already used");
        // Quadratic, this is 800 million tries; linear, a few hundred thousand. The limit is far above either machine's noise.
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var many = ResultTextWriter.UniqueFields([.. Enumerable.Repeat(new string('x', 128), 40_000)]);
        check(many[^1] == new string('x', 128) + "_40000" && watch.Elapsed < TimeSpan.FromSeconds(20), "numbering a repeated name does not start over for each repeat (" + watch.ElapsedMilliseconds + " ms for 40,000)");

        var builder = new PageBuilder(1, [WireKind.Text], 0);
        foreach (var value in new[] { "a\tb", "a b", "x\r\ny", "x\ny\0", "x y " })
        {
            builder.BeginRow();
            builder.AppendText(value);
            builder.CommitRow();
        }
        var page = PageView.Parse(builder.Seal(), 1);
        var read = new string[5];
        for (var row = 0; row < read.Length; row++) read[row] = ResultTextWriter.FieldName(page, row, 0);
        var fields = ResultTextWriter.UniqueFields(read);
        check(string.Join("|", fields) == "a b|a b_2|x y|x y |x y _2", "a tab, line break or NUL in a field name is a space before the names are made distinct (" + string.Join("|", fields) + ")");
    }

    /// <summary>A header column comes only with Transposed and is a shown column of the result; a hidden column is no line.</summary>
    private static async Task RequestsAsync(Action<bool, string> check, string folder)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var jobs = new ResultJobs(store);
        var set = TextChecks.Synthetic(store, "W1", 10);
        var path = Path.Combine(folder, "requests.csv");
        var copy = Turned(set, [Part(0, 1, 0, 0)]);
        var codes = new[]
        {
            await Code(() => TextChecks.Copy(jobs, copy with { Transposed = false, HeaderColumn = 0 })),
            await Code(() => TextChecks.Copy(jobs, copy with { HeaderColumn = -1 })),
            await Code(() => TextChecks.Copy(jobs, copy with { HeaderColumn = 8 })),
            await Code(() => TextChecks.Copy(jobs, copy with { HeaderColumn = PageBuilder.MaxColumns })),
            await Code(() => jobs.ExportAsync(Saved(set, path, "csv") with { Transposed = false, HeaderColumn = 0 }, null)),
            await Code(() => jobs.ExportAsync(Saved(set, path, "csv", headerColumn: 8), null)),
            await Code(() => jobs.ExportAsync(Saved(set, path, "csv", headerColumn: -1), null))
        };
        check(codes.All(code => code == "INVALID_PARAMS") && !File.Exists(path) && set.Leases == 0,
            "a header column without transposed, or one that is no column of the result, is refused: " + string.Join(" | ", codes));

        // A live table's row tone is never text: not a line, and not a header column.
        ResultColumn[] columns = [new("name", "nvarchar(20)", "text"), new("value", "int", "text"), new("tone", "int", "text", Role: "tone")];
        var toned = store.Open(store.BeginQuery(Guid.NewGuid().ToString()), 0, 1, 1, "rows", columns, [.. columns.Select(TextChecks.WireOf)]) ?? throw new InvalidOperationException("The set was not kept.");
        foreach (var (name, value) in new[] { ("a", "1"), ("b", "2") })
        {
            toned.CountRow();
            var builder = toned.BeginRow() ?? throw new InvalidOperationException("The row was not stored.");
            builder.AppendText(name);
            builder.AppendText(value);
            builder.AppendText("3");
            toned.TryCommitRow();
        }
        toned.Complete();
        var saved = await jobs.ExportAsync(Saved(toned, path, "csv", headerColumn: 0), null);
        var copied = await TextChecks.Copy(jobs, Turned(toned, [Part(0, End, 0, 2)]));
        check(saved.Rows == 2 && File.ReadAllText(path) == "Column,a,b\r\nname,a,b\r\nvalue,1,2\r\n" && Text(copied.Text) == "a\tb\n1\t2"
            && await Code(() => jobs.ExportAsync(Saved(toned, path, "csv", headerColumn: 2), null)) == "INVALID_PARAMS",
            "a hidden tone column is neither a line nor a header column of transposed text");
    }
}
