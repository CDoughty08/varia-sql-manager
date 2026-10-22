using System.Text.RegularExpressions;

namespace Varia.Backend.Ssis;

/// <summary>One command of Create Catalog: its constant text, the parameters it may name (bound by SsisCreate, never formatted
/// into the text), and the database it runs in: master, the catalog's own database, or either (three-part names).</summary>
internal sealed record SsisCreateCommand(string Id, string Text, IReadOnlyList<string> Parameters, SsisCreateContext Context = SsisCreateContext.Master);

internal enum SsisCreateContext { Master, Catalog }

/// <summary>Create Catalog's SQL (D-ssis 6.13, S9a): SSMS 22's Catalog.Create, read from its object model
/// (Microsoft.SqlServer.Management.IntegrationServices and its CatalogHelper) and its embedded scripts (DatabaseCheck.sql,
/// CreateCatalog.sql, CreateCleanupJobLogin.sql, CreateMaintenanceJob.sql, DropCatalog.sql, DropSSISDB.sql), one command per
/// SSMS batch. Every value is a parameter: SSMS formats the catalog's name and paths into its text, Varia binds them, and where
/// SQL Server takes only a literal (a master key's password, a file in OPENROWSET or an asymmetric key, a login's password, a
/// database in ALTER DATABASE) the server quotes the value itself with REPLACE or QUOTENAME before EXEC. <see cref="Lint"/>
/// checks those rules for every command.</summary>
internal static partial class SsisCreateSql
{
    /// <summary>What the dialog and the write's preflight read (SSMS's Create checks): sysadmin, the catalog's database, clr enabled
    /// in use, scan for startup procs (SSMS's default for the startup procedure), the Integration Services folder from the
    /// registry's SSIS\Setup\DTSPath for the server's version (CatalogHelper.GetCatalogBackupPath's xp_regread), the catalog backup
    /// and assembly in its Binn folder, whether the backup exists (xp_fileexist), and the master database's folder for the new
    /// files (GetDataDirectoryPath) with whether they exist already (CheckIfDatabaseFilesExist). The extended procedures run only
    /// for sysadmin, who alone may create the catalog. Its own lock timeout, as a write's preflight: parameterized, so the SET ends
    /// with the batch.</summary>
    public static readonly SsisCreateCommand Setup = new("setup",
        "SET NOCOUNT ON; SET LOCK_TIMEOUT 10000;\n"
        + "DECLARE @sysadmin bit = CONVERT(bit, ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0));\n"
        + "DECLARE @version nvarchar(128) = CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion'));\n"
        + "DECLARE @exists bit = CASE WHEN EXISTS (SELECT 1 FROM sys.databases AS d WHERE d.name = @catalog) THEN 1 ELSE 0 END;\n"
        + "DECLARE @clr int = (SELECT CONVERT(int, c.value_in_use) FROM sys.configurations AS c WHERE c.name = N'clr enabled');\n"
        + "DECLARE @scan int = (SELECT CONVERT(int, c.value) FROM sys.configurations AS c WHERE c.name = N'scan for startup procs');\n"
        + "DECLARE @dts nvarchar(1024), @backup nvarchar(1024), @assembly nvarchar(1024), @master nvarchar(1024), @directory nvarchar(1024), @data nvarchar(1024), @log nvarchar(1024);\n"
        + "DECLARE @backup_exists int = 0, @data_exists int = 0, @log_exists int = 0;\n"
        + "DECLARE @found TABLE (file_exists int, is_directory int, parent_directory_exists int);\n"
        + "IF @sysadmin = 1\n"
        + "BEGIN\n"
        + "    DECLARE @key nvarchar(256) = N'SOFTWARE\\Microsoft\\Microsoft SQL Server\\' + PARSENAME(@version, 4) + N'0\\SSIS\\Setup\\DTSPath';\n"
        + "    EXEC master.dbo.xp_regread N'HKEY_LOCAL_MACHINE', @key, N'', @dts OUTPUT;\n"
        + "    IF LEN(@dts) > 0\n"
        + "    BEGIN\n"
        + "        IF RIGHT(@dts, 1) <> N'\\' SET @dts = @dts + N'\\';\n"
        + "        SET @backup = @dts + N'Binn\\' + @backup_name;\n"
        + "        SET @assembly = @dts + N'Binn\\' + @assembly_name;\n"
        + "        INSERT @found EXEC master.dbo.xp_fileexist @backup;\n"
        + "        SELECT @backup_exists = f.file_exists FROM @found AS f;\n"
        + "    END\n"
        + "    SET @master = CONVERT(nvarchar(1024), SERVERPROPERTY('MasterFile'));\n"
        + "    IF CHARINDEX(N'master.mdf', LOWER(@master)) > 1\n"
        + "    BEGIN\n"
        + "        SET @directory = SUBSTRING(@master, 1, CHARINDEX(N'master.mdf', LOWER(@master)) - 1);\n"
        + "        SET @data = @directory + @catalog + N'.mdf';\n"
        + "        SET @log = @directory + @catalog + N'.ldf';\n"
        + "        DELETE @found;\n"
        + "        INSERT @found EXEC master.dbo.xp_fileexist @data;\n"
        + "        SELECT @data_exists = f.file_exists FROM @found AS f;\n"
        + "        DELETE @found;\n"
        + "        INSERT @found EXEC master.dbo.xp_fileexist @log;\n"
        + "        SELECT @log_exists = f.file_exists FROM @found AS f;\n"
        + "    END\n"
        + "END\n"
        + "SELECT @sysadmin, @version, @exists, ISNULL(@clr, 0), ISNULL(@scan, 0), @backup, @backup_exists, @assembly, @directory, @data, @data_exists, @log, @log_exists;",
        ["@catalog", "@backup_name", "@assembly_name"]);

