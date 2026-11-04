using Varia.Backend.Actions;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;
using Varia.Backend.Scripting;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of a login's Delete (D4c): the DropLogin template and its script, the plan (mapped users the option may
/// drop, then the login, in master), its step titles and details, which users a Delete keeps, the warnings and the refusals the
/// preflight gives, the scan's SQL and its lint, the login's errors and advice, and the engine gate before any connection.</summary>
internal static class LoginDeleteChecks
{
    private static readonly string NL = Environment.NewLine;
    private static string Id() => Guid.NewGuid().ToString();
    private static readonly ObjectRefDto AppUser = new("login", Name: "AppUser");
    private static readonly LoginIdentityDto Identity = new("01", "2026-01-01T00:00:00.000");

    private static ActionArgs Delete(ObjectRefDto target, bool? dropMappedUsers = null, LoginIdentityDto? identity = null) =>
        new("delete", Id(), Id(), target, null, false, false, LoginIdentity: identity, DropMappedUsers: dropMappedUsers);
    private static LoginFactsDto Facts(string subtype, string type = "S", bool own = false, int? sessions = 0, int? databases = 0, List<string>? names = null, int? objects = 0, int? jobs = 0, int? granted = 0) =>
        new(300, type, subtype, false, "01", "2026-01-01T00:00:00.000", null, null, false, own, false, sessions, databases, names ?? [], objects, true, true, false, OwnedJobs: jobs, GrantedPermissions: granted);
    private static MappedUserDto User(string database, string user, int schemas = 0, int roles = 0, bool readOnly = false, int securables = 0, int granted = 0, bool canDrop = true) =>
        new(database, user, schemas, roles, readOnly, securables, granted, canDrop);
    private static readonly PrincipalBinding Bound = new([0x01, 0x02], 300, new DateTime(2026, 1, 1, 0, 0, 0, 3));

    public static async Task RunAsync(Action<bool, string> check)
    {
        Templates(check);
        Guards(check);
        Plans(check);
        Warnings(check);
        Refusals(check);
        Scan(check);
        await ServiceAsync(check);
    }

    private static void Templates(Action<bool, string> check)
    {
        check(ActionSql.Statement(new(ActionTemplate.DropLogin, "master", ["App]User"])) == "DROP LOGIN [App]]User]"
            && ActionSql.ScriptText(new(ActionTemplate.DropLogin, "master", ["AppUser"])) == "USE [master]" + NL + "GO" + NL + "DROP LOGIN [AppUser]" + NL + "GO" + NL,
            "a login's Delete scripts DROP LOGIN in master, as SMO writes it");
        var failures = new List<string>();
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'").Append("\\"))
        {
            var name = ActionChecks.Long(fragment);
            var plan = new PlannedStatement(ActionTemplate.DropLogin, "master", [name]);
            if (ActionSql.Statement(plan) != "DROP LOGIN [" + name.Replace("]", "]]", StringComparison.Ordinal) + "]" || SqlScript.Parse(ActionSql.ScriptText(plan)).Count != 2) failures.Add(fragment[..1]);
        }
        check(failures.Count == 0, "a login's DROP quotes hostile 128-unit names and splits into SSMS's two batches: " + string.Join(", ", failures));
        var executable = ActionSql.Executable(ActionTemplate.DropLogin);
        check(ActionSql.ParameterCount(ActionTemplate.DropLogin) == 1 && executable.Contains("N'DROP LOGIN ' + QUOTENAME(@p1)", StringComparison.Ordinal)
            && ActionSql.LintExecutable(executable, ActionTemplate.DropLogin).Count == 0
            && ActionSql.LintExecutable(executable.Replace("QUOTENAME(@p1)", "@p1", StringComparison.Ordinal), ActionTemplate.DropLogin).Count > 0
            && ActionSql.LintExecutable(ActionSql.Executable(ActionTemplate.RenameLogin), ActionTemplate.DropLogin).Count > 0,
            "the DROP LOGIN batch has SQL Server quote the name, and the lint refuses a bare name or a batch that binds two names");
    }

