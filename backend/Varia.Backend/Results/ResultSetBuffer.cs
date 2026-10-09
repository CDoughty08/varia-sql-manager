namespace Varia.Backend.Results;

/// <summary>A sealed page: its first row, row count and the exact bytes that were (and will again be) written to main.</summary>
internal sealed record StoredPage(long FirstRow, int Rows, byte[] Body);

/// <summary>One stored result set: an append-only page directory that results.read serves, and, while the set is open,
/// the page being built. One query task writes; readers, progress events and releases may run concurrently.
/// Budget: each sealed page costs its length plus <see cref="ResultStore.PageOverhead"/>, and the builder's buffers are
/// charged as they grow; both come from reservations taken in 256 KiB steps.</summary>
internal sealed class ResultSetBuffer
{
    private static readonly TimeSpan FirstPageDelay = TimeSpan.FromMilliseconds(20);
    private static readonly TimeSpan IdleSealDelay = TimeSpan.FromMilliseconds(200);
    private readonly object gate = new();
    private readonly ResultStore store;
    private readonly List<StoredPage> pages = [];
    private PageBuilder? builder;
    private long charged, slack, working, pending;
    private long rowsRead, rowsStored, rowsAvailable, bytesStored, truncatedCells;
    private long firstRowAt;
    private int truncated;
    private int state;
    private volatile bool incomplete;

    internal ResultSetBuffer(ResultStore store, QueryBudget budget, uint resultId, int index, int batchNumber, int iteration, string kind, IReadOnlyList<ResultColumn> columns, IReadOnlyList<WireKind> wires)
    {
        this.store = store;
        Budget = budget;
        ResultId = resultId;
        Index = index;
        BatchNumber = batchNumber;
        Iteration = iteration;
        Kind = kind;
        Columns = columns;
        Wires = wires;
        builder = new PageBuilder(resultId, wires);
    }

    public QueryBudget Budget { get; }
    public uint ResultId { get; }
    public int Index { get; }
    public int BatchNumber { get; }
    public int Iteration { get; }
    public string Kind { get; }
    public IReadOnlyList<ResultColumn> Columns { get; }
    public IReadOnlyList<WireKind> Wires { get; }
    /// <summary>The statement producing this set stopped early (an error, cancellation or timeout).</summary>
    public bool Incomplete { get => incomplete; set => incomplete = value; }
    public bool IsOpen => Volatile.Read(ref state) == 0;
    public bool IsComplete => Volatile.Read(ref state) == 1;
    public bool IsReleased => Volatile.Read(ref state) == 2;
    public TruncationReason Truncated => (TruncationReason)Volatile.Read(ref truncated);
    public long RowsRead => Interlocked.Read(ref rowsRead);
    public long RowsAvailable { get { lock (gate) return rowsAvailable; } }
    /// <summary>Rows waiting in the page being built.</summary>
    public bool HasPendingRows { get { lock (gate) return builder?.HasRows == true; } }

    /// <summary>How long ingestion may wait for the next row before sealing what it has: the first page is sealed 20 ms
    /// after its first row, later pages after 200 ms without a row. Null when nothing waits.</summary>
    public TimeSpan? SealDelay
    {
        get
        {
            lock (gate)
            {
                if (builder?.HasRows != true) return null;
                if (pages.Count > 0) return IdleSealDelay;
                var waited = TimeSpan.FromMilliseconds(Environment.TickCount64 - firstRowAt);
                return waited >= FirstPageDelay ? TimeSpan.Zero : FirstPageDelay - waited;
            }
        }
    }

    /// <summary>Counts a row read from the server, whether or not it is stored.</summary>
    public void CountRow() => Interlocked.Increment(ref rowsRead);

    /// <summary>Records why a row was not stored; the first reason sticks.</summary>
    public void Skip(TruncationReason reason) => Interlocked.CompareExchange(ref truncated, (int)reason, 0);

    /// <summary>The builder for the next row, or null when this set stores nothing more (released, or its query stopped).</summary>
    public PageBuilder? BeginRow()
    {
        lock (gate)
        {
            if (builder is null || state != 0) return null;
            if (Budget.Stopped is var stopped and not TruncationReason.None) { Skip(stopped); return null; }
            builder.BeginRow();
            return builder;
        }
    }

    /// <summary>Commits the open row if the budget has room for it and for the builder's growth; otherwise rolls it back,
    /// so a page never holds a partial row, and stops the query from storing more. Returns whether the row was stored.</summary>
    public bool TryCommitRow(int truncatedCellsInRow = 0)
    {
        lock (gate)
        {
            if (builder is null) return false;
            var growth = Math.Max(0, builder.WorkingBytes - working);
            var rowBytes = builder.OpenRowBytes + 4L * Wires.Count;
            var need = growth + rowBytes;
            if (state != 0 || (need > slack && !Reserve(need - slack)))
            {
                builder.AbortRow();
                return false;
            }
            slack -= need;
            working += growth;
            pending += rowBytes;
            builder.CommitRow();
            rowsStored++;
            truncatedCells += truncatedCellsInRow;
            if (builder.RowCount == 1) firstRowAt = Environment.TickCount64;
            if (builder.IsFull || (pages.Count == 0 && builder.RowCount >= PageBuilder.FirstPageRows)) SealLocked();
            return true;
        }
    }

