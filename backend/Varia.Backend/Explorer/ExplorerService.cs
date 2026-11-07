using System.Collections.Concurrent;
using System.Data;
using System.Diagnostics;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Common;

namespace Varia.Backend.Explorer;

/// <summary>What the service needs from SqlService: a connection's profile and its Object Explorer pool.</summary>
internal interface IExplorerHost
{
    /// <summary>Throws NOT_CONNECTED for an unknown connection.</summary>
    ServerProfile Profile(string connectionId);
    /// <summary>An unopened connection from the connection's Object Explorer pool; with a database, a pool in that database
    /// (cloud editions, which cannot EXEC across databases).</summary>
    SqlConnection Connection(string connectionId, string? database);
    /// <summary>An unopened connection from the connection's SSIS read pool (" - Integration Services"), in the SSIS Catalog's
    /// database, for QueryScope.Ssis listings.</summary>
    SqlConnection SsisConnection(string connectionId);
    /// <summary>The SSIS Catalog's database: SSISDB, or the checks' fake catalog.</summary>
    string SsisCatalog { get; }
    /// <summary>Opens one of those connections; a Kerberos token failure throws AUTH_KERBEROS (or AUTH_UNSUPPORTED), and a
    /// Microsoft Entra token failure AUTH_ENTRA, which the node shows.</summary>
    Task OpenAsync(SqlConnection connection, CancellationToken token);
}

/// <summary>Limits and test seams (live checks set the internal ones through InternalsVisibleTo).</summary>
internal sealed class ExplorerOptions
{
    public int PerConnection { get; init; } = 4;
    public int Total { get; init; } = 8;
    /// <summary>Peek's own slots per connection, outside PerConnection and Total: a peek is one small read the user waits on, so
    /// it never queues behind the tree's paging.</summary>
    public int PeekPerConnection { get; init; } = 1;
    public int MaxRegistered { get; init; } = 1024;
    public TimeSpan Budget { get; set; } = TimeSpan.FromSeconds(40);
    /// <summary>Stop reading a page once its estimated size passes this many bytes.</summary>
    public long SizeCut { get; set; } = 900_000;
    /// <summary>Renders every statement for this band instead of the server's.</summary>
    public int? ForceBand { get; set; }
    /// <summary>Runs database statements on a pool per database, as on cloud editions.</summary>
    public bool ForcePerDatabaseScope { get; set; }
    /// <summary>Delays every catalog statement (cancellation checks).</summary>
    public TimeSpan? TestDelay { get; set; }
    /// <summary>Replaces Peek's budget from the catalogue (timeout checks).</summary>
    public TimeSpan? PeekBudget { get; set; }
}

/// <summary>explorer.children: static folders straight from the catalogue (no SQL, no slot), dynamic rows from constant
/// catalog SQL under per-connection and global gates, paged by keyset. Catalog failures are values; a cancelled
/// request (CANCEL frame, deadline, disconnect) throws.</summary>
internal sealed class ExplorerService : IDisposable
{
    private readonly IExplorerHost host;
    private readonly ExplorerCatalog catalog;
    private readonly IReadOnlyDictionary<string, ExplorerQuery> queries;
    private readonly RequestRegistry running;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> peekGates = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim total;

    /// <param name="catalog">A catalogue other than the embedded one, with <paramref name="queries"/> for the ids it lists
    /// (checks of mechanisms no shipped kind uses yet).</param>
    public ExplorerService(IExplorerHost host, ExplorerOptions? options = null, ExplorerCatalog? catalog = null, IReadOnlyDictionary<string, ExplorerQuery>? queries = null)
    {
        this.host = host;
        Options = options ?? new ExplorerOptions();
        this.catalog = catalog ?? ExplorerCatalog.Current;
        this.queries = queries ?? ExplorerQueries.All;
        total = new SemaphoreSlim(Options.Total);
        running = new RequestRegistry(Options.MaxRegistered, "Object Explorer");
    }

    public ExplorerOptions Options { get; }
    /// <summary>Requests registered and not yet finished.</summary>
    public int RunningCount => running.Count;

