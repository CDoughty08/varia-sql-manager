using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>The result-work benchmark, run by hand: <c>dotnet run --project backend/Varia.Backend.Tests --configuration Release
/// -- --result-work-bench [--rows N] [--only name,name] [--runs N]</c>, with <c>DOTNET_PROCESSOR_COUNT</c> to simulate fewer
/// cores. Synthetic results (every cell a function of its row number) for the three operations on stored rows that were
/// last made parallel: a pivot's Distinct Count, Compare Results' matching and alignment, and a column's distinct value
/// list past the coded-grouping limit. Each case reports the median of its warm runs, split into the operation's stages.
/// Prints one JSON line per case; measures only, no checks, and is not part of <c>npm run check</c>.</summary>
internal static class ResultWorkBench
{
    public const string Argument = "--result-work-bench";
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);

    private sealed record Column(ResultColumn Meta, Action<PageBuilder, long> Write);

    private static long Pick(long row, long groups) => (long)((ulong)row * 2654435761UL % 4294967291UL % (ulong)groups);
    private static void Integer(PageBuilder builder, long value) => builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), value));
    private static Column Int(string name, long groups, int nullEvery = 7) => new(new ResultColumn(name, "int", "text"), (builder, row) =>
    {
        if (nullEvery > 0 && row % nullEvery == 0) builder.AppendNull();
        else Integer(builder, Pick(row, groups));
    });
    private static Column Text(string name, long groups, int nullEvery = 7) => new(new ResultColumn(name, "nvarchar(40)", "text", Collation: CaseInsensitive), (builder, row) =>
    {
        if (nullEvery > 0 && row % nullEvery == 0) { builder.AppendNull(); return; }
        Span<char> text = stackalloc char[40];
        // Upper and lower case alternate for one value, so the collation, not the bytes, makes them one.
        var value = Pick(row, groups);
        text.TryWrite(CultureInfo.InvariantCulture, $"{(row % 2 == 0 ? "Region" : "REGION")} {value:D7}", out var length);
        builder.AppendText(text[..length]);
    });
    /// <summary>A unique id, with every <paramref name="changeEvery"/>-th row of the second result's other values changed.</summary>
    private static Column Id() => new(new ResultColumn("id", "int", "text", Nullable: false), Integer);

    private static int sessions;

    private static ResultSetBuffer Fill(ResultStore store, QueryBudget budget, int index, long rows, Func<long, long> rowOf, params Column[] columns)
    {
        var metas = columns.Select(column => column.Meta).ToArray();
        var set = store.Open(budget, index, 1, 1, "rows", metas, [.. metas.Select(_ => WireKind.Text)]) ?? throw new InvalidOperationException("The fixture was not kept.");
        for (long row = 0; row < rows; row++)
        {
            set.CountRow();
            var builder = set.BeginRow() ?? throw new InvalidOperationException("The budget is too small for this fixture.");
            var source = rowOf(row);
            foreach (var column in columns) column.Write(builder, source);
            if (!set.TryCommitRow()) throw new InvalidOperationException("The budget is too small for this fixture.");
        }
        set.Complete();
        return set;
    }

    private static double Ms(long ticks) => Math.Round(ticks * 1000.0 / Stopwatch.Frequency, 1);
    private static string[]? only;
    private static int runs = 5;

    private static void Case(string id, string detail, Func<Dictionary<string, long>> once)
    {
        if (only is not null && !only.Any(name => id.Contains(name, StringComparison.OrdinalIgnoreCase))) return;
        GC.Collect();
        once();
        var samples = new List<Dictionary<string, long>>();
        for (var i = 0; i < runs; i++) samples.Add(once());
        var median = samples.OrderBy(sample => sample["total"]).ElementAt(samples.Count / 2);
        Console.WriteLine(JsonSerializer.Serialize(new { id, detail, workers = ViewSorter.Workers, stagesMs = median.ToDictionary(item => item.Key, item => Ms(item.Value)) }));
    }

    public static void Run(string[] args)
    {
        long rows = 4_000_000;
        for (var i = 1; i < args.Length - 1; i++)
        {
            if (args[i] == "--rows") rows = long.Parse(args[i + 1], CultureInfo.InvariantCulture);
            if (args[i] == "--only") only = args[i + 1].Split(',');
            if (args[i] == "--runs") runs = int.Parse(args[i + 1], CultureInfo.InvariantCulture);
        }
        var store = new ResultStore(16L << 30, 16L << 30);
        Console.WriteLine(JsonSerializer.Serialize(new { processors = Environment.ProcessorCount, workers = ViewSorter.Workers, rows }));
        var budget = store.BeginQuery("bench" + sessions++);
        var count = rows.ToString("N0", CultureInfo.InvariantCulture);

        // Distinct value lists past the coded limit (and one under it, for scale).
        foreach (var (id, column, detail) in new[]
        {
            ("distinct-int-coded", Int("v", 50_000), "an int of 50,000 values (coded grouping)"),
            ("distinct-int", Int("v", rows / 2), "an int of " + (rows / 2).ToString("N0", CultureInfo.InvariantCulture) + " values"),
            ("distinct-text", Text("v", rows / 4), "case-insensitive text of " + (rows / 4).ToString("N0", CultureInfo.InvariantCulture) + " values"),
        })
        {
            if (only is not null && !only.Any(name => id.Contains(name, StringComparison.OrdinalIgnoreCase))) continue;
            var set = Fill(store, budget, 0, rows, row => row, column);
            var pages = set.SealedSnapshot();
            Case(id, count + " rows, " + detail, () =>
            {
                var stages = new DistinctStages();
                var memory = new ViewSorter.KeyMemory(bytes => store.TryReserveSpare(budget, bytes), bytes => store.Return(budget, bytes));
                var started = Stopwatch.GetTimestamp();
                var snapshot = ViewSorter.DistinctValues(set, pages, null, 0, true, default, null, memory, stages);
                var total = Stopwatch.GetTimestamp() - started;
                return new() { ["total"] = total, ["key"] = stages.Key, ["rows"] = stages.Rows, ["grouping"] = stages.Grouping, ["sorting"] = stages.Sorting, ["runs"] = stages.Runs, ["ranking"] = stages.Ranking, ["groups"] = snapshot.Distinct * Stopwatch.Frequency / 1000 };
            });
            store.Release([set.ResultId]);
        }

        // Pivot Distinct Count: 1,000 row groups by 16 column groups.
        foreach (var (id, column, detail) in new[]
        {
            ("pivot-distinct-int", Int("v", rows / 4), "Distinct Count of an int of " + (rows / 4).ToString("N0", CultureInfo.InvariantCulture) + " values"),
            ("pivot-distinct-text", Text("v", rows / 8), "Distinct Count of case-insensitive text of " + (rows / 8).ToString("N0", CultureInfo.InvariantCulture) + " values"),
        })
        {
            if (only is not null && !only.Any(name => id.Contains(name, StringComparison.OrdinalIgnoreCase))) continue;
            var set = Fill(store, budget, 0, rows, row => row, Int("g", 1_000, 0), Int("c", 16, 0), column);
            var pages = set.SealedSnapshot();
            var spec = new PivotSpec([0], 1, [new PivotValue(PivotAggregate.CountDistinct, 2)]);
            Case(id, count + " rows by 1,000 row groups and 16 column groups, " + detail, () =>
            {
                var stages = new PivotStages();
                var memory = new ViewSorter.KeyMemory(bytes => store.TryReserveSpare(budget, bytes), bytes => store.Return(budget, bytes));
                var started = Stopwatch.GetTimestamp();
                ResultPivoter.Build(set, pages, null, spec, default, _ => true, memory, stages);
                var total = Stopwatch.GetTimestamp() - started;
                return new() { ["total"] = total, ["keys"] = stages.Keys, ["grouping"] = stages.Grouping, ["aggregation"] = stages.Aggregation, ["distinct"] = stages.Distinct };
            });
            store.Release([set.ResultId]);
        }

        // Compare Results: by a unique id, and by whole rows (no column unique), every 50th row changed and every 97th
        // missing from the second.
        foreach (var (id, keyed, detail) in new[] { ("diff-key", true, "matched by a unique id"), ("diff-rows", false, "matched by whole rows (values repeat)") })
        {
            if (only is not null && !only.Any(name => id.Contains(name, StringComparison.OrdinalIgnoreCase))) continue;
            Column[] columns = keyed ? [Id(), Int("a", 1_000), Text("t", 100_000)] : [Int("a", rows / 3, 0), Text("t", rows / 5, 0)];
            var left = Fill(store, budget, 0, rows, row => row, columns);
            var right = Fill(store, budget, 1, rows - rows / 97, row => row + row / 96 + (row % 50 == 7 ? rows * 10 : 0), columns);
            var leftPages = left.SealedSnapshot();
            var rightPages = right.SealedSnapshot();
            Case(id, count + " rows against " + (rows - rows / 97).ToString("N0", CultureInfo.InvariantCulture) + ", " + detail, () =>
            {
                var stages = new DiffStages();
                var started = Stopwatch.GetTimestamp();
                var model = ResultDiffer.Compare(left, leftPages, right, rightPages, false, default, _ => true, stages);
                var total = Stopwatch.GetTimestamp() - started;
                return new() { ["total"] = total, ["identity"] = stages.Identity, ["matching"] = stages.Matching, ["aligning"] = stages.Aligning, ["keyed"] = (model.KeyPair >= 0 ? 1 : 0) * Stopwatch.Frequency / 1000 };
            });
            store.Release([left.ResultId, right.ResultId]);
        }
    }
}
