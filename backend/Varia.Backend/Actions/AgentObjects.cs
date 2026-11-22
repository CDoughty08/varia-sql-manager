using System.Data;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using Microsoft.Data.SqlClient;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;

namespace Varia.Backend.Actions;

/// <summary>SQL Server Agent alerts and operators (AG-7, docs/agent-plan.md › Alerts and Operators, docs/sql-server-agent.md). The alert and operator
/// documents' Save are the actions <c>agentAlert</c> and <c>agentOperator</c>; the tree's Enable, Disable, Rename and Delete on an alert or operator,
/// Add recommended alerts (<c>addRecommendedAlerts</c>) and Send test e-mail (<c>notifyOperator</c>) run here too. Every write is one batch in one
/// transaction (<see cref="AgentSql.ObjectBatch"/>): an existing object's opens with its identity guard (name and id, 50010), and each call is followed by
/// its return-code check, whose THROW state names the call that failed. Alerts are SQL Server on Windows only; Linux and Managed Instance refuse
/// them as NOT_SUPPORTED before anything runs. Only sysadmin may write alerts and operators: msdb refuses the others (PERMISSION_DENIED), and the
/// documents open read-only for them.</summary>
internal sealed partial class ActionService
{
    internal const string AddRecommendedAlertsAction = "addRecommendedAlerts";
    internal const string NotifyOperatorAction = "notifyOperator";
    internal const string AlertsUnsupportedMessage = "SQL Server Agent alerts are not available on Linux or Azure SQL Managed Instance.";
    internal const string AlertReadOnlyMessage = "Read-only. SQL Server Agent's roles may view alerts, not change them; only sysadmin can.";
    internal const string NotificationsUnreadMessage = "Read-only. The notifications could not be read; Reload to try again.";
    internal const string NotificationsTruncatedMessage = "Read-only. The server has more notifications than Varia reads at once; change them in each alert or operator.";
    internal const string OperatorReadOnlyMessage = "Read-only. SQL Server Agent's roles may view operators, not change them; only sysadmin can.";
    internal const string NoAgentProfileMessage = "SQL Server Agent has no Database Mail profile, so it cannot send e-mail. Set one in SQL Server Agent Properties › Alert System.";
    internal const string TestMailSubject = "Varia test e-mail from SQL Server Agent";
    internal const string TestMailBody = "This is a test message sent from Varia SQL Manager through SQL Server Agent's Database Mail profile. No action is needed.";
    private static readonly IReadOnlySet<string> AgentObjectVerbs = new HashSet<string>(["disable", "enable", "rename", "delete"], StringComparer.Ordinal);

    private static bool AgentObjectKind(string? kind) => kind is "agentAlert" or "agentOperator";
    private static bool AgentRoot(ObjectRefDto? target) => target is { Kind: "agent", Name: null, Database: null, Schema: null, Parent: null, SsisFolder: null, SsisProject: null };

    // --- Validate ------------------------------------------------------------------------------------------------------------

    /// <summary>Re-validates the AG-7 requests (src/shared/actions/schema.ts agentAlertRequestSchema, agentOperatorRequestSchema, the alert and operator
    /// branches of rename, delete and loginState; agent-alert.ts addRecommendedAlertsRequestSchema; agent-operator.ts notifyOperatorRequestSchema). Null
    /// for any other request, after refusing the AG-7 members on it.</summary>
    private ObjectRefDto? ValidateAgentObjects(ActionArgs args, bool script)
    {
        var mine = args.Action is "agentAlert" or "agentOperator" or AddRecommendedAlertsAction or NotifyOperatorAction || AgentObjectKind(args.Target?.Kind);
        if (!mine)
        {
            if (args.AgentAlert is not null || args.AgentOperator is not null || args.AgentRecommended is not null || args.AgentObjectId is not null || args.ReassignTo is not null)
                throw Invalid(args.Action + " takes no alert or operator members.");
            return null;
        }
        if (args.AgentObjectId is < 1) throw Invalid("agentObjectId.");
        var bare = new ActionArgs(args.Action, args.ConnectionId, args.RequestId, args.Target!);
        var limits = AgentCatalog.Current;
        var names = (int)limits.Limit("nameChars");
        switch (args.Action)
        {
            case "agentAlert" or "agentOperator":
            {
                var create = args.Target is { Kind: "agent" };
                ObjectRefDto target;
                if (create)
                {
                    if (!AgentRoot(args.Target)) throw Invalid("target.");
                    target = Target(args.Target, "agentProperties");
                    if (args.AgentObjectId is not null) throw Invalid("a new alert or operator has no id.");
                }
                else
                {
                    if (args.Target?.Kind != (args.Action == "agentAlert" ? "agentAlert" : "agentOperator")) throw Invalid("target.");
                    target = Target(args.Target, args.Action);
                    if (args.AgentObjectId is null && !script) throw Invalid("agentObjectId.");
                }
                if (args with { AgentAlert = null, AgentOperator = null, AgentObjectId = null } != bare) throw Invalid(args.Action + " takes only its save and the object's id.");
                if (args.Action == "agentAlert") { if (args.AgentOperator is not null || args.AgentAlert is not { } alert || !AlertSaveValid(alert, create, names) || !create && alert.Name == args.Target?.Name) throw Invalid("agentAlert."); }
                else if (args.AgentAlert is not null || args.AgentOperator is not { } saved || !OperatorSaveValid(saved, create, names) || !create && saved.Name == args.Target?.Name) throw Invalid("agentOperator.");
                return target;
            }
            case AddRecommendedAlertsAction:
            {
                if (!AgentRoot(args.Target)) throw Invalid("target.");
                if (args with { AgentRecommended = null } != bare) throw Invalid(args.Action + " takes only agentRecommended.");
                if (args.AgentRecommended is not { } recommended || !RecommendedValid(recommended, names)) throw Invalid("agentRecommended.");
                return Target(args.Target, "agentProperties");
            }
            case NotifyOperatorAction:
            {
                if (script) throw Invalid(args.Action + " has no script.");
                if (args.Target is not { Kind: "agentOperator" } || args.AgentObjectId is null || args with { AgentObjectId = null } != bare) throw Invalid(args.Action + " takes only the operator and its id.");
                return Target(args.Target, "agentOperator");
            }
        }
        // The tree's verbs on an alert or operator row.
        if (!AgentObjectVerbs.Contains(args.Action) || !AgentObjectKind(args.Target?.Kind)) throw Invalid("target.");
        var row = Target(args.Target, args.Action);
        var rest = args with { NewName = null, CloseConnections = null, DeleteHistory = null, AgentObjectId = null, ReassignTo = null };
        if (rest != bare) throw Invalid(args.Action + " on an alert or operator takes no such member.");
        switch (args.Action)
        {
            case "rename":
                if (!ExplorerRefs.Ident(args.NewName, names) || string.Equals(args.NewName, row.Name, StringComparison.Ordinal)) throw Invalid("newName.");
                if (args.CloseConnections is not null || args.DeleteHistory is not null || args.AgentObjectId is not null || args.ReassignTo is not null) throw Invalid("rename takes only the new name.");
                break;
            case "delete":
                if (args.NewName is not null || args.CloseConnections is not false || args.DeleteHistory is not false) throw Invalid("an alert's or operator's delete takes closeConnections and deleteHistory false.");
                if (args.AgentObjectId is null && !script) throw Invalid("agentObjectId.");
                if (args.ReassignTo is { } to && (row.Kind != "agentOperator" || !ExplorerRefs.Ident(to, names) || string.Equals(to, row.Name, StringComparison.Ordinal))) throw Invalid("reassignTo.");
                break;
            default:
                if (args.NewName is not null || args.CloseConnections is not null || args.DeleteHistory is not null || args.AgentObjectId is not null || args.ReassignTo is not null) throw Invalid(args.Action + " takes only the object.");
                break;
        }
        return row;
    }

