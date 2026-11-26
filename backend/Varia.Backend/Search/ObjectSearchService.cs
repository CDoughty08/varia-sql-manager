using System.Collections.Concurrent;
using System.Data;
using System.Data.Common;
using System.Diagnostics;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Common;
using Varia.Backend.Explorer;

namespace Varia.Backend.Search;

/// <summary>What the index needs from SqlService: a connection's profile and its own pool (" - Object Search").</summary>
internal interface IObjectSearchHost
{
    /// <summary>Throws NOT_CONNECTED for an unknown connection.</summary>
    ServerProfile Profile(string connectionId);
    /// <summary>An unopened connection from the index's pool: on the server's scope, or in <paramref name="database"/> on Azure
    /// SQL Database, which cannot EXEC across databases.</summary>
    SqlConnection Connection(string connectionId, string? database);
    Task OpenAsync(SqlConnection connection, CancellationToken token);
}

/// <summary>
/// explorer.index and explorer.search: an in-memory index per connection of the objects Object Explorer lists by schema and
/// name (and their module definitions), read two databases at a time (<see cref="ObjectIndexLimits.Total"/>) from constant catalog SQL (<see cref="ObjectSearchSql"/>),
/// and searched in memory. Nothing reaches disk; a disconnect drops the connection's index. A database that cannot be read is
/// skipped as a value, and the index keeps every other one.
/// </summary>
internal sealed partial class ObjectSearchService : IDisposable
{
    private readonly IObjectSearchHost host;
    private readonly ConcurrentDictionary<string, State> states = new(StringComparer.Ordinal);
    private readonly IndexBudget budget;
    private readonly StringPool pool;
    private readonly ResourceCatalog resources;
    private readonly SemaphoreSlim total;
    private readonly RequestRegistry running;
    public const int MaxText = 1000;
    public const int MaxLimit = 1000;
    public const int DefaultLimit = 200;
    public const int MaxSkipped = 256;
    /// <summary>The least time between two explorer.index.progress EVENTs of one build.</summary>
    public static readonly TimeSpan ProgressEvery = TimeSpan.FromMilliseconds(250);
    /// <summary>How often a BigQuery build checks whether its principal's throttling changed, to say so when no read finishes.</summary>
    internal TimeSpan ThrottleWatchEvery { get; set; } = TimeSpan.FromSeconds(1);
    /// <summary>How many more ticks a change in throttling is sent again on, since a dropped progress EVENT is never sent again.</summary>
    internal const int ThrottleRepeats = 2;

    /// <summary>Whether a BigQuery build's progress count (done or total) replaces the last one reported: within a phase a count
    /// only rises, since racing reporters may read it out of order; a new phase or the phase's last report always replaces it.</summary>
    internal static bool ProgressReplaces(bool last, string phase, string? lastPhase, int value, int lastValue) =>
        last || phase != lastPhase || value >= lastValue;
    /// <summary>The most kinds one search may name.</summary>
    public const int MaxKinds = 64;
    public static readonly string[] Kinds = ["table", "view", "procedure", "function", "synonym", "sequence", "trigger", "type", "tableType", "databaseTrigger", "login", "serverRole", "credential", "cryptographicProvider", "audit", "serverAuditSpecification", "backupDevice", "linkedServer", "serverTrigger", "database", "user", "databaseRole", "applicationRole", "schema", "assembly", "asymmetricKey", "certificate", "symmetricKey", "columnMasterKey", "columnEncryptionKey", "databaseAuditSpecification", "externalDataSource", "externalFileFormat", "fullTextCatalog", "fullTextStoplist", "partitionScheme", "partitionFunction", "searchPropertyList", "planGuide", "xmlSchemaCollection", "rule", "default", "securityPolicy", "column", "key", "constraint", "index", "statistic", "parameter", "agentJob", "agentAlert", "agentOperator"];
    /// <summary>The kinds Object Explorer lists that the index leaves out (ObjectSearchSql.Agent says why).</summary>
    public static readonly string[] Unindexed = ["agentProxySubsystem", "agentProxy", "agentErrorLog"];

    /// <summary>The database a skipped resource read is reported as.</summary>
    public const string ResourceDatabase = "mssqlsystemresource";
    /// <summary>The database a skipped (or partly read) server batch is reported as: no database has an empty name.</summary>
    public const string ServerScope = "";
    /// <summary>The code of a database whose objects the index keeps without their columns, indexes, statistics and parameters,
    /// which would have taken it past the objects per connection limit. It still counts as indexed (objectIndexCodes).</summary>
    public const string ChildrenLeftOut = "CHILDREN_LEFT_OUT";

    /// <summary>One connection's index and its build.</summary>
    private sealed class State(StringPool pool, ResourceCatalog resources)
    {
        public readonly object Gate = new();
        public ConnectionIndex Index { get; } = new(pool.Budget, resources, pool);
        public CancellationTokenSource? Build;
        public bool Building;
        public bool Built;
        /// <summary>The last full build was stopped (Stop or a disconnect, not a newer build) before it finished.</summary>
        public bool Stopped;
        public bool Definitions = true;
        public int Databases;
        public int Indexed;
        public SkipList Skipped = new(MaxSkipped);
        public DateTime? BuiltAt;
        /// <summary>What the editor's lookup needs of the builds: each database's last outcome, kept across builds.</summary>
        public readonly LookupLedger Ledger = new();
        /// <summary>A BigQuery connection's index (ObjectSearchService.BigQuery): datasets in place of databases.</summary>
        public bool BigQuery;
        /// <summary>BigQuery's pass while building: projects, names, then details.</summary>
        public string? Phase;
        /// <summary>BigQuery's projects indexed by name only (when memory budget stopped wave 3 early).</summary>
        public List<string>? NamesOnly;
        /// <summary>BigQuery's starred projects from the last full build (under Gate, excluding billing).</summary>
        public List<string> StarredProjects = [];
        /// <summary>BigQuery's auto-discovered projects from the last full build (under Gate, excluding billing and starred).</summary>
        public List<string> DiscoveredProjects = [];
        /// <summary>BigQuery's discovered projects kept with some datasets held after Wave 2 memory early-stop cut remaining datasets (under Gate).</summary>
        public HashSet<string> PartialProjects = new(StringComparer.Ordinal);
        /// <summary>Per-project dataset-listing skips (errors or dataset-list truncation) kept independently of the 256-entry displayed SkipList (under Gate).</summary>
        public Dictionary<string, ObjectIndexSkip> ProjectListingSkips = new(StringComparer.Ordinal);
        /// <summary>Per-dataset read skips (object-listing, detail, or budget failures) kept independently of the 256-entry displayed SkipList (under Gate).</summary>
        public Dictionary<(string Project, string Dataset), ObjectIndexSkip> DatasetSkips = [];
        /// <summary>Projects currently being discovered or listed by an active build, so mid-build DDL marks land before discovery commits (under Gate).</summary>
        public HashSet<string> InFlightProjects = new(StringComparer.Ordinal);
        /// <summary>BigQuery's last full build's bulk path, when it ran.</summary>
        public BigQueryBulkStatus? Bulk;
        /// <summary>BigQuery datasets DDL changed since their last read, by project and dataset (under Gate): the next build re-reads them whole.</summary>
        public readonly Dictionary<(string Project, string Dataset), long> Stale = [];
        /// <summary>Numbers each stale mark (under Gate), so a build clears only the marks it saw before it read the dataset.</summary>
        public long StaleMarks;
        /// <summary>BigQuery projects whose DDL could have touched any dataset (a script whose statements could not all be read, DDL
        /// with no target and no default dataset), by project (under Gate): the next stale-only build lists the project again and
        /// reads every dataset in it whole.</summary>
        public readonly Dictionary<string, long> StaleProjects = new(StringComparer.Ordinal);
        /// <summary>The newest stale mark not yet spent, or null: index status carries it so the renderer asks a stale-only
        /// build once per new mark (never again for a mark a failed read left).</summary>
        public long? StaleMark => Stale.Count + StaleProjects.Count == 0 ? null : Math.Max(Stale.Count == 0 ? 0 : Stale.Values.Max(), StaleProjects.Count == 0 ? 0 : StaleProjects.Values.Max());
    }

    public ObjectSearchService(IObjectSearchHost host, ObjectIndexLimits? limits = null)
    {
        this.host = host;
        Limits = limits ?? new ObjectIndexLimits();
        budget = new IndexBudget(Limits.MemoryBytes);
        pool = new StringPool(budget);
        resources = new ResourceCatalog(pool, Limits.NamesReserveBytes);
        total = new SemaphoreSlim(Limits.Total);
        running = new RequestRegistry(64, "object index");
    }

    public ObjectIndexLimits Limits { get; }
    /// <summary>The memory every connection's index holds (the checks read it).</summary>
    public long MemoryUsed => budget.Used;
    /// <summary>The shared resource sets and their distinct definitions (the checks read it).</summary>
    internal ResourceCatalog Resources => resources;
    /// <summary>The budget every connection's index shares (the checks charge it).</summary>
    internal IndexBudget Budget => budget;
    /// <summary>The names and definitions every connection shares (the checks read it).</summary>
    internal StringPool Pool => pool;
    /// <summary>The last finished build's and search's time, and a count of both that tells the memory report something changed
    /// that the budget's figure does not show.</summary>
    private long lastBuildMs = -1, lastSearchMs = -1, finished, builds, forgets;
    private int detailWalks;
    /// <summary>The set a memory detail walk dedupes texts in, kept between walks (empty in between).</summary>
    private readonly HashSet<object> walkSeen = new(ReferenceEqualityComparer.Instance);
    public long Finished => Interlocked.Read(ref finished);
    /// <summary>Ended builds, finished, stopped or failed, and lookup arrays built (<see cref="Changed"/>): a search changes nothing the
    /// index holds, so the memory report walks again only after one of these (or the budget moves).</summary>
    public long Builds => Interlocked.Read(ref builds);
    /// <summary>Indexes dropped for a disconnect: the memory report walks again at once after one.</summary>
    public long Forgets => Interlocked.Read(ref forgets);
    /// <summary>The slots the walk's set keeps between walks (the checks read it).</summary>
    internal int WalkSetCapacity { get { lock (walkSeen) return walkSeen.EnsureCapacity(0); } }
    /// <summary>How many times the memory detail walked the index (the checks read it).</summary>
    internal int DetailWalks => Volatile.Read(ref detailWalks);

