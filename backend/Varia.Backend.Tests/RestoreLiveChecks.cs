using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.SqlServer.Management.Common;
using Microsoft.SqlServer.Management.Smo;
using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live Restore Database checks (D1e): the describe's server facts and a missing device as a value; with
/// VARIA_TEST_SQL_SCRATCH=1, a marked scratch source in FULL recovery with a full backup striped across two files, two logs in one
/// file, a differential and a third log, all in real files in the backup folder (deleted in finally, then the history). Its sets as
/// msdb's history and as the media's headers read them, a missing stripe, each set's files, and SMO's DatabaseRestorePlanner on
/// the same history: the sets it chooses for the last backup and three points in time are the ones tests/fixtures/restore/
/// smo-plans.json records for the TypeScript planner (VARIA_UPDATE_RESTORE_FIXTURES=1 rewrites it), and its Script() is
/// actions.script's text for five option sets, a hostile destination name and paths among them. Each of the planner's plans is
/// restored under a scratch name (and dropped) to prove it reaches its point. A second source is restored in place to a point
/// inside a log backup, which forks its log: tests/fixtures/restore/smo-fork.json records its history, SMO's plans and the
/// planner's, which restore with every row where the abandoned branch's plan fails.</summary>
internal static class RestoreLiveChecks
{
    private const string FixturePath = "tests/fixtures/restore/smo-plans.json";
    private const string ForkPath = "tests/fixtures/restore/smo-fork.json";

