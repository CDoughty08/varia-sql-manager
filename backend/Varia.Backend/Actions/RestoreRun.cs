using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>Restore Database's run (actions.execute 'restore', D1f), a long action: the long gate, Stop, progress from STATS, and the
/// shutdown drain. A preflight in the action's own connection (the destination's identity, permission, the tail-log backup's
/// conditions, RestoreChain on the media, WITH REPLACE's case, Restore As paths other databases hold), then runner v2 with the
/// statements Script shows: Close existing connections, the tail-log backup, one RESTORE per set and SET MULTI_USER, each a
/// form 4 statement (RestoreSql) with every name, path, position and time a parameter. After a failure or Stop, Varia undoes only
/// its own changes that no RESTORE has overwritten (owner decision 5): the tail-log backup's RESTORING state and SINGLE_USER, while
/// no RESTORE started; and it removes a database the restore created, only while it is still that RESTORING database (critic
/// A11a). A database that existed is never dropped: a stopped restore leaves it RESTORING, and the reply says so (critic A12).
/// Nothing here logs a name, path or statement.</summary>
internal sealed partial class ActionService
{
    /// <summary>SQL Server's errors that refuse a RESTORE while it plans, before it writes to the database: exclusive access (3101),
    /// another database's backup (3154), a path it cannot restore to (3156, 3119, 5133, 1834), the tail of the log (3159), media it
    /// cannot open or that are incomplete (3201, 3241, 3242, 3132), and sets out of sequence (4305, 4326, 3117). After one of them
    /// on the first RESTORE the database is as the steps before left it, so their compensations are due.</summary>
    internal static readonly IReadOnlySet<int> RefusedBeforeWrite = new HashSet<int> { 3101, 3154, 3156, 3119, 5133, 1834, 3159, 3201, 3241, 3242, 3132, 4305, 4326, 3117 };

    /// <summary>What the preflight read: whether the destination exists and its user access then (0 multi, 1 single, 2 restricted),
    /// and every database id there was, so the cleanup drops only a database this restore created.</summary>
    internal sealed record RestoreFacts(bool Exists, int UserAccess, IReadOnlySet<int> Ids);

    /// <summary>A database as sys.databases has it now.</summary>
    internal sealed record RestoredRow(int Id, int State, int UserAccess);

