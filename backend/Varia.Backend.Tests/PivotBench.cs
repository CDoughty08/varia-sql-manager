using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>The pivot benchmark, run by hand (docs/pivot-performance-findings.md holds what it measured):
/// <c>dotnet run --project backend/Varia.Backend.Tests --configuration Release -- --pivot-bench [--budget-gib N]
/// [--only name,name] [--max-rows N] [--view-rows N]</c>. Synthetic results (every cell a function of its row number) pivoted as results.pivot does, one factor
/// changed at a time: row volume, group cardinality, shape, value types, recipe and source view, then parallel builds,
/// cancellation and a refusal. Each case reports its first build and the median and slowest of the warm ones, split into the
/// stages of <c>SqlService.PivotAsync</c> (reservation, sort keys, grouping, aggregation, distinct counts, output shape, output
/// pages, release), with the bytes reserved and allocated. Prints one JSON line per case; measures only, no checks, and is not
/// part of <c>npm run check</c>.</summary>
internal static class PivotBench
{
    public const string Argument = "--pivot-bench";
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);
    private static readonly ResultCollation Binary = new(1033, 0, 1252, false, 32768);
    private const string Lorem = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.";

    private sealed record Column(ResultColumn Meta, Action<PageBuilder, long> Write);

    /// <summary>A row's value among <paramref name="groups"/>, scattered so equal values are not neighbours.</summary>
    private static long Pick(long row, long groups) => (long)((ulong)row * 2654435761UL % 4294967291UL % (ulong)groups);
    private static bool IsNull(long row, int nullEvery) => nullEvery > 0 && row % nullEvery == 0;
    private static void Integer(PageBuilder builder, long value) => builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), value));

    /// <summary>An int of <paramref name="groups"/> distinct values, NULL every <paramref name="nullEvery"/> rows.</summary>
    private static Column Int(string name, long groups, int nullEvery = 7) => new(new ResultColumn(name, "int", "text"), (builder, row) =>
    {
        if (IsNull(row, nullEvery)) builder.AppendNull();
        else Integer(builder, Pick(row, groups));
    });
    private static Column Id() => new(new ResultColumn("id", "int", "text", Nullable: false), Integer);
    private static Column Decimal(string name, long groups, int nullEvery = 7) => new(new ResultColumn(name, "decimal(18,2)", "text", Precision: 18, Scale: 2), (builder, row) =>
    {
        if (IsNull(row, nullEvery)) builder.AppendNull();
        else builder.EndFormatted(CellFormat.WriteDecimal(builder.BeginFormatted(), new decimal((int)Pick(row, groups), 0, 0, row % 11 == 5, 2)));
    });
    /// <summary>A decimal(38,10) of 30 digits: more than a double holds, so equal values are told apart by their text.</summary>
    private static Column BigDecimal(string name, long groups, int nullEvery = 7) => new(new ResultColumn(name, "decimal(38,10)", "text", Precision: 38, Scale: 10), (builder, row) =>
    {
        if (IsNull(row, nullEvery)) { builder.AppendNull(); return; }
        Span<char> text = stackalloc char[40];
        text.TryWrite(CultureInfo.InvariantCulture, $"12345678901234{Pick(row, groups):D6}.0000000001", out var length);
        builder.AppendText(text[..length]);
    });
    private static Column Float(string name, long groups, int nullEvery = 7) => new(new ResultColumn(name, "float", "text", Precision: 53), (builder, row) =>
    {
        if (IsNull(row, nullEvery)) builder.AppendNull();
        else builder.EndFormatted(CellFormat.WriteFloat(builder.BeginFormatted(), Pick(row, groups) * 0.5 + 0.25));
    });
    private static Column Text(string name, long groups, ResultCollation collation, int nullEvery = 7) => new(new ResultColumn(name, "nvarchar(40)", "text", Collation: collation), (builder, row) =>
    {
        if (IsNull(row, nullEvery)) { builder.AppendNull(); return; }
        Span<char> text = stackalloc char[40];
        text.TryWrite(CultureInfo.InvariantCulture, $"Region {Pick(row, groups):D6}", out var length);
        builder.AppendText(text[..length]);
    });
    /// <summary>A datetime2(7) of <paramref name="groups"/> distinct minutes: a type compared by its display text.</summary>
    private static Column Date(string name, long groups, int nullEvery = 7) => new(new ResultColumn(name, "datetime2(7)", "text"), (builder, row) =>
    {
        if (IsNull(row, nullEvery)) builder.AppendNull();
        else builder.EndFormatted(CellFormat.WriteDateTime2(builder.BeginFormatted(), new DateTime(2026, 1, 1).AddMinutes(Pick(row, groups) * 7), 7));
    });
    /// <summary>Text of about 190 characters whose values differ only at the end (a long shared prefix).</summary>
    private static Column LongText(string name, long groups, int nullEvery = 7) => new(new ResultColumn(name, "nvarchar(400)", "text", Collation: CaseInsensitive), (builder, row) =>
    {
        if (IsNull(row, nullEvery)) { builder.AppendNull(); return; }
        Span<char> text = stackalloc char[200];
        Lorem.AsSpan(0, 180).CopyTo(text);
        text[180..].TryWrite(CultureInfo.InvariantCulture, $"{Pick(row, groups):D6}", out var length);
        builder.AppendText(text[..(180 + length)]);
    });
    private static Column[] Filler() =>
    [
        new(new ResultColumn("name", "nvarchar(50)", "text", Collation: CaseInsensitive), (builder, row) =>
        {
            Span<char> text = stackalloc char[40];
            text.TryWrite(CultureInfo.InvariantCulture, $"Customer {row:D10} GmbH", out var length);
            builder.AppendText(text[..length]);
        }),
        new(new ResultColumn("created", "datetime2(7)", "text"), (builder, row) =>
            builder.EndFormatted(CellFormat.WriteDateTime2(builder.BeginFormatted(), new DateTime(2026, 1, 1).AddTicks(row * 10_000_000), 7))),
        new(new ResultColumn("note", "nvarchar(200)", "text", Collation: CaseInsensitive), (builder, row) => builder.AppendText(Lorem.AsSpan((int)(row % 40), 80)))
    ];

    private static int sessions;

    private static ResultSetBuffer Fill(ResultStore store, long rows, params Column[] columns)
    {
        var metas = columns.Select(column => column.Meta).ToArray();
        var set = store.Open(store.BeginQuery("bench" + sessions++), 0, 1, 1, "rows", metas, [.. metas.Select(_ => WireKind.Text)])
            ?? throw new InvalidOperationException("The fixture was not kept.");
        for (long row = 0; row < rows; row++)
        {
            set.CountRow();
            var builder = set.BeginRow() ?? throw new InvalidOperationException("The budget is too small for this fixture.");
            foreach (var column in columns) column.Write(builder, row);
            if (!set.TryCommitRow()) throw new InvalidOperationException("The budget is too small for this fixture.");
        }
        set.Complete();
        return set;
    }

    private sealed class Sample
    {
        public double Total, Reserve, Keys, Grouping, Aggregation, Distinct, Shape, Write, Release;
        public long Allocated, Working, Figures, PivotBytes, Rows, RowGroups, ColumnGroups;
        public int Gen0, Gen1, Gen2;
        public string? Refused;
    }

    private static double Ms(long ticks) => ticks * 1000.0 / Stopwatch.Frequency;

    /// <summary>One pivot as SqlService.PivotAsync runs it, each stage timed; the pivot is released again.</summary>
    private static Sample Once(ResultStore store, ResultSetBuffer set, PivotSpec spec, int[]? order, CancellationToken token = default)
    {
        var sample = new Sample();
        int gen0 = GC.CollectionCount(0), gen1 = GC.CollectionCount(1), gen2 = GC.CollectionCount(2);
        var allocated = GC.GetTotalAllocatedBytes(true);
        long start = Stopwatch.GetTimestamp(), last = start;
        double Lap()
        {
            var now = Stopwatch.GetTimestamp();
            var ms = Ms(now - last);
            last = now;
            return ms;
        }
        var pages = set.SealedSnapshot();
        long rows = 0;
        foreach (var page in pages) rows += page.Rows;
        var working = ResultPivoter.WorkingBytes(rows, ResultPivoter.KeyColumns(spec));
        sample.Working = working;
        if (!store.TryReserve(set.Budget, working, false, out _)) { sample.Refused = "TOO_LARGE (working memory)"; return sample; }
        long figures = 0;
        bool Reserve(long bytes)
        {
            if (!store.TryReserve(set.Budget, bytes, false, out _)) return false;
            figures += bytes;
            return true;
        }
        sample.Reserve = Lap();
        try
        {
            var stages = new PivotStages();
            PivotModel model;
            try { model = ResultPivoter.Build(set, pages, order, spec, token, Reserve, stages); }
            catch (RequestException refusal) { sample.Refused = refusal.Code + " (bounds)"; model = null!; }
            catch (PivotTooLargeException) { sample.Refused = "TOO_LARGE (figures)"; model = null!; }
            (sample.Keys, sample.Grouping, sample.Aggregation, sample.Distinct) = (Ms(stages.Keys), Ms(stages.Grouping), Ms(stages.Aggregation), Ms(stages.Distinct));
            Lap();
            if (sample.Refused is null)
            {
                var (columns, wires, lengths) = PivotOutput.Shape(set, pages, spec, model);
                var pivot = store.Open(set.Budget, set.Index, set.BatchNumber, set.Iteration, "pivot", columns, wires, lengths: lengths, derived: true);
                sample.Shape = Lap();
                if (pivot is null) sample.Refused = "TOO_LARGE (output)";
                else
                {
                    PivotOutput.Write(pivot, set, pages, spec, model, token);
                    sample.Write = Lap();
                    (sample.PivotBytes, sample.Rows, sample.RowGroups, sample.ColumnGroups) = (pivot.Describe().BytesStored, model.Rows, model.RowGroups, model.ColumnGroups);
                    store.Release([pivot.ResultId]);
                    sample.Release = Lap();
                }
            }
        }
        finally { store.Return(set.Budget, working + figures); }
        sample.Figures = figures;
        sample.Total = Ms(Stopwatch.GetTimestamp() - start);
        sample.Allocated = GC.GetTotalAllocatedBytes(true) - allocated;
        (sample.Gen0, sample.Gen1, sample.Gen2) = (GC.CollectionCount(0) - gen0, GC.CollectionCount(1) - gen1, GC.CollectionCount(2) - gen2);
        return sample;
    }

    private static double Median(IEnumerable<double> values)
    {
        var sorted = values.Order().ToArray();
        return sorted.Length == 0 ? 0 : sorted[sorted.Length / 2];
    }
    private static double Round(double value) => Math.Round(value, value < 10 ? 2 : 1);

    private static string[]? only;
    private static long maxRows = long.MaxValue;
    /// <summary>Whether --only (names separated by commas) asks for a case, by its id or its dimension.</summary>
    private static bool Wanted(string dimension, string id = "") =>
        only is null || only.Any(name => (id.Length > 0 && id.Contains(name, StringComparison.OrdinalIgnoreCase)) || dimension.Contains(name, StringComparison.OrdinalIgnoreCase) || (id.Length == 0 && name.StartsWith(dimension, StringComparison.OrdinalIgnoreCase)));

    /// <summary>Times a case: its first build, then warm ones until seven have run or 20 s have passed (three at least).</summary>
    private static void Case(string dimension, string id, string detail, ResultStore store, ResultSetBuffer set, PivotSpec spec, int[]? order = null, SqlService? service = null, object? hostArgs = null)
    {
        if (!Wanted(dimension, id)) return;
        GC.Collect();
        var first = Once(store, set, spec, order);
        var warm = new List<Sample>();
        var watch = Stopwatch.StartNew();
        while (warm.Count < 7 && (warm.Count < 3 || watch.Elapsed.TotalSeconds < 20)) warm.Add(Once(store, set, spec, order));
        // The same pivot through the host method (dispatch, argument checks, the two Task.Run hops), when the case can be asked that way.
        var host = new List<double>();
        if (service is not null && hostArgs is not null && first.Refused is null)
        {
            var parameters = JsonSerializer.SerializeToElement(hostArgs, HostChecks.Json);
            for (var i = 0; i < Math.Min(5, warm.Count); i++)
            {
                var started = Stopwatch.GetTimestamp();
                var answer = (ResultsPivotResult)service.DispatchAsync("results.pivot", parameters, HostChecks.Json).GetAwaiter().GetResult();
                host.Add(Ms(Stopwatch.GetTimestamp() - started));
                store.Release([answer.Descriptor.ResultId]);
            }
        }
        var description = set.Describe();
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            dimension, id, detail, sourceRows = description.RowsStored, sourceBytes = description.BytesStored, columns = set.Columns.Count, pivotedRows = first.Rows,
            rowGroups = first.RowGroups, columnGroups = first.ColumnGroups, refused = first.Refused, workingBytes = first.Working, figuresBytes = first.Figures, pivotBytes = first.PivotBytes,
            allocatedBytes = warm.Select(sample => sample.Allocated).Order().ElementAt(warm.Count / 2), warmRuns = warm.Count,
            firstMs = Round(first.Total), medianMs = Round(Median(warm.Select(sample => sample.Total))), maxMs = Round(warm.Max(sample => sample.Total)),
            hostMedianMs = host.Count == 0 ? (double?)null : Round(Median(host)),
            stagesMs = new
            {
                reserve = Round(Median(warm.Select(sample => sample.Reserve))), keys = Round(Median(warm.Select(sample => sample.Keys))), grouping = Round(Median(warm.Select(sample => sample.Grouping))),
                aggregation = Round(Median(warm.Select(sample => sample.Aggregation))), distinct = Round(Median(warm.Select(sample => sample.Distinct))), shape = Round(Median(warm.Select(sample => sample.Shape))),
                write = Round(Median(warm.Select(sample => sample.Write))), release = Round(Median(warm.Select(sample => sample.Release)))
            },
            collections = new { gen0 = warm.Sum(sample => sample.Gen0), gen1 = warm.Sum(sample => sample.Gen1), gen2 = warm.Sum(sample => sample.Gen2) }
        }));
    }

    private static readonly PivotValue CountRows = new(PivotAggregate.Count, -1);
    private static object HostArgs(ResultSetBuffer set, PivotSpec spec, uint? viewId = null) => new
    {
        resultId = set.ResultId, viewId, rows = spec.Rows, column = spec.Column < 0 ? (int?)null : spec.Column,
        values = spec.Values.Select(value => new
        {
            aggregate = value.Aggregate switch
            {
                PivotAggregate.Count => "count", PivotAggregate.CountDistinct => "countDistinct", PivotAggregate.Sum => "sum", PivotAggregate.Avg => "avg", PivotAggregate.Min => "min", _ => "max"
            },
            column = value.Column < 0 ? (int?)null : value.Column
        }).ToArray()
    };

    public static void Run(string[] args)
    {
        long budgetGib = 2, viewRows = 5_000_000;
        for (var i = 1; i < args.Length - 1; i++)
        {
            if (args[i] == "--budget-gib") budgetGib = long.Parse(args[i + 1], CultureInfo.InvariantCulture);
            if (args[i] == "--only") only = args[i + 1].Split(',');
            if (args[i] == "--view-rows") viewRows = long.Parse(args[i + 1], CultureInfo.InvariantCulture);
            if (args[i] == "--max-rows") maxRows = long.Parse(args[i + 1], CultureInfo.InvariantCulture);
        }
        // The store as the backend sizes it: half the global budget a query. No memory-load check, so a busy machine refuses nothing.
        var store = new ResultStore(budgetGib << 30, budgetGib << 29);
        using var service = new SqlService(store);
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            environment = new
            {
                globalBudgetBytes = store.GlobalBytes, queryBudgetBytes = store.QueryBytes, processors = Environment.ProcessorCount, runtime = Environment.Version.ToString(),
                os = Environment.OSVersion.ToString(), serverGc = System.Runtime.GCSettings.IsServerGC, memoryBytes = GC.GetGCMemoryInfo().TotalAvailableMemoryBytes
            }
        }));
        void Go(string dimension, string id, string detail, ResultSetBuffer set, PivotSpec spec) => Case(dimension, id, detail, store, set, spec, null, service, HostArgs(set, spec));
        PivotSpec Count(params int[] rows) => new(rows, -1, [CountRows]);

        // The reported shape first, so its first build is the process's first: two results of 20,463 rows of one int column.
        if (Wanted("reported"))
        {
            var reportedA = Fill(store, 20_463, Int("status", 40));
            var reportedB = Fill(store, 20_463, Int("status", 40));
            Go("reported", "reported-first", "20,463 rows, one int column of 40 values and NULL, Count of rows by it; the first of two results", reportedA, Count(0));
            Go("reported", "reported-second", "the second result of the same shape", reportedB, Count(0));
            store.Release([reportedA.ResultId, reportedB.ResultId]);
        }

        foreach (var rows in new long[] { 1_000, 20_463, 200_000, 1_000_000, 5_000_000, 20_000_000, 50_000_000, 100_000_000, 200_000_000 })
        {
            if (rows > maxRows || !Wanted("volume", "volume-" + rows)) continue;
            // Past the budget the pivot's working memory no longer fits beside its source: stop at the first refusal.
            if (rows * 8 + ResultPivoter.WorkingBytes(rows, 1) > store.QueryBytes) { Console.WriteLine(JsonSerializer.Serialize(new { dimension = "volume", id = "volume-" + rows, skipped = "source and working memory pass the query budget" })); break; }
            var set = Fill(store, rows, Int("status", 40));
            Go("volume", "volume-" + rows, rows.ToString("N0", CultureInfo.InvariantCulture) + " rows, one int column of 40 values and NULL, Count of rows by it", set, Count(0));
            store.Release([set.ResultId]);
        }

        var million = Math.Min(1_000_000, maxRows);
        foreach (var groups in new long[] { 2, 40, 1_000, 50_000, 99_000, 500_000 })
        {
            if (!Wanted("cardinality", "cardinality-" + groups)) continue;
            var set = Fill(store, million, Int("status", groups));
            Go("cardinality", "cardinality-" + groups, million.ToString("N0", CultureInfo.InvariantCulture) + " rows, an int column of " + groups.ToString("N0", CultureInfo.InvariantCulture) + " values, Count of rows by it", set, Count(0));
            store.Release([set.ResultId]);
        }

        // Shape: the same grouping over a narrow and a wide source, more row groups, a column group, more values.
        var wide = !Wanted("shape") && !Wanted("recipe") ? Fill(store, 1, [Int("status", 40), Id(), Text("region", 12, CaseInsensitive), Decimal("amount", 100_000), Float("rate", 1_000), .. Filler()]) : Fill(store, million, [Int("status", 40), Id(), Text("region", 12, CaseInsensitive), Decimal("amount", 100_000), Float("rate", 1_000), .. Filler()]);
        Go("shape", "shape-wide", "8 columns (about 190 bytes a row), Count of rows by the int column", wide, Count(0));
        Go("shape", "shape-two-row-groups", "row groups status then region (40 x 12 values)", wide, Count(0, 2));
        Go("shape", "shape-column-group", "row group status, column group region (12 values)", wide, new PivotSpec([0], 2, [CountRows]));
        Go("shape", "shape-column-group-4-values", "row group status, column group region, Count, Sum, Average and Max of amount", wide,
            new PivotSpec([0], 2, [CountRows, new(PivotAggregate.Sum, 3), new(PivotAggregate.Avg, 3), new(PivotAggregate.Max, 3)]));

        // Recipe: one aggregate at a time over the wide source, grouped by status.
        foreach (var (name, value) in new (string, PivotValue)[]
        {
            ("count-rows", CountRows), ("count-column", new(PivotAggregate.Count, 3)), ("sum-decimal", new(PivotAggregate.Sum, 3)), ("avg-decimal", new(PivotAggregate.Avg, 3)),
            ("sum-float", new(PivotAggregate.Sum, 4)), ("min-decimal", new(PivotAggregate.Min, 3)), ("max-decimal", new(PivotAggregate.Max, 3)), ("distinct-decimal", new(PivotAggregate.CountDistinct, 3)),
            ("distinct-text", new(PivotAggregate.CountDistinct, 2)), ("min-text", new(PivotAggregate.Min, 2))
        })
            Go("recipe", "recipe-" + name, "status row group, one value: " + name, wide, new PivotSpec([0], -1, [value]));
        Go("recipe", "recipe-all-six", "status row group; Count, Distinct Count, Sum, Average, Min and Max of amount", wide, new PivotSpec([0], -1,
            [new(PivotAggregate.Count, 3), new(PivotAggregate.CountDistinct, 3), new(PivotAggregate.Sum, 3), new(PivotAggregate.Avg, 3), new(PivotAggregate.Min, 3), new(PivotAggregate.Max, 3)]));
        store.Release([wide.ResultId]);

        // Values: the group column's type, 40 and 50,000 values each.
        foreach (var groups in new long[] { 40, 50_000 })
        {
            foreach (var (name, column) in new (string, Column)[]
            {
                ("int", Int("value", groups)), ("decimal-18-2", Decimal("value", groups)), ("decimal-38-10", BigDecimal("value", groups)), ("float", Float("value", groups)), ("datetime2", Date("value", groups)),
                ("text-case-insensitive", Text("value", groups, CaseInsensitive)), ("text-binary", Text("value", groups, Binary)), ("text-long-prefix", LongText("value", groups))
            })
            {
                if (!Wanted("values", "values-" + name + "-" + groups)) continue;
                var set = Fill(store, million, column);
                Go("values", "values-" + name + "-" + groups, million.ToString("N0", CultureInfo.InvariantCulture) + " rows, one " + name + " column of " + groups.ToString("N0", CultureInfo.InvariantCulture) + " values, Count of rows by it", set, Count(0));
                store.Release([set.ResultId]);
            }
        }

        // Threshold: the sizes an automatic rebuild might be allowed at, each with an easy recipe and the slowest ones found.
        foreach (var rows in new long[] { 50_000, 100_000, 250_000, 500_000 })
        {
            if (rows > maxRows || !Wanted("threshold")) continue;
            var label = rows.ToString("N0", CultureInfo.InvariantCulture) + " rows: ";
            void At(string name, string detail, PivotSpec spec, params Column[] columns)
            {
                if (!Wanted("threshold", "threshold-" + rows + "-" + name)) return;
                var set = Fill(store, rows, columns);
                Go("threshold", "threshold-" + rows + "-" + name, label + detail, set, spec);
                store.Release([set.ResultId]);
            }
            At("int", "Count of rows by an int of 40 values", Count(0), Int("value", 40));
            At("text", "Count of rows by a case-insensitive text of 40 values", Count(0), Text("value", 40, CaseInsensitive));
            At("text-many", "Count of rows by a case-insensitive text with a value every 20 rows", Count(0), Text("value", rows / 20, CaseInsensitive));
            At("date", "Count of rows by a datetime2 of 40 values", Count(0), Date("value", 40));
            At("decimal-38", "Count of rows by a decimal(38,10) of 40 values", Count(0), BigDecimal("value", 40));
            At("long-text-many", "Count of rows by a text of 190 characters with a value every 20 rows", Count(0), LongText("value", rows / 20));
            At("wide-worst", "8 columns; row groups an int and a text, Count of rows, Sum of a decimal and Distinct Count of a text that never repeats",
                new PivotSpec([0, 2], -1, [CountRows, new(PivotAggregate.Sum, 3), new(PivotAggregate.CountDistinct, 5)]),
                [Int("status", 40), Id(), Text("region", 12, CaseInsensitive), Decimal("amount", 100_000), Float("rate", 1_000), .. Filler()]);
        }

        // Source view: the grid's filter or sort decides the rows pivoted; the keys still cover every stored row.
        viewRows = Math.Min(viewRows, maxRows);
        if (!Wanted("view") && !Wanted("parallel") && !Wanted("cancel")) viewRows = 1000;
        var viewed = Fill(store, viewRows, Int("status", 100, nullEvery: 0), Id());
        T Call<T>(string method, object arguments) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(arguments, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        void Viewed(string id, string detail, object[] filters, object[] sort)
        {
            var watch = Stopwatch.StartNew();
            var view = Call<ResultsViewResult>("results.view", new { resultId = viewed.ResultId, sort, filters });
            var built = watch.Elapsed.TotalMilliseconds;
            var order = store.FindView(viewed.ResultId, view.ViewId)!.Order;
            var spec = Count(0);
            Case("view", id, detail + "; " + view.Rows.ToString("N0", CultureInfo.InvariantCulture) + " of " + viewRows.ToString("N0", CultureInfo.InvariantCulture) + " rows in the view, which took " + Round(built).ToString(CultureInfo.InvariantCulture) + " ms to build",
                store, viewed, spec, order, service, HostArgs(viewed, spec, view.ViewId));
            store.CloseViews(viewed.ResultId, [view.ViewId]);
        }
        int RowOf(long value) { for (var row = 0; ; row++) if (Pick(row, 100) == value) return row; }
        if (Wanted("view"))
        {
        Go("view", "view-none", viewRows.ToString("N0", CultureInfo.InvariantCulture) + " rows, an int column of 100 values and an id; no view", viewed, Count(0));
        Viewed("view-filter-1-percent", "a filter keeping one value of 100", [new { op = "in", column = 0, rows = new[] { RowOf(17) } }], []);
        Viewed("view-filter-50-percent", "a filter keeping values 0 to 49", [new { op = "between", column = 0, rows = new[] { RowOf(0), RowOf(49) } }], []);
        Viewed("view-sorted", "sorted by the group column, descending", [], [new { column = 0, descending = true, mode = "value" }]);
        Viewed("view-sorted-by-id", "sorted by id, descending (the group column is not the sort's)", [], [new { column = 1, descending = true, mode = "value" }]);
        }

        // Parallel builds of one query share its budget: how long each takes, and how many are refused.
        if (Wanted("parallel"))
        {
            foreach (var count in new[] { 1, 2, 4, 8 })
            {
                var watch = Stopwatch.StartNew();
                var samples = Task.WhenAll(Enumerable.Range(0, count).Select(_ => Task.Run(() => Once(store, viewed, Count(0), null)))).GetAwaiter().GetResult();
                var done = samples.Where(sample => sample.Refused is null).ToArray();
                Console.WriteLine(JsonSerializer.Serialize(new
                {
                    dimension = "parallel", id = "parallel-" + count, sourceRows = viewRows, builds = count, refused = samples.Length - done.Length, wallMs = Round(watch.Elapsed.TotalMilliseconds),
                    medianBuildMs = done.Length == 0 ? 0 : Round(Median(done.Select(sample => sample.Total))), slowestBuildMs = done.Length == 0 ? 0 : Round(done.Max(sample => sample.Total)),
                    workingBytesEach = samples[0].Working, queryBudgetBytes = store.QueryBytes, sourceBytes = viewed.Describe().BytesStored
                }));
            }
        }

        // Cancellation: a CANCEL at points through a build, and how long the build takes to stop; nothing stays reserved.
        if (Wanted("cancel"))
        {
            var spec = new PivotSpec([0], -1, [CountRows, new(PivotAggregate.CountDistinct, 1)]);
            var whole = Median(Enumerable.Range(0, 3).Select(_ => Once(store, viewed, spec, null).Total));
            var used = store.UsedBytes;
            var latencies = new List<(double At, double Ms)>();
            var wrapped = 0;
            foreach (var fraction in new[] { 0.05, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9 })
            {
                using var cancel = new CancellationTokenSource();
                var started = Stopwatch.GetTimestamp();
                var build = Task.Run(() => Once(store, viewed, spec, null, cancel.Token));
                while (Ms(Stopwatch.GetTimestamp() - started) < whole * fraction) Thread.SpinWait(50);
                var asked = Stopwatch.GetTimestamp();
                cancel.Cancel();
                try { build.GetAwaiter().GetResult(); }
                catch (OperationCanceledException) { latencies.Add((fraction, Ms(Stopwatch.GetTimestamp() - asked))); }
                // Array.Sort wraps what its comparer throws: a cancel during a sort arrives as an InvalidOperationException.
                catch (InvalidOperationException error) when (error.InnerException is OperationCanceledException)
                {
                    wrapped++;
                    latencies.Add((fraction, Ms(Stopwatch.GetTimestamp() - asked)));
                }
            }
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                dimension = "cancel", id = "cancel", sourceRows = viewRows, detail = "Count of rows and Distinct Count of id by status", uncancelledMs = Round(whole), cancelled = latencies.Count, wrappedBySort = wrapped,
                latencyMs = latencies.Select(item => new { at = item.At, ms = Round(item.Ms) }), slowestMs = latencies.Count == 0 ? 0 : Round(latencies.Max(item => item.Ms)), reservedAfter = store.UsedBytes - used
            }));
        }
        store.Release([viewed.ResultId]);

        // A refusal: a source that leaves no room for the working memory is refused before anything is read.
        if (Wanted("refusal"))
        {
            var small = new ResultStore(64L << 20, 32L << 20);
            using var host = new SqlService(small);
            var set = Fill(small, 2_000_000, Int("status", 40));
            var used = small.UsedBytes;
            var watch = Stopwatch.StartNew();
            string? code = null;
            try { host.DispatchAsync("results.pivot", JsonSerializer.SerializeToElement(HostArgs(set, Count(0)), HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); }
            catch (RequestException error) { code = error.Code; }
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                dimension = "refusal", id = "refusal-working-memory", sourceRows = 2_000_000, sourceBytes = set.Describe().BytesStored, queryBudgetBytes = small.QueryBytes,
                workingBytes = ResultPivoter.WorkingBytes(2_000_000, 1), code, refusedInMs = Round(watch.Elapsed.TotalMilliseconds), reservedAfter = small.UsedBytes - used
            }));
        }
    }
}
