using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>Database Properties' describe (spec PR-B §4.1): one read in master (the database's sys.databases row with
/// every option, its files, the server's logins and collations, and its backup history when msdb is readable), then, when
/// the database is online and accessible, one read inside it (filegroups, space used, users, scoped configurations and
/// memory-optimized memory). Constant text per band; names reach SQL Server only as parameters.</summary>
internal static class DatabaseProperties
{
    /// <summary>The option columns of sys.databases, aliased as the catalogue's keys (states and descriptions converted in
    /// <see cref="Token"/>). Ledger and incremental statistics columns are gated by band.</summary>
    private static string OptionColumns(SqlRender render) =>
        "d.collation_name AS collation, d.recovery_model_desc AS recoveryModel, d.compatibility_level AS compatibilityLevel, d.containment_desc AS containmentType, "
        + "d.is_auto_close_on AS autoClose, d.is_auto_create_stats_incremental_on AS autoCreateIncrementalStatistics, d.is_auto_create_stats_on AS autoCreateStatistics, "
        + "d.is_auto_shrink_on AS autoShrink, d.is_auto_update_stats_on AS autoUpdateStatistics, d.is_auto_update_stats_async_on AS autoUpdateStatisticsAsync, "
        + "d.default_fulltext_language_lcid AS defaultFulltextLanguageLcid, d.default_language_name AS defaultLanguage, d.is_nested_triggers_on AS nestedTriggersEnabled, "
        + "d.is_transform_noise_words_on AS transformNoiseWords, d.two_digit_year_cutoff AS twoDigitYearCutoff, d.is_cursor_close_on_commit_on AS closeCursorOnCommit, "
        + "d.is_local_cursor_default AS defaultCursor, fo.directory_name AS filestreamDirectoryName, fo.non_transacted_access_desc AS filestreamNonTransactedAccess, "
        + render.Col(16, "d.is_ledger_on", "CONVERT(bit, NULL)") + " AS isLedgerDatabase, d.snapshot_isolation_state AS allowSnapshotIsolation, d.is_ansi_null_default_on AS ansiNullDefault, "
        + "d.is_ansi_nulls_on AS ansiNulls, d.is_ansi_padding_on AS ansiPadding, d.is_ansi_warnings_on AS ansiWarnings, d.is_arithabort_on AS arithmeticAbort, "
        + "d.is_concat_null_yields_null_on AS concatNullYieldsNull, d.is_db_chaining_on AS dbChaining, d.is_date_correlation_on AS dateCorrelationOptimization, "
        + "d.delayed_durability_desc AS delayedDurability, d.is_read_committed_snapshot_on AS readCommittedSnapshot, d.is_numeric_roundabort_on AS numericRoundAbort, "
        + "d.is_parameterization_forced AS parameterization, d.is_quoted_identifier_on AS quotedIdentifiers, d.is_recursive_triggers_on AS recursiveTriggers, "
        + "d.is_trustworthy_on AS trustworthy, CONVERT(bit, 1) AS varDecimalStorageFormat, d.page_verify_option_desc AS pageVerify, "
        + "d.target_recovery_time_in_seconds AS targetRecoveryTime, d.is_broker_enabled AS brokerEnabled, d.is_honor_broker_priority_on AS honorBrokerPriority, "
        + "d.service_broker_guid AS serviceBrokerIdentifier, d.is_read_only AS readOnly, d.state_desc AS databaseState, d.is_encrypted AS encryptionEnabled, d.user_access_desc AS restrictAccess";

