using System.Text.Json;

namespace Varia.Backend;

/// <summary>The database engines (src/shared/providers.ts) and which methods serve each. A method serves SQL Server only
/// unless it is listed in <see cref="BothMethods"/>, which mirrors methodPolicies' <c>providers</c> (tests/validation.test.ts
/// compares the two), so a new method is SQL Server's until it says otherwise.</summary>
internal static class Providers
{
    public const string SqlServer = "sqlserver";
    public const string BigQuery = "bigquery";
    private static readonly string[] Both = [SqlServer, BigQuery];
    private static readonly string[] SqlServerOnly = [SqlServer];

    /// <summary>Methods declared for both engines: those that name a query, session or result rather than a connection, and
    /// system.health. SqlService resolves their provider from what the id names.</summary>
    internal static readonly string[] BothMethods = ["system.health", "query.cancel", "query.session.close", "query.session.state",
        "results.visibility", "results.read", "results.close", "results.setMemoryLimit", "results.rowBytes", "results.view", "results.viewClose",
        "results.identify", "results.rowIds", "results.findRows", "results.diff", "results.search", "results.profile", "results.pivot",
        "results.distinct", "results.distinctRead", "results.distinctTick", "results.distinctClose", "results.copy", "results.export"];

    /// <summary>The methods whose provider is their parameters' <c>provider</c> (absent: SQL Server): they open a connection.</summary>
    internal static readonly string[] ParameterMethods = ["connections.connect", "connections.databases", "connections.preview"];

    public static IReadOnlyList<string> Of(string method) => Array.IndexOf(BothMethods, method) >= 0 ? Both : SqlServerOnly;

    /// <summary>A connection options object's provider; a missing one is SQL Server (every 0.9.0 request), anything else
    /// unknown is invalid.</summary>
    public static string OfOptions(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object || !parameters.TryGetProperty("provider", out var value)) return SqlServer;
        return value.ValueKind == JsonValueKind.String && value.GetString() is SqlServer or BigQuery ? value.GetString()!
            : throw new RequestException("INVALID_PARAMS", "Unknown connection provider.");
    }

    /// <summary>SQL Server's connection options: a <c>provider</c> of <c>sqlserver</c> is taken off, so the positional
    /// <see cref="ConnectOptions"/> record keeps refusing every member it does not know.</summary>
    public static JsonElement WithoutProvider(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object || !parameters.TryGetProperty("provider", out _)) return parameters;
        using var buffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            foreach (var property in parameters.EnumerateObject())
                if (property.Name != "provider") property.WriteTo(writer);
            writer.WriteEndObject();
        }
        using var document = JsonDocument.Parse(buffer.ToArray());
        return document.RootElement.Clone();
    }
}
