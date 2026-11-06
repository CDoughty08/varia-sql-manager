using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.Management.Smo;
using Varia.Backend.Actions;
using Varia.Backend.Activity;
using Varia.Backend.Entra;
using Varia.Backend.Explorer;
using Varia.Backend.Live;
using Varia.Backend.Protocol;
using Varia.Backend.Results;
using Varia.Backend.Search;
using Varia.Backend.Scripting;
using Varia.Backend.Ssis;

namespace Varia.Backend;

internal sealed class SqlService : IRequestDispatcher, IExplorerHost, IScriptingHost, IActionHost, ISsisHost, ILiveHost, IActivityHost, IObjectSearchHost
{
    /// <summary>Announced in HELLO; main refuses a backend that lacks any method it may call (a stale build).</summary>
    public static readonly string[] MethodNames =
    [
        "system.health", "connections.connect", "connections.databases", "connections.discover", "connections.preview", "connections.disconnect",
        "connections.identity",
        "databases.list", "tables.columns", "query.execute", "query.cancel", "query.session.close", "query.session.state",
        "results.read", "results.close", "explorer.children", "explorer.index", "explorer.search", "results.copy", "results.export",
        "scripting.script", "actions.describe", "actions.script", "actions.execute",
        "entra.cache.clear", "live.subscribe", "live.update", "activity.details", "activity.kill",
        "ssis.describe", "ssis.execute", "ssis.catalogSetup"
    ];
    /// <summary>Synthetic results for tests and benchmarks; it exists only with VARIA_BACKEND_TEST_HOOKS=1.</summary>
    public const string SynthesizeMethod = "debug.results.synthesize";
    private const long MaxSafeInteger = 9_007_199_254_740_991;
    private const string CancelledSentence = "The script was cancelled. Remaining batches were not executed.";
    private const string TimedOutSentence = "The script exceeded its execution timeout. Remaining batches were not executed.";
    /// <summary>SSMS's query-window defaults, run when a tab's session opens. SqlClient's login already sets all but two
    /// (ARITHABORT is OFF and TEXTSIZE -1), but a server's 'user options' can change them, so each is set explicitly. With
    /// ARITHABORT ON, plans differ from an application's that leaves it OFF, as they do between SSMS and that application.</summary>
    internal const string SessionPrologue = "SET ARITHABORT ON; SET ANSI_NULLS ON; SET ANSI_PADDING ON; SET ANSI_WARNINGS ON; SET ANSI_NULL_DFLT_ON ON; "
        + "SET CONCAT_NULL_YIELDS_NULL ON; SET QUOTED_IDENTIFIER ON; SET NUMERIC_ROUNDABORT OFF; SET TEXTSIZE 2147483647;";
    // The summary must fit the 16 MiB response limit: descriptors get 8 MiB, messages (1,000,000 characters, with their
    // kinds) and the error text the rest, with room to spare.
    private const long MaxSummaryDescriptorBytes = 8L * 1024 * 1024;

    private readonly ConcurrentDictionary<string, string> connections = new();
    private readonly ConcurrentDictionary<string, RunningQuery> queries = new();
    /// <summary>query.cancel requests that named a query not yet registered, by id, with when they came. Requests run on
    /// their own tasks, so a Stop sent at once can overtake its query.execute while that one is still reading its
    /// parameters (a script of up to 1M characters); the query cancels itself as it registers. Guarded by
    /// <see cref="cancelGate"/>, with registration, so neither side misses the other.</summary>
    private readonly Dictionary<string, long> earlyStops = new(StringComparer.Ordinal);
    private readonly object cancelGate = new();
    /// <summary>Main keeps at most 256 requests pending per generation, so more early Stops than that are stale.</summary>
    internal const int MaxEarlyStops = 256;
    internal static readonly TimeSpan EarlyStopLifetime = TimeSpan.FromMinutes(1);
    private readonly ConcurrentDictionary<string, QuerySession> sessions = new();
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> pools = new();
    private readonly ConcurrentDictionary<string, ServerProfile> profiles = new();
    /// <summary>Connections whose server-scope pools open in master since an object action freed their own database (critic A5).</summary>
    private readonly ConcurrentDictionary<string, byte> serverScopeInMaster = new();
    /// <summary>The database each connection's session landed in at connect: where its pools whose settings name no database (the
    /// Connect dialog's &lt;default&gt;) open, the login's default database.</summary>
    private readonly ConcurrentDictionary<string, string> homes = new();
    /// <summary>The connection id each pooled or Object Actions connection was made for, so opening it records its session.</summary>
    private readonly ConditionalWeakTable<SqlConnection, Owner> owners = [];
    private readonly OwnSessionLedger ownSessions = new();
    /// <summary>The session ids of every pooled connection the backend made, its plain pool (the connect's own, databases.list,
    /// tables.columns) included: what freeing a database waits for (critic A5). The Activity Monitor trusts ownSessions only.</summary>
    private readonly OwnSessionLedger poolSessions = new();
    private readonly ExplorerService explorer;
    private readonly ObjectSearchService search;
    private readonly ScriptingService scripting;
    private readonly ActionService actions;
    private readonly SsisService ssis;
    private readonly SsisActionService ssisActions;
    private readonly LiveService live;
    private readonly SessionActions sessionActions;
    private readonly EntraService entra;
    private readonly object sessionGate = new();
    private readonly ServerDiscovery discovery = new();
    private readonly ResultStore store;
    private readonly ResultJobs jobs;
    private readonly bool hooks;
    private readonly Func<object, bool>? publish;
    private readonly Timer? memoryTimer;
    private readonly object memoryGate = new();
    private long reportedBytes = -1;
    /// <summary>Orders memory reports (events and summary budgets) for this process; main pairs it with the generation.</summary>
    private long memorySeq;
    private long reportedIndexBytes = -1;
    private long indexMemorySeq;
    private object? health;

    private sealed class RunningQuery(string connectionId, string sessionId, CancellationTokenSource source)
    {
        public string ConnectionId { get; } = connectionId;
        public string SessionId { get; } = sessionId;
        public CancellationTokenSource Source { get; } = source;
        public bool UserCancelled { get; private set; }
        public void Cancel() { UserCancelled = true; TryCancel(Source); }
    }

    /// <summary>The most query sessions the app keeps open at once (each holds its own unpooled connection). SSMS has no
    /// such cap; this is only a backstop on connections, far above what anyone keeps open. Scripts running at once are
    /// bounded by main's 256 pending requests, beyond which main keeps only 32 for control-lane requests (cancels, state
    /// reads, closes), so the renderer sends a flow's cancels and state reads 8 at a time. Idle sessions are never
    /// reclaimed to make room: a session's SET options, temporary objects and open transaction are invisible from outside
    /// (an empty temporary table allocates no pages, so tempdb's space views miss it), and closing it would lose them
    /// silently. Only the live checks change it.</summary>
    internal int SessionLimit { get; set; } = 1000;
    /// <summary>Follows the SET prologue in the same command, so opening a session costs no extra round trip. The login
    /// is the session's as it opened, as SSMS shows it from the connection.</summary>
    internal const string LoginSql = "SELECT SUSER_SNAME();";
    /// <summary>What a query tab's session runs before it closes with commit: every nesting level of its transaction
    /// committed, then what is left. Only the live checks change it, to break the connection while it runs.</summary>
    internal string CommitSql { get; set; } = DefaultCommitSql;
    internal const string DefaultCommitSql = "WHILE @@TRANCOUNT > 0 COMMIT TRANSACTION; SELECT @@TRANCOUNT;";
    /// <summary>Read before the commit and by query.session.state, only when a session is about to end, as SSMS asks: a
    /// session found lost here never received the commit, and one with nothing open needs none. It reads no row (or a
    /// plan) when SET SHOWPLAN_*, NOEXEC, PARSEONLY or FMTONLY would keep the commit from executing.</summary>
    internal const string TransactionCountSql = "SELECT @@TRANCOUNT;";
    /// <summary>The options that compile a batch without executing it, turned off before a commit. Each SHOWPLAN option must
    /// be alone in its batch, and one that is not ON is only shown, not run, under another.</summary>
    internal static readonly string[] ExecuteAgainSql = ["SET SHOWPLAN_XML OFF", "SET SHOWPLAN_TEXT OFF", "SET SHOWPLAN_ALL OFF", "SET NOEXEC OFF; SET PARSEONLY OFF; SET FMTONLY OFF;"];

    /// <summary>What a tab's session runs when it opens: <see cref="SessionPrologue"/>. Only the live checks change it, to
    /// make it fail.</summary>
    internal string Prologue { get; set; } = SessionPrologue;

    /// <summary>Called after each row a script reads; an exception it returns is thrown there, as SqlClient raises an error
    /// that arrives while a result set's rows stream. Only the live checks set it: no statement raises a severity 17 to 19
    /// error partway through its rows on demand (those are resource errors such as 701 or 1105), and that path must still
    /// end the set as incomplete and go on with the batch.</summary>
    internal Func<Exception?>? RowFault { get; set; }
    /// <summary>Called when a batch's reader has reported the batch's end, just before the script asks whether its token
    /// fired meanwhile. Only the live checks set it, to cancel there as SqlClient's rare silent cancel does (see the batch
    /// loop), which no server does on demand.</summary>
    internal Action? ReaderEnded { get; set; }
    /// <summary>Called with each statement a commit or a state read is about to send in a tab's session; an exception it
    /// returns is thrown there. Only the live checks set it, to raise the fatal transport error managed SNI can report before
    /// Connection.State changes, which no server raises on demand.</summary>
    internal Func<string, Exception?>? SessionFault { get; set; }

    /// <param name="store">Defaults to the system budget (<see cref="ResultStore.FromSystem"/>).</param>
    /// <param name="hooks">Adds debug.results.synthesize (VARIA_BACKEND_TEST_HOOKS=1, set by main only for smoke tests).</param>
    /// <param name="publish">Sends a global EVENT and says whether it was queued. Memory usage is sampled once a second
    /// and after operations that release it.</param>
    /// <param name="actionsCatalog">The object actions' catalogue; the checks pass one that marks an action long (D1c) before D1f does.</param>
    public SqlService(ResultStore? store = null, bool hooks = false, Func<object, bool>? publish = null, ActionsCatalog? actionsCatalog = null)
    {
        this.store = store ?? ResultStore.FromSystem();
        jobs = new ResultJobs(this.store);
        this.hooks = hooks;
        this.publish = publish;
        Methods = hooks ? [.. MethodNames, SynthesizeMethod] : MethodNames;
        // Registers the Entra provider with SqlClient before any connection string can name it.
        entra = EntraService.Shared;
        Open = async (connection, token) =>
        {
            await entra.OpenPooledAsync(connection, token, OpenConnection);
            Record(connection);
        };
        explorer = new ExplorerService(this);
        search = new ObjectSearchService(this);
        scripting = new ScriptingService(this);
        actions = new ActionService(this, catalog: actionsCatalog);
        ssis = new SsisService(this);
        ssisActions = new SsisActionService(this, ssis);
        live = new LiveService(this);
        sessionActions = new SessionActions(this, live);
        if (publish is not null) memoryTimer = new Timer(_ => { ReportMemory(); ReportIndexMemory(); }, null, 1000, 1000);
    }

    /// <summary>The service as the backend process runs it. Test hooks, and the budget override VARIA_RESULT_BUDGET_BYTES,
    /// apply only with VARIA_BACKEND_TEST_HOOKS=1; main passes those variables only to unpackaged smoke runs.</summary>
    public static SqlService FromEnvironment(Func<object, bool>? publish)
    {
        var hooks = Environment.GetEnvironmentVariable("VARIA_BACKEND_TEST_HOOKS") == "1";
        long? budget = hooks && long.TryParse(Environment.GetEnvironmentVariable("VARIA_RESULT_BUDGET_BYTES"), NumberStyles.None, CultureInfo.InvariantCulture, out var bytes) && bytes > 0 ? bytes : null;
        return new SqlService(ResultStore.FromSystem(budget), hooks, publish);
    }

