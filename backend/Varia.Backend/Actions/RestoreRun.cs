using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>Restore Database's run (actions.execute 'restore', D1f), a long action: the long gate, Stop, progress from STATS, and the
/// shutdown drain. A preflight in the action's own connection (the destination's identity, permission, the tail-log backup's
/// conditions, RestoreChain on the media, WITH REPLACE's case, and every file it writes checked against the files on the server), then runner v2 with the
/// statements Script shows: Close existing connections, the tail-log backup, one RESTORE per set and SET MULTI_USER, each a
/// form 4 statement (RestoreSql) with every name, path, position and time a parameter. After a failure or Stop, Varia undoes only
/// its own changes that no RESTORE has overwritten (owner decision 5): the tail-log backup's RESTORING state and SINGLE_USER, while
/// no RESTORE started; and it removes a database the restore created, only while it is still that RESTORING database (critic
/// A11a), saying which of its files SQL Server left on disk. A database that existed is never dropped: a stopped restore leaves it
/// RESTORING, and the reply says so (critic A12).
/// Nothing here logs a name, path or statement.</summary>
internal sealed partial class ActionService
{
    /// <summary>SQL Server's errors that refuse a RESTORE while it plans, before it writes to the database: exclusive access (3101),
    /// another database's backup (3154), a path it cannot restore to (3156, 3119, 5133, 1834), the tail of the log (3159), media it
    /// cannot open or that are incomplete (3201, 3241, 3242, 3132), and sets out of sequence (4305, 4326, 3117). After one of them
    /// on the first RESTORE the database is as the steps before left it, so their compensations are due.</summary>
    internal static readonly IReadOnlySet<int> RefusedBeforeWrite = new HashSet<int> { 3101, 3154, 3156, 3119, 5133, 1834, 3159, 3201, 3241, 3242, 3132, 4305, 4326, 3117 };

    /// <summary>What the preflight read: whether the destination exists, its id and user access then (0 multi, 1 single, 2 restricted),
    /// every database id there was, so the cleanup drops only a database this restore created, and how a file's existence can be
    /// asked (sys.dm_os_file_exists from SQL Server 2017; xp_fileexist before, which answers sysadmin only).</summary>
    internal sealed record RestoreFacts(bool Exists, int Id, int UserAccess, IReadOnlySet<int> Ids, bool FileViews = false, bool Sysadmin = false);

    /// <summary>A database as sys.databases has it now.</summary>
    internal sealed record RestoredRow(int Id, int State, int UserAccess);

    /// <summary>What the cleanup found after it dropped a partly restored database: the files SQL Server left on disk (a cancelled
    /// RESTORE's, probed on 2025), or every file when it could not tell.</summary>
    internal sealed class RestoreLeftovers
    {
        public List<string>? Files { get; set; }
        public bool Unknown { get; set; }
    }

