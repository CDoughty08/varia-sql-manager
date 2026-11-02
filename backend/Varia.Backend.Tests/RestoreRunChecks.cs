using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of Restore Database's run (D1f): its statements are Script's, keyword for keyword, with variables where
/// Script has literals; its step titles are the catalogue's and the shared templates'; RestoreChain refuses a chain SQL Server would;
/// the errors that refuse a RESTORE before it writes are what the compensations wait on; and the cleanup's DROP is guarded.</summary>
internal static partial class RestoreRunChecks
{
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static readonly RestoreCatalogJson Restore = Catalog.Restore;

    [GeneratedRegex(@"N'(?:[^']|'')*'")]
    private static partial Regex Literal();
    [GeneratedRegex(@"\[(?:[^\]]|\]\])*\]|@db\b")]
    private static partial Regex Database();
    [GeneratedRegex(@"@\w+|(?<=FILE = )\d+")]
    private static partial Regex Value();

    /// <summary>A statement's keywords, with its database as DB and every value as ?: Script's literals and the run's variables alike.</summary>
    internal static string Shape(string text)
    {
        var shape = Value().Replace(Database().Replace(Literal().Replace(text, "?"), "DB"), "?");
        return Regex.Replace(Regex.Replace(shape, @"\s+", " "), @" ,", ",").Trim().TrimEnd(';');
    }

    private static RestorePlanSetDto Set(string id, string type, int file, params string[] devices) => new(id, [.. devices], file, type);

