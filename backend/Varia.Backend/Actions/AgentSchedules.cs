using System.Data;
using System.Globalization;
using System.Text;
using Microsoft.Data.SqlClient;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;

namespace Varia.Backend.Actions;

/// <summary>SQL Server Agent schedules (AG-6c, docs/agent-plan.md › Schedules). The describe <c>agentSchedules</c> on the SQL Server Agent node
/// reads the schedules the login may see with their owners and versions, the jobs, which job uses which (sysadmin) and each job's usual
/// duration; with a schedule id it reads only that schedule's jobs. The action <c>agentSchedule</c> is the Schedules document's and New ›
/// Schedule…'s save (<see cref="AgentSql.ScheduleSave"/>); the job document's Schedules section saves with its job
/// (<see cref="AgentJobSavePlan"/>). Both are validated here as in src/shared/actions/agent-schedule.ts.</summary>
internal sealed partial class ActionService
{
    internal const string SaveScheduleStep = "Save the schedule";
    internal const string CreateScheduleStep = "Create the schedule";
    internal const string DeleteScheduleStep = "Delete the schedule";
    /// <summary>How many of a job's newest successful runs its usual duration is the median of.</summary>
    internal const int DurationRuns = 10;
    private static readonly string[] ScheduleOps = ["create", "update", "enable", "disable", "delete"];

    // --- Validation --------------------------------------------------------------------------------------------------------

