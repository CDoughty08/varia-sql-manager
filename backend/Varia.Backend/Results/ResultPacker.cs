namespace Varia.Backend.Results;

/// <summary>
/// The page compression policy (docs/page-compression-findings.md). Stage 1: packs every complete result of
/// <see cref="FloorBytes"/> or more once its grid has been shown in no window for <see cref="DelayMs"/>
/// (<see cref="ResultVisibility"/>, from results.visibility). Stage 2: packs a shown one too once it has been idle for
/// <see cref="VisibleIdleMs"/>: no read, operation, Copy or Save (a pin or lease of the set) and no whole unpack since,
/// doubling the wait each time an operation has unpacked it (<see cref="MaxBackoff"/>), so a result in use is never packed
/// and unpacked in a loop. Under budget pressure (a query's row refused, <see cref="MakeRoom"/>) it packs complete results
/// that could make room at once, one after another until no query still waits, on the results' shared workers. Never a result still storing rows, a live table,
/// or one a read, operation or job holds (<see cref="ResultSetBuffer.Pack"/> refuses those and asks to be told when they end).
/// </summary>
/// <remarks>
/// Scheduling is the backend's alone: one thread that sleeps until the next result falls due or until something may have
/// made one packable or asked for room (a set completed, the visible set changed, a pin or lease that stopped packing
/// ended, a result's last view closed, a query's row waits for room), so an idle
/// backend does no work. Idle packing (both stages) packs one result at a time, page by page, compressing each at the
/// lowest thread priority (and doing everything that takes a lock or allocates at normal priority, so it is never
/// preempted holding a lock; only Windows honours the lowered priority, and on Linux and macOS compression competes as an
/// ordinary thread), on its own thread rather than the results' workers: the worker gate shares its threads fairly and has
/// no lower priority, so packing there would take a share from a visible sort for a saving nobody waits on. Packing for
/// room, which a query waits on, runs on the gate at normal priority. Opening a view never unpacks a packed result: its
/// sort and its screens read the packed pages in place.
/// One thread packs about 200 to 400 MB/s (a 1 GiB result in three to five seconds), and reads, operations and new
/// queries never wait for it: a page switches under the set's lock when its packed copy is ready, and an idle pass stops
/// between pages once a hidden result is shown again, a shown one is read, it is held or released, a query asks for room,
/// or the backend shuts down. Each packed page's saving goes back to the budget at once. Nothing is evicted and nothing
/// goes to disk.
/// <para>Lock order: the thread calls <see cref="ResultVisibility.State"/> holding no lock, and the store calls
/// <see cref="Poke"/> (which takes none) from inside a set's methods but outside its lock.</para>
/// </remarks>
internal sealed class ResultPacker : IDisposable
{
    /// <summary>How long a result is hidden before it is packed: flicking between tabs packs nothing.</summary>
    public const long DelayMs = 5000;
    /// <summary>The smallest result packed: four pages. Below it there is little to save.</summary>
    public const long FloorBytes = 1L << 20;
    /// <summary>How long a shown result goes untouched before it is packed (stage 2). Reading a packed result costs about
    /// 0.2 to 1 ms more a 1,000-row read (a sorted grid is never packed while shown), so the wait is not for the reads' sake: it
    /// keeps a result the user is working with from being packed (three to five seconds of one low-priority thread a GiB) only for an
    /// operation that unpacks it to undo that.</summary>
    public const long VisibleIdleMs = 30_000;
    /// <summary>The most a shown result's wait doubles for the operations that unpacked it whole: 2^3, four minutes.</summary>
    public const int MaxBackoff = 3;

    private readonly ResultStore store;
    private readonly ResultVisibility visibility;
    private readonly long floor;
    private long delay;
    private long visibleDelay;
    private readonly AutoResetEvent wake = new(false);
    private Thread? thread;
    private volatile bool stopping;
    private int passes;
    /// <summary>Each result an operation has unpacked: its unpack count when the policy noticed it, and when. An operation's
    /// unpack counts as a use, so a hidden result an unpacking operation (a search through a sorted grid, a far-ordered comparison) reads again and again is not packed between runs.
    /// Only results still stored are kept.</summary>
    private readonly Dictionary<uint, (int Unpacks, long At, bool Held)> used = [];
    /// <summary>Who asked for room since the last pass for it: some query for the global budget, and queries for their own half.</summary>
    private readonly object roomGate = new();
    private bool roomForAll;
    private readonly HashSet<QueryBudget> roomFor = [];
    private volatile bool roomWanted;
    private int roomPasses;

