using System.Globalization;
using System.Text.Json;
using Varia.Backend;

namespace Varia.Backend.Tests;

/// <summary>
/// Schedules (AG-6c, AG-14) on scratch objects, part of the Agent suite: the Schedules document's save creates a shared schedule with a job
/// attached, its describe reads every field back as sent with the link (and sysjobschedules' next run once Agent has written one), a guarded
/// update changes the timing to a daily window across midnight, a save naming the old version is refused STALE and changes nothing, Disable
/// and Enable flip it, and Delete with the job detached drops it. Agent's own next run for the scratch job (sysjobactivity) is compared with
/// src/shared/agent/schedule.ts's by tests/agent-schedule-live.test.ts, which reaches the same server. Every object is dropped in finally and
/// named so the stale sweep finds it if the run dies.
/// </summary>
internal static class AgentScheduleLiveChecks
{
    private static string Quote(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Said(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title)) + (result.Error is { } error ? " " + error.Code + " " + error.Message : "");
    private static AgentScheduleTimingDto TimingOf(AgentScheduleRecordDto record) => new(record.FreqType, record.FreqInterval, record.FreqSubdayType, record.FreqSubdayInterval,
        record.FreqRelativeInterval, record.FreqRecurrenceFactor, record.ActiveStartDate, record.ActiveEndDate, record.ActiveStartTime, record.ActiveEndTime);

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, ScratchDatabase scratch, Func<string, string, Task<SqlRun>> sql)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        var agent = new ObjectRefDto("agent");
        var name = scratch.AgentObject("sch");
        // A job of its own: the run's timestamp with its own id, so the sweep's pattern still matches it, apart from the Agent suite's job.
        var job = scratch.Name[..^8] + Guid.NewGuid().ToString("N")[..8] + "_job";
        Task<ActionExecuteResult> Execute(AgentScheduleSaveDto save) => Call<ActionExecuteResult>("actions.execute", new ActionArgs("agentSchedule", info.Id, Guid.NewGuid().ToString(), agent) { AgentSchedule = save });
        async Task<AgentSchedulesDto?> Describe() => (await Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "agentSchedules", agent))).AgentSchedules;
        async Task<string?> Scalar(string text) => (await sql(text, "msdb")).Scalar;
        try
        {
            // Disabled so it never runs; one step that does nothing.
            var made = await sql("DECLARE @id uniqueidentifier; EXEC msdb.dbo.sp_add_job @job_name = " + Quote(job) + ", @enabled = 0, @description = " + Quote(ScratchDatabase.JobMarker)
                + ", @job_id = @id OUTPUT; EXEC msdb.dbo.sp_add_jobstep @job_id = @id, @step_name = N'noop', @command = N'SELECT 1;'; EXEC msdb.dbo.sp_add_jobserver @job_id = @id;", "msdb");
            var before = await Describe();
            var listed = before?.Jobs?.FirstOrDefault(item => item.Name == job);
            check(made.Status == "completed" && before is { Sysadmin: true } && listed is not null, "the Schedules describe lists the scratch job for a sysadmin login: " + made.Error);
            if (before is null || listed is null) return;
            var today = int.Parse(before.Now[..10].Replace("-", "", StringComparison.Ordinal), CultureInfo.InvariantCulture);

            // Every 2 weeks on Monday and Friday at 02:30 from today.
            var fortnightly = new AgentScheduleTimingDto(8, 2 | 32, 1, 0, 0, 2, today, 99991231, 23000, 235959);
            var created = await Execute(new("create", Name: name, Enabled: true, Timing: fortnightly, Jobs: [new(listed.Id, listed.Version, true)]));
            var read = await Describe();
            var record = read?.Schedules.FirstOrDefault(item => item.Name == name);
            var link = read?.Links?.FirstOrDefault(item => record is not null && item.ScheduleId == record.Id && string.Equals(item.JobId, listed.Id, StringComparison.OrdinalIgnoreCase));
            check(created.Error is null && record is { Enabled: true, JobCount: 1 } && TimingOf(record) == fortnightly && record.Version is not null && record.Modified is not null && link is not null,
                "the Schedules document's create makes the shared schedule with the job attached, and its describe reads every timing field back as sent with the link: " + Said(created) + " " + JsonSerializer.Serialize(record));
            // sysjobschedules' next run is 0 until Agent writes it, so the describe sends none until then; once it does, it is a valid moment.
            check(link is null || (link.NextRunDate is null && link.NextRunTime is null) || (link.NextRunDate is >= 19900101 and <= 99991231 && link.NextRunTime is >= 0 and <= 235959),
                "a link's next run is absent until Agent writes one, and a valid date and time after: " + JsonSerializer.Serialize(link));
            if (record?.Version is not { } version || record.Modified is not { } modified) return;

            // Daily, every 90 minutes from 22:00 to 04:00 the next morning.
            var overnight = new AgentScheduleTimingDto(4, 1, 4, 90, 0, 0, today, 99991231, 220000, 40000);
            var updated = await Execute(new("update", Schedule: new(record.Id, version, modified), Timing: overnight));
            var after = (await Describe())?.Schedules.FirstOrDefault(item => item.Id == record.Id);
            check(updated.Error is null && after is not null && TimingOf(after) == overnight && after.Version > version,
                "a guarded update changes the timing to a window across midnight, read back as sent with a new version: " + Said(updated) + " " + JsonSerializer.Serialize(after));
            var stale = await Execute(new("update", Schedule: new(record.Id, version, modified), Name: name + "x"));
            check(stale.Error is { Code: "STALE" } && await Scalar("SELECT name FROM msdb.dbo.sysschedules WHERE schedule_id = " + record.Id.ToString(CultureInfo.InvariantCulture) + ";") == name,
                "an update naming the version read before is refused STALE and changes nothing: " + Said(stale));
            if (after?.Version is not { } current || after.Modified is not { } at) return;

            var disabled = await Execute(new("disable", Schedule: new(record.Id, current, at)));
            var off = (await Describe())?.Schedules.FirstOrDefault(item => item.Id == record.Id);
            var enabled = off?.Version is { } offVersion && off.Modified is { } offAt ? await Execute(new("enable", Schedule: new(record.Id, offVersion, offAt))) : null;
            var on = (await Describe())?.Schedules.FirstOrDefault(item => item.Id == record.Id);
            check(disabled.Error is null && off is { Enabled: false } && enabled is { Error: null } && on is { Enabled: true },
                "Disable and Enable flip the schedule: " + Said(disabled) + " " + (enabled is null ? "" : Said(enabled)));
            if (on?.Version is not { } last || on.Modified is not { } lastAt) return;

            var job2 = (await Describe())?.Jobs?.FirstOrDefault(item => item.Name == job);
            var detached = job2 is null ? null : await Execute(new("update", Schedule: new(record.Id, last, lastAt), Jobs: [new(job2.Id, job2.Version, false)]));
            var unused = (await Describe())?.Schedules.FirstOrDefault(item => item.Id == record.Id);
            var deleted = unused?.Version is { } unusedVersion && unused.Modified is { } unusedAt ? await Execute(new("delete", Schedule: new(record.Id, unusedVersion, unusedAt))) : null;
            check(detached is { Error: null } && unused is { JobCount: 0 } && deleted is { Error: null }
                && await Scalar("SELECT CONVERT(nvarchar(9), COUNT(*)) FROM msdb.dbo.sysschedules WHERE schedule_id = " + record.Id.ToString(CultureInfo.InvariantCulture) + ";") == "0",
                "detaching the job leaves the schedule unused, and Delete drops it: " + (detached is null ? "" : Said(detached)) + " " + (deleted is null ? "" : Said(deleted)));
        }
        finally
        {
            await sql("IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = " + Quote(job) + ") EXEC msdb.dbo.sp_delete_job @job_name = " + Quote(job) + ", @delete_unused_schedule = 1;", "msdb");
            await sql("DECLARE @id int; SELECT TOP (1) @id = schedule_id FROM msdb.dbo.sysschedules WHERE name = " + Quote(name) + "; IF @id IS NOT NULL EXEC msdb.dbo.sp_delete_schedule @schedule_id = @id, @force_delete = 1;", "msdb");
        }
    }
}
