using System.Text.Json;

namespace Varia.Backend.Actions;

/// <summary>One Object Explorer kind and subtype ('' for none) with the actions it offers enabled and greyed; with a
/// <c>Status</c>, the row a node with that status badge gets (the catalogue's status overlay applied).</summary>
internal sealed record ActionRow(string Kind, string Subtype, IReadOnlyList<string> Enabled, IReadOnlyList<string> Disabled, string Status = "");

/// <summary>How a database option is written (src/shared/actions/database.ts' OptionSql): 'set' with its keyword, '= ',
/// the SQL text per token, SMO's termination and " SECONDS"; 'scoped' with its configuration name and secondary form; and
/// 'compat', 'collate', 'autoCreateStats', 'snapshotIsolation' and 'filestream', which have their own forms.</summary>
internal sealed record OptionSqlJson(string Kind, string? Keyword = null, bool? Eq = null, Dictionary<string, string>? Tokens = null, bool? Termination = null, bool? Seconds = null,
    string? Name = null, bool? Secondary = null);
internal sealed record RangeJson(long Min, long Max);
/// <summary>The restore block of actions-catalog.json (src/shared/actions/restore.ts restoreCatalog()).</summary>
internal sealed record RestoreCatalogJson(string Describe, List<string> Requests, List<string> Engines, Dictionary<string, long> Limits, List<string> SystemDatabases, List<string> SourceKinds,
    List<string> RecoveryStates, List<string> FilesSetTypes, Dictionary<string, string> Messages, Dictionary<string, string> Steps)
{
    /// <summary>A run step's title (restoreStepTitles), shared with the document's step list.</summary>
    public string Step(string key) => Steps.TryGetValue(key, out var value) ? value : throw new InvalidOperationException("Unknown restore step " + key);
    public long Limit(string key) => Limits.TryGetValue(key, out var value) ? value : throw new InvalidOperationException("Unknown restore limit " + key);
    public string Message(string key) => Messages.TryGetValue(key, out var value) ? value : throw new InvalidOperationException("Unknown restore message " + key);
}
/// <summary>A database option or scoped configuration as the catalogue resolves it for C#.</summary>
internal sealed record OptionJson(string Key, string Label, string Control, bool Settable, int SmoOrder, List<string>? Tokens = null, RangeJson? Range = null, int? Since = null, List<string>? NotOn = null,
    bool? Exclusive = null, OptionSqlJson? Sql = null, bool? RefusedReadOnly = null);

/// <summary>Object actions as src/shared/actions/catalog.ts declares them, embedded as actions-catalog.json (a vitest file
/// snapshot keeps the copy in sync): which kinds and subtypes offer Select Top, Rename, Delete and Properties, the dialogs
/// and the action each runs, Database Properties' options, error retryability and limits. C# holds no rules of its own
/// about which objects an action may touch or how an option is written.</summary>
internal sealed class ActionsCatalog
{
    public const int Version = 4;

