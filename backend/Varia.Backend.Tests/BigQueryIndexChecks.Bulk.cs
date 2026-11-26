using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Varia.Backend.BigQuery;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>
/// The billed bulk path offline (docs/object-search.md, BigQuery, Bulk index): its SQL rendered with hostile names, INFORMATION_SCHEMA
/// type text read as pass 2 reads tables.get, the estimate (dry runs per location, the 10 MiB floor), and a build whose bulk rows fill
/// exactly the entries the free REST pass fills, with no job unless the build names its locations. Every request goes to
/// <see cref="BigQueryFake"/>, which answers jobs.insert and jobs.getQueryResults from rows that describe the same objects as the
/// REST fixtures.
/// </summary>
internal static partial class BigQueryIndexChecks
{
    static void BulkSql(Action<bool, string> check)
    {
        var columns = BigQueryBulkSql.Columns("varia-alpha", "US");
        var views = BigQueryBulkSql.Views("varia-alpha", "us-east1");
        check(columns.Contains("FROM `varia-alpha`.`region-us`.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS AS p", StringComparison.Ordinal)
            && columns.Contains("JOIN `varia-alpha`.`region-us`.INFORMATION_SCHEMA.COLUMNS AS c", StringComparison.Ordinal)
            && views.Contains("`varia-alpha`.`region-us-east1`.INFORMATION_SCHEMA.VIEWS", StringComparison.Ordinal)
            && BigQueryBulkSql.Routines("varia-alpha", "EU").Contains("`varia-alpha`.`region-eu`.INFORMATION_SCHEMA.ROUTINES", StringComparison.Ordinal),
            "the bulk queries name the location's region qualifier, quoted: " + views);
        // Every template is the same text whatever the project and location, but for the quoted qualifier.
        static string Constant(string sql) => System.Text.RegularExpressions.Regex.Replace(sql, @"`[^`]*`\.`region-[^`]*`", "@region");
        var same = new[] { ("varia-alpha", "US"), ("other-project-1", "asia-northeast1"), ("example.com:scoped-1", "EU") }
            .Select(pair => string.Join("\n", BigQueryBulkSql.Queries(pair.Item1, pair.Item2, true).Select(query => Constant(query.Sql)))).Distinct().Count();
        check(same == 1, "the bulk queries are constant text but for the region qualifier");
        string[] hostile = ["us`; DROP SCHEMA x; --", "us east", "", "us\u0007", "région", new string('a', 65), "us\\`"];
        var refused = hostile.Count(location => Throws(() => BigQueryBulkSql.Columns("varia-alpha", location)) && Throws(() => BigQueryBulkSql.Views("varia-alpha", location))
            && Throws(() => BigQueryBulkSql.Routines("varia-alpha", location)));
        var projects = new[] { "varia`alpha", "Varia-Alpha", "a", "x; DROP" }.Count(project => Throws(() => BigQueryBulkSql.Columns(project, "US")));
        check(refused == hostile.Length && projects == 4, $"a hostile location or project never reaches the text ({refused}/{hostile.Length}, {projects}/4)");
        check(BigQueryBulkSql.Queries("varia-alpha", "US", false).Count == 1 && BigQueryBulkSql.Queries("varia-alpha", "US", true).Sum(query => query.Views) == 5
            && BigQueryBulkSql.Billed(0, 3) == 30L << 20 && BigQueryBulkSql.Billed(50L << 20, 1) == 60L << 20 && BigQueryBulkSql.Billed(1, 3) == 31L << 20,
            "without definitions only the column query runs; a query is counted at every view's 10 MiB floor plus its bytes rounded up to whole MiB");

        static bool Throws(Action action)
        {
            try { action(); return false; }
            catch (RequestException error) { return error.Code == "INVALID_PARAMS"; }
        }
    }

