using System.Diagnostics;

namespace Varia.Backend.Results;

/// <summary>How far an operation over a whole result has got (a sort or filter, a profile, distinct values, a pivot, a
/// diff), sent as droppable <c>op.progress</c> EVENTs on its request at most every <see cref="Interval"/>: the phase it is
/// in and a percentage of the whole that never goes back, or none while the phase has no total (a diff looking for row
/// keys). The operation names its phases and where each ends (<see cref="Phase"/>); the work inside them is counted where
/// it is shared out, one item at a time: each <see cref="ViewSorter.WorkerGate.Lease.For{TState}"/> step of a lease taken
/// while this is <see cref="Current"/> is a step of the phase, and loops of their own count through <see cref="Count"/>.
/// A phase whose steps are not known ahead gives each new step half of what the phase has left, so the figure never
/// passes the phase's end. Nothing goes out in the first interval, so a quick operation sends nothing; nothing goes out
/// after the answer either (<see cref="Protocol.RequestContext.SendEvent"/> drops it).</summary>
internal sealed class OperationProgress
{
    public static readonly TimeSpan Interval = TimeSpan.FromMilliseconds(250);
    private static readonly AsyncLocal<OperationProgress?> current = new();

    /// <summary>The progress of the operation running on this flow (set by <c>SqlService.UntilReleased</c>), or none.</summary>
    public static OperationProgress? Current
    {
        get => current.Value;
        set => current.Value = value;
    }

    private readonly Action<string, int?> send;
    private readonly long interval;
    private readonly Lock sync = new();
    private string phase = "start";
    private bool known = true, complete;
    // Fractions of the whole: the value at the start of the open step, where the step and the phase end.
    private double cursor, stepEnd, phaseEnd;
    private int stepsLeft, firstShares = 1, items, done, open, sent = -1;
    private string? sentPhase;
    private bool sentKnown = true;
    private long next;

    public OperationProgress(Action<string, int?> send, TimeSpan? interval = null)
    {
        this.send = send;
        this.interval = (long)((interval ?? Interval).TotalSeconds * Stopwatch.Frequency);
        next = Stopwatch.GetTimestamp() + this.interval;
    }

    /// <summary>The figure now, 0 – 100: 100 only once <see cref="Complete"/>.</summary>
    public int Percent
    {
        get
        {
            lock (sync) return complete ? 100 : Math.Max(sent, Floor());
        }
    }

    /// <summary>The phase now.</summary>
    public string PhaseName
    {
        get { lock (sync) return phase; }
    }

    /// <summary>Starts phase <paramref name="id"/>, which ends at <paramref name="until"/> (0 – 1) of the whole and takes
    /// <paramref name="steps"/> counted steps if known (0: not known). Without a total (<paramref name="known"/> false) the
    /// EVENTs carry no percentage until the next phase that has one.</summary>
    public void Phase(string id, double until, int steps = 0, bool known = true)
    {
        lock (sync)
        {
            cursor = Value();
            stepEnd = cursor;
            phaseEnd = Math.Max(cursor, Math.Min(1, until));
            stepsLeft = Math.Max(0, steps);
            firstShares = 1;
            items = 0;
            done = 0;
            phase = id;
            this.known = known;
        }
        Tick();
    }

    /// <summary>The shares left in the phase, when it learns them only as it starts (a sort's slices and merge rounds): each
    /// counted step takes one, the next one <paramref name="first"/>. A phase that already has shares keeps its own.</summary>
    public void Steps(int steps, int first = 1)
    {
        lock (sync)
            if (stepsLeft == 0 && items == 0)
            {
                stepsLeft = Math.Max(0, steps);
                firstShares = Math.Clamp(first, 1, Math.Max(1, stepsLeft));
            }
    }

    /// <summary>Opens a counted step of <paramref name="count"/> items: false (count nothing) while another step is open,
    /// which is a step nested inside one of its items.</summary>
    internal bool Open(int count)
    {
        if (Interlocked.CompareExchange(ref open, 1, 0) != 0) return false;
        lock (sync)
        {
            cursor = Value();
            var left = phaseEnd - cursor;
            var shares = Math.Min(firstShares, stepsLeft);
            stepEnd = cursor + (stepsLeft > 0 ? left * shares / stepsLeft : left / 2);
            if (stepsLeft > 0) stepsLeft -= shares;
            firstShares = 1;
            items = Math.Max(1, count);
            done = 0;
        }
        return true;
    }

    /// <summary>One item of the open step is done (any thread).</summary>
    internal void Done()
    {
        Interlocked.Increment(ref done);
        Tick();
    }

    /// <summary>Closes the open step: its share is done, or as much of it as its items that ran (a step that threw, such
    /// as a profile pass given up to try again on one thread, leaves the rest of its share to what follows).</summary>
    internal void Close()
    {
        lock (sync)
        {
            cursor = Volatile.Read(ref done) >= items ? Math.Max(cursor, stepEnd) : Value();
            items = 0;
            done = 0;
        }
        Volatile.Write(ref open, 0);
    }

    /// <summary>A counted step for a loop of the operation's own (one thread): dispose it when the loop ends.</summary>
    public Counter Count(int count) => new(this, Open(count));

    /// <summary>The operation has finished: <see cref="Percent"/> is 100. Nothing is sent: its answer follows.</summary>
    public void Complete()
    {
        lock (sync) complete = true;
    }

    /// <summary>Sends the phase and figure once an interval has passed since the last, when either changed.</summary>
    private void Tick()
    {
        var now = Stopwatch.GetTimestamp();
        if (now < Volatile.Read(ref next)) return;
        lock (sync)
        {
            if (now < next || complete) return;
            next = now + interval;
            var figure = Math.Max(sent, Floor());
            if (phase == sentPhase && known == sentKnown && (!known || figure == sent)) return;
            if (known) sent = figure;
            sentPhase = phase;
            sentKnown = known;
            // Sent under the lock: two threads past the interval at once would otherwise queue their figures out of order.
            // Queuing a droppable EVENT does not block (it is dropped when the lane is full).
            send(phase, known ? figure : null);
        }
    }

    // The callers hold sync.
    private double Value() => items == 0 ? cursor : cursor + (stepEnd - cursor) * Math.Min(Volatile.Read(ref done), items) / items;

    private int Floor() => Math.Clamp((int)(Value() * 100), 0, 99);

    /// <summary>A counted step of a loop: <see cref="Done"/> per item, closed on dispose.</summary>
    public readonly struct Counter(OperationProgress? progress, bool opened) : IDisposable
    {
        public void Done()
        {
            if (opened) progress!.Done();
        }

        public void Dispose()
        {
            if (opened) progress!.Close();
        }
    }
}