    /// <summary>Statement 1, in master: the database's row; its files (at most @files + 1); the logins the Owner field
    /// suggests; the server's collations; and the last full and log backups, unknown (known = 0) when msdb cannot be read.</summary>
    public static string Master(int band)
    {
        var render = new SqlRender(band);
        return "SELECT d.database_id AS database_id, d.name AS name, d.state AS state, d.state_desc AS state_desc, d.is_in_standby AS is_in_standby, d.create_date AS create_date, "
            + "CONVERT(bit, CASE WHEN d.source_database_id IS NULL THEN 0 ELSE 1 END) AS is_snapshot, COALESCE(sp.name, SUSER_SNAME(d.owner_sid)) AS owner_name, "
            + "CONVERT(bit, ISNULL(CASE WHEN d.user_access = 1 THEN 1 ELSE HAS_DBACCESS(d.name) END, 0)) AS has_access, "
            + "CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(d.name, N'DATABASE', N'ALTER'), 1)) AS can_alter, "
            + "CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE') = 1 THEN (SELECT COUNT(*) FROM sys.dm_exec_sessions AS es WHERE es.database_id = d.database_id) END AS sessions, "
            + "(SELECT SUM(CONVERT(bigint, mf.size)) FROM sys.master_files AS mf WHERE mf.database_id = d.database_id AND mf.type IN (0, 1)) AS size_pages, "
            + "CONVERT(int, ISNULL(SERVERPROPERTY('FilestreamEffectiveLevel'), 0)) AS filestream_level, CONVERT(bit, ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0)) AS sysadmin, "
            + "CONVERT(int, SERVERPROPERTY('EngineEdition')) AS engine_edition, CONVERT(int, SERVERPROPERTY('ProductMajorVersion')) AS major, "
            + "CONVERT(bit, ISNULL((SELECT CONVERT(int, c.value_in_use) FROM sys.configurations AS c WHERE c.name = N'contained database authentication'), 0)) AS contained_authentication, "
            + OptionColumns(render) + " "
            + "FROM sys.databases AS d LEFT JOIN sys.server_principals AS sp ON sp.sid = d.owner_sid LEFT JOIN sys.database_filestream_options AS fo ON fo.database_id = d.database_id "
            + "WHERE d.name = @name;\n"
            + "SELECT TOP (@files) mf.file_id AS file_id, mf.name AS name, mf.type AS type, mf.data_space_id AS data_space_id, mf.size AS size, mf.max_size AS max_size, mf.growth AS growth, "
            + "mf.is_percent_growth AS is_percent_growth, mf.physical_name AS physical_name FROM sys.master_files AS mf JOIN sys.databases AS d ON d.database_id = mf.database_id "
            + "WHERE d.name = @name AND mf.type IN (0, 1, 2) ORDER BY mf.file_id;\n"
            + "SELECT TOP (@logins) p.name AS name FROM sys.server_principals AS p WHERE p.type IN ('S', 'U', 'G', 'E', 'X') AND p.name NOT LIKE N'##%' ORDER BY p.name;\n"
            + "SELECT TOP (@collations) c.name AS name FROM sys.fn_helpcollations() AS c ORDER BY c.name;\n"
            + "BEGIN TRY SELECT MAX(CASE WHEN b.type = 'D' THEN b.backup_finish_date END) AS last_backup, MAX(CASE WHEN b.type = 'L' THEN b.backup_finish_date END) AS last_log_backup, "
            + "CONVERT(bit, 1) AS known FROM msdb.dbo.backupset AS b WHERE b.database_name = @name; END TRY\n"
            + "BEGIN CATCH SELECT CONVERT(datetime, NULL) AS last_backup, CONVERT(datetime, NULL) AS last_log_backup, CONVERT(bit, 0) AS known; END CATCH;";
    }

    /// <summary>Statement 2, inside the database (only when it is online and accessible): its filegroups (at most @take,
    /// the limit + 1) with file counts, its data and log pages and pages used, its users, the four scoped configurations
    /// (band 13 and later), and memory-optimized memory, unknown without VIEW DATABASE STATE.</summary>
    public static string Inside(int band)
    {
        var render = new SqlRender(band);
        var text = "SELECT TOP (@take) fg.data_space_id AS data_space_id, fg.name AS name, fg.type AS type, fg.is_read_only AS is_read_only, fg.is_default AS is_default, "
            + render.Col(13, "fg.is_autogrow_all_files", "CONVERT(bit, NULL)") + " AS autogrow_all_files, "
            + "(SELECT COUNT(*) FROM sys.database_files AS f WHERE f.data_space_id = fg.data_space_id) AS files FROM sys.filegroups AS fg ORDER BY fg.data_space_id;\n"
            + "SELECT SUM(CONVERT(bigint, f.size)) AS pages, SUM(CONVERT(bigint, FILEPROPERTY(f.name, N'SpaceUsed'))) AS used FROM sys.database_files AS f WHERE f.type IN (0, 1);\n"
            + "SELECT COUNT(*) AS users FROM sys.database_principals AS p WHERE p.type IN ('S', 'U', 'G', 'E', 'X', 'C', 'K');\n";
        if (band >= 13)
            text += "SELECT c.name AS name, CONVERT(nvarchar(64), c.value) AS value, CONVERT(nvarchar(64), c.value_for_secondary) AS value_for_secondary FROM sys.database_scoped_configurations AS c "
                + "WHERE c.name IN (N'MAXDOP', N'LEGACY_CARDINALITY_ESTIMATION', N'PARAMETER_SNIFFING', N'QUERY_OPTIMIZER_HOTFIXES');\n";
        return text + "BEGIN TRY SELECT SUM(CONVERT(bigint, m.memory_allocated_for_table_kb + m.memory_allocated_for_indexes_kb)) AS allocated_kb, "
            + "SUM(CONVERT(bigint, m.memory_used_by_table_kb + m.memory_used_by_indexes_kb)) AS used_kb, CONVERT(bit, 1) AS known FROM sys.dm_db_xtp_table_memory_stats AS m; END TRY\n"
            + "BEGIN CATCH SELECT CONVERT(bigint, NULL) AS allocated_kb, CONVERT(bigint, NULL) AS used_kb, CONVERT(bit, 0) AS known; END CATCH;";
    }

