namespace Varia.Backend.Results;

/// <summary>
/// Stage 1 of the page compression plan (docs/page-compression-findings.md): packs every complete result of
/// <see cref="FloorBytes"/> or more once its grid has been shown in no window for <see cref="DelayMs"/>
/// (<see cref="ResultVisibility"/>, from results.visibility). Never a result still storing rows, a live table, or one a
/// read, operation or job holds (<see cref="ResultSetBuffer.Pack"/> refuses those and asks to be told when they end).
/// </summary>
/// <remarks>
/// Scheduling is the backend's alone: one thread that sleeps until the next hidden result is due or until something may
/// have made one packable (a set completed, the visible set changed, a pin or lease that stopped packing ended), so an
/// idle backend does no work. It packs one result at a time, page by page, compressing each at the lowest thread priority
/// (and doing everything that takes a lock or allocates at normal priority, so it is never preempted holding a lock; only
/// Windows honours the lowered priority, and on Linux and macOS compression competes as an ordinary thread), on its own
/// thread rather than the results' workers: the worker gate shares its threads fairly and has no lower priority, so
/// packing there would take a share from a visible sort. One thread packs about 275 to 400 MB/s (a 1 GiB result in about
/// three seconds), and reads, operations and new queries never wait for it: a page switches under the set's lock when
/// its packed copy is ready, and packing stops between pages as soon as the result is shown again, pinned, leased or
/// released, or the backend shuts down. Each packed page's saving goes back to the budget at once. Nothing is evicted
/// and nothing goes to disk.
/// <para>Lock order: the thread calls <see cref="ResultVisibility.IsHidden"/> holding no lock, and the store calls
/// <see cref="Poke"/> (which takes none) from inside a set's methods but outside its lock.</para>
/// </remarks>
internal sealed class ResultPacker : IDisposable
{
    /// <summary>How long a result is hidden before it is packed: flicking between tabs packs nothing.</summary>
    public const long DelayMs = 5000;
    /// <summary>The smallest result packed: four pages. Below it there is little to save.</summary>
    public const long FloorBytes = 1L << 20;

    private readonly ResultStore store;
    private readonly ResultVisibility visibility;
    private readonly long floor;
    private long delay;
    private readonly AutoResetEvent wake = new(false);
    private Thread? thread;
    private volatile bool stopping;
    private int passes;
    /// <summary>Each result an operation has unpacked: its unpack count when the policy noticed it, and when. An operation's
    /// unpack counts as a use, so a hidden result a search or comparison reads again and again is not packed between runs.
    /// Only results still stored are kept.</summary>
    private readonly Dictionary<uint, (int Unpacks, long At, bool Held)> used = [];

    /// <param name="delayMs">The checks pass a shorter delay; the product uses <see cref="DelayMs"/>.</param>
    public ResultPacker(ResultStore store, ResultVisibility visibility, long delayMs = DelayMs, long floorBytes = FloorBytes)
    {
        this.store = store;
        this.visibility = visibility;
        delay = delayMs;
        floor = floorBytes;
    }

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

    /// <summary>One scan: packs every result that is due, largest first, and returns when the next hidden one falls due (on
    /// <see cref="ResultVisibility.Now"/>'s clock), or null when none is waiting. A result skipped because it is held is
    /// not counted as waiting: its last pin or lease pokes the policy. Public for the checks, which drive the policy with
    /// their own clock instead of the thread.</summary>
    public long? PackDue()
    {
        Interlocked.Increment(ref passes);
        if (store.Packing == PagePacking.Off) return null;
        var now = visibility.Now;
        var wait = Delay;
        long? next = null;
        List<(ResultSetBuffer Set, long Bytes, int Unpacks)> due = [];
        var sets = store.Sets();
        foreach (var set in sets)
        {
            if (stopping) return null;
            // Asked about every stored query result a pass sees, open ones too, so one hidden while it stores rows starts its
            // delay then rather than when it completes. Live tables are never packed and the renderer never reports them.
            if (set.Budget.Live is not null || !visibility.IsHidden(set.ResultId, out var since)) continue;
            if (!set.NeedsPacking || set.BytesStored is var bytes && bytes < floor) continue;
            var unpacks = set.Unpacks;
            var at = Math.Max(since, UsedAt(set, unpacks, now)) + wait;
            if (at > now) next = Math.Min(next ?? at, at);
            else due.Add((set, bytes, unpacks));
        }
        // Packing a large result takes seconds, so one found due may have been used meanwhile: Pack packs nothing if an
        // operation unpacked it since the scan (its end pokes the policy, whose next scan starts the delay again).
        foreach (var (set, _, unpacks) in due.OrderByDescending(item => item.Bytes))
        {
            if (stopping) return null;
            set.Pack(() => !stopping && visibility.IsHidden(set.ResultId, out _), Quiet, unpacks);
        }
        lock (used)
            if (used.Count > 0)
            {
                var stored = sets.Select(set => set.ResultId).ToHashSet();
                foreach (var id in used.Keys.Where(id => !stored.Contains(id)).ToList()) used.Remove(id);
            }
        return next;
    }

    /// <summary>When an operation last unpacked the result, as the policy first saw it (0 when none has).</summary>
    private long UsedAt(ResultSetBuffer set, int unpacks, long now)
    {
        if (unpacks == 0) return 0;
        // An operation runs as long as it holds the result, so a scan that finds it still held after a new unpack (another
        // wake-up during a long sort or pivot) moves the use to now, and so does the first scan after that hold ends (its
        // end pokes the policy): the delay runs from when the operation ended, not from when a scan first saw its unpack.
        // Only the hold that follows an unpack counts: a plain read, Copy or Save later is not a use, as it is not on a
        // result never unpacked.
        var held = set.Pins > 0 || set.Leases > 0;
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
        wake.Set();
        if (thread is { } running) Raise(running);
        // One page takes about a millisecond to pack; the wait only bounds a stuck thread, which is a background one.
        thread?.Join(TimeSpan.FromSeconds(5));
    }
}
