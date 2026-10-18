using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.Management.Smo;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;
using Varia.Backend.Results;
using Varia.Backend.Scripting;

namespace Varia.Backend;

internal sealed class SqlService : IRequestDispatcher, IExplorerHost, IScriptingHost
{
    /// <summary>Announced in HELLO; main refuses a backend that lacks any method it may call (a stale build).</summary>
    public static readonly string[] MethodNames =
    [
        "system.health", "connections.connect", "connections.databases", "connections.discover", "connections.preview", "connections.disconnect",
        "databases.list", "tables.columns", "query.execute", "query.cancel", "query.session.close",
        "results.read", "results.close", "explorer.children", "results.copy", "results.export",
        "scripting.script"
    ];
    /// <summary>Synthetic results for tests and benchmarks; it exists only with VARIA_BACKEND_TEST_HOOKS=1.</summary>
    public const string SynthesizeMethod = "debug.results.synthesize";
    private const long MaxSafeInteger = 9_007_199_254_740_991;
    private const long MemoryReportStep = 64L * 1024 * 1024;
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
    private readonly ConcurrentDictionary<string, QuerySession> sessions = new();
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> pools = new();
    private readonly ConcurrentDictionary<string, ServerProfile> profiles = new();
    private readonly ExplorerService explorer;
    private readonly ScriptingService scripting;
    private readonly object sessionGate = new();
    private readonly ServerDiscovery discovery = new();
    private readonly ResultStore store;
    private readonly ResultJobs jobs;
    private readonly bool hooks;
    private readonly Func<object, bool>? publish;
    private readonly Timer? memoryTimer;
    private readonly object memoryGate = new();
    private long reportedBytes = -1;
    private int reportedBand;
    /// <summary>Orders memory reports (events and summary budgets) for this process; main pairs it with the generation.</summary>
    private long memorySeq;
    private object? health;

    private sealed class RunningQuery(string connectionId, string sessionId, CancellationTokenSource source)
    {
        public string ConnectionId { get; } = connectionId;
        public string SessionId { get; } = sessionId;
        public CancellationTokenSource Source { get; } = source;
        public bool UserCancelled { get; private set; }
        public void Cancel() { UserCancelled = true; TryCancel(Source); }
    }

    /// <summary>The most query sessions open at once. Only the live checks change it.</summary>
    internal int SessionLimit { get; set; } = 32;

