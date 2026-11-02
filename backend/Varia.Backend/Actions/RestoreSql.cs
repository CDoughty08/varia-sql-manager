using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>Restore Database's SQL: constant catalog reads of msdb's history and the server (D1e), the run's preflight (D1f), and
/// form 4 (spec D1 §3.2): RESTORE LABELONLY, HEADERONLY and FILELISTONLY, and the run's BACKUP LOG, RESTORE DATABASE and RESTORE LOG,
/// with every name, device, position, path and time a parameter, one constant text per shape (device and move counts, options),
/// which <see cref="LintMedia"/> checks for every shape up to the limits. <see cref="Script"/> renders a restore as SSMS's Script
/// writes it (SMO's text, probed); the run's statements are the same, with variables where Script has literals.</summary>
internal static partial class RestoreSql
{
    /// <summary>The databases msdb has backed up, by name (Learn: "only databases that have been backed up according to the msdb backup history").</summary>
    public const string HistoryDatabases = "SELECT TOP (@take) bs.database_name AS database_name FROM msdb.dbo.backupset AS bs WHERE bs.is_snapshot = 0 AND bs.database_name IS NOT NULL "
        + "GROUP BY bs.database_name ORDER BY bs.database_name;";

    /// <summary>One database's newest sets (SMO's columns, with the name a parameter), then the disk families of their media sets
    /// (mirror 0, in family order).</summary>
    public const string History = "SELECT TOP (@take) bs.backup_set_uuid AS set_uuid, bs.name AS name, bs.type AS type, bs.server_name AS server_name, bs.database_name AS database_name, "
        + "bs.position AS position, bs.first_lsn AS first_lsn, bs.last_lsn AS last_lsn, bs.checkpoint_lsn AS checkpoint_lsn, bs.database_backup_lsn AS database_backup_lsn, "
        + "bs.backup_start_date AS start_date, bs.backup_finish_date AS finish_date, bs.backup_size AS size_bytes, bs.user_name AS user_name, bs.expiration_date AS expiration_date, "
        + "bs.is_copy_only AS is_copy_only, bs.is_damaged AS is_damaged, bs.recovery_model AS recovery_model, bs.first_recovery_fork_guid AS first_fork, bs.last_recovery_fork_guid AS last_fork, "
        + "bs.media_set_id AS media_set_id, ms.media_family_count AS family_count, bs.fork_point_lsn AS fork_point_lsn, bs.family_guid AS family_guid "
        + "FROM msdb.dbo.backupset AS bs JOIN msdb.dbo.backupmediaset AS ms ON ms.media_set_id = bs.media_set_id "
        + "WHERE bs.database_name = @db AND bs.is_snapshot = 0 ORDER BY bs.backup_set_id DESC;\n"
        + "SELECT mf.media_set_id AS media_set_id, mf.family_sequence_number AS family, mf.physical_device_name AS device, mf.device_type AS device_type "
        + "FROM msdb.dbo.backupmediafamily AS mf WHERE mf.mirror = 0 AND mf.media_set_id IN (SELECT TOP (@take) bs.media_set_id FROM msdb.dbo.backupset AS bs "
        + "WHERE bs.database_name = @db AND bs.is_snapshot = 0 ORDER BY bs.backup_set_id DESC) ORDER BY mf.media_set_id, mf.family_sequence_number;";

    /// <summary>A history set's files (msdb's record of FILELISTONLY), by the set's uuid.</summary>
    public const string HistoryFiles = "SELECT TOP (@take) bf.logical_name AS logical_name, bf.physical_name AS physical_name, bf.file_type AS file_type, bf.filegroup_name AS filegroup_name, "
        + "bf.file_size AS file_size, bf.file_number AS file_id FROM msdb.dbo.backupfile AS bf JOIN msdb.dbo.backupset AS bs ON bs.backup_set_id = bf.backup_set_id "
        + "WHERE bs.backup_set_uuid = @set ORDER BY bf.file_number;";