    /// <summary>The last finished build's and search's times, absent before the first.</summary>
    internal (long? Build, long? Search) Times()
    {
        var build = Interlocked.Read(ref lastBuildMs);
        var search = Interlocked.Read(ref lastSearchMs);
        return (build < 0 ? null : build, search < 0 ? null : search);
    }

    /// <summary>What every connection's index holds (<see cref="IndexMemoryReport"/>), for the Memory panel's Nerd metrics: read
    /// only when an explorer.index.memory event goes out, against the <paramref name="used"/> that event carries.</summary>
    internal IndexMemoryDetail MemoryDetail(long? used = null)
    {
        Interlocked.Increment(ref detailWalks);
        var (build, search) = Times();
        lock (walkSeen)
        {
            var detail = IndexMemoryReport.Detail(budget, pool, [.. states.Values.Select(state => state.Index)], resources.Held, build, search, used, walkSeen);
            // The set's arrays, which no budget charges, are kept only while builds walk every few seconds; with none running,
            // walks are rare (a disconnect, a build's end), so it is given back.
            if (!states.Values.Any(state => Volatile.Read(ref state.Building))) walkSeen.TrimExcess();
            return detail;
        }
    }

    /// <summary>A memory detail from an earlier walk brought up to <paramref name="used"/> without walking: the pool's counts and the
    /// times are read afresh, and what the budget gained since the walk shows as reading (a build's reads, not yet walked).</summary>
    internal IndexMemoryDetail Refresh(IndexMemoryDetail walked, long used)
    {
        var (texts, references, _) = pool.Stats;
        var (build, search) = Times();
        return walked with
        {
            Texts = texts, References = references, LastBuildMs = build, LastSearchMs = search,
            ReadingBytes = Math.Max(0, used - walked.RecordBytes - walked.NameBytes - walked.DefinitionBytes),
        };
    }

    /// <summary>Records a finished build's (<paramref name="build"/>) or search's time, which the next memory report carries.</summary>
    internal void Finish(bool build, long ms)
    {
        Interlocked.Exchange(ref build ? ref lastBuildMs : ref lastSearchMs, ms);
        if (build) Ended();
        else Interlocked.Increment(ref finished);
    }

    /// <summary>Records that what the index holds changed beside the budget's figure (lookup arrays built for the editor): the memory
    /// report walks again, so they show with the records rather than as reading.</summary>
    internal void Changed()
    {
        Interlocked.Increment(ref builds);
        Interlocked.Increment(ref finished);
    }

    /// <summary>Records that a build ended: a stopped or failed one keeps no time, but what its reads left is walked again, so no
    /// read shows as still running.</summary>
    internal void Ended()
    {
        // Builds before finished: a report that sees the finish sees the build.
        Interlocked.Increment(ref builds);
        Interlocked.Increment(ref finished);
    }

