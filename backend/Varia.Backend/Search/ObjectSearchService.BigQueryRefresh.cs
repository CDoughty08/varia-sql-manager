using Google.Apis.Bigquery.v2.Data;

namespace Varia.Backend.Search;

/// <summary>What BigQuery's object refresh did (the checks read it): datasets rewritten because an object's details changed when
/// they were read anyway (Properties, the details pane), the background re-read's gets, and the datasets it rewrote.</summary>
internal readonly record struct BigQueryRefreshCounts(long Refreshed, long SweepGets, long SweepRewrites);

/// <summary>
/// BigQuery's in-place changes (ALTER TABLE, a view's text patched) keep an object's creation time, so a listing never sees them
/// (docs/object-search.md, Freshness). Two things catch them: an object's details read anyway (bigquery.properties) replace what the
/// index holds of it, and a slow background re-read gets each held object's details again, oldest dataset first, at most one call
/// at a time <see cref="SweepPace"/> apart under the principal's limiter, paused while any build or check of the connection runs, and
/// stopped when the connection closes.
/// </summary>
internal sealed partial class ObjectSearchService
{
    /// <summary>How old a dataset's details may get before the background re-read gets them again.</summary>
    internal TimeSpan SweepAfter { get; set; } = TimeSpan.FromHours(4);
    /// <summary>The least time between two of the background re-read's calls (so at most this many an hour: 1,800).</summary>
    internal TimeSpan SweepPace { get; set; } = TimeSpan.FromSeconds(2);
    /// <summary>The longest the background re-read waits before it looks again, when nothing is due.</summary>
    internal TimeSpan SweepIdle { get; set; } = TimeSpan.FromMinutes(10);
    /// <summary>The most objects one pass over a dataset gets; the rest wait for its next pass.</summary>
    internal const int SweepObjects = 1000;
    /// <summary>A pass over a dataset gives up after this many failed gets in a row (and tries the dataset again later).</summary>
    internal const int SweepFailures = 3;

    private long objectsRefreshed, sweepGets, sweepRewrites;
    private int sweeps;
    /// <summary>The background re-reads running (the checks wait for a closed connection's to end).</summary>
    internal int Sweeps => Volatile.Read(ref sweeps);
    internal BigQueryRefreshCounts BigQueryRefreshes => new(Interlocked.Read(ref objectsRefreshed), Interlocked.Read(ref sweepGets), Interlocked.Read(ref sweepRewrites));

    /// <summary>A check's hook: called before each background get (project, dataset, object).</summary>
    internal Func<string, string, string, Task>? SweepGetting { get; set; }

    private sealed partial class State
    {
        /// <summary>The background re-read of a BigQuery connection, while it runs (under Gate).</summary>
        public CancellationTokenSource? Sweep;
        /// <summary>When each held dataset's details were last read whole (UTC ticks, under Gate): a re-list that reused them did not.</summary>
        public readonly Dictionary<string, long> DetailsAt = new(StringComparer.Ordinal);
    }

    /// <summary>A table-like object's details read by bigquery.properties: what the index holds of it is replaced when they differ.</summary>
    public void TableRead(string connectionId, string project, string dataset, string name, Table table) =>
        ObjectRead(connectionId, project, dataset, name, BigQueryEntries.TableKind(table.Type)?.Kind, BigQueryEntries.FromTable(table));

    /// <summary>A routine's details read by bigquery.properties.</summary>
    public void RoutineRead(string connectionId, string project, string dataset, string name, Routine routine) =>
        ObjectRead(connectionId, project, dataset, name, "bqRoutine", BigQueryEntries.FromRoutine(routine));

    private void ObjectRead(string connectionId, string project, string dataset, string name, string? kind, BigQueryDetail detail)
    {
        if (kind is null || !states.TryGetValue(connectionId, out var state)) return;
        if (Apply(state, project, dataset, new Dictionary<(string, string), BigQueryDetail> { [(kind, name)] = detail })) Interlocked.Increment(ref objectsRefreshed);
    }

