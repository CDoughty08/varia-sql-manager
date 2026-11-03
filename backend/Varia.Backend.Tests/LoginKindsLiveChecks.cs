using System.Text.Json;
using Varia.Backend.Actions;

namespace Varia.Backend.Tests;

/// <summary>Live checks of PR D2e. Without scratch objects: SQL Server builds exactly LoginSql's CREATE LOGIN for a Microsoft Entra,
/// certificate and asymmetric key login and Managed Instance's SQL Server login, for hostile names; New Login's describe lists master's
/// certificates and asymmetric keys and the server's credentials; and Check Names finds the connection's own Windows account and answers
/// NOT_FOUND for one that does not exist. With VARIA_TEST_SQL_SCRATCH=1, on logins named VariaScratch_…_l…: a certificate login whose
/// certificate does not exist and a Microsoft Entra login on a server without Microsoft Entra fail as values and create nothing, and a
/// credential that does not exist fails after the login was created, which stays and is said to first. The checks create no
/// certificate, key or credential: those live outside a scratch database.</summary>
internal static class LoginKindsLiveChecks
{
    private static readonly ObjectRefDto Server = new("server");

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, bool required = false)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<SqlRun> Sql(string text, string database = "master", int timeout = 300)
        {
            var id = Guid.NewGuid().ToString();
            try
            {
                var result = await Call<QueryResult>("query.execute", new QueryArgs(info.Id, id, database, text, Guid.NewGuid().ToString(), 100_000, timeout, StopOnError: true));
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
            + "CASE WHEN CHARINDEX(N'\\', SUSER_SNAME()) > 0 THEN 1 ELSE 0 END, IS_SRVROLEMEMBER(N'sysadmin');")).Sets[0][0];
        var linux = facts[0] == "1";

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
            var found = await actions.DescribeAsync(Names(own.ToLowerInvariant()), CancellationToken.None);
            check(found.Error is null && found.WindowsPrincipal is { Access: true, Type: "user" } principal && string.Equals(principal.AccountName, own, StringComparison.OrdinalIgnoreCase),
                "Check Names finds the connection's own Windows account, typed in lower case, and answers its name as the server spells it");
        }
        else Console.WriteLine("Check Names' own-account check skipped: it needs Windows authentication on SQL Server on Windows.");

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1" || facts[2] != "1")
        {
            Console.WriteLine("New Login kind scratch checks skipped. They need VARIA_TEST_SQL_SCRATCH=1 and a sysadmin connection.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title + (step.Detail is null ? "" : "/" + step.Detail)));
        async Task<string?> Exists(string name) => (await Sql("SELECT COUNT(*) FROM sys.server_principals WHERE name = N'" + name + "';")).Scalar;
        ActionArgs Create(NewLoginDto login, string? password) => LoginChecks.Create(login, password) with { ConnectionId = info.Id };

        // A certificate that does not exist (15151): nothing is created, and the error is a value.
        var certificateLogin = scratch.OwnLogin("kcert");
        var noCertificate = await actions.ExecuteAsync(Create(LoginKindsChecks.Certificate(certificateLogin, "VariaScratch_NoSuchCertificate"), null), CancellationToken.None);
        check(noCertificate.Error is { Code: "PERMISSION_DENIED" } && Steps(noCertificate) == "failed:Create the login" && await Exists(certificateLogin) == "0",
            "a certificate login whose certificate does not exist fails at CREATE LOGIN and creates nothing: " + noCertificate.Error?.Code + " " + Steps(noCertificate));
        var keyLogin = scratch.OwnLogin("kkey");
        var noKey = await actions.ExecuteAsync(Create(LoginKindsChecks.Key(keyLogin, "VariaScratch_NoSuchKey"), null), CancellationToken.None);
        check(noKey.Error is not null && Steps(noKey) == "failed:Create the login" && await Exists(keyLogin) == "0",
            "an asymmetric key login whose key does not exist fails at CREATE LOGIN and creates nothing: " + noKey.Error?.Code);

        // Microsoft Entra on SQL Server needs Azure Arc and an Entra admin; a server without them refuses (37525 on SQL Server 2025).
        var entraLogin = scratch.OwnLogin("kentra");
        var entra = await actions.ExecuteAsync(Create(LoginKindsChecks.Entra(entraLogin), null), CancellationToken.None);
        check(entra.Error is not null && Steps(entra) == "failed:Create the login" && await Exists(entraLogin) == "0",
            "a Microsoft Entra login on a server without Microsoft Entra fails as a value and creates nothing: " + entra.Error?.Code);

        // A credential that does not exist fails after the login was created: the login stays, and the reply says so first.
        var credentialLogin = scratch.OwnLogin("kcred");
        var password = ScratchDatabase.Throwaway();
        var noCredential = await actions.ExecuteAsync(Create(LoginChecks.Sql(credentialLogin, false, false, false) with { Credentials = ["VariaScratch_NoSuchCredential"] }, password), CancellationToken.None);
        check(noCredential.Error is { } credentialError && credentialError.Message.StartsWith(ActionService.LoginCreatedMessage + " " + ActionService.LoginCredentialsMessage + " ", StringComparison.Ordinal)
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
        check(login.LoginProperties is { Credentials.Count: 0, CredentialsTruncated: false, Certificate: null } && properties?.Error is not null && properties.Steps.LastOrDefault()?.Status == "failed" && mapped == "0",
            "Login Properties reads a login's credentials (none) and a credential that does not exist fails as a value: " + properties?.Error?.Code);
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
