using Varia.Backend.Plans;
using Varia.Backend.Protocol;
using Microsoft.Data.SqlClient;

namespace Varia.Backend;

internal sealed partial class SqlService
{
    // Own gate: compilation waiting on schema locks cannot consume metadata or live-plan slots. Never queue.
    private readonly SemaphoreSlim estimatedPlans = new(2, 2);
    internal TimeSpan EstimatedPlanBudget { get; set; } = EstimatedPlanCapture.Budget;

    private async Task<EstimatedPlanResult> EstimateAsync(EstimatedPlanArgs args, RequestContext? context)
    {
        if (string.IsNullOrWhiteSpace(args.Sql) || args.Sql.Length > 1_000_000 || args.StartLine is < 1 or > 1_000_000
            || !Guid.TryParse(args.RequestId, out _) || !Guid.TryParse(args.SessionId, out _) || args.Mode is not ("isolated" or "session"))
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
            var batches = EstimatedPlanScript.Parse(args.Sql, args.StartLine, args.Mode == "session");
            cancellation.Token.ThrowIfCancellationRequested();
            entered = estimatedPlans.Wait(0);
            if (!entered) throw new RequestException("BUSY", "Two estimated plans are already being acquired. Try again shortly.");
            if (args.Mode == "session") return await EstimateSessionAsync(args, batches, cancellation.Token);
            // CreateConnection installs the identity guard; promote that same owner for the estimated-plan ledger.
            await using var connection = Owned(CreateConnection(args.ConnectionId, args.Database, stateful: true), args.ConnectionId);
            await Open(connection, cancellation.Token);
            return await EstimatedPlanCapture.ReadAsync(connection, batches, args.StartLine, cancellation.Token);
        }
        catch (Exception error) when (cancellation.IsCancellationRequested && error is OperationCanceledException or Microsoft.Data.SqlClient.SqlException or InvalidOperationException)
        {
            var cancelled = running.UserCancelled || context?.Reason is CancelReason.User or CancelReason.ConsumerGone or CancelReason.Shutdown;
            throw new RequestException(cancelled ? "CANCELLED" : "TIMEOUT", (cancelled ? "Estimated plan acquisition was cancelled. No submitted SQL was executed."
                : "Estimated plan acquisition exceeded its 30-second limit. No submitted SQL was executed.")
                + (args.Mode != "session" ? "" : sessions.TryGetValue(args.SessionId, out var retained) && retained.HasOpened
                    ? " The query session remains open. @@ROWCOUNT and @@ERROR may have changed. SQL Server may have rolled back its transaction (for example with XACT_ABORT ON); check @@TRANCOUNT before continuing."
                    : " No query session remains open."));
        }
        finally
        {
            queries.TryRemove(new(args.RequestId, running));
            if (entered) estimatedPlans.Release();
        }
    }

    private async Task<EstimatedPlanResult> EstimateSessionAsync(EstimatedPlanArgs args, List<EstimatedPlanScript.Batch> batches, CancellationToken token)
    {
        // Session() checks the target, limit and competing requests under the existing ownership lock. The gate also
        // excludes transaction-state reads/commit, and stays held through bounded capture cleanup.
        var session = Session(new QueryArgs(args.ConnectionId, args.SessionId, args.Database, args.Sql, args.RequestId, 0, 0));
        if (!session.TryEnter()) throw new RequestException("SESSION_BUSY", "The query session is busy. Wait for its operation to finish before estimating.");
        try
        {
            session.Connection.FireInfoMessageEventOnUserErrors = false;
            await OpenSessionAsync(session, token);
            var result = await EstimatedPlanCapture.ReadAsync(session.Connection, batches, args.StartLine, token, args.Database, SessionFault);
            return result with { Session = session.Spid is { } spid ? new(spid, session.Login) : null };
        }
        catch (EstimatedPlanCleanupException)
        {
            throw Lost(args.SessionId, session, "Estimated plan capture cleanup could not be confirmed, so Varia closed the query session to prevent ordinary SQL from running with capture enabled. "
                + LostMessage(session, committing: false, commit: false) + " Temporary objects and SET options are gone. Execute again to open a new session. No submitted SQL was executed.");
        }
        catch (Exception error) when (session.HasOpened && error is SqlException or InvalidOperationException or IOException && IsSessionLost(error, session.Connection.State))
        {
            throw Lost(args.SessionId, session, "The query session was lost during estimation. " + LostMessage(session, committing: false, commit: false)
                + " Temporary objects and SET options are gone. Execute again to open a new session. No submitted SQL was executed.");
        }
        catch (RequestException error) when (error.Code == "SESSION_LOST")
        {
            throw Lost(args.SessionId, session, error.Message);
        }
        catch (RequestException error) when (error.Code is "SQL_ERROR" or "TOO_LARGE")
        {
            throw new RequestException(error.Code, error.Message + " The query session remains open. @@ROWCOUNT and @@ERROR may have changed.");
        }
        catch (SqlException error) when (!token.IsCancellationRequested)
        {
            throw new RequestException("SQL_ERROR", (error.Message.Length > 16_000 ? error.Message[..16_000] : error.Message)
                + (session.HasOpened ? " Capture cleanup completed; the query session remains usable. @@ROWCOUNT and @@ERROR may have changed."
                    : " The SQL session could not be opened. No query session remains open. No submitted SQL was executed."));
        }
        finally
        {
            // Opening/prologue failures have no established state to retain, just as for ordinary execution.
            if (!session.HasOpened) { sessions.TryRemove(new(args.SessionId, session)); session.Close(); }
            session.Exit();
        }
    }
}
