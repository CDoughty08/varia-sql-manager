using System.Data;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Varia.Backend.Agent;

/// <summary>Which object an alert or operator batch acts on: none (New Alert, New Operator, Add recommended alerts), an existing alert, or an
/// existing operator.</summary>
internal enum AgentObjectHead { None, Alert, Operator }

/// <summary>One msdb call of an alert or operator batch: the procedure and its arguments in order, each with its value. Every argument is bound to
/// <c>@c&lt;index&gt;_&lt;argument&gt;</c>, except the object's own <c>@name</c> in a batch that resolved it, which is bound to <c>@name</c>.</summary>
internal sealed record AgentObjectCall(string Procedure, IReadOnlyList<(string Argument, object? Value)> Arguments);
/// <summary>An alert or operator batch: its text, the parameters it binds and the calls each THROW state names (index 1 is the first call).</summary>
internal sealed record AgentObjectBatch(string Text, IReadOnlyList<(AgentParameter Parameter, object? Value)> Parameters, IReadOnlyList<AgentObjectCall> Calls, AgentObjectHead Head);

/// <summary>Alerts and operators (AG-7, docs/agent-plan.md › Alerts and Operators): the documents' and the grid's reads (each in <see cref="All"/>
/// and so under <see cref="LintRead"/>) and every write, which is one batch of this shape: <see cref="ObjectHead"/> (for an existing alert or operator
/// it resolves the object by its name and the id its describe or the tree read, holding the row to the end of the transaction: 50010, NOT_FOUND),
/// then <c>EXEC @rc = msdb.dbo.&lt;procedure&gt; @arg = @c&lt;index&gt;_&lt;arg&gt;, …;</c> calls of the AG-7 procedures and arguments the catalogue lists,
/// each followed by <see cref="CheckAt"/>, whose THROW state is the call's index. <see cref="LintObjectBatch"/> admits nothing else.</summary>
internal static partial class AgentSql
{
    /// <summary>The identity guard's message for an alert or operator (50010, NOT_FOUND).</summary>
    public const string ObjectChangedMessage = "This is not the alert or operator that was read: it was deleted or replaced since. Refresh and try again.";

    internal const string ObjectNewHead = "DECLARE @rc int;\n";
    internal const string AlertResolve = "DECLARE @rc int, @target_id int;\n"
        + "SELECT @target_id = a.id FROM msdb.dbo.sysalerts AS a WITH (UPDLOCK, HOLDLOCK) WHERE a.name = @name AND a.id = @expected_id;\n"
        + "IF @target_id IS NULL THROW 50010, N'" + ObjectChangedMessage + "', 1;\n";
    internal const string OperatorResolve = "DECLARE @rc int, @target_id int;\n"
        + "SELECT @target_id = o.id FROM msdb.dbo.sysoperators AS o WITH (UPDLOCK, HOLDLOCK) WHERE o.name = @name AND o.id = @expected_id;\n"
        + "IF @target_id IS NULL THROW 50010, N'" + ObjectChangedMessage + "', 1;\n";
    internal static string ObjectHead(AgentObjectHead head) => head switch { AgentObjectHead.Alert => AlertResolve, AgentObjectHead.Operator => OperatorResolve, _ => ObjectNewHead };

    private static readonly AgentParameter ExpectedObjectIdParameter = new("@expected_id", SqlDbType.Int);