    /// <summary>The default folders, whether the login may restore (Learn: CREATE ANY DATABASE, or sysadmin and dbcreator), and whether it sees sessions.
    /// SQL Server 2016 and 2017 have no InstanceDefaultBackupPath (2019 added it), so their backup folder is the data folder.</summary>
    public const string Facts = "SELECT CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultDataPath')) AS data_path, CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultLogPath')) AS log_path, "
        + "COALESCE(CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultBackupPath')), CONVERT(nvarchar(260), SERVERPROPERTY('InstanceDefaultDataPath'))) AS backup_path, "
        + "CONVERT(bit, CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, N'CREATE ANY DATABASE') = 1 OR IS_SRVROLEMEMBER(N'dbcreator') = 1 OR IS_SRVROLEMEMBER(N'sysadmin') = 1 THEN 1 ELSE 0 END) AS can_restore;";

    /// <summary>The databases a restore can overwrite (Learn: all but master and tempdb; snapshots cannot be restored over), with
    /// their sessions where VIEW SERVER STATE shows them, and their backup family (a database of the same name from elsewhere is another).</summary>
    public const string Destinations = "SELECT TOP (@take) d.name AS name, d.database_id AS database_id, d.create_date AS create_date, d.state_desc AS state_desc, "
        + "d.recovery_model_desc AS recovery_model, CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE') = 1 "
        + "THEN (SELECT COUNT(*) FROM sys.dm_exec_sessions AS s WHERE s.database_id = d.database_id) END AS sessions, CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE') = 1 "
        + "THEN (SELECT COUNT(*) FROM sys.dm_exec_sessions AS s WHERE s.database_id = d.database_id AND s.open_transaction_count > 0) END AS with_transaction, rs.family_guid AS family_guid "
        + "FROM sys.databases AS d LEFT JOIN sys.database_recovery_status AS rs ON rs.database_id = d.database_id WHERE d.database_id > 2 AND d.source_database_id IS NULL ORDER BY d.name;";

    /// <summary>The run's preflight (D1f), in master on the action's own connection: the destination's row (identity, state, access,
    /// recovery model, whether it is a snapshot, and its backup family), every database id there is now (a cleanup drops only a
    /// database whose id is not among them, critic A11a), whether the login may create a database, whether it is in sysadmin, and
    /// whether the server has sys.dm_os_file_exists (SQL Server 2017 on), which tells the preflight and the cleanup whether a file exists.</summary>
    public const string Preflight = "SELECT d.database_id AS database_id, d.create_date AS create_date, d.state AS state, d.user_access AS user_access, d.recovery_model AS recovery_model, "
        + "CONVERT(bit, CASE WHEN d.source_database_id IS NULL THEN 0 ELSE 1 END) AS is_snapshot, rs.family_guid AS family_guid "
        + "FROM sys.databases AS d LEFT JOIN sys.database_recovery_status AS rs ON rs.database_id = d.database_id WHERE d.name = @db;\n"
        + "SELECT TOP (@take) d.database_id AS database_id FROM sys.databases AS d ORDER BY d.database_id;\n"
        + "SELECT CONVERT(bit, CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, N'CREATE ANY DATABASE') = 1 OR IS_SRVROLEMEMBER(N'dbcreator') = 1 OR IS_SRVROLEMEMBER(N'sysadmin') = 1 THEN 1 ELSE 0 END) AS can_restore, "
        + "CONVERT(bit, ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0)) AS sysadmin, (SELECT COUNT(*) FROM sys.system_objects AS o WHERE o.name = N'dm_os_file_exists') AS file_views;";

    /// <summary>Which of the paths in @paths (a JSON array) exist as files, by their index in it (SQL Server 2017 on).</summary>
    public const string FilesExist = "SELECT TOP (@take) CONVERT(int, j.[key]) AS item FROM OPENJSON(@paths) AS j CROSS APPLY sys.dm_os_file_exists(j.[value]) AS x "
        + "WHERE x.file_exists = 1 ORDER BY CONVERT(int, j.[key]);";

    /// <summary>A database's files, by id: the cleanup reads them before it drops a partly restored database, whose files SQL Server
    /// may leave on disk after a cancelled RESTORE (probed on 2025), to say which are still there.</summary>
    public const string FilesOf = "SELECT TOP (@take) f.physical_name AS physical_name FROM sys.master_files AS f WHERE f.database_id = @id ORDER BY f.file_id;";

