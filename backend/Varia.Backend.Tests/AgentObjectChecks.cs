using Microsoft.Data.SqlClient;
using Varia.Backend;
using Varia.Backend.Actions;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

/// <summary>Alerts and operators (AG-7), offline: the batch lint and its near misses, the planners (New Alert with inline operators and notifications,
/// an existing alert's changed arguments, an operator's save, the tree's verbs, Delete with Reassign to, Add recommended alerts, Send test e-mail), the
/// requests' validation, the refusal mapping and the script.</summary>
internal static class AgentObjectChecks
{
    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);
    private static readonly ObjectRefDto AgentNode = new("agent");
    private static readonly ObjectRefDto Alert = new("agentAlert", Name: "Severity 017 ']' -- x");
    private static readonly ObjectRefDto Operator = new("agentOperator", Name: "DBA ']' team");
    private const string JobId = "00000000-1111-2222-3333-444444444441";

    private sealed class Host(ServerProfile profile) : IActionHost
    {
        public ServerProfile Profile(string connectionId) => profile;
        public SqlConnection Connection(string connectionId) => new("Data Source=" + Unreachable.Source + ";Connect Timeout=1;Pooling=false;Encrypt=false");
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => connection.OpenAsync(token);
        public bool ClearPoolsFor(string connectionId, string database) => true;
        public bool FreeDatabase(string connectionId, string database) => true;
        public IReadOnlySet<int> PoolSessions(string connectionId) => new HashSet<int>();
        public IReadOnlyList<string> SameServer(string connectionId) => [connectionId];
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
    }

    private static ActionArgs Args(string action, ObjectRefDto target) => new(action, Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target);
    private static ActionArgs AlertSave(AgentAlertSaveDto save, ObjectRefDto? target = null, int? id = 7) => Args("agentAlert", target ?? Alert) with { AgentAlert = save, AgentObjectId = target?.Kind == "agent" ? null : id };
    private static ActionArgs OperatorSave(AgentOperatorSaveDto save, ObjectRefDto? target = null, int? id = 9) => Args("agentOperator", target ?? Operator) with { AgentOperator = save, AgentObjectId = target?.Kind == "agent" ? null : id };

    public static Task RunAsync(Action<bool, string> check)
    {
        Lint(check);
        Planner(check);
        Validation(check);
        Errors(check);
        Script(check);
        return Task.CompletedTask;
    }

    private static void Lint(Action<bool, string> check)
    {
        var results = AgentSql.LintObjectBatches().ToList();
        var failures = results.Where(item => item.Problems.Count > 0).Select(item => item.Name + ": " + string.Join(", ", item.Problems)).ToList();
        check(failures.Count == 0 && results.Count == 8, "the alert and operator batch shapes pass their lint" + (failures.Count == 0 ? "" : ": " + string.Join("; ", failures)));
        check(AgentSql.LintWrites().Count(item => item.Name.StartsWith("object batch ", StringComparison.Ordinal)) == 8, "the Agent write lint (and so the object actions' lint) runs the alert and operator batches too");
        foreach (var statement in new[] { AgentSql.AlertDocument, AgentSql.AlertRows, AgentSql.OperatorRows, AgentSql.Notifications, AgentSql.JobNotifications, AgentSql.AlertJobs, AgentSql.AlertDatabases,
            AgentSql.Counters, AgentSql.CounterValues, AgentSql.MessageText })
            check(AgentSql.Known(statement) && AgentSql.Lint(statement, null).Count == 0, "the alert and operator read " + statement.Id + " is one the reader runs, and passes the Agent read lint: " + string.Join(", ", AgentSql.Lint(statement, null)));
        check(AgentSql.LintRead(AgentSql.AlertByName, null).Count == 0 && AgentSql.LintRead(AgentSql.OperatorByName, null).Count == 0, "the by-name reads pass the Agent read lint");

        string Call(int index, string call) => call + AgentSql.CheckAt(index);
        var update = Call(1, "EXEC @rc = msdb.dbo.sp_update_alert @name = @name, @enabled = @c1_enabled;");
        var notify = Call(2, "EXEC @rc = msdb.dbo.sp_add_notification @alert_name = @c2_alert_name, @operator_name = @c2_operator_name, @notification_method = @c2_notification_method;");
        check(AgentSql.LintObjectBatch(AgentSql.AlertResolve + update + notify).Count == 0, "the lint admits an alert update with a notification");
        var misses = new (string Text, string Problem)[]
        {
            ("EXEC @rc = msdb.dbo.sp_delete_alert @name = @name;" + AgentSql.CheckAt(1), "does not open with a new object's declaration or an alert's or operator's identity guard"),
            (AgentSql.AlertResolve + Call(1, "EXEC @rc = msdb.dbo.sp_update_alert @name = @c1_name, @enabled = @c1_enabled;"), "passes @name another parameter's value"),
            (AgentSql.AlertResolve + Call(1, "EXEC @rc = msdb.dbo.sp_update_alert @name = @name, @enabled = @c2_enabled;"), "passes @enabled another parameter's value"),
            (AgentSql.AlertResolve + Call(1, "EXEC @rc = msdb.dbo.sp_update_alert @name = @name, @enabled = 1;"), "call 1 is not one msdb call in the alert and operator shape"),
            (AgentSql.AlertResolve + Call(1, "EXEC @rc = msdb.dbo.sp_update_alert @name = @name, @owner = @c1_owner;"), "passes @owner to sp_update_alert"),
            (AgentSql.AlertResolve + Call(1, "EXEC @rc = msdb.dbo.sp_update_alert @name = @name, @enabled = @c1_enabled, @enabled = @c1_enabled;"), "passes @enabled twice"),
            (AgentSql.AlertResolve + "EXEC @rc = msdb.dbo.sp_update_alert @name = @name, @enabled = @c1_enabled;" + AgentSql.CheckAt(2), "call 1 is not followed by its return-code check"),
            (AgentSql.AlertResolve + Call(1, "EXEC @rc = msdb.dbo.sp_update_operator @name = @c1_name, @enabled = @c1_enabled;"), "an alert's batch touches another alert, or updates it twice"),
            (AgentSql.OperatorResolve + Call(1, "EXEC @rc = msdb.dbo.sp_update_alert @name = @c1_name, @enabled = @c1_enabled;"), "an operator's batch touches another operator, or updates it twice"),
            (AgentSql.ObjectNewHead + Call(1, "EXEC @rc = msdb.dbo.sp_delete_alert @name = @c1_name;"), "a new object's batch does more than add and notify"),
            (AgentSql.AlertResolve + Call(1, "EXEC @rc = msdb.dbo.sp_delete_alert @name = @name;") + Call(2, "EXEC @rc = msdb.dbo.sp_delete_notification @alert_name = @c2_alert_name, @operator_name = @c2_operator_name;"), "sp_delete_alert does not stand alone"),
            (AgentSql.ObjectNewHead + Call(1, "EXEC @rc = msdb.dbo.sp_add_notification @alert_name = @c1_alert_name, @operator_name = @c1_operator_name;"), "sp_add_notification does not pass @notification_method"),
            (AgentSql.ObjectNewHead + Call(1, "EXEC @rc = msdb.dbo.sp_add_job @job_name = @c1_job_name;"), "EXECs sp_add_job, which an alert or operator batch does not call"),
            (AgentSql.ObjectNewHead + Call(1, "EXEC @rc = msdb.dbo.sp_add_alert @name = @c1_name; DELETE msdb.dbo.sysalerts;"), "call 1 is not one msdb call in the alert and operator shape"),
            (AgentSql.ObjectNewHead, "makes no call")
        };
        foreach (var (text, problem) in misses)
        {
            var problems = AgentSql.LintObjectBatch(text);
            check(problems.Contains(problem), "the alert and operator lint refuses: " + problem + " (got: " + string.Join(", ", problems) + ")");
        }
    }

    private static string Procedures(AgentObjectBatch batch) => string.Join(",", batch.Calls.Select(call => call.Procedure));
    private static object? ValueOf(AgentObjectBatch batch, string name) => batch.Parameters.FirstOrDefault(parameter => parameter.Parameter.Name == name).Value;

    private static void Planner(Action<bool, string> check)
    {
        var created = ActionService.AlertSavePlan(AlertSave(new(Name: "New", Enabled: true, MessageId: 0, Severity: 19, Delay: 60, IncludeIn: 1, Database: "", Keyword: "", JobId: "", Message: "",
            NewOperators: [new("On call", Email: "oncall@example.test")], Notifications: [new("On call", 1, "add"), new("DBA", 3, "add")]), AgentNode), AgentNode);
        check(created.Head == AgentObjectHead.None && Procedures(created) == "sp_add_operator,sp_add_alert,sp_add_notification,sp_add_notification" && AgentSql.LintObjectBatch(created.Text).Count == 0,
            "New Alert creates its inline operators first, then the alert, then its notifications, in one linted batch: " + Procedures(created));
        var add = created.Calls[1];
        check(add.Arguments.Select(argument => argument.Argument).SequenceEqual(["@name", "@enabled", "@message_id", "@severity", "@delay_between_responses", "@include_event_description_in"]),
            "New Alert leaves empty texts and no job to sp_add_alert's defaults: " + string.Join(",", add.Arguments.Select(argument => argument.Argument)));
        check(Equals(ValueOf(created, "@c3_alert_name"), "New") && Equals(ValueOf(created, "@c3_operator_name"), "On call") && Equals(ValueOf(created, "@c4_notification_method"), (byte)3),
            "each notification names the new alert, its operator and its methods");
        check(!created.Text.Contains("New", StringComparison.Ordinal) && !created.Text.Contains("oncall", StringComparison.Ordinal), "names and addresses never enter the batch's text");

        var renamed = ActionService.AlertSavePlan(AlertSave(new(Name: "Renamed", JobId: "", ResetCount: true, Notifications: [new("DBA", 0, "delete")])), Alert);
        check(renamed.Head == AgentObjectHead.Alert && Procedures(renamed) == "sp_update_alert,sp_delete_notification" && AgentSql.LintObjectBatch(renamed.Text).Count == 0,
            "an existing alert's save resolves it, updates only what changed and applies notification changes after");
        check(Equals(ValueOf(renamed, "@name"), Alert.Name) && Equals(ValueOf(renamed, "@expected_id"), 7) && Equals(ValueOf(renamed, "@c1_new_name"), "Renamed") && Equals(ValueOf(renamed, "@c1_job_id"), Guid.Empty)
            && Equals(ValueOf(renamed, "@c1_occurrence_count"), 0) && Equals(ValueOf(renamed, "@c2_alert_name"), "Renamed"),
            "a rename goes as @new_name, the identity guard binds the name and id read, a detached job is the zero id, Reset count is 0 occurrences, and later calls use the new name");
        var notifyOnly = ActionService.AlertSavePlan(AlertSave(new(Notifications: [new("DBA", 2, "update")])), Alert);
        check(Procedures(notifyOnly) == "sp_update_notification", "an alert save that only changes notifications calls no sp_update_alert");
        var job = ActionService.AlertSavePlan(AlertSave(new(JobId: JobId)), Alert);
        check(Equals(ValueOf(job, "@c1_job_id"), Guid.ParseExact(JobId, "D")), "a job goes as its id");

        var newOperator = ActionService.OperatorSavePlan(OperatorSave(new(Name: "Ops", Enabled: true, Email: "ops@example.test", Pager: "", NetSend: "", PagerDays: 62, WeekdayStart: 80000, WeekdayEnd: 180000,
            SaturdayStart: 0, SaturdayEnd: 0, SundayStart: 0, SundayEnd: 0, Notifications: [new("Sev 19", 1, "add")]), AgentNode), AgentNode);
        check(Procedures(newOperator) == "sp_add_operator,sp_add_notification" && AgentSql.LintObjectBatch(newOperator.Text).Count == 0 && !newOperator.Calls[0].Arguments.Any(argument => argument.Argument is "@pager_address" or "@netsend_address")
            && Equals(ValueOf(newOperator, "@c2_operator_name"), "Ops") && Equals(ValueOf(newOperator, "@c2_alert_name"), "Sev 19") && Equals(ValueOf(newOperator, "@c1_pager_days"), (byte)62),
            "New Operator creates it with its addresses and duty, then the alerts that notify it");
        var operatorUpdate = ActionService.OperatorSavePlan(OperatorSave(new(Name: "Ops 2", Pager: "")), Operator);
        check(operatorUpdate.Head == AgentObjectHead.Operator && Equals(ValueOf(operatorUpdate, "@c1_pager_address"), "") && Equals(ValueOf(operatorUpdate, "@c1_new_name"), "Ops 2"), "an operator update clears an address with ''");

        var reassign = ActionService.ObjectVerbPlan(Args("delete", Operator) with { CloseConnections = false, DeleteHistory = false, ReassignTo = "Backup DBA" }, Operator, 9);
        check(Procedures(reassign) == "sp_delete_operator" && Equals(ValueOf(reassign, "@c1_reassign_to_operator"), "Backup DBA") && AgentSql.LintObjectBatch(reassign.Text).Count == 0,
            "Delete operator with Reassign to passes sp_delete_operator's @reassign_to_operator");
        var drop = ActionService.ObjectVerbPlan(Args("delete", Operator) with { CloseConnections = false, DeleteHistory = false }, Operator, 9);
        check(drop.Calls[0].Arguments.Count == 1, "Delete operator without Reassign to drops its notifications");
        foreach (var (verb, target) in new[] { ("enable", Alert), ("disable", Alert), ("enable", Operator), ("disable", Operator) })
        {
            var batch = ActionService.ObjectVerbPlan(Args(verb, target), target, 3);
            check(AgentSql.LintObjectBatch(batch.Text).Count == 0 && Equals(ValueOf(batch, "@c1_enabled"), (byte)(verb == "enable" ? 1 : 0)), "the tree's " + verb + " on a " + target.Kind + " is one linted call");
        }
        var recommended = ActionService.RecommendedPlan(new([new("Severity 019", 0, 19), new("Error 823", 823, 0)], 1, 300, "DBA"));
        check(Procedures(recommended) == "sp_add_alert,sp_add_notification,sp_add_alert,sp_add_notification" && AgentSql.LintObjectBatch(recommended.Text).Count == 0
            && Equals(ValueOf(recommended, "@c3_message_id"), 823) && Equals(ValueOf(recommended, "@c1_delay_between_responses"), 300),
            "Add recommended alerts creates each alert with the one delay and notifies the one operator");
        var test = ActionService.NotifyPlan(Operator, 9, "Agent profile");
        check(Procedures(test) == "sp_notify_operator" && Equals(ValueOf(test, "@c1_profile_name"), "Agent profile") && AgentSql.LintObjectBatch(test.Text).Count == 0, "Send test e-mail goes through Agent's own profile");
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
            ("an alert's enable", AlertSave(new(Enabled: false))), ("a 128-character rename", AlertSave(new(Name: longName))), ("a switch to an error number", AlertSave(new(MessageId: 50001, Severity: 0))),
            ("a condition", AlertSave(new(Condition: "SQLServer:Databases|Log File(s) Used Size (KB)|_Total|>|1000"))), ("a reset", AlertSave(new(ResetCount: true))),
            ("New Alert", AlertSave(new(Name: "x", MessageId: 0, Severity: 17), AgentNode)), ("New Alert with an inline operator", AlertSave(new(Name: "x", MessageId: 0, Severity: 17, NewOperators: [new("o")], Notifications: [new("o", 1, "add")]), AgentNode)),
            ("an operator's addresses", OperatorSave(new(Email: "a@b.test", Pager: ""))), ("an operator's duty", OperatorSave(new(PagerDays: 127, WeekdayStart: 0, WeekdayEnd: 235959, SaturdayStart: 0, SaturdayEnd: 0, SundayStart: 0, SundayEnd: 0))),
            ("New Operator", OperatorSave(new(Name: "o"), AgentNode)),
            ("an alert's rename", Args("rename", Alert) with { NewName = "y" }), ("an operator's disable", Args("disable", Operator)),
            ("an alert's delete", Args("delete", Alert) with { CloseConnections = false, DeleteHistory = false, AgentObjectId = 7 }),
            ("an operator's delete with reassign", Args("delete", Operator) with { CloseConnections = false, DeleteHistory = false, AgentObjectId = 9, ReassignTo = "Backup" }),
            ("Add recommended alerts", Args("addRecommendedAlerts", AgentNode) with { AgentRecommended = new([new("Sev 19", 0, 19)], 1, 60, "DBA") })
        };
        foreach (var (name, args) in valid) check(Answer(args) == "accepted" && Answer(args, script: true) == "accepted", "the AG-7 request validates: " + name);
        check(Answer(Args("notifyOperator", Operator) with { AgentObjectId = 9 }) == "accepted" && Answer(Args("notifyOperator", Operator) with { AgentObjectId = 9 }, script: true) == "INVALID_PARAMS",
            "Send test e-mail runs, and has no script");
        check(Answer(AlertSave(new(Enabled: true), id: null), script: true) == "accepted" && Answer(AlertSave(new(Enabled: true), id: null)) == "INVALID_PARAMS", "Script may leave out the alert's id; the save itself may not");
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("nothing to change", AlertSave(new())), ("a 129-character name", AlertSave(new(Name: longName + "n"))), ("a severity of 26", AlertSave(new(MessageId: 0, Severity: 26))),
            ("an error number without its severity", AlertSave(new(MessageId: 1))), ("both an error number and a severity", AlertSave(new(MessageId: 50001, Severity: 17))),
            ("a condition with a severity", AlertSave(new(Condition: "a|b|c|>|1", MessageId: 0, Severity: 17))), ("a condition of four parts", AlertSave(new(Condition: "a|b|>|1"))),
            ("a 513-character message", AlertSave(new(Message: new string('m', 513)))), ("a 101-character keyword", AlertSave(new(Keyword: new string('k', 101)))),
            ("a delay of more than a day", AlertSave(new(Delay: 86401))), ("include in of 8", AlertSave(new(IncludeIn: 8))), ("a job that is no id", AlertSave(new(JobId: "nightly"))),
            ("a reset of false", AlertSave(new(ResetCount: false))), ("a notification twice", AlertSave(new(Notifications: [new("o", 1, "add"), new("o", 2, "update")]))),
            ("a delete with methods", AlertSave(new(Notifications: [new("o", 1, "delete")]))), ("an add without methods", AlertSave(new(Notifications: [new("o", 0, "add")]))),
            ("an inline operator not notified", AlertSave(new(Name: "x", MessageId: 0, Severity: 17, NewOperators: [new("o")]), AgentNode)),
            ("New Alert without a name", AlertSave(new(MessageId: 0, Severity: 17), AgentNode)), ("New Alert without a raise-on", AlertSave(new(Name: "x"), AgentNode)),
            ("New Alert with a reset", AlertSave(new(Name: "x", MessageId: 0, Severity: 17, ResetCount: true), AgentNode)), ("New Alert with an id", AlertSave(new(Name: "x", MessageId: 0, Severity: 17), AgentNode) with { AgentObjectId = 7 }),
            ("an alert save on an operator", AlertSave(new(Enabled: true), Operator)), ("an operator save with an alert's", OperatorSave(new(Enabled: true)) with { AgentAlert = new(Enabled: true) }),
            ("a duty without all its times", OperatorSave(new(PagerDays: 1))), ("a duty time of 25:00", OperatorSave(new(PagerDays: 1, WeekdayStart: 250000, WeekdayEnd: 0, SaturdayStart: 0, SaturdayEnd: 0, SundayStart: 0, SundayEnd: 0))),
            ("an address too long", OperatorSave(new(Email: new string('e', 101)))), ("New Operator without a name", OperatorSave(new(Email: "a@b.test"), AgentNode)),
            ("a delete without its id", Args("delete", Alert) with { CloseConnections = false, DeleteHistory = false }), ("an alert's delete with reassign", Args("delete", Alert) with { CloseConnections = false, DeleteHistory = false, AgentObjectId = 7, ReassignTo = "x" }),
            ("a reassign to itself", Args("delete", Operator) with { CloseConnections = false, DeleteHistory = false, AgentObjectId = 9, ReassignTo = Operator.Name }),
            ("a delete deleting history", Args("delete", Alert) with { CloseConnections = false, DeleteHistory = true, AgentObjectId = 7 }), ("a rename with an id", Args("rename", Alert) with { NewName = "y", AgentObjectId = 7 }),
            ("an alert's start", Args("startJob", Alert)), ("a job identity on an alert", Args("disable", Alert) with { AgentIdentity = new(JobId) }),
            ("recommended without an operator's methods", Args("addRecommendedAlerts", AgentNode) with { AgentRecommended = new([new("Sev 19", 0, 19)], 0, 60, "DBA") }),
            ("recommended raising on both", Args("addRecommendedAlerts", AgentNode) with { AgentRecommended = new([new("Sev 19", 823, 19)], 0, 60) }),
            ("recommended on an alert", Args("addRecommendedAlerts", Alert) with { AgentRecommended = new([new("Sev 19", 0, 19)], 0, 60) }),
            ("a test e-mail without the id", Args("notifyOperator", Operator)), ("an id on a job's verb", Args("disable", new ObjectRefDto("agentJob", Name: "j")) with { AgentIdentity = new(JobId), AgentObjectId = 1 })
        };
        foreach (var (name, args) in invalid) check(Answer(args) == "INVALID_PARAMS", "the AG-7 request is refused: " + name);
        string Describe(string dialog, ObjectRefDto target)
        {
            try { service.Validate(new ActionDescribeArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), dialog, target)); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(Describe("agentAlert", Alert) == "accepted" && Describe("agentAlert", AgentNode) == "accepted" && Describe("agentOperator", Operator) == "accepted" && Describe("agentOperator", AgentNode) == "accepted"
            && Describe("agentOperators", AgentNode) == "accepted" && Describe("deleteObject", Operator) == "accepted" && Describe("agentAlert", Operator) == "INVALID_PARAMS"
            && Describe("agentAlert", new ObjectRefDto("agent", Name: "x")) == "INVALID_PARAMS" && Describe("agentOperators", Operator) == "INVALID_PARAMS",
            "the alert and operator documents describe their object or the Agent node, and the grid the Agent node");
    }

    private static SqlException Exception(params (int Number, byte State, string Message)[] errors)
    {
        var collection = (SqlErrorCollection)Activator.CreateInstance(typeof(SqlErrorCollection), true)!;
        var add = typeof(SqlErrorCollection).GetMethod("Add", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!;
        foreach (var (number, state, message) in errors)
        {
            var constructor = typeof(SqlError).GetConstructors(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).First(candidate => candidate.GetParameters().Length >= 8);
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
        var batch = ActionService.AlertSavePlan(AlertSave(new(Name: "New", MessageId: 0, Severity: 17, NewOperators: [new("Taken")], Notifications: [new("Taken", 1, "add")]), AgentNode), AgentNode);
        check(service.ObjectSaveError(Exception((50010, 1, AgentSql.ObjectChangedMessage)), batch, null) is { Code: "NOT_FOUND" }, "the identity guard's 50010 is NOT_FOUND");
        check(service.ObjectSaveError(Exception((15281, 1, "Agent XPs")), batch, null) is { Code: "AGENT_STOPPED" }, "15281 is AGENT_STOPPED");
        var taken = service.ObjectSaveError(Exception((14261, 1, "The specified @name ('Taken') already exists."), (50012, 1, AgentSql.RefusedMessage)), batch, null);
        check(taken is { Code: "NAME_IN_USE" } && taken.Message.StartsWith("Saving creating operator 'Taken' was refused", StringComparison.Ordinal), "a refused inline operator says which one: " + taken.Message);
        var missing = service.ObjectSaveError(Exception((14262, 3, "The specified @operator_name ('Taken') does not exist."), (50012, 3, AgentSql.RefusedMessage)), batch, null);
        check(missing is { Code: "SQL_ERROR", Retryable: false } && missing.Message.Contains("notification of 'Taken' by 'New'", StringComparison.Ordinal), "a refused notification names its operator and alert, and msdb's missing name is not NOT_FOUND");
        var denied = service.ObjectSaveError(Exception((229, 1, "The EXECUTE permission was denied on the object 'sp_add_alert'.")), batch, null);
        check(denied is { Code: "PERMISSION_DENIED" } && denied.Message.StartsWith(ActionService.JobSaveAbortedMessage, StringComparison.Ordinal), "a refusal before any call's check is PERMISSION_DENIED and says nothing was saved");
    }

    private static void Script(Action<bool, string> check)
    {
        var script = ActionService.AgentObjectScript(AlertSave(new(Name: "It's new", MessageId: 0, Severity: 19, Notifications: [new("DBA", 1, "add")]), AgentNode), AgentNode);
        check(script.StartsWith("USE [msdb]\nGO\nBEGIN TRANSACTION", StringComparison.Ordinal) && script.Contains("EXEC @ReturnCode = msdb.dbo.sp_add_alert @name=N'It''s new', @message_id=0, @severity=19", StringComparison.Ordinal)
            && script.Contains("sp_add_notification @alert_name=N'It''s new', @operator_name=N'DBA', @notification_method=1", StringComparison.Ordinal) && script.Contains("GOTO QuitWithRollback", StringComparison.Ordinal),
            "the alert's script is SSMS's shape with quoted literals: " + script);
        var delete = ActionService.AgentObjectScript(Args("delete", Operator) with { CloseConnections = false, DeleteHistory = false, ReassignTo = "Backup" }, Operator);
        check(delete.Contains("sp_delete_operator @name=N'DBA '']'' team', @reassign_to_operator=N'Backup'", StringComparison.Ordinal), "Delete operator's script names the operator its notifications move to");
    }
}