    /// <summary>Every argument an AG-7 procedure takes from Varia, with its SQL type and size (msdb's own declarations).</summary>
    internal static readonly IReadOnlyDictionary<string, (SqlDbType Type, int Size)> ObjectArgumentTypes = new Dictionary<string, (SqlDbType, int)>(StringComparer.Ordinal)
    {
        ["@name"] = (SqlDbType.NVarChar, 128), ["@new_name"] = (SqlDbType.NVarChar, 128), ["@enabled"] = (SqlDbType.TinyInt, 0), ["@message_id"] = (SqlDbType.Int, 0),
        ["@severity"] = (SqlDbType.Int, 0), ["@delay_between_responses"] = (SqlDbType.Int, 0), ["@notification_message"] = (SqlDbType.NVarChar, 512),
        ["@include_event_description_in"] = (SqlDbType.TinyInt, 0), ["@database_name"] = (SqlDbType.NVarChar, 128), ["@event_description_keyword"] = (SqlDbType.NVarChar, 100),
        ["@job_id"] = (SqlDbType.UniqueIdentifier, 0), ["@occurrence_count"] = (SqlDbType.Int, 0), ["@performance_condition"] = (SqlDbType.NVarChar, 512),
        ["@email_address"] = (SqlDbType.NVarChar, 100), ["@pager_address"] = (SqlDbType.NVarChar, 100), ["@netsend_address"] = (SqlDbType.NVarChar, 100),
        ["@weekday_pager_start_time"] = (SqlDbType.Int, 0), ["@weekday_pager_end_time"] = (SqlDbType.Int, 0), ["@saturday_pager_start_time"] = (SqlDbType.Int, 0),
        ["@saturday_pager_end_time"] = (SqlDbType.Int, 0), ["@sunday_pager_start_time"] = (SqlDbType.Int, 0), ["@sunday_pager_end_time"] = (SqlDbType.Int, 0),
        ["@count_reset_date"] = (SqlDbType.Int, 0), ["@count_reset_time"] = (SqlDbType.Int, 0),
        ["@pager_days"] = (SqlDbType.TinyInt, 0), ["@reassign_to_operator"] = (SqlDbType.NVarChar, 128), ["@alert_name"] = (SqlDbType.NVarChar, 128),
        ["@operator_name"] = (SqlDbType.NVarChar, 128), ["@notification_method"] = (SqlDbType.TinyInt, 0), ["@profile_name"] = (SqlDbType.NVarChar, 128),
        ["@subject"] = (SqlDbType.NVarChar, 256), ["@body"] = (SqlDbType.NVarChar, 4000)
    };

