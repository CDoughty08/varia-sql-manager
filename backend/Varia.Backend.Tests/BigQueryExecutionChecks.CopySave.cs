using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>
/// Copy and Save of a windowed result offline (docs/bigquery.md, Copy and Save): Copy reads its rows through the block cache
/// within the Copy limit (a selection whose separators alone pass it is refused before any read; one whose text passes it
/// stops before the chunk that does), transposed too; Save streams every row the query keeps from the destination table,
/// through Storage Read or free REST pages, never through the cache; the table gone is REMOTE_EXPIRED. No request leaves
/// the process.
/// </summary>
internal static partial class BigQueryExecutionChecks
{
    static async Task CopySaveAsync(Action<bool, string> check)
    {
        Trace("WindowedCopy");
        await WindowedCopyAsync(check);
        Trace("WindowedSave");
        await WindowedSaveAsync(check);
    }

    static JsonObject CopyRequest(uint resultId, long first, long last, int lastColumn, long maxBytes, bool headers = false, bool transposed = false) => new()
    {
        ["resultId"] = resultId, ["parts"] = new JsonArray(new JsonObject { ["rows"] = new JsonArray(new JsonArray(first, last)), ["columns"] = new JsonArray(new JsonArray(0, lastColumn)) }),
        ["headers"] = headers, ["eol"] = "lf", ["maxBytes"] = maxBytes, ["transposed"] = transposed
    };

    /// <summary>results.copy as the host runs it: the text its DATA carries, or its error code.</summary>
    static async Task<(string Code, string Text, ResultsJobResult? Result, string Message, long Sent)> Copy(Harness harness, JsonObject request)
    {
        var sent = new MemoryStream();
        using var context = new RequestContext(3, "results.copy", RequestLane.Results, 120_000, 64L << 20,
            sendData: (owner, _, body) => { lock (sent) sent.Write(body); owner.Grant((uint)body.Length); });
        using var document = JsonDocument.Parse(request.ToJsonString());
        try
        {
            var result = (ResultsJobResult)await harness.Service.DispatchAsync("results.copy", document.RootElement.Clone(), Wire, context);
            lock (sent) return ("ok", Encoding.UTF8.GetString(sent.ToArray()), result, "", sent.Length);
        }
        catch (RequestException error) { lock (sent) return (error.Code, "", null, error.Message, sent.Length); }
    }

    /// <summary>Copy's text of rows of <see cref="Lines"/>: a line each, the last without its end (as Copy writes it).</summary>
    static string LinesText(long first, long last) => string.Join("\n", Enumerable.Range((int)first, (int)(last - first + 1)).Select(i => i.ToString(Inv) + "\trow " + i));