    /// <summary>A held dataset read's entries as pass 1 would list them, each with the details the read holds (carried as they were
    /// when not whole), so a read built from them again holds the same.</summary>
    internal static List<BigQueryEntry> EntriesOf(DatabaseIndex read, bool definitions)
    {
        var entries = new List<BigQueryEntry>();
        if (read.Facts is not { } facts) return entries;
        var known = BigQueryEntries.Known(read, definitions, carry: true);
        var table = read.Table;
        for (var at = 0; at < table.Count; at++)
        {
            if (table.Parent(at) >= 0 || table.Kind(at) == "bqDataset" || facts.Of(at) is not { } fact) continue;
            var kind = table.Kind(at);
            var shards = facts.Shards(at);
            // A clone's subtype is its details'; the listing names it a table.
            var subtype = table.Subtype(at) == "clone" ? null : table.Subtype(at);
            var detail = known.TryGetValue(BigQueryEntries.Key(kind, table.Name(at), shards), out var had) ? had.Detail : null;
            entries.Add(new(kind, table.Folder(at), subtype, table.Name(at), fact.Created, fact.Listed, shards, detail));
        }
        return entries;
    }

    /// <summary>Whether two details say the same of an object, leaving out its size and last change, which move with its data.</summary>
    internal static bool SameDetails(BigQueryDetail had, BigQueryDetail now, bool definitions) =>
        had.Subtype == now.Subtype && (!definitions || had.Definition == now.Definition) && had.Partitioning == now.Partitioning && had.Clustering == now.Clustering
        && had.Signature == now.Signature && had.ColumnsCut == now.ColumnsCut && had.Columns.SequenceEqual(now.Columns);

    /// <summary>
    /// Replaces what a held dataset read holds of the objects in <paramref name="fresh"/> (by kind and name) where it differs, and
    /// holds the read again, which saves it in place with the sync state it had. Nothing changes while a build or check of the
    /// connection runs (it reads them itself), for a dataset DDL marked stale (whose read whole is coming), for one loaded and not yet
    /// listed, or when the new read does not fit. True when it was replaced.
    /// </summary>
    private bool Apply(State state, string project, string dataset, IReadOnlyDictionary<(string Kind, string Name), BigQueryDetail> fresh)
    {
        var key = project + "\u0001" + dataset;
        DatabaseIndex? held;
        bool definitions, discovered;
        lock (state.Gate)
        {
            if (!state.BigQuery || state.Building || state.Saved.ContainsKey(key) || state.Stale.ContainsKey((project, dataset)) || state.StaleProjects.ContainsKey(project)) return false;
            held = state.Index.Get(key);
            definitions = state.Definitions;
            discovered = state.DiscoveredProjects.Contains(project);
        }
        if (held is not { ChildrenLeftOut: false, Facts: not null }) return false;
        var entries = EntriesOf(held, definitions);
        var changed = false;
        for (var at = 0; at < entries.Count; at++)
        {
            var entry = entries[at];
            if (!fresh.TryGetValue((entry.Kind, entry.Name), out var detail)) continue;
            if (entry.Detail is { Carried: false, Stale: false } had && SameDetails(had, detail, definitions)) continue;
            // A routine's listing carries its last change: the next listing compares it with this.
            entries[at] = entry with { Detail = detail, Modified = entry.Kind is "bqRoutine" ? detail.Modified ?? entry.Modified : entry.Modified };
            changed = true;
        }
        if (!changed) return false;
        var built = new BigQueryReader(Limits, pool, held, Limits.BigQueryNamesFloorBytes, Limits.BigQueryDetailsFloor(discovered, held.Detailed)).Read(project, dataset, entries, true, definitions);
        if (built is null) return false;
        lock (state.Gate)
        {
            if (!state.Building && ReferenceEquals(state.Index.Get(key), held) && !state.Stale.ContainsKey((project, dataset)) && !state.StaleProjects.ContainsKey(project))
            {
                built.Sync = held.Sync;
                built.StaleSeen = held.StaleSeen;
                state.Index.Put(built);
                return true;
            }
        }
        state.Index.Abandon(built);
        return false;
    }

    /// <summary>Starts a BigQuery connection's background re-read once, after a full build ran its course.</summary>
    private void StartSweep(string connectionId, State state, IBigQueryIndexSource source)
    {
        CancellationTokenSource sweep;
        lock (state.Gate)
        {
            if (state.Sweep is not null) return;
            state.Sweep = sweep = new CancellationTokenSource();
        }
        _ = Task.Run(() => SweepAsync(connectionId, state, source, sweep.Token));
    }

    /// <summary>Stops a connection's background re-read (its connection closed, or the backend stops).</summary>
    private static void StopSweep(State state)
    {
        CancellationTokenSource? sweep;
        lock (state.Gate) { sweep = state.Sweep; state.Sweep = null; }
        if (sweep is null) return;
        try { sweep.Cancel(); } catch (ObjectDisposedException) { }
        sweep.Dispose();
    }

