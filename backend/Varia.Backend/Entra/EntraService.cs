using Microsoft.Data.SqlClient;

namespace Varia.Backend.Entra;

/// <summary>Microsoft Entra ID for the backend: SqlClient's provider for every Entra type (registered once per process),
/// the browser sign-in the Connect dialog runs, and the mapping of Entra failures to answers. Connection strings carry
/// SqlClient's Authentication keyword, so every pool (Object Explorer, Script As, object actions, query sessions, SMO)
/// gets its tokens here without asking anyone.</summary>
internal sealed class EntraService
{
    private static readonly Lazy<EntraService> shared = new(() =>
    {
        var service = new EntraService(new MsalTokenSource());
        foreach (var method in EntraModes.Methods) SqlAuthenticationProvider.SetProvider(method, service.Provider);
        return service;
    });
    /// <summary>The process's service: SqlClient keeps one provider per method for the whole process.</summary>
    internal static EntraService Shared => shared.Value;

    private readonly SemaphoreSlim signIn = new(1, 1);

    internal EntraService(IEntraTokenSource source)
    {
        Source = source;
        Provider = new EntraAuthenticationProvider(this);
    }

    /// <summary>MSAL and Azure.Identity; the checks put a fake here (and put it back).</summary>
    internal IEntraTokenSource Source { get; set; }
    internal EntraAttempts Attempts { get; } = new();
    internal EntraAuthenticationProvider Provider { get; }
    /// <summary>How long a browser sign-in may take: SqlClient's own interactive limit. The checks shorten it.</summary>
    internal TimeSpan SignInLimit { get; set; } = TimeSpan.FromMinutes(3);
    /// <summary>Microsoft Entra Integrated is Windows-only in SqlClient; the checks pretend otherwise.</summary>
    internal Func<bool> IsWindows { get; set; } = OperatingSystem.IsWindows;

    /// <summary>Refuses, before any network I/O, a type this computer cannot use.</summary>
    internal void Refuse(ConnectOptions options)
    {
        if (options.Authentication == "entraIntegrated" && !IsWindows()) throw new RequestException("AUTH_UNSUPPORTED", EntraFailures.Messages.IntegratedNeedsWindows);
    }

    /// <summary>Opens a connection the user is choosing (connect and Load databases). When MFA has no cached token, signs in
    /// through the browser under the request's token (Stop cancels it), then opens once more with a new connection, which
    /// now finds the token. A sign-in without a user name names the account it used, so the stored connection string picks
    /// that account when several are signed in. Other Entra failures answer AUTH_ENTRA with the dialog's details; anything
    /// else is left to the caller.</summary>
    /// <returns>The open result and the connection string that opened it.</returns>
    internal async Task<(T Opened, string ConnectionString)> OpenForUserAsync<T>(string connectionString, string server, Func<string, CancellationToken, Task<T>> open, CancellationToken token)
    {
        try { return (await open(connectionString, token).ConfigureAwait(false), connectionString); }
        catch (SqlException error) when (!token.IsCancellationRequested && Attempts.Take(error.ClientConnectionId) is { } attempt)
        {
            if (attempt is not InteractionRequired required) throw EntraFailures.Describe(attempt, error, server, details: true);
            var signedIn = await SignInAsync(required.Request, server, token).ConfigureAwait(false);
            var builder = new SqlConnectionStringBuilder(connectionString);
            if (string.IsNullOrWhiteSpace(builder.UserID) && signedIn.Account is { Length: > 0 and <= 128 } account) builder.UserID = account;
            var retry = builder.ConnectionString;
            try { return (await open(retry, token).ConfigureAwait(false), retry); }
            catch (SqlException again) when (!token.IsCancellationRequested && Attempts.Take(again.ClientConnectionId) is { } second)
            {
                // The token is cached under the account that signed in, which is not the user name the connection names.
                throw second is InteractionRequired ? new RequestException("AUTH_ENTRA", EntraFailures.Messages.OtherAccount, new(0, 0, 11, Bounded(server)))
                    : EntraFailures.Describe(second, again, server, details: true);
            }
        }
    }

    /// <summary>Opens a connection made from a connected profile (query sessions, Object Explorer, Script As, object
    /// actions, database and column lists). These never open a browser: a sign-in that must be repeated, or any other Entra
    /// failure, answers AUTH_ENTRA, as an expired Kerberos ticket answers AUTH_KERBEROS.</summary>
    internal async Task OpenPooledAsync(SqlConnection connection, CancellationToken token, Func<SqlConnection, CancellationToken, Task> open)
    {
        try { await open(connection, token).ConfigureAwait(false); }
        catch (SqlException error) when (!token.IsCancellationRequested && Attempts.Take(error.ClientConnectionId) is { } attempt)
        {
            throw EntraFailures.Describe(attempt, error, connection.DataSource, details: false);
        }
    }

    /// <summary>One browser sign-in at a time: a second connect waits, then usually finds the first one's token.</summary>
    internal async Task<EntraToken> SignInAsync(EntraRequest request, string server, CancellationToken token)
    {
        await signIn.WaitAsync(token).ConfigureAwait(false);
        try
        {
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
            limit.CancelAfter(SignInLimit);
            try
            {
                if (await Source.SilentAsync(request, limit.Token).ConfigureAwait(false) is { } cached) return cached;
                return await Source.InteractiveAsync(request, limit.Token).ConfigureAwait(false);
            }
            // Stop: the request answers CANCELLED, whatever MSAL threw while its listener closed.
            catch (Exception) when (token.IsCancellationRequested) { throw new OperationCanceledException(token); }
            catch (Exception) when (limit.IsCancellationRequested) { throw new RequestException("AUTH_ENTRA", EntraFailures.Messages.TimedOut, new(0, 0, 11, Bounded(server))); }
            catch (Exception error) when (error is not (RequestException or OutOfMemoryException))
            {
                throw EntraFailures.Describe(EntraFailures.Map(error, SqlAuthenticationMethod.ActiveDirectoryInteractive), null, server, details: true);
            }
        }
        finally { signIn.Release(); }
    }

    /// <summary>Help › Clear Entra ID Token Cache: every token, credential and pending attempt goes, and so do the pools,
    /// whose idle connections hold tokens of their own.</summary>
    internal void Clear()
    {
        Source.Clear();
        Attempts.Clear();
        SqlConnection.ClearAllPools();
    }

    private static string? Bounded(string server)
    {
        var value = server.Trim();
        return value.Length == 0 ? null : value.Length > ConnectionFailures.MaxServerLength ? value[..ConnectionFailures.MaxServerLength] : value;
    }
}