    public static void Run(Action<bool, string> check)
    {
        const string b = "C:\\Backup\\";
        var chain = new List<RestorePlanSetDto> { Set("1:1", "full", 1, b + "f1.bak", b + "f2.bak"), Set("2:1", "differential", 1, b + "d.bak"), Set("3:1", "log", 1, b + "l.trn"), Set("3:2", "log", 2, b + "l.trn") };
        var moves = new List<RestoreMoveDto> { new("a", "C:\\D\\a.mdf"), new("a_log", "C:\\D\\a.ldf") };
        var variants = new (string Name, RestoreOptionsDto Options, bool Exists)[]
        {
            ("everything", new(chain, moves, true, true, true, "standby", true, "2026-10-29T21:05:43", b + "u.bak", new(b + "t.bak", true)), true),
            ("left restoring", new(chain, [], false, false, false, "norecovery", false), false),
            ("plain, one set", new([chain[0]], [], false, false, false, "recovery", true), true),
            ("a tail left online", new(chain[..1], moves[..1], true, false, false, "recovery", false, TailLog: new(b + "t.bak", false)), true)
        };
        var wrong = new List<string>();
        foreach (var (name, options, exists) in variants)
        {
            var script = RestoreSql.Statements(Restore, "Sales", options, exists);
            var restores = script.Where(line => line.StartsWith("RESTORE ", StringComparison.Ordinal)).Select(Shape).ToList();
            var run = Enumerable.Range(0, options.Sets.Count).Select(index => Shape(ActionService.RestoreText(Restore, options, index))).ToList();
            if (!restores.SequenceEqual(run)) wrong.Add(name + ": " + string.Join(" | ", run.Except(restores)) + " vs " + string.Join(" | ", restores.Except(run)));
            if (options.TailLog is { } tail && Shape(script.Single(line => line.StartsWith("BACKUP LOG ", StringComparison.Ordinal))) != Shape(RestoreSql.TailLog(Restore, tail.NoRecovery)))
                wrong.Add(name + ": the tail-log backup");
        }
        check(wrong.Count == 0 && Shape(RestoreSql.Recover) == "RESTORE DATABASE DB WITH RECOVERY",
            "the run sends Script's statements: each RESTORE and the tail-log backup have SMO's keywords in SMO's order, with a variable for every value: " + string.Join("; ", wrong));
        var stopAt = ActionService.RestoreText(Restore, variants[0].Options, 3);
        check(ActionService.RestoreText(Restore, variants[0].Options, 0).Contains("REPLACE", StringComparison.Ordinal) && !ActionService.RestoreText(Restore, variants[0].Options, 1).Contains("REPLACE", StringComparison.Ordinal)
            && stopAt.EndsWith("STANDBY = @standby, NOUNLOAD, STATS = 5, STOPAT = @stopat;", StringComparison.Ordinal) && stopAt.Contains("KEEP_REPLICATION", StringComparison.Ordinal)
            && ActionService.RestoreText(Restore, variants[0].Options, 2).Contains("NORECOVERY", StringComparison.Ordinal) && stopAt.StartsWith("RESTORE LOG @db FROM DISK = @d1 WITH RESTRICTED_USER, FILE = @file, MOVE @l1 TO @p1, MOVE @l2 TO @p2,", StringComparison.Ordinal)
            && ActionService.RestoreText(Restore, variants[0].Options, 0).StartsWith("RESTORE DATABASE @db FROM DISK = @d1, DISK = @d2 WITH ", StringComparison.Ordinal),
            "REPLACE only on the first RESTORE, NORECOVERY on all but the last, and KEEP_REPLICATION, the recovery state and STOPAT on the last; striped devices and moves as numbered variables");

        // One set of words for a step, in the reply and in the document's list before it.
        var log = Restore.Step("log") + " 1024 of 1024";
        check(Restore.Step("close") == ActionService.StepTitle(ActionTemplate.SetSingleUser) && Restore.Step("multiUser") == ActionService.StepTitle(ActionTemplate.SetMultiUser)
            && Restore.Step("multiUserBack") == ActionService.StepTitle(ActionTemplate.SetMultiUser) && Restore.Step("restrictedUserBack") == ActionService.StepTitle(ActionTemplate.SetRestrictedUser)
            && Restore.Step("remove") == ActionService.StepTitle(ActionTemplate.DropRestoring) && log.Length <= ActionSteps.MaxTitle
            && Restore.Steps.Values.All(title => title.Length is > 0 and <= ActionSteps.MaxTitle) && Restore.Steps.Count == 10,
            "the run's step titles are restoreStepTitles, the shared templates' where it runs them, and fit the reply's 64 characters with a 1,024-set plan");
        var finished = Restore.Message("finishedAtStop");
        check(finished.Split("{database}").Length == 2 && finished.Replace("{database}", new string('x', 128), StringComparison.Ordinal).Length <= ActionErrors.MaxMessage,
            "a Stop that reached SQL Server only as the restore finished has one message, naming the database once, within an error's length");

        CheckChain(check);
        CheckPlan(check);
        CheckStop(check);

        // The compensations wait on SQL Server refusing the first RESTORE before it writes: the codes a restore's refusals map to are among them.
        var restoreCodes = new[] { "BACKUP_MISMATCH", "TAIL_LOG_NEEDED", "RESTORE_SEQUENCE" };
        check(restoreCodes.All(code => ActionErrors.Numbers[code].All(ActionService.RefusedBeforeWrite.Contains)) && ActionService.RefusedBeforeWrite.Contains(3101) && ActionService.RefusedBeforeWrite.Contains(3201)
            && !ActionService.RefusedBeforeWrite.Contains(3013) && !ActionService.RefusedBeforeWrite.Contains(3183) && !ActionService.RefusedBeforeWrite.Contains(3203)
            && ActionErrors.CodeOf(RestoreChecks.Sql((3154, "The backup set holds a backup of a database other than the existing 'x' database."), (3013, "RESTORE DATABASE is terminating abnormally.")), null) == "BACKUP_MISMATCH"
            && ActionErrors.CodeOf(RestoreChecks.Sql((3159, "The tail of the log for the database \"x\" has not been backed up.")), null) == "TAIL_LOG_NEEDED"
            && ActionErrors.CodeOf(RestoreChecks.Sql((4305, "The log in this backup set begins at LSN 1, which is too recent to apply to the database.")), null) == "RESTORE_SEQUENCE"
            && ActionErrors.CodeOf(RestoreChecks.Sql((3101, "Exclusive access could not be obtained because the database is in use.")), null) == "IN_USE",
            "SQL Server's refusals of a RESTORE before it writes (another database's backup, the tail of the log, sets out of sequence, exclusive access, media) leave the compensations due, "
            + "never 3013's generic end or an error reading a set part way; 3154, 3159 and 4305 are BACKUP_MISMATCH, TAIL_LOG_NEEDED and RESTORE_SEQUENCE, and 3101 IN_USE");

        // The cleanup's DROP: a positive int id, the RESTORING check in the batch, and nothing but QUOTENAME and CONVERT for its parameters.
        string Refused(string id)
        {
            try { ActionSql.Checked(new PlannedStatement(ActionTemplate.DropRestoring, "master", ["x", id], StepKind.Cleanup)); return "accepted"; }
            catch (InvalidOperationException) { return "refused"; }
        }
        var executable = ActionSql.Executable(ActionTemplate.DropRestoring);
        var dry = ActionSql.Executable(ActionTemplate.DropRestoring, dryRun: true);
        check(new[] { "0", "01", "-1", "2147483648", "1e3", "", " 5", "99999999999" }.All(id => Refused(id) == "refused") && Refused("1") == "accepted" && Refused("2147483647") == "accepted"
            && ActionSql.DropRestoring("a]b", 7) is { Names: ["a]b", "7"], Kind: StepKind.Cleanup, Database: "master" } restoring && ActionSql.Statement(restoring) == "DROP DATABASE [a]]b]"
            && executable.Contains("d.state = 1 AND d.database_id = CONVERT(int, @p2)) THROW 50000", StringComparison.Ordinal) && executable.IndexOf("THROW", StringComparison.Ordinal) < executable.IndexOf("EXEC @module", StringComparison.Ordinal)
            && !dry.Contains("d.state = 1", StringComparison.Ordinal) && ActionSql.LintExecutable(executable, ActionTemplate.DropRestoring).Count == 0,
            "the cleanup drops by a positive int id only, and its batch checks the database is still that RESTORING one before the DROP");
        var mutations = new[]
        {
            executable.Replace("CONVERT(int, @p2)", "@p2", StringComparison.Ordinal), executable.Replace("d.name = @p1 AND", "d.name = @p1 OR", StringComparison.Ordinal),
            executable.Replace("N'DROP DATABASE ' + QUOTENAME(@p1)", "N'DROP DATABASE ' + @p1", StringComparison.Ordinal), executable.Replace(ActionSql.NotRestoring, "N'x'", StringComparison.Ordinal)
        };
        check(mutations.All(text => text != executable && ActionSql.LintExecutable(text, ActionTemplate.DropRestoring).Count > 0),
            "the lint catches the cleanup's name or id outside their two forms, and an unlisted literal");
    }

