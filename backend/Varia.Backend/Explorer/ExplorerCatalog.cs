using System.Text.Json;

namespace Varia.Backend.Explorer;

/// <summary>SchemaPlacement: where Group by Schema shows the folder (schema, database or both), for the folders below the
/// roots that move below schema rows; null for every other.</summary>
internal sealed record CatalogFolder(string Id, string Label, string Owner, string? Parent, int Order, int? Since, IReadOnlyList<string> Engines, string? List,
    IReadOnlyList<string> Rows, IReadOnlyList<string> Filter, string? SchemaPlacement = null)
{
    public bool BelowSchema => SchemaPlacement is "schema" or "both";
    /// <summary>Shown below a database while Group by Schema is on.</summary>
    public bool BelowGroupedDatabase => Owner == "database" && SchemaPlacement != "schema";
}
/// <summary>Group by Schema's listing of a database's schemas.</summary>
internal sealed record CatalogSchemaGroups(string List, IReadOnlyList<string> Rows);
/// <summary>A node kind. List and Rows: the query whose rows follow the kind's static folders, and their kinds. MaxName: the
/// longest name its refs may carry (128 unless the kind declares more, and then it owns no folders or rows).</summary>
internal sealed record CatalogKind(string Kind, string Title, string Scope, string Icon, IReadOnlyList<string> Subtypes, IReadOnlyDictionary<string, string> SubtypeIcons,
    IReadOnlyDictionary<string, string> VariantIcons, IReadOnlyList<string> Folders, IReadOnlyDictionary<string, IReadOnlyList<string>> SubtypeFolders,
    IReadOnlyList<string> HistoryLookup, IReadOnlyList<string> Parents, string? List, IReadOnlyList<string> Rows, int MaxName);
internal sealed record CatalogScope(IReadOnlyList<string> Required, IReadOnlyList<string> Forbidden);
/// <summary>One of Peek's facts (src/shared/explorer/peek.ts): its id (the reply key and the batch's column alias), how its
/// value travels (text, code, date, bool, count or kb), the first band whose catalog has it (null: every band), and whether it
/// is in a group read by a statement of its own that the login may be refused (Optional).</summary>
internal sealed record PeekFactSpec(string Id, string Format, int? Since, bool Optional = false);
/// <summary>One of a kind's lists, read with its facts: its id and its columns' ids and formats, in reply order.</summary>
internal sealed record PeekListSpec(string Id, IReadOnlyList<PeekFactSpec> Columns);
/// <summary>A kind Peek describes: its facts in reply-column order, where its definition comes from (module: the batch
/// reads the module's text; script: the renderer asks Script As), whether explorer.peekDependencies lists its dependencies,
/// and the lists its batch reads after the facts. OptionalGroup names the group of its optional facts, which a refused reply
/// lists.</summary>
internal sealed record PeekKindSpec(string Kind, string Definition, IReadOnlyList<PeekFactSpec> Facts, bool Dependencies = true, IReadOnlyList<PeekListSpec>? Lists = null,
    string? OptionalGroup = null)
{
    public bool Module => Definition == "module";
    public IReadOnlyList<PeekListSpec> ListSpecs => Lists ?? [];
    /// <summary>The facts a server of this band has, in reply order.</summary>
    public IReadOnlyList<PeekFactSpec> FactsFor(int band) => [.. Facts.Where(fact => (fact.Since ?? ExplorerCatalog.MinBand) <= band)];
}
/// <summary>Peek's kinds and limits: module text per reply and the longest Peek reads (UTF-16 code units), the backend's budget for one peek, the dependencies
/// listed each way, the rows each list keeps, and the databases a login's User mapping reads. (Its Top rows tab runs Select
/// Top Rows' script through query.execute, not the explorer.)</summary>
internal sealed record CatalogPeek(IReadOnlyDictionary<string, PeekKindSpec> Kinds, int DefinitionPageChars, int DefinitionMaxChars, int BudgetMs, int Dependencies, int ListRows = 1024, int MappingDatabases = 256);