    /// <summary>The database a name has now: its id, state and access. The cleanup reads it before it drops a partly restored database,
    /// and the run reads it last to report how the restore left the database (critic A12). A name is unique, so @take is 1.</summary>
    public const string Restored = "SELECT TOP (@take) d.database_id AS database_id, d.state AS state, d.user_access AS user_access FROM sys.databases AS d WHERE d.name = @db ORDER BY d.database_id;";

    /// <summary>Every database's files, so a Restore As path another database holds is a problem before OK.</summary>
    public const string ServerFiles = "SELECT TOP (@take) d.name AS database_name, f.physical_name AS physical_name FROM sys.master_files AS f JOIN sys.databases AS d ON d.database_id = f.database_id "
        + "ORDER BY d.name, f.file_id;";

    private static string Devices(int count) => string.Join(", ", Enumerable.Range(1, count).Select(index => "DISK = @d" + index.ToString(CultureInfo.InvariantCulture)));
    /// <summary>One device's media label (MediaSetId, FamilyCount, FamilySequenceNumber).</summary>
    public const string Label = "RESTORE LABELONLY FROM DISK = @d1 WITH NOUNLOAD;";
    /// <summary>Every backup set on a media set of <paramref name="count"/> families.</summary>
    public static string Header(int count) => "RESTORE HEADERONLY FROM " + Devices(count) + " WITH NOUNLOAD;";
    /// <summary>The files of the set at @file on a media set of <paramref name="count"/> families.</summary>
    public static string FileList(int count) => "RESTORE FILELISTONLY FROM " + Devices(count) + " WITH FILE = @file, NOUNLOAD;";

    /// <summary>The run's tail-log backup (SMO's option order): the destination's log to @tail under the name @tail_name, leaving the
    /// database RESTORING with <paramref name="noRecovery"/>.</summary>
    public static string TailLog(RestoreCatalogJson restore, bool noRecovery) =>
        "BACKUP LOG @db TO DISK = @tail WITH NOFORMAT, NOINIT, NAME = @tail_name, NOSKIP, NOREWIND, NOUNLOAD, " + (noRecovery ? "NORECOVERY, " : "") + Stats(restore) + ";";

    /// <summary>One set's RESTORE, as <see cref="Lines"/> writes it (SMO's keyword order) with variables: @d1… for its devices, @file
    /// its position, @l1/@p1… its moves, @standby and @stopat. <paramref name="recovery"/> is the state this statement leaves: SMO
    /// writes nothing for RECOVERY, the default.</summary>
    public static string Restore(RestoreCatalogJson restore, bool log, int devices, int moves, bool restrictedUser, bool keepReplication, string recovery, bool replace, bool stopAt)
    {
        var with = new List<string>();
        if (restrictedUser) with.Add("RESTRICTED_USER");
        with.Add("FILE = @file");
        for (var index = 1; index <= moves; index++)
        {
            var number = index.ToString(CultureInfo.InvariantCulture);
            with.Add("MOVE @l" + number + " TO @p" + number);
        }
        if (keepReplication) with.Add("KEEP_REPLICATION");
        if (recovery == "norecovery") with.Add("NORECOVERY");
        else if (recovery == "standby") with.Add("STANDBY = @standby");
        with.Add("NOUNLOAD");
        if (replace) with.Add("REPLACE");
        with.Add(Stats(restore));
        if (stopAt) with.Add("STOPAT = @stopat");
        return "RESTORE " + (log ? "LOG" : "DATABASE") + " @db FROM " + Devices(devices) + " WITH " + string.Join(", ", with) + ";";
    }

    /// <summary>The compensation for a tail-log backup taken WITH NORECOVERY when no RESTORE started (critic A11d): it brings the
    /// database back online as it was.</summary>
    public const string Recover = "RESTORE DATABASE @db WITH RECOVERY;";

    // --- Lint -----------------------------------------------------------------------------------------------------------

