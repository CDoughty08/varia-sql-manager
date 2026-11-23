using System.Data;
using System.Diagnostics;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>SQL Server Agent's verbs from Object Explorer (AG-2). A job's Start Job at Step, Stop Job, Disable, Enable, Rename and Delete each
/// run one msdb write (AgentSql.Writes) that resolves the job by its name and the job_id the tree listed, so a job that took the name
/// since is refused (50010, NOT_FOUND). msdb's 22022 (SQL Server Agent refused a start or stop) is decided by reading Agent's state and the
/// job's again: AGENT_STOPPED, JOB_STATE or SQL_ERROR. The Agent node's Start, Stop and Restart drive its service through the Service Control
/// Manager (<see cref="AgentServiceControl"/>), offered only with Varia on Windows and a Windows server that is not Managed Instance or a
/// failover cluster instance; elsewhere the preflight refuses NOT_SUPPORTED before anything opens.</summary>
internal sealed partial class ActionService
{
    internal static readonly IReadOnlySet<string> AgentServiceActions = new HashSet<string>(["startAgent", "stopAgent", "restartAgent"], StringComparer.Ordinal);
    private static readonly IReadOnlySet<string> JobVerbs = new HashSet<string>(["startJob", "stopJob", "disable", "enable", "rename", "delete"], StringComparer.Ordinal);
    /// <summary>Job Activity Monitor's bulk Change owner (AG-3b): no catalogue action and no tree verb, one job per request.</summary>
    internal const string ChangeJobOwnerAction = "changeJobOwner";

    internal const string NeedsWindowsMessage = "Starting and stopping SQL Server Agent needs Varia on Windows.";
    internal const string LinuxServiceMessage = "On Linux, use systemctl on the server.";
    internal const string ManagedInstanceServiceMessage = "Azure SQL Managed Instance runs SQL Server Agent itself.";
    internal const string ClusteredServiceMessage = "Use Failover Cluster Manager for a clustered instance.";
    internal const string AgentStoppedMessage = "SQL Server Agent is not running. Start it, then try again.";
    internal const string JobRunningMessage = "The job is already running.";
    internal const string JobIdleMessage = "The job is not running.";
    internal const string HostUnreadableMessage = "SQL Server did not say which machine and instance it runs as, so Varia cannot find its SQL Server Agent service.";

