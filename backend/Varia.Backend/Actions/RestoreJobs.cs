using System.Text.RegularExpressions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Actions;

/// <summary>Restore Database on the object-action path (D1e): its describe (RestoreDescribe) and its Script, which renders SSMS's
/// text, reads nothing and runs nothing. actions.execute refuses a restore until D1f runs one (critic A17). Validation repeats
/// src/shared/actions/restore-schema.ts against the catalogue's restore block, so C# holds no limits of its own.</summary>
internal sealed partial class ActionService
{
    private RestoreCatalogJson Restore => catalog.Restore;

    [GeneratedRegex(@"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[1-9][0-9]?:[1-9][0-9]{0,4})\z")]
    private static partial Regex RestoreSetId();
    [GeneratedRegex(@"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z")]
    private static partial Regex RestoreUuid();
    [GeneratedRegex(@"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\z")]
    private static partial Regex RestoreTime();
    [GeneratedRegex(@"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}\z")]
    private static partial Regex RestoreIdentityCreated();

    private bool RestorePath(string? path) => ServerPath.Valid(path, catalog.Limit("serverPath"));

    private void RestoreDevices(List<string>? devices)
    {
        if (devices is null || devices.Count < 1 || devices.Count > Restore.Limit("backupDevices") || devices.Any(device => !RestorePath(device))) throw Invalid("devices.");
    }

    /// <summary>Re-validates restoreSourceSchema: the server as the target, and one source of its kind's members only.</summary>
    private ObjectRefDto ValidateRestoreSource(ActionDescribeArgs args)
    {
        if (args.Target is not { Kind: "server" }) throw Invalid("target.");
        try { ExplorerRefs.Object(args.Target, explorer); }
        catch (RequestException) { throw Invalid("target."); }
        var source = args.Restore ?? throw Invalid("restore.");
        switch (source.Kind)
        {
            case "history":
                if (source.Devices is not null || source.SetId is not null || source.File is not null || (source.Database is not null && !ExplorerRefs.Ident(source.Database))) throw Invalid("restore.");
                break;
            case "devices":
                if (source.Database is not null || source.SetId is not null || source.File is not null) throw Invalid("restore.");
                RestoreDevices(source.Devices);
                break;
            case "historyFiles":
                if (source.Database is not null || source.Devices is not null || source.File is not null || source.SetId is null || !RestoreUuid().IsMatch(source.SetId)) throw Invalid("restore.");
                break;
            case "mediaFiles":
                if (source.Database is not null || source.SetId is not null || source.File is not { } file || file < 1 || file > Restore.Limit("position")) throw Invalid("restore.");
                RestoreDevices(source.Devices);
                break;
            default:
                throw Invalid("restore.");
        }
        return args.Target;
    }

