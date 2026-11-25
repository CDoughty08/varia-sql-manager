using System.Data;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Varia.Backend.Agent;

/// <summary>A schedule call's guard in a job save (AG-6c): the schedule still has the version_number and date_modified its describe read.</summary>
internal sealed record AgentScheduleGuardValues(int Version, DateTime Modified);

/// <summary>SQL Server Agent schedules (AG-6c, docs/agent-plan.md › Schedules): the reads the job document's Schedules section and the
/// Schedules document make (each in <see cref="All"/>, so under <see cref="LintRead"/>), the schedule calls a job save makes after its own
/// (<see cref="JobSave"/>: detach, attach, update, add, each update and attach after its own <see cref="ScheduleGuard"/>), and the Schedules
/// document's own save (<see cref="ScheduleSave"/>): one batch in one transaction that creates a schedule (sp_add_schedule, its id an
/// OUTPUT) or opens with <see cref="ScheduleStaleGuard"/> and changes, enables, disables or deletes it, then attaches or detaches jobs, each
/// after <see cref="JobVersionGuard"/>. <see cref="LintScheduleSave"/> admits nothing else.</summary>
internal static partial class AgentSql
{
    private static readonly string[] ScheduleColumns = ["schedule_id", "schedule_name", "enabled", "freq_type", "freq_interval", "freq_subday_type", "freq_subday_interval",
        "freq_relative_interval", "freq_recurrence_factor", "active_start_date", "active_end_date", "active_start_time", "active_end_time", "job_count"];

    /// <summary>A job's schedules (every Agent role), each with how many jobs use it. msdb sets no limit per job, so this reads them all
    /// (bounded as a list); schedulesPerJob bounds what one save adds, not what a job may already hold.</summary>
    public static readonly AgentStatement JobSchedules = new("jobSchedules", "EXEC msdb.dbo.sp_help_jobschedule @job_id = @job_id;", ScheduleColumns,
        [new("@job_id", SqlDbType.UniqueIdentifier)], "listRows");
    /// <summary>The schedules the login may see (sysschedules_localserver_view: its own below SQLAgentReaderRole), each with its job count.</summary>
    public static readonly AgentStatement Schedules = new("schedules", "EXEC msdb.dbo.sp_help_schedule;", ScheduleColumns, [], "listRows");
    /// <summary>Each visible schedule's version, modified date and owner, which a guarded save names (msdb grants SQLAgentUserRole SELECT on the view).
    /// The owner's SID comes too: a login through a Windows or Entra group owns schedules under its own SID, which has no server_principals
    /// row, so the backend matches it against the connection's SID.</summary>
    public static readonly AgentStatement ScheduleVersions = new("scheduleVersions",
        "SELECT s.schedule_id, s.version_number, s.date_modified, own.name AS owner, s.owner_sid\n"
        + "FROM msdb.dbo.sysschedules_localserver_view AS s LEFT JOIN sys.server_principals AS own ON own.sid = s.owner_sid;", ["schedule_id", "version_number", "date_modified", "owner", "owner_sid"], [], "listRows");
    /// <summary>Which job uses which schedule (sysadmin: sysjobschedules is not granted to the Agent roles), with the next run Agent last wrote
    /// for the pair (0 until Agent writes it, which it does periodically): the Timeline counts an every-n-weeks or -months cycle from it (AG-14).</summary>
    public static readonly AgentStatement ScheduleLinks = new("scheduleLinks", "SELECT js.schedule_id, js.job_id, js.next_run_date, js.next_run_time, a.next_scheduled_run_date AS job_next_run FROM msdb.dbo.sysjobschedules AS js " +
        "LEFT JOIN msdb.dbo.sysjobactivity AS a ON a.job_id = js.job_id AND a.session_id = (SELECT MAX(s.session_id) FROM msdb.dbo.syssessions AS s);",
        ["schedule_id", "job_id", "next_run_date", "next_run_time", "job_next_run"], [], "listRows");
    /// <summary>One schedule's jobs (SQLAgentUserRole sees its own only).</summary>
    public static readonly AgentStatement JobsInSchedule = new("jobsInSchedule", "EXEC msdb.dbo.sp_help_jobs_in_schedule @schedule_id = @schedule_id;",
        ["job_id", "name", "enabled", "owner", "version_number"], [new("@schedule_id", SqlDbType.Int)], "listRows");
    /// <summary>Every visible job's successful runs, newest first, for the free-slot check's usual durations.</summary>
    public static readonly AgentStatement JobDurations = new("jobDurations", "EXEC msdb.dbo.sp_help_jobhistory @step_id = @step_id, @run_status = @run_status, @mode = N'FULL';",
        ["job_id", "run_duration"], [new("@step_id", SqlDbType.Int), new("@run_status", SqlDbType.Int)], "historyRows");
    /// <summary>Whether SQL Server Agent has an idle CPU condition (sysadmin: Agent Properties › Advanced).</summary>
    public static readonly AgentStatement IdleCondition = new("idleCondition", "EXEC msdb.dbo.sp_get_sqlagent_properties;", ["cpu_poller_enabled", "idle_cpu_percent", "idle_cpu_duration"], [], "listRows");

