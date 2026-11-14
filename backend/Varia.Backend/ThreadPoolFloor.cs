namespace Varia.Backend;

/// <summary>How many pool threads the backend gets at once, before the pool's slow growth. SqlClient's managed SNI (Linux
/// and macOS) opens a connection synchronously on a pool thread, so tabs opening sessions together hold that many threads.
/// Timers fire through the pool too, a script's deadline among them: with 24 tabs opening at once on one processor's worth
/// of threads, a 1 s deadline fired only after its 5 s batch had finished, and the script reported completed.</summary>
internal static class ThreadPoolFloor
{
    internal const int Threads = 64;

    /// <summary>Raises the pool's minimums to <see cref="Threads"/>, never lowers them. Threads are still made only as work
    /// needs them; below the minimum the pool makes them at once instead of about two a second.</summary>
    internal static void Ensure()
    {
        ThreadPool.GetMinThreads(out var workers, out var completions);
        if (workers < Threads || completions < Threads) ThreadPool.SetMinThreads(Math.Max(workers, Threads), Math.Max(completions, Threads));
    }
}