    static void BulkTypes(Action<bool, string> check)
    {
        var cases = new (string Type, string Shown)[]
        {
            ("INT64", "INT64"), ("STRING(64)", "STRING(64)"), ("NUMERIC(10,2)", "NUMERIC(10, 2)"), ("NUMERIC(10, 2)", "NUMERIC(10, 2)"), ("ARRAY<STRING>", "ARRAY<STRING>"),
            ("STRUCT<a INT64, b STRUCT<c STRING>>", "STRUCT"), ("ARRAY<STRUCT<sku STRING>>", "ARRAY<STRUCT>"), ("RANGE<DATE>", "RANGE"), ("ARRAY<RANGE<DATE>>", "ARRAY<RANGE>"),
            ("STRING COLLATE 'und:ci'", "STRING"), ("INT64 NOT NULL", "INT64"), ("ARRAY<NUMERIC(38, 9)>", "ARRAY<NUMERIC(38, 9)>"), ("INTEGER", "INT64"),
            ("TIMESTAMP(12)", "TIMESTAMP"), ("BYTES(16)", "BYTES(16)"), ("BIGNUMERIC(76, 38)", "BIGNUMERIC(76, 38)")
        };
        var wrong = cases.Where(item => BigQueryBulk.TypeText(item.Type) != item.Shown).Select(item => item.Type + " → " + BigQueryBulk.TypeText(item.Type)).ToList();
        check(wrong.Count == 0, "INFORMATION_SCHEMA's type text reads as pass 2 shows tables.get's: " + string.Join("; ", wrong));
        var fields = BigQueryBulk.Fields(BigQueryBulk.StructBody("STRUCT<city STRING NOT NULL, `my field` STRUCT<x INT64, y ARRAY<STRING>>, n NUMERIC(10, 2), `tick\\`s` BOOL, code STRING COLLATE 'und:ci' NOT NULL>")!).ToList();
        check(fields is [("city", "STRING NOT NULL", false), ("my field", "STRUCT<x INT64, y ARRAY<STRING>>", true), ("n", "NUMERIC(10, 2)", true), ("tick`s", "BOOL", true), ("code", "STRING COLLATE 'und:ci' NOT NULL", false)]
            && BigQueryBulk.StructBody("ARRAY<STRUCT<sku STRING>>") == "sku STRING" && BigQueryBulk.StructBody("ARRAY<STRING>") is null,
            "a STRUCT's fields come in order, backticked names unquoted, NOT NULL as not nullable (after a COLLATE too): " + string.Join(", ", fields));
        var table = new BigQueryBulkTable("BASE TABLE");
        table.Fields.Add(new("b", "STRUCT<z STRING, a STRUCT<q INT64 NOT NULL>>", null, 2, true));
        table.Fields.Add(new("b.a.q", "INT64", "deep", 2, true));
        table.Fields.Add(new("a", "INT64", null, 1, false));
        table.Fields.Add(new("b.z", "STRING", null, 2, true));
        table.Fields.Add(new("b.a", "STRUCT<q INT64 NOT NULL>", null, 2, true));
        var detail = BigQueryBulk.FromTable(table, null);
        check(string.Join(", ", detail.Columns.Select(column => column.Path + ":" + column.Type + (column.Nullable ? "" : "!") + (column.Record ? "+" : "") + (column.Description is { } text ? "=" + text : "")))
            == "a:INT64!, b:STRUCT+, b.z:STRING, b.a:STRUCT+, b.a.q:INT64!=deep",
            "rows in any order flatten depth first in declared order, with nested NOT NULL and descriptions: " + string.Join(", ", detail.Columns.Select(column => column.Path)));
        // A dataset's rows are held under a character budget: past it, it keeps nothing and its objects go to the free calls.
        var big = new BigQueryBulkDataset("sales");
        big.Add("orders", "BASE TABLE", new("id", "INT64", null, 1, false));
        var listed = new BigQueryEntry("bqTable", "bqTables", null, "orders", 1, null);
        var covered = BigQueryBulk.Detail(big, listed, false) is not null;
        big.AddText(big.Views, "daily", new string('x', (int)BigQueryBulkSql.DatasetChars));
        big.Add("orders", "BASE TABLE", new("n", "INT64", null, 2, true));
        check(covered && big.Over && big.Tables.Count == 0 && big.Views.Count == 0 && BigQueryBulk.Detail(big, listed, false) is null,
            "a dataset's bulk rows past their character budget are dropped, leaving its objects to the free calls");
    }

    /// <summary>The fake's bulk answers: jobs.insert records each job by the view it reads; jobs.getQueryResults pages its rows (the
    /// column query in two pages, cut inside a table). Dry runs answer the fixture's 0 bytes, or <paramref name="dryRunBytes"/>.</summary>
    sealed class BulkJobs
    {
        public ConcurrentDictionary<string, string> Kinds { get; } = new();
        public ConcurrentQueue<(string Sql, string? Location, long? Cap, bool? Cache)> Created { get; } = new();
        public ConcurrentQueue<(string Sql, string? Location)> DryRuns { get; } = new();
        public long DryRunBytes { get; set; }
        /// <summary>What each job's first page says it processed (no guide to its bill); null leaves it out.</summary>
        public string? Processed { get; set; } = "1048577";
        /// <summary>What jobs.get says each job billed, by kind; null leaves totalBytesBilled out.</summary>
        public Dictionary<string, long>? BilledBytes { get; set; } = new() { ["columns"] = 30L << 20, ["views"] = 10L << 20, ["routines"] = 10L << 20 };
        /// <summary>Inserts and result reads in order ("insert columns", "read columns"…).</summary>
        public ConcurrentQueue<string> Events { get; } = new();
        public int Cancels;