    /// <summary>Nothing runs: the step plan is built, never executed.</summary>
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

    /// <summary>RestoreSteps against tests/fixtures/restore/run-steps.json, which run.ts's plannedSteps is held to as well: the Run
    /// panel's list, which the progress EVENTs index, is the backend's.</summary>
    private static void CheckPlan(Action<bool, string> check)
    {
        using var fixture = JsonDocument.Parse(File.ReadAllText(Fixtures.Path("tests/fixtures/restore/run-steps.json")));
        var web = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        using var service = new ActionService(new NoHost());
        using var connection = new SqlConnection();
        var wrong = new List<string>();
        var cases = 0;
        foreach (var item in fixture.RootElement.GetProperty("cases").EnumerateArray())
        {
            cases++;
            var options = item.GetProperty("restore").Deserialize<RestoreOptionsDto>(web)!;
            var facts = new ActionService.RestoreFacts(item.GetProperty("exists").GetBoolean(), 7, item.GetProperty("userAccess").GetInt32(), new HashSet<int>());
            var planned = service.RestoreSteps(connection, "c", "Sales", options, facts, new()).Select(step => (step.Kind.ToString().ToLowerInvariant(), step.Title, step.Detail)).ToList();
            var expected = item.GetProperty("steps").EnumerateArray().Select(step => (step.GetProperty("kind").GetString()!, step.GetProperty("title").GetString()!,
                step.TryGetProperty("detail", out var detail) ? detail.GetString() : null)).ToList();
            if (!planned.SequenceEqual(expected)) wrong.Add(item.GetProperty("name").GetString() + ": " + string.Join(", ", planned.Select(step => step.Item1 + " " + step.Title + " (" + step.Detail + ")")));
        }
        check(cases == 4 && wrong.Count == 0, "the run's steps are tests/fixtures/restore/run-steps.json's, as run.ts plans them, with the compensations and cleanup that may follow: " + string.Join("; ", wrong));
    }

