namespace Varia.Backend.Results;

/// <summary>A page of a windowed result's rows as the cache keeps it: sealed as results.read sends it.</summary>
internal sealed record RemotePage(long FirstRow, int Rows, byte[] Body, PageLengths Lengths)
{
    /// <summary>What the page costs the cache: as a stored page would cost the store.</summary>
    public long Cost => Body.Length + ResultStore.PageOverhead + Lengths.MemoryBytes;
}

/// <summary>Builds a block's rows into pages for <see cref="RemoteResult"/>, from its first row on; the engine's reader writes
/// each row's cells as a query's reader does (BigQueryColumnPlan).</summary>
internal sealed class RemoteBlockWriter(uint resultId, IReadOnlyList<WireKind> wires, long firstRow, long maxBytes = long.MaxValue)
{
    private readonly PageBuilder builder = new(resultId, wires, firstRow);
    private readonly List<RemotePage> pages = [];
    private bool open;
    private long bytes;

    /// <summary>The rows written so far.</summary>
    public long Rows { get; private set; }

    public PageBuilder BeginRow()
    {
        builder.BeginRow();
        open = true;
        return builder;
    }

    /// <summary>Commits the row; past <c>maxBytes</c> of sealed pages (rows much wider than the first page's, which sized the
    /// block) the block is refused before it grows further: TOO_LARGE.</summary>
    public void CommitRow()
    {
        builder.CommitRow();
        open = false;
        Rows++;
        if (builder.IsFull) Seal();
        if (bytes > maxBytes) throw BlockTooLarge();
    }

    internal static RequestException CacheTooSmall() =>
        new("TOO_LARGE", "The window cache is too small for these rows while other reads of this result hold it. Raise Block cache per windowed result in Tools › Options › Query Results › BigQuery › Results, or select fewer columns.");

    internal static RequestException BlockTooLarge() =>
        new("TOO_LARGE", "These rows are too wide for the window cache. Raise Block cache per windowed result in Tools › Options › Query Results › BigQuery › Results, or select fewer columns.");

    public void AbortRow()
    {
        if (open) builder.AbortRow();
        open = false;
    }

    private void Seal()
    {
        var first = builder.FirstRow;
        var rows = builder.RowCount;
        var body = builder.Seal(out var lengths);
        var page = new RemotePage(first, rows, body, lengths);
        pages.Add(page);
        bytes += page.Cost;
    }

    /// <summary>The pages written, the last one sealed: a block whose last page takes it past <c>maxBytes</c> is refused too, so
    /// no block costs more than its cache holds.</summary>
    public List<RemotePage> Finish()
    {
        AbortRow();
        if (builder.HasRows) Seal();
        if (bytes > maxBytes) throw BlockTooLarge();
        return pages;
    }
}

/// <summary>Reads rows [firstRow, firstRow + rows) of a remote table into the writer (fewer at the table's end), or throws
/// <see cref="RemoteExpiredException"/> once the table is gone.</summary>
internal delegate Task RemoteFetch(long firstRow, int rows, RemoteBlockWriter writer, CancellationToken token);

/// <summary>The remote table is gone (BigQuery's 24-hour result table expired or was dropped): REMOTE_EXPIRED.</summary>
internal sealed class RemoteExpiredException(Exception? inner = null) : Exception("The result table is gone.", inner);

/// <summary>A block's fetch stopped backing off on rate limits (no read is left waiting for it): a read that joined it
/// answers with the rows it has, and the next read asks again.</summary>
internal sealed class RemoteRetryException(Exception inner) : Exception("BigQuery's rate limit was reached.", inner);

