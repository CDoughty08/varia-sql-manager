using System.Globalization;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace Varia.Backend.Tests;

/// <summary>A script's outcome with its rows already read (display text, null for NULL), so its session can close at once.</summary>
internal sealed record SqlRun(string Status, string? Error, List<List<string?[]>> Sets)
{
    public string? Scalar => Sets.Count > 0 && Sets[0].Count > 0 ? Sets[0][0][0] : null;
}

/// <summary>A uniquely named, marked scratch database for the Object Explorer checks, created only with
/// VARIA_TEST_SQL_SCRATCH=1 (a disposable development server): VariaScratch_&lt;yyyyMMddHHmmss&gt;_&lt;8 hex&gt; with a
/// case-sensitive collation, plus _ro (read-only), _off (offline), _su (single-user), _snap (a snapshot), and a
/// low-privilege login when the server allows SQL logins. Everything is dropped on dispose; leftovers older than 6 h are swept on the next run.</summary>
internal sealed partial class ScratchDatabase : IAsyncDisposable
{
    private readonly Func<string, string, Task<SqlRun>> run;
    private readonly List<string> created = [];
    /// <summary>The files of a database the Detach checks detached, until it is attached again: disposal attaches it, then drops it.</summary>
    private readonly Dictionary<string, List<string>> detachedFiles = new(StringComparer.Ordinal);
    private bool loginCreated;
    private Backup? restoringBackup;
    private readonly List<string> restoreFiles = [];
    private (string Folder, int Major)? restoreTarget;

    private ScratchDatabase(Func<string, string, Task<SqlRun>> run, string suffix)
    {
        this.run = run;
        Name = "VariaScratch_" + suffix;
        Password = RandomPassword();
    }

    public string Name { get; }
    public string ReadOnly => Name + "_ro";
    public string Offline => Name + "_off";
    public string SingleUser => Name + "_su";
    /// <summary>A database left RESTORING by a tail-log backup WITH NORECOVERY (created on demand, by CreateStatesAsync), its
    /// backups where <see cref="Backup"/> puts them.</summary>
    public string Restoring => Name + "_rs";
    public string Snapshot => Name + "_snap";
    /// <summary>A database Object Explorer's status checks revert to its snapshot <see cref="RevertSnapshot"/>: a RESTORE that
    /// needs no backup file (created on demand, by CreateRevertAsync).</summary>
    public string Reverted => Name + "_rv";
    public string RevertSnapshot => Name + "_rvs";
    /// <summary>The SQL Server Agent job Object Explorer's status checks run, marked by its description.</summary>
    public string Job => Name + "_job";
    /// <summary>What marks a scratch Agent job (its description), as the extended property marks a database.</summary>
    public const string JobMarker = "varia.scratch";
    /// <summary>Where the Script As round trip runs scripts (created on demand).</summary>
    public string RoundTrip => Name + "_rt";
    /// <summary>Where the Script As injection matrix creates its objects and runs their scripts (created on demand).</summary>
    public string Injection => Name + "_inj";
    /// <summary>Where the object-action checks rename and drop objects, then rename and drop the database (created on demand).</summary>
    public string Actions => Name + "_act";
    /// <summary>The name the object-action checks rename <see cref="Actions"/> to and back.</summary>
    public string ActionsRenamed => Name + "_actr";
    /// <summary>Where the Database Properties checks change options, scoped configurations and the owner (created on demand).</summary>
    public string Properties => Name + "_dbp";
    /// <summary>Where the table designer checks create tables (created on demand).</summary>
    public string Designer => Name + "_tbd";
    /// <summary>A second table designer database, whose name HAS_PERMS_BY_NAME cannot read unbracketed (created on demand).</summary>
    public string DesignerOdd => Name + "_tbd.]";
    /// <summary>The fake SSIS catalog: tables named after SSISDB's catalog views, built from tests/fixtures/ssisdb (created on demand).</summary>
    public string Ssis => Name + "_ssis";
    /// <summary>The Integration Services feature's own catalog backup restored under a scratch name, so its schema can be read
    /// without a catalog (created on demand; never named SSISDB, never given a master key, CLR or jobs).</summary>
    public string SsisReference => Name + "_ssisref";
    /// <summary>Where Create Catalog's dry run restores the catalog backup and creates its master key (S9a; the backend creates it).</summary>
    public string SsisCreate => Name + "_ssiscc";
    /// <summary>The low-privilege login (same name as the database), when the server accepts SQL logins.</summary>
    public string? Login { get; private set; }
    /// <summary>Where the live table checks read a message log and a snapshot table (created on demand).</summary>
    public string Live => Name + "_live";
    /// <summary>The server file picker's database, whose backup file (on Linux) the backup folder's listing must show.</summary>
    public string Files => Name + "_files";
    /// <summary>Where the wave 5 seam checks run runner v2's compensation, the shared templates and the pre-move (created on demand).</summary>
    public string Seam => Name + "_seam";
    /// <summary>The name the seam checks' rename collides with (created on demand, with <see cref="Seam"/>).</summary>
    public string SeamTaken => Name + "_seamt";
    /// <summary>Where the New Login checks (D2a) run Create Catalog's master key batch under the Extended Events check (created on demand).</summary>
    public string LoginsDatabase => Name + "_lgn";
    /// <summary>Where the User Mapping checks (D2b) map New Login's logins (created on demand).</summary>
    public string MappingDatabase => Name + "_lgm";
    /// <summary>The User Mapping checks' offline database, which a mapping must not reach (created on demand).</summary>
    public string MappingOffline => Name + "_lgmo";
    /// <summary>The User Mapping checks' read-only database, which a mapping must not reach either (created on demand).</summary>
    public string MappingReadOnly => Name + "_lgmr";
    /// <summary>A SQL login the New Login checks create, `tag` being 1 to 8 lowercase letters or digits; dropped on disposal once owned.</summary>
    public string LoginNamed(string tag) => Name + "_l" + tag;
    /// <summary>The New Login checks' Extended Events session (critic A16), dropped on disposal once owned.</summary>
    public string XeSession => Name + "_xe";
    private readonly List<string> ownedLogins = [];
    private bool ownsXeSession;
    /// <summary>Restore Database's source (D1e): FULL recovery, its backups in real files in the backup folder (<see cref="RestoreFile"/>),
    /// which disposal deletes before its backup history.</summary>
    public string RestoreSource => Name + "_rst";
    /// <summary>Where the Restore Database checks restore a plan of <see cref="RestoreSource"/>'s backups (adopted when used).</summary>
    public string RestoreTarget => Name + "_rstr";
    /// <summary>Restore Database's forked source: FULL recovery, restored in place to a point in time between its log backups, so
    /// the next log forks; its backups are files like <see cref="RestoreSource"/>'s, deleted before its history.</summary>
    public string RestoreFork => Name + "_rstf";
    /// <summary>New Database's database (D1b), which OK itself creates; the checks mark it at once and adopt it.</summary>
    public string NewDatabase => Name + "_nd";
    /// <summary>Restore Files and Filegroups' database (D1g): FULL recovery, then SIMPLE, with a second filegroup and a third, its
    /// backups files like <see cref="RestoreSource"/>'s, deleted before its history.</summary>
    public string RestoreFiles => Name + "_rfl";
    /// <summary>Where the action progress checks back up with STATS and hold a lock (D1c; created on demand).</summary>
    public string Progress => Name + "_ap";
    /// <summary>Attach Databases' database: three files the attach checks detach and attach again (created on demand, by
    /// CreateAttachAsync). A run that crashes while it is detached leaves its files; the next dispose of the same run attaches
    /// them again to drop them, but the sweep cannot see a detached database.</summary>
    public string Attach => Name + "_at";
    /// <summary>The hostile name the attach checks attach <see cref="Attach"/>'s files as.</summary>
    public string AttachAs => Name + "_at']";
    /// <summary>The name of the attach checks' second database, whose file is missing (never created, unless an attach goes wrong).</summary>
    public string AttachMissing => Name + "_at2";
    private string[]? attachFiles;
    /// <summary>Where the Take Offline and Bring Online checks take a database offline and back (created on demand).</summary>
    public string DatabaseState => Name + "_dbs";
    /// <summary>Where the Detach checks detach a database and attach it again (created on demand).</summary>
    public string Detached => Name + "_det";
    /// <summary>A snapshot of <see cref="Detached"/>, which makes sp_detach_db fail (created on demand).</summary>
    public string DetachedSnapshot => Name + "_dets";
    /// <summary>Delete parity (D3d): an offline database Delete drops (its files stay), and one whose snapshot fails its DROP.</summary>
    public string DeleteOffline => Name + "_del";
    public string DeleteCompensated => Name + "_delc";
    public string DeleteSnapshot => Name + "_delcs";
    /// <summary>Delete parity (D3d): a database the low-privilege login owns, which it describes, scripts and deletes without VIEW SERVER STATE.</summary>
    public string DeleteOwned => Name + "_delo";
    /// <summary>Where the database rename checks (D3c) rename a database, the name they rename it to, and the name its compensation check takes first (created on demand).</summary>
    public string Rename => Name + "_ren";
    public string Renamed => Name + "_renn";
    public string RenameTaken => Name + "_rent";
    /// <summary>Held in memory only, never printed.</summary>
    public string Password { get; }
    public bool HasSnapshot { get; private set; }
    public int Major { get; private set; }
    /// <summary>Whether the server has Full-Text Search installed, which changes what SMO scripts for a full-text catalog.</summary>
    public bool FullText { get; private set; }

