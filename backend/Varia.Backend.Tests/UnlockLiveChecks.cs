using System.Diagnostics;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live checks of Unlock Login (PR D4d). Without scratch objects: LoginLock runs on this server, read for the login this
/// connection uses (which changes nothing). With VARIA_TEST_SQL_SCRATCH=1, on the run's own scratch SQL logins only: a login without
/// the password policy, one that is not locked out and one that must change its password are refused before any DDL, and SQL
/// Server's own answer for the last (15128) is settled in a rolled-back transaction; behind another session's open change to the
/// login the describe answers BLOCKED after a short read lock timeout and the execute waits until Stop, which changes nothing.
/// Then each policy login is locked out by failed sign-ins; where the server applies no lockout policy (SQL Server on Linux
/// without one) those checks are skipped with a note. Locked: Script runs nothing, and Unlock keeps the password (it signs in
/// again) and the policy, with expiration exactly when the login had it. Every scratch login is dropped in finally.</summary>
internal static class UnlockLiveChecks
{
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    /// <summary>One more than Windows' default lockout threshold (10 invalid attempts).</summary>
    private const int BadSignIns = 11;

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        async Task<T> Call<T>(string method, object args, RequestContext? context = null) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json, context);
        async Task<SqlRun> InSession(string session, string text)
        {
            var result = await Call<QueryResult>("query.execute", new QueryArgs(info.Id, session, "master", text, Guid.NewGuid().ToString(), 100_000, 60, StopOnError: true));
            return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
        }
        async Task<SqlRun> Sql(string text, string database = "master")
        {
            var session = Guid.NewGuid().ToString();
            try { return await InSession(session, database == "master" ? text : "USE " + Bracket(database) + ";\n" + text); }
            finally { await Call<object>("query.session.close", new SessionArgs(session)); }
        }
        ObjectRefDto Login(string name) => new("login", Name: name);
        Task<ActionDescribeResult> Describe(string name) => Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "unlockLogin", Login(name)));
        ActionArgs Unlock(string name, LoginIdentityDto? identity = null) => new("unlock", info.Id, Guid.NewGuid().ToString(), Login(name), LoginIdentity: identity, Mode: "keepPassword");
        Task<ActionExecuteResult> Execute(string name, LoginIdentityDto? identity = null, RequestContext? context = null) => Call<ActionExecuteResult>("actions.execute", Unlock(name, identity), context);
        static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title));
        var words = service.Actions.Catalog.Logins;

        // LoginLock's constant text runs here, for the login this connection uses (Windows logins answer NULL: not locked).
        var own = (await Sql("SELECT SUSER_SNAME();")).Scalar ?? "";
        var ownLock = await service.Actions.LoginLockFactsAsync(info.Id, own, CancellationToken.None);
        check(!ownLock.Locked && ownLock.LockoutTime is null, "LoginLock reads this connection's own login, which is not locked out");

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Unlock scratch checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping uniquely named logins on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        if (!await scratch.CreateLoginAsync())
        {
            Console.WriteLine("Unlock scratch checks skipped: the server accepts Windows logins only.");
            return;
        }
        // The base scratch login has no password policy. _lk enforces the policy and expiration, _lp the policy only, and _lm must
        // change its password.
        var noPolicy = scratch.Login!;
        var expiring = noPolicy + "_lk";
        var policyOnly = noPolicy + "_lp";
        var mustChange = noPolicy + "_lm";
        string NewPassword() => "Vx9!" + Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(12));
        var passwords = new Dictionary<string, string> { [expiring] = NewPassword(), [policyOnly] = NewPassword(), [mustChange] = NewPassword() };
        var connectivity = ConnectionSettings.Build(live("master")).ConnectionString;
        async Task<int> SignIn(string name, string password)
        {
            // Unpooled, so each attempt is a new sign-in. 0: signed in; otherwise SQL Server's error number (18456 a failed sign-in, which
            // is all SQL Server 2025 tells a client even when the login is locked out; 18486 locked out where the server says so).
            var builder = new SqlConnectionStringBuilder(connectivity) { IntegratedSecurity = false, UserID = name, Password = password, Pooling = false, ConnectTimeout = 30, ApplicationName = "Varia checks" };
            try
            {
                await using var connection = new SqlConnection(builder.ConnectionString);
                await connection.OpenAsync();
                return 0;
            }
            catch (SqlException error) { return error.Number; }
        }
        async Task<(bool Policy, bool Expiration)> Policy(string name) =>
            (await Sql("SELECT CONVERT(int, is_policy_checked), CONVERT(int, is_expiration_checked) FROM sys.sql_logins WHERE name = " + Literal(name) + ";")).Sets is [[[{ } policy, { } expiration], ..]]
                ? (policy == "1", expiration == "1") : (false, false);
        Task<LoginLockFactsDto> Lock(string name) => service.Actions.LoginLockFactsAsync(info.Id, name, CancellationToken.None);
        // Locks a login out with failed sign-ins; false where the server applies no lockout policy.
        async Task<bool> LockOut(string name)
        {
            var wrong = NewPassword();
            for (var attempt = 0; attempt < BadSignIns; attempt++)
                await SignIn(name, wrong);
            return (await Lock(name)).Locked;
        }

        try
        {
            var created = await Sql("CREATE LOGIN " + Bracket(expiring) + " WITH PASSWORD = " + Literal(passwords[expiring]) + ", CHECK_POLICY = ON, CHECK_EXPIRATION = ON;\n"
                + "CREATE LOGIN " + Bracket(policyOnly) + " WITH PASSWORD = " + Literal(passwords[policyOnly]) + ", CHECK_POLICY = ON, CHECK_EXPIRATION = OFF;\n"
                + "CREATE LOGIN " + Bracket(mustChange) + " WITH PASSWORD = " + Literal(passwords[mustChange]) + " MUST_CHANGE, CHECK_POLICY = ON, CHECK_EXPIRATION = ON;");
            check(created.Status == "completed", "the Unlock checks create their scratch logins with the password policy: " + created.Error);

            // Refused before any DDL: a login that is not locked out (timed: the bounds below scale by it), one without the policy,
            // and one that must change its password.
            var timing = Stopwatch.StartNew();
            var notLocked = await Execute(policyOnly);
            var referenceMs = timing.ElapsedMilliseconds;
            var withoutPolicy = await Execute(noPolicy);
            var changing = await Execute(mustChange);
            var describedChange = await Describe(mustChange);
            check(notLocked is { Error.Code: "NOT_SUPPORTED", Steps.Count: 0 } && notLocked.Error.Message == words.Message("notLocked")
                && withoutPolicy is { Error.Code: "NOT_SUPPORTED", Steps.Count: 0 } && withoutPolicy.Error.Message == words.Message("unlockNoPolicy")
                && changing is { Error.Code: "NOT_SUPPORTED", Steps.Count: 0 } && changing.Error.Message == words.Message("unlockMustChange")
                && describedChange is { Error: null, Lock.MustChange: true, Login.PolicyChecked: true } && await Policy(policyOnly) == (true, false) && await Policy(noPolicy) == (false, false),
                "Unlock refuses a login that is not locked out, one without the password policy and one that must change its password, before any DDL: "
                + notLocked.Error?.Code + " " + withoutPolicy.Error?.Code + " " + changing.Error?.Code);

            // SQL Server's own answer to turning off the policy of a login that must change its password, settled in a transaction
            // that is rolled back: 15128, so the flag cannot survive a keep-password unlock and the refusal stays.
            var refusedNumber = 0;
            await using (var direct = new SqlConnection(new SqlConnectionStringBuilder(connectivity) { Pooling = false }.ConnectionString))
            {
                await direct.OpenAsync();
                await using var transaction = (SqlTransaction)await direct.BeginTransactionAsync();
                try
                {
                    await using var command = direct.CreateCommand();
                    command.Transaction = transaction;
                    command.CommandText = "ALTER LOGIN " + Bracket(mustChange) + " WITH CHECK_POLICY = OFF;";
                    await command.ExecuteNonQueryAsync();
                }
                catch (SqlException error) { refusedNumber = error.Number; }
                finally { try { await transaction.RollbackAsync(); } catch (InvalidOperationException) { } }
            }
            check(refusedNumber == 15128 && ActionErrors.CodeOf(ConnectionFailureChecks.Sql(refusedNumber, 1, 16, "server", "x"), null) == "NOT_SUPPORTED" && (await Lock(mustChange)).MustChange,
                "SQL Server refuses to turn off the password policy of a login that must change its password (" + refusedNumber + "), which Unlock maps to NOT_SUPPORTED");

            // Another session's open change to the login (D4 P8): the describe answers BLOCKED after the read lock timeout (shortened
            // here), and the execute's preflight waits until Stop, which answers before any statement ran.
            var holder = Guid.NewGuid().ToString();
            var readTimeout = service.Actions.Options.ReadLockTimeoutMs;
            try
            {
                service.Actions.Options.ReadLockTimeoutMs = 500;
                var held = await InSession(holder, "BEGIN TRANSACTION;\nALTER LOGIN " + Bracket(policyOnly) + " DISABLE;");
                var blocked = await Describe(policyOnly);
                using var context = new RequestContext(1, "actions.execute", RequestLane.Actions, 0);
                var waiting = Execute(policyOnly, context: context);
                var stillWaiting = await Task.WhenAny(waiting, Task.Delay(2000)) != waiting;
                var watch = Stopwatch.StartNew();
                context.Cancel(CancelReason.User);
                ActionExecuteResult? stopped = null;
                try { stopped = await waiting; } catch (OperationCanceledException) { }
                var answeredMs = watch.ElapsedMilliseconds;
                await InSession(holder, "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;");
                var bound = LiveResultChecks.CancelBound(5000, referenceMs);
                check(held.Status == "completed" && blocked is { Error.Code: "BLOCKED", Lock: null } && stillWaiting && stopped is { Error.Code: "CANCELLED", Steps.Count: 0 }
                    && answeredMs < bound && await Policy(policyOnly) == (true, false),
                    "behind another session's change to the login, Unlock's describe answers BLOCKED and its execute waits until Stop, before any statement ("
                    + blocked.Error?.Code + ", " + stopped?.Error?.Code + " in " + answeredMs + " ms of " + bound + ")");
            }
            finally
            {
                service.Actions.Options.ReadLockTimeoutMs = readTimeout;
                await InSession(holder, "IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;");
                await Call<object>("query.session.close", new SessionArgs(holder));
            }

            if (!await LockOut(expiring))
            {
                Console.WriteLine("Unlock lockout checks skipped: " + BadSignIns + " failed sign-ins did not lock a login out, so this server applies no lockout policy.");
                return;
            }
            // Locked: the describe says so; Script writes the transaction and runs nothing; Unlock, bound to the login it read,
            // unlocks it in one transaction, keeps the password and turns the policy and expiration back on.
            var described = await Describe(expiring);
            var lockedOut = await SignIn(expiring, passwords[expiring]);
            var script = await Call<ActionScriptResult>("actions.script", Unlock(expiring));
            var stillLocked = (await Lock(expiring)).Locked;
            var identity = described.Login is { } facts ? new LoginIdentityDto(facts.Sid, facts.Created) : null;
            var unlocked = await Execute(expiring, identity);
            var after = await Lock(expiring);
            var signedIn = await SignIn(expiring, passwords[expiring]);
            check(described is { Error: null, Lock: { Locked: true, LockoutTime: { Length: > 0 }, MustChange: false } } && lockedOut is 18456 or 18486
                && script is { Error: null, Database: "master" } && script.Text == ActionSql.TransactionScriptText(ActionService.UnlockPlan(expiring, expiration: true)) && stillLocked
                && unlocked.Error is null && Steps(unlocked) == "done:Turn off the password policy, done:Turn the password policy and expiration back on, done:Commit"
                && !after.Locked && await Policy(expiring) == (true, true) && signedIn == 0,
                "Unlock unlocks a locked-out login in one transaction, keeping its password (" + signedIn + ") and its policy and expiration; Script runs nothing: "
                + described.Error?.Code + " " + lockedOut + " " + unlocked.Error?.Message + " " + Steps(unlocked));
            var again = await Execute(expiring, identity);
            check(again is { Error.Code: "NOT_SUPPORTED", Steps.Count: 0 } && again.Error.Message == words.Message("notLocked"), "a login Unlock has unlocked is not locked out any more");

            // A login with the policy but without expiration keeps expiration off.
            if (await LockOut(policyOnly))
            {
                var policyUnlocked = await Execute(policyOnly);
                check(policyUnlocked.Error is null && Steps(policyUnlocked) == "done:Turn off the password policy, done:Turn the password policy back on, done:Commit"
                    && !(await Lock(policyOnly)).Locked && await Policy(policyOnly) == (true, false) && await SignIn(policyOnly, passwords[policyOnly]) == 0,
                    "Unlock of a login without password expiration turns only the policy back on: " + policyUnlocked.Error?.Message);
            }
            else check(false, "a second policy login locks out where the first did");
        }
        finally
        {
            await Sql(string.Concat(new[] { expiring, policyOnly, mustChange }.Select(name => "IF SUSER_ID(" + Literal(name) + ") IS NOT NULL DROP LOGIN " + Bracket(name) + ";\n")));
        }
    }
}