    /// <summary>Whether yyyymmdd is a date sp_verify_schedule accepts (19900101 to 99991231).</summary>
    internal static bool ScheduleDate(int date) => date is >= 19_900_101 and <= 99_991_231
        && DateTime.TryParseExact(date.ToString("00000000", CultureInfo.InvariantCulture), "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _);
    /// <summary>Whether hhmmss is a time of day.</summary>
    internal static bool ScheduleTime(int time) => time is >= 0 and <= 235_959 && time / 100 % 100 < 60 && time % 100 < 60;

    /// <summary>Why a timing is not one sp_verify_schedule accepts, or null (agent-schedule.ts scheduleTimingSchema and timingProblem).</summary>
    internal static string? ScheduleTimingProblem(AgentScheduleTimingDto t)
    {
        if (!ScheduleDate(t.ActiveStartDate) || !ScheduleDate(t.ActiveEndDate) || !ScheduleTime(t.ActiveStartTime) || !ScheduleTime(t.ActiveEndTime)) return "dates and times";
        if (t.FreqType is not (1 or 4 or 8 or 16 or 32 or 64 or 128) || t.FreqInterval < 0 || t.FreqSubdayType is not (0 or 1 or 2 or 4 or 8) || t.FreqSubdayInterval < 0
            || t.FreqRelativeInterval is not (0 or 1 or 2 or 4 or 8 or 16) || t.FreqRecurrenceFactor < 0) return "ranges";
        if (t.ActiveEndDate < t.ActiveStartDate) return "end date";
        switch (t.FreqType)
        {
            case 1 or 64 or 128:
                return t.FreqInterval != 0 || t.FreqSubdayType != 0 || t.FreqSubdayInterval != 0 || t.FreqRelativeInterval != 0 || t.FreqRecurrenceFactor != 0 ? "frequency" : null;
            // msdb sets no upper bound on a daily interval or a recurrence factor (SSMS's dialog does; Varia warns past it).
            case 4 when t.FreqInterval < 1 || t.FreqRecurrenceFactor != 0: return "daily";
            case 8 when t.FreqInterval is < 1 or > 127 || t.FreqRecurrenceFactor < 1: return "weekly";
            case 16 when t.FreqInterval is < 1 or > 31 || t.FreqRecurrenceFactor < 1: return "monthly";
            case 32 when t.FreqInterval is < 1 or > 10 || t.FreqRelativeInterval < 1 || t.FreqRecurrenceFactor < 1: return "relative";
        }
        if (t.FreqType != 32 && t.FreqRelativeInterval != 0) return "relative interval";
        if (t.FreqSubdayType is 0 or 1) return t.FreqSubdayInterval != 0 ? "daily interval" : null;
        if (t.FreqSubdayInterval < 1 || (t.FreqSubdayType == 2 && t.FreqSubdayInterval < 10)) return "daily interval";
        // sp_verify_schedule stores an end of 00:00:00 as 23:59:59.
        return t.ActiveStartTime == (t.ActiveEndTime == 0 ? 235959 : t.ActiveEndTime) ? "start and end times" : null;
    }

    private static bool ScheduleGuardValid(int? id, int? version, string? modified) => id >= 1 && version >= 0 && modified is not null && JobModified(modified) is not null;

    /// <summary>Re-validates a job save's Schedules part (agent-schedule.ts jobSchedulesSaveSchema, jobSchedulesSaveProblems; New Job's rules in
    /// agentJobSaveProblems).</summary>
    private void ValidateJobSchedules(AgentJobSchedulesSaveDto save, bool create)
    {
        var limits = AgentCatalog.Current;
        var perJob = (int)limits.Limit("schedulesPerJob");
        var names = (int)limits.Limit("nameChars");
        bool Count<T>(List<T>? items) => items is null || (items.Count >= 1 && items.Count <= perJob);
        if (!Count(save.Detach) || !Count(save.Update) || !Count(save.Attach) || !Count(save.Add)) throw Invalid("agentJob.schedules.");
        if (save == new AgentJobSchedulesSaveDto()) throw Invalid("agentJob.schedules changes nothing.");
        if ((save.Detach ?? []).Any(item => item.Id < 1)) throw Invalid("agentJob.schedules.detach.");
        foreach (var item in save.Update ?? [])
        {
            if (!ScheduleGuardValid(item.Id, item.Version, item.Modified)) throw Invalid("agentJob.schedules.update.");
            if (item.Name is null && item.Enabled is null && item.Timing is null) throw Invalid("a schedule update changes nothing.");
            if (item.Name is { } name && !ExplorerRefs.Ident(name, names)) throw Invalid("agentJob.schedules.update.name.");
        }
        if ((save.Attach ?? []).Any(item => !ScheduleGuardValid(item.Id, item.Version, item.Modified))) throw Invalid("agentJob.schedules.attach.");
        foreach (var item in save.Add ?? [])
            if (item.Id is not null || item.Version is not null || item.Modified is not null || item.Name is null || !ExplorerRefs.Ident(item.Name, names) || item.Enabled is null || item.Timing is null)
                throw Invalid("agentJob.schedules.add.");
        foreach (var timing in (save.Update ?? []).Select(item => item.Timing).Concat((save.Add ?? []).Select(item => item.Timing)))
            if (timing is not null && ScheduleTimingProblem(timing) is not null) throw Invalid("agentJob.schedules timing.");
        var linked = (save.Detach ?? []).Select(item => item.Id).Concat((save.Attach ?? []).Select(item => item.Id)).ToList();
        if (linked.Distinct().Count() != linked.Count) throw Invalid("a schedule is attached or detached twice.");
        var updated = (save.Update ?? []).Select(item => item.Id!.Value).ToList();
        if (updated.Distinct().Count() != updated.Count || updated.Any(id => (save.Detach ?? []).Any(item => item.Id == id))) throw Invalid("a schedule is updated twice, or after its detach.");
        if ((save.Detach?.Count ?? 0) + (save.Update?.Count ?? 0) + (save.Attach?.Count ?? 0) + (save.Add?.Count ?? 0) > perJob * 2) throw Invalid("too many schedule changes.");
        if (create && (save.Detach is not null || updated.Any(id => !(save.Attach ?? []).Any(item => item.Id == id)))) throw Invalid("a new job has no schedule of its own to detach or change.");
    }

    /// <summary>Re-validates the agentSchedule request (schema.ts agentScheduleRequestSchema, agent-schedule.ts scheduleSaveProblems). Null for any
    /// other action, after refusing the schedule save's member on it.</summary>
    private ObjectRefDto? ValidateAgentSchedule(ActionArgs args)
    {
        if (args.Action != "agentSchedule")
        {
            if (args.AgentSchedule is not null) throw Invalid(args.Action + " takes no agentSchedule.");
            return null;
        }
        if (args.AgentSchedule is not { } save) throw Invalid("agentSchedule.");
        if (args.Target is not { Kind: "agent", Name: null, Database: null, Schema: null, Parent: null, SsisFolder: null, SsisProject: null }) throw Invalid("target.");
        var target = Target(args.Target, "agentSchedule");
        if (args with { AgentSchedule = null } != new ActionArgs(args.Action, args.ConnectionId, args.RequestId, args.Target)) throw Invalid("agentSchedule takes only its save.");
        var limits = AgentCatalog.Current;
        if (!ScheduleOps.Contains(save.Op)) throw Invalid("agentSchedule.op.");
        if (save.Name is not null && !ExplorerRefs.Ident(save.Name, (int)limits.Limit("nameChars"))) throw Invalid("agentSchedule.name.");
        if (save.Timing is { } timing && ScheduleTimingProblem(timing) is not null) throw Invalid("agentSchedule.timing.");
        if (save.Schedule is { } guard && !ScheduleGuardValid(guard.Id, guard.Version, guard.Modified)) throw Invalid("agentSchedule.schedule.");
        if (save.Jobs is { } jobs && (jobs.Count < 1 || jobs.Count > limits.Limit("scheduleJobChanges") || jobs.Any(job => !AgentJobId(job.JobId) || job.Version < 0)
            || jobs.Select(job => job.JobId.ToLowerInvariant()).Distinct().Count() != jobs.Count)) throw Invalid("agentSchedule.jobs.");
        var values = save.Name is not null || save.Enabled is not null || save.Timing is not null;
        switch (save.Op)
        {
            case "create":
                if (save.Schedule is not null || save.Name is null || save.Enabled is null || save.Timing is null || (save.Jobs ?? []).Any(job => !job.Attach)) throw Invalid("a new schedule has its values, no identity and no job to detach.");
                break;
            case "update":
                if (save.Schedule is null || (!values && save.Jobs is null)) throw Invalid("a schedule's save names its version and a change.");
                break;
            default:
                if (save.Schedule is null || values || save.Jobs is not null) throw Invalid(save.Op + " takes only the schedule.");
                break;
        }
        return target;
    }

    // --- Plan --------------------------------------------------------------------------------------------------------------

    /// <summary>A timing as sp_add_schedule's arguments take it, in <see cref="AgentSql.TimingArguments"/>' order.</summary>
    internal static int[]? TimingValues(AgentScheduleTimingDto? t) => t is null ? null :
        [t.FreqType, t.FreqInterval, t.FreqSubdayType, t.FreqSubdayInterval, t.FreqRelativeInterval, t.FreqRecurrenceFactor, t.ActiveStartDate, t.ActiveEndDate, t.ActiveStartTime, t.ActiveEndTime];

    /// <summary>A job save's schedule calls after its own <paramref name="calls"/>: detach, attach, update, add (agent-schedule.ts AgentJobSchedulesSave).
    /// Attach comes before update: sp_attach_schedule leaves sysschedules as it is, so a picked schedule edited in the same save passes
    /// both guards, where sp_update_schedule first would move its version and fail the attach's guard.</summary>
    internal static void AddJobScheduleCalls(AgentJobSchedulesSaveDto? save, List<AgentSaveCall> calls)
    {
        if (save is null) return;
        foreach (var item in save.Detach ?? []) calls.Add(AgentSql.DetachSchedule(calls.Count + 1, item.Id, item.DeleteUnused));
        foreach (var item in save.Attach ?? []) calls.Add(AgentSql.AttachSchedule(calls.Count + 1, item.Id, new(item.Version, JobModified(item.Modified)!.Value)));
        foreach (var item in save.Update ?? [])
            calls.Add(AgentSql.UpdateSchedule(calls.Count + 1, item.Id!.Value, new(item.Version!.Value, JobModified(item.Modified!)!.Value), item.Name, item.Enabled, TimingValues(item.Timing)));
        foreach (var item in save.Add ?? []) calls.Add(AgentSql.AddJobSchedule(calls.Count + 1, item.Name!, item.Enabled!.Value, TimingValues(item.Timing)!));
    }

    /// <summary>The Schedules document's batch for a validated save.</summary>
    internal static AgentSaveBatch AgentSchedulePlan(AgentScheduleSaveDto save) =>
        AgentSql.ScheduleSave(save.Op, save.Schedule?.Id, save.Schedule?.Version, save.Schedule is { } guard ? JobModified(guard.Modified) : null, save.Name, save.Enabled, TimingValues(save.Timing),
            [.. (save.Jobs ?? []).Select(job => (Guid.ParseExact(job.JobId, "D"), job.Version, job.Attach))]);

    // --- Describe ----------------------------------------------------------------------------------------------------------

    private static string? Modified(object? value) => value is DateTime changed ? changed.ToString("yyyy-MM-dd'T'HH:mm:ss.fff", CultureInfo.InvariantCulture) : null;
    private static string ClockOf(Dictionary<string, AgentResult> results) =>
        results.TryGetValue(AgentSql.ServerClock.Id, out var clock) && clock.Rows.Count > 0 && clock.Value(clock.Rows[0], "server_now") is DateTime now
            ? now.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture) : DateTime.Now.ToString("yyyy-MM-dd'T'HH:mm:ss", CultureInfo.InvariantCulture);

