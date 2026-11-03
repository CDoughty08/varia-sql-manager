using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Designer;
using Varia.Backend.Explorer;
using Varia.Backend.Live;
using Varia.Backend.Scripting;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of wave 5's backend seams (PR W5-0b): engine gating per action (critic A1), secrets only on an execute
/// that takes them (A3), runner v2's steps, compensation and bounds (A4), the shared templates' text and lint (A21), the lint's
/// refusal of LOGINPROPERTY, password hashes and a star over sys.sql_logins (A15), the login rules as logins.ts declares them (D4 §4),
/// secrets bounded and never printed (A3), Script Action without compensation, and where SqlService.FreeDatabase moves each
/// connection to the server (A5).</summary>
internal static class SeamChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
    };
    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);
    private static readonly string NL = Environment.NewLine;
    private static readonly ObjectRefDto Table = new("table", "AppData", "dbo", "Orders");

    public static async Task RunAsync(Action<bool, string> check)
    {
        await EnginesAsync(check);
        Secrets(check);
        SharedTemplates(check);
        SecretLint(check);
        Logins(check);
        FreeDatabase(check);
        await RunnerAsync(check);
    }

    private sealed class Host(int edition) : IActionHost
    {
        public int Connections;
        public List<string> Freed { get; } = [];
        public ServerProfile Profile(string connectionId) => Box2022 with { EngineEdition = edition };
        public SqlConnection Connection(string connectionId)
        {
            Interlocked.Increment(ref Connections);
            return new SqlConnection("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false");
        }
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => connection.OpenAsync(token);
        public bool ClearPoolsFor(string connectionId, string database) => false;
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
        public bool FreeDatabase(string connectionId, string database) { Freed.Add(database); return false; }
        public IReadOnlySet<int> PoolSessions(string connectionId) => new HashSet<int>();
    }

    private static ActionArgs Delete(ObjectRefDto target) => new("delete", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, null, false, false);
    private static ActionArgs Rename(ObjectRefDto target, string name) => new("rename", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target, name);

    /// <summary>The embedded catalogue with one action's engines replaced, as a later PR's catalogue would declare them.</summary>
    private static ActionsCatalog WithEngines(string action, params string[] engines)
    {
        using var stream = typeof(ActionsCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Actions.actions-catalog.json")!;
        var json = JsonNode.Parse(stream)!;
        foreach (var row in json["actions"]!.AsArray())
            if (row!["action"]!.GetValue<string>() == action) row["engines"] = new JsonArray([.. engines.Select(engine => (JsonNode)JsonValue.Create(engine)!)]);
        return ActionsCatalog.Parse(new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(json)));
    }

    private static async Task EnginesAsync(Action<bool, string> check)
    {
        var catalog = ActionsCatalog.Current;
        check(catalog.Serves("selectTop", "cloud") && catalog.Serves("selectTop", "managedInstance") && catalog.Serves("selectTop", "box")
            && new[] { "rename", "delete", "properties" }.All(action => catalog.Serves(action, "box") && catalog.Serves(action, "managedInstance") && !catalog.Serves(action, "cloud"))
            && !catalog.Serves("delete", "onPrem")
            && DesignerCatalog.Current.Engines.SequenceEqual(["box", "managedInstance"]),
            "each action declares its engines: Select Top everywhere, Rename, Delete, Properties and the designer's createTable on SQL Server and Managed Instance");
        check(catalog.Actions.All(action => catalog.CleanupBudget(action) == TimeSpan.FromMilliseconds(action == "restore" ? 30_000 : catalog.Limit("cleanupMs"))) && catalog.Limit("cleanupMs") == 10_000,
            "every action's compensation and cleanup run under the catalogue's 10-second budget unless it sets its own (Restore Database's 30 s, to drop a partly restored database)");

        // A later action that Managed Instance cannot run (Detach, Restore) is refused before any connection opens; the message names the engine.
        var mi = new Host(8);
        using (var service = new ActionService(mi, catalog: WithEngines("delete", "box")))
        {
            var execute = await service.ExecuteAsync(Delete(Table), CancellationToken.None);
            var script = await service.ScriptAsync(Delete(Table), CancellationToken.None);
            var rename = await service.ExecuteAsync(Rename(Table, "Orders2"), CancellationToken.None);
            check(execute.Error is { Code: "NOT_SUPPORTED", Message: ActionService.ManagedInstanceMessage } && script.Error?.Code == "NOT_SUPPORTED" && execute.Steps.Count == 0
                && rename.Error?.Code == "CONNECTION_LOST" && mi.Connections == 1 && service.RunningCount == 0,
                "an action whose engines leave out Managed Instance answers NOT_SUPPORTED there before any connection opens; the others still connect");
        }
        var box = new Host(3);
        using (var service = new ActionService(box, catalog: WithEngines("delete", "box")))
        {
            var execute = await service.ExecuteAsync(Delete(Table), CancellationToken.None);
            check(execute.Error?.Code == "CONNECTION_LOST" && box.Connections == 1, "the same action still runs on a box server");
        }
        var real = new Host(8);
        using (var service = new ActionService(real))
        {
            var execute = await service.ExecuteAsync(Delete(Table), CancellationToken.None);
            check(execute.Error?.Code == "CONNECTION_LOST" && real.Connections == 1, "Delete runs on Managed Instance: the gate lets it through to its connection");
        }
        check(ActionService.EngineMessage("cloud") == ActionService.CloudMessage && ActionService.EngineMessage("managedInstance") == ActionService.ManagedInstanceMessage,
            "the refusal names Azure SQL Database or Managed Instance");
    }

    private static void Secrets(Action<bool, string> check)
    {
        using var service = new ActionService(new Host(3));
        const string secret = "Throwaway-" + "Z9q";
        string Refused(ActionArgs args, bool script)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Message.Contains(secret, StringComparison.Ordinal) ? "echoed" : error.Code; }
        }
        var withSecret = Rename(Table, "x") with { Secrets = new(secret) };
        check(Refused(withSecret, script: false) == "INVALID_PARAMS" && Refused(withSecret, script: true) == "INVALID_PARAMS"
            && Refused(Delete(Table) with { Secrets = new(null, secret) }, script: false) == "INVALID_PARAMS" && Refused(Rename(Table, "x"), script: true) == "accepted",
            "secrets are refused on every action that takes none and on every script, without echoing them");
        // An action that takes secrets (createLogin, D2a) gets their bounds before its own case: past them, createLogin's own validation answers, here "target." (a login is not its target).
        string Bounded(LoginSecretsDto secrets)
        {
            try { service.Validate(new ActionArgs("createLogin", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new("login", Name: "x"), Secrets: secrets)); return "accepted"; }
            catch (RequestException error) { return (secrets.Password is { Length: > 0 } password && error.Message.Contains(password, StringComparison.Ordinal)) ? "echoed" : error.Message; }
        }
        var longest = new string('p', (int)ActionsCatalog.Current.Logins.Limit("password"));
        check(Bounded(new(longest + "q")).EndsWith("secrets.password.", StringComparison.Ordinal) && Bounded(new("Pa\0ss")).EndsWith("secrets.password.", StringComparison.Ordinal)
            && Bounded(new("Pa\uD800ss")).EndsWith("secrets.password.", StringComparison.Ordinal) && Bounded(new("Pass\uDC00")).EndsWith("secrets.password.", StringComparison.Ordinal)
            && Bounded(new("Zq9x", longest + "q")).EndsWith("secrets.oldPassword.", StringComparison.Ordinal)
            && Bounded(new(longest, longest)).EndsWith("target.", StringComparison.Ordinal) && Bounded(new("Pa😀ss")).EndsWith("target.", StringComparison.Ordinal),
            "every action that takes secrets gets a password and old password of at most 128 UTF-16 units, without U+0000 or an unpaired surrogate, refused without echoing it");
        var printed = (Rename(Table, "x") with { Secrets = new("Pa'ss-" + "Z9q", "Ol'd-" + "Z9q") }).ToString();
        check(!printed.Contains("Z9q", StringComparison.Ordinal) && printed.Contains("Password = <redacted>, OldPassword = <redacted>", StringComparison.Ordinal)
            && new LoginSecretsDto().ToString() == "LoginSecretsDto { Password = null, OldPassword = null }",
            "an ActionArgs never prints its secrets, which its record would otherwise write in clear: " + printed.Replace("Z9q", "***", StringComparison.Ordinal));
        var parsed = JsonSerializer.Deserialize<ActionArgs>("{\"action\":\"rename\",\"connectionId\":\"" + Guid.NewGuid() + "\",\"requestId\":\"" + Guid.NewGuid()
            + "\",\"target\":{\"kind\":\"table\",\"database\":\"AppData\",\"schema\":\"dbo\",\"name\":\"Orders\"},\"newName\":\"x\",\"secrets\":{\"password\":\"" + secret + "\"}}", Json);
        string ScriptRefused()
        {
            try { _ = service.ScriptAsync(parsed!, CancellationToken.None); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(parsed?.Secrets?.Password == secret && ScriptRefused() == "INVALID_PARAMS" && SqlService.SensitiveMethods.Contains("actions.execute")
            && !SqlService.SensitiveMethods.Contains("actions.script") && new SqlService().Sensitive("actions.execute"),
            "actions.execute is sensitive as a whole, so a secret's frame is zeroed; actions.script refuses secrets before it registers");
    }

    private static void SharedTemplates(Action<bool, string> check)
    {
        static string Text(ActionTemplate template, string name) => ActionSql.Statement(new(template, "master", [name]));
        check(Text(ActionTemplate.SetMultiUser, "A]b") == "ALTER DATABASE [A]]b] SET  MULTI_USER" && Text(ActionTemplate.SetRestrictedUser, "A") == "ALTER DATABASE [A] SET  RESTRICTED_USER"
            && Text(ActionTemplate.DisableLogin, "D\\u") == "ALTER LOGIN [D\\u] DISABLE" && Text(ActionTemplate.EnableLogin, "L") == "ALTER LOGIN [L] ENABLE"
            && Text(ActionTemplate.DenyConnect, "L") == "DENY CONNECT SQL TO [L]" && Text(ActionTemplate.GrantConnect, "L") == "GRANT CONNECT SQL TO [L]"
            && Text(ActionTemplate.DropUser, "u") == "DROP USER [u]"
            && ActionSql.Statement(ActionSql.Detach("O'Brien", updateStatistics: true)) == "EXEC master.dbo.sp_detach_db @dbname = N'O''Brien', @skipchecks = 'false'"
            && ActionSql.Statement(ActionSql.Detach("A", updateStatistics: false)) == "EXEC master.dbo.sp_detach_db @dbname = N'A', @skipchecks = 'true'"
            && ActionSql.ScriptText(ActionSql.Detach("A", true)) == "USE [master]" + NL + "GO" + NL + "EXEC master.dbo.sp_detach_db @dbname = N'A', @skipchecks = 'false'" + NL + "GO" + NL
            && ActionSql.ScriptText(new(ActionTemplate.DropUser, "AppData", ["u"])) == "USE [AppData]" + NL + "GO" + NL + "DROP USER [u]" + NL + "GO" + NL,
            "the shared templates script as SSMS writes them: SET  MULTI_USER and RESTRICTED_USER, sp_detach_db with @skipchecks, ALTER LOGIN, DENY and GRANT CONNECT SQL, DROP USER in its database");
        static bool Throws(Func<object> make)
        {
            try { make(); return false; }
            catch (InvalidOperationException) { return true; }
        }
        check(Throws(() => ActionSql.Checked(new(ActionTemplate.DetachDatabase, "master", ["A", "maybe"]))) && Throws(() => ActionSql.Checked(new(ActionTemplate.DetachDatabase, "master", ["A", "TRUE"])))
            && Throws(() => ActionSql.Statement(new(ActionTemplate.DetachDatabase, "master", ["A", "1; DROP DATABASE x"]))) && Throws(() => ActionSql.Checked(new(ActionTemplate.SetMultiUser, "master", ["A", "B"])))
            && Throws(() => ActionSql.Checked(new(ActionTemplate.DisableLogin, "master", []))) && ActionSql.Checked(ActionSql.Detach("A", false)).Names[1] == "true",
            "a plan reaches SQL only with its template's name count, and sp_detach_db's @skipchecks only as true or false");
        var mutations = new (string Name, ActionTemplate Template, string Text)[]
        {
            ("a bare login name", ActionTemplate.DisableLogin, ActionSql.Executable(ActionTemplate.DisableLogin).Replace("QUOTENAME(@p1)", "@p1", StringComparison.Ordinal)),
            ("a spliced login name", ActionTemplate.DenyConnect, ActionSql.Executable(ActionTemplate.DenyConnect).Replace("N'DENY CONNECT SQL TO ' + QUOTENAME(@p1)", "N'DENY CONNECT SQL TO [x]'", StringComparison.Ordinal)),
            ("a literal database to detach", ActionTemplate.DetachDatabase, ActionSql.Executable(ActionTemplate.DetachDatabase).Replace("@dbname = @p1", "@dbname = N'x'", StringComparison.Ordinal)),
            ("a user outside QUOTENAME", ActionTemplate.DropUser, ActionSql.Executable(ActionTemplate.DropUser).Replace("QUOTENAME(@p1)", "@p1", StringComparison.Ordinal)),
            ("a database outside QUOTENAME", ActionTemplate.SetMultiUser, ActionSql.Executable(ActionTemplate.SetMultiUser).Replace("QUOTENAME(@db) + N'.sys.sp_executesql'", "@db + N'.sys.sp_executesql'", StringComparison.Ordinal))
        };
        var missed = mutations.Where(mutation => mutation.Text == ActionSql.Executable(mutation.Template) || ActionSql.LintExecutable(mutation.Text, mutation.Template).Count == 0).Select(mutation => mutation.Name).ToList();
        check(missed.Count == 0, "the lint catches names reaching the shared templates' text: " + string.Join(", ", missed));
        var titles = Enum.GetValues<ActionTemplate>().Select(ActionService.StepTitle).ToList();
        check(titles.All(title => title.Length is > 0 and <= ActionSteps.MaxTitle) && titles.Count(title => title == "Drop the object") == 4
            && ActionSteps.MaxTitle == ActionsCatalog.Current.Logins.Limit("stepTitle") && ActionSteps.MaxDetail == ActionsCatalog.Current.Logins.Limit("stepDetail"),
            "every step title fits the 64 characters zod allows, and the new templates have their own titles");
        List<PlannedStatement> compensated =
        [
            new(ActionTemplate.SetSingleUser, "master", ["A"]), new(ActionTemplate.RenameDatabase, "master", ["A", "B"]),
            new(ActionTemplate.SetMultiUser, "master", ["A"], StepKind.Compensation, Undoes: 0)
        ];
        var scripted = ActionService.ScriptText(compensated);
        check(scripted == ActionSql.ScriptText(ActionSql.Checked(compensated[0])) + ActionSql.ScriptText(ActionSql.Checked(compensated[1])) && !scripted.Contains("MULTI_USER", StringComparison.Ordinal),
            "Script Action shows a plan's main statements only, as a success runs them, never its compensation: " + scripted);
    }

    private static void SecretLint(Action<bool, string> check)
    {
        static bool Names(List<string> problems, string token) => problems.Any(problem => problem.Contains(token, StringComparison.OrdinalIgnoreCase));
        const string good = "SELECT TOP (@take) l.name FROM sys.sql_logins AS l ORDER BY l.name;";
        var hash = good.Replace("SELECT TOP (@take) l.name", "SELECT TOP (@take) l.password_hash", StringComparison.Ordinal);
        var property = good.Replace("SELECT TOP (@take) l.name", "SELECT TOP (@take) LOGINPROPERTY(l.name, N'PasswordHash')", StringComparison.Ordinal);
        var lints = new (string Name, Func<string, List<string>> Lint)[]
        {
            ("object actions' catalog lint", text => ActionSql.LintCatalog(text, ExplorerCatalog.MaxBand, database: false)),
            ("Object Explorer's lint", text => CatalogSql.Lint(text, new SqlRender(ExplorerCatalog.MaxBand), list: true, mayCheckAccess: false)),
            ("the scripting preflight's lint", text => ScriptPreflight.Lint(text, ExplorerCatalog.MaxBand, serverScope: true)),
            ("the live probes' lint", text => LiveSql.Lint(LiveSql.UncommittedPrologue + text)),
            ("the SSIS lint", text => SsisSql.Lint(text, list: true))
        };
        var missed = lints.Where(lint => Names(lint.Lint(good), "password") || Names(lint.Lint(good), "LOGINPROPERTY") || !Names(lint.Lint(hash), "password_hash") || !Names(lint.Lint(property), "LOGINPROPERTY"))
            .Select(lint => lint.Name).ToList();
        check(missed.Count == 0, "every catalog lint refuses LOGINPROPERTY and sys.sql_logins.password_hash, which no Varia statement may read: " + string.Join(", ", missed));
        // The hash read without its name: a star over sys.sql_logins, and LOGINPROPERTY with a space before its parenthesis.
        var counted = "SELECT TOP (@take) l.name, (SELECT COUNT(*) FROM sys.sql_logins AS c) AS logins FROM sys.sql_logins AS l ORDER BY l.name;";
        var hidden = new[]
        {
            ("l.*", good.Replace("SELECT TOP (@take) l.name", "SELECT TOP (@take) l.*", StringComparison.Ordinal), "sql_logins through"),
            ("SELECT *", good.Replace("SELECT TOP (@take) l.name", "SELECT TOP (@take) *", StringComparison.Ordinal), "sql_logins through"),
            ("LOGINPROPERTY (", good.Replace("SELECT TOP (@take) l.name", "SELECT TOP (@take) LOGINPROPERTY (l.name, N'IsLocked')", StringComparison.Ordinal), "LOGINPROPERTY")
        };
        var unseen = lints.SelectMany(lint => hidden.Where(mutation => !Names(lint.Lint(mutation.Item2), mutation.Item3)).Select(mutation => lint.Name + " (" + mutation.Item1 + ")"))
            .Concat(lints.Where(lint => Names(lint.Lint(counted), "sql_logins through")).Select(lint => lint.Name + " (COUNT(*))")).ToList();
        check(unseen.Count == 0, "every catalog lint refuses a star over sys.sql_logins (COUNT(*) aside) and LOGINPROPERTY however it is spaced: " + string.Join(", ", unseen));
        var executable = ActionSql.Executable(ActionTemplate.DropUser);
        var declared = executable.Replace("DECLARE @stmt", "DECLARE @password_hash int;\nDECLARE @stmt", StringComparison.Ordinal);
        var alter = DatabaseAlter.Executable(ActionsCatalog.Current, new(AlterTemplate.Owner, "db", "owner", Name: "x"));
        var designer = DesignerSql.Builder(DesignerCatalog.Current, DesignerPart.CreateTable);
        var rules = new DesignBuilderRules(DesignerSql.Messages, DesignerCatalog.Current.Types.Select(type => type.Name).ToHashSet(StringComparer.Ordinal));
        check(ActionSql.LintExecutable(executable, ActionTemplate.DropUser).Count == 0 && Names(ActionSql.LintExecutable(declared, ActionTemplate.DropUser), "password_hash")
            && Names(ActionSql.LintExecutable(alter + "\nDECLARE @PasswordHash int;", DatabaseAlter.Messages), "PasswordHash")
            && Names(ActionSql.LintExecutable(designer + "\nDECLARE @password_hash int;", rules), "password_hash"),
            "the executable lints (templates, Database Properties' builders and the designer's) refuse a password hash even as a variable name");
    }

    /// <summary>Critic A5's move, offline: SqlService.Register records a connection as ConnectAsync does, without a server, and the
    /// server-scope pool's database (Object Explorer's with no database) shows where each connection's pools open.</summary>
    private static void FreeDatabase(Action<bool, string> check)
    {
        static string Settings(string? database) => "Data Source=tcp:127.0.0.1,1;" + (database is null ? "" : "Initial Catalog=" + database + ";") + "Encrypt=false;Application Name=Varia";
        static ServerProfile On(string server, bool contained = false) => Box2022 with { ServerName = server, Contained = contained };
        static string ServerScope(SqlService service, string id)
        {
            using var connection = ((IExplorerHost)service).Connection(id, null);
            return new SqlConnectionStringBuilder(connection.ConnectionString).InitialCatalog;
        }
        using (var service = new SqlService())
        {
            var named = service.Register(Settings("Sales"), On("S1"), "Sales");
            var other = service.Register(Settings("Sales"), On("S2"), "Sales");
            var freed = service.FreeDatabase(named, "Sales");
            check(freed && service.ServerScopeDatabase(named) == "master" && ServerScope(service, named) == "master" && ServerScope(service, other) == "Sales"
                && !service.FreeDatabase(named, "Other") && ServerScope(service, named) == "master",
                "freeing the connection's own database moves its server-scope pools to master; another server's connection keeps its own");
        }
        using (var service = new SqlService())
        {
            // The Connect dialog's <default>: no Initial Catalog, so the pools open in the login's default database, read at connect.
            var home = service.Register(Settings(null), On("S1"), "Sales");
            var inSales = service.ClearPoolsFor(home, "Sales");
            var freed = service.FreeDatabase(home, "Sales");
            check(inSales && freed && ServerScope(service, home) == "master",
                "a connection made with Database <default> is in the login's default database: freeing it moves the server-scope pools to master and clears the pools there");
        }
        using (var service = new SqlService())
        {
            var acting = service.Register(Settings("master"), On("S1"), "master");
            var inside = service.Register(Settings(null), On("S1"), "Sales");
            var contained = service.Register(Settings("Sales"), On("S1", contained: true), "Sales");
            var probeless = service.Register(Settings("Sales"), ServerProfile.Fallback("16.00.4135"), "Sales");
            var freed = service.FreeDatabase(acting, "Sales");
            check(freed && ServerScope(service, inside) == "master" && service.ServerScopeDatabase(acting) is null && ServerScope(service, contained) == "Sales"
                && service.ServerScopeDatabase(contained) is null,
                "freeing a database moves every connection to the same server whose own database it is, but not a contained database user's, who cannot open master");
            service.FreeDatabase(probeless, "Sales");
            check(service.ServerScopeDatabase(probeless) is null && ServerScope(service, probeless) == "Sales",
                "a connection whose sign-in the profile probe could not check keeps its own database, as a contained user's does");
        }
        using (var service = new SqlService())
        {
            var acting = service.Register(Settings("master"), On("S1"), "master");
            var named = service.Register(Settings("Sales"), On("S1"), "Sales");
            var defaulted = service.Register(Settings(null), On("S1"), "Sales");
            var other = service.Register(Settings(null), On("S2"), "Sales");
            service.DatabaseChanged(acting, "Sales", "Sales2");
            var renamed = new[] { ServerScope(service, named), ServerScope(service, defaulted), ServerScope(service, other) };
            service.DatabaseChanged(acting, "Sales2", null);
            var dropped = new[] { ServerScope(service, named), ServerScope(service, defaulted), ServerScope(service, acting) };
            check(renamed.SequenceEqual(["Sales2", "Sales2", ""]) && dropped.SequenceEqual(["master", "master", "master"]),
                "a rename or drop moves every connection to the server that was in the database, named or the login's default, to the new name or master: "
                + string.Join(", ", renamed) + " | " + string.Join(", ", dropped));
        }
    }

    private static LoginFactsDto Facts(string subtype, bool own = false, bool canAlter = true, bool sysadmin = false, bool control = true) =>
        new(300, "S", subtype, false, "01", "2026-01-01T00:00:00.000", true, false, false, own, sysadmin, 0, 0, [], 0, canAlter, control, false);

    private static void Logins(Action<bool, string> check)
    {
        var rules = ActionsCatalog.Current.Logins;
        check(rules.SubtypeOf(1, "S", "renamed_sa") == "sa" && rules.SubtypeOf(1, "S ", "sa") == "sa" && rules.SubtypeOf(270, "C", "##MS_PolicySigningCertificate##") == "system"
            && rules.SubtypeOf(270, "S", "##MS_PolicyTsqlExecutionLogin##") == "system" && rules.SubtypeOf(300, "S", "##") == "sql" && rules.SubtypeOf(300, "S", "app") == "sql"
            && rules.SubtypeOf(300, "U", "D\\u") == "windowsUser" && rules.SubtypeOf(300, "G", "D\\g") == "windowsGroup" && rules.SubtypeOf(300, "C", "c") == "certificateMapped"
            && rules.SubtypeOf(300, "K", "k") == "asymmetricKeyMapped" && rules.SubtypeOf(300, "E", "e@x") == "externalUser" && rules.SubtypeOf(300, "X", "g") == "externalGroup"
            && rules.SubtypeOf(3, "R", "sysadmin") is null && rules.SubtypeOf(300, null, "x") is null,
            "a login's subtype is sa by principal_id, SQL Server's own by its ## name, else its type; server roles are not logins");
        var refusals = new (LoginFactsDto Facts, string Verb, string? Expected)[]
        {
            (Facts("sa"), "delete", "saDelete"), (Facts("sa"), "disable", null), (Facts("system"), "rename", "system"), (Facts("system"), "enable", "system"),
            (Facts("windowsGroup"), "disable", "windowsGroupDisable"), (Facts("windowsGroup"), "enable", "notOffered"), (Facts("windowsUser"), "unlock", "notOffered"),
            (Facts("externalUser"), "rename", "externalRename"), (Facts("externalGroup"), "delete", null), (Facts("sql"), "unlock", null),
            (Facts("sql", own: true), "disable", "own"), (Facts("sql", own: true), "rename", "own"), (Facts("sql", own: true), "delete", "own"), (Facts("sql", own: true), "enable", null),
            (Facts("sql", canAlter: false), "rename", "alterAnyLogin"), (Facts("sql", sysadmin: true, control: false), "disable", "controlServer"), (Facts("sql", sysadmin: true), "disable", null)
        };
        var wrong = refusals.Where(item => rules.Refusal(item.Facts, item.Verb) != item.Expected).Select(item => item.Facts.Subtype + " " + item.Verb + " " + rules.Refusal(item.Facts, item.Verb)).ToList();
        check(wrong.Count == 0 && rules.Message("windowsGroupDisable").StartsWith("A Windows group cannot be disabled.", StringComparison.Ordinal),
            "the protected-principal rules refuse as logins.ts declares: sa's delete, SQL Server's own logins, a group's disable, an Entra rename, the connection's own login, and the permissions: " + string.Join(", ", wrong));
        check(ExplorerCatalog.Current.Kind("login") is { } login && rules.Subtypes.All(login.Subtypes.Contains) && rules.Types.Order().SequenceEqual(["C", "E", "G", "K", "S", "U", "X"]),
            "Object Explorer's login kind lists every subtype the rules cover");
    }

    private static async Task RunnerAsync(Action<bool, string> check)
    {
        using var service = new ActionService(new Host(3));
        await using var connection = new SqlConnection("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false");
        var ran = new List<string>();
        RunStep Step(string title, Exception? fails = null, StepKind kind = StepKind.Main, int? undoes = null, Func<IReadOnlyList<string>, bool>? when = null) =>
            new(title, _ => { ran.Add(title); return fails is null ? Task.CompletedTask : Task.FromException(fails); }, kind, undoes, when);
        var taken = ConnectionFailureChecks.Sql(1801, 1, 16, "server", "Database 'B' already exists. Choose a different database name.");
        var plan = new[]
        {
            Step("Close existing connections"), Step("Rename", taken), Step("Delete backup and restore history"),
            Step("Restore multi-user access", kind: StepKind.Compensation, undoes: 0), Step("Undo the rename", kind: StepKind.Compensation, undoes: 1),
            Step("Remove what was made", kind: StepKind.Cleanup, when: statuses => statuses.Contains("cancelled"))
        };
        var outcome = await service.RunStepsAsync(connection, plan, null, CancellationToken.None, TimeSpan.FromSeconds(1));
        // The connection is closed here (so the failure maps to CONNECTION_LOST, and the live checks see NAME_IN_USE), and the due
        // compensation cannot run: it is listed as failed, and the message says so.
        check(outcome.Steps.Select(step => step.Status + ":" + step.Title + ":" + (step.Compensates == true)).SequenceEqual(
                ["done:Close existing connections:False", "failed:Rename:False", "skipped:Delete backup and restore history:False", "failed:Restore multi-user access:True"])
            && outcome.Failure is { } failure && failure.Message.Contains(" Completed before the failure: Close existing connections.", StringComparison.Ordinal)
            && failure.Message.EndsWith(" Then \"Restore multi-user access\" could not run.", StringComparison.Ordinal) && outcome.Steps[1].Message is { Length: > 0 }
            && outcome.Steps[3].Message == "The connection was lost, so this step could not run."
            && outcome.Done == 1 && ran.SequenceEqual(["Close existing connections", "Rename"]),
            "runner v2 skips the rest after a failure and runs only the compensations of completed steps and the cleanups their condition allows, listed as compensating: "
            + string.Join(", ", outcome.Steps.Select(step => step.Status + ":" + step.Title)) + " | " + outcome.Failure?.Code + " " + outcome.Failure?.Message);
        ran.Clear();
        // A main step that finds it must not go on (StepRefusedException) fails with its own error, as a SqlException does.
        var refusal = ActionErrors.Create(ActionsCatalog.Current, "RESTORE_SEQUENCE", "The log was backed up during the run.");
        var refused = await service.RunStepsAsync(connection, [Step("Restore"), Step("Back up", new StepRefusedException(refusal)), Step("Restore it")], null, CancellationToken.None, TimeSpan.FromSeconds(1));
        check(refused.Steps.Select(step => step.Status + ":" + step.Title + ":" + step.Message).SequenceEqual(["done:Restore:", "failed:Back up:The log was backed up during the run.", "skipped:Restore it:"])
            && refused.Failure is { Code: "RESTORE_SEQUENCE" } && refused.Failure.Message == "The log was backed up during the run. Completed before the failure: Restore." && refused.Done == 1
            && ran.SequenceEqual(["Restore", "Back up"]),
            "a step that refuses to go on fails with its own error, the rest skipped and the steps completed named: " + string.Join(", ", refused.Steps.Select(step => step.Status + ":" + step.Title)) + " | " + refused.Failure?.Message);
        ran.Clear();
        using var stopped = new CancellationTokenSource();
        stopped.Cancel();
        var cancelled = await service.RunStepsAsync(connection, plan, null, stopped.Token, TimeSpan.FromSeconds(1));
        check(cancelled.Steps.Select(step => step.Status + ":" + step.Title).SequenceEqual(["cancelled:Close existing connections", "skipped:Rename", "skipped:Delete backup and restore history", "failed:Remove what was made"])
            && cancelled.Failure is { Code: "CANCELLED" } && ran.Count == 0, "after Stop, no compensation is due for steps that never completed; a cleanup whose condition holds still runs under its own budget");
        static async Task<bool> Refuses(Func<Task> run)
        {
            try { await run(); return false; }
            catch (InvalidOperationException) { return true; }
        }
        check(await Refuses(() => service.RunStepsAsync(connection, [Step("A"), Step("Undo", kind: StepKind.Compensation, undoes: 1)], null, CancellationToken.None, TimeSpan.FromSeconds(1)))
            && await Refuses(() => service.RunStepsAsync(connection, [Step("A"), Step("Undo", kind: StepKind.Compensation)], null, CancellationToken.None, TimeSpan.FromSeconds(1)))
            && await Refuses(() => service.RunStepsAsync(connection, [Step("A"), Step("Clean", kind: StepKind.Cleanup)], null, CancellationToken.None, TimeSpan.FromSeconds(1), transaction: true)),
            "a compensation names a main step it undoes, and a transaction's plan has no compensation or cleanup (its rollback undoes it)");
        var bounded = ActionSteps.Bound(new("failed", new string('t', 100), new string('m', 5000), new string('d', 300), true, 150));
        check(bounded.Title.Length == ActionSteps.MaxTitle && bounded.Message!.Length == ActionErrors.MaxMessage && bounded.Detail!.Length == ActionSteps.MaxDetail && bounded.Progress == 100
            && ActionSteps.Bound(new("done", "t", Progress: -3)).Progress == 0 && ActionSteps.Bound(new("done", "t")) == new ActionStepDto("done", "t"),
            "every step is bounded as zod's actionStepSchema bounds it: title, message, detail and progress");
        check(JsonSerializer.Serialize(new ActionStepDto("done", "Rename"), Json) == "{\"status\":\"done\",\"title\":\"Rename\"}"
            && JsonSerializer.Serialize(new ActionStepDto("failed", "Undo", "m", Compensates: true), Json) == "{\"status\":\"failed\",\"title\":\"Undo\",\"message\":\"m\",\"compensates\":true}",
            "a step's reply carries its title, and a message only when it failed");
    }
}
