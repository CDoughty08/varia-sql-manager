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
using Varia.Backend.Protocol;

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
        await WindowsInitialAsync(check);
        await FailedProfileAuthenticationAsync(check);
        await LostBeforePublicationAsync(check);
        await CancelledBeforePublicationAsync(check);
        await LaterOpensAsync(check, expected);
        await RegistryLifetimeAsync(check);
        await PlanOwnershipAsync(check);
        await ConnectionBindingChecks.RunAsync(check);
    }

    private static void RaiseOpen(SqlConnection connection)
    {
        var raise = typeof(DbConnection).GetMethod("OnStateChange", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new Exception("DbConnection.OnStateChange changed; update the native ownership regression.");
        raise.Invoke(connection, [new StateChangeEventArgs(ConnectionState.Closed, ConnectionState.Open)]);
    }

    private static async Task WindowsInitialAsync(Action<bool, string> check)
    {
        var auth = new EntraService(new EntraChecks.FakeSource());
        foreach (var pooling in new[] { true, false })
        {
            var requested = new SqlConnectionStringBuilder { DataSource = "offline", IntegratedSecurity = true, Pooling = pooling };
            var (opened, kept, principal) = await auth.OpenForUserAsync(requested.ConnectionString, "offline",
                (text, _) => Task.FromResult(new SqlConnectionStringBuilder(text)), _ => Guid.Empty, CancellationToken.None);
            check(!opened.Pooling && new SqlConnectionStringBuilder(kept).Pooling == pooling && principal is null,
                "initial Windows/Kerberos authentication always opens a fresh physical session while retaining the requested later pooling preference");
            using var sql = new SqlService();
            var id = sql.Register(kept, ServerProfile.Fallback("16.00.1000") with { PrincipalId = "sid:01" }, "master");
            var create = typeof(SqlService).GetMethod("CreateConnection", BindingFlags.Instance | BindingFlags.NonPublic)
                ?? throw new Exception("SqlService's plain connection factory changed; update the retained Windows pooling regression.");
            using var owned = (SqlConnection)create.Invoke(sql, [id, "master", false])!;
            check(new SqlConnectionStringBuilder(owned.ConnectionString).Pooling == pooling,
                "a later SID-guarded Windows connection keeps the requested pool preference after fresh account discovery");
        }
        var sqlText = SqlService.ConnectBuilder(new("offline", "master", "sql", "reader", "password-marker", true)).ConnectionString;
        var (physical, retained, _) = await auth.OpenForUserAsync(sqlText, "offline", (text, _) => Task.FromResult(text), _ => Guid.Empty, CancellationToken.None);
        check(physical == sqlText && retained == sqlText,
            "SQL authentication opens the exact connection string registered for pool cleanup without incidental reserialization");
        using var service = new SqlService();
        var attempts = new List<SqlConnectionStringBuilder>();
        service.OpenUser = (text, _, _) => { attempts.Add(new(text)); throw new InvalidOperationException("fresh-windows-open"); };
        var options = new ConnectOptions("offline", "master", "windows", null, null, true);
        foreach (var request in new Func<Task>[] { async () => { await service.ConnectAsync(options, CancellationToken.None); }, async () => { await service.DiscoverDatabasesAsync(options, CancellationToken.None); } })
            try { await request(); } catch (InvalidOperationException error) when (error.Message == "fresh-windows-open") { }
        check(attempts.Count == 2 && attempts.All(attempt => attempt.IntegratedSecurity && !attempt.Pooling),
            "real Connect and Load Databases entry points cannot reuse a prior Kerberos account's pooled authentication");
    }

    private static async Task FailedProfileAuthenticationAsync(Action<bool, string> check)
    {
        var permission = ConnectionFailureChecks.Sql(229, 1, 14, "offline", "Metadata permission denied.");
        check(ServerProfile.CanFallback(permission, ConnectionState.Open) && !ServerProfile.CanFallback(permission, ConnectionState.Closed)
            && !ServerProfile.CanFallback(ConnectionFailureChecks.Sql(233, 1, 20, "offline", "Transport closed."), ConnectionState.Open),
            "optional metadata permission failures may fall back only on an open nonfatal session, including managed-SNI errors before State updates");
        foreach (var number in new[] { 18456, 18486, 18487, 18488, 18452 })
            check(!ServerProfile.CanFallback(ConnectionFailureChecks.Sql(number, 1, 14, "offline", "Sign-in failed."), ConnectionState.Open),
                "an authentication failure cannot be swallowed as optional metadata while State still appears open");
        check(!ServerProfile.CanFallback(ConnectionFailureChecks.Sql(229, 18456), ConnectionState.Open),
            "an authentication error after an optional metadata error still prevents fallback");
        using var sql = new SqlService();
        SqlConnection? rejected = null;
        sql.OpenUser = (text, _, _) => Task.FromResult(rejected = new SqlConnection(text));
        sql.ProbeProfile = (_, _) => throw ConnectionFailureChecks.Sql(18456, 8, 14, "offline", "Login failed.");
        RequestException? failed = null;
        try { await sql.ConnectAsync(new("offline", "master", "sql", "reader", "typed-password-marker", true), CancellationToken.None); }
        catch (RequestException error) { failed = error; }
        check(failed is { Code: "SQL_ERROR", Details: { Number: 18456, State: 8, Class: 14 } } && rejected?.ConnectionString.Length == 0,
            "a pooled authentication failure during profile probing preserves Connect's SQL details and disposes the unregistered physical connection");
    }

    private static async Task LostBeforePublicationAsync(Action<bool, string> check)
    {
        using var sql = new SqlService();
        sql.OpenUser = (text, _, _) => Task.FromResult(new SqlConnection(text));
        sql.ProbeProfile = (connection, _) =>
        {
            // The identity read completed, then the physical session ended before Connect read its remaining properties.
            connection.Dispose();
            return Task.FromResult(ServerProfile.Fallback("16.00.1000") with { PrincipalId = "sid:01" });
        };
        RequestException? failed = null;
        try { await sql.ConnectAsync(new("offline", "master", "sql", "reader", "typed-password-marker", true), CancellationToken.None); }
        catch (RequestException error) { failed = error; }
        static bool Empty(object value) => (int)value.GetType().GetProperty("Count")!.GetValue(value)! == 0;
        var flags = BindingFlags.Instance | BindingFlags.NonPublic;
        var registrations = new[] { "connections", "profiles", "pools", "homes", "bindingRevisions" }
            .All(name => Empty(typeof(SqlService).GetField(name, flags)!.GetValue(sql)!));
        var ledgers = new[] { sql.OwnSessions, sql.PoolSessionLedger }
            .All(ledger => Empty(typeof(OwnSessionLedger).GetField("held", flags)!.GetValue(ledger)!));
        check(failed is { Code: "CONNECTION_LOST" } && registrations && ledgers,
            "a session lost after verified identity but before publication leaves no target, profile, pools, home, revision or session-ledger registration");
    }

    private static async Task CancelledBeforePublicationAsync(Action<bool, string> check)
    {
        using var sql = new SqlService();
        using var stop = new CancellationTokenSource();
        sql.OpenUser = (text, _, _) => Task.FromResult(new SqlConnection(text));
        sql.ProbeProfile = (_, _) => { stop.Cancel(); return Task.FromResult(ServerProfile.Fallback("16.0.1000") with { PrincipalId = "sid:01" }); };
        var cancelled = false;
        try { await sql.ConnectAsync(new("offline", "master", "sql", "reader", "password-marker", true), stop.Token); }
        catch (OperationCanceledException) { cancelled = true; }
        check(cancelled && RegistryCount(sql, "connections") == 0 && RegistryCount(sql, "profiles") == 0,
            "cancellation after authenticated proof is checked before a target can be registered");
    }

    private static int RegistryCount(SqlService sql, string name)
    {
        var value = typeof(SqlService).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(sql)!;
        return (int)value.GetType().GetProperty("Count")!.GetValue(value)!;
    }

    private sealed class HeldConnectionReceipt(SqlService service, bool oversized) : IRequestDispatcher
    {
        internal TaskCompletionSource<ConnectionInfo> Created { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        internal TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public IReadOnlyList<string> Methods => service.Methods;
        public RequestLane LaneOf(string method) => service.LaneOf(method);
        public bool AnswersStop(string method) => service.AnswersStop(method);
        public bool Sensitive(string method) => service.Sensitive(method);
        public (long GlobalBytes, long QueryBytes) ResultBudget => service.ResultBudget;
        public async Task<object> DispatchAsync(string method, JsonElement parameters, JsonSerializerOptions json, RequestContext? context)
        {
            var result = await service.DispatchAsync(method, parameters, json, context);
            if (method != "connections.connect") return result;
            Created.TrySetResult((ConnectionInfo)result);
            await Release.Task;
            return oversized ? new string('x', 2048) : result;
        }
        public void CancelAll() => service.CancelAll();
        public void DrainCommitted() => service.DrainCommitted();
        public void Dispose() => service.Dispose();
    }

    internal static async Task ReceiptLiveAsync(Action<bool, string> check, ConnectOptions options)
    {
        foreach (var oversized in new[] { false, true })
        {
            using var sql = new SqlService();
            var accepted = await sql.ConnectAsync(options, CancellationToken.None);
            var receipt = new HeldConnectionReceipt(sql, oversized);
            using var host = new HostHarness(dispatcher: () => receipt);
            host.Send(FrameKind.Hello, 0, 0, JsonBridge.Encode(new { Versions = new[] { 2, 2 }, Generation = 3, MaxFrameBytes = 1024, App = "checks" }, HostChecks.Json));
            _ = host.Next(FrameKind.Hello);
            host.Request(1, "connections.connect", options);
            try
            {
                var pending = await receipt.Created.Task.WaitAsync(TimeSpan.FromSeconds(15));
                check(pending.Id != accepted.Id && RegistryCount(sql, "connections") == 2, "the wire regression holds an actual successful new Connect beside an accepted target before delivery");
                Frame? answer = null;
                if (!oversized)
                {
                    host.Send(FrameKind.Cancel, 1, 1, []);
                    answer = host.Next(FrameKind.Response);
                }
                receipt.Release.TrySetResult();
                answer ??= host.Next(FrameKind.Response);
                var settled = await Task.Run(() => SpinWait.SpinUntil(() => host.Host.InFlight == 0, 15000));
                var code = answer is { } frame ? JsonBridge.ParseControl(frame.Body).GetProperty("error").GetProperty("code").GetString() : null;
                check(code == (oversized ? "RESPONSE_TOO_LARGE" : "CANCELLED") && settled
                    && new[] { "connections", "profiles", "pools", "homes", "bindingRevisions" }.All(name => RegistryCount(sql, name) == 1),
                    "a " + (oversized ? "serialized-unsent" : "cancelled-late-success") + " Connect receipt removes its exact unpublished target and all registration maps");
                using var retained = ((IExplorerHost)sql).Connection(accepted.Id, options.Database);
                await sql.Open(retained, CancellationToken.None);
                using var command = new SqlCommand("SELECT 731;", retained);
                check(Convert.ToInt32(await command.ExecuteScalarAsync()) == 731, "discarding an unpublished Connect leaves the accepted target usable");
            }
            finally { receipt.Release.TrySetResult(); }
        }
    }

    private static async Task RegistryLifetimeAsync(Action<bool, string> check)
    {
        using var sql = new SqlService();
        var target = sql.Register("Data Source=offline;Integrated Security=true", ServerProfile.Fallback("16.00.1000") with { PrincipalId = "sid:01" }, "master");
        using var existing = ((IExplorerHost)sql).Connection(target, "master");
        using var captured = new SqlConnection(existing.ConnectionString);
        var own = typeof(SqlService).GetMethod("Owned", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new Exception("SqlService's owner registration changed; update the deferred factory regression.");
        RequestException? Register(SqlConnection connection, string id)
        {
            try { own.Invoke(sql, [connection, id, true]); return null; }
            catch (TargetInvocationException error) { return error.InnerException as RequestException; }
        }
        await sql.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(target), HostChecks.Json), HostChecks.Json);
        check(Register(captured, target) is { Code: "NOT_CONNECTED" } && Register(existing, target) is { Code: "NOT_CONNECTED" },
            "a factory delayed after its settings snapshot and an existing owner's promotion both refuse after the target disconnected");
        var opens = 0;
        sql.OpenConnection = (_, _) => { opens++; return Task.CompletedTask; };
        RequestException? refused = null;
        try { await sql.Open(existing, CancellationToken.None); } catch (RequestException error) { refused = error; }
        check(refused is { Code: "NOT_CONNECTED" } && opens == 0, "a previously guarded factory cannot authenticate after its logical target was removed");

        var missing = sql.Register("Data Source=offline;Integrated Security=true", ServerProfile.Fallback("16.00.1000") with { PrincipalId = "sid:01" }, "master");
        var registry = typeof(SqlService).GetField("profiles", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new Exception("SqlService's profile registry changed; update the missing-profile regression.");
        ((IDictionary<string, ServerProfile>)registry.GetValue(sql)!).Remove(missing);
        check(Register(captured, missing) is { Code: "NOT_CONNECTED" }, "settings without a registered profile cannot create an identity-free connection owner");

        var fixture = sql.Register("Data Source=offline;Integrated Security=true", ServerProfile.Fallback("16.00.1000"), "master");
        using var permitted = ((IExplorerHost)sql).Connection(fixture, "master");
        await sql.Open(permitted, CancellationToken.None);
        check(opens == 1, "an explicitly registered identity-free offline profile remains available to the existing test seams");
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
            refused = null;
            try { await sql.Open(reopened, CancellationToken.None); } catch (RequestException error) { refused = error; }
            await sql.RejectedOpenCleanupAsync(reopened);
            check(refused is { Code: "AUTH_IDENTITY" } && reopened.ConnectionString.Length == 0,
                "a rejected connection is permanently fenced against later guarded reuse and its deferred cleanup completes");
            var identityError = new RequestException("AUTH_IDENTITY", ConnectionPrincipal.ChangedMessage);
            check(!ExplorerErrors.SignIn(identityError).Retryable && LiveErrors.SignIn("probe", identityError).Terminal
                && ActivityErrors.SignIn(identityError) is { Code: "AUTH_IDENTITY", Retryable: false },
                "identity failures preserve their reason and stop automatic retries across Explorer, live probes and session actions");
        }
        finally { sql.Entra.Source = source; sql.Entra.Attempts.Clear(); }
    }

    /// <summary>Uses the real SqlClient callback and diagnostic observer: unlike the offline raised event, an asynchronous
    /// Open is still pending while StateChange runs. Both native API paths must refuse and clean up without sending SQL.</summary>
    internal static async Task LiveAsync(Action<bool, string> check, SqlService service, ConnectionInfo info)
    {
        var cleanup = service.CloseRejectedConnection;
        try
        {
            foreach (var asynchronous in new[] { true, false })
            {
                var connection = ((IExplorerHost)service).Connection(info.Id, "master");
                SqlConnection.ClearPool(connection);
                var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                service.CloseRejectedConnection = async refused => { await release.Task; refused.Dispose(); };
                var opening = asynchronous ? connection.OpenAsync() : Task.Run(connection.Open);
                try
                {
                    RequestException? rejected = null;
                    try { await opening.WaitAsync(TimeSpan.FromSeconds(15)); } catch (RequestException error) { rejected = error; }
                    check(rejected is { Code: "AUTH_IDENTITY" }, "an unapproved real " + (asynchronous ? "OpenAsync" : "Open") + " refuses without waiting for its own completion");
                    if (!asynchronous) check(connection.State == ConnectionState.Open, "the held synchronous cleanup exercises the command fence while its rejected physical session is still open");
                    foreach (var api in new[] { "scalar", "nonquery", "reader" })
                    {
                        await using var command = new SqlCommand("SELECT 731;", connection);
                        rejected = null;
                        try
                        {
                            if (api == "scalar") { if (asynchronous) await command.ExecuteScalarAsync(); else command.ExecuteScalar(); }
                            else if (api == "nonquery") { if (asynchronous) await command.ExecuteNonQueryAsync(); else command.ExecuteNonQuery(); }
                            else { using var reader = asynchronous ? await command.ExecuteReaderAsync() : command.ExecuteReader(); }
                        }
                        catch (RequestException error) { rejected = error; }
                        check(rejected is { Code: "AUTH_IDENTITY" }, "catching a refused open cannot send a " + (asynchronous ? "asynchronous " : "synchronous ") + api + " SQL command before cleanup");
                    }
                    if (!asynchronous)
                    {
                        var context = new Microsoft.SqlServer.Management.Common.ServerConnection(connection);
                        var stopped = false;
                        try { context.ExecuteScalar("SELECT 731;"); }
                        catch (Exception error) { stopped = error.GetBaseException() is RequestException { Code: "AUTH_IDENTITY" }; }
                        check(stopped, "SMO cannot bypass the refused-open command fence when it wraps the SqlClient error");
                    }
                    rejected = null;
                    try { await service.Open(connection, CancellationToken.None); } catch (RequestException error) { rejected = error; }
                    check(rejected is { Code: "AUTH_IDENTITY" }, "a refused real connection cannot be admitted through guarded Open later");
                }
                finally
                {
                    release.TrySetResult();
                    if (opening.IsCompleted)
                    {
                        await service.RejectedOpenCleanupAsync(connection).WaitAsync(TimeSpan.FromSeconds(15));
                        check(connection.State == ConnectionState.Closed && connection.ConnectionString.Length == 0, "refused real-open cleanup disposes the physical connection after its callback unwinds");
                        connection.Dispose();
                    }
                    else
                        _ = opening.ContinueWith(static (task, state) => { _ = task.Exception; ((SqlConnection)state!).Dispose(); }, connection,
                            CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
                }
            }
        }
        finally { service.CloseRejectedConnection = cleanup; }
    }
}