    /// <summary>Rolls back a row whose cells could not all be read (the provider failed mid-row).</summary>
    public void AbortRow()
    {
        lock (gate) builder?.AbortRow();
    }

    /// <summary>Seals the rows waiting in the builder, so results.read can serve them.</summary>
    public void Seal()
    {
        lock (gate) SealLocked();
    }

    private void SealLocked()
    {
        if (builder is null || !builder.HasRows) return;
        var first = builder.FirstRow;
        var rows = builder.RowCount;
        var page = builder.Seal();
        var cost = page.Length + ResultStore.PageOverhead;
        // The rows were reserved as they were committed; the page header and alignment add a little.
        var extra = cost - pending;
        if (extra <= slack) slack -= extra;
        else
        {
            store.Force(Budget, extra - slack);
            charged += extra - slack;
            slack = 0;
        }
        pending = 0;
        pages.Add(new StoredPage(first, rows, page));
        rowsAvailable += rows;
        bytesStored += page.Length;
        // Checked at every seal: under memory pressure the page just sealed is kept, and nothing more is stored.
        if (store.IsSystemMemoryLow()) Budget.Stop(TruncationReason.SystemMemory);
    }

    private bool Reserve(long bytes)
    {
        var step = Math.Max(bytes, ResultStore.ReserveStep);
        if (store.TryReserve(Budget, step, false, out var reason) || (step > bytes && store.TryReserve(Budget, step = bytes, false, out reason)))
        {
            slack += step;
            charged += step;
            return true;
        }
        Skip(reason);
        Budget.Stop(reason);
        return false;
    }

    /// <summary>Charged at once, whatever the budget.</summary>
    internal void Charge(long bytes)
    {
        lock (gate)
        {
            store.Force(Budget, bytes);
            charged += bytes;
        }
    }

    /// <summary>Seals the last rows and returns the builder's memory: the set is complete.</summary>
    public void Complete()
    {
        lock (gate)
        {
            if (state != 0) return;
            builder?.AbortRow();
            SealLocked();
            ReturnLocked(slack + working + pending);
            slack = working = pending = 0;
            builder = null;
            state = 1;
        }
    }

    /// <summary>Drops every page and returns all memory charged for this set; in-flight reads stop after their current page.</summary>
    internal long Release()
    {
        lock (gate)
        {
            state = 2;
            builder = null;
            pages.Clear();
            var freed = charged;
            ReturnLocked(charged);
            slack = working = pending = 0;
            return freed;
        }
    }

    private void ReturnLocked(long bytes)
    {
        store.Return(Budget, bytes);
        charged -= bytes;
    }

    /// <summary>The sealed pages that overlap [firstRow, firstRow + maxRows), in order.</summary>
    public IReadOnlyList<StoredPage> PagesFor(long firstRow, int maxRows)
    {
        lock (gate)
        {
            // Stored rows are a prefix of the rows read, so pages are contiguous: find the first page ending after firstRow.
            int low = 0, high = pages.Count;
            while (low < high)
            {
                var middle = (low + high) >>> 1;
                if (pages[middle].FirstRow + pages[middle].Rows <= firstRow) low = middle + 1;
                else high = middle;
            }
            var end = firstRow + maxRows;
            var result = new List<StoredPage>();
            for (var i = low; i < pages.Count && pages[i].FirstRow < end; i++) result.Add(pages[i]);
            return result;
        }
    }

    public ResultDescriptor Describe()
    {
        lock (gate)
        {
            var reason = Truncated;
            return new ResultDescriptor(ResultId, Index, BatchNumber, Iteration, Kind, Columns, RowsRead, rowsStored, rowsAvailable, bytesStored, truncatedCells,
                state switch { 0 => "open", 1 => "complete", _ => "released" }, reason == TruncationReason.None ? null : Name(reason), Incomplete);
        }
    }

    /// <summary>Counters for a progress event.</summary>
    public (uint ResultId, long RowsRead, long RowsStored, long RowsAvailable, long BytesStored) Progress()
    {
        lock (gate) return (ResultId, RowsRead, rowsStored, rowsAvailable, bytesStored);
    }

    public static string Name(TruncationReason reason) => reason switch
    {
        TruncationReason.RowLimit => "rowLimit",
        TruncationReason.QueryBudget => "queryBudget",
        TruncationReason.GlobalBudget => "globalBudget",
        TruncationReason.SystemMemory => "systemMemory",
        _ => throw new ArgumentOutOfRangeException(nameof(reason))
    };
}