    public async Task<ExplorerChildrenResult> ChildrenAsync(ExplorerChildrenArgs args, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var request = ExplorerRefs.Validate(args, catalog);
        CursorKey? key = null;
        if (request.Cursor is not null) key = ExplorerCursor.Parse(request.Cursor, request.List!, queries[request.List!].Keyset);
        var server = host.Profile(request.ConnectionId);
        var real = server.Explorer(catalog);
        var profile = Options.ForceBand is { } band ? real with { Band = band } : real;
        ExplorerRefs.CheckServed(request, catalog, profile);
        // The catalog node is the catalog's database; any other name is a stale or forged ref.
        if (request.Object.Kind == "ssisCatalog" && !string.Equals(request.Object.Name, host.SsisCatalog, StringComparison.OrdinalIgnoreCase))
            throw new RequestException("INVALID_PARAMS", "Invalid Object Explorer request: the SSIS Catalog is " + host.SsisCatalog + ".");
        using var source = CancellationTokenSource.CreateLinkedTokenSource(token);
        var entry = running.Register(request.RequestId, request.ConnectionId, source);
        try
        {
            // A request cancelled before it ran (a CANCEL frame read right after its REQUEST) takes no slot.
            token.ThrowIfCancellationRequested();
            source.CancelAfter(Options.Budget);
            var page = await LoadAsync(request, profile, server.VectorDimensions, key, source.Token);
            return page with { ElapsedMs = watch.ElapsedMilliseconds };
        }
        catch (Exception error) when (error is OperationCanceledException or SqlException && source.IsCancellationRequested && !token.IsCancellationRequested)
        {
            if (entry.Forgotten) throw new RequestException("CANCELLED", "The operation was cancelled.");
            return new([], watch.ElapsedMilliseconds, Error: ExplorerErrors.Create("TIMEOUT", Subject(request), request.Database));
        }
        finally { running.Unregister(request.RequestId, entry); }
    }

    /// <summary>explorer.peek: one constant batch (PeekSql) in the object's database on the same pools and with the same error
    /// values as explorer.children, under the connection's peek slot rather than the tree's gates, within the catalogue's budget
    /// from the moment it has its slot (a TIMEOUT value past it).</summary>
    public async Task<PeekResult> PeekAsync(PeekArgs args, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var spec = ExplorerRefs.ValidatePeek(args, catalog);
        var target = args.Target;
        var real = host.Profile(args.ConnectionId).Explorer(catalog);
        var profile = Options.ForceBand is { } band ? real with { Band = band } : real;
        var batch = PeekSql.Render(spec, new SqlRender(profile.Band), catalog.Peek.DefinitionChars);
        var budget = Options.PeekBudget ?? TimeSpan.FromMilliseconds(catalog.Peek.BudgetMs);
        using var source = CancellationTokenSource.CreateLinkedTokenSource(token);
        var entry = running.Register(args.RequestId, args.ConnectionId, source);
        try
        {
            token.ThrowIfCancellationRequested();
            var lane = peekGates.GetOrAdd(args.ConnectionId, _ => new SemaphoreSlim(Options.PeekPerConnection));
            var values = new Values(target.Schema, target.Name, null, false, 0, null, null, null, null, null, null, null);
            var result = await RunAsync(args.ConnectionId, target.Database, target.Schema + "." + target.Name, profile, QueryScope.Database, batch.Text, values, async (_, reader) =>
                await ParentExistsAsync(reader, source.Token) && await reader.ReadAsync(source.Token)
                    ? PeekSql.Read(reader, spec, batch, profile.Band, catalog.Peek.DefinitionChars)
                    : new PeekResult([], 0, Error: NotFound(target)),
                error => new PeekResult([], 0, Error: error), source.Token, lane, () => source.CancelAfter(budget));
            return result with { ElapsedMs = watch.ElapsedMilliseconds };
        }
        catch (Exception error) when (error is OperationCanceledException or SqlException && source.IsCancellationRequested && !token.IsCancellationRequested)
        {
            if (entry.Forgotten) throw new RequestException("CANCELLED", "The operation was cancelled.");
            return new([], watch.ElapsedMilliseconds, Error: new("TIMEOUT", "Reading the properties took longer than "
                + Math.Ceiling(budget.TotalSeconds).ToString(CultureInfo.InvariantCulture) + " seconds. Retry.", true));
        }
        finally { running.Unregister(args.RequestId, entry); }
    }

    /// <summary>Cancels a disconnected connection's requests and drops its gate.</summary>
    public void Forget(string connectionId)
    {
        running.Forget(connectionId);
        gates.TryRemove(connectionId, out _);
        peekGates.TryRemove(connectionId, out _);
    }

