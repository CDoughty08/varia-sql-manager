using System.Text.Json;
using Varia.Backend.Actions;
using Varia.Backend.Agent;
using Varia.Backend.Live;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live checks of the Log File Viewer (AG-5a), part of the Agent suite with VARIA_TEST_SQL_SCRATCH=1, on this run's scratch job after it
/// ran once, plus a second scratch job of its own (no history): agent.history lists the run and, selected, its outcome and step rows;
/// agent.historyMessage reads a row's whole message; Delete History on both jobs keeps everything with "older than 30 days" and deletes the
/// run with "all", after which the message read is NOT_FOUND. Only the two scratch jobs' history is touched.</summary>
internal static class AgentHistoryLiveChecks
{
    private static string Quote(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, string job, Guid id,
        Func<string, string, Task<SqlRun>> sql)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        await using var other = ScratchDatabase.Bare(sql);
        var second = other.AgentObject("job");
        var made = await sql("DECLARE @id uniqueidentifier;\n"
            + "EXEC msdb.dbo.sp_add_job @job_name = " + Quote(second) + ", @description = " + Quote(ScratchDatabase.JobMarker) + ", @job_id = @id OUTPUT;\n"
            + "EXEC msdb.dbo.sp_add_jobserver @job_id = @id;\nSELECT CONVERT(nvarchar(36), @id);", "msdb");
        if (made.Status != "completed" || !Guid.TryParse(made.Scalar, out var secondId))
        {
            await sql("IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = " + Quote(second) + ") EXEC msdb.dbo.sp_delete_job @job_name = " + Quote(second) + ", @delete_history = 1;", "msdb");
            check(false, "a second scratch Agent job can be created for Delete History: " + made.Error);
            return;
        }
        try
        {
            var jobId = id.ToString("D");
            var runs = await TablesAsync(service, info, json, new AgentHistoryLiveArgs([jobId], null, null, null, null, null));
            var run = runs.GetValueOrDefault(0)?.FirstOrDefault(cells => cells[1] == job);
            var key = run?[6]?.Split(':') is [_, var instanceText] && int.TryParse(instanceText, out var parsed) ? parsed : 0;
            check(run is not null && run[2] == "Succeeded" && run[4] == "1" && key > 0 && string.Equals(run[7], jobId, StringComparison.OrdinalIgnoreCase)
                && runs.GetValueOrDefault(2)?.Any(cells => cells[1] == job) == true,
                "agent.history on a live server lists the scratch job's run (Succeeded, one step, keyed by its outcome row) and the job among the sources: "
                + string.Join(",", run ?? []));
            if (key == 0) return;

            var selected = await TablesAsync(service, info, json, new AgentHistoryLiveArgs([jobId], 7, null, null, null, new AgentHistoryRunDto(jobId, key)));
            var steps = selected.GetValueOrDefault(1) ?? [];
            check(steps is [var outcome, var step] && outcome[1] == AgentHistoryReader.OutcomeStepName && outcome[2] == "Succeeded" && outcome[9] == key.ToString(System.Globalization.CultureInfo.InvariantCulture)
                && step[0] == "1" && step[1] == "Step 1",
                "agent.history with the run selected reads its job outcome row first, then its step: " + string.Join(" / ", steps.Select(cells => string.Join(",", cells))));

            // The job document's History (AG-6d): the same job with its usual durations, from its one succeeded run.
            var usual = (await TablesAsync(service, info, json, new AgentHistoryLiveArgs([jobId], Usual: true))).GetValueOrDefault(3) ?? [];
            check(usual.Count == 2 && usual[0][0] == "0" && usual[1][0] == "1" && usual.All(cells => cells[2] == "1" && long.TryParse(cells[1], out var seconds) && seconds >= 0),
                "agent.history with args.usual reads the job's usual durations, for the job and its step, from its succeeded run: " + string.Join(" / ", usual.Select(cells => string.Join(",", cells))));

            var message = await Call<AgentHistoryMessageResult>("agent.historyMessage", new AgentHistoryMessageArgs(info.Id, Guid.NewGuid().ToString(), jobId, key));
            check(message is { Error: null, Message.Length: > 0 }, "agent.historyMessage reads the outcome row's whole message from msdb: " + message.Error?.Code);

            async Task<ActionExecuteResult> Delete(AgentHistoryDeleteDto scope) =>
                await Call<ActionExecuteResult>("actions.execute", new ActionArgs(ActionService.DeleteJobHistoryAction, info.Id, Guid.NewGuid().ToString(), new ObjectRefDto("agent")) { AgentHistory = scope });
            async Task<string?> Rows() => (await sql("SELECT CONVERT(nvarchar(20), COUNT(*)) FROM msdb.dbo.sysjobhistory WHERE job_id = '" + jobId + "';", "msdb")).Scalar;
            static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title)) + (result.Error is { } error ? " " + error.Code + " " + error.Message : "");
            var jobs = new List<string> { jobId, secondId.ToString("D") };

            var older = await Delete(new AgentHistoryDeleteDto(jobs, OlderThan: new AgentHistoryPurgeDto(30, 1)));
            var kept = await Rows();
            check(older.Error is null && older.Steps is [{ Status: "done", Title: ActionService.DeleteHistoryStep }] && kept == "2",
                "Delete History older than 30 days on two jobs runs as one step and keeps the run from a moment ago: " + Steps(older) + " rows " + kept);

            var all = await Delete(new AgentHistoryDeleteDto(jobs, All: true));
            var left = await Rows();
            var gone = await Call<AgentHistoryMessageResult>("agent.historyMessage", new AgentHistoryMessageArgs(info.Id, Guid.NewGuid().ToString(), jobId, key));
            check(all.Error is null && all.Steps is [{ Status: "done" }] && left == "0" && gone.Error?.Code == "NOT_FOUND",
                "Delete History of all their history deletes the two jobs' rows, and the deleted row's message is then NOT_FOUND: " + Steps(all) + " rows " + left + " " + gone.Error?.Code);
        }
        finally { await sql("EXEC msdb.dbo.sp_delete_job @job_id = '" + secondId.ToString("D") + "', @delete_history = 1, @delete_unused_schedule = 1;", "msdb"); }
    }

    /// <summary>One agent.history subscription with these args, until its runs table arrives (and, with a run selected, its steps): every table's rows.</summary>
    private static async Task<Dictionary<int, List<string?[]>>> TablesAsync(SqlService service, ConnectionInfo info, JsonSerializerOptions json, AgentHistoryLiveArgs args)
    {
        var recorder = new LiveRecorder(9710);
        var task = service.Live.SubscribeAsync(new LiveSubscribeArgs(Guid.NewGuid().ToString(), info.Id, AgentHistoryReader.Source,
            [new LiveProbeArgs(AgentHistoryReader.ListProbe, 5000)], JsonSerializer.SerializeToElement(args, json)), recorder.Context, json);
        try
        {
            LiveSample? Last(LiveRecorder seen) => seen.Ticks.SelectMany(tick => tick.Samples).LastOrDefault(sample => sample.Probe == AgentHistoryReader.ListProbe && sample.Tables is not null);
            await recorder.WaitAsync(seen => Last(seen)?.Tables is { } tables && tables.Any(table => table.Table == 0) && (args.Run is null || tables.Any(table => table.Table == 1)), 30_000);
            return Last(recorder)?.Tables?.ToDictionary(table => table.Table, table => LiveResultChecks.RowsOf(service.Results, table.Descriptor)) ?? [];
        }
        finally
        {
            recorder.Context.Cancel(CancelReason.User);
            await task.WaitAsync(TimeSpan.FromSeconds(10));
            recorder.Dispose();
        }
    }
}
