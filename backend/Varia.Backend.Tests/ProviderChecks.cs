using System.Text.Json;
using System.Text.Json.Serialization;

namespace Varia.Backend.Tests;

/// <summary>SqlService.DispatchAsync refuses a method for another engine's connection first thing (Providers), with a stub
/// provider standing in for a BigQuery handle where a check needs one without connecting.</summary>
internal static class ProviderChecks
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var wire = new JsonSerializerOptions(JsonSerializerDefaults.Web) { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
        static JsonElement Parse(string text) { using var document = JsonDocument.Parse(text); return document.RootElement.Clone(); }
        const string options = """{"server":"sql-prod-01","database":"Sales","authentication":"windows","trustServerCertificate":false}""";
        var withProvider = (string provider) => Parse(options.Replace("{", "{\"provider\":\"" + provider + "\",", StringComparison.Ordinal));

        using var service = new SqlService();
        var preview = await Code(() => service.DispatchAsync("connections.preview", Parse(options), wire));
        var previewSqlServer = await Code(() => service.DispatchAsync("connections.preview", withProvider("sqlserver"), wire));
        var previewBigQuery = await Code(() => service.DispatchAsync("connections.preview", withProvider("bigquery"), wire));
        var previewUnknown = await Code(() => service.DispatchAsync("connections.preview", withProvider("postgres"), wire));
        var connectBigQuery = await Code(() => service.DispatchAsync("connections.connect", withProvider("bigquery"), wire));
        var previewText = JsonSerializer.Serialize(await service.DispatchAsync("connections.preview", Parse(options), wire), wire);
        var previewSqlServerText = JsonSerializer.Serialize(await service.DispatchAsync("connections.preview", withProvider("sqlserver"), wire), wire);
        check(previewText == previewSqlServerText, "options naming 'sqlserver' read the same as options without a provider");
        // Options a caller serialises from the record (as the live checks do) carry no provider member and pass the check.
        var serialised = JsonSerializer.SerializeToElement(new ConnectOptions("sql-prod-01", "Sales", "windows", null, null, false), new JsonSerializerOptions(JsonSerializerDefaults.Web));
        var previewSerialised = await Code(() => service.DispatchAsync("connections.preview", serialised, wire));
        check(!serialised.TryGetProperty("provider", out _) && previewSerialised == "ok", $"serialised ConnectOptions write no provider and are SQL Server's: {previewSerialised}");
        check(preview == "ok" && previewSqlServer == "ok" && previewBigQuery == "UNSUPPORTED_PROVIDER" && connectBigQuery == "INVALID_PARAMS" && previewUnknown == "INVALID_PARAMS",
            $"options without a provider and with 'sqlserver' are SQL Server's; 'bigquery' preview is refused with UNSUPPORTED_PROVIDER, a BigQuery connect reads BigQuery's options (SQL Server's are invalid for it), and an unknown provider is invalid: {preview} {previewSqlServer} {previewBigQuery} {connectBigQuery} {previewUnknown}");

        var connectionId = Guid.NewGuid().ToString();
        var byHandle = Parse($$"""{"connectionId":"{{connectionId}}","database":"sales","schema":"dbo","name":"orders"}""");
        var sqlServerHandle = await Code(() => service.DispatchAsync("tables.columns", byHandle, wire));
        service.ConnectionProvider = id => id == connectionId ? Providers.BigQuery : Providers.SqlServer;
        var bigQueryHandle = await Code(() => service.DispatchAsync("tables.columns", byHandle, wire));
        // Object Explorer's tree serves both engines; Peek is SQL Server's.
        var bigQueryExplorer = await Code(() => service.DispatchAsync("explorer.peek", Parse($$"""{"connectionId":"{{connectionId}}","requestId":"{{Guid.NewGuid()}}","nodeId":"server"}"""), wire));
        var bigQueryLanguage = await Code(() => service.DispatchAsync("language.complete", Parse($$"""{"text":"","context":{"providerId":"sqlserver","connectionId":"{{connectionId}}"},"position":{"line":1,"column":1} }"""), wire));
        check(bigQueryLanguage == "UNSUPPORTED_PROVIDER", $"a language request for a stub BigQuery connection, named in its context, is refused with UNSUPPORTED_PROVIDER: {bigQueryLanguage}");
        check(sqlServerHandle != "UNSUPPORTED_PROVIDER" && bigQueryHandle == "UNSUPPORTED_PROVIDER" && bigQueryExplorer == "UNSUPPORTED_PROVIDER",
            $"a SQL Server-only method for a stub BigQuery connection handle is refused with UNSUPPORTED_PROVIDER, and the same handle as SQL Server's is not: {sqlServerHandle} {bigQueryHandle} {bigQueryExplorer}");

        service.RequestProvider = (_, _) => Providers.BigQuery;
        var closeBigQuery = await Code(() => service.DispatchAsync("results.close", Parse("""{"resultIds":[4242]}"""), wire));
        var health = await Code(() => service.DispatchAsync("system.health", Parse("{}"), wire));
        var planBigQuery = await Code(() => service.DispatchAsync("plans.estimate", Parse("{}"), wire));
        check(closeBigQuery != "UNSUPPORTED_PROVIDER" && health == "ok" && planBigQuery == "UNSUPPORTED_PROVIDER",
            $"a method declared for both engines passes the check for a BigQuery request, and a SQL Server-only one does not: {closeBigQuery} {health} {planBigQuery}");

        check(Providers.Of("results.read").SequenceEqual([Providers.SqlServer, Providers.BigQuery]) && Providers.Of("connections.connect").SequenceEqual([Providers.SqlServer, Providers.BigQuery]) && Providers.Of("bigquery.projects").SequenceEqual([Providers.BigQuery]) && Providers.Of("connections.preview").SequenceEqual([Providers.SqlServer])
            && Providers.Of("not.a.method").SequenceEqual([Providers.SqlServer]),
            "a method serves SQL Server only unless Providers.BothMethods names it");
    }

    private static async Task<string> Code(Func<Task> call)
    {
        try { await call(); return "ok"; }
        catch (RequestException error) { return error.Code; }
        catch (JsonException) { return "INVALID_PARAMS"; }
    }
}
