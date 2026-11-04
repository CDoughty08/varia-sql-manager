using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live checks of Login Properties (PR D2c). Without scratch objects: the describe of the login this connection uses, and dry
/// runs (SELECT @stmt only) proving SQL Server builds exactly the options and password statements Script shows, for hostile 128-unit
/// names and hostile passwords. With VARIA_TEST_SQL_SCRATCH=1, on the run's own SQL logins (VariaScratch_…_l…) and database (_lpr):
/// the describe and User Mapping's login-scoped read; one OK that changes the options, the password, a server role and a mapped user
/// (renamed, its new default schema created, a role dropped and one added) in SSMS's order; Deny and Disable; the old password, right
/// (the login itself, without ALTER ANY LOGIN) and wrong (15151, with the advice); MUST_CHANGE (18488 at sign-in); a role dropped; an
/// unmap; a login dropped and recreated under the same name refused by its identity; a role that vanishes mid-run and Stop, each
/// reply saying first that the login changed in part; Script, which runs nothing unedited; and, where the server applies a lockout
/// policy, a new password with UNLOCK. Passwords are throwaway and never printed; replies are checked to hold none.</summary>
internal static class LoginPropertiesLiveChecks
{
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private const int BadSignIns = 11;

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json, bool required = false)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<SqlRun> Sql(string text, string database = "master")
        {
            var session = Guid.NewGuid().ToString();
            try
            {
                var result = await Call<QueryResult>("query.execute", new QueryArgs(info.Id, session, database, text, Guid.NewGuid().ToString(), 100_000, 120, StopOnError: true));
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await Call<object>("query.session.close", new SessionArgs(session)); }
        }
        var actions = service.Actions;
        static ObjectRefDto Login(string name) => new("login", Name: name);
        Task<ActionDescribeResult> Describe(string name, string? connectionId = null) =>
            actions.DescribeAsync(new ActionDescribeArgs(connectionId ?? info.Id, Guid.NewGuid().ToString(), "loginProperties", Login(name)), CancellationToken.None);
        static LoginIdentityDto? IdentityOf(ActionDescribeResult described) => described.Login is { } facts ? new(facts.Sid, facts.Created) : null;
        ActionArgs Properties(string name, LoginChangesDto changes, LoginIdentityDto? identity, LoginSecretsDto? secrets = null, string? connectionId = null) =>
            new("loginProperties", connectionId ?? info.Id, Guid.NewGuid().ToString(), Login(name), Secrets: secrets, LoginIdentity: identity, LoginChanges: changes);
        static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title + (step.Detail is null ? "" : "/" + step.Detail)));

        // The login this connection uses: its describe reads its facts, defaults and the users mapped to it, and changes nothing.
        var own = (await Sql("SELECT SUSER_SNAME();")).Scalar ?? "";
        if (await actions.LoginFactsAsync(info.Id, own, CancellationToken.None) is not null)
        {
            var ownDescribed = await Describe(own);
            check(ownDescribed is { Error: null, Login.Own: true, NewLogin: not null, LoginProperties: { DefaultDatabase.Length: > 0 } }
                && (ownDescribed.Login.Type.Trim() == "S") == (ownDescribed.Lock is not null),
                "Login Properties' describe reads the login this connection uses: its facts, defaults, server roles, mapped users and, for a SQL Server login, its lock-out state: " + ownDescribed.Error?.Message);
        }
        else Console.WriteLine("Login Properties' own-login describe skipped: this connection gets in through a Windows group.");

        // Dry runs: SQL Server builds exactly Script's statements for hostile names and passwords, which never leave the batch's
        // parameters (no login is needed: the batch returns its statement and runs nothing).
        var failures = new List<string>();
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'").Append("‮"))
        {
            var name = ActionChecks.Long(fragment);
            var hostile = ("P'" + fragment + "x")[..Math.Min(128, fragment.Length + 3)];
            var hostileOld = ("O]'" + fragment)[..Math.Min(128, fragment.Length + 3)];
            foreach (var (dry, change) in new (LoginChangesDto, LoginPasswordChangeDto)[]
            {
                (new(name, name, true, true), new(true, false, false)), (new(DefaultLanguage: name, CheckPolicy: false), new(false, true, true)), (new(CheckExpiration: false), new(false, false, false))
            })
            {
                var (options, statement) = await actions.DryRunLoginPropertiesAsync(info.Id, name, dry with { Password = change }, hostile, change.OldPassword ? hostileOld : null, CancellationToken.None);
                if (options != LoginSql.OptionsStatement(name, dry) || statement != LoginSql.PasswordStatement(name, change, hostile, change.OldPassword ? hostileOld : null)) failures.Add(fragment[..1]);
            }
        }
        check(failures.Count == 0, "SQL Server builds exactly Script's ALTER LOGIN statements for hostile 128-unit names and hostile passwords: " + string.Join(", ", failures));

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            check(!required, "the Login Properties lane needs VARIA_TEST_SQL_SCRATCH=1");
            Console.WriteLine("Login Properties scratch checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping uniquely named logins on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        if (!await scratch.CreateLoginAsync())
        {
            check(!required, "the Login Properties lane needs a server that takes SQL Server logins");
            Console.WriteLine("Login Properties scratch checks skipped: the server accepts Windows logins only.");
            return;
        }
        var database = await scratch.CreateLoginPropertiesDatabaseAsync();
        string NewPassword() => "Vx9!" + Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(12));
        var secrets = new List<string>();
        string Remember(string password) { secrets.Add(password); return password; }
        bool Clean(object reply) { var text = JsonSerializer.Serialize(reply, json); return !secrets.Any(secret => text.Contains(secret, StringComparison.Ordinal)); }
        var connectivity = ConnectionSettings.Build(live("master")).ConnectionString;
        async Task<int> SignIn(string name, string password)
        {
            var builder = new SqlConnectionStringBuilder(connectivity) { IntegratedSecurity = false, UserID = name, Password = password, Pooling = false, ConnectTimeout = 30, ApplicationName = "Varia checks" };
            try
            {
                await using var connection = new SqlConnection(builder.ConnectionString);
                await connection.OpenAsync();
                return 0;
            }
            catch (SqlException error) { return error.Number; }
        }
        // The login's default database and language, whether it is disabled, its CONNECT SQL state and its server roles.
        async Task<string> State(string name) => string.Join("|", (await Sql("SELECT p.default_database_name, p.default_language_name, CONVERT(nvarchar(1), p.is_disabled), "
            + "ISNULL((SELECT TOP (1) sp.state FROM sys.server_permissions AS sp WHERE sp.grantee_principal_id = p.principal_id AND sp.type = 'COSQ' ORDER BY sp.state), N''), "
            + "ISNULL((SELECT STRING_AGG(r.name, N',') WITHIN GROUP (ORDER BY r.name) FROM sys.server_role_members AS m JOIN sys.server_principals AS r ON r.principal_id = m.role_principal_id "
            + "WHERE m.member_principal_id = p.principal_id), N'') FROM sys.server_principals AS p WHERE p.name = " + Literal(name) + ";")).Sets.SelectMany(set => set).SelectMany(row => row));
        // The user mapped to the login in the scratch database: its name, default schema and roles, and the owner of its schema.
        async Task<string> Mapped(string name) => string.Join("|", (await Sql("SELECT u.name, u.default_schema_name, "
            + "ISNULL((SELECT o.name FROM sys.schemas AS s JOIN sys.database_principals AS o ON o.principal_id = s.principal_id WHERE s.name = u.default_schema_name), N''), "
            + "ISNULL((SELECT STRING_AGG(r.name, N',') WITHIN GROUP (ORDER BY r.name) FROM sys.database_role_members AS m JOIN sys.database_principals AS r ON r.principal_id = m.role_principal_id "
            + "WHERE m.member_principal_id = u.principal_id), N'') FROM sys.database_principals AS u WHERE u.sid = SUSER_SID(" + Literal(name) + ");", database)).Sets.SelectMany(set => set).SelectMany(row => row));

        const string user = "Prop]u'ser", renamed = "Prop]u'ser2", role = "Prop]r'ole", schema = "Prop]s'chema";
        var login = scratch.OwnLogin("pa");
        var password = Remember(NewPassword());
        var setUp = await Sql("CREATE LOGIN " + Bracket(login) + " WITH PASSWORD = " + Literal(password) + ", CHECK_POLICY = ON, CHECK_EXPIRATION = OFF;");
        var setUpDatabase = await Sql("CREATE USER " + Bracket(user) + " FOR LOGIN " + Bracket(login) + " WITH DEFAULT_SCHEMA = [dbo];\nALTER ROLE [db_datareader] ADD MEMBER " + Bracket(user) + ";\n"
            + "CREATE ROLE " + Bracket(role) + ";\nCREATE ROLE [VariaGone];", database);
        check(setUp.Status == "completed" && setUpDatabase.Status == "completed", "Login Properties' scratch login and its user are created: " + setUp.Error + " " + setUpDatabase.Error);

        // The describe, and User Mapping's read of the database for this login: its user and that user's roles.
        var described = await Describe(login);
        var read = await actions.DescribeAsync(new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), actions.Catalog.Logins.RolesDescribe, new ObjectRefDto("database", Name: database), Login: login), CancellationToken.None);
        var notMapped = await actions.DescribeAsync(new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), actions.Catalog.Logins.RolesDescribe, new ObjectRefDto("database", Name: "master"), Login: login), CancellationToken.None);
        var gone = await actions.DescribeAsync(new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), actions.Catalog.Logins.RolesDescribe, new ObjectRefDto("database", Name: database), Login: scratch.LoginNamed("none")), CancellationToken.None);
        check(described is { Error: null, Login: { Own: false, PolicyChecked: true, ExpirationChecked: false }, Lock.Locked: false, LoginProperties: { DefaultDatabase: "master", ServerRolesTruncated: false } } props
            && props.LoginProperties!.Users.Any(item => item == new LoginMappedUserDto(database, user, "dbo", false)) && props.LoginProperties.Read.Contains(database)
            && props.LoginProperties.ServerRoles.Count == 0
            && read.LoginDatabaseRoles is { User: { Name: user, DefaultSchema: "dbo", Owner: false }, MemberOf: ["db_datareader"] } && notMapped.LoginDatabaseRoles is { User: null, MemberOf: [] }
            && gone.Error?.Code == "NOT_FOUND",
            "Login Properties reads the login, its lock-out state and its mapped user, and User Mapping's read of a database finds that user and its roles: " + described.Error?.Message);
        var identity = IdentityOf(described);

        // One OK: the options, the password, a server role and the mapped user, in SSMS's order, each a step.
        var second = Remember(NewPassword());
        var changes = new LoginChangesDto(database, "Deutsch", Password: new(false, false, false), RolesAdd: ["dbcreator"],
            Mappings: [new(database, "update", user, renamed, schema, [role], ["db_datareader"])]);
        var script = await actions.ScriptAsync(Properties(login, changes, null), CancellationToken.None);
        var scriptRun = await Sql(script.Text ?? "");
        var unchanged = await State(login);
        var changed = await actions.ExecuteAsync(Properties(login, changes, identity, new(second)), CancellationToken.None);
        check(script is { Error: null, Database: "master" } && script.Text!.Contains(LoginSql.Placeholder, StringComparison.Ordinal) && scriptRun.Status != "completed"
            && unchanged == "master|us_english|0|G|",
            "Script with a password runs nothing unedited (its placeholder does not parse): " + scriptRun.Status + " | " + unchanged);
        check(changed.Error is null && Steps(changed) == "done:Change the login's options, done:Change the password, done:Add to a server role/dbcreator, done:Rename a user/" + database
                + ", done:Set the default schema/" + database + ", done:Create a schema/" + database + ", done:Remove from a database role/db_datareader in " + database
                + ", done:Add to a database role/" + role + " in " + database
            && await State(login) == database + "|Deutsch|0|G|dbcreator" && await Mapped(login) == renamed + "|" + schema + "|" + renamed + "|" + role
            && await SignIn(login, second) == 0 && await SignIn(login, password) != 0 && Clean(changed),
            "Login Properties changes the options, the password, a server role and the mapped user in SSMS's order: " + Steps(changed) + " | " + changed.Error?.Message);

        // Deny and Disable lock the login out; Grant and Enable let it back in.
        var shut = await actions.ExecuteAsync(Properties(login, new(Connect: "deny", Enabled: false), identity), CancellationToken.None);
        var shutState = await State(login);
        var shutSignIn = await SignIn(login, second);
        var opened = await actions.ExecuteAsync(Properties(login, new(Connect: "grant", Enabled: true), identity), CancellationToken.None);
        check(shut.Error is null && Steps(shut) == "done:Deny permission to connect, done:Disable the login" && shutState == database + "|Deutsch|1|D|dbcreator" && shutSignIn != 0
            && opened.Error is null && await State(login) == database + "|Deutsch|0|G|dbcreator" && await SignIn(login, second) == 0,
            "Status denies and disables the login, then grants and enables it again: " + Steps(shut) + " | " + shutState + " | " + Steps(opened));

        // The old password: wrong, SQL Server answers 15151 and the reply says to check it; right, the password changes. Then the login
        // itself, without ALTER ANY LOGIN, changes its own password with the old one, as SQL Server requires.
        var third = Remember(NewPassword());
        var wrong = await actions.ExecuteAsync(Properties(login, new(Password: new(true, false, false)), identity, new(third, Remember(NewPassword()))), CancellationToken.None);
        var right = await actions.ExecuteAsync(Properties(login, new(Password: new(true, false, false)), identity, new(third, second)), CancellationToken.None);
        check(wrong is { Error.Code: "PERMISSION_DENIED" } && wrong.Error.Message.EndsWith(ActionService.LoginOldPasswordAdvice, StringComparison.Ordinal)
            && !wrong.Error.Message.StartsWith(ActionService.LoginChangedMessage, StringComparison.Ordinal) && Steps(wrong) == "failed:Change the password"
            && right.Error is null && await SignIn(login, third) == 0 && Clean(wrong) && Clean(right),
            "a wrong old password fails with 15151 and the advice to check it; the right one changes the password: " + wrong.Error?.Message + " | " + Steps(right));
        var self = await Call<ConnectionInfo>("connections.connect", live("master") with { Authentication = "sql", Username = login, Password = third, Database = "master" });
        try
        {
            var selfDescribed = await Describe(login, self.Id);
            // Its own Disable first: once its password changes, this connection's new sessions (object actions open their own) need the new one.
            var denied = await actions.ExecuteAsync(Properties(login, new(Enabled: false), IdentityOf(selfDescribed), null, self.Id), CancellationToken.None);
            var fourth = Remember(NewPassword());
            var withoutOld = await actions.ExecuteAsync(Properties(login, new(Password: new(false, false, false)), IdentityOf(selfDescribed), new(fourth), self.Id), CancellationToken.None);
            var withOld = await actions.ExecuteAsync(Properties(login, new(Password: new(true, false, false)), IdentityOf(selfDescribed), new(fourth, third), self.Id), CancellationToken.None);
            check(selfDescribed is { Error: null, Login: { Own: true, CanAlter: false } } && withoutOld is { Error.Code: "PERMISSION_DENIED" }
                && withoutOld.Error.Message.EndsWith(ActionErrors.LoginPermissionAdvice, StringComparison.Ordinal)
                && withOld.Error is null && await SignIn(login, fourth) == 0
                && denied is { Error.Code: "NOT_SUPPORTED", Steps.Count: 0 } && denied.Error.Message == actions.Catalog.Logins.Message("ownStatus") && await State(login) == database + "|Deutsch|0|G|dbcreator",
                "the login itself changes its own password only with the old one, and may not disable itself: " + withoutOld.Error?.Code + " " + withOld.Error?.Message + " " + denied.Error?.Code);
            // The connection keeps working: its new sessions (each object action opens one) sign in with the new password (finding 7).
            var afterOwn = await actions.ExecuteAsync(Properties(login, new(DefaultLanguage: "us_english"), IdentityOf(selfDescribed), null, self.Id), CancellationToken.None);
            var afterOwnState = await State(login);
            var mustOwn = await actions.ExecuteAsync(Properties(login, new(CheckExpiration: true, Password: new(false, false, true)), IdentityOf(selfDescribed), new(Remember(NewPassword())), self.Id), CancellationToken.None);
            check(afterOwn.Error is null && afterOwnState.StartsWith(database + "|us_english|", StringComparison.Ordinal) && Clean(afterOwn),
                "after the login changes its own password, the connection signed in as it runs its next action with the new one: " + afterOwn.Error?.Code + " " + afterOwn.Error?.Message);
            check(mustOwn is { Error.Code: "NOT_SUPPORTED", Steps.Count: 0 } && mustOwn.Error.Message == actions.Catalog.Logins.Message("ownMustChange") && await SignIn(login, fourth) == 0,
                "the login this connection uses may not require itself to change its password at the next sign-in: " + mustOwn.Error?.Code);
            third = fourth;
        }
        finally { await Call<object>("connections.disconnect", new ConnectionArgs(self.Id)); }

        // MUST_CHANGE, with expiration turned on first: the new password signs in only to be told to change it (18488).
        var fifth = Remember(NewPassword());
        var must = await actions.ExecuteAsync(Properties(login, new(CheckExpiration: true, Password: new(false, false, true)), identity, new(fifth)), CancellationToken.None);
        var mustSignIn = await SignIn(login, fifth);
        var mustLock = await actions.LoginLockFactsAsync(info.Id, login, CancellationToken.None);
        // A new password (the policy may keep a history) clears it.
        var current = Remember(NewPassword());
        var reset = await actions.ExecuteAsync(Properties(login, new(Password: new(false, false, false)), identity, new(current)), CancellationToken.None);
        check(must.Error is null && Steps(must) == "done:Change the login's options, done:Change the password" && mustSignIn == 18488 && mustLock.MustChange
            && reset.Error is null && !(await actions.LoginLockFactsAsync(info.Id, login, CancellationToken.None)).MustChange && await SignIn(login, current) == 0,
            "User must change password sets MUST_CHANGE after the policy options, and a new password clears it: " + Steps(must) + " " + mustSignIn);

        // A server role dropped, and the user unmapped (DROP USER, bound to the login's SID); Script warns of the DROP USER. The user
        // owns the schema OK created for it, so SQL Server refuses its DROP USER (15138), as in SSMS, after the role step completed.
        var unmap = new LoginChangesDto(RolesDrop: ["dbcreator"], Mappings: [new(database, "unmap", renamed)]);
        var unmapScript = await actions.ScriptAsync(Properties(login, unmap, null), CancellationToken.None);
        var owning = await actions.ExecuteAsync(Properties(login, unmap, identity), CancellationToken.None);
        check(unmapScript.Warnings.SequenceEqual(["Drops the user " + Bracket(renamed) + " in " + Bracket(database) + "."])
            && owning.Error is { } owningError && owningError.Message.StartsWith(ActionService.LoginChangedMessage + " ", StringComparison.Ordinal)
            && Steps(owning) == "done:Remove from a server role/dbcreator, failed:Drop the database user/" + renamed + " in " + database
            && await State(login) == database + "|us_english|0|G|" && await Mapped(login) == renamed + "|" + schema + "|" + renamed + "|" + role,
            "Login Properties drops a server role membership, then fails to unmap a user that owns a schema and says the login changed in part: " + Steps(owning) + " | " + owning.Error?.Message);
        var transferred = await Sql("ALTER AUTHORIZATION ON SCHEMA::" + Bracket(schema) + " TO [dbo];", database);
        var unmapped = await actions.ExecuteAsync(Properties(login, new(Mappings: [new(database, "unmap", renamed)]), identity), CancellationToken.None);
        check(transferred.Status == "completed" && unmapped.Error is null && Steps(unmapped) == "done:Drop the database user/" + renamed + " in " + database && await Mapped(login) == "",
            "Login Properties unmaps the user once it owns nothing: " + Steps(unmapped) + " | " + unmapped.Error?.Message);

        // Mapping again, then a role that vanishes after the preflight: the reply says first that the login changed in part.
        var remap = await actions.ExecuteAsync(Properties(login, new(Mappings: [new(database, "map", user, DefaultSchema: "dbo", RolesAdd: ["VariaGone"])]), identity), CancellationToken.None);
        check(remap.Error is null && await Mapped(login) == user + "|dbo|dbo|VariaGone", "Login Properties maps the login to a new user with a role: " + Steps(remap));
        // The mapping preflight refuses, before anything runs: a map where the login has a user, a new name another user or role has,
        // and a role the database lacks (finding 16).
        var mapTwice = await actions.ExecuteAsync(Properties(login, new(Mappings: [new(database, "map", "VariaOther")]), identity), CancellationToken.None);
        var renameTaken = await actions.ExecuteAsync(Properties(login, new(Mappings: [new(database, "update", user, role)]), identity), CancellationToken.None);
        var roleMissing = await actions.ExecuteAsync(Properties(login, new(DefaultLanguage: "us_english", Mappings: [new(database, "update", user, RolesAdd: ["VariaMissing"])]), identity), CancellationToken.None);
        check(mapTwice is { Error.Code: "NAME_IN_USE", Steps.Count: 0 } && renameTaken is { Error.Code: "NAME_IN_USE", Steps.Count: 0 } && roleMissing is { Error.Code: "NOT_FOUND", Steps.Count: 0 }
            && await Mapped(login) == user + "|dbo|dbo|VariaGone" && (await State(login)).StartsWith(database + "|us_english|", StringComparison.Ordinal),
            "User Mapping's preflight refuses a second user, a name in use and a missing role, and runs nothing: " + mapTwice.Error?.Code + " " + renameTaken.Error?.Code + " " + roleMissing.Error?.Code);
        var partialChanges = new LoginChangesDto(DefaultLanguage: "us_english", Mappings: [new(database, "update", user, RolesAdd: [role], RolesDrop: ["VariaGone"])]);
        actions.Options.BeforeStep = async (title, _) => { if (title == "Remove from a database role") await Sql("ALTER ROLE [VariaGone] DROP MEMBER " + Bracket(user) + ";\nDROP ROLE [VariaGone];", database); };
        ActionExecuteResult partial;
        try { partial = await actions.ExecuteAsync(Properties(login, partialChanges, identity), CancellationToken.None); }
        finally { actions.Options.BeforeStep = null; }
        check(partial.Error is { } partialError && partialError.Message.StartsWith(ActionService.LoginChangedMessage + " ", StringComparison.Ordinal)
            && Steps(partial) == "done:Change the login's options, done:Add to a database role/" + role + " in " + database + ", failed:Remove from a database role/VariaGone in " + database
            && (await State(login)).StartsWith(database + "|us_english|", StringComparison.Ordinal),
            "a step that fails after another completed says first that the login changed in part, and lists what completed: " + Steps(partial) + " | " + partial.Error?.Message);

        // Stop before the password: the options stay changed, the password does not, and the reply says so first.
        var sixth = Remember(NewPassword());
        using (var stop = new CancellationTokenSource())
        {
            actions.Options.BeforeStep = (title, _) => { if (title == ActionService.LoginPasswordStep) stop.Cancel(); return Task.CompletedTask; };
            ActionExecuteResult? stopped = null;
            try { stopped = await actions.ExecuteAsync(Properties(login, new(DefaultLanguage: "Deutsch", Password: new(false, false, false)), identity, new(sixth)), stop.Token); }
            catch (OperationCanceledException) { }
            finally { actions.Options.BeforeStep = null; }
            check(stopped is { Error.Code: "CANCELLED" } && stopped.Error.Message.StartsWith(ActionService.LoginChangedMessage + " ", StringComparison.Ordinal)
                && Steps(stopped) == "done:Change the login's options, cancelled:Change the password" && (await State(login)).StartsWith(database + "|Deutsch|", StringComparison.Ordinal)
                && await SignIn(login, current) == 0 && Clean(stopped),
                "Stop before the password leaves the options changed and the password as it was, and says so first: " + (stopped is null ? "an unknown outcome" : Steps(stopped)));
        }

        // A user replaced by another of the same name (another SID) between the preflight and its step: the step is refused and grants
        // nothing to the newcomer (finding 2). Then the preflight refuses an update and an unmap of the user that is gone (finding 16).
        actions.Options.BeforeStep = async (title, _) => { if (title == "Add to a database role") await Sql("DROP USER " + Bracket(user) + ";\nCREATE USER " + Bracket(user) + " WITHOUT LOGIN;", database); };
        ActionExecuteResult userSwapped;
        try { userSwapped = await actions.ExecuteAsync(Properties(login, new(Mappings: [new(database, "update", user, RolesAdd: ["db_datawriter"])]), identity), CancellationToken.None); }
        finally { actions.Options.BeforeStep = null; }
        var impostorRoles = (await Sql("SELECT COUNT(*) FROM sys.database_role_members AS m JOIN sys.database_principals AS u ON u.principal_id = m.member_principal_id WHERE u.name = " + Literal(user) + ";", database)).Scalar;
        check(userSwapped is { Error.Code: "NOT_FOUND" } && Steps(userSwapped) == "failed:Add to a database role/db_datawriter in " + database && impostorRoles == "0" && await Mapped(login) == "",
            "a user replaced under the same name after the preflight is refused at its step, and the newcomer gains no role: " + Steps(userSwapped) + " | " + userSwapped.Error?.Message);
        var updateGone = await actions.ExecuteAsync(Properties(login, new(Mappings: [new(database, "update", user, DefaultSchema: "dbo", RolesAdd: ["db_datawriter"])]), identity), CancellationToken.None);
        var unmapGone = await actions.ExecuteAsync(Properties(login, new(Mappings: [new(database, "unmap", user)]), identity), CancellationToken.None);
        check(updateGone is { Error.Code: "NOT_FOUND", Steps.Count: 0 } && unmapGone is { Error.Code: "NOT_FOUND", Steps.Count: 0 }
            && (await Sql("SELECT COUNT(*) FROM sys.database_principals WHERE name = " + Literal(user) + ";", database)).Scalar == "1",
            "the preflight refuses to update or unmap a user that is no longer the login's: " + updateGone.Error?.Code + " " + unmapGone.Error?.Code);
        // The login owning the database is dbo there, which Login Properties never changes.
        var owner = (await Sql("SELECT SUSER_SNAME(owner_sid) FROM sys.databases WHERE name = " + Literal(database) + ";")).Scalar ?? "";
        ActionExecuteResult dboChange;
        string? owned;
        try
        {
            owned = (await Sql("DROP USER " + Bracket(user) + ";\nALTER AUTHORIZATION ON DATABASE::" + Bracket(database) + " TO " + Bracket(login) + ";", database)).Error;
            dboChange = await actions.ExecuteAsync(Properties(login, new(Mappings: [new(database, "update", "dbo", DefaultSchema: schema)]), identity), CancellationToken.None);
        }
        finally { await Sql("ALTER AUTHORIZATION ON DATABASE::" + Bracket(database) + " TO " + Bracket(owner) + ";"); }
        check(owned is null && dboChange is { Error.Code: "NOT_SUPPORTED", Steps.Count: 0 },
            "the preflight refuses to change dbo, the user of the login that owns the database: " + owned + " " + dboChange.Error?.Code);
        // The login dropped and created again between the preflight and its step: that step is refused and the new login gains no role.
        actions.Options.BeforeStep = async (title, _) =>
        {
            if (title == "Add to a server role") await Sql("DROP LOGIN " + Bracket(login) + ";\nCREATE LOGIN " + Bracket(login) + " WITH PASSWORD = " + Literal(Remember(NewPassword())) + ", CHECK_POLICY = OFF;");
        };
        ActionExecuteResult loginSwapped;
        try { loginSwapped = await actions.ExecuteAsync(Properties(login, new(RolesAdd: ["dbcreator"]), identity), CancellationToken.None); }
        finally { actions.Options.BeforeStep = null; }
        check(loginSwapped is { Error.Code: "NOT_FOUND" } && Steps(loginSwapped) == "failed:Add to a server role/dbcreator" && await State(login) == "master|us_english|0|G|",
            "a login replaced under the same name after the preflight is refused at its step, and the newcomer gains no server role: " + Steps(loginSwapped) + " | " + loginSwapped.Error?.Message);

        // A login dropped and created again under the same name is not the one the dialog read: refused before anything runs.
        var recreated = await Sql("DROP LOGIN " + Bracket(login) + ";\nCREATE LOGIN " + Bracket(login) + " WITH PASSWORD = " + Literal(Remember(NewPassword())) + ", CHECK_POLICY = OFF;");
        var stale = await actions.ExecuteAsync(Properties(login, new(DefaultLanguage: "us_english"), identity), CancellationToken.None);
        check(recreated.Status == "completed" && stale is { Error.Code: "NOT_FOUND", Steps.Count: 0 } && (await State(login)).StartsWith("master|us_english|", StringComparison.Ordinal),
            "a login dropped and created again under the same name is refused by the identity the dialog read: " + stale.Error?.Code);

        // A new password with UNLOCK, where the server applies a lockout policy.
        var locked = scratch.OwnLogin("pl");
        var lockedPassword = Remember(NewPassword());
        await Sql("CREATE LOGIN " + Bracket(locked) + " WITH PASSWORD = " + Literal(lockedPassword) + ", CHECK_POLICY = ON, CHECK_EXPIRATION = OFF;");
        var bad = Remember(NewPassword());
        for (var attempt = 0; attempt < BadSignIns; attempt++) await SignIn(locked, bad);
        var lockedDescribed = await Describe(locked);
        if (lockedDescribed.Lock is not { Locked: true })
        {
            Console.WriteLine("Login Properties' UNLOCK check skipped: " + BadSignIns + " failed sign-ins did not lock a login out, so this server applies no lockout policy.");
            return;
        }
        var unlockedPassword = Remember(NewPassword());
        var unlocked = await actions.ExecuteAsync(Properties(locked, new(Password: new(false, true, false)), IdentityOf(lockedDescribed), new(unlockedPassword)), CancellationToken.None);
        check(unlocked.Error is null && Steps(unlocked) == "done:Change the password" && !(await actions.LoginLockFactsAsync(info.Id, locked, CancellationToken.None)).Locked
            && await SignIn(locked, unlockedPassword) == 0,
            "a new password with UNLOCK unlocks a locked-out login: " + unlocked.Error?.Message);
    }
}
