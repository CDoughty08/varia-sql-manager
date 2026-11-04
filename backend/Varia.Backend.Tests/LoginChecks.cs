using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of PR D2a, New Login: the CREATE LOGIN builder's lint (and that it catches what it exists for), the
/// statement SMO would write for each shape, the statements after it in SSMS's order, Script Action's one-batch text with the
/// placeholder (critic A14), the scrubber, createLogin's validation (refused without echoing a password), the engine gate, and a
/// run whose connection fails answering a value with no step and no password. No server is reached: LoginLiveChecks run the SQL.</summary>
internal static class LoginChecks
{
    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);
    private static readonly ObjectRefDto Server = new("server");
    private static string NL => LoginSql.NL;

    public static async Task RunAsync(Action<bool, string> check)
    {
        Lint(check);
        Statements(check);
        Script(check);
        Scrub(check);
        Partial(check);
        Validation(check);
        await ServiceAsync(check);
        await LoginMappingChecks.RunAsync(check);
    }

    internal static NewLoginDto Sql(string name, bool policy = true, bool expiration = true, bool mustChange = true, string database = "master", string? language = null) =>
        new("sql", name, database, language, policy, expiration, mustChange);
    internal static NewLoginDto Windows(string name, string database = "master", string? language = null) => new("windows", name, database, language);
    internal static ActionArgs Create(NewLoginDto login, string? password, List<string>? roles = null, LoginStatusDto? status = null, List<UserMappingDto>? mappings = null) =>
        new("createLogin", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), Server, Login: login, ServerRoles: roles ?? [], Status: status ?? new("grant", true), Mappings: mappings ?? [],
            Secrets: login.Auth == "sql" ? new(password) : null);

    private static void Lint(Action<bool, string> check)
    {
        var results = LoginSql.Lint().ToList();
        var problems = results.SelectMany(result => result.Problems.Select(problem => result.Name + ": " + problem)).ToList();
        check(problems.Count == 0 && results.Count == (LoginSql.Corpus().Count() + LoginSql.OptionsCorpus().Count() + LoginSql.PasswordCorpus().Count()) * 2 && LoginSql.Corpus().Count() == 10,
            "every CREATE LOGIN the builder writes (Windows, four SQL password option chains, with and without a language; run and dry run), and every ALTER LOGIN of Login Properties (D2c), passes its lint: " + string.Join("; ", problems.Take(5)));
        var sql = LoginSql.CreateExecutable(Sql("x"));
        var windows = LoginSql.CreateExecutable(Windows("D\\x"));
        var mutations = new (string Name, string Text)[]
        {
            ("a name spliced in", sql.Replace("QUOTENAME(@p1)", "@p1", StringComparison.Ordinal)),
            ("the default database spliced in", sql.Replace("QUOTENAME(@p2)", "@p2", StringComparison.Ordinal)),
            ("the database outside the module's QUOTENAME", sql.Replace("QUOTENAME(@db) + N'.sys.sp_executesql'", "@db + N'.sys.sp_executesql'", StringComparison.Ordinal)),
            ("no NULL guard", sql.Replace(LoginSql.PasswordGuard, "", StringComparison.Ordinal)),
            ("the NULL guard after the statement", sql.Replace(LoginSql.PasswordGuard, "", StringComparison.Ordinal) + LoginSql.PasswordGuard),
            ("no binary collation", sql.Replace(" COLLATE Latin1_General_BIN2", "", StringComparison.Ordinal)),
            ("the password unquoted", sql.Replace(LoginSql.PasswordExpression, "N' WITH PASSWORD=N''' + @password + N''''", StringComparison.Ordinal)),
            ("the password quoted twice", sql.Replace(LoginSql.PasswordExpression, LoginSql.PasswordExpression + " + " + LoginSql.PasswordExpression, StringComparison.Ordinal)),
            ("the password returned", sql + "\nSELECT @password AS p;"),
            ("the password passed on", sql.Replace("EXEC @module @stmt;", "EXEC @module @stmt, N'@password nvarchar(128)', @password;", StringComparison.Ordinal)),
            ("a password on a Windows login", windows.Replace("N' FROM WINDOWS", LoginSql.PasswordExpression + " + N' FROM WINDOWS", StringComparison.Ordinal)),
            ("no quoting guard", sql.Replace(ActionSql.Guard, "", StringComparison.Ordinal)),
            ("a dynamic EXEC", sql.Replace("EXEC @module @stmt;", "EXEC (@stmt);", StringComparison.Ordinal)),
            ("two runs", sql + "\nEXEC @module @stmt;"),
            ("no run", sql.Replace("EXEC @module @stmt;", "", StringComparison.Ordinal)),
            ("a SID", sql.Replace("N', CHECK_EXPIRATION=ON, CHECK_POLICY=ON'", "N', SID=0x01, CHECK_EXPIRATION=ON, CHECK_POLICY=ON'", StringComparison.Ordinal)),
            ("a hashed password", sql.Replace("N' MUST_CHANGE'", "N' HASHED'", StringComparison.Ordinal)),
            ("a literal that is not keyword text", sql.Replace("N' MUST_CHANGE'", "N' MUST_CHANGE'' --'", StringComparison.Ordinal)),
            ("an unknown keyword literal", sql.Replace("N' MUST_CHANGE'", "N' CREDENTIAL=x'", StringComparison.Ordinal)),
            ("a format hole", sql.Replace("QUOTENAME(@p1)", "QUOTENAME({0})", StringComparison.Ordinal)),
            ("a password hash read", sql + "\nSELECT l.password_hash FROM sys.sql_logins AS l;"),
            ("an undeclared variable", sql.Replace("QUOTENAME(@p2)", "QUOTENAME(@p9)", StringComparison.Ordinal))
        };
        var missed = mutations.Where(mutation => LoginSql.LintExecutable(mutation.Text).Count == 0).Select(mutation => mutation.Name).ToList();
        check(missed.Count == 0 && mutations.All(mutation => mutation.Text != sql && mutation.Text != windows),
            "the CREATE LOGIN lint refuses spliced names, a missing or late NULL guard, the password outside one binary-collation REPLACE, returned or passed on, "
            + "a Windows password, a missing quoting guard, dynamic, double or missing runs, SID, HASHED, stray literals, format holes, hash reads and undeclared names: " + string.Join(", ", missed));
        check(sql.StartsWith(LoginSql.PasswordGuard, StringComparison.Ordinal) && !windows.Contains("@password", StringComparison.Ordinal) && windows.Contains("FROM WINDOWS", StringComparison.Ordinal)
            && LoginSql.CreateExecutable(Sql("x"), dryRun: true).EndsWith("SELECT @stmt AS stmt;", StringComparison.Ordinal) && !LoginSql.CreateExecutable(Sql("x"), dryRun: true).Contains("EXEC", StringComparison.Ordinal)
            && LoginSql.CreateExecutable(Sql("x", language: "Deutsch")).Contains("QUOTENAME(@p3)", StringComparison.Ordinal) && !sql.Contains("@p3", StringComparison.Ordinal),
            "a SQL Server login's batch checks its password first, a Windows login's has none, a language is a third QUOTENAME'd parameter only when chosen, and the dry run selects the statement");
    }

    private static void Statements(Action<bool, string> check)
    {
        var cases = new (NewLoginDto Login, string? Password, string Expected)[]
        {
            (Windows("CONTOSO\\ann"), null, "CREATE LOGIN [CONTOSO\\ann] FROM WINDOWS WITH DEFAULT_DATABASE=[master]"),
            (Windows("CONTOSO\\ann", "AppData", "us_english"), null, "CREATE LOGIN [CONTOSO\\ann] FROM WINDOWS WITH DEFAULT_DATABASE=[AppData], DEFAULT_LANGUAGE=[us_english]"),
            (Sql("app"), null, "CREATE LOGIN [app] WITH PASSWORD=<password> MUST_CHANGE, DEFAULT_DATABASE=[master], CHECK_EXPIRATION=ON, CHECK_POLICY=ON"),
            (Sql("app", mustChange: false), "it's", "CREATE LOGIN [app] WITH PASSWORD=N'it''s', DEFAULT_DATABASE=[master], CHECK_EXPIRATION=ON, CHECK_POLICY=ON"),
            (Sql("app", expiration: false, mustChange: false), "p", "CREATE LOGIN [app] WITH PASSWORD=N'p', DEFAULT_DATABASE=[master], CHECK_EXPIRATION=OFF, CHECK_POLICY=ON"),
            (Sql("a]b", false, false, false, "Ap]p", "Fran]çais"), "", "CREATE LOGIN [a]]b] WITH PASSWORD=N'', DEFAULT_DATABASE=[Ap]]p], DEFAULT_LANGUAGE=[Fran]]çais], CHECK_EXPIRATION=OFF, CHECK_POLICY=OFF")
        };
        var wrong = cases.Where(item => LoginSql.CreateStatement(item.Login, item.Password) != item.Expected).Select(item => LoginSql.CreateStatement(item.Login, item.Password)).ToList();
        check(wrong.Count == 0, "CREATE LOGIN reads as SMO writes it: FROM WINDOWS, or PASSWORD then MUST_CHANGE, DEFAULT_DATABASE, DEFAULT_LANGUAGE and the policy pair, names bracketed: " + string.Join(" | ", wrong));
        static string Plan(LoginStatusDto status, params string[] roles) => string.Join(",", LoginSql.After(Sql("L"), roles, status).Select(statement => statement.Template + ":" + string.Join("/", statement.Names)));
        check(Plan(new("grant", true)) == "" && Plan(new("deny", false), "sysadmin", "Bulkadmin", "bulkadmin", "dbcreator")
                == "DenyConnect:L,DisableLogin:L,AddServerRoleMember:Bulkadmin/L,AddServerRoleMember:bulkadmin/L,AddServerRoleMember:dbcreator/L,AddServerRoleMember:sysadmin/L"
            && Plan(new("grant", false), "r") == "DisableLogin:L,AddServerRoleMember:r/L" && LoginSql.After(Sql("L"), ["r"], new("deny", true)).All(statement => statement.Database == "master"),
            "after CREATE LOGIN come DENY CONNECT SQL, then DISABLE, then each server role by name, all in master, only for what the dialog changed");
        check(ActionSql.Statement(ActionSql.Checked(new(ActionTemplate.AddServerRoleMember, "master", ["sys]admin", "a'b"]))) == "ALTER SERVER ROLE [sys]]admin] ADD MEMBER [a'b]"
            && ActionSql.LintExecutable(ActionSql.Executable(ActionTemplate.AddServerRoleMember), ActionTemplate.AddServerRoleMember).Count == 0
            && ActionSql.LintExecutable(ActionSql.Executable(ActionTemplate.AddServerRoleMember).Replace("QUOTENAME(@p2)", "@p2", StringComparison.Ordinal), ActionTemplate.AddServerRoleMember).Count > 0
            && ActionService.StepTitle(ActionTemplate.AddServerRoleMember) == "Add to a server role" && ActionService.CreateLoginStep == "Create the login",
            "ALTER SERVER ROLE … ADD MEMBER is a linted template whose two names go through QUOTENAME, with constant step titles");
    }

    private static void Script(Action<bool, string> check)
    {
        const string header = "/* header */";
        var sql = LoginSql.ScriptText(Sql("app", language: "us_english"), ["sysadmin", "dbcreator"], new("deny", false), [], new HashSet<string>(), header);
        var expected = "USE [master]" + NL + "GO" + NL + header + NL + "SET XACT_ABORT ON;" + NL + "BEGIN TRANSACTION;" + NL
            + "CREATE LOGIN [app] WITH PASSWORD=<password> MUST_CHANGE, DEFAULT_DATABASE=[master], DEFAULT_LANGUAGE=[us_english], CHECK_EXPIRATION=ON, CHECK_POLICY=ON;" + NL
            + "DENY CONNECT SQL TO [app];" + NL + "ALTER LOGIN [app] DISABLE;" + NL + "ALTER SERVER ROLE [dbcreator] ADD MEMBER [app];" + NL
            + "ALTER SERVER ROLE [sysadmin] ADD MEMBER [app];" + NL + "COMMIT TRANSACTION;" + NL + "GO" + NL;
        check(sql == expected, "a SQL Server login's script is one XACT_ABORT transaction batch under the header, with PASSWORD=<password> unquoted (critic A14):" + NL + sql);
        var windows = LoginSql.ScriptText(Windows("D\\u"), ["sysadmin"], new("grant", true), [], new HashSet<string>(), header);
        check(windows == "USE [master]" + NL + "GO" + NL + "CREATE LOGIN [D\\u] FROM WINDOWS WITH DEFAULT_DATABASE=[master]" + NL + "GO" + NL
                + "ALTER SERVER ROLE [sysadmin] ADD MEMBER [D\\u]" + NL + "GO" + NL,
            "a Windows login's script is SSMS's, one statement per batch, with no header and no transaction: " + windows);
        var batches = Varia.Backend.SqlScript.Parse(sql);
        check(batches.Count == 2 && batches[1].Sql.Contains("<password>", StringComparison.Ordinal) && ActionsCatalog.Current.Logins.ScriptHeader.StartsWith("/*", StringComparison.Ordinal)
            && ActionsCatalog.Current.Logins.ScriptHeader.EndsWith("*/", StringComparison.Ordinal) && ActionsCatalog.Current.Logins.ScriptHeader.Contains("<password>", StringComparison.Ordinal)
            && !ActionsCatalog.Current.Logins.ScriptHeader.Contains('\n', StringComparison.Ordinal),
            "the script parses as USE and one batch holding every statement, and the catalogue's header is one comment line naming the placeholder");
    }

    private static void Scrub(Action<bool, string> check)
    {
        const string secret = "Pa'ss-" + "Z9q";
        var scrubbed = LoginSql.Scrub("bad N'Pa''ss-Z9q' and Pa'ss-Z9q end", new(secret));
        check(scrubbed == "bad N'<password>' and <password> end" && LoginSql.Scrub("Pa'ss-Z9q", null) == "Pa'ss-Z9q" && LoginSql.Scrub("x", new("")) == "x"
            && LoginSql.Scrub("old 'Ol-Z9q' and \"Ol-Z9q\"", new(null, "Ol-Z9q")) == "old '<password>' and \"<password>\"" && LoginSql.Scrub("old Long-Ol-Z9q", new(null, "Long-Ol-Z9q")) == "old <password>",
            "the scrubber replaces a password, its doubled-quote form and an old password, and leaves text alone without one: " + scrubbed);
        // A short password is replaced only where it is quoted, so SQL Server's own words stay readable and do not show where its letters occur.
        const string role = "Cannot alter the server role 'VariaNoSuchRole', because it does not exist or you do not have permission.";
        var shortOne = LoginSql.Scrub(role + " near 'e'.", new("e"));
        var word = LoginSql.Scrub(role + " near N'server'.", new("server"));
        check(shortOne == role + " near '<password>'." && word == role + " near N'<password>'."
            && LoginSql.Scrub(role, new("in")) == role && LoginSql.BareSecretLength == 8,
            "a one-letter or dictionary-word password is replaced only where it stands quoted, never inside SQL Server's own words: " + shortOne + " | " + word);
        // The runner hands the scrubber SQL Server's text only: a password SQL Server quotes is replaced before it becomes the reply.
        var echoed = ConnectionFailureChecks.Sql(15118, 1, 16, "server", "Password validation failed for 'Long-Pw-Z9q'.");
        var failed = ActionErrors.FromSql(ActionsCatalog.Current, echoed, null, ddl: true, inUseAdvice: null, serverText: text => LoginSql.Scrub(text, new("Long-Pw-Z9q")));
        check(failed.Message == "Password validation failed for '<password>'." && ActionErrors.FromSql(ActionsCatalog.Current, echoed, null, ddl: true, inUseAdvice: null).Message.Contains("Long-Pw-Z9q", StringComparison.Ordinal),
            "a failure's SQL Server text goes through New Login's scrubber before it becomes the reply: " + failed.Message);
        // SQL Server on Linux applies its own policy, whose refusals (33062 to 33064) carry no password: CI's 'zq' answered 33062 there.
        const string linuxShort = "Password validation failed. The password does not meet SQL Server password policy requirements because it is too short. The password must be at least 8 characters.";
        var linux = ActionErrors.FromSql(ActionsCatalog.Current, ConnectionFailureChecks.Sql(33062, 2, 16, "server", linuxShort), null, ddl: true, inUseAdvice: null, serverText: text => LoginSql.Scrub(text, new("zq")));
        check(linux is { Code: "PASSWORD_POLICY", Retryable: true } && linux.Message == linuxShort,
            "SQL Server on Linux's password policy refusal (33062) answers PASSWORD_POLICY, retryable, with SQL Server's text: " + linux.Code + " " + linux.Message);
    }

    /// <summary>The reply after CREATE LOGIN completed and something after it did not: the login's real state comes first.</summary>
    private static void Partial(Action<bool, string> check)
    {
        static ActionStepDto Step(string status, ActionTemplate? template = null, string? detail = null) => new(status, template is { } value ? ActionService.StepTitle(value) : ActionService.CreateLoginStep, Detail: detail);
        var failure = new ActionError("PERMISSION_DENIED", "Cannot alter the server role 'r255'. Completed before the failure: " + string.Join(", ", Enumerable.Repeat("Add to a server role", 255)) + ".", false);
        var roles = Enumerable.Range(0, 255).Select(index => Step("done", ActionTemplate.AddServerRoleMember, "r" + index)).Append(Step("failed", ActionTemplate.AddServerRoleMember, "r255"));
        var many = ActionService.PartlyCreated(failure, new("grant", true), [Step("done"), .. roles]);
        check(many.Message.StartsWith(ActionService.LoginCreatedMessage + " " + ActionService.LoginRolesMessage + " Cannot alter", StringComparison.Ordinal) && many.Message.Length <= ActionErrors.MaxMessage
            && many.Code == "PERMISSION_DENIED",
            "a server role's failure after 255 completed roles still starts with the login's state, and stays within the message limit");
        var stopped = new ActionError("CANCELLED", "The action was stopped at \"Deny permission to connect\".", true);
        var open = ActionService.PartlyCreated(stopped, new("deny", false), [Step("done"), Step("cancelled", ActionTemplate.DenyConnect), Step("skipped", ActionTemplate.DisableLogin), Step("skipped", ActionTemplate.AddServerRoleMember, "r")]);
        var denied = ActionService.PartlyCreated(stopped, new("deny", false), [Step("done"), Step("done", ActionTemplate.DenyConnect), Step("cancelled", ActionTemplate.DisableLogin)]);
        var plain = ActionService.PartlyCreated(stopped, new("grant", true), [Step("done"), Step("cancelled", ActionTemplate.AddServerRoleMember, "r")]);
        check(open.Message == ActionService.LoginCreatedMessage + " " + ActionService.LoginCanConnectMessage + " " + ActionService.LoginEnabledMessage + " " + ActionService.LoginRolesMessage + " " + stopped.Message
            && denied.Message == ActionService.LoginCreatedMessage + " " + ActionService.LoginEnabledMessage + " " + stopped.Message
            && plain.Message == ActionService.LoginCreatedMessage + " " + ActionService.LoginRolesMessage + " " + stopped.Message,
            "a failure or Stop after CREATE LOGIN says the login can connect or is enabled when Deny or Disabled did not apply, and when a server role is missing: " + open.Message);
        var (steps, raced) = ActionService.StoppedAsCreated([Step("cancelled"), Step("skipped", ActionTemplate.DenyConnect)], new("CANCELLED", "The action was stopped at \"Create the login\".", true));
        check(steps is [{ Status: "done", Title: "Create the login" }, { Status: "skipped" }] && raced.Code == "CANCELLED"
            && ActionService.PartlyCreated(raced, new("deny", true), steps).Message.StartsWith(ActionService.LoginCreatedMessage + " " + ActionService.LoginCanConnectMessage + " The action was stopped as", StringComparison.Ordinal),
            "a Stop that raced CREATE LOGIN's completion, once the login is found, reports that step done and the login's state: " + raced.Message);
    }

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new Host(3));
        const string secret = "Throwaway-" + "Q7w";
        string Refused(ActionArgs args, bool script = false)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Message.Contains(secret, StringComparison.Ordinal) ? "echoed" : error.Code; }
        }
        var good = Create(Sql("app"), secret);
        var invalid = new (string Name, ActionArgs Args, bool Script)[]
        {
            ("a login target", good with { Target = new("login", Name: "app") }, false),
            ("a database target", good with { Target = new("database", Name: "master") }, false),
            ("a new name", good with { NewName = "x" }, false),
            ("no login", good with { Login = null }, false),
            ("no roles", good with { ServerRoles = null }, false),
            ("no status", good with { Status = null }, false),
            ("an unknown connect", good with { Status = new("revoke", true) }, false),
            ("an unknown auth", good with { Login = good.Login! with { Auth = "entra" } }, false),
            ("an empty name", Create(Sql(""), secret), false),
            ("a 129-unit name", Create(Sql(new string('x', 129)), secret), false),
            ("U+0000 in a name", Create(Sql("a\0b"), secret), false),
            ("a backslash in a SQL login", Create(Sql("D\\x"), secret), false),
            ("a Windows login without a domain", Create(Windows("ann"), null), false),
            ("a Windows login with two backslashes", Create(Windows("D\\a\\b"), null), false),
            ("a Windows login ending in a backslash", Create(Windows("D\\"), null), false),
            ("password options on a Windows login", Create(Windows("D\\a") with { CheckPolicy = true }, null), false),
            ("a SQL login without its options", Create(Sql("app") with { MustChange = null }, secret), false),
            ("expiration without the policy", Create(Sql("app", policy: false, expiration: true, mustChange: false), secret), false),
            ("must change without expiration", Create(Sql("app", expiration: false, mustChange: true), secret), false),
            ("an empty default database", Create(Sql("app", database: ""), secret), false),
            ("public", Create(Sql("app"), secret, ["public"]), false),
            ("a duplicate role", Create(Sql("app"), secret, ["sysadmin", "sysadmin"]), false),
            ("no password", Create(Sql("app"), null) with { Secrets = null }, false),
            ("a null password", Create(Sql("app"), null), false),
            ("an old password", good with { Secrets = new(secret, secret) }, false),
            ("a Windows password", Create(Windows("D\\a"), null) with { Secrets = new(secret) }, false),
            ("a blank password without the policy", Create(Sql("app", false, false, false), ""), false),
            ("a password on Script", good, true),
            // Members other actions take (Attach's databases, Restore's options) are refused here too.
            ("Attach's databases", good with { Databases = [] }, false),
            ("Restore's options", good with { Restore = new RestoreOptionsDto([], [], false, false, false, "recovery", false) }, false),
            ("login members on a rename", new ActionArgs("rename", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new("table", "AppData", "dbo", "T"), "U", Login: Sql("app")), false)
        };
        var accepted = invalid.Where(item => Refused(item.Args, item.Script) != "INVALID_PARAMS").Select(item => item.Name + " (" + Refused(item.Args, item.Script) + ")").ToList();
        check(accepted.Count == 0, "createLogin's validation refuses what zod refuses, never echoing the password: " + string.Join(", ", accepted));
        var valid = new (string Name, ActionArgs Args, bool Script)[]
        {
            ("a SQL Server login", good, false),
            ("a hostile SQL name", Create(Sql("a]b'; DROP LOGIN sa; --", database: "Ap]p", language: "Fran]çais"), secret, ["sysadmin", "Sysadmin"], new("deny", false)), false),
            ("a blank password under the policy", Create(Sql("app"), ""), false),
            ("a Windows login", Create(Windows("CONTOSO\\ann"), null, ["dbcreator"]), false),
            ("a Script without secrets", good with { Secrets = null }, true),
            ("a Windows Script", Create(Windows("CONTOSO\\ann"), null), true)
        };
        var refused = valid.Where(item => Refused(item.Args, item.Script) != "accepted").Select(item => item.Name + " (" + Refused(item.Args, item.Script) + ")").ToList();
        check(refused.Count == 0, "createLogin accepts hostile names verbatim, a blank password under the policy, Windows logins and Scripts without secrets: " + string.Join(", ", refused));
        string DescribeRefused(ObjectRefDto target)
        {
            try { service.Validate(new ActionDescribeArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "newLogin", target)); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(DescribeRefused(Server) == "accepted" && DescribeRefused(new("login", Name: "sa")) == "INVALID_PARAMS" && DescribeRefused(new("server", Name: "x")) == "INVALID_PARAMS",
            "New Login's describe takes the server and nothing else");
    }

    private static async Task ServiceAsync(Action<bool, string> check)
    {
        const string secret = "Throwaway-" + "M3k";
        var host = new Host(3);
        using var service = new ActionService(host);
        var args = Create(Sql("app"), null, ["sysadmin"], new("deny", true)) with { Secrets = null };
        var script = await service.ScriptAsync(args, CancellationToken.None);
        check(script.Error is null && script.Database == "master" && script.Text == LoginSql.ScriptText(args.Login!, args.ServerRoles!, args.Status!, [], new HashSet<string>(), ActionsCatalog.Current.Logins.ScriptHeader)
            && host.Connections == 0, "Script Action builds New Login's text from the request alone, opening no connection, as SSMS's Script runs nothing");
        var execute = await service.ExecuteAsync(Create(Sql("app"), secret), CancellationToken.None);
        check(execute.Error?.Code == "CONNECTION_LOST" && execute.Steps.Count == 0 && !(execute.Error.Message ?? "").Contains(secret, StringComparison.Ordinal) && service.RunningCount == 0,
            "a New Login whose connection fails answers CONNECTION_LOST with no step, and its message holds no password");
        var cloud = new Host(5);
        using var refusing = new ActionService(cloud);
        var refusedScript = await refusing.ScriptAsync(args, CancellationToken.None);
        var refusedRun = await refusing.ExecuteAsync(Create(Sql("app"), secret), CancellationToken.None);
        var refusedDescribe = await refusing.DescribeAsync(new(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "newLogin", Server), CancellationToken.None);
        check(refusedScript.Error?.Code == "NOT_SUPPORTED" && refusedRun.Error?.Code == "NOT_SUPPORTED" && refusedDescribe.Error?.Code == "NOT_SUPPORTED" && cloud.Connections == 0
            && ActionsCatalog.Current.Serves("createLogin", "box") && !ActionsCatalog.Current.Serves("createLogin", "cloud") && !ActionsCatalog.Current.Serves("createLogin", "managedInstance"),
            "New Login runs on SQL Server only for now: Azure SQL Database answers NOT_SUPPORTED to its describe, Script and OK before any connection opens");
    }

    private sealed class Host(int edition) : IActionHost
    {
        public int Connections;
        public ServerProfile Profile(string connectionId) => Box2022 with { EngineEdition = edition };
        public SqlConnection Connection(string connectionId)
        {
            Interlocked.Increment(ref Connections);
            return new SqlConnection("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false");
        }
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => connection.OpenAsync(token);
        public bool ClearPoolsFor(string connectionId, string database) => false;
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
        public bool FreeDatabase(string connectionId, string database) => false;
        public IReadOnlySet<int> PoolSessions(string connectionId) => new HashSet<int>();
    }
}