    /// <summary>The backup's logical files (CatalogHelper.GetLogicalNamesFromBackupFile): LogicalName and Type of each.</summary>
    public static readonly SsisCreateCommand FileList = new("fileList", "RESTORE FILELISTONLY FROM DISK = @backup;", ["@backup"]);

    /// <summary>The CLR checkbox: what SMO's Configuration.IsSqlClrEnabled with Alter() runs for SSMS's dialog.</summary>
    public static readonly SsisCreateCommand EnableClr = new("enableClr", "EXEC sys.sp_configure N'clr enabled', 1;\nRECONFIGURE;", []);

    /// <summary>DatabaseCheck.sql's 27135, in the restore's own batch, then CatalogHelper.RestoreCatalogBackup with every name and
    /// path a parameter. SSMS adds WITH REPLACE after checking the files; Varia does not, so a database or file that appeared
    /// since is never overwritten.</summary>
    public static readonly SsisCreateCommand Restore = new("restore",
        "SET NOCOUNT ON;\n"
        + "IF EXISTS (SELECT 1 FROM sys.databases AS d WHERE d.name = @catalog) RAISERROR(27135, 16, 1, @catalog);\n"
        + "ELSE IF @second_name IS NULL RESTORE DATABASE @catalog FROM DISK = @backup WITH MOVE @data_name TO @data_file, MOVE @log_name TO @log_file;\n"
        + "ELSE RESTORE DATABASE @catalog FROM DISK = @backup WITH MOVE @data_name TO @data_file, MOVE @second_name TO @second_file, MOVE @log_name TO @log_file;",
        ["@catalog", "@backup", "@data_name", "@data_file", "@second_name", "@second_file", "@log_name", "@log_file"]);

    /// <summary>CatalogHelper.MakeCatalogReadWrite.</summary>
    public static readonly SsisCreateCommand ReadWrite = new("readWrite",
        "SET NOCOUNT ON;\n"
        + "IF EXISTS (SELECT 1 FROM sys.databases AS d WHERE d.name = @catalog AND d.is_read_only = 1)\n"
        + "BEGIN\n"
        + "    DECLARE @alter nvarchar(400) = N'ALTER DATABASE ' + QUOTENAME(@catalog) + N' SET READ_WRITE WITH ROLLBACK IMMEDIATE;';\n"
        + "    EXEC sys.sp_executesql @alter;\n"
        + "END",
        ["@catalog"]);

