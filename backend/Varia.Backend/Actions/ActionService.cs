using System.Collections.Concurrent;
using System.Data;
using System.Diagnostics;
using Microsoft.Data.SqlClient;
using Varia.Backend.Common;
using Varia.Backend.Designer;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>What the service needs from SqlService: a connection's profile, its own unpooled connection, and a way to
/// close the backend's idle pooled connections in a database before DDL that needs it to itself.</summary>
internal interface IActionHost
{
    /// <summary>Throws NOT_CONNECTED for an unknown connection.</summary>
    ServerProfile Profile(string connectionId);
    /// <summary>An unopened, unpooled connection under the program name plus " - Object Actions", never retried, in master
    /// on box servers.</summary>
    SqlConnection Connection(string connectionId);
    /// <summary>Opens it; a Kerberos token failure throws AUTH_KERBEROS (or AUTH_UNSUPPORTED), answered as a value.</summary>
    Task OpenAsync(SqlConnection connection, CancellationToken token);
    /// <summary>Clears every pool of the connection whose initial catalog is the database, so none of the backend's idle
    /// connections blocks DROP DATABASE or MODIFY NAME. True when it cleared a pool: the server can still list the closed
    /// connections' sessions for a few milliseconds.</summary>
    bool ClearPoolsFor(string connectionId, string database);
    /// <summary>A database was renamed (to <paramref name="newName"/>) or dropped (null): a connection whose initial catalog
    /// it was moves to the new name, or to master, so its later connections can still open.</summary>
    void DatabaseChanged(string connectionId, string database, string? newName);
    /// <summary>Before a statement that needs the database to itself (critic A5), for every connection of the backend to the same
    /// server: when its own database (named, or the login's default) is that one, its server-scope pools (Object Explorer, scripting,
    /// SSIS, live, databases.list) open in master from now on, unless the login is a contained database user; then its idle pools
    /// in the database are cleared, as ClearPoolsFor does. True when it cleared a pool.</summary>
    bool FreeDatabase(string connectionId, string database);
    /// <summary>The session ids the pooled connections of every connection to the server were given (the plain pool's included):
    /// those still in a database just after FreeDatabase are Varia's own, which a cleared pool ends within moments. Query tabs
    /// are unpooled and never among them.</summary>
    IReadOnlySet<int> PoolSessions(string connectionId);
    /// <summary>The session ids of the backend's open query sessions on connections to the same server. SQL Server gives a freed id
    /// to the next client, and PoolSessions keeps a cleared pool's ids for minutes, so a query tab can hold one of them: it is the
    /// user's session, never Varia's pool's. Hosts that open no query sessions (the offline checks') have none.</summary>
    IReadOnlySet<int> QuerySessions(string connectionId) => new HashSet<int>();
}

/// <summary>Limits and test seams (live checks set the internal ones through InternalsVisibleTo).</summary>
internal sealed class ActionServiceOptions
{
    public int ReadPerConnection { get; init; } = 2;
    public int ReadTotal { get; init; } = 4;
    public int ExecutePerConnection { get; init; } = 1;
    public int ExecuteTotal { get; init; } = 2;
    public int MaxRegistered { get; init; } = 128;
    public TimeSpan DescribeBudget { get; set; } = TimeSpan.FromSeconds(40);
    public TimeSpan ScriptBudget { get; set; } = TimeSpan.FromSeconds(25);
    public TimeSpan GateWait { get; set; } = TimeSpan.FromSeconds(30);
    /// <summary>How long Stop on DDL waits for SQL Server to end the statement before the request answers CANCELLED; the
    /// action's cleanup budget (its compensation and cleanup steps) is added to it.</summary>
    public TimeSpan StopGrace { get; set; } = TimeSpan.FromSeconds(10);
    /// <summary>How long freeing a database waits for the sessions of the pools it cleared to end (critic A5).</summary>
    public TimeSpan FreeWait { get; set; } = TimeSpan.FromSeconds(1);
    /// <summary>Test seam: awaited before each main step with its title and the job's token.</summary>
    internal Func<string, CancellationToken, Task>? BeforeStep { get; set; }
    /// <summary>Test seam: awaited before each compensation or cleanup step that runs, with its title and the cleanup budget's token.</summary>
    internal Func<string, CancellationToken, Task>? BeforeCleanup { get; set; }
}

/// <summary>The object's identity and facts the preflight read: its subtype, row, and what refers to it; a login's facts too.</summary>
internal sealed record ActionSubject(ObjectRefDto Target, string Display, string Title, string Subtype, ScriptPreflight.Row Row, List<ActionWarningDto> Warnings, bool Truncated,
    LoginFactsDto? Login = null);

/// <summary>actions.describe, actions.script and actions.execute (spec PR17 §6): validate, register, take the action
/// gates, open the action's own unpooled connection, run the preflight in it, then the DDL. Failures are values; a
/// request cancelled by a disconnect throws CANCELLED. The reply never waits on blocked I/O: the request awaits the job
/// with its token, and the job alone owns the connection and its gate until it ends. Stop on DDL is the exception, bounded
/// by StopGrace: its reply waits for SQL Server to end the statement, so it says which steps completed.</summary>
internal sealed partial class ActionService : IDisposable
{
    private readonly IActionHost host;
    private readonly ActionsCatalog catalog;
    private readonly DesignerCatalog designer;
    private readonly ExplorerCatalog explorer;
    private readonly RequestRegistry running;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> readGates = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> executeGates = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim readTotal;
    private readonly SemaphoreSlim executeTotal;
    private int activeJobs;

    public const string CloudMessage = "Object actions on Azure SQL Database are not supported yet.";
    public const string ManagedInstanceMessage = "This object action is not available on Azure SQL Managed Instance.";

    /// <summary>Why an action does not run on a server of this engine (its catalogue `engines`, critic A1).</summary>
    public static string EngineMessage(string engine) => engine switch
    {
        "cloud" => CloudMessage,
        "managedInstance" => ManagedInstanceMessage,
        _ => "This object action is not available on this server."
    };

    /// <summary>Whether an action (a catalogue action, or the designer's createTable) runs on a server of this engine.</summary>
    private bool Serves(string action, string engine) => designer.Requests.Contains(action) ? designer.Engines.Contains(engine) : catalog.Serves(action, engine);

    /// <summary>How long a Stop's reply waits for the job: SQL Server ending the statement, then the action's own cleanup.</summary>
    private TimeSpan StopWait(string action) => Options.StopGrace + CleanupBudget(action);
    private TimeSpan CleanupBudget(string action) => catalog.Actions.Contains(action) ? catalog.CleanupBudget(action) : TimeSpan.FromMilliseconds(catalog.Limit("cleanupMs"));

    public ActionService(IActionHost host, ActionServiceOptions? options = null, ActionsCatalog? catalog = null, ExplorerCatalog? explorer = null)
    {
        this.host = host;
        Options = options ?? new ActionServiceOptions();
        this.catalog = catalog ?? ActionsCatalog.Current;
        designer = DesignerCatalog.Current;
        this.explorer = explorer ?? ExplorerCatalog.Current;
        readTotal = new SemaphoreSlim(Options.ReadTotal);
        executeTotal = new SemaphoreSlim(Options.ExecuteTotal);
        running = new RequestRegistry(Options.MaxRegistered, "object action");
    }

