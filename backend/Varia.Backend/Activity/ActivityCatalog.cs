using System.Collections.Frozen;
using System.Text.Json;

namespace Varia.Backend.Activity;

/// <summary>A table column as the catalogue declares it: its id, its type, and the capability it needs, if any.</summary>
internal sealed record ActivityColumn(string Id, string Type, string? Capability);

/// <summary>A table of an Activity Monitor probe: its key, row cap, columns, and which columns the filter box and the
/// column value filters use.</summary>
internal sealed record ActivityTableSpec(string Table, string Probe, IReadOnlyList<string> Key, IReadOnlyList<string> Identity, int RowCap, IReadOnlyList<ActivityColumn> Columns,
    IReadOnlySet<string> TextColumns, IReadOnlySet<string> FacetColumns, IReadOnlyList<string> Tones, bool DepartedLinger)
{
    public bool Has(string column) => Columns.Any(spec => spec.Id == column);
}

/// <summary>A probe's kind, tables, series and intervals.</summary>
internal sealed record ActivityProbeSpec(string Probe, string Kind, IReadOnlyList<string> Tables, IReadOnlyList<string> Series, int DefaultIntervalMs, int MinIntervalMs, int MaxIntervalMs,
    int FloorMs, int BudgetMs, int? MinGapMs, double MaxDutyCycle, bool Maxdop1, string? FilterMode, string Hidden);

/// <summary>A wait type's category id, and whether it is benign: on Varia's benign list or in a benign category (Idle).</summary>
internal readonly record struct WaitClass(string Category, bool Benign)
{
    /// <summary>Its time counts in Waiting Tasks and the Resource Waits chart: every type that is not benign, Unknown too.</summary>
    public bool CountsAsWaiting => !Benign;
}

/// <summary>The Activity Monitor as src/shared/activity/catalog.ts declares it, embedded as activity-catalog.json (a vitest
/// file snapshot keeps the copy in sync): probes, tables and columns, view chips, Query Store's wait categories with the
/// benign list and exceptions, negative blocker ids, Varia's session suffixes and limits. C# holds no column list or wait map
/// of its own.</summary>
internal sealed class ActivityCatalog
{
    public const int Version = 1;

