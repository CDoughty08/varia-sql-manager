using System.Data;
using System.Diagnostics;
using System.Globalization;
using Varia.Backend.Agent;

namespace Varia.Backend.Actions;

/// <summary>The Log File Viewer's writes and reads that are not live (AG-5a, docs/sql-server-agent.md). Delete History is actions.execute's
/// deleteJobHistory, no catalogue action (it has no menu verb or Script): one batch in one transaction (AgentSql.History.cs) purging the checked
/// jobs' history, all of it or only rows older than a cut-off the server computes, on SQL Server and Managed Instance. msdb refuses a login that
/// may not purge a job (14392, PERMISSION_DENIED); a job gone or hidden since the viewer listed it is 50010 (NOT_FOUND); 15281 is AGENT_STOPPED.
/// agent.historyMessage reads one history row's whole message (the grids cut messages): sysjobhistory for sysadmin, else the job's history
/// through sp_help_jobhistory, which every Agent role may run.</summary>
internal sealed partial class ActionService
{
    internal const string DeleteJobHistoryAction = "deleteJobHistory";
    internal const string DeleteHistoryStep = "Delete job history";
    internal const string HistoryMessageGone = "This history row no longer exists: SQL Server Agent's history cap or a purge removed it. Refresh the Log File Viewer.";
    internal const string HistoryMessageBeyond = "This row is older than the newest history rows of the job this login can read, so its whole message cannot be read here; the grid shows its start.";

    /// <summary>Re-validates deleteJobHistoryRequestSchema (src/shared/agent/history.ts). Null for any other action, after refusing agentHistory
    /// on it.</summary>
    private ObjectRefDto? ValidateAgentHistory(ActionArgs args, bool script)
    {
        if (args.Action != DeleteJobHistoryAction)
        {
            if (args.AgentHistory is not null) throw Invalid(args.Action + " takes no agentHistory.");
            return null;
        }
        if (script) throw Invalid(args.Action + " has no script.");
        if (args.Target != new ObjectRefDto("agent")) throw Invalid("target.");
        if (args with { AgentHistory = null } != new ActionArgs(args.Action, args.ConnectionId, args.RequestId, args.Target)) throw Invalid(args.Action + " takes only agentHistory.");
        if (args.AgentHistory is not { } history || !HistoryDeleteValid(history)) throw Invalid("agentHistory.");
        return args.Target;
    }

    /// <summary>Whether a Delete History scope is one zod admits: 1 to historyJobs job ids, each once, and exactly one of All (true) and OlderThan
    /// (Agent Properties' purge bounds).</summary>
    internal static bool HistoryDeleteValid(AgentHistoryDeleteDto history)
    {
        var limits = AgentCatalog.Current;
        if (history.Jobs is not { Count: > 0 } jobs || jobs.Count > limits.Limit("historyJobs")) return false;
        if (jobs.Any(id => id is not { Length: 36 } || !Guid.TryParseExact(id, "D", out _))) return false;
        if (jobs.Select(id => id.ToLowerInvariant()).Distinct(StringComparer.Ordinal).Count() != jobs.Count) return false;
        if (history.All is not null == history.OlderThan is not null) return false;
        if (history.All is false) return false;
        return history.OlderThan is not { } older
            || older.Count >= 1 && older.Count <= limits.Limit("purgeCount") && older.Unit is >= 1 and <= 3 && (older.Before is not { } before || PurgeBefore(before) is not null);
    }

    /// <summary>Delete History's parameter values in <see cref="AgentSql.HistoryDeleteParameters"/>' order.</summary>
    internal static object?[] HistoryDeleteValues(AgentHistoryDeleteDto history) =>
        [.. history.Jobs!.Select(id => (object?)Guid.ParseExact(id, "D")),
            .. history.OlderThan is { } older ? new object?[] { older.Count, older.Unit, older.Before is { } before ? PurgeBefore(before) : null } : []];