    /// <summary>The guarded DROPs (PrincipalBinding): SQL Server checks the principal by name and binding before the DROP and again
    /// after it in one transaction, the dry run selects only the DROP, and nothing runs a guarded DROP without its binding.</summary>
    private static void Guards(Action<bool, string> check)
    {
        var user = ActionSql.Executable(ActionTemplate.DropMappedUser);
        var login = ActionSql.Executable(ActionTemplate.DropLogin);
        check(user.Contains("N'DROP USER ' + QUOTENAME(@p1)", StringComparison.Ordinal) && user.Contains(ActionSql.UserCheck + " + @drop + " + ActionSql.UserRecheck, StringComparison.Ordinal)
            && user.EndsWith("EXEC @module @stmt, " + ActionSql.UserParameters + ", @name = @p1, @sid = @sid;", StringComparison.Ordinal)
            && login.Contains(ActionSql.LoginCheck + " + @drop + " + ActionSql.LoginRecheck, StringComparison.Ordinal)
            && login.EndsWith("EXEC @module @stmt, " + ActionSql.LoginParameters + ", @name = @p1, @sid = @sid, @principal = @principal, @created = @created;", StringComparison.Ordinal)
            && ActionSql.UserCheck.Contains("WHERE u.name = @name AND u.sid = @sid", StringComparison.Ordinal) && ActionSql.UserCheck.EndsWith("BEGIN TRANSACTION; '", StringComparison.Ordinal)
            && ActionSql.UserRecheck.Contains("WHERE u.principal_id = @principal) THROW 50010", StringComparison.Ordinal) && ActionSql.UserRecheck.EndsWith("COMMIT TRANSACTION;'", StringComparison.Ordinal)
            && ActionSql.LoginCheck.Contains("p.name = @name AND p.sid = @sid AND p.principal_id = @principal AND p.create_date = @created", StringComparison.Ordinal)
            && ActionSql.LoginRecheck.Contains("WHERE p.principal_id = @principal) THROW 50010", StringComparison.Ordinal),
            "a mapped user's and a login's DROP check the principal they were planned for, before the DROP and again after it in one transaction");
        check(ActionSql.Executable(ActionTemplate.DropMappedUser, dryRun: true).EndsWith("SELECT @drop AS stmt;", StringComparison.Ordinal)
            && ActionSql.Executable(ActionTemplate.DropLogin, dryRun: true).EndsWith("SELECT @drop AS stmt;", StringComparison.Ordinal)
            && new[] { "DropMappedUser", "DropMappedUser (dry run)", "DropLogin", "DropLogin (dry run)" }.All(name => ActionSql.Lint().Single(result => result.Name == name).Problems.Count == 0)
            && ActionSql.LintExecutable(user.Replace("QUOTENAME(@p1);", "@p1;", StringComparison.Ordinal), ActionTemplate.DropMappedUser).Count > 0
            && ActionSql.LintExecutable(login.Replace("@created = @created;", "@created = @when;", StringComparison.Ordinal), ActionTemplate.DropLogin).Count > 0
            && ActionSql.LintExecutable(user, ActionTemplate.DropUser).Count > 0,
            "the guarded DROPs pass the lint, which refuses a bare name, a variable they do not bind, and a binding on a template that takes none: "
            + string.Join("; ", ActionSql.Lint().Where(result => result.Name.StartsWith("Drop", StringComparison.Ordinal)).SelectMany(result => result.Problems.Select(problem => result.Name + " " + problem))));
        bool Throws(PlannedStatement plan) { try { ActionSql.Checked(plan); return false; } catch (InvalidOperationException) { return true; } }
        check(!Throws(new(ActionTemplate.DropMappedUser, "AppData", ["app"], Principal: new([0x01])))
            && !Throws(new(ActionTemplate.DropLogin, "master", ["AppUser"], Principal: Bound))
            && Throws(new(ActionTemplate.DropUser, "AppData", ["app"], Principal: new([0x01])))
            && Throws(new(ActionTemplate.DropLogin, "master", ["AppUser"], Principal: new([0x01])))
            && Throws(new(ActionTemplate.DropMappedUser, "AppData", ["app"], Principal: Bound))
            && Throws(new(ActionTemplate.DropMappedUser, "AppData", ["app"], Principal: new(new byte[86])))
            && ActionSql.Guarded(ActionTemplate.DropMappedUser) && ActionSql.Guarded(ActionTemplate.DropLogin) && !ActionSql.Guarded(ActionTemplate.DropUser),
            "a binding fits only its guarded template: a SID of 1 to 85 bytes, and for a login its principal id and create date");
        check(ActionErrors.CodeOf(ConnectionFailureChecks.Sql(50010, 1, 16, "server", "changed"), null) == "NOT_FOUND"
            && ActionErrors.CodeOf(ConnectionFailureChecks.Sql(15173, 1, 16, "server", "granted"), null) == "DEPENDENTS",
            "a guarded DROP that met another principal answers NOT_FOUND, and a login's granted server permissions (15173) DEPENDENTS");
    }

