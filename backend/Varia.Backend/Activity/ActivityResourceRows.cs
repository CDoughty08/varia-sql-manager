using System.Globalization;
using Varia.Backend.Live;

namespace Varia.Backend.Activity;

/// <summary>What one resources sample gives the live tables: each table's rows (null when its statement did not run), the rows
/// past a cap, which rows are benign (Hide benign waits), what Data File I/O's chips test about each file, and the probe's
/// series values (aligned with the catalogue's: each wait.&lt;category&gt;, then wait.signal; null without a rate).</summary>
internal sealed record ActivityResourcesSample(List<LiveRow>? Categories, List<LiveRow>? Types, long TypesMore, IReadOnlySet<LiveRow> Benign, List<LiveRow>? Files, long FilesMore,
    IReadOnlyDictionary<LiveRow, FileFacts> FileFacts, double?[] Series);

/// <summary>The resources probe's rows (Resource Waits and Data File I/O). Wait rates are per wait type between two samples
/// that both read sys.dm_os_wait_stats, over the probe's sample clock (the server's ms_ticks between samples that read it):
/// a type new since the last sample counts from zero (the statement leaves out types that never waited), and a type whose
/// counters went down means the statistics were cleared, so that sample has no rate at all. A first sample, the first after
/// a pause, a restart or a lost connection has none either (Reset). Types roll up to the catalogue's categories (benign
/// names in Idle, Unknown shown); the 1-Minute Average is the time-weighted mean of the samples in the last minute. File
/// rates are per file, keyed by database and file id (LiveKeyedDeltas, so a reused id whose counters went down starts
/// again), with latencies as stall per I/O in the interval, toned by the files filter's thresholds. Pure apart from those
/// baselines, so the offline checks feed it rows. Nothing is logged.</summary>
internal sealed class ActivityResourceRows
{
    private readonly record struct WaitCounters(double Tasks, double WaitMs, double SignalMs);
    private readonly record struct Interval(long At, long Span, double[] WaitMs);

    private readonly ActivityCatalog catalog;
    private readonly ActivityRowWriter categories;
    private readonly ActivityRowWriter types;
    private readonly ActivityRowWriter files;
    private readonly LiveKeyedDeltas fileRates;
    private readonly Dictionary<string, int> categoryIndex;
    private readonly string[] seriesCategories;
    private Dictionary<string, WaitCounters>? previous;
    private long previousAt;
    private readonly Queue<Interval> minute = new();

    public ActivityResourceRows(ActivityCatalog catalog)
    {
        this.catalog = catalog;
        categories = new(catalog.Table("waitCategories"));
        types = new(catalog.Table("waitTypes"));
        files = new(catalog.Table("files"));
        fileRates = new(catalog.Table("files").RowCap);
        categoryIndex = catalog.WaitCategories.Select((id, at) => (id, at)).ToDictionary(item => item.id, item => item.at, StringComparer.Ordinal);
        seriesCategories = [.. catalog.WaitCategories];
    }

    public ActivityRowWriter CategoriesWriter => categories;
    public ActivityRowWriter TypesWriter => types;
    public ActivityRowWriter FilesWriter => files;

    /// <summary>After a pause, a restart or a lost connection, rates and the minute's mean start again.</summary>
    public void Reset()
    {
        previous = null;
        minute.Clear();
        fileRates.Clear();
    }

    /// <param name="series">The probe's series ids, in the live catalogue's order.</param>
    /// <param name="at">This sample's time in milliseconds on the probe's sample clock.</param>
    public ActivityResourcesSample Build(IReadOnlyDictionary<string, ActivityResult> results, long at, IReadOnlyList<string> series, int latencyWarningMs, int latencyErrorMs)
    {
        var benign = new HashSet<LiveRow>(ReferenceEqualityComparer.Instance);
        var values = new double?[series.Count];
        List<LiveRow>? categoryRows = null, typeRows = null;
        long typesMore = 0;
        if (results.TryGetValue("waitStats", out var stats))
            (categoryRows, typeRows, typesMore) = Waits(stats, results.GetValueOrDefault("waiters"), at, series, values, benign);
        var facts = new Dictionary<LiveRow, FileFacts>(ReferenceEqualityComparer.Instance);
        List<LiveRow>? fileRows = null;
        long filesMore = 0;
        if (results.TryGetValue("files", out var io)) (fileRows, filesMore) = Files(io, at, latencyWarningMs, latencyErrorMs, facts);
        return new(categoryRows, typeRows, typesMore, benign, fileRows, filesMore, facts, values);
    }

