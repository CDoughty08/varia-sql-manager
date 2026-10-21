using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Azure.Core;
using Azure.Identity;
using Microsoft.Identity.Client;
using MsalIdentity = Microsoft.Identity.Client.AppConfig.ManagedIdentityId;

namespace Varia.Backend.Entra;

/// <summary>Tokens from MSAL (MFA, Password, Integrated, Managed Identity) and Azure.Identity (Service Principal, Default),
/// as SqlClient's own Azure provider gets them, but without WAM: MFA signs in through the system web browser on every OS
/// (EntraBrowser opens it: the shell on Windows, open on macOS, xdg-open on Linux). Tokens stay in this process's memory
/// for its lifetime, one MSAL application per sign-in authority (and another for Integrated), until <see cref="Clear"/>.
/// Nothing is logged: MSAL gets no logger and Azure.Identity no event listener.</summary>
internal sealed class MsalTokenSource : IEntraTokenSource
{
    /// <summary>SqlClient's own public client application (its Azure provider's default), which accepts the loopback
    /// redirect below for system-browser sign-in. Varia's own registration comes with the Packaging work.</summary>
    internal const string ClientId = "2fd908ad-0664-4344-b9be-cd3e8b574c38";
    internal const string RedirectUri = "http://localhost";
    internal const int MaxApplications = 16, MaxCredentials = 32, MaxPasswords = 64;
    /// <summary>How long Entra Password reuses a token for the same password, as SqlClient's provider does.</summary>
    internal static readonly TimeSpan PasswordReuse = TimeSpan.FromHours(2);
    private static readonly SystemWebViewOptions Browser = new()
    {
        // Static text only: MSAL would fill {0} and {1} with the server's error and description.
        HtmlMessageSuccess = "<!doctype html><title>Varia SQL Manager</title><p>Sign-in complete. You can close this tab and return to Varia SQL Manager.</p>",
        HtmlMessageError = "<!doctype html><title>Varia SQL Manager</title><p>Sign-in did not complete. Return to Varia SQL Manager for details.</p>",
        // MSAL's own launcher would let the browser write to the backend's standard output (the protocol).
        OpenBrowserAsync = EntraBrowser.OpenAsync
    };
    private static readonly string Version = typeof(MsalTokenSource).Assembly.GetName().Version?.ToString() ?? "0.0.0";

    private readonly ConcurrentDictionary<string, IPublicClientApplication> applications = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, (TokenCredential Credential, byte[] Secret)> credentials = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (byte[] Hash, DateTimeOffset Until)> passwords = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, IManagedIdentityApplication> identities = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>Managed identity and resource pairs whose token was fetched anew since the last clear.</summary>
    private readonly HashSet<string> refreshed = new(StringComparer.OrdinalIgnoreCase);
    /// <summary>Counts clears, so a fetch that began before one does not count as fetched after it.</summary>
    private long clears;
    private readonly Lock gate = new();

    /// <summary>Integrated Windows authentication itself; the checks replace it (it needs a domain-joined computer and a tenant).</summary>
    internal Func<IPublicClientApplication, EntraRequest, CancellationToken, Task<EntraToken>> WindowsSignIn { get; set; } = WindowsSignInAsync;

    /// <summary>The MSAL application for the request's authority (its host and tenant), as SqlClient keys them; Integrated
    /// gets its own, so it only ever reuses an account integrated Windows authentication signed in, never one MFA or Password
    /// left in the shared cache (the dialog shows Integrated's identity as the Windows user). Its token cache is MSAL's
    /// in-memory one; persisting it across backend restarts is a later change.</summary>
    internal IPublicClientApplication Application(EntraRequest request, bool integrated = false)
    {
        var key = (integrated ? "integrated|" : "") + request.Authority;
        if (applications.TryGetValue(key, out var existing)) return existing;
        lock (gate)
        {
            if (applications.TryGetValue(key, out existing)) return existing;
            // More authorities than any workbench signs in to: start over rather than grow without bound.
            if (applications.Count >= MaxApplications) applications.Clear();
            var application = PublicClientApplicationBuilder.Create(ClientId)
                .WithAuthority(request.Authority)
                .WithRedirectUri(RedirectUri)
                .WithClientName("Varia SQL Manager")
                .WithClientVersion(Version)
                .Build();
            applications[key] = application;
            return application;
        }
    }

