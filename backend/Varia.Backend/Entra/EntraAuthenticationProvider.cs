using Microsoft.Data.SqlClient;

namespace Varia.Backend.Entra;

/// <summary>SqlClient's token provider for every Entra type. SqlClient calls it inside its synchronous login, where no
/// cancellation reaches it, so it never waits for a person: MFA uses only a cached token, and when there is none it records
/// that a sign-in is needed (EntraAttempts) and fails at once, leaving the browser sign-in to EntraService, which runs it
/// under the Connect dialog's request and its Stop. Each other type is bounded by the connect timeout (2 minutes when that
/// is 0). Every failure is recorded under the attempt's ClientConnectionId and thrown without a retry, and so is the account
/// an MFA token without a user name went to.</summary>
internal sealed class EntraAuthenticationProvider(EntraService service) : SqlAuthenticationProvider
{
    internal static readonly TimeSpan UnboundedLimit = TimeSpan.FromMinutes(2);

    public override bool IsSupported(SqlAuthenticationMethod authenticationMethod) => Array.IndexOf(EntraModes.Methods, authenticationMethod) >= 0;

    public override async Task<SqlAuthenticationToken> AcquireTokenAsync(SqlAuthenticationParameters parameters)
    {
        var method = parameters.AuthenticationMethod;
        EntraAttempt attempt;
        if (!EntraEndpoints.TryParseAuthority(parameters.Authority, out var host, out var tenant))
            attempt = new EntraFailure("AUTH_ENTRA", EntraFailures.Messages.RefusedAuthority(EntraEndpoints.HostOf(parameters.Authority)));
        else if (!EntraEndpoints.IsAllowedResource(parameters.Resource))
            attempt = new EntraFailure("AUTH_ENTRA", EntraFailures.Messages.RefusedResource(EntraEndpoints.HostOf(parameters.Resource)));
        else
        {
            var request = new EntraRequest(host, tenant, EntraEndpoints.Scope(parameters.Resource), string.IsNullOrWhiteSpace(parameters.UserId) ? null : parameters.UserId);
            using var limit = new CancellationTokenSource(parameters.ConnectionTimeout > 0 ? TimeSpan.FromSeconds(Math.Min(parameters.ConnectionTimeout, 3600)) : UnboundedLimit);
            try
            {
                var token = await AcquireAsync(service.Source, method, request, parameters.Password ?? "", limit.Token).ConfigureAwait(false);
                if (token is not null)
                {
                    // MFA without a user name took the only account signed in to the tenant: the Connect dialog pins it.
                    if (method == SqlAuthenticationMethod.ActiveDirectoryInteractive && request.User is null && token.Account is { Length: > 0 and <= 128 } account)
                        service.Attempts.Record(parameters.ConnectionId, new Served(account));
                    return new SqlAuthenticationToken(token.AccessToken, token.ExpiresOn);
                }
                attempt = new InteractionRequired(request);
            }
            catch (OperationCanceledException) when (limit.IsCancellationRequested) { attempt = new EntraFailure("AUTH_ENTRA", EntraFailures.Messages.TokenTimedOut); }
            catch (Exception error) when (error is not OutOfMemoryException) { attempt = EntraFailures.Map(error, method); }
        }
        service.Attempts.Record(parameters.ConnectionId, attempt);
        throw new EntraProviderException(method, attempt is InteractionRequired ? "InteractionRequired" : "Failed",
            attempt is EntraFailure failure ? failure.Message : "Microsoft Entra sign-in is required.");
    }

    /// <summary>A token for the type, or null when MFA needs a sign-in in the browser.</summary>
    private static async Task<EntraToken?> AcquireAsync(IEntraTokenSource source, SqlAuthenticationMethod method, EntraRequest request, string password, CancellationToken token)
    {
#pragma warning disable CS0618 // ActiveDirectoryPassword: see EntraModes.
        return method switch
        {
            SqlAuthenticationMethod.ActiveDirectoryInteractive => await source.SilentAsync(request, token).ConfigureAwait(false),
            SqlAuthenticationMethod.ActiveDirectoryPassword => await source.PasswordAsync(request, password, token).ConfigureAwait(false),
            SqlAuthenticationMethod.ActiveDirectoryIntegrated => await source.IntegratedAsync(request, token).ConfigureAwait(false),
            SqlAuthenticationMethod.ActiveDirectoryServicePrincipal => await source.ServicePrincipalAsync(request, password, token).ConfigureAwait(false),
            SqlAuthenticationMethod.ActiveDirectoryManagedIdentity or SqlAuthenticationMethod.ActiveDirectoryMSI => await source.ManagedIdentityAsync(request, token).ConfigureAwait(false),
            SqlAuthenticationMethod.ActiveDirectoryDefault => await source.DefaultAsync(request, token).ConfigureAwait(false),
            _ => throw new NotSupportedException("Unsupported Microsoft Entra authentication.")
        };
#pragma warning restore CS0618
    }
}

/// <summary>A provider failure SqlClient answers at once (no retry); its message is already bounded and redacted.</summary>
internal sealed class EntraProviderException(SqlAuthenticationMethod method, string failureCode, string message)
    : SqlAuthenticationProviderException(method, failureCode, false, 0, message, null);
