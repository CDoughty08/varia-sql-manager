using System.Text.Json;

namespace Varia.Backend.Ssis;

/// <summary>The SSIS Catalog as src/shared/ssis/catalog.ts declares it, embedded as ssis-catalog.json (a vitest file snapshot
/// keeps the copy in sync): the catalog's name, the views ssis.describe reads and the kind each describes, code labels, error
/// retryability, feature names and limits. C# holds no SSIS codes or bounds of its own.</summary>
internal sealed class SsisCatalog
{
    public const int Version = 1;

    private static readonly Lazy<SsisCatalog> Embedded = new(() =>
    {
        using var stream = typeof(SsisCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Ssis.ssis-catalog.json")
            ?? throw new InvalidOperationException("The SSIS catalogue is missing from the backend build.");
        return Parse(stream);
    });

    private sealed record CodeJson(int Code, string Label, string? Tone = null, int? Since = null);
    private sealed record ErrorJson(string Code, bool Retryable);
    private sealed record ViewJson(string View, string Kind);
    private sealed record CatalogJson(int Version, string CatalogDatabase, List<ErrorJson> Errors, List<string> Features, Dictionary<string, long> Limits, List<CodeJson> LoggingLevels,
        List<CodeJson> MessageTypes, List<CodeJson> OperationStatuses, List<CodeJson> OperationTypes, List<CodeJson> ParameterObjectTypes, List<ViewJson> Views);

    private readonly Dictionary<string, bool> errors;
    private readonly Dictionary<string, string> views;

    private SsisCatalog(CatalogJson json)
    {
        if (json.Version != Version) throw new InvalidOperationException("Unsupported SSIS catalogue version.");
        CatalogDatabase = json.CatalogDatabase;
        errors = json.Errors.ToDictionary(row => row.Code, row => row.Retryable, StringComparer.Ordinal);
        views = json.Views.ToDictionary(row => row.View, row => row.Kind, StringComparer.Ordinal);
        Features = json.Features;
        Limits = json.Limits;
        LoggingLevels = json.LoggingLevels.ToDictionary(row => row.Code, row => row.Label);
        OperationStatuses = json.OperationStatuses.ToDictionary(row => row.Code, row => row.Label);
        OperationTypes = json.OperationTypes.ToDictionary(row => row.Code, row => row.Label);
        ParameterObjectTypes = json.ParameterObjectTypes.ToDictionary(row => row.Code, row => row.Label);
        MessageTypes = json.MessageTypes.ToDictionary(row => row.Code, row => row.Label);
    }

    public static SsisCatalog Current => Embedded.Value;

    public static SsisCatalog Parse(Stream stream) => new(JsonSerializer.Deserialize<CatalogJson>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
        ?? throw new InvalidOperationException("The SSIS catalogue is empty."));

    /// <summary>"SSISDB": SSMS fixes the catalog's name.</summary>
    public string CatalogDatabase { get; }
    public IReadOnlyList<string> Features { get; }
    public IReadOnlyDictionary<string, long> Limits { get; }
    public IReadOnlyDictionary<int, string> LoggingLevels { get; }
    public IReadOnlyDictionary<int, string> OperationStatuses { get; }
    public IReadOnlyDictionary<int, string> OperationTypes { get; }
    public IReadOnlyDictionary<int, string> ParameterObjectTypes { get; }
    public IReadOnlyDictionary<int, string> MessageTypes { get; }
    public IEnumerable<string> Views => views.Keys;
    public IEnumerable<string> ErrorCodes => errors.Keys;

    /// <summary>The kind a view describes, or null for a view the catalogue does not have.</summary>
    public string? KindOf(string view) => views.GetValueOrDefault(view);
    public bool Retryable(string code) => errors.TryGetValue(code, out var retryable) ? retryable : throw new InvalidOperationException("Unknown SSIS error code " + code + ".");
    public int Limit(string name) => checked((int)Limits[name]);
}
