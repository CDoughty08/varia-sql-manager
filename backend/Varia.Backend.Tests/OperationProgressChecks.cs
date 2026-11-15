using System.Globalization;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>op.progress (<see cref="OperationProgress"/>): the figure never goes back and stays below 100 until the
/// operation completes, a phase without a total sends no figure, nothing goes out in the first interval or after a step's
/// owner stopped, and the sort, filter, profile, distinct values, pivot and diff count their work through it.</summary>
internal static class OperationProgressChecks
{
    private static readonly ResultColumn[] Columns = [new("id", "int", "text"), new("name", "nvarchar(40)", "text"), new("group", "varchar(8)", "text")];
    private const int RowCount = 60_000;

    public static void Run(Action<bool, string> check)
    {
        Meter(check);
        Operations(check);
        Cancelled(check);
        SettleOrder(check);
        FailedStep(check);
    }

    private sealed class Recorder
    {
        public readonly List<(string Phase, int? Percent)> Events = [];
        public readonly OperationProgress Progress;
        public Recorder(TimeSpan? interval = null) => Progress = new((phase, percent) => { lock (Events) Events.Add((phase, percent)); }, interval ?? TimeSpan.Zero);

        /// <summary>Figures that never go back and stay within 0 – 99.</summary>
        public bool Monotonic()
        {
            var last = -1;
            foreach (var (_, percent) in Events)
            {
                if (percent is not { } value) continue;
                if (value < last || value > 99 || value < 0) return false;
                last = value;
            }
            return true;
        }

        public string Text => string.Join(", ", Events.Select(item => item.Phase + ":" + (item.Percent?.ToString(CultureInfo.InvariantCulture) ?? "-")));
    }

    private static void Meter(Action<bool, string> check)
    {
        var recorder = new Recorder();
        var progress = recorder.Progress;
        progress.Phase("keys", 0.5, steps: 2);
        for (var step = 0; step < 3; step++)
        {
            // Three steps where two were declared: the third shares out what the phase has left, never past its end.
            check(progress.Open(10), "a counted step opens while none is");
            check(!progress.Open(4), "a step nested in an open one is not counted");
            for (var i = 0; i < 10; i++) progress.Done();
            progress.Close();
        }
        check(progress.Percent <= 50, "steps past those declared never pass the phase's end: " + progress.Percent);
        progress.Phase("identify", 0.8, known: false);
        using (var counter = progress.Count(5)) for (var i = 0; i < 5; i++) counter.Done();
        progress.Phase("sort", 0.98);
        progress.Steps(4, first: 3);
        progress.Open(1);
        progress.Done();
        progress.Close();
        var afterFirst = progress.Percent;
        progress.Open(1);
        progress.Done();
        progress.Close();
        check(afterFirst is > 80 and < 98 && progress.Percent == 98, "a first step of 3 shares in 4 takes three quarters of the phase: " + afterFirst + ", then " + progress.Percent);
        check(recorder.Monotonic() && recorder.Events.Count > 3, "every figure sent is at or above the last and below 100: " + recorder.Text);
        check(recorder.Events.Any(item => item is ("identify", null)) && recorder.Events.Where(item => item.Phase == "identify").All(item => item.Percent is null),
            "a phase without a total sends no figure: " + recorder.Text);
        check(progress.Percent < 100, "the figure stays below 100 until the operation completes");
        progress.Complete();
        var sent = recorder.Events.Count;
        progress.Phase("write", 1);
        check(progress.Percent == 100 && recorder.Events.Count == sent, "a completed operation reads 100 and sends nothing more (its answer follows)");

        var quiet = new Recorder(TimeSpan.FromHours(1));
        quiet.Progress.Phase("keys", 0.5, steps: 1);
        using (var counter = quiet.Progress.Count(100)) for (var i = 0; i < 100; i++) counter.Done();
        check(quiet.Events.Count == 0 && quiet.Progress.Percent == 50, "nothing is sent within the first interval, so a quick operation sends nothing: " + quiet.Text);
    }

