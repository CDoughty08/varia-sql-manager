using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Live checks of PR S9a, Create Catalog. Always: ssis.catalogSetup on the server says what an independent read says
/// (CLR in use, scan for startup procs, the catalog backup and the files' places, or why not: Linux, no sysadmin, a catalog
/// that exists, other configuration changes a RECONFIGURE would apply, Integration Services not installed), and leaves what only
/// Create Catalog makes as it was. With VARIA_TEST_SQL_SCRATCH=1 and Integration Services on the server: the dry run (the internal
/// SsisOptions.CreateScratch) restores the catalog backup into a marked VariaScratch_…_ssiscc database through the product's own
/// steps, with a 128-character password made to break out of quotes, brackets and comments and holding apostrophes a
/// width-insensitive collation confuses with ', which then opens the master key while another does not; a second run is
/// CATALOG_EXISTS; a step that fails after the restore removes the database; Stop during the restore lets it end and then removes
/// it; Stop while the master key waits for another session's lock ends it within the grace and removes the database; Stop before
/// the restore creates nothing. The dry run never touches CLR, the assembly trust, sp_ssis_startup, logins or jobs, and checks so.
/// With VARIA_TEST_SSIS_CREATE=1 only (a server whose owner allows it; never set by default), and only on a server without SSISDB
/// (it never drops a catalog it did not create): the destructive check creates the catalog with Varia, checks what SSMS's Create
/// leaves, removes it, creates it again with the startup procedure chosen and makes its last step fail, and checks that the
/// server is as before (CLR restored). Passwords are never printed.</summary>
internal static class SsisCreateLiveChecks
{
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Dump(object? value) => JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
    private static readonly string[] Titles = [.. SsisCatalog.Current.Action("createCatalog")!.Steps];
    /// <summary>The dynamic configuration changes a RECONFIGURE would apply besides CLR, as the setup read finds them.</summary>
    private const string PendingRead = "SELECT COUNT(*) FROM sys.configurations AS c WHERE c.is_dynamic = 1 AND c.value <> c.value_in_use AND c.name <> N'clr enabled' "
        + "AND NOT (c.name = N'min server memory (MB)' AND CONVERT(int, c.value) = 0);";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
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
        var pending = (await Sql(PendingRead)).Scalar != "0";
        var objects = await ServerObjectsAsync(Sql);
        var watch = Stopwatch.StartNew();
        var setup = await service.Ssis.CatalogSetupAsync(new(info.Id, Guid.NewGuid().ToString()), CancellationToken.None);
        var elapsed = watch.Elapsed;
        var expectedBackup = SsisCatalog.Current.BackupFile(major);
        if (linux) check(setup is { Setup: null, Error: { Code: "NOT_SUPPORTED", Message: "The SSIS Catalog isn't supported on SQL Server on Linux." } }, "ssis.catalogSetup refuses SQL Server on Linux before it reads: " + Dump(setup));
        else if (!sysadmin) check(setup is { Setup: null, Error.Code: "PERMISSION_DENIED" }, "ssis.catalogSetup refuses a login that is not sysadmin, as SSMS does: " + Dump(setup));
        else if (exists) check(setup is { Setup: null, Error.Code: "CATALOG_EXISTS" }, "ssis.catalogSetup answers CATALOG_EXISTS while SSISDB exists: " + Dump(setup));
        else if (setup.Setup is { } found)
        {
            var directory = facts[6]![..facts[6]!.LastIndexOf('\\')] + "\\";
            check(!(pending && !clr) && found.Catalog == "SSISDB" && found.ClrEnabled == clr && found.StartupDefault == scan && found.BackupFile.EndsWith(@"\DTS\Binn\" + expectedBackup, StringComparison.OrdinalIgnoreCase)
                && string.Equals(found.DataFile, directory + "SSISDB.mdf", StringComparison.OrdinalIgnoreCase) && string.Equals(found.LogFile, directory + "SSISDB.ldf", StringComparison.OrdinalIgnoreCase),
                "ssis.catalogSetup reads what SSMS's Create reads: CLR in use (" + clr + "), scan for startup procs (" + scan + "), the " + expectedBackup + " in the registry's DTS folder, the new files "
                + "beside master.mdf, and no other configuration change waiting for RECONFIGURE (" + pending + "): " + Dump(setup));
        }
        else if (setup.Error?.Code == "CONFIGURATION_PENDING")
            check(pending && !clr && setup.Error.Message.Contains("RECONFIGURE", StringComparison.Ordinal),
                "ssis.catalogSetup refuses to enable CLR while other configuration changes wait for RECONFIGURE, as an independent read finds them: " + Dump(setup));
        else check(setup.Error?.Code == "NOT_SUPPORTED" && setup.Error.Message.Contains("catalog backup file", StringComparison.Ordinal),
            "without the Integration Services catalog backup, ssis.catalogSetup answers SSMS's NOT_SUPPORTED: " + Dump(setup));
        // Bounded by the read's own budget, not a guess at a shared server's speed; and what only Create Catalog makes is unchanged.
        check(elapsed < options.Budget + TimeSpan.FromSeconds(5) && await ServerObjectsAsync(Sql) == objects,
            "ssis.catalogSetup changes nothing Create Catalog makes and answers within its " + (int)options.Budget.TotalSeconds + " s budget (" + (long)elapsed.TotalMilliseconds + " ms)");

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
                await DryRunAsync(check, service, info, Sql, live, db, dry.Setup, objects);
            }
            finally
            {
                options.CreateScratch = null;
                options.BeforeCreateStep = null;
                options.BeforeWrite = null;
                options.StopGrace = new SsisOptions().StopGrace;
            }
        }
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SSIS_CREATE") != "1")
            Console.WriteLine("Create Catalog's destructive check is skipped: it creates and drops SSISDB, so it runs only with VARIA_TEST_SSIS_CREATE=1 on a server whose owner allows it.");
        else if (exists)
            Console.WriteLine("Create Catalog's destructive check is skipped: this server has an SSISDB, and the check never drops a catalog it did not create (its projects, environments, "
                + "history and master key password would be lost). Run it on a server without SSISDB.");
        else if (pending && !clr)
            Console.WriteLine("Create Catalog's destructive check is skipped: other configuration changes wait for RECONFIGURE on this server, so Create Catalog refuses to enable CLR.");
        else await DestructiveAsync(check, service, info, Sql, clr, objects);
    }

    /// <summary>What only a real Create Catalog makes on the server: the startup procedure, the SSIS jobs, the SSIS logins and the
    /// assembly loading login, the trusted assembly of the Integration Services assembly (by its description, the path Create Catalog
    /// gives it), and CLR in use. Other runs on a shared server change none of them; the dry run and the setup read must not either.</summary>
    private static async Task<string> ServerObjectsAsync(Func<string, string, Task<SqlRun>> sql)
    {
        var run = await sql("SELECT (SELECT COUNT(*) FROM master.sys.procedures WHERE name = N'sp_ssis_startup'), (SELECT COUNT(*) FROM msdb.dbo.sysjobs WHERE name LIKE N'SSIS %'), "
            + "(SELECT COUNT(*) FROM sys.server_principals WHERE name LIKE N'##MS[_]SSIS%' OR name = N'##MS_SQLEnableSystemAssemblyLoadingUser##'), "
            + "(SELECT COUNT(*) FROM sys.all_objects WHERE name = N'trusted_assemblies' AND schema_id = SCHEMA_ID(N'sys')), (SELECT CONVERT(int, value_in_use) FROM sys.configurations WHERE name = N'clr enabled');", "master");
        var row = run.Sets[0][0];
        var trusted = row[3] == "1" ? (await sql("SELECT COUNT(*) FROM sys.trusted_assemblies WHERE description LIKE N'%" + SsisCatalog.Current.AssemblyFile + "';", "master")).Scalar : "-";
        return string.Join(",", row[0], row[1], row[2], trusted, row[4]);
    }

    private static Task<SsisExecuteResult> CreateAsync(SqlService service, string connectionId, string password, CancellationToken token = default, bool startup = false, string? requestId = null) =>
        service.SsisActions.ExecuteAsync(new(connectionId, requestId ?? Guid.NewGuid().ToString(), new SsisActionDto("createCatalog", Password: password, EnableClr: true, StartupProcedure: startup)), token);

    /// <summary>128 UTF-16 code units made to end a string, a bracketed name, a line and a comment, with characters outside any code page
    /// and apostrophes a width- or kana-insensitive collation could take for ' (U+FF07, U+2019, U+02BC).</summary>
    private static string HostilePassword()
    {
        var text = "'];--/*ü\U0001D49C*/\"＇x’yʼz" + Convert.ToHexString(RandomNumberGenerator.GetBytes(16)) + "'' N'x＇";
        return (text + new string('p', 128))[..128];
    }

    private static async Task DryRunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, string, Task<SqlRun>> sql, Func<string, ConnectOptions> live, string db,
        SsisCatalogSetupDto setup, string objects)
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
        // A check that throws (a lost session, a hook's failure) is a named failure (a failed check throws already), and the database
        // it left is dropped.
        async Task Guarded(string name, Func<Task> body)
        {
            try { await body(); }
            catch (Exception error) when (!error.Message.StartsWith("FAIL: ", StringComparison.Ordinal)) { check(false, name + " threw " + error.GetType().Name + ": " + error.Message); }
            finally { options.BeforeCreateStep = null; await Drop(); }
        }

        // The product's restore and master key, with the dry run's name for the database.
        await Guarded("the dry run restores the catalog backup and creates its master key", async () =>
        {
            options.BeforeCreateStep = async title => { if (title == Titles[2]) await Mark(); };
            var created = await CreateAsync(service, info.Id, password);
            var files = await sql("SELECT f.physical_name FROM sys.master_files AS f WHERE f.database_id = DB_ID(" + Literal(db) + ") ORDER BY f.type, f.file_id;", "master");
            var key = await sql("SELECT COUNT(*) FROM sys.symmetric_keys WHERE name = N'##MS_DatabaseMasterKey##';", db);
            var opened = await sql("OPEN MASTER KEY DECRYPTION BY PASSWORD = " + Literal(password) + "; CLOSE MASTER KEY; SELECT 1;", db);
            // The same password with each look-alike apostrophe made ASCII, which a REPLACE in the database's collation would have stored.
            var folded = await sql("OPEN MASTER KEY DECRYPTION BY PASSWORD = " + Literal(password.Replace('＇', '\'').Replace('’', '\'').Replace('ʼ', '\'')) + ";", db);
            var wrong = await sql("OPEN MASTER KEY DECRYPTION BY PASSWORD = N'not the password';", db);
            check(created is { Error: null } && Statuses(created).SequenceEqual(["done " + Titles[1], "done " + Titles[2]]) && await State() == "0 0" && key.Scalar == "1"
                && opened.Status == "completed" && folded.Status != "completed" && wrong.Status != "completed"
                && files.Sets[0].Select(row => row[0]).SequenceEqual([setup.DataFile, setup.LogFile], StringComparer.OrdinalIgnoreCase),
                "the dry run restores the catalog backup online, read-write, to the setup's files, and its master key opens with the 128-character password that breaks out of quotes, brackets and "
                + "comments, exactly as typed (not with its look-alike apostrophes made ASCII), and with no other: " + Dump(created.Steps) + " " + Dump(files.Sets));
            var again = await CreateAsync(service, info.Id, password);
            check(again is { Steps: [], Error: { Code: "CATALOG_EXISTS", Retryable: false } } && await State() == "0 0", "a second Create Catalog is refused before it changes anything: " + Dump(again));
        });

        // A step that fails after the restore removes the database it restored.
        await Guarded("a step that fails after the restore removes the database", async () =>
        {
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
        });

        options.StopGrace = TimeSpan.FromSeconds(5);
        // Stop during the restore: SQL Server cannot end it, so the reply waits for it, and then Create Catalog removes what it restored.
        await Guarded("Stop during the restore", async () =>
        {
            using var stop = new CancellationTokenSource();
            var requestId = Guid.NewGuid().ToString();
            var running = CreateAsync(service, info.Id, password, stop.Token, requestId: requestId);
            var restoring = false;
            for (var tries = 0; tries < 400 && !running.IsCompleted && !restoring; tries++)
            {
                if (service.SsisActions.SessionOf(requestId) is { } session)
                    restoring = (await sql("SELECT COUNT(*) FROM sys.dm_exec_requests AS r WHERE r.session_id = " + session.ToString(CultureInfo.InvariantCulture) + " AND r.command LIKE N'RESTORE%';", "master")).Scalar == "1";
                if (!restoring) await Task.Delay(10);
            }
            if (!restoring)
            {
                var finished = await running;
                Console.WriteLine("Stop during the restore is not checked: the restore ended before it could be seen running (" + Dump(finished.Steps) + ").");
                return;
            }
            await stop.CancelAsync();
            var stopped = await running;
            check(stopped is { Error.Code: "CANCELLED" } && Statuses(stopped).SequenceEqual(["done " + Titles[1], "cancelled " + Titles[2], "done " + SsisCatalog.Current.CleanupStep])
                && stopped.Error.Message.Contains("Varia removed what Create Catalog had created", StringComparison.Ordinal) && await State() is null,
                "Stop during the restore lets the restore end, then stops Create Catalog before the master key and removes the database it restored: " + Dump(stopped));
        });

        // Stop while the master key waits for another session's lock (LOCK_TIMEOUT -1): SQL Server ends the wait, and the database goes.
        await Guarded("Stop while a step waits for a lock", async () =>
        {
            await using var holder = new SqlConnection(new SqlConnectionStringBuilder(ConnectionSettings.Build(live(db)).ConnectionString) { Pooling = false, InitialCatalog = "master" }.ConnectionString);
            using var stop = new CancellationTokenSource();
            var requestId = Guid.NewGuid().ToString();
            options.BeforeCreateStep = async title =>
            {
                if (title != Titles[2]) return;
                await Mark();
                await holder.OpenAsync();
                await holder.ChangeDatabaseAsync(db);
                await using var hold = holder.CreateCommand();
                hold.CommandText = "BEGIN TRANSACTION; CREATE MASTER KEY ENCRYPTION BY PASSWORD = N'Varia-holder-" + Guid.NewGuid().ToString("N") + "';";
                await hold.ExecuteNonQueryAsync();
            };
            var running = CreateAsync(service, info.Id, password, stop.Token, requestId: requestId);
            var blocked = false;
            var job = "0";
            for (var tries = 0; tries < 300 && !running.IsCompleted && !blocked; tries++)
            {
                if (service.SsisActions.SessionOf(requestId) is { } session && holder.State == System.Data.ConnectionState.Open)
                {
                    job = session.ToString(CultureInfo.InvariantCulture);
                    blocked = (await sql("SELECT COUNT(*) FROM sys.dm_exec_requests AS r WHERE r.session_id = " + job + " AND r.blocking_session_id = "
                        + holder.ServerProcessId.ToString(CultureInfo.InvariantCulture) + ";", "master")).Scalar == "1";
                }
                if (!blocked) await Task.Delay(50);
            }
            check(blocked, "the master key step waits for the other session's lock (LOCK_TIMEOUT -1), as SSMS waits");
            var watch = Stopwatch.StartNew();
            await stop.CancelAsync();
            // The holder's uncommitted master key also holds locks in master that the removal needs, so it lets go, but only once Stop
            // has ended the step's statement: until then the step would just go on.
            var ended = false;
            for (var tries = 0; tries < 200 && !ended; tries++)
            {
                ended = (await sql("SELECT COUNT(*) FROM sys.dm_exec_requests AS r WHERE r.session_id = " + job + " AND r.database_id = DB_ID(" + Literal(db) + ");", "master")).Scalar == "0";
                if (!ended) await Task.Delay(25);
            }
            await using (var release = holder.CreateCommand())
            {
                release.CommandText = "IF @@TRANCOUNT > 0 ROLLBACK;";
                await release.ExecuteNonQueryAsync();
            }
            check(ended, "Stop ends the step's statement while the other session still holds its lock");
            var stopped = await running;
            check(stopped is { Error.Code: "CANCELLED" } && Statuses(stopped).SequenceEqual(["done " + Titles[1], "cancelled " + Titles[2], "done " + SsisCatalog.Current.CleanupStep])
                && stopped.Error.Message.Contains("SQL Server cancelled that statement", StringComparison.Ordinal) && stopped.Error.Message.Contains("Varia removed what Create Catalog had created", StringComparison.Ordinal)
                && watch.Elapsed < options.StopGrace && await State() is null && service.SsisActions.ActiveJobs == 0,
                "Stop while a step after the restore waits for a lock has SQL Server cancel it, removes the database (ending the other session's hold) and answers within the grace ("
                + watch.ElapsedMilliseconds + " ms): " + Dump(stopped));
        });

        // Stop before the restore: nothing is created.
        await Guarded("Stop before the restore", async () =>
        {
            var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            options.BeforeWrite = async token => { reached.TrySetResult(); await Task.Delay(Timeout.Infinite, token); };
            try
            {
                using var stop = new CancellationTokenSource();
                var running = CreateAsync(service, info.Id, password, stop.Token);
                await reached.Task.WaitAsync(TimeSpan.FromSeconds(30));
                await stop.CancelAsync();
                var early = await running;
                check(early is { Steps: [], Error: { Code: "CANCELLED", Message: "The action was stopped before it changed anything." } } && await State() is null,
                    "Stop before the restore ends Create Catalog at once with nothing created: " + Dump(early));
            }
            finally { options.BeforeWrite = null; }
        });
        check(await ServerObjectsAsync(sql) == objects && service.SsisActions.ActiveJobs == 0,
            "the dry run never touched CLR, the assembly trust, sp_ssis_startup, the SSIS jobs or their logins, and every job ended");
    }

    /// <summary>VARIA_TEST_SSIS_CREATE=1 on a server without SSISDB only: Varia's Create Catalog for real (no startup procedure), what SSMS's
    /// Create leaves checked, a second Create refused, and the catalog removed; then Create Catalog with the startup procedure, whose last
    /// step is made to fail, which must leave the server as it was. CLR is restored. It never drops a catalog it did not create.</summary>
    private static async Task DestructiveAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, string, Task<SqlRun>> sql, bool clrBefore, string objects)
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
        // Only ever run against a catalog this check created: the caller skips a server that had one.
        async Task Drop()
        {
            var dropped = await sql(DropCatalog, "master");
            if (dropped.Status != "completed") throw new InvalidOperationException("The SSISDB this check created could not be dropped: " + dropped.Error);
        }
        var options = service.Ssis.Options;
        Console.WriteLine("VARIA_TEST_SSIS_CREATE=1: Create Catalog's destructive check creates SSISDB on this server, then removes it.");
        var password = HostilePassword();
        try
        {
            options.CatalogDatabase = SsisCatalog.Current.CatalogDatabase;
            var created = await CreateAsync(service, info.Id, password, startup: false);
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
            check(created is { Error: null } && created.Steps.All(step => step.Status == "done") && state.Count == 1 && state[0][0] == "0" && state[0][1] == "0" && state[0][2] == "1" && state[0][3] == "0"
                && state[0][4] == "1" && state[0][5] == "2" && state[0][6] == "1" && state[0][7] == "##MS_SSISServerCleanupJobLogin##" && inside.Status == "completed" && inside.Sets[0][0][0] == "1"
                && inside.Sets[0][0][1] == "1" && inside.Sets[0][0][2] == "2" && opened.Status == "completed" && describe is { Error: null, Model: SsisCatalogModel },
                "Create Catalog creates what SSMS's does: SSISDB online and read-write with its master key (opening with the password), CLR in use, sp_ssis_startup not run at startup when not chosen, "
                + "the disabled cleanup login and its user's two grants, the SSIS Server Maintenance Job with two steps and its daily schedule, owned by that login; and the catalog reads: "
                + Dump(created) + " " + Dump(state) + " " + Dump(describe.Error));
            var again = await CreateAsync(service, info.Id, password);
            check(again is { Steps: [], Error.Code: "CATALOG_EXISTS" }, "a second Create Catalog on a server with SSISDB is refused: " + Dump(again));
            service.Ssis.Forget(info.Id);
            await Drop();
            if (!clrBefore) await sql("EXEC sys.sp_configure N'clr enabled', 0; RECONFIGURE;", "master");

            // The startup choice, and a failure at the last step: everything the earlier steps made is removed.
            string? startupFlag = null;
            options.BeforeCreateStep = async title =>
            {
                if (title != Titles[4]) return;
                startupFlag = (await sql("SELECT CONVERT(int, p.is_auto_executed) FROM master.sys.procedures AS p WHERE p.name = N'sp_ssis_startup';", "master")).Scalar;
                var readOnly = await sql("ALTER DATABASE [SSISDB] SET READ_ONLY WITH ROLLBACK IMMEDIATE;", "master");
                if (readOnly.Status != "completed") throw new InvalidOperationException("SSISDB could not be made read-only: " + readOnly.Error);
            };
            var failed = await CreateAsync(service, info.Id, password, startup: true);
            options.BeforeCreateStep = null;
            var left = (await sql("SELECT CASE WHEN DB_ID(N'SSISDB') IS NULL THEN 0 ELSE 1 END;", "master")).Scalar;
            if (!clrBefore) await sql("EXEC sys.sp_configure N'clr enabled', 0; RECONFIGURE;", "master");
            var after = await ServerObjectsAsync(sql);
            check(startupFlag == "1" && failed.Error is { Code: "SQL_ERROR" } error && error.Message.Contains("Varia removed what Create Catalog had created", StringComparison.Ordinal)
                && failed.Steps.Select(step => step.Status).SequenceEqual([.. clrBefore ? Array.Empty<string>() : ["done"], "done", "done", "done", "failed", "done"]) && left == "0" && after == objects,
                "Create Catalog marks sp_ssis_startup to run at startup when chosen, and a failure at its last step removes the trusted hash, sp_ssis_startup, the jobs, the cleanup login and SSISDB, "
                + "so the server is as before: " + Dump(failed) + " " + after + " / " + objects);
        }
        finally
        {
            options.BeforeCreateStep = null;
            service.Ssis.Forget(info.Id);
            // The caller runs this only on a server that had no SSISDB, so whatever SSISDB is here now, this check created it.
            await Drop();
            if (!clrBefore) await sql("EXEC sys.sp_configure N'clr enabled', 0; RECONFIGURE;", "master");
        }
    }
}