    public void Dispose()
    {
        running.ForgetAll();
        gates.Clear();
        peekGates.Clear();
    }

    private async Task<ExplorerChildrenResult> LoadAsync(ExplorerRequest request, ExplorerProfile profile, bool vector, CursorKey? key, CancellationToken token)
    {
        var target = request.Object;
        var nodes = new List<ExplorerNode>();
        // Static folders (and an object's checks before them) lead the first page only; filters never apply to them. The
        // node's rows follow: a folder's, or those an object kind lists directly below itself.
        if (key is null && request.Folder is null)
        {
            if (target.Kind == "database")
            {
                var problem = await DatabaseProblemAsync(request, profile, token);
                if (problem is not null) return new(nodes, 0, Error: problem);
            }
            else if (request.Subtype is { } subtype && catalog.KindOf(target.Kind).HistoryLookup.Contains(subtype))
            {
                var (history, error) = await HistoryAsync(request, profile, vector, token);
                if (error is not null) return new(nodes, 0, Error: error);
                if (history is not null) nodes.Add(history);
            }
            // Group by Schema: a database keeps the folders of its database-scoped objects and lists its schemas after them, and
            // a schema row has the folders of the objects in it.
            var folders = target.Kind == "database" && request.Grouped ? catalog.GroupedDatabaseFolders(profile)
                : target.Kind == "schema" ? catalog.SchemaGroupFolders(profile)
                : catalog.StaticFolders(target.Kind, request.Subtype, profile);
            nodes.AddRange(folders.Select(id => FolderNode(target, id)));
        }
        else if (key is null) nodes.AddRange(catalog.Subfolders(request.Folder!.Id, target.Kind, request.Grouped, profile).Select(id => FolderNode(target, id)));
        if (request.List is null) return new(nodes, 0, Total: nodes.Count);
        var query = queries[request.List];
        var render = new SqlRender(profile.Band, vector, FilterShape.From(request.Filter), query.ChildFolder ? target.Kind : null);
        var first = key is null;
        var statics = nodes.Count;
        return await RunAsync(request, profile, query.Scope, query.Render(render), Parameters(request, key, first) with { SsisCatalog = host.SsisCatalog }, async (command, reader) =>
        {
            if ((query.ChildFolder || query.OwnerLookup is not null) && !await ParentExistsAsync(reader, token)) return new(nodes, 0, Error: NotFound(target));
            var context = new RowContext(catalog, profile, request.Database, target);
            if (query.ReadPrelude is not null) context = context with { Prelude = await query.ReadPrelude(reader, token) };
            int? total = null;
            if (first)
            {
                if (await reader.ReadAsync(token)) total = (int)Math.Min(int.MaxValue - statics - 1, reader.GetInt64(0)) + statics + (query.Tail is null ? 0 : 1);
                await reader.NextResultAsync(token);
            }
            var row = new Row(reader, context, query.Keys.Length);
            long estimate = 0;
            var count = 0;
            var more = false;
            CursorKey last = default;
            while (await reader.ReadAsync(token))
            {
                if (count == request.PageSize || estimate > Options.SizeCut) { more = true; break; }
                last = query.KeyOf(row);
                count++;
                // A candidate the folder does not list still moves the cursor on.
                if (query.Candidates is not null && !row.Listed) continue;
                var node = query.Map(row);
                nodes.Add(node);
                estimate += Estimate(node);
            }
            // Rows past the page are not drained: attention stops the statement.
            if (more) TryCancel(command);
            else if (first && count == 0 && query.WhenEmpty?.Invoke(context) is { } empty) return new(nodes, 0, Error: empty);
            else if (query.Tail?.Invoke(context) is { } tail) nodes.Add(tail);
            return new(nodes, 0, more ? ExplorerCursor.Encode(query.Id, last) : null, total);
        }, token, nodes);
    }

