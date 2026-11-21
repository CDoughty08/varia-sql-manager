namespace Varia.Backend.Results;

/// <summary>A sealed page: its first row, row count, the exact bytes that were (and will again be) written to main, and its
/// lengths sidecar, which never leaves the backend except through results.rowBytes. Its bytes are read only through
/// <see cref="Body"/> (its set's <see cref="ResultSetBuffer.Body"/>) while the set is pinned: the store may keep them
/// packed (<see cref="PackedPage"/>), which only the accessor reads (tests/result-page-access.test.ts checks that no reader
/// touches <see cref="Stored"/>). A page with no set is one built for a single read (a view's pages in view order), whose
/// bytes are its own.</summary>
internal sealed class StoredPage
{
    private object stored;

    public StoredPage(long firstRow, int rows, byte[] stored, PageLengths lengths, ResultSetBuffer? set = null)
    {
        FirstRow = firstRow;
        Rows = rows;
        Lengths = lengths;
        Length = stored.Length;
        Set = set;
        this.stored = stored;
    }

    public long FirstRow { get; }
    public int Rows { get; }
    public PageLengths Lengths { get; }
    /// <summary>The page's length as sealed (what results.read sends), whatever form the store keeps it in.</summary>
    public int Length { get; }
    /// <summary>The bytes the store holds for the page now (its packed length when packed): what its budget charge counts.</summary>
    public long StoredLength => Stored is PackedPage packed ? packed.Charged : Length;
    /// <summary>The set that stores the page, or null for a page built for one read.</summary>
    public ResultSetBuffer? Set { get; }
    /// <summary>The bytes as the store keeps them: the page as sealed (a byte array) or a <see cref="PackedPage"/>. Only
    /// <see cref="ResultSetBuffer"/> reads or replaces this, under its lock; a reader may see either form.</summary>
    internal object Stored { get => Volatile.Read(ref stored); set => Volatile.Write(ref stored, value); }
    /// <summary>The page's n-gram filter while it is packed (<see cref="PageFilter"/>), else null.</summary>
    public PageFilter? Filter => Stored is PackedPage packed ? packed.Filter : null;
    /// <summary>The page's compressed bytes while it is packed, without its filter, else null.</summary>
    public int? PackedLength => Stored is PackedPage packed ? packed.Bytes.Length : null;
    /// <summary>Packing saved less than a tenth of the page, so it is not tried again (ResultSetBuffer.Pack).</summary>
    internal bool KeptRaw { get; set; }
    /// <summary>The page's bytes as sealed, through its set's accessor (<see cref="ResultSetBuffer.Body"/>). A call, not a
    /// field: a packed page is unpacked (or found in its set's cache) on every call, so hold the array while reading the
    /// page rather than asking again for every row.</summary>
    public byte[] Body() => Set is null ? (byte[])Stored : Set.Body(this);
}

/// <summary>A page's Zstandard bytes (<see cref="PageCodec"/>; its length as sealed is the page's) and the n-gram filter
/// Find consults before unpacking it (<see cref="PageFilter"/>), built from the same page.</summary>
internal sealed class PackedPage(byte[] bytes, PageFilter? filter = null)
{
    public byte[] Bytes { get; } = bytes;
    public PageFilter? Filter { get; } = filter;
    /// <summary>What the page costs packed: its bytes and its filter's.</summary>
    public long Charged => Bytes.Length + (Filter?.Bytes ?? 0);
}

