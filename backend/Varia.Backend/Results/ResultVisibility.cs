namespace Varia.Backend.Results;

/// <summary>
/// Which query results' grids the renderer shows in any window, popouts included (results.visibility), and since when
/// each other stored result has been hidden (and each shown one shown): the input of the packing policy, which packs
/// results nobody can see after a few seconds (stage 1 of the page compression plan) and shown ones once idle (stage 2). The renderer reports query results only (result sets, pivots, comparisons, Peek's rows), not live
/// tables, which are replaced every tick: a stored live table always counts as hidden here, so a policy must exclude
/// results whose budget is live. It is a hint: the renderer sends the whole visible set each time it
/// changes, and again to a new backend, so a lost or late message only delays such a policy, never loses rows.
/// It holds no pages and changes nothing in the store.
/// </summary>
/// <remarks>
/// Lock order: this class takes its own lock and then calls <c>exists</c> (ResultStore.Find, which takes the store's
/// gate). Nothing may call into this class while holding the store's gate or any lock the store takes, or it can deadlock
/// against a concurrent <see cref="Set"/>.
/// <para>Bounds: the visible set holds at most <see cref="MaxResults"/> ids. Hidden-since entries exist only for results
/// asked about or hidden while stored; released ones are dropped by <see cref="Forget"/> (results.close) or by a sweep once
/// the table has doubled since the last one, so it stays within twice its size after the last sweep (and at least
/// <see cref="SweepFloor"/>); between sweeps only released results' entries add to the stored results' own. Nothing is evicted by age, so a lookup never resets a stored result's time.</para>
/// </remarks>
/// <param name="exists">Whether a result is stored (not released). Called under this class's own lock.</param>
/// <param name="now">Milliseconds on a monotonic clock (<see cref="Environment.TickCount64"/> by default); the checks pass their own.</param>
internal sealed class ResultVisibility(Func<uint, bool> exists, Func<long>? now = null)
{
    /// <summary>The most ids one set names (src/shared/ipc/wire/protocol.ts limits.visibility.maxResults).</summary>
    public const int MaxResults = 4096;
    /// <summary>The table size below which released entries are not swept.</summary>
    public const int SweepFloor = 1024;

    private readonly object gate = new();
    private readonly Func<long> clock = now ?? (() => Environment.TickCount64);
    private HashSet<uint> visible = [];
    private readonly Dictionary<uint, long> hiddenSince = [];
    /// <summary>When each id of the visible set entered it: bounded by the set (<see cref="MaxResults"/>).</summary>
    private readonly Dictionary<uint, long> shownSince = [];
    private int sweepAt = SweepFloor;
    private Guid source;
    private long lastSeq;

    /// <summary>The clock <see cref="IsHidden"/>'s timestamps are on.</summary>
    public long Now => clock();
    public int VisibleCount { get { lock (gate) return visible.Count; } }
    public int TrackedCount { get { lock (gate) return hiddenSince.Count; } }

    /// <summary>Replaces the visible set, unless it is older than the last one applied: the same <paramref name="source"/>
    /// (one renderer load) with a <paramref name="seq"/> not above the last. Control requests run concurrently, and one
    /// that passed its deadline still runs, so a late set must not undo a newer one. A new source (the renderer reloaded)
    /// is always applied. A result that leaves the set is hidden from now; ids of results not stored are ignored.
    /// Returns whether the set was applied; <paramref name="kept"/> is how many ids the visible set holds.</summary>
    public bool Set(Guid source, long seq, IEnumerable<uint> ids, out int kept)
    {
        var at = clock();
        lock (gate)
        {
            if (source == this.source && seq <= lastSeq)
            {
                kept = visible.Count;
                return false;
            }
            this.source = source;
            lastSeq = seq;
            HashSet<uint> next = [];
            foreach (var id in ids) if (next.Count < MaxResults && exists(id)) next.Add(id);
            // A released id that leaves gets an entry the next sweep drops; asking the store about each would only cost locks.
            foreach (var id in visible)
                if (!next.Contains(id))
                {
                    hiddenSince[id] = at;
                    shownSince.Remove(id);
                }
            foreach (var id in next)
            {
                hiddenSince.Remove(id);
                shownSince.TryAdd(id, at);
            }
            visible = next;
            Sweep();
            kept = visible.Count;
            return true;
        }
    }

    /// <summary>Whether a stored query result's grid is shown in no window, and since when (on <see cref="Now"/>'s clock). A stored
    /// result never shown counts as hidden from the first time it is asked about. A released result is neither. Never call
    /// it holding the store's locks (see the remarks).</summary>
    public bool IsHidden(uint resultId, out long since)
    {
        var hidden = State(resultId, out var isHidden, out var at) && isHidden;
        since = hidden ? at : 0;
        return hidden;
    }

    /// <summary>Whether a query result is stored and, if so, whether its grid is shown in no window, and since when it has
    /// been hidden or shown (on <see cref="Now"/>'s clock): what both packing stages ask, hidden results after a few seconds
    /// and shown ones once idle. A stored result never shown counts as hidden from the first time it is asked about. Never
    /// call it holding the store's locks (see the remarks).</summary>
    public bool State(uint resultId, out bool hidden, out long since)
    {
        lock (gate)
        {
            since = 0;
            hidden = false;
            if (!exists(resultId))
            {
                hiddenSince.Remove(resultId);
                shownSince.Remove(resultId);
                visible.Remove(resultId);
                return false;
            }
            if (visible.Contains(resultId))
            {
                since = shownSince.GetValueOrDefault(resultId);
                return true;
            }
            hidden = true;
            if (!hiddenSince.TryGetValue(resultId, out since))
            {
                hiddenSince[resultId] = since = clock();
                Sweep();
            }
            return true;
        }
    }

    /// <summary>Released results leave both sets (results.close).</summary>
    public void Forget(IEnumerable<uint> resultIds)
    {
        lock (gate)
            foreach (var id in resultIds)
            {
                visible.Remove(id);
                hiddenSince.Remove(id);
                shownSince.Remove(id);
            }
    }

    /// <summary>Every result was released (the service's disposal).</summary>
    public void Clear()
    {
        lock (gate)
        {
            visible = [];
            hiddenSince.Clear();
            shownSince.Clear();
            sweepAt = SweepFloor;
        }
    }

    /// <summary>Drops released results' entries once the table has doubled since the last sweep: amortized, each entry
    /// costs a constant number of store lookups however often sets arrive.</summary>
    private void Sweep()
    {
        if (hiddenSince.Count < sweepAt) return;
        foreach (var id in hiddenSince.Keys.Where(id => !exists(id)).ToList()) hiddenSince.Remove(id);
        sweepAt = Math.Max(SweepFloor, hiddenSince.Count * 2);
    }
}