    public async Task<ObjectIndexResult> IndexAsync(ObjectIndexArgs args, CancellationToken token, Action<object>? progress = null)
    {
        var watch = Stopwatch.StartNew();
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(args.RequestId, out _)) throw Invalid("requestId.");
        var profile = host.Profile(args.ConnectionId);
        var explorer = profile.Explorer(ExplorerCatalog.Current);
        var perDatabase = explorer.Cloud;
        var render = IndexRender(profile);
        var state = states.GetOrAdd(args.ConnectionId, _ => new State(pool, resources));
        using var source = CancellationTokenSource.CreateLinkedTokenSource(token);
        var entry = running.Register(args.RequestId, args.ConnectionId, source);
        var definitions = args.Definitions ?? true;
        var finishedBuild = false;
        lock (state.Gate)
        {
            // A newer build supersedes a running one, which answers CANCELLED and keeps what it read.
            try { state.Build?.Cancel(); } catch (ObjectDisposedException) { }
            state.Build = source;
            state.Building = true;
            state.Definitions = definitions;
            state.Indexed = 0;
            state.Skipped = new(MaxSkipped);
            state.Ledger.Start();
        }
        try
        {
            var names = await ListAsync(args.ConnectionId, source.Token);
            lock (state.Gate)
            {
                state.Databases = names.Count;
                state.Ledger.List(names);
            }
            state.Index.Keep(names.ToHashSet(StringComparer.Ordinal));
            if (await ReadServerAsync(args.ConnectionId, state, !explorer.Cloud, definitions, source.Token) is { } serverSkip)
                lock (state.Gate) state.Skipped.Add(SkipList.Server, serverSkip);
            if (explorer.Agent is { } platform && await ReadAgentAsync(args.ConnectionId, state, Varia.Backend.Agent.AgentCatalog.Current.Offers("alerts", platform), source.Token) is { } agentSkip)
                lock (state.Gate) state.Skipped.Add(SkipList.Agent, agentSkip);
            if (await ReadResourceAsync(args.ConnectionId, profile, state, definitions, source.Token) is { } resourceSkip)
                lock (state.Gate) state.Skipped.Add(SkipList.Resource, resourceSkip);
            await ReadDatabasesAsync(names, Limits.Total, (name, loop) => ReadAsync(args.ConnectionId, state, name, render, definitions, perDatabase, loop), (at, skip) =>
            {
                lock (state.Gate)
                {
                    if (skip is null or { Code: ChildrenLeftOut }) state.Indexed++;
                    if (skip is not null) state.Skipped.Add(at, skip);
                    state.Ledger.Done(names[at], skip);
                }
            }, progress is null ? null : done => progress(new { Type = "explorer.index.progress", Done = done, Total = names.Count, Objects = state.Index.Objects }), source.Token);
            lock (state.Gate)
            {
                if (ReferenceEquals(state.Build, source)) { state.Building = false; state.Built = true; state.Stopped = false; state.BuiltAt = DateTime.UtcNow; }
            }
            Finish(build: true, watch.ElapsedMilliseconds);
            finishedBuild = true;
            return new(Status(state), watch.ElapsedMilliseconds);
        }
        catch (Exception error) when (error is OperationCanceledException || (error is SqlException && source.IsCancellationRequested))
        {
            // Stopped, not superseded: what it read stays, and the status says the index is partial until a build finishes.
            lock (state.Gate) if (ReferenceEquals(state.Build, source)) state.Stopped = true;
            throw new RequestException("CANCELLED", "The object index build was stopped.");
        }
        catch (SqlException error)
        {
            // The database list itself failed: the index keeps what it had, and the build answers as a value.
            lock (state.Gate)
            {
                state.Skipped = new(MaxSkipped);
                state.Skipped.Add(SkipList.Server, new("", "CATALOG_ERROR", ExplorerErrors.From(error, ErrorPhase.Statement, "Databases", null).Message));
            }
            return new(Status(state), watch.ElapsedMilliseconds);
        }
        finally
        {
            lock (state.Gate)
                if (ReferenceEquals(state.Build, source)) { state.Build = null; state.Building = false; }
            if (!finishedBuild) Ended();
            running.Unregister(args.RequestId, entry);
        }
    }

    /// <summary>explorer.indexStatus: the index as it stands, so a window learns what a stopped build kept (its CANCELLED answer
    /// carries no status). <paramref name="bigQuery"/> for a BigQuery handle, whose connection SqlService has already checked.</summary>
    public ObjectIndexResult IndexStatus(ObjectIndexStatusArgs args, bool bigQuery = false)
    {
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (!bigQuery) host.Profile(args.ConnectionId);
        return new(states.TryGetValue(args.ConnectionId, out var state) ? Status(state)
            : new("none", 0, 0, 0, 0, 0, [], true, Provider: bigQuery ? Providers.BigQuery : null, Projects: bigQuery ? 0 : null), 0);
    }

    /// <summary>explorer.search; <paramref name="bigQuery"/> for a BigQuery handle, whose search narrows by Project and Dataset (never
    /// Database) and whose connection SqlService has already checked.</summary>
    public ObjectSearchResult Search(ObjectSearchArgs args, CancellationToken token, bool bigQuery = false)
    {
        var query = Validate(args);
        if (bigQuery ? args.Database is not null : args.Project is not null || args.Dataset is not null) throw Invalid(bigQuery ? "database." : "project.");
        token.ThrowIfCancellationRequested();
        if (!bigQuery) host.Profile(args.ConnectionId);
        if (!states.TryGetValue(args.ConnectionId, out var state)) return new([], 0, false, 0, new("none", 0, 0, 0, 0, 0, [], true, Provider: bigQuery ? Providers.BigQuery : null, Projects: bigQuery ? 0 : null));
        var status = Status(state);
        var (matcher, problem) = SearchMatcher.Create(query.Text, query.CaseSensitive, query.WholeWord, query.Regex, Limits.MatchTimeout);
        if (matcher is null) return new([], 0, false, 0, status, problem);
        try
        {
            var result = IndexSearch.Run(state.Index, query, matcher, Limits, status, token);
            Finish(build: false, result.ElapsedMs);
            return result;
        }
        catch (System.Text.RegularExpressions.RegexMatchTimeoutException) { return new([], 0, true, 0, status, "The regular expression took too long on one definition."); }
    }

    /// <summary>A connection's index, made if it has none (the checks hold reads in it).</summary>
    internal ConnectionIndex Held(string connectionId) => states.GetOrAdd(connectionId, _ => new State(pool, resources)).Index;

    /// <summary>How the index's batches are written for a server: its catalog band, and vector dimensions where it has them.</summary>
    internal static SqlRender IndexRender(ServerProfile profile) => new(profile.Explorer(ExplorerCatalog.Current).Band, profile.VectorDimensions);

    /// <summary>The editor's lookup into a connection's index (<see cref="IndexLookup"/>), or null when it has none: a snapshot of
    /// its build's state and the reads held now.</summary>
    internal IndexLookup? Lookup(string connectionId)
    {
        if (!states.TryGetValue(connectionId, out var state)) return null;
        lock (state.Gate)
            // The editor's lookup reads SQL Server's catalog shape; a BigQuery index answers through LookupBigQuery.
            return state.BigQuery ? null : new IndexLookup(state.Index, budget, state.Building, state.Ledger.Snapshot(), Changed);
    }

    /// <summary>The index a connection holds, or null (the checks read it).</summary>
    internal ConnectionIndex? IndexOf(string connectionId) => states.TryGetValue(connectionId, out var state) ? state.Index : null;

    /// <summary>Stops a disconnected connection's build and drops its index.</summary>
    public void Forget(string connectionId)
    {
        running.Forget(connectionId);
        if (!states.TryRemove(connectionId, out var state)) return;
        state.Index.Dispose();
        // Forgets before finished, as with builds; finished sends a report even when the dropped index freed no byte (a shared set).
        Interlocked.Increment(ref forgets);
        Interlocked.Increment(ref finished);
    }

    public void Dispose()
    {
        running.ForgetAll();
        foreach (var state in states.Values) state.Index.Dispose();
        states.Clear();
    }

    internal static SearchQuery Validate(ObjectSearchArgs args)
    {
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(args.RequestId, out _)) throw Invalid("requestId.");
        if (args.Text is null || args.Text.Length is < 1 or > MaxText || args.Text.Contains('\0')) throw Invalid("text.");
        var scope = args.In ?? "all";
        if (scope is not ("names" or "definitions" or "all")) throw Invalid("in.");
        if (args.Limit is < 1 or > MaxLimit) throw Invalid("limit.");
        if (args.Match is not (null or "exact" or "fuzzy") || (args.Match == "fuzzy" && args.Regex == true)) throw Invalid("match.");
        if (args.Database is { } database && !ExplorerRefs.Ident(database)) throw Invalid("database.");
        if (args.Project is { } project && !Varia.Backend.BigQuery.BqNames.IsProject(project)) throw Invalid("project.");
        if (args.Dataset is { } dataset && (!Varia.Backend.BigQuery.BqNames.IsDataset(dataset) || args.Project is null)) throw Invalid("dataset.");
        HashSet<string>? kinds = null;
        if (args.Kinds is { } list)
        {
            if (list.Count is < 1 or > MaxKinds || list.Any(kind => Array.IndexOf(Kinds, kind) < 0 && Array.IndexOf(BigQueryKinds, kind) < 0)) throw Invalid("kinds.");
            kinds = list.ToHashSet(StringComparer.Ordinal);
        }
        return new(args.Text, args.CaseSensitive ?? false, args.WholeWord ?? false, args.Regex ?? false, scope != "definitions", scope != "names", kinds, args.Database, args.Limit ?? DefaultLimit, args.Match == "fuzzy",
            args.Project, args.Dataset);
    }

    private static RequestException Invalid(string what) => new("INVALID_PARAMS", "Invalid object search request: " + what);

    private ObjectIndexStatus Status(State state)
    {
        var databases = state.Index.Databases;
        lock (state.Gate)
        {
            bool? stopped = !state.Building && state.Stopped ? true : null;
            if (state.BigQuery)
            {
                // Datasets: those this build lists while it runs, else those the index holds and those it skipped.
                var held = databases.Count(value => value.Dataset is not null);
                var projects = databases.Where(value => value.Dataset is not null).Select(value => value.Database).Distinct(StringComparer.Ordinal).Count();
                var skipped = state.Skipped.ToList();
                return new(state.Building ? "building" : state.Built || held > 0 ? "ready" : "none",
                    state.Building ? state.Databases : held + skipped.Count(skip => skip.Database.Length > 0 && skip.Code is not ChildrenLeftOut && !databases.Any(value => value.Database == skip.Project && value.Dataset == skip.Database)),
                    state.Building ? state.Indexed : held, state.Index.Objects, databases.Sum(value => value.Modules), databases.Sum(value => value.Cut), skipped, state.Definitions,
                    state.BuiltAt?.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture), Providers.BigQuery, state.Building ? state.Phase : null, state.NamesOnly is { Count: > 0 } names ? names : null, state.Bulk, projects, state.StaleMark, stopped);
            }
            // A stopped first build that read only the server's own objects still holds an index.
            return new(state.Building ? "building" : state.Built || databases.Count > 0 || state.Index.Objects > 0 ? "ready" : "none", state.Databases, state.Building ? state.Indexed : databases.Count,
                state.Index.Objects, databases.Sum(value => value.Modules) + (state.Index.Resource?.Modules ?? 0) + (state.Index.Server?.Modules ?? 0),
                databases.Sum(value => value.Cut) + (state.Index.Resource?.Cut ?? 0) + (state.Index.Server?.Cut ?? 0), state.Skipped.ToList(), state.Definitions,
                state.BuiltAt?.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture), Stopped: stopped);
        }
    }

    /// <summary>Reads each database, at most <paramref name="degree"/> at once (each read still waits for one of the index's
    /// slots across every connection), hands each read's outcome to <paramref name="completed"/> with its place in the listing,
    /// and reports progress: Done 0 first, then completions, whichever read ends first, one call at a time, at most one per
    /// <see cref="ProgressEvery"/> but always the last. Each read takes the loop's token, so one that fails stops the read
    /// still in flight and its error comes out at once, rather than after that read's own budget.</summary>
    internal static async Task ReadDatabasesAsync(IReadOnlyList<string> names, int degree, Func<string, CancellationToken, Task<ObjectIndexSkip?>> read,
        Action<int, ObjectIndexSkip?> completed, Action<int>? progress, CancellationToken token)
    {
        var last = Stopwatch.StartNew();
        progress?.Invoke(0);
        var done = 0;
        var reported = new object();
        await Parallel.ForEachAsync(Enumerable.Range(0, names.Count), new ParallelOptions { MaxDegreeOfParallelism = Math.Max(1, degree), CancellationToken = token }, async (at, loop) =>
        {
            completed(at, await read(names[at], loop));
            lock (reported)
            {
                done++;
                if (progress is not null && (last.Elapsed >= ProgressEvery || done == names.Count))
                {
                    progress(done);
                    last.Restart();
                }
            }
        });
    }

    /// <summary>Opens a batch's rows and reads them. A read that stops early (past the budget, answering null) cancels the batch
    /// before its reader closes: closing a reader short of its end reads, and throws away, every row and definition left. A
    /// read that completes is handed to <paramref name="keep"/> before the reader closes, so an error on close (a broken
    /// transport, a statement after the last result set) still finds it held by the index, never charged and lost. A read that
    /// throws cancels the batch too, so its error comes out at once rather than after the rest of the batch drained.</summary>
    internal static async Task<T?> ReadThenStopAsync<T>(Func<Task<DbDataReader>> open, Func<DbDataReader, Task<T?>> read, Action cancel, Action<T> keep) where T : class
    {
        var rows = await open();
        T? value;
        try { value = await read(rows); }
        catch
        {
            cancel();
            // The read's own error is the one to report: the cancelled batch's error on close changes nothing.
            try { await rows.DisposeAsync(); } catch (Exception error) when (error is DbException or InvalidOperationException) { }
            throw;
        }
        if (value is not null)
        {
            try { keep(value); }
            finally { await rows.DisposeAsync(); }
            return value;
        }
        cancel();
        // The read already answered TOO_LARGE: the cancelled batch's own error on close changes nothing.
        try { await rows.DisposeAsync(); } catch (Exception error) when (error is DbException or InvalidOperationException) { }
        return null;
    }

    /// <summary>Runs <paramref name="command"/>'s batch with sequential access through <see cref="ReadThenStopAsync"/>, cancelling
    /// it on the server when the read stops early. Every index read goes through here, so the live checks prove on a real server
    /// that a stopped read leaves the rest of its batch unsent.</summary>
    internal static Task<T?> ReadBatchAsync<T>(SqlCommand command, Func<DbDataReader, Task<T?>> read, Action<T> keep, CancellationToken token) where T : class =>
        ReadThenStopAsync(async () => await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, token), read, () => TryCancel(command), keep);

    private static void TryCancel(SqlCommand command)
    {
        try { command.Cancel(); } catch (Exception error) when (error is InvalidOperationException or SqlException) { /* Best effort: the reader then drains. */ }
    }

    private async Task<List<string>> ListAsync(string connectionId, CancellationToken token)
    {
        await using var connection = host.Connection(connectionId, null);
        await host.OpenAsync(connection, token);
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 0;
        command.CommandText = ObjectSearchSql.Prologue + ObjectSearchSql.Databases;
        await using var reader = await command.ExecuteReaderAsync(token);
        var names = new List<string>();
        while (await reader.ReadAsync(token)) names.Add(reader.GetString(0));
        return names;
    }

    /// <summary>Reads one database and swaps it into the index; the reason it could not, as a value. A database too large to keep
    /// with its children is read again without them (<see cref="WithFallbackAsync"/>).</summary>
    private Task<ObjectIndexSkip?> ReadAsync(string connectionId, State state, string database, SqlRender render, bool definitions, bool perDatabase, CancellationToken token) =>
        WithFallbackAsync(database, children => ReadOnceAsync(connectionId, state, database, render, definitions, perDatabase, children, token));

    /// <summary>Runs <paramref name="read"/> with children, and when that is TOO_LARGE once more without them: the database's
    /// tables, procedures and every other object then stay searchable, reported as <see cref="ChildrenLeftOut"/>.</summary>
    internal static async Task<ObjectIndexSkip?> WithFallbackAsync(string database, Func<bool, Task<ObjectIndexSkip?>> read)
    {
        var skip = await read(true);
        if (skip is not { Code: "TOO_LARGE" }) return skip;
        return await read(false) ?? new(database, ChildrenLeftOut,
            "The database's columns, indexes, statistics and parameters were left out: with them it does not fit in the memory the index shares across connections.");
    }

    private async Task<ObjectIndexSkip?> ReadOnceAsync(string connectionId, State state, string database, SqlRender render, bool definitions, bool perDatabase, bool children,
        CancellationToken token)
    {
        using var budgetSource = CancellationTokenSource.CreateLinkedTokenSource(token);
        await total.WaitAsync(token);
        // The budget is the read's own: time spent waiting for a slot behind other reads does not count.
        budgetSource.CancelAfter(Limits.DatabaseBudget);
        var reader = new DatabaseReader(database, Limits, pool, state.Index.Databases.FirstOrDefault(value => value.Database == database));
        var Put = Holding(state.Index, children);
        try
        {
            await using var connection = host.Connection(connectionId, perDatabase ? database : null);
            await host.OpenAsync(connection, budgetSource.Token);
            await using var command = connection.CreateCommand();
            command.CommandTimeout = 0;
            var batch = ObjectSearchSql.Batch(render, definitions, children);
            if (perDatabase) command.CommandText = ObjectSearchSql.Prologue + batch;
            else
            {
                command.CommandText = ObjectSearchSql.Prologue + ObjectSearchSql.ModuleCall;
                command.Parameters.Add(new SqlParameter("@db", SqlDbType.NVarChar, 128) { Value = database });
                command.Parameters.Add(new SqlParameter("@stmt", SqlDbType.NVarChar, -1) { Value = batch });
            }
            var index = await ReadBatchAsync(command,
                rows => reader.ReadAsync(rows, definitions, budgetSource.Token, children), Put, budgetSource.Token);
            if (index is null) return new(database, "TOO_LARGE", "The database does not fit in the index's memory (" + Size + " across every connection).");
            return null;
        }
        catch (Exception error) when (error is OperationCanceledException or SqlException && budgetSource.IsCancellationRequested && !token.IsCancellationRequested)
        {
            reader.Abandon();
            return new(database, "TIMEOUT", "Reading the database's objects took longer than " + Limits.DatabaseBudget.TotalSeconds.ToString(CultureInfo.InvariantCulture) + " seconds.");
        }
        catch (SqlException error) when (!token.IsCancellationRequested)
        {
            // A statement that fails part way (a catalog view this edition lacks) keeps what came before it, unless an earlier build
            // read the database whole.
            KeepPartial(reader, state.Index.Databases.Any(value => value.Database == database), Put);
            var value = ExplorerErrors.From(error, ErrorPhase.Scope, database, database);
            return new(database, value.Code is "NO_DB_ACCESS" or "DATABASE_UNAVAILABLE" ? value.Code : "CATALOG_ERROR", value.Message);
        }
        catch
        {
            reader.Abandon();
            throw;
        }
        finally { total.Release(); }
    }

    /// <summary>Puts a read into <paramref name="index"/>. A read without children is the fallback for a database too large with them
    /// (<see cref="WithFallbackAsync"/>), so the index it holds says so.</summary>
    internal static Action<DatabaseIndex> Holding(ConnectionIndex index, bool children) => read =>
    {
        read.ChildrenLeftOut = !children;
        index.Put(read);
    };

    /// <summary>After a read failed part way: holds what it read when nothing was held before, else keeps the earlier read whole.</summary>
    internal static void KeepPartial(DatabaseReader reader, bool held, Action<DatabaseIndex> put)
    {
        if (!held && reader.Any)
        {
            var partial = reader.Partial();
            partial.FailedPart = true;
            put(partial);
        }
        else reader.Abandon();
    }

    /// <summary>Reads the server's own objects (its databases and, on box editions and Managed Instance, its logins, roles and
    /// other server objects) into the index. The reason it could not, as a value; a read that failed part way keeps what it read
    /// only when no earlier build's objects are held.</summary>
    private async Task<ObjectIndexSkip?> ReadServerAsync(string connectionId, State state, bool box, bool definitions, CancellationToken token)
    {
        using var budgetSource = CancellationTokenSource.CreateLinkedTokenSource(token);
        await total.WaitAsync(token);
        // The budget is the read's own: time spent waiting for a slot behind other reads does not count.
        budgetSource.CancelAfter(Limits.DatabaseBudget);
        var reader = new DatabaseReader(ServerScope, Limits, pool, state.Index.Server);
        try
        {
            await using var connection = host.Connection(connectionId, null);
            await host.OpenAsync(connection, budgetSource.Token);
            await using var command = connection.CreateCommand();
            command.CommandTimeout = 0;
            command.CommandText = ObjectSearchSql.Prologue + ObjectSearchSql.Server(box, definitions);
            var index = await ReadBatchAsync(command,
                rows => reader.ReadServerAsync(rows, box, definitions, Actions.ActionsCatalog.Current.Logins, budgetSource.Token), state.Index.PutServer, budgetSource.Token);
            if (index is null) return new(ServerScope, "TOO_LARGE", "The server's objects do not fit in the index's memory (" + Size + " across every connection).");
            return null;
        }
        catch (Exception error) when (error is OperationCanceledException or SqlException && budgetSource.IsCancellationRequested && !token.IsCancellationRequested)
        {
            reader.Abandon();
            return new(ServerScope, "TIMEOUT", "Reading the server's objects took longer than " + Limits.DatabaseBudget.TotalSeconds.ToString(CultureInfo.InvariantCulture) + " seconds.");
        }
        catch (SqlException error) when (!token.IsCancellationRequested)
        {
            // A catalog view the login may not read fails its statement: what came before it (the databases) stays searchable,
            // unless an earlier build read them all.
            KeepPartial(reader, state.Index.Server is not null, state.Index.PutServer);
            return new(ServerScope, "CATALOG_ERROR", ExplorerErrors.From(error, ErrorPhase.Statement, "Server objects", null).Message);
        }
        catch
        {
            reader.Abandon();
            throw;
        }
        finally { total.Release(); }
    }

    /// <summary>Why SQL Server Agent's objects were left out: reported against msdb, where they are read, and flagged as Agent's so
    /// the index line does not count msdb itself as skipped.</summary>
    internal static ObjectIndexSkip AgentSkip(string code, string message) => new("msdb", code, message, Agent: true);

    /// <summary>Reads SQL Server Agent's objects (<see cref="ObjectSearchSql.Agent"/>) in msdb into the index's Agent slot. The reason
    /// it could not, reported as msdb, as a value: only Agent kinds are then left out.</summary>
    private async Task<ObjectIndexSkip?> ReadAgentAsync(string connectionId, State state, bool alerts, CancellationToken token)
    {
        const string Msdb = "msdb";
        using var budgetSource = CancellationTokenSource.CreateLinkedTokenSource(token);
        await total.WaitAsync(token);
        budgetSource.CancelAfter(Limits.DatabaseBudget);
        var reader = new DatabaseReader(Msdb, Limits, pool, state.Index.Agent);
        try
        {
            await using var connection = host.Connection(connectionId, null);
            await host.OpenAsync(connection, budgetSource.Token);
            await using var command = connection.CreateCommand();
            command.CommandTimeout = 0;
            command.CommandText = ObjectSearchSql.Prologue + ObjectSearchSql.ModuleCall;
            command.Parameters.Add(new SqlParameter("@db", System.Data.SqlDbType.NVarChar, 128) { Value = Msdb });
            command.Parameters.Add(new SqlParameter("@stmt", System.Data.SqlDbType.NVarChar, -1) { Value = ObjectSearchSql.Agent });
            var index = await ReadBatchAsync(command, rows => reader.ReadAgentAsync(rows, alerts, budgetSource.Token), state.Index.PutAgent, budgetSource.Token);
            return index is null ? AgentSkip("TOO_LARGE", "SQL Server Agent's objects do not fit in the index's memory (" + Size + " across every connection).") : null;
        }
        catch (Exception error) when (error is OperationCanceledException or SqlException && budgetSource.IsCancellationRequested && !token.IsCancellationRequested)
        {
            reader.Abandon();
            return AgentSkip("TIMEOUT", "Reading SQL Server Agent's objects took longer than " + Limits.DatabaseBudget.TotalSeconds.ToString(CultureInfo.InvariantCulture) + " seconds.");
        }
        catch (SqlException error) when (!token.IsCancellationRequested)
        {
            KeepPartial(reader, state.Index.Agent is not null, state.Index.PutAgent);
            var value = ExplorerErrors.From(error, ErrorPhase.Scope, "SQL Server Agent", Msdb);
            return AgentSkip(value.Code is "NO_DB_ACCESS" or "DATABASE_UNAVAILABLE" ? value.Code : "CATALOG_ERROR", value.Message);
        }
        catch
        {
            reader.Abandon();
            throw;
        }
        finally { total.Release(); }
    }

    /// <summary>Takes this connection's share of the resource database's objects: the set another connection (or an earlier build)
    /// holds for the same fingerprint, or a new read. The reason it could not, as a value; the set held before stays then.</summary>
    private async Task<ObjectIndexSkip?> ReadResourceAsync(string connectionId, ServerProfile profile, State state, bool definitions, CancellationToken token)
    {
        using var budgetSource = CancellationTokenSource.CreateLinkedTokenSource(token);
        budgetSource.CancelAfter(Limits.DatabaseBudget);
        try
        {
            await using var connection = host.Connection(connectionId, null);
            await host.OpenAsync(connection, budgetSource.Token);
            ResourceKey key;
            await using (var command = connection.CreateCommand())
            {
                command.CommandTimeout = 0;
                command.CommandText = ObjectSearchSql.Prologue + ObjectSearchSql.ResourceFingerprint;
                await using var rows = await command.ExecuteReaderAsync(budgetSource.Token);
                await rows.ReadAsync(budgetSource.Token);
                key = new(profile.ProductVersion ?? profile.Major.ToString(CultureInfo.InvariantCulture), profile.EngineEdition, rows.GetInt64(0),
                    rows.IsDBNull(1) ? null : rows.GetDateTime(1), rows.IsDBNull(2) ? 0 : rows.GetInt32(2), definitions);
            }
            if (state.Index.Resource?.Key == key) return null;
            // The shared read has its own connection and lifetime: other connections may wait for it, so stopping this build (or
            // disconnecting) stops only this wait, and the read ends only when every waiter has gone or its budget runs out.
            var set = await resources.AcquireAsync(key, async readToken =>
            {
                await using var own = host.Connection(connectionId, null);
                await host.OpenAsync(own, readToken);
                await using var command = own.CreateCommand();
                command.CommandTimeout = 0;
                command.CommandText = ObjectSearchSql.Prologue + ObjectSearchSql.ResourceObjects(definitions);
                await using var rows = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, readToken);
                return await DatabaseReader.ReadResourceAsync(rows, definitions, Limits, readToken);
            }, Limits.DatabaseBudget, token);
            state.Index.PutResource(set);
            return null;
        }
        catch (Exception error) when (error is TimeoutException || error is OperationCanceledException or SqlException && budgetSource.IsCancellationRequested && !token.IsCancellationRequested)
        {
            return new(ResourceDatabase, "TIMEOUT", "Reading the system objects took longer than " + Limits.DatabaseBudget.TotalSeconds.ToString(CultureInfo.InvariantCulture) + " seconds.");
        }
        catch (SqlException error) when (!token.IsCancellationRequested)
        {
            return new(ResourceDatabase, "CATALOG_ERROR", ExplorerErrors.From(error, ErrorPhase.Statement, "System objects", null).Message);
        }
    }

    private string Size => (Limits.MemoryBytes / (1024 * 1024)).ToString("N0", CultureInfo.InvariantCulture) + " MiB";
}

