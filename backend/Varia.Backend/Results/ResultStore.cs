namespace Varia.Backend.Results;

/// <summary>Why a result stopped storing rows. Execution always continues; only storage stops.</summary>
internal enum TruncationReason { None, RowLimit, QueryBudget, GlobalBudget, SystemMemory }

/// <summary>A live subscription's tables (docs/ipc.md, Live subscriptions): every revision and segment has its own
/// QueryBudget, so one that did not fit never stops later ones, and they share this one's limit (64 MiB). All live tables
/// together also stay within the store's live share (a quarter of the result budget). Live sets seal small pages (64 KiB,
/// under the large object heap's threshold) and their releases do not count toward the forced collection, which would
/// otherwise run a blocking gen2 collection every few seconds under a 1 s snapshot of a large table.</summary>
internal sealed class LiveBudget(long limit)
{
    internal long used;
    public long Limit { get; } = limit;
    public long UsedBytes => Interlocked.Read(ref used);
}

/// <summary>One query's share of the result budget, and the reason it stopped storing rows, if it did.</summary>
internal sealed class QueryBudget(string sessionId, LiveBudget? live = null, long maxBytes = long.MaxValue)
{
    internal long used;
    private int stopped;
    private long refusedBytes, stoppedBytes;
    public string SessionId { get; } = sessionId;
    private volatile bool executing;
    /// <summary>The query that owns this budget is still executing (BigQuery): its sets may still change, so Load into
    /// memory waits for it to end.</summary>
    public bool Executing { get => executing; set => executing = value; }
    private int loading;
    /// <summary>A Load into memory of one of this query's sets is running. Sets of one query share its budget, so two loads
    /// at once would each be refused part way where one alone fits: a second waits for the first (BUSY).</summary>
    public bool Loading => Volatile.Read(ref loading) != 0;
    public bool TryBeginLoad() => Interlocked.CompareExchange(ref loading, 1, 0) == 0;
    public void EndLoad() => Volatile.Write(ref loading, 0);
    /// <summary>The live subscription this budget belongs to, or null for a query's.</summary>
    public LiveBudget? Live { get; } = live;
    public long MaxBytes { get; } = maxBytes;
    public long UsedBytes => Interlocked.Read(ref used);
    /// <summary>Set by the first failed reservation: later rows and later result sets of the query store nothing.</summary>
    public TruncationReason Stopped => (TruncationReason)Volatile.Read(ref stopped);
    /// <summary>The figure the query stopped at, for a budget reason: the one in force at the refusal that stopped it, which
    /// a later change of the limit (ResultStore.Resize) does not alter. Null otherwise.</summary>
    public long? StoppedBytes => Volatile.Read(ref stoppedBytes) is > 0 and var bytes ? bytes : null;
    /// <summary>Records the figure a reservation was just refused at (ResultStore.TryReserve).</summary>
    internal void Refused(long figure) => Interlocked.Exchange(ref refusedBytes, figure);
    private int sealPending;
    /// <summary>Pages of this query's sets queued for packing at seal and not yet packed (<see cref="ResultStore.PackAtSeal"/>):
    /// while there are any, a refused row waits for their saving (<see cref="ResultStore.WaitForRoomAsync"/>).</summary>
    public int SealPending => Volatile.Read(ref sealPending);
    internal void SealQueued(int pages) => Interlocked.Add(ref sealPending, pages);
    private readonly List<ResultSetBuffer> sealing = [];

    /// <summary>Records a set of this query that queued pages for packing at seal (called under that set's lock; this
    /// list's lock is taken inside it, never the other way).</summary>
    internal void Sealing(ResultSetBuffer set)
    {
        lock (sealing) if (!sealing.Contains(set)) sealing.Add(set);
    }

    /// <summary>Whether a page this query queued for packing at seal will pack without waiting on a lease
    /// (<see cref="ResultSetBuffer.SealPackable"/>). Asked outside every set's lock (ResultStore.WaitForRoomAsync), so a row is
    /// refused at once while a Copy or Save holds every set with pages queued, and waits through a pin, which ends with its read, Find or profile.</summary>
    internal bool SealCanPack()
    {
        if (SealPending == 0) return false;
        ResultSetBuffer[] sets;
        lock (sealing) sets = [.. sealing];
        return sets.Any(set => set.SealPackable);
    }
    internal void Stop(TruncationReason reason)
    {
        // The refusal that stops a query comes just before its Stop, on the same thread.
        if (Interlocked.CompareExchange(ref stopped, (int)reason, 0) == 0 && reason is TruncationReason.QueryBudget or TruncationReason.GlobalBudget)
            Volatile.Write(ref stoppedBytes, Interlocked.Read(ref refusedBytes));
    }

    private readonly object allowGate = new();
    private readonly Dictionary<uint, Allowance> allowances = [];
    private long allowed;

    /// <summary>The bytes the query's limit is raised by now: the allowances in force, summed (<see cref="ResultStore.Allow"/>).</summary>
    public long AllowedBytes => Interlocked.Read(ref allowed);

    /// <summary>Allowances in force, for the checks.</summary>
    internal int AllowanceCount { get { lock (allowGate) return allowances.Count; } }

    /// <summary>One replaced result's allowance: granted once with its charge, held by each replace that names it.</summary>
    internal sealed class Allowance(uint replaced, long bytes)
    {
        public uint Replaced { get; } = replaced;
        public long Bytes { get; } = bytes;
        public int Holders;
        public bool Ended;
    }

    /// <summary>Joins the allowance for <paramref name="replaced"/>, granting it with <paramref name="bytes"/> when there is
    /// none: a newer replace of the same result adds a holder, not a second grant. Called under the replaced set's lock
    /// (<see cref="ResultSetBuffer.Grant"/>), so it never meets the end of that set's allowance halfway.</summary>
    internal Allowance Join(uint replaced, long bytes)
    {
        lock (allowGate)
        {
            if (!allowances.TryGetValue(replaced, out var allowance))
            {
                allowances[replaced] = allowance = new Allowance(replaced, Math.Max(0, bytes));
                Interlocked.Add(ref allowed, allowance.Bytes);
            }
            allowance.Holders++;
            return allowance;
        }
    }

    /// <summary>Drops one hold; the last holder's drop ends the allowance.</summary>
    internal void Drop(Allowance allowance)
    {
        lock (allowGate)
        {
            if (allowance.Ended || --allowance.Holders > 0) return;
            EndLocked(allowance);
        }
    }

    /// <summary>Ends the allowance for <paramref name="replaced"/>, whatever holds it: the replaced set's bytes went back
    /// (<see cref="ResultSetBuffer"/>'s free), so the limit no longer needs to cover them.</summary>
    internal void End(uint replaced)
    {
        lock (allowGate)
            if (allowances.TryGetValue(replaced, out var allowance)) EndLocked(allowance);
    }

    private void EndLocked(Allowance allowance)
    {
        allowance.Ended = true;
        allowances.Remove(allowance.Replaced);
        Interlocked.Add(ref allowed, -allowance.Bytes);
    }
}

