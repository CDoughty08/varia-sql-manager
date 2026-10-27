using System.Globalization;
using Varia.Backend.Results;

namespace Varia.Backend.Live;

/// <summary>debug.synthetic (VARIA_BACKEND_TEST_HOOKS=1 only): generated values that exercise the live protocol and the live
/// tables without SQL Server. Its metrics probe counts samples and draws a wave; its table probe stores a snapshot per
/// sample whose rows move on by one id each time; its status probe reports the phase and sample count. Its grid probe
/// writes two snapshot tables from one sample (items, with a view, facets and departed rows, and their groups, built from
/// the source's own state); its log probe grows an append table from an in-memory log, with late rows (an id that becomes
/// visible after higher ones), a start position, and a restart when its filter or level changes; its wide probe is the
/// 23-column snapshot the churn benchmark stores. Args set the row counts, a sampling period below the 1 s minimum (tickMs),
/// a sample count after which the source ends, and an error value every n-th sample. Every table goes through the live
/// table writers (LiveTables.cs), as the SQL sources' do.</summary>
internal sealed class SyntheticSampler : ILiveSampler
{
    public const string Source = "debug.synthetic";
    public const string MetricsProbe = "debug.synthetic.metrics";
    public const string TableProbe = "debug.synthetic.table";
    public const string StatusProbe = "debug.synthetic.status";
    public const string GridProbe = "debug.synthetic.grid";
    public const string LogProbe = "debug.synthetic.log";
    public const string WideProbe = "debug.synthetic.wide";
    /// <summary>The in-memory log keeps at most this many messages (the oldest go first).</summary>
    internal const int LogCapacity = 400_000;
    private static readonly DateTime Epoch = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Unspecified);
    private readonly LiveTableSet tables;
    private readonly LiveLimitsJson limits;
    private readonly Lock gate = new();
    private readonly List<(long Id, int Level, string Text)> log = [];
    private SyntheticLiveArgs args;
    private LiveStart start = LiveStart.Beginning;
    private bool restartLog;
    private IReadOnlyList<LiveCursor> resume = [];
    /// <summary>A message held back one sample, as a writer's commit that lands after higher ids.</summary>
    private (long Id, int Level, string Text)? late;
    private long metricSamples, tableSamples, statusSamples, gridSamples, logSamples, wideSamples, ticks, nextLogId;

    public SyntheticSampler(ResultStore store, string subscriptionId, SyntheticLiveArgs args, LiveLimitsJson limits)
    {
        // Only bookkeeping: nothing is stored or released until the subscription samples.
        tables = new LiveTableSet(store, subscriptionId, limits);
        this.limits = limits;
        this.args = args;
        if (args.Start is { } value) start = LiveStart.Parse(value, limits.SegmentRows);
    }

    /// <summary>Checks args as main's schema does (src/shared/live/schema.ts, liveArgsSchemas).</summary>
    public static SyntheticLiveArgs Check(SyntheticLiveArgs args, int maxTail)
    {
        if (args.Rows is < 0 or > 10_000 || args.TickMs is < 10 or > 60_000 || args.EndAfterTicks is < 1 or > 10_000 || args.ErrorEvery is < 1 or > 1000
            || args.LogRows is < 0 or > 10_000 || args.LogLevel is < 0 or > 3 || args.LateEvery is < 1 or > 1000)
            throw new RequestException("INVALID_PARAMS", "Invalid arguments for this source.");
        if (args.Start is { } value) LiveStart.Parse(value, maxTail);
        return args;
    }

    public int? PeriodMs { get { lock (gate) return args.TickMs; } }

    public bool Ended { get { lock (gate) return args.EndAfterTicks is { } end && ticks >= end; } }

    public void Apply(object value)
    {
        var next = (SyntheticLiveArgs)value;
        // An update replaces only the members it names; a new start starts the log again (a new level changes its predicate).
        lock (gate)
        {
            if (next.Start is { } named)
            {
                start = LiveStart.Parse(named, limits.SegmentRows);
                restartLog = true;
            }
            args = new(next.Rows ?? args.Rows, next.TickMs ?? args.TickMs, next.EndAfterTicks ?? args.EndAfterTicks, next.ErrorEvery ?? args.ErrorEvery,
                next.LogRows ?? args.LogRows, next.LogLevel ?? args.LogLevel, next.LateEvery ?? args.LateEvery, null);
        }
    }

    public Task<LiveOpening> OpenAsync(IReadOnlyList<LiveProbeState> probes, IReadOnlyList<LiveCursor> resume, CancellationToken token)
    {
        this.resume = resume;
        return Task.FromResult(new LiveOpening([.. probes.Select(probe => new LiveOpenedProbe(probe.Spec.Id, probe.IntervalMs, probe.Spec.IntervalMs.Min, probe.Spec.IntervalMs.Max, "ok"))]));
    }

    public Task<LiveSampleBatch> SampleAsync(IReadOnlyList<LiveDue> due, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        SyntheticLiveArgs current;
        bool restart;
        lock (gate)
        {
            current = args;
            restart = restartLog;
            restartLog = false;
            ticks++;
        }
        tables.BeginTick();
        var samples = new List<LiveSample>();
        var errors = new List<LiveProbeError>();
        List<LiveCursor>? cursors = null;
        foreach (var item in due)
        {
            var probe = item.Probe;
            var spec = probe.Spec;
            LiveSample Sample(IReadOnlyList<LiveSnapshotSample>? snapshots = null, IReadOnlyList<LiveAppendSample>? append = null, IReadOnlyList<LiveStatus>? status = null, double?[]? metrics = null) =>
                new(spec.Id, 0, probe.IntervalMs, item.ElapsedMs, item.Gap, item.Skipped, metrics, snapshots, append, status);
            LiveProbeError Budget(int[] indexes) => LiveErrors.Create(spec.Id, "BUDGET", LiveErrors.BudgetMessage) with { Tables = indexes };
            switch (spec.Id)
            {
                case MetricsProbe:
                {
                    var n = ++metricSamples;
                    var wave = 50 + 50 * Math.Sin(n / 4.0);
                    // A rate has no value until a second sample, as a cumulative counter's would.
                    samples.Add(Sample(metrics: [n, wave, item.ElapsedMs is null || item.Gap is "resumed" ? null : wave * 1000.0 / Math.Max(1, item.ElapsedMs.Value)]));
                    break;
                }
                case TableProbe:
                {
                    var sample = ++tableSamples;
                    if (current.ErrorEvery is { } every && sample % every == 0)
                    {
                        errors.Add(new LiveProbeError(spec.Id, "SQL_ERROR", "The synthetic source failed this sample, as the test asked.", null, probe.IntervalMs, false));
                        break;
                    }
                    var rows = Enumerable.Range(0, current.Rows ?? 3).Select(offset => sample + offset)
                        .Select(id => new LiveRow([LiveCell.Of(id), LiveCell.Of("Row " + id.ToString(CultureInfo.InvariantCulture)), LiveCell.Of(id * 37 % 100 + sample % 7)])).ToList();
                    var write = tables.Snapshot(spec, 0).Write(rows, new(item.Sort, item.Filter, null, item.Tracks.GetValueOrDefault(0)));
                    if (write.Sample is { } table) samples.Add(Sample([table]));
                    if (write.Budget) errors.Add(Budget([0]));
                    break;
                }
                case StatusProbe:
                {
                    var count = ++statusSamples;
                    samples.Add(Sample(status: [new LiveStatus("phase", count % 2 == 0 ? "even" : "odd"), new LiveStatus("samples", count)]));
                    break;
                }
                case GridProbe:
                {
                    var (snapshots, error, budget) = Grid(item, current);
                    samples.Add(Sample(snapshots.Count > 0 ? snapshots : null));
                    if (error is not null) errors.Add(error);
                    if (budget.Length > 0) errors.Add(Budget(budget));
                    break;
                }
                case LogProbe:
                {
                    var write = Log(item, current, restart);
                    // A probe with nothing new still reports its sample, so the schedule sees it succeed.
                    if (write.Sample is { } append) samples.Add(Sample(append: [append]));
                    else if (!write.Budget) samples.Add(Sample());
                    if (write.Budget) errors.Add(Budget([0]));
                    cursors = tables.Cursors();
                    break;
                }
                case WideProbe:
                {
                    var write = tables.Snapshot(spec, 0).Write(Wide(++wideSamples, current.Rows ?? 3), new(item.Sort, item.Filter, null, item.Tracks.GetValueOrDefault(0)));
                    var gen2 = new LiveStatus("gen2", GC.CollectionCount(2));
                    samples.Add(write.Sample is { } table ? Sample([table], status: [gen2]) : Sample(status: [gen2]));
                    if (write.Budget) errors.Add(Budget([0]));
                    break;
                }
            }
        }
        return Task.FromResult(new LiveSampleBatch(samples, errors, null, cursors));
    }

    /// <summary>Items (ids sample … sample + rows − 1, in five groups) and the groups' item counts, which come from this
    /// source's own state, not a query. With errorEvery, every n-th sample fails the groups table alone, as one failed
    /// statement of a batch would, while the probe's other table still arrives.</summary>
    private (List<LiveSnapshotSample> Snapshots, LiveProbeError? Error, int[] Budget) Grid(LiveDue item, SyntheticLiveArgs current)
    {
        var spec = item.Probe.Spec;
        var n = ++gridSamples;
        var items = Enumerable.Range(0, current.Rows ?? 3).Select(offset => n + offset)
            .Select(id => new LiveRow([LiveCell.Of(id), LiveCell.Of("G" + (id % 5).ToString(CultureInfo.InvariantCulture)), LiveCell.Of("Item " + id.ToString(CultureInfo.InvariantCulture)),
                LiveCell.Of(id * 37 % 100 + n % 7)])).ToList();
        Func<LiveRow, bool>? view = item.View == "even" ? row => row.Cells[0].Value is long id && id % 2 == 0 : null;
        var snapshots = new List<LiveSnapshotSample>();
        var budget = new List<int>();
        var first = tables.Snapshot(spec, 0).Write(items, new(item.Sort, item.Filter, view, item.Tracks.GetValueOrDefault(0)));
        if (first.Sample is { } a) snapshots.Add(a);
        if (first.Budget) budget.Add(0);
        if (current.ErrorEvery is { } every && n % every == 0)
            return (snapshots, new LiveProbeError(spec.Id, "SQL_ERROR", "The synthetic source failed the groups of this sample, as the test asked.", null, item.Probe.IntervalMs, false, Tables: [1]), [.. budget]);
        var groups = items.GroupBy(row => row.Cells[1].Text!, StringComparer.Ordinal).OrderBy(group => group.Key, StringComparer.Ordinal)
            .Select(group => new LiveRow([LiveCell.Of(group.Key), LiveCell.Of(group.Count())])).ToList();
        var second = tables.Snapshot(spec, 1).Write(groups, new(item.Sort, item.Filter, null, item.Tracks.GetValueOrDefault(1)));
        if (second.Sample is { } b) snapshots.Add(b);
        if (second.Budget) budget.Add(1);
        return (snapshots, null, [.. budget]);
    }

    /// <summary>The log: logRows new messages a sample (level id % 4), the first held back a sample with lateEvery; then the
    /// read an SQL source would run: the visible messages above the settled id (and below the table's end) that match the
    /// level and filter, by id, at most the rows the table asks for. A new level, filter or start starts the table again.</summary>
    private LiveTableWrite<LiveAppendSample> Log(LiveDue item, SyntheticLiveArgs current, bool restart)
    {
        var spec = item.Probe.Spec;
        var n = ++logSamples;
        var level = current.LogLevel ?? 0;
        if (late is { } held)
        {
            log.Add(held);
            late = null;
        }
        for (var i = 0; i < (current.LogRows ?? 3); i++)
        {
            var id = ++nextLogId;
            var message = (id, (int)(id % 4), "Message " + id.ToString(CultureInfo.InvariantCulture));
            if (i == 0 && current.LateEvery is { } every && n % every == 0) late = message;
            else log.Add(message);
        }
        if (log.Count > LogCapacity) log.RemoveRange(0, log.Count - LogCapacity);
        var filter = item.Filter;
        int[] columns = filter?.Columns is { Length: > 0 } named ? [.. named.Select(id => spec.Tables[0].Columns.FindIndex(column => column.Id == id)).Where(at => at >= 0)] : [2];
        bool Matches((long Id, int Level, string Text) row)
        {
            if (row.Level < level) return false;
            if (filter is null) return true;
            string[] texts = [row.Id.ToString(CultureInfo.InvariantCulture), row.Level.ToString(CultureInfo.InvariantCulture), row.Text];
            return columns.Any(column => texts[column].Contains(filter.Text, StringComparison.OrdinalIgnoreCase));
        }
        var predicate = level.ToString(CultureInfo.InvariantCulture) + "\u001f" + filter?.Text + "\u001f" + string.Join(",", filter?.Columns ?? []);
        var table = tables.Append(spec, 0);
        if (!table.Started || restart || table.Predicate != predicate)
        {
            var resumed = table.Started ? null : resume.FirstOrDefault(cursor => cursor.Probe == spec.Id && cursor.Table == 0);
            var (after, below, earlier) = resumed is not null ? (resumed.SettledId, null, 0) : Resolve(Matches);
            table.Start(after, below, earlier > 0 ? new LiveRow([LiveCell.Null, LiveCell.Null, LiveCell.Of(LiveStart.Note(earlier))]) : null, predicate);
        }
        var rows = log.Where(row => row.Id > table.SettledId && (table.Before is not { } end || row.Id < end) && Matches(row)).OrderBy(row => row.Id).Take(table.ReadRows)
            .Select(row => new LiveRow([LiveCell.Of(row.Id), LiveCell.Of(row.Level), LiveCell.Of(row.Text)])).ToList();
        return table.Append(rows, Environment.TickCount64);
    }

    /// <summary>Where the log starts: the id the table reads after, the id it ends before, and how many earlier rows are left out.</summary>
    private (long After, long? Below, long Earlier) Resolve(Func<(long Id, int Level, string Text), bool> matches)
    {
        if (start.Kind == "beginning") return (0, null, 0);
        long? below = start.Kind == "before" ? start.Value : null;
        var ids = log.Where(row => (below is not { } end || row.Id < end) && matches(row)).Select(row => row.Id).Order().ToList();
        var keep = (int)Math.Min(start.Kind == "tail" ? start.Value : limits.SegmentRows, ids.Count);
        var earlier = ids.Count - keep;
        return (earlier == 0 ? 0 : ids[earlier - 1], below, earlier);
    }

    /// <summary>The wide probe's rows: an id and 22 columns cycling nvarchar, bigint, datetime2, float, bit and int.</summary>
    private static List<LiveRow> Wide(long sample, int count)
    {
        var rows = new List<LiveRow>(count);
        for (var offset = 0; offset < count; offset++)
        {
            var id = offset + 1L;
            var cells = new LiveCell[23];
            cells[0] = LiveCell.Of(id);
            for (var column = 1; column < 23; column++)
                cells[column] = ((column - 1) % 6) switch
                {
                    0 => LiveCell.Of("Session " + id.ToString(CultureInfo.InvariantCulture) + " / " + column.ToString(CultureInfo.InvariantCulture)),
                    1 => LiveCell.Of(id * 1000 + sample),
                    2 => LiveCell.DateTime2(Epoch.AddSeconds(id).AddMilliseconds(sample)),
                    3 => LiveCell.Of(id * sample / 7.0),
                    4 => LiveCell.Bit((id + sample) % 2 == 0),
                    _ => LiveCell.Of((id * 31 + sample) % 1000)
                };
            rows.Add(new LiveRow(cells));
        }
        return rows;
    }

    public uint[] Keep() => tables.Keep(limits.Kept);

    /// <summary>Releases only this subscription's own tables, never anything else stored under its session name.</summary>
    public void Release() => tables.Release();

    public void Dispose() { }
}
