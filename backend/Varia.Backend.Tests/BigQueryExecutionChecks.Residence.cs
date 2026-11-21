using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Apache.Arrow;
using Apache.Arrow.Types;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>
/// Result residence offline (docs/bigquery.md, Residence): the block cache on its own (byte-sized blocks, read-ahead per
/// viewer and a jump's cancellation, the fetch lanes, the wait that answers short, eviction, expiry, rowBytes from the cache
/// only), the residence decision through query.execute, results.read of a windowed result through tabledata.list, every
/// page reader's REMOTE_RESULT, the switch to windowed when the size was misestimated (REST and Arrow), Load into memory
/// (results.remoteQuery) and back, and Demote's budget accounting while pages are pinned. No request leaves the process.
/// </summary>
internal static partial class BigQueryExecutionChecks
{
    static void Memory(JsonObject args) => args["residence"] = "memory";
    static void Windowed(JsonObject args) => args["residence"] = "windowed";
    static readonly WireKind[] OneText = [WireKind.Text];

    static async Task ResidenceAsync(Action<bool, string> check)
    {
        Trace("RemoteBlocks");
        await RemoteBlocksAsync(check);
        Trace("ResidenceDecision");
        await ResidenceDecisionAsync(check);
        Trace("RemoteReads");
        await RemoteReadsAsync(check);
        Trace("Misestimate");
        await MisestimateAsync(check);
        Trace("LoadIntoMemory");
        await LoadIntoMemoryAsync(check);
        Trace("DemoteAccounting");
        DemoteAccounting(check);
    }

    /// <summary>A scripted remote table for <see cref="RemoteResult"/>: row n reads "r{n}", padded; it records each fetch,
    /// how many ran at once, and can hold them or say the table is gone.</summary>
    sealed class Blocks
    {
        public readonly ConcurrentQueue<(long First, int Rows)> Calls = new();
        public TaskCompletionSource? Gate;
        public int Pad;
        public volatile bool Expire;
        int running;
        public int MaxRunning;
        public int Cancelled;

        public RemoteFetch Fetch => async (first, rows, writer, token) =>
        {
            Calls.Enqueue((first, rows));
            var now = Interlocked.Increment(ref running);
            lock (Calls) MaxRunning = Math.Max(MaxRunning, now);
            try
            {
                if (Gate is { } gate)
                {
                    try { await gate.Task.WaitAsync(token); }
                    catch (OperationCanceledException) { Interlocked.Increment(ref Cancelled); throw; }
                }
                if (Expire) throw new RemoteExpiredException();
                for (var row = first; row < first + rows; row++) Write(writer, row, Pad);
            }
            finally { Interlocked.Decrement(ref running); }
        };

        public static void Write(RemoteBlockWriter writer, long row, int pad)
        {
            var builder = writer.BeginRow();
            var text = "r" + row.ToString(Inv) + new string('x', pad);
            builder.AppendText(text);
            builder.Measure(text.Length, text.Length);
            writer.CommitRow();
        }
    }

    static RemoteResult Remote(ResultStore store, Blocks blocks, long rows = 100_000, double rowBytes = 16_384, long cache = 256L << 20, SemaphoreSlim? lane = null) =>
        new(store, 1, OneText, rows, false, rowBytes, cache, lane ?? new SemaphoreSlim(RemoteResult.FetchesPerConnection), blocks.Fetch);

    /// <summary>Reads through the cache as results.read does; each row's number (the text after "r", before the padding).</summary>
    static async Task<(long Next, List<long> Rows)> ReadRemote(RemoteResult remote, long first, int max, uint viewer = 0, int waitMs = 15_000)
    {
        var rows = new List<long>();
        var next = await remote.ReadAsync(first, max, viewer, body =>
        {
            foreach (var row in PageReader.Read(body, OneText).Rows) rows.Add(long.Parse(row[0].Text!.AsSpan(1).TrimEnd('x'), Inv));
            return ValueTask.CompletedTask;
        }, TimeSpan.FromMilliseconds(waitMs), CancellationToken.None);
        return (next, rows);
    }

    /// <summary>The rows sent hold [first, first + count) in order (a read sends whole cached pages, so it may send more).</summary>
    static bool Consecutive(List<long> rows, long first, int count)
    {
        var at = rows.IndexOf(first);
        return at >= 0 && rows.Count - at >= count && rows.Skip(at).Take(count).Select((row, index) => row == first + index).All(same => same);
    }

    /// <summary>The rows sent hold [first, first + count) in order, by their first cell's number.</summary>
    static bool Covers(List<string[]> rows, long first, int count) => Consecutive([.. rows.Select(row => long.Parse(row[0], Inv))], first, count);

