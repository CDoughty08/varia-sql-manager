using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of PR D2e: New Login's other kinds (Microsoft Entra, certificate, asymmetric key), Managed Instance's SQL Server
/// login without policy options, Map to Credential (ALTER LOGIN … ADD and DROP CREDENTIAL) in New Login and Login Properties, the engine
/// rules from actions-catalog.json, Check Names' describe, and the error numbers it adds. No server is reached: LoginKindsLiveChecks run
/// the SQL.</summary>
internal static class LoginKindsChecks
{
    private static readonly ActionsCatalog Catalog = ActionsCatalog.Current;
    private static readonly ObjectRefDto Server = new("server");
    private static string NL => LoginSql.NL;
    private static string Id() => Guid.NewGuid().ToString();

    internal static NewLoginDto Entra(string name, string database = "master", string? language = null) => new("entra", name, database, language);
    internal static NewLoginDto Certificate(string name, string certificate) => new("certificate", name, null, Certificate: certificate);
    internal static NewLoginDto Key(string name, string key) => new("asymmetricKey", name, null, AsymmetricKey: key);
    /// <summary>A SQL Server login as Managed Instance creates it: no policy options.</summary>
    internal static NewLoginDto ManagedSql(string name) => new("sql", name, "master");

    public static async Task RunAsync(Action<bool, string> check)
    {
        Statements(check);
        Credentials(check);
        Validation(check);
        Rules(check);
        Properties(check);
        Errors(check);
        await FailuresAsync(check);
        await EnginesAsync(check);
    }

