using System.Data;
using System.Data.SqlTypes;
using System.Globalization;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>Restore Database's describe (actions.describe 'restoreDatabase', D1e) on the object actions' connection under its own
/// gate (ActionServiceOptions.RestorePerConnection, outside the read gates) and the catalogue's mediaReadMs: msdb's history (the databases it backed up; one database's sets and their media), the
/// headers of backup files (LABELONLY per device, then HEADERONLY per media set), one set's files (msdb's backupfile, or
/// FILELISTONLY), and the server's facts. Constant SQL (RestoreSql) with every name, path and position a parameter. Nothing here
/// logs a name, path or count.</summary>
internal static partial class RestoreDescribe
{
    public static async Task<(RestoreModelDto? Model, ActionError? Error)> DescribeAsync(SqlConnection connection, ActionsCatalog catalog, RestoreSourceDto source, bool linux, CancellationToken token)
    {
        var restore = catalog.Restore;
        try
        {
            switch (source.Kind)
            {
                case "history":
                {
                    var server = await ServerAsync(connection, restore, linux, token);
                    var take = (int)restore.Limit("historyDatabases");
                    var names = new List<string>();
                    await using (var command = Command(connection, RestoreSql.HistoryDatabases))
                    {
                        Add(command, "@take", SqlDbType.Int, 0, take + 1);
                        await using var reader = await command.ExecuteReaderAsync(token);
                        while (await reader.ReadAsync(token)) names.Add(reader.GetString(0));
                    }
                    var truncated = names.Count > take;
                    if (truncated) names.RemoveRange(take, names.Count - take);
                    if (source.Database is null) return (new(server, names, truncated), null);
                    var (sets, setsTruncated) = await HistoryAsync(connection, restore, source.Database, token);
                    return (new(server, names, truncated, sets, setsTruncated), null);
                }
                case "devices":
                {
                    var server = await ServerAsync(connection, restore, linux, token);
                    var (sets, truncated) = await MediaAsync(connection, restore, source.Devices!, token);
                    return (new(server, Sets: sets, SetsTruncated: truncated), null);
                }
                case "historyFiles":
                {
                    var take = (int)restore.Limit("restoreMoves");
                    var files = new List<BackupFileDto>();
                    await using var command = Command(connection, RestoreSql.HistoryFiles);
                    Add(command, "@take", SqlDbType.Int, 0, take + 1);
                    command.Parameters.Add(new SqlParameter("@set", SqlDbType.UniqueIdentifier) { Value = Guid.Parse(source.SetId!) });
                    await using var reader = await command.ExecuteReaderAsync(token);
                    while (await reader.ReadAsync(token))
                        files.Add(new(reader.GetString(0), Text(reader, 1), FileType(Text(reader, 2)), reader.IsDBNull(4) ? 0 : Long(reader.GetValue(4)), reader.IsDBNull(5) ? 0 : Convert.ToInt32(reader.GetValue(5), CultureInfo.InvariantCulture),
                            reader.IsDBNull(3) ? null : reader.GetString(3)));
                    return (new(Files: Clip(files, take), FilesTruncated: files.Count > take), null);
                }
                case "mediaFiles":
                {
                    var take = (int)restore.Limit("restoreMoves");
                    var files = new List<BackupFileDto>();
                    await using var command = Command(connection, RestoreSql.FileList(source.Devices!.Count));
                    AddDevices(command, source.Devices);
                    Add(command, "@file", SqlDbType.Int, 0, source.File!.Value);
                    await using var reader = await command.ExecuteReaderAsync(token);
                    int Column(string name) => reader.GetOrdinal(name);
                    var (logical, physical, type, group, size, id) = (Column("LogicalName"), Column("PhysicalName"), Column("Type"), Column("FileGroupName"), Column("Size"), Column("FileId"));
                    while (await reader.ReadAsync(token))
                        files.Add(new(reader.GetString(logical), Text(reader, physical), FileType(Text(reader, type)), reader.IsDBNull(size) ? 0 : Long(reader.GetValue(size)),
                            reader.IsDBNull(id) ? 0 : Convert.ToInt32(reader.GetValue(id), CultureInfo.InvariantCulture), reader.IsDBNull(group) ? null : reader.GetString(group)));
                    return (new(Files: Clip(files, take), FilesTruncated: files.Count > take), null);
                }
                default:
                    throw new InvalidOperationException("Unknown restore source " + source.Kind);
            }
        }
        catch (SqlException error) when (!token.IsCancellationRequested && MediaError(catalog, error, connection) is { } media) { return (null, media); }
    }

    /// <summary>Operating system errors that say the file or its path is not there: file, path, network path or name not found, a bad name.</summary>
    private static readonly HashSet<int> Missing = [2, 3, 53, 67, 123, 161];
    [GeneratedRegex(@"(\d+)\s?\(")]
    private static partial Regex OsError();

