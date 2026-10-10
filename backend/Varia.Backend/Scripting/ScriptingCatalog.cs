using System.Text.Json;

namespace Varia.Backend.Scripting;

internal enum ScriptVerb { Create, Alter, CreateOrAlter, Drop, DropAndCreate, Select, Insert, Update, Delete, Execute }

/// <summary>DDL verbs run SMO's Scripter; DML and EXECUTE verbs are SSMS's templates over the preflight's rows.</summary>
internal enum VerbClass { Ddl, Dml, Execute }

/// <summary>One Object Explorer kind and subtype ('' for none), resolved: phase "later" rows offer nothing.</summary>
internal sealed record ScriptTargetRow(string Kind, string Subtype, string Phase, string Title, string Urn, string Preflight, IReadOnlyList<string> ObjectTypes,
    IReadOnlyList<string> Parents, IReadOnlyList<string> Enabled, IReadOnlyList<string> Disabled, bool Modifiable)
{
    public bool Scriptable => Phase == "pr5";
}

internal sealed record ScriptVerbRow(ScriptVerb Verb, string Id, string Name, VerbClass Class);
internal sealed record ScriptOptionRow(string Key, string Type, IReadOnlyList<string> Values, JsonElement Default);

/// <summary>Script As as src/shared/scripting/catalog.ts declares it, embedded as scripting-catalog.json (a vitest file
/// snapshot keeps the copy in sync): which verbs each kind and subtype offers, its URN type and preflight, titles,
/// options, error retryability and limits. C# holds no rules of its own about what can be scripted.</summary>
internal sealed class ScriptingCatalog
{
    private static readonly Lazy<ScriptingCatalog> Embedded = new(() =>
    {
        using var stream = typeof(ScriptingCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Scripting.scripting-catalog.json")
            ?? throw new InvalidOperationException("The scripting catalogue is missing from the backend build.");
        return Parse(stream);
    });

    private sealed record TargetJson(string Kind, string Subtype, string Phase, string Title, string Urn, string Preflight, List<string> ObjectTypes, List<string> Parents,
        List<string> Enabled, List<string> Disabled, bool Modifiable);
    private sealed record VerbJson(string Verb, string Name, string Class, string SmoFlag);
    private sealed record OptionJson(string Key, string Type, List<string> Values, JsonElement Default);
    private sealed record ErrorJson(string Code, bool Retryable);
    private sealed record CatalogJson(int Version, List<ErrorJson> Errors, Dictionary<string, long> Limits, List<OptionJson> Options, List<TargetJson> Targets,
        Dictionary<string, string> Titles, List<VerbJson> Verbs);

    private readonly Dictionary<(string Kind, string Subtype), ScriptTargetRow> targets;
    private readonly Dictionary<string, ScriptVerbRow> verbs;
    private readonly Dictionary<string, bool> errors;

    private ScriptingCatalog(CatalogJson json)
    {
        if (json.Version != 1) throw new InvalidOperationException("Unsupported scripting catalogue version.");
        targets = json.Targets.ToDictionary(row => (row.Kind, row.Subtype), row => new ScriptTargetRow(row.Kind, row.Subtype, row.Phase, row.Title, row.Urn, row.Preflight,
            row.ObjectTypes, row.Parents, row.Enabled, row.Disabled, row.Modifiable));
        verbs = json.Verbs.ToDictionary(row => row.Verb, row => new ScriptVerbRow(Enum.Parse<ScriptVerb>(row.Verb, ignoreCase: true), row.Verb, row.Name,
            Enum.Parse<VerbClass>(row.Class, ignoreCase: true)), StringComparer.Ordinal);
        errors = json.Errors.ToDictionary(row => row.Code, row => row.Retryable, StringComparer.Ordinal);
        Options = [.. json.Options.Select(row => new ScriptOptionRow(row.Key, row.Type, row.Values, row.Default.Clone()))];
        Titles = json.Titles;
        Limits = json.Limits;
    }

    public static ScriptingCatalog Current => Embedded.Value;

    public static ScriptingCatalog Parse(Stream stream) => new(JsonSerializer.Deserialize<CatalogJson>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
        ?? throw new InvalidOperationException("The scripting catalogue is empty."));

    /// <summary>The options in request order (ScriptingOptionsDto's member order).</summary>
    public IReadOnlyList<ScriptOptionRow> Options { get; }
    /// <summary>The object noun of each title key: "Table", "Stored Procedure".</summary>
    public IReadOnlyDictionary<string, string> Titles { get; }
    public IReadOnlyDictionary<string, long> Limits { get; }
    public IEnumerable<ScriptTargetRow> Targets => targets.Values;
    public IEnumerable<ScriptVerbRow> Verbs => verbs.Values;
    public IEnumerable<string> ErrorCodes => errors.Keys;

    public ScriptVerbRow? Verb(string id) => verbs.GetValueOrDefault(id);

    /// <summary>The row of a kind and subtype ('' or null for none), or null when the kind is not scriptable at all.</summary>
    public ScriptTargetRow? Row(string kind, string? subtype) => targets.GetValueOrDefault((kind, subtype ?? ""));

    public bool Retryable(string code) => errors.TryGetValue(code, out var retryable) ? retryable : throw new InvalidOperationException("Unknown scripting error " + code);

    public long Limit(string key) => Limits.TryGetValue(key, out var value) ? value : throw new InvalidOperationException("Unknown scripting limit " + key);
}
