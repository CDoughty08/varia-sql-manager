using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.Management.Common;
using Microsoft.SqlServer.Management.Smo;

namespace Varia.Backend;

internal sealed class SqlService : IDisposable
{
    private readonly ConcurrentDictionary<string, string> connections = new();
    private readonly ConcurrentDictionary<string, RunningQuery> queries = new();
    private readonly ConcurrentDictionary<string, QuerySession> sessions = new();
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> pools = new();
    private readonly object sessionGate = new();
    private readonly ServerDiscovery discovery = new();

    private sealed class RunningQuery(string connectionId, string sessionId, CancellationTokenSource source)
    {
        public string ConnectionId { get; } = connectionId;
        public string SessionId { get; } = sessionId;
        public CancellationTokenSource Source { get; } = source;
        public bool UserCancelled { get; private set; }
        public void Cancel() { UserCancelled = true; TryCancel(Source); }
    }

    public async Task<object> DispatchAsync(string method, JsonElement parameters, JsonSerializerOptions json) => method switch
    {
        "system.health" => new
        {
            ProtocolVersion = 1,
            Runtime = RuntimeInformation.FrameworkDescription,
            Platform = RuntimeInformation.OSDescription,
            SmoVersion = typeof(Server).Assembly.GetName().Version?.ToString(),
            SqlClientVersion = typeof(SqlConnection).Assembly.GetName().Version?.ToString()
        },
        "connections.connect" => await ConnectAsync(Read<ConnectOptions>(parameters, json)),
        "connections.databases" => await DiscoverDatabasesAsync(Read<ConnectOptions>(parameters, json)),
        "connections.discover" => await discovery.DiscoverAsync(Read<DiscoveryArgs>(parameters, json)),
        "connections.preview" => ConnectionSettings.Preview(Read<ConnectOptions>(parameters, json)),
        "connections.disconnect" => Disconnect(Read<ConnectionArgs>(parameters, json)),
        "databases.list" => await DatabasesAsync(Read<ConnectionArgs>(parameters, json)),
        "server.objects.list" => await ServerObjectsAsync(Read<ServerObjectArgs>(parameters, json)),
        "tables.list" => await TablesAsync(Read<DatabaseArgs>(parameters, json)),
        "tables.script" => await ScriptAsync(Read<TableArgs>(parameters, json)),
        "query.execute" => await ExecuteAsync(Read<QueryArgs>(parameters, json)),
        "query.cancel" => Cancel(Read<CancelArgs>(parameters, json)),
        "query.session.close" => CloseSession(Read<SessionArgs>(parameters, json)),
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

    private async Task<ConnectionInfo> ConnectAsync(ConnectOptions options)
    {
        if (options.Authentication is not ("windows" or "sql"))
            throw new RequestException("INVALID_PARAMS", "Unsupported authentication mode.");
        if (options.Authentication == "windows" && !OperatingSystem.IsWindows())
            throw new RequestException("AUTH_UNSUPPORTED", "Windows authentication in this bootstrap requires Windows. Use SQL authentication on other platforms.");
        var builder = ConnectionSettings.Build(options);
        await using var connection = new SqlConnection(builder.ConnectionString);
        await connection.OpenAsync();
        var id = Guid.NewGuid().ToString();
        connections[id] = builder.ConnectionString;
        pools[id] = new() { [builder.ConnectionString] = 0 };
        return new(id, options.Server, connection.Database, connection.ServerVersion, options.DisplayName, options.Color, builder.CommandTimeout);
    }

    private static async Task<List<DatabaseInfo>> DiscoverDatabasesAsync(ConnectOptions options)
    {
        // Use the login's default database to discover choices, even if the typed database is stale.
        var builder = ConnectionSettings.Build(options with { Database = "", Advanced = (options.Advanced ?? new()) with { AttachDbFilename = "" } });
        builder.Pooling = false;
        await using var connection = new SqlConnection(builder.ConnectionString);
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        await connection.OpenAsync(deadline.Token);
        return await ReadDatabasesAsync(connection, deadline.Token);
    }

    private object Disconnect(ConnectionArgs args)
    {
        var removed = connections.TryRemove(args.ConnectionId, out var connectionString);
        foreach (var query in queries.Values.Where(query => query.ConnectionId == args.ConnectionId)) query.Cancel();
        foreach (var item in sessions.Where(item => item.Value.ConnectionId == args.ConnectionId))
            if (sessions.TryRemove(item.Key, out var session)) session.Close();
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

    private async Task<List<DatabaseInfo>> DatabasesAsync(ConnectionArgs args)
    {
        await using var connection = CreateConnection(args.ConnectionId);
        await connection.OpenAsync();
        return await ReadDatabasesAsync(connection, CancellationToken.None);
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

    private async Task<List<ServerObjectInfo>> ServerObjectsAsync(ServerObjectArgs args)
    {
        // Fixed catalog queries keep renderer input out of SQL identifiers and expressions.
        var sql = args.Kind switch
        {
            "logins" => "SELECT name, type_desc FROM sys.server_principals WHERE type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X') ORDER BY name;",
            "serverRoles" => "SELECT name, CASE WHEN is_fixed_role = 1 THEN 'Fixed server role' ELSE 'Server role' END FROM sys.server_principals WHERE type = 'R' ORDER BY name;",
            "credentials" => "SELECT name, N'Credential' FROM sys.credentials ORDER BY name;",
            "cryptographicProviders" => "SELECT name, CASE WHEN is_enabled = 1 THEN 'Enabled' ELSE 'Disabled' END FROM sys.cryptographic_providers ORDER BY name;",
            "audits" => "SELECT name, CONCAT(type_desc, CASE WHEN is_state_enabled = 1 THEN ' · Enabled' ELSE ' · Disabled' END) FROM sys.server_audits ORDER BY name;",
            "serverAuditSpecifications" => "SELECT name, CASE WHEN is_state_enabled = 1 THEN 'Enabled' ELSE 'Disabled' END FROM sys.server_audit_specifications ORDER BY name;",
            _ => throw new RequestException("INVALID_PARAMS", "Unsupported server object category.")
        };
        await using var connection = CreateConnection(args.ConnectionId, "master");
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.CommandTimeout = 30;
        await using var reader = await command.ExecuteReaderAsync();
        var result = new List<ServerObjectInfo>();
        while (await reader.ReadAsync()) result.Add(new(reader.GetString(0), reader.GetString(1)));
        return result;
    }

    private async Task<List<TableInfo>> TablesAsync(DatabaseArgs args)
    {
        await using var connection = CreateConnection(args.ConnectionId, args.Database);
        await connection.OpenAsync();
        await using var command = connection.CreateCommand();
        command.CommandTimeout = 30;
        command.CommandText = "SELECT s.name, t.name FROM sys.tables AS t JOIN sys.schemas AS s ON s.schema_id = t.schema_id WHERE t.is_ms_shipped = 0 ORDER BY s.name, t.name;";
        await using var reader = await command.ExecuteReaderAsync();
        var result = new List<TableInfo>();
        while (await reader.ReadAsync()) result.Add(new(reader.GetString(0), reader.GetString(1)));
        return result;
    }

    private async Task<object> ScriptAsync(TableArgs args)
    {
        Name(args.Schema);
        Name(args.Name);
        await using var connection = CreateConnection(args.ConnectionId, args.Database);
        await connection.OpenAsync();
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

    private async Task<QueryResult> ExecuteAsync(QueryArgs args)
    {
        if (string.IsNullOrWhiteSpace(args.Sql) || args.Sql.Length > 1_000_000 || args.MaxRows is < 1 or > 5000
            || args.TimeoutSeconds is < 0 or > 86400 || args.StartLine is < 1 or > 1_000_000 || !Guid.TryParse(args.QueryId, out _) || !Guid.TryParse(args.SessionId, out _))
            throw new RequestException("INVALID_PARAMS", "Query text, ID, session, timeout, or row limit is invalid.");
        Name(args.Database);
        // Validate the whole script before opening a session or submitting any SQL.
        var batches = SqlScript.Parse(args.Sql, args.StartLine);
        using var cancellation = args.TimeoutSeconds == 0 ? new CancellationTokenSource() : new CancellationTokenSource(TimeSpan.FromSeconds(args.TimeoutSeconds));
        var running = new RunningQuery(args.ConnectionId, args.SessionId, cancellation);
        if (!queries.TryAdd(args.QueryId, running)) throw new RequestException("DUPLICATE_QUERY", "This query is already running.");
        QuerySession? session = null;
        var entered = false;
        var messages = new QueryMessages();
        var sets = new List<ResultSet>();
        ResultSet? currentSet = null;
        var token = cancellation.Token;
        var watch = Stopwatch.StartNew();
        var completed = 0;
        var batchNumber = 0;
        var iteration = 0;
        var totalRows = 0;
        var totalCells = 0;
        var discardedSets = false;
        long textBudget = 4_000_000;
        long recordsAffected = -1;
        QueryFailure? failure = null;
        var status = "completed";
        var database = args.Database;
        // Only the first errors are reported; a looping statement can raise millions while its batch keeps running.
        var errors = new List<string>();
        var suppressedErrors = 0;
        string Describe(SqlError item)
        {
            var location = string.IsNullOrEmpty(item.Procedure) && batchNumber > 0 && item.LineNumber > 0
                ? "Line " + (args.StartLine + batches[batchNumber - 1].StartLine + item.LineNumber - 2)
                : string.IsNullOrEmpty(item.Procedure) ? "Connection" : "Procedure " + item.Procedure + ", line " + item.LineNumber;
            return "Msg " + item.Number + ", Level " + item.Class + ", State " + item.State + ", " + location + ": " + item.Message;
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
                lock (errors) { if (errors.Count < 20) errors.Add(Describe(error)); else suppressedErrors++; }
            }
        };
        // The error that stopped execution comes first, then those SQL Server reported while the script continued.
        string ErrorText(IEnumerable<string> terminating)
        {
            var lines = terminating.Take(20).Concat(errors);
            if (suppressedErrors > 0) lines = lines.Append("… and " + suppressedErrors + " more errors.");
            var text = string.Join(Environment.NewLine, lines);
            return text.Length > 16384 ? text[..16384] + "…" : text;
        }
        string Stopped(string reason) => errors.Count == 0 ? reason : reason + Environment.NewLine + ErrorText([]);

        try
        {
            session = Session(args);
            entered = session.TryEnter();
            if (!entered) throw new RequestException("SESSION_BUSY", "A query is already running in this tab.");
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
                    await using var command = connection.CreateCommand();
                    command.CommandText = batch.Sql;
                    command.CommandTimeout = args.TimeoutSeconds == 0 ? 0 : Math.Max(1, (int)Math.Ceiling(args.TimeoutSeconds - watch.Elapsed.TotalSeconds));
                    command.StatementCompleted += (_, e) => { if (e.RecordCount >= 0) messages.Add("(" + e.RecordCount + " rows affected)"); };
                    SqlDataReader? reader = null;
                    try
                    {
                        reader = await command.ExecuteReaderAsync(token);
                        do
                        {
                            var keep = reader.FieldCount > 0 && sets.Count < 10;
                            if (reader.FieldCount > 0 && !keep) discardedSets = true;
                            var raw = new CellMode[reader.FieldCount];
                            if (keep)
                            {
                                var columns = new List<ColumnInfo>();
                                for (var i = 0; i < reader.FieldCount; i++) columns.Add(new(reader.GetName(i), reader.GetDataTypeName(i)));
                                var isPlan = columns.Count == 1 && columns[0].Name.Equals("Microsoft SQL Server 2005 XML Showplan", StringComparison.OrdinalIgnoreCase);
                                currentSet = new(columns, batchNumber, iteration, isPlan);
                                sets.Add(currentSet);
                            }
                            while (await reader.ReadAsync(token))
                            {
                                if (!keep) continue;
                                if (totalRows >= args.MaxRows || textBudget <= 0 || totalCells + reader.FieldCount > 100_000)
                                {
                                    currentSet!.Truncated = true;
                                    continue;
                                }
                                var row = new object?[reader.FieldCount];
                                for (var i = 0; i < row.Length; i++)
                                {
                                    var value = ReadCell(reader, i, raw);
                                    if (value is string text)
                                    {
                                        var cellLimit = currentSet!.Kind == "executionPlan" ? 1_000_000 : 16384;
                                        var available = (int)Math.Max(0, Math.Min(cellLimit, textBudget));
                                        if (text.Length > available) { value = text[..available] + "… [cell truncated]"; currentSet.Truncated = true; }
                                        textBudget -= ((string)value).Length;
                                    }
                                    row[i] = value;
                                }
                                currentSet!.Rows.Add(row);
                                totalRows++;
                                totalCells += row.Length;
                            }
                            currentSet = null;
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
                }
            }
        }
        catch (SqlException error)
        {
            if (currentSet is not null) currentSet.Incomplete = true;
            // Before the first batch, -2 is a connect timeout while opening the session, not the script deadline.
            status = running.UserCancelled ? "cancelled" : cancellation.IsCancellationRequested || error.Number == -2 && batchNumber > 0 ? "timedOut" : "failed";
            // Informational messages delivered with the exception (e.g. PRINT before a severe error) belong in Messages.
            foreach (SqlError item in error.Errors) if (item.Class <= 10) messages.Add(item.Message);
            var details = error.Errors.Cast<SqlError>().Where(item => item.Class > 10).Select(Describe).ToList();
            if (details.Count == 0) details.Add(error.Message);
            var text = status == "cancelled" ? Stopped("The script was cancelled. Remaining batches were not executed.")
                : status == "timedOut" ? Stopped("The script exceeded its execution timeout. Remaining batches were not executed.")
                : ErrorText(details);
            failure = new(status == "failed" ? "SQL_ERROR" : status == "cancelled" ? "CANCELLED" : "TIMEOUT", text, batchNumber, iteration);
        }
        catch (OperationCanceledException)
        {
            if (currentSet is not null) currentSet.Incomplete = true;
            status = running.UserCancelled ? "cancelled" : "timedOut";
            failure = new(running.UserCancelled ? "CANCELLED" : "TIMEOUT", Stopped(running.UserCancelled
                ? "The script was cancelled. Remaining batches were not executed."
                : "The script exceeded its execution timeout. Remaining batches were not executed."), batchNumber, iteration);
        }
        catch (Exception error) when (error is not RequestException)
        {
            // Keep earlier result sets and messages when the provider fails outside SQL Server error handling.
            if (currentSet is not null) currentSet.Incomplete = true;
            status = "failed";
            failure = new("BACKEND_ERROR", ErrorText(["Execution stopped unexpectedly: " + error.Message]), batchNumber, iteration);
        }
        finally
        {
            queries.TryRemove(args.QueryId, out _);
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
        if (sets.Any(set => set.Truncated)) output.Add("Results were truncated by display limits. Display limits do not stop script execution.");
        if (discardedSets) output.Add("Only the first ten result sets are displayed. Display limits do not stop script execution.");
        if (failure is not null && batchNumber > 0) output.Add("Stopped at batch " + batchNumber + ", repetition " + iteration + "; " + completed + " of " + batches.Sum(batch => batch.RepeatCount) + " batch executions completed.");
        return new(sets, output, recordsAffected, watch.ElapsedMilliseconds, status, failure, completed,
            batches.Sum(batch => batch.RepeatCount), database, messages.Truncated);
    }

    private enum CellMode : byte { Value, SqlValue, Bytes }

    /// <summary>Falls back per column when the CLR value cannot be materialized, e.g. CLR UDTs without
    /// Microsoft.SqlServer.Types (hierarchyid, geometry, geography) or decimals beyond System.Decimal.</summary>
    private static object? ReadCell(SqlDataReader reader, int ordinal, CellMode[] modes)
    {
        if (modes[ordinal] == CellMode.Value)
        {
            try { return FormatValue(reader.GetValue(ordinal)); }
            catch (Exception error) when (error is not SqlException and not OperationCanceledException) { modes[ordinal] = CellMode.SqlValue; }
        }
        if (reader.IsDBNull(ordinal)) return null;
        if (modes[ordinal] == CellMode.SqlValue)
        {
            try { return Convert.ToString(reader.GetSqlValue(ordinal), CultureInfo.InvariantCulture); }
            catch (Exception error) when (error is not SqlException and not OperationCanceledException) { modes[ordinal] = CellMode.Bytes; }
        }
        // SSMS also displays CLR UDT values as their serialized bytes.
        return FormatValue(reader.GetSqlBytes(ordinal).Value);
    }

    private static object? FormatValue(object value) => value switch
    {
        DBNull => null,
        byte[] bytes => "0x" + Convert.ToHexString(bytes.AsSpan(0, Math.Min(bytes.Length, 8192))) + (bytes.Length > 8192 ? "… [cell truncated]" : ""),
        DateTime date => date.ToString("O", CultureInfo.InvariantCulture),
        DateTimeOffset date => date.ToString("O", CultureInfo.InvariantCulture),
        long or ulong or decimal => Convert.ToString(value, CultureInfo.InvariantCulture),
        float number when !float.IsFinite(number) => number.ToString(CultureInfo.InvariantCulture),
        double number when !double.IsFinite(number) => number.ToString(CultureInfo.InvariantCulture),
        bool or byte or short or int or float or double => value,
        _ => Convert.ToString(value, CultureInfo.InvariantCulture)
    };

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
        CancelAll();
        foreach (var session in sessions.Values) session.Close();
        sessions.Clear();
        pools.Clear();
        connections.Clear();
        SqlConnection.ClearAllPools();
    }
}