    public Task<EntraToken?> SilentAsync(EntraRequest request, CancellationToken token) => SilentAsync(Application(request), request, token);

    private static async Task<EntraToken?> SilentAsync(IPublicClientApplication application, EntraRequest request, CancellationToken token)
    {
        var accounts = (await application.GetAccountsAsync().ConfigureAwait(false)).ToList();
        // The named account, else the one account signed in to this tenant; several without a name need the account picker.
        var account = request.User is { } user ? accounts.Find(item => string.Equals(item.Username, user, StringComparison.OrdinalIgnoreCase))
            : accounts.Count == 1 ? accounts[0] : null;
        if (account is null) return null;
        try { return From(await application.AcquireTokenSilent([request.Scope], account).ExecuteAsync(token).ConfigureAwait(false)); }
        catch (MsalUiRequiredException) { return null; }
    }

    public async Task<EntraToken> InteractiveAsync(EntraRequest request, CancellationToken token)
    {
        var builder = Application(request).AcquireTokenInteractive([request.Scope]).WithUseEmbeddedWebView(false).WithSystemWebViewOptions(Browser);
        builder = request.User is { } user ? builder.WithLoginHint(user) : builder.WithPrompt(Prompt.SelectAccount);
        return From(await builder.ExecuteAsync(token).ConfigureAwait(false));
    }

    public async Task<EntraToken> PasswordAsync(EntraRequest request, string password, CancellationToken token)
    {
        var user = request.User ?? throw new ArgumentException("A user name is required.", nameof(request));
        var key = request.Authority + "+" + user;
        var hash = Hash(password);
        // A cached token is reused only for the password it was issued for, so a wrong password never connects on a token
        // a right one got (SqlClient's provider does the same).
        if (passwords.TryGetValue(key, out var known) && known.Until > DateTimeOffset.UtcNow && CryptographicOperations.FixedTimeEquals(known.Hash, hash)
            && await SilentAsync(request, token).ConfigureAwait(false) is { } cached) return cached;
#pragma warning disable CS0618 // MSAL marks the ROPC flow obsolete; SSMS 22 still offers Microsoft Entra Password.
        var result = await Application(request).AcquireTokenByUsernamePassword([request.Scope], user, password).ExecuteAsync(token).ConfigureAwait(false);
#pragma warning restore CS0618
        lock (gate)
        {
            if (passwords.Count >= MaxPasswords) passwords.Clear();
            passwords[key] = (hash, DateTimeOffset.UtcNow + PasswordReuse);
        }
        return From(result);
    }

    public async Task<EntraToken> IntegratedAsync(EntraRequest request, CancellationToken token)
    {
        var application = Application(request, integrated: true);
        if (await SilentAsync(application, request, token).ConfigureAwait(false) is { } cached) return cached;
        return await WindowsSignIn(application, request, token).ConfigureAwait(false);
    }

    private static async Task<EntraToken> WindowsSignInAsync(IPublicClientApplication application, EntraRequest request, CancellationToken token)
    {
#pragma warning disable CS0618 // MSAL marks integrated Windows authentication obsolete; SSMS 22 still offers Microsoft Entra Integrated.
        var builder = application.AcquireTokenByIntegratedWindowsAuth([request.Scope]);
#pragma warning restore CS0618
        if (request.User is { } user) builder = builder.WithUsername(user);
        return From(await builder.ExecuteAsync(token).ConfigureAwait(false));
    }

    public Task<EntraToken> ServicePrincipalAsync(EntraRequest request, string secret, CancellationToken token)
    {
        var clientId = request.User ?? throw new ArgumentException("A client ID is required.", nameof(request));
        return CredentialAsync("sp|" + request.Authority + "|" + clientId, secret, request,
            () => new ClientSecretCredential(request.Tenant, clientId, secret, new ClientSecretCredentialOptions { AuthorityHost = request.AuthorityHost }), token);
    }