    /// <summary>DropMasterKey.sql, then Catalog.CreateMasterKey's statement, in the catalog's database. The password reaches the
    /// text only through the server's REPLACE inside EXEC, as SSMS does; the literal is N'' so no character is lost.</summary>
    public static readonly SsisCreateCommand MasterKey = new("masterKey",
        "SET NOCOUNT ON;\n"
        + "IF EXISTS (SELECT 1 FROM sys.symmetric_keys AS k WHERE k.name = N'##MS_DatabaseMasterKey##') DROP MASTER KEY;\n"
        + "DECLARE @create nvarchar(max) = N'CREATE MASTER KEY ENCRYPTION BY PASSWORD = N''' + REPLACE(@password, N'''', N'''''') + N''';';\n"
        + "EXEC (@create);",
        ["@password"], SsisCreateContext.Catalog);

    /// <summary>CreateCatalog.sql's first batch: before 14.0.800.11, the asymmetric key from the assembly, its login and UNSAFE
    /// ASSEMBLY; from then, the assembly's SHA2_512 hash as a trusted assembly. Answers whether it added the hash, and the hash,
    /// so a failure after it removes only what it added.</summary>
    public static readonly SsisCreateCommand Assembly = new("assembly",
        "SET NOCOUNT ON;\n"
        + "DECLARE @version nvarchar(128) = CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion'));\n"
        + "DECLARE @major int = CONVERT(int, PARSENAME(@version, 4)), @minor int = CONVERT(int, PARSENAME(@version, 3)), @build int = CONVERT(int, PARSENAME(@version, 2)), "
        + "@revision int = CONVERT(int, PARSENAME(@version, 1));\n"
        + "DECLARE @quoted nvarchar(2100) = REPLACE(@assembly, N'''', N'''''');\n"
        + "DECLARE @statement nvarchar(max), @bin varbinary(max), @hash varbinary(64), @added bit = 0;\n"
        + "IF NOT (@major > 14 OR (@major = 14 AND (@minor > 0 OR (@minor = 0 AND (@build > 800 OR (@build = 800 AND @revision > 11))))))\n"
        + "BEGIN\n"
        + "    IF EXISTS (SELECT 1 FROM sys.server_principals AS p WHERE p.name = N'##MS_SQLEnableSystemAssemblyLoadingUser##') DROP LOGIN [##MS_SQLEnableSystemAssemblyLoadingUser##];\n"
        + "    IF EXISTS (SELECT 1 FROM sys.asymmetric_keys AS k WHERE k.name = N'MS_SQLEnableSystemAssemblyLoadingKey') DROP ASYMMETRIC KEY [MS_SQLEnableSystemAssemblyLoadingKey];\n"
        + "    SET @statement = N'CREATE ASYMMETRIC KEY [MS_SQLEnableSystemAssemblyLoadingKey] FROM EXECUTABLE FILE = N''' + @quoted + N''';';\n"
        + "    EXEC (@statement);\n"
        + "    CREATE LOGIN [##MS_SQLEnableSystemAssemblyLoadingUser##] FROM ASYMMETRIC KEY [MS_SQLEnableSystemAssemblyLoadingKey];\n"
        + "    GRANT UNSAFE ASSEMBLY TO [##MS_SQLEnableSystemAssemblyLoadingUser##];\n"
        + "END\n"
        + "ELSE\n"
        + "BEGIN\n"
        + "    SET @statement = N'SELECT @bin = d.BulkColumn FROM OPENROWSET(BULK N''' + @quoted + N''', SINGLE_BLOB) AS d;';\n"
        + "    EXEC sys.sp_executesql @statement, N'@bin varbinary(max) OUTPUT', @bin = @bin OUTPUT;\n"
        + "    SET @hash = HASHBYTES('SHA2_512', @bin);\n"
        + "    IF NOT EXISTS (SELECT 1 FROM sys.trusted_assemblies AS t WHERE t.hash = @hash)\n"
        + "    BEGIN\n"
        + "        EXEC sys.sp_add_trusted_assembly @hash, @assembly;\n"
        + "        SET @added = 1;\n"
        + "    END\n"
        + "END\n"
        + "SELECT @added, @hash;",
        ["@assembly"]);