    private Task<ActionExecuteResult> ExecuteAgentHistoryAsync(ActionArgs args, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var engine = host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine;
        if (engine is not ("box" or "managedInstance")) return Task.FromResult(new ActionExecuteResult([], [], 0, Error("NOT_SUPPORTED", EngineMessage(engine))));
        var history = args.AgentHistory!;
        var older = history.OlderThan is not null;
        var count = history.Jobs!.Count;
        return RunAsync(args.ConnectionId, args.RequestId, null, read: false, null, token,
            async (connection, profile, band, job) =>
            {
                // sp_purge_jobhistory reports how many rows it deleted as an informational message (14226).
                var messages = CollectMessages(connection);
                var parameters = AgentSql.HistoryDeleteParameters(count, older);
                var values = HistoryDeleteValues(history);
                var step = new RunStep(DeleteHistoryStep, async context =>
                {
                    try
                    {
                        await using var command = connection.CreateCommand();
                        command.CommandText = AgentSql.HistoryDelete(count, older);
                        command.CommandTimeout = 0;
                        for (var i = 0; i < parameters.Count; i++) Add(command, parameters[i].Name, parameters[i].Type, parameters[i].Size, values[i]);
                        await ReadAllAsync(command, context.Token);
                    }
                    catch (Microsoft.Data.SqlClient.SqlException error) when (!context.Token.IsCancellationRequested && FirstNumber(error) == 15281)
                    {
                        throw new StepRefusedException(Error("AGENT_STOPPED", AgentStoppedMessage));
                    }
                }, Detail: count == 1 ? "1 job" : count.ToString(CultureInfo.InvariantCulture) + " jobs");
                var (steps, failure, _) = await RunStepsAsync(connection, [step], null, job, CleanupBudget(DeleteJobHistoryAction));
                return new ActionExecuteResult(steps, messages.Collected(), watch.ElapsedMilliseconds, failure);
            },
            error => new ActionExecuteResult([], [], watch.ElapsedMilliseconds, error));
    }

    // --- agent.historyMessage ------------------------------------------------------------------------------------------------

    /// <summary>Re-validates agentHistoryMessageSchema: the ids, the job id and an instance_id of 1 or more.</summary>
    internal static void Validate(AgentHistoryMessageArgs args)
    {
        Ids(args.ConnectionId, args.RequestId);
        if (args.JobId is not { Length: 36 } || !Guid.TryParseExact(args.JobId, "D", out _)) throw Invalid("jobId.");
        if (args.InstanceId < 1) throw Invalid("instanceId.");
    }

    public Task<AgentHistoryMessageResult> HistoryMessageAsync(AgentHistoryMessageArgs args, CancellationToken token)
    {
        Validate(args);
        var watch = Stopwatch.StartNew();
        var engine = host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine;
        if (engine is not ("box" or "managedInstance")) return Task.FromResult(new AgentHistoryMessageResult(null, 0, Error("NOT_SUPPORTED", EngineMessage(engine))));
        var jobId = Guid.ParseExact(args.JobId, "D");
        return RunAsync(args.ConnectionId, args.RequestId, null, read: true, Options.DescribeBudget, token,
            async (connection, profile, band, job) => await ReadHistoryMessageAsync(new AgentReader(), connection, jobId, args.InstanceId, job) with { ElapsedMs = watch.ElapsedMilliseconds },
            error => new AgentHistoryMessageResult(null, watch.ElapsedMilliseconds, error), "Reading the message");
    }

    /// <summary>The row's message: sysjobhistory directly, and where the login may not read it (every role below sysadmin), the job's history through
    /// msdb, which shows that login only what it may see.</summary>
    internal async Task<AgentHistoryMessageResult> ReadHistoryMessageAsync(AgentReader reader, Microsoft.Data.SqlClient.SqlConnection? connection, Guid jobId, int instance, CancellationToken token)
    {
        var (results, errors) = await reader.ReadAsync(connection, null, [AgentSql.HistoryMessage], (_, parameter) => parameter.Name == "@job_id" ? jobId : instance, token);
        if (results.TryGetValue(AgentSql.HistoryMessage.Id, out var direct))
            return direct.Rows.Count > 0 ? new(direct.Value(direct.Rows[0], "message") as string, 0) : new(null, 0, Error("NOT_FOUND", HistoryMessageGone));
        if (errors.FirstOrDefault() is { Code: not "PERMISSION_DENIED" } failed) return new(null, 0, HistoryReadError(failed));
        (results, errors) = await reader.ReadAsync(connection, null, [AgentSql.History], (_, _) => jobId, token);
        if (!results.TryGetValue(AgentSql.History.Id, out var history)) return new(null, 0, HistoryReadError(errors[0]));
        foreach (var row in history.Rows)
            if (Convert.ToInt32(history.Value(row, "instance_id"), CultureInfo.InvariantCulture) == instance) return new(history.Value(row, "message") as string, 0);
        return new(null, 0, Error("NOT_FOUND", history.Truncated ? HistoryMessageBeyond : HistoryMessageGone));
    }

    private ActionError HistoryReadError(AgentReadError failed) => failed.Code switch
    {
        "AGENT_DISABLED" => Error("AGENT_STOPPED", AgentStoppedMessage),
        "PERMISSION_DENIED" or "NOT_SUPPORTED" or "TIMEOUT" or "NOT_FOUND" => Error(failed.Code, failed.Message),
        _ => Error("SQL_ERROR", failed.Message)
    };
}
