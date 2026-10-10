using System.Buffers;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of Copy and Save Results As: the golden text of tests/fixtures/results-text/cases.json (which
/// the fake backend's text-writer.mjs must also match), PageView against the independent PageReader, the copy estimate,
/// the copy stream and export file jobs, leases, FOR XML collection and the descriptor bounds.</summary>
internal static class TextChecks
{
    private const long End = ResultJobs.MaxSafeInteger;

    public static async Task RunAsync(Action<bool, string> check)
    {
        await Goldens(check);
        PageViews(check);
        await Estimates(check);
        await CopyStream(check);
        await Export(check);
        ForXml(check);
        Descriptors(check);
        Allocation(check);
    }

    internal static WireKind WireOf(ResultColumn column) => column.Wire == "binary" ? WireKind.Binary : WireKind.Text;

    /// <summary>A stored set from cells as cases.json writes them, sealed every <paramref name="rowsPerPage"/> rows so the
    /// jobs cross page boundaries.</summary>
    private static ResultSetBuffer Build(ResultStore store, IReadOnlyList<ResultColumn> columns, IReadOnlyList<JsonElement[]> rows, int rowsPerPage = 2, bool complete = true)
    {
        var set = store.Open(store.BeginQuery(Guid.NewGuid().ToString()), 0, 1, 1, "rows", columns, [.. columns.Select(WireOf)]) ?? throw new InvalidOperationException("The set was not kept.");
        for (var r = 0; r < rows.Count; r++)
        {
            set.CountRow();
            var builder = set.BeginRow() ?? throw new InvalidOperationException("The row was not stored.");
            var truncated = 0;
            foreach (var cell in rows[r])
            {
                if (cell.ValueKind == JsonValueKind.Null) builder.AppendNull();
                else if (cell.ValueKind == JsonValueKind.String) builder.AppendText(cell.GetString());
                else if (cell.TryGetProperty("error", out _)) builder.AppendNull(error: true);
                else
                {
                    var cut = cell.TryGetProperty("truncated", out _);
                    if (cut) truncated++;
                    if (cell.TryGetProperty("hex", out var hex)) builder.AppendBinary(Convert.FromHexString(hex.GetString()!), cut);
                    else builder.AppendText(cell.GetProperty("text").GetString(), cut);
                }
            }
            set.TryCommitRow(truncated);
            if ((r + 1) % rowsPerPage == 0) set.Seal();
        }
        if (complete) set.Complete();
        else set.Seal();
        return set;
    }

    private static ResultSetBuffer Synthetic(ResultStore store, string shape, long rows, bool complete = true)
    {
        var columns = SyntheticRows.Columns(shape);
        var set = store.Open(store.BeginQuery(Guid.NewGuid().ToString()), 0, 1, 1, "rows",
            [.. columns.Select(column => new ResultColumn(column.Name, column.DataType, column.Wire == WireKind.Text ? "text" : "binary", column.Role))], [.. columns.Select(column => column.Wire)])
            ?? throw new InvalidOperationException("The set was not kept.");
        for (long row = 0; row < rows; row++)
        {
            set.CountRow();
            var builder = set.BeginRow() ?? throw new InvalidOperationException("The row was not stored.");
            SyntheticRows.WriteCells(shape, row, builder);
            set.TryCommitRow();
        }
        if (complete) set.Complete();
        else set.Seal();
        return set;
    }

    internal sealed record CopyRun(byte[] Text, ResultsJobResult Result, List<byte[]> Chunks, List<JsonElement> Events);

    /// <summary>Runs results.copy as the host would, granting back what each DATA frame used unless told not to.</summary>
    /// <param name="chunks">Receives each DATA body as it is sent, for checks made while the copy waits.</param>
    internal static async Task<CopyRun> Copy(ResultJobs jobs, ResultsCopyArgs args, long credit = 16 * 1024 * 1024, bool grant = true, Action<RequestContext>? started = null, List<byte[]>? chunks = null)
    {
        chunks ??= [];
        var events = new List<JsonElement>();
        using var context = new RequestContext(1, "results.copy", RequestLane.Results, 0, credit,
            sendData: (owner, _, body) => { lock (chunks) chunks.Add(body); if (grant) owner.Grant((uint)body.Length); },
            sendEvent: (_, value, _) => { lock (events) events.Add(JsonSerializer.SerializeToElement(value, HostChecks.Json)); });
        var running = jobs.CopyAsync(args, context);
        started?.Invoke(context);
        var result = await running;
        lock (chunks) return new CopyRun([.. chunks.SelectMany(chunk => chunk)], result, [.. chunks], events);
    }

    private static CopyPartArgs Part(long first, long last, int firstColumn, int lastColumn) => new([[first, last]], [[firstColumn, lastColumn]]);

    private static CopyPartArgs PartOf(JsonElement part) => new(
        [.. part.GetProperty("rows").EnumerateArray().Select(range => new[] { range[0].GetInt64(), range[1].GetInt64() })],
        [.. part.GetProperty("columns").EnumerateArray().Select(range => new[] { range[0].GetInt32(), range[1].GetInt32() })]);

    private static string Show(string text) => JsonSerializer.Serialize(text.Length > 300 ? text[..300] + "…" : text);

    private static async Task Goldens(Action<bool, string> check)
    {
        using var fixture = JsonDocument.Parse(File.ReadAllText(Fixtures.Path("tests/fixtures/results-text/cases.json")));
        var failures = new List<string>();
        var count = 0;
        var folder = Directory.CreateTempSubdirectory("varia-text-");
        try
        {
            foreach (var item in fixture.RootElement.GetProperty("cases").EnumerateArray())
            {
                var store = new ResultStore(1L << 30, 1L << 29);
                var jobs = new ResultJobs(store);
                var columns = item.GetProperty("columns").EnumerateArray().Select(column => new ResultColumn(column.GetProperty("name").GetString()!, column.GetProperty("dataType").GetString()!, column.GetProperty("wire").GetString()!)).ToList();
                var rows = item.GetProperty("rows").EnumerateArray().Select(row => row.EnumerateArray().ToArray()).ToList();
                var set = Build(store, columns, rows);
                var name = item.GetProperty("name").GetString();
                foreach (var copy in item.GetProperty("copy").EnumerateArray())
                {
                    count++;
                    var run = await Copy(jobs, new ResultsCopyArgs(set.ResultId, [.. copy.GetProperty("parts").EnumerateArray().Select(PartOf)], copy.GetProperty("headers").GetBoolean(), copy.GetProperty("eol").GetString()!, ResultJobs.MaxCopyBytes));
                    var expected = copy.GetProperty("expected").GetString()!;
                    var actual = Encoding.UTF8.GetString(run.Text);
                    if (actual != expected || run.Result.Rows != copy.GetProperty("rows").GetInt64() || run.Result.TruncatedCells != copy.GetProperty("truncatedCells").GetInt64() || run.Result.Bytes != run.Text.Length || run.Result.Partial)
                        failures.Add(name + " / copy " + copy.GetProperty("name").GetString() + ": " + Show(actual) + " (" + run.Result + ")");
                }
                foreach (var save in item.GetProperty("save").EnumerateArray())
                {
                    count++;
                    var path = Path.Combine(folder.FullName, "golden-" + count + ".out");
                    var result = await jobs.ExportAsync(new ResultsExportArgs(set.ResultId, path, save.GetProperty("format").GetString()!, save.GetProperty("headers").GetBoolean(), save.GetProperty("nullText").GetString()!, Guid.NewGuid().ToString("N")), null);
                    var bytes = File.ReadAllBytes(path);
                    var expected = Encoding.UTF8.GetBytes(save.GetProperty("expected").GetString()!);
                    if (!bytes.AsSpan().SequenceEqual(expected) || result.Rows != save.GetProperty("rows").GetInt64() || result.TruncatedCells != save.GetProperty("truncatedCells").GetInt64() || result.Bytes != bytes.Length)
                        failures.Add(name + " / save " + save.GetProperty("format").GetString() + ": " + Show(Encoding.UTF8.GetString(bytes)) + " (" + result + ")");
                }
                check(store.UsedBytes > 0 && set.Leases == 0, "jobs end their leases (" + name + ")");
            }
        }
        finally { folder.Delete(true); }
        check(count >= 15 && failures.Count == 0, "Copy and Save write the golden text of every cases.json case (" + count + ")" + (failures.Count == 0 ? "" : ": " + string.Join(" | ", failures)));
    }

    /// <summary>PageView reads what PageReader (written independently, with every validity check) reads.</summary>
    private static void PageViews(Action<bool, string> check)
    {
        var mismatches = new List<string>();
        var pages = 0;
        void Compare(byte[] page, IReadOnlyList<WireKind> wires, string label)
        {
            pages++;
            var oracle = PageReader.Read(page, wires);
            var view = PageView.Parse(page, wires.Count);
            if (view.Rows != oracle.Rows.Length || view.FirstRow != oracle.FirstRow) { mismatches.Add(label + " header"); return; }
            for (var row = 0; row < view.Rows; row++)
                for (var column = 0; column < wires.Count; column++)
                {
                    var cell = oracle.Rows[row][column];
                    var span = view.Span(column, row);
                    var text = view.IsNull(column, row) ? null : view.Wire(column) == WireKind.Text ? Encoding.UTF8.GetString(span) : "0x" + Convert.ToHexString(span);
                    var flags = (view.IsNull(column, row) ? PageReader.Null : 0) | (view.IsTruncated(column, row) ? PageReader.Truncated : 0) | (view.IsError(column, row) ? PageReader.Error : 0);
                    if (text != cell.Text || flags != cell.Flags) { mismatches.Add(label + " r" + row + "c" + column); return; }
                }
            var nulls = 0;
            for (var column = 0; column < wires.Count; column++) nulls += view.NullCount(column, 0, view.Rows - 1);
            if (nulls != oracle.Rows.Sum(row => row.Count(cell => (cell.Flags & PageReader.Null) != 0))) mismatches.Add(label + " null count");
        }
        foreach (var name in new[] { "w1", "n1", "b1", "wide" })
        {
            using var described = JsonDocument.Parse(File.ReadAllText(Fixtures.Path("tests/fixtures/pages/" + name + ".json")));
            var wires = described.RootElement.GetProperty("columns").EnumerateArray().Select(column => column.GetProperty("wire").GetString() == "binary" ? WireKind.Binary : WireKind.Text).ToList();
            Compare(File.ReadAllBytes(Fixtures.Path("tests/fixtures/pages/" + name + ".page")), wires, name);
        }
        var random = new Random(20261009);
        string[] shapes = ["W1", "N1", "B1", "X1", "M1"];
        while (pages < 1004)
        {
            var shape = shapes[random.Next(shapes.Length)];
            var wires = SyntheticRows.Columns(shape).Select(column => column.Wire).ToList();
            foreach (var page in SyntheticRows.Pages(shape, (uint)random.Next(1, int.MaxValue), random.NextInt64(0, 5_000_000), random.Next(1, shape == "X1" ? 80 : 300)).Take(2))
                Compare(page, wires, shape);
        }
        check(mismatches.Count == 0, "PageView reads the golden pages and " + (pages - 4) + " synthetic pages exactly as the independent PageReader does" + (mismatches.Count == 0 ? "" : ": " + string.Join(", ", mismatches.Take(5))));
    }

    /// <summary>The estimate is an upper bound on the text Copy writes, so TOO_LARGE never refuses a copy that would fit.</summary>
    private static async Task Estimates(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var jobs = new ResultJobs(store);
        var sets = new[] { Synthetic(store, "N1", 3000), Synthetic(store, "W1", 3000) };
        var random = new Random(7);
        var below = new List<string>();
        long tightest = long.MaxValue;
        for (var i = 0; i < 1000; i++)
        {
            var set = sets[i % 2];
            var columns = set.Columns.Count;
            var parts = Enumerable.Range(0, random.Next(1, 4)).Select(_ =>
            {
                long row = random.Next(0, 200);
                var rows = new List<long[]>();
                for (var r = random.Next(1, 4); r > 0 && row < 3200; r--)
                {
                    var last = random.Next(4) == 0 ? End : row + random.Next(0, 1500);
                    rows.Add([row, last]);
                    if (last == End) break;
                    row = last + 1 + random.Next(0, 200);
                }
                var columnRanges = new List<int[]>();
                for (var c = random.Next(0, columns); c < columns && columnRanges.Count < 3;)
                {
                    var last = Math.Min(columns - 1, c + random.Next(0, 3));
                    columnRanges.Add([c, last]);
                    c = last + 1 + random.Next(0, 2);
                }
                return new CopyPartArgs([.. rows], [.. columnRanges]);
            }).ToArray();
            var headers = random.Next(2) == 0;
            var crlf = random.Next(2) == 0;
            var estimate = ResultJobs.EstimateCopy(set, parts, headers, crlf);
            var run = await Copy(jobs, new ResultsCopyArgs(set.ResultId, parts, headers, crlf ? "crlf" : "lf", ResultJobs.MaxCopyBytes));
            if (estimate < run.Text.Length) below.Add(i + ": " + estimate + " < " + run.Text.Length);
            if (run.Text.Length > 0) tightest = Math.Min(tightest, estimate * 100 / run.Text.Length);
        }
        check(below.Count == 0, "the copy estimate is at least the text written for 1,000 random part sets (tightest " + tightest + " %)" + (below.Count == 0 ? "" : ": " + string.Join(", ", below.Take(5))));
    }

    private static async Task CopyStream(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var jobs = new ResultJobs(store);
        var large = Synthetic(store, "W1", 60_000);
        var all = new ResultsCopyArgs(large.ResultId, [Part(0, End, 0, 7)], false, "lf", ResultJobs.MaxCopyBytes);
        var run = await Copy(jobs, all);
        var lines = Encoding.UTF8.GetString(run.Text).Split('\n');
        check(run.Chunks.Count > 4 && run.Chunks.All(chunk => chunk.Length <= ChunkedBuffer.DefaultSize) && run.Chunks.SkipLast(1).All(chunk => chunk.Length == ChunkedBuffer.DefaultSize)
            && lines.Length == 60_000 && lines[0].StartsWith("0\tCustomer 0000000000 GmbH\t") && run.Result is { Rows: 60_000, Partial: false } && run.Result.Bytes == run.Text.Length,
            "copy streams its text in DATA chunks of 1 MiB (" + run.Chunks.Count + " chunks for " + run.Text.Length / 1024 + " KiB)");
        // Credit: a stream sends while its credit is positive, so it overdraws by at most one chunk, then waits.
        RequestContext? waiting = null;
        var sent = new List<byte[]>();
        var stalled = Copy(jobs, all, credit: 64 * 1024, grant: false, started: context => waiting = context, chunks: sent);
        await Task.Delay(300);
        var early = stalled.IsCompleted;
        int sentEarly;
        lock (sent) sentEarly = sent.Count;
        waiting!.Grant(64 * 1024 * 1024);
        waiting.Grant(64 * 1024 * 1024);
        run = await stalled;
        check(!early && sentEarly == 1 && run.Result.Rows == 60_000, "copy waits for credit after overdrawing it by at most one chunk (" + sentEarly + " sent on 64 KiB)");
        check(run.Events.Count >= 1 && run.Events.All(item => item.GetProperty("type").GetString() == "job.progress" && item.GetProperty("rowsTotal").GetInt64() == 60_000
            && item.GetProperty("rowsDone").GetInt64() <= 60_000 && item.GetProperty("bytes").GetInt64() <= run.Text.Length), "a copy that runs past 250 ms reports job.progress against its total (" + run.Events.Count + " events)");

        string? Code(Func<Task> action)
        {
            try { action().GetAwaiter().GetResult(); return null; }
            catch (RequestException error) { return error.Code + ": " + error.Message; }
        }
        var tooLarge = Code(() => Copy(jobs, all with { MaxBytes = 1024 * 1024 }));
        check(tooLarge?.StartsWith("TOO_LARGE: The selection is too large to copy (") == true && tooLarge.Contains("the limit is 1 MB). Use Save Results As instead."),
            "a copy whose estimate is over the limit is refused before any DATA: " + tooLarge);

        // An open set is copied as far as it is stored; open-ended rows end at the rows available now.
        var open = Synthetic(store, "W1", 1000, complete: false);
        run = await Copy(jobs, new ResultsCopyArgs(open.ResultId, [Part(0, End, 0, 0)], true, "crlf", ResultJobs.MaxCopyBytes));
        check(run.Result is { Rows: 1000, Partial: true } && Encoding.UTF8.GetString(run.Text).Split("\r\n").Length == 1001, "copying a set still loading is partial and ends at its available rows");

        var invalid = new List<string?>
        {
            Code(() => Copy(jobs, all with { Parts = [] })),
            Code(() => Copy(jobs, all with { Parts = [new([[5, 4]], [[0, 0]])] })),
            Code(() => Copy(jobs, all with { Parts = [new([[0, 4], [3, 9]], [[0, 0]])] })),
            Code(() => Copy(jobs, all with { Parts = [Part(0, 1, 0, 8)] })),
            Code(() => Copy(jobs, all with { Parts = [new([[0, End + 1]], [[0, 0]])] })),
            Code(() => Copy(jobs, all with { Eol = "cr" })),
            Code(() => Copy(jobs, all with { MaxBytes = ResultJobs.MaxCopyBytes + 1 })),
            Code(() => Copy(jobs, all with { ResultId = 999_999 }))
        };
        check(invalid.Take(7).All(code => code?.StartsWith("INVALID_PARAMS") == true) && invalid[7]?.StartsWith("RESULT_NOT_FOUND") == true,
            "copy rejects empty, reversed, overlapping and out-of-range ranges, a bad end of line or limit, and unknown results: " + string.Join(" | ", invalid));
        try { await jobs.CopyAsync(all, null); check(false, "a copy without a stream ran"); }
        catch (RequestException error) { check(error.Code == "INVALID_REQUEST", "copy is a stream request"); }

        // Cancel: the job stops at the next page and ends its lease.
        var cancelled = Copy(jobs, all, credit: 64 * 1024, grant: false, started: context => waiting = context);
        await Task.Delay(100);
        waiting!.Cancel(CancelReason.User);
        try { await cancelled; check(false, "a cancelled copy finished"); }
        catch (OperationCanceledException) { check(large.Leases == 0, "a cancelled copy stops and ends its lease"); }
    }

    private static async Task Export(Action<bool, string> check)
    {
        var folder = Directory.CreateTempSubdirectory("varia-export-");
        try
        {
            var store = new ResultStore(1L << 30, 1L << 29);
            var jobs = new ResultJobs(store);
            var set = Synthetic(store, "W1", 1000);
            string[] Leftovers() => [.. Directory.GetFiles(folder.FullName, ".varia-*.tmp")];
            var target = Path.Combine(folder.FullName, "out.csv");
            File.WriteAllText(target, "old");
            var result = await jobs.ExportAsync(new ResultsExportArgs(set.ResultId, target, "csv", true, "empty", Guid.NewGuid().ToString("N")), null);
            // ReadAllText would drop the BOM.
            var lines = Encoding.UTF8.GetString(File.ReadAllBytes(target)).Split("\r\n");
            check(result is { Rows: 1000, Partial: false } && lines.Length == 1002 && lines[0] == "\uFEFFid,name,created,amount,key,note,active,score" && lines[^1] == "" && Leftovers().Length == 0
                && result.Bytes == new FileInfo(target).Length, "export writes a temporary file and renames it over the target (" + result.Bytes + " bytes)");
            if (!OperatingSystem.IsWindows())
            {
                // A replaced file keeps its permissions, private or group-writable, whatever the umask; a new one gets the default.
                var modes = new List<string>();
                foreach (var mode in new[] { UnixFileMode.UserRead | UnixFileMode.UserWrite, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead | UnixFileMode.GroupWrite })
                {
                    File.SetUnixFileMode(target, mode);
                    await jobs.ExportAsync(new ResultsExportArgs(set.ResultId, target, "csv", true, "empty", Guid.NewGuid().ToString("N")), null);
                    modes.Add(Convert.ToString((int)File.GetUnixFileMode(target), 8));
                }
                var fresh = Path.Combine(folder.FullName, "fresh.csv");
                await jobs.ExportAsync(new ResultsExportArgs(set.ResultId, fresh, "csv", true, "empty", Guid.NewGuid().ToString("N")), null);
                var freshMode = File.GetUnixFileMode(fresh);
                File.Delete(fresh);
                check(modes.SequenceEqual(["600", "660"]) && (freshMode & UnixFileMode.UserRead) != 0 && Leftovers().Length == 0,
                    "an export over an existing file keeps its permissions (" + string.Join(", ", modes) + "), and a new file gets the default (" + Convert.ToString((int)freshMode, 8) + ")");
                // A symbolic link to a private file is replaced by a file no more readable than the one it pointed to.
                var hidden = Path.Combine(folder.FullName, "private.csv");
                var link = Path.Combine(folder.FullName, "link.csv");
                File.WriteAllText(hidden, "private");
                File.SetUnixFileMode(hidden, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                File.CreateSymbolicLink(link, hidden);
                await jobs.ExportAsync(new ResultsExportArgs(set.ResultId, link, "csv", true, "empty", Guid.NewGuid().ToString("N")), null);
                var linkInfo = new FileInfo(link);
                var linkMode = File.GetUnixFileMode(link);
                check(linkInfo.LinkTarget is null && linkInfo.Length == result.Bytes && File.ReadAllText(hidden) == "private" && linkMode == (UnixFileMode.UserRead | UnixFileMode.UserWrite),
                    "an export over a link to a private file replaces the link with a file as private (" + Convert.ToString((int)linkMode, 8) + ")");
                File.Delete(link);
                File.Delete(hidden);
            }

            // The temporary file has the name main chose, so main can remove it if the backend dies while writing.
            var named = Guid.NewGuid().ToString("N");
            var seenName = false;
            var naming = new ResultJobs(store) { AfterPage = () => seenName = File.Exists(Path.Combine(folder.FullName, ".varia-" + named + ".tmp")) };
            await naming.ExportAsync(new ResultsExportArgs(set.ResultId, target, "csv", true, "empty", named), null);
            check(seenName && Leftovers().Length == 0, "an export writes .varia-{temporaryId}.tmp beside the target, then renames it");

            // ReplaceFile (Windows) keeps a backup until the replace succeeds: a failure leaves the old file or puts the new one in place.
            var replaced = Path.Combine(folder.FullName, "replaced.csv");
            var fresher = Path.Combine(folder.FullName, ".varia-new.tmp");
            var backup = Path.Combine(folder.FullName, ".varia-new.bak");
            string Outcome(Action<string, string, string?> replace)
            {
                File.WriteAllText(replaced, "old");
                File.WriteAllText(fresher, "new");
                string? failure = null;
                try { ResultJobs.ReplaceFile(fresher, replaced, backup, replace); } catch (IOException) { failure = "failed"; }
                var outcome = (failure ?? "ok") + ":" + (File.Exists(replaced) ? File.ReadAllText(replaced) : "none") + ":" + (File.Exists(backup) ? "backup" : "") + (File.Exists(fresher) ? "temporary" : "");
                File.Delete(fresher);
                File.Delete(backup);
                return outcome;
            }
            var outcomes = new[]
            {
                Outcome((source, path, copy) => { File.Move(path, copy!); File.Move(source, path); }),
                // ERROR_UNABLE_TO_REPLACE: nothing moved.
                Outcome((_, _, _) => throw new IOException("1175")),
                // ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: the original went to the backup name, the new file stayed put.
                Outcome((_, path, copy) => { File.Move(path, copy!); throw new IOException("1177"); }),
                // The same, and the new file cannot be moved either: the original comes back.
                Outcome((source, path, copy) => { File.Move(path, copy!); File.Delete(source); throw new IOException("1177"); })
            };
            check(outcomes.SequenceEqual(["ok:new:", "failed:old:temporary", "ok:new:", "failed:old:"]),
                "a replace that fails keeps the old file or puts the new one in place, never neither: " + string.Join(", ", outcomes));

            string? Code(ResultsExportArgs args, RequestContext? context = null)
            {
                try { jobs.ExportAsync(args, context).GetAwaiter().GetResult(); return null; }
                catch (RequestException error) { return error.Code + ":" + error.Message; }
            }
            var args = new ResultsExportArgs(set.ResultId, target, "tsv", true, "NULL", Guid.NewGuid().ToString("N"));
            var codes = new[]
            {
                Code(args with { Path = "relative.csv" }), Code(args with { Path = Path.Combine(folder.FullName, "nul\0.csv") }), Code(args with { Path = @"\\.\pipe\x" }),
                Code(args with { Path = @"\\?\C:\x.csv" }), Code(args with { Path = "//./pipe/x" }), Code(args with { Path = new string('a', 32_768) }),
                Code(args with { Format = "xlsx" }), Code(args with { NullText = "null" })
            };
            check(codes.All(code => code == "INVALID_PARAMS:The export request is invalid."), "export rejects relative, NUL, device and extended paths, unknown formats and NULL texts: " + string.Join(" | ", codes));
            var missing = Code(args with { Path = Path.Combine(folder.FullName, "missing", "x.csv") });
            var directory = Code(args with { Path = folder.FullName });
            check(missing == "EXPORT_FAILED:NOT_FOUND" && directory == "EXPORT_FAILED:IS_DIRECTORY" && Leftovers().Length == 0,
                "a missing folder and a folder target fail with one token each, never a path: " + missing + ", " + directory);
            var open = Synthetic(store, "W1", 10, complete: false);
            check(Code(args with { ResultId = open.ResultId }) == "RESULT_OPEN:Save the results after this result set finishes loading." && open.Leases == 0,
                "exporting a set still loading is refused (RESULT_OPEN)");

            // Cancel mid-write: the temporary file is removed and an existing target is left as it was.
            var big = Synthetic(store, "W1", 300_000);
            File.WriteAllText(target, "old");
            RequestContext? exportContext = null;
            var pagesWritten = 0;
            var temporarySeen = false;
            var cancelling = new ResultJobs(store) { AfterPage = () => { if (++pagesWritten == 3) { temporarySeen = Leftovers().Length == 1; exportContext!.Cancel(CancelReason.User); } } };
            using (var context = exportContext = new RequestContext(2, "results.export", RequestLane.Results, 0))
            {
                var stopped = false;
                try { await cancelling.ExportAsync(new ResultsExportArgs(big.ResultId, target, "json", false, "NULL", Guid.NewGuid().ToString("N")), context); } catch (OperationCanceledException) { stopped = true; }
                check(stopped && temporarySeen && pagesWritten == 3 && File.ReadAllText(target) == "old" && Leftovers().Length == 0 && big.Leases == 0,
                    "an export cancelled mid-write removes its temporary file and leaves the target untouched");
            }

            // A release during an export takes effect when it ends: the file is complete and the memory comes back.
            var json = Path.Combine(folder.FullName, "all.json");
            var released = false;
            long during = 0;
            var releasing = new ResultJobs(store) { AfterPage = () => { if (!released) { released = store.Release(big.ResultId); during = store.UsedBytes; } } };
            var watch = Stopwatch.StartNew();
            result = await releasing.ExportAsync(new ResultsExportArgs(big.ResultId, json, "json", true, "NULL", Guid.NewGuid().ToString("N")), null);
            var seconds = watch.Elapsed.TotalSeconds;
            using (var document = JsonDocument.Parse(File.ReadAllBytes(json)))
                check(released && during > 0 && result.Rows == 300_000 && document.RootElement.GetArrayLength() == 300_000 && big.Leases == 0 && store.Find(big.ResultId) is null,
                    "an export leases its result: released while it runs, it still writes every row (" + result.Bytes / 1048576 + " MB in " + seconds.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture) + " s)");
            store.Release(set.ResultId);
            store.Release(open.ResultId);
            check(store.UsedBytes == 0, "once the export ends, the released result's memory is returned");

            // A folder the process may not write: ACCESS, and nothing left behind (root bypasses permissions, so it is skipped).
            if (!OperatingSystem.IsWindows())
            {
                var locked = Directory.CreateDirectory(Path.Combine(folder.FullName, "locked"));
                File.SetUnixFileMode(locked.FullName, UnixFileMode.UserRead | UnixFileMode.UserExecute);
                var writable = true;
                try { File.WriteAllText(Path.Combine(locked.FullName, "probe"), ""); } catch (UnauthorizedAccessException) { writable = false; }
                if (writable) Console.WriteLine("Export ACCESS check skipped: this user can write a read-only folder (root).");
                else
                {
                    var small = Synthetic(store, "W1", 5);
                    check(Code(new ResultsExportArgs(small.ResultId, Path.Combine(locked.FullName, "x.csv"), "csv", true, "empty", Guid.NewGuid().ToString("N"))) == "EXPORT_FAILED:ACCESS" && locked.GetFiles().Length == 0,
                        "an export to a read-only folder fails with ACCESS and leaves nothing behind");
                    store.Release(small.ResultId);
                }
                File.SetUnixFileMode(locked.FullName, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }
        }
        finally { folder.Delete(true); }

        string Token(Exception error) => ResultJobs.ExportToken(error);
        IOException Io(int result) => new("x") { HResult = result };
        var tokens = new[]
        {
            Token(new UnauthorizedAccessException()), Token(Io(unchecked((int)0x80070005))), Token(Io(unchecked((int)0x80070020))), Token(Io(unchecked((int)0x80070021))),
            Token(Io(unchecked((int)0x80070070))), Token(Io(unchecked((int)0x80070027))), Token(new DirectoryNotFoundException()), Token(new IOException("x")), Token(new PathTooLongException())
        };
        check(tokens.SequenceEqual(["ACCESS", "ACCESS", "IN_USE", "IN_USE", "DISK_FULL", "DISK_FULL", "NOT_FOUND", "IO", "IO"])
            && Token(Io(28)) == (OperatingSystem.IsWindows() ? "IO" : "DISK_FULL"), "export failures map to one token each: " + string.Join(", ", tokens));
    }

    /// <summary>FOR XML and FOR JSON output arrives in rows of about 2,033 characters, joined into one value up to the cap.</summary>
    private static void ForXml(Action<bool, string> check)
    {
        check(ForXmlCollector.RoleOf(ForXmlCollector.XmlColumn, (int)System.Data.SqlDbType.NText) == "xml" && ForXmlCollector.RoleOf(ForXmlCollector.JsonColumn, (int)System.Data.SqlDbType.NVarChar) == "json"
            && ForXmlCollector.RoleOf(ForXmlCollector.XmlColumn, (int)System.Data.SqlDbType.Xml) is null && ForXmlCollector.RoleOf("XML_F52E2B61-18A1-11d1-B105-00805F49916b", (int)System.Data.SqlDbType.NText) is null,
            "FOR XML and FOR JSON are recognised by their exact column name and a text type");
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("for xml");
        var chunk = string.Concat(Enumerable.Repeat("<row a=\"1\"/>", 200))[..2033];
        string written;
        bool cut;
        using (var collector = new ForXmlCollector(store, budget))
        {
            for (var i = 0; i < 5; i++) collector.Append(chunk);
            var builder = new PageBuilder(1, [WireKind.Text]);
            builder.BeginRow();
            cut = collector.Write(builder);
            builder.CommitRow();
            written = PageReader.Read(builder.Seal(), [WireKind.Text]).Rows[0][0].Text!;
            check(collector.Rows == 5 && !cut && written == string.Concat(Enumerable.Repeat(chunk, 5)) && store.UsedBytes >= 2 * written.Length, "five chunks are joined into one value, reserved from the budget");
        }
        check(store.UsedBytes == 0, "the collector returns its reservation");
        using (var collector = new ForXmlCollector(store, budget))
        {
            for (var i = 0; i < 1100; i++) collector.Append(chunk);
            var builder = new PageBuilder(1, [WireKind.Text]);
            builder.BeginRow();
            cut = collector.Write(builder);
            builder.CommitRow();
            var cell = PageReader.Read(builder.Seal(), [WireKind.Text]).Rows[0][0];
            check(collector.Rows == 1100 && cut && collector.Truncated && cell.Text!.Length == ColumnPlan.DocumentCap && (cell.Flags & PageReader.Truncated) != 0 && store.UsedBytes <= 2L * (ColumnPlan.DocumentCap + 1) + ResultStore.ReserveStep,
                "output past 2,097,152 characters keeps that prefix, marked truncated (" + collector.Rows + " chunks)");
            // The pool rounds a rented length up to a power of two: the budget must cover the array actually held.
            check(collector.Capacity <= ColumnPlan.DocumentCap && store.UsedBytes >= 2L * collector.Capacity,
                "the collector's reservation covers its buffer (" + collector.Capacity + " characters, " + store.UsedBytes + " bytes reserved)");
        }
        using (var collector = new ForXmlCollector(store, budget, cap: 10))
        {
            collector.Append("0123456789");
            var exact = !collector.Truncated;
            collector.Append("");
            exact &= !collector.Truncated;
            collector.Append("x");
            check(exact && collector.Truncated && collector.Length == 10, "a value of exactly the cap is whole, and one more character marks it truncated");
        }
        using (var collector = new ForXmlCollector(store, budget, cap: 10))
        {
            collector.Append("012345678\U0001F600");
            var builder = new PageBuilder(1, [WireKind.Text]);
            builder.BeginRow();
            cut = collector.Write(builder);
            builder.CommitRow();
            check(cut && PageReader.Read(builder.Seal(), [WireKind.Text]).Rows[0][0].Text == "012345678", "a surrogate pair split by the cap is dropped whole");
        }
        var tight = new ResultStore(1024 * 1024, 1024 * 1024);
        using (var collector = new ForXmlCollector(tight, tight.BeginQuery("tight")))
        {
            for (var i = 0; i < 1100; i++) collector.Append(chunk);
            check(collector.Stopped == TruncationReason.QueryBudget && tight.UsedBytes <= tight.QueryBytes, "a value the budget cannot hold stops collecting with the budget's reason");
        }
        check(tight.UsedBytes == 0, "and returns what it reserved");
    }

    /// <summary>A descriptor's bound covers its encoded size, and the widest possible one fits an essential event.</summary>
    private static void Descriptors(Action<bool, string> check)
    {
        var columns = Enumerable.Range(0, 4096).Select(i => new ResultColumn(new string('名', 124) + i.ToString("D4", System.Globalization.CultureInfo.InvariantCulture), new string('t', 128), "binary", "vector", int.MaxValue, 38, 38, false)).ToList();
        var descriptor = new ResultDescriptor(uint.MaxValue, 999, int.MaxValue, int.MaxValue, "executionPlan", columns, ResultJobs.MaxSafeInteger, ResultJobs.MaxSafeInteger, ResultJobs.MaxSafeInteger,
            ResultJobs.MaxSafeInteger, ResultJobs.MaxSafeInteger, "released", "globalBudget", true);
        var encoded = JsonBridge.Encode(new { Type = "resultSet.opened", Descriptor = descriptor }, HostChecks.Json).Length;
        var bound = ColumnPlan.DescriptorBytesOf(columns);
        check(encoded <= bound && encoded <= ProtocolLimits.EssentialEventBody && encoded > ProtocolLimits.EventBody,
            "the widest descriptor (" + encoded / 1024 + " KiB) is within its bound (" + bound / 1024 + " KiB) and an essential event (4 MiB), but not an ordinary one");
    }

    /// <summary>The writer allocates nothing per row or cell; throughput is reported only.</summary>
    private static void Allocation(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Synthetic(store, "W1", 100_000);
        var pages = set.PagesFor(0, int.MaxValue);
        var output = new Discard();
        var scratch = new int[PageView.ScratchLength(set.Columns.Count)];
        int[] columns = [.. Enumerable.Range(0, set.Columns.Count)];
        var report = new List<string>();
        foreach (var format in new[] { TextFormat.Csv, TextFormat.Tsv, TextFormat.Json })
        {
            var watch = Stopwatch.StartNew();
            var before = GC.GetAllocatedBytesForCurrentThread();
            var writer = new ResultTextWriter(output, TextOptions.Export(format, true, "NULL"), set.Columns);
            writer.Begin();
            writer.Header(columns);
            foreach (var page in pages)
            {
                var view = PageView.Parse(page.Body, columns.Length, scratch);
                for (var row = 0; row < view.Rows; row++) writer.Row(view, row, columns);
            }
            writer.End();
            var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
            var seconds = watch.Elapsed.TotalSeconds;
            check(writer.Rows == 100_000 && allocated <= 2 * 1024 * 1024, format + " writes 100,000 rows allocating " + allocated / 1024 + " KiB, at most 2 MiB");
            report.Add(format + " " + (writer.Bytes / 1048576.0 / seconds).ToString("0", System.Globalization.CultureInfo.InvariantCulture) + " MB/s");
        }
        Console.WriteLine("ResultTextWriter throughput (report only): " + string.Join(", ", report));
    }

    /// <summary>An output that drops what is written into one reused buffer.</summary>
    private sealed class Discard : IBufferWriter<byte>
    {
        private readonly byte[] buffer = new byte[64 * 1024];
        public void Advance(int count) { }
        public Memory<byte> GetMemory(int sizeHint = 0) => buffer;
        public Span<byte> GetSpan(int sizeHint = 0) => buffer;
    }
}
