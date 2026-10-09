using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.Management.Common;
using Microsoft.SqlServer.Management.Smo;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend;

internal sealed class SqlService : IRequestDispatcher, IExplorerHost
{
    /// <summary>Announced in HELLO; main refuses a backend that lacks any method it may call (a stale build).</summary>
    public static readonly string[] MethodNames =
    [
        "system.health", "connections.connect", "connections.databases", "connections.discover", "connections.preview", "connections.disconnect",
        "databases.list", "tables.script", "tables.columns", "query.execute", "query.cancel", "query.session.close",
        "results.read", "results.close", "explorer.children", "results.copy", "results.export"
    ];
    /// <summary>Synthetic results for tests and benchmarks; it exists only with VARIA_BACKEND_TEST_HOOKS=1.</summary>
    public const string SynthesizeMethod = "debug.results.synthesize";
    private const long MaxSafeInteger = 9_007_199_254_740_991;
    private const long MemoryReportStep = 64L * 1024 * 1024;
    private const string CancelledSentence = "The script was cancelled. Remaining batches were not executed.";
    private const string TimedOutSentence = "The script exceeded its execution timeout. Remaining batches were not executed.";
    // The summary must fit the 16 MiB response limit: descriptors get 8 MiB, messages (1,000,000 characters, with their
    // kinds) and the error text the rest, with room to spare.
    private const long MaxSummaryDescriptorBytes = 8L * 1024 * 1024;

    private readonly ConcurrentDictionary<string, string> connections = new();
    private readonly ConcurrentDictionary<string, RunningQuery> queries = new();
    private readonly ConcurrentDictionary<string, QuerySession> sessions = new();
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> pools = new();
    private readonly ConcurrentDictionary<string, ServerProfile> profiles = new();
    private readonly ExplorerService explorer;
    private readonly object sessionGate = new();
    private readonly ServerDiscovery discovery = new();
    private readonly ResultStore store;
    private readonly ResultJobs jobs;
    private readonly bool hooks;
    private readonly Action<object>? publish;
    private readonly Timer? memoryTimer;
    private long reportedBytes = -1;
    private int reportedBand;
    private object? health;

    private sealed class RunningQuery(string connectionId, string sessionId, CancellationTokenSource source)
    {
        public string ConnectionId { get; } = connectionId;
        public string SessionId { get; } = sessionId;
        public CancellationTokenSource Source { get; } = source;
        public bool UserCancelled { get; private set; }
        public void Cancel() { UserCancelled = true; TryCancel(Source); }
    }

    /// <param name="store">Defaults to the system budget (<see cref="ResultStore.FromSystem"/>).</param>
    /// <param name="hooks">Adds debug.results.synthesize (VARIA_BACKEND_TEST_HOOKS=1, set by main only for smoke tests).</param>
    /// <param name="publish">Sends a global EVENT; result memory usage is reported through it at most once a second.</param>
    public SqlService(ResultStore? store = null, bool hooks = false, Action<object>? publish = null)
    {
        this.store = store ?? ResultStore.FromSystem();
        jobs = new ResultJobs(this.store);
        this.hooks = hooks;
        this.publish = publish;
        Methods = hooks ? [.. MethodNames, SynthesizeMethod] : MethodNames;
        explorer = new ExplorerService(this);
        if (publish is not null) memoryTimer = new Timer(_ => ReportMemory(), null, 1000, 1000);
    }

    /// <summary>The service as the backend process runs it. Test hooks, and the budget override VARIA_RESULT_BUDGET_BYTES,
    /// apply only with VARIA_BACKEND_TEST_HOOKS=1; main passes those variables only to unpackaged smoke runs.</summary>
    public static SqlService FromEnvironment(Action<object>? publish)
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
        "tables.script" => await ScriptAsync(Read<TableArgs>(parameters, json), Token(context)),
        "tables.columns" => await ColumnsAsync(Read<TableArgs>(parameters, json), Token(context)),
        "query.execute" => await ExecuteAsync(Read<QueryArgs>(parameters, json), context),
        "query.cancel" => Cancel(Read<CancelArgs>(parameters, json)),
        "query.session.close" => CloseSession(Read<SessionArgs>(parameters, json)),
        "results.read" => await ReadResultsAsync(Read<ResultsReadArgs>(parameters, json), context),
        "results.close" => CloseResults(Read<ResultsCloseArgs>(parameters, json)),
        "results.copy" => await jobs.CopyAsync(Read<ResultsCopyArgs>(parameters, json), context),
        "results.export" => await jobs.ExportAsync(Read<ResultsExportArgs>(parameters, json), context),
        "explorer.children" => await explorer.ChildrenAsync(Read<ExplorerChildrenArgs>(parameters, json), Token(context)),
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

