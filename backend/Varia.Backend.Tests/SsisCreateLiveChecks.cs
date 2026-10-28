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
/// CATALOG_EXISTS; a request that did not agree to CLR is CLR_REQUIRED on a server with CLR off; a database another session creates
/// between the preflight and the restore is CATALOG_EXISTS and left alone (and the destructive check's guarded drop leaves it too); a
/// step that fails after the restore removes the database; the removal drops a database still RESTORING and keeps an online one;
/// Stop during the restore lets it end (within RestoreStop) and then removes it, the database marked right after its restore in every case; a shutdown during the restore (CancelAll, then DrainCommitted, as
/// ProtocolHost does on stdin EOF) waits for the removal; Stop while the master key waits for another session's lock ends it within
/// the grace and removes the database; Stop before the restore creates nothing. The dry run never touches CLR, the assembly trust,
/// sp_ssis_startup, logins or jobs, and checks so. With VARIA_TEST_SSIS_CREATE=1 only (a server whose owner allows it; never set by
/// default), and only on a server without SSISDB: the destructive check creates the catalog with Varia, checks what SSMS's Create
/// leaves, removes it, creates it again with the startup procedure chosen and makes its last step fail, and checks that the server
/// is as before (CLR restored, unless other configuration changes wait for RECONFIGURE). It drops only an SSISDB its own Create
/// restored (by database_id and create_date) and checks again for SSISDB before each Create. With VARIA_TEST_SSIS=1 on a server that
/// has an SSISDB, a read-only check compares it with what SSMS's Create leaves. Passwords are never printed.</summary>
internal static class SsisCreateLiveChecks
{
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Dump(object? value) => JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
    /// <summary>A database's identity, so a drop takes only the one a check made: database_id and create_date, or null when it does not exist.</summary>
    private const string IdentityRead = "SELECT CONCAT(d.database_id, N'|', CONVERT(nvarchar(30), d.create_date, 126)) FROM sys.databases AS d WHERE d.name = ";
    private static readonly string[] Titles = [.. SsisCatalog.Current.Action("createCatalog")!.Steps];
    /// <summary>Whether dynamic configuration changes wait for a RECONFIGURE (1) or not (0), as the setup read and the guard find them.</summary>
    private const string PendingRead = "SELECT CASE WHEN " + SsisCreateSql.PendingList + " IS NULL THEN 0 ELSE 1 END;";

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
            check(!pending && found.Catalog == "SSISDB" && found.ClrEnabled == clr && found.StartupDefault == scan && found.BackupFile.EndsWith(@"\DTS\Binn\" + expectedBackup, StringComparison.OrdinalIgnoreCase)
                && string.Equals(found.DataFile, directory + "SSISDB.mdf", StringComparison.OrdinalIgnoreCase) && string.Equals(found.LogFile, directory + "SSISDB.ldf", StringComparison.OrdinalIgnoreCase),
                "ssis.catalogSetup reads what SSMS's Create reads: CLR in use (" + clr + "), scan for startup procs (" + scan + "), the " + expectedBackup + " in the registry's DTS folder, the new files "
                + "beside master.mdf, and no other configuration change waiting for RECONFIGURE (" + pending + "): " + Dump(setup));
        }
        else if (setup.Error?.Code == "CONFIGURATION_PENDING")
            check(pending && setup.Error.Message.Contains("RECONFIGURE WITH OVERRIDE", StringComparison.Ordinal),
                "ssis.catalogSetup refuses while other configuration changes wait for RECONFIGURE, CLR in use or not (sp_procoption reconfigures too), as an independent read finds them: " + Dump(setup));
        else check(setup.Error?.Code == "NOT_SUPPORTED" && setup.Error.Message.Contains("catalog backup file", StringComparison.Ordinal),
            "without the Integration Services catalog backup, ssis.catalogSetup answers SSMS's NOT_SUPPORTED: " + Dump(setup));
        // Bounded by the read's own budget, not a guess at a shared server's speed; and what only Create Catalog makes is unchanged.
        check(elapsed < options.Budget + TimeSpan.FromSeconds(5) && await ServerObjectsAsync(Sql) == objects,
            "ssis.catalogSetup changes nothing Create Catalog makes and answers within its " + (int)options.Budget.TotalSeconds + " s budget (" + (long)elapsed.TotalMilliseconds + " ms)");

