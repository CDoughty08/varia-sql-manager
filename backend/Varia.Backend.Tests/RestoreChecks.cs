using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of Restore Database's read side and Script (D1e): the catalogue's restore block, the lint over every
/// catalog and media read (and what it must catch), validation parity with restore-schema.ts, actions.execute refusing a restore
/// until D1f, SMO's script text for the probed plans, hostile names and paths in it, and the engines it runs on.</summary>
internal static class RestoreChecks
{
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static readonly RestoreCatalogJson Restore = Catalog.Restore;
    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);

    private static RestorePlanSetDto Set(string id, string type, int file, params string[] devices) => new(id, [.. devices], file, type);
    private static RestoreOptionsDto Options(List<RestorePlanSetDto> sets, bool replace = false, string recovery = "recovery", List<RestoreMoveDto>? moves = null, bool keep = false,
        bool restricted = false, string? standby = null, RestoreTailLogDto? tail = null, bool close = false, string? stopAt = null) =>
        new(sets, moves ?? [], replace, keep, restricted, recovery, close, stopAt, standby, tail);

    public static async Task RunAsync(Action<bool, string> check)
    {
        var options = new ActionServiceOptions();
        check(Restore.Describe == "restoreDatabase" && Restore.Requests.SequenceEqual(["restore"]) && Restore.Engines.SequenceEqual(["box"])
            && Restore.SystemDatabases.SequenceEqual(["master", "model", "msdb", "tempdb"]) && Restore.Limit("mediaReadMs") == (long)options.RestoreDescribeBudget.TotalMilliseconds
            && Restore.Limit("backupDevices") == 64 && Restore.Limit("restoreMoves") == 1_000 && Restore.Limit("stats") == 5 && Restore.Limit("planSets") == Restore.Limit("historySets")
            && Restore.Limit("scriptChars") == 4_000_000 && Restore.Limit("mediaReadsPerConnection") == options.RestorePerConnection && options.RestorePerConnection == 2
            && !Catalog.Actions.Contains("restore") && !Catalog.Dialogs.ContainsKey("restoreDatabase") && Catalog.Retryable("MEDIA") == false && Catalog.Retryable("FILE_ACCESS") == true,
            "the restore block is restore.ts': describe restoreDatabase, action restore on SQL Server itself only, SQL Server's own databases, the 120 s media budget the service uses, "
            + "64 devices, 1000 moves, as many sets as the history lists, a 4,000,000-character script, two media reads per connection; restore is no object action (no menu item or command, critic A17), MEDIA is not retryable, and FILE_ACCESS (shared with Attach) is once the file is fixed");
        // 64 devices and two parameters per move stay under SQL Server's 2,100 parameters, with room for @db, @file, @standby, @stopat and the tail's two.
        check(Restore.Limit("backupDevices") + 2 * Restore.Limit("restoreMoves") + 6 <= 2_100, "a restore statement's parameters stay under SQL Server's 2,100");

        var lint = RestoreSql.Lint(Restore).ToList();
        var problems = lint.SelectMany(item => item.Problems.Select(problem => item.Name + ": " + problem)).ToList();
        check(lint.Count == 7 + 2 * 64 && problems.Count == 0, "every restore catalog read and every media read up to 64 devices passes its lint: " + string.Join("; ", problems.Take(5)));
        check(RestoreSql.Header(3) == "RESTORE HEADERONLY FROM DISK = @d1, DISK = @d2, DISK = @d3 WITH NOUNLOAD;" && RestoreSql.FileList(1) == "RESTORE FILELISTONLY FROM DISK = @d1 WITH FILE = @file, NOUNLOAD;"
            && RestoreSql.Label == "RESTORE LABELONLY FROM DISK = @d1 WITH NOUNLOAD;", "media reads take every device and the position as parameters, one text per device count");
        var mediaRefused = new[]
        {
            "RESTORE HEADERONLY FROM DISK = N'C:\\x.bak' WITH NOUNLOAD;", "RESTORE HEADERONLY FROM DISK = @d65 WITH NOUNLOAD;", "RESTORE HEADERONLY FROM DISK = @d1 WITH NOUNLOAD; EXEC sp_who;",
            "RESTORE HEADERONLY FROM DISK = @d1 WITH NOUNLOAD -- x\n;", "RESTORE DATABASE @db FROM DISK = @d1 WITH REPLACE;", "RESTORE HEADERONLY FROM DISK = @path WITH NOUNLOAD;",
            "SELECT 1;", "RESTORE HEADERONLY FROM DISK = @d1 WITH STATS = 10;", "RESTORE DATABASE @db FROM DISK = @d1 WITH MOVE @l1001 TO @p1;"
        }.Where(text => RestoreSql.LintMedia(text).Count == 0).ToList();
        check(mediaRefused.Count == 0 && RestoreSql.LintMedia("RESTORE DATABASE @db FROM DISK = @d1, DISK = @d64 WITH RESTRICTED_USER, FILE = @file, MOVE @l1000 TO @p1000, NORECOVERY, NOUNLOAD, REPLACE, STATS = 5;", replace: true).Count == 0
            && RestoreSql.LintMedia("BACKUP LOG @db TO DISK = @tail WITH NOFORMAT, NOINIT, NAME = @tail_name, NOSKIP, NOREWIND, NOUNLOAD, NORECOVERY, STATS = 5;").Count == 0,
            "the media lint (form 4) refuses literals, devices past @d64, a second statement, comments, REPLACE outside its variant and any word not in the form, and passes D1f's restore and tail-log shapes: " + string.Join(" | ", mediaRefused));
        var catalogRefused = new[]
        {
            "SELECT TOP (@take) bs.name FROM msdb.dbo.backupset AS bs WHERE bs.database_name = N'x' ORDER BY bs.name;", "SELECT bs.name FROM msdb.dbo.backupset AS bs;",
            "SELECT TOP (@take) DB_NAME(bs.database_id) FROM sys.databases AS bs ORDER BY 1;", "EXEC msdb.dbo.sp_delete_database_backuphistory @db;", "SELECT TOP (@take) b.x FROM #b AS b ORDER BY b.x;",
            "SELECT TOP (10) bs.name FROM msdb.dbo.backupset AS bs ORDER BY bs.name;", "SELECT TOP (@take) bs.name FROM msdb.dbo.backupset AS bs WHERE bs.name = @other ORDER BY bs.name;",
            "SELECT TOP (@take) LOGINPROPERTY(name, 'x') FROM sys.sql_logins ORDER BY 1;"
        }.Where(text => RestoreSql.LintCatalog(text).Count == 0).ToList();
        check(catalogRefused.Count == 0, "the restore catalog lint refuses literals, listings without TOP (@take) and ORDER BY, metadata functions, procedures, temporary tables, unknown parameters and secrets: " + string.Join(" | ", catalogRefused));

        CheckScripts(check);
        CheckMediaErrors(check);
        await ValidationAsync(check);
        await GatesAsync(check);
    }

    /// <summary>A SqlException carrying SQL Server's errors with their numbers and messages, as a failed media read raises them.</summary>
    private static SqlException Sql(params (int Number, string Message)[] errors)
    {
        var flags = System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance;
        var constructor = typeof(SqlError).GetConstructor(flags, [typeof(int), typeof(byte), typeof(byte), typeof(string), typeof(string), typeof(string), typeof(int), typeof(Exception)])
            ?? throw new Exception("SqlClient's SqlError constructor changed; update RestoreChecks.Sql");
        var collection = (SqlErrorCollection)(typeof(SqlErrorCollection).GetConstructor(flags, Type.EmptyTypes) ?? throw new Exception("SqlErrorCollection's constructor changed")).Invoke([]);
        var add = typeof(SqlErrorCollection).GetMethod("Add", flags) ?? throw new Exception("SqlErrorCollection.Add changed");
        foreach (var (number, message) in errors) add.Invoke(collection, [constructor.Invoke([number, (byte)1, (byte)16, "server", message, "", 0, null])]);
        var create = typeof(SqlException).GetMethod("CreateException", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static, [typeof(SqlErrorCollection), typeof(string)])
            ?? throw new Exception("SqlException.CreateException changed");
        return (SqlException)create.Invoke(null, [collection, "17.00.1000"])!;
    }

    /// <summary>How a failed media read becomes a value: 3201 by its operating system error (not there: PATH_NOT_FOUND; denied,
    /// held by another program or anything else: FILE_ACCESS), even with a "(" in the device's name; media a restore cannot use
    /// (MEDIA); and anything else as FromSql has it.</summary>
    private static void CheckMediaErrors(Action<bool, string> check)
    {
        const string terminating = "RESTORE LABELONLY is terminating abnormally.";
        string Code(params (int, string)[] errors) => RestoreDescribe.MediaError(Catalog, Sql(errors), null) is { } error ? error.Code + (error.Message.Contains("terminating", StringComparison.Ordinal) ? "+" : "") : "null";
        string Open(string device, string os) => "Cannot open backup device '" + device + "'. Operating system error " + os + ".";
        var cases = new (string Name, string Expected, (int, string)[] Errors)[]
        {
            ("a missing file", "PATH_NOT_FOUND+", [(3201, Open("C:\\B\\x.bak", "2(The system cannot find the file specified.)")), (3013, terminating)]),
            ("a missing folder", "PATH_NOT_FOUND", [(3201, Open("C:\\No\\x.bak", "3(The system cannot find the path specified.)"))]),
            ("an unreachable share", "PATH_NOT_FOUND", [(3201, Open("\\\\10.255.255.1\\s\\x.bak", "53(The network path was not found.)"))]),
            ("access denied", "FILE_ACCESS+", [(3201, Open("C:\\B\\x.bak", "5(Access is denied.)")), (3013, terminating)]),
            ("a file another program holds", "FILE_ACCESS", [(3201, Open("C:\\B\\x.bak", "32(The process cannot access the file because it is being used by another process.)"))]),
            ("a missing file whose name holds 5(", "PATH_NOT_FOUND", [(3201, Open("C:\\B\\copy 5(1).bak", "2(The system cannot find the file specified.)"))]),
            ("denied, whose name holds 2(", "FILE_ACCESS", [(3201, Open("C:\\B\\copy 2(1).bak", "5(Access is denied.)"))]),
            ("another program's media", "MEDIA+", [(3241, "The media family on device 'C:\\B\\x.bak' is incorrectly formed. SQL Server cannot process this media family."), (3013, terminating)]),
            ("a missing family", "MEDIA", [(3242, "The file on device 'C:\\B\\x.bak' is not a valid Microsoft Tape Format backup set.")]),
            ("a damaged set", "MEDIA", [(3183, "RESTORE detected an error on page (1:2) in database \"x\" as read from the backup set.")]),
            ("anything else", "SQL_ERROR+", [(3013, terminating)]),
            ("a lock", "null", [(1222, "Lock request time out period exceeded.")])
        };
        var wrong = cases.Where(item => Code(item.Errors) != item.Expected).Select(item => item.Name + " gave " + Code(item.Errors)).ToList();
        check(wrong.Count == 0, "a failed media read is PATH_NOT_FOUND when its operating system error says the file or path is not there, FILE_ACCESS for any other, MEDIA for media a restore cannot use, with SQL Server's whole message: " + string.Join(", ", wrong));
    }

    /// <summary>SQL Server ends a read of a file on an unreachable share only when the file call returns, so a restore describe past
    /// its budget still holds its gate. Describes stuck on as many servers as the read gates allow in total, two on one of them,
    /// leave Database Properties and Delete Object their read gates on those servers and others.</summary>
    private static async Task GatesAsync(Action<bool, string> check)
    {
        var host = new ServerFilesChecks.StuckHost();
        using var service = new ActionService(host);
        service.Options.RestoreDescribeBudget = TimeSpan.FromMilliseconds(400);
        service.Options.GateWait = TimeSpan.FromSeconds(5);
        var servers = Enumerable.Range(0, service.Options.ReadTotal).Select(_ => Guid.NewGuid().ToString()).ToList();
        ActionDescribeArgs Media(string connectionId) => new(connectionId, Guid.NewGuid().ToString(), "restoreDatabase", new ObjectRefDto("server"), null, new("devices", Devices: ["\\\\unreachable\\share\\x.bak"]));
        var stuck = servers.Select(Media).Append(Media(servers[0])).Select(args => service.DescribeAsync(args, CancellationToken.None)).ToList();
        var watch = System.Diagnostics.Stopwatch.StartNew();
        while (host.Held < stuck.Count && watch.Elapsed < TimeSpan.FromSeconds(10)) await Task.Delay(10);
        var timedOut = await Task.WhenAll(stuck);
        host.Blocking = false;
        async Task<string> Describe(string connectionId, string dialog, ObjectRefDto target)
        {
            try { return (await service.DescribeAsync(new(connectionId, Guid.NewGuid().ToString(), dialog, target), CancellationToken.None)).Error?.Code ?? "none"; }
            catch (RequestException error) { return error.Code; }
        }
        var properties = await Describe(servers[0], "databaseProperties", new ObjectRefDto("database", Name: "AppData"));
        var delete = await Describe(servers[0], "deleteObject", new ObjectRefDto("table", "AppData", "dbo", "Orders"));
        var other = await Describe(Guid.NewGuid().ToString(), "databaseProperties", new ObjectRefDto("database", Name: "AppData"));
        var heldWhile = host.Held;
        host.Release();
        watch.Restart();
        while (service.ActiveJobs > 0 && watch.Elapsed < TimeSpan.FromSeconds(10)) await Task.Delay(10);
        check(timedOut.All(result => result.Error?.Code == "TIMEOUT") && heldWhile == stuck.Count && properties == "CONNECTION_LOST" && delete == "CONNECTION_LOST" && other == "CONNECTION_LOST"
            && service.ActiveJobs == 0 && service.RunningCount == 0,
            "restore describes stuck past their budget hold only their own gate: Database Properties and Delete Object still open on that server and others (their unreachable fake answers CONNECTION_LOST, not BUSY): "
            + string.Join(", ", timedOut.Select(result => result.Error?.Code)) + " | " + properties + " | " + delete + " | " + other + " | " + heldWhile + " held");
    }

    /// <summary>SMO's RestorePlan.Script() text as the D1 probe captured it on SQL Server 2025 (scratchpad D1-database-wizards-probe-output2.txt),
    /// with SET  SINGLE_USER and SET  MULTI_USER as the shared templates write them (critic A12), which differ from SMO's only in a space.</summary>
    private static void CheckScripts(Action<bool, string> check)
    {
        const string db = "X_src", b = "C:\\Backup\\";
        var chain = new List<RestorePlanSetDto> { Set("1:1", "full", 1, b + "X_src_full.bak"), Set("3:1", "differential", 1, b + "X_src_diff.bak"), Set("2:3", "log", 3, b + "X_src_log.trn") };
        var cases = new (string Name, string Database, RestoreOptionsDto Options, bool Exists, string[] Expected)[]
        {
            ("last backup over the source, with a tail-log backup and closed connections", db, Options(chain, replace: true, close: true, tail: new(b + "X_src_LogBackup_2026-10-29_21-05-45.bak", true)), true,
            [
                "ALTER DATABASE [X_src] SET  SINGLE_USER WITH ROLLBACK IMMEDIATE",
                "BACKUP LOG [X_src] TO  DISK = N'C:\\Backup\\X_src_LogBackup_2026-10-29_21-05-45.bak' WITH NOFORMAT, NOINIT,  NAME = N'X_src_LogBackup_2026-10-29_21-05-45', NOSKIP, NOREWIND, NOUNLOAD,  NORECOVERY ,  STATS = 5",
                "RESTORE DATABASE [X_src] FROM  DISK = N'C:\\Backup\\X_src_full.bak' WITH  FILE = 1,  NORECOVERY,  NOUNLOAD,  REPLACE,  STATS = 5",
                "RESTORE DATABASE [X_src] FROM  DISK = N'C:\\Backup\\X_src_diff.bak' WITH  FILE = 1,  NORECOVERY,  NOUNLOAD,  STATS = 5",
                "RESTORE LOG [X_src] FROM  DISK = N'C:\\Backup\\X_src_log.trn' WITH  FILE = 3,  NOUNLOAD,  STATS = 5",
                "ALTER DATABASE [X_src] SET  MULTI_USER"
            ]),
            ("a new name with its files relocated", "X_r", Options(chain, moves: [new("X_src", "C:\\DATA\\X_r.mdf"), new("X_src_log", "C:\\DATA\\X_r_log.ldf")]), false,
            [
                "RESTORE DATABASE [X_r] FROM  DISK = N'C:\\Backup\\X_src_full.bak' WITH  FILE = 1,  MOVE N'X_src' TO N'C:\\DATA\\X_r.mdf',  MOVE N'X_src_log' TO N'C:\\DATA\\X_r_log.ldf',  NORECOVERY,  NOUNLOAD,  STATS = 5",
                "RESTORE DATABASE [X_r] FROM  DISK = N'C:\\Backup\\X_src_diff.bak' WITH  FILE = 1,  MOVE N'X_src' TO N'C:\\DATA\\X_r.mdf',  MOVE N'X_src_log' TO N'C:\\DATA\\X_r_log.ldf',  NORECOVERY,  NOUNLOAD,  STATS = 5",
                "RESTORE LOG [X_r] FROM  DISK = N'C:\\Backup\\X_src_log.trn' WITH  FILE = 3,  MOVE N'X_src' TO N'C:\\DATA\\X_r.mdf',  MOVE N'X_src_log' TO N'C:\\DATA\\X_r_log.ldf',  NOUNLOAD,  STATS = 5"
            ]),
            ("standby, keep replication and restricted access", db, Options(chain, replace: true, recovery: "standby", keep: true, restricted: true, standby: b + "X_src_RollbackUndo_x.bak"), true,
            [
                "RESTORE DATABASE [X_src] FROM  DISK = N'C:\\Backup\\X_src_full.bak' WITH  RESTRICTED_USER,  FILE = 1,  NORECOVERY,  NOUNLOAD,  REPLACE,  STATS = 5",
                "RESTORE DATABASE [X_src] FROM  DISK = N'C:\\Backup\\X_src_diff.bak' WITH  RESTRICTED_USER,  FILE = 1,  NORECOVERY,  NOUNLOAD,  STATS = 5",
                "RESTORE LOG [X_src] FROM  DISK = N'C:\\Backup\\X_src_log.trn' WITH  RESTRICTED_USER,  FILE = 3,  KEEP_REPLICATION,  STANDBY = N'C:\\Backup\\X_src_RollbackUndo_x.bak',  NOUNLOAD,  STATS = 5"
            ]),
            ("left restoring", db, Options(chain, recovery: "norecovery"), true,
            [
                "RESTORE DATABASE [X_src] FROM  DISK = N'C:\\Backup\\X_src_full.bak' WITH  FILE = 1,  NORECOVERY,  NOUNLOAD,  STATS = 5",
                "RESTORE DATABASE [X_src] FROM  DISK = N'C:\\Backup\\X_src_diff.bak' WITH  FILE = 1,  NORECOVERY,  NOUNLOAD,  STATS = 5",
                "RESTORE LOG [X_src] FROM  DISK = N'C:\\Backup\\X_src_log.trn' WITH  FILE = 3,  NORECOVERY,  NOUNLOAD,  STATS = 5"
            ]),
            ("a point in time", db, Options([Set("1:1", "full", 1, b + "X_src_full.bak"), Set("2:1", "log", 1, b + "X_src_log.trn"), Set("2:2", "log", 2, b + "X_src_log.trn")], stopAt: "2026-10-29T21:05:43"), true,
            [
                "RESTORE DATABASE [X_src] FROM  DISK = N'C:\\Backup\\X_src_full.bak' WITH  FILE = 1,  NORECOVERY,  NOUNLOAD,  STATS = 5",
                "RESTORE LOG [X_src] FROM  DISK = N'C:\\Backup\\X_src_log.trn' WITH  FILE = 1,  NORECOVERY,  NOUNLOAD,  STATS = 5",
                "RESTORE LOG [X_src] FROM  DISK = N'C:\\Backup\\X_src_log.trn' WITH  FILE = 2,  NOUNLOAD,  STATS = 5,  STOPAT = N'2026-10-29T21:05:43'"
            ])
        };
        var wrong = cases.Where(item => !RestoreSql.Statements(Restore, item.Database, item.Options, item.Exists).SequenceEqual(item.Expected)).Select(item => item.Name).ToList();
        check(wrong.Count == 0, "Script writes SMO's restore plan text for the probed plans (tail log, relocation, standby, norecovery, point in time): " + string.Join(", ", wrong));

        var script = RestoreSql.Script(Restore, db, cases[3].Options, true, Restore.Limit("scriptChars"))!;
        var nl = Environment.NewLine;
        check(script.StartsWith("USE [master]" + nl + "RESTORE DATABASE ", StringComparison.Ordinal) && script.EndsWith(nl + nl + "GO" + nl, StringComparison.Ordinal),
            "a restore's script starts with USE [master] and ends with GO");
        // Close existing connections on a database that does not exist yet, or with restricted access or no recovery, adds nothing (SET MULTI_USER would fail or undo RESTRICTED_USER).
        check(!RestoreSql.Statements(Restore, "X_new", Options(chain, close: true), false).Any(text => text.StartsWith("ALTER", StringComparison.Ordinal))
            && RestoreSql.Statements(Restore, db, Options(chain, close: true, recovery: "norecovery"), true) is [{ } first, .., { } lastNoRecovery] && first.Contains("SINGLE_USER", StringComparison.Ordinal) && !lastNoRecovery.Contains("MULTI_USER", StringComparison.Ordinal)
            && !RestoreSql.Statements(Restore, db, Options(chain, close: true, restricted: true), true).Any(text => text.Contains("MULTI_USER", StringComparison.Ordinal))
            && RestoreSql.Statements(Restore, db, Options(chain, tail: new(b + "t.bak", false)), true)[0].EndsWith("NOREWIND, NOUNLOAD,  STATS = 5", StringComparison.Ordinal),
            "SET SINGLE_USER only on a database that exists, SET MULTI_USER only after RESTORE WITH RECOVERY without restricted access, and a tail-log backup that leaves the database online has no NORECOVERY");
        // Hostile names and paths: brackets doubled in names, quotes doubled in literals, nothing else changed.
        const string hostile = "a]b'c; DROP DATABASE x --";
        var hostileText = RestoreSql.Statements(Restore, hostile, Options([Set("1:1", "full", 1, "C:\\O'Brien ]]\\x.bak", "\\\\files\\share\\'; --.bak")], moves: [new("l'o]g", "/var/opt/mssql/data/x'y.ldf")], recovery: "standby", standby: "C:\\u'.bak"), true)[0];
        check(hostileText == "RESTORE DATABASE [a]]b'c; DROP DATABASE x --] FROM  DISK = N'C:\\O''Brien ]]\\x.bak',  DISK = N'\\\\files\\share\\''; --.bak' WITH  FILE = 1,  MOVE N'l''o]g' TO N'/var/opt/mssql/data/x''y.ldf',  STANDBY = N'C:\\u''.bak',  NOUNLOAD,  STATS = 5"
            && RestoreSql.TailName("C:\\B\\X_LogBackup_1.bak") == "X_LogBackup_1" && RestoreSql.TailName("/var/b/x.y.trn") == "x.y" && RestoreSql.TailName("C:\\B\\noext") == "noext",
            "a hostile database name, logical name and paths are quoted as SMO quotes them, striped devices in family order: " + hostileText);
        // A request under 4 MiB whose text would be about 200 million characters: 1,000 moves of quote-filled names on every one of
        // 256 sets. Script stops at its limit after a few statements, never building the whole text.
        var quotes = new List<RestoreMoveDto>([.. Enumerable.Range(0, 1_000).Select(index => new RestoreMoveDto(index.ToString("D4", System.Globalization.CultureInfo.InvariantCulture) + new string('\'', 124), "C:\\" + index.ToString("D4", System.Globalization.CultureInfo.InvariantCulture) + new string('\'', 253)))]);
        var huge = Options([Set("1:1", "full", 1, b + "f.bak"), .. Enumerable.Range(2, 255).Select(index => Set("1:" + index, "log", index, b + "l.trn"))], moves: quotes);
        var before = GC.GetAllocatedBytesForCurrentThread();
        var tooLarge = RestoreSql.Script(Restore, db, huge, false, Restore.Limit("scriptChars"));
        var allocated = GC.GetAllocatedBytesForCurrentThread() - before;
        var fits = RestoreSql.Script(Restore, db, huge with { Sets = huge.Sets[..4] }, false, Restore.Limit("scriptChars"));
        check(tooLarge is null && allocated < 64L * 1024 * 1024 && fits is { Length: > 3_000_000 and <= 4_000_000 },
            "a restore's script stops once it passes 4,000,000 characters, allocating " + (allocated / 1024 / 1024) + " MiB rather than the whole text's gigabyte, and a long one under the limit is written whole");
    }

    private static async Task ValidationAsync(Action<bool, string> check)
    {
        using var service = new ActionService(new FakeHost());
        string Refused(Func<object> validate)
        {
            try { validate(); return "accepted"; }
            catch (RequestException error) { return error.Code + " " + error.Message; }
        }
        static string Id() => Guid.NewGuid().ToString();
        var server = new ObjectRefDto("server");
        ActionDescribeArgs Describe(RestoreSourceDto? source, ObjectRefDto? target = null, string dialog = "restoreDatabase") => new(Id(), Id(), dialog, target ?? server, null, source);
        var path = "C:\\Backup\\x.bak";
        var describeInvalid = new (string Name, ActionDescribeArgs Args)[]
        {
            ("no source", Describe(null)), ("a source for another dialog", Describe(new("history"), dialog: "deleteObject")), ("a database target", Describe(new("history"), new ObjectRefDto("database", Name: "x"))),
            ("an unknown kind", Describe(new("tape"))), ("devices with a database", Describe(new("devices", "x", [path]))), ("no devices", Describe(new("devices", Devices: []))),
            ("65 devices", Describe(new("devices", Devices: [.. Enumerable.Repeat(path, 65)]))), ("a relative device", Describe(new("devices", Devices: ["x.bak"]))),
            ("a wildcard device", Describe(new("devices", Devices: ["C:\\*.bak"]))), ("a set id that is no uuid", Describe(new("historyFiles", SetId: "1:1"))),
            ("an upper-case uuid", Describe(new("historyFiles", SetId: "ABCDEF00-0000-0000-0000-000000000000"))), ("position 0", Describe(new("mediaFiles", Devices: [path], File: 0))),
            ("position 32768", Describe(new("mediaFiles", Devices: [path], File: 32_768))), ("a history name with U+0000", Describe(new("history", "a\0b"))), ("a 129-unit name", Describe(new("history", new string('x', 129)))),
            ("history with a position", Describe(new("history", File: 1))), ("Attach's primary file too", Describe(new("history")) with { Attach = new("/var/opt/mssql/data/Sales.mdf") })
        };
        var describeAccepted = describeInvalid.Where(item => !Refused(() => service.Validate(item.Args)).StartsWith("INVALID_PARAMS", StringComparison.Ordinal)).Select(item => item.Name).ToList();
        check(describeAccepted.Count == 0 && Refused(() => service.Validate(Describe(new("history")))) == "accepted" && Refused(() => service.Validate(Describe(new("history", "a]b'c")))) == "accepted"
            && Refused(() => service.Validate(Describe(new("devices", Devices: [.. Enumerable.Repeat("\\\\files\\share\\O'Brien ]].bak", 64)])))) == "accepted"
            && Refused(() => service.Validate(Describe(new("historyFiles", SetId: "abcdef00-0000-0000-0000-000000000000")))) == "accepted"
            && Refused(() => service.Validate(Describe(new("mediaFiles", Devices: ["/var/opt/mssql/x.bak"], File: 32_767)))) == "accepted",
            "Validate refuses what restoreSourceSchema refuses and accepts hostile names and paths: " + string.Join(", ", describeAccepted));

        var chain = new List<RestorePlanSetDto> { Set("abcdef00-0000-0000-0000-000000000000", "full", 1, path), Set("1:2", "log", 2, path) };
        ActionArgs Script(RestoreOptionsDto? restore, string name = "Sales", DatabaseIdentityDto? identity = null, string action = "restore") =>
            new(action, Id(), Id(), new ObjectRefDto("database", Name: name), Identity: identity, Restore: restore);
        var good = Options(chain);
        var scriptInvalid = new (string Name, ActionArgs Args)[]
        {
            ("no options", Script(null)), ("master", Script(good, "master")), ("msdb", Script(good, "msdb")), ("model", Script(good, "model")), ("tempdb", Script(good, "tempdb")),
            ("MSDB", Script(good, "MSDB")), ("Master", Script(good, "Master")), ("Model", Script(good, "Model")), ("TempDB", Script(good, "TempDB")),
            ("a log first", Script(Options([chain[1]]))), ("two fulls", Script(Options([chain[0], chain[0] with { Id = "1:3" }]))), ("a differential third", Script(Options([.. chain, Set("2:1", "differential", 1, path)]))),
            ("a set twice", Script(Options([chain[0], chain[1], chain[1]]))), ("a file set", Script(Options([chain[0], Set("2:1", "file", 1, path)]))),
            ("a bad set id", Script(Options([chain[0] with { Id = "x" }]))), ("position 0", Script(Options([chain[0] with { File = 0 }]))), ("no devices", Script(Options([chain[0] with { Devices = [] }]))),
            ("STOPAT on a full", Script(Options([chain[0]], stopAt: "2026-10-29T21:05:43"))), ("STOPAT with a fraction", Script(Options(chain, stopAt: "2026-10-29T21:05:43.5"))),
            ("standby without a file", Script(Options(chain, recovery: "standby"))), ("a file without standby", Script(Options(chain, standby: path))), ("an unknown recovery", Script(Options(chain, recovery: "online"))),
            ("keep replication left restoring", Script(Options(chain, recovery: "norecovery", keep: true))), ("a move twice", Script(Options(chain, moves: [new("a", "C:\\a.mdf"), new("a", "C:\\b.mdf")]))),
            ("two moves to one path", Script(Options(chain, moves: [new("a", "C:\\a.mdf"), new("b", "C:\\A.MDF")]))), ("a relative move", Script(Options(chain, moves: [new("a", "a.mdf")]))),
            ("a relative tail", Script(Options(chain, tail: new("t.bak", true)))), ("a 1001st move", Script(Options(chain, moves: [.. Enumerable.Range(0, 1001).Select(index => new RestoreMoveDto("f" + index, "C:\\f" + index + ".mdf"))]))),
            ("1025 sets", Script(Options([chain[0], .. Enumerable.Range(1, 1_024).Select(index => Set("1:" + (index + 1), "log", index + 1, path))]))), ("a tail set id", Script(Options([chain[0], chain[1] with { Id = "tail" }]))),
            ("a bad identity", Script(good, identity: new(0, "2026-10-29T21:05:43.000"))), ("a new name too", Script(good) with { NewName = "x" }),
            ("restore options on a rename", Script(good, action: "rename") with { NewName = "x" }), ("a schema target", Script(good) with { Target = new ObjectRefDto("database", "x", Name: "Sales") }),
            // Attach Databases' member (D1d): each action takes only its own, as zod's strict schemas do.
            ("Attach's databases too", Script(good) with { Databases = [new("Sales", ["/var/opt/mssql/data/Sales.mdf"], false)] }),
            ("restore options on an attach", Script(good, action: "attach") with { Target = server, Databases = [new("Sales", ["/var/opt/mssql/data/Sales.mdf"], false)] })
        };
        var scriptAccepted = scriptInvalid.Where(item => !Refused(() => service.Validate(item.Args, script: true)).StartsWith("INVALID_PARAMS", StringComparison.Ordinal)).Select(item => item.Name).ToList();
        check(scriptAccepted.Count == 0 && Refused(() => service.Validate(Script(good), script: true)) == "accepted"
            && Refused(() => service.Validate(Script(Options(chain, true, "standby", [new("l'o]g", "\\\\s\\h\\x.ldf")], restricted: true, standby: path, tail: new(path, true), close: true, stopAt: "2026-10-29T21:05:43"), "a]b'c",
                new(5, "2026-10-29T21:05:43.123")), script: true)) == "accepted"
            && Refused(() => service.Validate(Script(good, "master"), script: true)).Contains(Restore.Message("systemDatabase"), StringComparison.Ordinal)
            && Refused(() => service.Validate(Script(good, "MSDB"), script: true)).Contains(Restore.Message("systemDatabase"), StringComparison.Ordinal)
            && Refused(() => service.Validate(Script(good, "msdb_copy"), script: true)) == "accepted"
            && Refused(() => service.Validate(Script(Options([chain[0], .. Enumerable.Range(1, 1_023).Select(index => Set("1:" + (index + 1), "log", index + 1, path))])), script: true)) == "accepted",
            "Validate refuses what restoreRequestSchema refuses, SQL Server's own databases in any case with critic A19's reason, and accepts hostile names, msdb_copy and a 1,024-set plan: " + string.Join(", ", scriptAccepted));
        check(Refused(() => service.Validate(Script(good))).StartsWith("INVALID_PARAMS", StringComparison.Ordinal),
            "actions.execute refuses a restore until D1f runs one (critic A17)");

        var cloudHost = new FakeHost(5);
        using var cloud = new ActionService(cloudHost);
        var managedHost = new FakeHost(8);
        using var managed = new ActionService(managedHost);
        var cloudDescribe = await cloud.DescribeAsync(Describe(new("history")), CancellationToken.None);
        var managedDescribe = await managed.DescribeAsync(Describe(new("history")), CancellationToken.None);
        var managedScript = await managed.ScriptAsync(Script(good), CancellationToken.None);
        check(cloudDescribe is { Error.Code: "NOT_SUPPORTED", Restore: null } && managedDescribe.Error?.Code == "NOT_SUPPORTED" && managedScript is { Error.Code: "NOT_SUPPORTED", Text: null }
            && cloudHost.Connections == 0 && managedHost.Connections == 0,
            "Azure SQL Database and Managed Instance answer Restore Database's describe and Script NOT_SUPPORTED before any connection opens");
        var unreachable = new FakeHost();
        using var offline = new ActionService(unreachable);
        var lost = await offline.DescribeAsync(Describe(new("devices", Devices: [path])), CancellationToken.None);
        var scripted = await offline.ScriptAsync(Script(good), CancellationToken.None);
        check(lost is { Error.Code: "CONNECTION_LOST", Restore: null } && offline.RunningCount == 0 && scripted is { Error: null, Database: "master", Text: { } text } && text.Contains("RESTORE LOG [Sales]", StringComparison.Ordinal)
            && unreachable.Connections == 1,
            "a restore describe that cannot connect is a value and frees its request, and a restore's Script, which reads nothing, opens no connection and takes no gate");
        check(JsonSerializer.Serialize(new RestoreSourceDto("devices", Devices: [path]), new JsonSerializerOptions(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull })
            == "{\"kind\":\"devices\",\"devices\":[\"C:\\\\Backup\\\\x.bak\"]}", "a restore source crosses the wire with restore.ts' member names");
    }

    private sealed class FakeHost(int edition = 3) : IActionHost
    {
        public int Connections;
        public ServerProfile Profile(string connectionId) => Box2022 with { EngineEdition = edition };
        public SqlConnection Connection(string connectionId)
        {
            Interlocked.Increment(ref Connections);
            return new SqlConnection("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false");
        }
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => connection.OpenAsync(token);
        public bool ClearPoolsFor(string connectionId, string database) => true;
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
        public bool FreeDatabase(string connectionId, string database) => true;
        public IReadOnlySet<int> PoolSessions(string connectionId) => new HashSet<int>();
    }
}
