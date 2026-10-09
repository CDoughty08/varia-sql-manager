namespace Varia.Backend.Results;

/// <summary>A query's EVENT frames (docs/ipc.md): resultSet.opened and resultSet.closed as they happen, progress at most
/// 10 times a second (latest value wins), and stored messages every 100 ms or 64 KiB. It never blocks the query task:
/// emitting only queues a frame, and progress is sampled by a timer. Disposing flushes, and nothing is emitted after
/// that, so every event precedes the query's summary. The summary stays authoritative; progress and messages may be
/// dropped when main is not reading.</summary>
internal sealed class QueryEventSink : IDisposable
{
    public const int MaxProgressResults = 64;
    private const int FlushCharacters = 64 * 1024;
    private const int IntervalMs = 100;
    private readonly Action<object, bool>? emit;
    private readonly object gate = new();
    private readonly List<ResultSetBuffer> open = [];
    private readonly List<string> messages = [];
    private readonly Timer? timer;
    private int characters;
    private volatile bool dirty;
    private bool stopped;
    private int completedBatches, totalBatches, batchNumber, iteration;

    /// <param name="emit">Queues an event body; the flag marks events that may be dropped. Null discards everything.</param>
    public QueryEventSink(Action<object, bool>? emit)
    {
        this.emit = emit;
        if (emit is not null) timer = new Timer(_ => Tick(), null, IntervalMs, IntervalMs);
    }

    public void Opened(ResultSetBuffer set)
    {
        lock (gate)
        {
            open.Add(set);
            Emit(new { Type = "resultSet.opened", Descriptor = set.Describe() }, false);
        }
    }

    public void Closed(ResultSetBuffer set)
    {
        lock (gate)
        {
            // Messages already stored come first, so the closed set is never reported before what produced it.
            FlushMessages();
            open.Remove(set);
            Emit(new { Type = "resultSet.closed", Descriptor = set.Describe() }, false);
        }
    }

    /// <summary>Cheap: only records where the script is; the timer reports it.</summary>
    public void Progress(int completed, int total, int batch, int repetition)
    {
        lock (gate)
        {
            completedBatches = completed;
            totalBatches = total;
            batchNumber = batch;
            iteration = repetition;
            dirty = true;
        }
    }

    /// <summary>Marks rows read since the last report.</summary>
    public void RowsChanged() => dirty = true;

    /// <summary>A message stored in the summary (QueryMessages enforces the caps).</summary>
    public void Message(string text)
    {
        if (emit is null) return;
        lock (gate)
        {
            if (stopped) return;
            messages.Add(text);
            characters += text.Length;
            if (characters >= FlushCharacters) FlushMessages();
        }
    }

    private void Tick()
    {
        lock (gate)
        {
            if (stopped) return;
            FlushMessages();
            if (dirty) EmitProgress();
        }
    }

    private void FlushMessages()
    {
        if (messages.Count == 0) return;
        Emit(new { Type = "messages", Messages = messages.ToArray() }, true);
        messages.Clear();
        characters = 0;
    }

    private void EmitProgress()
    {
        dirty = false;
        var results = open.Skip(Math.Max(0, open.Count - MaxProgressResults)).Select(set => set.Progress())
            .Select(item => new { item.ResultId, item.RowsRead, item.RowsStored, item.RowsAvailable, item.BytesStored }).ToArray();
        Emit(new { Type = "progress", CompletedBatches = completedBatches, TotalBatches = totalBatches, BatchNumber = batchNumber, Iteration = iteration, Results = results }, true);
    }

    private void Emit(object value, bool droppable)
    {
        if (stopped || emit is null) return;
        try { emit(value, droppable); }
        catch (Exception error) when (error is InvalidOperationException or ObjectDisposedException) { /* Events are best effort; the summary is authoritative. */ }
    }

    /// <summary>Flushes what is waiting; nothing is emitted afterwards.</summary>
    public void Dispose()
    {
        timer?.Dispose();
        lock (gate)
        {
            if (stopped) return;
            FlushMessages();
            stopped = true;
        }
    }
}
