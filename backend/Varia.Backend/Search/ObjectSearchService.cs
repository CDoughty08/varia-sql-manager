using System.Collections.Concurrent;
using System.Data;
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
/// name (and their module definitions), read one database at a time from constant catalog SQL (<see cref="ObjectSearchSql"/>),
/// and searched in memory. Nothing reaches disk; a disconnect drops the connection's index. A database that cannot be read is
/// skipped as a value, and the index keeps every other one.
/// </summary>
internal sealed class ObjectSearchService : IDisposable
{
    private readonly IObjectSearchHost host;
    private readonly ConcurrentDictionary<string, State> states = new(StringComparer.Ordinal);
    private readonly IndexBudget budget;
    private readonly ResourceCatalog resources;
    private readonly SemaphoreSlim total;
    private readonly RequestRegistry running;
    public const int MaxText = 1000;
    public const int MaxLimit = 1000;
    public const int DefaultLimit = 200;
    public const int MaxSkipped = 256;
    /// <summary>The least time between two explorer.index.progress EVENTs of one build.</summary>
    public static readonly TimeSpan ProgressEvery = TimeSpan.FromMilliseconds(250);
    /// <summary>The most kinds one search may name.</summary>
    public const int MaxKinds = 64;
    public static readonly string[] Kinds = ["table", "view", "procedure", "function", "synonym", "sequence", "trigger", "type", "tableType", "databaseTrigger", "login", "serverRole", "credential", "cryptographicProvider", "audit", "serverAuditSpecification", "backupDevice", "linkedServer", "serverTrigger", "database", "user", "databaseRole", "applicationRole", "schema", "assembly", "asymmetricKey", "certificate", "symmetricKey", "columnMasterKey", "columnEncryptionKey", "databaseAuditSpecification", "externalDataSource", "externalFileFormat", "fullTextCatalog", "fullTextStoplist", "partitionScheme", "partitionFunction", "searchPropertyList", "planGuide", "xmlSchemaCollection", "rule", "default", "securityPolicy", "column", "key", "constraint", "index", "statistic", "parameter"];

    /// <summary>The database a skipped resource read is reported as.</summary>
    public const string ResourceDatabase = "mssqlsystemresource";
    /// <summary>The database a skipped (or partly read) server batch is reported as: no database has an empty name.</summary>
    public const string ServerScope = "";

    /// <summary>One connection's index and its build.</summary>
    private sealed class State(IndexBudget budget, ResourceCatalog resources)
    {
        public readonly object Gate = new();
        public ConnectionIndex Index { get; } = new(budget, resources);
        public CancellationTokenSource? Build;
        public bool Building;
        public bool Built;
        public bool Definitions = true;
        public int Databases;
        public int Indexed;
        public List<ObjectIndexSkip> Skipped = [];
        public DateTime? BuiltAt;
    }

    public ObjectSearchService(IObjectSearchHost host, ObjectIndexLimits? limits = null)
    {
        this.host = host;
        Limits = limits ?? new ObjectIndexLimits();
        budget = new IndexBudget(Limits.TotalDefinitionChars);
        resources = new ResourceCatalog(budget);
        total = new SemaphoreSlim(Limits.Total);
        running = new RequestRegistry(64, "object index");
    }

    public ObjectIndexLimits Limits { get; }
    /// <summary>Definition characters held across every connection (the checks read it).</summary>
    public long DefinitionChars => budget.Used;
    /// <summary>The shared resource sets and their distinct definitions (the checks read it).</summary>
    internal ResourceCatalog Resources => resources;