    // --- The guards ------------------------------------------------------------------------------------------------------

    private const string ScheduleGuardHead = "IF NOT EXISTS (SELECT 1 FROM msdb.dbo.sysschedules_localserver_view AS s WITH (UPDLOCK, HOLDLOCK) WHERE s.schedule_id = @schedule_id_";
    private const string JobVersionGuardHead = "IF NOT EXISTS (SELECT 1 FROM msdb.dbo.sysjobs_view AS j WITH (UPDLOCK, HOLDLOCK) WHERE j.job_id = @job_id_";

    /// <summary>A job save's schedule guard before its call <paramref name="index"/>: the schedule still has the version and modified date read.
    /// UPDLOCK, HOLDLOCK hold its row to the end of the transaction, as the job's own guard does.</summary>
    internal static string ScheduleGuard(int index)
    {
        var at = index.ToString(CultureInfo.InvariantCulture);
        return ScheduleGuardHead + at + " AND s.version_number = @schedule_version_" + at + " AND s.date_modified = @schedule_modified_" + at + ") THROW 50011, N'" + StaleMessage + "', " + at + ";\n";
    }
    /// <summary>The Schedules document's guard on its schedule, which opens every save but create's.</summary>
    internal const string ScheduleStaleGuard = "IF NOT EXISTS (SELECT 1 FROM msdb.dbo.sysschedules_localserver_view AS s WITH (UPDLOCK, HOLDLOCK) WHERE s.schedule_id = @schedule_id AND s.version_number = @version AND s.date_modified = @modified) THROW 50011, N'"
        + StaleMessage + "', 1;\n";
    /// <summary>The Schedules document's guard before attaching or detaching a job (call <paramref name="index"/>): the job still has the version read.</summary>
    internal static string JobVersionGuard(int index)
    {
        var at = index.ToString(CultureInfo.InvariantCulture);
        return JobVersionGuardHead + at + " AND j.version_number = @job_version_" + at + ") THROW 50011, N'" + StaleMessage + "', " + at + ";\n";
    }
    internal const string NewScheduleHead = "DECLARE @schedule_id int, @rc int;\n";
    internal const string ScheduleHead = "DECLARE @rc int;\n" + ScheduleStaleGuard;

    /// <summary>The timing arguments of sp_add_schedule, sp_update_schedule and sp_add_jobschedule (agent catalogue scheduleTimingArguments).</summary>
    internal static readonly IReadOnlyList<string> TimingArguments =
        ["@freq_type", "@freq_interval", "@freq_subday_type", "@freq_subday_interval", "@freq_relative_interval", "@freq_recurrence_factor", "@active_start_date", "@active_end_date", "@active_start_time", "@active_end_time"];
    /// <summary>The procedures a job save calls for its Schedules section, in the order it calls them.</summary>
    internal static IReadOnlyList<string> JobScheduleProcedures => ["sp_detach_schedule", "sp_attach_schedule", "sp_update_schedule", "sp_add_jobschedule"];

    // --- A job save's schedule calls ---------------------------------------------------------------------------------------

