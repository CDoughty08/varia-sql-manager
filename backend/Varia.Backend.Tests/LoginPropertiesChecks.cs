using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of Login Properties (D2c): its three new templates, the ALTER LOGIN builders for the options and the
/// password (and their lint, which must refuse every misuse of @old_password), the plan in SSMS's order, Script Action's two forms,
/// validation parity with zod, the login's rules and identity, the message of a run that changed the login in part, and the
/// kind-scoped dialog action that routes a login's Properties.</summary>
internal static class LoginPropertiesChecks
{
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static readonly string NL = Environment.NewLine;
    private static string Id() => Guid.NewGuid().ToString();
    private static readonly ObjectRefDto App = new("login", Name: "app_login");
    private static readonly LoginIdentityDto Identity = new("01", "2026-01-01T00:00:00.000");
    private static readonly LoginPasswordChangeDto NewPassword = new(false, false, false);
    private static ActionArgs Properties(LoginChangesDto changes, ObjectRefDto? target = null) => new("loginProperties", Id(), Id(), target ?? App, LoginChanges: changes);
    private static LoginFactsDto Facts(string subtype = "sql", string type = "S", bool own = false) =>
        new(300, type, subtype, false, "01", "2026-01-01T00:00:00.000", type == "S" ? true : null, type == "S" ? true : null, false, own, false, 0, null, [], null, true, true, false);

    public static void Run(Action<bool, string> check)
    {
        Templates(check);
        Builders(check);
        BuilderLint(check);
        Plans(check);
        ScriptText(check);
        Validation(check);
        Refusals(check);
        Messages(check);
        // The A16 Extended Events check (CI only) waits for this text to know it recorded the batch that carries both passwords.
        check(LoginSql.PasswordExecutable(new(true, false, false)).Contains(LoginLiveChecks.XeOldMarker, StringComparison.Ordinal) && !LoginSql.PasswordExecutable(NewPassword).Contains(LoginLiveChecks.XeOldMarker, StringComparison.Ordinal),
            "the Extended Events check finds Login Properties' password batch with Specify old password by its old password's guard");
    }

    private static void Templates(Action<bool, string> check)
    {
        check(ActionSql.Statement(new(ActionTemplate.DropServerRoleMember, "master", ["bulk]admin", "app]login"])) == "ALTER SERVER ROLE [bulk]]admin] DROP MEMBER [app]]login]"
            && ActionSql.Statement(new(ActionTemplate.RenameUser, "AppData", ["app", "app]2"])) == "ALTER USER [app] WITH NAME=[app]]2]"
            && ActionSql.Statement(new(ActionTemplate.DropRoleMember, "AppData", ["db_owner", "app"])) == "ALTER ROLE [db_owner] DROP MEMBER [app]",
            "Login Properties' removals and rename are SMO's statements, the role first, the user before its new name (D2 §4)");
        var templates = new[] { ActionTemplate.DropServerRoleMember, ActionTemplate.RenameUser, ActionTemplate.DropRoleMember };
        check(templates.All(template => ActionSql.ParameterCount(template) == 2 && ActionSql.LintExecutable(ActionSql.Executable(template), template).Count == 0
                && ActionSql.LintExecutable(ActionSql.Executable(template).Replace("QUOTENAME(@p2)", "@p2", StringComparison.Ordinal), template).Count > 0
                && ActionSql.LintExecutable(ActionSql.Executable(template).Replace("QUOTENAME(@p1)", "N'[x]'", StringComparison.Ordinal), template).Count > 0)
            && ActionService.StepTitle(ActionTemplate.DropServerRoleMember) == "Remove from a server role" && ActionService.StepTitle(ActionTemplate.RenameUser) == "Rename a user"
            && ActionService.StepTitle(ActionTemplate.DropRoleMember) == "Remove from a database role"
            && ActionService.StepDetail(new(ActionTemplate.DropServerRoleMember, "master", ["bulkadmin", "app"])) == "bulkadmin"
            && ActionService.StepDetail(new(ActionTemplate.DropRoleMember, "AppData", ["db_owner", "app"])) == "db_owner in AppData"
            && ActionService.StepDetail(new(ActionTemplate.RenameUser, "AppData", ["app", "app2"])) == "AppData",
            "the new templates have SQL Server quote both names and pass the lint, which refuses a bare or spliced name; their steps say what and where");
    }