    static async Task RemoteBlocksAsync(Action<bool, string> check)
    {
        check(RemoteResult.BlockRowsFor(16_384) == 256 && RemoteResult.BlockRowsFor(1) == RemoteResult.MaxBlockRows && RemoteResult.BlockRowsFor(1 << 20) == RemoteResult.MinBlockRows
            && RemoteResult.BlockRowsFor(1024) == 4096, "a block is about 4 MiB of measured rows, clamped to 256..16,384 rows");

        // The first page is seeded and read without a fetch; rowBytes answers from the cache only.
        {
            var store = new ResultStore(1L << 30, 1L << 29);
            var blocks = new Blocks();
            using var remote = Remote(store, blocks);
            var seed = new RemoteBlockWriter(1, OneText, 0);
            for (var row = 0; row < 100; row++) Blocks.Write(seed, row, 0);
            remote.Seed(seed.Finish());
            var cached = store.WindowCacheBytes;
            var held = remote.CachedBytes;
            var (next, rows) = await ReadRemote(remote, 0, 100, viewer: 0, waitMs: 15_000);
            var bytes = remote.RowBytes(90, 20);
            var uncached = remote.RowBytes(5000, 10);
            check(next == 100 && Consecutive(rows, 0, 100) && cached > 0 && cached == held && store.UsedBytes >= cached,
                $"seeded rows read from the cache, charged to the global budget as the window cache: {next} {rows.Count} {cached}");
            check(bytes.Length == 10 && bytes.All(value => value > 0) && uncached.Length == 0, "rowBytes answers only as far as the cached rows go");
            // Read-ahead from the seeded read may have started block 1's fetch; rowBytes itself never fetches.
            SpinWait.SpinUntil(() => remote.CachedBlocks() is var ahead && ahead.Contains(1) && ahead.Contains(2), 15_000);
            var before = remote.Fetches;
            remote.RowBytes(50_000, 100);
            check(remote.Fetches == before, "rowBytes never fetches a block");
        }

        // A read across two blocks fetches them (and its viewer's read-ahead), at most two at a time per result.
        {
            var store = new ResultStore(1L << 30, 1L << 29);
            var blocks = new Blocks();
            using var remote = Remote(store, blocks);
            var (next, rows) = await ReadRemote(remote, 1000, 100, viewer: 1);
            check(next >= 1100 && Consecutive(rows, 1000, 100), $"a read across blocks 3 and 4 answers its rows in order: {next} {rows.Count}");
            var ahead = SpinWait.SpinUntil(() => remote.CachedBlocks() is var cached && new long[] { 2, 3, 4, 5, 6 }.All(cached.Contains), 15_000);
            check(ahead, "the viewer's read-ahead fetches the blocks either side and one more in the direction of travel: " + string.Join(",", remote.CachedBlocks()));
            check(blocks.MaxRunning <= RemoteResult.FetchesPerResult && blocks.Calls.All(call => call.First % 256 == 0 && call.Rows == 256),
                $"fetches run at most {RemoteResult.FetchesPerResult} at a time per result, one whole block each: {blocks.MaxRunning}");
            // Scrolling back reads ahead backwards.
            await ReadRemote(remote, 300, 10, viewer: 1);
            check(SpinWait.SpinUntil(() => remote.CachedBlocks().Contains(0), 15_000), "a read moving up reads ahead towards the top");
        }

        // The connection's lane bounds fetches across its results.
        {
            var store = new ResultStore(1L << 30, 1L << 29);
            var lane = new SemaphoreSlim(1);
            var shared = new Blocks();
            using var first = Remote(store, shared, lane: lane);
            using var second = Remote(store, shared, lane: lane);
            await Task.WhenAll(ReadRemote(first, 0, 600, viewer: 1), ReadRemote(second, 5000, 600, viewer: 1));
            check(shared.MaxRunning == 1, "one connection's lane bounds fetches across all of its results: " + shared.MaxRunning);
        }

        // A read whose blocks do not come within its wait answers short, and the rows follow on the next read.
        {
            var store = new ResultStore(1L << 30, 1L << 29);
            var blocks = new Blocks { Gate = new(TaskCreationOptions.RunContinuationsAsynchronously) };
            using var remote = Remote(store, blocks);
            var (next, rows) = await ReadRemote(remote, 2000, 50, viewer: 1, waitMs: 100);
            check(next == 2000 && rows.Count == 0, $"a read that waits past its time answers with the rows it has (none), not an error: {next} {rows.Count}");
            blocks.Gate.SetResult();
            (next, rows) = await ReadRemote(remote, 2000, 50, viewer: 1);
            check(next >= 2050 && Consecutive(rows, 2000, 50), "the next read finds the rows the held fetch brought");
        }

        // A jump cancels the viewer's stale read-ahead; the read's own block still arrives.
        {
            var store = new ResultStore(1L << 30, 1L << 29);
            var blocks = new Blocks { Gate = new(TaskCreationOptions.RunContinuationsAsynchronously) };
            using var remote = Remote(store, blocks);
            await ReadRemote(remote, 10 * 256, 10, viewer: 7, waitMs: 50);
            // Blocks 9, 11 and 12 are read-ahead (held or queued on the lane); block 10 is the read's own.
            await ReadRemote(remote, 100 * 256, 10, viewer: 7, waitMs: 50);
            var cancelledBefore = blocks.Cancelled;
            blocks.Gate.SetResult();
            var settled = SpinWait.SpinUntil(() => remote.CachedBlocks() is var cached && new long[] { 10, 99, 100, 101, 102 }.All(cached.Contains), 15_000);
            var cachedAfter = remote.CachedBlocks();
            check(settled && !cachedAfter.Contains(9) && !cachedAfter.Contains(11) && !cachedAfter.Contains(12),
                $"a jump cancels the viewer's earlier read-ahead and keeps the read's own block: {string.Join(",", cachedAfter)} (cancelled in flight: {cancelledBefore})");
            // Another viewer's read-ahead is its own: viewer 8 jumping does not cancel viewer 7's.
        }

        // The cache evicts its least recent blocks within its limit, and gives every byte back when released.
        {
            var store = new ResultStore(1L << 30, 1L << 29);
            var blocks = new Blocks { Pad = 16_000 };
            var remote = Remote(store, blocks, cache: 16L << 20);
            foreach (var block in new long[] { 0, 40, 80, 120, 160, 200 }) await ReadRemote(remote, block * 256, 10, viewer: (uint)(block + 1));
            SpinWait.SpinUntil(() => remote.Fetches >= 6 && remote.CachedBytes <= remote.CacheLimit, 15_000);
            check(remote.Evictions > 0 && remote.CachedBytes <= remote.CacheLimit + (5L << 20) && store.WindowCacheBytes == remote.CachedBytes,
                $"the cache evicts least recent blocks to stay near its limit, and the store counts what it holds: {remote.Evictions} {remote.CachedBytes} {store.WindowCacheBytes}");
            remote.Dispose();
            SpinWait.SpinUntil(() => store.WindowCacheBytes == 0, 15_000);
            check(store.WindowCacheBytes == 0 && store.UsedBytes == 0, "a released window gives back every cached byte: " + store.UsedBytes);
        }

        // A full global budget refuses a block (TOO_LARGE) rather than passing it.
        {
            var store = new ResultStore(2L << 20, 1L << 20);
            var blocks = new Blocks();
            using var remote = Remote(store, blocks, cache: 64L << 20);
            string? code = null;
            try { await ReadRemote(remote, 0, 10); }
            catch (RequestException error) { code = error.Code; }
            check(code == "TOO_LARGE" && store.UsedBytes == 0, "a block the global budget has no room for answers TOO_LARGE and holds nothing: " + code);
        }

        // A gone table fails the rows not cached; the cached ones stay readable.
        {
            var store = new ResultStore(1L << 30, 1L << 29);
            var blocks = new Blocks();
            using var remote = Remote(store, blocks);
            await ReadRemote(remote, 0, 10);
            blocks.Expire = true;
            var expired = false;
            try { await ReadRemote(remote, 50_000, 10); }
            catch (RemoteExpiredException) { expired = true; }
            var (next, rows) = await ReadRemote(remote, 0, 10);
            check(expired && remote.Expired && next >= 10 && Consecutive(rows, 0, 10), "a gone table fails the rows not cached and leaves the cached rows readable");
        }
    }