    /// <summary>Schedules as sp_help_schedule or sp_help_jobschedule list them, each with the owner, version and modified date
    /// <paramref name="versions"/> (sysschedules_localserver_view) lists for it. A schedule whose owner SID is the connection's own
    /// (<paramref name="principalId"/>, ConnectionPrincipal.FromSid) is <paramref name="login"/>'s, even without a server_principals row.</summary>
    internal static List<AgentScheduleRecordDto> ScheduleRecords(AgentResult rows, AgentResult? versions, string? login = null, string? principalId = null)
    {
        var known = new Dictionary<int, (int Version, string? Modified, string? Owner)>();
        if (versions is not null)
            foreach (var row in versions.Rows)
            {
                var own = principalId is not null && login is not null && ConnectionPrincipal.FromSid(versions.Value(row, "owner_sid") as byte[]) == principalId;
                known[IntOf(versions.Value(row, "schedule_id"))] = (IntOf(versions.Value(row, "version_number")), Modified(versions.Value(row, "date_modified")),
                    own ? login : versions.Value(row, "owner") is string owner ? owner : null);
            }
        return [.. rows.Rows.Select(row =>
        {
            int Value(string column) => IntOf(rows.Value(row, column));
            var id = Value("schedule_id");
            var found = known.TryGetValue(id, out var facts);
            return new AgentScheduleRecordDto(id, TextOf(rows.Value(row, "schedule_name")), Value("enabled") == 1, Value("freq_type"), Value("freq_interval"), Value("freq_subday_type"),
                Value("freq_subday_interval"), Value("freq_relative_interval"), Value("freq_recurrence_factor"), Value("active_start_date"), Value("active_end_date"), Value("active_start_time"),
                Value("active_end_time"), Value("job_count"), found ? facts.Owner : null, found ? facts.Version : null, found ? facts.Modified : null);
        })];
    }

