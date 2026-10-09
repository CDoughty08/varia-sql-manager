using System.Runtime;

namespace Varia.Backend.Results;

/// <summary>Why a result stopped storing rows. Execution always continues; only storage stops.</summary>
internal enum TruncationReason { None, RowLimit, QueryBudget, GlobalBudget, SystemMemory }

/// <summary>One query's share of the result budget, and the reason it stopped storing rows, if it did.</summary>
internal sealed class QueryBudget(string sessionId, string connectionId)
{
    internal long used;
    private int stopped;
    public string SessionId { get; } = sessionId;
    public string ConnectionId { get; } = connectionId;
    public long UsedBytes => Interlocked.Read(ref used);
    /// <summary>Set by the first failed reservation: later rows and later result sets of the query store nothing.</summary>
    public TruncationReason Stopped => (TruncationReason)Volatile.Read(ref stopped);
    internal void Stop(TruncationReason reason) => Interlocked.CompareExchange(ref stopped, (int)reason, 0);
}

/// <summary>Query results kept in backend memory (never on disk) under a byte budget: a global one, at most half of it per
/// query, and nothing more while the operating system reports high memory load. Reading from SQL Server never waits for
/// the UI; a full budget truncates what is stored, with the reason.</summary>
internal sealed class ResultStore
{
    /// <summary>Bookkeeping charged per sealed page on top of its bytes.</summary>
    public const long PageOverhead = 96;
    /// <summary>Reservations are taken in steps this size, so the global counter is not touched for every row.</summary>
    public const long ReserveStep = 256 * 1024;
    private const long CompactAfterRelease = 64L * 1024 * 1024;
    private readonly object gate = new();
    private readonly Dictionary<uint, ResultSetBuffer> sets = [];
    private readonly Func<(long Load, long Threshold)> memory;
    private uint nextId = 1;
    private long used;

    /// <param name="memory">The operating system's memory load and its high-load threshold, in bytes.</param>
    public ResultStore(long globalBytes, long queryBytes, Func<(long Load, long Threshold)>? memory = null)
    {
        if (globalBytes <= 0 || queryBytes <= 0) throw new ArgumentOutOfRangeException(nameof(globalBytes));
        GlobalBytes = globalBytes;
        QueryBytes = Math.Min(queryBytes, globalBytes);
        this.memory = memory ?? SystemMemory;
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
    public int Count { get { lock (gate) return sets.Count; } }

    /// <summary>A new query on a session replaces that session's earlier results.</summary>
    public QueryBudget BeginQuery(string sessionId, string connectionId)
    {
        ReleaseSession(sessionId);
        return new QueryBudget(sessionId, connectionId);
    }

    /// <summary>Opens a result set; its column metadata is charged at once (512 bytes plus 2 per name character and 64
    /// per column), whatever the budget, because the descriptor exists either way.</summary>
    public ResultSetBuffer Open(QueryBudget query, int index, int batchNumber, int iteration, string kind, IReadOnlyList<ResultColumn> columns, IReadOnlyList<WireKind> wires)
    {
        ResultSetBuffer set;
        lock (gate)
        {
            if (nextId == 0) throw new RequestException("BACKEND_ERROR", "Result identifiers are exhausted. Restart the SQL backend.");
            set = new ResultSetBuffer(this, query, nextId++, index, batchNumber, iteration, kind, columns, wires);
            sets[set.ResultId] = set;
        }
        set.Charge(512 + columns.Sum(column => 2L * column.Name.Length + 64));
        return set;
    }

    /// <summary>Reserves bytes for a query. Checks run in this order: the system's memory load (only when asked, at page
    /// seals), the query's half of the budget, then the global budget.</summary>
    public bool TryReserve(QueryBudget query, long bytes, bool checkSystem, out TruncationReason reason)
    {
        if (checkSystem && IsSystemMemoryLow()) { reason = TruncationReason.SystemMemory; return false; }
        if (Interlocked.Read(ref query.used) + bytes > QueryBytes) { reason = TruncationReason.QueryBudget; return false; }
        for (var current = Interlocked.Read(ref used); ; current = Interlocked.Read(ref used))
        {
            if (current + bytes > GlobalBytes) { reason = TruncationReason.GlobalBudget; return false; }
            if (Interlocked.CompareExchange(ref used, current + bytes, current) == current) break;
        }
        Interlocked.Add(ref query.used, bytes);
        reason = TruncationReason.None;
        return true;
    }

    /// <summary>Charges bytes whatever the budget (metadata, and the few bytes by which a sealed page exceeds its rows' estimate).</summary>
    internal void Force(QueryBudget query, long bytes)
    {
        Interlocked.Add(ref used, bytes);
        Interlocked.Add(ref query.used, bytes);
    }

    public void Return(QueryBudget query, long bytes)
    {
        if (bytes == 0) return;
        Interlocked.Add(ref used, -bytes);
        Interlocked.Add(ref query.used, -bytes);
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

    public bool Release(uint resultId) => Release(set => set.ResultId == resultId) == 1;
    public int ReleaseSession(string sessionId) => Release(set => set.Budget.SessionId == sessionId);
    public int ReleaseConnection(string connectionId) => Release(set => set.Budget.ConnectionId == connectionId);
    public int ReleaseAll() => Release(_ => true);

    private int Release(Func<ResultSetBuffer, bool> match)
    {
        List<ResultSetBuffer> released;
        lock (gate)
        {
            released = [.. sets.Values.Where(match)];
            foreach (var set in released) sets.Remove(set.ResultId);
        }
        long freed = 0;
        foreach (var set in released) freed += set.Release();
        // Large pages live on the large object heap; compact it once after a big release so the memory goes back.
        if (freed > CompactAfterRelease) GCSettings.LargeObjectHeapCompactionMode = GCLargeObjectHeapCompactionMode.CompactOnce;
        return released.Count;
    }
}
