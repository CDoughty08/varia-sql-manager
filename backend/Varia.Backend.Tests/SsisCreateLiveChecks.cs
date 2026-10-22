using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Live checks of PR S9a, Create Catalog. Always: ssis.catalogSetup on the server says what an independent read says
/// (CLR in use, scan for startup procs, the catalog backup and the files' places, or why not: Linux, no sysadmin, a catalog
/// that exists, Integration Services not installed), and changes nothing. With VARIA_TEST_SQL_SCRATCH=1 and Integration Services
/// on the server: the dry run (the internal SsisOptions.CreateScratch) restores the catalog backup into a marked
/// VariaScratch_…_ssiscc database through the product's own steps, with a 128-character password made to break out of quotes,
/// brackets and comments, which then opens the master key while another does not; a second run is CATALOG_EXISTS; a step that
/// fails after the restore removes the database; Stop after the restore began is answered only once it finished; Stop before it
/// creates nothing. The dry run never touches CLR, the assembly trust, sp_ssis_startup, logins or jobs, and checks so. With
/// VARIA_TEST_SSIS_CREATE=1 only (a server whose owner allows it; never set by default), the destructive check: it drops an
/// existing SSISDB with what SSMS's DropCatalog does, creates the catalog with Varia, checks what SSMS's Create leaves, and
/// removes it again (restoring CLR) unless a catalog was there before. Passwords are never printed.</summary>
internal static class SsisCreateLiveChecks
{
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Dump(object? value) => JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
    private static readonly string[] Titles = [.. SsisCatalog.Current.Action("createCatalog")!.Steps];

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        async Task<SqlRun> Sql(string text, string database = "master")
        {
            var id = Guid.NewGuid().ToString();
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(info.Id, id, database, text, Guid.NewGuid().ToString(), 100_000, 300, StopOnError: true), json), json);
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(id), json), json); }
        }
        var options = service.Ssis.Options;
        var facts = (await Sql("SELECT CONVERT(int, SERVERPROPERTY('ProductMajorVersion')), (SELECT CONVERT(int, c.value_in_use) FROM sys.configurations AS c WHERE c.name = N'clr enabled'), "
            + "(SELECT CONVERT(int, c.value) FROM sys.configurations AS c WHERE c.name = N'scan for startup procs'), CASE WHEN DB_ID(N'SSISDB') IS NULL THEN 0 ELSE 1 END, "
            + "CONVERT(int, IS_SRVROLEMEMBER(N'sysadmin')), (SELECT h.host_platform FROM sys.dm_os_host_info AS h), CONVERT(nvarchar(1024), SERVERPROPERTY('MasterFile'));")).Sets[0][0];
        var major = int.Parse(facts[0]!, CultureInfo.InvariantCulture);
        bool clr = facts[1] == "1", scan = facts[2] == "1", exists = facts[3] == "1", sysadmin = facts[4] == "1", linux = facts[5] == "Linux";
        var objects = await ServerObjectsAsync(Sql);
        var watch = Stopwatch.StartNew();
        var setup = await service.Ssis.CatalogSetupAsync(new(info.Id, Guid.NewGuid().ToString()), CancellationToken.None);
        var expectedBackup = SsisCatalog.Current.BackupFile(major);
        if (linux) check(setup is { Setup: null, Error: { Code: "NOT_SUPPORTED", Message: "The SSIS Catalog isn't supported on SQL Server on Linux." } }, "ssis.catalogSetup refuses SQL Server on Linux before it reads: " + Dump(setup));
        else if (!sysadmin) check(setup is { Setup: null, Error.Code: "PERMISSION_DENIED" }, "ssis.catalogSetup refuses a login that is not sysadmin, as SSMS does: " + Dump(setup));
        else if (exists) check(setup is { Setup: null, Error.Code: "CATALOG_EXISTS" }, "ssis.catalogSetup answers CATALOG_EXISTS while SSISDB exists: " + Dump(setup));
        else if (setup.Setup is { } found)
        {
            var directory = facts[6]![..facts[6]!.LastIndexOf('\\')] + "\\";
            check(found.Catalog == "SSISDB" && found.ClrEnabled == clr && found.StartupDefault == scan && found.BackupFile.EndsWith(@"\DTS\Binn\" + expectedBackup, StringComparison.OrdinalIgnoreCase)
                && string.Equals(found.DataFile, directory + "SSISDB.mdf", StringComparison.OrdinalIgnoreCase) && string.Equals(found.LogFile, directory + "SSISDB.ldf", StringComparison.OrdinalIgnoreCase),
                "ssis.catalogSetup reads what SSMS's Create reads: CLR in use (" + clr + "), scan for startup procs (" + scan + "), the " + expectedBackup + " in the registry's DTS folder, and the new files beside master.mdf: " + Dump(setup));
        }
        else check(setup.Error?.Code == "NOT_SUPPORTED" && setup.Error.Message.Contains("catalog backup file", StringComparison.Ordinal),
            "without the Integration Services catalog backup, ssis.catalogSetup answers SSMS's NOT_SUPPORTED: " + Dump(setup));
        check(watch.ElapsedMilliseconds < 15_000 && await ServerObjectsAsync(Sql) == objects, "ssis.catalogSetup changes nothing on the server and answers within 15 s (" + watch.ElapsedMilliseconds + " ms)");

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1" || linux || !sysadmin)
        {
            Console.WriteLine("Create Catalog's dry run is skipped: it needs VARIA_TEST_SQL_SCRATCH=1, SQL Server on Windows and sysadmin.");
            return;
        }
        await using (var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database)))
        {
            var db = scratch.SsisCreate;
            scratch.Adopt(db);
            try
            {
                options.CreateScratch = db;
                var dry = await service.Ssis.CatalogSetupAsync(new(info.Id, Guid.NewGuid().ToString()), CancellationToken.None);
                if (dry.Setup is null)
                {
                    Console.WriteLine("Create Catalog's dry run is skipped: " + dry.Error?.Message);
                    return;
                }
                check(dry.Setup.Catalog == db && dry.Setup.DataFile.EndsWith("\\" + db + ".mdf", StringComparison.Ordinal) && dry.Setup.LogFile.EndsWith("\\" + db + ".ldf", StringComparison.Ordinal),
                    "the dry run's setup names its scratch database and files: " + Dump(dry));
                await DryRunAsync(check, service, info, Sql, db, dry.Setup, objects);
            }
            finally
            {
                options.CreateScratch = null;
                options.BeforeCreateStep = null;
                options.BeforeWrite = null;
                options.StopGrace = new SsisOptions().StopGrace;
            }
        }
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SSIS_CREATE") == "1") await DestructiveAsync(check, service, info, Sql, clr, exists);
        else Console.WriteLine("Create Catalog's destructive check is skipped: it creates and drops SSISDB, so it runs only with VARIA_TEST_SSIS_CREATE=1 on a server whose owner allows it.");
    }

    /// <summary>What only a real Create Catalog makes on the server: the startup procedure, the SSIS jobs, the cleanup login, trusted
    /// assemblies and the assembly loading login. The dry run and the setup read must leave it as it was.</summary>
    private static async Task<string> ServerObjectsAsync(Func<string, string, Task<SqlRun>> sql)
    {
        var run = await sql("SELECT (SELECT COUNT(*) FROM master.sys.procedures WHERE name = N'sp_ssis_startup'), (SELECT COUNT(*) FROM msdb.dbo.sysjobs WHERE name LIKE N'SSIS %'), "
            + "(SELECT COUNT(*) FROM sys.server_principals WHERE name LIKE N'##MS[_]SSIS%' OR name = N'##MS_SQLEnableSystemAssemblyLoadingUser##'), "
            + "(SELECT COUNT(*) FROM sys.all_objects WHERE name = N'trusted_assemblies' AND schema_id = SCHEMA_ID(N'sys')), (SELECT CONVERT(int, value_in_use) FROM sys.configurations WHERE name = N'clr enabled');", "master");
        var row = run.Sets[0][0];
        var trusted = row[3] == "1" ? (await sql("SELECT COUNT(*) FROM sys.trusted_assemblies;", "master")).Scalar : "-";
        return string.Join(",", row[0], row[1], row[2], trusted, row[4]);
    }

    private static Task<SsisExecuteResult> CreateAsync(SqlService service, string connectionId, string password, CancellationToken token = default, bool startup = false) =>
        service.SsisActions.ExecuteAsync(new(connectionId, Guid.NewGuid().ToString(), new SsisActionDto("createCatalog", Password: password, EnableClr: true, StartupProcedure: startup)), token);

    /// <summary>128 UTF-16 code units made to end a string, a bracketed name, a line and a comment, with characters outside any code page.</summary>
    private static string HostilePassword()
    {
        var text = "'];--/*ü\U0001D49C*/\"" + Convert.ToHexString(RandomNumberGenerator.GetBytes(16)) + "'' N'x";
        return (text + new string('p', 128))[..128];
    }

    private static async Task DryRunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, string, Task<SqlRun>> sql, string db, SsisCatalogSetupDto setup, string objects)
    {
        var options = service.Ssis.Options;
        async Task Mark()
        {
            var marked = await sql("EXEC sys.sp_addextendedproperty @name = N'varia.scratch', @value = 1;", db);
            if (marked.Status != "completed") throw new InvalidOperationException("The dry run's database could not be marked: " + marked.Error);
        }
        async Task<string?> State() => (await sql("SELECT CONCAT(d.state, ' ', d.is_read_only) FROM sys.databases AS d WHERE d.name = " + Literal(db) + ";", "master")).Scalar;
        async Task Drop()
        {
            var dropped = await sql("IF DB_ID(" + Literal(db) + ") IS NOT NULL BEGIN ALTER DATABASE " + Bracket(db) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE " + Bracket(db) + "; END", "master");
            if (dropped.Status != "completed") throw new InvalidOperationException("The dry run's database could not be dropped: " + dropped.Error);
        }
        var password = HostilePassword();
        string[] Statuses(SsisExecuteResult result) => [.. result.Steps.Select(step => step.Status + " " + step.Message)];

        // The product's restore and master key, with the dry run's name for the database.
        options.BeforeCreateStep = async title => { if (title == Titles[2]) await Mark(); };
        var created = await CreateAsync(service, info.Id, password);
        var files = await sql("SELECT f.physical_name FROM sys.master_files AS f WHERE f.database_id = DB_ID(" + Literal(db) + ") ORDER BY f.type, f.file_id;", "master");
        var key = await sql("SELECT COUNT(*) FROM sys.symmetric_keys WHERE name = N'##MS_DatabaseMasterKey##';", db);
        var opened = await sql("OPEN MASTER KEY DECRYPTION BY PASSWORD = " + Literal(password) + "; CLOSE MASTER KEY; SELECT 1;", db);
        var wrong = await sql("OPEN MASTER KEY DECRYPTION BY PASSWORD = N'not the password';", db);
        check(created is { Error: null } && Statuses(created).SequenceEqual(["done " + Titles[1], "done " + Titles[2]]) && await State() == "0 0" && key.Scalar == "1"
            && opened.Status == "completed" && wrong.Status != "completed" && files.Sets[0].Select(row => row[0]).SequenceEqual([setup.DataFile, setup.LogFile], StringComparer.OrdinalIgnoreCase),
            "the dry run restores the catalog backup online, read-write, to the setup's files, and its master key opens with the 128-character password that breaks out of quotes, brackets and comments, "
            + "and with no other: " + Dump(created.Steps) + " " + Dump(files.Sets));
        var again = await CreateAsync(service, info.Id, password);
        check(again is { Steps: [], Error: { Code: "CATALOG_EXISTS", Retryable: false } } && await State() == "0 0", "a second Create Catalog is refused before it changes anything: " + Dump(again));
        await Drop();

        // A step that fails after the restore removes the database it restored.
        options.BeforeCreateStep = async title =>
        {
            if (title != Titles[2]) return;
            await Mark();
            var readOnly = await sql("ALTER DATABASE " + Bracket(db) + " SET READ_ONLY WITH ROLLBACK IMMEDIATE;", "master");
            if (readOnly.Status != "completed") throw new InvalidOperationException("The dry run's database could not be made read-only: " + readOnly.Error);
        };
        var failed = await CreateAsync(service, info.Id, password);
        check(failed.Error is { Code: "SQL_ERROR" } error && error.Message.Contains("Varia removed what Create Catalog had created, so the catalog does not exist.", StringComparison.Ordinal)
            && !error.Message.Contains(password[..8], StringComparison.Ordinal) && failed.Steps.Select(step => step.Status).SequenceEqual(["done", "failed", "done"])
            && failed.Steps[^1].Message == SsisCatalog.Current.CleanupStep && await State() is null,
            "a step that fails after the restore removes the database it restored, says so, and never echoes the password: " + Dump(failed));

        // Stop once the restore began: the reply waits past the grace for Create Catalog to finish, and it does.
        options.StopGrace = TimeSpan.FromMilliseconds(300);
        using (var stop = new CancellationTokenSource())
        {
            options.BeforeCreateStep = async title =>
            {
                if (title != Titles[2]) return;
                await Mark();
                await stop.CancelAsync();
                await Task.Delay(1500);
            };
            var watch = Stopwatch.StartNew();
            var held = await CreateAsync(service, info.Id, password, stop.Token);
            check(held is { Error: null } && held.Steps.All(step => step.Status == "done") && watch.ElapsedMilliseconds >= 1400 && await State() == "0 0",
                "Stop after the restore began cannot stop Create Catalog: the reply waits past its grace until it finished (" + watch.ElapsedMilliseconds + " ms): " + Dump(held));
        }
        await Drop();

        // Stop before the restore: nothing is created.
        options.BeforeCreateStep = null;
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        options.BeforeWrite = async token => { reached.TrySetResult(); await Task.Delay(Timeout.Infinite, token); };
        using (var stop = new CancellationTokenSource())
        {
            var running = CreateAsync(service, info.Id, password, stop.Token);
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(30));
            await stop.CancelAsync();
            var early = await running;
            check(early is { Steps: [], Error: { Code: "CANCELLED", Message: "The action was stopped before it changed anything." } } && await State() is null,
                "Stop before the restore ends Create Catalog at once with nothing created: " + Dump(early));
        }
        options.BeforeWrite = null;
        check(await ServerObjectsAsync(sql) == objects && service.SsisActions.ActiveJobs == 0,
            "the dry run never touched CLR, the assembly trust, sp_ssis_startup, the SSIS jobs or their logins, and every job ended");
    }

    /// <summary>VARIA_TEST_SSIS_CREATE=1 only: SSMS's DropCatalog for an existing catalog, then Varia's Create Catalog for real, what SSMS's
    /// Create leaves checked, a second Create refused, and the catalog removed again unless one was there before (CLR restored).</summary>
    private static async Task DestructiveAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, string, Task<SqlRun>> sql, bool clrBefore, bool existed)
    {
        const string DropCatalog = "IF EXISTS (SELECT 1 FROM master.sys.procedures WHERE name = N'sp_ssis_startup') BEGIN EXEC master.sys.sp_procoption N'sp_ssis_startup', 'startup', 'off'; DROP PROCEDURE dbo.sp_ssis_startup; END\n"
            + "IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = N'SSIS Server Maintenance Job') EXEC msdb.dbo.sp_delete_job @job_name = N'SSIS Server Maintenance Job';\n"
            + "IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = N'SSIS Failover Monitor Job') EXEC msdb.dbo.sp_delete_job @job_name = N'SSIS Failover Monitor Job';\n"
            + "IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'##MS_SSISServerCleanupJobLogin##') DROP LOGIN [##MS_SSISServerCleanupJobLogin##];\n"
            + "IF DB_ID(N'SSISDB') IS NOT NULL AND EXISTS (SELECT 1 FROM sys.all_objects WHERE name = N'trusted_assemblies' AND schema_id = SCHEMA_ID(N'sys'))\n"
            + "BEGIN\n"
            + "    DECLARE @hash varbinary(64);\n"
            + "    EXEC sys.sp_executesql N'SELECT @h = HASHBYTES(''SHA2_512'', af.content) FROM [SSISDB].sys.assembly_files AS af JOIN [SSISDB].sys.assemblies AS a ON a.assembly_id = af.assembly_id WHERE a.name = N''ISSERVER'' AND af.file_id = 1;', N'@h varbinary(64) OUTPUT', @h = @hash OUTPUT;\n"
            + "    IF @hash IS NOT NULL AND EXISTS (SELECT 1 FROM sys.trusted_assemblies WHERE hash = @hash) EXEC sys.sp_drop_trusted_assembly @hash;\n"
            + "END\n"
            + "IF DB_ID(N'SSISDB') IS NOT NULL BEGIN ALTER DATABASE [SSISDB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [SSISDB]; END";
        async Task Drop()
        {
            var dropped = await sql(DropCatalog, "master");
            if (dropped.Status != "completed") throw new InvalidOperationException("SSISDB could not be dropped: " + dropped.Error);
        }
        var options = service.Ssis.Options;
        Console.WriteLine("VARIA_TEST_SSIS_CREATE=1: Create Catalog's destructive check " + (existed ? "drops this server's SSISDB, then creates it again." : "creates SSISDB on this server, then removes it."));
        var password = HostilePassword();
        try
        {
            if (existed) await Drop();
            options.CatalogDatabase = SsisCatalog.Current.CatalogDatabase;
            var created = await CreateAsync(service, info.Id, password, startup: true);
            var state = (await sql("SELECT d.state, d.is_read_only, (SELECT CONVERT(int, c.value_in_use) FROM sys.configurations AS c WHERE c.name = N'clr enabled'), "
                + "(SELECT CONVERT(int, p.is_auto_executed) FROM master.sys.procedures AS p WHERE p.name = N'sp_ssis_startup'), "
                + "(SELECT CONVERT(int, l.is_disabled) FROM sys.server_principals AS l WHERE l.name = N'##MS_SSISServerCleanupJobLogin##'), "
                + "(SELECT COUNT(*) FROM msdb.dbo.sysjobs AS j JOIN msdb.dbo.sysjobsteps AS s ON s.job_id = j.job_id WHERE j.name = N'SSIS Server Maintenance Job'), "
                + "(SELECT COUNT(*) FROM msdb.dbo.sysjobs AS j JOIN msdb.dbo.sysjobschedules AS js ON js.job_id = j.job_id JOIN msdb.dbo.sysschedules AS sc ON sc.schedule_id = js.schedule_id "
                + "WHERE j.name = N'SSIS Server Maintenance Job' AND sc.name = N'SSISDB Scheduler' AND sc.freq_type = 4), "
                + "(SELECT SUSER_SNAME(j.owner_sid) FROM msdb.dbo.sysjobs AS j WHERE j.name = N'SSIS Server Maintenance Job') FROM sys.databases AS d WHERE d.name = N'SSISDB';", "master")).Sets[0];
            var inside = await sql("SELECT (SELECT COUNT(*) FROM sys.symmetric_keys WHERE name = N'##MS_DatabaseMasterKey##'), (SELECT COUNT(*) FROM [catalog].[catalog_properties] WHERE property_name = N'SCHEMA_VERSION'), "
                + "(SELECT COUNT(*) FROM sys.database_permissions AS p JOIN sys.database_principals AS u ON u.principal_id = p.grantee_principal_id "
                + "WHERE u.name = N'##MS_SSISServerCleanupJobUser##' AND p.permission_name = N'EXECUTE');", "SSISDB");
            var opened = await sql("OPEN MASTER KEY DECRYPTION BY PASSWORD = " + Literal(password) + "; CLOSE MASTER KEY; SELECT 1;", "SSISDB");
            var describe = await service.Ssis.DescribeAsync(new SsisDescribeArgs(info.Id, Guid.NewGuid().ToString(), "catalog", new ObjectRefDto("ssisCatalog", Name: "SSISDB")), CancellationToken.None);
            check(created is { Error: null } && created.Steps.All(step => step.Status == "done") && state.Count == 1 && state[0][0] == "0" && state[0][1] == "0" && state[0][2] == "1" && state[0][3] == "1"
                && state[0][4] == "1" && state[0][5] == "2" && state[0][6] == "1" && state[0][7] == "##MS_SSISServerCleanupJobLogin##" && inside.Status == "completed" && inside.Sets[0][0][0] == "1"
                && inside.Sets[0][0][1] == "1" && inside.Sets[0][0][2] == "2" && opened.Status == "completed" && describe is { Error: null, Model: SsisCatalogModel },
                "Create Catalog creates what SSMS's does: SSISDB online and read-write with its master key (opening with the password), CLR in use, sp_ssis_startup at startup, the disabled cleanup login and its "
                + "user's two grants, the SSIS Server Maintenance Job with two steps and its daily schedule, owned by that login; and the catalog reads: " + Dump(created) + " " + Dump(state) + " " + Dump(describe.Error));
            var again = await CreateAsync(service, info.Id, password);
            check(again is { Steps: [], Error.Code: "CATALOG_EXISTS" }, "a second Create Catalog on a server with SSISDB is refused: " + Dump(again));
        }
        finally
        {
            service.Ssis.Forget(info.Id);
            if (!existed)
            {
                await Drop();
                if (!clrBefore) await sql("EXEC sys.sp_configure N'clr enabled', 0; RECONFIGURE;", "master");
            }
        }
    }
}
