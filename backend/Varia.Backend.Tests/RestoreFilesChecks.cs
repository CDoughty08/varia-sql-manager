using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of Restore Files and Filegroups (D1g): its statements are Script's with variables where Script has literals,
/// FILE and FILEGROUP as numbered variables the form 4 lint allows; Validate refuses what restoreFilesRequestSchema refuses; the
/// preflight's file rules; the files variant of RestoreChain; and its steps are tests/fixtures/restore/files-steps.json's, which
/// files.ts plans too.</summary>
internal static class RestoreFilesChecks
{
    private static readonly RestoreCatalogJson Restore = ActionsCatalog.Current.Restore;
    private static RestorePlanSetDto Set(string id, string type, int file, params string[] devices) => new(id, [.. devices], file, type);
    private static RestoreFilesOptionsDto Options(List<RestorePlanSetDto> sets, List<string>? files = null, List<string>? filegroups = null, List<RestoreMoveDto>? moves = null, bool replace = false,
        bool restricted = false, string recovery = "recovery", string? standby = null, string? logBackup = null) =>
        new(sets, files ?? ["Sales_2"], filegroups ?? [], moves ?? [], replace, restricted, recovery, standby, logBackup is null ? null : new(logBackup));

    public static void Run(Action<bool, string> check)
    {
        const string b = "C:\\Backup\\";
        var chain = new List<RestorePlanSetDto> { Set("1:1", "file", 1, b + "f1.bak", b + "f2.bak"), Set("3:1", "log", 1, b + "l.trn"), Set("3:2", "log", 2, b + "l.trn") };
        var variants = new (string Name, RestoreFilesOptionsDto Options)[]
        {
            ("a file, logs and the log backup", Options(chain, ["a", "b"], ["FG2"], [new("a", "D:\\a.ndf")], replace: true, restricted: true, logBackup: b + "Sales_LogBackup_1.bak")),
            ("a filegroup alone, left restoring", Options([chain[0]], [], ["FG2"], recovery: "norecovery")),
            ("standby on the last log", Options(chain, recovery: "standby", standby: b + "u.bak"))
        };
        var wrong = new List<string>();
        foreach (var (name, options) in variants)
        {
            var script = RestoreSql.FilesStatements(Restore, "Sales", options).Select(RestoreRunChecks.Shape).ToList();
            var last = options.LogBackup is null ? options.Sets.Count - 1 : -1;
            var run = Enumerable.Range(0, options.Sets.Count).Select(index => ActionService.RestoreFilesText(Restore, options, index, index == last ? options.Recovery : "norecovery")).ToList();
            if (options.LogBackup is not null) run.AddRange([RestoreSql.LogBackup(Restore), ActionService.RestoreFilesLogBackupText(Restore, options)]);
            var shapes = run.Select(RestoreRunChecks.Shape).ToList();
            if (!script.SequenceEqual(shapes)) wrong.Add(name + ": " + string.Join(" | ", shapes.Except(script)) + " vs " + string.Join(" | ", script.Except(shapes)));
            wrong.AddRange(run.SelectMany(text => RestoreSql.LintMedia(text, replace: options.Replace).Select(problem => name + ": " + problem)));
        }
        var first = ActionService.RestoreFilesText(Restore, variants[0].Options, 0, "norecovery");
        check(wrong.Count == 0 && first == "RESTORE DATABASE @db FILE = @f1, FILE = @f2, FILEGROUP = @g1 FROM DISK = @d1, DISK = @d2 WITH RESTRICTED_USER, FILE = @file, MOVE @l1 TO @p1, NORECOVERY, NOUNLOAD, REPLACE, STATS = 5;"
            && ActionService.RestoreFilesText(Restore, variants[0].Options, 1, "norecovery") == "RESTORE LOG @db FROM DISK = @d1 WITH RESTRICTED_USER, FILE = @file, NORECOVERY, NOUNLOAD, STATS = 5;"
            && RestoreSql.LogBackup(Restore) == "BACKUP LOG @db TO DISK = @tail WITH COPY_ONLY, NOFORMAT, NOINIT, NAME = @tail_name, NOSKIP, NOREWIND, NOUNLOAD, STATS = 5;"
            && ActionService.RestoreFilesLogBackupText(Restore, variants[0].Options) == "RESTORE LOG @db FROM DISK = @d1 WITH RESTRICTED_USER, FILE = @file, NOUNLOAD, STATS = 5;",
            "a file restore sends Script's statements: FILE and FILEGROUP as @f/@g variables before FROM, the moves and REPLACE on the files' RESTORE only, NORECOVERY until the last, "
            + "then the copy-only log backup and its RESTORE WITH RECOVERY; every statement passes the form 4 lint: " + string.Join("; ", wrong));
        var mutated = new[] { first.Replace("@f1", "N'x'", StringComparison.Ordinal), first.Replace("@g1", "@g257", StringComparison.Ordinal), first.Replace("FILEGROUP", "FILEGROUP_X", StringComparison.Ordinal) };
        check(mutated.All(text => RestoreSql.LintMedia(text, replace: true).Count > 0) && RestoreSql.LintCatalog(RestoreSql.DatabaseFiles).Count == 0,
            "the form 4 lint refuses a literal file name, a FILEGROUP variable past @g256 and an unknown word, and the file state read is a linted catalog read");

        // SMO's text for hostile names: brackets doubled in the database, quotes doubled in literals; the log backup's set is the new file's first.
        var hostile = RestoreSql.FilesStatements(Restore, "a]b'c", Options([Set("1:1", "full", 1, "C:\\O'Brien\\x.bak")], ["f'1"], ["g]2"], [new("f'1", "D:\\x'y.ndf")], logBackup: "C:\\B\\a'b.bak"));
        check(hostile.Count == 3 && hostile[0] == "RESTORE DATABASE [a]]b'c] FILE = N'f''1',  FILEGROUP = N'g]2' FROM  DISK = N'C:\\O''Brien\\x.bak' WITH  FILE = 1,  MOVE N'f''1' TO N'D:\\x''y.ndf',  NORECOVERY,  NOUNLOAD,  STATS = 5"
            && hostile[1] == "BACKUP LOG [a]]b'c] TO  DISK = N'C:\\B\\a''b.bak' WITH  COPY_ONLY, NOFORMAT, NOINIT,  NAME = N'a''b', NOSKIP, NOREWIND, NOUNLOAD,  STATS = 5"
            && hostile[2] == "RESTORE LOG [a]]b'c] FROM  DISK = N'C:\\B\\a''b.bak' WITH  FILE = 1,  NOUNLOAD,  STATS = 5"
            && RestoreSql.FilesScript(Restore, "x", variants[0].Options, 100) is null && RestoreSql.FilesScript(Restore, "x", variants[0].Options, 4_000_000) is { } whole
            && whole.StartsWith("USE [master]", StringComparison.Ordinal) && whole.TrimEnd().EndsWith("GO", StringComparison.Ordinal),
            "a file restore's script quotes hostile names as SMO does, ends with the copy-only log backup restored from position 1, and stops at its limit: " + string.Join(" | ", hostile));

        CheckValidation(check);
        CheckFiles(check);
        CheckChain(check);
        CheckSteps(check);
    }

