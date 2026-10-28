using System.Collections.Concurrent;
using System.Diagnostics;

namespace Varia.Backend.Live;

/// <summary>Live statements at once: a few per connection id and a few more in the backend (limits.live.statements*), so
/// live views never crowd out a server or the backend. Probes take a gate for each statement, and unary methods on lane live
/// (which take no protocol slot) take one for their SQL through <see cref="LiveService.RunGatedAsync"/>. A wait longer than
/// the caller's budget gives up (null: the caller reports BUSY) rather than queue behind slow statements. Gates exist only
/// for connected ids: an unknown one is NOT_CONNECTED before anything is added, and a gate whose id went away while it was
/// held goes once its last lease is back, so ids that a request names never accumulate.</summary>
internal sealed class LiveGates(int perConnection, int total, Func<string, bool>? isConnected = null)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> connections = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim all = new(total, total);

    public int Total { get; } = total;
    /// <summary>Statements running now, across connections (the checks read it).</summary>
    public int Busy => Total - all.CurrentCount;
    /// <summary>Connection ids with a gate (the checks read it).</summary>
    public int Connections => connections.Count;

    /// <summary>The connection's gate, then the backend's, within <paramref name="waitMs"/> in all; null when either stays
    /// full that long. Throws OperationCanceledException when <paramref name="token"/> is cancelled, and NOT_CONNECTED for an
    /// id that is not connected, holding nothing.</summary>
    public async Task<IDisposable?> WaitAsync(string connectionId, int waitMs, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (isConnected is not null && !isConnected(connectionId)) throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");
        var started = Stopwatch.GetTimestamp();
        var gate = connections.GetOrAdd(connectionId, _ => new SemaphoreSlim(perConnection, perConnection));
        try
        {
            if (!await gate.WaitAsync(Math.Max(0, waitMs), token).ConfigureAwait(false)) return null;
            try
            {
                var left = waitMs - (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds;
                if (await all.WaitAsync(Math.Max(0, left), token).ConfigureAwait(false)) return new Lease(this, connectionId, gate);
            }
            catch
            {
                gate.Release();
                throw;
            }
            gate.Release();
            return null;
        }
        finally
        {
            // A disconnect may have raced the add (Forget ran first): the gate goes once nothing holds it.
            Sweep(connectionId, gate);
        }
    }

    /// <summary>A disconnect: the connection's gate goes (leases still running release the one they took).</summary>
    public void Forget(string connectionId) => connections.TryRemove(connectionId, out _);

    private void Sweep(string connectionId, SemaphoreSlim gate)
    {
        if (isConnected is not null && !isConnected(connectionId) && gate.CurrentCount == perConnection)
            connections.TryRemove(new KeyValuePair<string, SemaphoreSlim>(connectionId, gate));
    }

    private sealed class Lease(LiveGates owner, string connectionId, SemaphoreSlim gate) : IDisposable
    {
        private int released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref released, 1) != 0) return;
            owner.all.Release();
            gate.Release();
            owner.Sweep(connectionId, gate);
        }
    }
}
