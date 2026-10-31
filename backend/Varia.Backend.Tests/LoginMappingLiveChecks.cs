using Varia.Backend.Actions;

namespace Varia.Backend.Tests;

/// <summary>Live checks of PR D2b, New Login's User Mapping, with VARIA_TEST_SQL_SCRATCH=1 and a sysadmin connection, in the scratch
/// databases VariaScratch_…_lgm and _lgmo (offline) with logins named VariaScratch_…_l…: the roles describe (roles, guest, schemas)
/// and its refusals; a real create mapping a user with hostile names, a missing default schema (created, owned by the user) and two
/// roles; an existing default schema (no CREATE SCHEMA); the per-database preflight refusing a name in use, a missing role, a missing
/// and an offline database before anything runs; a role that vanishes mid-plan and Stop before CREATE USER, each reply starting with
/// the login's real state; and the script: unedited it runs nothing, edited it creates all of it, and edited with a role that does
/// not exist it rolls back whole (XACT_ABORT), the login included. Passwords are throwaway and never printed.</summary>
internal static class LoginMappingLiveChecks
{
    public static async Task RunAsync(Action<bool, string> check, ActionService actions, ConnectionInfo info, ScratchDatabase scratch, Func<string, string, int, Task<SqlRun>> sql)
    {
        Task<SqlRun> Sql(string text, string database = "master") => sql(text, database, 300);
        static string N(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
        static string B(string value) => "[" + value.Replace("]", "]]", StringComparison.Ordinal) + "]";
        static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title + (step.Detail is null ? "" : "/" + step.Detail)));
        ActionArgs Create(string login, string? password, params UserMappingDto[] mappings) =>
            LoginChecks.Create(LoginChecks.Sql(login, false, false, false), password, mappings: [.. mappings]) with { ConnectionId = info.Id };
        var password = ScratchDatabase.Throwaway();

        var (database, offline) = await scratch.CreateMappingDatabasesAsync();
        const string role = "Varia]r'ole", gone = "VariaGone", taken = "taken";
        var setUp = await Sql("CREATE ROLE " + B(role) + ";\nCREATE ROLE " + B(gone) + ";\nCREATE USER " + B(taken) + " WITHOUT LOGIN;", database);
        check(setUp.Status == "completed", "the User Mapping database's roles and user are created: " + setUp.Error);
        async Task<string> Logins(params string[] names) => (await Sql("SELECT COUNT(*) FROM sys.server_principals WHERE name IN (" + string.Join(", ", names.Select(N)) + ");")).Scalar ?? "";
        async Task<string> Users(params string[] names) => (await Sql("SELECT COUNT(*) FROM sys.database_principals WHERE name IN (" + string.Join(", ", names.Select(N)) + ");", database)).Scalar ?? "";
        async Task<string> Schemas(params string[] names) => (await Sql("SELECT COUNT(*) FROM sys.schemas WHERE name IN (" + string.Join(", ", names.Select(N)) + ");", database)).Scalar ?? "";
        // A user's login, default schema, the owner of the schema named, and its roles by name, comma separated.
        async Task<string> Mapped(string user, string schema) => string.Join("|", (await Sql("SELECT SUSER_SNAME(u.sid), u.default_schema_name, "
            + "(SELECT o.name FROM sys.schemas AS s JOIN sys.database_principals AS o ON o.principal_id = s.principal_id WHERE s.name = " + N(schema) + "), "
            + "ISNULL((SELECT STRING_AGG(r.name, N',') WITHIN GROUP (ORDER BY r.name) FROM sys.database_role_members AS m JOIN sys.database_principals AS r ON r.principal_id = m.role_principal_id "
            + "WHERE m.member_principal_id = u.principal_id), N'') FROM sys.database_principals AS u WHERE u.name = " + N(user) + ";", database)).Sets.SelectMany(set => set).SelectMany(row => row));