    public ActionServiceOptions Options { get; }
    public ActionsCatalog Catalog => catalog;
    /// <summary>Requests registered and not yet answered.</summary>
    public int RunningCount => running.Count;
    /// <summary>Jobs still holding their connection: an answered (cancelled) request's job counts until its statement ends.</summary>
    public int ActiveJobs => Volatile.Read(ref activeJobs);

    private static RequestException Invalid(string detail) => new("INVALID_PARAMS", "Invalid object action request: " + detail);

    // --- Validation -------------------------------------------------------------------------------------------------------

    private static readonly HashSet<string> SystemSchemas = new(["sys", "INFORMATION_SCHEMA"], StringComparer.Ordinal);
    private static readonly HashSet<string> SystemDatabases = new(["master", "model", "msdb", "tempdb"], StringComparer.Ordinal);

    private ObjectRefDto Target(ObjectRefDto? target, string action)
    {
        if (target is null) throw Invalid("target.");
        try { ExplorerRefs.Object(target, explorer); }
        catch (RequestException) { throw Invalid("target."); }
        if (!catalog.Offered(target.Kind, action)) throw Invalid("this object does not offer " + action + ".");
        if (catalog.ServesSystemObjects(action)) return target;
        if (target.Kind == "database" ? SystemDatabases.Contains(target.Name!) : target.Schema is { } schema && SystemSchemas.Contains(schema)) throw Invalid("system objects cannot be changed.");
        return target;
    }