    private static void Statements(Action<bool, string> check)
    {
        check(LoginSql.CreateStatement(Entra("a]b@example.com", "Ap]p", "Deutsch"), null) == "CREATE LOGIN [a]]b@example.com] FROM EXTERNAL PROVIDER WITH DEFAULT_DATABASE=[Ap]]p], DEFAULT_LANGUAGE=[Deutsch]"
            && LoginSql.CreateStatement(Certificate("c]l", "ce]rt"), null) == "CREATE LOGIN [c]]l] FROM CERTIFICATE [ce]]rt]"
            && LoginSql.CreateStatement(Key("k]l", "k]ey"), null) == "CREATE LOGIN [k]]l] FROM ASYMMETRIC KEY [k]]ey]"
            && LoginSql.CreateStatement(ManagedSql("m"), null) == "CREATE LOGIN [m] WITH PASSWORD=<password>, DEFAULT_DATABASE=[master]",
            "New Login writes SMO's text for a Microsoft Entra login (with its defaults), a certificate or asymmetric key login (no defaults), and Managed Instance's SQL Server login (no policy options)");
        check(LoginSql.SecondName(Certificate("c", "cert")) == "cert" && LoginSql.SecondName(Key("k", "key")) == "key" && LoginSql.SecondName(Entra("e")) == "master"
            && LoginSql.CreateExecutable(Certificate("c", "cert")).Contains("N' FROM CERTIFICATE ' + QUOTENAME(@p2)", StringComparison.Ordinal)
            && LoginSql.CreateExecutable(Entra("e")).Contains("N' FROM EXTERNAL PROVIDER WITH DEFAULT_DATABASE=' + QUOTENAME(@p2)", StringComparison.Ordinal)
            && !LoginSql.CreateExecutable(ManagedSql("m")).Contains("CHECK_POLICY", StringComparison.Ordinal) && LoginSql.CreateExecutable(ManagedSql("m")).Contains("@password", StringComparison.Ordinal)
            && !LoginSql.CreateExecutable(Certificate("c", "cert")).Contains("@password", StringComparison.Ordinal),
            "the builder binds @p2 to the certificate or key (else the default database), and writes no policy options for Managed Instance's SQL Server login");
        // The builder's lint must catch a certificate or key name spliced or left bare.
        var certificate = LoginSql.CreateExecutable(Certificate("c", "cert"));
        check(LoginSql.LintExecutable(certificate).Count == 0 && LoginSql.LintExecutable(certificate.Replace("QUOTENAME(@p2)", "@p2", StringComparison.Ordinal)).Count > 0
            && LoginSql.LintExecutable(certificate.Replace("N' FROM CERTIFICATE '", "N' FROM CERTIFICATE [x]'", StringComparison.Ordinal)).Count > 0
            && LoginSql.LintExecutable(LoginSql.CreateExecutable(Entra("e")).Replace("N' FROM EXTERNAL PROVIDER WITH DEFAULT_DATABASE='", "N' FROM EXTERNAL PROVIDER WITH OBJECT_ID='", StringComparison.Ordinal)).Count > 0,
            "the CREATE LOGIN lint refuses a certificate outside QUOTENAME, a name in a fragment, and a clause the builder never writes (OBJECT_ID)");
        // Script: a certificate, key or Entra login with statements after CREATE LOGIN is one XACT_ABORT batch without the placeholder
        // header, so a CREATE that fails where the certificate, key or Entra is missing runs nothing after it; alone, it is SSMS's GO form.
        static string Script(NewLoginDto login, LoginStatusDto status, List<UserMappingDto>? mappings = null) =>
            LoginSql.ScriptText(login, [], status, mappings ?? [], new HashSet<string>(), Catalog.Logins.ScriptHeader);
        var text = Script(Certificate("c", "cert") with { Credentials = ["vault"] }, new("deny", true));
        check(text == "USE [master]" + NL + "GO" + NL + "SET XACT_ABORT ON;" + NL + "BEGIN TRANSACTION;" + NL + "CREATE LOGIN [c] FROM CERTIFICATE [cert];" + NL + "DENY CONNECT SQL TO [c];" + NL
                + "ALTER LOGIN [c] ADD CREDENTIAL [vault];" + NL + "COMMIT TRANSACTION;" + NL + "GO" + NL
            && Script(ManagedSql("m"), new("grant", true)).Contains(Catalog.Logins.ScriptHeader, StringComparison.Ordinal),
            "a certificate login's script with statements after CREATE LOGIN is one XACT_ABORT transaction, its credential after Deny; Managed Instance's SQL Server login keeps the placeholder header");
        var mappedKey = Script(Key("k", "key"), new("grant", true), [new("App]Data", "k", null, ["db_owner"])]);
        var entraDisabled = Script(Entra("e@example.com"), new("grant", false));
        check(SqlScript.Parse(mappedKey).Count == 2 && mappedKey.Contains("EXEC [App]]Data].sys.sp_executesql N'CREATE USER [k] FOR LOGIN [k]';", StringComparison.Ordinal)
            && SqlScript.Parse(entraDisabled).Count == 2 && entraDisabled.Contains("ALTER LOGIN [e@example.com] DISABLE;" + NL + "COMMIT TRANSACTION;", StringComparison.Ordinal)
            && !mappedKey.Contains(Catalog.Logins.ScriptHeader, StringComparison.Ordinal) && !entraDisabled.Contains(Catalog.Logins.ScriptHeader, StringComparison.Ordinal)
            && Script(Certificate("c", "cert"), new("grant", true)) == "USE [master]" + NL + "GO" + NL + "CREATE LOGIN [c] FROM CERTIFICATE [cert]" + NL + "GO" + NL
            && SqlScript.Parse(Script(LoginChecks.Windows("D\\u"), new("deny", false))).Count == 4,
            "a key login's mapped users and an Entra login's Disable run in that one batch (users through the database's sp_executesql); CREATE LOGIN alone, and a Windows login, keep SSMS's GO form");
    }