/// <summary>A build's skipped list in listing order whatever order its reads end in: the server's and the resource database's
/// entries first, then the databases by their place in the listing, at most <paramref name="capacity"/> of them, the first ones
/// listed, so which databases a status reports never depends on timing. Not thread safe: the state's gate guards it.</summary>
internal sealed class SkipList(int capacity)
{
    public const int Server = -2;
    public const int Resource = -1;
    /// <summary>SQL Server Agent's objects (read after the server's), listed first: a skip orders by this, not by when it was read.</summary>
    public const int Agent = -3;
    private readonly List<(int Order, ObjectIndexSkip Skip)> items = [];
    private int databases;

    /// <summary>Adds <paramref name="skip"/> at <paramref name="order"/> (a database's index in the listing, or <see cref="Server"/>
    /// or <see cref="Resource"/>); past the capacity, the database listed last gives way.</summary>
    public void Add(int order, ObjectIndexSkip skip)
    {
        var at = items.FindLastIndex(item => item.Order <= order) + 1;
        if (order >= 0)
        {
            if (databases >= capacity)
            {
                if (capacity <= 0 || order > items[^1].Order) return;
                items.RemoveAt(items.Count - 1);
            }
            else databases++;
        }
        items.Insert(Math.Min(at, items.Count), (order, skip));
    }