    public async Task<ObjectIndexResult> IndexAsync(ObjectIndexArgs args, CancellationToken token, Action<object>? progress = null)
    {
        var watch = Stopwatch.StartNew();
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(args.RequestId, out _)) throw Invalid("requestId.");
        var profile = host.Profile(args.ConnectionId);
        var explorer = profile.Explorer(ExplorerCatalog.Current);
        var perDatabase = explorer.Cloud;
        var render = new SqlRender(explorer.Band);
        var state = states.GetOrAdd(args.ConnectionId, _ => new State(budget, resources));
        using var source = CancellationTokenSource.CreateLinkedTokenSource(token);
        var entry = running.Register(args.RequestId, args.ConnectionId, source);
        var definitions = args.Definitions ?? true;
        lock (state.Gate)
        {
            // A newer build supersedes a running one, which answers CANCELLED and keeps what it read.
            try { state.Build?.Cancel(); } catch (ObjectDisposedException) { }
            state.Build = source;
            state.Building = true;
            state.Definitions = definitions;
            state.Indexed = 0;
            state.Skipped = [];
        }
        try
        {
            var names = await ListAsync(args.ConnectionId, source.Token);
            lock (state.Gate) state.Databases = names.Count;
            state.Index.Keep(names.ToHashSet(StringComparer.Ordinal));
            if (await ReadServerAsync(args.ConnectionId, state, !explorer.Cloud, definitions, source.Token) is { } serverSkip)
                lock (state.Gate) state.Skipped.Add(serverSkip);
            if (await ReadResourceAsync(args.ConnectionId, profile, state, definitions, source.Token) is { } resourceSkip)
                lock (state.Gate) state.Skipped.Add(resourceSkip);
            var last = Stopwatch.StartNew();
            progress?.Invoke(new { Type = "explorer.index.progress", Done = 0, Total = names.Count, Objects = state.Index.Objects });
            for (var done = 0; done < names.Count; done++)
            {
                var name = names[done];
                var skip = await ReadAsync(args.ConnectionId, state, name, render, definitions, perDatabase, source.Token);
                lock (state.Gate)
                {
                    if (skip is null) state.Indexed++;
                    else if (state.Skipped.Count < MaxSkipped) state.Skipped.Add(skip);
                }
                if (progress is not null && (last.Elapsed >= ProgressEvery || done + 1 == names.Count))
                {
                    progress(new { Type = "explorer.index.progress", Done = done + 1, Total = names.Count, Objects = state.Index.Objects });
                    last.Restart();
                }
            }
            lock (state.Gate)
            {
                if (ReferenceEquals(state.Build, source)) { state.Building = false; state.Built = true; state.BuiltAt = DateTime.UtcNow; }
            }
            return new(Status(state), watch.ElapsedMilliseconds);
        }
        catch (Exception error) when (error is OperationCanceledException || (error is SqlException && source.IsCancellationRequested))
        {
            throw new RequestException("CANCELLED", "The object index build was stopped.");
        }
        catch (SqlException error)
        {
            // The database list itself failed: the index keeps what it had, and the build answers as a value.
            lock (state.Gate) state.Skipped = [new("", "CATALOG_ERROR", ExplorerErrors.From(error, ErrorPhase.Statement, "Databases", null).Message)];
            return new(Status(state), watch.ElapsedMilliseconds);
        }
        finally
        {
            lock (state.Gate)
                if (ReferenceEquals(state.Build, source)) { state.Build = null; state.Building = false; }
            running.Unregister(args.RequestId, entry);
        }
    }

    public ObjectSearchResult Search(ObjectSearchArgs args, CancellationToken token)
    {
        var query = Validate(args);
        token.ThrowIfCancellationRequested();
        host.Profile(args.ConnectionId);
        if (!states.TryGetValue(args.ConnectionId, out var state)) return new([], 0, false, 0, new("none", 0, 0, 0, 0, 0, [], true));
        var status = Status(state);
        var (matcher, problem) = SearchMatcher.Create(query.Text, query.CaseSensitive, query.WholeWord, query.Regex, Limits.MatchTimeout);
        if (matcher is null) return new([], 0, false, 0, status, problem);
        try { return IndexSearch.Run(state.Index, query, matcher, Limits, status); }
        catch (System.Text.RegularExpressions.RegexMatchTimeoutException) { return new([], 0, true, 0, status, "The regular expression took too long on one definition."); }
    }

    /// <summary>Stops a disconnected connection's build and drops its index.</summary>
    public void Forget(string connectionId)
    {
        running.Forget(connectionId);
        if (states.TryRemove(connectionId, out var state)) state.Index.Dispose();
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
        if (args.Database is { } database && !ExplorerRefs.Ident(database)) throw Invalid("database.");
        HashSet<string>? kinds = null;
        if (args.Kinds is { } list)
        {
            if (list.Count is < 1 or > MaxKinds || list.Any(kind => Array.IndexOf(Kinds, kind) < 0)) throw Invalid("kinds.");
            kinds = list.ToHashSet(StringComparer.Ordinal);
        }
        return new(args.Text, args.CaseSensitive ?? false, args.WholeWord ?? false, args.Regex ?? false, scope != "definitions", scope != "names", kinds, args.Database, args.Limit ?? DefaultLimit);
    }

    private static RequestException Invalid(string what) => new("INVALID_PARAMS", "Invalid object search request: " + what);

    private ObjectIndexStatus Status(State state)
    {
        var databases = state.Index.Databases;
        lock (state.Gate)
            return new(state.Building ? "building" : state.Built ? "ready" : databases.Count > 0 ? "ready" : "none", state.Databases, state.Building ? state.Indexed : databases.Count,
                state.Index.Objects, databases.Sum(value => value.Modules) + (state.Index.Resource?.Modules ?? 0) + (state.Index.Server?.Modules ?? 0),
                databases.Sum(value => value.Cut) + (state.Index.Resource?.Cut ?? 0) + (state.Index.Server?.Cut ?? 0), [.. state.Skipped], state.Definitions,
                state.BuiltAt?.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture));
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

    /// <summary>Reads one database and swaps it into the index; the reason it could not, as a value.</summary>
    private async Task<ObjectIndexSkip?> ReadAsync(string connectionId, State state, string database, SqlRender render, bool definitions, bool perDatabase, CancellationToken token)
    {
        using var budgetSource = CancellationTokenSource.CreateLinkedTokenSource(token);
        budgetSource.CancelAfter(Limits.DatabaseBudget);
        await total.WaitAsync(token);
        var reader = new DatabaseReader(database, Limits, budget, Limits.ObjectsPerConnection - OtherObjects(state, database));
        try
        {
            await using var connection = host.Connection(connectionId, perDatabase ? database : null);
            await host.OpenAsync(connection, budgetSource.Token);
            await using var command = connection.CreateCommand();
            command.CommandTimeout = 0;
            var batch = ObjectSearchSql.Batch(render, definitions);
            if (perDatabase) command.CommandText = ObjectSearchSql.Prologue + batch;
            else
            {
                command.CommandText = ObjectSearchSql.Prologue + ObjectSearchSql.ModuleCall;
                command.Parameters.Add(new SqlParameter("@db", SqlDbType.NVarChar, 128) { Value = database });
                command.Parameters.Add(new SqlParameter("@stmt", SqlDbType.NVarChar, -1) { Value = batch });
            }
            await using var rows = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, budgetSource.Token);
            var index = await reader.ReadAsync(rows, definitions, budgetSource.Token);
            if (index is null) return new(database, "TOO_LARGE", "The database has more objects than the index keeps per server (" + Limits.ObjectsPerConnection.ToString("N0", CultureInfo.InvariantCulture) + ").");
            state.Index.Put(index);
            return null;
        }
        catch (Exception error) when (error is OperationCanceledException or SqlException && budgetSource.IsCancellationRequested && !token.IsCancellationRequested)
        {
            reader.Abandon();
            return new(database, "TIMEOUT", "Reading the database's objects took longer than " + Limits.DatabaseBudget.TotalSeconds.ToString(CultureInfo.InvariantCulture) + " seconds.");
        }
        catch (SqlException error) when (!token.IsCancellationRequested)
        {
            reader.Abandon();
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

    /// <summary>Reads the server's own objects (its databases and, on box editions and Managed Instance, its logins, roles and
    /// other server objects) into the index. The reason it could not, as a value; a read that failed part way keeps what it read,
    /// and one that failed at once leaves the objects held before.</summary>
    private async Task<ObjectIndexSkip?> ReadServerAsync(string connectionId, State state, bool box, bool definitions, CancellationToken token)
    {
        using var budgetSource = CancellationTokenSource.CreateLinkedTokenSource(token);
        budgetSource.CancelAfter(Limits.DatabaseBudget);
        await total.WaitAsync(token);
        var reader = new DatabaseReader(ServerScope, Limits, budget, Limits.ObjectsPerConnection - state.Index.Databases.Sum(value => value.Objects.Length));
        var read = false;
        try
        {
            await using var connection = host.Connection(connectionId, null);
            await host.OpenAsync(connection, budgetSource.Token);
            await using var command = connection.CreateCommand();
            command.CommandTimeout = 0;
            command.CommandText = ObjectSearchSql.Prologue + ObjectSearchSql.Server(box, definitions);
            await using var rows = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, budgetSource.Token);
            read = true;
            var index = await reader.ReadServerAsync(rows, box, definitions, Actions.ActionsCatalog.Current.Logins, budgetSource.Token);
            if (index is null) return new(ServerScope, "TOO_LARGE", "The server has more objects than the index keeps per server (" + Limits.ObjectsPerConnection.ToString("N0", CultureInfo.InvariantCulture) + ").");
            state.Index.PutServer(index);
            return null;
        }
        catch (Exception error) when (error is OperationCanceledException or SqlException && budgetSource.IsCancellationRequested && !token.IsCancellationRequested)
        {
            reader.Abandon();
            return new(ServerScope, "TIMEOUT", "Reading the server's objects took longer than " + Limits.DatabaseBudget.TotalSeconds.ToString(CultureInfo.InvariantCulture) + " seconds.");
        }
        catch (SqlException error) when (!token.IsCancellationRequested)
        {
            // A catalog view the login may not read fails its statement: what came before it (the databases) stays searchable.
            if (read) state.Index.PutServer(reader.Partial());
            else reader.Abandon();
            return new(ServerScope, "CATALOG_ERROR", ExplorerErrors.From(error, ErrorPhase.Statement, "Server objects", null).Message);
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
            var set = await resources.AcquireAsync(key, async () =>
            {
                await using var command = connection.CreateCommand();
                command.CommandTimeout = 0;
                command.CommandText = ObjectSearchSql.Prologue + ObjectSearchSql.ResourceObjects(definitions);
                await using var rows = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, budgetSource.Token);
                return await DatabaseReader.ReadResourceAsync(rows, definitions, Limits, budgetSource.Token);
            });
            state.Index.PutResource(set);
            return null;
        }
        catch (Exception error) when (error is OperationCanceledException or SqlException && budgetSource.IsCancellationRequested && !token.IsCancellationRequested)
        {
            return new(ResourceDatabase, "TIMEOUT", "Reading the system objects took longer than " + Limits.DatabaseBudget.TotalSeconds.ToString(CultureInfo.InvariantCulture) + " seconds.");
        }
        catch (SqlException error) when (!token.IsCancellationRequested)
        {
            return new(ResourceDatabase, "CATALOG_ERROR", ExplorerErrors.From(error, ErrorPhase.Statement, "System objects", null).Message);
        }
    }

    private static int OtherObjects(State state, string database) =>
        state.Index.Databases.Where(value => value.Database != database).Sum(value => value.Objects.Length) + (state.Index.Server?.Objects.Length ?? 0);
}