    static Jobs Lines(int count, Func<int, string>? text = null) => new()
    {
        Schema = Schema(Field("n", "INTEGER"), Field("s", "STRING")),
        Rows = [.. Enumerable.Range(0, count).Select(i => Row(i.ToString(Inv), text?.Invoke(i) ?? "row " + i))],
        Destination = Destination
    };

    /// <summary>results.read as the host runs it: the rows of its DATA pages, each row's cells as text.</summary>
    static async Task<(string Code, ResultsReadResult? Result, List<string[]> Rows, string Message)> ReadRows(Harness harness, uint resultId, long first, int max, uint? viewer = null)
    {
        var set = harness.Service.Results.Find(resultId)!;
        var bodies = new List<byte[]>();
        using var context = new RequestContext(1, "results.read", RequestLane.Results, 60_000, 64L << 20,
            sendData: (owner, _, body) => { lock (bodies) bodies.Add(body); owner.Grant((uint)body.Length); });
        var parameters = new JsonObject { ["resultId"] = resultId, ["firstRow"] = first, ["maxRows"] = max };
        if (viewer is not null) parameters["viewer"] = viewer;
        using var document = JsonDocument.Parse(parameters.ToJsonString());
        try
        {
            var result = (ResultsReadResult)await harness.Service.DispatchAsync("results.read", document.RootElement.Clone(), Wire, context);
            lock (bodies) return ("ok", result, [.. bodies.SelectMany(body => PageReader.Read(body, set.Wires).Rows).Select(row => row.Select(cell => cell.Text ?? "").ToArray())], "");
        }
        catch (RequestException error) { return (error.Code, null, [], error.Message); }
    }

