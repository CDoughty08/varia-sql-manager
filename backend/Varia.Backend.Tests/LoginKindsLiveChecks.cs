using System.Text.Json;
using Varia.Backend.Actions;

namespace Varia.Backend.Tests;

/// <summary>Live checks of PR D2e. Without scratch objects: SQL Server builds exactly LoginSql's CREATE LOGIN for a Microsoft Entra,
/// certificate and asymmetric key login and Managed Instance's SQL Server login, for hostile names; New Login's describe lists master's
/// certificates and asymmetric keys and the server's credentials; Login Properties reads a certificate login's certificate (SQL Server's
/// own ##MS_…## ones, read only) and a login's credentials where one has any; and Check Names finds the connection's own Windows account,
/// named as typed, and answers NOT_FOUND for one that does not exist. With VARIA_TEST_SQL_SCRATCH=1, on logins named VariaScratch_…: a
/// certificate or key login whose certificate or key does not exist fails as NOT_FOUND and creates nothing, a Microsoft Entra login fails
/// as a value and creates nothing (refused before connecting below SQL Server 2022), a credential that does not exist fails after the
/// login was created, which stays and is said to first, and in Login Properties too; a certificate login's script run where the
/// certificate is missing changes nothing on an existing login of that name; and Check Names answers PERMISSION_DENIED to a login that
/// may not run xp_logininfo. The checks create no certificate, key or credential: those live outside a scratch database.</summary>
internal static class LoginKindsLiveChecks
{
    private static readonly ObjectRefDto Server = new("server");

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json, bool required = false)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<SqlRun> Sql(string text, string database = "master", int timeout = 300, bool stopOnError = true)
        {
            var id = Guid.NewGuid().ToString();
            try
            {
                var result = await Call<QueryResult>("query.execute", new QueryArgs(info.Id, id, database, text, Guid.NewGuid().ToString(), 100_000, timeout, StopOnError: stopOnError));
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await Call<object>("query.session.close", new SessionArgs(id)); }
        }
        var actions = service.Actions;
        var edition = (await Sql("SELECT CONVERT(int, SERVERPROPERTY('EngineEdition'));")).Scalar;
        if (edition is "5" or "6" or "8" or "9" or "11")
        {
            if (required) throw new Exception("--login-kinds-live needs SQL Server (a box edition).");
            Console.WriteLine("New Login kind live checks skipped: they run on SQL Server (a box edition).");
            return;
        }
        var facts = (await Sql("SELECT CASE WHEN EXISTS (SELECT 1 FROM sys.dm_os_host_info WHERE host_platform = N'Linux') THEN 1 ELSE 0 END, "
            + "CASE WHEN CHARINDEX(N'\\', SUSER_SNAME()) > 0 THEN 1 ELSE 0 END, IS_SRVROLEMEMBER(N'sysadmin'), CONVERT(int, SERVERPROPERTY('ProductMajorVersion'));")).Sets[0][0];
        var linux = facts[0] == "1";
        var major = int.Parse(facts[3]!, System.Globalization.CultureInfo.InvariantCulture);

        await DryRunsAsync(check, actions, info);

        // New Login's describe: master's certificates and asymmetric keys, the server's credentials, and the engine.
        var described = await actions.DescribeAsync(new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "newLogin", Server), CancellationToken.None);
        var counts = (await Sql("SELECT (SELECT COUNT(*) FROM master.sys.certificates), (SELECT COUNT(*) FROM master.sys.asymmetric_keys), (SELECT COUNT(*) FROM sys.credentials);")).Sets[0][0];
        check(described.NewLogin is { } model && model.Server.Engine == "box" && model.Certificates.Count.ToString(System.Globalization.CultureInfo.InvariantCulture) == counts[0]
            && model.AsymmetricKeys.Count.ToString(System.Globalization.CultureInfo.InvariantCulture) == counts[1] && model.Credentials.Count.ToString(System.Globalization.CultureInfo.InvariantCulture) == counts[2]
            && !model.CertificatesTruncated && !model.AsymmetricKeysTruncated && !model.CredentialsTruncated,
            "New Login's describe lists every certificate and asymmetric key in master and every credential, on a box server: " + string.Join(",", counts));

        // Check Names: xp_logininfo for an account that cannot exist, and for the connection's own Windows account.
        ActionDescribeArgs Names(string name) => new(info.Id, Guid.NewGuid().ToString(), actions.Catalog.Logins.CheckNamesDescribe, new ObjectRefDto("login", Name: name));
        var missing = await actions.DescribeAsync(Names("VARIANOSUCHDOMAIN\\VariaNobody" + Guid.NewGuid().ToString("N")[..8]), CancellationToken.None);
        check(linux ? missing.Error is not null || missing.WindowsPrincipal is { Access: false }
                : missing.Error is { Code: "NOT_FOUND" } notFound && notFound.Message == actions.Catalog.Logins.CheckNamesNotFound,
            "Check Names answers NOT_FOUND with the catalogue's words for a Windows account the server cannot find (15404): " + missing.Error?.Code);
        if (facts[1] == "1" && !linux)
        {
            var own = (await Sql("SELECT SUSER_SNAME();")).Scalar!;
            var typed = own.ToLowerInvariant();
            var found = await actions.DescribeAsync(Names(typed), CancellationToken.None);
            check(found.Error is null && found.WindowsPrincipal is { Access: true, Type: "user" } principal && principal.AccountName == typed,
                "Check Names finds the connection's own Windows account, typed in lower case, and names it as typed (xp_logininfo echoes @acctname)");
        }
        else Console.WriteLine("Check Names' own-account check skipped: it needs Windows authentication on SQL Server on Windows.");

        await PropertiesReadsAsync(check, actions, info, Sql);

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1" || facts[2] != "1")
        {
            Console.WriteLine("New Login kind scratch checks skipped. They need VARIA_TEST_SQL_SCRATCH=1 and a sysadmin connection.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title + (step.Detail is null ? "" : "/" + step.Detail)));
        async Task<string?> Exists(string name) => (await Sql("SELECT COUNT(*) FROM sys.server_principals WHERE name = N'" + name + "';")).Scalar;
        ActionArgs Create(NewLoginDto login, string? password) => LoginChecks.Create(login, password) with { ConnectionId = info.Id };

        // A certificate or key that does not exist (15151): NOT_FOUND with what to check, never the login permission advice; nothing is created.
        var certificateLogin = scratch.OwnLogin("kcert");
        var noCertificate = await actions.ExecuteAsync(Create(LoginKindsChecks.Certificate(certificateLogin, "VariaScratch_NoSuchCertificate"), null), CancellationToken.None);
        check(noCertificate.Error is { Code: "NOT_FOUND" } certificateError && certificateError.Message.EndsWith(" " + ActionService.CertificateAdvice, StringComparison.Ordinal)
            && Steps(noCertificate).StartsWith("failed:Create the login", StringComparison.Ordinal) && noCertificate.Steps.Count == 1 && await Exists(certificateLogin) == "0",
            "a certificate login whose certificate does not exist fails at CREATE LOGIN as NOT_FOUND, says to check the certificate, and creates nothing: " + noCertificate.Error?.Code + " " + Steps(noCertificate));
        var keyLogin = scratch.OwnLogin("kkey");
        var noKey = await actions.ExecuteAsync(Create(LoginKindsChecks.Key(keyLogin, "VariaScratch_NoSuchKey"), null), CancellationToken.None);
        check(noKey.Error is { Code: "NOT_FOUND" } keyError && keyError.Message.EndsWith(" " + ActionService.AsymmetricKeyAdvice, StringComparison.Ordinal) && noKey.Steps.Count == 1
            && await Exists(keyLogin) == "0",
            "an asymmetric key login whose key does not exist fails at CREATE LOGIN as NOT_FOUND, says to check the key, and creates nothing: " + noKey.Error?.Code);

        // Microsoft Entra on SQL Server needs 2022 or later, Azure Arc and an Entra admin: before 2022 the backend refuses it before it
        // connects; from 2022 a server without them refuses (37525 on SQL Server 2025).
        var entraLogin = scratch.OwnLogin("kentra");
        var entra = await actions.ExecuteAsync(Create(LoginKindsChecks.Entra(entraLogin), null), CancellationToken.None);
        var refusal = actions.Catalog.Logins.NewLoginRefusal(LoginKindsChecks.Entra(entraLogin), "box", major);
        check(major < 16
                ? refusal is not null && entra.Error is { Code: "NOT_SUPPORTED" } old && old.Message == refusal && entra.Steps.Count == 0 && await Exists(entraLogin) == "0"
                : refusal is null && entra.Error is not null && Steps(entra) == "failed:Create the login" && await Exists(entraLogin) == "0",
            "a Microsoft Entra login fails as a value and creates nothing: refused before connecting below SQL Server 2022, by the server without Microsoft Entra from 2022 ("
            + major + "): " + entra.Error?.Code);

        // Script Action: a certificate login's script with statements after CREATE LOGIN, run where the certificate is missing and an
        // unrelated login has the name, changes nothing on that login (one XACT_ABORT batch; GO batches would deny and disable it).
        var bystander = scratch.OwnLogin("kby");
        var bystanderSetUp = await Sql("CREATE LOGIN [" + bystander + "] WITH PASSWORD = N'" + ScratchDatabase.Throwaway().Replace("'", "''", StringComparison.Ordinal) + "', CHECK_POLICY = OFF;");
        var script = await actions.ScriptAsync(LoginChecks.Create(LoginKindsChecks.Certificate(bystander, "VariaScratch_NoSuchCertificate"), null, status: new("deny", false)) with { ConnectionId = info.Id },
            CancellationToken.None);
        if (script.Text is { } scriptText) await Sql(scriptText, stopOnError: false);
        var bystanderState = (await Sql("SELECT CONVERT(int, p.is_disabled), (SELECT COUNT(*) FROM sys.server_permissions AS sp WHERE sp.grantee_principal_id = p.principal_id AND sp.type = 'COSQ' AND sp.state = 'D') "
            + "FROM sys.server_principals AS p WHERE p.name = N'" + bystander + "';")).Sets[0];
        check(bystanderSetUp.Status == "completed" && script.Error is null && script.Text?.Contains("SET XACT_ABORT ON;", StringComparison.Ordinal) == true
            && bystanderState is [[ "0", "0" ]],
            "a certificate login's script run where its certificate is missing denies and disables nothing on an existing login of that name: "
            + string.Join("|", bystanderState.SelectMany(row => row)));

        // A credential that does not exist fails after the login was created: the login stays, and the reply says so first.
        var credentialLogin = scratch.OwnLogin("kcred");
        var password = ScratchDatabase.Throwaway();
        var noCredential = await actions.ExecuteAsync(Create(LoginChecks.Sql(credentialLogin, false, false, false) with { Credentials = ["VariaScratch_NoSuchCredential"] }, password), CancellationToken.None);
        check(noCredential.Error is { Code: "NOT_FOUND" } credentialError && credentialError.Message.StartsWith(ActionService.LoginCreatedMessage + " " + ActionService.LoginCredentialsMessage + " ", StringComparison.Ordinal)
            && credentialError.Message.Contains(ActionService.CredentialAdvice, StringComparison.Ordinal)
            && Steps(noCredential) == "done:Create the login, failed:Map a credential/VariaScratch_NoSuchCredential" && await Exists(credentialLogin) == "1"
            && !JsonSerializer.Serialize(noCredential).Contains(password, StringComparison.Ordinal),
            "a credential that does not exist fails after the login was created, which stays, and the reply says so first: " + noCredential.Error?.Code + " " + Steps(noCredential));
        // Login Properties: the same credential on the login that stays fails as a value and changes nothing.
        var login = await actions.DescribeAsync(new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "loginProperties", new ObjectRefDto("login", Name: credentialLogin)), CancellationToken.None);
        var properties = login.Login is { } loginFacts
            ? await actions.ExecuteAsync(new ActionArgs("loginProperties", info.Id, Guid.NewGuid().ToString(), new ObjectRefDto("login", Name: credentialLogin),
                LoginIdentity: new(loginFacts.Sid, loginFacts.Created), LoginChanges: new(CredentialsAdd: ["VariaScratch_NoSuchCredential"])), CancellationToken.None)
            : null;
        var mapped = (await Sql("SELECT COUNT(*) FROM sys.server_principal_credentials AS c JOIN sys.server_principals AS p ON p.principal_id = c.principal_id WHERE p.name = N'" + credentialLogin + "';")).Scalar;
        check(login.LoginProperties is { Credentials.Count: 0, CredentialsTruncated: false, Certificate: null } && properties?.Error is { Code: "NOT_FOUND" } propertiesError
            && propertiesError.Message.EndsWith(ActionService.CredentialAdvice, StringComparison.Ordinal) && !propertiesError.Message.Contains(ActionErrors.LoginPermissionAdvice, StringComparison.Ordinal)
            && properties.Steps.LastOrDefault()?.Status == "failed" && mapped == "0",
            "Login Properties reads a login's credentials (none) and a credential that does not exist fails as NOT_FOUND, saying to check it: " + properties?.Error?.Code + " " + properties?.Error?.Message);

        // Check Names as a login that may not run xp_logininfo (229): PERMISSION_DENIED with the catalogue's words.
        if (!await scratch.CreateLoginAsync())
        {
            Console.WriteLine("Check Names' permission check skipped: the server accepts Windows logins only.");
            return;
        }
        var low = await Call<ConnectionInfo>("connections.connect", live("master") with { Authentication = "sql", Username = scratch.Login, Password = scratch.Password, Database = "master" });
        try
        {
            var refused = await actions.DescribeAsync(new ActionDescribeArgs(low.Id, Guid.NewGuid().ToString(), actions.Catalog.Logins.CheckNamesDescribe, new ObjectRefDto("login", Name: "VARIANOSUCHDOMAIN\\VariaNobody")),
                CancellationToken.None);
            check(refused.Error is { Code: "PERMISSION_DENIED" } denied && denied.Message == actions.Catalog.Logins.CheckNamesPermission && refused.WindowsPrincipal is null,
                "Check Names answers PERMISSION_DENIED with the catalogue's words to a login that may not run xp_logininfo (229): " + refused.Error?.Code);
        }
        finally { await Call<object>("connections.disconnect", new ConnectionArgs(low.Id)); }
    }

    /// <summary>Login Properties' reads of what D2e adds, on SQL Server's own logins (read only): a certificate login's certificate
    /// (SQL Server ships ##MS_…## ones) and an asymmetric key login's key, and a login's mapped credentials where one has any.</summary>
    private static async Task PropertiesReadsAsync(Action<bool, string> check, ActionService actions, ConnectionInfo info, Func<string, string, int, bool, Task<SqlRun>> sql)
    {
        async Task<ActionDescribeResult> Properties(string name) =>
            await actions.DescribeAsync(new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "loginProperties", new ObjectRefDto("login", Name: name)), CancellationToken.None);
        foreach (var (type, label) in new[] { ("C", "certificate"), ("K", "asymmetric key") })
        {
            var source = type == "C" ? "master.sys.certificates" : "master.sys.asymmetric_keys";
            var rows = (await sql("SELECT TOP (1) p.name, s.name FROM sys.server_principals AS p JOIN " + source + " AS s ON s.sid = p.sid WHERE p.type = '" + type + "' ORDER BY p.name;", "master", 300, true)).Sets[0];
            if (rows is not [[{ } name, { } mappedTo]])
            {
                Console.WriteLine("Login Properties' " + label + " read check skipped: the server has no login mapped to one.");
                continue;
            }
            var read = await Properties(name);
            check(read.Error is null && read.LoginProperties is { } facts && (type == "C" ? facts.Certificate == mappedTo && facts.AsymmetricKey is null : facts.AsymmetricKey == mappedTo && facts.Certificate is null),
                "Login Properties reads the " + label + " a " + label + " login is mapped to: " + read.Error?.Code);
        }
        var credentialRows = (await sql("SELECT TOP (1) p.name FROM sys.server_principal_credentials AS pc JOIN sys.server_principals AS p ON p.principal_id = pc.principal_id ORDER BY p.name;", "master", 300, true)).Sets[0];
        if (credentialRows is not [[{ } holder]])
        {
            Console.WriteLine("Login Properties' credential read check skipped: no login on the server has a credential mapped.");
            return;
        }
        var expected = (await sql("SELECT c.name FROM sys.server_principal_credentials AS pc JOIN sys.server_principals AS p ON p.principal_id = pc.principal_id JOIN sys.credentials AS c ON c.credential_id = pc.credential_id "
            + "WHERE p.name = N'" + holder.Replace("'", "''", StringComparison.Ordinal) + "' ORDER BY c.name;", "master", 300, true)).Sets[0].Select(row => row[0]!).ToList();
        var holderRead = await Properties(holder);
        check(holderRead.LoginProperties is { } held && held.Credentials.SequenceEqual(expected.Take(held.Credentials.Count), StringComparer.Ordinal) && held.Credentials.Count > 0,
            "Login Properties reads the credentials mapped to a login that has some: " + holderRead.Error?.Code);
    }

    /// <summary>Every new CREATE LOGIN shape, for hostile names, as SQL Server builds it from the batch (the dry run selects @stmt), equals
    /// LoginSql.CreateStatement. Nothing runs, so the certificate and key need not exist.</summary>
    private static async Task DryRunsAsync(Action<bool, string> check, ActionService actions, ConnectionInfo info)
    {
        var names = new[] { "]", "'", "a]b'; DROP LOGIN sa; --", "line\nbreak", "x" + new string(']', 63) + new string('y', 64), "Fran]çais" };
        var wrong = new List<string>();
        var cases = 0;
        foreach (var name in names)
        {
            var other = new string(name.Reverse().ToArray());
            foreach (var login in new[]
            {
                LoginKindsChecks.Entra(name + "@example.com"[..Math.Min(12, 128 - name.Length)], "Ap]p'"),
                LoginKindsChecks.Entra(name, "Ap]p'", "us]english'"),
                LoginKindsChecks.Certificate(name, other),
                LoginKindsChecks.Key(name, other)
            })
            {
                if (await actions.DryRunCreateLoginAsync(info.Id, login, null, CancellationToken.None) != LoginSql.CreateStatement(login, null)) wrong.Add(login.Auth + " " + name.Length);
                cases++;
            }
            var managed = LoginKindsChecks.ManagedSql(name) with { DefaultDatabase = "Ap]p'" };
            var password = ("p'＇]" + name)[..Math.Min(128, name.Length + 4)];
            if (await actions.DryRunCreateLoginAsync(info.Id, managed, password, CancellationToken.None) != LoginSql.CreateStatement(managed, password)) wrong.Add("managed " + name.Length);
            cases++;
        }
        check(wrong.Count == 0 && cases == 6 * 5,
            "SQL Server builds exactly LoginSql's CREATE LOGIN for Microsoft Entra, certificate, asymmetric key and policy-free SQL Server logins with hostile names (" + cases + "): " + string.Join(", ", wrong.Take(5)));
    }
}