    /// <summary>What a Stop's reply may claim: that the restore finished only with its own STATS at 100 percent and the database online;
    /// RECOVERY after the tail-log backup only while no RESTORE wrote; and the files a dropped partly restored database left, named.</summary>
    private static void CheckStop(Action<bool, string> check)
    {
        var last = Restore.Step("full");
        List<ActionStepDto> Steps(int? progress, string status = "cancelled") => [new("done", Restore.Step("close")), new(status, last, Progress: progress)];
        var online = new ActionService.RestoredRow(5, 0, 0);
        check(ActionService.FinishedAtStop(last, "recovery", Steps(100), online) && !ActionService.FinishedAtStop(last, "recovery", Steps(null), online)
            && !ActionService.FinishedAtStop(last, "recovery", Steps(99), online) && !ActionService.FinishedAtStop(last, "recovery", Steps(100), online with { State = 1 })
            && !ActionService.FinishedAtStop(last, "recovery", Steps(100), null) && !ActionService.FinishedAtStop(last, "norecovery", Steps(100), online)
            && !ActionService.FinishedAtStop(Restore.Step("log"), "recovery", Steps(100), online) && !ActionService.FinishedAtStop(last, "recovery", Steps(100, "failed"), online),
            "a Stop's reply says the restore finished only when the last RESTORE's own STATS reached 100 percent before it and the database reads online; a Stop before the RESTORE was sent has no percent");
        check(ActionService.RecoverDue("done", false) && ActionService.RecoverDue("cancelled", false) && !ActionService.RecoverDue("done", true) && !ActionService.RecoverDue("cancelled", true)
            && !ActionService.RecoverDue("failed", false) && !ActionService.RecoverDue("skipped", false),
            "RECOVERY after the tail-log backup is due once the BACKUP LOG completed or was stopped (it may have finished as Stop came) and while no RESTORE wrote");
        var many = Enumerable.Range(0, 40).Select(index => "C:\\" + new string('x', 250) + index).ToList();
        check(ActionService.LeftoversNote(many, false).Length + ActionErrors.MaxMessage / 2 <= ActionErrors.MaxMessage && ActionService.LeftoversNote(many, true).Contains("and 37 more", StringComparison.Ordinal)
            && ActionService.LeftoversNote(["/d/a.mdf"], false) == "SQL Server left the database's files on disk (/d/a.mdf): delete them, or restore to other paths."
            && ActionService.MaxFilesLeft == 16,
            "the note on a dropped partly restored database's files names at most three, fits beside an error's message, and the reply lists at most 16");
    }

    private static BackupSetDto Header(string type, string first, string last, string checkpoint = "0", string databaseBackup = "0", bool copyOnly = false, bool damaged = false,
        string? fork = "11111111-1111-1111-1111-111111111111", string? firstFork = null, string? forkPoint = null, string? family = "aaaaaaaa-0000-0000-0000-000000000000", string database = "Sales") =>
        new("1:1", "", type, "S", database, 1, first, last, checkpoint, databaseBackup, "2026-10-29T21:00:00", "2026-10-29T21:00:01", 1, "u", copyOnly, damaged, [], null, "FULL",
            firstFork ?? fork, fork, null, forkPoint, family);