    private static readonly HashSet<string> Literals =
    [
        "'InstanceDefaultDataPath'", "'InstanceDefaultLogPath'", "'InstanceDefaultBackupPath'", "N'CREATE ANY DATABASE'", "N'dbcreator'", "N'sysadmin'", "N'VIEW SERVER STATE'", "N'dm_os_file_exists'"
    ];
    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    [GeneratedRegex(@"@\w+")]
    private static partial Regex Variable();

    /// <summary>Problems with one catalog read: a metadata function, a literal beyond the allowlist, a variable other than its
    /// parameters, dynamic SQL, a write, and a listing that is not TOP (@take) with ORDER BY.</summary>
    public static List<string> LintCatalog(string text)
    {
        var problems = new List<string>();
        foreach (var builtin in CatalogSql.Builtins) if (text.Contains(builtin, StringComparison.OrdinalIgnoreCase)) problems.Add("uses " + builtin);
        problems.AddRange(CatalogSql.SecretUses(text));
        if (text.Contains("OBJECT_ID(", StringComparison.OrdinalIgnoreCase) || text.Contains("DB_NAME(", StringComparison.OrdinalIgnoreCase) || text.Contains("DB_ID(", StringComparison.OrdinalIgnoreCase))
            problems.Add("uses a metadata function");
        // Words inside the allowed literals (N'CREATE ANY DATABASE') are not statements.
        var bare = LiteralPattern().Replace(text, "''");
        if (Regex.IsMatch(bare, @"\bEXEC(UTE)?\b|sp_executesql", RegexOptions.IgnoreCase)) problems.Add("runs a procedure or dynamic SQL");
        foreach (var write in new[] { "INSERT", "UPDATE", "DELETE", "MERGE", "DROP", "ALTER", "CREATE", "RESTORE", "BACKUP", "TRUNCATE" })
            if (Regex.IsMatch(bare, @"\b" + write + @"\b", RegexOptions.IgnoreCase)) problems.Add("writes with " + write);
        if (bare.Contains('#', StringComparison.Ordinal)) problems.Add("uses a temporary table");
        if (bare.Contains("--", StringComparison.Ordinal) || bare.Contains("/*", StringComparison.Ordinal)) problems.Add("has a comment");
        foreach (Match literal in LiteralPattern().Matches(text)) if (!Literals.Contains(literal.Value)) problems.Add("has the literal " + literal.Value);
        foreach (Match used in Variable().Matches(text)) if (used.Value is not ("@take" or "@db" or "@set" or "@paths" or "@id")) problems.Add("uses " + used.Value);
        var tops = Regex.Matches(text, @"SELECT TOP \(").Count;
        if (tops != Regex.Matches(text, @"SELECT TOP \(@take\) ").Count) problems.Add("takes other than @take");
        if (tops > 0 && Regex.Matches(text, @" ORDER BY ").Count < tops) problems.Add("has a TOP without ORDER BY");
        if (tops == 0 && text.Contains("FROM ", StringComparison.Ordinal) && !text.Contains("SERVERPROPERTY", StringComparison.Ordinal)) problems.Add("is a listing without TOP (@take)");
        return problems;
    }

    /// <summary>The words a form 4 statement may hold (spec D1 §3.2), besides its parameters, commas, = and the final semicolon.</summary>
    private static readonly HashSet<string> MediaWords = new(
    [
        "RESTORE", "BACKUP", "DATABASE", "LOG", "LABELONLY", "HEADERONLY", "FILELISTONLY", "VERIFYONLY", "FROM", "TO", "DISK", "WITH", "FILE", "MOVE", "RECOVERY", "NORECOVERY",
        "STANDBY", "REPLACE", "KEEP_REPLICATION", "RESTRICTED_USER", "NOUNLOAD", "NOFORMAT", "NOINIT", "NOSKIP", "NOREWIND", "NAME", "STATS", "5", "STOPAT", "CHECKSUM",
        "COPY_ONLY", "COMPRESSION", "NO_COMPRESSION", "DIFFERENTIAL", "FILEGROUP"
    ], StringComparer.Ordinal);
    [GeneratedRegex(@"^@(?:db|file|standby|stopat|tail|tail_name|d(?:[1-9]|[1-5][0-9]|6[0-4])|[lp](?:[1-9][0-9]{0,2}|1000)|[fg](?:[1-9][0-9]?|1[0-9]{2}|2[0-4][0-9]|25[0-6]))$")]
    private static partial Regex MediaParameter();
    [GeneratedRegex(@"@\w+|[A-Za-z_0-9]+|[,=;]|\S")]
    private static partial Regex MediaToken();