    /// <summary>The background re-read (see the class): until the connection closes, picks the held dataset whose details are
    /// oldest, and when they are older than <see cref="SweepAfter"/> gets its objects' details again one at a time, then holds what
    /// changed (<see cref="Apply"/>). A dataset is dropped from a pass when a build or check starts, and tried again after it.</summary>
    private async Task SweepAsync(string connectionId, State state, IBigQueryIndexSource source, CancellationToken stop)
    {
        Interlocked.Increment(ref sweeps);
        try
        {
            while (!stop.IsCancellationRequested)
            {
                var (key, wait) = NextSweep(state);
                if (key is null)
                {
                    await Task.Delay(wait, stop);
                    continue;
                }
                await SweepDatasetAsync(connectionId, state, source, key, stop);
                await Task.Delay(SweepPace, stop);
            }
        }
        catch (OperationCanceledException) when (stop.IsCancellationRequested) { }
        catch (RequestException error) when (error.Code == "NOT_CONNECTED") { }
        finally { Interlocked.Decrement(ref sweeps); }
    }

    /// <summary>The held dataset whose details are oldest when it is due, else how long to wait before looking again.</summary>
    private (string? Key, TimeSpan Wait) NextSweep(State state)
    {
        var now = UtcNow().Ticks;
        lock (state.Gate)
        {
            if (state.Building) return (null, SweepPace);
            string? oldest = null;
            long oldestAt = long.MaxValue;
            foreach (var read in state.Index.Databases)
            {
                if (read is not { Dataset: not null, Detailed: true, ChildrenLeftOut: false } || state.Saved.ContainsKey(read.Key)) continue;
                // A dataset first seen here was read (details and all) no earlier than its read: its clock starts then.
                if (!state.DetailsAt.TryGetValue(read.Key, out var at)) state.DetailsAt[read.Key] = at = Utc(read.ReadAt).Ticks;
                if (at < oldestAt) (oldest, oldestAt) = (read.Key, at);
            }
            if (oldest is null) return (null, SweepIdle);
            var due = oldestAt + SweepAfter.Ticks - now;
            return due <= 0 ? (oldest, TimeSpan.Zero) : (null, TimeSpan.FromTicks(Math.Min(due, SweepIdle.Ticks)));
        }
    }

    private async Task SweepDatasetAsync(string connectionId, State state, IBigQueryIndexSource source, string key, CancellationToken stop)
    {
        var cut = key.IndexOf('\u0001', StringComparison.Ordinal);
        var (project, dataset) = (key[..cut], key[(cut + 1)..]);
        DatabaseIndex? held;
        bool definitions;
        lock (state.Gate) { held = state.Index.Get(key); definitions = state.Definitions; }
        if (held is null) return;
        var objects = EntriesOf(held, definitions).Where(entry => BigQueryEntries.HasDetails(entry) && entry.Detail is not null).Take(SweepObjects).ToList();
        var fresh = new Dictionary<(string, string), BigQueryDetail>();
        var failures = 0;
        var complete = true;
        foreach (var entry in objects)
        {
            lock (state.Gate)
                if (state.Building || !ReferenceEquals(state.Index.Get(key), held)) { complete = false; break; }
            if (SweepGetting is { } hook) await hook(project, dataset, entry.Name);
            try
            {
                Interlocked.Increment(ref sweepGets);
                fresh[(entry.Kind, entry.Name)] = entry.Kind == "bqRoutine"
                    ? BigQueryEntries.FromRoutine(await source.RoutineAsync(connectionId, project, dataset, entry.Name, stop))
                    : BigQueryEntries.FromTable(await source.TableAsync(connectionId, project, dataset, entry.Name, stop));
                failures = 0;
            }
            catch (Exception error) when (!stop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
            {
                // An object gone (dropped meanwhile) means the listing is out of date: the dataset is due, and its next search re-lists it.
                if (source.Map(error, project, null, stop) is RequestException { Code: "NOT_FOUND" })
                    lock (state.Gate) if (!state.Due.ContainsKey(key)) state.Due[key] = ++state.StaleMarks;
                if (++failures >= SweepFailures) break;
            }
            await Task.Delay(SweepPace, stop);
        }
        if (fresh.Count > 0 && Apply(state, project, dataset, fresh)) Interlocked.Increment(ref sweepRewrites);
        // A pass cut short by a build is tried again after it; one that failed waits for its next turn, like a whole one.
        if (complete) lock (state.Gate) state.DetailsAt[key] = UtcNow().Ticks;
    }
}
