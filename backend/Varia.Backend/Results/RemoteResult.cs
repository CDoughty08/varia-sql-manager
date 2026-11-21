namespace Varia.Backend.Results;

/// <summary>A page of a windowed result's rows as the cache keeps it: sealed as results.read sends it.</summary>
internal sealed record RemotePage(long FirstRow, int Rows, byte[] Body, PageLengths Lengths)
{
    /// <summary>What the page costs the cache: as a stored page would cost the store.</summary>
    public long Cost => Body.Length + ResultStore.PageOverhead + Lengths.MemoryBytes;
}

/// <summary>Builds a block's rows into pages for <see cref="RemoteResult"/>, from its first row on; the engine's reader writes
/// each row's cells as a query's reader does (BigQueryColumnPlan).</summary>
internal sealed class RemoteBlockWriter(uint resultId, IReadOnlyList<WireKind> wires, long firstRow)
{
    private readonly PageBuilder builder = new(resultId, wires, firstRow);
    private readonly List<RemotePage> pages = [];
    private bool open;

    /// <summary>The rows written so far.</summary>
    public long Rows { get; private set; }

    public PageBuilder BeginRow()
    {
        builder.BeginRow();
        open = true;
        return builder;
    }

    public void CommitRow()
    {
        builder.CommitRow();
        open = false;
        Rows++;
        if (builder.IsFull) Seal();
    }

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
        pages.Add(new RemotePage(first, rows, body, lengths));
    }

    /// <summary>The pages written, the last one sealed.</summary>
    public List<RemotePage> Finish()
    {
        AbortRow();
        if (builder.HasRows) Seal();
        return pages;
    }
}

/// <summary>Reads rows [firstRow, firstRow + rows) of a remote table into the writer (fewer at the table's end), or throws
/// <see cref="RemoteExpiredException"/> once the table is gone.</summary>
internal delegate Task RemoteFetch(long firstRow, int rows, RemoteBlockWriter writer, CancellationToken token);

/// <summary>The remote table is gone (BigQuery's 24-hour result table expired or was dropped): REMOTE_EXPIRED.</summary>
internal sealed class RemoteExpiredException(Exception? inner = null) : Exception("The result table is gone.", inner);

/// <summary>
/// A windowed result (docs/bigquery.md, Windowed results): its rows stay in a remote table and are read in blocks sized by
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
    public RemoteResult(ResultStore store, uint resultId, IReadOnlyList<WireKind> wires, long rows, bool capped, double rowBytes, long cacheLimit,
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
        BlockRows = BlockRowsFor(rowBytes);
    }

    /// <summary>A block's rows for a row's measured bytes: about <see cref="TargetBlockBytes"/>, clamped.</summary>
    public static int BlockRowsFor(double rowBytes) => (int)Math.Clamp(TargetBlockBytes / Math.Max(1, rowBytes), MinBlockRows, MaxBlockRows);

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

    /// <summary>The blocks cached, in order (checks).</summary>
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
            ObjectDisposedException.ThrowIf(disposed.IsCancellationRequested, this);
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
                    Task? fetching;
                    lock (gate)
                    {
                        if (block.Filled >= need) break;
                        if (expired) throw new RemoteExpiredException();
                        fetching = block.Fetching;
                    }
                    fetching ??= Ensure(block, 0, need);
                    // Nothing to wait for: the rows came meanwhile, the table is gone, or the result was released.
                    if (fetching is null)
                    {
                        lock (gate) if (block.Filled >= need || expired) continue;
                        throw new ObjectDisposedException(nameof(RemoteResult));
                    }
                    try { await fetching.WaitAsync(limit.Token); }
                    // The read's own wait passed: it answers with the rows it has, and the grid draws the rest as loading.
                    catch (OperationCanceledException) when (limit.IsCancellationRequested && !token.IsCancellationRequested) { return next; }
                    // A read-ahead fetch cancelled under this read (its viewer jumped): asked for again as the read's own.
                    catch (OperationCanceledException) when (!token.IsCancellationRequested && !disposed.IsCancellationRequested) { }
                }
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
            }
            return next;
        }
        finally
        {
            lock (gate) foreach (var block in targets) block.Waiters--;
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
            if (disposed.IsCancellationRequested || expired || block.Filled >= need) return block.Fetching;
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
                    if (block.Fetching == done) { block.Fetching = null; block.Stop = null; block.AheadOf = 0; }
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
                // room; what it really cost is settled once its pages are built. At most half the cache, so very wide rows (a
                // block of the fewest rows past the cache) still read: the overrun is charged when the pages are built.
                var estimate = Math.Min((long)Math.Ceiling(rows * rowBytes * 1.25) + ResultStore.PageOverhead, CacheLimit / 2);
                Reserve(estimate, block);
                var writer = new RemoteBlockWriter(resultId, wires, from);
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
                else if (cost > estimate && !store.TryReserveCache(ref held, long.MaxValue, cost - estimate)) Force(cost - estimate);
                lock (gate)
                {
                    if (disposed.IsCancellationRequested || !blocks.ContainsKey(block.Index))
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

    /// <summary>Reserves a block's bytes in the cache, evicting the least recent blocks no read waits for; TOO_LARGE when even an
    /// empty cache has no room for it (the global budget is full).</summary>
    private void Reserve(long bytes, Block keep)
    {
        while (!store.TryReserveCache(ref held, CacheLimit, bytes))
        {
            Block? victim;
            lock (gate)
            {
                victim = lru.FirstOrDefault(block => block != keep && block.Waiters == 0 && block.Fetching is null && block.Bytes > 0);
                if (victim is not null) EvictLocked(victim);
            }
            if (victim is null) throw new RequestException("TOO_LARGE", "There is not enough result memory to read these rows from BigQuery. Close other results and try again.");
        }
    }

    /// <summary>A block whose pages came out larger than estimated keeps them: the difference is charged whatever the limit.</summary>
    private void Force(long bytes)
    {
        Interlocked.Add(ref held, bytes);
        store.ForceCache(bytes);
    }

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
            var jump = viewer.First >= 0 && (first > viewer.Last + 2 || last < viewer.First - 2);
            if (viewer.First >= 0) viewer.Direction = first > viewer.First ? 1 : first < viewer.First ? -1 : viewer.Direction;
            if (jump)
                foreach (var block in blocks.Values.Where(block => block.AheadOf == key && block.Waiters == 0 && block.Fetching is not null)) block.Stop?.Cancel();
            viewer.First = first;
            viewer.Last = last;
            var maxBlock = (Rows - 1) / BlockRows;
            foreach (var index in new[] { first - 1, last + 1, viewer.Direction > 0 ? last + 2 : first - 2 })
                if (index >= 0 && index <= maxBlock) ahead.Add(BlockLocked(index));
        }
        foreach (var block in ahead) _ = Ensure(block, key, block.End);
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
