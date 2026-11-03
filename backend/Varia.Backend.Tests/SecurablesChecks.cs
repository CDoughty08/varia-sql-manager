using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the Securables page (D2d): the catalogue C# reads, the permission builder and its lint (which must refuse
/// every misuse), SMO's statement text, the plan's order and step words, Script's two forms, validation parity with zod for New Login and
/// Login Properties, the Effective tab's describe, the reads' lint, and the message of a New Login that set its permissions in part.</summary>
internal static class SecurablesChecks
{
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static readonly SecurableCatalog Securables = Catalog.Logins.Securables;
    private static readonly string NL = Environment.NewLine;
    private static string Id() => Guid.NewGuid().ToString();
    private static PermissionDto Server(string permission, string state, bool? cascade = null) => new(new("server"), permission, state, cascade);
    private static PermissionDto On(string type, string name, string permission, string state, bool? cascade = null) => new(new(type, name), permission, state, cascade);

    public static void Run(Action<bool, string> check)
    {
        CatalogRead(check);
        Builder(check);
        BuilderLint(check);
        Plan(check);
        ScriptText(check);
        Validation(check);
        Partial(check);
        PostCondition(check);
        Protected(check);
    }

    /// <summary>Review of D2d: SQL Server runs a REVOKE that removes only its own grantor's row, or a statement for sa, the principal running
    /// it or the securable's owner, without an error. What remains decides whether the step did what the boxes asked.</summary>
    private static void PostCondition(Action<bool, string> check)
    {
        var none = Array.Empty<(string, string)>();
        static (string, string)[] Rows(params (string State, string Grantor)[] rows) => rows;
        var met = new (string Name, PermissionDto Permission, (string, string)[] Rows)[]
        {
            ("a grant", Server("SHUTDOWN", "grant"), Rows(("G", "sa"))),
            ("a grant beside another's grant option", Server("SHUTDOWN", "grant"), Rows(("W", "b"), ("G", "sa"))),
            ("a grant option", Server("SHUTDOWN", "withGrant"), Rows(("W", "sa"), ("G", "b"))),
            ("a deny over another's grant", Server("SHUTDOWN", "deny", true), Rows(("D", "sa"), ("W", "b"))),
            ("a revoke", Server("SHUTDOWN", "revoke"), none),
            ("a grant option revoked", On("login", "t", "ALTER", "revokeGrantOption"), Rows(("G", "t")))
        };
        const string Tail = ": SQL Server's GRANT, DENY and REVOKE change only what their own grantor recorded. This permission was not changed.";
        const string Ignored = ": it changes no permission for sa, for the login this connection uses or for the securable's owner. This permission was not changed.";
        var unmet = new (string Name, PermissionDto Permission, (string, string)[] Rows, string Message)[]
        {
            ("a revoke that left another grantor's grant", Server("VIEW SERVER STATE", "revoke"), Rows(("G", "b]x")), "VIEW SERVER STATE is still granted by b]x" + Tail),
            ("a revoke that left another grantor's deny", Server("SHUTDOWN", "revoke"), Rows(("D", "b"), ("G", "c")), "SHUTDOWN is still denied by b" + Tail),
            ("a grant option revoked that other grantors hold", On("login", "t", "ALTER", "revokeGrantOption"), Rows(("W", "b"), ("W", "c"), ("G", "t")),
                "ALTER on t is still granted with grant option by b, c" + Tail),
            ("a grant under other grantors' denials", Server("SHUTDOWN", "grant"), Rows(("D", "a"), ("D", "b"), ("D", "c"), ("D", "d"), ("G", "sa")),
                "SHUTDOWN is still denied by a, b, c and others" + Tail),
            ("a deny SQL Server ignored", Server("SHUTDOWN", "deny"), none, "SQL Server did not set SHUTDOWN" + Ignored),
            ("a grant SQL Server ignored", On("login", "t", "VIEW DEFINITION", "grant"), none, "SQL Server did not set VIEW DEFINITION on t" + Ignored)
        };
        var wrong = met.Where(item => PermissionSql.Unmet(item.Permission, item.Rows) is not null).Select(item => item.Name)
            .Concat(unmet.Where(item => PermissionSql.Unmet(item.Permission, item.Rows) != item.Message).Select(item => item.Name + ": " + PermissionSql.Unmet(item.Permission, item.Rows))).ToList();
        check(wrong.Count == 0 && PermissionSql.Collapsed(Rows(("G", "a"), ("W", "b"))) == "withGrant" && PermissionSql.Collapsed(none) is null,
            "a permission step fails as a value when what SQL Server left is not what the boxes asked for, naming the grantors in the way: " + string.Join(", ", wrong));
        check(PermissionSql.Remaining.Contains("sp.grantee_principal_id = @principal AND sp.class = @class AND sp.permission_name = @permission", StringComparison.Ordinal)
            && PermissionSql.Remaining.Contains("ORDER BY CASE sp.state WHEN 'D' THEN 0 WHEN 'W' THEN 1 ELSE 2 END", StringComparison.Ordinal)
            && PermissionSql.Lint(Securables).Single(item => item.Name == "remaining permission").Problems.Count == 0 && ActionService.ProtectedPrincipalMessage == 4624,
            "the post-condition reads one permission's rows of the login, denials first, through linted constant SQL, and 4624 is SQL Server's refusal");
    }