    private static List<AgentScheduleJobDto> ScheduleJobs(AgentResult rows) =>
        [.. rows.Rows.Where(row => rows.Value(row, "job_id") is Guid).Select(row => new AgentScheduleJobDto(((Guid)rows.Value(row, "job_id")!).ToString("D"), TextOf(rows.Value(row, "name")),
            IntOf(rows.Value(row, "enabled")) == 1, TextOf(rows.Value(row, "owner")), IntOf(rows.Value(row, "version_number"))))
            .OrderBy(job => job.Name, StringComparer.CurrentCultureIgnoreCase)];

    /// <summary>A link with sysjobschedules' next run when Agent has written a valid one (next_run_date is 0 until it does, and it is only
    /// rewritten on Agent's periodic write, so it can predate the schedule's last change), and the job's next run from sysjobactivity, which
    /// Agent rewrites as soon as a schedule is attached or changed.</summary>
    internal static AgentScheduleLinkDto NextRunOf(AgentScheduleLinkDto link, int date, int time, object? jobNext = null)
    {
        var withLink = date is >= 19_900_101 and <= 99_991_231 && time is >= 0 and <= 235_959 ? link with { NextRunDate = date, NextRunTime = time } : link;
        return jobNext is DateTime at && at.Year is >= 1990 and <= 9999
            ? withLink with { JobNextRunDate = at.Year * 10_000 + at.Month * 100 + at.Day, JobNextRunTime = at.Hour * 10_000 + at.Minute * 100 + at.Second }
            : withLink;
    }

    /// <summary>Each job's usual duration: the median of its newest <see cref="DurationRuns"/> successful runs (run_duration hhmmss) in <paramref name="rows"/>.</summary>
    internal static List<AgentJobDurationDto> JobDurations(AgentResult rows)
    {
        var runs = new Dictionary<Guid, List<int>>();
        foreach (var row in rows.Rows)
        {
            if (rows.Value(row, "job_id") is not Guid id) continue;
            var encoded = IntOf(rows.Value(row, "run_duration"));
            var list = runs.TryGetValue(id, out var found) ? found : runs[id] = [];
            if (list.Count < DurationRuns) list.Add(encoded / 10_000 * 3_600 + encoded / 100 % 100 * 60 + encoded % 100);
        }
        return [.. runs.Select(entry =>
        {
            var sorted = entry.Value.Order().ToList();
            var middle = sorted.Count / 2;
            var median = sorted.Count % 2 == 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
            return new AgentJobDurationDto(entry.Key.ToString("D"), median);
        })];
    }