    private static void CheckValidation(Action<bool, string> check)
    {
        using var service = new ActionService(new NoHost());
        string Refused(ActionArgs args, bool script = false)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Code + " " + error.Message; }
        }
        static string Id() => Guid.NewGuid().ToString();
        var identity = new DatabaseIdentityDto(7, "2026-10-29T21:05:43.000");
        const string path = "C:\\Backup\\x.bak";
        var chain = new List<RestorePlanSetDto> { Set("abcdef00-0000-0000-0000-000000000000", "file", 1, path), Set("1:2", "log", 2, path) };
        ActionArgs Args(RestoreFilesOptionsDto? options, string name = "Sales", DatabaseIdentityDto? id = null, bool noIdentity = false) =>
            new("restoreFiles", Id(), Id(), new ObjectRefDto("database", Name: name), Identity: noIdentity ? null : id ?? identity, RestoreFiles: options);
        var good = Options(chain);
        var many = Enumerable.Range(0, 257).Select(index => "f" + index).ToList();
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("no options", Args(null)), ("no identity", Args(good, noIdentity: true)), ("a bad identity", Args(good, id: new(0, "2026-10-29T21:05:43.000"))), ("master", Args(good, "master")), ("MSDB", Args(good, "MSDB")),
            ("a log first", Args(Options([chain[1]]))), ("a differential after the base", Args(Options([chain[0], Set("2:1", "differential", 1, path)]))), ("two bases", Args(Options([chain[0], chain[0] with { Id = "1:3" }]))),
            ("a differential base", Args(Options([Set("2:1", "differential", 1, path)]))), ("a set twice", Args(Options([chain[0], chain[1], chain[1]]))),
            ("nothing to restore", Args(Options(chain, [], []))), ("a file twice", Args(Options(chain, ["a", "a"]))), ("a filegroup twice", Args(Options(chain, [], ["g", "g"]))),
            ("257 files", Args(Options(chain, many))), ("257 filegroups", Args(Options(chain, [], many))), ("an empty file name", Args(Options(chain, [""]))),
            ("a file name with U+0000", Args(Options(chain, ["a\0b"]))), ("a 129-unit filegroup", Args(Options(chain, [], [new string('g', 129)]))),
            ("standby without a file", Args(Options(chain, recovery: "standby"))), ("a file without standby", Args(Options(chain, standby: path))), ("an unknown recovery", Args(Options(chain, recovery: "online"))),
            ("a log backup left restoring", Args(Options(chain, recovery: "norecovery", logBackup: path))), ("a log backup with standby", Args(Options(chain, recovery: "standby", standby: path, logBackup: "C:\\Backup\\y.bak"))),
            ("a relative log backup", Args(Options(chain, logBackup: "x.bak"))), ("a relative move", Args(Options(chain, moves: [new("Sales_2", "x.ndf")]))),
            ("a move twice", Args(Options(chain, moves: [new("a", "C:\\a.ndf"), new("a", "C:\\b.ndf")]))),
            ("too many parameters", Args(Options([chain[0] with { Devices = [.. Enumerable.Repeat(path, 64)] }], [.. many.Take(256)], [.. many.Take(256)], [.. Enumerable.Range(0, 800).Select(index => new RestoreMoveDto("m" + index, "C:\\m" + index + ".ndf"))]))),
            ("restore options too", Args(good) with { Restore = new([Set("1:1", "full", 1, path)], [], false, false, false, "recovery", false) }),
            ("file restore options on a restore", new ActionArgs("restore", Id(), Id(), new ObjectRefDto("database", Name: "Sales"), RestoreFiles: good)),
            ("Attach's databases too", Args(good) with { Databases = [new("Sales", ["/var/opt/mssql/data/Sales.mdf"], false)] }),
            ("New Login's members too", Args(good) with { Login = new("sql", "x", "master") }), ("Take Offline's dropConnections too", Args(good) with { DropConnections = true }),
            ("a new name too", Args(good) with { NewName = "x" }), ("a schema target", Args(good) with { Target = new ObjectRefDto("database", "x", Name: "Sales") })
        };
        var accepted = invalid.Where(item => !Refused(item.Args).StartsWith("INVALID_PARAMS", StringComparison.Ordinal) || !Refused(item.Args, script: true).StartsWith("INVALID_PARAMS", StringComparison.Ordinal))
            .Select(item => item.Name).ToList();
        var hostile = Options([Set("1:1", "full", 1, "\\\\files\\share\\O'Brien ]].bak")], ["f'1]", .. many.Take(255)], ["g]2", .. many.Take(255)], [new("f'1]", "/var/opt/mssql/data/x'y.ndf")], true, true, "recovery",
            logBackup: "/var/opt/mssql/backup/a'b.bak");
        check(accepted.Count == 0 && Refused(Args(good)) == "accepted" && Refused(Args(good), script: true) == "accepted" && Refused(Args(hostile, "a]b'c")) == "accepted"
            && Refused(Args(Options([Set("1:1", "full", 1, path)], [], ["PRIMARY"], recovery: "standby", standby: path))) == "accepted"
            && Refused(Args(good, "MSDB")).Contains(Restore.Message("systemDatabase"), StringComparison.Ordinal)
            && Refused(Args(good) with { Secrets = new("x") }).StartsWith("INVALID_PARAMS", StringComparison.Ordinal),
            "Validate refuses what restoreFilesRequestSchema refuses (and both restores' options on the other's action), SQL Server's own databases, and accepts hostile names, 256 files and 256 filegroups: "
            + string.Join(", ", accepted));
        check(JsonSerializer.Serialize(good, new JsonSerializerOptions(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull })
            .StartsWith("{\"sets\":[{\"id\":\"abcdef00-0000-0000-0000-000000000000\",\"devices\":[\"C:\\\\Backup\\\\x.bak\"],\"file\":1,\"type\":\"file\"}", StringComparison.Ordinal)
            && JsonSerializer.Serialize(new RestoredDatabaseDto(0, 0, FilesRestoring: ["a"]), new JsonSerializerOptions(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull })
                == "{\"state\":0,\"userAccess\":0,\"filesRestoring\":[\"a\"]}",
            "a file restore's options and the files still restoring cross the wire with restore.ts' and schema.ts' member names");
    }

    /// <summary>RestoredFiles: the named files and the named filegroups' files, all in the backup set, no log file, and moves only of them.</summary>
    private static void CheckFiles(Action<bool, string> check)
    {
        using var service = new ActionService(new NoHost());
        var listed = new List<ActionService.ListedFile>
        {
            new("Sales", "C:\\D\\Sales.mdf", "D", "PRIMARY", true), new("Sales_2", "C:\\D\\Sales_2.ndf", "D", "FG2", true), new("Sales_3", "C:\\D\\Sales_3.ndf", "D", "FG2", true),
            new("Sales_fs", "C:\\D\\fs", "S", "FS", true), new("Sales_log", "C:\\D\\Sales_log.ldf", "L", null, true), new("Old", "C:\\D\\Old.ndf", "D", "FG3", false)
        };
        string Outcome(List<string> files, List<string> filegroups, List<RestoreMoveDto>? moves = null, bool primaryRefused = false)
        {
            var (restored, error) = service.RestoredFiles(listed, new([Set("1:1", "file", 1, "C:\\B\\f.bak")], files, filegroups, moves ?? [], false, false, "recovery"), primaryRefused);
            return error is not null ? error.Code : string.Join(",", restored!.Select(file => file.Logical));
        }
        check(Outcome(["Sales_2"], []) == "Sales_2" && Outcome(["sales_2"], ["fg2"]) == "Sales_2,Sales_3" && Outcome([], ["FG2", "FS"]) == "Sales_2,Sales_3,Sales_fs"
            && Outcome(["Sales_log"], []) == "NOT_SUPPORTED" && Outcome(["Missing"], []) == "NOT_FOUND" && Outcome(["Old"], []) == "NOT_FOUND" && Outcome([], ["FG3"]) == "NOT_FOUND"
            && Outcome(["Sales_2"], [], [new("Sales_2", "E:\\x.ndf")]) == "Sales_2" && Outcome(["Sales_2"], [], [new("Sales", "E:\\x.mdf")]) == "NOT_FOUND",
            "a file restore restores the named files and the named filegroups' files (names as the server compares them), refuses a log file, a name the set lacks, a file a file backup does not hold, "
            + "and a move of a file it does not restore");
        // A PRIMARY file restores only offline, which loses an online or offline database's log tail (probed on 2025): refused there,
        // by file and through its filegroup, and only there.
        check(Outcome(["Sales"], [], primaryRefused: true) == "NOT_SUPPORTED" && Outcome([], ["primary"], primaryRefused: true) == "NOT_SUPPORTED"
            && Outcome(["Sales_2"], ["FG2"], primaryRefused: true) == "Sales_2,Sales_3" && Outcome(["Sales"], []) == "Sales" && Outcome([], ["PRIMARY"]) == "Sales",
            "a file restore refuses a file of the PRIMARY filegroup on an online or offline database, named or through its filegroup, and restores it on a restoring one");
    }

    private static BackupSetDto Header(string type, string first, string last, string checkpoint = "0") =>
        new("1:1", "", type, "S", "Sales", 1, first, last, checkpoint, "0", "2026-10-29T21:00:00", "2026-10-29T21:00:01", 1, "u", false, false, [], null, "FULL",
            "11111111-1111-1111-1111-111111111111", "11111111-1111-1111-1111-111111111111", null, null, "aaaaaaaa-0000-0000-0000-000000000000");

    /// <summary>RestoreChain's files variant: a full or file backup first, then logs that continue it; never a differential.</summary>
    private static void CheckChain(Action<bool, string> check)
    {
        var file = Header("file", "100", "200", "150");
        var log = Header("log", "150", "300");
        List<RestorePlanSetDto> Sets(params string[] types) => [.. types.Select((type, index) => Set("1:" + (index + 1), type, index + 1, "C:\\B\\f.bak"))];
        check(RestoreChain.Problem(Restore, Sets("file", "log"), [file, log], files: true) is null && RestoreChain.Problem(Restore, Sets("full", "log"), [file with { Type = "full" }, log], files: true) is null
            && RestoreChain.Problem(Restore, Sets("file", "log"), [file, log]) is { Code: "RESTORE_SEQUENCE" }
            && RestoreChain.Problem(Restore, Sets("file", "differential"), [file, Header("differential", "300", "400")], files: true) is { Code: "RESTORE_SEQUENCE" }
            && RestoreChain.Problem(Restore, Sets("file", "log"), [file, log with { FirstLsn = "250" }], files: true) is { Code: "RESTORE_SEQUENCE" }
            && RestoreChain.Problem(Restore, Sets("file", "log"), [file, log with { CopyOnly = true }], files: true) is { Code: "RESTORE_SEQUENCE" },
            "a file restore's chain is a full or file backup then logs that continue it: a file backup heads only a file restore's chain, and a differential, a gap or a copy-only log is refused");
        // The plan reaches the log chain when its last set ends at or after where the next log backup starts (a copy-only log after the
        // last regular one ends past it); no chain (SIMPLE, no full backup yet, not online) asks nothing.
        check(RestoreChain.Reaches("300", 300m) && RestoreChain.Reaches("400", 300m) && RestoreChain.Reaches("200", null) && !RestoreChain.Reaches("200", 300m) && !RestoreChain.Reaches(null, 1m),
            "a file restore's plan reaches the database's log chain only when its last set ends at or after the chain's next LSN");
    }

    /// <summary>RestoreFilesSteps against tests/fixtures/restore/files-steps.json, which files.ts's plannedFileSteps is held to as well.</summary>
    private static void CheckSteps(Action<bool, string> check)
    {
        using var fixture = JsonDocument.Parse(File.ReadAllText(Fixtures.Path("tests/fixtures/restore/files-steps.json")));
        var web = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        using var service = new ActionService(new NoHost());
        using var connection = new SqlConnection();
        var wrong = new List<string>();
        var cases = 0;
        foreach (var item in fixture.RootElement.GetProperty("cases").EnumerateArray())
        {
            cases++;
            var options = item.GetProperty("restoreFiles").Deserialize<RestoreFilesOptionsDto>(web)!;
            var planned = service.RestoreFilesSteps(connection, "Sales", options).Select(step => (step.Kind.ToString().ToLowerInvariant(), step.Title, step.Detail)).ToList();
            var expected = item.GetProperty("steps").EnumerateArray().Select(step => (step.GetProperty("kind").GetString()!, step.GetProperty("title").GetString()!,
                step.TryGetProperty("detail", out var detail) ? detail.GetString() : null)).ToList();
            if (!planned.SequenceEqual(expected)) wrong.Add(item.GetProperty("name").GetString() + ": " + string.Join(", ", planned.Select(step => step.Item1 + " " + step.Title + " (" + step.Detail + ")")));
        }
        check(cases == 3 && wrong.Count == 0 && Restore.Steps.Count == 13 && new[] { "files", "logBackup", "logBackupRestore" }.All(key => Restore.Step(key).Length <= ActionSteps.MaxTitle),
            "a file restore's steps are tests/fixtures/restore/files-steps.json's, as files.ts plans them, with no compensation or cleanup: " + string.Join("; ", wrong));
    }

    /// <summary>Nothing runs: requests are validated and step plans built, never executed.</summary>
    private sealed class NoHost : IActionHost
    {
        public ServerProfile Profile(string connectionId) => throw new NotSupportedException();
        public SqlConnection Connection(string connectionId) => throw new NotSupportedException();
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => throw new NotSupportedException();
        public bool ClearPoolsFor(string connectionId, string database) => throw new NotSupportedException();
        public bool FreeDatabase(string connectionId, string database) => throw new NotSupportedException();
        public IReadOnlySet<int> PoolSessions(string connectionId) => throw new NotSupportedException();
        public void DatabaseChanged(string connectionId, string database, string? newName) => throw new NotSupportedException();
    }
}
