using System.Text.Json;

namespace Varia.Backend.Explorer;

internal sealed record CatalogFolder(string Id, string Label, string Owner, string? Parent, int Order, int? Since, IReadOnlyList<string> Engines, string? List,
    IReadOnlyList<string> Rows, IReadOnlyList<string> Filter);
internal sealed record CatalogKind(string Kind, string Title, string Scope, string Icon, IReadOnlyList<string> Subtypes, IReadOnlyDictionary<string, string> SubtypeIcons,
    IReadOnlyDictionary<string, string> VariantIcons, IReadOnlyList<string> Folders, IReadOnlyDictionary<string, IReadOnlyList<string>> SubtypeFolders,
    IReadOnlyList<string> HistoryLookup, IReadOnlyList<string> Parents);
internal sealed record CatalogScope(IReadOnlyList<string> Required, IReadOnlyList<string> Forbidden);

/// <summary>What a server can browse: its version band (12 below SQL Server 2016, else the major version up to 17; on cloud
/// editions, the band of the catalog columns it has) and whether it is a cloud edition.</summary>
internal readonly record struct ExplorerProfile(int Band, bool Cloud)
{
    public string Engine => Cloud ? "cloud" : "box";
}

/// <summary>The Object Explorer tree as src/shared/explorer/catalog.ts declares it, embedded as explorer-catalog.json (a
/// vitest file snapshot keeps the copy in sync). Gates are already combined with those of parent folders.</summary>
internal sealed class ExplorerCatalog
{
    public const int MinBand = 12, MaxBand = 17;
    private static readonly Lazy<ExplorerCatalog> Embedded = new(() =>
    {
        using var stream = typeof(ExplorerCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Explorer.explorer-catalog.json")
            ?? throw new InvalidOperationException("The Object Explorer catalogue is missing from the backend build.");
        return Parse(stream);
    });

    private sealed record FolderJson(string Id, string Label, string Owner, string? Parent, int Order, int? Since, List<string> Engines, string? List, List<string>? Rows, List<string> Filter);
    private sealed record KindJson(string Kind, string Title, string Scope, string Icon, List<string> Subtypes, Dictionary<string, string> SubtypeIcons,
        Dictionary<string, string> VariantIcons, List<string> Folders, Dictionary<string, List<string>> SubtypeFolders, List<string> HistoryLookup, List<string> Parents);
    private sealed record CatalogJson(int Version, List<int> CloudEngineEditions, List<FolderJson> Folders, List<KindJson> Kinds, List<string> Queries,
        Dictionary<string, CatalogScope> Scopes);

    private readonly Dictionary<string, CatalogFolder> folders;
    private readonly Dictionary<string, CatalogKind> kinds;
    private readonly Dictionary<string, IReadOnlyList<string>> subfolders;
    private readonly Dictionary<string, IReadOnlyList<string>> owners;

    private ExplorerCatalog(CatalogJson json)
    {
        if (json.Version != 1) throw new InvalidOperationException("Unsupported Object Explorer catalogue version.");
        CloudEditions = json.CloudEngineEditions.ToHashSet();
        folders = json.Folders.ToDictionary(folder => folder.Id, folder => new CatalogFolder(folder.Id, folder.Label, folder.Owner, folder.Parent, folder.Order, folder.Since,
            folder.Engines, folder.List, folder.Rows ?? [], folder.Filter), StringComparer.Ordinal);
        kinds = json.Kinds.ToDictionary(kind => kind.Kind, kind => new CatalogKind(kind.Kind, kind.Title, kind.Scope, kind.Icon, kind.Subtypes, kind.SubtypeIcons, kind.VariantIcons,
            kind.Folders, kind.SubtypeFolders.ToDictionary(item => item.Key, item => (IReadOnlyList<string>)item.Value), kind.HistoryLookup, kind.Parents), StringComparer.Ordinal);
        Queries = [.. json.Queries];
        Scopes = json.Scopes;
        FolderIds = [.. json.Folders.Select(folder => folder.Id)];
        subfolders = folders.Keys.ToDictionary(id => id, id => (IReadOnlyList<string>)[.. folders.Values.Where(child => child.Parent == id).OrderBy(child => child.Order).Select(child => child.Id)], StringComparer.Ordinal);
        owners = folders.Keys.ToDictionary(id => id, id =>
        {
            var root = RootFolder(id);
            return (IReadOnlyList<string>)[.. kinds.Values.Where(kind => kind.Folders.Contains(root) || kind.SubtypeFolders.Values.Any(set => set.Contains(root))).Select(kind => kind.Kind)];
        }, StringComparer.Ordinal);
    }

    public static ExplorerCatalog Current => Embedded.Value;

    public static ExplorerCatalog Parse(Stream stream) => new(JsonSerializer.Deserialize<CatalogJson>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
        ?? throw new InvalidOperationException("The Object Explorer catalogue is empty."));

    public static int BandOf(int major) => major < 13 ? MinBand : Math.Min(major, MaxBand);

    public IReadOnlySet<int> CloudEditions { get; }
    public IReadOnlyList<string> Queries { get; }
    public IReadOnlyList<string> FolderIds { get; }
    public IReadOnlyDictionary<string, CatalogScope> Scopes { get; }
    public IEnumerable<CatalogKind> Kinds => kinds.Values;

    public CatalogFolder? Folder(string id) => folders.GetValueOrDefault(id);
    public CatalogKind? Kind(string kind) => kinds.GetValueOrDefault(kind);
    public CatalogKind KindOf(string kind) => kinds[kind];

    /// <summary>A box server's band is its major version's; a cloud edition's is at least the band of the catalog columns
    /// it has (<paramref name="catalogBand"/>), since Azure SQL Database reports version 12.</summary>
    public ExplorerProfile Profile(int major, int edition, int catalogBand = MinBand)
    {
        var cloud = CloudEditions.Contains(edition);
        return new(cloud ? Math.Max(BandOf(major), Math.Clamp(catalogBand, MinBand, MaxBand)) : BandOf(major), cloud);
    }

    public string RootFolder(string id)
    {
        var folder = folders[id];
        while (folder.Parent is { } parent) folder = folders[parent];
        return folder.Id;
    }

    /// <summary>The kinds a folder can hang below, whatever their subtype.</summary>
    public IReadOnlyList<string> FolderOwnerKinds(string folder) => owners.GetValueOrDefault(folder) ?? [];

    public bool Served(string folder, ExplorerProfile profile)
    {
        var spec = folders[folder];
        return (spec.Since ?? MinBand) <= profile.Band && spec.Engines.Contains(profile.Engine);
    }

    public IReadOnlyList<string> FoldersFor(string kind, string? subtype)
    {
        var spec = kinds[kind];
        return subtype is not null && spec.SubtypeFolders.TryGetValue(subtype, out var set) ? set : spec.Folders;
    }

    /// <summary>The static folders below an object of this kind and subtype, served on this server.</summary>
    public IReadOnlyList<string> StaticFolders(string kind, string? subtype, ExplorerProfile profile) => [.. FoldersFor(kind, subtype).Where(id => Served(id, profile))];

    /// <summary>A folder's static subfolders served on this server, in SSMS order.</summary>
    public IReadOnlyList<string> Subfolders(string folder, ExplorerProfile profile) => [.. subfolders[folder].Where(id => Served(id, profile))];

    /// <summary>Whether an object node can expand: it has served static folders, or a history row (temporal and ledger tables).</summary>
    public bool HasChildren(string kind, string? subtype, ExplorerProfile profile) =>
        StaticFolders(kind, subtype, profile).Count > 0 || subtype is not null && kinds[kind].HistoryLookup.Contains(subtype);

    public string IconFor(string kind, string? subtype) => subtype is not null && kinds[kind].SubtypeIcons.TryGetValue(subtype, out var icon) ? icon : kinds[kind].Icon;
}
