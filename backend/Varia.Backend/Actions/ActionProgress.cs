using System.Diagnostics;

namespace Varia.Backend.Actions;

/// <summary>A long step's progress (D1c): SQL Server's message 3211, "n percent processed.", which RESTORE, BACKUP and VERIFYONLY
/// send with STATS. Only the number is read, never the text, so a localised server reports too. Each one becomes the running
/// step's percent, which the reply's step carries, and a droppable <c>{ type: 'action.progress', step, percent }</c> EVENT on the
/// actions.execute request. <c>step</c> is the index the step takes in the reply. Each step's start goes out at once as percent 0,
/// so the page sees a finished step give way to the next even when that one reports nothing for minutes. Its percents go out at
/// most once per interval (the catalogue's progressEventMs) with a trailing edge: a percent the interval held back goes out when
/// the interval ends, or before the next step's start, so a step's last percent is not lost. EVENTs are queued under one lock,
/// so they leave in order. The messages arrive while the statement runs only through a reader: SqlClient's async non-query path
/// holds every info message until the statement ends (probed), so every action statement runs through
/// <see cref="ActionService.ReadAllAsync"/>.</summary>
/// <param name="clock">Milliseconds on a monotonic clock: a Stopwatch, since Environment.TickCount64 moves in 15.6 ms steps on Windows.</param>
/// <param name="later">Runs an action after a delay: the trailing edge.</param>
internal sealed class ActionProgress(Action<object>? send, TimeSpan interval, Func<long>? clock = null, Action<TimeSpan, Action>? later = null)
{
    public const int StatsMessage = 3211;
    private readonly object gate = new();
    private readonly Dictionary<int, int> percents = [];
    private readonly Func<long> clock = clock ?? (() => Stopwatch.GetTimestamp() * 1000 / Stopwatch.Frequency);
    private readonly Action<TimeSpan, Action> later = later ?? ((delay, run) => _ = Task.Delay(delay).ContinueWith(_ => run(), TaskScheduler.Default));
    private int step = -1;
    private long? sent;
    private (int Step, int Percent)? held;
    private bool flushing;

    /// <summary>The step that runs next, by its index in the reply; its messages count for it until the next Begin. Sends what the
    /// interval still held of the step before, then the new step's start (percent 0).</summary>
    public void Begin(int index)
    {
        lock (gate)
        {
            step = index;
            if (send is null) return;
            if (held is { } last) Send(last);
            held = null;
            sent = clock();
            Send((index, 0));
        }
    }

    /// <summary>The last percent a step reported, or null when it reported none.</summary>
    public int? PercentOf(int index) { lock (gate) return percents.TryGetValue(index, out var percent) ? percent : null; }

    /// <summary>Takes an informational message: true for a progress message (3211), which the action's kept messages leave out,
    /// so a STATS = 1 restore cannot fill them.</summary>
    public bool Observe(int number, string message)
    {
        if (number != StatsMessage) return false;
        if (Parse(message) is not { } percent) return true;
        lock (gate)
        {
            if (step < 0) return true;
            percents[step] = percent;
            if (send is null) return true;
            var now = clock();
            var gap = (long)interval.TotalMilliseconds;
            if (sent is { } last && now - last < gap)
            {
                held = (step, percent);
                if (!flushing)
                {
                    flushing = true;
                    later(TimeSpan.FromMilliseconds(last + gap - now), Flush);
                }
                return true;
            }
            sent = now;
            held = null;
            Send((step, percent));
        }
        return true;
    }

    /// <summary>The trailing edge: sends the percent the interval held back, unless a later one or a new step already went out.</summary>
    private void Flush()
    {
        lock (gate)
        {
            flushing = false;
            if (held is not { } due) return;
            held = null;
            sent = clock();
            Send(due);
        }
    }

    private void Send((int Step, int Percent) value) => send!(new { Type = "action.progress", value.Step, value.Percent });

    /// <summary>The message's first number of 1 to 3 digits, when it is a percent (0-100).</summary>
    internal static int? Parse(string message)
    {
        var start = 0;
        while (start < message.Length && !char.IsAsciiDigit(message[start])) start++;
        var end = start;
        while (end < message.Length && char.IsAsciiDigit(message[end])) end++;
        if (end == start || end - start > 3) return null;
        var value = int.Parse(message.AsSpan(start, end - start), System.Globalization.CultureInfo.InvariantCulture);
        return value <= 100 ? value : null;
    }
}