    /// <summary>Runs statement 2 in the database, which reaches T-SQL only through QUOTENAME.</summary>
    public const string InsideCall = "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt, N'@take int', @take = @take;";

    /// <summary>The configuration names statement 2 reads, by the catalogue's keys (primary, then secondary).</summary>
    public static IReadOnlyDictionary<string, (string Name, bool Secondary)> ScopedNames(ActionsCatalog catalog) =>
        catalog.ScopedConfigurations.Values.ToDictionary(def => def.Key, def => (def.Sql!.Name!, def.Sql.Secondary == true), StringComparer.Ordinal);

    /// <summary>An option's token from its sys.databases value: True/False for bits, sys.databases' descriptions for
    /// choices (which are the catalogue's tokens), and the few columns SSMS shows otherwise.</summary>
    public static string? Token(string key, object? value)
    {
        if (value is null) return null;
        return key switch
        {
            "defaultCursor" => Convert.ToBoolean(value, CultureInfo.InvariantCulture) ? "LOCAL" : "GLOBAL",
            "parameterization" => Convert.ToBoolean(value, CultureInfo.InvariantCulture) ? "FORCED" : "SIMPLE",
            // 1 on, 3 in transition to on (SSMS shows the state it is heading for).
            "allowSnapshotIsolation" => Convert.ToInt32(value, CultureInfo.InvariantCulture) is 1 or 3 ? "true" : "false",
            "databaseState" or "recoveryModel" or "containmentType" or "delayedDurability" or "pageVerify" or "restrictAccess" or "filestreamNonTransactedAccess" or "defaultLanguage"
                or "filestreamDirectoryName" or "collation" => Convert.ToString(value, CultureInfo.InvariantCulture),
            "compatibilityLevel" or "targetRecoveryTime" or "defaultFulltextLanguageLcid" or "twoDigitYearCutoff" => Convert.ToString(Convert.ToInt64(value, CultureInfo.InvariantCulture), CultureInfo.InvariantCulture),
            "serviceBrokerIdentifier" => value is Guid guid ? guid.ToString("D").ToUpperInvariant() : Convert.ToString(value, CultureInfo.InvariantCulture),
            _ => value is bool flag ? (flag ? "true" : "false") : Convert.ToBoolean(value, CultureInfo.InvariantCulture) ? "true" : "false"
        };
    }

    /// <summary>A scoped configuration's token: MAXDOP's number, ON or OFF for the others, PRIMARY for a secondary that follows the primary.</summary>
    public static string ScopedToken(string name, string? value, bool secondary)
    {
        if (value is null) return secondary ? "PRIMARY" : "OFF";
        if (name == "MAXDOP") return value;
        return value == "1" ? "ON" : value == "0" ? "OFF" : value.ToUpperInvariant();
    }

    private static void Add(SqlCommand command, string name, SqlDbType type, int size, object? value)
    {
        var parameter = size == 0 ? new SqlParameter(name, type) : new SqlParameter(name, type, size);
        parameter.Value = value ?? DBNull.Value;
        command.Parameters.Add(parameter);
    }

