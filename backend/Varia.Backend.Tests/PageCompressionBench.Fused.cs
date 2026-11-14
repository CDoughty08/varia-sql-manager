using System.Diagnostics;
using System.Globalization;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

internal static partial class PageCompressionBench
{
    /// <summary><c>--page-compression-bench &lt;GiB&gt; &lt;shape&gt; --fused</c>: the fused per-page reads
    /// (docs/page-compression-findings.md). Fills a real store as ingestion does, then runs each whole-result operation
    /// three ways, median of three timed runs after a warm pass: over the raw pages; over the result packed by the store
    /// (zstd 2), unpacked whole on the workers first and packed again after (rehydrate, the unpacking timed with the
    /// operation); and over the packed result directly (fused). For each it prints the time, the most the store's budget
    /// held above the result while it ran (rooms, extracts and unpacked pages are charged there), and the most the managed
    /// heap grew, sampled every millisecond.</summary>
    private static void RunFused(double gib, string shapeName, Shape shape, int workers)
    {
        ResultColumn[] columns = [.. shape.Columns.Select(column => column.Meta)];
        var none = CancellationToken.None;
        var budget = (long)(gib * (1L << 30));
        // Room for the result, its unpacked copy and the operations' working memory beside it.
        var store = new ResultStore(4 * budget, 4 * budget) { Packing = PagePacking.OnRequest };
        var query = store.BeginQuery("fused");
        var set = store.Open(query, 0, 1, 1, "rows", columns, [.. columns.Select(_ => WireKind.Text)]) ?? throw new InvalidOperationException("The result set was not kept.");
        long rows = 0;
        while (query.UsedBytes < budget && set.BeginRow() is { } builder)
        {
            set.CountRow();
            if (shapeName == "w1") SyntheticRows.WriteCells("W1", rows, builder);
            else foreach (var column in shape.Columns) column.Write(builder, rows);
            if (!set.TryCommitRow()) break;
            rows++;
        }
        set.Complete();
        var pageCount = set.SealedSnapshot().Length;
        var detail = rows.ToString("N0", CultureInfo.InvariantCulture) + " rows, " + pageCount.ToString("N0", CultureInfo.InvariantCulture) + " pages, " + columns.Length + " columns";
        Print("rows", rows, "rows", detail);
        Print("workers", workers, "threads", "ViewSorter.Workers on " + Environment.ProcessorCount + " logical processors");
        var rawBytes = store.UsedBytes;

        // The product's key memory: whole keys only while the budget has room to spare; and none, so that ties read cells.
        ViewSorter.KeyMemory Spare() => new((bytes, large) => store.TryReserveSpare(query, bytes, large), bytes => store.Return(query, bytes));
        ViewSorter.KeyMemory Narrow() => new(_ => false, _ => { });
        var pivotSpec = new PivotSpec([shape.LowColumn], -1, [new(PivotAggregate.Count, -1), new(PivotAggregate.Sum, shape.SumColumn), new(PivotAggregate.Max, shape.MaxColumn)]);
        // The text column with many equal 8-byte starts: the shape's longest text (note, message), else its text column.
        var tieColumn = shapeName switch { "orders" => 11, "log" => 5, _ => shape.TextColumn };
        (string Name, Func<StoredPage[], object> Run)[] operations =
        [
            ("sortInt", pages => ViewSorter.Build(set, pages, [new ViewKey(shape.IntColumn, true, SortMode.Value)], [], none, Spare()).Order.Length),
            ("sortText", pages => ViewSorter.Build(set, pages, [new ViewKey(shape.TextColumn, false, SortMode.Value)], [], none, Spare()).Order.Length),
            ("sortTies", pages => ViewSorter.Build(set, pages, [new ViewKey(tieColumn, false, SortMode.Value)], [], none, Narrow()).Order.Length),
            ("filterIn", pages => ViewSorter.Build(set, pages, [], [new ViewFilter(FilterOp.In, shape.LowColumn, [0], false, null, [])], none, Spare()).Order.Length),
            ("profile", pages => ColumnProfiler.Profile(set, pages, null, shape.Profile, true, none).Columns.Length),
            ("pivot", pages => ResultPivoter.Build(set, pages, null, pivotSpec, none, _ => true).RowGroups),
            ("save", pages => SaveThrough(set, pages, columns)),
        ];

        void Measure(string mode, Func<Func<StoredPage[], object>, object> run, Action? after = null)
        {
            foreach (var (name, op) in operations)
            {
                var seconds = new double[3];
                long budgetPeak = 0, heapPeak = 0;
                for (var i = 0; i < seconds.Length; i++)
                {
                    GC.Collect(2, GCCollectionMode.Forced, true, false);
                    var heapBefore = GC.GetTotalMemory(false);
                    var usedBefore = store.UsedBytes;
                    long usedMost = usedBefore, heapMost = heapBefore;
                    var done = 0;
                    var sampler = new Thread(() =>
                    {
                        while (Volatile.Read(ref done) == 0)
                        {
                            usedMost = Math.Max(usedMost, store.UsedBytes);
                            heapMost = Math.Max(heapMost, GC.GetTotalMemory(false));
                            Thread.Sleep(1);
                        }
                    }) { IsBackground = true, Priority = ThreadPriority.AboveNormal };
                    sampler.Start();
                    var timer = Stopwatch.StartNew();
                    run(op);
                    seconds[i] = timer.Elapsed.TotalSeconds;
                    Volatile.Write(ref done, 1);
                    sampler.Join();
                    after?.Invoke();
                    budgetPeak = Math.Max(budgetPeak, usedMost - usedBefore);
                    heapPeak = Math.Max(heapPeak, heapMost - heapBefore);
                }
                Print("fused." + name + "." + mode + "Seconds", Median(seconds), "s", "median of 3 (" + seconds.Min().ToString("0.000", CultureInfo.InvariantCulture) + " to " + seconds.Max().ToString("0.000", CultureInfo.InvariantCulture) + ")");
                Print("fused." + name + "." + mode + ".budgetPeakMiB", budgetPeak / 1048576.0, "MiB", "most the store's budget held above the result during a run (charged working memory)");
                Print("fused." + name + "." + mode + ".heapPeakMiB", heapPeak / 1048576.0, "MiB", "most the managed heap grew during a run, sampled every millisecond");
            }
        }

        // Warm every path on the raw pages and on a packed copy, so no timed run pays for compiling it.
        var all = set.SealedSnapshot();
        foreach (var (_, op) in operations) op(all[..Math.Min(8, all.Length)]);
        Measure("raw", op => op(set.SealedSnapshot()));
        var packTimer = Stopwatch.StartNew();
        var saved = set.Pack();
        Print("fused.packSeconds", packTimer.Elapsed.TotalSeconds, "s", "the store's Pack, one thread");
        Print("fused.ratio", (double)rawBytes / (rawBytes - saved), "x", "the result's charge raw over packed, lengths and overheads included");
        foreach (var (_, op) in operations) op(all[..Math.Min(8, all.Length)]);
        Thread.Sleep(1000);
        Measure("rehydrate", op =>
        {
            object result;
            using (set.Pin())
            {
                if (!set.TryUnpackAll()) throw new InvalidOperationException("No room to unpack.");
                result = op(set.SealedSnapshot());
            }
            return result;
        }, after: () => set.Pack());
        Measure("fused", op =>
        {
            var result = op(set.SealedSnapshot());
            if (!set.HasPacked) throw new InvalidOperationException("The fused run unpacked the result.");
            return result;
        });
        using (var process = Process.GetCurrentProcess()) Print("fused.peakWorkingSetMiB", process.PeakWorkingSet64 >> 20, "MiB", "over the whole run");
    }