    private static bool Text(string? value, long max) => value is null || (value.Length <= max && !value.Contains('\0'));
    private static bool Methods(int value) => value is >= 0 and <= 7;
    private static bool DutyTime(int? value) => value is not { } time || (time is >= 0 and <= 235959 && time % 100 < 60 && time / 100 % 100 < 60);

    private static bool NotificationsValid(List<AgentNotificationChangeDto>? changes, int names)
    {
        if (changes is null) return true;
        if (changes.Count == 0 || changes.Count > AgentCatalog.Current.Limit("notificationChanges")) return false;
        if (changes.Select(change => change.Name).Distinct(StringComparer.Ordinal).Count() != changes.Count) return false;
        return changes.All(change => ExplorerRefs.Ident(change.Name, names) && Methods(change.Methods) && change.Change is "add" or "update" or "delete" && (change.Change == "delete") == (change.Methods == 0));
    }

    /// <summary>agent-alert.ts agentAlertSaveSchema and agentAlertSaveProblems.</summary>
    internal static bool AlertSaveValid(AgentAlertSaveDto save, bool create, int names)
    {
        var limits = AgentCatalog.Current;
        if (save.Name is not null && !ExplorerRefs.Ident(save.Name, names)) return false;
        if (save.MessageId is < 0 || save.Severity is < 0 or > 25 || save.Delay is < 0 || save.Delay > limits.Limit("alertDelaySeconds") || save.IncludeIn is { } include && !Methods(include)) return false;
        if (save.Database is { Length: > 0 } database && !ExplorerRefs.Ident(database, names)) return false;
        if (!Text(save.Database, names) || !Text(save.Keyword, limits.Limit("alertKeywordChars")) || !Text(save.Message, limits.Limit("alertMessageChars"))) return false;
        if (save.Condition is { } condition && (!Text(condition, limits.Limit("conditionChars")) || condition.Split('|') is not { Length: 5 } parts || parts[3] is not (">" or "<" or "="))) return false;
        if (save.JobId is { Length: > 0 } job && !AgentJobId(job)) return false;
        if (save.ResetCount is false) return false;
        if (save.NewOperators is { } added && (added.Count == 0 || added.Count > limits.Limit("newOperators") || added.Select(item => item.Name).Distinct(StringComparer.Ordinal).Count() != added.Count
            || added.Any(item => !ExplorerRefs.Ident(item.Name, names) || !Text(item.Email, limits.Limit("addressChars")) || !Text(item.Pager, limits.Limit("addressChars")))
            || added.Any(item => save.Notifications?.Any(change => change.Name == item.Name && change.Change == "add") != true))) return false;
        if (!NotificationsValid(save.Notifications, names)) return false;
        if (save.MessageId is null != save.Severity is null) return false;
        if (save.MessageId is { } message && save.Condition is null && (message == 0) == (save.Severity == 0)) return false;
        if (save.Condition is not null && (save.MessageId ?? 0) + (save.Severity ?? 0) != 0) return false;
        if (create) return save.Name is not null && save.ResetCount is null && (save.Condition is not null || save.MessageId is not null);
        return save != new AgentAlertSaveDto();
    }

    /// <summary>agent-operator.ts agentOperatorSaveSchema and agentOperatorSaveProblems.</summary>
    internal static bool OperatorSaveValid(AgentOperatorSaveDto save, bool create, int names)
    {
        var address = AgentCatalog.Current.Limit("addressChars");
        if (save.Name is not null && !ExplorerRefs.Ident(save.Name, names)) return false;
        if (!Text(save.Email, address) || !Text(save.Pager, address) || !Text(save.NetSend, address)) return false;
        int?[] duty = [save.PagerDays, save.WeekdayStart, save.WeekdayEnd, save.SaturdayStart, save.SaturdayEnd, save.SundayStart, save.SundayEnd];
        if (duty.Count(value => value is not null) is not (0 or 7)) return false;
        if (save.PagerDays is < 0 or > 127 || !duty.Skip(1).All(DutyTime)) return false;
        if (!NotificationsValid(save.Notifications, names)) return false;
        if (create) return save.Name is not null;
        return save != new AgentOperatorSaveDto();
    }

    /// <summary>agent-alert.ts agentRecommendedSchema.</summary>
    internal static bool RecommendedValid(AgentRecommendedDto recommended, int names)
    {
        var limits = AgentCatalog.Current;
        if (recommended.Alerts is not { Count: > 0 } alerts || alerts.Count > limits.Limit("recommendedAlerts")) return false;
        if (alerts.Select(alert => alert.Name).Distinct(StringComparer.Ordinal).Count() != alerts.Count) return false;
        if (alerts.Any(alert => !ExplorerRefs.Ident(alert.Name, names) || alert.MessageId < 0 || alert.Severity is < 0 or > 25 || (alert.MessageId == 0) == (alert.Severity == 0))) return false;
        if (!Methods(recommended.Methods) || recommended.Delay < 0 || recommended.Delay > limits.Limit("alertDelaySeconds")) return false;
        return recommended.Operator is null ? recommended.Methods == 0 : ExplorerRefs.Ident(recommended.Operator, names) && recommended.Methods > 0;
    }

    // --- Plans ---------------------------------------------------------------------------------------------------------------

    private static AgentObjectCall Notification(AgentNotificationChangeDto change, string alert, string @operator) => change.Change switch
    {
        "delete" => new("sp_delete_notification", [("@alert_name", alert), ("@operator_name", @operator)]),
        _ => new(change.Change == "add" ? "sp_add_notification" : "sp_update_notification", [("@alert_name", alert), ("@operator_name", @operator), ("@notification_method", (byte)change.Methods)])
    };

