namespace Varia.Backend.Protocol;

/// <summary>What a method waits for before it runs (the lanes of src/shared/ipc/methods.ts): control runs at once,
/// metadata takes one of 8 slots, query uses the session path, results one of 16 read slots, explorer runs at once
/// under Object Explorer's own gates (static folders need no slot at all), actions runs DDL at once under the action
/// service's own gates, so a DROP waiting on a lock never holds a metadata slot (Kill Process runs there under gates of its
/// own), and ssis runs SSIS Catalog reads and writes at once under the SSIS services' own gates. A live subscription takes no
/// slot: it samples on its own task, one tick at a time, and answers only when it ends; its statements, and a unary live
/// method's (activity.details, through LiveService.RunGatedAsync), run under the live gates.</summary>
internal enum RequestLane { Control, Metadata, Query, Results, Explorer, Actions, Live, Ssis }

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
    private readonly Func<RequestContext, object, int>? sendCreditedEvent;
    private readonly object gate = new();
    private readonly long started = Environment.TickCount64;
    private int settled;
    private int reason;
    private long credit;
    private uint sequence;
    private TaskCompletionSource? creditWaiter;

    /// <param name="sendCreditedEvent">Encodes and queues a live EVENT, returning its body length, or −1 (nothing queued)
    /// when it is over the 256 KiB event limit.</param>
    public RequestContext(uint id, string method, RequestLane lane, uint deadlineMs, long? credit = null,
        Action<RequestContext>? cancelled = null, Action<RequestContext, uint, byte[]>? sendData = null, Action<RequestContext, object, bool>? sendEvent = null,
        Func<RequestContext, object, int>? sendCreditedEvent = null)
    {
        Id = id;
        Method = method;
        Lane = lane;
        DeadlineMs = deadlineMs;
        IsStream = credit is not null;
        this.credit = credit ?? 0;
        InitialCredit = credit ?? 0;
        this.sendData = sendData;
        this.sendEvent = sendEvent;
        this.sendCreditedEvent = sendCreditedEvent;
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
    /// <summary>Stream requests carry credit; their DATA and terminal RESPONSE use the bulk lane. A live subscription's
    /// EVENTs use the control lane, which is drained first, so its RESPONSE still follows them.</summary>
    public bool IsStream { get; }
    /// <summary>The credit the REQUEST carried; a live EVENT is sent only while all of it is available.</summary>
    public long InitialCredit { get; }
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

    /// <summary>Queues a live EVENT (live.subscribe) only while nothing is unacknowledged: the available credit is back to
    /// the initial credit. Its body length is then taken from the credit (it may go negative by this one frame), and main
    /// grants it back once the renderer has applied it. False while a frame is outstanding or once the request is settled;
    /// throws OperationCanceledException once cancelled, and BACKEND_ERROR for a frame over the event limit (a bug, never
    /// a silent drop).</summary>
    public bool TrySendCreditedEvent(object value)
    {
        if (sendCreditedEvent is null || !IsStream) throw new InvalidOperationException("Credited EVENT frames belong to live subscriptions.");
        lock (gate)
        {
            Token.ThrowIfCancellationRequested();
            if (IsSettled || credit < InitialCredit) return false;
            var length = sendCreditedEvent(this, value);
            if (length < 0) throw new RequestException("BACKEND_ERROR", "A live update was too large to send.");
            credit -= length;
            return true;
        }
    }

    /// <summary>Completes once the outstanding live EVENT has been acknowledged (credit back to the initial credit), at once
    /// when none is outstanding. Throws OperationCanceledException when <paramref name="token"/> or the request is cancelled.</summary>
    public async Task WaitForAckAsync(CancellationToken token)
    {
        while (true)
        {
            Task wait;
            lock (gate)
            {
                token.ThrowIfCancellationRequested();
                Token.ThrowIfCancellationRequested();
                if (credit >= InitialCredit) return;
                creditWaiter ??= new(TaskCreationOptions.RunContinuationsAsynchronously);
                wait = creditWaiter.Task;
            }
            await wait.WaitAsync(token).ConfigureAwait(false);
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