    private static void Plans(Action<bool, string> check)
    {
        var users = new[] { User("AppData", "app"), User("Sales", "owner", schemas: 1), User("Hr", "roles", roles: 2), User("Archive", "old", readOnly: true), User("Ops]", "o'ps"),
            User("Keys", "certs", securables: 2), User("Grants", "grantor", granted: 1), User("Locked", "denied", canDrop: false) };
        var plain = ActionService.Plan(Delete(AppUser), AppUser, users: users);
        var off = ActionService.Plan(Delete(AppUser, false), AppUser, users: users);
        var drop = ActionService.Plan(Delete(AppUser, true), AppUser, users: users);
        check(plain.Single() is { Template: ActionTemplate.DropLogin, Database: "master" } login && login.Names.SequenceEqual(["AppUser"]) && off.Count == 1
            && ActionService.Plan(Delete(AppUser, true), AppUser).Single().Template == ActionTemplate.DropLogin,
            "a login's Delete without its mapped users plans only DROP LOGIN in master");
        check(drop.Count == 3 && drop[0] is { Template: ActionTemplate.DropMappedUser, Database: "AppData", Principal: null } first && first.Names.SequenceEqual(["app"])
            && drop[1] is { Template: ActionTemplate.DropMappedUser, Database: "Ops]" } second && second.Names.SequenceEqual(["o'ps"])
            && drop[2] is { Template: ActionTemplate.DropLogin, Database: "master", Principal: null } && drop.All(step => step.Kind == StepKind.Main),
            "with its mapped users, it drops those it may, each in its database, then the login, and keeps every user whose DROP USER would fail");
        var bound = ActionService.Plan(Delete(AppUser, true, Identity), AppUser, users: users, login: Bound);
        check(bound.Count == 3 && bound.Take(2).All(step => step.Principal is { PrincipalId: null, Created: null } principal && principal.Sid.SequenceEqual(Bound.Sid))
            && bound[2].Principal == Bound && bound.All(step => ActionSql.Checked(step) == step),
            "the execute binds each user's DROP to the login's SID, and the login's to its SID, principal id and create date");
        check(ActionService.Kept(users[1]) && ActionService.Kept(users[2]) && ActionService.Kept(users[3]) && !ActionService.Kept(users[0]) && !ActionService.Kept(users[4])
            && ActionService.Kept(users[5]) && ActionService.Kept(users[6]) && ActionService.Kept(users[7]),
            "a Delete keeps a user that owns a schema, role or other securable, has granted permissions, is in a read-only database, or where it may not drop users");
        check(ActionService.StepTitle(ActionTemplate.DropLogin) == "Drop the login" && ActionService.StepTitle(ActionTemplate.DropMappedUser) == "Drop the database user"
            && ActionService.StepTitle(ActionTemplate.DropUser) == "Drop the database user"
            && ActionService.StepDetail(drop[1]) == "o'ps in Ops]" && ActionService.StepDetail(drop[2]) is null
            && ActionService.StepDetail(new(ActionTemplate.DropMappedUser, "A\nB", ["u‮"])) == ScriptingErrors.Display("u‮") + " in " + ScriptingErrors.Display("A\nB"),
            "the login's step is Drop the login, each user's names its user and database as they are displayed, reading cleanly after the title's colon");
        check(ActionService.ScriptText(drop) == "USE [AppData]" + NL + "GO" + NL + "DROP USER [app]" + NL + "GO" + NL + "USE [Ops]]]" + NL + "GO" + NL + "DROP USER [o'ps]" + NL + "GO" + NL
            + "USE [master]" + NL + "GO" + NL + "DROP LOGIN [AppUser]" + NL + "GO" + NL,
            "Script Action writes each user's DROP in its database, then the login's in master");
    }