    /// <summary>SQL Server changes no permission of sa or of the login a connection uses (4624), so Login Properties refuses them before
    /// anything runs (logins.ts permissionsProtected), and the Effective tab never reads a login SQL Server cannot impersonate.</summary>
    private static void Protected(Action<bool, string> check)
    {
        static LoginFactsDto Facts(string subtype = "sql", string type = "S", bool own = false) =>
            new(9, type, subtype, false, "01", "2026-01-01T00:00:00.000", null, null, false, own, false, 0, 0, [], 0, true, true, false);
        var permission = new LoginChangesDto(Permissions: [Server("SHUTDOWN", "grant")]);
        var cases = new (string Name, LoginFactsDto Facts, LoginChangesDto Changes, string? Id)[]
        {
            ("sa's permissions", Facts("sa"), permission, "permissionsProtected"),
            ("the own login's permissions", Facts(own: true), permission, "permissionsProtected"),
            ("the own Windows login's permissions", Facts("windowsUser", "U", own: true), permission, "permissionsProtected"),
            ("a group the connection gets in through", Facts("windowsGroup", "G", own: true), permission, null),
            ("another login's permissions", Facts(), permission, null),
            ("sa's default database", Facts("sa"), new("master"), null),
            ("sa with an empty list", Facts("sa"), new(Permissions: []), null)
        };
        var wrong = cases.Where(item => LoginRules.PropertiesRefusal(item.Facts, item.Changes) != item.Id).Select(item => item.Name).ToList();
        check(wrong.Count == 0 && Catalog.Logins.Message("permissionsProtected").Contains("sa", StringComparison.Ordinal),
            "Login Properties refuses permissions for sa and for the login this connection uses, which SQL Server would leave unchanged: " + string.Join(", ", wrong));
        check(Securables.EffectiveUnavailableSubtypes.SequenceEqual(["windowsGroup", "certificateMapped", "asymmetricKeyMapped", "externalGroup"])
            && Securables.EffectiveUnavailable.StartsWith("SQL Server cannot impersonate a group", StringComparison.Ordinal),
            "the Effective tab's read refuses the login subtypes SQL Server cannot impersonate, with the catalogue's words");
    }