    /// <summary>Problems with one form 4 statement: anything but the allowed keywords, parameters of the fixed set, commas and =,
    /// so no literal, EXEC, comment or second statement can be written; REPLACE only when the variant allows it.</summary>
    public static List<string> LintMedia(string text, bool replace = false)
    {
        var problems = new List<string>();
        problems.AddRange(CatalogSql.SecretUses(text));
        if (!text.EndsWith(';') || text.IndexOf(';', StringComparison.Ordinal) != text.Length - 1) problems.Add("is not one statement ending with its only semicolon");
        if (!text.StartsWith("RESTORE ", StringComparison.Ordinal) && !text.StartsWith("BACKUP LOG ", StringComparison.Ordinal)) problems.Add("is not a RESTORE or BACKUP LOG");
        foreach (Match token in MediaToken().Matches(text))
        {
            var value = token.Value;
            if (value.StartsWith('@')) { if (!MediaParameter().IsMatch(value)) problems.Add("uses " + value); }
            else if (value is "," or "=" or ";") continue;
            else if (!MediaWords.Contains(value)) problems.Add("has " + value);
            else if (value == "REPLACE" && !replace) problems.Add("replaces where its variant may not");
        }
        return problems;
    }

    /// <summary>Every catalog read and every media read up to the device limit, with its lint problems.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> Lint(RestoreCatalogJson restore)
    {
        yield return ("restore history databases", LintCatalog(HistoryDatabases));
        yield return ("restore history", LintCatalog(History));
        yield return ("restore history files", LintCatalog(HistoryFiles));
        yield return ("restore facts", LintCatalog(Facts));
        yield return ("restore destinations", LintCatalog(Destinations));
        yield return ("restore server files", LintCatalog(ServerFiles));
        yield return ("restore preflight", LintCatalog(Preflight));
        yield return ("restore restored", LintCatalog(Restored));
        yield return ("restore files exist", LintCatalog(FilesExist));
        yield return ("restore files of", LintCatalog(FilesOf));
        yield return ("restore label", LintMedia(Label));
        yield return ("restore recover", LintMedia(Recover));
        foreach (var noRecovery in new[] { false, true }) yield return ("restore tail log " + noRecovery, LintMedia(TailLog(restore, noRecovery)));
        // Every shape a run can send: the device and move counts at their edges and limits, with every option; REPLACE only where asked.
        var moveLimit = (int)restore.Limit("restoreMoves");
        foreach (var devices in new[] { 1, 2, (int)restore.Limit("backupDevices") })
            foreach (var moves in new[] { 0, 1, 2, moveLimit })
                foreach (var log in new[] { false, true })
                    foreach (var recovery in restore.RecoveryStates)
                        for (var flags = 0; flags < 16; flags++)
                        {
                            bool restricted = (flags & 1) != 0, keep = (flags & 2) != 0, replace = (flags & 4) != 0, stopAt = (flags & 8) != 0;
                            yield return ("restore " + (log ? "log" : "database") + " " + devices + "/" + moves + "/" + recovery + "/" + flags,
                                LintMedia(Restore(restore, log, devices, moves, restricted, keep, recovery, replace, stopAt), replace));
                        }
        for (var count = 1; count <= restore.Limit("backupDevices"); count++)
        {
            yield return ("restore header " + count, LintMedia(Header(count)));
            yield return ("restore file list " + count, LintMedia(FileList(count)));
        }
    }

    // --- Script ---------------------------------------------------------------------------------------------------------

    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Stats(RestoreCatalogJson restore) => "STATS = " + restore.Limit("stats").ToString(CultureInfo.InvariantCulture);