    private async Task<ExplorerError?> DatabaseProblemAsync(ExplorerRequest request, ExplorerProfile profile, CancellationToken token)
    {
        var name = request.Object.Name!;
        var result = await RunAsync(request, profile, QueryScope.Server, ExplorerQueries.DatabaseState, Parameters(request, null, false, name), async (_, reader) =>
        {
            if (!await reader.ReadAsync(token)) return new ExplorerChildrenResult([], 0, Error: ExplorerErrors.Create("NOT_FOUND", "Database " + name, null));
            var state = Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture);
            if (state is not (0 or 5)) return new([], 0, Error: ExplorerErrors.Create("DATABASE_UNAVAILABLE", name, name, 0, ExplorerLabels.DatabaseState(state)));
            // A single-user database another session is in denies access until that session leaves (Msg 924).
            if (!reader.GetBoolean(2))
                return new([], 0, Error: Convert.ToInt32(reader.GetValue(1), CultureInfo.InvariantCulture) == 1
                    ? ExplorerErrors.Create("DATABASE_UNAVAILABLE", name, name, 0, "Single User, in use by another session")
                    : ExplorerErrors.Create("NO_DB_ACCESS", name, name));
            return new([], 0);
        }, token, []);
        return result.Error;
    }

    private async Task<(ExplorerNode? Row, ExplorerError? Error)> HistoryAsync(ExplorerRequest request, ExplorerProfile profile, bool vector, CancellationToken token)
    {
        var target = request.Object;
        ExplorerNode? history = null;
        var result = await RunAsync(request, profile, QueryScope.Database, ExplorerQueries.HistoryTable(new SqlRender(profile.Band, vector)),
            Parameters(request, null, false, target.Name, target.Schema), async (_, reader) =>
            {
                if (!await ParentExistsAsync(reader, token)) return new ExplorerChildrenResult([], 0, Error: ExplorerErrors.Create("NOT_FOUND", target.Schema + "." + target.Name, request.Database));
                if (await reader.ReadAsync(token))
                {
                    var context = new RowContext(catalog, profile, request.Database, target);
                    var subtype = Convert.ToInt32(reader.GetValue(3), CultureInfo.InvariantCulture) == 1 ? "ledgerHistory" : "history";
                    var (schema, name) = (reader.GetString(0), reader.GetString(1));
                    history = ExplorerQueries.Node(context, new ObjectRefDto("table", request.Database, schema, name), schema + "." + name, subtype, "(History)",
                        created: reader.IsDBNull(2) ? null : reader.GetDateTime(2));
                }
                return new([], 0);
            }, token, []);
        return (history, result.Error);
    }

    private static async Task<bool> ParentExistsAsync(SqlDataReader reader, CancellationToken token)
    {
        var exists = await reader.ReadAsync(token) && reader.GetBoolean(0);
        if (exists) await reader.NextResultAsync(token);
        return exists;
    }

    private static ExplorerError NotFound(ObjectRefDto target) =>
        ExplorerErrors.Create("NOT_FOUND", target.Schema is null ? target.Name ?? target.Kind : target.Schema + "." + target.Name, target.Database);

    private string Subject(ExplorerRequest request) => request.Folder?.Label ?? (request.Object.Schema is null ? request.Object.Name ?? "Server" : request.Object.Schema + "." + request.Object.Name);

    private ExplorerNode FolderNode(ObjectRefDto owner, string folder) => new(new NodeRefDto("folder", Owner: owner, Folder: folder), catalog.Folder(folder)!.Label, "folder", true);

    /// <summary>A node's share of the response: 96 bytes plus two per character of its text and ref.</summary>
    internal static long Estimate(ExplorerNode node)
    {
        var value = node.Ref.Object ?? node.Ref.Owner!;
        return 96 + 2L * (node.Label.Length + (node.Sublabel?.Length ?? 0) + (node.Detail?.Length ?? 0) + (value.Database?.Length ?? 0) + (value.Schema?.Length ?? 0)
            + (value.Name?.Length ?? 0) + (value.Parent is { } parent ? parent.Schema.Length + parent.Name.Length : 0) + (value.SsisFolder?.Length ?? 0)
            + (value.SsisProject?.Length ?? 0)) + (node.Database is null ? 0 : DatabaseEstimate) + (node.ConnectDenied is null ? 0 : ConnectDeniedEstimate);
    }
    /// <summary>A database row's runtime state on the wire: its four keys and small values.</summary>
    internal const int DatabaseEstimate = 64;
    /// <summary>A login's connectDenied on the wire: its key and true.</summary>
    internal const int ConnectDeniedEstimate = 24;

    internal sealed record Values(string? ObjectSchema, string? ObjectName, CursorKey? Key, bool First, int Take, string? Name, string? Schema, string? Owner, DateTime? D1, DateTime? D2,
        string? SsisFolder, string? SsisProject, string? SsisCatalog = null);

    internal static Values Parameters(ExplorerRequest request, CursorKey? key, bool first, string? objectName = null, string? objectSchema = null)
    {
        var filter = request.Filter;
        string? Text(TextFilterDto? value) => value is null ? null : value.Op == "equals" ? value.Value : CatalogSql.EscapeLike(value.Value);
        // Listings name their owner by its own fields: child folders and the history row resolve their parent object by
        // (schema, name), and SSIS listings their folder and project.
        var owner = request.Object;
        return new(objectSchema ?? owner.Schema, objectName ?? owner.Name, key, first, request.PageSize + 1, Text(filter?.Name), Text(filter?.Schema), Text(filter?.Owner),
            ExplorerRefs.Date(filter?.Created?.Value), ExplorerRefs.Date(filter?.Created?.Value2), owner.SsisFolder, owner.SsisProject);
    }

    private Task<ExplorerChildrenResult> RunAsync(ExplorerRequest request, ExplorerProfile profile, QueryScope scope, string statement, Values values,
        Func<SqlCommand, SqlDataReader, Task<ExplorerChildrenResult>> read, CancellationToken token, List<ExplorerNode> partial) =>
        RunAsync(request.ConnectionId, request.Database, Subject(request), profile, scope, statement, values, read, error => new ExplorerChildrenResult(partial, 0, Error: error), token);

    /// <summary>Takes the connection's gate and then the global one (or only <paramref name="lane"/>, a slot of its own), runs
    /// one batch, and reads it; SQL errors become values (<paramref name="failed"/>).</summary>
    /// <param name="requestDatabase">The database the request reads (absent for server-scope statements).</param>
    /// <param name="subject">The folder or object being read, as the tree labels it, for error messages.</param>
    /// <param name="started">Runs once the slots are taken, before the connection opens (Peek starts its budget there).</param>
    private async Task<T> RunAsync<T>(string connectionId, string? requestDatabase, string subject, ExplorerProfile profile, QueryScope scope, string statement, Values values,
        Func<SqlCommand, SqlDataReader, Task<T>> read, Func<ExplorerError, T> failed, CancellationToken token, SemaphoreSlim? lane = null, Action? started = null)
    {
        var perDatabase = scope == QueryScope.Database && (profile.Cloud || Options.ForcePerDatabaseScope);
        var database = scope == QueryScope.Ssis ? host.SsisCatalog : requestDatabase;
        // Inside EXEC [db].sys.sp_executesql, a missing procedure can only be the wrapper's: the database is gone.
        var phase = scope == QueryScope.Database && !perDatabase ? ErrorPhase.Scope : ErrorPhase.Statement;
        var shared = lane is null;
        var gate = lane ?? gates.GetOrAdd(connectionId, _ => new SemaphoreSlim(Options.PerConnection));
        await gate.WaitAsync(token);
        try
        {
            if (shared) await total.WaitAsync(token);
            try
            {
                started?.Invoke();
                await using var connection = scope == QueryScope.Ssis ? host.SsisConnection(connectionId) : host.Connection(connectionId, perDatabase ? requestDatabase : null);
                try { await host.OpenAsync(connection, token); }
                // 4060 says the login cannot open the catalog's database, whether it is gone, offline, restoring or closed to the
                // login: the Explorer pool tells which.
                catch (SqlException error) when (scope == QueryScope.Ssis && ExplorerErrors.Classify(error.Number, error.Class, ErrorPhase.Statement) is "NO_DB_ACCESS" or "DATABASE_UNAVAILABLE"
                    && !token.IsCancellationRequested)
                {
                    return failed(await SsisOpenFailureAsync(connectionId, subject, database!, token));
                }
                await using var command = connection.CreateCommand();
                command.CommandTimeout = 30;
                var prologue = CatalogSql.Prologue + (Options.TestDelay is { } delay ? "WAITFOR DELAY '" + delay.ToString(@"hh\:mm\:ss", CultureInfo.InvariantCulture) + "';\n" : "");
                if (phase == ErrorPhase.Scope)
                {
                    command.CommandText = prologue + CatalogSql.ModuleCall;
                    Add(command, "@db", SqlDbType.NVarChar, 128, requestDatabase);
                    Add(command, "@stmt", SqlDbType.NVarChar, -1, statement);
                    Add(command, "@decl", SqlDbType.NVarChar, -1, CatalogSql.Declarations);
                }
                else command.CommandText = prologue + statement;
                command.Parameters.AddRange(Bind(values));
                await using var reader = await command.ExecuteReaderAsync(token);
                return await read(command, reader);
            }
            finally { if (shared) total.Release(); }
        }
        catch (SqlException error) when (!token.IsCancellationRequested)
        {
            return failed(ExplorerErrors.From(error, phase, subject, database));
        }
        catch (RequestException error) when (error.Code is "AUTH_KERBEROS" or "AUTH_UNSUPPORTED" or "AUTH_ENTRA")
        {
            return failed(ExplorerErrors.SignIn(error));
        }
        finally { gate.Release(); }
    }

    /// <summary>The SSIS Catalog's database state, read on the Explorer pool after its own failed to open: it was dropped (the
    /// node is gone), it is unavailable to everyone (offline, restoring, single-user in use), or the login may not open it.</summary>
    private async Task<ExplorerError> SsisOpenFailureAsync(string connectionId, string subject, string name, CancellationToken token)
    {
        try
        {
            await using var connection = host.Connection(connectionId, null);
            await host.OpenAsync(connection, token);
            await using var command = connection.CreateCommand();
            command.CommandTimeout = 30;
            command.CommandText = CatalogSql.Prologue + ExplorerQueries.SsisCatalogState;
            command.Parameters.Add(Parameter("@ssis_catalog", SqlDbType.NVarChar, 128, name));
            await using var reader = await command.ExecuteReaderAsync(token);
            if (!await reader.ReadAsync(token)) return ExplorerErrors.Create("NOT_FOUND", "The SSIS Catalog " + name, null);
            return ExplorerLabels.Unavailable(Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture), Convert.ToInt32(reader.GetValue(1), CultureInfo.InvariantCulture)) is { } reason
                ? ExplorerErrors.Create("DATABASE_UNAVAILABLE", name, name, 0, reason)
                : ExplorerErrors.Create("NO_DB_ACCESS", name, name);
        }
        catch (SqlException error) when (!token.IsCancellationRequested) { return ExplorerErrors.From(error, ErrorPhase.Statement, subject, name); }
    }

    /// <summary>The parameters <see cref="CatalogSql.Declarations"/> declares, in its order.</summary>
    internal static SqlParameter[] Bind(Values values) =>
    [
        Parameter("@object_schema", SqlDbType.NVarChar, 128, values.ObjectSchema),
        Parameter("@object_name", SqlDbType.NVarChar, 128, values.ObjectName),
        Parameter("@k1", SqlDbType.NVarChar, 128, values.Key?.K1),
        Parameter("@k2", SqlDbType.NVarChar, 128, values.Key?.K2),
        Parameter("@kn", SqlDbType.Int, 0, values.Key?.Kn),
        Parameter("@take", SqlDbType.Int, 0, values.Take),
        Parameter("@first", SqlDbType.Bit, 0, values.First),
        Parameter("@fname", SqlDbType.NVarChar, 400, values.Name),
        Parameter("@fschema", SqlDbType.NVarChar, 400, values.Schema),
        Parameter("@fowner", SqlDbType.NVarChar, 400, values.Owner),
        Parameter("@d1", SqlDbType.Date, 0, values.D1),
        Parameter("@d2", SqlDbType.Date, 0, values.D2),
        Parameter("@ssis_folder", SqlDbType.NVarChar, 128, values.SsisFolder),
        Parameter("@ssis_project", SqlDbType.NVarChar, 128, values.SsisProject),
        Parameter("@kb", SqlDbType.BigInt, 0, values.Key?.Kb),
        Parameter("@ssis_catalog", SqlDbType.NVarChar, 128, values.SsisCatalog)
    ];

    private static void Add(SqlCommand command, string name, SqlDbType type, int size, object? value) => command.Parameters.Add(Parameter(name, type, size, value));

    private static SqlParameter Parameter(string name, SqlDbType type, int size, object? value)
    {
        // SqlClient cuts longer text to the size without an error, and a cut name resolves another object.
        if (value is string text && size > 0 && text.Length > size) throw new InvalidOperationException("An Object Explorer parameter is longer than its declaration: " + name + ".");
        var parameter = size == 0 ? new SqlParameter(name, type) : new SqlParameter(name, type, size);
        parameter.Value = value ?? DBNull.Value;
        return parameter;
    }

    private static void TryCancel(SqlCommand command)
    {
        try { command.Cancel(); } catch (Exception error) when (error is InvalidOperationException or SqlException) { /* Best effort. */ }
    }
}
