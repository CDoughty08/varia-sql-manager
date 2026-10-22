namespace Varia.Backend.Protocol;

/// <summary>What a method waits for before it runs (the lanes of src/shared/ipc/methods.ts): control runs at once,
/// metadata takes one of 8 slots, query uses the session path, results one of 16 read slots, explorer runs at once
/// under Object Explorer's own gates (static folders need no slot at all), and actions runs DDL at once under the action
/// service's own gates, so a DROP waiting on a lock never holds a metadata slot.</summary>
internal enum RequestLane { Control, Metadata, Query, Results, Explorer, Actions, Ssis }

/// <summary>Why a request's token was cancelled: CANCEL frame reasons 1–4, or its own header deadline.</summary>
internal enum CancelReason { None = 0, User = 1, Deadline = 2, ConsumerGone = 3, Shutdown = 4, Expired = 5 }

/// <summary>One REQUEST from main: the token that CANCEL frames and the header deadline cancel, stream credit, and
/// exactly-once settlement. Every id gets exactly one RESPONSE, whichever of the handler, a deadline or a CANCEL comes first.</summary>
internal sealed class RequestContext : IDisposable
{
    private readonly CancellationTokenSource source = new();
    private readonly CancellationTokenRegistration registration;
    private readonly Action<RequestContext, uint, byte[]>? sendData;
    private readonly Action<RequestContext, object, bool>? sendEvent;
    private readonly object gate = new();
    private readonly long started = Environment.TickCount64;
    private int settled;
    private int reason;
    private long credit;
    private uint sequence;
    private TaskCompletionSource? creditWaiter;

    public RequestContext(uint id, string method, RequestLane lane, uint deadlineMs, long? credit = null,
        Action<RequestContext>? cancelled = null, Action<RequestContext, uint, byte[]>? sendData = null, Action<RequestContext, object, bool>? sendEvent = null)
    {
        Id = id;
        Method = method;
        Lane = lane;
        DeadlineMs = deadlineMs;
        IsStream = credit is not null;
        this.credit = credit ?? 0;
        this.sendData = sendData;
        this.sendEvent = sendEvent;
        registration = source.Token.Register(() =>
        {
            // A header deadline cancels with no reason recorded; claim it, so a later CANCEL cannot relabel the outcome.
            Interlocked.CompareExchange(ref reason, (int)CancelReason.Expired, 0);
            WakeCreditWaiter();
            cancelled?.Invoke(this);
        });
        if (deadlineMs > 0) source.CancelAfter(TimeSpan.FromMilliseconds(deadlineMs));
    }

    public uint Id { get; }
    public string Method { get; }
    public RequestLane Lane { get; }
    /// <summary>The header deadline in milliseconds; 0 means none.</summary>
    public uint DeadlineMs { get; }
    /// <summary>Stream requests carry credit; their DATA and terminal RESPONSE use the bulk lane.</summary>
    public bool IsStream { get; }
    public CancellationToken Token => source.Token;
    public CancelReason Reason => (CancelReason)Volatile.Read(ref reason);
    public bool IsSettled => Volatile.Read(ref settled) != 0;

    /// <summary>The time left before the header deadline, or null when the request has none.</summary>
    public TimeSpan? Remaining => DeadlineMs == 0 ? null : TimeSpan.FromMilliseconds(Math.Max(0, DeadlineMs - (Environment.TickCount64 - started)));

    /// <summary>Called when the handler's result could not be encoded (RESPONSE_TOO_LARGE), so whatever it created for main
    /// to own, such as stored results, is released instead of being left without an owner.</summary>
    public Action? Unsent { get; set; }

    /// <summary>True exactly once; the caller that wins writes the RESPONSE.</summary>
    public bool TrySettle() => Interlocked.Exchange(ref settled, 1) == 0;

    public void Cancel(CancelReason why)
    {
        if (Interlocked.CompareExchange(ref reason, (int)why, 0) != 0) return;
        try { source.Cancel(); }
        catch (ObjectDisposedException) { /* The handler finished concurrently. */ }
    }

    /// <summary>Adds credit from a CREDIT frame and wakes a producer waiting for it.</summary>
    public void Grant(uint bytes)
    {
        lock (gate) credit += bytes;
        WakeCreditWaiter();
    }

    /// <summary>Sends one DATA frame once credit is positive. Credit may go negative by at most this one frame, so a
    /// page larger than the credit never deadlocks the stream. The body array is written as is (a stored page is not
    /// copied), so it must not change afterwards. Throws OperationCanceledException when cancelled.</summary>
    public async ValueTask SendDataAsync(byte[] body)
    {
        if (sendData is null || !IsStream) throw new InvalidOperationException("DATA frames belong to stream requests.");
        while (true)
        {
            Task wait;
            lock (gate)
            {
                Token.ThrowIfCancellationRequested();
                if (credit > 0)
                {
                    credit -= body.Length;
                    // Enqueued under the lock, so frames leave in sequence order.
                    sendData(this, ++sequence, body);
                    return;
                }
                creditWaiter ??= new(TaskCreationOptions.RunContinuationsAsynchronously);
                wait = creditWaiter.Task;
            }
            await wait.WaitAsync(Token).ConfigureAwait(false);
        }
    }

    /// <summary>Queues an EVENT frame for this request (query events). Events after the answer are dropped, so they always
    /// precede it; a droppable event may also be dropped while main is not reading.</summary>
    public void SendEvent(object value, bool droppable)
    {
        if (!IsSettled) sendEvent?.Invoke(this, value, droppable);
    }

    private void WakeCreditWaiter()
    {
        TaskCompletionSource? waiter;
        lock (gate) { waiter = creditWaiter; creditWaiter = null; }
        waiter?.TrySetResult();
    }

    public void Dispose()
    {
        registration.Dispose();
        source.Dispose();
    }
}