    public List<ObjectIndexSkip> ToList() => [.. items.Select(item => item.Skip)];
}

/// <summary>Reads the server batch (<see cref="ObjectSearchSql.Server"/>) or one database's batch (<see cref="ObjectSearchSql.Batch"/>)
/// into a <see cref="DatabaseIndex"/>, charging its records (<see cref="IndexMemory"/>) against the shared budget: first against
/// the share of the index it will replace (<paramref name="credit"/>), so a rebuild fits wherever the build before it did, then
/// against what is free. Names and definitions come from the <paramref name="pool"/>, one reference per distinct text per read,
/// so a text another database or connection holds costs only its slot. A read past the budget answers null; a definition past
/// it is left out. Children (columns, keys,
/// constraints, triggers, indexes, statistics, parameters) are kept only under a parent Object Explorer lists them below, and share
/// its strings; repeated names (schemas, common column names) are held once per read. A history table (and its children) names
/// the table whose history row lists it.</summary>
internal sealed class DatabaseReader(string database, ObjectIndexLimits limits, StringPool pool, DatabaseIndex? credit = null)
{
    private readonly IndexBudget budget = pool.Budget;
    private long taken;
    private long credited;
    private long creditLeft = credit?.Bytes ?? 0;
    private int modules;
    private int cut;
    /// <summary>The objects read so far, and the pool's copy of each distinct text the read holds a reference to (its texts).</summary>
    private readonly ObjectTable.Builder objects = new();
    /// <summary>Rows waiting for the object that lists them: children for their parent, history tables for their table.</summary>
    private readonly List<(int At, int Owner, bool History)> pending = [];
    private char[] buffer = new char[Math.Min(limits.DefinitionChars, 64 * 1024)];
    /// <summary>Whether the read asked for definitions, and its database's case rule once read: kept on whatever it hands over.</summary>
    private bool definitionsRead = true;
    private bool? caseSensitive;
    private bool dottedI;

    /// <summary>A read past the budget.</summary>
    private sealed class TooLarge : Exception;

    /// <summary>Gives back what a failed read took; the share it would have replaced stays with its owner.</summary>
    public void Abandon()
    {
        pool.Release(objects.Texts);
        objects.Clear();
        budget.Release(taken);
        taken = 0;
        credited = 0;
        creditLeft = 0;
    }

    /// <summary>Charges <paramref name="bytes"/> to the credit, else to the budget when that leaves <paramref name="keepFree"/> free.</summary>
    private bool TryCharge(long bytes, long keepFree)
    {
        if (creditLeft >= bytes) { creditLeft -= bytes; credited += bytes; return true; }
        if (!budget.TryTake(bytes, keepFree)) return false;
        taken += bytes;
        return true;
    }

    /// <summary>Whether the read holds anything (a read that failed part way keeps it).</summary>
    public bool Any => objects.Count > 0;

    /// <summary>What the read holds so far, as an index: rows still waiting for the object that lists them are left out.</summary>
    public DatabaseIndex Partial()
    {
        foreach (var (at, _, _) in pending) objects.Remove(at);
        pending.Clear();
        var index = new DatabaseIndex(database, objects.Build(), taken + credited, modules, cut, credited, credited > 0 ? credit : null, pooled: true)
        {
            // A read that failed part way (KeepPartial) says what it read as much as a whole one.
            DefinitionsLeftOut = !definitionsRead, CaseSensitive = caseSensitive, DottedI = dottedI
        };
        objects.Clear();
        taken = 0;
        credited = 0;
        creditLeft = 0;
        return index;
    }

