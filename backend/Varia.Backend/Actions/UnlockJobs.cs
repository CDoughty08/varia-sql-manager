using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>Unlock Login (D4d, owner decision 9): keeps the login's password and unlocks it the way Learn documents, turning the
/// password policy off and back on (with expiration, when the login had it) in one transaction, which also clears the password
/// history. Its describe, script and execute read the login's facts (ActionSql.LoginAlter) and then its lock-out state
/// (ActionSql.LoginLock, the one LOGINPROPERTY reader) in the action's own connection; the execute reads both again inside its
/// transaction, just before the first statement, since the plan depends on them and no read holds the login until it.</summary>
internal sealed partial class ActionService
{
    /// <summary>What a failed or stopped Unlock adds: runner v2's transaction mode rolled both statements back.</summary>
    public const string UnlockRolledBack = "SQL Server rolled back the transaction, so the login and its password policy are as they were.";

    /// <summary>Unlock's statements, in master: CHECK_POLICY = OFF, which unlocks the login and turns expiration off too (D4 P12),
    /// then CHECK_POLICY = ON, with CHECK_EXPIRATION = ON when the login had it (P13).</summary>
    internal static List<PlannedStatement> UnlockPlan(string login, bool expiration) =>
    [
        new(ActionTemplate.CheckPolicyOff, "master", [login]),
        new(expiration ? ActionTemplate.CheckPolicyExpirationOn : ActionTemplate.CheckPolicyOn, "master", [login])
    ];

