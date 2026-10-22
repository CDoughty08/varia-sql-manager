using System.Collections.Concurrent;
using System.Diagnostics;

namespace Varia.Backend.Live;

/// <summary>Live statements at once: a few per connection id and a few more in the backend (limits.live.statements*), so
/// live views never crowd out a server or the backend. Probes take a gate for each statement, and unary methods on lane live
/// (which take no protocol slot) take one for their SQL through <see cref="LiveService.RunGatedAsync"/>. A wait longer than
/// the caller's budget gives up (null: the caller reports BUSY) rather than queue behind slow statements.</summary>
internal sealed class LiveGates(int perConnection, int total)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> connections = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim all = new(total, total);

    public int Total { get; } = total;
    /// <summary>Statements running now, across connections (the checks read it).</summary>
    public int Busy => Total - all.CurrentCount;

    /// <summary>The connection's gate, then the backend's, within <paramref name="waitMs"/> in all; null when either stays
    /// full that long. Throws OperationCanceledException when <paramref name="token"/> is cancelled, holding nothing.</summary>
    public async Task<IDisposable?> WaitAsync(string connectionId, int waitMs, CancellationToken token)
    {
        var started = Stopwatch.GetTimestamp();
        var gate = connections.GetOrAdd(connectionId, _ => new SemaphoreSlim(perConnection, perConnection));
        if (!await gate.WaitAsync(Math.Max(0, waitMs), token).ConfigureAwait(false)) return null;
        try
        {
            var left = waitMs - (int)Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            if (await all.WaitAsync(Math.Max(0, left), token).ConfigureAwait(false)) return new Lease(gate, all);
        }
        catch
        {
            gate.Release();
            throw;
        }
        gate.Release();
        return null;
    }

    /// <summary>A disconnect: the connection's gate goes (leases still running release the one they took).</summary>
    public void Forget(string connectionId) => connections.TryRemove(connectionId, out _);

    private sealed class Lease(SemaphoreSlim gate, SemaphoreSlim all) : IDisposable
    {
        private int released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref released, 1) != 0) return;
            all.Release();
            gate.Release();
        }
    }
}