    private static void Builders(Action<bool, string> check)
    {
        var all = new LoginChangesDto("App]Data", "us_english", false, false);
        check(LoginSql.OptionsStatement("a]b", all) == "ALTER LOGIN [a]]b] WITH DEFAULT_DATABASE=[App]]Data], DEFAULT_LANGUAGE=[us_english], CHECK_EXPIRATION=OFF, CHECK_POLICY=OFF"
            && LoginSql.OptionsStatement("a", new(CheckPolicy: true)) == "ALTER LOGIN [a] WITH CHECK_POLICY=ON"
            && LoginSql.OptionsStatement("a", new(CheckPolicy: true, CheckExpiration: true)) == "ALTER LOGIN [a] WITH CHECK_EXPIRATION=ON, CHECK_POLICY=ON",
            "the options are one ALTER LOGIN with only the changed clauses, in SMO's order");
        check(LoginSql.OptionsExecutable(all) == "DECLARE @stmt nvarchar(max) = N'ALTER LOGIN ' + QUOTENAME(@p1) + N' WITH DEFAULT_DATABASE=' + QUOTENAME(@p2) + N', DEFAULT_LANGUAGE=' + QUOTENAME(@p3)"
                + " + N', CHECK_EXPIRATION=OFF' + N', CHECK_POLICY=OFF';\n" + ActionSql.Guard + "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;"
            && LoginSql.OptionsExecutable(new(CheckPolicy: true), dryRun: true).EndsWith("SELECT @stmt AS stmt;", StringComparison.Ordinal),
            "the options' batch has SQL Server build the statement from constant clauses and QUOTENAME'd names, and the dry run returns it");
        var refused = false;
        try { _ = LoginSql.OptionsExecutable(new(Enabled: true)); } catch (InvalidOperationException) { refused = true; }
        check(refused, "the options' batch is never built without an option");
        check(LoginSql.PasswordStatement("a]b", NewPassword, null, null) == "ALTER LOGIN [a]]b] WITH PASSWORD=<password>"
            && LoginSql.PasswordStatement("a", new(true, false, false), null, null) == "ALTER LOGIN [a] WITH PASSWORD=<password> OLD_PASSWORD=<old password>"
            && LoginSql.PasswordStatement("a", new(false, true, true), null, null) == "ALTER LOGIN [a] WITH PASSWORD=<password> UNLOCK MUST_CHANGE"
            && LoginSql.PasswordStatement("a", new(true, true, true), "n'1", "o'2") == "ALTER LOGIN [a] WITH PASSWORD=N'n''1' OLD_PASSWORD=N'o''2'",
            "the password is SMO's ALTER LOGIN: PASSWORD, then OLD_PASSWORD, or UNLOCK and MUST_CHANGE (never both), with Script's placeholders");
        var old = LoginSql.PasswordExecutable(new(true, false, false));
        check(old.StartsWith(LoginSql.PasswordGuard + LoginSql.OldPasswordGuard, StringComparison.Ordinal)
            && old.Contains(LoginSql.PasswordExpression + " + " + LoginSql.OldPasswordExpression + ";", StringComparison.Ordinal)
            && !old.Contains("UNLOCK", StringComparison.Ordinal) && !old.Contains("MUST_CHANGE", StringComparison.Ordinal)
            && LoginSql.PasswordExecutable(new(false, true, true)).Contains(LoginSql.PasswordExpression + " + N' UNLOCK' + N' MUST_CHANGE';", StringComparison.Ordinal)
            && !LoginSql.PasswordExecutable(new(false, true, true)).Contains("@old_password", StringComparison.Ordinal),
            "the password's batch checks each password for NULL, then quotes each once on the server; the old password excludes UNLOCK and MUST_CHANGE");
        check(LoginSql.OptionsCorpus().Count() == 35 && LoginSql.PasswordCorpus().Count() == 5
            && LoginSql.OptionsCorpus().All(changes => LoginSql.LintExecutable(LoginSql.OptionsExecutable(changes)).Count == 0)
            && LoginSql.PasswordCorpus().All(change => LoginSql.LintExecutable(LoginSql.PasswordExecutable(change, dryRun: true)).Count == 0),
            "every options and password batch the builders write passes the builder lint, run and dry run");
    }