    /// <summary>CreateCatalog.sql's second batch: an earlier sp_ssis_startup goes, startup flag first.</summary>
    public static readonly SsisCreateCommand DropStartup = new("dropStartup",
        "SET NOCOUNT ON;\n"
        + "IF EXISTS (SELECT 1 FROM sys.procedures AS p WHERE p.name = N'sp_ssis_startup')\n"
        + "BEGIN\n"
        + "    EXEC sys.sp_procoption N'sp_ssis_startup', 'startup', 'off';\n"
        + "    DROP PROCEDURE [dbo].[sp_ssis_startup];\n"
        + "END",
        []);

    /// <summary>CreateCatalog.sql's procedure, as SSMS creates it: it runs the catalog's startup through dynamic SQL so a
    /// non-readable Always On secondary does not fail it. Its text is the server's object, not Varia's statement.</summary>
    public static readonly SsisCreateCommand CreateStartup = new("createStartup",
        "CREATE PROCEDURE [dbo].[sp_ssis_startup]\n"
        + "AS\n"
        + "SET NOCOUNT ON\n"
        + "    /* Currently, the IS Store name is 'SSISDB' */\n"
        + "    IF DB_ID('SSISDB') IS NULL\n"
        + "        RETURN\n"
        + "\n"
        + "    IF NOT EXISTS(SELECT name FROM [SSISDB].sys.procedures WHERE name=N'startup')\n"
        + "        RETURN\n"
        + "\n"
        + "    /*Invoke the procedure in SSISDB  */\n"
        + "    /* Use dynamic sql to handle AlwaysOn non-readable mode*/\n"
        + "    DECLARE @script nvarchar(500)\n"
        + "    SET @script = N'EXEC [SSISDB].[catalog].[startup]'\n"
        + "    EXECUTE sp_executesql @script",
        []);

    /// <summary>CreateCatalog.sql's last batch, when "Enable automatic execution of Integration Services stored procedure at SQL
    /// Server startup" is checked.</summary>
    public static readonly SsisCreateCommand StartupOn = new("startupOn", "IF @startup = 1 EXEC sys.sp_procoption N'sp_ssis_startup', 'startup', 'on';", ["@startup"]);

    /// <summary>CreateCleanupJobLogin.sql's first batches: both SSIS jobs and the cleanup login go, then the login comes back with
    /// a random password the server generates and quotes, disabled.</summary>
    public static readonly SsisCreateCommand CleanupLogin = new("cleanupLogin",
        "SET NOCOUNT ON;\n"
        + "IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs AS j WHERE j.name = N'SSIS Server Maintenance Job') EXEC msdb.dbo.sp_delete_job @job_name = N'SSIS Server Maintenance Job';\n"
        + "IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs AS j WHERE j.name = N'SSIS Failover Monitor Job') EXEC msdb.dbo.sp_delete_job @job_name = N'SSIS Failover Monitor Job';\n"
        + "IF EXISTS (SELECT 1 FROM sys.server_principals AS p WHERE p.name = N'##MS_SSISServerCleanupJobLogin##') DROP LOGIN [##MS_SSISServerCleanupJobLogin##];\n"
        + "DECLARE @login_password nvarchar(256) = REPLACE(CONVERT(nvarchar(256), CRYPT_GEN_RANDOM(64)), N'''', N'''''');\n"
        + "DECLARE @login nvarchar(max) = N'CREATE LOGIN [##MS_SSISServerCleanupJobLogin##] WITH PASSWORD = N''' + @login_password + N''', CHECK_POLICY = OFF;';\n"
        + "EXEC (@login);\n"
        + "ALTER LOGIN [##MS_SSISServerCleanupJobLogin##] DISABLE;",
        []);

    /// <summary>CreateCleanupJobLogin.sql's batches in the catalog: the cleanup user and its two grants.</summary>
    public static readonly SsisCreateCommand CleanupUser = new("cleanupUser",
        "SET NOCOUNT ON;\n"
        + "IF EXISTS (SELECT 1 FROM sys.database_principals AS p WHERE p.name = N'##MS_SSISServerCleanupJobUser##') DROP USER [##MS_SSISServerCleanupJobUser##];\n"
        + "CREATE USER [##MS_SSISServerCleanupJobUser##] FOR LOGIN [##MS_SSISServerCleanupJobLogin##];\n"
        + "GRANT EXECUTE ON [internal].[cleanup_server_retention_window] TO [##MS_SSISServerCleanupJobUser##];\n"
        + "GRANT EXECUTE ON [internal].[cleanup_server_project_version] TO [##MS_SSISServerCleanupJobUser##];",
        [], SsisCreateContext.Catalog);