    /// <summary>MSAL's managed identity application, used directly: MSAL keeps managed identity tokens in a cache shared by
    /// the whole process, which a new application (or Azure.Identity credential) reads too, so the first token for each
    /// identity and resource after a clear (or ever) is fetched anew from the host's endpoint. The resource counts because
    /// MSAL caches one token per identity and resource.</summary>
    public async Task<EntraToken> ManagedIdentityAsync(EntraRequest request, CancellationToken token)
    {
        var key = request.User ?? "";
        var resource = Resource(request.Scope);
        var fetched = key + "|" + resource;
        IManagedIdentityApplication application;
        bool force;
        long generation;
        lock (gate)
        {
            if (!identities.TryGetValue(key, out application!))
            {
                if (identities.Count >= MaxCredentials) { identities.Clear(); refreshed.Clear(); }
                application = ManagedIdentityApplicationBuilder.Create(request.User is { } clientId ? MsalIdentity.WithUserAssignedClientId(clientId) : MsalIdentity.SystemAssigned).Build();
                identities[key] = application;
            }
            force = !refreshed.Contains(fetched);
            generation = clears;
        }
        var result = await application.AcquireTokenForManagedIdentity(resource).WithForceRefresh(force).ExecuteAsync(token).ConfigureAwait(false);
        // A token whose fetch a clear overtook may predate the clear, so the next request fetches again.
        if (force) lock (gate) if (clears == generation) refreshed.Add(fetched);
        return new EntraToken(result.AccessToken, result.ExpiresOn, null);
    }

    public Task<EntraToken> DefaultAsync(EntraRequest request, CancellationToken token) =>
        CredentialAsync("default|" + request.Authority + "|" + request.User, "", request, () =>
        {
            // The chain's own browser credential is left out: only the Connect dialog's MFA opens a browser. A user name names
            // the managed or workload identity, as SqlClient's provider passes it.
            var options = new DefaultAzureCredentialOptions { AuthorityHost = request.AuthorityHost, TenantId = request.Tenant, ExcludeInteractiveBrowserCredential = true };
            if (request.User is { } clientId) { options.ManagedIdentityClientId = clientId; options.WorkloadIdentityClientId = clientId; }
            return new DefaultAzureCredential(options);
        }, token);

    /// <summary>Forgets every MSAL application and Azure.Identity credential with their tokens. Tokens held outside this
    /// process (the Azure CLI's, an Azure host's endpoint, and the managed identity leg of Default's chain, which shares MSAL's
    /// process-wide cache) are theirs to keep until they expire.</summary>
    public void Clear()
    {
        lock (gate)
        {
            applications.Clear();
            credentials.Clear();
            passwords.Clear();
            identities.Clear();
            refreshed.Clear();
            clears++;
        }
    }

    /// <summary>Azure.Identity credentials keep their own token caches, so each is reused for its key, and replaced when the
    /// secret changes; at most 32 are kept.</summary>
    private async Task<EntraToken> CredentialAsync(string key, string secret, EntraRequest request, Func<TokenCredential> create, CancellationToken token)
    {
        var hash = Hash(secret);
        TokenCredential credential;
        lock (gate)
        {
            if (credentials.TryGetValue(key, out var known) && CryptographicOperations.FixedTimeEquals(known.Secret, hash)) credential = known.Credential;
            else
            {
                if (credentials.Count >= MaxCredentials) credentials.Clear();
                credential = create();
                credentials[key] = (credential, hash);
            }
        }
        var access = await credential.GetTokenAsync(new TokenRequestContext([request.Scope]), token).ConfigureAwait(false);
        return new EntraToken(access.Token, access.ExpiresOn, null);
    }

    /// <summary>A managed identity asks for a resource, not a scope: the scope without its /.default.</summary>
    internal static string Resource(string scope) => scope.EndsWith("/.default", StringComparison.Ordinal) ? scope[..^"/.default".Length] : scope;

    private static EntraToken From(AuthenticationResult result) => new(result.AccessToken, result.ExpiresOn, result.Account?.Username);

    private static byte[] Hash(string secret) => SHA256.HashData(Encoding.Unicode.GetBytes(secret));
}