/// <summary>Reads the server batch (<see cref="ObjectSearchSql.Server"/>) or one database's batch (<see cref="ObjectSearchSql.Batch"/>)
/// into a <see cref="DatabaseIndex"/>, charging the definitions it keeps against the shared budget. Children (columns, keys,
/// constraints, triggers, indexes, statistics, parameters) are kept only under a parent Object Explorer lists them below, and share
/// its strings; repeated names (schemas, common column names) are held once per read.</summary>
internal sealed class DatabaseReader(string database, ObjectIndexLimits limits, IndexBudget budget, int room)
{
    private long taken;
    private int modules;
    private int cut;
    private readonly List<IndexedObject?> objects = [];
    private readonly HashSet<string> strings = new(StringComparer.Ordinal);
    private char[] buffer = new char[Math.Min(limits.DefinitionChars, 64 * 1024)];

    /// <summary>A read past the room it was given.</summary>
    private sealed class TooLarge : Exception;

    /// <summary>Gives back what a failed read took.</summary>
    public void Abandon()
    {
        budget.Release(taken);
        taken = 0;
    }

    /// <summary>What the read holds so far, as an index (a server read that failed part way keeps it).</summary>
    public DatabaseIndex Partial()
    {
        var index = new DatabaseIndex(database, [.. objects.OfType<IndexedObject>()], taken, modules, cut);
        taken = 0;
        return index;
    }

