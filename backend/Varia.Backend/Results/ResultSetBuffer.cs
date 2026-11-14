namespace Varia.Backend.Results;

/// <summary>A sealed page: its first row, row count, the exact bytes that were (and will again be) written to main, and its
/// lengths sidecar, which never leaves the backend except through results.rowBytes. Its bytes are read only through
/// <see cref="Body"/> (its set's <see cref="ResultSetBuffer.Body"/>) while the set is pinned: the store may keep them in
/// another form, which only the accessor reads (tests/result-page-access.test.ts checks that no reader touches
/// <see cref="Stored"/>). A page with no set is one built for a single read (a view's pages in view order), whose bytes are
/// its own.</summary>
internal sealed class StoredPage(long firstRow, int rows, byte[] stored, PageLengths lengths, ResultSetBuffer? set = null)
{
    public long FirstRow { get; } = firstRow;
    public int Rows { get; } = rows;
    public PageLengths Lengths { get; } = lengths;
    /// <summary>The page's length as sealed (what results.read sends), whatever form the store keeps it in.</summary>
    public int Length { get; } = stored.Length;
    /// <summary>The set that stores the page, or null for a page built for one read.</summary>
    public ResultSetBuffer? Set { get; } = set;
    /// <summary>The bytes as the store keeps them. Only <see cref="ResultSetBuffer"/> reads this.</summary>
    internal byte[] Stored { get; } = stored;
    /// <summary>The page's bytes as sealed, through its set's accessor (<see cref="ResultSetBuffer.Body"/>). A call, not a
    /// field: hold the array while reading the page rather than asking again for every row.</summary>
    public byte[] Body() => Set is null ? Stored : Set.Body(this);
}

