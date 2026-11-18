using System.Diagnostics;
using System.Globalization;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

internal static partial class PageCompressionBench
{
    /// <summary>Stage 2 of the policy (<c>--stage2</c>): four results of a quarter of the size each, the first shown and the
    /// others hidden. Measures the budget they hold raw, once stage 1 has packed the hidden ones ("before") and once stage 2
    /// has packed the shown one too ("after"); then, on the shown result raw and packed, a grid's plain reads while it
    /// scrolls and jumps (results.read's path: each page through the set's accessor while pinned, 1,000-row windows), a
    /// sorted view's screens (256 rows, ViewPages, as results.read with a view reads them), the first sort after it went
    /// idle (fused when packed), what the policy's next look adds with that sorted view open (nothing: it stays packed), and the whole unpack an operation that still rehydrates (a comparison read far out of order)
    /// does first. Backend share only: no IPC or rendering.</summary>
    private static void RunStage2(double gib, string shapeName, Shape shape)
    {
        ResultColumn[] columns = [.. shape.Columns.Select(column => column.Meta)];
        var each = (long)(gib * (1L << 30)) / 4;
        var store = new ResultStore(16 * each, 8 * each) { Packing = PagePacking.OnRequest };
        long clock = 0;
        store.Clock = () => clock;
        var visibility = new ResultVisibility(id => store.Find(id) is not null, () => clock);
        var sets = new List<ResultSetBuffer>();
        var watch = Stopwatch.StartNew();
        for (var r = 0; r < 4; r++)
        {
            var set = store.Open(store.BeginQuery("stage2-" + r), 0, 1, 1, "rows", columns, [.. columns.Select(_ => WireKind.Text)]) ?? throw new InvalidOperationException("The result set was not kept.");
            for (long row = 0; set.BeginRow() is { } builder; row++)
            {
                set.CountRow();
                if (shapeName == "w1") SyntheticRows.WriteCells("W1", row, builder);
                else foreach (var column in shape.Columns) column.Write(builder, row);
                if (!set.TryCommitRow() || (row & 4095) == 0 && set.BytesStored >= each) break;
            }
            set.Complete();
            sets.Add(set);
        }
        var shown = sets[0];
        Print("stage2.fillSeconds", watch.Elapsed.TotalSeconds, "s", "four results of " + (each >> 20) + " MiB, " + shown.RowsAvailable.ToString("N0", CultureInfo.InvariantCulture) + " rows each");
        visibility.Set(System.Guid.NewGuid(), 1, [shown.ResultId], out _);
        var raw = store.UsedBytes;

        // Before: stage 1 alone packs the three hidden results.
        var before = new ResultPacker(store, visibility, visibleIdleMs: null) { Priority = ThreadPriority.Normal };
        before.PackDue();
        clock += ResultPacker.DelayMs;
        before.PackDue();
        var stage1 = store.UsedBytes;
        if (shown.HasPacked || sets.Skip(1).Any(set => set.NeedsPacking)) throw new InvalidOperationException("Stage 1 did not pack the hidden results alone.");

        // The shown result raw: a grid's reads, a sorted view's screens, and the first sort.
        var random = new Random(7);
        var rows = shown.RowsAvailable;
        const int Window = 1_000, Screen = 256;
        long[] Trace()
        {
            var starts = new List<long>();
            for (long at = 0; at < Math.Min(rows, 600L * Window); at += Window) starts.Add(at);
            for (var i = 0; i < 200 && starts.Count > 0; i++) starts.Add(starts[^1] - Window * (i % 2 == 0 ? 1 : 0));
            return [.. starts.Select(at => Math.Max(0, at))];
        }
        long[] Jumps(int count) => [.. Enumerable.Range(0, count).Select(_ => (long)(random.NextDouble() * Math.Max(1, rows - Window)))];
        double[] Plain(long[] starts)
        {
            var times = new double[starts.Length];
            for (var i = 0; i < starts.Length; i++)
            {
                var start = Stopwatch.GetTimestamp();
                foreach (var page in shown.PagesFor(starts[i], Window))
                    using (shown.Pin()) page.Body();
                times[i] = Stopwatch.GetElapsedTime(start).TotalMicroseconds;
            }
            return times;
        }
        ResultView? view = null;
        double SortSeconds()
        {
            var timer = Stopwatch.StartNew();
            using (shown.Pin())
            {
                var built = ViewSorter.Build(shown, shown.SealedSnapshot(), [new ViewKey(shape.IntColumn, true, SortMode.Value)], [], CancellationToken.None);
                var seconds = timer.Elapsed.TotalSeconds;
                if (view is null) view = store.AddView(shown, built.Order, [new ViewKey(shape.IntColumn, true, SortMode.Value)], built.Approximate, true, 0, null);
                return seconds;
            }
        }
        double[] Screens(long[] starts)
        {
            var times = new double[starts.Length];
            for (var i = 0; i < starts.Length; i++)
            {
                var start = Stopwatch.GetTimestamp();
                foreach (var page in ViewPages.Build(view!, starts[i], Screen)) page.Body();
                times[i] = Stopwatch.GetElapsedTime(start).TotalMilliseconds;
            }
            return times;
        }
        void Report(string state, double[] scroll, double[] jumps, double[] screens, double sort)
        {
            Print("stage2." + state + ".scrollMicroseconds", Median(scroll), "µs", "a 1,000-row plain read while scrolling (" + scroll.Length + " reads); p99 " + Percentile(scroll, 0.99).ToString("0", CultureInfo.InvariantCulture));
            Print("stage2." + state + ".jumpMicroseconds", Median(jumps), "µs", "a 1,000-row plain read at a random row (" + jumps.Length + " jumps); p99 " + Percentile(jumps, 0.99).ToString("0", CultureInfo.InvariantCulture));
            Print("stage2." + state + ".sortedScreenMilliseconds", Median(screens), "ms", "a 256-row screen of a view sorted by a random int at a random position, " + ViewSorter.Workers + " workers; p99 " + Percentile(screens, 0.99).ToString("0.0", CultureInfo.InvariantCulture));
            Print("stage2." + state + ".firstSortSeconds", sort, "s", "the first sort by a random int after going idle" + (state == "packed" ? " (fused: read packed)" : ""));
        }
        Plain(Trace());
        SortSeconds();
        var trace = Trace();
        var jumpsAt = Jumps(200);
        var screensAt = Jumps(200);
        var rawSort = SortSeconds();
        Report("raw", Plain(trace), Plain(jumpsAt), Screens(screensAt), rawSort);

        // After: stage 2 packs the shown result once idle. The view closes first and is built again on the packed result, so
        // its screens are measured on a view sorted from packed pages, as a grid sorted after packing would be.
        store.CloseViews(shown.ResultId, [view!.ViewId]);
        view = null;
        var after = new ResultPacker(store, visibility) { Priority = ThreadPriority.Normal };
        after.PackDue();
        clock += ResultPacker.VisibleIdleMs;
        var packTimer = Stopwatch.StartNew();
        after.PackDue();
        var packSeconds = packTimer.Elapsed.TotalSeconds;
        if (shown.NeedsPacking) throw new InvalidOperationException("Stage 2 did not pack the shown result.");
        var stage2 = store.UsedBytes;
        Print("stage2.usedRawMiB", raw >> 20, "MiB", "four results held raw (one shown, three hidden)");
        Print("stage2.usedBeforeMiB", stage1 >> 20, "MiB", "stage 1: the three hidden results packed, the shown one raw; " + ((double)raw / stage1).ToString("0.00", CultureInfo.InvariantCulture) + "x less than raw");
        Print("stage2.usedAfterMiB", stage2 >> 20, "MiB", "stage 2: the shown one packed too; " + ((double)raw / stage2).ToString("0.00", CultureInfo.InvariantCulture) + "x less than raw, " + ((double)stage1 / stage2).ToString("0.00", CultureInfo.InvariantCulture) + "x less than stage 1");
        Print("stage2.packSeconds", packSeconds, "s", "the stage 2 pass over the shown result on one thread; " + (shown.BytesStored / 1e6 / packSeconds).ToString("0", CultureInfo.InvariantCulture) + " MB/s");
        var packedSort = SortSeconds();
        Report("packed", Plain(trace), Plain(jumpsAt), Screens(screensAt), packedSort);
        // The policy's next look at the shown result with its sorted view open: it stays packed (a view never unpacks it).
        var beforeLook = store.UsedBytes;
        var lookTimer = Stopwatch.StartNew();
        after.PackDue();
        Print("stage2.packed.sortedLookMiB", (store.UsedBytes - beforeLook) / (double)(1 << 20), "MiB", "what the policy's next look adds to the budget once the packed shown result is sorted, in " + lookTimer.Elapsed.TotalMilliseconds.ToString("0.0", CultureInfo.InvariantCulture) + " ms; " + (shown.HasPacked ? "it stays packed" : "it was unpacked"));
        var unpackTimer = Stopwatch.StartNew();
        using (shown.Pin()) if (!shown.TryUnpackAll()) throw new InvalidOperationException("The budget refused the unpack.");
        Print("stage2.packed.firstUnpackSeconds", unpackTimer.Elapsed.TotalSeconds, "s", "the whole unpack a comparison read far out of order does first, " + ViewSorter.Workers + " workers");
        var counters = store.PackingSnapshot();
        Print("stage2.cacheHitShare", counters.CacheLookups == 0 ? 0 : (double)counters.CacheHits / counters.CacheLookups, "x", counters.CacheHits + " cache hits in " + counters.CacheLookups + " lookups over the packed reads");
    }
}
