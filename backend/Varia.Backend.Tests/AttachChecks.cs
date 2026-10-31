using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of Attach Databases (D1d): the builder batch and CHECKPRIMARYFILE batches pass their lint and the lint
/// catches what it must, the statement and Script Action's text for hostile names and paths, the design's round trip, the plan's
/// steps and compensations, validation parity with zod, the error numbers, and the engine gate before any connection.</summary>
internal static class AttachChecks
{
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);
    private static readonly ObjectRefDto Server = new("server");
    private static readonly string NL = ScriptFormatter.NewLine;

    public static async Task RunAsync(Action<bool, string> check)
    {
        var lint = AttachSql.LintAll().ToList();
        var problems = lint.SelectMany(item => item.Problems.Select(problem => item.Name + ": " + problem)).ToList();
        check(lint.Count == 7 + 3 * (ExplorerCatalog.MaxBand - ExplorerCatalog.MinBand + 1) && problems.Count == 0 && ActionSql.Lint().All(item => item.Problems.Count == 0),
            "every attach statement passes its lint, within ActionSql's: " + string.Join("; ", problems.Take(5)));

        // What the lint must catch, each a mutation of the real batch.
        var real = AttachSql.Executable(rebuildLog: false);
        var mutations = new (string Name, string Text)[]
        {
            ("STRING_AGG", real.Replace("WHILE @i < @n BEGIN", "SELECT @list = STRING_AGG(x.quoted, N', ') FROM @f AS x; WHILE @i < @n BEGIN", StringComparison.Ordinal)),
            ("EXEC (", real.Replace("EXEC @module @stmt;", "EXEC (@stmt);", StringComparison.Ordinal)),
            ("sp_executesql on a variable", real.Replace("EXEC @module @stmt;", "EXEC sys.sp_executesql @stmt;", StringComparison.Ordinal)),
            ("@p1 spliced", real.Replace("QUOTENAME(@p1)", "N'[' + @p1 + N']'", StringComparison.Ordinal)),
            ("@db spliced", real.Replace("QUOTENAME(@db) + N'.sys.sp_executesql'", "@db + N'.sys.sp_executesql'", StringComparison.Ordinal)),
            ("a raw path", real.Replace("REPLACE(a.value COLLATE Latin1_General_BIN2, N'''', N'''''')", "a.value", StringComparison.Ordinal)),
            // However T-SQL spells the value: brackets, another case, another alias, or a WITH clause that names it otherwise.
            ("a bracketed raw path", real.Replace("REPLACE(a.value COLLATE Latin1_General_BIN2, N'''', N'''''')", "a.[value]", StringComparison.Ordinal)),
            ("an upper-case raw path", real.Replace("REPLACE(a.value COLLATE Latin1_General_BIN2, N'''', N'''''')", "A.VALUE", StringComparison.Ordinal)),
            ("a raw path under another alias", real.Replace("REPLACE(a.value COLLATE Latin1_General_BIN2, N'''', N'''''')", "b.value", StringComparison.Ordinal)
                .Replace("FROM OPENJSON(@design) AS a;", "FROM OPENJSON(@design) AS a CROSS APPLY OPENJSON(@design) AS b;", StringComparison.Ordinal)),
            ("a raw path through WITH", real.Replace("REPLACE(a.value COLLATE Latin1_General_BIN2, N'''', N'''''')", "a.p", StringComparison.Ordinal)
                .Replace("FROM OPENJSON(@design) AS a;", "FROM OPENJSON(@design) WITH (p nvarchar(max) N'$') AS a;", StringComparison.Ordinal)),
            ("@design outside OPENJSON", real.Replace("N' ON ' + @list", "N' ON ' + @design", StringComparison.Ordinal)),
            ("no guard", real.Replace(ActionSql.Guard, "", StringComparison.Ordinal)),
            ("a literal keyword", real.Replace("N' FOR ATTACH'", "N' FOR ATTACH WITH ENABLE_BROKER'", StringComparison.Ordinal)),
            ("a format hole", real + "{0}"),
            ("an undeclared variable", real.Replace("SET @i = @i + 1;", "SET @i = @i + @step;", StringComparison.Ordinal))
        };
        var missed = mutations.Where(item => item.Text == real || AttachSql.Lint(item.Text).Count == 0).Select(item => item.Name).ToList();
        check(missed.Count == 0 && AttachSql.LintPrimary("DBCC CHECKPRIMARYFILE (N'C:\\x.mdf', 0);").Count > 0 && AttachSql.LintPrimary("DBCC CHECKPRIMARYFILE (@mdf, 1);").Count > 0
            && AttachSql.LintPrimary(AttachSql.Primary + "\nSELECT 1;").Count > 0 && AttachSql.LintPrimary("DECLARE @s nvarchar(max) = N'DBCC CHECKPRIMARYFILE (@mdf, 0);'; EXEC (@s);").Count > 0,
            "the attach lint refuses STRING_AGG (SQL Server 2016), other dynamic SQL, a spliced name or path, no guard, another keyword, a format hole and an undeclared variable, and CHECKPRIMARYFILE only with a bound path: "
            + string.Join(", ", missed));
        check(AttachSql.Executable(true).Contains("N' FOR ATTACH_REBUILD_LOG'", StringComparison.Ordinal) && !AttachSql.Executable(false).Contains("REBUILD", StringComparison.Ordinal)
            && AttachSql.Executable(false, dryRun: true).EndsWith("SELECT @stmt AS stmt;", StringComparison.Ordinal) && !AttachSql.Executable(false, dryRun: true).Contains("EXEC", StringComparison.Ordinal)
            && AttachSql.IsPrimary == "DBCC CHECKPRIMARYFILE (@mdf, 0);" && !AttachSql.Executable(false).Contains("STRING_AGG", StringComparison.Ordinal),
            "the keyword comes from one of two constant batches, and a dry run only selects the statement");

        // The statement and Script Action's text for hostile names and paths.
        var hostile = new AttachStatement("O'Brien ]]; DROP DATABASE x; --", ["C:\\Data\\O'Brien ]].mdf", "\\\\files\\share\\a''b\\Log ✓.ldf"], RebuildLog: false);
        var statement = AttachSql.Statement(hostile);
        check(statement == "CREATE DATABASE [O'Brien ]]]]; DROP DATABASE x; --] ON ( FILENAME = N'C:\\Data\\O''Brien ]].mdf' ), ( FILENAME = N'\\\\files\\share\\a''''b\\Log ✓.ldf' ) FOR ATTACH"
            && AttachSql.Statement(hostile with { Files = [hostile.Files[0]], RebuildLog = true }) == "CREATE DATABASE [O'Brien ]]]]; DROP DATABASE x; --] ON ( FILENAME = N'C:\\Data\\O''Brien ]].mdf' ) FOR ATTACH_REBUILD_LOG"
            && AttachSql.ScriptText(hostile) == "USE [master]" + NL + "GO" + NL + statement + NL + "GO" + NL,
            "Attach scripts CREATE DATABASE … FOR ATTACH in master with the name bracketed and each path quoted, files in order, on one line: " + statement);
        var paths = new[] { "C:\\a.mdf", "/var/opt/mssql/data/O'Brien \"x\" \\ é ✓ 😀.ndf", "\\\\files\\share\\]]'.ldf" };
        check(AttachSql.Paths(AttachSql.Design(new("A", paths, false))).SequenceEqual(paths) && AttachSql.Design(new("A", ["C:\\x'.mdf"], false)).StartsWith('['),
            "the design is a JSON array of the paths, in order, that reads back exactly");

        // The plan: per database its attach and owner, then compensations newest first.
        List<AttachDatabaseDto> two = [new("Sales", ["C:\\s.mdf"], false, Owner: "app_owner"), new("Hr", ["C:\\h.mdf", "C:\\h.ldf"], false), new("Ops", ["C:\\o.mdf"], true)];
        var plan = ActionService.AttachPlan(two);
        check(plan.Select(step => step.Title + "|" + step.Database + "|" + step.Kind + "|" + step.Undoes).SequenceEqual([
                "Attach the database|Sales|Main|", "Set the database owner|Sales|Main|", "Attach the database|Hr|Main|", "Attach the database|Ops|Main|",
                "Detach the database again|Ops|Compensation|3", "Detach the database again|Hr|Compensation|2", "Detach the database again|Sales|Compensation|0"])
            && plan[1].Owner is { Template: AlterTemplate.Owner, Database: "Sales", Name: "app_owner" }
            && plan.Where(step => step.Detach is not null).All(step => ActionSql.Statement(step.Detach!) == "EXEC master.dbo.sp_detach_db @dbname = N'" + step.Database + "', @skipchecks = 'true'")
            && plan[3].Attach is { RebuildLog: true, Files.Count: 1 } && plan.All(step => step.Title.Length <= Catalog.Logins.Limit("stepTitle"))
            && plan.Where(step => step.Kind == StepKind.Compensation).Select(step => step.Mdf).SequenceEqual(["C:\\o.mdf", "C:\\h.mdf", "C:\\s.mdf"]) && plan.All(step => step.Kind == StepKind.Compensation || step.Mdf is null),
            "an attach plans each database's attach and owner in order, then detaches what it attached, newest first, once a later step fails or is stopped (SSMS's Rolled Back)");
        var owner = DatabaseAlter.ScriptText(Catalog, [plan[1].Owner!]);
        check(owner == "USE [Sales]" + NL + "GO" + NL + "ALTER AUTHORIZATION ON DATABASE::[Sales] TO [app_owner]" + NL + "GO" + NL,
            "the owner is set as Database Properties sets it, in the attached database: " + owner);

        // Errors: SQL Server's numbers for an attach and a primary file map to codes the dialog explains, each number to one code.
        static string Code(int number) => string.Join(",", ActionErrors.Numbers.Where(pair => pair.Value.Contains(number)).Select(pair => pair.Key));
        check(Catalog.Retryable("FILE_ACCESS") == true && Catalog.Retryable("PATH_NOT_FOUND") == false && Catalog.Retryable("NOT_SUPPORTED") == false
            && Code(5120) == "FILE_ACCESS" && Code(5123) == "FILE_ACCESS" && Code(5133) == "PATH_NOT_FOUND"
            && Code(5058) == "NOT_SUPPORTED" && Code(2571) == "PERMISSION_DENIED" && Code(1801) == "NAME_IN_USE",
            "a file SQL Server cannot open (5120, 5123) is FILE_ACCESS, a missing folder (5133) PATH_NOT_FOUND, and DBCC's permission (2571) PERMISSION_DENIED");
        // A newer database: SQL Server's 948 is severity 20, which ends the session, so no number mapping can name it. Attach refuses
        // it itself, in Add's describe and again in OK's preflight, by the file's version against master's.
        var newer = ActionService.VersionProblem(999, 998);
        check(Code(948) == "" && ActionErrors.CodeOf(ConnectionFailureChecks.Sql(948, 1, 20, "server", "The database cannot be opened because it is version 999."), null) == "CONNECTION_LOST"
            && newer is not null && newer.StartsWith("This database is from a newer version of SQL Server and cannot be attached here", StringComparison.Ordinal)
            && ActionService.VersionProblem(957, 998) is null && ActionService.VersionProblem(998, 998) is null && ActionService.VersionProblem(null, 998) is null && ActionService.VersionProblem(999, null) is null,
            "a database newer than the server is refused by its version before anything runs, since SQL Server's 948 (severity 20) would read as a lost connection: " + newer);
        check(AttachSql.Facts.Contains(ActionSql.MasterVersion + " AS server_version", StringComparison.Ordinal) && AttachSql.Preflight.Contains(ActionSql.MasterVersion + " AS server_version", StringComparison.Ordinal)
            && ActionSql.LintCatalog(AttachSql.Facts.Replace(ActionSql.MasterVersion, "CONVERT(int, DATABASEPROPERTYEX(N'model', 'Version'))", StringComparison.Ordinal), 16, database: false).Count > 0,
            "the describe and the preflight read master's version, the catalog lint's one DATABASEPROPERTYEX exception, and no other");

        // Recorded paths: only those on the server's own disks are probed; a share the file names is unknown, and never reached.
        var local = new[] { "C:\\Data\\a.ndf", "c:/data/a.ndf", "/var/opt/mssql/data/a.ndf", "/" };
        var remote = new[] { "\\\\attacker.example\\share\\db_log.ldf", "//attacker.example/share/a.ndf", "\\\\?\\C:\\a.ndf", "\\\\.\\pipe\\x\\y" };
        await using var closed = new SqlConnection("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false");
        var unprobed = await ServerFiles.FilesExistAsync(closed, [.. remote, "relative.ndf", ""], CancellationToken.None);
        check(local.All(path => ServerPath.Local(path, 260)) && !remote.Any(path => ServerPath.Local(path, 260)) && !ServerPath.Local("relative.ndf", 260)
            && unprobed.SequenceEqual(new bool?[] { null, null, false, null, false, false }) && closed.State == System.Data.ConnectionState.Closed,
            "a primary file's recorded shares and device paths are never probed (the service account would sign in to that host): their existence is unknown, and an invalid path (a device path holding ?) is not found");

        // Validation parity with zod (attachSchema, attachDescribeSchema).
        using var service = new ActionService(new FakeHost());
        string Refused(Func<ObjectRefDto> validate)
        {
            try { validate(); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        ActionArgs Attach(List<AttachDatabaseDto>? databases, ObjectRefDto? target = null) => new("attach", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target ?? Server, Databases: databases);
        AttachDatabaseDto One(string name = "Sales", string? owner = null, params string[] files) => new(name, files.Length == 0 ? ["C:\\Data\\Sales.mdf"] : [.. files], false, owner);
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("no databases", Attach(null)), ("an empty list", Attach([])), ("17 databases", Attach([.. Enumerable.Range(0, 17).Select(index => One("d" + index))])),
            ("a name twice", Attach([One("A"), One("A")])), ("an empty name", Attach([One("")])), ("129 units", Attach([One(new string('x', 129))])), ("U+0000", Attach([One("a\0b")])),
            ("an owner of 129 units", Attach([One(owner: new string('x', 129))])), ("no files", Attach([new("A", [], false)])), ("1,001 files", Attach([new("A", [.. Enumerable.Range(0, 1001).Select(index => "C:\\f" + index + ".ndf")], false)])),
            ("a file twice", Attach([One("A", null, "C:\\a.mdf", "C:\\a.mdf")])), ("a relative path", Attach([One("A", null, "a.mdf")])), ("a 261-unit path", Attach([One("A", null, "C:\\" + new string('x', 258))])),
            ("a database target", Attach([One()], new ObjectRefDto("database", Name: "Sales"))), ("a named server", Attach([One()], new ObjectRefDto("server", Name: "x"))),
            ("a new name", Attach([One()]) with { NewName = "x" }), ("delete options", Attach([One()]) with { CloseConnections = false, DeleteHistory = false }),
            ("databases on a delete", new("delete", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new ObjectRefDto("database", Name: "Sales"), CloseConnections: false, DeleteHistory: false, Databases: [One()])),
            ("databases on a rename", new("rename", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new ObjectRefDto("database", Name: "Sales"), NewName: "Hr", Databases: [One()]))
        };
        var accepted = invalid.Where(item => Refused(() => service.Validate(item.Args)) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        ActionDescribeArgs Describe(string dialog, string? mdf, ObjectRefDto? target = null) => new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), dialog, target ?? Server, Attach: mdf is null ? null : new(mdf));
        var describeRefused = new (string Name, ActionDescribeArgs Args)[]
        {
            ("attach on Delete Object", Describe("deleteObject", "C:\\a.mdf", new ObjectRefDto("database", Name: "Sales"))), ("an empty path", Describe("attachDatabase", "")),
            ("a relative path", Describe("attachDatabase", "a.mdf")), ("a database target", Describe("attachDatabase", null, new ObjectRefDto("database", Name: "Sales")))
        }.Where(item => Refused(() => service.Validate(item.Args)) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        check(accepted.Count == 0 && describeRefused.Count == 0
            && Refused(() => service.Validate(Attach([One("O'Brien ]]", "app_owner", "\\\\files\\share\\O'Brien ]].mdf", "/var/opt/mssql/data/x.ldf"), .. Enumerable.Range(0, 15).Select(index => One("d" + index))]))) == "accepted"
            && Refused(() => service.Validate(Attach([One()]), script: true)) == "accepted"
            && Refused(() => service.Validate(Describe("attachDatabase", null))) == "accepted" && Refused(() => service.Validate(Describe("attachDatabase", "C:\\Data\\O'Brien ]].mdf"))) == "accepted",
            "Validate refuses what zod refuses for Attach Databases and accepts 16 databases, hostile names and paths verbatim: " + string.Join(", ", accepted.Concat(describeRefused)));

        check(ActionService.OnBrowseGate(Describe("attachDatabase", "C:\\Data\\Sales.mdf")) && !ActionService.OnBrowseGate(Describe("attachDatabase", null))
            && !ActionService.OnBrowseGate(Describe("deleteObject", null, new ObjectRefDto("database", Name: "Sales"))),
            "Add's describe, which waits on the file system, takes the picker's gate; the dialog's opening read and other describes take the read gates");

        // Attach runs on SQL Server's box editions alone (decision 10): Managed Instance and Azure SQL Database answer NOT_SUPPORTED before any connection.
        foreach (var edition in new[] { 5, 8 })
        {
            var host = new FakeHost(edition);
            using var gated = new ActionService(host);
            var described = await gated.DescribeAsync(Describe("attachDatabase", null), CancellationToken.None);
            var scripted = await gated.ScriptAsync(Attach([One()]), CancellationToken.None);
            var executed = await gated.ExecuteAsync(Attach([One()]), CancellationToken.None);
            check(described is { Error.Code: "NOT_SUPPORTED", AttachDatabase: null } && scripted is { Error.Code: "NOT_SUPPORTED", Text: null } && executed is { Error.Code: "NOT_SUPPORTED", Steps: [] }
                && host.Connections == 0 && gated.RunningCount == 0, "edition " + edition + " answers Attach Databases NOT_SUPPORTED before any connection opens");
        }
        check(Catalog.FolderOf("attach") == "databases" && Catalog.FolderOf("delete") is null && Catalog.Limit("attachDatabases") == 16 && Catalog.Limit("attachFiles") == 1_000,
            "the catalogue offers Attach on the Databases folder, with its limits");
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
        public bool FreeDatabase(string connectionId, string database) => false;
        public IReadOnlySet<int> PoolSessions(string connectionId) => new HashSet<int>();
    }
}