    /// <summary>A Save as the product writes one (ResultJobs' ReadRoom): one thread, each packed page unpacked into one room.</summary>
    private static long SaveThrough(ResultSetBuffer set, StoredPage[] pages, ResultColumn[] columns)
    {
        using var pin = set.Pin();
        var output = new Discard();
        var writer = new ResultTextWriter(output, TextOptions.Export(TextFormat.Csv, true, "NULL"), columns);
        int[] selected = [.. Enumerable.Range(0, columns.Length)];
        var scratch = new int[PageView.ScratchLength(columns.Length)];
        var room = new byte[pages.Length == 0 ? 0 : pages.Max(page => page.Length)];
        // Reserved as ResultJobs.ReadRoom reserves it, so the budget's peak shows it.
        var reserved = pages.Any(page => set.Raw(page) is null) && set.TryReserveWork(room.Length) ? room.Length : 0;
        try
        {
            writer.Begin();
            writer.Header(selected);
            foreach (var page in pages)
            {
                var body = set.Raw(page) ?? set.Read(page, room);
                var view = PageView.Parse(body.AsSpan(0, page.Length), columns.Length, scratch);
                for (var row = 0; row < view.Rows; row++) writer.Row(view, row, selected);
            }
            writer.End();
            return output.Written;
        }
        finally { set.ReturnWork(reserved); }
    }
}
