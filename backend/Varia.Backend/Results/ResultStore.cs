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
internal sealed class QueryBudget(string sessionId, LiveBudget? live = null)
{
    internal long used;
    private int stopped;
    public string SessionId { get; } = sessionId;
    /// <summary>The live subscription this budget belongs to, or null for a query's.</summary>
    public LiveBudget? Live { get; } = live;
    public long UsedBytes => Interlocked.Read(ref used);
    /// <summary>Set by the first failed reservation: later rows and later result sets of the query store nothing.</summary>
    public TruncationReason Stopped => (TruncationReason)Volatile.Read(ref stopped);
    internal void Stop(TruncationReason reason) => Interlocked.CompareExchange(ref stopped, (int)reason, 0);
}

/// <summary>Query results kept in backend memory (never on disk) under a byte budget: a global one, at most half of it per
/// query, and nothing more while the operating system reports high memory load. Reading from SQL Server never waits for
/// the UI; a full budget truncates what is stored, with the reason. Results are released only by results.close, the next
/// query on the same session (tab), or the process ending: closing a session or disconnecting keeps them, as SSMS does.</summary>
internal sealed class ResultStore
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
    private readonly Func<(long Load, long Threshold)> memory;
    private uint nextId = 1;
    private long used;
    private long liveUsed;
    private long freedSinceCollect;
    private long freedSinceCompact;
    private int collecting;

    /// <param name="memory">The operating system's memory load and its high-load threshold, in bytes.</param>
    public ResultStore(long globalBytes, long queryBytes, Func<(long Load, long Threshold)>? memory = null)
    {
        if (globalBytes <= 0 || queryBytes <= 0) throw new ArgumentOutOfRangeException(nameof(globalBytes));
        GlobalBytes = globalBytes;
        QueryBytes = Math.Min(queryBytes, globalBytes);
        this.memory = memory ?? SystemMemory;
        LiveBytes = globalBytes / 4;
    }

    /// <summary>A quarter of the memory available to the process (container-aware), within 256 MiB to 2 GiB, half of it
    /// per query. <paramref name="globalOverride"/> (VARIA_RESULT_BUDGET_BYTES, test hooks only) replaces the global figure.</summary>
    public static ResultStore FromSystem(long? globalOverride = null)
    {
        var global = globalOverride is > 0 ? globalOverride.Value : Math.Clamp(GC.GetGCMemoryInfo().TotalAvailableMemoryBytes / 4, 256L << 20, 2L << 30);
        return new ResultStore(global, global / 2);
    }

    private static (long, long) SystemMemory()
    {
        var info = GC.GetGCMemoryInfo();
        return (info.MemoryLoadBytes, info.HighMemoryLoadThresholdBytes);
    }

    public long GlobalBytes { get; }
    public long QueryBytes { get; }
    public long UsedBytes => Interlocked.Read(ref used);
    /// <summary>What all live tables may hold together (the live share of the budget), and hold now.</summary>
    public long LiveBytes { get; private set; }
    public long LiveUsedBytes => Interlocked.Read(ref liveUsed);
    /// <summary>Bytes released toward the next forced collection (the checks read it).</summary>
    internal long FreedSinceCollect => Interlocked.Read(ref freedSinceCollect);
    /// <summary>Sets the live share: <paramref name="share"/> of the global budget (limits.live.budgetShare).</summary>
    public void ShareWithLive(double share) => LiveBytes = (long)(GlobalBytes * Math.Clamp(share, 0, 1));
    public int Count { get { lock (gate) return sets.Count; } }

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
    public ResultSetBuffer? Open(QueryBudget query, int index, int batchNumber, int iteration, string kind, IReadOnlyList<ResultColumn> columns, IReadOnlyList<WireKind> wires, bool transfer = false)
    {
        // A live set's pages stay off the large object heap; see LiveBudget.
        var sealBytes = query.Live is null ? PageBuilder.SealBytes : LiveSealBytes;
        if (query.Stopped != TruncationReason.None) return null;
        var metadata = 512 + columns.Sum(column => 2L * column.Name.Length + 64);
        if (transfer) Force(query, metadata);
        else if (!TryReserve(query, metadata, false, out var reason))
        {
            query.Stop(reason);
            return null;
        }
        lock (gate)
        {
            if (nextId == 0)
            {
                Return(query, metadata);
                throw new RequestException("BACKEND_ERROR", "Result identifiers are exhausted. Restart the SQL backend.");
            }
            var set = new ResultSetBuffer(this, query, nextId++, index, batchNumber, iteration, kind, columns, wires, metadata, sealBytes);
            sets[set.ResultId] = set;
            return set;
        }
    }

    /// <summary>Reserves bytes for a query. Checks run in this order: the system's memory load (only when asked, at page
    /// seals), the query's half of the budget, for a live table its subscription's limit (QueryBudget) and the live share
    /// (GlobalBudget), then the global budget.</summary>
    public bool TryReserve(QueryBudget query, long bytes, bool checkSystem, out TruncationReason reason)
    {
        if (checkSystem && IsSystemMemoryLow()) { reason = TruncationReason.SystemMemory; return false; }
        if (Interlocked.Read(ref query.used) + bytes > QueryBytes) { reason = TruncationReason.QueryBudget; return false; }
        var live = query.Live;
        // Added first and taken back on a refusal, so concurrent reservations never pass a limit together.
        if (live is not null)
        {
            if (Interlocked.Add(ref live.used, bytes) > live.Limit)
            {
                Interlocked.Add(ref live.used, -bytes);
                reason = TruncationReason.QueryBudget;
                return false;
            }
            if (Interlocked.Add(ref liveUsed, bytes) > LiveBytes)
            {
                Interlocked.Add(ref liveUsed, -bytes);
                Interlocked.Add(ref live.used, -bytes);
                reason = TruncationReason.GlobalBudget;
                return false;
            }
        }
        for (var current = Interlocked.Read(ref used); ; current = Interlocked.Read(ref used))
        {
            if (current + bytes > GlobalBytes)
            {
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
        Interlocked.Add(ref query.used, bytes);
        reason = TruncationReason.None;
        return true;
    }

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
    }

    public bool IsSystemMemoryLow()
    {
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

    /// <summary>Releases the given ids (unknown and repeated ids are skipped) and returns how many were released.</summary>
    public int Release(IEnumerable<uint> resultIds)
    {
        List<ResultSetBuffer> released = [];
        lock (gate)
        {
            foreach (var id in resultIds) if (sets.Remove(id, out var set)) released.Add(set);
        }
        return Free(released);
    }

    public int ReleaseSession(string sessionId) => Release(set => set.Budget.SessionId == sessionId);
    public int ReleaseAll() => Release(_ => true);

    private int Release(Func<ResultSetBuffer, bool> match)
    {
        List<ResultSetBuffer> released;
        lock (gate)
        {
            released = [.. sets.Values.Where(match)];
            foreach (var set in released) sets.Remove(set.ResultId);
        }
        return Free(released);
    }

    private int Free(List<ResultSetBuffer> released)
    {
        long freed = 0;
        foreach (var set in released)
        {
            var bytes = set.Release();
            if (set.Budget.Live is null) freed += bytes;
        }
        Freed(freed);
        return released.Count;
    }

    /// <summary>Memory a release returned, now or when a leased set's last job ended. Live tables' memory is not counted:
    /// see LiveBudget.</summary>
    internal void Freed(long freed, bool live = false)
    {
        if (freed == 0 || live) return;
        // Counted across calls: closing many small results, together or one at a time, frees as much as one large release.
        var sinceCollect = Interlocked.Add(ref freedSinceCollect, freed);
        var sinceCompact = Interlocked.Add(ref freedSinceCompact, freed);
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
        _ = Task.Delay(100).ContinueWith(_ =>
        {
            Volatile.Write(ref collecting, 0);
            CollectNow();
        }, TaskScheduler.Default);
    }

    private void CollectNow()
    {
        Interlocked.Exchange(ref freedSinceCollect, 0);
        if (UsedBytes <= Interlocked.Read(ref freedSinceCompact))
        {
            Interlocked.Exchange(ref freedSinceCompact, 0);
            GC.Collect(2, GCCollectionMode.Aggressive, blocking: true, compacting: true);
        }
        else GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: false);
    }
}
