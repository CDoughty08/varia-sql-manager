using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Activity;

namespace Varia.Backend.Tests;

/// <summary>Live Activity Monitor checks, without scratch objects: every statement of every probe runs at the server's band
/// (with the spills variant the server has) and returns the columns it declares, the counters statement finds every
/// counter, and a real blocking chain of application locks (only this run's sessions are asserted, so other runs' sessions
/// do not matter) builds the graph SSMS gets wrong: one row per session and an idle lead blocker with its open transaction.</summary>
internal static class ActivityLiveChecks
{
    private sealed record Rows(List<string> Names, List<object?[]> Values)
    {
        public object? Get(object?[] row, string column) => row[Names.IndexOf(column)] is var value && value is DBNull ? null : value;
    }

    private static async Task<Rows> Read(SqlConnection connection, ActivityStatement statement, Func<ActivityParameter, object?> value)
    {
        await using var command = new SqlCommand(statement.Batch, connection) { CommandTimeout = 30 };
        foreach (var parameter in statement.Parameters)
        {
            var sql = new SqlParameter(parameter.Name, parameter.Type) { Value = value(parameter) ?? DBNull.Value };
            if (parameter.Size > 0) sql.Size = parameter.Size;
            command.Parameters.Add(sql);
        }
        await using var reader = await command.ExecuteReaderAsync();
        var names = Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToList();
        var rows = new List<object?[]>();
        while (await reader.ReadAsync())
        {
            var row = new object?[reader.FieldCount];
            reader.GetValues(row!);
            rows.Add(row);
        }
        return new(names, rows);
    }

    private static async Task<object?> Scalar(SqlConnection connection, string text)
    {
        await using var command = new SqlCommand(text, connection) { CommandTimeout = 30 };
        return await command.ExecuteScalarAsync();
    }