    /// <summary>CreateCleanupJobLogin.sql's last batch, in master as server permissions need.</summary>
    public static readonly SsisCreateCommand CleanupGrant = new("cleanupGrant", "GRANT VIEW SERVER STATE TO [##MS_SSISServerCleanupJobLogin##];", []);

    private const string RoleCheck = "\n\tDECLARE @role int\n\tSET @role = (SELECT [role] FROM [sys].[dm_hadr_availability_replica_states] hars INNER JOIN [sys].[availability_databases_cluster] adc "
        + "ON hars.[group_id] = adc.[group_id] WHERE hars.[is_local] = 1 AND adc.[database_name] =''SSISDB'')\n\tIF DB_ID(''SSISDB'') IS NOT NULL AND (@role IS NULL OR @role = 1)\n\t\t";

    /// <summary>CreateMaintenanceJob.sql: the SSIS Server Maintenance Job, owned by the cleanup login, two T-SQL steps that run on
    /// the primary replica only, three retries three minutes apart, daily at 00:00. The local server's name is read whole
    /// (SSMS's CONVERT(NVARCHAR, …) keeps 30 characters, which fails sp_add_jobserver for a longer name).</summary>
    public static readonly SsisCreateCommand MaintenanceJob = new("maintenanceJob",
        "SET NOCOUNT ON;\n"
        + "IF NOT EXISTS (SELECT 1 FROM sys.server_principals AS p WHERE p.name = N'##MS_SSISServerCleanupJobLogin##')\n"
        + "BEGIN\n"
        + "    RAISERROR(27229, 16, 1, N'##MS_SSISServerCleanupJobLogin##');\n"
        + "    RETURN;\n"
        + "END\n"
        + "IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs AS j WHERE j.name = N'SSIS Server Maintenance Job') EXEC msdb.dbo.sp_delete_job @job_name = N'SSIS Server Maintenance Job';\n"
        + "EXEC msdb.dbo.sp_add_job @job_name = N'SSIS Server Maintenance Job', @enabled = 1, @owner_login_name = N'##MS_SSISServerCleanupJobLogin##', "
        + "@description = N'Runs every day. The job removes operation records from the database that are outside the retention window and maintains a maximum number of versions per project.';\n"
        + "DECLARE @server nvarchar(128) = CONVERT(nvarchar(128), SERVERPROPERTY('ServerName'));\n"
        + "EXEC msdb.dbo.sp_add_jobserver @job_name = N'SSIS Server Maintenance Job', @server_name = @server;\n"
        + "EXEC msdb.dbo.sp_add_jobstep @job_name = N'SSIS Server Maintenance Job', @step_name = N'SSIS Server Operation Records Maintenance', @subsystem = N'TSQL', "
        + "@command = N'" + RoleCheck + "EXEC [SSISDB].[internal].[cleanup_server_retention_window]', @database_name = N'msdb', @on_success_action = 3, @retry_attempts = 3, @retry_interval = 3;\n"
        + "EXEC msdb.dbo.sp_add_jobstep @job_name = N'SSIS Server Maintenance Job', @step_name = N'SSIS Server Max Version Per Project Maintenance', @subsystem = N'TSQL', "
        + "@command = N'" + RoleCheck + "EXEC [SSISDB].[internal].[cleanup_server_project_version]', @database_name = N'msdb', @retry_attempts = 3, @retry_interval = 3;\n"
        + "EXEC msdb.dbo.sp_add_jobschedule @job_name = N'SSIS Server Maintenance Job', @name = N'SSISDB Scheduler', @enabled = 1, @freq_type = 4, @freq_interval = 1, "
        + "@freq_subday_type = 1, @active_start_date = 20001231, @active_end_date = 99991231, @active_start_time = 0, @active_end_time = 120000;",
        []);

    // --- What a failure after the restore removes (DropCatalog.sql and DropSSISDB.sql, limited to what Create Catalog made) ---