/// <summary>A replace's hold on an allowance (<see cref="ResultStore.Allow"/>): disposed when the replace fails or is
/// cancelled, or kept by the set it wrote until that set is freed (<see cref="ResultSetBuffer.KeepAllowance"/>).
/// Disposing twice drops it once.</summary>
internal sealed class AllowanceHold(QueryBudget budget, QueryBudget.Allowance allowance) : IDisposable
{
    private int dropped;
    public long Bytes => allowance.Bytes;
    public uint Replaced => allowance.Replaced;
    public void Dispose()
    {
        if (Interlocked.Exchange(ref dropped, 1) == 0) budget.Drop(allowance);
    }
}

/// <summary>Query results kept in backend memory (never on disk) under a byte budget: a global one, at most half of it per
/// query, and nothing more while the operating system reports high memory load. Reading from SQL Server never waits for
/// the UI; a full budget truncates what is stored, with the reason. Results are released only by results.close, the next
/// query on the same session (tab), or the process ending: closing a session or disconnecting keeps them, as SSMS does.</summary>
internal sealed partial class ResultStore
{
    /// <summary>Bookkeeping charged per sealed page on top of its bytes.</summary>
    public const long PageOverhead = 96;
    /// <summary>Reservations are taken in steps this size, so the global counter is not touched for every row.</summary>
    public const long ReserveStep = 256 * 1024;
    private const long CollectAfterRelease = 64L * 1024 * 1024;
    /// <summary>The page size live sets seal at: below the large object heap's 85,000 bytes.</summary>
    public const int LiveSealBytes = 64 * 1024;
    private const long CompactWhenEmpty = 16L * 1024 * 1024;
    private readonly object gate = new();
    private readonly Dictionary<uint, ResultSetBuffer> sets = [];
    private readonly Dictionary<uint, ResultView> views = [];
    /// <summary>Views one result keeps at most; a new one past this replaces its oldest.</summary>
    public const int MaxViewsPerResult = 8;
    /// <summary>Bookkeeping charged per view on top of its order array.</summary>
    public const long ViewOverhead = 256;
    private uint nextViewId = 1;
    /// <summary>Distinct snapshots (results.distinct), by id: each belongs to its result and goes with it.</summary>
    private readonly Dictionary<uint, DistinctSnapshot> snapshots = [];
    private uint nextSnapshotId = 1;
    /// <summary>Each result's row identities (results.identify), at most one per result.</summary>
    private readonly Dictionary<uint, ResultIdentity> identities = [];
    private readonly Func<(long Load, long Threshold)>? memory;
    /// <summary>The memory a user's limit is measured against (<see cref="SetLimit"/>), or null when the figures are fixed.</summary>
    private readonly Func<long>? machineMemory;
    /// <summary>The budget's figures, replaced whole (<see cref="Resize"/>) so a reservation reads one consistent set.</summary>
    private sealed record Figures(long Global, long Query, long Live);
    private Figures figures;
    private readonly object figuresGate = new();
    private double liveShare = 0.25;
    private uint nextId = 1;
    private long used;
    private long liveUsed;
    /// <summary>Windowed results' block caches, all of them (<see cref="TryReserveCache"/>): part of <see cref="UsedBytes"/>.</summary>
    private long windowCacheUsed;
    private long freedSinceCollect;
    private long freedSinceCompact;
    private int collecting;
    private Task collection = Task.CompletedTask;

    /// <param name="memory">The memory load and its high-load threshold, in bytes (<see cref="OperatingSystemMemory"/> in the
    /// process). Null stores up to the budgets whatever the machine's load: the checks build their stores so, because their
    /// budget assertions otherwise fail whenever the machine running them is busy (above 90 % load under parallel lanes).</param>
    /// <param name="machineMemory">The memory available to the process, which <see cref="SetLimit"/> sizes the budget by.
    /// Null fixes the figures: <see cref="SetLimit"/> then changes nothing (the test hooks' budget override).</param>
    public ResultStore(long globalBytes, long queryBytes, Func<(long Load, long Threshold)>? memory = null, Func<long>? machineMemory = null)
    {
        if (globalBytes <= 0 || queryBytes <= 0) throw new ArgumentOutOfRangeException(nameof(globalBytes));
        figures = new Figures(globalBytes, Math.Min(queryBytes, globalBytes), globalBytes / 4);
        this.memory = memory;
        this.machineMemory = machineMemory;
    }

    /// <summary>The least a budget is, and the most it is without a limit of the user's.</summary>
    public const long MinBytes = 256L << 20, MaxAutomaticBytes = 16L << 30;

    /// <summary>The global budget on a machine of this much memory: a quarter of it within <see cref="MinBytes"/> and
    /// <see cref="MaxAutomaticBytes"/>, or the limit the user set (Tools › Options), as it is up to three quarters of the
    /// memory. The budget holds the rows and the working memory of the sorts, pivots and profiles of them alike, so it
    /// is all the backend commits to results: a quarter of memory unless the user set more.</summary>
    public static long GlobalBytesFor(long memoryBytes, long? limitBytes = null) =>
        limitBytes is > 0 ? Math.Clamp(limitBytes.Value, MinBytes, Math.Max(MinBytes, memoryBytes / 4 * 3)) : Math.Clamp(memoryBytes / 4, MinBytes, MaxAutomaticBytes);

    /// <summary>The budget for this machine (<see cref="GlobalBytesFor"/>, of the memory available to the process,
    /// container-aware), half of it per query, storing nothing more under high system memory load.
    /// <paramref name="limitBytes"/> is the user's limit (VARIA_RESULT_MEMORY_MIB, from main). <paramref name="globalOverride"/>
    /// (VARIA_RESULT_BUDGET_BYTES, test hooks only) replaces the global figure and turns the memory-load check off, so the
    /// tests that set it see the budget they chose and its truncation reasons however busy the machine is.</summary>
    public static ResultStore FromSystem(long? globalOverride = null, long? limitBytes = null)
    {
        if (globalOverride is > 0) return new ResultStore(globalOverride.Value, globalOverride.Value / 2);
        var global = GlobalBytesFor(AvailableMemory(), limitBytes);
        return new ResultStore(global, global / 2, OperatingSystemMemory, AvailableMemory);
    }

    private static long AvailableMemory() => GC.GetGCMemoryInfo().TotalAvailableMemoryBytes;

    /// <summary>Applies the user's limit to the running store (results.setMemoryLimit): the global figure becomes
    /// <see cref="GlobalBytesFor"/> of it, half of that per query. Returns false, changing nothing, when the figures are
    /// fixed (the test hooks' override). See <see cref="Resize"/> for what a change does to what is stored and storing.</summary>
    public bool SetLimit(long? limitBytes)
    {
        if (machineMemory is null) return false;
        var global = GlobalBytesFor(machineMemory(), limitBytes);
        Resize(global, global / 2);
        return true;
    }

    /// <summary>Replaces the global and per-query figures, keeping the live share's fraction. Every reservation from now on
    /// checks the new figures; none already made is taken back. Lowered below what is stored, nothing is dropped: every
    /// reservation is refused (a query storing rows stops with GlobalBudget, or QueryBudget past its new half, as it would
    /// at a full budget) until releases bring use under the new figure. Raised, the room is there for the next
    /// reservation, of rows or working memory alike. A query that has already stopped stays stopped: a stop is never
    /// undone. A query's own ceiling (<see cref="QueryBudget.MaxBytes"/>, an actual plan's, fixed when it began) stays as
    /// it was; it holds the query to the smaller of it and the new half.</summary>
    public void Resize(long globalBytes, long queryBytes)
    {
        if (globalBytes <= 0 || queryBytes <= 0) throw new ArgumentOutOfRangeException(nameof(globalBytes));
        lock (figuresGate) Volatile.Write(ref figures, new Figures(globalBytes, Math.Min(queryBytes, globalBytes), (long)(globalBytes * liveShare)));
    }

