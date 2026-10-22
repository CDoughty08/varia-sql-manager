using System.Data;
using System.Globalization;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Activity;
using Varia.Backend.Live;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live checks of the Activity Monitor's live source (VARIA_TEST_SQL_SERVER), through LiveService as main drives it:
/// the overview's series and the sessions probe's three tables, the capability statuses and Varia's own sessions; a real
/// blocking chain of application locks in Processes, Blocking and Active Expensive Queries, and the Blocked view chip applied
/// by an update; whether a session's CPU stays continuous when its requests end (the per-session rate's assumption, D-am
/// §6.1); and (VARIA_TEST_SQL_SCRATCH=1) a login without server state, which sees only its own session. Only this run's
/// sessions are asserted, so other runs' sessions do not matter; the only objects created are application locks, released in
/// finally, and the scratch login.</summary>
internal static class ActivitySourceLiveChecks
{
    private static uint next = 9500;
    private static readonly DateTime Login = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Unspecified);

    private sealed record View(Task<LiveEnd> Task, LiveRecorder Recorder, string Id);

    private static View Subscribe(SqlService service, string connectionId, JsonSerializerOptions json, object? args, params string[] probes)
    {
        var recorder = new LiveRecorder(Interlocked.Increment(ref next));
        var id = Guid.NewGuid().ToString();
        var task = service.Live.SubscribeAsync(new LiveSubscribeArgs(id, connectionId, "activity", [.. probes.Select(probe => new LiveProbeArgs(probe, 2000))],
            args is null ? null : JsonSerializer.SerializeToElement(args, json)), recorder.Context, json);
        return new(task, recorder, id);
    }

    private static async Task<LiveEnd> Stop(View view)
    {
        view.Recorder.Context.Cancel(CancelReason.User);
        var end = await view.Task.WaitAsync(TimeSpan.FromSeconds(10));
        view.Recorder.Dispose();
        return end;
    }

    private static List<LiveSample> SamplesOf(LiveRecorder recorder, string probe) => [.. recorder.Ticks.SelectMany(tick => tick.Samples).Where(sample => sample.Probe == probe)];

    /// <summary>A table's rows by column id (the live column ids of the probe's catalogue entry), read from the stored revision.</summary>
    private static List<Dictionary<string, string?>> Rows(SqlService service, LiveSnapshotSample table)
    {
        var columns = LiveCatalog.Current.Probes[ActivityReader.SessionsProbe].Tables[table.Table].Columns;
        return [.. LiveResultChecks.RowsOf(service.Live.Store, table.Descriptor).Select(row => columns.Select((column, at) => (column.Id, row[at])).ToDictionary(cell => cell.Id, cell => cell.Item2))];
    }

    /// <summary>Holds the stream (no acknowledgement, so no further tick), then reads the newest sample's tables, which stay
    /// readable until the stream goes on.</summary>
    private static async Task<LiveSample?> Freeze(View view, Func<LiveSample, bool> wanted, int timeoutMs = 20_000)
    {
        var found = await view.Recorder.WaitAsync(recorder => SamplesOf(recorder, ActivityReader.SessionsProbe).Any(wanted), timeoutMs);
        view.Recorder.Acknowledge = false;
        await Task.Delay(300);
        return found ? SamplesOf(view.Recorder, ActivityReader.SessionsProbe).LastOrDefault() : null;
    }

    private static void Resume(View view)
    {
        view.Recorder.Acknowledge = true;
        view.Recorder.Grant();
    }

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        var profile = ((IActionHost)service).Profile(info.Id);
        if (ActivitySql.BandOf(profile.Major, profile.EngineEdition, profile.CatalogBand) is null)
        {
            Console.WriteLine("Activity Monitor source live checks skipped: the server is not one the monitor serves yet.");
            return;
        }
        await SourceAsync(check, service, info, json);
        await BlockingAsync(check, service, info, json);
        await CpuAsync(check, service, info);
        await PermissionAsync(check, service, info, live, json);
    }

    private static async Task SourceAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var view = Subscribe(service, info.Id, json, new { filters = new[] { new { table = "sessions", showVaria = true } } }, ActivityReader.OverviewProbe, ActivityReader.SessionsProbe);
        try
        {
            var latest = await Freeze(view, _ => SamplesOf(view.Recorder, ActivityReader.SessionsProbe).Count >= 3);
            var opened = view.Recorder.Opened;
            var sessions = SamplesOf(view.Recorder, ActivityReader.SessionsProbe);
            var overview = SamplesOf(view.Recorder, ActivityReader.OverviewProbe);
            var errors = view.Recorder.Ticks.SelectMany(tick => tick.Errors ?? []).Select(error => error.Code + " " + error.Message).ToList();
            check(latest is not null && opened is { Probes: [{ State: "ok" }, { State: "ok" }], Spid: > 0 } && errors.Count == 0
                && sessions.All(sample => sample.Tables?.Select(table => table.Table).Order().SequenceEqual([0, 1, 2]) == true) && overview.Count >= 2 && overview.All(sample => sample.Metrics?.Length == 21),
                "the Activity Monitor source samples the overview's 21 series and the sessions probe's three tables (Processes, Blocking, Active Expensive Queries) on one connection: "
                + string.Join("; ", errors.Take(3)));
            check(sessions[0].Status is { Count: 2 } status && status[0] is { Id: "serverState", Value: 1 } && status[1] is { Id: "canKill", Value: 0 or 1 } && sessions.Skip(1).All(sample => sample.Status is null)
                && sessions[0].Tables![0].Facets?.Any(facet => facet.Column == "login" && facet.Values.Count > 0) == true,
                "the first sessions sample reports what the capability probe found (server state, Kill), and Processes sends its column facets");
            var rows = latest is null ? [] : Rows(service, latest.Tables!.Single(table => table.Table == 0));
            var monitor = rows.FirstOrDefault(row => row["sessionId"] == opened?.Spid?.ToString(CultureInfo.InvariantCulture));
            check(rows.Count >= 2 && monitor is { } own && own["varia"] == "Varia Activity Monitor" && own["application"]!.EndsWith(" - Activity Monitor", StringComparison.Ordinal) && own["login"] is { Length: > 0 },
                "Processes holds the server's sessions, the monitor's own marked as Varia's Activity Monitor when Varia's own sessions are shown");
            // The catalogue's defaults hide Varia's pools again, the monitor's own included.
            var before = sessions.Count;
            service.Live.Update(new LiveUpdateArgs(view.Id, "activity", Args: JsonSerializer.SerializeToElement(new { filters = new[] { new { table = "sessions" } } }, json)), json);
            Resume(view);
            var after = await Freeze(view, _ => SamplesOf(view.Recorder, ActivityReader.SessionsProbe).Count > before + 1);
            var hidden = after is null ? [] : Rows(service, after.Tables!.Single(table => table.Table == 0));
            check(after is not null && hidden.Count > 0 && hidden.All(row => row["varia"] is null or "Query tab") && hidden.All(row => row["sessionId"] != opened?.Spid?.ToString(CultureInfo.InvariantCulture)),
                "an update back to the default filter hides Varia's pool sessions, the monitor's own among them, from the next sample");
        }
        finally
        {
            var end = await Stop(view);
            check(end.Ended == "cancelled" && service.Live.Gates.Busy == 0, "the Activity Monitor view ends cancelled and holds no live gate");
        }
    }

    private static async Task<object?> Scalar(SqlConnection connection, string text)
    {
        await using var command = new SqlCommand(text, connection) { CommandTimeout = 30 };
        return await command.ExecuteScalarAsync();
    }

    private static async Task BlockingAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var host = (IActionHost)service;
        var marker = "VariaActivitySource_" + Guid.NewGuid().ToString("N");
        var connections = new List<SqlConnection>();
        var waiting = new List<(SqlCommand Command, Task Task)>();
        async Task<(SqlConnection Connection, int Spid)> Open()
        {
            var connection = host.Connection(info.Id);
            connections.Add(connection);
            await host.OpenAsync(connection, CancellationToken.None);
            return (connection, Convert.ToInt32(await Scalar(connection, "SELECT @@SPID;"), CultureInfo.InvariantCulture));
        }
        // These sessions run under Varia's Object Actions pool name, so the filter shows Varia's own sessions.
        var view = Subscribe(service, info.Id, json, new { filters = new[] { new { table = "sessions", showVaria = true } } }, ActivityReader.SessionsProbe);
        var holder = default((SqlConnection Connection, int Spid));
        try
        {
            holder = await Open();
            await Scalar(holder.Connection, $"BEGIN TRAN; DECLARE @r int; EXEC @r = sp_getapplock @Resource = N'{marker}', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0; -- {marker}");
            var waiters = new List<int>();
            for (var index = 0; index < 2; index++)
            {
                var waiter = await Open();
                waiters.Add(waiter.Spid);
                var command = new SqlCommand($"DECLARE @r int; EXEC @r = sp_getapplock @Resource = N'{marker}', @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 60000;", waiter.Connection) { CommandTimeout = 90 };
                waiting.Add((command, command.ExecuteNonQueryAsync()));
            }
            string Id(int spid) => spid.ToString(CultureInfo.InvariantCulture);
            bool Chained(LiveSample sample)
            {
                if (sample.Tables?.FirstOrDefault(table => table.Table == 1) is not { } chain) return false;
                var rows = Rows(service, chain);
                return waiters.All(spid => rows.Any(row => row["chainSessionId"] == Id(spid)));
            }
            var latest = await Freeze(view, sample => Chained(sample));
            var processes = latest is null ? [] : Rows(service, latest.Tables!.Single(table => table.Table == 0));
            var chainRows = latest is null ? [] : Rows(service, latest.Tables!.Single(table => table.Table == 1));
            var active = latest is null ? [] : Rows(service, latest.Tables!.Single(table => table.Table == 2));
            Dictionary<string, string?>? Process(int spid) => processes.FirstOrDefault(row => row["sessionId"] == Id(spid));
            // A lock queue reports a later waiter as blocked by the waiter ahead of it, so a waiter's blocker is the holder or another waiter.
            bool Ours(string? blocker, int waiter) => blocker != Id(waiter) && waiters.Append(holder.Spid).Any(spid => Id(spid) == blocker);
            check(Process(holder.Spid) is { } lead && lead["headBlocker"] == "1" && lead["blocking"] == "2" && lead["blockedBy"] is null && lead["status"]!.EndsWith(" · 1 open tran", StringComparison.Ordinal)
                && lead["openTransactions"] == "1" && waiters.All(spid => Process(spid) is { } row && Ours(row["blockedBy"], spid) && row["headBlocker"] == "0" && row["waitType"]!.StartsWith("LCK_M_", StringComparison.Ordinal)),
                "through the live source, Processes marks the idle lead blocker (Head Blocker, two downstream, its open transaction in its status) and each waiter's blocker and lock wait: "
                + string.Join(" | ", waiters.Prepend(holder.Spid).Select(spid => Process(spid) is { } row ? string.Join(",", new[] { "sessionId", "status", "headBlocker", "blocking", "blockedBy", "waitType", "openTransactions" }.Select(column => row[column])) : spid + " missing")));
            var leadRow = chainRows.FirstOrDefault(row => row["chainSessionId"] == Id(holder.Spid));
            check(leadRow is { } top && top["chainDepth"] == "0" && top["chainLastBatch"]!.Contains(marker, StringComparison.Ordinal) && top["chainSession"] == Id(holder.Spid)
                && waiters.All(spid => chainRows.Any(row => row["chainSessionId"] == Id(spid) && int.Parse(row["chainDepth"]!, CultureInfo.InvariantCulture) is var depth and >= 1
                    && row["chainSession"] == new string(' ', 2 * (depth - 1)) + "└─ " + Id(spid)))
                && waiters.All(spid => active.Any(row => row["activeSessionId"] == Id(spid) && Ours(row["activeBlockedBy"], spid))),
                "the Blocking table shows the chain under its lead blocker with its last batch, and Active Expensive Queries the waiting requests and their blocker");
            // The Blocked view chip, applied by an update, keeps only sessions that wait on another session.
            var count = SamplesOf(view.Recorder, ActivityReader.SessionsProbe).Count;
            service.Live.Update(new LiveUpdateArgs(view.Id, "activity", Args: JsonSerializer.SerializeToElement(new { filters = new[] { new { table = "sessions", view = "blocked", showVaria = true } } }, json)), json);
            Resume(view);
            var blocked = await Freeze(view, _ => SamplesOf(view.Recorder, ActivityReader.SessionsProbe).Count > count + 1);
            var shown = blocked is null ? [] : Rows(service, blocked.Tables!.Single(table => table.Table == 0));
            check(shown.Count > 0 && shown.All(row => int.TryParse(row["blockedBy"], CultureInfo.InvariantCulture, out var by) && by > 0) && waiters.All(spid => shown.Any(row => row["sessionId"] == Id(spid)))
                && shown.All(row => row["sessionId"] != Id(holder.Spid)),
                "the Blocked view chip, sent as args in an update, shows only the waiters from the next sample on");
        }
        finally
        {
            foreach (var (command, task) in waiting) if (!task.IsCompleted) command.Cancel();
            if (holder.Connection is { State: ConnectionState.Open }) await Scalar(holder.Connection, "IF @@TRANCOUNT > 0 ROLLBACK;");
            foreach (var (command, task) in waiting)
            {
                try { await task.WaitAsync(TimeSpan.FromSeconds(30)); } catch (Exception error) when (error is SqlException or TimeoutException or InvalidOperationException) { }
                await command.DisposeAsync();
            }
            foreach (var connection in connections) await connection.DisposeAsync();
            await Stop(view);
        }
    }

    /// <summary>D-am §6.1's assumption, which per-session CPU rates rest on: a session's cpu_time takes in its request's CPU when
    /// the request ends, so session plus request CPU never goes down. A marked session burns CPU in two batches while the
    /// sessions statement is read every 100 ms.</summary>
    private static async Task CpuAsync(Action<bool, string> check, SqlService service, ConnectionInfo info)
    {
        var host = (IActionHost)service;
        var profile = host.Profile(info.Id);
        var render = new ActivityRender(ActivitySql.BandOf(profile.Major, profile.EngineEdition, profile.CatalogBand)!.Value, ActivityCatalog.Current.EditionOf(profile.EngineEdition)!);
        var statement = ActivitySql.Statements(ActivityReader.SessionsProbe, render).Single(item => item.Id == "sessions");
        await using var monitor = host.Connection(info.Id);
        await using var busy = host.Connection(info.Id);
        await host.OpenAsync(monitor, CancellationToken.None);
        await host.OpenAsync(busy, CancellationToken.None);
        var spid = Convert.ToInt32(await Scalar(busy, "SELECT @@SPID;"), CultureInfo.InvariantCulture);
        var totals = new List<long>();
        var counters = new List<(long At, SessionCounters Counters)>();
        using var stop = new CancellationTokenSource();
        async Task Sample()
        {
            while (!stop.IsCancellationRequested)
            {
                await using var command = new SqlCommand(statement.Batch, monitor) { CommandTimeout = 30 };
                command.Parameters.Add(new SqlParameter("@rowCap", SqlDbType.Int) { Value = 10_001 });
                await using (var reader = await command.ExecuteReaderAsync())
                {
                    while (await reader.ReadAsync())
                        if (Convert.ToInt32(reader["session_id"], CultureInfo.InvariantCulture) == spid)
                            {
                            double? Optional(string column) => reader[column] is DBNull ? null : Convert.ToDouble(reader[column], CultureInfo.InvariantCulture);
                            var session = Convert.ToDouble(reader["cpu_time"], CultureInfo.InvariantCulture);
                            totals.Add((long)(session + (Optional("request_cpu_ms") ?? 0)));
                            (int?, DateTime?)? request = reader["request_id"] is DBNull ? null : (Convert.ToInt32(reader["request_id"], CultureInfo.InvariantCulture), (DateTime)reader["start_time"]);
                            counters.Add((Environment.TickCount64, new(session, Optional("request_cpu_ms"), Convert.ToDouble(reader["logical_reads"], CultureInfo.InvariantCulture), Optional("request_logical_reads"), request)));
                        }
                }
                try { await Task.Delay(100, stop.Token); } catch (OperationCanceledException) { }
            }
        }
        var sampling = Sample();
        const string Burn = "DECLARE @i bigint = 0, @end datetime2 = DATEADD(millisecond, 1200, SYSDATETIME()); WHILE SYSDATETIME() < @end SET @i += 1;";
        await Scalar(busy, Burn);
        await Scalar(busy, Burn);
        await Task.Delay(400);
        stop.Cancel();
        await sampling;
        // D-am §6.1 assumed session plus request CPU never falls; SQL Server takes a request's CPU into the session on a smaller
        // scale when it ends, so it does. Reported, not asserted: the rule below is what the rates rest on.
        var drops = totals.Zip(totals.Skip(1)).Count(pair => pair.Second < pair.First);
        Console.WriteLine($"Activity Monitor: session plus request CPU fell {drops} times in {totals.Count} samples across two batches ({string.Join(",", totals)}).");
        var rates = new SessionRates(10);
        var measured = counters.Select((sample, at) => rates.Apply(spid, Login, sample.Counters, at == 0 ? null : sample.At - counters[at - 1].At)[0]).Skip(1).ToList();
        var busyRates = counters.Skip(1).Zip(measured).Where(pair => pair.First.Counters.Request is not null && counters.Count > 0).Select(pair => pair.Second).ToList();
        check(counters.Count >= 10 && measured.All(rate => rate is >= 0) && busyRates.Count >= 4 && busyRates.Count(rate => rate >= 400) >= busyRates.Count / 2,
            $"a busy session's CPU rate is never negative or blank across its batches, and reads near a full CPU while a loop runs ({string.Join(",", measured.Select(rate => rate is { } value ? Math.Round(value).ToString(CultureInfo.InvariantCulture) : "-"))})");
    }

    /// <summary>A login without server state (scratch only): the overview opens unavailable, while the sessions probe runs and
    /// shows the monitor's own session, the only one SQL Server shows such a login, and reports Blocking and Active Expensive
    /// Queries as PERMISSION_DENIED values without failing the view.</summary>
    private static async Task PermissionAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Activity Monitor permission checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named login on a disposable development server.");
            return;
        }
        async Task<SqlRun> Sql(string text)
        {
            var id = Guid.NewGuid().ToString();
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(info.Id, id, "master", text, Guid.NewGuid().ToString(), 1000, 60, StopOnError: true), json), json);
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(id), json), json); }
        }
        await using var scratch = ScratchDatabase.Bare((text, _) => Sql(text));
        if (!await scratch.CreateLoginAsync())
        {
            Console.WriteLine("Activity Monitor permission checks skipped: this server accepts Windows logins only.");
            return;
        }
        var options = live("master") with { Authentication = "sql", Username = scratch.Login, Password = scratch.Password };
        var connected = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(options, json), json);
        try
        {
            var view = Subscribe(service, connected.Id, json, null, ActivityReader.OverviewProbe, ActivityReader.SessionsProbe);
            try
            {
                var latest = await Freeze(view, _ => SamplesOf(view.Recorder, ActivityReader.SessionsProbe).Count >= 2);
                var opened = view.Recorder.Opened;
                var first = SamplesOf(view.Recorder, ActivityReader.SessionsProbe).FirstOrDefault();
                var rows = latest?.Tables?.FirstOrDefault(table => table.Table == 0) is { } table ? Rows(service, table) : [];
                var denied = view.Recorder.Ticks.SelectMany(tick => tick.Errors ?? []).Where(error => error.Probe == ActivityReader.SessionsProbe).ToList();
                check(opened is { Probes: [{ State: "unavailable", Reason: "PERMISSION_DENIED" }, { State: "ok" }] } && !view.Task.IsCompleted
                    && first is { Status: [{ Id: "serverState", Value: 0 }, { Id: "canKill", Value: 0 }] } && latest?.Tables?.Select(entry => entry.Table).SequenceEqual([0]) == true
                    && rows.Count == 1 && rows[0]["sessionId"] == opened.Spid?.ToString(CultureInfo.InvariantCulture) && rows[0]["login"] == scratch.Login
                    && denied.Count > 0 && denied.All(error => error is { Code: "PERMISSION_DENIED", Terminal: false, Tables: [1, 2] }),
                    "a login without server state opens the overview unavailable, while the sessions probe runs: Processes shows the monitor's own session (the only one SQL Server shows it, not hidden as Varia's), the status says so, and Blocking and Active Expensive Queries are PERMISSION_DENIED values beside the sample: "
                    + string.Join(", ", rows.Select(row => row["sessionId"] + " " + row["varia"])) + " | " + string.Join(", ", denied.Take(2).Select(error => error.Code + " " + string.Join("/", error.Tables ?? []))));
            }
            finally { await Stop(view); }
        }
        finally
        {
            await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(connected.Id), json), json);
            // The login is this run's own: its sessions, if a pool kept one, are ours to end before the login is dropped.
            await Sql("DECLARE @kill nvarchar(max) = N'';\nSELECT @kill += N'KILL ' + CONVERT(nvarchar(11), s.session_id) + N';' FROM sys.dm_exec_sessions AS s WHERE s.login_name = N'"
                + scratch.Login!.Replace("'", "''") + "';\nEXEC (@kill);");
        }
    }
}