    private static void BuilderLint(Action<bool, string> check)
    {
        var old = LoginSql.PasswordExecutable(new(true, false, false));
        var options = LoginSql.OptionsExecutable(new("tempdb", CheckPolicy: true));
        var mutants = new (string Name, string Text)[]
        {
            ("the old password a third time", old.Replace("EXEC @module @stmt;", "SELECT @old_password AS p;\nEXEC @module @stmt;", StringComparison.Ordinal)),
            ("no NULL guard for the old password", old.Replace(LoginSql.OldPasswordGuard, "", StringComparison.Ordinal)),
            ("the old password's guard before the password's", LoginSql.OldPasswordGuard + old.Replace(LoginSql.OldPasswordGuard, "", StringComparison.Ordinal)),
            ("the old password unquoted", old.Replace(LoginSql.OldPasswordExpression, "N' OLD_PASSWORD=' + @old_password", StringComparison.Ordinal)),
            ("the old password through another collation", old.Replace("@old_password COLLATE Latin1_General_BIN2", "@old_password COLLATE Latin1_General_CI_AS", StringComparison.Ordinal)),
            ("the old password before the new one", old.Replace(LoginSql.PasswordExpression + " + " + LoginSql.OldPasswordExpression,
                LoginSql.OldPasswordExpression + " + " + LoginSql.PasswordExpression, StringComparison.Ordinal)),
            ("the old password as a name", old.Replace(LoginSql.OldPasswordExpression, "QUOTENAME(@old_password)", StringComparison.Ordinal)),
            ("UNLOCK with the old password as a literal", old.Replace(LoginSql.OldPasswordExpression + ";", LoginSql.OldPasswordExpression + " + N' UNLOCK, CHECK_POLICY=OFF';", StringComparison.Ordinal)),
            ("an option outside the fragments", options.Replace("N' WITH DEFAULT_DATABASE='", "N' WITH DEFAULT_DATABASE=master, CHECK_POLICY=OFF, DEFAULT_DATABASE='", StringComparison.Ordinal)),
            ("a bare default database", options.Replace("QUOTENAME(@p2)", "@p2", StringComparison.Ordinal)),
            ("a second statement", options.Replace("EXEC @module @stmt;", "EXEC @module @stmt;\nEXEC @module @stmt;", StringComparison.Ordinal)),
            ("dynamic SQL", options.Replace("EXEC @module @stmt;", "EXEC (@stmt);", StringComparison.Ordinal)),
            ("a hash", LoginSql.PasswordExecutable(NewPassword).Replace("N' UNLOCK'", "N' HASHED'", StringComparison.Ordinal)
                .Replace(LoginSql.PasswordExpression + ";", LoginSql.PasswordExpression + " + N' HASHED';", StringComparison.Ordinal))
        };
        var missed = mutants.Where(mutant => LoginSql.LintExecutable(mutant.Text).Count == 0).Select(mutant => mutant.Name).ToList();
        check(missed.Count == 0, "the builder lint refuses every misuse of the old password and every literal or statement the builders never write: " + string.Join(", ", missed));
    }