/// <summary>One stored result set: an append-only page directory that results.read serves, and, while the set is open,
/// the page being built. One query task writes; readers, progress events and releases may run concurrently.
/// Budget: each sealed page costs its length plus <see cref="ResultStore.PageOverhead"/> plus its lengths sidecar (4 bytes a
/// row, 24 per sparse cell entry, <see cref="PageLengths.MemoryBytes"/>), and the builder's buffers are charged as they
/// grow; both come from reservations taken in 256 KiB steps. A packed page (<see cref="Pack"/>) costs its packed length
/// instead, and the pages unpacked for reads (<see cref="CachePages"/> of them) are charged as working memory while kept.
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
    /// <summary>Counts pins and leases taken: every read, operation, Copy or Save of the result (<see cref="Activity"/>).</summary>
    private int touches;
    /// <summary>When a pin or lease last began or ended, or the set completed, on the store's clock (<see cref="ResultStore.Now"/>).</summary>
    private long touchedAt;
    /// <summary>Bytes a row commit is waiting for packing to make room for (<see cref="RoomWanted"/>), or 0.</summary>
    private long roomWanted;
    private CancellationTokenSource? released;
    private bool freePending, gone;
    /// <summary>Packed pages' bytes, their bytes as sealed, and the unpacked cache's bytes (all under the lock).</summary>
    private long packedBytes, packedLogical, cacheBytes;
    /// <summary>The pages read most recently from packed ones, newest first (<see cref="CachePages"/> at most).</summary>
    private readonly List<(StoredPage Page, byte[] Body)> cache = [];
    /// <summary>A whole pass of <see cref="Pack"/> ended with every page packed or kept raw; cleared when the result is
    /// unpacked again. The policy (<see cref="ResultPacker"/>) passes over a result marked so.</summary>
    private bool packDone;
    /// <summary>Counts whole unpacks (<see cref="UnpackAll"/>), so a pass of <see cref="Pack"/> that an operation's unpack
    /// overtook between its last page and its end does not mark the result packed.</summary>
    private int unpacks;
    /// <summary>Packing stopped, or was refused, for a pin or lease, or an operation unpacked the result: the last pin or
    /// lease to end tells the store (<see cref="ResultStore.Settle"/>), so the policy looks at the result again.</summary>
    private bool notifyIdle;
    /// <summary>Pages an operation is unpacking whole (<see cref="UnpackAll"/>) and how many it has done, for the Memory panel.</summary>
    private int unpackTotal, unpackDone;
    private TruncationReason refused;
    private volatile bool incomplete;
    /// <summary>The last search's memo (<see cref="SearchMemo"/>), its bytes counted in <see cref="charged"/>.</summary>
    private SearchMemo? searchMemo;
    /// <summary>Sealed pages waiting to be packed as they sealed (<see cref="ResultStore.PackAtSeal"/>), oldest first, each
    /// counted in its query's <see cref="QueryBudget.SealPending"/>; <see cref="sealQueued"/> pages have been queued so far.</summary>
    private readonly Queue<StoredPage> sealQueue = new();
    private int sealQueued;
    /// <summary>A worker is packing <see cref="sealQueue"/> (<see cref="PackSealed"/>): at most one a set.</summary>
    private bool sealRunning;
    /// <summary>A diff's change index (<see cref="Results.DiffIndex"/>), its bytes counted in <see cref="charged"/>.</summary>
    private DiffIndex? diffIndex;
    /// <summary>The allowance the replace that wrote this set holds (<see cref="ResultStore.Allow"/>), let go when it is freed.</summary>
    private AllowanceHold? allowanceHold;
    /// <summary>The column metadata's bytes, which a switch to windowed keeps (<see cref="Demote"/>).</summary>
    private readonly long metadataBytes;
    private readonly int sealBytes;
    /// <summary>A windowed BigQuery result's rows in BigQuery and its block cache (docs/bigquery.md, Windowed results); null
    /// while the rows are stored here.</summary>
    private RemoteResult? remote;
    /// <summary>A BigQuery result's residence ("memory" or "remote"), its row count in BigQuery and its revision; null, -1
    /// and 0 for every other result, whose descriptors leave them out.</summary>
    private string? residence;
    private long rowsTotal = -1;
    private int revision;
    /// <summary>Bytes a switch to windowed freed while a pin or lease held the pages: returned when the last one ends.</summary>
    private long dropPending;

    /// <param name="metadata">Bytes already reserved for the column metadata; returned with everything else on release.</param>
    internal ResultSetBuffer(ResultStore store, QueryBudget budget, uint resultId, int index, int batchNumber, int iteration, string kind, IReadOnlyList<ResultColumn> columns,
        IReadOnlyList<WireKind> wires, long metadata = 0, int sealBytes = PageBuilder.SealBytes, IReadOnlyList<ColumnLength>? lengths = null)
    {
        Lengths = lengths ?? [.. wires.Select(wire => wire == WireKind.Binary ? ColumnLength.Binary : ColumnLength.Utf16)];
        this.store = store;
        charged = metadata;
        metadataBytes = metadata;
        this.sealBytes = sealBytes;
        Budget = budget;
        ResultId = resultId;
        Index = index;
        BatchNumber = batchNumber;
        Iteration = iteration;
        Kind = kind;
        Columns = columns;
        Wires = wires;
        builder = new PageBuilder(resultId, wires, sealBytes: sealBytes);
        touchedAt = store.Now;
    }

    public QueryBudget Budget { get; }
    public uint ResultId { get; }
    public int Index { get; }
    public int BatchNumber { get; }
    public int Iteration { get; }
    public string Kind { get; }
    /// <summary>The query's name for this set (a #Name marker, ResultNames.cs); null when it has none.</summary>
    public string? ResultName { get; init; }
    /// <summary>A diff's two input results (results.diff), recorded when it is written: its row identity (results.identify)
    /// hashes each entry's (input, row) pairs, ordered by input result id.</summary>
    public (uint Left, uint Right)? DiffInputs { get; set; }
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

    /// <summary>Counts rows read past without reading them: those a BigQuery result holds beyond the rows Varia read (its
    /// totalRows), so the set reports every row its query returned, as a SQL Server set counts the rows it reads past.</summary>
    public void CountRows(long rows) { if (rows > 0) Interlocked.Add(ref rowsRead, rows); }

    /// <summary>Records why a row was not stored; the first reason sticks.</summary>
    public void Skip(TruncationReason reason) => Interlocked.CompareExchange(ref truncated, (int)reason, 0);

    /// <summary>A set made from stored results (a pivot, a diff), not read from the server: a refusal or low
    /// system memory fails only this set, which its caller then releases whole, and never stops its query from storing
    /// more, so a smaller one can still fit.</summary>
    public bool Derived { get; init; }
    /// <summary>Never packed at seal (<see cref="ResultStore.PackAtSeal"/>): set by the synthesize test hook, before its first
    /// row, so a check or benchmark that asks for a raw result gets one.</summary>
    internal bool SealRaw { get; set; }

    /// <summary>An Automatic in-memory BigQuery read (docs/bigquery.md, Choosing the residence): a refusal (the budget, low
    /// system memory) neither stops the query nor truncates the set; its reader switches it to windowed instead
    /// (<see cref="ResultStore.Demote"/>), so a refusal ends only this set's storing, as a derived set's does.</summary>
    public bool SwitchesOnRefusal { get; set; }

    /// <summary>Why the budget refused this set's last row when that stopped only this set (a derived set, or one that
    /// switches on a refusal); None otherwise.</summary>
    public TruncationReason Refusal { get { lock (gate) return refused; } }

    /// <summary>The windowed result's rows in BigQuery and its block cache; null while the rows are stored here.</summary>
    public RemoteResult? Remote => Volatile.Read(ref remote);
    public bool IsRemote => Volatile.Read(ref remote) is not null;
    public string? Residence { get { lock (gate) return residence; } }
    public int Revision { get { lock (gate) return revision; } }

    /// <summary>Marks a BigQuery result read into memory, with BigQuery's row count (the descriptor's residence and rowsTotal).</summary>
    public void InMemory(long totalRows)
    {
        lock (gate)
        {
            residence = "memory";
            rowsTotal = totalRows;
        }
    }

    /// <summary>Switches the set to windowed (docs/bigquery.md, A misestimate): its stored pages go, with their budget (when
    /// the last pin or lease ends, if one holds them), and it becomes a complete remote result read through
    /// <paramref name="windowed"/>, under a new revision. An operation over its rows ends at once. Called only through
    /// <see cref="ResultStore.Demote"/>, which drops its views, snapshots and identities. False once it was released.</summary>
    internal bool Demote(RemoteResult windowed, long totalRows, bool bump = true)
    {
        CancellationTokenSource? stop;
        long returned = 0;
        lock (gate)
        {
            if (state == 2) return false;
            builder?.AbortRow();
            builder = null;
            pages.Clear();
            // Nothing is left to pack at seal: the queued pages are gone with the rest.
            DropSealQueueLocked();
            sealQueued = 0;
            cache.Clear();
            Volatile.Write(ref searchMemo, null);
            Volatile.Write(ref diffIndex, null);
            store.Held(-packedBytes, -packedLogical, -cacheBytes);
            packedBytes = packedLogical = cacheBytes = 0;
            var bytes = charged - metadataBytes - dropPending;
            if (pins > 0 || leases > 0) dropPending += bytes;
            else
            {
                ReturnLocked(bytes);
                returned = bytes;
            }
            slack = working = pending = 0;
            Volatile.Write(ref remote, windowed);
            residence = "remote";
            rowsTotal = totalRows;
            // A set windowed before anyone saw its rows (the residence decided after the first page) keeps revision 0.
            if (bump) revision++;
            state = 1;
            refused = TruncationReason.None;
            Volatile.Write(ref truncated, (int)(windowed.Capped ? TruncationReason.RowLimit : TruncationReason.None));
            Interlocked.Exchange(ref rowsRead, totalRows);
            rowsStored = 0;
            rowsAvailable = windowed.Rows;
            bytesStored = 0;
            truncatedCells = 0;
            incomplete = false;
            Volatile.Write(ref sealedPages, 0);
            packDone = false;
            stop = released;
            released = null;
            touchedAt = store.Now;
        }
        // An operation over the stored rows ends at once (UntilReleased answers REMOTE_RESULT): its pages are gone.
        stop?.Cancel();
        store.Freed(returned);
        return true;
    }

    /// <summary>Switches a windowed set back to memory (Load into memory): its cache goes, and it is an open set again, empty,
    /// under a new revision, for the reader to store the rows into and complete. False once released.</summary>
    internal bool Promote(long totalRows)
    {
        RemoteResult? old;
        lock (gate)
        {
            if (state == 2 || remote is null) return false;
            old = remote;
            Volatile.Write(ref remote, null);
            residence = "memory";
            rowsTotal = totalRows;
            revision++;
            state = 0;
            builder = new PageBuilder(ResultId, Wires, sealBytes: sealBytes);
            Interlocked.Exchange(ref rowsRead, 0);
            rowsStored = rowsAvailable = bytesStored = truncatedCells = 0;
            Volatile.Write(ref truncated, 0);
            refused = TruncationReason.None;
            incomplete = false;
            touchedAt = store.Now;
        }
        old.Dispose();
        return true;
    }

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
    /// <param name="mayWait">The query's ingestion only: when the budget refuses the row and a policy could pack complete
    /// results to make room (<see cref="ResultStore.CanMakeRoom"/>), the row is neither stored nor rolled back and nothing
    /// stops: false with <see cref="RoomWanted"/> set, and the caller waits for room outside every lock
    /// (<see cref="ResultStore.WaitForRoomAsync"/>, which ends at once when nothing can be packed) and commits the same row
    /// again, with <paramref name="mayWait"/> false once there is no more room to wait for. Stored rows stay a prefix of the rows read, so a stop is never undone; this
    /// only lets packing run before the refusal that would stop the query.</param>
    public bool TryCommitRow(int truncatedCellsInRow = 0, bool mayWait = false)
    {
        lock (gate)
        {
            roomWanted = 0;
            if (builder is null) return false;
            var growth = Math.Max(0, builder.WorkingBytes - working);
            var rowBytes = builder.OpenRowBytes + 4L * Wires.Count + builder.OpenRowLengthBytes;
            var need = growth + rowBytes;
            if (state != 0 || (need > slack && !Reserve(need - slack, mayWait)))
            {
                if (roomWanted == 0) builder.AbortRow();
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

    /// <summary>Bytes the last <see cref="TryCommitRow"/> with mayWait is waiting for packing to make room for, its row still
    /// open; 0 when it stored the row or refused it for good.</summary>
    public long RoomWanted { get { lock (gate) return roomWanted; } }

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
        QueueSealedLocked();
        // Checked at every seal, the only low-memory check there is: the page just sealed is kept, and nothing more is
        // stored. A query's own set stops its query, at its last seal too, so later sets store nothing. A derived set stops
        // only itself, at its next row (its caller then refuses it whole), and the query can still store another. One whose
        // last seal sees pressure (the seal inside Complete, or its last row filling a page) asks for no row after it, so
        // it is whole and not truncated.
        if (!store.IsSystemMemoryLow()) return;
        if (Derived || SwitchesOnRefusal) refused = TruncationReason.SystemMemory;
        else Budget.Stop(TruncationReason.SystemMemory);
    }

    private bool Reserve(long bytes, bool mayWait = false)
    {
        var step = Math.Max(bytes, ResultStore.ReserveStep);
        if (store.TryReserve(Budget, step, false, out var reason) || (step > bytes && store.TryReserve(Budget, step = bytes, false, out reason)))
        {
            slack += step;
            charged += step;
            return true;
        }
        // Packing may make room before the query stops: the caller asks, outside this lock, whether anything can be packed
        // (asking here would take other sets' locks inside this one's).
        if (mayWait && !Derived && reason is TruncationReason.QueryBudget or TruncationReason.GlobalBudget && store.CanMakeRoom(Budget))
        {
            roomWanted = bytes;
            return false;
        }
        Skip(reason);
        // The first refusal ends the set, as it ends a query's: a later, smaller row must not be stored past the gap,
        // because stored rows are a prefix of the rows read. A derived set ends only itself.
        if (Derived || SwitchesOnRefusal) refused = reason;
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
            touchedAt = store.Now;
        }
        if (store.Packing == PagePacking.EveryComplete) Pack();
        // Only a result the policy could pack wakes it: a script of thousands of small sets does not rescan the store each time.
        else if (BytesStored >= ResultPacker.FloorBytes) store.Settle();
    }

    /// <summary>Marks the set released, so in-flight reads stop after their current page and nothing more is stored, and
    /// returns the memory it frees: all of it, or nothing while a job holds a lease (the last lease frees it).</summary>
    internal long Release()
    {
        CancellationTokenSource? stop;
        long freed;
        RemoteResult? windowed;
        lock (gate)
        {
            state = 2;
            builder = null;
            DropSealQueueLocked();
            stop = released;
            windowed = remote;
            if (leases > 0 || pins > 0)
            {
                freePending = true;
                freed = 0;
            }
            else freed = FreeLocked();
        }
        // Outside the lock: cancelling runs the operations' registrations inline.
        stop?.Cancel();
        // A windowed result's block cache goes with it, and its fetches stop.
        windowed?.Dispose();
        return freed;
    }

    /// <summary>Cancelled when the set is released or switched to windowed (already cancelled once it has been), so an
    /// operation over the whole result (a sort, profile, diff or pivot) stops at once rather than keeping the pages it pins,
    /// and their budget, until it finishes, or reading the pages a switch took away.</summary>
    public CancellationToken Released
    {
        get
        {
            lock (gate) return state == 2 || remote is not null ? new CancellationToken(true) : (released ??= new CancellationTokenSource()).Token;
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
            touches++;
            touchedAt = store.Now;
            return true;
        }
    }

    /// <summary>Ends a lease. The last one frees a set that was released while it was held.</summary>
    public void ReleaseLease()
    {
        long bytes, dropped = 0;
        bool repack = false, settled = false;
        lock (gate)
        {
            if (leases == 0) throw new InvalidOperationException("The result set is not leased.");
            touchedAt = store.Now;
            if (--leases > 0 || pins > 0) return;
            dropped = TakeDropped();
            StartSealedLocked();
            if (!freePending)
            {
                repack = state == 1 && store.Packing == PagePacking.EveryComplete;
                settled = !repack && state == 1 && notifyIdle;
                notifyIdle &= !settled;
                bytes = 0;
            }
            else bytes = FreeLocked();
        }
        store.Freed(dropped);
        if (repack) Pack();
        else if (settled) store.Settle();
        else store.Freed(bytes, Budget.Live is not null);
    }

    public int Leases { get { lock (gate) return leases; } }

    /// <summary>Bytes a switch to windowed left to the last pin or lease (<see cref="Demote"/>), returned now.</summary>
    private long TakeDropped()
    {
        var bytes = dropPending;
        if (bytes == 0 || freePending) return 0;
        ReturnLocked(bytes);
        dropPending = 0;
        return bytes;
    }

    /// <summary>Pins the set while a request reads its pages: a release meanwhile ends the request's reads at their next
    /// check (<see cref="IsReleased"/>, or <see cref="Released"/> for an operation over the whole result), but frees the pages and their budget only when the last pin ends, as for a lease.
    /// Pins nest and cost a lock each; a released set can still be pinned, and its pages are then empty or the ones a lease
    /// keeps. Dispose the pin when the read ends.</summary>
    public PagePin Pin()
    {
        lock (gate)
        {
            pins++;
            touches++;
            touchedAt = store.Now;
        }
        return new PagePin(this);
    }

    public int Pins { get { lock (gate) return pins; } }

    /// <summary>What the stage 2 policy (<see cref="ResultPacker"/>) reads to tell a result in use from an idle one, in one
    /// lock: the pins and leases taken so far (every read, operation, Copy or Save), whether one is held now, the whole
    /// unpacks so far (<see cref="Unpacks"/>), and when a pin or lease last began or ended or the set completed (on
    /// <see cref="ResultStore.Now"/>'s clock).</summary>
    public (int Touches, bool Held, int Unpacks, long TouchedAt) Activity()
    {
        lock (gate) return (touches, pins > 0 || leases > 0, unpacks, touchedAt);
    }

    /// <summary>The pins and leases taken so far (<see cref="Activity"/>): a pass packing a shown result stops once it changes.</summary>
    public int Touches { get { lock (gate) return touches; } }

    internal void Unpin()
    {
        long bytes, dropped = 0;
        bool repack = false, settled = false;
        lock (gate)
        {
            if (pins == 0) throw new InvalidOperationException("The result set is not pinned.");
            touchedAt = store.Now;
            if (--pins > 0 || leases > 0) return;
            dropped = TakeDropped();
            StartSealedLocked();
            if (!freePending)
            {
                repack = state == 1 && store.Packing == PagePacking.EveryComplete;
                settled = !repack && state == 1 && notifyIdle;
                notifyIdle &= !settled;
                bytes = 0;
            }
            else bytes = FreeLocked();
        }
        store.Freed(dropped);
        if (repack) Pack();
        else if (settled) store.Settle();
        else store.Freed(bytes, Budget.Live is not null);
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
        return page.Stored as byte[] ?? Unpacked(page);
    }

    /// <summary>A page's bytes as sealed when the store holds them so; null for a packed page, which a fused read unpacks
    /// into a room of its own (<see cref="Read"/>) rather than through the cache. Read only while the set is pinned or
    /// leased.</summary>
    public byte[]? Raw(StoredPage page)
    {
        CheckRead(page);
        return page.Stored as byte[];
    }

    /// <summary>A page's bytes as sealed for a fused read (ViewSorter.PageRooms): its own array when the store holds it
    /// so, otherwise unpacked into <paramref name="room"/> (at least the page's length; the page is its first
    /// <see cref="StoredPage.Length"/> bytes), which the reader reuses for its next page. Nothing is cached or charged here:
    /// the room was reserved when it was made. Read only while the set is pinned or leased.</summary>
    public byte[] Read(StoredPage page, byte[] room)
    {
        CheckRead(page);
        if (page.Stored is not PackedPage packed) return (byte[])page.Stored;
        store.UnpackInto(packed, room.AsSpan(0, page.Length));
        return room;
    }

    private void CheckRead(StoredPage page)
    {
        if (page.Set != this) throw new ArgumentException("The page is not this result's.", nameof(page));
        if (RequirePins && Volatile.Read(ref pins) == 0 && Volatile.Read(ref leases) == 0)
            throw new InvalidOperationException("A result page was read without a pin.");
    }

    /// <summary>Reserves working memory from this set's budget (<see cref="ResultStore.TryReserveWork"/>): a fused read's
    /// rooms and column extracts. Give it back with <see cref="ReturnWork"/>.</summary>
    public bool TryReserveWork(long bytes) => store.TryReserveWork(Budget, bytes);

    /// <summary>Reserves working memory taken in pieces (a column extract's pages), asking the system's memory load when
    /// <paramref name="checkSystem"/>: once for every <see cref="ResultStore.WorkCheckBytes"/> taken, as one reservation
    /// of that size would.</summary>
    public bool TryReserveWork(long bytes, bool checkSystem) => store.TryReserve(Budget, bytes, checkSystem, out _);

    /// <summary>Reserves memory that only makes an operation faster (<see cref="ResultStore.TryReserveSpare"/>): refused unless
    /// an eighth of the budget stays free. Give it back with <see cref="ReturnWork"/>.</summary>
    public bool TryReserveSpare(long bytes) => store.TryReserveSpare(Budget, bytes);

    /// <summary>Whether memory taken as spare may still be kept (<see cref="ResultStore.HasSpare"/>).</summary>
    public bool HasSpare => store.HasSpare(Budget);

    /// <summary>What the result's last search kept for the next to narrow from (<see cref="Narrowing"/>), or null.</summary>
    internal SearchMemo? SearchMemo => Volatile.Read(ref searchMemo);

    /// <summary>Keeps a search's memo in place of the last, taking over the spare room its search reserved for it
    /// (<see cref="TryReserveSpare"/>) and returning the last one's; a freed set keeps none and returns the room.</summary>
    internal void KeepSearchMemo(SearchMemo memo)
    {
        lock (gate)
        {
            if (gone) { store.Return(Budget, memo.Bytes); return; }
            if (searchMemo is { } last) ReturnLocked(last.Bytes);
            charged += memo.Bytes;
            Volatile.Write(ref searchMemo, memo);
        }
    }

    /// <summary>A diff's change index, kept from when results.diff wrote it until the set is freed; null for other sets.</summary>
    internal DiffIndex? DiffIndex => Volatile.Read(ref diffIndex);

    /// <summary>Keeps a diff's change index, taking over the bytes its writer reserved for it (<see cref="DiffIndex.Bytes"/>);
    /// a freed set keeps none and returns them.</summary>
    internal void KeepDiffIndex(DiffIndex index)
    {
        lock (gate)
        {
            if (gone) { store.Return(Budget, index.Bytes); return; }
            if (diffIndex is { } last) ReturnLocked(last.Bytes);
            charged += index.Bytes;
            Volatile.Write(ref diffIndex, index);
        }
    }

    /// <summary>What the set holds of its query's budget now: its rows, metadata, change index and search memo.</summary>
    internal long ChargedBytes { get { lock (gate) return charged; } }

    /// <summary>Grants an allowance for replacing this set (<see cref="ResultStore.Allow"/>) unless it has been freed, under
    /// its lock, so its free (which ends the allowance) comes wholly before or after the grant.</summary>
    internal QueryBudget.Allowance? Grant(Func<QueryBudget.Allowance> join)
    {
        lock (gate) return gone ? null : join();
    }

    /// <summary>Keeps the allowance hold of the replace that wrote this set until the set is freed; a set already freed lets
    /// it go at once.</summary>
    internal void KeepAllowance(AllowanceHold hold)
    {
        lock (gate)
        {
            if (!gone && allowanceHold is null) { allowanceHold = hold; return; }
        }
        hold.Dispose();
    }

    /// <summary>Pages read from packed ones kept unpacked per result, newest first: a plain grid's reads ask for the same
    /// few pages again as it scrolls (0.3 ms a read with six, measured, against 0.7 ms with none).</summary>
    public const int CachePages = 6;

    /// <summary>A packed page's bytes: from the cache, or unpacked and kept there while the budget has spare room for it
    /// (<see cref="ResultStore.TryReserveSpare"/>), so the caches of many results never take the budget past its figures.
    /// A read never fails for room: without it the page is unpacked for the read alone.</summary>
    private byte[] Unpacked(StoredPage page)
    {
        store.CountCacheLookup();
        lock (gate)
        {
            for (var i = 0; i < cache.Count; i++)
            {
                if (cache[i].Page != page) continue;
                var hit = cache[i];
                if (i > 0)
                {
                    cache.RemoveAt(i);
                    cache.Insert(0, hit);
                }
                store.CountCacheHit();
                return hit.Body;
            }
        }
        if (page.Stored is not PackedPage packed) return (byte[])page.Stored;
        var body = store.Unpack(packed, page.Length);
        lock (gate) CacheLocked(page, body);
        return body;
    }

    private void CacheLocked(StoredPage page, byte[] body)
    {
        // A freed set keeps no charge; a page unpacked meanwhile needs no copy.
        if (gone || page.Stored is not PackedPage || cache.Exists(item => item.Page == page)) return;
        // The oldest page makes way first, so a full budget still keeps the newest read.
        if (cache.Count >= CachePages) DropCachedLocked(cache.Count - 1);
        if (!store.TryReserveSpare(Budget, body.Length, false)) return;
        charged += body.Length;
        cache.Insert(0, (page, body));
        cacheBytes += body.Length;
        store.Held(0, 0, body.Length);
        while (cache.Count > CachePages) DropCachedLocked(cache.Count - 1);
    }

    private void DropCachedLocked(int index)
    {
        var length = cache[index].Body.Length;
        cache.RemoveAt(index);
        ReturnLocked(length);
        cacheBytes -= length;
        store.Held(0, 0, -length);
    }

    /// <summary>Charges bytes whatever the budget, as the set's own (returned with it).</summary>
    private void Charge(long bytes)
    {
        store.Force(Budget, bytes);
        charged += bytes;
    }

    /// <summary>Whether any page is packed now.</summary>
    public bool HasPacked { get { lock (gate) return packedLogical > 0; } }

    /// <summary>The bytes of the sealed pages as sealed (the rows as read; the descriptor's bytesStored).</summary>
    public long BytesStored { get { lock (gate) return bytesStored; } }

    /// <summary>How many times an operation has unpacked the result whole (the policy counts each as a use).</summary>
    public int Unpacks { get { lock (gate) return unpacks; } }

    /// <summary>Whether the policy (<see cref="ResultPacker"/>) may pack this result: complete, not a live table, and not
    /// already packed by a whole pass since it was last unpacked.</summary>
    public bool NeedsPacking { get { lock (gate) return state == 1 && !packDone && Budget.Live is null; } }

    /// <summary>What the set holds now, for the Memory panel (ResultStore.MemoryDetail): its pages' bytes as sealed, what
    /// they take (raw pages plus packed ones), the packed pages' bytes and their bytes as sealed, the unpacked pages cached
    /// for reads, while an operation unpacks the whole result how far it has got (0 to 100), else null, and whether a whole
    /// pass of <see cref="Pack"/> ended since the result was last unpacked (a pass stopped part way leaves it partial).</summary>
    public (long Logical, long StoredBytes, long Packed, long PackedLogical, long Cache, int? Unpacking, bool Whole) Memory()
    {
        lock (gate)
        {
            var total = Volatile.Read(ref unpackTotal);
            int? unpacking = total > 0 ? (int)Math.Min(100, 100L * Volatile.Read(ref unpackDone) / total) : null;
            return (bytesStored, bytesStored - packedLogical + packedBytes, packedBytes, packedLogical, cacheBytes, unpacking, packDone);
        }
    }

    /// <summary>Packs a complete result's pages one at a time (<see cref="PageCodec"/>), as the store's
    /// <see cref="ResultStore.Packing"/> allows: nothing when it is off or for a live table. It stops, keeping what it
    /// packed, once the set is pinned, leased or released, and checks that before each page it replaces, so a reader
    /// never meets a page replaced while it reads; stopped or refused for a pin or lease, the last one to end tells the
    /// store (<see cref="ResultStore.Settle"/>), so the policy can finish. A whole pass marks the set packed until an
    /// operation unpacks it (<see cref="NeedsPacking"/>). A page that saves less than a tenth stays raw (the checks' mode packs
    /// every page). The bytes saved go back to the budgets at once and count toward the store's next collection, but
    /// never toward a compacting one (ResultStore.Freed): the space is reused anyway. Returns the bytes saved.</summary>
    /// <param name="proceed">Asked before each page, outside the set's lock: false stops packing there, keeping what was
    /// packed (the policy's: the result was shown again, or the backend is shutting down).</param>
    /// <param name="quiet">Passed to the codec around each page's compression (<see cref="PageCodec.Pack"/>): the policy's,
    /// which lowers its thread's priority for the compression alone, outside every lock.</param>
    /// <param name="unpacks">The policy's: the <see cref="Unpacks"/> it saw when it found the result due. An operation that
    /// unpacked the result since then is a use, so nothing is packed and the policy looks again.</param>
    /// <param name="workers">Packs the pages on these workers (the results' shared <see cref="ViewSorter.Gate"/>), each page
    /// as one item, rather than one at a time on the caller's thread: the policy's when a query waits for room
    /// (<see cref="ResultStore.WaitForRoomAsync"/>), which is user work that shares the workers fairly with other result
    /// work. Pages are replaced in whatever order they finish; every check is the same as one at a time.</param>
    public long Pack(Func<bool>? proceed = null, Action<bool>? quiet = null, int? unpacks = null, ViewSorter.WorkerGate? workers = null)
    {
        var mode = store.Packing;
        if (mode == PagePacking.Off || Budget.Live is not null) return 0;
        StoredPage[] candidates;
        int generation;
        lock (gate)
        {
            generation = this.unpacks;
            if (state != 1 || unpacks is { } seen && seen != generation) return 0;
            if (pins > 0 || leases > 0)
            {
                notifyIdle = true;
                return 0;
            }
            candidates = [.. pages.Where(page => page.Stored is byte[] && (mode == PagePacking.EveryComplete || !page.KeptRaw))];
        }
        long saved = 0;
        var stopped = 0;
        // One page: false stops the pass there, keeping what was packed.
        bool PackOne(StoredPage page)
        {
            if (Volatile.Read(ref stopped) != 0 || proceed is not null && !proceed()) return false;
            if (page.Stored is not byte[] raw || Compress(raw, mode, quiet) is not { } packed) return true;
            lock (gate)
            {
                if (state != 1 || pins > 0 || leases > 0)
                {
                    notifyIdle = state == 1;
                    return false;
                }
                // An operation unpacked the result whole between two pages and has already ended (its end poked the
                // policy): a use, so the rest waits the delay again.
                if (unpacks is not null && this.unpacks != generation) return false;
                saved += ReplaceLocked(page, raw, packed);
                return true;
            }
        }
        try
        {
            if (workers is null)
            {
                foreach (var page in candidates)
                    if (!PackOne(page))
                    {
                        stopped = 1;
                        break;
                    }
            }
            else if (candidates.Length > 0)
            {
                using var threads = workers.Take(Math.Min(candidates.Length, ViewSorter.Workers));
                threads.For(candidates.Length, i =>
                {
                    if (!PackOne(candidates[i])) Volatile.Write(ref stopped, 1);
                });
            }
            if (stopped == 0)
                lock (gate)
                    packDone = state == 1 && this.unpacks == generation;
        }
        finally
        {
            // Pages packed before a failure gave their bytes back already; they still count toward the next collection.
            if (saved > 0) store.Freed(saved, Budget.Live is not null, compacts: false);
        }
        return saved;
    }

    /// <summary>A raw page packed outside every lock, with its Find filter, or null when the codec failed. A page that
    /// saves less than a tenth stays raw (<c>Keep</c> false) unless the checks' mode packs every page; its filter is built
    /// only for a page that stays packed, and capped: at most an eighth of the packed bytes, and the page with its filter
    /// still saves a tenth (a wide page of GUIDs would cost more).</summary>
    private (byte[] Bytes, PageFilter? Filter, bool Keep)? Compress(byte[] raw, PagePacking mode, Action<bool>? quiet = null)
    {
        if (store.Pack(raw, quiet) is not { } bytes) return null;
        var keep = mode == PagePacking.EveryComplete || bytes.Length <= raw.Length - raw.Length / 10;
        var filter = keep && raw.Length >= store.FilterMinBytes
            ? PageFilter.Build(raw, Columns, Wires, store.FilterCapped ? Math.Min(bytes.Length / 8, raw.Length - raw.Length / 10 - bytes.Length) : long.MaxValue)
            : null;
        return (bytes, filter, keep);
    }

    /// <summary>Replaces a page still holding <paramref name="raw"/> with its packed form (or marks it kept raw), under the
    /// lock, once the caller has checked that no pin or lease is held: the saving goes back to the budgets at once.
    /// Returns the bytes saved.</summary>
    private long ReplaceLocked(StoredPage page, byte[] raw, (byte[] Bytes, PageFilter? Filter, bool Keep) packed)
    {
        if (!ReferenceEquals(page.Stored, raw)) return 0;
        if (!packed.Keep)
        {
            page.KeptRaw = true;
            store.CountKeptRaw();
            return 0;
        }
        var stored = packed.Bytes.Length + (packed.Filter?.Bytes ?? 0);
        page.Stored = new PackedPage(packed.Bytes, packed.Filter);
        store.CountPacked();
        var difference = raw.Length - stored;
        if (difference >= 0) ReturnLocked(difference);
        else Charge(-difference);
        packedBytes += stored;
        packedLogical += raw.Length;
        store.Held(stored, raw.Length, 0);
        return difference;
    }

    /// <summary>Queues the pages sealed since the last call for packing at seal (<see cref="ResultStore.PackAtSeal"/>): a
    /// query's own set only (not a live table's, nor a derived set an operation builds from stored rows, which the policy
    /// packs once complete), and only once it holds <see cref="ResultPacker.FloorBytes"/>, so a small result is never
    /// packed; the pages sealed before then are queued with the one that reaches it.</summary>
    private void QueueSealedLocked()
    {
        if (!store.PackAtSeal || store.Packing == PagePacking.Off || Budget.Live is not null || Derived || SealRaw || bytesStored < ResultPacker.FloorBytes) return;
        var queued = 0;
        for (; sealQueued < pages.Count; sealQueued++)
        {
            sealQueue.Enqueue(pages[sealQueued]);
            queued++;
        }
        if (queued == 0) return;
        Budget.SealQueued(queued);
        Budget.Sealing(this);
        StartSealedLocked();
    }

    /// <summary>Starts a thread-pool worker packing the queued pages (<see cref="PackSealed"/>) unless one runs or a pin or
    /// lease is held: the reading thread never packs, and the last pin or lease to end starts it again. One worker a set,
    /// so queries storing at once pack on as many threads; a single thread for all of them fell behind four at once.</summary>
    private void StartSealedLocked()
    {
        if (sealRunning || sealQueue.Count == 0 || pins > 0 || leases > 0) return;
        sealRunning = true;
        ThreadPool.UnsafeQueueUserWorkItem(static set => { while (set.PackSealed()) { } }, this, preferLocal: false);
    }

    private void DropSealQueueLocked()
    {
        if (sealQueue.Count == 0) return;
        Budget.SealQueued(-sealQueue.Count);
        sealQueue.Clear();
    }

    /// <summary>Whether pages are queued for packing at seal that will pack without a lease ending first: a pin (a read)
    /// ends with its read, Find or profile and its end restarts the worker, so a refused row waits through it (within the
    /// wait's bounds); a lease (a Copy or Save) may hold the
    /// set for as long as its job runs, so a row is refused at once rather than waiting on it.</summary>
    internal bool SealPackable
    {
        get { lock (gate) return sealQueue.Count > 0 && leases == 0 && SealMayPackLocked(); }
    }

    /// <summary>Whether the queued pages may still be packed: not on a set released, nor on a complete one an operation has
    /// unpacked whole (a use, which the policy's delays then govern), nor once packing is off.</summary>
    private bool SealMayPackLocked() => store.Packing != PagePacking.Off && (state == 0 || state == 1 && unpacks == 0);

    /// <summary>Packs the oldest queued page outside the lock and replaces it as <see cref="Pack"/> does, never while a pin
    /// or lease is held (the page stays queued, and the last hold to end hands the set over again). The page's saving goes
    /// back to the budgets at once, which wakes a row waiting for room. Returns whether more remain to pack now. A failure, a defect never the user's, drops the queue:
    /// the pages stay raw and readable, and the policy packs them once the result is complete.</summary>
    internal bool PackSealed()
    {
        try
        {
            StoredPage page;
            lock (gate)
            {
                if (!SealMayPackLocked()) DropSealQueueLocked();
                if (sealQueue.Count == 0 || pins > 0 || leases > 0) return sealRunning = false;
                page = sealQueue.Peek();
            }
            var raw = page.Stored as byte[];
            var packed = raw is null ? null : Compress(raw, store.Packing);
            store.SealCompressed?.Invoke(this);
            long saved = 0;
            lock (gate)
            {
                // A hold began while the page packed: it stays queued for the hold's end.
                if (pins > 0 || leases > 0) return sealRunning = false;
                if (SealMayPackLocked() && sealQueue.Count > 0 && ReferenceEquals(sealQueue.Peek(), page))
                {
                    sealQueue.Dequeue();
                    Budget.SealQueued(-1);
                    if (raw is not null && packed is { } done) saved = ReplaceLocked(page, raw, done);
                }
            }
            if (saved > 0) store.Freed(saved, live: false, compacts: false);
            // A page that saved nothing leaves a row waiting for room to look again, now that less is queued.
            else store.RoomChanged();
            lock (gate)
            {
                if (sealQueue.Count > 0 && pins == 0 && leases == 0 && SealMayPackLocked()) return true;
                if (!SealMayPackLocked()) DropSealQueueLocked();
                return sealRunning = false;
            }
        }
        catch (Exception)
        {
            lock (gate)
            {
                DropSealQueueLocked();
                sealRunning = false;
            }
            store.RoomChanged();
            return false;
        }
    }

    /// <summary>Unpacks every packed page in place before an operation that reads the whole result (a diff read far out
    /// of order, or a sort, pivot or other read whose rooms or extract were refused), on the workers, after reserving the bytes it adds from the budget as
    /// working memory is (<see cref="ResultStore.TryReserveWork"/>: refused under high system memory load from 64 MiB, as
    /// a sort's keys are). False, changing nothing, when the budget refuses: the caller answers TOO_LARGE, and plain and
    /// view reads still work. The caller holds a pin, so nothing packs the pages again until it ends.</summary>
    public bool TryUnpackAll(CancellationToken token = default)
    {
        if (!HasPacked) return true;
        var need = UnpackNeed();
        if (need > 0 && !store.TryReserveWork(Budget, need)) return false;
        UnpackAll(need, token);
        return true;
    }

    /// <summary>The bytes unpacking every packed page would add (0 when none is packed). The caller holds a pin, so the
    /// figure can only fall (another operation unpacking) until <see cref="UnpackAll"/>.</summary>
    public long UnpackNeed()
    {
        lock (gate)
        {
            if (pins == 0) throw new InvalidOperationException("A result is unpacked only while pinned.");
            long need = 0;
            foreach (var page in pages)
                if (page.Stored is PackedPage packed) need += page.Length - packed.Charged;
            return Math.Max(0, need);
        }
    }

    /// <summary>Unpacks every packed page in place, taking <paramref name="reserved"/> bytes already reserved from this
    /// set's budget as working memory (<see cref="UnpackNeed"/>) as its own, and giving back what it did not need. On
    /// failure (cancellation) the reservation is returned and nothing changes.</summary>
    public void UnpackAll(long reserved, CancellationToken token = default)
    {
        StoredPage[] packed;
        bool wasDone;
        int generation;
        lock (gate)
        {
            if (pins == 0) throw new InvalidOperationException("A result is unpacked only while pinned.");
            packed = [.. pages.Where(page => page.Stored is PackedPage)];
            wasDone = packDone;
            generation = unpacks + 1;
            // Nothing packed (a comparison unpacks every side once one is packed): nothing changes, and it is no use that
            // lengthens the policy's wait for this result.
            if (packed.Length > 0)
            {
                // Whatever happens next, the policy may pack the result again once the operation's pin ends.
                packDone = false;
                unpacks++;
                notifyIdle = true;
            }
        }
        if (packed.Length == 0)
        {
            store.Return(Budget, reserved);
            return;
        }
        var bodies = new byte[packed.Length][];
        var started = System.Diagnostics.Stopwatch.GetTimestamp();
        // Two operations unpacking at once share the figures; the Memory panel shows one's progress or the other's.
        Volatile.Write(ref unpackDone, 0);
        Volatile.Write(ref unpackTotal, packed.Length);
        try
        {
            using var threads = ViewSorter.Gate.Take(Math.Min(packed.Length, ViewSorter.Workers));
            threads.For(packed.Length, i =>
            {
                bodies[i] = Cached(packed[i]) ?? (packed[i].Stored is PackedPage bytes ? store.Unpack(bytes, packed[i].Length) : null!);
                Interlocked.Increment(ref unpackDone);
            }, token);
        }
        catch
        {
            Volatile.Write(ref unpackTotal, 0);
            // Nothing was unpacked: a whole pass still holds (the Memory panel says packed, not partly), unless another
            // operation's unpack came since. The cancelled operation still counts as a use.
            lock (gate)
                if (unpacks == generation) packDone = wasDone;
            store.Return(Budget, reserved);
            throw;
        }
        Volatile.Write(ref unpackTotal, 0);
        store.Unpacked(System.Diagnostics.Stopwatch.GetTimestamp() - started);
        lock (gate)
        {
            charged += reserved;
            long added = 0;
            for (var i = 0; i < packed.Length; i++)
            {
                if (packed[i].Stored is not PackedPage bytes || bodies[i] is null) continue;
                var at = cache.FindIndex(item => item.Page == packed[i]);
                if (at >= 0) DropCachedLocked(at);
                packed[i].Stored = bodies[i];
                added += packed[i].Length - bytes.Charged;
                packedBytes -= bytes.Charged;
                packedLogical -= packed[i].Length;
                store.Held(-bytes.Charged, -packed[i].Length, 0);
            }
            // Pages another operation unpacked meanwhile give their share back.
            if (added > reserved) Charge(added - reserved);
            else ReturnLocked(reserved - added);
        }
    }

    private byte[]? Cached(StoredPage page)
    {
        lock (gate) return cache.Find(item => item.Page == page).Body;
    }

    /// <summary>The bytes of several pages at once, for a read that needs them together (a view's rows in view order): the
    /// packed ones unpacked on the workers, after reserving their bytes as working memory, which the caller returns
    /// (<see cref="ReturnWork"/>, <paramref name="reserved"/>) when it is done with them. Null, reserving nothing, when the
    /// budget has no room: the caller then reads them one at a time through <see cref="Body"/>.</summary>
    /// <param name="rooms">With a list, the packed pages are unpacked into rooms rented from the store's pool
    /// (<see cref="ResultStore.Rooms"/>), added to it: a body is then longer than its page (read its first
    /// <see cref="StoredPage.Length"/> bytes), and the caller gives every room back (<see cref="ReturnRooms"/>) once it
    /// reads none of them. Without one, each is a new array of its page's length.</param>
    public byte[][]? BodiesTogether(IReadOnlyList<StoredPage> wanted, out long reserved, CancellationToken token = default, List<byte[]>? rooms = null)
    {
        // Reserved is set only once the reservation is made, so a throw before it leaves the caller holding nothing.
        reserved = 0;
        var bodies = new byte[wanted.Count][];
        var unpack = new List<int>();
        long need = 0;
        for (var i = 0; i < wanted.Count; i++)
        {
            if (wanted[i].Set != this) throw new ArgumentException("The page is not this result's.", nameof(wanted));
            if (wanted[i].Stored is byte[] raw) bodies[i] = raw;
            else if (Cached(wanted[i]) is { } hit)
            {
                store.CountCacheLookup();
                store.CountCacheHit();
                bodies[i] = hit;
            }
            else
            {
                store.CountCacheLookup();
                unpack.Add(i);
                need += wanted[i].Length;
            }
        }
        if (unpack.Count == 0) return bodies;
        if (RequirePins && Volatile.Read(ref pins) == 0 && Volatile.Read(ref leases) == 0) throw new InvalidOperationException("A result page was read without a pin.");
        if (!store.TryReserveWork(Budget, need)) return null;
        reserved = need;
        var held = need;
        var rented = rooms?.Count ?? 0;
        try
        {
            // Rented here, on one thread, so the workers only unpack.
            var into = rooms is null ? null : new byte[unpack.Count][];
            if (into is not null)
                for (var k = 0; k < unpack.Count; k++) rooms!.Add(into[k] = store.Rooms.Rent(wanted[unpack[k]].Length));
            using var threads = ViewSorter.Gate.Take(Math.Min(unpack.Count, ViewSorter.Workers));
            threads.For(unpack.Count, k =>
            {
                var page = wanted[unpack[k]];
                // A page another operation unpacked in place meanwhile answers its own array (its room goes back unused).
                bodies[unpack[k]] = into is null ? page.Stored is PackedPage packed ? store.Unpack(packed, page.Length) : (byte[])page.Stored : Read(page, into[k]);
            }, token);
        }
        catch
        {
            // Returned here, so the caller (which returns what it holds) holds nothing.
            store.Return(Budget, held);
            reserved = 0;
            if (rooms is not null)
            {
                for (var k = rented; k < rooms.Count; k++) store.Rooms.Return(rooms[k]);
                rooms.RemoveRange(rented, rooms.Count - rented);
            }
            throw;
        }
        return bodies;
    }

    /// <summary>The store's pool of rooms for reads of packed pages.</summary>
    internal RoomPool Rooms => store.Rooms;

    /// <summary>Gives back the rooms <see cref="BodiesTogether"/> rented, once nothing reads them, and empties the list.</summary>
    public void ReturnRooms(List<byte[]> rooms)
    {
        foreach (var room in rooms) store.Rooms.Return(room);
        rooms.Clear();
    }

    /// <summary>Returns working memory reserved by <see cref="BodiesTogether"/> or <see cref="TryReserveWork"/>.</summary>
    public void ReturnWork(long bytes) => store.Return(Budget, bytes);

    private long FreeLocked()
    {
        freePending = false;
        dropPending = 0;
        gone = true;
        pages.Clear();
        cache.Clear();
        // Their bytes are in charged, returned below.
        Volatile.Write(ref searchMemo, null);
        Volatile.Write(ref diffIndex, null);
        store.Held(-packedBytes, -packedLogical, -cacheBytes);
        packedBytes = packedLogical = cacheBytes = 0;
        var freed = charged;
        ReturnLocked(charged);
        slack = working = pending = 0;
        // Its bytes are back: an allowance for replacing it ends (whatever holds it), and the one its own replace held is let go.
        Budget.End(ResultId);
        allowanceHold?.Dispose();
        allowanceHold = null;
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
        // Under the lock Demote takes: a set switched to windowed since its reader's check is refused, never read as empty.
        lock (gate) return remote is null ? [.. pages] : throw SqlService.RemoteRefused();
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
                state switch { 0 => "open", 1 => "complete", _ => "released" }, reason == TruncationReason.None ? null : Name(reason), Incomplete, ResultName,
                residence, residence is null || rowsTotal < 0 ? null : rowsTotal, residence is null ? null : revision);
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