    private static void CatalogRead(Action<bool, string> check)
    {
        check(Securables.Types.Select(type => type.Type).SequenceEqual(["server", "endpoint", "login", "serverRole", "availabilityGroup"])
            && Securables.Type("server") is { On: null, SqlClass: "SERVER", ClassId: 100 } && Securables.Type("endpoint") is { On: " ON ENDPOINT::", SqlClass: "ENDPOINT", ClassId: 105 }
            && Securables.Type("login") is { On: " ON LOGIN::", ClassId: 101 } && Securables.Type("serverRole") is { On: " ON SERVER ROLE::", SqlClass: "SERVER ROLE", ClassId: 101 }
            && Securables.Type("availabilityGroup") is { On: " ON AVAILABILITY GROUP::", ClassId: 108 } && Securables.Type("database") is null && Securables.Type(null) is null,
            "C# reads the Securables page's five server-level classes, their ON clauses and sys.server_permissions classes from the embedded catalogue");
        check(Securables.Takes("server", "VIEW SERVER STATE") && Securables.Takes("server", "CONNECT SQL") && !Securables.Takes("login", "VIEW SERVER STATE") && !Securables.Takes("server", "view server state")
            && Securables.Reserved("server", "CONNECT SQL") && !Securables.Reserved("server", "SHUTDOWN") && Securables.Type("server")!.Permissions.Count == 51
            && Securables.EffectiveDescribe == "loginEffectivePermissions" && Securables.EffectiveDenied == "You don't have permission to view effective permissions.",
            "the catalogue's permissions match ordinally, CONNECT SQL is the Status page's, and the Effective tab's describe and words come from it");
        string? Refused(SecurablesJson json)
        {
            try { _ = new SecurableCatalog(json); return null; }
            catch (InvalidOperationException error) { return error.Message; }
        }
        var good = new SecurablesJson("e", "d", "u", ["windowsGroup"], [new("server", "CONNECT SQL")], [new("server", "Server", "Servers", "SERVER", 100, ["CONNECT SQL"]), new("login", "Login", "Logins", "LOGIN", 101, ["ALTER"], " ON LOGIN::")]);
        check(Refused(good) is null
            && Refused(good with { Types = [good.Types[0] with { Permissions = ["CONNECT SQL", "ALTER'; DROP LOGIN sa; --"] }, good.Types[1]] }) is not null
            && Refused(good with { Types = [good.Types[0], good.Types[1] with { On = " ON LOGIN::[x]; --" }] }) is not null
            && Refused(good with { Types = [good.Types[0], good.Types[1] with { On = null }] }) is not null
            && Refused(good with { Types = [good.Types[0] with { On = " ON SERVER::" }, good.Types[1]] }) is not null
            && Refused(good with { Types = [good.Types[0] with { SqlClass = "SERVER'" }, good.Types[1]] }) is not null
            && Refused(good with { Reserved = [new("server", "SHUTDOWN")] }) is not null,
            "a catalogue whose permissions, classes or ON clauses could carry anything but upper-case keyword text is refused at load");
    }