/// <summary>
/// A windowed result (docs/bigquery.md, Residence): its rows stay in a remote table and are read in blocks sized by
/// bytes (about <see cref="TargetBlockBytes"/> of display text, <see cref="MinBlockRows"/> to <see cref="MaxBlockRows"/>
/// rows) into an LRU cache of whole pages, charged to the global budget up to its own limit
/// (<see cref="ResultStore.TryReserveCache"/>) and released with the result. Fetches run on their own lane: at most two per
/// result and a lane per connection (four), never a results.* slot. A read waits for its blocks within its own wait and
/// answers with the rows it has once that passes. Each viewer (a grid, a popout, Transpose) reads ahead apart: the blocks
/// on either side of its last read plus one more in its direction of travel; a jump cancels that viewer's stale read-ahead.
/// Nothing here touches the store's pages: a windowed result has none.
/// </summary>
internal sealed class RemoteResult : IDisposable
{
    public const int TargetBlockBytes = 4 << 20;
    public const int MinBlockRows = 256;
    public const int MaxBlockRows = 16_384;
    public const long DefaultCacheBytes = 64L << 20;
    /// <summary>The grid addresses rows with 32-bit indexes: a windowed result shows this many at most (decision 31).</summary>
    public const long MaxRows = int.MaxValue;
    /// <summary>Fetches of one result at once; the connection's lane allows more across its results.</summary>
    public const int FetchesPerResult = 2;
    public const int FetchesPerConnection = 4;

    private readonly ResultStore store;
    private readonly uint resultId;
    private readonly IReadOnlyList<WireKind> wires;
    private readonly RemoteFetch fetch;
    private readonly SemaphoreSlim connectionLane;
    private readonly SemaphoreSlim resultLane = new(FetchesPerResult);
    private readonly double rowBytes;
    private readonly object gate = new();
    private readonly Dictionary<long, Block> blocks = [];
    /// <summary>Blocks by use, oldest first.</summary>
    private readonly LinkedList<Block> lru = new();
    private readonly Dictionary<uint, Viewer> viewers = [];
    private readonly CancellationTokenSource disposed = new();
    private long held;
    private long fetches, evictions;
    private bool expired;

    private sealed class Block(long index, long first, long end)
    {
        public readonly long Index = index, First = first, End = end;
        public readonly List<RemotePage> Pages = [];
        /// <summary>The rows cached are [First, Filled).</summary>
        public long Filled = first;
        public long Bytes;
        public Task? Fetching;
        public CancellationTokenSource? Stop;
        /// <summary>Reads waiting for or sending this block: it is not evicted meanwhile, nor its read-ahead cancelled.</summary>
        public int Waiters;
        /// <summary>The viewer whose read-ahead started the running fetch, or 0 for a read's own.</summary>
        public uint AheadOf;
        /// <summary>The running fetch holds its estimate in the cache, and whether it is settling an overrun (an overrun waits
        /// only for fetches holding room that are not themselves waiting, so two never wait for each other).</summary>
        public bool Holding, Settling;
        public LinkedListNode<Block>? Node;
    }

    private sealed class Viewer
    {
        public long First = -1, Last = -1;
        public int Direction = 1;
    }

    /// <param name="rows">The rows the grid shows: BigQuery's total, capped at <see cref="MaxRows"/> and a row limit.</param>
    /// <param name="rowBytes">A row's measured cost in pages (from the first page), which sizes blocks.</param>
    /// <param name="cacheLimit">The cache's own limit (queryResults.bigQuery.windowCacheMiB).</param>
    internal static RemoteResult Create(ResultStore store, uint resultId, IReadOnlyList<WireKind> wires, long rows, bool capped, double rowBytes, long cacheLimit,
        SemaphoreSlim connectionLane, RemoteFetch fetch, object? source = null) => new(store, resultId, wires, rows, capped, rowBytes, cacheLimit, connectionLane, fetch) { Source = source };

    // Private: a cache is built only through Create, which only the residence code calls (tests/result-page-access.test.ts),
    // where every switch bumps the revision, sends resultSet.residence and settles the budget.
    private RemoteResult(ResultStore store, uint resultId, IReadOnlyList<WireKind> wires, long rows, bool capped, double rowBytes, long cacheLimit,
        SemaphoreSlim connectionLane, RemoteFetch fetch)
    {
        this.store = store;
        this.resultId = resultId;
        this.wires = wires;
        this.fetch = fetch;
        this.connectionLane = connectionLane;
        this.rowBytes = Math.Max(1, rowBytes);
        Rows = rows;
        Capped = capped;
        CacheLimit = Math.Max(TargetBlockBytes, cacheLimit);
        BlockRows = BlockRowsFor(rowBytes, CacheLimit);
    }