    private sealed class TypeRow(string type, WaitClass wait)
    {
        public string Type = type;
        public WaitClass Class = wait;
        public WaitCounters Now;
        public double MaxWaitMs;
        public bool Read;
        public int? Waiters;
        public double? WaitRate, SignalRate, WaitsRate, AverageWaitMs;
    }

    private (List<LiveRow> Categories, List<LiveRow> Types, long More) Waits(ActivityResult stats, ActivityResult? waiters, long at, IReadOnlyList<string> series, double?[] values,
        HashSet<LiveRow> benign)
    {
        var rows = new Dictionary<string, TypeRow>(StringComparer.Ordinal);
        TypeRow Row(string type) => rows.TryGetValue(type, out var row) ? row : rows[type] = new(type, catalog.Classify(type));
        var current = new Dictionary<string, WaitCounters>(StringComparer.Ordinal);
        foreach (var raw in stats.Rows)
        {
            if (stats.Text(raw, "wait_type") is not { } type) continue;
            var counters = new WaitCounters(stats.Double(raw, "waiting_tasks_count") ?? 0, stats.Double(raw, "wait_time_ms") ?? 0, stats.Double(raw, "signal_wait_time_ms") ?? 0);
            if (!current.TryAdd(type, counters)) continue;
            var row = Row(type);
            (row.Now, row.MaxWaitMs, row.Read) = (counters, stats.Double(raw, "max_wait_time_ms") ?? 0, true);
        }
        if (waiters is not null)
            foreach (var raw in waiters.Rows)
                if (waiters.Text(raw, "wait_type") is { } type) Row(type).Waiters = waiters.Int(raw, "waiters") ?? 0;

        // Rates need a baseline with time since, and no counter that went down (cleared statistics): then none at all.
        var elapsed = previous is null ? 0 : at - previousAt;
        var rated = previous is not null && elapsed > 0 && !current.Any(entry => previous.TryGetValue(entry.Key, out var before)
            && (entry.Value.Tasks < before.Tasks || entry.Value.WaitMs < before.WaitMs || entry.Value.SignalMs < before.SignalMs));
        var count = catalog.WaitCategories.Count;
        var categoryWait = new double[count];
        var categorySignal = new double[count];
        var categoryCumulative = new double[count];
        var categoryWaiters = new int?[count];
        var categorySeen = new bool[count];
        var top = new TypeRow?[count];
        double signal = 0;
        foreach (var row in rows.Values)
        {
            var category = categoryIndex.TryGetValue(row.Class.Category, out var known) ? known : categoryIndex["unknown"];
            categorySeen[category] = true;
            if (waiters is not null) categoryWaiters[category] = (categoryWaiters[category] ?? 0) + (row.Waiters ?? 0);
            categoryCumulative[category] += Math.Max(0, row.Now.WaitMs - row.Now.SignalMs);
            if (!rated || !row.Read) continue;
            var before = previous!.GetValueOrDefault(row.Type);
            var waitMs = row.Now.WaitMs - before.WaitMs;
            var signalMs = row.Now.SignalMs - before.SignalMs;
            var tasks = row.Now.Tasks - before.Tasks;
            // Signal wait is part of wait time; a sample that read the two a moment apart may show more of it.
            var resourceMs = Math.Max(0, waitMs - signalMs);
            row.WaitRate = resourceMs * 1000 / elapsed;
            row.SignalRate = signalMs * 1000 / elapsed;
            row.WaitsRate = tasks * 1000 / elapsed;
            row.AverageWaitMs = tasks > 0 ? waitMs / tasks : null;
            categoryWait[category] += resourceMs;
            categorySignal[category] += signalMs;
            signal += signalMs;
            if (resourceMs > 0 && (top[category] is not { } best || row.WaitRate > best.WaitRate)) top[category] = row;
        }
        previous = current;
        previousAt = at;

        // The minute's mean: wait time over the time the samples in the last minute span.
        if (rated) minute.Enqueue(new(at, elapsed, categoryWait));
        var window = catalog.Limit("waitAverageMs");
        while (minute.TryPeek(out var oldest) && oldest.At <= at - window) minute.Dequeue();
        var spanned = minute.Sum(entry => entry.Span);

        for (var i = 0; i < series.Count; i++)
        {
            if (!rated) continue;
            if (series[i] == "wait.signal") values[i] = signal * 1000 / elapsed;
            else if (series[i].StartsWith("wait.", StringComparison.Ordinal) && categoryIndex.TryGetValue(series[i]["wait.".Length..], out var category)) values[i] = categoryWait[category] * 1000 / elapsed;
        }

        var categoryRows = new List<LiveRow>(count);
        for (var category = 0; category < count; category++)
        {
            if (!categorySeen[category]) continue;
            var id = seriesCategories[category];
            var cells = categories.New();
            double? rate = rated ? categoryWait[category] * 1000 / elapsed : null;
            categories.Set(cells, "categoryId", LiveCell.Of(id));
            categories.Set(cells, "category", LiveCell.Of(catalog.WaitLabels.GetValueOrDefault(id, id)));
            categories.Set(cells, "waitRate", ActivityRowWriter.Decimal(rate, 1));
            categories.Set(cells, "signalRate", ActivityRowWriter.Decimal(rated ? categorySignal[category] * 1000 / elapsed : null, 1));
            categories.Set(cells, "minuteAverage", ActivityRowWriter.Decimal(spanned > 0 ? minute.Sum(entry => entry.WaitMs[category]) * 1000 / spanned : null, 1));
            categories.Set(cells, "averageWaiters", ActivityRowWriter.Decimal(rate / 1000, 3));
            categories.Set(cells, "currentWaiters", LiveCell.Of((long?)categoryWaiters[category]));
            categories.Set(cells, "cumulativeSeconds", ActivityRowWriter.Decimal(categoryCumulative[category] / 1000, 3));
            categories.Set(cells, "topWaitType", LiveCell.Of(top[category]?.Type));
            var live = new LiveRow(cells);
            if (catalog.BenignCategories.Contains(id)) benign.Add(live);
            categoryRows.Add(live);
        }

        // Types with time in the interval or a waiter now; without a rate, every type with time since SQL Server started.
        var shown = rows.Values.Where(row => row.Waiters > 0 || (rated ? row.WaitRate > 0 || row.SignalRate > 0 || row.WaitsRate > 0 : row.Now.WaitMs > 0))
            .OrderByDescending(row => row.WaitRate ?? -1).ThenByDescending(row => row.Now.WaitMs - row.Now.SignalMs).ThenBy(row => row.Type, StringComparer.Ordinal).ToList();
        var cap = (int)catalog.Limit("waitTypes");
        var typeRows = new List<LiveRow>(Math.Min(cap, shown.Count));
        foreach (var row in shown.Take(cap))
        {
            var cells = types.New();
            types.Set(cells, "waitType", LiveCell.Of(row.Type));
            types.Set(cells, "category", LiveCell.Of(catalog.WaitLabels.GetValueOrDefault(row.Class.Category, row.Class.Category)));
            types.Set(cells, "waitRate", ActivityRowWriter.Decimal(row.WaitRate, 1));
            types.Set(cells, "signalRate", ActivityRowWriter.Decimal(row.SignalRate, 1));
            types.Set(cells, "waitsRate", ActivityRowWriter.Decimal(row.WaitsRate, 1));
            types.Set(cells, "averageWaitMs", ActivityRowWriter.Decimal(row.AverageWaitMs, 1));
            types.Set(cells, "maxWaitMs", row.Read ? LiveCell.Of((long)row.MaxWaitMs) : LiveCell.Null);
            types.Set(cells, "currentWaiters", LiveCell.Of((long?)row.Waiters ?? (waiters is null ? null : 0)));
            types.Set(cells, "cumulativeSeconds", row.Read ? ActivityRowWriter.Decimal(Math.Max(0, row.Now.WaitMs - row.Now.SignalMs) / 1000, 3) : LiveCell.Null);
            types.Set(cells, "benign", LiveCell.Bit(row.Class.Benign));
            var live = new LiveRow(cells);
            if (row.Class.Benign) benign.Add(live);
            typeRows.Add(live);
        }
        return (categoryRows, typeRows, Math.Max(0, shown.Count - cap));
    }

