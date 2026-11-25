using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
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

    /// <summary>The editor's lookup into a BigQuery connection's index (<see cref="BigQueryLookup"/>): a snapshot of its build's state
    /// and the reads held now. A connection with no index yet still answers its billing project.</summary>
    internal BigQueryLookup LookupBigQuery(string connectionId, string billing)
    {
        if (!states.TryGetValue(connectionId, out var state) || !state.BigQuery) return new(billing, [], [], null, [], false, false, budget, Changed);
        lock (state.Gate)
        {
            var databases = state.Index.Databases;
            List<string> others =
            [
                .. state.StarredProjects,
                .. state.DiscoveredProjects,
                .. databases.Where(read => read.Dataset is not null).Select(read => read.Database).Order(StringComparer.Ordinal)
            ];
            return new(billing, others, databases, state.NamesOnly, state.Skipped.ToList(), state.Building, state.Built, budget, Changed);
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

    public async Task<ObjectIndexResult> IndexBigQueryAsync(ObjectIndexArgs args, IBigQueryIndexSource source, CancellationToken token, Action<object>? progress = null)
    {
        var watch = Stopwatch.StartNew();
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(args.RequestId, out _)) throw Invalid("requestId.");
        if (args.StarredProjects is { } rawStarred && (rawStarred.Count > BigQueryIndexLimits.StarredProjects || rawStarred.Any(project => !BqNames.IsProject(project))))
            throw Invalid("starredProjects.");
        var billing = source.BillingProject(args.ConnectionId);
        var allProjects = args.AllProjects ?? true;
        var starred = (args.StarredProjects ?? []).Where(project => project != billing).Distinct(StringComparer.Ordinal).ToList();
        var starredSet = starred.ToHashSet(StringComparer.Ordinal);
        var scope = args.Scope;
        var staleOnly = args.Stale == true;
        if (scope is not null && (!BqNames.IsProject(scope.Project) || scope.Dataset is { } only && !BqNames.IsDataset(only))) throw Invalid("scope.");
        if (scope is not null && staleOnly) throw Invalid("stale.");
        // The billed bulk path reads only what the estimate covered: billing and starred projects, never auto-discovered ones.
        var bulkProjects = new HashSet<string>(StringComparer.Ordinal) { billing };
        foreach (var project in starred) bulkProjects.Add(project);
        var bulk = args.Bulk;
        if (bulk is not null && (scope is not null || staleOnly || bulk.Locations is not { Count: > 0 and <= BigQueryBulkSql.MaxLocations }
            || bulk.Locations.Any(item => item is null || !bulkProjects.Contains(item.Project) || !BqNames.IsLocation(item.Location))
            || bulk.MaximumBytesBilled is < 1 or > BigQueryLimits.MaxSafeInteger || bulk.BudgetBytes is not (>= 1 and <= BigQueryLimits.MaxSafeInteger))) throw Invalid("bulk.");
        var definitions = args.Definitions ?? true;
        var state = states.GetOrAdd(args.ConnectionId, _ => new State(pool, resources));
        using var source2 = CancellationTokenSource.CreateLinkedTokenSource(token);
        var entry = running.Register(args.RequestId, args.ConnectionId, source2);
        var stop = source2.Token;
        var finishedBuild = false;
        HashSet<(string Project, string Dataset)> stale;
        List<string> knownProjects;
        // A stale-only build's skips are its targets' (an earlier skip of a dataset it reads again goes); a scoped one's are the scope's.
        bool InScope(ObjectIndexSkip skip) => scope is not null ? skip.Project == scope.Project && (scope.Dataset is null || skip.Database == scope.Dataset || skip.Database == "")
            : !staleOnly || skip.Project is { } skipProject && stale.Contains((skipProject, skip.Database));
        // The mark each dataset had when this build began reading it: only that mark is cleared, so DDL that lands mid-read stays marked.
        var seen = new ConcurrentDictionary<(string, string), long>();
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
                state.Bulk = null;
                state.NamesOnly = null;
                state.StarredProjects = [.. starred];
                if (!allProjects) state.DiscoveredProjects = [];
            }
            knownProjects = [billing, .. state.StarredProjects, .. state.DiscoveredProjects];
            state.Databases = 0;
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
        try
        {
            using var slots = new SemaphoreSlim(BigQueryIndexLimits.Details);
            // One dataset's pass 2 details: the bulk path's rows where they cover an object, free tables.get and routines.get for the rest.
            async Task<ObjectIndexSkip?> DetailAsync((string Project, string Dataset) target, (List<BigQueryEntry> Listed, int[] Read, bool Cut) value,
                BigQueryBulkDataset? rows, Func<int> tickDone, int wanted, CancellationToken loop)
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
                        finally
                        {
                            slots.Release();
                            Report(tickDone(), wanted, "details", false);
                        }
                    }, loop));
                }
                await Task.WhenAll(tasks);
                loop.ThrowIfCancellationRequested();
                var held = Hold(state, project, dataset, entries, definitions);
                if (held is not null) Skip(held);
                if (failed is { } first)
                    Skip(first with { Details = true, Message = failures == 1 ? "The details of 1 object could not be read: " + first.Message : "The details of " + failures.ToString(CultureInfo.InvariantCulture) + " objects could not be read: " + first.Message });
                else if (held is null or { Code: ChildrenLeftOut } && !value.Cut) Clear(target);
                return held;
            }

            async Task ReadPass1Async((string Project, string Dataset) target, ConcurrentDictionary<(string, string), (List<BigQueryEntry> Listed, int[] Read, bool Cut)> pending,
                Func<int> tickDone, int total, CancellationToken loop, Action? onTooLarge = null, Action<string>? onChildrenLeftOut = null)
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
                    Report(tickDone(), total, "names", false);
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
                if (held is { Code: not ChildrenLeftOut })
                {
                    if (onTooLarge is not null && held.Code == "TOO_LARGE") onTooLarge();
                    else Skip(held);
                }
                else
                {
                    lock (state.Gate) state.Indexed++;
                    if (held is not null)
                    {
                        Skip(held);
                        onChildrenLeftOut?.Invoke(project);
                    }
                    if (listing.Cut) Skip(new(dataset, "TOO_LARGE", "The dataset has more objects than the index lists; it keeps the first ones.", Project: project));
                    // A read that fit only without columns reads no details: they would not fit either, and its reused ones are gone.
                    int[] read = held is null
                        ? [.. Enumerable.Range(0, entries.Count).Where(at => entries[at].Detail is null && BigQueryEntries.HasDetails(entries[at]))] : [];
                    if (read.Length > 0) pending[target] = (listed, read, listing.Cut);
                    else if (!listing.Cut) Clear(target);
                }
                Report(tickDone(), total, "names", false);
            }

            if (scope is not null || staleOnly)
            {
                // Scoped refresh (any valid project: billing, starred, discovered, or session) or stale-only refresh.
                var targets = new List<(string Project, string Dataset)>();
                if (staleOnly)
                {
                    var allowedStale = new HashSet<string>(StringComparer.Ordinal) { billing };
                    foreach (var project in starred) allowedStale.Add(project);
                    foreach (var project in knownProjects) allowedStale.Add(project);
                    foreach (var read in state.Index.Databases)
                        if (read.Dataset is not null) allowedStale.Add(read.Database);
                    targets.AddRange(stale.Where(item => allowedStale.Contains(item.Project))
                        .OrderBy(item => item.Project, StringComparer.Ordinal).ThenBy(item => item.Dataset, StringComparer.Ordinal));
                }
                else
                {
                    BigQueryDatasetList? list = null;
                    try { list = await source.DatasetsAsync(args.ConnectionId, scope!.Project, stop); }
                    catch (Exception error) when (!stop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                    {
                        Skip(SkipOf(error, scope!.Project, "", "bigquery.datasets.get"));
                    }
                    if (list is not null)
                    {
                        if (list.Cut) Skip(new("", "TOO_LARGE", "The project has more datasets than the index lists; it keeps the first " + (BigQueryIndexLimits.ListPages * 1000).ToString("N0", CultureInfo.InvariantCulture) + ".", Project: scope!.Project));
                        var listed = scope!.Dataset is { } scoped ? list.Datasets.Where(name => name == scoped).ToList() : list.Datasets;
                        var names = listed.ToHashSet(StringComparer.Ordinal);
                        state.Index.KeepWhere(read => read.Database != scope.Project || read.Dataset is not { } dataset || names.Contains(dataset) || list.Cut
                            || scope.Dataset is { } kept && kept != dataset);
                        targets.AddRange(listed.Select(name => (scope.Project, name)));
                    }
                }
                lock (state.Gate) state.Databases = targets.Count;
                var pending = new ConcurrentDictionary<(string, string), (List<BigQueryEntry> Listed, int[] Read, bool Cut)>();
                Report(0, targets.Count, "names", true);
                var listedDone = 0;
                await Parallel.ForEachAsync(targets, new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = stop },
                    (target, loop) => new ValueTask(ReadPass1Async(target, pending, () => Interlocked.Increment(ref listedDone), targets.Count, loop)));
                Report(listedDone, targets.Count, "names", true);
                lock (state.Gate) state.Phase = "details";
                var wanted = pending.Sum(pair => pair.Value.Read.Length);
                var detailsDone = 0;
                Report(0, wanted, "details", true);
                await Parallel.ForEachAsync(pending.OrderBy(pair => pair.Key.Item1, StringComparer.Ordinal).ThenBy(pair => pair.Key.Item2, StringComparer.Ordinal),
                    new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = stop },
                    async (pair, loop) => { await DetailAsync(pair.Key, pair.Value, null, () => Interlocked.Increment(ref detailsDone), wanted, loop); });
                Report(detailsDone, wanted, "details", true);
            }
            else
            {
                // Full build: 3 prioritized waves.
                var located = new Dictionary<(string, string), string>();
                var bulkBudget = bulk is not null ? new BigQueryBulkBudget(bulk.BudgetBytes!.Value) : null;
                var bulkAsked = new HashSet<(string, string)>();
                var bulkRead = 0;
                var bulkFailed = 0;
                (string Code, string Message)? bulkError = null;
                async Task RunBulkAsync(IEnumerable<BigQueryIndexLocation> locations,
                    ConcurrentDictionary<(string, string), (List<BigQueryEntry> Listed, int[] Read, bool Cut)> pending, Func<int> tickDone, int wanted)
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
                                    await DetailAsync((project, rows.Dataset), value, rows, tickDone, wanted, stop);
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
                    BigQueryDatasetList? list = null;
                    try { list = await source.DatasetsAsync(args.ConnectionId, billing, stop); }
                    catch (Exception error) when (!stop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                    {
                        Skip(SkipOf(error, billing, "", "bigquery.datasets.get"));
                    }
                    if (list is not null)
                    {
                        if (list.Cut) Skip(new("", "TOO_LARGE", "The project has more datasets than the index lists; it keeps the first " + (BigQueryIndexLimits.ListPages * 1000).ToString("N0", CultureInfo.InvariantCulture) + ".", Project: billing));
                        var names = list.Datasets.ToHashSet(StringComparer.Ordinal);
                        state.Index.KeepWhere(read => read.Database != billing || read.Dataset is not { } dataset || names.Contains(dataset) || list.Cut);
                        foreach (var name in list.Datasets)
                        {
                            wave1Targets.Add((billing, name));
                            if (list.Locations?.GetValueOrDefault(name) is { } where) located[(billing, name)] = where;
                        }
                    }
                }
                lock (state.Gate) { state.Phase = "names"; state.Databases = wave1Targets.Count; }
                var wave1Pending = new ConcurrentDictionary<(string, string), (List<BigQueryEntry> Listed, int[] Read, bool Cut)>();
                Report(0, wave1Targets.Count, "names", true);
                var wave1ListedDone = 0;
                await Parallel.ForEachAsync(wave1Targets, new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = stop },
                    (target, loop) => new ValueTask(ReadPass1Async(target, wave1Pending, () => Interlocked.Increment(ref wave1ListedDone), wave1Targets.Count, loop)));
                Report(wave1ListedDone, wave1Targets.Count, "names", true);
                lock (state.Gate) state.Phase = "details";
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
                var discovered = new List<string>();
                var discoverySucceeded = false;
                var discoveryCut = false;
                if (allProjects)
                {
                    lock (state.Gate) state.Phase = "projects";
                    Report(0, 0, "projects", true);
                    try
                    {
                        var discovery = await source.AccessibleProjectsAsync(args.ConnectionId, stop);
                        discoverySucceeded = true;
                        discoveryCut = discovery.Cut;
                        discovered = [.. discovery.Projects.Where(project => project != billing && !starredSet.Contains(project)).Order(StringComparer.Ordinal)];
                        if (discovery.Cut)
                            Skip(new("", "TOO_LARGE", "You have access to more than " + BigQueryIndexLimits.MaxProjects.ToString("N0", CultureInfo.InvariantCulture) + " projects; the index keeps the first " + BigQueryIndexLimits.MaxProjects.ToString("N0", CultureInfo.InvariantCulture) + ".", Project: ""));
                    }
                    catch (Exception error) when (!stop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                    {
                        var skip = SkipOf(error, "", "", "bigquery.projects.list");
                        Skip(new("", skip.Code, skip.Message, Project: ""));
                    }
                }
                lock (state.Gate)
                {
                    state.StarredProjects = [.. starred];
                    if (!allProjects || discoverySucceeded) state.DiscoveredProjects = [.. discovered];
                }
                if (!allProjects || (discoverySucceeded && !discoveryCut))
                {
                    var allowed = new HashSet<string>(StringComparer.Ordinal) { billing };
                    foreach (var project in starred) allowed.Add(project);
                    foreach (var project in discovered) allowed.Add(project);
                    state.Index.KeepWhere(read => allowed.Contains(read.Database));
                }

                List<(string Project, bool Discovered)> wave2Projects = [.. starred.Select(project => (project, false)), .. discovered.Select(project => (project, true))];
                var wave2DatasetResults = new (BigQueryDatasetList? List, ObjectIndexSkip? Skip)[wave2Projects.Count];
                if (wave2Projects.Count > 0)
                {
                    await Parallel.ForEachAsync(Enumerable.Range(0, wave2Projects.Count),
                        new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Projects, CancellationToken = stop },
                        async (index, loop) =>
                        {
                            var (project, isDiscovered) = wave2Projects[index];
                            try
                            {
                                wave2DatasetResults[index] = (await source.DatasetsAsync(args.ConnectionId, project, loop), null);
                            }
                            catch (Exception error) when (!loop.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                            {
                                var skip = SkipOf(error, project, "", "bigquery.datasets.get");
                                // Noise filtering: auto-discovered projects without BigQuery enabled or dataset access are silently skipped.
                                if (!isDiscovered || skip.Code is not ("API_DISABLED" or "PERMISSION_DENIED" or "NOT_FOUND"))
                                    wave2DatasetResults[index] = (null, skip);
                            }
                        });
                }
                var wave2StarredTargets = new List<(string Project, string Dataset)>();
                var wave2DiscoveredTargets = new List<(string Project, string Dataset)>();
                for (var index = 0; index < wave2Projects.Count; index++)
                {
                    var (project, isDiscovered) = wave2Projects[index];
                    var (list, skip) = wave2DatasetResults[index];
                    if (skip is not null) { Skip(skip); continue; }
                    if (list is null) continue;
                    if (list.Cut) Skip(new("", "TOO_LARGE", "The project has more datasets than the index lists; it keeps the first " + (BigQueryIndexLimits.ListPages * 1000).ToString("N0", CultureInfo.InvariantCulture) + ".", Project: project));
                    var names = list.Datasets.ToHashSet(StringComparer.Ordinal);
                    state.Index.KeepWhere(read => read.Database != project || read.Dataset is not { } dataset || names.Contains(dataset) || list.Cut);
                    var bucket = isDiscovered ? wave2DiscoveredTargets : wave2StarredTargets;
                    foreach (var name in list.Datasets)
                    {
                        bucket.Add((project, name));
                        if (list.Locations?.GetValueOrDefault(name) is { } where) located[(project, name)] = where;
                    }
                }
                var wave2Total = wave1Targets.Count + wave2StarredTargets.Count + wave2DiscoveredTargets.Count;
                lock (state.Gate) { state.Phase = "names"; state.Databases = wave2Total; }
                var wave3StarredPending = new ConcurrentDictionary<(string, string), (List<BigQueryEntry> Listed, int[] Read, bool Cut)>();
                var wave3DiscoveredPending = new ConcurrentDictionary<(string, string), (List<BigQueryEntry> Listed, int[] Read, bool Cut)>();
                var wave2NamesOnly = new ConcurrentDictionary<string, byte>(StringComparer.Ordinal);
                var wave2BudgetExhausted = 0;
                if (wave2StarredTargets.Count + wave2DiscoveredTargets.Count > 0)
                {
                    var listedDone = wave1ListedDone;
                    Report(listedDone, wave2Total, "names", true);
                    if (wave2StarredTargets.Count > 0)
                    {
                        await Parallel.ForEachAsync(wave2StarredTargets, new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = stop },
                            (target, loop) => new ValueTask(ReadPass1Async(target, wave3StarredPending, () => Interlocked.Increment(ref listedDone), wave2Total, loop)));
                    }
                    if (wave2DiscoveredTargets.Count > 0)
                    {
                        using var wave2DiscoveredStop = CancellationTokenSource.CreateLinkedTokenSource(stop);
                        try
                        {
                            await Parallel.ForEachAsync(wave2DiscoveredTargets, new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = wave2DiscoveredStop.Token },
                                (target, loop) => Volatile.Read(ref wave2BudgetExhausted) != 0 ? ValueTask.CompletedTask
                                    : new ValueTask(ReadPass1Async(target, wave3DiscoveredPending, () => Interlocked.Increment(ref listedDone), wave2Total, loop,
                                        onTooLarge: () =>
                                        {
                                            if (Interlocked.Exchange(ref wave2BudgetExhausted, 1) == 0)
                                            {
                                                Skip(new("", "TOO_LARGE", "Indexing stopped early for auto-discovered projects because the index reached its " + Size + " memory limit.", Project: ""));
                                                wave2DiscoveredStop.Cancel();
                                            }
                                        },
                                        onChildrenLeftOut: project => wave2NamesOnly[project] = 0)));
                        }
                        catch (OperationCanceledException) when (Volatile.Read(ref wave2BudgetExhausted) == 1 && !stop.IsCancellationRequested)
                        {
                            // Wave 2 budget early-stop: Wave 1 and already-held Wave 2 datasets stay intact.
                        }
                    }
                    Report(listedDone, wave2Total, "names", true);
                }

                // Wave 3 — Starred, then Discovered projects (Pass 2: Columns + Definitions).
                var wave3Wanted = wave3StarredPending.Sum(pair => pair.Value.Read.Length) + wave3DiscoveredPending.Sum(pair => pair.Value.Read.Length);
                var wave3DetailsDone = 0;
                if (wave3Wanted > 0 || bulk is not null)
                {
                    lock (state.Gate) state.Phase = "details";
                    if (wave3Wanted > 0) Report(0, wave3Wanted, "details", true);
                    if (bulk is not null)
                        await RunBulkAsync(bulk.Locations.Where(item => starredSet.Contains(item.Project)), wave3StarredPending, () => Interlocked.Increment(ref wave3DetailsDone), wave3Wanted);
                    if (!wave3StarredPending.IsEmpty)
                    {
                        await Parallel.ForEachAsync(wave3StarredPending.OrderBy(pair => pair.Key.Item1, StringComparer.Ordinal).ThenBy(pair => pair.Key.Item2, StringComparer.Ordinal),
                            new ParallelOptions { MaxDegreeOfParallelism = BigQueryIndexLimits.Datasets, CancellationToken = stop },
                            async (pair, loop) => { await DetailAsync(pair.Key, pair.Value, null, () => Interlocked.Increment(ref wave3DetailsDone), wave3Wanted, loop); });
                    }
                    var completedDiscovered = new ConcurrentDictionary<(string, string), byte>();
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
                                    var held = await DetailAsync(pair.Key, pair.Value, null, () => Interlocked.Increment(ref wave3DetailsDone), wave3Wanted, loop);
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
                    if (!wave3DiscoveredPending.IsEmpty || !wave2NamesOnly.IsEmpty)
                    {
                        var namesOnly = new HashSet<string>(wave2NamesOnly.Keys, StringComparer.Ordinal);
                        foreach (var target in wave3DiscoveredPending.Keys)
                            if (!completedDiscovered.ContainsKey(target)) namesOnly.Add(target.Item1);
                        if (namesOnly.Count > 0)
                        {
                            var bounded = namesOnly.Order(StringComparer.Ordinal).Take(BigQueryIndexLimits.MaxProjects).ToList();
                            lock (state.Gate) if (ReferenceEquals(state.Build, source2)) state.NamesOnly = bounded;
                        }
                    }
                    if (wave3Wanted > 0) Report(wave3DetailsDone, wave3Wanted, "details", true);
                }
                else if (!wave2NamesOnly.IsEmpty)
                {
                    var bounded = wave2NamesOnly.Keys.Order(StringComparer.Ordinal).Take(BigQueryIndexLimits.MaxProjects).ToList();
                    lock (state.Gate) if (ReferenceEquals(state.Build, source2)) state.NamesOnly = bounded;
                }
            }

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