        static JsonArray Row(params string?[] cells) => new([.. cells.Select(cell => (JsonNode)new JsonObject { ["v"] = cell is null ? null : JsonValue.Create(cell) })]);
        static JsonObject F(JsonArray cells) => new() { ["f"] = cells };

        static IEnumerable<JsonArray> OrdersShape(string table, string type) =>
        [
            Row("sales", table, type, "1", "NO", "id", "INT64", null),
            Row("sales", table, type, "2", "YES", "customer", "STRING", null),
            // COLUMNS says an array is never NULL; tables.get's REPEATED mode is nullable to pass 2.
            Row("sales", table, type, "3", "NO", "tags", "ARRAY<STRING>", null),
            Row("sales", table, type, "4", "YES", "placed", "TIMESTAMP", null),
            Row("sales", table, type, "5", "YES", "address", "STRUCT<city STRING, geo STRUCT<lat FLOAT64>>", null),
            Row("sales", table, type, "5", "YES", "address.geo.lat", "FLOAT64", null),
            Row("sales", table, type, "5", "YES", "address.city", "STRING", null),
            Row("sales", table, type, "5", "YES", "address.geo", "STRUCT<lat FLOAT64>", null),
            Row("sales", table, type, "6", "YES", "bad`col", "STRING", null)
        ];

        public static List<JsonArray> ColumnRows() =>
        [
            Row("archive", "elsewhere", "BASE TABLE", "1", "YES", "x", "STRING", null),
            Row("bad`name", "t", "BASE TABLE", "1", "YES", "x", "STRING", null),
            Row("sales", "daily", "VIEW", "2", "YES", "n", "INT64", null),
            Row("sales", "daily", "VIEW", "1", "YES", "day", "DATE", null),
            .. OrdersShape("orders", "BASE TABLE"), .. OrdersShape("events_summary", "BASE TABLE"), .. OrdersShape("audit_20261399", "BASE TABLE"),
            .. OrdersShape("audit_20261398", "BASE TABLE"), .. OrdersShape("orders_2024", "SNAPSHOT"), .. OrdersShape("landing", "EXTERNAL"), .. OrdersShape("totals", "MATERIALIZED VIEW"),
            Row("sales", "orders_copy", "CLONE", "2", "YES", "amount", "NUMERIC(10, 2)", "Order total in dollars."),
            Row("sales", "orders_copy", "CLONE", "1", "NO", "id", "INT64", null),
            Row("sales", "events_20260101", "BASE TABLE", "1", "YES", "event_name", "STRING(64)", null),
            Row("sales", "events_20260103", "BASE TABLE", "2", "YES", "items.sku", "STRING", null),
            Row("sales", "events_20260103", "BASE TABLE", "1", "YES", "event_name", "STRING(64)", null),
            Row("sales", "events_20260103", "BASE TABLE", "2", "YES", "items", "ARRAY<STRUCT<sku STRING>>", null),
            Row("zeta", "t", "BASE TABLE", "1", "YES", "x", "STRING", null)
        ];

        static List<JsonArray> ViewRows() =>
        [
            Row("sales", "daily", "SELECT DATE(placed) AS day, COUNT(*) AS n\nFROM `varia-alpha.sales.orders`\nGROUP BY day"),
            Row("staging", "v", "SELECT 1")
        ];

        static List<JsonArray> RoutineRows() =>
        [
            Row("sales", "refresh_totals", null),
            Row("sales", "to_cents", "CAST(ROUND(dollars * 100) AS INT64)"),
            Row("sales", "top_customers", "SELECT 1 AS n")
        ];

