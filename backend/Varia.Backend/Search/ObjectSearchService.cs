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
/// name (and their module definitions), read one database at a time from constant catalog SQL (<see cref="ObjectSearchSql"/>),
/// and searched in memory. Nothing reaches disk; a disconnect drops the connection's index. A database that cannot be read is
/// skipped as a value, and the index keeps every other one.
/// </summary>
internal sealed class ObjectSearchService : IDisposable
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
    /// <summary>The most kinds one search may name.</summary>
    public const int MaxKinds = 64;
    public static readonly string[] Kinds = ["table", "view", "procedure", "function", "synonym", "sequence", "trigger", "type", "tableType", "databaseTrigger", "login", "serverRole", "credential", "cryptographicProvider", "audit", "serverAuditSpecification", "backupDevice", "linkedServer", "serverTrigger", "database", "user", "databaseRole", "applicationRole", "schema", "assembly", "asymmetricKey", "certificate", "symmetricKey", "columnMasterKey", "columnEncryptionKey", "databaseAuditSpecification", "externalDataSource", "externalFileFormat", "fullTextCatalog", "fullTextStoplist", "partitionScheme", "partitionFunction", "searchPropertyList", "planGuide", "xmlSchemaCollection", "rule", "default", "securityPolicy", "column", "key", "constraint", "index", "statistic", "parameter"];

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
    /// <summary>The names and definitions every connection shares (the checks read it).</summary>
    internal StringPool Pool => pool;

    public async Task<ObjectIndexResult> IndexAsync(ObjectIndexArgs args, CancellationToken token, Action<object>? progress = null)
    {
        var watch = Stopwatch.StartNew();
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(args.RequestId, out _)) throw Invalid("requestId.");
        var profile = host.Profile(args.ConnectionId);
        var explorer = profile.Explorer(ExplorerCatalog.Current);
        var perDatabase = explorer.Cloud;
        var render = new SqlRender(explorer.Band);
        var state = states.GetOrAdd(args.ConnectionId, _ => new State(pool, resources));
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
                    if (skip is null or { Code: ChildrenLeftOut }) state.Indexed++;
                    if (skip is not null && state.Skipped.Count < MaxSkipped) state.Skipped.Add(skip);
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
        try { return IndexSearch.Run(state.Index, query, matcher, Limits, status, token); }
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
        if (args.Match is not (null or "exact" or "fuzzy") || (args.Match == "fuzzy" && args.Regex == true)) throw Invalid("match.");
        if (args.Database is { } database && !ExplorerRefs.Ident(database)) throw Invalid("database.");
        HashSet<string>? kinds = null;
        if (args.Kinds is { } list)
        {
            if (list.Count is < 1 or > MaxKinds || list.Any(kind => Array.IndexOf(Kinds, kind) < 0)) throw Invalid("kinds.");
            kinds = list.ToHashSet(StringComparer.Ordinal);
        }
        return new(args.Text, args.CaseSensitive ?? false, args.WholeWord ?? false, args.Regex ?? false, scope != "definitions", scope != "names", kinds, args.Database, args.Limit ?? DefaultLimit, args.Match == "fuzzy");
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
        budgetSource.CancelAfter(Limits.DatabaseBudget);
        await total.WaitAsync(token);
        var reader = new DatabaseReader(database, Limits, pool, state.Index.Databases.FirstOrDefault(value => value.Database == database));
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
            await using var rows = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, budgetSource.Token);
            var index = await reader.ReadAsync(rows, definitions, budgetSource.Token, children);
            if (index is null) return new(database, "TOO_LARGE", "The database does not fit in the index's memory (" + Size + " across every connection).");
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
            // A statement that fails part way (a catalog view this edition lacks) keeps what came before it, unless an earlier build
            // read the database whole.
            KeepPartial(reader, state.Index.Databases.Any(value => value.Database == database), state.Index.Put);
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

    /// <summary>After a read failed part way: holds what it read when nothing was held before, else keeps the earlier read whole.</summary>
    internal static void KeepPartial(DatabaseReader reader, bool held, Action<DatabaseIndex> put)
    {
        if (!held && reader.Any) put(reader.Partial());
        else reader.Abandon();
    }

    /// <summary>Reads the server's own objects (its databases and, on box editions and Managed Instance, its logins, roles and
    /// other server objects) into the index. The reason it could not, as a value; a read that failed part way keeps what it read
    /// only when no earlier build's objects are held.</summary>
    private async Task<ObjectIndexSkip?> ReadServerAsync(string connectionId, State state, bool box, bool definitions, CancellationToken token)
    {
        using var budgetSource = CancellationTokenSource.CreateLinkedTokenSource(token);
        budgetSource.CancelAfter(Limits.DatabaseBudget);
        await total.WaitAsync(token);
        var reader = new DatabaseReader(ServerScope, Limits, pool, state.Index.Server);
        try
        {
            await using var connection = host.Connection(connectionId, null);
            await host.OpenAsync(connection, budgetSource.Token);
            await using var command = connection.CreateCommand();
            command.CommandTimeout = 0;
            command.CommandText = ObjectSearchSql.Prologue + ObjectSearchSql.Server(box, definitions);
            await using var rows = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, budgetSource.Token);
            var index = await reader.ReadServerAsync(rows, box, definitions, Actions.ActionsCatalog.Current.Logins, budgetSource.Token);
            if (index is null) return new(ServerScope, "TOO_LARGE", "The server's objects do not fit in the index's memory (" + Size + " across every connection).");
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
    private readonly List<IndexedObject?> objects = [];
    /// <summary>The pool's copy of each distinct text the read holds a reference to.</summary>
    private readonly Dictionary<string, string> held = new(StringComparer.Ordinal);
    /// <summary>Rows waiting for the object that lists them: children for their parent, history tables for their table.</summary>
    private readonly List<(int At, int Owner, bool History)> pending = [];
    private char[] buffer = new char[Math.Min(limits.DefinitionChars, 64 * 1024)];

    /// <summary>A read past the budget.</summary>
    private sealed class TooLarge : Exception;

    /// <summary>Gives back what a failed read took; the share it would have replaced stays with its owner.</summary>
    public void Abandon()
    {
        pool.Release(held.Values);
        held.Clear();
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
        foreach (var (at, _, _) in pending) objects[at] = null;
        pending.Clear();
        var index = new DatabaseIndex(database, [.. objects.OfType<IndexedObject>()], taken + credited, modules, cut, credited, credited > 0 ? credit : null, [.. held.Values]);
        held.Clear();
        taken = 0;
        credited = 0;
        creditLeft = 0;
        return index;
    }

    /// <summary>The database's index, or null when it does not fit in the budget. Without
    /// <paramref name="children"/> the batch has no column, index, statistics or parameter result sets.</summary>
    public async Task<DatabaseIndex?> ReadAsync(DbDataReader reader, bool definitions, CancellationToken token, bool children = true)
    {
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
                    pending.Add((objects.Count - 1, parent, false));
                }
                else if (Map(type, schema, name, modified, system, variant) is { } item)
                {
                    byId[id] = Add(item);
                    if (variant is 6 or 7) pending.Add((objects.Count - 1, current, true));
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
                var (text, longer) = definitions ? Text(reader, 2) : ("", false);
                var guide = new IndexedObject("planGuide", "planGuides", null, name, Modified: modified);
                Add(text.Length > 0 ? guide with { Definition = text, DefinitionCut = longer } : guide);
            }
            if (children)
            {
                await Children(reader, byId, "column", "columns", definitions, token);
                await Children(reader, byId, "index", "indexes", false, token);
                await Children(reader, byId, "statistic", "statistics", false, token);
                await Children(reader, byId, "parameter", "parameters", false, token);
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

    /// <summary>Gives each waiting row the object that lists it, once every table and table type is read: a history table its
    /// table (whose history row Object Explorer shows it as), then a child its parent. A row whose owner the login cannot see, or
    /// whose owner lists no such folder, is left out.</summary>
    private void Place(Dictionary<int, int> byId)
    {
        IndexedObject? Owner(int id) => id != 0 && byId.TryGetValue(id, out var at) ? objects[at] : null;
        foreach (var (at, owner, history) in pending)
            if (history) objects[at] = Owner(owner) is { Kind: "table" } table ? objects[at]! with { Via = table } : null;
        foreach (var (at, owner, history) in pending)
        {
            if (history) continue;
            var child = objects[at]!;
            objects[at] = Owner(owner) is { } found ? Child(found, child.Kind, child.Folder, child.Name, child.Subtype, child.Modified) : null;
        }
        pending.Clear();
    }

    /// <summary>One child result set (object id, name, then a subtype column or a definition): each row kept under its parent.</summary>
    private async Task Children(DbDataReader reader, Dictionary<int, int> byId, string kind, string folder, bool definition, CancellationToken token)
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
    public static async Task<IndexedObject[]> ReadResourceAsync(DbDataReader reader, bool definitions, ObjectIndexLimits limits, CancellationToken token)
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

    /// <summary>Keeps <paramref name="item"/> (whose texts are the pool's), charging its record.</summary>
    private int Add(IndexedObject item)
    {
        if (!TryCharge(IndexMemory.RecordBytes, 0)) throw new TooLarge();
        objects.Add(item);
        return objects.Count - 1;
    }

    /// <summary>The pool's copy of a name; a read past the budget stops.</summary>
    private string Intern(string value) => Pooled(value, 0) ?? throw new TooLarge();

    /// <summary>The pool's copy of <paramref name="value"/>, taking the read's one reference to it and charging its slot when the
    /// read does not hold it yet; null when either would leave less than <paramref name="keepFree"/> free.</summary>
    private string? Pooled(string value, long keepFree)
    {
        if (held.TryGetValue(value, out var copy)) return copy;
        copy = pool.TryAcquire(value, keepFree);
        if (copy is null) return null;
        if (!TryCharge(IndexMemory.SlotBytes, keepFree)) { pool.Release([copy]); return null; }
        held[value] = copy;
        return copy;
    }

    /// <summary>A text column read only as far as the per-module limit and charged to the budget: empty when the budget is spent
    /// (counted as cut), and whether it goes on past the limit.</summary>
    private (string Text, bool Longer) Text(DbDataReader reader, int ordinal)
    {
        if (reader.IsDBNull(ordinal)) return ("", false);
        var (text, longer) = ReadText(reader, ordinal, ref buffer, limits.DefinitionChars);
        if (text.Length == 0) return ("", false);
        if (Pooled(text, limits.NamesReserveBytes) is not { } copy) { cut++; return ("", false); }
        modules++;
        if (longer) cut++;
        return (copy, longer);
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
        parent.Schema is not null && parent.Folder != "functions" && Lists(kind, parent)
            ? new(kind, folder, null, name, parent.Kind, parent.Schema, parent.Name, modified, System: parent.System, Subtype: subtype, ParentFolder: parent.Folder, Via: parent.Via)
            : null;

    private static bool Lists(string kind, IndexedObject parent) => kind switch
    {
        "column" => parent.Kind is "table" or "view" or "tableType" or "function",
        "key" or "constraint" => parent.Kind is "tableType" || parent.Kind is "table" && parent.Subtype is not ("external" or "history" or "ledgerHistory" or "droppedLedger"),
        "trigger" => parent.Kind is "view" || parent.Kind is "table" && parent.Subtype is not ("external" or "history" or "ledgerHistory" or "droppedLedger"),
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
