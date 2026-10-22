using System.Collections.Concurrent;

namespace Varia.Backend.Common;

/// <summary>The running requests of a service that main names by the renderer's requestId (Object Explorer, scripting):
/// a duplicate id is refused, the count is bounded, and a disconnect cancels a connection's requests. Main keeps the
/// tombstones for ids cancelled before they arrived and sends a CANCEL frame for the rest, so none are needed here.</summary>
internal sealed class RequestRegistry(int capacity, string noun)
{
    private readonly ConcurrentDictionary<string, Entry> running = new(StringComparer.Ordinal);

    public sealed class Entry(string connectionId, CancellationTokenSource source)
    {
        public string ConnectionId { get; } = connectionId;
        /// <summary>A disconnect or shutdown cancelled it; the request answers CANCELLED rather than its own timeout.</summary>
        public bool Forgotten { get; private set; }
        private readonly CancellationTokenSource forgotten = new();
        /// <summary>Cancelled by a disconnect or shutdown only, never by Stop: what a reply that outlives Stop still waits on.</summary>
        public CancellationToken ForgottenToken => forgotten.Token;

        public void Forget()
        {
            Forgotten = true;
            forgotten.Cancel();
            try { source.Cancel(); } catch (ObjectDisposedException) { /* Finished concurrently. */ }
        }
    }

    public int Capacity { get; } = capacity;
    public int Count => running.Count;

    /// <summary>Throws BUSY past the capacity and DUPLICATE_REQUEST for an id already running.</summary>
    public Entry Register(string requestId, string connectionId, CancellationTokenSource source)
    {
        if (running.Count >= Capacity) throw new RequestException("BUSY", "Too many " + noun + " requests are running. Retry after some finish.");
        var entry = new Entry(connectionId, source);
        if (!running.TryAdd(requestId, entry)) throw new RequestException("DUPLICATE_REQUEST", "This " + noun + " request is already running.");
        return entry;
    }

    public void Unregister(string requestId, Entry entry) => ((ICollection<KeyValuePair<string, Entry>>)running).Remove(new(requestId, entry));

    public void Forget(string connectionId)
    {
        foreach (var entry in running.Values.Where(entry => entry.ConnectionId == connectionId)) entry.Forget();
    }

    public void ForgetAll()
    {
        foreach (var entry in running.Values) entry.Forget();
    }
}