    /// <summary>Whether reservations checked at a seal stop under high memory load.</summary>
    internal bool ChecksSystemMemory => memory is not null;

    /// <summary>How long a reading of the memory load is good for.</summary>
    internal const long LoadReadingMs = 1000;
    private static long loadReadAt;

    /// <summary>The machine's memory load and the load the runtime calls high. The runtime's figure is the load at its
    /// last garbage collection, and an idle backend may not have collected for hours: a reading older than
    /// <see cref="LoadReadingMs"/> is taken again by a collection of the youngest generation, which takes a millisecond
    /// or so. Without that a sort would be refused for a load that passed long ago, or allowed on a machine since filled.</summary>
    internal static (long Load, long Threshold) OperatingSystemMemory() => OperatingSystemMemory(Environment.TickCount64);

    internal static (long Load, long Threshold) OperatingSystemMemory(long now)
    {
        var last = Interlocked.Read(ref loadReadAt);
        if ((now - last >= LoadReadingMs || now < last) && Interlocked.CompareExchange(ref loadReadAt, now, last) == last)
            GC.Collect(0, GCCollectionMode.Forced, blocking: true);
        var info = GC.GetGCMemoryInfo();
        return (info.MemoryLoadBytes, info.HighMemoryLoadThresholdBytes);
    }

    /// <summary>The user's limit from VARIA_RESULT_MEMORY_MIB as main sets it: digits alone, 1 to 1,048,576 MiB. Anything
    /// else is no limit.</summary>
    public static long? LimitFromEnvironment(string? value) =>
        long.TryParse(value, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var mib) && mib is > 0 and <= 1L << 20 ? mib << 20 : null;

    public long GlobalBytes => Volatile.Read(ref figures).Global;
    public long QueryBytes => Volatile.Read(ref figures).Query;
    public long UsedBytes => Interlocked.Read(ref used);
    /// <summary>What all live tables may hold together (the live share of the budget), and hold now.</summary>
    public long LiveBytes => Volatile.Read(ref figures).Live;
    public long LiveUsedBytes => Interlocked.Read(ref liveUsed);
    /// <summary>What windowed results' block caches hold (the Memory panel's "window cache").</summary>
    public long WindowCacheBytes => Interlocked.Read(ref windowCacheUsed);
    /// <summary>Bytes released toward the next forced collection (the checks read it).</summary>
    internal long FreedSinceCollect => Interlocked.Read(ref freedSinceCollect);
    /// <summary>Bytes released toward the next compacting collection (the checks read it).</summary>
    internal long FreedSinceCompact => Interlocked.Read(ref freedSinceCompact);
    /// <summary>The forced collection a release scheduled last, or a completed task (the read bench waits for it, so the
    /// collection one case's release scheduled does not land in the next case's timing).</summary>
    internal Task Collection => Volatile.Read(ref collection);
    /// <summary>Sets the live share: <paramref name="share"/> of the global budget (limits.live.budgetShare).</summary>
    public void ShareWithLive(double share)
    {
        lock (figuresGate)
        {
            liveShare = Math.Clamp(share, 0, 1);
            var current = figures;
            Volatile.Write(ref figures, current with { Live = (long)(current.Global * liveShare) });
        }
    }
    public int Count { get { lock (gate) return sets.Count; } }

    /// <summary>The packing a new store starts with: off, but for the checks' second pass over the result suites, which
    /// packs every complete result (<see cref="PagePacking.EveryComplete"/>). The backend process sets its own store's
    /// (SqlService's packHidden: <see cref="PagePacking.OnRequest"/>).</summary>
    internal static PagePacking DefaultPacking { get; set; } = PagePacking.Off;

    /// <summary>Whether and how complete results' pages are packed (<see cref="ResultSetBuffer.Pack"/>). An internal switch,
    /// on request in the product, where the hidden-result policy (<see cref="ResultPacker"/>) asks; the service that runs that
    /// policy turns it on. Switching it off packs nothing more and leaves packed pages packed; they read as ever.</summary>
    internal PagePacking Packing { get; set; } = DefaultPacking;

    /// <summary>Packs a query's pages as they seal, on a thread-pool worker beside the reading thread, once its set holds <see cref="ResultPacker.FloorBytes"/>
    /// (ResultSetBuffer.PackSealed), so a result larger than its query's half is not truncated while its raw pages wait
    /// for the policy, which packs only complete results. The service running the policy turns it on; the checks' stores
    /// leave it off unless a check turns it on.</summary>
    internal bool PackAtSeal { get; set; }

    /// <summary>The checks' way into packing at seal: run on the worker after it compresses a page and before it takes the
    /// set's lock to replace it. Null in the product.</summary>
    internal Action<ResultSetBuffer>? SealCompressed { get; set; }

    /// <summary>The size at which a query's pages are sealed (the checks lower it for many small pages).</summary>
    internal int SealBytes { get; init; } = PageBuilder.SealBytes;

    /// <summary>The smallest page given an n-gram filter when packed (<see cref="PageFilter"/>).</summary>
    internal int FilterMinBytes { get; init; } = DefaultFilterMinBytes;

    /// <summary>The checks' packed pass lowers it so the small pages of every suite there are filtered.</summary>
    internal static int DefaultFilterMinBytes { get; set; } = PageFilter.MinPageBytes;

    /// <summary>Whether a page's filter is capped by its packed size (<see cref="ResultSetBuffer.Pack"/>); the checks turn it
    /// off to filter pages of any size.</summary>
    internal bool FilterCapped { get; init; } = DefaultFilterCapped;
    internal static bool DefaultFilterCapped { get; set; } = true;
    /// <summary>Whether packing types columns (PageCodec.Typed.cs): always in the product; the benchmarks compare both.</summary>
    internal bool TypedPacking { get; init; } = true;
    /// <summary>The rooms view reads unpack packed pages into, kept between reads (<see cref="RoomPool"/>).</summary>
    internal RoomPool Rooms { get; } = new();

    private long packedBytes, packedLogical, cacheBytes, pagesPacked, pagesKeptRaw, pagesUnpacked, cacheHits, cacheLookups, packedIn, packedOut, unpackedOut, packTicks, unpackTicks, lastUnpackTicks;

    /// <summary>The store's packing figures (<see cref="PackingSnapshot"/>): what is held now (packed bytes, their bytes as
    /// sealed, the unpacked pages cached for reads) and counts since the store began (pages packed, kept raw because
    /// packing saved under a tenth, and unpacked; cache hits and lookups; bytes in and out; time spent, and the last
    /// operation's whole unpack, in Stopwatch ticks).</summary>
    internal sealed record PackingCounters(long PackedBytes, long PackedLogicalBytes, long CacheBytes, long PagesPacked, long PagesKeptRaw, long PagesUnpacked,
        long CacheHits, long PackedInBytes, long PackedOutBytes, long UnpackedBytes, long PackTicks, long UnpackTicks, long CacheLookups = 0, long LastUnpackTicks = 0);

