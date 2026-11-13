using System.Text;
using System.Text.Json;
using System.Data;
using System.Data.Common;
using System.Reflection;
using Microsoft.Data.SqlClient;
using Varia.Backend.Entra;
using Varia.Backend.Explorer;
using Varia.Backend.Actions;
using Varia.Backend.Scripting;
using Varia.Backend.Ssis;
using Varia.Backend.Search;
using Varia.Backend.Live;
using Varia.Backend.Activity;
using Varia.Backend.Plans;

namespace Varia.Backend.Tests;

/// <summary>Stable account evidence, without a tenant or SQL Server. Fake login successes join the exact provider request.</summary>
internal static class ConnectionPrincipalChecks
{
    private const string Tenant = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    private const string FirstObject = "11111111-2222-3333-4444-555555555555";
    private const string OtherObject = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    private static string Jwt(string claims) => "e30." + Convert.ToBase64String(Encoding.UTF8.GetBytes(claims)).TrimEnd('=').Replace('+', '-').Replace('/', '_') + ".signature";
    private static string Claims(string oid = FirstObject, string tenant = Tenant) => JsonSerializer.Serialize(new { oid, tid = tenant, preferred_username = "same-name@contoso.com", name = "Same SQL group" });
    private static SqlAuthenticationParameters Parameters(Guid id, string? user = null) => new(SqlAuthenticationMethod.ActiveDirectoryInteractive,
        "sql.contoso.database.windows.net", "appdb", "https://database.windows.net/", "https://login.microsoftonline.com/" + Tenant, user, null, id, 15);

