using Varia.Backend.Plans;
using Varia.Backend.Protocol;

namespace Varia.Backend;

internal sealed partial class SqlService
{
    // Own gate: compilation waiting on schema locks cannot consume metadata or live-plan slots. Never queue.
    private readonly SemaphoreSlim estimatedPlans = new(2, 2);
    internal TimeSpan EstimatedPlanBudget { get; set; } = EstimatedPlanCapture.Budget;

    private async Task<EstimatedPlanResult> EstimateAsync(EstimatedPlanArgs args, RequestContext? context)
    {
        if (string.IsNullOrWhiteSpace(args.Sql) || args.Sql.Length > 1_000_000 || args.StartLine is < 1 or > 1_000_000
            || !Guid.TryParse(args.RequestId, out _) || !Guid.TryParse(args.SessionId, out _))
            throw new RequestException("INVALID_PARAMS", "Estimated plan text, request ID, session ID or start line is invalid.");
        Name(args.Database);
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(Token(context));
        cancellation.CancelAfter(EstimatedPlanBudget);
        var running = new RunningQuery(args.ConnectionId, args.SessionId, cancellation);
        if (!Register(args.RequestId, running)) throw new RequestException("DUPLICATE_QUERY", "This request is already running.");
        var entered = false;
        try
        {
            if (queries.Values.Count(query => query.SessionId == args.SessionId) > 1)
                throw new RequestException("SESSION_BUSY", "A query or estimated plan is already running in this tab.");
            var batches = EstimatedPlanScript.Parse(args.Sql, args.StartLine);
            cancellation.Token.ThrowIfCancellationRequested();
            entered = estimatedPlans.Wait(0);
            if (!entered) throw new RequestException("BUSY", "Two estimated plans are already being acquired. Try again shortly.");
            await using var connection = Owned(CreateConnection(args.ConnectionId, args.Database, stateful: true), args.ConnectionId);
            await Open(connection, cancellation.Token);
            return await EstimatedPlanCapture.ReadAsync(connection, batches, args.StartLine, cancellation.Token);
        }
        catch (Exception error) when (cancellation.IsCancellationRequested && error is OperationCanceledException or Microsoft.Data.SqlClient.SqlException or InvalidOperationException)
        {
            var cancelled = running.UserCancelled || context?.Reason is CancelReason.User or CancelReason.ConsumerGone or CancelReason.Shutdown;
            throw new RequestException(cancelled ? "CANCELLED" : "TIMEOUT", cancelled ? "Estimated plan acquisition was cancelled. No submitted SQL was executed."
                : "Estimated plan acquisition exceeded its 30-second limit. No submitted SQL was executed.");
        }
        finally
        {
            queries.TryRemove(new(args.RequestId, running));
            if (entered) estimatedPlans.Release();
        }
    }
}