    /// <summary>The packing figures now (results.memory's codec counters, <see cref="MemoryDetail"/>).</summary>
    internal PackingCounters PackingSnapshot() => new(Interlocked.Read(ref packedBytes), Interlocked.Read(ref packedLogical), Interlocked.Read(ref cacheBytes),
        Interlocked.Read(ref pagesPacked), Interlocked.Read(ref pagesKeptRaw), Interlocked.Read(ref pagesUnpacked), Interlocked.Read(ref cacheHits),
        Interlocked.Read(ref packedIn), Interlocked.Read(ref packedOut), Interlocked.Read(ref unpackedOut), Interlocked.Read(ref packTicks), Interlocked.Read(ref unpackTicks),
        Interlocked.Read(ref cacheLookups), Interlocked.Read(ref lastUnpackTicks));

    /// <summary>Called when a set may have become packable: it completed, or the last pin or lease ended on one whose packing
    /// stopped for it or that an operation unpacked (<see cref="ResultSetBuffer.Pack"/>). The policy
    /// (<see cref="ResultPacker"/>) sets it to wake itself; it must return at once and take none of the store's locks.</summary>
    internal Action? Settled { get; set; }

    internal void Settle() => Settled?.Invoke();

    /// <summary>The clock the sets note their last use on (<see cref="ResultSetBuffer.Activity"/>), in milliseconds: monotonic,
    /// <see cref="Environment.TickCount64"/> as <see cref="ResultVisibility"/>'s is, which the policy compares it with. The
    /// checks set both to their own.</summary>
    internal Func<long> Clock { get; set; } = () => Environment.TickCount64;

    internal long Now => Clock();

    /// <summary>Asked while a query's refused row waits (<see cref="WaitForRoomAsync"/>): whether packing complete results could
    /// make room for that query, either in the global budget (<c>true</c>) or in its own half only (its own complete sets),
    /// and if so starts packing them at once. The policy (<see cref="ResultPacker"/>) sets it; it must return at once and take
    /// no lock of the waiting set's (it is never a candidate: it is open).</summary>
    internal Func<QueryBudget, bool, bool>? RoomMaker { get; set; }

    /// <summary>The longest a row waits for packing to make room (<see cref="WaitForRoomAsync"/>) before the query stops as
    /// it would have: packing on the workers takes about 0.2 s of 16 workers a GiB (docs/page-compression-findings.md), a few
    /// times that on a few cores, so
    /// this only bounds a pass that a held result or a starved machine keeps from finishing.</summary>
    internal const int RoomWaitMs = 10_000;
    /// <summary>How long one wait for a page's saving lasts before the room is looked at again.</summary>
    private const int RoomPollMs = 250;
    private int roomWaiters;

    /// <summary>Whether a query's row is waiting for room now (<see cref="WaitForRoomAsync"/>).</summary>
    internal bool RoomWaiting => Volatile.Read(ref roomWaiters) > 0;
    private TaskCompletionSource roomChanged = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>Whether a policy runs that could pack results to make room for a query's refused row: asked inside the refused
    /// set's lock, so it takes none (<see cref="WaitForRoomAsync"/> asks the policy, outside every lock).</summary>
    internal bool CanMakeRoom(QueryBudget query) => query.Live is null && (RoomMaker is not null || query.SealPending > 0);

    /// <summary>Whether packing could make room for a refused row, in the global budget (<paramref name="global"/>) or the
    /// query's own half, starting it if so (<see cref="RoomMaker"/>). Never called holding a set's lock: the policy takes
    /// the store's and its candidates' locks.</summary>
    // Pages of its own queued for packing at seal make room too, unless a lease holds them: they pack outside the policy.
    private bool MayMakeRoom(QueryBudget query, bool global) => query.Live is null && (query.SealCanPack() || RoomMaker is { } maker && maker(query, global));

    /// <summary>Waits, outside every lock, until <paramref name="bytes"/> fit the query's half and the global budget or packing
    /// has nothing more to give: true when they fit (the caller reserves them then, and may find them taken again), false
    /// when they do not and nothing more is packing for this query, or after <see cref="RoomWaitMs"/>. Each page packed
    /// returns its saving at once (<see cref="Return"/>), which wakes the wait. A cancelled query throws.</summary>
    public async Task<bool> WaitForRoomAsync(QueryBudget query, long bytes, CancellationToken token = default, int? waitMs = null)
    {
        var deadline = Environment.TickCount64 + (waitMs ?? RoomWaitMs);
        Interlocked.Increment(ref roomWaiters);
        try
        {
            while (true)
            {
                var signal = Volatile.Read(ref roomChanged).Task;
                var fitsQuery = FitsQuery(query, bytes);
                if (fitsQuery && FitsGlobal(bytes)) return true;
                // Its own half full: only its own results can make room there (packing them helps the global budget too).
                var global = fitsQuery;
                if (!MayMakeRoom(query, global)) return false;
                var left = deadline - Environment.TickCount64;
                if (left <= 0) return false;
                try { await signal.WaitAsync(TimeSpan.FromMilliseconds(Math.Min(left, RoomPollMs)), token).ConfigureAwait(false); }
                catch (TimeoutException) { }
            }
        }
        finally { Interlocked.Decrement(ref roomWaiters); }
    }

    private bool FitsGlobal(long bytes) => UsedBytes + bytes <= GlobalBytes;

    private bool FitsQuery(QueryBudget query, long bytes) => query.UsedBytes + bytes <= QueryLimit(query, Volatile.Read(ref figures));

    /// <summary>The query's limit: its half of the budget (or its own smaller ceiling), raised by the allowances in force
    /// (<see cref="Allow"/>). The only limit reader: every reservation of the query, on any thread and through any room,
    /// checks against it (<see cref="TryReserve(QueryBudget, long, bool, out TruncationReason)"/>, <see cref="FitsQuery"/>,
    /// <see cref="HasSpare"/>, <see cref="TryReserveSpare"/>), and a refusal records it.</summary>
    private static long QueryLimit(QueryBudget query, Figures budget) => Math.Min(budget.Query, query.MaxBytes) + query.AllowedBytes;

    /// <summary>The query's limit now (<see cref="QueryLimit(QueryBudget, Figures)"/>): the truncation note's figure when no
    /// stopped figure is recorded.</summary>
    public long QueryLimit(QueryBudget query) => QueryLimit(query, Volatile.Read(ref figures));

    /// <summary>Raises <paramref name="query"/>'s limit by <paramref name="replaced"/>'s whole charge now (its rows, metadata,
    /// change index, views, identity and value lists; <see cref="ChargeOf"/>) while a result that replaces it is written
    /// (results.diff's replaces): a bounded overrun of the query's half, so old and new can be held together until the
    /// old is released. One allowance per replaced result, granted once and held by each replace naming it; allowances of
    /// different results add up. It ends when the replaced set's bytes go back (its free, after the last lease or pin), or
    /// when its last holder lets go (a failed or cancelled replace, or a written one's set freed). The global budget and
    /// the system's memory load are not raised. Null when the replaced set is already freed.</summary>
    public AllowanceHold? Allow(QueryBudget query, ResultSetBuffer replaced)
    {
        var allowance = replaced.Grant(() => query.Join(replaced.ResultId, ChargeOf(replaced)));
        return allowance is null ? null : new AllowanceHold(query, allowance);
    }