    // _act and _actr are the object-action checks' database and the name they rename it to (PR17), so a run that crashes
    // mid-rename leaves nothing the sweep cannot find; _dbp is Database Properties' database, _tbd and _tbd.] the table designer's,
    // _live the live tables', _ssis the fake SSIS catalog, _ssisref the restored catalog backup and _ssiscc Create Catalog's
    // dry run; _rs is left restoring, and _rv is reverted to its snapshot _rvs; _files is the server file picker's; _seam and _seamt are the wave 5 seam checks'; _nd is New Database's; _ap the action progress checks';
    // _at, _at'] and _at2 Attach Databases'; _rst Restore Database's source, _rstf its forked source and _rstr where their plans are restored; _rfl Restore Files and Filegroups' database; _lgn New Login's, _lgm, _lgmo (offline) and _lgmr (read-only) its User Mapping's; _dbs Take Offline's and
    // Bring Online's (a crashed run can leave it offline, which the sweep drops by state); _del, _delc, _delcs and _delo Delete parity's (D3d): an offline
    // database, a database with its snapshot, and the login's own; _det Detach's and _dets its snapshot (a run that crashes while _det is detached
    // leaves only its files, which disposal attaches again when it can); and _ren, _renn and _rent the database rename checks' (D3c): a crashed run
    // can leave either name, or one in SINGLE_USER, which the DROP handles.
    [GeneratedRegex(@"^VariaScratch_\d{14}_[0-9a-f]{8}(_ro|_off|_su|_rs|_rv|_rvs|_snap|_rt|_inj|_act|_actr|_dbp|_tbd|_tbd\.\]|_live|_ssis|_ssisref|_ssiscc|_files|_seam|_seamt|_nd|_ap|_at|_at'\]|_at2|_rst|_rstr|_rstf|_rfl|_lgn|_lgm|_lgmo|_lgmr|_dbs|_del|_delc|_delcs|_delo|_det|_dets|_ren|_renn|_rent)?$")]
    private static partial Regex Pattern();
    [GeneratedRegex(@"^[a-z0-9]{1,8}\.(bak|trn)$")]
    private static partial Regex PartPattern();
    // A run's own login, and New Login's (_l and a tag).
    [GeneratedRegex(@"^VariaScratch_\d{14}_[0-9a-f]{8}(_l[a-z0-9]{1,8})?$")]
    private static partial Regex LoginPattern();
    // New Login's Extended Events session; its name's UTC timestamp dates it, as sys.server_event_sessions has no creation date.
    [GeneratedRegex(@"^VariaScratch_(\d{14})_[0-9a-f]{8}_xe$")]
    private static partial Regex XePattern();

    /// <summary>Whether the sweep drops a stale SQL login of this name.</summary>
    internal static bool SweepableLogin(string name) => LoginPattern().IsMatch(name);
    /// <summary>Whether an Extended Events session of this name is a run's of the checks, created before `before` (UTC).</summary>
    internal static bool StaleXeSession(string name, DateTime before) => XePattern().Match(name) is { Success: true } match
        && DateTime.TryParseExact(match.Groups[1].Value, "yyyyMMddHHmmss", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var created) && created < before;
    [GeneratedRegex(@"^VariaScratch_\d{14}_[0-9a-f]{8}_job$")]
    private static partial Regex JobPattern();