    private static void Builder(Action<bool, string> check)
    {
        check(PermissionSql.Statement(Securables, "l]x", Server("VIEW SERVER STATE", "grant")) == "GRANT VIEW SERVER STATE TO [l]]x]"
            && PermissionSql.Statement(Securables, "l", Server("ALTER ANY LOGIN", "withGrant")) == "GRANT ALTER ANY LOGIN TO [l] WITH GRANT OPTION"
            && PermissionSql.Statement(Securables, "l", Server("SHUTDOWN", "deny")) == "DENY SHUTDOWN TO [l]"
            && PermissionSql.Statement(Securables, "l", Server("VIEW SERVER STATE", "revoke")) == "REVOKE VIEW SERVER STATE TO [l]"
            && PermissionSql.Statement(Securables, "l", Server("VIEW ANY DATABASE", "revokeGrantOption")) == "REVOKE GRANT OPTION FOR VIEW ANY DATABASE TO [l] CASCADE",
            "the statements are SMO's captured ones (D2 §3.4), one permission each, without SMO's trailing space after WITH GRANT OPTION");
        check(PermissionSql.Statement(Securables, "l", On("endpoint", "TSQL]Default", "CONNECT", "grant")) == "GRANT CONNECT ON ENDPOINT::[TSQL]]Default] TO [l]"
            && PermissionSql.Statement(Securables, "l", On("login", "sa", "IMPERSONATE", "deny", true)) == "DENY IMPERSONATE ON LOGIN::[sa] TO [l] CASCADE"
            && PermissionSql.Statement(Securables, "l", On("serverRole", "aud'itors", "ALTER", "revoke", true)) == "REVOKE ALTER ON SERVER ROLE::[aud'itors] TO [l] CASCADE"
            && PermissionSql.Statement(Securables, "l", On("availabilityGroup", "ag1", "VIEW DEFINITION", "grant")) == "GRANT VIEW DEFINITION ON AVAILABILITY GROUP::[ag1] TO [l]",
            "a named securable takes the T-SQL grammar's ON class::[name], and DENY and REVOKE cascade where asked");
        var run = PermissionSql.Executable(Securables, On("login", "x", "IMPERSONATE", "revoke", true));
        check(run == "DECLARE @stmt nvarchar(max) = N'REVOKE ' + N'IMPERSONATE' + N' ON LOGIN::' + QUOTENAME(@p2) + N' TO ' + QUOTENAME(@p1) + N' CASCADE';\n" + ActionSql.Guard
                + "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;"
            && PermissionSql.Executable(Securables, Server("SHUTDOWN", "grant"), dryRun: true) == "DECLARE @stmt nvarchar(max) = N'GRANT ' + N'SHUTDOWN' + N' TO ' + QUOTENAME(@p1);\n" + ActionSql.Guard + "SELECT @stmt AS stmt;",
            "SQL Server builds each statement from the catalogue's keyword text and QUOTENAME'd parameters, and the dry run returns it instead of running it");
        string? Throws(PermissionDto permission)
        {
            try { _ = PermissionSql.Executable(Securables, permission); return null; }
            catch (InvalidOperationException error) { return error.Message; }
        }
        check(Throws(Server("SHUTDOWN; DROP LOGIN sa", "grant")) is not null && Throws(On("login", "x", "SHUTDOWN", "grant")) is not null && Throws(Server("SHUTDOWN", "drop")) is not null
            && Throws(new(new("database", "x"), "ALTER", "grant")) is not null,
            "the builder writes no permission, class or verb the catalogue does not hold");
        check(PermissionSql.StepTitle(Server("A", "grant")) == "Grant a permission" && PermissionSql.StepTitle(Server("A", "withGrant")) == "Grant a permission"
            && PermissionSql.StepTitle(Server("A", "deny")) == "Deny a permission" && PermissionSql.StepTitle(Server("A", "revoke")) == "Revoke a permission"
            && PermissionSql.StepTitle(Server("A", "revokeGrantOption")) == "Revoke a grant option"
            && PermissionSql.StepDetail(Server("SHUTDOWN", "grant")) == "SHUTDOWN" && PermissionSql.StepDetail(On("login", "sa", "IMPERSONATE", "grant")) == "IMPERSONATE on sa"
            && PermissionSql.IsStep("Deny a permission") && !PermissionSql.IsStep("Deny permission to connect"),
            "each permission step says what it does, the permission, and the securable it is on");
    }