    /// <param name="delayMs">The checks pass a shorter delay; the product uses <see cref="DelayMs"/>.</param>
    /// <param name="visibleIdleMs">How long a shown result is idle before it is packed (<see cref="VisibleIdleMs"/>), or
    /// null to pack hidden results only (stage 1: that stage's checks, and the benchmark's "before").</param>
    public ResultPacker(ResultStore store, ResultVisibility visibility, long delayMs = DelayMs, long floorBytes = FloorBytes, long? visibleIdleMs = VisibleIdleMs)
    {
        this.store = store;
        this.visibility = visibility;
        delay = delayMs;
        floor = floorBytes;
        visibleDelay = visibleIdleMs ?? -1;
    }

    /// <summary>How long a shown result is idle before it is packed, in milliseconds, or null when shown results are never
    /// packed; read at each pass (the checks change it).</summary>
    internal long? VisibleDelay
    {
        get => Interlocked.Read(ref visibleDelay) is >= 0 and var value ? value : null;
        set => Interlocked.Exchange(ref visibleDelay, value ?? -1);
    }

    /// <summary>The workers packing for room shares (the results' shared gate; the checks pass their own to see it used).</summary>
    internal ViewSorter.WorkerGate RoomGate { get; set; } = ViewSorter.Gate;

    /// <summary>Passes that packed for room (the checks wait on it).</summary>
    public int RoomPasses => Volatile.Read(ref roomPasses);

    /// <summary>How long a result is hidden before it is packed, in milliseconds; read at each pass (the checks shorten it).</summary>
    internal long Delay { get => Interlocked.Read(ref delay); set => Interlocked.Exchange(ref delay, value); }

    /// <summary>Scans that ran (the checks wait on it).</summary>
    public int Passes => Volatile.Read(ref passes);

    /// <summary>Whether the thread is running (started and not yet ended).</summary>
    internal bool Running => thread?.IsAlive == true;

    /// <summary>The priority a pass compresses a page at, on whichever thread runs it (read before each page). Lowest in the product; the checks
    /// of the thread's timing use normal priority, since on a starved machine (offline-stress) a lowest-priority thread may
    /// not run for many seconds, which is the point in the product but not what those checks test. Everything else the
    /// thread does (the scan, visibility lookups, replacing a page under the set's lock, charging the budget) runs at normal
    /// priority: a thread preempted for seconds while it holds the store's or a set's lock would stall reads and new
    /// queries behind it.</summary>
    internal ThreadPriority Priority { get; set; } = ThreadPriority.Lowest;

    /// <summary>False once the platform refused a priority change; the thread then compresses at normal priority.</summary>
    private volatile bool canLower = true;
    private int pagesAtPriority;

    /// <summary>Whether the platform lets the thread change its priority (for the checks).</summary>
    internal bool CanLower => canLower;

    /// <summary>The pages compressed after asking for <see cref="Priority"/> (for the checks; off Windows the request is
    /// accepted and has no effect on scheduling).</summary>
    internal int PagesAtPriority => Volatile.Read(ref pagesAtPriority);

    /// <summary>Starts the thread and hooks the store's <see cref="ResultStore.Settled"/>. Only the service starts one, for
    /// a store whose packing is on.</summary>
    public void Start()
    {
        if (thread is not null) return;
        store.Settled = Poke;
        store.RoomMaker = MakeRoom;
        thread = new Thread(Run) { IsBackground = true, Name = "Varia result packer" };
        thread.Start();
    }

    /// <summary>Something may have made a result packable, or shown one: look again now. Returns at once.</summary>
    public void Poke()
    {
        Interlocked.Increment(ref pokes);
        if (!stopping) wake.Set();
    }

    private int pokes;

    /// <summary>How many times something woke the policy (for the checks).</summary>
    internal int Pokes => Volatile.Read(ref pokes);

    private void Run()
    {
        while (!stopping)
        {
            long? next;
            try { next = PackDue(); }
            // A failure here is a defect, never the user's: the result stays as it was, readable, and the policy tries again
            // after the delay rather than spinning or taking the backend down.
            catch (Exception) { next = visibility.Now + Delay; }
            if (stopping) break;
            var wait = next is { } at ? Math.Clamp(at - visibility.Now, 0, int.MaxValue) : Timeout.Infinite;
            if (wait != 0) wake.WaitOne((int)wait);
        }
        PageCodec.ReleaseQuietEncoder();
    }