    private static void Plans(Action<bool, string> check)
    {
        var changes = new LoginChangesDto(RolesAdd: ["sysadmin", "dbcreator"], RolesDrop: ["bulkadmin"], Connect: "deny", Enabled: false, Mappings:
        [
            new("Sales", "map", "app", DefaultSchema: "sales", RolesAdd: ["db_owner"]),
            new("AppData", "update", "app", "app2", "dbo", ["db_owner"], ["db_datareader"]),
            new("Archive", "unmap", "old")
        ]);
        var sid = new byte[] { 1, 2 };
        var bound = new PrincipalBinding(sid, 300, new DateTime(2026, 1, 1));
        var server = LoginSql.PropertiesServerPlan("app_login", changes, bound);
        check(server.Select(plan => plan.Template).SequenceEqual([ActionTemplate.DenyConnect, ActionTemplate.DisableLogin, ActionTemplate.DropServerRoleMember, ActionTemplate.AddServerRoleMember,
                ActionTemplate.AddServerRoleMember])
            && server.Skip(2).Select(plan => plan.Names[0]).SequenceEqual(["bulkadmin", "dbcreator", "sysadmin"]) && server.All(plan => plan.Database == "master"),
            "the server statements follow SSMS: Connect, then Enabled, then each changed server role by name");
        check(server.All(plan => plan.Principal == bound && ReferenceEquals(ActionSql.Checked(plan), plan)) && LoginSql.PropertiesServerPlan("app_login", changes).All(plan => plan.Principal is null),
            "each server statement is bound to the login the preflight read (its SID, principal_id and create_date); Script's plan to none");
        var mapping = LoginSql.PropertiesMappingPlan("app_login", changes, new HashSet<string> { "Sales" }, bound);
        check(mapping.Select(plan => (plan.Database, plan.Template)).SequenceEqual([
                ("AppData", ActionTemplate.RenameUser), ("AppData", ActionTemplate.AlterUserSchema), ("AppData", ActionTemplate.DropRoleMember), ("AppData", ActionTemplate.AddRoleMember),
                ("Archive", ActionTemplate.DropMappedUser),
                ("Sales", ActionTemplate.CreateUserForLogin), ("Sales", ActionTemplate.AlterUserSchema), ("Sales", ActionTemplate.CreateSchemaFor), ("Sales", ActionTemplate.AddRoleMember)])
            && mapping[1].Names.SequenceEqual(["app2", "dbo"]) && mapping[2].Names.SequenceEqual(["db_datareader", "app2"]) && mapping[0].Names.SequenceEqual(["app", "app2"])
            && mapping[4].Principal is { } principal && principal.Sid.SequenceEqual(sid) && mapping[5].Names.SequenceEqual(["app", "app_login"]),
            "User Mapping's statements run per database by name: a rename before the schema and roles, which name the new user; a guarded DROP USER bound to the login's SID");
        check(mapping.All(plan => plan.Principal is { } binding && binding.Sid.SequenceEqual(sid) && (plan.Template == ActionTemplate.CreateUserForLogin) == (binding.PrincipalId == 300 && binding.Created is not null))
                && mapping.All(plan => ReferenceEquals(ActionSql.Checked(plan), plan)),
            "every User Mapping statement is bound: CREATE USER … FOR LOGIN to the login, the others to the user with the login's SID (finding 2)");
        string Binding(PlannedStatement plan) { try { ActionSql.Checked(plan); return "accepted"; } catch (InvalidOperationException) { return "refused"; } }
        var misfits = new (string Name, PlannedStatement Plan)[]
        {
            ("a user statement bound to the login", new(ActionTemplate.AddRoleMember, "AppData", ["db_owner", "app"], Principal: bound)),
            ("a login statement bound to a SID alone", new(ActionTemplate.DisableLogin, "master", ["app_login"], Principal: new(sid))),
            ("an unbindable statement", new(ActionTemplate.DropUser, "AppData", ["app"], Principal: new(sid))),
            ("a SID too long", new(ActionTemplate.AlterUserSchema, "AppData", ["app", "dbo"], Principal: new(new byte[86]))),
            ("an empty SID", new(ActionTemplate.EnableLogin, "master", ["app_login"], Principal: new([], 300, new DateTime(2026, 1, 1))))
        };
        var fitted = misfits.Where(misfit => Binding(misfit.Plan) != "refused").Select(misfit => misfit.Name).ToList();
        check(fitted.Count == 0, "a binding must fit its template: the login's for a login statement, a SID alone for a user's, none elsewhere: " + string.Join(", ", fitted));
        check(new[] { "login binding", "user binding call" }.All(name => ActionSql.Lint().Single(result => result.Name == name).Problems.Count == 0) && ActionSql.LoginBinding.Contains("p.create_date = @created", StringComparison.Ordinal) && ActionSql.LoginBinding.Contains("p.sid = @sid", StringComparison.Ordinal)
                && ActionSql.UserBindingCall.Contains("QUOTENAME(@db)", StringComparison.Ordinal) && ActionSql.UserBindingCall.Contains("@sid = @sid", StringComparison.Ordinal),
            "the binding checks are constant, linted text: the login by name, SID, principal_id and create_date, the user by name and SID in its database through QUOTENAME");
        check(LoginSql.PropertiesMappingPlan("app_login", changes, new HashSet<string>()).Single(plan => plan.Template == ActionTemplate.DropMappedUser).Principal is null,
            "Script's plan has no SID to bind");
        var full = changes with { DefaultDatabase = "AppData", Password = NewPassword };
        check(LoginSql.PropertiesStatements(full) == 2 + server.Count + LoginSql.PropertiesMappingPlan("app_login", full, new HashSet<string> { "Sales", "AppData" }).Count
            && LoginSql.PropertiesStatements(new()) == 0 && LoginSql.PropertiesStatements(new(Mappings: [new("A", "update", "u", DefaultSchema: "s")])) == 2,
            "the statement count bounds the plan: the options and password, the server's, and each database's with both schema steps");
    }