    /// <summary>A query-shaped request with its EVENTs, as the host runs it.</summary>
    static async Task<(string Code, QueryResult? Result, List<JsonElement> Events, string Message)> Run(Harness harness, string method, JsonNode parameters)
    {
        var events = new List<JsonElement>();
        using var context = new RequestContext(2, method, RequestLane.Query, 0, sendEvent: (_, value, _) => { lock (events) events.Add(JsonSerializer.SerializeToElement(value, HostChecks.Json)); });
        using var document = JsonDocument.Parse(parameters.ToJsonString());
        try
        {
            var result = (QueryResult)await harness.Service.DispatchAsync(method, document.RootElement.Clone(), Wire, context);
            lock (events) return ("ok", result, [.. events], "");
        }
        catch (RequestException error) { lock (events) return (error.Code, null, [.. events], error.Message); }
    }

    /// <summary>What the store holds besides window caches: stored pages, and each set's own few hundred bytes.</summary>
    static long Pages(Harness harness) => harness.Service.Results.UsedBytes - harness.Service.Results.WindowCacheBytes;

    static string[] Types(List<JsonElement> events) => [.. events.Select(item => item.GetProperty("type").GetString() ?? "")];
    static IEnumerable<JsonElement> OfType(List<JsonElement> events, string type) => events.Where(item => item.GetProperty("type").GetString() == type);

    static JsonObject Load(uint resultId, string? queryId = null, string kind = "load") =>
        new() { ["queryId"] = queryId ?? Guid.NewGuid().ToString(), ["resultId"] = resultId, ["generation"] = 1, ["kind"] = kind };