        // The roles describe: the database's roles, its schemas, and whether guest may connect there (master's may).
        Task<ActionDescribeResult> Describe(string name) => actions.DescribeAsync(new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "loginDatabaseRoles", new ObjectRefDto("database", Name: name)), CancellationToken.None);
        var described = await Describe(database);
        var master = await Describe("master");
        var offlineDescribed = await Describe(offline);
        var missingDescribed = await Describe(scratch.Name + "_none");
        check(described.LoginDatabaseRoles is { Guest: false, RolesTruncated: false, SchemasTruncated: false } roles
            && new[] { "public", "db_owner", "db_datareader", role, gone }.All(roles.Roles.Contains) && !roles.Roles.Contains(taken) && roles.Schemas.Contains("dbo")
            && master.LoginDatabaseRoles is { Guest: true } && offlineDescribed is { Error.Code: "DATABASE_UNAVAILABLE", LoginDatabaseRoles: null } && missingDescribed.Error?.Code == "NOT_FOUND",
            "User Mapping's describe lists a database's roles and schemas and whether guest may connect (master's may), and refuses an offline or missing database: "
            + string.Join(",", described.LoginDatabaseRoles?.Roles ?? []) + " | " + offlineDescribed.Error?.Code + " " + missingDescribed.Error?.Code);

        // A real create: a user with a hostile name, a default schema that does not exist (SSMS creates it, owned by the user), two roles.
        var login = scratch.OwnLogin("map");
        const string user = "Map]u'ser", schema = "Map]s'chema";
        var created = await actions.ExecuteAsync(Create(login, password, LoginMappingChecks.Map(database, user, schema, role, "db_datareader")), CancellationToken.None);
        var mapped = await Mapped(user, schema);
        check(created.Error is null && Steps(created) == "done:Create the login, done:Create a user/" + database + ", done:Set the default schema/" + database + ", done:Create a schema/" + database
                + ", done:Add to a database role/db_datareader in " + database + ", done:Add to a database role/" + role + " in " + database
            && mapped == login + "|" + schema + "|" + user + "|db_datareader," + role,
            "New Login maps the login: CREATE USER, its default schema, the schema it lacked (owned by the user) and each role, in SSMS's order: " + Steps(created) + " | " + mapped);

        // A default schema the database has: no CREATE SCHEMA.
        var dboLogin = scratch.OwnLogin("mapdbo");
        var dbo = await actions.ExecuteAsync(Create(dboLogin, password, LoginMappingChecks.Map(database, dboLogin, "dbo")), CancellationToken.None);
        check(dbo.Error is null && Steps(dbo) == "done:Create the login, done:Create a user/" + database + ", done:Set the default schema/" + database && await Mapped(dboLogin, "dbo") == dboLogin + "|dbo|dbo|",
            "a default schema the database has gets no CREATE SCHEMA: " + Steps(dbo));

        // The per-database preflight refuses before anything runs: no login is created.
        var refusedLogin = scratch.OwnLogin("maprf");
        var inUse = await actions.ExecuteAsync(Create(refusedLogin, password, LoginMappingChecks.Map(database, taken)), CancellationToken.None);
        var roleName = await actions.ExecuteAsync(Create(refusedLogin, password, LoginMappingChecks.Map(database, role)), CancellationToken.None);
        var noRole = await actions.ExecuteAsync(Create(refusedLogin, password, LoginMappingChecks.Map(database, "u", null, "VariaNoRole")), CancellationToken.None);
        var noDatabase = await actions.ExecuteAsync(Create(refusedLogin, password, LoginMappingChecks.Map(scratch.Name + "_none", "u")), CancellationToken.None);
        var offlineRun = await actions.ExecuteAsync(Create(refusedLogin, password, LoginMappingChecks.Map(database, "u2"), LoginMappingChecks.Map(offline, "u")), CancellationToken.None);
        var refusals = new[] { inUse, roleName, noRole, noDatabase, offlineRun };
        check(refusals.Select(result => result.Error?.Code).SequenceEqual(["NAME_IN_USE", "NAME_IN_USE", "NOT_FOUND", "NOT_FOUND", "DATABASE_UNAVAILABLE"]) && refusals.All(result => result.Steps.Count == 0)
            && await Logins(refusedLogin) == "0" && await Users("u", "u2") == "0"
            && !refusals.Any(result => System.Text.Json.JsonSerializer.Serialize(result).Contains(password, StringComparison.Ordinal)),
            "User Mapping's preflight refuses a user or role name in use, a missing role, and a missing or offline database before anything runs, so no login is created: "
            + string.Join(", ", refusals.Select(result => result.Error?.Code ?? "ok")));

        // A role that vanishes after the preflight fails its step: the login and user stay, and the reply says so first.
        var partialLogin = scratch.OwnLogin("mapprt");
        actions.Options.BeforeStep = async (title, _) => { if (title == "Add to a database role") await Sql("DROP ROLE " + B(gone) + ";", database); };
        ActionExecuteResult partial;
        try { partial = await actions.ExecuteAsync(Create(partialLogin, password, LoginMappingChecks.Map(database, partialLogin, null, gone)), CancellationToken.None); }
        finally { actions.Options.BeforeStep = null; }
        check(partial.Error is { } partialError && partialError.Message.StartsWith(ActionService.LoginCreatedMessage + " " + ActionService.LoginMappingsMessage + " ", StringComparison.Ordinal)
            && Steps(partial) == "done:Create the login, done:Create a user/" + database + ", failed:Add to a database role/" + gone + " in " + database
            && await Logins(partialLogin) == "1" && await Mapped(partialLogin, "dbo") == partialLogin + "|dbo|dbo|",
            "a database role that vanished fails after the login and user were created, which stay, and the reply says first that a database is not mapped as chosen: "
            + Steps(partial) + " | " + partial.Error?.Message);

        // Stop before CREATE USER: the login stays unmapped, and the reply starts with that.
        var stopLogin = scratch.OwnLogin("mapstop");
        using var stop = new CancellationTokenSource();
        actions.Options.BeforeStep = (title, _) => { if (title == "Create a user") stop.Cancel(); return Task.CompletedTask; };
        ActionExecuteResult? stopped = null;
        try { stopped = await actions.ExecuteAsync(Create(stopLogin, password, LoginMappingChecks.Map(database, stopLogin, null, "db_datareader")), stop.Token); }
        catch (OperationCanceledException) { }
        finally { actions.Options.BeforeStep = null; }
        check(stopped is { Error.Code: "CANCELLED" } && stopped.Error.Message.StartsWith(ActionService.LoginCreatedMessage + " " + ActionService.LoginMappingsMessage + " The action was stopped", StringComparison.Ordinal)
            && Steps(stopped) == "done:Create the login, cancelled:Create a user/" + database + ", skipped:Add to a database role/db_datareader in " + database
            && await Logins(stopLogin) == "1" && await Users(stopLogin) == "0",
            "Stop before CREATE USER leaves the login unmapped and says so first: " + (stopped is null ? "an unknown outcome" : Steps(stopped) + " | " + stopped.Error?.Message));

        // Script runs nothing unedited; edited (the password typed in), its one transaction creates everything, or nothing when a
        // statement fails (here a role the database lacks, which Script does not refuse: it never reads roles).
        async Task<SqlRun> RunScript(string name, UserMappingDto mapping, bool edited)
        {
            var script = await actions.ScriptAsync(Create(name, null, mapping) with { Secrets = null }, CancellationToken.None);
            var text = script.Text ?? "";
            return await Sql(edited ? text.Replace(LoginSql.Placeholder, N(password), StringComparison.Ordinal) : text);
        }
        var unedited = scratch.OwnLogin("mapune");
        var uneditedRun = await RunScript(unedited, LoginMappingChecks.Map(database, "Une]u", "Une]s", "db_datareader"), edited: false);
        var scripted = scratch.OwnLogin("mapscr");
        var scriptedRun = await RunScript(scripted, LoginMappingChecks.Map(database, "Scr]u'ser", "Scr]s'chema", "db_datareader", role), edited: true);
        var rolledBack = scratch.OwnLogin("maprb");
        var rolledBackRun = await RunScript(rolledBack, LoginMappingChecks.Map(database, "Rb]u", "Rb]s", "db_datareader", "VariaNoRole"), edited: true);
        var scriptedMapped = await Mapped("Scr]u'ser", "Scr]s'chema");
        check(uneditedRun.Status != "completed" && await Logins(unedited) == "0" && await Users("Une]u") == "0" && await Schemas("Une]s") == "0",
            "an unedited script with a mapping fails to parse and runs nothing: no login, user or schema: " + uneditedRun.Status);
        check(scriptedRun.Status == "completed" && scriptedMapped == scripted + "|Scr]s'chema|Scr]u'ser|db_datareader," + role,
            "the script with the password typed in creates the login, its user, the schema it lacked and its roles, as OK would: " + scriptedRun.Status + " " + scriptedRun.Error + " | " + scriptedMapped);
        check(rolledBackRun.Status != "completed" && await Logins(rolledBack) == "0" && await Users("Rb]u") == "0" && await Schemas("Rb]s") == "0",
            "the edited script rolls back whole when a mapped role does not exist: no login, user or schema remains: " + rolledBackRun.Status);
    }
}
