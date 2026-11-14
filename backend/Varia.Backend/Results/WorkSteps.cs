namespace Varia.Backend.Results;

/// <summary>Working memory an operation takes in steps as it meets what needs it (a profile's long values, a diff's
/// differing cells, a pivot's figures and then its Distinct Count bounds), charged to its query's budget. A step of <see cref="ResultStore.WorkCheckBytes"/>
/// or more asks the system's memory load as <see cref="ResultStore.TryReserveWork"/> does; smaller steps ask only when
/// their total passes another <see cref="ResultStore.WorkCheckBytes"/> held, so gigabytes taken a few kilobytes at a time
/// are refused under high memory load as one request that large would be, without a load reading per step. Safe to use
/// from several threads: the bytes are counted before asking, so of steps taken together exactly one sees each crossing
/// (while none is refused; the operations using it stop at their first refusal).
/// <see cref="Held"/> is what the operation gives back when it ends.</summary>
internal sealed class WorkSteps(ResultStore store, QueryBudget query)
{
    private long held;
    private int lowMemory;

    /// <summary>The bytes taken and not refused.</summary>
    public long Held => Interlocked.Read(ref held);

    /// <summary>Whether a step was refused for the system's memory load rather than the budget.</summary>
    public bool LowMemory => Volatile.Read(ref lowMemory) != 0;

    public bool TryReserve(long bytes)
    {
        if (bytes <= 0) return true;
        var after = Interlocked.Add(ref held, bytes);
        var mark = store.WorkStepBytes;
        var check = bytes >= mark || after / mark != (after - bytes) / mark;
        if (store.TryReserve(query, bytes, check, out var reason)) return true;
        // Taken back, so the next step passes the same mark and asks again.
        Interlocked.Add(ref held, -bytes);
        if (reason == TruncationReason.SystemMemory) Volatile.Write(ref lowMemory, 1);
        return false;
    }
}