    static async Task WindowedCopyAsync(Action<bool, string> check)
    {
        using (var harness = new Harness(Lines(3000)))
        {
            await harness.ConnectAsync();
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t", Windowed);
            var id = result!.ResultSets.Single().ResultId;
            var set = harness.Service.Results.Find(id)!;
            // The cached first page: no table read.
            var (code, text, copied, message, _) = await Copy(harness, CopyRequest(id, 0, 1, 1, 1000));
            check(code == "ok" && text == LinesText(0, 1) && copied is { Rows: 2, Partial: false } && set.Leases == 0 && harness.Jobs.TableReads.IsEmpty,
                $"Copy of a windowed result's cached rows reads them from the block cache: {code} {message} [{text}] {set.Leases}");
            // Across blocks not cached: read through tabledata.list, in order, every row once.
            (code, text, copied, message, _) = await Copy(harness, CopyRequest(id, 400, 2600, 1, 1L << 20, headers: true));
            check(code == "ok" && text == "n\ts\n" + LinesText(400, 2600) && copied?.Rows == 2201 && !harness.Jobs.TableReads.IsEmpty && set.Leases == 0,
                $"Copy of windowed rows across blocks reads them through the cache, in order: {code} {message} {copied?.Rows} {text.Length}");
            // The last row and past it: clamped to the rows the result has.
            (code, text, _, _, _) = await Copy(harness, CopyRequest(id, 2998, 5000, 1, 1000));
            check(code == "ok" && text == LinesText(2998, 2999), $"Copy of windowed rows past the end is clamped to the result: {code} [{text}]");
            // Over the limit by its separators alone: refused before any read, pointing to Save.
            var reads = harness.Jobs.TableReads.Count;
            (code, _, _, message, var sent) = await Copy(harness, CopyRequest(id, 0, 2999, 1, 1000));
            check(code == "TOO_LARGE" && message.Contains("Save Results As", StringComparison.Ordinal) && sent == 0 && harness.Jobs.TableReads.Count == reads && set.Leases == 0,
                $"a windowed selection whose separators pass the limit is refused before any read: {code} {message} {sent} {harness.Jobs.TableReads.Count - reads}");
            // Over the limit by its text: stops before the chunk that passes it is sent (main's cap is never what stops it).
            (code, _, _, message, sent) = await Copy(harness, CopyRequest(id, 0, 2999, 1, 10_000));
            check(code == "TOO_LARGE" && message.Contains("Save Results As", StringComparison.Ordinal) && sent <= 10_000 && set.Leases == 0,
                $"a windowed selection whose text passes the limit stops before sending past it: {code} {message} {sent}");
            // Transposed: a line per column, a field per row.
            (code, text, copied, message, _) = await Copy(harness, CopyRequest(id, 0, 2, 1, 1000, transposed: true));
            check(code == "ok" && text == "0\t1\t2\nrow 0\trow 1\trow 2" && copied is { Rows: 3, Capped: 0 }, $"a transposed Copy of a windowed result writes its rows as columns: {code} {message} [{text}]");
            // A view id: a windowed result has none (BQ-3c-2's derived results are results of their own).
            var withView = CopyRequest(id, 0, 1, 1, 1000);
            withView["viewId"] = 7;
            (code, _, _, _, _) = await Copy(harness, withView);
            check(code == "VIEW_NOT_FOUND", "Copy of a windowed result naming a view answers VIEW_NOT_FOUND: " + code);
        }
        // The table gone: REMOTE_EXPIRED for rows not cached; the cached first page still copies.
        using (var harness = new Harness(Lines(3000)))
        {
            await harness.ConnectAsync();
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t", Windowed);
            var id = result!.ResultSets.Single().ResultId;
            var set = harness.Service.Results.Find(id)!;
            harness.Jobs.TableDataStatus = 404;
            var (code, _, _, message, _) = await Copy(harness, CopyRequest(id, 2100, 2200, 1, 1L << 20));
            var (cachedCode, cachedText, _, _, _) = await Copy(harness, CopyRequest(id, 0, 1, 1, 1000));
            check(code == "REMOTE_EXPIRED" && cachedCode == "ok" && cachedText == LinesText(0, 1) && set.Leases == 0,
                $"Copy of an expired windowed result's rows not cached answers REMOTE_EXPIRED; its cached rows still copy: {code} {message} {cachedCode}");
        }
        // Closed while it reads: RESULT_RELEASED, never a short copy that looks whole.
        using (var harness = new Harness(Lines(3000)))
        {
            await harness.ConnectAsync();
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t", Windowed);
            var id = result!.ResultSets.Single().ResultId;
            harness.Jobs.TableDataGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var copying = Copy(harness, CopyRequest(id, 0, 2999, 1, 1L << 20));
            SpinWait.SpinUntil(() => !harness.Jobs.TableReads.IsEmpty, 15_000);
            harness.Service.Results.Release([id]);
            harness.Jobs.TableDataGate.TrySetResult();
            var (code, _, _, message, _) = await copying;
            check(code == "RESULT_RELEASED", $"a windowed result closed while Copy reads it answers RESULT_RELEASED: {code} {message}");
        }
    }

    static async Task<(string Code, string Text, ResultsJobResult? Result, string Message)> Save(Harness harness, uint resultId, bool transposed = false, Action<JsonObject>? change = null)
    {
        var directory = Directory.CreateTempSubdirectory("varia-bq-save-");
        var path = Path.Combine(directory.FullName, "result.csv");
        try
        {
            var request = new JsonObject { ["resultId"] = resultId, ["path"] = path, ["format"] = "tsv", ["headers"] = true, ["nullText"] = "NULL", ["temporaryId"] = Guid.NewGuid().ToString("N"), ["transposed"] = transposed };
            change?.Invoke(request);
            var (code, result, message) = await harness.Call("results.export", request);
            var leftovers = directory.GetFiles(".varia-*").Length;
            return (code, File.Exists(path) ? File.ReadAllText(path) : "", result as ResultsJobResult, message + (leftovers > 0 ? " (temporary file left)" : ""));
        }
        finally { directory.Delete(true); }
    }

    /// <summary>A saved file's lines, whatever their ends.</summary>
    static string[] SavedLines(string text) => [.. text.Split('\n').Select(line => line.TrimEnd('\r')).Where(line => line.Length > 0)];