    private static void BuilderLint(Action<bool, string> check)
    {
        var results = PermissionSql.Lint(Securables).ToList();
        var problems = results.SelectMany(result => result.Problems.Select(problem => result.Name + ": " + problem)).ToList();
        check(problems.Count == 0 && results.Count == Securables.Types.Count * PermissionSql.Forms.Count * 2 + 4 && PermissionSql.Forms.Count == 7,
            "every permission batch the builder can write, for every type, permission and form, run and dry run, and the four reads pass the lint (" + results.Count + "): " + string.Join("; ", problems.Take(5)));
        var good = PermissionSql.Executable(Securables, On("login", "x", "IMPERSONATE", "deny", true));
        var mutants = new (string Name, string Text, string Type)[]
        {
            ("the grantee spliced", good.Replace("QUOTENAME(@p1)", "N'[x]'", StringComparison.Ordinal), "login"),
            ("the grantee bare", good.Replace("QUOTENAME(@p1)", "@p1", StringComparison.Ordinal), "login"),
            ("the securable bare", good.Replace("QUOTENAME(@p2)", "@p2", StringComparison.Ordinal), "login"),
            ("the securable spliced", good.Replace("QUOTENAME(@p2)", "N'[sa]'", StringComparison.Ordinal), "login"),
            ("a permission of another class", good.Replace("N'IMPERSONATE'", "N'SHUTDOWN'", StringComparison.Ordinal), "login"),
            ("free text as the permission", good.Replace("N'IMPERSONATE'", "N'IMPERSONATE TO [x]; DROP LOGIN [sa]; --'", StringComparison.Ordinal), "login"),
            ("two permissions", good.Replace("N'IMPERSONATE'", "N'IMPERSONATE' + N', ' + N'ALTER'", StringComparison.Ordinal), "login"),
            ("another ON clause", good.Replace("N' ON LOGIN::'", "N' ON SERVER ROLE::'", StringComparison.Ordinal), "login"),
            ("no ON clause", good.Replace("N' ON LOGIN::' + QUOTENAME(@p2) + ", "", StringComparison.Ordinal), "login"),
            ("an ON clause on the server", PermissionSql.Executable(Securables, Server("SHUTDOWN", "deny")).Replace("N'SHUTDOWN'", "N'SHUTDOWN' + N' ON LOGIN::' + QUOTENAME(@p2)", StringComparison.Ordinal), "server"),
            ("an unknown verb", good.Replace("N'DENY '", "N'DROP LOGIN '", StringComparison.Ordinal), "login"),
            ("the grantee twice", good.Replace(" + N' CASCADE'", " + N' TO ' + QUOTENAME(@p1)", StringComparison.Ordinal), "login"),
            ("no quoting guard", good.Replace(ActionSql.Guard, "", StringComparison.Ordinal), "login"),
            ("a second EXEC", good + "\nEXEC @module @stmt;", "login"),
            ("EXEC of a string", good.Replace("EXEC @module @stmt;", "EXEC (@stmt);", StringComparison.Ordinal), "login"),
            ("the module unquoted", good.Replace("QUOTENAME(@db) + N'.sys.sp_executesql'", "@db + N'.sys.sp_executesql'", StringComparison.Ordinal), "login"),
            ("an unknown type", good, "database")
        };
        var passed = mutants.Where(mutant => PermissionSql.LintExecutable(mutant.Text, Securables, mutant.Type).Count == 0).Select(mutant => mutant.Name).ToList();
        check(passed.Count == 0 && PermissionSql.LintExecutable(good, Securables, "login").Count == 0,
            "the permission lint refuses a spliced or bare name, a permission of another class or as free text, two permissions, a wrong or missing ON clause, an unknown verb, a second grantee or EXEC, and a missing guard: " + string.Join(", ", passed));
        check(PermissionSql.Effective.Contains("EXECUTE AS LOGIN = @name;", StringComparison.Ordinal) && PermissionSql.Effective.TrimEnd().EndsWith("REVERT;", StringComparison.Ordinal)
            && PermissionSql.Effective.Contains("BEGIN CATCH\nREVERT;\nTHROW;", StringComparison.Ordinal) && PermissionSql.Effective.Contains("sys.fn_my_permissions(@securable, @class)", StringComparison.Ordinal),
            "the Effective tab's read impersonates the login only between EXECUTE AS and REVERT, on failure too");
    }

    private static void Plan(Action<bool, string> check)
    {
        var ordered = PermissionSql.Ordered(Securables, [On("login", "b", "ALTER", "grant"), On("endpoint", "E", "CONNECT", "grant"), Server("VIEW SERVER STATE", "deny"), On("login", "A", "IMPERSONATE", "grant"),
            On("login", "a", "ALTER", "grant"), Server("SHUTDOWN", "grant"), On("serverRole", "r", "ALTER", "grant")]);
        check(ordered.Select(item => item.Securable.Type + ":" + item.Securable.Name + ":" + item.Permission).SequenceEqual([
                "server::SHUTDOWN", "server::VIEW SERVER STATE", "endpoint:E:CONNECT", "login:A:IMPERSONATE", "login:a:ALTER", "login:b:ALTER", "serverRole:r:ALTER"]),
            "the permission statements run by type in the catalogue's order (the server first), then by name and permission");
        var status = new LoginStatusDto("grant", true);
        check(LoginSql.Statements(status, [], [], 3) == 4 && LoginSql.PropertiesStatements(new(Permissions: [Server("SHUTDOWN", "grant"), Server("SHUTDOWN", "deny")])) == 2,
            "each permission counts as one statement toward actionLimits.statements, for New Login and Login Properties alike");
    }