    private async Task<ActionExecuteResult> ExecuteRestoreJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, bool linux, ActionProgress progress, CancellationToken token)
    {
        var messages = CollectMessages(connection, progress);
        var database = target.Name!;
        var (facts, refused) = await RestorePreflightAsync(connection, args, database, linux, token);
        if (facts is null) return new([], [], 0, refused);
        var options = args.Restore!;
        var (steps, failure, _) = await RunStepsAsync(connection, RestoreSteps(connection, args.ConnectionId, database, options, facts), facts.Exists && !options.CloseConnections ? ActionErrors.CloseConnectionsAdvice : null,
            token, CleanupBudget(args.Action), progress: progress);
        // How the run left the database, read once the steps are over (Stop's token has fired by then, so the read has its own).
        RestoredRow? now = null;
        if (connection.State == ConnectionState.Open)
        {
            using var read = new CancellationTokenSource(Options.StopGrace);
            try { now = await RestoredAsync(connection, database, read.Token); }
            catch (Exception error) when (error is SqlException or OperationCanceledException or InvalidOperationException) { }
        }
        // A Stop that reached SQL Server only as it finished the last RESTORE WITH RECOVERY (probed: a small restore ends before the
        // attention does): the database is restored and online, so the reply says so rather than that SQL Server cancelled it.
        if (failure?.Code == "CANCELLED" && options.Recovery == "recovery" && now is { State: 0 } && steps.Any(step => step.Status == "cancelled" && step.Title == LastSetTitle(options)))
            failure = failure with { Message = Restore.Message("finishedAtStop").Replace("{database}", ScriptingErrors.Display(database), StringComparison.Ordinal) };
        // A database that is not online (RESTORING, or gone) is no connection's database any more.
        if (facts.Exists && now is not { State: 0 }) host.DatabaseChanged(args.ConnectionId, database, null);
        return new(steps, messages.Collected(), 0, failure, now is null ? null : new(now.State, now.UserAccess));
    }

    /// <summary>The run's preflight in the action's connection (master), before any statement: the destination is the database the
    /// document read (or still absent), not a snapshot, the login may create it, a tail-log backup can be taken, the media hold the
    /// planned chain (RestoreChain), a database of another backup is replaced only with WITH REPLACE, and no Restore As path is
    /// another database's file.</summary>
    private async Task<(RestoreFacts? Facts, ActionError? Error)> RestorePreflightAsync(SqlConnection connection, ActionArgs args, string database, bool linux, CancellationToken token)
    {
        var display = ScriptingErrors.Display(database);
        var options = args.Restore!;
        ScriptPreflight.Row? row = null;
        var ids = new HashSet<int>();
        var canRestore = false;
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = RestoreSql.Preflight;
            command.CommandTimeout = 0;
            Add(command, "@db", SqlDbType.NVarChar, 128, database);
            Add(command, "@take", SqlDbType.Int, 0, (int)Restore.Limit("databases") + 1);
            await using var reader = await command.ExecuteReaderAsync(token);
            if (await reader.ReadAsync(token)) row = ReadRow(reader);
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token)) ids.Add(reader.GetInt32(0));
            await reader.NextResultAsync(token);
            if (await reader.ReadAsync(token)) canRestore = !reader.IsDBNull(0) && reader.GetBoolean(0);
        }
        if (args.Identity is { } read)
        {
            if (row is null || row.Int("database_id") != read.Id || DatabaseProperties.Iso(row.Raw("create_date")) != read.Created)
                return (null, Error("NOT_FOUND", "The database " + display + " is not the one this restore was planned over: it was renamed, dropped or replaced since. Refresh, then check the destination."));
        }
        else if (row is not null) return (null, Error("NAME_IN_USE", "A database named " + display + " was created since the server was read. Refresh, then check the destination."));
        var exists = row is not null;
        if (row is not null && row.Bool("is_snapshot")) return (null, Error("NOT_SUPPORTED", "A database snapshot cannot be restored over."));
        if (!exists && !canRestore) return (null, Error("PERMISSION_DENIED", "You do not have permission to create a database (CREATE ANY DATABASE), which restoring to a new database needs."));
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
        if (options.Relocate.Count > 0)
        {
            var paths = options.Relocate.Select(move => move.Physical).ToHashSet(linux ? StringComparer.Ordinal : StringComparer.OrdinalIgnoreCase);
            await using var command = connection.CreateCommand();
            command.CommandText = RestoreSql.ServerFiles;
            command.CommandTimeout = 0;
            Add(command, "@take", SqlDbType.Int, 0, (int)Restore.Limit("serverFiles"));
            await using var reader = await command.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token))
                if (!reader.IsDBNull(1) && paths.Contains(reader.GetString(1)) && !string.Equals(reader.GetString(0), database, StringComparison.OrdinalIgnoreCase))
                    return (null, Error("NAME_IN_USE", "The file " + ScriptingErrors.Display(reader.GetString(1)) + " belongs to the database " + ScriptingErrors.Display(reader.GetString(0)) + ". Choose another path on the Files page."));
        }
        return (new(exists, row?.Int("user_access") ?? 0, ids), null);
    }

    /// <summary>The run's steps in Script's order, then the compensations (in the order they must run: RECOVERY before access) and
    /// the cleanup. Varia's own pools leave the destination before the first statement that needs it (FreeDatabaseAsync).</summary>
    private List<RunStep> RestoreSteps(SqlConnection connection, string connectionId, string database, RestoreOptionsDto options, RestoreFacts facts)
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
        // Compensations, due only while no RESTORE has written to the database (owner decision 5).
        if (tail is { } tailStep && options.TailLog!.NoRecovery)
            steps.Add(new(Restore.Step("recover"), context => RunMediaAsync(connection, RestoreSql.Recover, command => Add(command, "@db", SqlDbType.NVarChar, 128, database), context.Token),
                StepKind.Compensation, tailStep, _ => !touched));
        if (close is { } closeStep && facts.UserAccess != 1)
        {
            var (template, key) = facts.UserAccess == 2 ? (ActionTemplate.SetRestrictedUser, "restrictedUserBack") : (ActionTemplate.SetMultiUser, "multiUserBack");
            steps.Add(new(Restore.Step(key), context => RunStatementAsync(connection, ActionSql.Checked(new(template, "master", [database], StepKind.Compensation)), dryRun: false, context.Token),
                StepKind.Compensation, closeStep, _ => !touched));
        }
        // The cleanup: a database this restore created and left RESTORING, read again right before the DROP, which checks it once more.
        if (!facts.Exists)
            steps.Add(new(Restore.Step("remove"), async context =>
            {
                var now = await RestoredAsync(connection, database, context.Token);
                if (now is null || now.State != 1 || facts.Ids.Contains(now.Id)) throw new StepNotDueException();
                await RunStatementAsync(connection, ActionSql.DropRestoring(database, now.Id), dryRun: false, context.Token);
            }, StepKind.Cleanup, When: _ => touched));
        return steps;
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
