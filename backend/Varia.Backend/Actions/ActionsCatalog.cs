using System.Text.Json;

namespace Varia.Backend.Actions;

/// <summary>One Object Explorer kind and subtype ('' for none) with the actions it offers enabled and greyed.</summary>
internal sealed record ActionRow(string Kind, string Subtype, IReadOnlyList<string> Enabled, IReadOnlyList<string> Disabled);

/// <summary>Object actions as src/shared/actions/catalog.ts declares them, embedded as actions-catalog.json (a vitest file
/// snapshot keeps the copy in sync): which kinds and subtypes offer Select Top, Rename and Delete, the dialogs, error
/// retryability and limits. C# holds no rules of its own about which objects an action may touch.</summary>
internal sealed class ActionsCatalog
{
    private static readonly Lazy<ActionsCatalog> Embedded = new(() =>
    {
        using var stream = typeof(ActionsCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Actions.actions-catalog.json")
            ?? throw new InvalidOperationException("The object actions catalogue is missing from the backend build.");
        return Parse(stream);
    });

    private sealed record ActionJson(string Action, string Class, string Title);
    private sealed record DialogJson(string Dialog, List<string> Pages);
    private sealed record ErrorJson(string Code, bool Retryable);
    private sealed record RowJson(string Kind, string Subtype, List<string> Enabled, List<string> Disabled);
    private sealed record CatalogJson(int Version, List<ActionJson> Actions, List<DialogJson> Dialogs, List<ErrorJson> Errors, Dictionary<string, long> Limits, List<RowJson> Rows);

    private readonly Dictionary<(string Kind, string Subtype), ActionRow> rows;
    private readonly Dictionary<string, bool> errors;

    private ActionsCatalog(CatalogJson json)
    {
        if (json.Version != 1) throw new InvalidOperationException("Unsupported object actions catalogue version.");
        rows = json.Rows.ToDictionary(row => (row.Kind, row.Subtype), row => new ActionRow(row.Kind, row.Subtype, row.Enabled, row.Disabled));
        errors = json.Errors.ToDictionary(row => row.Code, row => row.Retryable, StringComparer.Ordinal);
        Actions = [.. json.Actions.Select(row => row.Action)];
        Dialogs = json.Dialogs.ToDictionary(row => row.Dialog, row => (IReadOnlyList<string>)row.Pages, StringComparer.Ordinal);
        Limits = json.Limits;
    }

    public static ActionsCatalog Current => Embedded.Value;

    public static ActionsCatalog Parse(Stream stream) => new(JsonSerializer.Deserialize<CatalogJson>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
        ?? throw new InvalidOperationException("The object actions catalogue is empty."));

    public IReadOnlyList<string> Actions { get; }
    public IReadOnlyDictionary<string, IReadOnlyList<string>> Dialogs { get; }
    public IReadOnlyDictionary<string, long> Limits { get; }
    public IEnumerable<ActionRow> Rows => rows.Values;
    public IEnumerable<string> ErrorCodes => errors.Keys;

    /// <summary>The row of a kind and subtype ('' or null for none), or null when the kind offers no actions.</summary>
    public ActionRow? Row(string kind, string? subtype) => rows.GetValueOrDefault((kind, subtype ?? ""));

    /// <summary>Whether some row of the kind enables the action: what Validate checks before the preflight derives the subtype.</summary>
    public bool Offered(string kind, string action) => rows.Values.Any(row => row.Kind == kind && row.Enabled.Contains(action));

    /// <summary>Whether the derived subtype's row enables the action now.</summary>
    public bool Allows(string kind, string subtype, string action) => (Row(kind, subtype) ?? Row(kind, "")) is { } row && row.Enabled.Contains(action);

    public bool Retryable(string code) => errors.TryGetValue(code, out var retryable) ? retryable : throw new InvalidOperationException("Unknown object action error " + code);

    public long Limit(string key) => Limits.TryGetValue(key, out var value) ? value : throw new InvalidOperationException("Unknown object action limit " + key);
}