/// <summary>What a server can browse: its version band (12 below SQL Server 2016, else the major version up to 17, or the
/// band of the catalog columns it has when that is higher), whether it is a cloud edition, whether it runs on Linux, and whether
/// it is Azure SQL Managed Instance.</summary>
internal readonly record struct ExplorerProfile(int Band, bool Cloud, bool Linux = false, bool ManagedInstance = false)
{
    /// <summary>The folders' engine: Managed Instance browses as a box server.</summary>
    public string Engine => Cloud ? "cloud" : "box";
    /// <summary>The actions' engine (src/shared/explorer/catalog.ts serverEngineOf): box, managedInstance or cloud.</summary>
    public string ServerEngine => Cloud ? "cloud" : ManagedInstance ? "managedInstance" : "box";
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

    private sealed record FolderJson(string Id, string Label, string Owner, string? Parent, int Order, int? Since, List<string> Engines, string? List, List<string>? Rows, List<string> Filter,
        string? SchemaPlacement);
    private sealed record KindJson(string Kind, string Title, string Scope, string Icon, List<string> Subtypes, Dictionary<string, string> SubtypeIcons,
        Dictionary<string, string> VariantIcons, List<string> Folders, Dictionary<string, List<string>> SubtypeFolders, List<string> HistoryLookup, List<string> Parents,
        string? List, List<string> Rows, int MaxName);
    private sealed record PeekFactJson(string Id, string Format, int? Since, bool Optional = false);
    private sealed record PeekListJson(string Id, List<PeekFactJson> Columns);
    private sealed record PeekKindJson(string Kind, string Definition, bool Dependencies, string? OptionalGroup, List<PeekFactJson> Facts, List<PeekListJson> Lists);
    private sealed record PeekJson(int BudgetMs, int DefinitionPageChars, int DefinitionMaxChars, int Dependencies, int ListRows, int MappingDatabases, List<PeekKindJson> Kinds);
    private sealed record CatalogJson(int Version, List<int> CloudEngineEditions, List<FolderJson> Folders, List<KindJson> Kinds, List<int> ManagedInstanceEngineEditions, List<string> Queries,
        CatalogSchemaGroups SchemaGroups, Dictionary<string, CatalogScope> Scopes, PeekJson? Peek);
    private static readonly string[] PeekFormats = ["text", "code", "date", "bool", "count", "kb"];
    /// <summary>The scopes Peek reads: a schema object, a table's or view's child, a database-scoped object, a database, a
    /// server-scoped object.</summary>
    private static readonly string[] PeekScopes = ["schemaObject", "child", "databaseObject", "database", "serverObject"];

    private readonly Dictionary<string, CatalogFolder> folders;
    private readonly Dictionary<string, CatalogKind> kinds;
    private readonly Dictionary<string, IReadOnlyList<string>> subfolders;
    private readonly Dictionary<string, IReadOnlyList<string>> owners;

    private ExplorerCatalog(CatalogJson json)
    {
        if (json.Version != 1) throw new InvalidOperationException("Unsupported Object Explorer catalogue version.");
        CloudEditions = json.CloudEngineEditions.ToHashSet();
        ManagedInstanceEditions = json.ManagedInstanceEngineEditions.ToHashSet();
        folders = json.Folders.ToDictionary(folder => folder.Id, folder => new CatalogFolder(folder.Id, folder.Label, folder.Owner, folder.Parent, folder.Order, folder.Since,
            folder.Engines, folder.List, folder.Rows ?? [], folder.Filter, folder.SchemaPlacement), StringComparer.Ordinal);
        kinds = json.Kinds.ToDictionary(kind => kind.Kind, kind => new CatalogKind(kind.Kind, kind.Title, kind.Scope, kind.Icon, kind.Subtypes, kind.SubtypeIcons, kind.VariantIcons,
            kind.Folders, kind.SubtypeFolders.ToDictionary(item => item.Key, item => (IReadOnlyList<string>)item.Value), kind.HistoryLookup, kind.Parents, kind.List, kind.Rows,
            kind.MaxName is >= ExplorerRefs.MaxIdentifier and <= ExplorerRefs.MaxName ? kind.MaxName : throw new InvalidOperationException("A kind's name bound is out of range.")),
            StringComparer.Ordinal);
        // Folders, history rows and listings name their owner through @object_name, a sysname: a longer owner name would
        // reach them cut to 128 code units, and resolve another object.
        if (kinds.Values.FirstOrDefault(kind => kind.MaxName > ExplorerRefs.MaxIdentifier && OwnsChildren(kind)) is { } longNamed)
            throw new InvalidOperationException("A kind whose names exceed 128 code units cannot own folders or rows: " + longNamed.Kind + ".");
        Queries = [.. json.Queries];
        SchemaGroups = json.SchemaGroups ?? throw new InvalidOperationException("The Object Explorer catalogue has no schema groups.");
        Scopes = json.Scopes;
        Peek = ParsePeek(json.Peek, kinds);
        FolderIds = [.. json.Folders.Select(folder => folder.Id)];
        subfolders = folders.Keys.ToDictionary(id => id, id => (IReadOnlyList<string>)[.. folders.Values.Where(child => child.Parent == id).OrderBy(child => child.Order).Select(child => child.Id)], StringComparer.Ordinal);
        owners = folders.Keys.ToDictionary(id => id, id =>
        {
            var root = RootFolder(id);
            IReadOnlyList<string> owners = [.. kinds.Values.Where(kind => kind.Folders.Contains(root) || kind.SubtypeFolders.Values.Any(set => set.Contains(root))).Select(kind => kind.Kind)];
            return folders[id].BelowSchema ? [.. owners, "schema"] : owners;
        }, StringComparer.Ordinal);
    }

    /// <summary>Peek's block, checked once: fact ids become column aliases in PeekSql's batches, so they are plain words.</summary>
    private static CatalogPeek ParsePeek(PeekJson? peek, Dictionary<string, CatalogKind> kinds)
    {
        if (peek is null) throw new InvalidOperationException("The Object Explorer catalogue has no peek block.");
        // A page is at most 3 bytes a code unit in UTF-8, far under the protocol's 16 MiB reply; no module is longer than 2^30.
        if (peek.DefinitionPageChars is < 1 or > 4_000_000 || peek.DefinitionMaxChars < peek.DefinitionPageChars || peek.DefinitionMaxChars > 1 << 30 || peek.BudgetMs is < 1000 or > 60_000 || peek.Dependencies is < 1 or > 10_000
            || peek.ListRows is < 1 or > 10_000 || peek.MappingDatabases is < 1 or > 32_767) throw new InvalidOperationException("Peek's limits are out of range.");
        var specs = new Dictionary<string, PeekKindSpec>(StringComparer.Ordinal);
        foreach (var kind in peek.Kinds ?? throw new InvalidOperationException("Peek has no kinds."))
        {
            if (!kinds.TryGetValue(kind.Kind, out var spec) || !PeekScopes.Contains(spec.Scope)) throw new InvalidOperationException("Peek names a kind of a scope it does not read: " + kind.Kind + ".");
            if (kind.Definition is not ("module" or "script")) throw new InvalidOperationException("Peek's definition source is unknown for " + kind.Kind + ".");
            var facts = Words(kind.Kind, kind.Facts, "fact");
            // Optional facts come from the batch's last statement, after every fact it always reads.
            if (facts.SkipWhile(fact => !fact.Optional).Any(fact => !fact.Optional)) throw new InvalidOperationException("Peek's " + kind.Kind + " has an optional fact before a fact it always reads.");
            if (facts.Any(fact => fact.Optional) != kind.OptionalGroup is { Length: > 0 }) throw new InvalidOperationException("Peek's " + kind.Kind + " has optional facts without their group, or a group without them.");
            var lists = new List<PeekListSpec>();
            foreach (var list in kind.Lists ?? [])
            {
                if (list.Id is not { Length: >= 1 and <= 64 } || !list.Id.All(char.IsAsciiLetter) || lists.Any(other => other.Id == list.Id))
                    throw new InvalidOperationException("Peek's " + kind.Kind + " has an invalid or repeated list.");
                var columns = Words(kind.Kind + "." + list.Id, list.Columns, "column");
                if (columns.Any(item => item.Since is not null || item.Optional)) throw new InvalidOperationException("Peek's list " + kind.Kind + "." + list.Id + " has a banded or optional column.");
                lists.Add(new(list.Id, [.. columns.Select(item => new PeekFactSpec(item.Id, item.Format, null))]));
            }
            // The batch reads User mapping's databases after every other list (PeekSql.ReadAsync).
            if (lists.FindIndex(list => list.Id == "userMapping") is var mapping and >= 0 && mapping != lists.Count - 1)
                throw new InvalidOperationException("Peek's " + kind.Kind + " lists User mapping before another list.");
            if (!specs.TryAdd(kind.Kind, new(kind.Kind, kind.Definition, [.. facts.Select(fact => new PeekFactSpec(fact.Id, fact.Format, fact.Since, fact.Optional))], kind.Dependencies, lists, kind.OptionalGroup)))
                throw new InvalidOperationException("Peek names " + kind.Kind + " twice.");
        }
        return new(specs, peek.DefinitionPageChars, peek.DefinitionMaxChars, peek.BudgetMs, peek.Dependencies, peek.ListRows, peek.MappingDatabases);
    }

    /// <summary>Fact and list column ids become column aliases in PeekSql's batches, so they are plain words, distinct, never
    /// "definition", with a known format and band.</summary>
    private static List<PeekFactJson> Words(string owner, List<PeekFactJson>? items, string what)
    {
        if (items is not { Count: > 0 }) throw new InvalidOperationException("Peek's " + owner + " has no " + what + "s.");
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "definition" };
        foreach (var item in items)
        {
            if (item.Id is not { Length: >= 1 and <= 64 } id || !char.IsAsciiLetterLower(id[0]) || !id.All(char.IsAsciiLetter) || !ids.Add(id))
                throw new InvalidOperationException("Peek's " + owner + " has an invalid or repeated " + what + " id.");
            if (!PeekFormats.Contains(item.Format) || item.Since is { } since && (since <= MinBand || since > MaxBand))
                throw new InvalidOperationException("Peek's " + what + " " + owner + "." + item.Id + " has an unknown format or band.");
        }
        return items;
    }

    private static bool OwnsChildren(CatalogKind kind) => kind.Folders.Count > 0 || kind.SubtypeFolders.Count > 0 || kind.HistoryLookup.Count > 0 || kind.List is not null;

    public static ExplorerCatalog Current => Embedded.Value;

    public static ExplorerCatalog Parse(Stream stream) => new(JsonSerializer.Deserialize<CatalogJson>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
        ?? throw new InvalidOperationException("The Object Explorer catalogue is empty."));

    public static int BandOf(int major) => major < 13 ? MinBand : Math.Min(major, MaxBand);

    public IReadOnlySet<int> CloudEditions { get; }
    public IReadOnlySet<int> ManagedInstanceEditions { get; }
    public IReadOnlyList<string> Queries { get; }
    public IReadOnlyList<string> FolderIds { get; }
    public IReadOnlyDictionary<string, CatalogScope> Scopes { get; }
    public CatalogSchemaGroups SchemaGroups { get; }
    public CatalogPeek Peek { get; }
    public IEnumerable<CatalogKind> Kinds => kinds.Values;

    public CatalogFolder? Folder(string id) => folders.GetValueOrDefault(id);
    public CatalogKind? Kind(string kind) => kinds.GetValueOrDefault(kind);
    public CatalogKind KindOf(string kind) => kinds[kind];

    /// <summary>A server's band is its major version's, raised to the band of the catalog columns it has
    /// (<paramref name="catalogBand"/>): Azure SQL Database and Managed Instance report version 12 while running the newest
    /// engine. On SQL Server the catalog band never exceeds the version's.</summary>
    public ExplorerProfile Profile(int major, int edition, int catalogBand = MinBand) =>
        new(Math.Max(BandOf(major), Math.Clamp(catalogBand, MinBand, MaxBand)), CloudEditions.Contains(edition), ManagedInstance: ManagedInstanceEditions.Contains(edition));

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

    /// <summary>A folder's served subfolders as its owner shows them: below a schema row those that list its objects, below a
    /// database with Group by Schema on those that do not (src/shared/explorer/catalog.ts ownedSubfolders).</summary>
    public IReadOnlyList<string> Subfolders(string folder, string owner, bool grouped, ExplorerProfile profile) =>
        [.. Subfolders(folder, profile).Where(id => owner == "schema" ? folders[id].BelowSchema : owner != "database" || !grouped || folders[id].BelowGroupedDatabase)];

    /// <summary>A database's served folders with Group by Schema on: those that stay below it.</summary>
    public IReadOnlyList<string> GroupedDatabaseFolders(ExplorerProfile profile) => [.. StaticFolders("database", null, profile).Where(id => folders[id].BelowGroupedDatabase)];

    /// <summary>A schema row's served folders with Group by Schema on.</summary>
    public IReadOnlyList<string> SchemaGroupFolders(ExplorerProfile profile) => [.. StaticFolders("database", null, profile).Where(id => folders[id].BelowSchema)];

    /// <summary>The filter properties a folder offers below its owner: below a schema row, not Schema.</summary>
    public IReadOnlyList<string> FilterFor(CatalogFolder folder, string owner) => [.. folder.Filter.Where(property => owner != "schema" || property != "schema")];

    /// <summary>Whether an object node can expand: it has served static folders, a history row (temporal and ledger tables), or
    /// rows of its own (<see cref="CatalogKind.List"/>).</summary>
    public bool HasChildren(string kind, string? subtype, ExplorerProfile profile) =>
        StaticFolders(kind, subtype, profile).Count > 0 || subtype is not null && kinds[kind].HistoryLookup.Contains(subtype) || kinds[kind].List is not null;

    public string IconFor(string kind, string? subtype) => subtype is not null && kinds[kind].SubtypeIcons.TryGetValue(subtype, out var icon) ? icon : kinds[kind].Icon;
}
