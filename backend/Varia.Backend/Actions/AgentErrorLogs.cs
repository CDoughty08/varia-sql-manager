using System.Diagnostics;
using System.Globalization;
using Varia.Backend.Agent;

namespace Varia.Backend.Actions;

/// <summary>SQL Server Agent's error logs in the Log File Viewer (AG-5b, docs/sql-server-agent.md). agent.errorLogs lists them (xp_enumerrorlogs 2,
/// sysadmin) for the viewer's sources; where the server answers with no list (SQL Server on Linux) the current log is listed alone. Recycle is
/// actions.execute's recycleAgentErrorLog, no catalogue action (no row verb or Script), on the Agent node: one call of sp_cycle_agent_errorlog on a
/// SQL Server box (Managed Instance reads its log through sp_readmierrorlog and is not offered Recycle). msdb grants it to sysadmin alone (229,
/// PERMISSION_DENIED); 22022 (Agent not running, so it cannot be told) and 15281 (Agent XPs off) are AGENT_STOPPED.</summary>
internal sealed partial class ActionService
{
    internal const string RecycleErrorLogAction = "recycleAgentErrorLog";
    internal const string RecycleStep = "Recycle the SQL Server Agent error log";

    /// <summary>Re-validates recycleAgentErrorLogRequestSchema (src/shared/agent/error-log.ts): the Agent node and nothing else. Null for any other action.</summary>
    private ObjectRefDto? ValidateAgentErrorLog(ActionArgs args, bool script)
    {
        if (args.Action != RecycleErrorLogAction) return null;
        if (script) throw Invalid(args.Action + " has no script.");
        if (args.Target != new ObjectRefDto("agent")) throw Invalid("target.");
        if (args != new ActionArgs(args.Action, args.ConnectionId, args.RequestId, args.Target)) throw Invalid(args.Action + " takes no other arguments.");
        return args.Target;
    }

    private Task<ActionExecuteResult> ExecuteRecycleErrorLogAsync(ActionArgs args, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var engine = host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine;
        if (engine != "box") return Task.FromResult(new ActionExecuteResult([], [], 0, Error("NOT_SUPPORTED", engine == "managedInstance" ? RecycleManagedInstanceMessage : EngineMessage(engine))));
        return RunAsync(args.ConnectionId, args.RequestId, null, read: false, null, token,
            async (connection, profile, band, job) =>
            {
                var messages = CollectMessages(connection);
                var step = new RunStep(RecycleStep, async context =>
                {
                    try
                    {
                        await using var command = connection.CreateCommand();
                        command.CommandText = AgentSql.Recycle;
                        command.CommandTimeout = 0;
                        await ReadAllAsync(command, context.Token);
                    }
                    catch (Microsoft.Data.SqlClient.SqlException error) when (!context.Token.IsCancellationRequested && FirstNumber(error) is 15281 or 22022)
                    {
                        throw new StepRefusedException(Error("AGENT_STOPPED", AgentStoppedMessage));
                    }
                });
                var (steps, failure, _) = await RunStepsAsync(connection, [step], null, job, CleanupBudget(RecycleErrorLogAction));
                return new ActionExecuteResult(steps, messages.Collected(), watch.ElapsedMilliseconds, failure);
            },
            error => new ActionExecuteResult([], [], watch.ElapsedMilliseconds, error));
    }

    internal const string RecycleManagedInstanceMessage = "Azure SQL Managed Instance manages SQL Server Agent's error log itself: Recycle is not offered there.";

    // --- agent.errorLogs -----------------------------------------------------------------------------------------------------

    public Task<AgentErrorLogsResult> ErrorLogsAsync(AgentErrorLogsArgs args, CancellationToken token)
    {
        Ids(args.ConnectionId, args.RequestId);
        var watch = Stopwatch.StartNew();
        var engine = host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine;
        if (engine is not ("box" or "managedInstance")) return Task.FromResult(new AgentErrorLogsResult([], false, 0, Error("NOT_SUPPORTED", EngineMessage(engine))));
        return RunAsync(args.ConnectionId, args.RequestId, null, read: true, Options.DescribeBudget, token,
            async (connection, profile, band, job) => await ReadErrorLogsAsync(new AgentReader(), connection, job) with { ElapsedMs = watch.ElapsedMilliseconds },
            error => new AgentErrorLogsResult([], false, watch.ElapsedMilliseconds, error), "Listing the error logs");
    }

    /// <summary>The logs in archive order, Current (0) first. No list at all (SQL Server on Linux) is Current alone with Archives false.</summary>
    internal async Task<AgentErrorLogsResult> ReadErrorLogsAsync(AgentReader reader, Microsoft.Data.SqlClient.SqlConnection? connection, CancellationToken token)
    {
        var (results, errors) = await reader.ReadAsync(connection, null, [AgentSql.ErrorLogs], (_, _) => null, token);
        if (errors is [{ Code: "NOT_SUPPORTED" }]) return new([new(0)], false, 0);
        if (!results.TryGetValue(AgentSql.ErrorLogs.Id, out var logs)) return new([], false, 0, HistoryReadError(errors[0]));
        var listed = logs.Rows.Select(row => new AgentErrorLogDto(Convert.ToInt32(logs.Value(row, "Archive #"), CultureInfo.InvariantCulture),
                logs.Value(row, "Date") is DateTime date ? date.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture) : null,
                logs.Value(row, "Log File Size (Byte)") is { } size and not DBNull ? Convert.ToInt64(size, CultureInfo.InvariantCulture) : null))
            .Where(log => log.Archive is >= 0 and <= AgentErrorLogArgs.MaxArchive).OrderBy(log => log.Archive).ToList();
        if (!listed.Any(log => log.Archive == 0)) listed.Insert(0, new(0));
        return new(listed, true, 0);
    }
}