    /// <summary>The tail-log backup's name: its file's name without the extension (SSMS names both &lt;db&gt;_LogBackup_&lt;stamp&gt;).</summary>
    public static string TailName(string file)
    {
        var name = file[(Math.Max(file.LastIndexOf('\\'), file.LastIndexOf('/')) + 1)..];
        var dot = name.LastIndexOf('.');
        return dot > 0 ? name[..dot] : name;
    }

    /// <summary>The statements of a restore as SMO's RestorePlan.Script() writes them (probed on SQL Server 2025): SET SINGLE_USER
    /// first with Close existing connections on a database that exists (the shared template, critic A12), the tail-log BACKUP LOG,
    /// one RESTORE per set (RESTRICTED_USER and the MOVEs on each, REPLACE on the first, KEEP_REPLICATION, the recovery state and
    /// STOPAT on the last), and SET MULTI_USER last after a RESTORE WITH RECOVERY that did not ask for restricted access.</summary>
    public static List<string> Statements(RestoreCatalogJson restore, string database, RestoreOptionsDto options, bool exists) => [.. Lines(restore, database, options, exists)];

    /// <summary><see cref="Statements"/> one at a time, so <see cref="Script"/> can stop at its limit before writing the rest.</summary>
    private static IEnumerable<string> Lines(RestoreCatalogJson restore, string database, RestoreOptionsDto options, bool exists)
    {
        var close = options.CloseConnections && exists;
        if (close) yield return ActionSql.Statement(new PlannedStatement(ActionTemplate.SetSingleUser, "master", [database]));
        if (options.TailLog is { } tail)
            yield return ("BACKUP LOG " + ScriptFormatter.Quote(database) + " TO  DISK = " + Literal(tail.File) + " WITH NOFORMAT, NOINIT,  NAME = " + Literal(TailName(tail.File))
                + ", NOSKIP, NOREWIND, NOUNLOAD, " + (tail.NoRecovery ? " NORECOVERY , " : "") + " " + Stats(restore));
        for (var index = 0; index < options.Sets.Count; index++)
        {
            var set = options.Sets[index];
            var last = index == options.Sets.Count - 1;
            var with = new List<string>();
            if (options.RestrictedUser) with.Add("RESTRICTED_USER");
            with.Add("FILE = " + set.File.ToString(CultureInfo.InvariantCulture));
            foreach (var move in options.Relocate) with.Add("MOVE " + Literal(move.Logical) + " TO " + Literal(move.Physical));
            if (last && options.KeepReplication) with.Add("KEEP_REPLICATION");
            if (!last || options.Recovery == "norecovery") with.Add("NORECOVERY");
            else if (options.Recovery == "standby") with.Add("STANDBY = " + Literal(options.StandbyFile!));
            with.Add("NOUNLOAD");
            if (index == 0 && options.Replace) with.Add("REPLACE");
            with.Add(Stats(restore));
            if (last && options.StopAt is { } stopAt) with.Add("STOPAT = " + Literal(stopAt));
            yield return "RESTORE " + (set.Type == "log" ? "LOG " : "DATABASE ") + ScriptFormatter.Quote(database) + " FROM  " + string.Join(",  ", set.Devices.Select(device => "DISK = " + Literal(device)))
                + " WITH  " + string.Join(",  ", with);
        }
        if (close && options.Recovery == "recovery" && !options.RestrictedUser) yield return ActionSql.Statement(new PlannedStatement(ActionTemplate.SetMultiUser, "master", [database]));
    }

    /// <summary>SSMS's script: USE [master], the statements one per line, then GO (recalled); null once it would pass
    /// <paramref name="limit"/> characters, checked after each statement, so at most one statement (bounded by the request's
    /// moves and devices) is written past it.</summary>
    public static string? Script(RestoreCatalogJson restore, string database, RestoreOptionsDto options, bool exists, long limit)
    {
        var text = new StringBuilder();
        text.Append(ScriptFormatter.Use("master")).Append(ScriptFormatter.NewLine);
        foreach (var statement in Lines(restore, database, options, exists))
        {
            text.Append(statement).Append(ScriptFormatter.NewLine);
            if (text.Length > limit) return null;
        }
        text.Append(ScriptFormatter.NewLine).Append("GO").Append(ScriptFormatter.NewLine);
        return text.Length > limit ? null : text.ToString();
    }
}