    public static async Task RunAsync(Action<bool, string> check)
    {
        check(ConnectionPrincipal.FromSid([0x01, 0xab, 0xff]) == "sid:01abff" && ConnectionPrincipal.FromSid(new byte[85])?.Length == 174,
            "SQL and Windows SIDs are bounded canonical stable evidence, not display login names");
        check(ConnectionPrincipal.FromSid(null) is null && ConnectionPrincipal.FromSid([]) is null && ConnectionPrincipal.FromSid(new byte[86]) is null,
            "missing and oversized SQL SIDs cannot establish a connection identity");
        check(ConnectionPrincipal.FromSid([1]) != ConnectionPrincipal.FromSid([2]), "recreated same-name SQL accounts with different SIDs remain distinct");
        check(CatalogSql.Lint(ConnectionPrincipal.ProbeSidSql, new SqlRender(12), list: false, mayCheckAccess: false).Count == 0
            && ConnectionPrincipal.ProbeSidSql == "SELECT SUSER_SID();" && ServerProfile.ProbeSql.EndsWith(", SUSER_SID();", StringComparison.Ordinal)
            && ServerProfile.Fallback("16.00.1000").PrincipalId is null,
            "the independent constant identity probe is linted and does not require optional capability metadata");
        var expected = $"entra:{Tenant}:{FirstObject}";
        check(ConnectionPrincipal.FromEntraToken(Jwt(Claims(FirstObject.ToUpperInvariant(), Tenant.ToUpperInvariant()))) == expected,
            "the token tenant and object GUIDs form a canonical stable principal");
        check(ConnectionPrincipal.FromEntraToken(Jwt(Claims(OtherObject))) != expected
            && ConnectionPrincipal.FromEntraToken(Jwt(Claims(tenant: OtherObject))) != expected,
            "same display login and SQL group cannot equate another Entra object or tenant");
        foreach (var payload in new[] { "{}", "[]", "null", "{", "{\"oid\":\"" + FirstObject + "\"}",
            "{\"tid\":\"" + Tenant + "\",\"oid\":\"bad\"}", "{\"tid\":null,\"oid\":\"" + FirstObject + "\"}",
            "{\"tid\":\"" + Tenant + "\",\"oid\":\"" + Guid.Empty + "\"}",
            "{\"tid\":\"" + Tenant + "\",\"oid\":\"" + FirstObject + "\",\"oid\":\"" + OtherObject + "\"}",
            "{\"tid\":\"" + Tenant + "\",\"tid\":\"" + Tenant + "\",\"oid\":\"" + FirstObject + "\"}",
            "{\"preferred_username\":\"same-name@contoso.com\",\"name\":\"same SQL group\"}" })
            check(ConnectionPrincipal.FromEntraToken(Jwt(payload)) is null, "missing, duplicate, malformed or display-only token identity is refused");
        foreach (var token in new[] { "opaque", "a.b.c.d", "a.%%%%.b", "a.====.b", new string('x', ConnectionPrincipal.MaxTokenLength + 1), Jwt(new string('[', 9) + new string(']', 9)) })
            check(ConnectionPrincipal.FromEntraToken(token) is null, "opaque, oversized, malformed or deeply nested token payload is refused without exposing it");
        RequestException? missing = null;
        try { ConnectionPrincipal.Require(null); } catch (RequestException error) { missing = error; }
        check(missing is { Code: "AUTH_IDENTITY" }, "missing authenticated evidence fails closed without a login fallback");

        var current = Jwt(Claims());
        var service = new EntraService(new EntraChecks.FakeSource
        {
            Silent = (_, _) => Task.FromResult<EntraToken?>(new(current, DateTimeOffset.UtcNow.AddHours(1), "same-name@contoso.com"))
        });
        var opens = new List<SqlConnectionStringBuilder>();
        async Task<Guid> Login(string text, CancellationToken token)
        {
            var builder = new SqlConnectionStringBuilder(text);
            opens.Add(builder);
            var id = Guid.NewGuid();
            await service.Provider.AcquireTokenAsync(Parameters(id, string.IsNullOrEmpty(builder.UserID) ? null : builder.UserID));
            return id;
        }
        const string anonymous = "Data Source=sql.contoso.database.windows.net;Authentication=Active Directory Interactive";
        var (_, kept, actual) = await service.OpenForUserAsync(anonymous, "sql.contoso.database.windows.net", Login, id => id, CancellationToken.None);
        check(actual == expected && service.Attempts.Count == 0 && !opens.Single().Pooling && new SqlConnectionStringBuilder(kept) is { Pooling: true, UserID: "same-name@contoso.com" },
            "anonymous MFA preserves its exact supplied-token principal while consuming account pinning and retains the later pooling preference");
        current = Jwt(Claims(OtherObject));
        var (_, _, changed) = await service.OpenForUserAsync(kept, "sql.contoso.database.windows.net", Login, id => id, CancellationToken.None);
        check(changed == $"entra:{Tenant}:{OtherObject}" && changed != actual && opens.All(open => !open.Pooling),
            "named Entra connects also force fresh provider proof and distinguish same-name accounts behind one SQL group");
        var (_, unpooled, _) = await service.OpenForUserAsync(kept + ";Pooling=false", "sql.contoso.database.windows.net", Login, id => id, CancellationToken.None);
        check(!new SqlConnectionStringBuilder(unpooled).Pooling, "an explicitly unpooled profile remains unpooled after authentication");
        var (_, _, unjoined) = await service.OpenForUserAsync(kept, "sql.contoso.database.windows.net", Login, _ => Guid.NewGuid(), CancellationToken.None);
        check(unjoined is null, "another successful connection ID cannot borrow the supplied token's identity proof");
        var (_, _, reused) = await service.OpenForUserAsync(kept, "sql.contoso.database.windows.net", (_, _) => Task.FromResult(Guid.NewGuid()), id => id, CancellationToken.None);
        check(reused is null, "a connection without a provider call cannot reuse earlier account evidence");

        using var sql = new SqlService();
        var closed = new SqlConnection(kept);
        sql.OpenUser = (_, _, _) => Task.FromResult(closed);
        missing = null;
        try { await sql.ConnectAsync(new("sql.contoso.database.windows.net", "appdb", "entraMfa", null, null, false), CancellationToken.None); }
        catch (RequestException error) { missing = error; }
        check(missing is { Code: "AUTH_IDENTITY" } && closed.ConnectionString.Length == 0,
            "an Entra open missing provider evidence is disposed before metadata or backend target registration");
        await ScopesAsync(check, expected);
        await LaterOpensAsync(check, expected);
        await PlanOwnershipAsync(check);
        await ConnectionBindingChecks.RunAsync(check);
    }

