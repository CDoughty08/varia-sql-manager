using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of a login's Disable, Enable and Rename (D4b): the catalogue's login rows and the loginFacts describe,
/// the RenameLogin template and its script, plans in master, validation parity with zod, the refusals the preflight's facts
/// give, the service lookup's name fallback, the error map, and the engine gate before any connection.</summary>
internal static class LoginActionChecks
{
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static readonly string NL = Environment.NewLine;
    private static string Id() => Guid.NewGuid().ToString();
    private static readonly ObjectRefDto AppUser = new("login", Name: "AppUser");

    private static ActionArgs State(string action, ObjectRefDto target) => new(action, Id(), Id(), target);
    private static ActionArgs Rename(ObjectRefDto target, string name) => new("rename", Id(), Id(), target, name);
    /// <summary>The identity of the login <see cref="Facts"/> describes.</summary>
    private static readonly LoginIdentityDto Identity = new("01", "2026-01-01T00:00:00.000");
    private static LoginFactsDto Facts(string subtype, string type = "S", bool own = false, bool canAlter = true, bool nameInUse = false) =>
        new(300, type, subtype, false, "01", "2026-01-01T00:00:00.000", null, null, false, own, false, 3, 0, [], 0, canAlter, true, nameInUse);

    public static async Task RunAsync(Action<bool, string> check)
    {
        CatalogChecks(check);
        Templates(check);
        Plans(check);
        Validation(check);
        Refusals(check);
        Errors(check);
        await ServiceAsync(check);
    }

    private static void CatalogChecks(Action<bool, string> check)
    {
        check(Catalog.Row("login", "sa") is { } sa && sa.Enabled.SequenceEqual(["rename", "disable", "unlock"]) && sa.Disabled.SequenceEqual(["delete"])
            && Catalog.Row("login", "sa", "disabled") is { Status: "disabled" } off && off.Enabled.SequenceEqual(["rename", "enable", "unlock"]) && off.Disabled.SequenceEqual(["delete"])
            && Catalog.Row("login", "system", "disabled") is { } system && system.Enabled.Count == 0 && system.Disabled.SequenceEqual(["rename", "delete", "enable", "unlock"])
            && Catalog.Row("login", "windowsGroup", "disabled") is { } group && group.Enabled.SequenceEqual(["rename", "delete"]) && group.Disabled.Count == 0
            && Catalog.Row("login", "sql", "noAccess") == Catalog.Row("login", "sql") && Catalog.Row("login", "")?.Enabled.Count == 0,
            "a login's rows come from logins.ts: Disable, Unlock, Rename and Delete (greyed for sa) by subtype, Enable in place of Disable while it is disabled, and a denied login keeps its row");
        check(Catalog.Offered("login", "disable") && Catalog.Offered("login", "enable") && Catalog.Offered("login", "rename") && Catalog.Offered("login", "delete") && !Catalog.Offered("login", "properties")
            && !Catalog.Offered("table", "disable") && Catalog.Serves("disable", "box") && Catalog.Serves("enable", "managedInstance") && !Catalog.Serves("disable", "cloud"),
            "Disable, Enable and Delete are offered on logins, Disable and Enable on logins only, on SQL Server and Managed Instance");
        check(Catalog.Describes.TryGetValue("loginFacts", out var kinds) && kinds.SequenceEqual(["login"]) && Catalog.ActionOf("loginFacts") == "disable" && !Catalog.Dialogs.ContainsKey("loginFacts"),
            "loginFacts is a fact describe without a dialog, for logins, under Disable's target rules");
        check(LoginRules.SystemName("##MS_PolicyTsqlExecutionLogin##") && !LoginRules.SystemName("##") && !LoginRules.SystemName("##x") && !LoginRules.SystemName("AppUser"),
            "SQL Server's own logins are named ##…##");
        // SQL Server compares names without trailing spaces, so "##x## " is SQL Server's own ##x## too.
        check(LoginRules.SystemName("##MS_PolicyEventProcessingLogin##  ") && Catalog.Logins.SubtypeOf(300, "S", "##x## ") == "system" && !LoginRules.SystemName(" ##x##")
            && !LoginRules.SystemName("##x##\t"), "a ##…## name with trailing spaces is SQL Server's own too");
        check(Catalog.Logins.Message("systemName") == "Names that start and end with ## are reserved for SQL Server's own logins.", "the reserved-name message is the catalogue's");
        check(Catalog.Logins.Limit("serviceName") == 256 && Catalog.Logins.Limit("serviceNames") == 4 && Catalog.Logins.Message("sqlBackslash") == "A SQL Server login's name cannot contain a backslash.",
            "the login facts' service bounds and the backslash message are the catalogue's");
    }