    private static readonly Lazy<ActivityCatalog> Embedded = new(() =>
    {
        using var stream = typeof(ActivityCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Activity.activity-catalog.json")
            ?? throw new InvalidOperationException("The Activity Monitor catalogue is missing from the backend build.");
        return Parse(stream);
    });

    private sealed record BandsJson(int Min, int Max);
    private sealed record EditionJson(bool Available, List<int> Editions);
    private sealed record ExceptionJson(string Name, string Category);
    private sealed record ProbeJson(string Probe, string Kind, List<string> Tables, List<string> Series, int DefaultIntervalMs, int MinIntervalMs, int MaxIntervalMs, int FloorMs, int BudgetMs,
        double MaxDutyCycle, string Hidden, int? MinGapMs = null, bool? Maxdop1 = null, string? FilterMode = null);
    private sealed record HideBenignJson(bool Default, List<string> Tables);
    private sealed record LoadGuardJson(int SlowSamples, int CheapSamples);
    private sealed record TableJson(string Table, string Probe, List<string> Key, int RowCap, List<string> Columns, List<string>? Identity = null, List<string>? TextColumns = null,
        List<string>? FacetColumns = null, List<string>? Tones = null, bool? DepartedLinger = null);
    private sealed record VariaJson(string Suffix, string Kind);
    private sealed record WaitJson(string Id, int Value, List<string> Names, List<string> Patterns);
    private sealed record CatalogJson(int Version, BandsJson Bands, List<string> Benign, List<string> BenignCategories, Dictionary<string, string> BlockerLabels, List<string> DetailsSections,
        List<string> DetailsTexts, Dictionary<string, EditionJson> Editions, List<ExceptionJson> Exceptions, HideBenignJson HideBenign, List<string> KillOutcomes, Dictionary<string, long> Limits,
        LoadGuardJson LoadGuard, string PoolSuffix, List<ProbeJson> Probes, string Source, List<TableJson> Tables, Dictionary<string, string> Tones, string UnavailableMessage,
        List<VariaJson> VariaSessions, List<string> Views, List<WaitJson> Waits);

    private readonly FrozenDictionary<string, string> exact;
    private readonly FrozenSet<string> benign;
    private readonly FrozenSet<string> benignCategories;
    private readonly (string Prefix, string Category)[] prefixes;
    private readonly FrozenDictionary<int, string> editions;
    private readonly HashSet<string> available;

    private ActivityCatalog(CatalogJson json)
    {
        if (json.Version != Version) throw new InvalidOperationException("Unsupported Activity Monitor catalogue version.");
        Source = json.Source;
        PoolSuffix = json.PoolSuffix;
        MinBand = json.Bands.Min;
        MaxBand = json.Bands.Max;
        Limits = json.Limits;
        Views = json.Views;
        Tones = json.Tones;
        BlockerLabels = json.BlockerLabels.ToFrozenDictionary(entry => int.Parse(entry.Key, System.Globalization.CultureInfo.InvariantCulture), entry => entry.Value);
        Probes = json.Probes.ToFrozenDictionary(probe => probe.Probe, probe => new ActivityProbeSpec(probe.Probe, probe.Kind, probe.Tables, probe.Series, probe.DefaultIntervalMs,
            probe.MinIntervalMs, probe.MaxIntervalMs, probe.FloorMs, probe.BudgetMs, probe.MinGapMs, probe.MaxDutyCycle, probe.Maxdop1 == true, probe.FilterMode, probe.Hidden), StringComparer.Ordinal);
        Tables = json.Tables.ToFrozenDictionary(table => table.Table, table => new ActivityTableSpec(table.Table, table.Probe, table.Key, table.Identity ?? [], table.RowCap,
            [.. table.Columns.Select(Column)], (table.TextColumns ?? []).ToFrozenSet(StringComparer.Ordinal), (table.FacetColumns ?? []).ToFrozenSet(StringComparer.Ordinal), table.Tones ?? [],
            table.DepartedLinger == true), StringComparer.Ordinal);
        VariaSuffixes = json.VariaSessions.Select(entry => (entry.Suffix, entry.Kind)).ToArray();
        DetailsSections = json.DetailsSections;
        DetailsTexts = json.DetailsTexts.ToFrozenSet(StringComparer.Ordinal);
        KillOutcomes = json.KillOutcomes;
        UnavailableMessage = json.UnavailableMessage;
        WaitCategories = [.. json.Waits.Select(wait => wait.Id)];
        var names = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var wait in json.Waits) foreach (var name in wait.Names) names[name] = wait.Id;
        foreach (var exception in json.Exceptions) names[exception.Name] = exception.Category;
        exact = names.ToFrozenDictionary(StringComparer.Ordinal);
        benign = json.Benign.ToFrozenSet(StringComparer.Ordinal);
        benignCategories = json.BenignCategories.ToFrozenSet(StringComparer.Ordinal);
        HideBenignDefault = json.HideBenign.Default;
        HideBenignTables = json.HideBenign.Tables.ToFrozenSet(StringComparer.Ordinal);
        LoadGuard = (json.LoadGuard.SlowSamples, json.LoadGuard.CheapSamples);
        prefixes = [.. json.Waits.SelectMany(wait => wait.Patterns.Select(pattern => pattern.EndsWith('%') && pattern.IndexOf('%') == pattern.Length - 1
            ? (pattern[..^1], wait.Id) : throw new InvalidOperationException("A wait pattern must be a prefix with one trailing %.")))];
        editions = json.Editions.SelectMany(entry => entry.Value.Editions.Select(edition => (edition, entry.Key))).ToFrozenDictionary(pair => pair.edition, pair => pair.Key);
        available = [.. json.Editions.Where(entry => entry.Value.Available).Select(entry => entry.Key)];
    }

    private static ActivityColumn Column(string text)
    {
        var parts = text.Split(':');
        return parts.Length is 2 or 3 ? new(parts[0], parts[1], parts.Length == 3 ? parts[2] : null) : throw new InvalidOperationException("Malformed Activity Monitor column.");
    }