    /// <summary>The database's index, or null when it holds more objects than <paramref name="room"/>.</summary>
    public async Task<DatabaseIndex?> ReadAsync(SqlDataReader reader, bool definitions, CancellationToken token)
    {
        try
        {
            var byId = new Dictionary<int, int>();
            var pending = new List<(int At, int Parent)>();
            while (await reader.ReadAsync(token))
            {
                var id = reader.GetInt32(0);
                var schema = Intern(reader.GetString(1));
                var name = reader.GetString(2);
                var type = reader.GetString(3).TrimEnd();
                var modified = reader.GetDateTime(4);
                var parent = reader.GetInt32(5);
                var system = reader.GetBoolean(6);
                var variant = reader.GetByte(7);
                if (ChildOf(type, parent) is { } child)
                {
                    // Its parent may come later in id order, or be a table type (read next): placed once every parent is read.
                    byId[id] = Add(new(child.Kind, child.Folder, null, name, Modified: modified, Subtype: child.Subtype));
                    pending.Add((objects.Count - 1, parent));
                }
                else if (Map(type, schema, name, modified, system, variant) is { } item) byId[id] = Add(item);
            }
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token))
            {
                reader.GetInt32(0);
                var schema = Intern(reader.GetString(1));
                var name = reader.GetString(2);
                var table = reader.GetBoolean(3);
                var assembly = reader.GetBoolean(4);
                var at = Add(table ? new("tableType", "userDefinedTableTypes", schema, name) : new("type", assembly ? "userDefinedTypes" : "userDefinedDataTypes", schema, name, Subtype: assembly ? "clr" : "alias"));
                if (!reader.IsDBNull(5)) byId[reader.GetInt32(5)] = at;
            }
            foreach (var (at, parent) in pending)
            {
                var child = objects[at]!;
                objects[at] = byId.TryGetValue(parent, out var owner) && objects[owner] is { } found ? Child(found, child.Kind, child.Folder, child.Name, child.Subtype, child.Modified) : null;
            }
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token))
            {
                var code = reader.GetString(0);
                var schema = reader.IsDBNull(1) ? null : Intern(reader.GetString(1));
                var name = reader.GetString(2);
                DateTime? modified = reader.IsDBNull(3) ? null : reader.GetDateTime(3);
                var system = reader.GetBoolean(4);
                if (Named(code) is var (kind, folder)) Add(new(kind, folder, schema, name, Modified: modified, System: system));
            }
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token))
            {
                var id = reader.GetInt32(0);
                byId[id] = Add(new("databaseTrigger", "databaseTriggers", null, reader.GetString(1), Modified: reader.GetDateTime(2), System: reader.GetBoolean(3)));
            }
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token))
            {
                var name = reader.GetString(0);
                var modified = reader.GetDateTime(1);
                var (text, longer) = definitions ? Text(reader, 2) : ("", false);
                var guide = new IndexedObject("planGuide", "planGuides", null, name, Modified: modified);
                Add(text.Length > 0 ? guide with { Definition = text, DefinitionCut = longer } : guide);
            }
            await Children(reader, byId, "column", "columns", definitions, token);
            await Children(reader, byId, "index", "indexes", false, token);
            await Children(reader, byId, "statistic", "statistics", false, token);
            await Children(reader, byId, "parameter", "parameters", false, token);
            if (definitions && await reader.NextResultAsync(token))
                while (await reader.ReadAsync(token))
                {
                    if (!byId.TryGetValue(reader.GetInt32(0), out var at) || objects[at] is not { } item) continue;
                    var (text, longer) = Text(reader, 1);
                    if (text.Length > 0) objects[at] = item with { Definition = text, DefinitionCut = longer };
                }
            return Partial();
        }
        catch (TooLarge)
        {
            Abandon();
            return null;
        }
    }

    /// <summary>One child result set (object id, name, then a subtype column or a definition): each row kept under its parent.</summary>
    private async Task Children(SqlDataReader reader, Dictionary<int, int> byId, string kind, string folder, bool definition, CancellationToken token)
    {
        await reader.NextResultAsync(token);
        var last = int.MinValue;
        IndexedObject? parent = null;
        while (await reader.ReadAsync(token))
        {
            var id = reader.GetInt32(0);
            var name = reader.GetString(1);
            if (id != last) { last = id; parent = byId.TryGetValue(id, out var at) ? objects[at] : null; }
            string? subtype = kind switch
            {
                "index" => ExplorerLabels.IndexSubtype(reader.GetByte(2)),
                "parameter" => reader.GetBoolean(2) ? "output" : "input",
                _ => null
            };
            if (parent is null || name.Length == 0) continue;
            var item = Child(parent, kind, folder, Intern(name), subtype);
            if (item is null) continue;
            if (definition && !reader.IsDBNull(2))
            {
                var (text, longer) = Text(reader, 2);
                if (text.Length > 0) item = item with { Definition = text, DefinitionCut = longer };
            }
            Add(item);
        }
    }

    /// <summary>The server's own objects (<see cref="ObjectSearchSql.Server"/>): its databases, then, where it has them, its logins,
    /// server roles, other server objects and server triggers. Null when they are more than <paramref name="room"/>.</summary>
    public async Task<DatabaseIndex?> ReadServerAsync(SqlDataReader reader, bool box, bool definitions, Actions.LoginRules logins, CancellationToken token)
    {
        try
        {
            while (await reader.ReadAsync(token))
            {
                var name = reader.GetString(0);
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
                var name = reader.GetString(1);
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
                var name = reader.GetString(1);
                DateTime? modified = reader.IsDBNull(2) ? null : reader.GetDateTime(2);
                if (ServerNamed(code) is var (kind, folder)) Add(new(kind, folder, null, name, Modified: modified));
            }
            await reader.NextResultAsync(token);
            var byId = new Dictionary<int, int>();
            while (await reader.ReadAsync(token))
            {
                var id = reader.GetInt32(0);
                byId[id] = Add(new("serverTrigger", "serverTriggers", null, reader.GetString(1), Modified: reader.GetDateTime(2), System: reader.GetBoolean(3)));
            }
            if (definitions && await reader.NextResultAsync(token))
                while (await reader.ReadAsync(token))
                {
                    if (!byId.TryGetValue(reader.GetInt32(0), out var at) || objects[at] is not { } item) continue;
                    var (text, longer) = Text(reader, 1);
                    if (text.Length > 0) objects[at] = item with { Definition = text, DefinitionCut = longer };
                }
            return Partial();
        }
        catch (TooLarge)
        {
            Abandon();
            return null;
        }
    }

    /// <summary>The resource database's objects (<see cref="ObjectSearchSql.ResourceObjects"/>), each a system one, with their
    /// columns and parameters and the definitions cut at the per-module limit; the shared catalog charges them to the budget.</summary>
    public static async Task<IndexedObject[]> ReadResourceAsync(SqlDataReader reader, bool definitions, ObjectIndexLimits limits, CancellationToken token)
    {
        var objects = new List<IndexedObject>();
        var byId = new Dictionary<int, int>();
        var strings = new HashSet<string>(StringComparer.Ordinal);
        string Intern(string value) => strings.TryGetValue(value, out var held) ? held : strings.Add(value) ? value : value;
        while (await reader.ReadAsync(token))
        {
            // Sequential access reads the columns in order.
            var id = reader.GetInt32(0);
            var schema = Intern(reader.GetString(1));
            var name = reader.GetString(2);
            var type = reader.GetString(3).TrimEnd();
            var item = Map(type, schema, name, reader.GetDateTime(4), system: true);
            if (item is null) continue;
            byId[id] = objects.Count;
            objects.Add(item);
        }
        foreach (var (kind, folder) in new[] { ("column", "columns"), ("parameter", "parameters") })
        {
            await reader.NextResultAsync(token);
            while (await reader.ReadAsync(token))
            {
                var id = reader.GetInt32(0);
                var name = reader.GetString(1);
                var subtype = kind == "parameter" ? reader.GetBoolean(2) ? "output" : "input" : null;
                if (name.Length > 0 && byId.TryGetValue(id, out var at) && Child(objects[at], kind, folder, Intern(name), subtype) is { } child) objects.Add(child);
            }
        }
        if (definitions && await reader.NextResultAsync(token))
        {
            var buffer = new char[Math.Min(limits.DefinitionChars, 64 * 1024)];
            while (await reader.ReadAsync(token))
            {
                if (!byId.TryGetValue(reader.GetInt32(0), out var at)) continue;
                var (text, longer) = ReadText(reader, 1, ref buffer, limits.DefinitionChars);
                if (text.Length > 0) objects[at] = objects[at] with { Definition = text, DefinitionCut = longer };
            }
        }
        return [.. objects];
    }

    private int Add(IndexedObject item)
    {
        if (objects.Count >= room) throw new TooLarge();
        objects.Add(item);
        return objects.Count - 1;
    }

    private string Intern(string value)
    {
        if (strings.TryGetValue(value, out var held)) return held;
        strings.Add(value);
        return value;
    }

    /// <summary>A text column read only as far as the per-module limit and charged to the budget: empty when the budget is spent
    /// (counted as cut), and whether it goes on past the limit.</summary>
    private (string Text, bool Longer) Text(SqlDataReader reader, int ordinal)
    {
        if (reader.IsDBNull(ordinal)) return ("", false);
        var (text, longer) = ReadText(reader, ordinal, ref buffer, limits.DefinitionChars);
        if (text.Length == 0) return ("", false);
        if (!budget.TryTake(text.Length)) { cut++; return ("", false); }
        taken += text.Length;
        modules++;
        if (longer) cut++;
        return (text, longer);
    }

    private static (string Text, bool Longer) ReadText(SqlDataReader reader, int ordinal, ref char[] buffer, int limit)
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
    /// variant: 1 FileTable, 2 external, 3 graph node, 4 graph edge, 5 dropped ledger, 6 a temporal or ledger history table (listed
    /// below its table, which the index does not name, so under Tables).</summary>
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

    /// <summary>A child under <paramref name="parent"/>, sharing its strings and system flag, or null where Object Explorer lists no
    /// such folder below it (a key on a view, a column of a procedure).</summary>
    internal static IndexedObject? Child(IndexedObject parent, string kind, string folder, string name, string? subtype = null, DateTime? modified = null) =>
        parent.Schema is not null && Lists(kind, parent)
            ? new(kind, folder, null, name, parent.Kind, parent.Schema, parent.Name, modified, System: parent.System, Subtype: subtype, ParentFolder: parent.Folder)
            : null;

    private static bool Lists(string kind, IndexedObject parent) => kind switch
    {
        "column" => parent.Kind is "table" or "view" or "tableType" or "function",
        "key" or "constraint" => parent.Kind is "tableType" || parent.Kind is "table" && parent.Subtype is not ("external" or "history" or "droppedLedger"),
        "trigger" => parent.Kind is "view" || parent.Kind is "table" && parent.Subtype is not ("external" or "history" or "droppedLedger"),
        "index" => parent.Kind is "view" or "tableType" || parent.Kind is "table" && parent.Subtype is not "external",
        "statistic" => parent.Kind is "table" or "view",
        "parameter" => parent.Kind is "procedure" or "function",
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