    /// <summary>The Schedules describe's reads: every login's, then sysadmin's (the links, the durations only the free-slot check uses, and
    /// the idle condition).</summary>
    internal static readonly AgentStatement[] SchedulesRead = [AgentSql.JobDocumentFacts, AgentSql.ServerClock, AgentSql.Schedules, AgentSql.ScheduleVersions, AgentSql.Jobs];
    internal static readonly AgentStatement[] SchedulesSysadminRead = [AgentSql.ScheduleLinks, AgentSql.JobDurations, AgentSql.IdleCondition];

    /// <summary>The Schedules describe: everything the document shows, or with <paramref name="schedule"/> one schedule's jobs.</summary>
    private async Task<ActionDescribeResult> DescribeAgentSchedulesAsync(SqlConnection connection, ServerProfile profile, int? schedule, CancellationToken token)
    {
        var catalogue = AgentCatalog.Current;
        if (catalogue.PlatformOf(profile.EngineEdition, profile.Linux) is not { } platform) return new(null, 0, Error("NOT_SUPPORTED", AgentProfileSql.Unsupported(profile.EngineEdition)));
        var reader = new AgentReader();
        List<AgentStatement> first = schedule is null
            ? [.. SchedulesRead]
            : [AgentSql.JobDocumentFacts, AgentSql.ServerClock, AgentSql.JobsInSchedule];
        var (results, errors) = await reader.ReadAsync(connection, null, first, (_, parameter) => parameter.Name switch
        {
            "@schedule_id" => schedule,
            _ => null
        }, token);
        AgentReadError? Failed(AgentStatement statement) => errors.FirstOrDefault(error => error.Statement == statement.Id);
        bool Read(AgentStatement statement, out AgentResult result) => results.TryGetValue(statement.Id, out result!) && Failed(statement) is null;
        foreach (var needed in new[] { AgentSql.JobDocumentFacts, schedule is null ? AgentSql.Schedules : AgentSql.JobsInSchedule })
            if (ReadFailure(Failed(needed)) is { } failure) return new(null, 0, failure);
        var facts = results[AgentSql.JobDocumentFacts.Id];
        if (facts.Rows.Count == 0) return new(null, 0, Error("SQL_ERROR", AgentReader.FailedMessage));
        var login = TextOf(facts.Value(facts.Rows[0], "login_name"));
        var sysadmin = IntOf(facts.Value(facts.Rows[0], "is_sysadmin")) == 1;
        var now = ClockOf(results);
        if (schedule is not null)
            return new(null, 0, AgentSchedules: new(login, sysadmin, platform, now, [], ScheduleJobs: ScheduleJobs(results[AgentSql.JobsInSchedule.Id])));
        var listed = results[AgentSql.Schedules.Id];
        var records = ScheduleRecords(listed, Read(AgentSql.ScheduleVersions, out var versions) ? versions : null, login, profile.PrincipalId).OrderBy(record => record.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
        List<AgentScheduleJobDto>? jobs = Read(AgentSql.Jobs, out var jobRows) ? ScheduleJobs(jobRows) : null;
        List<AgentJobDurationDto>? durations = null;
        List<AgentScheduleLinkDto>? links = null;
        bool? idle = null;
        if (sysadmin)
        {
            var (more, moreErrors) = await reader.ReadAsync(connection, null, [.. SchedulesSysadminRead], (_, parameter) => parameter.Name switch
            {
                "@step_id" => 0,
                "@run_status" => 1,
                _ => null
            }, token);
            bool ReadMore(AgentStatement statement, out AgentResult result) => more.TryGetValue(statement.Id, out result!) && moreErrors.All(error => error.Statement != statement.Id);
            if (ReadMore(AgentSql.JobDurations, out var durationRows)) durations = JobDurations(durationRows);
            if (ReadMore(AgentSql.ScheduleLinks, out var linkRows))
                links = [.. linkRows.Rows.Where(row => linkRows.Value(row, "job_id") is Guid).Select(row => NextRunOf(new AgentScheduleLinkDto(IntOf(linkRows.Value(row, "schedule_id")), ((Guid)linkRows.Value(row, "job_id")!).ToString("D")),
                    IntOf(linkRows.Value(row, "next_run_date")), IntOf(linkRows.Value(row, "next_run_time")), linkRows.Value(row, "job_next_run")))];
            // SSMS's Define idle CPU condition: the poller on with a percent and a duration.
            if (ReadMore(AgentSql.IdleCondition, out var idleRows) && idleRows.Rows.Count > 0)
                idle = IntOf(idleRows.Value(idleRows.Rows[0], "cpu_poller_enabled")) == 1 && IntOf(idleRows.Value(idleRows.Rows[0], "idle_cpu_percent")) > 0;
        }
        return new(null, 0, AgentSchedules: new(login, sysadmin, platform, now, records, idle, listed.Truncated ? true : null, jobs, links, durations));
    }

    /// <summary>The job document's schedules: sp_help_jobschedule with the versions, or null when the job's read was not asked for.</summary>
    internal static List<AgentScheduleRecordDto>? JobDocumentSchedules(Dictionary<string, AgentResult> results, List<AgentReadError> errors, string? login = null, string? principalId = null) =>
        results.TryGetValue(AgentSql.JobSchedules.Id, out var rows) && errors.All(error => error.Statement != AgentSql.JobSchedules.Id)
            ? ScheduleRecords(rows, results.TryGetValue(AgentSql.ScheduleVersions.Id, out var versions) && errors.All(error => error.Statement != AgentSql.ScheduleVersions.Id) ? versions : null,
                login, principalId)
            : null;

    // --- Execute -----------------------------------------------------------------------------------------------------------

    private async Task<ActionExecuteResult> ExecuteAgentScheduleAsync(SqlConnection connection, ActionArgs args, CancellationToken token)
    {
        var save = args.AgentSchedule!;
        var batch = AgentSchedulePlan(save);
        var messages = CollectMessages(connection);
        var step = new RunStep(save.Op switch { "create" => CreateScheduleStep, "delete" => DeleteScheduleStep, _ => SaveScheduleStep }, async context =>
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
        }, Detail: save.Name);
        var (steps, failure, _) = await RunStepsAsync(connection, [step], null, token, CleanupBudget(args.Action));
        return new(steps, messages.Collected(), 0, failure);
    }

