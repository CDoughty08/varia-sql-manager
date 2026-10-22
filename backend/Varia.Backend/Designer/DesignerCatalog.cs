using System.Text.Json;

namespace Varia.Backend.Designer;

/// <summary>A data type as src/shared/designer/catalog.ts declares it: how it takes parameters (none, length, nlength,
/// precisionScale, scale, dimensions), its list defaults, bounds, band and storage.</summary>
internal sealed record DesignerTypeJson(string Name, string Params, int? Length = null, int? Precision = null, int? Scale = null, int? Dimensions = null, int? MaxLength = null,
    bool? Max = null, bool? ListMax = null, bool? Unlisted = null, int? Since = null, bool? Lob = null, bool? Identity = null, bool? OnePerTable = null);
internal sealed record DesignerBoundJson(int? Min = null, int? Max = null);

/// <summary>The table designer's catalogue, embedded as designer-catalog.json (a vitest file snapshot keeps the copy in
/// sync): the data types in list order (a type's index is its id in the builder's request), the reserved keywords the
/// change script brackets, parameter bounds, limits, and the describe and request ids it adds to actions.*. C# holds no
/// type rules of its own.</summary>
internal sealed class DesignerCatalog
{
    public const int Version = 1;

    private static readonly Lazy<DesignerCatalog> Embedded = new(() =>
    {
        using var stream = typeof(DesignerCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Designer.designer-catalog.json")
            ?? throw new InvalidOperationException("The table designer catalogue is missing from the backend build.");
        return Parse(stream);
    });

    private sealed record CatalogJson(int Version, Dictionary<string, DesignerBoundJson> Bounds, List<string> Describes, Dictionary<string, long> Limits, List<string> Requests,
        List<string> ReservedKeywords, List<DesignerTypeJson> Types);

    private readonly Dictionary<string, int> ids;

    private DesignerCatalog(CatalogJson json)
    {
        if (json.Version != Version) throw new InvalidOperationException("Unsupported table designer catalogue version.");
        Types = json.Types;
        ids = json.Types.Select((type, index) => (type.Name, index)).ToDictionary(item => item.Name, item => item.index, StringComparer.Ordinal);
        Bounds = json.Bounds;
        Describes = json.Describes.ToHashSet(StringComparer.Ordinal);
        Requests = json.Requests.ToHashSet(StringComparer.Ordinal);
        Limits = json.Limits;
        ReservedKeywords = json.ReservedKeywords.Append("GO").ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    public static DesignerCatalog Current => Embedded.Value;

    public static DesignerCatalog Parse(Stream stream) => new(JsonSerializer.Deserialize<CatalogJson>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
        ?? throw new InvalidOperationException("The table designer catalogue is empty."));

    public IReadOnlyList<DesignerTypeJson> Types { get; }
    public IReadOnlyDictionary<string, DesignerBoundJson> Bounds { get; }
    /// <summary>actions.describe ids the designer answers (tableDesigner).</summary>
    public IReadOnlySet<string> Describes { get; }
    /// <summary>actions.script and actions.execute actions the designer answers (createTable).</summary>
    public IReadOnlySet<string> Requests { get; }
    public IReadOnlyDictionary<string, long> Limits { get; }
    /// <summary>T-SQL's reserved keywords and GO: names the change script brackets.</summary>
    public IReadOnlySet<string> ReservedKeywords { get; }

    /// <summary>The type's id (its index in list order), or -1.</summary>
    public int IdOf(string name) => ids.TryGetValue(name, out var id) ? id : -1;
    public DesignerTypeJson? Type(string name) => ids.TryGetValue(name, out var id) ? Types[id] : null;

    public long Limit(string key) => Limits.TryGetValue(key, out var value) ? value : throw new InvalidOperationException("Unknown table designer limit " + key);
    public int Bound(string key, bool max) => (Bounds.TryGetValue(key, out var bound) ? max ? bound.Max : bound.Min : null) ?? throw new InvalidOperationException("Unknown table designer bound " + key);
}
