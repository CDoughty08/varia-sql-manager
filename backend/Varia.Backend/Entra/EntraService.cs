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
    // Bumped by each clear, so a sign-in that a clear overtook says so.
    private int generation;

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
    /// now finds the token. MFA without a user name opens unpooled (SqlClient reuses a pool's token without asking the
    /// provider), so the provider says which account it used, and the connection string returned names that account: later
    /// opens then find that account's token even when several are signed in. Other Entra failures answer AUTH_ENTRA with the
    /// dialog's details; anything else is left to the caller.</summary>
    /// <param name="idOf">The opened connection's ClientConnectionId, under which the provider recorded the account.</param>
    /// <returns>The open result and the connection string to keep.</returns>
    internal async Task<(T Opened, string ConnectionString)> OpenForUserAsync<T>(string connectionString, string server, Func<string, CancellationToken, Task<T>> open, Func<T, Guid> idOf, CancellationToken token)
    {
        async Task<(T, string)> Attempt(string text)
        {
            if (!AnonymousMfa(text)) return (await open(text, token).ConfigureAwait(false), text);
            var opened = await open(new SqlConnectionStringBuilder(text) { Pooling = false }.ConnectionString, token).ConfigureAwait(false);
            return (opened, Attempts.Take(idOf(opened)) is Served served ? new SqlConnectionStringBuilder(text) { UserID = served.Account }.ConnectionString : text);
        }
        try { return await Attempt(connectionString).ConfigureAwait(false); }
        catch (SqlException error) when (!token.IsCancellationRequested && Failure(error, connectionString) is { } attempt)
        {
            if (attempt is not InteractionRequired required) throw EntraFailures.Describe(attempt, error, server, details: true);
            var generation = Volatile.Read(ref this.generation);
            var signedIn = await SignInAsync(required.Request, server, token).ConfigureAwait(false);
            var builder = new SqlConnectionStringBuilder(connectionString);
            if (string.IsNullOrWhiteSpace(builder.UserID) && signedIn.Account is { Length: > 0 and <= 128 } account) builder.UserID = account;
            var retry = builder.ConnectionString;
            try { return await Attempt(retry).ConfigureAwait(false); }
            catch (SqlException again) when (!token.IsCancellationRequested && Failure(again, retry) is { } second)
            {
                if (second is not InteractionRequired) throw EntraFailures.Describe(second, again, server, details: true);
                // The token went into the cache that Help › Clear Entra ID Token Cache emptied while the browser waited; otherwise
                // it is cached under the account that signed in, which is not the user name the connection names.
                throw new RequestException("AUTH_ENTRA", generation != Volatile.Read(ref this.generation) ? EntraFailures.Messages.ClearedDuringSignIn : EntraFailures.Messages.OtherAccount,
                    new(0, 0, 11, Bounded(server)));
            }
        }
    }

    /// <summary>Opens a connection made from a connected profile (query sessions, Object Explorer, Script As, object
    /// actions, database and column lists). These never open a browser: a sign-in that must be repeated, or any other Entra
    /// failure, answers AUTH_ENTRA, as an expired Kerberos ticket answers AUTH_KERBEROS.</summary>
    internal async Task OpenPooledAsync(SqlConnection connection, CancellationToken token, Func<SqlConnection, CancellationToken, Task> open)
    {
        try { await open(connection, token).ConfigureAwait(false); }
        catch (SqlException error) when (!token.IsCancellationRequested && Failure(error, connection.ConnectionString) is { } attempt)
        {
            throw EntraFailures.Describe(attempt, error, connection.DataSource, details: false);
        }
    }

    /// <summary>What the provider recorded for a failed open. When it recorded nothing (if SqlClient stopped giving the
    /// exception the attempt's ClientConnectionId, say) but SqlClient reports its provider's failure (error 0, class 11) on
    /// an Entra connection, SqlClient's own text is the answer, as AUTH_ENTRA; any other failure is left to the caller.</summary>
    private EntraAttempt? Failure(SqlException error, string connectionString)
    {
        // A Served entry means the token was given and the login failed after it (18456, say): that is SQL Server's answer.
        if (Attempts.Take(error.ClientConnectionId) is (InteractionRequired or EntraFailure) and var recorded) return recorded;
        if (!UsesEntra(connectionString) || error.Errors.Count == 0 || error.Errors[0] is not { Number: 0, Class: 11 }) return null;
        var text = EntraFailures.Sanitize(error.Message);
        return new EntraFailure("AUTH_ENTRA", text.Length > 0 ? text : EntraFailures.Messages.SignInFailed);
    }

    private static bool UsesEntra(string connectionString)
    {
        try { return Array.IndexOf(EntraModes.Methods, new SqlConnectionStringBuilder(connectionString).Authentication) >= 0; }
        catch (ArgumentException) { return false; }
    }

    private static bool AnonymousMfa(string connectionString)
    {
        var builder = new SqlConnectionStringBuilder(connectionString);
        return builder.Authentication == SqlAuthenticationMethod.ActiveDirectoryInteractive && string.IsNullOrWhiteSpace(builder.UserID);
    }

    /// <summary>One browser sign-in at a time: a second connect waits, then usually finds the first one's token. The limit
    /// counts that wait too, so a connect queued behind another sign-in still ends within main's deadline.</summary>
    internal async Task<EntraToken> SignInAsync(EntraRequest request, string server, CancellationToken token)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
        limit.CancelAfter(SignInLimit);
        try { await signIn.WaitAsync(limit.Token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { throw TimedOut(server); }
        try
        {
            try
            {
                if (await Source.SilentAsync(request, limit.Token).ConfigureAwait(false) is { } cached) return cached;
                return await Source.InteractiveAsync(request, limit.Token).ConfigureAwait(false);
            }
            // Stop: the request answers CANCELLED, whatever MSAL threw while its listener closed.
            catch (Exception) when (token.IsCancellationRequested) { throw new OperationCanceledException(token); }
            catch (Exception) when (limit.IsCancellationRequested) { throw TimedOut(server); }
            catch (Exception error) when (error is not (RequestException or OutOfMemoryException))
            {
                throw EntraFailures.Describe(EntraFailures.Map(error, SqlAuthenticationMethod.ActiveDirectoryInteractive), null, server, details: true);
            }
        }
        finally { signIn.Release(); }
    }

    private static RequestException TimedOut(string server) => new("AUTH_ENTRA", EntraFailures.Messages.TimedOut, new(0, 0, 11, Bounded(server)));

    /// <summary>Help › Clear Entra ID Token Cache: every token, credential and pending attempt goes, and so do the pools,
    /// whose idle connections hold tokens of their own.</summary>
    internal void Clear()
    {
        Interlocked.Increment(ref generation);
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