    /// <summary>Re-validates restoreRequestSchema: the destination by name, never SQL Server's own (critic A19), its identity when it
    /// exists, and the restore's sets, moves and options with restoreOptionsProblems' rules. Only actions.script takes it in D1e.</summary>
    private ObjectRefDto ValidateRestore(ActionArgs args, bool script)
    {
        if (!script) throw Invalid("restore runs in a later update; script it instead.");
        if (args.NewName is not null || args.CloseConnections is not null || args.DeleteHistory is not null || args.Changes is not null || args.Design is not null) throw Invalid("restore takes only its options.");
        var target = args.Target ?? throw Invalid("target.");
        if (target.Kind != "database" || target.Database is not null || target.Schema is not null || target.Parent is not null || !ExplorerRefs.Ident(target.Name)) throw Invalid("target.");
        // In any case: a case-insensitive server, the default, takes MSDB for msdb.
        if (Restore.SystemDatabases.Contains(target.Name!, StringComparer.OrdinalIgnoreCase)) throw Invalid(Restore.Message("systemDatabase"));
        if (args.Identity is { } identity && (identity.Id < 1 || identity.Created is null || !RestoreIdentityCreated().IsMatch(identity.Created))) throw Invalid("identity.");
        var options = args.Restore ?? throw Invalid("restore.");
        var sets = options.Sets ?? throw Invalid("restore.sets.");
        if (sets.Count < 1 || sets.Count > Restore.Limit("planSets")) throw Invalid("restore.sets.");
        for (var index = 0; index < sets.Count; index++)
        {
            var set = sets[index];
            if (set is null || set.Id is null || set.Id.Length > Restore.Limit("setId") || !RestoreSetId().IsMatch(set.Id) || set.File < 1 || set.File > Restore.Limit("position")
                || (set.Name is { } name && (name.Length > Restore.Limit("setName") || name.Contains('\0')))) throw Invalid("restore.sets.");
            RestoreDevices(set.Devices);
            var fits = set.Type switch
            {
                "full" => index == 0,
                "differential" => index == 1,
                "log" => index > 0,
                _ => false
            };
            if (!fits) throw Invalid("restore.sets: a full backup, then at most one differential, then logs.");
        }
        if (sets.Select(set => set.Id).Distinct(StringComparer.Ordinal).Count() != sets.Count) throw Invalid("restore.sets: a set is listed twice.");
        if (options.StopAt is { } stopAt && (!RestoreTime().IsMatch(stopAt) || sets[^1].Type != "log")) throw Invalid("restore.stopAt.");
        var moves = options.Relocate ?? throw Invalid("restore.relocate.");
        if (moves.Count > Restore.Limit("restoreMoves") || moves.Any(move => move is null || !ExplorerRefs.Ident(move.Logical) || !RestorePath(move.Physical))) throw Invalid("restore.relocate.");
        if (moves.Select(move => move.Logical).Distinct(StringComparer.Ordinal).Count() != moves.Count
            || moves.Select(move => move.Physical.ToLowerInvariant()).Distinct(StringComparer.Ordinal).Count() != moves.Count) throw Invalid("restore.relocate: a file or a path is listed twice.");
        if (!Restore.RecoveryStates.Contains(options.Recovery, StringComparer.Ordinal)) throw Invalid("restore.recovery.");
        if ((options.Recovery == "standby") != (options.StandbyFile is not null) || (options.StandbyFile is not null && !RestorePath(options.StandbyFile))) throw Invalid("restore.standbyFile.");
        if (options.KeepReplication && options.Recovery == "norecovery") throw Invalid("restore.keepReplication.");
        if (options.TailLog is { } tail && (tail.File is null || !RestorePath(tail.File))) throw Invalid("restore.tailLog.");
        return target;
    }

    private Task<ActionDescribeResult> DescribeRestoreAsync(ActionDescribeArgs args, CancellationToken token)
    {
        var watch = System.Diagnostics.Stopwatch.StartNew();
        return RunAsync(args.ConnectionId, args.RequestId, "restore", read: true, Options.RestoreDescribeBudget, token,
            async (connection, profile, band, job) =>
            {
                var (model, error) = await RestoreDescribe.DescribeAsync(connection, catalog, args.Restore!, profile.Linux, job);
                return new ActionDescribeResult(null, watch.ElapsedMilliseconds, error, Restore: model);
            },
            error => new ActionDescribeResult(null, watch.ElapsedMilliseconds, error), "Reading the backups", own: OwnGate.Restore);
    }

    /// <summary>Script: SSMS's text for the restore. It reads nothing and runs nothing; a destination that exists comes with its
    /// identity. Every RESTORE repeats the moves, so the text stops at the limit as it is written, never after.</summary>
    private ActionScriptResult ScriptRestore(ActionArgs args, ObjectRefDto target)
    {
        var text = RestoreSql.Script(Restore, target.Name!, args.Restore!, exists: args.Identity is not null, ScriptLimit(args.Action));
        return text is null ? new ActionScriptResult(null, "master", [], Error("SQL_ERROR", "The script is too large: it is longer than " + ScriptLimit(args.Action).ToString("N0", System.Globalization.CultureInfo.InvariantCulture) + " characters."))
            : new ActionScriptResult(text, "master", []);
    }

}