    private static void ScriptText(Action<bool, string> check)
    {
        var header = Catalog.Logins.ScriptHeader;
        var plain = new LoginChangesDto("AppData", Enabled: false, Mappings: [new("Sales", "update", "app", RolesDrop: ["db_owner"])]);
        var text = LoginSql.PropertiesScriptText("app]login", plain, new HashSet<string>(), header);
        check(text == "USE [master]" + NL + "GO" + NL + "ALTER LOGIN [app]]login] WITH DEFAULT_DATABASE=[AppData]" + NL + "GO" + NL + "ALTER LOGIN [app]]login] DISABLE" + NL + "GO" + NL
                + "USE [Sales]" + NL + "GO" + NL + "ALTER ROLE [db_owner] DROP MEMBER [app]" + NL + "GO" + NL
            && !text.Contains(header, StringComparison.Ordinal),
            "without a password, Script is SSMS's form: a GO after each statement and USE before each database's");
        var withPassword = LoginSql.PropertiesScriptText("app_login", plain with { Password = new(false, true, false) }, new HashSet<string>(), header);
        check(withPassword == "USE [master]" + NL + "GO" + NL + header + NL + "SET XACT_ABORT ON;" + NL + "BEGIN TRANSACTION;" + NL
                + "ALTER LOGIN [app_login] WITH DEFAULT_DATABASE=[AppData];" + NL + "ALTER LOGIN [app_login] WITH PASSWORD=<password> UNLOCK;" + NL + "ALTER LOGIN [app_login] DISABLE;" + NL
                + "EXEC [Sales].sys.sp_executesql N'ALTER ROLE [db_owner] DROP MEMBER [app]';" + NL + "COMMIT TRANSACTION;" + NL + "GO" + NL
            && SqlScript.Parse(withPassword).Count == 2,
            "with a password, Script is one XACT_ABORT batch under the placeholder header, each database's statement through its sp_executesql (critic A14)");
        var failures = new List<string>();
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'"))
        {
            var name = ActionChecks.Long(fragment);
            var changes = new LoginChangesDto(name, Password: new(true, false, false), RolesDrop: [name], Mappings: [new(name, "update", name, "n", name)]);
            var script = LoginSql.PropertiesScriptText(name, changes, new HashSet<string> { name }, header);
            var quoted = "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
            if (SqlScript.Parse(script).Count != 2 || !script.Contains("ALTER LOGIN " + quoted + " WITH DEFAULT_DATABASE=" + quoted + ";", StringComparison.Ordinal)
                || !script.Contains("EXEC " + quoted + ".sys.sp_executesql N'" + ("ALTER USER " + quoted).Replace("'", "''", StringComparison.Ordinal), StringComparison.Ordinal))
                failures.Add(fragment[..1]);
        }
        check(failures.Count == 0, "Login Properties' script quotes hostile 128-unit names in every statement and stays two batches: " + string.Join(", ", failures));
        using var service = new ActionService(new ActionChecks.FakeHost());
        check(service.LoginPropertiesWarnings("l]x", new(Mappings: [new("Sales", "unmap", "a]b"), new("AppData", "unmap", "app"), new("Hr", "update", "x", "y")],
                Permissions: [new(new("login", "t]1"), "ALTER", "deny", true), new(new("server"), "SHUTDOWN", "revoke"), new(new("server"), "VIEW SERVER STATE", "revokeGrantOption"), new(new("server"), "ALTER TRACE", "revoke", true)]))
                .SequenceEqual(["Drops the user [app] in [AppData].", "Drops the user [a]]b] in [Sales].", "CASCADE also revokes ALTER TRACE from every principal [l]]x] granted it to.",
                    "CASCADE also revokes VIEW SERVER STATE from every principal [l]]x] granted it to.", "CASCADE also revokes ALTER on [t]]1] from every principal [l]]x] granted it to."]),
            "Script and the steps preview warn of each DROP USER, by database name, then of each permission that cascades to the principals the login granted it to");
    }

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new ActionChecks.FakeHost());
        string Refused(ActionArgs args, bool script = false)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        string DescribeRefused(ActionDescribeArgs args)
        {
            try { service.Validate(args); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var executed = Properties(new(Password: new(false, true, true), Enabled: true)) with { LoginIdentity = Identity, Secrets = new("N3w!pass") };
        check(Refused(Properties(new(Enabled: false)), script: true) == "accepted" && Refused(executed) == "accepted"
            && Refused(Properties(new(Password: new(true, false, false))) with { LoginIdentity = Identity, Secrets = new("N3w!pass", "") }) == "accepted"
            && Refused(Properties(new(Mappings: [new("A", "map", "u", DefaultSchema: "s", RolesAdd: ["r"]), new("B", "unmap", "v"), new("C", "update", "w", RolesDrop: ["r"])])), script: true) == "accepted"
            && Refused(Properties(new(Enabled: true), new ObjectRefDto("login", Name: "##MS_PolicyTsqlExecutionLogin##")), script: true) == "accepted",
            "Login Properties' changes are accepted on Script, and on OK with the identity and exactly the passwords they need; SQL Server's own logins open (the preflight refuses them)");
        var many = Enumerable.Range(0, 200).Select(index => new LoginMappingChangeDto("d" + index, "map", "u", RolesAdd: ["a", "b"])).ToList();
        var invalid = new (string Name, ActionArgs Args, bool Script)[]
        {
            ("no changes", Properties(new()) with { LoginChanges = null }, true), ("nothing to change", Properties(new()), true),
            ("expiration without the policy", Properties(new(CheckPolicy: false, CheckExpiration: true)), true),
            ("the old password with UNLOCK", Properties(new(Password: new(true, true, false))), true), ("the old password with MUST_CHANGE", Properties(new(Password: new(true, false, true))), true),
            ("a third connect state", Properties(new(Connect: "revoke")), true), ("public", Properties(new(RolesAdd: ["public"])), true),
            ("a duplicate role", Properties(new(RolesAdd: ["a", "a"])), true), ("a role added and dropped", Properties(new(RolesAdd: ["a"], RolesDrop: ["a"])), true),
            ("an overlong role", Properties(new(RolesDrop: [new string('r', 129)])), true), ("an overlong default database", Properties(new(DefaultDatabase: new string('d', 129))), true),
            ("a database twice", Properties(new(Mappings: [new("A", "unmap", "u"), new("A", "map", "u")])), true),
            ("an unmap with roles", Properties(new(Mappings: [new("A", "unmap", "u", RolesAdd: ["r"])])), true),
            ("a map that renames", Properties(new(Mappings: [new("A", "map", "u", NewName: "v")])), true),
            ("an update that changes nothing", Properties(new(Mappings: [new("A", "update", "u")])), true),
            ("a rename to the same name", Properties(new(Mappings: [new("A", "update", "u", NewName: "u")])), true),
            ("another change kind", Properties(new(Mappings: [new("A", "drop", "u")])), true),
            ("too many statements", Properties(new(Mappings: many)), true),
            ("a database target", Properties(new(Enabled: true), new ObjectRefDto("database", Name: "AppData")), true),
            ("a table target", Properties(new(Enabled: true), new ObjectRefDto("table", "AppData", "dbo", "Orders")), true),
            ("a mode", Properties(new(Enabled: true)) with { Mode = "keepPassword" }, true), ("drop mapped users", Properties(new(Enabled: true)) with { DropMappedUsers = true }, true),
            ("a new name", Properties(new(Enabled: true)) with { NewName = "x" }, true),
            ("Database Properties' changes", Properties(new(Enabled: true)) with { Changes = new() }, true),
            ("secrets on Script", Properties(new(Password: NewPassword)) with { Secrets = new("N3w!pass") }, true),
            ("no identity on OK", Properties(new(Enabled: true)), false),
            ("no new password", Properties(new(Password: NewPassword)) with { LoginIdentity = Identity }, false),
            ("a blank new password", Properties(new(Password: NewPassword)) with { LoginIdentity = Identity, Secrets = new("") }, false),
            ("a password without a change", Properties(new(Enabled: true)) with { LoginIdentity = Identity, Secrets = new("N3w!pass") }, false),
            ("an old password without Specify old password", Properties(new(Password: NewPassword)) with { LoginIdentity = Identity, Secrets = new("N3w!pass", "x") }, false),
            ("Specify old password without the old one", Properties(new(Password: new(true, false, false))) with { LoginIdentity = Identity, Secrets = new("N3w!pass") }, false),
            ("an overlong password", Properties(new(Password: NewPassword)) with { LoginIdentity = Identity, Secrets = new(new string('p', 129)) }, false),
            ("a login's properties as Database Properties", new ActionArgs("properties", Id(), Id(), App, CloseConnections: false, Changes: new()), true)
        };
        var accepted = invalid.Where(item => Refused(item.Args, item.Script) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        check(accepted.Count == 0, "Validate refuses what zod refuses for Login Properties: " + string.Join(", ", accepted));
        var stray = new LoginChangesDto(Enabled: true);
        var others = new (string Name, ActionArgs Args)[]
        {
            ("rename", new ActionArgs("rename", Id(), Id(), App, NewName: "app2", LoginChanges: stray)),
            ("disable", new ActionArgs("disable", Id(), Id(), App, LoginChanges: stray)),
            ("properties", new ActionArgs("properties", Id(), Id(), new ObjectRefDto("database", Name: "AppData"), CloseConnections: false, Changes: new(), LoginChanges: stray)),
            ("createLogin", new ActionArgs("createLogin", Id(), Id(), new ObjectRefDto("server"), Login: new("sql", "x", "master"), Status: new("grant", true), LoginChanges: stray))
        };
        var strayAccepted = others.Where(item => Refused(item.Args, script: true) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        check(strayAccepted.Count == 0, "every other action refuses loginChanges (finding 20): " + string.Join(", ", strayAccepted));
        check(DescribeRefused(new(Id(), Id(), "loginProperties", App)) == "accepted" && DescribeRefused(new(Id(), Id(), "loginProperties", new ObjectRefDto("database", Name: "AppData"))) == "INVALID_PARAMS"
            && DescribeRefused(new(Id(), Id(), Catalog.Logins.RolesDescribe, new ObjectRefDto("database", Name: "Sales"), Login: "a]'b")) == "accepted"
            && DescribeRefused(new(Id(), Id(), Catalog.Logins.RolesDescribe, new ObjectRefDto("database", Name: "Sales"), Login: new string('l', 129))) == "INVALID_PARAMS"
            && DescribeRefused(new(Id(), Id(), "loginProperties", App, Login: "app_login")) == "INVALID_PARAMS"
            && DescribeRefused(new(Id(), Id(), "databaseProperties", App)) == "INVALID_PARAMS",
            "the loginProperties describe takes a login, and only User Mapping's read of a database names a login");
    }

    private static void Refusals(Action<bool, string> check)
    {
        var cases = new (string Name, LoginFactsDto Facts, LoginChangesDto Changes, string? Id)[]
        {
            ("a SQL Server login's password", Facts(), new(Password: NewPassword), null),
            ("SQL Server's own login", Facts("system"), new(Enabled: true), "system"),
            ("the own login's default database", Facts(own: true), new("AppData"), null),
            ("the own login's password", Facts(own: true), new(Password: new(true, false, false)), null),
            ("the own login denied", Facts(own: true), new(Connect: "deny"), "ownStatus"),
            ("the own login disabled", Facts(own: true), new(Enabled: false), "ownStatus"),
            ("the own login granted and enabled", Facts(own: true), new(Connect: "grant", Enabled: true), null),
            ("a Windows group disabled", Facts("windowsGroup", "G"), new(Enabled: false), "windowsGroupDisable"),
            ("a Windows group denied", Facts("windowsGroup", "G"), new(Connect: "deny"), null),
            ("a Windows login's password", Facts("windowsUser", "U"), new(Password: NewPassword), "propertiesNotSql"),
            ("a Windows login's policy", Facts("windowsUser", "U"), new(CheckPolicy: true), "propertiesNotSql"),
            ("a Windows login's roles", Facts("windowsUser", "U"), new(RolesAdd: ["dbcreator"]), null),
            ("sa's password", Facts("sa"), new(Password: NewPassword), null)
        };
        var wrong = cases.Where(item => LoginRules.PropertiesRefusal(item.Facts, item.Changes) != item.Id).Select(item => item.Name).ToList();
        check(wrong.Count == 0 && Catalog.Logins.Message("ownStatus").Contains("lock this connection out", StringComparison.Ordinal) && Catalog.Logins.Message("propertiesNotSql").Length > 0,
            "Login Properties refuses SQL Server's own logins, the own login's Deny and Disable, a group's Disable, and a password on another kind: " + string.Join(", ", wrong));
        using var service = new ActionService(new ActionChecks.FakeHost());
        var args = Properties(new(Enabled: false)) with { LoginIdentity = Identity };
        check(service.LoginPropertiesRefusal(Facts(), args) is null && service.LoginPropertiesRefusal(Facts() with { Sid = "02" }, args)?.Code == "NOT_FOUND"
            && service.LoginPropertiesRefusal(Facts() with { Created = "2026-02-01T00:00:00.000" }, args)?.Code == "NOT_FOUND"
            && service.LoginPropertiesRefusal(Facts(own: true), args)?.Code == "NOT_SUPPORTED"
            && service.LoginPropertiesRefusal(Facts() with { CanAlter = false }, args) is null,
            "the preflight refuses a login the dialog did not read and the login's rules, and leaves permissions to SQL Server (a login may change its own password)");
    }

    private static void Messages(Action<bool, string> check)
    {
        var denied = new ActionError("PERMISSION_DENIED", "Cannot alter the login 'x', because it does not exist or you do not have permission.", false);
        ActionStepDto Step(string title, string status) => new(status, title);
        var wrongOld = ActionService.PartlyChanged(denied, [Step(ActionService.LoginOptionsStep, "done"), Step(ActionService.LoginPasswordStep, "failed")], oldPassword: true);
        var noRight = ActionService.PartlyChanged(denied, [Step(ActionService.LoginPasswordStep, "failed")], oldPassword: false);
        var later = ActionService.PartlyChanged(denied, [Step(ActionService.LoginPasswordStep, "done"), Step("Disable the login", "failed")], oldPassword: true);
        check(wrongOld.Message.StartsWith(ActionService.LoginChangedMessage + " ", StringComparison.Ordinal) && wrongOld.Message.EndsWith(ActionService.LoginOldPasswordAdvice, StringComparison.Ordinal)
            && !noRight.Message.StartsWith(ActionService.LoginChangedMessage, StringComparison.Ordinal) && noRight.Message.EndsWith(ActionErrors.LoginPermissionAdvice, StringComparison.Ordinal)
            && later.Message.EndsWith(ActionErrors.LoginPermissionAdvice, StringComparison.Ordinal)
            && ActionService.PartlyChanged(new("SQL_ERROR", "x", false), [], false).Message == "x"
            && ActionService.PartlyChanged(new("SQL_ERROR", new string('m', 5_000), false), [Step("a", "done")], false).Message.Length <= ActionErrors.MaxMessage,
            "a 15151 says to check the old password when its step failed with one, else the permissions; a run that changed the login in part says so first, within the message bound");
        check(LoginSql.Scrub("Old N'o''ld!pass1' and new 'n3w!pass99' and bare o'ld!pass1", new("n3w!pass99", "o'ld!pass1")) == "Old N'" + LoginSql.Placeholder + "' and new '" + LoginSql.Placeholder + "' and bare " + LoginSql.Placeholder
            && !ActionService.LoginOldPasswordAdvice.Contains('\'') && ActionService.LoginChangedMessage.Length < 128,
            "SQL Server's text is scrubbed of the old password as of the new one");
    }
}
