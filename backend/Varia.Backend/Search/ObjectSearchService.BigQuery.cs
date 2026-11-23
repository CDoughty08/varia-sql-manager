using System.Diagnostics;
using Varia.Backend.BigQuery;

namespace Varia.Backend.Search;

/// <summary>
/// explorer.index for BigQuery handles (docs/object-search.md, BigQuery): the same per-connection index, budget and search as SQL
/// Server's, with one read per dataset (Database the project, Dataset the dataset) built in two passes from free REST calls. Pass 1
/// lists every project's datasets and each dataset's tables, routines and models, so names are searchable within seconds; pass 2
/// reads each table-like object's schema and each routine's body (tables.get, routines.get) and swaps the dataset's read again. An
/// object an earlier read already detailed is reused while its creation time (and, for routines and models, its last change) is the
/// same, unless the build re-reads its scope (Object Explorer's Refresh) or DDL marked its dataset stale. Extra projects get pass 1
/// only unless ExtraDetails asks for both.
/// </summary>
internal sealed partial class ObjectSearchService
{
    /// <summary>The BigQuery kinds the index holds and the subtype variants a search's kinds may name (src/shared/explorer/search.ts).</summary>
    public static readonly string[] BigQueryKinds = ["bqDataset", "bqTable", "bqView", "bqMaterializedView", "bqExternalTable", "bqRoutine", "bqModel", "bqColumn", .. SearchQuery.Variants];

    /// <summary>Records that DDL changed a dataset (a CREATE, ALTER or DROP run from a query tab): the next build reads it whole, and a
    /// build asked for stale datasets only (Stale) reads just those. A connection with no BigQuery index keeps no mark.</summary>
    public void MarkStale(string connectionId, string project, string dataset)
    {
        if (!BqNames.IsProject(project) || !BqNames.IsDataset(dataset) || !states.TryGetValue(connectionId, out var state)) return;
        lock (state.Gate)
            if (state.BigQuery) state.Stale[(project, dataset)] = ++state.StaleMarks;
    }

    /// <summary>The editor's lookup into a BigQuery connection's index (<see cref="BigQueryLookup"/>): a snapshot of its build's state
    /// and the reads held now. A connection with no index yet still answers its projects (<paramref name="billing"/> first).</summary>
    internal BigQueryLookup LookupBigQuery(string connectionId, string billing, IReadOnlyList<string> extras)
    {
        if (!states.TryGetValue(connectionId, out var state) || !state.BigQuery) return new(billing, extras, [], null, [], false, false, budget, Changed);
        lock (state.Gate)
            return new(billing, extras, state.Index.Databases, state.NamesOnly, state.Skipped.ToList(), state.Building, state.Built, budget, Changed);
    }

    /// <summary>The dataset reads a connection's index holds (the checks read it).</summary>
    internal IReadOnlyList<DatabaseIndex> HeldOf(string connectionId)
    {
        if (!states.TryGetValue(connectionId, out var state)) return [];
        lock (state.Gate) return [.. state.Index.Databases];
    }

    /// <summary>The datasets marked stale on a connection (the checks read it).</summary>
    internal IReadOnlyCollection<(string Project, string Dataset)> StaleOf(string connectionId)
    {
        if (!states.TryGetValue(connectionId, out var state)) return [];
        lock (state.Gate) return [.. state.Stale.Keys];
    }

