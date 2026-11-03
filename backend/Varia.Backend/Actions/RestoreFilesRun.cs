using System.Data;
using System.Globalization;
using System.Text;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>Restore Files and Filegroups (actions.script and actions.execute 'restoreFiles', D1g): some files of an existing database,
/// restored from one full or file backup and rolled forward through the log backups after it. A long action like Restore Database: the
/// long gate, Stop and STATS progress. Its preflight, in the action's own connection, checks the database is the one the document read,
/// the chain on the media (RestoreChain, files variant), that the backups are the database's own, that under FULL or BULK_LOGGED the plan
/// reaches the database's log chain (spec D1 §8), that each named file or filegroup is in the backup set, no log file and, on an online or
/// offline database, not of PRIMARY (an offline restore that loses the log's tail), Learn's rule that under SIMPLE only a read-only
/// filegroup's files restore, and every file it writes.
/// The steps: "Restore the files" (RESTORE DATABASE … FILE = @f1, FILEGROUP = @g1 …), one "Restore log backup n of m" per log, and, when
/// asked, Varia's "Back up the log" (COPY_ONLY) and "Restore the log backup", which an online file restore under FULL or BULK_LOGGED
/// needs to bring its files online (probed on 2025); Back up the log first checks that no log backup was taken during the run. It never drops anything: a stopped or failed file restore leaves the files it
/// reached RESTORING, and the reply names them (restored.filesRestoring). Nothing here logs a name, path or statement.</summary>
internal sealed partial class ActionService
{
    /// <summary>Re-validates restoreFilesRequestSchema (restore-schema.ts): an existing user database by name with its identity, the sets
    /// (a full or file backup, then logs), the files and filegroups, the moves and the options, with restoreFilesOptionsProblems' rules.</summary>
    private ObjectRefDto ValidateRestoreFiles(ActionArgs args)
    {
        if (args.NewName is not null || args.CloseConnections is not null || args.DeleteHistory is not null || args.Changes is not null || args.Design is not null || args.Restore is not null)
            throw Invalid("restoreFiles takes only its options.");
        var target = args.Target ?? throw Invalid("target.");
        if (target.Kind != "database" || target.Database is not null || target.Schema is not null || target.Parent is not null || !ExplorerRefs.Ident(target.Name)) throw Invalid("target.");
        if (Restore.SystemDatabases.Contains(target.Name!, StringComparer.OrdinalIgnoreCase)) throw Invalid(Restore.Message("systemDatabase"));
        if (args.Identity is not { } identity || identity.Id < 1 || identity.Created is null || !RestoreIdentityCreated().IsMatch(identity.Created)) throw Invalid("identity.");
        var options = args.RestoreFiles ?? throw Invalid("restoreFiles.");
        var sets = options.Sets ?? throw Invalid("restoreFiles.sets.");
        if (sets.Count < 1 || sets.Count > Restore.Limit("planSets")) throw Invalid("restoreFiles.sets.");
        for (var index = 0; index < sets.Count; index++)
        {
            var set = sets[index];
            if (set is null || set.Id is null || set.Id.Length > Restore.Limit("setId") || !RestoreSetId().IsMatch(set.Id) || set.File < 1 || set.File > Restore.Limit("position")
                || (set.Name is { } name && (name.Length > Restore.Limit("setName") || name.Contains('\0')))) throw Invalid("restoreFiles.sets.");
            RestoreDevices(set.Devices);
            var fits = index == 0 ? set.Type is "full" or "file" : set.Type == "log";
            if (!fits || !Restore.FilesSetTypes.Contains(set.Type, StringComparer.Ordinal)) throw Invalid("restoreFiles.sets: a full or file backup, then logs.");
        }
        if (sets.Select(set => set.Id).Distinct(StringComparer.Ordinal).Count() != sets.Count) throw Invalid("restoreFiles.sets: a set is listed twice.");
        var named = (int)Restore.Limit("restoreFiles");
        foreach (var (list, member) in new[] { (options.Files, "files"), (options.Filegroups, "filegroups") })
        {
            if (list is null || list.Count > named || list.Any(item => !ExplorerRefs.Ident(item))) throw Invalid("restoreFiles." + member + ".");
            if (list.Distinct(StringComparer.Ordinal).Count() != list.Count) throw Invalid("restoreFiles." + member + ": a name is listed twice.");
        }
        if (options.Files!.Count + options.Filegroups!.Count == 0) throw Invalid("restoreFiles: name the files or filegroups to restore.");
        var moves = options.Relocate ?? throw Invalid("restoreFiles.relocate.");
        if (moves.Count > Restore.Limit("restoreMoves") || moves.Any(move => move is null || !ExplorerRefs.Ident(move.Logical) || !RestorePath(move.Physical))) throw Invalid("restoreFiles.relocate.");
        if (moves.Select(move => move.Logical).Distinct(StringComparer.Ordinal).Count() != moves.Count
            || moves.Select(move => move.Physical.ToLowerInvariant()).Distinct(StringComparer.Ordinal).Count() != moves.Count) throw Invalid("restoreFiles.relocate: a file or a path is listed twice.");
        if (RestoreFilesParameters(options) > Restore.Limit("parameters")) throw Invalid("restoreFiles: too many parameters for one RESTORE.");
        if (!Restore.RecoveryStates.Contains(options.Recovery, StringComparer.Ordinal)) throw Invalid("restoreFiles.recovery.");
        if ((options.Recovery == "standby") != (options.StandbyFile is not null) || (options.StandbyFile is not null && !RestorePath(options.StandbyFile))) throw Invalid("restoreFiles.standbyFile.");
        if (options.LogBackup is { } backup && (backup.File is null || !RestorePath(backup.File) || options.Recovery != "recovery")) throw Invalid("restoreFiles.logBackup.");
        return target;
    }

