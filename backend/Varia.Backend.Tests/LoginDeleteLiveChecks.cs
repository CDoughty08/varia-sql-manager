using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live checks of a login's Delete (PR D4c), with VARIA_TEST_SQL_SCRATCH=1 on a server that accepts SQL logins, on the
/// run's own scratch logins and databases only: a login that owns a database is refused before any DDL; Delete Object lists the
/// users mapped to a login (a schema owner as kept) and a scan with no budget counts every database as not checked; Script runs
/// nothing; a login with a session is refused (IN_USE) before any DDL, and when the deleting login cannot see sessions (no VIEW
/// SERVER STATE) SQL Server's 15434 answers IN_USE with the advice to end them, while a Delete with its users is refused before any
/// DDL, and a connection that may read no database counts every one as not checked; a login that is not the one read is refused; a
/// login that granted a server permission is refused before any DDL, and a user that granted one is kept; a Delete whose scan could
/// not read a database again is refused before any DDL; a user renamed in an open transaction while the scan read past it, and a
/// login dropped and created again before its DROP, are never dropped in their stead; a Delete without the option leaves its user
/// orphaned; and with it, the users it may drop go, then the login, while the schema owner stays. Logins and users have hostile
/// names. Everything is dropped in finally.</summary>
internal static class LoginDeleteLiveChecks
{
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string NewPassword() => "Vx9!" + Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(12));

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json, bool required = false)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<SqlRun> Sql(string text, string database = "master")
        {
            var session = Guid.NewGuid().ToString();
            try
            {
                var result = await Call<QueryResult>("query.execute", new QueryArgs(info.Id, session, database, text, Guid.NewGuid().ToString(), 100_000, 60, StopOnError: true));
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await Call<object>("query.session.close", new SessionArgs(session)); }
        }
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            if (required) throw new InvalidOperationException("The login Delete checks require VARIA_TEST_SQL_SCRATCH=1.");
            Console.WriteLine("Login Delete scratch checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping uniquely named logins on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        if ((await Sql("SELECT CONVERT(int, SERVERPROPERTY('IsIntegratedSecurityOnly'));")).Scalar != "0")
        {
            if (required) throw new InvalidOperationException("The login Delete checks require a server that accepts SQL logins.");
            Console.WriteLine("Login Delete scratch checks skipped: the server accepts Windows logins only.");
            return;
        }
        ObjectRefDto Login(string name) => new("login", Name: name);
        Task<ActionDescribeResult> Describe(string connectionId, string name, ActionService? actions = null) => actions is null
            ? Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(connectionId, Guid.NewGuid().ToString(), "deleteObject", Login(name)))
            : actions.DescribeAsync(new ActionDescribeArgs(connectionId, Guid.NewGuid().ToString(), "deleteObject", Login(name)), CancellationToken.None);
        ActionArgs Delete(string connectionId, string name, bool? users, LoginIdentityDto? identity) =>
            new("delete", connectionId, Guid.NewGuid().ToString(), Login(name), null, false, false, LoginIdentity: identity, DropMappedUsers: users);
        static LoginIdentityDto? IdentityOf(ActionDescribeResult result) => result.DeleteTarget?.Login is { } facts ? new(facts.Sid, facts.Created) : null;
        static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title));
        async Task<bool> LoginExists(string name) => (await Sql("SELECT COUNT(*) FROM sys.server_principals WHERE name = " + Literal(name) + ";")).Scalar == "1";
        async Task<string?> UserState(string database, string user) => (await Sql("SELECT CASE WHEN sp.sid IS NULL THEN 'orphaned' ELSE 'mapped' END FROM sys.database_principals AS dp "
            + "LEFT JOIN sys.server_principals AS sp ON sp.sid = dp.sid WHERE dp.name = " + Literal(user) + ";", database)).Scalar;

        var login = scratch.Name + "_ld]' --";
        var orphaning = scratch.Name + "_ld2";
        var deleter = scratch.Name + "_ld3";
        var grantee = scratch.Name + "_ld4";
        var recreated = scratch.Name + "_ld5";
        var users = scratch.LoginDeleteUsers;
        var kept = scratch.LoginDeleteKept;
        var droppedUser = "u]' --";
        var orphanUser = "o2";
        var ownerUser = "k";
        var victim = "v";
        var recreatedUser = "r";
        var password = NewPassword();
        var deleterPassword = NewPassword();
        var nl = Environment.NewLine;
        var host = (IActionHost)service;
        static string Codes(ActionExecuteResult result) => (result.Error?.Code ?? "none") + " " + string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title));
        async Task<string?> SidOf(string database, string user) => (await Sql("SELECT CONVERT(varchar(172), sid, 1) FROM sys.database_principals WHERE name = " + Literal(user) + ";", database)).Scalar;
        try
        {
            var made = await Sql("CREATE LOGIN " + Bracket(login) + " WITH PASSWORD = " + Literal(password) + ", CHECK_POLICY = OFF;\n"
                + "CREATE LOGIN " + Bracket(orphaning) + " WITH PASSWORD = " + Literal(NewPassword()) + ", CHECK_POLICY = OFF;\n"
                + "CREATE LOGIN " + Bracket(deleter) + " WITH PASSWORD = " + Literal(deleterPassword) + ", CHECK_POLICY = OFF;\nGRANT ALTER ANY LOGIN TO " + Bracket(deleter) + ";\n"
                + "CREATE LOGIN " + Bracket(grantee) + " WITH PASSWORD = " + Literal(NewPassword()) + ", CHECK_POLICY = OFF;\n"
                + "CREATE LOGIN " + Bracket(recreated) + " WITH PASSWORD = " + Literal(NewPassword()) + ", CHECK_POLICY = OFF;");
            await scratch.CreateLoginDeleteAsync();
            var owned = await Sql("ALTER AUTHORIZATION ON DATABASE::" + Bracket(kept) + " TO " + Bracket(login) + ";");
            check(made.Status == "completed" && owned.Status == "completed", "the login Delete checks create their scratch logins and databases: " + made.Error + owned.Error);

            // A login that owns a database: Delete Object warns, and the execute refuses before any DDL (SQL Server would answer 15174).
            var owning = await Describe(info.Id, login);
            var refused = await Call<ActionExecuteResult>("actions.execute", Delete(info.Id, login, true, IdentityOf(owning)));
            check(owning.DeleteTarget is { Type: "Login", Login.Subtype: "sql" } target && target.Warnings.Any(warning => warning.Blocking && warning.Text == ActionService.OwnedDatabasesWarning(1, [kept]))
                && refused is { Error.Code: "DEPENDENTS", Steps.Count: 0 } && refused.Error.Message.Contains(ActionService.OwnedDatabasesWarning(1, [kept]), StringComparison.Ordinal) && await LoginExists(login),
                "a login that owns a database is warned about and refused before any DDL: " + owning.Error?.Message + " " + refused.Error?.Code);
            var reowned = await Sql("DECLARE @owner sysname = SUSER_SNAME(0x01), @stmt nvarchar(max);\nSET @stmt = N'ALTER AUTHORIZATION ON DATABASE::' + QUOTENAME(" + Literal(kept) + ") + N' TO ' + QUOTENAME(@owner);\nEXEC (@stmt);");
            // The orphaning login's user grants a permission (DROP USER would fail, 15284), to a user without a login that the swap check
            // below renames.
            var mapped = await Sql("CREATE USER " + Bracket(droppedUser) + " FOR LOGIN " + Bracket(login) + ";\nCREATE USER " + Bracket(orphanUser) + " FOR LOGIN " + Bracket(orphaning) + ";\n"
                + "CREATE USER " + Bracket(victim) + " WITHOUT LOGIN;\nCREATE USER " + Bracket(recreatedUser) + " FOR LOGIN " + Bracket(recreated) + ";\n"
                + "GRANT SELECT ON SCHEMA::dbo TO " + Bracket(orphanUser) + " WITH GRANT OPTION;\nGRANT SELECT ON SCHEMA::dbo TO " + Bracket(victim) + " AS " + Bracket(orphanUser) + ";", users);
            var owner = await Sql("CREATE USER " + Bracket(ownerUser) + " FOR LOGIN " + Bracket(login) + ";", kept);
            var schema = await Sql("CREATE SCHEMA [ks] AUTHORIZATION " + Bracket(ownerUser) + ";", kept);
            check(reowned.Status == "completed" && mapped.Status == "completed" && owner.Status == "completed" && schema.Status == "completed",
                "the login Delete checks map users to their logins: " + reowned.Error + mapped.Error + owner.Error + schema.Error);

            // Delete Object lists the users mapped to the login, in database order, a schema owner with what it owns.
            var described = await Describe(info.Id, login);
            var mappings = described.DeleteTarget?.Mappings;
            check(described is { Error: null, DeleteTarget: { Name: var shown, Warnings.Count: 0, Login: { } } } && shown == login && mappings is { Mapped: 2, Checked: >= 2 }
                && mappings.Users.Count == 2 && mappings.Users[0] == new MappedUserDto(kept, ownerUser, 1, 0, false, 0, 0, true) && mappings.Users[1] == new MappedUserDto(users, droppedUser, 0, 0, false, 0, 0, true),
                "Delete Object lists a login's mapped users, the schema owner as one a Delete keeps: " + described.Error?.Message + " "
                + string.Join(", ", mappings?.Users.Select(user => user.Database[^4..] + ":" + user.OwnedSchemas) ?? []));
            // With no time to read, the scan reads no database and counts every one as not checked: a value, not a failure.
            using (var hurried = new ActionService(service, new ActionServiceOptions { ScanBudget = TimeSpan.Zero }))
            {
                var unread = await Describe(info.Id, login, hurried);
                check(unread is { Error: null, DeleteTarget.Mappings: { Mapped: 0, Checked: 0, Users.Count: 0, NotChecked: >= 2 } },
                    "a scan out of time counts the databases it did not read as not checked: " + unread.Error?.Message + " " + unread.DeleteTarget?.Mappings?.NotChecked);
                // The execute's own scan out of time: a database it could not read again might hold users the dialog listed, which would
                // stay orphaned while the login went. Refused before any DDL, as retryable.
                var hurriedRun = await hurried.ExecuteAsync(Delete(info.Id, login, true, IdentityOf(described)), CancellationToken.None);
                check(hurriedRun is { Error: { Code: "BLOCKED", Retryable: true }, Steps.Count: 0 } && hurriedRun.Error.Message.Contains(" databases could not be read again", StringComparison.Ordinal) 
                    && hurriedRun.Error.Message.EndsWith("Try again, or delete the login without its users.", StringComparison.Ordinal) && await LoginExists(login) && await UserState(users, droppedUser) == "mapped",
                    "a Delete with its users whose scan could not read a database again is refused before any DDL: " + Codes(hurriedRun));
            }

            // Script Action writes the users it may drop, each in its database, then the login, and runs nothing.
            var script = await Call<ActionScriptResult>("actions.script", Delete(info.Id, login, true, null));
            check(script is { Error: null, Database: "master", Warnings.Count: 0 } && script.Text == "USE " + Bracket(users) + nl + "GO" + nl + "DROP USER " + Bracket(droppedUser) + nl + "GO" + nl
                + "USE [master]" + nl + "GO" + nl + "DROP LOGIN " + Bracket(login) + nl + "GO" + nl
                && await LoginExists(login) && await UserState(users, droppedUser) == "mapped",
                "Script Action writes DROP USER for the users a Delete may drop and DROP LOGIN in master, and runs nothing: " + script.Error?.Message);

            // A session connected as the login: refused before any DDL. A deleter without VIEW SERVER STATE cannot count sessions,
            // so SQL Server's 15434 refuses its DROP, and the reply says how to end them; the login and its users stay.
            var builder = new SqlConnectionStringBuilder
            {
                DataSource = live("master").Server, InitialCatalog = "master", UserID = login, Password = password, TrustServerCertificate = true, Pooling = false,
                ConnectTimeout = 30, ApplicationName = "Varia checks"
            };
            await using (var session = new SqlConnection(builder.ConnectionString))
            {
                await session.OpenAsync();
                var counted = await Describe(info.Id, login);
                var inUse = await Call<ActionExecuteResult>("actions.execute", Delete(info.Id, login, true, IdentityOf(counted)));
                check(counted.DeleteTarget?.Login?.Sessions >= 1 && counted.DeleteTarget.Warnings.FirstOrDefault() is { Blocking: true } first
                    && first.Text == ActionService.SessionsWarning(counted.DeleteTarget.Login.Sessions!.Value)
                    && inUse is { Error.Code: "IN_USE", Steps.Count: 0, Sessions: >= 1 } && await LoginExists(login) && await UserState(users, droppedUser) == "mapped",
                    "a login with a session is warned about and refused before any DDL: " + inUse.Error?.Code + " " + counted.DeleteTarget?.Login?.Sessions);
                var limited = await Call<ConnectionInfo>("connections.connect", live("master") with { Authentication = "sql", Username = deleter, Password = deleterPassword });
                try
                {
                    var blind = await Describe(limited.Id, login);
                    // It may open no database, so it reads no user: every database counts as not checked, never as none mapped.
                    check(blind.DeleteTarget?.Mappings is { Mapped: 0, Checked: 0, Users.Count: 0, NotChecked: >= 2 },
                        "a connection that may read no database counts every one as not checked: " + blind.Error?.Message + " " + blind.DeleteTarget?.Mappings?.NotChecked);
                    // With its users, a session it cannot count would fail the login's DROP after them: refused before any DDL.
                    var uncounted = await Call<ActionExecuteResult>("actions.execute", Delete(limited.Id, login, true, IdentityOf(blind)));
                    check(uncounted is { Error.Code: "NOT_SUPPORTED", Steps.Count: 0 } && uncounted.Error.Message.Contains("VIEW SERVER STATE", StringComparison.Ordinal)
                        && await LoginExists(login) && await UserState(users, droppedUser) == "mapped",
                        "without VIEW SERVER STATE, a Delete with its users is refused before any DDL: " + Codes(uncounted));
                    // Where it may see users but not drop them (no ALTER ANY USER), the user is listed as kept.
                    var viewer = await Sql("CREATE USER " + Bracket(deleter) + " FOR LOGIN " + Bracket(deleter) + ";\nGRANT VIEW DEFINITION TO " + Bracket(deleter) + ";", users);
                    var viewing = await Describe(limited.Id, login);
                    check(viewer.Status == "completed" && viewing.DeleteTarget?.Mappings is { Mapped: 1, Checked: 1, NotChecked: >= 1 } seen
                        && seen.Users.Single() == new MappedUserDto(users, droppedUser, 0, 0, false, 0, 0, false) && ActionService.Kept(seen.Users[0]),
                        "a user where the connection may not drop users is listed as kept: " + viewer.Error + " " + viewing.Error?.Message);
                    var failed = await Call<ActionExecuteResult>("actions.execute", Delete(limited.Id, login, false, IdentityOf(blind)));
                    check(blind.DeleteTarget?.Login is { Sessions: null } && failed is { Error.Code: "IN_USE" } && Steps(failed) == "failed:Drop the login"
                        && failed.Error.Message.EndsWith(ActionErrors.LoginSessionsAdvice, StringComparison.Ordinal) && await LoginExists(login),
                        "without VIEW SERVER STATE, SQL Server's refusal of a login with a session (15434) is IN_USE with the advice to end it: "
                        + blind.Error?.Code + " " + failed.Error?.Code + " " + Steps(failed));
                }
                finally { await Call<object>("connections.disconnect", new ConnectionArgs(limited.Id)); }
            }

            // The confirmation is about the login it read: another identity is refused before any DDL.
            var stale = await Call<ActionExecuteResult>("actions.execute", Delete(info.Id, login, true, new(new string('0', 32), IdentityOf(described)!.Created)));
            check(stale is { Error.Code: "NOT_FOUND", Steps.Count: 0 } && await LoginExists(login), "a login's Delete refuses a login that is not the one it read: " + stale.Error?.Code);

            // A login that granted a server permission (DROP LOGIN fails, 15173): warned about and refused before any DDL, so its users
            // stay; its user that granted a database permission (DROP USER fails, 15284) is listed as kept.
            var granted = await Sql("GRANT VIEW ANY DATABASE TO " + Bracket(orphaning) + " WITH GRANT OPTION;\nGRANT VIEW ANY DATABASE TO " + Bracket(grantee) + " AS " + Bracket(orphaning) + ";");
            var grantorRead = await Describe(info.Id, orphaning);
            var grantor = await Call<ActionExecuteResult>("actions.execute", Delete(info.Id, orphaning, true, IdentityOf(grantorRead)));
            check(granted.Status == "completed" && grantorRead.DeleteTarget is { } grantorTarget && grantorTarget.Warnings.Any(warning => warning.Blocking && warning.Text == ActionService.GrantedWarning(1))
                && grantorTarget.Mappings?.Users.SingleOrDefault() == new MappedUserDto(users, orphanUser, 0, 0, false, 0, 1, true)
                && grantor is { Error.Code: "DEPENDENTS", Steps.Count: 0 } && grantor.Error.Message.Contains(ActionService.GrantedWarning(1), StringComparison.Ordinal)
                && await LoginExists(orphaning) && await UserState(users, orphanUser) == "mapped",
                "a login that granted a server permission is refused before any DDL, and its user that granted one is kept: " + granted.Error + " " + Codes(grantor));
            // Dropping the grantee removes the permission it was granted.
            await Sql("DROP LOGIN " + Bracket(grantee) + ";");

            // A user renamed in an open transaction while the execute's scan read past it: the scan may plan the DROP of the name the
            // login's user had taken, which another user really has once the transaction rolls back. The DROP checks the SID it was
            // planned for, so that user survives, as does the login's.
            var victimSid = await SidOf(users, victim);
            await using (var holder = host.Connection(info.Id))
            {
                await host.OpenAsync(holder, CancellationToken.None);
                await holder.ChangeDatabaseAsync(users);
                await using var swap = (SqlTransaction)await holder.BeginTransactionAsync();
                await using (var rename = holder.CreateCommand())
                {
                    rename.Transaction = swap;
                    rename.CommandText = "ALTER USER " + Bracket(victim) + " WITH NAME = [v_tmp];\nALTER USER " + Bracket(droppedUser) + " WITH NAME = " + Bracket(victim) + ";";
                    await rename.ExecuteNonQueryAsync();
                }
                var rolledBack = false;
                using var swapping = new ActionService(service, new ActionServiceOptions
                {
                    BeforeStep = async (title, _) => { if (!rolledBack) { rolledBack = true; await swap.RollbackAsync(); } }
                });
                var swapped = await swapping.ExecuteAsync(Delete(info.Id, login, true, IdentityOf(described)), CancellationToken.None);
                if (!rolledBack) await swap.RollbackAsync();
                check(swapped.Error?.Code is "NOT_FOUND" or "BLOCKED" && swapped.Steps.All(step => step.Status != "done") && await LoginExists(login)
                    && await SidOf(users, victim) == victimSid && await UserState(users, droppedUser) == "mapped",
                    "a user another session renamed while the scan read past it is never dropped in the login's user's stead: " + Codes(swapped));
            }

            // A login dropped and created again (with its SID) while its users' DROPs ran: the login's DROP checks the principal it was
            // planned for, so the new login survives.
            var recreatedSid = (await Sql("SELECT CONVERT(varchar(172), SUSER_SID(" + Literal(recreated) + "), 1);")).Scalar;
            var recreatedId = (await Sql("SELECT SUSER_ID(" + Literal(recreated) + ");")).Scalar;
            var recreatedRead = await Describe(info.Id, recreated);
            using (var racing = new ActionService(service, new ActionServiceOptions
            {
                BeforeStep = async (title, _) =>
                {
                    if (title == "Drop the login")
                        await Sql("DROP LOGIN " + Bracket(recreated) + ";\nCREATE LOGIN " + Bracket(recreated) + " WITH PASSWORD = " + Literal(NewPassword()) + ", SID = " + recreatedSid + ", CHECK_POLICY = OFF;");
                }
            }))
            {
                var raced = await racing.ExecuteAsync(Delete(info.Id, recreated, true, IdentityOf(recreatedRead)), CancellationToken.None);
                check(recreatedSid is { Length: > 2 } && raced is { Error.Code: "NOT_FOUND" } && Steps(raced) == "done:Drop the database user, failed:Drop the login"
                    && await LoginExists(recreated) && (await Sql("SELECT SUSER_ID(" + Literal(recreated) + ");")).Scalar != recreatedId && await UserState(users, recreatedUser) is null,
                    "a login dropped and created again before its DROP is not dropped: " + Codes(raced));
            }

            // Without the option, the login goes and its user stays, orphaned.
            var plainRead = await Describe(info.Id, orphaning);
            var plain = await Call<ActionExecuteResult>("actions.execute", Delete(info.Id, orphaning, false, IdentityOf(plainRead)));
            check(plainRead.DeleteTarget?.Mappings is { Mapped: 1 } && plain is { Error: null } && Steps(plain) == "done:Drop the login" && !await LoginExists(orphaning)
                && await UserState(users, orphanUser) == "orphaned",
                "a login's Delete without its users drops the login and leaves its user orphaned: " + plain.Error?.Message);

            // With it, the user it may drop goes in its database, then the login; the schema owner stays.
            var withRead = await Describe(info.Id, login);
            var full = await Call<ActionExecuteResult>("actions.execute", Delete(info.Id, login, true, IdentityOf(withRead)));
            check(full is { Error: null } && Steps(full) == "done:Drop the database user, done:Drop the login" && full.Steps[0].Detail == droppedUser + " in " + users
                && !await LoginExists(login) && await UserState(users, droppedUser) is null && await UserState(kept, ownerUser) == "orphaned",
                "a login's Delete with its users drops those it may, each in its database, then the login, and keeps a schema owner: " + full.Error?.Message + " " + Steps(full));
        }
        finally
        {
            // A failed run may leave the login owning its database, which its DROP would refuse.
            await Sql("IF DB_ID(" + Literal(kept) + ") IS NOT NULL AND EXISTS (SELECT 1 FROM sys.databases WHERE name = " + Literal(kept) + " AND owner_sid = SUSER_SID(" + Literal(login) + "))\n"
                + "BEGIN DECLARE @owner sysname = SUSER_SNAME(0x01), @stmt nvarchar(max); SET @stmt = N'ALTER AUTHORIZATION ON DATABASE::' + QUOTENAME(" + Literal(kept) + ") + N' TO ' + QUOTENAME(@owner); EXEC (@stmt); END;");
            // The grantee first: a login that granted it a permission cannot be dropped while it holds it (15173).
            foreach (var name in new[] { grantee, login, orphaning, deleter, recreated })
                await Sql("IF SUSER_ID(" + Literal(name) + ") IS NOT NULL DROP LOGIN " + Bracket(name) + ";");
        }
    }
}
