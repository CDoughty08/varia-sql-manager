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

internal sealed record ReadOnlySqlViolation(int Line, int Column, int EndLine, int EndColumn, string Keyword, string Message);

internal sealed record MultiTargetContext(
    string QueryId,
    string SessionId,
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
    QueryBudget Budget,
    QueryMessages Messages,
    QueryEventSink Events);

internal sealed record MultiTargetPhase1Result(
    MultiTargetOutcome Outcome,
    IReadOnlyList<ResultSetBuffer> ResultSets,
    bool NeedsCommit);

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
    Task<MultiCommitOutcome> CommitAsync(CancellationToken token);
    Task RollbackAsync(CancellationToken token);
}

internal interface IMultiTargetRunner
{
    string Provider { get; }
    Task PreflightAsync(IReadOnlyList<MultiTargetContext> targets, CancellationToken token);
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