    private static void Ids(string? connectionId, string? requestId)
    {
        if (!Guid.TryParse(connectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(requestId, out _)) throw Invalid("requestId.");
    }

    /// <summary>Re-validates what main's zod schema (src/shared/actions/schema.ts) accepts for actions.describe: a known
    /// dialog and a target its action serves, or the table designer and a database, SQL Server's own included.</summary>
    public ObjectRefDto Validate(ActionDescribeArgs args)
    {
        Ids(args.ConnectionId, args.RequestId);
        if (args.Dialog is not null && designer.Describes.Contains(args.Dialog)) return DatabaseTarget(args.Target);
        if (args.Dialog is null || !catalog.Dialogs.ContainsKey(args.Dialog)) throw Invalid("dialog.");
        return Target(args.Target, catalog.ActionOf(args.Dialog));
    }

    /// <summary>The actions whose actions.execute may carry passwords (New Login and Login Properties, later PRs); none is in the switch yet.</summary>
    private static readonly HashSet<string> SecretActions = new(["createLogin", "loginProperties"], StringComparer.Ordinal);

    /// <summary>A password of at most loginLimits.password UTF-16 units, without U+0000 or an unpaired surrogate, here for every
    /// action that takes one, so none can forget it. The message names the member, never the value.</summary>
    private void Secret(string? value, string member)
    {
        if (value is not null && (value.Length > catalog.Logins.Limit("password") || value.Contains('\0') || ScriptingErrors.UnpairedSurrogate(value) >= 0)) throw Invalid("secrets." + member + ".");
    }

    /// <summary>Re-validates actionRequestSchema (actionScriptRequestSchema for a script): the action, ids, a target whose kind
    /// offers it, a new name of 1–128 UTF-16 units without U+0000 that differs from the old one, the delete flags only for
    /// databases, Database Properties' changes (DatabaseAlter.Validate), and secrets nowhere but an execute of an action that
    /// takes them (critic A3).</summary>
    public ObjectRefDto Validate(ActionArgs args, bool script = false)
    {
        Ids(args.ConnectionId, args.RequestId);
        if (args.Secrets is not null && (script || !SecretActions.Contains(args.Action))) throw Invalid("this request takes no secrets.");
        if (args.Secrets is { } secrets) { Secret(secrets.Password, "password"); Secret(secrets.OldPassword, "oldPassword"); }
        switch (args.Action)
        {
            case "rename":
                if (args.CloseConnections is not null || args.DeleteHistory is not null || args.Changes is not null || args.Design is not null || args.Identity is not null) throw Invalid("rename takes no delete options or changes.");
                if (!ExplorerRefs.Ident(args.NewName)) throw Invalid("newName.");
                var renamed = Target(args.Target, "rename");
                if (string.Equals(args.NewName, renamed.Name, StringComparison.Ordinal)) throw Invalid("the new name is the current name.");
                return renamed;
            case "delete":
                if (args.NewName is not null || args.Changes is not null || args.Design is not null || args.Identity is not null) throw Invalid("delete takes no new name or changes.");
                if (args.CloseConnections is not { } close || args.DeleteHistory is not { } history) throw Invalid("closeConnections and deleteHistory are required.");
                var deleted = Target(args.Target, "delete");
                if (deleted.Kind != "database" && (close || history)) throw Invalid("only a database has connections to close and backup history to delete.");
                return deleted;
            case "properties":
                if (args.Design is not null) throw Invalid("properties takes no design.");
                var target = Target(args.Target, "properties");
                DatabaseAlter.Validate(catalog, args);
                return target;
            case "createTable":
                if (args.NewName is not null || args.CloseConnections is not null || args.DeleteHistory is not null || args.Changes is not null || args.Identity is not null) throw Invalid("createTable takes only a design.");
                var database = DatabaseTarget(args.Target);
                TableDesignValidator.Validate(designer, args.Design);
                return database;
            default:
                throw Invalid("action.");
        }
    }

    /// <summary>The longest script an action may return.</summary>
    private long ScriptLimit(string action) => action switch
    {
        "createTable" => designer.Limit("scriptChars"),
        _ => catalog.Limit("scriptChars")
    };

    // --- Requests ---------------------------------------------------------------------------------------------------------

    public Task<ActionDescribeResult> DescribeAsync(ActionDescribeArgs args, CancellationToken token)
    {
        var target = Validate(args);
        var watch = Stopwatch.StartNew();
        var action = designer.Describes.Contains(args.Dialog) ? designer.Requests.Single() : catalog.ActionOf(args.Dialog);
        return RunAsync(args.ConnectionId, args.RequestId, action, read: true, Options.DescribeBudget, token,
            async (connection, profile, band, job) => await (args.Dialog switch
            {
                "tableDesigner" => DescribeDesignerJobAsync(connection, target, band, job),
                "databaseProperties" => DescribePropertiesJobAsync(connection, target, band, job),
                _ => DescribeJobAsync(connection, args.ConnectionId, profile.Explorer(explorer).ServerEngine, target, band, job)
            }) with { ElapsedMs = watch.ElapsedMilliseconds },
            error => new ActionDescribeResult(null, watch.ElapsedMilliseconds, error));
    }

    public Task<ActionScriptResult> ScriptAsync(ActionArgs args, CancellationToken token)
    {
        var target = Validate(args, script: true);
        // A new table's script runs in its database; a database's or a server object's action in master.
        var database = args.Action == "createTable" ? target.Name! : ScriptDatabase(target);
        return RunAsync(args.ConnectionId, args.RequestId, args.Action, read: true, Options.ScriptBudget, token,
            (connection, profile, band, job) => args.Action switch
            {
                "createTable" => ScriptDesignerJobAsync(connection, args, target, band, job),
                "properties" => ScriptPropertiesJobAsync(connection, args, target, band, job),
                _ => ScriptJobAsync(connection, args, target, band, job)
            },
            error => new ActionScriptResult(null, database, [], error));
    }

    public Task<ActionExecuteResult> ExecuteAsync(ActionArgs args, CancellationToken token)
    {
        var target = Validate(args);
        var watch = Stopwatch.StartNew();
        // Managed Instance refuses SINGLE_USER: Delete Object greys the option there (CloseConnectionsNote), and a request that
        // asks for it anyway is refused before any connection opens.
        if (args.Action == "delete" && args.CloseConnections == true && host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine == "managedInstance")
            return Task.FromResult(new ActionExecuteResult([], [], 0, Error("NOT_SUPPORTED", ManagedInstanceCloseNote)));
        return RunAsync(args.ConnectionId, args.RequestId, args.Action, read: false, null, token,
            async (connection, profile, band, job) => await (args.Action switch
            {
                "createTable" => ExecuteDesignerJobAsync(connection, args, target, band, job),
                "properties" => ExecutePropertiesJobAsync(connection, args, target, band, job),
                _ => ExecuteJobAsync(connection, args, target, band, job)
            }) with { ElapsedMs = watch.ElapsedMilliseconds },
            error => new ActionExecuteResult([], [], watch.ElapsedMilliseconds, error));
    }

    /// <summary>Registers the request, then runs the job on the pool under the read or execute gates with its own
    /// connection. Past its budget, a describe or script answers TIMEOUT; DDL has none (Stop ends it). A disconnect answers
    /// CANCELLED. Failures before any DDL, such as an engine the action does not run on or a Kerberos sign-in, are values.
    /// Stop on DDL (the request's own token) has already sent SQL Server an attention through the job's token; the reply then
    /// waits up to StopGrace plus the action's cleanup budget for the job, whose steps say what completed and what Varia
    /// undid, and past it answers CANCELLED, an unknown outcome.</summary>
    private async Task<T> RunAsync<T>(string connectionId, string requestId, string action, bool read, TimeSpan? budget, CancellationToken token,
        Func<SqlConnection, ServerProfile, int, CancellationToken, Task<T>> work, Func<ActionError, T> failed)
    {
        var profile = host.Profile(connectionId);
        var served = profile.Explorer(explorer);
        // Each action declares the engines it runs on: Azure SQL Database reaches one database per connection and refuses USE,
        // and Managed Instance cannot set SINGLE_USER, attach, detach or restore from a disk.
        if (!Serves(action, served.ServerEngine)) return failed(ActionErrors.Create(catalog, "NOT_SUPPORTED", EngineMessage(served.ServerEngine)));
        using var source = CancellationTokenSource.CreateLinkedTokenSource(token);
        var entry = running.Register(requestId, connectionId, source);
        try
        {
            token.ThrowIfCancellationRequested();
            if (budget is { } limit) source.CancelAfter(limit);
            var jobSource = CancellationTokenSource.CreateLinkedTokenSource(source.Token);
            var job = Task.Run(() => JobAsync(connectionId, read, profile, served.Band, work, failed, jobSource), CancellationToken.None);
            _ = job.ContinueWith(done => _ = done.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
            try { return await job.WaitAsync(source.Token); }
            catch (OperationCanceledException) when (source.IsCancellationRequested && !token.IsCancellationRequested)
            {
                if (entry.Forgotten) throw new RequestException("CANCELLED", "The operation was cancelled.");
                return failed(ActionErrors.Create(catalog, "TIMEOUT", "Reading the object took longer than " + (int)budget!.Value.TotalSeconds + " seconds. Try again."));
            }
            catch (OperationCanceledException) when (!read && token.IsCancellationRequested && !entry.Forgotten)
            {
                try { return await job.WaitAsync(StopWait(action), CancellationToken.None); }
                catch (TimeoutException) { throw new OperationCanceledException(token); }
                // Only the preflight, the gates or the sign-in can throw on cancellation: no DDL had started.
                catch (Exception error) when (error is OperationCanceledException or SqlException) { return failed(Error("CANCELLED", "The action was stopped before it changed anything.")); }
            }
        }
        finally { running.Unregister(requestId, entry); }
    }

    private async Task<T> JobAsync<T>(string connectionId, bool read, ServerProfile profile, int band, Func<SqlConnection, ServerProfile, int, CancellationToken, Task<T>> work,
        Func<ActionError, T> failed, CancellationTokenSource jobSource)
    {
        Interlocked.Increment(ref activeJobs);
        try
        {
            var token = jobSource.Token;
            var gate = (read ? readGates : executeGates).GetOrAdd(connectionId, _ => new SemaphoreSlim(read ? Options.ReadPerConnection : Options.ExecutePerConnection));
            var total = read ? readTotal : executeTotal;
            if (!await gate.WaitAsync(Options.GateWait, token)) throw Busy();
            try
            {
                if (!await total.WaitAsync(Options.GateWait, token)) throw Busy();
                try
                {
                    await using var connection = host.Connection(connectionId);
                    try { await host.OpenAsync(connection, token); }
                    catch (RequestException error) when (error.Code is "AUTH_KERBEROS" or "AUTH_UNSUPPORTED" or "AUTH_ENTRA") { return failed(ActionErrors.Create(catalog, error.Code, error.Message)); }
                    // Nothing ran yet, so the outcome is known: the action did not start.
                    catch (SqlException error) when (!token.IsCancellationRequested) { return failed(ActionErrors.Create(catalog, "CONNECTION_LOST", "Could not connect to the server: " + error.Message)); }
                    try
                    {
                        await RunAsync(connection, read ? ActionSql.ReadPrologue : ActionSql.ExecutePrologue, token);
                        return await work(connection, profile, band, token);
                    }
                    catch (SqlException error) when (!token.IsCancellationRequested) { return failed(ActionErrors.FromSql(catalog, error, connection, ddl: !read, inUseAdvice: null)); }
                }
                finally { total.Release(); }
            }
            finally { gate.Release(); }
        }
        finally
        {
            Interlocked.Decrement(ref activeJobs);
            jobSource.Dispose();
        }
    }

    private static RequestException Busy() => new("BUSY", "Other object actions are running on this server. Retry after they finish.");

    // --- Preflight --------------------------------------------------------------------------------------------------------

    private static async Task RunAsync(SqlConnection connection, string sql, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.CommandTimeout = 0;
        await command.ExecuteNonQueryAsync(token);
    }

    private static void Add(SqlCommand command, string name, SqlDbType type, int size, object? value)
    {
        var parameter = size == 0 ? new SqlParameter(name, type) : new SqlParameter(name, type, size);
        parameter.Value = value ?? DBNull.Value;
        command.Parameters.Add(parameter);
    }

    private static ScriptPreflight.Row ReadRow(SqlDataReader reader)
    {
        var values = new Dictionary<string, object?>(reader.FieldCount, StringComparer.Ordinal);
        for (var i = 0; i < reader.FieldCount; i++) values[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
        return new ScriptPreflight.Row(values);
    }

    private string Display(ObjectRefDto target) => ScriptingErrors.Display(target.Schema is { } schema ? schema + "." + target.Name : target.Name!);
    /// <summary>Where an action's script runs: master for a database and for a server object (a login), else the object's database.</summary>
    private string ScriptDatabase(ObjectRefDto target) => target.Kind == "database" || explorer.Kind(target.Kind)?.Scope == "serverObject" ? "master" : target.Database!;
    private string Title(ObjectRefDto target) => explorer.Kind(target.Kind)?.Title ?? target.Kind;
    private ActionError Error(string code, string message) => ActionErrors.Create(catalog, code, message);

    /// <summary>Finds the object again in this connection and derives its subtype. <paramref name="take"/> bounds the
    /// dependents read per kind (0 reads none). Returns an error value when it is gone, unavailable or SQL Server's own.</summary>
    private async Task<(ActionSubject? Subject, ActionError? Error)> ResolveAsync(SqlConnection connection, ObjectRefDto target, string? newName, int band, int take, CancellationToken token)
    {
        var display = Display(target);
        var title = Title(target);
        var warnings = new List<ActionWarningDto>();
        var truncated = false;
        ScriptPreflight.Row? row = null;
        if (target.Kind == "login")
        {
            var (facts, loginRow) = await LoginAsync(connection, target.Name!, newName, take == 0 ? 0 : (int)catalog.Logins.Limit("ownedDatabases"), token);
            if (facts is null) return (null, Error("NOT_FOUND", "The login " + display + " no longer exists. Refresh Object Explorer."));
            return (new ActionSubject(target, display, title, facts.Subtype, loginRow!, warnings, false, facts), null);
        }
        if (target.Kind == "database")
        {
            await using var command = connection.CreateCommand();
            command.CommandText = ActionSql.Database;
            command.CommandTimeout = 0;
            Add(command, "@name", SqlDbType.NVarChar, 128, target.Name);
            Add(command, "@new", SqlDbType.NVarChar, 128, newName);
            await using var reader = await command.ExecuteReaderAsync(token);
            if (await reader.ReadAsync(token)) row = ReadRow(reader);
            if (row is null) return (null, Error("NOT_FOUND", "The database " + display + " no longer exists. Refresh Object Explorer."));
            if (row.Bool("replicated")) warnings.Add(new("The database is used for replication; the DROP fails until replication is removed.", true));
            if (row.Bool("in_availability_group")) warnings.Add(new("The database is in an availability group; the DROP fails until it is removed from the group.", true));
            if (row.Bool("mirrored")) warnings.Add(new("The database is mirrored; the DROP fails until mirroring is removed.", true));
            if (row.Bool("has_snapshots")) warnings.Add(new(SnapshotsWarning, true));
            // SQL Server leaves an offline database's files where they are when it drops the database (D3 §8).
            if (row.Int("state") == OfflineState) warnings.Add(new(OfflineWarning, false));
        }
        else
        {
            await using (var state = connection.CreateCommand())
            {
                state.CommandText = ActionSql.DatabaseState;
                state.CommandTimeout = 0;
                Add(state, "@db", SqlDbType.NVarChar, 128, target.Database);
                await using var reader = await state.ExecuteReaderAsync(token);
                if (!await reader.ReadAsync(token)) return (null, Error("NOT_FOUND", "The database " + ScriptingErrors.Display(target.Database!) + " no longer exists. Refresh Object Explorer."));
                var facts = ReadRow(reader);
                if (facts.Int("state") != 0 || !facts.Bool("has_access"))
                    return (null, Error("DATABASE_UNAVAILABLE", "The database " + ScriptingErrors.Display(target.Database!) + " is " + (facts.Int("state") != 0 ? (facts.Text("state_desc") ?? "unavailable").ToLowerInvariant() : "not accessible to this login") + "."));
            }
            await using var command = connection.CreateCommand();
            command.CommandText = ActionSql.ModuleCall;
            command.CommandTimeout = 0;
            Add(command, "@db", SqlDbType.NVarChar, 128, target.Database);
            Add(command, "@stmt", SqlDbType.NVarChar, -1, ActionSql.Object(target.Kind, band));
            Add(command, "@decl", SqlDbType.NVarChar, -1, ActionSql.Declarations);
            Add(command, "@schema", SqlDbType.NVarChar, 128, target.Schema);
            Add(command, "@name", SqlDbType.NVarChar, 128, target.Name);
            Add(command, "@new", SqlDbType.NVarChar, 128, newName);
            Add(command, "@take", SqlDbType.Int, 0, take);
            try
            {
                await using var reader = await command.ExecuteReaderAsync(token);
                if (await reader.ReadAsync(token)) row = ReadRow(reader);
                var limit = (int)catalog.Limit("dependents");
                if (await reader.NextResultAsync(token))
                {
                    var count = 0;
                    while (await reader.ReadAsync(token))
                        if (++count <= limit)
                            warnings.Add(new("Referenced by foreign key " + ScriptingErrors.Display(reader.GetString(2)) + " on " + ScriptingErrors.Display(reader.GetString(0) + "." + reader.GetString(1))
                                + "; the DROP fails until it is dropped.", true));
                    truncated |= count > limit;
                }
                if (await reader.NextResultAsync(token))
                {
                    var count = 0;
                    while (await reader.ReadAsync(token))
                        if (++count <= limit)
                        {
                            var noun = reader.GetString(2).Trim() switch { "V" => "view", "FN" or "IF" or "TF" => "function", _ => "object" };
                            warnings.Add(new("Referenced by schema-bound " + noun + " " + ScriptingErrors.Display(reader.GetString(0) + "." + reader.GetString(1)) + "; the DROP fails until it is changed.", true));
                        }
                    truncated |= count > limit;
                }
            }
            // Inside EXEC [db].sys.sp_executesql, a missing procedure can only be the wrapper's: the database went away.
            catch (SqlException error) when (error.Number is 2812 or 911 && !token.IsCancellationRequested)
            {
                return (null, Error("NOT_FOUND", "The database " + ScriptingErrors.Display(target.Database!) + " no longer exists. Refresh Object Explorer."));
            }
            if (row is null) return (null, Error("NOT_FOUND", display + " no longer exists. Refresh Object Explorer."));
        }
        var subtype = ScriptPreflight.Subtype(target.Kind, row);
        return (new ActionSubject(target, display, title, subtype, row, warnings, truncated), null);
    }

    /// <summary>The login preflight (ActionSql.Login) in master: the login's facts, at most <paramref name="take"/> names of the
    /// databases it owns, and its row; null facts when no login of a listed type has the name.</summary>
    private async Task<(LoginFactsDto? Facts, ScriptPreflight.Row? Row)> LoginAsync(SqlConnection connection, string name, string? newName, int take, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = ActionSql.Login;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, name);
        Add(command, "@new", SqlDbType.NVarChar, 128, newName);
        Add(command, "@take", SqlDbType.Int, 0, take);
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token)) return (null, null);
        var row = ReadRow(reader);
        var owned = new List<string>();
        if (await reader.NextResultAsync(token))
            while (await reader.ReadAsync(token)) owned.Add(reader.GetString(0));
        var type = row.Text("principal_type")?.Trim() ?? "";
        var principalId = row.Int("principal_id");
        var subtype = catalog.Logins.SubtypeOf(principalId, type, name);
        if (subtype is null) return (null, null);
        int? sessions = row.Long("sessions") is { } count ? (int)count : null;
        var created = DatabaseProperties.Iso(row.Raw("create_date")) ?? "";
        var facts = new LoginFactsDto(principalId, type, subtype, row.Bool("is_disabled"), row.Text("sid_hex") ?? "", created, row.NullableBool("policy_checked"), row.NullableBool("expiration_checked"),
            row.Bool("connect_denied"), row.Bool("is_own"), row.Bool("is_sysadmin"), sessions, row.Int("owned_databases"), owned, row.Int("owned_server_objects"), row.Bool("can_alter"),
            row.Bool("can_control_server"), row.Bool("name_in_use"));
        return (facts, row);
    }