        public void Route(BigQueryFake fake)
        {
            fake.On("POST", BigQueryFake.Jobs, request =>
            {
                var body = JsonNode.Parse(request.Body)!;
                var sql = body["configuration"]?["query"]?["query"]?.GetValue<string>() ?? "";
                var location = body["jobReference"]?["location"]?.GetValue<string>();
                if (body["configuration"]?["dryRun"]?.GetValue<bool>() == true)
                {
                    // The connect probe's dry run is not the estimate's.
                    if (sql.Contains("INFORMATION_SCHEMA", StringComparison.Ordinal)) DryRuns.Enqueue((sql, location));
                    var bytes = DryRunBytes.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    return new(200, "{\"jobReference\":{\"projectId\":\"varia-alpha\",\"location\":\"" + location + "\"},\"statistics\":{\"totalBytesProcessed\":\"" + bytes + "\",\"query\":{\"totalBytesProcessed\":\"" + bytes + "\",\"statementType\":\"SELECT\"}},\"status\":{\"state\":\"DONE\"}}");
                }
                var id = body["jobReference"]!["jobId"]!.GetValue<string>();
                Kinds[id] = sql.Contains("COLUMN_FIELD_PATHS", StringComparison.Ordinal) ? "columns" : sql.Contains("INFORMATION_SCHEMA.VIEWS", StringComparison.Ordinal) ? "views" : "routines";
                Events.Enqueue("insert " + Kinds[id]);
                Created.Enqueue((sql, location, long.TryParse(body["configuration"]?["query"]?["maximumBytesBilled"]?.ToString(), out var cap) ? cap : null,
                    body["configuration"]?["query"]?["useQueryCache"]?.GetValue<bool>()));
                return new(200, "{\"jobReference\":{\"projectId\":\"varia-alpha\",\"jobId\":\"" + id + "\",\"location\":\"" + location + "\"},\"status\":{\"state\":\"RUNNING\"}}");
            });
            fake.On("GET", @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha/queries/[^/]+", request =>
            {
                var id = request.Url[(request.Url.LastIndexOf('/') + 1)..];
                Events.Enqueue("read " + Kinds.GetValueOrDefault(id));
                var rows = Kinds.GetValueOrDefault(id) switch { "columns" => ColumnRows(), "views" => ViewRows(), _ => RoutineRows() };
                var second = request.Uri.Query.Contains("pageToken=p2", StringComparison.Ordinal);
                // The column query's first page ends inside orders' rows; the others have one page.
                var split = Kinds.GetValueOrDefault(id) == "columns" ? 7 : rows.Count;
                var page = second ? rows.Skip(split) : rows.Take(split);
                var answer = new JsonObject
                {
                    ["jobComplete"] = true, ["totalRows"] = rows.Count.ToString(System.Globalization.CultureInfo.InvariantCulture), ["rows"] = new JsonArray([.. page.Select(cells => (JsonNode)F(cells))])
                };
                if (!second && split < rows.Count) answer["pageToken"] = "p2";
                if (!second && Processed is { } processed) answer["totalBytesProcessed"] = processed;
                return new(200, answer.ToJsonString());
            });
            fake.On("GET", @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha/jobs/[^/]+", request =>
            {
                var id = request.Url[(request.Url.LastIndexOf('/') + 1)..];
                var query = new JsonObject { ["statementType"] = "SELECT" };
                if (BilledBytes?.GetValueOrDefault(Kinds.GetValueOrDefault(id) ?? "") is > 0 and var billed) query["totalBytesBilled"] = billed.ToString(System.Globalization.CultureInfo.InvariantCulture);
                return new(200, new JsonObject
                {
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id }, ["status"] = new JsonObject { ["state"] = "DONE" },
                    ["statistics"] = new JsonObject { ["query"] = query }
                }.ToJsonString());
            });
            fake.On("POST", @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha/jobs/[^/]+/cancel", _ => { Interlocked.Increment(ref Cancels); return new(200, "{}"); });
            // Datasets in two locations: staging and sales in the US, archive in us-east1 (no objects to read there).
            fake.On("GET", Alpha + "/datasets", request => new(200, request.Uri.Query.Contains("pageToken=page-2", StringComparison.Ordinal)
                ? BigQueryFake.FixtureText("datasets-page-2")
                : "{\"datasets\":[{\"datasetReference\":{\"projectId\":\"varia-alpha\",\"datasetId\":\"staging\"},\"location\":\"US\"},{\"datasetReference\":{\"projectId\":\"varia-alpha\",\"datasetId\":\"sales\"},\"location\":\"US\"}],\"nextPageToken\":\"page-2\"}"));
        }
    }