    /// <summary>The trusted assembly hash the assembly step added, and nothing else.</summary>
    public static readonly SsisCreateCommand DropTrusted = new("dropTrusted",
        "IF EXISTS (SELECT 1 FROM sys.trusted_assemblies AS t WHERE t.hash = @hash) EXEC sys.sp_drop_trusted_assembly @hash;", ["@hash"]);

    /// <summary>DropCatalog.sql's first batch: the assembly loading login of servers before 14.0.800.11, unless the Data Quality
    /// catalog (DependencyCatalog) shares it.</summary>
    public static readonly SsisCreateCommand DropLoadingLogin = new("dropLoadingLogin",
        "IF EXISTS (SELECT 1 FROM sys.server_principals AS p WHERE p.name = N'##MS_SQLEnableSystemAssemblyLoadingUser##')\n"
        + "    AND NOT EXISTS (SELECT 1 FROM sys.databases AS d WHERE d.name = N'DependencyCatalog')\n"
        + "    DROP LOGIN [##MS_SQLEnableSystemAssemblyLoadingUser##];",
        []);

    /// <summary>DropCatalog.sql's msdb batches: both SSIS jobs and the cleanup login.</summary>
    public static readonly SsisCreateCommand DropJobs = new("dropJobs",
        "SET NOCOUNT ON;\n"
        + "IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs AS j WHERE j.name = N'SSIS Server Maintenance Job') EXEC msdb.dbo.sp_delete_job @job_name = N'SSIS Server Maintenance Job';\n"
        + "IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs AS j WHERE j.name = N'SSIS Failover Monitor Job') EXEC msdb.dbo.sp_delete_job @job_name = N'SSIS Failover Monitor Job';\n"
        + "IF EXISTS (SELECT 1 FROM sys.server_principals AS p WHERE p.name = N'##MS_SSISServerCleanupJobLogin##') DROP LOGIN [##MS_SSISServerCleanupJobLogin##];",
        []);

    /// <summary>DropSSISDB.sql, for the database this Create Catalog restored: single-user and dropped, or only dropped while it is
    /// still restoring (a restore that failed part way). @restoring = 1 drops it only in that state, so a failed
    /// restore never drops a database someone else created meanwhile.</summary>
    public static readonly SsisCreateCommand DropDatabase = new("dropDatabase",
        "SET NOCOUNT ON;\n"
        + "DECLARE @state int = (SELECT d.state FROM sys.databases AS d WHERE d.name = @catalog);\n"
        + "IF @state IS NOT NULL AND (@restoring = 0 OR @state = 1)\n"
        + "BEGIN\n"
        + "    DECLARE @drop nvarchar(600) = CASE WHEN @state = 0 THEN N'ALTER DATABASE ' + QUOTENAME(@catalog) + N' SET SINGLE_USER WITH ROLLBACK IMMEDIATE; ' ELSE N'' END\n"
        + "        + N'DROP DATABASE ' + QUOTENAME(@catalog) + N';';\n"
        + "    EXEC sys.sp_executesql @drop;\n"
        + "END",
        ["@catalog", "@restoring"]);

    /// <summary>Every command, for the lint and the docs.</summary>
    public static IEnumerable<SsisCreateCommand> All =>
    [
        Setup, FileList, EnableClr, Restore, ReadWrite, MasterKey, Assembly, DropStartup, CreateStartup, StartupOn, CleanupLogin, CleanupUser, CleanupGrant, MaintenanceJob,
        DropTrusted, DropLoadingLogin, DropJobs, DropDatabase
    ];

    [GeneratedRegex(@"(?<![@\w])@[A-Za-z_]\w*")]
    private static partial Regex Variables();
    [GeneratedRegex(@"\bDECLARE\s+(@\w+)|,\s*(@\w+)\s+(?:int|bit|nvarchar|varbinary|TABLE)\b", RegexOptions.IgnoreCase)]
    private static partial Regex Declarations();
    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex Literals();
    /// <summary>A variable next to a +: text concatenated into a statement.</summary>
    [GeneratedRegex(@"\+\s*(@\w+)|(@\w+)\s*\+")]
    private static partial Regex Concatenated();
    /// <summary>Text that runs as SQL: EXEC of a string or a variable, or sp_executesql.</summary>
    [GeneratedRegex(@"\bEXEC(?:UTE)?\s*\(|\bsp_executesql\s+@", RegexOptions.IgnoreCase)]
    private static partial Regex Dynamic();
    /// <summary>A variable assigned from the server's own quoting.</summary>
    [GeneratedRegex(@"(@\w+)\s+nvarchar\(\d+\)\s*=\s*REPLACE\(")]
    private static partial Regex QuotedAssignment();
    private const string QuoteEscape = "REPLACE(@password, N'''', N'''''')";