    /// <summary>The live checks' only way to read a login's facts as the login actions will (D4b-d), in the action's own connection.</summary>
    internal async Task<LoginFactsDto?> LoginFactsAsync(string connectionId, string name, CancellationToken token)
    {
        await using var connection = host.Connection(connectionId);
        await host.OpenAsync(connection, token);
        await RunAsync(connection, ActionSql.ReadPrologue, token);
        return (await LoginAsync(connection, name, null, (int)catalog.Logins.Limit("ownedDatabases"), token)).Facts;
    }

    /// <summary>The preflight's verdict for running <paramref name="action"/> now: SQL Server's own objects, subtypes the
    /// catalogue greys, advisory permissions, and a name already taken. A login answers by the protected-principal rules
    /// (src/shared/actions/logins.ts).</summary>
    private ActionError? Refusal(ActionSubject subject, ActionArgs args)
    {
        if (subject.Login is { } login)
        {
            if (catalog.Logins.Refusal(login, args.Action) is { } refused)
                return Error(refused is "alterAnyLogin" or "controlServer" ? "PERMISSION_DENIED" : "NOT_SUPPORTED", catalog.Logins.Message(refused));
            if (args.Action == "rename" && login.NameInUse) return Error("NAME_IN_USE", "The name " + ScriptingErrors.Display(args.NewName!) + " is already used by another login or server role.");
            return null;
        }
        var row = subject.Row;
        var system = subject.Target.Kind == "database" ? row.Bool("is_system") : row.Bool("is_ms_shipped");
        if (system) return Error("NOT_SUPPORTED", subject.Display + " belongs to SQL Server and cannot be " + (args.Action == "rename" ? "renamed." : "deleted."));
        if (!catalog.Allows(subject.Target.Kind, subject.Subtype, args.Action))
            return Error("NOT_SUPPORTED", (args.Action == "rename" ? "Rename" : "Delete") + " for this kind of " + subject.Title.ToLowerInvariant() + " is not supported yet.");
        if (args.Action == "rename")
        {
            if (!row.Bool("can_alter")) return Error("PERMISSION_DENIED", "You do not have permission to rename " + subject.Display + " (ALTER on it).");
            if (row.Bool("name_in_use")) return Error("NAME_IN_USE", "The name " + ScriptingErrors.Display(args.NewName!) + " is already in use" + (subject.Target.Kind == "database" ? " by another database." : " in this schema."));
            return null;
        }
        if (!row.Bool("can_drop")) return Error("PERMISSION_DENIED", "You do not have permission to delete " + subject.Display + ".");
        if (subject.Target.Kind == "database" && row.Bool("is_snapshot") && (args.CloseConnections == true || args.DeleteHistory == true))
            return Error("NOT_SUPPORTED", "Close existing connections and deleting backup history do not apply to a database snapshot.");
        return null;
    }

