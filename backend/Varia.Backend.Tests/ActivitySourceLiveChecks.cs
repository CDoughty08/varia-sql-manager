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
/// the overview's series and the sessions probe's three tables, the capability statuses and Varia's own sessions (an Object
/// Explorer pool, an SSIS pool opened through SqlService.Open, a query tab, an Object Actions session that ends); a real
/// blocking chain of application locks in Processes, Blocking and Active Expensive Queries, and the Blocked view chip applied
/// by an update; whether a session's CPU stays continuous when its requests end (the per-session rate's assumption, D-am
/// §6.1); and (VARIA_TEST_SQL_SCRATCH=1) a login without server state, which sees only its own session, and whose overview
/// stops without a sample when the monitor opened paused. Only this run's
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
        await StatementErrorsAsync(check, service, info, json);
        await ReconnectAsync(check, service, info, json);
        await BlockingAsync(check, service, info, json);
        await CpuAsync(check, service, info);
        await PermissionAsync(check, service, info, live, json);
    }

    /// <summary>Runs a script in a query tab session (a new one, closed after, unless <paramref name="session"/> names one).</summary>
    private static async Task<SqlRun> Sql(SqlService service, ConnectionInfo info, JsonSerializerOptions json, string text, string? session = null)
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

    private static async Task CloseSession(SqlService service, JsonSerializerOptions json, string session) =>
        await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(session), json), json);

    private static async Task SourceAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        // An Object Explorer pool session and a query tab of this backend, held while the view samples: SQL Server shows them
        // with this process's id, this machine's name and the program names Varia gave them.
        var explorer = (Varia.Backend.Explorer.IExplorerHost)service;
        await using var pool = explorer.Connection(info.Id, null);
        await explorer.OpenAsync(pool, CancellationToken.None);
        var poolSpid = pool.ServerProcessId.ToString(CultureInfo.InvariantCulture);
        // A pool another host opens through the shared opener, as the SSIS hosts do (their OpenAsync is SqlService.Open
        // itself): its session is recorded like every pool's, so Processes marks it Varia's.
        var host = (ILiveHost)service;
        await using var ssis = host.PoolConnection(info.Id, null, " - Integration Services");
        await service.Open(ssis, CancellationToken.None);
        var ssisSpid = ssis.ServerProcessId.ToString(CultureInfo.InvariantCulture);
        // An Object Actions connection is unpooled: its session ends as it closes, and SQL Server may give its id to anyone.
        var actions = (IActionHost)service;
        int actionSpid;
        bool whileOpen;
        await using (var action = actions.Connection(info.Id))
        {
            await actions.OpenAsync(action, CancellationToken.None);
            actionSpid = action.ServerProcessId;
            whileOpen = host.OwnSessions(info.Id).Contains(actionSpid);
        }
        check(whileOpen && !host.OwnSessions(info.Id).Contains(actionSpid) && host.OwnSessions(info.Id).Contains(ssis.ServerProcessId),
            "an Object Actions session counts as Varia's own while its connection is open and no longer once it closes, and an SSIS pool opened through SqlService.Open counts");
        var tab = Guid.NewGuid().ToString();
        var tabSpid = (await Sql(service, info, json, "SELECT @@SPID;", tab)).Scalar;
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
            string? Varia(List<Dictionary<string, string?>> table, string? spid) => table.FirstOrDefault(row => row["sessionId"] == spid) is { } row ? row["varia"] ?? "(none)" : null;
            check(Varia(rows, poolSpid) == "Varia Object Explorer" && Varia(rows, tabSpid) == "Query tab" && Varia(rows, ssisSpid) == "Varia Integration Services",
                "Processes labels this backend's Object Explorer and Integration Services pool sessions and its query tab as SQL Server shows them (process id, machine, program name), the pools also by the session id they were given: "
                + Varia(rows, poolSpid) + ", " + Varia(rows, tabSpid) + ", " + Varia(rows, ssisSpid));
            // The catalogue's defaults hide Varia's pools again, the monitor's own included, and keep its query tabs.
            var before = sessions.Count;
            service.Live.Update(new LiveUpdateArgs(view.Id, "activity", Args: JsonSerializer.SerializeToElement(new { filters = new[] { new { table = "sessions" } } }, json)), json);
            Resume(view);
            var after = await Freeze(view, _ => SamplesOf(view.Recorder, ActivityReader.SessionsProbe).Count > before + 1);
            var hidden = after is null ? [] : Rows(service, after.Tables!.Single(table => table.Table == 0));
            check(after is not null && hidden.Count > 0 && hidden.All(row => row["varia"] is null or "Query tab") && hidden.All(row => row["sessionId"] != opened?.Spid?.ToString(CultureInfo.InvariantCulture))
                && Varia(hidden, poolSpid) is null && Varia(hidden, ssisSpid) is null && Varia(hidden, tabSpid) == "Query tab",
                "an update back to the default filter hides Varia's pool sessions (the Object Explorer and Integration Services pools' and the monitor's own) from the next sample, and keeps its query tab");
        }
        finally
        {
            var end = await Stop(view);
            check(end.Ended == "cancelled" && service.Live.Gates.Busy == 0, "the Activity Monitor view ends cancelled and holds no live gate");
            await CloseSession(service, json, tab);
        }
    }

    /// <summary>D-am amendment 5: a statement fails alone. One the server lacks (a view it does not have, 208) is reported beside
    /// every sample and never run again; a lock wait stops the statements after it, and what was read arrives. The test hook
    /// rewrites one statement's text; nothing else changes.</summary>
    private static async Task StatementErrorsAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        string Tables(LiveSample sample) => string.Join(",", (sample.Tables ?? []).Select(table => table.Table).Order());
        string Errors(LiveTickEvent tick) => string.Join(";", (tick.Errors ?? []).Select(error => error.Code + " " + error.Number + " [" + string.Join(",", error.Tables ?? []) + "]"));
        var edgesRuns = 0;
        service.Live.TestText = (_, text) =>
        {
            if (!text.Contains("SELECT TOP (@edgeCap)", StringComparison.Ordinal)) return text;
            Interlocked.Increment(ref edgesRuns);
            return text.Replace("FROM sys.dm_os_waiting_tasks AS w\n", "FROM sys.dm_os_waiting_tasks_x AS w\n", StringComparison.Ordinal);
        };
        var view = Subscribe(service, info.Id, json, null, ActivityReader.SessionsProbe);
        try
        {
            var sampled = await view.Recorder.WaitAsync(recorder => SamplesOf(recorder, ActivityReader.SessionsProbe).Count >= 3, 30_000);
            var ticks = view.Recorder.Ticks.Where(tick => tick.Samples.Count > 0).ToList();
            check(sampled && ticks.All(tick => tick.Errors?.Any(error => error is { Code: "NOT_SUPPORTED", Number: 208, Tables: [0, 1] }) == true)
                && SamplesOf(view.Recorder, ActivityReader.SessionsProbe).All(sample => Tables(sample) == "0,2") && Volatile.Read(ref edgesRuns) == 1,
                "a statement the server cannot run (a missing view) fails alone: every sample still carries Processes and Active Expensive Queries, an error beside each names the tables it feeds, and it ran once ("
                + Volatile.Read(ref edgesRuns) + " runs; " + string.Join(" | ", ticks.Take(3).Select(tick => string.Join("/", tick.Samples.Select(Tables)) + " " + Errors(tick))) + ")");
        }
        finally
        {
            service.Live.TestText = null;
            await Stop(view);
        }

        // An open transaction holding an X lock on a global temporary table that Active Expensive Queries' statement is made to read first.
        var holder = Guid.NewGuid().ToString();
        var table = "##VariaScratch_live_" + Guid.NewGuid().ToString("N");
        var locked = await Sql(service, info, json, "CREATE TABLE " + table + " (id int); INSERT " + table + " VALUES (1);\nBEGIN TRANSACTION; UPDATE " + table + " SET id = 2;", holder);
        service.Live.TestText = (_, text) => text.Replace("SELECT TOP (@take)", "SET TRANSACTION ISOLATION LEVEL READ COMMITTED;\nDECLARE @varia_rows int = (SELECT COUNT(*) FROM " + table + ");\nSELECT TOP (@take)",
            StringComparison.Ordinal);
        view = Subscribe(service, info.Id, json, null, ActivityReader.SessionsProbe);
        try
        {
            var sampled = await view.Recorder.WaitAsync(recorder => SamplesOf(recorder, ActivityReader.SessionsProbe).Count >= 2, 30_000);
            var ticks = view.Recorder.Ticks.Where(tick => tick.Samples.Count > 0).ToList();
            check(locked.Status == "completed" && sampled && ticks.All(tick => tick.Errors?.Any(error => error is { Code: "BLOCKED", Number: 1222, Tables: [2] }) == true)
                && SamplesOf(view.Recorder, ActivityReader.SessionsProbe).All(sample => Tables(sample) == "0,1"),
                "a lock wait in the last statement stops only it: each sample keeps Processes and Blocking, and a BLOCKED value beside it names Active Expensive Queries ("
                + string.Join(" | ", ticks.Take(3).Select(tick => string.Join("/", tick.Samples.Select(Tables)) + " " + Errors(tick))) + ")");
        }
        finally
        {
            service.Live.TestText = null;
            await Stop(view);
            await Sql(service, info, json, "IF @@TRANCOUNT > 0 ROLLBACK;\nDROP TABLE IF EXISTS " + table + ";", holder);
            await CloseSession(service, json, holder);
        }
    }

    /// <summary>The statuses (server state, Kill) come with the first sample on each new connection: the view's own session is
    /// killed (this test's own view's, proved in the same batch), and the first sample on the session it reopens reports them again.</summary>
    private static async Task ReconnectAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var view = Subscribe(service, info.Id, json, null, ActivityReader.SessionsProbe);
        try
        {
            await view.Recorder.WaitAsync(recorder => SamplesOf(recorder, ActivityReader.SessionsProbe).Count >= 2, 20_000);
            int Latest() => view.Recorder.Ticks.LastOrDefault(tick => tick.Spid is not null)?.Spid ?? view.Recorder.Opened?.Spid ?? 0;
            var before = view.Recorder.Ticks.Count;
            string? killed = null;
            for (var attempt = 0; attempt < 3 && killed != "1"; attempt++)
            {
                if (attempt > 0) await Task.Delay(500);
                killed = (await Sql(service, info, json, "DECLARE @spid int = " + Latest().ToString(CultureInfo.InvariantCulture) + ", @pid int = " + Environment.ProcessId.ToString(CultureInfo.InvariantCulture) + ";\n"
                    + "IF EXISTS (SELECT 1 FROM sys.dm_exec_sessions AS s WHERE s.session_id = @spid AND s.session_id <> @@SPID AND s.host_process_id = @pid AND s.program_name LIKE N'% - Activity Monitor')\n"
                    + "BEGIN\n    DECLARE @kill nvarchar(40) = N'KILL ' + CONVERT(nvarchar(11), @spid) + N';';\n    EXEC (@kill);\n    SELECT 1 AS killed;\nEND\nELSE SELECT 0 AS killed;")).Scalar;
            }
            List<LiveSample> Reopened(LiveRecorder recorder) =>
                [.. recorder.Ticks.Skip(before).SkipWhile(tick => tick.Spid is null).SelectMany(tick => tick.Samples).Where(sample => sample.Probe == ActivityReader.SessionsProbe)];
            var recovered = await view.Recorder.WaitAsync(recorder => Reopened(recorder).Count >= 2, 20_000);
            var first = SamplesOf(view.Recorder, ActivityReader.SessionsProbe);
            var again = Reopened(view.Recorder);
            check(killed == "1" && recovered && first[0].Status is { Count: 2 } && first[1].Status is null && again[0].Status is [{ Id: "serverState", Value: 1 }, { Id: "canKill" }] && again[1].Status is null,
                "after the view's session is lost, the first sample on the session it reopens reports server state and Kill again, and the next does not ("
                + killed + ", " + string.Join(",", again.Take(2).Select(sample => sample.Status?.Count ?? 0)) + ")");
        }
        finally { await Stop(view); }
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
        // Each request's CPU over its own elapsed time, as the server measured both: what the loop got of a scheduler on this
        // run, which the rates are held to rather than a fixed bound (the server is shared and loaded).
        var loop = new Dictionary<DateTime, double>();
        using var stop = new CancellationTokenSource();
        async Task Sample()
        {
            while (!stop.IsCancellationRequested)
            {
                await using var command = new SqlCommand(statement.Batch, monitor) { CommandTimeout = 30 };
                command.Parameters.Add(new SqlParameter("@rowCap", SqlDbType.Int) { Value = 10_001 });
                double? session = null, reads = null;
                var requests = new List<RequestCounters>();
                await using (var reader = await command.ExecuteReaderAsync())
                {
                    while (await reader.ReadAsync())
                        if (Convert.ToInt32(reader["session_id"], CultureInfo.InvariantCulture) == spid)
                        {
                            double Number(string column) => Convert.ToDouble(reader[column], CultureInfo.InvariantCulture);
                            (session, reads) = (Number("cpu_time"), Number("logical_reads"));
                            if (reader["request_id"] is DBNull) continue;
                            var start = (DateTime)reader["start_time"];
                            requests.Add(new(Convert.ToInt32(reader["request_id"], CultureInfo.InvariantCulture), start, Number("request_cpu_time"), Number("request_logical_reads")));
                            if (Number("total_elapsed_time") is var elapsed and >= 500) loop[start] = Number("request_cpu_time") * 1000 / elapsed;
                        }
                }
                if (session is { } cpu)
                {
                    totals.Add((long)(cpu + requests.Sum(request => request.Cpu)));
                    counters.Add((Environment.TickCount64, new(cpu, reads ?? 0, requests)));
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
        // Every sample is applied in order (the first only sets the baseline), then the first's empty rate is left out.
        var measured = counters.Select(sample => rates.Apply(spid, Login, sample.Counters, sample.At)[0]).ToList().Skip(1).ToList();
        var busyRates = counters.Skip(1).Zip(measured).Where(pair => pair.First.Counters.Requests.Count > 0).Select(pair => pair.Second).ToList();
        var reference = loop.Count > 0 ? loop.Values.Max() : 0;
        check(counters.Count >= 10 && measured.All(rate => rate is >= 0) && busyRates.Count >= 4 && reference > 0 && busyRates.Count(rate => rate >= reference / 2) >= busyRates.Count / 2,
            $"a busy session's CPU rate is never negative or blank across its batches, and reads at least half of what the loop got of a scheduler ({Math.Round(reference)} ms/s) while it runs ("
            + string.Join(",", measured.Select(rate => rate is { } value ? Math.Round(value).ToString(CultureInfo.InvariantCulture) : "-")) + ")");
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

            // Subscribed hidden (every probe paused, as a monitor restored in the background), the source opens without the
            // capability probe, so the overview opens "ok"; once resumed it learns the login lacks server state and stops,
            // reading nothing, rather than sample the one statement such a login may run (whose sums are NULL).
            var recorder = new LiveRecorder(Interlocked.Increment(ref next));
            var hiddenId = Guid.NewGuid().ToString();
            var hidden = new View(service.Live.SubscribeAsync(new LiveSubscribeArgs(hiddenId, connected.Id, "activity",
                [new LiveProbeArgs(ActivityReader.OverviewProbe, 2000, Paused: true), new LiveProbeArgs(ActivityReader.SessionsProbe, 2000, Paused: true)]), recorder.Context, json), recorder, hiddenId);
            try
            {
                var paused = await recorder.WaitAsync(item => item.Opened is not null);
                var opened = recorder.Opened;
                service.Live.Update(new LiveUpdateArgs(hiddenId, "activity", Probes: [new LiveProbeArgs(ActivityReader.OverviewProbe, Paused: false), new LiveProbeArgs(ActivityReader.SessionsProbe, Paused: false)]), json);
                LiveProbeError? Stopped(LiveRecorder item) => item.Ticks.SelectMany(tick => tick.Errors ?? []).FirstOrDefault(error => error.Probe == ActivityReader.OverviewProbe && error.Terminal);
                var stopped = await recorder.WaitAsync(item => Stopped(item) is not null && SamplesOf(item, ActivityReader.SessionsProbe).Count >= 2, 20_000);
                var overviewErrors = recorder.Ticks.SelectMany(tick => tick.Errors ?? []).Where(error => error.Probe == ActivityReader.OverviewProbe).ToList();
                check(paused && opened is { Probes: [{ State: "ok" }, { State: "ok" }] } && stopped && SamplesOf(recorder, ActivityReader.OverviewProbe).Count == 0
                    && overviewErrors is [{ Code: "PERMISSION_DENIED", Terminal: true, Tables: null, Series: null }] && !hidden.Task.IsCompleted,
                    "a login without server state whose monitor opened paused gets no overview sample once it resumes: the overview stops with one PERMISSION_DENIED, while the sessions probe samples: "
                    + SamplesOf(recorder, ActivityReader.OverviewProbe).Count + " overview samples, " + string.Join(", ", overviewErrors.Select(error => error.Code + " " + error.Terminal + " " + string.Join("/", error.Series ?? []))));
            }
            finally { await Stop(hidden); }
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