    /// <summary>The alert save's batch: each new operator's sp_add_operator, then New Alert's sp_add_alert with every argument it sets (or an existing
    /// alert's sp_update_alert with only the changed ones, '' clearing a text and the job detached by the zero id), then each notification change by
    /// the alert's name as saved.</summary>
    /// <param name="now">The server's clock, for Reset count's stamp (sp_update_alert keeps the old reset date unless given one).</param>
    internal static AgentObjectBatch AlertSavePlan(ActionArgs args, ObjectRefDto target, DateTime? now = null)
    {
        var save = args.AgentAlert!;
        var create = target.Kind == "agent";
        var calls = new List<AgentObjectCall>();
        foreach (var added in save.NewOperators ?? [])
        {
            var arguments = new List<(string, object?)> { ("@name", added.Name) };
            if (added.Email is { Length: > 0 } email) arguments.Add(("@email_address", email));
            if (added.Pager is { Length: > 0 } pager)
            {
                // sp_add_operator's @pager_days defaults to 0 (never on duty); New Operator's every day, 08:00 to 18:00, so its pages are sent.
                arguments.Add(("@pager_address", pager));
                arguments.Add(("@pager_days", (byte)127));
                foreach (var day in new[] { "weekday", "saturday", "sunday" }) { arguments.Add(($"@{day}_pager_start_time", 80000)); arguments.Add(($"@{day}_pager_end_time", 180000)); }
            }
            calls.Add(new("sp_add_operator", arguments));
        }
        var alert = new List<(string, object?)> { ("@name", create ? save.Name : target.Name) };
        if (!create && save.Name is not null) alert.Add(("@new_name", save.Name));
        void Set(string argument, object? value, bool skipEmpty = false) { if (value is not null && !(create && skipEmpty && value is "")) alert.Add((argument, value)); }
        Set("@enabled", save.Enabled is { } enabled ? (byte)(enabled ? 1 : 0) : null);
        Set("@message_id", save.MessageId);
        Set("@severity", save.Severity);
        Set("@delay_between_responses", save.Delay);
        Set("@notification_message", save.Message, skipEmpty: true);
        Set("@include_event_description_in", save.IncludeIn is { } include ? (byte)include : null);
        Set("@database_name", save.Database, skipEmpty: true);
        Set("@event_description_keyword", save.Keyword, skipEmpty: true);
        Set("@job_id", save.JobId is null ? null : save.JobId.Length == 0 ? (create ? null : Guid.Empty) : Guid.ParseExact(save.JobId, "D"));
        Set("@occurrence_count", save.ResetCount == true ? 0 : null);
        if (save.ResetCount == true && now is { } stamp)
        {
            Set("@count_reset_date", stamp.Year * 10000 + stamp.Month * 100 + stamp.Day);
            Set("@count_reset_time", stamp.Hour * 10000 + stamp.Minute * 100 + stamp.Second);
        }
        Set("@performance_condition", save.Condition);
        if (create) calls.Add(new("sp_add_alert", alert));
        else if (alert.Count > 1) calls.Add(new("sp_update_alert", alert));
        var name = save.Name ?? target.Name!;
        foreach (var change in save.Notifications ?? []) calls.Add(Notification(change, name, change.Name));
        return create ? AgentSql.ObjectBatch(AgentObjectHead.None, calls) : AgentSql.ObjectBatch(AgentObjectHead.Alert, calls, target.Name, args.AgentObjectId ?? 0);
    }

    /// <summary>The operator save's batch: New Operator's sp_add_operator then each notification change by its name; an existing operator's notification
    /// changes by the name read, then its sp_update_operator with only the changed arguments last, since sp_update_operator rewrites the fail-safe
    /// operator's registry values outside the transaction, so nothing after it may fail and roll its UPDATE back.</summary>
    internal static AgentObjectBatch OperatorSavePlan(ActionArgs args, ObjectRefDto target)
    {
        var save = args.AgentOperator!;
        var create = target.Kind == "agent";
        var calls = new List<AgentObjectCall>();
        var arguments = new List<(string, object?)> { ("@name", create ? save.Name : target.Name) };
        if (!create && save.Name is not null) arguments.Add(("@new_name", save.Name));
        void Set(string argument, object? value, bool skipEmpty = false) { if (value is not null && !(create && skipEmpty && value is "")) arguments.Add((argument, value)); }
        Set("@enabled", save.Enabled is { } enabled ? (byte)(enabled ? 1 : 0) : null);
        Set("@email_address", save.Email, skipEmpty: true);
        Set("@pager_address", save.Pager, skipEmpty: true);
        Set("@weekday_pager_start_time", save.WeekdayStart);
        Set("@weekday_pager_end_time", save.WeekdayEnd);
        Set("@saturday_pager_start_time", save.SaturdayStart);
        Set("@saturday_pager_end_time", save.SaturdayEnd);
        Set("@sunday_pager_start_time", save.SundayStart);
        Set("@sunday_pager_end_time", save.SundayEnd);
        Set("@pager_days", save.PagerDays is { } days ? (byte)days : null);
        Set("@netsend_address", save.NetSend, skipEmpty: true);
        if (create) calls.Add(new("sp_add_operator", arguments));
        var name = create ? save.Name! : target.Name!;
        foreach (var change in save.Notifications ?? []) calls.Add(Notification(change, change.Name, name));
        if (!create && arguments.Count > 1) calls.Add(new("sp_update_operator", arguments));
        return create ? AgentSql.ObjectBatch(AgentObjectHead.None, calls) : AgentSql.ObjectBatch(AgentObjectHead.Operator, calls, target.Name, args.AgentObjectId ?? 0);
    }

    /// <summary>A tree verb's batch on an alert or operator: one call under its identity guard.</summary>
    internal static AgentObjectBatch ObjectVerbPlan(ActionArgs args, ObjectRefDto target, int id)
    {
        var alert = target.Kind == "agentAlert";
        var update = alert ? "sp_update_alert" : "sp_update_operator";
        AgentObjectCall call = args.Action switch
        {
            "enable" or "disable" => new(update, [("@name", target.Name), ("@enabled", (byte)(args.Action == "enable" ? 1 : 0))]),
            "rename" => new(update, [("@name", target.Name), ("@new_name", args.NewName)]),
            "delete" when alert => new("sp_delete_alert", [("@name", target.Name)]),
            "delete" => new("sp_delete_operator", args.ReassignTo is { } to ? [("@name", target.Name), ("@reassign_to_operator", to)] : [("@name", target.Name)]),
            _ => throw new InvalidOperationException("Not an alert or operator verb.")
        };
        return AgentSql.ObjectBatch(alert ? AgentObjectHead.Alert : AgentObjectHead.Operator, [call], target.Name, id);
    }