    /// <summary>sys.databases state of an offline database.</summary>
    internal const int OfflineState = 6;
    internal const string OfflineWarning = "This database is offline. Deleting it removes it from the server but leaves its files on disk.";
    internal const string SnapshotsWarning = "The database has database snapshots; the DROP fails until they are deleted.";
    /// <summary>Why Delete Object greys Close existing connections on Azure SQL Managed Instance.</summary>
    internal const string ManagedInstanceCloseNote = "Managed Instance cannot set SINGLE_USER.";

    /// <summary>What a database's Delete plan needs from its row: whether it is offline, where no session can be (so no SINGLE_USER
    /// runs), and its user access (sys.databases user_access: 0 multi, 1 single, 2 restricted), which a failed DROP restores.</summary>
    internal sealed record DeleteFacts(bool Offline, int UserAccess);

    private static DeleteFacts? FactsOf(ActionSubject subject) =>
        subject.Target.Kind == "database" ? new(subject.Row.Int("state") == OfflineState, subject.Row.Int("user_access")) : null;

    /// <summary>The statements an action runs, in order. A database's Delete that closes connections first undoes SINGLE_USER when
    /// its DROP did not complete (D3 §8): the compensation restores the access <paramref name="facts"/> read (multi or restricted).
    /// An offline database has no sessions to close, so its Delete runs no SINGLE_USER.</summary>
    public static List<PlannedStatement> Plan(ActionArgs args, ObjectRefDto target, DeleteFacts? facts = null)
    {
        if (args.Action == "rename")
            return target.Kind == "database"
                ? [new(ActionTemplate.RenameDatabase, "master", [target.Name!, args.NewName!])]
                : [new(ActionTemplate.RenameObject, target.Database!, [target.Schema!, target.Name!, args.NewName!])];
        if (target.Kind != "database") return [new(ActionSql.DropOf(target.Kind), target.Database!, [target.Schema!, target.Name!])];
        // SSMS deletes the backup history first; deleting it after the DROP keeps it when the DROP fails (IN_USE).
        var plan = new List<PlannedStatement>();
        var close = args.CloseConnections == true && facts?.Offline != true;
        if (close) plan.Add(new(ActionTemplate.SetSingleUser, "master", [target.Name!]));
        plan.Add(new(ActionTemplate.DropDatabase, "master", [target.Name!]));
        if (args.DeleteHistory == true) plan.Add(new(ActionTemplate.DeleteBackupHistory, "msdb", [target.Name!]));
        // Due only when the DROP (main step 1) did not complete; a failed history delete after it leaves no database to restore.
        var restore = facts?.UserAccess switch { 0 => ActionTemplate.SetMultiUser, 2 => ActionTemplate.SetRestrictedUser, _ => (ActionTemplate?)null };
        if (close && restore is { } undo)
            plan.Add(new(undo, "master", [target.Name!], StepKind.Compensation, Undoes: 0, When: statuses => statuses.Count < 2 || statuses[1] != "done"));
        return plan;
    }

    /// <summary>A step's title in the reply (at most 64 characters).</summary>
    internal static string StepTitle(ActionTemplate template) => template switch
    {
        ActionTemplate.DeleteBackupHistory => "Delete backup and restore history",
        ActionTemplate.SetSingleUser => "Close existing connections",
        ActionTemplate.DropDatabase => "Drop the database",
        ActionTemplate.RenameDatabase or ActionTemplate.RenameObject => "Rename",
        ActionTemplate.SetMultiUser => "Restore multi-user access",
        ActionTemplate.SetRestrictedUser => "Restore restricted user access",
        ActionTemplate.DetachDatabase => "Detach the database",
        ActionTemplate.DisableLogin => "Disable the login",
        ActionTemplate.EnableLogin => "Enable the login",
        ActionTemplate.DenyConnect => "Deny permission to connect",
        ActionTemplate.GrantConnect => "Grant permission to connect",
        ActionTemplate.DropUser => "Drop the database user",
        _ => "Drop the object"
    };

    /// <summary>The templates whose statement needs its database (the first name) free of Varia's own idle sessions (critic A5).</summary>
    private static bool NeedsFreeDatabase(ActionTemplate template) => template is ActionTemplate.SetSingleUser or ActionTemplate.DropDatabase or ActionTemplate.RenameDatabase
        or ActionTemplate.DetachDatabase;

