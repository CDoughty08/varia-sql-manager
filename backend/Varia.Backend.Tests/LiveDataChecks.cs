using System.Globalization;
using System.Text.Json;
using Varia.Backend.Live;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live SQL checks of the Activity Monitor source (VARIA_TEST_SQL_SERVER): every live query's columns as SQL Server
/// returns them, activity.overview's rates and clock, its pool and prologue as the server sees them, recovery after its
/// session is killed, a statement over its budget reported as TIMEOUT, a lock wait reported as BLOCKED while the view keeps
/// ticking, and (VARIA_TEST_SQL_SCRATCH=1) a login without server state refused as a value. Only the sessions these checks
/// open are killed, each in a batch that first proves it is this process's own Activity Monitor session, and the only
/// objects created are one global temporary table, dropped in finally, and the scratch login.</summary>
internal static class LiveDataChecks
{
    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        async Task<QueryResult> Execute(string text, string? session = null)
        {
            var id = session ?? Guid.NewGuid().ToString();
            try
            {
                return (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(info.Id, id, "master", text, Guid.NewGuid().ToString(), 1000, 60, StopOnError: true), json), json);
            }
            finally { if (session is null) await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(id), json), json); }
        }
        async Task<SqlRun> Sql(string text, string? session = null)
        {
            var result = await Execute(text, session);
            return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
        }
        uint next = 9000;
        (Task<LiveEnd> Task, LiveRecorder Recorder, string Id) Subscribe(string connectionId, int intervalMs)
        {
            var recorder = new LiveRecorder(++next);
            var id = Guid.NewGuid().ToString();
            var task = service.Live.SubscribeAsync(new LiveSubscribeArgs(id, connectionId, "activity", [new LiveProbeArgs(LiveSql.OverviewProbe, intervalMs)]), recorder.Context, json);
            return (task, recorder, id);
        }
        static async Task<LiveEnd> Stop((Task<LiveEnd> Task, LiveRecorder Recorder, string Id) view)
        {
            view.Recorder.Context.Cancel(CancelReason.User);
            var end = await view.Task.WaitAsync(TimeSpan.FromSeconds(10));
            view.Recorder.Dispose();
            return end;
        }
        // The session the view holds now: a tick names every session it opened after the opened frame.
        static int LatestSpid(LiveRecorder recorder) => recorder.Ticks.LastOrDefault(tick => tick.Spid is not null)?.Spid ?? recorder.Opened?.Spid ?? 0;
        // A session number is reused as soon as it is free, so the kill names the view's session only if, in the same batch,
        // it is still this process's own Activity Monitor session; otherwise it kills nothing (0).
        async Task<string?> KillOwnAsync(int spid) => (await Sql("DECLARE @spid int = " + spid.ToString(CultureInfo.InvariantCulture) + ", @pid int = "
            + Environment.ProcessId.ToString(CultureInfo.InvariantCulture) + ";\n"
            + "IF EXISTS (SELECT 1 FROM sys.dm_exec_sessions AS s WHERE s.session_id = @spid AND s.session_id <> @@SPID AND s.host_process_id = @pid AND s.program_name LIKE N'% - Activity Monitor')\n"
            + "BEGIN\n    DECLARE @kill nvarchar(40) = N'KILL ' + CONVERT(nvarchar(11), @spid) + N';';\n    EXEC (@kill);\n    SELECT 1 AS killed;\nEND\nELSE SELECT 0 AS killed;")).Scalar;

        // Every live query at the server's band returns the columns it declares, by name, in order and numeric (the sampler
        // reads values by declared position).
        var band = LiveConnections.Band((service as ILiveHost).Profile(info.Id)!);
        var shapes = new List<string>();
        foreach (var query in LiveSql.All(LiveCatalog.Current).Where(query => query.Band == band))
        {
            var result = await Execute(query.Text(LiveSql.UncommittedPrologue));
            var columns = result.ResultSets is [{ } set] ? set.Columns.Select(column => (column.Name, Numeric(column.DataType))).ToList() : [];
            if (result.Status != "completed" || !query.Returns(columns))
                shapes.Add(query.Probe + " " + result.Status + ": " + string.Join(", ", result.ResultSets.SelectMany(item => item.Columns).Select(column => column.Name + " " + column.DataType)));
        }
        check(band is >= LiveSql.MinBand and <= LiveSql.MaxBand && shapes.Count == 0,
            "every live query at the server's band (" + band + ") returns the columns it declares, by name, in order and numeric: " + string.Join("; ", shapes));

        // Rates on the server's clock: a baseline with gauges only, then every series, the second within about a second
        // (the quick second sample; the interval is 2 s). Measured once more when a tick failed (a busy shared server).
        async Task<((Task<LiveEnd> Task, LiveRecorder Recorder, string Id) View, bool Sampled, List<LiveTickEvent> Ticks)> Overview()
        {
            var view = Subscribe(info.Id, 2000);
            var sampled = await view.Recorder.WaitAsync(recorder => recorder.Ticks.Count >= 3, 20_000);
            return (view, sampled, view.Recorder.Ticks.Take(3).ToList());
        }
        var measured = await Overview();
        if (measured.Ticks.Any(tick => tick.Errors is not null))
        {
            Console.WriteLine("Timing: an activity.overview tick failed (" + string.Join(", ", measured.Ticks.SelectMany(tick => tick.Errors ?? []).Select(error => error.Code)) + "); measuring it once more.");
            await Stop(measured.View);
            measured = await Overview();
        }
        var (overview, sampled, ticks) = measured;
        var opened = overview.Recorder.Opened;
        var samples = ticks.Where(tick => tick.Samples.Count > 0).Select(tick => tick.Samples[0]).ToList();
        check(sampled && ticks.All(tick => tick.Errors is null && tick.Samples.Count == 1) && opened is { Source: "activity", Band: >= LiveSql.MinBand and <= LiveSql.MaxBand, Spid: > 0, Isolation: "readUncommitted", Probes: [{ State: "ok" }] }
            && samples[0] is { Gap: "baseline", Metrics: [null, >= 0, null, null, null, >= 1] }
            && samples.Skip(1).All(sample => sample.Metrics is { Length: 6 } metrics && metrics.All(value => value is { } v && double.IsFinite(v) && v >= 0) && metrics[0] <= 100 && sample.EffectiveIntervalMs == 2000),
            "activity.overview opens on the server's band and its own session, reading uncommitted; its baseline carries gauges only, and the next samples every series (CPU 0 to 100 %): "
            + string.Join(" | ", ticks.Select(tick => string.Join(",", tick.Errors?.Select(error => error.Code) ?? []) + string.Join(",", tick.Samples.Select(sample => sample.Gap + " " + string.Join(",", sample.Metrics ?? []))))));
        // ms_ticks is read at some point while a statement runs, so the server's elapsed time lies between the backend's
        // clock less the later statement's cost and plus the earlier one's (ms_ticks has the system timer's resolution).
        var (cost1, cost2) = (samples[1].CostMs, samples[2].CostMs);
        var wall = ticks[2].SampledAt - ticks[1].SampledAt;
        var server = samples[2].ElapsedMs ?? -1;
        const int Slack = 100;
        check(server >= wall - cost2 - Slack && server <= wall + cost1 + Slack,
            "a sample's elapsed time is the server's own (ms_ticks), within the two statements' costs of the backend's clock: " + server + " vs " + wall + " ms (costs " + cost1 + ", " + cost2 + ")");
        var quick = ticks[1].SampledAt - ticks[0].SampledAt;
        check(quick <= 1000 + cost2 + 250, "the second sample comes about a second after the baseline, not at the 2 s interval: " + quick + " ms (cost " + cost2 + ")");

        // The pool and prologue, as SQL Server sees the view's session.
        var spid = LatestSpid(overview.Recorder);
        var session = await Sql("SELECT s.program_name, s.transaction_isolation_level, s.lock_timeout, s.deadlock_priority, s.host_process_id FROM sys.dm_exec_sessions AS s WHERE s.session_id = "
            + spid.ToString(CultureInfo.InvariantCulture) + ";");
        var row = session.Sets is [[{ } first, ..], ..] ? first : null;
        check(row is [{ } program, "1", "1000", "-5", { } pid] && program.EndsWith(" - Activity Monitor", StringComparison.Ordinal) && pid == Environment.ProcessId.ToString(CultureInfo.InvariantCulture),
            "the view's session runs under the program name plus \" - Activity Monitor\", READ UNCOMMITTED, LOCK_TIMEOUT 1000 and DEADLOCK_PRIORITY LOW: " + string.Join(", ", row ?? []));

        // Killing the view's own session: a CONNECTION_LOST value, then the view reconnects on its own with a new session.
        var before = overview.Recorder.Ticks.Count;
        string? killed = null;
        // The view may have replaced its session (a timeout reconnects) between reading it and the kill: read it again.
        for (var attempt = 0; attempt < 3 && killed != "1"; attempt++)
        {
            if (attempt > 0) await Task.Delay(500);
            killed = await KillOwnAsync(LatestSpid(overview.Recorder));
        }
        check(killed == "1", "the kill names the view's own session, proved in the same batch to be this process's Activity Monitor session (0: it was not, so nothing was killed)");
        var recovered = await overview.Recorder.WaitAsync(recorder =>
        {
            var after = recorder.Ticks.Skip(before).ToList();
            var lost = after.FindIndex(tick => tick.Errors?.Any(error => error.Code == "CONNECTION_LOST") == true);
            return lost >= 0 && after.Skip(lost + 1).Any(tick => tick.Samples.Count > 0);
        }, 20_000);
        var later = overview.Recorder.Ticks.Skip(before).ToList();
        var reopened = later.FirstOrDefault(tick => tick.Spid is not null)?.Spid;
        var firstAfter = later.SkipWhile(tick => tick.Errors?.Any(error => error.Code == "CONNECTION_LOST") != true).Skip(1).FirstOrDefault(tick => tick.Samples.Count > 0)?.Samples[0];
        // SQL Server often gives the new session the killed one's number, so the tick names it whatever it is.
        check(recovered && reopened is > 0 && firstAfter?.Gap == "baseline" && !overview.Task.IsCompleted,
            "a killed live session is a CONNECTION_LOST value; the view reconnects on its own (the new session id in the tick) and starts its rates again from a baseline: "
            + string.Join(" | ", later.Take(4).Select(tick => (tick.Errors?.FirstOrDefault()?.Code ?? "ok") + " spid " + tick.Spid)));
        var ended = await Stop(overview);
        check(ended.Ended == "cancelled" && ended.Ticks >= 4 && service.Live.Gates.Busy == 0, "a cancelled view ends cancelled and holds no live gate");

        await BudgetAsync(check, service, info.Id, Subscribe, Stop);
        await BlockedAsync(check, service, info.Id, json, Sql, Subscribe, Stop);
        await PermissionAsync(check, service, live, json, Sql, Subscribe);
    }

    private static Type Numeric(string dataType) => dataType.Split('(')[0] switch
    {
        "tinyint" => typeof(byte),
        "smallint" => typeof(short),
        "int" => typeof(int),
        "bigint" => typeof(long),
        "decimal" or "numeric" => typeof(decimal),
        "real" => typeof(float),
        "float" => typeof(double),
        _ => typeof(string)
    };

    /// <summary>A statement that runs past its budget without waiting on any lock (the test hook puts a WAITFOR first): the
    /// budget cancels it as a TIMEOUT value, the connection is dropped and reopened (a new session in the tick), and the view
    /// keeps ticking and holds no gate.</summary>
    private static async Task BudgetAsync(Action<bool, string> check, SqlService service, string connectionId,
        Func<string, int, (Task<LiveEnd> Task, LiveRecorder Recorder, string Id)> subscribe, Func<(Task<LiveEnd>, LiveRecorder, string), Task<LiveEnd>> stop)
    {
        var slow = true;
        service.Live.TestText = (_, text) => slow ? text.Replace(LiveSql.UncommittedPrologue, LiveSql.UncommittedPrologue + "WAITFOR DELAY '00:00:03';\n", StringComparison.Ordinal) : text;
        (Task<LiveEnd> Task, LiveRecorder Recorder, string Id)? view = null;
        try
        {
            // 1 s: a 0.8 s budget, well under the 3 s wait.
            view = subscribe(connectionId, 1000);
            var timedOut = await view.Value.Recorder.WaitAsync(recorder => recorder.Ticks.Count(tick => tick.Errors is not null) >= 2, 20_000);
            var errors = view.Value.Recorder.Ticks.SelectMany(tick => tick.Errors ?? []).ToList();
            check(timedOut && errors.Take(2).All(error => error is { Code: "TIMEOUT", Number: null, Terminal: false }) && errors[1].RetryInMs > errors[0].RetryInMs && view.Value.Recorder.Ticks.All(tick => tick.Samples.Count == 0),
                "a statement that runs past its budget without waiting on a lock is cancelled at the budget as a TIMEOUT value (no error number), and the probe backs off: "
                + string.Join(", ", errors.Take(2).Select(error => error.Code + " " + error.Number + " retry " + error.RetryInMs)));
            slow = false;
            var before = view.Value.Recorder.Ticks.Count;
            var recovered = await view.Value.Recorder.WaitAsync(recorder => recorder.Ticks.Skip(before).Any(tick => tick.Samples.Count > 0), 20_000);
            var after = view.Value.Recorder.Ticks.Skip(before).FirstOrDefault(tick => tick.Samples.Count > 0);
            check(recovered && after is { Spid: > 0, Samples: [{ Gap: "baseline" }] } && !view.Value.Task.IsCompleted,
                "after a timeout the view reconnects on its own (the dropped connection is never pooled: a new session in the tick) and samples again from a baseline");
        }
        finally
        {
            service.Live.TestText = null;
            if (view is { } running) await stop(running);
        }
        check(service.Live.Gates.Busy == 0, "a view stopped after timeouts holds no live gate");
    }

    /// <summary>An open transaction holding an X lock: the probe (made to read the locked table first, by the test hook)
    /// reports BLOCKED after LOCK_TIMEOUT under READ COMMITTED and keeps ticking; under READ UNCOMMITTED it reads through.</summary>
    private static async Task BlockedAsync(Action<bool, string> check, SqlService service, string connectionId, JsonSerializerOptions json, Func<string, string?, Task<SqlRun>> sql,
        Func<string, int, (Task<LiveEnd> Task, LiveRecorder Recorder, string Id)> subscribe, Func<(Task<LiveEnd>, LiveRecorder, string), Task<LiveEnd>> stop)
    {
        var holder = Guid.NewGuid().ToString();
        var table = "##VariaScratch_live_" + Guid.NewGuid().ToString("N");
        var locked = await sql("CREATE TABLE " + table + " (id int); INSERT " + table + " VALUES (1);\nBEGIN TRANSACTION; UPDATE " + table + " SET id = 2;", holder);
        var committed = true;
        service.Live.TestText = (_, text) => text.Replace(LiveSql.UncommittedPrologue, LiveSql.UncommittedPrologue
            + (committed ? "SET TRANSACTION ISOLATION LEVEL READ COMMITTED;\n" : "") + "DECLARE @varia_rows int = (SELECT COUNT(*) FROM " + table + ");\n", StringComparison.Ordinal);
        (Task<LiveEnd>, LiveRecorder Recorder, string Id)? view = null;
        try
        {
            var started = Environment.TickCount64;
            view = subscribe(connectionId, 2000);
            var blocked = await view.Value.Recorder.WaitAsync(recorder => recorder.Ticks.Count(tick => tick.Errors is not null) >= 2, 20_000);
            var waited = Environment.TickCount64 - started;
            var errors = view.Value.Recorder.Ticks.SelectMany(tick => tick.Errors ?? []).ToList();
            check(locked.Status == "completed" && blocked && errors.Take(2).All(error => error is { Code: "BLOCKED", Number: 1222, Terminal: false }) && errors[1].RetryInMs > errors[0].RetryInMs,
                "a probe that waits on another session's lock reports BLOCKED (1222, LOCK_TIMEOUT 1000 within its 1.6 s budget), keeps ticking and backs off (" + waited + " ms for two): "
                + string.Join(", ", errors.Take(2).Select(error => error.Code + " " + error.Number + " retry " + error.RetryInMs)));
            committed = false;
            var before = view.Value.Recorder.Ticks.Count;
            service.Live.Update(new LiveUpdateArgs(view.Value.Id, "activity", Refresh: true), json);
            var readThrough = await view.Value.Recorder.WaitAsync(recorder => recorder.Ticks.Skip(before).Any(tick => tick.Samples.Count > 0), 10_000);
            check(readThrough, "under READ UNCOMMITTED the same probe reads through the lock once its back-off ends (a refresh does not cut a back-off short)");
        }
        finally
        {
            service.Live.TestText = null;
            if (view is { } running) await stop(running);
            await sql("IF @@TRANCOUNT > 0 ROLLBACK;\nDROP TABLE IF EXISTS " + table + ";", holder);
            await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(holder), json), json);
        }
    }

    /// <summary>A login without VIEW SERVER STATE (scratch only): the overview opens unavailable and the view ends failed
    /// PERMISSION_DENIED as a value, running nothing.</summary>
    private static async Task PermissionAsync(Action<bool, string> check, SqlService service, Func<string, ConnectOptions> live, JsonSerializerOptions json,
        Func<string, string?, Task<SqlRun>> sql, Func<string, int, (Task<LiveEnd> Task, LiveRecorder Recorder, string Id)> subscribe)
    {
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Live data permission checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named login on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => sql(text, null));
        if (!await scratch.CreateLoginAsync())
        {
            Console.WriteLine("Live data permission checks skipped: this server accepts Windows logins only.");
            return;
        }
        var options = live("master") with { Authentication = "sql", Username = scratch.Login, Password = scratch.Password };
        var connected = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(options, json), json);
        try
        {
            var view = subscribe(connected.Id, 2000);
            var end = await view.Task.WaitAsync(TimeSpan.FromSeconds(20));
            check(end is { Ended: "failed", Code: "PERMISSION_DENIED", Ticks: 0 } && view.Recorder.Opened?.Probes is [{ State: "unavailable", Reason: "PERMISSION_DENIED" }],
                "a login without VIEW SERVER STATE opens the overview unavailable (PERMISSION_DENIED) and the view ends failed with that code, running nothing");
            view.Recorder.Dispose();
        }
        finally
        {
            await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(connected.Id), json), json);
            // The login is this run's own: its sessions, if a pool kept one, are ours to end before the login is dropped.
            await sql("DECLARE @kill nvarchar(max) = N'';\nSELECT @kill += N'KILL ' + CONVERT(nvarchar(11), s.session_id) + N';' FROM sys.dm_exec_sessions AS s WHERE s.login_name = N'"
                + scratch.Login!.Replace("'", "''") + "';\nEXEC (@kill);", null);
        }
    }
}