    private static AgentParameter Indexed(string argument, int index, SqlDbType type, int size = 0) => new(argument + "_" + index.ToString(CultureInfo.InvariantCulture), type, size);
    private static IEnumerable<AgentSaveArgument> TimingOf(int[] timing, int index) =>
        TimingArguments.Select((argument, at) => new AgentSaveArgument(argument, Indexed(argument, index, SqlDbType.Int), timing[at]));
    private static IEnumerable<AgentSaveArgument> Values(string nameArgument, string? name, bool? enabled, int[]? timing, int index) =>
    [
        ..(name is null ? [] : new AgentSaveArgument[] { new(nameArgument, Indexed(nameArgument, index, SqlDbType.NVarChar, 128), name) }),
        ..(enabled is { } on ? new AgentSaveArgument[] { new("@enabled", Indexed("@enabled", index, SqlDbType.TinyInt), (byte)(on ? 1 : 0)) } : []),
        ..(timing is null ? [] : TimingOf(timing, index))
    ];
    private static readonly AgentParameter JobIdParameter = new("@job_id", SqlDbType.UniqueIdentifier);

    /// <summary>sp_detach_schedule of the job's schedule <paramref name="id"/> (call <paramref name="index"/>), deleting it when unused if asked.</summary>
    public static AgentSaveCall DetachSchedule(int index, int id, bool deleteUnused) =>
        new("sp_detach_schedule", [new("@job_id", JobIdParameter, null), new("@schedule_id", Indexed("@schedule_id", index, SqlDbType.Int), id),
            new("@delete_unused_schedule", Indexed("@delete_unused_schedule", index, SqlDbType.Bit), deleteUnused)], Label: "removing a schedule");
    /// <summary>sp_update_schedule of schedule <paramref name="id"/> with what changed, after its guard.</summary>
    public static AgentSaveCall UpdateSchedule(int index, int id, AgentScheduleGuardValues guard, string? name, bool? enabled, int[]? timing) =>
        new("sp_update_schedule", [new("@schedule_id", Indexed("@schedule_id", index, SqlDbType.Int), id), ..Values("@new_name", name, enabled, timing, index)], Guard: guard,
            Label: "changing a schedule" + (name is null ? "" : " ('" + name + "')"));
    /// <summary>sp_attach_schedule of a picked schedule <paramref name="id"/>, after its guard.</summary>
    public static AgentSaveCall AttachSchedule(int index, int id, AgentScheduleGuardValues guard) =>
        new("sp_attach_schedule", [new("@job_id", JobIdParameter, null), new("@schedule_id", Indexed("@schedule_id", index, SqlDbType.Int), id)], Guard: guard, Label: "attaching a schedule");
    /// <summary>sp_add_jobschedule of a new schedule for this job alone.</summary>
    public static AgentSaveCall AddJobSchedule(int index, string name, bool enabled, int[] timing) =>
        new("sp_add_jobschedule", [new("@job_id", JobIdParameter, null), ..Values("@name", name, enabled, timing, index)], Label: "adding schedule '" + name + "'");

    // --- The Schedules document's save -------------------------------------------------------------------------------------

