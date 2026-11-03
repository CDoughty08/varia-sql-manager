using Varia.Backend.Actions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of PR D2b, New Login's User Mapping: the four templates (CREATE USER … FOR LOGIN, ALTER USER … WITH
/// DEFAULT_SCHEMA, CREATE SCHEMA … AUTHORIZATION, ALTER ROLE … ADD MEMBER) and their lint, the read and preflight statements, the
/// plan's order, the statement bound, Script Action's text for both script forms with hostile names, the steps' details, the partial
/// state message, createLogin's mapping validation and the loginDatabaseRoles describe's. LoginLiveChecks run the SQL.</summary>
internal static class LoginMappingChecks
{
    private static string NL => LoginSql.NL;
    private static readonly ActionTemplate[] Templates = [ActionTemplate.CreateUserForLogin, ActionTemplate.AlterUserSchema, ActionTemplate.CreateSchemaFor, ActionTemplate.AddRoleMember];

    public static async Task RunAsync(Action<bool, string> check)
    {
        TemplateChecks(check);
        Plan(check);
        Script(check);
        Partial(check);
        Validation(check);
        await ServiceAsync(check);
    }

    internal static UserMappingDto Map(string database, string user, string? schema = null, params string[] roles) => new(database, user, schema, [.. roles]);

    private static void TemplateChecks(Action<bool, string> check)
    {
        static string Text(ActionTemplate template, params string[] names) => ActionSql.Statement(ActionSql.Checked(new(template, "Ap]p", names)));
        check(Text(ActionTemplate.CreateUserForLogin, "u]1", "l'x") == "CREATE USER [u]]1] FOR LOGIN [l'x]"
            && Text(ActionTemplate.AlterUserSchema, "u]1", "s]") == "ALTER USER [u]]1] WITH DEFAULT_SCHEMA=[s]]]"
            && Text(ActionTemplate.CreateSchemaFor, "s]", "u]1") == "CREATE SCHEMA [s]]] AUTHORIZATION [u]]1]"
            && Text(ActionTemplate.AddRoleMember, "db_data]reader", "u]1") == "ALTER ROLE [db_data]]reader] ADD MEMBER [u]]1]",
            "User Mapping's statements read as SMO writes them, names bracketed with ] doubled");
        var lint = Templates.SelectMany(template => new[] { false, true }.SelectMany(dry => ActionSql.LintExecutable(ActionSql.Executable(template, dry), template).Select(problem => template + ": " + problem))).ToList();
        var spliced = Templates.Where(template => ActionSql.LintExecutable(ActionSql.Executable(template).Replace("QUOTENAME(@p2)", "@p2", StringComparison.Ordinal), template).Count == 0
            || ActionSql.LintExecutable(ActionSql.Executable(template).Replace("QUOTENAME(@p1)", "@p1", StringComparison.Ordinal), template).Count == 0
            || ActionSql.LintExecutable(ActionSql.Executable(template).Replace("QUOTENAME(@db)", "@db", StringComparison.Ordinal), template).Count == 0).ToList();
        check(lint.Count == 0 && spliced.Count == 0 && Templates.All(template => ActionSql.ParameterCount(template) == 2)
            && Templates.All(template => ActionSql.Executable(template).Contains("QUOTENAME(@db) + N'.sys.sp_executesql'", StringComparison.Ordinal)),
            "the four User Mapping templates pass the executable lint run and dry run, take two names, run in their database's module, and a name or the database spliced in is refused: "
            + string.Join("; ", lint.Concat(spliced.Select(template => template + " accepted a spliced name"))));
        check(Templates.Select(ActionService.StepTitle).SequenceEqual(["Create a user", "Set the default schema", "Create a schema", "Add to a database role"]),
            "User Mapping's steps have constant titles");
        var reads = new[] { ("database roles", LoginSql.DatabaseRoles), ("mapping preflight", LoginSql.MappingPreflight) };
        var readProblems = reads.SelectMany(read => ActionSql.LintCatalog(read.Item2, ExplorerCatalog.MaxBand, database: true).Select(problem => read.Item1 + ": " + problem)).ToList();
        var catches = reads.All(read => ActionSql.LintCatalog(read.Item2 + "\nSELECT HAS_DBACCESS(N'x');", ExplorerCatalog.MaxBand, database: true).Count > 0
            && ActionSql.LintCatalog(read.Item2.Replace("ORDER BY p.name", "AND p.name = @db ORDER BY p.name", StringComparison.Ordinal), ExplorerCatalog.MaxBand, database: true).Count > 0
            && ActionSql.LintCatalog(read.Item2 + "\nSELECT N'x' AS x;", ExplorerCatalog.MaxBand, database: true).Count > 0);
        check(readProblems.Count == 0 && catches && ActionSql.Lint().Any(item => item.Name == "login database roles") && ActionSql.Lint().Any(item => item.Name == "login mapping preflight")
            && ActionSql.Lint().Count(item => Templates.Any(template => item.Name.StartsWith(template.ToString(), StringComparison.Ordinal))) == Templates.Length * 2,
            "User Mapping's read and preflight are catalog statements clean inside a database (no @db, no HAS_DBACCESS, no stray literal), and ActionSql.Lint covers them and the templates: "
            + string.Join("; ", readProblems));
        check(LoginSql.DatabaseRoles.Contains("dp.grantee_principal_id = 2 AND dp.class = 0 AND dp.type = 'CO' AND dp.state IN ('G', 'W')", StringComparison.Ordinal)
            && LoginSql.MappingPreflight.Contains("@schema IS NULL OR EXISTS", StringComparison.Ordinal),
            "guest counts as enabled only with CONNECT granted on the database, and no default schema needs no schema");
    }

