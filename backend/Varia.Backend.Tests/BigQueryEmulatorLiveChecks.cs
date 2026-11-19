using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Google;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.BigQuery;

namespace Varia.Backend.Tests;

/// <summary>
/// BigQuery against the emulator VARIA_TEST_BIGQUERY_ENDPOINT names (docs/bigquery.md, Testing; CI starts
/// ghcr.io/goccy/bigquery-emulator pinned by digest with project varia-emulator and dataset varia_fixture). Emulator mode
/// end to end through SqlService (anonymous connect with no probe, the pre-connect methods, disconnect), and the REST calls
/// later lanes build on, through the connection's own client: query jobs with a client job id, result and table paging,
/// scripts, parameters, cancel and metadata. Never a real Google Cloud project.
/// </summary>
internal static class BigQueryEmulatorLiveChecks
{
    public const string Project = "varia-emulator";
    public const string Dataset = "varia_fixture";
    static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static async Task RunAsync(Action<bool, string> check)
    {
        var environment = BigQueryEnvironment.FromEnvironment();
        if (environment.Endpoint is null) throw new InvalidOperationException("Set VARIA_TEST_BIGQUERY_ENDPOINT to the emulator's address, such as http://localhost:9050.");
        await ReadyAsync(environment.Endpoint);
        using var service = new SqlService(bigQuery: environment);
        async Task<(string Code, JsonElement Result, string Message)> Call(string method, JsonNode parameters)
        {
            using var document = JsonDocument.Parse(parameters.ToJsonString());
            try
            {
                var result = await service.DispatchAsync(method, document.RootElement.Clone(), Wire);
                return ("ok", JsonSerializer.SerializeToElement(result, result.GetType(), Wire), "");
            }
            catch (RequestException error) { return (error.Code, default, error.Message); }
        }
        static string Text(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var member) && member.ValueKind == JsonValueKind.String ? member.GetString()! : "";
        var anonymous = new JsonObject { ["source"] = "anonymous" };

        var account = await Call("bigquery.account", new JsonObject { ["authentication"] = "gcloud", ["credential"] = anonymous.DeepClone() });
        check(account.Code == "ok" && Text(account.Result, "kind") == "emulator", $"emulator: bigquery.account answers the anonymous emulator account: {account.Code} {account.Message} {account.Result}");
        var projects = await Call("bigquery.projects", new JsonObject { ["authentication"] = "gcloud", ["credential"] = anonymous.DeepClone() });
        check(projects.Code == "ok" && projects.Result.GetProperty("projects").EnumerateArray().Any(project => Text(project, "id") == Project),
            $"emulator: bigquery.projects lists the emulator's project, which it names only by id: {projects.Code} {projects.Message} {projects.Result}");
        var (code, info, message) = await Call("connections.connect", new JsonObject
        {
            ["provider"] = "bigquery", ["project"] = Project, ["dataset"] = Dataset, ["authentication"] = "gcloud", ["credential"] = anonymous.DeepClone()
        });
        var connection = service.BigQuery.Find(Text(info, "id"));
        check(code == "ok" && connection is not null && Text(info, "principalId") == "bigquery:anonymous:emulator" && Text(info, "database") == Dataset && Text(info, "providerId") == "bigquery",
            $"emulator: connect opens a BigQuery handle anonymously, with no probe (the emulator cannot dry-run): {code} {message} {info}");
        if (connection is null) return;
        var estimate = await service.BigQuery.EstimateAsync(connection, "SELECT 1", CancellationToken.None);
        check(estimate.Faked, "emulator: estimates are faked, since the emulator answers dry runs with HTTP 500");

        var client = connection.Client;
        var table = "orders_" + Guid.NewGuid().ToString("N")[..12];
        try
        {
            await client.CreateTableAsync(Project, Dataset, table, new TableSchema
            {
                Fields = [new() { Name = "id", Type = "INT64", Mode = "REQUIRED" }, new() { Name = "customer", Type = "STRING" }, new() { Name = "amount", Type = "NUMERIC" }]
            });
            await client.InsertRowsAsync(Project, Dataset, table, Enumerable.Range(1, 25).Select(id => new Google.Cloud.BigQuery.V2.BigQueryInsertRow
            {
                ["id"] = id, ["customer"] = "customer " + id, ["amount"] = Google.Cloud.BigQuery.V2.BigQueryNumeric.Parse((id * 1.5m).ToString(System.Globalization.CultureInfo.InvariantCulture))
            }));
            var api = client.Service;

            // A query job with a client job id (BQ-3a): insert, look it up by id, then page its results.
            var jobId = "varia_" + Guid.NewGuid().ToString("N");
            var inserted = await api.Jobs.Insert(new Job
            {
                JobReference = new JobReference { ProjectId = Project, JobId = jobId },
                Configuration = new JobConfiguration { Labels = new Dictionary<string, string>(BigQueryService.Labels), Query = new JobConfigurationQuery { Query = $"SELECT id, customer FROM `{Project}.{Dataset}.{table}` ORDER BY id", UseLegacySql = false } }
            }, Project).ExecuteAsync();
            var looked = await api.Jobs.Get(Project, jobId).ExecuteAsync();
            check(inserted.JobReference?.JobId == jobId && looked.JobReference?.JobId == jobId && looked.Status?.State == "DONE" && looked.Status?.ErrorResult is null,
                $"emulator: a query job keeps its client job id and is found by it, done: {looked.Status?.State}");
            var rows = new List<string>();
            string? pageToken = null;
            var pages = 0;
            do
            {
                var request = api.Jobs.GetQueryResults(Project, jobId);
                request.MaxResults = 10;
                request.PageToken = pageToken;
                var page = await request.ExecuteAsync();
                rows.AddRange(page.Rows?.Select(row => row.F[0].V?.ToString() ?? "") ?? []);
                pageToken = page.PageToken;
                pages++;
            } while (pageToken is { Length: > 0 } && pages < 10);
            check(rows.Count == 25 && rows[0] == "1" && rows[^1] == "25" && pages == 3, $"emulator: getQueryResults pages a job's 25 rows ten at a time in order: {rows.Count} rows in {pages} pages");

            var listed = new List<string>();
            pageToken = null;
            pages = 0;
            do
            {
                var request = api.Tabledata.List(Project, Dataset, table);
                request.MaxResults = 10;
                request.PageToken = pageToken;
                var page = await request.ExecuteAsync();
                listed.AddRange(page.Rows?.Select(row => row.F[0].V?.ToString() ?? "") ?? []);
                pageToken = page.PageToken;
                pages++;
            } while (pageToken is { Length: > 0 } && pages < 10);
            // The emulator ignores tabledata.list's maxResults and answers every row at once (Google pages them); Preview Rows'
            // paging is held to the offline fake instead. Should a newer emulator page, this check says so.
            check(listed.Count == 25 && listed.Order(StringComparer.Ordinal).SequenceEqual(rows.Order(StringComparer.Ordinal)) && pages == 1,
                $"emulator: tabledata.list answers a table's 25 rows, in one page whatever maxResults asks: {listed.Count} rows in {pages} pages");

            var script = await client.ExecuteQueryAsync("DECLARE factor INT64 DEFAULT 21; SELECT factor * 2 AS answer;", parameters: null);
            check(script.Select(row => row["answer"]?.ToString()).SingleOrDefault() == "42", "emulator: a multi-statement script answers its last statement's rows");

            var counted = await client.ExecuteQueryAsync($"SELECT COUNT(*) AS n FROM `{Project}.{Dataset}.{table}` WHERE id > @minimum AND customer != @skip",
                [new Google.Cloud.BigQuery.V2.BigQueryParameter("minimum", Google.Cloud.BigQuery.V2.BigQueryDbType.Int64, 20), new Google.Cloud.BigQuery.V2.BigQueryParameter("skip", Google.Cloud.BigQuery.V2.BigQueryDbType.String, "customer 25")]);
            check(counted.Select(row => row["n"]?.ToString()).SingleOrDefault() == "4", "emulator: named query parameters of each type bind as values");

            // The emulator finishes jobs synchronously, so cancel meets a finished job; it must still answer (Job History's Cancel).
            var cancelled = await api.Jobs.Cancel(Project, jobId).ExecuteAsync();
            check(cancelled.Job?.JobReference?.JobId == jobId && cancelled.Job.Status?.State == "DONE", $"emulator: jobs.cancel of a finished job answers the job, done: {cancelled.Job?.Status?.State}");

            var history = await api.Jobs.List(Project).ExecuteAsync();
            check(history.Jobs?.Any(job => job.JobReference?.JobId == jobId) == true, "emulator: jobs.list includes the job by its id");
            var datasets = await api.Datasets.List(Project).ExecuteAsync();
            var described = await api.Tables.Get(Project, Dataset, table).ExecuteAsync();
            var tables = await api.Tables.List(Project, Dataset).ExecuteAsync();
            check(datasets.Datasets?.Any(dataset => dataset.DatasetReference?.DatasetId == Dataset) == true && tables.Tables?.Any(item => item.TableReference?.TableId == table) == true
                // Google answers the legacy spelling INTEGER for INT64, the emulator the type as created: the converter takes both.
                && described.Schema?.Fields?.Select(field => field.Name + ":" + (field.Type == "INTEGER" ? "INT64" : field.Type)).SequenceEqual(["id:INT64", "customer:STRING", "amount:NUMERIC"]) == true,
                $"emulator: REST metadata lists datasets and tables and describes a table's columns: {string.Join(",", described.Schema?.Fields?.Select(field => field.Name + ":" + field.Type) ?? [])}");

            var missing = await Outcome(() => api.Datasets.Get(Project, "no_such_dataset").ExecuteAsync());
            check(missing.StartsWith("NOT_FOUND", StringComparison.Ordinal), $"emulator: a missing dataset maps to NOT_FOUND: {missing}");
        }
        finally
        {
            try { await client.DeleteTableAsync(Project, Dataset, table); } catch (GoogleApiException) { }
        }

        var (closed, disconnected, _) = await Call("connections.disconnect", new JsonObject { ["connectionId"] = connection.Id });
        check(closed == "ok" && disconnected.GetProperty("disconnected").GetBoolean() && service.BigQuery.Count == 0, "emulator: disconnect releases the BigQuery handle");
    }

    static async Task<string> Outcome(Func<Task> call)
    {
        try { await call(); return "ok"; }
        catch (Exception error) when (BigQueryErrors.Map(error, Project) is RequestException mapped) { return mapped.Code + ": " + mapped.Message; }
    }

    /// <summary>Waits for a just-started emulator to answer (generous, returning as soon as it does).</summary>
    static async Task ReadyAsync(Uri endpoint)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
        var started = Stopwatch.StartNew();
        while (true)
        {
            try
            {
                using var response = await http.GetAsync(new Uri(endpoint, "bigquery/v2/projects"));
                if (response.IsSuccessStatusCode) return;
            }
            catch (Exception error) when (error is HttpRequestException or TaskCanceledException) { }
            if (started.Elapsed > TimeSpan.FromSeconds(90)) throw new InvalidOperationException("The BigQuery emulator did not answer within 90 seconds.");
            await Task.Delay(250);
        }
    }
}
