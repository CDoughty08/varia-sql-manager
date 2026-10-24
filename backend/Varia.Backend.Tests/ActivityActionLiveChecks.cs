using System.Data;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Activity;
using Varia.Backend.Live;

namespace Varia.Backend.Tests;

/// <summary>Live checks of Details and Kill Process. Every session they kill or read is one they opened, under a program
/// name that carries this run's own marker; the other targets (a system session, an id no session has, this backend's own
/// pool session) are refused by the kill batch before KILL, which SQL Server would refuse for a system session anyway. With
/// VARIA_TEST_SQL_SCRATCH=1 a scratch login with server state but no ALTER ANY CONNECTION is denied, and one without server
/// state sees no other session, so nothing is killed.</summary>
internal static class ActivityActionLiveChecks
{
    private sealed record Victim(SqlConnection Connection, int Spid, DateTime LoginTime, int? HostProcessId)
    {
        /// <summary>The row's identity as Processes shows it.</summary>
        public ActivityKillSessionDto Kill() => new(Spid, SessionActions.FormatLoginTime(LoginTime), HostProcessId);
    }

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json, bool requirePermissionChecks = false)
    {
        var host = (IActionHost)service;
        var profile = host.Profile(info.Id);
        var band = ActivitySql.BandOf(profile.Major, profile.EngineEdition, profile.CatalogBand);
        var edition = ActivityCatalog.Current.EditionOf(profile.EngineEdition);
        if (band is null || edition is null)
        {
            if (requirePermissionChecks) throw new InvalidOperationException("Activity Monitor session action checks require a supported SQL Server.");
            Console.WriteLine("Activity Monitor session action checks skipped: the server is not one the monitor serves yet.");
            return;
        }
        var render = new ActivityRender(band.Value, edition);
        var marker = "VariaActivityKill_" + Guid.NewGuid().ToString("N");
        var opened = new List<SqlConnection>();
        await using var monitor = host.Connection(info.Id);
        await host.OpenAsync(monitor, CancellationToken.None);
        async Task<Victim> Open(string suffix, Func<SqlConnectionStringBuilder, SqlConnectionStringBuilder>? change = null)
        {
            using var template = host.Connection(info.Id);
            var builder = new SqlConnectionStringBuilder(template.ConnectionString) { ApplicationName = marker + suffix };
            var connection = new SqlConnection((change?.Invoke(builder) ?? builder).ConnectionString);
            opened.Add(connection);
            await host.OpenAsync(connection, CancellationToken.None);
            return await Identify(connection, connection.ServerProcessId);
        }
        async Task<Victim> Identify(SqlConnection connection, int spid)
        {
            await using var command = new SqlCommand("SELECT login_time, host_process_id FROM sys.dm_exec_sessions WHERE session_id = @spid;", monitor);
            command.Parameters.Add(new SqlParameter("@spid", SqlDbType.Int) { Value = spid });
            await using var reader = await command.ExecuteReaderAsync();
            if (!await reader.ReadAsync()) throw new InvalidOperationException("A session this run opened is not listed.");
            return new(connection, spid, reader.GetDateTime(0), reader.IsDBNull(1) ? null : reader.GetInt32(1));
        }
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        Task<ActivityKillResult> Kill(params ActivityKillSessionDto[] sessions) => Call<ActivityKillResult>("activity.kill", new ActivityKillArgs(info.Id, [.. sessions]));
        Task<ActivityDetailsResult> Details(Victim victim, DateTime? loginTime = null, string? text = null, bool? locks = null) =>
            Call<ActivityDetailsResult>("activity.details", new ActivityDetailsArgs(info.Id, Guid.NewGuid().ToString(), victim.Spid, SessionActions.FormatLoginTime(loginTime ?? victim.LoginTime), text, locks));
        static async Task<bool> Works(SqlConnection connection)
        {
            try
            {
                await using var command = new SqlCommand("SELECT 1;", connection) { CommandTimeout = 15 };
                return Convert.ToInt32(await command.ExecuteScalarAsync()) == 1;
            }
            catch (Exception error) when (error is SqlException or InvalidOperationException) { return false; }
        }
        var running = new List<(SqlCommand Command, Task Task)>();
        try
        {
            // Every statement returns the columns it declares at the server's band (SessionActions also checks on every read).
            var mismatched = new List<string>();
            foreach (var statement in ActivitySql.Statements("activity.details", render).Append(ActivitySql.Statements("activity.kill", render).Single()))
            {
                await using var command = new SqlCommand((statement.Probe == "activity.kill" ? ActivitySql.KillPrologue : "") + statement.Text, monitor);
                foreach (var parameter in statement.Parameters)
                    command.Parameters.Add(new SqlParameter(parameter.Name, parameter.Type) { Size = parameter.Size, Value = parameter.Name switch
                    {
                        // An id no session has, so the kill batch's state is 1 and it kills nothing.
                        "@session_id" => statement.Probe == "activity.kill" ? 32_767 : monitor.ServerProcessId,
                        "@login_time" => DateTime.Now,
                        "@rowCap" or "@chars" or "@statement_chars" or "@batch_chars" => 10,
                        "@backend_pid" => Environment.ProcessId,
                        _ => DBNull.Value
                    } });
                await using var reader = await command.ExecuteReaderAsync();
                var names = Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToList();
                if (!names.SequenceEqual(statement.Columns)) mismatched.Add(statement.Id);
            }
            check(mismatched.Count == 0, $"every Details and Kill statement runs at band {band} and returns the columns it declares: " + string.Join(", ", mismatched));

            // Details of a session holding a transaction, an application lock and a temporary table, while it waits in a batch
            // longer than the flyout's preview.
            var reader1 = await Open("_details");
            var padding = new string('x', 70_000);
            await using (var setup = new SqlCommand($"BEGIN TRAN; DECLARE @r int; EXEC @r = sp_getapplock @Resource = N'{marker}', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0;"
                + " CREATE TABLE #varia_details (v nvarchar(4000)); INSERT #varia_details SELECT TOP (200) REPLICATE(N'v', 4000) FROM sys.all_objects;", reader1.Connection))
                await setup.ExecuteNonQueryAsync();
            var waiting = new SqlCommand($"/* {marker} {padding} */\nWAITFOR DELAY '00:00:30';", reader1.Connection) { CommandTimeout = 60 };
            running.Add((waiting, waiting.ExecuteNonQueryAsync()));
            ActivityDetailsResult details = new(0, "ended", 0);
            for (var attempt = 0; attempt < 50; attempt++)
            {
                details = await Details(reader1, locks: true);
                if (details.Session?.Command == "WAITFOR") break;
                await Task.Delay(100);
            }
            check(details is { State: "present", SectionErrors: null, Error: null, Session: { Command: "WAITFOR", RequestCount: 1, OpenTransactions: >= 1, IsUserProcess: true }, ReadAt: not null }
                && details.Session.Application == marker + "_details" && details.Session.LoginTime == SessionActions.FormatLoginTime(reader1.LoginTime) && details.Session.WaitType == "WAITFOR"
                && details.Statement is { Truncated: false } && details.Statement.Text.Contains("WAITFOR DELAY", StringComparison.Ordinal)
                && details.Batch is { Truncated: true, Text.Length: 65_536 } && details.Batch.Chars > 70_000 && details.Batch.Text.Contains(marker, StringComparison.Ordinal)
                && details.InputBuffer?.Text.Text.Contains(marker, StringComparison.Ordinal) == true && details.InputBuffer.EventType == "Language Event"
                && details.Transactions?.Any(transaction => transaction.UserTransaction) == true && details.TransactionsTruncated == false
                && details.Tempdb is { UserObjectsKb: > 0 } && details.Locks?.Any(item => item.ResourceType == "APPLICATION" && item.Mode == "X" && item.Status == "GRANT") == true
                && details.LocksTruncated == false && details.Waits is not null,
                $"Details reads a waiting session's identity, statement, batch (the first 65,536 characters), last batch, transaction, tempdb pages and application lock ({details.State}, "
                + string.Join("; ", details.SectionErrors?.Select(error => error.Section + " " + error.Code) ?? []) + ")");
            var whole = await Details(reader1, text: "batch");
            check(whole is { State: "present", Session: null, Statement: null, InputBuffer: null, Waits: null, Locks: null, Batch.Truncated: false } && whole.Batch.Text.Length == whole.Batch.Chars
                && whole.Batch.Chars == details.Batch!.Chars, "asked for the batch by name, Details returns only it, whole, for Open in Query Editor");
            var changed = await Details(reader1, loginTime: reader1.LoginTime.AddSeconds(-1));
            check(changed is { State: "changed", Session: null, Statement: null, Transactions: null, Error: null },
                "Details of a session id that now belongs to another session (its login time differs) answers changed and reads nothing more");
            check(service.Live.Gates.Busy == 0, "Details gives its live gate back");

            // Kill Process, with every identity check: a stale login time or host process id is refused and the session lives.
            var victim = await Open("_victim");
            await using (var hold = new SqlCommand($"BEGIN TRAN; DECLARE @r int; EXEC @r = sp_getapplock @Resource = N'{marker}_kill', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 0;", victim.Connection))
                await hold.ExecuteNonQueryAsync();
            var other = await Open("_other");
            // One request may not name a session twice, so each stale identity is its own request.
            var stale = new List<ActivityKillResult>
            {
                await Kill(victim.Kill() with { LoginTime = SessionActions.FormatLoginTime(victim.LoginTime.AddSeconds(-1)) }),
                await Kill(victim.Kill() with { HostProcessId = (victim.HostProcessId ?? 0) + 1 }),
                await Kill(victim.Kill() with { HostProcessId = victim.HostProcessId is null ? 1 : null })
            };
            check(stale.All(result => result is { Error: null, Results: [{ Outcome: "changed", Message: null }] }) && stale.All(result => result.Results[0].SessionId == victim.Spid)
                && await Works(victim.Connection),
                "Kill refuses a session whose login time or host process id differs from the row's (the id was reused), and the session keeps working: "
                + string.Join(", ", stale.SelectMany(result => result.Results).Select(result => result.Outcome)));
            var absent = 32_767;
            await using (var free = new SqlCommand("SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE session_id = 32767;", monitor))
                if (Convert.ToInt32(await free.ExecuteScalarAsync()) != 0) absent = 0;
            var both = await Kill([new(other.Spid, SessionActions.FormatLoginTime(other.LoginTime.AddMinutes(-5)), other.HostProcessId), victim.Kill(),
                .. absent == 0 ? Array.Empty<ActivityKillSessionDto>() : [new ActivityKillSessionDto(absent, "2026-10-22T00:00:00", null)]]);
            var gone = false;
            for (var attempt = 0; attempt < 50 && !gone; attempt++)
            {
                await using var probe = new SqlCommand("SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE session_id = @spid AND login_time = @login;", monitor);
                probe.Parameters.Add(new SqlParameter("@spid", SqlDbType.Int) { Value = victim.Spid });
                probe.Parameters.Add(new SqlParameter("@login", SqlDbType.DateTime) { Value = victim.LoginTime });
                gone = Convert.ToInt32(await probe.ExecuteScalarAsync()) == 0;
                if (!gone) await Task.Delay(100);
            }
            string[] expected = absent == 0 ? ["changed", "killed"] : ["changed", "killed", "ended"];
            check(both is { Error: null } && both.Results.Select(result => result.Outcome).SequenceEqual(expected) && both.Results.Select(result => result.SessionId).SequenceEqual(both.Results.Select(result => result.SessionId))
                && gone && !await Works(victim.Connection) && await Works(other.Connection),
                "Kill runs each session's check in order: a stale identity is left alone, the session with the row's identity is killed (its transaction rolls back and it is gone), "
                + "and an id no session has is ended: " + string.Join(", ", both.Results.Select(result => result.Outcome)));

            // Never this backend's own pool sessions, nor SQL Server's.
            var pooled = ((ILiveHost)service).PoolConnection(info.Id, null, LiveConnections.ServerSuffix);
            opened.Add(pooled);
            await ((ILiveHost)service).OpenAsync(pooled, CancellationToken.None);
            var pool = await Identify(pooled, pooled.ServerProcessId);
            int? systemSpid = null;
            DateTime systemLogin = default;
            await using (var system = new SqlCommand("SELECT TOP (1) session_id, login_time FROM sys.dm_exec_sessions WHERE is_user_process = 0 ORDER BY session_id;", monitor))
            await using (var row = await system.ExecuteReaderAsync())
                if (await row.ReadAsync()) (systemSpid, systemLogin) = (row.GetInt16(0), row.GetDateTime(1));
            var refused = await Kill([pool.Kill(), .. systemSpid is { } spid ? [new ActivityKillSessionDto(spid, SessionActions.FormatLoginTime(systemLogin), null)] : Array.Empty<ActivityKillSessionDto>()]);
            check(refused.Results.Select(result => result.Outcome).SequenceEqual(systemSpid is null ? ["varia"] : ["varia", "system"]) && await Works(pooled),
                "Kill refuses this window's own Activity Monitor pool session (varia) and a SQL Server system session (system), killing neither: "
                + string.Join(", ", refused.Results.Select(result => result.Outcome)));
            // Nor the pool sessions of this backend's other connections, whose Application Names differ (one long enough that
            // its pool names are cut to 128 characters).
            var others = new List<string>();
            try
            {
                var pooledOthers = new List<Victim>();
                foreach (var name in new[] { marker + "_B", (marker + "_C").PadRight(120, 'c') })
                {
                    var options = live("master") with { Advanced = new AdvancedConnectionOptions(ApplicationName: name) };
                    var connected = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(options, json), json);
                    others.Add(connected.Id);
                    var otherPool = ((ILiveHost)service).PoolConnection(connected.Id, null, LiveConnections.ServerSuffix);
                    opened.Add(otherPool);
                    await ((ILiveHost)service).OpenAsync(otherPool, CancellationToken.None);
                    pooledOthers.Add(await Identify(otherPool, otherPool.ServerProcessId));
                }
                var programs = new List<string>();
                foreach (var pooledOther in pooledOthers)
                {
                    await using var program = new SqlCommand("SELECT program_name FROM sys.dm_exec_sessions WHERE session_id = @spid;", monitor);
                    program.Parameters.Add(new SqlParameter("@spid", SqlDbType.Int) { Value = pooledOther.Spid });
                    programs.Add(Convert.ToString(await program.ExecuteScalarAsync(), System.Globalization.CultureInfo.InvariantCulture) ?? "");
                }
                var refusedOthers = await Kill([.. pooledOthers.Select(pooledOther => pooledOther.Kill())]);
                var alive = new List<bool>();
                foreach (var pooledOther in pooledOthers) alive.Add(await Works(pooledOther.Connection));
                check(refusedOthers is { Error: null } && refusedOthers.Results.Select(result => result.Outcome).SequenceEqual(["varia", "varia"]) && alive.All(item => item)
                    && programs[0] == marker + "_B" + LiveConnections.ServerSuffix && programs[1].Length == 128,
                    "Kill from one connection refuses the pool sessions of this backend's other connections with other Application Names, also when the name is cut to 128 characters: "
                    + string.Join(", ", refusedOthers.Results.Select(result => result.Outcome)) + " " + string.Join(", ", alive));
            }
            finally
            {
                foreach (var otherId in others) await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(otherId), json), json);
            }
            // The batch's own session: the template answers 2 (own) for @@SPID, before KILL could refuse it.
            await using (var self = new SqlCommand(ActivitySql.KillPrologue + ActivitySql.Statements("activity.kill", render).Single().Text, other.Connection))
            {
                foreach (var parameter in ActivitySql.Statements("activity.kill", render).Single().Parameters)
                    self.Parameters.Add(new SqlParameter(parameter.Name, parameter.Type) { Size = parameter.Size, Value = parameter.Name switch
                    {
                        "@session_id" => other.Spid,
                        "@login_time" => other.LoginTime,
                        "@host_process_id" => (object?)other.HostProcessId ?? DBNull.Value,
                        "@backend_pid" => Environment.ProcessId,
                        _ => "unused"
                    } });
                var state = Convert.ToInt32(await self.ExecuteScalarAsync());
                check(state == 2 && await Works(other.Connection), "the kill batch answers own (2) for its own session and runs no KILL");
            }

            await PermissionAsync(check, service, info, live, json, Open, Works, requirePermissionChecks);
        }
        finally
        {
            foreach (var (command, task) in running)
            {
                command.Cancel();
                try { await task.WaitAsync(TimeSpan.FromSeconds(30)); } catch (Exception error) when (error is SqlException or TimeoutException or InvalidOperationException) { }
                await command.DisposeAsync();
            }
            // Closing an unpooled session rolls back its transaction; the pooled one goes back to its pool.
            foreach (var connection in opened) await connection.DisposeAsync();
        }
    }

    /// <summary>Scratch only: a login with server state but without ALTER ANY CONNECTION is denied and the session lives; a
    /// login without server state cannot see the session, so Details and Kill answer ended and nothing is killed.</summary>
    private static async Task PermissionAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json,
        Func<string, Func<SqlConnectionStringBuilder, SqlConnectionStringBuilder>?, Task<Victim>> open, Func<SqlConnection, Task<bool>> works, bool required)
    {
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            if (required) throw new InvalidOperationException("Activity Monitor session action permission checks require VARIA_TEST_SQL_SCRATCH=1.");
            Console.WriteLine("Kill Process permission checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named login on a disposable development server.");
            return;
        }
        var host = (IActionHost)service;
        async Task<SqlRun> Sql(string text)
        {
            await using var connection = host.Connection(info.Id);
            await host.OpenAsync(connection, CancellationToken.None);
            await using var command = new SqlCommand(text, connection) { CommandTimeout = 30 };
            try
            {
                var scalar = await command.ExecuteScalarAsync();
                return new SqlRun("completed", null, [[[scalar is null or DBNull ? null : Convert.ToString(scalar, System.Globalization.CultureInfo.InvariantCulture)]]]);
            }
            catch (SqlException error) { return new SqlRun("failed", error.Message, []); }
        }
        await using var scratch = ScratchDatabase.Bare((text, _) => Sql(text));
        if (!await scratch.CreateLoginAsync())
        {
            if (required) throw new InvalidOperationException("Activity Monitor session action permission checks require a SQL Server that accepts SQL logins.");
            Console.WriteLine("Kill Process permission checks skipped: this server accepts Windows logins only.");
            return;
        }
        var login = "[" + scratch.Login!.Replace("]", "]]") + "]";
        var victim = await open("_denied", null);
        string? limitedId = null;
        try
        {
            var options = live("master") with { Authentication = "sql", Username = scratch.Login, Password = scratch.Password };
            var limited = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(options, json), json);
            limitedId = limited.Id;
            async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
            var unseen = await Call<ActivityKillResult>("activity.kill", new ActivityKillArgs(limited.Id, [victim.Kill()]));
            var unseenDetails = await Call<ActivityDetailsResult>("activity.details", new ActivityDetailsArgs(limited.Id, Guid.NewGuid().ToString(), victim.Spid, SessionActions.FormatLoginTime(victim.LoginTime)));
            var unseenAlive = await works(victim.Connection);
            check(unseen.Results is [{ Outcome: "ended" }] && unseenDetails is { State: "ended", Error: null } && unseenAlive,
                "a login without server state sees no other session: Kill and Details answer ended and nothing is killed; "
                + "kill=" + string.Join(", ", unseen.Results.Select(result => result.Outcome + ":" + result.Message))
                + "; killError=" + unseen.Error?.Code + ":" + unseen.Error?.Message
                + "; details=" + unseenDetails.State + "; detailsError=" + unseenDetails.Error?.Code + ":" + unseenDetails.Error?.Message
                + "; victimAlive=" + unseenAlive);
            var granted = await Sql("GRANT VIEW SERVER STATE TO " + login + ";");
            var denied = await Call<ActivityKillResult>("activity.kill", new ActivityKillArgs(limited.Id, [victim.Kill()]));
            var seen = await Call<ActivityDetailsResult>("activity.details", new ActivityDetailsArgs(limited.Id, Guid.NewGuid().ToString(), victim.Spid, SessionActions.FormatLoginTime(victim.LoginTime)));
            var seenAlive = await works(victim.Connection);
            check(granted.Status == "completed" && denied.Results is [{ Outcome: "denied", Message: null }] && denied.Error is null && seen is { State: "present" } && seenAlive,
                "a login with server state but without ALTER ANY CONNECTION reads Details, and its Kill is denied as a value while the session lives; "
                + "grant=" + granted.Status + ":" + granted.Error
                + "; kill=" + string.Join(", ", denied.Results.Select(result => result.Outcome + ":" + result.Message))
                + "; killError=" + denied.Error?.Code + ":" + denied.Error?.Message
                + "; details=" + seen.State + "; detailsError=" + seen.Error?.Code + ":" + seen.Error?.Message
                + "; victimAlive=" + seenAlive);
        }
        finally
        {
            if (limitedId is not null) await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(limitedId), json), json);
            // The login is this run's own: its sessions, if a pool kept one, are ours to end before the login is dropped.
            await Sql("DECLARE @kill nvarchar(max) = N'';\nSELECT @kill += N'KILL ' + CONVERT(nvarchar(11), s.session_id) + N';' FROM sys.dm_exec_sessions AS s WHERE s.login_name = N'"
                + scratch.Login!.Replace("'", "''") + "';\nEXEC (@kill);");
        }
    }
}
