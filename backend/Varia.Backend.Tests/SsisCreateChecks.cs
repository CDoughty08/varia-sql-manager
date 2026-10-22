using System.Diagnostics;
using System.Text.Json;
using Varia.Backend.Common;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of PR S9a, Create Catalog: the catalogue's verb and files, the SQL's lint (which catches what it exists
/// for) and the SSMS steps it must keep, the refusals before connecting and from the setup facts, request validation and
/// dispatch of ssis.execute's createCatalog and ssis.catalogSetup, the password never printed, and the disconnect-only token a
/// reply that outlives Stop waits on. No server is reached: the live checks (SsisCreateLiveChecks) run the SQL.</summary>
internal static class SsisCreateChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
    };

    public static async Task RunAsync(Action<bool, string> check)
    {
        Catalog(check);
        Lint(check);
        Steps(check);
        Rules(check);
        await ValidationAsync(check);
        await RefusedFirstAsync(check);
        Registry(check);
        Removal(check);
        await StopAsync(check);
    }

    /// <summary>The startup choice reaches sp_procoption as chosen, and a Stop or failure after the restore removes exactly what Create
    /// Catalog had made, in DropCatalog's order.</summary>
    private static void Removal(Action<bool, string> check)
    {
        static object? Startup(bool? choice) => SsisCreate.StartupParameter(new SsisActionDto("createCatalog", Password: "x", EnableClr: true, StartupProcedure: choice)).Value;
        var startup = SsisCreate.StartupParameter(Create(startup: true).Action);
        check(startup is { ParameterName: "@startup", SqlDbType: System.Data.SqlDbType.Bit } && Equals(Startup(true), true) && Equals(Startup(false), false) && Equals(Startup(null), false),
            "the startup procedure is marked to run at startup only when the request chose it");
        string Plan(CreatedObjects created, bool restoring = false, string version = "17.0.1000.7") => string.Join(",", SsisCreate.Removal(created, "SSISDB", restoring, version)
            .Select(item => item.Command.Id + string.Concat(item.Parameters.Select(parameter => " " + parameter.ParameterName + "=" + (parameter.Value is byte[] bytes ? Convert.ToHexString(bytes) : parameter.Value)))));
        var cases = new (CreatedObjects Created, bool Restoring, string Version, string Expected)[]
        {
            (new(), false, "17.0.1000.7", ""),
            (new() { Restored = true }, true, "17.0.1000.7", "dropDatabase @catalog=SSISDB @restoring=True"),
            (new() { Restored = true, Recovered = true }, false, "17.0.1000.7", "dropDatabase @catalog=SSISDB @restoring=False"),
            (new() { Restored = true, Recovered = true, Assembly = true }, false, "17.0.1000.7", "dropDatabase @catalog=SSISDB @restoring=False"),
            (new() { Restored = true, Recovered = true, Assembly = true }, false, "13.0.7000.253", "dropLoadingLogin,dropDatabase @catalog=SSISDB @restoring=False"),
            (new() { Restored = true, Recovered = true, Assembly = true, TrustedHash = [1, 2], Startup = true }, false, "17.0.1000.7", "dropTrusted @hash=0102,dropStartup,dropDatabase @catalog=SSISDB @restoring=False"),
            (new() { Restored = true, Recovered = true, Assembly = true, TrustedHash = [1, 2], Startup = true, Jobs = true }, false, "17.0.1000.7",
                "dropTrusted @hash=0102,dropStartup,dropJobs,dropDatabase @catalog=SSISDB @restoring=False")
        };
        var wrong = cases.Where(item => Plan(item.Created, item.Restoring, item.Version) != item.Expected).Select(item => item.Expected + " <> " + Plan(item.Created, item.Restoring, item.Version)).ToList();
        check(wrong.Count == 0, "a Stop or failure after the restore removes only what Create Catalog made: the hash it added (or the loading login before 14.0.800.11), sp_ssis_startup, "
            + "the jobs and their login, then the database it restored: " + string.Join("; ", wrong));
    }

    /// <summary>ExecuteAsync's Stop reply against fake jobs: within the grace it is the job's answer; past it, a job that answers Stop itself
    /// (Create Catalog from its restore on) is waited for, and a disconnect still answers at once; any other job answers CANCELLED.</summary>
    private static async Task StopAsync(Action<bool, string> check)
    {
        using var reads = new SsisService(new SsisChecks.FakeHost(), new SsisOptions { StopGrace = TimeSpan.FromMilliseconds(200) });
        using var service = new SsisActionService(new SsisChecks.FakeHost(), reads);
        var answer = new SsisExecuteResult([new("done", "x")], 0);
        async Task<(string Outcome, long Ms)> Run(Task<SsisExecuteResult> job, bool committed, CancellationToken forgotten)
        {
            var progress = new SsisActionService.JobProgress();
            if (committed) progress.Commit();
            var watch = Stopwatch.StartNew();
            try
            {
                var result = await service.AfterStopAsync(job, progress, forgotten, new CancellationToken(true));
                return (result.Error?.Code ?? "answer", watch.ElapsedMilliseconds);
            }
            catch (RequestException error) { return ("request " + error.Code, watch.ElapsedMilliseconds); }
            catch (OperationCanceledException) { return ("cancelled", watch.ElapsedMilliseconds); }
        }
        async Task<SsisExecuteResult> After(int ms) { await Task.Delay(ms); return answer; }
        var quick = await Run(After(20), false, CancellationToken.None);
        var late = await Run(After(700), true, CancellationToken.None);
        var abandoned = await Run(After(700), false, CancellationToken.None);
        using var disconnect = new CancellationTokenSource(400);
        var lost = await Run(new TaskCompletionSource<SsisExecuteResult>().Task, true, disconnect.Token);
        var early = await Run(Task.FromException<SsisExecuteResult>(new OperationCanceledException()), false, CancellationToken.None);
        check(quick is ("answer", < 200) && late is ("answer", >= 600) && abandoned is ("cancelled", >= 150 and < 600) && lost is ("request CANCELLED", >= 300 and < 2_000) && early.Outcome == "CANCELLED",
            "Stop's reply is the job's answer within the grace; past it, a job that answers Stop itself is waited for until it does, a disconnect answers at once, and any other job answers "
            + "CANCELLED; a job that ended on the Stop before a step is a CANCELLED value: " + string.Join(", ", quick, late, abandoned, lost, early));
    }

    internal static SsisExecuteArgs Create(string password = "Pa'ss]--w0rd", bool? enableClr = true, bool? startup = false, string? connectionId = null) =>
        new(connectionId ?? Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new SsisActionDto("createCatalog", Password: password, EnableClr: enableClr, StartupProcedure: startup));

    private static void Catalog(Action<bool, string> check)
    {
        var catalog = SsisCatalog.Current;
        var create = catalog.Action("createCatalog");
        check(create is { Title: "Create Catalog", Server: true, Revision: false, WindowsAuthOnBox: false, Procedures.Count: 0 } && catalog.Action("stopOperation") is { Server: false }
            && create.Steps.SequenceEqual(["Enable CLR integration", "Restore the catalog database", "Create the master key", "Register the Integration Services assembly and startup procedure", "Create the maintenance job"]),
            "Create Catalog is a server verb of the catalogue with SSMS's five steps, any authentication, and no catalog procedure");
        check(new[] { 13, 14, 15, 16, 17, 18 }.Select(catalog.BackupFile).SequenceEqual(["SSISDB.bak", "SSISDB.bak", "SSISDB.bak", "SSISDB.bak", "SSISDBBackup.bak", "SSISDBBackup.bak"])
            && catalog.AssemblyFile == "Microsoft.SqlServer.IntegrationServices.Server.dll" && catalog.CleanupStep == "Remove the incomplete catalog"
            && catalog.Limit("catalogPassword") == 128 && catalog.Limit("serverPath") == 1024 && !catalog.Retryable("CATALOG_EXISTS") && !catalog.Retryable("CLR_REQUIRED"),
            "the catalog backup is SSISDBBackup.bak from SQL Server 2025 and SSISDB.bak before, beside the ISSERVER assembly; the password and paths are bounded; CATALOG_EXISTS and CLR_REQUIRED need the user");
    }

    private static void Lint(Action<bool, string> check)
    {
        var problems = SsisCreateSql.All.SelectMany(command => SsisCreateSql.Lint(command).Select(problem => command.Id + ": " + problem)).ToList();
        check(problems.Count == 0 && SsisCreateSql.All.Select(command => command.Id).Distinct().Count() == SsisCreateSql.All.Count(),
            "every Create Catalog command passes its lint: " + string.Join("; ", problems));
        string[] Problems(string id, string text, params string[] parameters) => [.. SsisCreateSql.Lint(new SsisCreateCommand(id, text, parameters))];
        var caught = new (string Id, string Text, string[] Parameters, string Expected)[]
        {
            ("masterKey", "DECLARE @create nvarchar(max) = N'CREATE MASTER KEY ENCRYPTION BY PASSWORD = N''' + @password + N''';'; EXEC (@create);", ["@password"], "uses the password other than through the server's quoting"),
            ("masterKey", "DECLARE @create nvarchar(max) = N'CREATE MASTER KEY ENCRYPTION BY PASSWORD = N''' + @password + N''';'; EXEC (@create);", ["@password"], "concatenates the parameter @password into a statement"),
            ("masterKey", "SELECT 1;", ["@password"], "does not read the password"),
            ("assembly", "SELECT @password;", ["@password"], "reads the password"),
            ("readWrite", "DECLARE @alter nvarchar(400) = N'ALTER DATABASE [' + @catalog + N'] SET READ_WRITE;'; EXEC sys.sp_executesql @alter;", ["@catalog"], "concatenates the parameter @catalog into a statement"),
            ("assembly", "DECLARE @quoted nvarchar(2100) = @assembly; DECLARE @s nvarchar(max) = N'SELECT * FROM OPENROWSET(BULK N''' + @quoted + N''', SINGLE_BLOB) AS d;'; EXEC (@s);", ["@assembly"],
                "concatenates @quoted, which the server did not quote"),
            ("restore", "RESTORE DATABASE @catalog FROM DISK = @backup WITH REPLACE, MOVE @data_name TO @data_file;", ["@catalog", "@backup", "@data_name", "@data_file"], "restores WITH REPLACE"),
            ("restore", "RESTORE DATABASE @catalog FROM DISK = @backup WITH MOVE @data_name TO @data_file, REPLACE;", ["@catalog", "@backup", "@data_name", "@data_file"], "restores WITH REPLACE"),
            ("masterKey", "RESTORE DATABASE @catalog FROM DISK = @backup; SELECT REPLACE(@password, N'''', N'''''');", ["@password", "@catalog", "@backup"], "restores a database"),
            ("readWrite", "SELECT 1 FROM sys.databases WHERE name = N'{0}';", [], "has a format placeholder"),
            ("readWrite", "SELECT @other;", ["@catalog"], "names @other, which is neither its parameter nor declared"),
            ("dropJobs", "DROP DATABASE [SSISDB];", [], "drops a database"),
            ("dropJobs", "ALTER DATABASE [SSISDB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;", [], "rolls other sessions back"),
            ("enableClr", "EXEC master.dbo.xp_cmdshell N'dir';", [], "runs the shell"),
            // A parameter wrapped in a function, a REPLACE that is not the quote escape, the password quoted twice, and quoting in the
            // database's collation (width-insensitive, it doubles U+FF07 and the literal reads it as an ASCII quote).
            ("readWrite", "DECLARE @alter nvarchar(400) = N'ALTER DATABASE [' + LTRIM(@catalog) + N'] SET READ_WRITE;'; EXEC sys.sp_executesql @alter;", ["@catalog"],
                "builds text that runs from the parameter @catalog other than through QUOTENAME or the server's quoting"),
            ("readWrite", "DECLARE @alter nvarchar(400) = N'ALTER DATABASE ' + QUOTENAME(RTRIM(@catalog)) + N' SET READ_WRITE;'; EXEC sys.sp_executesql @alter;", ["@catalog"],
                "builds text that runs from the parameter @catalog other than through QUOTENAME or the server's quoting"),
            ("readWrite", "DECLARE @q nvarchar(400) = REPLACE(@catalog, N'a', N'a'); DECLARE @alter nvarchar(400) = N'ALTER DATABASE [' + @q + N'] SET READ_WRITE;'; EXEC sys.sp_executesql @alter;", ["@catalog"],
                "concatenates @q, which the server did not quote"),
            ("readWrite", "DECLARE @q nvarchar(400) = REPLACE(@catalog COLLATE Latin1_General_BIN2, N'''', N'''''') + N'x'; DECLARE @alter nvarchar(400) = N'PRINT ''' + @q + N''';'; EXEC (@alter);", ["@catalog"],
                "concatenates @q, which the server did not quote"),
            ("masterKey", SsisCreateSql.MasterKey.Text + "\nEXEC (N'PRINT N''' + REPLACE(@password COLLATE Latin1_General_BIN2, N'''', N'''''') + N'''');", ["@password"],
                "uses the password other than through the server's quoting"),
            ("masterKey", SsisCreateSql.MasterKey.Text.Replace(" COLLATE Latin1_General_BIN2", "", StringComparison.Ordinal), ["@password"], "uses the password other than through the server's quoting"),
            ("assembly", SsisCreateSql.Assembly.Text.Replace(" COLLATE Latin1_General_BIN2", "", StringComparison.Ordinal), ["@assembly"], "concatenates @quoted, which the server did not quote"),
            ("cleanupLogin", SsisCreateSql.CleanupLogin.Text.Replace(" COLLATE Latin1_General_BIN2", "", StringComparison.Ordinal), [], "concatenates @login_password, which the server did not quote")
        };
        var missed = caught.Where(item => !Problems(item.Id, item.Text, item.Parameters).Contains(item.Expected))
            .Select(item => item.Expected + " in " + item.Text + " (" + string.Join("; ", Problems(item.Id, item.Text, item.Parameters)) + ")").ToList();
        check(missed.Count == 0, "the Create Catalog lint rejects a password or parameter concatenated into SQL, or wrapped in anything but QUOTENAME or the server's binary-collation quote escape, "
            + "the password anywhere but once in the master key, unquoted dynamic text, RESTORE WITH REPLACE, a restore, drop or ROLLBACK IMMEDIATE outside their commands, format placeholders, "
            + "unknown variables and the shell: " + string.Join("; ", missed));
        var verbs = SsisCatalog.Current.Actions.Where(spec => spec.Server).Select(spec => (spec.Verb, Commands: SsisCreateSql.ServerCommands(spec.Verb))).ToList();
        check(verbs.Count > 0 && verbs.All(item => item.Commands is { Count: > 0 } commands && commands.All(command => SsisCreateSql.Lint(command).Count == 0)) && SsisCreateSql.ServerCommands("stopOperation") is null
            && SsisCreateSql.ServerCommands("deleteCatalog") is null,
            "every server verb of the catalogue runs only commands SsisCreateSql lists for it, and they pass its lint; a server verb it does not know has none: " + string.Join(", ", verbs.Select(item => item.Verb + "=" + item.Commands?.Count)));
    }

    /// <summary>What SSMS 22's object model and scripts do, kept: the reads it makes, the restore's parameters, the master key's quoting,
    /// the version test for the assembly, the startup procedure's body, and the maintenance job's steps and schedule.</summary>
    private static void Steps(Action<bool, string> check)
    {
        static bool Has(SsisCreateCommand command, params string[] parts) => parts.All(part => command.Text.Contains(part, StringComparison.Ordinal));
        check(Has(SsisCreateSql.Setup, "EXEC master.dbo.xp_regread N'HKEY_LOCAL_MACHINE', @key, N'', @dts OUTPUT;", "N'0\\SSIS\\Setup\\DTSPath'", "PARSENAME(@version, 4)", "N'Binn\\' + @backup_name",
                "INSERT @found EXEC master.dbo.xp_fileexist @backup;", "SERVERPROPERTY('MasterFile')", "CHARINDEX(N'master.mdf', LOWER(@master))", "@directory + @catalog + N'.mdf'", "@directory + @catalog + N'.ldf'",
                "c.name = N'clr enabled'", "c.name = N'scan for startup procs'", "IS_SRVROLEMEMBER(N'sysadmin')", "IF @sysadmin = 1", "SET LOCK_TIMEOUT 10000",
                "WHERE c.is_dynamic = 1 AND c.value <> c.value_in_use AND c.name <> N'clr enabled'", "AND NOT (c.name = N'min server memory (MB)' AND CONVERT(int, c.value) = 0)", "@log_exists, @pending;")
            && SsisCreateSql.FileList.Text == "RESTORE FILELISTONLY FROM DISK = @backup;",
            "the setup reads what SSMS's Create reads: the registry's DTSPath for the version, the Binn folder's backup with xp_fileexist, the master database's folder and the new files, sysadmin, CLR, the startup default and the other dynamic configuration changes RECONFIGURE would apply, within a 10 s lock timeout");
        check(Has(SsisCreateSql.Restore, "RAISERROR(27135, 16, 1, @catalog)", "RESTORE DATABASE @catalog FROM DISK = @backup WITH MOVE @data_name TO @data_file, MOVE @log_name TO @log_file;",
                "MOVE @second_name TO @second_file") && !SsisCreateSql.Restore.Text.Contains("REPLACE", StringComparison.Ordinal)
            && Has(SsisCreateSql.ReadWrite, "d.is_read_only = 1", "QUOTENAME(@catalog) + N' SET READ_WRITE WITH ROLLBACK IMMEDIATE;'")
            && Has(SsisCreateSql.MasterKey, "DROP MASTER KEY", "N'CREATE MASTER KEY ENCRYPTION BY PASSWORD = N''' + REPLACE(@password COLLATE Latin1_General_BIN2, N'''', N'''''') + N''';'", "EXEC (@create);")
            && SsisCreateSql.MasterKey.Context == SsisCreateContext.Catalog && SsisCreateSql.CleanupUser.Context == SsisCreateContext.Catalog
            && SsisCreateSql.EnableClr.Text == "EXEC sys.sp_configure N'clr enabled', 1;\nRECONFIGURE;",
            "the restore refuses a database that appeared (27135) and never replaces one; the master key takes the password only through the server's quoting, in the catalog; CLR is enabled as SMO does");
        check(Has(SsisCreateSql.Assembly, "IF NOT (@major > 14 OR (@major = 14 AND (@minor > 0 OR (@minor = 0 AND (@build > 800 OR (@build = 800 AND @revision > 11))))))",
                "CREATE ASYMMETRIC KEY [MS_SQLEnableSystemAssemblyLoadingKey] FROM EXECUTABLE FILE", "GRANT UNSAFE ASSEMBLY TO [##MS_SQLEnableSystemAssemblyLoadingUser##]",
                "DECLARE @quoted nvarchar(2100) = REPLACE(@assembly COLLATE Latin1_General_BIN2, N'''', N'''''');", "OPENROWSET(BULK N''' + @quoted + N''', SINGLE_BLOB)", "HASHBYTES('SHA2_512', @bin)", "EXEC sys.sp_add_trusted_assembly @hash, @assembly;", "SELECT @added, @hash;")
            && Has(SsisCreateSql.CreateStartup, "CREATE PROCEDURE [dbo].[sp_ssis_startup]", "IF DB_ID('SSISDB') IS NULL", "SET @script = N'EXEC [SSISDB].[catalog].[startup]'", "EXECUTE sp_executesql @script")
            && SsisCreateSql.StartupOn.Text == "IF @startup = 1 EXEC sys.sp_procoption N'sp_ssis_startup', 'startup', 'on';"
            && SsisCreate.UsesAsymmetricKey("13.0.7000.253") && SsisCreate.UsesAsymmetricKey("14.0.800.11") && !SsisCreate.UsesAsymmetricKey("14.0.800.12")
            && !SsisCreate.UsesAsymmetricKey("14.0.1000.169") && !SsisCreate.UsesAsymmetricKey("14.1.0.0") && !SsisCreate.UsesAsymmetricKey("17.0.1000.7"),
            "the assembly is trusted by hash after 14.0.800.11 and through the asymmetric key before, as SSMS decides it; sp_ssis_startup is SSMS's, and the startup option follows the choice");
        check(Has(SsisCreateSql.CleanupLogin, "REPLACE(CONVERT(nvarchar(256), CRYPT_GEN_RANDOM(64)) COLLATE Latin1_General_BIN2, N'''', N'''''')", "CHECK_POLICY = OFF", "ALTER LOGIN [##MS_SSISServerCleanupJobLogin##] DISABLE;",
                "@job_name = N'SSIS Failover Monitor Job'")
            && Has(SsisCreateSql.CleanupUser, "GRANT EXECUTE ON [internal].[cleanup_server_retention_window]", "GRANT EXECUTE ON [internal].[cleanup_server_project_version]")
            && SsisCreateSql.CleanupGrant.Text == "GRANT VIEW SERVER STATE TO [##MS_SSISServerCleanupJobLogin##];"
            && Has(SsisCreateSql.MaintenanceJob, "RAISERROR(27229, 16, 1, N'##MS_SSISServerCleanupJobLogin##');\n    RETURN;", "@owner_login_name = N'##MS_SSISServerCleanupJobLogin##'",
                "@step_name = N'SSIS Server Operation Records Maintenance'", "EXEC [SSISDB].[internal].[cleanup_server_retention_window]', @database_name = N'msdb', @on_success_action = 3, @retry_attempts = 3, @retry_interval = 3;",
                "@step_name = N'SSIS Server Max Version Per Project Maintenance'", "EXEC [SSISDB].[internal].[cleanup_server_project_version]', @database_name = N'msdb', @retry_attempts = 3, @retry_interval = 3;",
                "@name = N'SSISDB Scheduler', @enabled = 1, @freq_type = 4, @freq_interval = 1, @freq_subday_type = 1, @active_start_date = 20001231, @active_end_date = 99991231, @active_start_time = 0, @active_end_time = 120000;",
                "adc.[database_name] =''SSISDB'')", "CONVERT(nvarchar(128), SERVERPROPERTY('ServerName'))")
            && !SsisCreateSql.All.Any(command => command.Text.Contains("sp_add_job @job_name = N'SSIS Failover Monitor Job'", StringComparison.Ordinal)),
            "the maintenance job is SSMS's: a disabled cleanup login with a server-made password, its grants, two primary-only steps with three retries, daily at 00:00; no Failover Monitor Job is created");
        check(Has(SsisCreateSql.DropDatabase, "(@restoring = 0 OR (@state = 1 AND NOT EXISTS (SELECT 1 FROM sys.dm_tran_locks AS l WHERE l.resource_type = N'DATABASE'", "AND l.resource_database_id = DB_ID(@catalog) AND l.request_session_id <> @@SPID)))", "SET SINGLE_USER WITH ROLLBACK IMMEDIATE; ", "N'DROP DATABASE ' + QUOTENAME(@catalog)")
            && SsisCreateSql.CleanupPrologue.Text == "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;\nSET LOCK_TIMEOUT 30000;" && SsisCreateSql.CleanupPrologue.Parameters.Count == 0
            && Has(SsisCreateSql.DropTrusted, "EXEC sys.sp_drop_trusted_assembly @hash;") && Has(SsisCreateSql.DropLoadingLogin, "N'DependencyCatalog'")
            && Has(SsisCreateSql.DropJobs, "N'SSIS Server Maintenance Job'", "N'SSIS Failover Monitor Job'", "DROP LOGIN [##MS_SSISServerCleanupJobLogin##]"),
            "a failure after the restore removes what Create Catalog made, as DropCatalog.sql does: only the hash it added, and a database left restoring only while it still is and no other session holds it (another restore's exclusive lock); "
            + "before it, a transaction a cancelled step left open ends and later lock waits are bounded (30 s), in a batch without parameters so the timeout lasts");
    }

    private static void Rules(Action<bool, string> check)
    {
        var catalog = SsisCatalog.Current;
        var ok = new CatalogFacts(true, "17.0.1000.7", false, false, false, @"C:\Program Files\Microsoft SQL Server\170\DTS\Binn\SSISDBBackup.bak", true,
            @"C:\Program Files\Microsoft SQL Server\170\DTS\Binn\Microsoft.SqlServer.IntegrationServices.Server.dll", @"C:\Data\", @"C:\Data\SSISDB.mdf", false, @"C:\Data\SSISDB.ldf", false);
        var cases = new (CatalogFacts Facts, string? Code, string Text)[]
        {
            (ok, null, ""),
            (ok with { Sysadmin = false }, "PERMISSION_DENIED", "you must be a member of the SQL Server sysadmin fixed server role"),
            (ok with { Sysadmin = false, Exists = true }, "PERMISSION_DENIED", "sysadmin"),
            (ok with { Exists = true }, "CATALOG_EXISTS", "There already exists a catalog (SSISDB), and only one catalog is supported on a server."),
            (ok with { Exists = true, BackupFile = null }, "CATALOG_EXISTS", "There already exists a catalog"),
            (ok with { BackupFile = null, AssemblyFile = null }, "NOT_SUPPORTED", "The path to the catalog backup file could not be determined. Integration Services might not be installed on this server"),
            (ok with { BackupExists = false }, "NOT_SUPPORTED", @"The catalog backup file 'C:\Program Files\Microsoft SQL Server\170\DTS\Binn\SSISDBBackup.bak' could not be accessed."),
            (ok with { Directory = null, DataFile = null, LogFile = null }, "NOT_SUPPORTED", "The folder of the master database's files could not be determined"),
            (ok with { DataExists = true }, "NOT_SUPPORTED", @"The database file with name 'SSISDB.mdf' already exists in directory 'C:\Data\'."),
            (ok with { LogExists = true }, "NOT_SUPPORTED", @"The database file with name 'SSISDB.ldf' already exists in directory 'C:\Data\'."),
            (ok with { DataFile = @"C:\" + new string('d', 1030) + ".mdf" }, "NOT_SUPPORTED", "longer than 1,024 characters"),
            (ok with { PendingConfiguration = "cost threshold for parallelism, max server memory (MB)" }, "CONFIGURATION_PENDING",
                "Enabling CLR integration runs RECONFIGURE, which would also apply these pending server configuration changes: cost threshold for parallelism, max server memory (MB)."),
            (ok with { PendingConfiguration = "max server memory (MB)", ClrEnabled = true }, null, ""),
            (ok with { PendingConfiguration = "max server memory (MB)", Exists = true }, "CATALOG_EXISTS", "There already exists a catalog")
        };
        var wrong = cases.Where(item => SsisCreate.Refusal(catalog, item.Facts, "SSISDB") is var error && (error?.Code != item.Code || error is not null && !error.Message.Contains(item.Text, StringComparison.Ordinal)))
            .Select(item => JsonSerializer.Serialize(SsisCreate.Refusal(catalog, item.Facts, "SSISDB"), Json)).ToList();
        check(wrong.Count == 0, "Create Catalog refuses in SSMS's order and words: without sysadmin, when a catalog exists, without the backup's path or file, without the files' folder, "
            + "when its files are there already, and past the path bound; then, when CLR must be enabled, while other configuration changes wait for the RECONFIGURE that would apply them too; "
            + "CLR itself is not a refusal of the facts: " + string.Join("; ", wrong));
        check(!catalog.Retryable("CONFIGURATION_PENDING"), "CONFIGURATION_PENDING needs the user, so retrying alone does not help");
        var setup = SsisCreate.Setup("SSISDB", ok with { ScanForStartup = true });
        check(setup is { Catalog: "SSISDB", ClrEnabled: false, StartupDefault: true, DataFile: @"C:\Data\SSISDB.mdf", LogFile: @"C:\Data\SSISDB.ldf" } && setup.BackupFile.EndsWith("SSISDBBackup.bak", StringComparison.Ordinal),
            "the dialog's setup shows the catalog, CLR in use, SSMS's startup default (scan for startup procs), the backup and the files' places");

        var explorer = ExplorerCatalog.Current;
        ExplorerProfile Served(int major, bool linux = false) => new ServerProfile(major, major + ".0.1.1", 3, "sa", false, true, false, ExplorerCatalog.MinBand, linux).Explorer(explorer);
        var refusals = new[]
        {
            SsisCreate.Unsupported(catalog, Served(12), 3, false)?.Message, SsisCreate.Unsupported(catalog, Served(17, linux: true), 3, false)?.Message,
            SsisCreate.Unsupported(catalog, Served(17), 5, false)?.Message, SsisCreate.Unsupported(catalog, Served(17), 8, false)?.Message,
            SsisCreate.Unsupported(catalog, Served(17), 3, false)?.Message, SsisCreate.Unsupported(catalog, Served(17, linux: true), 3, true)?.Message, SsisCreate.Unsupported(catalog, Served(13), 2, false)?.Message
        };
        check(refusals[0] == "The SSIS Catalog needs SQL Server 2016 or later." && refusals[1] == "The SSIS Catalog isn't supported on SQL Server on Linux."
            && refusals[2] == refusals[3] && refusals[2]!.StartsWith("Create Catalog is not available on Azure SQL Database or Azure SQL Managed Instance", StringComparison.Ordinal)
            && refusals[4] is null && refusals[5] is null && refusals[6] is null,
            "Create Catalog is refused before connecting before 2016, on Linux, and on Azure SQL Database and Managed Instance; box servers from 2016 pass: " + string.Join(" | ", refusals));
    }

    private static async Task ValidationAsync(Action<bool, string> check)
    {
        using var reads = new SsisService(new SsisChecks.FakeHost());
        using var service = new SsisActionService(new SsisChecks.FakeHost(), reads);
        string Code(SsisExecuteArgs args)
        {
            try { service.Validate(args); return "ok"; }
            catch (RequestException error) { return error.Code; }
        }
        var create = Create();
        var cases = new (SsisExecuteArgs Args, string Expected)[]
        {
            (create, "ok"), (Create(new string('p', 128)), "ok"), (Create("x", enableClr: false, startup: true), "ok"), (Create(string.Concat(Enumerable.Repeat("\U0001D49C", 64))), "ok"),
            (Create(""), "INVALID_PARAMS"), (Create(new string('p', 129)), "INVALID_PARAMS"), (Create("a\0b"), "INVALID_PARAMS"), (Create(string.Concat(Enumerable.Repeat("\U0001D49C", 64)) + "a"), "INVALID_PARAMS"),
            (Create(enableClr: null), "INVALID_PARAMS"), (Create(startup: null), "INVALID_PARAMS"), (create with { Action = create.Action with { Password = null } }, "INVALID_PARAMS"),
            (create with { Action = create.Action with { OperationId = 1 } }, "INVALID_PARAMS"), (create with { Revision = new string('a', 64) }, "INVALID_PARAMS"),
            (new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new SsisActionDto("stopOperation", 42, Password: "x")), "INVALID_PARAMS"),
            (new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new SsisActionDto("stopOperation", 42, EnableClr: true)), "INVALID_PARAMS")
        };
        var wrong = cases.Where(item => Code(item.Args) != item.Expected).Select(item => item.Args.Action + " " + Code(item.Args)).ToList();
        check(wrong.Count == 0, "ssis.execute accepts Create Catalog with a password of 1 to 128 UTF-16 code units and both choices, and refuses an empty, long or NUL password, "
            + "a missing choice, an operation id, a revision, and Create Catalog's members on Stop Operation: " + string.Join("; ", wrong));
        var printed = create.ToString() + create.Action;
        check(!printed.Contains("Pa'ss", StringComparison.Ordinal) && printed.Contains("Password = <redacted>", StringComparison.Ordinal),
            "the request's records never print the catalog's password: " + printed);

        using var sql = new SqlService();
        async Task<string> Dispatch(string method, string body)
        {
            try { await sql.DispatchAsync(method, JsonDocument.Parse(body).RootElement, Json); return "ok"; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "JSON"; }
        }
        var ids = "\"connectionId\":\"" + Guid.NewGuid() + "\",\"requestId\":\"" + Guid.NewGuid() + "\"";
        var codes = new[]
        {
            await Dispatch("ssis.execute", "{" + ids + ",\"action\":{\"verb\":\"createCatalog\",\"password\":\"x\",\"enableClr\":true,\"startupProcedure\":false}}"),
            await Dispatch("ssis.execute", "{" + ids + ",\"action\":{\"verb\":\"createCatalog\",\"password\":\"\",\"enableClr\":true,\"startupProcedure\":false}}"),
            await Dispatch("ssis.execute", "{" + ids + ",\"action\":{\"verb\":\"createCatalog\",\"password\":\"x\",\"enableClr\":true,\"startupProcedure\":false,\"catalog\":\"Other\"}}"),
            await Dispatch("ssis.catalogSetup", "{" + ids + "}"),
            await Dispatch("ssis.catalogSetup", "{\"connectionId\":\"x\",\"requestId\":\"" + Guid.NewGuid() + "\"}"),
            await Dispatch("ssis.catalogSetup", "{" + ids + ",\"extra\":1}")
        };
        check(codes.SequenceEqual(["NOT_CONNECTED", "INVALID_PARAMS", "JSON", "NOT_CONNECTED", "INVALID_PARAMS", "JSON"]) && sql.Methods.Contains("ssis.catalogSetup")
            && SqlService.MethodNames.Contains("ssis.catalogSetup") && sql.LaneOf("ssis.catalogSetup") == RequestLane.Ssis && !sql.Sensitive("ssis.catalogSetup") && sql.Sensitive("ssis.execute")
            && !sql.AnswersStop("ssis.catalogSetup"),
            "Create Catalog's password rides the sensitive ssis.execute; ssis.catalogSetup is a read on the ssis lane, and both reject unknown members and check ids before the connection: " + string.Join(", ", codes));
    }

    /// <summary>What no server of this kind can do is answered at once, with no connection; others reach the write's own connection in
    /// master (or, for the dialog, the read pool), a sysadmin SQL Server login included, as in SSMS.</summary>
    private static async Task RefusedFirstAsync(Action<bool, string> check)
    {
        async Task<(SsisExecuteResult Result, SsisChecks.FakeHost Host)> Run(SsisChecks.FakeHost host)
        {
            using var reads = new SsisService(host);
            using var service = new SsisActionService(host, reads);
            return (await service.ExecuteAsync(Create(), CancellationToken.None), host);
        }
        var refused = new[] { await Run(new SsisChecks.FakeHost(12)), await Run(new SsisChecks.FakeHost(17, linux: true)), await Run(new SsisChecks.FakeHost(edition: 5)), await Run(new SsisChecks.FakeHost(edition: 8)) };
        check(refused.All(item => item.Result is { Steps: [], Error: { Code: "NOT_SUPPORTED", Retryable: false } } && item.Host.ActionConnections == 0 && item.Host.Opens == 0),
            "Create Catalog is refused before it connects before 2016, on Linux, on Azure SQL Database and on Managed Instance");
        var sqlLogin = await Run(new SsisChecks.FakeHost(auth: "sql"));
        var windows = await Run(new SsisChecks.FakeHost());
        check(new[] { sqlLogin, windows }.All(item => item.Result.Error is { Code: "AUTH_KERBEROS" } && item.Host.ActionConnections == 1 && item.Host.ActionCatalog == "master"),
            "Create Catalog opens its own write connection in master, not the catalog that does not exist yet, for a SQL Server login too");

        async Task<(SsisCatalogSetupResult Result, SsisChecks.FakeHost Host)> Setup(SsisChecks.FakeHost host)
        {
            using var reads = new SsisService(host);
            return (await reads.CatalogSetupAsync(new SsisCatalogSetupArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString()), CancellationToken.None), host);
        }
        var azure = await Setup(new SsisChecks.FakeHost(edition: 5));
        var box = await Setup(new SsisChecks.FakeHost());
        check(azure.Result is { Setup: null, Error.Code: "NOT_SUPPORTED" } && azure.Host.Opens == 0 && box.Result is { Setup: null, Error.Code: "AUTH_KERBEROS" } && box.Host.Opens == 1 && box.Host.ActionConnections == 0,
            "ssis.catalogSetup refuses Azure before connecting, and otherwise reads on the SSIS read pool, never the write connection, answering a sign-in failure as a value");
        try
        {
            using var reads = new SsisService(new SsisChecks.FakeHost());
            await reads.CatalogSetupAsync(new SsisCatalogSetupArgs("x", Guid.NewGuid().ToString()), CancellationToken.None);
            check(false, "ssis.catalogSetup accepts a bad connection id");
        }
        catch (RequestException error) { check(error.Code == "INVALID_PARAMS", "ssis.catalogSetup checks its ids"); }
    }

    /// <summary>Stop cancels a request's token; only a disconnect cancels the token a Create Catalog reply waits on past its restore.</summary>
    private static void Registry(Action<bool, string> check)
    {
        var registry = new RequestRegistry(4, "test");
        using var stop = new CancellationTokenSource();
        using var source = CancellationTokenSource.CreateLinkedTokenSource(stop.Token);
        var entry = registry.Register("a", "c", source);
        stop.Cancel();
        var afterStop = entry.ForgottenToken.IsCancellationRequested;
        registry.Forget("c");
        check(!afterStop && entry.ForgottenToken.IsCancellationRequested && entry.Forgotten && source.IsCancellationRequested,
            "Stop leaves a request's disconnect token alone, and a disconnect cancels it");
    }
}
