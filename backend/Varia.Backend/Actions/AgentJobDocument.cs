using System.Data;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;

namespace Varia.Backend.Actions;

/// <summary>The SQL Server Agent job document (AG-6a, docs/agent-plan.md › Jobs). Its describe reads the job (sp_help_job's JOB aspect), its
/// steps, the categories, the operators, Database Mail's readiness and, where the login and platform have them, the alerts that run it and the
/// logins the owner picker lists, all through <see cref="AgentReader"/>; a part the login may not read is left out, never an error. Its Save is the
/// action <c>agentJob</c>: one batch in one transaction (<see cref="AgentSql.JobSave"/>) that an existing job's identity and STALE guards open,
/// or New Job's sp_add_job and sp_add_jobserver on the Agent node. A refusal names the call that failed (the THROW state) and, where msdb's
/// text or number tells, the field (ActionError.Field).</summary>
internal sealed partial class ActionService
{
    internal const string SaveJobStep = "Save the job";
    internal const string CreateJobStep = "Create the job";
    internal const string JobReadOnlyMessage = "Only sysadmin and the job's owner can change it.";
    internal const string JobSaveAbortedMessage = "The save failed and nothing was saved.";

    /// <summary>Re-validates the agentJob request (src/shared/actions/schema.ts agentJobRequestSchema, agent-job.ts agentJobSaveProblems). Null for any
    /// other action, after refusing the job save's member on it. An existing job's targets the job with its identity (Script may leave the
    /// identity out); New Job's targets the SQL Server Agent node with none.</summary>
    private ObjectRefDto? ValidateAgentJob(ActionArgs args, bool script)
    {
        if (args.Action != "agentJob")
        {
            if (args.AgentJob is not null) throw Invalid(args.Action + " takes no agentJob.");
            return null;
        }
        if (args.AgentJob is not { } save) throw Invalid("agentJob.");
        var create = args.Target is { Kind: "agent" };
        ObjectRefDto target;
        if (create)
        {
            if (args.Target is not { Kind: "agent", Name: null, Database: null, Schema: null, Parent: null, SsisFolder: null, SsisProject: null }) throw Invalid("target.");
            target = Target(args.Target, "agentProperties");
            if (args.AgentIdentity is not null) throw Invalid("a new job has no identity.");
        }
        else
        {
            if (args.Target?.Kind != "agentJob") throw Invalid("target.");
            target = Target(args.Target, "agentJob");
            if (args.AgentIdentity is { } identity ? !AgentJobId(identity.JobId) : !script) throw Invalid("agentIdentity.");
        }
        if (args with { AgentJob = null, AgentIdentity = null } != new ActionArgs(args.Action, args.ConnectionId, args.RequestId, args.Target!)) throw Invalid("agentJob takes only the save and the job's identity.");
        var limits = AgentCatalog.Current;
        var names = (int)limits.Limit("nameChars");
        static bool Level(int? value) => value is null or (>= 0 and <= 3);
        bool Operator(string? value) => value is null || (value.Length <= names && !value.Contains('\0'));
        if (save.Name is not null && !ExplorerRefs.Ident(save.Name, names)) throw Invalid("agentJob.name.");
        if (save.Category is not null && !ExplorerRefs.Ident(save.Category, names)) throw Invalid("agentJob.category.");
        if (save.Owner is not null && !ExplorerRefs.Ident(save.Owner, names)) throw Invalid("agentJob.owner.");
        if (save.Description is { } description && (description.Length > limits.Limit("descriptionChars") || description.Contains('\0'))) throw Invalid("agentJob.description.");
        if (!Level(save.EmailLevel) || !Level(save.PageLevel) || !Level(save.NetSendLevel) || !Level(save.EventLogLevel) || !Level(save.DeleteLevel)) throw Invalid("agentJob levels.");
        if (!Operator(save.EmailOperator) || !Operator(save.PageOperator) || !Operator(save.NetSendOperator)) throw Invalid("agentJob operators.");
        foreach (var (level, name) in new[] { (save.EmailLevel, save.EmailOperator), (save.PageLevel, save.PageOperator), (save.NetSendLevel, save.NetSendOperator) })
        {
            if ((level is null) != (name is null)) throw Invalid("a notification goes as its level and operator together.");
            if (level is { } sent && (sent == 0) != (name == "")) throw Invalid("a notification names an operator exactly when it is sent.");
        }
        if (save.RemoveAlerts is { } alerts && (alerts.Count == 0 || alerts.Count > limits.Limit("jobAlerts") || alerts.Any(alert => alert.Id < 1 || !ExplorerRefs.Ident(alert.Name, names))
            || alerts.Select(alert => alert.Id).Distinct().Count() != alerts.Count)) throw Invalid("agentJob.removeAlerts.");
        if (create)
        {
            if (save.Version is not null || save.Modified is not null || save.Name is null || save.RemoveAlerts is not null) throw Invalid("a new job has a name, no version and no alerts.");
        }
        else
        {
            if (save.Version is not { } version || version < 0 || save.Modified is null || JobModified(save.Modified) is null) throw Invalid("agentJob.version.");
            if (save with { Version = null, Modified = null } == new AgentJobSaveDto()) throw Invalid("there is nothing to change.");
        }
        return target;
    }