    static async Task ResidenceDecisionAsync(Action<bool, string> check)
    {
        // Rows that arrive whole stay in memory, whatever their size.
        using (var harness = new Harness(Lines(100)))
        {
            await harness.ConnectAsync();
            var (code, result, message) = await harness.Execute("SELECT n, s FROM t");
            var set = result?.ResultSets.Single();
            check(code == "ok" && set is { Residence: "memory", RowsTotal: 100, Revision: 0, RowsStored: 100 } && harness.Jobs.TableReads.IsEmpty,
                $"a result that arrives in its first page stays in memory: {code} {message} {set?.Residence} {set?.RowsTotal} {set?.Revision}");
        }
        // Automatic keeps a result that fits in memory, ready to switch if the budget refuses it.
        using (var harness = new Harness(Lines(1200)))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n, s FROM t");
            var set = result?.ResultSets.Single();
            check(code == "ok" && set is { Residence: "memory", RowsTotal: 1200, RowsStored: 1200, Revision: 0 } && harness.Service.Results.Find(set.ResultId)?.SwitchesOnRefusal == true
                && harness.Jobs.TableReads.IsEmpty, $"Automatic keeps a result that fits in memory: {set?.Residence} {set?.RowsStored}");
        }
        // Too large for half the room: windowed, its first page cached, nothing read from the table yet.
        using (var harness = new Harness(Lines(3000), new ResultStore(4L << 20, 32 * 1024)))
        {
            await harness.ConnectAsync();
            var (code, result, message) = await harness.Execute("SELECT n, s FROM t");
            var set = result?.ResultSets.Single();
            var buffer = set is null ? null : harness.Service.Results.Find(set.ResultId);
            var store = harness.Service.Results;
            check(code == "ok" && result?.Status == "completed" && set is { Residence: "remote", RowsTotal: 3000, RowsAvailable: 3000, Revision: 0, Truncated: null } && buffer?.IsRemote == true
                && buffer.Remote!.CachedBlocks().SequenceEqual([0L]) && harness.Jobs.TableReads.IsEmpty,
                $"Automatic windows a result too large for half the room, its first page cached: {code} {message} {set?.Residence} {set?.RowsAvailable} {set?.Truncated}");
            check(store.WindowCacheBytes > 0 && store.WindowCacheBytes == buffer?.Remote?.CachedBytes && store.MemoryDetail().WindowCacheBytes == store.WindowCacheBytes,
                "the window cache is charged to the store and shown in the memory detail: " + store.WindowCacheBytes);
        }
        // Always in memory truncates at the budget as before.
        using (var harness = new Harness(Lines(3000), new ResultStore(4L << 20, 32 * 1024)))
        {
            await harness.ConnectAsync();
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t", Memory);
            var set = result?.ResultSets.Single();
            check(set is { Residence: "memory", Truncated: "queryBudget" } && harness.Jobs.TableReads.IsEmpty, $"Always in memory truncates at the budget: {set?.Residence} {set?.Truncated}");
        }
        // Always windowed, with its cache setting; a result without a readable destination table stays in memory.
        using (var harness = new Harness(Lines(1200)))
        {
            await harness.ConnectAsync();
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t", args => { Windowed(args); args["windowCacheMiB"] = 128; });
            var set = result?.ResultSets.Single();
            check(set is { Residence: "remote", RowsTotal: 1200 } && harness.Service.Results.Find(set.ResultId)?.Remote?.CacheLimit == 128L << 20,
                $"Always windowed windows a small result, with the cache size asked: {set?.Residence}");
            harness.Jobs.Destination = null;
            (_, result, _) = await harness.Execute("SELECT n, s FROM t", Windowed);
            set = result?.ResultSets.Single();
            check(set is { Residence: "memory", RowsStored: 1200 }, $"a result whose destination table cannot be read stays in memory: {set?.Residence} {set?.RowsStored}");
            var (badResidence, _, _) = await harness.Execute("SELECT 1", args => args["residence"] = "disk");
            var (badCache, _, _) = await harness.Execute("SELECT 1", args => args["windowCacheMiB"] = 8);
            check(badResidence == "INVALID_PARAMS" && badCache == "INVALID_PARAMS", $"an unknown residence or a cache outside 16..4,096 MiB is refused: {badResidence} {badCache}");
        }
        // The row cap: 32-bit row indexes show at most 2,147,483,647 rows, with a note.
        using (var harness = new Harness(Lines(1200)))
        {
            harness.Jobs.ReportedTotal = 3_000_000_000;
            await harness.ConnectAsync();
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t");
            var set = result?.ResultSets.Single();
            check(set is { Residence: "remote", RowsTotal: 3_000_000_000, RowsAvailable: int.MaxValue } && Says(result, "the most it can address"),
                $"a result past the row cap shows the first 2,147,483,647 rows and says why: {set?.RowsTotal} {set?.RowsAvailable} {Texts(result?.Messages ?? [])}");
        }
    }

    static async Task RemoteReadsAsync(Action<bool, string> check)
    {
        using (var harness = new Harness(Lines(3000)))
        {
            await harness.ConnectAsync();
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t", Windowed);
            var id = result!.ResultSets.Single().ResultId;
            var (code, read, rows, message) = await ReadRows(harness, id, 0, 200);
            check(code == "ok" && read is { NextRow: >= 200, RowsAvailable: 3000, Complete: false, Rows: 200 } && Covers(rows, 0, 200) && rows[0][1] == "row 0" && harness.Jobs.TableReads.IsEmpty,
                $"the first page reads from the cache without asking BigQuery: {code} {message} {read?.NextRow} {rows.Count}");
            var (bytesCode, bytes, _) = await harness.Call("results.rowBytes", new JsonObject { ["resultId"] = id, ["firstRow"] = 2000, ["count"] = 10 });
            check(bytesCode == "ok" && bytes is ResultsRowBytesResult { Bytes.Length: 0 } && harness.Jobs.TableReads.IsEmpty, "results.rowBytes of rows not cached answers none and reads nothing");
            (code, read, rows, message) = await ReadRows(harness, id, 2500, 100, viewer: 3);
            check(code == "ok" && read is { NextRow: >= 2600, Rows: 100 } && Covers(rows, 2500, 100) && rows.Single(row => row[0] == "2599")[1] == "row 2599"
                && harness.Jobs.TableReads.TryPeek(out var first) && first.StartIndex == 500,
                $"a read past the cache fetches the block's rows through tabledata.list from where the cache ends: {code} {message} {read?.NextRow} {rows.Count}");
            (code, read, rows, _) = await ReadRows(harness, id, 2900, 500);
            check(read is { NextRow: 3000, Complete: true, Rows: 100 } && Covers(rows, 2900, 100), "a read to the end is complete");
            var (viewerCode, _, _, _) = await ReadRows(harness, id, 0, 10, viewer: 0);
            check(viewerCode == "INVALID_PARAMS", "a viewer id of 0 is refused");

            // Every reader of stored pages refuses a windowed result before doing any work.
            var refusals = new List<string>();
            async Task Refuses(string method, JsonObject parameters)
            {
                parameters["resultId"] = id;
                var (refused, _, text) = await harness.Call(method, parameters);
                if (refused != "REMOTE_RESULT") refusals.Add(method + ": " + refused + " " + text);
            }
            await Refuses("results.view", new JsonObject { ["sort"] = new JsonArray(new JsonObject { ["column"] = 0, ["descending"] = false, ["mode"] = "value" }) });
            await Refuses("results.profile", new JsonObject { ["columns"] = new JsonArray(0) });
            await Refuses("results.search", new JsonObject { ["text"] = "row", ["fromRow"] = 0, ["maxMatches"] = 10 });
            await Refuses("results.distinct", new JsonObject { ["column"] = 0 });
            await Refuses("results.pivot", new JsonObject { ["rows"] = new JsonArray(0), ["values"] = new JsonArray(new JsonObject { ["aggregate"] = "count" }) });
            await Refuses("results.identify", new JsonObject { ["by"] = "row" });
            await Refuses("results.rowIds", new JsonObject { ["firstRow"] = 0, ["count"] = 10 });
            await Refuses("results.findRows", new JsonObject { ["ids"] = new JsonArray(1) });
            check(refusals.Count == 0, "every reader of stored pages answers REMOTE_RESULT for a windowed result: " + string.Join("; ", refusals));
            var set = harness.Service.Results.Find(id)!;
            string? leased;
            using (var context = new RequestContext(3, "results.copy", RequestLane.Results, 0, 16L << 20, sendData: (owner, _, body) => owner.Grant((uint)body.Length)))
            {
                var copy = new JsonObject
                {
                    ["resultId"] = id, ["parts"] = new JsonArray(new JsonObject { ["rows"] = new JsonArray(new JsonArray(0, 1)), ["columns"] = new JsonArray(new JsonArray(0, 1)) }),
                    ["headers"] = false, ["eol"] = "lf", ["maxBytes"] = 1000
                };
                using var document = JsonDocument.Parse(copy.ToJsonString());
                try { await harness.Service.DispatchAsync("results.copy", document.RootElement.Clone(), Wire, context); leased = "ok"; }
                catch (RequestException error) { leased = error.Code; }
            }
            check(leased == "REMOTE_RESULT" && set.Leases == 0, "Copy and Save's lease refuses a windowed result: " + leased);

            harness.Service.Results.Release([id]);
            check(harness.Service.Results.WindowCacheBytes == 0 && harness.Service.Results.UsedBytes == 0, "closing a windowed result gives back its cache: " + harness.Service.Results.UsedBytes);
        }

        // A gone result table: REMOTE_EXPIRED for the rows not cached, the cached rows still read.
        using (var harness = new Harness(Lines(3000)))
        {
            await harness.ConnectAsync();
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t", Windowed);
            var id = result!.ResultSets.Single().ResultId;
            harness.Jobs.TableDataStatus = 404;
            var (code, _, _, message) = await ReadRows(harness, id, 2500, 100);
            var (cachedCode, _, rows, _) = await ReadRows(harness, id, 0, 100);
            check(code == "REMOTE_EXPIRED" && cachedCode == "ok" && Covers(rows, 0, 100), $"a 404 from tabledata.list is REMOTE_EXPIRED, and the cached rows still read: {code} {message}");
        }

        // A rate limit backs off and reads again, never as an error.
        using (var harness = new Harness(Lines(3000)))
        {
            await harness.ConnectAsync();
            harness.Service.BigQuery.ReadAttempts = 1;
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t", Windowed);
            var id = result!.ResultSets.Single().ResultId;
            lock (harness.Jobs.TableDataReplies) { harness.Jobs.TableDataReplies.Enqueue(429); harness.Jobs.TableDataReplies.Enqueue(429); }
            var (code, read, rows, message) = await ReadRows(harness, id, 2500, 100);
            check(code == "ok" && Covers(rows, 2500, 100) && harness.Jobs.TableReads.Count >= 3, $"rateLimitExceeded backs off and reads the block again: {code} {message} {harness.Jobs.TableReads.Count}");
        }

        // A read whose block is slow answers short within its wait; the grid reads again.
        using (var harness = new Harness(Lines(3000)))
        {
            await harness.ConnectAsync();
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t", Windowed);
            var id = result!.ResultSets.Single().ResultId;
            harness.Jobs.TableDataGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
            harness.Service.RemoteReadWait = TimeSpan.FromMilliseconds(100);
            var (code, read, rows, _) = await ReadRows(harness, id, 2500, 100);
            check(code == "ok" && read is { NextRow: 2500, Rows: 0, Complete: false } && rows.Count == 0, $"a read that waits past its time answers short, not with an error: {code} {read?.NextRow}");
            harness.Jobs.TableDataGate.SetResult();
            harness.Service.RemoteReadWait = TimeSpan.FromSeconds(20);
            (code, read, rows, _) = await ReadRows(harness, id, 2500, 100);
            check(code == "ok" && Covers(rows, 2500, 100), "the read after it finds the rows");
        }
    }

    static async Task MisestimateAsync(Action<bool, string> check)
    {
        // The first page's rows are short and the rest long: Automatic keeps it in memory, then the budget refuses it.
        static string Text(int i) => i < 500 ? "r" : new string('w', 1000);
        using (var harness = new Harness(Lines(3000, Text), new ResultStore(8L << 20, 512 * 1024)))
        {
            await harness.ConnectAsync();
            var (code, result, events, message) = await Run(harness, "query.execute", harness.Query("SELECT n, s FROM t"));
            var set = result?.ResultSets.Single();
            var types = Types(events);
            var residence = OfType(events, "resultSet.residence").ToList();
            check(code == "ok" && result?.Status == "completed" && set is { Residence: "remote", Revision: 1, RowsTotal: 3000, RowsAvailable: 3000, Truncated: null }
                && Says(result, "larger than estimated") && residence.Count == 1 && residence[0].GetProperty("descriptor").GetProperty("revision").GetInt32() == 1
                && System.Array.IndexOf(types, "resultSet.opened") < System.Array.IndexOf(types, "resultSet.residence") && System.Array.IndexOf(types, "resultSet.residence") < System.Array.LastIndexOf(types, "resultSet.closed"),
                $"a result larger than estimated switches to windowed under a new revision and says so: {code} {message} {set?.Residence} {set?.Revision} {set?.Truncated} [{string.Join(",", types)}]");
            check(Pages(harness) < 4096, "the switch releases the rows it had stored (the empty set keeps only its own bytes): " + Pages(harness));
            var (readCode, _, rows, _) = await ReadRows(harness, set!.ResultId, 2900, 10);
            check(readCode == "ok" && Covers(rows, 2900, 10) && rows.Single(row => row[0] == "2900")[1].Length == 1000, "its rows then read through the window");
        }
        // The same through Storage Read.
        {
            var jobs = Lines(3000, Text);
            var schema = new Schema([new("n", Int64Type.Default, true), new("s", StringType.Default, true)], null);
            var batches = Enumerable.Range(0, 3000).Chunk(500)
                .Select(chunk => new RecordBatch(schema, [Primitive(Int64Type.Default, [.. chunk.Select(i => (long?)i)]), Strings(chunk.Select(Text))], chunk.Length)).ToList();
            using var harness = StorageHarness(jobs, new BigQueryStorageFake(schema, batches), new ResultStore(8L << 20, 512 * 1024));
            await harness.ConnectAsync();
            var (code, result, events, message) = await Run(harness, "query.execute", harness.Query("SELECT n, s FROM t"));
            var set = result?.ResultSets.Single();
            check(code == "ok" && set is { Residence: "remote", Revision: 1, Truncated: null } && OfType(events, "resultSet.residence").Count() == 1 && Says(result, "larger than estimated"),
                $"a Storage Read larger than estimated switches to windowed too: {code} {message} {set?.Residence} {set?.Revision} {set?.Truncated} {Texts(result?.Messages ?? [])}");
            check(Pages(harness) < 4096, "the Storage Read's switch gives back every batch's charge: " + Pages(harness));
        }
    }

    static async Task LoadIntoMemoryAsync(Action<bool, string> check)
    {
        using (var harness = new Harness(Lines(3000)))
        {
            await harness.ConnectAsync();
            var (_, executed, _) = await harness.Execute("SELECT n, s FROM t", Windowed);
            var id = executed!.ResultSets.Single().ResultId;
            var (code, result, events, message) = await Run(harness, "results.remoteQuery", Load(id));
            var set = result?.ResultSets.Single();
            var rows = set is null ? [] : harness.Rows(set);
            check(code == "ok" && result?.Status == "completed" && set is { ResultId: var same, Residence: "memory", Revision: 1, RowsStored: 3000 } && same == id
                && rows.Count == 3000 && rows[2999][1].Text == "row 2999" && Types(events) is ["resultSet.residence", .., "resultSet.closed"] && harness.Service.Results.WindowCacheBytes == 0,
                $"Load into memory reads the whole result into the same result under a new revision: {code} {message} {set?.Residence} {set?.Revision} {set?.RowsStored} [{string.Join(",", Types(events))}]");
            var (viewCode, _, _) = await harness.Call("results.view", new JsonObject { ["resultId"] = id, ["sort"] = new JsonArray(new JsonObject { ["column"] = 0, ["descending"] = true, ["mode"] = "value" }) });
            check(viewCode == "ok", "a loaded result sorts in memory: " + viewCode);
            var (again, _, _, _) = await Run(harness, "results.remoteQuery", Load(id));
            var (kind, _, _, _) = await Run(harness, "results.remoteQuery", Load(id, kind: "view"));
            var (missing, _, _, _) = await Run(harness, "results.remoteQuery", Load(999_999));
            check(again == "INVALID_PARAMS" && kind == "INVALID_PARAMS" && missing == "RESULT_NOT_FOUND", $"only a windowed result loads, and only the load kind exists: {again} {kind} {missing}");
        }
        // A load the budget refuses part way goes back to windowed, whole.
        using (var harness = new Harness(Lines(3000, i => new string('w', 1000)), new ResultStore(8L << 20, 512 * 1024)))
        {
            await harness.ConnectAsync();
            var (_, executed, _) = await harness.Execute("SELECT n, s FROM t");
            var id = executed!.ResultSets.Single().ResultId;
            var (code, result, events, message) = await Run(harness, "results.remoteQuery", Load(id));
            var set = result?.ResultSets.Single();
            check(code == "ok" && set is { Residence: "remote", Revision: 2, RowsAvailable: 3000 } && OfType(events, "resultSet.residence").Count() == 2 && Says(result, "stays windowed")
                && Pages(harness) < 4096,
                $"a load that does not fit goes back to windowed under another revision: {code} {message} {set?.Residence} {set?.Revision} {Texts(result?.Messages ?? [])}");
        }
        // Stop part way: back to windowed, the load reported cancelled.
        using (var harness = new Harness(Lines(3000)))
        {
            await harness.ConnectAsync();
            var (_, executed, _) = await harness.Execute("SELECT n, s FROM t", Windowed);
            var id = executed!.ResultSets.Single().ResultId;
            harness.Jobs.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
            harness.Jobs.HangPages = true;
            var queryId = Guid.NewGuid().ToString();
            var loading = Run(harness, "results.remoteQuery", Load(id, queryId));
            var held = await Task.WhenAny(harness.Jobs.Polling.Task, Task.Delay(15_000)) == harness.Jobs.Polling.Task;
            var (cancel, _, _) = await harness.Call("query.cancel", new JsonObject { ["queryId"] = queryId });
            var (code, result, _, message) = await loading;
            var set = result?.ResultSets.Single();
            check(held && cancel == "ok" && code == "ok" && result?.Status == "cancelled" && set is { Residence: "remote", Revision: 2 } && harness.Service.Results.Find(id)?.IsRemote == true,
                $"Stop during a load leaves the result windowed: {held} {cancel} {code} {message} {result?.Status} {set?.Residence} {set?.Revision}");
        }
    }

    /// <summary>Demote frees a set's pages, but only once nothing still reads them.</summary>
    static void DemoteAccounting(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = TextChecks.Synthetic(store, "W1", 5000);
        var before = store.UsedBytes;
        var pin = set.Pin();
        var remote = new RemoteResult(store, set.ResultId, set.Wires, 5000, false, 100, 16L << 20, new SemaphoreSlim(4), new Blocks().Fetch);
        var demoted = store.Demote(set, remote, 5000);
        var held = store.UsedBytes;
        pin.Dispose();
        var after = store.UsedBytes;
        check(demoted && set.IsRemote && set.Revision == 1 && set.Residence == "remote" && held == before && after < before / 10,
            $"Demote keeps a pinned set's pages charged until the pin ends, then frees them: {before} {held} {after}");
        store.Release([set.ResultId]);
        check(store.UsedBytes == 0 && store.WindowCacheBytes == 0, "releasing a demoted set gives back everything: " + store.UsedBytes);
        var released = TextChecks.Synthetic(store, "W1", 10);
        store.Release([released.ResultId]);
        var late = new RemoteResult(store, released.ResultId, released.Wires, 10, false, 100, 16L << 20, new SemaphoreSlim(4), new Blocks().Fetch);
        check(!store.Demote(released, late, 10) && store.UsedBytes == 0, "a released set does not demote");
    }
}