    /// <param name="store">Defaults to the system budget (<see cref="ResultStore.FromSystem"/>).</param>
    /// <param name="hooks">Adds debug.results.synthesize (VARIA_BACKEND_TEST_HOOKS=1, set by main only for smoke tests).</param>
    /// <param name="publish">Sends a global EVENT and says whether it was queued; result memory usage is reported through it
    /// at most once a second.</param>
    public SqlService(ResultStore? store = null, bool hooks = false, Func<object, bool>? publish = null)
    {
        this.store = store ?? ResultStore.FromSystem();
        jobs = new ResultJobs(this.store);
        this.hooks = hooks;
        this.publish = publish;
        Methods = hooks ? [.. MethodNames, SynthesizeMethod] : MethodNames;
        explorer = new ExplorerService(this);
        scripting = new ScriptingService(this);
        if (publish is not null) memoryTimer = new Timer(_ => ReportMemory(), null, 1000, 1000);
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
    /// <summary>Script As (the checks set its test options).</summary>
    public ScriptingService Scripting => scripting;

    /// <summary>Cancellation and cleanup never wait for a slot, and scripts are bounded by the per-tab session limit, so
    /// long-running queries cannot starve Object Explorer and connection requests of the 8 metadata slots. Result reads,
    /// copies and exports take one of 16 result slots.</summary>
    public RequestLane LaneOf(string method) => method switch
    {
        "query.execute" => RequestLane.Query,
        "results.read" or "results.copy" or "results.export" => RequestLane.Results,
        "explorer.children" => RequestLane.Explorer,
        "system.health" or "connections.disconnect" or "query.cancel" or "query.session.close" or "results.close" => RequestLane.Control,
        SynthesizeMethod when hooks => RequestLane.Metadata,
        _ when Array.IndexOf(MethodNames, method) < 0 => RequestLane.Control,
        _ => RequestLane.Metadata
    };

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
        "databases.list" => await DatabasesAsync(Read<ConnectionArgs>(parameters, json), Token(context)),
        "tables.columns" => await ColumnsAsync(Read<TableArgs>(parameters, json), Token(context)),
        "query.execute" => await ExecuteAsync(Read<QueryArgs>(parameters, json), context),
        "query.cancel" => Cancel(Read<CancelArgs>(parameters, json)),
        "query.session.close" => CloseSession(Read<SessionArgs>(parameters, json)),
        "results.read" => await ReadResultsAsync(Read<ResultsReadArgs>(parameters, json), context),
        "results.close" => CloseResults(Read<ResultsCloseArgs>(parameters, json)),
        "results.copy" => await jobs.CopyAsync(Read<ResultsCopyArgs>(parameters, json), context),
        "results.export" => await jobs.ExportAsync(Read<ResultsExportArgs>(parameters, json), context),
        "explorer.children" => await explorer.ChildrenAsync(Read<ExplorerChildrenArgs>(parameters, json), Token(context)),
        "scripting.script" => await scripting.ScriptAsync(Read<ScriptArgs>(parameters, json), Token(context)),
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

    private async Task<ConnectionInfo> ConnectAsync(ConnectOptions options, CancellationToken token)
    {
        if (options.Authentication is not ("windows" or "sql"))
            throw new RequestException("INVALID_PARAMS", "Unsupported authentication mode.");
        if (options.Authentication == "windows" && !OperatingSystem.IsWindows())
            throw new RequestException("AUTH_UNSUPPORTED", "Windows authentication in this bootstrap requires Windows. Use SQL authentication on other platforms.");
        var builder = ConnectionSettings.Build(options);
        await using var connection = new SqlConnection(builder.ConnectionString);
        await connection.OpenAsync(token);
        var profile = await ServerProfile.ProbeAsync(connection, token);
        var id = Guid.NewGuid().ToString();
        profiles[id] = profile;
        connections[id] = builder.ConnectionString;
        pools[id] = new() { [builder.ConnectionString] = 0 };
        var probed = profile.ProductVersion is not null;
        return new(id, options.Server, connection.Database, connection.ServerVersion, options.DisplayName, options.Color, builder.CommandTimeout,
            profile.ProductVersion, profile.Login, probed ? profile.EngineEdition : null);
    }

    private static async Task<List<DatabaseInfo>> DiscoverDatabasesAsync(ConnectOptions options, CancellationToken token)
    {
        // Use the login's default database to discover choices, even if the typed database is stale.
        var builder = ConnectionSettings.Build(options with { Database = "", Advanced = (options.Advanced ?? new()) with { AttachDbFilename = "" } });
        builder.Pooling = false;
        await using var connection = new SqlConnection(builder.ConnectionString);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(30));
        await connection.OpenAsync(deadline.Token);
        return await ReadDatabasesAsync(connection, deadline.Token);
    }

    private object Disconnect(ConnectionArgs args)
    {
        var removed = connections.TryRemove(args.ConnectionId, out var connectionString);
        profiles.TryRemove(args.ConnectionId, out _);
        explorer.Forget(args.ConnectionId);
        scripting.Forget(args.ConnectionId);
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
        if (stateful)
        {
            // Never let idle connection recovery silently replace a tab's SQL session state.
            builder.ConnectRetryCount = 0;
            // Closing a tab must end its server session so open transactions roll back and release locks;
            // a pooled connection would keep them open until the pool reused or pruned it.
            builder.Pooling = false;
        }
        else if (pools.TryGetValue(id, out var used)) used.TryAdd(builder.ConnectionString, 0);
        return new SqlConnection(builder.ConnectionString);
    }

    ServerProfile IExplorerHost.Profile(string connectionId) => Profile(connectionId);
    ServerProfile IScriptingHost.Profile(string connectionId) => Profile(connectionId);

    private ServerProfile Profile(string connectionId) =>
        connections.ContainsKey(connectionId) && profiles.TryGetValue(connectionId, out var profile) ? profile : throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");

    /// <summary>Object Explorer's own pool: the connection's settings under a distinct program name (as SSMS does), so its
    /// READ UNCOMMITTED and LOCK_TIMEOUT never reach query tabs, SMO or databases.list. It keeps the login's initial
    /// catalog (contained-database users), and is cleared with the connection's other pools on disconnect.</summary>
    SqlConnection IExplorerHost.Connection(string connectionId, string? database) => PoolConnection(connectionId, database, " - Object Explorer");

