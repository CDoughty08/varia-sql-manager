using System.Text.Json;
using System.Text.Json.Serialization;

namespace Varia.Backend.Live;

internal sealed record LiveIntervalJson(int Default, int Min, int Max);
internal sealed record LiveIntervalBoundsJson(int Min, int Max);
internal sealed record LiveSeriesJson(string Id, string Unit, string Label);
internal sealed record LiveColumnJson(string Id, string Name, string DataType);
/// <summary>Mode is snapshot (replaced by each sample) or append (grows); Key names the columns that identify a row.</summary>
internal sealed record LiveTableJson(string Id, string Mode, List<LiveColumnJson> Columns, List<string> Key);
/// <summary>FilterMode is memory, restart or none (the probe refuses filters).</summary>
internal sealed record LiveProbeJson(string Id, string Source, string Label, string Description, LiveIntervalJson IntervalMs, List<LiveSeriesJson> Series,
    List<LiveTableJson> Tables, List<string> Status, List<string> Views, string FilterMode);
/// <summary>Scope is server, ssisdb or none (a test source that touches no SQL Server).</summary>
internal sealed record LiveSourceJson(string Id, string Label, string Description, string Scope, bool TestOnly, List<string> Probes);
/// <summary>limits.live of src/shared/ipc/wire/protocol.ts, plus the event body limit.</summary>
internal sealed record LiveLimitsJson(int PortStreams, int BackendSubscriptions, int PerConnection, int Probes, int TablesPerProbe, int AppendPerProbe, int TablesPerTick,
    int Series, int Statuses, int StatusCharacters, int Errors, int MessageCharacters, int NoteCharacters, int Columns, LiveIntervalBoundsJson IntervalMs, int InitialCredit,
    int FrameBudget, int SortColumns, int FilterCharacters, int FilterColumns, int TrackedKeys, int KeyCharacters, int ResumeCharacters, int Kept, int EventBody);

/// <summary>The live catalogue, embedded as live-catalog.json (a vitest file snapshot keeps the copy in sync with
/// src/shared/live/catalog.ts): sources, probes and what each emits, and the live limits. C# holds no ids of its own;
/// unknown members fail the build's own checks, so the two sides cannot drift.</summary>
internal sealed class LiveCatalog
{
    public const int Version = 1;

    private static readonly Lazy<LiveCatalog> Embedded = new(() =>
    {
        using var stream = typeof(LiveCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Live.live-catalog.json")
            ?? throw new InvalidOperationException("The live catalogue is missing from the backend build.");
        return Parse(stream);
    });

    private sealed record CatalogJson(LiveLimitsJson Limits, List<LiveProbeJson> Probes, List<LiveSourceJson> Sources, int Version);

    private LiveCatalog(CatalogJson json)
    {
        if (json.Version != Version) throw new InvalidOperationException("Unsupported live catalogue version.");
        Limits = json.Limits;
        Probes = json.Probes.ToDictionary(probe => probe.Id, StringComparer.Ordinal);
        Sources = json.Sources.ToDictionary(source => source.Id, StringComparer.Ordinal);
    }

    public static LiveCatalog Current => Embedded.Value;

    public static LiveCatalog Parse(Stream stream) => new(JsonSerializer.Deserialize<CatalogJson>(stream,
        new JsonSerializerOptions(JsonSerializerDefaults.Web) { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow })
        ?? throw new InvalidOperationException("The live catalogue is empty."));

    public LiveLimitsJson Limits { get; }
    public IReadOnlyDictionary<string, LiveProbeJson> Probes { get; }
    public IReadOnlyDictionary<string, LiveSourceJson> Sources { get; }
}