    private static void Credentials(Action<bool, string> check)
    {
        check(ActionSql.Statement(ActionSql.Checked(new(ActionTemplate.AddLoginCredential, "master", ["a]pp", "va]ult"]))) == "ALTER LOGIN [a]]pp] ADD CREDENTIAL [va]]ult]"
            && ActionSql.Statement(ActionSql.Checked(new(ActionTemplate.DropLoginCredential, "master", ["app", "vault"]))) == "ALTER LOGIN [app] DROP CREDENTIAL [vault]"
            && ActionSql.ParameterCount(ActionTemplate.AddLoginCredential) == 2 && ActionSql.BindingOf(ActionTemplate.DropLoginCredential) == new BindingShape(true, 0, true, 0),
            "Map to Credential writes SMO's ALTER LOGIN … ADD CREDENTIAL and DROP CREDENTIAL, bound to the login (its first name)");
        foreach (var template in new[] { ActionTemplate.AddLoginCredential, ActionTemplate.DropLoginCredential })
            check(ActionSql.LintExecutable(ActionSql.Executable(template), template).Count == 0
                && ActionSql.LintExecutable(ActionSql.Executable(template).Replace("QUOTENAME(@p2)", "@p2", StringComparison.Ordinal), template).Count > 0,
                template + " passes the executable lint, which refuses its credential outside QUOTENAME");
        check(ActionService.StepTitle(ActionTemplate.AddLoginCredential) == "Map a credential" && ActionService.StepTitle(ActionTemplate.DropLoginCredential) == "Remove a credential"
            && ActionService.StepDetail(new(ActionTemplate.AddLoginCredential, "master", ["app", "vault"])) == "vault",
            "a credential's steps say what they do and name the credential");
        static string Plan(IEnumerable<PlannedStatement> plan) => string.Join(",", plan.Select(statement => statement.Template + ":" + string.Join("/", statement.Names)));
        var login = LoginChecks.Sql("L") with { Credentials = ["zeta", "Alpha"] };
        check(Plan(LoginSql.After(login, ["sysadmin"], new("deny", false))) == "DenyConnect:L,DisableLogin:L,AddLoginCredential:L/zeta,AddLoginCredential:L/Alpha,AddServerRoleMember:sysadmin/L",
            "New Login maps each credential after Deny and Disable and before the server roles, in Mapped Credentials' order (SSMS's order, D2 §0)");
        var failure = new ActionError("PERMISSION_DENIED", "Cannot find the credential.", false);
        static ActionStepDto Step(string status, ActionTemplate? template = null) => new(status, template is { } shown ? ActionService.StepTitle(shown) : ActionService.CreateLoginStep);
        var partial = ActionService.PartlyCreated(failure, new("grant", true), [Step("done"), Step("failed", ActionTemplate.AddLoginCredential), Step("skipped", ActionTemplate.AddServerRoleMember)]);
        check(partial.Message.StartsWith(ActionService.LoginCreatedMessage + " " + ActionService.LoginCredentialsMessage + " " + ActionService.LoginRolesMessage, StringComparison.Ordinal),
            "a New Login whose credential failed says the login was created and not every credential was mapped, before SQL Server's text");
    }

    private static string Refused(ActionService service, ActionArgs args)
    {
        try { service.Validate(args); return "accepted"; }
        catch (RequestException error) { return error.Code; }
    }

