using System.Reflection;
using Microsoft.Data.SqlClient;
using Varia.Backend;
using Varia.Backend.Actions;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

/// <summary>SQL Server Agent schedules (AG-6c), offline: the reads, the job save's schedule calls and the Schedules document's save under
/// their lints and near misses, the planners (order, guards, parameter values), the timing rules sp_verify_schedule enforces, the requests'
/// validation, a refused schedule call's part and field, the scripts, and the describe's durations and versions.</summary>
internal static class AgentScheduleChecks
{
    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);
    private static readonly ObjectRefDto AgentNode = new("agent");
    private static readonly ObjectRefDto Job = new("agentJob", Name: "Nightly load");
    private const string JobId = "00000000-1111-2222-3333-444444444441";
    private const string Modified = "2026-11-20T14:32:07.123";
    private static readonly AgentScheduleTimingDto Daily = new(4, 1, 1, 0, 0, 0, 20_260_101, 99_991_231, 23_000, 235_959);
    private static readonly AgentScheduleTimingDto EveryQuarterHour = new(4, 1, 4, 15, 0, 0, 20_260_101, 99_991_231, 60_000, 180_000);

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

    private static ActionArgs JobSave(AgentJobSchedulesSaveDto schedules, bool create = false) => create
        ? new("agentJob", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), AgentNode) { AgentJob = new(Name: "New", Schedules: schedules) }
        : new("agentJob", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), Job) { AgentJob = new(Version: 7, Modified: Modified, Schedules: schedules), AgentIdentity = new(JobId) };
    private static ActionArgs ScheduleSave(AgentScheduleSaveDto save, ObjectRefDto? target = null) =>
        new("agentSchedule", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target ?? AgentNode) { AgentSchedule = save };
    private static AgentScheduleGuardDto Guard(int id) => new(id, 3, Modified);
    private static object? ValueOf(AgentSaveBatch batch, string name) => batch.Parameters.First(parameter => parameter.Parameter.Name == name).Value;

    public static Task RunAsync(Action<bool, string> check)
    {
        Lint(check);
        Planner(check);
        Timing(check);
        Validation(check);
        Errors(check);
        Script(check);
        Describe(check);
        return Task.CompletedTask;
    }

    private static void Lint(Action<bool, string> check)
    {
        var saves = AgentSql.LintScheduleSaves().ToList();
        var failures = saves.Where(item => item.Problems.Count > 0).Select(item => item.Name + ": " + string.Join(", ", item.Problems)).ToList();
        check(failures.Count == 0 && saves.Count == 5, "the Schedules document's five save shapes pass their lint" + (failures.Count == 0 ? "" : ": " + string.Join("; ", failures)));
        check(AgentSql.LintWrites().Count(item => item.Name.StartsWith("schedule save ", StringComparison.Ordinal)) == 5, "the Agent write lint runs the schedule saves too");
        foreach (var statement in new[] { AgentSql.JobSchedules, AgentSql.Schedules, AgentSql.ScheduleVersions, AgentSql.ScheduleLinks, AgentSql.JobsInSchedule, AgentSql.JobDurations, AgentSql.IdleCondition })
            check(AgentSql.Known(statement) && AgentSql.Lint(statement, null).Count == 0, "the schedules' read " + statement.Id + " is one the reader runs, and passes the Agent read lint");

        string Call(int index, string call) => call + AgentSql.CheckAt(index);
        var existing = AgentSql.Resolve + AgentSql.StaleGuard;
        var attach = AgentSql.ScheduleGuard(1) + Call(1, "EXEC @rc = msdb.dbo.sp_attach_schedule @job_id = @job_id, @schedule_id = @schedule_id_1;");
        check(AgentSql.LintJobSave(existing + attach).Count == 0, "the job save lint admits a guarded attach");
        var jobMisses = new (string Text, string Problem)[]
        {
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_attach_schedule @job_id = @job_id, @schedule_id = @schedule_id_1;"), "changes or attaches a schedule without its guard"),
            (existing + AgentSql.ScheduleGuard(1) + Call(1, "EXEC @rc = msdb.dbo.sp_detach_schedule @job_id = @job_id, @schedule_id = @schedule_id_1;"), "guards a call that does not change or attach a schedule"),
            (existing + AgentSql.ScheduleGuard(2) + Call(1, "EXEC @rc = msdb.dbo.sp_attach_schedule @job_id = @job_id, @schedule_id = @schedule_id_1;"), "call 1 has a schedule guard that is not exactly its own"),
            (existing + AgentSql.ScheduleGuard(1) + Call(1, "EXEC @rc = msdb.dbo.sp_attach_schedule @job_id = @job_id, @schedule_id = @schedule_id;"), "passes @schedule_id another parameter's value"),
            (existing + AgentSql.ScheduleGuard(1) + Call(1, "EXEC @rc = msdb.dbo.sp_attach_schedule @job_id = @job_id_1, @schedule_id = @schedule_id_1;"), "passes @job_id another parameter's value"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_add_jobschedule @job_id = @job_id, @name = @name_1;") + Call(2, "EXEC @rc = msdb.dbo.sp_detach_schedule @job_id = @job_id, @schedule_id = @schedule_id_2;"),
                "makes its schedule calls out of order (detach, attach, update, add)"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_detach_schedule @job_id = @job_id, @schedule_id = @schedule_id_1;") + Call(2, "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @enabled = @enabled;"),
                "makes a job or alert call after a schedule call"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_add_jobschedule @job_id = @job_id, @enabled = @enabled_1;"), "adds a schedule without its name"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_detach_schedule @schedule_id = @schedule_id_1;"), "sp_detach_schedule does not name the job"),
            (existing + Call(1, "EXEC @rc = msdb.dbo.sp_delete_schedule @schedule_id = @schedule_id_1;"), "EXECs sp_delete_schedule, which a job save does not call"),
            (AgentSql.NewJobHead + Call(1, "EXEC @rc = msdb.dbo.sp_add_job @job_name = @job_name, @job_id = @job_id OUTPUT;") + Call(2, "EXEC @rc = msdb.dbo.sp_add_jobserver @job_id = @job_id;")
                + Call(3, "EXEC @rc = msdb.dbo.sp_detach_schedule @job_id = @job_id, @schedule_id = @schedule_id_3;"), "detaches a schedule from a new job")
        };
        foreach (var (text, problem) in jobMisses)
        {
            var found = AgentSql.LintJobSave(text);
            check(found.Any(item => item.EndsWith(problem, StringComparison.Ordinal)), "the job save lint refuses a save that " + problem + " (found: " + string.Join(", ", found) + ")");
        }

        var create = AgentSql.NewScheduleHead + Call(1, "EXEC @rc = msdb.dbo.sp_add_schedule @schedule_name = @schedule_name, @schedule_id = @schedule_id OUTPUT;");
        var update = AgentSql.ScheduleHead + Call(1, "EXEC @rc = msdb.dbo.sp_update_schedule @schedule_id = @schedule_id, @enabled = @enabled;");
        var jobAttach = AgentSql.JobVersionGuard(2) + Call(2, "EXEC @rc = msdb.dbo.sp_attach_schedule @job_id = @job_id_2, @schedule_id = @schedule_id;");
        check(AgentSql.LintScheduleSave(create + jobAttach).Count == 0 && AgentSql.LintScheduleSave(update + jobAttach).Count == 0, "the schedule save lint admits a create and an update, each with a guarded attach");
        var misses = new (string Text, string Problem)[]
        {
            (AgentSql.Resolve + Call(1, "EXEC @rc = msdb.dbo.sp_delete_schedule @schedule_id = @schedule_id;"), "does not open with a new schedule's declaration or the schedule's STALE guard"),
            ("DECLARE @rc int;\n" + Call(1, "EXEC @rc = msdb.dbo.sp_delete_schedule @schedule_id = @schedule_id;"), "does not open with a new schedule's declaration or the schedule's STALE guard"),
            (AgentSql.ScheduleHead + Call(1, "EXEC @rc = msdb.dbo.sp_delete_schedule @schedule_id = @schedule_id, @force_delete = @force_delete;"), "passes @force_delete to sp_delete_schedule"),
            (AgentSql.ScheduleHead + Call(1, "EXEC @rc = msdb.dbo.sp_delete_schedule @schedule_id = @schedule_id;") + jobAttach, "deletes the schedule with other calls"),
            (AgentSql.NewScheduleHead + Call(1, "EXEC @rc = msdb.dbo.sp_add_schedule @schedule_name = @schedule_name, @schedule_id = @schedule_id;"), "does not take the new schedule's id as sp_add_schedule's OUTPUT"),
            (update + Call(2, "EXEC @rc = msdb.dbo.sp_attach_schedule @job_id = @job_id_2, @schedule_id = @schedule_id;"), "attaches or detaches a job without its guard"),
            (update + AgentSql.JobVersionGuard(2) + Call(2, "EXEC @rc = msdb.dbo.sp_detach_schedule @job_id = @job_id_2, @schedule_id = @schedule_id, @delete_unused_schedule = @delete_unused_schedule;"),
                "passes @delete_unused_schedule to sp_detach_schedule"),
            (update + AgentSql.JobVersionGuard(2) + Call(2, "EXEC @rc = msdb.dbo.sp_attach_schedule @job_id = @job_id_1, @schedule_id = @schedule_id;"), "passes @job_id another parameter's value"),
            (create + AgentSql.JobVersionGuard(2) + Call(2, "EXEC @rc = msdb.dbo.sp_detach_schedule @job_id = @job_id_2, @schedule_id = @schedule_id;"), "detaches a job from a new schedule"),
            (update + jobAttach + Call(3, "EXEC @rc = msdb.dbo.sp_update_schedule @schedule_id = @schedule_id, @enabled = @enabled;"), "changes the schedule after a job, or twice"),
            (AgentSql.ScheduleHead + Call(1, "EXEC @rc = msdb.dbo.sp_add_schedule @schedule_name = @schedule_name, @schedule_id = @schedule_id OUTPUT;"), "adds a schedule in an existing schedule's save"),
            (AgentSql.ScheduleHead + Call(1, "EXEC @rc = msdb.dbo.sp_update_job @job_id = @job_id, @enabled = @enabled;"), "EXECs sp_update_job, which a schedule save does not call"),
            (AgentSql.ScheduleHead + Call(1, "EXEC @rc = msdb.dbo.sp_update_schedule @schedule_id = @schedule_id, @enabled = 1;"), "is not one msdb call in the save shape"),
            (AgentSql.ScheduleHead, "makes no call")
        };
        foreach (var (text, problem) in misses)
        {
            var found = AgentSql.LintScheduleSave(text);
            check(found.Any(item => item.EndsWith(problem, StringComparison.Ordinal)), "the schedule save lint refuses a save that " + problem + " (found: " + string.Join(", ", found) + ")");
        }
        foreach (var procedure in new[] { "sp_add_jobschedule", "sp_attach_schedule", "sp_detach_schedule", "sp_update_schedule", "sp_delete_schedule" })
            check(AgentSql.LintExecutable(AgentSql.Resolve + "EXEC @rc = msdb.dbo." + procedure + " @job_id = @job_id;" + AgentSql.Check).Contains("EXECs " + procedure + ", which only a job save calls"),
                "the one-call write lint refuses " + procedure + ", which only a guarded schedule batch calls");
        check(AgentSql.ScheduleStaleGuard.Contains("s.version_number = @version", StringComparison.Ordinal) && AgentSql.ScheduleStaleGuard.Contains("s.date_modified = @modified", StringComparison.Ordinal)
            && AgentSql.ScheduleGuard(4).Contains("WITH (UPDLOCK, HOLDLOCK)", StringComparison.Ordinal) && AgentSql.JobVersionGuard(4).Contains("j.version_number = @job_version_4", StringComparison.Ordinal),
            "the schedule guards compare the version and modified date read and hold the row; the job guard compares the job's version");
    }

    private static void Planner(Action<bool, string> check)
    {
        var batch = ActionService.AgentJobSavePlan(JobSave(new(Detach: [new(4, true)], Update: [new(6, 3, Modified, Enabled: false)], Attach: [Guard(9)], Add: [new(Name: "Nightly 02:30", Enabled: true, Timing: Daily)])), Job);
        check(batch.Calls.Select(call => call.Procedure).SequenceEqual(["sp_detach_schedule", "sp_attach_schedule", "sp_update_schedule", "sp_add_jobschedule"]) && AgentSql.LintJobSave(batch.Text).Count == 0
            && (int?)ValueOf(batch, "@schedule_id_1") == 4 && ValueOf(batch, "@delete_unused_schedule_1") is true && ValueOf(batch, "@enabled_3") is (byte)0 && (int?)ValueOf(batch, "@schedule_version_3") == 3
            && ValueOf(batch, "@schedule_modified_2") is DateTime modified && modified == new DateTime(2026, 11, 20, 14, 32, 7, 123) && (int?)ValueOf(batch, "@schedule_id_2") == 9
            && (string?)ValueOf(batch, "@name_4") == "Nightly 02:30" && (int?)ValueOf(batch, "@active_start_time_4") == 23_000 && !batch.Text.Contains("Nightly 02:30", StringComparison.Ordinal),
            "a job's schedule changes are detach, attach, update, add after its own calls, each indexed and guarded, names only as parameters");
        check(batch.Calls[2].Arguments.Select(argument => argument.Name).SequenceEqual(["@schedule_id", "@enabled"]) && batch.Calls[3].Arguments.Count == 13,
            "an update sends only what changed; an add sends the job, name, enabled and every timing argument");
        var created = ActionService.AgentJobSavePlan(JobSave(new(Attach: [Guard(9)], Add: [new(Name: "x", Enabled: true, Timing: Daily)]), create: true), AgentNode);
        check(created.Calls.Select(call => call.Procedure).SequenceEqual(["sp_add_job", "sp_add_jobserver", "sp_attach_schedule", "sp_add_jobschedule"]) && AgentSql.LintJobSave(created.Text).Count == 0,
            "New Job attaches picked schedules and adds new ones after sp_add_jobserver, by the new job's id");

        var save = ActionService.AgentSchedulePlan(new("create", Name: "Weekdays", Enabled: true, Timing: Daily, Jobs: [new(JobId, 2, true)]));
        check(save.Calls.Select(call => call.Procedure).SequenceEqual(["sp_add_schedule", "sp_attach_schedule"]) && AgentSql.LintScheduleSave(save.Text).Count == 0
            && (string?)ValueOf(save, "@schedule_name") == "Weekdays" && ValueOf(save, "@job_id_2") is Guid job && job == Guid.Parse(JobId) && (int?)ValueOf(save, "@job_version_2") == 2
            && !save.Parameters.Any(parameter => parameter.Parameter.Name == "@schedule_id"),
            "a new schedule is sp_add_schedule with its id as the batch's own OUTPUT, then each guarded attach by that id");
        var jobsOnly = ActionService.AgentSchedulePlan(new("update", Schedule: Guard(5), Jobs: [new(JobId, 2, false)]));
        check(jobsOnly.Calls is [{ Procedure: "sp_detach_schedule" }] && AgentSql.LintScheduleSave(jobsOnly.Text).Count == 0 && (int?)ValueOf(jobsOnly, "@schedule_id") == 5 && (int?)ValueOf(jobsOnly, "@version") == 3,
            "an update that only detaches a job makes no sp_update_schedule, under the schedule's STALE guard");
        var disable = ActionService.AgentSchedulePlan(new("disable", Schedule: Guard(5)));
        check(disable.Calls is [{ Procedure: "sp_update_schedule" } off] && off.Arguments.Any(argument => argument.Name == "@enabled" && argument.Value is (byte)0), "Disable is sp_update_schedule @enabled = 0 alone");
        check(ActionService.AgentSchedulePlan(new("delete", Schedule: Guard(5))).Calls is [{ Procedure: "sp_delete_schedule" } delete] && delete.Arguments.Count == 1, "Delete is sp_delete_schedule without @force_delete");
    }

    private static void Timing(Action<bool, string> check)
    {
        var valid = new (string Name, AgentScheduleTimingDto Timing)[]
        {
            ("daily at a time", Daily), ("every 15 minutes in a window", EveryQuarterHour), ("weekdays", new(8, 62, 1, 0, 0, 1, 20_260_101, 99_991_231, 60_000, 235_959)),
            ("the last Friday", new(32, 6, 1, 0, 16, 1, 20_260_101, 99_991_231, 0, 235_959)), ("once", new(1, 0, 0, 0, 0, 0, 20_261_122, 99_991_231, 30_000, 235_959)),
            ("every 10 seconds overnight", new(4, 1, 2, 10, 0, 0, 20_260_101, 20_261_231, 220_000, 40_000)), ("at Agent start", new(64, 0, 0, 0, 0, 0, 20_260_101, 99_991_231, 0, 235_959))
        };
        foreach (var (name, timing) in valid) check(ActionService.ScheduleTimingProblem(timing) is null, "a timing sp_verify_schedule accepts passes: " + name);
        var invalid = new (string Name, AgentScheduleTimingDto Timing)[]
        {
            ("freq_type 2", Daily with { FreqType = 2 }), ("daily every 0 days", Daily with { FreqInterval = 0 }), ("weekly with no day", new(8, 0, 1, 0, 0, 1, 20_260_101, 99_991_231, 0, 235_959)),
            ("weekly every 0 weeks", new(8, 2, 1, 0, 0, 0, 20_260_101, 99_991_231, 0, 235_959)), ("monthly day 32", new(16, 32, 1, 0, 0, 1, 20_260_101, 99_991_231, 0, 235_959)),
            ("relative third of nothing", new(32, 11, 1, 0, 4, 1, 20_260_101, 99_991_231, 0, 235_959)), ("every 5 seconds", Daily with { FreqSubdayType = 2, FreqSubdayInterval = 5 }),
            ("a repeat with equal start and end", EveryQuarterHour with { ActiveEndTime = 60_000 }), ("an end before the start", Daily with { ActiveEndDate = 20_251_231 }),
            ("1989", Daily with { ActiveStartDate = 19_891_231 }), ("February 30", Daily with { ActiveStartDate = 20_260_230 }), ("24:00", Daily with { ActiveStartTime = 240_000 }),
            ("12:60", Daily with { ActiveStartTime = 126_000 }), ("once with a frequency", new(1, 1, 0, 0, 0, 0, 20_260_101, 99_991_231, 0, 235_959)),
            ("a relative interval on a daily", Daily with { FreqRelativeInterval = 1 }), ("a daily interval at a time", Daily with { FreqSubdayInterval = 3 })
        };
        foreach (var (name, timing) in invalid) check(ActionService.ScheduleTimingProblem(timing) is not null, "a timing sp_verify_schedule refuses is refused: " + name);
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
            ("a job's detach", JobSave(new(Detach: [new(4, false)]))), ("a job's update", JobSave(new(Update: [new(6, 3, Modified, Name: "x")]))), ("a job's attach", JobSave(new(Attach: [Guard(9)]))),
            ("a job's add", JobSave(new(Add: [new(Name: "x", Enabled: true, Timing: Daily)]))), ("New Job attaching and changing a picked schedule", JobSave(new(Update: [new(9, 3, Modified, Enabled: false)], Attach: [Guard(9)]), create: true)),
            ("a create", ScheduleSave(new("create", Name: "x", Enabled: true, Timing: Daily))), ("a create attaching jobs", ScheduleSave(new("create", Name: "x", Enabled: false, Timing: Daily, Jobs: [new(JobId, 0, true)]))),
            ("an update", ScheduleSave(new("update", Schedule: Guard(5), Timing: EveryQuarterHour))), ("an update of jobs only", ScheduleSave(new("update", Schedule: Guard(5), Jobs: [new(JobId, 1, false)]))),
            ("an enable", ScheduleSave(new("enable", Schedule: Guard(5)))), ("a delete", ScheduleSave(new("delete", Schedule: Guard(5))))
        };
        foreach (var (name, args) in valid) check(Answer(args) == "accepted" && Answer(args, script: true) == "accepted", "a schedule save validates: " + name);
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("a job's empty schedules", JobSave(new())), ("a job's empty detach list", JobSave(new(Detach: []))), ("a job's update without a change", JobSave(new(Update: [new(6, 3, Modified)]))),
            ("a job's update without its guard", JobSave(new(Update: [new(6, Name: "x")]))), ("a job's attach with a bad date", JobSave(new(Attach: [new(9, 3, "2026-11-20T14:32:07")]))),
            ("a job's add with an id", JobSave(new(Add: [new(1, Name: "x", Enabled: true, Timing: Daily)]))), ("a job's add without timing", JobSave(new(Add: [new(Name: "x", Enabled: true)]))),
            ("a job's add with a bad timing", JobSave(new(Add: [new(Name: "x", Enabled: true, Timing: Daily with { FreqInterval = 0 })]))),
            ("a schedule detached and attached", JobSave(new(Detach: [new(9, false)], Attach: [Guard(9)]))), ("a detached schedule updated", JobSave(new(Detach: [new(9, false)], Update: [new(9, 3, Modified, Name: "x")]))),
            ("too many adds", JobSave(new(Add: [.. Enumerable.Range(0, 17).Select(_ => new AgentScheduleChangeDto(Name: "x", Enabled: true, Timing: Daily))]))),
            ("New Job detaching", JobSave(new(Detach: [new(4, false)]), create: true)), ("New Job updating a schedule it does not attach", JobSave(new(Update: [new(6, 3, Modified, Name: "x")]), create: true)),
            ("an unknown op", ScheduleSave(new("rename", Schedule: Guard(5), Name: "x"))), ("a create without timing", ScheduleSave(new("create", Name: "x", Enabled: true))),
            ("a create with an identity", ScheduleSave(new("create", Schedule: Guard(5), Name: "x", Enabled: true, Timing: Daily))),
            ("a create detaching a job", ScheduleSave(new("create", Name: "x", Enabled: true, Timing: Daily, Jobs: [new(JobId, 0, false)]))), ("an update without its guard", ScheduleSave(new("update", Name: "x"))),
            ("an update changing nothing", ScheduleSave(new("update", Schedule: Guard(5)))), ("an enable with values", ScheduleSave(new("enable", Schedule: Guard(5), Name: "x"))),
            ("a delete with jobs", ScheduleSave(new("delete", Schedule: Guard(5), Jobs: [new(JobId, 0, false)]))), ("a job named twice", ScheduleSave(new("update", Schedule: Guard(5), Jobs: [new(JobId, 0, true), new(JobId.ToUpperInvariant(), 0, false)]))),
            ("a job id that is no guid", ScheduleSave(new("update", Schedule: Guard(5), Jobs: [new("x", 0, true)]))), ("a 129-character name", ScheduleSave(new("create", Name: new string('n', 129), Enabled: true, Timing: Daily))),
            ("a schedule id of 0", ScheduleSave(new("delete", Schedule: new(0, 3, Modified)))), ("a named Agent node", ScheduleSave(new("delete", Schedule: Guard(5)), new ObjectRefDto("agent", Name: "x"))),
            ("a job's target", ScheduleSave(new("delete", Schedule: Guard(5)), Job)), ("another member", ScheduleSave(new("delete", Schedule: Guard(5))) with { NewName = "x" }),
            ("the save on another action", new ActionArgs("agentJob", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), Job) { AgentJob = new(Version: 1, Modified: Modified, Description: "x"), AgentIdentity = new(JobId), AgentSchedule = new("delete", Schedule: Guard(5)) })
        };
        foreach (var (name, args) in invalid) check(Answer(args) == "INVALID_PARAMS", "a schedule save is refused: " + name);
        string Describe(string dialog, ObjectRefDto target, int? schedule)
        {
            try { service.Validate(new ActionDescribeArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), dialog, target) { Schedule = schedule }); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(Describe("agentSchedules", AgentNode, null) == "accepted" && Describe("agentSchedules", AgentNode, 5) == "accepted" && Describe("agentSchedules", AgentNode, 0) == "INVALID_PARAMS"
            && Describe("agentJob", Job, 5) == "INVALID_PARAMS" && Describe("agentSchedules", Job, null) == "INVALID_PARAMS" && Describe("agentSchedules", new ObjectRefDto("agent", Name: "x"), null) == "INVALID_PARAMS",
            "the Schedules describe reads the SQL Server Agent node, and only it may name one schedule");
    }

    private static SqlException Exception(params (int Number, byte State, string Message)[] errors)
    {
        var collection = (SqlErrorCollection)Activator.CreateInstance(typeof(SqlErrorCollection), true)!;
        var add = typeof(SqlErrorCollection).GetMethod("Add", BindingFlags.Instance | BindingFlags.NonPublic)!;
        foreach (var (number, state, message) in errors)
        {
            var constructor = typeof(SqlError).GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic).First(candidate => candidate.GetParameters().Length >= 8);
            var values = constructor.GetParameters().Select(parameter => parameter.Name switch
            {
                "infoNumber" => (object)number, "errorState" => state, "errorClass" => (byte)16, "server" => "s", "errorMessage" => message, "procedure" => "p", "lineNumber" => 1,
                _ => parameter.ParameterType == typeof(uint) ? 0u : parameter.ParameterType == typeof(int) ? 0 : parameter.ParameterType.IsValueType ? Activator.CreateInstance(parameter.ParameterType) : null
            }).ToArray();
            add.Invoke(collection, [constructor.Invoke(values)]);
        }
        var create = typeof(SqlException).GetMethod("CreateException", BindingFlags.Static | BindingFlags.NonPublic, [typeof(SqlErrorCollection), typeof(string)])!;
        return (SqlException)create.Invoke(null, [collection, "16.0"])!;
    }

    private static void Errors(Action<bool, string> check)
    {
        using var service = new ActionService(new Host(Box2022));
        var batch = ActionService.AgentJobSavePlan(JobSave(new(Update: [new(6, 3, Modified, Enabled: true)], Add: [new(Name: "Night", Enabled: true, Timing: Daily)])), Job);
        var refused = service.JobSaveError(Exception((14278, 1, "The schedule for this job is invalid (reason: @enabled ...)."), (50012, 2, AgentSql.RefusedMessage)), batch, null);
        check(refused is { Field: "schedules" } && refused.Message.StartsWith("Saving adding schedule 'Night' was refused", StringComparison.Ordinal),
            "a refused schedule call lands on the Schedules section (never the job's own @enabled), naming the schedule: " + refused.Message);
        check(service.JobSaveError(Exception((50011, 1, AgentSql.StaleMessage)), batch, null) is { Code: "STALE" }, "a schedule guard's 50011 is STALE");
        var delete = ActionService.AgentSchedulePlan(new("delete", Schedule: Guard(5)));
        var inUse = service.JobSaveError(Exception((14372, 1, "The schedule (ID 5) cannot be deleted because it is being used by at least one other job."), (50012, 1, AgentSql.RefusedMessage)), delete, null);
        check(inUse is { Code: "IN_USE" } && inUse.Message.StartsWith("Saving deleting the schedule was refused", StringComparison.Ordinal), "deleting a schedule a job uses is IN_USE: " + inUse.Code);
    }

    private static void Script(Action<bool, string> check)
    {
        var created = ActionService.AgentScheduleScript(new("create", Name: "It's nightly", Enabled: true, Timing: Daily, Jobs: [new(JobId, 2, true)]));
        check(created.Contains("DECLARE @schedule_id INT\nEXEC @ReturnCode = msdb.dbo.sp_add_schedule @schedule_name=N'It''s nightly', \n\t\t@enabled=1, \n\t\t@freq_type=4,", StringComparison.Ordinal)
            && created.Contains("@schedule_id = @schedule_id OUTPUT\n", StringComparison.Ordinal)
            && created.Contains("EXEC @ReturnCode = msdb.dbo.sp_attach_schedule @job_id=N'" + JobId + "', \n\t\t@schedule_id = @schedule_id\n", StringComparison.Ordinal)
            && created.EndsWith("EndSave:\nGO\n", StringComparison.Ordinal),
            "a new schedule's Script is sp_add_schedule with the id as an OUTPUT, then each attach by job id, in SSMS's QuitWithRollback shape");
        var deleted = ActionService.AgentScheduleScript(new("delete", Schedule: Guard(5)));
        check(deleted.Contains("EXEC @ReturnCode = msdb.dbo.sp_delete_schedule @schedule_id=5\n", StringComparison.Ordinal), "Delete's Script names the schedule by its id");
        var job = ActionService.AgentJobDocumentScript(JobSave(new(Detach: [new(4, true)], Add: [new(Name: "Night", Enabled: false, Timing: Daily)])), Job);
        check(job.Contains("EXEC @ReturnCode = msdb.dbo.sp_detach_schedule @job_name=N'Nightly load', \n\t\t@schedule_id=4, \n\t\t@delete_unused_schedule=1\n", StringComparison.Ordinal)
            && job.Contains("EXEC @ReturnCode = msdb.dbo.sp_add_jobschedule @job_name=N'Nightly load', \n\t\t@name=N'Night', \n\t\t@enabled=0, \n\t\t@freq_type=4,", StringComparison.Ordinal),
            "the job document's Script detaches and adds schedules by the job's name, with literal values");
    }

    private static void Describe(Action<bool, string> check)
    {
        var a = Guid.NewGuid();
        var b = Guid.NewGuid();
        var history = new AgentResult(["job_id", "run_duration"], [.. new[] { 130, 200, 1_000_000, 145 }.Select(duration => new object?[] { a, duration }), .. Enumerable.Range(0, 12).Select(at => new object?[] { b, at < 10 ? 5 : 100_000 })], false);
        var durations = ActionService.JobDurations(history);
        check(durations.Single(item => item.JobId == a.ToString("D")).Seconds == 112 && durations.Single(item => item.JobId == b.ToString("D")).Seconds == 5,
            "a job's usual duration is the median of its newest ten successful runs (hhmmss decoded): one long run does not move it, older runs are not read");
        var rows = new AgentResult(["schedule_id", "schedule_name", "enabled", "freq_type", "freq_interval", "freq_subday_type", "freq_subday_interval", "freq_relative_interval", "freq_recurrence_factor",
            "active_start_date", "active_end_date", "active_start_time", "active_end_time", "job_count"],
            [[5, "Nightly", (byte)1, 4, 1, 1, 0, 0, 0, 20_260_101, 99_991_231, 23_000, 235_959, 2], [6, "Theirs", (byte)0, 64, 0, 0, 0, 0, 0, 20_260_101, 99_991_231, 0, 235_959, 1]], false);
        var versions = new AgentResult(["schedule_id", "version_number", "date_modified", "owner"], [[5, 3, new DateTime(2026, 11, 20, 14, 32, 7, 0), "CONTOSO\\dana"]], false);
        var records = ActionService.ScheduleRecords(rows, versions);
        check(records is [{ Id: 5, Name: "Nightly", Enabled: true, JobCount: 2, Version: 3, Modified: "2026-11-20T14:32:07.000", Owner: "CONTOSO\\dana" }, { Id: 6, Enabled: false, FreqType: 64, Version: null, Owner: null }],
            "a schedule carries its version, modified date (milliseconds always written) and owner where the view lists it, and none where it does not (then it cannot be changed)");
    }
}