    /// <summary>The parameters the files' RESTORE DATABASE sends (restore-schema.ts restoreFilesParameters): @db, @file and @standby, the
    /// files, filegroups and devices, and two per move.</summary>
    internal static int RestoreFilesParameters(RestoreFilesOptionsDto options) =>
        3 + options.Files.Count + options.Filegroups.Count + (options.Sets.Count > 0 ? options.Sets[0].Devices.Count : 0) + 2 * options.Relocate.Count;

    /// <summary>Script: SSMS's text for the file restore, from the request and the catalogue alone (it reads and runs nothing).</summary>
    private ActionScriptResult ScriptRestoreFiles(ActionArgs args, ObjectRefDto target)
    {
        var limit = Restore.Limit("scriptChars");
        var text = RestoreSql.FilesScript(Restore, target.Name!, args.RestoreFiles!, limit);
        return text is null ? new ActionScriptResult(null, "master", [], Error("SQL_ERROR", "The script is too large: it is longer than " + limit.ToString("N0", CultureInfo.InvariantCulture) + " characters."))
            : new ActionScriptResult(text, "master", []);
    }

    private async Task<ActionExecuteResult> ExecuteRestoreFilesJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, bool linux, ActionProgress progress, CancellationToken token)
    {
        var messages = CollectMessages(connection, progress);
        var database = target.Name!;
        var (facts, reach, refused) = await RestoreFilesPreflightAsync(connection, args, database, linux, token);
        if (facts is null) return new([], [], 0, refused);
        var options = args.RestoreFiles!;
        var (steps, failure, _) = await RunStepsAsync(connection, RestoreFilesSteps(connection, database, options, facts.Id, reach), null, token, CleanupBudget(args.Action), progress: progress);
        // How the run left the database and which of its files are still RESTORING, read once the steps are over, with a token of its own.
        RestoredDatabaseDto? restored = null;
        if (connection.State == ConnectionState.Open)
        {
            using var reading = new CancellationTokenSource(Options.StopGrace);
            try
            {
                if (await RestoredAsync(connection, database, reading.Token) is { } now)
                {
                    var restoring = (await DatabaseFilesAsync(connection, now.Id, reading.Token)).Where(file => file.State == 1).Select(file => file.Name).ToList();
                    restored = new(now.State, now.UserAccess, FilesRestoring: restoring.Count > 0 ? [.. restoring.Take(MaxFilesLeft)] : null);
                    if (now.State != 0) host.DatabaseChanged(args.ConnectionId, database, null);
                }
                else restored = new(null, null, true);
            }
            catch (Exception error) when (error is SqlException or OperationCanceledException or InvalidOperationException) { }
        }
        return new(steps, messages.Collected(), 0, failure, restored);
    }

    /// <summary>A database file as sys.master_files has it: its logical name, whether it is read-only, and its state (1 RESTORING).</summary>
    internal sealed record DatabaseFileRow(string Name, bool ReadOnly, int State);

    private static async Task<List<DatabaseFileRow>> DatabaseFilesAsync(SqlConnection connection, int id, CancellationToken token)
    {
        var files = new List<DatabaseFileRow>();
        await using var command = connection.CreateCommand();
        command.CommandText = RestoreSql.DatabaseFiles;
        command.CommandTimeout = 0;
        Add(command, "@id", SqlDbType.Int, 0, id);
        Add(command, "@take", SqlDbType.Int, 0, 32_767);
        await using var reader = await command.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token))
            if (!reader.IsDBNull(0)) files.Add(new(reader.GetString(0), !reader.IsDBNull(1) && reader.GetBoolean(1), reader.IsDBNull(2) ? 0 : Convert.ToInt32(reader.GetValue(2), CultureInfo.InvariantCulture)));
        return files;
    }

    /// <summary>The preflight (D1g) in the action's connection (master), before any statement. Nothing here changes the database. Reach is
    /// the plan's last LSN where the database keeps a log chain, which Back up the log checks again before it runs.</summary>
    private async Task<(RestoreFacts? Facts, string? Reach, ActionError? Error)> RestoreFilesPreflightAsync(SqlConnection connection, ActionArgs args, string database, bool linux, CancellationToken token)
    {
        var display = ScriptingErrors.Display(database);
        var options = args.RestoreFiles!;
        var (row, ids, _, sysadmin, views) = await ReadPreflightAsync(connection, database, token);
        if (IdentityProblem(row, args.Identity!, database) is { } changed) return (null, null, changed);
        if (row!.Bool("is_snapshot")) return (null, null, Error("NOT_SUPPORTED", "A database snapshot's files cannot be restored."));
        // sys.databases.recovery_model: 1 FULL, 2 BULK_LOGGED, 3 SIMPLE.
        var simple = row.Int("recovery_model") == 3;
        if (options.LogBackup is not null)
        {
            if (simple) return (null, null, Error("NOT_SUPPORTED", "The database " + display + " uses the SIMPLE recovery model, which has no log to back up. Clear Back up the log."));
            if (row.Int("state") != 0) return (null, null, Error("DATABASE_UNAVAILABLE", "The database " + display + " is not online, so its log cannot be backed up. Clear Back up the log."));
        }
        // SQL Server refuses STANDBY on an online database's file restore only at the log, after the files are restored (4302, probed on 2025).
        if (options.Recovery == "standby" && row.Int("state") == 0) return (null, null, Error("NOT_SUPPORTED", Restore.Message("standbyOnline")));
        var (chain, media) = await RestoreChain.ReadAsync(connection, catalog, options.Sets, token, files: true);
        if (chain is null) return (null, null, media);
        // Files restore only from the database's own backups: by its backup family where both are known, else by name.
        var family = row.Raw("family_guid") is Guid guid ? guid.ToString("D") : null;
        var own = chain.Family is not null && family is not null ? string.Equals(chain.Family, family, StringComparison.OrdinalIgnoreCase) : string.Equals(chain.Database, database, StringComparison.OrdinalIgnoreCase);
        if (!own) return (null, null, Error("BACKUP_MISMATCH", Restore.Message("otherDatabase")));
        // Under FULL or BULK_LOGGED the plan must reach the log chain (spec D1 §8): a log backup taken after its last set, outside the
        // plan, would leave the restored files waiting for it, and Varia's log backup, which starts where the chain is, would not continue
        // them (4305), after the files are restored.
        var next = row.Raw("last_log_backup_lsn") is decimal lsn ? lsn : (decimal?)null;
        var tracked = !simple && next is not null;
        if (tracked && !RestoreChain.Reaches(chain.Sets[^1].LastLsn, next))
            return (null, null, Error("RESTORE_SEQUENCE", Restore.Message("logChainAhead") + await NewestLogBackupAsync(connection, database, row.Int("database_id"), token)));

        var (listed, unread) = await FileListAsync(connection, options.Sets[0], token);
        if (listed is null) return (null, null, unread);
        // A PRIMARY file restores only offline: on an online or offline database (sys.databases.state 0 or 6) that loses the log's tail.
        var (restored, problem) = RestoredFiles(listed, options, primaryRefused: row.Int("state") is 0 or 6);
        if (problem is not null) return (null, null, problem);
        if (simple)
        {
            var readOnly = (await DatabaseFilesAsync(connection, row.Int("database_id"), token)).ToDictionary(file => file.Name, file => file.ReadOnly, StringComparer.OrdinalIgnoreCase);
            if (restored!.FirstOrDefault(file => !readOnly.GetValueOrDefault(file.Logical)) is { } writable)
                return (null, null, Error("NOT_SUPPORTED", Restore.Message("simpleReadOnly") + " " + ScriptingErrors.Display(writable.Logical) + " belongs to a read-write filegroup of " + display + ", which uses the SIMPLE recovery model."));
        }
        var facts = new RestoreFacts(true, row.Int("database_id"), row.Int("user_access"), ids, views, sysadmin);
        var written = new List<(string Path, string What)>();
        if (options.Recovery == "standby" && options.StandbyFile is { } standby) written.Add((standby, "standby file"));
        if (options.LogBackup is { } backup) written.Add((backup.File, "log backup file"));
        if (await WrittenProblemAsync(connection, database, restored!, options.Relocate, written, facts, linux, token) is { } paths) return (null, null, paths);
        // The log backup goes to a new file, so it is the file's first backup set, as Script writes it (FILE = 1).
        if (options.LogBackup is { } fresh && await ExistingAsync(connection, [fresh.File], facts, token) is { Count: > 0 })
            return (null, null, Error("NAME_IN_USE", "The log backup file " + ScriptingErrors.Display(fresh.File) + " is already on the server. Choose a new file for the log backup."));
        return (facts, tracked ? chain.Sets[^1].LastLsn : null, null);
    }

    /// <summary>The backup set's files the request restores: each named file, and every file of each named filegroup, all in the set;
    /// or why not: a name the set does not have, a file it does not hold (a file backup of other files), a log file, or a move of a
    /// file that is not restored; with <paramref name="primaryRefused"/> (an online or offline database), a file of the PRIMARY filegroup.</summary>
    internal (List<ListedFile>? Files, ActionError? Error) RestoredFiles(IReadOnlyList<ListedFile> listed, RestoreFilesOptionsDto options, bool primaryRefused = false)
    {
        var restored = new List<ListedFile>();
        foreach (var name in options.Files)
        {
            var file = listed.FirstOrDefault(item => string.Equals(item.Logical, name, StringComparison.OrdinalIgnoreCase));
            if (file is null) return (null, Error("NOT_FOUND", "The backup set has no file named " + ScriptingErrors.Display(name) + ". Read the backups again."));
            if (file.Type == "L") return (null, Error("NOT_SUPPORTED", ScriptingErrors.Display(name) + " is a log file: the log is not restored by itself; the log backups after the backup set restore with the data files."));
            if (!file.Present) return (null, Error("NOT_FOUND", "The backup set does not hold " + ScriptingErrors.Display(name) + ": it is a backup of other files."));
            restored.Add(file);
        }
        foreach (var name in options.Filegroups)
        {
            var files = listed.Where(item => item.Present && item.Type != "L" && string.Equals(item.Filegroup, name, StringComparison.OrdinalIgnoreCase)).ToList();
            if (files.Count == 0) return (null, Error("NOT_FOUND", "The backup set holds no file of the filegroup " + ScriptingErrors.Display(name) + ". Read the backups again."));
            restored.AddRange(files.Where(file => !restored.Contains(file)));
        }
        // The PRIMARY filegroup's name is fixed (it cannot be renamed), and FILELISTONLY names it so.
        if (primaryRefused && restored.Any(file => string.Equals(file.Filegroup, "PRIMARY", StringComparison.OrdinalIgnoreCase))) return (null, Error("NOT_SUPPORTED", Restore.Message("primaryOnline")));
        if (options.Relocate.FirstOrDefault(move => !restored.Any(file => string.Equals(file.Logical, move.Logical, StringComparison.OrdinalIgnoreCase))) is { } stray)
            return (null, Error("NOT_FOUND", ScriptingErrors.Display(stray.Logical) + " is not among the files restored, so it cannot be moved."));
        return (restored, null);
    }

    /// <summary>The file restore's steps in Script's order (RestoreSql.FilesLines). No compensation or cleanup: nothing here can be undone
    /// but by another restore, and the database existed, so Varia never drops it (owner decision 5). With <paramref name="reach"/> (the
    /// plan's last LSN where the database keeps a log chain), Back up the log first checks that no log backup was taken during the run.</summary>
    internal List<RunStep> RestoreFilesSteps(SqlConnection connection, string database, RestoreFilesOptionsDto options, int databaseId = 0, string? reach = null)
    {
        var steps = new List<RunStep>();
        var last = options.LogBackup is null ? options.Sets.Count - 1 : -1;
        var logs = options.Sets.Count - 1;
        for (var index = 0; index < options.Sets.Count; index++)
        {
            var set = options.Sets[index];
            var first = index == 0;
            var recovery = index == last ? options.Recovery : "norecovery";
            var title = index == 0 ? Restore.Step("files") : Restore.Step("log") + (logs > 1 ? " " + index.ToString(CultureInfo.InvariantCulture) + " of " + logs.ToString(CultureInfo.InvariantCulture) : "");
            var text = RestoreFilesText(Restore, options, index, recovery);
            steps.Add(new(title, context => RunMediaAsync(connection, text, command =>
            {
                Add(command, "@db", SqlDbType.NVarChar, 128, database);
                for (var device = 0; device < set.Devices.Count; device++) Add(command, "@d" + (device + 1).ToString(CultureInfo.InvariantCulture), SqlDbType.NVarChar, 260, set.Devices[device]);
                Add(command, "@file", SqlDbType.Int, 0, set.File);
                if (first)
                {
                    for (var item = 0; item < options.Files.Count; item++) Add(command, "@f" + (item + 1).ToString(CultureInfo.InvariantCulture), SqlDbType.NVarChar, 128, options.Files[item]);
                    for (var item = 0; item < options.Filegroups.Count; item++) Add(command, "@g" + (item + 1).ToString(CultureInfo.InvariantCulture), SqlDbType.NVarChar, 128, options.Filegroups[item]);
                    for (var item = 0; item < options.Relocate.Count; item++)
                    {
                        var number = (item + 1).ToString(CultureInfo.InvariantCulture);
                        Add(command, "@l" + number, SqlDbType.NVarChar, 128, options.Relocate[item].Logical);
                        Add(command, "@p" + number, SqlDbType.NVarChar, 260, options.Relocate[item].Physical);
                    }
                }
                if (recovery == "standby") Add(command, "@standby", SqlDbType.NVarChar, 260, options.StandbyFile);
            }, context.Token), Detail: RestoreChain.Where(set) + ", position " + set.File.ToString(CultureInfo.InvariantCulture)));
        }
        if (options.LogBackup is { } backup)
        {
            var name = RestoreSql.TailName(backup.File);
            void Bind(SqlCommand command)
            {
                Add(command, "@db", SqlDbType.NVarChar, 128, database);
                Add(command, "@tail", SqlDbType.NVarChar, 260, backup.File);
                Add(command, "@tail_name", SqlDbType.NVarChar, 128, name);
            }
            steps.Add(new(Restore.Step("logBackup"), async context =>
            {
                // A log backup taken since the preflight moved the chain past the plan: a copy-only backup would start there and not
                // continue the restored files (4305), so the run stops here and says which backup they need.
                if (reach is not null && !RestoreChain.Reaches(reach, await LastLogBackupAsync(connection, databaseId, context.Token)))
                    throw new StepRefusedException(Error("RESTORE_SEQUENCE", Restore.Message("logBackedUpDuring") + await NewestLogBackupAsync(connection, database, databaseId, context.Token)));
                await RunMediaAsync(connection, RestoreSql.LogBackup(Restore), Bind, context.Token);
            }, Detail: FileName(backup.File)));
            steps.Add(new(Restore.Step("logBackupRestore"), async context =>
            {
                // The new file's backup set: its first, unless the server could not say the file was new (2016 without sysadmin), when it
                // is the last set of that name on it.
                var sets = await RestoreDescribe.HeadersAsync(connection, [backup.File], "1", null, context.Token);
                var ours = sets.Where(set => set.Type == "log" && set.Name == name).Select(set => set.Position).DefaultIfEmpty(sets.Count > 0 ? sets.Max(set => set.Position) : 1).Max();
                await RunMediaAsync(connection, RestoreFilesLogBackupText(Restore, options), command =>
                {
                    Add(command, "@db", SqlDbType.NVarChar, 128, database);
                    Add(command, "@d1", SqlDbType.NVarChar, 260, backup.File);
                    Add(command, "@file", SqlDbType.Int, 0, ours);
                }, context.Token);
            }, Detail: FileName(backup.File)));
        }
        return steps;
    }

    /// <summary>Where the database's log chain is now (RestoreSql.LastLogBackup), or null.</summary>
    private static async Task<decimal?> LastLogBackupAsync(SqlConnection connection, int id, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = RestoreSql.LastLogBackup;
        command.CommandTimeout = 0;
        Add(command, "@id", SqlDbType.Int, 0, id);
        Add(command, "@take", SqlDbType.Int, 0, 1);
        await using var reader = await command.ExecuteReaderAsync(token);
        return await reader.ReadAsync(token) && !reader.IsDBNull(0) ? reader.GetDecimal(0) : null;
    }

    /// <summary>A sentence naming the log backup that moved the chain (RestoreSql.NewestLogBackup): when it finished and its first file,
    /// or nothing when msdb has no record of it or is closed to the login.</summary>
    private static async Task<string> NewestLogBackupAsync(SqlConnection connection, string database, int id, CancellationToken token)
    {
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = RestoreSql.NewestLogBackup;
            command.CommandTimeout = 0;
            Add(command, "@db", SqlDbType.NVarChar, 128, database);
            Add(command, "@id", SqlDbType.Int, 0, id);
            Add(command, "@take", SqlDbType.Int, 0, 64);
            await using var reader = await command.ExecuteReaderAsync(token);
            DateTime? finished = null;
            var devices = new List<string>();
            while (await reader.ReadAsync(token))
            {
                finished ??= reader.IsDBNull(0) ? null : reader.GetDateTime(0);
                if (!reader.IsDBNull(1)) devices.Add(reader.GetString(1));
            }
            if (devices.Count == 0) return "";
            return " The newest log backup" + (finished is { } at ? ", finished " + at.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) + "," : "") + " is in "
                + ScriptingErrors.Display(devices[0]) + (devices.Count > 1 ? " (+" + (devices.Count - 1).ToString(CultureInfo.InvariantCulture) + " files)" : "") + ".";
        }
        catch (SqlException) when (!token.IsCancellationRequested) { return ""; }
    }

    /// <summary>The statement of the file restore's set at <paramref name="index"/>: the files' RESTORE DATABASE with the moves and REPLACE
    /// for the first, RESTORE LOG for the others; RESTRICTED_USER on each, and the recovery state given.</summary>
    internal static string RestoreFilesText(RestoreCatalogJson restore, RestoreFilesOptionsDto options, int index, string recovery)
    {
        var set = options.Sets[index];
        return index == 0
            ? RestoreSql.RestoreFiles(restore, options.Files.Count, options.Filegroups.Count, set.Devices.Count, options.Relocate.Count, options.RestrictedUser, recovery, options.Replace)
            : RestoreSql.Restore(restore, log: true, set.Devices.Count, moves: 0, options.RestrictedUser, keepReplication: false, recovery, replace: false, stopAt: false);
    }

    /// <summary>The restore of Varia's log backup, the last statement: WITH RECOVERY, which brings the files online.</summary>
    internal static string RestoreFilesLogBackupText(RestoreCatalogJson restore, RestoreFilesOptionsDto options) =>
        RestoreSql.Restore(restore, log: true, devices: 1, moves: 0, options.RestrictedUser, keepReplication: false, options.Recovery, replace: false, stopAt: false);
}
