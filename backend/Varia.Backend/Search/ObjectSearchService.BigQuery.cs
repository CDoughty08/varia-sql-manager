using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Threading.Channels;
using Varia.Backend.BigQuery;

namespace Varia.Backend.Search;

/// <summary>
/// explorer.index for BigQuery handles (docs/object-search.md, BigQuery): the same per-connection index, budget and search as SQL
/// Server's, with one read per dataset (Database the project, Dataset the dataset) built from free REST calls in three prioritized
/// waves. Wave 1 lists and details the billing project whole so IntelliSense and Search Objects are ready immediately; wave 2
/// discovers accessible projects (unless AllProjects is false) and lists names across starred and discovered projects; wave 3
/// reads details (columns and definitions) for starred projects first, then discovered projects, stopping early if memory gets
/// tight. An object an earlier read already detailed is reused while its creation time (and, for routines and models, its last
/// change) is the same, unless the build re-reads its scope (Object Explorer's Refresh) or DDL marked its dataset stale.
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

    /// <summary>Records that DDL may have changed any dataset of a project, which ones unknown (a script whose statements could not
    /// all be read): the next stale-only build lists the project again and reads each of its datasets whole.</summary>
    public void MarkProjectStale(string connectionId, string project)
    {
        if (!BqNames.IsProject(project) || !states.TryGetValue(connectionId, out var state)) return;
        lock (state.Gate)
            if (state.BigQuery) state.StaleProjects[project] = ++state.StaleMarks;
    }

    /// <summary>Test seam: a connection's index counts as a BigQuery one, so DDL marks land on it without a build.</summary>
    internal void TrackBigQuery(string connectionId)
    {
        var state = states.GetOrAdd(connectionId, _ => new State(pool, resources));
        lock (state.Gate) state.BigQuery = true;
    }

    /// <summary>The newest stale mark not yet spent on a connection, or null (a query's result carries it, docs/object-search.md).</summary>
    public long? StaleMarkOf(string connectionId)
    {
        if (!states.TryGetValue(connectionId, out var state)) return null;
        lock (state.Gate) return state.BigQuery ? state.StaleMark : null;
    }

    /// <summary>Atomically marks a dataset stale if the connection's BigQuery index tracks <paramref name="project"/> (billing, starred, discovered, in-flight, or held).</summary>
    public void MarkStaleIfTracked(string connectionId, string billingProject, string project, string dataset)
    {
        if (!BqNames.IsProject(project) || !BqNames.IsDataset(dataset) || !states.TryGetValue(connectionId, out var state)) return;
        lock (state.Gate)
        {
            if (!state.BigQuery) return;
            if (project == billingProject
                || state.StarredProjects.Contains(project, StringComparer.Ordinal)
                || state.DiscoveredProjects.Contains(project, StringComparer.Ordinal)
                || state.InFlightProjects.Contains(project)
                || state.Index.Databases.Any(read => read.Dataset is not null && read.Database == project))
            {
                state.Stale[(project, dataset)] = ++state.StaleMarks;
            }
        }
    }

    /// <summary>Whether the connection's BigQuery index tracks <paramref name="project"/> (starred, discovered, in-flight, or held).</summary>
    public bool TracksBigQueryProject(string connectionId, string project)
    {
        if (!states.TryGetValue(connectionId, out var state)) return false;
        lock (state.Gate)
            return state.BigQuery && (state.StarredProjects.Contains(project, StringComparer.Ordinal)
                || state.DiscoveredProjects.Contains(project, StringComparer.Ordinal)
                || state.InFlightProjects.Contains(project)
                || state.Index.Databases.Any(read => read.Dataset is not null && read.Database == project));
    }

    /// <summary>The editor's lookup into a BigQuery connection's index (<see cref="BigQueryLookup"/>): a snapshot of its build's state
    /// and the reads held now. A connection with no index yet still answers its billing project.</summary>
    internal BigQueryLookup LookupBigQuery(string connectionId, string billing)
    {
        if (!states.TryGetValue(connectionId, out var state)) return new(billing, [], [], null, [], false, false, budget, Changed);
        lock (state.Gate)
        {
            if (!state.BigQuery) return new(billing, [], [], null, [], false, false, budget, Changed);
            var databases = state.Index.Databases;
            List<string> others =
            [
                .. state.StarredProjects,
                .. state.DiscoveredProjects,
                .. databases.Where(read => read.Dataset is not null).Select(read => read.Database).Order(StringComparer.Ordinal)
            ];
            return new(billing, others, databases, state.NamesOnly, state.Skipped.ToList(), state.Building, state.Built, budget, Changed,
                [.. state.PartialProjects], new Dictionary<string, ObjectIndexSkip>(state.ProjectListingSkips, StringComparer.Ordinal),
                new Dictionary<(string Project, string Dataset), ObjectIndexSkip>(state.DatasetSkips));
        }
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

    /// <summary>The projects marked stale whole on a connection (the checks read it).</summary>
    internal IReadOnlyCollection<string> StaleProjectsOf(string connectionId)
    {
        if (!states.TryGetValue(connectionId, out var state)) return [];
        lock (state.Gate) return [.. state.StaleProjects.Keys];
    }

    public async Task<ObjectIndexResult> IndexBigQueryAsync(ObjectIndexArgs args, IBigQueryIndexSource source, CancellationToken token, Action<object>? progress = null)
    {
        var watch = Stopwatch.StartNew();
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(args.RequestId, out _)) throw Invalid("requestId.");
        if (args.StarredProjects is { } rawStarred && (rawStarred.Count > BigQueryIndexLimits.StarredProjects || rawStarred.Any(project => !BqNames.IsProject(project))))
            throw Invalid("starredProjects.");
        var billing = source.BillingProject(args.ConnectionId);
        var allProjects = args.AllProjects ?? true;
        var maxProjects = args.MaxProjects ?? BigQueryIndexLimits.MaxProjects;
        if (maxProjects < 1 || maxProjects > BigQueryIndexLimits.MaxProjectsCap) throw Invalid("maxProjects.");
        var starred = (args.StarredProjects ?? []).Where(project => project != billing).Distinct(StringComparer.Ordinal).ToList();
        var starredSet = starred.ToHashSet(StringComparer.Ordinal);
        var scope = args.Scope;
        var missingOnly = args.MissingOnly == true;
        var staleOnly = args.Stale == true;
        if (scope is not null && (!BqNames.IsProject(scope.Project) || scope.Dataset is { } only && !BqNames.IsDataset(only))) throw Invalid("scope.");
        if (scope is not null && staleOnly) throw Invalid("stale.");
        if (missingOnly && scope is null) throw Invalid("missingOnly.");
        // The billed bulk path reads only what the estimate covered: billing and starred projects, never auto-discovered ones.
        var bulkProjects = new HashSet<string>(StringComparer.Ordinal) { billing };
        foreach (var project in starred) bulkProjects.Add(project);
        var bulk = args.Bulk;
        if (bulk is not null && (scope is not null || staleOnly || bulk.Locations is not { Count: > 0 and <= BigQueryBulkSql.MaxLocations }
            || bulk.Locations.Any(item => item is null || !bulkProjects.Contains(item.Project) || !BqNames.IsLocation(item.Location))
            || bulk.MaximumBytesBilled is < 1 or > BigQueryLimits.MaxSafeInteger || bulk.BudgetBytes is not (>= 1 and <= BigQueryLimits.MaxSafeInteger))) throw Invalid("bulk.");
        var definitions = args.Definitions ?? true;
        var state = states.GetOrAdd(args.ConnectionId, _ => new State(pool, resources));
        if (missingOnly && scope is not null)
        {
            // Fast path: when the requested scope is already cleanly covered in the index (no listing/dataset skips, partial cuts, or stale marks), return immediately with 0 API calls.
            lock (state.Gate)
            {
                if (state.BigQuery && state.Built && !state.Building && IsScopeCoveredLocked(state, billing, scope))
                    return new(Status(state), watch.ElapsedMilliseconds);
            }
        }
        using var source2 = CancellationTokenSource.CreateLinkedTokenSource(token);
        var entry = running.Register(args.RequestId, args.ConnectionId, source2);
        var stop = source2.Token;
        var finishedBuild = false;
        HashSet<(string Project, string Dataset)> stale;
        Dictionary<string, long> wholeProjects;
        List<string> knownProjects;
        List<string> priorNamesOnly;
        List<string> priorPartialProjects;
        // A stale-only build's skips are its targets' (an earlier skip of a dataset or whole project it reads again goes); a scoped one's are the scope's.
        bool InScope(ObjectIndexSkip skip) => scope is not null ? skip.Project == scope.Project && (scope.Dataset is null || skip.Database == scope.Dataset || skip.Database == "")
            : !staleOnly || skip.Project is { } skipProject && (stale.Contains((skipProject, skip.Database)) || wholeProjects.ContainsKey(skipProject));
        // The mark each dataset had when this build began reading it: only that mark is cleared, so DDL that lands mid-read stays marked.
        var seen = new ConcurrentDictionary<(string, string), long>();
        bool Current() => ReferenceEquals(state.Build, source2);
        var skipOrder = 0;
        const int CarriedSkipOffset = 1_000_000;
        lock (state.Gate)
        {
            stale = [.. state.Stale.Keys];
            wholeProjects = new Dictionary<string, long>(state.StaleProjects, StringComparer.Ordinal);
            priorNamesOnly = state.NamesOnly is { Count: > 0 } prior ? [.. prior] : [];
            priorPartialProjects = state.PartialProjects.Count > 0 ? [.. state.PartialProjects] : [];
            try { state.Build?.Cancel(); } catch (ObjectDisposedException) { }
            state.Build = source2;
            state.Building = true;
            state.BigQuery = true;
            state.Phase = "names";
            // What the index as a whole holds is a full build's to say: a refresh re-reads part of it with whatever Options says now.
            if (scope is null && !staleOnly)
            {
                state.Definitions = definitions;
                state.Bulk = null;
                state.DatasetSkips.Clear();
            }
            state.InFlightProjects.Clear();
            if (scope is not null) state.InFlightProjects.Add(scope.Project);
            knownProjects = [billing, .. state.StarredProjects, .. state.DiscoveredProjects];
            state.Databases = 0;
            state.Indexed = 0;
            // A full build starts its skip list afresh; a scoped or stale-only one keeps the skips outside what it reads (at high orders so fresh refresh skips take priority).
            var kept = state.Skipped.ToList().Where(skip => !InScope(skip)).ToList();
            state.Skipped = new(MaxSkipped);
            for (var at = 0; at < kept.Count; at++)
                state.Skipped.Add(kept[at] is { Project: "", Database: "" } ? SkipList.Server : CarriedSkipOffset + at, kept[at]);
        }
        long CurrentStaleMark()
        {
            lock (state.Gate) return state.StaleMarks;
        }
        void SetProjectListingSkip(string project, ObjectIndexSkip? skip)
        {
            lock (state.Gate)
            {
                if (!Current()) return;
                if (skip is not null) state.ProjectListingSkips[project] = skip;
                else state.ProjectListingSkips.Remove(project);
            }
        }
        void SetDatasetSkip(string project, string dataset, ObjectIndexSkip? skip)
        {
            lock (state.Gate)
            {
                if (!Current()) return;
                if (skip is not null) state.DatasetSkips[(project, dataset)] = skip;
                else state.DatasetSkips.Remove((project, dataset));
            }
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
        void PruneProjectStale(string project, HashSet<string> keptDatasets, long beforeListing)
        {
            lock (state.Gate)
            {
                if (!Current()) return;
                // Only prune stale marks that existed before the dataset listing began; DDL arriving mid-build stays marked.
                foreach (var gone in state.Stale.Where(pair => pair.Key.Project == project && !keptDatasets.Contains(pair.Key.Dataset) && pair.Value <= beforeListing).Select(pair => pair.Key).ToList())
                {
                    state.Stale.Remove(gone);
                    stale.Remove(gone);
                }
            }
        }
        void PruneProjects(HashSet<string> allowed)
        {
            stop.ThrowIfCancellationRequested();
            lock (state.Gate)
            {
                if (!Current()) throw new OperationCanceledException(stop);
                state.Index.KeepWhere(read => allowed.Contains(read.Database));
                foreach (var gone in state.Stale.Keys.Where(key => !allowed.Contains(key.Project)).ToList())
                {
                    state.Stale.Remove(gone);
                    stale.Remove(gone);
                }
                foreach (var gone in state.StaleProjects.Keys.Where(project => !allowed.Contains(project)).ToList())
                    state.StaleProjects.Remove(gone);
                state.DiscoveredProjects = [.. state.DiscoveredProjects.Where(allowed.Contains)];
                state.PartialProjects.RemoveWhere(project => !allowed.Contains(project));
                foreach (var gone in state.ProjectListingSkips.Keys.Where(project => !allowed.Contains(project)).ToList())
                    state.ProjectListingSkips.Remove(gone);
                foreach (var gone in state.DatasetSkips.Keys.Where(key => !allowed.Contains(key.Project)).ToList())
                    state.DatasetSkips.Remove(gone);
                if (state.NamesOnly is { Count: > 0 } currentNamesOnly)
                {
                    var remaining = currentNamesOnly.Where(allowed.Contains).ToList();
                    state.NamesOnly = remaining.Count > 0 ? remaining : null;
                }
            }
        }
        void Skip(ObjectIndexSkip skip)
        {
            var order = skip is { Project: "", Database: "" } ? SkipList.Server : Interlocked.Increment(ref skipOrder) - 1;
            lock (state.Gate) if (Current()) state.Skipped.Add(order, skip);
        }
        ObjectIndexSkip SkipOf(Exception error, string project, string dataset, string? permission)
        {
            var mapped = source.Map(error, project, permission, stop);
            var (code, message) = mapped is RequestException request ? (request.Code, request.Message) : ("CATALOG_ERROR", "BigQuery refused the request.");
            code = code is "PERMISSION_DENIED" or "NOT_FOUND" or "TIMEOUT" or "AUTH_EXPIRED" or "QUOTA" or "API_DISABLED" or "BILLING_DISABLED" or "CONNECTION_LOST" ? code : "CATALOG_ERROR";
            return new(dataset, code, Explorer.ExplorerLabels.Clip(message, 512), Project: project);
        }
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
                progress(new { Type = "explorer.index.progress", Done = done, Total = Math.Max(done, total), Objects = state.Index.Objects, Phase = phase });
            }
        }
        try
        {
            // A project marked whole: each dataset its listing names takes the project's mark (so a failed read keeps it marked and
            // a full build reads it whole too), and the project's own mark is spent once a listing is read.
            void Spread(string project, BigQueryDatasetList list)
            {
                if (!wholeProjects.TryGetValue(project, out var mark)) return;
                lock (state.Gate)
                {
                    if (!Current()) return;
                    foreach (var name in list.Datasets)
                        if (!state.Stale.TryGetValue((project, name), out var had) || had < mark) state.Stale[(project, name)] = mark;
                    if (state.StaleProjects.TryGetValue(project, out var current) && current == mark) state.StaleProjects.Remove(project);
                }
                foreach (var name in list.Datasets) stale.Add((project, name));
            }
            using var slots = new SemaphoreSlim(BigQueryIndexLimits.Details);
            // One dataset's pass 2 details: the bulk path's rows where they cover an object, free tables.get and routines.get for the rest.
            async Task<ObjectIndexSkip?> DetailAsync((string Project, string Dataset) target, (List<BigQueryEntry> Listed, int[] Read, bool Cut) value,
                BigQueryBulkDataset? rows, Func<int> tickDone, int wanted, CancellationToken loop, Action? onDetailFailure = null)
            {
                var (project, dataset) = target;
                var reused = BigQueryEntries.Known(state.Index.Get(project + "\u0001" + dataset), definitions);
                var entries = value.Listed.Select(item => BigQueryEntries.Reuse(reused, item)).ToArray();
                reused.Clear();
                ObjectIndexSkip? failed = null;
                var failures = 0;
                var tasks = new List<Task>();
                // Only what pass 1 counted: an object whose reused details pass 1 could not keep stays as it was held.
                foreach (var at in value.Read)
                {
                    var item = entries[at];
                    var index = at;
                    if (rows is not null && BigQueryBulk.Detail(rows, item, definitions) is { } read)
                    {
                        entries[index] = item with { Detail = read };
                        Report(tickDone(), wanted, "details", false);
                        continue;
                    }
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
                        catch (Exception error) when (loop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                        {
                            throw new OperationCanceledException(loop);
                        }
                        finally
                        {
                            slots.Release();
                            Report(tickDone(), wanted, "details", false);
                        }
                    }, loop));
                }
                await Task.WhenAll(tasks);
                loop.ThrowIfCancellationRequested();
                var held = Hold(state, source2, project, dataset, entries, definitions, loop);
                if (held is not null)
                {
                    Skip(held);
                    SetDatasetSkip(project, dataset, held);
                }
                if (failed is { } first)
                {
                    onDetailFailure?.Invoke();
                    var detailSkip = first with { Details = true, Message = failures == 1 ? "The details of 1 object could not be read: " + first.Message : "The details of " + failures.ToString(CultureInfo.InvariantCulture) + " objects could not be read: " + first.Message };
                    Skip(detailSkip);
                    SetDatasetSkip(project, dataset, detailSkip);
                }
                else if (held is null or { Code: ChildrenLeftOut } && !value.Cut) Clear(target);
                return held;
            }

            // Caller must hold state.Gate and verify Current(): when a project loses its last held dataset, drop NamesOnly
            // and, if the project is no longer tracked anywhere else, drop any orphaned stale marks older than `before`.
            void PruneEmptyProjectLocked(string project, long before)
            {
                if (state.Index.Databases.Any(read => read.Dataset is not null && read.Database == project)) return;
                if (state.NamesOnly is { Count: > 0 } currentNamesOnly && currentNamesOnly.Contains(project, StringComparer.Ordinal))
                {
                    var remaining = currentNamesOnly.Where(item => item != project).ToList();
                    state.NamesOnly = remaining.Count > 0 ? remaining : null;
                }
                if (project != billing && !state.StarredProjects.Contains(project, StringComparer.Ordinal) && !state.DiscoveredProjects.Contains(project, StringComparer.Ordinal))
                {
                    foreach (var gone in state.Stale.Where(pair => pair.Key.Project == project && pair.Value <= before).Select(pair => pair.Key).ToList())
                    {
                        state.Stale.Remove(gone);
                        stale.Remove(gone);
                    }
                    if (state.StaleProjects.TryGetValue(project, out var projectMark) && projectMark <= before)
                        state.StaleProjects.Remove(project);
                }
            }

            async Task ReadPass1Async((string Project, string Dataset) target, ConcurrentDictionary<(string, string), (List<BigQueryEntry> Listed, int[] Read, bool Cut)> pending,
                Func<int> tickDone, Func<int> total, CancellationToken loop, Action? onTooLarge = null, Action<string>? onChildrenLeftOut = null, Action<string>? onIncomplete = null, Action<(string, string)>? onDone = null, Action<(string, string)>? onAttempted = null)
            {
                var (project, dataset) = target;
                var beforeObjects = CurrentStaleMark();
                var marked = Seen(target);
                BigQueryListing listing;
                try { listing = await source.ObjectsAsync(args.ConnectionId, project, dataset, loop); }
                catch (Exception error) when (!loop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                {
                    var skip = SkipOf(error, project, dataset, "bigquery.tables.list");
                    // A dataset that is gone (dropped since the listing, or by the DDL that marked it) leaves the index without a skip.
                    if (skip.Code == "NOT_FOUND")
                    {
                        lock (state.Gate)
                        {
                            if (Current())
                            {
                                state.Index.KeepWhere(read => !(read.Database == project && read.Dataset == dataset));
                                state.DatasetSkips.Remove((project, dataset));
                                if (state.Stale.TryGetValue((project, dataset), out var mark) && mark <= beforeObjects)
                                    state.Stale.Remove((project, dataset));
                                PruneEmptyProjectLocked(project, beforeObjects);
                            }
                        }
                        onDone?.Invoke(target);
                    }
                    else
                    {
                        Skip(skip);
                        SetDatasetSkip(project, dataset, skip);
                        onIncomplete?.Invoke(project);
                    }
                    onAttempted?.Invoke(target);
                    var failedDone = tickDone();
                    Report(failedDone, Math.Max(failedDone, total()), "names", false);
                    return;
                }
                catch (Exception error) when (loop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                {
                    throw new OperationCanceledException(loop);
                }
                var key = project + "\u0001" + dataset;
                var force = (scope is not null && !missingOnly) || marked || stale.Contains(target);
                var known = force ? [] : BigQueryEntries.Known(state.Index.Get(key), definitions);
                var listed = BigQueryEntries.FromListing(listing);
                var entries = listed.Select(item => BigQueryEntries.Reuse(known, item)).ToList();
                known.Clear();
                // A superseded build writes nothing more: the newer one has reset the counters and skips.
                loop.ThrowIfCancellationRequested();
                var held = Hold(state, source2, project, dataset, entries, definitions, loop);
                if (held is { Code: not ChildrenLeftOut })
                {
                    onIncomplete?.Invoke(project);
                    if (onTooLarge is not null && held.Code == "TOO_LARGE") onTooLarge();
                    else
                    {
                        Skip(held);
                        SetDatasetSkip(project, dataset, held);
                        onAttempted?.Invoke(target);
                    }
                }
                else
                {
                    lock (state.Gate) if (Current()) state.Indexed++;
                    ObjectIndexSkip? datasetSkip = null;
                    if (held is not null)
                    {
                        Skip(held);
                        datasetSkip = held;
                        onChildrenLeftOut?.Invoke(project);
                        onIncomplete?.Invoke(project);
                    }
                    if (listing.Cut)
                    {
                        var cutSkip = new ObjectIndexSkip(dataset, "TOO_LARGE", "The dataset has more objects than the index lists; it keeps the first ones.", Project: project);
                        Skip(cutSkip);
                        datasetSkip ??= cutSkip;
                        onIncomplete?.Invoke(project);
                    }
                    SetDatasetSkip(project, dataset, datasetSkip);
                    // A read that fit only without columns reads no details: they would not fit either, and its reused ones are gone.
                    int[] read = held is null
                        ? [.. Enumerable.Range(0, entries.Count).Where(at => entries[at].Detail is null && BigQueryEntries.HasDetails(entries[at]))] : [];
                    if (read.Length > 0) pending[target] = (listed, read, listing.Cut);
                    else if (!listing.Cut) Clear(target);
                    onDone?.Invoke(target);
                    onAttempted?.Invoke(target);
                }
                var doneNow = tickDone();
                Report(doneNow, Math.Max(doneNow, total()), "names", false);
            }

            void KeepProjectDatasets(string project, HashSet<string> names, bool cut, long beforeListing, string? onlyDataset = null)
            {
                stop.ThrowIfCancellationRequested();
                lock (state.Gate)
                {
                    if (!Current()) throw new OperationCanceledException(stop);
                    state.Index.KeepWhere(read => read.Database != project || read.Dataset is not { } dataset || names.Contains(dataset) || cut
                        || onlyDataset is { } kept && kept != dataset);
                    if (!cut)
                    {
                        foreach (var gone in state.DatasetSkips.Keys.Where(key => key.Project == project && !names.Contains(key.Dataset)
                            && (onlyDataset is null || onlyDataset == key.Dataset)).ToList())
                            state.DatasetSkips.Remove(gone);
                    }
                    if (names.Count == 0) PruneEmptyProjectLocked(project, beforeListing);
                }
                if (!cut)
                {
                    if (onlyDataset is null) PruneProjectStale(project, names, beforeListing);
                    else if (!names.Contains(onlyDataset))
                    {
                        lock (state.Gate)
                        {
                            if (Current() && state.Stale.TryGetValue((project, onlyDataset), out var mark) && mark <= beforeListing)
                            {
                                state.Stale.Remove((project, onlyDataset));
                                stale.Remove((project, onlyDataset));
                            }
                        }
                    }
                }
            }

            if (scope is not null || staleOnly)
            {
                // Scoped refresh (any valid project: billing, starred, discovered, or session) or stale-only refresh.
                stop.ThrowIfCancellationRequested();
                if (args.StarredProjects is not null)
                {
                    lock (state.Gate)
                    {
                        if (!Current()) throw new OperationCanceledException(stop);
                        state.StarredProjects = [.. starred];
                    }
                }
                var targets = new List<(string Project, string Dataset)>();
                var scopedClean = scope is { Dataset: null };
                if (staleOnly)
                {
                    var allowedStale = new HashSet<string>(StringComparer.Ordinal) { billing };
                    foreach (var project in starred) allowedStale.Add(project);
                    foreach (var project in knownProjects) allowedStale.Add(project);
                    foreach (var read in state.Index.Databases)
                        if (read.Dataset is not null) allowedStale.Add(read.Database);
                    foreach (var project in wholeProjects.Keys.Where(allowedStale.Contains).Order(StringComparer.Ordinal))
                    {
                        var beforeListing = CurrentStaleMark();
                        BigQueryDatasetList list;
                        try { list = await source.DatasetsAsync(args.ConnectionId, project, stop); }
                        catch (Exception error) when (!stop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                        {
                            var skip = SkipOf(error, project, "", "bigquery.datasets.get");
                            Skip(skip);
                            SetProjectListingSkip(project, skip);
                            continue;
                        }
                        if (list.Cut)
                        {
                            var cutSkip = new ObjectIndexSkip("", "TOO_LARGE", "The project has more datasets than the index lists; it keeps the first " + (BigQueryIndexLimits.ListPages * 1000).ToString("N0", CultureInfo.InvariantCulture) + ".", Project: project);
                            Skip(cutSkip);
                            SetProjectListingSkip(project, cutSkip);
                        }
                        else SetProjectListingSkip(project, null);
                        var names = list.Datasets.ToHashSet(StringComparer.Ordinal);
                        KeepProjectDatasets(project, names, list.Cut, beforeListing);
                        Spread(project, list);
                    }
                    targets.AddRange(stale.Where(item => allowedStale.Contains(item.Project))
                        .OrderBy(item => item.Project, StringComparer.Ordinal).ThenBy(item => item.Dataset, StringComparer.Ordinal));
                }
                else
                {
                    var beforeListing = CurrentStaleMark();
                    BigQueryDatasetList? list = null;
                    try { list = await source.DatasetsAsync(args.ConnectionId, scope!.Project, stop); }
                    catch (Exception error) when (!stop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                    {
                        scopedClean = false;
                        var skip = SkipOf(error, scope!.Project, "", "bigquery.datasets.get");
                        Skip(skip);
                        SetProjectListingSkip(scope!.Project, skip);
                    }
                    if (list is not null)
                    {
                        if (list.Cut)
                        {
                            scopedClean = false;
                            var cutSkip = new ObjectIndexSkip("", "TOO_LARGE", "The project has more datasets than the index lists; it keeps the first " + (BigQueryIndexLimits.ListPages * 1000).ToString("N0", CultureInfo.InvariantCulture) + ".", Project: scope!.Project);
                            Skip(cutSkip);
                            SetProjectListingSkip(scope!.Project, cutSkip);
                        }
                        else SetProjectListingSkip(scope!.Project, null);
                        var listed = scope!.Dataset is { } scoped ? list.Datasets.Where(name => name == scoped).ToList() : list.Datasets;
                        var names = listed.ToHashSet(StringComparer.Ordinal);
                        KeepProjectDatasets(scope.Project, names, list.Cut, beforeListing, scope.Dataset);
                        if (scope.Dataset is null) Spread(scope.Project, list);
                        targets.AddRange(listed.Select(name => (scope.Project, name)));
                    }
                }
                lock (state.Gate) if (Current()) state.Databases = targets.Count;
                var pending = new ConcurrentDictionary<(string, string), (List<BigQueryEntry> Listed, int[] Read, bool Cut)>();
                Report(0, targets.Count, "names", true);
                var listedDone = 0;
                var scopedPassIncomplete = 0;
                await Parallel.ForEachAsync(targets, new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = stop },
                    (target, loop) => new ValueTask(ReadPass1Async(target, pending, () => Interlocked.Increment(ref listedDone), () => targets.Count, loop,
                        onIncomplete: _ => Interlocked.Exchange(ref scopedPassIncomplete, 1))));
                Report(listedDone, targets.Count, "names", true);
                lock (state.Gate) if (Current()) state.Phase = "details";
                var wanted = pending.Sum(pair => pair.Value.Read.Length);
                var detailsDone = 0;
                Report(0, wanted, "details", true);
                await Parallel.ForEachAsync(pending.OrderBy(pair => pair.Key.Item1, StringComparer.Ordinal).ThenBy(pair => pair.Key.Item2, StringComparer.Ordinal),
                    new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = stop },
                    async (pair, loop) =>
                    {
                        var held = await DetailAsync(pair.Key, pair.Value, null, () => Interlocked.Increment(ref detailsDone), wanted, loop,
                            onDetailFailure: () => Interlocked.Exchange(ref scopedPassIncomplete, 1));
                        if (held is not null) Interlocked.Exchange(ref scopedPassIncomplete, 1);
                    });
                Report(detailsDone, wanted, "details", true);
                // Whole-project scoped refresh whose dataset listing succeeded clears any Wave 2 partial-project mark (every dataset was attempted);
                // clearing NamesOnly additionally requires full details without incomplete passes.
                if (scopedClean && scope is { Dataset: null })
                {
                    var detailsClean = Volatile.Read(ref scopedPassIncomplete) == 0;
                    lock (state.Gate)
                    {
                        if (Current())
                        {
                            state.PartialProjects.Remove(scope.Project);
                            if (detailsClean && state.NamesOnly is { Count: > 0 } currentNamesOnly && currentNamesOnly.Contains(scope.Project, StringComparer.Ordinal))
                            {
                                var remaining = currentNamesOnly.Where(project => project != scope.Project).ToList();
                                state.NamesOnly = remaining.Count > 0 ? remaining : null;
                            }
                        }
                    }
                }
            }
            else
            {
                // Full build: 3 prioritized waves.
                var located = new ConcurrentDictionary<(string, string), string>();
                var bulkBudget = bulk is not null ? new BigQueryBulkBudget(bulk.BudgetBytes!.Value) : null;
                var bulkAsked = new HashSet<(string, string)>();
                var bulkRead = 0;
                var bulkFailed = 0;
                (string Code, string Message)? bulkError = null;
                async Task RunBulkAsync(IEnumerable<BigQueryIndexLocation> locations,
                    ConcurrentDictionary<(string, string), (List<BigQueryEntry> Listed, int[] Read, bool Cut)> pending, Func<int> tickDone, int wanted, Action<string>? onIncomplete = null)
                {
                    if (bulk is null || bulkBudget is null) return;
                    foreach (var (project, location) in locations.Select(item => (item.Project, item.Location)))
                    {
                        // Location ids are case-insensitive: one spelled twice is read once.
                        if (!bulkAsked.Add((project, location.ToUpperInvariant()))) continue;
                        var inLocation = pending.Keys.Where(key => key.Item1 == project && string.Equals(located.GetValueOrDefault(key), location, StringComparison.OrdinalIgnoreCase)).ToHashSet();
                        if (inLocation.Count == 0) continue;
                        // The objects pass 2 would read, by dataset: the rows of any other are dropped as they arrive.
                        var names = inLocation.ToDictionary(key => key.Item2, key => pending.TryGetValue(key, out var value) ? value.Read.Select(at => value.Listed[at].Name).ToHashSet(StringComparer.Ordinal) : [], StringComparer.Ordinal);
                        try
                        {
                            await foreach (var rows in source.BulkAsync(args.ConnectionId, project, location, definitions, bulk.MaximumBytesBilled, bulkBudget,
                                (dataset, name) => names.TryGetValue(dataset, out var set) && set.Contains(name), stop).WithCancellation(stop))
                                if (inLocation.Remove((project, rows.Dataset)) && pending.TryRemove((project, rows.Dataset), out var value))
                                {
                                    var held = await DetailAsync((project, rows.Dataset), value, rows, tickDone, wanted, stop,
                                        onDetailFailure: onIncomplete is null ? null : () => onIncomplete(project));
                                    if (held is not null) onIncomplete?.Invoke(project);
                                }
                            bulkRead++;
                        }
                        catch (Exception error) when (!stop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                        {
                            bulkFailed++;
                            // A location past its own time limit timed out; its datasets still get their details from the free calls below.
                            var mapped = source.Map(error is OperationCanceledException ? new TimeoutException() : error, project, "bigquery.jobs.create", stop);
                            bulkError ??= mapped is RequestException request ? (request.Code, Explorer.ExplorerLabels.Clip(request.Message, 512)) : ("BACKEND_ERROR", "BigQuery refused the request.");
                        }
                    }
                    lock (state.Gate) if (ReferenceEquals(state.Build, source2)) state.Bulk = new(bulkRead, bulkFailed, bulkError?.Code, bulkError?.Message);
                }

                // Wave 1 — Billing project (Names + Details): ready for Search Objects and IntelliSense right away.
                var wave1Targets = new List<(string Project, string Dataset)>();
                {
                    var beforeListing = CurrentStaleMark();
                    BigQueryDatasetList? list = null;
                    try { list = await source.DatasetsAsync(args.ConnectionId, billing, stop); }
                    catch (Exception error) when (!stop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                    {
                        var skip = SkipOf(error, billing, "", "bigquery.datasets.get");
                        Skip(skip);
                        SetProjectListingSkip(billing, skip);
                    }
                    if (list is not null)
                    {
                        if (list.Cut)
                        {
                            var cutSkip = new ObjectIndexSkip("", "TOO_LARGE", "The project has more datasets than the index lists; it keeps the first " + (BigQueryIndexLimits.ListPages * 1000).ToString("N0", CultureInfo.InvariantCulture) + ".", Project: billing);
                            Skip(cutSkip);
                            SetProjectListingSkip(billing, cutSkip);
                        }
                        else SetProjectListingSkip(billing, null);
                        var names = list.Datasets.ToHashSet(StringComparer.Ordinal);
                        KeepProjectDatasets(billing, names, list.Cut, beforeListing);
                        Spread(billing, list);
                        foreach (var name in list.Datasets)
                        {
                            wave1Targets.Add((billing, name));
                            if (list.Locations?.GetValueOrDefault(name) is { } where) located[(billing, name)] = where;
                        }
                    }
                }
                lock (state.Gate) if (Current()) { state.Phase = "names"; state.Databases = wave1Targets.Count; }
                var wave1Pending = new ConcurrentDictionary<(string, string), (List<BigQueryEntry> Listed, int[] Read, bool Cut)>();
                Report(0, wave1Targets.Count, "names", true);
                var wave1ListedDone = 0;
                await Parallel.ForEachAsync(wave1Targets, new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = stop },
                    (target, loop) => new ValueTask(ReadPass1Async(target, wave1Pending, () => Interlocked.Increment(ref wave1ListedDone), () => wave1Targets.Count, loop)));
                Report(wave1ListedDone, wave1Targets.Count, "names", true);
                lock (state.Gate) if (Current()) state.Phase = "details";
                var wave1Wanted = wave1Pending.Sum(pair => pair.Value.Read.Length);
                var wave1DetailsDone = 0;
                Report(0, wave1Wanted, "details", true);
                if (bulk is not null)
                    await RunBulkAsync(bulk.Locations.Where(item => item.Project == billing), wave1Pending, () => Interlocked.Increment(ref wave1DetailsDone), wave1Wanted);
                await Parallel.ForEachAsync(wave1Pending.OrderBy(pair => pair.Key.Item1, StringComparer.Ordinal).ThenBy(pair => pair.Key.Item2, StringComparer.Ordinal),
                    new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = stop },
                    async (pair, loop) => { await DetailAsync(pair.Key, pair.Value, null, () => Interlocked.Increment(ref wave1DetailsDone), wave1Wanted, loop); });
                Report(wave1DetailsDone, wave1Wanted, "details", true);

                // Wave 2 — Starred + Discovered projects (Pass 1: Names).
                stop.ThrowIfCancellationRequested();
                var discovered = new List<string>();
                var discoverySucceeded = false;
                var discoveryCut = false;
                if (allProjects)
                {
                    lock (state.Gate) if (Current()) state.Phase = "projects";
                    Report(0, 0, "projects", true);
                    try
                    {
                        var discovery = await source.AccessibleProjectsAsync(args.ConnectionId, maxProjects, stop);
                        discoverySucceeded = true;
                        discoveryCut = discovery.Cut;
                        discovered = [.. discovery.Projects.Where(project => project != billing && !starredSet.Contains(project)).Order(StringComparer.Ordinal)];
                        if (discovery.Cut)
                            Skip(new("", "TOO_LARGE", "You have access to more than " + maxProjects.ToString("N0", CultureInfo.InvariantCulture) + " projects; the index keeps the first " + maxProjects.ToString("N0", CultureInfo.InvariantCulture) + ".", Project: ""));
                    }
                    catch (Exception error) when (!stop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                    {
                        // projects.list needs no one permission: it lists the projects where the account holds any BigQuery role.
                        var skip = SkipOf(error, "", "", null);
                        Skip(new("", skip.Code, skip.Message, Project: ""));
                    }
                }
                var pruneWhole = !allProjects || (discoverySucceeded && !discoveryCut);
                lock (state.Gate)
                {
                    if (!Current()) throw new OperationCanceledException(stop);
                    var previousStarred = state.StarredProjects;
                    state.StarredProjects = [.. starred];
                    if (!allProjects) state.DiscoveredProjects = [];
                    else if (!pruneWhole && previousStarred.Count > 0)
                    {
                        // Unstarred projects with no held datasets and not otherwise tracked drop any pending stale marks so StaleMark cannot leak.
                        var heldNow = state.Index.Databases.Where(read => read.Dataset is not null).Select(read => read.Database).ToHashSet(StringComparer.Ordinal);
                        var stillTracked = new HashSet<string>(StringComparer.Ordinal) { billing };
                        foreach (var project in starred) stillTracked.Add(project);
                        foreach (var project in discovered) stillTracked.Add(project);
                        foreach (var project in state.DiscoveredProjects) stillTracked.Add(project);
                        foreach (var project in heldNow) stillTracked.Add(project);
                        var removedStarred = previousStarred.Where(project => !stillTracked.Contains(project)).ToHashSet(StringComparer.Ordinal);
                        if (removedStarred.Count > 0)
                        {
                            foreach (var gone in state.Stale.Keys.Where(key => removedStarred.Contains(key.Project)).ToList())
                            {
                                state.Stale.Remove(gone);
                                stale.Remove(gone);
                            }
                            foreach (var gone in removedStarred) state.StaleProjects.Remove(gone);
                        }
                    }
                }
                if (pruneWhole)
                {
                    var allowed = new HashSet<string>(StringComparer.Ordinal) { billing };
                    foreach (var project in starred) allowed.Add(project);
                    foreach (var project in discovered) allowed.Add(project);
                    PruneProjects(allowed);
                }

                // Wave 2 — Stream dataset listings directly into Pass 1 (Names), starred projects first so a slow discovered
                // project never delays a starred project and huge orgs never accumulate all listings before the memory budget stops them.
                var wave2ListedProjects = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
                var wave2ListingIncompleteProjects = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
                var wave2IncompleteProjects = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
                var projectListedCount = new ConcurrentDictionary<string, int>(StringComparer.Ordinal);
                var projectAttemptedCount = new ConcurrentDictionary<string, int>(StringComparer.Ordinal);
                var projectCompletedCount = new ConcurrentDictionary<string, int>(StringComparer.Ordinal);
                var noiseFilteredProjects = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
                var discoveredFailedProjects = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
                var wave3StarredPending = new ConcurrentDictionary<(string, string), (List<BigQueryEntry> Listed, int[] Read, bool Cut)>();
                var wave3DiscoveredPending = new ConcurrentDictionary<(string, string), (List<BigQueryEntry> Listed, int[] Read, bool Cut)>();
                var wave2NamesOnly = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
                var wave2Total = wave1Targets.Count;
                var listedDone = wave1ListedDone;
                var wave2BudgetExhausted = 0;

                void RecordListedDatasets(int added)
                {
                    if (added <= 0) return;
                    var totalNow = Interlocked.Add(ref wave2Total, added);
                    lock (state.Gate) if (Current()) state.Databases = totalNow;
                }
                void DropNoiseFilteredProject(string project)
                {
                    stop.ThrowIfCancellationRequested();
                    lock (state.Gate)
                    {
                        if (!Current()) throw new OperationCanceledException(stop);
                        state.Index.KeepWhere(read => read.Database != project);
                        foreach (var gone in state.Stale.Keys.Where(key => key.Project == project).ToList())
                        {
                            state.Stale.Remove(gone);
                            stale.Remove(gone);
                        }
                        state.StaleProjects.Remove(project);
                        state.PartialProjects.Remove(project);
                        state.ProjectListingSkips.Remove(project);
                        foreach (var gone in state.DatasetSkips.Keys.Where(key => key.Project == project).ToList())
                            state.DatasetSkips.Remove(gone);
                        state.InFlightProjects.Remove(project);
                        state.DiscoveredProjects = [.. state.DiscoveredProjects.Where(item => item != project)];
                        if (state.NamesOnly is { Count: > 0 } currentNamesOnly && currentNamesOnly.Contains(project, StringComparer.Ordinal))
                        {
                            var remaining = currentNamesOnly.Where(item => item != project).ToList();
                            state.NamesOnly = remaining.Count > 0 ? remaining : null;
                        }
                    }
                }

                if (starred.Count > 0 || discovered.Count > 0)
                {
                    lock (state.Gate)
                    {
                        if (Current())
                        {
                            state.Phase = "names";
                            foreach (var project in starred) state.InFlightProjects.Add(project);
                            foreach (var project in discovered) state.InFlightProjects.Add(project);
                        }
                    }
                    Report(listedDone, Volatile.Read(ref wave2Total), "names", true);
                }

                // Wave 2a — Starred projects: stream DatasetsAsync -> ReadPass1Async before starting discovered projects.
                if (starred.Count > 0)
                {
                    using var wave2StarredStop = CancellationTokenSource.CreateLinkedTokenSource(stop);
                    var starredChannel = Channel.CreateBounded<(string Project, string Dataset)>(new BoundedChannelOptions(BigQueryIndexLimits.Datasets * 4));
                    var starredProducer = Task.Run(async () =>
                    {
                        try
                        {
                            await Parallel.ForEachAsync(starred,
                                new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Projects, CancellationToken = wave2StarredStop.Token },
                                async (project, loop) =>
                                {
                                    var beforeListing = CurrentStaleMark();
                                    BigQueryDatasetList list;
                                    try { list = await source.DatasetsAsync(args.ConnectionId, project, loop); }
                                    catch (Exception error) when (!loop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                                    {
                                        var skip = SkipOf(error, project, "", "bigquery.datasets.get");
                                        Skip(skip);
                                        SetProjectListingSkip(project, skip);
                                        wave2ListingIncompleteProjects[project] = 0;
                                        wave2IncompleteProjects[project] = 0;
                                        return;
                                    }
                                    catch (Exception error) when (loop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                                    {
                                        throw new OperationCanceledException(loop);
                                    }
                                    wave2ListedProjects[project] = 0;
                                    if (list.Cut)
                                    {
                                        var cutSkip = new ObjectIndexSkip("", "TOO_LARGE", "The project has more datasets than the index lists; it keeps the first " + (BigQueryIndexLimits.ListPages * 1000).ToString("N0", CultureInfo.InvariantCulture) + ".", Project: project);
                                        Skip(cutSkip);
                                        SetProjectListingSkip(project, cutSkip);
                                        wave2ListingIncompleteProjects[project] = 0;
                                        wave2IncompleteProjects[project] = 0;
                                    }
                                    else SetProjectListingSkip(project, null);
                                    var names = list.Datasets.ToHashSet(StringComparer.Ordinal);
                                    var distinctDatasets = list.Datasets.Distinct(StringComparer.Ordinal).ToList();
                                    projectListedCount[project] = distinctDatasets.Count;
                                    KeepProjectDatasets(project, names, list.Cut, beforeListing);
                                    Spread(project, list);
                                    RecordListedDatasets(distinctDatasets.Count);
                                    foreach (var name in distinctDatasets)
                                    {
                                        if (list.Locations?.GetValueOrDefault(name) is { } where) located[(project, name)] = where;
                                        await starredChannel.Writer.WriteAsync((project, name), loop);
                                    }
                                });
                            starredChannel.Writer.TryComplete();
                        }
                        catch (Exception error)
                        {
                            starredChannel.Writer.TryComplete(error);
                            wave2StarredStop.Cancel();
                            throw;
                        }
                    }, wave2StarredStop.Token);
                    var starredConsumers = Enumerable.Range(0, BigQueryIndexLimits.Datasets).Select(_ => Task.Run(async () =>
                    {
                        try
                        {
                            await foreach (var target in starredChannel.Reader.ReadAllAsync(wave2StarredStop.Token))
                            {
                                await ReadPass1Async(target, wave3StarredPending, () => Interlocked.Increment(ref listedDone), () => Volatile.Read(ref wave2Total), wave2StarredStop.Token,
                                    onIncomplete: project => wave2IncompleteProjects[project] = 0,
                                    onDone: doneTarget => projectCompletedCount.AddOrUpdate(doneTarget.Item1, 1, (_, count) => count + 1),
                                    onAttempted: attemptedTarget => projectAttemptedCount.AddOrUpdate(attemptedTarget.Item1, 1, (_, count) => count + 1));
                            }
                        }
                        catch
                        {
                            wave2StarredStop.Cancel();
                            throw;
                        }
                    }, wave2StarredStop.Token)).ToArray();
                    await Task.WhenAll([starredProducer, .. starredConsumers]);
                }

                // Wave 2b — Discovered projects: bounded streaming DatasetsAsync -> ReadPass1Async so early memory-limit stops halt listing too.
                if (discovered.Count > 0)
                {
                    using var wave2DiscoveredStop = CancellationTokenSource.CreateLinkedTokenSource(stop);
                    var discoveredChannel = Channel.CreateBounded<(string Project, string Dataset)>(new BoundedChannelOptions(BigQueryIndexLimits.Datasets * 4));
                    var discoveredProducer = Task.Run(async () =>
                    {
                        try
                        {
                            await Parallel.ForEachAsync(discovered,
                                new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Projects, CancellationToken = wave2DiscoveredStop.Token },
                                async (project, loop) =>
                                {
                                    if (Volatile.Read(ref wave2BudgetExhausted) != 0) return;
                                    var beforeListing = CurrentStaleMark();
                                    BigQueryDatasetList list;
                                    try { list = await source.DatasetsAsync(args.ConnectionId, project, loop); }
                                    catch (Exception error) when (!loop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                                    {
                                        var skip = SkipOf(error, project, "", "bigquery.datasets.get");
                                        // Noise filtering: auto-discovered projects without BigQuery enabled or dataset access are silently skipped.
                                        if (skip.Code is "API_DISABLED" or "PERMISSION_DENIED" or "NOT_FOUND")
                                        {
                                            noiseFilteredProjects[project] = 0;
                                            DropNoiseFilteredProject(project);
                                        }
                                        else
                                        {
                                            Skip(skip);
                                            SetProjectListingSkip(project, skip);
                                            discoveredFailedProjects[project] = 0;
                                            wave2ListingIncompleteProjects[project] = 0;
                                            wave2IncompleteProjects[project] = 0;
                                        }
                                        return;
                                    }
                                    catch (Exception error) when (loop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                                    {
                                        throw new OperationCanceledException(loop);
                                    }
                                    wave2ListedProjects[project] = 0;
                                    if (list.Cut)
                                    {
                                        var cutSkip = new ObjectIndexSkip("", "TOO_LARGE", "The project has more datasets than the index lists; it keeps the first " + (BigQueryIndexLimits.ListPages * 1000).ToString("N0", CultureInfo.InvariantCulture) + ".", Project: project);
                                        Skip(cutSkip);
                                        SetProjectListingSkip(project, cutSkip);
                                        wave2ListingIncompleteProjects[project] = 0;
                                        wave2IncompleteProjects[project] = 0;
                                    }
                                    else SetProjectListingSkip(project, null);
                                    var names = list.Datasets.ToHashSet(StringComparer.Ordinal);
                                    var distinctDatasets = list.Datasets.Distinct(StringComparer.Ordinal).ToList();
                                    projectListedCount[project] = distinctDatasets.Count;
                                    KeepProjectDatasets(project, names, list.Cut, beforeListing);
                                    Spread(project, list);
                                    RecordListedDatasets(distinctDatasets.Count);
                                    foreach (var name in distinctDatasets)
                                    {
                                        if (Volatile.Read(ref wave2BudgetExhausted) != 0) break;
                                        await discoveredChannel.Writer.WriteAsync((project, name), loop);
                                    }
                                });
                            discoveredChannel.Writer.TryComplete();
                        }
                        catch (Exception error)
                        {
                            discoveredChannel.Writer.TryComplete(error);
                            if (error is not OperationCanceledException) wave2DiscoveredStop.Cancel();
                            throw;
                        }
                    }, wave2DiscoveredStop.Token);
                    var discoveredConsumers = Enumerable.Range(0, BigQueryIndexLimits.Datasets).Select(_ => Task.Run(async () =>
                    {
                        try
                        {
                            await foreach (var target in discoveredChannel.Reader.ReadAllAsync(wave2DiscoveredStop.Token))
                            {
                                if (Volatile.Read(ref wave2BudgetExhausted) != 0) break;
                                await ReadPass1Async(target, wave3DiscoveredPending, () => Interlocked.Increment(ref listedDone), () => Volatile.Read(ref wave2Total), wave2DiscoveredStop.Token,
                                    onTooLarge: () =>
                                    {
                                        if (Interlocked.Exchange(ref wave2BudgetExhausted, 1) == 0)
                                        {
                                            Skip(new("", "TOO_LARGE", "Indexing stopped early for auto-discovered projects because the index reached its " + Size + " memory limit.", Project: ""));
                                            wave2DiscoveredStop.Cancel();
                                        }
                                    },
                                    onChildrenLeftOut: project => wave2NamesOnly[project] = 0,
                                    onIncomplete: project => wave2IncompleteProjects[project] = 0,
                                    onDone: doneTarget => projectCompletedCount.AddOrUpdate(doneTarget.Item1, 1, (_, count) => count + 1),
                                    onAttempted: attemptedTarget => projectAttemptedCount.AddOrUpdate(attemptedTarget.Item1, 1, (_, count) => count + 1));
                            }
                        }
                        catch
                        {
                            wave2DiscoveredStop.Cancel();
                            throw;
                        }
                    }, wave2DiscoveredStop.Token)).ToArray();
                    try
                    {
                        await Task.WhenAll([discoveredProducer, .. discoveredConsumers]);
                    }
                    catch (OperationCanceledException) when (Volatile.Read(ref wave2BudgetExhausted) == 1 && !stop.IsCancellationRequested)
                    {
                        // Wave 2 budget early-stop: Wave 1 and already-held Wave 2 datasets stay intact.
                    }
                }
                if (starred.Count > 0 || discovered.Count > 0)
                    Report(listedDone, Volatile.Read(ref wave2Total), "names", true);

                // Commit discovered projects and PartialProjects after Wave 2: exclude noise-filtered projects and truly budget-cut projects.
                {
                    stop.ThrowIfCancellationRequested();
                    var heldProjects = state.Index.Databases.Where(read => read.Dataset is not null).Select(read => read.Database).ToHashSet(StringComparer.Ordinal);
                    var budgetStopped = Volatile.Read(ref wave2BudgetExhausted) != 0;
                    var nextPartial = new HashSet<string>(StringComparer.Ordinal);
                    List<string>? finalDiscovered = null;
                    if (allProjects && discoverySucceeded)
                    {
                        finalDiscovered = new List<string>(discovered.Count);
                        foreach (var project in discovered)
                        {
                            if (noiseFilteredProjects.ContainsKey(project)) continue;
                            if (discoveredFailedProjects.ContainsKey(project))
                            {
                                finalDiscovered.Add(project);
                                continue;
                            }
                            if (!projectListedCount.TryGetValue(project, out var listedCount))
                            {
                                // Listing never completed (budget early-stop cancelled remaining projects): keep only if datasets are already held.
                                if (heldProjects.Contains(project))
                                {
                                    finalDiscovered.Add(project);
                                    nextPartial.Add(project);
                                }
                                continue;
                            }
                            var attemptedCount = projectAttemptedCount.GetValueOrDefault(project);
                            if (budgetStopped && listedCount > 0 && !heldProjects.Contains(project) && attemptedCount == 0)
                                continue;
                            finalDiscovered.Add(project);
                            if (budgetStopped && attemptedCount < listedCount)
                                nextPartial.Add(project);
                        }
                    }
                    lock (state.Gate)
                    {
                        if (Current())
                        {
                            if (finalDiscovered is not null) state.DiscoveredProjects = finalDiscovered;
                            state.InFlightProjects.Clear();
                            // Canonical post-commit tracked set: any project outside it drops orphaned stale/partial/listing-skip marks.
                            var tracked = new HashSet<string>(StringComparer.Ordinal) { billing };
                            foreach (var project in state.StarredProjects) tracked.Add(project);
                            foreach (var project in state.DiscoveredProjects) tracked.Add(project);
                            foreach (var read in state.Index.Databases)
                                if (read.Dataset is not null) tracked.Add(read.Database);
                            foreach (var prior in priorPartialProjects)
                            {
                                if (prior == billing || !tracked.Contains(prior)) continue;
                                var unattempted = projectListedCount.TryGetValue(prior, out var listedCount) && projectAttemptedCount.GetValueOrDefault(prior) < listedCount;
                                if (!wave2ListedProjects.ContainsKey(prior) || wave2ListingIncompleteProjects.ContainsKey(prior) || unattempted)
                                    nextPartial.Add(prior);
                            }
                            state.PartialProjects = nextPartial;
                            foreach (var gone in state.Stale.Keys.Where(key => !tracked.Contains(key.Project)).ToList())
                            {
                                state.Stale.Remove(gone);
                                stale.Remove(gone);
                            }
                            foreach (var gone in state.StaleProjects.Keys.Where(project => !tracked.Contains(project)).ToList())
                                state.StaleProjects.Remove(gone);
                            foreach (var gone in state.ProjectListingSkips.Keys.Where(project => !tracked.Contains(project)).ToList())
                                state.ProjectListingSkips.Remove(gone);
                            foreach (var gone in state.DatasetSkips.Keys.Where(key => !tracked.Contains(key.Project)).ToList())
                                state.DatasetSkips.Remove(gone);
                        }
                    }
                }

                // Wave 3 — Starred, then Discovered projects (Pass 2: Columns + Definitions).
                var wave3Wanted = wave3StarredPending.Sum(pair => pair.Value.Read.Length) + wave3DiscoveredPending.Sum(pair => pair.Value.Read.Length);
                var wave3DetailsDone = 0;
                var completedDiscovered = new ConcurrentDictionary<(string, string), byte>();
                if (wave3Wanted > 0 || bulk is not null)
                {
                    lock (state.Gate) if (Current()) state.Phase = "details";
                    if (wave3Wanted > 0) Report(0, wave3Wanted, "details", true);
                    if (bulk is not null)
                        await RunBulkAsync(bulk.Locations.Where(item => starredSet.Contains(item.Project)), wave3StarredPending, () => Interlocked.Increment(ref wave3DetailsDone), wave3Wanted,
                            onIncomplete: project => wave2IncompleteProjects[project] = 0);
                    if (!wave3StarredPending.IsEmpty)
                    {
                        await Parallel.ForEachAsync(wave3StarredPending.OrderBy(pair => pair.Key.Item1, StringComparer.Ordinal).ThenBy(pair => pair.Key.Item2, StringComparer.Ordinal),
                            new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = stop },
                            async (pair, loop) =>
                            {
                                var held = await DetailAsync(pair.Key, pair.Value, null, () => Interlocked.Increment(ref wave3DetailsDone), wave3Wanted, loop,
                                    onDetailFailure: () => wave2IncompleteProjects[pair.Key.Item1] = 0);
                                if (held is not null) wave2IncompleteProjects[pair.Key.Item1] = 0;
                            });
                    }
                    var wave3BudgetTight = Volatile.Read(ref wave2BudgetExhausted);
                    if (!wave3DiscoveredPending.IsEmpty && wave3BudgetTight == 0)
                    {
                        var reserveFloor = Limits.NamesReserveBytes / 2;
                        using var wave3DiscoveredStop = CancellationTokenSource.CreateLinkedTokenSource(stop);
                        try
                        {
                            await Parallel.ForEachAsync(wave3DiscoveredPending.OrderBy(pair => pair.Key.Item1, StringComparer.Ordinal).ThenBy(pair => pair.Key.Item2, StringComparer.Ordinal),
                                new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = wave3DiscoveredStop.Token },
                                async (pair, loop) =>
                                {
                                    if (Volatile.Read(ref wave3BudgetTight) != 0) return;
                                    if (reserveFloor > 0 && budget.Limit - budget.Used < reserveFloor)
                                    {
                                        if (Interlocked.Exchange(ref wave3BudgetTight, 1) == 0) wave3DiscoveredStop.Cancel();
                                        return;
                                    }
                                    var held = await DetailAsync(pair.Key, pair.Value, null, () => Interlocked.Increment(ref wave3DetailsDone), wave3Wanted, loop,
                                        onDetailFailure: () => wave2IncompleteProjects[pair.Key.Item1] = 0);
                                    if (held is { Code: ChildrenLeftOut or "TOO_LARGE" })
                                    {
                                        if (Interlocked.Exchange(ref wave3BudgetTight, 1) == 0) wave3DiscoveredStop.Cancel();
                                        return;
                                    }
                                    completedDiscovered[pair.Key] = 0;
                                });
                        }
                        catch (OperationCanceledException) when (Volatile.Read(ref wave3BudgetTight) == 1 && !stop.IsCancellationRequested)
                        {
                            // Wave 3 budget early-stop: Wave 1, Wave 2 names, and already-read details stay intact.
                        }
                    }
                    if (wave3Wanted > 0) Report(wave3DetailsDone, wave3Wanted, "details", true);
                }

                // Compute NamesOnly across Wave 2/3 plus any retained prior names-only projects that were not cleanly refreshed with details.
                var namesOnly = new HashSet<string>(wave2NamesOnly.Keys, StringComparer.Ordinal);
                foreach (var target in wave3DiscoveredPending.Keys)
                    if (!completedDiscovered.ContainsKey(target)) namesOnly.Add(target.Item1);
                if (priorNamesOnly.Count > 0)
                {
                    var heldNow = state.Index.Databases.Where(read => read.Dataset is not null).Select(read => read.Database).ToHashSet(StringComparer.Ordinal);
                    foreach (var prior in priorNamesOnly)
                    {
                        if (prior == billing || !heldNow.Contains(prior)) continue;
                        var incomplete = projectListedCount.TryGetValue(prior, out var listedCount) && projectCompletedCount.GetValueOrDefault(prior) < listedCount;
                        if (!wave2ListedProjects.ContainsKey(prior) || wave2IncompleteProjects.ContainsKey(prior) || incomplete)
                            namesOnly.Add(prior);
                    }
                }
                var cap = Math.Clamp(Math.Max(maxProjects, priorNamesOnly.Count), BigQueryIndexLimits.MaxProjects, BigQueryIndexLimits.MaxProjectsCap);
                var bounded = namesOnly.Count > 0 ? namesOnly.Order(StringComparer.Ordinal).Take(cap).ToList() : null;
                lock (state.Gate) if (Current()) state.NamesOnly = bounded;
            }

            stop.ThrowIfCancellationRequested();
            lock (state.Gate)
            {
                if (!Current()) throw new OperationCanceledException(stop);
                state.Building = false;
                state.Built = true;
                state.BuiltAt = DateTime.UtcNow;
                state.Phase = null;
            }
            Finish(build: true, watch.ElapsedMilliseconds);
            finishedBuild = true;
            return new(Status(state), watch.ElapsedMilliseconds);
        }
        catch (Exception error) when (error is OperationCanceledException || (stop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" }))
        {
            throw new RequestException("CANCELLED", "The object index build was stopped.");
        }
        finally
        {
            lock (state.Gate)
                if (ReferenceEquals(state.Build, source2)) { state.Build = null; state.Building = false; state.Phase = null; state.InFlightProjects.Clear(); }
            if (!finishedBuild) Ended();
            running.Unregister(args.RequestId, entry);
        }
    }

    /// <summary>Caller holds <c>state.Gate</c>: whether <paramref name="scope"/> is already cleanly covered by the index (no listing/dataset skip, partial cut, or stale mark).</summary>
    private static bool IsScopeCoveredLocked(State state, string billing, BigQueryIndexScope scope)
    {
        var project = scope.Project;
        if (state.StaleProjects.ContainsKey(project)) return false;
        var projectTracked = project == billing
            || state.StarredProjects.Contains(project, StringComparer.Ordinal)
            || state.DiscoveredProjects.Contains(project, StringComparer.Ordinal);
        var projectClean = projectTracked
            && !state.ProjectListingSkips.ContainsKey(project)
            && !state.PartialProjects.Contains(project);
        if (scope.Dataset is { } dataset)
        {
            if (state.Stale.ContainsKey((project, dataset)) || state.DatasetSkips.ContainsKey((project, dataset))) return false;
            return state.Index.Get(project + "\u0001" + dataset) is not null || projectClean;
        }
        return projectClean
            && !state.DatasetSkips.Keys.Any(key => key.Project == project)
            && !state.Stale.Keys.Any(key => key.Project == project);
    }

    /// <summary>Builds and holds a dataset's read; a read past the budget is tried again without columns (CHILDREN_LEFT_OUT), then skipped as TOO_LARGE.</summary>
    private ObjectIndexSkip? Hold(State state, CancellationTokenSource owner, string project, string dataset, IReadOnlyList<BigQueryEntry> entries, bool definitions, CancellationToken token)
    {
        var old = state.Index.Get(project + "\u0001" + dataset);
        var built = new BigQueryReader(Limits, pool, old).Read(project, dataset, entries, true, definitions);
        var childrenLeftOut = false;
        if (built is null)
        {
            built = new BigQueryReader(Limits, pool, old).Read(project, dataset, entries, false, definitions);
            childrenLeftOut = built is not null;
        }
        if (built is not null)
        {
            var superseded = token.IsCancellationRequested;
            if (!superseded)
            {
                lock (state.Gate)
                {
                    if (ReferenceEquals(state.Build, owner)) state.Index.Put(built);
                    else superseded = true;
                }
            }
            if (superseded)
            {
                state.Index.Abandon(built);
                throw new OperationCanceledException(token);
            }
            return childrenLeftOut
                ? new(dataset, ChildrenLeftOut, "The dataset's columns were left out: with them the index would pass its " + Size + " memory limit.", Project: project)
                : null;
        }
        return new(dataset, "TOO_LARGE", old is not null
            ? "The dataset's updated details would take the index past its " + Size + " memory limit; earlier names were kept."
            : "The dataset was not indexed: it would take the index past its " + Size + " memory limit.", Project: project);
    }
}
