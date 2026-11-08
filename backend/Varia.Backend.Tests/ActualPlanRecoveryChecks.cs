using System.Data;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Live;
using Varia.Backend.Plans;

namespace Varia.Backend.Tests;

internal static class ActualPlanRecoveryChecks
{
    public static void Run(Action<bool, string> check)
    {
        // Replaces the older interpolated-DDL lint: the builders take only scope/version booleans, all values
        // are bound as typed parameters, and the live lane also round-trips a hostile identifier through QUOTENAME.
        var client = Guid.Parse("29a1b709-41ab-4c1e-bc93-acd76bd66e96");
        var target = Guid.Parse("49a1b709-41ab-4c1e-bc93-acd76bd66e96");
        var owner = Guid.Parse("39a1b709-41ab-4c1e-bc93-acd76bd66e96");
        const string Batch = "<and><leaf><comparator name=\"equal_uint64\" package=\"package0\"/><global name=\"session_id\" package=\"sqlserver\"/><value>99</value></leaf>"
            + "<leaf><comparator name=\"equal_guid\" package=\"package0\"/><global name=\"client_connection_id\" package=\"sqlserver\"/><value>29A1B709-41AB-4C1E-BC93-ACD76BD66E96</value></leaf></and>";
        const string Plan = "<and>" + Batch + "<leaf><comparator name=\"equal_boolean\" package=\"package0\"/><global name=\"is_system\" package=\"sqlserver\"/><value>false</value></leaf></and>";
        var candidate = new ActualPlanRecovery.Candidate(1, ActualPlanRecovery.Name(client, target, owner), Batch, Plan, "", "");
        check(ActualPlanRecovery.Owns(candidate, out var c, out var o) && c == target && o == owner, "collector ownership binds both server connection IDs separately from the client event GUID");
        check(ActualPlanRecovery.Owns(candidate with {
            BatchXml = candidate.BatchXml.Replace("package=\"package0\"/>", "package=\"package0\"></comparator>").Replace("package=\"sqlserver\"/>", "package=\"sqlserver\"></global>"),
            PlanXml = candidate.PlanXml.Replace("package=\"package0\"/>", "package=\"package0\"></comparator>").Replace("package=\"sqlserver\"/>", "package=\"sqlserver\"></global>") }, out _, out _),
            "server predicate serialization with explicit closing tags is equivalent to self-closing nodes");
        foreach (var changed in new[] {
            candidate with { Name = "VariaActual_" + client.ToString("N") }, // Legacy random GUID is not an ownership ledger.
            candidate with { Name = ActualPlanRecovery.Name(Guid.NewGuid(), target, owner) },
            candidate with { Name = ActualPlanRecovery.Name(client, Guid.Empty, owner) },
            candidate with { Name = ActualPlanRecovery.Name(client, target, Guid.Empty) },
            candidate with { Name = candidate.Name + "];DROP EVENT SESSION x--" },
            candidate with { BatchXml = Batch.Replace("<and>", "<or>").Replace("</and>", "</or>") },
            candidate with { BatchXml = Batch.Replace("<value>99", "<value>0") },
            candidate with { PlanXml = Plan.Replace("false", "true") },
            candidate with { PlanXml = Plan.Replace("<value>99", "<value>100") },
            candidate with { PlanXml = "<broken" } })
            check(!ActualPlanRecovery.Owns(changed, out _, out _), "modified, legacy or ambiguous collector ownership is refused");
        foreach (var database in new[] { false, true })
        foreach (var duration in new[] { false, true })
        {
            var sql = ActualPlanSql.Create(database, duration);
            check(sql.Contains("QUOTENAME(@name)") && sql.Contains("CONVERT(nvarchar(11),@spid)") && sql.Contains("CONVERT(nvarchar(36),@client)")
                && sql.Contains("[package0].[equal_guid]([sqlserver].[client_connection_id]") && sql.Contains("[sqlserver].[is_system]=(0)")
                && sql.Contains("STARTUP_STATE=OFF") && sql.Contains("max_memory=(4096), max_events_limit=(2048)")
                && sql.Contains("MAX_DURATION") == duration && sql.Contains(database ? "ON DATABASE" : "ON SERVER")
                && !sql.Contains("STATISTICS XML") && !sql.Contains("SHOWPLAN"), "collector SQL uses parameter-only values, bounded targets and fixed scope/version variants");
            check(ActualPlanSql.Drop(database).Contains("QUOTENAME(@name)"), "collector cleanup quotes its identifier on the server");
            check(ActualPlanSql.Read(database).Contains(database ? "sys.dm_xe_database_sessions" : "sys.dm_xe_sessions")
                && ActualPlanSql.Read(database).Contains("s.name=@name"), "collector reads preserve scope and parameterized ownership");
            check(ActualPlanSql.Permissions(database).Contains(database ? "DROP ANY DATABASE EVENT SESSION" : "DROP ANY EVENT SESSION")
                && ActualPlanSql.Permissions(database).Contains("IS NULL"), "collector permission preflight preserves granular DENY and legacy permission fallback");
        }
        check(ActualPlanSql.Candidates.Contains("TOP (17)") && ActualPlanSql.Candidates.Contains("ORDER BY CASE WHEN c.id>@after THEN 0 ELSE 1 END, c.id")
            && ActualPlanSql.DropAbandoned.Contains("s.event_session_id=@id") && ActualPlanSql.DropAbandoned.Contains("b.predicate=@batch AND p.predicate=@plan")
            && ActualPlanSql.DropAbandoned.Contains("c.parent_connection_id IN (@target,@owner)") && ActualPlanSql.DropAbandoned.Contains("QUOTENAME(@name)"),
            "collector recovery bounds and rotates its scan and rechecks definition and MARS/physical connection liveness before quoted DROP");
        // Single-GUID names from earlier builds go only when clearly abandoned: stopped, or created more than a day ago.
        check(ActualPlanSql.Candidates.Contains(ActualPlanSql.LegacyName) && ActualPlanSql.Candidates.Contains(ActualPlanSql.LegacyAbandoned)
            && ActualPlanSql.DropLegacy.Contains(ActualPlanSql.LegacyName) && ActualPlanSql.DropLegacy.Contains(ActualPlanSql.LegacyAbandoned)
            && ActualPlanSql.DropLegacy.Contains("s.event_session_id=@id AND s.name=@name") && ActualPlanSql.DropLegacy.Contains("QUOTENAME(@name)")
            && ActualPlanSql.LegacyAbandoned.Contains("NOT EXISTS (SELECT 1 FROM sys.dm_xe_sessions") && ActualPlanSql.LegacyAbandoned.Contains("create_time<DATEADD(day,-1,GETDATE())")
            && ActualPlanSql.LegacyName.Contains("DATALENGTH(s.name)=88"), "legacy collectors are selected and rechecked only when stopped or a day old");

        // #165: every collector statement, each variant, passes the collector lint, and the lint refuses what it is for.
        var all = ActualPlanSql.All().ToList();
        check(all.Count == 13 &&all.Distinct().Count() == all.Count, "the collector lint sees every rendered variant");
        foreach (var sql in all)
        {
            var problems = ActualPlanSql.Lint(sql);
            check(problems.Count == 0, "collector SQL passes its lint: " + string.Join("; ", problems));
        }
        check(ReferenceEquals(ActualPlanSql.Create(false, true), ActualPlanSql.Create(false, true)) && ReferenceEquals(ActualPlanSql.Drop(true), ActualPlanSql.Drop(true)),
            "collector SQL is rendered once per variant, the text the lint checked");
        foreach (var (bad, why) in new[] {
            ("DECLARE @sql nvarchar(max) = N'DROP EVENT SESSION [' + @name + N'] ON SERVER;'; EXEC sys.sp_executesql @sql;", "raw identifier"),
            ("DECLARE @sql nvarchar(max) = N'DROP EVENT SESSION ' + CONVERT(nvarchar(128),@name) + N' ON SERVER;'; EXEC sys.sp_executesql @sql;", "converted identifier"),
            ("DECLARE @sql nvarchar(max) = N'DROP EVENT SESSION ' + QUOTENAME(@name) + N' ON SERVER;'; EXEC(@sql);", "EXEC of a string"),
            ("DECLARE @sql nvarchar(max) = N'DROP EVENT SESSION ' + QUOTENAME(@name) + N' ON {Scope};'; EXEC sys.sp_executesql @sql;", "unrendered hole"),
            ("DECLARE @sql nvarchar(max) = N'DROP EVENT SESSION [VariaActual_1] ON SERVER;'; SET @sql = @sql + @name; EXEC sys.sp_executesql @sql;", "late assignment"),
            ("DECLARE @sql nvarchar(max) = N'DROP DATABASE ' + QUOTENAME(@name) + N';'; EXEC sys.sp_executesql @sql;", "other DDL"),
            ("DECLARE @sql nvarchar(max) = N'GRANT CONTROL SERVER TO ' + QUOTENAME(@name) + N';'; EXEC sys.sp_executesql @sql;", "other statement"),
            ("SELECT name FROM sys.server_event_sessions WHERE name=@other;", "unknown variable"),
            ("DROP EVENT SESSION [x] ON SERVER;", "static DDL outside the dynamic text"),
            ("SELECT N'unterminated;", "unterminated literal") })
            check(ActualPlanSql.Lint(bad).Count > 0, "the collector lint refuses " + why);

        ScanChecks(check);
    }