    private static ActionArgs Create(NewLoginDto login, List<UserMappingDto>? mappings = null) =>
        LoginChecks.Create(login, login.Auth == "sql" ? "Throwaway-K1" : null, mappings: mappings);

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new LoginChecks.Host(3));
        var accepted = new[] { Entra("u@example.com"), Certificate("c", "cert"), Key("k", "key"), ManagedSql("m"), LoginChecks.Windows("D\\u") with { Credentials = ["a", "b"] } };
        check(accepted.All(login => Refused(service, Create(login)) == "accepted"),
            "createLogin takes a Microsoft Entra login with its default database, a certificate or key login naming its certificate or key, a SQL Server login without options (Managed Instance), and credentials");
        var refused = new (string Name, ActionArgs Args)[]
        {
            ("a certificate login without its certificate", Create(new("certificate", "c", null))),
            ("a certificate login with a default database", Create(Certificate("c", "cert") with { DefaultDatabase = "master" })),
            ("an asymmetric key login with a language", Create(Key("k", "key") with { DefaultLanguage = "us_english" })),
            ("a Windows login naming a certificate", Create(LoginChecks.Windows("D\\u") with { Certificate = "cert" })),
            ("a certificate login naming a key", Create(Certificate("c", "cert") with { AsymmetricKey = "key" })),
            ("a Microsoft Entra login without a default database", Create(Entra("e") with { DefaultDatabase = null })),
            ("a Microsoft Entra login with credentials", Create(Entra("e") with { Credentials = ["vault"] })),
            ("a Microsoft Entra login with policy options", Create(Entra("e") with { CheckPolicy = true, CheckExpiration = false, MustChange = false })),
            ("a SQL Server login with some options", Create(ManagedSql("m") with { CheckPolicy = true })),
            ("duplicate credentials", Create(LoginChecks.Windows("D\\u") with { Credentials = ["a", "a"] })),
            ("17 credentials", Create(LoginChecks.Windows("D\\u") with { Credentials = [.. Enumerable.Range(0, 17).Select(index => "c" + index)] })),
            ("an overlong credential", Create(LoginChecks.Windows("D\\u") with { Credentials = [new string('c', 129)] })),
            ("an overlong certificate", Create(Certificate("c", new string('c', 129)))),
            ("an unknown kind", Create(new("token", "t", "master"))),
            ("a certificate login's user with a default schema", Create(Certificate("c", "cert"), [new("AppData", "c", "dbo", [])])),
            ("a password for a certificate login", LoginChecks.Create(Certificate("c", "cert"), null) with { Secrets = new("Throwaway-K1") })
        };
        var wrong = refused.Where(item => Refused(service, item.Args) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        check(wrong.Count == 0, "createLogin refuses the other kinds' fields where they do not belong, credentials beyond their bounds and for Entra, and a default schema for a certificate login's users: "
            + string.Join("; ", wrong));
        // Check Names: a login ref holding DOMAIN\name, and nothing else.
        string Describe(ObjectRefDto target, string? login = null)
        {
            try { service.Validate(new ActionDescribeArgs(Id(), Id(), "windowsPrincipal", target, Login: login)); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(Describe(new("login", Name: "D\\u")) == "accepted" && Describe(new("login", Name: "u")) == "INVALID_PARAMS" && Describe(new("login", Name: "D\\u\\v")) == "INVALID_PARAMS"
            && Describe(new("login", Name: "\\u")) == "INVALID_PARAMS" && Describe(Server) == "INVALID_PARAMS" && Describe(new("login", Name: "D\\u"), "D\\u") == "INVALID_PARAMS"
            && Describe(new("login", Database: "master", Name: "D\\u")) == "INVALID_PARAMS" && Catalog.Logins.CheckNamesDescribe == "windowsPrincipal",
            "Check Names takes a login ref with one DOMAIN\\name and nothing else");
    }

    private static void Rules(Action<bool, string> check)
    {
        var rules = Catalog.Logins;
        var messages = Catalog.Logins;
        check(rules.NewLoginRefusal(LoginChecks.Windows("D\\u"), "managedInstance", 16) == "This server does not offer this kind of login."
            && rules.NewLoginRefusal(Certificate("c", "cert"), "managedInstance", 16) is not null && rules.NewLoginRefusal(Key("k", "key"), "managedInstance", 16) is not null
            && rules.NewLoginRefusal(Entra("e"), "managedInstance", 12) is null && rules.NewLoginRefusal(ManagedSql("m"), "managedInstance", 12) is null
            && rules.NewLoginRefusal(LoginChecks.Sql("s"), "managedInstance", 12) is { } policy && policy.StartsWith("Azure SQL Managed Instance takes no password policy options", StringComparison.Ordinal)
            && rules.NewLoginRefusal(ManagedSql("m"), "box", 16) == "A SQL Server login on SQL Server states its password policy options."
            && rules.NewLoginRefusal(Entra("e"), "box", 15) == "Microsoft Entra logins need SQL Server 2022 or later." && rules.NewLoginRefusal(Entra("e"), "box", 16) is null
            && rules.NewLoginRefusal(Certificate("c", "cert"), "box", 13) is null && rules.NewLoginRefusal(LoginChecks.Windows("D\\u"), "box", 13) is null,
            "the engine rules come from logins.ts: Managed Instance creates SQL Server (without policy options) and Microsoft Entra logins only; SQL Server needs the options, and 2022 for Entra");
        check(rules.TakesDefaults("entra") && !rules.TakesDefaults("certificate") && !rules.TakesDefaults("asymmetricKey") && rules.TakesCredentials("asymmetricKey") && !rules.TakesCredentials("entra")
            && rules.PolicyOn("box") && !rules.PolicyOn("managedInstance") && rules.Auths.Order(StringComparer.Ordinal).SequenceEqual(["asymmetricKey", "certificate", "entra", "sql", "windows"])
            && messages.CheckNamesPermission.Contains("xp_logininfo", StringComparison.Ordinal) && messages.CheckNamesNotFound.Contains("DOMAIN\\name", StringComparison.Ordinal),
            "the catalogue says which kinds take defaults and credentials, where the policy options go, and Check Names' words");
    }

    private static void Properties(Action<bool, string> check)
    {
        var changes = new LoginChangesDto(Connect: "deny", RolesAdd: ["sysadmin"], CredentialsAdd: ["new", "Alpha"], CredentialsDrop: ["old"]);
        static string Plan(IEnumerable<PlannedStatement> plan) => string.Join(",", plan.Select(statement => statement.Template + ":" + string.Join("/", statement.Names)));
        check(Plan(LoginSql.PropertiesServerPlan("L", changes)) == "DenyConnect:L,DropLoginCredential:L/old,AddLoginCredential:L/new,AddLoginCredential:L/Alpha,AddServerRoleMember:sysadmin/L"
            && LoginSql.PropertiesStatements(changes) == 5 && LoginSql.PropertiesStatements(new(CredentialsDrop: ["old"])) == 1,
            "Login Properties removes, then maps, credentials after Connect and Enabled and before the server roles, each one statement");
        var script = LoginSql.PropertiesScriptText("L", new(CredentialsAdd: ["vault"], CredentialsDrop: ["old"]), new HashSet<string>(), Catalog.Logins.ScriptHeader);
        check(script == "USE [master]" + NL + "GO" + NL + "ALTER LOGIN [L] DROP CREDENTIAL [old]" + NL + "GO" + NL + "ALTER LOGIN [L] ADD CREDENTIAL [vault]" + NL + "GO" + NL,
            "Login Properties' script of a credential change is SSMS's GO form");
        using var service = new ActionService(new LoginChecks.Host(3));
        static ActionArgs Change(LoginChangesDto changes) => new("loginProperties", Id(), Id(), new ObjectRefDto("login", Name: "app_login"), LoginChanges: changes);
        check(Refused(service, Change(new(CredentialsAdd: ["a"]))) == "INVALID_PARAMS" && Refused(service, Change(new(CredentialsAdd: ["a"])) with { LoginIdentity = new("01", "2026-01-01T00:00:00.000") }) == "accepted"
            && Refused(service, Change(new(CredentialsAdd: ["a", "a"])) with { LoginIdentity = new("01", "2026-01-01T00:00:00.000") }) == "INVALID_PARAMS"
            && Refused(service, Change(new(CredentialsAdd: ["a"], CredentialsDrop: ["a"])) with { LoginIdentity = new("01", "2026-01-01T00:00:00.000") }) == "INVALID_PARAMS"
            && Refused(service, Change(new(CredentialsDrop: [.. Enumerable.Range(0, 17).Select(index => "c" + index)])) with { LoginIdentity = new("01", "2026-01-01T00:00:00.000") }) == "INVALID_PARAMS",
            "Login Properties takes distinct credentials to add or remove, never both, at most 16 each");
        static LoginFactsDto Facts(string subtype, string type) => new(300, type, subtype, false, "01", "2026-01-01T00:00:00.000", null, null, false, false, false, 0, null, [], null, true, true, false);
        check(LoginRules.PropertiesRefusal(Facts("externalUser", "E"), new(CredentialsAdd: ["vault"])) == "externalCredentials"
            && LoginRules.PropertiesRefusal(Facts("certificateMapped", "C"), new(Mappings: [new("AppData", "map", "c", DefaultSchema: "dbo")])) == "signingSchema"
            && LoginRules.PropertiesRefusal(Facts("certificateMapped", "C"), new(CredentialsAdd: ["vault"], Mappings: [new("AppData", "map", "c")])) is null
            && Catalog.Logins.Message("signingSchema").Contains("default schema", StringComparison.Ordinal),
            "Login Properties refuses credentials for a Microsoft Entra login and a default schema for a certificate login's users (15259)");
    }

    private static void Errors(Action<bool, string> check)
    {
        static SqlException Sql(int number) => ConnectionFailureChecks.Sql(number, 1, 16, "server", "failed");
        check(ActionErrors.CodeOf(Sql(15404), null) == "NOT_FOUND" && ActionErrors.CodeOf(Sql(15259), null) == "NOT_SUPPORTED" && ActionErrors.CodeOf(Sql(37525), null) == "NOT_SUPPORTED"
            && ActionErrors.CodeOf(Sql(15151), null) == "PERMISSION_DENIED",
            "Check Names' missing account (15404) is NOT_FOUND, a certificate user's default schema (15259) and Entra without Arc (37525) NOT_SUPPORTED, a missing certificate or credential (15151) PERMISSION_DENIED");
    }

    /// <summary>Check Names' 15404 by the Windows error xp_logininfo names (probed on SQL Server 2025), and its 229; then a 15151 from a
    /// step that names a credential, certificate or key, which is NOT_FOUND with what to check, while any other step's stays as it was.</summary>
    private static async Task FailuresAsync(Action<bool, string> check)
    {
        using var service = new ActionService(new LoginChecks.Host(3));
        var missing = service.CheckNamesFailure(15404, "Could not obtain information about Windows NT group/user 'NOSUCHDOMAIN\\nobody', error code 0x534.");
        var unreachable = service.CheckNamesFailure(15404, "Could not obtain information about Windows NT group/user 'NT SERVICE\\MSSQLSERVER', error code 0x54b.");
        var bare = service.CheckNamesFailure(15404, "Could not obtain information about Windows NT group/user 'ann', error code 0xffff0002.");
        var denied = service.CheckNamesFailure(229, "The EXECUTE permission was denied on the object 'xp_logininfo', database 'mssqlsystemresource', schema 'sys'.");
        check(missing is { Code: "NOT_FOUND" } && missing.Message == Catalog.Logins.CheckNamesNotFound
            && unreachable is { Code: "SQL_ERROR" } && unreachable.Message == Catalog.Logins.CheckNamesLookupFailed && bare.Message == Catalog.Logins.CheckNamesLookupFailed
            && denied is { Code: "PERMISSION_DENIED" } && denied.Message == Catalog.Logins.CheckNamesPermission
            && !Catalog.Logins.CheckNamesLookupFailed.Contains("could not find", StringComparison.OrdinalIgnoreCase),
            "Check Names says an account is missing only for Windows' 0x534; any other 15404 (a domain it could not reach, 0x54b) says the server could not look it up");
        static SqlException Sql(int number, string message) => ConnectionFailureChecks.Sql(number, 1, 16, "server", message);
        async Task<ActionError?> Step(string? advice, SqlException thrown)
        {
            try { await service.NamingAsync(null, () => throw thrown, advice, text => text.Replace("secret", "<password>", StringComparison.Ordinal), CancellationToken.None); return null; }
            catch (StepRefusedException refusal) { return refusal.Error; }
            catch (SqlException) { return new ActionError("RETHROWN", "", false); }
        }
        var credential = await Step(ActionService.NamedAdvice(ActionTemplate.AddLoginCredential), Sql(15151, "Cannot find the credential 'Vault', because it does not exist or you do not have permission. secret"));
        var certificate = await Step(ActionService.CertificateAdvice, Sql(15151, "Cannot find the certificate 'cert', because it does not exist or you do not have permission."));
        var other = await Step(ActionService.NamedAdvice(ActionTemplate.AddServerRoleMember), Sql(15151, "Cannot find the login 'x', because it does not exist or you do not have permission."));
        var otherNumber = await Step(ActionService.CredentialAdvice, Sql(15247, "User does not have permission to perform this action."));
        check(credential is { Code: "NOT_FOUND" } && credential.Message == "Cannot find the credential 'Vault', because it does not exist or you do not have permission. <password> " + ActionService.CredentialAdvice
            && ActionService.NamedAdvice(ActionTemplate.DropLoginCredential) == ActionService.CredentialAdvice
            && certificate is { Code: "NOT_FOUND" } && certificate.Message.EndsWith(" " + ActionService.CertificateAdvice, StringComparison.Ordinal)
            && !credential.Message.Contains(ActionErrors.LoginPermissionAdvice, StringComparison.Ordinal)
            && other?.Code == "RETHROWN" && otherNumber?.Code == "RETHROWN",
            "a 15151 on a credential, certificate or key step is NOT_FOUND with SQL Server's scrubbed text and what to check, never the login permission advice; other steps and numbers are left to the runner");
        var partly = ActionService.PartlyChanged(credential!, [new("done", ActionService.LoginOptionsStep), new("failed", ActionService.StepTitle(ActionTemplate.AddLoginCredential))], oldPassword: false);
        check(partly.Message.StartsWith(ActionService.LoginChangedMessage + " Cannot find the credential", StringComparison.Ordinal) && partly.Message.EndsWith(ActionService.CredentialAdvice, StringComparison.Ordinal),
            "Login Properties adds no login permission advice to a credential that went");
    }

    private static async Task EnginesAsync(Action<bool, string> check)
    {
        var managed = new LoginChecks.Host(8, 12);
        using var service = new ActionService(managed);
        async Task<string?> Script(NewLoginDto login) => (await service.ScriptAsync(Create(login) with { Secrets = null }, CancellationToken.None)) is { Error: { } error } ? error.Code + ": " + error.Message : null;
        var windows = await Script(LoginChecks.Windows("D\\u"));
        var policy = await Script(LoginChecks.Sql("s"));
        var run = await service.ExecuteAsync(LoginChecks.Create(LoginChecks.Windows("D\\u"), null), CancellationToken.None);
        var sql = await service.ScriptAsync(Create(ManagedSql("m")) with { Secrets = null }, CancellationToken.None);
        var entra = await service.ScriptAsync(Create(Entra("u@example.com")) with { Secrets = null }, CancellationToken.None);
        var names = await service.DescribeAsync(new(Id(), Id(), "windowsPrincipal", new("login", Name: "D\\u")), CancellationToken.None);
        check(windows == "NOT_SUPPORTED: This server does not offer this kind of login." && policy?.StartsWith("NOT_SUPPORTED: Azure SQL Managed Instance takes no password policy options", StringComparison.Ordinal) == true
            && run.Error?.Code == "NOT_SUPPORTED" && run.Steps.Count == 0 && names.Error?.Code == "NOT_SUPPORTED"
            && sql.Error is null && sql.Text!.Contains("CREATE LOGIN [m] WITH PASSWORD=<password>, DEFAULT_DATABASE=[master];", StringComparison.Ordinal)
            && entra.Error is null && entra.Text!.Contains("CREATE LOGIN [u@example.com] FROM EXTERNAL PROVIDER WITH DEFAULT_DATABASE=[master]", StringComparison.Ordinal) && managed.Connections == 0,
            "on Managed Instance New Login refuses Windows logins and policy options, and Check Names, before any connection opens; it scripts SQL Server and Entra logins from the request");
        var old = new LoginChecks.Host(3, 15);
        using var box = new ActionService(old);
        var early = await box.ScriptAsync(Create(Entra("u@example.com")) with { Secrets = null }, CancellationToken.None);
        var missing = await box.ScriptAsync(Create(ManagedSql("m")) with { Secrets = null }, CancellationToken.None);
        var key = await box.ScriptAsync(Create(Key("k", "key")) with { Secrets = null }, CancellationToken.None);
        check(early.Error?.Message == "Microsoft Entra logins need SQL Server 2022 or later." && missing.Error?.Code == "NOT_SUPPORTED" && key.Error is null
            && key.Text == "USE [master]" + NL + "GO" + NL + "CREATE LOGIN [k] FROM ASYMMETRIC KEY [key]" + NL + "GO" + NL && old.Connections == 0,
            "SQL Server 2019 refuses a Microsoft Entra login and a SQL Server login without its options, and scripts an asymmetric key login");
    }
}
