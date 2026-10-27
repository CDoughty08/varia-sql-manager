namespace Varia.Backend.Activity;

/// <summary>The session ids Varia's own pooled and Object Actions connections were given when they opened, per connection id:
/// what the Activity Monitor trusts, beyond what a client claims at login, to call a session one of Varia's pools. An id
/// counts only while it can still be Varia's, because SQL Server gives a freed id to the next client: an unpooled
/// connection's until it closes; a pooled one's while a connection holds it and for <see cref="IdleMs"/> after the last
/// closed, past the 4 to 8 minutes SqlClient keeps an idle physical connection before it prunes it (each open refreshes
/// it). The ids of connections that reach one server count for every monitor of that server, so an Object Explorer
/// session of another connection to it is Varia's too; a connection id's ids go when it disconnects. At most one entry per
/// session id per connection id, so bounded by the server's.</summary>
internal sealed class OwnSessionLedger(Func<long>? clock = null)
{
    public const long IdleMs = 10 * 60_000;

    private sealed class Held
    {
        public int Open;
        public bool Pooled;
        public long ClosedAt;
    }

    private readonly Func<long> now = clock ?? (() => Environment.TickCount64);
    private readonly Lock gate = new();
    private readonly Dictionary<string, Dictionary<int, Held>> held = new(StringComparer.Ordinal);

    /// <summary>A connection of <paramref name="connectionId"/> opened under <paramref name="session"/>.</summary>
    public void Opened(string connectionId, int session, bool pooled)
    {
        lock (gate)
        {
            if (!held.TryGetValue(connectionId, out var sessions)) held[connectionId] = sessions = [];
            if (!sessions.TryGetValue(session, out var entry)) sessions[session] = entry = new();
            entry.Open++;
            entry.Pooled = pooled;
        }
    }

    /// <summary>That connection closed: an unpooled one's session has ended, a pooled one's waits in the pool.</summary>
    public void Closed(string connectionId, int session)
    {
        lock (gate)
        {
            if (!held.TryGetValue(connectionId, out var sessions) || !sessions.TryGetValue(session, out var entry)) return;
            if (--entry.Open > 0) return;
            entry.Open = 0;
            if (entry.Pooled) entry.ClosedAt = now();
            else sessions.Remove(session);
        }
    }

    /// <summary>The connection id disconnected: its pools are cleared, and its sessions with them.</summary>
    public void Forget(string connectionId)
    {
        lock (gate) held.Remove(connectionId);
    }

    /// <summary>The ids every connection id that reaches <paramref name="connectionId"/>'s server holds now.</summary>
    /// <param name="serverOf">The server a connection id reaches, null when it is not connected.</param>
    public IReadOnlySet<int> Sessions(string connectionId, Func<string, string?> serverOf)
    {
        var own = new HashSet<int>();
        if (serverOf(connectionId) is not { } server) return own;
        lock (gate)
        {
            var time = now();
            foreach (var (id, sessions) in held)
            {
                if (serverOf(id) != server) continue;
                foreach (var (session, entry) in sessions.ToList())
                {
                    if (entry.Open == 0 && time - entry.ClosedAt > IdleMs) sessions.Remove(session);
                    else own.Add(session);
                }
            }
        }
        return own;
    }
}