    private static object? Value(ActivityParameter parameter, DateTime since, object?[]? statement) => parameter.Name switch
    {
        "@rowCap" => 10_001,
        "@edgeCap" => 20_001,
        "@take" => 101,
        "@since" => since,
        // Statement texts: slot 0 asks for a statement the stats just returned, the others pass NULL handles.
        "@h0" => statement?[0],
        "@p0" => statement?[1],
        "@s0" => statement?[2],
        "@e0" => statement?[3],
        _ => null
    };

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info)
    {
        var host = (IActionHost)service;
        var profile = host.Profile(info.Id);
        var band = ActivitySql.BandOf(profile.Major, profile.EngineEdition, profile.CatalogBand);
        var edition = ActivityCatalog.Current.EditionOf(profile.EngineEdition);
        if (band is null || edition is null)
        {
            Console.WriteLine("Activity Monitor live checks skipped: the server is not one the monitor serves yet.");
            return;
        }
        await using var monitor = host.Connection(info.Id);
        await host.OpenAsync(monitor, CancellationToken.None);
        var spills = Convert.ToInt32(await Scalar(monitor, "SELECT CASE WHEN COL_LENGTH('sys.dm_exec_query_stats', 'total_spills') IS NULL THEN 0 ELSE 1 END;")) == 1;
        var render = new ActivityRender(band.Value, edition, spills);
        var clock = await Read(monitor, ActivitySql.Statements("activity.overview", render)[0], _ => null);
        var since = ((DateTime)clock.Get(clock.Values[0], "server_local_time")!).AddMinutes(-15);

        var mismatched = new List<string>();
        var read = new Dictionary<string, Rows>();
        foreach (var probe in ActivityCatalog.Current.Probes.Keys)
        {
            object?[]? statement = null;
            foreach (var sql in ActivitySql.Statements(probe, render))
            {
                var rows = await Read(monitor, sql, parameter => Value(parameter, since, statement));
                if (!rows.Names.SequenceEqual(sql.Columns)) mismatched.Add(probe + " " + sql.Id);
                read[probe + " " + sql.Id] = rows;
                if (sql.Id == "stats" && rows.Values.FirstOrDefault(row => rows.Get(row, "sql_handle") is not null) is { } first)
                    statement = [rows.Get(first, "sql_handle"), rows.Get(first, "plan_handle"), rows.Get(first, "statement_start_offset"), rows.Get(first, "statement_end_offset")];
            }
        }
        check(mismatched.Count == 0 && read.Count == 19, $"every Activity Monitor statement runs at band {band} ({edition}{(spills ? ", spills" : "")}) and returns the columns it declares: " + string.Join(", ", mismatched));
        var counters = read["activity.overview counters"];
        var found = counters.Values.Select(row => (string)counters.Get(row, "counter_name")!).ToHashSet(StringComparer.Ordinal);
        string[] wanted = ["Batch Requests/sec", "SQL Compilations/sec", "SQL Re-Compilations/sec", "Memory Grants Pending", "Memory Grants Outstanding", "Lock Waits/sec", "Number of Deadlocks/sec",
            "Page life expectancy", "Logins/sec"];
        check(wanted.All(found.Contains) && counters.Values.Count == wanted.Length,
            "the counters statement finds each counter once, whatever the instance prefix and the nchar padding of object names: " + string.Join(", ", wanted.Where(name => !found.Contains(name))));
        var monitorSpid = Convert.ToInt32(clock.Get(clock.Values[0], "monitor_spid"));
        var sessions = read["activity.sessions sessions"];
        check(read["activity.overview cpu"].Values.Count == 1 && Convert.ToInt32(read["activity.overview cpu"].Get(read["activity.overview cpu"].Values[0], "schedulers")) > 0
            && sessions.Values.Any(row => Convert.ToInt32(sessions.Get(row, "session_id")) == monitorSpid)
            && read["activity.sessions activeQueries"].Values.All(row => Convert.ToInt32(read["activity.sessions activeQueries"].Get(row, "session_id")) != monitorSpid),
            "the monitor sees the schedulers and its own session, and leaves its own request out of Active Expensive Queries");
        var text = read["activity.queries text"];
        check(read["activity.queries stats"].Values.Count == 0 || text.Values.Count == 1 && Convert.ToInt32(text.Get(text.Values[0], "slot")) == 0,
            "statement texts come back for the slots that ask, and NULL slots return nothing");
        var waits = read["activity.overview waits"];
        var unknown = waits.Values.Select(row => (string)waits.Get(row, "wait_type")!).Where(type => ActivityCatalog.Current.Classify(type).Category == "unknown").Count();
        Console.WriteLine($"Activity Monitor: {unknown} wait types with time are Unknown on this server (shown, not dropped; AM3 completes the benign list).");

        await BlockingAsync(check, host, info, monitor, render);
        await MarsAsync(check, host, info, monitor, render);
    }

    /// <summary>A MARS session with two requests at once: the sessions statement returns each request as its own row, ranked
    /// within the session, and Processes folds them into one row.</summary>
    private static async Task MarsAsync(Action<bool, string> check, IActionHost host, ConnectionInfo info, SqlConnection monitor, ActivityRender render)
    {
        var connection = host.Connection(info.Id);
        connection.ConnectionString = new SqlConnectionStringBuilder(connection.ConnectionString) { MultipleActiveResultSets = true }.ConnectionString;
        SqlCommand? streaming = null, delay = null;
        SqlDataReader? reader = null;
        Task? delayed = null;
        try
        {
            await host.OpenAsync(connection, CancellationToken.None);
            var spid = Convert.ToInt32(await Scalar(connection, "SELECT @@SPID;"));
            // A result too large for the network buffers keeps its request open while one row is read.
            streaming = new SqlCommand("SELECT a.object_id, b.name FROM sys.all_objects AS a CROSS JOIN sys.all_objects AS b;", connection) { CommandTimeout = 60 };
            reader = await streaming.ExecuteReaderAsync();
            await reader.ReadAsync();
            delay = new SqlCommand("WAITFOR DELAY '00:00:30';", connection) { CommandTimeout = 60 };
            delayed = delay.ExecuteNonQueryAsync();
            var statement = ActivitySql.Statements("activity.sessions", render).Single(item => item.Id == "sessions");
            List<object?[]> Mine(Rows rows) => [.. rows.Values.Where(row => Convert.ToInt32(rows.Get(row, "session_id")) == spid)];
            Rows sessions = new([], []);
            for (var attempt = 0; attempt < 100; attempt++)
            {
                sessions = await Read(monitor, statement, parameter => 10_001);
                if (Mine(sessions).Count > 1) break;
                await Task.Delay(100);
            }
            var mine = Mine(sessions);
            long Number(object?[] row, string column) => Convert.ToInt64(sessions.Get(row, column) ?? -1L);
            // Processes folds them: one row for the session.
            var builder = new ActivitySessionRows(ActivityCatalog.Current);
            var results = new Dictionary<string, ActivityResult> { ["sessions"] = new(sessions.Names, [.. sessions.Values.Select(row => row.Select(cell => cell is DBNull ? null : cell).ToArray())]) };
            var folded = builder.Build(results, 0, new VariaSessions(ActivityCatalog.Current, 0, [], new HashSet<int>()), 0, 0);
            var processes = folded.Sessions.Count(row => builder.SessionsWriter.Reader(row)("sessionId") == spid.ToString(System.Globalization.CultureInfo.InvariantCulture));
            check(mine.Count == 2 && mine.Select(row => Number(row, "request_rank")).SequenceEqual([1L, 2L]) && mine.All(row => Number(row, "request_count") == 2)
                && mine.Select(row => Number(row, "request_id")).Distinct().Count() == 2 && mine.All(row => Number(row, "lowest_request_id") == mine.Min(other => Number(other, "request_id")))
                && processes == 1,
                $"a MARS session running two requests is a sessions row per request, ranked 1 and 2 with both counted, and one Processes row ({mine.Count} rows, {processes} in Processes)");
        }
        finally
        {
            delay?.Cancel();
            streaming?.Cancel();
            if (delayed is not null)
            {
                try { await delayed.WaitAsync(TimeSpan.FromSeconds(30)); } catch (Exception error) when (error is SqlException or TimeoutException or InvalidOperationException) { }
            }
            try { if (reader is not null) await reader.DisposeAsync(); } catch (SqlException) { }
            if (delay is not null) await delay.DisposeAsync();
            if (streaming is not null) await streaming.DisposeAsync();
            await connection.DisposeAsync();
        }
    }

    private static async Task BlockingAsync(Action<bool, string> check, IActionHost host, ConnectionInfo info, SqlConnection monitor, ActivityRender render)
    {
        var marker = "VariaActivityCheck_" + Guid.NewGuid().ToString("N");
        var connections = new List<SqlConnection>();
        var waiting = new List<(SqlCommand Command, Task Task)>();
        async Task<(SqlConnection Connection, int Spid)> Open()
        {
            var connection = host.Connection(info.Id);
            connections.Add(connection);
            await host.OpenAsync(connection, CancellationToken.None);
            return (connection, Convert.ToInt32(await Scalar(connection, "SELECT @@SPID;")));
        }
        var statements = ActivitySql.Statements("activity.sessions", render);
        object? Cap(ActivityParameter parameter) => parameter.Name == "@edgeCap" ? 20_001 : parameter.Name == "@take" ? 101 : 10_001;
        async Task<bool> Waits(int spid)
        {
            var edges = await Read(monitor, statements.Single(statement => statement.Id == "edges"), Cap);
            return edges.Values.Any(row => Convert.ToInt32(edges.Get(row, "session_id")) == spid);
        }
        async Task Until(Func<Task<bool>> condition)
        {
            for (var attempt = 0; attempt < 150 && !await condition(); attempt++) await Task.Delay(100);
        }
        var holder = default((SqlConnection Connection, int Spid));
        long cleanupMs = 0;
        try
        {
            holder = await Open();
            // Literal text (the marker is this run's own GUID), so the input buffer holds the marker comment.
            await Scalar(holder.Connection, $"BEGIN TRAN; DECLARE @r int; EXEC @r = sp_getapplock @Resource = N'{marker}', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0; -- {marker}");
            var waiters = new List<int>();
            for (var index = 0; index < 3; index++)
            {
                var waiter = await Open();
                waiters.Add(waiter.Spid);
                var command = new SqlCommand($"DECLARE @r int; EXEC @r = sp_getapplock @Resource = N'{marker}', @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = 60000;", waiter.Connection) { CommandTimeout = 90 };
                waiting.Add((command, command.ExecuteNonQueryAsync()));
                await Until(() => Waits(waiter.Spid));
            }
            var sessions = await Read(monitor, statements.Single(statement => statement.Id == "sessions"), Cap);
            var edges = await Read(monitor, statements.Single(statement => statement.Id == "edges"), Cap);
            var batches = await Read(monitor, statements.Single(statement => statement.Id == "leadBatches"), Cap);
            var waits = edges.Values.Select(row => new BlockingWait(Convert.ToInt32(edges.Get(row, "session_id")), Convert.ToInt32(edges.Get(row, "blocking_session_id")),
                    (string?)edges.Get(row, "wait_type"), Convert.ToInt64(edges.Get(row, "wait_duration_ms") ?? 0L), (string?)edges.Get(row, "resource_description")))
                .Concat(sessions.Values.Where(row => sessions.Get(row, "blocking_session_id") is not null).Select(row => new BlockingWait(Convert.ToInt32(sessions.Get(row, "session_id")),
                    Convert.ToInt32(sessions.Get(row, "blocking_session_id")), (string?)sessions.Get(row, "wait_type"), Convert.ToInt64(sessions.Get(row, "wait_time") ?? 0), (string?)sessions.Get(row, "wait_resource"), FromTask: false)));
            var graph = BlockingGraph.Build(waits, 32, 2_000);
            int? Root(int spid)
            {
                var at = graph.Of(spid);
                for (var hops = 0; at?.BlockedBy is int up && hops < 64; hops++) at = graph.Of(up);
                return at?.SessionId;
            }
            var ours = graph.Rows.Where(row => row.Node.SessionId == holder.Spid || waiters.Contains(row.Node.SessionId)).ToList();
            var holderRow = sessions.Values.Single(row => Convert.ToInt32(sessions.Get(row, "session_id")) == holder.Spid);
            check(waiters.All(spid => Root(spid) == holder.Spid) && graph.Of(holder.Spid) is { HeadBlocker: true, BlockedBy: null, Downstream: 3 }
                && ours.Count == 4 && ours.Select(row => row.Node.SessionId).Distinct().Count() == 4 && ours.Single(row => row.Node.SessionId == holder.Spid).Depth == 0
                && waiters.All(spid => graph.Of(spid)!.WaitType?.StartsWith("LCK_M_", StringComparison.Ordinal) == true),
                "a real chain of application locks is one row per session under its idle lead blocker, each waiter on a lock");
            check(Convert.ToInt32(sessions.Get(holderRow, "open_transaction_count")) == 1 && sessions.Get(holderRow, "request_id") is null
                && batches.Values.Any(row => Convert.ToInt32(batches.Get(row, "session_id")) == holder.Spid && ((string?)batches.Get(row, "event_info"))?.Contains(marker, StringComparison.Ordinal) == true),
                "the idle lead blocker shows its open transaction (SSMS shows 0) and its last batch");
            // Truncation drops idle sessions first: with room for little more than the sessions in blocking waits, the chain
            // is still there (ordered by session id alone, the cap would keep SQL Server's own low ids instead).
            var fresh = await Read(monitor, statements.Single(statement => statement.Id == "edges"), Cap);
            var named = fresh.Values.SelectMany(row => new[] { Convert.ToInt32(fresh.Get(row, "session_id")), Convert.ToInt32(fresh.Get(row, "blocking_session_id")) }).Where(id => id > 0).ToHashSet();
            var capped = await Read(monitor, statements.Single(statement => statement.Id == "sessions"), parameter => parameter.Name == "@rowCap" ? named.Count + 5 : Cap(parameter));
            var kept = capped.Values.Select(row => Convert.ToInt32(capped.Get(row, "session_id"))).ToHashSet();
            check(kept.Count == capped.Values.Count && waiters.Append(holder.Spid).All(kept.Contains), $"a sessions read capped at {named.Count + 5} sessions keeps this run's blocking chain");
        }
        finally
        {
            // Cancel the waiters before the holder lets go: a waiter granted the session-owned lock would keep it, and each
            // one behind it would wait out its lock timeout.
            var cleanup = System.Diagnostics.Stopwatch.StartNew();
            foreach (var (command, task) in waiting) if (!task.IsCompleted) command.Cancel();
            if (holder.Connection is { State: ConnectionState.Open }) await Scalar(holder.Connection, "IF @@TRANCOUNT > 0 ROLLBACK;");
            foreach (var (command, task) in waiting)
            {
                try { await task.WaitAsync(TimeSpan.FromSeconds(30)); } catch (Exception error) when (error is SqlException or TimeoutException or InvalidOperationException) { }
                await command.DisposeAsync();
            }
            foreach (var connection in connections) await connection.DisposeAsync();
            cleanupMs = cleanup.ElapsedMilliseconds;
        }
        // Waiting out the waiters' lock timeouts took 20 s of every live run, under the lock other runs queue for.
        check(cleanupMs < 10_000, $"the blocking chain's cleanup cancels its waiters at once ({cleanupMs} ms)");
    }
}