    private static void RaiseOpen(SqlConnection connection)
    {
        var raise = typeof(DbConnection).GetMethod("OnStateChange", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new Exception("DbConnection.OnStateChange changed; update the native ownership regression.");
        raise.Invoke(connection, [new StateChangeEventArgs(ConnectionState.Closed, ConnectionState.Open)]);
    }

    private static async Task PlanOwnershipAsync(Action<bool, string> check)
    {
        using var sql = new SqlService();
        var target = sql.Register("Data Source=offline;Integrated Security=true", ServerProfile.Fallback("16.00.1000") with { PrincipalId = "sid:01" }, "master");
        var signaled = false;
        sql.OpenConnection = (connection, _) =>
        {
            // Exercise the event the real SqlClient raises, rather than a no-op fake Open that cannot expose duplicate guards.
            RaiseOpen(connection);
            signaled = true;
            throw new InvalidOperationException("estimated-open-approved");
        };
        Exception? failure = null;
        try
        {
            await sql.DispatchAsync("plans.estimate", JsonSerializer.SerializeToElement(new EstimatedPlanArgs(target, Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "master", "SELECT 1;"), HostChecks.Json), HostChecks.Json);
        }
        catch (Exception error) { failure = error; }
        check(signaled && failure is InvalidOperationException { Message: "estimated-open-approved" },
            "an isolated estimated-plan connection promoted from plain ownership raises Open through one shared identity fence");

        sql.OpenConnection = (connection, _) => { RaiseOpen(connection); return Task.CompletedTask; };
        sql.ProbePrincipal = (_, _) => Task.FromResult<string?>("sid:02");
        var observer = ((IExplorerHost)sql).Connection(target, "master");
        var capture = new ActualPlanCapture(observer, false, open: sql.Open);
        // Model capture setup/user SQL having completed before its observer connection was lost.
        typeof(ActualPlanCapture).GetField("attempted", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(capture, true);
        typeof(ActualPlanCapture).GetField("name", BindingFlags.Instance | BindingFlags.NonPublic)!.SetValue(capture, "VariaActual_cleanup_regression");
        typeof(ActualPlanCapture).GetProperty(nameof(ActualPlanCapture.Started))!.SetValue(capture, true);
        var cleanup = await capture.CloseAsync(CancellationToken.None);
        check(cleanup == "Actual plan capture could not remove its Extended Events session (VariaActual_cleanup_regression)." && observer.ConnectionString.Length == 0,
            "a lost actual-plan observer reopens through the target SID guard and reports cleanup-only identity failure as a notice, preserving the executed query outcome");
        var calls = 0;
        var unused = new ActualPlanCapture(new SqlConnection("Data Source=offline"), false, open: (_, _) => { calls++; throw new RequestException("AUTH_IDENTITY", "unused"); });
        check(await unused.CloseAsync(CancellationToken.None) is null && calls == 0,
            "actual-plan cleanup never authenticates a new observer when capture setup was not attempted");
    }

    private static async Task ScopesAsync(Action<bool, string> check, string expected)
    {
        var fake = new EntraChecks.FakeSource { Silent = (_, _) => Task.FromResult<EntraToken?>(new(Jwt(Claims()), DateTimeOffset.UtcNow.AddHours(1), "same-name@contoso.com")) };
        var service = new EntraService(fake);
        async Task<bool> Refused(Guid id)
        {
            try { await service.Provider.AcquireTokenAsync(Parameters(id)); return false; }
            catch (EntraProviderException) { return service.Attempts.Take(id) is EntraFailure { Code: "AUTH_IDENTITY" }; }
        }
        check(!EntraConnectScope.Authorized && await Refused(Guid.NewGuid()) && fake.Calls.Count == 0,
            "a provider acquisition without an explicit authorized scope fails before fetching or supplying any token");
        using var initialBudget = new CancellationTokenSource();
        using (var initial = new EntraConnectScope(initialBudget.Token, allowUnpinned: true))
        {
            var hit = await service.Provider.AcquireTokenAsync(Parameters(Guid.NewGuid()));
            check(hit.AccessToken == Jwt(Claims()) && EntraConnectScope.Authorized && EntraConnectScope.ExpectedPrincipal is null && EntraConnectScope.Token == initialBudget.Token,
                "intentional initial authentication explicitly permits discovering a token account under its own budget");
            using (var pinned = new EntraConnectScope(CancellationToken.None, expected))
            {
                hit = await service.Provider.AcquireTokenAsync(Parameters(Guid.NewGuid()));
                check(hit.AccessToken == Jwt(Claims()) && EntraConnectScope.ExpectedPrincipal == expected,
                    "a pinned native open permits only its expected tenant and object identity");
                using (var unapproved = new EntraConnectScope(CancellationToken.None))
                    check(!EntraConnectScope.Authorized && await Refused(Guid.NewGuid()), "a token-budget-only scope cannot acquire an unpinned account for a native target");
                check(EntraConnectScope.Authorized && EntraConnectScope.ExpectedPrincipal == expected && EntraConnectScope.Token == CancellationToken.None,
                    "nested scopes restore the pinned native target and its budget exactly");
            }
            check(EntraConnectScope.Authorized && EntraConnectScope.ExpectedPrincipal is null && EntraConnectScope.Token == initialBudget.Token,
                "disposing a nested pinned scope restores only the intentional initial-authentication permission");
            var before = fake.Calls.Count;
            Task<bool> background;
            using (ExecutionContext.SuppressFlow()) background = Task.Run(() => Refused(Guid.NewGuid()));
            check(await background && fake.Calls.Count == before,
                "context-free background pool maintenance cannot fetch another account's token or seed its authentication cache");
        }
        check(!EntraConnectScope.Authorized && EntraConnectScope.ExpectedPrincipal is null && EntraConnectScope.Token == CancellationToken.None,
            "authorization and request budgets do not escape their explicit authentication scopes");
    }

    private static async Task LaterOpensAsync(Action<bool, string> check, string expected)
    {
        using var sql = new SqlService();
        var source = sql.Entra.Source;
        var actual = Jwt(Claims());
        try
        {
            sql.Entra.Source = new EntraChecks.FakeSource { Silent = (_, _) => Task.FromResult<EntraToken?>(new(actual, DateTimeOffset.UtcNow.AddHours(1), "same-name@contoso.com")) };
            async Task ProviderOpen(SqlConnection _, CancellationToken cancel)
            {
                var id = Guid.NewGuid();
                try { await sql.Entra.Provider.AcquireTokenAsync(Parameters(id, "same-name@contoso.com")); }
                catch (EntraProviderException) { throw EntraChecks.ProviderFailure(id); }
            }
            sql.OpenConnection = ProviderOpen;
            var profile = ServerProfile.Fallback("16.00.1000") with { PrincipalId = expected };
            var settings = "Data Source=sql.contoso.database.windows.net;Authentication=Active Directory Interactive;User ID=same-name@contoso.com;Application Name=" + new string('x', 128);
            var first = sql.Register(settings, profile, "appdb");
            var second = sql.Register(settings, profile, "appdb");
            using var firstPool = ((IExplorerHost)sql).Connection(first, "appdb");
            using var secondPool = ((IExplorerHost)sql).Connection(second, "appdb");
            var firstBuilder = new SqlConnectionStringBuilder(firstPool.ConnectionString);
            var secondBuilder = new SqlConnectionStringBuilder(secondPool.ConnectionString);
            check(firstBuilder.Pooling && secondBuilder.Pooling && firstBuilder.ApplicationName.Length <= 128
                && firstBuilder.ApplicationName.StartsWith("Varia#" + Guid.Parse(first).ToString("N"), StringComparison.Ordinal)
                && secondBuilder.ApplicationName.StartsWith("Varia#" + Guid.Parse(second).ToString("N"), StringComparison.Ordinal)
                && firstBuilder.ApplicationName != secondBuilder.ApplicationName && firstBuilder.ApplicationName.EndsWith(" - Object Explorer", StringComparison.Ordinal)
                && SqlService.OwnSuffixes.All(suffix => suffix.Length <= 40),
                "each Entra target has its own pooled physical sessions, with bounded private prefixes and complete role suffixes even for maximum application names");
            var probes = 0;
            sql.ProbePrincipal = (_, _) => { probes++; return Task.FromResult<string?>("sid:01"); };
            await sql.Open(firstPool, CancellationToken.None);
            check(probes == 0, "Entra later opens use the actual token principal, never a SQL group SID");
            actual = Jwt(Claims(OtherObject));
            using var mismatched = ((IExplorerHost)sql).Connection(first, "appdb");
            RequestException? refused = null;
            try { await sql.Open(mismatched, CancellationToken.None); } catch (RequestException error) { refused = error; }
            check(refused is { Code: "AUTH_IDENTITY" } && mismatched.ConnectionString.Length == 0 && EntraConnectScope.ExpectedPrincipal is null,
                "a later same-name Entra token from another object is refused before caller SQL and disposed, and its scope cannot leak to another request");
            actual = Jwt("{\"preferred_username\":\"same-name@contoso.com\"}");
            using var missing = ((IExplorerHost)sql).Connection(first, "appdb");
            refused = null;
            try { await sql.Open(missing, CancellationToken.None); } catch (RequestException error) { refused = error; }
            check(refused is { Code: "AUTH_IDENTITY" }, "a refreshed Entra token without stable claims cannot borrow its prior account or group identity");

            var sidProfile = ServerProfile.Fallback("16.00.1000") with { PrincipalId = "sid:01" };
            var windows = sql.Register("Data Source=offline;Integrated Security=true;Connect Retry Count=3", sidProfile, "appdb");
            sql.OpenConnection = (_, _) => Task.CompletedTask;
            using var windowsPool = ((IExplorerHost)sql).Connection(windows, "appdb");
            await sql.Open(windowsPool, CancellationToken.None);
            check(probes == 1 && new SqlConnectionStringBuilder(windowsPool.ConnectionString).ConnectRetryCount == 0,
                "Windows/Kerberos pooled opens verify their actual SID before caller SQL and cannot recover under another account during a later command");
            sql.ProbePrincipal = (_, _) => Task.FromResult<string?>("sid:02");
            using var changedWindows = ((IExplorerHost)sql).Connection(windows, "appdb");
            refused = null;
            try { await sql.Open(changedWindows, CancellationToken.None); } catch (RequestException error) { refused = error; }
            check(refused is { Code: "AUTH_IDENTITY" } && changedWindows.ConnectionString.Length == 0,
                "later Windows/Kerberos or recreated SQL login SID changes fail closed and dispose the physical session");
            sql.OpenConnection = ProviderOpen;
            foreach (var create in new Func<SqlConnection>[] {
                () => ((IExplorerHost)sql).Connection(first, "appdb"),
                () => ((IScriptingHost)sql).Connection(first, "appdb"),
                () => ((IObjectSearchHost)sql).Connection(first, "appdb"),
                () => ((ISsisHost)sql).SsisConnection(first, "SSISDB"),
                () => ((ISsisHost)sql).SsisActionConnection(first, "SSISDB"),
                () => ((IActionHost)sql).Connection(first),
                () => ((ILiveHost)sql).PoolConnection(first, "appdb", " - Live")
            })
            {
                using var connection = create();
                check(new SqlConnectionStringBuilder(connection.ConnectionString).ConnectRetryCount == 0,
                    "every native metadata, SMO and action factory disables unguarded authentication recovery for a bound target");
                refused = null;
                try { await sql.Open(connection, CancellationToken.None); } catch (RequestException error) { refused = error; }
                check(refused is { Code: "AUTH_IDENTITY" }, "every native metadata, SMO and action factory preserves its expected principal guard");
            }
            refused = null;
            try
            {
                await sql.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(new QueryArgs(first, Guid.NewGuid().ToString(), "appdb", "SELECT 1;", Guid.NewGuid().ToString(), 10, 15), HostChecks.Json), HostChecks.Json);
            }
            catch (RequestException error) { refused = error; }
            check(refused is { Code: "AUTH_IDENTITY" }, "a stateful query session cannot send even its prologue or user SQL under an unverified account");

            using var reopened = ((IExplorerHost)sql).Connection(windows, "appdb");
            var raise = typeof(DbConnection).GetMethod("OnStateChange", BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new Exception("DbConnection.OnStateChange changed; update the identity reopen fence check.");
            refused = null;
            try { raise.Invoke(reopened, [new StateChangeEventArgs(ConnectionState.Closed, ConnectionState.Open)]); }
            catch (TargetInvocationException error) { refused = error.InnerException as RequestException; }
            check(refused is { Code: "AUTH_IDENTITY" }, "a library reopening an owned connection outside the central identity preflight is fenced before caller SQL");
            var identityError = new RequestException("AUTH_IDENTITY", ConnectionPrincipal.ChangedMessage);
            check(!ExplorerErrors.SignIn(identityError).Retryable && LiveErrors.SignIn("probe", identityError).Terminal
                && ActivityErrors.SignIn(identityError) is { Code: "AUTH_IDENTITY", Retryable: false },
                "identity failures preserve their reason and stop automatic retries across Explorer, live probes and session actions");
        }
        finally { sql.Entra.Source = source; sql.Entra.Attempts.Clear(); }
    }
}
