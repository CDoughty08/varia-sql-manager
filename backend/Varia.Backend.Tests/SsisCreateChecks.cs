using System.Diagnostics;
using System.Text.Json;
using Varia.Backend.Common;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of PR S9a, Create Catalog: the catalogue's verb and files, the SQL's lint (which catches what it exists
/// for) and the SSMS steps it must keep, the refusals before connecting and from the setup facts, request validation and
/// dispatch of ssis.execute's createCatalog and ssis.catalogSetup, the password never printed, the plan the write follows after its
/// preflight, what the removal names, and the bounded waits of Stop and shutdown. No server is reached: the live checks
/// (SsisCreateLiveChecks) run the SQL.</summary>
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
        Planning(check);
        Removal(check);
        await StopAsync(check);
    }

    /// <summary>The decisions the write follows after its preflight (SsisCreate.Plan): the CLR agreement, whether CLR is enabled, and
    /// the steps, which come only from here.</summary>
    private static void Planning(Action<bool, string> check)
    {
        var catalog = SsisCatalog.Current;
        var titles = catalog.Action("createCatalog")!.Steps;
        var off = Facts();
        var on = off with { ClrEnabled = true };
        static SsisActionDto Agree(bool? enable) => new("createCatalog", Password: "x", EnableClr: enable, StartupProcedure: true);
        string Describe(SsisCreate.CreatePlan plan) => (plan.Refusal?.Code ?? "ok") + " clr=" + plan.EnableClr + " " + string.Join("|", plan.Steps);
        var cases = new (SsisCreate.CreatePlan Plan, string? Code, bool EnableClr, string[] Steps)[]
        {
            (SsisCreate.Plan(catalog, off, Agree(false), dryRun: false), "CLR_REQUIRED", false, []),
            (SsisCreate.Plan(catalog, off, Agree(null), dryRun: false), "CLR_REQUIRED", false, []),
            (SsisCreate.Plan(catalog, off, Agree(false), dryRun: true), "CLR_REQUIRED", false, []),
            (SsisCreate.Plan(catalog, off, Agree(true), dryRun: false), null, true, [.. titles]),
            (SsisCreate.Plan(catalog, on, Agree(false), dryRun: false), null, false, [.. titles.Skip(1)]),
            (SsisCreate.Plan(catalog, off, Agree(true), dryRun: true), null, false, [titles[1], titles[2]]),
            (SsisCreate.Plan(catalog, on, Agree(true), dryRun: true), null, false, [titles[1], titles[2]])
        };
        var wrong = cases.Where(item => item.Plan.Refusal?.Code != item.Code || item.Plan.EnableClr != item.EnableClr || !item.Plan.Steps.SequenceEqual(item.Steps)).Select(item => Describe(item.Plan)).ToList();
        check(wrong.Count == 0, "Create Catalog's plan refuses CLR_REQUIRED with no step when CLR is off and the request did not agree, enables CLR first only when it is off, agreed and not a dry run, "
            + "and runs the restore and the master key, then outside a dry run the assembly and startup procedure and the maintenance job: " + string.Join("; ", wrong));
    }

    /// <summary>The setup read's facts for a box server where Create Catalog can run, with CLR off and nothing pending.</summary>
    private static CatalogFacts Facts() => new(true, "17.0.1000.7", false, false, false, @"C:\Program Files\Microsoft SQL Server\170\DTS\Binn\SSISDBBackup.bak", true,
        @"C:\Program Files\Microsoft SQL Server\170\DTS\Binn\Microsoft.SqlServer.IntegrationServices.Server.dll", @"C:\Data\", @"C:\Data\SSISDB.mdf", false, @"C:\Data\SSISDB.ldf", false);

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

        // What the message tells the user to delete: only what is left, by name, and CLR's note either way.
        var catalog = SsisCatalog.Current;
        var all = SsisCreate.Removal(new() { Restored = true, Recovered = true, Assembly = true, TrustedHash = [1, 2], Startup = true, Jobs = true }, "SSISDB", false, "13.0.7000.253")
            .Select(item => item.Command).ToList();
        var removed = SsisCreate.Outcome(catalog, "SSISDB", [], null, clrEnabled: true);
        var everything = SsisCreate.Outcome(catalog, "SSISDB", all, "Lock request time out period exceeded.", clrEnabled: true);
        var trustedOnly = SsisCreate.Outcome(catalog, "SSISDB", [SsisCreateSql.DropTrusted], "Cannot drop it.", clrEnabled: false);
        var database = SsisCreate.Outcome(catalog, "SSISDB", [SsisCreateSql.DropDatabase], "x", clrEnabled: false);
        check(removed == " Varia removed what Create Catalog had created, so the catalog does not exist. CLR integration stays enabled."
            && everything == " Removing what Create Catalog had created failed too (Lock request time out period exceeded.): delete the trusted assembly Create Catalog added for "
                + catalog.AssemblyFile + " (sys.sp_drop_trusted_assembly with its hash from sys.trusted_assemblies), the ##MS_SQLEnableSystemAssemblyLoadingUser## login, master.dbo.sp_ssis_startup, "
                + "the SSIS Server Maintenance Job and the ##MS_SSISServerCleanupJobLogin## login and the SSISDB database before you try again. CLR integration stays enabled."
            && trustedOnly.Contains("delete the trusted assembly Create Catalog added", StringComparison.Ordinal) && !trustedOnly.Contains("SSISDB database", StringComparison.Ordinal)
            && !trustedOnly.Contains("CLR", StringComparison.Ordinal) && database.EndsWith("delete the SSISDB database before you try again.", StringComparison.Ordinal),
            "a removal that failed names only what it left (the trusted assembly hash and the 2016 loading login among them), and says CLR integration stays enabled whether or not it failed: "
            + everything + " | " + trustedOnly);
    }

    /// <summary>ExecuteAsync's Stop reply against fake jobs: within the grace it is the job's answer; past it, a job that answers Stop itself
    /// (Create Catalog from its restore on) is waited for; any other job answers CANCELLED. A backend that shuts down waits, within its
    /// bound, for committed jobs only.</summary>
    private static async Task StopAsync(Action<bool, string> check)
    {
        using var reads = new SsisService(new SsisChecks.FakeHost(), new SsisOptions { StopGrace = TimeSpan.FromMilliseconds(200) });
        using var service = new SsisActionService(new SsisChecks.FakeHost(), reads);
        var answer = new SsisExecuteResult([new("done", "x")], 0);
        async Task<(string Outcome, long Ms)> Run(Task<SsisExecuteResult> job, bool committed)
        {
            var progress = new SsisActionService.JobProgress();
            if (committed) progress.Commit();
            var watch = Stopwatch.StartNew();
            try
            {
                var result = await service.AfterStopAsync(job, progress, new CancellationToken(true));
                return (result.Error?.Code ?? "answer", watch.ElapsedMilliseconds);
            }
            catch (RequestException error) { return ("request " + error.Code, watch.ElapsedMilliseconds); }
            catch (OperationCanceledException) { return ("cancelled", watch.ElapsedMilliseconds); }
        }
        async Task<SsisExecuteResult> After(int ms) { await Task.Delay(ms); return answer; }
        reads.Options.CreateDrain = TimeSpan.FromMilliseconds(1_500);
        var quick = await Run(After(20), false);
        var late = await Run(After(700), true);
        var abandoned = await Run(After(700), false);
        var early = await Run(Task.FromException<SsisExecuteResult>(new OperationCanceledException()), false);
        // A committed job that never ends (a restore waiting on a lock): Stop, and a disconnect, which answers the same way, still answer.
        var stuckJob = new TaskCompletionSource<SsisExecuteResult>().Task;
        var progressOf = new SsisActionService.JobProgress();
        progressOf.Commit();
        var stuckWatch = Stopwatch.StartNew();
        SsisExecuteResult? stuckAnswer = null;
        try { stuckAnswer = await service.AfterStopAsync(stuckJob, progressOf, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(30)); }
        catch (TimeoutException) { /* An unbounded wait: the check below fails. */ }
        var stuckMs = stuckWatch.ElapsedMilliseconds;
        check(quick is ("answer", < 200) && late is ("answer", >= 600) && abandoned is ("cancelled", >= 150 and < 600) && early.Outcome == "CANCELLED"
            && stuckAnswer is { Steps: [], Error.Code: "CANCELLED" } && stuckAnswer.Error.Message.Contains("goes on on the server", StringComparison.Ordinal) && stuckMs is >= 1_500 and < 10_000,
            "Stop's reply is the job's answer within the grace; past it, a job that answers Stop itself is waited for up to CreateDrain more, then answers CANCELLED as not known yet, "
            + "and any other job answers CANCELLED; a job that ended on the Stop before a step is a CANCELLED value: " + string.Join(", ", quick, late, abandoned, early) + ", stuck " + stuckMs + " ms");

        // Shutdown's drain: committed jobs only, within the bound.
        static SsisActionService.JobProgress Progress(bool committed) { var progress = new SsisActionService.JobProgress(); if (committed) progress.Commit(); return progress; }
        var jobs = new SsisActionService.CommittedJobs();
        var never = new TaskCompletionSource().Task;
        jobs.Track(never, Progress(false));
        var finishing = Task.Delay(300);
        jobs.Track(finishing, Progress(true));
        var watch = Stopwatch.StartNew();
        var drained = jobs.Wait(TimeSpan.FromSeconds(10));
        var drainedMs = watch.ElapsedMilliseconds;
        var stuck = new SsisActionService.CommittedJobs();
        stuck.Track(never, Progress(true));
        watch.Restart();
        var bounded = stuck.Wait(TimeSpan.FromMilliseconds(200));
        var boundedMs = watch.ElapsedMilliseconds;
        var empty = new SsisActionService.CommittedJobs().Wait(TimeSpan.FromSeconds(10));
        check(drained && drainedMs is >= 250 and < 5_000 && !bounded && boundedMs is >= 150 and < 5_000 && empty && new SsisOptions().CreateDrain == TimeSpan.FromMilliseconds(SsisCatalog.Current.Limit("createDrainMs"))
            && new SsisOptions().RestoreStop == TimeSpan.FromMilliseconds(SsisCatalog.Current.Limit("restoreStopMs")),
            "a backend that shuts down waits for a Create Catalog past its restore, not for jobs that end on their token, and no longer than its bound: " + drainedMs + " ms, " + boundedMs + " ms");
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
        check(new[] { 13, 14, 15, 16, 17, 18 }.Select(catalog.BackupFile).All(file => file == "SSISDBBackup.bak")
            && catalog.AssemblyFile == "Microsoft.SqlServer.IntegrationServices.Server.dll" && catalog.CleanupStep == "Remove the incomplete catalog"
            && catalog.Limit("catalogPassword") == 128 && catalog.Limit("serverPath") == 1024 && catalog.Limit("createDrainMs") == 120_000 && catalog.Limit("restoreStopMs") == 30_000
            && catalog.Limit("restoreStopMs") < catalog.Limit("createDrainMs") && !catalog.Retryable("CATALOG_EXISTS") && !catalog.Retryable("CLR_REQUIRED"),
            "the catalog backup is SSISDBBackup.bak on every version, as SSMS 22's Catalog.Create names it, beside the ISSERVER assembly; the password and paths are bounded, and so are a shutdown's "
            + "or a Stop's wait for a Create Catalog and the restore's run after it; CATALOG_EXISTS and CLR_REQUIRED need the user");
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
            ("cleanupLogin", SsisCreateSql.CleanupLogin.Text.Replace(" COLLATE Latin1_General_BIN2", "", StringComparison.Ordinal), [], "concatenates @login_password, which the server did not quote"),
            // sp_procoption ends with RECONFIGURE WITH OVERRIDE: neither runs before the pending-configuration guard.
            ("startupOn", "IF @startup = 1 EXEC sys.sp_procoption N'sp_ssis_startup', 'startup', 'on';", ["@startup"], "reconfigures the server without the pending-configuration guard"),
            ("enableClr", "EXEC sys.sp_configure N'clr enabled', 1;\nRECONFIGURE;", [], "reconfigures the server without the pending-configuration guard"),
            ("dropStartup", SsisCreateSql.DropStartup.Text.Replace(SsisCreateSql.PendingGuard, "", StringComparison.Ordinal), [], "reconfigures the server without the pending-configuration guard"),
            ("startupOn", "EXEC sys.sp_procoption N'sp_ssis_startup', 'startup', 'on';\n" + SsisCreateSql.StartupOn.Text, ["@startup"], "reconfigures the server without the pending-configuration guard"),
            // The restore, the read-only fix and the database drop are exempt only as Create Catalog's own commands, not by their id.
            ("dropDatabase", SsisCreateSql.DropDatabase.Text, ["@catalog", "@restoring"], "rolls other sessions back"),
            ("restore", SsisCreateSql.Restore.Text, [.. SsisCreateSql.Restore.Parameters], "restores a database"),
            // Inside text that runs, too.
            ("dropJobs", "EXEC (N'ALTER DATABASE [SSISDB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [SSISDB];');", [], "rolls other sessions back"),
            ("dropJobs", "EXEC (N'DROP DATABASE [SSISDB];');", [], "drops a database"),
            ("dropJobs", "EXEC (N'RESTORE DATABASE [SSISDB] FROM DISK = N''x'';');", [], "restores a database"),
            ("startupOn", "EXEC (N'EXEC sys.sp_procoption N''sp_ssis_startup'', ''startup'', ''on'';');", [], "reconfigures the server without the pending-configuration guard"),
            ("enableClr", "EXEC (N'EXEC master.dbo.xp_cmdshell N''dir'';');", [], "runs the shell")
        };
        var missed = caught.Where(item => !Problems(item.Id, item.Text, item.Parameters).Contains(item.Expected))
            .Select(item => item.Expected + " in " + item.Text + " (" + string.Join("; ", Problems(item.Id, item.Text, item.Parameters)) + ")").ToList();
        check(missed.Count == 0, "the Create Catalog lint rejects a password or parameter concatenated into SQL, or wrapped in anything but QUOTENAME or the server's binary-collation quote escape, "
            + "the password anywhere but once in the master key, unquoted dynamic text, RESTORE WITH REPLACE, a restore, drop or ROLLBACK IMMEDIATE outside their commands, format placeholders, "
            + "unknown variables and the shell: " + string.Join("; ", missed));
        var verbs = SsisCatalog.Current.Actions.Where(spec => spec.Server).Select(spec => (spec.Verb, Commands: SsisCreateSql.ServerCommands(spec.Verb))).ToList();
        check(verbs.Count > 0 && verbs.All(item => item.Commands is { Count: > 0 } commands && commands.All(command => SsisCreateSql.Lint(command, item.Verb).Count == 0))
            && SsisCreateSql.ServerCommands("stopOperation") is null && SsisCreateSql.ServerCommands("deleteCatalog") is null,
            "every server verb of the catalogue runs only commands SsisCreateSql lists for it, and they pass its lint for that verb; a server verb it does not know has none: " + string.Join(", ", verbs.Select(item => item.Verb + "=" + item.Commands?.Count)));
        var reused = SsisCreateSql.Lint(SsisCreateSql.DropDatabase, "deleteCatalog");
        check(reused.Contains("rolls other sessions back") && reused.Contains("drops a database") && SsisCreateSql.Lint(SsisCreateSql.Restore, "deleteCatalog").Contains("restores a database"),
            "Create Catalog's database drop (ROLLBACK IMMEDIATE) and restore pass the lint only for Create Catalog, so Delete Catalog cannot reuse them unchecked: " + string.Join("; ", reused));
    }

    /// <summary>What SSMS 22's object model and scripts do, kept: the reads it makes, the restore's parameters, the master key's quoting,
    /// the version test for the assembly, the startup procedure's body, and the maintenance job's steps and schedule.</summary>
    private static void Steps(Action<bool, string> check)
    {
        static bool Has(SsisCreateCommand command, params string[] parts) => parts.All(part => command.Text.Contains(part, StringComparison.Ordinal));
        check(Has(SsisCreateSql.Setup, "EXEC master.dbo.xp_regread N'HKEY_LOCAL_MACHINE', @key, N'', @dts OUTPUT;", "N'0\\SSIS\\Setup\\DTSPath'", "PARSENAME(@version, 4)", "N'Binn\\' + @backup_name",
                "INSERT @found EXEC master.dbo.xp_fileexist @backup;", "SERVERPROPERTY('MasterFile')", "CHARINDEX(N'master.mdf', LOWER(@master))", "@directory + @catalog + N'.mdf'", "@directory + @catalog + N'.ldf'",
                "c.name = N'clr enabled'", "c.name = N'scan for startup procs'", "IS_SRVROLEMEMBER(N'sysadmin')", "IF @sysadmin = 1", "SET LOCK_TIMEOUT 10000",
                "DECLARE @pending nvarchar(max) = " + SsisCreateSql.PendingList + ";", "@log_exists, @pending;")
            && Has(new("pending", SsisCreateSql.PendingList, []), "WHERE c.is_dynamic = 1 AND c.value <> c.value_in_use", "AND NOT (c.name = N'clr enabled' AND CONVERT(int, c.value) = 1)",
                "AND NOT (c.name = N'min server memory (MB)' AND CONVERT(int, c.value) = 0)")
            && SsisCreateSql.FileList.Text == "RESTORE FILELISTONLY FROM DISK = @backup;",
            "the setup reads what SSMS's Create reads: the registry's DTSPath for the version, the Binn folder's backup with xp_fileexist, the master database's folder and the new files, sysadmin, CLR, the startup default and the other dynamic configuration changes RECONFIGURE would apply, within a 10 s lock timeout");
        check(Has(SsisCreateSql.Restore, "RAISERROR(27135, 16, 1, @catalog)", "RESTORE DATABASE @catalog FROM DISK = @backup WITH MOVE @data_name TO @data_file, MOVE @log_name TO @log_file;",
                "MOVE @second_name TO @second_file") && !SsisCreateSql.Restore.Text.Contains("REPLACE", StringComparison.Ordinal)
            && Has(SsisCreateSql.ReadWrite, "d.is_read_only = 1", "QUOTENAME(@catalog) + N' SET READ_WRITE WITH ROLLBACK IMMEDIATE;'")
            && Has(SsisCreateSql.MasterKey, "DROP MASTER KEY", "N'CREATE MASTER KEY ENCRYPTION BY PASSWORD = N''' + REPLACE(@password COLLATE Latin1_General_BIN2, N'''', N'''''') + N''';'", "EXEC (@create);")
            && SsisCreateSql.MasterKey.Context == SsisCreateContext.Catalog && SsisCreateSql.CleanupUser.Context == SsisCreateContext.Catalog
            && SsisCreateSql.EnableClr.Text == "SET NOCOUNT ON;\nBEGIN\n" + SsisCreateSql.PendingGuard + "    EXEC sys.sp_configure N'clr enabled', 1;\n    RECONFIGURE;\nEND",
            "the restore refuses a database that appeared (27135) and never replaces one; the master key takes the password only through the server's quoting, in the catalog; CLR is enabled as SMO does, "
            + "behind the pending-configuration guard");
        // sp_procoption ends with RECONFIGURE WITH OVERRIDE (as SQL Server's own definition does), so every command that reconfigures
        // the server raises the guard's error, and stops, while other configuration changes wait.
        var guarded = SsisCreateSql.All.Where(command => System.Text.RegularExpressions.Regex.IsMatch(command.Text, @"\bRECONFIGURE\b|\bsp_procoption\b")).Select(command => command.Id).ToList();
        check(guarded.SequenceEqual(["enableClr", "dropStartup", "startupOn"]) && SsisCreateSql.All.Where(command => guarded.Contains(command.Id)).All(command => command.Text.Contains(SsisCreateSql.PendingGuard, StringComparison.Ordinal))
            && SsisCreateSql.PendingGuard.Contains("DECLARE @pending nvarchar(2000) = LEFT(" + SsisCreateSql.PendingList + ", 2000);", StringComparison.Ordinal)
            && SsisCreateSql.PendingGuard.Contains("16, " + SsisCreateSql.PendingState + ", @pending);\n        RETURN;", StringComparison.Ordinal)
            && SsisCreate.IsPendingGuard(50000, SsisCreateSql.PendingState) && !SsisCreate.IsPendingGuard(50000, 1) && !SsisCreate.IsPendingGuard(15281, SsisCreateSql.PendingState),
            "enabling CLR and every sp_procoption (the startup procedure, an earlier one's removal, the removal after a failure) run only behind the guard that refuses while other configuration "
            + "changes wait for a RECONFIGURE, and its error is told apart from the server's: " + string.Join(",", guarded));
        check(Has(SsisCreateSql.Assembly, "IF NOT (@major > 14 OR (@major = 14 AND (@minor > 0 OR (@minor = 0 AND (@build > 800 OR (@build = 800 AND @revision > 11))))))",
                "CREATE ASYMMETRIC KEY [MS_SQLEnableSystemAssemblyLoadingKey] FROM EXECUTABLE FILE", "GRANT UNSAFE ASSEMBLY TO [##MS_SQLEnableSystemAssemblyLoadingUser##]",
                "DECLARE @quoted nvarchar(2100) = REPLACE(@assembly COLLATE Latin1_General_BIN2, N'''', N'''''');", "OPENROWSET(BULK N''' + @quoted + N''', SINGLE_BLOB)", "HASHBYTES('SHA2_512', @bin)",
                "SET @trusted = CASE WHEN EXISTS (SELECT 1 FROM sys.trusted_assemblies AS t WHERE t.hash = @hash) THEN 1 ELSE 0 END;", "SELECT @hash, @trusted;")
            // The hash is read (and kept for the removal) before a statement of its own adds it: an add cut short is still removed.
            && !SsisCreateSql.Assembly.Text.Contains("sp_add_trusted_assembly", StringComparison.Ordinal)
            && SsisCreateSql.AddTrusted.Text == "IF NOT EXISTS (SELECT 1 FROM sys.trusted_assemblies AS t WHERE t.hash = @hash) EXEC sys.sp_add_trusted_assembly @hash, @assembly;"
            && Has(SsisCreateSql.CreateStartup, "CREATE PROCEDURE [dbo].[sp_ssis_startup]", "IF DB_ID('SSISDB') IS NULL", "SET @script = N'EXEC [SSISDB].[catalog].[startup]'", "EXECUTE sp_executesql @script")
            && SsisCreateSql.StartupOn.Text == "SET NOCOUNT ON;\nIF @startup = 1\nBEGIN\n" + SsisCreateSql.PendingGuard + "    EXEC sys.sp_procoption N'sp_ssis_startup', 'startup', 'on';\nEND"
            && SsisCreate.UsesAsymmetricKey("13.0.7000.253") && SsisCreate.UsesAsymmetricKey("14.0.800.11") && !SsisCreate.UsesAsymmetricKey("14.0.800.12")
            && !SsisCreate.UsesAsymmetricKey("14.0.1000.169") && !SsisCreate.UsesAsymmetricKey("14.1.0.0") && !SsisCreate.UsesAsymmetricKey("17.0.1000.7"),
            "the assembly is trusted by hash after 14.0.800.11, read before a statement of its own adds it, and through the asymmetric key before, as SSMS decides it; sp_ssis_startup is SSMS's, "
            + "and the startup option follows the choice");
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
            && Has(SsisCreateSql.DropJobs, "N'SSIS Server Maintenance Job'", "N'SSIS Failover Monitor Job'", "DROP LOGIN [##MS_SSISServerCleanupJobLogin##]")
            && SsisCreateSql.CatalogState.Text == "SELECT d.state FROM sys.databases AS d WHERE d.name = @catalog;",
            "a failure after the restore removes what Create Catalog made, as DropCatalog.sql does: only the hash it added, and a database left restoring only while it still is and no other session holds it (another restore's exclusive lock); "
            + "before it, a transaction a cancelled step left open ends and later lock waits are bounded (30 s), in a batch without parameters so the timeout lasts");
    }

    private static void Rules(Action<bool, string> check)
    {
        var catalog = SsisCatalog.Current;
        var ok = Facts();
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
                "Create Catalog reconfigures the server (RECONFIGURE to enable CLR integration, and sys.sp_procoption's RECONFIGURE WITH OVERRIDE for its startup procedure), which would also apply "
                + "these pending server configuration changes: cost threshold for parallelism, max server memory (MB)."),
            // CLR in use: sp_procoption still ends with RECONFIGURE WITH OVERRIDE.
            (ok with { PendingConfiguration = "max server memory (MB)", ClrEnabled = true }, "CONFIGURATION_PENDING", "these pending server configuration changes: max server memory (MB)."),
            (ok with { PendingConfiguration = "max server memory (MB)", Exists = true }, "CATALOG_EXISTS", "There already exists a catalog")
        };
        var wrong = cases.Where(item => SsisCreate.Refusal(catalog, item.Facts, "SSISDB") is var error && (error?.Code != item.Code || error is not null && !error.Message.Contains(item.Text, StringComparison.Ordinal)))
            .Select(item => JsonSerializer.Serialize(SsisCreate.Refusal(catalog, item.Facts, "SSISDB"), Json)).ToList();
        check(wrong.Count == 0, "Create Catalog refuses in SSMS's order and words: without sysadmin, when a catalog exists, without the backup's path or file, without the files' folder, "
            + "when its files are there already, and past the path bound; then, CLR in use or not, while other configuration changes wait for the RECONFIGURE (or sp_procoption's RECONFIGURE WITH OVERRIDE) that would apply them too; "
            + "CLR itself is not a refusal of the facts: " + string.Join("; ", wrong));
        check(!catalog.Retryable("CONFIGURATION_PENDING"), "CONFIGURATION_PENDING needs the user, so retrying alone does not help");
        // CLR: the request's agreement decides, whatever else runs; it is never a refusal when CLR is in use.
        static SsisActionDto Agree(bool? enable) => new("createCatalog", Password: "x", EnableClr: enable, StartupProcedure: false);
        var clr = new[]
        {
            SsisCreate.ClrRefusal(catalog, ok, Agree(false))?.Code, SsisCreate.ClrRefusal(catalog, ok, Agree(null))?.Code, SsisCreate.ClrRefusal(catalog, ok, Agree(true))?.Code,
            SsisCreate.ClrRefusal(catalog, ok with { ClrEnabled = true }, Agree(false))?.Code
        };
        check(clr.SequenceEqual(["CLR_REQUIRED", "CLR_REQUIRED", null, null]), "Create Catalog refuses CLR_REQUIRED when CLR integration is off and the request did not agree, and only then: " + string.Join(",", clr));
        var words = new[] { "Pa'ss", "\U0001D49Cx", "\uD835\uDC9C", "", "\uD800abc", "abc\uDC00", "\uDC00\uD800", "x\uD800" }.Select(SsisCreate.WellFormed).ToArray();
        check(words.SequenceEqual([true, true, true, true, false, false, false, false]), "a password must be well-formed UTF-16: a lone surrogate would cross the wire as U+FFFD");
        var longFailure = string.Join(" ", Enumerable.Range(0, 6).Select(index => "Lock request time out period exceeded " + index + new string('x', 900)));
        var failedStep = SsisCreate.CleanupStep(catalog, longFailure);
        var doneStep = SsisCreate.CleanupStep(catalog, null);
        check(failedStep.Status == "failed" && failedStep.Message!.Length <= catalog.Limit("messageChars") && failedStep.Message.StartsWith(catalog.CleanupStep + ": Lock request", StringComparison.Ordinal)
            && doneStep is { Status: "done", Message: "Remove the incomplete catalog" },
            "the removal's step names what failed, clipped to " + catalog.Limit("messageChars") + " characters as every SSIS message is (" + failedStep.Message?.Length + ")");
        var setup = SsisCreate.Setup("SSISDB", ok with { ScanForStartup = true });
        check(setup is { Catalog: "SSISDB", ClrEnabled: false, StartupDefault: true, DataFile: @"C:\Data\SSISDB.mdf", LogFile: @"C:\Data\SSISDB.ldf" } && setup.BackupFile.EndsWith("SSISDBBackup.bak", StringComparison.Ordinal),
            "the dialog's setup shows the catalog, CLR in use, SSMS's startup default (scan for startup procs), the backup and the files' places");

        var explorer = ExplorerCatalog.Current;
        ExplorerProfile Served(int major, bool linux = false, int edition = 3) => new ServerProfile(major, major + ".0.1.1", edition, "sa", false, true, false, ExplorerCatalog.MinBand, linux).Explorer(explorer);
        var refusals = new[]
        {
            SsisCreate.Unsupported(catalog, Served(12), 3, false)?.Message, SsisCreate.Unsupported(catalog, Served(17, linux: true), 3, false)?.Message,
            SsisCreate.Unsupported(catalog, Served(12, edition: 5), 5, false)?.Message, SsisCreate.Unsupported(catalog, Served(12, edition: 8), 8, false)?.Message,
            SsisCreate.Unsupported(catalog, Served(17), 3, false)?.Message, SsisCreate.Unsupported(catalog, Served(17, linux: true), 3, true)?.Message, SsisCreate.Unsupported(catalog, Served(13), 2, false)?.Message
        };
        check(refusals[0] == "The SSIS Catalog needs SQL Server 2016 or later." && refusals[1] == "The SSIS Catalog isn't supported on SQL Server on Linux."
            && refusals[2] == refusals[3] && refusals[2]!.StartsWith("Create Catalog is not available on Azure SQL Database or Azure SQL Managed Instance", StringComparison.Ordinal)
            && refusals[4] is null && refusals[5] is null && refusals[6] is null,
            "Create Catalog is refused before connecting before 2016, on Linux, and on Azure SQL Database and Managed Instance; box servers from 2016 pass: " + string.Join(" | ", refusals));
        // The explorer catalogue's other cloud editions: Synapse dedicated (6) and serverless (11), Azure SQL Edge (9), SQL database in Fabric (12).
        var cloud = new[] { 6, 9, 11, 12 }.Select(edition => SsisCreate.Unsupported(catalog, Served(12, edition: edition), edition, false)?.Message).ToList();
        check(explorer.CloudEditions.SetEquals([5, 6, 9, 11, 12]) && cloud.All(message => message is not null && message.StartsWith("Create Catalog is not available on this platform (engine edition ", StringComparison.Ordinal)),
            "Create Catalog is refused before connecting on every cloud edition of the explorer catalogue, saying the platform hosts no catalog: " + string.Join(" | ", cloud));
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
            (Create("\uD800abc"), "INVALID_PARAMS"), (Create("abc\uDC00"), "INVALID_PARAMS"),
            (Create(enableClr: null), "INVALID_PARAMS"), (Create(startup: null), "INVALID_PARAMS"), (create with { Action = create.Action with { Password = null } }, "INVALID_PARAMS"),
            (create with { Action = create.Action with { OperationId = 1 } }, "INVALID_PARAMS"), (create with { Revision = new string('a', 64) }, "INVALID_PARAMS"),
            (new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new SsisActionDto("stopOperation", 42, Password: "x")), "INVALID_PARAMS"),
            (new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new SsisActionDto("stopOperation", 42, EnableClr: true)), "INVALID_PARAMS")
        };
        var wrong = cases.Where(item => Code(item.Args) != item.Expected).Select(item => item.Args.Action + " " + Code(item.Args)).ToList();
        check(wrong.Count == 0, "ssis.execute accepts Create Catalog with a password of 1 to 128 UTF-16 code units and both choices, and refuses an empty, long, NUL or lone-surrogate password, "
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
        var refused = new[] { await Run(new SsisChecks.FakeHost(12)), await Run(new SsisChecks.FakeHost(17, linux: true)), await Run(new SsisChecks.FakeHost(edition: 5)), await Run(new SsisChecks.FakeHost(edition: 8)),
            await Run(new SsisChecks.FakeHost(edition: 6)), await Run(new SsisChecks.FakeHost(edition: 11)), await Run(new SsisChecks.FakeHost(edition: 12)) };
        check(refused.All(item => item.Result is { Steps: [], Error: { Code: "NOT_SUPPORTED", Retryable: false } } && item.Host.ActionConnections == 0 && item.Host.Opens == 0),
            "Create Catalog is refused before it connects before 2016, on Linux, on Azure SQL Database, on Managed Instance, on Synapse and on SQL database in Fabric");
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
        var fabric = await Setup(new SsisChecks.FakeHost(edition: 12));
        var box = await Setup(new SsisChecks.FakeHost());
        check(azure.Result is { Setup: null, Error.Code: "NOT_SUPPORTED" } && azure.Host.Opens == 0 && fabric.Result is { Setup: null, Error.Code: "NOT_SUPPORTED" } && fabric.Host.Opens == 0 && box.Result is { Setup: null, Error.Code: "AUTH_KERBEROS" } && box.Host.Opens == 1 && box.Host.ActionConnections == 0,
            "ssis.catalogSetup refuses Azure and the other cloud editions before connecting, and otherwise reads on the SSIS read pool, never the write connection, answering a sign-in failure as a value");
        try
        {
            using var reads = new SsisService(new SsisChecks.FakeHost());
            await reads.CatalogSetupAsync(new SsisCatalogSetupArgs("x", Guid.NewGuid().ToString()), CancellationToken.None);
            check(false, "ssis.catalogSetup accepts a bad connection id");
        }
        catch (RequestException error) { check(error.Code == "INVALID_PARAMS", "ssis.catalogSetup checks its ids"); }
    }
}