        if (exists && !linux && sysadmin && Environment.GetEnvironmentVariable("VARIA_TEST_SSIS") == "1") await ExistingAsync(check, Sql, major);
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
                await DryRunAsync(check, service, info, Sql, live, db, dry.Setup, objects, clr);
            }
            finally
            {
                options.CreateScratch = null;
                options.BeforeCreateStep = null;
                options.BeforeWrite = null;
                options.StopGrace = new SsisOptions().StopGrace;
                options.RestoreStop = new SsisOptions().RestoreStop;
            }
        }
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SSIS_CREATE") != "1")
            Console.WriteLine("Create Catalog's destructive check is skipped: it creates and drops SSISDB, so it runs only with VARIA_TEST_SSIS_CREATE=1 on a server whose owner allows it.");
        else if (exists)
            Console.WriteLine("Create Catalog's destructive check is skipped: this server has an SSISDB, and the check never drops a catalog it did not create (its projects, environments, "
                + "history and master key password would be lost). Run it on a server without SSISDB.");
        else if (pending)
            Console.WriteLine("Create Catalog's destructive check is skipped: other configuration changes wait for RECONFIGURE on this server, so Create Catalog refuses (CONFIGURATION_PENDING).");
        else await DestructiveAsync(check, service, info, Sql, clr, objects);
    }

    /// <summary>The destructive check's drop, as one batch that runs only while <paramref name="name"/> is still the database this
    /// check's Create Catalog restored (<paramref name="identity"/>, from <see cref="IdentityRead"/>): another session's catalog of
    /// that name, created meanwhile, is never touched. With <paramref name="serverObjects"/> it first drops what Create Catalog makes
    /// on the server (only for SSISDB), and also when SSISDB is gone (a removal that dropped the database but not the rest).</summary>
    internal static string OwnedDrop(string name, string? identity, bool serverObjects)
    {
        var parts = identity?.Split('|');
        var owned = parts is [var id, var created] && int.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out var databaseId)
            ? "EXISTS (SELECT 1 FROM sys.databases AS d WHERE d.name = " + Literal(name) + " AND d.database_id = " + databaseId.ToString(CultureInfo.InvariantCulture)
                + " AND CONVERT(nvarchar(30), d.create_date, 126) = " + Literal(created) + ")"
            : "1 = 0";
        // sp_procoption ends with RECONFIGURE WITH OVERRIDE: refused, as Create Catalog refuses, while other changes wait.
        const string Server = "IF EXISTS (SELECT 1 FROM master.sys.procedures WHERE name = N'sp_ssis_startup')\n"
            + "    IF " + SsisCreateSql.PendingList + " IS NOT NULL RAISERROR(N'Other configuration changes wait for RECONFIGURE, so sp_ssis_startup was left.', 16, 1);\n"
            + "    ELSE BEGIN EXEC master.sys.sp_procoption N'sp_ssis_startup', 'startup', 'off'; DROP PROCEDURE dbo.sp_ssis_startup; END\n"
            + "IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = N'SSIS Server Maintenance Job') EXEC msdb.dbo.sp_delete_job @job_name = N'SSIS Server Maintenance Job';\n"
            + "IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = N'SSIS Failover Monitor Job') EXEC msdb.dbo.sp_delete_job @job_name = N'SSIS Failover Monitor Job';\n"
            + "IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'##MS_SSISServerCleanupJobLogin##') DROP LOGIN [##MS_SSISServerCleanupJobLogin##];\n";
        const string Trusted = "IF EXISTS (SELECT 1 FROM sys.all_objects WHERE name = N'trusted_assemblies' AND schema_id = SCHEMA_ID(N'sys'))\n"
            + "BEGIN\n"
            + "    DECLARE @hash varbinary(64);\n"
            + "    EXEC sys.sp_executesql N'SELECT @h = HASHBYTES(''SHA2_512'', af.content) FROM [SSISDB].sys.assembly_files AS af JOIN [SSISDB].sys.assemblies AS a ON a.assembly_id = af.assembly_id WHERE a.name = N''ISSERVER'' AND af.file_id = 1;', N'@h varbinary(64) OUTPUT', @h = @hash OUTPUT;\n"
            + "    IF @hash IS NOT NULL AND EXISTS (SELECT 1 FROM sys.trusted_assemblies WHERE hash = @hash) EXEC sys.sp_drop_trusted_assembly @hash;\n"
            + "END\n";
        var database = "IF EXISTS (SELECT 1 FROM sys.databases WHERE name = " + Literal(name) + " AND state = 0) ALTER DATABASE " + Bracket(name) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n"
            + "DROP DATABASE " + Bracket(name) + ";\n";
        return "IF " + owned + "\nBEGIN\n" + (serverObjects ? Server + Trusted : "") + database + "END\n"
            + (serverObjects ? "ELSE IF DB_ID(" + Literal(name) + ") IS NULL\nBEGIN\n" + Server + "END\n" : "");
    }

    /// <summary>Puts CLR integration back off in one batch that first looks for other dynamic configuration changes waiting for a
    /// RECONFIGURE (the setup read's filter) and refuses rather than apply them, as Create Catalog refuses (CONFIGURATION_PENDING).</summary>
    internal const string ClrOff = "IF " + SsisCreateSql.PendingList + " IS NOT NULL\n"
        + "    RAISERROR(N'Other configuration changes wait for RECONFIGURE, so CLR integration was left enabled.', 16, 1);\n"
        + "ELSE IF EXISTS (SELECT 1 FROM sys.configurations AS c WHERE c.name = N'clr enabled' AND CONVERT(int, c.value_in_use) = 1)\n"
        + "BEGIN\n"
        + "    EXEC sys.sp_configure N'clr enabled', 0;\n"
        + "    RECONFIGURE;\n"
        + "END";

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

    private static Task<SsisExecuteResult> CreateAsync(SqlService service, string connectionId, string password, CancellationToken token = default, bool startup = false, string? requestId = null, bool enableClr = true) =>
        service.SsisActions.ExecuteAsync(new(connectionId, requestId ?? Guid.NewGuid().ToString(), new SsisActionDto("createCatalog", Password: password, EnableClr: enableClr, StartupProcedure: startup)), token);

    /// <summary>128 UTF-16 code units made to end a string, a bracketed name, a line and a comment, with characters outside any code page
    /// and apostrophes a width- or kana-insensitive collation could take for ' (U+FF07, U+2019, U+02BC).</summary>
    private static string HostilePassword()
    {
        var text = "'];--/*ü\U0001D49C*/\"＇x’yʼz" + Convert.ToHexString(RandomNumberGenerator.GetBytes(16)) + "'' N'x＇";
        return (text + new string('p', 128))[..128];
    }

    private static async Task DryRunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, string, Task<SqlRun>> sql, Func<string, ConnectOptions> live, string db,
        SsisCatalogSetupDto setup, string objects, bool clr)
    {
        var options = service.Ssis.Options;
        async Task Mark()
        {
            var marked = await sql("EXEC sys.sp_addextendedproperty @name = N'varia.scratch', @value = 1;", db);
            if (marked.Status != "completed") throw new InvalidOperationException("The dry run's database could not be marked: " + marked.Error);
        }
        // The hook runs before the master key step even after a Stop, so the database is marked before its removal begins.
        async Task MarkAfterRestore(string title) { if (title == Titles[2]) await Mark(); }
        async Task<string?> State() => (await sql("SELECT CONCAT(d.state, ' ', d.is_read_only) FROM sys.databases AS d WHERE d.name = " + Literal(db) + ";", "master")).Scalar;
        // A database left RESTORING admits no ALTER DATABASE, only the DROP.
        async Task Drop()
        {
            var dropped = await sql("IF EXISTS (SELECT 1 FROM sys.databases WHERE name = " + Literal(db) + " AND state = 0) ALTER DATABASE " + Bracket(db) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n"
                + "IF DB_ID(" + Literal(db) + ") IS NOT NULL DROP DATABASE " + Bracket(db) + ";", "master");
            if (dropped.Status != "completed") throw new InvalidOperationException("The dry run's database could not be dropped: " + dropped.Error);
        }
        // Waits until the request's own session runs its RESTORE; false when the request ended first.
        async Task<bool> Restoring(string requestId, Task running)
        {
            for (var tries = 0; tries < 400 && !running.IsCompleted; tries++)
            {
                if (service.SsisActions.SessionOf(requestId) is { } session
                    && (await sql("SELECT COUNT(*) FROM sys.dm_exec_requests AS r WHERE r.session_id = " + session.ToString(CultureInfo.InvariantCulture) + " AND r.command LIKE N'RESTORE%';", "master")).Scalar == "1")
                    return true;
                await Task.Delay(10);
            }
            return false;
        }
        SqlConnection Direct() => new(new SqlConnectionStringBuilder(ConnectionSettings.Build(live(db)).ConnectionString) { Pooling = false, InitialCatalog = "master" }.ConnectionString);
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
            options.BeforeCreateStep = MarkAfterRestore;
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

        // The CLR agreement is the request's, in a dry run too: a request that did not agree changes nothing on a server with CLR off.
        if (clr) Console.WriteLine("CLR_REQUIRED is not checked live: CLR integration is in use on this server (SsisCreateChecks covers the rule offline).");
        else await Guarded("a request that did not agree to enable CLR", async () =>
        {
            var refused = await CreateAsync(service, info.Id, password, enableClr: false);
            check(refused is { Steps: [], Error: { Code: "CLR_REQUIRED", Retryable: false } } && await State() is null,
                "Create Catalog without the agreement to enable CLR integration is refused (CLR_REQUIRED) before it changes anything, in a dry run too: " + Dump(refused));
        });

        // Another session creates the database between the preflight and the restore: the restore's own check refuses it (27135),
        // nothing is removed, and the destructive check's guarded drop leaves a database it did not create alone.
        await Guarded("a database that appears before the restore", async () =>
        {
            options.BeforeCreateStep = async title =>
            {
                if (title != Titles[1]) return;
                var made = await sql("CREATE DATABASE " + Bracket(db) + ";", "master");
                if (made.Status != "completed") throw new InvalidOperationException("The other session's database could not be created: " + made.Error);
                await Mark();
            };
            var raced = await CreateAsync(service, info.Id, password);
            options.BeforeCreateStep = null;
            var other = (await sql(IdentityRead + Literal(db) + ";", "master")).Scalar;
            check(raced is { Error: { Code: "CATALOG_EXISTS", Retryable: false } } && Statuses(raced).SequenceEqual(["failed " + raced.Error.Message, "skipped " + Titles[2]])
                && raced.Error.Message == "There already exists a catalog (" + db + "), and only one catalog is supported on a server." && await State() == "0 0" && other is not null,
                "a database another session creates before the restore is refused by the restore's own check (CATALOG_EXISTS), with no removal step, and stays online: " + Dump(raced));
            var foreign = await sql(OwnedDrop(db, null, serverObjects: false), "master");
            var stale = await sql(OwnedDrop(db, other!.Split('|')[0] + "|2000-01-01T00:00:00", serverObjects: false), "master");
            var kept = await State();
            var mine = await sql(OwnedDrop(db, other, serverObjects: false), "master");
            check(foreign.Status == "completed" && stale.Status == "completed" && kept == "0 0" && mine.Status == "completed" && await State() is null,
                "the destructive check's drop leaves a database it did not create alone (no identity, or another create_date), and drops the one whose identity it recorded: " + kept);
        });

        // The removal after a failed restore: a database still RESTORING goes, an online one (another session's) stays.
        await Guarded("the removal of a database left restoring", async () =>
        {
            await using var direct = Direct();
            await direct.OpenAsync();
            var (layout, unusable) = await SsisCreate.LayoutAsync(direct, SsisCatalog.Current, setup.BackupFile, CancellationToken.None);
            if (layout is null) throw new InvalidOperationException("The catalog backup's files could not be read: " + unusable?.Message);
            await using (var restore = direct.CreateCommand())
            {
                restore.CommandText = "RESTORE DATABASE @catalog FROM DISK = @backup WITH NORECOVERY, MOVE @data_name TO @data_file, MOVE @log_name TO @log_file"
                    + (layout.SecondName is null ? ";" : ", MOVE @second_name TO @second_file;");
                restore.CommandTimeout = 0;
                restore.Parameters.AddRange([SsisCreate.Name("@catalog", db), SsisCreate.Path(SsisCatalog.Current, "@backup", setup.BackupFile), SsisCreate.Name("@data_name", layout.DataName),
                    SsisCreate.Path(SsisCatalog.Current, "@data_file", setup.DataFile), SsisCreate.Name("@log_name", layout.LogName), SsisCreate.Path(SsisCatalog.Current, "@log_file", setup.LogFile),
                    SsisCreate.Name("@second_name", layout.SecondName), SsisCreate.Path(SsisCatalog.Current, "@second_file", layout.SecondName is null ? null : Path.ChangeExtension(setup.DataFile, ".ndf"))]);
                await restore.ExecuteNonQueryAsync();
            }
            var restoring = await State();
            async Task RemoveRestoring()
            {
                await using var command = direct.CreateCommand();
                command.CommandText = SsisCreateSql.DropDatabase.Text;
                command.Parameters.AddRange([SsisCreate.Name("@catalog", db), new SqlParameter("@restoring", System.Data.SqlDbType.Bit) { Value = true }]);
                await command.ExecuteNonQueryAsync();
            }
            await RemoveRestoring();
            var gone = await State();
            var made = await sql("CREATE DATABASE " + Bracket(db) + ";", "master");
            if (made.Status != "completed") throw new InvalidOperationException("The online database could not be created: " + made.Error);
            await Mark();
            await RemoveRestoring();
            check(restoring == "1 0" && gone is null && await State() == "0 0",
                "the removal after a failed restore drops the database while it is still RESTORING, and keeps an online database of that name: " + restoring + " / " + gone);
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
            options.BeforeCreateStep = MarkAfterRestore;
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

        // Stop past RestoreStop (1 ms here): SQL Server is asked to end the restore too, and the database it left restoring goes. A
        // restore that ends before SQL Server takes the attention is stopped at the master key instead, or named if it is left online.
        await Guarded("Stop past RestoreStop during the restore", async () =>
        {
            options.RestoreStop = TimeSpan.FromMilliseconds(1);
            try
            {
                using var stop = new CancellationTokenSource();
                var requestId = Guid.NewGuid().ToString();
                options.BeforeCreateStep = MarkAfterRestore;
                var running = CreateAsync(service, info.Id, password, stop.Token, requestId: requestId);
                if (!await Restoring(requestId, running))
                {
                    Console.WriteLine("Stop past RestoreStop is not checked: the restore ended before it could be seen running (" + Dump((await running).Steps) + ").");
                    return;
                }
                await stop.CancelAsync();
                var stopped = await running;
                var statuses = Statuses(stopped);
                var cleanup = "done " + SsisCatalog.Current.CleanupStep;
                // Cancelled at the restore step: the RESTORE itself (the database left restoring), or, when the restore ended just as
                // RestoreStop passed, its switch to read-write, which then never starts.
                var cancelled = statuses.SequenceEqual(["cancelled " + Titles[1], "skipped " + Titles[2], cleanup]);
                var midRestore = cancelled && stopped.Error?.Message.Contains("SQL Server cancelled the restore", StringComparison.Ordinal) == true;
                var endedFirst = statuses.SequenceEqual(["done " + Titles[1], "cancelled " + Titles[2], cleanup]);
                var named = stopped.Error?.Message.Contains("the " + db + " database is online", StringComparison.Ordinal) == true;
                var left = await State();
                check(stopped is { Error.Code: "CANCELLED" } && ((cancelled || endedFirst) && left is null || named && left is not null) && service.SsisActions.ActiveJobs == 0,
                    "Stop during the restore asks SQL Server to end it once RestoreStop has passed, then removes the database it left restoring (or the one it restored, or names one "
                    + "left online): " + Dump(stopped) + " " + left);
                if (!midRestore) Console.WriteLine("Stop past RestoreStop: the restore ended before SQL Server could cancel it, so a RESTORE cancelled part way is not checked live (" + Dump(stopped.Steps) + ").");
            }
            finally { options.RestoreStop = new SsisOptions().RestoreStop; }
        });

        // A backend that shuts down during the restore (stdin EOF: ProtocolHost cancels everything, then drains): the restore ends, the
        // removal runs before DrainCommitted returns, and the request still answers what it removed.
        await Guarded("a shutdown during the restore", async () =>
        {
            var requestId = Guid.NewGuid().ToString();
            options.BeforeCreateStep = MarkAfterRestore;
            var running = CreateAsync(service, info.Id, password, requestId: requestId);
            if (!await Restoring(requestId, running))
            {
                Console.WriteLine("A shutdown during the restore is not checked: the restore ended before it could be seen running (" + Dump((await running).Steps) + ").");
                return;
            }
            service.SsisActions.CancelAll();
            var watch = Stopwatch.StartNew();
            var drained = await Task.Run(service.SsisActions.DrainCommitted);
            var drainedMs = watch.ElapsedMilliseconds;
            var left = await State();
            SsisExecuteResult? answer = null;
            string? thrown = null;
            try { answer = await running; }
            catch (RequestException error) { thrown = error.Code; }
            check(drained && left is null && thrown is null && answer is { Error.Code: "CANCELLED" }
                && Statuses(answer).SequenceEqual(["done " + Titles[1], "cancelled " + Titles[2], "done " + SsisCatalog.Current.CleanupStep]) && service.SsisActions.ActiveJobs == 0,
                "a backend that shuts down during the restore waits for it to end and for the removal of what it created (" + drainedMs + " ms), and the request answers with the steps: "
                + (thrown ?? Dump(answer)));
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

    /// <summary>VARIA_TEST_SSIS=1 on a Windows server that has an SSISDB (the owner's, created with Varia or SSMS): read only, the catalog and
    /// what Create Catalog leaves on the server are what SSMS's Create leaves, so a catalog made by Varia's Create Catalog is checked even
    /// where the destructive check cannot run (it never drops a catalog it did not create).</summary>
    private static async Task ExistingAsync(Action<bool, string> check, Func<string, string, Task<SqlRun>> sql, int major)
    {
        var server = await sql("SELECT (SELECT CONVERT(int, c.value_in_use) FROM sys.configurations AS c WHERE c.name = N'clr enabled'), "
            + "(SELECT COUNT(*) FROM master.sys.procedures AS p WHERE p.name = N'sp_ssis_startup'), "
            + "(SELECT CONVERT(int, l.is_disabled) FROM sys.server_principals AS l WHERE l.name = N'##MS_SSISServerCleanupJobLogin##'), "
            + "(SELECT COUNT(*) FROM sys.server_permissions AS p JOIN sys.server_principals AS l ON l.principal_id = p.grantee_principal_id WHERE l.name = N'##MS_SSISServerCleanupJobLogin##' AND p.permission_name = N'VIEW SERVER STATE' AND p.state = 'G'), "
            + "(SELECT COUNT(*) FROM msdb.dbo.sysjobs AS j JOIN msdb.dbo.sysjobsteps AS s ON s.job_id = j.job_id WHERE j.name = N'SSIS Server Maintenance Job'), "
            + "(SELECT COUNT(*) FROM msdb.dbo.sysjobs AS j JOIN msdb.dbo.sysjobschedules AS js ON js.job_id = j.job_id JOIN msdb.dbo.sysschedules AS sc ON sc.schedule_id = js.schedule_id "
            + "WHERE j.name = N'SSIS Server Maintenance Job' AND sc.name = N'SSISDB Scheduler' AND sc.freq_type = 4), "
            + "(SELECT SUSER_SNAME(j.owner_sid) FROM msdb.dbo.sysjobs AS j WHERE j.name = N'SSIS Server Maintenance Job'), "
            + "(SELECT d.state FROM sys.databases AS d WHERE d.name = N'SSISDB');", "master");
        var trusted = major >= 14 ? (await sql("SELECT COUNT(*) FROM sys.trusted_assemblies WHERE description LIKE N'%" + SsisCatalog.Current.AssemblyFile + "';", "master")).Scalar : "1";
        var inside = await sql("SELECT (SELECT COUNT(*) FROM sys.symmetric_keys WHERE name = N'##MS_DatabaseMasterKey##'), (SELECT COUNT(*) FROM [catalog].[catalog_properties] WHERE property_name = N'SCHEMA_VERSION'), "
            + "(SELECT COUNT(*) FROM sys.database_permissions AS p JOIN sys.database_principals AS u ON u.principal_id = p.grantee_principal_id "
            + "WHERE u.name = N'##MS_SSISServerCleanupJobUser##' AND p.permission_name = N'EXECUTE'), (SELECT COUNT(*) FROM sys.assemblies WHERE name = N'ISSERVER');", "SSISDB");
        var row = server.Status == "completed" ? server.Sets[0][0] : [];
        var within = inside.Status == "completed" ? inside.Sets[0][0] : [];
        check(row is ["1", "1", "1", "1", "2", "1", "##MS_SSISServerCleanupJobLogin##", "0"] && trusted is not (null or "0") && within is ["1", "1", "2", "1"],
            "this server's SSISDB is what SSMS's Create leaves: online, its master key, schema version and ISSERVER assembly, CLR in use, sp_ssis_startup, the trusted Integration Services assembly, "
            + "the disabled cleanup login with VIEW SERVER STATE and its user's two grants, and the SSIS Server Maintenance Job (two steps, daily, owned by that login): "
            + Dump(row) + " " + trusted + " " + Dump(within) + " " + server.Error + inside.Error);
    }

    /// <summary>VARIA_TEST_SSIS_CREATE=1 on a server without SSISDB only: Varia's Create Catalog for real (no startup procedure), what SSMS's
    /// Create leaves checked, a second Create refused, and the catalog removed; then Create Catalog with the startup procedure, whose last
    /// step is made to fail, which must leave the server as it was. It drops only an SSISDB its own Create restored (its identity, read
    /// right after that restore), checks for SSISDB again before each Create (stopping, and leaving it alone, when another session made
    /// one), and puts CLR back only when its own Create enabled it, never applying another pending configuration change.</summary>
    private static async Task DestructiveAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, string, Task<SqlRun>> sql, bool clrBefore, string objects)
    {
        var options = service.Ssis.Options;
        // What this check made: the identity of the SSISDB its Create restored, whether that Create reached the server objects, and
        // whether it enabled CLR.
        string? owned = null;
        var serverObjects = false;
        var clrChanged = false;
        async Task<string?> Identity() => (await sql(IdentityRead + "N'SSISDB';", "master")).Scalar;
        async Task<bool> Absent()
        {
            if (await Identity() is null) return true;
            Console.WriteLine("Create Catalog's destructive check stops: an SSISDB appeared that this check did not create, and it is left alone.");
            return false;
        }
        void Saw(SsisExecuteResult result)
        {
            if (result.Steps is [{ Status: "done" } first, ..] && first.Message == Titles[0]) clrChanged = true;
            if (result.Steps.Any(step => step.Message == Titles[3] && step.Status is "done" or "failed" or "cancelled")) serverObjects = true;
        }
        async Task Drop()
        {
            var dropped = await sql(OwnedDrop(SsisCatalog.Current.CatalogDatabase, owned, serverObjects), "master");
            if (dropped.Status != "completed") throw new InvalidOperationException("The SSISDB this check created could not be dropped: " + dropped.Error);
            owned = null;
            serverObjects = false;
        }
        async Task RestoreClr()
        {
            if (clrBefore || !clrChanged) return;
            var off = await sql(ClrOff, "master");
            check(off.Status == "completed", "the destructive check puts CLR integration back off without applying another pending configuration change: " + off.Error);
            clrChanged = false;
        }
        // Right after the restore (the master key step comes next), the database is the one this request restored: the restore refuses
        // one that exists.
        Func<string, Task> Recorder(Func<string, Task>? then = null) => async title =>
        {
            if (title == Titles[2]) owned ??= await Identity();
            if (then is not null) await then(title);
        };
        Console.WriteLine("VARIA_TEST_SSIS_CREATE=1: Create Catalog's destructive check creates SSISDB on this server, then removes it.");
        var password = HostilePassword();
        try
        {
            options.CatalogDatabase = SsisCatalog.Current.CatalogDatabase;
            if (!await Absent()) return;
            options.BeforeCreateStep = Recorder();
            var created = await CreateAsync(service, info.Id, password, startup: false);
            options.BeforeCreateStep = null;
            Saw(created);
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
            await RestoreClr();

            // The startup choice, and a failure at the last step: everything the earlier steps made is removed.
            string? startupFlag = null;
            if (!await Absent()) return;
            options.BeforeCreateStep = Recorder(async title =>
            {
                if (title != Titles[4]) return;
                startupFlag = (await sql("SELECT CONVERT(int, p.is_auto_executed) FROM master.sys.procedures AS p WHERE p.name = N'sp_ssis_startup';", "master")).Scalar;
                // Only the database this request restored, which nobody else can have replaced while the request runs.
                if (owned is null) throw new InvalidOperationException("The SSISDB this check restored was not recorded.");
                var readOnly = await sql("ALTER DATABASE [SSISDB] SET READ_ONLY WITH ROLLBACK IMMEDIATE;", "master");
                if (readOnly.Status != "completed") throw new InvalidOperationException("SSISDB could not be made read-only: " + readOnly.Error);
            });
            var failed = await CreateAsync(service, info.Id, password, startup: true);
            options.BeforeCreateStep = null;
            Saw(failed);
            var left = (await sql("SELECT CASE WHEN DB_ID(N'SSISDB') IS NULL THEN 0 ELSE 1 END;", "master")).Scalar;
            await RestoreClr();
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
            // Only what this check made: an SSISDB another session created meanwhile does not match the recorded identity.
            await Drop();
            await RestoreClr();
        }
    }
}