    /// <summary>A block's rows for a row's measured bytes: about <see cref="TargetBlockBytes"/>, clamped to
    /// <see cref="MinBlockRows"/>..<see cref="MaxBlockRows"/>, but never more than half of <paramref name="cacheLimit"/> holds
    /// with the estimate's margin (one row at least), so two blocks of very wide rows, read and read ahead, fit the cache
    /// even when their rows come out a little wider than measured.</summary>
    public static int BlockRowsFor(double rowBytes, long cacheLimit = DefaultCacheBytes)
    {
        var bytes = Math.Max(1, rowBytes);
        var floor = (int)Math.Clamp(cacheLimit / 2 / (bytes * EstimateMargin), 1, MinBlockRows);
        return (int)Math.Clamp(TargetBlockBytes / bytes, floor, MaxBlockRows);
    }

    /// <summary>What a fetch of <paramref name="rows"/> rows is expected to cost in the cache.</summary>
    private long EstimateOf(int rows) => (long)Math.Ceiling(rows * rowBytes * EstimateMargin) + ResultStore.PageOverhead;

    /// <summary>The headroom a block's estimate allows over its measured rows.</summary>
    private const double EstimateMargin = 1.25;

    /// <summary>A whole block's expected cost, as its fetch reserves it.</summary>
    private long BlockEstimate => Math.Max(1, Math.Min(EstimateOf(BlockRows), CacheLimit / 2));

    public long Rows { get; }
    /// <summary>BigQuery holds more rows than <see cref="Rows"/> (the 32-bit cap or a row limit).</summary>
    public bool Capped { get; }
    public int BlockRows { get; }
    public long CacheLimit { get; }
    /// <summary>What the engine reads the rows from (its job and table), for Load into memory and later remote queries.</summary>
    public object? Source { get; init; }
    public long CachedBytes => Interlocked.Read(ref held);
    public long Fetches => Interlocked.Read(ref fetches);
    public long Evictions => Interlocked.Read(ref evictions);
    public bool Expired { get { lock (gate) return expired; } }

    /// <summary>Checks only: the blocks the cache lists, fetched or not.</summary>
    internal int ListedBlocks()
    {
        lock (gate) return blocks.Count;
    }

    /// <summary>Checks only: the blocks with a fetch running or queued.</summary>
    internal int FetchingBlocks()
    {
        lock (gate) return blocks.Values.Count(block => block.Fetching is not null);
    }

    /// <summary>The blocks cached, in order (checks).</summary>
    /// <summary>Checks only: what the cached blocks' pages cost, counted from the pages themselves.</summary>
    internal long CachedPageCost()
    {
        lock (gate) return blocks.Values.Sum(block => block.Pages.Sum(page => (long)page.Cost));
    }

    internal long[] CachedBlocks()
    {
        lock (gate) return [.. blocks.Values.Where(block => block.Filled > block.First).Select(block => block.Index).Order()];
    }

    /// <summary>Keeps rows already read (the first page, which the grid shows at once) in their blocks, if the cache has room.</summary>
    public void Seed(IReadOnlyList<RemotePage> pages)
    {
        foreach (var page in pages)
        {
            if (page.FirstRow >= Rows) break;
            lock (gate)
            {
                var block = BlockLocked(page.FirstRow / BlockRows);
                // Only a page that continues the block's rows and stays inside it.
                if (page.FirstRow != block.Filled || page.FirstRow + page.Rows > block.End || block.Fetching is not null) continue;
                if (!store.TryReserveCache(ref held, CacheLimit, page.Cost)) return;
                block.Pages.Add(page);
                block.Filled = page.FirstRow + page.Rows;
                block.Bytes += page.Cost;
            }
        }
    }