    /// <summary>Add recommended alerts' batch: per alert its sp_add_alert (enabled, the delay, the error text in e-mail) and, with an operator, its
    /// sp_add_notification.</summary>
    internal static AgentObjectBatch RecommendedPlan(AgentRecommendedDto recommended)
    {
        var calls = new List<AgentObjectCall>();
        foreach (var alert in recommended.Alerts!)
        {
            calls.Add(new("sp_add_alert", [("@name", alert.Name), ("@message_id", alert.MessageId), ("@severity", alert.Severity), ("@enabled", (byte)1),
                ("@delay_between_responses", recommended.Delay), ("@include_event_description_in", (byte)(recommended.Methods & 1))]));
            if (recommended.Operator is { } @operator)
                calls.Add(new("sp_add_notification", [("@alert_name", alert.Name), ("@operator_name", @operator), ("@notification_method", (byte)recommended.Methods)]));
        }
        return AgentSql.ObjectBatch(AgentObjectHead.None, calls);
    }

    internal static AgentObjectBatch NotifyPlan(ObjectRefDto target, int id, string profile) =>
        AgentSql.ObjectBatch(AgentObjectHead.Operator, [new("sp_notify_operator", [("@profile_name", profile), ("@name", target.Name), ("@subject", TestMailSubject), ("@body", TestMailBody)])], target.Name, id);

    // --- Describe ------------------------------------------------------------------------------------------------------------

    private static string AlertKind(int type) => type == 2 ? "performance" : type == 4 ? "wmi" : "event";
    private static string? Stamp(object? date, object? time) => RunStamp(IntOf(date), IntOf(time));