    /// <summary>What a result holds of its query's budget now: its own charge (rows, metadata, change index, search memo)
    /// and its views', identity's and value lists' charges.</summary>
    public long ChargeOf(ResultSetBuffer set)
    {
        var bytes = set.ChargedBytes;
        lock (gate)
        {
            foreach (var view in views.Values) if (view.Set == set) bytes += view.Charged;
            foreach (var snapshot in snapshots.Values) if (snapshot.Set == set) bytes += snapshot.Charged;
            if (identities.TryGetValue(set.ResultId, out var identity)) bytes += identity.Charged;
        }
        return bytes;
    }

    /// <summary>Wakes the waits for room (<see cref="WaitForRoomAsync"/>): bytes went back to the budget, or a packing pass
    /// for room ended (the policy's), which may mean there is nothing more to wait for.</summary>
    internal void RoomChanged()
    {
        if (Volatile.Read(ref roomWaiters) == 0) return;
        var next = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Interlocked.Exchange(ref roomChanged, next).TrySetResult();
    }

    /// <summary>Every stored set now, for the policy and the Memory panel, which read each outside the store's lock.</summary>
    internal ResultSetBuffer[] Sets()
    {
        lock (gate) return [.. sets.Values];
    }

    /// <summary>A page packed (<see cref="PageCodec.Pack"/>), timed and counted; null when the codec failed.</summary>
    internal byte[]? Pack(byte[] page, Action<bool>? quiet = null)
    {
        var started = System.Diagnostics.Stopwatch.GetTimestamp();
        var packed = PageCodec.Pack(page, quiet, TypedPacking);
        Interlocked.Add(ref packTicks, System.Diagnostics.Stopwatch.GetTimestamp() - started);
        Interlocked.Add(ref packedIn, page.Length);
        if (packed is null) return null;
        Interlocked.Add(ref packedOut, packed.Length);
        return packed;
    }

    /// <summary>A packed page's bytes as sealed (<see cref="PageCodec.Unpack"/>), timed and counted.</summary>
    internal byte[] Unpack(PackedPage packed, int length)
    {
        var started = System.Diagnostics.Stopwatch.GetTimestamp();
        var page = PageCodec.Unpack(packed.Bytes, length);
        Interlocked.Add(ref unpackTicks, System.Diagnostics.Stopwatch.GetTimestamp() - started);
        Interlocked.Increment(ref pagesUnpacked);
        Interlocked.Add(ref unpackedOut, length);
        return page;
    }

    /// <summary>A packed page unpacked into a fused read's room (<see cref="PageCodec.UnpackInto"/>), timed and counted as
    /// any unpack is.</summary>
    internal void UnpackInto(PackedPage packed, Span<byte> room)
    {
        var started = System.Diagnostics.Stopwatch.GetTimestamp();
        PageCodec.UnpackInto(packed.Bytes, room);
        Interlocked.Add(ref unpackTicks, System.Diagnostics.Stopwatch.GetTimestamp() - started);
        Interlocked.Increment(ref pagesUnpacked);
        Interlocked.Add(ref unpackedOut, room.Length);
    }

    /// <summary>Moves what the sets hold packed and cached (each set keeps its own share and gives it back when freed).</summary>
    internal void Held(long packed, long logical, long cached)
    {
        if (packed != 0) Interlocked.Add(ref packedBytes, packed);
        if (logical != 0) Interlocked.Add(ref packedLogical, logical);
        if (cached != 0) Interlocked.Add(ref cacheBytes, cached);
    }

    internal void CountCacheHit() => Interlocked.Increment(ref cacheHits);
    internal void CountCacheLookup() => Interlocked.Increment(ref cacheLookups);
    /// <summary>Records how long an operation's whole unpack took (<see cref="ResultSetBuffer.UnpackAll"/>).</summary>
    internal void Unpacked(long ticks) => Interlocked.Exchange(ref lastUnpackTicks, ticks);
    internal void CountKeptRaw() => Interlocked.Increment(ref pagesKeptRaw);
    /// <summary>A page's packed copy replaced it (pages compressed and then kept raw or dropped are not counted).</summary>
    internal void CountPacked() => Interlocked.Increment(ref pagesPacked);

    /// <summary>A new query on a session replaces that session's earlier results, whatever connection produced them.</summary>
    public QueryBudget BeginQuery(string sessionId)
    {
        ReleaseSession(sessionId);
        return new QueryBudget(sessionId);
    }

    /// <summary>Opens a result set, reserving its column metadata (512 bytes plus 2 per name character and 64 per column)
    /// like any other storage. Returns null, so the set is not kept, once the query has stopped storing or when the
    /// metadata does not fit; the query then stops with that reason.</summary>
    /// <param name="transfer">The caller has just released a set with the same columns, whose bytes pay for this one's
    /// metadata, so it is charged without a check (an append table's restart, LiveAppendTable): no one else can take those
    /// bytes in between, and while a lease holds the released set the store is over by one set's metadata at most.</param>
    /// <param name="lengths">Each column's byte rule (ColumnPlan.Lengths); without them text counts as UTF-16.</param>
    /// <param name="derived">A set made from stored results (<see cref="ResultSetBuffer.Derived"/>): a refusal returns null
    /// without stopping the query.</param>
    public ResultSetBuffer? Open(QueryBudget query, int index, int batchNumber, int iteration, string kind, IReadOnlyList<ResultColumn> columns, IReadOnlyList<WireKind> wires, bool transfer = false,
        IReadOnlyList<ColumnLength>? lengths = null, bool derived = false, string? name = null)
    {
        // A live set's pages stay off the large object heap; see LiveBudget.
        var sealBytes = query.Live is null ? SealBytes : LiveSealBytes;
        if (query.Stopped != TruncationReason.None) return null;
        var metadata = 512 + columns.Sum(column => 2L * column.Name.Length + 64);
        if (transfer) Force(query, metadata);
        else if (!TryReserve(query, metadata, false, out var reason))
        {
            if (!derived) query.Stop(reason);
            return null;
        }
        lock (gate)
        {
            if (nextId == 0)
            {
                Return(query, metadata);
                throw new RequestException("BACKEND_ERROR", "Result identifiers are exhausted. Restart the SQL backend.");
            }
            var set = new ResultSetBuffer(this, query, nextId++, index, batchNumber, iteration, kind, columns, wires, metadata, sealBytes, lengths) { Derived = derived, ResultName = name };
            sets[set.ResultId] = set;
            return set;
        }
    }

    /// <summary>Reserves bytes for a query. Checks run in this order: the system's memory load (only when asked, at page
    /// seals, and by working and spare memory of some size), the query's half of the budget, for a live table its subscription's limit (QueryBudget) and the live share
    /// (GlobalBudget), then the global budget.</summary>
    public bool TryReserve(QueryBudget query, long bytes, bool checkSystem, out TruncationReason reason) =>
        // One reading of the figures for the whole reservation: a concurrent Resize applies to the next one.
        TryReserve(query, bytes, checkSystem, Volatile.Read(ref figures), out reason);