    private static void Templates(Action<bool, string> check)
    {
        check(ActionSql.Statement(new(ActionTemplate.RenameLogin, "master", ["AppUser", "App]User"])) == "ALTER LOGIN [AppUser] WITH NAME=[App]]User]"
            && ActionSql.ScriptText(new(ActionTemplate.DisableLogin, "master", ["AppUser"])) == "USE [master]" + NL + "GO" + NL + "ALTER LOGIN [AppUser] DISABLE" + NL + "GO" + NL
            && ActionSql.ScriptText(new(ActionTemplate.EnableLogin, "master", ["AppUser"])) == "USE [master]" + NL + "GO" + NL + "ALTER LOGIN [AppUser] ENABLE" + NL + "GO" + NL
            && ActionSql.ScriptText(new(ActionTemplate.RenameLogin, "master", ["sa", "admin"])) == "USE [master]" + NL + "GO" + NL + "ALTER LOGIN [sa] WITH NAME=[admin]" + NL + "GO" + NL,
            "a login's Disable, Enable and Rename script as SMO writes them, in master");
        var failures = new List<string>();
        foreach (var fragment in InjectionMatrix.Fragments.Append("]").Append("'").Append("\\"))
        {
            var name = ActionChecks.Long(fragment);
            var plan = new PlannedStatement(ActionTemplate.RenameLogin, "master", [name, name]);
            var quoted = "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
            var batches = SqlScript.Parse(ActionSql.ScriptText(plan));
            if (ActionSql.Statement(plan) != "ALTER LOGIN " + quoted + " WITH NAME=" + quoted || batches.Count != 2) failures.Add(fragment[..1]);
        }
        check(failures.Count == 0, "a login's rename quotes hostile 128-unit names and splits into SSMS's two batches: " + string.Join(", ", failures));
        var executable = ActionSql.Executable(ActionTemplate.RenameLogin);
        check(ActionSql.ParameterCount(ActionTemplate.RenameLogin) == 2 && executable.Contains("N'ALTER LOGIN ' + QUOTENAME(@p1) + N' WITH NAME=' + QUOTENAME(@p2)", StringComparison.Ordinal)
            && ActionSql.LintExecutable(executable, ActionTemplate.RenameLogin).Count == 0
            && ActionSql.LintExecutable(executable.Replace("QUOTENAME(@p2)", "@p2", StringComparison.Ordinal), ActionTemplate.RenameLogin).Count > 0
            && ActionSql.LintExecutable(executable, ActionTemplate.DisableLogin).Count > 0,
            "the rename's batch has SQL Server quote both names, and the lint refuses a bare new name or a template that binds one name");
        // Before an ALTER LOGIN, the preflight reads only the login's own rows (seeks), so it waits behind nothing the ALTER would not.
        check(!ActionSql.LoginAlter.Contains("owning_principal_id", StringComparison.Ordinal) && !ActionSql.LoginAlter.Contains("sys.databases", StringComparison.Ordinal)
            && !ActionSql.LoginAlter.Contains("sys.endpoints", StringComparison.Ordinal) && !ActionSql.LoginAlter.Contains("@take", StringComparison.Ordinal)
            && ActionSql.Login.Contains("owning_principal_id", StringComparison.Ordinal)
            && ActionSql.LoginAlter.Contains("sp.class = 100 AND sp.major_id = 0 AND sp.minor_id = 0 AND sp.grantee_principal_id = p.principal_id", StringComparison.Ordinal)
            && ActionSql.Login.Contains("sp.class = 100 AND sp.major_id = 0 AND sp.minor_id = 0 AND sp.grantee_principal_id = p.principal_id", StringComparison.Ordinal),
            "Disable, Enable and Rename's preflight leaves out what the login owns, whose scans wait behind other principals' changes, and both preflights seek CONNECT SQL");
        var lint = ActionSql.Lint().ToList();
        check(lint.Single(result => result.Name == "login service").Problems.Count == 0 && lint.Single(result => result.Name == "login alter").Problems.Count == 0 && lint.Any(result => result.Name == "RenameLogin (dry run)")
            && ActionSql.LintCatalog(ActionSql.LoginService.Replace("UPPER(@name)", "LOGINPROPERTY(@name, N'IsLocked')", StringComparison.Ordinal), 17, database: false).Count > 0,
            "the service lookup and the ALTER LOGIN preflight pass the catalog lint, which refuses LOGINPROPERTY in it");
    }