    /// <summary>Whether an Agent job's name is one a run of the checks gave its own job (<see cref="Job"/>); the sweep deletes
    /// only such jobs that also carry <see cref="JobMarker"/>.</summary>
    internal static bool IsScratchJob(string name) => JobPattern().IsMatch(name);

    /// <summary>Whether the sweep drops a database of this name once it is stale and marked (or not online).</summary>
    internal static bool Sweepable(string name) => Pattern().IsMatch(name);

    /// <summary>Whether a name is a scratch object's, this run's or another's on the same server: the .NET checks'
    /// VariaScratch_ databases, logins and server objects, and the vitest and smoke suites' varia_scratch_ databases.
    /// Another run's can be mid-setup, single-user, offline or gone a moment later.</summary>
    public static bool IsScratchName(string name) =>
        name.StartsWith("VariaScratch_", StringComparison.Ordinal) || name.StartsWith("varia_scratch_", StringComparison.OrdinalIgnoreCase);

    /// <summary>Lists every database by name, for "the server is unchanged" checks through <see cref="Lasting"/>.</summary>
    public const string DatabaseNamesSql = "SELECT name FROM sys.databases ORDER BY name;";

    /// <summary>The database names no other run creates or drops, from <see cref="DatabaseNamesSql"/>. Other runs on the
    /// same server add and drop scratch databases at any moment, so a count of every database is not this run's to check.</summary>
    public static string Lasting(SqlRun run) =>
        string.Join("\n", (run.Sets.Count > 0 ? run.Sets[0] : []).Select(row => row[0] ?? "").Where(name => !IsScratchName(name)));

    /// <summary>A throwaway password for a scratch login, never printed.</summary>
    internal static string Throwaway() => RandomPassword();

    private static string RandomPassword()
    {
        const string alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        // Every character class appears, so the password satisfies any complexity policy.
        return "Vx9!" + new string(Enumerable.Range(0, 28).Select(_ => alphabet[RandomNumberGenerator.GetInt32(alphabet.Length)]).ToArray());
    }

    private async Task<SqlRun> Exec(string sql, string database = "master")
    {
        var result = await run(sql, database);
        if (result.Status != "completed") throw new InvalidOperationException("Scratch setup failed: " + result.Error);
        return result;
    }

    /// <summary>Drops scratch databases and logins older than 6 hours that carry the marker or are not online (names only are logged).</summary>
    public static async Task SweepAsync(Func<string, string, Task<SqlRun>> run, Action<string>? log = null)
    {
        log ??= Console.WriteLine;
        // HAS_DBACCESS waits on a single-user database another session is in; reading its marker then fails, which leaves it alone.
        var result = await run("SELECT d.name, d.state, CONVERT(bit, CASE WHEN d.create_date < DATEADD(hour, -6, GETDATE()) THEN 1 ELSE 0 END), "
            + "CONVERT(bit, ISNULL(CASE WHEN d.user_access = 1 THEN 1 ELSE HAS_DBACCESS(d.name) END, 0)) "
            + "FROM sys.databases AS d WHERE d.name LIKE N'VariaScratch[_]%' ORDER BY CASE WHEN d.source_database_id IS NULL THEN 1 ELSE 0 END;", "master");
        foreach (var row in result.Sets.Count == 0 ? [] : result.Sets[0])
        {
            var name = row[0]!;
            if (!Pattern().IsMatch(name) || row[2] != "1") continue;
            var online = row[1] == "0";
            // An online database is dropped only when its marker can be read and is there; one this login cannot open is left alone.
            if (online)
            {
                if (row[3] != "1") continue;
                var marker = await run("DECLARE @sql nvarchar(max) = N'SELECT COUNT(*) FROM ' + QUOTENAME(" + Quote(name) + ") + N'.sys.extended_properties WHERE class = 0 AND name = N''varia.scratch'';';\nEXEC (@sql);", "master");
                if (marker.Status != "completed" || marker.Scalar is null or "0") continue;
            }
            log("Dropping stale scratch database " + name);
            // Only an offline database is brought online first, so its files go with it; a restoring one cannot be, and drops as it is.
            await Drop(run, name, row[1] != "6");
        }
        // A crashed run's backup files on Linux (Windows ones went to NUL) and its backup history, once their database is gone.
        var backups = await run(StaleBackupsSql, "msdb");
        foreach (var group in (backups.Sets.Count == 0 ? [] : backups.Sets[0]).Where(row => row[0] is { } name && Pattern().IsMatch(name)).GroupBy(row => row[0]!, StringComparer.Ordinal))
        {
            foreach (var row in group)
                if (row[1] is { } device && device != NullDevice && Backup.Stale(device, row[2] ?? "", group.Key)
                    && (await run(Backup.DeleteSql(device, int.Parse(row[3]!, CultureInfo.InvariantCulture)), "master")).Status != "completed")
                    log("Could not delete a stale scratch backup file of " + group.Key);
            await run(HistorySql(group.Key), "msdb");
        }
        var logins = await run("SELECT name FROM sys.server_principals WHERE name LIKE N'VariaScratch[_]%' AND type = 'S' AND create_date < DATEADD(hour, -6, GETDATE());", "master");
        foreach (var row in logins.Sets.Count == 0 ? [] : logins.Sets[0])
            if (LoginPattern().IsMatch(row[0]!))
            {
                log("Dropping stale scratch login " + row[0]);
                await run("DROP LOGIN " + Bracket(row[0]!) + ";", "master");
            }
        // New Login's Extended Events sessions (CI only, VARIA_TEST_SQL_XE=1), by the age in their names.
        var sessions = await run("SELECT s.name FROM sys.server_event_sessions AS s WHERE s.name LIKE N'VariaScratch[_]%';", "master");
        foreach (var row in sessions.Status == "completed" && sessions.Sets.Count > 0 ? sessions.Sets[0] : [])
            if (StaleXeSession(row[0]!, DateTime.UtcNow.AddHours(-6)))
            {
                log("Dropping stale scratch event session " + row[0]);
                await run(DropXeSql(row[0]!), "master");
            }
    }

    /// <summary>Backups older than 6 hours of scratch databases that no longer exist, with each one's device, the folder a Linux
    /// backup file of the checks would be in, and the version (which delete procedure the server has).</summary>
    internal const string StaleBackupsSql = "SELECT DISTINCT s.database_name, f.physical_device_name, " + Backup.FolderSql + ", CONVERT(int, SERVERPROPERTY('ProductMajorVersion')) "
        + "FROM msdb.dbo.backupset AS s JOIN msdb.dbo.backupmediafamily AS f ON f.media_set_id = s.media_set_id "
        + "WHERE s.database_name LIKE N'VariaScratch[_]%' AND s.backup_finish_date < DATEADD(hour, -6, GETDATE()) AND DB_ID(s.database_name) IS NULL;";