    // --- Script ------------------------------------------------------------------------------------------------------------

    private static string ScriptValue(object? value) => value switch
    {
        null => "NULL",
        string text => "N'" + text.Replace("'", "''", StringComparison.Ordinal) + "'",
        bool flag => flag ? "1" : "0",
        byte or int => Convert.ToString(value, CultureInfo.InvariantCulture)!,
        Guid id => "N'" + id.ToString("D") + "'",
        _ => throw new InvalidOperationException("Not a script value.")
    };

    /// <summary>The Schedules document's save in SSMS's script shape: one transaction, each call followed by its return-code check, literal values.</summary>
    internal static string AgentScheduleScript(AgentScheduleSaveDto save)
    {
        var batch = AgentSchedulePlan(save);
        var create = save.Op == "create";
        var text = new StringBuilder("USE [msdb]\nGO\nBEGIN TRANSACTION\nDECLARE @ReturnCode INT\nSELECT @ReturnCode = 0\n");
        if (create) text.Append("DECLARE @schedule_id INT\n");
        foreach (var call in batch.Calls)
        {
            var parts = call.Arguments.Select(argument => argument.Name switch
            {
                "@schedule_id" when argument.Output => "@schedule_id = @schedule_id OUTPUT",
                "@schedule_id" when create => "@schedule_id = @schedule_id",
                "@schedule_id" => "@schedule_id=" + ScriptValue(save.Schedule!.Id),
                _ => argument.Name + "=" + ScriptValue(argument.Value)
            });
            text.Append("EXEC @ReturnCode = msdb.dbo.").Append(call.Procedure).Append(' ').Append(string.Join(", \n\t\t", parts)).Append('\n')
                .Append("IF (@@ERROR <> 0 OR @ReturnCode <> 0) GOTO QuitWithRollback\n");
        }
        text.Append("COMMIT TRANSACTION\nGOTO EndSave\nQuitWithRollback:\n    IF (@@TRANCOUNT > 0) ROLLBACK TRANSACTION\nEndSave:\nGO\n");
        return text.ToString();
    }

    private Task<ActionScriptResult> ScriptAgentSchedule(ActionArgs args)
    {
        var engine = host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine;
        if (!Serves(args.Action, engine)) return Task.FromResult(new ActionScriptResult(null, "msdb", [], Error("NOT_SUPPORTED", EngineMessage(engine))));
        return Task.FromResult(new ActionScriptResult(AgentScheduleScript(args.AgentSchedule!), "msdb", []));
    }
}
