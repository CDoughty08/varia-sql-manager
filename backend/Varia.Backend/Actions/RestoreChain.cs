using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>The run's check of the plan it was sent (D1f): the document's planner chose the sets, but the backend never trusts it.
/// Right before any statement, HEADERONLY re-reads each set's media (once per media set) and the sets must be what the request
/// says, in an order SQL Server can restore: a full backup, at most one differential based on it, then logs that each continue the
/// set before them on its recovery fork, all of one database (the planner's rules, src/shared/actions/restore-plan.ts).</summary>
internal static class RestoreChain
{
    /// <summary>The chain as the media hold it: the database the backup is of and its family, and each planned set's header.</summary>
    public sealed record Chain(string Database, string? Family, List<BackupSetDto> Sets);

    public static async Task<(Chain? Chain, ActionError? Error)> ReadAsync(SqlConnection connection, ActionsCatalog catalog, IReadOnlyList<RestorePlanSetDto> planned, CancellationToken token)
    {
        var media = new Dictionary<string, List<BackupSetDto>>(StringComparer.Ordinal);
        var headers = new List<BackupSetDto>();
        try
        {
            foreach (var set in planned)
            {
                var key = string.Join("\n", set.Devices);
                if (!media.TryGetValue(key, out var listed)) media[key] = listed = await RestoreDescribe.HeadersAsync(connection, set.Devices, "1", null, token);
                if (listed.FirstOrDefault(item => item.Position == set.File) is not { } header)
                    return (null, ActionErrors.Create(catalog, "MEDIA", "No full, differential or log backup is at position " + set.File.ToString(CultureInfo.InvariantCulture) + " of " + Where(set) + ". Read the backups again."));
                headers.Add(header);
            }
        }
        catch (SqlException error) when (!token.IsCancellationRequested && RestoreDescribe.MediaError(catalog, error, connection) is { } value) { return (null, value); }
        if (Problem(catalog.Restore, planned, headers) is { } problem) return (null, ActionErrors.Create(catalog, problem.Code, problem.Message));
        return (new(headers[0].Database, headers[0].FamilyGuid, headers), null);
    }

    /// <summary>Why the headers the media hold do not restore as planned, or null: a set of another kind than planned, a damaged set,
    /// a copy-only log, sets of more than one database, a differential not based on the full, or a log that does not continue the
    /// set before it.</summary>
    internal static (string Code, string Message)? Problem(RestoreCatalogJson restore, IReadOnlyList<RestorePlanSetDto> planned, IReadOnlyList<BackupSetDto> headers)
    {
        var invalid = restore.Message("invalidPlan");
        for (var index = 0; index < planned.Count; index++)
        {
            var (set, header) = (planned[index], headers[index]);
            if (header.Type != set.Type)
                return ("RESTORE_SEQUENCE", "The backup at position " + set.File.ToString(CultureInfo.InvariantCulture) + " of " + Where(set) + " is not the " + set.Type + " backup the plan names. Read the backups again.");
            if (header.Damaged) return ("MEDIA", restore.Message("damaged") + " (" + Where(set) + ")");
            if (header.Type == "log" && header.CopyOnly) return ("RESTORE_SEQUENCE", restore.Message("copyOnlyLog") + " (" + Where(set) + ")");
            if (!SameFamily(header, headers[0])) return ("RESTORE_SEQUENCE", invalid + " The backup sets are not all of one database.");
            var fits = index == 0 ? header.Type == "full"
                : header.Type == "differential" ? index == 1 && BasedOn(header, headers[0])
                : header.Type == "log" && Continues(header, headers[index - 1]);
            if (!fits) return ("RESTORE_SEQUENCE", invalid + " " + Where(set) + " does not follow the backup before it.");
        }
        return null;
    }

    /// <summary>A set's first file by name, and how many more it is striped across.</summary>
    internal static string Where(RestorePlanSetDto set)
    {
        var first = set.Devices[0];
        var name = first[(Math.Max(first.LastIndexOf('\\'), first.LastIndexOf('/')) + 1)..];
        return ScriptingErrors.Display(name) + (set.Devices.Count > 1 ? " (+" + (set.Devices.Count - 1).ToString(CultureInfo.InvariantCulture) + " files)" : "");
    }

    /// <summary>An LSN's decimal text (numeric(25, 0) fits decimal), or 0.</summary>
    private static decimal Lsn(string? text) => decimal.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var value) ? value : 0;
    private static bool SameFamily(BackupSetDto a, BackupSetDto b) => a.FamilyGuid is null || b.FamilyGuid is null || a.FamilyGuid == b.FamilyGuid;

    /// <summary>restore-plan.ts continues: the log starts at or before the set's last LSN and ends after it, in its family and on
    /// its recovery fork, and a log that forks inside itself continues only a set that ends by the fork point.</summary>
    internal static bool Continues(BackupSetDto log, BackupSetDto from)
    {
        if (!(Lsn(log.FirstLsn) <= Lsn(from.LastLsn) && Lsn(from.LastLsn) < Lsn(log.LastLsn)) || !SameFamily(log, from)) return false;
        if (log.FirstForkGuid is not null && from.ForkGuid is not null && log.FirstForkGuid != from.ForkGuid) return false;
        var forks = log.FirstForkGuid is not null && log.ForkGuid is not null && log.FirstForkGuid != log.ForkGuid;
        return !(forks && log.ForkPointLsn is not null && Lsn(log.ForkPointLsn) < Lsn(from.LastLsn));
    }

    /// <summary>restore-plan.ts basedOn: the differential's database_backup_lsn is the full's checkpoint, and it ends after the full.</summary>
    internal static bool BasedOn(BackupSetDto differential, BackupSetDto full) =>
        Lsn(differential.DatabaseBackupLsn) == Lsn(full.CheckpointLsn) && Lsn(differential.LastLsn) > Lsn(full.LastLsn) && SameFamily(differential, full);
}
