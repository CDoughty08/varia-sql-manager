using System.Data;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>One database the mapped-user scan listed, and whether it read the users there (Login Properties' User Mapping, D2c,
/// shows a row it did not read as "Not read"; a login's Delete with its users refuses to run while one is unread).</summary>
internal sealed record ScannedDatabase(string Name, bool ReadOnly, bool Checked);

/// <summary>The mapped-user scan's answer: at most its list bound of users, how many it found in all (Mapped), every database it
/// listed, and how many it left out of the list (offline, restoring, not accessible or readable, past the scan's bound).</summary>
internal sealed record LoginScan(List<MappedUserDto> Users, int Mapped, List<ScannedDatabase> Databases, int NotListed)
{
    public int Checked => Databases.Count(database => database.Checked);
    public int NotChecked => NotListed + Databases.Count(database => !database.Checked);
    public LoginMappingsDto Dto => new(Users, Mapped, Checked, NotChecked);
}

/// <summary>A login's Delete (D4c): Delete Object's describe of a login (its facts, what it owns, and the database users mapped to
/// it), Script Action, and the execute that drops the mapped users it may (when asked) and then the login, after a preflight that
/// refuses, before any DDL, a login that is not the one the dialog read, the rules' refusals, and what SQL Server would refuse the
/// DROP for (sessions, owned databases, jobs, server roles, endpoints and availability groups, granted permissions); with its users,
/// also sessions it cannot count and databases it could not read again, so no predictable refusal of the DROP comes after the users
/// are gone. Not one transaction: DROP USER in several databases would hold locks in all of them until the end, and every partial
/// outcome (some users gone, the login kept) is coherent. Each DROP checks, in its own batch, the principal it was planned for.</summary>
internal sealed partial class ActionService
{
    /// <summary>Whether a Delete that drops the mapped users keeps this one: DROP USER fails while it owns a schema (15138), a role
    /// (15421) or another securable (15138, 15183), or has granted permissions (15284), cannot run in a read-only database, and needs
    /// ALTER ANY USER there (logins.ts mappedUserKept).</summary>
    internal static bool Kept(MappedUserDto user) => user.OwnedSchemas > 0 || user.OwnedRoles > 0 || user.OwnedSecurables > 0 || user.GrantedPermissions > 0 || user.ReadOnly || !user.CanDrop;

    /// <summary>How long the scan reads databases before it counts the rest as not checked: the catalogue's scanMs, or the live
    /// checks' own.</summary>
    private TimeSpan ScanBudget => Options.ScanBudget ?? TimeSpan.FromMilliseconds(catalog.Logins.Limit("scanMs"));

    /// <summary>The per-database scan (D4c; Login Properties reuses it, D2c): the users mapped to a SID in every database the
    /// login can read (ActionSql.LoginDatabases, at most loginLimits.scanDatabases), one call per database (ActionSql.MappedUserCall)
    /// under the caller's isolation and lock timeout, listing at most <paramref name="list"/> users. A database whose read fails
    /// (a lock timeout, a database that went offline, no access after all) is not checked, as are those left once
    /// <paramref name="budget"/> has passed: values, never the request's failure. Only the job's own token ends the scan.</summary>
    internal async Task<LoginScan> ScanMappedUsersAsync(SqlConnection connection, byte[] sid, int list, TimeSpan budget, CancellationToken token)
    {
        var (users, mapped, databases, notListed) = await ScanAsync(connection, sid, ActionSql.MappedUser, list, budget, token, (name, readOnly, canDrop, reader) =>
        {
            int Count(int ordinal) => reader.IsDBNull(ordinal) ? 0 : Convert.ToInt32(reader.GetValue(ordinal), CultureInfo.InvariantCulture);
            return new MappedUserDto(name, reader.GetString(0), Count(1), Count(2), readOnly, Count(3), Count(4), canDrop);
        });
        return new(users, mapped, databases, notListed);
    }

    /// <summary>The scan itself, with the statement it runs in each database (through ActionSql.MappedUserCall, which binds @sid and
    /// @take) and how a row becomes a user: Delete's ActionSql.MappedUser, or Login Properties' LoginSql.PropertiesMappedUser (D2c).</summary>
    private async Task<(List<T> Users, int Mapped, List<ScannedDatabase> Databases, int NotListed)> ScanAsync<T>(SqlConnection connection, byte[] sid, string statement, int list,
        TimeSpan budget, CancellationToken token, Func<string, bool, bool, SqlDataReader, T> project)
    {
        var listed = new List<(string Name, bool ReadOnly, bool CanDrop)>();
        var total = 0;
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = ActionSql.LoginDatabases;
            command.CommandTimeout = 0;
            Add(command, "@take", SqlDbType.Int, 0, (int)catalog.Logins.Limit("scanDatabases"));
            await using var reader = await command.ExecuteReaderAsync(token);
            // The total first, apart from the rows: a connection that may read no database still counts every one as not checked.
            if (await reader.ReadAsync(token)) total = Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture);
            if (await reader.NextResultAsync(token))
                while (await reader.ReadAsync(token)) listed.Add((reader.GetString(0), !reader.IsDBNull(1) && reader.GetBoolean(1), !reader.IsDBNull(2) && reader.GetBoolean(2)));
        }
        var users = new List<T>();
        var databases = new List<ScannedDatabase>(listed.Count);
        var mapped = 0;
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
        limit.CancelAfter(budget);
        foreach (var (name, readOnly, canDrop) in listed)
        {
            var found = new List<T>();
            var read = false;
            if (!limit.IsCancellationRequested)
            {
                try
                {
                    await using var command = connection.CreateCommand();
                    command.CommandText = ActionSql.MappedUserCall;
                    command.CommandTimeout = 0;
                    Add(command, "@db", SqlDbType.NVarChar, 128, name);
                    Add(command, "@stmt", SqlDbType.NVarChar, -1, statement);
                    Add(command, "@sid", SqlDbType.VarBinary, 85, sid);
                    Add(command, "@take", SqlDbType.Int, 0, list + 1);
                    await using var reader = await command.ExecuteReaderAsync(limit.Token);
                    while (await reader.ReadAsync(limit.Token)) found.Add(project(name, readOnly, canDrop, reader));
                    read = true;
                }
                catch (Exception error) when (!token.IsCancellationRequested && error is SqlException or OperationCanceledException or InvalidOperationException) { }
            }
            if (read)
                foreach (var user in found)
                {
                    mapped++;
                    if (users.Count < list) users.Add(user);
                }
            databases.Add(new(name, readOnly, read));
        }
        return (users, mapped, databases, Math.Max(0, total - listed.Count));
    }

    /// <summary>The SQL Server Agent jobs a login owns (ActionSql.LoginJobs), or null when msdb's job table cannot be read.</summary>
    private static async Task<int?> LoginJobsAsync(SqlConnection connection, byte[] sid, CancellationToken token)
    {
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = ActionSql.LoginJobs;
            command.CommandTimeout = 0;
            Add(command, "@sid", SqlDbType.VarBinary, 85, sid);
            var value = await command.ExecuteScalarAsync(token);
            return value is null or DBNull ? null : Convert.ToInt32(value, CultureInfo.InvariantCulture);
        }
        catch (SqlException) when (!token.IsCancellationRequested) { return null; }
    }

    private static byte[] SidBytes(LoginFactsDto facts) => Convert.FromHexString(facts.Sid);

    private static string Count(int value, string one, string many) => value.ToString("N0", CultureInfo.InvariantCulture) + " " + (value == 1 ? one : many);

    /// <summary>What Delete Object warns about a login (D4 §5.4): what SQL Server refuses the DROP for (blocking: the sessions
    /// connected as it, 15434; the databases it owns, 15174; its Agent jobs, 15170; the server roles, endpoints and availability
    /// groups it owns, 15141; the server permissions it granted to others, 15173), and the service that runs as it. The execute's
    /// preflight refuses with the same texts.</summary>
    internal static List<ActionWarningDto> LoginDeleteWarnings(LoginFactsDto facts, string? service)
    {
        var warnings = new List<ActionWarningDto>();
        if (facts.Sessions is > 0 and var sessions) warnings.Add(new(SessionsWarning(sessions), true));
        if (facts.OwnedDatabases is > 0 and var databases) warnings.Add(new(OwnedDatabasesWarning(databases, facts.OwnedDatabaseNames), true));
        if (facts.OwnedJobs is > 0 and var jobs) warnings.Add(new(JobsWarning(jobs), true));
        if (facts.OwnedServerObjects is > 0 and var objects) warnings.Add(new(ServerObjectsWarning(objects), true));
        if (facts.GrantedPermissions is > 0 and var granted) warnings.Add(new(GrantedWarning(granted), true));
        if (service is not null) warnings.Add(new(ScriptingErrors.Display(service) + " runs as this account.", false));
        return warnings;
    }

    internal static string SessionsWarning(int sessions) => sessions == 1
        ? "1 session is connected as this login; the DROP fails until it ends. Activity Monitor can end it."
        : sessions.ToString("N0", CultureInfo.InvariantCulture) + " sessions are connected as this login; the DROP fails until they end. Activity Monitor can end them.";

    internal static string OwnedDatabasesWarning(int count, IReadOnlyList<string> names)
    {
        var shown = string.Join(", ", names.Select(ScriptingErrors.Display));
        var more = count - names.Count;
        if (count == 1 && names.Count == 1) return "Owns the database " + shown + "; the DROP fails until its owner is changed.";
        return "Owns " + Count(count, "database", "databases") + (names.Count > 0 ? " (" + shown + (more > 0 ? " and " + more.ToString("N0", CultureInfo.InvariantCulture) + " more" : "") + ")" : "")
            + "; the DROP fails until their owner is changed.";
    }

    internal static string JobsWarning(int jobs) => jobs == 1
        ? "Owns 1 SQL Server Agent job; the DROP fails until it is reassigned or deleted."
        : "Owns " + Count(jobs, "SQL Server Agent job", "SQL Server Agent jobs") + "; the DROP fails until they are reassigned or deleted.";

    internal static string ServerObjectsWarning(int objects) => objects == 1
        ? "Owns 1 server role, endpoint or availability group; the DROP fails until it is reassigned."
        : "Owns " + Count(objects, "server role, endpoint or availability group", "server roles, endpoints or availability groups") + "; the DROP fails until they are reassigned.";

    internal static string GrantedWarning(int permissions) => permissions == 1
        ? "Has granted 1 server permission to another principal; the DROP fails until it is revoked."
        : "Has granted " + Count(permissions, "server permission", "server permissions") + " to other principals; the DROP fails until they are revoked.";

    /// <summary>Why a Delete that drops the mapped users stops before any DDL when its own scan could not read databases the describe
    /// may have listed users in: their users would be left orphaned while the login went.</summary>
    internal static string UnreadDatabases(int count) => (count == 1 ? "1 database could not be read again" : count.ToString("N0", CultureInfo.InvariantCulture) + " databases could not be read again")
        + ", so the database users mapped to the login there would be left orphaned. Try again, or delete the login without its users.";

    /// <summary>Why a Delete that drops the mapped users stops before any DDL when more are mapped than it lists and plans.</summary>
    internal string TooManyMappedUsers => "The login is mapped to more than " + catalog.Logins.Limit("mappedUsers").ToString("N0", CultureInfo.InvariantCulture)
        + " database users. Delete them in each database first, or delete the login without them.";

    /// <summary>The login's facts as Delete Object shows them, read past other sessions' uncommitted changes (they only advise; the
    /// execute's preflight reads the login itself under READ COMMITTED): the full preflight (what it owns, at most
    /// loginLimits.ownedDatabases names), its Agent jobs and service, and, when <paramref name="scan"/>, the mapped users.</summary>
    private async Task<(LoginFactsDto? Facts, string? Name, string? Service, LoginScan? Scan)> LoginDeleteFactsAsync(SqlConnection connection, string name, bool scan, CancellationToken token)
    {
        await RunAsync(connection, ActionSql.FactsIsolation, token);
        var (facts, row) = await LoginAsync(connection, name, null, (int)catalog.Logins.Limit("ownedDatabases"), token);
        if (facts is null) return (null, null, null, null);
        var sid = SidBytes(facts);
        var actual = row!.Text("name") ?? name;
        facts = facts with { OwnedJobs = await LoginJobsAsync(connection, sid, token) };
        var service = facts.Type == "U" ? await LoginServiceAsync(connection, actual, token) : null;
        var users = scan ? await ScanMappedUsersAsync(connection, sid, (int)catalog.Logins.Limit("mappedUsers"), ScanBudget, token) : null;
        return (facts, actual, service, users);
    }

    private ActionError LoginGone(ObjectRefDto target) => Error("NOT_FOUND", "The login " + Display(target) + " no longer exists. Refresh Object Explorer.");

    /// <summary>Delete Object's describe of a login: its row (Object Type "Login"), the warnings, its facts with what it owns, and
    /// the database users mapped to it.</summary>
    private async Task<ActionDescribeResult> DescribeLoginDeleteAsync(SqlConnection connection, ObjectRefDto target, CancellationToken token)
    {
        var (facts, name, service, scan) = await LoginDeleteFactsAsync(connection, target.Name!, scan: true, token);
        if (facts is null) return new(null, 0, LoginGone(target));
        var deleted = new DeleteTargetDto(ScriptingErrors.Display(name!), Title(target), null, LoginDeleteWarnings(facts, service), false, Login: facts with { Service = service }, Mappings: scan!.Dto);
        return new(deleted, 0);
    }

    /// <summary>Script Action: the statements a success runs (DROP USER per mapped user it may drop, when asked, then DROP LOGIN in
    /// master), with the blocking warnings. Runs nothing.</summary>
    private async Task<ActionScriptResult> ScriptLoginDeleteAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, CancellationToken token)
    {
        var (facts, name, service, scan) = await LoginDeleteFactsAsync(connection, target.Name!, scan: args.DropMappedUsers == true, token);
        if (facts is null) return new(null, "master", [], LoginGone(target));
        if (scan is not null && scan.Mapped > scan.Users.Count) return new(null, "master", [], Error("NOT_SUPPORTED", TooManyMappedUsers));
        var text = ScriptText(Plan(args, target with { Name = name }, users: scan?.Users));
        if (text.Length > ScriptLimit(args.Action)) return new(null, "master", [], Error("SQL_ERROR", "The script is too large."));
        return new(text, "master", [.. LoginDeleteWarnings(facts, service).Where(warning => warning.Blocking).Take(8).Select(warning => warning.Text)]);
    }

    /// <summary>The execute: the login read again under READ COMMITTED (its identity and the rules), then, read past other sessions'
    /// changes under the read lock timeout, what blocks the DROP and the mapped users; any blocker refuses before DDL. The DDL then
    /// runs with the execute's own settings: the users, then the login, each DROP bound to the principal it was planned for (a read past
    /// an open change may name a principal that is not the login's, which that check refuses).</summary>
    private async Task<ActionExecuteResult> ExecuteLoginDeleteAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, CancellationToken token)
    {
        var messages = CollectMessages(connection);
        var (subject, error) = await ResolveAsync(connection, target, args.Action, null, band, 0, token);
        if (subject is null) return new([], [], 0, error);
        if (Refusal(subject, args) is { } refused) return new([], [], 0, refused);
        var read = subject.Login!;
        await RunAsync(connection, ActionSql.ReadPrologue, token);
        var (facts, _, _, scan) = await LoginDeleteFactsAsync(connection, subject.Target.Name!, scan: args.DropMappedUsers == true, token);
        if (facts is null || !string.Equals(facts.Sid, read.Sid, StringComparison.Ordinal) || facts.PrincipalId != read.PrincipalId || subject.Row.Raw("create_date") is not DateTime created)
            return new([], [], 0, Error("NOT_FOUND", "The login " + subject.Display + " changed while it was read. Refresh Object Explorer and try again."));
        if (facts.Sessions is > 0 and var sessions) return new([], [], 0, Error("IN_USE", SessionsWarning(sessions)), sessions);
        var dependents = LoginDeleteWarnings(facts, null).Where(warning => warning.Blocking).Select(warning => warning.Text).ToList();
        if (dependents.Count > 0) return new([], [], 0, Error("DEPENDENTS", string.Join(" ", dependents)), facts.Sessions);
        if (scan is not null)
        {
            // Users go first, so nothing the preflight cannot see may fail the login's DROP after them: a session it cannot count
            // (15434), or a database it could not read again, whose users would stay orphaned while the reply said success.
            if (facts.Sessions is null) return new([], [], 0, Error("NOT_SUPPORTED", catalog.Logins.Message("sessionsUncounted")));
            if (scan.Databases.Count(database => !database.Checked) is > 0 and var unread) return new([], [], 0, Error("BLOCKED", UnreadDatabases(unread)), facts.Sessions);
            if (scan.Mapped > scan.Users.Count) return new([], [], 0, Error("NOT_SUPPORTED", TooManyMappedUsers), facts.Sessions);
        }
        await RunAsync(connection, ActionSql.ExecutePrologue, token);
        var plan = Plan(args, subject.Target, users: scan?.Users, login: new(SidBytes(facts), facts.PrincipalId, created));
        var (steps, failure, _) = await RunPlannedAsync(connection, args.ConnectionId, args.Action, plan, ActionErrors.LoginSessionsAdvice, token);
        if (failure is { Code: "PERMISSION_DENIED" }) failure = Error(failure.Code, failure.Message + " " + ActionErrors.LoginPermissionAdvice);
        return new(steps, messages.Collected(), 0, failure, facts.Sessions);
    }
}