    /// <summary>A failure reading backup media as a value: a device SQL Server cannot open (3201) is PATH_NOT_FOUND when its operating
    /// system error says the file or path is not there, and FILE_ACCESS otherwise (access denied, a file another program holds);
    /// FromSql makes the rest a value (media a restore cannot use is MEDIA, by its numbers), or null for a lost connection or a lock.</summary>
    internal static ActionError? MediaError(ActionsCatalog catalog, SqlException error, SqlConnection? connection)
    {
        var errors = error.Errors.Cast<SqlError>().ToList();
        var text = string.Join(" ", errors.Where(item => item.Class > 10).Select(item => item.Message).Distinct());
        if (errors.FirstOrDefault(item => item.Number == 3201) is { } open)
        {
            // The operating system error is the last number before a parenthesis: "Operating system error 5(Access is denied.)."
            // The device's own name comes earlier in the message, so a "(" in it does not count.
            var os = OsError().Matches(open.Message).LastOrDefault() is { } match && int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var number) ? number : -1;
            return ActionErrors.Create(catalog, Missing.Contains(os) ? "PATH_NOT_FOUND" : "FILE_ACCESS", text);
        }
        return ActionErrors.CodeOf(error, connection) is "CONNECTION_LOST" or "BLOCKED" ? null : ActionErrors.FromSql(catalog, error, connection, ddl: false, inUseAdvice: null);
    }

    private static List<T> Clip<T>(List<T> items, int take) => items.Count > take ? items[..take] : items;

    private static SqlCommand Command(SqlConnection connection, string sql)
    {
        var command = connection.CreateCommand();
        command.CommandText = sql;
        command.CommandTimeout = 0;
        return command;
    }

    private static void Add(SqlCommand command, string name, SqlDbType type, int size, object? value)
    {
        var parameter = size == 0 ? new SqlParameter(name, type) : new SqlParameter(name, type, size);
        parameter.Value = value ?? DBNull.Value;
        command.Parameters.Add(parameter);
    }

    private static void AddDevices(SqlCommand command, IReadOnlyList<string> devices)
    {
        for (var index = 0; index < devices.Count; index++) Add(command, "@d" + (index + 1).ToString(CultureInfo.InvariantCulture), SqlDbType.NVarChar, 260, devices[index]);
    }

    private static string Text(SqlDataReader reader, int ordinal) => reader.IsDBNull(ordinal) ? "" : Convert.ToString(reader.GetValue(ordinal), CultureInfo.InvariantCulture) ?? "";
    private static long Long(object value) => value switch
    {
        decimal number => number > long.MaxValue ? long.MaxValue : (long)number,
        _ => Convert.ToInt64(value, CultureInfo.InvariantCulture)
    };
    private static string Time(object value) => value is DateTime time ? time.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture) : "";
    /// <summary>A numeric(25, 0) LSN as decimal text ('0' when absent).</summary>
    private static string Lsn(SqlDataReader reader, int ordinal)
    {
        if (reader.IsDBNull(ordinal)) return "0";
        var value = reader.GetProviderSpecificValue(ordinal);
        return value is SqlDecimal number ? number.ToString() : Convert.ToString(reader.GetValue(ordinal), CultureInfo.InvariantCulture) ?? "0";
    }
    private static string? ForkId(SqlDataReader reader, int ordinal) => reader.IsDBNull(ordinal) ? null : reader.GetGuid(ordinal).ToString("D");

    /// <summary>msdb's type letter or HEADERONLY's BackupType as the catalogue's set type, or null for one Varia does not list (a snapshot).</summary>
    internal static string? SetType(string letter) => letter switch
    {
        "D" or "1" => "full",
        "I" or "5" => "differential",
        "L" or "2" => "log",
        "F" or "4" => "file",
        "G" or "6" => "fileDifferential",
        "P" or "7" => "partial",
        "Q" or "8" => "partialDifferential",
        _ => null
    };

    /// <summary>A file's type: D data, L log, S FILESTREAM (or memory-optimized), F a full-text catalog.</summary>
    internal static string FileType(string letter) => letter.Trim() switch
    {
        "D" => "data",
        "L" => "log",
        "S" => "filestream",
        "F" => "fulltext",
        _ => "other"
    };

    private static async Task<RestoreServerDto> ServerAsync(SqlConnection connection, RestoreCatalogJson restore, bool linux, CancellationToken token)
    {
        string? data = null, log = null, backup = null;
        var canRestore = false;
        await using (var command = Command(connection, RestoreSql.Facts))
        await using (var reader = await command.ExecuteReaderAsync(token))
            if (await reader.ReadAsync(token))
            {
                string? Folder(int i) => reader.IsDBNull(i) ? null : ServerPath.Folder(reader.GetString(i), linux);
                (data, log, backup, canRestore) = (Folder(0), Folder(1), Folder(2), !reader.IsDBNull(3) && reader.GetBoolean(3));
            }
        var takeDestinations = (int)restore.Limit("destinations");
        var destinations = new List<RestoreDestinationDto>();
        await using (var command = Command(connection, RestoreSql.Destinations))
        {
            Add(command, "@take", SqlDbType.Int, 0, takeDestinations + 1);
            await using var reader = await command.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token))
                destinations.Add(new(reader.GetString(0), reader.GetInt32(1), DatabaseProperties.Iso(reader.GetValue(2)), Text(reader, 3), Text(reader, 4), reader.IsDBNull(5) ? null : reader.GetInt32(5)));
        }
        var takeFiles = (int)restore.Limit("serverFiles");
        var files = new List<RestoreServerFileDto>();
        await using (var command = Command(connection, RestoreSql.ServerFiles))
        {
            Add(command, "@take", SqlDbType.Int, 0, takeFiles + 1);
            await using var reader = await command.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token)) if (!reader.IsDBNull(1)) files.Add(new(reader.GetString(0), reader.GetString(1)));
        }
        return new(linux ? "/" : "\\", canRestore, Clip(destinations, takeDestinations), destinations.Count > takeDestinations, Clip(files, takeFiles), files.Count > takeFiles, data, log, backup);
    }

    private static async Task<(List<BackupSetDto> Sets, bool Truncated)> HistoryAsync(SqlConnection connection, RestoreCatalogJson restore, string database, CancellationToken token)
    {
        var take = (int)restore.Limit("historySets");
        var rows = new List<(BackupSetDto Set, int MediaSet, int Families)>();
        var families = new Dictionary<int, List<(string Device, bool Disk)>>();
        await using (var command = Command(connection, RestoreSql.History))
        {
            Add(command, "@take", SqlDbType.Int, 0, take + 1);
            Add(command, "@db", SqlDbType.NVarChar, 128, database);
            await using var reader = await command.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token))
            {
                if (SetType(Text(reader, 2)) is not { } type) continue;
                var set = new BackupSetDto(reader.GetGuid(0).ToString("D"), Text(reader, 1), type, Text(reader, 3), Text(reader, 4), Convert.ToInt32(reader.GetValue(5), CultureInfo.InvariantCulture),
                    Lsn(reader, 6), Lsn(reader, 7), Lsn(reader, 8), Lsn(reader, 9), reader.IsDBNull(10) ? "" : Time(reader.GetValue(10)), reader.IsDBNull(11) ? "" : Time(reader.GetValue(11)),
                    reader.IsDBNull(12) ? 0 : Long(reader.GetValue(12)), Text(reader, 13), !reader.IsDBNull(15) && reader.GetBoolean(15), !reader.IsDBNull(16) && reader.GetBoolean(16), [],
                    reader.IsDBNull(14) ? null : Time(reader.GetValue(14)), reader.IsDBNull(17) ? null : reader.GetString(17), ForkId(reader, 18), ForkId(reader, 19),
                    ForkPointLsn: reader.IsDBNull(22) ? null : Lsn(reader, 22), FamilyGuid: ForkId(reader, 23));
                rows.Add((set, reader.GetInt32(20), reader.IsDBNull(21) ? 1 : Convert.ToInt32(reader.GetValue(21), CultureInfo.InvariantCulture)));
            }
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token))
            {
                if (reader.IsDBNull(2)) continue;
                var type = reader.IsDBNull(3) ? 0 : Convert.ToInt32(reader.GetValue(3), CultureInfo.InvariantCulture);
                // 2 a disk file, 102 a backup device on disk (its physical name is the file).
                (families.TryGetValue(reader.GetInt32(0), out var list) ? list : families[reader.GetInt32(0)] = []).Add((reader.GetString(2), type is 2 or 102));
            }
        }
        var truncated = rows.Count > take;
        var sets = rows.Take(take).Select(row =>
        {
            var media = families.GetValueOrDefault(row.MediaSet) ?? [];
            var problem = media.Any(family => !family.Disk) ? restore.Message("notDisk")
                : media.Count < row.Families ? Striped(row.Families) : null;
            return row.Set with { Devices = [.. media.Select(family => family.Device)], Problem = problem };
        }).ToList();
        return (sets, truncated);
    }

    internal static string Striped(int families) => "This backup set is striped across " + families.ToString(CultureInfo.InvariantCulture) + " files; add the missing ones.";

    /// <summary>The sets on the devices: LABELONLY on each groups them into media sets (in the order first given, families in
    /// sequence), then HEADERONLY on each media set lists its sets. A media set with families missing is still read where SQL
    /// Server can, its sets marked so the planner passes them over.</summary>
    private static async Task<(List<BackupSetDto> Sets, bool Truncated)> MediaAsync(SqlConnection connection, RestoreCatalogJson restore, IReadOnlyList<string> devices, CancellationToken token)
    {
        var groups = new List<(Guid Id, int Families, SortedDictionary<int, string> Devices)>();
        foreach (var device in devices)
        {
            await using var command = Command(connection, RestoreSql.Label);
            AddDevices(command, [device]);
            await using var reader = await command.ExecuteReaderAsync(token);
            if (!await reader.ReadAsync(token)) continue;
            var id = reader.GetGuid(reader.GetOrdinal("MediaSetId"));
            var count = Convert.ToInt32(reader.GetValue(reader.GetOrdinal("FamilyCount")), CultureInfo.InvariantCulture);
            var sequence = Convert.ToInt32(reader.GetValue(reader.GetOrdinal("FamilySequenceNumber")), CultureInfo.InvariantCulture);
            var group = groups.FindIndex(item => item.Id == id);
            if (group < 0) { groups.Add((id, count, new())); group = groups.Count - 1; }
            groups[group].Devices.TryAdd(sequence, device);
        }
        var take = (int)restore.Limit("historySets");
        var sets = new List<BackupSetDto>();
        for (var index = 0; index < groups.Count && sets.Count <= take; index++)
        {
            var (_, families, members) = groups[index];
            var paths = members.Values.ToList();
            var problem = paths.Count < families ? Striped(families) : null;
            await using var command = Command(connection, RestoreSql.Header(paths.Count));
            AddDevices(command, paths);
            SqlDataReader reader;
            try { reader = await command.ExecuteReaderAsync(token); }
            // Families missing: SQL Server may refuse the media set; it then says only what the planner would.
            catch (SqlException) when (problem is not null && !token.IsCancellationRequested) { continue; }
            await using (reader)
            {
                int Column(string name) => reader.GetOrdinal(name);
                var c = (Name: Column("BackupName"), Type: Column("BackupType"), Server: Column("ServerName"), Database: Column("DatabaseName"), Position: Column("Position"), First: Column("FirstLSN"),
                    Last: Column("LastLSN"), Checkpoint: Column("CheckpointLSN"), Base: Column("DatabaseBackupLSN"), Start: Column("BackupStartDate"), Finish: Column("BackupFinishDate"),
                    Size: Column("BackupSize"), User: Column("UserName"), Expiration: Column("ExpirationDate"), CopyOnly: Column("IsCopyOnly"), Damaged: Column("IsDamaged"),
                    Model: Column("RecoveryModel"), FirstFork: Column("FirstRecoveryForkID"), Fork: Column("RecoveryForkID"), Snapshot: Column("IsSnapshot"), ForkPoint: Column("ForkPointLSN"),
                    Family: Column("FamilyGUID"));
                while (await reader.ReadAsync(token))
                {
                    if (SetType(Text(reader, c.Type)) is not { } type || (!reader.IsDBNull(c.Snapshot) && Convert.ToBoolean(reader.GetValue(c.Snapshot), CultureInfo.InvariantCulture))) continue;
                    var position = Convert.ToInt32(reader.GetValue(c.Position), CultureInfo.InvariantCulture);
                    sets.Add(new((index + 1).ToString(CultureInfo.InvariantCulture) + ":" + position.ToString(CultureInfo.InvariantCulture), Text(reader, c.Name), type, Text(reader, c.Server), Text(reader, c.Database),
                        position, Lsn(reader, c.First), Lsn(reader, c.Last), Lsn(reader, c.Checkpoint), Lsn(reader, c.Base), reader.IsDBNull(c.Start) ? "" : Time(reader.GetValue(c.Start)),
                        reader.IsDBNull(c.Finish) ? "" : Time(reader.GetValue(c.Finish)), reader.IsDBNull(c.Size) ? 0 : Long(reader.GetValue(c.Size)), Text(reader, c.User),
                        !reader.IsDBNull(c.CopyOnly) && Convert.ToBoolean(reader.GetValue(c.CopyOnly), CultureInfo.InvariantCulture),
                        !reader.IsDBNull(c.Damaged) && Convert.ToBoolean(reader.GetValue(c.Damaged), CultureInfo.InvariantCulture), paths,
                        reader.IsDBNull(c.Expiration) ? null : Time(reader.GetValue(c.Expiration)), reader.IsDBNull(c.Model) ? null : Text(reader, c.Model),
                        ForkId(reader, c.FirstFork), ForkId(reader, c.Fork), problem, reader.IsDBNull(c.ForkPoint) ? null : Lsn(reader, c.ForkPoint), ForkId(reader, c.Family)));
                }
            }
        }
        return (Clip(sets, take), sets.Count > take);
    }
}