    /// <summary>Re-validates a job's verbs and the Agent service's (zod: startJobSchema, stopJobSchema, the job branches of rename, delete
    /// and loginState, agentServiceRequestSchema). Null when the request is neither, after refusing an Agent member on it.</summary>
    private ObjectRefDto? ValidateAgent(ActionArgs args, bool script)
    {
        var service = AgentServiceActions.Contains(args.Action);
        var job = args.Target?.Kind == "agentJob" || args.Action is "startJob" or "stopJob" or ChangeJobOwnerAction;
        if (!service && !job)
        {
            if (args.AgentIdentity is not null || args.StepName is not null || args.DeleteUnusedSchedule is not null) throw Invalid("only a job's verbs take agentIdentity, stepName and deleteUnusedSchedule.");
            if (args.JobOwner is not null) throw Invalid("only changeJobOwner takes jobOwner.");
            return null;
        }
        var bare = new ActionArgs(args.Action, args.ConnectionId, args.RequestId, args.Target!);
        // zod: bulk.ts changeJobOwnerRequestSchema. Rename is the job row's verb its target must offer; it has no script.
        if (args.Action == ChangeJobOwnerAction)
        {
            if (script) throw Invalid(args.Action + " has no script.");
            if (args.Target?.Kind != "agentJob") throw Invalid("target.");
            var owned = Target(args.Target, "rename");
            if (args.AgentIdentity is not { } ownerIdentity || !AgentJobId(ownerIdentity.JobId)) throw Invalid("agentIdentity.");
            if (!ExplorerRefs.Ident(args.JobOwner)) throw Invalid("jobOwner.");
            if (args with { AgentIdentity = null, JobOwner = null } != bare) throw Invalid(args.Action + " takes only the job, its identity and jobOwner.");
            return owned;
        }
        if (args.JobOwner is not null) throw Invalid("only changeJobOwner takes jobOwner.");
        if (service)
        {
            if (script) throw Invalid(args.Action + " has no script.");
            if (args != bare) throw Invalid(args.Action + " takes only the Agent node.");
            if (args.Target is not { Kind: "agent", Name: null, Database: null, Schema: null, Parent: null, SsisFolder: null, SsisProject: null }) throw Invalid("target.");
            return Target(args.Target, args.Action);
        }
        if (args.Target?.Kind != "agentJob" || !JobVerbs.Contains(args.Action)) throw Invalid("target.");
        var target = Target(args.Target, args.Action);
        if (args.AgentIdentity is { } identity ? !AgentJobId(identity.JobId) : !script) throw Invalid("agentIdentity.");
        if (args.StepName is not null && (args.Action != "startJob" || !ExplorerRefs.Ident(args.StepName))) throw Invalid("stepName.");
        if (args.DeleteUnusedSchedule is not null && args.Action != "delete") throw Invalid("deleteUnusedSchedule.");
        // Each verb's own members; nothing else.
        var rest = args with { AgentIdentity = null, StepName = null, DeleteUnusedSchedule = null, NewName = null, CloseConnections = null, DeleteHistory = null };
        if (rest != bare) throw Invalid(args.Action + " on a job takes no such member.");
        switch (args.Action)
        {
            case "rename":
                if (!ExplorerRefs.Ident(args.NewName)) throw Invalid("newName.");
                if (string.Equals(args.NewName, target.Name, StringComparison.Ordinal)) throw Invalid("the new name is the current name.");
                if (args.CloseConnections is not null || args.DeleteHistory is not null) throw Invalid("rename takes no delete options.");
                break;
            case "delete":
                if (args.NewName is not null || args.CloseConnections is not false || args.DeleteHistory is null) throw Invalid("a job's delete takes deleteHistory, and closeConnections false.");
                break;
            default:
                if (args.NewName is not null || args.CloseConnections is not null || args.DeleteHistory is not null) throw Invalid(args.Action + " takes only the job.");
                break;
        }
        return target;
    }

    private static int FirstNumber(SqlException error) => (error.Errors.Cast<SqlError>().FirstOrDefault(item => item.Class > 10) ?? (error.Errors.Count > 0 ? error.Errors[0] : null))?.Number ?? error.Number;

    // --- Describe ---------------------------------------------------------------------------------------------------------

    private sealed record JobRow(Guid Id, string Name, string Created, bool Enabled, string? Owner);

    /// <summary>An agentIdentity's job_id: a uniqueidentifier in its 36-character "D" form.</summary>
    internal static bool AgentJobId(string? text) => text is { Length: 36 } && Guid.TryParseExact(text, "D", out _);

