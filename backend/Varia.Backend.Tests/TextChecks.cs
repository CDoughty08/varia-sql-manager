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
        XmlCells(check);
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

    internal static ResultSetBuffer Synthetic(ResultStore store, string shape, long rows, bool complete = true)
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
        var transposed = 0;
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
                    var args = new ResultsCopyArgs(set.ResultId, [.. copy.GetProperty("parts").EnumerateArray().Select(PartOf)], copy.GetProperty("headers").GetBoolean(), copy.GetProperty("eol").GetString()!, ResultJobs.MaxCopyBytes,
                        Transposed: Transposed(copy), HeaderColumn: HeaderColumn(copy));
                    var run = await Copy(jobs, args);
                    var expected = copy.GetProperty("expected").GetString()!;
                    var actual = Encoding.UTF8.GetString(run.Text);
                    if (Transposed(copy)) transposed++;
                    // The estimate that refuses a copy too large is never under the text, transposed as well.
                    var estimate = ResultJobs.EstimateCopy(set, args.Parts, args.Headers, args.Eol == "crlf", args.Transposed, args.HeaderColumn);
                    if (actual != expected || run.Result.Rows != copy.GetProperty("rows").GetInt64() || run.Result.TruncatedCells != copy.GetProperty("truncatedCells").GetInt64() || run.Result.Bytes != run.Text.Length || run.Result.Partial
                        || run.Result.Capped != Capped(copy) || estimate < run.Text.Length)
                        failures.Add(name + " / copy " + copy.GetProperty("name").GetString() + ": " + Show(actual) + " (" + run.Result + ", estimate " + estimate + ")");
                }
                foreach (var save in item.GetProperty("save").EnumerateArray())
                {
                    count++;
                    var path = Path.Combine(folder.FullName, "golden-" + count + ".out");
                    var result = await jobs.ExportAsync(new ResultsExportArgs(set.ResultId, path, save.GetProperty("format").GetString()!, save.GetProperty("headers").GetBoolean(), save.GetProperty("nullText").GetString()!, Guid.NewGuid().ToString("N"),
                        Transposed: Transposed(save), HeaderColumn: HeaderColumn(save)), null);
                    var bytes = File.ReadAllBytes(path);
                    var expected = Encoding.UTF8.GetBytes(save.GetProperty("expected").GetString()!);
                    if (Transposed(save)) transposed++;
                    if (!bytes.AsSpan().SequenceEqual(expected) || result.Rows != save.GetProperty("rows").GetInt64() || result.TruncatedCells != save.GetProperty("truncatedCells").GetInt64() || result.Bytes != bytes.Length || result.Capped != Capped(save))
                        failures.Add(name + " / save " + save.GetProperty("format").GetString() + ": " + Show(Encoding.UTF8.GetString(bytes)) + " (" + result + ")");
                }
                check(store.UsedBytes > 0 && set.Leases == 0, "jobs end their leases (" + name + ")");
            }
        }
        finally { folder.Delete(true); }
        check(count >= 15 && transposed >= 20 && failures.Count == 0, "Copy and Save write the golden text of every cases.json case (" + count + ", " + transposed + " transposed)" + (failures.Count == 0 ? "" : ": " + string.Join(" | ", failures)));

        static bool Transposed(JsonElement item) => item.TryGetProperty("transposed", out var value) && value.GetBoolean();
        static int? HeaderColumn(JsonElement item) => item.TryGetProperty("headerColumn", out var value) ? value.GetInt32() : null;
        static long Capped(JsonElement item) => item.TryGetProperty("capped", out var value) ? value.GetInt64() : 0;
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
            string Outcome(Action<string, string, string?, bool> replace)
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
                Outcome((source, path, copy, _) => { File.Move(path, copy!); File.Move(source, path); }),
                // ERROR_UNABLE_TO_REMOVE_REPLACED: nothing moved.
                Outcome((_, _, _, _) => throw new IOException("1175")),
                // ERROR_UNABLE_TO_MOVE_REPLACEMENT_2: the original went to the backup name, the new file stayed put.
                Outcome((_, path, copy, _) => { File.Move(path, copy!); throw new IOException("1177"); }),
                // The same, and the new file cannot be moved either: the original comes back.
                Outcome((source, path, copy, _) => { File.Move(path, copy!); File.Delete(source); throw new IOException("1177"); })
            };
            check(outcomes.SequenceEqual(["ok:new:", "failed:old:temporary", "ok:new:", "failed:old:"]),
                "a replace that fails keeps the old file or puts the new one in place, never neither: " + string.Join(", ", outcomes));
            // Without the right to set permissions (a share granted Change), keeping the old file's ACLs must not fail the save.
            bool? ignoresMetadataErrors = null;
            Outcome((source, path, copy, ignore) => { ignoresMetadataErrors = ignore; File.Move(path, copy!); File.Move(source, path); });
            check(ignoresMetadataErrors == true, "ReplaceFile asks File.Replace to ignore ACL merge errors");

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
            Token(Io(unchecked((int)0x80070497))), Token(Io(unchecked((int)0x80070070))), Token(Io(unchecked((int)0x80070027))), Token(new DirectoryNotFoundException()),
            Token(new IOException("x")), Token(new PathTooLongException())
        };
        check(tokens.SequenceEqual(["ACCESS", "ACCESS", "IN_USE", "IN_USE", "IN_USE", "DISK_FULL", "DISK_FULL", "NOT_FOUND", "IO", "IO"])
            && Token(Io(28)) == (OperatingSystem.IsWindows() ? "IO" : "DISK_FULL"), "export failures map to one token each: " + string.Join(", ", tokens));
    }

    /// <summary>xml cells stream under sequential access: through SqlClient internals until a release reads xml as UTF-16
    /// itself, behind a feed that stops XmlReader from holding a huge node; long columns never fall back to whole reads.</summary>
    private static void XmlCells(Action<bool, string> check)
    {
        check(SequentialXml.Available, "SqlClient still has the sequential stream internals that xml cells are read through (SequentialXml)");
        // A SqlClient that changed them must leave the opener null (GetXmlReader reads the cell), never throw from the type
        // initializer: Expression.Assign refuses a readonly field, and Expression.Field an instance of a static one.
        const System.Reflection.BindingFlags Any = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic;
        var newStream = typeof(PinnedStream).GetConstructor(Any, [typeof(PinnedReader), typeof(int)]);
        System.Reflection.FieldInfo Pinned(string name) => typeof(PinnedReader).GetField(name, Any)!;
        var opener = SequentialXml.Compile<PinnedReader>(newStream, Pinned("current"), Pinned("last"));
        var pinned = new PinnedReader();
        var opened = opener?.Invoke(pinned, 7);
        check(opened is PinnedStream { Column: 7 } && ReferenceEquals(pinned.Current, opened) && pinned.Last == 7,
            "the compiled opener builds the column's stream and sets the reader's two fields");
        var refused = new List<string>();
        void Refuses(string name, System.Reflection.FieldInfo current, System.Reflection.FieldInfo last)
        {
            try
            {
                if (SequentialXml.Usable(newStream, current, last)) refused.Add(name + " is usable");
                // Past the check too: what it does not foresee must still fall back.
                if (SequentialXml.Compile<PinnedReader>(newStream, current, last) is not null || SequentialXml.Compile<PinnedReader>(newStream, current, last, check: false) is not null) refused.Add(name + " compiled");
            }
            catch (Exception e) { refused.Add(name + " threw " + e.GetType().Name); }
        }
        Refuses("a readonly stream field", Pinned("frozenCurrent"), Pinned("last"));
        Refuses("a readonly column field", Pinned("current"), Pinned("frozenLast"));
        Refuses("a static stream field", Pinned("sharedCurrent"), Pinned("last"));
        Refuses("a static column field", Pinned("current"), Pinned("sharedLast"));
        Refuses("a stream field of another type", Pinned("wideLast"), Pinned("last"));
        Refuses("a column field of another type", Pinned("current"), Pinned("wideLast"));
        check(refused.Count == 0 && SequentialXml.Compile<PinnedReader>(null, null, null) is null,
            "a sequential stream field that became readonly, static or of another type leaves no opener instead of throwing: " + string.Join("; ", refused));
        // Without them, a cell is stored before the rest of its value is read past: a parse failure there must end the
        // read-past, not fail the cell, which ReadRow would then append a second time.
        static System.Xml.XmlReader Fragment(string text) => System.Xml.XmlReader.Create(new StringReader(text), new System.Xml.XmlReaderSettings { ConformanceLevel = System.Xml.ConformanceLevel.Fragment });
        var broken = Fragment("<a>kept</a><b>" + new string('t', 10_000) + "</c>");
        var wellFormed = Fragment("<a>kept</a><b>" + new string('t', 10_000) + "</b>");
        broken.Read();
        wellFormed.Read();
        var chunk = new char[4096];
        // A Stop still ends the read: cancellation is not a cell failure the read-past may swallow.
        var stopped = Fragment("<a>kept</a><b>" + new string('t', 10_000) + "</b>");
        stopped.Read();
        var cancelledThrows = false;
        try { ColumnPlan.ReadPastXml(stopped, chunk, new CancellationToken(canceled: true)); }
        catch (OperationCanceledException) { cancelledThrows = true; }
        // Positioned so that the next Read meets the bad end tag: a parse failure under a Stop is the Stop.
        var cut = Fragment("<a>x</b>");
        cut.Read();
        cut.Read();
        try { ColumnPlan.ReadPastXml(cut, chunk, new CancellationToken(canceled: true)); cancelledThrows = false; }
        catch (OperationCanceledException) { }
        catch (System.Xml.XmlException) { cancelledThrows = false; }
        check(!ColumnPlan.ReadPastXml(broken, chunk, default) && ColumnPlan.ReadPastXml(wellFormed, chunk, default) && cancelledThrows,
            "reading past the rest of an xml value after its cell is stored stops at a parse failure instead of failing the cell, and a Stop still ends the read, even where the value parses as cut short");
        // The feed counts characters: 2 bytes each, as SQL Server sends xml.
        var bytes = new byte[2 * 3 * XmlFeed.Window];
        var buffer = new char[4096];
        long Drain(XmlFeed feed)
        {
            long total = 0;
            for (int read; (read = feed.Read(buffer, 0, buffer.Length)) > 0;) total += read;
            return total;
        }
        var silent = new XmlFeed(() => 0);
        silent.Reset(new MemoryStream(bytes));
        var cutAt = Drain(silent);
        var output = 0;
        var growing = new XmlFeed(() => ++output);
        growing.Reset(new MemoryStream(bytes));
        var whole = Drain(growing);
        check(cutAt == XmlFeed.Window && silent.Starved && whole == bytes.Length / 2 && growing.Consumed == bytes.Length && !growing.Starved,
            "the xml feed stops after " + cutAt + " characters without output, and never while output grows (" + whole + " characters)");
        // A column plan feeds every xml cell through one feed, so a cell that starved it must not cut the next one short.
        silent.Reset(new MemoryStream(bytes, 0, 200));
        var next = Drain(silent);
        var stuck = 7;
        var reused = new XmlFeed(() => stuck);
        reused.Reset(new MemoryStream(bytes));
        var unchanged = Drain(reused);
        check(next == 100 && !silent.Starved && unchanged == XmlFeed.Window && reused.Starved,
            "a reset feed starts a fresh window for the next cell (" + next + " characters) and counts output from what it was at the reset (" + unchanged + " characters)");
        // It decodes UTF-16 itself, so a stream that returns one byte at a time (ending reads inside characters and inside a
        // surrogate pair) still reads as the text it holds.
        const string Mixed = "<r a=\"é\">\U0001F600 €</r>";
        var trickle = new XmlFeed(() => 0);
        trickle.Reset(new OneByteStream(Encoding.Unicode.GetBytes(Mixed)));
        check(trickle.ReadToEnd() == Mixed && trickle.Consumed == 2 * Mixed.Length, "the xml feed decodes UTF-16 across reads that end inside a character");
        XmlCellWriters(check);
        var fallbacks = Enum.GetValues<CellCodec>().SelectMany(codec => new[] { (codec, WireKind.Text), (codec, WireKind.Binary) })
            .Select(pair => (pair.codec, pair.Item2, Fallback: ColumnPlan.FallbackOf(pair.codec, pair.Item2, true))).ToList();
        check(fallbacks.All(item => item.Fallback is CellCodec.LongText or CellCodec.Xml or CellCodec.Json or CellCodec.Stream) && ColumnPlan.FallbackOf(CellCodec.Xml, WireKind.Text, true) == CellCodec.Xml
            && ColumnPlan.FallbackOf(CellCodec.Chars, WireKind.Text, false) == CellCodec.Value && ColumnPlan.FallbackOf(CellCodec.Bytes, WireKind.Binary, true) == CellCodec.Stream,
            "a long column whose value could not be read keeps a streaming reader, never GetValue");
        // SqlClient 7.1.1 misreads json's UTF-8 under SequentialAccess: GetChars one byte a character, GetTextReader throws
        // when a read ends inside a sequence. Varia decodes the bytes itself (the live checks read non-ASCII json).
        var json = ColumnPlan.Choose(35, null, true, typeof(string), false);
        check(json == (CellCodec.Json, WireKind.Text, "json", ColumnPlan.DocumentCap), "json is decoded from its UTF-8 bytes, not read with GetChars: " + json);
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
        // The writer's allocations, not unpacking's: the packed pass's pages are unpacked first.
        using var pin = set.Pin();
        set.TryUnpackAll();
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
                var view = PageView.Parse(PinnedPage.Body(page), columns.Length, scratch);
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

    /// <summary>Stand-ins for SqlDataReader and SqlSequentialStream, with the field shapes a later SqlClient could have.</summary>
#pragma warning disable CS0649, CS0169, CS0414, IDE0044, IDE0051, CA1823
    private sealed class PinnedReader
    {
        private PinnedStream? current;
        private int last;
        private readonly PinnedStream? frozenCurrent;
        private readonly int frozenLast;
        private static PinnedStream? sharedCurrent;
        private static int sharedLast;
        private long wideLast;
        public PinnedStream? Current => current;
        public int Last => last;
    }
#pragma warning restore CS0649, CS0169, CS0414, IDE0044, IDE0051, CA1823

    private sealed class PinnedStream : MemoryStream
    {
        internal PinnedStream(PinnedReader reader, int column)
        {
            ArgumentNullException.ThrowIfNull(reader);
            Column = column;
        }
        public int Column { get; }
    }

    private sealed class OneByteStream(byte[] bytes) : MemoryStream(bytes)
    {
        public override int Read(byte[] buffer, int offset, int count) => base.Read(buffer, offset, Math.Min(count, 1));
    }

    /// <summary>One xml cell through a column plan's <see cref="XmlCellWriter"/>, from its UTF-16 bytes as SQL Server sends
    /// them; a parse failure reads as "!error", a starved feed as "!starved".</summary>
    private static string Cell(XmlCellWriter cells, MemoryStream stream, string xml, int limit = 2_097_153)
    {
        // SetLength first: growing a MemoryStream clears the bytes it grows into.
        stream.SetLength(Encoding.Unicode.GetByteCount(xml));
        Encoding.Unicode.GetBytes(xml, 0, xml.Length, stream.GetBuffer(), 0);
        stream.Position = 0;
        cells.Reset(limit);
        cells.Feed.Reset(stream);
        try
        {
            using var reader = cells.OpenReader();
            return cells.Write(reader, cells.Feed, default) ? "!starved" : cells.Text.ToString();
        }
        catch (System.Xml.XmlException) { return "!error"; }
    }

    /// <summary>A weak reference to the NameTable <paramref name="cells"/> holds, taken before it reads one more cell (not
    /// inlined, so no local keeps the table alive).</summary>
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static WeakReference Grown(XmlCellWriter cells, MemoryStream stream, string xml)
    {
        var table = new WeakReference(cells.CurrentNames);
        Cell(cells, stream, xml);
        return table;
    }

    /// <summary>A node too long for the feed's window (a start tag with all its attributes, a comment or a processing
    /// instruction) cuts the value inside it, which keeps the first characters of the whole value, as SSMS shows a truncated
    /// one: what was written before the node, the parent's start tag closed, then the node's raw text up to the limit.</summary>
    private static void XmlCuts(Action<bool, string> check)
    {
        const int Limit = 2_097_153;
        var stream = new MemoryStream();
        var cells = new XmlCellWriter();
        var huge = new string('v', 5 * 1024 * 1024);
        var shrunk = string.Concat(Enumerable.Repeat("&#x41;", 600_000));
        (string Xml, string Start)[] cases =
        [
            ("<r a=\"1\"><c x=\"" + huge + "\"/></r>", "<r a=\"1\"><c x=\""),
            ("<r>hello<c x=\"" + huge + "\"/></r>", "<r>hello<c x=\""),
            ("<r x=\"" + huge + "\"/>", "<r x=\""),
            ("<r><!-- a<b " + huge + " --></r>", "<r><!-- a<b "),
            ("<?pi a<b " + huge + "?><r/>", "<?pi a<b "),
            ("<r><!--<<--><![CDATA[<]]><?p <?><c/>  <c x=\"" + huge + "\"/></r>", "<r><!--<<--><![CDATA[<]]><?p <?><c />  <c x=\""),
            (string.Concat(Enumerable.Repeat("<n/>", 5000)) + "<r><n>t</n><c x=\"" + huge + "\"/></r>", string.Concat(Enumerable.Repeat("<n />", 5000)) + "<r><n>t</n><c x=\""),
            // The tail moves past several of its chunks before the cut node starts.
            ("<r>" + string.Concat(Enumerable.Repeat("<n/>", 40_000)) + "<!-- " + new string('w', 3 * XmlFeed.Chunk + 7) + " --><c x=\"" + huge + "\"/></r>",
                "<r>" + string.Concat(Enumerable.Repeat("<n />", 40_000)) + "<!-- " + new string('w', 3 * XmlFeed.Chunk + 7) + " --><c x=\""),
            // A start tag read whole but longer than the feed keeps (character references shrink it below the limit) loses
            // only the nodes that start in the read its end is in: 5,000 siblings later the feed keeps a node's start again,
            // wherever XmlReader's reads end (it did so only once a read ended exactly where a node did).
            ("<r><a x=\"" + shrunk + "\"/>" + string.Concat(Enumerable.Repeat("<c x=\"1\"/>", 5000)) + "<b y=\"" + huge + "\"/></r>",
                "<r><a x=\"" + new string('A', 600_000) + "\" />" + string.Concat(Enumerable.Repeat("<c x=\"1\" />", 5000)) + "<b y=\""),
            // With text in the siblings a read did end at a node now and then, so this one was kept before too.
            ("<r><a x=\"" + shrunk + "\"/>" + string.Concat(Enumerable.Repeat("<c>t</c>", 5000)) + "<b y=\"" + huge + "\"/></r>",
                "<r><a x=\"" + new string('A', 600_000) + "\" />" + string.Concat(Enumerable.Repeat("<c>t</c>", 5000)) + "<b y=\""),
        ];
        var wrong = new List<string>();
        foreach (var (xml, start) in cases)
        {
            var expected = (start + huge)[..Limit];
            var text = Cut(cells, stream, xml, Limit);
            if (text != expected) wrong.Add(start + " -> " + (text is null ? "not cut" : text[..Math.Min(text.Length, start.Length + 8)] + " (" + text.Length + " characters)"));
            // The next cell reads as through a fresh writer.
            if (Cell(cells, stream, "<a b=\"1\">x</a>") != "<a b=\"1\">x</a>") wrong.Add(start + ": the next cell");
        }
        check(wrong.Count == 0, "an xml node too long for the feed cuts the value inside it, keeping the value's first " + Limit + " characters: " + string.Join("; ", wrong));

        // A start tag read whole but longer than the feed keeps (character references shrink it below the limit) loses the
        // next node's start: the cut keeps what was written, with the parent's start tag closed.
        // A limit below one read: the feed keeps reads whole, so a node that character references shrink does not use up
        // what the next node's text needs (clipping at the limit inside the read kept 3,000 raw characters for both).
        var small = Cut(cells, stream, "<r><a x=\"" + shrunk[..2400] + "\"/><b y=\"" + huge + "\"/></r>", 3000);
        check(small == ("<r><a x=\"" + new string('A', 400) + "\" /><b y=\"" + huge)[..3000],
            "a cut node keeps its text up to the limit after a node that character references shrank (" + small?.Length + " of 3000 characters)");
        var lost = Cut(cells, stream, "<r><a x=\"" + shrunk + "\"><b y=\"" + huge + "\"/></a></r>", Limit);
        check(lost == "<r><a x=\"" + new string('A', 600_000) + "\">", "a cut whose node start the feed could not keep ends with the parent's start tag closed (" + lost?.Length + " characters)");
    }

    /// <summary>The feed copies a node's raw text while XmlReader holds it, in case the feed cuts it; most long nodes are read
    /// whole, so that copy must cost no allocation once the pool holds its chunks (a doubling array grew to the node's length,
    /// about 4 MB for a 1 Mi-character comment, in every cell), and the feed keeps no chunk once the cell ends.</summary>
    private static void XmlTailCost(Action<bool, string> check)
    {
        const int Limit = 2_097_153;
        var xml = "<r><!--" + new string('y', 1024 * 1024) + "--><c><![CDATA[" + new string('z', 300_000) + "]]></c></r>";
        var stream = new MemoryStream();
        var cells = new XmlCellWriter();
        long Allocated(int keep)
        {
            var text = "";
            for (var warm = 0; warm < 2; warm++) text = Run(keep);
            var before = GC.GetAllocatedBytesForCurrentThread();
            for (var i = 0; i < 4; i++) text = Run(keep);
            var allocated = (GC.GetAllocatedBytesForCurrentThread() - before) / 4;
            return text == xml ? allocated : -1;
        }
        string Run(int keep)
        {
            stream.SetLength(Encoding.Unicode.GetByteCount(xml));
            Encoding.Unicode.GetBytes(xml, 0, xml.Length, stream.GetBuffer(), 0);
            stream.Position = 0;
            cells.Reset(Limit);
            cells.Feed.Keep = keep;
            cells.Feed.Reset(stream);
            using (var reader = cells.OpenReader())
                if (cells.Write(reader, cells.Feed, default)) return "!starved";
            cells.Feed.Reset(Stream.Null);
            return cells.Text.ToString();
        }
        var without = Allocated(0);
        var with = Allocated(Limit);
        check(without >= 0 && with >= 0 && with - without < 256 * 1024 && cells.Feed.Chunks == 0,
            "an xml cell whose long comment and CDATA section are read whole allocates nothing more for the feed's copy of them ("
            + (with - without) + " bytes more a cell, " + cells.Feed.Chunks + " chunks kept)");
    }

    /// <summary>The text of an xml cell the feed starved, or null when it was not cut.</summary>
    private static string? Cut(XmlCellWriter cells, MemoryStream stream, string xml, int limit)
    {
        stream.SetLength(Encoding.Unicode.GetByteCount(xml));
        Encoding.Unicode.GetBytes(xml, 0, xml.Length, stream.GetBuffer(), 0);
        stream.Position = 0;
        cells.Reset(limit);
        cells.Feed.Reset(stream);
        using var reader = cells.OpenReader();
        var starved = cells.Write(reader, cells.Feed, default);
        cells.Feed.Reset(Stream.Null);
        return starved ? cells.Text.ToString() : null;
    }

    /// <summary>A column plan reuses its xml writer, reader settings and NameTable across cells: each cell must still read
    /// exactly as it would through fresh ones, the writer is rebuilt only after a cell that did not end cleanly, the shared
    /// NameTable is replaced once hostile names grow it past its cap, and a small cell allocates little.</summary>
    private static void XmlCellWriters(Action<bool, string> check)
    {
        const int Whole = 2_097_153;
        (string Xml, int Limit)[] corpus =
        [
            ("<a b=\"1\">x</a>", Whole), ("<p:a xmlns:p=\"u1\"><p:b c=\"2\"/></p:a>", Whole), ("<p:a xmlns:p=\"u2\"/>", Whole), ("<a xmlns=\"d\"><b/></a>", Whole),
            ("<b/>", Whole), ("text only", Whole), ("<?pi data?><r/>", Whole), ("<!--c--><r><![CDATA[x<y]]></r>", Whole), ("<?xml version=\"1.0\"?><r/>", Whole),
            ("  <r> </r>", Whole), ("<a>&lt;&amp;&#x1F600;</a>", Whole), ("<a/><b/>tail", Whole), ("<a><b></a>", Whole),
            ("<a><b>" + new string('t', 300) + "</b></a>", 40), ("<a><b>" + new string('t', 20_000) + "</b></a>", 40), ("<r xml:space=\"preserve\">  </r>", Whole), ("<a>x</a>", Whole)
        ];
        var stream = new MemoryStream(new byte[1 << 16], 0, 1 << 16, true, true);
        var shared = new XmlCellWriter();
        var mismatches = new List<string>();
        for (var round = 0; round < 2; round++)
            foreach (var (xml, limit) in corpus)
            {
                var fresh = Cell(new XmlCellWriter(), stream, xml, limit);
                var again = Cell(shared, stream, xml, limit);
                if (fresh != again) mismatches.Add(xml + " -> " + again + " (fresh: " + fresh + ")");
            }
        check(mismatches.Count == 0 && Cell(new XmlCellWriter(), stream, "<p:a xmlns:p=\"u1\"><p:b c=\"2\"/></p:a>") == "<p:a xmlns:p=\"u1\"><p:b c=\"2\" /></p:a>",
            "xml cells read through a reused writer and NameTable as through fresh ones, after cut, malformed and declared cells: " + string.Join("; ", mismatches));

        var steady = new XmlCellWriter();
        for (var i = 0; i < 1000; i++) Cell(steady, stream, "<a b=\"1\">x</a>");
        var afterCut = new XmlCellWriter();
        // Cut past the writer's own buffer, so the sink fills inside <b>; a short cut ends the document in that buffer first.
        Cell(afterCut, stream, "<a><b>" + new string('t', 20_000) + "</b></a>", 40);
        Cell(afterCut, stream, "<a/>");
        Cell(afterCut, stream, "<a><b></a>");
        Cell(afterCut, stream, "<a/>");
        check(steady.Writers == 1 && steady.NameTables == 1 && afterCut.Writers == 3,
            "a column plan builds one xml writer and NameTable for its cells, and a fresh writer only after a cut or failed cell (" + steady.Writers + ", " + steady.NameTables + ", " + afterCut.Writers + ")");

        // Every cell names new elements: the shared table is replaced between cells once it passes its cap, so it never holds
        // much more than the cap plus one cell's names.
        var hostile = new XmlCellWriter();
        var names = new StringBuilder();
        for (var cell = 0; cell < 40; cell++)
        {
            names.Clear().Append("<r>");
            for (var n = 0; n < 500; n++) names.Append("<n").Append(cell).Append('_').Append(n).Append("/>");
            Cell(hostile, stream, names.Append("</r>").ToString());
        }
        check(hostile.NameTables >= 4, "the NameTable that xml cells share is replaced once hostile names grow it past " + BoundedNameTable.MaxNames + " names (" + hostile.NameTables + " tables for 20,000 names)");

        // A table one cell grew past its cap goes as that cell ends, not when the next xml cell opens a reader: when it was
        // the column's last xml value, it would stay alive outside the result budget for the rest of the set.
        var large = new MemoryStream();
        var last = new XmlCellWriter();
        Cell(last, large, "<a b=\"1\">x</a>");
        var kept = last.CurrentNames is not null;
        names.Clear().Append("<r>");
        for (var n = 0; n < BoundedNameTable.MaxNames + 100; n++) names.Append("<g").Append(n).Append("/>");
        var table = Grown(last, large, names.Append("</r>").ToString());
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        check(kept && last.CurrentNames is null && !table.IsAlive, "a NameTable a hostile xml cell grew past its cap is released as soon as that cell ends");
        XmlCuts(check);
        XmlTailCost(check);

        var small = new XmlCellWriter();
        for (var i = 0; i < 100; i++) Cell(small, stream, "<a b=\"1\">x</a>");
        const int Cells = 10_000;
        var before = GC.GetAllocatedBytesForCurrentThread();
        for (var i = 0; i < Cells; i++) Cell(small, stream, "<a b=\"1\">x</a>");
        var perCell = (GC.GetAllocatedBytesForCurrentThread() - before) / Cells;
        // About 28 KB with a fresh writer, reader buffers and NameTable per cell; each cell still builds its own XmlReader.
        check(perCell < 14 * 1024, "a small xml cell allocates under 14 KB through a column plan's xml writer (" + perCell + " bytes)");
    }
}
