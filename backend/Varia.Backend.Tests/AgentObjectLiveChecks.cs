using System.Text.Json;
using Varia.Backend;

namespace Varia.Backend.Tests;

/// <summary>
/// Alerts and operators (AG-7) on scratch objects: New Operator's save, the operator document's describe and save, the tree's Rename to a
/// hostile name and back, Disable and Enable, and (where the platform has alerts) New Alert with an inline new operator and a
/// notification, an alert save that changes and drops notifications, and Delete operator with Reassign to moving them. Nothing sends
/// e-mail: the operators' addresses are .invalid and Send test e-mail is not run. Every object is dropped in finally and named so the
/// stale sweep finds it if the run dies.
/// </summary>
internal static class AgentObjectLiveChecks
{
    private static string Quote(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Said(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title)) + (result.Error is { } error ? " " + error.Code + " " + error.Message : "");

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, ScratchDatabase scratch, Func<string, string, Task<SqlRun>> sql)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        var agent = new ObjectRefDto("agent");
        var op = scratch.AgentObject("op");
        // A second operator for Reassign to: the same run's timestamp with its own id, so the sweep's pattern still matches it.
        var other = scratch.Name[..^8] + Guid.NewGuid().ToString("N")[..8] + "_op";
        var alert = scratch.AgentObject("al");
        Task<ActionExecuteResult> Execute(ActionArgs args) => Call<ActionExecuteResult>("actions.execute", args);
        ActionArgs Args(string action, ObjectRefDto target) => new(action, info.Id, Guid.NewGuid().ToString(), target);
        async Task<AgentOperatorDocumentDto?> Operator(string name) =>
            (await Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "agentOperator", new ObjectRefDto("agentOperator", Name: name)))).AgentOperatorDocument;
        async Task<string?> Scalar(string text) => (await sql(text, "msdb")).Scalar;
        try
        {
            var created = await Execute(Args("agentOperator", agent) with { AgentOperator = new(Name: op, Enabled: false, Email: "varia-test@example.invalid") });
            var read = await Operator(op);
            check(created.Error is null && read?.Operator is { Enabled: false, Email: "varia-test@example.invalid" } && read.Operator.Name == op,
                "New Operator's save creates the scratch operator, and the operator document describes it: " + Said(created) + " " + JsonSerializer.Serialize(read?.Operator));
            if (read?.Operator is not { } first) return;

            var saved = await Execute(Args("agentOperator", new ObjectRefDto("agentOperator", Name: op)) with { AgentObjectId = first.Id, AgentOperator = new(Pager: "varia-pager@example.invalid",
                PagerDays: 62, WeekdayStart: 80000, WeekdayEnd: 180000, SaturdayStart: 0, SaturdayEnd: 0, SundayStart: 0, SundayEnd: 0) });
            check(saved.Error is null && await Scalar("SELECT pager_address + N'|' + CONVERT(nvarchar(9), pager_days) FROM msdb.dbo.sysoperators WHERE name = " + Quote(op) + ";") == "varia-pager@example.invalid|62",
                "the operator document's save changes the pager address and duty: " + Said(saved));
            // The id guard: a save naming another id is refused and changes nothing.
            var wrong = await Execute(Args("agentOperator", new ObjectRefDto("agentOperator", Name: op)) with { AgentObjectId = first.Id + 100000, AgentOperator = new(Email: "other@example.invalid") });
            check(wrong.Error is { Code: "NOT_FOUND" } && await Scalar("SELECT email_address FROM msdb.dbo.sysoperators WHERE name = " + Quote(op) + ";") == "varia-test@example.invalid",
                "an operator save whose id is not the named operator's is refused NOT_FOUND and changes nothing: " + Said(wrong));

            var hostile = op + "]'; --é";
            var renamed = await Execute(Args("rename", new ObjectRefDto("agentOperator", Name: op)) with { NewName = hostile });
            var named = await Scalar("SELECT name FROM msdb.dbo.sysoperators WHERE id = " + first.Id + ";");
            var back = await Execute(Args("rename", new ObjectRefDto("agentOperator", Name: hostile)) with { NewName = op });
            if (await Scalar("SELECT name FROM msdb.dbo.sysoperators WHERE id = " + first.Id + ";") != op) await sql("EXEC msdb.dbo.sp_update_operator @name = " + Quote(hostile) + ", @new_name = " + Quote(op) + ";", "msdb");
            check(renamed.Error is null && named == hostile && back.Error is null, "Rename renames the operator to a hostile name and back: " + Said(renamed) + " " + Said(back));
            var enabled = await Execute(Args("enable", new ObjectRefDto("agentOperator", Name: op)));
            var on = await Scalar("SELECT CONVERT(nvarchar(1), enabled) FROM msdb.dbo.sysoperators WHERE name = " + Quote(op) + ";");
            var disabled = await Execute(Args("disable", new ObjectRefDto("agentOperator", Name: op)));
            check(enabled.Error is null && on == "1" && disabled.Error is null && await Scalar("SELECT CONVERT(nvarchar(1), enabled) FROM msdb.dbo.sysoperators WHERE name = " + Quote(op) + ";") == "0",
                "Enable and Disable on an operator row change it: " + Said(enabled) + " " + Said(disabled));

            if (read.Platform == "windows") await AlertsAsync(check, info, Call<ActionDescribeResult>, Execute, Args, Scalar, op, first.Id, other, alert);
        }
        finally
        {
            await sql("IF EXISTS (SELECT 1 FROM msdb.dbo.sysalerts WHERE name = " + Quote(alert) + ") EXEC msdb.dbo.sp_delete_alert @name = " + Quote(alert) + ";", "msdb");
            foreach (var name in new[] { op, op + "]'; --é", other })
                await sql("IF EXISTS (SELECT 1 FROM msdb.dbo.sysoperators WHERE name = " + Quote(name) + ") EXEC msdb.dbo.sp_delete_operator @name = " + Quote(name) + ";", "msdb");
        }
    }

    /// <summary>New Alert with an inline operator, an alert save that changes notifications, and Delete operator with Reassign to.</summary>
    private static async Task AlertsAsync(Action<bool, string> check, ConnectionInfo info, Func<string, object, Task<ActionDescribeResult>> call, Func<ActionArgs, Task<ActionExecuteResult>> execute,
        Func<string, ObjectRefDto, ActionArgs> args, Func<string, Task<string?>> scalar, string op, int opId, string other, string alert)
    {
        // Disabled, on severity 24 in msdb with a keyword of its own, so it never fires and no other alert has its condition.
        var created = await execute(args("agentAlert", new ObjectRefDto("agent")) with { AgentAlert = new(Name: alert, Enabled: false, MessageId: 0, Severity: 24, Database: "msdb", Keyword: alert,
            Delay: 600, IncludeIn: 1, NewOperators: [new(other, Email: "varia-other@example.invalid")], Notifications: [new(op, 1, "add"), new(other, 1, "add")]) });
        var count = await scalar("SELECT CONVERT(nvarchar(9), COUNT(*)) FROM msdb.dbo.sysnotifications AS n JOIN msdb.dbo.sysalerts AS a ON a.id = n.alert_id WHERE a.name = " + Quote(alert) + ";");
        var document = (await call("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "agentAlert", new ObjectRefDto("agentAlert", Name: alert)))).AgentAlertDocument;
        check(created.Error is null && count == "2" && document?.Alert is { Enabled: false, Severity: 24, Delay: 600 } && document.Notifications.Count == 2,
            "New Alert's save creates the alert, the inline new operator and both notifications in one transaction: " + Said(created) + " " + count);
        if (document?.Alert is not { } read) return;

        var changed = await execute(args("agentAlert", new ObjectRefDto("agentAlert", Name: alert)) with { AgentObjectId = read.Id, AgentAlert = new(Notifications: [new(op, 3, "update"), new(other, 0, "delete")]) });
        var methods = await scalar("SELECT CONVERT(nvarchar(9), n.notification_method) FROM msdb.dbo.sysnotifications AS n JOIN msdb.dbo.sysoperators AS o ON o.id = n.operator_id WHERE o.name = " + Quote(op) + ";");
        var dropped = await scalar("SELECT CONVERT(nvarchar(9), COUNT(*)) FROM msdb.dbo.sysnotifications AS n JOIN msdb.dbo.sysoperators AS o ON o.id = n.operator_id WHERE o.name = " + Quote(other) + ";");
        check(changed.Error is null && methods == "3" && dropped == "0", "an alert save updates one notification and deletes another: " + Said(changed) + " " + methods + " " + dropped);

        // A save whose later call fails commits nothing: the notification to an operator that does not exist fails after the delay's change.
        var failed = await execute(args("agentAlert", new ObjectRefDto("agentAlert", Name: alert)) with { AgentObjectId = read.Id, AgentAlert = new(Delay: 60, Notifications: [new("VariaNoSuchOperator_" + Guid.NewGuid().ToString("N")[..8], 1, "add")]) });
        check(failed.Error is not null && await scalar("SELECT CONVERT(nvarchar(9), delay_between_responses) FROM msdb.dbo.sysalerts WHERE name = " + Quote(alert) + ";") == "600",
            "an alert save whose later call fails commits nothing: " + Said(failed));

        // Delete operator with Reassign to: its notification moves to the other operator.
        var describe = (await call("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "deleteObject", new ObjectRefDto("agentOperator", Name: op)))).DeleteTarget;
        var deleted = await execute(args("delete", new ObjectRefDto("agentOperator", Name: op)) with { CloseConnections = false, DeleteHistory = false, AgentObjectId = opId, ReassignTo = other });
        var moved = await scalar("SELECT CONVERT(nvarchar(9), n.notification_method) FROM msdb.dbo.sysnotifications AS n JOIN msdb.dbo.sysoperators AS o ON o.id = n.operator_id JOIN msdb.dbo.sysalerts AS a ON a.id = n.alert_id WHERE o.name = " + Quote(other) + " AND a.name = " + Quote(alert) + ";");
        check(describe is { AgentObjectId: var id, NotifiedBy.Alerts: 1 } && id == opId && describe.ReassignChoices?.Contains(other) == true && deleted.Error is null && moved == "3"
            && await scalar("SELECT CONVERT(nvarchar(9), COUNT(*)) FROM msdb.dbo.sysoperators WHERE name = " + Quote(op) + ";") == "0",
            "Delete operator describes its notifications and the operators to move them to, and Reassign to moves them: " + Said(deleted) + " " + moved);

        var alertDeleted = await execute(args("delete", new ObjectRefDto("agentAlert", Name: alert)) with { CloseConnections = false, DeleteHistory = false, AgentObjectId = read.Id });
        check(alertDeleted.Error is null && await scalar("SELECT CONVERT(nvarchar(9), COUNT(*)) FROM msdb.dbo.sysalerts WHERE name = " + Quote(alert) + ";") == "0", "Delete on an alert deletes it: " + Said(alertDeleted));
    }
}