    /// <summary>The procedures an alert or operator batch may call, and the arguments each must pass.</summary>
    internal static readonly IReadOnlyDictionary<string, string[]> ObjectProcedures = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["sp_add_alert"] = ["@name"], ["sp_update_alert"] = ["@name"], ["sp_delete_alert"] = ["@name"],
        ["sp_add_operator"] = ["@name"], ["sp_update_operator"] = ["@name"], ["sp_delete_operator"] = ["@name"],
        ["sp_add_notification"] = ["@alert_name", "@operator_name", "@notification_method"], ["sp_update_notification"] = ["@alert_name", "@operator_name", "@notification_method"],
        ["sp_delete_notification"] = ["@alert_name", "@operator_name"], ["sp_notify_operator"] = ["@profile_name", "@name", "@subject", "@body"]
    };
    private static readonly HashSet<string> NotificationProcedures = new(["sp_add_notification", "sp_update_notification", "sp_delete_notification"], StringComparer.Ordinal);

    /// <summary>A call's parameter for <paramref name="argument"/>: <c>@c&lt;index&gt;_&lt;argument&gt;</c>.</summary>
    internal static string ObjectValue(int index, string argument) => "@c" + index.ToString(CultureInfo.InvariantCulture) + "_" + argument[1..];
    /// <summary>Whether a call's <c>@name</c> is the object the head resolved: the object's own procedure in a resolved batch.</summary>
    private static bool OwnName(AgentObjectHead head, string procedure, string argument) => argument == "@name" && head switch
    {
        AgentObjectHead.Alert => procedure is "sp_update_alert" or "sp_delete_alert",
        AgentObjectHead.Operator => procedure is "sp_update_operator" or "sp_delete_operator" or "sp_notify_operator",
        _ => false
    };

    /// <summary>The batch for <paramref name="calls"/> under <paramref name="head"/>; <paramref name="name"/> and <paramref name="id"/> bind a resolved
    /// head's guard (and the object's own <c>@name</c>).</summary>
    public static AgentObjectBatch ObjectBatch(AgentObjectHead head, IReadOnlyList<AgentObjectCall> calls, string? name = null, int? id = null)
    {
        if (calls.Count == 0 || calls.Count > CallIndexLimit) throw new InvalidOperationException("An alert or operator batch makes 1 to 255 calls.");
        var text = new StringBuilder(ObjectHead(head));
        var parameters = new List<(AgentParameter, object?)>();
        if (head != AgentObjectHead.None) parameters.AddRange([(NameParameter, name), (ExpectedObjectIdParameter, id)]);
        for (var i = 0; i < calls.Count; i++)
        {
            var call = calls[i];
            var parts = new List<string>();
            foreach (var (argument, value) in call.Arguments)
            {
                if (OwnName(head, call.Procedure, argument)) { parts.Add("@name = @name"); continue; }
                var (type, size) = ObjectArgumentTypes[argument];
                var parameter = new AgentParameter(ObjectValue(i + 1, argument), type, size);
                parts.Add(argument + " = " + parameter.Name);
                parameters.Add((parameter, value));
            }
            text.Append("EXEC @rc = msdb.dbo.").Append(call.Procedure).Append(' ').Append(string.Join(", ", parts)).Append(';').Append(CheckAt(i + 1));
        }
        return new(text.ToString(), parameters, calls, head);
    }

    [GeneratedRegex(@"^EXEC @rc = msdb\.dbo\.(?<proc>\w+) (?<arg>@\w+) = (?<value>@\w+)(?:, (?<arg>@\w+) = (?<value>@\w+))*;$", RegexOptions.CultureInvariant)]
    private static partial Regex ObjectCall();

    /// <summary>Problems with an alert or operator batch's full text; empty when it passes. It opens with <see cref="ObjectNewHead"/>,
    /// <see cref="AlertResolve"/> or <see cref="OperatorResolve"/> exactly; each call is one msdb call of <see cref="ObjectProcedures"/> with arguments
    /// the catalogue lists for it, each once and bound to its own <c>@c&lt;index&gt;_</c> parameter (the resolved object's own <c>@name</c> to
    /// <c>@name</c>, which a resolved batch's own procedure must pass), followed by <see cref="CheckAt"/> with its index. A new object's batch adds and
    /// notifies only; an alert's batch touches no other alert and an operator's no other operator; sp_delete_* and sp_notify_operator stand alone.</summary>
    public static List<string> LintObjectBatch(string text, AgentCatalog? catalog = null)
    {
        catalog ??= AgentCatalog.Current;
        var problems = new List<string>();
        if (text.Contains("xp_servicecontrol", StringComparison.OrdinalIgnoreCase)) problems.Add("uses xp_servicecontrol");
        AgentObjectHead head;
        if (text.StartsWith(AlertResolve, StringComparison.Ordinal)) head = AgentObjectHead.Alert;
        else if (text.StartsWith(OperatorResolve, StringComparison.Ordinal)) head = AgentObjectHead.Operator;
        else if (text.StartsWith(ObjectNewHead, StringComparison.Ordinal)) head = AgentObjectHead.None;
        else { problems.Add("does not open with a new object's declaration or an alert's or operator's identity guard"); return problems; }
        var rest = text[ObjectHead(head).Length..];
        var procedures = new List<string>();
        for (var index = 1; rest.Length > 0; index++)
        {
            if (index > CallIndexLimit) { problems.Add("makes more than 255 calls"); return problems; }
            var end = rest.IndexOf('\n', StringComparison.Ordinal);
            if (end < 0) { problems.Add("call " + index + " is not followed by its return-code check"); return problems; }
            var call = rest[..end];
            rest = rest[end..];
            var check = CheckAt(index);
            if (!rest.StartsWith(check, StringComparison.Ordinal)) { problems.Add("call " + index + " is not followed by its return-code check"); return problems; }
            rest = rest[check.Length..];
            var match = ObjectCall().Match(call);
            if (!match.Success) { problems.Add("call " + index + " is not one msdb call in the alert and operator shape"); return problems; }
            var procedure = match.Groups["proc"].Value;
            procedures.Add(procedure);
            if (!ObjectProcedures.TryGetValue(procedure, out var required) || !catalog.WriteArguments.TryGetValue(procedure, out var allowed)) { problems.Add("EXECs " + procedure + ", which an alert or operator batch does not call"); continue; }
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 0; i < match.Groups["arg"].Captures.Count; i++)
            {
                var argument = match.Groups["arg"].Captures[i].Value;
                var value = match.Groups["value"].Captures[i].Value;
                if (!allowed.Contains(argument)) problems.Add("passes " + argument + " to " + procedure);
                if (!seen.Add(argument)) problems.Add("passes " + argument + " twice");
                var expected = OwnName(head, procedure, argument) ? "@name" : ObjectValue(index, argument);
                if (value != expected) problems.Add("passes " + argument + " another parameter's value");
            }
            foreach (var argument in required) if (!seen.Contains(argument)) problems.Add(procedure + " does not pass " + argument);
        }
        if (procedures.Count == 0) { problems.Add("makes no call"); return problems; }
        bool Only(params string[] allowed) => procedures.All(procedure => allowed.Contains(procedure) || NotificationProcedures.Contains(procedure));
        var alone = procedures.FirstOrDefault(procedure => procedure is "sp_delete_alert" or "sp_delete_operator" or "sp_notify_operator");
        if (alone is not null && procedures.Count != 1) problems.Add(alone + " does not stand alone");
        switch (head)
        {
            case AgentObjectHead.None:
                if (!Only("sp_add_alert", "sp_add_operator") || procedures.Any(procedure => procedure is "sp_update_notification" or "sp_delete_notification")) problems.Add("a new object's batch does more than add and notify");
                break;
            case AgentObjectHead.Alert:
                if (!Only("sp_update_alert", "sp_delete_alert", "sp_add_operator") || procedures.Count(procedure => procedure == "sp_update_alert") > 1) problems.Add("an alert's batch touches another alert, or updates it twice");
                break;
            case AgentObjectHead.Operator:
                if (!Only("sp_update_operator", "sp_delete_operator", "sp_notify_operator") || procedures.Count(procedure => procedure == "sp_update_operator") > 1) problems.Add("an operator's batch touches another operator, or updates it twice");
                break;
        }
        return problems;
    }

    /// <summary>The alert and operator batches in their shapes, each with every argument the catalogue lists, under <see cref="LintObjectBatch"/>,
    /// each binding exactly the parameters it uses.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> LintObjectBatches(AgentCatalog? catalog = null)
    {
        catalog ??= AgentCatalog.Current;
        AgentObjectCall Every(string procedure) => new(procedure, [.. catalog.WriteArguments[procedure].Select(argument => (argument, (object?)null))]);
        var batches = new (string Name, AgentObjectBatch Batch)[]
        {
            ("new alert", ObjectBatch(AgentObjectHead.None, [Every("sp_add_operator"), Every("sp_add_alert"), Every("sp_add_notification")])),
            ("alert update", ObjectBatch(AgentObjectHead.Alert, [Every("sp_add_operator"), Every("sp_update_alert"), Every("sp_add_notification"), Every("sp_update_notification"), Every("sp_delete_notification")], "a", 1)),
            ("alert delete", ObjectBatch(AgentObjectHead.Alert, [Every("sp_delete_alert")], "a", 1)),
            ("new operator", ObjectBatch(AgentObjectHead.None, [Every("sp_add_operator"), Every("sp_add_notification")])),
            ("operator update", ObjectBatch(AgentObjectHead.Operator, [Every("sp_update_operator"), Every("sp_add_notification"), Every("sp_update_notification"), Every("sp_delete_notification")], "o", 1)),
            ("operator delete", ObjectBatch(AgentObjectHead.Operator, [Every("sp_delete_operator")], "o", 1)),
            ("operator test mail", ObjectBatch(AgentObjectHead.Operator, [Every("sp_notify_operator")], "o", 1)),
            ("recommended alerts", ObjectBatch(AgentObjectHead.None, [Every("sp_add_alert"), Every("sp_add_notification"), Every("sp_add_alert")]))
        };
        foreach (var (name, batch) in batches)
        {
            var problems = LintObjectBatch(batch.Text, catalog);
            var code = Literal().Replace(batch.Text, "''");
            var used = Variable().Matches(code).Select(match => match.Value).Where(variable => variable is not ("@rc" or "@target_id")).ToHashSet(StringComparer.Ordinal);
            var values = Variable().Matches(Regex.Replace(code, @"@\w+ = (?=@)", "= ")).Select(match => match.Value).Where(variable => variable is not ("@rc" or "@target_id")).ToHashSet(StringComparer.Ordinal);
            var bound = batch.Parameters.Select(parameter => parameter.Parameter.Name).ToHashSet(StringComparer.Ordinal);
            if (bound.Count != batch.Parameters.Count) problems.Add("binds a parameter twice");
            foreach (var variable in values.Except(bound)) problems.Add("binds the undeclared " + variable);
            foreach (var variable in bound.Except(used)) problems.Add("declares the unused " + variable);
            yield return ("object batch " + name, problems);
        }
    }

    // --- Reads ---------------------------------------------------------------------------------------------------------------

    private static readonly string[] AlertDocumentColumns = ["id", "name", "enabled", "message_id", "severity", "database_name", "event_description_keyword", "performance_condition",
        "wmi_namespace", "wmi_query", "job_id", "job_name", "delay_between_responses", "include_event_description", "notification_message", "occurrence_count",
        "last_occurrence_date", "last_occurrence_time", "last_response_date", "last_response_time", "count_reset_date", "count_reset_time", "type"];
    /// <summary>One alert with everything the alert document shows (SQLAgentOperatorRole and sysadmin).</summary>
    public static readonly AgentStatement AlertDocument = new("alertDocument", "EXEC msdb.dbo.sp_help_alert @alert_id = @alert_id;", AlertDocumentColumns, [new("@alert_id", SqlDbType.Int)], "listRows");
    /// <summary>Every alert with its type, for the grid and an operator's Notifications list.</summary>
    public static readonly AgentStatement AlertRows = new("alertRows", "EXEC msdb.dbo.sp_help_alert;", ["id", "name", "enabled", "message_id", "severity", "type"], [], "alertRows");
    /// <summary>An alert's id by name, for the document's describe, the tree's verbs and Delete Object (sysalerts by name; SQLAgentOperatorRole and
    /// sysadmin read it through msdb's grants, others are refused, which the describe reports).</summary>
    public const string AlertByName = "SELECT a.id, a.name FROM msdb.dbo.sysalerts AS a WHERE a.name = @name;";
    /// <summary>An operator's id by name (sysoperators is readable by every Agent role through msdb's grants).</summary>
    public const string OperatorByName = "SELECT o.id, o.name FROM msdb.dbo.sysoperators AS o WHERE o.name = @name;";
    private static readonly string[] OperatorDocumentColumns = ["id", "name", "enabled", "email_address", "pager_address", "netsend_address", "weekday_pager_start_time", "weekday_pager_end_time",
        "saturday_pager_start_time", "saturday_pager_end_time", "sunday_pager_start_time", "sunday_pager_end_time", "pager_days", "last_email_date", "last_email_time",
        "last_pager_date", "last_pager_time", "last_netsend_date", "last_netsend_time"];
    /// <summary>Every operator with its addresses, pager duty and when it was last notified.</summary>
    public static readonly AgentStatement OperatorRows = new("operatorRows", "EXEC msdb.dbo.sp_help_operator;", OperatorDocumentColumns, [], "operatorRows");
    /// <summary>One operator by id (the operator document), so an operator past the listing's cap still opens.</summary>
    public static readonly AgentStatement OperatorDocument = new("operatorDocument", "EXEC msdb.dbo.sp_help_operator @operator_id = @operator_id;", OperatorDocumentColumns, [new("@operator_id", SqlDbType.Int)], "listRows");
    /// <summary>Every notification (alert, operator, methods), for SQLAgentOperatorRole and sysadmin.</summary>
    public static readonly AgentStatement Notifications = new("notifications", "SELECT n.alert_id, n.operator_id, n.notification_method FROM msdb.dbo.sysnotifications AS n;",
        ["alert_id", "operator_id", "notification_method"], [], "listRows");
    /// <summary>One alert's notifications with each operator's name (the alert document), so none depends on the capped operator listing.</summary>
    public static readonly AgentStatement AlertNotifications = new("alertNotifications",
        "SELECT n.alert_id, n.operator_id, n.notification_method, o.name AS operator_name FROM msdb.dbo.sysnotifications AS n JOIN msdb.dbo.sysoperators AS o ON o.id = n.operator_id WHERE n.alert_id = @alert_id;",
        ["alert_id", "operator_id", "notification_method", "operator_name"], [new("@alert_id", SqlDbType.Int)], "listRows");
    /// <summary>One operator's notifications (the operator document and Delete Object's count).</summary>
    public static readonly AgentStatement OperatorNotifications = new("operatorNotifications", "SELECT n.alert_id, n.operator_id, n.notification_method FROM msdb.dbo.sysnotifications AS n WHERE n.operator_id = @operator_id;",
        ["alert_id", "operator_id", "notification_method"], [new("@operator_id", SqlDbType.Int)], "listRows");
    /// <summary>The jobs that notify an operator, by the operators' names (sysjobs_view filters by role itself).</summary>
    public static readonly AgentStatement JobNotifications = new("jobNotifications",
        "SELECT j.job_id, j.name, e.name AS email_operator, p.name AS page_operator, s.name AS netsend_operator FROM msdb.dbo.sysjobs_view AS j\n"
        + "LEFT JOIN msdb.dbo.sysoperators AS e ON e.id = j.notify_email_operator_id AND j.notify_level_email > 0\n"
        + "LEFT JOIN msdb.dbo.sysoperators AS p ON p.id = j.notify_page_operator_id AND j.notify_level_page > 0\n"
        + "LEFT JOIN msdb.dbo.sysoperators AS s ON s.id = j.notify_netsend_operator_id AND j.notify_level_netsend > 0\n"
        + "WHERE e.id IS NOT NULL OR p.id IS NOT NULL OR s.id IS NOT NULL;", ["job_id", "name", "email_operator", "page_operator", "netsend_operator"], [], "listRows");
    /// <summary>The jobs an alert may run: every job the login may see, by id and name.</summary>
    public static readonly AgentStatement AlertJobs = new("alertJobs", "SELECT j.job_id, j.name FROM msdb.dbo.sysjobs_view AS j ORDER BY j.name;", ["job_id", "name"], [], "listRows");
    /// <summary>The databases an event alert may be restricted to.</summary>
    public static readonly AgentStatement AlertDatabases = new("alertDatabases", "SELECT d.name FROM sys.databases AS d ORDER BY d.name;", ["name"], [], "listRows");
    /// <summary>The performance counters (object and counter, without the instance's own prefix) a condition may name; VIEW SERVER STATE.</summary>
    public static readonly AgentStatement Counters = new("counters",
        "SELECT DISTINCT RTRIM(c.object_name) AS object_name, RTRIM(c.counter_name) AS counter_name FROM sys.dm_os_performance_counters AS c ORDER BY object_name, counter_name;",
        ["object_name", "counter_name"], [], "counterRows");
    /// <summary>One counter's current value per instance (the alert document's "Now on"), and the server's clock; VIEW SERVER STATE. The object is
    /// matched with or without the instance's own prefix (SQLServer: or MSSQL$NAME:), as SQL Server Agent itself does.</summary>
    public static readonly AgentStatement CounterValues = new("counterValues",
        "SELECT RTRIM(c.instance_name) AS instance_name, c.cntr_value, CONVERT(char(19), SYSDATETIME(), 126) AS read_at FROM sys.dm_os_performance_counters AS c\n"
        + "WHERE RTRIM(c.counter_name) = @counter AND (RTRIM(c.object_name) = @object OR SUBSTRING(RTRIM(c.object_name), CHARINDEX(N':', c.object_name) + 1, 128) = SUBSTRING(@object, CHARINDEX(N':', @object) + 1, 128))\n"
        + "ORDER BY instance_name;", ["instance_name", "cntr_value", "read_at"], [new("@object", SqlDbType.NVarChar, 128), new("@counter", SqlDbType.NVarChar, 128)], "counterInstances");
    /// <summary>The English text of an error number, for the alert's "Raises on" line.</summary>
    public static readonly AgentStatement MessageText = new("messageText", "SELECT m.text FROM sys.messages AS m WHERE m.message_id = @message_id AND m.language_id = 1033;",
        ["text"], [new("@message_id", SqlDbType.Int)], "listRows");

    /// <summary>The ad hoc reads alerts and operators run outside the reader, under <see cref="LintRead"/>, and every batch under <see cref="LintObjectBatch"/>.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> LintObjectWrites()
    {
        yield return ("alert by name", LintRead(AlertByName, null));
        yield return ("operator by name", LintRead(OperatorByName, null));
        foreach (var item in LintObjectBatches()) yield return item;
    }
}
