using System.Text.Json;

namespace Varia.Backend.Actions;

/// <summary>One Object Explorer kind and subtype ('' for none) with the actions it offers enabled and greyed.</summary>
internal sealed record ActionRow(string Kind, string Subtype, IReadOnlyList<string> Enabled, IReadOnlyList<string> Disabled);

/// <summary>How a database option is written (src/shared/actions/database.ts' OptionSql): 'set' with its keyword, '= ',
/// the SQL text per token, SMO's termination and " SECONDS"; 'scoped' with its configuration name and secondary form; and
/// 'compat', 'collate', 'autoCreateStats', 'snapshotIsolation' and 'filestream', which have their own forms.</summary>
internal sealed record OptionSqlJson(string Kind, string? Keyword = null, bool? Eq = null, Dictionary<string, string>? Tokens = null, bool? Termination = null, bool? Seconds = null,
    string? Name = null, bool? Secondary = null);
internal sealed record RangeJson(long Min, long Max);
/// <summary>A database option or scoped configuration as the catalogue resolves it for C#.</summary>
internal sealed record OptionJson(string Key, string Label, string Control, bool Settable, int SmoOrder, List<string>? Tokens = null, RangeJson? Range = null, int? Since = null, List<string>? NotOn = null,
    bool? Exclusive = null, OptionSqlJson? Sql = null, bool? RefusedReadOnly = null);

/// <summary>Object actions as src/shared/actions/catalog.ts declares them, embedded as actions-catalog.json (a vitest file
/// snapshot keeps the copy in sync): which kinds and subtypes offer Select Top, Rename, Delete and Properties, the dialogs
/// and the action each runs, Database Properties' options, error retryability and limits. C# holds no rules of its own
/// about which objects an action may touch or how an option is written.</summary>
internal sealed class ActionsCatalog
{
    public const int Version = 2;

    private static readonly Lazy<ActionsCatalog> Embedded = new(() =>
    {
        using var stream = typeof(ActionsCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Actions.actions-catalog.json")
            ?? throw new InvalidOperationException("The object actions catalogue is missing from the backend build.");
        return Parse(stream);
    });

    private sealed record ActionJson(string Action, string Class, string Title, bool? SystemObjects = null);
    private sealed record DialogJson(string Dialog, string Action, List<string> Pages);
    private sealed record ErrorJson(string Code, bool Retryable);
    private sealed record RowJson(string Kind, string Subtype, List<string> Enabled, List<string> Disabled);
    private sealed record CatalogJson(int Version, List<ActionJson> Actions, List<int> CompatibilityLevels, List<OptionJson> DatabaseOptions, List<DialogJson> Dialogs, List<ErrorJson> Errors,
        Dictionary<string, long> Limits, List<string> OwnerNotOn, List<RowJson> Rows, List<OptionJson> ScopedConfigurations);

    private readonly Dictionary<(string Kind, string Subtype), ActionRow> rows;
    private readonly Dictionary<string, bool> errors;
    private readonly Dictionary<string, string> dialogActions;
    private readonly HashSet<string> systemActions;

    private ActionsCatalog(CatalogJson json)
    {
        if (json.Version != Version) throw new InvalidOperationException("Unsupported object actions catalogue version.");
        rows = json.Rows.ToDictionary(row => (row.Kind, row.Subtype), row => new ActionRow(row.Kind, row.Subtype, row.Enabled, row.Disabled));
        errors = json.Errors.ToDictionary(row => row.Code, row => row.Retryable, StringComparer.Ordinal);
        Actions = [.. json.Actions.Select(row => row.Action)];
        systemActions = json.Actions.Where(row => row.SystemObjects == true).Select(row => row.Action).ToHashSet(StringComparer.Ordinal);
        Dialogs = json.Dialogs.ToDictionary(row => row.Dialog, row => (IReadOnlyList<string>)row.Pages, StringComparer.Ordinal);
        dialogActions = json.Dialogs.ToDictionary(row => row.Dialog, row => row.Action, StringComparer.Ordinal);
        Limits = json.Limits;
        DatabaseOptions = json.DatabaseOptions.ToDictionary(row => row.Key, StringComparer.Ordinal);
        ScopedConfigurations = json.ScopedConfigurations.ToDictionary(row => row.Key, StringComparer.Ordinal);
        CompatibilityLevels = json.CompatibilityLevels;
        OwnerNotOn = json.OwnerNotOn;
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

    /// <summary>The action a dialog's OK runs (deleteObject: delete, databaseProperties: properties).</summary>
    public string ActionOf(string dialog) => dialogActions.TryGetValue(dialog, out var action) ? action : throw new InvalidOperationException("Unknown dialog " + dialog);

    /// <summary>Whether the action also serves SQL Server's own objects (Properties on master, model, msdb and tempdb).</summary>
    public bool ServesSystemObjects(string action) => systemActions.Contains(action);

    /// <summary>The row of a kind and subtype ('' or null for none), or null when the kind offers no actions.</summary>
    public ActionRow? Row(string kind, string? subtype) => rows.GetValueOrDefault((kind, subtype ?? ""));

    /// <summary>Whether some row of the kind enables the action: what Validate checks before the preflight derives the subtype.</summary>
    public bool Offered(string kind, string action) => rows.Values.Any(row => row.Kind == kind && row.Enabled.Contains(action));

    /// <summary>Whether the derived subtype's row enables the action now.</summary>
    public bool Allows(string kind, string subtype, string action) => (Row(kind, subtype) ?? Row(kind, "")) is { } row && row.Enabled.Contains(action);

    public bool Retryable(string code) => errors.TryGetValue(code, out var retryable) ? retryable : throw new InvalidOperationException("Unknown object action error " + code);

    public long Limit(string key) => Limits.TryGetValue(key, out var value) ? value : throw new InvalidOperationException("Unknown object action limit " + key);
}
