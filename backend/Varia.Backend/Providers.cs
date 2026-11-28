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
    internal static readonly string[] BothMethods = ["system.health", "connections.connect", "connections.disconnect", "connections.databases", "databases.list", "query.execute", "query.cancel", "query.session.close", "query.session.state",
        "results.visibility", "results.read", "results.close", "results.setMemoryLimit", "results.rowBytes", "results.view", "results.viewClose",
        "results.identify", "results.rowIds", "results.findRows", "results.diff", "results.search", "results.profile", "results.pivot",
        "results.distinct", "results.distinctRead", "results.distinctTick", "results.distinctClose", "results.copy", "results.export",
        "results.diffSeek", "explorer.children", "explorer.index", "explorer.indexStatus", "explorer.search", "scripting.script", "live.subscribe", "live.update",
        "explorer.indexStore.configure", "explorer.indexStore.clear", "language.lookup"];

    /// <summary>Methods only BigQuery serves. Those without a connection handle (the pre-connect bigquery.account and
    /// bigquery.projects, and results.remoteQuery, which names a windowed result) are BigQuery's by declaration, with
    /// nothing to resolve; bigquery.dryRun names its handle, and a SQL Server handle is refused.</summary>
    internal static readonly string[] BigQueryMethods = ["bigquery.account", "bigquery.projects", "bigquery.connectionProjects", "bigquery.dryRun", "bigquery.properties", "bigquery.indexEstimate", "results.remoteQuery", "query.attach",
        "bigquery.endIdleSessions", "bigquery.cancelJobs", "bigquery.jobs.get", "bigquery.jobs.cancel", "language.hydrate"];
    private static readonly string[] BigQueryOnly = [BigQuery];

    /// <summary>The methods whose provider is their parameters' <c>provider</c> (absent: SQL Server): they open a connection.</summary>
    internal static readonly string[] ParameterMethods = ["connections.connect", "connections.databases", "connections.preview"];

    public static IReadOnlyList<string> Of(string method) => Array.IndexOf(BothMethods, method) >= 0 ? Both : Array.IndexOf(BigQueryMethods, method) >= 0 ? BigQueryOnly : SqlServerOnly;

    /// <summary>A connection options object's provider; a missing one is SQL Server (every 0.9.0 request), anything else
    /// unknown is invalid.</summary>
    public static string OfOptions(JsonElement parameters)
    {
        if (parameters.ValueKind != JsonValueKind.Object || !parameters.TryGetProperty("provider", out var value)) return SqlServer;
        return value.ValueKind == JsonValueKind.String && value.GetString() is SqlServer or BigQuery ? value.GetString()!
            : throw new RequestException("INVALID_PARAMS", "Unknown connection provider.");
    }
}
