using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using System.Text.Json;
using Azure.Identity;
using Microsoft.Data.SqlClient;
using Microsoft.Identity.Client;
using Varia.Backend.Entra;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of Microsoft Entra ID: connection strings per type, the provider SqlClient calls (through a fake
/// token source: no tenant is reachable here), the sign-in the Connect dialog runs and its Stop, the sign-in address
/// allowlist, the failure messages, and the cache clear. Live Entra checks need a tenant and run only on request
/// (VARIA_TEST_ENTRA_*; see EntraLiveChecks).</summary>
internal static class EntraChecks
{
    private const string Authority = "https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47";
    private const string Resource = "https://database.windows.net/";

    /// <summary>A fake MSAL and Azure.Identity: each call is recorded, and each kind answers as the check says.</summary>
    internal sealed class FakeSource : IEntraTokenSource
    {
        public readonly List<(string Kind, EntraRequest Request, string? Secret)> Calls = [];
        public Func<EntraRequest, CancellationToken, Task<EntraToken?>> Silent = (_, _) => Task.FromResult<EntraToken?>(null);
        public Func<EntraRequest, CancellationToken, Task<EntraToken>> Interactive = (_, _) => Task.FromResult(Token("interactive"));
        public Func<string, EntraRequest, CancellationToken, Task<EntraToken>> Other = (kind, _, _) => Task.FromResult(Token(kind));
        public int Cleared;
        public readonly List<CancellationToken> InteractiveTokens = [];

        private void Record(string kind, EntraRequest request, string? secret) { lock (Calls) Calls.Add((kind, request, secret)); }
        public int Count(string kind) { lock (Calls) return Calls.Count(call => call.Kind == kind); }
        public Task<EntraToken?> SilentAsync(EntraRequest request, CancellationToken token) { Record("silent", request, null); return Silent(request, token); }
        public Task<EntraToken> InteractiveAsync(EntraRequest request, CancellationToken token) { Record("interactive", request, null); lock (Calls) InteractiveTokens.Add(token); return Interactive(request, token); }
        public Task<EntraToken> PasswordAsync(EntraRequest request, string password, CancellationToken token) { Record("password", request, password); return Other("password", request, token); }
        public Task<EntraToken> IntegratedAsync(EntraRequest request, CancellationToken token) { Record("integrated", request, null); return Other("integrated", request, token); }
        public Task<EntraToken> ServicePrincipalAsync(EntraRequest request, string secret, CancellationToken token) { Record("servicePrincipal", request, secret); return Other("servicePrincipal", request, token); }
        public Task<EntraToken> ManagedIdentityAsync(EntraRequest request, CancellationToken token) { Record("managedIdentity", request, null); return Other("managedIdentity", request, token); }
        public Task<EntraToken> DefaultAsync(EntraRequest request, CancellationToken token) { Record("default", request, null); return Other("default", request, token); }
        public void Clear() => Cleared++;
    }

    internal static EntraToken Token(string marker, string? account = null) => new("fake-access-" + marker, new DateTimeOffset(2030, 1, 2, 3, 4, 5, TimeSpan.Zero), account);

    /// <summary>The SqlException SqlClient builds from a provider's exception: no inner exception, and the attempt's
    /// ClientConnectionId (ADP.CreateSqlException). Built by reflection; a SqlClient upgrade that changes it fails here.</summary>
    internal static SqlException ProviderFailure(Guid connectionId, string message = "Failed to authenticate the user  in Active Directory (Authentication=ActiveDirectoryInteractive).")
    {
        var template = ConnectionFailureChecks.Sql(0, 0, 11, "sql.contoso.database.windows.net", message);
        var errors = template.Errors;
        var create = typeof(SqlException).GetMethod("CreateException", BindingFlags.NonPublic | BindingFlags.Static, [typeof(SqlErrorCollection), typeof(string), typeof(Guid), typeof(Exception)])
            ?? throw new Exception("SqlException.CreateException(errors, version, conId, inner) changed; update EntraChecks.ProviderFailure");
        return (SqlException)create.Invoke(null, [errors, "", connectionId, null])!;
    }

    /// <summary>The ClientConnectionId of a fake open's result: none.</summary>
    private static Guid NoId<T>(T _) => Guid.Empty;

    private static SqlAuthenticationParameters Parameters(SqlAuthenticationMethod method, Guid connectionId, string? user = null, string? password = null, string authority = Authority, string resource = Resource, int timeout = 15) =>
        new(method, "sql.contoso.database.windows.net", "appdb", resource, authority, user, password, connectionId, timeout);

    public static async Task RunAsync(Action<bool, string> check)
    {
        ConnectionStrings(check);
        Registration(check);
        Allowlist(check);
        Failures(check);
        Attempts(check);
        var service = EntraService.Shared;
        var original = service.Source;
        var limit = service.SignInLimit;
        var windows = service.IsWindows;
        try
        {
            await ProviderAsync(check, service);
            await SignInAsync(check, service);
            await AccountsAsync(check, service);
            await ServiceAsync(check);
            await SilentAsync(check, service);
        }
        finally
        {
            service.Source = original;
            service.SignInLimit = limit;
            service.IsWindows = windows;
            service.Attempts.Clear();
        }
        await AbandonAsync(check);
        await BrowserAsync(check);
        await RealSourceAsync(check);
        await ManagedIdentityAsync(check);
    }

    private static ConnectOptions Options(string authentication, string? user = null, string? password = null) =>
        new("sql.contoso.database.windows.net", "appdb", authentication, user, password, false);

    private static void ConnectionStrings(Action<bool, string> check)
    {
        var mfa = ConnectionSettings.Build(Options("entraMfa", "alice@contoso.com", "never-sent-marker"));
        check(mfa.Authentication == SqlAuthenticationMethod.ActiveDirectoryInteractive && !mfa.IntegratedSecurity && mfa.UserID == "alice@contoso.com" && mfa.Password == ""
            && !mfa.ConnectionString.Contains("never-sent-marker"), "Entra MFA carries SqlClient's Interactive keyword and the user name, never a password sent with it");
        var anonymous = ConnectionSettings.Build(Options("entraMfa", "  "));
        check(anonymous.UserID == "" && !anonymous.ConnectionString.Contains("User ID", StringComparison.OrdinalIgnoreCase), "Entra MFA without a user name leaves User ID out (the browser's account picker)");
#pragma warning disable CS0618 // ActiveDirectoryPassword: see EntraModes.
        var password = ConnectionSettings.Build(Options("entraPassword", "alice@contoso.com", "pw-marker"));
        check(password.Authentication == SqlAuthenticationMethod.ActiveDirectoryPassword && password.UserID == "alice@contoso.com" && password.Password == "pw-marker", "Entra Password sends the user name and password");
#pragma warning restore CS0618
        var integrated = ConnectionSettings.Build(Options("entraIntegrated", "ignored", "ignored-marker"));
        check(integrated.Authentication == SqlAuthenticationMethod.ActiveDirectoryIntegrated && integrated.UserID == "" && integrated.Password == "" && !integrated.IntegratedSecurity,
            "Entra Integrated sends neither a user name nor a password");
        var principal = ConnectionSettings.Build(Options("entraServicePrincipal", "11111111-2222-3333-4444-555555555555", "secret-marker"));
        check(principal.Authentication == SqlAuthenticationMethod.ActiveDirectoryServicePrincipal && principal.UserID == "11111111-2222-3333-4444-555555555555" && principal.Password == "secret-marker",
            "Entra Service Principal sends the client ID as User ID and the secret as Password");
        var managed = ConnectionSettings.Build(Options("entraManagedIdentity", "client-id", "x"));
        var system = ConnectionSettings.Build(Options("entraManagedIdentity"));
        check(managed.Authentication == SqlAuthenticationMethod.ActiveDirectoryManagedIdentity && managed.UserID == "client-id" && managed.Password == "" && system.UserID == "",
            "Entra Managed Identity names a user-assigned identity by its client ID, or none for the system-assigned one");
        var chain = ConnectionSettings.Build(Options("entraDefault"));
        check(chain.Authentication == SqlAuthenticationMethod.ActiveDirectoryDefault && chain.UserID == "" && chain.Password == "", "Entra Default sends no credentials");
        string Refused(ConnectOptions options)
        {
            try { ConnectionSettings.Build(options); return "built"; }
            catch (RequestException error) { return error.Code + ": " + error.Message; }
        }
        check(Refused(Options("entraServicePrincipal", "client-id", "")) == "INVALID_PARAMS: Microsoft Entra Service Principal requires the client secret in Password."
            && Refused(Options("entraServicePrincipal", " ", "secret")).StartsWith("INVALID_PARAMS: Microsoft Entra Service Principal requires the application (client) ID", StringComparison.Ordinal)
            && Refused(Options("entraPassword", "alice", "")) == "INVALID_PARAMS: Microsoft Entra Password requires a password."
            && Refused(Options("entraPassword", "", "pw")) == "INVALID_PARAMS: Microsoft Entra Password requires a user name."
            && Refused(Options("entraDeviceCode", "alice")) == "INVALID_PARAMS: Unsupported authentication mode."
            && Refused(Options("entraMfa", new string('u', 129))).StartsWith("INVALID_PARAMS", StringComparison.Ordinal)
            && Refused(Options("entraPassword", "alice", new string('p', 1025))).StartsWith("INVALID_PARAMS", StringComparison.Ordinal),
            "Entra types refuse a missing secret or user name, device code flow, and over-long fields");
        var preview = JsonSerializer.Serialize(ConnectionSettings.Preview(Options("entraServicePrincipal", "client-id", "secret-marker")));
        var mfaPreview = JsonSerializer.Serialize(ConnectionSettings.Preview(Options("entraMfa", "alice@contoso.com")));
        var remembered = JsonSerializer.Serialize(ConnectionSettings.Preview(Options("entraPassword", "alice@contoso.com", "")));
        check(!preview.Contains("secret-marker") && preview.Contains("not included") && preview.Contains("Authentication=ActiveDirectoryServicePrincipal")
            && mfaPreview.Contains("Authentication=ActiveDirectoryInteractive") && !mfaPreview.Contains("Password", StringComparison.OrdinalIgnoreCase)
            && remembered.Contains("not included"),
            "the preview shows SqlClient's Authentication keyword, and <not included> for the secret of every type that takes one, typed or not: " + preview + remembered);
    }

    private static void Registration(Action<bool, string> check)
    {
        _ = EntraService.Shared;
        check(EntraModes.Methods.All(method => SqlAuthenticationProvider.GetProvider(method) is EntraAuthenticationProvider) && EntraModes.Methods.Length == 7,
            "Varia's provider serves SqlClient's seven Entra methods, so no SqlClient Azure extension (and its forced WAM) is used");
        check(SqlAuthenticationProvider.GetProvider(SqlAuthenticationMethod.ActiveDirectoryDeviceCodeFlow) is not EntraAuthenticationProvider
            && SqlAuthenticationProvider.GetProvider(SqlAuthenticationMethod.ActiveDirectoryWorkloadIdentity) is not EntraAuthenticationProvider,
            "device code flow and workload identity, which SSMS does not offer, get no provider");
        check(EntraModes.Known.Length == 8 && EntraModes.Known.All(mode => EntraModes.IsKnown(mode)) && !EntraModes.IsKnown("entraDeviceCode")
            && EntraModes.Known.Count(EntraModes.IsEntra) == 6 && !EntraModes.IsEntra("windows") && !EntraModes.IsEntra("sql"), "eight authentication types, six of them Entra");
    }

    private static void Allowlist(Action<bool, string> check)
    {
        check(EntraEndpoints.TryParseAuthority(Authority, out var host, out var tenant) && host.AbsoluteUri == "https://login.microsoftonline.com/" && tenant == "72f988bf-86f1-41af-91ab-2d7cd011db47",
            "the authority's host and its tenant, the first path segment");
        check(EntraEndpoints.TryParseAuthority("https://LOGIN.windows.net/contoso.onmicrosoft.com/oauth2/authorize", out host, out tenant) && host.AbsoluteUri == "https://login.windows.net/" && tenant == "contoso.onmicrosoft.com",
            "an ADAL-style authority gives the first segment as the tenant, in any case");
        check(new[] { "https://login.microsoftonline.us/t", "https://login.chinacloudapi.cn/t", "https://login.partner.microsoftonline.cn/t" }.All(value => EntraEndpoints.TryParseAuthority(value, out _, out _)),
            "the US Government and China clouds' sign-in addresses are allowed");
        check(!new[] { "http://login.microsoftonline.com/t", "https://login.microsoftonline.com.evil.example/t", "https://evil.example/t", "https://login.microsoftonline.com:8443/t",
            "https://user@login.microsoftonline.com/t", "https://login.microsoftonline.com/", "https://login.microsoftonline.com/te%20nant", "not a url", "" }.Any(value => EntraEndpoints.TryParseAuthority(value, out _, out _)),
            "http, other hosts, other ports, user info and a missing or odd tenant are refused");
        check(EntraEndpoints.IsAllowedResource("https://database.windows.net/") && EntraEndpoints.IsAllowedResource("https://DATABASE.windows.net") && EntraEndpoints.IsAllowedResource("https://database.windows.net//.default")
            && EntraEndpoints.IsAllowedResource("https://database.usgovcloudapi.net/") && EntraEndpoints.IsAllowedResource("https://database.fabric.microsoft.com/")
            && !EntraEndpoints.IsAllowedResource("https://management.azure.com/") && !EntraEndpoints.IsAllowedResource("https://graph.microsoft.com/.default") && !EntraEndpoints.IsAllowedResource(null),
            "only SQL audiences, with or without a trailing slash or /.default");
        check(EntraEndpoints.Scope("https://database.windows.net/") == "https://database.windows.net//.default" && EntraEndpoints.Scope("https://database.windows.net/.default") == "https://database.windows.net/.default",
            "the scope is the resource plus /.default, exactly as SqlClient writes it");
    }

    private static void Failures(Action<bool, string> check)
    {
        var interactive = SqlAuthenticationMethod.ActiveDirectoryInteractive;
#pragma warning disable CS0618 // ActiveDirectoryPassword: see EntraModes.
        var password = SqlAuthenticationMethod.ActiveDirectoryPassword;
#pragma warning restore CS0618
        check(EntraFailures.Map(new MsalClientException(MsalError.AuthenticationCanceledError, "User canceled authentication."), interactive) == new EntraFailure("AUTH_ENTRA", EntraFailures.Messages.Cancelled)
            && EntraFailures.Map(new MsalServiceException(MsalError.AccessDenied, "The user denied consent."), interactive).Message == EntraFailures.Messages.Cancelled,
            "a sign-in cancelled or denied in the browser says so");
        check(MsalError.LinuxXdgOpen == "linux_xdg_open_failed" && EntraFailures.Map(new MsalClientException(MsalError.LinuxXdgOpen, "xdg-open failed"), interactive).Message == EntraFailures.Messages.BrowserFailed,
            "a browser that could not be opened (xdg-open on Linux) says to set a default browser");
        var badPassword = EntraFailures.Map(new MsalServiceException("invalid_grant", "AADSTS50126: Error validating credentials due to invalid username or password."), password);
        var badSecret = EntraFailures.Map(new AuthenticationFailedException("ClientSecretCredential authentication failed", new MsalServiceException("invalid_client", "AADSTS7000215: Invalid client secret provided.")),
            SqlAuthenticationMethod.ActiveDirectoryServicePrincipal);
        check(badPassword == new EntraFailure("AUTH_ENTRA", EntraFailures.Messages.BadPassword, 50126) && badSecret == new EntraFailure("AUTH_ENTRA", EntraFailures.Messages.BadSecret, 7000215),
            "AADSTS50126 and 7000215 name the rejected password or client secret and carry their numbers, so main forgets a remembered one");
        check(EntraFailures.Map(new MsalUiRequiredException("invalid_grant", "AADSTS50076: Due to a configuration change made by your administrator, you must use multi-factor authentication."), password).Message == EntraFailures.Messages.MfaRequired
            && EntraFailures.Map(new MsalUiRequiredException("invalid_grant", "AADSTS50076: multi-factor"), interactive).Explained == false,
            "multifactor required under Entra Password says to use Entra MFA");
        check(EntraFailures.Map(new MsalServiceException(MsalError.ManagedIdentityUnreachableNetwork, "No managed identity endpoint."), SqlAuthenticationMethod.ActiveDirectoryManagedIdentity).Message == EntraFailures.Messages.NoManagedIdentity
            && EntraFailures.Map(new MsalServiceException(MsalError.ManagedIdentityUnreachableNetwork, "No managed identity endpoint."), interactive).Explained == false,
            "MSAL's managed identity client finding no endpoint says Managed Identity needs an Azure host");
        check(EntraFailures.Map(new CredentialUnavailableException("ManagedIdentityCredential authentication unavailable."), SqlAuthenticationMethod.ActiveDirectoryManagedIdentity).Message == EntraFailures.Messages.NoManagedIdentity
            && EntraFailures.Map(new CredentialUnavailableException("ManagedIdentityCredential authentication unavailable."), SqlAuthenticationMethod.ActiveDirectoryMSI).Message == EntraFailures.Messages.NoManagedIdentity
            && EntraFailures.Map(new CredentialUnavailableException("DefaultAzureCredential failed to retrieve a token."), SqlAuthenticationMethod.ActiveDirectoryDefault).Message == EntraFailures.Messages.DefaultNoIdentity,
            "no managed identity, and no identity for Entra Default's chain, say what to do");
        var jwt = "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJhdWQiOiJodHRwczovL2RhdGFiYXNlLndpbmRvd3MubmV0LyJ9.c2lnbmF0dXJl";
        var other = EntraFailures.Map(new MsalServiceException("invalid_request", "AADSTS90002: Tenant not found. token=" + jwt + "\r\nline two\u0007" + new string('x', 5000)), interactive);
        check(!other.Explained && other.Message.StartsWith("AADSTS90002: Tenant not found. token=<token> line two", StringComparison.Ordinal) && !other.Message.Contains("eyJ") && other.Message.Length <= EntraFailures.MaxMessage
            && !other.Message.Any(char.IsControl) && other.Number is null,
            "any other failure shows MSAL's own text (its AADSTS code and description), one line, at most 2,000 characters, with tokens redacted");
        check(EntraFailures.Sanitize("half eyJhbGciOiJIUzI1NiJ9.eyJzdWIi") == "half <token>", "a token cut short is redacted too");
        var sql = ConnectionFailureChecks.Sql(18456, 1, 14, "sql.contoso.database.windows.net", "Login failed for user '<token-identified principal>'.");
        var failure = new RequestException("SQL_ERROR", sql.Message, new(18456, 1, 14, "sql.contoso.database.windows.net"));
        check(EntraFailures.WithClearHint(failure, "entraMfa").Message == sql.Message + EntraFailures.Messages.ClearCacheHint && EntraFailures.WithClearHint(failure, "entraMfa").Details?.Number == 18456
            && ReferenceEquals(EntraFailures.WithClearHint(failure, "sql"), failure) && EntraFailures.WithClearHint(new RequestException("SQL_ERROR", "x", new(53, 0, 20, null)), "entraMfa").Message == "x",
            "Login failed (18456) under Entra points to Help › Clear Entra ID Token Cache; under SQL authentication it is unchanged");
        var described = EntraFailures.Describe(new EntraFailure("AUTH_ENTRA", "AADSTS90002: Tenant not found.", Explained: false), ProviderFailure(Guid.NewGuid(), "Failed to authenticate the user alice in Active Directory (Authentication=ActiveDirectoryInteractive)."), "srv", details: true);
        check(described.Code == "AUTH_ENTRA" && described.Message == "Failed to authenticate the user alice in Active Directory (Authentication=ActiveDirectoryInteractive). AADSTS90002: Tenant not found."
            && described.Details == new ErrorDetails(0, 0, 11, "srv") && EntraFailures.Describe(new InteractionRequired(Request()), null, "srv", details: false) is { Code: "AUTH_ENTRA", Details: null, Message: EntraFailures.Messages.SignInExpired },
            "a failure leads with SqlClient's first line, then MSAL's; details (error 0, class 11, the server) only for the Connect dialog");
        check(!Token("x").ToString().Contains("fake-access"), "a token never prints");
    }

    internal static EntraRequest Request(string? user = null) => new(new Uri("https://login.microsoftonline.com/"), "72f988bf-86f1-41af-91ab-2d7cd011db47", "https://database.windows.net//.default", user);

    private static void Attempts(Action<bool, string> check)
    {
        var attempts = new EntraAttempts();
        long now = 0;
        attempts.Now = () => now;
        var first = Guid.NewGuid();
        attempts.Record(first, new InteractionRequired(Request()));
        attempts.Record(Guid.Empty, new InteractionRequired(Request()));
        check(attempts.Count == 1 && attempts.Take(first) is InteractionRequired && attempts.Take(first) is null, "an attempt is taken once, and one without a connection ID is not kept");
        attempts.Record(first, new InteractionRequired(Request()));
        now += (long)EntraAttempts.Lifetime.TotalMilliseconds + 1;
        check(attempts.Take(first) is null, "an attempt older than 2 minutes is forgotten");
        for (var i = 0; i < EntraAttempts.MaxEntries + 10; i++) { now++; attempts.Record(Guid.NewGuid(), new InteractionRequired(Request())); }
        check(attempts.Count == EntraAttempts.MaxEntries, "at most 256 attempts are kept, the oldest going first");
    }

    private static async Task ProviderAsync(Action<bool, string> check, EntraService service)
    {
        var fake = new FakeSource { Silent = (_, _) => Task.FromResult<EntraToken?>(Token("silent")) };
        service.Source = fake;
        var provider = (EntraAuthenticationProvider)SqlAuthenticationProvider.GetProvider(SqlAuthenticationMethod.ActiveDirectoryInteractive)!;
        var hit = await provider.AcquireTokenAsync(Parameters(SqlAuthenticationMethod.ActiveDirectoryInteractive, Guid.NewGuid(), "alice@contoso.com"));
        check(hit.AccessToken == "fake-access-silent" && hit.ExpiresOn == Token("x").ExpiresOn && fake.Calls.Single() is ("silent", { Tenant: "72f988bf-86f1-41af-91ab-2d7cd011db47", User: "alice@contoso.com" }, null),
            "MFA with a cached token returns it to SqlClient, for the tenant and user the login names");
        fake = new FakeSource();
        service.Source = fake;
        var id = Guid.NewGuid();
        SqlAuthenticationProviderException? thrown = null;
        try { await provider.AcquireTokenAsync(Parameters(SqlAuthenticationMethod.ActiveDirectoryInteractive, id)); }
        catch (SqlAuthenticationProviderException error) { thrown = error; }
        check(thrown is EntraProviderException { ShouldRetry: false } && fake.Count("interactive") == 0 && service.Attempts.Take(id) is InteractionRequired { Request.User: null },
            "MFA without a cached token never opens the browser inside SqlClient's login: it records that a sign-in is needed, under the attempt's connection ID, and fails without a retry");
        id = Guid.NewGuid();
        fake.Calls.Clear();
        await provider.AcquireTokenAsync(Parameters(SqlAuthenticationMethod.ActiveDirectoryServicePrincipal, id, "client-id", "secret-marker"));
        await provider.AcquireTokenAsync(Parameters(SqlAuthenticationMethod.ActiveDirectoryManagedIdentity, id, ""));
        await provider.AcquireTokenAsync(Parameters(SqlAuthenticationMethod.ActiveDirectoryMSI, id, "mi-client"));
        await provider.AcquireTokenAsync(Parameters(SqlAuthenticationMethod.ActiveDirectoryDefault, id));
#pragma warning disable CS0618 // ActiveDirectoryPassword: see EntraModes.
        await provider.AcquireTokenAsync(Parameters(SqlAuthenticationMethod.ActiveDirectoryPassword, id, "alice@contoso.com", "pw-marker"));
#pragma warning restore CS0618
        await provider.AcquireTokenAsync(Parameters(SqlAuthenticationMethod.ActiveDirectoryIntegrated, id));
        check(fake.Calls.Select(call => (call.Kind, call.Request.User, call.Secret)).SequenceEqual([("servicePrincipal", "client-id", "secret-marker"), ("managedIdentity", null, null), ("managedIdentity", "mi-client", null),
            ("default", null, null), ("password", "alice@contoso.com", "pw-marker"), ("integrated", null, null)]) && fake.Count("interactive") == 0,
            "each type goes to its own credential: Service Principal's client ID and secret, a system-assigned identity for a blank Managed Identity, and so on");
        // Refused addresses: the browser never goes there and no token is requested.
        fake = new FakeSource();
        service.Source = fake;
        id = Guid.NewGuid();
        try { await provider.AcquireTokenAsync(Parameters(SqlAuthenticationMethod.ActiveDirectoryInteractive, id, authority: "https://login.evil.example/tenant")); }
        catch (EntraProviderException) { }
        var refused = service.Attempts.Take(id) as EntraFailure;
        id = Guid.NewGuid();
        try { await provider.AcquireTokenAsync(Parameters(SqlAuthenticationMethod.ActiveDirectoryDefault, id, resource: "https://management.azure.com/")); }
        catch (EntraProviderException) { }
        var resource = service.Attempts.Take(id) as EntraFailure;
        check(fake.Calls.Count == 0 && refused?.Message == "The server asked to sign in at login.evil.example, which is not a Microsoft Entra sign-in address. Varia SQL Manager signs in only at Microsoft Entra addresses."
            && resource?.Message == "The server asked for a token for management.azure.com, which is not an Azure SQL resource. Varia SQL Manager requests Microsoft Entra tokens only for Azure SQL.",
            "a server that names another sign-in address or another resource gets nothing, and the user is told why");
        // A credential chain that does not answer is bounded by the connect timeout.
        fake = new FakeSource { Other = async (_, _, token) => { await Task.Delay(Timeout.Infinite, token); return Token("never"); } };
        service.Source = fake;
        id = Guid.NewGuid();
        var watch = Stopwatch.StartNew();
        try { await provider.AcquireTokenAsync(Parameters(SqlAuthenticationMethod.ActiveDirectoryDefault, id, timeout: 1)); }
        catch (EntraProviderException) { }
        check(watch.ElapsedMilliseconds < 5000 && service.Attempts.Take(id) is EntraFailure { Message: EntraFailures.Messages.TokenTimedOut }, "a non-interactive type is bounded by the connect timeout");
        fake = new FakeSource { Other = (_, _, _) => throw new MsalServiceException("invalid_client", "AADSTS7000215: Invalid client secret provided.") };
        service.Source = fake;
        id = Guid.NewGuid();
        try { await provider.AcquireTokenAsync(Parameters(SqlAuthenticationMethod.ActiveDirectoryServicePrincipal, id, "client-id", "wrong")); }
        catch (EntraProviderException error) { check(error.Message == EntraFailures.Messages.BadSecret && !error.ShouldRetry, "a rejected secret fails at once, with its message"); }
        check(service.Attempts.Take(id) is EntraFailure { Number: 7000215 }, "the rejected secret is recorded for the answer");
    }

    private static async Task SignInAsync(Action<bool, string> check, EntraService service)
    {
        // An open that fails as SqlClient does when the provider needed a sign-in, then succeeds once the fake has a token.
        var signedIn = false;
        var opened = new List<string>();
        async Task<string> Open(string connectionString, CancellationToken token)
        {
            lock (opened) opened.Add(connectionString);
            await Task.Yield();
            if (signedIn) return "connection";
            var id = Guid.NewGuid();
            service.Attempts.Record(id, new InteractionRequired(Request()));
            throw ProviderFailure(id);
        }
        var fake = new FakeSource { Interactive = (_, _) => { signedIn = true; return Task.FromResult(Token("interactive", "alice@contoso.com")); } };
        service.Source = fake;
        var start = "Data Source=sql.contoso.database.windows.net;Authentication=\"Active Directory Interactive\"";
        using (var request = new CancellationTokenSource())
        {
            var (connection, connectionString) = await service.OpenForUserAsync(start, "sql.contoso.database.windows.net", Open, NoId, request.Token);
            check(connection == "connection" && fake.Count("interactive") == 1 && fake.Calls.Last().Request == Request() && opened.Count == 2
                && new SqlConnectionStringBuilder(connectionString).UserID == "alice@contoso.com" && opened[1] == connectionString,
                "Connect signs in through the browser once, with the attempt's authority and resource, then opens a new connection, named for the account that signed in");
        }
        // A pool open (Object Explorer, a query session) never signs in.
        signedIn = false;
        fake = new FakeSource();
        service.Source = fake;
        RequestException? pooled = null;
        try
        {
            await service.OpenPooledAsync(new SqlConnection("Data Source=sql.contoso.database.windows.net"), CancellationToken.None, (_, _) =>
            {
                var id = Guid.NewGuid();
                service.Attempts.Record(id, new InteractionRequired(Request()));
                throw ProviderFailure(id);
            });
        }
        catch (RequestException error) { pooled = error; }
        check(pooled is { Code: "AUTH_ENTRA", Message: EntraFailures.Messages.SignInExpired, Details: null } && fake.Count("interactive") == 0,
            "a pool connection that needs a sign-in answers AUTH_ENTRA (connect again) and never opens the browser");
        // Stop while the browser waits: cancelled within a second, and MSAL saw its token cancelled.
        var waiting = new TaskCompletionSource();
        fake = new FakeSource { Interactive = async (_, token) => { waiting.TrySetResult(); await Task.Delay(Timeout.Infinite, token); return Token("never"); } };
        service.Source = fake;
        opened.Clear();
        using (var stop = new CancellationTokenSource())
        {
            var connect = service.OpenForUserAsync(start, "srv", Open, NoId, stop.Token);
            await waiting.Task.WaitAsync(TimeSpan.FromSeconds(5));
            var watch = Stopwatch.StartNew();
            stop.Cancel();
            Exception? stopped = null;
            try { await connect; } catch (Exception error) { stopped = error; }
            check(stopped is OperationCanceledException && watch.ElapsedMilliseconds < 1000 && fake.InteractiveTokens[0].IsCancellationRequested && opened.Count == 1,
                "Stop ends a sign-in waiting for the browser within a second, cancelling MSAL's wait, and nothing is opened again");
        }
        // Two connects at once: one sign-in; the second finds its token.
        var gate = new TaskCompletionSource();
        EntraToken? cached = null;
        fake = new FakeSource
        {
            Silent = (_, _) => Task.FromResult(cached),
            Interactive = async (_, token) => { await gate.Task.WaitAsync(token); cached = Token("shared", "alice@contoso.com"); signedIn = true; return cached; }
        };
        service.Source = fake;
        signedIn = false;
        var first = service.OpenForUserAsync(start, "srv", Open, NoId, CancellationToken.None);
        var second = service.OpenForUserAsync(start, "srv", Open, NoId, CancellationToken.None);
        await Task.Delay(100);
        gate.SetResult();
        await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(5));
        check(fake.Count("interactive") == 1, "two connects that need a sign-in at once open the browser once; the second waits, then uses the token");
        // Stop on one of two waiting connects leaves the other to finish.
        gate = new TaskCompletionSource();
        cached = null;
        signedIn = false;
        fake.Calls.Clear();
        using (var stopFirst = new CancellationTokenSource())
        {
            first = service.OpenForUserAsync(start, "srv", Open, NoId, stopFirst.Token);
            second = service.OpenForUserAsync(start, "srv", Open, NoId, CancellationToken.None);
            await Task.Delay(100);
            stopFirst.Cancel();
            Exception? stopped = null;
            try { await first.WaitAsync(TimeSpan.FromSeconds(5)); } catch (Exception error) { stopped = error; }
            gate.SetResult();
            var (other, _) = await second.WaitAsync(TimeSpan.FromSeconds(5));
            check(stopped is OperationCanceledException && other == "connection", "Stop on one waiting connect leaves the other to sign in and connect");
        }
        // The 3-minute limit (shortened here) answers its own message.
        service.SignInLimit = TimeSpan.FromMilliseconds(200);
        fake = new FakeSource { Interactive = async (_, token) => { await Task.Delay(Timeout.Infinite, token); return Token("never"); } };
        service.Source = fake;
        signedIn = false;
        RequestException? timedOut = null;
        try { await service.OpenForUserAsync(start, "srv", Open, NoId, CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5)); }
        catch (RequestException error) { timedOut = error; }
        check(timedOut is { Code: "AUTH_ENTRA", Message: EntraFailures.Messages.TimedOut } && timedOut.Details?.Server == "srv", "a sign-in that takes longer than its limit says so");
        service.SignInLimit = TimeSpan.FromMinutes(3);
        // A sign-in cancelled in the browser, and a provider failure, are values with the dialog's details.
        fake = new FakeSource { Interactive = (_, _) => throw new MsalClientException(MsalError.AuthenticationCanceledError, "User canceled authentication.") };
        service.Source = fake;
        RequestException? cancelled = null;
        try { await service.OpenForUserAsync(start, "srv", Open, NoId, CancellationToken.None); }
        catch (RequestException error) { cancelled = error; }
        check(cancelled is { Code: "AUTH_ENTRA", Message: EntraFailures.Messages.Cancelled }, "a sign-in cancelled in the browser answers AUTH_ENTRA, not CANCELLED");
        RequestException? rejected = null;
        try
        {
            await service.OpenForUserAsync<string>(start, "srv", (_, _) =>
            {
                var id = Guid.NewGuid();
                service.Attempts.Record(id, new EntraFailure("AUTH_ENTRA", EntraFailures.Messages.BadPassword, EntraFailures.InvalidPassword));
                throw ProviderFailure(id);
            }, NoId, CancellationToken.None);
        }
        catch (RequestException error) { rejected = error; }
        check(rejected is { Code: "AUTH_ENTRA", Message: EntraFailures.Messages.BadPassword } && rejected.Details == new ErrorDetails(50126, 0, 11, "srv"),
            "a rejected password answers AUTH_ENTRA with its AADSTS number in the details, which main's forget rule reads");
        // A token for another account than the user name entered: the retry is not repeated.
        fake = new FakeSource { Interactive = (_, _) => Task.FromResult(Token("other", "bob@contoso.com")) };
        service.Source = fake;
        RequestException? other2 = null;
        try { await service.OpenForUserAsync<string>(start + ";User ID=alice@contoso.com", "srv", (_, _) => { var id = Guid.NewGuid(); service.Attempts.Record(id, new InteractionRequired(Request("alice@contoso.com"))); throw ProviderFailure(id); }, NoId, CancellationToken.None); }
        catch (RequestException error) { other2 = error; }
        check(other2?.Message == EntraFailures.Messages.OtherAccount && fake.Count("interactive") == 1, "a sign-in as another account than the user name entered says so, after one browser sign-in");
        // Help › Clear Entra ID Token Cache while the browser waits: the token went into the cache it emptied, which is not
        // another account.
        fake = new FakeSource { Interactive = (_, _) => { service.Clear(); return Task.FromResult(Token("cleared", "alice@contoso.com")); } };
        service.Source = fake;
        RequestException? overtaken = null;
        try { await service.OpenForUserAsync<string>(start + ";User ID=alice@contoso.com", "srv", (_, _) => { var id = Guid.NewGuid(); service.Attempts.Record(id, new InteractionRequired(Request("alice@contoso.com"))); throw ProviderFailure(id); }, NoId, CancellationToken.None); }
        catch (RequestException error) { overtaken = error; }
        check(overtaken is { Code: "AUTH_ENTRA", Message: EntraFailures.Messages.ClearedDuringSignIn } && fake.Cleared == 1, "a cache clear during the browser sign-in says so, not that another account signed in");
        // A connect queued behind another sign-in counts its wait in the 3-minute limit, so it ends before main's deadline.
        var hold = new TaskCompletionSource();
        fake = new FakeSource { Interactive = async (_, token) => { await hold.Task.WaitAsync(token); return Token("held"); } };
        service.Source = fake;
        service.SignInLimit = TimeSpan.FromMinutes(10);
        using (var stopHolder = new CancellationTokenSource())
        {
            var holder = service.SignInAsync(Request(), "srv", stopHolder.Token);
            for (var waited = 0; fake.Count("interactive") == 0 && waited < 5000; waited += 10) await Task.Delay(10);
            service.SignInLimit = TimeSpan.FromMilliseconds(200);
            object queued;
            try { await service.SignInAsync(Request(), "srv", CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(5)); queued = "signed in"; }
            catch (RequestException error) { queued = error; }
            catch (TimeoutException) { queued = "still waiting"; }
            check(queued is RequestException { Code: "AUTH_ENTRA", Message: EntraFailures.Messages.TimedOut } && fake.Count("interactive") == 1,
                "a sign-in queued behind another one times out within its own limit, waiting included: " + queued);
            stopHolder.Cancel();
            try { await holder; } catch (OperationCanceledException) { }
        }
        service.SignInLimit = TimeSpan.FromMinutes(3);
        // SqlClient's provider failure with no recorded attempt (a SqlClient that changed the exception's connection ID): its
        // own text, as AUTH_ENTRA, on an Entra connection only.
        Exception? unjoined = null, unjoinedPool = null;
        try { await service.OpenForUserAsync<string>(start, "srv", (_, _) => throw ProviderFailure(Guid.NewGuid()), NoId, CancellationToken.None); }
        catch (Exception error) { unjoined = error; }
        try { await service.OpenPooledAsync(new SqlConnection(start + ";User ID=alice@contoso.com"), CancellationToken.None, (_, _) => throw ProviderFailure(Guid.NewGuid())); }
        catch (Exception error) { unjoinedPool = error; }
        Exception? plain = null;
        try { await service.OpenPooledAsync(new SqlConnection("Data Source=sql.contoso.database.windows.net"), CancellationToken.None, (_, _) => throw ProviderFailure(Guid.NewGuid())); }
        catch (Exception error) { plain = error; }
        check(unjoined is RequestException { Code: "AUTH_ENTRA" } unjoinedRequest && unjoinedRequest.Message == "Failed to authenticate the user in Active Directory (Authentication=ActiveDirectoryInteractive)."
            && unjoinedRequest.Details == new ErrorDetails(0, 0, 11, "srv") && unjoinedPool is RequestException { Code: "AUTH_ENTRA", Details: null } && plain is SqlException,
            "a provider failure the provider did not record answers AUTH_ENTRA with SqlClient's text on an Entra connection, and is left alone on any other: " + unjoined?.GetType().Name + " " + unjoined?.Message + " / " + unjoinedPool?.GetType().Name + " / " + plain?.GetType().Name);
        // An open failure that is not Entra's is left to the caller (SQL Server's own error, with its details).
        try { await service.OpenForUserAsync<string>(start, "srv", (_, _) => throw ConnectionFailureChecks.Sql(18456, 1, 14, "srv", "Login failed."), NoId, CancellationToken.None); check(false, "unreachable"); }
        catch (SqlException error) { check(error.Number == 18456, "an open failure the provider did not record is left to the caller's mapping"); }
    }

    /// <summary>MFA without a user name, against a fake that keeps MSAL's account rule (the named account, else the only one
    /// signed in to the tenant, else none) and opens that call the provider as SqlClient's login does (not for a pool that
    /// already has a token).</summary>
    private static async Task AccountsAsync(Action<bool, string> check, EntraService service)
    {
        var accounts = new List<string>();
        var next = "alice@contoso.com";
        service.Source = new FakeSource
        {
            Silent = (request, _) => Task.FromResult(request.User is { } user ? accounts.Contains(user) ? Token("silent", user) : null : accounts.Count == 1 ? Token("silent", accounts[0]) : null),
            Interactive = (_, _) => { accounts.Add(next); return Task.FromResult(Token("interactive", next)); }
        };
        var pooled = new HashSet<string>();
        var opened = new List<string>();
        async Task<Guid> Login(string text, CancellationToken token)
        {
            opened.Add(text);
            var builder = new SqlConnectionStringBuilder(text);
            if (builder.Pooling && pooled.Contains(text)) return Guid.NewGuid();
            var id = Guid.NewGuid();
            try { await service.Provider.AcquireTokenAsync(Parameters(SqlAuthenticationMethod.ActiveDirectoryInteractive, id, builder.UserID)); }
            catch (EntraProviderException) { throw ProviderFailure(id); }
            if (builder.Pooling) pooled.Add(text);
            return id;
        }
        const string anonymous = "Data Source=sql.contoso.database.windows.net;Authentication=\"Active Directory Interactive\"";
        // Load databases signs in (unpooled), then Connect finds that token silently.
        await service.OpenForUserAsync(anonymous + ";Pooling=false", "srv", Login, id => id, CancellationToken.None);
        opened.Clear();
        var (_, kept) = await service.OpenForUserAsync(anonymous, "srv", Login, id => id, CancellationToken.None);
        var connectOpens = opened.ToList();
        // A second account signs in to the same tenant (another server's connect), then a query tab opens on the first server.
        next = "adm-alice@contoso.com";
        accounts.Add(next);
        string session;
        try { await Login(kept, CancellationToken.None); session = "opened"; }
        catch (SqlException) { session = "sign-in needed"; }
        check(new SqlConnectionStringBuilder(kept).UserID == "alice@contoso.com" && session == "opened" && connectOpens.Count == 1 && !new SqlConnectionStringBuilder(connectOpens[0]).Pooling,
            "Connect without a user name that finds a token silently keeps the account it is for (its open unpooled, so the provider is asked), so later opens find it when another account signs in: " + session);
        check(service.Attempts.Count == 0, "the account recorded for the connect is taken by it");
        service.Attempts.Clear();
    }

    private static async Task ServiceAsync(Action<bool, string> check)
    {
        using var service = new SqlService();
        var fake = new FakeSource();
        service.Entra.Source = fake;
        // Integrated is refused off Windows before anything is opened.
        service.Entra.IsWindows = () => false;
        var opens = 0;
        service.OpenUser = (_, _, _) => { opens++; throw new InvalidOperationException("opened"); };
        string Code(Exception error) => error is RequestException request ? request.Code + ": " + request.Message : error.GetType().Name;
        string connect, discover;
        try { await service.ConnectAsync(Options("entraIntegrated"), CancellationToken.None); connect = "connected"; } catch (Exception error) { connect = Code(error); }
        try { await service.DiscoverDatabasesAsync(Options("entraIntegrated"), CancellationToken.None); discover = "listed"; } catch (Exception error) { discover = Code(error); }
        check(connect == "AUTH_UNSUPPORTED: " + EntraFailures.Messages.IntegratedNeedsWindows && discover == connect && opens == 0,
            "Entra Integrated off Windows answers AUTH_UNSUPPORTED before any network I/O");
        service.Entra.IsWindows = () => true;
        try { await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(Options("entraDeviceCode", "alice"), HostChecks.Json), HostChecks.Json); connect = "connected"; }
        catch (Exception error) { connect = Code(error); }
        check(connect == "INVALID_PARAMS: Unsupported authentication mode." && opens == 0, "an unknown authentication type is refused by connect");
        // Connect and Load databases sign in through the browser when the login needs it, and Stop ends that wait.
        var waiting = new TaskCompletionSource();
        fake.Interactive = async (_, token) => { waiting.TrySetResult(); await Task.Delay(Timeout.Infinite, token); return Token("never"); };
        service.OpenUser = (_, _, _) =>
        {
            opens++;
            var id = Guid.NewGuid();
            service.Entra.Attempts.Record(id, new InteractionRequired(Request()));
            throw ProviderFailure(id);
        };
        foreach (var (name, run) in new (string, Func<CancellationToken, Task>)[] { ("connect", token => service.ConnectAsync(Options("entraMfa"), token)), ("Load databases", token => service.DiscoverDatabasesAsync(Options("entraMfa"), token)) })
        {
            waiting = new TaskCompletionSource();
            fake.Calls.Clear();
            using var stop = new CancellationTokenSource();
            var running = run(stop.Token);
            await waiting.Task.WaitAsync(TimeSpan.FromSeconds(5));
            stop.Cancel();
            Exception? stopped = null;
            try { await running.WaitAsync(TimeSpan.FromSeconds(1)); } catch (Exception error) { stopped = error; }
            check(stopped is OperationCanceledException && fake.Count("interactive") == 1, name + " signs in through the browser when MFA has no token, and Stop ends the wait");
        }
        // Load databases keeps one deadline for its opens (and its read): the browser sign-in between them is not counted, the
        // first open's time is.
        service.DiscoveryLimit = TimeSpan.FromSeconds(10);
        fake.Interactive = (_, _) => Task.FromResult(Token("budget", "alice@contoso.com"));
        var limits = new List<TimeSpan?>();
        service.OpenUser = async (_, limit, _) =>
        {
            limits.Add(limit);
            if (limits.Count > 1) throw new InvalidOperationException("budget read");
            await Task.Delay(400);
            var id = Guid.NewGuid();
            service.Entra.Attempts.Record(id, new InteractionRequired(Request("alice@contoso.com")));
            throw ProviderFailure(id);
        };
        try { await service.DiscoverDatabasesAsync(Options("entraMfa", "alice@contoso.com"), CancellationToken.None); } catch (Exception) { }
        check(limits.Count == 2 && limits[0] == TimeSpan.FromSeconds(10) && limits[1] <= TimeSpan.FromSeconds(10) - TimeSpan.FromMilliseconds(350),
            "Load databases' opens share one deadline, so a second open after a sign-in gets only what the first left: " + string.Join(", ", limits));
        // Login failed (18456) under Entra on Connect points to Help › Clear Entra ID Token Cache.
        service.OpenUser = (_, _, _) => throw ConnectionFailureChecks.Sql(18456, 1, 14, "sql.contoso.database.windows.net", "Login failed for user '<token-identified principal>'.");
        RequestException? hinted = null;
        try { await service.ConnectAsync(Options("entraMfa", "alice@contoso.com"), CancellationToken.None); } catch (RequestException error) { hinted = error; }
        check(hinted is { Code: "SQL_ERROR", Details.Number: 18456 } && hinted.Message.EndsWith(EntraFailures.Messages.ClearCacheHint, StringComparison.Ordinal),
            "Connect's Login failed (18456) under Entra MFA points to Help › Clear Entra ID Token Cache: " + hinted?.Message);
        // The cache clear: main's request reaches the token source and empties the attempts.
        service.Entra.Attempts.Record(Guid.NewGuid(), new InteractionRequired(Request()));
        var cleared = await service.DispatchAsync("entra.cache.clear", JsonDocument.Parse("{}").RootElement, HostChecks.Json);
        check(JsonSerializer.Serialize(cleared, HostChecks.Json) == "{\"cleared\":true}" && fake.Cleared == 1 && service.Entra.Attempts.Count == 0 && service.LaneOf("entra.cache.clear") == RequestLane.Control
            && SqlService.MethodNames.Contains("entra.cache.clear"), "Help › Clear Entra ID Token Cache empties the token source on the control lane");
        try { await service.DispatchAsync("entra.cache.clear", JsonDocument.Parse("{\"extra\":1}").RootElement, HostChecks.Json); check(false, "unknown member accepted"); }
        catch (JsonException) { check(true, "entra.cache.clear refuses unknown members"); }
        service.Entra.IsWindows = OperatingSystem.IsWindows;
    }

    /// <summary>Nothing about tokens, accounts or failures reaches stdout (protocol frames) or stderr (main's log).</summary>
    private static async Task SilentAsync(Action<bool, string> check, EntraService service)
    {
        var output = Console.Out;
        var error = Console.Error;
        using var captured = new StringWriter();
        Console.SetOut(captured);
        Console.SetError(captured);
        try
        {
            var signedIn = false;
            service.Source = new FakeSource { Interactive = (_, _) => { signedIn = true; return Task.FromResult(Token("quiet", "alice@contoso.com")); } };
            var provider = service.Provider;
            async Task<string> Open(string text, CancellationToken token)
            {
                try { return signedIn ? "connection" : (await provider.AcquireTokenAsync(Parameters(SqlAuthenticationMethod.ActiveDirectoryInteractive, Guid.Empty))).AccessToken; }
                catch (EntraProviderException) { var id = Guid.NewGuid(); service.Attempts.Record(id, new InteractionRequired(Request())); throw ProviderFailure(id); }
            }
            await service.OpenForUserAsync("Data Source=x", "x", Open, NoId, CancellationToken.None);
            service.Source = new FakeSource { Interactive = (_, _) => throw new MsalServiceException("invalid_request", "AADSTS90002: Tenant not found.") };
            signedIn = false;
            try { await service.OpenForUserAsync("Data Source=x", "x", Open, NoId, CancellationToken.None); } catch (RequestException) { }
        }
        finally
        {
            Console.SetOut(output);
            Console.SetError(error);
        }
        check(captured.ToString().Length == 0, "a sign-in and a failed sign-in write nothing to stdout or stderr");
    }

    private static async Task AbandonAsync(Action<bool, string> check)
    {
        var release = new TaskCompletionSource();
        var connection = new SqlConnection("Data Source=localhost");
        var disposed = new TaskCompletionSource();
        connection.Disposed += (_, _) => disposed.TrySetResult();
        using var stop = new CancellationTokenSource();
        var open = SqlService.OpenAbandonableAsync(connection, stop.Token, (_, _) => release.Task);
        stop.CancelAfter(50);
        var watch = Stopwatch.StartNew();
        Exception? thrown = null;
        try { await open.WaitAsync(TimeSpan.FromSeconds(5)); } catch (Exception error) { thrown = error; }
        check(thrown is OperationCanceledException && watch.ElapsedMilliseconds < 1000 && !disposed.Task.IsCompleted,
            "Stop answers a connect at once while SqlClient still waits for its login (a token or a credential chain)");
        release.SetException(new InvalidOperationException("late failure"));
        await disposed.Task.WaitAsync(TimeSpan.FromSeconds(5));
        check(disposed.Task.IsCompleted, "the abandoned connection is closed when its login finally ends");
        var failing = new SqlConnection("Data Source=localhost");
        var failed = false;
        failing.Disposed += (_, _) => failed = true;
        try { await SqlService.OpenAbandonableAsync(failing, CancellationToken.None, (_, _) => Task.FromException(new InvalidOperationException("refused"))); }
        catch (InvalidOperationException) { }
        check(failed, "a connection whose open failed is disposed");
    }

    /// <summary>Against the live server (which does not use Entra): a connect and a Load databases whose first open fails as a
    /// login that needs a browser sign-in does sign in once, then open for real, and the cache clear leaves a connected
    /// server working.</summary>
    internal static async Task LiveAsync(Action<bool, string> check, ConnectOptions options, JsonSerializerOptions json)
    {
        using var service = new SqlService();
        var original = service.Entra.Source;
        var fake = new FakeSource { Interactive = (_, _) => Task.FromResult(Token("live")) };
        service.Entra.Source = fake;
        var real = service.OpenUser;
        var opens = 0;
        service.OpenUser = (text, limit, token) =>
        {
            if (Interlocked.Increment(ref opens) % 2 == 1)
            {
                var id = Guid.NewGuid();
                service.Entra.Attempts.Record(id, new InteractionRequired(Request()));
                throw ProviderFailure(id);
            }
            return real(text, limit, token);
        };
        try
        {
            var info = await service.ConnectAsync(options, CancellationToken.None);
            try
            {
                check(info.ServerVersion.Length > 0 && opens == 2 && fake.Count("interactive") == 1, "a connect that needs a sign-in signs in once, then connects with a new connection");
                var databases = await service.DiscoverDatabasesAsync(options with { Database = "" }, CancellationToken.None);
                check(databases.Any(database => database.Name == "master") && opens == 4 && fake.Count("interactive") == 2, "Load databases signs in the same way, then lists the databases");
                await service.DispatchAsync("entra.cache.clear", JsonDocument.Parse("{}").RootElement, json);
                var listed = (List<DatabaseInfo>)await service.DispatchAsync("databases.list", JsonSerializer.SerializeToElement(new ConnectionArgs(info.Id), json), json);
                check(listed.Any(database => database.Name == "master"), "clearing the Entra token cache leaves other connections working (their pools are only emptied)");
            }
            finally { await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(info.Id), json), json); }
        }
        finally
        {
            service.Entra.Source = original;
            service.Entra.Attempts.Clear();
        }
    }

    /// <summary>The browser launcher: never with the backend's standard output (the protocol), only for an allowed sign-in
    /// page, and a launcher that fails says so.</summary>
    private static async Task BrowserAsync(Action<bool, string> check)
    {
        var page = new Uri("https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/oauth2/v2.0/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A49152");
        var linux = EntraBrowser.StartInfo(page, "linux");
        var mac = EntraBrowser.StartInfo(page, "macos");
        var windows = EntraBrowser.StartInfo(page, "windows");
        check(linux.FileName == "/bin/sh" && !linux.UseShellExecute && linux.RedirectStandardInput && linux.RedirectStandardOutput && linux.RedirectStandardError
            && linux.ArgumentList.SequenceEqual(["-c", "exec \"$0\" \"$1\" </dev/null >/dev/null 2>&1", "xdg-open", page.AbsoluteUri]) && mac.ArgumentList[2] == "open"
            && windows.UseShellExecute && windows.FileName == page.AbsoluteUri,
            "the browser starts with its streams on /dev/null (xdg-open, open) or through the Windows shell, the page an argument, never interpolated");
        string Refused(string address) { try { EntraBrowser.StartInfo(new Uri(address), "linux"); return "started"; } catch (EntraBrowserException) { return "refused"; } }
        check(new[] { "http://login.microsoftonline.com/t", "https://evil.example/t", "https://login.microsoftonline.com:444/t", "file:///etc/passwd" }.All(address => Refused(address) == "refused"),
            "only an https sign-in page on an allowed host is opened");
        check(EntraFailures.Map(new EntraBrowserException("x"), SqlAuthenticationMethod.ActiveDirectoryInteractive).Message == EntraFailures.Messages.BrowserFailed, "a browser that could not be started says so");
        if (OperatingSystem.IsWindows()) return;
        // The real shell, with stand-ins for the tool: what the tool prints never reaches the backend's streams, and a tool
        // that fails (as xdg-open does without a browser) is a failure.
        ProcessStartInfo With(string tool) { var start = EntraBrowser.StartInfo(page, "linux"); start.ArgumentList[2] = tool; return start; }
        var printed = await EntraBrowser.RunAsync(With("echo"));
        string failed;
        try { await EntraBrowser.RunAsync(With("false")); failed = "opened"; } catch (EntraBrowserException) { failed = "failed"; }
        string missing;
        try { await EntraBrowser.RunAsync(With("varia-no-such-browser-tool")); missing = "opened"; } catch (EntraBrowserException) { missing = "failed"; }
        check(printed == "" && failed == "failed" && missing == "failed", "the launcher prints nothing to the backend and reports a tool that failed or is missing");
    }

    /// <summary>The real MSAL source offline: building its applications needs no network, and a clear drops them with
    /// their in-memory caches.</summary>
    private static async Task RealSourceAsync(Action<bool, string> check)
    {
        var source = new MsalTokenSource();
        var first = source.Application(Request());
        check(ReferenceEquals(first, source.Application(Request())) && first.AppConfig.ClientId == MsalTokenSource.ClientId && first.AppConfig.RedirectUri == "http://localhost"
            && first.AppConfig.ClientName == "Varia SQL Manager" && !first.AppConfig.IsBrokerEnabled,
            "MSAL uses SqlClient's public client ID with the loopback redirect, no broker, one application per authority");
        source.Clear();
        check(!ReferenceEquals(first, source.Application(Request())), "a clear drops every application, and with it its tokens");
        var others = Enumerable.Range(0, MsalTokenSource.MaxApplications + 1).Select(index => source.Application(Request() with { Tenant = "tenant" + index })).ToList();
        check(!ReferenceEquals(others[0], source.Application(Request() with { Tenant = "tenant0" })), "at most 16 authorities are kept");
        // An MFA sign-in as an admin account leaves it in the tenant's application; Integrated, which the dialog shows as the
        // Windows user, must not connect with it.
        var seeded = new MsalTokenSource();
        Seed(seeded.Application(Request()), "admin-alice@contoso.com", "MFA-ADMIN-TOKEN");
        var mfa = await seeded.SilentAsync(Request(), CancellationToken.None);
        var windows = 0;
        seeded.WindowsSignIn = (_, _, _) => { windows++; return Task.FromResult(Token("windows", "alice@contoso.com")); };
        var integrated = await seeded.IntegratedAsync(Request(), CancellationToken.None);
        check(mfa is { AccessToken: "MFA-ADMIN-TOKEN", Account: "admin-alice@contoso.com" } && integrated.AccessToken == "fake-access-windows" && windows == 1,
            "Microsoft Entra Integrated signs in as the Windows user, never with an account MFA or Password left in the tenant's cache: " + integrated.Account);
    }

    /// <summary>Puts one signed-in account, with an access token for SQL valid for an hour, in an MSAL application's in-memory
    /// cache, as an MFA sign-in leaves it. MSAL reads it without any network call (login.microsoftonline.com's metadata is
    /// built in).</summary>
    private static void Seed(IPublicClientApplication application, string user, string accessToken)
    {
        const string tenant = "72f988bf-86f1-41af-91ab-2d7cd011db47", environment = "login.microsoftonline.com", objectId = "00000000-0000-0000-0000-0000000000a1";
        var home = objectId + "." + tenant;
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        static string Encode(object value) => Convert.ToBase64String(JsonSerializer.SerializeToUtf8Bytes(value)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        var idToken = Encode(new { alg = "none", typ = "JWT" }) + "." + Encode(new { aud = MsalTokenSource.ClientId, iss = "https://login.microsoftonline.com/" + tenant + "/v2.0", oid = objectId, tid = tenant, preferred_username = user, sub = "subject", ver = "2.0" }) + ".";
        var cache = new Dictionary<string, object>
        {
            ["Account"] = new Dictionary<string, object> { ["account"] = new { home_account_id = home, environment, realm = tenant, local_account_id = objectId, username = user, authority_type = "MSSTS" } },
            ["IdToken"] = new Dictionary<string, object> { ["id"] = new { home_account_id = home, environment, realm = tenant, credential_type = "IdToken", client_id = MsalTokenSource.ClientId, secret = idToken } },
            ["RefreshToken"] = new Dictionary<string, object> { ["refresh"] = new { home_account_id = home, environment, credential_type = "RefreshToken", client_id = MsalTokenSource.ClientId, secret = "refresh" } },
            ["AccessToken"] = new Dictionary<string, object>
            {
                ["access"] = new
                {
                    home_account_id = home, environment, realm = tenant, credential_type = "AccessToken", client_id = MsalTokenSource.ClientId, secret = accessToken, target = "https://database.windows.net//.default",
                    cached_at = now.ToString(CultureInfo.InvariantCulture), expires_on = (now + 3600).ToString(CultureInfo.InvariantCulture), extended_expires_on = (now + 3600).ToString(CultureInfo.InvariantCulture), token_type = "Bearer"
                }
            },
            ["AppMetadata"] = new Dictionary<string, object>()
        };
        var seeded = false;
        application.UserTokenCache.SetBeforeAccess(args =>
        {
            if (seeded) return;
            seeded = true;
            args.TokenCache.DeserializeMsalV3(JsonSerializer.SerializeToUtf8Bytes(cache));
        });
    }

    /// <summary>Managed Identity against a stand-in for an Azure App Service identity endpoint (IDENTITY_ENDPOINT and
    /// IDENTITY_HEADER, which MSAL reads): MSAL caches managed identity tokens for the whole process, so after Help › Clear
    /// Entra ID Token Cache the next connect must fetch a new one, not get the old one from that cache, for every resource,
    /// and also when the clear came while a fetch was on its way.</summary>
    private static async Task ManagedIdentityAsync(Action<bool, string> check)
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var hits = 0;
        // Set by the race below: the endpoint signals that a request arrived, then answers only once released.
        TaskCompletionSource? arrived = null, release = null;
        using var stop = new CancellationTokenSource();
        var serving = Task.Run(async () =>
        {
            while (!stop.IsCancellationRequested)
            {
                using var client = await listener.AcceptTcpClientAsync(stop.Token);
                var stream = client.GetStream();
                var buffer = new byte[16_384];
                var read = 0;
                while (read < buffer.Length && !Encoding.ASCII.GetString(buffer, 0, read).Contains("\r\n\r\n", StringComparison.Ordinal))
                {
                    var count = await stream.ReadAsync(buffer.AsMemory(read), stop.Token);
                    if (count == 0) break;
                    read += count;
                }
                var hit = Interlocked.Increment(ref hits);
                var line = Encoding.ASCII.GetString(buffer, 0, read).Split("\r\n")[0];
                var resource = Uri.UnescapeDataString(line.Split("resource=", 2) is [_, var rest] ? rest.Split(['&', ' '])[0] : "");
                if (arrived is { } signal && release is { } gate) { signal.TrySetResult(); await gate.Task.WaitAsync(stop.Token); }
                var body = JsonSerializer.Serialize(new Dictionary<string, string>
                {
                    ["access_token"] = "managed-" + hit + (resource.Contains("synapse", StringComparison.Ordinal) ? "-synapse" : ""),
                    ["expires_on"] = DateTimeOffset.UtcNow.AddHours(1).ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture),
                    ["resource"] = resource, ["token_type"] = "Bearer"
                });
                await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + body.Length + "\r\nConnection: close\r\n\r\n" + body), stop.Token);
            }
        });
        var endpoint = Environment.GetEnvironmentVariable("IDENTITY_ENDPOINT");
        var header = Environment.GetEnvironmentVariable("IDENTITY_HEADER");
        Environment.SetEnvironmentVariable("IDENTITY_ENDPOINT", "http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/msi/token");
        Environment.SetEnvironmentVariable("IDENTITY_HEADER", "varia-checks");
        try
        {
            var source = new MsalTokenSource();
            using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var before = await source.ManagedIdentityAsync(Request(), limit.Token);
            var again = await source.ManagedIdentityAsync(Request(), limit.Token);
            source.Clear();
            var after = await source.ManagedIdentityAsync(Request(), limit.Token);
            check(before.AccessToken == "managed-1" && again.AccessToken == "managed-1" && after.AccessToken == "managed-2" && hits == 2,
                "Managed Identity reuses its token until Help › Clear Entra ID Token Cache, then fetches a new one, although MSAL's cache is process-wide: "
                + string.Join(", ", before.AccessToken, again.AccessToken, after.AccessToken));

            // MSAL caches a token per identity and resource, so each resource is fetched anew after a clear.
            var synapse = Request() with { Scope = "https://sql.azuresynapse.net/.default" };
            var synapseBefore = await source.ManagedIdentityAsync(synapse, limit.Token);
            source.Clear();
            var databaseAfter = await source.ManagedIdentityAsync(Request(), limit.Token);
            var synapseAfter = await source.ManagedIdentityAsync(synapse, limit.Token);
            check(synapseBefore.AccessToken == "managed-3-synapse" && databaseAfter.AccessToken == "managed-4" && synapseAfter.AccessToken == "managed-5-synapse",
                "Managed Identity fetches a new token after a clear for each resource of the same identity, not only the first one asked for: "
                + string.Join(", ", synapseBefore.AccessToken, databaseAfter.AccessToken, synapseAfter.AccessToken));

            // A clear while a forced fetch is on its way: that token may predate the clear, so the next one is fetched again.
            source.Clear();
            arrived = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var pending = source.ManagedIdentityAsync(Request(), limit.Token);
            await arrived.Task.WaitAsync(limit.Token);
            source.Clear();
            arrived = null;
            release.TrySetResult();
            var overtaken = await pending;
            var next = await source.ManagedIdentityAsync(Request(), limit.Token);
            check(overtaken.AccessToken == "managed-6" && next.AccessToken == "managed-7",
                "Managed Identity fetches again after a clear that came while a fetch was on its way: " + string.Join(", ", overtaken.AccessToken, next.AccessToken));
        }
        finally
        {
            Environment.SetEnvironmentVariable("IDENTITY_ENDPOINT", endpoint);
            Environment.SetEnvironmentVariable("IDENTITY_HEADER", header);
            stop.Cancel();
            listener.Stop();
            try { await serving; } catch (Exception error) when (error is OperationCanceledException or SocketException or ObjectDisposedException) { }
        }
    }
}
