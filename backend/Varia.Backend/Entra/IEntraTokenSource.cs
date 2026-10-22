namespace Varia.Backend.Entra;

/// <summary>A token request: the allowed sign-in host (https://login.microsoftonline.com/), the server's tenant, the
/// scope (the SQL audience plus /.default), and the user name or client ID the connection names, if any.</summary>
internal sealed record EntraRequest(Uri AuthorityHost, string Tenant, string Scope, string? User)
{
    /// <summary>The MSAL authority: the host and the tenant.</summary>
    public string Authority => AuthorityHost.AbsoluteUri + Tenant;
}

/// <summary>An access token for SqlClient, and the account it was issued to (for a user, its user name).</summary>
internal sealed record EntraToken(string AccessToken, DateTimeOffset ExpiresOn, string? Account)
{
    // The token never reaches logs or exception text, so a record's generated ToString must not print it.
    public override string ToString() => "EntraToken";
}

/// <summary>Where Entra tokens come from: MSAL and Azure.Identity in the backend (MsalTokenSource), a fake in the checks.
/// Only the Connect dialog's sign-in calls <see cref="InteractiveAsync"/>; the provider SqlClient calls never does.</summary>
internal interface IEntraTokenSource
{
    /// <summary>A cached token, refreshed if needed, for the request's user (or the only account signed in to that tenant),
    /// or null when a sign-in in the browser is needed.</summary>
    Task<EntraToken?> SilentAsync(EntraRequest request, CancellationToken token);
    /// <summary>Signs in through the system web browser; only cancellation (Stop, the 3-minute limit) ends the wait.</summary>
    Task<EntraToken> InteractiveAsync(EntraRequest request, CancellationToken token);
    Task<EntraToken> PasswordAsync(EntraRequest request, string password, CancellationToken token);
    Task<EntraToken> IntegratedAsync(EntraRequest request, CancellationToken token);
    /// <summary>The request's user is the application's client ID.</summary>
    Task<EntraToken> ServicePrincipalAsync(EntraRequest request, string secret, CancellationToken token);
    /// <summary>The request's user is a user-assigned identity's client ID; none means the system-assigned identity.</summary>
    Task<EntraToken> ManagedIdentityAsync(EntraRequest request, CancellationToken token);
    Task<EntraToken> DefaultAsync(EntraRequest request, CancellationToken token);
    /// <summary>Forgets every token and credential (Help › Clear Entra ID Token Cache).</summary>
    void Clear();
}
