using System.Text.Json;
using Microsoft.SqlServer.Management.Common;
using Microsoft.SqlServer.Management.Smo;
using Varia.Backend.Actions;

namespace Varia.Backend.Tests;

/// <summary>Live checks of Restore Files and Filegroups (D1g, spec D1 §11.1 check 5), with VARIA_TEST_SQL_SCRATCH=1 after Restore
/// Database's: a marked scratch database in FULL recovery with a filegroup and file named to break out of brackets, strings and
/// comments, and a second filegroup FG3; a full backup and a log backup in real files (deleted in finally, then the history).
/// Refusals before any statement (STANDBY online, SQL Server's 4302; a log file; a name the backup set lacks; a database that is not
/// the one read; a log backup file already there; a PRIMARY file or filegroup of the online database; a plan a later log backup is missing
/// from). A FILE restore through actions.execute, rolled forward through the log and ended
/// by Varia's copy-only log backup, comes back online with the rows written after the last log backup. A FILEGROUP (bound as a
/// variable) restored WITH NORECOVERY leaves its file restoring, which the reply names, until a tail-log backup restored WITH
/// RECOVERY brings it online. A log backup taken during a run stops it at Back up the log, naming that backup. Under SIMPLE a read-write filegroup's file is refused before anything (Learn's rule), and a read-only
/// filegroup restores.</summary>
internal static class RestoreFilesLiveChecks
{
    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, Func<string, string, Task<SqlRun>> sql, ScratchDatabase scratch)
    {
        var restore = ActionsCatalog.Current.Restore;
        const string group = "G2]'; -- x", file = "f2]'; /* x";
        await scratch.CreateRestoreFilesAsync(group, file);
        var db = scratch.RestoreFiles;
        static string Q(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
        static string B(string value) => "[" + value.Replace("]", "]]", StringComparison.Ordinal) + "]";
        async Task Step(string text, string database = "master")
        {
            var ran = await sql(text, database);
            if (ran.Status != "completed") throw new InvalidOperationException("Restore Files setup failed: " + ran.Error);
        }
        async Task<string?> Scalar(string text, string database = "master") => (await sql(text, database)).Scalar;
        Task<string?> Rows() => Scalar("SELECT CONVERT(nvarchar(20), COUNT(*)) FROM dbo.t;", db);
        Task<string?> FileState(string name) => Scalar("SELECT CONVERT(nvarchar(10), state) FROM sys.master_files WHERE database_id = DB_ID(" + Q(db) + ") AND name = " + Q(name) + ";");
        Task<string?> State() => Scalar("SELECT CONVERT(nvarchar(20), state) + N'/' + CONVERT(nvarchar(20), user_access) FROM sys.databases WHERE name = " + Q(db) + ";");
        async Task<ActionDescribeResult> Describe(RestoreSourceDto source) => (ActionDescribeResult)await service.DispatchAsync("actions.describe", JsonSerializer.SerializeToElement(
            new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "restoreDatabase", new ObjectRefDto("server"), null, source), json), json);
        async Task<DatabaseIdentityDto> Identity() => (await Describe(new("history"))).Restore?.Server?.Destinations.FirstOrDefault(destination => destination.Name == db) is { } found
            ? new(found.Id, found.Created) : throw new InvalidOperationException("No identity for the scratch database.");
        async Task<ActionExecuteResult> Wire(RestoreFilesOptionsDto options, DatabaseIdentityDto? identity = null) => (ActionExecuteResult)await service.DispatchAsync("actions.execute",
            JsonSerializer.SerializeToElement(new ActionArgs("restoreFiles", info.Id, Guid.NewGuid().ToString(), new ObjectRefDto("database", Name: db), Identity: identity ?? await Identity(), RestoreFiles: options), json), json);
        static RestoreFilesOptionsDto Options(List<RestorePlanSetDto> sets, List<string> files, List<string> groups, string recovery = "recovery", string? standby = null, RestoreLogBackupDto? backup = null) =>
            new(sets, files, groups, [], false, false, recovery, standby, backup);
        static string Show(ActionExecuteResult result) => (result.Error is { } error ? error.Code + " " + error.Message + " | " : "")
            + string.Join(", ", result.Steps.Select(step => step.Title + " " + step.Status))
            + (result.Restored is { } now ? " | " + now.State + "/" + now.UserAccess + (now.FilesRestoring is { } restoring ? " restoring " + string.Join(", ", restoring) : "") : "");

        // dbo.t on the hostile filegroup: a row in the full backup, one in the log backup, and one after it.
        await Step("CREATE TABLE dbo.t (i int IDENTITY) ON " + B(group) + "; INSERT dbo.t DEFAULT VALUES; CREATE TABLE dbo.u (i int) ON [FG3]; INSERT dbo.u VALUES (1);", db);
        var (fullFile, logFile) = (scratch.RestoreFile("full.bak", db), scratch.RestoreFile("log1.trn", db));
        await Step("BACKUP DATABASE " + B(db) + " TO DISK = " + Q(fullFile) + " WITH FORMAT, INIT, NAME = N'full';");
        await Step("INSERT dbo.t DEFAULT VALUES;", db);
        await Step("BACKUP LOG " + B(db) + " TO DISK = " + Q(logFile) + " WITH FORMAT, INIT, NAME = N'log1';");
        await Step("INSERT dbo.t DEFAULT VALUES;", db);
        var history = await Describe(new("history", db));
        RestorePlanSetDto Planned(string name) => history.Restore?.Sets?.FirstOrDefault(set => set.Name == name) is { } set
            ? new(set.Id, [.. set.Devices], set.Position, set.Type, set.Name) : throw new InvalidOperationException("No set " + name);
        var (full, log1) = (Planned("full"), Planned("log1"));
        var listed = (await Describe(new("historyFiles", SetId: full.Id))).Restore?.Files ?? [];
        check(listed.Any(item => item.Logical == file && item.Filegroup == group && item.Type == "data" && item.Absent is null) && listed.Any(item => item.Logical == "f3" && item.Filegroup == "FG3"),
            "a full backup's files carry their filegroups, every one present: " + string.Join(", ", listed.Select(item => item.Logical + "@" + item.Filegroup + (item.Absent == true ? " absent" : ""))));

        // Refusals before any statement: nothing runs, so no step is listed, and the database and its file are as they were.
        var folder = fullFile[..^"full.bak".Length];
        var identity = await Identity();
        var standby = await Wire(Options([full, log1], [file], [], "standby", folder + "undo.bak"), identity);
        var logName = await Wire(Options([full, log1], [db + "_log"], []), identity);
        var unknown = await Wire(Options([full, log1], ["nope"], []), identity);
        var stale = await Wire(Options([full, log1], [file], []), identity with { Id = identity.Id + 100_000 });
        var existing = await Wire(Options([full, log1], [file], [], backup: new(fullFile)), identity);
        check(standby is { Error.Code: "NOT_SUPPORTED", Steps: [] } && standby.Error.Message == restore.Message("standbyOnline") && logName is { Error.Code: "NOT_SUPPORTED", Steps: [] }
            && unknown is { Error.Code: "NOT_FOUND", Steps: [] } && stale is { Error.Code: "NOT_FOUND", Steps: [] } && existing is { Error.Code: "NAME_IN_USE", Steps: [] }
            && await FileState(file) == "0" && await State() == "0/0" && await Rows() == "3",
            "a file restore refuses before any statement STANDBY on an online database (SQL Server's 4302 comes only after the files are restored), a log file, a name the set lacks, "
            + "a database that is not the one read, and a log backup file already there: " + string.Join(" | ", new[] { standby, logName, unknown, stale, existing }.Select(Show)));

        // A PRIMARY file restores only offline: on this online FULL database it would put the whole database in RESTORING and lose the
        // log since log1 (4303, then 927, probed on 2025), so it is refused before any statement, by file with REPLACE and by filegroup.
        var primary = listed.FirstOrDefault(item => item.Filegroup == "PRIMARY" && item.Type == "data")?.Logical ?? throw new InvalidOperationException("No PRIMARY data file.");
        var primaryFile = await Wire(new([full, log1], [primary], [], [], true, false, "recovery", null, null), identity);
        var primaryGroup = await Wire(new([full, log1], [], ["PRIMARY"], [], false, false, "norecovery", null, null), identity);
        check(primaryFile is { Error.Code: "NOT_SUPPORTED", Steps: [] } && primaryFile.Error.Message == restore.Message("primaryOnline") && primaryGroup is { Error.Code: "NOT_SUPPORTED", Steps: [] }
            && await FileState(primary) == "0" && await State() == "0/0" && await Rows() == "3",
            "a file restore refuses a PRIMARY file (with REPLACE) and the PRIMARY filegroup of an online database before any statement: " + Show(primaryFile) + " | " + Show(primaryGroup));

        // FILE, rolled forward through the log, then Varia's copy-only log backup restored WITH RECOVERY: online with the row written
        // after the last log backup.
        var backup = new RestoreLogBackupDto(scratch.RestoreFile("lb1.bak", db));
        var ended = await Wire(Options([full, log1], [file], [], backup: backup), identity);
        check(ended is { Error: null, Restored: { State: 0, UserAccess: 0, FilesRestoring: null } }
            && ended.Steps.Select(step => (step.Status, step.Title)).SequenceEqual([("done", restore.Step("files")), ("done", restore.Step("log")), ("done", restore.Step("logBackup")), ("done", restore.Step("logBackupRestore"))])
            && await FileState(file) == "0" && await Rows() == "3" && await State() == "0/0",
            "a file restore through actions.execute, from the full backup and its log, ends with Varia's copy-only log backup restored WITH RECOVERY: the file online with every row: " + Show(ended));

        // FILEGROUP bound as a variable, WITH NORECOVERY through two logs: the file stays RESTORING and the reply names it; a tail-log
        // backup restored WITH RECOVERY brings it online with the row written after.
        var log2File = scratch.RestoreFile("log2.trn", db);
        await Step("BACKUP LOG " + B(db) + " TO DISK = " + Q(log2File) + " WITH FORMAT, INIT, NAME = N'log2';");
        await Step("INSERT dbo.t DEFAULT VALUES;", db);
        history = await Describe(new("history", db));
        var log2 = Planned("log2");
        var left = await Wire(Options([full, log1, log2], [], [group], "norecovery"));
        var restoring = await FileState(file);
        var tail = scratch.RestoreFile("tail.trn", db);
        await Step("BACKUP LOG " + B(db) + " TO DISK = " + Q(tail) + " WITH FORMAT, INIT, NAME = N'tail';");
        await Step("RESTORE LOG " + B(db) + " FROM DISK = " + Q(tail) + " WITH RECOVERY;");
        check(left is { Error: null, Restored: { State: 0, FilesRestoring: [var named] } } && named == file
            && left.Steps.Select(step => (step.Status, step.Title)).SequenceEqual([("done", restore.Step("files")), ("done", restore.Step("log") + " 1 of 2"), ("done", restore.Step("log") + " 2 of 2")])
            && restoring == "1" && await FileState(file) == "0" && await Rows() == "4" && await FileState("f3") == "0",
            "a FILEGROUP (bound as a variable) restored WITH NORECOVERY through two logs leaves its file RESTORING, named in the reply, until a tail-log backup restored WITH RECOVERY brings it online: "
            + Show(left) + " (file state " + restoring + ")");

        // The plan must reach the log chain (spec D1 §8): the tail backup just taken is a regular log backup the plans below lack, so
        // they are refused before any statement, naming it, and the file stays online.
        var behind = await Wire(Options([full, log1, log2], [file], [], backup: new(scratch.RestoreFile("lb3.bak", db))));
        var noLogs = await Wire(Options([full], [file], [], "norecovery"));
        check(behind is { Error.Code: "RESTORE_SEQUENCE", Steps: [] } && behind.Error.Message.StartsWith(restore.Message("logChainAhead"), StringComparison.Ordinal) && behind.Error.Message.Contains(tail, StringComparison.Ordinal)
            && noLogs is { Error.Code: "RESTORE_SEQUENCE", Steps: [] } && await FileState(file) == "0" && await State() == "0/0" && await Rows() == "4",
            "a file restore whose plan misses a log backup taken after its last set is refused before any statement, naming the newest log backup: " + Show(behind) + " | " + Show(noLogs));

        // A log backup taken during the run, before Back up the log: the copy-only backup would not continue the restored files (4305),
        // so that step fails naming it, and the file is left restoring until that backup and a later one are restored.
        history = await Describe(new("history", db));
        var tailSet = Planned("tail");
        var mid = scratch.RestoreFile("mid.trn", db);
        service.Actions.Options.BeforeStep = async (title, _) =>
        {
            if (title == restore.Step("logBackup")) await Step("BACKUP LOG " + B(db) + " TO DISK = " + Q(mid) + " WITH FORMAT, INIT, NAME = N'mid';");
        };
        ActionExecuteResult during;
        try { during = await Wire(Options([full, log1, log2, tailSet], [file], [], backup: new(scratch.RestoreFile("lb4.bak", db)))); }
        finally { service.Actions.Options.BeforeStep = null; }
        var duringState = await FileState(file);
        var tail2 = scratch.RestoreFile("tail2.trn", db);
        await Step("RESTORE LOG " + B(db) + " FROM DISK = " + Q(mid) + " WITH NORECOVERY;");
        await Step("BACKUP LOG " + B(db) + " TO DISK = " + Q(tail2) + " WITH FORMAT, INIT, NAME = N'tail2';");
        await Step("RESTORE LOG " + B(db) + " FROM DISK = " + Q(tail2) + " WITH RECOVERY;");
        check(during is { Error.Code: "RESTORE_SEQUENCE", Restored: { State: 0, FilesRestoring: [var waiting] } } && waiting == file
            && during.Error.Message.StartsWith(restore.Message("logBackedUpDuring"), StringComparison.Ordinal) && during.Error.Message.Contains(mid, StringComparison.Ordinal)
            && during.Steps.Select(step => (step.Status, step.Title)).SequenceEqual([("done", restore.Step("files")), ("done", restore.Step("log") + " 1 of 3"), ("done", restore.Step("log") + " 2 of 3"),
                ("done", restore.Step("log") + " 3 of 3"), ("failed", restore.Step("logBackup")), ("skipped", restore.Step("logBackupRestore"))])
            && duringState == "1" && await FileState(file) == "0" && await Rows() == "4",
            "a log backup taken during a file restore stops it at Back up the log, naming that backup, with the file left restoring until it and a later log backup are restored: "
            + Show(during) + " (file state " + duringState + ")");

        // Script: SMO's Restore { Action = Files } and { Action = Log }, and its copy-only Backup, script the statements actions.script writes,
        // for a hostile database, file, filegroup and paths, a move, REPLACE, RESTRICTED_USER and each recovery state.
        await using (var connection = ((IActionHost)service).Connection(info.Id))
        {
            await ((IActionHost)service).OpenAsync(connection, CancellationToken.None);
            var smo = new Server(new ServerConnection(connection) { AutoDisconnectMode = AutoDisconnectMode.NoAutoDisconnect });
            const string hostile = "a]b'c";
            var device = folder + "O'Brien ]x.bak";
            var move = new RestoreMoveDto(file, folder + "O'Brien ]f2.ndf");
            var differ = new List<string>();
            foreach (var (recovery, logBackup) in new[] { ("recovery", false), ("norecovery", false), ("standby", false), ("recovery", true) })
            {
                var options = new RestoreFilesOptionsDto([new(full.Id, [device], 2, "full", "full"), new(log1.Id, [device, device + "2"], 3, "log", "log1")], [file, "f3"], [group, "FG3"], [move], true, true, recovery,
                    recovery == "standby" ? folder + "O'Brien ]undo.bak" : null, logBackup ? new RestoreLogBackupDto(folder + "O'Brien ]lb.bak") : null);
                var expected = new List<string>();
                for (var index = 0; index < options.Sets.Count; index++)
                {
                    var set = options.Sets[index];
                    var last = !logBackup && index == options.Sets.Count - 1;
                    var step = new Restore { Database = hostile, Action = index == 0 ? RestoreActionType.Files : RestoreActionType.Log, FileNumber = set.File, ReplaceDatabase = index == 0, RestrictedUser = true,
                        NoRecovery = !last || recovery == "norecovery", PercentCompleteNotification = 5 };
                    if (last && recovery == "standby") step.StandbyFile = options.StandbyFile;
                    foreach (var path in set.Devices) step.Devices.AddDevice(path, DeviceType.File);
                    if (index == 0)
                    {
                        step.DatabaseFiles.AddRange([file, "f3"]);
                        step.DatabaseFileGroups.AddRange([group, "FG3"]);
                        step.RelocateFiles.Add(new RelocateFile(move.Logical, move.Physical));
                    }
                    expected.AddRange(step.Script(smo).Cast<string>());
                }
                if (options.LogBackup is { } lb)
                {
                    var taken = new Backup { Database = hostile, Action = BackupActionType.Log, CopyOnly = true, Initialize = false, FormatMedia = false, NoRewind = true, BackupSetName = RestoreSql.TailName(lb.File), PercentCompleteNotification = 5 };
                    taken.Devices.AddDevice(lb.File, DeviceType.File);
                    expected.Add(taken.Script(smo));
                    var back = new Restore { Database = hostile, Action = RestoreActionType.Log, FileNumber = 1, RestrictedUser = true, PercentCompleteNotification = 5 };
                    back.Devices.AddDevice(lb.File, DeviceType.File);
                    expected.AddRange(back.Script(smo).Cast<string>());
                }
                var actual = RestoreSql.FilesStatements(restore, hostile, options);
                if (!actual.SequenceEqual(expected))
                    differ.Add(recovery + (logBackup ? " + log backup" : "") + ": " + string.Join(" / ", actual.Zip(expected).Where(pair => pair.First != pair.Second).Select(pair => pair.First + " <> " + pair.Second).Take(1).DefaultIfEmpty(actual.Count + " <> " + expected.Count)));
            }
            check(differ.Count == 0, "a file restore's script is what SMO's Restore { Action = Files } and its copy-only log Backup script for the same choices, hostile names and paths among them: " + string.Join(" | ", differ));
        }

        // Under SIMPLE (Learn): a read-write filegroup's file is refused before anything; the read-only filegroup restores WITH RECOVERY.
        await Step("ALTER DATABASE " + B(db) + " SET RECOVERY SIMPLE;");
        await Step("ALTER DATABASE " + B(db) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\nALTER DATABASE " + B(db) + " MODIFY FILEGROUP " + B(group) + " READ_ONLY;\nALTER DATABASE " + B(db) + " SET MULTI_USER;");
        var simpleFile = scratch.RestoreFile("simple.bak", db);
        await Step("BACKUP DATABASE " + B(db) + " TO DISK = " + Q(simpleFile) + " WITH FORMAT, INIT, NAME = N'simple';");
        history = await Describe(new("history", db));
        var simple = Planned("simple");
        var readWrite = await Wire(Options([simple], ["f3"], []));
        var noLog = await Wire(Options([simple], [], [group], backup: new(scratch.RestoreFile("lb2.bak", db))));
        var readOnly = await Wire(Options([simple], [], [group]));
        check(readWrite is { Error.Code: "NOT_SUPPORTED", Steps: [] } && readWrite.Error.Message.StartsWith(restore.Message("simpleReadOnly"), StringComparison.Ordinal) && noLog is { Error.Code: "NOT_SUPPORTED", Steps: [] }
            && await FileState("f3") == "0" && readOnly is { Error: null, Restored: { State: 0, FilesRestoring: null }, Steps: [{ Status: "done" }] } && await FileState(file) == "0" && await Rows() == "4",
            "under SIMPLE a read-write filegroup's file and a log backup are refused before any statement, and the read-only filegroup restores WITH RECOVERY: "
            + string.Join(" | ", new[] { readWrite, noLog, readOnly }.Select(Show)));
    }
}
