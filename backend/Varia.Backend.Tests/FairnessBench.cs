using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>How result operations share the worker threads, run by hand (docs/ipc.md, "Worker threads"):
/// <c>dotnet run --project backend/Varia.Backend.Tests --configuration Release -- --fairness-bench [--rows N] [--runs N]</c>,
/// with <c>DOTNET_PROCESSOR_COUNT=n</c> for a smaller machine. Fills one synthetic W1 result, then times a text sort, a uniqueidentifier sort, a pivot
/// and a profile of every column each alone, and each pair of them started together (two pivots, two sorts, a sort and a
/// profile, a sort and a pivot, a pivot and a profile, two uniqueidentifier sorts, one beside a pivot). Prints one JSON line per case with each operation's median time and
/// the faster and slower of each pair (medians) and its wall time; measures only, no checks, and is not part of <c>npm run check</c>.</summary>
internal static class FairnessBench
{
    public const string Argument = "--fairness-bench";
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);

    public static void Run(string[] args)
    {
        long Option(string name, long fallback) => Array.IndexOf(args, name) is var at and >= 0 && at + 1 < args.Length ? long.Parse(args[at + 1], CultureInfo.InvariantCulture) : fallback;
        var wanted = Option("--rows", 2_000_000);
        var runs = (int)Option("--runs", 7);
        var shape = SyntheticRows.Columns("W1");
        ResultColumn[] columns = [.. shape.Select(column => new ResultColumn(column.Name, column.DataType, "text", Collation: column.DataType.StartsWith("nvarchar", StringComparison.Ordinal) ? CaseInsensitive : null))];
        var store = new ResultStore(16L << 30, 8L << 30);
        var set = store.Open(store.BeginQuery("fairness"), 0, 1, 1, "rows", columns, [.. shape.Select(column => column.Wire)]) ?? throw new InvalidOperationException("The result set was not kept.");
        long rows = 0;
        while (rows < wanted && set.BeginRow() is { } builder)
        {
            set.CountRow();
            SyntheticRows.WriteCells("W1", rows, builder);
            if (!set.TryCommitRow()) break;
            rows++;
        }
        set.Complete();
        var pages = set.SealedSnapshot();
        var none = CancellationToken.None;
        var operations = new Dictionary<string, Action>
        {
            ["sort"] = () => ViewSorter.Build(set, pages, [new ViewKey(1, false, SortMode.Value)], [], none),
            ["pivot"] = () => ResultPivoter.Build(set, pages, null, new PivotSpec([6], -1, [new(PivotAggregate.Count, -1), new(PivotAggregate.Sum, 3), new(PivotAggregate.Max, 7)]), none, _ => true),
            ["sortGuid"] = () => ViewSorter.Build(set, pages, [new ViewKey(4, false, SortMode.Value)], [], none),
            ["profile"] = () => ColumnProfiler.Profile(set, pages, null, [.. Enumerable.Range(0, columns.Length)], true, none),
        };
        var label = rows.ToString("N0", CultureInfo.InvariantCulture) + " rows, " + Environment.ProcessorCount + " processors, " + ViewSorter.Workers + " workers";
        foreach (var operation in operations.Values) operation();

        double Ms(long ticks) => ticks * 1000.0 / Stopwatch.Frequency;
        double Median(List<double> values) => values.Order().ElementAt(values.Count / 2);
        foreach (var (name, operation) in operations)
        {
            var times = new List<double>();
            for (var run = 0; run < runs; run++)
            {
                GC.Collect();
                var start = Stopwatch.GetTimestamp();
                operation();
                times.Add(Ms(Stopwatch.GetTimestamp() - start));
            }
            Print(new { id = "fairness.alone." + name, ms = Math.Round(Median(times), 1), detail = label });
        }
        foreach (var (first, second) in new[] { ("pivot", "pivot"), ("sort", "sort"), ("sort", "profile"), ("profile", "sort"), ("sort", "pivot"), ("pivot", "profile"), ("sortGuid", "sortGuid"), ("sortGuid", "pivot") })
        {
            List<double> a = [], b = [], faster = [], slower = [], wall = [];
            for (var run = 0; run < runs; run++)
            {
                GC.Collect();
                using var go = new Barrier(2);
                double Timed(Action work)
                {
                    go.SignalAndWait();
                    var start = Stopwatch.GetTimestamp();
                    work();
                    return Ms(Stopwatch.GetTimestamp() - start);
                }
                var started = Stopwatch.GetTimestamp();
                var one = Task.Factory.StartNew(() => Timed(operations[first]), TaskCreationOptions.LongRunning);
                var two = Task.Factory.StartNew(() => Timed(operations[second]), TaskCreationOptions.LongRunning);
                Task.WaitAll(one, two);
                wall.Add(Ms(Stopwatch.GetTimestamp() - started));
                a.Add(one.Result);
                b.Add(two.Result);
                faster.Add(Math.Min(one.Result, two.Result));
                slower.Add(Math.Max(one.Result, two.Result));
            }
            Print(new { id = "fairness.pair." + first + "+" + second, firstMs = Math.Round(Median(a), 1), secondMs = Math.Round(Median(b), 1), fasterMs = Math.Round(Median(faster), 1), slowerMs = Math.Round(Median(slower), 1), wallMs = Math.Round(Median(wall), 1), detail = label });
        }
        Print(new { id = "fairness.gate", busy = ViewSorter.Gate.Busy, peak = ViewSorter.Gate.Peak, detail = "threads still taken after every case, and the most taken at once" });
    }

    private static void Print(object line) => Console.WriteLine(JsonSerializer.Serialize(line));
}