    /// <summary>The sets the TypeScript planner restores for a goal: SMO's, but between log2 and the differential, where SMO's plan
    /// restores the differential taken after the point (the check below restores both), the logs that reach it.</summary>
    private static IReadOnlyList<string> Varia(string goal, IReadOnlyList<string> smo) => goal == "between log2 and the differential" ? ["full", "log1", "log2", "log3"] : smo;

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        async Task<SqlRun> Sql(string text, string database = "master")
        {
            var id = Guid.NewGuid().ToString();
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(info.Id, id, database, text, Guid.NewGuid().ToString(), 1000, 120, StopOnError: true), json), json);
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(id), json), json); }
        }
        async Task<ActionDescribeResult> Describe(RestoreSourceDto source) => (ActionDescribeResult)await service.DispatchAsync("actions.describe", JsonSerializer.SerializeToElement(
            new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "restoreDatabase", new ObjectRefDto("server"), null, source), json), json);
        async Task<ActionScriptResult> Script(string database, RestoreOptionsDto options, DatabaseIdentityDto? identity) => (ActionScriptResult)await service.DispatchAsync("actions.script",
            JsonSerializer.SerializeToElement(new ActionArgs("restore", info.Id, Guid.NewGuid().ToString(), new ObjectRefDto("database", Name: database), Identity: identity, Restore: options), json), json);
        static string Show(ActionDescribeResult result) => result.Error is { } error ? error.Code + " " + error.Message
            : result.Restore is { } model ? (model.Sets?.Count ?? 0) + " sets, " + (model.Files?.Count ?? 0) + " files, " + (model.HistoryDatabases?.Count ?? 0) + " databases" : "nothing";

        var facts = (await Sql("SELECT CONVERT(nvarchar(1), SERVERPROPERTY('PathSeparator')), CONVERT(int, ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0)), "
            + "COALESCE(CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultBackupPath')), CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultDataPath')));")).Sets[0][0];
        var separator = facts[0] ?? "\\";
        var sysadmin = facts[1] == "1";
        var backupFolder = (facts[2] ?? "").TrimEnd(separator[0]) + separator;

        // Without a database: the server's facts and msdb's databases; SQL Server's own master and tempdb are never destinations.
        var server = await Describe(new("history"));
        check(server is { Error: null, Restore: { Server: { } facts1, HistoryDatabases: { } } } && facts1.Separator == separator && (!sysadmin || facts1.CanRestore)
            && !facts1.Destinations.Any(d => d.Name is "master" or "tempdb") && facts1.Destinations.Any(d => d.Name == "model" && d.Created.Length == 23)
            && facts1.Files.Any(file => file.Database == "master") && facts1.BackupPath is { } path && path.EndsWith(separator, StringComparison.Ordinal),
            "Restore Database's describe reads the server's separator, folders, whether the login may restore, the destinations but master and tempdb, and every database's files: " + Show(server));
        var missing = await Describe(new("devices", Devices: [backupFolder + "VariaRestoreMissing_" + Guid.NewGuid().ToString("N") + ".bak"]));
        var noSet = await Describe(new("historyFiles", SetId: Guid.NewGuid().ToString("D")));
        check(missing is { Error.Code: "PATH_NOT_FOUND", Restore: null } && noSet is { Error: null, Restore.Files: [] },
            "a backup file that does not exist is PATH_NOT_FOUND as a value, and an unknown history set has no files: " + Show(missing));

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Restore Database scratch checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named database and its backup files on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        var folder = await scratch.CreateRestoreSourceAsync();
        var db = scratch.RestoreSource;
        var (full1, full2, log, diff, log3) = (scratch.RestoreFile("full1.bak"), scratch.RestoreFile("full2.bak"), scratch.RestoreFile("log.trn"), scratch.RestoreFile("diff.bak"), scratch.RestoreFile("log3.trn"));
        static string Q(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
        var b = "[" + db + "]";
        async Task Step(string text, string database = "master")
        {
            var result = await Sql(text, database);
            if (result.Status != "completed") throw new InvalidOperationException("Restore source setup failed: " + result.Error);
        }
        // Two seconds between the backups a point in time falls between, so whole-second points land strictly inside.
        await Step("CREATE TABLE dbo.t (i int IDENTITY, at datetime2 DEFAULT SYSDATETIME()); INSERT dbo.t DEFAULT VALUES;", db);
        await Step("BACKUP DATABASE " + b + " TO DISK = " + Q(full1) + ", DISK = " + Q(full2) + " WITH FORMAT, INIT, NAME = N'full';");
        await Step("INSERT dbo.t DEFAULT VALUES;", db);
        await Step("BACKUP LOG " + b + " TO DISK = " + Q(log) + " WITH FORMAT, INIT, NAME = N'log1';");
        await Step("WAITFOR DELAY '00:00:02.2'; INSERT dbo.t DEFAULT VALUES;", db);
        await Step("BACKUP LOG " + b + " TO DISK = " + Q(log) + " WITH NOINIT, NAME = N'log2';");
        await Step("WAITFOR DELAY '00:00:02.2'; INSERT dbo.t DEFAULT VALUES;", db);
        await Step("BACKUP DATABASE " + b + " TO DISK = " + Q(diff) + " WITH DIFFERENTIAL, FORMAT, INIT, NAME = N'diff';");
        await Step("WAITFOR DELAY '00:00:02.2'; INSERT dbo.t DEFAULT VALUES;", db);
        await Step("BACKUP LOG " + b + " TO DISK = " + Q(log3) + " WITH FORMAT, INIT, NAME = N'log3';");

        // msdb's history: newest first, the full's two stripes in family order, both logs in one file at positions 1 and 2.
        var history = await Describe(new("history", db));
        var sets = history.Restore?.Sets ?? [];
        BackupSetDto? Named(IEnumerable<BackupSetDto> list, string name) => list.FirstOrDefault(set => set.Name == name);
        var (full, l1, l2, dif, l3) = (Named(sets, "full"), Named(sets, "log1"), Named(sets, "log2"), Named(sets, "diff"), Named(sets, "log3"));
        var destination = history.Restore?.Server?.Destinations.FirstOrDefault(d => d.Name == db);
        check(history is { Error: null, Restore: { HistoryDatabases: { } names, SetsTruncated: false } } && names.Contains(db) && sets.Select(set => set.Name).SequenceEqual(["log3", "diff", "log2", "log1", "full"])
            && full is { Type: "full", Position: 1, Problem: null } && full.Devices.SequenceEqual([full1, full2]) && full.Database == db && full.RecoveryModel == "FULL" && full.SizeBytes > 0
            && l1 is { Type: "log", Position: 1 } && l1.Devices.SequenceEqual([log]) && l2 is { Type: "log", Position: 2 } && dif is { Type: "differential" } && l3 is { Type: "log", Position: 1 }
            && dif.DatabaseBackupLsn == full.CheckpointLsn && l1.FirstLsn == full.FirstLsn && l2.FirstLsn == l1.LastLsn && sets.All(set => set.Id.Length == 36 && set.Finish.Length == 19 && !set.CopyOnly && !set.Damaged)
            && destination is { State: "ONLINE", RecoveryModel: "FULL" } && history.Restore!.Server!.Files.Any(file => file.Database == db),
            "msdb's history lists the source's five sets newest first, with the striped full's files in family order, both logs of one file at their positions, the differential based on the full, and the source as a destination: " + Show(history));

        // The media's headers: LABELONLY groups the files into media sets in the order given, HEADERONLY lists each one's sets.
        var media = await Describe(new("devices", Devices: [log, full2, full1, diff, log3]));
        var read = media.Restore?.Sets ?? [];
        bool Same(BackupSetDto? a, BackupSetDto? h) => a is not null && h is not null && a.Type == h.Type && a.FirstLsn == h.FirstLsn && a.LastLsn == h.LastLsn && a.CheckpointLsn == h.CheckpointLsn
            && a.DatabaseBackupLsn == h.DatabaseBackupLsn && a.Finish == h.Finish && a.Position == h.Position && a.Database == h.Database && a.Devices.SequenceEqual(h.Devices);
        check(media is { Error: null, Restore.SetsTruncated: false } && read.Select(set => set.Id).SequenceEqual(["1:1", "1:2", "2:1", "3:1", "4:1"])
            && Same(Named(read, "log1"), l1) && Same(Named(read, "log2"), l2) && Same(Named(read, "full"), full) && Same(Named(read, "diff"), dif) && Same(Named(read, "log3"), l3),
            "the backup files' headers give the same five sets as msdb, grouped by media set in the order the files were added, a striped set's files in family order: " + Show(media));
        var stripe = await Describe(new("devices", Devices: [full2]));
        check(stripe.Error is null && stripe.Restore?.Sets is { } partial && partial.All(set => set.Problem == RestoreDescribe.Striped(2)),
            "a striped set with a file missing is passed over, its rows (where SQL Server reads them) marked to add the missing files: " + Show(stripe));
        var mediaFiles = await Describe(new("mediaFiles", Devices: [full1, full2], File: 1));
        var historyFiles = await Describe(new("historyFiles", SetId: full!.Id));
        check(mediaFiles.Restore?.Files is [{ Type: "data" } data, { Type: "log" } logFile] && data.Logical == db && logFile.Logical == db + "_log" && data.Filegroup == "PRIMARY" && data.SizeBytes > 0
            && historyFiles.Restore?.Files is { } recorded && recorded.Select(file => (file.Logical, file.Type, file.Physical)).SequenceEqual(mediaFiles.Restore.Files.Select(file => (file.Logical, file.Type, file.Physical))),
            "a set's files come from FILELISTONLY on its media and, the same, from msdb's record of them: " + Show(mediaFiles) + " | " + Show(historyFiles));

        // SMO's planner on the same history, as SSMS's dialog drives it (probed), and actions.script's text for its plans.
        await using var connection = ((IActionHost)service).Connection(info.Id);
        await ((IActionHost)service).OpenAsync(connection, CancellationToken.None);
        var smo = new Server(new ServerConnection(connection) { AutoDisconnectMode = AutoDisconnectMode.NoAutoDisconnect });
        string Point(string finish) => DateTime.ParseExact(finish, "yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture).AddSeconds(1).ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture);
        var goals = new (string Name, string? StopAt)[] { ("last backup", null), ("between log1 and log2", Point(l1!.Finish)), ("between log2 and the differential", Point(l2!.Finish)), ("between the differential and log3", Point(dif!.Finish)) };
        RestorePlan Plan(string? stopAt, Microsoft.SqlServer.Management.Smo.RestoreOptions options, string? tail = null)
        {
            var planner = new DatabaseRestorePlanner(smo, db) { ReadHeaderFromMedia = false, RestoreToLastBackup = stopAt is null, BackupTailLog = tail is not null };
            if (stopAt is not null) planner.RestoreToPointInTime = DateTime.ParseExact(stopAt, "yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture);
            if (tail is not null) { planner.TailLogWithNoRecovery = true; planner.TailLogBackupFile = tail; }
            return planner.CreateRestorePlan(options);
        }
        Microsoft.SqlServer.Management.Smo.RestoreOptions Recovery() => new() { RecoveryState = DatabaseRecoveryState.WithRecovery, PercentCompleteNotification = 5 };
        var byId = sets.ToDictionary(set => set.Id, StringComparer.OrdinalIgnoreCase);
        var chosen = goals.Select(goal => (goal.Name, goal.StopAt, Names: Plan(goal.StopAt, Recovery()).RestoreOperations.Select(op => byId.TryGetValue(op.BackupSet.BackupSetGuid.ToString("D"), out var set) ? set.Name : "?").ToList())).ToList();
        check(chosen[0].Names.SequenceEqual(["full", "diff", "log3"]) && chosen[1].Names.SequenceEqual(["full", "log1", "log2"]),
            "SMO restores the last backup from the full, the differential and the log after it, and a point between two logs from the full and both logs: " + string.Join(" | ", chosen.Select(item => item.Name + ": " + string.Join(",", item.Names))));
        var fixturePath = Fixtures.Path(FixturePath);
        var shift = new DateTime(2026, 1, 1) - DateTime.ParseExact(full.Start, "yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture).Date;
        var scrubbed = Scrub(sets, read, db, folder, separator, shift);
        var plans = new JsonArray([.. chosen.Select((item, index) => (JsonNode)new JsonObject
        {
            ["goal"] = item.Name,
            ["stopAt"] = item.StopAt is null ? null : Shift(item.StopAt, shift),
            ["names"] = new JsonArray([.. item.Names.Select(name => (JsonNode)JsonValue.Create(name))]),
            ["varia"] = new JsonArray([.. Varia(item.Name, item.Names).Select(name => (JsonNode)JsonValue.Create(name))])
        })]);
        if (Environment.GetEnvironmentVariable("VARIA_UPDATE_RESTORE_FIXTURES") == "1")
        {
            var fixture = new JsonObject { ["source"] = "SMO DatabaseRestorePlanner over a live history (RestoreLiveChecks); names, servers, users and paths replaced, times moved by whole days to 2026-01-01", ["history"] = scrubbed.History, ["media"] = scrubbed.Media, ["plans"] = plans };
            Directory.CreateDirectory(Path.GetDirectoryName(fixturePath)!);
            File.WriteAllText(fixturePath, fixture.ToJsonString(new JsonSerializerOptions { WriteIndented = true }).Replace("\r\n", "\n", StringComparison.Ordinal) + "\n");
            Console.WriteLine("Rewrote " + FixturePath + ".");
        }
        var recordedPlans = JsonNode.Parse(File.ReadAllText(fixturePath))?["plans"]?.AsArray();
        check(recordedPlans is not null && recordedPlans.Count == plans.Count && recordedPlans.Zip(plans).All(pair => pair.First!["goal"]!.GetValue<string>() == pair.Second!["goal"]!.GetValue<string>()
                && pair.First["names"]!.AsArray().Select(name => name!.GetValue<string>()).SequenceEqual(pair.Second["names"]!.AsArray().Select(name => name!.GetValue<string>()))),
            "the plans " + FixturePath + " records for the TypeScript planner are the sets SMO chooses on this server for the last backup and each point in time");

        // Each of the TypeScript planner's plans restored for real under a scratch name reaches exactly its point: the rows inserted
        // by then, no more. Between log2 and the differential SMO restores the differential, taken after the point, which no STOPAT
        // can undo; the planner restores the logs instead (its plan differs from SMO's only there).
        var target = scratch.RestoreTarget;
        scratch.Adopt(target);
        var restoreFacts = history.Restore!.Server!;
        var relocated = new List<RestoreMoveDto> { new(db, (restoreFacts.DataPath ?? folder) + target + ".mdf"), new(db + "_log", (restoreFacts.LogPath ?? folder) + target + "_log.ldf") };
        async Task<string> Restored(IEnumerable<string> statements)
        {
            var outcome = "";
            foreach (var text in statements)
            {
                var ran = await Sql(text);
                if (ran.Status != "completed") { outcome = ran.Error ?? ran.Status; break; }
            }
            if (outcome.Length == 0)
            {
                var rows = await Sql("SELECT COUNT(*) FROM dbo.t;", target);
                outcome = rows.Status == "completed" ? rows.Scalar + " rows" : rows.Error ?? rows.Status;
            }
            await Sql("IF DB_ID(" + Q(target) + ") IS NOT NULL DROP DATABASE [" + target + "];");
            return outcome;
        }
        var reached = new[] { "5 rows", "2 rows", "3 rows", "4 rows" };
        var outcomes = new List<string>();
        for (var index = 0; index < goals.Length; index++)
        {
            var planned = Varia(goals[index].Name, chosen[index].Names);
            var options = new RestoreOptionsDto([.. planned.Select(name => Named(sets, name) is { } set ? new RestorePlanSetDto(set.Id, [.. set.Devices], set.Position, set.Type, set.Name) : throw new InvalidOperationException("No set " + name))],
                relocated, false, false, false, "recovery", false, goals[index].StopAt);
            outcomes.Add(await Restored(RestoreSql.Statements(ActionsCatalog.Current.Restore, target, options, exists: false)));
        }
        var smoThird = Plan(goals[2].StopAt, Recovery());
        smoThird.DatabaseName = target;
        foreach (var op in smoThird.RestoreOperations)
        {
            op.Database = target;
            foreach (var move in relocated) op.RelocateFiles.Add(new RelocateFile(move.Logical, move.Physical));
        }
        var smoOutcome = await Restored(smoThird.Script().Cast<string>().Where(text => text != "USE [master]"));
        check(outcomes.SequenceEqual(reached) && smoOutcome != reached[2],
            "the planner's plans restore to the last backup and to each point exactly, where SMO's plan between log2 and the differential does not (" + smoOutcome + "): " + string.Join(", ", outcomes));

        // Script: SMO's RestorePlan.Script() for the same sets and options is actions.script's text, SET  SINGLE_USER and SET  MULTI_USER
        // as the shared templates space them (critic A12).
        RestorePlanSetDto Planned(string name) => Named(sets, name) is { } set ? new(set.Id, [.. set.Devices], set.Position, set.Type, set.Name) : throw new InvalidOperationException("No set " + name);
        var lastChain = new List<RestorePlanSetDto> { Planned("full"), Planned("diff"), Planned("log3") };
        var dataFolder = history.Restore!.Server!.DataPath ?? folder;
        var logFolder = history.Restore.Server.LogPath ?? folder;
        var hostile = db + "]'; -- x";
        var tailFile = backupFolder + db + "_LogBackup_2026-10-30_12-00-00.bak";
        var standby = backupFolder + db + "_RollbackUndo_2026-10-30_12-00-00.bak";
        var moves = new List<RestoreMoveDto> { new(db, dataFolder + "O'Brien ]" + db + ".mdf"), new(db + "_log", logFolder + "O'Brien ]" + db + "_log.ldf") };
        var identity = destination is null ? null : new DatabaseIdentityDto(destination.Id, destination.Created);
        RestorePlan Relocated()
        {
            var plan = Plan(null, Recovery());
            plan.DatabaseName = hostile;
            foreach (var op in plan.RestoreOperations)
            {
                op.Database = hostile;
                foreach (var move in moves) op.RelocateFiles.Add(new RelocateFile(move.Logical, move.Physical));
            }
            return plan;
        }
        var cases = new (string Name, Func<RestorePlan> Smo, string Database, RestoreOptionsDto Options, DatabaseIdentityDto? Identity)[]
        {
            ("over the source with a tail-log backup and closed connections", () =>
            {
                var plan = Plan(null, new() { ReplaceDatabase = true, RecoveryState = DatabaseRecoveryState.WithRecovery, PercentCompleteNotification = 5 }, tailFile);
                plan.CloseExistingConnections = true;
                return plan;
            }, db, new(lastChain, [], true, false, false, "recovery", true, TailLog: new(tailFile, true)), identity),
            ("a hostile new name with its files relocated", Relocated, hostile, new(lastChain, moves, false, false, false, "recovery", false), null),
            ("standby, keep replication and restricted access", () => Plan(null, new() { ReplaceDatabase = true, RecoveryState = DatabaseRecoveryState.WithStandBy, StandByFile = standby, KeepReplication = true, SetRestrictedUser = true, PercentCompleteNotification = 5 }),
                db, new(lastChain, [], true, true, true, "standby", false, StandbyFile: standby), identity),
            ("left restoring", () => Plan(null, new() { RecoveryState = DatabaseRecoveryState.WithNoRecovery, PercentCompleteNotification = 5 }), db, new(lastChain, [], false, false, false, "norecovery", false), identity),
            ("a point in time", () => Plan(goals[1].StopAt, Recovery()), db, new([Planned("full"), Planned("log1"), Planned("log2")], [], false, false, false, "recovery", false, goals[1].StopAt), identity)
        };
        var nl = Environment.NewLine;
        var differ = new List<string>();
        foreach (var item in cases)
        {
            var expected = item.Smo().Script().Cast<string>().Where(text => text != "USE [master]")
                .Select(text => text.Replace("] SET SINGLE_USER WITH ROLLBACK IMMEDIATE", "] SET  SINGLE_USER WITH ROLLBACK IMMEDIATE", StringComparison.Ordinal))
                .Select(text => text.EndsWith("] SET MULTI_USER", StringComparison.Ordinal) ? text[..^"SET MULTI_USER".Length] + "SET  MULTI_USER" : text).ToList();
            var scripted = await Script(item.Database, item.Options, item.Identity);
            var actual = scripted.Text is { } text && text.StartsWith("USE [master]" + nl, StringComparison.Ordinal) && text.EndsWith(nl + nl + "GO" + nl, StringComparison.Ordinal)
                ? text["USE [master]".Length..^("GO" + nl).Length].Split(nl, StringSplitOptions.RemoveEmptyEntries).ToList() : [];
            if (scripted.Error is not null || scripted.Database != "master" || !actual.SequenceEqual(expected))
                differ.Add(item.Name + ": " + (scripted.Error?.Message ?? string.Join(" / ", actual.Zip(expected).Where(pair => pair.First != pair.Second).Select(pair => pair.First + " <> " + pair.Second).Take(1).DefaultIfEmpty(actual.Count + " <> " + expected.Count))));
        }
        check(differ.Count == 0, "actions.script writes SMO's RestorePlan.Script() for the same sets and options (tail log and closed connections, a hostile relocated name, standby, norecovery, a point in time): " + string.Join(" | ", differ));

        // A fork: full, log1 and log2, then the database restored in place to a point inside log2 (rows 1 to 3 of 4), a row
        // inserted on the new fork and log3, which starts on the old fork and forks at the point. Times are whole seconds the
        // server read, a second clear of the rows around them.
        var forkDb = await scratch.CreateRestoreForkAsync();
        var fb = "[" + forkDb + "]";
        var (forkFull, forkLog1, forkLog2, forkLog3) = (scratch.RestoreFile("ffull.bak", forkDb), scratch.RestoreFile("flog1.trn", forkDb), scratch.RestoreFile("flog2.trn", forkDb), scratch.RestoreFile("flog3.trn", forkDb));
        async Task<string> Now() => (await Sql("WAITFOR DELAY '00:00:01.1'; SELECT CONVERT(nvarchar(19), SYSDATETIME(), 126);")).Sets[0][0][0] ?? throw new InvalidOperationException("No server time.");
        await Step("CREATE TABLE dbo.t (i int IDENTITY, at datetime2 DEFAULT SYSDATETIME()); INSERT dbo.t DEFAULT VALUES;", forkDb);
        await Step("BACKUP DATABASE " + fb + " TO DISK = " + Q(forkFull) + " WITH FORMAT, INIT, NAME = N'full';");
        await Step("INSERT dbo.t DEFAULT VALUES;", forkDb);
        await Step("BACKUP LOG " + fb + " TO DISK = " + Q(forkLog1) + " WITH FORMAT, INIT, NAME = N'log1';");
        await Step("WAITFOR DELAY '00:00:01.1'; INSERT dbo.t DEFAULT VALUES;", forkDb);
        var forkPoint = await Now();
        await Step("WAITFOR DELAY '00:00:01.1'; INSERT dbo.t DEFAULT VALUES;", forkDb);
        await Step("BACKUP LOG " + fb + " TO DISK = " + Q(forkLog2) + " WITH FORMAT, INIT, NAME = N'log2';");
        await Step("ALTER DATABASE " + fb + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\nRESTORE DATABASE " + fb + " FROM DISK = " + Q(forkFull) + " WITH REPLACE, NORECOVERY;\n"
            + "RESTORE LOG " + fb + " FROM DISK = " + Q(forkLog1) + " WITH NORECOVERY;\nRESTORE LOG " + fb + " FROM DISK = " + Q(forkLog2) + " WITH RECOVERY, STOPAT = " + Q(forkPoint) + ";\n"
            + "ALTER DATABASE " + fb + " SET MULTI_USER;");
        var afterRestore = await Now();
        await Step("WAITFOR DELAY '00:00:01.1'; INSERT dbo.t DEFAULT VALUES;", forkDb);
        await Step("BACKUP LOG " + fb + " TO DISK = " + Q(forkLog3) + " WITH FORMAT, INIT, NAME = N'log3';");
        var forkHistory = await Describe(new("history", forkDb));
        var forkSets = forkHistory.Restore?.Sets ?? [];
        var forkRead = (await Describe(new("devices", Devices: [forkFull, forkLog1, forkLog2, forkLog3]))).Restore?.Sets ?? [];
        var (ff, f1, f2, f3) = (Named(forkSets, "full"), Named(forkSets, "log1"), Named(forkSets, "log2"), Named(forkSets, "log3"));
        static decimal L(string text) => decimal.Parse(text, CultureInfo.InvariantCulture);
        var m3 = Named(forkRead, "log3");
        check(ff is not null && f1 is not null && f2 is not null && f3 is not null && f3.FirstForkGuid == f2.ForkGuid && f3.ForkGuid != f3.FirstForkGuid && f2.FirstForkGuid == f2.ForkGuid
            && f3.ForkPointLsn is { } forkLsn && L(forkLsn) > L(f2.FirstLsn) && L(forkLsn) < L(f2.LastLsn) && L(f3.FirstLsn) <= L(f1.LastLsn)
            && forkSets.All(set => set.FamilyGuid is { } family && family == ff.FamilyGuid) && m3 is not null && m3.ForkPointLsn == f3.ForkPointLsn && m3.FamilyGuid == f3.FamilyGuid
            && m3.FirstForkGuid == f3.FirstForkGuid && m3.ForkGuid == f3.ForkGuid,
            "after a restore to a point inside log2, msdb and the media's headers read log3 as starting on the old fork and forking inside log2 at its fork point, all of one family: "
            + string.Join(", ", forkSets.Select(set => set.Name + " " + set.FirstLsn + "-" + set.LastLsn + " fork " + set.ForkPointLsn)));

        var forkById = forkSets.ToDictionary(set => set.Id, StringComparer.OrdinalIgnoreCase);
        RestorePlan ForkPlan(string? stopAt)
        {
            var planner = new DatabaseRestorePlanner(smo, forkDb) { ReadHeaderFromMedia = false, RestoreToLastBackup = stopAt is null, BackupTailLog = false };
            if (stopAt is not null) planner.RestoreToPointInTime = DateTime.ParseExact(stopAt, "yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture);
            return planner.CreateRestorePlan(Recovery());
        }
        var forkGoals = new (string Name, string? StopAt)[] { ("last backup", null), ("after the restore", afterRestore) };
        var forkChosen = forkGoals.Select(goal => (goal.Name, goal.StopAt, Names: ForkPlan(goal.StopAt).RestoreOperations.Select(op => forkById.TryGetValue(op.BackupSet.BackupSetGuid.ToString("D"), out var set) ? set.Name : "?").ToList())).ToList();
        string[] forkVaria = ["full", "log1", "log3"];
        var forkPath = Fixtures.Path(ForkPath);
        var forkShift = new DateTime(2026, 1, 1) - DateTime.ParseExact(ff!.Start, "yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture).Date;
        var forkPlans = new JsonArray([.. forkChosen.Select(item => (JsonNode)new JsonObject
        {
            ["goal"] = item.Name,
            ["stopAt"] = item.StopAt is null ? null : Shift(item.StopAt, forkShift),
            ["names"] = new JsonArray([.. item.Names.Select(name => (JsonNode)JsonValue.Create(name))]),
            ["varia"] = new JsonArray([.. forkVaria.Select(name => (JsonNode)JsonValue.Create(name))])
        })]);
        if (Environment.GetEnvironmentVariable("VARIA_UPDATE_RESTORE_FIXTURES") == "1")
        {
            var scrubbedFork = Scrub(forkSets, forkRead, forkDb, folder, separator, forkShift);
            var fixture = new JsonObject { ["source"] = "SMO DatabaseRestorePlanner over a live history forked by a restore to a point in time (RestoreLiveChecks); names, servers, users and paths replaced, times moved by whole days to 2026-01-01", ["history"] = scrubbedFork.History, ["media"] = scrubbedFork.Media, ["plans"] = forkPlans };
            File.WriteAllText(forkPath, fixture.ToJsonString(new JsonSerializerOptions { WriteIndented = true }).Replace("\r\n", "\n", StringComparison.Ordinal) + "\n");
            Console.WriteLine("Rewrote " + ForkPath + ".");
        }
        var recordedFork = File.Exists(forkPath) ? JsonNode.Parse(File.ReadAllText(forkPath))?["plans"]?.AsArray() : null;
        check(forkChosen.All(item => item.Names.SequenceEqual(forkVaria)) && recordedFork is not null && recordedFork.Count == forkPlans.Count
            && recordedFork.Zip(forkPlans).All(pair => pair.First!["goal"]!.GetValue<string>() == pair.Second!["goal"]!.GetValue<string>()
                && pair.First["names"]!.AsArray().Select(name => name!.GetValue<string>()).SequenceEqual(pair.Second["names"]!.AsArray().Select(name => name!.GetValue<string>()))),
            "SMO's planner follows the new fork (full, log1, log3) for the last backup and a point after the restore, as " + ForkPath + " records for the TypeScript planner: "
            + string.Join(" | ", forkChosen.Select(item => item.Name + ": " + string.Join(",", item.Names))));

        // Restored under the scratch name: the planner's plan comes back ONLINE with every row (and the point's rows); the abandoned
        // branch's plan (log2, then log3) fails at a RESTORE LOG.
        var forkMoves = new List<RestoreMoveDto> { new(forkDb, (restoreFacts.DataPath ?? folder) + target + ".mdf"), new(forkDb + "_log", (restoreFacts.LogPath ?? folder) + target + "_log.ldf") };
        RestoreOptionsDto ForkOptions(IEnumerable<string> names, string? stopAt) => new([.. names.Select(name => Named(forkSets, name) is { } set ? new RestorePlanSetDto(set.Id, [.. set.Devices], set.Position, set.Type, set.Name) : throw new InvalidOperationException("No set " + name))],
            forkMoves, false, false, false, "recovery", false, stopAt);
        var forkOutcomes = new List<string>();
        foreach (var goal in forkGoals) forkOutcomes.Add(await Restored(RestoreSql.Statements(ActionsCatalog.Current.Restore, target, ForkOptions(forkVaria, goal.StopAt), exists: false)));
        var abandoned = await Restored(RestoreSql.Statements(ActionsCatalog.Current.Restore, target, ForkOptions(["full", "log1", "log2", "log3"], null), exists: false));
        check(forkOutcomes.SequenceEqual(["4 rows", "3 rows"]) && !abandoned.EndsWith(" rows", StringComparison.Ordinal),
            "the planner's plan over the fork restores every row, and to the point after the restore its rows, where the abandoned branch's plan fails (" + abandoned + "): " + string.Join(", ", forkOutcomes));
    }

    /// <summary>The history and media sets with this run's names, server, user, folders and times replaced, so the fixture holds
    /// nothing of the machine it was captured on; times move by a whole number of days, so their order and gaps stay.</summary>
    private static (JsonArray History, JsonArray Media) Scrub(IReadOnlyList<BackupSetDto> history, IReadOnlyList<BackupSetDto> media, string database, string folder, string separator, TimeSpan shift)
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };
        var prefix = folder.TrimEnd(separator[0]) + separator + database + "_";
        JsonArray Rows(IEnumerable<BackupSetDto> sets) => new([.. sets.Select(set => JsonSerializer.SerializeToNode(set with
        {
            Server = "SQLHOST", Database = "Sales", UserName = "CONTOSO\\dba", Start = Shift(set.Start, shift), Finish = Shift(set.Finish, shift), Expiration = set.Expiration is null ? null : Shift(set.Expiration, shift),
            Devices = [.. set.Devices.Select(device => device.StartsWith(prefix, StringComparison.Ordinal) ? "C:\\Backup\\Sales_" + device[prefix.Length..] : "C:\\Backup\\other.bak")]
        }, options))]);
        return (Rows(history), Rows(media));
    }

    /// <summary>Moves a capture's time by whole days, so the full backup's day is 2026-01-01 and the order and gaps stay.</summary>
    private static string Shift(string time, TimeSpan shift) => time.Length != 19 ? time
        : (DateTime.ParseExact(time, "yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture) + shift).ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture);
}