    public IReadOnlyList<string> Methods { get; }
    /// <summary>Stored query results (the live checks read them back through it).</summary>
    public ResultStore Results => store;
    /// <summary>Object Explorer's node provider (the checks set its test options).</summary>
    public ExplorerService Explorer => explorer;
    /// <summary>The object index (the checks set its limits and read its budget).</summary>
    internal ObjectSearchService Search => search;
    /// <summary>Script As (the checks set its test options).</summary>
    public ScriptingService Scripting => scripting;
    /// <summary>Object actions (the checks reach its dry run and test options).</summary>
    public ActionService Actions => actions;
    /// <summary>The SSIS Catalog's reads (the checks point it at a fake catalog through its options).</summary>
    public SsisService Ssis => ssis;
    /// <summary>The SSIS Catalog's writes (the checks reach its session seam; it shares Ssis's options).</summary>
    public SsisActionService SsisActions => ssisActions;
    /// <summary>Microsoft Entra ID (the checks replace its token source).</summary>
    internal EntraService Entra => entra;
    /// <summary>Live subscriptions (the checks count them).</summary>
    internal LiveService Live => live;
    /// <summary>Activity Monitor's Details and Kill (the checks shorten their budgets).</summary>
    internal SessionActions SessionActions => sessionActions;
    bool ILiveHost.TestHooks => hooks;
    bool ILiveHost.IsConnected(string connectionId) => connections.ContainsKey(connectionId);
    string? ILiveHost.ServerOf(string connectionId) => ServerOf(connectionId);
    ResultStore ILiveHost.Store => store;
    ServerProfile? ILiveHost.Profile(string connectionId) => connections.ContainsKey(connectionId) && profiles.TryGetValue(connectionId, out var profile) ? profile : null;
    /// <summary>The live views' pools: idle connection resiliency is off, so a session that was killed or dropped is a
    /// CONNECTION_LOST value and a new session id in the next tick, never a silent reconnect under the old one.</summary>
    SqlConnection ILiveHost.PoolConnection(string connectionId, string? database, string suffix) => PoolConnection(connectionId, database, suffix, reconnect: false);
    Task ILiveHost.OpenAsync(SqlConnection connection, CancellationToken token) => Open(connection, token);
    IReadOnlyCollection<VariaClient> ILiveHost.Clients => [.. connections.Values.Select(text => new SqlConnectionStringBuilder(text)).Select(builder => new VariaClient(builder.ApplicationName, Workstation(builder))).Distinct()];

    /// <summary>The host name SqlClient sends at login: the Workstation ID when one is set, else this machine's name.</summary>
    internal static string Workstation(SqlConnectionStringBuilder builder) => builder.WorkstationID is { Length: > 0 } id ? id : Environment.MachineName;

    IReadOnlySet<int> ILiveHost.OwnSessions(string connectionId) => ownSessions.Sessions(connectionId, ServerOf);
    /// <summary>Varia's own session ids (the checks record and read them).</summary>
    internal OwnSessionLedger OwnSessions => ownSessions;
    /// <summary>The ids the pooled connections were given (the checks record a stale one, as a cleared pool leaves it).</summary>
    internal OwnSessionLedger PoolSessionLedger => poolSessions;

    /// <summary>Own: under one of Varia's own program names (a pool's, Object Actions'), which the Activity Monitor trusts; a plain
    /// pooled connection is recorded only for freeing a database.</summary>
    private sealed record Owner(string ConnectionId, bool Pooled, bool Own);

    /// <summary>Marks a connection made for a connection id under one of Varia's own program names (a pool's, Object
    /// Actions'), or a plain pooled one (<paramref name="own"/> false), so <see cref="Open"/> records the session it is given.
    /// Every such connection must be made through here.</summary>
    private SqlConnection Owned(SqlConnection connection, string connectionId, bool own = true)
    {
        owners.AddOrUpdate(connection, new(connectionId, new SqlConnectionStringBuilder(connection.ConnectionString).Pooling, own));
        return connection;
    }

    /// <summary>Records the session id an owned connection was given as it opened (a pooled connection keeps its physical
    /// session's), and lets it go as the connection closes, so the Activity Monitor knows Varia's own sessions by what Varia
    /// holds, not by what a client may claim at login. Done in <see cref="Open"/>, so every host that opens an owned connection
    /// records it.</summary>
    private void Record(SqlConnection connection)
    {
        if (!owners.TryGetValue(connection, out var owner) || connection.State != System.Data.ConnectionState.Open || !connections.ContainsKey(owner.ConnectionId)) return;
        OwnSessionLedger[] ledgers = owner.Own ? owner.Pooled ? [ownSessions, poolSessions] : [ownSessions] : owner.Pooled ? [poolSessions] : [];
        if (ledgers.Length == 0) return;
        var session = connection.ServerProcessId;
        foreach (var ledger in ledgers) ledger.Opened(owner.ConnectionId, session, owner.Pooled);
        System.Data.StateChangeEventHandler? closed = null;
        closed = (_, change) =>
        {
            if (change.CurrentState == System.Data.ConnectionState.Open) return;
            connection.StateChange -= closed;
            foreach (var ledger in ledgers) ledger.Closed(owner.ConnectionId, session);
        };
        connection.StateChange += closed;
        // A connection that closed before the handler was in place said so to nobody.
        if (connection.State != System.Data.ConnectionState.Open) closed(connection, new(System.Data.ConnectionState.Open, connection.State));
    }
    bool IActivityHost.IsConnected(string connectionId) => connections.ContainsKey(connectionId);
    ServerProfile? IActivityHost.Profile(string connectionId) => ((ILiveHost)this).Profile(connectionId);
    /// <summary>Activity Monitor's session actions read on the monitor's pool, in master where the live pool is (LiveConnections.Pool).</summary>
    SqlConnection IActivityHost.MonitorConnection(string connectionId) =>
        PoolConnection(connectionId, LiveConnections.Pool("server", "activity", Profile(connectionId), ssis.Options.CatalogDatabase).Database, LiveConnections.ServerSuffix, reconnect: false);
    SqlConnection IActivityHost.KillConnection(string connectionId) => ((IActionHost)this).Connection(connectionId);
    Task IActivityHost.OpenAsync(SqlConnection connection, CancellationToken token) => Open(connection, token);
    IReadOnlyCollection<string> IActivityHost.ApplicationNames() =>
        connections.Values.Select(connectionString => new SqlConnectionStringBuilder(connectionString).ApplicationName).ToHashSet(StringComparer.Ordinal);
    string ILiveHost.SsisCatalog => ssis.Options.CatalogDatabase;
    bool ILiveHost.SsisIgnoresLinux => ssis.Options.IgnoreLinuxHost;

    /// <summary>The server a connection reaches: its own name (SERVERPROPERTY('ServerName'), probed at connect), so two
    /// connections to one server count as one whatever name, login or database they used; the connection's data source when
    /// the probe failed. Null when the id is not connected.</summary>
    internal string? ServerOf(string connectionId)
    {
        if (!connections.TryGetValue(connectionId, out var connectionString)) return null;
        if (profiles.TryGetValue(connectionId, out var profile) && !string.IsNullOrWhiteSpace(profile.ServerName)) return "server:" + profile.ServerName.Trim().ToUpperInvariant();
        return "source:" + new SqlConnectionStringBuilder(connectionString).DataSource.Trim().ToUpperInvariant();
    }

    /// <summary>Cancellation and cleanup never wait for a slot, and scripts are bounded by the per-tab session limit, so
    /// long-running queries cannot starve Object Explorer and connection requests of the 8 metadata slots. Result reads,
    /// copies and exports take one of 16 result slots.</summary>
    public RequestLane LaneOf(string method) => method switch
    {
        "query.execute" => RequestLane.Query,
        "results.read" or "results.copy" or "results.export" => RequestLane.Results,
        "explorer.children" or "explorer.index" or "explorer.search" => RequestLane.Explorer,
        "actions.execute" => RequestLane.Actions,
        "ssis.describe" or "ssis.execute" or "ssis.catalogSetup" => RequestLane.Ssis,
        "live.subscribe" or "activity.details" => RequestLane.Live,
        // Kill Process takes no metadata slot: it runs at once under its own gates, as object actions do under theirs.
        "activity.kill" => RequestLane.Actions,
        "system.health" or "connections.disconnect" or "query.cancel" or "query.session.close" or "query.session.state" or "results.close" or "entra.cache.clear"
            or "live.update" => RequestLane.Control,
        SynthesizeMethod when hooks => RequestLane.Metadata,
        _ when Array.IndexOf(MethodNames, method) < 0 => RequestLane.Control,
        _ => RequestLane.Metadata
    };

    /// <summary>Stop on DDL and on SSIS Catalog writes answers with the steps that completed, once SQL Server ends the statement.</summary>
    public bool AnswersStop(string method) => method is "actions.execute" or "ssis.execute";

    /// <summary>The methods whose frames may carry a password or a sensitive value: methodPolicies' sensitive entries
    /// (tests/validation.test.ts compares the two lists), zeroed here as main zeroes its copy.</summary>
    internal static readonly string[] SensitiveMethods = ["connections.connect", "connections.databases", "connections.preview", "ssis.execute", "actions.execute"];
    public bool Sensitive(string method) => Array.IndexOf(SensitiveMethods, method) >= 0;

    /// <summary>The result memory budget: global, and the most one query may use.</summary>
    public (long GlobalBytes, long QueryBytes) ResultBudget => (store.GlobalBytes, store.QueryBytes);

    /// <summary>The request's token: CANCEL frames and its header deadline. Live checks call without a context.</summary>
    private static CancellationToken Token(RequestContext? context) => context?.Token ?? CancellationToken.None;

    public async Task<object> DispatchAsync(string method, JsonElement parameters, JsonSerializerOptions json, RequestContext? context = null) => method switch
    {
        "system.health" => health ??= new
        {
            ProtocolVersion = ProtocolLimits.Version,
            Runtime = RuntimeInformation.FrameworkDescription,
            Platform = RuntimeInformation.OSDescription,
            SmoVersion = typeof(Server).Assembly.GetName().Version?.ToString(),
            SqlClientVersion = typeof(SqlConnection).Assembly.GetName().Version?.ToString()
        },
        "connections.connect" => await ConnectAsync(Read<ConnectOptions>(parameters, json), Token(context)),
        "connections.databases" => await DiscoverDatabasesAsync(Read<ConnectOptions>(parameters, json), Token(context)),
        "connections.discover" => await discovery.DiscoverAsync(Read<DiscoveryArgs>(parameters, json)),
        "connections.preview" => ConnectionSettings.Preview(Read<ConnectOptions>(parameters, json)),
        "connections.disconnect" => Disconnect(Read<ConnectionArgs>(parameters, json)),
        "connections.identity" => await IdentityAsync(Read<IdentityArgs>(parameters, json), Token(context)),
        "databases.list" => await DatabasesAsync(Read<ConnectionArgs>(parameters, json), Token(context)),
        "tables.columns" => await ColumnsAsync(Read<TableArgs>(parameters, json), Token(context)),
        "query.execute" => await ExecuteAsync(Read<QueryArgs>(parameters, json), context),
        "query.cancel" => Cancel(Read<CancelArgs>(parameters, json)),
        "query.session.close" => await CloseSessionAsync(Read<SessionArgs>(parameters, json), Token(context)),
        "query.session.state" => await SessionStateAsync(Read<SessionStateArgs>(parameters, json), Token(context)),
        "results.read" => await ReadResultsAsync(Read<ResultsReadArgs>(parameters, json), context),
        "results.close" => CloseResults(Read<ResultsCloseArgs>(parameters, json)),
        "results.copy" => await jobs.CopyAsync(Read<ResultsCopyArgs>(parameters, json), context),
        "results.export" => await jobs.ExportAsync(Read<ResultsExportArgs>(parameters, json), context),
        "explorer.children" => await explorer.ChildrenAsync(Read<ExplorerChildrenArgs>(parameters, json), Token(context)),
        // The build reports how far it got as droppable explorer.index.progress EVENTs on the request.
        "explorer.index" => await search.IndexAsync(Read<ObjectIndexArgs>(parameters, json), Token(context), context is null ? null : value => context.SendEvent(value, droppable: true)),
        "explorer.search" => search.Search(Read<ObjectSearchArgs>(parameters, json), Token(context)),
        "scripting.script" => await scripting.ScriptAsync(Read<ScriptArgs>(parameters, json), Token(context)),
        "actions.describe" => await actions.DescribeAsync(Read<ActionDescribeArgs>(parameters, json), Token(context)),
        "actions.script" => await actions.ScriptAsync(Read<ActionArgs>(parameters, json), Token(context)),
        // A long step's 3211 progress goes out as droppable action.progress EVENTs on the request (ActionProgress).
        "actions.execute" => await actions.ExecuteAsync(Read<ActionArgs>(parameters, json), Token(context), context is null ? null : value => context.SendEvent(value, droppable: true)),
        "entra.cache.clear" => ClearEntra(Read<EntraCacheArgs>(parameters, json)),
        "ssis.describe" => await ssis.DescribeAsync(Read<SsisDescribeArgs>(parameters, json), Token(context)),
        "ssis.execute" => await ssisActions.ExecuteAsync(Read<SsisExecuteArgs>(parameters, json), Token(context)),
        "ssis.catalogSetup" => await ssis.CatalogSetupAsync(Read<SsisCatalogSetupArgs>(parameters, json), Token(context)),
        "live.subscribe" => await live.SubscribeAsync(Read<LiveSubscribeArgs>(parameters, json), context, json),
        "live.update" => live.Update(Read<LiveUpdateArgs>(parameters, json), json),
        "activity.details" => await sessionActions.DetailsAsync(Read<ActivityDetailsArgs>(parameters, json), Token(context)),
        "activity.kill" => await sessionActions.KillAsync(Read<ActivityKillArgs>(parameters, json), Token(context)),
        SynthesizeMethod when hooks => Synthesize(Read<SynthesizeArgs>(parameters, json), Token(context)),
        _ => throw new RequestException("METHOD_NOT_FOUND", "Unsupported backend method.")
    };

