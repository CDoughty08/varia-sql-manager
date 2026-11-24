using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;
using Varia.Backend.Live;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live checks of SQL Server Agent's overview (AG-15), part of the Agent suite with VARIA_TEST_SQL_SCRATCH=1: the conditions its
/// checks look for, made on scratch objects (a job owned by a disabled login that notifies no one, and a schedule no job uses), read back
/// through live.subscribe as sysadmin, then through the reader under a SQLAgentReaderRole login, whose sysadmin reads are "role" values.
/// Everything is dropped in finally (the login by the scratch database, the job and schedule here and by the Agent sweep).</summary>
internal static class AgentOverviewLiveChecks
{
    private static string Quote(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Bracket(string value) => "[" + value.Replace("]", "]]", StringComparison.Ordinal) + "]";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, ScratchDatabase scratch,
        Func<string, string, Task<SqlRun>> sql, SqlConnection connection, ServerProfile profile)
    {
        var owner = scratch.OwnLogin("ovo");
        var job = scratch.AgentObject("job");
        var schedule = scratch.AgentObject("sch");
        var made = await sql("CREATE LOGIN " + Bracket(owner) + " WITH PASSWORD = " + Quote(ScratchDatabase.Throwaway()) + ", CHECK_POLICY = OFF;", "master");
        var created = await sql("DECLARE @id uniqueidentifier;\n"
            + "EXEC msdb.dbo.sp_add_job @job_name = " + Quote(job) + ", @description = " + Quote(ScratchDatabase.JobMarker) + ", @owner_login_name = " + Quote(owner) + ", @job_id = @id OUTPUT;\n"
            + "EXEC msdb.dbo.sp_add_jobstep @job_id = @id, @step_name = N'Step 1', @subsystem = N'TSQL', @command = N'SELECT 1;';\n"
            + "EXEC msdb.dbo.sp_add_jobserver @job_id = @id;\n"
            + "EXEC msdb.dbo.sp_add_schedule @schedule_name = " + Quote(schedule) + ", @freq_type = 1, @active_start_date = 20990101;\n"
            + "SELECT CONVERT(nvarchar(36), @id);", "msdb");
        var disabled = await sql("ALTER LOGIN " + Bracket(owner) + " DISABLE;", "master");
        try
        {
            check(made.Status == "completed" && created.Status == "completed" && disabled.Status == "completed",
                "the overview's scratch conditions can be made: a login, disabled, owning a job with no notification, and an unused schedule: " + made.Error + created.Error + disabled.Error);
            var (rows, status) = await SubscribedAsync(service, info, json);
            var reads = rows.TryGetValue(3, out var readRows) ? readRows.ToDictionary(row => row[0] ?? "", row => row[1]) : [];
            var ours = rows.TryGetValue(0, out var jobRows) ? jobRows.FirstOrDefault(row => row[1] == job) : null;
            var unused = rows.TryGetValue(2, out var scheduleRows) ? scheduleRows.FirstOrDefault(row => row[1] == schedule) : null;
            check(ours is not null && ours[3] == owner && ours[2] == "1" && ours[8] == "0" && ours[9] == "0" && ours[10] == "0" && ours[12] == "1" && ours[13] == "0"
                && unused is not null && unused[3] == "0",
                "agent.overview reads the scratch job through live.subscribe with its owner's login disabled (1), no notification and no history, and the scratch schedule with no job: "
                + (ours is null ? "no job row" : string.Join(",", ours)) + " | " + (unused is null ? "no schedule row" : string.Join(",", unused)));
            check(status.TryGetValue("isSysadmin", out var sysadmin) && Equals(sysadmin, 1L) && status.ContainsKey("serverNow") && status.ContainsKey("historyMaxRows")
                && AgentOverviewReader.Reads.Where(read => read is not "alerts" and not "mail").All(read => reads.GetValueOrDefault(read) == "ok")
                && reads.ContainsKey("mail")
                && reads.GetValueOrDefault("alerts") is "ok" or "platform",
                "as sysadmin every overview read is read (alerts off Windows say platform; Agent's mail settings may be a shape error, which the mail check works around), with the server's clock and the history caps: "
                + string.Join(", ", reads.Select(item => item.Key + "=" + item.Value)) + " | " + string.Join(", ", status.Keys));

            // A SQLAgentReaderRole login reads the jobs, properties and alerts; the sysadmin reads are role values, never failures.
            var reader = scratch.OwnLogin("ovr");
            var readerMade = await sql("CREATE LOGIN " + Bracket(reader) + " WITH PASSWORD = " + Quote(ScratchDatabase.Throwaway()) + ", CHECK_POLICY = OFF;", "master");
            var mapped = await sql("CREATE USER " + Bracket(reader) + " FOR LOGIN " + Bracket(reader) + ";\nALTER ROLE SQLAgentReaderRole ADD MEMBER " + Bracket(reader) + ";", "msdb");
            try
            {
                var overview = new AgentOverviewReader();
                overview.Unavailable(LiveCatalog.Current.Probes[AgentOverviewReader.ReadProbe], profile);
                LiveReaderSample? role = null;
                await Run("EXECUTE AS LOGIN = " + Quote(reader) + ";");
                try { role = await overview.SampleAsync(connection, LiveSql.Prologue("server", readCommittedSnapshot: false), null, CancellationToken.None); }
                finally { await Run("REVERT;"); }
                var roleReads = role.Tables[3].Rows.ToDictionary(row => row.Cells[0].Text ?? "", row => row.Cells[1].Text);
                var roleJob = role.Tables[0].Rows.FirstOrDefault(row => row.Cells[1].Text == job);
                check(readerMade.Status == "completed" && mapped.Status == "completed" && role.Sampled && role.Errors.Count == 0
                    && new[] { "owners", "history", "schedules", "mail", "service" }.All(read => roleReads.GetValueOrDefault(read) == "role")
                    && roleReads.GetValueOrDefault("jobs") == "ok" && roleJob is not null && roleJob.Cells[12].Text is null && roleJob.Cells[13].Text is null,
                    "a SQLAgentReaderRole login reads every job (the scratch one included) with its owner and history facts unknown, and the sysadmin reads are role values: "
                    + readerMade.Error + mapped.Error + " " + string.Join(", ", roleReads.Select(item => item.Key + "=" + item.Value)));
            }
            finally { await sql("IF USER_ID(" + Quote(reader) + ") IS NOT NULL DROP USER " + Bracket(reader) + ";", "msdb"); }
        }
        finally
        {
            await sql("IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = " + Quote(job) + ") EXEC msdb.dbo.sp_delete_job @job_name = " + Quote(job) + ", @delete_history = 1, @delete_unused_schedule = 1;\n"
                + "IF EXISTS (SELECT 1 FROM msdb.dbo.sysschedules WHERE name = " + Quote(schedule) + ") EXEC msdb.dbo.sp_delete_schedule @schedule_name = " + Quote(schedule) + ", @force_delete = 1;", "msdb");
        }

        async Task Run(string text)
        {
            await using var command = new SqlCommand(text, connection);
            await command.ExecuteNonQueryAsync();
        }
    }

