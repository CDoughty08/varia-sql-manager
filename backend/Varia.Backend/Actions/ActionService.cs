using System.Collections.Concurrent;
using System.Data;
using System.Diagnostics;
using System.Text.RegularExpressions;
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
    /// <summary>The connection, then every other connection of the backend to the same server, as SERVERPROPERTY('ServerName')
    /// names it (whatever name each was opened with): those DatabaseChanged and FreeDatabase act on. Hosts with one connection
    /// (the offline checks') have only it.</summary>
    IReadOnlyList<string> SameServer(string connectionId) => [connectionId];
    /// <summary>The session ids of the backend's open query sessions on connections to the same server. SQL Server gives a freed id
    /// to the next client, and PoolSessions keeps a cleared pool's ids for minutes, so a query tab can hold one of them: it is the
    /// user's session, never Varia's pool's. Hosts that open no query sessions (the offline checks') have none.</summary>
    IReadOnlySet<int> QuerySessions(string connectionId) => new HashSet<int>();
    /// <summary>The backend's open query sessions on connections to the same server, by SPID: each one's session id (its query tab).</summary>
    IReadOnlyDictionary<int, string> QueryTabs(string connectionId) => new Dictionary<int, string>();
}

/// <summary>Limits and test seams (live checks set the internal ones through InternalsVisibleTo).</summary>
internal sealed class ActionServiceOptions
{
    public int ReadPerConnection { get; init; } = 2;
    public int ReadTotal { get; init; } = 4;
    public int ExecutePerConnection { get; init; } = 1;
    public int ExecuteTotal { get; init; } = 2;
    /// <summary>The long-job gate (the catalogue's long actions: restore, verify, backup): their DDL takes it instead of the execute
    /// gate, so other actions on the connection stay available while one runs for hours (actionLimits.longPerConnection, longTotal).</summary>
    public int LongPerConnection { get; init; } = 1;
    public int LongTotal { get; init; } = 2;
    public int MaxRegistered { get; init; } = 128;
    public TimeSpan DescribeBudget { get; set; } = TimeSpan.FromSeconds(40);
    public TimeSpan ScriptBudget { get; set; } = TimeSpan.FromSeconds(25);
    /// <summary>The server file picker's budget for one listing (actionLimits.browseMs).</summary>
    public TimeSpan BrowseBudget { get; set; } = TimeSpan.FromSeconds(10);
    /// <summary>Restore Database's describe: reading backup media headers on a large striped set or a slow share (restoreLimits.mediaReadMs).</summary>
    public TimeSpan RestoreDescribeBudget { get; set; } = TimeSpan.FromSeconds(120);
    /// <summary>The picker's listings run one at a time per connection under a gate of their own, outside the read gates: SQL
    /// Server honours an attention only once a file-system call returns (about 21 s for an unreachable share), so a listing
    /// past its budget still holds its gate, and must not hold one that Database Properties or Delete Object waits for.</summary>
    public int BrowsePerConnection { get; init; } = 1;
    /// <summary>Restore Database's describes (LABELONLY, HEADERONLY and FILELISTONLY on files that may sit on a slow or unreachable
    /// share, and msdb's history) run two at a time per connection under a gate of their own, outside the read gates, for the
    /// same reason as the picker's: a media read past its budget still holds its gate until SQL Server's file call returns.</summary>
    public int RestorePerConnection { get; init; } = 2;
    public TimeSpan GateWait { get; set; } = TimeSpan.FromSeconds(30);
    /// <summary>How long Stop on DDL waits for SQL Server to end the statement before the request answers CANCELLED; the
    /// action's cleanup budget (its compensation and cleanup steps) is added to it.</summary>
    public TimeSpan StopGrace { get; set; } = TimeSpan.FromSeconds(10);
    /// <summary>The least time between two action.progress EVENTs of one request (actionLimits.progressEventMs).</summary>
    public TimeSpan ProgressInterval { get; set; } = TimeSpan.FromMilliseconds(ActionsCatalog.Current.Limit("progressEventMs"));
    /// <summary>How long freeing a database waits for the sessions of the pools it cleared to end (critic A5).</summary>
    public TimeSpan FreeWait { get; set; } = TimeSpan.FromSeconds(1);
    /// <summary>How long Bring Online reads the access a database came back with, after SET ONLINE completed (the reply's note).</summary>
    public TimeSpan AccessNoteBudget { get; set; } = TimeSpan.FromSeconds(5);
    /// <summary>How long a database rename that waits for other sessions (Rename When Free) pauses before it tries MODIFY NAME again
    /// after SQL Server refused it at once as in use (5030).</summary>
    public TimeSpan RenameRetryDelay { get; set; } = TimeSpan.FromSeconds(1);
    /// <summary>How long a login's mapped-user scan reads databases (null: loginLimits.scanMs); the live checks shorten it.</summary>
    internal TimeSpan? ScanBudget { get; set; }
    /// <summary>Test seam: awaited before each main step with its title and the job's token.</summary>
    internal Func<string, CancellationToken, Task>? BeforeStep { get; set; }
    /// <summary>Test seam: awaited after each main step's statement ends, before it counts as done, with its title and the job's token: a
    /// Stop there stands for one that reached SQL Server only as the statement finished.</summary>
    internal Func<string, CancellationToken, Task>? AfterStep { get; set; }
    /// <summary>Test seam: awaited before each compensation or cleanup step that runs, with its title and the cleanup budget's token.</summary>
    internal Func<string, CancellationToken, Task>? BeforeCleanup { get; set; }
    /// <summary>Test seam: the newest database version Attach Databases takes the server to open, in place of master's.</summary>
    internal int? AttachServerVersion { get; set; }
}

