using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.MultiQuery;

internal enum MultiCommitOutcome
{
    Committed,
    Refused,
    CancelledBeforeSend,
    InDoubt
}

internal sealed record MultiCommitResult(
    MultiCommitOutcome Outcome,
    MultiTargetError? Error = null);

internal sealed record MultiTargetPreflightOutcome(
    string TargetKey,
    bool Passed,
    MultiTargetError? Error = null,
    long? EstimatedBytes = null);

internal sealed record ReadOnlySqlViolation(int Line, int Column, int EndLine, int EndColumn, string Keyword, string Message);

/// <summary>Thread-safe shared result-set count and summary-descriptor byte quota across all targets and auto-combined sets of one multi-server run.</summary>
internal interface IMultiQueryQuota
{
    int MaxResultSets { get; }
    long MaxSummaryDescriptorBytes { get; }
    int KeptResultSets { get; }
    int DiscardedResultSets { get; }
    /// <summary>Claims the next global result-set index when both result-set count and summary descriptor byte caps allow it.</summary>
    bool TryAllocate(long descriptorBytes, out int index, out bool descriptorOversize);
    /// <summary>Refunds a previously claimed slot, index, and descriptor byte charge when storing the result set fails or is skipped.</summary>
    void Release(int index, long descriptorBytes);
    void RecordDiscarded(int count = 1);
}

internal sealed class MultiQueryQuota(int maxResultSets, long maxSummaryDescriptorBytes) : IMultiQueryQuota
{
    private readonly object gate = new();
    private readonly PriorityQueue<int, int> recycled = new();
    private readonly HashSet<int> recycledSet = [];
    private int nextIndex;
    private int kept;
    private int discarded;
    private long descriptorBytes;

    public int MaxResultSets { get; } = maxResultSets;
    public long MaxSummaryDescriptorBytes { get; } = maxSummaryDescriptorBytes;
    public int KeptResultSets { get { lock (gate) return kept; } }
    public int DiscardedResultSets { get { lock (gate) return discarded; } }

    public bool TryAllocate(long bytes, out int index, out bool descriptorOversize)
    {
        if (bytes < 0) bytes = 0;
        lock (gate)
        {
            if (kept >= MaxResultSets)
            {
                index = -1;
                descriptorOversize = false;
                return false;
            }
            if (bytes > MaxSummaryDescriptorBytes - descriptorBytes)
            {
                index = -1;
                descriptorOversize = true;
                return false;
            }
            if (recycled.TryDequeue(out var reused, out _))
            {
                recycledSet.Remove(reused);
                index = reused;
            }
            else if (nextIndex < MaxResultSets)
            {
                index = nextIndex++;
            }
            else
            {
                index = -1;
                descriptorOversize = false;
                return false;
            }
            kept++;
            descriptorBytes += bytes;
            descriptorOversize = false;
            return true;
        }
    }

    public void Release(int index, long bytes)
    {
        lock (gate)
        {
            if (index >= 0 && index < nextIndex && recycledSet.Add(index))
            {
                recycled.Enqueue(index, index);
                if (kept > 0) kept--;
                if (bytes > 0) descriptorBytes = Math.Max(0, descriptorBytes - bytes);
            }
        }
    }

    public void RecordDiscarded(int count = 1)
    {
        if (count <= 0) return;
        lock (gate) discarded += count;
    }
}

internal sealed record MultiTargetContext(
    string QueryId,
    string SessionId,
    string Mode,
    bool PreflightDryRun,
    MultiQueryTargetArgs Target,
    string Provider,
    string Sql,
    int StartLine,
    int StartColumn,
    int MaxRows,
    int MaxResultSets,
    int TimeoutSeconds,
    bool StopOnError,
    bool DiscardResults,
    bool? Prices,
    string? Residence,
    int? WindowCacheMiB,
    string? JobKey,
    IMultiQueryQuota Quota,
    Func<bool> IsAbandoned,
    QueryBudget Budget,
    QueryMessages Messages,
    QueryEventSink Events,
    Func<bool>? IsUserCancelled = null,
    Func<bool>? IsTimedOut = null,
    bool ReadOnlyValidated = false);

internal sealed record MultiTargetPhase1Result(
    MultiTargetOutcome Outcome,
    IReadOnlyList<ResultSetBuffer> ResultSets,
    bool NeedsCommit,
    int DiscardedResultSets = 0);

internal sealed record MultiTargetPhase1Outcome(
    MultiTargetPhase1Result Result,
    IMultiTargetPhase2Handle? Phase2 = null);

internal sealed record CombineOutput(
    ResultSetBuffer? Buffer,
    IReadOnlyList<string> Warnings);

internal interface IMultiQueryCoordinator
{
    Task<QueryMultiResult> ExecuteAsync(QueryMultiArgs args, RequestContext? context);
}

internal interface IMultiTargetPhase2Handle : IAsyncDisposable
{
    Task<MultiCommitResult> CommitAsync(CancellationToken token);
    Task RollbackAsync(CancellationToken token);
}

internal interface IMultiTargetRunner
{
    string Provider { get; }
    Task<IReadOnlyList<MultiTargetPreflightOutcome>> PreflightAsync(IReadOnlyList<MultiTargetContext> targets, CancellationToken token);
    Task<MultiTargetPhase1Outcome> ExecutePhase1Async(MultiTargetContext target, CancellationToken token);
}

internal interface IResultCombiner
{
    Task<CombineOutput> CombineAsync(
        ResultStore store,
        QueryBudget budget,
        IReadOnlyList<ResultSetBuffer> sources,
        int index,
        int batchNumber,
        int iteration,
        string? statementName,
        bool throwOnBudgetRefusal,
        CancellationToken token);
}

internal interface IReadOnlySqlValidator
{
    Task<IReadOnlyList<ReadOnlySqlViolation>> ValidateTSqlAsync(string sql, int startLine, CancellationToken token);
}