    /// <summary>One agent.overview subscription until its first sample with tables arrives: its tables' rows (read while the
    /// subscription holds them; they are released when it ends) and its status values.</summary>
    private static async Task<(Dictionary<int, List<string?[]>> Rows, Dictionary<string, object> Status)> SubscribedAsync(SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var recorder = new LiveRecorder(9715);
        var task = service.Live.SubscribeAsync(new LiveSubscribeArgs(Guid.NewGuid().ToString(), info.Id, AgentOverviewReader.Source,
            [new LiveProbeArgs(AgentOverviewReader.ReadProbe, 60_000)]), recorder.Context, json);
        try
        {
            LiveSample? Last(LiveRecorder seen) => seen.Ticks.SelectMany(tick => tick.Samples).LastOrDefault(sample => sample.Probe == AgentOverviewReader.ReadProbe && sample.Tables is { Count: 4 });
            await recorder.WaitAsync(seen => Last(seen) is not null, 30_000);
            var sample = Last(recorder);
            return (sample?.Tables?.ToDictionary(table => table.Table, table => LiveResultChecks.RowsOf(service.Results, table.Descriptor)) ?? [],
                (sample?.Status ?? []).ToDictionary(item => item.Id, item => item.Value));
        }
        finally
        {
            recorder.Context.Cancel(CancelReason.User);
            await task.WaitAsync(TimeSpan.FromSeconds(10));
            recorder.Dispose();
        }
    }
}