    /// <summary>The Schedules document's batch: <paramref name="op"/> create (sp_add_schedule with every value, the id its OUTPUT), update
    /// (sp_update_schedule with what changed; none when only jobs change), enable, disable or delete, then one guarded attach or detach per job.
    /// Parameters are the arguments' own names (@schedule_id, @new_name, @freq_type, …), the guard's @version and @modified, and per job
    /// @job_id_&lt;index&gt; and @job_version_&lt;index&gt;.</summary>
    public static AgentSaveBatch ScheduleSave(string op, int? scheduleId, int? version, DateTime? modified, string? name, bool? enabled, int[]? timing,
        IReadOnlyList<(Guid JobId, int Version, bool Attach)> jobs)
    {
        var create = op == "create";
        var text = new StringBuilder(create ? NewScheduleHead : ScheduleHead);
        var parameters = new List<(AgentParameter, object?)>();
        var scheduleParameter = new AgentParameter("@schedule_id", SqlDbType.Int);
        if (!create) parameters.AddRange([(scheduleParameter, scheduleId), (VersionParameter, version), (new AgentParameter("@modified", SqlDbType.DateTime), modified)]);
        var calls = new List<AgentSaveCall>();
        AgentSaveArgument Own(string argument, SqlDbType type, object? value, int size = 0) => new(argument, new(argument, type, size), value);
        IEnumerable<AgentSaveArgument> Set(string nameArgument) =>
        [
            ..(name is null ? [] : new[] { Own(nameArgument, SqlDbType.NVarChar, name, 128) }),
            ..(enabled is { } on ? new[] { Own("@enabled", SqlDbType.TinyInt, (byte)(on ? 1 : 0)) } : []),
            ..(timing is null ? [] : TimingArguments.Select((argument, at) => Own(argument, SqlDbType.Int, timing[at])))
        ];
        switch (op)
        {
            case "create": calls.Add(new("sp_add_schedule", [..Set("@schedule_name"), new("@schedule_id", scheduleParameter, null, Output: true)], Label: "creating the schedule")); break;
            case "update" when name is not null || enabled is not null || timing is not null: calls.Add(new("sp_update_schedule", [new("@schedule_id", scheduleParameter, scheduleId), ..Set("@new_name")], Label: "the schedule's settings")); break;
            case "enable" or "disable": calls.Add(new("sp_update_schedule", [new("@schedule_id", scheduleParameter, scheduleId), Own("@enabled", SqlDbType.TinyInt, (byte)(op == "enable" ? 1 : 0))], Label: "the schedule's settings")); break;
            case "delete": calls.Add(new("sp_delete_schedule", [new("@schedule_id", scheduleParameter, scheduleId)], Label: "deleting the schedule")); break;
        }
        foreach (var (jobId, jobVersion, attach) in jobs)
        {
            var index = calls.Count + 1;
            calls.Add(new(attach ? "sp_attach_schedule" : "sp_detach_schedule", [new("@job_id", Indexed("@job_id", index, SqlDbType.UniqueIdentifier), jobId), new("@schedule_id", scheduleParameter, null)],
                JobVersion: jobVersion, Label: attach ? "attaching a job" : "detaching a job"));
        }
        if (calls.Count == 0 || calls.Count > CallIndexLimit) throw new InvalidOperationException("A schedule save makes 1 to 255 calls.");
        for (var i = 0; i < calls.Count; i++)
        {
            var call = calls[i];
            if (call.JobVersion is { } guarded)
            {
                text.Append(JobVersionGuard(i + 1));
                parameters.Add((Indexed("@job_version", i + 1, SqlDbType.Int), guarded));
            }
            text.Append(Call(call)).Append(CheckAt(i + 1));
            foreach (var argument in call.Arguments)
                if (argument.Parameter.Name != "@schedule_id") parameters.Add((argument.Parameter, argument.Value));
        }
        return new(text.ToString(), parameters, calls);
    }

    [GeneratedRegex(@"^EXEC @rc = msdb\.dbo\.(?<proc>\w+) (?<arg>@\w+) = (?<value>@\w+)(?<out> OUTPUT)?(?:, (?<arg>@\w+) = (?<value>@\w+)(?<out> OUTPUT)?)*;$", RegexOptions.CultureInvariant)]
    private static partial Regex ScheduleCall();

    /// <summary>One parsed call: its procedure and each argument with the parameter it is passed and whether as an OUTPUT.</summary>
    private static (string Procedure, List<(string Argument, string Value, bool Output)> Arguments)? ParseCall(Regex shape, string call)
    {
        var match = shape.Match(call);
        if (!match.Success) return null;
        var arguments = new List<(string, string, bool)>();
        var count = match.Groups["arg"].Captures.Count;
        for (var i = 0; i < count; i++)
        {
            var value = match.Groups["value"].Captures[i];
            var output = match.Groups["out"].Captures.Any(capture => capture.Index > value.Index && (i + 1 == count || capture.Index < match.Groups["arg"].Captures[i + 1].Index));
            arguments.Add((match.Groups["arg"].Captures[i].Value, value.Value, output));
        }
        return (match.Groups["proc"].Value, arguments);
    }