    private static ScriptPreflight.Row ReadRow(SqlDataReader reader)
    {
        var values = new Dictionary<string, object?>(reader.FieldCount, StringComparer.Ordinal);
        for (var i = 0; i < reader.FieldCount; i++) values[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
        return new ScriptPreflight.Row(values);
    }

    internal static string Iso(object? value) => value is DateTime date ? date.ToString("yyyy-MM-ddTHH:mm:ss.fff", CultureInfo.InvariantCulture) : "";
    private static double Mb(long pages) => Math.Round(pages * 8 / 1024.0, 2);

    /// <summary>Splits physical_name at its last separator: the folder (with no trailing separator) and the file.</summary>
    public static (string Path, string File) SplitPath(string physical)
    {
        var at = physical.LastIndexOfAny(['\\', '/']);
        return at < 0 ? ("", physical) : (physical[..at], physical[(at + 1)..]);
    }

    /// <summary>A file's Autogrowth / Maxsize: growth in pages or percent (0 = none), max_size in pages (-1 = unlimited).</summary>
    public static GrowthDto Growth(int growth, bool percent, int maxSize)
    {
        if (growth == 0) return new(false);
        long? max = maxSize < 0 ? null : (long)maxSize * 8 / 1024;
        return percent ? new(true, "percent", growth, max) : new(true, "mb", (long)growth * 8 / 1024, max);
    }

    private static string Type(object? type) => Convert.ToInt32(type, CultureInfo.InvariantCulture) switch { 1 => "log", 2 => "filestream", _ => "rows" };
    private static string FilegroupType(string? type) => type switch { "FD" => "filestream", "FX" => "memoryOptimized", _ => "rows" };

    /// <summary>Reads what the dialog shows. NOT_FOUND when the database is gone; a database that cannot change opens
    /// read-only with its reason, as does Azure SQL Managed Instance (its write path is a follow-up).</summary>
    public static async Task<(DatabasePropertiesDto? Model, string? Missing)> DescribeAsync(SqlConnection connection, ActionsCatalog catalog, string database, int band, CancellationToken token)
    {
        int Limit(string key) => (int)catalog.Limit(key);
        ScriptPreflight.Row? row = null;
        var files = new List<ScriptPreflight.Row>();
        var logins = new List<string>();
        var collations = new List<string>();
        ScriptPreflight.Row? backups = null;
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = Master(band);
            command.CommandTimeout = 0;
            Add(command, "@name", SqlDbType.NVarChar, 128, database);
            Add(command, "@files", SqlDbType.Int, 0, Limit("files") + 1);
            Add(command, "@logins", SqlDbType.Int, 0, Limit("logins"));
            Add(command, "@collations", SqlDbType.Int, 0, Limit("collations"));
            await using var reader = await command.ExecuteReaderAsync(token);
            if (await reader.ReadAsync(token)) row = ReadRow(reader);
            if (row is null) return (null, "The database " + ScriptingErrors.Display(database) + " no longer exists. Refresh Object Explorer.");
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token)) files.Add(ReadRow(reader));
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token)) logins.Add(reader.GetString(0));
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token)) collations.Add(reader.GetString(0));
            if (await reader.NextResultAsync(token) && await reader.ReadAsync(token)) backups = ReadRow(reader);
        }
        var online = row.Int("state") == 0 && row.Bool("has_access");
        var filegroups = new List<ScriptPreflight.Row>();
        ScriptPreflight.Row? space = null, memory = null;
        int? users = null;
        var scoped = new Dictionary<string, string>(StringComparer.Ordinal);
        if (online)
        {
            await using var command = connection.CreateCommand();
            command.CommandText = InsideCall;
            command.CommandTimeout = 0;
            Add(command, "@db", SqlDbType.NVarChar, 128, database);
            Add(command, "@stmt", SqlDbType.NVarChar, -1, Inside(band));
            Add(command, "@take", SqlDbType.Int, 0, Limit("filegroups") + 1);
            try
            {
                await using var reader = await command.ExecuteReaderAsync(token);
                while (await reader.ReadAsync(token)) filegroups.Add(ReadRow(reader));
                await reader.NextResultAsync(token);
                if (await reader.ReadAsync(token)) space = ReadRow(reader);
                await reader.NextResultAsync(token);
                if (await reader.ReadAsync(token)) users = reader.GetInt32(0);
                if (band >= 13)
                {
                    await reader.NextResultAsync(token);
                    var names = ScopedNames(catalog);
                    var values = new Dictionary<string, (string? Value, string? Secondary)>(StringComparer.OrdinalIgnoreCase);
                    while (await reader.ReadAsync(token)) values[reader.GetString(0)] = (reader.IsDBNull(1) ? null : reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2));
                    foreach (var (key, (name, secondary)) in names)
                        if (values.TryGetValue(name, out var found)) scoped[key] = ScopedToken(name, secondary ? found.Secondary : found.Value, secondary);
                }
                if (await reader.NextResultAsync(token) && await reader.ReadAsync(token)) memory = ReadRow(reader);
            }
            // Inside EXEC [db].sys.sp_executesql, a missing procedure can only be the wrapper's: the database went away.
            catch (SqlException error) when (error.Number is 2812 or 911 && !token.IsCancellationRequested)
            {
                return (null, "The database " + ScriptingErrors.Display(database) + " no longer exists. Refresh Object Explorer.");
            }
        }
        var options = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var key in catalog.DatabaseOptions.Keys)
            if (row.Has(key) && Token(key, RawValue(row, key)) is { } value) options[key] = value;
        var dataSpaces = filegroups.ToDictionary(item => item.Int("data_space_id"), item => item.Name("name"));
        var listed = files.Take(Limit("files")).Select(file =>
        {
            var (path, name) = SplitPath(file.Name("physical_name"));
            var type = Type(RawValue(file, "type"));
            return new DatabaseFileDto(file.Name("name"), type, type == "log" ? null : dataSpaces.GetValueOrDefault(file.Int("data_space_id")), Mb(file.Long("size") ?? 0),
                Growth(file.Int("growth"), file.Bool("is_percent_growth"), file.Int("max_size")), path, name, file.Int("file_id") == 1);
        }).ToList();
        var groups = filegroups.Take(Limit("filegroups")).Select(group => new DatabaseFilegroupDto(group.Name("name"), FilegroupType(group.Text("type")), group.Int("files"),
            group.Bool("is_read_only"), group.Bool("is_default"), group.NullableBool("autogrow_all_files"))).ToList();
        var engine = row.Int("engine_edition");
        var primary = listed.FirstOrDefault(file => file.IsPrimary)?.Path ?? "";
        var server = new DatabaseServerFactsDto(band, row.Bool("sysadmin"), row.Int("filestream_level"), primary.StartsWith('/') ? "/" : "\\", engine, row.Bool("contained_authentication"));
        var levels = catalog.CompatibilityLevels.Where(level => level <= Math.Min(row.Int("major") * 10, catalog.CompatibilityLevels.Max())).ToList();
        string? lastBackup = null, lastLog = null;
        if (backups is not null && backups.Bool("known"))
        {
            lastBackup = RawValue(backups, "last_backup") is { } full ? Iso(full) : "None";
            lastLog = RawValue(backups, "last_log_backup") is { } log ? Iso(log) : "None";
        }
        long? pages = space?.Long("pages"), used = space?.Long("used");
        var known = memory is not null && memory.Bool("known");
        var general = new DatabaseGeneralDto(row.Name("name"), row.Text("state_desc") ?? "", row.Bool("is_in_standby"), row.Name("owner_name") is { Length: > 0 } owner ? owner : null,
            Iso(RawValue(row, "create_date")), Mb(row.Long("size_pages") ?? 0), pages is { } total && used is { } inUse ? Mb(total - inUse) : null, users, lastBackup, lastLog,
            row.Text("collation"), known ? Math.Round((memory!.Long("allocated_kb") ?? 0) / 1024.0, 2) : null, known ? Math.Round((memory!.Long("used_kb") ?? 0) / 1024.0, 2) : null,
            row.Int("database_id"));
        int? sessions = row.Long("sessions") is { } count ? (int)count : null;
        return (new DatabasePropertiesDto(general, options, scoped, levels, collations, logins, listed, files.Count > Limit("files"), groups, filegroups.Count > Limit("filegroups"), server,
            sessions, ReadOnlyReason(row, database)), null);
    }

    private static object? RawValue(ScriptPreflight.Row row, string key) => row.Raw(key);

    /// <summary>Why the dialog opens read-only, or null. The order says the most fundamental reason first.</summary>
    public static string? ReadOnlyReason(ScriptPreflight.Row row, string database)
    {
        if (row.Int("engine_edition") == 8) return "Database Properties on Azure SQL Managed Instance is not supported yet.";
        if (row.Bool("is_snapshot")) return "A database snapshot is read-only.";
        if (row.Int("state") != 0) return "The database is " + (row.Text("state_desc") ?? "unavailable").Replace('_', ' ').ToLowerInvariant() + ".";
        if (!row.Bool("has_access")) return "The database is not accessible to this login.";
        if (!row.Bool("can_alter")) return "You do not have permission to change " + ScriptingErrors.Display(database) + " (ALTER on it).";
        return null;
    }
}