    /// <summary>Scripting's own pool, for the same reasons: its READ COMMITTED, LOCK_TIMEOUT 10 s and SMO's USE never
    /// reach the other pools, and each job restores its database before the connection returns to the pool.</summary>
    SqlConnection IScriptingHost.Connection(string connectionId, string? database) => PoolConnection(connectionId, database, " - Scripting");

    private SqlConnection PoolConnection(string connectionId, string? database, string suffix)
    {
        if (!connections.TryGetValue(connectionId, out var connectionString)) throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");
        var builder = new SqlConnectionStringBuilder(connectionString) { Pooling = true, CommandTimeout = 30 };
        var name = builder.ApplicationName + suffix;
        builder.ApplicationName = name.Length > 128 ? name[..128] : name;
        if (database is not null) builder.InitialCatalog = database;
        if (pools.TryGetValue(connectionId, out var used)) used.TryAdd(builder.ConnectionString, 0);
        return new SqlConnection(builder.ConnectionString);
    }

    private async Task<List<DatabaseInfo>> DatabasesAsync(ConnectionArgs args, CancellationToken token)
    {
        await using var connection = CreateConnection(args.ConnectionId);
        await connection.OpenAsync(token);
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

    // Select Top N Rows lists the columns; QUOTENAME and parameters keep the names out of the SQL text. Hidden internal
    // columns (graph tables' graph_id and node ids) cannot be selected, unlike hidden temporal period and ledger columns,
    // which are GENERATED ALWAYS.
    private async Task<TableColumnsResult> ColumnsAsync(TableArgs args, CancellationToken token)
    {
        Name(args.Schema);
        Name(args.Name);
        await using var connection = CreateConnection(args.ConnectionId, args.Database);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(30));
        await connection.OpenAsync(deadline.Token);
        await using var command = connection.CreateCommand();
        // Only the token's deadline: on a pooled connection that opens at once, a 30 s CommandTimeout would expire on the
        // same tick and could leave the connection a response behind for its next user.
        command.CommandTimeout = 0;
        command.CommandText = "DECLARE @id int = OBJECT_ID(QUOTENAME(@schema) + N'.' + QUOTENAME(@name));\n"
            + "SELECT CONVERT(bit, CASE WHEN @id IS NULL THEN 0 ELSE 1 END);\n"
            + "SELECT TOP (" + (MaxColumns + 1) + ") c.name, TYPE_NAME(c.user_type_id) FROM sys.all_columns AS c WHERE c.object_id = @id"
            + " AND (c.is_hidden = 0 OR c.generated_always_type <> 0) ORDER BY c.column_id;";
        command.Parameters.Add(new SqlParameter("@schema", System.Data.SqlDbType.NVarChar, 128) { Value = args.Schema });
        command.Parameters.Add(new SqlParameter("@name", System.Data.SqlDbType.NVarChar, 128) { Value = args.Name });
        await using var reader = await command.ExecuteReaderAsync(deadline.Token);
        if (!await reader.ReadAsync(deadline.Token) || !reader.GetBoolean(0)) throw new RequestException("NOT_FOUND", "Table was not found.");
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
        // Validate the whole script before opening a session or submitting any SQL.
        var batches = SqlScript.Parse(args.Sql, args.StartLine);
        using var cancellation = args.TimeoutSeconds == 0 ? new CancellationTokenSource() : new CancellationTokenSource(TimeSpan.FromSeconds(args.TimeoutSeconds));
        var running = new RunningQuery(args.ConnectionId, args.SessionId, cancellation);
        if (!queries.TryAdd(args.QueryId, running)) throw new RequestException("DUPLICATE_QUERY", "This query is already running.");
        // A CANCEL frame for this request: main's backstop means its deadline passed; any other reason stops it like query.cancel.
        using var cancelled = context?.Token.Register(() => { if (context.Reason == CancelReason.Deadline) TryCancel(cancellation); else running.Cancel(); });
        using var events = new QueryEventSink(context is null ? null : context.SendEvent);
        QuerySession? session = null;
        var entered = false;
        var messages = new QueryMessages(events.Message);
        var sets = new List<ResultSetBuffer>();
        ResultSetBuffer? currentSet = null;
        var token = cancellation.Token;
        var watch = Stopwatch.StartNew();
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
                if (error.Class <= 10) { if (!IsContextChange(error)) messages.Add(error.Message); continue; }
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
                if (item.Class <= 10) { if (!IsContextChange(item)) messages.Add(item.Message); }
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
                await connection.OpenAsync(token);
                try
                {
                    await using var prologue = connection.CreateCommand();
                    prologue.CommandText = SessionPrologue;
                    prologue.CommandTimeout = 0;
                    await prologue.ExecuteNonQueryAsync(token);
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
                    using var stop = token.Register(Attention, command);
                    command.StatementCompleted += (_, e) => { if (e.RecordCount >= 0) messages.Add(e.RecordCount == 1 ? "(1 row affected)" : "(" + e.RecordCount + " rows affected)"); };
                    SqlDataReader? reader = null;
                    try
                    {
                        // Sequential access streams each value once, in column order, so a huge value is never materialised
                        // (ColumnPlan reads past the rest of a truncated one).
                        reader = await command.ExecuteReaderAsync(System.Data.CommandBehavior.SequentialAccess, token);
                        do
                        {
                            ColumnPlan? plan = null;
                            bool? hasLong = null;
                            var skipped = false;
                            long transient = 0;
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
                                while (await reader.ReadAsync(token)) collector.AppendRow(reader, token);
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
                                    await SkipRowsAsync(reader, command, currentSet, events, token);
                                    break;
                                }
                                var read = reader.ReadAsync(token);
                                // Rows waiting for the next one are sealed: the first page 20 ms after its first row, later
                                // pages after 200 ms without a row, so a slow statement's rows become readable.
                                if (!read.IsCompleted && currentSet?.SealDelay is { } delay
                                    && (delay == TimeSpan.Zero || await Task.WhenAny(read, Task.Delay(delay, token)) != read))
                                {
                                    currentSet.Seal();
                                    events.Sealed(currentSet);
                                }
                                if (!await read) break;
                                // The reader has let go of the previous row, so a large xml value read whole is garbage now.
                                store.Discarded(transient);
                                transient = 0;
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
                                transient = plan.TransientBytes;
                                var sealedBefore = currentSet.SealedPages;
                                if (currentSet.TryCommitRow(truncatedCells)) storedRows++;
                                if (currentSet.SealedPages != sealedBefore) events.Sealed(currentSet);
                            }
                            store.Discarded(transient);
                            if (currentSet is not null)
                            {
                                currentSet.Complete();
                                events.Closed(currentSet);
                                currentSet = null;
                            }
                        } while (await reader.NextResultAsync(token));
                        if (reader.RecordsAffected >= 0) recordsAffected = Math.Max(0, recordsAffected) + reader.RecordsAffected;
                    }
                    catch (Exception error)
                    {
                        // Do not drain a failed command into later statements unnecessarily.
                        try { command.Cancel(); } catch (Exception cancel) when (cancel is InvalidOperationException or SqlException) { }
                        if (error is not SqlException sql || !Continues(sql, connection)) throw;
                        // Severity 17 to 19 errors still end their batch, and the script goes on with the next one.
                        Report(sql);
                        if (currentSet is not null)
                        {
                            currentSet.Incomplete = true;
                            currentSet.Complete();
                            events.Closed(currentSet);
                            currentSet = null;
                        }
                    }
                    finally { if (reader is not null) await reader.DisposeAsync(); }
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
            if (currentSet is not null) currentSet.Incomplete = true;
            // Before the first batch, -2 is a connect timeout while opening the session, not the script deadline.
            status = running.UserCancelled ? "cancelled" : cancellation.IsCancellationRequested || error.Number == -2 && batchNumber > 0 ? "timedOut" : "failed";
            // Messages delivered with the exception (e.g. PRINT before a severe error, or the error itself) belong in Messages,
            // in order, except errors InfoMessage already reported.
            foreach (SqlError item in error.Errors)
                if (item.Class <= 10) { if (!IsContextChange(item)) messages.Add(item.Message); }
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
                if (session.Connection.State == System.Data.ConnectionState.Open) database = session.Connection.Database;
                if (session.Connection.State is System.Data.ConnectionState.Closed or System.Data.ConnectionState.Broken)
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
            totalBatches, database, messages.Truncated, SummaryBudget(), completedAt);
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

    /// <summary>A global results.memory EVENT, checked once a second and after each results.close: when usage crosses 50,
    /// 75, 90 or 100 % of the budget, grows by 64 MiB, or falls below what the status bar was last shown (results were
    /// closed, or a copy or save that leased them ended). An event the full control lane refused does not count as
    /// reported, so the next check sends it again.</summary>
    internal void ReportMemory()
    {
        lock (memoryGate)
        {
            var used = store.UsedBytes;
            var global = store.GlobalBytes;
            var band = Band(used, global);
            if (publish is null || (reportedBytes < 0 ? used == 0 : used >= reportedBytes && band == reportedBand && used - reportedBytes < MemoryReportStep)) return;
            if (!publish(new { Type = "results.memory", UsedBytes = used, GlobalBytes = global, Seq = memorySeq + 1 })) return;
            memorySeq++;
            reportedBytes = used;
            reportedBand = band;
        }
    }

    /// <summary>A summary's budget. The status bar shows it as it shows an event, so it counts as reported: otherwise a run
    /// that grew by less than a report step, then closed, would leave the status bar showing memory already freed. The
    /// summary is written only after this returns, so an event published meanwhile (a close in another tab) can reach main
    /// first; both take their sequence number under this lock with the usage they carry, and the status bar ignores a
    /// figure older than the one it shows.</summary>
    internal ResultBudget SummaryBudget()
    {
        lock (memoryGate)
        {
            var used = store.UsedBytes;
            reportedBytes = used;
            reportedBand = Band(used, store.GlobalBytes);
            return new ResultBudget(used, store.GlobalBytes, store.QueryBytes, ++memorySeq);
        }
    }

    private static int Band(long used, long global) => used >= global ? 4 : used * 10 >= global * 9 ? 3 : used * 4 >= global * 3 ? 2 : used * 2 >= global ? 1 : 0;

    /// <summary>Reads past the rest of a result set that stores no more rows and has a long column, counting its rows.
    /// ReadAsync would skip each long value by buffering all of it, in time quadratic in its size and deaf to the token; a
    /// synchronous Read skips it in linear time, and Cancel stops it. That Read also blocks while the server is slow to
    /// send the next row (a lock, a slow plan, a remote server), so it runs on a thread of its own: on pool threads, a
    /// few such queries delayed every other request, cancels included, by seconds.</summary>
    private static Task SkipRowsAsync(SqlDataReader reader, SqlCommand command, ResultSetBuffer? set, QueryEventSink events, CancellationToken token) =>
        Task.Factory.StartNew(() =>
        {
            using var cancel = token.Register(Attention, command);
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

    private object Cancel(CancelArgs args)
    {
        var found = queries.TryGetValue(args.QueryId, out var query);
        if (found) query!.Cancel();
        return new { Cancelled = found };
    }

    private static void TryCancel(CancellationTokenSource source)
    {
        try { source.Cancel(); } catch (ObjectDisposedException) { /* Query completed concurrently. */ }
    }

    private object CloseSession(SessionArgs args)
    {
        if (!Guid.TryParse(args.SessionId, out _)) throw new RequestException("INVALID_PARAMS", "A valid session ID is required.");
        foreach (var query in queries.Values.Where(query => query.SessionId == args.SessionId)) query.Cancel();
        var removed = sessions.TryRemove(args.SessionId, out var session);
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
            if (sessions.Count >= SessionLimit) throw new RequestException("SESSION_LIMIT", "Close an unused query tab before opening another SQL session (maximum " + SessionLimit + ").");
            var session = new QuerySession(args.ConnectionId, CreateConnection(args.ConnectionId, args.Database, stateful: true));
            sessions[args.SessionId] = session;
            return session;
        }
    }

    public void CancelAll()
    {
        foreach (var query in queries.Values) query.Cancel();
        scripting.CancelAll();
    }
    public void Dispose()
    {
        memoryTimer?.Dispose();
        explorer.Dispose();
        scripting.Dispose();
        CancelAll();
        foreach (var session in sessions.Values) session.Close();
        sessions.Clear();
        pools.Clear();
        profiles.Clear();
        connections.Clear();
        store.ReleaseAll();
        SqlConnection.ClearAllPools();
    }
}