    private static void Plan(Action<bool, string> check)
    {
        var login = LoginChecks.Sql("L");
        static string Steps(IEnumerable<PlannedStatement> plan) => string.Join(",", plan.Select(statement => statement.Template + "@" + statement.Database + ":" + string.Join("/", statement.Names)));
        var mappings = new List<UserMappingDto> { Map("zeta", "zu"), Map("Alpha", "au", "sales", "db_owner", "Readers", "db_datareader"), Map("beta", "bu", "dbo") };
        var plan = Steps(LoginSql.Mappings(login, mappings, new HashSet<string>(StringComparer.Ordinal) { "Alpha" }));
        check(plan == "CreateUserForLogin@Alpha:au/L,AlterUserSchema@Alpha:au/sales,CreateSchemaFor@Alpha:sales/au,AddRoleMember@Alpha:db_datareader/au,AddRoleMember@Alpha:db_owner/au,"
                + "AddRoleMember@Alpha:Readers/au,CreateUserForLogin@beta:bu/L,AlterUserSchema@beta:bu/dbo,CreateUserForLogin@zeta:zu/L",
            "User Mapping plans per database by name: CREATE USER, then the default schema, CREATE SCHEMA only where it is missing, then each role by name: " + plan);
        var status = new LoginStatusDto("deny", false);
        check(LoginSql.Statements(login, status, ["sysadmin"], mappings) == 1 + 1 + 1 + 1 + 1 + (1 + 2 + 3) + (1 + 2) && LoginSql.Statements(login, new("grant", true), [], []) == 1
            && LoginSql.Statements(login with { Credentials = ["c1", "c2"] }, new("grant", true), [], []) == 3,
            "the statement bound counts CREATE LOGIN, Deny, Disable, credentials, server roles, and per mapping CREATE USER, two for a default schema and one per role (logins.ts newLoginStatements)");
        check(ActionService.StepDetail(new(ActionTemplate.AddRoleMember, "Ap]p", ["db_owner", "u"])) == "db_owner in Ap]p" && ActionService.StepDetail(new(ActionTemplate.CreateUserForLogin, "Ap]p", ["u", "L"])) == "Ap]p"
            && ActionService.StepDetail(new(ActionTemplate.CreateSchemaFor, "Ap]p", ["s", "u"])) == "Ap]p" && ActionService.StepDetail(new(ActionTemplate.AddServerRoleMember, "master", ["sysadmin", "L"])) == "sysadmin"
            && ActionService.StepDetail(new(ActionTemplate.DenyConnect, "master", ["L"])) is null,
            "a mapping step's detail names its database, and a database role's its role and database");
    }