    /// <summary>
    /// Sends the cached pages that cover [firstRow, firstRow + maxRows) in order, fetching the blocks not cached (a read's own
    /// first, then its viewer's read-ahead). Waits for them within <paramref name="wait"/> (and <paramref name="token"/>), then
    /// answers with the rows sent so far. Returns the row after the last one sent. Throws <see cref="RemoteExpiredException"/>
    /// once the table is gone and the rows asked are not cached, and a fetch's own failure.
    /// </summary>
    public async Task<long> ReadAsync(long firstRow, int maxRows, uint viewer, Func<byte[], ValueTask> send, TimeSpan wait, CancellationToken token)
    {
        var end = Math.Min(Rows, firstRow + maxRows);
        if (firstRow >= end) return firstRow;
        var first = firstRow / BlockRows;
        var last = (end - 1) / BlockRows;
        var targets = new List<Block>();
        lock (gate)
        {
            if (disposed.IsCancellationRequested) return firstRow;
            for (var index = first; index <= last; index++)
            {
                var block = BlockLocked(index);
                block.Waiters++;
                Touch(block);
                targets.Add(block);
            }
        }
        try
        {
            // The read's own blocks are asked for first, in order, then its viewer's read-ahead.
            foreach (var block in targets) _ = Ensure(block, 0, Math.Min(end, block.End));
            ReadAhead(viewer, first, last);
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
            limit.CancelAfter(wait);
            var next = firstRow;
            foreach (var block in targets)
            {
                var need = Math.Min(end, block.End);
                while (true)
                {
                    Task? fetching = null;
                    var gone = false;
                    lock (gate)
                    {
                        if (block.Filled >= need) break;
                        gone = expired;
                        // Released, or replaced by Load into memory: the rows sent so far are the answer (the caller tells a
                        // release apart), and the grid reads again under the new revision.
                        if (!gone && disposed.IsCancellationRequested) return next;
                        if (!gone) fetching = block.Fetching;
                    }
                    // The table is gone: the cached rows are the answer, a part-filled block's included (the seeded first
                    // page); none at all is REMOTE_EXPIRED.
                    if (gone)
                    {
                        next = await SendHeldAsync(block, next);
                        return next > firstRow ? next : throw new RemoteExpiredException();
                    }
                    fetching ??= Ensure(block, 0, need);
                    // Nothing to wait for: the rows came meanwhile, the table is gone, or the cache was disposed; the loop says which.
                    if (fetching is null) continue;
                    try { await fetching.WaitAsync(limit.Token); }
                    // The read's own wait passed: it answers with the rows it has, those of a part-filled block too, and the
                    // grid draws the rest as loading.
                    catch (OperationCanceledException) when (limit.IsCancellationRequested && !token.IsCancellationRequested) { return await SendHeldAsync(block, next); }
                    // A read-ahead fetch cancelled under this read (its viewer jumped), or the cache disposed under it: the loop
                    // asks again as the read's own, or answers with the rows sent.
                    catch (OperationCanceledException) when (!token.IsCancellationRequested) { }
                    // Gone under this read, or refused room (a read across more blocks than the cache holds): the rows it has
                    // are the answer, and the grid reads the rest again from there; none at all is the error.
                    catch (RemoteExpiredException)
                    {
                        next = await SendHeldAsync(block, next);
                        if (next > firstRow) return next;
                        throw;
                    }
                    // Rate limited for longer than a read waits: the rows it has are the answer, never an error.
                    catch (RemoteRetryException) { return await SendHeldAsync(block, next); }
                    // Any other failure of the block's fetch (BigQuery's error, a connection lost past its retries): the same.
                    catch (Exception error) when (error is not OperationCanceledException)
                    {
                        next = await SendHeldAsync(block, next);
                        if (next > firstRow) return next;
                        throw;
                    }
                }
                next = await SendHeldAsync(block, next);
            }
            return next;

            // Sends the block's cached pages that continue the rows sent, up to the read's end: all of a filled block, the
            // leading pages of a part-filled one. Answers where the rows sent now end.
            async Task<long> SendHeldAsync(Block block, long next)
            {
                RemotePage[] pages;
                lock (gate) pages = [.. block.Pages];
                foreach (var page in pages)
                {
                    if (page.FirstRow + page.Rows <= next) continue;
                    if (page.FirstRow > next || page.FirstRow >= end) break;
                    token.ThrowIfCancellationRequested();
                    await send(page.Body);
                    next = page.FirstRow + page.Rows;
                }
                return next;
            }
        }
        finally
        {
            lock (gate)
            {
                foreach (var block in targets)
                {
                    // A fetch this read asked for that no read now waits for (the read was cancelled or answered short)
                    // becomes its viewer's read-ahead: the viewer's next read nearby joins it, and a jump cancels it.
                    if (--block.Waiters == 0 && block.Fetching is not null && block.AheadOf == 0) block.AheadOf = viewer == 0 ? uint.MaxValue : viewer;
                    DropIfIdleLocked(block);
                }
                TrimLocked();
            }
        }
    }