    /// <summary>The modified date a save names, exactly yyyy-MM-ddTHH:mm:ss.fff inside datetime's range, or null.</summary>
    internal static DateTime? JobModified(string text) =>
        text.Length == 23 && DateTime.TryParseExact(text, "yyyy-MM-dd'T'HH:mm:ss.fff", CultureInfo.InvariantCulture, DateTimeStyles.None, out var value) && value.Year >= 1753 ? value : null;

    // --- Describe ----------------------------------------------------------------------------------------------------------

    private static int IntOf(object? value, int fallback = 0) => value is null or DBNull ? fallback : Convert.ToInt32(value, CultureInfo.InvariantCulture);
    private static string TextOf(object? value) => value is null or DBNull ? "" : Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";

    /// <summary>A sp_help_job run date and time (yyyymmdd, hhmmss) as yyyy-MM-ddTHH:mm:ss, or null when it never ran.</summary>
    internal static string? RunStamp(int date, int time)
    {
        if (date <= 0) return null;
        var text = date.ToString("00000000", CultureInfo.InvariantCulture) + time.ToString("000000", CultureInfo.InvariantCulture);
        return DateTime.TryParseExact(text, "yyyyMMddHHmmss", CultureInfo.InvariantCulture, DateTimeStyles.None, out var value) ? value.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture) : null;
    }

    private ActionError? ReadFailure(AgentReadError? failed) => failed is null ? null
        : Error(failed.Code switch { "AGENT_DISABLED" => "AGENT_STOPPED", "PERMISSION_DENIED" or "NOT_FOUND" or "NOT_SUPPORTED" or "TIMEOUT" => failed.Code, _ => "SQL_ERROR" },
            failed.Code == "AGENT_DISABLED" ? AgentStoppedMessage : failed.Message);

    /// <summary>The job document's describe: the job named by <paramref name="target"/> (an agentJob), or New Job's facts (the Agent node).</summary>
    private async Task<ActionDescribeResult> DescribeAgentJobDocumentAsync(SqlConnection connection, ServerProfile profile, ObjectRefDto target, CancellationToken token)
    {
        var catalogue = AgentCatalog.Current;
        if (catalogue.PlatformOf(profile.EngineEdition, profile.Linux) is not { } platform) return new(null, 0, Error("NOT_SUPPORTED", AgentProfileSql.Unsupported(profile.EngineEdition)));
        JobRow? row = null;
        if (target.Kind == "agentJob" && (row = await ReadJobAsync(connection, target.Name!, token)) is null) return new(null, 0, JobGone(target));
        var reader = new AgentReader();
        List<AgentStatement> first = [AgentSql.JobDocumentFacts, AgentSql.JobCategories, AgentSql.Operators, AgentSql.MailProfiles];
        if (row is not null) first.AddRange([AgentSql.JobDocument, AgentSql.JobDocumentSteps]);
        // New Job's Copy an existing job picks from the jobs msdb lets the login see.
        else first.Add(AgentSql.Jobs);
        var (results, errors) = await reader.ReadAsync(connection, null, first, (_, _) => row?.Id, token);
        AgentReadError? Failed(AgentStatement statement) => errors.FirstOrDefault(error => error.Statement == statement.Id);
        // What the document cannot open without: who the login is, and the job with its steps.
        foreach (var needed in new[] { AgentSql.JobDocumentFacts, AgentSql.JobDocument, AgentSql.JobDocumentSteps })
            if (ReadFailure(Failed(needed)) is { } failure) return new(null, 0, failure);
        var facts = results[AgentSql.JobDocumentFacts.Id];
        if (facts.Rows.Count == 0) return new(null, 0, Error("SQL_ERROR", AgentReader.FailedMessage));
        var login = TextOf(facts.Value(facts.Rows[0], "login_name"));
        var sysadmin = IntOf(facts.Value(facts.Rows[0], "is_sysadmin")) == 1;
        int? mailXps = facts.Value(facts.Rows[0], "mail_xps") is { } xps and not DBNull ? IntOf(xps) : null;
        var categories = results.TryGetValue(AgentSql.JobCategories.Id, out var categoryRows) ? categoryRows.Rows.Select(item => TextOf(categoryRows.Value(item, "name"))).Where(name => name.Length > 0).ToList() : [];
        List<AgentJobOperatorDto>? operators = null;
        if (Failed(AgentSql.Operators) is null && results.TryGetValue(AgentSql.Operators.Id, out var operatorRows))
            operators = [.. operatorRows.Rows.Select(item =>
            {
                object? Value(string column) => operatorRows.Value(item, column);
                return new AgentJobOperatorDto(TextOf(Value("name")), IntOf(Value("enabled")) == 1, TextOf(Value("email_address")).Trim().Length > 0, TextOf(Value("pager_address")).Trim().Length > 0,
                    TextOf(Value("netsend_address")).Trim().Length > 0, IntOf(Value("pager_days")),
                    new(IntOf(Value("weekday_pager_start_time")), IntOf(Value("weekday_pager_end_time"))), new(IntOf(Value("saturday_pager_start_time")), IntOf(Value("saturday_pager_end_time"))),
                    new(IntOf(Value("sunday_pager_start_time")), IntOf(Value("sunday_pager_end_time"))));
            })];
        var mailChecked = Failed(AgentSql.MailProfiles) is null && results.ContainsKey(AgentSql.MailProfiles.Id);
        int? profiles = mailChecked ? results[AgentSql.MailProfiles.Id].Rows.Count : null;

        AgentJobRecordDto? job = null;
        var steps = new List<AgentJobStepRowDto>();
        if (row is not null)
        {
            var jobRows = results[AgentSql.JobDocument.Id];
            if (jobRows.Rows.Count == 0) return new(null, 0, JobGone(target));
            object? Value(string column) => jobRows.Value(jobRows.Rows[0], column);
            var modified = Value("date_modified") is DateTime changed ? changed.ToString("yyyy-MM-dd'T'HH:mm:ss.fff", CultureInfo.InvariantCulture) : "";
            int? outcome = Value("last_run_outcome") is { } last and not DBNull ? IntOf(last) : null;
            // sp_help_job names a missing operator with message 14205 ("(unknown)" in English); a level of 0 sends to nobody, so its operator is ''.
            string Operator(string level, string name) => IntOf(Value(level)) == 0 ? "" : TextOf(Value(name));
            job = new(row.Id.ToString("D"), row.Name, IntOf(Value("enabled")) == 1, TextOf(Value("description")), TextOf(Value("category")), TextOf(Value("owner")),
                IntOf(Value("notify_level_email")), Operator("notify_level_email", "notify_email_operator"), IntOf(Value("notify_level_page")), Operator("notify_level_page", "notify_page_operator"),
                IntOf(Value("notify_level_netsend")), Operator("notify_level_netsend", "notify_netsend_operator"), IntOf(Value("notify_level_eventlog")), IntOf(Value("delete_level")),
                row.Created, modified, IntOf(Value("version_number")), IntOf(Value("start_step_id"), 1), RunStamp(IntOf(Value("last_run_date")), IntOf(Value("last_run_time"))), outcome);
            var stepRows = results[AgentSql.JobDocumentSteps.Id];
            steps = [.. stepRows.Rows.Select(item => new AgentJobStepRowDto(IntOf(stepRows.Value(item, "step_id")), TextOf(stepRows.Value(item, "step_name")), TextOf(stepRows.Value(item, "subsystem"))))];
        }

        // The second read: sysadmin's own (Agent's mail profile, the owner picker), and the alerts where the platform has them. Each may fail alone.
        List<AgentStatement> second = [];
        var alertsOffered = row is not null && catalogue.Offers("alerts", platform);
        if (alertsOffered) second.Add(AgentSql.Alerts);
        if (sysadmin) second.AddRange([AgentSql.AgentMail, AgentSql.OwnerLogins]);
        Dictionary<string, AgentResult> more = [];
        List<AgentReadError> moreErrors = [];
        if (second.Count > 0) (more, moreErrors) = await reader.ReadAsync(connection, null, second, (_, _) => null, token);
        bool Read(AgentStatement statement, out AgentResult result) => more.TryGetValue(statement.Id, out result!) && moreErrors.All(error => error.Statement != statement.Id);
        List<AgentJobAlertDto>? alerts = null;
        if (alertsOffered && Read(AgentSql.Alerts, out var alertRows))
            alerts = [.. alertRows.Rows.Where(item => alertRows.Value(item, "job_id") is Guid id && id == row!.Id)
                .Select(item => new AgentJobAlertDto(IntOf(alertRows.Value(item, "id")), TextOf(alertRows.Value(item, "name")), IntOf(alertRows.Value(item, "enabled")) == 1,
                    IntOf(alertRows.Value(item, "severity")), IntOf(alertRows.Value(item, "message_id"))))
                .Take((int)catalogue.Limit("jobAlerts"))];
        bool? useDatabaseMail = null;
        string? agentProfile = null;
        if (sysadmin && Read(AgentSql.AgentMail, out var mailRows) && mailRows.Rows.Count > 0)
        {
            useDatabaseMail = IntOf(mailRows.Value(mailRows.Rows[0], "use_databasemail")) == 1;
            agentProfile = TextOf(mailRows.Value(mailRows.Rows[0], "databasemail_profile")) is { Length: > 0 } named ? named : null;
        }
        List<string>? owners = sysadmin && Read(AgentSql.OwnerLogins, out var ownerRows) ? [.. ownerRows.Rows.Select(item => TextOf(ownerRows.Value(item, "name")))] : null;

        // By name, each with its job id (JobIds, same order), so a document whose job was renamed elsewhere can find it again.
        var listed = row is null && Failed(AgentSql.Jobs) is null && results.TryGetValue(AgentSql.Jobs.Id, out var jobList)
            ? jobList.Rows.Select(item => (Name: TextOf(jobList.Value(item, "name")), Id: jobList.Value(item, "job_id") is Guid id ? id.ToString("D") : ""))
                .Where(entry => entry.Name.Length > 0 && entry.Id.Length > 0).OrderBy(entry => entry.Name, StringComparer.CurrentCultureIgnoreCase).ToList() : null;
        List<string>? jobs = listed?.Select(entry => entry.Name).ToList();
        List<string>? jobIds = listed?.Select(entry => entry.Id).ToList();
        var readOnly = job is not null && !sysadmin && !string.Equals(job.Owner, login, StringComparison.OrdinalIgnoreCase) ? JobReadOnlyMessage : null;
        var mail = new AgentJobMailDto(mailChecked, sysadmin, mailXps is { } on ? on == 1 : null, profiles, useDatabaseMail, agentProfile);
        return new(null, 0, AgentJobDocument: new(job, login, sysadmin, platform, categories, steps, alerts is not null && sysadmin, mail, readOnly, operators, owners, alerts, jobs, jobIds));
    }

    // --- Plan --------------------------------------------------------------------------------------------------------------

    /// <summary>The save's calls and batch: New Job's sp_add_job with every argument the request sets (an operator only with a level above 0,
    /// none NULL, so sp_add_job's own defaults stand), then sp_add_jobserver; an existing job's sp_update_job with only the changed arguments
    /// (an operator '' clears it) unless only alerts change, then one detach per removed alert.</summary>
    internal static AgentSaveBatch AgentJobSavePlan(ActionArgs args, ObjectRefDto target)
    {
        var save = args.AgentJob!;
        var create = target.Kind == "agent";
        var jobId = new AgentParameter("@job_id", SqlDbType.UniqueIdentifier);
        object? ValueOf(string argument) => argument switch
        {
            "@enabled" => save.Enabled is { } enabled ? (byte)(enabled ? 1 : 0) : null,
            "@description" => save.Description,
            "@category_name" => save.Category,
            "@owner_login_name" => save.Owner,
            "@notify_level_eventlog" => save.EventLogLevel,
            "@notify_level_email" => save.EmailLevel,
            "@notify_level_netsend" => save.NetSendLevel,
            "@notify_level_page" => save.PageLevel,
            "@notify_email_operator_name" => save.EmailOperator,
            "@notify_netsend_operator_name" => save.NetSendOperator,
            "@notify_page_operator_name" => save.PageOperator,
            "@delete_level" => save.DeleteLevel,
            _ => throw new InvalidOperationException("Not a job argument.")
        };
        var arguments = new List<AgentSaveArgument>();
        if (create) arguments.Add(new("@job_name", new("@job_name", SqlDbType.NVarChar, 128), save.Name));
        else
        {
            arguments.Add(new("@job_id", jobId, null));
            if (save.Name is not null) arguments.Add(new("@new_name", new("@new_name", SqlDbType.NVarChar, 128), save.Name));
        }
        foreach (var (argument, type, size, _) in AgentSql.JobArguments)
        {
            var value = ValueOf(argument);
            // New Job leaves an unset operator to sp_add_job's default (none): '' is how sp_update_job clears one.
            if (value is null || (create && value is "")) continue;
            arguments.Add(new(argument, new(argument, type, size), value));
        }
        var calls = new List<AgentSaveCall>();
        if (create)
        {
            arguments.Add(new("@job_id", jobId, null, Output: true));
            calls.Add(new("sp_add_job", arguments));
            calls.Add(new("sp_add_jobserver", [new("@job_id", jobId, null)]));
        }
        else if (arguments.Count > 1) calls.Add(new("sp_update_job", arguments));
        foreach (var alert in save.RemoveAlerts ?? []) calls.Add(AgentSql.DetachAlert(calls.Count + 1, alert.Id, alert.Name));
        return create ? AgentSql.JobSave(true, calls) : AgentSql.JobSave(false, calls, target.Name, args.AgentIdentity is { } identity ? Guid.ParseExact(identity.JobId, "D") : null, save.Version, JobModified(save.Modified!));
    }

    // --- Execute -----------------------------------------------------------------------------------------------------------

    private async Task<ActionExecuteResult> ExecuteAgentJobDocumentAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, CancellationToken token)
    {
        var batch = AgentJobSavePlan(args, target);
        var create = target.Kind == "agent";
        var messages = CollectMessages(connection);
        var step = new RunStep(create ? CreateJobStep : SaveJobStep, async context =>
        {
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
                throw new StepRefusedException(JobSaveError(error, batch, connection));
            }
            finally
            {
                // XACT_ABORT has rolled back a failed batch's transaction already (its Connection is then null).
                if (!committed && open.Connection is not null)
                {
                    try { await open.RollbackAsync(CancellationToken.None).WaitAsync(Options.StopGrace, CancellationToken.None); }
                    catch (Exception) { try { await connection.CloseAsync(); } catch (Exception) { } }
                }
                await open.DisposeAsync();
            }
        }, Detail: args.AgentJob?.Name ?? target.Name);
        var (steps, failure, _) = await RunStepsAsync(connection, [step], null, token, CleanupBudget(args.Action));
        return new(steps, messages.Collected(), 0, failure);
    }

    // 14234 quotes the argument ("The specified '@category_name' is invalid"), 14262 does not ("The specified @owner_login_name ('bob') does
    // not exist"); either way the argument comes before any value msdb quotes back.
    [GeneratedRegex(@"(?<arg>@[a-z_]+)", RegexOptions.CultureInvariant)]
    private static partial Regex NamedArgument();

    /// <summary>What a refused save says. 50011 is STALE; 50010 NOT_FOUND (another job has the name). Otherwise msdb's own error maps by number
    /// (ActionErrors), and the THROW's state names the call that failed: the message says which part, and the field is the argument msdb's text
    /// names ('@category_name'), else the name for NAME_IN_USE, the alerts for a detach, or the one argument a call changed. With no THROW (the batch
    /// aborted first) nothing was saved and no part is named.</summary>
    internal ActionError JobSaveError(SqlException error, AgentSaveBatch batch, SqlConnection? connection)
    {
        var errors = error.Errors.Cast<SqlError>().ToList();
        var first = errors.FirstOrDefault(item => item.Class > 10)?.Number ?? error.Number;
        if (first == 50011) return Error("STALE", AgentSql.StaleMessage);
        if (first == 50010) return Error("NOT_FOUND", AgentSql.ChangedMessage);
        if (first == 15281) return Error("AGENT_STOPPED", AgentStoppedMessage);
        var mapped = ActionErrors.FromSql(catalog, error, connection, ddl: true, null);
        // NOT_FOUND is the job itself (50010 above), which the document answers with the compare; msdb's own "does not exist" (14262: an owner,
        // an operator, an alert) is a refused value, not retryable as it stands.
        if (mapped.Code == "NOT_FOUND") mapped = mapped with { Code = "SQL_ERROR", Retryable = false };
        var text = string.Join(" ", errors.Where(item => item.Class > 10 && item.Number is not (50012 or 3621 or 3998)).Select(item => item.Message).Distinct());
        var thrown = errors.FirstOrDefault(item => item.Number == 50012);
        if (thrown is null || thrown.State < 1 || thrown.State > batch.Calls.Count)
            return ActionErrors.Create(catalog, mapped.Code, JobSaveAbortedMessage + (text.Length > 0 ? " " + text : "")) with { Retryable = mapped.Retryable };
        var call = batch.Calls[thrown.State - 1];
        var part = call.Procedure switch
        {
            "sp_add_job" => "creating the job",
            "sp_add_jobserver" => "targeting this server",
            "sp_update_alert" => "removing alert '" + (call.Arguments.FirstOrDefault(argument => argument.Name == "@name")?.Value as string ?? "") + "'",
            _ => "the job's settings"
        };
        string? field = NamedArgument().Matches(text).Select(match => AgentSql.FieldOfArgument(match.Groups["arg"].Value)).FirstOrDefault(found => found is not null);
        if (field is null && mapped.Code == "NAME_IN_USE" && call.Procedure is "sp_add_job" or "sp_update_job") field = "name";
        if (field is null && call.Procedure == "sp_update_alert") field = "alerts";
        if (field is null && call.Procedure is "sp_update_job" or "sp_add_job")
        {
            var changed = call.Arguments.Select(argument => AgentSql.FieldOfArgument(argument.Name)).Where(found => found is not null).Distinct().ToList();
            if (changed.Count == 1) field = changed[0];
        }
        var message = "Saving " + part + " was refused: " + (text.Length > 0 ? text : AgentSql.RefusedMessage);
        return ActionErrors.Create(catalog, mapped.Code, message) with { Field = field, Retryable = mapped.Retryable };
    }

    // --- Script ------------------------------------------------------------------------------------------------------------

    /// <summary>The save's script in SSMS's job-script shape: one transaction, each call followed by its return-code check and
    /// <c>GOTO QuitWithRollback</c>, by the job's name (Script reads nothing, so it needs no identity or version) with literal values.</summary>
    internal static string AgentJobDocumentScript(ActionArgs args, ObjectRefDto target)
    {
        var batch = AgentJobSavePlan(args, target);
        var create = target.Kind == "agent";
        static string Value(object? value) => value switch
        {
            null => "NULL",
            string text => Literal(text),
            byte or int => Convert.ToString(value, CultureInfo.InvariantCulture)!,
            Guid id => Literal(id.ToString("D")),
            _ => throw new InvalidOperationException("Not a script value.")
        };
        var text = new StringBuilder("USE [msdb]\nGO\nBEGIN TRANSACTION\nDECLARE @ReturnCode INT\nSELECT @ReturnCode = 0\n");
        if (create) text.Append("DECLARE @jobId BINARY(16)\n");
        foreach (var call in batch.Calls)
        {
            var parts = call.Arguments.Select(argument => argument.Name switch
            {
                "@job_id" when argument.Output => "@job_id = @jobId OUTPUT",
                "@job_id" when call.Procedure == "sp_update_alert" => "@job_id=" + Value(Guid.Empty),
                "@job_id" when create => "@job_id = @jobId",
                "@job_id" => "@job_name=" + Literal(target.Name!),
                _ => argument.Name + "=" + Value(argument.Value)
            });
            if (call.Procedure == "sp_add_jobserver") parts = parts.Append("@server_name = N'(local)'");
            text.Append("EXEC @ReturnCode = msdb.dbo.").Append(call.Procedure).Append(' ').Append(string.Join(", \n\t\t", parts)).Append('\n')
                .Append("IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback\n");
        }
        text.Append("COMMIT TRANSACTION\nGOTO EndSave\nQuitWithRollback:\n    IF (@@TRANCOUNT > 0) ROLLBACK TRANSACTION\nEndSave:\nGO\n");
        return text.ToString();
    }

    private Task<ActionScriptResult> ScriptAgentJobDocument(ActionArgs args, ObjectRefDto target)
    {
        var engine = host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine;
        if (!Serves(args.Action, engine)) return Task.FromResult(new ActionScriptResult(null, "msdb", [], Error("NOT_SUPPORTED", EngineMessage(engine))));
        return Task.FromResult(new ActionScriptResult(AgentJobDocumentScript(args, target), "msdb", []));
    }
}
