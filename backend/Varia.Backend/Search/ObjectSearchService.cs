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
    private readonly SemaphoreSlim total;
    private readonly RequestRegistry running;
    public const int MaxText = 1000;
    public const int MaxLimit = 1000;
    public const int DefaultLimit = 200;
    public const int MaxSkipped = 256;
    /// <summary>The least time between two explorer.index.progress EVENTs of one build.</summary>
    public static readonly TimeSpan ProgressEvery = TimeSpan.FromMilliseconds(250);
    public static readonly string[] Kinds = ["table", "view", "procedure", "function", "synonym", "sequence", "trigger", "type", "tableType", "databaseTrigger"];

    /// <summary>One connection's index and its build.</summary>
    private sealed class State(IndexBudget budget)
    {
        public readonly object Gate = new();
        public ConnectionIndex Index { get; } = new(budget);
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
        total = new SemaphoreSlim(Limits.Total);
        running = new RequestRegistry(64, "object index");
    }

    public ObjectIndexLimits Limits { get; }
    /// <summary>Definition characters held across every connection (the checks read it).</summary>
    public long DefinitionChars => budget.Used;

    public async Task<ObjectIndexResult> IndexAsync(ObjectIndexArgs args, CancellationToken token, Action<object>? progress = null)
    {
        var watch = Stopwatch.StartNew();
        if (!Guid.TryParse(args.ConnectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(args.RequestId, out _)) throw Invalid("requestId.");
        var profile = host.Profile(args.ConnectionId);
        var perDatabase = profile.Explorer(ExplorerCatalog.Current).Cloud;
        var state = states.GetOrAdd(args.ConnectionId, _ => new State(budget));
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
            var last = Stopwatch.StartNew();
            progress?.Invoke(new { Type = "explorer.index.progress", Done = 0, Total = names.Count, Objects = state.Index.Objects });
            for (var done = 0; done < names.Count; done++)
            {
                var name = names[done];
                var skip = await ReadAsync(args.ConnectionId, state, name, definitions, perDatabase, source.Token);
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
            if (list.Count is < 1 or > 16 || list.Any(kind => Array.IndexOf(Kinds, kind) < 0)) throw Invalid("kinds.");
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
                databases.Sum(value => value.Objects.Length), databases.Sum(value => value.Modules), databases.Sum(value => value.Cut), [.. state.Skipped], state.Definitions,
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
    private async Task<ObjectIndexSkip?> ReadAsync(string connectionId, State state, string database, bool definitions, bool perDatabase, CancellationToken token)
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
            var batch = ObjectSearchSql.Batch(definitions);
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

    private static int OtherObjects(State state, string database) => state.Index.Databases.Where(value => value.Database != database).Sum(value => value.Objects.Length);
}

/// <summary>Reads one database's batch (<see cref="ObjectSearchSql.Batch"/>) into a <see cref="DatabaseIndex"/>, charging the
/// definitions it keeps against the shared budget.</summary>
internal sealed class DatabaseReader(string database, ObjectIndexLimits limits, IndexBudget budget, int room)
{
    private long taken;

    /// <summary>Gives back what a failed read took.</summary>
    public void Abandon()
    {
        budget.Release(taken);
        taken = 0;
    }

    /// <summary>The database's index, or null when it holds more objects than <paramref name="room"/>.</summary>
    public async Task<DatabaseIndex?> ReadAsync(SqlDataReader reader, bool definitions, CancellationToken token)
    {
        var objects = new List<IndexedObject>();
        var byId = new Dictionary<int, int>();
        while (await reader.ReadAsync(token))
        {
            if (objects.Count >= room) { Abandon(); return null; }
            var id = reader.GetInt32(0);
            var schema = reader.GetString(1);
            var name = reader.GetString(2);
            var type = reader.GetString(3).TrimEnd();
            var modified = reader.GetDateTime(4);
            var parent = reader.IsDBNull(5) ? null : reader.GetString(5);
            var parentSchema = reader.IsDBNull(6) ? null : reader.GetString(6);
            var parentType = reader.IsDBNull(7) ? null : reader.GetString(7).TrimEnd();
            var item = Map(type, schema, name, modified, parent, parentSchema, parentType);
            if (item is null) continue;
            byId[id] = objects.Count;
            objects.Add(item);
        }
        await reader.NextResultAsync(token);
        while (await reader.ReadAsync(token))
        {
            if (objects.Count >= room) { Abandon(); return null; }
            reader.GetInt32(0);
            var schema = reader.GetString(1);
            var name = reader.GetString(2);
            var table = reader.GetBoolean(3);
            var assembly = reader.GetBoolean(4);
            objects.Add(table ? new("tableType", "userDefinedTableTypes", schema, name) : new("type", assembly ? "userDefinedTypes" : "userDefinedDataTypes", schema, name));
        }
        await reader.NextResultAsync(token);
        while (await reader.ReadAsync(token))
        {
            if (objects.Count >= room) { Abandon(); return null; }
            var id = reader.GetInt32(0);
            var name = reader.GetString(1);
            var modified = reader.GetDateTime(2);
            byId[id] = objects.Count;
            objects.Add(new("databaseTrigger", "databaseTriggers", null, name, Modified: modified));
        }
        var modules = 0;
        var cut = 0;
        if (definitions && await reader.NextResultAsync(token))
        {
            var buffer = new char[Math.Min(limits.DefinitionChars, 64 * 1024)];
            while (await reader.ReadAsync(token))
            {
                var id = reader.GetInt32(0);
                if (!byId.TryGetValue(id, out var at)) continue;
                var (text, longer) = ReadText(reader, 1, ref buffer);
                if (text.Length == 0) continue;
                if (!budget.TryTake(text.Length)) { cut++; continue; }
                taken += text.Length;
                modules++;
                if (longer) cut++;
                objects[at] = objects[at] with { Definition = text, DefinitionCut = longer };
            }
        }
        var index = new DatabaseIndex(database, [.. objects], taken, modules, cut);
        taken = 0;
        return index;
    }

    /// <summary>A text column read only as far as the per-module limit, and whether it goes on past it.</summary>
    private (string Text, bool Longer) ReadText(SqlDataReader reader, int ordinal, ref char[] buffer)
    {
        var builder = new System.Text.StringBuilder();
        long offset = 0;
        while (builder.Length < limits.DefinitionChars)
        {
            var want = Math.Min(buffer.Length, limits.DefinitionChars - builder.Length);
            var read = (int)reader.GetChars(ordinal, offset, buffer, 0, want);
            if (read <= 0) return (builder.ToString(), false);
            builder.Append(buffer, 0, read);
            offset += read;
        }
        var more = reader.GetChars(ordinal, offset, buffer, 0, 1) > 0;
        return (builder.ToString(), more);
    }

    /// <summary>The Object Explorer identity of a sys.objects row, or null for a trigger whose parent it cannot list.</summary>
    internal static IndexedObject? Map(string type, string schema, string name, DateTime modified, string? parent, string? parentSchema, string? parentType) => type switch
    {
        "U" => new("table", "tables", schema, name, Modified: modified),
        "ET" => new("table", "externalTables", schema, name, Modified: modified),
        "V" => new("view", "views", schema, name, Modified: modified),
        "P" or "PC" or "X" => new("procedure", "storedProcedures", schema, name, Modified: modified),
        "FN" or "FS" => new("function", "scalarValuedFunctions", schema, name, Modified: modified),
        "IF" or "TF" or "FT" => new("function", "tableValuedFunctions", schema, name, Modified: modified),
        "AF" => new("function", "aggregateFunctions", schema, name, Modified: modified),
        "SN" => new("synonym", "synonyms", schema, name, Modified: modified),
        "SO" => new("sequence", "sequences", schema, name, Modified: modified),
        "TR" when parent is not null && parentSchema is not null && parentType is "U" or "ET" or "V" =>
            new("trigger", "tableTriggers", null, name, parentType == "V" ? "view" : "table", parentSchema, parent, modified),
        _ => null
    };
}
