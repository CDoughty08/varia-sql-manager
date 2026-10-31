namespace Varia.Backend.Actions;

/// <summary>A long step's progress (D1c): SQL Server's message 3211, "n percent processed.", which RESTORE, BACKUP and VERIFYONLY
/// send with STATS. Only the number is read, never the text, so a localised server reports too. Each one becomes the running
/// step's percent, which the reply's step carries, and a droppable <c>{ type: 'action.progress', step, percent }</c> EVENT on the
/// actions.execute request, at most once per interval (the catalogue's progressEventMs). <c>step</c> is the index the step takes
/// in the reply. The messages arrive while the statement runs only through a reader: SqlClient's async non-query path holds
/// every info message until the statement ends (probed), so every action statement runs through <see cref="ActionService.ReadAllAsync"/>.</summary>
internal sealed class ActionProgress(Action<object>? send, TimeSpan interval, Func<long>? clock = null)
{
    public const int StatsMessage = 3211;
    private readonly object gate = new();
    private readonly Dictionary<int, int> percents = [];
    private readonly Func<long> clock = clock ?? (() => Environment.TickCount64);
    private int step = -1;
    private long? sent;

    /// <summary>The step that runs next, by its index in the reply; its messages count for it until the next Begin.</summary>
    public void Begin(int index) { lock (gate) step = index; }

    /// <summary>The last percent a step reported, or null when it reported none.</summary>
    public int? PercentOf(int index) { lock (gate) return percents.TryGetValue(index, out var percent) ? percent : null; }

    /// <summary>Takes an informational message: true for a progress message (3211), which the action's kept messages leave out,
    /// so a STATS = 1 restore cannot fill them.</summary>
    public bool Observe(int number, string message)
    {
        if (number != StatsMessage) return false;
        if (Parse(message) is not { } percent) return true;
        int index;
        lock (gate)
        {
            if (step < 0) return true;
            index = step;
            percents[index] = percent;
            var now = this.clock();
            if (send is null || (sent is { } last && now - last < (long)interval.TotalMilliseconds)) return true;
            sent = now;
        }
        send(new { Type = "action.progress", Step = index, Percent = percent });
        return true;
    }

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