    /// <summary>A read's entries as the index holds them (kind, subtype, name, its column's type, nullability and position,
    /// description, definition), which the bulk path must fill exactly as pass 2 does. Dates and the table facts beside them are pass 2's alone.</summary>
    static List<string> Entries(SqlService service, string connectionId, string project, string dataset)
    {
        var read = service.Search.IndexOf(connectionId)?.Get(project + "\u0001" + dataset);
        if (read is null) return ["(none)"];
        var table = read.Table;
        return [.. Enumerable.Range(0, table.Count).Select(at =>
        {
            var typed = table.Typed(at);
            return string.Join("|", table.Kind(at), table.Subtype(at), table.ParentName(at), table.Name(at), typed?.TypeName, typed?.Ordinal, typed is { } value ? value.Flags.ToString() : null,
                read.Facts?.Description(at), table.Definition(at), table.DefinitionCut(at), read.Facts?.Of(at)?.Detailed);
        }).Order(StringComparer.Ordinal)];
    }

    static async Task BulkAsync(Action<bool, string> check, JsonObject key)
    {
        List<string> rest;
        using (var free = new Harness())
        {
            new BulkJobs().Route(free.Fake);
            await free.ConnectAsync(key);
            await free.Index();
            rest = Entries(free.Service, free.ConnectionId, "varia-alpha", "sales");
        }
        using var harness = new Harness();
        var jobs = new BulkJobs();
        jobs.Route(harness.Fake);
        await harness.ConnectAsync(key);

        // The estimate: datasets.list's locations, the queries dry-run in each, at least 10 MiB per view; never calls projects.list.
        var (code, result, message) = await harness.Call("bigquery.indexEstimate", new JsonObject { ["connectionId"] = harness.ConnectionId });
        var estimate = result as BigQueryIndexEstimateResult;
        check(code == "ok" && estimate is { Cut: false, Locations: [{ Project: "varia-alpha", Location: "US" }, { Project: "varia-alpha", Location: "us-east1" }], Estimate: { BytesProcessed: 2 * (50L << 20), StatementType: "SELECT", Faked: false, Incomplete: null } }
            && jobs.DryRuns.Count == 6 && jobs.DryRuns.All(run => run.Location is "US" or "us-east1") && jobs.Created.IsEmpty
            && harness.Gets(BigQueryFake.Projects) == 0,
            $"the estimate dry-runs each billing location's three queries without auto-discovering projects: {code} {message} {estimate?.Estimate.BytesProcessed} {string.Join(",", jobs.DryRuns.Select(run => run.Location))}");
        jobs.DryRunBytes = 1L << 30;
        var (_, bare, _) = await harness.Call("bigquery.indexEstimate", new JsonObject { ["connectionId"] = harness.ConnectionId, ["definitions"] = false, ["starredProjects"] = new JsonArray("varia-beta", "varia-alpha") });
        var (badEstimateStar, _, _) = await harness.Call("bigquery.indexEstimate", new JsonObject { ["connectionId"] = harness.ConnectionId, ["starredProjects"] = new JsonArray("NOT A PROJECT") });
        check(bare is BigQueryIndexEstimateResult { Locations: [_, _, { Project: "varia-beta", Location: "US" }], Estimate.BytesProcessed: 3 * ((1L << 30) + (30L << 20)) }
            && jobs.DryRuns.Count == 9 && jobs.Created.IsEmpty && harness.Gets(BigQueryFake.Projects) == 0 && badEstimateStar == "INVALID_PARAMS",
            "without definitions only the column query is estimated, starredProjects adds starred locations without discovering org projects, and invalid starred projects are refused");

        // The build: the US location's queries run once each, one at a time, never cached, each capped so the three together bill no
        // more than the budget (the estimate shown): 100 MiB less the later jobs' floors (10 and 10 MiB) and what the earlier ones
        // billed (jobs.get: 30 and 10 MiB). us-east1 holds nothing to read and bills nothing.
        var built = await harness.Index(more => more["bulk"] = new JsonObject
        {
            ["locations"] = new JsonArray(new JsonObject { ["project"] = "varia-alpha", ["location"] = "US" }, new JsonObject { ["project"] = "varia-alpha", ["location"] = "us-east1" },
                new JsonObject { ["project"] = "varia-alpha", ["location"] = "us" }),
            ["maximumBytesBilled"] = 1L << 30, ["budgetBytes"] = 100L << 20
        });
        var bulk = Entries(harness.Service, harness.ConnectionId, "varia-alpha", "sales");
        var created = jobs.Created.ToList();
        check(created.Count == 3 && created.All(job => job.Location == "US" && job.Cache == false) && created.Select(job => job.Cap).SequenceEqual(new long?[] { 80L << 20, 60L << 20, 60L << 20 })
            && built.Status.Bulk is { Locations: 1, Failed: 0 } && jobs.Cancels == 0,
            "the build runs the US location's three queries once, in the US, uncached, each capped inside the budget, none for a location with nothing to read, and cancels nothing it finished: "
            + string.Join(", ", created.Select(job => job.Location + " " + job.Cap)));
        var events = jobs.Events.Distinct().ToList();
        check(events.IndexOf("read columns") is >= 0 and var columnsRead && columnsRead < events.IndexOf("insert views") && events.IndexOf("read views") < events.IndexOf("insert routines")
            && events.IndexOf("insert views") < events.IndexOf("read views"),
            "each job starts only after the one before finished: " + string.Join(", ", events));
        check(rest.Count > 60 && rest.Any(entry => entry.StartsWith("bqColumn||orders|address.geo.lat|FLOAT64|", StringComparison.Ordinal)) && rest.Any(entry => entry.Contains("Order total in dollars.", StringComparison.Ordinal))
            && rest.Any(entry => entry.StartsWith("bqTable|clone|", StringComparison.Ordinal)) && rest.Any(entry => entry.Contains("GROUP BY day", StringComparison.Ordinal)),
            $"the REST read compared holds columns, descriptions, a clone and view text ({rest.Count} entries)");
        check(bulk.SequenceEqual(rest), "the bulk path fills exactly the entries pass 2 fills: " + string.Join(" ; ", bulk.Except(rest).Take(6)) + " vs " + string.Join(" ; ", rest.Except(bulk).Take(6)));
        var prefix = Sales.Replace("\\", "");
        var called = harness.Fake.Seen.Where(request => request.Method == "GET" && (request.Url.StartsWith(prefix + "/tables/", StringComparison.Ordinal) || request.Url.StartsWith(prefix + "/routines/", StringComparison.Ordinal)))
            .Select(request => request.Url[(request.Url.LastIndexOf('/') + 1)..]).Order(StringComparer.Ordinal).ToList();
        check(called is ["refresh_totals", "totals"], "only what the bulk rows lack goes to the free calls (a materialized view, a routine without a body): " + string.Join(", ", called));
        var tablesBefore = harness.Fake.Seen.Count(request => request.Method == "GET" && request.Url.StartsWith(prefix + "/tables/", StringComparison.Ordinal));
        var plain = await harness.Index();
        check(jobs.Created.Count == 3 && jobs.DryRuns.Count == 9 && plain.Status.Bulk is null, "a build that names no bulk locations runs no job and no dry run, and its status has no bulk read");
        // Bulk rows lack pass 2's size, layout and last change: the next free build reads those objects again rather than keep them.
        var again = harness.Fake.Seen.Count(request => request.Method == "GET" && request.Url.StartsWith(prefix + "/tables/", StringComparison.Ordinal)) - tablesBefore;
        check(again > 5 && Entries(harness.Service, harness.ConnectionId, "varia-alpha", "sales").SequenceEqual(rest),
            $"a free build after a bulk one reads the bulk-read objects again and fills pass 2's entries ({again} tables.get)");

        // A budget below a location's floors starts no job; a cap below a job's floor neither: the free calls read its datasets.
        foreach (var (budgetBytes, cap) in new[] { ((50L << 20) - 1, (long?)null), (1L << 30, (long?)(20L << 20)) })
        {
            using var poor = new Harness();
            var poorJobs = new BulkJobs();
            poorJobs.Route(poor.Fake);
            await poor.ConnectAsync(key);
            var shortOf = await poor.Index(more =>
            {
                var request = Bulk();
                request["budgetBytes"] = budgetBytes;
                if (cap is { } bytes) request["maximumBytesBilled"] = bytes;
                more["bulk"] = request;
            });
            check(poorJobs.Created.IsEmpty && shortOf.Status.Bulk is { Locations: 0, Failed: 1, Code: "COST_CAP" } && Entries(poor.Service, poor.ConnectionId, "varia-alpha", "sales").SequenceEqual(rest),
                $"a budget of {budgetBytes} B or a cap of {cap} B below the floors starts no job and falls back to the free calls ({shortOf.Status.Bulk?.Code}, {poorJobs.Created.Count} jobs)");
        }
        // A job whose bill jobs.get does not give keeps its whole cap charged, whatever it processed: the later jobs get only their floors.
        // One that never finishes (the location's time limit) keeps it charged too, so the next location cannot count on it.
        using (var silent = new Harness())
        {
            var silentJobs = new BulkJobs { BilledBytes = null, Processed = "0" };
            silentJobs.Route(silent.Fake);
            await silent.ConnectAsync(key);
            var request = Bulk();
            request["budgetBytes"] = 100L << 20;
            await silent.Index(more => more["bulk"] = request);
            check(silentJobs.Created.Select(job => job.Cap).SequenceEqual(new long?[] { 80L << 20, 10L << 20, 10L << 20 }),
                "an unknown bill counts as the job's cap: " + string.Join(", ", silentJobs.Created.Select(job => job.Cap)));
        }
        // A job BigQuery refused and reports done with nothing billed returns its cap, so the next location keeps its budget.
        using (var refusedHarness = new Harness())
        {
            var refusedJobs = new BulkJobs();
            refusedJobs.Route(refusedHarness.Fake);
            refusedHarness.Fake.On("GET", @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha/queries/[^/]+", BigQueryFake.Fixture("error-access-denied", 403));
            refusedHarness.Fake.On("GET", @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha/jobs/[^/]+", new BigQueryFake.Reply(200,
                "{\"jobReference\":{\"projectId\":\"varia-alpha\",\"jobId\":\"x\"},\"statistics\":{\"query\":{\"totalBytesBilled\":\"0\"}},\"status\":{\"state\":\"DONE\",\"errorResult\":{\"reason\":\"accessDenied\",\"message\":\"Access Denied: INFORMATION_SCHEMA\"}}}"));
            await refusedHarness.ConnectAsync(key);
            var shared = new BigQueryBulkBudget(200L << 20);
            string? failure = null;
            try
            {
                await foreach (var _ in ((IBigQueryIndexSource)refusedHarness.Service.BigQuery).BulkAsync(refusedHarness.ConnectionId, "varia-alpha", "US", true, null, shared, (_, _) => true, CancellationToken.None)) { }
            }
            catch (RequestException error) { failure = error.Code; }
            check(failure == "PERMISSION_DENIED" && refusedJobs.Created.Count == 1 && shared.Remaining == 200L << 20,
                $"a refused job that billed nothing returns its cap to the shared budget ({failure}, {shared.Remaining} B left)");
        }
        using (var stuck = new Harness())
        {
            var stuckJobs = new BulkJobs();
            stuckJobs.Route(stuck.Fake);
            stuck.Fake.On("GET", @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha/queries/[^/]+", new BigQueryFake.Reply(200, "{\"jobComplete\":false}"));
            await stuck.ConnectAsync(key);
            var service = stuck.Service.BigQuery;
            service.BulkLimit = TimeSpan.FromMilliseconds(300);
            service.DdlPoll = TimeSpan.FromMilliseconds(20);
            var shared = new BigQueryBulkBudget(200L << 20);
            string? failure = null;
            try
            {
                await foreach (var _ in ((IBigQueryIndexSource)service).BulkAsync(stuck.ConnectionId, "varia-alpha", "US", true, null, shared, (_, _) => true, CancellationToken.None)) { }
            }
            catch (OperationCanceledException) { failure = "timeout"; }
            check(failure == "timeout" && stuckJobs.Created.Count == 1 && stuckJobs.Created.Single().Cap == 180L << 20 && shared.Remaining == 20L << 20,
                $"a job past the location's time limit keeps its cap charged to the shared budget ({failure}, {shared.Remaining} B left)");
        }

        // Refused: bulk with a scope, stale, an unknown project, a hostile location, too many locations; and SQL Server refuses bulk.
        async Task<string> Refused(Action<JsonObject> more)
        {
            var args = new JsonObject { ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString() };
            more(args);
            return (await harness.Call("explorer.index", args)).Code;
        }
        static JsonObject Bulk(string project = "varia-alpha", string location = "US", int count = 1) =>
            new() { ["locations"] = new JsonArray([.. Enumerable.Range(0, count).Select(_ => (JsonNode)new JsonObject { ["project"] = project, ["location"] = location })]), ["budgetBytes"] = 1L << 30 };
        var codes = new[]
        {
            await Refused(more => { more["bulk"] = Bulk(); more["scope"] = new JsonObject { ["project"] = "varia-alpha" }; }),
            await Refused(more => { more["bulk"] = Bulk(); more["stale"] = true; }),
            await Refused(more => more["bulk"] = Bulk(project: "bigquery-public-data")),
            await Refused(more => more["bulk"] = Bulk(project: "varia-beta")),
            await Refused(more => more["bulk"] = Bulk(location: "us`; --")),
            await Refused(more => more["bulk"] = Bulk(count: BigQueryBulkSql.MaxLocations + 1)),
            await Refused(more => more["bulk"] = new JsonObject { ["locations"] = new JsonArray(), ["budgetBytes"] = 1L << 30 }),
            await Refused(more => { var request = Bulk(); request.Remove("budgetBytes"); more["bulk"] = request; }),
            await Refused(more => { var request = Bulk(); request["budgetBytes"] = 0; more["bulk"] = request; })
        };
        check(codes.All(value => value == "INVALID_PARAMS") && jobs.Created.Count == 3,
            "bulk is refused with a scope or stale, for a project the build does not detail, a hostile location, too many or no locations, or without a budget: " + string.Join(",", codes));

        // A location whose job fails falls back to the free calls for its datasets and says why; a failed or stopped read cancels its
        // jobs, and a failed column job starts no other.
        using var failing = new Harness();
        var failingJobs = new BulkJobs();
        failingJobs.Route(failing.Fake);
        failing.Fake.On("GET", @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha/queries/[^/]+", BigQueryFake.Fixture("error-access-denied", 403));
        failing.Fake.On("GET", @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha/jobs/[^/]+", new BigQueryFake.Reply(200,
            "{\"jobReference\":{\"projectId\":\"varia-alpha\",\"jobId\":\"x\"},\"status\":{\"state\":\"DONE\",\"errorResult\":{\"reason\":\"accessDenied\",\"message\":\"Access Denied: INFORMATION_SCHEMA\"}}}"));
        await failing.ConnectAsync(key);
        var fellBack = await failing.Index(more => more["bulk"] = Bulk());
        check(fellBack.Status.Bulk is { Locations: 0, Failed: 1, Code: "PERMISSION_DENIED" } && Entries(failing.Service, failing.ConnectionId, "varia-alpha", "sales").SequenceEqual(rest)
            && failingJobs.Created.Count == 1 && failingJobs.Cancels == 1 && fellBack.Status.Skipped.Count == 0,
            $"a refused bulk read falls back to the free calls, fills the same entries, starts no further job, cancels its own and is reported once ({fellBack.Status.Bulk?.Code}, {failingJobs.Created.Count} jobs, {failingJobs.Cancels} cancels)");

        // Wave 3 bulk path covers starred projects alongside Wave 1 billing project, sharing BigQueryBulkBudget.
        using var starredBulk = new Harness();
        var starredJobs = new BulkJobs();
        starredJobs.Route(starredBulk.Fake);
        await starredBulk.ConnectAsync(key);
        var builtStarred = await starredBulk.Index(more =>
        {
            more["allProjects"] = false;
            more["starredProjects"] = new JsonArray("varia-beta");
            more["bulk"] = new JsonObject
            {
                ["locations"] = new JsonArray(
                    new JsonObject { ["project"] = "varia-alpha", ["location"] = "US" },
                    new JsonObject { ["project"] = "varia-beta", ["location"] = "US" }),
                ["budgetBytes"] = 200L << 20
            };
        });
        check(builtStarred.Status.Bulk is { Locations: 2, Failed: 0 }
            && starredJobs.Created.Any(job => job.Sql.Contains("`varia-alpha`", StringComparison.Ordinal))
            && starredJobs.Created.Any(job => job.Sql.Contains("`varia-beta`", StringComparison.Ordinal))
            && starredBulk.Service.Search.HeldOf(starredBulk.ConnectionId).Any(read => read.Database == "varia-beta" && read.Dataset == "census"),
            $"wave 3 bulk reads starred project alongside billing project ({builtStarred.Status.Bulk?.Locations} locations, {starredJobs.Created.Count} jobs)");

        check(harness.Fake.Unmatched.IsEmpty && failing.Fake.Unmatched.IsEmpty && starredBulk.Fake.Unmatched.IsEmpty,
            "every bulk request had a route: " + string.Join(", ", harness.Fake.Unmatched.Concat(failing.Fake.Unmatched).Concat(starredBulk.Fake.Unmatched).Select(request => request.Method + " " + request.Url)));
    }
}