    /// <summary>Runs planned statements through runner v2 on the action's connection. Before the first main statement that needs
    /// a database to itself, the connection's own pools leave it (FreeDatabaseAsync), inside that step, so Stop reaches it.</summary>
    private async Task<RunOutcome> RunPlannedAsync(SqlConnection connection, string connectionId, string action, IReadOnlyList<PlannedStatement> plan, string? inUseAdvice, CancellationToken token)
    {
        var freed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var steps = plan.Select(ActionSql.Checked).Select(statement => new RunStep(StepTitle(statement.Template), async context =>
        {
            if (statement.Kind == StepKind.Main && NeedsFreeDatabase(statement.Template) && freed.Add(statement.Names[0]))
                await FreeDatabaseAsync(connection, connectionId, statement.Names[0], context.Token);
            await RunStatementAsync(connection, statement, dryRun: false, context.Token, context.Transaction);
        }, statement.Kind, statement.Undoes, statement.When)).ToList();
        return await RunStepsAsync(connection, steps, inUseAdvice, token, CleanupBudget(action));
    }

    /// <summary>Frees a database of the backend's own sessions (critic A5): the server-scope pools of every connection to the server
    /// move to master when it is their database (host.FreeDatabase) and their idle pools in it are cleared; then, for up to FreeWait,
    /// the action counts the sessions of this process still in it that the backend's pooled connections were given
    /// (host.PoolSessions), which the server ends a moment after a clear. Query tabs are the user's own.</summary>
    private async Task FreeDatabaseAsync(SqlConnection connection, string connectionId, string database, CancellationToken token)
    {
        if (!host.FreeDatabase(connectionId, database)) return;
        var watch = Stopwatch.StartNew();
        while (true)
        {
            var left = await PoolSessionsInAsync(connection, connectionId, database, token);
            if (left == 0 || watch.Elapsed >= Options.FreeWait) return;
            await Task.Delay(50, token);
        }
    }