/// <summary>One stored result set: an append-only page directory that results.read serves, and, while the set is open,
/// the page being built. One query task writes; readers, progress events and releases may run concurrently.
/// Budget: each sealed page costs its length plus <see cref="ResultStore.PageOverhead"/> plus its lengths sidecar (4 bytes a
/// row, 24 per sparse cell entry, <see cref="PageLengths.MemoryBytes"/>), and the builder's buffers are charged as they
/// grow; both come from reservations taken in 256 KiB steps.
/// Copy and export jobs lease the set: a release during a job ends reads and stops storing at once, but its pages and
/// budget are freed only when the last lease ends, so re-executing or closing a tab never breaks a save.
/// Every reader of page bodies pins the set while it reads (<see cref="Pin"/>) and reads them through <see cref="Body"/>:
/// a release frees the pages and their budget only once the last pin and the last lease have ended, so the budget never
/// counts as free the pages a running sort or read still holds.</summary>
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
    private int sealedPages;
    private int leases;
    private int pins;
    private CancellationTokenSource? released;
    private bool freePending;
    private TruncationReason refused;
    private volatile bool incomplete;

    /// <param name="metadata">Bytes already reserved for the column metadata; returned with everything else on release.</param>
    internal ResultSetBuffer(ResultStore store, QueryBudget budget, uint resultId, int index, int batchNumber, int iteration, string kind, IReadOnlyList<ResultColumn> columns,
        IReadOnlyList<WireKind> wires, long metadata = 0, int sealBytes = PageBuilder.SealBytes, IReadOnlyList<ColumnLength>? lengths = null)
    {
        Lengths = lengths ?? [.. wires.Select(wire => wire == WireKind.Binary ? ColumnLength.Binary : ColumnLength.Utf16)];
        this.store = store;
        charged = metadata;
        Budget = budget;
        ResultId = resultId;
        Index = index;
        BatchNumber = batchNumber;
        Iteration = iteration;
        Kind = kind;
        Columns = columns;
        Wires = wires;
        builder = new PageBuilder(resultId, wires, sealBytes: sealBytes);
    }

    public QueryBudget Budget { get; }
    public uint ResultId { get; }
    public int Index { get; }
    public int BatchNumber { get; }
    public int Iteration { get; }
    public string Kind { get; }
    public IReadOnlyList<ResultColumn> Columns { get; }
    public IReadOnlyList<WireKind> Wires { get; }
    /// <summary>Each column's byte rule (ColumnPlan's; a live table's text counts as UTF-16).</summary>
    public IReadOnlyList<ColumnLength> Lengths { get; }
    /// <summary>The statement producing this set stopped early (an error, cancellation or timeout).</summary>
    public bool Incomplete { get => incomplete; set => incomplete = value; }
    public bool IsOpen => Volatile.Read(ref state) == 0;
    public bool IsComplete => Volatile.Read(ref state) == 1;
    public bool IsReleased => Volatile.Read(ref state) == 2;
    public TruncationReason Truncated => (TruncationReason)Volatile.Read(ref truncated);
    public long RowsRead => Interlocked.Read(ref rowsRead);
    public long RowsAvailable { get { lock (gate) return rowsAvailable; } }
    /// <summary>Pages sealed so far; read without the lock, so ingestion can tell that a row sealed one.</summary>
    public int SealedPages => Volatile.Read(ref sealedPages);
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

    /// <summary>A set made from stored results (a pivot, a diff), not read from the server: a refusal or low
    /// system memory fails only this set, which its caller then releases whole, and never stops its query from storing
    /// more, so a smaller one can still fit.</summary>
    public bool Derived { get; init; }

    /// <summary>The builder for the next row, or null when this set stores nothing more: released, its query stopped, or,
    /// for a derived set, a row the budget refused or a page sealed under low system memory.</summary>
    public PageBuilder? BeginRow()
    {
        lock (gate)
        {
            if (builder is null || state != 0) return null;
            if (Budget.Stopped is var stopped and not TruncationReason.None) { Skip(stopped); return null; }
            if (refused != TruncationReason.None) { Skip(refused); return null; }
            builder.BeginRow();
            return builder;
        }
    }

    /// <summary>Commits the open row if the budget has room for it and for the builder's growth; otherwise rolls it back,
    /// so a page never holds a partial row, and stops the query from storing more (a derived set stops only itself).
    /// Returns whether the row was stored.</summary>
    public bool TryCommitRow(int truncatedCellsInRow = 0)
    {
        lock (gate)
        {
            if (builder is null) return false;
            var growth = Math.Max(0, builder.WorkingBytes - working);
            var rowBytes = builder.OpenRowBytes + 4L * Wires.Count + builder.OpenRowLengthBytes;
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

    /// <summary>Makes sure the budget has room for rows of up to <paramref name="bytes"/> about to be written, so rows that
    /// belong together (a diff's changed pair) are stored both or neither. Their commits charge the rows (at most
    /// <paramref name="bytes"/>) and the builder's growth: what it grew by and is not charged for yet, and its buffers
    /// doubling, which adds at most their size and the rows' bytes again. False when it has not: the set stores nothing
    /// more and the query stops (a derived set leaves it open), as when a row is refused.</summary>
    public bool TryReserveRows(long bytes)
    {
        lock (gate)
        {
            if (builder is null || state != 0 || refused != TruncationReason.None) return false;
            var size = builder.WorkingBytes;
            var need = 2 * bytes + Math.Max(0, size - working) + size;
            return need <= slack || Reserve(need - slack);
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
        var page = builder.Seal(out var lengths);
        var cost = page.Length + ResultStore.PageOverhead + lengths.MemoryBytes;
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
        pages.Add(new StoredPage(first, rows, page, lengths, this));
        Volatile.Write(ref sealedPages, pages.Count);
        rowsAvailable += rows;
        bytesStored += page.Length;
        // Checked at every seal, the only low-memory check there is: the page just sealed is kept, and nothing more is
        // stored. A query's own set stops its query, at its last seal too, so later sets store nothing. A derived set stops
        // only itself, at its next row (its caller then refuses it whole), and the query can still store another. One whose
        // last seal sees pressure (the seal inside Complete, or its last row filling a page) asks for no row after it, so
        // it is whole and not truncated.
        if (!store.IsSystemMemoryLow()) return;
        if (Derived) refused = TruncationReason.SystemMemory;
        else Budget.Stop(TruncationReason.SystemMemory);
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
        // The first refusal ends the set, as it ends a query's: a later, smaller row must not be stored past the gap,
        // because stored rows are a prefix of the rows read. A derived set ends only itself.
        if (Derived) refused = reason;
        else Budget.Stop(reason);
        return false;
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

    /// <summary>Marks the set released, so in-flight reads stop after their current page and nothing more is stored, and
    /// returns the memory it frees: all of it, or nothing while a job holds a lease (the last lease frees it).</summary>
    internal long Release()
    {
        CancellationTokenSource? stop;
        long freed;
        lock (gate)
        {
            state = 2;
            builder = null;
            stop = released;
            if (leases > 0 || pins > 0)
            {
                freePending = true;
                freed = 0;
            }
            else freed = FreeLocked();
        }
        // Outside the lock: cancelling runs the operations' registrations inline.
        stop?.Cancel();
        return freed;
    }

    /// <summary>Cancelled when the set is released (already cancelled once it has been), so an operation over the whole
    /// result (a sort, profile, diff or pivot) stops at once rather than keeping the pages it pins, and their budget,
    /// until it finishes.</summary>
    public CancellationToken Released
    {
        get
        {
            lock (gate) return state == 2 ? new CancellationToken(true) : (released ??= new CancellationTokenSource()).Token;
        }
    }

    /// <summary>Keeps the pages and their budget for a copy or export until <see cref="ReleaseLease"/>; false once the set
    /// has been released.</summary>
    public bool TryLease()
    {
        lock (gate)
        {
            if (state == 2) return false;
            leases++;
            return true;
        }
    }

    /// <summary>Ends a lease. The last one frees a set that was released while it was held.</summary>
    public void ReleaseLease()
    {
        long freed;
        lock (gate)
        {
            if (leases == 0) throw new InvalidOperationException("The result set is not leased.");
            if (--leases > 0 || pins > 0 || !freePending) return;
            freed = FreeLocked();
        }
        store.Freed(freed, Budget.Live is not null);
    }

    public int Leases { get { lock (gate) return leases; } }

    /// <summary>Pins the set while a request reads its pages: a release meanwhile ends the request's reads at their next
    /// check (<see cref="IsReleased"/>, or <see cref="Released"/> for an operation over the whole result), but frees the pages and their budget only when the last pin ends, as for a lease.
    /// Pins nest and cost a lock each; a released set can still be pinned, and its pages are then empty or the ones a lease
    /// keeps. Dispose the pin when the read ends.</summary>
    public PagePin Pin()
    {
        lock (gate) pins++;
        return new PagePin(this);
    }

    public int Pins { get { lock (gate) return pins; } }

    internal void Unpin()
    {
        long freed;
        lock (gate)
        {
            if (pins == 0) throw new InvalidOperationException("The result set is not pinned.");
            if (--pins > 0 || leases > 0 || !freePending) return;
            freed = FreeLocked();
        }
        store.Freed(freed, Budget.Live is not null);
    }

    /// <summary>Makes <see cref="Body"/> refuse a set that is neither pinned nor leased. The checks turn it on, so a reader
    /// that does not pin fails them; the product leaves it off, where such a reader would still read correct bytes.</summary>
    internal static bool RequirePins { get; set; }

    /// <summary>The one way to a sealed page's bytes, as they were sealed (and as results.read sends them). Read only while
    /// the set is pinned (<see cref="Pin"/>) or leased.</summary>
    public byte[] Body(StoredPage page)
    {
        if (page.Set != this) throw new ArgumentException("The page is not this result's.", nameof(page));
        if (RequirePins && Volatile.Read(ref pins) == 0 && Volatile.Read(ref leases) == 0)
            throw new InvalidOperationException("A result page was read without a pin.");
        return page.Stored;
    }

    private long FreeLocked()
    {
        freePending = false;
        pages.Clear();
        var freed = charged;
        ReturnLocked(charged);
        slack = working = pending = 0;
        return freed;
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

    /// <summary>Every sealed page so far, in order (rows 0 to RowsAvailable - 1): what a view sorts. Pages are immutable, so
    /// the list stays valid while more are sealed.</summary>
    public StoredPage[] SealedSnapshot()
    {
        lock (gate) return [.. pages];
    }

    /// <summary>The bytes (sum of DATALENGTH) of up to <paramref name="count"/> rows from <paramref name="firstRow"/>, as far
    /// as sealed pages hold them; fewer, or none, past the rows available.</summary>
    public long[] RowBytes(long firstRow, int count, List<long>? estimated = null)
    {
        var result = new List<long>(Math.Min(count, 4096));
        // A column whose rule is a guess (no collation) makes every row's sum an estimate.
        var guessed = estimated is not null && Lengths.Any(length => length.Estimated);
        foreach (var page in PagesFor(firstRow, count))
        {
            var from = (int)Math.Max(0, firstRow + result.Count - page.FirstRow);
            if (page.FirstRow + from != firstRow + result.Count) break;
            var start = result.Count;
            for (var row = from; row < page.Rows && result.Count < count; row++) result.Add(page.Lengths.RowBytes(row));
            if (estimated is null) continue;
            var to = from + result.Count - start;
            if (guessed) for (var row = from; row < to; row++) estimated.Add(page.FirstRow + row);
            else page.Lengths.EstimatedRows(from, to, row => estimated.Add(page.FirstRow + row));
        }
        return [.. result];
    }

    /// <summary>One stored cell's characters and bytes, truncated or not (CellLengths.cs); null for a NULL cell or a row
    /// not in a sealed page. Later views (sort, filters, column statistics) read lengths only through this.</summary>
    public CellSize? CellSize(long row, int column)
    {
        if ((uint)column >= (uint)Wires.Count) throw new ArgumentOutOfRangeException(nameof(column));
        using var pin = Pin();
        var found = PagesFor(row, 1);
        if (found.Count == 0 || found[0].FirstRow > row) return null;
        var page = found[0];
        var at = (int)(row - page.FirstRow);
        var view = PageView.Parse(page.Body(), Wires.Count);
        if (view.IsNull(column, at)) return null;
        if (page.Lengths.TryCell(at, column, out var cell)) return new CellSize(cell.Chars, cell.Bytes, cell.Exact && !Lengths[column].Estimated);
        var size = Lengths[column].Derive(view.Span(column, at), Wires[column]);
        return view.IsTruncated(column, at) || Lengths[column].Rule == LengthRule.Recorded ? size with { Exact = false } : size;
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

    /// <summary>Counters for a progress event, and why the set stopped storing rows once it has: a long statement keeps
    /// reading for minutes after that, and the grid says why its rows stopped only if it hears before the set closes.</summary>
    public (uint ResultId, long RowsRead, long RowsStored, long RowsAvailable, long BytesStored, string? Truncated) Progress()
    {
        lock (gate)
        {
            var reason = Truncated;
            return (ResultId, RowsRead, rowsStored, rowsAvailable, bytesStored, reason == TruncationReason.None ? null : Name(reason));
        }
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

/// <summary>A pin on a result set (<see cref="ResultSetBuffer.Pin"/>); disposing it more than once unpins once.</summary>
internal sealed class PagePin(ResultSetBuffer set) : IDisposable
{
    private int disposed;
    public ResultSetBuffer Set { get; } = set;
    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) == 0) Set.Unpin();
    }
}