    public static ActivityCatalog Current => Embedded.Value;

    public static ActivityCatalog Parse(Stream stream) => new(JsonSerializer.Deserialize<CatalogJson>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
        ?? throw new InvalidOperationException("The Activity Monitor catalogue is empty."));

    public string Source { get; }
    public string PoolSuffix { get; }
    public int MinBand { get; }
    public int MaxBand { get; }
    public IReadOnlyDictionary<string, long> Limits { get; }
    public IReadOnlyList<string> Views { get; }
    public IReadOnlyDictionary<string, string> Tones { get; }
    public IReadOnlyDictionary<int, string> BlockerLabels { get; }
    public IReadOnlyDictionary<string, ActivityProbeSpec> Probes { get; }
    public IReadOnlyDictionary<string, ActivityTableSpec> Tables { get; }
    /// <summary>Program name suffixes of Varia's sessions, with 'queryTab' or 'pool'.</summary>
    public IReadOnlyList<(string Suffix, string Kind)> VariaSuffixes { get; }
    public IReadOnlyList<string> WaitCategories { get; }
    /// <summary>The Details flyout's sections, the texts it returns whole on request, and Kill's outcomes (activity.details and activity.kill).</summary>
    public IReadOnlyList<string> DetailsSections { get; }
    public IReadOnlySet<string> DetailsTexts { get; }
    public IReadOnlyList<string> KillOutcomes { get; }
    /// <summary>What the monitor says for a server it does not serve.</summary>
    public string UnavailableMessage { get; }
    public IEnumerable<string> BenignWaits => benign;
    public IEnumerable<string> BenignCategories => benignCategories;
    /// <summary>Hide benign waits: on unless a filter turns it off, and only for these tables.</summary>
    public bool HideBenignDefault { get; }
    public IReadOnlySet<string> HideBenignTables { get; }
    /// <summary>The load guard's counts: slow samples in a row before an interval doubles, cheap ones before it halves back.</summary>
    public (int SlowSamples, int CheapSamples) LoadGuard { get; }

    /// <summary>The program names of this backend's pool sessions for a connection whose Application Name is <paramref name="applicationName"/>:
    /// each pool suffix appended and cut to 128 characters, as SqlService names its pools. Query tabs (no suffix) are not pools.</summary>
    public IReadOnlyList<string> PoolProgramNames(string applicationName) =>
        [.. VariaSuffixes.Where(entry => entry.Kind == "pool").Select(entry => applicationName + entry.Suffix).Select(name => name.Length > 128 ? name[..128] : name)];

    public long Limit(string key) => Limits.TryGetValue(key, out var value) ? value : throw new InvalidOperationException("Unknown Activity Monitor limit " + key);

    public ActivityTableSpec Table(string table) => Tables.TryGetValue(table, out var spec) ? spec : throw new InvalidOperationException("Unknown Activity Monitor table " + table);

    /// <summary>Benign names, then Query Store's exceptions and exact names, then its prefixes in order; anything else is
    /// Unknown, which the monitor shows rather than drops. A type in a benign category is benign too.</summary>
    public WaitClass Classify(string waitType)
    {
        if (benign.Contains(waitType)) return new("idle", true);
        var category = exact.GetValueOrDefault(waitType) ?? prefixes.FirstOrDefault(entry => waitType.StartsWith(entry.Prefix, StringComparison.Ordinal)).Category ?? "unknown";
        return new(category, benignCategories.Contains(category));
    }

    /// <summary>The catalogue's kind of server for an EngineEdition ('box', 'managedInstance', 'azureSqlDatabase'), or null
    /// for one the monitor does not serve (Synapse, Fabric, SQL Edge).</summary>
    public string? EditionOf(int engineEdition) => editions.GetValueOrDefault(engineEdition);

    /// <summary>Whether this version's monitor serves the kind of server (Azure SQL Database arrives later).</summary>
    public bool Available(string edition) => available.Contains(edition);
}