    /// <summary>The database's index, or null when it does not fit in the budget. Without
    /// <paramref name="children"/> the batch has no column, index, statistics or parameter result sets.</summary>
    public async Task<DatabaseIndex?> ReadAsync(DbDataReader reader, bool definitions, CancellationToken token, bool children = true)
    {
        definitionsRead = definitions;
        try
        {
            var byId = new Dictionary<int, int>();
            while (await reader.ReadAsync(token))
            {
                var id = reader.GetInt32(0);
                var schema = Intern(reader.GetString(1));
                var name = Intern(reader.GetString(2));
                var type = reader.GetString(3).TrimEnd();
                var modified = reader.GetDateTime(4);
                var parent = reader.GetInt32(5);
                var system = reader.GetBoolean(6);
                var variant = reader.GetByte(7);
                var current = reader.IsDBNull(8) ? 0 : reader.GetInt32(8);
                if (ChildOf(type, parent) is { } child)
                {
                    // Its parent may come later in id order, or be a table type (read next): placed once every parent is read.
                    byId[id] = Add(new(child.Kind, child.Folder, null, name, Modified: modified, Subtype: child.Subtype));
                    pending.Add((byId[id], parent, false));
                }
                else if (Map(type, schema, name, modified, system, variant) is { } item)
                {
                    byId[id] = Add(item);
                    if (variant is 6 or 7) pending.Add((byId[id], current, true));
                }
            }
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token))
            {
                reader.GetInt32(0);
                var schema = Intern(reader.GetString(1));
                var name = Intern(reader.GetString(2));
                var table = reader.GetBoolean(3);
                var assembly = reader.GetBoolean(4);
                var at = Add(table ? new("tableType", "userDefinedTableTypes", schema, name) : new("type", assembly ? "userDefinedTypes" : "userDefinedDataTypes", schema, name, Subtype: assembly ? "clr" : "alias"));
                if (!reader.IsDBNull(5)) byId[reader.GetInt32(5)] = at;
            }
            Place(byId);
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token))
            {
                var code = reader.GetString(0);
                var schema = reader.IsDBNull(1) ? null : Intern(reader.GetString(1));
                var name = Intern(reader.GetString(2));
                DateTime? modified = reader.IsDBNull(3) ? null : reader.GetDateTime(3);
                var system = reader.GetBoolean(4);
                if (Named(code) is var (kind, folder)) Add(new(kind, folder, schema, name, Modified: modified, System: system));
            }
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token))
            {
                var id = reader.GetInt32(0);
                byId[id] = Add(new("databaseTrigger", "databaseTriggers", null, Intern(reader.GetString(1)), Modified: reader.GetDateTime(2), System: reader.GetBoolean(3)));
            }
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token))
            {
                var name = Intern(reader.GetString(0));
                var modified = reader.GetDateTime(1);
                var (text, longer) = definitions ? Text(reader, 2) : (None, false);
                var guide = Add(new IndexedObject("planGuide", "planGuides", null, name, Modified: modified));
                if (text is not null) objects.SetDefinition(guide, text, longer);
            }
            if (children)
            {
                await reader.NextResultAsync(token);
                var types = await ReadTypes(reader, objects, Intern, Charge, token);
                await Columns(reader, byId, types, definitions, token);
                var indexes = await Indexes(reader, byId, token);
                await Children(reader, byId, "statistic", "statistics", false, token);
                await Parameters(reader, byId, types, token);
                await Keys(reader, byId, indexes, token);
            }
            await Definitions(reader, byId, definitions, token);
            // The last result set (ObjectSearchSql.CaseSensitive): absent from a batch that stopped short, which leaves it unknown.
            // Best-effort: the objects are all read by now, so a probe that fails leaves the case rule unknown rather than losing
            // them (a stop the caller asked for still stops).
            try
            {
                if (await reader.NextResultAsync(token) && await reader.ReadAsync(token))
                {
                    caseSensitive = reader.GetBoolean(0);
                    dottedI = reader.FieldCount > 1 && reader.GetBoolean(1);
                }
            }
            catch (Exception error) when (error is DbException or InvalidOperationException && !token.IsCancellationRequested)
            {
                caseSensitive = null;
                dottedI = false;
            }
            return Partial();
        }
        catch (TooLarge)
        {
            Abandon();
            return null;
        }
    }

    /// <summary>Gives each waiting row the object that lists it, once every table and table type is read: a history table its
    /// table (whose history row Object Explorer shows it as), then a child its parent. A row whose owner the login cannot see, or
    /// whose owner lists no such folder, is left out.</summary>
    private void Place(Dictionary<int, int> byId)
    {
        int Owner(int id) => id != 0 && byId.TryGetValue(id, out var at) && !objects.Removed(at) ? at : -1;
        foreach (var (at, owner, history) in pending)
        {
            if (!history) continue;
            if (Owner(owner) is var table and >= 0 && objects.Kind(table) == "table") objects.SetVia(at, table);
            else objects.Remove(at);
        }
        foreach (var (at, owner, history) in pending)
        {
            if (history) continue;
            if (Owner(owner) is var parent and >= 0 && Lists(objects.Kind(at), parent)) objects.Attach(at, parent, objects.System(parent));
            else objects.Remove(at);
        }
        pending.Clear();
    }

    /// <summary>Whether Object Explorer lists a <paramref name="kind"/> child below the read's object at <paramref name="parent"/>
    /// (as <see cref="Child"/> decides for a record).</summary>
    private bool Lists(string kind, int parent) =>
        objects.HasSchema(parent) && objects.Folder(parent) != "functions" && Lists(kind, objects.Kind(parent), objects.Subtype(parent));

    /// <summary>The definitions result set: each kept with its object (a module, a constraint, a trigger).</summary>
    private async Task Definitions(DbDataReader reader, Dictionary<int, int> byId, bool definitions, CancellationToken token)
    {
        if (!definitions || !await reader.NextResultAsync(token)) return;
        while (await reader.ReadAsync(token))
        {
            if (!byId.TryGetValue(reader.GetInt32(0), out var at) || objects.Removed(at)) continue;
            var (text, longer) = Text(reader, 1);
            if (text is not null) objects.SetDefinition(at, text, longer);
        }
    }

    /// <summary>Charges <paramref name="bytes"/> of details; a read past the budget stops (and is read again without children).</summary>
    private void Charge(long bytes)
    {
        if (!TryCharge(bytes, 0)) throw new TooLarge();
    }

    /// <summary>A catalog int that the details hold in 16 bits (column_id, parameter_id), clamped.</summary>
    private static short Short(int value) => (short)Math.Clamp(value, short.MinValue, short.MaxValue);

    /// <summary>The types result set (<see cref="ObjectSearchSql.Types"/>, the reader on it): each type's index in the table's
    /// details by user_type_id. Names go through <paramref name="intern"/>, each type is charged through <paramref name="charge"/>.</summary>
    internal static async Task<Dictionary<int, ushort>> ReadTypes(DbDataReader reader, ObjectTable.Builder objects, Func<string, string> intern, Action<long> charge, CancellationToken token)
    {
        var types = new Dictionary<int, ushort>();
        while (await reader.ReadAsync(token))
        {
            var id = reader.GetInt32(0);
            var schema = reader.GetString(1);
            var name = reader.GetString(2);
            var system = reader.GetByte(3);
            var userDefined = reader.GetBoolean(4);
            var table = reader.GetBoolean(5);
            if (objects.Details.TypeCount > ushort.MaxValue) continue;
            charge(IndexMemory.TypeBytes);
            var held = intern(name);
            var heldSchema = userDefined ? intern(schema) : null;
            types[id] = objects.Details.AddType(objects.Id(held), heldSchema is null ? -1 : objects.Id(heldSchema), id, system, userDefined, table);
        }
        return types;
    }

    /// <summary>A typed row's type and flags from <paramref name="from"/> on (<see cref="ObjectSearchSql.TypedColumns"/>, or with
    /// <paramref name="parameter"/> <see cref="ObjectSearchSql.TypedParameters"/>), in column order as sequential access reads them.</summary>
    internal static (int Type, short Length, byte Precision, byte Scale, short Ordinal, TypedFlags Flags) ReadTyped(DbDataReader reader, bool parameter)
    {
        if (parameter)
        {
            var output = reader.GetBoolean(2);
            var ordinal = Short(reader.GetInt32(3));
            var type = reader.GetInt32(4);
            var (length, precision, scale) = (reader.GetInt16(5), reader.GetByte(6), reader.GetByte(7));
            var readOnly = !reader.IsDBNull(8) && reader.GetBoolean(8);
            var parameterFlags = (output ? TypedFlags.Output : 0) | (readOnly ? TypedFlags.ReadOnly : 0);
            if (!reader.IsDBNull(9)) (length, parameterFlags) = (Short(reader.GetInt32(9)), parameterFlags | TypedFlags.Dimensions);
            return (type, length, precision, scale, ordinal, parameterFlags);
        }
        var column = Short(reader.GetInt32(2));
        var columnType = reader.GetInt32(3);
        var (columnLength, columnPrecision, columnScale) = (reader.GetInt16(4), reader.GetByte(5), reader.GetByte(6));
        var flags = (!reader.IsDBNull(7) && reader.GetBoolean(7) ? TypedFlags.Nullable : 0) | (reader.GetBoolean(8) ? TypedFlags.Identity : 0)
            | (reader.GetBoolean(9) ? TypedFlags.Computed : 0) | (reader.GetBoolean(10) ? TypedFlags.Default : 0);
        // A vector column's length is its dimensions (TypedDetail.MaxLength): its bytes depend on its base type.
        if (!reader.IsDBNull(11)) (columnLength, flags) = (Short(reader.GetInt32(11)), flags | TypedFlags.Dimensions);
        return (columnType, columnLength, columnPrecision, columnScale, column, flags);
    }

    /// <summary>Gives the entry at <paramref name="at"/> its type, when the types result set listed it.</summary>
    private void SetTyped(int at, Dictionary<int, ushort> types, (int Type, short Length, byte Precision, byte Scale, short Ordinal, TypedFlags Flags) typed)
    {
        if (!types.TryGetValue(typed.Type, out var type)) return;
        Charge(IndexMemory.TypedBytes);
        objects.Details.SetTyped(at, type, typed.Length, typed.Precision, typed.Scale, typed.Ordinal, typed.Flags);
    }

    /// <summary>The columns result set: each column Object Explorer lists kept under its parent with its type (and a computed
    /// column's expression).</summary>
    private async Task Columns(DbDataReader reader, Dictionary<int, int> byId, Dictionary<int, ushort> types, bool definition, CancellationToken token)
    {
        await reader.NextResultAsync(token);
        var last = int.MinValue;
        var parent = -1;
        while (await reader.ReadAsync(token))
        {
            var id = reader.GetInt32(0);
            var name = reader.GetString(1);
            var typed = ReadTyped(reader, parameter: false);
            if (id != last) { last = id; parent = byId.TryGetValue(id, out var at) && !objects.Removed(at) ? at : -1; }
            if (parent < 0 || name.Length == 0) continue;
            var held = Intern(name);
            if (!Lists("column", parent)) continue;
            var (text, longer) = definition && !reader.IsDBNull(12) ? Text(reader, 12) : (None, false);
            var child = Add(new("column", "columns", null, held));
            objects.Attach(child, parent, objects.System(parent));
            if (text is not null) objects.SetDefinition(child, text, longer);
            SetTyped(child, types, typed);
        }
    }

    /// <summary>The indexes result set: each index kept under its parent, by (object id, index_id) for its columns.</summary>
    private async Task<Dictionary<(int, int), int>> Indexes(DbDataReader reader, Dictionary<int, int> byId, CancellationToken token)
    {
        await reader.NextResultAsync(token);
        var indexes = new Dictionary<(int, int), int>();
        var last = int.MinValue;
        var parent = -1;
        while (await reader.ReadAsync(token))
        {
            var id = reader.GetInt32(0);
            var name = reader.GetString(1);
            var subtype = ExplorerLabels.IndexSubtype(reader.GetByte(2));
            var indexId = reader.GetInt32(3);
            if (id != last) { last = id; parent = byId.TryGetValue(id, out var at) && !objects.Removed(at) ? at : -1; }
            if (parent < 0 || name.Length == 0) continue;
            var held = Intern(name);
            if (!Lists("index", parent)) continue;
            var child = Add(new("index", "indexes", null, held, Subtype: subtype));
            objects.Attach(child, parent, objects.System(parent));
            indexes[(id, indexId)] = child;
        }
        return indexes;
    }

    /// <summary>The parameters result set: each parameter kept under its procedure or function with its type; a scalar function's
    /// return (parameter 0) types the function itself.</summary>
    private async Task Parameters(DbDataReader reader, Dictionary<int, int> byId, Dictionary<int, ushort> types, CancellationToken token)
    {
        await reader.NextResultAsync(token);
        var last = int.MinValue;
        var parent = -1;
        while (await reader.ReadAsync(token))
        {
            var id = reader.GetInt32(0);
            var name = reader.GetString(1);
            var typed = ReadTyped(reader, parameter: true);
            if (id != last) { last = id; parent = byId.TryGetValue(id, out var at) && !objects.Removed(at) ? at : -1; }
            if (parent < 0) continue;
            if (typed.Ordinal == 0)
            {
                if (objects.Kind(parent) == "function" && Lists("parameter", parent)) SetTyped(parent, types, typed);
                continue;
            }
            if (name.Length == 0) continue;
            var held = Intern(name);
            if (!Lists("parameter", parent)) continue;
            var child = Add(new("parameter", "parameters", null, held, Subtype: (typed.Flags & TypedFlags.Output) != 0 ? "output" : "input"));
            objects.Attach(child, parent, objects.System(parent));
            SetTyped(child, types, typed);
        }
    }

    /// <summary>The key metadata result sets: each kept index's columns in key order (included ones last), each primary or unique
    /// key's index (whose columns it shares), and each foreign key's column pairs with the table it references.</summary>
    private async Task Keys(DbDataReader reader, Dictionary<int, int> byId, Dictionary<(int, int), int> indexes, CancellationToken token)
    {
        int Kept(int id) => byId.TryGetValue(id, out var at) && !objects.Removed(at) ? at : -1;
        await reader.NextResultAsync(token);
        var items = new Dictionary<int, int>();
        var last = (int.MinValue, int.MinValue);
        var open = false;
        while (await reader.ReadAsync(token))
        {
            var index = (reader.GetInt32(0), reader.GetInt32(1));
            var column = Short(reader.GetInt32(2));
            var flags = (!reader.IsDBNull(3) && reader.GetBoolean(3) ? KeyColumnFlags.Descending : 0) | (!reader.IsDBNull(4) && reader.GetBoolean(4) ? KeyColumnFlags.Included : 0);
            if (index != last)
            {
                last = index;
                open = indexes.TryGetValue(index, out var at) && !objects.Removed(at);
                if (open)
                {
                    Charge(IndexMemory.KeyBytes);
                    items[at] = objects.Details.StartKey(at, -1);
                }
            }
            if (!open) continue;
            Charge(IndexMemory.KeyColumnBytes);
            objects.Details.AddKeyColumn(column, 0, flags);
        }
        await reader.NextResultAsync(token);
        while (await reader.ReadAsync(token))
        {
            var key = Kept(reader.GetInt32(0));
            var index = (reader.GetInt32(1), reader.IsDBNull(2) ? -1 : reader.GetInt32(2));
            if (key < 0 || !indexes.TryGetValue(index, out var at) || !items.TryGetValue(at, out var item)) continue;
            Charge(IndexMemory.KeyBytes);
            objects.Details.ShareKey(key, item);
        }
        await reader.NextResultAsync(token);
        var lastKey = int.MinValue;
        open = false;
        while (await reader.ReadAsync(token))
        {
            var id = reader.GetInt32(0);
            var column = Short(reader.GetInt32(1));
            var referenced = reader.GetInt32(2);
            var other = Short(reader.GetInt32(3));
            if (id != lastKey)
            {
                lastKey = id;
                var key = Kept(id);
                open = key >= 0 && objects.Kind(key) == "key";
                if (open)
                {
                    Charge(IndexMemory.KeyBytes);
                    objects.Details.StartKey(key, Kept(referenced));
                }
            }
            if (!open) continue;
            Charge(IndexMemory.KeyColumnBytes);
            objects.Details.AddKeyColumn(column, other, KeyColumnFlags.None);
        }
    }

    /// <summary>One child result set (object id, name, then a subtype column or a definition): each row kept under its parent.</summary>
    private async Task Children(DbDataReader reader, Dictionary<int, int> byId, string kind, string folder, bool definition, CancellationToken token)
    {
        await reader.NextResultAsync(token);
        var last = int.MinValue;
        var parent = -1;
        while (await reader.ReadAsync(token))
        {
            var id = reader.GetInt32(0);
            var name = reader.GetString(1);
            if (id != last) { last = id; parent = byId.TryGetValue(id, out var at) && !objects.Removed(at) ? at : -1; }
            string? subtype = kind switch
            {
                "index" => ExplorerLabels.IndexSubtype(reader.GetByte(2)),
                "parameter" => reader.GetBoolean(2) ? "output" : "input",
                _ => null
            };
            if (parent < 0 || name.Length == 0) continue;
            var held = Intern(name);
            if (!Lists(kind, parent)) continue;
            var (text, longer) = definition && !reader.IsDBNull(2) ? Text(reader, 2) : (None, false);
            var child = Add(new(kind, folder, null, held, Subtype: subtype));
            objects.Attach(child, parent, objects.System(parent));
            if (text is not null) objects.SetDefinition(child, text, longer);
        }
    }

    /// <summary>The server's own objects (<see cref="ObjectSearchSql.Server"/>): its databases, then, where it has them, its logins,
    /// server roles, other server objects and server triggers. Null when they do not fit in the budget.</summary>
    public async Task<DatabaseIndex?> ReadServerAsync(DbDataReader reader, bool box, bool definitions, Actions.LoginRules logins, CancellationToken token)
    {
        try
        {
            while (await reader.ReadAsync(token))
            {
                var name = Intern(reader.GetString(0));
                var created = reader.GetDateTime(1);
                var system = reader.GetBoolean(2);
                var snapshot = reader.GetBoolean(3);
                Add(snapshot ? new("database", "databaseSnapshots", null, name, Modified: created, Subtype: "snapshot")
                    : system ? new("database", "systemDatabases", null, name, Modified: created, System: true, Subtype: "system")
                    : new("database", "databases", null, name, Modified: created));
            }
            if (!box) return Partial();
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token))
            {
                var principal = reader.GetInt32(0);
                var name = Intern(reader.GetString(1));
                var type = reader.GetString(2).TrimEnd();
                var modified = reader.GetDateTime(3);
                var fixedRole = reader.GetBoolean(4);
                if (type == "R") { Add(new("serverRole", "serverRoles", null, name, Modified: modified, System: fixedRole || principal == 2)); continue; }
                var subtype = logins.SubtypeOf(principal, type, name);
                Add(new("login", "logins", null, name, Modified: modified, System: subtype == "system", Subtype: subtype));
            }
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token))
            {
                var code = reader.GetString(0);
                var name = Intern(reader.GetString(1));
                DateTime? modified = reader.IsDBNull(2) ? null : reader.GetDateTime(2);
                if (ServerNamed(code) is var (kind, folder)) Add(new(kind, folder, null, name, Modified: modified));
            }
            await reader.NextResultAsync(token);
            var byId = new Dictionary<int, int>();
            while (await reader.ReadAsync(token))
            {
                var id = reader.GetInt32(0);
                byId[id] = Add(new("serverTrigger", "serverTriggers", null, Intern(reader.GetString(1)), Modified: reader.GetDateTime(2), System: reader.GetBoolean(3)));
            }
            await Definitions(reader, byId, definitions, token);
            return Partial();
        }
        catch (TooLarge)
        {
            Abandon();
            return null;
        }
    }

    /// <summary>SQL Server Agent's objects (<see cref="ObjectSearchSql.Agent"/>) by each row's code: jobs with their modify date,
    /// alerts and operators by name. Alerts only where the platform serves the Alerts folder (<paramref name="alerts"/>), so
    /// every hit can be revealed. Their refs name no database. Null when they do not fit.</summary>
    public async Task<DatabaseIndex?> ReadAgentAsync(DbDataReader reader, bool alerts, CancellationToken token)
    {
        try
        {
            do
                while (await reader.ReadAsync(token))
                {
                    var code = reader.GetString(0);
                    if (AgentNamed(code) is not var (kind, folder) || kind == "agentAlert" && !alerts) continue;
                    // In column order: the index reads with CommandBehavior.SequentialAccess.
                    var name = Intern(reader.GetString(1));
                    var modified = code == "AJ" && !reader.IsDBNull(2) ? reader.GetDateTime(2) : (DateTime?)null;
                    Add(new(kind, folder, null, name, Modified: modified));
                }
            while (await reader.NextResultAsync(token));
            return Partial();
        }
        catch (TooLarge)
        {
            Abandon();
            return null;
        }
    }

    /// <summary>The kind and folder of the Agent batch's named-object code.</summary>
    internal static (string Kind, string Folder)? AgentNamed(string code) => code switch
    {
        "AJ" => ("agentJob", "agentJobs"),
        "AA" => ("agentAlert", "agentAlerts"),
        "AO" => ("agentOperator", "agentOperators"),
        _ => null
    };

    /// <summary>The resource database's objects (<see cref="ObjectSearchSql.ResourceObjects"/>), each a system one, with their
    /// columns and parameters and the definitions cut at the per-module limit; the shared catalog charges them to the budget.</summary>
    public static async Task<ObjectTable> ReadResourceAsync(DbDataReader reader, bool definitions, ObjectIndexLimits limits, CancellationToken token)
    {
        var objects = new ObjectTable.Builder();
        var byId = new Dictionary<int, int>();
        while (await reader.ReadAsync(token))
        {
            // Sequential access reads the columns in order.
            var id = reader.GetInt32(0);
            var schema = reader.GetString(1);
            var name = reader.GetString(2);
            var type = reader.GetString(3).TrimEnd();
            var item = Map(type, schema, name, reader.GetDateTime(4), system: true);
            if (item is null) continue;
            objects.Text(schema);
            objects.Text(name);
            byId[id] = objects.Add(item);
        }
        await reader.NextResultAsync(token);
        var types = await ReadTypes(reader, objects, value => { objects.Text(value); return value; }, _ => { }, token);
        void Typed(int at, (int Type, short Length, byte Precision, byte Scale, short Ordinal, TypedFlags Flags) typed)
        {
            if (types.TryGetValue(typed.Type, out var type)) objects.Details.SetTyped(at, type, typed.Length, typed.Precision, typed.Scale, typed.Ordinal, typed.Flags);
        }
        foreach (var (kind, folder) in new[] { ("column", "columns"), ("parameter", "parameters") })
        {
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token))
            {
                var id = reader.GetInt32(0);
                var name = reader.GetString(1);
                var typed = ReadTyped(reader, parameter: kind == "parameter");
                if (!byId.TryGetValue(id, out var at) || !(objects.HasSchema(at) && objects.Folder(at) != "functions" && Lists(kind, objects.Kind(at), objects.Subtype(at)))) continue;
                if (kind == "parameter" && typed.Ordinal == 0)
                {
                    if (objects.Kind(at) == "function") Typed(at, typed);
                    continue;
                }
                if (name.Length == 0) continue;
                objects.Text(name);
                var child = objects.Add(kind, folder, kind == "parameter" ? (typed.Flags & TypedFlags.Output) != 0 ? "output" : "input" : null, null, name, null, true);
                objects.Attach(child, at, objects.System(at));
                Typed(child, typed);
            }
        }
        if (definitions && await reader.NextResultAsync(token))
        {
            var buffer = new char[Math.Min(limits.DefinitionChars, 64 * 1024)];
            while (await reader.ReadAsync(token))
            {
                if (!byId.TryGetValue(reader.GetInt32(0), out var at)) continue;
                var (text, longer) = ReadText(reader, 1, ref buffer, limits.DefinitionChars);
                if (text.Length == 0) continue;
                var held = DefinitionText.Hold(text);
                objects.Text(held);
                objects.SetDefinition(at, held, longer);
            }
        }
        return objects.Build();
    }

    /// <summary>Keeps <paramref name="item"/> (whose texts are the pool's), charging its entry. Its parent, its Via and its
    /// definition are set on the entry afterwards.</summary>
    private int Add(IndexedObject item)
    {
        if (!TryCharge(IndexMemory.RecordBytes, 0)) throw new TooLarge();
        return objects.Add(item);
    }

    /// <summary>The pool's copy of a name; a read past the budget stops.</summary>
    private string Intern(string value) => Pooled(value, 0) ?? throw new TooLarge();

    /// <summary>The pool's copy of <paramref name="value"/>, taking the read's one reference to it and charging its slot when the
    /// read does not hold it yet; null when either would leave less than <paramref name="keepFree"/> free.</summary>
    private PackedText? Pooled(PackedText value, long keepFree)
    {
        if (objects.TryText(value, out var copy)) return copy;
        var acquired = pool.TryAcquire(value, keepFree);
        if (acquired is null) return null;
        if (!TryCharge(IndexMemory.SlotBytes, keepFree)) { pool.Release([acquired]); return null; }
        objects.Text(acquired);
        return acquired;
    }

    private string? Pooled(string value, long keepFree)
    {
        if (objects.TryText(value, out var copy)) return copy;
        var acquired = pool.TryAcquire(value, keepFree);
        if (acquired is null) return null;
        if (!TryCharge(IndexMemory.SlotBytes, keepFree)) { pool.Release([acquired]); return null; }
        objects.Text(acquired);
        return acquired;
    }

    /// <summary>No definition (a typed null for the tuples below).</summary>
    private static readonly object? None = null;

    /// <summary>A definition column read only as far as the per-module limit and charged to the budget, held as the index holds it
    /// (packed when long, <see cref="PackedText"/>): null when there is none or the budget is spent (counted as cut), and whether it
    /// goes on past the limit.</summary>
    private (object? Text, bool Longer) Text(DbDataReader reader, int ordinal)
    {
        if (reader.IsDBNull(ordinal)) return (None, false);
        // Below the names' reserve with no credit for a slot, the pool refuses every definition the read does not hold yet: read
        // no more than a short one's length, which finds a repeated default or computed column expression (((0)), (getdate()))
        // the read already holds at no cost, rather than stream a long one only to throw it away.
        if (creditLeft < IndexMemory.SlotBytes && budget.Limit - budget.Used < limits.NamesReserveBytes) return Repeated(reader, ordinal);
        var (text, longer) = ReadText(reader, ordinal, ref buffer, limits.DefinitionChars);
        if (text.Length == 0) return (None, false);
        if ((PackedText.TryPack(text) is { } packed ? (object?)Pooled(packed, limits.NamesReserveBytes) : Pooled(text, limits.NamesReserveBytes)) is not { } copy) { cut++; return (None, false); }
        modules++;
        if (longer) cut++;
        return (copy, longer);
    }

    /// <summary>The longest definition the read looks for among the texts it holds once it is below the names' reserve.</summary>
    public const int RepeatChars = 256;

    /// <summary>A definition read below the names' reserve: the read's own copy when it is at most <see cref="RepeatChars"/> long
    /// and the read already holds it, else left out (counted as cut) after at most that many characters.</summary>
    private (object? Text, bool Longer) Repeated(DbDataReader reader, int ordinal)
    {
        var most = Math.Min(RepeatChars, buffer.Length - 1);
        // As ReadText, read until the value ends or one character past the longest repeat: a provider may answer a GetChars call
        // short of what it asked, and a short read taken as the value's end would match a held prefix of a longer text.
        var read = 0;
        for (int got; read <= most && (got = (int)reader.GetChars(ordinal, read, buffer, read, most + 1 - read)) > 0;) read += got;
        if (read <= 0) return (None, false);
        if (read <= most && objects.TryText(buffer.AsSpan(0, read), out var copy))
        {
            modules++;
            return (copy, false);
        }
        cut++;
        return (None, false);
    }

    private static (string Text, bool Longer) ReadText(DbDataReader reader, int ordinal, ref char[] buffer, int limit)
    {
        var builder = new System.Text.StringBuilder();
        long offset = 0;
        while (builder.Length < limit)
        {
            var want = Math.Min(buffer.Length, limit - builder.Length);
            var read = (int)reader.GetChars(ordinal, offset, buffer, 0, want);
            if (read <= 0) return (builder.ToString(), false);
            builder.Append(buffer, 0, read);
            offset += read;
        }
        var more = reader.GetChars(ordinal, offset, buffer, 0, 1) > 0;
        return (builder.ToString(), more);
    }

    /// <summary>The Object Explorer identity of a sys.objects or sys.all_objects row that is not a child, or null for a type it
    /// does not list. A system table, view or procedure is in its System folder; a system function, which Object Explorer's static
    /// System Functions folder does not list, is under Functions. <paramref name="variant"/> is the batch's table and view folder
    /// variant: 1 FileTable, 2 external, 3 graph node, 4 graph edge, 5 dropped ledger, 6 temporal history, 7 ledger history (both
    /// shown below their table: the reader names it), 8 a dropped ledger table's history, which Object Explorer does not list.</summary>
    internal static IndexedObject? Map(string type, string schema, string name, DateTime modified, bool system = false, int variant = 0) =>
        (type, system) switch
        {
            ("U", true) => new("table", "systemTables", schema, name, Modified: modified, System: true, Subtype: "system"),
            ("U", false) => variant switch
            {
                1 => new("table", "fileTables", schema, name, Modified: modified, Subtype: "fileTable"),
                2 => new("table", "externalTables", schema, name, Modified: modified, Subtype: "external"),
                3 => new("table", "graphTables", schema, name, Modified: modified, Subtype: "graphNode"),
                4 => new("table", "graphTables", schema, name, Modified: modified, Subtype: "graphEdge"),
                5 => new("table", "droppedLedgerTables", schema, name, Modified: modified, Subtype: "droppedLedger"),
                6 => new("table", "tables", schema, name, Modified: modified, Subtype: "history"),
                7 => new("table", "tables", schema, name, Modified: modified, Subtype: "ledgerHistory"),
                8 => null,
                _ => new("table", "tables", schema, name, Modified: modified)
            },
            ("ET", _) => new("table", "externalTables", schema, name, Modified: modified, System: system, Subtype: "external"),
            ("V", true) => new("view", "systemViews", schema, name, Modified: modified, System: true, Subtype: "system"),
            ("V", false) when variant == 5 => new("view", "droppedLedgerViews", schema, name, Modified: modified, Subtype: "droppedLedger"),
            ("V", false) => new("view", "views", schema, name, Modified: modified),
            // Object Explorer's Stored Procedures folder lists T-SQL and CLR procedures; the System one every other kind.
            ("P" or "PC", false) => new("procedure", "storedProcedures", schema, name, Modified: modified, Subtype: ExplorerLabels.ProcedureSubtype(type)),
            ("P" or "PC" or "X" or "RF", _) => new("procedure", "systemStoredProcedures", schema, name, Modified: modified, System: system,
                Subtype: type is "X" or "RF" ? ExplorerLabels.ProcedureSubtype(type) : "system"),
            ("FN" or "FS", false) => new("function", "scalarValuedFunctions", schema, name, Modified: modified, Subtype: ExplorerLabels.FunctionSubtype(type)),
            ("IF" or "TF" or "FT", false) => new("function", "tableValuedFunctions", schema, name, Modified: modified, Subtype: ExplorerLabels.FunctionSubtype(type)),
            ("AF", false) => new("function", "aggregateFunctions", schema, name, Modified: modified, Subtype: "aggregate"),
            ("FN" or "FS" or "IF" or "TF" or "FT" or "AF", true) => new("function", "functions", schema, name, Modified: modified, System: true, Subtype: ExplorerLabels.FunctionSubtype(type)),
            ("SN", _) => new("synonym", "synonyms", schema, name, Modified: modified, System: system),
            ("SO", _) => new("sequence", "sequences", schema, name, Modified: modified, System: system),
            ("R", _) => new("rule", "rules", schema, name, Modified: modified, System: system),
            ("D", _) => new("default", "defaults", schema, name, Modified: modified, System: system),
            ("SP", _) => new("securityPolicy", "securityPolicies", schema, name, Modified: modified, System: system),
            _ => null
        };

    /// <summary>The child kind, folder and subtype of a sys.objects row kept with its parent: DML triggers, keys, and check, default
    /// and edge constraints. A default with no parent is a stand-alone one (<see cref="Map"/>).</summary>
    internal static (string Kind, string Folder, string? Subtype)? ChildOf(string type, int parent) => type switch
    {
        "TR" => ("trigger", "tableTriggers", null),
        "PK" => ("key", "keys", "primary"),
        "UQ" => ("key", "keys", "unique"),
        "F" => ("key", "keys", "foreign"),
        "C" => ("constraint", "constraints", "check"),
        "D" when parent != 0 => ("constraint", "constraints", "default"),
        "EC" => ("constraint", "constraints", "edge"),
        _ => null
    };

    /// <summary>A child under <paramref name="parent"/>, sharing its strings, system flag and the table a history table is shown
    /// below, or null where Object Explorer lists no such folder below it (a key on a view, a column of a procedure) or does not
    /// list the parent in a folder at all (a system function, whose System Functions folder is planned).</summary>
    internal static IndexedObject? Child(IndexedObject parent, string kind, string folder, string name, string? subtype = null, DateTime? modified = null) =>
        parent.Schema is not null && parent.Folder != "functions" && Lists(kind, parent.Kind, parent.Subtype)
            ? new(kind, folder, null, name, parent.Kind, parent.Schema, parent.Name, modified, System: parent.System, Subtype: subtype, ParentFolder: parent.Folder, Via: parent.Via)
            : null;

    private static bool Lists(string kind, string parentKind, string? parentSubtype) => kind switch
    {
        "column" => parentKind is "table" or "view" or "tableType" or "function",
        "key" or "constraint" => parentKind is "tableType" || parentKind is "table" && parentSubtype is not ("external" or "history" or "ledgerHistory" or "droppedLedger"),
        "trigger" => parentKind is "view" || parentKind is "table" && parentSubtype is not ("external" or "history" or "ledgerHistory" or "droppedLedger"),
        "index" => parentKind is "view" or "tableType" || parentKind is "table" && parentSubtype is not "external",
        "statistic" => parentKind is "table" or "view",
        "parameter" => parentKind is "procedure" or "function",
        _ => false
    };

    /// <summary>The kind and folder of a database batch's named-object code.</summary>
    internal static (string Kind, string Folder)? Named(string code) => code switch
    {
        "US" => ("user", "users"),
        "RL" => ("databaseRole", "databaseRoles"),
        "AR" => ("applicationRole", "applicationRoles"),
        "SC" => ("schema", "schemas"),
        "AS" => ("assembly", "assemblies"),
        "AK" => ("asymmetricKey", "asymmetricKeys"),
        "CE" => ("certificate", "certificates"),
        "SK" => ("symmetricKey", "symmetricKeys"),
        "CM" => ("columnMasterKey", "columnMasterKeys"),
        "CK" => ("columnEncryptionKey", "columnEncryptionKeys"),
        "DS" => ("externalDataSource", "externalDataSources"),
        "FF" => ("externalFileFormat", "externalFileFormats"),
        "DA" => ("databaseAuditSpecification", "databaseAuditSpecifications"),
        "FC" => ("fullTextCatalog", "fullTextCatalogs"),
        "FL" => ("fullTextStoplist", "fullTextStoplists"),
        "PS" => ("partitionScheme", "partitionSchemes"),
        "PF" => ("partitionFunction", "partitionFunctions"),
        "PL" => ("searchPropertyList", "searchPropertyLists"),
        "XS" => ("xmlSchemaCollection", "xmlSchemaCollections"),
        _ => null
    };

    /// <summary>The kind and folder of the server batch's named-object code.</summary>
    internal static (string Kind, string Folder)? ServerNamed(string code) => code switch
    {
        "CR" => ("credential", "credentials"),
        "CP" => ("cryptographicProvider", "cryptographicProviders"),
        "AU" => ("audit", "audits"),
        "SA" => ("serverAuditSpecification", "serverAuditSpecifications"),
        "BD" => ("backupDevice", "backupDevices"),
        "LS" => ("linkedServer", "linkedServers"),
        _ => null
    };
}
