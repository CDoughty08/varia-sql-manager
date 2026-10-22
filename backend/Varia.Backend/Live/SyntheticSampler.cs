using System.Globalization;
using Varia.Backend.Results;

namespace Varia.Backend.Live;

/// <summary>debug.synthetic (VARIA_BACKEND_TEST_HOOKS=1 only): generated values that exercise the live protocol without
/// SQL Server. Its metrics probe counts samples and draws a wave; its table probe stores a snapshot result per sample,
/// whose rows move on by one id each time (two revisions alive, the one before them retired), sorted as asked, with diff
/// counts and tracked rows; its status probe reports the phase and sample count. Args set the row count, a sampling
/// period below the 1 s minimum (tickMs), a sample count after which the source ends, and an error value every n-th sample.
/// Each revision has its own budget, and the oldest is released before the next is stored (the renderer has applied the
/// newest by then), so a revision that did not fit (BUDGET) never stops later ones once memory is free again.</summary>
internal sealed class SyntheticSampler : ILiveSampler
{
    public const string Source = "debug.synthetic";
    public const string MetricsProbe = "debug.synthetic.metrics";
    public const string TableProbe = "debug.synthetic.table";
    public const string StatusProbe = "debug.synthetic.status";
    private readonly ResultStore store;
    private readonly string session;
    private readonly List<ResultSetBuffer> revisions = [];
    /// <summary>Released before a revision that then did not fit: the next stored revision reports it as retired.</summary>
    private readonly List<uint> retiring = [];
    private readonly Lock gate = new();
    private SyntheticLiveArgs args;
    private Dictionary<long, long> previous = [];
    private long metricSamples, tableSamples, statusSamples, ticks, revision;

    public SyntheticSampler(ResultStore store, string subscriptionId, SyntheticLiveArgs args)
    {
        this.store = store;
        // Only a name for the store's bookkeeping: nothing is stored or released until the subscription samples.
        session = "live:" + subscriptionId;
        this.args = args;
    }

    /// <summary>Checks args as main's schema does (src/shared/live/schema.ts, liveArgsSchemas).</summary>
    public static SyntheticLiveArgs Check(SyntheticLiveArgs args)
    {
        if (args.Rows is < 0 or > 10_000 || args.TickMs is < 10 or > 60_000 || args.EndAfterTicks is < 1 or > 10_000 || args.ErrorEvery is < 1 or > 1000)
            throw new RequestException("INVALID_PARAMS", "Invalid arguments for this source.");
        return args;
    }

    public int? PeriodMs { get { lock (gate) return args.TickMs; } }

    public bool Ended { get { lock (gate) return args.EndAfterTicks is { } end && ticks >= end; } }

    public void Apply(object value)
    {
        var next = (SyntheticLiveArgs)value;
        // An update replaces only the members it names.
        lock (gate) args = new(next.Rows ?? args.Rows, next.TickMs ?? args.TickMs, next.EndAfterTicks ?? args.EndAfterTicks, next.ErrorEvery ?? args.ErrorEvery);
    }

    public Task<LiveOpening> OpenAsync(IReadOnlyList<LiveProbeState> probes, IReadOnlyList<LiveCursor> resume, CancellationToken token) =>
        Task.FromResult(new LiveOpening([.. probes.Select(probe => new LiveOpenedProbe(probe.Spec.Id, probe.IntervalMs, probe.Spec.IntervalMs.Min, probe.Spec.IntervalMs.Max, "ok"))]));

    public Task<LiveSampleBatch> SampleAsync(IReadOnlyList<LiveDue> due, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        SyntheticLiveArgs current;
        lock (gate) { current = args; ticks++; }
        var samples = new List<LiveSample>();
        var errors = new List<LiveProbeError>();
        foreach (var item in due)
        {
            var probe = item.Probe;
            LiveSample Sample(double?[]? metrics = null, IReadOnlyList<LiveSnapshotSample>? tables = null, IReadOnlyList<LiveStatus>? status = null) =>
                new(probe.Spec.Id, 0, probe.IntervalMs, item.ElapsedMs, item.Gap, item.Skipped, metrics, tables, null, status);
            switch (probe.Spec.Id)
            {
                case MetricsProbe:
                    var n = ++metricSamples;
                    var wave = 50 + 50 * Math.Sin(n / 4.0);
                    // A rate has no value until a second sample, as a cumulative counter's would.
                    samples.Add(Sample(metrics: [n, wave, item.ElapsedMs is null || item.Gap is "resumed" ? null : wave * 1000.0 / Math.Max(1, item.ElapsedMs.Value)]));
                    break;
                case TableProbe:
                    var sample = ++tableSamples;
                    if (current.ErrorEvery is { } every && sample % every == 0)
                    {
                        errors.Add(new LiveProbeError(probe.Spec.Id, "SQL_ERROR", "The synthetic source failed this sample, as the test asked.", null, probe.IntervalMs, false));
                        break;
                    }
                    if (Table(item, sample, current.Rows ?? 3) is { } table) samples.Add(Sample(tables: [table]));
                    else errors.Add(new LiveProbeError(probe.Spec.Id, "BUDGET", "The result memory budget is full. Close some results, and the view continues.", null, probe.IntervalMs, false));
                    break;
                case StatusProbe:
                    var count = ++statusSamples;
                    samples.Add(Sample(status: [new LiveStatus("phase", count % 2 == 0 ? "even" : "odd"), new LiveStatus("samples", count)]));
                    break;
            }
        }
        return Task.FromResult(new LiveSampleBatch(samples, errors));
    }

