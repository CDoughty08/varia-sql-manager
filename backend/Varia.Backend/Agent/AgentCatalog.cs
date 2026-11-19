using System.Text.Json;

namespace Varia.Backend.Agent;

/// <summary>SQL Server Agent as src/shared/agent/catalog.ts declares it, embedded as agent-catalog.json (a vitest file snapshot
/// keeps the copy in sync): the msdb and master procedures an Agent read may call, the write procedures, the platform gates,
/// code labels and the limits. C# holds no Agent procedure list or bound of its own.</summary>
internal sealed class AgentCatalog
{
    public const int Version = 1;

    private static readonly Lazy<AgentCatalog> Embedded = new(() =>
    {
        using var stream = typeof(AgentCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Agent.agent-catalog.json")
            ?? throw new InvalidOperationException("The Agent catalogue is missing from the backend build.");
        return Parse(stream);
    });

    private sealed record CodeJson(int Code, string Label, string? Tone = null);
    private sealed record ArgumentJson(string Name, List<string>? Constants = null);
    private sealed record ReadJson(string Name, List<ArgumentJson> Arguments);
    private sealed record ShapeJson(string Name, string Shape);
    private sealed record WriteJson(string Name, string Lane, string Database);
    private sealed record GateJson(string Feature, List<string> Platforms);
    private sealed record CatalogJson(int Version, List<int> EngineEditions, List<CodeJson> ExecutionStatuses, List<GateJson> Gates, List<CodeJson> LastRunOutcomes, Dictionary<string, long> Limits,
        List<ShapeJson> MasterReadShapes, Dictionary<string, List<string>> PlatformSubsystems, List<ReadJson> ReadProcedures, List<CodeJson> RunStatuses, List<WriteJson> WriteProcedures,
        List<SubsystemJson>? Subsystems = null);
    private sealed record SubsystemJson(string Id, string Label);

    private readonly Dictionary<string, long> limits;
    private readonly Dictionary<string, HashSet<string>> gates;

    private AgentCatalog(CatalogJson json)
    {
        if (json.Version != Version) throw new InvalidOperationException("Unsupported Agent catalogue version.");
        limits = json.Limits;
        EngineEditions = json.EngineEditions.ToHashSet();
        ReadProcedures = json.ReadProcedures.ToDictionary(row => row.Name, row => new AgentReadProcedure(row.Name,
            row.Arguments.ToDictionary(argument => argument.Name, argument => (IReadOnlySet<string>)(argument.Constants ?? []).ToHashSet(StringComparer.Ordinal), StringComparer.Ordinal)), StringComparer.Ordinal);
        MasterReadShapes = json.MasterReadShapes.ToDictionary(row => row.Name, row => row.Shape, StringComparer.Ordinal);
        WriteProcedures = json.WriteProcedures.ToDictionary(row => row.Name, row => row.Database, StringComparer.Ordinal);
        gates = json.Gates.ToDictionary(row => row.Feature, row => row.Platforms.ToHashSet(StringComparer.Ordinal), StringComparer.Ordinal);
        PlatformSubsystems = json.PlatformSubsystems.ToDictionary(row => row.Key, row => (IReadOnlySet<string>)row.Value.ToHashSet(StringComparer.Ordinal), StringComparer.Ordinal);
        RunStatuses = json.RunStatuses.ToDictionary(row => row.Code, row => row.Label);
        ExecutionStatuses = json.ExecutionStatuses.ToDictionary(row => row.Code, row => row.Label);
        LastRunOutcomes = json.LastRunOutcomes.ToDictionary(row => row.Code, row => row.Label);
        SubsystemLabels = (json.Subsystems ?? []).ToDictionary(row => row.Id, row => row.Label, StringComparer.Ordinal);
        if (ReadProcedures.Keys.Any(WriteProcedures.ContainsKey)) throw new InvalidOperationException("An Agent procedure is both a read and a write.");
    }

    public static AgentCatalog Current => Embedded.Value;

    public static AgentCatalog Parse(Stream stream) => new(JsonSerializer.Deserialize<CatalogJson>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web))
        ?? throw new InvalidOperationException("The Agent catalogue is empty."));

    /// <summary>The engine editions that serve the Agent node.</summary>
    public IReadOnlySet<int> EngineEditions { get; }
    /// <summary>The msdb procedures a read may EXEC, each with its named arguments and the constants each may take.</summary>
    public IReadOnlyDictionary<string, AgentReadProcedure> ReadProcedures { get; }
    /// <summary>The master procedures a read may call, each by its one statement (`@p` stands for a parameter).</summary>
    public IReadOnlyDictionary<string, string> MasterReadShapes { get; }
    /// <summary>The procedures the write lint (AG-2) admits, with their database.</summary>
    public IReadOnlyDictionary<string, string> WriteProcedures { get; }
    public IReadOnlyDictionary<string, IReadOnlySet<string>> PlatformSubsystems { get; }
    public IReadOnlyDictionary<int, string> RunStatuses { get; }
    public IReadOnlyDictionary<int, string> ExecutionStatuses { get; }
    public IReadOnlyDictionary<int, string> LastRunOutcomes { get; }
    /// <summary>SSMS's step-type names by syssubsystems.subsystem (Object Explorer labels the Proxies folder's rows with them).</summary>
    public IReadOnlyDictionary<string, string> SubsystemLabels { get; }

    /// <summary>A limit by its catalogue name; an unknown name is a bug.</summary>
    public long Limit(string name) => limits.TryGetValue(name, out var value) ? value : throw new InvalidOperationException("Unknown Agent limit.");

    /// <summary>Whether a platform (windows, linux, managedInstance) offers a feature; an unknown feature is a bug.</summary>
    public bool Offers(string feature, string platform) => gates.TryGetValue(feature, out var platforms) ? platforms.Contains(platform) : throw new InvalidOperationException("Unknown Agent feature.");

    /// <summary>The platform of a server, as agentPlatform() in the catalogue: null where Agent is not served.</summary>
    public string? PlatformOf(int engineEdition, bool linux) => !EngineEditions.Contains(engineEdition) ? null : engineEdition == 8 ? "managedInstance" : linux ? "linux" : "windows";
}

/// <summary>One allowlisted msdb read procedure: its named arguments, each with the constants it may take instead of a parameter.</summary>
internal sealed record AgentReadProcedure(string Name, IReadOnlyDictionary<string, IReadOnlySet<string>> Arguments);