    private static void Warnings(Action<bool, string> check)
    {
        var none = ActionService.LoginDeleteWarnings(Facts("sql"), null);
        var unknown = ActionService.LoginDeleteWarnings(Facts("sql", sessions: null, databases: null, objects: null, jobs: null, granted: null), null);
        var all = ActionService.LoginDeleteWarnings(Facts("windowsUser", "U", sessions: 2, databases: 3, names: ["A]", "B"], objects: 1, jobs: 4, granted: 2), @"MSSQL$SQL2");
        check(none.Count == 0 && unknown.Count == 0, "a login that owns nothing and has no sessions (or whose counts could not be read) has no warnings");
        check(all.Select(warning => warning.Text).SequenceEqual([
                "2 sessions are connected as this login; the DROP fails until they end. Activity Monitor can end them.",
                "Owns 3 databases (A], B and 1 more); the DROP fails until their owner is changed.",
                "Owns 4 SQL Server Agent jobs; the DROP fails until they are reassigned or deleted.",
                "Owns 1 server role, endpoint or availability group; the DROP fails until it is reassigned.",
                "Has granted 2 server permissions to other principals; the DROP fails until they are revoked.",
                @"MSSQL$SQL2 runs as this account."])
            && all.Take(5).All(warning => warning.Blocking) && !all[5].Blocking,
            "Delete Object's warnings name what SQL Server refuses the DROP for, blocking, and the service that runs as the login, not blocking");
        check(ActionService.SessionsWarning(1) == "1 session is connected as this login; the DROP fails until it ends. Activity Monitor can end it."
            && ActionService.SessionsWarning(1234).StartsWith("1,234 sessions", StringComparison.Ordinal)
            && ActionService.OwnedDatabasesWarning(1, ["AppData"]) == "Owns the database AppData; the DROP fails until its owner is changed."
            && ActionService.OwnedDatabasesWarning(2, []) == "Owns 2 databases; the DROP fails until their owner is changed."
            && ActionService.JobsWarning(1) == "Owns 1 SQL Server Agent job; the DROP fails until it is reassigned or deleted."
            && ActionService.ServerObjectsWarning(2) == "Owns 2 server roles, endpoints or availability groups; the DROP fails until they are reassigned."
            && ActionService.GrantedWarning(1) == "Has granted 1 server permission to another principal; the DROP fails until it is revoked."
            && ActionService.UnreadDatabases(1) == "1 database could not be read again, so the database users mapped to the login there would be left orphaned. Try again, or delete the login without its users."
            && ActionService.UnreadDatabases(1200).StartsWith("1,200 databases could not", StringComparison.Ordinal),
            "the warnings count in the singular and plural, with thousands separators");
        check(ActionErrors.LoginSessionsAdvice == "End the login's sessions first; Activity Monitor can end them." && ActionErrors.CodeOf(ConnectionFailureChecks.Sql(15434, 1, 16, "server", "failed"), null) == "IN_USE",
            "a DROP that a session the preflight could not see fails answers IN_USE with the advice to end it");
    }