    /// <summary>Problems with the Schedules document's save text; empty when it passes. It opens with <see cref="NewScheduleHead"/> (then
    /// sp_add_schedule first, its @schedule_id only as the OUTPUT, then attaches) or <see cref="ScheduleHead"/> exactly (then sp_update_schedule
    /// at most once and first, then attaches and detaches; or sp_delete_schedule alone, never @force_delete). Each attach or detach follows its own
    /// <see cref="JobVersionGuard"/> and passes @job_id_&lt;index&gt; and @schedule_id; every other argument is passed by the parameter of its own
    /// name. Every call is one msdb call of the catalogue's write arguments followed by <see cref="CheckAt"/> with its index.</summary>
    public static List<string> LintScheduleSave(string text, AgentCatalog? catalog = null)
    {
        catalog ??= AgentCatalog.Current;
        var problems = new List<string>();
        if (text.Contains("xp_servicecontrol", StringComparison.OrdinalIgnoreCase)) problems.Add("uses xp_servicecontrol");
        var create = text.StartsWith(NewScheduleHead, StringComparison.Ordinal);
        string rest;
        if (create) rest = text[NewScheduleHead.Length..];
        else if (text.StartsWith(ScheduleHead, StringComparison.Ordinal)) rest = text[ScheduleHead.Length..];
        else { problems.Add("does not open with a new schedule's declaration or the schedule's STALE guard"); return problems; }
        var procedures = new List<string>();
        for (var index = 1; rest.Length > 0; index++)
        {
            if (index > CallIndexLimit) { problems.Add("makes more than 255 calls"); return problems; }
            var guarded = rest.StartsWith(JobVersionGuardHead, StringComparison.Ordinal);
            if (guarded)
            {
                var guard = JobVersionGuard(index);
                if (!rest.StartsWith(guard, StringComparison.Ordinal)) { problems.Add("call " + index + " has a job guard that is not exactly its own"); return problems; }
                rest = rest[guard.Length..];
            }
            var end = rest.IndexOf('\n', StringComparison.Ordinal);
            var check = CheckAt(index);
            if (end < 0 || !rest[end..].StartsWith(check, StringComparison.Ordinal)) { problems.Add("call " + index + " is not followed by its return-code check"); return problems; }
            var parsed = ParseCall(ScheduleCall(), rest[..end]);
            rest = rest[(end + check.Length)..];
            if (parsed is not { } call) { problems.Add("call " + index + " is not one msdb call in the save shape"); return problems; }
            procedures.Add(call.Procedure);
            var jobCall = call.Procedure is "sp_attach_schedule" or "sp_detach_schedule";
            if (call.Procedure is not ("sp_add_schedule" or "sp_update_schedule" or "sp_delete_schedule" or "sp_attach_schedule" or "sp_detach_schedule")
                || !catalog.WriteArguments.TryGetValue(call.Procedure, out var allowed)) { problems.Add("EXECs " + call.Procedure + ", which a schedule save does not call"); continue; }
            if (guarded != jobCall) problems.Add(guarded ? "guards a call that does not attach or detach a job" : "attaches or detaches a job without its guard");
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (argument, value, output) in call.Arguments)
            {
                if (!allowed.Contains(argument) || argument is "@delete_unused_schedule" or "@force_delete") problems.Add("passes " + argument + " to " + call.Procedure);
                if (!seen.Add(argument)) problems.Add("passes " + argument + " twice");
                var expected = jobCall && argument == "@job_id" ? "@job_id_" + index.ToString(CultureInfo.InvariantCulture) : argument;
                if (value != expected) problems.Add("passes " + argument + " another parameter's value");
                if (output != (call.Procedure == "sp_add_schedule" && argument == "@schedule_id")) problems.Add(output ? "passes " + argument + " as an OUTPUT" : "does not take the new schedule's id as sp_add_schedule's OUTPUT");
            }
            if (!seen.Contains("@schedule_id")) problems.Add(call.Procedure + " does not name the schedule");
            if (jobCall && !seen.Contains("@job_id")) problems.Add(call.Procedure + " does not name the job");
            if (call.Procedure == "sp_add_schedule" && !seen.Contains("@schedule_name")) problems.Add("creates a schedule without its name");
        }
        if (procedures.Count == 0) problems.Add("makes no call");
        var head = procedures.FirstOrDefault();
        var jobs = procedures.Skip(head is "sp_add_schedule" or "sp_update_schedule" or "sp_delete_schedule" ? 1 : 0).ToList();
        if (create && head != "sp_add_schedule") problems.Add("a new schedule's save does not open with sp_add_schedule");
        if (!create && head == "sp_add_schedule") problems.Add("adds a schedule in an existing schedule's save");
        if (jobs.Any(procedure => procedure is not ("sp_attach_schedule" or "sp_detach_schedule"))) problems.Add("changes the schedule after a job, or twice");
        if (create && jobs.Contains("sp_detach_schedule")) problems.Add("detaches a job from a new schedule");
        if (head == "sp_delete_schedule" && procedures.Count > 1) problems.Add("deletes the schedule with other calls");
        return problems;
    }

    /// <summary>The Schedules document's batches in their shapes (create with every value and two attaches; update with every value, an attach and a
    /// detach; enable; delete) under <see cref="LintScheduleSave"/>, each binding exactly the parameters it uses.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> LintScheduleSaves()
    {
        var timing = new int[TimingArguments.Count];
        var batches = new (string Name, AgentSaveBatch Batch)[]
        {
            ("create", ScheduleSave("create", null, null, null, "x", true, timing, [(Guid.Empty, 1, true), (Guid.Empty, 2, true)])),
            ("update", ScheduleSave("update", 1, 1, DateTime.UnixEpoch, "x", false, timing, [(Guid.Empty, 1, true), (Guid.Empty, 2, false)])),
            ("jobs only", ScheduleSave("update", 1, 1, DateTime.UnixEpoch, null, null, null, [(Guid.Empty, 1, false)])),
            ("enable", ScheduleSave("enable", 1, 1, DateTime.UnixEpoch, null, null, null, [])),
            ("delete", ScheduleSave("delete", 1, 1, DateTime.UnixEpoch, null, null, null, []))
        };
        foreach (var (name, batch) in batches)
        {
            var problems = LintScheduleSave(batch.Text);
            problems.AddRange(BindingProblems(batch, ["@rc", "@schedule_id"]));
            // A new schedule's id is the batch's own variable; an existing one's is bound once.
            if (batch.Parameters.Count(parameter => parameter.Parameter.Name == "@schedule_id") != (name == "create" ? 0 : 1)) problems.Add("binds @schedule_id wrongly");
            yield return ("schedule save " + name, problems);
        }
    }

    /// <summary>A batch's variables against its parameters: every value it passes is bound, and every bound parameter is used. <paramref name="locals"/>
    /// are the batch's own declarations.</summary>
    private static IEnumerable<string> BindingProblems(AgentSaveBatch batch, IReadOnlyCollection<string> locals)
    {
        var code = Literal().Replace(batch.Text, "''");
        var used = Variable().Matches(code).Select(match => match.Value).Where(variable => !locals.Contains(variable)).ToHashSet(StringComparer.Ordinal);
        // An msdb call names the procedure's argument on the left of each '='; those are not the batch's variables.
        var values = Variable().Matches(Regex.Replace(code, @"@\w+ = (?=@)", "= ")).Select(match => match.Value).Where(variable => !locals.Contains(variable)).ToHashSet(StringComparer.Ordinal);
        var bound = batch.Parameters.Select(parameter => parameter.Parameter.Name).Where(variable => !locals.Contains(variable)).ToHashSet(StringComparer.Ordinal);
        foreach (var variable in values.Except(bound)) yield return "binds the undeclared " + variable;
        foreach (var variable in bound.Except(used)) yield return "declares the unused " + variable;
        if (batch.Parameters.Select(parameter => parameter.Parameter.Name).Distinct(StringComparer.Ordinal).Count() != batch.Parameters.Count) yield return "binds a parameter twice";
    }
}
