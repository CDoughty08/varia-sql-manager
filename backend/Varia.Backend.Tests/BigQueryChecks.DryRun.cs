using System.Globalization;
using System.Text.Json.Nodes;

namespace Varia.Backend.Tests;

/// <summary>
/// bigquery.dryRun offline (docs/bigquery.md, Cost): the free estimate and dry-run diagnostics through SqlService.DispatchAsync,
/// against dry-run answers in the shapes Google documents (the emulator does not dry-run). The request's body, the estimate
/// and each reason it may be low, a refused query's <c>[line:column]</c>, the limits, and handles that are not BigQuery's.
/// </summary>
internal static partial class BigQueryChecks
{
    /// <summary>A dry run's answer: its bytes, statement type, BigQuery's accuracy and whether it read tables.</summary>
    static string DryRunAnswer(long bytes, string statement = "SELECT", string? accuracy = null, bool tables = true)
    {
        var figure = bytes.ToString(CultureInfo.InvariantCulture);
        var query = new JsonObject { ["totalBytesProcessed"] = figure, ["statementType"] = statement, ["cacheHit"] = false };
        if (accuracy is not null) query["totalBytesProcessedAccuracy"] = accuracy;
        if (tables) query["referencedTables"] = new JsonArray(new JsonObject { ["projectId"] = "varia-alpha", ["datasetId"] = "sales", ["tableId"] = "orders" });
        return new JsonObject
        {
            ["kind"] = "bigquery#job", ["configuration"] = new JsonObject { ["dryRun"] = true, ["jobType"] = "QUERY" },
            ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["location"] = "US" },
            ["statistics"] = new JsonObject { ["totalBytesProcessed"] = figure, ["query"] = query },
            ["status"] = new JsonObject { ["state"] = "DONE" }
        }.ToJsonString();
    }

    static async Task DryRunAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        var (connected, info, _) = await harness.Call("connections.connect", KeyConnect(key));
        var id = Text(info, "id");
        JsonObject Args(string sql, string? dataset = null)
        {
            var args = new JsonObject { ["connectionId"] = id, ["sql"] = sql };
            if (dataset is not null) args["dataset"] = dataset;
            return args;
        }
        var reply = DryRunAnswer(1_331_439_861_760);
        harness.Fake.On("POST", BigQueryFake.Jobs, _ => new BigQueryFake.Reply(200, reply));

        var before = harness.Fake.To(BigQueryFake.Jobs).Count();
        var plain = await harness.Call("bigquery.dryRun", Args("SELECT * FROM orders", "sales"));
        var body = JsonNode.Parse(harness.Fake.To(BigQueryFake.Jobs).Last().Body)!;
        check(connected == "ok" && plain.Code == "ok" && plain.Result.GetProperty("bytesProcessed").GetInt64() == 1_331_439_861_760 && !plain.Result.TryGetProperty("incomplete", out _)
            && plain.Result.GetProperty("statementType").GetString() == "SELECT" && harness.Fake.To(BigQueryFake.Jobs).Count() == before + 1
            && body["configuration"]?["dryRun"]?.GetValue<bool>() == true && body["configuration"]?["query"]?["query"]?.GetValue<string>() == "SELECT * FROM orders"
            && body["configuration"]?["query"]?["useLegacySql"]?.GetValue<bool>() == false
            && body["configuration"]?["query"]?["defaultDataset"]?["datasetId"]?.GetValue<string>() == "sales" && body["jobReference"]?["jobId"] is null,
            $"bigquery.dryRun is one dry-run job with the tab's dataset, answering its bytes: {plain.Code} {plain.Message} {plain.Result} {body}");

        foreach (var (answer, expected, what) in new (string, string?, string)[]
        {
            (DryRunAnswer(20_971_520, "SCRIPT"), "script", "a script, estimated only up to its first DDL or control statement"),
            (DryRunAnswer(10_485_760, accuracy: "LOWER_BOUND"), "lowerBound", "a lower bound"),
            (DryRunAnswer(10_485_760, accuracy: "UNKNOWN"), "unknown", "an unknown accuracy"),
            (DryRunAnswer(0), "zeroBytes", "0 bytes from tables that were read (external or row-level-security tables)"),
            (DryRunAnswer(0, tables: false), null, "0 bytes from no table (SELECT 1)"),
            (DryRunAnswer(0, "DROP_TABLE"), null, "0 bytes from DDL that names a table"),
            (DryRunAnswer(0, "TRUNCATE_TABLE"), null, "0 bytes from TRUNCATE TABLE"),
            (DryRunAnswer(0, "CREATE_TABLE_AS_SELECT"), "zeroBytes", "0 bytes from CREATE TABLE AS SELECT over tables that were read"),
            (DryRunAnswer(0, "MERGE"), "zeroBytes", "0 bytes from MERGE over tables that were read"),
            (DryRunAnswer(10_485_760, accuracy: "PRECISE"), null, "a precise figure")
        })
        {
            harness.Fake.On("POST", BigQueryFake.Jobs, _ => new BigQueryFake.Reply(200, answer));
            var outcome = await harness.Call("bigquery.dryRun", Args("SELECT 1"));
            var incomplete = outcome.Code == "ok" && outcome.Result.TryGetProperty("incomplete", out var value) ? value.GetString() : null;
            check(outcome.Code == "ok" && incomplete == expected, $"a dry run marks {what} as incomplete={expected ?? "none"}: {outcome.Code} {outcome.Result}");
        }

        var refusalText = "Unrecognized name: order_totl; Did you mean order_total? at [5:7]";
        var refusal = new JsonObject
        {
            ["error"] = new JsonObject
            {
                ["code"] = 400, ["message"] = refusalText, ["status"] = "INVALID_ARGUMENT",
                ["errors"] = new JsonArray(new JsonObject { ["message"] = refusalText, ["domain"] = "global", ["reason"] = "invalidQuery", ["location"] = "q", ["locationType"] = "parameter" })
            }
        }.ToJsonString();
        harness.Fake.On("POST", BigQueryFake.Jobs, _ => new BigQueryFake.Reply(400, refusal));
        var refused = await harness.Call("bigquery.dryRun", Args("SELECT SUM(order_totl) FROM orders"));
        check(refused.Code == "SQL_ERROR" && refused.Message.Contains("[5:7]", StringComparison.Ordinal) && refused.Message.Contains("order_totl", StringComparison.Ordinal),
            $"a query BigQuery refuses is SQL_ERROR with BigQuery's text and [line:column]: {refused.Code} {refused.Message}");
        harness.Fake.On("POST", BigQueryFake.Jobs, BigQueryFake.Fixture("error-access-denied", 403));
        var denied = await harness.Call("bigquery.dryRun", Args("SELECT 1"));
        check(denied.Code == "PERMISSION_DENIED" && !denied.Message.Contains("Job User", StringComparison.Ordinal), $"a refused dry run maps as other BigQuery errors do, without the Job User hint: {denied.Code} {denied.Message}");
        // Connecting proved bigquery.jobs.create: a 403 on a dry run is about a table the query reads, so Google's text stays.
        string Refusal(int code, string status, string reason, string message) => new JsonObject
        {
            ["error"] = new JsonObject { ["code"] = code, ["message"] = message, ["status"] = status, ["errors"] = new JsonArray(new JsonObject { ["message"] = message, ["domain"] = "global", ["reason"] = reason }) }
        }.ToJsonString();
        harness.Fake.On("POST", BigQueryFake.Jobs, _ => new BigQueryFake.Reply(403, Refusal(403, "PERMISSION_DENIED", "accessDenied", "Access Denied: Table other-proj:ds.t: User does not have permission to query table other-proj:ds.t.")));
        var table = await harness.Call("bigquery.dryRun", Args("SELECT * FROM `other-proj.ds.t`"));
        check(table.Code == "PERMISSION_DENIED" && table.Message.Contains("permission to query table other-proj:ds.t", StringComparison.Ordinal) && !table.Message.Contains("Job User", StringComparison.Ordinal),
            $"a dry run refused for a table keeps Google's text and does not blame bigquery.jobs.create: {table.Code} {table.Message}");
        harness.Fake.On("POST", BigQueryFake.Jobs, _ => new BigQueryFake.Reply(404, Refusal(404, "NOT_FOUND", "notFound", "Not found: Table varia-alpha:sales.ordrs was not found in location US")));
        var missing = await harness.Call("bigquery.dryRun", Args("SELECT * FROM ordrs", "sales"));
        check(missing.Code == "SQL_ERROR" && missing.Message == "Not found: Table varia-alpha:sales.ordrs was not found in location US",
            $"a dry run naming a missing table is the query's error, with Google's text and no project hint: {missing.Code} {missing.Message}");
        // A dataset in another location is told apart as Execute tells it, and a missing project stays NOT_FOUND.
        harness.Fake.On("POST", BigQueryFake.Jobs, _ => new BigQueryFake.Reply(404, Refusal(404, "NOT_FOUND", "notFound", "Not found: Dataset varia-alpha:sales_eu was not found in location US")));
        harness.Fake.On("GET", BigQueryFake.Datasets, new BigQueryFake.Reply(200, "{\"kind\":\"bigquery#dataset\",\"datasetReference\":{\"projectId\":\"varia-alpha\",\"datasetId\":\"sales_eu\"},\"location\":\"EU\"}"));
        var elsewhere = await harness.Call("bigquery.dryRun", Args("SELECT * FROM sales_eu.orders"));
        check(elsewhere.Code == "LOCATION_MISMATCH" && elsewhere.Message.Contains("is in location EU, but the query ran in US", StringComparison.Ordinal),
            $"a dry run against a dataset in another location is LOCATION_MISMATCH, as Execute says: {elsewhere.Code} {elsewhere.Message}");
        // A table name may hold spaces; the whole name is kept, without NOT_FOUND's project hint.
        harness.Fake.On("POST", BigQueryFake.Jobs, _ => new BigQueryFake.Reply(404, Refusal(404, "NOT_FOUND", "notFound", "Not found: Table varia-alpha:sales.my orders was not found in location US")));
        var spaced = await harness.Call("bigquery.dryRun", Args("SELECT * FROM `sales.my orders`"));
        check(spaced.Code == "SQL_ERROR" && spaced.Message == "Not found: Table varia-alpha:sales.my orders was not found in location US",
            $"a missing table whose name holds a space keeps its whole name: {spaced.Code} {spaced.Message}");
        harness.Fake.On("POST", BigQueryFake.Jobs, _ => new BigQueryFake.Reply(404, Refusal(404, "NOT_FOUND", "notFound", "Not found: Table varia-alpha:sales.my orders")));
        var bare = await harness.Call("bigquery.dryRun", Args("SELECT * FROM `sales.my orders`"));
        check(bare.Code == "SQL_ERROR" && bare.Message == "Not found: Table varia-alpha:sales.my orders",
            $"a missing table without a location clause is the query's error without the project hint: {bare.Code} {bare.Message}");
        // A dataset that exists nowhere (datasets.get answers 404) is the query's error too, not a location mismatch.
        harness.Fake.On("POST", BigQueryFake.Jobs, _ => new BigQueryFake.Reply(404, Refusal(404, "NOT_FOUND", "notFound", "Not found: Dataset varia-alpha:salez was not found in location US")));
        harness.Fake.On("GET", BigQueryFake.Datasets, new BigQueryFake.Reply(404, Refusal(404, "NOT_FOUND", "notFound", "Not found: Dataset varia-alpha:salez")));
        var noDataset = await harness.Call("bigquery.dryRun", Args("SELECT * FROM salez.orders"));
        check(noDataset.Code == "SQL_ERROR" && noDataset.Message == "Not found: Dataset varia-alpha:salez was not found in location US",
            $"a dry run naming a dataset that does not exist is the query's error: {noDataset.Code} {noDataset.Message}");
        harness.Fake.On("POST", BigQueryFake.Jobs, _ => new BigQueryFake.Reply(404, Refusal(404, "NOT_FOUND", "notFound", "Not found: Project varia-alpha")));
        var gone = await harness.Call("bigquery.dryRun", Args("SELECT 1"));
        check(gone.Code == "NOT_FOUND", $"a dry run in a project that no longer exists is NOT_FOUND, not a query error: {gone.Code} {gone.Message}");

        var jobs = harness.Fake.To(BigQueryFake.Jobs).Count();
        var legacy = await harness.Call("bigquery.dryRun", Args("#legacySQL\nSELECT 1"));
        var empty = await harness.Call("bigquery.dryRun", Args("  \n "));
        var huge = await harness.Call("bigquery.dryRun", Args(new string('x', 1_000_001)));
        var badDataset = await harness.Call("bigquery.dryRun", Args("SELECT 1", "sales;drop"));
        var unknownField = await harness.Call("bigquery.dryRun", new JsonObject { ["connectionId"] = id, ["sql"] = "SELECT 1", ["sessionId"] = Guid.NewGuid().ToString() });
        check(legacy.Code == "LEGACY_SQL" && empty.Code == "INVALID_PARAMS" && huge.Code == "INVALID_PARAMS" && badDataset.Code == "INVALID_PARAMS" && unknownField.Code == "INVALID_PARAMS"
            && harness.Fake.To(BigQueryFake.Jobs).Count() == jobs,
            $"legacy SQL, blank or over-long text, a bad dataset and unknown fields are refused before any job: {legacy.Code} {empty.Code} {huge.Code} {badDataset.Code} {unknownField.Code}");

        var sqlServer = await harness.Call("bigquery.dryRun", new JsonObject { ["connectionId"] = Guid.NewGuid().ToString(), ["sql"] = "SELECT 1" });
        await harness.Call("connections.disconnect", new JsonObject { ["connectionId"] = id });
        var closed = await harness.Call("bigquery.dryRun", Args("SELECT 1"));
        check(sqlServer.Code == "UNSUPPORTED_PROVIDER" && closed.Code is "UNSUPPORTED_PROVIDER" or "NOT_CONNECTED" && harness.Fake.To(BigQueryFake.Jobs).Count() == jobs,
            $"bigquery.dryRun on a handle that is not BigQuery's, or one closed, dry-runs nothing: {sqlServer.Code} {closed.Code}");
        Clean(check, harness.Fake, "bigquery.dryRun");
    }
}