    private static readonly string[] FileCounters =
        ["num_of_bytes_read", "num_of_bytes_written", "num_of_reads", "num_of_writes", "io_stall_read_ms", "io_stall_write_ms", "io_stall_queued_read_ms", "io_stall_queued_write_ms"];

    private (List<LiveRow> Rows, long More) Files(ActivityResult io, long at, int warningMs, int errorMs, Dictionary<LiveRow, FileFacts> facts)
    {
        const double Megabyte = 1024 * 1024;
        var cap = (int)catalog.Limit("files");
        var rows = new List<LiveRow>(Math.Min(cap, io.Rows.Count));
        foreach (var raw in io.Rows.Take(cap))
        {
            var database = io.Int(raw, "database_id") ?? 0;
            var file = io.Int(raw, "file_id") ?? 0;
            var r = fileRates.Apply(database.ToString(CultureInfo.InvariantCulture) + "\u001f" + file.ToString(CultureInfo.InvariantCulture),
                [.. FileCounters.Select(column => io.Double(raw, column) ?? 0)], at);
            // Stall per I/O in the interval: the two rates share it, so their ratio is the change in stall over the change in count.
            double? readLatency = r[2] is > 0 && r[4] is { } readStall ? readStall / r[2]!.Value : null;
            double? writeLatency = r[3] is > 0 && r[5] is { } writeStall ? writeStall / r[3]!.Value : null;
            double? response = r[2] is { } reads && r[3] is { } writes && reads + writes > 0 && r[4] is { } stallRead && r[5] is { } stallWrite ? (stallRead + stallWrite) / (reads + writes) : null;
            var worst = Math.Max(readLatency ?? 0, writeLatency ?? 0);
            var tone = worst >= errorMs ? "latencyError" : worst >= warningMs ? "latencyWarning" : null;
            var (typeId, typeLabel) = Type(io.Text(raw, "type_desc"));

            var cells = files.New();
            files.Set(cells, "databaseId", LiveCell.Of(database));
            files.Set(cells, "fileId", LiveCell.Of(file));
            files.Set(cells, "database", LiveCell.Of(io.Text(raw, "database_name") ?? "database " + database.ToString(CultureInfo.InvariantCulture)));
            files.Set(cells, "file", LiveCell.Of(io.Text(raw, "file_name") ?? "file " + file.ToString(CultureInfo.InvariantCulture)));
            files.Set(cells, "type", LiveCell.Of(typeLabel));
            files.Set(cells, "fileName", LiveCell.Of(io.Text(raw, "physical_name")));
            files.Set(cells, "readMbRate", ActivityRowWriter.Decimal(r[0] / Megabyte, 3));
            files.Set(cells, "writeMbRate", ActivityRowWriter.Decimal(r[1] / Megabyte, 3));
            files.Set(cells, "totalMbRate", ActivityRowWriter.Decimal(r[0] is { } read && r[1] is { } written ? (read + written) / Megabyte : null, 3));
            files.Set(cells, "readsRate", ActivityRowWriter.Decimal(r[2], 1));
            files.Set(cells, "writesRate", ActivityRowWriter.Decimal(r[3], 1));
            files.Set(cells, "readLatencyMs", ActivityRowWriter.Decimal(readLatency, 1));
            files.Set(cells, "writeLatencyMs", ActivityRowWriter.Decimal(writeLatency, 1));
            files.Set(cells, "responseTimeMs", ActivityRowWriter.Decimal(response, 1));
            files.Set(cells, "throttledRate", ActivityRowWriter.Decimal(r[6] is { } queuedRead && r[7] is { } queuedWrite ? queuedRead + queuedWrite : null, 1));
            files.Set(cells, "sizeMb", ActivityRowWriter.Decimal(io.Double(raw, "size_on_disk_bytes") / Megabyte, 2));
            if (tone is not null) files.Tone(cells, tone, catalog);
            var live = new LiveRow(cells);
            facts[live] = new(typeId, tone is not null);
            rows.Add(live);
        }
        fileRates.EndSample();
        return (rows, Math.Max(0, io.Rows.Count - cap));
    }

    /// <summary>A file's type id (for the chips) and caption, from sys.master_files' type_desc; null when its name is hidden.</summary>
    internal static (string? Id, string? Label) Type(string? typeDesc) => typeDesc switch
    {
        "ROWS" => ("rows", "Rows"),
        "LOG" => ("log", "Log"),
        "FILESTREAM" => ("filestream", "FILESTREAM"),
        "FULLTEXT" => ("fulltext", "Full-text"),
        null => (null, null),
        _ => (typeDesc.ToLowerInvariant(), typeDesc)
    };
}
