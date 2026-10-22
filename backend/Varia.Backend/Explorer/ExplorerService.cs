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
    /// <summary>Opens one of those connections; a Kerberos token failure throws AUTH_KERBEROS (or AUTH_UNSUPPORTED), and a
    /// Microsoft Entra token failure AUTH_ENTRA, which the node shows.</summary>
    Task OpenAsync(SqlConnection connection, CancellationToken token);
}

/// <summary>Limits and test seams (live checks set the internal ones through InternalsVisibleTo).</summary>
internal sealed class ExplorerOptions
{
    public int PerConnection { get; init; } = 4;
    public int Total { get; init; } = 8;
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
}

/// <summary>explorer.children: static folders straight from the catalogue (no SQL, no slot), dynamic rows from constant
/// catalog SQL under per-connection and global gates, paged by keyset. Catalog failures are values; a cancelled
/// request (CANCEL frame, deadline, disconnect) throws.</summary>
internal sealed class ExplorerService : IDisposable
{
    private readonly IExplorerHost host;
    private readonly ExplorerCatalog catalog;
    private readonly RequestRegistry running;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> gates = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim total;

    public ExplorerService(IExplorerHost host, ExplorerOptions? options = null, ExplorerCatalog? catalog = null)
    {
        this.host = host;
        Options = options ?? new ExplorerOptions();
        this.catalog = catalog ?? ExplorerCatalog.Current;
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
        if (request.Cursor is not null) key = ExplorerCursor.Parse(request.Cursor, request.Folder!.List!, ExplorerQueries.All[request.Folder.List!].Keyset);
        var server = host.Profile(request.ConnectionId);
        var real = server.Explorer(catalog);
        var profile = Options.ForceBand is { } band ? real with { Band = band } : real;
        ExplorerRefs.CheckServed(request, catalog, profile);
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

    /// <summary>Cancels a disconnected connection's requests and drops its gate.</summary>
    public void Forget(string connectionId)
    {
        running.Forget(connectionId);
        gates.TryRemove(connectionId, out _);
    }

    public void Dispose()
    {
        running.ForgetAll();
        gates.Clear();
    }

    private async Task<ExplorerChildrenResult> LoadAsync(ExplorerRequest request, ExplorerProfile profile, bool vector, CursorKey? key, CancellationToken token)
    {
        var target = request.Object;
        var nodes = new List<ExplorerNode>();
        if (request.Folder is not { } folder)
        {
            var folders = catalog.StaticFolders(target.Kind, request.Subtype, profile);
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
            nodes.AddRange(folders.Select(id => FolderNode(target, id)));
            return new(nodes, 0, Total: nodes.Count);
        }
        // Static subfolders lead the first page only; filters never apply to them.
        if (key is null) nodes.AddRange(catalog.Subfolders(folder.Id, profile).Select(id => FolderNode(target, id)));
        if (folder.List is null) return new(nodes, 0, Total: nodes.Count);
        var query = ExplorerQueries.All[folder.List];
        var render = new SqlRender(profile.Band, vector, FilterShape.From(request.Filter), query.ChildFolder ? target.Kind : null);
        var first = key is null;
        var statics = nodes.Count;
        return await RunAsync(request, profile, query.Scope, query.Render(render), Parameters(request, key, first), async (command, reader) =>
        {
            if (query.ChildFolder && !await ParentExistsAsync(reader, token)) return new(nodes, 0, Error: NotFound(target));
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
            + (value.Name?.Length ?? 0) + (value.Parent is { } parent ? parent.Schema.Length + parent.Name.Length : 0));
    }

    private sealed record Values(string? ObjectSchema, string? ObjectName, CursorKey? Key, bool First, int Take, string? Name, string? Schema, string? Owner, DateTime? D1, DateTime? D2);

    private static Values Parameters(ExplorerRequest request, CursorKey? key, bool first, string? objectName = null, string? objectSchema = null)
    {
        var filter = request.Filter;
        string? Text(TextFilterDto? value) => value is null ? null : value.Op == "equals" ? value.Value : CatalogSql.EscapeLike(value.Value);
        // Child folders and the history row resolve their parent object by (schema, name).
        var owner = request.Object;
        return new(objectSchema ?? (request.Folder is not null ? owner.Schema : null), objectName ?? (request.Folder is not null ? owner.Name : null), key, first,
            request.PageSize + 1, Text(filter?.Name), Text(filter?.Schema), Text(filter?.Owner), ExplorerRefs.Date(filter?.Created?.Value), ExplorerRefs.Date(filter?.Created?.Value2));
    }

    /// <summary>Takes the connection's gate and then the global one, runs one batch, and reads it; SQL errors become values.</summary>
    private async Task<ExplorerChildrenResult> RunAsync(ExplorerRequest request, ExplorerProfile profile, QueryScope scope, string statement, Values values,
        Func<SqlCommand, SqlDataReader, Task<ExplorerChildrenResult>> read, CancellationToken token, List<ExplorerNode> partial)
    {
        var perDatabase = scope == QueryScope.Database && (profile.Cloud || Options.ForcePerDatabaseScope);
        // Inside EXEC [db].sys.sp_executesql, a missing procedure can only be the wrapper's: the database is gone.
        var phase = scope == QueryScope.Database && !perDatabase ? ErrorPhase.Scope : ErrorPhase.Statement;
        var gate = gates.GetOrAdd(request.ConnectionId, _ => new SemaphoreSlim(Options.PerConnection));
        await gate.WaitAsync(token);
        try
        {
            await total.WaitAsync(token);
            try
            {
                await using var connection = host.Connection(request.ConnectionId, perDatabase ? request.Database : null);
                await host.OpenAsync(connection, token);
                await using var command = connection.CreateCommand();
                command.CommandTimeout = 30;
                var prologue = CatalogSql.Prologue + (Options.TestDelay is { } delay ? "WAITFOR DELAY '" + delay.ToString(@"hh\:mm\:ss", CultureInfo.InvariantCulture) + "';\n" : "");
                if (phase == ErrorPhase.Scope)
                {
                    command.CommandText = prologue + CatalogSql.ModuleCall;
                    Add(command, "@db", SqlDbType.NVarChar, 128, request.Database);
                    Add(command, "@stmt", SqlDbType.NVarChar, -1, statement);
                    Add(command, "@decl", SqlDbType.NVarChar, -1, CatalogSql.Declarations);
                }
                else command.CommandText = prologue + statement;
                Add(command, "@object_schema", SqlDbType.NVarChar, 128, values.ObjectSchema);
                Add(command, "@object_name", SqlDbType.NVarChar, 128, values.ObjectName);
                Add(command, "@k1", SqlDbType.NVarChar, 128, values.Key?.K1);
                Add(command, "@k2", SqlDbType.NVarChar, 128, values.Key?.K2);
                Add(command, "@kn", SqlDbType.Int, 0, values.Key?.Kn);
                Add(command, "@take", SqlDbType.Int, 0, values.Take);
                Add(command, "@first", SqlDbType.Bit, 0, values.First);
                Add(command, "@fname", SqlDbType.NVarChar, 400, values.Name);
                Add(command, "@fschema", SqlDbType.NVarChar, 400, values.Schema);
                Add(command, "@fowner", SqlDbType.NVarChar, 400, values.Owner);
                Add(command, "@d1", SqlDbType.Date, 0, values.D1);
                Add(command, "@d2", SqlDbType.Date, 0, values.D2);
                await using var reader = await command.ExecuteReaderAsync(token);
                return await read(command, reader);
            }
            finally { total.Release(); }
        }
        catch (SqlException error) when (!token.IsCancellationRequested)
        {
            return new(partial, 0, Error: ExplorerErrors.From(error, phase, Subject(request), request.Database));
        }
        catch (RequestException error) when (error.Code is "AUTH_KERBEROS" or "AUTH_UNSUPPORTED" or "AUTH_ENTRA")
        {
            return new(partial, 0, Error: ExplorerErrors.SignIn(error));
        }
        finally { gate.Release(); }
    }

    private static void Add(SqlCommand command, string name, SqlDbType type, int size, object? value)
    {
        var parameter = size == 0 ? new SqlParameter(name, type) : new SqlParameter(name, type, size);
        parameter.Value = value ?? DBNull.Value;
        command.Parameters.Add(parameter);
    }

    private static void TryCancel(SqlCommand command)
    {
        try { command.Cancel(); } catch (Exception error) when (error is InvalidOperationException or SqlException) { /* Best effort. */ }
    }
}
