using Microsoft.Data.SqlClient;
using Varia.Backend;
using Varia.Backend.Actions;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

/// <summary>SQL Server Agent's verbs from Object Explorer (AG-2), offline: the msdb write lint and its near misses, the job verbs' validation,
/// plans and scripts, the service names and Windows error mapping, the service preflight's refusals before any connection opens, and every
/// Service Control Manager failure through a fake client.</summary>
internal static class AgentActionChecks
{
    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);
    private static readonly ObjectRefDto Job = new("agentJob", Name: "Nightly ETL");
    private static readonly ObjectRefDto AgentNode = new("agent");
    private const string JobId = "00000000-1111-2222-3333-444444444441";

    private sealed class Host(ServerProfile profile) : IActionHost
    {
        public int Connections;
        public ServerProfile Profile(string connectionId) => profile;
        public SqlConnection Connection(string connectionId)
        {
            Interlocked.Increment(ref Connections);
            return new SqlConnection("Data Source=" + Unreachable.Source + ";Connect Timeout=1;Pooling=false;Encrypt=false");
        }
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => connection.OpenAsync(token);
        public bool ClearPoolsFor(string connectionId, string database) => true;
        public bool FreeDatabase(string connectionId, string database) => true;
        public IReadOnlySet<int> PoolSessions(string connectionId) => new HashSet<int>();
        public IReadOnlyList<string> SameServer(string connectionId) => [connectionId];
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
    }

    /// <summary>A Service Control Manager that answers from a script: the state each Query returns in turn (the last repeats), and the
    /// failure each call kind throws.</summary>
    private sealed class FakeControl : IServiceControl
    {
        public Queue<AgentServiceStatus> States { get; } = new();
        public AgentServiceStatus Last { get; set; } = AgentServiceStatus.Running;
        public ServiceControlException? OnStart, OnStop, OnQuery;
        public List<string> Calls { get; } = [];
        /// <summary>Set by the first Query, so a check can act while a wait polls, without a fixed sleep.</summary>
        public TaskCompletionSource Queried { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public AgentServiceStatus Query(string machine, string service)
        {
            Calls.Add("query " + machine + " " + service);
            Queried.TrySetResult();
            if (OnQuery is not null) throw OnQuery;
            if (States.TryDequeue(out var state)) Last = state;
            return Last;
        }
        public void Start(string machine, string service) { Calls.Add("start"); if (OnStart is not null) throw OnStart; }
        public void Stop(string machine, string service) { Calls.Add("stop"); if (OnStop is not null) throw OnStop; }
    }

    private static ActionArgs Args(string action, ObjectRefDto target) => new(action, Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target);
    private static ActionArgs JobArgs(string action) => Args(action, Job) with { AgentIdentity = new(JobId) };

    public static async Task RunAsync(Action<bool, string> check)
    {
        Lint(check);
        Validation(check);
        ChangeOwner(check);
        PlansAndScripts(check);
        Names(check);
        await PreflightAsync(check);
        await ServiceAsync(check);
    }

    private static void Lint(Action<bool, string> check)
    {
        var failures = AgentSql.LintWrites().Where(item => item.Problems.Count > 0).Select(item => item.Name + ": " + string.Join(", ", item.Problems)).ToList();
        check(failures.Count == 0 && AgentSql.Writes.Count == 7, "every Agent write passes its lint, as do the job verbs' own reads" + (failures.Count == 0 ? "" : ": " + string.Join("; ", failures)));
        check(ActionSql.Lint().Count(item => item.Name.StartsWith("agent ", StringComparison.Ordinal)) == AgentSql.Writes.Count + 2 + AgentSql.LintJobSaves().Count() + AgentSql.LintServerWrites().Count() + AgentSql.LintHistoryWrites().Count() + AgentSql.LintObjectWrites().Count() + AgentSql.LintScheduleSaves().Count() + AgentSql.LintProxySaves().Count(), "the object actions' lint runs the Agent writes too, SQL Server Agent Properties', the job document's saves and Delete History's, the alert and operator batches, the Schedules document's and the proxy document's included");
        var start = AgentSql.StartJob.Text;
        string Call(string call) => AgentSql.Resolve + call + AgentSql.Check;
        var misses = new (string Text, string Problem)[]
        {
            (start.Replace("msdb.dbo.sp_start_job", "master.dbo.xp_servicecontrol N'Start', N'SQLServerAgent'", StringComparison.Ordinal), "uses xp_servicecontrol"),
            (Call("EXEC @rc = msdb.dbo.sp_add_job @job_id = @job_id;"), "EXECs sp_add_job, which only a job save calls"),
            (Call("EXEC @rc = msdb.dbo.sp_purge_jobhistory @job_id = @job_id;"), "passes @job_id to sp_purge_jobhistory"),
            (Call("EXEC @rc = msdb.dbo.sp_stop_job @job_id = @job_id, @step_name = @step_name;"), "passes @step_name to sp_stop_job"),
            (Call("EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @enabled = @new_name;"), "passes @enabled another parameter's value"),
            (Call("EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @enabled = @enabled, @enabled = @enabled;"), "passes @enabled twice"),
            (Call("EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @enabled = 1;"), "is not one msdb call in the write shape"),
            (Call("EXEC @rc = msdb.dbo.sp_stop_job @job_id = @job_id; DROP TABLE dbo.t;"), "is not one msdb call in the write shape"),
            (start.Replace("THROW 50010", "PRINT 50010", StringComparison.Ordinal), "does not resolve the job by its identity first"),
            (start[..^AgentSql.Check.Length] + ";", "does not check the return code last")
        };
        foreach (var (text, problem) in misses) check(AgentSql.LintExecutable(text).Contains(problem), "the Agent write lint refuses a write that " + problem);
        check(AgentSql.Resolve.Contains("j.name = @name AND j.job_id = @expected_job_id", StringComparison.Ordinal) && AgentSql.Resolve.Contains("THROW 50010", StringComparison.Ordinal)
            && AgentSql.Check.Contains("IF @@ERROR <> 0 OR @rc <> 0 THROW 50012", StringComparison.Ordinal),
            "a write resolves the job by name and immutable job ID (50010 otherwise) and THROWs on msdb's return code, which RAISERROR leaves without @@ERROR");
    }

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new Host(Box2022));
        string Answer(ActionArgs args, bool script = false)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var valid = new (string Name, ActionArgs Args)[]
        {
            ("start", JobArgs("startJob")), ("start at a step", JobArgs("startJob") with { StepName = "Load" }), ("stop", JobArgs("stopJob")), ("disable", JobArgs("disable")), ("enable", JobArgs("enable")),
            ("rename", JobArgs("rename") with { NewName = "Nightly ETL 2" }), ("delete", JobArgs("delete") with { CloseConnections = false, DeleteHistory = true, DeleteUnusedSchedule = true }),
            ("start the service", Args("startAgent", AgentNode)), ("stop the service", Args("stopAgent", AgentNode)), ("restart the service", Args("restartAgent", AgentNode))
        };
        foreach (var (name, args) in valid) check(Answer(args) == "accepted", "a job's or the service's verb validates: " + name);
        var invalid = new (string Name, ActionArgs Args, bool Script)[]
        {
            ("start without the identity", JobArgs("startJob") with { AgentIdentity = null }, false), ("a timestamp instead of a job ID", JobArgs("stopJob") with { AgentIdentity = new("2026-11-02T21:07:12.123") }, false),
            ("a malformed job ID", JobArgs("stopJob") with { AgentIdentity = new(JobId + " ") }, false), ("a step on stop", JobArgs("stopJob") with { StepName = "Load" }, false),
            ("a step name with U+0000", JobArgs("startJob") with { StepName = "a\0b" }, false), ("schedules on a disable", JobArgs("disable") with { DeleteUnusedSchedule = true }, false),
            ("a rename to the same name", JobArgs("rename") with { NewName = "Nightly ETL" }, false), ("a job's delete closing connections", JobArgs("delete") with { CloseConnections = true, DeleteHistory = true }, false),
            ("a job's stop with a new name", JobArgs("stopJob") with { NewName = "x" }, false), ("a job's enable with a login identity", JobArgs("enable") with { LoginIdentity = new("01", "2026-11-02T21:07:12.000") }, false),
            ("an identity on a table", Args("rename", new ObjectRefDto("table", "AppData", "dbo", "Orders")) with { NewName = "x", AgentIdentity = new(JobId) }, false),
            ("start on a table", Args("startJob", new ObjectRefDto("table", "AppData", "dbo", "Orders")) with { AgentIdentity = new(JobId) }, false),
            ("properties of a job", JobArgs("properties"), false), ("the service on a job", Args("startAgent", Job), false),
            ("the service with a member", Args("stopAgent", AgentNode) with { NewName = "x" }, false), ("the service's script", Args("restartAgent", AgentNode), true),
            ("the service named", Args("startAgent", new ObjectRefDto("agent", Name: "x")), false)
        };
        foreach (var (name, args, script) in invalid) check(Answer(args, script) == "INVALID_PARAMS", "a job's or the service's verb is refused: " + name);
        check(Answer(JobArgs("delete") with { AgentIdentity = null, CloseConnections = false, DeleteHistory = true }, script: true) == "accepted", "a job's Script runs nothing, so it needs no identity");
    }

    /// <summary>Job Activity Monitor's bulk Change owner (AG-3b): one job per request through AG-2's guarded write, re-validated as zod's
    /// changeJobOwnerRequestSchema, with no script and jobOwner refused on every other request.</summary>
    private static void ChangeOwner(Action<bool, string> check)
    {
        using var service = new ActionService(new Host(Box2022));
        string Answer(ActionArgs args, bool script = false)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var owner = JobArgs(ActionService.ChangeJobOwnerAction) with { JobOwner = "CONTOSO\\agent" };
        check(Answer(owner) == "accepted" && Answer(owner with { JobOwner = new string('l', 128) }) == "accepted", "Change owner validates with the job, its identity and a login of up to 128 characters");
        var refused = new (string Name, ActionArgs Args, bool Script)[]
        {
            ("without the owner", owner with { JobOwner = null }, false), ("an empty owner", owner with { JobOwner = "" }, false), ("an owner past 128 characters", owner with { JobOwner = new string('l', 129) }, false),
            ("an owner with U+0000", owner with { JobOwner = "a\0b" }, false), ("without the identity", owner with { AgentIdentity = null }, false), ("a malformed identity", owner with { AgentIdentity = new("x") }, false),
            ("its script", owner, true), ("on an alert", Args(ActionService.ChangeJobOwnerAction, new ObjectRefDto("agentAlert", Name: "a")) with { JobOwner = "sa" }, false),
            ("on the Agent node", Args(ActionService.ChangeJobOwnerAction, AgentNode) with { JobOwner = "sa" }, false), ("with a new name", owner with { NewName = "x" }, false),
            ("with a step", owner with { StepName = "Load" }, false), ("an owner on a job's enable", JobArgs("enable") with { JobOwner = "sa" }, false),
            ("an owner on a table's rename", Args("rename", new ObjectRefDto("table", "AppData", "dbo", "Orders")) with { NewName = "x", JobOwner = "sa" }, false)
        };
        foreach (var (name, args, script) in refused) check(Answer(args, script) == "INVALID_PARAMS", "Change owner is refused: " + name);
        check(ActionService.AgentJobPlan(owner) is { Write: var write, Values: ["CONTOSO\\agent"] } && write == AgentSql.ChangeOwner
            && AgentSql.ChangeOwner.Text.EndsWith("EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @owner_login_name = @owner_login_name;" + AgentSql.Check, StringComparison.Ordinal)
            && AgentSql.ChangeOwner.Text.StartsWith(AgentSql.Resolve, StringComparison.Ordinal),
            "Change owner resolves the job by its listed identity, then passes the login as sp_update_job's @owner_login_name parameter");
    }

    private static void PlansAndScripts(Action<bool, string> check)
    {
        check(ActionService.AgentJobPlan(JobArgs("startJob")).Write == AgentSql.StartJob && ActionService.AgentJobPlan(JobArgs("startJob") with { StepName = "Load" }) is { Write: var atStep, Values: ["Load"] } && atStep == AgentSql.StartJobAtStep
            && ActionService.AgentJobPlan(JobArgs("disable")).Values is [(byte)0] && ActionService.AgentJobPlan(JobArgs("enable")).Values is [(byte)1]
            && ActionService.AgentJobPlan(JobArgs("delete") with { DeleteHistory = false, DeleteUnusedSchedule = null }).Values is [false, true],
            "each job verb runs its msdb write with its own values (Delete drops the schedules only it used unless told not to)");
        var script = ActionService.AgentJobScript(JobArgs("delete") with { DeleteHistory = true, DeleteUnusedSchedule = true }, new ObjectRefDto("agentJob", Name: "O'Neil job"));
        check(script == "USE [msdb]\nGO\nEXEC msdb.dbo.sp_delete_job @job_name=N'O''Neil job', @delete_history=1, @delete_unused_schedule=1\nGO\n"
            && ActionService.AgentJobScript(JobArgs("startJob") with { StepName = "Load" }, Job).Contains("sp_start_job @job_name=N'Nightly ETL', @step_name=N'Load'", StringComparison.Ordinal),
            "a job verb's Script writes the msdb call by the job's name, as SSMS does, quoting names");
        check(ActionErrors.Numbers["NAME_IN_USE"].Contains(14261) && ActionErrors.Numbers["NOT_FOUND"].Contains(14262) && ActionErrors.Numbers["NOT_FOUND"].Contains(50010)
            && ActionErrors.Numbers["IN_USE"].Contains(14372) && ActionErrors.Numbers["AGENT_STOPPED"].SequenceEqual([15281]) && !ActionErrors.Numbers.Values.Any(numbers => numbers.Contains(22022)),
            "msdb's errors map by number (agentErrorNumbers), and 22022 never does: a re-read decides it");
    }

    private static void Names(Action<bool, string> check)
    {
        check(AgentServiceControl.ServiceName(null) == "SQLSERVERAGENT" && AgentServiceControl.ServiceName("MSSQLSERVER") == "SQLSERVERAGENT" && AgentServiceControl.ServiceName("SQL2022") == "SQLAgent$SQL2022"
            && AgentServiceControl.ServiceName("A$B_1") == "SQLAgent$A$B_1" && AgentServiceControl.ServiceName("bad name") is null && AgentServiceControl.ServiceName("1abc") is null
            && AgentServiceControl.ServiceName(new string('a', 17)) is null && AgentServiceControl.ServiceName("x\\y") is null,
            "the Agent service is SQLSERVERAGENT for the default instance and SQLAgent$<instance> for a named one, only for a valid instance name");
        check(AgentServiceControl.ValidMachine("SQL-01") && !AgentServiceControl.ValidMachine("sql.contoso.com") && !AgentServiceControl.ValidMachine("10.0.0.1") && !AgentServiceControl.ValidMachine(new string('a', 16))
            && !AgentServiceControl.ValidMachine("-sql") && !AgentServiceControl.ValidMachine(null) && !AgentServiceControl.ValidMachine("\\\\host")
            && !AgentServiceControl.ValidMachine("SQL01\n") && AgentServiceControl.ServiceName("SALES\n") is null,
            "the machine is a NetBIOS name only: never a DNS name, an address or a UNC path, and neither name may end in a newline");
        check(AgentServiceControl.Classify(5) == ServiceFailure.Denied && new[] { 1722, 1726, 1753, 53, 67 }.All(code => AgentServiceControl.Classify(code) == ServiceFailure.Unreachable)
            && AgentServiceControl.Classify(1060) == ServiceFailure.NotFound && AgentServiceControl.Classify(1058) == ServiceFailure.Disabled && AgentServiceControl.Classify(1053) == ServiceFailure.Other,
            "Windows errors classify: 5 denied, RPC and name errors unreachable, 1060 no such service, 1058 disabled, anything else other");
        var states = Enum.GetValues<AgentServiceStatus>().Select(state => AgentServiceControl.StateName(state)).Append(AgentServiceControl.StateName(null)).ToList();
        check(states.SequenceEqual(["stopped", "startPending", "stopPending", "running", "continuePending", "pausePending", "paused", "unreadable"]), "the service states' names are agentServiceStates");
    }

    private static async Task PreflightAsync(Action<bool, string> check)
    {
        async Task<(ActionError? Error, int Connections)> Run(ServerProfile profile, bool windows, string action = "startAgent")
        {
            var host = new Host(profile);
            using var service = new ActionService(host, new ActionServiceOptions { ServiceControl = new FakeControl(), WindowsClient = windows });
            var result = await service.ExecuteAsync(Args(action, AgentNode), CancellationToken.None);
            var described = await service.DescribeAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), action, AgentNode), CancellationToken.None);
            return (result.Error?.Message == described.Error?.Message ? result.Error : null, host.Connections);
        }
        var client = await Run(Box2022, windows: false);
        check(client.Error is { Code: "NOT_SUPPORTED", Retryable: false } && client.Error.Message == ActionService.NeedsWindowsMessage && client.Connections == 0,
            "with Varia off Windows, the service verbs and their dialogs answer NOT_SUPPORTED before any connection opens");
        var linux = await Run(Box2022 with { Linux = true }, windows: true, "stopAgent");
        check(linux.Error is { Code: "NOT_SUPPORTED" } && linux.Error.Message == ActionService.LinuxServiceMessage && linux.Connections == 0, "a Linux server is told to use systemctl, before any connection opens");
        var managed = await Run(Box2022 with { EngineEdition = 8 }, windows: true, "restartAgent");
        check(managed.Error is { Code: "NOT_SUPPORTED" } && managed.Error.Message == ActionService.ManagedInstanceServiceMessage && managed.Connections == 0, "Managed Instance runs Agent itself: NOT_SUPPORTED, nothing opened");
        var cloud = await Run(Box2022 with { EngineEdition = 5 }, windows: true);
        check(cloud.Error is { Code: "NOT_SUPPORTED" } && cloud.Connections == 0, "Azure SQL Database has no Agent: NOT_SUPPORTED, nothing opened");
    }

    private static async Task ServiceAsync(Action<bool, string> check)
    {
        using var service = new ActionService(new Host(Box2022));
        var facts = new ActionService.ServiceHostFacts("SQL-01", "SQLAgent$SQL2022");
        async Task<(ActionExecuteResult Result, FakeControl Control)> Run(string action, Action<FakeControl> arrange)
        {
            var control = new FakeControl();
            arrange(control);
            await using var connection = new SqlConnection();
            return (await service.RunAgentServiceAsync(connection, action, facts, control, CancellationToken.None), control);
        }
        string Statuses(ActionExecuteResult result) => string.Join(" ", result.Steps.Select(step => step.Status));

        var started = await Run("startAgent", control => { control.States.Enqueue(AgentServiceStatus.Running); });
        check(started.Result.Error is null && Statuses(started.Result) == "done done" && started.Result.Steps[0].Title == ActionService.StartServiceStep && started.Result.Steps[0].Detail == facts.Service
            && started.Result.AgentService == "running" && started.Control.Calls.Contains("query SQL-01 SQLAgent$SQL2022"), "Start sends Start to the machine's service and waits until it runs");
        var restarted = await Run("restartAgent", control => { foreach (var state in new[] { AgentServiceStatus.StopPending, AgentServiceStatus.Stopped, AgentServiceStatus.Running }) control.States.Enqueue(state); });
        check(restarted.Result.Error is null && Statuses(restarted.Result) == "done done done done" && string.Join(",", restarted.Control.Calls.Where(call => !call.StartsWith("query", StringComparison.Ordinal))) == "stop,start",
            "Restart stops, waits for Stopped, starts and waits for Running");
        var failures = new (ServiceFailure Failure, int Code, string Error, string Text)[]
        {
            (ServiceFailure.Denied, 5, "PERMISSION_DENIED", "needs Windows administrator rights on SQL-01"), (ServiceFailure.Unreachable, 1722, "SERVICE_UNREACHABLE", "could not reach the Service Control Manager on SQL-01"),
            (ServiceFailure.NotFound, 1060, "NOT_FOUND", "There is no service SQLAgent$SQL2022 on SQL-01"), (ServiceFailure.Disabled, 1058, "NOT_SUPPORTED", "service is disabled"),
            (ServiceFailure.Other, 1053, "SQL_ERROR", "Windows error 1053")
        };
        foreach (var (failure, code, error, text) in failures)
        {
            var (result, _) = await Run("stopAgent", control => control.OnStop = new ServiceControlException(failure, code));
            check(result.Error is { } value && value.Code == error && value.Message.Contains(text, StringComparison.Ordinal) && value.Retryable == (error is "PERMISSION_DENIED" or "SQL_ERROR") && Statuses(result) == "failed skipped",
                "a Stop the Service Control Manager refuses (" + failure + ") fails its step as " + error + ", and the wait is skipped: " + Statuses(result) + " " + result.Error?.Code + " " + result.Error?.Message);
        }
        var partway = await Run("restartAgent", control => { control.States.Enqueue(AgentServiceStatus.Stopped); control.OnStart = new ServiceControlException(ServiceFailure.Denied, 5); });
        check(partway.Result.Error?.Code == "PERMISSION_DENIED" && Statuses(partway.Result) == "done done failed skipped" && partway.Result.Error.Message.Contains("Completed before the failure: Stop SQL Server Agent, Wait for it to stop", StringComparison.Ordinal)
            && partway.Result.AgentService == "stopped", "a Restart whose Start is refused says Agent was stopped, and the reply's state says it still is");
        var fell = await Run("startAgent", control => { control.States.Enqueue(AgentServiceStatus.StartPending); control.States.Enqueue(AgentServiceStatus.Stopped); });
        check(fell.Result.Error?.Code == "SQL_ERROR" && Statuses(fell.Result) == "done failed" && fell.Result.Error.Message.Contains("stopped again while it was starting", StringComparison.Ordinal) && fell.Result.AgentService == "stopped",
            "a service that stops again while starting fails the wait, pointing at its error log");
        var quick = await Run("startAgent", control => { control.States.Enqueue(AgentServiceStatus.Stopped); });
        check(quick.Result.Error?.Code == "SQL_ERROR" && Statuses(quick.Result) == "done failed" && quick.Result.Error.Message.Contains("stopped again while it was starting", StringComparison.Ordinal)
            && quick.Control.Calls.Count(call => call.StartsWith("query", StringComparison.Ordinal)) <= 2,
            "a service already stopped again at the first read after Start fails at once, not after serviceWaitMs: " + string.Join(",", quick.Control.Calls));
        var stopping = await Run("startAgent", control => { control.States.Enqueue(AgentServiceStatus.StopPending); });
        check(stopping.Result.Error?.Code == "BLOCKED" && Statuses(stopping.Result) == "done failed" && stopping.Result.Error.Message.Contains("still stopping", StringComparison.Ordinal),
            "a Start sent while the service is still stopping says so (BLOCKED), not that it stopped again while starting: " + Statuses(stopping.Result));
        var fellOver = await Run("startAgent", control => { foreach (var state in new[] { AgentServiceStatus.StartPending, AgentServiceStatus.StopPending, AgentServiceStatus.Stopped }) control.States.Enqueue(state); });
        check(fellOver.Result.Error?.Code == "SQL_ERROR" && fellOver.Result.Error.Message.Contains("stopped again while it was starting", StringComparison.Ordinal),
            "a service that took the Start and then fell over (Start Pending, Stop Pending, Stopped) says it stopped again, not that it was still stopping: " + Statuses(fellOver.Result));
        var unreadable = await Run("startAgent", control => control.OnQuery = new ServiceControlException(ServiceFailure.Denied, 5));
        check(unreadable.Result.Error?.Code == "PERMISSION_DENIED" && Statuses(unreadable.Result) == "done failed" && unreadable.Result.AgentService == "unreadable",
            "a state the login may not read fails the wait as denied, and the reply's state is unreadable");
        using var stop = new CancellationTokenSource();
        var control = new FakeControl();
        for (var i = 0; i < 1_000; i++) control.States.Enqueue(AgentServiceStatus.StartPending);
        await using var connection = new SqlConnection();
        var pending = service.RunAgentServiceAsync(connection, "startAgent", facts, control, stop.Token);
        await control.Queried.Task.WaitAsync(TimeSpan.FromSeconds(30));
        await stop.CancelAsync();
        var stopped = await pending;
        check(stopped.Error?.Code == "CANCELLED" && Statuses(stopped) == "done cancelled", "Stop during the wait ends it; the Start that was sent stays done");
    }
}