    /// <summary>One scan: first packs for room if a query asked (<see cref="MakeRoom"/>), then every result that is due,
    /// hidden ones first, largest first, and returns when the next one falls due (on <see cref="ResultVisibility.Now"/>'s
    /// clock), or null when none is waiting. A hidden result skipped because it is held is not counted as waiting: its last
    /// pin or lease pokes the policy. Public for the checks, which drive the policy with their own clock instead of the thread.</summary>
    public long? PackDue()
    {
        Interlocked.Increment(ref passes);
        if (store.Packing == PagePacking.Off) return null;
        PackForRoom();
        var now = visibility.Now;
        var wait = Delay;
        var idle = VisibleDelay;
        long? next = null;
        List<(ResultSetBuffer Set, long Bytes, int Unpacks, bool Hidden, int Touches)> due = [];
        var sets = store.Sets();
        foreach (var set in sets)
        {
            if (stopping) return null;
            // Asked about every stored query result a pass sees, open ones too, so one hidden while it stores rows starts its
            // delay then rather than when it completes. Live tables are never packed and the renderer never reports them.
            if (set.Budget.Live is not null || !visibility.State(set.ResultId, out var hidden, out var since)) continue;
            // A shown result whose grid is sorted or filtered (an open view) is not packed while idle: each screen of a view
            // reads a page or so a row, about 0.9 ms raw against 4 to 6 ms packed (a 256-row screen of a 256 MiB result on 16
            // workers, measured). One already packed stays packed: its sort and screens read the packed pages, never
            // unpacking it whole. Closing its last view pokes the policy.
            if (!hidden && (idle is null || store.HasViews(set))) continue;
            if (!set.NeedsPacking || set.BytesStored is var bytes && bytes < floor) continue;
            var (touches, held, unpacks, touchedAt) = set.Activity();
            var usedAt = UsedAt(set, unpacks, held, now);
            long at;
            if (hidden) at = Math.Max(since, usedAt) + wait;
            // A shown result waits from when it was shown, completed, last read or held (now, while held) and last unpacked,
            // longer each time an operation has unpacked it whole: such an operation would otherwise undo each packing.
            else at = Math.Max(Math.Max(since, usedAt), held ? now : touchedAt) + (idle!.Value << Math.Min(unpacks, MaxBackoff));
            if (at > now) next = Math.Min(next ?? at, at);
            else due.Add((set, bytes, unpacks, hidden, touches));
        }
        // Packing a large result takes seconds, so one found due may have been used meanwhile: Pack packs nothing if an
        // operation unpacked it since the scan (its end pokes the policy, whose next scan starts the delay again), and a
        // shown one stops at its next page once anything reads it.
        foreach (var (set, _, unpacks, hidden, touches) in due.OrderByDescending(item => item.Hidden).ThenByDescending(item => item.Bytes))
        {
            if (stopping) return null;
            // A query waiting for room goes first: the next scan packs for it straight away.
            if (roomWanted) break;
            if (hidden) set.Pack(() => Page(set) && !roomWanted && visibility.IsHidden(set.ResultId, out _), Quiet, unpacks);
            else
            {
                set.Pack(() => Page(set) && !roomWanted && set.Touches == touches, Quiet, unpacks);
                // A read that stopped the pass pokes nothing (it never reached the set's lock), so the rest falls due its idle
                // time after the read: from now while the read still holds it.
                if (set.NeedsPacking && idle is { } again)
                {
                    var (_, heldNow, unpacksNow, touchedNow) = set.Activity();
                    var at = (heldNow ? visibility.Now : touchedNow) + (again << Math.Min(unpacksNow, MaxBackoff));
                    next = Math.Min(next ?? at, at);
                }
            }
        }
        Forget(sets);
        return roomWanted ? visibility.Now : next;
    }

    /// <summary>After a candidate was packed for room: whether a query still waits for it. The waits ask again on every page's
    /// saving until they have room, so a request made during the pass may since have been met; with no wait left it is
    /// dropped, rather than packing every other candidate (and starting another pass) for rows already stored. A wait counts
    /// itself (<see cref="ResultStore.RoomWaiting"/>) before it asks, so one asking after this cannot be dropped.</summary>
    private bool StillWaited()
    {
        lock (roomGate)
        {
            if (!roomWanted) return false;
            if (store.RoomWaiting) return true;
            roomForAll = false;
            roomFor.Clear();
            roomWanted = false;
            return false;
        }
    }

