using System.Diagnostics;
using System.Globalization;
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
        using var service = new SqlService(CheckStores.Unprobed(), bigQuery: environment);
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

            await ExecuteAsync(check, service, connection.Id, table);
            await StorageReadAsync(check, environment);
            await ExplorerAsync(check, service, connection.Id, table);

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

    /// <summary>Object Explorer, Preview Rows and Script As end to end (docs/bigquery.md, Object Explorer): the emulator's datasets.list,
    /// tables.list, tables.get and tabledata.list behind explorer.children, query.execute's preview and scripting.script.</summary>
    static async Task ExplorerAsync(Action<bool, string> check, SqlService service, string connectionId, string table)
    {
        async Task<(string Code, object? Result, string Message)> Call(string method, JsonNode parameters)
        {
            using var document = JsonDocument.Parse(parameters.ToJsonString());
            try { return ("ok", await service.DispatchAsync(method, document.RootElement.Clone(), Wire), ""); }
            catch (RequestException error) { return (error.Code, null, error.Message); }
        }
        JsonObject Children(JsonObject node) => new() { ["connectionId"] = connectionId, ["requestId"] = Guid.NewGuid().ToString(), ["node"] = node, ["pageSize"] = 500 };
        var project = new JsonObject { ["kind"] = "bqProject", ["name"] = Project };
        var dataset = new JsonObject { ["kind"] = "bqDataset", ["name"] = Dataset, ["project"] = Project };
        var orders = new JsonObject { ["kind"] = "bqTable", ["name"] = table, ["project"] = Project, ["dataset"] = Dataset };

        var datasets = await Call("explorer.children", Children(new JsonObject { ["type"] = "object", ["object"] = project }));
        check(datasets is { Code: "ok", Result: ExplorerChildrenResult { Error: null } listed } && listed.Nodes.Any(node => node.Label == Dataset),
            $"emulator: a project lists its datasets in Object Explorer: {datasets.Code} {datasets.Message} {(datasets.Result as ExplorerChildrenResult)?.Error?.Message}");
        var tables = await Call("explorer.children", Children(new JsonObject { ["type"] = "folder", ["owner"] = dataset, ["folder"] = "bqTables" }));
        check(tables is { Code: "ok", Result: ExplorerChildrenResult { Error: null } rows } && rows.Nodes.Any(node => node.Label == table && node.Ref.Object?.Kind == "bqTable"),
            $"emulator: a dataset's Tables folder lists the table: {tables.Code} {tables.Message} {(tables.Result as ExplorerChildrenResult)?.Error?.Message}");
        var columns = await Call("explorer.children", Children(new JsonObject { ["type"] = "folder", ["owner"] = orders.DeepClone(), ["folder"] = "bqColumns" }));
        var labels = (columns.Result as ExplorerChildrenResult)?.Nodes.Select(node => node.Label + " " + node.Sublabel).ToArray() ?? [];
        check(labels.SequenceEqual(["id INT64, required", "customer STRING", "amount NUMERIC"]), "emulator: a table's Columns show each column's type: " + string.Join(", ", labels));

        var preview = await Call("query.execute", new JsonObject
        {
            ["connectionId"] = connectionId, ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = "SELECT 1", ["maxRows"] = 0, ["timeoutSeconds"] = 0,
            ["preview"] = new JsonObject { ["project"] = Project, ["dataset"] = Dataset, ["table"] = table }
        });
        var result = preview.Result as QueryResult;
        check(result is { Status: "completed" } && result.ResultSets.Single().RowsStored == 25,
            $"emulator: Preview Rows reads the table's rows with tabledata.list: {preview.Code} {preview.Message} {result?.Status} {result?.Error?.Message} {result?.ResultSets.FirstOrDefault()?.RowsStored}");

        var options = new JsonObject();
        foreach (var option in Varia.Backend.Scripting.ScriptingCatalog.Current.Options) options[option.Key] = JsonNode.Parse(option.Default.GetRawText());
        var script = await Call("scripting.script", new JsonObject
        {
            ["connectionId"] = connectionId, ["requestId"] = Guid.NewGuid().ToString(), ["targets"] = new JsonArray(orders.DeepClone()), ["verb"] = "select", ["options"] = options
        });
        var text = (script.Result as ScriptResult)?.Text ?? "";
        check(text.Contains("`customer`", StringComparison.Ordinal) && text.Contains($"FROM `{Project}`.`{Dataset}`.`{table}`", StringComparison.Ordinal),
            $"emulator: Script As › SELECT names the table's columns from tables.get: {script.Code} {script.Message} {(script.Result as ScriptResult)?.Error?.Message}");
    }

    /// <summary>query.execute end to end (docs/bigquery.md, Execution): a job per query, results polled and paged into the
    /// result store, every type through the converter, a script on the connection's default dataset, DML and a failure.</summary>
    static async Task ExecuteAsync(Action<bool, string> check, SqlService service, string connectionId, string table)
    {
        async Task<(string Code, QueryResult? Result, string Message)> Execute(string sql, int maxRows = 0)
        {
            var args = new JsonObject
            {
                ["connectionId"] = connectionId, ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = sql, ["maxRows"] = maxRows,
                // No execution timeout: the emulator refuses jobTimeoutMs as a JSON number (Google takes int64 fields as numbers
                // or strings), so the offline checks hold the timeout instead.
                ["timeoutSeconds"] = 0
            };
            using var document = JsonDocument.Parse(args.ToJsonString());
            try { return ("ok", await service.DispatchAsync("query.execute", document.RootElement.Clone(), Wire) as QueryResult, ""); }
            catch (RequestException error) { return (error.Code, null, error.Message); }
        }
        List<PageCell[]> Rows(ResultDescriptor descriptor)
        {
            var set = service.Results.Find(descriptor.ResultId)!;
            return [.. set.SealedSnapshot().SelectMany(page => PageReader.Read(PinnedPage.Body(page), set.Wires).Rows)];
        }
        static string Messages(QueryResult? result) => string.Join(" | ", result?.Messages.Select(message => message.Text) ?? []);

        var (code, result, message) = await Execute("SELECT 1 AS i, 1.5 AS f, NUMERIC '1.50' AS n, TRUE AS b, 'héllo' AS s, b'\\xde\\xad' AS y, DATE '2026-11-15' AS d, "
            + "TIME '09:30:00.123' AS t, DATETIME '2026-11-15 09:30:00.5' AS dt, TIMESTAMP '2026-11-15 09:30:00.123456 UTC' AS ts, JSON '{\"k\":1}' AS j, "
            + "STRUCT(7 AS a, 'x' AS b) AS st, [1, 2] AS ai, CAST(NULL AS INT64) AS nl");
        var set = result?.ResultSets.SingleOrDefault();
        var row = set is null ? null : Rows(set).SingleOrDefault();
        var texts = row is null ? "" : string.Join("|", row.Select(cell => cell.Text ?? "NULL"));
        check(code == "ok" && result?.Status == "completed" && row is not null && row.All(cell => (cell.Flags & PageReader.Error) == 0)
            && texts == "1|1.5|1.5|true|héllo|0xDEAD|2026-11-15|09:30:00.123|2026-11-15T09:30:00.5|2026-11-15 09:30:00.123456 UTC|{\"k\":1}|{\"a\":\"7\",\"b\":\"x\"}|[\"1\",\"2\"]|NULL"
            && set!.Columns.Select(column => column.DataType).SequenceEqual(["INT64", "FLOAT64", "NUMERIC", "BOOL", "STRING", "BYTES", "DATE", "TIME", "DATETIME", "TIMESTAMP", "JSON", "STRUCT<a INT64, b STRING>", "ARRAY<INT64>", "INT64"]),
            $"emulator: query.execute reads every type through the converter into the result store: {code} {message} {texts} {string.Join(",", set?.Columns.Select(column => column.DataType) ?? [])} {Messages(result)}");

        (code, result, message) = await Execute("SELECT n FROM UNNEST(GENERATE_ARRAY(1, 1200)) AS n ORDER BY n");
        set = result?.ResultSets.SingleOrDefault();
        var values = set is null ? [] : Rows(set).Select(cells => cells[0].Text).ToList();
        check(code == "ok" && set is { RowsRead: 1200, RowsStored: 1200, Truncated: null } && values.SequenceEqual(Enumerable.Range(1, 1200).Select(n => n.ToString(System.Globalization.CultureInfo.InvariantCulture)))
            && result!.Messages.Any(entry => entry.Text == "(1200 rows affected)"),
            $"emulator: query.execute pages a result past its first page, in order: {code} {message} {set?.RowsRead} {set?.RowsStored} {Messages(result)}");

        (code, result, _) = await Execute("SELECT n FROM UNNEST(GENERATE_ARRAY(1, 1200)) AS n", maxRows: 10);
        set = result?.ResultSets.SingleOrDefault();
        check(set is { RowsRead: 1200, RowsStored: 10, Truncated: "rowLimit" }, $"emulator: the row limit stores the first rows and counts the rest: {set?.RowsRead} {set?.RowsStored} {set?.Truncated}");

        (code, result, message) = await Execute($"DECLARE minimum INT64 DEFAULT 20; SELECT COUNT(*) AS n FROM {table} WHERE id > minimum;");
        set = result?.ResultSets.SingleOrDefault();
        check(code == "ok" && result?.Status == "completed" && set is not null && Rows(set).Single()[0].Text == "5",
            $"emulator: a script's variables bind and an unqualified table resolves in the connection's default dataset: {code} {message} {Messages(result)}");

        (code, result, message) = await Execute($"UPDATE {table} SET customer = 'renamed' WHERE id <= 2");
        check(code == "ok" && result is { Status: "completed", ResultSets.Count: 0 }, $"emulator: DML completes with no result set: {code} {message} {result?.RecordsAffected} {Messages(result)}");

        (code, result, message) = await Execute("SELECT * FROM no_such_table_" + Guid.NewGuid().ToString("N")[..8]);
        check(code == "ok" && result is { Status: "failed", Error: not null, ResultSets.Count: 0 } && result.Job is { JobId.Length: > 0 }
            && result.Messages.Any(entry => entry.Kind == "error"),
            $"emulator: a failing query is the summary's error, with its job: {code} {message} {result?.Error} {Messages(result)}");
    }

    /// <summary>Storage Read against the emulator's plaintext gRPC port (VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT, emulator mode
    /// only): the same queries read through REST and through Arrow give identical cells, in order for a top-level ORDER BY.
    /// Scalar columns only: the emulator fails to write DATETIME and TIME to Arrow, writes BYTES base64-encoded twice and
    /// panics on ARRAY columns (the offline golden check covers every type).</summary>
    static async Task StorageReadAsync(Action<bool, string> check, BigQueryEnvironment environment)
    {
        if (environment.StorageEndpoint is null)
        {
            Console.WriteLine("emulator: Storage Read checks skipped: VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT is not set.");
            return;
        }
        using var rest = new SqlService(CheckStores.Unprobed(), bigQuery: environment with { StorageEndpoint = null });
        using var arrow = new SqlService(CheckStores.Unprobed(), bigQuery: environment);
        arrow.BigQuery.StorageReadMinBytes = 0;
        async Task<string> Connect(SqlService service)
        {
            using var document = JsonDocument.Parse(new JsonObject
            {
                ["provider"] = "bigquery", ["project"] = Project, ["dataset"] = Dataset, ["authentication"] = "gcloud", ["credential"] = new JsonObject { ["source"] = "anonymous" }
            }.ToJsonString());
            return ((ConnectionInfo)await service.DispatchAsync("connections.connect", document.RootElement.Clone(), Wire)).Id;
        }
        var restId = await Connect(rest);
        var arrowId = await Connect(arrow);
        async Task<(QueryResult? Result, List<PageCell[]> Rows)> Run(SqlService service, string connectionId, string sql)
        {
            var args = new JsonObject { ["connectionId"] = connectionId, ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = sql, ["maxRows"] = 0, ["timeoutSeconds"] = 0 };
            using var document = JsonDocument.Parse(args.ToJsonString());
            var result = await service.DispatchAsync("query.execute", document.RootElement.Clone(), Wire) as QueryResult;
            var set = result?.ResultSets.SingleOrDefault() is { } descriptor ? service.Results.Find(descriptor.ResultId) : null;
            return (result, set is null ? [] : [.. set.SealedSnapshot().SelectMany(page => PageReader.Read(PinnedPage.Body(page), set.Wires).Rows)]);
        }
        string[] queries =
        [
            "SELECT n, CAST(n AS STRING) AS s, n * 1.5 AS f, CAST(n AS NUMERIC) / 8 AS num, MOD(n, 2) = 0 AS b, DATE_ADD(DATE '2026-01-01', INTERVAL n DAY) AS d, "
                + "TIMESTAMP_ADD(TIMESTAMP '2026-11-15 09:30:00.123456 UTC', INTERVAL n SECOND) AS ts, "
                + "IF(MOD(n, 7) = 0, NULL, n) AS maybe "
                + "FROM UNNEST(GENERATE_ARRAY(1, 1500)) AS n ORDER BY n",
            // Unordered: up to four streams, appended as they come, so the rows are compared in any order.
            "SELECT n, REPEAT('x', MOD(n, 40)) AS pad FROM UNNEST(GENERATE_ARRAY(1, 2500)) AS n"
        ];
        foreach (var sql in queries)
        {
            var before = arrow.BigQuery.StorageSessions;
            var (restResult, restRows) = await Run(rest, restId, sql);
            var (arrowResult, arrowRows) = await Run(arrow, arrowId, sql);
            if (!sql.Contains("ORDER BY", StringComparison.Ordinal))
            {
                restRows = [.. restRows.OrderBy(row => long.Parse(row[0].Text ?? "0", CultureInfo.InvariantCulture))];
                arrowRows = [.. arrowRows.OrderBy(row => long.Parse(row[0].Text ?? "0", CultureInfo.InvariantCulture))];
            }
            var differences = new List<string>();
            for (var r = 0; r < Math.Min(restRows.Count, arrowRows.Count) && differences.Count < 8; r++)
                for (var c = 0; c < restRows[r].Length; c++)
                    if (restRows[r][c].Text != arrowRows[r][c].Text || restRows[r][c].Flags != arrowRows[r][c].Flags)
                        differences.Add(r + "," + c + ": REST ‘" + restRows[r][c].Text + "’ Arrow ‘" + arrowRows[r][c].Text + "’");
            var messages = string.Join(" | ", arrowResult?.Messages.Select(message => message.Text) ?? []);
            check(restResult?.Status == "completed" && arrowResult?.Status == "completed" && arrow.BigQuery.StorageSessions == before + 1 && restRows.Count > 0
                && restRows.Count == arrowRows.Count && differences.Count == 0,
                $"emulator: Storage Read reads the result the REST reader reads, cell for cell and in order: {restRows.Count} {arrowRows.Count} {arrow.BigQuery.StorageSessions - before} {string.Join("; ", differences)} {messages}");
        }
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
