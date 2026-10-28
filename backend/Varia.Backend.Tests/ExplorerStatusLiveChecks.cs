using System.Globalization;
using System.Text.Json;
using Varia.Backend.Live;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live SQL checks of Object Explorer's status chips, the `explorer` live source (VARIA_TEST_SQL_SERVER with
/// VARIA_TEST_SQL_SCRATCH=1): marked VariaScratch_ databases left read-only, offline, single-user and restoring are listed
/// with their states while an online one is not, and a state changed by another session leaves the list on the next
/// samples without any refresh; restore progress and availability groups report only what runs or exists; a SQL Server
/// Agent job of this run's own that waits a few seconds is counted while it runs (when the Agent runs); and a login without
/// server state gets its database states while the DMV probes open unavailable, as values. Only this run's databases, job
/// and login are created, each uniquely named and dropped in finally.</summary>
internal static class ExplorerStatusLiveChecks
{
    private const string Source = "explorer";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Object Explorer status live checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping uniquely named databases and an Agent job on a disposable development server.");
            return;
        }
        async Task<SqlRun> Sql(string text, string database = "master", string? connectionId = null)
        {
            var session = Guid.NewGuid().ToString();
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(connectionId ?? info.Id, session, database, text, Guid.NewGuid().ToString(), 1000, 60, StopOnError: true), json), json);
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(session), json), json); }
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        await scratch.CreateStatesAsync();
        var store = ((ILiveHost)service).Store;
        var hadr = ((ILiveHost)service).Profile(info.Id)!.Hadr;

        var view = Subscribe(service, info.Id, json);
        try
        {
            Dictionary<string, string?[]>? Ours(LiveRecorder recorder) => Latest(store, recorder, LiveSql.DatabasesProbe) is { } rows
                ? rows.Where(row => row[0] is { } name && name.StartsWith(scratch.Name, StringComparison.Ordinal)).ToDictionary(row => row[0]!, StringComparer.Ordinal) : null;
            var expected = new[] { scratch.ReadOnly, scratch.Offline, scratch.SingleUser, scratch.Restoring };
            var listed = await view.Recorder.WaitAsync(recorder => Ours(recorder) is { } rows && expected.All(rows.ContainsKey), 20_000);
            var rows = Ours(view.Recorder) ?? [];
            string Cells(string name) => rows.TryGetValue(name, out var row) ? string.Join(",", row.Skip(1)) : "missing";
            check(listed && view.Recorder.Opened is { Source: Source, Isolation: "readUncommitted" } opened && opened.Probes.All(probe => probe.State + " " + probe.Reason == Expected(service, info.Id, probe.Probe, permitted: true))
                && Cells(scratch.ReadOnly) == "0,0,1,0" && Cells(scratch.Offline) == "6,0,0,0" && Cells(scratch.SingleUser) == "0,1,0,0" && Cells(scratch.Restoring) == "1,0,0,0"
                && !rows.ContainsKey(scratch.Name),
                "explorer.databases lists the read-only (0,0,1,0), offline (6), single-user (user access 1) and restoring (1) scratch databases by state, user access, read-only and standby, and not the online one: "
                + string.Join(" | ", expected.Select(name => name[scratch.Name.Length..] + " " + Cells(name))));

            // Another session changes two of them: the next samples drop their rows, with no refresh and no tree reload.
            var changed = await Sql("ALTER DATABASE " + Bracket(scratch.ReadOnly) + " SET READ_WRITE WITH ROLLBACK IMMEDIATE;\nALTER DATABASE " + Bracket(scratch.SingleUser) + " SET MULTI_USER WITH ROLLBACK IMMEDIATE;");
            var before = view.Recorder.Ticks.Count;
            var followed = await view.Recorder.WaitAsync(recorder => recorder.Ticks.Count > before && Ours(recorder) is { } now
                && !now.ContainsKey(scratch.ReadOnly) && !now.ContainsKey(scratch.SingleUser) && now.ContainsKey(scratch.Offline) && now.ContainsKey(scratch.Restoring), 20_000);
            check(changed.Status == "completed" && followed,
                "a database set read-write and multi-user by another session leaves explorer.databases on its next samples, while the offline and restoring ones stay: " + changed.Error);

            // Nothing restores or recovers these databases, and a server without Always On has no groups.
            var progress = Latest(store, view.Recorder, LiveSql.ProgressProbe);
            var groups = Latest(store, view.Recorder, LiveSql.AvailabilityProbe);
            var errors = view.Recorder.Ticks.SelectMany(tick => tick.Errors ?? []).Select(error => error.Probe + " " + error.Code).ToList();
            check(progress is not null && !progress.Any(row => row[0]?.StartsWith(scratch.Name, StringComparison.Ordinal) == true) && groups is not null && (hadr || groups.Count == 0)
                && errors.Count == 0 && !view.Task.IsCompleted,
                "explorer.progress lists no restore of a database nothing restores, explorer.availability lists no group without Always On (" + (hadr ? "enabled here" : "not enabled") + "), and no probe failed: "
                + string.Join(", ", errors));
        }
        finally { await Stop(view); }

        await AgentAsync(check, service, info.Id, json, scratch.Name + "_job", (text, database) => Sql(text, database));
        await LowPrivilegeAsync(check, service, scratch, store, live, json, (text, database) => Sql(text, database));
    }

    /// <summary>How a probe opens on this connection's server: unavailable below its gates (an edition without Agent or Always
    /// On), unavailable without server state where it needs it, otherwise ok.</summary>
    private static string Expected(SqlService service, string connectionId, string probe, bool permitted)
    {
        var spec = LiveCatalog.Current.Probes[probe];
        var profile = ((ILiveHost)service).Profile(connectionId)!;
        var gated = spec.Gates is { } gates && (LiveConnections.Band(profile) < gates.MinMajor || !gates.Editions.Contains(profile.EngineEdition));
        return gated ? "unavailable NOT_SUPPORTED" : spec.Permission == "serverState" && !permitted ? "unavailable PERMISSION_DENIED" : "ok ";
    }

    private static (Task<LiveEnd> Task, LiveRecorder Recorder, string Id) Subscribe(SqlService service, string connectionId, JsonSerializerOptions json)
    {
        var recorder = new LiveRecorder((uint)Random.Shared.Next(20_000, 30_000));
        var id = Guid.NewGuid().ToString();
        var task = service.Live.SubscribeAsync(new LiveSubscribeArgs(id, connectionId, Source,
            [new(LiveSql.DatabasesProbe, 2000), new(LiveSql.ProgressProbe, 2000), new(LiveSql.AgentProbe, 5000), new(LiveSql.AvailabilityProbe, 5000)]), recorder.Context, json);
        return (task, recorder, id);
    }

    private static async Task<LiveEnd> Stop((Task<LiveEnd> Task, LiveRecorder Recorder, string Id) view)
    {
        view.Recorder.Context.Cancel(CancelReason.User);
        var end = await view.Task.WaitAsync(TimeSpan.FromSeconds(10));
        view.Recorder.Dispose();
        return end;
    }

    /// <summary>The newest stored revision of a probe's table, as rows of cell text; null before one arrived (or when the
    /// next sample retired it while it was read).</summary>
    private static List<string?[]>? Latest(Results.ResultStore store, LiveRecorder recorder, string probe)
    {
        var sample = recorder.Ticks.SelectMany(tick => tick.Samples).LastOrDefault(item => item.Probe == probe && item.Tables is { Count: > 0 });
        if (sample is null) return null;
        try { return LiveResultChecks.RowsOf(store, sample.Tables![0].Descriptor); }
        catch (InvalidOperationException) { return null; }
    }

    /// <summary>The newest running-jobs value, or null before a sample.</summary>
    private static double? Jobs(LiveRecorder recorder) =>
        recorder.Ticks.SelectMany(tick => tick.Samples).LastOrDefault(item => item.Probe == LiveSql.AgentProbe && item.Metrics is { Length: 1 })?.Metrics![0];

    /// <summary>An Agent job of this run's own that waits 30 s: counted while it runs, and no longer once it is stopped. Stale
    /// jobs of earlier runs (VariaScratch_…_job, older than 6 hours) are deleted first; this one is deleted in finally.</summary>
    private static async Task AgentAsync(Action<bool, string> check, SqlService service, string connectionId, JsonSerializerOptions json, string job, Func<string, string, Task<SqlRun>> sql)
    {
        var agent = (await sql("SELECT COUNT(*) FROM sys.dm_server_services WHERE servicename LIKE N'SQL Server Agent%' AND status = 4;", "master")).Scalar;
        if (agent != "1")
        {
            Console.WriteLine("Object Explorer status Agent checks skipped: SQL Server Agent is not running on this server.");
            return;
        }
        var stale = await sql("SELECT j.name FROM msdb.dbo.sysjobs AS j WHERE j.name LIKE N'VariaScratch[_]%[_]job' AND j.date_created < DATEADD(hour, -6, GETDATE());", "msdb");
        foreach (var row in stale.Sets.Count == 0 ? [] : stale.Sets[0])
            if (row[0] is { } name && ScratchDatabase.IsScratchName(name)) await sql("EXEC msdb.dbo.sp_delete_job @job_name = " + Literal(name) + ", @delete_history = 1;", "msdb");
        var view = Subscribe(service, connectionId, json);
        try
        {
            var idle = await view.Recorder.WaitAsync(recorder => Jobs(recorder) is not null, 20_000) ? Jobs(view.Recorder)!.Value : -1;
            var created = await sql("EXEC msdb.dbo.sp_add_job @job_name = " + Literal(job) + ", @description = N'varia.scratch';\n"
                + "EXEC msdb.dbo.sp_add_jobstep @job_name = " + Literal(job) + ", @step_name = N'wait', @subsystem = N'TSQL', @database_name = N'master', @command = N'WAITFOR DELAY ''00:00:30'';';\n"
                + "EXEC msdb.dbo.sp_add_jobserver @job_name = " + Literal(job) + ";\nEXEC msdb.dbo.sp_start_job @job_name = " + Literal(job) + ";", "msdb");
            // The job counts once the Agent has started it (its activity row has a start date and no stop date).
            var running = created.Status == "completed" && await view.Recorder.WaitAsync(recorder => Jobs(recorder) >= idle + 1, 30_000);
            var during = Jobs(view.Recorder);
            check(created.Status == "completed" && idle >= 0 && running,
                "explorer.agent counts a SQL Server Agent job while it runs (" + idle + " before, " + during + " while this run's own job waits): " + created.Error);
            var stopped = await sql("EXEC msdb.dbo.sp_stop_job @job_name = " + Literal(job) + ";", "msdb");
            var after = await view.Recorder.WaitAsync(recorder => Jobs(recorder) <= during - 1, 30_000);
            check(stopped.Status == "completed" && after, "explorer.agent stops counting the job once it is stopped (" + Jobs(view.Recorder) + " after): " + stopped.Error);
        }
        finally
        {
            await Stop(view);
            await sql("IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = " + Literal(job) + ") EXEC msdb.dbo.sp_delete_job @job_name = " + Literal(job) + ", @delete_history = 1;", "msdb");
        }
    }

    /// <summary>A login with no server permission: the database states arrive (sys.databases needs none), the DMV probes
    /// open unavailable (PERMISSION_DENIED), and the view keeps running.</summary>
    private static async Task LowPrivilegeAsync(Action<bool, string> check, SqlService service, ScratchDatabase scratch, Results.ResultStore store, Func<string, ConnectOptions> live,
        JsonSerializerOptions json, Func<string, string, Task<SqlRun>> sql)
    {
        if (!await scratch.CreateLoginAsync())
        {
            Console.WriteLine("Object Explorer status permission checks skipped: this server accepts Windows logins only.");
            return;
        }
        var options = live("master") with { Authentication = "sql", Username = scratch.Login, Password = scratch.Password };
        var connected = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(options, json), json);
        (Task<LiveEnd> Task, LiveRecorder Recorder, string Id)? view = null;
        try
        {
            view = Subscribe(service, connected.Id, json);
            var recorder = view.Value.Recorder;
            var agentRuns = Expected(service, connected.Id, LiveSql.AgentProbe, permitted: false) == "ok ";
            var sampled = await recorder.WaitAsync(item => Latest(store, item, LiveSql.DatabasesProbe) is { } rows && rows.Any(row => row[0] == scratch.Offline)
                && (!agentRuns || item.Ticks.Any(tick => tick.Samples.Any(sample => sample.Probe == LiveSql.AgentProbe) || tick.Errors?.Any(error => error.Probe == LiveSql.AgentProbe) == true)), 20_000);
            var opened = recorder.Opened?.Probes.ToDictionary(probe => probe.Probe, probe => probe.State + " " + probe.Reason) ?? [];
            var agent = recorder.Ticks.SelectMany(tick => tick.Errors ?? []).FirstOrDefault(error => error.Probe == LiveSql.AgentProbe);
            check(sampled && opened.Count == 4 && opened.All(item => item.Value == Expected(service, connected.Id, item.Key, permitted: false))
                && (!agentRuns || agent is { Code: "PERMISSION_DENIED", Terminal: true }) && !view.Value.Task.IsCompleted,
                "a login without server permissions gets database states, while restore progress and availability groups open unavailable and msdb refuses the Agent count (PERMISSION_DENIED), as values: "
                + string.Join(", ", opened.Select(item => item.Key + " " + item.Value)) + "; agent " + agent?.Code + " " + agent?.Number);
        }
        finally
        {
            if (view is { } running) await Stop(running);
            await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(connected.Id), json), json);
            // The login is this run's own: its sessions, if a pool kept one, are ours to end before the login is dropped.
            await sql("DECLARE @kill nvarchar(max) = N'';\nSELECT @kill += N'KILL ' + CONVERT(nvarchar(11), s.session_id) + N';' FROM sys.dm_exec_sessions AS s WHERE s.login_name = "
                + Literal(scratch.Login!) + ";\nEXEC (@kill);", "master");
        }
    }

    private static string Literal(string value) => "N'" + value.Replace("'", "''") + "'";
    private static string Bracket(string value) => "[" + value.Replace("]", "]]") + "]";
}