    private static void Plans(Action<bool, string> check)
    {
        check(ActionService.Plan(Rename(AppUser, "App]User"), AppUser).Single() is { Template: ActionTemplate.RenameLogin, Database: "master" } renamed && renamed.Names.SequenceEqual(["AppUser", "App]User"])
            && ActionService.Plan(State("disable", AppUser), AppUser).Single() is { Template: ActionTemplate.DisableLogin, Database: "master" } disabled && disabled.Names.SequenceEqual(["AppUser"])
            && ActionService.Plan(State("enable", AppUser), AppUser).Single() is { Template: ActionTemplate.EnableLogin, Database: "master" }
            && ActionService.StepTitle(ActionTemplate.RenameLogin) == "Rename" && ActionService.StepTitle(ActionTemplate.DisableLogin) == "Disable the login"
            && ActionService.StepTitle(ActionTemplate.EnableLogin) == "Enable the login",
            "a login's rename, Disable and Enable plan one statement in master, with SSMS's step titles");
    }

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new ActionChecks.FakeHost());
        string Refused(ActionArgs args)
        {
            try { service.Validate(args); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        string DescribeRefused(string dialog, ObjectRefDto target)
        {
            try { service.Validate(new ActionDescribeArgs(Id(), Id(), dialog, target)); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var system = new ObjectRefDto("login", Name: "##MS_PolicyTsqlExecutionLogin##");
        var table = new ObjectRefDto("table", "AppData", "dbo", "Orders");
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("a new name on a disable", State("disable", AppUser) with { NewName = "x" }), ("delete flags on an enable", State("enable", AppUser) with { CloseConnections = false }),
            ("history on a disable", State("disable", AppUser) with { DeleteHistory = false }), ("changes on an enable", State("enable", AppUser) with { Changes = new() }),
            ("an identity on a disable", State("disable", AppUser) with { Identity = new(1, "2026-01-01T00:00:00.000") }), ("a table's disable", State("disable", table)),
            ("a database's enable", State("enable", new ObjectRefDto("database", Name: "AppData"))), ("SQL Server's own login's disable", State("disable", system)),
            ("SQL Server's own login's rename", Rename(system, "x")), ("a login's delete that closes connections", new ActionArgs("delete", Id(), Id(), AppUser, null, true, false)),
            ("a login's delete that deletes backup history", new ActionArgs("delete", Id(), Id(), AppUser, null, false, true)), ("SQL Server's own login's delete", new ActionArgs("delete", Id(), Id(), system, null, false, false)),
            ("mapped users on a table's delete", new ActionArgs("delete", Id(), Id(), table, null, false, false, DropMappedUsers: false)),
            ("a login identity on a table's delete", new ActionArgs("delete", Id(), Id(), table, null, false, false, LoginIdentity: Identity)),
            ("mapped users on a disable", State("disable", AppUser) with { DropMappedUsers = true }), ("mapped users on a rename", Rename(AppUser, "x") with { DropMappedUsers = false }),
            ("a login's delete without the identity it read", new ActionArgs("delete", Id(), Id(), AppUser, null, false, false, DropMappedUsers: true)),
            ("a login's delete with a short SID", new ActionArgs("delete", Id(), Id(), AppUser, null, false, false, LoginIdentity: Identity with { Sid = "0" })),
            ("a login without a name", State("disable", new ObjectRefDto("login"))), ("secrets on a disable", State("disable", AppUser) with { Secrets = new("x", null) }),
            ("SQL Server's own login with a trailing space", State("disable", system with { Name = system.Name + " " })), ("a rename of one with trailing spaces", Rename(system with { Name = system.Name + "  " }, "x")),
            ("a login's rename to SQL Server's own form", Rename(AppUser, "##AppUser##")), ("one with a trailing space", Rename(AppUser, "##AppUser## ")),
            ("a login identity on a rename", Rename(AppUser, "x") with { LoginIdentity = Identity }),
            ("a short SID", State("disable", AppUser) with { LoginIdentity = Identity with { Sid = "0" } }), ("a long SID", State("disable", AppUser) with { LoginIdentity = Identity with { Sid = new string('0', 172) + "F" } }),
            ("a lower-case SID", State("disable", AppUser) with { LoginIdentity = Identity with { Sid = "0a" } }), ("a SID with a line break", State("enable", AppUser) with { LoginIdentity = Identity with { Sid = "01\n" } }),
            ("no SID", State("disable", AppUser) with { LoginIdentity = Identity with { Sid = null! } }), ("a created without milliseconds", State("disable", AppUser) with { LoginIdentity = Identity with { Created = "2026-01-02T03:04:05" } }),
            ("a created with a line break", State("disable", AppUser) with { LoginIdentity = Identity with { Created = "2026-01-02T03:04:05.000\n" } }),
            // Members other actions added to ActionArgs (Attach's databases, Take Offline's and Detach's flags) are no login's.
            ("databases on a disable", State("disable", AppUser) with { Databases = [] }), ("databases on an enable", State("enable", AppUser) with { Databases = [] }),
            ("dropConnections on a disable", State("disable", AppUser) with { DropConnections = false }), ("updateStatistics on an enable", State("enable", AppUser) with { UpdateStatistics = false })
        };
        var accepted = invalid.Where(item => Refused(item.Args) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        check(accepted.Count == 0, "Validate refuses what zod refuses for a login's actions: " + string.Join(", ", accepted));
        check(Refused(State("disable", AppUser)) == "accepted" && Refused(State("enable", new ObjectRefDto("login", Name: @"CONTOSO\Ops"))) == "accepted"
            && Refused(State("disable", AppUser) with { LoginIdentity = Identity }) == "accepted" && Refused(State("enable", AppUser) with { LoginIdentity = Identity with { Sid = new string('0', 171) + "F" } }) == "accepted"
            && Refused(Rename(AppUser, "App]User")) == "accepted" && Refused(Rename(new ObjectRefDto("login", Name: "sa"), @"a\b")) == "accepted"
            && Refused(Rename(new ObjectRefDto("database", Name: "AppData"), "##AppData##")) == "accepted"
            && Refused(new ActionArgs("delete", Id(), Id(), AppUser, null, false, false, LoginIdentity: Identity)) == "accepted"
            && Refused(new ActionArgs("delete", Id(), Id(), AppUser, null, false, false, LoginIdentity: Identity, DropMappedUsers: true)) == "accepted"
            && Refused(new ActionArgs("delete", Id(), Id(), new ObjectRefDto("login", Name: "sa"), null, false, false, LoginIdentity: Identity)) == "accepted",
            "a login's Disable, Enable and Delete (with the identity of the login it read, Delete with or without its mapped users) and Rename are accepted, a backslash and sa's Delete left to the preflight, which knows the login's type");
        check(DescribeRefused("loginFacts", AppUser) == "accepted" && DescribeRefused("loginFacts", table) == "INVALID_PARAMS" && DescribeRefused("loginFacts", system) == "INVALID_PARAMS"
            && DescribeRefused("loginFacts", new ObjectRefDto("database", Name: "AppData")) == "INVALID_PARAMS" && DescribeRefused("loginfacts", AppUser) == "INVALID_PARAMS"
            && DescribeRefused("loginFacts", system with { Name = system.Name + " " }) == "INVALID_PARAMS",
            "the loginFacts describe takes only a login Disable may act on");
    }

    private static void Refusals(Action<bool, string> check)
    {
        using var service = new ActionService(new ActionChecks.FakeHost());
        var cases = new (string Name, LoginFactsDto Facts, ActionArgs Args, string? Code, string? Message)[]
        {
            ("a SQL login's backslash", Facts("sql"), Rename(AppUser, @"App\User"), "NOT_SUPPORTED", "A SQL Server login's name cannot contain a backslash."),
            ("sa's backslash", Facts("sa"), Rename(AppUser, @"x\y"), "NOT_SUPPORTED", "A SQL Server login's name cannot contain a backslash."),
            ("a Windows login's domain", Facts("windowsUser", "U"), Rename(AppUser, @"CONTOSO\New"), null, null),
            ("a name in use", Facts("sql", nameInUse: true), Rename(AppUser, "Taken"), "NAME_IN_USE", "The name Taken is already used by another login or server role."),
            ("the own login's disable", Facts("sql", own: true), State("disable", AppUser), "NOT_SUPPORTED", "This is the login this connection uses. Connect with another login to change it."),
            ("the own login's rename", Facts("sql", own: true), Rename(AppUser, "x"), "NOT_SUPPORTED", null),
            ("the own login's enable", Facts("sql", own: true), State("enable", AppUser), null, null),
            ("a group's disable", Facts("windowsGroup", "G"), State("disable", AppUser), "NOT_SUPPORTED", "A Windows group cannot be disabled. Deny it permission to connect (DENY CONNECT SQL) instead."),
            ("an Entra rename", Facts("externalUser", "E"), Rename(AppUser, "x"), "NOT_SUPPORTED", "A Microsoft Entra login cannot be renamed."),
            ("SQL Server's own login's enable", Facts("system"), State("enable", AppUser), "NOT_SUPPORTED", "This login belongs to SQL Server and cannot be changed."),
            ("no ALTER ANY LOGIN", Facts("sql", canAlter: false), State("disable", AppUser), "PERMISSION_DENIED", "You do not have permission to change logins (ALTER ANY LOGIN)."),
            ("a plain disable", Facts("sql"), State("disable", AppUser), null, null),
            ("a Windows login's rename to ##…##", Facts("windowsUser", "U"), Rename(AppUser, "##AppUser##"), "NOT_SUPPORTED", "Names that start and end with ## are reserved for SQL Server's own logins."),
            ("a SQL login's rename to ##…## with a backslash", Facts("sql"), Rename(AppUser, @"##App\User## "), "NOT_SUPPORTED", "Names that start and end with ## are reserved for SQL Server's own logins."),
            ("the login that was read", Facts("sql"), State("disable", AppUser) with { LoginIdentity = Identity }, null, null),
            // Another principal took the name after the facts were read: its own refusals never get a say.
            ("another SID", Facts("sql", own: true), State("disable", AppUser) with { LoginIdentity = Identity with { Sid = "02" } }, "NOT_FOUND",
                "The login AppUser is not the one that was read: it was renamed, dropped or replaced since. Refresh Object Explorer and try again."),
            ("another create date", Facts("sql"), State("enable", AppUser) with { LoginIdentity = Identity with { Created = "2026-01-01T00:00:00.001" } }, "NOT_FOUND", null)
        };
        var wrong = cases.Where(item => service.LoginRefusal(item.Facts, item.Args) is var refused && (refused?.Code != item.Code || item.Message is not null && refused?.Message != item.Message))
            .Select(item => item.Name).ToList();
        check(wrong.Count == 0, "a login action's preflight refuses by the rules, then a rename's new name: " + string.Join(", ", wrong));
        check(ActionService.ServiceOfName(@"NT SERVICE\SQLSERVERAGENT") == "SQLSERVERAGENT" && ActionService.ServiceOfName(@"nt service\MSSQL$SQL2") == "MSSQL$SQL2"
            && ActionService.ServiceOfName(@"NT SERVICE\") is null && ActionService.ServiceOfName(@"CONTOSO\svc") is null && ActionService.ServiceOfName("NT SERVICE") is null,
            "a per-service login names its service when sys.dm_server_services cannot be read");
        // The live checks rename their scratch login to a hostile name and add a taken one; a crashed run's must still be swept.
        check(new[] { "VariaScratch_20261031010203_0a1b2c3d", "VariaScratch_20261031010203_0a1b2c3d_lt", "VariaScratch_20261031010203_0a1b2c3d_lr]' --", "##VariaScratch_20261031010203_0a1b2c3d_ls##", "VariaScratch_20261031010203_0a1b2c3d_lsx",
            "VariaScratch_20261031010203_0a1b2c3d_ld]' --", "VariaScratch_20261031010203_0a1b2c3d_ld2", "VariaScratch_20261031010203_0a1b2c3d_ld3",
                "VariaScratch_20261031010203_0a1b2c3d_lk", "VariaScratch_20261031010203_0a1b2c3d_lp", "VariaScratch_20261031010203_0a1b2c3d_lm" }.All(ScratchDatabase.SweepableLogin)
            && !new[] { "VariaScratch_20261031010203_0a1b2c3d_x", "VariaScratch_2026_0a1b2c3d", "AppUser", "VariaScratch_20261031010203_0a1b2c3d_lr]'", "##VariaScratch_20261031010203_0a1b2c3d##",
                "##VariaScratch_20261031010203_0a1b2c3d_ls", "##MS_PolicyEventProcessingLogin##",
                "VariaScratch_20261031010203_0a1b2c3d_ld]'", "VariaScratch_20261031010203_0a1b2c3d_ld]' -- x" }.Any(ScratchDatabase.SweepableLogin),
            "the scratch sweep drops the login action checks' scratch logins under every name they give them, and no other login");
    }

    private static void Errors(Action<bool, string> check)
    {
        static SqlException Sql(int number) => ConnectionFailureChecks.Sql(number, 1, 16, "server", "failed");
        var expected = new Dictionary<int, string>
        {
            [15025] = "NAME_IN_USE", [15434] = "IN_USE", [15174] = "DEPENDENTS", [15170] = "DEPENDENTS", [15141] = "DEPENDENTS", [15155] = "DEPENDENTS", [15186] = "DEPENDENTS",
            [15144] = "DEPENDENTS", [15138] = "DEPENDENTS", [15421] = "DEPENDENTS", [15284] = "DEPENDENTS", [15183] = "DEPENDENTS", [15405] = "NOT_SUPPORTED", [15021] = "NOT_SUPPORTED",
            [15099] = "NOT_SUPPORTED", [15151] = "PERMISSION_DENIED", [15247] = "PERMISSION_DENIED"
        };
        var wrong = expected.Where(pair => ActionErrors.CodeOf(Sql(pair.Key), null) != pair.Value).Select(pair => pair.Key).ToList();
        check(wrong.Count == 0 && ActionErrors.Numbers.Values.SelectMany(numbers => numbers).GroupBy(number => number).All(group => group.Count() == 1),
            "SQL Server's login errors map onto the action error codes, each number once: " + string.Join(", ", wrong));
        check(ActionErrors.LoginPermissionAdvice == "Changing a login needs ALTER ANY LOGIN, and CONTROL SERVER for a member of sysadmin.", "a login's PERMISSION_DENIED names the permissions");
    }

    private static async Task ServiceAsync(Action<bool, string> check)
    {
        var host = new ActionChecks.FakeHost(5);
        using var cloud = new ActionService(host);
        var disable = await cloud.ExecuteAsync(State("disable", AppUser), CancellationToken.None);
        var rename = await cloud.ExecuteAsync(Rename(AppUser, "x"), CancellationToken.None);
        var facts = await cloud.DescribeAsync(new(Id(), Id(), "loginFacts", AppUser), CancellationToken.None);
        check(disable.Error?.Code == "NOT_SUPPORTED" && rename.Error?.Code == "NOT_SUPPORTED" && facts.Error?.Code == "NOT_SUPPORTED" && facts.Login is null && disable.Sessions is null
            && host.Connections == 0, "Azure SQL Database answers a login's actions and its facts NOT_SUPPORTED before any connection opens");
        var unreachable = new ActionChecks.FakeHost();
        using var service = new ActionService(unreachable);
        var failed = await service.DescribeAsync(new(Id(), Id(), "loginFacts", AppUser), CancellationToken.None);
        check(failed.Error is not null && failed.Login is null && unreachable.Connections == 1 && service.RunningCount == 0, "a loginFacts describe that cannot connect answers an error value and frees its request");
    }
}