    public async Task<ObjectIndexResult> IndexBigQueryAsync(ObjectIndexArgs args, IBigQueryIndexSource source, CancellationToken token, Action<object>? progress = null)
    {
        var watch = Stopwatch.StartNew();
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(args.RequestId, out _)) throw Invalid("requestId.");
        var (billing, extras) = source.Projects(args.ConnectionId);
        List<string> projects = [billing, .. extras];
        var scope = args.Scope;
        var staleOnly = args.Stale == true;
        if (scope is not null && (!projects.Contains(scope.Project, StringComparer.Ordinal) || scope.Dataset is { } only && !BqNames.IsDataset(only))) throw Invalid("scope.");
        if (scope is not null && staleOnly) throw Invalid("stale.");
        var detailed = args.ExtraDetails == true ? projects.ToHashSet(StringComparer.Ordinal) : new HashSet<string>(StringComparer.Ordinal) { billing };
        var definitions = args.Definitions ?? true;
        var state = states.GetOrAdd(args.ConnectionId, _ => new State(pool, resources));
        using var source2 = CancellationTokenSource.CreateLinkedTokenSource(token);
        var entry = running.Register(args.RequestId, args.ConnectionId, source2);
        var stop = source2.Token;
        var finishedBuild = false;
        HashSet<(string Project, string Dataset)> stale;
        // A stale-only build's skips are its targets' (an earlier skip of a dataset it reads again goes); a scoped one's are the scope's.
        bool InScope(ObjectIndexSkip skip) => scope is not null ? skip.Project == scope.Project && (scope.Dataset is null || skip.Database == scope.Dataset || skip.Database == "")
            : !staleOnly || skip.Project is { } skipProject && stale.Contains((skipProject, skip.Database));
        // The mark each dataset had when this build began reading it: only that mark is cleared, so DDL that lands mid-read stays marked.
        var seen = new System.Collections.Concurrent.ConcurrentDictionary<(string, string), long>();
        lock (state.Gate)
        {
            stale = [.. state.Stale.Keys];
            try { state.Build?.Cancel(); } catch (ObjectDisposedException) { }
            state.Build = source2;
            state.Building = true;
            state.BigQuery = true;
            state.Phase = "names";
            // What the index as a whole holds is a full build's to say: a refresh re-reads part of it with whatever Options says now.
            if (scope is null && !staleOnly)
            {
                state.Definitions = definitions;
                state.NamesOnly = [.. projects.Where(project => !detailed.Contains(project))];
            }
            state.Indexed = 0;
            // A full build starts its skip list afresh; a scoped or stale-only one keeps the skips outside what it reads.
            var kept = state.Skipped.ToList().Where(skip => !InScope(skip)).ToList();
            state.Skipped = new(MaxSkipped);
            for (var at = 0; at < kept.Count; at++) state.Skipped.Add(at, kept[at]);
        }
        // Records the dataset's mark as its read begins: a marked dataset is read whole, even when marked after this build began.
        bool Seen((string, string) target)
        {
            lock (state.Gate) return (seen[target] = state.Stale.GetValueOrDefault(target)) != 0;
        }
        void Clear((string, string) target)
        {
            lock (state.Gate)
                if (state.Stale.TryGetValue(target, out var mark) && mark == seen.GetValueOrDefault(target)) state.Stale.Remove(target);
        }
        void Skip(ObjectIndexSkip skip)
        {
            lock (state.Gate) state.Skipped.Add(int.MaxValue, skip);
        }
        ObjectIndexSkip SkipOf(Exception error, string project, string dataset, string permission)
        {
            var mapped = source.Map(error, project, permission, stop);
            var (code, message) = mapped is RequestException request ? (request.Code, request.Message) : ("CATALOG_ERROR", "BigQuery refused the request.");
            code = code is "PERMISSION_DENIED" or "NOT_FOUND" or "TIMEOUT" or "AUTH_EXPIRED" or "QUOTA" or "API_DISABLED" or "BILLING_DISABLED" or "CONNECTION_LOST" ? code : "CATALOG_ERROR";
            return new(dataset, code, Explorer.ExplorerLabels.Clip(message, 512), Project: project);
        }
        try
        {
            // The datasets this build reads: a stale-only build those DDL marked; otherwise each project's listing (or the scope's dataset).
            var targets = new List<(string Project, string Dataset)>();
            if (staleOnly) targets.AddRange(stale.Where(item => projects.Contains(item.Project, StringComparer.Ordinal)).OrderBy(item => item.Project, StringComparer.Ordinal).ThenBy(item => item.Dataset, StringComparer.Ordinal));
            else
                foreach (var project in scope is null ? projects : [scope.Project])
                {
                    BigQueryDatasetList list;
                    try { list = await source.DatasetsAsync(args.ConnectionId, project, stop); }
                    catch (Exception error) when (!stop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                    {
                        // The project's earlier reads stay; the status names the project.
                        Skip(SkipOf(error, project, "", "bigquery.datasets.get"));
                        continue;
                    }
                    if (list.Cut) Skip(new("", "TOO_LARGE", "The project has more datasets than the index lists; it keeps the first " + (BigQueryIndexLimits.ListPages * 1000).ToString("N0", System.Globalization.CultureInfo.InvariantCulture) + ".", Project: project));
                    var listed = scope?.Dataset is { } scoped ? list.Datasets.Where(name => name == scoped).ToList() : list.Datasets;
                    var names = listed.ToHashSet(StringComparer.Ordinal);
                    // Datasets the listing no longer names are dropped (only the scope's, for a dataset refresh; never on a cut listing).
                    state.Index.KeepWhere(read => read.Database != project || read.Dataset is not { } dataset || names.Contains(dataset) || list.Cut
                        || scope?.Dataset is { } kept && kept != dataset);
                    targets.AddRange(listed.Select(name => (project, name)));
                }
            lock (state.Gate) state.Databases = targets.Count;
            // Pass 2's datasets: their objects as listed, the ones to read (by position), and whether the listing was cut. Details reused
            // from an earlier read are found again in the read pass 1 held, so pass 1 keeps no expanded copies of them outside the budget.
            var pending = new System.Collections.Concurrent.ConcurrentDictionary<(string, string), (List<BigQueryEntry> Listed, int[] Read, bool Cut)>();
            var progressed = Stopwatch.StartNew();
            var reported = TimeSpan.MinValue;
            var progressGate = new object();
            void Report(int done, int total, string phase, bool last)
            {
                if (progress is null) return;
                lock (progressGate)
                {
                    if (!last && progressed.Elapsed - reported < ProgressEvery) return;
                    reported = progressed.Elapsed;
                    progress(new { Type = "explorer.index.progress", Done = done, Total = total, Objects = state.Index.Objects, Phase = phase });
                }
            }
            Report(0, targets.Count, "names", true);
            var listedDone = 0;
            await Parallel.ForEachAsync(targets, new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = stop }, async (target, loop) =>
            {
                var (project, dataset) = target;
                var marked = Seen(target);
                BigQueryListing listing;
                try { listing = await source.ObjectsAsync(args.ConnectionId, project, dataset, loop); }
                catch (Exception error) when (!loop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                {
                    var skip = SkipOf(error, project, dataset, "bigquery.tables.list");
                    // A dataset that is gone (dropped since the listing, or by the DDL that marked it) leaves the index without a skip.
                    if (skip.Code == "NOT_FOUND") Forget(state, project, dataset);
                    else Skip(skip);
                    Report(Interlocked.Increment(ref listedDone), targets.Count, "names", false);
                    return;
                }
                var key = project + "\u0001" + dataset;
                var force = scope is not null || marked || stale.Contains(target);
                var known = force ? [] : BigQueryEntries.Known(state.Index.Get(key), definitions);
                var listed = BigQueryEntries.FromListing(listing);
                var entries = listed.Select(item => BigQueryEntries.Reuse(known, item)).ToList();
                known.Clear();
                // A superseded build writes nothing more: the newer one has reset the counters and skips.
                loop.ThrowIfCancellationRequested();
                var held = Hold(state, project, dataset, entries, definitions);
                if (held is { Code: not ChildrenLeftOut }) Skip(held);
                else
                {
                    lock (state.Gate) state.Indexed++;
                    if (held is not null) Skip(held);
                    if (listing.Cut) Skip(new(dataset, "TOO_LARGE", "The dataset has more objects than the index lists; it keeps the first ones.", Project: project));
                    // A read that fit only without columns reads no details: they would not fit either, and its reused ones are gone.
                    int[] read = detailed.Contains(project) && held is null
                        ? [.. Enumerable.Range(0, entries.Count).Where(at => entries[at].Detail is null && BigQueryEntries.HasDetails(entries[at]))] : [];
                    if (read.Length > 0) pending[target] = (listed, read, listing.Cut);
                    else if (!listing.Cut) Clear(target);
                }
                Report(Interlocked.Increment(ref listedDone), targets.Count, "names", false);
            });
            Report(listedDone, targets.Count, "names", true);
            // Pass 2: each pending dataset's objects without details, then the dataset's read swapped in again.
            lock (state.Gate) state.Phase = "details";
            var wanted = pending.Sum(pair => pair.Value.Read.Length);
            var detailsDone = 0;
            Report(0, wanted, "details", true);
            using var slots = new SemaphoreSlim(BigQueryIndexLimits.Details);
            await Parallel.ForEachAsync(pending.OrderBy(pair => pair.Key.Item1, StringComparer.Ordinal).ThenBy(pair => pair.Key.Item2, StringComparer.Ordinal),
                new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = stop }, async (pair, loop) =>
            {
                var (project, dataset) = pair.Key;
                var reused = BigQueryEntries.Known(state.Index.Get(project + "\u0001" + dataset), definitions);
                var entries = pair.Value.Listed.Select(item => BigQueryEntries.Reuse(reused, item)).ToArray();
                reused.Clear();
                ObjectIndexSkip? failed = null;
                var failures = 0;
                var tasks = new List<Task>();
                // Only what pass 1 counted: an object whose reused details pass 1 could not keep stays as it was held.
                foreach (var at in pair.Value.Read)
                {
                    var item = entries[at];
                    var index = at;
                    tasks.Add(Task.Run(async () =>
                    {
                        await slots.WaitAsync(loop);
                        try
                        {
                            var detail = item.Kind == "bqRoutine"
                                ? BigQueryEntries.FromRoutine(await source.RoutineAsync(args.ConnectionId, project, dataset, item.Name, loop))
                                : BigQueryEntries.FromTable(await source.TableAsync(args.ConnectionId, project, dataset, item.Name, loop));
                            entries[index] = item with { Detail = detail };
                        }
                        catch (Exception error) when (!loop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                        {
                            // An object dropped since the listing keeps its name; any other failure is counted for the dataset's skip.
                            var skip = SkipOf(error, project, dataset, item.Kind == "bqRoutine" ? "bigquery.routines.get" : "bigquery.tables.get");
                            if (skip.Code != "NOT_FOUND")
                            {
                                Interlocked.Increment(ref failures);
                                Interlocked.CompareExchange(ref failed, skip, null);
                            }
                        }
                        finally
                        {
                            slots.Release();
                            Report(Interlocked.Increment(ref detailsDone), wanted, "details", false);
                        }
                    }, loop));
                }
                await Task.WhenAll(tasks);
                loop.ThrowIfCancellationRequested();
                var held = Hold(state, project, dataset, entries, definitions);
                if (held is not null) Skip(held);
                if (failed is { } first)
                    Skip(first with { Details = true, Message = failures == 1 ? "The details of 1 object could not be read: " + first.Message : "The details of " + failures.ToString(System.Globalization.CultureInfo.InvariantCulture) + " objects could not be read: " + first.Message });
                else if (held is null or { Code: ChildrenLeftOut } && !pair.Value.Cut) Clear(pair.Key);
            });
            Report(detailsDone, wanted, "details", true);
            lock (state.Gate)
            {
                if (ReferenceEquals(state.Build, source2)) { state.Building = false; state.Built = true; state.BuiltAt = DateTime.UtcNow; state.Phase = null; }
            }
            Finish(build: true, watch.ElapsedMilliseconds);
            finishedBuild = true;
            return new(Status(state), watch.ElapsedMilliseconds);
        }
        catch (OperationCanceledException)
        {
            throw new RequestException("CANCELLED", "The object index build was stopped.");
        }
        finally
        {
            lock (state.Gate)
                if (ReferenceEquals(state.Build, source2)) { state.Build = null; state.Building = false; state.Phase = null; }
            if (!finishedBuild) Ended();
            running.Unregister(args.RequestId, entry);
        }
    }

    /// <summary>Builds and holds a dataset's read; a read past the budget is tried again without columns (CHILDREN_LEFT_OUT), then skipped as TOO_LARGE.</summary>
    private ObjectIndexSkip? Hold(State state, string project, string dataset, IReadOnlyList<BigQueryEntry> entries, bool definitions)
    {
        var old = state.Index.Get(project + "\u0001" + dataset);
        if (new BigQueryReader(Limits, pool, old).Read(project, dataset, entries, true, definitions) is { } read) { state.Index.Put(read); return null; }
        if (new BigQueryReader(Limits, pool, old).Read(project, dataset, entries, false, definitions) is { } names)
        {
            state.Index.Put(names);
            return new(dataset, ChildrenLeftOut, "The dataset's columns were left out: with them the index would pass its " + Size + " memory limit.", Project: project);
        }
        return new(dataset, "TOO_LARGE", "The dataset was not indexed: it would take the index past its " + Size + " memory limit.", Project: project);
    }

    private static void Forget(State state, string project, string dataset)
    {
        state.Index.KeepWhere(read => !(read.Database == project && read.Dataset == dataset));
        lock (state.Gate) state.Stale.Remove((project, dataset));
    }
}