    private async Task<int?> ObjectIdAsync(SqlConnection connection, ObjectRefDto target, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = target.Kind == "agentAlert" ? AgentSql.AlertByName : AgentSql.OperatorByName;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, target.Name!);
        await using var reader = await command.ExecuteReaderAsync(token);
        return await reader.ReadAsync(token) ? reader.GetInt32(0) : null;
    }

    private ActionError ObjectGone(ObjectRefDto target) => Error("NOT_FOUND", (target.Kind == "agentAlert" ? "The alert " : "The operator ") + Display(target) + " no longer exists. Refresh Object Explorer.");

    private ActionError? ObjectIdError(SqlException error, SqlConnection connection) => ActionErrors.FromSql(catalog, error, connection, ddl: false, null);

    /// <summary>The platform, or why Agent's alerts cannot be had here (NOT_SUPPORTED).</summary>
    private (string? Platform, ActionError? Error) AgentPlatform(ServerProfile profile, bool alerts)
    {
        var catalogue = AgentCatalog.Current;
        if (catalogue.PlatformOf(profile.EngineEdition, profile.Linux) is not { } platform) return (null, Error("NOT_SUPPORTED", AgentProfileSql.Unsupported(profile.EngineEdition)));
        if (alerts && !catalogue.Offers("alerts", platform)) return (null, Error("NOT_SUPPORTED", AlertsUnsupportedMessage));
        return (platform, null);
    }

    private static AgentDutyHoursDto Duty(AgentResult rows, object?[] row, string day) => new(IntOf(rows.Value(row, day + "_pager_start_time")), IntOf(rows.Value(row, day + "_pager_end_time")));
    private static AgentOperatorRecordDto OperatorRecord(AgentResult rows, object?[] row)
    {
        object? Value(string column) => rows.Value(row, column);
        return new(IntOf(Value("id")), TextOf(Value("name")), IntOf(Value("enabled")) == 1, TextOf(Value("email_address")).Trim(), TextOf(Value("pager_address")).Trim(), TextOf(Value("netsend_address")).Trim(),
            IntOf(Value("pager_days")), Duty(rows, row, "weekday"), Duty(rows, row, "saturday"), Duty(rows, row, "sunday"),
            Stamp(Value("last_email_date"), Value("last_email_time")), Stamp(Value("last_pager_date"), Value("last_pager_time")), Stamp(Value("last_netsend_date"), Value("last_netsend_time")));
    }
    private static AgentJobOperatorDto OperatorChoice(AgentOperatorRecordDto record) =>
        new(record.Name, record.Enabled, record.Email.Length > 0, record.Pager.Length > 0, record.NetSend.Length > 0, record.PagerDays, record.Weekday, record.Saturday, record.Sunday);
    private static List<AgentAlertRowDto> AlertRowList(AgentResult rows) =>
        [.. rows.Rows.Select(row => new AgentAlertRowDto(IntOf(rows.Value(row, "id")), TextOf(rows.Value(row, "name")), IntOf(rows.Value(row, "enabled")) == 1, AlertKind(IntOf(rows.Value(row, "type"))),
            IntOf(rows.Value(row, "message_id")), IntOf(rows.Value(row, "severity"))))];
    private static List<AgentNotificationRowDto> NotificationList(AgentResult rows) =>
        [.. rows.Rows.Select(row => new AgentNotificationRowDto(IntOf(rows.Value(row, "alert_id")), IntOf(rows.Value(row, "operator_id")), IntOf(rows.Value(row, "notification_method"))))];
    private static List<AgentJobNotifyRowDto> JobNotifyList(AgentResult rows) =>
        [.. rows.Rows.Select(row => new AgentJobNotifyRowDto(rows.Value(row, "job_id") is Guid id ? id.ToString("D") : "", TextOf(rows.Value(row, "name")), TextOf(rows.Value(row, "email_operator")),
            TextOf(rows.Value(row, "page_operator")), TextOf(rows.Value(row, "netsend_operator"))))];

    /// <summary>The facts every AG-7 describe shares: the login, sysadmin, Database Mail's readiness; null with the error when the facts cannot be read.</summary>
    private async Task<(string Login, bool Sysadmin, AgentJobMailDto Mail, ActionError? Error)> AgentObjectFactsAsync(AgentReader reader, SqlConnection connection, CancellationToken token)
    {
        var (results, errors) = await reader.ReadAsync(connection, null, [AgentSql.JobDocumentFacts, AgentSql.MailProfiles], (_, _) => null, token);
        if (ReadFailure(errors.FirstOrDefault(error => error.Statement == AgentSql.JobDocumentFacts.Id)) is { } failure) return ("", false, new(false, false), failure);
        var facts = results[AgentSql.JobDocumentFacts.Id];
        if (facts.Rows.Count == 0) return ("", false, new(false, false), Error("SQL_ERROR", AgentReader.FailedMessage));
        var login = TextOf(facts.Value(facts.Rows[0], "login_name"));
        var sysadmin = IntOf(facts.Value(facts.Rows[0], "is_sysadmin")) == 1;
        int? xps = facts.Value(facts.Rows[0], "mail_xps") is { } value and not DBNull ? IntOf(value) : null;
        var mailChecked = errors.All(error => error.Statement != AgentSql.MailProfiles.Id) && results.ContainsKey(AgentSql.MailProfiles.Id);
        bool? useDatabaseMail = null;
        string? agentProfile = null;
        if (sysadmin)
        {
            var (mail, mailErrors) = await reader.ReadAsync(connection, null, [AgentSql.AgentMail], (_, _) => null, token);
            if (mailErrors.Count == 0 && mail.TryGetValue(AgentSql.AgentMail.Id, out var rows) && rows.Rows.Count > 0)
            {
                useDatabaseMail = IntOf(rows.Value(rows.Rows[0], "use_databasemail")) == 1;
                agentProfile = TextOf(rows.Value(rows.Rows[0], "databasemail_profile")) is { Length: > 0 } named ? named : null;
            }
        }
        return (login, sysadmin, new(mailChecked, sysadmin, xps is { } on ? on == 1 : null, mailChecked ? results[AgentSql.MailProfiles.Id].Rows.Count : null, useDatabaseMail, agentProfile), null);
    }

    /// <summary>The alert document's describe: the alert named by <paramref name="target"/>, or New Alert's choices (the Agent node).</summary>
    private async Task<ActionDescribeResult> DescribeAgentAlertDocumentAsync(SqlConnection connection, ServerProfile profile, ObjectRefDto target, CancellationToken token)
    {
        var (platform, refused) = AgentPlatform(profile, alerts: true);
        if (refused is not null) return new(null, 0, refused);
        int? id = null;
        if (target.Kind == "agentAlert")
        {
            try { id = await ObjectIdAsync(connection, target, token); }
            catch (SqlException error) when (!token.IsCancellationRequested) { return new(null, 0, ObjectIdError(error, connection)); }
            if (id is null) return new(null, 0, ObjectGone(target));
        }
        var reader = new AgentReader();
        var (login, sysadmin, mail, failure) = await AgentObjectFactsAsync(reader, connection, token);
        if (failure is not null) return new(null, 0, failure);
        List<AgentStatement> reads = [AgentSql.OperatorRows, AgentSql.AlertJobs, AgentSql.AlertDatabases, AgentSql.Counters];
        if (id is not null) reads.AddRange([AgentSql.AlertDocument, AgentSql.AlertNotifications]);
        var (results, errors) = await reader.ReadAsync(connection, null, reads, (_, parameter) => parameter.Name == "@alert_id" ? id : null, token);
        bool Read(AgentStatement statement, out AgentResult result) => results.TryGetValue(statement.Id, out result!) && errors.All(error => error.Statement != statement.Id);
        if (id is not null && ReadFailure(errors.FirstOrDefault(error => error.Statement == AgentSql.AlertDocument.Id)) is { } alertFailure) return new(null, 0, alertFailure);
        List<AgentOperatorRecordDto>? operators = Read(AgentSql.OperatorRows, out var operatorRows) ? [.. operatorRows.Rows.Select(row => OperatorRecord(operatorRows, row))] : null;
        AgentAlertRecordDto? alert = null;
        var notifications = new List<AgentAlertNotifyDto>();
        string? messageText = null;
        if (id is not null)
        {
            var rows = results[AgentSql.AlertDocument.Id];
            if (rows.Rows.Count == 0) return new(null, 0, ObjectGone(target));
            object? Value(string column) => rows.Value(rows.Rows[0], column);
            alert = new(id.Value, TextOf(Value("name")), IntOf(Value("enabled")) == 1, AlertKind(IntOf(Value("type"))), IntOf(Value("message_id")), IntOf(Value("severity")), TextOf(Value("database_name")),
                TextOf(Value("event_description_keyword")), TextOf(Value("performance_condition")), TextOf(Value("wmi_namespace")), TextOf(Value("wmi_query")),
                Value("job_id") is Guid job && job != Guid.Empty ? job.ToString("D") : "", TextOf(Value("job_name")), IntOf(Value("delay_between_responses")), IntOf(Value("include_event_description")),
                TextOf(Value("notification_message")), IntOf(Value("occurrence_count")), Stamp(Value("last_occurrence_date"), Value("last_occurrence_time")),
                Stamp(Value("last_response_date"), Value("last_response_time")), Stamp(Value("count_reset_date"), Value("count_reset_time")));
            if (Read(AgentSql.AlertNotifications, out var notified))
                notifications = [.. notified.Rows.Where(row => IntOf(notified.Value(row, "notification_method")) > 0)
                    .Select(row => new AgentAlertNotifyDto(TextOf(notified.Value(row, "operator_name")), IntOf(notified.Value(row, "notification_method"))))];
            if (alert.MessageId > 0)
            {
                var (text, _) = await reader.ReadAsync(connection, null, [AgentSql.MessageText], (_, _) => alert.MessageId, token);
                if (text.TryGetValue(AgentSql.MessageText.Id, out var found) && found.Rows.Count > 0) messageText = TextOf(found.Value(found.Rows[0], "text"));
            }
        }
        List<AgentAlertJobDto>? jobs = Read(AgentSql.AlertJobs, out var jobRows)
            ? [.. jobRows.Rows.Where(row => jobRows.Value(row, "job_id") is Guid).Select(row => new AgentAlertJobDto(((Guid)jobRows.Value(row, "job_id")!).ToString("D"), TextOf(jobRows.Value(row, "name"))))] : null;
        var databases = Read(AgentSql.AlertDatabases, out var databaseRows) ? databaseRows.Rows.Select(row => TextOf(databaseRows.Value(row, "name"))).Where(name => name.Length > 0).ToList() : [];
        List<AgentCounterDto>? counters = null;
        var countersTruncated = false;
        if (Read(AgentSql.Counters, out var counterRows))
        {
            counters = [.. counterRows.Rows.Select(row => new AgentCounterDto(TextOf(counterRows.Value(row, "object_name")), TextOf(counterRows.Value(row, "counter_name"))))];
            countersTruncated = counterRows.Truncated;
        }
        return new(null, 0, AgentAlertDocument: new(alert, login, sysadmin, platform!, notifications, databases, mail, !sysadmin ? AlertReadOnlyMessage : id is not null && !Read(AgentSql.AlertNotifications, out _) ? NotificationsUnreadMessage : null, operators?.Select(OperatorChoice).ToList(),
            jobs, counters, countersTruncated ? true : null, messageText, operators is not null && operatorRows!.Truncated ? true : null));
    }

    /// <summary>The operator document's describe: the operator named by <paramref name="target"/>, or New Operator's (the Agent node).</summary>
    private async Task<ActionDescribeResult> DescribeAgentOperatorDocumentAsync(SqlConnection connection, ServerProfile profile, ObjectRefDto target, CancellationToken token)
    {
        var (platform, refused) = AgentPlatform(profile, alerts: false);
        if (refused is not null) return new(null, 0, refused);
        int? id = null;
        if (target.Kind == "agentOperator")
        {
            try { id = await ObjectIdAsync(connection, target, token); }
            catch (SqlException error) when (!token.IsCancellationRequested) { return new(null, 0, ObjectIdError(error, connection)); }
            if (id is null) return new(null, 0, ObjectGone(target));
        }
        var reader = new AgentReader();
        var (login, sysadmin, mail, failure) = await AgentObjectFactsAsync(reader, connection, token);
        if (failure is not null) return new(null, 0, failure);
        var alertsOffered = AgentCatalog.Current.Offers("alerts", platform!);
        List<AgentStatement> reads = id is null ? [AgentSql.OperatorRows, AgentSql.JobNotifications] : [AgentSql.OperatorRows, AgentSql.OperatorDocument, AgentSql.JobNotifications];
        if (alertsOffered) reads.AddRange(id is null ? [AgentSql.AlertRows] : [AgentSql.AlertRows, AgentSql.OperatorNotifications]);
        var (results, errors) = await reader.ReadAsync(connection, null, reads, (_, parameter) => parameter.Name == "@operator_id" ? id : null, token);
        bool Read(AgentStatement statement, out AgentResult result) => results.TryGetValue(statement.Id, out result!) && errors.All(error => error.Statement != statement.Id);
        if (ReadFailure(errors.FirstOrDefault(error => error.Statement == AgentSql.OperatorRows.Id)) is { } operatorFailure) return new(null, 0, operatorFailure);
        AgentOperatorRecordDto? record = null;
        if (id is not null)
        {
            if (ReadFailure(errors.FirstOrDefault(error => error.Statement == AgentSql.OperatorDocument.Id)) is { } documentFailure) return new(null, 0, documentFailure);
            var rows = results[AgentSql.OperatorDocument.Id];
            var row = rows.Rows.FirstOrDefault(item => IntOf(rows.Value(item, "id")) == id);
            if (row is null) return new(null, 0, ObjectGone(target));
            record = OperatorRecord(rows, row);
        }
        List<AgentAlertRowDto>? alerts = null;
        var alertsTruncated = false;
        if (alertsOffered && Read(AgentSql.AlertRows, out var alertRows)) { alerts = AlertRowList(alertRows); alertsTruncated = alertRows.Truncated; }
        var notifications = alerts is not null && id is not null && Read(AgentSql.OperatorNotifications, out var notified) ? NotificationList(notified).Where(row => row.OperatorId == id).ToList() : [];
        List<AgentJobNotifyRowDto>? jobs = record is not null && Read(AgentSql.JobNotifications, out var jobRows)
            ? [.. JobNotifyList(jobRows).Where(job => job.Email == record.Name || job.Page == record.Name || job.NetSend == record.Name)] : null;
        return new(null, 0, AgentOperatorDocument: new(record, login, sysadmin, platform!, notifications, mail, !sysadmin ? OperatorReadOnlyMessage : alerts is not null && id is not null && !Read(AgentSql.OperatorNotifications, out _) ? NotificationsUnreadMessage : null, alerts, alertsTruncated ? true : null, jobs));
    }

    /// <summary>The Operators and notifications grid's describe: every operator, alert, notification and notifying job the login may read.</summary>
    private async Task<ActionDescribeResult> DescribeAgentOperatorsAsync(SqlConnection connection, ServerProfile profile, CancellationToken token)
    {
        var (platform, refused) = AgentPlatform(profile, alerts: false);
        if (refused is not null) return new(null, 0, refused);
        var reader = new AgentReader();
        var (login, sysadmin, mail, failure) = await AgentObjectFactsAsync(reader, connection, token);
        if (failure is not null) return new(null, 0, failure);
        var alertsOffered = AgentCatalog.Current.Offers("alerts", platform!);
        List<AgentStatement> reads = [AgentSql.OperatorRows, AgentSql.JobNotifications];
        if (alertsOffered) reads.AddRange([AgentSql.AlertRows, AgentSql.Notifications]);
        var (results, errors) = await reader.ReadAsync(connection, null, reads, (_, _) => null, token);
        bool Read(AgentStatement statement, out AgentResult result) => results.TryGetValue(statement.Id, out result!) && errors.All(error => error.Statement != statement.Id);
        if (ReadFailure(errors.FirstOrDefault(error => error.Statement == AgentSql.OperatorRows.Id)) is { } operatorFailure) return new(null, 0, operatorFailure);
        var operatorRows = results[AgentSql.OperatorRows.Id];
        var operators = operatorRows.Rows.Select(row => OperatorRecord(operatorRows, row)).ToList();
        List<AgentAlertRowDto>? alerts = null;
        var alertsTruncated = false;
        if (alertsOffered && Read(AgentSql.AlertRows, out var alertRows)) { alerts = AlertRowList(alertRows); alertsTruncated = alertRows.Truncated; }
        var notifications = alerts is not null && Read(AgentSql.Notifications, out var notified) ? NotificationList(notified) : [];
        var notificationsTruncated = alerts is not null && results.TryGetValue(AgentSql.Notifications.Id, out var all) && all.Truncated;
        List<AgentJobNotifyRowDto>? jobs = Read(AgentSql.JobNotifications, out var jobRows) ? JobNotifyList(jobRows) : null;
        // A grid missing some notifications would re-add one msdb already has, so past the cap it only shows them.
        var readOnly = !sysadmin ? OperatorReadOnlyMessage : alerts is not null && !Read(AgentSql.Notifications, out _) ? NotificationsUnreadMessage : notificationsTruncated ? NotificationsTruncatedMessage : null;
        return new(null, 0, AgentOperators: new(login, sysadmin, platform!, operators, notifications, mail, readOnly, operatorRows.Truncated ? true : null,
            alerts, alertsTruncated ? true : null, jobs));
    }

    /// <summary>Delete Object's row for an alert or operator: its id, which the Delete request names, and for an operator the operators its
    /// notifications can move to and how many alerts and jobs notify it.</summary>
    private async Task<ActionDescribeResult> DescribeAgentObjectDeleteAsync(SqlConnection connection, ObjectRefDto target, CancellationToken token)
    {
        int? id;
        try { id = await ObjectIdAsync(connection, target, token); }
        catch (SqlException error) when (!token.IsCancellationRequested) { return new(null, 0, ObjectIdError(error, connection)); }
        if (id is null) return new(null, 0, ObjectGone(target));
        if (target.Kind == "agentAlert") return new(new DeleteTargetDto(target.Name!, "Alert", null, [], false, AgentObjectId: id), 0);
        var reader = new AgentReader();
        var (results, errors) = await reader.ReadAsync(connection, null, [AgentSql.OperatorRows, AgentSql.OperatorNotifications, AgentSql.JobNotifications], (_, parameter) => parameter.Name == "@operator_id" ? id : null, token);
        bool Read(AgentStatement statement, out AgentResult result) => results.TryGetValue(statement.Id, out result!) && errors.All(error => error.Statement != statement.Id);
        List<string>? choices = Read(AgentSql.OperatorRows, out var rows)
            ? [.. rows.Rows.Select(row => TextOf(rows.Value(row, "name"))).Where(name => name.Length > 0 && !string.Equals(name, target.Name, StringComparison.Ordinal)).Order(StringComparer.CurrentCultureIgnoreCase)] : null;
        var alerts = Read(AgentSql.OperatorNotifications, out var notified) ? NotificationList(notified).Count(row => row.OperatorId == id && row.Methods > 0) : 0;
        var jobs = Read(AgentSql.JobNotifications, out var jobRows) ? JobNotifyList(jobRows).Count(job => job.Email == target.Name || job.Page == target.Name || job.NetSend == target.Name) : 0;
        return new(new DeleteTargetDto(target.Name!, "Operator", null, [], false, AgentObjectId: id, ReassignChoices: choices, NotifiedBy: new(alerts, jobs)), 0);
    }

    // --- Execute -------------------------------------------------------------------------------------------------------------

    private static string ObjectStep(ActionArgs args, ObjectRefDto target) => args.Action switch
    {
        "agentAlert" => target.Kind == "agent" ? "Create the alert" : "Save the alert",
        "agentOperator" => target.Kind == "agent" ? "Create the operator" : "Save the operator",
        AddRecommendedAlertsAction => "Create the recommended alerts",
        NotifyOperatorAction => "Send a test e-mail",
        "enable" => target.Kind == "agentAlert" ? "Enable the alert" : "Enable the operator",
        "disable" => target.Kind == "agentAlert" ? "Disable the alert" : "Disable the operator",
        "rename" => target.Kind == "agentAlert" ? "Rename the alert" : "Rename the operator",
        _ => target.Kind == "agentAlert" ? "Delete the alert" : "Delete the operator"
    };

    /// <summary>Runs an AG-7 write: the platform check, the batch the request plans (a tree verb resolves the id by name first; Send test e-mail reads
    /// Agent's mail profile first), in one transaction.</summary>
    private async Task<ActionExecuteResult> ExecuteAgentObjectAsync(SqlConnection connection, ServerProfile profile, ActionArgs args, ObjectRefDto target, CancellationToken token)
    {
        var alerts = args.Action is "agentAlert" or AddRecommendedAlertsAction || target.Kind == "agentAlert";
        var (_, refused) = AgentPlatform(profile, alerts);
        if (refused is not null) return new([], [], 0, refused);
        var messages = CollectMessages(connection);
        AgentObjectBatch? batch = null;
        var step = new RunStep(ObjectStep(args, target), async context =>
        {
            batch = await PlanObjectAsync(connection, args, target, context.Token);
            var open = (SqlTransaction)await connection.BeginTransactionAsync(context.Token);
            var committed = false;
            try
            {
                await using var command = connection.CreateCommand();
                command.Transaction = open;
                command.CommandText = batch.Text;
                command.CommandTimeout = 0;
                foreach (var (parameter, value) in batch.Parameters) Add(command, parameter.Name, parameter.Type, parameter.Size, value);
                await ReadAllAsync(command, context.Token);
                await open.CommitAsync(CancellationToken.None);
                committed = true;
            }
            catch (SqlException error) when (!context.Token.IsCancellationRequested && connection.State == ConnectionState.Open)
            {
                throw new StepRefusedException(ObjectSaveError(error, batch, connection));
            }
            finally
            {
                if (!committed && open.Connection is not null)
                {
                    try { await open.RollbackAsync(CancellationToken.None).WaitAsync(Options.StopGrace, CancellationToken.None); }
                    catch (Exception) { try { await connection.CloseAsync(); } catch (Exception) { } }
                }
                await open.DisposeAsync();
            }
        }, Detail: args.AgentAlert?.Name ?? args.AgentOperator?.Name ?? target.Name);
        var (steps, failure, _) = await RunStepsAsync(connection, [step], null, token, CleanupBudget(args.Action));
        return new(steps, messages.Collected(), 0, failure);
    }

    /// <summary>The batch a request runs. A tree verb without an id (Enable, Disable, Rename) resolves it by name now; Send test e-mail needs Agent's
    /// own Database Mail profile (sysadmin reads it), else it is refused before anything is sent.</summary>
    private async Task<AgentObjectBatch> PlanObjectAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, CancellationToken token)
    {
        switch (args.Action)
        {
            case "agentAlert":
            {
                if (args.AgentAlert?.ResetCount != true) return AlertSavePlan(args, target);
                var (clock, errors) = await new AgentReader().ReadAsync(connection, null, [AgentSql.ServerClock], (_, _) => null, token);
                if (errors.FirstOrDefault() is { } failed) throw new StepRefusedException(ReadFailure(failed)!);
                var rows = clock[AgentSql.ServerClock.Id];
                return AlertSavePlan(args, target, rows.Rows.Count > 0 && rows.Value(rows.Rows[0], "server_now") is DateTime serverNow ? serverNow : null);
            }
            case "agentOperator": return OperatorSavePlan(args, target);
            case AddRecommendedAlertsAction: return RecommendedPlan(args.AgentRecommended!);
            case NotifyOperatorAction:
            {
                var (mail, errors) = await new AgentReader().ReadAsync(connection, null, [AgentSql.AgentMail], (_, _) => null, token);
                if (errors.FirstOrDefault() is { } failed) throw new StepRefusedException(failed.Code == "PERMISSION_DENIED" ? Error("PERMISSION_DENIED", "Only sysadmin can send a test e-mail through SQL Server Agent's profile.") : ReadFailure(failed)!);
                var rows = mail[AgentSql.AgentMail.Id];
                var profileName = rows.Rows.Count > 0 ? TextOf(rows.Value(rows.Rows[0], "databasemail_profile")) : "";
                if (profileName.Length == 0) throw new StepRefusedException(Error("NOT_SUPPORTED", NoAgentProfileMessage));
                return NotifyPlan(target, args.AgentObjectId!.Value, profileName);
            }
        }
        var id = args.AgentObjectId ?? await ObjectIdAsync(connection, target, token) ?? throw new StepRefusedException(ObjectGone(target));
        return ObjectVerbPlan(args, target, id);
    }

    /// <summary>What a refused AG-7 write says: 50010 NOT_FOUND (the object was replaced), 15281 AGENT_STOPPED, else msdb's own error mapped by number,
    /// with the call the THROW's state names.</summary>
    internal ActionError ObjectSaveError(SqlException error, AgentObjectBatch? batch, SqlConnection? connection)
    {
        var errors = error.Errors.Cast<SqlError>().ToList();
        var first = errors.FirstOrDefault(item => item.Class > 10)?.Number ?? error.Number;
        if (first == 50010) return Error("NOT_FOUND", AgentSql.ObjectChangedMessage);
        if (first == 15281) return Error("AGENT_STOPPED", AgentStoppedMessage);
        var mapped = ActionErrors.FromSql(catalog, error, connection, ddl: true, null);
        if (mapped.Code == "NOT_FOUND") mapped = mapped with { Code = "SQL_ERROR", Retryable = false };
        var text = string.Join(" ", errors.Where(item => item.Class > 10 && item.Number is not (50012 or 3621 or 3998)).Select(item => item.Message).Distinct());
        var thrown = errors.FirstOrDefault(item => item.Number == 50012);
        if (batch is null || thrown is null || thrown.State < 1 || thrown.State > batch.Calls.Count)
            return ActionErrors.Create(catalog, mapped.Code, JobSaveAbortedMessage + (text.Length > 0 ? " " + text : "")) with { Retryable = mapped.Retryable };
        var call = batch.Calls[thrown.State - 1];
        string Named(string argument) => call.Arguments.FirstOrDefault(item => item.Argument == argument).Value as string ?? "";
        var part = call.Procedure switch
        {
            "sp_add_operator" => "Creating operator '" + Named("@name") + "'",
            "sp_add_alert" => "Creating alert '" + Named("@name") + "'",
            "sp_update_alert" => "Saving the alert's settings",
            "sp_update_operator" => "Saving the operator's settings",
            "sp_delete_alert" => "Deleting the alert",
            "sp_delete_operator" => "Deleting the operator",
            "sp_notify_operator" => "The test e-mail",
            _ => "Saving the notification of '" + Named("@operator_name") + "' by '" + Named("@alert_name") + "'"
        };
        return ActionErrors.Create(catalog, mapped.Code, part + " was refused: " + (text.Length > 0 ? text : AgentSql.RefusedMessage)) with { Retryable = mapped.Retryable };
    }

    private Task<ActionExecuteResult> ExecuteAgentObjectRequestAsync(ActionArgs args, ObjectRefDto target, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var engine = host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine;
        if (engine is not ("box" or "managedInstance")) return Task.FromResult(new ActionExecuteResult([], [], 0, Error("NOT_SUPPORTED", EngineMessage(engine))));
        return RunAsync(args.ConnectionId, args.RequestId, null, read: false, null, token,
            async (connection, profile, band, job) => await ExecuteAgentObjectAsync(connection, profile, args, target, job) with { ElapsedMs = watch.ElapsedMilliseconds },
            error => new ActionExecuteResult([], [], watch.ElapsedMilliseconds, error));
    }

    // --- Script --------------------------------------------------------------------------------------------------------------

    /// <summary>An AG-7 write's script: one transaction, each call with literal values by the object's name and followed by its return-code check
    /// (Script reads nothing, so it needs no id).</summary>
    internal static string AgentObjectScript(ActionArgs args, ObjectRefDto target)
    {
        var batch = args.Action switch
        {
            // Script reads nothing, so Reset count's stamp is this machine's clock at scripting time.
            "agentAlert" => AlertSavePlan(args, target, DateTime.Now),
            "agentOperator" => OperatorSavePlan(args, target),
            AddRecommendedAlertsAction => RecommendedPlan(args.AgentRecommended!),
            _ => ObjectVerbPlan(args, target, 0)
        };
        static string Value(object? value) => value switch
        {
            null => "NULL",
            string text => Literal(text),
            byte or int => Convert.ToString(value, CultureInfo.InvariantCulture)!,
            Guid id => Literal(id.ToString("D")),
            _ => throw new InvalidOperationException("Not a script value.")
        };
        var text = new StringBuilder("USE [msdb]\nGO\nBEGIN TRANSACTION\nDECLARE @ReturnCode INT\nSELECT @ReturnCode = 0\n");
        foreach (var call in batch.Calls)
            text.Append("EXEC @ReturnCode = msdb.dbo.").Append(call.Procedure).Append(' ').Append(string.Join(", ", call.Arguments.Select(argument => argument.Argument + "=" + Value(argument.Value)))).Append('\n')
                .Append("IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback\n");
        text.Append("COMMIT TRANSACTION\nGOTO EndSave\nQuitWithRollback:\n    IF (@@TRANCOUNT > 0) ROLLBACK TRANSACTION\nEndSave:\nGO\n");
        return text.ToString();
    }

    private Task<ActionScriptResult> ScriptAgentObject(ActionArgs args, ObjectRefDto target)
    {
        var profile = host.Profile(args.ConnectionId);
        var engine = profile.Explorer(explorer).ServerEngine;
        if (engine is not ("box" or "managedInstance")) return Task.FromResult(new ActionScriptResult(null, "msdb", [], Error("NOT_SUPPORTED", EngineMessage(engine))));
        var alerts = args.Action is "agentAlert" or AddRecommendedAlertsAction || target.Kind == "agentAlert";
        if (alerts && (engine == "managedInstance" || profile.Linux)) return Task.FromResult(new ActionScriptResult(null, "msdb", [], Error("NOT_SUPPORTED", AlertsUnsupportedMessage)));
        return Task.FromResult(new ActionScriptResult(AgentObjectScript(args, target), "msdb", []));
    }

    // --- agent.counterValues -------------------------------------------------------------------------------------------------

    /// <summary>Re-validates agentCounterValuesSchema: the ids, and an object and counter of 1 to 128 characters without U+0000.</summary>
    internal static void Validate(AgentCounterValuesArgs args)
    {
        Ids(args.ConnectionId, args.RequestId);
        if (args.Object is not { Length: > 0 and <= 128 } || args.Object.Contains('\0')) throw Invalid("object.");
        if (args.Counter is not { Length: > 0 and <= 128 } || args.Counter.Contains('\0')) throw Invalid("counter.");
    }

    public Task<AgentCounterValuesResult> CounterValuesAsync(AgentCounterValuesArgs args, CancellationToken token)
    {
        Validate(args);
        var watch = Stopwatch.StartNew();
        var engine = host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine;
        if (engine is not ("box" or "managedInstance")) return Task.FromResult(new AgentCounterValuesResult(null, 0, Error("NOT_SUPPORTED", EngineMessage(engine))));
        return RunAsync(args.ConnectionId, args.RequestId, null, read: true, Options.DescribeBudget, token,
            async (connection, profile, band, job) =>
            {
                var (results, errors) = await new AgentReader().ReadAsync(connection, null, [AgentSql.CounterValues], (_, parameter) => parameter.Name == "@object" ? args.Object : args.Counter, job);
                if (errors.FirstOrDefault() is { } failed) return new AgentCounterValuesResult(null, watch.ElapsedMilliseconds, ReadFailure(failed));
                var rows = results[AgentSql.CounterValues.Id];
                var values = rows.Rows.Select(row => new AgentCounterValueDto(TextOf(rows.Value(row, "instance_name")), Convert.ToDouble(rows.Value(row, "cntr_value") ?? 0, CultureInfo.InvariantCulture))).ToList();
                var readAt = rows.Rows.Count > 0 ? TextOf(rows.Value(rows.Rows[0], "read_at")) : null;
                return new AgentCounterValuesResult(values, watch.ElapsedMilliseconds, null, rows.Truncated ? true : null, readAt);
            },
            error => new AgentCounterValuesResult(null, watch.ElapsedMilliseconds, error), "Reading the counter");
    }
}