    ServerProfile IExplorerHost.Profile(string connectionId) =>
        connections.ContainsKey(connectionId) && profiles.TryGetValue(connectionId, out var profile) ? profile : throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");

    /// <summary>Object Explorer's own pool: the connection's settings under a distinct program name (as SSMS does), so its
    /// READ UNCOMMITTED and LOCK_TIMEOUT never reach query tabs, SMO or databases.list. It keeps the login's initial
    /// catalog (contained-database users), and is cleared with the connection's other pools on disconnect.</summary>
    SqlConnection IExplorerHost.Connection(string connectionId, string? database)
    {
        if (!connections.TryGetValue(connectionId, out var connectionString)) throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");
        var builder = new SqlConnectionStringBuilder(connectionString) { Pooling = true, CommandTimeout = 30 };
        var name = builder.ApplicationName + " - Object Explorer";
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
        command.CommandTimeout = 30;
        command.CommandText = "SELECT name, CONVERT(bit, CASE WHEN database_id <= 4 THEN 1 ELSE 0 END), CONVERT(bit, CASE WHEN source_database_id IS NOT NULL THEN 1 ELSE 0 END) FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name;";
        await using var reader = await command.ExecuteReaderAsync(token);
        var result = new List<DatabaseInfo>();
        while (await reader.ReadAsync(token)) result.Add(new(reader.GetString(0), reader.GetBoolean(1), reader.GetBoolean(2)));
        return result;
    }