    private bool TryReserve(QueryBudget query, long bytes, bool checkSystem, Figures budget, out TruncationReason reason)
    {
        if (checkSystem && IsSystemMemoryLow()) { reason = TruncationReason.SystemMemory; return false; }
        var queryLimit = QueryLimit(query, budget);
        // Each share is claimed before the next is checked and given back on a later refusal, so concurrent reservations (a
        // query's Storage Read streams) never pass a limit together. The query's share is claimed only when it fits.
        for (var current = Interlocked.Read(ref query.used); ; current = Interlocked.Read(ref query.used))
        {
            if (current + bytes > queryLimit)
            {
                query.Refused(queryLimit);
                reason = TruncationReason.QueryBudget;
                return false;
            }
            if (Interlocked.CompareExchange(ref query.used, current + bytes, current) == current) break;
        }
        var live = query.Live;
        if (live is not null)
        {
            if (Interlocked.Add(ref live.used, bytes) > live.Limit)
            {
                Interlocked.Add(ref live.used, -bytes);
                Interlocked.Add(ref query.used, -bytes);
                query.Refused(live.Limit);
                reason = TruncationReason.QueryBudget;
                return false;
            }
            if (Interlocked.Add(ref liveUsed, bytes) > budget.Live)
            {
                Interlocked.Add(ref liveUsed, -bytes);
                Interlocked.Add(ref live.used, -bytes);
                Interlocked.Add(ref query.used, -bytes);
                query.Refused(budget.Live);
                reason = TruncationReason.GlobalBudget;
                return false;
            }
        }
        for (var current = Interlocked.Read(ref used); ; current = Interlocked.Read(ref used))
        {
            if (current + bytes > budget.Global)
            {
                Interlocked.Add(ref query.used, -bytes);
                query.Refused(budget.Global);
                if (live is not null)
                {
                    Interlocked.Add(ref liveUsed, -bytes);
                    Interlocked.Add(ref live.used, -bytes);
                }
                reason = TruncationReason.GlobalBudget;
                return false;
            }
            if (Interlocked.CompareExchange(ref used, current + bytes, current) == current) break;
        }
        reason = TruncationReason.None;
        return true;
    }

    /// <summary>Whether both budgets are still short of the eighth <see cref="TryReserveSpare"/> leaves free: once either
    /// reaches it, memory taken as spare is better given back to the operation's own work.</summary>
    public bool HasSpare(QueryBudget query)
    {
        var budget = Volatile.Read(ref figures);
        var limit = QueryLimit(query, budget);
        return query.UsedBytes <= limit - limit / 8 && UsedBytes <= budget.Global - budget.Global / 8;
    }

    /// <summary>Takes bytes for what only makes a request faster (a sort's whole keys), leaving an eighth of the query's
    /// room and of the store's free: a query still loading into this budget goes on storing rows meanwhile, where a
    /// reservation of its own that found the budget full would stop it for good.</summary>
    /// <param name="checkSystem">Whether to ask the system's memory load too. By default as working memory is asked
    /// (<see cref="WorkCheckBytes"/> or more): what is taken in small pieces (a sort key's pages) asks once for every
    /// that much taken, so a busy machine does not lose a few kilobytes that make a sort many times faster.</param>
    public bool TryReserveSpare(QueryBudget query, long bytes, bool? checkSystem = null)
    {
        var budget = Volatile.Read(ref figures);
        var limit = QueryLimit(query, budget);
        if (query.UsedBytes + bytes > limit - limit / 8 || UsedBytes + bytes > budget.Global - budget.Global / 8) return false;
        // The same reading as the eighth left free: a lowering in between cannot let spare memory take that eighth.
        return TryReserve(query, bytes, checkSystem ?? bytes >= WorkCheckBytes, budget, out _);
    }

    /// <summary>Working memory at this size or more is refused while the operating system reports high memory load, as a
    /// page of rows is: the budget is a share of the machine's memory, not of what is free, and a sort of a large result
    /// would otherwise take gigabytes from a machine with none to spare. Smaller requests are not asked: a busy machine
    /// still sorts a small result. What is taken in many small steps (a profile's long values, a diff's cells) asks once
    /// for every this much taken (<see cref="WorkSteps"/>), as a sort key's pages do.</summary>
    public const long WorkCheckBytes = 64L << 20;

    /// <summary>What <see cref="WorkSteps"/> take between load readings: <see cref="WorkCheckBytes"/>, less only in checks.</summary>
    internal long WorkStepBytes { get; init; } = WorkCheckBytes;

    /// <summary>Takes the working memory of an operation on a result (a sort's keys, a profile's figures).</summary>
    public bool TryReserveWork(QueryBudget query, long bytes) => TryReserve(query, bytes, bytes >= WorkCheckBytes, out _);

    /// <summary>Charges bytes whatever the budget: the few bytes by which a sealed page exceeds its rows' estimate.</summary>
    internal void Force(QueryBudget query, long bytes)
    {
        Interlocked.Add(ref used, bytes);
        Interlocked.Add(ref query.used, bytes);
        if (query.Live is { } live)
        {
            Interlocked.Add(ref liveUsed, bytes);
            Interlocked.Add(ref live.used, bytes);
        }
    }

    public void Return(QueryBudget query, long bytes)
    {
        if (bytes == 0) return;
        Interlocked.Add(ref used, -bytes);
        Interlocked.Add(ref query.used, -bytes);
        if (query.Live is { } live)
        {
            Interlocked.Add(ref liveUsed, -bytes);
            Interlocked.Add(ref live.used, -bytes);
        }
        else if (bytes > 0) RoomChanged();
    }

    public bool IsSystemMemoryLow()
    {
        if (memory is null) return false;
        var (load, threshold) = memory();
        return threshold > 0 && load >= threshold;
    }

    public ResultSetBuffer? Find(uint resultId)
    {
        lock (gate) return sets.GetValueOrDefault(resultId);
    }

    /// <summary>Whether this id was issued and has since been released (RESULT_RELEASED rather than RESULT_NOT_FOUND).</summary>
    public bool WasReleased(uint resultId)
    {
        lock (gate) return resultId >= 1 && resultId < nextId && !sets.ContainsKey(resultId);
    }

    public bool Release(uint resultId) => Release([resultId]) == 1;