    /// <summary>Each row's bytes from the cache only (results.rowBytes runs on the control lane and never fetches): as far as
    /// the cached rows from <paramref name="firstRow"/> go, fewer or none past them.</summary>
    public long[] RowBytes(long firstRow, int count)
    {
        var result = new List<long>(Math.Min(count, 4096));
        lock (gate)
        {
            var row = firstRow;
            while (result.Count < count && row < Rows)
            {
                if (!blocks.TryGetValue(row / BlockRows, out var block) || row >= block.Filled) break;
                var page = block.Pages.FirstOrDefault(page => page.FirstRow <= row && row < page.FirstRow + page.Rows);
                if (page is null) break;
                for (var at = (int)(row - page.FirstRow); at < page.Rows && result.Count < count; at++, row++) result.Add(page.Lengths.RowBytes(at));
            }
        }
        return [.. result];
    }

    private Block BlockLocked(long index)
    {
        if (blocks.TryGetValue(index, out var block)) return block;
        block = new Block(index, index * BlockRows, Math.Min(Rows, (index + 1) * BlockRows));
        blocks[index] = block;
        block.Node = lru.AddLast(block);
        return block;
    }

    /// <summary>A block nothing fetched (cancelled, refused or failed) that no read waits for leaves the cache's lists, so
    /// the blocks a scroll passed over are not kept.</summary>
    private void DropIfIdleLocked(Block block)
    {
        if (block.Node is null || block.Waiters > 0 || block.Fetching is not null || block.Bytes > 0 || block.Filled > block.First) return;
        blocks.Remove(block.Index);
        lru.Remove(block.Node);
        block.Node = null;
    }

    private void Touch(Block block)
    {
        if (block.Node is null) return;
        lru.Remove(block.Node);
        lru.AddLast(block.Node);
    }