    private static async Task<JobRow?> ReadJobAsync(SqlConnection connection, string name, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = AgentSql.JobByName;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, name);
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token)) return null;
        return new(reader.GetGuid(0), reader.GetString(1), reader.GetString(2).Trim(), Convert.ToInt32(reader.GetValue(3), CultureInfo.InvariantCulture) != 0, reader.IsDBNull(4) ? null : reader.GetString(4));
    }

    private ActionError JobGone(ObjectRefDto target) => Error("NOT_FOUND", "The job " + Display(target) + " no longer exists. Refresh Object Explorer.");

    /// <summary>Delete Object's row for a job: its name, owner and the job_id the Delete request names.</summary>
    private async Task<ActionDescribeResult> DescribeAgentJobDeleteAsync(SqlConnection connection, ObjectRefDto target, CancellationToken token)
    {
        var job = await ReadJobAsync(connection, target.Name!, token);
        if (job is null) return new(null, 0, JobGone(target));
        return new(new DeleteTargetDto(job.Name, "Job", job.Owner, [], false, AgentIdentity: new(job.Id.ToString("D"))), 0);
    }

    /// <summary>Start Job at Step's facts: the job, whether it runs now (sp_help_job's current_execution_status, 4 idle), and its steps.</summary>
    private async Task<ActionDescribeResult> DescribeStartJobAsync(SqlConnection connection, ObjectRefDto target, CancellationToken token)
    {
        var job = await ReadJobAsync(connection, target.Name!, token);
        if (job is null) return new(null, 0, JobGone(target));
        var (results, errors) = await new AgentReader().ReadAsync(connection, null, [AgentSql.Job, AgentSql.JobSteps], (_, _) => job.Id, token);
        if (errors.FirstOrDefault() is { } failed)
            return new(null, 0, Error(failed.Code switch { "AGENT_DISABLED" => "AGENT_STOPPED", "PERMISSION_DENIED" or "NOT_FOUND" or "NOT_SUPPORTED" or "TIMEOUT" => failed.Code, _ => "SQL_ERROR" }, failed.Message));
        var status = results["job"].Rows.Select(row => results["job"].Value(row, "current_execution_status")).FirstOrDefault();
        var running = status is not null && Convert.ToInt32(status, CultureInfo.InvariantCulture) != 4;
        var steps = results["jobSteps"];
        var list = steps.Rows.Select(row => new AgentJobStepDto(Convert.ToInt32(steps.Value(row, "step_id"), CultureInfo.InvariantCulture), Convert.ToString(steps.Value(row, "step_name"), CultureInfo.InvariantCulture) ?? "")).ToList();
        return new(null, 0, AgentJob: new(job.Name, new(job.Id.ToString("D")), job.Enabled, running, list, steps.Truncated));
    }

    // --- Script ------------------------------------------------------------------------------------------------------------

    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    /// <summary>A job verb's script, as SSMS writes it: the msdb procedure by the job's name (Script runs nothing, so it needs no identity).</summary>
    internal static string AgentJobScript(ActionArgs args, ObjectRefDto target)
    {
        var name = "@job_name=" + Literal(target.Name!);
        return "USE [msdb]\nGO\n" + args.Action switch
        {
            "startJob" => "EXEC msdb.dbo.sp_start_job " + name + (args.StepName is { } step ? ", @step_name=" + Literal(step) : ""),
            "stopJob" => "EXEC msdb.dbo.sp_stop_job " + name,
            "disable" => "EXEC msdb.dbo.sp_update_job " + name + ", @enabled=0",
            "enable" => "EXEC msdb.dbo.sp_update_job " + name + ", @enabled=1",
            "rename" => "EXEC msdb.dbo.sp_update_job " + name + ", @new_name=" + Literal(args.NewName!),
            "delete" => "EXEC msdb.dbo.sp_delete_job " + name + ", @delete_history=" + (args.DeleteHistory == true ? 1 : 0) + ", @delete_unused_schedule=" + (args.DeleteUnusedSchedule == false ? 0 : 1),
            _ => throw new InvalidOperationException("Not a job verb.")
        } + "\nGO\n";
    }

    private Task<ActionScriptResult> ScriptAgentJob(ActionArgs args, ObjectRefDto target)
    {
        var engine = host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine;
        if (!Serves(args.Action, engine)) return Task.FromResult(new ActionScriptResult(null, "msdb", [], Error("NOT_SUPPORTED", EngineMessage(engine))));
        return Task.FromResult(new ActionScriptResult(AgentJobScript(args, target), "msdb", []));
    }

    // --- Execute -----------------------------------------------------------------------------------------------------------

    /// <summary>The write a job verb runs, its step title and the values of its own parameters.</summary>
    internal static (AgentWrite Write, string Title, object?[] Values) AgentJobPlan(ActionArgs args) => args.Action switch
    {
        "startJob" when args.StepName is { } step => (AgentSql.StartJobAtStep, "Start the job", [step]),
        "startJob" => (AgentSql.StartJob, "Start the job", []),
        "stopJob" => (AgentSql.StopJob, "Stop the job", []),
        "disable" => (AgentSql.SetEnabled, "Disable the job", [(byte)0]),
        "enable" => (AgentSql.SetEnabled, "Enable the job", [(byte)1]),
        "rename" => (AgentSql.RenameJob, "Rename the job", [args.NewName]),
        "delete" => (AgentSql.DeleteJob, "Delete the job", [args.DeleteHistory == true, args.DeleteUnusedSchedule != false]),
        ChangeJobOwnerAction => (AgentSql.ChangeOwner, "Change the job's owner", [args.JobOwner]),
        _ => throw new InvalidOperationException("Not a job verb.")
    };

    /// <summary>Change owner's run (AG-3b): AG-2's job write on the execute gate, refused on an engine without Agent before anything opens. It is
    /// no catalogue action, so the runner is given none (as Send test e-mail).</summary>
    private Task<ActionExecuteResult> ExecuteChangeJobOwnerAsync(ActionArgs args, ObjectRefDto target, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var engine = host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine;
        if (!Serves("startJob", engine)) return Task.FromResult(new ActionExecuteResult([], [], 0, Error("NOT_SUPPORTED", EngineMessage(engine))));
        return RunAsync(args.ConnectionId, args.RequestId, null, read: false, null, token,
            async (connection, profile, band, job) => await ExecuteAgentJobAsync(connection, args, target, job) with { ElapsedMs = watch.ElapsedMilliseconds },
            error => new ActionExecuteResult([], [], watch.ElapsedMilliseconds, error));
    }

    private async Task<ActionExecuteResult> ExecuteAgentJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, CancellationToken token)
    {
        var (write, title, values) = AgentJobPlan(args);
        var step = new RunStep(title, async context =>
        {
            try
            {
                await using var command = connection.CreateCommand();
                command.CommandText = write.Text;
                command.CommandTimeout = 0;
                Add(command, "@name", SqlDbType.NVarChar, 128, target.Name!);
                Add(command, "@expected_job_id", SqlDbType.UniqueIdentifier, 0, Guid.ParseExact(args.AgentIdentity!.JobId, "D"));
                for (var i = 0; i < write.Parameters.Count; i++) Add(command, write.Parameters[i].Name, write.Parameters[i].Type, write.Parameters[i].Size, values[i]);
                await ReadAllAsync(command, context.Token);
            }
            catch (SqlException error) when (!context.Token.IsCancellationRequested && FirstNumber(error) == 22022)
            {
                throw new StepRefusedException(await AgentRefusalAsync(connection, args.Action, target, error, context.Token));
            }
            catch (SqlException error) when (!context.Token.IsCancellationRequested && FirstNumber(error) == 15281)
            {
                throw new StepRefusedException(Error("AGENT_STOPPED", AgentStoppedMessage));
            }
        }, Detail: target.Name);
        var (steps, failure, _) = await RunStepsAsync(connection, [step], null, token, CleanupBudget(args.Action));
        return new(steps, [], 0, failure);
    }

    /// <summary>msdb's 22022 decided by a re-read (AG-0: its number says only that Agent refused): Agent XPs off is AGENT_STOPPED; a Start of
    /// a running job or a Stop of an idle one is JOB_STATE; anything else keeps SQL Server's text as SQL_ERROR.</summary>
    internal async Task<ActionError> AgentRefusalAsync(SqlConnection connection, string action, ObjectRefDto target, SqlException error, CancellationToken token)
    {
        var fallback = ActionErrors.FromSql(catalog, error, connection, ddl: true, null) with { Code = "SQL_ERROR", Retryable = catalog.Retryable("SQL_ERROR") };
        try
        {
            var reader = new AgentReader();
            var (state, _) = await reader.ReadAsync(connection, null, [AgentSql.State], (_, _) => null, token);
            if (state.TryGetValue("state", out var agent) && agent.Rows.Count > 0 && Convert.ToInt32(agent.Value(agent.Rows[0], "agent_xps"), CultureInfo.InvariantCulture) == 0)
                return Error("AGENT_STOPPED", AgentStoppedMessage);
            if (action is not ("startJob" or "stopJob") || await ReadJobAsync(connection, target.Name!, token) is not { } job) return fallback;
            var (results, _) = await reader.ReadAsync(connection, null, [AgentSql.Job], (_, _) => job.Id, token);
            if (!results.TryGetValue("job", out var row) || row.Rows.Count == 0 || row.Value(row.Rows[0], "current_execution_status") is not { } status) return fallback;
            var idle = Convert.ToInt32(status, CultureInfo.InvariantCulture) == 4;
            return action == "startJob" && !idle ? Error("JOB_STATE", JobRunningMessage) : action == "stopJob" && idle ? Error("JOB_STATE", JobIdleMessage) : fallback;
        }
        catch (SqlException) when (!token.IsCancellationRequested) { return fallback; }
    }

    // --- Service control ---------------------------------------------------------------------------------------------------

    /// <summary>The Service Control Manager client: the options' (the offline checks' fake), else Windows' own on Windows, else none.</summary>
    private IServiceControl? ServiceClient => Options.ServiceControl ?? (OperatingSystem.IsWindows() ? new WindowsServiceControl() : null);
    private bool WindowsClient => Options.WindowsClient ?? OperatingSystem.IsWindows();

    /// <summary>Why the service verbs cannot run for this connection before anything opens, or null: Varia not on Windows, a Linux server,
    /// Managed Instance (or any engine the catalogue does not serve them on).</summary>
    internal ActionError? ServicePreflight(string connectionId, string action)
    {
        if (!WindowsClient || ServiceClient is null) return Error("NOT_SUPPORTED", NeedsWindowsMessage);
        var profile = host.Profile(connectionId);
        if (profile.Linux) return Error("NOT_SUPPORTED", LinuxServiceMessage);
        var engine = profile.Explorer(explorer).ServerEngine;
        if (engine == "managedInstance") return Error("NOT_SUPPORTED", ManagedInstanceServiceMessage);
        if (!Serves(action, engine)) return Error("NOT_SUPPORTED", EngineMessage(engine));
        return null;
    }

    internal sealed record ServiceHostFacts(string Machine, string Service);

    /// <summary>The machine and service from the server, checked against strict patterns; a clustered instance or names that do not pass
    /// are refused as values.</summary>
    private async Task<(ServiceHostFacts? Facts, ActionError? Error)> ReadServiceHostAsync(SqlConnection connection, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = AgentSql.ServiceHost;
        command.CommandTimeout = 0;
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token)) return (null, Error("SQL_ERROR", HostUnreadableMessage));
        var machine = reader.IsDBNull(0) ? null : reader.GetString(0);
        var instance = reader.IsDBNull(1) ? null : reader.GetString(1);
        var clustered = !reader.IsDBNull(2) && reader.GetInt32(2) == 1;
        if (clustered) return (null, Error("NOT_SUPPORTED", ClusteredServiceMessage));
        var service = AgentServiceControl.ServiceName(instance);
        if (!AgentServiceControl.ValidMachine(machine) || service is null) return (null, Error("SQL_ERROR", HostUnreadableMessage));
        return (new(machine!, service), null);
    }

    private ActionError ServiceError(ServiceControlException error, ServiceHostFacts facts)
    {
        var (code, message) = AgentServiceControl.Describe(error, facts.Machine, facts.Service);
        return Error(code, message);
    }

    /// <summary>The service dialogs' describe: where the service is and its state. A state the login may not read is `unreadable` (the run says
    /// why); an unreachable machine or a missing service is the describe's error.</summary>
    private Task<ActionDescribeResult> DescribeAgentServiceAsync(ActionDescribeArgs args, CancellationToken token)
    {
        if (ServicePreflight(args.ConnectionId, args.Dialog!) is { } refused) return Task.FromResult(new ActionDescribeResult(null, 0, refused));
        var watch = Stopwatch.StartNew();
        return RunAsync(args.ConnectionId, args.RequestId, args.Dialog, read: true, Options.DescribeBudget, token,
            async (connection, profile, band, job) =>
            {
                var (facts, error) = await ReadServiceHostAsync(connection, job);
                if (facts is null) return new ActionDescribeResult(null, watch.ElapsedMilliseconds, error);
                var control = new AgentServiceControl(ServiceClient!);
                try
                {
                    var state = await control.QueryAsync(facts.Machine, facts.Service, job);
                    return new ActionDescribeResult(null, watch.ElapsedMilliseconds, AgentService: new(facts.Machine, facts.Service, AgentServiceControl.StateName(state)));
                }
                catch (ServiceControlException failure) when (failure.Failure is ServiceFailure.Denied or ServiceFailure.Other)
                {
                    return new ActionDescribeResult(null, watch.ElapsedMilliseconds, AgentService: new(facts.Machine, facts.Service, "unreadable"));
                }
                catch (ServiceControlException failure) { return new ActionDescribeResult(null, watch.ElapsedMilliseconds, ServiceError(failure, facts)); }
                catch (ServiceTimeoutException) { return new ActionDescribeResult(null, watch.ElapsedMilliseconds, AgentService: new(facts.Machine, facts.Service, "unreadable")); }
            },
            error => new ActionDescribeResult(null, watch.ElapsedMilliseconds, error));
    }

    /// <summary>The service's steps: Start (start, wait for Running), Stop (stop, wait for Stopped), Restart (both). Each SCM failure is the
    /// step's (StepRefusedException); a wait past serviceWaitMs is TIMEOUT. The reply carries the state read after the last step.</summary>
    private Task<ActionExecuteResult> ExecuteAgentServiceAsync(ActionArgs args, CancellationToken token)
    {
        if (ServicePreflight(args.ConnectionId, args.Action) is { } refused) return Task.FromResult(new ActionExecuteResult([], [], 0, refused));
        var watch = Stopwatch.StartNew();
        return RunAsync(args.ConnectionId, args.RequestId, args.Action, read: false, null, token,
            async (connection, profile, band, job) =>
            {
                var (facts, error) = await ReadServiceHostAsync(connection, job);
                if (facts is null) return new ActionExecuteResult([], [], watch.ElapsedMilliseconds, error);
                return await RunAgentServiceAsync(connection, args.Action, facts, ServiceClient!, job) with { ElapsedMs = watch.ElapsedMilliseconds };
            },
            error => new ActionExecuteResult([], [], watch.ElapsedMilliseconds, error));
    }

    /// <summary>The steps of a start, stop or restart on <paramref name="facts"/>' service through <paramref name="client"/>, and the state read
    /// after them. The connection only carries the runner (nothing runs on it), so the offline checks drive every failure with a fake client.</summary>
    internal async Task<ActionExecuteResult> RunAgentServiceAsync(SqlConnection connection, string action, ServiceHostFacts facts, IServiceControl client, CancellationToken token)
    {
        var control = new AgentServiceControl(client);
        Func<StepContext, Task> Guard(Func<CancellationToken, Task> work) => async context =>
        {
            try { await work(context.Token); }
            catch (ServiceControlException failure) { throw new StepRefusedException(ServiceError(failure, facts)); }
            catch (ServiceTimeoutException failure) { throw new StepRefusedException(Error("TIMEOUT", failure.Message)); }
            catch (ServiceStoppedException failure) { throw new StepRefusedException(Error("SQL_ERROR", failure.Message)); }
            catch (ServiceStillStoppingException failure) { throw new StepRefusedException(Error("BLOCKED", failure.Message)); }
        };
        RunStep Stop() => new(StopServiceStep, Guard(t => control.StopAsync(facts.Machine, facts.Service, t)), Detail: facts.Service);
        RunStep Stopped() => new(StoppedServiceStep, Guard(t => control.WaitAsync(facts.Machine, facts.Service, AgentServiceStatus.Stopped, t)), Detail: facts.Service);
        RunStep Start() => new(StartServiceStep, Guard(t => control.StartAsync(facts.Machine, facts.Service, t)), Detail: facts.Service);
        RunStep Running() => new(RunningServiceStep, Guard(t => control.WaitAsync(facts.Machine, facts.Service, AgentServiceStatus.Running, t, started: true)), Detail: facts.Service);
        List<RunStep> plan = action switch
        {
            "startAgent" => [Start(), Running()],
            "stopAgent" => [Stop(), Stopped()],
            _ => [Stop(), Stopped(), Start(), Running()]
        };
        var (steps, failure, _) = await RunStepsAsync(connection, plan, null, token, CleanupBudget(action));
        string state;
        try
        {
            using var read = new CancellationTokenSource(TimeSpan.FromMilliseconds(AgentCatalog.Current.Limit("serviceReadMs")));
            state = AgentServiceControl.StateName(await control.QueryAsync(facts.Machine, facts.Service, read.Token));
        }
        catch (Exception exception) when (exception is ServiceControlException or ServiceTimeoutException or OperationCanceledException) { state = "unreadable"; }
        return new ActionExecuteResult(steps, [], 0, failure, AgentService: state);
    }

    internal const string StopServiceStep = "Stop SQL Server Agent";
    internal const string StoppedServiceStep = "Wait for it to stop";
    internal const string StartServiceStep = "Start SQL Server Agent";
    internal const string RunningServiceStep = "Wait for it to run";
}
