using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend;
using Varia.Backend.Actions;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;
using Varia.Backend.Language;

namespace Varia.Backend.Tests;

/// <summary>The job document (AG-6a), offline: the save lint and its near misses, the save planner (New Job, an existing job's changed arguments,
/// alert detaches and their guards, the STALE guard's values), the request's validation, the refusal mapping (STALE, the failed call's part and
/// field) and the SSMS-shaped script.</summary>
internal static class AgentJobDocumentChecks
{
    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);
    private static readonly ObjectRefDto AgentNode = new("agent");
    private static readonly ObjectRefDto Job = new("agentJob", Name: "Nightly ']' -- load");
    private const string JobId = "00000000-1111-2222-3333-444444444441";
    private const string Modified = "2026-11-20T14:32:07.123";

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

    private static ActionArgs Save(AgentJobSaveDto save, ObjectRefDto? target = null, string? jobId = JobId) =>
        new("agentJob", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target ?? Job) { AgentJob = save, AgentIdentity = target?.Kind == "agent" || jobId is null ? null : new(jobId) };
    private static AgentJobSaveDto Changed(AgentJobSaveDto changes) => changes with { Version = 7, Modified = Modified };

    public static Task RunAsync(Action<bool, string> check)
    {
        Lint(check);
        Planner(check);
        Validation(check);
        Errors(check);
        Script(check);
        Steps(check);
        Parse(check);
        return Task.CompletedTask;
    }

    private static void Lint(Action<bool, string> check)
    {
        var results = AgentSql.LintJobSaves().ToList();
        var failures = results.Where(item => item.Problems.Count > 0).Select(item => item.Name + ": " + string.Join(", ", item.Problems)).ToList();
        check(failures.Count == 0 && results.Count == 9, "the job document's nine save shapes (AG-6b: two with steps; AG-6c: three with schedule calls; two with both) pass their lint" + (failures.Count == 0 ? "" : ": " + string.Join("; ", failures)));
        check(AgentSql.LintWrites().Count(item => item.Name.StartsWith("job save ", StringComparison.Ordinal)) == 9, "the Agent write lint (and so the object actions' lint) runs the job saves too");
        foreach (var statement in (AgentStatement[])[ AgentSql.JobDocument, AgentSql.JobDocumentSteps, AgentSql.JobCategories, AgentSql.Operators, AgentSql.Alerts, AgentSql.AgentMail, AgentSql.MailProfiles,
            AgentSql.JobDocumentFacts, AgentSql.OwnerLogins, AgentSql.JobStepDatabases, AgentSql.Subsystems, ..AgentSql.JobStepProxies])
            check(AgentSql.Known(statement) && AgentSql.Lint(statement, null).Count == 0, "the job document's read " + statement.Id + " is one the reader runs, and passes the Agent read lint");

        var existing = AgentSql.Resolve + AgentSql.StaleGuard;
        string Call(int index, string call) => call + AgentSql.CheckAt(index);
        var update = Call(1, "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @description = @description;");
        var detach = AgentSql.AlertGuard(2) + Call(2, "EXEC @rc = msdb.dbo.sp_update_alert @name = @name_2, @job_id = @no_job;");
        var add = Call(1, "EXEC @rc = msdb.dbo.sp_add_job @job_name = @job_name, @job_id = @job_id OUTPUT;") + Call(2, "EXEC @rc = msdb.dbo.sp_add_jobserver @job_id = @job_id;");
        check(AgentSql.LintJobSave(existing + update + detach).Count == 0 && AgentSql.LintJobSave(AgentSql.NewJobHead + add).Count == 0, "the lint admits an update with a detach, and New Job's add");
        var misses = new (string Text, string Problem)[]
        {
            (AgentSql.Resolve + update, "does not open with New Job's declaration or the job's identity and STALE guards"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_update_alert @name = @name_1, @job_id = @no_job;"), "detaches an alert without its guard"),
            (existing + update + AgentSql.AlertGuard(3) + Call(2, "EXEC @rc = msdb.dbo.sp_update_alert @name = @name_2, @job_id = @no_job;"), "call 2 has an alert guard that is not exactly its own"),
            (existing + update + AgentSql.AlertGuard(2) + Call(2, "EXEC @rc = msdb.dbo.sp_update_alert @name = @name_1, @job_id = @no_job;"), "passes @name another parameter's value"),
            (existing + update + AgentSql.AlertGuard(2) + Call(2, "EXEC @rc = msdb.dbo.sp_update_alert @name = @name_2, @job_id = @job_id;"), "passes @job_id another parameter's value"),
            (existing + update + AgentSql.AlertGuard(2) + Call(2, "EXEC @rc = msdb.dbo.sp_update_alert @name = @name_2, @job_id = @no_job, @enabled = @enabled;"), "passes @enabled to sp_update_alert"),
            (existing + "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @description = @description;" + AgentSql.CheckAt(2), "call 1 is not followed by its return-code check"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @enabled = @enabled, @enabled = @enabled;"), "passes @enabled twice"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @enabled = @description;"), "passes @enabled another parameter's value"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @output_file_name = @output_file_name;"), "passes @output_file_name to sp_update_job"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @enabled = 1;"), "is not one msdb call in the save shape"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @enabled = @enabled; DELETE msdb.dbo.sysjobs;"), "is not one msdb call in the save shape"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_delete_job @job_id = @job_id;"), "EXECs sp_delete_job, which a job save does not call"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_update_job @enabled = @enabled;"), "sp_update_job does not name the job"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id OUTPUT, @enabled = @enabled;"), "passes @job_id as an OUTPUT"),
            (existing + AgentSql.AlertGuard(1) + Call(1, "EXEC @rc = msdb.dbo.sp_update_alert @name = @name_1, @job_id = @no_job;") + Call(2, "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @enabled = @enabled;"), "updates the job more than once, or calls out of the save's order (job, alerts, step deletes, temporary names, inserts, step contents, Start step, schedules)"),
            (existing + add, "adds a job in an existing job's save"),
            (AgentSql.NewJobHead + Call(1, "EXEC @rc = msdb.dbo.sp_add_job @job_name = @job_name, @job_id = @job_id;") + Call(2, "EXEC @rc = msdb.dbo.sp_add_jobserver @job_id = @job_id;"),
                "does not take the new job's id as sp_add_job's OUTPUT"),
            (AgentSql.NewJobHead + Call(1, "EXEC @rc = msdb.dbo.sp_add_job @job_name = @job_name, @job_id = @job_id OUTPUT;"), "New Job's save is not sp_add_job, its steps, sp_add_jobserver, at most the Start step, then its schedules"),
            (AgentSql.NewJobHead + add + Call(3, "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @enabled = @enabled;"), "New Job's save is not sp_add_job, its steps, sp_add_jobserver, at most the Start step, then its schedules"),
            (existing + Call(1, "EXEC @rc = master.dbo.xp_servicecontrol @a = @a;"), "uses xp_servicecontrol"),
            (existing, "makes no call")
        };
        foreach (var (text, problem) in misses)
        {
            var found = AgentSql.LintJobSave(text);
            var refused = found.Any(item => item.EndsWith(problem, StringComparison.Ordinal));
            check(refused, "the job save lint refuses a save that " + problem + (refused ? "" : " (found: " + string.Join(", ", found) + ")"));
        }
        check(AgentSql.LintExecutable(AgentSql.Resolve + "EXEC @rc = msdb.dbo.sp_update_alert @job_id = @job_id;" + AgentSql.Check).Contains("EXECs sp_update_alert, which only a job save calls")
            && AgentSql.LintExecutable(AgentSql.Resolve + "EXEC @rc = msdb.dbo.sp_add_jobserver @job_id = @job_id;" + AgentSql.Check).Contains("EXECs sp_add_jobserver, which only a job save calls")
            && AgentSql.LintServerExecutable(AgentSql.ServerHead + "EXEC @rc = msdb.dbo.sp_update_alert @name = @name;" + AgentSql.Check).Contains("EXECs sp_update_alert, which only a job save calls"),
            "the one-call write lints refuse the procedures only a job save calls in its own shape (New Job's OUTPUT, a detach's guard)");
        check(ActionErrors.Numbers["STALE"].SequenceEqual([50011]) && ActionErrors.Numbers["PERMISSION_DENIED"].Contains(14525) && ActionErrors.Numbers["NOT_FOUND"].Contains(50010),
            "50011 maps to STALE, msdb's 14525 (another owner's job below sysadmin) to PERMISSION_DENIED, and the identity guard's 50010 to NOT_FOUND");
        check(AgentSql.StaleGuard.Contains("j.version_number = @version", StringComparison.Ordinal) && AgentSql.StaleGuard.Contains("j.date_modified = @modified", StringComparison.Ordinal)
            && AgentSql.StaleGuard.Contains("THROW 50011", StringComparison.Ordinal),
            "the STALE guard compares the job's version_number and date_modified with those the document read, and THROWs 50011");
    }

    private static void Planner(Action<bool, string> check)
    {
        static string Names(AgentSaveCall call) => string.Join(",", call.Arguments.Select(argument => argument.Name));
        static object? ValueOf(AgentSaveBatch batch, string name) => batch.Parameters.First(parameter => parameter.Parameter.Name == name).Value;

        var described = ActionService.AgentJobSavePlan(Save(Changed(new(Description: "Rebuilds indexes"))), Job);
        check(described.Calls is [{ Procedure: "sp_update_job" } call] && Names(call) == "@job_id,@description" && AgentSql.LintJobSave(described.Text).Count == 0
            && (string?)ValueOf(described, "@name") == Job.Name && ValueOf(described, "@expected_job_id") is Guid expected && expected == Guid.Parse(JobId) && (int?)ValueOf(described, "@version") == 7
            && ValueOf(described, "@modified") is DateTime modified && modified == new DateTime(2026, 11, 20, 14, 32, 7, 123) && (string?)ValueOf(described, "@description") == "Rebuilds indexes",
            "an existing job's save sends sp_update_job with only the changed argument, under the identity and STALE guards' values");

        var notify = ActionService.AgentJobSavePlan(Save(Changed(new(Name: "Renamed", Enabled: false, EmailLevel: 0, EmailOperator: "", PageLevel: 2, PageOperator: "On-call DBA"))), Job);
        check(notify.Calls is [var single] && Names(single) == "@job_id,@new_name,@enabled,@notify_level_email,@notify_level_page,@notify_email_operator_name,@notify_page_operator_name"
            && ValueOf(notify, "@enabled") is (byte)0 && (string?)ValueOf(notify, "@notify_email_operator_name") == "" && (int?)ValueOf(notify, "@notify_level_page") == 2,
            "a rename is @new_name, Enabled a tinyint, and a cleared notification sends level 0 with the operator '' (how sp_update_job clears it)");

        var alerts = ActionService.AgentJobSavePlan(Save(Changed(new(RemoveAlerts: [new(11, "Log full"), new(12, "Severity 017")]))), Job);
        check(alerts.Calls is [{ Procedure: "sp_update_alert", AlertId: 11 }, { Procedure: "sp_update_alert", AlertId: 12 }] && AgentSql.LintJobSave(alerts.Text).Count == 0
            && alerts.Text.Contains(AgentSql.AlertGuard(1), StringComparison.Ordinal) && alerts.Text.Contains(AgentSql.AlertGuard(2), StringComparison.Ordinal)
            && (int?)ValueOf(alerts, "@alert_id_2") == 12 && (string?)ValueOf(alerts, "@name_2") == "Severity 017" && ValueOf(alerts, "@no_job") is Guid none && none == Guid.Empty,
            "removed alerts alone make no sp_update_job: each is a guarded sp_update_alert by name with the zero job id, its index its THROW state");

        var both = ActionService.AgentJobSavePlan(Save(Changed(new(Category: "Database Maintenance", RemoveAlerts: [new(11, "Log full")]))), Job);
        check(both.Calls is [{ Procedure: "sp_update_job" }, { Procedure: "sp_update_alert", AlertId: 11 }] && both.Text.Contains(AgentSql.AlertGuard(2), StringComparison.Ordinal)
            && AgentSql.LintJobSave(both.Text).Count == 0, "a job change and a removed alert are one transaction: the update first, then the detach as call 2");

        var created = ActionService.AgentJobSavePlan(Save(new(Name: "New job", Enabled: true, Description: "", Category: "[Uncategorized (Local)]", EmailLevel: 0, EmailOperator: "",
            PageLevel: 0, PageOperator: "", NetSendLevel: 0, NetSendOperator: "", EventLogLevel: 0, DeleteLevel: 0), AgentNode), AgentNode);
        check(created.Calls is [{ Procedure: "sp_add_job" } job, { Procedure: "sp_add_jobserver" } server] && AgentSql.LintJobSave(created.Text).Count == 0 && created.Text.StartsWith(AgentSql.NewJobHead, StringComparison.Ordinal)
            && Names(job) == "@job_name,@enabled,@category_name,@notify_level_eventlog,@notify_level_email,@notify_level_netsend,@notify_level_page,@delete_level,@job_id"
            && job.Arguments[^1].Output && Names(server) == "@job_id" && !created.Parameters.Any(parameter => parameter.Parameter.Name is "@name" or "@expected_job_id" or "@version" or "@modified"),
            "New Job's save is sp_add_job with every value it sets (no operator for level 0, no description '' or owner left out, so msdb's defaults stand) and the new id as its OUTPUT, then sp_add_jobserver on the local server; no identity or STALE guard");
        var owned = ActionService.AgentJobSavePlan(Save(new(Name: "Theirs", Owner: "CONTOSO\\dana", Description: "d"), AgentNode), AgentNode);
        check(owned.Calls[0].Arguments.Any(argument => argument.Name == "@owner_login_name" && (string?)argument.Value == "CONTOSO\\dana") && owned.Calls[0].Arguments.Any(argument => argument.Name == "@description"),
            "New Job sends the owner a sysadmin chose and a description it has");
        check(described.Text.Contains("@name", StringComparison.Ordinal) && !described.Text.Contains(Job.Name!, StringComparison.Ordinal) && !created.Text.Contains("New job", StringComparison.Ordinal),
            "names never enter the save's text: the job, operators and alerts are parameters");
    }

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new Host(Box2022));
        string Answer(ActionArgs args, bool script = false)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var longName = new string('n', 128);
        var valid = new (string Name, ActionArgs Args)[]
        {
            ("a description", Save(Changed(new(Description: "x")))), ("a 128-character name", Save(Changed(new(Name: longName)))), ("a 512-character description", Save(Changed(new(Description: new string('d', 512))))),
            ("a cleared notification", Save(Changed(new(EmailLevel: 0, EmailOperator: "")))), ("a page", Save(Changed(new(PageLevel: 3, PageOperator: "On-call")))),
            ("a removed alert", Save(Changed(new(RemoveAlerts: [new(1, "a")])))), ("New Job", Save(new(Name: "New"), AgentNode)), ("New Job with an owner", Save(new(Name: "New", Owner: "sa", EventLogLevel: 2), AgentNode))
        };
        foreach (var (name, args) in valid) check(Answer(args) == "accepted" && Answer(args, script: true) == "accepted", "the job document's save validates: " + name);
        check(Answer(Save(Changed(new(Description: "x")), jobId: null), script: true) == "accepted" && Answer(Save(Changed(new(Description: "x")), jobId: null)) == "INVALID_PARAMS",
            "Script may leave out the job's identity; the save itself may not");
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("nothing to change", Save(Changed(new()))), ("no version", Save(new(Description: "x"))), ("no modified date", Save(new(Version: 1, Description: "x"))),
            ("a modified date without milliseconds", Save(new(Version: 1, Modified: "2026-11-20T14:32:07", Description: "x"))), ("a modified date that is no date", Save(new(Version: 1, Modified: "2026-02-30T14:32:07.000", Description: "x"))),
            ("a negative version", Save(new(Version: -1, Modified: Modified, Description: "x"))), ("a blank name", Save(Changed(new(Name: "")))), ("a 129-character name", Save(Changed(new(Name: longName + "n")))),
            ("a name with U+0000", Save(Changed(new(Name: "a\0b")))), ("a 513-character description", Save(Changed(new(Description: new string('d', 513))))),
            ("a level of 4", Save(Changed(new(EventLogLevel: 4)))), ("a level without its operator", Save(Changed(new(EmailLevel: 2)))), ("an operator without its level", Save(Changed(new(EmailOperator: "DBA")))),
            ("a level 0 with an operator", Save(Changed(new(PageLevel: 0, PageOperator: "DBA")))), ("a level with no operator", Save(Changed(new(NetSendLevel: 1, NetSendOperator: "")))),
            ("an operator too long", Save(Changed(new(EmailLevel: 2, EmailOperator: longName + "x")))), ("no alerts listed", Save(Changed(new(RemoveAlerts: [])))),
            ("an alert twice", Save(Changed(new(RemoveAlerts: [new(1, "a"), new(1, "a")])))), ("an alert id of 0", Save(Changed(new(RemoveAlerts: [new(0, "a")])))),
            ("too many alerts", Save(Changed(new(RemoveAlerts: [.. Enumerable.Range(1, 33).Select(id => new AgentAlertRefDto(id, "a" + id))])))),
            ("New Job without a name", Save(new(Description: "x"), AgentNode)), ("New Job with a version", Save(Changed(new(Name: "x")), AgentNode)), ("New Job removing an alert", Save(new(Name: "x", RemoveAlerts: [new(1, "a")]), AgentNode)),
            ("New Job with an identity", Save(new(Name: "x"), AgentNode) with { AgentIdentity = new(JobId) }), ("a named Agent node", Save(new(Name: "x"), new ObjectRefDto("agent", Name: "x"))),
            ("a database's target", Save(Changed(new(Description: "x")), new ObjectRefDto("database", Name: "db"))), ("no save", Save(Changed(new(Description: "x"))) with { AgentJob = null }),
            ("another member", Save(Changed(new(Description: "x"))) with { NewName = "x" }),
            ("the save on another action", new ActionArgs("rename", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), Job) { NewName = "y", AgentIdentity = new(JobId), AgentJob = new(Name: "y") })
        };
        foreach (var (name, args) in invalid) check(Answer(args) == "INVALID_PARAMS", "the job document's save is refused: " + name);
        string Describe(ObjectRefDto target)
        {
            try { service.Validate(new ActionDescribeArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "agentJob", target)); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(Describe(Job) == "accepted" && Describe(AgentNode) == "accepted" && Describe(new ObjectRefDto("agent", Name: "x")) == "INVALID_PARAMS" && Describe(new ObjectRefDto("database", Name: "db")) == "INVALID_PARAMS",
            "the job document describes a job, or the SQL Server Agent node for New Job, and nothing else");
    }

    private static SqlException Exception(params (int Number, byte State, string Message)[] errors)
    {
        var collection = (SqlErrorCollection)Activator.CreateInstance(typeof(SqlErrorCollection), true)!;
        var add = typeof(SqlErrorCollection).GetMethod("Add", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        foreach (var (number, state, message) in errors)
        {
            var constructor = typeof(SqlError).GetConstructors(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
                .First(candidate => candidate.GetParameters().Length >= 8);
            var values = constructor.GetParameters().Select(parameter => parameter.Name switch
            {
                "infoNumber" => (object)number, "errorState" => state, "errorClass" => (byte)16, "server" => "s", "errorMessage" => message, "procedure" => "p", "lineNumber" => 1,
                _ => parameter.ParameterType == typeof(uint) ? 0u : parameter.ParameterType == typeof(int) ? 0 : parameter.ParameterType.IsValueType ? Activator.CreateInstance(parameter.ParameterType) : null
            }).ToArray();
            add.Invoke(collection, [constructor.Invoke(values)]);
        }
        var create = typeof(SqlException).GetMethod("CreateException", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic, [typeof(SqlErrorCollection), typeof(string)])!;
        return (SqlException)create.Invoke(null, [collection, "16.0"])!;
    }

    private static void Errors(Action<bool, string> check)
    {
        using var service = new ActionService(new Host(Box2022));
        var batch = ActionService.AgentJobSavePlan(Save(Changed(new(Category: "Nope", RemoveAlerts: [new(11, "Log full")]))), Job);
        var stale = service.JobSaveError(Exception((50011, 1, AgentSql.StaleMessage)), batch, null);
        check(stale is { Code: "STALE", Retryable: false } && stale.Message == AgentSql.StaleMessage, "the STALE guard's 50011 is STALE, not retryable: the same save always fails again");
        check(service.JobSaveError(Exception((50010, 1, AgentSql.ChangedMessage)), batch, null) is { Code: "NOT_FOUND" }, "the identity guard's 50010 is NOT_FOUND");
        var category = service.JobSaveError(Exception((14234, 1, "The specified '@category_name' is invalid (valid values are returned by sp_help_category)."), (50012, 1, AgentSql.RefusedMessage)), batch, null);
        check(category is { Field: "category" } && category.Message.StartsWith("Saving the job's settings was refused: The specified '@category_name'", StringComparison.Ordinal),
            "a refusal naming an argument lands on its field, and says which part of the save was refused");
        var alert = service.JobSaveError(Exception((14262, 2, "The specified @name ('Log full') does not exist."), (50012, 2, AgentSql.RefusedMessage)), batch, null);
        check(alert is { Code: "SQL_ERROR", Retryable: false, Field: "alerts" } && alert.Message.StartsWith("Saving removing alert 'Log full' was refused", StringComparison.Ordinal), "a refused detach lands on the alerts, naming the alert");
        var owned = ActionService.AgentJobSavePlan(Save(Changed(new(Owner: "bob", Description: "x"))), Job);
        var owner = service.JobSaveError(Exception((14262, 1, "The specified @owner_login_name ('bob') does not exist."), (50012, 1, AgentSql.RefusedMessage)), owned, null);
        check(owner is { Code: "SQL_ERROR", Retryable: false, Field: "owner" },
            "msdb's unquoted 'does not exist' lands on its field and is not NOT_FOUND, which only the job itself is (the document opens the compare on it): " + owner.Code + " " + owner.Field);
        var renamed = ActionService.AgentJobSavePlan(Save(Changed(new(Name: "Taken"))), Job);
        check(service.JobSaveError(Exception((14261, 1, "The specified @name ('Taken') already exists."), (50012, 1, AgentSql.RefusedMessage)), renamed, null) is { Code: "NAME_IN_USE", Field: "name" },
            "a name in use lands on the name");
        var denied = service.JobSaveError(Exception((14525, 1, "Only members of sysadmin role are allowed to update or delete jobs owned by a different login."), (50012, 1, AgentSql.RefusedMessage)), batch, null);
        check(denied is { Code: "PERMISSION_DENIED" }, "msdb's refusal of another owner's job is PERMISSION_DENIED");
        var aborted = service.JobSaveError(Exception((266, 1, "Transaction count after EXECUTE indicates a mismatching number of BEGIN and COMMIT statements.")), batch, null);
        check(aborted.Message.StartsWith(ActionService.JobSaveAbortedMessage, StringComparison.Ordinal) && aborted.Field is null, "a batch that aborted before its THROW says nothing was saved and names no part");
    }

    private static void Script(Action<bool, string> check)
    {
        var update = ActionService.AgentJobDocumentScript(Save(Changed(new(Description: "It's nightly", RemoveAlerts: [new(11, "Log full")]))), Job);
        check(update == "USE [msdb]\nGO\nBEGIN TRANSACTION\nDECLARE @ReturnCode INT\nSELECT @ReturnCode = 0\n"
            + "EXEC @ReturnCode = msdb.dbo.sp_update_job @job_name=N'Nightly '']'' -- load', \n\t\t@description=N'It''s nightly'\nIF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback\n"
            + "EXEC @ReturnCode = msdb.dbo.sp_update_alert @name=N'Log full', \n\t\t@job_id=N'00000000-0000-0000-0000-000000000000'\nIF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback\n"
            + "COMMIT TRANSACTION\nGOTO EndSave\nQuitWithRollback:\n    IF (@@TRANCOUNT > 0) ROLLBACK TRANSACTION\nEndSave:\nGO\n",
            "an existing job's Script is SSMS's one-transaction shape by the job's name, with only the changed arguments and the alert's detach, quoting every literal");
        var created = ActionService.AgentJobDocumentScript(Save(new(Name: "New", Enabled: true, EventLogLevel: 0), AgentNode), AgentNode);
        check(created.Contains("DECLARE @jobId BINARY(16)\nEXEC @ReturnCode = msdb.dbo.sp_add_job @job_name=N'New', \n\t\t@enabled=1, \n\t\t@notify_level_eventlog=0, \n\t\t@job_id = @jobId OUTPUT\n", StringComparison.Ordinal)
            && created.Contains("EXEC @ReturnCode = msdb.dbo.sp_add_jobserver @job_id = @jobId, \n\t\t@server_name = N'(local)'\n", StringComparison.Ordinal) && created.EndsWith("EndSave:\nGO\n", StringComparison.Ordinal),
            "New Job's Script is sp_add_job with the new id as @jobId OUTPUT, then sp_add_jobserver on (local), in SSMS's QuitWithRollback shape");
    }

    // --- The steps (AG-6b) -------------------------------------------------------------------------------------------------

    private static AgentStepWriteDto StepWrite(int id, string name = "", int proxy = 0, int onSuccess = 3, int onSuccessTarget = 0, int onFail = 2, int onFailTarget = 0, string subsystem = "TSQL",
        int flags = 0, int priority = 0) =>
        new(id, name.Length > 0 ? name : "Step " + id, subsystem, "SELECT 1;", subsystem == "TSQL" ? "master" : "", "", onSuccess, onSuccessTarget, onFail, onFailTarget, 0, 0, "", flags, 0, proxy, "", priority);
    private static string Temp(int n) => AgentSql.TemporaryStepPrefix + n.ToString("x32", System.Globalization.CultureInfo.InvariantCulture);

    private static void Steps(Action<bool, string> check)
    {
        static object? ValueOf(AgentSaveBatch batch, string name) => batch.Parameters.First(parameter => parameter.Parameter.Name == name).Value;
        static string Order(AgentSaveBatch batch) => string.Join(",", batch.Calls.Select(call => call.Procedure switch
        {
            "sp_delete_jobstep" => "D", "sp_add_jobstep" => "A", "sp_update_jobstep" => call.Arguments.Count == 3 + AgentSql.TemporaryStepContent.Count ? "T" : "W", "sp_update_job" => call.Part is null ? "J" : "S", "sp_update_alert" => "X", _ => "?"
        }));

        // A swap of two steps with a rename: survivors renamed, then each step written whole into its final id, then the Start step.
        var swap = new AgentStepsSaveDto(Temporary: [new(1, Temp(1)), new(2, Temp(2))], Writes: [StepWrite(1, "B", onSuccess: 4, onSuccessTarget: 2), StepWrite(2, "A", proxy: 4, subsystem: "CmdExec", flags: 96, priority: 15)], StartStepId: 2);
        var swapped = ActionService.AgentJobSavePlan(Save(Changed(new(Description: "x", RemoveAlerts: [new(11, "Log full")], Steps: swap))), Job);
        check(Order(swapped) == "J,X,T,T,W,W,S" && AgentSql.LintJobSave(swapped.Text).Count == 0, "a swap saves the job, the alerts, temporary names, whole contents and the Start step, in that order: " + Order(swapped));
        check((string?)ValueOf(swapped, "@subsystem_3") == "TSQL" && (string?)ValueOf(swapped, "@database_name_3") == "master" && (string?)ValueOf(swapped, "@proxy_name_3") == ""
            && (string?)ValueOf(swapped, "@output_file_name_3") == "" && (int?)ValueOf(swapped, "@flags_3") == 0,
            "a temporary name's call sets neutral content, so msdb does not re-check the stored step's before the whole write");
        check((int?)ValueOf(swapped, "@step_id_3") == 1 && (string?)ValueOf(swapped, "@step_name_3") == Temp(1) && (string?)ValueOf(swapped, "@step_name_5") == "B"
            && ValueOf(swapped, "@on_success_action_5") is (byte)4 && (int?)ValueOf(swapped, "@on_success_step_id_5") == 2 && (int?)ValueOf(swapped, "@proxy_id_6") == 4
            && (int?)ValueOf(swapped, "@flags_6") == 96 && (int?)ValueOf(swapped, "@os_run_priority_6") == 15 && (string?)ValueOf(swapped, "@proxy_name_5") == ""
            && (int?)ValueOf(swapped, "@start_step_id") == 2 && swapped.Calls[^1] is { Procedure: "sp_update_job", Part: "the Start step" },
            "each step call binds its own indexed parameters: actions as tinyint, a proxy by id or the service account as @proxy_name '', flags and priority as given");

        var emptied = ActionService.AgentJobSavePlan(Save(Changed(new(Steps: new(Deletes: [2, 1], StartStepId: 1)))), Job);
        check(Order(emptied) == "D,D,S" && AgentSql.LintJobSave(emptied.Text).Count == 0 && (int?)ValueOf(emptied, "@start_step_id") == 1,
            "deleting every step sets the Start step back to 1, which msdb's sp_delete_jobstep would leave past the last step: " + Order(emptied));
        var reordered = ActionService.AgentJobSavePlan(Save(Changed(new(Steps: new(Deletes: [3, 1], Temporary: [new(1, Temp(1))], Adds: [new(1, Temp(2))], Writes: [StepWrite(1), StepWrite(2)], StartStepId: 1)))), Job);
        check(Order(reordered) == "D,D,T,A,W,W,S" && AgentSql.LintJobSave(reordered.Text).Count == 0 && (int?)ValueOf(reordered, "@step_id_1") == 3 && (int?)ValueOf(reordered, "@step_id_2") == 1,
            "deletes go first from the highest id, then temporary names, inserts and whole contents; only steps change, so there is no sp_update_job of the job's own");

        var edit = ActionService.AgentJobSavePlan(Save(Changed(new(Steps: new(Writes: [StepWrite(2, "Load")])))), Job);
        check(Order(edit) == "W" && AgentSql.LintJobSave(edit.Text).Count == 0, "an edit without a structural change writes only the changed step");

        var created = ActionService.AgentJobSavePlan(Save(new(Name: "New", Steps: new(Writes: [StepWrite(1, onSuccess: 4, onSuccessTarget: 2), StepWrite(2)], StartStepId: 2)), AgentNode), AgentNode);
        check(string.Join(",", created.Calls.Select(call => call.Procedure)) == "sp_add_job,sp_add_jobstep,sp_add_jobstep,sp_add_jobserver,sp_update_job" && AgentSql.LintJobSave(created.Text).Count == 0
            && created.Calls[1].Arguments.Count == AgentSql.StepWriteArguments.Count + 2,
            "New Job adds its steps whole between sp_add_job and sp_add_jobserver, then sets its Start step");

        // The lint's step near misses.
        var existing = AgentSql.Resolve + AgentSql.StaleGuard;
        string Call(int index, string call) => call + AgentSql.CheckAt(index);
        var misses = new (string Text, string Problem)[]
        {
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_delete_jobstep @job_id = @job_id, @step_id = @step_id;"), "passes @step_id another parameter's value"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_delete_jobstep @job_id = @job_id, @step_id = @step_id_1, @step_name = @step_name_1;"), "deletes a step without its job and id alone"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_update_jobstep @job_id = @job_id, @step_id = @step_id_1, @command = @command_1;"), "updates a step with neither its whole content nor only a temporary name"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_add_jobstep @job_id = @job_id, @step_id = @step_id_1, @step_name = @step_name_1, @command = @command_1;"), "inserts a step with more than its id and temporary name"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @enabled = @enabled, @start_step_id = @start_step_id;"), "sets the Start step with other job settings"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_update_jobstep @job_id = @job_id, @step_id = @step_id_1, @step_name = @step_name_1;")
                + Call(2, "EXEC @rc = msdb.dbo.sp_delete_jobstep @job_id = @job_id, @step_id = @step_id_2;"), "calls out of the save's order (job, alerts, step deletes, temporary names, inserts, step contents, Start step, schedules)"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @start_step_id = @start_step_id;")
                + Call(2, "EXEC @rc = msdb.dbo.sp_update_jobstep @job_id = @job_id, @step_id = @step_id_2, @step_name = @step_name_2;"), "calls out of the save's order (job, alerts, step deletes, temporary names, inserts, step contents, Start step, schedules)"),
            (AgentSql.NewJobHead + Call(1, "EXEC @rc = msdb.dbo.sp_add_job @job_name = @job_name, @job_id = @job_id OUTPUT;") + Call(2, "EXEC @rc = msdb.dbo.sp_add_jobstep @job_id = @job_id, @step_id = @step_id_2, @step_name = @step_name_2;")
                + Call(3, "EXEC @rc = msdb.dbo.sp_add_jobserver @job_id = @job_id;"), "adds a new job's step without its whole content"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_update_jobstep @job_id = @job_id, @step_id = @step_id_1, @step_name = @step_name_1, @output_file_name = @output_file_name_1;"), "updates a step with neither its whole content nor only a temporary name")
        };
        foreach (var (text, problem) in misses)
        {
            var found = AgentSql.LintJobSave(text);
            check(found.Any(item => item.EndsWith(problem, StringComparison.Ordinal)), "the job save lint refuses a step save that " + problem + " (found: " + string.Join(", ", found) + ")");
        }
        check(AgentSql.LintExecutable(AgentSql.Resolve + "EXEC @rc = msdb.dbo.sp_delete_jobstep @job_id = @job_id, @step_id = @step_id;" + AgentSql.Check).Contains("EXECs sp_delete_jobstep, which only a job save calls")
            && AgentSql.LintExecutable(AgentSql.Resolve + "EXEC @rc = msdb.dbo.sp_update_jobstep @job_id = @job_id, @step_id = @step_id;" + AgentSql.Check).Contains("EXECs sp_update_jobstep, which only a job save calls"),
            "the one-call write lints refuse the step procedures, which only the planner's whole sequence calls");

        // Validation.
        using var service = new ActionService(new Host(Box2022));
        string Answer(AgentStepsSaveDto steps, bool create = false)
        {
            try { service.Validate(create ? Save(new(Name: "New", Steps: steps), AgentNode) : Save(Changed(new(Steps: steps))), false); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(Answer(swap) == "accepted" && Answer(new(Writes: [StepWrite(2, "Load")])) == "accepted" && Answer(new(Writes: [StepWrite(1), StepWrite(2)], StartStepId: 2), create: true) == "accepted"
            && Answer(new(Deletes: [1])) == "accepted" && Answer(new(StartStepId: 2)) == "accepted" && Answer(new(Writes: [StepWrite(1, onFail: 4, onFailTarget: 9)])) == "accepted",
            "the steps save validates: a swap, one step's edit, New Job's steps, deleting the last step, the Start step alone, and a go-to past the last step as msdb keeps it");
        var invalid = new (string Name, AgentStepsSaveDto Steps, bool Create)[]
        {
            ("nothing", new(), false), ("an empty list", new(Deletes: []), false), ("deletes upward", new(Deletes: [1, 3]), false),
            ("a survivor renamed out of place", new(Temporary: [new(2, Temp(1))], Writes: [StepWrite(1)], StartStepId: 1), false),
            ("a temporary name not in the pattern", new(Temporary: [new(1, "x")], Writes: [StepWrite(1)], StartStepId: 1), false),
            ("a step named with the temporary prefix", new(Writes: [StepWrite(1, AgentSql.TemporaryStepPrefix + "x")]), false),
            ("an insert past the end", new(Temporary: [new(1, Temp(1))], Adds: [new(3, Temp(2))], Writes: [StepWrite(1), StepWrite(2)], StartStepId: 1), false),
            ("a missing write after renumbering", new(Temporary: [new(1, Temp(1)), new(2, Temp(2))], Writes: [StepWrite(1)], StartStepId: 1), false),
            ("no Start step after renumbering", new(Temporary: [new(1, Temp(1))], Writes: [StepWrite(1)]), false),
            ("a temporary name twice", new(Temporary: [new(1, Temp(1)), new(2, Temp(1))], Writes: [StepWrite(1), StepWrite(2)], StartStepId: 1), false),
            ("two steps of one name", new(Temporary: [new(1, Temp(1)), new(2, Temp(2))], Writes: [StepWrite(1, "a"), StepWrite(2, "A")], StartStepId: 1), false),
            ("a step written twice", new(Writes: [StepWrite(1), StepWrite(1)]), false), ("a go-to to itself", new(Writes: [StepWrite(1, onSuccess: 4, onSuccessTarget: 1)]), false),
            ("a target without a go-to", new(Writes: [StepWrite(1, onSuccessTarget: 2)]), false), ("an action of 5", new(Writes: [StepWrite(1, onSuccess: 5)]), false),
            ("flags past 114", new(Writes: [StepWrite(1, flags: 115)]), false), ("an os priority of 2", new(Writes: [StepWrite(1, priority: 2)]), false),
            ("an unknown step type", new(Writes: [StepWrite(1, subsystem: "Nope")]), false), ("a command too long", new(Writes: [StepWrite(1) with { Command = new string('c', 100_001) }]), false),
            ("an output path too long", new(Writes: [StepWrite(1) with { OutputFileName = new string('o', 201) }]), false), ("a retry count too high", new(Writes: [StepWrite(1) with { RetryAttempts = 10_000 }]), false),
            ("a command with U+0000", new(Writes: [StepWrite(1) with { Command = "a\0b" }]), false), ("step 51", new(Writes: [StepWrite(51)]), false),
            ("commands too long together", new(Writes: [.. Enumerable.Range(1, 11).Select(id => StepWrite(id) with { Command = new string('c', 100_000) })]), true),
            ("New Job deleting a step", new(Deletes: [1], Writes: [StepWrite(1)]), true), ("New Job's steps out of order", new(Writes: [StepWrite(2)]), true),
            ("New Job's Start step past its steps", new(Writes: [StepWrite(1)], StartStepId: 2), true)
        };
        foreach (var (name, steps, create) in invalid) check(Answer(steps, create) == "INVALID_PARAMS", "the steps save is refused: " + name);

        // Refusals land on the steps and name the step's part.
        var failed = service.JobSaveError(Exception((14262, 6, "The specified @proxy_id ('4') does not exist."), (50012, 6, AgentSql.RefusedMessage)), swapped, null);
        check(failed is { Field: "steps" } && failed.Message.StartsWith("Saving step 2 was refused", StringComparison.Ordinal) is var named && named,
            "a refused step call lands on the steps and says which step: " + failed.Message);

        // The script carries the step calls by the job's name.
        var script = ActionService.AgentJobDocumentScript(Save(Changed(new(Steps: swap))), Job);
        check(script.Contains("EXEC @ReturnCode = msdb.dbo.sp_update_jobstep @job_name=N'Nightly '']'' -- load', \n\t\t@step_id=1, \n\t\t@step_name=N'" + Temp(1) + "'", StringComparison.Ordinal)
            && script.Contains("@start_step_id=2", StringComparison.Ordinal) && script.Contains("@proxy_id=4", StringComparison.Ordinal),
            "the save's script renames, writes and sets the Start step by the job's name");
        // Renamed in the same save: the job's own call names it as it was, every later call by its new name.
        var renamed = ActionService.AgentJobDocumentScript(Save(Changed(new(Name: "Nightly 2", Steps: swap))), Job);
        check(renamed.Contains("sp_update_job @job_name=N'Nightly '']'' -- load', \n\t\t@new_name=N'Nightly 2'", StringComparison.Ordinal)
            && renamed.Contains("sp_update_jobstep @job_name=N'Nightly 2', \n\t\t@step_id=1", StringComparison.Ordinal) && !renamed.Contains("sp_update_jobstep @job_name=N'Nightly ''", StringComparison.Ordinal),
            "a script that renames the job names it by its new name after the rename: " + renamed);
    }
    /// <summary>language.parse: ScriptDom alone, batches split on GO, errors with their position and number, and the text bounded.</summary>
    private static void Parse(Action<bool, string> check)
    {
        static LanguageParseResult Run(string text) => StepParser.ParseAsync(new LanguageParseArgs(text), CancellationToken.None).GetAwaiter().GetResult();
        var clean = Run("SELECT 1;\nGO\nEXEC dbo.Load @day = 1;");
        check(clean.Errors.Count == 0 && !clean.Truncated, "Parse finds no error in T-SQL batches split on GO");
        var deep = Run("SELECT " + new string('(', 40_000) + "1" + new string(')', 40_000));
        check(deep.Errors is [{ Line: 1, Number: 0 } refusal] && refusal.Message.Contains("too deep", StringComparison.Ordinal), "Parse refuses nesting deeper than SQL Server accepts instead of overflowing the stack");
        var chain = Run("SELECT 1" + string.Concat(Enumerable.Repeat(" + 1", 40_000)));
        check(chain.Errors.Count == 0, "Parse takes a long operator chain on its large-stack thread");
        var wrong = Run("SELECT 1;\nSELEC 2");
        check(wrong.Errors.Count >= 1 && wrong.Errors[0] is { Line: 2, Number: > 0 } first && first.Message.Contains("SELEC", StringComparison.Ordinal) && first.Message.Length <= StepParser.MessageChars,
            "Parse reports a syntax error with its line, number and message");
        var limit = (int)AgentCatalog.Current.Limit("parseChars");
        var refused = false;
        try { Run(new string(' ', limit + 1)); }
        catch (RequestException error) { refused = error.Code == "INVALID_PARAMS"; }
        check(refused, "Parse refuses a text over the catalogue's parseChars");
    }
}