    private static void Refusals(Action<bool, string> check)
    {
        using var service = new ActionService(new ActionChecks.FakeHost());
        var cases = new (string Name, LoginFactsDto Facts, ActionArgs Args, string? Code, string? Message)[]
        {
            ("sa", Facts("sa"), Delete(new ObjectRefDto("login", Name: "sa")), "NOT_SUPPORTED", "The sa login cannot be deleted."),
            ("the own login", Facts("sql", own: true), Delete(AppUser), "NOT_SUPPORTED", "This is the login this connection uses. Connect with another login to change it."),
            ("SQL Server's own login", Facts("system"), Delete(AppUser), "NOT_SUPPORTED", "This login belongs to SQL Server and cannot be changed."),
            ("a Windows group", Facts("windowsGroup", "G"), Delete(AppUser, true, Identity), null, null),
            ("a plain login", Facts("sql"), Delete(AppUser, false, Identity), null, null),
            // The name now belongs to another principal: the user never saw its facts, so neither its rules nor its warnings get a say.
            ("another SID", Facts("sa"), Delete(AppUser, true, Identity with { Sid = "02" }), "NOT_FOUND", null),
            ("another create date", Facts("sql"), Delete(AppUser, null, Identity with { Created = "2026-01-01T00:00:00.003" }), "NOT_FOUND", null)
        };
        var wrong = cases.Where(item => service.LoginRefusal(item.Facts, item.Args) is var refused && (refused?.Code != item.Code || item.Message is not null && refused?.Message != item.Message))
            .Select(item => item.Name).ToList();
        check(wrong.Count == 0, "a login's Delete refuses sa, its own login, SQL Server's own and a login that is not the one read: " + string.Join(", ", wrong));
        // Execute binds every DROP to the login Delete Object read, so it needs its identity; Script runs nothing and may leave it out.
        bool Invalid(ActionArgs args, bool script) { try { service.Validate(args, script); return false; } catch (RequestException error) { return error.Code == "INVALID_PARAMS"; } }
        check(Invalid(Delete(AppUser, true), script: false) && Invalid(Delete(AppUser), script: false) && !Invalid(Delete(AppUser, true), script: true) && !Invalid(Delete(AppUser, true, Identity), script: false),
            "a login's Delete execute without the identity it read is invalid; its script is not");
        check(service.TooManyMappedUsers == "The login is mapped to more than 100 database users. Delete them in each database first, or delete the login without them.",
            "a Delete that would drop more mapped users than it lists says so with the catalogue's bound");
    }