    static async Task WindowedSaveAsync(Action<bool, string> check)
    {
        // REST: every row the query keeps, from the table, in order, never through the cache.
        using (var harness = new Harness(Lines(3000)))
        {
            await harness.ConnectAsync();
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t", Windowed);
            var id = result!.ResultSets.Single().ResultId;
            var remote = harness.Service.Results.Find(id)!.Remote!;
            var cached = remote.CachedBlocks();
            var (code, text, saved, message) = await Save(harness, id);
            var lines = SavedLines(text);
            check(code == "ok" && saved?.Rows == 3000 && lines.Length == 3001 && lines[0] == "n\ts" && lines[1] == "0\trow 0" && lines[^1] == "2999\trow 2999"
                && lines.Skip(1).Select((line, i) => line == i.ToString(Inv) + "\trow " + i).All(same => same) && remote.CachedBlocks().SequenceEqual(cached),
                $"Save of a windowed result streams every row from its table, never through the cache: {code} {message} {saved?.Rows} {lines.Length}");
            // Transposed: the rows a transposed grid draws.
            (code, text, saved, message) = await Save(harness, id, transposed: true);
            check(code == "ok" && text.StartsWith("Column\tRow 1\tRow 2", StringComparison.Ordinal) && saved?.Capped == 0 && SavedLines(text).Length == 3,
                $"a transposed Save of a windowed result writes its rows as columns: {code} {message} {saved?.Rows} {text[..Math.Min(80, text.Length)]}");
            harness.Jobs.TableDataStatus = 404;
            (code, _, _, message) = await Save(harness, id);
            check(code == "REMOTE_EXPIRED" && !message.Contains("temporary file left", StringComparison.Ordinal), $"Save of an expired windowed result answers REMOTE_EXPIRED and leaves no file: {code} {message}");
        }
        // Maximum rows: Save writes the rows the result keeps.
        using (var harness = new Harness(Lines(3000)))
        {
            await harness.ConnectAsync();
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t", args => { Windowed(args); args["maxRows"] = 2500; });
            var id = result!.ResultSets.Single().ResultId;
            var (code, text, saved, message) = await Save(harness, id);
            check(code == "ok" && saved?.Rows == 2500 && SavedLines(text) is { Length: 2501 } kept && kept[^1] == "2499\trow 2499", $"Save of a windowed result honours Maximum rows: {code} {message} {saved?.Rows}");
        }
        // Storage Read: the streams one after another, every row once; REST pages are not read.
        var (jobs, storage) = Numbers(3000, 700);
        using (var harness = StorageHarness(jobs, storage))
        {
            await harness.ConnectAsync();
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t", Windowed);
            var id = result!.ResultSets.Single().ResultId;
            var tableReads = harness.Jobs.TableReads.Count;
            var (code, text, saved, message) = await Save(harness, id);
            var rows = SavedLines(text).Skip(1).Select(line => long.Parse(line.Split('\t')[0], Inv)).Order().ToArray();
            check(code == "ok" && saved?.Rows == 3000 && rows.SequenceEqual(Enumerable.Range(0, 3000).Select(i => (long)i)) && !storage.Sessions.IsEmpty && harness.Jobs.TableReads.Count == tableReads,
                $"Save of a windowed result reads it through Storage Read, every row once: {code} {message} {saved?.Rows} {rows.Length} {storage.Sessions.Count} {harness.Jobs.TableReads.Count - tableReads}");
            // A stream that fails transiently is read again from its offset, with no row twice.
            var failed = 0;
            storage.ReadFault = (request, index) => index == 1 && request.Offset == 0 && Interlocked.Increment(ref failed) == 1 ? new Grpc.Core.RpcException(new(Grpc.Core.StatusCode.Unavailable, "blip")) : null;
            (code, text, saved, message) = await Save(harness, id);
            rows = [.. SavedLines(text).Skip(1).Select(line => long.Parse(line.Split('\t')[0], Inv)).Order()];
            check(code == "ok" && failed == 1 && rows.SequenceEqual(Enumerable.Range(0, 3000).Select(i => (long)i)),
                $"a Storage Read stream that fails during Save is read again from its offset, no row twice: {code} {message} {failed} {rows.Length}");
            storage.ReadFault = null;
            // A failure writing the rows (the disk) is never retried as a read: the stream is read once.
            var reads = storage.Reads.Count;
            var export = harness.Service.Results.Find(id)!.Remote!.Export!;
            var thrown = "";
            try { await export.ExportAsync(_ => throw new IOException("disk full"), CancellationToken.None); }
            catch (IOException) { thrown = "IOException"; }
            check(thrown == "IOException" && storage.Reads.Count - reads == 1, $"a write failure during Save is not retried as a Storage Read failure: {thrown} {storage.Reads.Count - reads}");
        }
    }
}