    private static void Script(Action<bool, string> check)
    {
        const string header = "/* header */";
        var mappings = new List<UserMappingDto> { Map("Ap]p'x", "u'1", "s]", "db_data]reader"), Map("App2", "app") };
        var sql = LoginSql.ScriptText(LoginChecks.Sql("app", mustChange: false), [], new("grant", true), mappings, new HashSet<string>(StringComparer.Ordinal) { "Ap]p'x" }, header);
        var expected = "USE [master]" + NL + "GO" + NL + header + NL + "SET XACT_ABORT ON;" + NL + "BEGIN TRANSACTION;" + NL
            + "CREATE LOGIN [app] WITH PASSWORD=<password>, DEFAULT_DATABASE=[master], CHECK_EXPIRATION=ON, CHECK_POLICY=ON;" + NL
            + "EXEC [App2].sys.sp_executesql N'CREATE USER [app] FOR LOGIN [app]';" + NL
            + "EXEC [Ap]]p'x].sys.sp_executesql N'CREATE USER [u''1] FOR LOGIN [app]';" + NL
            + "EXEC [Ap]]p'x].sys.sp_executesql N'ALTER USER [u''1] WITH DEFAULT_SCHEMA=[s]]]';" + NL
            + "EXEC [Ap]]p'x].sys.sp_executesql N'CREATE SCHEMA [s]]] AUTHORIZATION [u''1]';" + NL
            + "EXEC [Ap]]p'x].sys.sp_executesql N'ALTER ROLE [db_data]]reader] ADD MEMBER [u''1]';" + NL
            + "COMMIT TRANSACTION;" + NL + "GO" + NL;
        var batches = Varia.Backend.SqlScript.Parse(sql);
        check(sql == expected && batches.Count == 2, "a SQL Server login's script keeps one transaction batch: each mapped database's statement runs there through its sp_executesql, quotes doubled:" + NL + sql);
        var windows = LoginSql.ScriptText(LoginChecks.Windows("D\\u"), [], new("grant", true), [Map("App", "D\\u", null, "db_owner")], new HashSet<string>(), header);
        check(windows == "USE [master]" + NL + "GO" + NL + "CREATE LOGIN [D\\u] FROM WINDOWS WITH DEFAULT_DATABASE=[master]" + NL + "GO" + NL
                + "USE [App]" + NL + "GO" + NL + "CREATE USER [D\\u] FOR LOGIN [D\\u]" + NL + "GO" + NL + "USE [App]" + NL + "GO" + NL + "ALTER ROLE [db_owner] ADD MEMBER [D\\u]" + NL + "GO" + NL,
            "a Windows login's script is SSMS's: USE [db] and GO before each mapped database's statement: " + windows);
    }