    private static string HistorySql(string database) => "EXEC msdb.dbo.sp_delete_database_backuphistory @database_name = " + Quote(database) + ";";

    /// <summary>The null device SQL Server on Windows backs up to without writing a file.</summary>
    internal const string NullDevice = "NUL";

    /// <summary>Where a scratch database's backups go. SQL Server on Windows writes them to the null device, so no file is left.
    /// SQL Server on Linux cannot: it sizes the target first, and /dev/null fails (error 3634 in 'DiskChangeFileSize'). There
    /// they go to one file named after the scratch database in the instance's default backup folder (its data folder on 2017,
    /// which has no backup folder property and uses the data folder by default), which <see cref="ForgetAsync"/> deletes and
    /// the stale sweep finds again through msdb's history.</summary>
    internal sealed record Backup(string Database, string Device, int Major)
    {
        internal const string FolderSql = "COALESCE(CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultBackupPath')), CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultDataPath')))";

        /// <summary>The platform, folder and version; sys.dm_os_host_info (2017+) is read through sp_executesql, so the batch also compiles on 2016.</summary>
        internal const string FactsSql = "DECLARE @platform nvarchar(256) = N'Windows';\n"
            + "IF OBJECT_ID(N'sys.dm_os_host_info') IS NOT NULL EXEC sys.sp_executesql N'SELECT @platform = host_platform FROM sys.dm_os_host_info;', N'@platform nvarchar(256) OUTPUT', @platform = @platform OUTPUT;\n"
            + "SELECT @platform, " + FolderSql + ", CONVERT(int, SERVERPROPERTY('ProductMajorVersion'));";

        public bool IsFile => Device != NullDevice;

        /// <summary>A scratch database's backup file in a Linux folder.</summary>
        internal static string FileIn(string folder, string database) => folder.TrimEnd('/') + "/" + database + ".bak";

        /// <summary>One of Restore Database's source backups (<see cref="RestoreSource"/>): &lt;folder&gt;&lt;database&gt;_&lt;part&gt;, the part a few
        /// lower-case letters or digits then .bak or .trn, joined with the folder's own separator.</summary>
        internal static string PartIn(string folder, string database, string part)
        {
            if (!Pattern().IsMatch(database) || database.Contains('.', StringComparison.Ordinal) || database.Contains(']', StringComparison.Ordinal) || !PartPattern().IsMatch(part))
                throw new InvalidOperationException("Scratch setup failed: only a scratch database's backup gets a file name.");
            var linux = folder.StartsWith('/');
            if (!linux && !(folder.Length >= 3 && folder[1] == ':' && folder[2] == '\\') && !folder.StartsWith(@"\\", StringComparison.Ordinal))
                throw new InvalidOperationException("Scratch setup failed: the server reported no absolute backup folder.");
            var separator = linux ? '/' : '\\';
            return folder.TrimEnd(separator) + separator + database + "_" + part;
        }

        /// <summary>Whether the stale sweep may delete a device a scratch database's history names: the one file <see cref="For"/> names
        /// on Linux, or one <see cref="PartIn"/> names in the backup folder on either platform; nothing else, whatever the history says.</summary>
        internal static bool Stale(string device, string folder, string database)
        {
            if (device == FileIn(folder, database)) return true;
            var name = device[(device.LastIndexOfAny(['/', '\\']) + 1)..];
            if (!name.StartsWith(database + "_", StringComparison.Ordinal)) return false;
            try { return device == PartIn(folder, database, name[(database.Length + 1)..]); }
            catch (InvalidOperationException) { return false; }
        }

        /// <summary>The target on a server of this platform, folder and version. Only a sweepable scratch name of letters, digits
        /// and underscores names a file.</summary>
        internal static Backup For(string database, string? platform, string? folder, int major)
        {
            if (platform != "Linux") return new(database, NullDevice, major);
            if (!Pattern().IsMatch(database) || database.Contains('.', StringComparison.Ordinal) || database.Contains(']', StringComparison.Ordinal))
                throw new InvalidOperationException("Scratch setup failed: only a scratch database's backup gets a file name.");
            if (folder is not ['/', ..]) throw new InvalidOperationException("Scratch setup failed: SQL Server on Linux reported no default backup folder.");
            return new(database, FileIn(folder, database), major);
        }

        public static async Task<Backup> ForAsync(Func<string, string, Task<SqlRun>> run, string database)
        {
            var facts = await run(FactsSql, "master");
            if (facts.Status != "completed" || facts.Sets.Count == 0 || facts.Sets[0].Count == 0) throw new InvalidOperationException("Scratch setup failed: " + facts.Error);
            var row = facts.Sets[0][0];
            return For(database, row[0], row[1], int.Parse(row[2]!, CultureInfo.InvariantCulture));
        }

        /// <summary>BACKUP DATABASE to the target.</summary>
        public string DatabaseSql(string? with = null) => "BACKUP DATABASE " + Bracket(Database) + " TO DISK = " + Quote(Device) + (with is null ? "" : " WITH " + with) + ";";

        /// <summary>BACKUP LOG to the target; in a file it appends to the full backup's media set.</summary>
        public string LogSql(string with) => "BACKUP LOG " + Bracket(Database) + " TO DISK = " + Quote(Device) + " WITH " + with + ";";

        /// <summary>Deletes a backup file (sysadmin): xp_delete_files from SQL Server 2019, before it xp_delete_file's backup
        /// type, which deletes only a backup file.</summary>
        internal static string DeleteSql(string file, int major) => major >= 15
            ? "EXEC master.sys.xp_delete_files " + Quote(file) + ";"
            : "EXEC master.sys.xp_delete_file 0, " + Quote(file) + ";";

        /// <summary>Deletes the file, best effort (a failure is a value), and only once it went (or there was none) the database's
        /// backup history, so a file left behind is still in msdb for the stale sweep to try again.</summary>
        public async Task ForgetAsync(Func<string, string, Task<SqlRun>> run)
        {
            if (!IsFile || (await run(DeleteSql(Device, Major), "master")).Status == "completed") await run(HistorySql(Database), "msdb");
        }
    }

    private static string Quote(string value) => "N'" + value.Replace("'", "''") + "'";
    private static string Bracket(string value) => "[" + value.Replace("]", "]]") + "]";