    /// <summary>RestoreChain's rules on headers as the media hold them: the planner's (restore-plan.ts), so a plan the document made from
    /// the same headers passes, and a stale or forged one does not.</summary>
    private static void CheckChain(Action<bool, string> check)
    {
        var planned = new List<RestorePlanSetDto> { Set("1:1", "full", 1, "C:\\B\\f.bak"), Set("1:2", "differential", 2, "C:\\B\\f.bak"), Set("2:1", "log", 1, "C:\\B\\l.trn"), Set("2:2", "log", 2, "C:\\B\\l.trn") };
        var full = Header("full", "100", "200", checkpoint: "150");
        var differential = Header("differential", "300", "400", databaseBackup: "150");
        var log1 = Header("log", "380", "500", databaseBackup: "150");
        var log2 = Header("log", "500", "600", databaseBackup: "150");
        var good = new List<BackupSetDto> { full, differential, log1, log2 };
        string? Code(List<BackupSetDto> headers, List<RestorePlanSetDto>? sets = null) => RestoreChain.Problem(Restore, sets ?? planned, headers)?.Code;
        var cases = new (string Name, string? Expected, List<BackupSetDto> Headers, List<RestorePlanSetDto>? Sets)[]
        {
            ("the planned chain", null, good, null),
            ("full then logs from its end", null, [full, Header("log", "150", "500"), log2], [planned[0], planned[2], planned[3]]),
            ("a set of another kind at the position", "RESTORE_SEQUENCE", [full, differential, Header("differential", "380", "500", databaseBackup: "150"), log2], null),
            ("a damaged set", "MEDIA", [full, differential with { Damaged = true }, log1, log2], null),
            ("a copy-only log", "RESTORE_SEQUENCE", [full, differential, log1 with { CopyOnly = true }, log2], null),
            ("a differential of another full", "RESTORE_SEQUENCE", [full, differential with { DatabaseBackupLsn = "99" }, log1, log2], null),
            ("a differential that ends before the full", "RESTORE_SEQUENCE", [full, differential with { LastLsn = "180" }, log1, log2], null),
            ("a gap between logs", "RESTORE_SEQUENCE", [full, differential, log1, log2 with { FirstLsn = "550" }], null),
            ("a log that ends before the set it follows", "RESTORE_SEQUENCE", [full, differential, log1 with { LastLsn = "390" }, log2], null),
            ("a log of another database", "RESTORE_SEQUENCE", [full, differential, log1, log2 with { FamilyGuid = "bbbbbbbb-0000-0000-0000-000000000000" }], null),
            ("a log on another fork", "RESTORE_SEQUENCE", [full, differential, log1, log2 with { FirstForkGuid = "22222222-2222-2222-2222-222222222222" }], null),
            ("a forking log after a set past its fork point", "RESTORE_SEQUENCE", [full, differential, log1, log2 with { ForkGuid = "33333333-3333-3333-3333-333333333333", ForkPointLsn = "450" }], null),
            ("a forking log after a set by its fork point", null, [full, differential, log1, log2 with { ForkGuid = "33333333-3333-3333-3333-333333333333", ForkPointLsn = "500" }], null),
            ("unknown families", null, [.. good.Select(set => set with { FamilyGuid = null })], null)
        };
        var wrong = cases.Where(item => Code(item.Headers, item.Sets) != item.Expected).Select(item => item.Name + " gave " + (Code(item.Headers, item.Sets) ?? "none")).ToList();
        check(wrong.Count == 0 && RestoreChain.Where(planned[0]) == "f.bak" && RestoreChain.Where(Set("1:1", "full", 1, "/var/b/x.bak", "/var/b/y.bak")) == "x.bak (+1 files)",
            "RestoreChain refuses what SQL Server would (another kind at the position, damaged sets, copy-only logs, a differential of another full, gaps, other databases and forks) and passes the planner's chains: "
            + string.Join(", ", wrong));
    }
}