    /// <summary>One revision: ids sample … sample + rows − 1, each with a value that changes every sample.</summary>
    private LiveSnapshotSample? Table(LiveDue item, long sample, int count)
    {
        var probe = item.Probe;
        var rows = Enumerable.Range(0, count).Select(offset => (Id: sample + offset, Label: "Row " + (sample + offset).ToString(CultureInfo.InvariantCulture), Value: (sample + offset) * 37 % 100 + sample % 7)).ToList();
        if (item.Sort is { } sort)
        {
            IOrderedEnumerable<(long Id, string Label, long Value)>? ordered = null;
            foreach (var key in sort)
            {
                Func<(long Id, string Label, long Value), IComparable> select = key.Column switch { "label" => row => row.Label, "value" => row => row.Value, _ => row => row.Id };
                ordered = ordered is null ? key.Descending ? rows.OrderByDescending(select) : rows.OrderBy(select)
                    : key.Descending ? ordered.ThenByDescending(select) : ordered.ThenBy(select);
            }
            // The key breaks ties, so equal values never change places between revisions.
            rows = [.. ordered!.ThenBy(row => row.Id)];
        }
        var spec = probe.Spec.Tables[0];
        lock (gate)
        {
            // Two revisions stay readable: the renderer shows the newest it applied, or, until it applies this one, the one
            // before. The oldest is released first, so its memory is free for this one.
            if (revisions.Count >= 2)
            {
                retiring.Add(revisions[0].ResultId);
                store.Release(revisions[0].ResultId);
                revisions.RemoveAt(0);
            }
        }
        var set = store.Open(new QueryBudget(session), 0, 1, 1, "rows", [.. spec.Columns.Select(column => new ResultColumn(column.Name, column.DataType, "text", Nullable: false))], [WireKind.Text, WireKind.Text, WireKind.Text]);
        if (set is null) return null;
        lock (gate) revisions.Add(set);
        foreach (var row in rows)
        {
            set.CountRow();
            if (set.BeginRow() is not { } builder) continue;
            builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), row.Id));
            builder.AppendText(row.Label);
            builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), row.Value));
            set.TryCommitRow();
        }
        set.Complete();
        uint[]? retired = null;
        lock (gate)
        {
            if (retiring.Count > 0) retired = [.. retiring];
            retiring.Clear();
            revision++;
        }
        var current = rows.ToDictionary(row => row.Id, row => row.Value);
        var diff = new LiveDiff(current.Keys.Count(id => !previous.ContainsKey(id)), previous.Keys.Count(id => !current.ContainsKey(id)),
            current.Count(row => previous.TryGetValue(row.Key, out var before) && before != row.Value));
        previous = current;
        var positions = rows.Select((row, index) => (Key: row.Id.ToString(CultureInfo.InvariantCulture), index)).ToDictionary(item => item.Key, item => item.index, StringComparer.Ordinal);
        var tracked = item.Tracks.TryGetValue(0, out var track) ? new LiveTracked(track.Seq, [.. track.Keys.Select(key => positions.TryGetValue(key, out var at) ? at : -1)]) : null;
        return new LiveSnapshotSample(0, set.Describe(), revision, retired, diff, tracked);
    }

    public uint[] Keep()
    {
        lock (gate)
        {
            if (revisions.Count == 0) return [];
            var newest = revisions[^1];
            foreach (var older in revisions.Take(revisions.Count - 1)) store.Release(older.ResultId);
            revisions.RemoveRange(0, revisions.Count - 1);
            return [newest.ResultId];
        }
    }

    /// <summary>Releases only this subscription's own revisions, never anything else stored under its session name.</summary>
    public void Release()
    {
        uint[] ids;
        lock (gate)
        {
            ids = [.. revisions.Select(set => set.ResultId)];
            revisions.Clear();
        }
        store.Release(ids);
    }

    public void Dispose() { }
}