    private async Task<ActionExecuteResult> ExecuteRestoreJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, bool linux, ActionProgress progress, CancellationToken token)
    {
        var messages = CollectMessages(connection, progress);
        var database = target.Name!;
        var (facts, refused) = await RestorePreflightAsync(connection, args, database, linux, token);
        if (facts is null) return new([], [], 0, refused);
        var options = args.Restore!;
        var left = new RestoreLeftovers();
        var (steps, failure, _) = await RunStepsAsync(connection, RestoreSteps(connection, args.ConnectionId, database, options, facts, left), facts.Exists && !options.CloseConnections ? ActionErrors.CloseConnectionsAdvice : null,
            token, CleanupBudget(args.Action), progress: progress);
        // How the run left the database, read once the steps are over (Stop's token has fired by then, so the read has its own). When
        // it cannot be read (the connection is gone), the reply says nothing of the database rather than guess.
        RestoredRow? now = null;
        var read = false;
        if (connection.State == ConnectionState.Open)
        {
            using var reading = new CancellationTokenSource(Options.StopGrace);
            try { now = await RestoredAsync(connection, database, reading.Token); read = true; }
            catch (Exception error) when (error is SqlException or OperationCanceledException or InvalidOperationException) { }
        }
        if (failure?.Code == "CANCELLED" && FinishedAtStop(LastSetTitle(options), options.Recovery, steps, now))
            failure = failure with { Message = Restore.Message("finishedAtStop").Replace("{database}", ScriptingErrors.Display(database), StringComparison.Ordinal) };
        if (left.Files is { Count: > 0 } files)
        {
            var note = LeftoversNote(files, left.Unknown);
            var index = steps.FindIndex(step => step.Status == "done" && step.Title == Restore.Step("remove"));
            if (index >= 0) steps[index] = ActionSteps.Bound(steps[index] with { Message = note });
            if (failure is not null) failure = failure with { Message = ScriptingErrors.Clip(failure.Message + " " + note, ActionErrors.MaxMessage) };
        }
        // A database that is not online (RESTORING, or gone) is no connection's database any more.
        if (facts.Exists && now is not { State: 0 }) host.DatabaseChanged(args.ConnectionId, database, null);
        RestoredDatabaseDto? restored = !read ? null : now is not null ? new(now.State, now.UserAccess)
            : new(null, null, true, left.Files is { Count: > 0 } kept ? [.. kept.Take(MaxFilesLeft)] : null, left.Files is { Count: > 0 } && left.Unknown ? true : null);
        return new(steps, messages.Collected(), 0, failure, restored);
    }

    /// <summary>The most leftover files a reply names (restoredDatabaseSchema in schema.ts holds the same).</summary>
    internal const int MaxFilesLeft = 16;

    /// <summary>What the reply says of files a dropped partly restored database left: SQL Server leaves them after a cancelled RESTORE,
    /// and a later restore to their paths fails (3142) or, here, is refused until they are deleted or other paths are chosen.</summary>
    internal static string LeftoversNote(IReadOnlyList<string> files, bool unknown)
    {
        var named = string.Join(", ", files.Take(3).Select(file => ScriptingErrors.Display(file))) + (files.Count > 3 ? " and " + (files.Count - 3).ToString(CultureInfo.InvariantCulture) + " more" : "");
        return unknown
            ? "Varia could not check whether SQL Server deleted the database's files (" + named + "): if they are still there, delete them, or restore to other paths."
            : "SQL Server left the database's files on disk (" + named + "): delete them, or restore to other paths.";
    }

    /// <summary>Whether a Stop came only as SQL Server finished the last RESTORE WITH RECOVERY (probed: a small restore can end before the
    /// attention does). Only with proof: that RESTORE's own STATS reached 100 percent before the cancel, and the database reads online now.
    /// A Stop that came before the RESTORE was sent (between steps, or while the pools were freed) has no percent, so the database being
    /// online then says nothing of the restore.</summary>
    internal static bool FinishedAtStop(string lastTitle, string recovery, IReadOnlyList<ActionStepDto> steps, RestoredRow? now) =>
        recovery == "recovery" && now is { State: 0 } && steps.Any(step => step.Status == "cancelled" && step.Title == lastTitle && step.Progress == 100);

    /// <summary>The run's preflight in the action's connection (master), before any statement: the destination is the database the
    /// document read (or still absent), not a snapshot, the login may create it, connections are closed only on an online database, a
    /// tail-log backup can be taken, the media hold the planned chain (RestoreChain), a database of another backup is replaced only with
    /// WITH REPLACE, and no file the restore writes (each of the full backup's files where it restores it, the standby file, the tail-log
    /// backup) is another database's file, however the path is spelled, nor a file already on disk that is not the destination's own.</summary>
    /// <summary>What RestoreSql.Preflight reads: the destination's row (null when no database has the name), every database id, and the login's rights.</summary>
    private sealed record PreflightRead(ScriptPreflight.Row? Row, HashSet<int> Ids, bool CanRestore, bool Sysadmin, bool FileViews);

    private async Task<PreflightRead> ReadPreflightAsync(SqlConnection connection, string database, CancellationToken token)
    {
        ScriptPreflight.Row? row = null;
        var ids = new HashSet<int>();
        bool canRestore = false, sysadmin = false, views = false;
        await using var command = connection.CreateCommand();
        command.CommandText = RestoreSql.Preflight;
        command.CommandTimeout = 0;
        Add(command, "@db", SqlDbType.NVarChar, 128, database);
        Add(command, "@take", SqlDbType.Int, 0, (int)Restore.Limit("databases") + 1);
        await using var reader = await command.ExecuteReaderAsync(token);
        if (await reader.ReadAsync(token)) row = ReadRow(reader);
        await reader.NextResultAsync(token);
        while (await reader.ReadAsync(token)) ids.Add(reader.GetInt32(0));
        await reader.NextResultAsync(token);
        if (await reader.ReadAsync(token))
        {
            canRestore = !reader.IsDBNull(0) && reader.GetBoolean(0);
            sysadmin = !reader.IsDBNull(1) && reader.GetBoolean(1);
            views = !reader.IsDBNull(2) && Convert.ToInt32(reader.GetValue(2), CultureInfo.InvariantCulture) > 0;
        }
        return new(row, ids, canRestore, sysadmin, views);
    }

    /// <summary>Whether the preflight's row is the database the document read (DatabaseIdentity), or why not.</summary>
    private ActionError? IdentityProblem(ScriptPreflight.Row? row, DatabaseIdentityDto identity, string database) =>
        row is null || row.Int("database_id") != identity.Id || DatabaseProperties.Iso(row.Raw("create_date")) != identity.Created
            ? Error("NOT_FOUND", "The database " + ScriptingErrors.Display(database) + " is not the one this restore was planned over: it was renamed, dropped or replaced since. Refresh, then check the destination.")
            : null;

    private async Task<(RestoreFacts? Facts, ActionError? Error)> RestorePreflightAsync(SqlConnection connection, ActionArgs args, string database, bool linux, CancellationToken token)
    {
        var display = ScriptingErrors.Display(database);
        var options = args.Restore!;
        var (row, ids, canRestore, sysadmin, views) = await ReadPreflightAsync(connection, database, token);
        if (args.Identity is { } identity)
        {
            if (IdentityProblem(row, identity, database) is { } changed) return (null, changed);
        }
        else if (row is not null) return (null, Error("NAME_IN_USE", "A database named " + display + " was created since the server was read. Refresh, then check the destination."));
        var exists = row is not null;
        if (row is not null && row.Bool("is_snapshot")) return (null, Error("NOT_SUPPORTED", "A database snapshot cannot be restored over."));
        if (!exists && !canRestore) return (null, Error("PERMISSION_DENIED", "You do not have permission to create a database (CREATE ANY DATABASE), which restoring to a new database needs."));
        // SET SINGLE_USER is refused on a database that is not online (5069 on one a stopped restore left RESTORING), which has no
        // connections to close anyway.
        if (row is not null && options.CloseConnections && row.Int("state") != 0)
            return (null, Error("DATABASE_UNAVAILABLE", "The database " + display + " is not online, so it has no connections to close. Clear Close existing connections to destination database."));
        if (options.TailLog is not null)
        {
            if (row is null) return (null, Error("NOT_SUPPORTED", "A tail-log backup needs a database to back up: " + display + " does not exist."));
            if (row.Int("state") != 0) return (null, Error("DATABASE_UNAVAILABLE", "The database " + display + " is not online, so the tail of its log cannot be backed up."));
            // sys.databases.recovery_model: 1 FULL, 2 BULK_LOGGED, 3 SIMPLE.
            if (row.Int("recovery_model") == 3) return (null, Error("NOT_SUPPORTED", "The database " + display + " uses the SIMPLE recovery model, which has no log to back up. Clear Take tail-log backup before restore."));
        }
        var (chain, media) = await RestoreChain.ReadAsync(connection, catalog, options.Sets, token);
        if (chain is null) return (null, media);
        // SQL Server's own check (3154), before Close existing connections or the tail-log backup changes anything.
        if (row is not null && !options.Replace && (!string.Equals(chain.Database, database, StringComparison.OrdinalIgnoreCase)
            || (chain.Family is not null && row.Raw("family_guid") is Guid family && !string.Equals(family.ToString("D"), chain.Family, StringComparison.OrdinalIgnoreCase))))
            return (null, Error("BACKUP_MISMATCH", "The backup set holds a backup of a database other than " + display + ". Check Overwrite the existing database (WITH REPLACE) to restore over it."));
        var facts = new RestoreFacts(exists, row?.Int("database_id") ?? 0, row?.Int("user_access") ?? 0, ids, views, sysadmin);
        var files = await RestoreFilesProblemAsync(connection, database, options, facts, linux, token);
        return files is null ? (facts, null) : (null, files);
    }

    /// <summary>Why a file the restore writes would overwrite what is not the destination's, or null. SQL Server checks none of this
    /// with WITH REPLACE (probed: a Restore As path to an offline database's file spelled with a '.' segment, and a standby file at its
    /// .mdf, both overwrote it), and STANDBY overwrites its undo file even without it.</summary>
    private async Task<ActionError?> RestoreFilesProblemAsync(SqlConnection connection, string database, RestoreOptionsDto options, RestoreFacts facts, bool linux, CancellationToken token)
    {
        // Where the restore writes each of the full backup's files: its Restore As path, or where the backup had it.
        var (listed, media) = await FileListAsync(connection, options.Sets[0], token);
        if (listed is null) return media;
        var written = new List<(string Path, string What)>();
        if (options.Recovery == "standby" && options.StandbyFile is { } standby) written.Add((standby, "standby file"));
        if (options.TailLog is { } tail) written.Add((tail.File, "tail-log backup file"));
        return await WrittenProblemAsync(connection, database, listed, options.Relocate, written, facts, linux, token);
    }

    /// <summary>A file of a backup set as RESTORE FILELISTONLY lists it: Type its letter (D data, L log, S FILESTREAM, F full-text),
    /// Present whether the set holds it (a file backup lists every file of the database).</summary>
    internal sealed record ListedFile(string Logical, string Physical, string Type, string? Filegroup, bool Present);

    /// <summary>The files of a set, read from its media; a media error as a value.</summary>
    private async Task<(List<ListedFile>? Files, ActionError? Error)> FileListAsync(SqlConnection connection, RestorePlanSetDto set, CancellationToken token)
    {
        var listed = new List<ListedFile>();
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = RestoreSql.FileList(set.Devices.Count);
            command.CommandTimeout = 0;
            for (var index = 0; index < set.Devices.Count; index++) Add(command, "@d" + (index + 1).ToString(CultureInfo.InvariantCulture), SqlDbType.NVarChar, 260, set.Devices[index]);
            Add(command, "@file", SqlDbType.Int, 0, set.File);
            await using var reader = await command.ExecuteReaderAsync(token);
            int Column(string name) => reader.GetOrdinal(name);
            var (logical, physical, type, group, present) = (Column("LogicalName"), Column("PhysicalName"), Column("Type"), Column("FileGroupName"), Column("IsPresent"));
            while (await reader.ReadAsync(token))
                if (!reader.IsDBNull(logical) && !reader.IsDBNull(physical))
                    listed.Add(new(reader.GetString(logical), reader.GetString(physical), reader.IsDBNull(type) ? "" : reader.GetString(type).Trim(), reader.IsDBNull(group) ? null : reader.GetString(group),
                        reader.IsDBNull(present) || Convert.ToBoolean(reader.GetValue(present), CultureInfo.InvariantCulture)));
        }
        catch (SqlException error) when (!token.IsCancellationRequested && RestoreDescribe.MediaError(catalog, error, connection) is { } value) { return (null, value); }
        return (listed, null);
    }

    /// <summary>Why a file a restore writes would overwrite what is not the destination's, or null: each of <paramref name="listed"/>
    /// where it goes (its move, or where the backup had it), every move's path, and the other files it writes (a standby file, a log backup).</summary>
    private async Task<ActionError?> WrittenProblemAsync(SqlConnection connection, string database, IReadOnlyList<ListedFile> listed, IReadOnlyList<RestoreMoveDto> relocate,
        IReadOnlyList<(string Path, string What)> written, RestoreFacts facts, bool linux, CancellationToken token)
    {
        var moves = relocate.GroupBy(move => move.Logical, StringComparer.OrdinalIgnoreCase).ToDictionary(group => group.Key, group => group.First().Physical, StringComparer.OrdinalIgnoreCase);
        var targets = listed.Select(file => moves.TryGetValue(file.Logical, out var to) ? to : file.Physical).Concat(relocate.Select(move => move.Physical)).Distinct(StringComparer.Ordinal).ToList();

        // Every database's files, keyed as the files they name.
        var held = new Dictionary<string, string>(StringComparer.Ordinal);
        var own = new HashSet<string>(StringComparer.Ordinal);
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = RestoreSql.ServerFiles;
            command.CommandTimeout = 0;
            Add(command, "@take", SqlDbType.Int, 0, (int)Restore.Limit("serverFiles"));
            await using var reader = await command.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token))
            {
                if (reader.IsDBNull(1) || ServerPath.Key(reader.GetString(1), linux) is not { } key) continue;
                var name = reader.GetString(0);
                if (string.Equals(name, database, StringComparison.OrdinalIgnoreCase)) own.Add(key);
                else held.TryAdd(key, name);
            }
        }
        string Path(string path) => ScriptingErrors.Display(path);
        ActionError NotAPath(string path) => Error("PATH_NOT_FOUND", Path(path) + " is not a full path to a file on this server" + (linux ? " (SQL Server runs on Linux, so paths start with /)." : "."));
        var unknown = new List<string>();
        foreach (var target in targets)
        {
            if (ServerPath.Key(target, linux) is not { } key) return NotAPath(target);
            if (held.TryGetValue(key, out var holder)) return Error("NAME_IN_USE", "The file " + Path(target) + " belongs to the database " + Path(holder) + ". Choose another path on the Files page.");
            if (!own.Contains(key)) unknown.Add(target);
        }
        foreach (var (path, what) in written)
        {
            if (ServerPath.Key(path, linux) is not { } key) return NotAPath(path);
            if (held.TryGetValue(key, out var holder) || own.Contains(key))
                return Error("NAME_IN_USE", "The " + what + " " + Path(path) + " is a file of the database " + Path(holder ?? database) + ". Choose another file.");
            if (DatabaseFile(key)) return Error("NAME_IN_USE", "The " + what + " " + Path(path) + " has a database file's extension (.mdf, .ndf or .ldf). Choose another file.");
        }
        // A Restore As path SQL Server may overwrite (WITH REPLACE) that is on disk but no database's file: a detached database's, one
        // left by a cancelled restore, or another database's under a spelling the key does not resolve (a short name, another share).
        if (await ExistingAsync(connection, unknown, facts, token) is { Count: > 0 } existing)
            return Error("NAME_IN_USE", "The file " + Path(unknown[existing[0]]) + " is already on the server and is not a file of " + Path(database) + ": restoring would overwrite it. Choose another path on the Files page, or delete the file.");
        return null;
    }

    private static bool DatabaseFile(string key) => key.EndsWith(".MDF", StringComparison.OrdinalIgnoreCase) || key.EndsWith(".NDF", StringComparison.OrdinalIgnoreCase) || key.EndsWith(".LDF", StringComparison.OrdinalIgnoreCase);

    /// <summary>Which of <paramref name="paths"/> exist as files, by index; null when the server will not say (SQL Server 2016 without
    /// sysadmin, or a login sys.dm_os_file_exists refuses).</summary>
    private static async Task<List<int>?> ExistingAsync(SqlConnection connection, IReadOnlyList<string> paths, RestoreFacts facts, CancellationToken token)
    {
        if (paths.Count == 0) return [];
        try
        {
            var found = new List<int>();
            if (facts.FileViews)
            {
                await using var command = connection.CreateCommand();
                command.CommandText = RestoreSql.FilesExist;
                command.CommandTimeout = 0;
                Add(command, "@paths", SqlDbType.NVarChar, -1, System.Text.Json.JsonSerializer.Serialize(paths));
                Add(command, "@take", SqlDbType.Int, 0, paths.Count);
                await using var reader = await command.ExecuteReaderAsync(token);
                while (await reader.ReadAsync(token)) found.Add(reader.GetInt32(0));
                return found;
            }
            if (!facts.Sysadmin) return null;
            for (var index = 0; index < paths.Count; index++)
                if ((await ServerFiles.ExistsAsync(connection, ServerFiles.LegacyExists, paths[index], token)).Exists) found.Add(index);
            return found;
        }
        catch (SqlException) when (!token.IsCancellationRequested) { return null; }
    }

    /// <summary>The run's steps in Script's order, then the compensations and the cleanup in the order they must run (RECOVERY before
    /// access). Varia's own pools leave the destination before the first statement that needs it (FreeDatabaseAsync).</summary>
    internal List<RunStep> RestoreSteps(SqlConnection connection, string connectionId, string database, RestoreOptionsDto options, RestoreFacts facts, RestoreLeftovers left)
    {
        var steps = new List<RunStep>();
        var freed = false;
        // Whether a RESTORE may have written to the database: set before each is sent, cleared when SQL Server refused the first
        // while it planned. While it is false, the database is as the steps before left it.
        var touched = false;
        async Task Free(CancellationToken token)
        {
            if (!facts.Exists || freed) return;
            freed = true;
            await FreeDatabaseAsync(connection, connectionId, database, token);
        }
        int? close = null, tail = null;
        if (options.CloseConnections && facts.Exists)
        {
            close = steps.Count;
            steps.Add(new(Restore.Step("close"), async context =>
            {
                await Free(context.Token);
                await RunStatementAsync(connection, ActionSql.Checked(new(ActionTemplate.SetSingleUser, "master", [database])), dryRun: false, context.Token);
            }));
        }
        if (options.TailLog is { } tailLog)
        {
            tail = steps.Count;
            steps.Add(new(Restore.Step("tailLog"), async context =>
            {
                await Free(context.Token);
                await RunMediaAsync(connection, RestoreSql.TailLog(Restore, tailLog.NoRecovery), command =>
                {
                    Add(command, "@db", SqlDbType.NVarChar, 128, database);
                    Add(command, "@tail", SqlDbType.NVarChar, 260, tailLog.File);
                    Add(command, "@tail_name", SqlDbType.NVarChar, 128, RestoreSql.TailName(tailLog.File));
                }, context.Token);
            }, Detail: FileName(tailLog.File)));
        }
        var logs = options.Sets.Count(set => set.Type == "log");
        var logNumber = 0;
        for (var index = 0; index < options.Sets.Count; index++)
        {
            var set = options.Sets[index];
            var last = index == options.Sets.Count - 1;
            var title = set.Type == "log" ? Restore.Step("log") + (logs > 1 ? " " + (++logNumber).ToString(CultureInfo.InvariantCulture) + " of " + logs.ToString(CultureInfo.InvariantCulture) : "")
                : Restore.Step(set.Type);
            var text = RestoreText(Restore, options, index);
            steps.Add(new(title, async context =>
            {
                await Free(context.Token);
                var before = touched;
                touched = true;
                try { await RunMediaAsync(connection, text, command => BindRestore(command, database, set, options, last), context.Token); }
                catch (SqlException error)
                {
                    if (!before && !context.Token.IsCancellationRequested && error.Errors.Cast<SqlError>().Any(item => RefusedBeforeWrite.Contains(item.Number))) touched = false;
                    throw;
                }
            }, Detail: RestoreChain.Where(set) + ", position " + set.File.ToString(CultureInfo.InvariantCulture)));
        }
        if (close is not null && options.Recovery == "recovery" && !options.RestrictedUser)
            steps.Add(new(Restore.Step("multiUser"), context => RunStatementAsync(connection, ActionSql.Checked(new(ActionTemplate.SetMultiUser, "master", [database])), dryRun: false, context.Token)));
        // Compensations, due only while no RESTORE has written to the database (owner decision 5). RECOVERY after the tail-log backup
        // asks SQL Server rather than the step's status: a Stop that reaches the BACKUP LOG only as it finishes marks the step cancelled
        // although the database is RESTORING, so it runs whenever that database (the one the preflight read) reads RESTORING.
        if (tail is { } tailStep && options.TailLog!.NoRecovery)
            steps.Add(new(Restore.Step("recover"), async context =>
            {
                if (await RestoredAsync(connection, database, context.Token) is not { State: 1 } now || now.Id != facts.Id) throw new StepNotDueException();
                await RunMediaAsync(connection, RestoreSql.Recover, command => Add(command, "@db", SqlDbType.NVarChar, 128, database), context.Token);
            }, StepKind.Cleanup, When: statuses => RecoverDue(statuses[tailStep], touched)));
        if (close is { } closeStep && facts.UserAccess != 1)
        {
            var (template, key) = facts.UserAccess == 2 ? (ActionTemplate.SetRestrictedUser, "restrictedUserBack") : (ActionTemplate.SetMultiUser, "multiUserBack");
            steps.Add(new(Restore.Step(key), context => RunStatementAsync(connection, ActionSql.Checked(new(template, "master", [database], StepKind.Compensation)), dryRun: false, context.Token),
                StepKind.Compensation, closeStep, _ => !touched));
        }
        // The cleanup: a database this restore created and left RESTORING, read again right before the DROP, which checks it once more.
        // SQL Server may leave a cancelled RESTORE's files on disk although the DROP removes the database, so they are read first and
        // asked after.
        if (!facts.Exists)
            steps.Add(new(Restore.Step("remove"), async context =>
            {
                var now = await RestoredAsync(connection, database, context.Token);
                if (now is null || now.State != 1 || facts.Ids.Contains(now.Id)) throw new StepNotDueException();
                var files = await FilesOfAsync(connection, now.Id, context.Token);
                await RunStatementAsync(connection, ActionSql.DropRestoring(database, now.Id), dryRun: false, context.Token);
                List<int>? existing;
                try { existing = await ExistingAsync(connection, files, facts, context.Token); }
                catch (OperationCanceledException) { existing = null; }
                (left.Files, left.Unknown) = existing is null ? (files, true) : ([.. existing.Select(index => files[index])], false);
            }, StepKind.Cleanup, When: _ => touched));
        return steps;
    }

    /// <summary>Whether RECOVERY after the tail-log backup may be due: the BACKUP LOG completed or was stopped (it may have finished as Stop
    /// came), and no RESTORE has written to the database since. The step itself then asks SQL Server whether the database is RESTORING.</summary>
    internal static bool RecoverDue(string tailStatus, bool touched) => tailStatus is "done" or "cancelled" && !touched;

    private static async Task<List<string>> FilesOfAsync(SqlConnection connection, int id, CancellationToken token)
    {
        var files = new List<string>();
        await using var command = connection.CreateCommand();
        command.CommandText = RestoreSql.FilesOf;
        command.CommandTimeout = 0;
        Add(command, "@id", SqlDbType.Int, 0, id);
        Add(command, "@take", SqlDbType.Int, 0, 32_767);
        await using var reader = await command.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token)) if (!reader.IsDBNull(0)) files.Add(reader.GetString(0));
        return files;
    }

    /// <summary>The step title of the plan's last set, as RestoreSteps gives it.</summary>
    private string LastSetTitle(RestoreOptionsDto options)
    {
        var last = options.Sets[^1];
        var logs = options.Sets.Count(set => set.Type == "log");
        return last.Type == "log" ? Restore.Step("log") + (logs > 1 ? " " + logs.ToString(CultureInfo.InvariantCulture) + " of " + logs.ToString(CultureInfo.InvariantCulture) : "") : Restore.Step(last.Type);
    }

    /// <summary>The RESTORE of the plan's set at <paramref name="index"/>, with Script's options for its place (RestoreSql.Lines): REPLACE on
    /// the first, NORECOVERY on all but the last, and KEEP_REPLICATION, the recovery state and STOPAT on the last.</summary>
    internal static string RestoreText(RestoreCatalogJson restore, RestoreOptionsDto options, int index)
    {
        var set = options.Sets[index];
        var last = index == options.Sets.Count - 1;
        return RestoreSql.Restore(restore, set.Type == "log", set.Devices.Count, options.Relocate.Count, options.RestrictedUser, last && options.KeepReplication,
            last ? options.Recovery : "norecovery", index == 0 && options.Replace, last && options.StopAt is not null);
    }

    private void BindRestore(SqlCommand command, string database, RestorePlanSetDto set, RestoreOptionsDto options, bool last)
    {
        Add(command, "@db", SqlDbType.NVarChar, 128, database);
        for (var index = 0; index < set.Devices.Count; index++) Add(command, "@d" + (index + 1).ToString(CultureInfo.InvariantCulture), SqlDbType.NVarChar, 260, set.Devices[index]);
        Add(command, "@file", SqlDbType.Int, 0, set.File);
        for (var index = 0; index < options.Relocate.Count; index++)
        {
            var number = (index + 1).ToString(CultureInfo.InvariantCulture);
            Add(command, "@l" + number, SqlDbType.NVarChar, 128, options.Relocate[index].Logical);
            Add(command, "@p" + number, SqlDbType.NVarChar, 260, options.Relocate[index].Physical);
        }
        if (last && options.Recovery == "standby") Add(command, "@standby", SqlDbType.NVarChar, 260, options.StandbyFile);
        if (last && options.StopAt is { } stopAt) Add(command, "@stopat", SqlDbType.DateTime, 0, DateTime.ParseExact(stopAt, "yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture));
    }

    /// <summary>A form 4 statement: always through a reader (ReadAllAsync), so STATS' 3211 messages arrive while it runs.</summary>
    private static async Task RunMediaAsync(SqlConnection connection, string text, Action<SqlCommand> bind, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = text;
        command.CommandTimeout = 0;
        bind(command);
        await ReadAllAsync(command, token);
    }

    internal static async Task<RestoredRow?> RestoredAsync(SqlConnection connection, string database, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = RestoreSql.Restored;
        command.CommandTimeout = 0;
        Add(command, "@db", SqlDbType.NVarChar, 128, database);
        Add(command, "@take", SqlDbType.Int, 0, 1);
        await using var reader = await command.ExecuteReaderAsync(token);
        return await reader.ReadAsync(token) ? new(reader.GetInt32(0), Convert.ToInt32(reader.GetValue(1), CultureInfo.InvariantCulture), Convert.ToInt32(reader.GetValue(2), CultureInfo.InvariantCulture)) : null;
    }

    private static string FileName(string path) => ScriptingErrors.Display(path[(Math.Max(path.LastIndexOf('\\'), path.LastIndexOf('/')) + 1)..]);
}
