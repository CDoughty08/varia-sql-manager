namespace Varia.Backend.Common;

/// <summary>Keeps the backend from exiting halfway through killing a child's process tree. On Linux and macOS .NET's
/// tree kill stops the process (SIGSTOP), lists its children, and only then kills it. A backend that exited in between
/// left the child stopped for good: a stopped process never notices that its parent left, and it keeps open every
/// descriptor it inherited. A kill and the exit take the same lock, so the exit waits for a kill that is under way, and
/// none starts once the exit has begun.</summary>
internal sealed class ExitGate
{
    /// <summary>The backend's own gate; checks pass theirs.</summary>
    public static readonly ExitGate Shared = new();
    private readonly Lock gate = new();
    private int waiting;

    /// <summary>Callers waiting for the gate, for checks that must know a caller is held rather than still on its way.</summary>
    public int Waiting => Volatile.Read(ref waiting);

    /// <summary>Runs <paramref name="kill"/> once per <paramref name="done"/>. A second caller returns only after the
    /// first one's kill has ended, so it can release the child's handles.</summary>
    public void Kill(ref bool done, Action kill)
    {
        Interlocked.Increment(ref waiting);
        lock (gate)
        {
            Interlocked.Decrement(ref waiting);
            if (done) return;
            done = true;
            kill();
        }
    }

    public void Exit(Action<int> exit, int code)
    {
        Interlocked.Increment(ref waiting);
        lock (gate)
        {
            Interlocked.Decrement(ref waiting);
            exit(code);
        }
    }
}