    /// <summary>Called before each page a pass packs, outside every lock (the checks' way into a pass); null in the product.</summary>
    internal Action<ResultSetBuffer>? OnPage { get; set; }

    /// <summary>Whether a pass goes on to its next page: not while the backend shuts down.</summary>
    private bool Page(ResultSetBuffer set)
    {
        OnPage?.Invoke(set);
        return !stopping;
    }

    /// <summary>Drops the notes of results no longer stored.</summary>
    private void Forget(ResultSetBuffer[] sets)
    {
        lock (used)
            if (used.Count > 0)
            {
                var stored = sets.Select(set => set.ResultId).ToHashSet();
                foreach (var id in used.Keys.Where(id => !stored.Contains(id)).ToList()) used.Remove(id);
            }
    }

    /// <summary>A query's row waits for want of room (<see cref="ResultStore.WaitForRoomAsync"/>): whether some complete
    /// result not held now could be packed for it (any query's for the global budget, <paramref name="global"/>, else its
    /// own), and if so wakes the policy to pack them at once (<see cref="PackForRoom"/>). Takes the store's lock and each
    /// set's in turn, so it is never called holding a set's lock, and returns at once.</summary>
    internal bool MakeRoom(QueryBudget query, bool global)
    {
        if (stopping || store.Packing == PagePacking.Off) return false;
        // Asked again on every page's saving while the pass for it has not begun: no need to scan every set each time.
        lock (roomGate)
            if (roomWanted && (roomForAll || !global && roomFor.Contains(query))) return true;
        if (!store.Sets().Any(set => ForRoom(set, global, [query]))) return false;
        lock (roomGate)
        {
            if (global) roomForAll = true;
            else roomFor.Add(query);
            roomWanted = true;
        }
        if (!stopping) wake.Set();
        return true;
    }

    /// <summary>Packs for the queries that asked for room since the last pass: every complete result not held that could make
    /// room for them, hidden ones first and largest first, shown or not, idle or not, with no delay, though never one under <see cref="FloorBytes"/>. A
    /// query waits for it, so it runs at normal priority on the results' shared workers (<see cref="ViewSorter.Gate"/>),
    /// sharing them fairly with the other result work, and stops once no query asks again (each page's saving wakes the
    /// waits, which ask again while they still have no room). A read that ends between two pages does not stop it; one
    /// that holds the result as a page is replaced stops the pass there (<see cref="ResultSetBuffer.Pack"/>), and the waits ask
    /// again once it ends.</summary>
    private bool PackForRoom()
    {
        var any = false;
        while (roomWanted && !stopping)
        {
            bool all;
            QueryBudget[] queries;
            lock (roomGate)
            {
                all = roomForAll;
                queries = [.. roomFor];
                roomForAll = false;
                roomFor.Clear();
                roomWanted = false;
            }
            Interlocked.Increment(ref roomPasses);
            any = true;
            var candidates = store.Sets()
                .Where(set => ForRoom(set, all, queries))
                .Select(set => (Set: set, Hidden: visibility.IsHidden(set.ResultId, out _), Bytes: set.BytesStored))
                .OrderByDescending(item => item.Hidden).ThenByDescending(item => item.Bytes).ToList();
            long saved = 0;
            foreach (var (set, _, _) in candidates)
            {
                if (stopping) break;
                // Packing one candidate takes seconds: one later in the list may have become one the user works with since
                // (a view opened, an operation's unpack), so it is asked again now, and again before each
                // page. An operation that unpacks it during its pass stops it too (Pack's unpacks).
                if (!ForRoom(set, all, queries)) continue;
                var unpacks = set.Unpacks;
                var hidden = visibility.IsHidden(set.ResultId, out _);
                long got;
                // One candidate's failure (out of memory compressing a page) skips it rather than every other candidate and
                // the scheduled passes after this one.
                try { got = set.Pack(() => Page(set) && (hidden || !store.HasViews(set)), unpacks: unpacks, workers: RoomGate); }
                catch (OutOfMemoryException) { continue; }
                saved += got;
                // A candidate that saved something wakes the waits, which ask again while they still have no room: carry on
                // only while one still waits. One that saved nothing (its pages kept raw) wakes none, so go on to the next.
                if (got > 0 && !StillWaited()) break;
            }
            // Nothing left to pack: the waits look again and end. Every candidate held by a reader that pinned it after it was
            // asked for (nothing saved): the waits look again at their next poll rather than at once, so a reader pinning
            // and unpinning cannot keep the two threads spinning.
            if (candidates.Count == 0 || saved > 0) store.RoomChanged();
            if (candidates.Count == 0 || saved == 0) break;
        }
        return any;
    }