    /// <summary>Problems with one command; empty when it passes. Its text is constant (no format placeholder); it names only its
    /// own parameters and the variables it declares; only the master key reads the password, and only through the server's
    /// quoting; a variable concatenated into a statement is never a parameter, only one the command assigned from REPLACE's
    /// quoting (or QUOTENAME inline); the restore never replaces; only the read-only fix and the database drop roll other
    /// sessions back; and nothing runs the shell.</summary>
    public static List<string> Lint(SsisCreateCommand command)
    {
        var problems = new List<string>();
        var text = command.Text;
        if (text.Contains('{') || text.Contains('}')) problems.Add("has a format placeholder");
        var code = Literals().Replace(text, "''");
        var declared = Declarations().Matches(code).Select(match => match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
        // sp_executesql's OUTPUT parameter and a procedure's named parameters (@job_name = …) are not variables of the command.
        var named = Regex.Matches(code, @"(@\w+)\s*=(?!=)").Select(match => match.Groups[1].Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var variable in Variables().Matches(code).Select(match => match.Value).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            if (declared.Contains(variable) || command.Parameters.Contains(variable, StringComparer.OrdinalIgnoreCase)) continue;
            if (named.Contains(variable) && Regex.IsMatch(code, @"EXEC\S*\s[^;]*" + Regex.Escape(variable) + @"\s*=", RegexOptions.IgnoreCase)) continue;
            problems.Add("names " + variable + ", which is neither its parameter nor declared");
        }
        if (text.Contains("@password", StringComparison.OrdinalIgnoreCase) != (command.Id == "masterKey")) problems.Add(command.Id == "masterKey" ? "does not read the password" : "reads the password");
        if (command.Id == "masterKey" && (text.Replace(QuoteEscape, "", StringComparison.Ordinal).Contains("@password", StringComparison.OrdinalIgnoreCase) || !text.Contains(QuoteEscape, StringComparison.Ordinal)))
            problems.Add("uses the password other than through the server's quoting");
        var quoted = QuotedAssignment().Matches(code.Replace(QuoteEscape, "''", StringComparison.Ordinal)).Select(match => match.Groups[1].Value).ToHashSet(StringComparer.OrdinalIgnoreCase);
        // Only text that runs (EXEC of a string, sp_executesql) matters: elsewhere a + builds a value, such as the setup's paths.
        if (Dynamic().IsMatch(code))
            foreach (Match match in Concatenated().Matches(code))
            {
                var variable = match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value;
                if (command.Parameters.Contains(variable, StringComparer.OrdinalIgnoreCase)) problems.Add("concatenates the parameter " + variable + " into a statement");
                else if (!quoted.Contains(variable)) problems.Add("concatenates " + variable + ", which the server did not quote");
            }
        if (Regex.IsMatch(code, @"\bWITH\s+REPLACE\b|,\s*REPLACE\s*(,|;|$)", RegexOptions.IgnoreCase | RegexOptions.Multiline)) problems.Add("restores WITH REPLACE");
        if (code.Contains("RESTORE DATABASE", StringComparison.OrdinalIgnoreCase) && command.Id != "restore") problems.Add("restores a database");
        if (code.Contains("ROLLBACK IMMEDIATE", StringComparison.OrdinalIgnoreCase) && command.Id is not ("readWrite" or "dropDatabase")) problems.Add("rolls other sessions back");
        if (code.Contains("DROP DATABASE", StringComparison.OrdinalIgnoreCase) && command.Id != "dropDatabase") problems.Add("drops a database");
        if (code.Contains("xp_cmdshell", StringComparison.OrdinalIgnoreCase)) problems.Add("runs the shell");
        return problems;
    }
}