    /// <summary>How many sessions of this process in the database the backend's pooled connections were given (ActionSql.OwnSessions).</summary>
    private async Task<int> PoolSessionsInAsync(SqlConnection connection, string connectionId, string database, CancellationToken token)
    {
        var pooled = host.PoolSessions(connectionId);
        var left = 0;
        await using var command = connection.CreateCommand();
        command.CommandText = ActionSql.OwnSessions;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, database);
        Add(command, "@pid", SqlDbType.Int, 0, Environment.ProcessId);
        await using var reader = await command.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token)) if (pooled.Contains(Convert.ToInt32(reader.GetValue(0), System.Globalization.CultureInfo.InvariantCulture))) left++;
        return left;
    }

    /// <summary>The live checks' way to free a database as an action does before its DDL (FreeDatabaseAsync), on the action's own connection.</summary>
    internal async Task FreeDatabaseAsync(string connectionId, string database, CancellationToken token)
    {
        await using var connection = host.Connection(connectionId);
        await host.OpenAsync(connection, token);
        await FreeDatabaseAsync(connection, connectionId, database, token);
    }

    /// <summary>The live checks' only way to run a plan of shared templates with compensation (runner v2) through the action
    /// path: the engine gate, the request registry, the execute gates, the action's connection and Stop as actions.execute
    /// has them. Not reachable from the wire, which asks only for catalogue actions.</summary>
    internal Task<ActionExecuteResult> ExecutePlanAsync(string connectionId, string requestId, string action, IReadOnlyList<PlannedStatement> plan, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        return RunAsync(connectionId, requestId, action, read: false, null, token, async (connection, profile, band, job) =>
        {
            var messages = CollectMessages(connection);
            var (steps, failure, _) = await RunPlannedAsync(connection, connectionId, action, plan, null, job);
            return new ActionExecuteResult(steps, messages.Collected(), watch.ElapsedMilliseconds, failure);
        }, error => new ActionExecuteResult([], [], watch.ElapsedMilliseconds, error));
    }

    // --- Jobs -------------------------------------------------------------------------------------------------------------

    private async Task<ActionDescribeResult> DescribeJobAsync(SqlConnection connection, string connectionId, string engine, ObjectRefDto target, int band, CancellationToken token)
    {
        var (subject, error) = await ResolveAsync(connection, target, null, band, (int)catalog.Limit("dependents") + 1, token);
        if (subject is null) return new(null, 0, error);
        var row = subject.Row;
        var owner = row.Name("owner_name") is { Length: > 0 } name ? ScriptingErrors.Display(name) : null;
        if (target.Kind != "database") return new(new DeleteTargetDto(subject.Display, subject.Title, owner, subject.Warnings, subject.Truncated), 0);
        var snapshot = row.Bool("is_snapshot");
        int? sessions = row.Long("sessions") is { } count ? (int)count : null;
        int? withTransaction = row.Long("with_transaction") is { } open ? (int)open : null;
        var (blockers, more) = sessions is null ? (null, false) : await BlockersAsync(connection, connectionId, target.Name!, token);
        var note = engine == "managedInstance" && !snapshot ? ManagedInstanceCloseNote : null;
        var deleted = new DeleteTargetDto(subject.Display, snapshot ? "Database Snapshot" : subject.Title, owner, subject.Warnings, subject.Truncated, snapshot, sessions,
            withTransaction, blockers, blockers is null ? null : more, note);
        return new(deleted, 0);
    }

    /// <summary>The sessions in the database Delete Object lists (ActionSql.DatabaseSessions), at most the catalogue's blockers, leaving
    /// out the sessions of this process its pooled connections were given (FreeDatabaseAsync ends those before the DROP) unless a query
    /// tab holds that id now: More when more exist. Program and host are clipped to blockerChars.</summary>
    private async Task<(List<BlockerDto>? Blockers, bool More)> BlockersAsync(SqlConnection connection, string connectionId, string database, CancellationToken token)
    {
        var limit = (int)catalog.Limit("blockers");
        var chars = (int)catalog.Limit("blockerChars");
        var pooled = host.PoolSessions(connectionId);
        var tabs = host.QuerySessions(connectionId);
        var blockers = new List<BlockerDto>();
        var more = false;
        await using var command = connection.CreateCommand();
        command.CommandText = ActionSql.DatabaseSessions;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, database);
        Add(command, "@take", SqlDbType.Int, 0, limit + 1 + Math.Min(pooled.Count, 1024));
        await using var reader = await command.ExecuteReaderAsync(token);
        int Number(int ordinal) => reader.IsDBNull(ordinal) ? 0 : Convert.ToInt32(reader.GetValue(ordinal), System.Globalization.CultureInfo.InvariantCulture);
        string? Clipped(int ordinal) => reader.IsDBNull(ordinal) || reader.GetString(ordinal).Trim() is not { Length: > 0 } text ? null : ScriptingErrors.Clip(text, chars);
        while (await reader.ReadAsync(token))
        {
            var id = Number(0);
            if (Number(1) == Environment.ProcessId && pooled.Contains(id) && !tabs.Contains(id)) continue;
            if (blockers.Count == limit) { more = true; break; }
            blockers.Add(new(id, Clipped(3), Clipped(4), Number(2) > 0));
        }
        return (blockers, more);
    }

    private async Task<ActionScriptResult> ScriptJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, CancellationToken token)
    {
        var database = ScriptDatabase(target);
        var (subject, error) = await ResolveAsync(connection, target, args.NewName, band, (int)catalog.Limit("dependents") + 1, token);
        if (subject is null) return new(null, database, [], error);
        var text = ScriptText(Plan(args, target, FactsOf(subject)));
        if (text.Length > ScriptLimit(args.Action)) return new(null, database, [], Error("SQL_ERROR", "The script is too large."));
        return new(text, database, [.. subject.Warnings.Take(8).Select(warning => warning.Text)]);
    }

    /// <summary>Script Action's text of a plan: its main statements only, as a success runs them. Compensation and cleanup run only
    /// after a failure or Stop, so they are never scripted.</summary>
    internal static string ScriptText(IEnumerable<PlannedStatement> plan) =>
        string.Concat(plan.Where(statement => statement.Kind == StepKind.Main).Select(ActionSql.Checked).Select(ActionSql.ScriptText));

    private async Task<ActionExecuteResult> ExecuteJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, CancellationToken token)
    {
        var messages = CollectMessages(connection);
        var (subject, error) = await ResolveAsync(connection, target, args.NewName, band, 0, token);
        if (subject is null) return new([], [], 0, error);
        if (Refusal(subject, args) is { } refused) return new([], [], 0, refused);
        var plan = Plan(args, target, FactsOf(subject));
        // The backend's own pools leave the database before the first statement that needs it to itself (RunPlannedAsync).
        var (steps, failure, done) = await RunPlannedAsync(connection, args.ConnectionId, args.Action, plan, target.Kind == "database" && args.Action == "delete" ? ActionErrors.CloseConnectionsAdvice : null, token);
        // The database's new name, or its absence, from now on: a connection opened in it must not keep asking for it.
        if (plan.Where(statement => statement.Kind == StepKind.Main).Take(done).Any(statement => statement.Template is ActionTemplate.DropDatabase or ActionTemplate.RenameDatabase))
            host.DatabaseChanged(args.ConnectionId, target.Name!, args.Action == "rename" ? args.NewName : null);
        return new(steps, messages.Collected(), 0, failure);
    }

    /// <summary>SQL Server's informational messages (severity 10 and below), such as sp_rename's caution, bounded.</summary>
    private sealed class MessageLog(int max, int chars)
    {
        private readonly List<string> messages = [];
        public void Add(SqlError item) { lock (messages) if (item.Class <= 10 && messages.Count < max) messages.Add(ScriptingErrors.Clip(item.Message, chars)); }
        public List<string> Collected() { lock (messages) return [.. messages]; }
    }

    private MessageLog CollectMessages(SqlConnection connection)
    {
        var log = new MessageLog((int)catalog.Limit("infoMessages"), (int)catalog.Limit("infoMessageChars"));
        connection.InfoMessage += (_, e) => { foreach (SqlError item in e.Errors) log.Add(item); };
        return log;
    }

    // --- Database Properties ----------------------------------------------------------------------------------------------

    private async Task<ActionDescribeResult> DescribePropertiesJobAsync(SqlConnection connection, ObjectRefDto target, int band, CancellationToken token)
    {
        var (model, missing) = await DatabaseProperties.DescribeAsync(connection, catalog, target.Name!, band, token);
        return model is null ? new(null, 0, Error("NOT_FOUND", missing!)) : new(null, 0, DatabaseProperties: model);
    }

    /// <summary>The database as the properties preflight finds it in this connection, the plan, or the refusal. Script and
    /// execute share it; only execute checks access, permission and the new owner's login.</summary>
    private async Task<(List<AlterStatement>? Plan, ActionError? Error)> PlanPropertiesAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, bool execute, CancellationToken token,
        bool clearedPools = false)
    {
        var display = ScriptingErrors.Display(target.Name!);
        async Task<ScriptPreflight.Row?> Preflight()
        {
            await using var command = connection.CreateCommand();
            command.CommandText = DatabasePropertiesPreflight;
            command.CommandTimeout = 0;
            Add(command, "@name", SqlDbType.NVarChar, 128, target.Name);
            Add(command, "@owner", SqlDbType.NVarChar, 128, args.Changes!.Owner);
            await using var reader = await command.ExecuteReaderAsync(token);
            return await reader.ReadAsync(token) ? ReadRow(reader) : null;
        }
        var row = await Preflight();
        if (row is null) return (null, Error("NOT_FOUND", "The database " + display + " no longer exists. Refresh Object Explorer."));
        // The properties were read from one database; a rename, drop or restore since can have given its name to another,
        // which Apply and Script must never change in its place.
        if (args.Identity is { } read && (row.Int("database_id") != read.Id || DatabaseProperties.Iso(row.Raw("create_date")) != read.Created))
            return (null, Error("NOT_FOUND", "The database " + display + " is not the one these properties were read from: it was renamed, dropped or replaced since. Read its properties again."));
        if (row.Int("engine_edition") == 8) return (null, Error("NOT_SUPPORTED", "Database Properties on Azure SQL Managed Instance is not supported yet."));
        if (row.Bool("is_snapshot")) return (null, Error("NOT_SUPPORTED", "A database snapshot is read-only."));
        if (row.Int("state") != 0) return (null, Error("DATABASE_UNAVAILABLE", "The database " + display + " is " + (row.Text("state_desc") ?? "unavailable").Replace('_', ' ').ToLowerInvariant() + "."));
        if (execute)
        {
            if (!row.Bool("has_access")) return (null, Error("DATABASE_UNAVAILABLE", "The database " + display + " is not accessible to this login."));
            if (!row.Bool("can_alter")) return (null, Error("PERMISSION_DENIED", "You do not have permission to change " + display + " (ALTER on it)."));
            if (!row.Bool("owner_exists")) return (null, Error("NOT_FOUND", "The login " + ScriptingErrors.Display(args.Changes!.Owner!) + " does not exist."));
        }
        // SSMS counts the database's connections when OK is pressed. The dialog asks Open Connections from the count it opened
        // with; sessions that joined since would make WITH NO_WAIT wait about 20 s and fail, so the change is refused before
        // anything runs, and the dialog asks.
        if (execute && args.CloseConnections != true && Exclusive(args.Changes!))
        {
            // The pooled connections ClearPoolsFor just closed stay listed until the server ends their sessions (measured on SQL
            // Server 2025: up to one count in ten right after the clear sees one, gone within 25 ms), so a count that may include them is
            // taken again for up to a second rather than answered as other connections.
            for (var wait = 0; clearedPools && row.Long("sessions") > 0 && wait < 20; wait++)
            {
                await Task.Delay(50, token);
                if ((row = await Preflight()) is null) return (null, Error("NOT_FOUND", "The database " + display + " no longer exists. Refresh Object Explorer."));
            }
            if (row.Long("sessions") > 0) return (null, Error("IN_USE", ActionErrors.OpenConnectionsAdvice));
        }
        var facts = new DatabaseAlter.Facts(band, Math.Min(row.Int("major") * 10, catalog.CompatibilityLevels.Max()), row.Bool("auto_create"));
        // Script always writes WITH NO_WAIT: SSMS never closes connections while scripting.
        var (plan, refusal) = DatabaseAlter.Plan(catalog, target.Name!, args.Changes!, execute && args.CloseConnections == true, facts);
        if (refusal is not null) return (null, Error("NOT_SUPPORTED", refusal));
        if (plan!.Count == 0) return (null, Error("NOT_SUPPORTED", "Auto Create Incremental Statistics applies only while Auto Create Statistics is True."));
        return (plan, null);
    }

    /// <summary>Whether the changes include an option SSMS closes other connections for.</summary>
    private bool Exclusive(DatabaseChangesDto changes) => (changes.Options ?? []).Keys.Any(key => catalog.DatabaseOptions.TryGetValue(key, out var option) && option.Exclusive == true);

    /// <summary>The properties preflight, in master: the database's identity, state and kind, the login's access and ALTER permission,
    /// Auto Create Statistics now, the server's edition and version, whether a new owner's login exists, and the sessions in
    /// the database (with VIEW SERVER STATE; this connection is in master).</summary>
    public const string DatabasePropertiesPreflight = "SELECT d.database_id AS database_id, d.create_date AS create_date, d.state AS state, d.state_desc AS state_desc, "
        + "CONVERT(bit, CASE WHEN d.source_database_id IS NULL THEN 0 ELSE 1 END) AS is_snapshot, "
        + "CONVERT(bit, ISNULL(CASE WHEN d.user_access = 1 THEN 1 ELSE HAS_DBACCESS(d.name) END, 0)) AS has_access, "
        + "CONVERT(bit, ISNULL(HAS_PERMS_BY_NAME(d.name, N'DATABASE', N'ALTER'), 1)) AS can_alter, d.is_auto_create_stats_on AS auto_create, "
        + "CONVERT(int, SERVERPROPERTY('EngineEdition')) AS engine_edition, CONVERT(int, SERVERPROPERTY('ProductMajorVersion')) AS major, "
        + "CONVERT(bit, CASE WHEN @owner IS NULL OR EXISTS (SELECT 1 FROM sys.server_principals AS p WHERE p.name = @owner) THEN 1 ELSE 0 END) AS owner_exists, "
        + "CASE WHEN HAS_PERMS_BY_NAME(NULL, NULL, N'VIEW SERVER STATE') = 1 THEN (SELECT COUNT(*) FROM sys.dm_exec_sessions AS es WHERE es.database_id = d.database_id) END AS sessions "
        + "FROM sys.databases AS d WHERE d.name = @name;";

    private async Task<ActionScriptResult> ScriptPropertiesJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, CancellationToken token)
    {
        var (plan, error) = await PlanPropertiesAsync(connection, args, target, band, execute: false, token);
        if (plan is null) return new(null, "master", [], error);
        var text = DatabaseAlter.ScriptText(catalog, plan);
        if (text.Length > ScriptLimit(args.Action)) return new(null, "master", [], Error("SQL_ERROR", "The script is too large."));
        return new(text, "master", []);
    }

    private async Task<ActionExecuteResult> ExecutePropertiesJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, CancellationToken token)
    {
        var messages = CollectMessages(connection);
        // The backend's own idle pooled connections in the database must not hold it (SET options WITH NO_WAIT, COLLATE), nor
        // count as other connections in the preflight.
        var cleared = host.FreeDatabase(args.ConnectionId, target.Name!);
        var (plan, error) = await PlanPropertiesAsync(connection, args, target, band, execute: true, token, cleared);
        if (plan is null) return new([], [], 0, error);
        // Choosing Yes helps only where the dialog asks: an exclusive change made without closing connections. Other
        // changes that need the database to themselves (Broker Enabled, Containment type, COLLATE) are never asked about.
        var advice = args.CloseConnections != true && Exclusive(args.Changes!) ? ActionErrors.OpenConnectionsAdvice : ActionErrors.OtherConnectionsAdvice;
        var (steps, failure, _) = await RunStepsAsync(connection, [.. plan.Select(statement => new RunStep(statement.Title, context => RunAlterAsync(connection, statement, dryRun: false, context.Token)))],
            advice, token, CleanupBudget(args.Action));
        return new(steps, messages.Collected(), 0, failure);
    }

    private async Task<List<string?>> RunAlterAsync(SqlConnection connection, AlterStatement statement, bool dryRun, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = DatabaseAlter.Executable(catalog, statement, dryRun);
        command.CommandTimeout = 0;
        Add(command, "@db", SqlDbType.NVarChar, 128, statement.InDatabase ? statement.Database : "master");
        Add(command, "@p1", SqlDbType.NVarChar, 128, statement.Database);
        Add(command, "@p2", SqlDbType.NVarChar, 128, statement.Name);
        Add(command, "@n1", SqlDbType.BigInt, 0, statement.Number);
        var values = new List<string?>();
        await using var reader = await command.ExecuteReaderAsync(token);
        do
        {
            while (await reader.ReadAsync(token))
                for (var i = 0; i < reader.FieldCount; i++) values.Add(reader.IsDBNull(i) ? null : reader.GetString(i));
        } while (await reader.NextResultAsync(token));
        return values;
    }

    /// <summary>The live checks' only way to see what Database Properties batches would run (see the other DryRunAsync), on one connection.</summary>
    internal async Task<List<List<string?>>> DryRunAsync(string connectionId, IReadOnlyList<AlterStatement> statements, CancellationToken token)
    {
        await using var connection = host.Connection(connectionId);
        await host.OpenAsync(connection, token);
        var results = new List<List<string?>>();
        foreach (var statement in statements) results.Add(await RunAlterAsync(connection, statement, dryRun: true, token));
        return results;
    }

    private static async Task<List<string?>> RunStatementAsync(SqlConnection connection, PlannedStatement statement, bool dryRun, CancellationToken token, SqlTransaction? transaction = null)
    {
        ActionSql.Checked(statement);
        await using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = ActionSql.Executable(statement.Template, dryRun);
        command.CommandTimeout = 0;
        Add(command, "@db", SqlDbType.NVarChar, 128, statement.Database);
        for (var index = 0; index < statement.Names.Count; index++) Add(command, "@p" + (index + 1), SqlDbType.NVarChar, 128, statement.Names[index]);
        var values = new List<string?>();
        await using var reader = await command.ExecuteReaderAsync(token);
        do
        {
            while (await reader.ReadAsync(token))
                for (var i = 0; i < reader.FieldCount; i++) values.Add(reader.IsDBNull(i) ? null : reader.GetString(i));
        } while (await reader.NextResultAsync(token));
        return values;
    }

    /// <summary>The live checks' only way to see what an executable batch would run: SQL Server builds the statement from the
    /// parameters and selects it. Not reachable from the wire, which can never ask the backend to skip or alter DDL.</summary>
    internal async Task<List<string?>> DryRunAsync(string connectionId, PlannedStatement statement, CancellationToken token)
    {
        await using var connection = host.Connection(connectionId);
        await host.OpenAsync(connection, token);
        return await RunStatementAsync(connection, statement, dryRun: true, token);
    }

    /// <summary>Cancels a disconnected connection's requests and drops its gates.</summary>
    public void Forget(string connectionId)
    {
        running.Forget(connectionId);
        readGates.TryRemove(connectionId, out _);
        executeGates.TryRemove(connectionId, out _);
    }

    public void CancelAll() => running.ForgetAll();

    public void Dispose()
    {
        running.ForgetAll();
        readGates.Clear();
        executeGates.Clear();
    }
}