    private static Task<SqlRun> Drop(Func<string, string, Task<SqlRun>> run, string name, bool online) => run(
        (online ? "" : "IF EXISTS (SELECT 1 FROM sys.databases WHERE name = " + Quote(name) + " AND state = 6) ALTER DATABASE " + Bracket(name) + " SET ONLINE;\n")
        + "IF EXISTS (SELECT 1 FROM sys.databases WHERE name = " + Quote(name) + " AND source_database_id IS NULL AND state = 0) ALTER DATABASE " + Bracket(name) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n"
        + "IF DB_ID(" + Quote(name) + ") IS NOT NULL DROP DATABASE " + Bracket(name) + ";", "master");

    /// <summary>A scratch name with none of the Object Explorer fixture, for checks that need only a database of their own.</summary>
    public static ScratchDatabase Bare(Func<string, string, Task<SqlRun>> run) =>
        new(run, DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture) + "_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant());

    public static async Task<ScratchDatabase> CreateAsync(Func<string, string, Task<SqlRun>> run, string fixtures)
    {
        var suffix = DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture) + "_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant();
        var scratch = new ScratchDatabase(run, suffix);
        try { await scratch.SetUpAsync(fixtures); }
        catch
        {
            await scratch.DisposeAsync();
            throw;
        }
        return scratch;
    }

    private async Task SetUpAsync(string fixtures)
    {
        var facts = await Exec("SELECT CONVERT(int, SERVERPROPERTY('ProductMajorVersion')), CONVERT(int, SERVERPROPERTY('IsIntegratedSecurityOnly')), CONVERT(int, FULLTEXTSERVICEPROPERTY('IsFulltextInstalled'));");
        var fact = facts.Sets[0][0];
        Major = int.Parse(fact[0]!, CultureInfo.InvariantCulture);
        var sqlLogins = fact[1] == "0";
        FullText = fact[2] == "1";
        const string marker = "EXEC sys.sp_addextendedproperty @name = N'varia.scratch', @value = 1;";
        foreach (var name in new[] { Name, ReadOnly, Offline, SingleUser })
        {
            created.Add(name);
            await Exec("CREATE DATABASE " + Bracket(name) + (name == Name ? " COLLATE Latin1_General_100_CS_AS_SC" : "") + ";\nALTER DATABASE " + Bracket(name) + " SET RECOVERY SIMPLE;");
            await Exec(marker, name);
        }
        var text = File.ReadAllText(Path.Combine(fixtures, "explorer-2016.sql"));
        await Exec(text.Replace("{{password}}", Password.Replace("'", "''")), Name);
        foreach (var (version, file) in new[] { (14, "explorer-2017.sql"), (15, "explorer-2019.sql"), (16, "explorer-2022.sql"), (17, "explorer-2025.sql") })
            if (Major >= version) await Exec(File.ReadAllText(Path.Combine(fixtures, file)), Name);
        if (sqlLogins)
        {
            Login = Name;
            await Exec("CREATE LOGIN " + Bracket(Login) + " WITH PASSWORD = " + Quote(Password) + ", CHECK_POLICY = OFF, DEFAULT_DATABASE = [master];");
            loginCreated = true;
            await Exec("CREATE USER " + Bracket(Login) + " FOR LOGIN " + Bracket(Login) + ";\nGRANT SELECT ON SCHEMA::[bulk] TO " + Bracket(Login) + ";", Name);
        }
        await Exec("ALTER DATABASE " + Bracket(ReadOnly) + " SET READ_ONLY WITH ROLLBACK IMMEDIATE;\nALTER DATABASE " + Bracket(Offline) + " SET OFFLINE WITH ROLLBACK IMMEDIATE;\n"
            + "ALTER DATABASE " + Bracket(SingleUser) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE;");
        // Snapshots need an edition that has them; the file goes to the instance's default data path.
        HasSnapshot = await CreateSnapshotAsync(Name, Snapshot);
        if (HasSnapshot) created.Insert(0, Snapshot);
        else Console.WriteLine("Database snapshot checks skipped: this server could not create a snapshot.");
    }

    /// <summary>A snapshot of a database, its file in the instance's default data path; false when the server cannot create one.</summary>
    private async Task<bool> CreateSnapshotAsync(string source, string snapshot)
    {
        var result = await run("DECLARE @path nvarchar(4000) = CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultDataPath'));\n"
            + "DECLARE @logical sysname = (SELECT name FROM sys.master_files WHERE database_id = DB_ID(" + Quote(source) + ") AND type = 0);\n"
            + "DECLARE @sql nvarchar(max) = N'CREATE DATABASE ' + QUOTENAME(" + Quote(snapshot) + ") + N' ON (NAME = ' + QUOTENAME(@logical) + N', FILENAME = ' "
            + "+ QUOTENAME(@path + " + Quote(snapshot + ".ss") + ", '''') + N') AS SNAPSHOT OF ' + QUOTENAME(" + Quote(source) + ") + N';';\nEXEC (@sql);", "master");
        return result.Status == "completed";
    }

    /// <summary>For a bare scratch name: the marked database to revert (<see cref="Reverted"/>) and its snapshot, which disposal
    /// drops first; false when this server cannot create a snapshot.</summary>
    public async Task<bool> CreateRevertAsync()
    {
        await CreateMarkedAsync(Reverted);
        if (!await CreateSnapshotAsync(Reverted, RevertSnapshot)) return false;
        created.Insert(0, RevertSnapshot);
        return true;
    }

    /// <summary>For a bare scratch name, Object Explorer's live status checks: the database itself (online and open), and
    /// read-only, offline, single-user and restoring ones, each marked before its state is set. RESTORING comes from a full
    /// and a tail-log backup WITH NORECOVERY (<see cref="RestoringSql"/>): to the null device on Windows, to one file on Linux,
    /// which disposal deletes.</summary>
    public async Task CreateStatesAsync()
    {
        foreach (var name in new[] { Name, ReadOnly, Offline, SingleUser, Restoring }) await CreateMarkedAsync(name);
        await Exec("ALTER DATABASE " + Bracket(ReadOnly) + " SET READ_ONLY WITH ROLLBACK IMMEDIATE;\nALTER DATABASE " + Bracket(Offline) + " SET OFFLINE WITH ROLLBACK IMMEDIATE;\n"
            + "ALTER DATABASE " + Bracket(SingleUser) + " SET SINGLE_USER WITH ROLLBACK IMMEDIATE;");
        // Known before the backups run, so disposal deletes a file even when the tail-log backup fails.
        restoringBackup = await Backup.ForAsync(run, Restoring);
        await Exec(RestoringSql(restoringBackup));
    }

    /// <summary>Leaves a database RESTORING: full recovery, a full backup, and a tail-log backup WITH NORECOVERY to the same target.</summary>
    internal static string RestoringSql(Backup backup) =>
        "ALTER DATABASE " + Bracket(backup.Database) + " SET RECOVERY FULL;\n" + backup.DatabaseSql() + "\n" + backup.LogSql("NORECOVERY");

    /// <summary>Creates the empty, marked round-trip database with the scratch database's collation.</summary>
    public Task<string> CreateRoundTripAsync() => CreateMarkedAsync(RoundTrip);

    /// <summary>Creates the empty, marked injection-matrix database with the scratch database's collation.</summary>
    public Task<string> CreateInjectionAsync() => CreateMarkedAsync(Injection);

    /// <summary>Creates the empty, marked Database Properties database.</summary>
    public Task<string> CreatePropertiesAsync() => CreateMarkedAsync(Properties);

    /// <summary>Creates the empty, marked live tables database.</summary>
    public Task<string> CreateLiveAsync() => CreateMarkedAsync(Live);

    /// <summary>Creates the empty, marked server file picker database.</summary>
    public Task<string> CreateFilesAsync() => CreateMarkedAsync(Files);
    /// <summary>Creates the empty, marked seam database and the one whose name its rename collides with.</summary>
    public async Task<string> CreateSeamAsync()
    {
        await CreateMarkedAsync(SeamTaken);
        return await CreateMarkedAsync(Seam);
    }

    /// <summary>Creates the empty, marked action progress database.</summary>
    public Task<string> CreateProgressAsync() => CreateMarkedAsync(Progress);

    /// <summary>Creates the marked <see cref="Attach"/> database with a primary data file and a second data file in
    /// <paramref name="dataFolder"/> and its log in <paramref name="logFolder"/> (each ending with the server's separator), named
    /// after it; returns the three paths. Dispose attaches them again if they are left detached, so dropping deletes them.</summary>
    public async Task<string[]> CreateAttachAsync(string dataFolder, string logFolder)
    {
        string[] files = [dataFolder + Attach + ".mdf", dataFolder + Attach + "_2.ndf", logFolder + Attach + "_log.ldf"];
        created.Add(Attach);
        created.Add(AttachAs);
        created.Add(AttachMissing);
        attachFiles = files;
        await Exec("CREATE DATABASE " + Bracket(Attach) + " ON PRIMARY (NAME = " + Quote(Attach) + ", FILENAME = " + Quote(files[0]) + "), (NAME = " + Quote(Attach + "_2") + ", FILENAME = " + Quote(files[1])
            + ") LOG ON (NAME = " + Quote(Attach + "_log") + ", FILENAME = " + Quote(files[2]) + ");\nALTER DATABASE " + Bracket(Attach) + " SET RECOVERY SIMPLE;");
        await Exec("EXEC sys.sp_addextendedproperty @name = N'varia.scratch', @value = 1;", Attach);
        return files;
    }

    /// <summary>The attach checks' own SQL for <see cref="Attach"/>'s files: detach the database of <paramref name="name"/>.</summary>
    public Task<SqlRun> DetachAsync(string name) => Exec("EXEC master.dbo.sp_detach_db @dbname = " + Quote(name) + ", @skipchecks = 'true';");

    /// <summary>The files <see cref="Attach"/> has now (a rebuilt log has a name of SQL Server's choosing), which Dispose attaches.</summary>
    public void AttachFilesAre(string[] files) => attachFiles = files;

    /// <summary>Creates the empty, marked database the Take Offline and Bring Online checks change the state of.</summary>
    public Task<string> CreateDatabaseStateAsync() => CreateMarkedAsync(DatabaseState);

    /// <summary>Creates the empty, marked database the rename checks rename; disposal also drops it under its new name.</summary>
    public Task<string> CreateRenameAsync()
    {
        created.Add(Renamed);
        return CreateMarkedAsync(Rename);
    }

    /// <summary>Creates the marked database whose name the rename compensation check takes.</summary>
    public Task<string> CreateRenameTakenAsync() => CreateMarkedAsync(RenameTaken);

    /// <summary>Creates the empty, marked table designer database.</summary>
    public Task<string> CreateDesignerAsync() => CreateMarkedAsync(Designer);

    /// <summary>Creates the empty, marked fake SSIS catalog database with the real catalog's collation.</summary>
    public Task<string> CreateSsisAsync(string collation) => CreateMarkedAsync(Ssis, collation);

    /// <summary>Restores the Integration Services catalog backup at a server-side path as <see cref="SsisReference"/>, with its
    /// files in the instance's default folders, and marks it. Only its schema is read: it gets no master key, CLR or jobs, and
    /// nothing treats a database of this name as the catalog.</summary>
    public async Task<string> RestoreSsisReferenceAsync(string backup)
    {
        var paths = (await Exec("SELECT CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultDataPath')), CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultLogPath'));")).Sets[0][0];
        var files = await Exec("RESTORE FILELISTONLY FROM DISK = " + Quote(backup) + ";");
        var moves = files.Sets[0].Select((file, index) => "MOVE " + Quote(file[0]!) + " TO "
            + Quote((file[2] == "L" ? paths[1] : paths[0]) + SsisReference + "_" + index.ToString(CultureInfo.InvariantCulture) + (file[2] == "L" ? ".ldf" : ".mdf")));
        created.Add(SsisReference);
        await Exec("RESTORE DATABASE " + Bracket(SsisReference) + " FROM DISK = " + Quote(backup) + " WITH RECOVERY, " + string.Join(", ", moves) + ";\n"
            + "ALTER DATABASE " + Bracket(SsisReference) + " SET RECOVERY SIMPLE;");
        await Exec("EXEC sys.sp_addextendedproperty @name = N'varia.scratch', @value = 1;", SsisReference);
        return SsisReference;
    }

    /// <summary>Creates the empty, marked second table designer database, case- and accent-insensitive.</summary>
    public Task<string> CreateDesignerOddAsync() => CreateMarkedAsync(DesignerOdd, "Latin1_General_100_CI_AI");

    /// <summary>For a bare scratch name: the low-privilege login (named like the database, so the sweep finds it), when the
    /// server accepts SQL logins; false when it accepts Windows logins only.</summary>
    public async Task<bool> CreateLoginAsync()
    {
        if ((await Exec("SELECT CONVERT(int, SERVERPROPERTY('IsIntegratedSecurityOnly'));")).Scalar != "0") return false;
        Login = Name;
        await Exec("CREATE LOGIN " + Bracket(Login) + " WITH PASSWORD = " + Quote(Password) + ", CHECK_POLICY = OFF, DEFAULT_DATABASE = [master];");
        loginCreated = true;
        return true;
    }

    /// <summary>Creates the marked database the Detach checks detach (<see cref="Detached"/>).</summary>
    public Task<string> CreateDetachedAsync() => CreateMarkedAsync(Detached);

    /// <summary>A snapshot of <see cref="Detached"/> (<see cref="DetachedSnapshot"/>), dropped before it; false when this server cannot create one.</summary>
    public async Task<bool> CreateDetachedSnapshotAsync()
    {
        if (!await CreateSnapshotAsync(Detached, DetachedSnapshot)) return false;
        created.Insert(0, DetachedSnapshot);
        return true;
    }

    /// <summary>The statement that attaches a detached database again from its files (FOR ATTACH).</summary>
    public static string AttachSql(string name, IEnumerable<string> files) =>
        "CREATE DATABASE " + Bracket(name) + " ON " + string.Join(", ", files.Select(file => "(FILENAME = " + Quote(file) + ")")) + " FOR ATTACH;";

    /// <summary>A database was detached: until <see cref="Attached"/>, disposal attaches it from these files before it drops it, so
    /// its files are deleted with it.</summary>
    public void Detaching(string name, IEnumerable<string> files) => detachedFiles[name] = [.. files];
    public void Attached(string name) => detachedFiles.Remove(name);

    /// <summary>For a bare scratch name, Delete parity's offline database (D3d): marked, then taken offline; its files' physical
    /// names, which the check deletes (<see cref="DeleteFileSql"/>) once Delete has dropped it and left them.</summary>
    public async Task<List<string>> CreateDeleteOfflineAsync()
    {
        await CreateMarkedAsync(DeleteOffline);
        var files = await Exec("SELECT physical_name FROM sys.master_files WHERE database_id = DB_ID(" + Quote(DeleteOffline) + ") ORDER BY file_id;");
        await Exec("ALTER DATABASE " + Bracket(DeleteOffline) + " SET OFFLINE WITH ROLLBACK IMMEDIATE;");
        return [.. files.Sets[0].Select(row => row[0]!)];
    }

    /// <summary>Deletes a file the server left (sysadmin, SQL Server 2019 and later): an offline-dropped scratch database's, whose
    /// ACL Windows authentication leaves to the dropping login, so attaching it again fails. Only for paths this run created.</summary>
    public static string DeleteFileSql(string file) => "EXEC master.sys.xp_delete_files " + Quote(file) + ";";

    /// <summary>For a bare scratch name with its login (<see cref="CreateLoginAsync"/>), Delete parity's database that the login owns (D3d).</summary>
    public async Task<string> CreateDeleteOwnedAsync()
    {
        await CreateMarkedAsync(DeleteOwned);
        await Exec("ALTER AUTHORIZATION ON DATABASE::" + Bracket(DeleteOwned) + " TO " + Bracket(Login!) + ";");
        return DeleteOwned;
    }

    /// <summary>For a bare scratch name, Delete parity's compensation database (D3d) and a snapshot of it, which fails its DROP
    /// (3709) and which disposal drops first; false when this server cannot create a snapshot.</summary>
    public async Task<bool> CreateDeleteCompensatedAsync()
    {
        await CreateMarkedAsync(DeleteCompensated);
        if (!await CreateSnapshotAsync(DeleteCompensated, DeleteSnapshot)) return false;
        created.Insert(0, DeleteSnapshot);
        return true;
    }

    /// <summary>Creates the empty, marked object-action database; disposal also drops it under its renamed name.</summary>
    public Task<string> CreateActionsAsync()
    {
        created.Add(ActionsRenamed);
        return CreateMarkedAsync(Actions);
    }

    /// <summary>A second object-action database under <see cref="ActionsRenamed"/>, once <see cref="Actions"/> is gone
    /// (already in the dispose list).</summary>
    public async Task<string> CreateActionsRenamedAsync()
    {
        await CreateMarkedAsync(ActionsRenamed);
        created.Remove(ActionsRenamed);
        return ActionsRenamed;
    }

    private async Task<string> CreateMarkedAsync(string name, string collation = "Latin1_General_100_CS_AS_SC")
    {
        created.Add(name);
        await Exec("CREATE DATABASE " + Bracket(name) + " COLLATE " + collation + ";\nALTER DATABASE " + Bracket(name) + " SET RECOVERY SIMPLE;");
        await Exec("EXEC sys.sp_addextendedproperty @name = N'varia.scratch', @value = 1;", name);
        return name;
    }

    /// <summary>Creates the marked Restore Database source in FULL recovery and returns the folder its backups go to: the default
    /// backup folder (the data folder on 2017, which has none).</summary>
    public async Task<string> CreateRestoreSourceAsync()
    {
        await CreateMarkedAsync(RestoreSource);
        await Exec("ALTER DATABASE " + Bracket(RestoreSource) + " SET RECOVERY FULL;");
        var row = (await Exec(Backup.FactsSql)).Sets[0][0];
        restoreTarget = (row[1] ?? throw new InvalidOperationException("Scratch setup failed: the server reported no backup folder."), int.Parse(row[2]!, CultureInfo.InvariantCulture));
        return row[1]!;
    }

    /// <summary>Creates the marked forked source in FULL recovery (after <see cref="CreateRestoreSourceAsync"/>, whose folder it shares).</summary>
    public async Task<string> CreateRestoreForkAsync()
    {
        if (restoreTarget is null) throw new InvalidOperationException("Create the restore source first.");
        await CreateMarkedAsync(RestoreFork);
        await Exec("ALTER DATABASE " + Bracket(RestoreFork) + " SET RECOVERY FULL;");
        return RestoreFork;
    }

    /// <summary>Creates the marked Restore Files and Filegroups database in FULL recovery with a filegroup named <paramref name="group"/>
    /// holding one file named <paramref name="file"/> and a filegroup FG3 holding f3, both in the default data folder (dropped with the
    /// database), and returns the folder its backups go to.</summary>
    public async Task<string> CreateRestoreFilesAsync(string group, string file)
    {
        await CreateMarkedAsync(RestoreFiles);
        var b = Bracket(RestoreFiles);
        var row = (await Exec(Backup.FactsSql)).Sets[0][0];
        restoreTarget ??= (row[1] ?? throw new InvalidOperationException("Scratch setup failed: the server reported no backup folder."), int.Parse(row[2]!, CultureInfo.InvariantCulture));
        var data = (await Exec("SELECT CONVERT(nvarchar(4000), SERVERPROPERTY('InstanceDefaultDataPath'));")).Scalar ?? throw new InvalidOperationException("Scratch setup failed: the server reported no data folder.");
        var separator = data.StartsWith('/') ? "/" : "\\";
        var folder = data.TrimEnd(separator[0]) + separator;
        await Exec("ALTER DATABASE " + b + " SET RECOVERY FULL;\nALTER DATABASE " + b + " ADD FILEGROUP " + Bracket(group) + ";\nALTER DATABASE " + b + " ADD FILE (NAME = " + Quote(file)
            + ", FILENAME = " + Quote(folder + RestoreFiles + "_f2.ndf") + ") TO FILEGROUP " + Bracket(group) + ";\nALTER DATABASE " + b + " ADD FILEGROUP [FG3];\nALTER DATABASE " + b
            + " ADD FILE (NAME = N'f3', FILENAME = " + Quote(folder + RestoreFiles + "_f3.ndf") + ") TO FILEGROUP [FG3];");
        return restoreTarget.Value.Folder;
    }

    /// <summary>A file for one of <see cref="RestoreSource"/>'s backups, <see cref="RestoreFork"/>'s or <see cref="RestoreFiles"/>' (<see cref="Backup.PartIn"/>), which disposal deletes.</summary>
    public string RestoreFile(string part, string? database = null)
    {
        var (folder, _) = restoreTarget ?? throw new InvalidOperationException("Create the restore source first.");
        if (database is not null && database != RestoreSource && database != RestoreFork && database != RestoreFiles) throw new InvalidOperationException("Only the restore sources' backups get a file.");
        var file = Backup.PartIn(folder, database ?? RestoreSource, part);
        if (!restoreFiles.Contains(file)) restoreFiles.Add(file);
        return file;
    }

    /// <summary>A scratch database something else creates (the backend's Create Catalog dry run), dropped with the rest.</summary>
    public void Adopt(string name) { if (!created.Contains(name)) created.Add(name); }

    /// <summary>Stops and drops an Extended Events session by name, if it exists.</summary>
    internal static string DropXeSql(string name) =>
        "IF EXISTS (SELECT 1 FROM sys.dm_xe_sessions WHERE name = " + Quote(name) + ") ALTER EVENT SESSION " + Bracket(name) + " ON SERVER STATE = STOP;\n"
        + "IF EXISTS (SELECT 1 FROM sys.server_event_sessions WHERE name = " + Quote(name) + ") DROP EVENT SESSION " + Bracket(name) + " ON SERVER;";

    /// <summary>New Login's database for the Extended Events check's master key batch.</summary>
    public Task<string> CreateLoginsDatabaseAsync() => CreateMarkedAsync(LoginsDatabase);
    /// <summary>User Mapping's database, its offline one and its read-only one.</summary>
    public async Task<(string Online, string Offline, string ReadOnly)> CreateMappingDatabasesAsync()
    {
        await CreateMarkedAsync(MappingDatabase);
        await CreateMarkedAsync(MappingOffline);
        await CreateMarkedAsync(MappingReadOnly);
        await Exec("ALTER DATABASE " + Bracket(MappingOffline) + " SET OFFLINE WITH ROLLBACK IMMEDIATE;\nALTER DATABASE " + Bracket(MappingReadOnly) + " SET READ_ONLY WITH ROLLBACK IMMEDIATE;");
        return (MappingDatabase, MappingOffline, MappingReadOnly);
    }
    /// <summary>Records a login the checks are about to create (by <see cref="LoginNamed"/>), so disposal drops it.</summary>
    public string OwnLogin(string tag)
    {
        var name = LoginNamed(tag);
        if (!ownedLogins.Contains(name)) ownedLogins.Add(name);
        return name;
    }
    /// <summary>Records that the checks are about to create <see cref="XeSession"/>, so disposal stops and drops it.</summary>
    public string OwnXeSession() { ownsXeSession = true; return XeSession; }

    /// <summary>Drops the Extended Events session and the New Login checks' logins, then the snapshot first, brings the offline
    /// database online so its files are deleted, then drops the rest and the login.</summary>
    public async ValueTask DisposeAsync()
    {
        if (ownsXeSession) await run(DropXeSql(XeSession), "master");
        foreach (var login in ownedLogins) await run("IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = " + Quote(login) + ") DROP LOGIN " + Bracket(login) + ";", "master");
        // Attach's files left detached are attached again under their own name, so the drop below deletes them.
        if (attachFiles is { } files)
            await run("IF DB_ID(" + Quote(Attach) + ") IS NULL AND DB_ID(" + Quote(AttachAs) + ") IS NULL AND DB_ID(" + Quote(AttachMissing) + ") IS NULL CREATE DATABASE " + Bracket(Attach) + " ON "
                + string.Join(", ", files.Select(file => "(FILENAME = " + Quote(file) + ")")) + " FOR ATTACH;", "master");
        // A failed Detach check can leave _det detached: attached again, the DROP deletes its files.
        foreach (var (name, kept) in detachedFiles)
            if (kept.Count > 0) await run("IF DB_ID(" + Quote(name) + ") IS NULL " + AttachSql(name, kept), "master");
        // A failed state check can leave _dbs offline; SET ONLINE first lets the DROP delete its files.
        foreach (var name in created) await Drop(run, name, name != Offline && name != DatabaseState && name != DeleteOffline && name != MappingOffline);
        // The restoring database's backup file (Linux) goes, then its history.
        if (restoringBackup is not null) await restoringBackup.ForgetAsync(run);
        // Restore Database's source files go, then its history; a file left behind keeps the history for the stale sweep.
        if (restoreTarget is { } target)
        {
            var deleted = true;
            foreach (var file in restoreFiles) deleted &= (await run(Backup.DeleteSql(file, target.Major), "master")).Status == "completed";
            if (deleted)
            {
                await run(HistorySql(RestoreSource), "msdb");
                if (created.Contains(RestoreFork)) await run(HistorySql(RestoreFork), "msdb");
                if (created.Contains(RestoreFiles)) await run(HistorySql(RestoreFiles), "msdb");
            }
        }
        if (loginCreated) await run("DROP LOGIN " + Bracket(Login!) + ";", "master");
    }
}
