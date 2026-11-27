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
        {
            if (!state.BigQuery) return;
            state.Stale[(project, dataset)] = ++state.StaleMarks;
            // What was saved of the dataset is stale from here: its file goes until a build has read it again.
            state.Index.Sink?.Stale(project, dataset);
        }
    }

    /// <summary>Records DDL on a dataset (or, with none, on any dataset of a project) against what is saved for the principal
    /// that ran it: the file goes, and no connection of the principal saves a read of it begun before now, whether or not the
    /// connection that ran the DDL indexes the project (its marks, above, cover only what it indexes).</summary>
    public void MarkSavedStale(string? principal, string project, string? dataset)
    {
        if (!BqNames.IsProject(project) || dataset is not null && !BqNames.IsDataset(dataset) || IndexStoreScope.BigQuery(principal) is not { } scope) return;
        Store.MarkStale(scope, project, dataset);
    }

    /// <summary>Records that DDL may have changed any dataset of a project, which ones unknown (a script whose statements could not
    /// all be read): the next stale-only build lists the project again and reads each of its datasets whole.</summary>
    public void MarkProjectStale(string connectionId, string project)
    {
        if (!BqNames.IsProject(project) || !states.TryGetValue(connectionId, out var state)) return;
        lock (state.Gate)
        {
            if (!state.BigQuery) return;
            state.StaleProjects[project] = ++state.StaleMarks;
            if (state.Index.Sink is { } sink)
                foreach (var read in state.Index.Databases)
                    if (read.Database == project && read.Dataset is { } dataset) sink.Stale(project, dataset);
        }
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
        lock (state.Gate) return state.StaleMark;
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
                state.Index.Sink?.Stale(project, dataset);
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
                new Dictionary<(string Project, string Dataset), ObjectIndexSkip>(state.DatasetSkips), Limits.BigQueryNamesFloorBytes,
                starredProjects: [.. state.StarredProjects]);
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
        // A check of one database, or of every one, is SQL Server's (a BigQuery check reads what its marks name).
        if (args.Database is not null || args.CheckAll is not null) throw Invalid(args.Database is not null ? "database." : "checkAll.");
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
        SetMemoryLimit(args.MemoryLimitMiB);
        var state = states.GetOrAdd(args.ConnectionId, _ => new State(pool, resources));
        // A dataset's file is its verified principal's, whatever project the connection bills.
        state.Index.Sink ??= Store.Sink(IndexStoreScope.BigQuery(source.Principal(args.ConnectionId)));
        // Discovered projects' details keep the most free, so they give way before the billing and starred projects' do. A
        // refresh the user asked of one project or dataset reads it as a starred one, whatever the project.
        bool Discovered(string project) => scope is null && project != billing && !starredSet.Contains(project);
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
        // A stale-only build's due datasets (a search found them older than BigQueryCheckAfter): listed again, reusing what is unchanged.
        List<string> due;
        Dictionary<string, long> wholeProjects;
        List<string> knownProjects;
        List<string> priorNamesOnly;
        List<string> priorPartialProjects;
        // A stale-only build's skips are its targets' (an earlier skip of a dataset or whole project it reads again goes); a scoped one's are the scope's.
        bool InScope(ObjectIndexSkip skip) => scope is not null ? skip.Project == scope.Project && (scope.Dataset is null || skip.Database == scope.Dataset || skip.Database == "")
            : !staleOnly || skip.Project is { } skipProject && (stale.Contains((skipProject, skip.Database)) || wholeProjects.ContainsKey(skipProject));
        // The mark each dataset had when this build began reading it: only that mark is cleared, so DDL that lands mid-read stays marked.
        var seen = new ConcurrentDictionary<(string, string), long>();
        // The store's stale count as each dataset's read began: DDL from another connection of the principal counts too.
        var storeSeen = new ConcurrentDictionary<(string, string), long>();
        bool Current() => ReferenceEquals(state.Build, source2);
        var skipOrder = 0;
        const int CarriedSkipOffset = 1_000_000;
        lock (state.Gate)
        {
            stale = [.. state.Stale.Keys];
            due = staleOnly ? [.. state.Due.Keys] : [];
            wholeProjects = new Dictionary<string, long>(state.StaleProjects, StringComparer.Ordinal);
            priorNamesOnly = state.NamesOnly is { Count: > 0 } prior ? [.. prior] : [];
            priorPartialProjects = state.PartialProjects.Count > 0 ? [.. state.PartialProjects] : [];
            try { state.Build?.Cancel(); } catch (ObjectDisposedException) { }
            state.Build = source2;
            state.Building = true;
            state.Checking = staleOnly;
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
            lock (state.Gate)
            {
                storeSeen[target] = state.Index.Sink?.StaleSeq ?? long.MaxValue;
                return (seen[target] = state.Stale.GetValueOrDefault(target)) != 0;
            }
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
                state.Index.KeepWhere(read => allowed.Contains(read.Database), gone: false);
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
        // The last figures reported (sent or held back by ProgressEvery), so a change in throttling alone can be sent with them.
        var lastDone = 0;
        var lastTotal = 0;
        string? lastPhase = null;
        var sentThrottled = false;
        // Ticks left on which the watcher sends the last change in throttling again (progress EVENTs are droppable).
        var throttleRepeats = 0;
        // 1 while wave 2 is still listing projects' datasets: its names total can still grow.
        var listingProjects = 0;
        void Report(int done, int total, string phase, bool last)
        {
            if (progress is null) return;
            // What of the saved index is still unchecked changes as listings check it: a pass's closing report says it again.
            if (last) lock (state.Gate) SavedAtLocked(state);
            lock (progressGate)
            {
                if (ProgressReplaces(last, phase, lastPhase, done, lastDone)) lastDone = done;
                if (ProgressReplaces(last, phase, lastPhase, total, lastTotal)) lastTotal = total;
                lastPhase = phase;
                if (!last && progressed.Elapsed - reported < ProgressEvery) return;
                SendLocked();
            }
        }
        void SendLocked()
        {
            reported = progressed.Elapsed;
            var throttled = source.Throttled(args.ConnectionId);
            if (throttled != sentThrottled) throttleRepeats = ThrottleRepeats;
            sentThrottled = throttled;
            var growing = lastPhase == "names" && Volatile.Read(ref listingProjects) != 0;
            progress!(new BigQueryIndexProgress(lastDone, Math.Max(lastDone, lastTotal), state.Index.Objects, lastPhase!, growing ? true : null, throttled ? true : null,
                scope is null && !staleOnly ? state.SavedAtText : null, scope is null && !staleOnly ? true : null));
        }
        // BigQuery's rate limit can stall every call at once, so no read finishes to report it: a change in throttling is sent by itself.
        // Progress EVENTs are droppable, so the watcher sends a change again on its next few ticks, in case main missed it.
        using var watchStop = new CancellationTokenSource();
        async Task WatchThrottlingAsync(CancellationToken token)
        {
            try
            {
                using var timer = new PeriodicTimer(ThrottleWatchEvery);
                while (await timer.WaitForNextTickAsync(token))
                    lock (progressGate)
                    {
                        if (lastPhase is null) continue;
                        if (source.Throttled(args.ConnectionId) != sentThrottled) SendLocked();
                        else if (throttleRepeats > 0)
                        {
                            throttleRepeats--;
                            SendLocked();
                        }
                    }
            }
            catch (Exception) { }
        }
        var watcher = progress is null ? Task.CompletedTask : WatchThrottlingAsync(watchStop.Token);
        // The saved units a full build listed before its first call, by project: a listing deletes those it no longer names.
        Dictionary<string, List<SavedUnit>>? savedUnits = null;
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
            var admission = new BigQueryDetailAdmission(BigQueryIndexLimits.DetailObjects);
            // One dataset's pass 2 details: the bulk path's rows where they cover an object, free tables.get and routines.get for the rest.
            async Task<ObjectIndexSkip?> DetailAsync((string Project, string Dataset) target, (List<BigQueryEntry> Listed, int[] Read, bool Cut) value,
                BigQueryBulkDataset? rows, Func<int> tickDone, int wanted, CancellationToken loop, Action? onDetailFailure = null)
            {
                var (project, dataset) = target;
                // The read pass 1 held is of this same listing: each object keeps what that read holds of it, whole or carried,
                // until its own read below replaces it. One whose read fails so keeps the columns it had (still marked carried,
                // so the next build reads it again) instead of giving them back and needing room above the floor to return.
                var reused = BigQueryEntries.Known(state.Index.Get(project + "\u0001" + dataset), definitions, carry: true);
                var entries = value.Listed.Select(item => reused.TryGetValue(BigQueryEntries.Key(item), out var had) ? item with { Detail = had.Detail } : item).ToArray();
                reused.Clear();
                ObjectIndexSkip? failed = null;
                var failures = 0;
                var calls = new List<int>();
                // Only what pass 1 counted: an object whose reused details pass 1 could not keep stays as it was held.
                foreach (var at in value.Read)
                {
                    if (rows is not null && BigQueryBulk.Detail(rows, entries[at], definitions) is { } read)
                    {
                        entries[at] = entries[at] with { Detail = read };
                        Report(tickDone(), wanted, "details", false);
                    }
                    else calls.Add(at);
                }
                // A fixed set of workers per dataset takes the objects in turn, so a dataset of 100,000 tables parks at most
                // Details tasks, not one per object; datasets are admitted by how many objects they read, so the details read but
                // not yet held (outside the budget) stay bounded however many datasets pass 2 runs at once.
                using var admitted = calls.Count > 0 ? await admission.EnterAsync(calls.Count, loop) : null;
                var taken = -1;
                var workers = Enumerable.Range(0, Math.Min(BigQueryIndexLimits.Details, calls.Count)).Select(_ => Task.Run(async () =>
                {
                    for (var next = Interlocked.Increment(ref taken); next < calls.Count; next = Interlocked.Increment(ref taken))
                    {
                        var index = calls[next];
                        var item = entries[index];
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
                            // An object dropped since the listing keeps its name alone; any other failure is counted for the dataset's skip.
                            var skip = SkipOf(error, project, dataset, item.Kind == "bqRoutine" ? "bigquery.routines.get" : "bigquery.tables.get");
                            if (skip.Code == "NOT_FOUND") entries[index] = item with { Detail = null };
                            else
                            {
                                // What was carried from an earlier generation of the object is not kept as if it were this one's.
                                if (item.Detail is { Stale: true }) entries[index] = item with { Detail = null };
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
                    }
                }, loop)).ToArray();
                await Task.WhenAll(workers);
                loop.ThrowIfCancellationRequested();
                var held = Hold(state, source2, project, dataset, entries, definitions, Discovered(project), loop, new(value.Cut, 0, Volatile.Read(ref failures), seen.GetValueOrDefault(target),
                    storeSeen.GetValueOrDefault(target, long.MaxValue), BigQueryEntries.ListingDigest(value.Listed, value.Cut)), details: value.Read);
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
                // Details left out for memory are not read by reading the dataset again: its stale mark is spent, as when its
                // columns were left out.
                else if (held is null or { Code: ChildrenLeftOut } or { Details: true } && !value.Cut) Clear(target);
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
                                state.Index.KeepWhere(read => !(read.Database == project && read.Dataset == dataset), gone: true);
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
                    NamesHeld?.Invoke(project, dataset);
                    var failedDone = tickDone();
                    Report(failedDone, Math.Max(failedDone, total()), "names", false);
                    return;
                }
                catch (Exception error) when (loop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                {
                    throw new OperationCanceledException(loop);
                }
                var key = project + "\u0001" + dataset;
                var earlier = state.Index.Get(key);
                // DDL from another connection of the principal marks only the store: a held read it postdates is read whole.
                var force = (scope is not null && !missingOnly) || marked || stale.Contains(target)
                    || earlier is not null && state.Index.Sink?.Scope is { } sinkScope && Store.MarkedSince(sinkScope, earlier);
                var carried = BigQueryEntries.Known(earlier, definitions, carry: true);
                var listed = BigQueryEntries.FromListing(listing);
                // What pass 2 reads: every object with details that this build may not reuse: one the earlier read did not read
                // whole, one created again or changed since, and all of them when the read is forced.
                static bool Same((long Created, long? Modified, BigQueryDetail Detail) had, BigQueryEntry item) =>
                    had.Created == item.Created && (item.Modified is null || item.Modified == had.Modified);
                bool Reused(BigQueryEntry item) => !force && carried.TryGetValue(BigQueryEntries.Key(item), out var had) && !had.Detail.Carried && Same(had, item);
                var again = listed.Select(item => BigQueryEntries.HasDetails(item) && !Reused(item)).ToArray();
                var digest = BigQueryEntries.ListingDigest(listed, listing.Cut);
                // The listing is the one the held read (loaded from its file, or read before) was made from, and it has nothing
                // left to read: it stays as it is, and its file is only marked used rather than written again.
                if (!force && !again.Any(read => read) && Unchanged(state, source2, project, dataset, earlier, digest, definitions))
                {
                    carried.Clear();
                    loop.ThrowIfCancellationRequested();
                    NamesHeld?.Invoke(project, dataset);
                    lock (state.Gate)
                        if (Current())
                        {
                            state.Indexed++;
                            CheckedLocked(state, key);
                        }
                    ObjectIndexSkip? cutSkip = null;
                    if (listing.Cut)
                    {
                        cutSkip = new ObjectIndexSkip(dataset, "TOO_LARGE", "The dataset has more objects than the index lists; it keeps the first ones.", Project: project);
                        Skip(cutSkip);
                        onIncomplete?.Invoke(project);
                    }
                    SetDatasetSkip(project, dataset, cutSkip);
                    if (!listing.Cut) Clear(target);
                    onDone?.Invoke(target);
                    onAttempted?.Invoke(target);
                    var unchangedDone = tickDone();
                    Report(unchangedDone, Math.Max(unchangedDone, total()), "names", false);
                    return;
                }
                // Pass 1 still holds what the earlier read had of those objects, by name, until pass 2 has read them again: a
                // dataset whose columns fitted keeps their memory between the passes, rather than give it back and ask for it
                // again above BigQuery's floor, where it would be refused once anything else has taken memory since. They are
                // marked carried, so a build stopped or a read that fails before pass 2 lands leaves nothing a later build reuses,
                // and stale when the object was created or changed since, so they are dropped rather than kept if pass 2 cannot
                // replace them. A date-sharded group is carried by its prefix, and is never stale: every new shard renames its
                // entry and gives it a new creation time, and it is the same table for all that.
                var entries = listed.Select((item, at) => !carried.TryGetValue(BigQueryEntries.Key(item), out var had) ? item
                    : item with { Detail = again[at] ? had.Detail with { Carried = true, Stale = had.Detail.Stale || item.Shards is null && !Same(had, item) } : had.Detail }).ToList();
                carried.Clear();
                // A superseded build writes nothing more: the newer one has reset the counters and skips.
                loop.ThrowIfCancellationRequested();
                var held = Hold(state, source2, project, dataset, entries, definitions, Discovered(project), loop, new(listing.Cut, again.Count(read => read), 0, seen.GetValueOrDefault(target),
                    storeSeen.GetValueOrDefault(target, long.MaxValue), digest));
                NamesHeld?.Invoke(project, dataset);
                if (held is { Code: not ChildrenLeftOut })
                {
                    onIncomplete?.Invoke(project);
                    // A dataset with no read at all that does not fit ends the wave for new datasets: they would not fit either.
                    // One that was read before keeps that read, and the wave goes on for those: the next may have nothing new.
                    if (onTooLarge is not null && held.Code == "TOO_LARGE" && earlier is null) onTooLarge();
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
                    int[] read = held is null ? [.. Enumerable.Range(0, entries.Count).Where(at => again[at])] : [];
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
                var heldGone = new HashSet<string>(StringComparer.Ordinal);
                lock (state.Gate)
                {
                    if (!Current()) throw new OperationCanceledException(stop);
                    // Saved datasets held as the listing lands: dropping the read deletes the file, so the prune below leaves them.
                    if (!cut && onlyDataset is null && savedUnits is not null)
                        lock (savedUnits)
                            if (savedUnits.TryGetValue(project, out var units))
                                foreach (var unit in units)
                                    if (!names.Contains(unit.Dataset!) && state.Index.Get(project + "\u0001" + unit.Dataset) is not null) heldGone.Add(unit.Dataset!);
                    state.Index.KeepWhere(read => read.Database != project || read.Dataset is not { } dataset || names.Contains(dataset) || cut
                        || onlyDataset is { } kept && kept != dataset, gone: true);
                    if (!cut)
                    {
                        foreach (var gone in state.DatasetSkips.Keys.Where(key => key.Project == project && !names.Contains(key.Dataset)
                            && (onlyDataset is null || onlyDataset == key.Dataset)).ToList())
                            state.DatasetSkips.Remove(gone);
                    }
                    if (names.Count == 0) PruneEmptyProjectLocked(project, beforeListing);
                }
                if (!cut && onlyDataset is null && savedUnits is not null)
                    lock (savedUnits) PruneSaved(state, savedUnits, project, names, heldGone);
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
                    // Due by age: listed again like any dataset a build reads, so only what was created or changed since costs a get.
                    var listedTargets = targets.ToHashSet();
                    foreach (var key in due.Order(StringComparer.Ordinal))
                    {
                        var cut = key.IndexOf('\u0001', StringComparison.Ordinal);
                        if (cut <= 0) continue;
                        var target = (key[..cut], key[(cut + 1)..]);
                        if (allowedStale.Contains(target.Item1) && !wholeProjects.ContainsKey(target.Item1) && listedTargets.Add(target)) targets.Add(target);
                    }
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

                // What the principal saved is searchable before any call; the waves below check it.
                savedUnits = await Task.Run(() => LoadSaved(state, source2, billing, starredSet, allProjects, stop), stop);
                if (state.SavedAtText is not null) Report(0, 0, "names", true);

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
                        state.Index.KeepWhere(read => read.Database != project, gone: false);
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
                    Volatile.Write(ref listingProjects, 1);
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
                        finally
                        {
                            if (discovered.Count == 0) Volatile.Write(ref listingProjects, 0);
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
                    // Cancelled when a new dataset does not fit: the reads in flight of other new datasets end at once, while
                    // datasets the index already holds go on being read.
                    using var wave2NewStop = CancellationTokenSource.CreateLinkedTokenSource(wave2DiscoveredStop.Token);
                    var discoveredChannel = Channel.CreateBounded<(string Project, string Dataset)>(new BoundedChannelOptions(BigQueryIndexLimits.Datasets * 4));
                    var discoveredProducer = Task.Run(async () =>
                    {
                        try
                        {
                            await Parallel.ForEachAsync(discovered,
                                new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Projects, CancellationToken = wave2DiscoveredStop.Token },
                                async (project, loop) =>
                                {
                                    // Once a new dataset has not fit, only projects the index already holds something of are
                                    // listed: what they hold is read again in its own share.
                                    if (Volatile.Read(ref wave2BudgetExhausted) != 0 && !state.Index.Databases.Any(read => read.Dataset is not null && read.Database == project)) return;
                                    var beforeListing = CurrentStaleMark();
                                    BigQueryDatasetList list;
                                    try { list = await source.DatasetsAsync(args.ConnectionId, project, loop); }
                                    catch (Exception error) when (!loop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                                    {
                                        var skip = SkipOf(error, project, "", "bigquery.datasets.get");
                                        // Noise filtering: auto-discovered projects without BigQuery enabled or dataset access are silently skipped.
                                        // A VPC Service Controls refusal is not noise: off the network the project is still the user's, so it
                                        // is a skip that says so and keeps what an earlier build read.
                                        if (skip.Code is "API_DISABLED" or "PERMISSION_DENIED" or "NOT_FOUND" && !skip.Message.StartsWith(BigQueryErrors.PerimeterOpening, StringComparison.Ordinal))
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
                                        if (Volatile.Read(ref wave2BudgetExhausted) != 0 && state.Index.Get(project + "\u0001" + name) is null) continue;
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
                        finally
                        {
                            Volatile.Write(ref listingProjects, 0);
                        }
                    }, wave2DiscoveredStop.Token);
                    var discoveredConsumers = Enumerable.Range(0, BigQueryIndexLimits.Datasets).Select(_ => Task.Run(async () =>
                    {
                        try
                        {
                            await foreach (var target in discoveredChannel.Reader.ReadAllAsync(wave2DiscoveredStop.Token))
                            {
                                // A new dataset did not fit: no other new one is read (it would not fit either), while a dataset
                                // read before still is, in the share of the read it replaces.
                                var isNew = state.Index.Get(target.Project + "\u0001" + target.Dataset) is null;
                                if (isNew && Volatile.Read(ref wave2BudgetExhausted) != 0) continue;
                                try
                                {
                                    await ReadPass1Async(target, wave3DiscoveredPending, () => Interlocked.Increment(ref listedDone), () => Volatile.Read(ref wave2Total),
                                        isNew ? wave2NewStop.Token : wave2DiscoveredStop.Token,
                                        onTooLarge: () =>
                                        {
                                            if (Interlocked.Exchange(ref wave2BudgetExhausted, 1) != 0) return;
                                            Skip(new("", "TOO_LARGE", "Indexing stopped early for auto-discovered projects: " + BigQueryPart + ", and the rest is in use.", Project: ""));
                                            wave2NewStop.Cancel();
                                            NamesStopped?.Invoke();
                                        },
                                        onChildrenLeftOut: project => wave2NamesOnly[project] = 0,
                                        onIncomplete: project => wave2IncompleteProjects[project] = 0,
                                        onDone: doneTarget => projectCompletedCount.AddOrUpdate(doneTarget.Item1, 1, (_, count) => count + 1),
                                        onAttempted: attemptedTarget => projectAttemptedCount.AddOrUpdate(attemptedTarget.Item1, 1, (_, count) => count + 1));
                                }
                                catch (OperationCanceledException) when (isNew && wave2NewStop.IsCancellationRequested && !wave2DiscoveredStop.IsCancellationRequested)
                                {
                                    // Its read was cut off by the stop for new datasets alone: the pass goes on.
                                }
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
                Volatile.Write(ref listingProjects, 0);
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
                    // Datasets that already hold details first, whatever is free: what they held is charged to the share of the
                    // read it replaces, so reading their changed objects again costs only what has grown, and without it their
                    // carried details would stay as the earlier build left them.
                    var wave3Holding = wave3DiscoveredPending.Where(pair => state.Index.Get(pair.Key.Item1 + "\u0001" + pair.Key.Item2) is { Detailed: true })
                        .OrderBy(pair => pair.Key.Item1, StringComparer.Ordinal).ThenBy(pair => pair.Key.Item2, StringComparer.Ordinal).ToList();
                    var wave3HoldingKeys = wave3Holding.Select(pair => pair.Key).ToHashSet();
                    if (wave3Holding.Count > 0)
                    {
                        await Parallel.ForEachAsync(wave3Holding, new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = stop },
                            async (pair, loop) =>
                            {
                                // Whatever the outcome (its skip says), the dataset holds details: its project is not one read by
                                // name only.
                                await DetailAsync(pair.Key, pair.Value, null, () => Interlocked.Increment(ref wave3DetailsDone), wave3Wanted, loop,
                                    onDetailFailure: () => wave2IncompleteProjects[pair.Key.Item1] = 0);
                                completedDiscovered[pair.Key] = 0;
                            });
                    }
                    var wave3Fresh = wave3DiscoveredPending.Where(pair => !wave3HoldingKeys.Contains(pair.Key)).ToList();
                    if (wave3Fresh.Count > 0 && wave3BudgetTight == 0)
                    {
                        var reserveFloor = Limits.BigQueryDiscoveredFloorBytes;
                        using var wave3DiscoveredStop = CancellationTokenSource.CreateLinkedTokenSource(stop);
                        try
                        {
                            await Parallel.ForEachAsync(wave3Fresh.OrderBy(pair => pair.Key.Item1, StringComparer.Ordinal).ThenBy(pair => pair.Key.Item2, StringComparer.Ordinal),
                                new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = wave3DiscoveredStop.Token },
                                async (pair, loop) =>
                                {
                                    if (Volatile.Read(ref wave3BudgetTight) != 0) return;
                                    if (reserveFloor > 0 && budget.Free < reserveFloor)
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
                state.Checking = false;
                state.Built = true;
                // Only a full build reads everything; a refresh re-reads a part and leaves a stopped build's gaps as they were.
                if (scope is null && !staleOnly) state.Stopped = false;
                state.BuiltAt = DateTime.UtcNow;
                state.Phase = null;
                PruneLocked(state);
            }
            // In-place changes no listing sees are caught by a slow background re-read, from the first full build on.
            if (scope is null && !staleOnly)
            {
                BeforeSweep?.Invoke();
                StartSweep(args.ConnectionId, state, source);
            }
            Finish(build: true, watch.ElapsedMilliseconds);
            finishedBuild = true;
            return new(Status(state), watch.ElapsedMilliseconds);
        }
        catch (Exception error) when (error is OperationCanceledException || (stop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" }))
        {
            // A full build stopped, not superseded: what it read stays, and the status says the index is partial until one finishes.
            if (scope is null && !staleOnly) lock (state.Gate) if (Current()) state.Stopped = true;
            throw new RequestException("CANCELLED", "The object index build was stopped.");
        }
        finally
        {
            watchStop.Cancel();
            await watcher;
            lock (state.Gate)
                if (ReferenceEquals(state.Build, source2)) { state.Build = null; state.Building = false; state.Checking = false; state.Phase = null; state.InFlightProjects.Clear(); }
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

    /// <summary>Builds and holds a dataset's read. A read past BigQuery's part of the budget (its names floor, and its details floor,
    /// the higher one for a <paramref name="discovered"/> project, each a step lower for a dataset that already holds details)
    /// never swaps a dataset that holds details for one without them. In pass 1, where what does not fit is a name, the dataset
    /// is left as it was read before (TOO_LARGE). In pass 2 (<paramref name="details"/>, the objects pass 2 read) objects go back to what the dataset
    /// held of them, in this order until the read fits: the new ones (to their names); those whose details grew; the one a
    /// read ran out of room at (a text the pool did not hold), a few times; then all. What was left out is reported as
    /// details missing (TOO_LARGE with Details). A dataset that holds no details is tried without columns
    /// (CHILDREN_LEFT_OUT), then skipped as TOO_LARGE.</summary>
    /// <param name="saved">What the dataset's file is to say beside the read (<see cref="BigQuerySync"/>), and the stale mark the
    /// dataset had when this read of it began: a mark made since means DDL the read may predate, so no file stands for it.</param>
    private ObjectIndexSkip? Hold(State state, CancellationTokenSource owner, string project, string dataset, IReadOnlyList<BigQueryEntry> entries, bool definitions, bool discovered,
        CancellationToken token, BigQuerySaved saved, IReadOnlyList<int>? details = null)
    {
        var old = state.Index.Get(project + "\u0001" + dataset);
        var (namesFloor, detailsFloor) = (Limits.BigQueryNamesFloorBytes, Limits.BigQueryDetailsFloor(discovered, old is { Detailed: true }));
        var reader = new BigQueryReader(Limits, pool, old, namesFloor, detailsFloor);
        var built = reader.Read(project, dataset, entries, true, definitions);
        var childrenLeftOut = false;
        var detailsLeftOut = 0;
        if (built is null && old is { Detailed: true })
        {
            // In pass 1 what does not fit is the names of what is new: the dataset stays as it was until there is room, rather
            // than lose its columns to list a new object.
            if (details is null)
                return new(dataset, "TOO_LARGE", "The dataset's changes did not fit, so it was kept as it was read before: " + BigQueryPart + ", and the rest is in use.", Project: project);
            // What pass 1's read of this listing holds of each object, and what of that is still the object's own: details
            // carried from an object created or changed since are, only when what pass 2 read has the same shape (and is
            // then what is kept). Which object a read runs out of room at says little, since the replaced read's share is
            // spent in listing order: an object that grew takes what a later one needs. So objects go back by what changed.
            var own = BigQueryEntries.Known(old, definitions, carry: true);
            BigQueryDetail? Carried(BigQueryEntry entry) => own.TryGetValue(BigQueryEntries.Key(entry), out var had) ? had.Detail : null;
            BigQueryDetail? Had(BigQueryEntry entry) => Carried(entry) is not { } carried ? null : !carried.Stale ? carried
                : entry.Detail is { } fresh && BigQueryReader.SameShape(fresh, carried) ? fresh : null;
            var attempt = entries.ToArray();
            var back = new bool[attempt.Length];
            var changed = false;
            void Back(int at)
            {
                attempt[at] = entries[at] with { Detail = Had(entries[at]) };
                back[at] = changed = true;
            }
            bool Fits()
            {
                if (!changed) return false;
                token.ThrowIfCancellationRequested();
                changed = false;
                reader = new BigQueryReader(Limits, pool, old, namesFloor, detailsFloor);
                built = reader.Read(project, dataset, attempt, true, definitions);
                return built is not null;
            }
            // New objects first: all their details are new memory.
            for (var at = 0; at < attempt.Length; at++)
                if (entries[at].Detail is not null && Carried(entries[at]) is null) Back(at);
            if (!Fits())
            {
                // Then every object whose details grew; one no larger than what was held of it stays as pass 2 read it.
                for (var at = 0; at < attempt.Length; at++)
                    if (!back[at] && entries[at].Detail is { } fresh && Carried(entries[at]) is { } carried && BigQueryReader.Weight(fresh) > BigQueryReader.Weight(carried)) Back(at);
                Fits();
            }
            // What is left to refuse is a text the pool does not hold (a column renamed in place), at the object it belongs to.
            for (var tries = 0; built is null && tries < HoldRetries; tries++)
            {
                var at = reader.FailedAt;
                if (at < 0 || back[at] || entries[at].Detail is null) break;
                Back(at);
                Fits();
            }
            if (built is null)
            {
                for (var at = 0; at < attempt.Length; at++)
                    if (!back[at] && entries[at].Detail is not null) Back(at);
                Fits();
            }
            // Not even what was held (it always fits its share, short of a fault): pass 1's read stays, its details missing.
            if (built is null) return DetailsLeftOut(project, dataset, -1);
            // Only what pass 2 read counts: an object it did not read went back to an equal copy of what was held.
            detailsLeftOut = details.Count(at => !ReferenceEquals(attempt[at].Detail, entries[at].Detail));
        }
        if (built is null)
        {
            built = new BigQueryReader(Limits, pool, old, namesFloor, detailsFloor).Read(project, dataset, entries, false, definitions);
            childrenLeftOut = built is not null;
        }
        if (built is not null)
        {
            var superseded = token.IsCancellationRequested;
            if (!superseded)
            {
                lock (state.Gate)
                {
                    if (ReferenceEquals(state.Build, owner))
                    {
                        built.SaveWhenHeld = !(state.Stale.TryGetValue((project, dataset), out var mark) && mark != saved.Seen) && !state.StaleProjects.ContainsKey(project);
                        built.StaleSeen = saved.StoreSeen;
                        // A read that fit only without columns has no details left to read: they would not fit either.
                        built.Sync = new BigQuerySync(saved.Cut, childrenLeftOut ? 0 : saved.Pending, saved.Failed, detailsLeftOut, saved.Listing).ToBytes();
                        state.Index.Put(built);
                        CheckedLocked(state, built.Key);
                        // A loaded read it replaces has been checked.
                        if (state.Saved.Remove(built.Database + "\u0001" + built.Dataset, out var replaced))
                        {
                            state.SavedOrder.Remove((replaced.Ticks, built.Database + "\u0001" + built.Dataset));
                            SavedAtLocked(state);
                        }
                    }
                    else superseded = true;
                }
            }
            if (superseded)
            {
                state.Index.Abandon(built);
                throw new OperationCanceledException(token);
            }
            return childrenLeftOut
                ? new(dataset, ChildrenLeftOut, "The dataset's columns were left out: " + BigQueryPart + ", and the rest does not hold them.", Project: project)
                : detailsLeftOut != 0 ? DetailsLeftOut(project, dataset, detailsLeftOut)
                : null;
        }
        return new(dataset, "TOO_LARGE", old is not null
            ? "The dataset's changes did not fit, so its earlier names were kept: " + BigQueryPart + ", and the rest is in use."
            : "The dataset was not indexed: " + BigQueryPart + ", and the rest is in use.", Project: project);
    }

    /// <summary>What <see cref="Hold"/> is told for the dataset's file: whether the listing was cut, how many objects pass 2 has
    /// yet to read, how many it could not, the dataset's stale mark as this read of it began, and the listing's digest.</summary>
    private readonly record struct BigQuerySaved(bool Cut, int Pending, int Failed, long Seen, long StoreSeen = long.MaxValue, string? Listing = null);

    /// <summary>How many times pass 2 sends the object a dataset's read ran out of room at back to what was held and reads again,
    /// before every object goes back: each is a read of the whole dataset.</summary>
    internal const int HoldRetries = 16;

    /// <summary>The skip of a dataset held with its names as listed and the details it held, the details pass 2 read of
    /// <paramref name="count"/> objects (-1: of every changed object) left out for memory.</summary>
    private ObjectIndexSkip DetailsLeftOut(string project, string dataset, int count) => new(dataset, "TOO_LARGE",
        "The details of " + (count < 0 ? "the dataset's new and changed objects" : count == 1 ? "1 object" : count.ToString("N0", CultureInfo.InvariantCulture) + " objects")
        + " were left out: " + BigQueryPart + ", and the rest does not hold them.", Project: project, Details: true);

    /// <summary>Why a BigQuery read was refused with memory still free: true whatever BigQuery itself holds, since SQL Server's
    /// use counts against the same limit. The renderer and the lookup know a memory skip by the words "memory limit".</summary>
    private string BigQueryPart => "BigQuery leaves part of the index's " + Size + " memory limit to SQL Server";
}