    /// <summary>The login's lock-out state (ActionSql.LoginLock) by the name the catalog holds. LOGINPROPERTY answers NULL for a
    /// property a login does not have (a Windows login's lock-out), which reads as not locked.</summary>
    private static async Task<LoginLockFactsDto> LoginLockAsync(SqlConnection connection, string name, CancellationToken token, SqlTransaction? transaction = null)
    {
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = ActionSql.LoginLock;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, name);
        await using var reader = await command.ExecuteReaderAsync(token);
        var row = await reader.ReadAsync(token) ? ReadRow(reader) : new ScriptPreflight.Row(new Dictionary<string, object?>());
        var locked = row.Int("is_locked") == 1;
        int? Count(string column) => row.Long(column) is { } value ? (int)Math.Clamp(value, 0, int.MaxValue) : null;
        return new(locked, Count("bad_passwords"), locked && DatabaseProperties.Iso(row.Raw("lockout_time")) is { Length: > 0 } time ? time : null, row.Int("must_change") == 1,
            row.Int("is_expired") == 1, row.Long("days_until_expiration") is { } days ? (int)Math.Clamp(days, int.MinValue, int.MaxValue) : null);
    }

    /// <summary>The live checks' only way to read a login's lock-out state as Unlock does, in the action's own connection.</summary>
    internal async Task<LoginLockFactsDto> LoginLockFactsAsync(string connectionId, string name, CancellationToken token)
    {
        await using var connection = host.Connection(connectionId);
        await host.OpenAsync(connection, token);
        await RunAsync(connection, ActionSql.ReadPrologueOf(Options.ReadLockTimeoutMs), token);
        return await LoginLockAsync(connection, name, token);
    }

    /// <summary>Unlock…'s describe: the login's facts without what it owns, and its lock-out state. Behind another session's open
    /// change to the login both wait, and the read lock timeout answers BLOCKED as a value.</summary>
    private async Task<ActionDescribeResult> DescribeUnlockJobAsync(SqlConnection connection, ObjectRefDto target, CancellationToken token)
    {
        var (facts, row) = await LoginAsync(connection, target.Name!, null, null, token);
        if (facts is null) return new(null, 0, Error("NOT_FOUND", "The login " + Display(target) + " no longer exists. Refresh Object Explorer."));
        var state = await LoginLockAsync(connection, row!.Text("name") ?? target.Name!, token);
        return new(null, 0, Login: facts, Lock: state);
    }

    /// <summary>Script Action: the transaction as one batch. It is refused where running it would change the login rather than
    /// unlock it (no password policy) or fail (must change its password), but not because the login is not locked out now.</summary>
    private async Task<ActionScriptResult> ScriptUnlockJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, CancellationToken token)
    {
        var (subject, error) = await ResolveAsync(connection, target, args.Action, null, band, 0, token);
        if (subject is null) return new(null, "master", [], error);
        var state = await LoginLockAsync(connection, subject.Target.Name!, token);
        if (LoginRules.UnlockRefusal(subject.Login!, state, script: true) is { } refused) return new(null, "master", [], Error("NOT_SUPPORTED", catalog.Logins.Message(refused)));
        return new(ActionSql.TransactionScriptText(UnlockPlan(subject.Target.Name!, subject.Login!.ExpirationChecked == true)), "master", []);
    }

    /// <summary>Why Unlock's transaction must stop before its first statement, or null: the login read again there (<paramref name="now"/>,
    /// with its lock-out state) is gone, is not the principal the plan was built for, is refused now, or no longer has the
    /// expiration setting the plan turns back on. Catalog reads and LOGINPROPERTY hold no lock on the login (probed: a REPEATABLE
    /// READ or SERIALIZABLE read in an open transaction does not block another session's ALTER LOGIN), so a change committed after
    /// the preflight, or while its LoginLock read waited behind another session's open change, would otherwise be undone by the
    /// stale plan (CHECK_POLICY = OFF also turns expiration off) or clear the history of a login already unlocked.</summary>
    internal ActionError? UnlockRecheck(ActionArgs args, LoginFactsDto planned, LoginFactsDto? now, LoginLockFactsDto state)
    {
        if (now is null) return Error("NOT_FOUND", "The login " + ScriptingErrors.Display(args.Target.Name!) + " no longer exists. Refresh Object Explorer.");
        if (now.PrincipalId != planned.PrincipalId || !string.Equals(now.Sid, planned.Sid, StringComparison.Ordinal) || !string.Equals(now.Created, planned.Created, StringComparison.Ordinal))
            return Error("NOT_FOUND", "The login " + ScriptingErrors.Display(args.Target.Name!) + " is not the one that was read: it was renamed, dropped or replaced since. Refresh Object Explorer and try again.");
        if (LoginRefusal(now, args) is { } refused) return refused;
        if (LoginRules.UnlockRefusal(now, state) is { } id) return Error("NOT_SUPPORTED", catalog.Logins.Message(id));
        return now.PolicyChecked != planned.PolicyChecked || now.ExpirationChecked != planned.ExpirationChecked ? Error("NOT_SUPPORTED", catalog.Logins.Message("unlockChanged")) : null;
    }

    /// <summary>Unlock: the preflight (the identity the dialog read, the login's rules, then its lock-out state read again), then
    /// both statements and the commit through runner v2's transaction mode, so a failure or Stop rolls them back. The first step
    /// reads the login's facts and lock-out state again in the transaction and refuses (UnlockRecheck) before its statement when
    /// they no longer fit the plan.</summary>
    private async Task<ActionExecuteResult> ExecuteUnlockJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, CancellationToken token)
    {
        var messages = CollectMessages(connection);
        var (subject, error) = await ResolveAsync(connection, target, args.Action, null, band, 0, token);
        if (subject is null) return new([], [], 0, error);
        if (Refusal(subject, args) is { } refused) return new([], [], 0, refused);
        var state = await LoginLockAsync(connection, subject.Target.Name!, token);
        if (LoginRules.UnlockRefusal(subject.Login!, state) is { } id) return new([], [], 0, Error("NOT_SUPPORTED", catalog.Logins.Message(id)));
        var plan = UnlockPlan(subject.Target.Name!, subject.Login!.ExpirationChecked == true).Select(ActionSql.Checked).ToList();
        var planned = subject.Login!;
        async Task Recheck(StepContext context)
        {
            var (now, _) = await LoginAsync(connection, subject.Target.Name!, null, null, context.Token, context.Transaction);
            var state = now is null ? null : await LoginLockAsync(connection, subject.Target.Name!, context.Token, context.Transaction);
            if (UnlockRecheck(args, planned, now, state ?? new(false, null, null, false, false, null)) is { } changed) throw new StepRefusedException(changed);
        }
        var run = plan.Select((statement, index) => new RunStep(StepTitle(statement.Template), async context =>
        {
            if (index == 0) await Recheck(context);
            await RunStatementAsync(connection, statement, dryRun: false, context.Token, context.Transaction);
        })).ToList();
        var (steps, failure, _) = await RunStepsAsync(connection, run, null, token, CleanupBudget(args.Action), transaction: true, rolledBack: UnlockRolledBack);
        // 15151 says "does not exist or you do not have permission"; for a login the preflight found, it is the permission.
        if (failure is { Code: "PERMISSION_DENIED" }) failure = Error(failure.Code, failure.Message + " " + ActionErrors.LoginPermissionAdvice);
        return new(steps, messages.Collected(), 0, failure);
    }
}
