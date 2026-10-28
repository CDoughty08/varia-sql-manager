using System.Globalization;
using System.Text.Json;
using Varia.Backend.Live;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live SQL checks of Object Explorer's status chips, the `explorer` live source (VARIA_TEST_SQL_SERVER with
/// VARIA_TEST_SQL_SCRATCH=1): marked VariaScratch_ databases left read-only, offline, single-user and restoring are listed
/// with their states while an online one is not, and a state changed by another session leaves the list on the next
/// samples without any refresh; restore progress and availability groups report only what runs or exists, a restore is
/// named by the database it restores (a snapshot revert, sampled while it runs) and the lock DMV is read only for RESTORE
/// requests; the view's sessions sit in master, so a database the connection opened in can go offline under it; a SQL
/// Server Agent job of this run's own that waits a few seconds is counted while it runs (when the Agent runs); and a login
/// without server state gets its database states while the DMV probes open unavailable, as values. Only this run's
/// databases, job and login are created, each uniquely named and dropped in finally.</summary>
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
        async Task<(QueryResult Result, List<List<string?[]>> Sets)> Run(string text, string database, string? connectionId)
        {
            var session = Guid.NewGuid().ToString();
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(connectionId ?? info.Id, session, database, text, Guid.NewGuid().ToString(), 1000, 60, StopOnError: true), json), json);
                return (result, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(session), json), json); }
        }
        async Task<SqlRun> Sql(string text, string database = "master", string? connectionId = null)
        {
            var (result, sets) = await Run(text, database, connectionId);
            return new(result.Status, result.Error?.Message, sets);
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

        var band = LiveConnections.Band(((ILiveHost)service).Profile(info.Id)!);
        await LockReadsAsync(check, band, (text, database) => Run(text, database, null));
        await RestoreAsync(check, scratch, band, (text, database) => Sql(text, database));
        await PoolAsync(check, service, scratch, store, live, json, (text, database) => Sql(text, database));
        await AgentAsync(check, service, info.Id, json, scratch.Job, (text, database) => Sql(text, database));
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

    /// <summary>The restore progress probe scans the lock manager (sys.dm_tran_locks) only for RESTORE requests: its statement,
    /// profiled on this server, executes the lock DMV no more often than RESTORE requests run (counted just before and after,
    /// since other runs' restores may come and go), and never while none runs.</summary>
    private static async Task LockReadsAsync(Action<bool, string> check, int band, Func<string, string, Task<(QueryResult Result, List<List<string?[]>> Sets)>> run)
    {
        const string restores = "SELECT COUNT(*) FROM sys.dm_exec_requests WHERE command IN (N'RESTORE DATABASE', N'RESTORE LOG')";
        var body = LiveSql.For(LiveSql.ProgressProbe, band)!.Body;
        var (result, sets) = await run("SET NOCOUNT ON;\nSET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\nDECLARE @before int = (" + restores + ");\n"
            + "SET STATISTICS PROFILE ON;\n" + body + "\nSET STATISTICS PROFILE OFF;\nSELECT @before, (" + restores + ");", "master");
        // Result sets: the probe's rows, its profile, then the RESTORE requests before and after.
        var profile = result.ResultSets.Count == 3 ? result.ResultSets[1] : null;
        int Column(string name) => profile?.Columns.Select(column => column.Name).ToList().IndexOf(name) ?? -1;
        int executes = Column("Executes"), op = Column("PhysicalOp"), output = Column("OutputList");
        var locks = profile is null || executes < 0 || op < 0 || output < 0 ? [] : sets[1].Where(row => row[op] == "Table-valued function" && row[output]?.Contains("SYSLOCKINFORMATION", StringComparison.Ordinal) == true)
            .Select(row => int.Parse(row[executes]!, CultureInfo.InvariantCulture)).ToList();
        var running = sets.Count == 3 ? Math.Max(int.Parse(sets[2][0][0]!, CultureInfo.InvariantCulture), int.Parse(sets[2][0][1]!, CultureInfo.InvariantCulture)) : -1;
        check(result.Status == "completed" && locks.Count == 1 && running >= 0 && locks[0] <= running,
            "explorer.progress reads the lock DMV once per RESTORE request and never otherwise (" + string.Join(",", locks) + " lock scans, " + running + " RESTORE requests): " + result.Error?.Message);
    }

    /// <summary>A RESTORE runs in master while it holds its target exclusively: a snapshot revert of this run's own database,
    /// sampled with the probe's own statement as fast as it runs, is listed under the reverted database, never under master or
    /// msdb. A revert is over in a moment, so a run that saw none of it reverts once more.</summary>
    private static async Task RestoreAsync(Action<bool, string> check, ScratchDatabase scratch, int band, Func<string, string, Task<SqlRun>> sql)
    {
        if (!await scratch.CreateRevertAsync())
        {
            Console.WriteLine("Object Explorer status restore checks skipped: this server could not create a database snapshot.");
            return;
        }
        var body = LiveSql.For(LiveSql.ProgressProbe, band)!.Body;
        // Until the revert was seen and its lock is gone, for at most 10 s; the rows of other runs' restores are left out.
        var poll = "SET NOCOUNT ON;\nSET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;\n"
            + "DECLARE @seen TABLE (name sysname NOT NULL, command nvarchar(32) NOT NULL, [percent] int NULL);\n"
            + "DECLARE @target sysname = " + Literal(scratch.Reverted) + ", @end datetime2 = DATEADD(second, 10, SYSDATETIME());\n"
            + "WHILE SYSDATETIME() < @end\nBEGIN\n"
            + "INSERT @seen (name, command, [percent])\n" + body + "\n"
            + "IF EXISTS (SELECT 1 FROM @seen WHERE name = @target) AND NOT EXISTS (SELECT 1 FROM sys.dm_tran_locks WHERE resource_type = N'DATABASE' AND request_mode = N'X' AND resource_database_id = DB_ID(@target)) BREAK;\n"
            + "END\n"
            + "SELECT name, command, COUNT(*) FROM @seen WHERE name IN (@target, N'master', N'msdb') GROUP BY name, command ORDER BY name, command;";
        SqlRun seen = new("failed", "not run", []), reverted = seen;
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var polling = sql(poll, "master");
            await Task.Delay(300);
            reverted = await sql("RESTORE DATABASE " + Bracket(scratch.Reverted) + " FROM DATABASE_SNAPSHOT = " + Literal(scratch.RevertSnapshot) + ";", "master");
            seen = await polling;
            if (seen.Sets.Count == 1 && seen.Sets[0].Any(row => row[0] == scratch.Reverted)) break;
            Console.WriteLine("Object Explorer status restore check: the revert ran between samples; reverting once more.");
        }
        var lines = seen.Sets.Count == 1 ? seen.Sets[0].Select(row => (row[0] == scratch.Reverted ? "the reverted database" : row[0]) + " " + row[1] + " x" + row[2]).ToList() : [];
        check(reverted.Status == "completed" && seen.Status == "completed" && seen.Sets.Count == 1
            && seen.Sets[0].Any(row => row[0] == scratch.Reverted && row[1] == "RESTORE DATABASE") && seen.Sets[0].All(row => row[0] == scratch.Reverted),
            "explorer.progress names a running restore by the database it restores (a snapshot revert, whose request runs in master), never master or msdb: "
            + string.Join(", ", lines) + " " + reverted.Error + seen.Error);
    }

    /// <summary>The view's sessions sit in master, not in the database the connection opened in (the Connect dialog's
    /// Database): that database goes offline under a running view, whose next samples list it OFFLINE without an error, and
    /// no session of the view is in it.</summary>
    private static async Task PoolAsync(Action<bool, string> check, SqlService service, ScratchDatabase scratch, Results.ResultStore store, Func<string, ConnectOptions> live,
        JsonSerializerOptions json, Func<string, string, Task<SqlRun>> sql)
    {
        var connected = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(live(scratch.Name), json), json);
        (Task<LiveEnd> Task, LiveRecorder Recorder, string Id)? view = null;
        var offline = false;
        try
        {
            view = Subscribe(service, connected.Id, json);
            var recorder = view.Value.Recorder;
            var sampled = await recorder.WaitAsync(item => item.Opened?.Spid is not null && Latest(store, item, LiveSql.DatabasesProbe) is not null, 20_000);
            var spid = recorder.Opened?.Spid ?? 0;
            var sessions = await sql("SELECT DB_NAME(s.database_id) FROM sys.dm_exec_sessions AS s WHERE s.session_id = " + spid.ToString(CultureInfo.InvariantCulture) + ";\n"
                + "SELECT COUNT(*) FROM sys.dm_exec_sessions AS s WHERE s.host_process_id = " + Environment.ProcessId.ToString(CultureInfo.InvariantCulture)
                + " AND s.program_name LIKE N'%" + LiveConnections.ServerSuffix + "' AND s.database_id = DB_ID(" + Literal(scratch.Name) + ");", "master");
            var where = sessions.Sets.Count == 2 && sessions.Sets[0].Count == 1 ? sessions.Sets[0][0][0] : null;
            var inside = sessions.Sets.Count == 2 ? sessions.Sets[1][0][0] : null;
            // Its own sessions in the database (the connection's) end; the view's are elsewhere and carry on.
            var ticks = recorder.Ticks.Count;
            var altered = await sql("ALTER DATABASE " + Bracket(scratch.Name) + " SET OFFLINE WITH ROLLBACK IMMEDIATE;", "master");
            offline = altered.Status == "completed";
            var followed = offline && await recorder.WaitAsync(item => item.Ticks.Skip(ticks).Any(tick => tick.Samples.Any(sample => sample.Probe == LiveSql.DatabasesProbe))
                && Latest(store, item, LiveSql.DatabasesProbe)?.FirstOrDefault(row => row[0] == scratch.Name) is { } row && row[1] == "6", 20_000);
            var errors = recorder.Ticks.Skip(ticks).SelectMany(tick => tick.Errors ?? []).Select(error => error.Probe + " " + error.Code).ToList();
            check(sampled && where == "master" && inside == "0" && followed && errors.Count == 0 && !view.Value.Task.IsCompleted,
                "Object Explorer's status view runs in master, not in the database its connection opened in, so that database goes offline under it and is listed OFFLINE with no error (session in "
                + where + ", " + inside + " of its sessions in the database): " + string.Join(", ", errors) + " " + altered.Error);
        }
        finally
        {
            if (view is { } running) await Stop(running);
            await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(connected.Id), json), json);
            if (offline) await sql("ALTER DATABASE " + Bracket(scratch.Name) + " SET ONLINE;", "master");
        }
    }

    /// <summary>An Agent job of this run's own that waits 30 s: counted while it runs, and no longer once it is stopped. Agent
    /// jobs are server-wide, and other runs start and stop theirs, so each value is compared with direct counts of the Agent's
    /// current session taken just before and after the sample, while this job's own row says it runs (or has stopped). Stale
    /// jobs of earlier runs (named as a run names its own, marked, older than 6 hours) are deleted first, by id; this one is
    /// deleted in finally.</summary>
    private static async Task AgentAsync(Action<bool, string> check, SqlService service, string connectionId, JsonSerializerOptions json, string job, Func<string, string, Task<SqlRun>> sql)
    {
        var agent = (await sql("SELECT COUNT(*) FROM sys.dm_server_services WHERE servicename LIKE N'SQL Server Agent%' AND status = 4;", "master")).Scalar;
        if (agent != "1")
        {
            Console.WriteLine("Object Explorer status Agent checks skipped: SQL Server Agent is not running on this server.");
            return;
        }
        var stale = await sql("SELECT CONVERT(nvarchar(36), j.job_id), j.name FROM msdb.dbo.sysjobs AS j WHERE j.name LIKE N'VariaScratch[_]%[_]job' AND j.description = "
            + Literal(ScratchDatabase.JobMarker) + " AND j.date_created < DATEADD(hour, -6, GETDATE());", "msdb");
        foreach (var row in stale.Sets.Count == 0 ? [] : stale.Sets[0])
            if (row[0] is { } id && Guid.TryParse(id, out var jobId) && row[1] is { } name && ScratchDatabase.IsScratchJob(name))
            {
                Console.WriteLine("Deleting stale scratch Agent job " + name);
                await sql("EXEC msdb.dbo.sp_delete_job @job_id = '" + jobId.ToString("D") + "', @delete_history = 1;", "msdb");
            }
        // Independent of the probe's own statement: the Agent's newest session by its start time, and this job's row in it.
        var direct = "DECLARE @session int = (SELECT TOP (1) s.session_id FROM msdb.dbo.syssessions AS s ORDER BY s.agent_start_date DESC, s.session_id DESC);\n"
            + "SELECT COUNT(*), COUNT(CASE WHEN j.name = " + Literal(job) + " THEN 1 END) FROM msdb.dbo.sysjobactivity AS a JOIN msdb.dbo.sysjobs AS j ON j.job_id = a.job_id\n"
            + "WHERE a.session_id = @session AND a.start_execution_date IS NOT NULL AND a.stop_execution_date IS NULL;";
        async Task<(int Total, bool Ours)?> Direct()
        {
            var counts = await sql(direct, "msdb");
            return counts.Status == "completed" && counts.Sets.Count == 1 && counts.Sets[0].Count == 1
                ? (int.Parse(counts.Sets[0][0][0]!, CultureInfo.InvariantCulture), counts.Sets[0][0][1] != "0") : null;
        }
        var view = Subscribe(service, connectionId, json);
        // A sample agrees when this job's row says the same before and after it, and its value lies between the two counts.
        async Task<(bool Agrees, string Detail)> Agrees(bool ours)
        {
            var detail = "";
            var until = DateTime.UtcNow.AddSeconds(40);
            while (DateTime.UtcNow < until)
            {
                var before = await Direct();
                var ticks = view.Recorder.Ticks.Count;
                var sampled = await view.Recorder.WaitAsync(recorder => recorder.Ticks.Skip(ticks).Any(tick => tick.Samples.Any(sample => sample.Probe == LiveSql.AgentProbe)), 15_000);
                var value = Jobs(view.Recorder);
                var after = await Direct();
                detail = before + " " + value + " " + after;
                if (sampled && before is { } b && after is { } a && value is { } v && b.Ours == ours && a.Ours == ours
                    && v >= Math.Min(b.Total, a.Total) && v <= Math.Max(b.Total, a.Total) && (!ours || v >= 1)) return (true, detail);
            }
            return (false, detail);
        }
        try
        {
            var created = await sql("EXEC msdb.dbo.sp_add_job @job_name = " + Literal(job) + ", @description = " + Literal(ScratchDatabase.JobMarker) + ";\n"
                + "EXEC msdb.dbo.sp_add_jobstep @job_name = " + Literal(job) + ", @step_name = N'wait', @subsystem = N'TSQL', @database_name = N'master', @command = N'WAITFOR DELAY ''00:00:30'';';\n"
                + "EXEC msdb.dbo.sp_add_jobserver @job_name = " + Literal(job) + ";\nEXEC msdb.dbo.sp_start_job @job_name = " + Literal(job) + ";", "msdb");
            var (running, during) = created.Status == "completed" ? await Agrees(ours: true) : (false, "");
            check(created.Status == "completed" && running,
                "explorer.agent counts a SQL Server Agent job while it runs, as the Agent's current session does (before, sample, after: " + during + "): " + created.Error);
            var stopped = await sql("EXEC msdb.dbo.sp_stop_job @job_name = " + Literal(job) + ";", "msdb");
            var (gone, after) = stopped.Status == "completed" ? await Agrees(ours: false) : (false, "");
            check(stopped.Status == "completed" && gone, "explorer.agent stops counting the job once it is stopped (before, sample, after: " + after + "): " + stopped.Error);
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