/// <summary>A job's gate when it is not the read or execute gates: the picker's listings, Restore Database's reads.</summary>
internal enum OwnGate { None, Browse, Restore }

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
    private readonly ConcurrentDictionary<string, SemaphoreSlim> longGates = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> browseGates = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> restoreGates = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim readTotal;
    private readonly SemaphoreSlim executeTotal;
    private readonly SemaphoreSlim longTotal;
    /// <summary>Running long jobs, each with how long a shutdown waits for it (StopWait: SQL Server ending its statement, then its cleanup).</summary>
    private readonly ConcurrentDictionary<Task, TimeSpan> longJobs = new();
    private int activeJobs;

    public const string CloudMessage = "Object actions on Azure SQL Database are not supported yet.";
    /// <summary>The describe id of the server file picker (src/shared/actions/catalog.ts serverFilesDescribeId).</summary>
    public const string ServerFilesDescribe = "serverFiles";
    public const string ManagedInstanceFilesMessage = "Azure SQL Managed Instance does not let Varia browse its folders.";
    public const string ManagedInstanceMessage = "This object action is not available on Azure SQL Managed Instance.";

    /// <summary>Why an action does not run on a server of this engine (its catalogue `engines`, critic A1).</summary>
    public static string EngineMessage(string engine) => engine switch
    {
        "cloud" => CloudMessage,
        "managedInstance" => ManagedInstanceMessage,
        _ => "This object action is not available on this server."
    };

    /// <summary>Whether an action (a catalogue action, or the designer's createTable) runs on a server of this engine.</summary>
    private bool Serves(string action, string engine) => designer.Requests.Contains(action) ? designer.Engines.Contains(engine)
        : catalog.Restore.Requests.Contains(action) ? catalog.Restore.Engines.Contains(engine) : catalog.Serves(action, engine);

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
        longTotal = new SemaphoreSlim(Options.LongTotal);
        running = new RequestRegistry(Options.MaxRegistered, "object action");
    }

    public ActionServiceOptions Options { get; }
    public ActionsCatalog Catalog => catalog;
    /// <summary>Requests registered and not yet answered.</summary>
    public int RunningCount => running.Count;
    /// <summary>Jobs still holding their connection: an answered (cancelled) request's job counts until its statement ends.</summary>
    public int ActiveJobs => Volatile.Read(ref activeJobs);

    private static RequestException Invalid(string detail) => new("INVALID_PARAMS", "Invalid object action request: " + detail);
    /// <summary>A SID as CONVERT(varchar(172), sid, 2) writes it (loginLimits.sidHex).</summary>
    [GeneratedRegex(@"^[0-9A-F]{2,172}\z")]
    private static partial Regex LoginSid();

    // --- Validation -------------------------------------------------------------------------------------------------------

    private static readonly HashSet<string> SystemSchemas = new(["sys", "INFORMATION_SCHEMA"], StringComparer.Ordinal);
    private static readonly HashSet<string> SystemDatabases = new(["master", "model", "msdb", "tempdb"], StringComparer.Ordinal);

    private ObjectRefDto Target(ObjectRefDto? target, string action)
    {
        if (target is null) throw Invalid("target.");
        try { ExplorerRefs.Object(target, explorer); }
        catch (RequestException) { throw Invalid("target."); }
        // A folder's action (Attach) acts on the server alone.
        if (catalog.FolderOf(action) is not null) return target == ServerRef ? target : throw Invalid("target.");
        if (!catalog.Offered(target.Kind, action)) throw Invalid("this object does not offer " + action + ".");
        if (catalog.ServesSystemObjects(action)) return target;
        // SQL Server's own logins by name, as the Logins folder tells them; the preflight re-derives the subtype.
        if (target.Kind == "login" && LoginRules.SystemName(target.Name!)) throw Invalid("system objects cannot be changed.");
        if (target.Kind == "database" ? SystemDatabases.Contains(target.Name!) : target.Schema is { } schema && SystemSchemas.Contains(schema)) throw Invalid("system objects cannot be changed.");
        return target;
    }

    private static readonly ObjectRefDto ServerRef = new("server");

    private static void Ids(string? connectionId, string? requestId)
    {
        if (!Guid.TryParse(connectionId, out _)) throw Invalid("connectionId.");
        if (!Guid.TryParse(requestId, out _)) throw Invalid("requestId.");
    }

    /// <summary>Re-validates what main's zod schema (src/shared/actions/schema.ts) accepts for actions.describe: a known
    /// dialog and a target its action serves, a fact describe and a target of a kind it describes, the table designer and a
    /// database, SQL Server's own included, or the server file picker, the server and what to list (a known purpose and a server
    /// path, without All Files for a folder).</summary>
    public ObjectRefDto Validate(ActionDescribeArgs args)
    {
        Ids(args.ConnectionId, args.RequestId);
        if ((args.Dialog == ServerFilesDescribe) != (args.Files is not null)) throw Invalid("files.");
        if (args.Attach is { } attach && (args.Dialog != AttachDialog || !ServerPath.Valid(attach.Mdf, catalog.Limit("serverPath")))) throw Invalid("attach.");
        if ((args.Dialog == catalog.Restore.Describe) != (args.Restore is not null)) throw Invalid("restore.");
        if (args.Restore is not null) return ValidateRestoreSource(args);
        if (args.Files is { } files)
        {
            if (!catalog.ServerFilePurposes.ContainsKey(files.Purpose ?? "")) throw Invalid("purpose.");
            if (files.Path is not null && !ServerPath.Valid(files.Path, catalog.Limit("serverPath"))) throw Invalid("path.");
            if (files.Purpose == "folder" && files.AllFiles == true) throw Invalid("a folder picker lists folders only.");
            if (files.Exists == true && (files.Path is null || files.AllFiles is not null)) throw Invalid("exists checks one path.");
            if (args.Target is not { Kind: "server" }) throw Invalid("target.");
            try { ExplorerRefs.Object(args.Target, explorer); }
            catch (RequestException) { throw Invalid("target."); }
            return args.Target;
        }
        // User Mapping reads any database, SQL Server's own included: a login may be mapped to master or msdb.
        if (args.Dialog is not null && args.Dialog == catalog.Logins.RolesDescribe) return MappedDatabase(args.Target);
        if (args.Dialog is not null && designer.Describes.Contains(args.Dialog)) return DatabaseTarget(args.Target);
        if (args.Dialog is not null && catalog.Describes.TryGetValue(args.Dialog, out var kinds))
        {
            if (args.Target is null || !kinds.Contains(args.Target.Kind)) throw Invalid("target.");
            return Target(args.Target, catalog.ActionOf(args.Dialog));
        }
        if (args.Dialog is null || !catalog.Dialogs.ContainsKey(args.Dialog)) throw Invalid("dialog.");
        // New Login opens on the server: its action makes a login rather than acting on a row.
        if (args.Dialog == "newLogin") return ServerTarget(args.Target);
        // A server action's document (New Database) describes the server it makes something on.
        if (catalog.IsServerAction(catalog.ActionOf(args.Dialog)))
        {
            if (args.Target is not { Kind: "server" }) throw Invalid("target.");
            try { ExplorerRefs.Object(args.Target, explorer); }
            catch (RequestException) { throw Invalid("target."); }
            return args.Target;
        }
        return Target(args.Target, catalog.ActionOf(args.Dialog));
    }

    /// <summary>The actions whose actions.execute may carry passwords: New Login, and Login Properties (D2c).</summary>
    private static readonly HashSet<string> SecretActions = new(["createLogin", "loginProperties"], StringComparer.Ordinal);

    /// <summary>A password of at most loginLimits.password UTF-16 units, without U+0000 or an unpaired surrogate, here for every
    /// action that takes one, so none can forget it. The message names the member, never the value.</summary>
    private void Secret(string? value, string member)
    {
        if (value is not null && (value.Length > catalog.Logins.Limit("password") || value.Contains('\0') || ScriptingErrors.UnpairedSurrogate(value) >= 0)) throw Invalid("secrets." + member + ".");
    }

    /// <summary>Re-validates actionRequestSchema (actionScriptRequestSchema for a script): the action, ids, a target whose kind
    /// offers it, a new name of 1–128 UTF-16 units without U+0000 that differs from the old one, a login's Disable and Enable
    /// with nothing but a target and the login's identity, the delete flags only for databases and the login's identity and
    /// dropMappedUsers only for a login's Delete (whose execute needs the identity), Database Properties' changes (DatabaseAlter.Validate), and secrets nowhere but an
    /// execute of an action that takes them (critic A3).</summary>
    public ObjectRefDto Validate(ActionArgs args, bool script = false)
    {
        Ids(args.ConnectionId, args.RequestId);
        if (args.Secrets is not null && (script || !SecretActions.Contains(args.Action))) throw Invalid("this request takes no secrets.");
        if (args.Secrets is { } secrets) { Secret(secrets.Password, "password"); Secret(secrets.OldPassword, "oldPassword"); }
        // The login a confirmation or Delete Object was about: Disable, Enable and Delete read it first.
        if (args.LoginIdentity is { } loginRead && (args.Action is not ("disable" or "enable" or "delete") || loginRead.Sid is null || !LoginSid().IsMatch(loginRead.Sid)
            || loginRead.Created is null || !DatabaseAlter.IdentityCreated().IsMatch(loginRead.Created))) throw Invalid("loginIdentity.");
        if (args.DropMappedUsers is not null && args.Action != "delete") throw Invalid("only a login's delete drops mapped users.");
        if (args.Action != "detach" && (args.UpdateStatistics is not null || args.DetachOffline is not null)) throw Invalid("only detach takes updateStatistics and detachOffline.");
        if (args.Action != "createLogin" && LoginMembers(args)) throw Invalid(args.Action + " takes no login, server roles, mappings or status.");
        if (args.Restore is not null && args.Action != "restore") throw Invalid("only a restore takes restore options.");
        if (args.DropConnections is not null && args.Action is not ("takeOffline" or "detach")) throw Invalid("only takeOffline and detach take dropConnections.");
        if (args.RestoreFiles is not null && args.Action != "restoreFiles") throw Invalid("only a file restore takes file restore options.");
        switch (args.Action)
        {
            case "rename":
                if (args.DeleteHistory is not null || args.Changes is not null || args.Design is not null || args.Databases is not null)
                    throw Invalid("rename takes no delete options or changes.");
                if (!ExplorerRefs.Ident(args.NewName)) throw Invalid("newName.");
                var renamed = Target(args.Target, "rename");
                if (string.Equals(args.NewName, renamed.Name, StringComparison.Ordinal)) throw Invalid("the new name is the current name.");
                // Varia would take the renamed login for one of SQL Server's own (zod refuses it too).
                if (renamed.Kind == "login" && LoginRules.SystemName(args.NewName!)) throw Invalid("newName.");
                // Only a database has connections to close (D3c) and an identity its describe read.
                if (renamed.Kind != "database" && (args.CloseConnections is not null || args.Identity is not null)) throw Invalid("only a database has connections to close and an identity.");
                if (args.Identity is { } read && !DatabaseAlter.IdentityValid(read)) throw Invalid("identity.");
                return renamed;
            case "delete":
                if (args.NewName is not null || args.Changes is not null || args.Design is not null || args.Identity is not null || args.Databases is not null) throw Invalid("delete takes no new name or changes.");
                if (args.CloseConnections is not { } close || args.DeleteHistory is not { } history) throw Invalid("closeConnections and deleteHistory are required.");
                var deleted = Target(args.Target, "delete");
                if (deleted.Kind != "database" && (close || history)) throw Invalid("only a database has connections to close and backup history to delete.");
                if (deleted.Kind != "login" && (args.DropMappedUsers is not null || args.LoginIdentity is not null)) throw Invalid("only a login has mapped users and an identity to check.");
                // DROP LOGIN and every DROP USER bind to the principal Delete Object showed; Script runs nothing and may omit it.
                if (deleted.Kind == "login" && !script && args.LoginIdentity is null) throw Invalid("a login's delete needs the loginIdentity it read.");
                return deleted;
            case "properties":
                if (args.Design is not null || args.Databases is not null) throw Invalid("properties takes no design or databases.");
                var target = Target(args.Target, "properties");
                DatabaseAlter.Validate(catalog, args);
                return target;
            case "disable" or "enable":
                if (args.NewName is not null || args.CloseConnections is not null || args.DeleteHistory is not null || args.Changes is not null || args.Design is not null || args.Identity is not null
                    || args.Databases is not null)
                    throw Invalid(args.Action + " takes only a target.");
                var login = Target(args.Target, args.Action);
                if (login.Kind != "login") throw Invalid("target.");
                return login;
            case "restore":
                return ValidateRestore(args);
            case "attach":
                if (args.NewName is not null || args.CloseConnections is not null || args.DeleteHistory is not null || args.Changes is not null || args.Design is not null || args.Identity is not null)
                    throw Invalid("attach takes only databases.");
                var server = Target(args.Target, "attach");
                ValidateAttach(args.Databases);
                return server;
            case "restoreFiles":
                return ValidateRestoreFiles(args);
            case "createTable":
                if (args.NewName is not null || args.CloseConnections is not null || args.DeleteHistory is not null || args.Changes is not null || args.Identity is not null || args.Databases is not null)
                    throw Invalid("createTable takes only a design.");
                var database = DatabaseTarget(args.Target);
                TableDesignValidator.Validate(designer, args.Design?.As<TableDesignDto>());
                return database;
            case "createLogin":
                return ValidateCreateLogin(args, script);
            case "createDatabase":
                if (args.NewName is not null || args.CloseConnections is not null || args.DeleteHistory is not null || args.Changes is not null || args.Identity is not null || args.Databases is not null)
                    throw Invalid("createDatabase takes only a design.");
                // The new database's name is the target's; it is no object yet, so no row offers the action.
                if (args.Target is not { Kind: "database", Database: null, Schema: null, Parent: null, SsisFolder: null, SsisProject: null } created || !ExplorerRefs.Ident(created.Name)) throw Invalid("target.");
                NewDatabaseValidator.Validate(catalog, created.Name!, args.Design?.As<NewDatabaseDesignDto>());
                return created;
            case "takeOffline":
            case "bringOnline":
                if (args.NewName is not null || args.CloseConnections is not null || args.DeleteHistory is not null || args.Changes is not null || args.Design is not null || args.Databases is not null)
                    throw Invalid(args.Action + " takes no new name, delete options, changes or databases.");
                // Take Offline asks whether to roll back other connections; Bring Online has nothing to ask (no other action takes it).
                if (args.Action == "takeOffline" && args.DropConnections is null) throw Invalid("dropConnections is required.");
                if (args.Identity is { } identity && !DatabaseAlter.IdentityValid(identity)) throw Invalid("identity.");
                return Target(args.Target, args.Action);
            case "detach":
                if (args.NewName is not null || args.CloseConnections is not null || args.DeleteHistory is not null || args.Changes is not null || args.Design is not null)
                    throw Invalid("detach takes no new name, delete options or changes.");
                // Drop Connections and Update Statistics are the grid's two boxes; Detach while offline is asked only of an offline database.
                if (args.DropConnections is null || args.UpdateStatistics is null) throw Invalid("dropConnections and updateStatistics are required.");
                if (args.Identity is { } detached && !DatabaseAlter.IdentityValid(detached)) throw Invalid("identity.");
                return Target(args.Target, "detach");
            default:
                throw Invalid("action.");
        }
    }

    /// <summary>The longest script an action may return.</summary>
    private long ScriptLimit(string action) => action switch
    {
        "createTable" => designer.Limit("scriptChars"),
        "restore" or "restoreFiles" => catalog.Restore.Limit("scriptChars"),
        _ => catalog.Limit("scriptChars")
    };

    // --- Requests ---------------------------------------------------------------------------------------------------------

    /// <summary>Whether a describe other than a listing waits on the file system: Attach's Add reads a file the user chose (DBCC
    /// CHECKPRIMARYFILE) and checks the files it records, so it takes the picker's gate, never one Database Properties or Delete
    /// Object waits for.</summary>
    internal static bool OnBrowseGate(ActionDescribeArgs args) => args.Dialog == AttachDialog && args.Attach is not null;

    public Task<ActionDescribeResult> DescribeAsync(ActionDescribeArgs args, CancellationToken token)
    {
        var target = Validate(args);
        var watch = Stopwatch.StartNew();
        if (args.Files is { } files)
        {
            // The picker is no catalogue action, so it names its own engines: Azure SQL Database has no server disks to browse,
            // and Managed Instance keeps its files to itself (no RESTORE FROM DISK, attach or file specs).
            var engine = host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine;
            if (engine != "box") return Task.FromResult(new ActionDescribeResult(null, 0, Error("NOT_SUPPORTED", engine == "managedInstance" ? ManagedInstanceFilesMessage : CloudMessage)));
            return RunAsync(args.ConnectionId, args.RequestId, null, read: true, Options.BrowseBudget, token,
                async (connection, profile, band, job) =>
                {
                    var (listing, error) = await ServerFiles.ListAsync(connection, catalog, files, profile.Linux, job);
                    return new ActionDescribeResult(null, watch.ElapsedMilliseconds, error, ServerFiles: listing);
                },
                error => new ActionDescribeResult(null, watch.ElapsedMilliseconds, error), "Listing the folder", own: OwnGate.Browse);
        }
        if (args.Restore is not null) return DescribeRestoreAsync(args, token);
        var action = designer.Describes.Contains(args.Dialog) ? designer.Requests.Single() : args.Dialog == catalog.Logins.RolesDescribe ? "createLogin" : catalog.ActionOf(args.Dialog);
        var reading = OnBrowseGate(args);
        return RunAsync(args.ConnectionId, args.RequestId, action, read: true, Options.DescribeBudget, token,
            async (connection, profile, band, job) => await (args.Dialog switch
            {
                "tableDesigner" => DescribeDesignerJobAsync(connection, target, band, job),
                "databaseProperties" => DescribePropertiesJobAsync(connection, target, band, job),
                "newLogin" => DescribeNewLoginJobAsync(connection, profile, band, job),
                "newDatabase" => DescribeNewDatabaseJobAsync(connection, profile, band, job),
                AttachDialog => DescribeAttachJobAsync(connection, args.Attach, profile.Linux, job),
                "takeOffline" or "bringOnline" or "detachDatabase" => DescribeStateJobAsync(connection, args.ConnectionId, target, action, band, job, profile.Linux),
                "renameDatabase" => DescribeRenameJobAsync(connection, args.ConnectionId, target, profile.Explorer(explorer).ServerEngine, band, job),
                "loginFacts" => DescribeLoginJobAsync(connection, target, job),
                _ when args.Dialog == catalog.Logins.RolesDescribe => DescribeDatabaseRolesJobAsync(connection, target, job),
                _ => DescribeJobAsync(connection, args.ConnectionId, profile.Explorer(explorer).ServerEngine, target, action, band, job)
            }) with { ElapsedMs = watch.ElapsedMilliseconds },
            error => new ActionDescribeResult(null, watch.ElapsedMilliseconds, error), reading ? "Reading the file" : "Reading the object", own: reading ? OwnGate.Browse : OwnGate.None);
    }

    public Task<ActionScriptResult> ScriptAsync(ActionArgs args, CancellationToken token)
    {
        var target = Validate(args, script: true);
        if (args.Action == "createLogin") return ScriptNewLoginAsync(args, token);
        // The restores' Script reads nothing: it is written from the request and the catalogue, on no connection and under no gate.
        if (catalog.Restore.Requests.Contains(args.Action))
        {
            var engine = host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine;
            if (!Serves(args.Action, engine)) return Task.FromResult(new ActionScriptResult(null, "master", [], ActionErrors.Create(catalog, "NOT_SUPPORTED", EngineMessage(engine))));
            return Task.FromResult(args.Action == "restoreFiles" ? ScriptRestoreFiles(args, target) : ScriptRestore(args, target));
        }
        // A new table's script runs in its database; a database's, a server object's or the server's action in master.
        var database = args.Action == "createTable" ? target.Name! : args.Action == "attach" ? "master" : ScriptDatabase(target);
        return RunAsync(args.ConnectionId, args.RequestId, args.Action, read: true, Options.ScriptBudget, token,
            (connection, profile, band, job) => args.Action switch
            {
                "createTable" => ScriptDesignerJobAsync(connection, args, target, band, job),
                "properties" => ScriptPropertiesJobAsync(connection, args, target, band, job),
                "createDatabase" => ScriptNewDatabaseJobAsync(connection, args, profile, band, job),
                "attach" => Task.FromResult(ScriptAttach(args)),
                _ => ScriptJobAsync(connection, args, target, band, job)
            },
            error => new ActionScriptResult(null, database, [], error));
    }

    /// <param name="events">Queues a droppable EVENT on the request (action.progress), or null when nothing listens. Only a long
    /// action sends them: the others report no STATS, and their step starts would only add traffic.</param>
    public Task<ActionExecuteResult> ExecuteAsync(ActionArgs args, CancellationToken token, Action<object>? events = null)
    {
        var target = Validate(args);
        var watch = Stopwatch.StartNew();
        // Managed Instance refuses SINGLE_USER: Delete Object greys the option there (CloseConnectionsNote), and a request that
        // asks for it anyway is refused before any connection opens.
        if (args.Action == "delete" && args.CloseConnections == true && host.Profile(args.ConnectionId).Explorer(explorer).ServerEngine == "managedInstance")
            return Task.FromResult(new ActionExecuteResult([], [], 0, Error("NOT_SUPPORTED", ManagedInstanceCloseNote)));
        var progress = new ActionProgress(catalog.IsLong(args.Action) ? events : null, Options.ProgressInterval);
        return RunAsync(args.ConnectionId, args.RequestId, args.Action, read: false, null, token,
            async (connection, profile, band, job) => await (args.Action switch
            {
                "createTable" => ExecuteDesignerJobAsync(connection, args, target, band, progress, job),
                "properties" => ExecutePropertiesJobAsync(connection, args, target, band, progress, job),
                "restore" => ExecuteRestoreJobAsync(connection, args, target, profile.Linux, progress, job),
                "createDatabase" => ExecuteNewDatabaseJobAsync(connection, args, profile, band, progress, job),
                "attach" => ExecuteAttachJobAsync(connection, args, job),
                "createLogin" => ExecuteNewLoginJobAsync(connection, args, job),
                "restoreFiles" => ExecuteRestoreFilesJobAsync(connection, args, target, profile.Linux, progress, job),
                "detach" => ExecuteDetachJobAsync(connection, args, target, profile.Linux, band, job),
                _ => ExecuteJobAsync(connection, args, target, profile.Explorer(explorer).ServerEngine, band, progress, job)
            }) with { ElapsedMs = watch.ElapsedMilliseconds },
            error => new ActionExecuteResult([], [], watch.ElapsedMilliseconds, error));
    }

    /// <summary>Registers the request, then runs the job on the pool under the read or execute gates with its own
    /// connection. Past its budget, a describe or script answers TIMEOUT; DDL has none (Stop ends it). A disconnect answers
    /// CANCELLED. Failures before any DDL, such as an engine the action does not run on or a Kerberos sign-in, are values.
    /// Stop on DDL (the request's own token) has already sent SQL Server an attention through the job's token; the reply then
    /// waits up to StopGrace plus the action's cleanup budget for the job, whose steps say what completed and what Varia
    /// undid, and past it answers CANCELLED, an unknown outcome. A long action's DDL takes the long gate instead of the execute
    /// gate, and a shutdown waits for its job (DrainLong), so its cleanup still runs when the backend is closed under it. A null
    /// action is the server file picker's listing, which checks its own engines first; it and Attach's file read take only the
    /// browse gate (own Browse), and Restore Database's reads of msdb and backup media only the restore gate (own Restore).</summary>
    private async Task<T> RunAsync<T>(string connectionId, string requestId, string? action, bool read, TimeSpan? budget, CancellationToken token,
        Func<SqlConnection, ServerProfile, int, CancellationToken, Task<T>> work, Func<ActionError, T> failed, string reading = "Reading the object", OwnGate own = OwnGate.None)
    {
        var profile = host.Profile(connectionId);
        var served = profile.Explorer(explorer);
        // Each action declares the engines it runs on: Azure SQL Database reaches one database per connection and refuses USE,
        // and Managed Instance cannot set SINGLE_USER, attach, detach or restore from a disk.
        if (action is not null && !Serves(action, served.ServerEngine)) return failed(ActionErrors.Create(catalog, "NOT_SUPPORTED", EngineMessage(served.ServerEngine)));
        using var source = CancellationTokenSource.CreateLinkedTokenSource(token);
        var entry = running.Register(requestId, connectionId, source);
        try
        {
            token.ThrowIfCancellationRequested();
            if (budget is { } limit) source.CancelAfter(limit);
            // The job's token is cancelled off the canceller's thread (CancelAsync): SqlClient's cancel waits while a statement streams
            // info messages (a RESTORE's STATS) until it ends, and a Stop's canceller is the backend's frame loop, which would stop
            // reading every request, ping included, for as long. ReadAllAsync sends the cancel from the reader's own thread instead.
            var jobSource = new CancellationTokenSource();
            // Never disposed with this scope: a Stop or the budget may resume this method (and leave the scope) from an earlier
            // callback of the same Cancel, and a disposed registration would then never cancel the job.
            _ = source.Token.UnsafeRegister(static state => _ = ((CancellationTokenSource)state!).CancelAsync(), jobSource);
            var gate = own switch
            {
                OwnGate.Browse => ActionGate.Browse,
                OwnGate.Restore => ActionGate.Restore,
                _ => read ? ActionGate.Read : action is not null && catalog.IsLong(action) ? ActionGate.Long : ActionGate.Execute
            };
            var job = Task.Run(() => JobAsync(connectionId, gate, profile, served.Band, work, failed, jobSource), CancellationToken.None);
            _ = job.ContinueWith(done => _ = done.Exception, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
            if (gate == ActionGate.Long)
            {
                longJobs[job] = StopWait(action!);
                _ = job.ContinueWith(done => longJobs.TryRemove(done, out _), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            }
            try { return await job.WaitAsync(source.Token); }
            catch (OperationCanceledException) when (source.IsCancellationRequested && !token.IsCancellationRequested)
            {
                if (entry.Forgotten) throw new RequestException("CANCELLED", "The operation was cancelled.");
                return failed(ActionErrors.Create(catalog, "TIMEOUT", reading + " took longer than " + (int)budget!.Value.TotalSeconds + " seconds. Try again."));
            }
            catch (OperationCanceledException) when (!read && token.IsCancellationRequested && !entry.Forgotten)
            {
                try { return await job.WaitAsync(action is null ? Options.StopGrace : StopWait(action), CancellationToken.None); }
                catch (TimeoutException) { throw new OperationCanceledException(token); }
                // Only the preflight, the gates or the sign-in can throw on cancellation: no DDL had started.
                catch (Exception error) when (error is OperationCanceledException or SqlException) { return failed(Error("CANCELLED", "The action was stopped before it changed anything.")); }
            }
        }
        finally { running.Unregister(requestId, entry); }
    }

    private async Task<T> JobAsync<T>(string connectionId, ActionGate kind, ServerProfile profile, int band, Func<SqlConnection, ServerProfile, int, CancellationToken, Task<T>> work,
        Func<ActionError, T> failed, CancellationTokenSource jobSource)
    {
        Interlocked.Increment(ref activeJobs);
        try
        {
            var token = jobSource.Token;
            var read = kind is ActionGate.Read or ActionGate.Browse or ActionGate.Restore;
            // The picker's listings and Restore Database's reads take only their own gate (ActionServiceOptions.BrowsePerConnection,
            // RestorePerConnection), never a read gate or a total slot.
            var (gates, perConnection, total) = kind switch
            {
                ActionGate.Browse => (browseGates, Options.BrowsePerConnection, (SemaphoreSlim?)null),
                ActionGate.Restore => (restoreGates, Options.RestorePerConnection, (SemaphoreSlim?)null),
                ActionGate.Read => (readGates, Options.ReadPerConnection, readTotal),
                ActionGate.Long => (longGates, Options.LongPerConnection, longTotal),
                _ => (executeGates, Options.ExecutePerConnection, executeTotal)
            };
            var gate = gates.GetOrAdd(connectionId, _ => new SemaphoreSlim(perConnection));
            if (!await gate.WaitAsync(Options.GateWait, token)) throw Busy(kind, total: false);
            try
            {
                if (total is not null && !await total.WaitAsync(Options.GateWait, token)) throw Busy(kind, total: true);
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
                finally { total?.Release(); }
            }
            finally { gate.Release(); }
        }
        finally
        {
            Interlocked.Decrement(ref activeJobs);
            jobSource.Dispose();
        }
    }

    /// <summary>Which gates a request takes: describe and script the read gates, DDL the execute gates, a long action's DDL the long
    /// ones, the server file picker's listings and Attach's file read only the browse gate, and Restore Database's reads only the restore gate.</summary>
    private enum ActionGate { Read, Execute, Long, Browse, Restore }

    /// <summary>The gates are per Varia connection (critic A26): two connections to one server have a gate each. A request that
    /// holds its connection's gate but not a total slot waits on actions of other connections, so the message says so: the user
    /// must look for them there.</summary>
    private static RequestException Busy(ActionGate kind, bool total) => (kind, total) switch
    {
        (ActionGate.Long, false) => new("BUSY", "Another restore or backup is running on this connection. Retry after it finishes."),
        (ActionGate.Long, true) => new("BUSY", "Restores or backups are already running on other connections. Retry after one finishes."),
        (_, false) => new("BUSY", "Other object actions are running on this connection. Retry after they finish."),
        _ => new("BUSY", "Object actions are already running on other connections. Retry after they finish.")
    };

    /// <summary>For a backend that is shutting down, after CancelAll: waits for every long job to end, each within its Stop wait
    /// (StopGrace plus its cleanup budget), so a restore stopped by a reload, a quit or Restart SQL Backend still removes what it
    /// created before the process exits. Main gives such a generation the longer grace (methodPolicies' drainMs). True when none is left.</summary>
    public bool DrainLong()
    {
        var running = longJobs.ToArray();
        if (running.Length == 0) return true;
        try { return Task.WaitAll([.. running.Select(pair => pair.Key)], running.Max(pair => pair.Value)); }
        catch (AggregateException) { return running.All(pair => pair.Key.IsCompleted); }
    }

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
    private async Task<(ActionSubject? Subject, ActionError? Error)> ResolveAsync(SqlConnection connection, ObjectRefDto target, string action, string? newName, int band, int take, CancellationToken token)
    {
        var display = Display(target);
        var title = Title(target);
        var warnings = new List<ActionWarningDto>();
        var truncated = false;
        ScriptPreflight.Row? row = null;
        if (target.Kind == "login")
        {
            // The login's own rows only: the scans that count what it owns would wait behind other principals' changes. Delete reads
            // those past them afterwards (LoginDeleteFactsAsync).
            var (facts, loginRow) = await LoginAsync(connection, target.Name!, newName, null, token);
            if (facts is null) return (null, Error("NOT_FOUND", "The login " + display + " no longer exists. Refresh Object Explorer."));
            // The login by the name the catalog holds: the rules judged that principal, so the DDL names exactly it.
            return (new ActionSubject(target with { Name = loginRow!.Text("name") }, display, title, facts.Subtype, loginRow, warnings, false, facts), null);
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

    /// <summary>The login preflight in master: the login's facts, at most <paramref name="take"/> names of the databases it owns
    /// (ActionSql.Login), or with a null take nothing it owns (ActionSql.LoginAlter), and its row; null facts when no login of
    /// a listed type has the name.</summary>
    private async Task<(LoginFactsDto? Facts, ScriptPreflight.Row? Row)> LoginAsync(SqlConnection connection, string name, string? newName, int? take, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = take is null ? ActionSql.LoginAlter : ActionSql.Login;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, name);
        Add(command, "@new", SqlDbType.NVarChar, 128, newName);
        if (take is { } limit) Add(command, "@take", SqlDbType.Int, 0, limit);
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token)) return (null, null);
        var row = ReadRow(reader);
        var owned = new List<string>();
        if (await reader.NextResultAsync(token))
            while (await reader.ReadAsync(token)) owned.Add(reader.GetString(0));
        var type = row.Text("principal_type")?.Trim() ?? "";
        var principalId = row.Int("principal_id");
        // By the catalog's name, never the request's: the server collation finds "##x## " and a fullwidth ＃ spelling of
        // SQL Server's own ##x##, whose subtype the request's spelling would hide.
        var subtype = catalog.Logins.SubtypeOf(principalId, type, row.Text("name") ?? "");
        if (subtype is null) return (null, null);
        int? sessions = row.Long("sessions") is { } count ? (int)count : null;
        var created = DatabaseProperties.Iso(row.Raw("create_date")) ?? "";
        var facts = new LoginFactsDto(principalId, type, subtype, row.Bool("is_disabled"), row.Text("sid_hex") ?? "", created, row.NullableBool("policy_checked"), row.NullableBool("expiration_checked"),
            row.Bool("connect_denied"), row.Bool("is_own"), row.Bool("is_sysadmin"), sessions, take is null ? null : row.Int("owned_databases"), owned, take is null ? null : row.Int("owned_server_objects"), row.Bool("can_alter"),
            row.Bool("can_control_server"), row.Bool("name_in_use"), GrantedPermissions: take is null ? null : row.Int("granted_permissions"));
        return (facts, row);
    }

    /// <summary>The services that run as a Windows login (ActionSql.LoginService), joined, else the service an NT SERVICE\ name
    /// is; null when there is none. A failed read (no VIEW SERVER STATE, or a server without the view) is no answer.</summary>
    private async Task<string?> LoginServiceAsync(SqlConnection connection, string name, CancellationToken token)
    {
        var names = new List<string>();
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = ActionSql.LoginService;
            command.CommandTimeout = 0;
            Add(command, "@name", SqlDbType.NVarChar, 128, name);
            Add(command, "@take", SqlDbType.Int, 0, (int)catalog.Logins.Limit("serviceNames"));
            await using var reader = await command.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token)) if (!reader.IsDBNull(0) && reader.GetString(0) is { Length: > 0 } service) names.Add(service);
        }
        catch (SqlException) when (!token.IsCancellationRequested) { names.Clear(); }
        var text = names.Count > 0 ? string.Join(", ", names) : ServiceOfName(name);
        return text is null ? null : ScriptingErrors.Clip(text, (int)catalog.Logins.Limit("serviceName"));
    }

    /// <summary>The service a per-service SID login names (NT SERVICE\SQLSERVERAGENT is SQLSERVERAGENT), or null.</summary>
    internal static string? ServiceOfName(string name) =>
        name.StartsWith(@"NT SERVICE\", StringComparison.OrdinalIgnoreCase) && name.Length > 11 ? name[11..] : null;

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
    private ActionError? Refusal(ActionSubject subject, ActionArgs args, string? engine = null)
    {
        if (subject.Login is { } login) return LoginRefusal(login, args);
        var row = subject.Row;
        var system = subject.Target.Kind == "database" ? row.Bool("is_system") : row.Bool("is_ms_shipped");
        if (system) return Error("NOT_SUPPORTED", subject.Display + " belongs to SQL Server and cannot be " + (args.Action == "rename" ? "renamed." : "deleted."));
        if (!catalog.Allows(subject.Target.Kind, subject.Subtype, args.Action))
            return Error("NOT_SUPPORTED", (args.Action == "rename" ? "Rename" : "Delete") + " for this kind of " + subject.Title.ToLowerInvariant() + " is not supported yet.");
        if (args.Action == "rename" && subject.Target.Kind == "database") return DatabaseRenameRefusal(subject, args.NewName, args.Identity, args.CloseConnections == true, engine);
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

    /// <summary>A login action's refusal from the facts its preflight read: the protected-principal rules (permissions answer
    /// PERMISSION_DENIED, the rest NOT_SUPPORTED), then a rename's new name: a backslash in a SQL Server login's, or another
    /// principal's. First, a login the request's identity does not describe: the name now belongs to another principal, whose
    /// facts the user never saw (a confirmation's warnings were about the one it read).</summary>
    internal ActionError? LoginRefusal(LoginFactsDto login, ActionArgs args)
    {
        if (args.LoginIdentity is { } read && (!string.Equals(read.Sid, login.Sid, StringComparison.Ordinal) || !string.Equals(read.Created, login.Created, StringComparison.Ordinal)))
            return Error("NOT_FOUND", "The login " + ScriptingErrors.Display(args.Target.Name!) + " is not the one that was read: it was renamed, dropped or replaced since. Refresh Object Explorer and try again.");
        if (catalog.Logins.Refusal(login, args.Action) is { } refused)
            return Error(refused is "alterAnyLogin" or "controlServer" ? "PERMISSION_DENIED" : "NOT_SUPPORTED", catalog.Logins.Message(refused));
        if (args.Action != "rename") return null;
        if (catalog.Logins.NameRefusal(login.Subtype, args.NewName!) is { } name) return Error("NOT_SUPPORTED", catalog.Logins.Message(name));
        if (login.NameInUse) return Error("NAME_IN_USE", "The name " + ScriptingErrors.Display(args.NewName!) + " is already used by another login or server role.");
        return null;
    }

    /// <summary>A database rename's verdict (D3c), past the system and snapshot checks: a database other than the one the describe read
    /// (<paramref name="read"/>), a state the catalogue's rename rule greys (MODIFY NAME opens the database), an availability group
    /// (SQL Server refuses MODIFY NAME for its databases), the permission (can_rename: ALTER on it, or CONTROL SERVER or ownership,
    /// which HAS_PERMS_BY_NAME on the database denies while another session holds it SINGLE_USER), the new name taken, and closing the
    /// connections on Managed Instance, which cannot set SINGLE_USER.</summary>
    private ActionError? DatabaseRenameRefusal(ActionSubject subject, string? newName, DatabaseIdentityDto? read, bool closeConnections, string? engine)
    {
        var row = subject.Row;
        if (read is not null && (row.Int("database_id") != read.Id || DatabaseProperties.Iso(row.Raw("create_date")) != read.Created))
            return Error("NOT_FOUND", "The database " + subject.Display + " is not the one Object Explorer read: it was renamed, dropped or replaced since. Refresh Object Explorer and try again.");
        if (catalog.DatabaseRefusal("rename", row.Int("state"), row.Int("user_access"), row.Bool("is_read_only"), row.Bool("is_in_standby")) is { } reason) return Error("NOT_SUPPORTED", reason);
        if (row.Bool("in_availability_group")) return Error("NOT_SUPPORTED", "The database is in an availability group; remove it from the group to rename it.");
        if (!row.Bool("can_rename")) return Error("PERMISSION_DENIED", "You do not have permission to rename " + subject.Display + " (ALTER on it).");
        if (newName is not null && row.Bool("name_in_use")) return Error("NAME_IN_USE", "The name " + ScriptingErrors.Display(newName) + " is already in use by another database.");
        if (closeConnections && engine == "managedInstance") return Error("NOT_SUPPORTED", "Managed Instance cannot set SINGLE_USER, so Varia cannot close the connections. Rename when they are free instead.");
        return null;
    }

    /// <summary>sys.databases state of an offline database.</summary>
    internal const int OfflineState = 6;
    internal const string OfflineWarning = "This database is offline. Deleting it removes it from the server but leaves its files on disk.";
    internal const string SnapshotsWarning = "The database has database snapshots; the DROP fails until they are deleted.";
    /// <summary>Why Delete Object greys Close existing connections on Azure SQL Managed Instance.</summary>
    internal const string ManagedInstanceCloseNote = "Managed Instance cannot set SINGLE_USER.";
    /// <summary>Why it greys the option for an offline database: no session can be in it, and its Delete runs no SINGLE_USER (Plan).</summary>
    internal const string OfflineCloseNote = "An offline database has no connections to close.";
    /// <summary>The most query tabs Delete Object names as holding a transaction in the database (TransactionTabs).</summary>
    internal const int TransactionTabLimit = 1000;

    /// <summary>Why Delete Object greys Close existing connections, or null where it applies. A snapshot greys it by itself (isSnapshot).</summary>
    internal static string? CloseConnectionsNote(string engine, bool snapshot, bool offline) =>
        snapshot ? null : engine == "managedInstance" ? ManagedInstanceCloseNote : offline ? OfflineCloseNote : null;

    /// <summary>What a database's Delete plan needs from its row: whether it is offline, where no session can be (so no SINGLE_USER
    /// runs), and its user access (sys.databases user_access: 0 multi, 1 single, 2 restricted), which a failed DROP restores, as a failed
    /// detach does.</summary>
    internal sealed record DeleteFacts(bool Offline, int UserAccess);

    private static DeleteFacts? FactsOf(ActionSubject subject) =>
        subject.Target.Kind == "database" ? new(subject.Row.Int("state") == OfflineState, subject.Row.Int("user_access")) : null;

    /// <summary>Take Offline's, Bring Online's and Detach's verdict: a database other than the one the dialog read (<paramref name="read"/>),
    /// SQL Server's own, a snapshot, a state the catalogue's database rules grey the action in (as the menu does), and, for Take Offline
    /// and Bring Online, ALTER on it. Detach's permission is its own (DetachFactsAsync): DBCC DETACHDB refuses ALTER, CONTROL, ALTER
    /// ANY DATABASE and dbcreator alike (7983).</summary>
    private ActionError? StateRefusal(ActionSubject subject, string action, DatabaseIdentityDto? read)
    {
        var row = subject.Row;
        if (read is not null && (row.Int("database_id") != read.Id || DatabaseProperties.Iso(row.Raw("create_date")) != read.Created))
            return Error("NOT_FOUND", "The database " + subject.Display + " is not the one this dialog read: it was renamed, dropped or replaced since. Close the dialog and open it again.");
        var verb = action switch { "takeOffline" => "taken offline", "detach" => "detached", _ => "brought online" };
        if (row.Bool("is_system")) return Error("NOT_SUPPORTED", subject.Display + " belongs to SQL Server and cannot be " + verb + ".");
        if (!catalog.Allows(subject.Target.Kind, subject.Subtype, action)) return Error("NOT_SUPPORTED", "A database snapshot cannot be " + verb + ".");
        if (catalog.DatabaseRefusal(action, row.Int("state"), row.Int("user_access"), row.Bool("is_read_only"), row.Bool("is_in_standby")) is { } reason) return Error("NOT_SUPPORTED", reason);
        if (action != "detach" && !row.Bool("can_alter_state")) return Error("PERMISSION_DENIED", "You do not have permission to change the state of " + subject.Display + " (ALTER on it).");
        return null;
    }

    /// <summary>What blocks sp_detach_db besides StateRefusal (spec D3 §6): replication, a snapshot of the database, an availability
    /// group and mirroring, which SQL Server refuses too, as blocking warnings.</summary>
    internal static List<ActionWarningDto> DetachBlockers(ScriptPreflight.Row row)
    {
        var warnings = new List<ActionWarningDto>();
        if (row.Bool("replicated")) warnings.Add(new("The database is used for replication; it cannot be detached until replication is removed.", true));
        if (row.Bool("has_snapshots")) warnings.Add(new("A database snapshot of this database exists; drop the snapshot before you detach it.", true));
        if (row.Bool("in_availability_group")) warnings.Add(new("The database is in an availability group; remove it from the group before you detach it.", true));
        if (row.Bool("mirrored")) warnings.Add(new("The database is mirrored; remove mirroring before you detach it.", true));
        return warnings;
    }

    /// <summary>Detach's note on Linux for a database that is not online, where it is advice only (critic A27); <paramref name="words"/>
    /// come from DetachStateWords.</summary>
    public static string DetachStateNote(string words) => "This database is " + words + ". On Windows, SQL Server may restrict access to its files when it is detached "
        + (words == "offline" ? "offline" : "in this state") + "; bring it online first if you will attach it again.";
    public static readonly string DetachOfflineNote = DetachStateNote("offline");

    /// <summary>Detach's note on Windows for a SQL Server login (probed: files a SQL login detached stayed closed to a Windows
    /// administrator's attach, OS error 5, and opened to a SQL-authenticated one).</summary>
    public const string DetachSqlLoginNote = "You are connected with a SQL Server login. SQL Server then lets only its service account open the detached files, so "
        + "attaching them again with Windows authentication can fail with access denied; attach them with SQL Server authentication.";

    /// <summary>Detach's note when SQL Server showed this login none of the database's files (sys.master_files needs VIEW ANY
    /// DEFINITION, and a database that is not online cannot be read inside).</summary>
    public const string DetachFilesHiddenNote = "SQL Server did not show this login the database's files (that needs VIEW ANY DEFINITION), so they are not listed here; "
        + "note where they are before you detach it.";

    /// <summary>A database state's words in Detach's notes and refusals.</summary>
    internal string DetachStateWords(int state) => catalog.DatabaseStateOf(state) switch
    {
        "offline" => "offline",
        "emergency" => "in EMERGENCY mode",
        "offlineSecondary" => "an offline secondary",
        _ => "not online"
    };

    /// <summary>The box a database that is not online asks for on Windows (src/shared/actions/database.ts detachConfirmLabel).</summary>
    internal string DetachConfirmLabel(int state) => catalog.DatabaseStateOf(state) == "offline" ? "Detach while offline" : "Detach anyway";

    /// <summary>Why Update Statistics cannot run: sp_detach_db's sp_updatestats raises 15635 on a read-only, standby or EMERGENCY
    /// database (and SQL Server detaches it all the same), and 942 on an offline one, which aborts the detach.</summary>
    internal string? DetachStatisticsRefusal(ScriptPreflight.Row row) =>
        catalog.DatabaseStateOf(row.Int("state")) != "online" ? "Update Statistics cannot run while the database is " + DetachStateWords(row.Int("state")) + "; clear it."
        : row.Bool("is_read_only") || row.Bool("is_in_standby") ? "Update Statistics cannot run on a read-only or standby database; clear it."
        : null;

    /// <summary>Detach's verdict at execute: StateRefusal, the permission (DetachFactsAsync's <paramref name="permission"/>),
    /// DetachBlockers, Update Statistics where it cannot run, then a database that is not online on a Windows server without its
    /// box: SQL Server may leave its files with restricted access after the detach (critic A27; probed for OFFLINE and EMERGENCY).</summary>
    internal ActionError? DetachRefusal(ActionSubject subject, DatabaseIdentityDto? read, bool linux, bool detachOffline, bool updateStatistics = false, ActionError? permission = null)
    {
        if (StateRefusal(subject, "detach", read) is { } refused) return refused;
        if (permission is not null) return permission;
        if (DetachBlockers(subject.Row).FirstOrDefault() is { } blocker) return Error("NOT_SUPPORTED", blocker.Text);
        if (updateStatistics && DetachStatisticsRefusal(subject.Row) is { } statistics) return Error("NOT_SUPPORTED", statistics);
        if (NotOnlineOnWindows(subject.Row, linux) && !detachOffline)
            return Error("NOT_SUPPORTED", "The database " + subject.Display + " is " + DetachStateWords(subject.Row.Int("state")) + ". Bring it online first, or check "
                + DetachConfirmLabel(subject.Row.Int("state")) + ".");
        return null;
    }

    /// <summary>Detach's non-blocking notes over the preflight row: a database that is not online on Linux (critic A27 asks for the
    /// box on Windows instead), a SQL Server login on Windows, and files SQL Server did not show this login.</summary>
    internal List<ActionWarningDto> DetachNotes(ScriptPreflight.Row row, bool linux, bool filesHidden)
    {
        var notes = new List<ActionWarningDto>();
        if (linux && catalog.DatabaseStateOf(row.Int("state")) != "online") notes.Add(new(DetachStateNote(DetachStateWords(row.Int("state"))), false));
        if (!linux && row.Bool("sql_login")) notes.Add(new(DetachSqlLoginNote, false));
        if (filesHidden) notes.Add(new(DetachFilesHiddenNote, false));
        return notes;
    }

    private bool NotOnlineOnWindows(ScriptPreflight.Row row, bool linux) => !linux && catalog.DatabaseStateOf(row.Int("state")) != "online";

    /// <summary>The statements an action runs, in order. A database's Delete that closes connections first undoes SINGLE_USER when
    /// its DROP did not complete (D3 §8), and a Detach that closes them undoes it when sp_detach_db did not: each compensation restores
    /// the access <paramref name="facts"/> read (multi or restricted). An offline database has no sessions to close, so its Delete runs
    /// no SINGLE_USER. A database's rename that closes connections restores the access the same way (RenameDatabasePlan). A login's Delete with dropMappedUsers drops
    /// the mapped <paramref name="users"/> it may (not those Kept) first, each in its database, then the login (D4 §5.4), each DROP bound
    /// to the principal it was planned for (<paramref name="login"/>; the users by the login's SID). Script Action plans none: it runs nothing.</summary>
    public static List<PlannedStatement> Plan(ActionArgs args, ObjectRefDto target, DeleteFacts? facts = null, IReadOnlyList<MappedUserDto>? users = null, PrincipalBinding? login = null)
    {
        // A login's statements run in master, as SMO scripts them.
        if (target.Kind == "login")
            return args.Action switch
            {
                "rename" => [new(ActionTemplate.RenameLogin, "master", [target.Name!, args.NewName!])],
                "disable" => [new(ActionTemplate.DisableLogin, "master", [target.Name!])],
                "enable" => [new(ActionTemplate.EnableLogin, "master", [target.Name!])],
                "delete" => [.. (args.DropMappedUsers == true ? users ?? [] : []).Where(user => !Kept(user))
                        .Select(user => new PlannedStatement(ActionTemplate.DropMappedUser, user.Database, [user.User], Principal: login is null ? null : new(login.Sid))),
                    new(ActionTemplate.DropLogin, "master", [target.Name!], Principal: login)],
                _ => throw new InvalidOperationException("No plan for a login's " + args.Action + ".")
            };
        if (args.Action == "detach") return DetachPlan(target.Name!, args.DropConnections == true, args.UpdateStatistics == true, facts?.UserAccess ?? 0);
        // SSMS's Take Offline rolls other connections back only when Drop All Active Connections is checked; without it SET OFFLINE
        // waits for them to leave until Stop.
        if (args.Action == "takeOffline") return [new(args.DropConnections == true ? ActionTemplate.SetOfflineRollback : ActionTemplate.SetOffline, "master", [target.Name!])];
        if (args.Action == "bringOnline") return [new(ActionTemplate.SetOnline, "master", [target.Name!])];
        if (args.Action == "rename" && target.Kind != "database") return [new(ActionTemplate.RenameObject, target.Database!, [target.Schema!, target.Name!, args.NewName!])];
        if (args.Action == "rename") return RenameDatabasePlan(target.Name!, args.NewName!, args.CloseConnections == true, facts?.UserAccess ?? 0);
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

    /// <summary>A database's rename (D3c, spec 7). Closing the connections is SINGLE_USER WITH ROLLBACK IMMEDIATE on the action's own
    /// connection, which keeps the database until MODIFY NAME (critic A12), and then the original access back under the new name.
    /// The compensations put the access back where the database is: under the old name when the rename failed or was stopped, under the
    /// new one when only the restore did not complete. A database already in SINGLE_USER keeps it, so it has nothing to restore: setting
    /// it again would wait for a session that holds the database, and MODIFY NAME alone fails with 924 while one does (probed on 2025),
    /// which the describe refuses first.</summary>
    internal static List<PlannedStatement> RenameDatabasePlan(string name, string newName, bool closeConnections, int userAccess)
    {
        var rename = new PlannedStatement(ActionTemplate.RenameDatabase, "master", [name, newName]);
        if (!closeConnections || userAccess == 1) return [rename];
        var restore = userAccess == 2 ? ActionTemplate.SetRestrictedUser : ActionTemplate.SetMultiUser;
        return
        [
            new(ActionTemplate.SetSingleUser, "master", [name]),
            rename,
            new(restore, "master", [newName]),
            new(restore, "master", [name], StepKind.Compensation, 0, statuses => statuses[1] != "done"),
            new(restore, "master", [newName], StepKind.Compensation, 0, statuses => statuses[1] == "done" && statuses[2] != "done")
        ];
    }

    /// <summary>SSMS's Detach: Drop Connections sets SINGLE_USER WITH ROLLBACK IMMEDIATE first (as SSMS does whether or not sessions
    /// remain), then sp_detach_db, with @skipchecks from Update Statistics. When the detach fails or is stopped after SINGLE_USER,
    /// Varia gives the database back the access it had (owner decision): MULTI_USER, or RESTRICTED_USER; a database that was
    /// SINGLE_USER already is left so. Attach (D1d) can share the compensation (RestoreAccess).</summary>
    internal static List<PlannedStatement> DetachPlan(string database, bool dropConnections, bool updateStatistics, int userAccess)
    {
        var plan = new List<PlannedStatement>();
        if (dropConnections) plan.Add(new(ActionTemplate.SetSingleUser, "master", [database]));
        plan.Add(ActionSql.Detach(database, updateStatistics));
        if (dropConnections && RestoreAccess(database, userAccess, 0) is { } restore) plan.Add(restore);
        return plan;
    }

    /// <summary>The compensation that restores a database's access after main step <paramref name="undoes"/> set SINGLE_USER: SET
    /// MULTI_USER, or SET RESTRICTED_USER for a database that was restricted, or none for one that was single-user already.</summary>
    internal static PlannedStatement? RestoreAccess(string database, int userAccess, int undoes) => ActionsCatalog.DatabaseAccessOf(userAccess) switch
    {
        "single" => null,
        "restricted" => new(ActionTemplate.SetRestrictedUser, "master", [database], StepKind.Compensation, undoes),
        _ => new(ActionTemplate.SetMultiUser, "master", [database], StepKind.Compensation, undoes)
    };

    /// <summary>A step's title in the reply (at most 64 characters).</summary>
    internal static string StepTitle(ActionTemplate template) => template switch
    {
        ActionTemplate.DeleteBackupHistory => "Delete backup and restore history",
        ActionTemplate.SetSingleUser => "Close existing connections",
        ActionTemplate.DropDatabase => "Drop the database",
        ActionTemplate.RenameDatabase or ActionTemplate.RenameObject or ActionTemplate.RenameLogin => "Rename",
        ActionTemplate.SetMultiUser => "Restore multi-user access",
        ActionTemplate.SetRestrictedUser => "Restore restricted user access",
        ActionTemplate.DetachDatabase => "Detach the database",
        ActionTemplate.DisableLogin => "Disable the login",
        ActionTemplate.EnableLogin => "Enable the login",
        ActionTemplate.DenyConnect => "Deny permission to connect",
        ActionTemplate.GrantConnect => "Grant permission to connect",
        ActionTemplate.DropUser or ActionTemplate.DropMappedUser => "Drop the database user",
        ActionTemplate.DropLogin => "Drop the login",
        ActionTemplate.DropRestoring => "Remove the partly restored database",
        ActionTemplate.AddServerRoleMember => "Add to a server role",
        ActionTemplate.CreateUserForLogin => "Create a user",
        ActionTemplate.AlterUserSchema => "Set the default schema",
        ActionTemplate.CreateSchemaFor => "Create a schema",
        ActionTemplate.AddRoleMember => "Add to a database role",
        ActionTemplate.SetOffline => "Take database offline",
        ActionTemplate.SetOfflineRollback => "Close connections and take database offline",
        ActionTemplate.SetOnline => "Bring database online",
        _ => "Drop the object"
    };

    /// <summary>The templates whose statement needs its database (the first name) free of Varia's own idle sessions (critic A5).</summary>
    private static bool NeedsFreeDatabase(ActionTemplate template) => template is ActionTemplate.SetSingleUser or ActionTemplate.DropDatabase or ActionTemplate.RenameDatabase
        or ActionTemplate.DetachDatabase or ActionTemplate.SetOffline or ActionTemplate.SetOfflineRollback;

    /// <summary>Runs planned statements through runner v2 on the action's connection. Before the first main statement that needs
    /// a database to itself, the connection's own pools leave it (FreeDatabaseAsync), inside that step, so Stop reaches it.
    /// sp_detach_db can fail and still detach: sp_updatestats' 15635 (read-only, standby or EMERGENCY) does not abort it, and a Stop
    /// can answer after DBCC DETACHDB finished. So a failed or stopped detach whose database is gone is done, with SQL Server's
    /// errors kept in <paramref name="messages"/>, and no compensation runs on a database that no longer exists.</summary>
    private async Task<RunOutcome> RunPlannedAsync(SqlConnection connection, string connectionId, string action, IReadOnlyList<PlannedStatement> plan, string? inUseAdvice, CancellationToken token,
        ActionProgress? progress = null, MessageLog? messages = null)
    {
        var freed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // A database rename that does not close the connections waits for them (Rename When Free).
        var closes = plan.Any(statement => statement.Template == ActionTemplate.SetSingleUser);
        var steps = plan.Select(ActionSql.Checked).Select(statement => new RunStep(StepTitle(statement.Template), async context =>
        {
            if (statement.Kind == StepKind.Main && NeedsFreeDatabase(statement.Template) && freed.Add(statement.Names[0]))
                await FreeDatabaseAsync(connection, connectionId, statement.Names[0], context.Token);
            try
            {
                if (statement.Template == ActionTemplate.RenameDatabase && !closes)
                    await WhileLockedAsync(() => RunStatementAsync(connection, statement, dryRun: false, context.Token, context.Transaction), LockedByOthers, Options.RenameRetryDelay, context.Token);
                else await RunStatementAsync(connection, statement, dryRun: false, context.Token, context.Transaction);
            }
            catch (Exception error) when (statement is { Template: ActionTemplate.DetachDatabase, Kind: StepKind.Main } && error is SqlException or OperationCanceledException)
            {
                if (!await DatabaseGoneAsync(connection, statement.Names[0], CleanupBudget(action))) throw;
                if (error is SqlException sql) foreach (SqlError item in sql.Errors) { if (item.Class > 10) messages?.Note(item.Message); }
                else messages?.Note("Stop came after SQL Server had detached the database.");
            }
        }, statement.Kind, statement.Undoes, statement.When, StepDetail(statement))).ToList();
        return await RunStepsAsync(connection, steps, inUseAdvice, token, CleanupBudget(action), progress: progress);
    }

    /// <summary>Whether a database is gone from sys.databases (ActionSql.DatabaseAccess), read under a fresh budget because a Stop
    /// may have cancelled the job's token; false when the read fails, so the step's own failure stands.</summary>
    private static async Task<bool> DatabaseGoneAsync(SqlConnection connection, string database, TimeSpan budget)
    {
        using var source = new CancellationTokenSource(budget);
        try
        {
            if (connection.State != ConnectionState.Open) return false;
            await using var command = connection.CreateCommand();
            command.CommandText = ActionSql.DatabaseAccess;
            command.CommandTimeout = 0;
            Add(command, "@name", SqlDbType.NVarChar, 128, database);
            await using var reader = await command.ExecuteReaderAsync(source.Token);
            return !await reader.ReadAsync(source.Token);
        }
        catch (Exception error) when (error is SqlException or OperationCanceledException or InvalidOperationException) { return false; }
    }

    /// <summary>Runs <paramref name="run"/> until it completes, trying again after <paramref name="delay"/> each time it fails as
    /// <paramref name="locked"/> says, until <paramref name="token"/> is cancelled. Rename When Free promises a wait that Stop ends:
    /// SQL Server 2025 queues MODIFY NAME behind the other sessions in the database (LCK_M_X, probed), while earlier versions are
    /// recalled to refuse it at once with 5030, so there the rename tries again until they have gone. A refusal that comes after Stop
    /// (the delay and Stop can end on one timer tick, so the next try runs under a cancelled token) is the Stop, not IN_USE.</summary>
    internal static async Task WhileLockedAsync(Func<Task> run, Func<Exception, bool> locked, TimeSpan delay, CancellationToken token)
    {
        while (true)
        {
            try { await run(); return; }
            catch (Exception error) when (locked(error)) { token.ThrowIfCancellationRequested(); }
            await Task.Delay(delay, token);
        }
    }

    /// <summary>SQL Server could not lock the database exclusively because other sessions use it (5030).</summary>
    internal static bool LockedByOthers(Exception error) => error is SqlException { Number: 5030 };

    /// <summary>Frees a database of the backend's own sessions (critic A5): the server-scope pools of every connection to the server
    /// move to master when it is their database (host.FreeDatabase) and their idle pools in it are cleared; then, for up to FreeWait,
    /// the action counts the sessions of this process still in it that the backend's pooled connections were given
    /// (host.PoolSessions), which the server ends a moment after a clear. Query tabs are the user's own. True when it cleared a pool.</summary>
    private async Task<bool> FreeDatabaseAsync(SqlConnection connection, string connectionId, string database, CancellationToken token)
    {
        if (!host.FreeDatabase(connectionId, database)) return false;
        var watch = Stopwatch.StartNew();
        while (true)
        {
            var left = await PoolSessionsInAsync(connection, connectionId, database, token);
            if (left == 0 || watch.Elapsed >= Options.FreeWait) return true;
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
            var (steps, failure, _) = await RunPlannedAsync(connection, connectionId, action, plan, null, job, messages: messages);
            return new ActionExecuteResult(steps, messages.Collected(), watch.ElapsedMilliseconds, failure);
        }, error => new ActionExecuteResult([], [], watch.ElapsedMilliseconds, error));
    }

    /// <summary>The live checks' only way to run steps of their own (a scratch BACKUP with STATS) through the action path as a long
    /// action's steps will run: the engine gate, the registry, the action's gates (the long gate for a long action), its connection
    /// and prologue, Stop, runner v2 with progress, and the shutdown drain. Not reachable from the wire, which asks only for catalogue
    /// actions and never carries SQL.</summary>
    internal Task<ActionExecuteResult> ExecuteStepsAsync(string connectionId, string requestId, string action, Func<SqlConnection, IReadOnlyList<RunStep>> plan, Action<object>? events,
        CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var progress = new ActionProgress(events, Options.ProgressInterval);
        return RunAsync(connectionId, requestId, action, read: false, null, token, async (connection, profile, band, job) =>
        {
            var messages = CollectMessages(connection, progress);
            var (steps, failure, _) = await RunStepsAsync(connection, plan(connection), null, job, CleanupBudget(action), progress: progress);
            return new ActionExecuteResult(steps, messages.Collected(), watch.ElapsedMilliseconds, failure);
        }, error => new ActionExecuteResult([], [], watch.ElapsedMilliseconds, error));
    }

    // --- Jobs -------------------------------------------------------------------------------------------------------------

    private async Task<ActionDescribeResult> DescribeJobAsync(SqlConnection connection, string connectionId, string engine, ObjectRefDto target, string action, int band, CancellationToken token)
    {
        if (target.Kind == "login") return await DescribeLoginDeleteAsync(connection, target, token);
        var (subject, error) = await ResolveAsync(connection, target, action, null, band, (int)catalog.Limit("dependents") + 1, token);
        if (subject is null) return new(null, 0, error);
        var row = subject.Row;
        var owner = row.Name("owner_name") is { Length: > 0 } name ? ScriptingErrors.Display(name) : null;
        if (target.Kind != "database") return new(new DeleteTargetDto(subject.Display, subject.Title, owner, subject.Warnings, subject.Truncated), 0);
        var snapshot = row.Bool("is_snapshot");
        int? sessions = null, withTransaction = null;
        List<BlockerDto>? blockers = null;
        var more = false;
        List<string>? tabs = null;
        // Database's count is null without VIEW SERVER STATE, and the transaction DMVs are read only when it is not (ActionSql.InTransaction).
        if (row.Long("sessions") is not null)
        {
            try
            {
                (sessions, withTransaction) = await DatabaseUseAsync(connection, target.Name!, token);
                (blockers, more) = await BlockersAsync(connection, connectionId, target.Name!, token);
                tabs = await TransactionTabsAsync(connection, connectionId, target.Name!, token);
            }
            // VIEW SERVER STATE with VIEW SERVER PERFORMANCE STATE denied (2022 and later): unknown, as without the permission.
            catch (SqlException denied) when (denied.Number == 300 && !token.IsCancellationRequested)
            {
                (sessions, withTransaction, blockers, more, tabs) = (null, null, null, false, null);
            }
        }
        var note = CloseConnectionsNote(engine, snapshot, row.Int("state") == OfflineState);
        var deleted = new DeleteTargetDto(subject.Display, snapshot ? "Database Snapshot" : subject.Title, owner, subject.Warnings, subject.Truncated, snapshot, sessions,
            withTransaction, blockers, blockers is null ? null : more, note, tabs);
        return new(deleted, 0);
    }

    /// <summary>The loginFacts describe: the login preflight's facts (no owned database names) and, for a Windows login, the
    /// services that run as it, which the Disable prompt names.</summary>
    private async Task<ActionDescribeResult> DescribeLoginJobAsync(SqlConnection connection, ObjectRefDto target, CancellationToken token)
    {
        // Behind another session's uncommitted change to the login (D4 P8), a READ COMMITTED read of its row would wait out the
        // lock timeout before Disable could even ask; the facts only advise, and the execute preflight reads them again.
        await RunAsync(connection, ActionSql.FactsIsolation, token);
        var (facts, row) = await LoginAsync(connection, target.Name!, null, 0, token);
        if (facts is null) return new(null, 0, Error("NOT_FOUND", "The login " + Display(target) + " no longer exists. Refresh Object Explorer."));
        var service = facts.Type == "U" ? await LoginServiceAsync(connection, row!.Text("name") ?? target.Name!, token) : null;
        return new(null, 0, Login: facts with { Service = service });
    }

    /// <summary>The sessions using the database and those with an open transaction there (ActionSql.DatabaseUse).</summary>
    private static async Task<(int? Sessions, int? WithTransaction)> DatabaseUseAsync(SqlConnection connection, string database, CancellationToken token)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = ActionSql.DatabaseUse;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, database);
        await using var reader = await command.ExecuteReaderAsync(token);
        if (!await reader.ReadAsync(token)) return (null, null);
        int? Count(int ordinal) => reader.IsDBNull(ordinal) ? null : Convert.ToInt32(reader.GetValue(ordinal), System.Globalization.CultureInfo.InvariantCulture);
        return (Count(0), Count(1));
    }

    /// <summary>The sessions in the database Delete Object lists (ActionSql.DatabaseUseSessions), at most the catalogue's blockers, leaving
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
        command.CommandText = ActionSql.DatabaseUseSessions;
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

    /// <summary>The query tabs (their session ids) whose session has an open transaction in the database or holds one while in it
    /// (ActionSql.TransactionSessions), at most TransactionTabLimit: Delete Object names them (A7), whatever database each tab is in.</summary>
    private async Task<List<string>> TransactionTabsAsync(SqlConnection connection, string connectionId, string database, CancellationToken token)
    {
        var tabs = host.QueryTabs(connectionId);
        var named = new List<string>();
        if (tabs.Count == 0) return named;
        await using var command = connection.CreateCommand();
        command.CommandText = ActionSql.TransactionSessions;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, database);
        Add(command, "@pid", SqlDbType.Int, 0, Environment.ProcessId);
        // A few more than the tabs: another session of this process (a pool's, mid-transaction) may sort before them.
        Add(command, "@take", SqlDbType.Int, 0, Math.Min(tabs.Count, TransactionTabLimit) + 64);
        await using var reader = await command.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token) && named.Count < TransactionTabLimit)
            if (tabs.TryGetValue(Convert.ToInt32(reader.GetValue(0), System.Globalization.CultureInfo.InvariantCulture), out var tab)) named.Add(tab);
        return named;
    }

    private async Task<ActionScriptResult> ScriptJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, CancellationToken token)
    {
        if (target.Kind == "login" && args.Action == "delete") return await ScriptLoginDeleteAsync(connection, args, target, token);
        var database = ScriptDatabase(target);
        var (subject, error) = await ResolveAsync(connection, target, args.Action, args.NewName, band, (int)catalog.Limit("dependents") + 1, token);
        if (subject is null) return new(null, database, [], error);
        var text = (args.Action == "detach" && args.UpdateStatistics == false ? DetachSkipChecksComment : "") + ScriptText(Plan(args, subject.Target, FactsOf(subject)));
        if (text.Length > ScriptLimit(args.Action)) return new(null, database, [], Error("SQL_ERROR", "The script is too large."));
        return new(text, database, [.. subject.Warnings.Take(8).Select(warning => warning.Text)]);
    }

    /// <summary>SSMS's script leaves @skipchecks out when Update Statistics is cleared, so sp_detach_db's default runs UPDATE STATISTICS
    /// anyway; Varia writes 'true' so the script does what the dialog does (owner decision, D3 spec §6). It names no object.</summary>
    internal static string DetachSkipChecksComment => "-- Update Statistics is cleared: @skipchecks = 'true' skips UPDATE STATISTICS (SSMS's script leaves it out)." + ActionSql.NL;

    /// <summary>Script Action's text of a plan: its main statements only, as a success runs them. Compensation and cleanup run only
    /// after a failure or Stop, so they are never scripted.</summary>
    internal static string ScriptText(IEnumerable<PlannedStatement> plan) =>
        string.Concat(plan.Where(statement => statement.Kind == StepKind.Main).Select(ActionSql.Checked).Select(ActionSql.ScriptText));

    private async Task<ActionExecuteResult> ExecuteJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, string engine, int band, ActionProgress progress, CancellationToken token)
    {
        if (target.Kind == "login" && args.Action == "delete") return await ExecuteLoginDeleteAsync(connection, args, target, band, token);
        var messages = CollectMessages(connection, progress);
        var (subject, error) = await ResolveAsync(connection, target, args.Action, args.NewName, band, 0, token);
        if (subject is null) return new([], [], 0, error);
        var state = args.Action is "takeOffline" or "bringOnline";
        if ((state ? StateRefusal(subject, args.Action, args.Identity) : Refusal(subject, args, engine)) is { } refused) return new([], [], 0, refused);
        var plan = Plan(args, subject.Target, FactsOf(subject));
        // The backend's own pools leave the database before the first statement that needs it to itself (RunPlannedAsync).
        var inUseAdvice = target.Kind != "database" ? null : args.Action == "delete" ? ActionErrors.CloseConnectionsAdvice
            : args.Action == "rename" ? RenameInUseAdvice(subject.Row.Int("user_access")) : null;
        var (steps, failure, done) = await RunPlannedAsync(connection, args.ConnectionId, args.Action, plan, inUseAdvice, token, progress);
        // The database's new name, or its absence, from now on: a connection opened in it must not keep asking for it. An offline
        // database keeps its name, so its connections keep it too and fail until it is back online, as in SSMS.
        var changed = plan.Where(statement => statement.Kind == StepKind.Main).Take(done).Any(statement => statement.Template is ActionTemplate.DropDatabase or ActionTemplate.RenameDatabase);
        if (changed) host.DatabaseChanged(args.ConnectionId, target.Name!, args.Action == "rename" ? args.NewName : null);
        // SQL Server gives a renamed database a new create_date (sys.databases: "created or renamed"), so the documents that follow it
        // need its identity under the new name, or Database Properties' Apply would refuse it as another database.
        var identity = changed && args.Action == "rename" && target.Kind == "database" ? await RenamedIdentityAsync(connection, args.NewName!, subject.Row.Int("database_id")) : null;
        var collected = messages.Collected();
        // SET ONLINE keeps the access a database was left in (SINGLE_USER set while it was offline stays), which SSMS does not say.
        // It takes the last place when SQL Server's messages fill the list (main refuses more than infoMessages).
        if (args.Action == "bringOnline" && failure is null && await AccessNoteAsync(connection, target.Name!) is { } note)
        {
            if (collected.Count >= catalog.Limit("infoMessages")) collected.RemoveAt(collected.Count - 1);
            collected.Add(note);
        }
        // 15151 says "does not exist or you do not have permission"; for a login the preflight found, it is the permission.
        if (subject.Login is not null && failure is { Code: "PERMISSION_DENIED" }) failure = Error(failure.Code, failure.Message + " " + ActionErrors.LoginPermissionAdvice);
        return new(steps, collected, 0, failure, Identity: identity, Sessions: subject.Login?.Sessions);
    }

    /// <summary>A renamed database's identity under its new name, read in the action's connection just after MODIFY NAME, or null when it
    /// cannot be read or the name now belongs to another database (<paramref name="id"/> is the one the preflight read). MODIFY NAME has
    /// completed, so like the access note it has a budget of its own (AccessNoteBudget), not the request's token.</summary>
    private async Task<DatabaseIdentityDto?> RenamedIdentityAsync(SqlConnection connection, string newName, int id)
    {
        using var budget = new CancellationTokenSource(Options.AccessNoteBudget);
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = ActionSql.DatabaseIdentity;
            command.CommandTimeout = 0;
            Add(command, "@name", SqlDbType.NVarChar, 128, newName);
            await using var reader = await command.ExecuteReaderAsync(budget.Token);
            if (!await reader.ReadAsync(budget.Token)) return null;
            var row = ReadRow(reader);
            return row.Int("database_id") == id && DatabaseProperties.Iso(row.Raw("create_date")) is { } created ? new(id, created) : null;
        }
        catch (Exception error) when (error is OperationCanceledException or SqlException or InvalidOperationException) { return null; }
    }

    /// <summary>What a database rename's IN_USE failure advises: a SINGLE_USER database's holder must go (924); otherwise the
    /// connections must close (SET SINGLE_USER WITH ROLLBACK IMMEDIATE that could not complete, or 5030).</summary>
    internal static string RenameInUseAdvice(int userAccess) => userAccess == 1 ? SingleUserAdvice : RenameCloseAdvice;
    internal const string RenameCloseAdvice = "Close its connections, or rename it when they disconnect.";

    /// <summary>What a database brought online still restricts: SINGLE_USER or RESTRICTED_USER access, or null. SET ONLINE has
    /// completed, so a Stop that arrives now, or a read that fails, must not make the success a failure: the note has a budget of
    /// its own (AccessNoteBudget), not the request's token, and is left out when it cannot be read.</summary>
    private async Task<string?> AccessNoteAsync(SqlConnection connection, string database)
    {
        using var budget = new CancellationTokenSource(Options.AccessNoteBudget);
        try
        {
            await using var command = connection.CreateCommand();
            command.CommandText = ActionSql.DatabaseAccess;
            command.CommandTimeout = 0;
            Add(command, "@name", SqlDbType.NVarChar, 128, database);
            await using var reader = await command.ExecuteReaderAsync(budget.Token);
            if (!await reader.ReadAsync(budget.Token)) return null;
            return ActionsCatalog.DatabaseAccessOf(ReadRow(reader).Int("user_access")) switch
            {
                "single" => "The database is online in SINGLE_USER mode: only one connection at a time can use it.",
                "restricted" => "The database is online in RESTRICTED_USER mode: only members of db_owner, dbcreator and sysadmin can use it.",
                _ => null
            };
        }
        catch (Exception error) when (error is OperationCanceledException or SqlException or InvalidOperationException) { return null; }
    }

    /// <summary>Take Database Offline's and Bring Database Online's model: the database's identity and state, the preflight's
    /// verdict, what blocks SET OFFLINE, and the sessions in it (VIEW SERVER STATE); their open transactions are what WITH ROLLBACK
    /// IMMEDIATE rolls back (critic A7). The backend's own idle pooled connections are no one's work: as SET OFFLINE does, Take
    /// Offline's describe first frees the database of them (spec 3.6) and reads it again, then lists every session left, this
    /// process's query windows included. No session is left out by its id, which SQL Server gives the next client once a cleared
    /// pool's session has ended.</summary>
    private async Task<ActionDescribeResult> DescribeStateJobAsync(SqlConnection connection, string connectionId, ObjectRefDto target, string action, int band, CancellationToken token,
        bool linux = false)
    {
        var (subject, error) = await ResolveAsync(connection, target, action, null, band, 0, token);
        if (subject is null) return new(null, 0, error);
        if (StateRefusal(subject, action, null) is { } refused) return new(null, 0, refused);
        List<DatabaseFileRefDto>? files = null;
        bool? filesTruncated = null, confirmOffline = null;
        if (action == "detach")
        {
            (var permission, files, var more) = await DetachFactsAsync(connection, subject, token);
            if (permission is not null) return new(null, 0, permission);
            filesTruncated = more;
        }
        if (action is "takeOffline" or "detach" && subject.Row.Long("sessions") > 0 && await FreeDatabaseAsync(connection, connectionId, target.Name!, token))
        {
            (subject, error) = await ResolveAsync(connection, target, action, null, band, 0, token);
            if (subject is null) return new(null, 0, error);
            if (StateRefusal(subject, action, null) is { } changed) return new(null, 0, changed);
        }
        var row = subject.Row;
        var warnings = new List<ActionWarningDto>();
        if (action == "takeOffline")
        {
            if (row.Bool("in_availability_group")) warnings.Add(new("The database is in an availability group; SET OFFLINE fails until it is removed from the group.", true));
            if (row.Bool("mirrored")) warnings.Add(new("The database is mirrored; SET OFFLINE fails until mirroring is removed.", true));
        }
        if (action == "detach")
        {
            warnings.AddRange(DetachBlockers(row));
            // A database that is not online on Windows waits for its box (critic A27); on Linux the dialog only says so (DetachNotes).
            if (NotOnlineOnWindows(row, linux)) confirmOffline = true;
            warnings.AddRange(DetachNotes(row, linux, filesHidden: files is { Count: 0 }));
        }
        int? sessions = row.Long("sessions") is { } count ? (int)count : null;
        int? withTransaction = row.Long("with_transaction") is { } open ? (int)open : null;
        var list = new List<DatabaseSessionDto>();
        if (sessions is not null)
        {
            var limit = (int)catalog.Limit("sessions");
            var chars = (int)catalog.Limit("sessionText");
            await using var command = connection.CreateCommand();
            command.CommandText = ActionSql.DatabaseSessions;
            command.CommandTimeout = 0;
            Add(command, "@name", SqlDbType.NVarChar, 128, target.Name);
            Add(command, "@take", SqlDbType.Int, 0, limit);
            await using var reader = await command.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token))
            {
                var session = ReadRow(reader);
                string? Clip(string name) => session.Text(name) is { Length: > 0 } text ? ScriptingErrors.Detail(text, chars) : null;
                list.Add(new(session.Int("session_id"), Clip("login_name"), Clip("program_name"), Clip("host_name"), session.Int("open_transactions")));
            }
            // Sessions that came between the count and the list leave the counts as the list found them at least.
            sessions = Math.Max(sessions.Value, list.Count);
            withTransaction = Math.Max(withTransaction ?? 0, list.Count(session => session.OpenTransactions > 0));
        }
        var identity = new DatabaseIdentityDto(row.Int("database_id"), DatabaseProperties.Iso(row.Raw("create_date")) ?? "");
        var model = new DatabaseStateDto(subject.Display, identity, row.Int("state"), row.Int("user_access"), row.Bool("is_read_only"), row.Bool("is_in_standby"), sessions, withTransaction,
            list, sessions is { } total && total > list.Count, warnings, files, filesTruncated, confirmOffline);
        return new(null, 0, DatabaseState: model);
    }

    /// <summary>What a database's rename reads first (D3c, spec 7): the preflight's verdict for a rename, then, as Take Offline's describe
    /// does, the database freed of the backend's own idle pooled sessions and read again when it had sessions (they are no one's work,
    /// and the rename frees it of them itself), the sessions left and those with open transactions (critic A7), and the logins whose
    /// default database it is. The renderer asks before closing anyone's connections.</summary>
    private async Task<ActionDescribeResult> DescribeRenameJobAsync(SqlConnection connection, string connectionId, ObjectRefDto target, string engine, int band, CancellationToken token)
    {
        var (subject, error) = await ResolveAsync(connection, target, "rename", null, band, 0, token);
        if (subject is null) return new(null, 0, error);
        var probe = new ActionArgs("rename", connectionId, Guid.Empty.ToString(), target);
        if (Refusal(subject, probe, engine) is { } refused) return new(null, 0, refused);
        if (subject.Row.Long("sessions") > 0 && await FreeDatabaseAsync(connection, connectionId, target.Name!, token))
        {
            (subject, error) = await ResolveAsync(connection, target, "rename", null, band, 0, token);
            if (subject is null) return new(null, 0, error);
            if (Refusal(subject, probe, engine) is { } changed) return new(null, 0, changed);
        }
        var row = subject.Row;
        var logins = 0;
        // Through a reader, as every action statement runs (tests/action-reader-lint.test.ts).
        await using (var command = connection.CreateCommand())
        {
            command.CommandText = ActionSql.LoginsDefaulting;
            command.CommandTimeout = 0;
            Add(command, "@name", SqlDbType.NVarChar, 128, target.Name);
            await using var reader = await command.ExecuteReaderAsync(token);
            if (await reader.ReadAsync(token)) logins = reader.GetInt32(0);
        }
        int? sessions = row.Long("sessions") is { } count ? (int)count : null;
        int? withTransaction = row.Long("with_transaction") is { } open ? (int)open : null;
        var userAccess = row.Int("user_access");
        // Another session holds a SINGLE_USER database: MODIFY NAME fails with 924, and SET SINGLE_USER WITH ROLLBACK IMMEDIATE waits for
        // it rather than closing it (both probed on 2025), so neither button could rename it.
        if (userAccess == 1 && sessions > 0) return new(null, 0, Error("IN_USE", subject.Display + " is in single-user mode and another session is using it. " + SingleUserAdvice));
        var identity = new DatabaseIdentityDto(row.Int("database_id"), DatabaseProperties.Iso(row.Raw("create_date")) ?? "");
        var connections = host.SameServer(connectionId).Take((int)catalog.Limit("serverConnections")).ToList();
        return new(null, 0, RenameDatabase: new(subject.Display, identity, userAccess, sessions, withTransaction, logins, engine != "managedInstance" && userAccess != 1, connections));
    }

    /// <summary>What to do about a session that holds a single-user database a rename needs (924).</summary>
    internal const string SingleUserAdvice = "That session must disconnect, or be ended in Activity Monitor, before the database can be renamed.";

    /// <summary>The files a detach leaves on the server (ActionSql.DatabaseFiles), at most the catalogue's detachFiles, and whether
    /// there were more.</summary>
    private async Task<(List<DatabaseFileRefDto> Files, bool Truncated)> FilesAsync(SqlConnection connection, string database, CancellationToken token)
    {
        var limit = (int)catalog.Limit("detachFiles");
        var rows = new List<ScriptPreflight.Row>();
        await using var command = connection.CreateCommand();
        command.CommandText = ActionSql.DatabaseFiles;
        command.CommandTimeout = 0;
        Add(command, "@name", SqlDbType.NVarChar, 128, database);
        Add(command, "@take", SqlDbType.Int, 0, limit + 1);
        await using var reader = await command.ExecuteReaderAsync(token);
        while (rows.Count <= limit && await reader.ReadAsync(token)) rows.Add(ReadRow(reader));
        return FilesOf(rows);
    }

    /// <summary>File rows (file_id, file_name, file_type, physical_name) as the reply carries them, at most the catalogue's
    /// detachFiles; names and paths clipped to the catalogue's bounds (sysname, filePath).</summary>
    private (List<DatabaseFileRefDto> Files, bool Truncated) FilesOf(IReadOnlyList<ScriptPreflight.Row> rows)
    {
        var limit = (int)catalog.Limit("detachFiles");
        var path = (int)catalog.Limit("filePath");
        var files = rows.Take(limit).Select(file => new DatabaseFileRefDto(file.Int("file_id"), ScriptingErrors.Clip(file.Name("file_name"), 128),
            file.Int("file_type") switch { 1 => "log", 2 => "filestream", _ => "rows" }, ScriptingErrors.Clip(file.Name("physical_name"), path))).ToList();
        return (files, rows.Count > limit);
    }

    /// <summary>Detach's permission and the files it leaves on the server. sysadmin and the owner may detach (the preflight's
    /// can_detach); otherwise only a member of the online database's db_owner role, read inside it (ActionSql.DetachInside), which
    /// also lists the files when sys.master_files showed this login none. Permission is null when this login may detach, so a
    /// login SQL Server would refuse with 7983 is refused before SINGLE_USER rolls anyone back.</summary>
    private async Task<(ActionError? Permission, List<DatabaseFileRefDto> Files, bool Truncated)> DetachFactsAsync(SqlConnection connection, ActionSubject subject, CancellationToken token)
    {
        var database = subject.Target.Name!;
        var (files, more) = await FilesAsync(connection, database, token);
        var may = subject.Row.Bool("can_detach");
        ActionError? unread = null;
        if (catalog.DatabaseStateOf(subject.Row.Int("state")) == "online" && (!may || files.Count == 0))
        {
            try
            {
                var (sets, missing) = await InsideAsync(connection, database, ActionSql.DetachInside, null, null, null, (int)catalog.Limit("detachFiles") + 1, token);
                if (missing is not null) return (missing, files, more);
                if (sets is [[var role], var inside, ..])
                {
                    may |= role.Bool("db_owner");
                    if (files.Count == 0) (files, more) = FilesOf(inside);
                }
            }
            // No user in the database (916) leaves sysadmin and the owner; another failure, such as a SINGLE_USER database another
            // session holds, is SQL Server's answer when nothing else says this login may detach.
            catch (SqlException error) when (!token.IsCancellationRequested)
            {
                if (!may && error.Number is not (916 or 4060)) unread = ActionErrors.FromSql(catalog, error, connection, ddl: false, null);
            }
        }
        return (may ? null : unread ?? Error("PERMISSION_DENIED", "You do not have permission to detach " + subject.Display + ": that needs its db_owner role, or sysadmin."), files, more);
    }

    /// <summary>Detach Database (spec D3 §6): the preflight, the permission and the files the database has (DetachFactsAsync) and
    /// DetachRefusal, then SINGLE_USER (with Drop Connections), sp_detach_db and, after a failure or Stop past SINGLE_USER, the access
    /// it had (DetachPlan). Once detached (RunPlannedAsync counts a failed or stopped sp_detach_db whose database is gone), the
    /// connection forgets the name, as for a dropped database, and the reply lists the files left on the server.</summary>
    private async Task<ActionExecuteResult> ExecuteDetachJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, bool linux, int band, CancellationToken token)
    {
        var messages = CollectMessages(connection);
        var (subject, error) = await ResolveAsync(connection, target, "detach", null, band, 0, token);
        if (subject is null) return new([], [], 0, error);
        if (StateRefusal(subject, "detach", args.Identity) is { } stale) return new([], [], 0, stale);
        var (permission, files, _) = await DetachFactsAsync(connection, subject, token);
        if (DetachRefusal(subject, args.Identity, linux, args.DetachOffline == true, args.UpdateStatistics == true, permission) is { } refused) return new([], [], 0, refused);
        var plan = Plan(args, target, FactsOf(subject));
        var (steps, failure, done) = await RunPlannedAsync(connection, args.ConnectionId, args.Action, plan, ActionErrors.DropConnectionsAdvice, token, messages: messages);
        var detached = plan.Where(statement => statement.Kind == StepKind.Main).Take(done).Any(statement => statement.Template == ActionTemplate.DetachDatabase);
        if (detached) host.DatabaseChanged(args.ConnectionId, target.Name!, null);
        return new(steps, messages.Collected(), 0, failure, FilesKept: detached ? files : null);
    }

    /// <summary>SQL Server's informational messages (severity 10 and below), such as sp_rename's caution, bounded, and the notes an
    /// action adds (a detach's errors once the database was detached all the same). A long step's progress messages (3211) go to
    /// the request's ActionProgress instead and never count toward the kept ones.</summary>
    internal sealed class MessageLog(int max, int chars, ActionProgress? progress)
    {
        private readonly List<string> messages = [];
        public void Add(SqlError item) => Add(item.Class, item.Number, item.Message);
        internal void Add(byte severity, int number, string message)
        {
            if (severity > 10) return;
            if (number == ActionProgress.StatsMessage) { progress?.Observe(number, message); return; }
            Note(message);
        }
        public void Note(string text) { lock (messages) if (messages.Count < max) messages.Add(ScriptingErrors.Clip(text, chars)); }
        public List<string> Collected() { lock (messages) return [.. messages]; }
    }

    internal MessageLog CollectMessages(SqlConnection connection, ActionProgress? progress = null)
    {
        var log = new MessageLog((int)catalog.Limit("infoMessages"), (int)catalog.Limit("infoMessageChars"), progress);
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

    private async Task<ActionExecuteResult> ExecutePropertiesJobAsync(SqlConnection connection, ActionArgs args, ObjectRefDto target, int band, ActionProgress progress, CancellationToken token)
    {
        var messages = CollectMessages(connection, progress);
        // The backend's own idle pooled connections in the database must not hold it (SET options WITH NO_WAIT, COLLATE), nor
        // count as other connections in the preflight.
        var cleared = host.FreeDatabase(args.ConnectionId, target.Name!);
        var (plan, error) = await PlanPropertiesAsync(connection, args, target, band, execute: true, token, cleared);
        if (plan is null) return new([], [], 0, error);
        // Choosing Yes helps only where the dialog asks: an exclusive change made without closing connections. Other
        // changes that need the database to themselves (Broker Enabled, Containment type, COLLATE) are never asked about.
        var advice = args.CloseConnections != true && Exclusive(args.Changes!) ? ActionErrors.OpenConnectionsAdvice : ActionErrors.OtherConnectionsAdvice;
        var (steps, failure, _) = await RunStepsAsync(connection, [.. plan.Select(statement => new RunStep(statement.Title, context => RunAlterAsync(connection, statement, dryRun: false, context.Token)))],
            advice, token, CleanupBudget(args.Action), progress: progress);
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
        return await ReadAllAsync(command, token);
    }

    /// <summary>Test seam: called with the command once its reader has reported the statement's end, before ReadAllAsync asks whether
    /// its token fired meanwhile. Only the live checks set it, to Stop there as SqlClient's rare silent cancel looks, which no server
    /// does on demand.</summary>
    internal static Action<SqlCommand>? ReaderEnded { get; set; }

    /// <summary>Runs an action's statement and reads every result set's values (text). Always a reader, never ExecuteNonQueryAsync:
    /// SqlClient's async non-query path holds every info message until the statement ends (probed), which would hold a long step's
    /// 3211 progress (ActionProgress) until it is done; the live progress check guards this.
    /// The token never reaches SqlClient: StatementStop sends the cancel (see there). A statement whose token fired before its reader
    /// reported the end is stopped, never done: SqlClient now and then ends a cancelled statement's reader as if it had finished and
    /// raises nothing (SqlService's batch loop meets the same), and the statement may also have finished just as Stop came; either
    /// way the runner lists it cancelled, and a compensation's Confirm or the restore's reads of the server say what it left.</summary>
    internal static async Task<List<string?>> ReadAllAsync(SqlCommand command, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        var connection = command.Connection;
        var stop = new StatementStop(command, token);
        connection.InfoMessage += stop.OnMessage;
        try
        {
            using var registration = token.UnsafeRegister(static state => ((StatementStop)state!).FromOtherThread(), stop);
            var values = new List<string?>();
            await using var reader = await command.ExecuteReaderAsync(CancellationToken.None);
            do
            {
                while (await reader.ReadAsync(CancellationToken.None))
                    for (var i = 0; i < reader.FieldCount; i++) values.Add(reader.IsDBNull(i) ? null : reader.GetString(i));
            } while (await reader.NextResultAsync(CancellationToken.None));
            ReaderEnded?.Invoke(command);
            if (token.IsCancellationRequested) throw new OperationCanceledException(token);
            return values;
        }
        finally { connection.InfoMessage -= stop.OnMessage; }
    }

    /// <summary>How a Stop reaches a running action statement. Once the statement has sent an info message (a RESTORE's STATS),
    /// SqlClient's cancel from another thread waits until the statement ends (probed: a RESTORE stopped at 5 percent ran to
    /// 100 and its attention went out only then), while from the reader's own thread, inside the message, it goes out at once;
    /// and the two together deadlock (the other thread holds the connection, the reader the parser). So before any message
    /// the Stop cancels from its own thread; after one, the reader cancels at the next message, and if none comes within
    /// <see cref="Fallback"/>, the Stop's thread cancels after all (it may then wait until the statement ends, as before),
    /// and the reader leaves it to that one. Either side cancels at most once. A statement a Stop cancelled ends in a
    /// SqlException, or now and then in a reader SqlClient ends silently (ReadAllAsync then throws), which the runner reads as
    /// cancelled because the token is.</summary>
    internal sealed class StatementStop(SqlCommand command, CancellationToken token)
    {
        internal static TimeSpan Fallback { get; set; } = TimeSpan.FromSeconds(1);
        private readonly object gate = new();
        private bool streaming, sent;

        public void OnMessage(object sender, SqlInfoMessageEventArgs e)
        {
            lock (gate)
            {
                streaming = true;
                if (!token.IsCancellationRequested || sent) return;
                sent = true;
            }
            Cancel();
        }

        public void FromOtherThread()
        {
            lock (gate)
            {
                if (sent) return;
                if (streaming)
                {
                    _ = Task.Delay(Fallback).ContinueWith(static (_, state) => ((StatementStop)state!).Late(), this, CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
                    return;
                }
                sent = true;
            }
            Cancel();
        }

        private void Late()
        {
            lock (gate)
            {
                if (sent) return;
                sent = true;
            }
            Cancel();
        }

        private void Cancel()
        {
            try { command.Cancel(); }
            catch (Exception error) when (error is InvalidOperationException or SqlException) { /* Best effort: the statement may have ended. */ }
        }
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
        // A guarded DROP never runs by its name alone (the dry run selects the DROP and binds nothing).
        if (ActionSql.Guarded(statement.Template) && !dryRun)
        {
            var bound = statement.Principal ?? throw new InvalidOperationException("A guarded DROP needs the principal it was planned for.");
            Add(command, "@sid", SqlDbType.VarBinary, 85, bound.Sid);
            if (statement.Template == ActionTemplate.DropLogin)
            {
                Add(command, "@principal", SqlDbType.Int, 0, bound.PrincipalId!.Value);
                Add(command, "@created", SqlDbType.DateTime, 0, bound.Created!.Value);
            }
        }
        return await ReadAllAsync(command, token);
    }

    /// <summary>The live checks' only way to see what an executable batch would run: SQL Server builds the statement from the
    /// parameters and selects it. Not reachable from the wire, which can never ask the backend to skip or alter DDL.</summary>
    internal async Task<List<string?>> DryRunAsync(string connectionId, PlannedStatement statement, CancellationToken token)
    {
        await using var connection = host.Connection(connectionId);
        await host.OpenAsync(connection, token);
        return await RunStatementAsync(connection, statement, dryRun: true, token);
    }

    /// <summary>The live checks' only way to list with SQL Server 2016's statements on a newer server, or under another catalogue's
    /// limits (a smaller browseEntries), on a connection of its own. Not reachable from the wire.</summary>
    internal async Task<(ServerFilesDto? Listing, ActionError? Error)> ListServerFilesAsync(string connectionId, ServerFilesArgsDto files, bool legacy, ActionsCatalog? limits, CancellationToken token)
    {
        await using var connection = host.Connection(connectionId);
        await host.OpenAsync(connection, token);
        await RunAsync(connection, ActionSql.ReadPrologue, token);
        return await ServerFiles.ListAsync(connection, limits ?? catalog, files, host.Profile(connectionId).Linux, token, legacy);
    }

    /// <summary>Cancels a disconnected connection's requests and drops its gates.</summary>
    public void Forget(string connectionId)
    {
        running.Forget(connectionId);
        readGates.TryRemove(connectionId, out _);
        executeGates.TryRemove(connectionId, out _);
        longGates.TryRemove(connectionId, out _);
        browseGates.TryRemove(connectionId, out _);
        restoreGates.TryRemove(connectionId, out _);
    }

    public void CancelAll() => running.ForgetAll();

    public void Dispose()
    {
        running.ForgetAll();
        readGates.Clear();
        executeGates.Clear();
        longGates.Clear();
        browseGates.Clear();
        restoreGates.Clear();
    }
}