    private static void Partial(Action<bool, string> check)
    {
        static ActionStepDto Step(string status, ActionTemplate? template = null) => new(status, template is { } value ? ActionService.StepTitle(value) : ActionService.CreateLoginStep);
        var failure = new ActionError("NOT_FOUND", "Cannot add the principal.", false);
        var mapped = ActionService.PartlyCreated(failure, new("grant", true), [Step("done"), Step("done", ActionTemplate.CreateUserForLogin), Step("failed", ActionTemplate.AddRoleMember)]);
        var schema = ActionService.PartlyCreated(failure, new("grant", true), [Step("done"), Step("done", ActionTemplate.CreateUserForLogin), Step("failed", ActionTemplate.CreateSchemaFor)]);
        var server = ActionService.PartlyCreated(failure, new("grant", true), [Step("done"), Step("failed", ActionTemplate.AddServerRoleMember), Step("skipped", ActionTemplate.CreateUserForLogin)]);
        var whole = ActionService.PartlyCreated(failure, new("grant", true), [Step("done"), Step("done", ActionTemplate.CreateUserForLogin), Step("done", ActionTemplate.AddRoleMember)]);
        check(mapped.Message == ActionService.LoginCreatedMessage + " " + ActionService.LoginMappingsMessage + " " + failure.Message
            && schema.Message == mapped.Message
            && server.Message == ActionService.LoginCreatedMessage + " " + ActionService.LoginRolesMessage + " " + ActionService.LoginMappingsMessage + " " + failure.Message
            && whole.Message == ActionService.LoginCreatedMessage + " " + failure.Message,
            "a failure or Stop after CREATE LOGIN says when a database was not mapped as chosen: " + server.Message);
    }

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new LoginHost());
        string Refused(ActionArgs args, bool script = false)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        ActionArgs With(params UserMappingDto[] mappings) => LoginChecks.Create(LoginChecks.Windows("D\\a"), null, mappings: [.. mappings]);
        var many = Enumerable.Range(0, 257).Select(index => Map("d" + index, "u")).ToArray();
        var roles = Enumerable.Range(0, 256).Select(index => "r" + index).ToArray();
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("no mappings", With() with { Mappings = null }),
            ("a database twice", With(Map("A", "u"), Map("A", "v"))),
            ("an empty database", With(Map("", "u"))),
            ("an empty user", With(Map("A", ""))),
            ("a 129-unit user", With(Map("A", new string('u', 129)))),
            ("U+0000 in a user", With(Map("A", "u\0v"))),
            ("an empty schema", With(Map("A", "u", ""))),
            ("no roles", With(new UserMappingDto("A", "u", null, null!))),
            ("public", With(Map("A", "u", null, "public"))),
            ("a role twice", With(Map("A", "u", null, "r", "r"))),
            ("257 roles", With(Map("A", "u", null, [.. roles, "r256"]))),
            ("257 mappings", With(many)),
            ("more than 512 statements", With(Map("A", "u", null, roles), Map("B", "u", null, roles))),
            ("mappings on a rename", new ActionArgs("rename", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new("table", "AppData", "dbo", "T"), "U", Mappings: [Map("A", "u")]))
        };
        var accepted = invalid.Where(item => Refused(item.Args) != "INVALID_PARAMS").Select(item => item.Name + " (" + Refused(item.Args) + ")").ToList();
        check(accepted.Count == 0, "createLogin's validation refuses the mappings zod refuses: " + string.Join(", ", accepted));
        var valid = new (string Name, ActionArgs Args, bool Script)[]
        {
            ("no mapping", With(), false),
            ("hostile names in master", With(Map("master", "u]'; DROP USER dbo; --", "s]'x", "db_data]reader", "Db_Data]Reader")), false),
            ("256 mappings", With([.. many.Take(256)]), false),
            ("256 roles", With(Map("A", "u", null, roles)), false),
            ("a Script", With(Map("A", "u", "dbo", "db_owner")), true)
        };
        var refused = valid.Where(item => Refused(item.Args, item.Script) != "accepted").Select(item => item.Name + " (" + Refused(item.Args, item.Script) + ")").ToList();
        check(refused.Count == 0, "createLogin accepts mappings with hostile names, SQL Server's own databases, 256 mappings and 256 roles each: " + string.Join(", ", refused));
        string DescribeRefused(ObjectRefDto target, string dialog = "loginDatabaseRoles")
        {
            try { service.Validate(new ActionDescribeArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), dialog, target)); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(ActionsCatalog.Current.Logins.RolesDescribe == "loginDatabaseRoles" && DescribeRefused(new("database", Name: "master")) == "accepted" && DescribeRefused(new("database", Name: "Ap]p'x")) == "accepted"
            && DescribeRefused(new("server")) == "INVALID_PARAMS" && DescribeRefused(new("table", "AppData", "dbo", "T")) == "INVALID_PARAMS" && DescribeRefused(new("database", Name: "")) == "INVALID_PARAMS"
            && DescribeRefused(new("database", Name: new string('d', 129))) == "INVALID_PARAMS" && DescribeRefused(new("database", Name: "A", Schema: "dbo")) == "INVALID_PARAMS",
            "User Mapping's loginDatabaseRoles describe takes a database, SQL Server's own included, and nothing else");
    }

    private static async Task ServiceAsync(Action<bool, string> check)
    {
        var host = new LoginHost();
        using var service = new ActionService(host);
        var plain = LoginChecks.Create(LoginChecks.Sql("app"), null, mappings: [Map("App", "app", null, "db_owner")]) with { Secrets = null };
        var script = await service.ScriptAsync(plain, CancellationToken.None);
        check(script.Error is null && host.Connections == 0 && script.Text == LoginSql.ScriptText(plain.Login!, [], plain.Status!, plain.Mappings!, new HashSet<string>(), ActionsCatalog.Current.Logins.ScriptHeader),
            "Script Action with mappings but no default schema still builds its text from the request alone, opening no connection");
        var schema = plain with { Mappings = [Map("App", "app", "sales")] };
        var read = await service.ScriptAsync(schema, CancellationToken.None);
        check(read.Error?.Code == "CONNECTION_LOST" && read.Text is null && host.Connections == 1,
            "a default schema makes Script read whether the database has it (SSMS scripts CREATE SCHEMA only for a missing one), and a failed read is a value");
        var cloud = new LoginHost(5);
        using var refusing = new ActionService(cloud);
        var describe = await refusing.DescribeAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "loginDatabaseRoles", new("database", Name: "App")), CancellationToken.None);
        var reading = await service.DescribeAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "loginDatabaseRoles", new("database", Name: "App")), CancellationToken.None);
        check(describe.Error?.Code == "NOT_SUPPORTED" && cloud.Connections == 0 && reading.Error?.Code == "CONNECTION_LOST" && reading.LoginDatabaseRoles is null,
            "the loginDatabaseRoles describe follows New Login's engine gate, and a failed read is a value");
    }

    private sealed class LoginHost(int edition = 3) : IActionHost
    {
        public int Connections;
        public ServerProfile Profile(string connectionId) => new(16, "16.0.4135.4", edition, "sa", false, true, false, 16);
        public Microsoft.Data.SqlClient.SqlConnection Connection(string connectionId)
        {
            Interlocked.Increment(ref Connections);
            return new Microsoft.Data.SqlClient.SqlConnection("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false");
        }
        public Task OpenAsync(Microsoft.Data.SqlClient.SqlConnection connection, CancellationToken token) => connection.OpenAsync(token);
        public bool ClearPoolsFor(string connectionId, string database) => false;
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
        public bool FreeDatabase(string connectionId, string database) => false;
        public IReadOnlySet<int> PoolSessions(string connectionId) => new HashSet<int>();
    }
}
