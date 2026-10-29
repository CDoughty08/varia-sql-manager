namespace Varia.Backend.Live;

/// <summary>One sample's raw row: the server clock (ms_ticks and the start time in ticks, null when the probe cannot read
/// them) and each series' raw value and base, aligned with the catalogue's series.</summary>
internal sealed record LiveRawSample(long? MsTicks, long? StartTicks, double?[] Values, double?[] Bases);

/// <summary>What a sample carries: each series' value (null where there is none yet), the interval it covers (the server's
/// own when it has ms_ticks, else the backend's, null for a first sample) and its gap marker.</summary>
internal sealed record LiveDeltaResult(double?[] Values, long? ElapsedMs, string? Gap);

/// <summary>The backend keeps baselines only (docs/live.md): the previous raw values of one probe, from which it sends
/// rates; the renderer keeps the history. Rates use the server's clock (Δms_ticks) when the probe reads it, so a slow round
/// trip never skews them, and the backend's clock otherwise. A restart (the start time moved) drops every baseline (gap
/// reset); a counter that went down (DBCC SQLPERF cleared it, a database came back) rebaselines alone (null, gap reset); the
/// first sample, the first after a pause and the first after a broken connection have no rates (baseline, resumed).</summary>
internal sealed class LiveDeltas(IReadOnlyList<string> counters)
{
    private double?[]? previous;
    private double?[]? previousBases;
    private long? msTicks, startTicks;

    /// <summary>The next sample is a baseline: after a broken connection, which may have reached another server.</summary>
    public void Reset() => previous = null;

    /// <param name="clientElapsedMs">The backend's own measure of the interval, used when the probe has no ms_ticks.</param>
    /// <param name="dueGap">The scheduler's marker: baseline (first sample), resumed (after a pause), late (missed slots).</param>
    public LiveDeltaResult Apply(LiveRawSample raw, long? clientElapsedMs, int effectiveIntervalMs, string? dueGap)
    {
        if (raw.Values.Length != counters.Count || raw.Bases.Length != counters.Count) throw new ArgumentException("A raw sample has one value and base per series.", nameof(raw));
        string? gap = dueGap is "baseline" or "resumed" ? dueGap : previous is null ? "baseline" : null;
        if (gap is null && raw.StartTicks is { } start && startTicks is { } before && start != before) gap = "reset";
        var restart = gap is not null;
        long? elapsed = restart ? null : raw.MsTicks is { } now && msTicks is { } then ? now - then : clientElapsedMs;
        var values = new double?[counters.Count];
        for (var i = 0; i < counters.Count; i++)
        {
            var value = raw.Values[i];
            if (counters[i] == "gauge") { values[i] = value; continue; }
            if (restart || value is not { } v || previous![i] is not { } p) continue;
            var delta = v - p;
            if (delta < 0)
            {
                // This counter alone starts again; the others keep their rates.
                gap ??= "reset";
                continue;
            }
            values[i] = counters[i] switch
            {
                "rate" or "msPerSecond" => elapsed is > 0 ? delta * 1000.0 / elapsed.Value : null,
                "ratio" => Ratio(delta, raw.Bases[i], previousBases![i], ref gap),
                "cpuPercent" => elapsed is > 0 && raw.Bases[i] is > 0 ? Math.Clamp(100.0 * delta / (elapsed.Value * raw.Bases[i]!.Value), 0, 100) : null,
                _ => throw new InvalidOperationException("Unknown counter kind.")
            };
        }
        previous = raw.Values;
        previousBases = raw.Bases;
        msTicks = raw.MsTicks;
        startTicks = raw.StartTicks;
        // A sample far later than its interval is still a rate, marked so charts do not join it to the one before.
        gap ??= dueGap ?? (elapsed > 3L * effectiveIntervalMs ? "late" : null);
        return new(values, elapsed is >= 0 ? elapsed : null, gap);
    }

    private static double? Ratio(double delta, double? baseValue, double? previousBase, ref string? gap)
    {
        if (baseValue is not { } b || previousBase is not { } p) return null;
        var change = b - p;
        if (change < 0) { gap ??= "reset"; return null; }
        return change == 0 ? null : delta / change;
    }
}

/// <summary>Per-row rates of a snapshot probe (per-request CPU, per-file bytes per second): baselines per key, where the key
/// holds an identity column (a request's start time, a file's database and file ids), so a reused id never yields a delta
/// across two rows. Each baseline keeps the time it was read at, on the probe's own sample clock, so a row missing from a
/// sample (cut by a TOP, or its statement failed) gets a rate over its own span when it comes back, never two intervals over
/// one. At most <paramref name="capacity"/> keys (the probe's row cap); a key absent from two samples in a row is dropped.</summary>
internal sealed class LiveKeyedDeltas(int capacity)
{
    private sealed class Baseline(double[] values, long at) { public double[] Values = values; public long At = at; public int Absent; }
    private readonly Dictionary<string, Baseline> baselines = new(StringComparer.Ordinal);
    private readonly HashSet<string> seen = new(StringComparer.Ordinal);

    public int Count => baselines.Count;

    /// <summary>Each value's change per second since this key's previous sample: null for a new key, a counter that went
    /// down, or no time between the two.</summary>
    /// <param name="at">This sample's time in milliseconds on the probe's sample clock.</param>
    public double?[] Apply(string key, double[] values, long at)
    {
        var rates = new double?[values.Length];
        seen.Add(key);
        if (baselines.TryGetValue(key, out var baseline) && baseline.Values.Length == values.Length)
        {
            var elapsed = at - baseline.At;
            for (var i = 0; i < values.Length; i++)
            {
                var delta = values[i] - baseline.Values[i];
                rates[i] = delta >= 0 && elapsed > 0 ? delta * 1000.0 / elapsed : null;
            }
            (baseline.Values, baseline.At, baseline.Absent) = (values, at, 0);
        }
        else if (baseline is not null) (baseline.Values, baseline.At, baseline.Absent) = (values, at, 0);
        else if (baselines.Count < capacity) baselines[key] = new(values, at);
        return rates;
    }

    /// <summary>Ends a sample: keys it did not see age, and go after two.</summary>
    public void EndSample()
    {
        foreach (var (key, baseline) in baselines.ToList())
            if (!seen.Contains(key) && ++baseline.Absent >= 2) baselines.Remove(key);
        seen.Clear();
    }

    /// <summary>After a pause or a restart every key starts again.</summary>
    public void Clear()
    {
        baselines.Clear();
        seen.Clear();
    }
}