    private async Task<object> ScriptAsync(TableArgs args, CancellationToken token)
    {
        Name(args.Schema);
        Name(args.Name);
        await using var connection = CreateConnection(args.ConnectionId, args.Database);
        // SMO cannot be interrupted once it runs; the host answers TIMEOUT at the deadline and keeps the slot until it returns.
        await connection.OpenAsync(token);
        var serverConnection = new ServerConnection(connection) { StatementTimeout = 30 };
        try
        {
            var server = new Server(serverConnection);
            var database = server.Databases[args.Database]
                ?? throw new RequestException("NOT_FOUND", "Database was not found.");
            var table = database.Tables[args.Name, args.Schema]
                ?? throw new RequestException("NOT_FOUND", "Table was not found.");
            var script = table.Script(new ScriptingOptions
            {
                SchemaQualify = true, ScriptSchema = true, ScriptData = false,
                DriAll = true, Indexes = true, IncludeHeaders = true
            });
            return new { Sql = string.Join(Environment.NewLine + Environment.NewLine, script.Cast<string>()) };
        }
        finally { serverConnection.Disconnect(); }
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
        command.CommandTimeout = 30;
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
                if (error.Class <= 10) { messages.Add(error.Message); continue; }
                // An error while rows stream means the statement producing the current result set stopped early.
                if (currentSet is not null) currentSet.Incomplete = true;
                var text = Describe(error);
                messages.Add(text, MessageKind.Error);
                lock (errors)
                {
                    delivered.Enqueue((error.Number, error.State, error.LineNumber, error.Message));
                    if (delivered.Count > 20) delivered.Dequeue();
                    if (errors.Count < 20) errors.Add(text); else suppressedErrors++;
                }
            }
        };
        bool Delivered(SqlError item)
        {
            lock (errors) return delivered.Contains((item.Number, item.State, item.LineNumber, item.Message));
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
                    await using var command = connection.CreateCommand();
                    command.CommandText = batch.Sql;
                    command.CommandTimeout = args.TimeoutSeconds == 0 ? 0 : Math.Max(1, (int)Math.Ceiling(args.TimeoutSeconds - watch.Elapsed.TotalSeconds));
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
                    catch
                    {
                        // Do not drain a failed command into later statements unnecessarily.
                        try { command.Cancel(); } catch (Exception error) when (error is InvalidOperationException or SqlException) { }
                        throw;
                    }
                    finally { if (reader is not null) await reader.DisposeAsync(); }
                    database = connection.Database;
                    // Like SSMS's default, a batch that raised an error stops the remaining batches.
                    if (errors.Count > 0) { status = "failed"; failure = new("SQL_ERROR", ErrorText([]), batchNumber, iteration); break; }
                    completed++;
                    events.Progress(completed, totalBatches, batchNumber, iteration);
                }
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
                if (item.Class <= 10) messages.Add(item.Message);
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
        if (overflowSets > 0) Note("Only the first " + (args.MaxResultSets == 10 ? "ten" : args.MaxResultSets.ToString(CultureInfo.InvariantCulture)) + " result sets are displayed. Display limits do not stop script execution.");
        if (oversizeSets > 0) Note(oversizeSets + " later result sets are not displayed because their column lists are too large to return. Display limits do not stop script execution.");
        if (failure is not null && batchNumber > 0) Note("Stopped at batch " + batchNumber + ", repetition " + iteration + "; " + completed + " of " + totalBatches + " batch executions completed.");
        if (context is not null) context.Unsent = () => store.Release(descriptors.Select(set => set.ResultId));
        var completedAt = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffffffzzz", CultureInfo.InvariantCulture);
        return new(descriptors, overflowSets + oversizeSets + budgetSets, output, recordsAffected, watch.ElapsedMilliseconds, status, failure, completed,
            totalBatches, database, messages.Truncated, new ResultBudget(store.UsedBytes, store.GlobalBytes, store.QueryBytes), completedAt);
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

    /// <summary>A global results.memory EVENT at most once a second, when usage crosses 50, 75, 90 or 100 % of the budget
    /// or moves by 64 MiB.</summary>
    private void ReportMemory()
    {
        var used = store.UsedBytes;
        var global = store.GlobalBytes;
        var band = used >= global ? 4 : used * 10 >= global * 9 ? 3 : used * 4 >= global * 3 ? 2 : used * 2 >= global ? 1 : 0;
        var previous = Interlocked.Read(ref reportedBytes);
        if (previous < 0 ? used == 0 : band == reportedBand && Math.Abs(used - previous) < MemoryReportStep) return;
        Interlocked.Exchange(ref reportedBytes, used);
        reportedBand = band;
        publish?.Invoke(new { Type = "results.memory", UsedBytes = used, GlobalBytes = global });
    }

    /// <summary>Reads past the rest of a result set that stores no more rows and has a long column, counting its rows.
    /// ReadAsync would skip each long value by buffering all of it, in time quadratic in its size and deaf to the token; a
    /// synchronous Read skips it in linear time, and Cancel stops it. That Read also blocks while the server is slow to
    /// send the next row (a lock, a slow plan, a remote server), so it runs on a thread of its own: on pool threads, a
    /// few such queries delayed every other request, cancels included, by seconds.</summary>
    private static Task SkipRowsAsync(SqlDataReader reader, SqlCommand command, ResultSetBuffer? set, QueryEventSink events, CancellationToken token) =>
        Task.Factory.StartNew(() =>
        {
            using var cancel = token.Register(command.Cancel);
            while (true)
            {
                token.ThrowIfCancellationRequested();
                if (!reader.Read()) return;
                if (set is null) continue;
                set.CountRow();
                events.RowsChanged();
            }
        }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default);

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
            if (sessions.Count >= 32) throw new RequestException("SESSION_LIMIT", "Close an unused query tab before opening another SQL session (maximum 32).");
            var session = new QuerySession(args.ConnectionId, CreateConnection(args.ConnectionId, args.Database, stateful: true));
            sessions[args.SessionId] = session;
            return session;
        }
    }

    public void CancelAll() { foreach (var query in queries.Values) query.Cancel(); }
    public void Dispose()
    {
        memoryTimer?.Dispose();
        explorer.Dispose();
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