    private static readonly Lazy<ActionsCatalog> Embedded = new(() =>
    {
        using var stream = typeof(ActionsCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Actions.actions-catalog.json")
            ?? throw new InvalidOperationException("The object actions catalogue is missing from the backend build.");
        return Parse(stream);
    });

    private sealed record ActionJson(string Action, string Class, string Title, List<string> Engines, long CleanupMs, bool? SystemObjects = null, string? Folder = null, string? Scope = null, bool? Long = null);
    private sealed record DialogJson(string Dialog, string Action, List<string> Pages);
    private sealed record ErrorJson(string Code, bool Retryable);
    private sealed record RowJson(string Kind, string Subtype, List<string> Enabled, List<string> Disabled, string? Status = null);
    /// <summary>A database rule (src/shared/actions/catalog.ts DatabaseActionRule): states and access by name, as databaseStates names them.</summary>
    private sealed record DatabaseRuleJson(string Action, string Reason, List<string>? States = null, List<string>? Access = null, bool? ReadOnly = null, bool? Hide = null);
    private sealed record ServerFilesJson(string Purpose, List<string> Extensions);
    private sealed record CatalogJson(int Version, List<ActionJson> Actions, List<int> CompatibilityLevels, List<OptionJson> DatabaseOptions, List<DatabaseRuleJson> DatabaseRules,
        Dictionary<string, string> DatabaseStates, List<DialogJson> Dialogs, List<ErrorJson> Errors, Dictionary<string, long> Limits, LoginRulesJson Logins, List<string> OwnerNotOn,
        RestoreCatalogJson Restore, List<RowJson> Rows, List<OptionJson> ScopedConfigurations, List<ServerFilesJson> ServerFiles);

    private readonly Dictionary<(string Kind, string Subtype, string Status), ActionRow> rows;
    private readonly Dictionary<string, bool> errors;
    private readonly Dictionary<string, string> dialogActions;
    private readonly HashSet<string> systemActions;
    private readonly HashSet<string> serverActions;
    private readonly Dictionary<string, ActionJson> actions;
    private readonly List<DatabaseRuleJson> databaseRules;
    private readonly Dictionary<int, string> databaseStates;

    private ActionsCatalog(CatalogJson json)
    {
        if (json.Version != Version) throw new InvalidOperationException("Unsupported object actions catalogue version.");
        rows = json.Rows.ToDictionary(row => (row.Kind, row.Subtype, row.Status ?? ""), row => new ActionRow(row.Kind, row.Subtype, row.Enabled, row.Disabled, row.Status ?? ""));
        errors = json.Errors.ToDictionary(row => row.Code, row => row.Retryable, StringComparer.Ordinal);
        Actions = [.. json.Actions.Select(row => row.Action)];
        actions = json.Actions.ToDictionary(row => row.Action, StringComparer.Ordinal);
        Logins = new LoginRules(json.Logins);
        Restore = json.Restore;
        systemActions = json.Actions.Where(row => row.SystemObjects == true).Select(row => row.Action).ToHashSet(StringComparer.Ordinal);
        serverActions = json.Actions.Where(row => row.Scope == "server").Select(row => row.Action).ToHashSet(StringComparer.Ordinal);
        Dialogs = json.Dialogs.ToDictionary(row => row.Dialog, row => (IReadOnlyList<string>)row.Pages, StringComparer.Ordinal);
        dialogActions = json.Dialogs.ToDictionary(row => row.Dialog, row => row.Action, StringComparer.Ordinal);
        Limits = json.Limits;
        DatabaseOptions = json.DatabaseOptions.ToDictionary(row => row.Key, StringComparer.Ordinal);
        ScopedConfigurations = json.ScopedConfigurations.ToDictionary(row => row.Key, StringComparer.Ordinal);
        CompatibilityLevels = json.CompatibilityLevels;
        OwnerNotOn = json.OwnerNotOn;
        databaseRules = json.DatabaseRules;
        databaseStates = json.DatabaseStates.ToDictionary(pair => int.Parse(pair.Key, System.Globalization.CultureInfo.InvariantCulture), pair => pair.Value);
        ServerFilePurposes = json.ServerFiles.ToDictionary(row => row.Purpose, row => (IReadOnlyList<string>)row.Extensions, StringComparer.Ordinal);
    }

    public static ActionsCatalog Current => Embedded.Value;

    public static ActionsCatalog Parse(Stream stream) => new(JsonSerializer.Deserialize<CatalogJson>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
        ?? throw new InvalidOperationException("The object actions catalogue is empty."));

    public IReadOnlyList<string> Actions { get; }
    public IReadOnlyDictionary<string, IReadOnlyList<string>> Dialogs { get; }
    public IReadOnlyDictionary<string, long> Limits { get; }
    public IEnumerable<ActionRow> Rows => rows.Values;
    public IEnumerable<string> ErrorCodes => errors.Keys;
    /// <summary>Database Properties' options by key (the Options page's rows but the scoped configurations).</summary>
    public IReadOnlyDictionary<string, OptionJson> DatabaseOptions { get; }
    /// <summary>The Database Scoped Configurations rows by key.</summary>
    public IReadOnlyDictionary<string, OptionJson> ScopedConfigurations { get; }
    /// <summary>Every compatibility level the dialog can offer, from SQL Server 2008's 100.</summary>
    public IReadOnlyList<int> CompatibilityLevels { get; }
    /// <summary>System databases whose owner SQL Server keeps.</summary>
    public IReadOnlyList<string> OwnerNotOn { get; }
    /// <summary>The server file picker's purposes and the lower-case extensions each one's type filter keeps (none: folders only).</summary>
    public IReadOnlyDictionary<string, IReadOnlyList<string>> ServerFilePurposes { get; }

    /// <summary>Login subtypes, protected-principal rules and login limits (src/shared/actions/logins.ts).</summary>
    public LoginRules Logins { get; }
    /// <summary>Restore Database's describe id, request action, engines, limits, system databases and messages (src/shared/actions/restore.ts).</summary>
    public RestoreCatalogJson Restore { get; }

    /// <summary>Whether the action runs on a server of this engine (ExplorerProfile.ServerEngine).</summary>
    public bool Serves(string action, string engine) => actions.TryGetValue(action, out var row) ? row.Engines.Contains(engine) : throw new InvalidOperationException("Unknown object action " + action);

    /// <summary>Whether the action is a long job (restore, verify, backup): its DDL takes the long gate, reports 3211 progress and
    /// is waited for when the backend shuts down. The table designer's createTable is not a catalogue action, so never long.</summary>
    public bool IsLong(string action) => actions.TryGetValue(action, out var row) && row.Long == true;

    /// <summary>How long the action's compensation and cleanup steps may run after a failure or Stop.</summary>
    public TimeSpan CleanupBudget(string action) => TimeSpan.FromMilliseconds(actions.TryGetValue(action, out var row) ? row.CleanupMs : Limit("cleanupMs"));

    /// <summary>The action a dialog's OK runs (deleteObject: delete, databaseProperties: properties).</summary>
    public string ActionOf(string dialog) => dialogActions.TryGetValue(dialog, out var action) ? action : throw new InvalidOperationException("Unknown dialog " + dialog);

    /// <summary>The Object Explorer folder a folder action (Attach: databases) is offered on, whose server is its target; null for an object row's action.</summary>
    public string? FolderOf(string action) => actions.TryGetValue(action, out var row) ? row.Folder : throw new InvalidOperationException("Unknown object action " + action);

    /// <summary>Whether the action is a server action (New Database): no row offers it, and its describe's target is the server.</summary>
    public bool IsServerAction(string action) => serverActions.Contains(action);

    /// <summary>Whether the action also serves SQL Server's own objects (Properties on master, model, msdb and tempdb).</summary>
    public bool ServesSystemObjects(string action) => systemActions.Contains(action);

    /// <summary>The row of a kind and subtype ('' or null for none), or null when the kind offers no actions. With a status
    /// the kind has an overlay for, that status's row; another status leaves the subtype's row, as in the catalogue.</summary>
    public ActionRow? Row(string kind, string? subtype, string? status = null) =>
        (string.IsNullOrEmpty(status) ? null : rows.GetValueOrDefault((kind, subtype ?? "", status))) ?? rows.GetValueOrDefault((kind, subtype ?? "", ""));

    /// <summary>Whether some row of the kind, a status's included, enables the action: what Validate checks before the
    /// preflight derives the subtype.</summary>
    public bool Offered(string kind, string action) => rows.Values.Any(row => row.Kind == kind && row.Enabled.Contains(action));

    /// <summary>Whether the derived subtype's row enables the action now. It reads the row without a status: the preflights
    /// that derive a status (a disabled login) arrive with the actions that need them.</summary>
    public bool Allows(string kind, string subtype, string action) => (Row(kind, subtype) ?? Row(kind, "")) is { } row && row.Enabled.Contains(action);

    /// <summary>sys.databases.state by the catalogue's name ('other' for a value it does not know).</summary>
    public string DatabaseStateOf(int state) => databaseStates.TryGetValue(state, out var name) ? name : "other";

    /// <summary>sys.databases.user_access by name.</summary>
    public static string DatabaseAccessOf(int userAccess) => userAccess == 1 ? "single" : userAccess == 2 ? "restricted" : "multi";

    /// <summary>Why the database rules grey or hide an action for a database in this runtime state (the first rule that applies,
    /// as the menu derives it in databaseActionState), or null when none does.</summary>
    public string? DatabaseRefusal(string action, int state, int userAccess, bool readOnly, bool standby)
    {
        var stateName = DatabaseStateOf(state);
        var access = DatabaseAccessOf(userAccess);
        return databaseRules.FirstOrDefault(rule => rule.Action == action
            && (rule.States?.Contains(stateName) == true || rule.Access?.Contains(access) == true || rule.ReadOnly == true && (readOnly || standby)))?.Reason;
    }

    public bool Retryable(string code) => errors.TryGetValue(code, out var retryable) ? retryable : throw new InvalidOperationException("Unknown object action error " + code);

    public long Limit(string key) => Limits.TryGetValue(key, out var value) ? value : throw new InvalidOperationException("Unknown object action limit " + key);
}