    private static void Scan(Action<bool, string> check)
    {
        var lint = ActionSql.Lint().ToList();
        check(new[] { "login databases", "mapped user", "mapped user call", "login jobs", "DropLogin", "DropLogin (dry run)" }.All(name => lint.SingleOrDefault(result => result.Name == name).Problems is { Count: 0 }),
            "the scan's statements, the jobs count and DROP LOGIN pass the lint");
        // Inside a database the scan reads only that database's catalog; HAS_DBACCESS belongs to the master-side database list.
        check(ActionSql.LintCatalog(ActionSql.MappedUser.Replace("u.principal_id > 4", "u.principal_id > 4 AND HAS_DBACCESS(DB_NAME()) = 1", StringComparison.Ordinal), ExplorerCatalog.MaxBand, database: true).Count > 0
            && ActionSql.LintCatalog(ActionSql.MappedUser.Replace("SELECT TOP (@take) u.name", "SELECT TOP (@take) SUSER_SNAME(u.sid) AS login, u.name", StringComparison.Ordinal), ExplorerCatalog.MaxBand, database: true).Count > 0
            && ActionSql.LintCatalog(ActionSql.MappedUserCall.Replace("@take int'", "@take int, @name sysname'", StringComparison.Ordinal), ExplorerCatalog.MaxBand, database: false).Count > 0
            && ActionSql.MappedUserCall.StartsWith("DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';", StringComparison.Ordinal),
            "the lint refuses HAS_DBACCESS or a metadata built-in inside a database and a call's parameter list it does not know, and the call quotes its database");
        // The total is its own statement, first: a connection that may open no database still learns how many it did not check.
        check(ActionSql.LoginDatabases.StartsWith("SELECT COUNT(*) AS total FROM sys.databases AS a WHERE a.source_database_id IS NULL;", StringComparison.Ordinal)
            && ActionSql.LoginDatabases.Contains("HAS_PERMS_BY_NAME(d.name, N'DATABASE', N'ALTER ANY USER')", StringComparison.Ordinal)
            && ActionSql.MappedUser.Contains("g.grantor_principal_id = u.principal_id AND g.grantee_principal_id <> u.principal_id", StringComparison.Ordinal)
            && ActionSql.MappedUser.Contains("AS owned_securables", StringComparison.Ordinal) && ActionSql.Login.Contains("g.grantor_principal_id = p.principal_id AND g.grantee_principal_id <> p.principal_id", StringComparison.Ordinal)
            && ActionSql.Login.Contains("sys.availability_replicas AS ar WHERE ar.owner_sid = p.sid", StringComparison.Ordinal) && !ActionSql.LoginAlter.Contains("granted_permissions", StringComparison.Ordinal),
            "the scan counts every database apart from those it lists and reads where users may be dropped, what a user's DROP fails on, and the login's grants and availability groups");
        check(ActionSql.LoginDatabases.Contains("d.state = 0", StringComparison.Ordinal) && ActionSql.LoginDatabases.Contains("d.source_database_id IS NULL", StringComparison.Ordinal)
            && ActionSql.LoginDatabases.Contains("HAS_DBACCESS(d.name) = 1", StringComparison.Ordinal) && ActionSql.LoginDatabases.Contains("N'VIEW DEFINITION'", StringComparison.Ordinal)
            && ActionSql.MappedUser.Contains("u.sid = @sid", StringComparison.Ordinal) && ActionSql.MappedUser.Contains("u.principal_id > 4", StringComparison.Ordinal)
            && ActionSql.MappedUserCall.Contains("@sid = @sid, @take = @take", StringComparison.Ordinal),
            "the scan reads online databases (no snapshots) the login can see the users of, and in each only users of the SID, never dbo, guest or the schemas' fixed principals");
        var scan = new LoginScan([User("A", "a")], 3, [new("A", false, true), new("B", true, false), new("C", false, true)], 2);
        check(scan.Checked == 2 && scan.NotChecked == 3 && scan.Dto is { Mapped: 3, Checked: 2, NotChecked: 3 } dto && dto.Users.Count == 1,
            "the scan counts databases it did not read, and those past its bound, as not checked");
        check(new LoginScan([], 0, [], 12).Dto is { Mapped: 0, Checked: 0, NotChecked: 12 }, "a scan that may read no database counts every one as not checked, never as none mapped");
    }

    private static async Task ServiceAsync(Action<bool, string> check)
    {
        var host = new ActionChecks.FakeHost(5);
        using var cloud = new ActionService(host);
        var describe = await cloud.DescribeAsync(new(Id(), Id(), "deleteObject", AppUser), CancellationToken.None);
        var script = await cloud.ScriptAsync(Delete(AppUser, true), CancellationToken.None);
        var execute = await cloud.ExecuteAsync(Delete(AppUser, true, Identity), CancellationToken.None);
        check(describe.Error?.Code == "NOT_SUPPORTED" && script.Error?.Code == "NOT_SUPPORTED" && execute.Error?.Code == "NOT_SUPPORTED" && execute.Steps.Count == 0 && host.Connections == 0,
            "Azure SQL Database answers a login's Delete NOT_SUPPORTED before any connection opens");
        var unreachable = new ActionChecks.FakeHost();
        using var service = new ActionService(unreachable);
        var failed = await service.ExecuteAsync(Delete(AppUser, true, Identity), CancellationToken.None);
        check(failed.Error is not null && failed.Steps.Count == 0 && unreachable.Connections == 1 && service.RunningCount == 0,
            "a login's Delete that cannot connect answers an error value, runs no step and frees its request");
    }
}
