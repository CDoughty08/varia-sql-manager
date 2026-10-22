using System.Globalization;
using System.Text.Json;
using Varia.Backend.Live;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live SQL checks of the Activity Monitor source (VARIA_TEST_SQL_SERVER): activity.overview's rates and clock,
/// its pool and prologue as the server sees them, recovery after its session is killed, a lock wait reported as BLOCKED
/// while the view keeps ticking, and (VARIA_TEST_SQL_SCRATCH=1) a login without server state refused as a value. Only the
/// sessions these checks open are killed, and the only objects created are one global temporary table, dropped in finally,
/// and the scratch login.</summary>
internal static class LiveDataChecks
{
    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        async Task<SqlRun> Sql(string text, string? session = null)
        {
            var id = session ?? Guid.NewGuid().ToString();
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(info.Id, id, "master", text, Guid.NewGuid().ToString(), 1000, 60, StopOnError: true), json), json);
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { if (session is null) await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(id), json), json); }
        }
        uint next = 9000;
        (Task<LiveEnd> Task, LiveRecorder Recorder, string Id) Subscribe(string connectionId, int intervalMs)
        {
            var recorder = new LiveRecorder(++next);
            var id = Guid.NewGuid().ToString();
            var task = service.Live.SubscribeAsync(new LiveSubscribeArgs(id, connectionId, "activity", [new LiveProbeArgs(LiveSql.OverviewProbe, intervalMs)]), recorder.Context, json);
            return (task, recorder, id);
        }
        static List<LiveSample> Samples(LiveRecorder recorder) => [.. recorder.Ticks.SelectMany(tick => tick.Samples)];
        static async Task<LiveEnd> Stop((Task<LiveEnd> Task, LiveRecorder Recorder, string Id) view)
        {
            view.Recorder.Context.Cancel(CancelReason.User);
            var end = await view.Task.WaitAsync(TimeSpan.FromSeconds(10));
            view.Recorder.Dispose();
            return end;
        }

        // Rates on the server's clock: a baseline with gauges only, then every series, within a second (the quick second sample).
        var overview = Subscribe(info.Id, 1000);
        var sampled = await overview.Recorder.WaitAsync(recorder => Samples(recorder).Count >= 3, 20_000);
        var opened = overview.Recorder.Opened;
        var ticks = overview.Recorder.Ticks.Where(tick => tick.Samples.Count > 0).Take(3).ToList();
        var samples = ticks.Select(tick => tick.Samples[0]).ToList();
        check(sampled && opened is { Source: "activity", Band: >= LiveSql.MinBand and <= LiveSql.MaxBand, Spid: > 0, Isolation: "readUncommitted", Probes: [{ State: "ok" }] }
            && samples[0] is { Gap: "baseline", Metrics: [null, >= 0, null, null, null, >= 1] }
            && samples.Skip(1).All(sample => sample.Metrics is { Length: 6 } metrics && metrics.All(value => value is { } v && double.IsFinite(v) && v >= 0) && metrics[0] <= 100 && sample.EffectiveIntervalMs == 1000),
            "activity.overview opens on the server's band and its own session, reading uncommitted; its baseline carries gauges only, and the next samples every series (CPU 0 to 100 %): "
            + string.Join(" | ", samples.Select(sample => sample.Gap + " " + string.Join(",", sample.Metrics ?? []))));
        if (ticks.Count == 3)
        {
            var wall = ticks[2].SampledAt - ticks[1].SampledAt;
            var server = samples[2].ElapsedMs ?? -1;
            check(Math.Abs(server - wall) <= Math.Max(250, wall / 5) && ticks[1].SampledAt - ticks[0].SampledAt < 1500,
                "a sample's elapsed time is the server's own (ms_ticks), within 20 % of the backend's clock, and the second sample comes within about a second: " + server + " vs " + wall + " ms");
        }

        // The pool and prologue, as SQL Server sees the view's session.
        var spid = opened?.Spid ?? 0;
        var session = await Sql("SELECT s.program_name, s.transaction_isolation_level, s.lock_timeout, s.deadlock_priority FROM sys.dm_exec_sessions AS s WHERE s.session_id = "
            + spid.ToString(CultureInfo.InvariantCulture) + ";");
        var row = session.Sets is [[{ } first, ..], ..] ? first : null;
        check(row is [{ } program, "1", "1000", "-5"] && program.EndsWith(" - Activity Monitor", StringComparison.Ordinal),
            "the view's session runs under the program name plus \" - Activity Monitor\", READ UNCOMMITTED, LOCK_TIMEOUT 1000 and DEADLOCK_PRIORITY LOW: " + string.Join(", ", row ?? []));

        // Killing the view's own session: a CONNECTION_LOST value, then the view reconnects on its own with a new session.
        var before = overview.Recorder.Ticks.Count;
        var killed = await Sql("KILL " + spid.ToString(CultureInfo.InvariantCulture) + ";");
        var recovered = await overview.Recorder.WaitAsync(recorder =>
        {
            var after = recorder.Ticks.Skip(before).ToList();
            var lost = after.FindIndex(tick => tick.Errors?.Any(error => error.Code == "CONNECTION_LOST") == true);
            return lost >= 0 && after.Skip(lost + 1).Any(tick => tick.Samples.Count > 0);
        }, 20_000);
        var later = overview.Recorder.Ticks.Skip(before).ToList();
        var reopened = later.FirstOrDefault(tick => tick.Spid is not null)?.Spid;
        var firstAfter = later.SkipWhile(tick => tick.Errors is null).Skip(1).FirstOrDefault(tick => tick.Samples.Count > 0)?.Samples[0];
        // SQL Server often gives the new session the killed one's number, so the tick names it whatever it is.
        check(killed.Status == "completed" && recovered && reopened is > 0 && firstAfter?.Gap == "baseline" && !overview.Task.IsCompleted,
            "a killed live session is a CONNECTION_LOST value; the view reconnects on its own (the new session id in the tick) and starts its rates again from a baseline: "
            + string.Join(" | ", later.Take(4).Select(tick => (tick.Errors?.FirstOrDefault()?.Code ?? "ok") + " spid " + tick.Spid)));
        var ended = await Stop(overview);
        check(ended.Ended == "cancelled" && ended.Ticks >= 4 && service.Live.Gates.Busy == 0, "a cancelled view ends cancelled and holds no live gate");

        await BlockedAsync(check, service, info.Id, json, Sql, Subscribe, Stop);
        await PermissionAsync(check, service, live, json, Sql, Subscribe);
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
            check(readThrough, "under READ UNCOMMITTED the same probe reads through the lock, and a refresh runs it at once");
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