    /// <summary>Keeps a view built for <paramref name="set"/>, whose order and overhead (<paramref name="charged"/> bytes) the
    /// caller has reserved from the set's budget: they are returned when the view goes. <paramref name="replaces"/> names a
    /// view of the same set this one supersedes; past <see cref="MaxViewsPerResult"/> the set's oldest view goes. Throws
    /// RESULT_RELEASED, returning the charge, when the set was released while the view was built.</summary>
    public ResultView AddView(ResultSetBuffer set, int[] order, IReadOnlyList<ViewKey> keys, bool approximate, bool complete, long charged, uint? replaces, long baseRows = long.MaxValue, long[]? unitBlocks = null)
    {
        List<ResultView> dropped = [];
        ResultView view;
        lock (gate)
        {
            if (!sets.ContainsKey(set.ResultId) || set.IsReleased || nextViewId == 0)
            {
                Return(set.Budget, charged);
                throw nextViewId == 0 ? new RequestException("BACKEND_ERROR", "View identifiers are exhausted. Restart the SQL backend.")
                    : new RequestException("RESULT_RELEASED", "These results were closed. Execute the query again to see them.");
            }
            // Switched to windowed while the view was built (Demote drops views under this lock): its pages are gone.
            if (set.IsRemote)
            {
                Return(set.Budget, charged);
                throw SqlService.RemoteRefused();
            }
            if (replaces is { } old && views.TryGetValue(old, out var replaced) && replaced.Set == set && views.Remove(old)) dropped.Add(replaced);
            var own = views.Values.Where(item => item.Set == set).OrderBy(item => item.ViewId).ToList();
            for (var i = 0; i <= own.Count - MaxViewsPerResult; i++)
            {
                views.Remove(own[i].ViewId);
                dropped.Add(own[i]);
            }
            view = new ResultView(nextViewId++, set, order, keys, approximate, complete, charged, baseRows) { UnitBlocks = unitBlocks };
            views[view.ViewId] = view;
        }
        foreach (var item in dropped) Return(item.Set.Budget, item.Charged);
        return view;
    }

    /// <summary>A view of <paramref name="resultId"/>, or null when there is none by that id for that result (closed,
    /// replaced, or another result's).</summary>
    public ResultView? FindView(uint resultId, uint viewId)
    {
        lock (gate) return views.TryGetValue(viewId, out var view) && view.Set.ResultId == resultId ? view : null;
    }

    public bool HasView(ResultView view)
    {
        lock (gate) return views.TryGetValue(view.ViewId, out var kept) && kept == view;
    }

    public int ViewCount { get { lock (gate) return views.Count; } }

    /// <summary>Closes views of <paramref name="resultId"/> (others' ids, unknown and repeated ones are skipped); returns how
    /// many were closed.</summary>
    public int CloseViews(uint resultId, IEnumerable<uint> viewIds)
    {
        List<ResultView> closed = [];
        lock (gate)
        {
            foreach (var id in viewIds)
                if (views.TryGetValue(id, out var view) && view.Set.ResultId == resultId && views.Remove(id)) closed.Add(view);
        }
        foreach (var view in closed) Return(view.Set.Budget, view.Charged);
        return closed.Count;
    }

    /// <summary>Keeps a distinct snapshot of its set, whose charge the caller has reserved from the set's budget: it is
    /// returned when the snapshot goes. Throws RESULT_RELEASED, returning the charge, when the set was released while it was
    /// built, and TOO_LARGE when the set already keeps <see cref="ViewSorter.MaxDistinctSnapshots"/>: a snapshot may hold a
    /// grid's filter, so none is dropped to make room.</summary>
    public DistinctSnapshot AddSnapshot(DistinctSnapshot snapshot)
    {
        var set = snapshot.Set;
        lock (gate)
        {
            string? refusal = !sets.ContainsKey(set.ResultId) || set.IsReleased ? "RESULT_RELEASED" : set.IsRemote ? "REMOTE_RESULT" : nextSnapshotId == 0 ? "BACKEND_ERROR"
                : snapshots.Values.Count(item => item.Set == set) >= ViewSorter.MaxDistinctSnapshots ? "TOO_LARGE" : null;
            if (refusal is null)
            {
                snapshot.SnapshotId = nextSnapshotId++;
                snapshots[snapshot.SnapshotId] = snapshot;
                return snapshot;
            }
            Return(set.Budget, snapshot.Charged);
            throw refusal switch
            {
                "RESULT_RELEASED" => new RequestException(refusal, "These results were closed. Execute the query again to see them."),
                "REMOTE_RESULT" => SqlService.RemoteRefused(),
                "TOO_LARGE" => new RequestException(refusal, "These results keep as many value lists as they can. Remove some column filters and try again."),
                _ => new RequestException(refusal, "Value list identifiers are exhausted. Restart the SQL backend.")
            };
        }
    }

    /// <summary>A distinct snapshot of <paramref name="resultId"/>, or null when there is none by that id for that result.</summary>
    public DistinctSnapshot? FindSnapshot(uint resultId, uint snapshotId)
    {
        lock (gate) return snapshots.TryGetValue(snapshotId, out var snapshot) && snapshot.Set.ResultId == resultId ? snapshot : null;
    }

    public int SnapshotCount { get { lock (gate) return snapshots.Count; } }

    /// <summary>Closes distinct snapshots of <paramref name="resultId"/> (others' ids, unknown and repeated ones are skipped);
    /// returns how many were closed.</summary>
    public int CloseSnapshots(uint resultId, IEnumerable<uint> snapshotIds)
    {
        List<DistinctSnapshot> closed = [];
        lock (gate)
        {
            foreach (var id in snapshotIds)
                if (snapshots.TryGetValue(id, out var snapshot) && snapshot.Set.ResultId == resultId && snapshots.Remove(id)) closed.Add(snapshot);
        }
        foreach (var snapshot in closed) Return(snapshot.Set.Budget, snapshot.Charged);
        return closed.Count;
    }

    /// <summary>Keeps <paramref name="identity"/> as its result's row identities, replacing any it had; the caller reserved its
    /// charge, which is returned when it goes. Throws RESULT_RELEASED, returning the charge, when the result went meanwhile.</summary>
    public void SetIdentity(ResultIdentity identity)
    {
        var set = identity.Set;
        ResultIdentity? replaced;
        lock (gate)
        {
            if (!sets.ContainsKey(set.ResultId) || set.IsReleased)
            {
                Return(set.Budget, identity.Charged);
                throw new RequestException("RESULT_RELEASED", "These results were closed. Execute the query again to see them.");
            }
            identities.Remove(set.ResultId, out replaced);
            identities[set.ResultId] = identity;
        }
        if (replaced is not null) Return(set.Budget, replaced.Charged);
    }

    public ResultIdentity? FindIdentity(uint resultId)
    {
        lock (gate) return identities.GetValueOrDefault(resultId);
    }

    public int IdentityCount { get { lock (gate) return identities.Count; } }

    /// <summary>Switches a stored set to windowed (docs/bigquery.md, Residence: Misestimate): its views, snapshots and identities go
    /// first, as on a release, then its pages (<see cref="ResultSetBuffer.Demote"/>). False once it was released, and the
    /// remote result is then disposed.</summary>
    public bool Demote(ResultSetBuffer set, RemoteResult remote, long totalRows, bool bump = true)
    {
        // Windowed first, then what was built over its pages goes: AddView and AddSnapshot refuse a windowed set under this
        // lock, so one finished meanwhile is either refused or dropped here.
        if (!set.Demote(remote, totalRows, bump))
        {
            remote.Dispose();
            return false;
        }
        List<ResultView> dropped;
        lock (gate)
        {
            if (!sets.ContainsKey(set.ResultId)) dropped = [];
            else dropped = DropViewsLocked([set]);
        }
        Free([], dropped);
        return true;
    }

