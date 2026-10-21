using System.Collections.Concurrent;

namespace Varia.Backend.Entra;

/// <summary>Why the provider gave SqlClient no token: a sign-in in the browser is needed, or the sign-in failed.</summary>
internal abstract record EntraAttempt;
/// <summary>No cached token: the Connect dialog can sign in through the browser; any other open cannot.</summary>
internal sealed record InteractionRequired(EntraRequest Request) : EntraAttempt;
/// <summary>A failed sign-in, answered with <paramref name="Code"/> (AUTH_ENTRA, or AUTH_UNSUPPORTED). <paramref name="Number"/>
/// is the AADSTS number main uses to forget a rejected remembered password (50126 and 7000215 only). Without
/// <paramref name="Explained"/>, the message is MSAL's or Azure.Identity's own and follows SqlClient's first line.</summary>
internal sealed record EntraFailure(string Code, string Message, int? Number = null, bool Explained = true) : EntraAttempt;
/// <summary>A token given to Microsoft Entra MFA without a user name, and the account it is for: the Connect dialog names that
/// account in the connection string it keeps, so later opens find the same account's token when several are signed in.</summary>
internal sealed record Served(string Account) : EntraAttempt;

/// <summary>What the provider recorded for each connection attempt (a failure, or the account an MFA token without a user
/// name is for), by SqlClient's ClientConnectionId: SqlClient turns a provider's exception into a SqlException with no inner
/// exception, and that SqlException carries the same id. Entries are taken once, and expire after 2 minutes; at most 256
/// are kept.</summary>
internal sealed class EntraAttempts
{
    internal const int MaxEntries = 256;
    internal static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(2);
    private readonly ConcurrentDictionary<Guid, (EntraAttempt Attempt, long At)> entries = new();
    private readonly Lock gate = new();

    /// <summary>Milliseconds on a monotonic clock; the checks move it.</summary>
    internal Func<long> Now { get; set; } = () => Environment.TickCount64;
    internal int Count => entries.Count;

    internal void Record(Guid connectionId, EntraAttempt attempt)
    {
        // Without an id the failure cannot be joined; the SqlException's own text is answered then.
        if (connectionId == Guid.Empty) return;
        lock (gate)
        {
            Prune();
            while (entries.Count >= MaxEntries && Oldest() is { } oldest) entries.TryRemove(oldest, out _);
            entries[connectionId] = (attempt, Now());
        }
    }

    internal EntraAttempt? Take(Guid connectionId) =>
        connectionId != Guid.Empty && entries.TryRemove(connectionId, out var entry) && Now() - entry.At <= Lifetime.TotalMilliseconds ? entry.Attempt : null;

    internal void Clear() => entries.Clear();

    private void Prune()
    {
        var cutoff = Now() - (long)Lifetime.TotalMilliseconds;
        foreach (var (id, entry) in entries) if (entry.At < cutoff) entries.TryRemove(id, out _);
    }

    private Guid? Oldest()
    {
        Guid? oldest = null;
        long at = long.MaxValue;
        foreach (var (id, entry) in entries) if (entry.At < at) { at = entry.At; oldest = id; }
        return oldest;
    }
}
