namespace Varia.Backend.Results;

/// <summary>
/// Which results' grids the renderer shows in any window, popouts included (results.visibility), and since when each
/// other stored result has been hidden: the input of a memory policy for results nobody can see
/// (stage 1 of the page compression plan). It is a hint: the renderer sends the whole visible set each time it
/// changes, and again to a new backend, so a lost or late message only delays such a policy, never loses rows.
/// It holds no pages and changes nothing in the store; ids are kept only while <paramref name="exists"/> says their result
/// is stored, and both sets are bounded.
/// </summary>
/// <param name="exists">Whether a result is stored (not released); called under this class's own lock, never the reverse.</param>
/// <param name="now">Milliseconds on a monotonic clock (<see cref="Environment.TickCount64"/> by default); the checks pass their own.</param>
internal sealed class ResultVisibility(Func<uint, bool> exists, Func<long>? now = null)
{
    /// <summary>The most ids one set names (src/shared/ipc/wire/protocol.ts limits.visibility.maxResults).</summary>
    public const int MaxResults = 4096;
    /// <summary>The most hidden-since entries kept; past it, released results go first, then the longest hidden.</summary>
    public const int MaxTracked = 16_384;

    private readonly object gate = new();
    private readonly Func<long> clock = now ?? (() => Environment.TickCount64);
    private HashSet<uint> visible = [];
    private readonly Dictionary<uint, long> hiddenSince = [];

    /// <summary>The clock <see cref="IsHidden"/>'s timestamps are on.</summary>
    public long Now => clock();
    public int VisibleCount { get { lock (gate) return visible.Count; } }
    public int TrackedCount { get { lock (gate) return hiddenSince.Count; } }

    /// <summary>Replaces the visible set. A result that leaves it is hidden from now; ids of results not stored are ignored.
    /// Returns how many ids the set kept.</summary>
    public int Set(IEnumerable<uint> ids)
    {
        var at = clock();
        lock (gate)
        {
            HashSet<uint> next = [];
            foreach (var id in ids) if (next.Count < MaxResults && exists(id)) next.Add(id);
            foreach (var id in visible) if (!next.Contains(id) && exists(id)) hiddenSince[id] = at;
            foreach (var id in next) hiddenSince.Remove(id);
            visible = next;
            // Each set also drops what releases left behind, so entries never outlive their results by more than one message.
            foreach (var id in hiddenSince.Keys.Where(id => !exists(id)).ToList()) hiddenSince.Remove(id);
            Bound();
            return visible.Count;
        }
    }

    /// <summary>Whether a stored result's grid is shown in no window, and since when (on <see cref="Now"/>'s clock). A stored
    /// result never shown counts as hidden from the first time it is asked about. A released result is neither.</summary>
    public bool IsHidden(uint resultId, out long since)
    {
        lock (gate)
        {
            since = 0;
            if (!exists(resultId))
            {
                hiddenSince.Remove(resultId);
                visible.Remove(resultId);
                return false;
            }
            if (visible.Contains(resultId)) return false;
            if (!hiddenSince.TryGetValue(resultId, out since))
            {
                hiddenSince[resultId] = since = clock();
                Bound();
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
            }
    }

    /// <summary>Every result was released (the service's disposal).</summary>
    public void Clear()
    {
        lock (gate)
        {
            visible = [];
            hiddenSince.Clear();
        }
    }

    private void Bound()
    {
        if (hiddenSince.Count <= MaxTracked) return;
        foreach (var id in hiddenSince.Keys.Where(id => !exists(id)).ToList()) hiddenSince.Remove(id);
        if (hiddenSince.Count <= MaxTracked) return;
        // Forgetting the longest hidden only makes it look hidden for less time: a later IsHidden starts it again.
        foreach (var (id, _) in hiddenSince.OrderBy(pair => pair.Value).Take(hiddenSince.Count - MaxTracked).ToList()) hiddenSince.Remove(id);
    }
}