    /// <summary>Starts the block's fetch from its cached rows to <paramref name="need"/>'s block end, unless one runs or the rows
    /// are cached; <paramref name="aheadOf"/> names the viewer whose read-ahead asks. Returns the running fetch, or null.</summary>
    private Task? Ensure(Block block, uint aheadOf, long need)
    {
        lock (gate)
        {
            // A block evicted since it was looked up is no longer the cache's: a fetch for it would charge bytes nothing frees.
            if (disposed.IsCancellationRequested || expired || block.Filled >= need || block.Node is null) return block.Fetching;
            if (block.Fetching is { } running)
            {
                // A read now needs a block its viewer's read-ahead is fetching: it is the read's own from here.
                if (aheadOf == 0) block.AheadOf = 0;
                return running;
            }
            var stop = CancellationTokenSource.CreateLinkedTokenSource(disposed.Token);
            block.Stop = stop;
            block.AheadOf = aheadOf;
            var task = FetchAsync(block, stop.Token);
            block.Fetching = task;
            _ = task.ContinueWith(done =>
            {
                lock (gate)
                {
                    if (block.Fetching == done) { block.Fetching = null; block.Stop = null; block.AheadOf = 0; block.Holding = block.Settling = false; }
                    DropIfIdleLocked(block);
                    TrimLocked();
                }
                stop.Dispose();
                // Observed here: a failure reaches the reads awaiting it, and a read-ahead's has no one to tell.
                _ = done.Exception;
            }, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            return task;
        }
    }

    private async Task FetchAsync(Block block, CancellationToken token)
    {
        // Off the caller's thread: a read's request never runs the fetch inline.
        await Task.Yield();
        await resultLane.WaitAsync(token);
        try
        {
            await connectionLane.WaitAsync(token);
            try
            {
                long from;
                lock (gate) from = block.Filled;
                var rows = (int)(block.End - from);
                if (rows <= 0) return;
                // The block's estimated cost is reserved before it is read, evicting this result's least recent blocks for
                // room; what it really cost is settled once its pages are built (BlockRowsFor keeps a block within half the
                // cache, so the estimate is capped there): an overrun is reserved the same way, within the cache's limit.
                var estimate = Math.Min(EstimateOf(rows), CacheLimit / 2);
                if (!Reserve(estimate, block))
                {
                    // The cache's own limit, held by blocks reads wait for (this read's others, or another grid's). A block
                    // only read ahead stops, nothing fetched (a read that joins it answers short and asks again); one a read
                    // waits for passes the limit, up to twice it, as an overrun may, and the cache trims back after.
                    bool waited;
                    lock (gate) waited = block.Waiters > 0;
                    if (!waited) throw new RemoteRetryException(RemoteBlockWriter.CacheTooSmall());
                    if (!store.TryReserveCache(ref held, OverLimit, estimate, out var full)) throw full ? RemoteBlockWriter.CacheTooSmall() : BudgetFull();
                }
                lock (gate) block.Holding = true;
                // Never more than the cache holds: a block whose rows grew far wider than the first page's stops being built.
                var writer = new RemoteBlockWriter(resultId, wires, from, CacheLimit);
                List<RemotePage> pages;
                try
                {
                    Interlocked.Increment(ref fetches);
                    await fetch(from, rows, writer, token);
                    pages = writer.Finish();
                }
                catch (RemoteExpiredException)
                {
                    store.ReturnCache(ref held, estimate);
                    lock (gate) expired = true;
                    throw;
                }
                catch
                {
                    store.ReturnCache(ref held, estimate);
                    throw;
                }
                var cost = pages.Sum(page => page.Cost);
                if (cost < estimate) store.ReturnCache(ref held, estimate - cost);
                else if (cost > estimate)
                {
                    try { await ReserveOverrunAsync(cost - estimate, block, token); }
                    catch
                    {
                        store.ReturnCache(ref held, estimate);
                        throw;
                    }
                }
                lock (gate)
                {
                    if (disposed.IsCancellationRequested || !blocks.TryGetValue(block.Index, out var cached) || cached != block)
                    {
                        store.ReturnCache(ref held, cost);
                        return;
                    }
                    block.Pages.AddRange(pages);
                    block.Bytes += cost;
                    // A table shorter than BigQuery said (it changed under the result): the rest stays loading.
                    block.Filled = writer.Rows < rows ? block.End : from + writer.Rows;
                }
            }
            finally { connectionLane.Release(); }
        }
        finally { resultLane.Release(); }
    }

    /// <summary>A block's overrun (rows wider than measured). Refused by the cache's own limit while other fetches of this result
    /// hold its room, it stops read-ahead no read waits for, waits once for the rest, then evicts as usual. When reads still
    /// hold every other block (a read's own blocks that do not fit the cache together), the overrun passes the cache's limit,
    /// up to twice it (OverLimit), for the global budget alone to refuse (TOO_LARGE): answering short instead would read the same
    /// block again on every read. The cache trims back to its limit once no read holds those blocks (<see cref="TrimLocked"/>).</summary>
    private async Task ReserveOverrunAsync(long bytes, Block keep, CancellationToken token)
    {
        for (var round = 0; ; round++)
        {
            if (Reserve(bytes, keep)) return;
            Task[] others;
            lock (gate)
            {
                keep.Settling = true;
                var holding = blocks.Values.Where(block => block != keep && block.Holding && !block.Settling && block.Fetching is not null).ToList();
                foreach (var block in holding) if (block.Waiters == 0 && block.AheadOf != 0) block.Stop?.Cancel();
                others = [.. holding.Select(block => block.Fetching!)];
            }
            if (others.Length == 0 || round > 0)
            {
                if (store.TryReserveCache(ref held, OverLimit, bytes, out var full)) return;
                // Past even that, the cache (not the global budget) is what refuses: say so, and how to raise it.
                throw full ? RemoteBlockWriter.CacheTooSmall() : BudgetFull();
            }
            // Each settles (a stopped one gives its estimate back); how is theirs to tell their own readers.
            try { await Task.WhenAll(others).WaitAsync(token); }
            catch (Exception) when (!token.IsCancellationRequested) { }
        }
    }

    /// <summary>What the cache may hold while blocks reads wait for pass its limit: twice it.</summary>
    private long OverLimit => CacheLimit * 2;

    /// <summary>Evicts the least recent blocks no read waits for while the cache is past its limit (after an overrun took room
    /// past it for a read's own blocks).</summary>
    private void TrimLocked()
    {
        while (Interlocked.Read(ref held) > CacheLimit)
        {
            var victim = lru.FirstOrDefault(block => block.Waiters == 0 && block.Fetching is null && block.Bytes > 0);
            if (victim is null) return;
            EvictLocked(victim);
        }
    }

    /// <summary>Reserves a block's bytes in the cache, evicting the least recent blocks no read waits for. False when the cache's
    /// own limit refuses with nothing left to evict (reads hold the rest); TOO_LARGE when the global budget is full.</summary>
    private bool Reserve(long bytes, Block keep)
    {
        while (!store.TryReserveCache(ref held, CacheLimit, bytes, out var full))
        {
            Block? victim;
            lock (gate)
            {
                victim = lru.FirstOrDefault(block => block != keep && block.Waiters == 0 && block.Fetching is null && block.Bytes > 0);
                if (victim is not null) EvictLocked(victim);
            }
            if (victim is null) return full ? false : throw BudgetFull();
        }
        return true;
    }

    private static RequestException BudgetFull() =>
        new("TOO_LARGE", "There is not enough result memory to read these rows from BigQuery. Close other results and try again.");

    private void EvictLocked(Block block)
    {
        blocks.Remove(block.Index);
        if (block.Node is not null) lru.Remove(block.Node);
        block.Node = null;
        var bytes = block.Bytes;
        block.Bytes = 0;
        block.Pages.Clear();
        block.Filled = block.First;
        Interlocked.Increment(ref evictions);
        store.ReturnCache(ref held, bytes);
    }

    /// <summary>The viewer's read-ahead: the blocks on either side of the read and one more in its direction. A jump past what
    /// the read-ahead covers cancels the fetches that viewer's earlier read-ahead started and no read waits for.</summary>
    private void ReadAhead(uint id, long first, long last)
    {
        // A read that names no viewer reads ahead as one viewer of its own; 0 marks a read's own fetch.
        var key = id == 0 ? uint.MaxValue : id;
        var ahead = new List<Block>();
        lock (gate)
        {
            if (!viewers.TryGetValue(id, out var viewer))
            {
                // Viewers come and go with grids: a few hundred at most are remembered.
                if (viewers.Count >= 256) viewers.Clear();
                viewers[id] = viewer = new Viewer();
            }
            // Nothing more can be fetched once the table is gone or the cache disposed: no blocks are listed for it.
            if (expired || disposed.IsCancellationRequested) return;
            var jump = viewer.First >= 0 && (first > viewer.Last + 2 || last < viewer.First - 2);
            if (viewer.First >= 0) viewer.Direction = first > viewer.First ? 1 : first < viewer.First ? -1 : viewer.Direction;
            viewer.First = first;
            viewer.Last = last;
            var maxBlock = (Rows - 1) / BlockRows;
            // Only as many blocks as the cache holds beside the read's own: more would evict the rows on screen.
            var room = CacheLimit / BlockEstimate - (last - first + 1);
            var chosen = new List<long>();
            // The block ahead in the direction of travel comes first: with room for one, the one behind is usually cached already.
            var order = viewer.Direction < 0 ? new[] { first - 1, last + 1, first - 2 } : new[] { last + 1, first - 1, last + 2 };
            foreach (var index in order)
                if (index >= 0 && index <= maxBlock && chosen.Count < room) chosen.Add(index);
            // A jump stops the earlier read-ahead, except blocks the new one wants: a cancelled fetch still running would be
            // joined by the new read-ahead and never fetch its block.
            if (jump)
                foreach (var block in blocks.Values.Where(block => block.AheadOf == key && block.Waiters == 0 && block.Fetching is not null && !chosen.Contains(block.Index))) block.Stop?.Cancel();
            foreach (var index in chosen) ahead.Add(BlockLocked(index));
        }
        foreach (var block in ahead)
        {
            AheadChosen?.Invoke(block.Index);
            _ = Ensure(block, key, block.End);
        }
    }

    /// <summary>Checks only: called once the read-ahead's blocks are chosen, outside the lock, before each one's fetch starts.</summary>
    internal Action<long>? AheadChosen { get; set; }

    /// <summary>Checks only: evicts the block as <see cref="Reserve"/> would, if no read waits for it and no fetch runs.</summary>
    internal void EvictForChecks(long index)
    {
        lock (gate) if (blocks.TryGetValue(index, out var block) && block.Waiters == 0 && block.Fetching is null) EvictLocked(block);
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed.IsCancellationRequested) return;
            disposed.Cancel();
            foreach (var block in blocks.Values.ToList()) EvictLocked(block);
            viewers.Clear();
        }
    }
}