    /// <summary>#258 and #234: a backlog of definitions that recovery refuses, or that fail to drop, ahead of real
    /// orphans. Bounded passes must still reach every orphan and never drop a refused one.</summary>
    private static void ScanChecks(Action<bool, string> check)
    {
        const string Batch = "<and><leaf><comparator name=\"equal_uint64\" package=\"package0\"/><global name=\"session_id\" package=\"sqlserver\"/><value>7</value></leaf>"
            + "<leaf><comparator name=\"equal_guid\" package=\"package0\"/><global name=\"client_connection_id\" package=\"sqlserver\"/><value>{0}</value></leaf></and>";
        const string Plan = "<and>" + Batch + "<leaf><comparator name=\"equal_boolean\" package=\"package0\"/><global name=\"is_system\" package=\"sqlserver\"/><value>false</value></leaf></and>";
        ActualPlanRecovery.Candidate Make(int id, bool owned)
        {
            var client = Guid.NewGuid();
            var shown = (owned ? client : Guid.NewGuid()).ToString("D").ToUpperInvariant();
            return new(id, ActualPlanRecovery.Name(client, Guid.NewGuid(), Guid.NewGuid()), string.Format(Batch, shown), string.Format(Plan, shown), "", "");
        }
        // Ids 1-20 are refused (their predicates name another client), 21-23 always fail to drop, 24-40 are orphans,
        // and 41-42 are legacy orphans.
        var server = new SortedDictionary<int, ActualPlanRecovery.Candidate>();
        for (var id = 1; id <= 40; id++) server[id] = Make(id, id > 20);
        for (var id = 41; id <= 42; id++) server[id] = new(id, "VariaActual_" + Guid.NewGuid().ToString("N"), "", "", "", "", true);
        var failing = new HashSet<int> { 21, 22, 23 };
        // The candidate query's order: ids after the resume point first, then the scan wraps; TOP (limit + 1).
        Task<List<ActualPlanRecovery.Candidate>> Select(int after) => Task.FromResult(server.Values
            .OrderBy(candidate => candidate.Id > after ? 0 : 1).ThenBy(candidate => candidate.Id).Take(ActualPlanSql.RecoveryLimit + 1).ToList());
        var dropped = new List<int>();
        Task<bool> Drop(ActualPlanRecovery.Candidate candidate, Guid target, Guid owner)
        {
            if (failing.Contains(candidate.Id)) return Task.FromResult(false);
            dropped.Add(candidate.Id);
            server.Remove(candidate.Id);
            return Task.FromResult(true);
        }
        var key = "scan-check\n" + Guid.NewGuid();
        var notices = new List<string?>();
        for (var pass = 0; pass < 6 && server.Keys.Any(id => id > 23); pass++)
            notices.Add(ActualPlanRecovery.ScanAsync(key, Select, Drop).GetAwaiter().GetResult());
        check(!server.Keys.Any(id => id > 23) && dropped.Order().SequenceEqual(Enumerable.Range(24, 19)),
            "bounded recovery passes reach every orphan behind refused and failing definitions: left " + string.Join(",", server.Keys.Where(id => id > 23)));
        check(Enumerable.Range(1, 23).All(server.ContainsKey), "rotated recovery never drops a refused definition, and keeps one it failed to drop");
        check(notices.Count > 1 && notices.All(notice => notice == ActualPlanRecovery.Notice), "a pass that defers or fails a drop reports the notice");

        // Once only refused definitions remain beyond the limit, passes keep wrapping without dropping anything.
        var quiet = new SortedDictionary<int, ActualPlanRecovery.Candidate>();
        for (var id = 1; id <= 3; id++) quiet[id] = Make(id, false);
        var none = ActualPlanRecovery.ScanAsync("scan-check\n" + Guid.NewGuid(), after => Task.FromResult(quiet.Values.Where(c => c.Id > after).ToList()),
            (_, _, _) => { check(false, "a refused definition is never dropped"); return Task.FromResult(true); }).GetAwaiter().GetResult();
        check(none is null, "a pass that examined every candidate and dropped none needs no notice");
        var (examine, next) = ActualPlanRecovery.Window([.. Enumerable.Range(5, 17).Select(id => Make(id, true))]);
        check(examine.Length == ActualPlanSql.RecoveryLimit && next == 20 && ActualPlanRecovery.Window([Make(9, true)]).Next == 0,
            "the next scan resumes after the last examined definition, or starts over once all were examined");
    }

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var host = (ILiveHost)service;
        if (host.Profile(info.Id) is not { Major: >= 14, EngineEdition: not 5 }) return;
        using var budget = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        var token = budget.Token;
        SqlConnection Connection(bool mars = false)
        {
            using var pool = host.PoolConnection(info.Id, "master", " - Collector Tests");
            return new(new SqlConnectionStringBuilder(pool.ConnectionString) { Pooling = false, ConnectRetryCount = 0, MultipleActiveResultSets = mars }.ConnectionString);
        }
        async Task<SqlConnection> Open(bool mars = false)
        {
            var connection = Connection(mars);
            try { await host.OpenAsync(connection, token); return connection; }
            catch { await connection.DisposeAsync(); throw; }
        }
        await using var control = await Open();
        var created = new HashSet<string>(StringComparer.Ordinal);
        async Task<object?> Scalar(string sql, string name)
        {
            await using var command = control.CreateCommand();
            command.CommandTimeout = 5;
            command.CommandText = sql;
            command.Parameters.Add("@name", SqlDbType.NVarChar, 128).Value = name;
            return await command.ExecuteScalarAsync(token);
        }
        async Task<bool> Exists(string name) => await Scalar("SELECT COUNT(*) FROM sys.server_event_sessions WHERE name=@name;", name) is 1;
        // A collector definition with production DDL (no MAX_DURATION) for a session that does not exist, optionally stopped.
        async Task Define(string name, Guid client, bool stop)
        {
            created.Add(name);
            await using (var command = control.CreateCommand())
            {
                command.CommandTimeout = 5;
                command.CommandText = ActualPlanSql.Create(false, false);
                command.Parameters.Add("@name", SqlDbType.NVarChar, 128).Value = name;
                command.Parameters.Add("@spid", SqlDbType.Int).Value = 32767;
                command.Parameters.Add("@client", SqlDbType.UniqueIdentifier).Value = client;
                await command.ExecuteNonQueryAsync(token);
            }
            if (stop) await Scalar("DECLARE @sql nvarchar(max)=N'ALTER EVENT SESSION '+QUOTENAME(@name)+N' ON SERVER STATE=STOP;'; EXEC sys.sp_executesql @sql;", name);
        }
        async Task<int> Spid(SqlConnection connection)
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT @@SPID;";
            return Convert.ToInt32(await command.ExecuteScalarAsync(token));
        }
        async Task<Guid> ServerId(SqlConnection connection)
        {
            await using var command = connection.CreateCommand();
            command.CommandText = "SELECT connection_id FROM sys.dm_exec_connections WHERE session_id=@@SPID AND parent_connection_id IS NULL;";
            return (Guid)(await command.ExecuteScalarAsync(token))!;
        }
        async Task<(ActualPlanCapture Capture, string Name, SqlConnection Target, SqlConnection Owner)> Collector(int major, bool mars = false)
        {
            var target = await Open(mars);
            SqlConnection? observer = null;
            try
            {
                observer = await Open(mars);
                var targetId = await ServerId(target);
                var name = ActualPlanRecovery.Name(target.ClientConnectionId, targetId, await ServerId(observer));
                created.Add(name);
                // The exact-name recovery scope keeps these tests from modifying pre-existing collectors on a shared server.
                var capture = new ActualPlanCapture(observer, false, name);
                var notice = await capture.StartAsync(await Spid(target), target.ClientConnectionId, major, 30, token);
                check(capture.Started && (notice is null or ActualPlanRecovery.Notice), "isolated collector starts even when bounded recovery defers: " + (notice ?? "ok"));
                return (capture, name, target, observer);
            }
            catch
            {
                await target.DisposeAsync();
                if (observer is not null) await observer.DisposeAsync();
                throw;
            }
        }
        async Task Recover(string name)
        {
            // A shared server can legitimately exhaust the one-second optional slice. Retry that reported deferral,
            // with an overall test budget, rather than treating a slow scheduler as a capture/ownership failure.
            for (var attempt = 0; attempt < 3; attempt++)
            {
                var notice = await ActualPlanRecovery.RecoverAsync(control, token, name);
                if (notice is null) return;
                check(notice == ActualPlanRecovery.Notice, "a deferred recovery has the bounded notice");
            }
            check(false, "isolated recovery completes within three bounded attempts");
        }
        async Task RecheckActive(string name)
        {
            ActualPlanRecovery.Candidate value;
            await using (var command = control.CreateCommand())
            {
                command.CommandText = """
                    SELECT s.event_session_id,s.name,b.predicate_xml,p.predicate_xml,b.predicate,p.predicate FROM sys.server_event_sessions s
                    JOIN sys.server_event_session_events b ON b.event_session_id=s.event_session_id AND b.name=N'sql_batch_starting'
                    JOIN sys.server_event_session_events p ON p.event_session_id=s.event_session_id AND p.name=N'query_post_execution_plan_profile' WHERE s.name=@name;
                    """;
                command.Parameters.Add("@name", SqlDbType.NVarChar, 128).Value = name;
                await using var reader = await command.ExecuteReaderAsync(token);
                check(await reader.ReadAsync(token), "active fixture definition is available");
                value = new(reader.GetInt32(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetString(4), reader.GetString(5));
            }
            check(ActualPlanRecovery.Owns(value, out var target, out var owner), "active fixture owns both server connection IDs");
            await using var drop = control.CreateCommand();
            drop.CommandText = ActualPlanSql.DropAbandoned;
            drop.Parameters.Add("@id", SqlDbType.Int).Value = value.Id;
            drop.Parameters.Add("@name", SqlDbType.NVarChar, 128).Value = value.Name;
            drop.Parameters.Add("@batch", SqlDbType.NVarChar, 3000).Value = value.Batch;
            drop.Parameters.Add("@plan", SqlDbType.NVarChar, 3000).Value = value.Plan;
            drop.Parameters.Add("@target", SqlDbType.UniqueIdentifier).Value = target;
            drop.Parameters.Add("@owner", SqlDbType.UniqueIdentifier).Value = owner;
            await drop.ExecuteNonQueryAsync(token);
            check(await Exists(name), "the final DROP independently rechecks liveness even if candidate enumeration were stale");
        }
        async Task Gone(string name)
        {
            var until = DateTime.UtcNow.AddSeconds(5);
            while (true)
            {
                await using var command = control.CreateCommand();
                command.CommandTimeout = 3;
                command.CommandText = "SELECT COUNT(*) FROM sys.dm_exec_connections WHERE connection_id IN (@client,@owner) OR parent_connection_id IN (@client,@owner);";
                command.Parameters.Add("@client", SqlDbType.UniqueIdentifier).Value = Guid.ParseExact(name.Substring(45,32), "N");
                command.Parameters.Add("@owner", SqlDbType.UniqueIdentifier).Value = Guid.ParseExact(name.Substring(78,32), "N");
                if (await command.ExecuteScalarAsync(token) is 0) break;
                check(DateTime.UtcNow < until, "test-created physical connections disappear from SQL Server after unpooled close");
                await Task.Delay(25, token);
            }
            await using var candidate = control.CreateCommand();
            candidate.CommandText = ActualPlanSql.Candidates;
            candidate.Parameters.Add("@only", SqlDbType.NVarChar, 128).Value = name;
            candidate.Parameters.Add("@after", SqlDbType.Int).Value = 0;
            await using var reader = await candidate.ExecuteReaderAsync(token);
            check(await reader.ReadAsync(token), "abandoned test collector passes SQL ownership-shape/liveness filter");
            var value = new ActualPlanRecovery.Candidate(reader.GetInt32(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetString(4), reader.GetString(5), reader.GetBoolean(6));
            check(!value.Legacy && ActualPlanRecovery.Owns(value, out _, out _), "real predicate XML proves ownership: " + value.BatchXml + " | " + value.PlanXml);
        }
        try
        {
            var hostile = "VariaQuote_" + Guid.NewGuid().ToString("N") + "]'; SELECT 1;--";
            created.Add(hostile);
            await using (var quoted = control.CreateCommand())
            {
                quoted.CommandTimeout = 5;
                quoted.CommandText = ActualPlanSql.Create(false, false);
                quoted.Parameters.Add("@name", SqlDbType.NVarChar, 128).Value = hostile;
                quoted.Parameters.Add("@spid", SqlDbType.Int).Value = 32767;
                quoted.Parameters.Add("@client", SqlDbType.UniqueIdentifier).Value = Guid.NewGuid();
                await quoted.ExecuteNonQueryAsync(token);
            }
            check(await Exists(hostile), "parameterized collector creation quotes bracket, literal and comment characters as one identifier");
            await Scalar(ActualPlanSql.Drop(false), hostile);
            check(!await Exists(hostile), "parameterized collector cleanup drops precisely the quoted hostile identifier");
            // Render the pre-2025 path on the real server: no MAX_DURATION can conceal a missing recovery implementation.
            foreach (var mars in new[] { false, true })
            {
                var active = await Collector(16, mars);
                await using var target = active.Target;
                await using var owner = active.Owner;
                try
                {
                    await Recover(active.Name);
                    check(await Exists(active.Name), "an idle active collector is not abandoned");
                    await RecheckActive(active.Name);
                    await target.CloseAsync();
                    await Recover(active.Name);
                    check(await Exists(active.Name), "a live observer protects final collection even after the query connection closes");
                    await RecheckActive(active.Name);
                    await owner.CloseAsync(); // Stand in for backend/application death: intentionally skip CloseAsync on the capture.
                    await Gone(active.Name);
                    await Recover(active.Name);
                    check(!await Exists(active.Name), "abandoned pre-MAX_DURATION collector is removed once both connections disappear");
                }
                finally { await active.Capture.CloseAsync(token); }
            }

            var ownerLost = await Collector(16);
            await using var survivingTarget = ownerLost.Target;
            await using var lostOwner = ownerLost.Owner;
            try
            {
                await lostOwner.CloseAsync();
                await Recover(ownerLost.Name);
                check(await Exists(ownerLost.Name), "a live query connection protects capture after observer failure");
                await survivingTarget.CloseAsync();
                await Gone(ownerLost.Name);
                // The next StartAsync uses precisely the same recovery entry point as toolbar Actual/Live capture.
                await using var nextTarget = await Open();
                await using var nextOwner = await Open();
                var nextId = await ServerId(nextTarget);
                var nextName = ActualPlanRecovery.Name(nextTarget.ClientConnectionId, nextId, await ServerId(nextOwner));
                created.Add(nextName);
                var next = new ActualPlanCapture(nextOwner, false, ownerLost.Name);
                try
                {
                    var notice = await next.StartAsync(await Spid(nextTarget), nextTarget.ClientConnectionId, 16, 30, token);
                    if (notice == ActualPlanRecovery.Notice) await Recover(ownerLost.Name);
                    check((notice is null or ActualPlanRecovery.Notice) && next.Started
                        && !await Exists(ownerLost.Name), "next capture recovers an abandoned collector before starting its own");
                    check(await next.CloseAsync(token) is null && !await Exists(nextName), "normal capture cleanup removes its own definition");
                }
                finally { await next.CloseAsync(token); }
            }
            finally { await ownerLost.Capture.CloseAsync(token); }

            var modified = await Collector(16);
            await using var modifiedTarget = modified.Target;
            await using var modifiedOwner = modified.Owner;
            await modifiedTarget.CloseAsync();
            await modifiedOwner.CloseAsync();
            await Scalar("DECLARE @sql nvarchar(max)=N'ALTER EVENT SESSION '+QUOTENAME(@name)+N' ON SERVER DROP EVENT sqlserver.sql_batch_starting;'; EXEC sys.sp_executesql @sql;", modified.Name);
            await Recover(modified.Name);
            check(await Exists(modified.Name), "recovery leaves a modified collector definition alone even with matching ownership-shaped name");

            // #233: a single-GUID collector from an earlier build stays while it runs (less than a day) and goes once stopped.
            var legacy = "VariaActual_" + Guid.NewGuid().ToString("N");
            await Define(legacy, Guid.NewGuid(), stop: false);
            await Recover(legacy);
            check(await Exists(legacy), "a running legacy collector created less than a day ago is kept");
            await Scalar("DECLARE @sql nvarchar(max)=N'ALTER EVENT SESSION '+QUOTENAME(@name)+N' ON SERVER STATE=STOP;'; EXEC sys.sp_executesql @sql;", legacy);
            await Recover(legacy);
            check(!await Exists(legacy), "a stopped legacy collector is removed");

            // #258: sixteen definitions recovery refuses (their predicates name another client) ahead of a real orphan,
            // all under one random prefix. Bounded passes must still reach the orphan and leave the refused ones.
            var client = Guid.NewGuid();
            string Under() => ActualPlanRecovery.Name(client, Guid.NewGuid(), Guid.NewGuid());
            var prefix = Under()[..44];
            var refused = Enumerable.Range(0, ActualPlanSql.RecoveryLimit).Select(_ => Under()).ToList();
            foreach (var name in refused) await Define(name, Guid.NewGuid(), stop: true);
            var orphan = Under();
            await Define(orphan, client, stop: true);
            var passes = 0;
            for (; passes < 4 && await Exists(orphan); passes++) await ActualPlanRecovery.RecoverAsync(control, token, prefix);
            check(!await Exists(orphan), "recovery reaches an orphan behind sixteen refused definitions within bounded passes: " + passes);
            var kept = 0;
            foreach (var name in refused) if (await Exists(name)) kept++;
            check(kept == refused.Count, "rotated recovery leaves every refused definition: " + kept);

            // Failure to inspect connection state must not be interpreted as proof that every owner is dead.
            await using var denied = await Open();
            await using (var command = denied.CreateCommand())
            {
                command.CommandText = "EXECUTE AS USER='guest';";
                await command.ExecuteNonQueryAsync(token);
            }
            check(await ActualPlanRecovery.RecoverAsync(denied, token, modified.Name) == ActualPlanRecovery.Notice && await Exists(modified.Name),
                "recovery permission failure reports a notice and preserves uncertain collectors");
            var deniedCapture = new ActualPlanCapture(denied, false, modified.Name);
            check(await deniedCapture.StartAsync(await Spid(control), control.ClientConnectionId, 16, 30, token) is { } unavailable
                && unavailable.Contains("permission") && !deniedCapture.Started, "permission preflight still precedes recovery and creation");

            using var cancelled = new CancellationTokenSource();
            cancelled.Cancel();
            try { await ActualPlanRecovery.RecoverAsync(control, cancelled.Token, modified.Name); check(false, "cancelled recovery"); }
            catch (OperationCanceledException) { check(await Exists(modified.Name), "setup cancellation preserves collectors without executing cleanup"); }

            // A failed optional observer must leave the ordinary execution/session and Client Statistics available.
            var tab = Guid.NewGuid().ToString();
            var open = service.Open;
            var opens = 0;
            service.Open = async (connection, cancellation) =>
            {
                await open(connection, cancellation);
                if (Interlocked.Increment(ref opens) == 2)
                {
                    await using var command = connection.CreateCommand();
                    command.CommandText = "EXECUTE AS USER='guest';";
                    await command.ExecuteNonQueryAsync(cancellation);
                }
            };
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(new QueryArgs(info.Id, tab, "master",
                    "SELECT 42 AS available;", Guid.NewGuid().ToString(), 10, 10, IncludeActualPlan: true, IncludeClientStatistics: true), json), json);
                check(result.Status == "completed" && result.PlanSets is null && result.ResultSets is [{ RowsStored: 1 } set]
                    && LiveResultChecks.RowsOf(service.Results, set)[0][0] == "42" && result.ClientStatistics is not null
                    && result.Messages.Any(m => m.Text.Contains("permission")), "denied optional capture preserves ordinary rows, execution availability and statistics");
            }
            finally
            {
                service.Open = open;
                await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(tab), json), json);
            }
        }
        finally
        {
            // Fresh teardown budget: cleanup must still run after a failed/cancelled check. Drop only exact test-created names.
            using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            foreach (var name in created)
            {
                await using var command = control.CreateCommand();
                command.CommandTimeout = 3;
                command.CommandText = "IF EXISTS(SELECT 1 FROM sys.server_event_sessions WHERE name=@name) BEGIN " + ActualPlanSql.Drop(false) + " END;";
                command.Parameters.Add("@name", SqlDbType.NVarChar, 128).Value = name;
                await command.ExecuteNonQueryAsync(cleanup.Token);
            }
        }
    }
}