    private static ResultSetBuffer Fill(ResultStore store, QueryBudget budget, int index, int seed)
    {
        var wires = Columns.Select(_ => WireKind.Text).ToArray();
        var set = store.Open(budget, index, 1, 1, "rows", Columns, wires) ?? throw new InvalidOperationException("The result set was not kept.");
        for (var row = 0; row < RowCount; row++)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            builder.AppendText(((row * 7919 + seed) % RowCount).ToString(CultureInfo.InvariantCulture));
            builder.AppendText("name " + ((row * 31 + seed) % 977).ToString(CultureInfo.InvariantCulture));
            builder.AppendText("g" + (row % 12).ToString(CultureInfo.InvariantCulture));
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    /// <summary>Runs <paramref name="operation"/> as the host does, with a recorder current on its flow.</summary>
    private static Recorder Measure(Action<OperationProgress> operation)
    {
        var recorder = new Recorder();
        Task.Run(() =>
        {
            OperationProgress.Current = recorder.Progress;
            operation(recorder.Progress);
            recorder.Progress.Complete();
        }).GetAwaiter().GetResult();
        return recorder;
    }

    private static void Operations(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("progress" + Guid.NewGuid());
        var left = Fill(store, budget, 0, 0);
        var right = Fill(store, budget, 1, 3);
        var pages = left.SealedSnapshot();
        check(pages.Length > 4, "the checks' result spans several pages: " + pages.Length);

        void Expect(string name, Recorder recorder, params string[] phases)
        {
            var seen = recorder.Events.Select(item => item.Phase).Distinct().ToArray();
            check(recorder.Monotonic() && recorder.Progress.Percent == 100 && phases.All(seen.Contains) && recorder.Events.Any(item => item.Percent > 0),
                name + " reports its phases with a figure that only goes up, and completes at 100: " + recorder.Text);
        }

        Expect("a sort", Measure(_ => ViewSorter.Build(left, pages, [new ViewKey(1, false, SortMode.Value), new ViewKey(0, true, SortMode.Value)], [], CancellationToken.None)), "keys", "sort");
        Expect("a filter and sort", Measure(_ => ViewSorter.Build(left, pages, [new ViewKey(0, false, SortMode.Value)], [new ViewFilter(FilterOp.Duplicates, -1, null, false, null, [2])], CancellationToken.None)), "filter", "keys", "sort");
        Expect("a filter alone", Measure(_ => ViewSorter.Build(left, pages, [], [new ViewFilter(FilterOp.Duplicates, -1, null, false, null, [1])], CancellationToken.None)), "filter");
        Expect("a profile", Measure(_ => ColumnProfiler.Profile(left, pages, null, [0, 1, 2], true, CancellationToken.None)), "profile");
        Expect("distinct values", Measure(_ => ViewSorter.DistinctValues(left, pages, null, 1, true, CancellationToken.None)), "keys", "group");
        Expect("a pivot", Measure(_ => ResultPivoter.Build(left, pages, null, new PivotSpec([2], -1, [new PivotValue(PivotAggregate.Count, -1)]), CancellationToken.None, _ => true)), "keys", "aggregate");
        var diff = Measure(_ => ResultDiffer.Compare(left, pages, right, right.SealedSnapshot(), false, CancellationToken.None));
        Expect("a diff", diff, "identify", "align");
        check(diff.Events.Where(item => item.Phase == "identify").All(item => item.Percent is null), "a diff looking for row keys sends no figure: " + diff.Text);
        // Without a progress current, nothing is counted anywhere (the benchmarks and every other caller).
        check(OperationProgress.Current is null, "no progress is current outside an operation's own flow");
    }

    /// <summary>A cancelled operation sends nothing after its answer: the request is answered CANCELLED (settled) from the
    /// first figure on, as ProtocolHost answers a CANCEL on another thread while the sort's workers keep counting until they
    /// see the token; no EVENT is queued after that answer, and the last figure stays below 100.</summary>
    private static void Cancelled(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store, store.BeginQuery("progress" + Guid.NewGuid()), 0, 0);
        var pages = set.SealedSnapshot();
        using var cancel = new CancellationTokenSource();
        var frames = new List<string>();
        RequestContext? request = null;
        request = new RequestContext(9, "results.view", RequestLane.Results, 0, sendEvent: (_, value, _) =>
        {
            lock (frames) frames.Add("event");
            var figure = (OperationProgressEvent)value;
            if (figure.Percent > 0 && request!.TrySettle())
            {
                lock (frames) frames.Add("answer");
                cancel.Cancel();
            }
        });
        using var _ = request;
        var progress = new OperationProgress((phase, percent) => request.SendEvent(new OperationProgressEvent("op.progress", phase, percent), droppable: true), TimeSpan.Zero);
        var stopped = false;
        try
        {
            Task.Run(() =>
            {
                OperationProgress.Current = progress;
                ViewSorter.Build(set, pages, [new ViewKey(1, false, SortMode.Value)], [], cancel.Token);
            }).GetAwaiter().GetResult();
        }
        catch (OperationCanceledException) { stopped = true; }
        var answer = frames.IndexOf("answer");
        check(stopped && answer > 0 && answer == frames.Count - 1 && progress.Percent < 100,
            "a cancelled sort queues no op.progress after its CANCELLED answer and never reads 100: " + string.Join(", ", frames));
    }

    /// <summary>An EVENT being queued and the answer exclude each other: a settle on another thread while an event is being
    /// queued waits until it is queued, so the answer follows it (main counts an EVENT after the answer as a violation).
    /// The settle is given a generous while to overtake; it returns early only when it can.</summary>
    private static void SettleOrder(Action<bool, string> check)
    {
        var order = new List<string>();
        RequestContext? request = null;
        request = new RequestContext(10, "results.view", RequestLane.Results, 0, sendEvent: (_, _, _) =>
        {
            var settle = Task.Run(() => { if (request!.TrySettle()) lock (order) order.Add("answer"); });
            settle.Wait(TimeSpan.FromMilliseconds(250));
            lock (order) order.Add("event");
        });
        using var _ = request;
        request.SendEvent(new OperationProgressEvent("op.progress", "sort", 10), droppable: true);
        SpinWait.SpinUntil(() => { lock (order) return order.Count == 2; }, TimeSpan.FromSeconds(30));
        request.SendEvent(new OperationProgressEvent("op.progress", "sort", 20), droppable: true);
        check(string.Join(",", order) == "event,answer", "an op.progress being queued is never overtaken by the answer, and none follows it: " + string.Join(",", order));
    }

    /// <summary>A step that throws credits only the items that ran: a profile pass given up to run again on one thread
    /// leaves the rest of its phase to the retry rather than standing still.</summary>
    private static void FailedStep(Action<bool, string> check)
    {
        var progress = new Recorder().Progress;
        progress.Phase("profile", 0.7);
        using (var pass = progress.Count(10))
            for (var item = 0; item < 3; item++) pass.Done();
        var afterFailure = progress.Percent;
        progress.Phase("profile", 0.7);
        using (var retry = progress.Count(10))
            for (var item = 0; item < 10; item++) retry.Done();
        // 3 of the first step's 10 items is 10 % of the whole; crediting the whole step would read 35 %.
        check(afterFailure <= 11 && progress.Percent > afterFailure && progress.Percent <= 70,
            "a step that stopped early credits only its items, and the retry moves on from there: " + afterFailure + " then " + progress.Percent);
    }
}
