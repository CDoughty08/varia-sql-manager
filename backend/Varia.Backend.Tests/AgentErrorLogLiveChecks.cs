using System.Text.Json;
using Varia.Backend.Actions;
using Varia.Backend.Agent;
using Varia.Backend.Live;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live checks of the Agent error logs (AG-5b), part of the Agent suite with VARIA_TEST_SQL_SCRATCH=1 (Recycle changes the server's
/// Agent error log): agent.errorLogs lists Current first and the archives in order; agent.errorLog reads Current's rows through
/// live.subscribe; Recycle closes Current, which becomes Archive #1 with its size, and the new Current gets Agent's [412] line.
/// With SQL Server Agent stopped, Recycle must be AGENT_STOPPED instead.</summary>
internal static class AgentErrorLogLiveChecks
{
    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        Task<AgentErrorLogsResult> List() => Call<AgentErrorLogsResult>("agent.errorLogs", new AgentErrorLogsArgs(info.Id, Guid.NewGuid().ToString()));

        var before = await List();
        var archives = before.Logs.Select(log => log.Archive).ToList();
        check(before.Error is null && archives is [0, ..] && archives.Skip(1).SequenceEqual(archives.Skip(1).Order()) && archives.Distinct().Count() == archives.Count
            && (!before.Archives || before.Logs.All(log => log.Date is { Length: 19 })),
            "agent.errorLogs on a live server lists Current first and the archives in order, each with its date (xp_enumerrorlogs sends it as text): " + string.Join(",", archives) + " " + before.Error?.Code);
        var rows = await RowsAsync(service, info, json, new AgentErrorLogLiveArgs([0], null, null));
        check(rows is not null && rows.All(cells => cells[1] == "Current" && cells[5] == "0" && cells[4]?.StartsWith("0:", StringComparison.Ordinal) == true),
            "agent.errorLog reads Current's rows through live.subscribe, each named Current and keyed by archive and place: " + rows?.Count);

        var recycled = await Call<ActionExecuteResult>("actions.execute", new ActionArgs(ActionService.RecycleErrorLogAction, info.Id, Guid.NewGuid().ToString(), new ObjectRefDto("agent")));
        if (recycled.Error?.Code == "AGENT_STOPPED")
        {
            check(recycled.Steps is [{ Status: not "done" }] or [], "Recycle with SQL Server Agent stopped is AGENT_STOPPED and recycles nothing: " + recycled.Error.Message);
            return;
        }
        // Agent closes the log when it handles the notification, a moment after the call returns: the wait ends once Current no longer holds
        // the newest row read before (an earlier Recycle's 412 line in the old Current cannot end it), and the new Current has the 412 line.
        var newest = rows is [var first, ..] ? first[0] + "|" + first[3] : null;
        List<string?[]>? fresh = null;
        var moved = false;
        var deadline = Environment.TickCount64 + 20_000;
        while (Environment.TickCount64 < deadline)
        {
            var currentRows = await RowsAsync(service, info, json, new AgentErrorLogLiveArgs([0], null, null)) ?? [];
            moved = newest is null || currentRows.All(cells => cells[0] + "|" + cells[3] != newest);
            fresh = currentRows.Where(cells => cells[3]?.Contains("412]", StringComparison.Ordinal) == true).ToList();
            if (moved && fresh.Count > 0) break;
            await Task.Delay(500);
        }
        var after = await List();
        var oldCurrent = before.Logs.FirstOrDefault(log => log.Archive == 0);
        var archived = after.Logs.FirstOrDefault(log => log.Archive == 1);
        // Agent may write to the old Current between the listing and Recycle, so its archive is at least the size listed.
        check(recycled.Error is null && recycled.Steps is [{ Status: "done", Title: ActionService.RecycleStep }] && moved && fresh is { Count: > 0 }
            && (!before.Archives || (archived is not null && archived.Bytes >= oldCurrent?.Bytes)),
            "Recycle starts a new Current with Agent's 412 line, and the old Current is Archive #1 at least its listed size: "
            + string.Join(", ", recycled.Steps.Select(step => step.Status + ":" + step.Title)) + " " + recycled.Error?.Code + " moved " + moved + " " + fresh?.Count + " " + archived?.Bytes + "/" + oldCurrent?.Bytes);
    }

    /// <summary>One agent.errorLog subscription with these args, until its entries table arrives: its rows, or null when the read failed.</summary>
    private static async Task<List<string?[]>?> RowsAsync(SqlService service, ConnectionInfo info, JsonSerializerOptions json, AgentErrorLogLiveArgs args)
    {
        var recorder = new LiveRecorder(9711);
        var task = service.Live.SubscribeAsync(new LiveSubscribeArgs(Guid.NewGuid().ToString(), info.Id, AgentErrorLogReader.Source,
            [new LiveProbeArgs(AgentErrorLogReader.ReadProbe, 30_000)], JsonSerializer.SerializeToElement(args, json)), recorder.Context, json);
        try
        {
            LiveSample? Last(LiveRecorder seen) => seen.Ticks.SelectMany(tick => tick.Samples).LastOrDefault(sample => sample.Probe == AgentErrorLogReader.ReadProbe && sample.Tables is not null);
            await recorder.WaitAsync(seen => Last(seen)?.Tables is { Count: > 0 }, 30_000);
            return Last(recorder)?.Tables?.FirstOrDefault(table => table.Table == 0) is { } table ? LiveResultChecks.RowsOf(service.Results, table.Descriptor) : null;
        }
        finally
        {
            recorder.Context.Cancel(CancelReason.User);
            await task.WaitAsync(TimeSpan.FromSeconds(10));
            recorder.Dispose();
        }
    }
}