    /// <summary>Charges a windowed result's block cache (docs/bigquery.md, Residence) to the global budget, as a live table
    /// is, not to a query's half: within the cache's own limit (<paramref name="limit"/>, what <paramref name="held"/> counts
    /// for that cache) and the global budget. The cache evicts its own blocks and asks again when this refuses.</summary>
    public bool TryReserveCache(ref long held, long limit, long bytes) => TryReserveCache(ref held, limit, bytes, out _);

    /// <param name="overLimit">On a refusal, whether the cache's own limit refused (else the global budget did), as the
    /// reservation saw it: a caller deciding by its held bytes afterwards would race other fetches giving theirs back.</param>
    public bool TryReserveCache(ref long held, long limit, long bytes, out bool overLimit)
    {
        overLimit = false;
        if (bytes <= 0) return true;
        if (Interlocked.Add(ref held, bytes) > limit)
        {
            Interlocked.Add(ref held, -bytes);
            overLimit = true;
            return false;
        }
        var global = Volatile.Read(ref figures).Global;
        for (var current = Interlocked.Read(ref used); ; current = Interlocked.Read(ref used))
        {
            if (current + bytes > global)
            {
                Interlocked.Add(ref held, -bytes);
                return false;
            }
            if (Interlocked.CompareExchange(ref used, current + bytes, current) == current) break;
        }
        Interlocked.Add(ref windowCacheUsed, bytes);
        return true;
    }

    /// <summary>Gives back a block cache's bytes (<see cref="TryReserveCache"/>).</summary>
    public void ReturnCache(ref long held, long bytes)
    {
        if (bytes <= 0) return;
        Interlocked.Add(ref held, -bytes);
        Interlocked.Add(ref windowCacheUsed, -bytes);
        Interlocked.Add(ref used, -bytes);
        RoomChanged();
        Freed(bytes);
    }

    /// <summary>Releases the given ids (unknown and repeated ids are skipped) and returns how many were released.</summary>
    public int Release(IEnumerable<uint> resultIds)
    {
        List<ResultSetBuffer> released = [];
        List<ResultView> dropped;
        lock (gate)
        {
            foreach (var id in resultIds) if (sets.Remove(id, out var set)) released.Add(set);
            dropped = DropViewsLocked(released);
        }
        return Free(released, dropped);
    }

    public int ReleaseSession(string sessionId) => Release(set => set.Budget.SessionId == sessionId);
    public int ReleaseAll() => Release(_ => true);

    private int Release(Func<ResultSetBuffer, bool> match)
    {
        List<ResultSetBuffer> released;
        List<ResultView> dropped;
        lock (gate)
        {
            released = [.. sets.Values.Where(match)];
            foreach (var set in released) sets.Remove(set.ResultId);
            dropped = DropViewsLocked(released);
        }
        return Free(released, dropped);
    }

    /// <summary>The views of the sets just released, removed with them.</summary>
    private List<ResultView> DropViewsLocked(List<ResultSetBuffer> released)
    {
        // Identities go with their result too; Return takes no lock.
        foreach (var set in released) if (identities.Remove(set.ResultId, out var identity)) Return(set.Budget, identity.Charged);
        if (released.Count == 0 || views.Count + snapshots.Count == 0) return [];
        var gone = released.ToHashSet();
        // Snapshots go with their result too.
        foreach (var snapshot in snapshots.Values.Where(item => gone.Contains(item.Set)).ToList())
        {
            snapshots.Remove(snapshot.SnapshotId);
            Return(snapshot.Set.Budget, snapshot.Charged);
        }
        var dropped = views.Values.Where(view => gone.Contains(view.Set)).ToList();
        foreach (var view in dropped) views.Remove(view.ViewId);
        return dropped;
    }

    private int Free(List<ResultSetBuffer> released, List<ResultView> dropped)
    {
        long freed = 0;
        foreach (var view in dropped)
        {
            Return(view.Set.Budget, view.Charged);
            if (view.Set.Budget.Live is null) freed += view.Charged;
        }
        foreach (var set in released)
        {
            var bytes = set.Release();
            if (set.Budget.Live is null) freed += bytes;
        }
        Freed(freed);
        return released.Count;
    }

    /// <summary>Memory a release returned, now or when a leased set's last job ended. Live tables' memory is not counted:
    /// see LiveBudget. Packing's saving (<paramref name="compacts"/> false) counts toward the next collection as a release
    /// does, but not toward a compacting one: the space it frees is reused for new pages without one, and compacting copies
    /// what remains, 0.1 to 0.3 s a GiB (docs/page-compression-findings.md).</summary>
    internal void Freed(long freed, bool live = false, bool compacts = true)
    {
        if (freed == 0 || live) return;
        // Counted across calls: closing many small results, together or one at a time, frees as much as one large release.
        var sinceCollect = Interlocked.Add(ref freedSinceCollect, freed);
        var sinceCompact = compacts ? Interlocked.Add(ref freedSinceCompact, freed) : Interlocked.Read(ref freedSinceCompact);
        if (sinceCollect > CollectAfterRelease || UsedBytes == 0 && sinceCompact > CompactWhenEmpty) Collect();
    }

    /// <summary>Pages are large arrays, which only a gen2 collection frees, and nothing else in the backend allocates enough
    /// to trigger one: without it the process keeps its peak memory after results are closed and grows under store and
    /// close churn. One runs after every 64 MiB released, counted across calls, and when a release
    /// empties the store after 16 MiB released since the last compacting one; calls that come together share it, off the
    /// caller's thread.
    /// Only an aggressive (compacting) collection returns the freed memory to the operating system. It copies what remains,
    /// so it runs only when that is no more than what was released since the last one; otherwise a non-compacting one
    /// keeps the pause short.</summary>
    private void Collect()
    {
        if (Interlocked.Exchange(ref collecting, 1) == 1) return;
        Volatile.Write(ref collection, Task.Delay(100).ContinueWith(_ =>
        {
            Volatile.Write(ref collecting, 0);
            CollectNow();
        }, TaskScheduler.Default));
    }

    /// <summary>The most a compacting collection copies while the machine has memory to spare. Every thread of the backend
    /// stops while it copies: measured, 0.1 to 0.2 s for each GiB that remains, so a second or two here. It is the most
    /// the automatic budget can leave after a release that large; a limit the user set higher can leave more.</summary>
    internal const long CompactAtMostBytes = 8L << 30;

    /// <summary>Whether a collection now may compact: what remains is no more than was released since the last one that
    /// did, and no more than <see cref="CompactAtMostBytes"/> unless the machine is short of memory. Nothing else gives
    /// the released memory back (a non-compacting collection, however often it runs, keeps it committed), so a machine
    /// short of memory takes the longer pause: what is kept would go on refusing rows and sorts.</summary>
    internal static bool MayCompact(long usedBytes, long freedSinceCompact, bool memoryLow) =>
        usedBytes <= freedSinceCompact && (usedBytes <= CompactAtMostBytes || memoryLow);

    private void CollectNow()
    {
        Interlocked.Exchange(ref freedSinceCollect, 0);
        var used = UsedBytes;
        if (MayCompact(used, Interlocked.Read(ref freedSinceCompact), used > CompactAtMostBytes && IsSystemMemoryLow()))
        {
            Interlocked.Exchange(ref freedSinceCompact, 0);
            GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
        }
        else GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: false);
    }
}