    private static T Read<T>(JsonElement value, JsonSerializerOptions json) => value.Deserialize<T>(json)
        ?? throw new RequestException("INVALID_PARAMS", "Parameters are required.");

    private static string Name(string? value, int maxLength = 128)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > maxLength)
            throw new RequestException("INVALID_PARAMS", "A valid server, database, or object name is required.");
        return value;
    }

    internal async Task<ConnectionInfo> ConnectAsync(ConnectOptions options, CancellationToken token)
    {
        if (!EntraModes.IsKnown(options.Authentication))
            throw new RequestException("INVALID_PARAMS", "Unsupported authentication mode.");
        entra.Refuse(options);
        var builder = ConnectBuilder(options);
        // For MFA without a user name, the connection string kept names the account its token is for.
        var (opened, connectionString) = await OpenForUserAsync(builder.ConnectionString, options, null, token);
        await using var connection = opened;
        var profile = await ServerProfile.ProbeAsync(connection, token);
        var id = Register(connectionString, profile, connection.Database);
        // The connect's own session waits in the plain pool, in the connection's database, until the pool prunes it.
        if (new SqlConnectionStringBuilder(connectionString).Pooling)
        {
            poolSessions.Opened(id, connection.ServerProcessId, pooled: true);
            poolSessions.Closed(id, connection.ServerProcessId);
        }
        var probed = profile.ProductVersion is not null;
        return new(id, options.Server, connection.Database, connection.ServerVersion, options.DisplayName, options.Color, builder.CommandTimeout,
            profile.ProductVersion, profile.Login, probed ? profile.EngineEdition : null, probed ? profile.Linux : null);
    }

    /// <summary>Records a connected profile under a new id: its settings, the server's profile, and the database its session
    /// landed in (the login's default when the settings name none). ConnectAsync's, and the offline checks', which have no server.</summary>
    internal string Register(string connectionString, ServerProfile profile, string database)
    {
        var id = Guid.NewGuid().ToString();
        profiles[id] = profile;
        homes[id] = database;
        connections[id] = connectionString;
        pools[id] = new() { [connectionString] = 0 };
        return id;
    }

    /// <summary>The connection's settings, which its other pools derive from. SqlClient's pool blocking (Auto blocks for every
    /// server but Azure SQL) keeps a failed open's exception and rethrows it for every open during 5 to 60 seconds without
    /// trying: a Connect after kinit, or Object Explorer's retry after a ticket expired, would show the stale failure (and,
    /// with a ticket now there, the wrong Kerberos advice). Every open the user asks for must reach the server.</summary>
    internal static SqlConnectionStringBuilder ConnectBuilder(ConnectOptions options)
    {
        var builder = ConnectionSettings.Build(options);
        builder.PoolBlockingPeriod = PoolBlockingPeriod.NeverBlock;
        return builder;
    }

    /// <summary>Opens connections made from a connected profile: query sessions, Object Explorer, Script As, object actions,
    /// and database and column lists (<see cref="OpenConnection"/>, then the Entra mapping, which never opens a browser), and
    /// records the session of a connection made through <see cref="Owned"/>. The live checks replace it to fail as an
    /// expired Kerberos ticket does.</summary>
    internal Func<SqlConnection, CancellationToken, Task> Open { get; set; }
    /// <summary>The open inside <see cref="Open"/>; the live checks replace it to fail as a revoked Entra sign-in does, so the
    /// mapping around it is the production one.</summary>
    internal Func<SqlConnection, CancellationToken, Task> OpenConnection { get; set; } = ConnectionFailures.OpenAsync;

    internal async Task<List<DatabaseInfo>> DiscoverDatabasesAsync(ConnectOptions options, CancellationToken token)
    {
        // Use the login's default database to discover choices, even if the typed database is stale.
        var builder = ConnectionSettings.Build(options with { Database = "", Advanced = (options.Advanced ?? new()) with { AttachDbFilename = "" } });
        builder.Pooling = false;
        entra.Refuse(options);
        // One budget for the opens and the read; an MFA sign-in in the browser between two opens has its own 3 minutes.
        var budget = new OpenBudget(DiscoveryLimit);
        var (opened, _) = await OpenForUserAsync(builder.ConnectionString, options, budget, token);
        await using var connection = opened;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(budget.Remaining);
        return await ReadDatabasesAsync(connection, deadline.Token);
    }
    /// <summary>Load databases' deadline (30 seconds), not counting a browser sign-in; the checks shorten it.</summary>
    internal TimeSpan DiscoveryLimit { get; set; } = TimeSpan.FromSeconds(30);

    /// <summary>A deadline shared by a request's opens and what follows them, which a browser sign-in between two opens does
    /// not use up.</summary>
    private sealed class OpenBudget(TimeSpan total)
    {
        private TimeSpan spent;
        internal TimeSpan Remaining => spent < total ? total - spent : TimeSpan.Zero;

        internal async Task<T> SpendAsync<T>(Func<TimeSpan, Task<T>> work)
        {
            var watch = Stopwatch.StartNew();
            try { return await work(Remaining); }
            finally { spent += watch.Elapsed; }
        }
    }

    /// <summary>Opens a connection the user is choosing (connect and database discovery), so a failure carries its details,
    /// integrated authentication on Linux and macOS (Kerberos through SqlClient's managed SNI) says what to fix, and
    /// Microsoft Entra MFA signs in through the browser when it must (EntraService). A cancelled or timed-out attempt is
    /// left to the host, which answers it CANCELLED or TIMEOUT; Stop answers at once, even while SqlClient still waits.</summary>
    /// <param name="budget">The opens' deadline, if any (the sign-in between two opens is not counted).</param>
    private async Task<(SqlConnection Connection, string ConnectionString)> OpenForUserAsync(string connectionString, ConnectOptions options, OpenBudget? budget, CancellationToken token)
    {
        try
        {
            return await entra.OpenForUserAsync(connectionString, options.Server,
                (text, cancel) => budget is null ? OpenUser(text, null, cancel) : budget.SpendAsync(remaining => OpenUser(text, remaining, cancel)),
                static connection => connection.ClientConnectionId, token);
        }
        catch (Exception error) when (!token.IsCancellationRequested && error is not (RequestException or OperationCanceledException)
            && ConnectionFailures.Describe(error, options.Server, ConnectionFailures.UsesKerberos(options), KerberosProbe.Inspect) is { } failure)
        {
            throw EntraFailures.WithClearHint(failure, options.Authentication);
        }
    }

    /// <summary>One open of a connection the user is choosing, under its own time limit, if any. The checks replace it to fail
    /// as a login that needs a Microsoft Entra sign-in does.</summary>
    internal Func<string, TimeSpan?, CancellationToken, Task<SqlConnection>> OpenUser { get; set; } = OpenAttemptAsync;

    private static async Task<SqlConnection> OpenAttemptAsync(string connectionString, TimeSpan? limit, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        if (limit is { } value) deadline.CancelAfter(value);
        return await OpenAbandonableAsync(new SqlConnection(connectionString), deadline.Token);
    }

    /// <summary>Opens the connection, or gives it up at once when the token is cancelled: SqlClient does not stop a login
    /// while it gets a token (its provider runs synchronously) or while a credential chain runs, so the abandoned open
    /// finishes on its own, bounded by the connect timeout, and the connection is closed then. Owns the connection: it is
    /// returned open, or disposed.</summary>
    /// <param name="open">Replaces SqlConnection.OpenAsync (the checks).</param>
    internal static async Task<SqlConnection> OpenAbandonableAsync(SqlConnection connection, CancellationToken token, Func<SqlConnection, CancellationToken, Task>? open = null)
    {
        Task opening;
        try { opening = open is null ? connection.OpenAsync(token) : open(connection, token); }
        catch { await connection.DisposeAsync(); throw; }
        try
        {
            await opening.WaitAsync(token);
            return connection;
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested && !opening.IsCompleted)
        {
            _ = opening.ContinueWith(static (task, state) => { _ = task.Exception; ((SqlConnection)state!).Dispose(); }, connection, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
            throw;
        }
        catch
        {
            await connection.DisposeAsync();
            throw;
        }
    }

    /// <summary>Help › Clear Entra ID Token Cache.</summary>
    private object ClearEntra(EntraCacheArgs _)
    {
        entra.Clear();
        return new EntraCacheClearResult(true);
    }

    /// <summary>Reads the default credential cache's principal for connections.identity (KerberosProbe.Identity); the checks
    /// replace it.</summary>
    internal Func<KerberosIdentity> IdentityProbe { get; set; } = KerberosProbe.Identity;
    private readonly Lock identityGate = new();
    private Task<KerberosIdentity>? identityLookup;

    /// <summary>The Connect dialog's User Name under Windows Authentication off Windows. Each dialog asks, so a credential
    /// cache that does not answer (a stuck KCM daemon) holds one pool thread, every caller waits on that one lookup, and
    /// each request still ends (and frees its metadata slot) at its deadline.</summary>
    internal async Task<IntegratedIdentity> IdentityAsync(IdentityArgs _, CancellationToken token)
    {
        Task<KerberosIdentity> lookup;
        lock (identityGate)
        {
            if (identityLookup is not { IsCompleted: false }) identityLookup = Task.Run(IdentityProbe, CancellationToken.None);
            lookup = identityLookup;
        }
        var identity = await lookup.WaitAsync(token);
        return new(identity.State == KerberosState.Valid ? KerberosProbe.Bounded(identity.Principal) : null);
    }

    private object Disconnect(ConnectionArgs args)
    {
        var removed = connections.TryRemove(args.ConnectionId, out var connectionString);
        profiles.TryRemove(args.ConnectionId, out _);
        serverScopeInMaster.TryRemove(args.ConnectionId, out _);
        homes.TryRemove(args.ConnectionId, out _);
        ownSessions.Forget(args.ConnectionId);
        poolSessions.Forget(args.ConnectionId);
        explorer.Forget(args.ConnectionId);
        search.Forget(args.ConnectionId);
        ReportIndexMemory();
        scripting.Forget(args.ConnectionId);
        actions.Forget(args.ConnectionId);
        ssis.Forget(args.ConnectionId);
        ssisActions.Forget(args.ConnectionId);
        live.Forget(args.ConnectionId);
        sessionActions.Forget(args.ConnectionId);
        foreach (var query in queries.Values.Where(query => query.ConnectionId == args.ConnectionId)) query.Cancel();
        foreach (var item in sessions.Where(item => item.Value.ConnectionId == args.ConnectionId))
            if (sessions.TryRemove(item.Key, out var session)) session.Close();
        // Results stay readable, copyable and saveable after a disconnect, as in SSMS.
        // Each initial catalog has its own pool; clear every one this connection used.
        if (removed && pools.TryRemove(args.ConnectionId, out var used))
            foreach (var pooled in used.Keys)
            {
                using var connection = new SqlConnection(pooled);
                SqlConnection.ClearPool(connection);
            }
        return new { Disconnected = removed };
    }

    private SqlConnection CreateConnection(string id, string? database = null, bool stateful = false)
    {
        if (!connections.TryGetValue(id, out var connectionString))
            throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");
        var builder = new SqlConnectionStringBuilder(connectionString);
        if (database is not null) builder.InitialCatalog = Name(database);
        else if (!stateful && serverScopeInMaster.ContainsKey(id)) builder.InitialCatalog = "master";
        if (stateful)
        {
            // Never let idle connection recovery silently replace a tab's SQL session state.
            builder.ConnectRetryCount = 0;
            // Closing a tab must end its server session so open transactions roll back and release locks;
            // a pooled connection would keep them open until the pool reused or pruned it.
            builder.Pooling = false;
        }
        else if (pools.TryGetValue(id, out var used)) used.TryAdd(builder.ConnectionString, 0);
        return stateful ? new SqlConnection(builder.ConnectionString) : Owned(new SqlConnection(builder.ConnectionString), id, own: false);
    }

    ServerProfile IExplorerHost.Profile(string connectionId) => Profile(connectionId);
    ServerProfile IScriptingHost.Profile(string connectionId) => Profile(connectionId);
    ServerProfile IActionHost.Profile(string connectionId) => Profile(connectionId);

    /// <summary>Object actions' own connection: unpooled, so DDL settings and a database it used never outlive the request,
    /// and never retried, so a DDL request is never sent twice. It starts in master on box servers, so it never holds the
    /// database it renames or drops.</summary>
    SqlConnection IActionHost.Connection(string connectionId)
    {
        if (!connections.TryGetValue(connectionId, out var connectionString)) throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");
        var builder = new SqlConnectionStringBuilder(connectionString) { Pooling = false, ConnectRetryCount = 0, CommandTimeout = 0, InitialCatalog = "master" };
        var name = builder.ApplicationName + " - Object Actions";
        builder.ApplicationName = name.Length > 128 ? name[..128] : name;
        return Owned(new SqlConnection(builder.ConnectionString), connectionId);
    }

    Task IActionHost.OpenAsync(SqlConnection connection, CancellationToken token) => Open(connection, token);

    /// <summary>Critic A5, for every connection of this backend to the same server: when its own database (the Connect dialog's
    /// Database, or the login's default) is the one an action needs to itself, its server-scope pools open in master from now on,
    /// unless its login cannot open master (a contained database user, or a sign-in the probe could not check); then its idle
    /// pools in the database are cleared. True when it cleared a pool.</summary>
    public bool FreeDatabase(string connectionId, string database)
    {
        var cleared = false;
        foreach (var id in SameServer(connectionId))
        {
            if (connections.TryGetValue(id, out var current) && string.Equals(DatabaseOf(id, current), database, StringComparison.OrdinalIgnoreCase)
                && profiles.TryGetValue(id, out var profile) && profile.ServerScopeInMaster)
                serverScopeInMaster.TryAdd(id, 0);
            cleared |= ClearPoolsFor(id, database);
        }
        return cleared;
    }

    /// <summary>The session ids of the pooled connections of every connection to the server: those still in a database a moment
    /// after FreeDatabase cleared its pools are the backend's own, which the server is ending.</summary>
    public IReadOnlySet<int> PoolSessions(string connectionId) => poolSessions.Sessions(connectionId, ServerOf);

    /// <summary>The SPIDs of the open query sessions on connections to the server (IActionHost.QuerySessions).</summary>
    public IReadOnlySet<int> QuerySessions(string connectionId)
    {
        var server = ServerOf(connectionId);
        return server is null ? new HashSet<int>() : sessions.Values.Where(session => session.Spid is not null && session.Connection.State == System.Data.ConnectionState.Open
            && ServerOf(session.ConnectionId) == server).Select(session => session.Spid!.Value).ToHashSet();
    }

    /// <summary>The open query sessions on connections to the server by SPID, each with its session id (IActionHost.QueryTabs).</summary>
    public IReadOnlyDictionary<int, string> QueryTabs(string connectionId)
    {
        var server = ServerOf(connectionId);
        var tabs = new Dictionary<int, string>();
        if (server is null) return tabs;
        foreach (var (id, session) in sessions)
            if (session.Spid is { } spid && session.Connection.State == System.Data.ConnectionState.Open && ServerOf(session.ConnectionId) == server) tabs[spid] = id;
        return tabs;
    }

    private static string Program(string application, string suffix)
    {
        var name = application + suffix;
        return name.Length > 128 ? name[..128] : name;
    }

    IReadOnlyList<string> IActionHost.SameServer(string connectionId) => SameServer(connectionId);

    /// <summary>The connection itself, then every other connection of this backend that reaches its server (ServerOf).</summary>
    private List<string> SameServer(string connectionId)
    {
        if (ServerOf(connectionId) is not { } server) return [];
        return [connectionId, .. connections.Keys.Where(id => id != connectionId && ServerOf(id) == server)];
    }

    /// <summary>The database a connection string's sessions open in: its Initial Catalog, or the connection's home (the login's
    /// default, read at connect) when it names none.</summary>
    private string? DatabaseOf(string connectionId, string connectionString) =>
        new SqlConnectionStringBuilder(connectionString).InitialCatalog is { Length: > 0 } catalog ? catalog : homes.TryGetValue(connectionId, out var home) ? home : null;

    /// <summary>Where a connection's server-scope pools open: null (its own database) until an action freed that database, then master.</summary>
    internal string? ServerScopeDatabase(string connectionId) => serverScopeInMaster.ContainsKey(connectionId) ? "master" : null;

    /// <summary>Idle pooled connections in the database (Object Explorer's and scripting's per-database pools, and a server-scope
    /// pool whose database it is, named or the login's default) keep it in use: DROP DATABASE and MODIFY NAME would fail while the
    /// server stays connected. Clearing them closes the idle ones; busy ones are discarded when they return. True when it cleared a pool.</summary>
    public bool ClearPoolsFor(string connectionId, string database)
    {
        if (!pools.TryGetValue(connectionId, out var used)) return false;
        var cleared = false;
        foreach (var pooled in used.Keys)
        {
            if (!string.Equals(DatabaseOf(connectionId, pooled), database, StringComparison.OrdinalIgnoreCase)) continue;
            using var connection = new SqlConnection(pooled);
            SqlConnection.ClearPool(connection);
            cleared = true;
        }
        return cleared;
    }

    /// <summary>After a rename or drop of a database that a connection to this server was opened in (the Connect dialog's Database,
    /// or the login's default), every connection derived from it would fail to open: each such connection moves to the new name,
    /// or to master after a drop, and the old database's pools are cleared.</summary>
    public void DatabaseChanged(string connectionId, string database, string? newName)
    {
        foreach (var id in SameServer(connectionId))
        {
            // First: a pool whose settings name no database is in the home, which changes below.
            ClearPoolsFor(id, database);
            if (!connections.TryGetValue(id, out var current) || !string.Equals(DatabaseOf(id, current), database, StringComparison.OrdinalIgnoreCase)) continue;
            var builder = new SqlConnectionStringBuilder(current) { InitialCatalog = newName ?? "master" };
            if (!connections.TryUpdate(id, builder.ConnectionString, current)) continue;
            homes[id] = builder.InitialCatalog;
            if (pools.TryGetValue(id, out var used)) used.TryAdd(builder.ConnectionString, 0);
        }
    }

    /// <summary>After Login Properties changed a SQL Server login's password: each connection to the same server that signed in as
    /// that login with SQL Server authentication (its profile's SUSER_SNAME, so never a contained database user or another login of a
    /// similar name) keeps the new password for its later sessions. Sessions already open stay signed in.</summary>
    public void PasswordChanged(string connectionId, string login, string password)
    {
        foreach (var id in SameServer(connectionId))
        {
            if (!connections.TryGetValue(id, out var current) || !profiles.TryGetValue(id, out var profile) || profile.Contained || !string.Equals(profile.Login, login, StringComparison.Ordinal)) continue;
            var builder = new SqlConnectionStringBuilder(current);
            if (builder.IntegratedSecurity || builder.Authentication is not (SqlAuthenticationMethod.NotSpecified or SqlAuthenticationMethod.SqlPassword)) continue;
            builder.Password = password;
            connections.TryUpdate(id, builder.ConnectionString, current);
        }
    }

    private ServerProfile Profile(string connectionId) =>
        connections.ContainsKey(connectionId) && profiles.TryGetValue(connectionId, out var profile) ? profile : throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");

    /// <summary>Object Explorer's own pool: the connection's settings under a distinct program name (as SSMS does), so its
    /// READ UNCOMMITTED and LOCK_TIMEOUT never reach query tabs, SMO or databases.list. It keeps the login's initial
    /// catalog (contained-database users), and is cleared with the connection's other pools on disconnect.</summary>
    SqlConnection IExplorerHost.Connection(string connectionId, string? database) => PoolConnection(connectionId, database, ExplorerPool);
    private const string ExplorerPool = " - Object Explorer", ScriptingPool = " - Scripting", SearchPool = " - Object Search";

    ServerProfile IObjectSearchHost.Profile(string connectionId) => Profile(connectionId);
    /// <summary>The object index's own pool, so its reads never wait behind (or hold) Object Explorer's, under its own program name.</summary>
    SqlConnection IObjectSearchHost.Connection(string connectionId, string? database) => PoolConnection(connectionId, database, SearchPool);
    Task IObjectSearchHost.OpenAsync(SqlConnection connection, CancellationToken token) => Open(connection, token);

    /// <summary>Scripting's own pool, for the same reasons: its READ COMMITTED, LOCK_TIMEOUT 10 s and SMO's USE never
    /// reach the other pools, and each job restores its database before the connection returns to the pool.</summary>
    SqlConnection IScriptingHost.Connection(string connectionId, string? database) => PoolConnection(connectionId, database, ScriptingPool);

    Task IExplorerHost.OpenAsync(SqlConnection connection, CancellationToken token) => Open(connection, token);

    /// <summary>The SSIS read pool (D-ssis 1.4): tree listings, describes and later live reads, under its own program name, in
    /// the catalog's database on every engine, so no statement crosses databases. Its prologues fix isolation and lock timeouts.</summary>
    SqlConnection IExplorerHost.SsisConnection(string connectionId) => PoolConnection(connectionId, ssis.Options.CatalogDatabase, SsisPool);
    string IExplorerHost.SsisCatalog => ssis.Options.CatalogDatabase;
    ServerProfile ISsisHost.Profile(string connectionId) => Profile(connectionId);
    SqlConnection ISsisHost.SsisConnection(string connectionId, string catalogDatabase) => PoolConnection(connectionId, catalogDatabase, SsisPool);
    SqlConnection ISsisHost.SsisServerConnection(string connectionId) => PoolConnection(connectionId, null, SsisPool);
    Task ISsisHost.OpenAsync(SqlConnection connection, CancellationToken token) => Open(connection, token);
    private const string SsisPool = " - Integration Services";

    /// <summary>A write's own connection (D-ssis 4.4), as object actions have: unpooled, so its settings and session end with the
    /// request, and never retried, so a write is never sent twice.</summary>
    SqlConnection ISsisHost.SsisActionConnection(string connectionId, string catalogDatabase)
    {
        if (!connections.TryGetValue(connectionId, out var connectionString)) throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");
        var builder = new SqlConnectionStringBuilder(connectionString) { Pooling = false, ConnectRetryCount = 0, CommandTimeout = 0, InitialCatalog = catalogDatabase };
        var name = builder.ApplicationName + " - Integration Services Actions";
        builder.ApplicationName = name.Length > 128 ? name[..128] : name;
        return new SqlConnection(builder.ConnectionString);
    }

    /// <summary>How a connection signed in, from its settings: Windows (Kerberos off Windows), Microsoft Entra ID, or SQL Server authentication.</summary>
    string ISsisHost.Authentication(string connectionId)
    {
        if (!connections.TryGetValue(connectionId, out var connectionString)) throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");
        var builder = new SqlConnectionStringBuilder(connectionString);
        return builder.IntegratedSecurity ? "integrated" : builder.Authentication is SqlAuthenticationMethod.NotSpecified or SqlAuthenticationMethod.SqlPassword ? "sql" : "entra";
    }
    Task IScriptingHost.OpenAsync(SqlConnection connection, CancellationToken token) => Open(connection, token);

    private SqlConnection PoolConnection(string connectionId, string? database, string suffix, bool reconnect = true)
    {
        if (!connections.TryGetValue(connectionId, out var connectionString)) throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");
        var builder = new SqlConnectionStringBuilder(connectionString) { Pooling = true, CommandTimeout = 30 };
        if (!reconnect) builder.ConnectRetryCount = 0;
        builder.ApplicationName = Program(builder.ApplicationName, suffix);
        // Server scope (no database) keeps the connection's own database, which a contained user signs in to, until an action
        // freed that database (critic A5).
        if ((database ?? ServerScopeDatabase(connectionId)) is { } catalog) builder.InitialCatalog = catalog;
        if (pools.TryGetValue(connectionId, out var used)) used.TryAdd(builder.ConnectionString, 0);
        return Owned(new SqlConnection(builder.ConnectionString), connectionId);
    }

    private async Task<List<DatabaseInfo>> DatabasesAsync(ConnectionArgs args, CancellationToken token)
    {
        await using var connection = CreateConnection(args.ConnectionId);
        await Open(connection, token);
        return await ReadDatabasesAsync(connection, token);
    }

    private static async Task<List<DatabaseInfo>> ReadDatabasesAsync(SqlConnection connection, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        // The caller's token carries the deadline; a CommandTimeout expiring with it could desynchronise the connection.
        command.CommandTimeout = 0;
        command.CommandText = "SELECT name, CONVERT(bit, CASE WHEN database_id <= 4 THEN 1 ELSE 0 END), CONVERT(bit, CASE WHEN source_database_id IS NOT NULL THEN 1 ELSE 0 END) FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name;";
        await using var reader = await command.ExecuteReaderAsync(token);
        var result = new List<DatabaseInfo>();
        while (await reader.ReadAsync(token)) result.Add(new(reader.GetString(0), reader.GetBoolean(1), reader.GetBoolean(2)));
        return result;
    }

    private const int MaxColumns = 4096;

    /// <summary>tables.columns' statement, run in the object's database through sp_executesql: the table's or view's id by
    /// schema and name (sys.all_objects, not OBJECT_ID, so no name is parsed), then its columns.</summary>
    internal const string ColumnsSql = "DECLARE @id int = (SELECT o.object_id FROM sys.all_objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id "
        + "WHERE s.name = @schema AND o.name = @name AND o.type IN ('U', 'V'));\n"
        + "SELECT CONVERT(bit, CASE WHEN @id IS NULL THEN 0 ELSE 1 END);\n"
        + "SELECT TOP (4097) c.name, TYPE_NAME(c.user_type_id) FROM sys.all_columns AS c WHERE c.object_id = @id"
        + " AND (c.is_hidden = 0 OR c.generated_always_type <> 0) ORDER BY c.column_id;";
    /// <summary>Runs <see cref="ColumnsSql"/> in the object's database, which reaches T-SQL only through QUOTENAME.</summary>
    internal const string ColumnsCall = "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\n"
        + "EXEC @module @stmt, N'@schema sysname, @name sysname', @schema = @schema, @name = @name;";
    /// <summary>What tables.columns sends: the statement itself on a connection already in the object's database (Azure SQL
    /// Database, or Object Explorer's ForcePerDatabaseScope test seam), else the cross-database call.</summary>
    internal static string ColumnsText(bool perDatabase) => perDatabase ? ColumnsSql : ColumnsCall;
    /// <summary>Whether tables.columns opens its connection in the object's database: on Azure SQL Database, which refuses a
    /// three-part module name (Msg 40515).</summary>
    internal static bool ColumnsPerDatabase(ServerProfile profile, bool force) => profile.Explorer(ExplorerCatalog.Current).Cloud || force;

    // Select Top N Rows lists the columns; QUOTENAME and parameters keep the names out of the SQL text. Hidden internal
    // columns (graph tables' graph_id and node ids) cannot be selected, unlike hidden temporal period and ledger columns,
    // which are GENERATED ALWAYS. On box servers the connection keeps the login's database and reaches the object's through
    // sp_executesql, so no idle pooled connection is left in the object's database to block DROP or MODIFY NAME. Azure SQL
    // Database opens it in the object's database, as Object Explorer does there; object actions are not offered there.
    private async Task<TableColumnsResult> ColumnsAsync(TableArgs args, CancellationToken token)
    {
        Name(args.Database);
        Name(args.Schema);
        Name(args.Name);
        var perDatabase = ColumnsPerDatabase(Profile(args.ConnectionId), explorer.Options.ForcePerDatabaseScope);
        await using var connection = perDatabase ? CreateConnection(args.ConnectionId, args.Database) : CreateConnection(args.ConnectionId);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(30));
        await Open(connection, deadline.Token);
        await using var command = connection.CreateCommand();
        // Only the token's deadline: on a pooled connection that opens at once, a 30 s CommandTimeout would expire on the
        // same tick and could leave the connection a response behind for its next user.
        command.CommandTimeout = 0;
        command.CommandText = ColumnsText(perDatabase);
        if (!perDatabase)
        {
            command.Parameters.Add(new SqlParameter("@db", System.Data.SqlDbType.NVarChar, 128) { Value = args.Database });
            command.Parameters.Add(new SqlParameter("@stmt", System.Data.SqlDbType.NVarChar, -1) { Value = ColumnsSql });
        }
        command.Parameters.Add(new SqlParameter("@schema", System.Data.SqlDbType.NVarChar, 128) { Value = args.Schema });
        command.Parameters.Add(new SqlParameter("@name", System.Data.SqlDbType.NVarChar, 128) { Value = args.Name });
        SqlDataReader reader;
        try { reader = await command.ExecuteReaderAsync(deadline.Token); }
        // Inside EXEC [db].sys.sp_executesql, a missing procedure can only be the wrapper's: the database is gone.
        catch (SqlException error) when (error.Number is 2812 or 911 && !deadline.IsCancellationRequested) { throw new RequestException("NOT_FOUND", "The table or view no longer exists."); }
        await using var reading = reader;
        if (!await reader.ReadAsync(deadline.Token) || !reader.GetBoolean(0)) throw new RequestException("NOT_FOUND", "The table or view no longer exists.");
        await reader.NextResultAsync(deadline.Token);
        var columns = new List<ColumnInfo>();
        while (await reader.ReadAsync(deadline.Token)) columns.Add(new(reader.GetString(0), reader.IsDBNull(1) ? "" : reader.GetString(1)));
        var truncated = columns.Count > MaxColumns;
        if (truncated) columns.RemoveAt(MaxColumns);
        return new(columns, truncated);
    }

    private async Task<QueryResult> ExecuteAsync(QueryArgs args, RequestContext? context)
    {
        if (string.IsNullOrWhiteSpace(args.Sql) || args.Sql.Length > 1_000_000 || args.MaxRows < 0 || args.MaxResultSets is < 1 or > 1000
            || args.TimeoutSeconds is < 0 or > 86400 || args.StartLine is < 1 or > 1_000_000 || !Guid.TryParse(args.QueryId, out _) || !Guid.TryParse(args.SessionId, out _))
            throw new RequestException("INVALID_PARAMS", "Query text, ID, session, timeout, or row limit is invalid.");
        Name(args.Database);
        using var cancellation = args.TimeoutSeconds == 0 ? new CancellationTokenSource() : new CancellationTokenSource(TimeSpan.FromSeconds(args.TimeoutSeconds));
        var running = new RunningQuery(args.ConnectionId, args.SessionId, cancellation);
        // Registered before the script is parsed, so a Stop during parsing finds it; a Stop that came even earlier waits in
        // earlyStops.
        if (!Register(args.QueryId, running)) throw new RequestException("DUPLICATE_QUERY", "This query is already running.");
        // Validate the whole script before opening a session or submitting any SQL.
        List<SqlBatch> batches;
        try { batches = SqlScript.Parse(args.Sql, args.StartLine); }
        catch
        {
            queries.TryRemove(new(args.QueryId, running));
            throw;
        }
        // A CANCEL frame for this request: main's backstop means its deadline passed; any other reason stops it like query.cancel.
        using var cancelled = context?.Token.Register(() => { if (context.Reason == CancelReason.Deadline) TryCancel(cancellation); else running.Cancel(); });
        using var events = new QueryEventSink(context is null ? null : context.SendEvent);
        QuerySession? session = null;
        var entered = false;
        // The error that ended the script, which can end the session before managed SNI's asynchronous close updates its state.
        SqlException? ended = null;
        var messages = new QueryMessages(events.Message);
        var sets = new List<ResultSetBuffer>();
        ResultSetBuffer? currentSet = null;
        var token = cancellation.Token;
        var watch = Stopwatch.StartNew();
        int? spid = null;
        string? login = null;
        var completed = 0;
        var batchNumber = 0;
        var iteration = 0;
        var totalBatches = batches.Sum(batch => batch.RepeatCount);
        long storedRows = 0;
        // Sets past maxResultSets, sets whose descriptors would not fit in the summary, and sets after the budget stopped.
        int overflowSets = 0, oversizeSets = 0, budgetSets = 0;
        long descriptorBytes = 0;
        QueryBudget? budget = null;
        long recordsAffected = -1;
        QueryFailure? failure = null;
        var status = "completed";
        var database = args.Database;
        // Only the first errors are reported in the summary; a looping statement can raise millions while its batch keeps
        // running. Messages keep them all, in order, up to their own caps.
        var errors = new List<string>();
        var suppressedErrors = 0;
        // Every severity 11+ error so far: a batch raised one when this grew while it ran.
        var raised = 0;
        (int Batch, int Iteration)? firstError = null;
        // Errors InfoMessage delivered, so the exception that may carry them again does not repeat them in Messages.
        var delivered = new Queue<(int Number, byte State, int Line, string Message)>();
        // SSMS's two-line form: the line is absolute within the script (or the selection), or the procedure's own.
        string Describe(SqlError item)
        {
            var location = !string.IsNullOrEmpty(item.Procedure) ? "Procedure " + item.Procedure + ", Line " + item.LineNumber
                : batchNumber > 0 && item.LineNumber > 0 ? "Line " + (args.StartLine + batches[batchNumber - 1].StartLine + item.LineNumber - 2)
                : "Line " + item.LineNumber;
            return "Msg " + item.Number + ", Level " + item.Class + ", State " + item.State + ", " + location + "\n" + item.Message;
        }
        Microsoft.Data.SqlClient.SqlInfoMessageEventHandler onInfo = (_, e) =>
        {
            // With FireInfoMessageEventOnUserErrors, severity 11-16 errors arrive here instead of aborting the reader,
            // so SQL Server (not the client) decides whether the rest of the batch runs, as in SSMS.
            foreach (SqlError error in e.Errors)
            {
                if (error.Class <= 10) { if (!IsContextChange(error)) messages.Add(error.Message, InformationalKind(error)); continue; }
                // An error while rows stream means the statement producing the current result set stopped early.
                if (currentSet is not null) currentSet.Incomplete = true;
                lock (errors)
                {
                    delivered.Enqueue((error.Number, error.State, error.LineNumber, error.Message));
                    if (delivered.Count > 20) delivered.Dequeue();
                }
                Raise(Describe(error));
            }
        };
        void Raise(string text)
        {
            messages.Add(text, MessageKind.Error);
            lock (errors)
            {
                raised++;
                if (errors.Count < 20) errors.Add(text); else suppressedErrors++;
            }
        }
        bool Delivered(SqlError item)
        {
            lock (errors) return delivered.Contains((item.Number, item.State, item.LineNumber, item.Message));
        }
        int Raised()
        {
            lock (errors) return raised;
        }
        // A batch's exception ends only that batch while the session survives it: SQL Server closes the connection for
        // severity 20 and above, and a cancel or the deadline ends the whole script.
        bool Continues(SqlException error, SqlConnection connection) => !args.StopOnError && !token.IsCancellationRequested
            && connection.State == System.Data.ConnectionState.Open && error.Errors.Cast<SqlError>().All(item => item.Class < 20);
        // Messages a batch's exception carries, in order, except errors InfoMessage already reported.
        void Report(SqlException error)
        {
            foreach (SqlError item in error.Errors)
                if (item.Class <= 10) { if (!IsContextChange(item)) messages.Add(item.Message, InformationalKind(item)); }
                else if (!Delivered(item)) Raise(Describe(item));
            if (!error.Errors.Cast<SqlError>().Any(item => item.Class > 10)) Raise(error.Message);
        }
        // The error that stopped execution comes first, then those SQL Server reported while the script continued.
        string ErrorText(IEnumerable<string> terminating)
        {
            var lines = terminating.Take(20).Concat(errors);
            if (suppressedErrors > 0) lines = lines.Append("… and " + suppressedErrors + " more errors.");
            var text = string.Join(Environment.NewLine, lines);
            return text.Length > 16384 ? text[..16384] + "…" : text;
        }
        // The reason leads, and the whole text stays under the same cap as any other error text.
        string Stopped(string reason) => errors.Count == 0 ? reason : ErrorText([reason]);

        try
        {
            session = Session(args);
            entered = session.TryEnter();
            if (!entered) throw new RequestException("SESSION_BUSY", "A query is already running in this tab.");
            // This query now owns the session, so the session's earlier results are released before any new row is stored.
            budget = store.BeginQuery(args.SessionId);
            var connection = session.Connection;
            connection.FireInfoMessageEventOnUserErrors = false;
            connection.InfoMessage += onInfo;
            if (connection.State != System.Data.ConnectionState.Open)
            {
                if (session.HasOpened) throw new RequestException("SESSION_LOST", "The SQL session was lost. This script was not executed. Execute again to open a new session; previous SET options, temporary objects, and open transactions are gone.");
                // A Kerberos or Entra failure answers the request (AUTH_KERBEROS, AUTH_ENTRA), as SESSION_LOST does: no batch was sent.
                await Open(connection, token);
                try
                {
                    await using var prologue = connection.CreateCommand();
                    prologue.CommandText = Prologue + " " + LoginSql;
                    prologue.CommandTimeout = 0;
                    await using var reader = await prologue.ExecuteReaderAsync(token);
                    session.Login = await reader.ReadAsync(token) && reader.FieldCount == 1 && !reader.IsDBNull(0) ? reader.GetString(0) : null;
                    // The SPID comes with the login acknowledgement: no round trip, and it never changes, since idle
                    // connection recovery is off for query sessions.
                    session.Spid = connection.ServerProcessId;
                }
                catch
                {
                    // A session without SSMS's settings must not run a script later; closing it makes the next execution open
                    // a new one.
                    connection.Close();
                    throw;
                }
                session.HasOpened = true;
            }
            if (session.Spid is { } openedSpid) events.SessionOpened(openedSpid, session.Login);
            // ChangeDatabase must still throw for a missing database, so user errors become events only for script batches.
            if (!string.Equals(connection.Database, args.Database, StringComparison.Ordinal))
                await connection.ChangeDatabaseAsync(args.Database, token);
            database = connection.Database;
            connection.FireInfoMessageEventOnUserErrors = true;
            for (var b = 0; b < batches.Count && failure is null; b++)
            {
                batchNumber = b + 1;
                var batch = batches[b];
                for (iteration = 1; iteration <= batch.RepeatCount; iteration++)
                {
                    token.ThrowIfCancellationRequested();
                    events.Progress(completed, totalBatches, batchNumber, iteration);
                    var raisedBefore = Raised();
                    await using var command = connection.CreateCommand();
                    command.CommandText = batch.Sql;
                    // The token alone carries the script's deadline. A CommandTimeout would arm a second timer expiring with
                    // it, and when both fire on the same tick SqlClient can leave the session one response behind, so each
                    // later execution in the tab would show the previous one's results. Cancel also stops the synchronous
                    // reads (ColumnPlan) that only check the token between chunks.
                    command.CommandTimeout = 0;
                    // From another thread, SqlClient's cancel waits while the batch streams info messages (a loop of PRINT or
                    // RAISERROR WITH NOWAIT) until they stop, and the batch's later statements run meanwhile; StatementStop
                    // cancels inside the next message instead. So the token reaches no SqlClient call of the batch: SqlClient's
                    // own registration would cancel from another thread too, and the two together deadlock.
                    var statementStop = new ActionService.StatementStop(command, token);
                    connection.InfoMessage += statementStop.OnMessage;
                    using var stop = token.UnsafeRegister(static state => ((ActionService.StatementStop)state!).FromOtherThread(), statementStop);
                    command.StatementCompleted += (_, e) => { if (e.RecordCount >= 0) messages.Add(e.RecordCount == 1 ? "(1 row affected)" : "(" + e.RecordCount + " rows affected)"); };
                    SqlDataReader? reader = null;
                    // The token fired before the reader reported the batch's end.
                    var cutShort = false;
                    try
                    {
                        // Sequential access streams each value once, in column order, so a huge value is never materialised
                        // (ColumnPlan reads past the rest of a truncated one).
                        // A Stop between the loop's check and here found no statement to cancel.
                        token.ThrowIfCancellationRequested();
                        reader = await command.ExecuteReaderAsync(System.Data.CommandBehavior.SequentialAccess, CancellationToken.None);
                        // Positioned on a result set not yet read, or on the batch's end.
                        var unread = true;
                        while (true)
                        {
                            try
                            {
                                if (unread)
                                {
                                    unread = false;
                                    ColumnPlan? plan = null;
                                    bool? hasLong = null;
                                    var skipped = false;
                                    if (reader.FieldCount > 0)
                                    {
                                        if (sets.Count >= args.MaxResultSets) overflowSets++;
                                        else if (oversizeSets > 0) oversizeSets++;
                                        else if ((plan = ColumnPlan.From(reader)).DescriptorBytes + descriptorBytes > MaxSummaryDescriptorBytes) { oversizeSets++; plan = null; }
                                        else if (store.Open(budget, sets.Count, batchNumber, iteration, plan.IsPlan ? "executionPlan" : "rows", plan.Columns, plan.Wires) is { } opened)
                                        {
                                            descriptorBytes += plan.DescriptorBytes;
                                            currentSet = opened;
                                            sets.Add(opened);
                                            events.Opened(opened);
                                        }
                                        else { budgetSets++; plan = null; }
                                    }
                                    if (plan?.ForXml is not null && currentSet is not null)
                                    {
                                        // FOR XML and FOR JSON output: every row is a chunk of one value, stored as the set's one row.
                                        using var collector = new ForXmlCollector(store, budget!);
                                        while (await reader.ReadAsync(CancellationToken.None)) collector.AppendRow(reader, token);
                                        if (collector.Rows > 0)
                                        {
                                            currentSet.CountRow();
                                            events.RowsChanged();
                                            if (args.MaxRows > 0 && storedRows >= args.MaxRows) currentSet.Skip(TruncationReason.RowLimit);
                                            else if (collector.Stopped is not TruncationReason.None and var refused) { currentSet.Skip(refused); budget!.Stop(refused); }
                                            else if (currentSet.BeginRow() is { } row)
                                            {
                                                bool cut;
                                                try { cut = collector.Write(row); }
                                                catch { currentSet.AbortRow(); throw; }
                                                if (currentSet.TryCommitRow(cut ? 1 : 0)) storedRows++;
                                            }
                                        }
                                    }
                                    else while (true)
                                    {
                                        // A row is not stored only for reasons that last for the rest of the set, so once one has been
                                        // skipped the rest of a set with a long column is read past in one go; rows already stored
                                        // become readable first.
                                        if (skipped && (hasLong ??= plan?.HasLong ?? ColumnPlan.HasLongColumns(reader)))
                                        {
                                            if (currentSet?.SealDelay is not null)
                                            {
                                                currentSet.Seal();
                                                events.Sealed(currentSet);
                                            }
                                            await SkipRowsAsync(reader, currentSet, events, token);
                                            break;
                                        }
                                        var read = reader.ReadAsync(CancellationToken.None);
                                        // Rows waiting for the next one are sealed: the first page 20 ms after its first row, later
                                        // pages after 200 ms without a row, so a slow statement's rows become readable.
                                        if (!read.IsCompleted && currentSet?.SealDelay is { } delay
                                            && (delay == TimeSpan.Zero || await Task.WhenAny(read, Task.Delay(delay)) != read))
                                        {
                                            currentSet.Seal();
                                            events.Sealed(currentSet);
                                        }
                                        if (!await read) break;
                                        if (RowFault?.Invoke() is { } fault) throw fault;
                                        skipped = true;
                                        if (currentSet is null) continue;
                                        currentSet.CountRow();
                                        events.RowsChanged();
                                        if (args.MaxRows > 0 && storedRows >= args.MaxRows) { currentSet.Skip(TruncationReason.RowLimit); continue; }
                                        var builder = currentSet.BeginRow();
                                        if (builder is null) continue;
                                        skipped = false;
                                        int truncatedCells;
                                        try { truncatedCells = plan!.ReadRow(reader, builder, text => messages.Add(text), token); }
                                        catch { currentSet.AbortRow(); throw; }
                                        var sealedBefore = currentSet.SealedPages;
                                        if (currentSet.TryCommitRow(truncatedCells)) storedRows++;
                                        if (currentSet.SealedPages != sealedBefore) events.Sealed(currentSet);
                                    }
                                    if (currentSet is not null)
                                    {
                                        currentSet.Complete();
                                        events.Closed(currentSet);
                                        currentSet = null;
                                    }
                                }
                                if (!await reader.NextResultAsync(CancellationToken.None)) break;
                                unread = true;
                            }
                            catch (SqlException error) when (!reader.IsClosed && Continues(error, connection))
                            {
                                // A severity 17 to 19 error after the batch's first result set: SqlClient raises it when it
                                // reaches it but keeps the reader, so the batch's later result sets and messages follow it
                                // in order, as SQL Server sent them and SSMS shows them.
                                Report(error);
                                if (currentSet is not null)
                                {
                                    currentSet.Incomplete = true;
                                    currentSet.Complete();
                                    events.Closed(currentSet);
                                    currentSet = null;
                                }
                            }
                        }
                        ReaderEnded?.Invoke();
                        cutShort = token.IsCancellationRequested;
                        if (reader.RecordsAffected >= 0) recordsAffected = Math.Max(0, recordsAffected) + reader.RecordsAffected;
                    }
                    catch (Exception error)
                    {
                        // Do not drain a failed command into later statements unnecessarily.
                        try { command.Cancel(); } catch (Exception cancel) when (cancel is InvalidOperationException or SqlException) { }
                        if (error is not SqlException sql || !Continues(sql, connection)) throw;
                        // A severity 17 to 19 error before the batch's first result set: SqlClient reads the rest of the batch
                        // inside ExecuteReader, discarding its result sets and delivering its messages, and only then raises
                        // the error. SQL Server ran the whole batch; what SqlClient discarded cannot be recovered short of
                        // forking it (docs/ipc.md, Batches). The script goes on with the next batch.
                        Report(sql);
                        if (currentSet is not null)
                        {
                            currentSet.Incomplete = true;
                            currentSet.Complete();
                            events.Closed(currentSet);
                            currentSet = null;
                        }
                    }
                    finally
                    {
                        if (reader is not null) await reader.DisposeAsync();
                        connection.InfoMessage -= statementStop.OnMessage;
                    }
                    // Now and then (about once in 600 of the live check's timed WAITFORs under load) SqlClient ends a cancelled
                    // batch's reader as if the batch had finished and raises no "Operation cancelled", though SQL Server
                    // stopped the batch where the attention found it (after 1 s of a 5 s WAITFOR). A batch whose token fired
                    // before its end was stopped, not finished: the script times out or is cancelled, as when SqlClient
                    // does raise it, and the batch does not count as completed.
                    if (cutShort) throw new OperationCanceledException(token);
                    database = connection.Database;
                    var failed = Raised() != raisedBefore;
                    // SSMS runs the remaining batches after one that raised an error; stopOnError (SQLCMD's :on error exit) does not.
                    if (failed && args.StopOnError) { status = "failed"; failure = new("SQL_ERROR", ErrorText([]), batchNumber, iteration); break; }
                    if (failed) firstError ??= (batchNumber, iteration);
                    completed++;
                    events.Progress(completed, totalBatches, batchNumber, iteration);
                    if (failed && completed < totalBatches)
                        messages.Add("Batch " + batchNumber + (batch.RepeatCount > 1 ? ", repetition " + iteration + "," : "") + " raised an error; execution continued with the next "
                            + (iteration < batch.RepeatCount ? "repetition." : "batch."));
                }
            }
            if (firstError is { } first)
            {
                status = "completedWithErrors";
                failure = new("SQL_ERROR", ErrorText([]), first.Batch, first.Iteration);
            }
        }
        catch (SqlException error)
        {
            ended = error;
            if (currentSet is not null) currentSet.Incomplete = true;
            // Before the first batch, -2 is a connect timeout while opening the session, not the script deadline.
            status = running.UserCancelled ? "cancelled" : cancellation.IsCancellationRequested || error.Number == -2 && batchNumber > 0 ? "timedOut" : "failed";
            // Messages delivered with the exception (e.g. PRINT before a severe error, or the error itself) belong in Messages,
            // in order, except errors InfoMessage already reported.
            foreach (SqlError item in error.Errors)
                if (item.Class <= 10) { if (!IsContextChange(item)) messages.Add(item.Message, InformationalKind(item)); }
                else if (status == "failed" && !Delivered(item)) messages.Add(Describe(item), MessageKind.Error);
            var details = error.Errors.Cast<SqlError>().Where(item => item.Class > 10).Select(Describe).ToList();
            if (details.Count == 0)
            {
                details.Add(error.Message);
                if (status == "failed") messages.Add(error.Message, MessageKind.Error);
            }
            if (status != "failed") messages.Add(status == "cancelled" ? CancelledSentence : TimedOutSentence, MessageKind.Error);
            var text = status == "cancelled" ? Stopped(CancelledSentence) : status == "timedOut" ? Stopped(TimedOutSentence) : ErrorText(details);
            failure = new(status == "failed" ? "SQL_ERROR" : status == "cancelled" ? "CANCELLED" : "TIMEOUT", text, batchNumber, iteration);
        }
        catch (OperationCanceledException)
        {
            if (currentSet is not null) currentSet.Incomplete = true;
            status = running.UserCancelled ? "cancelled" : "timedOut";
            var sentence = running.UserCancelled ? CancelledSentence : TimedOutSentence;
            messages.Add(sentence, MessageKind.Error);
            failure = new(running.UserCancelled ? "CANCELLED" : "TIMEOUT", Stopped(sentence), batchNumber, iteration);
        }
        catch (Exception error) when (error is not RequestException)
        {
            // Keep earlier result sets and messages when the provider fails outside SQL Server error handling.
            if (currentSet is not null) currentSet.Incomplete = true;
            status = "failed";
            messages.Add("Execution stopped unexpectedly: " + error.Message, MessageKind.Error);
            failure = new("BACKEND_ERROR", ErrorText(["Execution stopped unexpectedly: " + error.Message]), batchNumber, iteration);
        }
        finally
        {
            watch.Stop();
            queries.TryRemove(args.QueryId, out _);
            // A set cut short keeps the rows it stored.
            foreach (var set in sets.Where(set => set.IsOpen))
            {
                set.Complete();
                events.Closed(set);
            }
            if (entered && session is not null)
            {
                session.Connection.FireInfoMessageEventOnUserErrors = false;
                session.Connection.InfoMessage -= onInfo;
                // Nothing runs in the session after the script: its @@ROWCOUNT, @@ERROR and most recent SQL stay the
                // script's. Its transaction is read only when it is about to end (query.session.state), as SSMS does.
                var state = session.Connection.State;
                // A severity 20 error ends the session even while its connection still reads Open (IsSessionLost).
                var lost = state is System.Data.ConnectionState.Closed or System.Data.ConnectionState.Broken || ended is not null && IsSessionLost(ended, state);
                if (!lost && state == System.Data.ConnectionState.Open)
                {
                    database = session.Connection.Database;
                    spid = session.Spid;
                    login = session.Login;
                }
                if (lost)
                {
                    ((ICollection<KeyValuePair<string, QuerySession>>)sessions).Remove(new(args.SessionId, session));
                    session.Close();
                    // A session that failed to open (a missing database, a refused login) had no state to lose.
                    if (session.HasOpened)
                        messages.Add("The SQL session closed. The next execution opens a new session; previous SET options and temporary objects will be lost.");
                }
                session.Exit();
            }
        }
        var output = messages.Snapshot();
        void Note(string text) => output.Add(new(text, QueryMessages.Info));
        var descriptors = sets.Select(set => set.Describe()).ToList();
        var reasons = descriptors.Select(set => set.Truncated).ToHashSet();
        if (budget?.Stopped is { } stopped and not TruncationReason.None) reasons.Add(ResultSetBuffer.Name(stopped));
        if (reasons.Contains("rowLimit") || descriptors.Any(set => set.TruncatedCells > 0)) Note("Results were truncated by display limits. Display limits do not stop script execution.");
        if (reasons.Contains("queryBudget") || reasons.Contains("globalBudget"))
            Note("Results were truncated because the result memory budget (" + (reasons.Contains("queryBudget") ? store.QueryBytes : store.GlobalBytes) / (1024 * 1024)
                + " MB) is full. Execution continued; close other query results to free memory.");
        if (reasons.Contains("systemMemory")) Note("Results were truncated because the computer is low on memory. Execution continued.");
        if (overflowSets > 0) Note("Only the first " + (args.MaxResultSets == 10 ? "ten" : args.MaxResultSets.ToString("N0", CultureInfo.InvariantCulture)) + " result sets are displayed. Display limits do not stop script execution.");
        if (oversizeSets > 0) Note(oversizeSets + " later result sets are not displayed because their column lists are too large to return. Display limits do not stop script execution.");
        // Only when something stopped the script before a later batch: SQL Server may have run the failing batch to its end.
        if (failure is not null && batchNumber > 0 && completed + 1 < totalBatches)
        {
            var repeated = batches[batchNumber - 1].RepeatCount > 1;
            Note(status == "failed"
                ? "Batch " + batchNumber + (repeated ? ", repetition " + iteration + "," : "") + " raised an error; later batches were not executed."
                : "Stopped at batch " + batchNumber + (repeated ? ", repetition " + iteration : "") + "; " + completed + " of " + totalBatches + " batch executions completed.");
        }
        if (context is not null) context.Unsent = () => store.Release(descriptors.Select(set => set.ResultId));
        var completedAt = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffffffzzz", CultureInfo.InvariantCulture);
        return new(descriptors, overflowSets + oversizeSets + budgetSets, output, recordsAffected, watch.ElapsedMilliseconds, status, failure, completed,
            totalBatches, database, messages.Truncated, SummaryBudget(), completedAt, spid, login);
    }

    /// <summary>Streams the sealed pages that cover a row range, as stored (never copied), within the request's credit; rows
    /// still being built are not served, so the worker reads again after the next progress event.</summary>
    private async Task<ResultsReadResult> ReadResultsAsync(ResultsReadArgs args, RequestContext? context)
    {
        if (args.ResultId == 0 || args.FirstRow is < 0 or > MaxSafeInteger || args.MaxRows is < 1 or > 65_536)
            throw new RequestException("INVALID_PARAMS", "The result range is invalid.");
        if (context is not { IsStream: true }) throw new RequestException("INVALID_REQUEST", "Result pages are read as a stream with credit.");
        var set = store.Find(args.ResultId) ?? throw Unavailable(args.ResultId);
        var next = args.FirstRow;
        int pages = 0, rows = 0;
        foreach (var page in set.PagesFor(args.FirstRow, args.MaxRows))
        {
            // A release ends the read after the page already sent.
            if (set.IsReleased) throw Unavailable(args.ResultId);
            await context.SendDataAsync(page.Body);
            next = page.FirstRow + page.Rows;
            pages++;
            rows += page.Rows;
        }
        var available = set.RowsAvailable;
        return new ResultsReadResult(next, available, set.IsComplete && next >= available, pages, rows);
    }

    private RequestException Unavailable(uint resultId) => store.WasReleased(resultId)
        ? new RequestException("RESULT_RELEASED", "These results were closed. Execute the query again to see them.")
        : new RequestException("RESULT_NOT_FOUND", "These results do not exist.");

    private ResultsCloseResult CloseResults(ResultsCloseArgs args)
    {
        if (args.ResultIds is not { Length: >= 1 and <= 1024 } || args.ResultIds.Contains(0u)) throw new RequestException("INVALID_PARAMS", "Between 1 and 1024 result IDs are required.");
        var closed = store.Release(args.ResultIds);
        // The fall goes out as an event before this answer, in order with the other results.memory events; the status bar
        // follows only those, so an answer overtaken by a newer event cannot show stale usage.
        if (closed > 0) ReportMemory();
        return new ResultsCloseResult(closed, store.UsedBytes);
    }

    /// <summary>Stores synthetic rows (SyntheticRows shapes) through the same budgeted path as a query.</summary>
    private ResultDescriptor Synthesize(SynthesizeArgs args, CancellationToken token)
    {
        if (!SyntheticRows.Shapes.Contains(args.Shape) || args.Rows is < 1 or > 5_000_000) throw new RequestException("INVALID_PARAMS", "Shape must be W1, B1, N1, X1, L1 or M1 with 1 to 5,000,000 rows.");
        var columns = SyntheticRows.Columns(args.Shape);
        var set = store.Open(store.BeginQuery("debug:" + Guid.NewGuid()), 0, 1, 1, "rows",
            [.. columns.Select(column => new ResultColumn(column.Name, column.DataType, column.Wire == WireKind.Text ? "text" : "binary", column.Role))], [.. columns.Select(column => column.Wire)])
            ?? throw new RequestException("BACKEND_ERROR", "The result memory budget is full.");
        try
        {
            for (long row = 0; row < args.Rows; row++)
            {
                if ((row & 4095) == 0) token.ThrowIfCancellationRequested();
                set.CountRow();
                if (set.BeginRow() is not { } builder) continue;
                SyntheticRows.WriteCells(args.Shape, row, builder);
                set.TryCommitRow();
            }
            set.Complete();
            return set.Describe();
        }
        catch
        {
            store.Release(set.ResultId);
            throw;
        }
    }

    /// <summary>"Changed database context to 'x'." (5701) and "Changed language setting to x." (5703): SQL Server sends
    /// them for USE, a session's login, and the toolbar's database change, and SSMS leaves them out of Messages.</summary>
    private static bool IsContextChange(SqlError error) => error.Number is 5701 or 5703;
    /// <summary>PRINT arrives as number 0 and RAISERROR as 50000 or a user message's number (above 50000): what the script itself
    /// printed, which opens the Messages strip. Every other informational number is SQL Server's own (8153's NULL warning,
    /// STATISTICS output, DBCC, sp_rename's caution).</summary>
    private static MessageKind InformationalKind(SqlError error) => InformationalKind(error.Number);
    internal static MessageKind InformationalKind(int number) => number == 0 || number >= 50000 ? MessageKind.Print : MessageKind.Server;

    /// <summary>A global results.memory EVENT on the first sample and whenever sampled usage changes. The timer checks
    /// once a second and results.close checks before it answers. A refused event is retried at the next check.</summary>
    internal void ReportMemory()
    {
        lock (memoryGate)
        {
            var used = store.UsedBytes;
            var global = store.GlobalBytes;
            if (publish is null || used == reportedBytes) return;
            if (!publish(new { Type = "results.memory", UsedBytes = used, GlobalBytes = global, Seq = memorySeq + 1 })) return;
            memorySeq++;
            reportedBytes = used;
        }
    }

    /// <summary>The shared index budget, sampled while builds run and after a disconnect releases an index.</summary>
    internal void ReportIndexMemory()
    {
        lock (memoryGate)
        {
            var used = search.MemoryUsed;
            if (publish is null || used == reportedIndexBytes) return;
            if (!publish(new { Type = "explorer.index.memory", UsedBytes = used, GlobalBytes = search.Limits.MemoryBytes, Seq = indexMemorySeq + 1 })) return;
            indexMemorySeq++;
            reportedIndexBytes = used;
        }
    }

    /// <summary>A summary's budget counts as reported, so a subsequent close reports any fall from the summary. The
    /// summary is written only after this returns, so an event published meanwhile (a close in another tab) can reach main
    /// first; both take their sequence number under this lock with the usage they carry, and the status bar ignores a
    /// figure older than the one it shows.</summary>
    internal ResultBudget SummaryBudget()
    {
        lock (memoryGate)
        {
            var used = store.UsedBytes;
            reportedBytes = used;
            return new ResultBudget(used, store.GlobalBytes, store.QueryBytes, ++memorySeq);
        }
    }

    /// <summary>Reads past the rest of a result set that stores no more rows and has a long column, counting its rows.
    /// ReadAsync would skip each long value by buffering all of it, in time quadratic in its size and deaf to the token; a
    /// synchronous Read skips it in linear time, and Cancel stops it. That Read also blocks while the server is slow to
    /// send the next row (a lock, a slow plan, a remote server), so it runs on a thread of its own: on pool threads, a
    /// few such queries delayed every other request, cancels included, by seconds. The batch's StatementStop cancels it;
    /// a cancel of its own from another thread could deadlock with that one.</summary>
    private static Task SkipRowsAsync(SqlDataReader reader, ResultSetBuffer? set, QueryEventSink events, CancellationToken token) =>
        Task.Factory.StartNew(() =>
        {
            while (true)
            {
                token.ThrowIfCancellationRequested();
                if (!reader.Read()) return;
                if (set is null) continue;
                set.CountRow();
                events.RowsChanged();
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);

    /// <summary>Sends an attention for a command when its token is cancelled. Cancel throws when the connection has broken, and
    /// a callback's exception would escape on the deadline's timer thread, ending the backend, or out of the loops that
    /// cancel every query of a connection.</summary>
    private static void Attention(object? command)
    {
        try { ((SqlCommand)command!).Cancel(); }
        catch (Exception error) when (error is InvalidOperationException or SqlException or ObjectDisposedException) { }
    }

    /// <summary>query.cancel. `cancelled` says whether the query was running; a Stop for one not yet registered is kept
    /// (earlyStops) and stops it as it registers, since main sends query.cancel only for a query it started.</summary>
    private object Cancel(CancelArgs args)
    {
        RunningQuery? query;
        lock (cancelGate)
        {
            if (!queries.TryGetValue(args.QueryId, out query) && Guid.TryParse(args.QueryId, out _)) RememberEarlyStop(args.QueryId, Environment.TickCount64);
        }
        // Outside the gate: cancelling runs the token's callbacks, which reach SqlClient.
        query?.Cancel();
        return new { Cancelled = query is not null };
    }

    /// <summary>Adds a running query unless its id is taken; a Stop that came first cancels it at once.</summary>
    private bool Register(string queryId, RunningQuery running)
    {
        bool early;
        lock (cancelGate)
        {
            if (!queries.TryAdd(queryId, running)) return false;
            early = earlyStops.Remove(queryId);
        }
        if (early) running.Cancel();
        return true;
    }

    private void RememberEarlyStop(string queryId, long now)
    {
        foreach (var (id, at) in earlyStops)
            if (now - at > EarlyStopLifetime.TotalMilliseconds) earlyStops.Remove(id);
        if (earlyStops.Count >= MaxEarlyStops && !earlyStops.ContainsKey(queryId))
            earlyStops.Remove(earlyStops.MinBy(entry => entry.Value).Key);
        earlyStops[queryId] = now;
    }

    /// <summary>Test seam: the early Stops kept.</summary>
    internal int EarlyStopCount { get { lock (cancelGate) return earlyStops.Count; } }

    private static void TryCancel(CancellationTokenSource source)
    {
        try { source.Cancel(); } catch (ObjectDisposedException) { /* Query completed concurrently. */ }
    }

    /// <summary>query.session.state: the open transaction (@@TRANCOUNT) of an idle session about to end, read on demand as
    /// SSMS reads it when a query window closes or disconnects. It never waits: a session running a script answers
    /// SESSION_BUSY, an unknown one SESSION_CLOSED, and one found lost is closed and answers SESSION_LOST (SQL Server rolled
    /// back its transaction). Under SET SHOWPLAN_*, NOEXEC, PARSEONLY or FMTONLY ON the SELECT returns no count, and the
    /// options stay as they are, since the user may still keep the session: the answer is then unchecked, and a commit
    /// turns them off first (CommitAsync).</summary>
    private async Task<SessionState> SessionStateAsync(SessionStateArgs args, CancellationToken token)
    {
        if (!Guid.TryParse(args.SessionId, out _)) throw new RequestException("INVALID_PARAMS", "A valid session ID is required.");
        if (!sessions.TryGetValue(args.SessionId, out var session)) throw new RequestException("SESSION_CLOSED", "This query has no open SQL session.");
        if (!session.TryEnter()) throw new RequestException("SESSION_BUSY", "A query is running in this tab.");
        try
        {
            var connection = session.Connection;
            if (connection.State != System.Data.ConnectionState.Open)
            {
                if (!session.HasOpened) throw new RequestException("SESSION_CLOSED", "This query has no open SQL session.");
                throw Lost(args.SessionId, session, LostMessage(session, committing: false, commit: false));
            }
            try
            {
                var open = await CountAsync(connection, TransactionCountSql, token);
                return new SessionState(open ?? 0, open is not null);
            }
            catch (Exception error) when (error is SqlException or InvalidOperationException && !token.IsCancellationRequested && IsSessionLost(error, connection.State))
            {
                throw Lost(args.SessionId, session, LostMessage(session, committing: false, commit: false));
            }
        }
        finally { session.Exit(); }
    }

    /// <summary>Forgets a session found lost and closes it; the answer is SESSION_LOST with <paramref name="message"/>.</summary>
    private RequestException Lost(string sessionId, QuerySession session, string message)
    {
        ((ICollection<KeyValuePair<string, QuerySession>>)sessions).Remove(new(sessionId, session));
        session.Close();
        return new RequestException("SESSION_LOST", message);
    }

    // Managed SNI can report a fatal transport error before its asynchronous close updates Connection.State.
    // Severity 20 and above ends the session even while the connection still appears open.
    internal static bool IsSessionLost(Exception error, System.Data.ConnectionState state) =>
        state != System.Data.ConnectionState.Open || error is SqlException sql && sql.Errors.Cast<SqlError>().Any(item => item.Class >= 20);

    internal const string LostRolledBack = "The SQL session was lost, so SQL Server rolled back its transaction.";
    internal const string LostNothingCommitted = LostRolledBack + " Nothing was committed.";
    internal const string LostWhileCommitting = "The SQL session was lost while committing, so it is not known whether its transaction was committed. Check the data before running the work again.";
    internal const string LostAfterUnfinishedCommit = "The SQL session was lost after a commit that did not finish (it was cancelled or timed out), so it is not known whether that commit took effect. Check the data before running the work again.";

    /// <summary>What a lost session's answer says became of its transaction: SQL Server rolled back what was open, unless a
    /// commit was running (<paramref name="committing"/>) or one sent earlier never answered (<see cref="QuerySession.CommitInDoubt"/>).
    /// <paramref name="commit"/> is a close with commit, which also says that nothing was committed.</summary>
    internal static string LostMessage(QuerySession session, bool committing, bool commit) =>
        committing ? LostWhileCommitting : session.CommitInDoubt ? LostAfterUnfinishedCommit : commit ? LostNothingCommitted : LostRolledBack;

    /// <summary>@@TRANCOUNT after the batch, or null when the batch compiled without executing. The token alone carries the
    /// deadline (see ExecuteAsync).</summary>
    private async Task<int?> CountAsync(SqlConnection connection, string sql, CancellationToken token)
    {
        if (SessionFault?.Invoke(sql) is { } fault) throw fault;
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.CommandTimeout = 0;
        using var stop = token.Register(Attention, command);
        await using var reader = await command.ExecuteReaderAsync(token);
        return await reader.ReadAsync(token) && reader.FieldCount == 1 && reader.GetFieldType(0) == typeof(int) ? reader.GetInt32(0) : null;
    }

    private async Task<object> CloseSessionAsync(SessionArgs args, CancellationToken token)
    {
        if (!Guid.TryParse(args.SessionId, out _)) throw new RequestException("INVALID_PARAMS", "A valid session ID is required.");
        if (args.Transaction is not (null or "commit" or "rollback")) throw new RequestException("INVALID_PARAMS", "A transaction ends by commit or rollback.");
        // A rollback is the close itself: SQL Server rolls back what a closed session left open, on its own time. An explicit
        // ROLLBACK would hold this request until the rollback finished, since an attention waits for it too.
        if (args.Transaction == "commit" && sessions.TryGetValue(args.SessionId, out var open)) await CommitAsync(args.SessionId, open, token);
        return CloseSession(args.SessionId);
    }

    /// <summary>Commits the session's transaction before it closes. A commit that fails (an uncommittable error, a script
    /// still running, SET options that keep it from executing even after they are turned off) throws and leaves the session
    /// open, so its tab stays open with its transaction for the user to decide again. A session found lost before the
    /// commit was sent had its transaction rolled back by SQL Server; for one lost while the commit ran, the outcome is
    /// unknown, and the error says so. Either way the lost session is closed. A commit the deadline or a cancel interrupts
    /// is answered by the request's TIMEOUT or CANCELLED, and the session stays open; its outcome is unknown too, so the
    /// session remembers it (<see cref="QuerySession.CommitInDoubt"/>) for whatever finds it lost later.</summary>
    private async Task CommitAsync(string sessionId, QuerySession session, CancellationToken token)
    {
        if (!session.TryEnter()) throw new RequestException("SESSION_BUSY", "A query is running in this tab. Cancel it before committing its transaction.");
        var committing = false;
        try
        {
            var connection = session.Connection;
            RequestException Lost() => this.Lost(sessionId, session, LostMessage(session, committing, commit: true));
            if (connection.State != System.Data.ConnectionState.Open)
            {
                if (!session.HasOpened) return;
                throw Lost();
            }
            // The token alone carries the deadline (see ExecuteAsync).
            async Task Run(string sql)
            {
                if (SessionFault?.Invoke(sql) is { } fault) throw fault;
                await using var command = connection.CreateCommand();
                command.CommandText = sql;
                command.CommandTimeout = 0;
                using var stop = token.Register(Attention, command);
                await command.ExecuteNonQueryAsync(token);
            }
            Task<int?> Count(string sql) => CountAsync(connection, sql, token);
            try
            {
                var open = await Count(TransactionCountSql);
                if (open is null)
                {
                    // The session is about to close, so the options it would lose anyway are turned off now.
                    foreach (var sql in ExecuteAgainSql) await Run(sql);
                    open = await Count(TransactionCountSql);
                }
                if (open is null) throw new RequestException("SQL_ERROR", "The transaction was not committed, and the query stays open. The session's SET options keep a COMMIT from executing.");
                if (open == 0) return;
                committing = true;
                var remaining = await Count(CommitSql);
                committing = false;
                if (remaining is not 0) throw new RequestException("SQL_ERROR", "The transaction was not committed, and the query stays open. @@TRANCOUNT is " + (remaining?.ToString(CultureInfo.InvariantCulture) ?? "unknown") + " after COMMIT.");
            }
            catch (Exception error) when (error is SqlException or InvalidOperationException && !token.IsCancellationRequested)
            {
                if (IsSessionLost(error, connection.State)) throw Lost();
                if (error is not SqlException failed) throw;
                // SQL Server answered the commit with an error, so it is known not to have committed.
                committing = false;
                var details = string.Join(Environment.NewLine, failed.Errors.Cast<SqlError>().Where(item => item.Class > 10)
                    .Select(item => "Msg " + item.Number + ", Level " + item.Class + ", State " + item.State + "\n" + item.Message));
                throw new RequestException("SQL_ERROR", "The transaction was not committed, and the query stays open. " + (details.Length == 0 ? failed.Message : details));
            }
        }
        finally
        {
            // The commit ended without an answer (the deadline or a cancel, or a failure outside SQL Server's errors) while the
            // session stays open: a loss found later cannot say that nothing was committed.
            if (committing) session.CommitInDoubt = true;
            session.Exit();
        }
    }

    private object CloseSession(string sessionId)
    {
        foreach (var query in queries.Values.Where(query => query.SessionId == sessionId)) query.Cancel();
        var removed = sessions.TryRemove(sessionId, out var session);
        session?.Close();
        // The session's results stay until the renderer closes them (results.close) or its next query replaces them.
        return new { Closed = removed };
    }

    private QuerySession Session(QueryArgs args)
    {
        lock (sessionGate)
        {
            if (queries.Values.Count(query => query.SessionId == args.SessionId) > 1)
                throw new RequestException("SESSION_BUSY", "A query is already running in this tab.");
            if (!connections.ContainsKey(args.ConnectionId)) throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");
            if (sessions.TryGetValue(args.SessionId, out var existing))
            {
                if (existing.ConnectionId != args.ConnectionId) throw new RequestException("SESSION_TARGET", "Close this query session before selecting another server.");
                return existing;
            }
            if (sessions.Count >= SessionLimit)
                throw new RequestException("SESSION_LIMIT", "This query was not executed: " + SessionLimit.ToString("N0", CultureInfo.InvariantCulture) + " query tabs already hold SQL sessions, the most Varia SQL Manager keeps open. "
                    + "Close query tabs you no longer need, or disconnect idle ones (Query > Connection > Disconnect), then execute again.");
            var session = new QuerySession(args.ConnectionId, CreateConnection(args.ConnectionId, args.Database, stateful: true));
            sessions[args.SessionId] = session;
            return session;
        }
    }

    public void CancelAll()
    {
        foreach (var query in queries.Values) query.Cancel();
        scripting.CancelAll();
        actions.CancelAll();
        ssis.CancelAll();
        ssisActions.CancelAll();
        live.CancelAll();
    }
    /// <summary>Waits, side by side, for a Create Catalog past its restore and for long object actions (a restore) with their cleanup,
    /// each within its own bound, which main's drainMs for the pending request covers.</summary>
    public void DrainCommitted()
    {
        var restores = Task.Run(actions.DrainLong);
        ssisActions.DrainCommitted();
        restores.Wait();
    }
    public void Dispose()
    {
        memoryTimer?.Dispose();
        explorer.Dispose();
        search.Dispose();
        scripting.Dispose();
        actions.Dispose();
        ssis.Dispose();
        ssisActions.Dispose();
        CancelAll();
        foreach (var session in sessions.Values) session.Close();
        sessions.Clear();
        pools.Clear();
        profiles.Clear();
        serverScopeInMaster.Clear();
        homes.Clear();
        connections.Clear();
        store.ReleaseAll();
        SqlConnection.ClearAllPools();
    }
}