    /// <summary>Whether packing the set could make room for these queries: complete, not live, not packed yet, of
    /// <see cref="FloorBytes"/> or more (smaller ones would cost a pass each for little), not held now (its pass would end
    /// at once and stall the others), and any query's for the global budget (<paramref name="all"/>), else theirs. One rule
    /// for <see cref="MakeRoom"/> and <see cref="PackForRoom"/>, so a wait is never told there is room to make that the
    /// pass then skips.
    /// <para>Never a result the user is working with: a shown one with an open view (a sorted or filtered grid, whose
    /// screens would then read a page or so a row with no room left for the cache), nor one an operation unpacked whole
    /// and that is still in use (touched within the wait the policy would give it), whose next operation would need its
    /// unpack's room again and could be refused. Packing such a result would trade the result the user is looking at for
    /// the rows of a new query; that query is truncated instead, as without the policy.</para></summary>
    private bool ForRoom(ResultSetBuffer set, bool all, QueryBudget[] queries)
    {
        if (set.Budget.Live is not null || !all && !queries.Contains(set.Budget) || !set.NeedsPacking || set.BytesStored < floor) return false;
        var (_, held, unpacks, touchedAt) = set.Activity();
        if (held || !visibility.State(set.ResultId, out var hidden, out _)) return false;
        if (!hidden && store.HasViews(set)) return false;
        var wait = hidden || VisibleDelay is not { } idle ? Delay : idle << Math.Min(unpacks, MaxBackoff);
        return unpacks == 0 || store.Now - touchedAt >= wait;
    }

    /// <summary>When an operation last unpacked the result, as the policy first saw it (0 when none has).</summary>
    private long UsedAt(ResultSetBuffer set, int unpacks, bool held, long now)
    {
        if (unpacks == 0) return 0;
        // An operation runs as long as it holds the result, so a scan that finds it still held after a new unpack (another
        // wake-up during a long sort or pivot) moves the use to now, and so does the first scan after that hold ends (its
        // end pokes the policy): the delay runs from when the operation ended, not from when a scan first saw its unpack.
        // Only the hold that follows an unpack counts: a plain read, Copy or Save later is not a use, as it is not on a
        // result never unpacked.
        lock (used)
        {
            var found = used.TryGetValue(set.ResultId, out var seen);
            if (!found || seen.Unpacks != unpacks || seen.Held) used[set.ResultId] = seen = (unpacks, now, held);
            return seen.At;
        }
    }

    /// <summary>Whether this thread lowered itself for the compression running now (<see cref="Quiet"/>).</summary>
    [ThreadStatic] private static bool lowered;

    /// <summary>Lowers the thread to <see cref="Priority"/> just before the codec compresses a page and returns it to normal
    /// priority just after (<see cref="PageCodec.Pack"/>): nothing that takes a lock or allocates runs lowered.</summary>
    private void Quiet(bool compressing)
    {
        if (compressing) lowered = Lower();
        else if (lowered)
        {
            lowered = false;
            Raise(Thread.CurrentThread);
        }
    }

    private bool Lower()
    {
        if (!canLower || Priority == ThreadPriority.Normal || stopping) return false;
        try { Thread.CurrentThread.Priority = Priority; }
        catch (Exception error) when (error is PlatformNotSupportedException or ThreadStateException)
        {
            canLower = false;
            return false;
        }
        // Disposal raises the thread after setting stopping; checking it after lowering means one of the two always sees
        // the other, so the last page before a stop is never compressed starved.
        if (!stopping)
        {
            Interlocked.Increment(ref pagesAtPriority);
            return true;
        }
        Raise(Thread.CurrentThread);
        return false;
    }

    private static void Raise(Thread target)
    {
        try { target.Priority = ThreadPriority.Normal; }
        catch (Exception error) when (error is PlatformNotSupportedException or ThreadStateException) { }
    }

    /// <summary>Stops packing between pages and ends the thread (the service's disposal). What was packed stays packed.</summary>
    public void Dispose()
    {
        stopping = true;
        store.Settled = null;
        store.RoomMaker = null;
        // A query waiting for room stops waiting: nothing more will pack for it.
        store.RoomChanged();
        wake.Set();
        if (thread is { } running) Raise(running);
        // One page takes about a millisecond to pack; the wait only bounds a stuck thread, which is a background one.
        thread?.Join(TimeSpan.FromSeconds(5));
    }
}