    private static void ScriptText(Action<bool, string> check)
    {
        var header = Catalog.Logins.ScriptHeader;
        var permissions = new List<string> { "GRANT SHUTDOWN TO [D\\u]", "DENY IMPERSONATE ON LOGIN::[sa] TO [D\\u]" };
        var windows = LoginSql.ScriptText(LoginChecks.Windows("D\\u"), [], new("grant", true), [new("App", "D\\u", null, ["db_owner"])], new HashSet<string>(), header, permissions);
        check(windows == "USE [master]" + NL + "GO" + NL + "CREATE LOGIN [D\\u] FROM WINDOWS WITH DEFAULT_DATABASE=[master]" + NL + "GO" + NL
                + "USE [App]" + NL + "GO" + NL + "CREATE USER [D\\u] FOR LOGIN [D\\u]" + NL + "GO" + NL + "USE [App]" + NL + "GO" + NL + "ALTER ROLE [db_owner] ADD MEMBER [D\\u]" + NL + "GO" + NL
                + "USE [master]" + NL + "GO" + NL + "GRANT SHUTDOWN TO [D\\u]" + NL + "GO" + NL + "DENY IMPERSONATE ON LOGIN::[sa] TO [D\\u]" + NL + "GO" + NL,
            "a Windows login's script ends with its permissions, each with GO, after USE [master] again when a mapped database came before: " + windows);
        var bare = LoginSql.ScriptText(LoginChecks.Windows("D\\u"), [], new("grant", true), [], new HashSet<string>(), header, permissions);
        check(bare == "USE [master]" + NL + "GO" + NL + "CREATE LOGIN [D\\u] FROM WINDOWS WITH DEFAULT_DATABASE=[master]" + NL + "GO" + NL + "GRANT SHUTDOWN TO [D\\u]" + NL + "GO" + NL
                + "DENY IMPERSONATE ON LOGIN::[sa] TO [D\\u]" + NL + "GO" + NL,
            "without a mapped database, the permissions follow in master with no second USE");
        var sql = LoginSql.ScriptText(LoginChecks.Sql("u"), [], new("grant", true), [], new HashSet<string>(), header, ["GRANT SHUTDOWN TO [u]"]);
        check(sql.Contains("CHECK_POLICY=ON;" + NL + "GRANT SHUTDOWN TO [u];" + NL + "COMMIT TRANSACTION;", StringComparison.Ordinal) && Varia.Backend.SqlScript.Parse(sql).Count == 2,
            "a SQL Server login's one-batch script carries the permissions before COMMIT: " + sql);
        var properties = LoginSql.PropertiesScriptText("u", new(Permissions: [Server("SHUTDOWN", "revoke")]), new HashSet<string>(), header, ["REVOKE SHUTDOWN TO [u]"]);
        check(properties == "USE [master]" + NL + "GO" + NL + "REVOKE SHUTDOWN TO [u]" + NL + "GO" + NL, "Login Properties scripts a permission change alone as SSMS does: " + properties);
    }

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new ActionChecks.FakeHost());
        string Refused(ActionArgs args, bool script = false)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        ActionArgs Create(params PermissionDto[] permissions) => LoginChecks.Create(LoginChecks.Windows("D\\a"), null) with { Permissions = [.. permissions] };
        ActionArgs Change(params PermissionDto[] permissions) =>
            new("loginProperties", Id(), Id(), new("login", Name: "app"), LoginIdentity: new("01", "2026-01-01T00:00:00.000"), LoginChanges: new(Permissions: [.. permissions]));
        var many = Enumerable.Range(0, 513).Select(index => On("login", "l" + index, "ALTER", "grant")).ToArray();
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("a revoke", Create(Server("SHUTDOWN", "revoke"))),
            ("a grant option revoked", Create(Server("SHUTDOWN", "revokeGrantOption"))),
            ("CASCADE", Create(Server("SHUTDOWN", "deny", true))),
            ("CONNECT SQL", Create(Server("CONNECT SQL", "deny"))),
            ("free text", Create(Server("SHUTDOWN; DROP LOGIN sa", "grant"))),
            ("lower case", Create(Server("shutdown", "grant"))),
            ("another class's permission", Create(On("login", "sa", "SHUTDOWN", "grant"))),
            ("a named server", Create(new PermissionDto(new("server", "x"), "SHUTDOWN", "grant"))),
            ("an unnamed login", Create(new PermissionDto(new("login"), "ALTER", "grant"))),
            ("a long name", Create(On("login", new string('x', 129), "ALTER", "grant"))),
            ("a database", Create(new PermissionDto(new("database", "x"), "ALTER", "grant"))),
            ("an unknown state", Create(Server("SHUTDOWN", "drop"))),
            ("twice", Create(Server("SHUTDOWN", "grant"), Server("SHUTDOWN", "deny"))),
            ("513", Create(many)),
            ("cascade on a grant", Change(Server("SHUTDOWN", "grant", true))),
            ("cascade false", Change(Server("SHUTDOWN", "revoke", false))),
            ("cascade on revokeGrantOption", Change(Server("SHUTDOWN", "revokeGrantOption", true))),
            ("CONNECT SQL changed", Change(Server("CONNECT SQL", "revoke"))),
            ("changed twice", Change(Server("SHUTDOWN", "revoke"), Server("SHUTDOWN", "grant")))
        };
        var accepted = invalid.Where(item => Refused(item.Args) != "INVALID_PARAMS").Select(item => item.Name + " (" + Refused(item.Args) + ")").ToList();
        check(accepted.Count == 0, "New Login and Login Properties refuse the permissions zod refuses: " + string.Join(", ", accepted));
        var valid = new (string Name, ActionArgs Args, bool Script)[]
        {
            ("New Login's three states", Create(Server("SHUTDOWN", "grant"), Server("ALTER ANY LOGIN", "withGrant"), On("login", "s]a'x", "IMPERSONATE", "deny")), false),
            ("511, with CREATE LOGIN the 512 statements", Create([.. many.Take(511)]), false),
            ("a Script", Create(On("endpoint", "TSQL Default TCP", "CONNECT", "grant")), true),
            ("Login Properties' five verbs", Change(Server("SHUTDOWN", "revoke", true), Server("ALTER ANY LOGIN", "revokeGrantOption"), Server("VIEW SERVER STATE", "deny", true),
                On("serverRole", "r", "ALTER", "grant"), On("availabilityGroup", "ag", "CONTROL", "withGrant")), false)
        };
        var refused = valid.Where(item => Refused(item.Args, item.Script) != "accepted").Select(item => item.Name + " (" + Refused(item.Args, item.Script) + ")").ToList();
        check(refused.Count == 0, "New Login and Login Properties accept the permissions zod accepts, hostile names included: " + string.Join(", ", refused));
        string Describe(string dialog, ObjectRefDto target, SecurableRefDto? securable)
        {
            try { service.Validate(new ActionDescribeArgs(Id(), Id(), dialog, target, Securable: securable)); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var login = new ObjectRefDto("login", Name: "app]x");
        check(Describe("loginEffectivePermissions", login, new("server")) == "accepted" && Describe("loginEffectivePermissions", login, new("endpoint", "TSQL Default TCP")) == "accepted"
            && Describe("loginEffectivePermissions", login, null) == "INVALID_PARAMS" && Describe("loginEffectivePermissions", login, new("server", "x")) == "INVALID_PARAMS"
            && Describe("loginEffectivePermissions", login, new("login")) == "INVALID_PARAMS" && Describe("loginEffectivePermissions", login, new("login", new string('x', 129))) == "INVALID_PARAMS"
            && Describe("loginEffectivePermissions", login, new("database", "x")) == "INVALID_PARAMS" && Describe("loginEffectivePermissions", new("server"), new("server")) == "INVALID_PARAMS"
            && Describe("loginProperties", login, new("server")) == "INVALID_PARAMS"
            && Describe("loginEffectivePermissions", new("login", Name: "##MS_PolicyTsqlExecutionLogin##"), new("server")) == "INVALID_PARAMS",
            "only the Effective tab's describe names a securable, and it takes a login other than SQL Server's own and a securable of the catalogue");
    }

    private static void Partial(Action<bool, string> check)
    {
        var failure = new ActionError("PERMISSION_DENIED", "Cannot find the login 'sa'.", false);
        static ActionStepDto Step(string status, string title) => new(status, title);
        var partly = ActionService.PartlyCreated(failure, new("grant", true), [Step("done", ActionService.CreateLoginStep), Step("done", PermissionSql.GrantStep), Step("failed", PermissionSql.DenyStep)]);
        var whole = ActionService.PartlyCreated(failure, new("grant", true), [Step("done", ActionService.CreateLoginStep), Step("done", PermissionSql.GrantStep)]);
        check(partly.Message == ActionService.LoginCreatedMessage + " " + ActionService.LoginPermissionsMessage + " " + failure.Message && whole.Message == ActionService.LoginCreatedMessage + " " + failure.Message,
            "a failure or Stop after CREATE LOGIN says when a permission was not set as chosen: " + partly.Message);
    }
}
