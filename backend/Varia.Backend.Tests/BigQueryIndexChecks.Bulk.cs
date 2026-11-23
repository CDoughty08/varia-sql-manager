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
            && BigQueryBulkSql.Billed(0, 3) == 30L << 20 && BigQueryBulkSql.Billed(50L << 20, 1) == 50L << 20,
            "without definitions only the column query runs; each query is estimated at no less than 10 MiB per view it reads");

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
            ("STRING COLLATE 'und:ci'", "STRING"), ("INT64 NOT NULL", "INT64"), ("ARRAY<NUMERIC(38, 9)>", "ARRAY<NUMERIC(38, 9)>"), ("INTEGER", "INT64")
        };
        var wrong = cases.Where(item => BigQueryBulk.TypeText(item.Type) != item.Shown).Select(item => item.Type + " → " + BigQueryBulk.TypeText(item.Type)).ToList();
        check(wrong.Count == 0, "INFORMATION_SCHEMA's type text reads as pass 2 shows tables.get's: " + string.Join("; ", wrong));
        var fields = BigQueryBulk.Fields(BigQueryBulk.StructBody("STRUCT<city STRING NOT NULL, `my field` STRUCT<x INT64, y ARRAY<STRING>>, n NUMERIC(10, 2), `tick\\`s` BOOL>")!).ToList();
        check(fields is [("city", "STRING NOT NULL", false), ("my field", "STRUCT<x INT64, y ARRAY<STRING>>", true), ("n", "NUMERIC(10, 2)", true), ("tick`s", "BOOL", true)]
            && BigQueryBulk.StructBody("ARRAY<STRUCT<sku STRING>>") == "sku STRING" && BigQueryBulk.StructBody("ARRAY<STRING>") is null,
            "a STRUCT's fields come in order, backticked names unquoted, NOT NULL as not nullable: " + string.Join(", ", fields));
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
    }

    /// <summary>The fake's bulk answers: jobs.insert records each job by the view it reads; jobs.getQueryResults pages its rows (the
    /// column query in two pages, cut inside a table). Dry runs answer the fixture's 0 bytes, or <paramref name="dryRunBytes"/>.</summary>
    sealed class BulkJobs
    {
        public ConcurrentDictionary<string, string> Kinds { get; } = new();
        public ConcurrentQueue<(string Sql, string? Location, long? Cap, bool? Cache)> Created { get; } = new();
        public ConcurrentQueue<(string Sql, string? Location)> DryRuns { get; } = new();
        public long DryRunBytes { get; set; }
        public int Cancels;

        static JsonArray Row(params string?[] cells) => new([.. cells.Select(cell => (JsonNode)new JsonObject { ["v"] = cell is null ? null : JsonValue.Create(cell) })]);
        static JsonObject F(JsonArray cells) => new() { ["f"] = cells };

        static IEnumerable<JsonArray> OrdersShape(string table, string type) =>
        [
            Row("sales", table, type, "1", "NO", "id", "INT64", null),
            Row("sales", table, type, "2", "YES", "customer", "STRING", null),
            Row("sales", table, type, "3", "YES", "tags", "ARRAY<STRING>", null),
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
                Created.Enqueue((sql, location, long.TryParse(body["configuration"]?["query"]?["maximumBytesBilled"]?.ToString(), out var cap) ? cap : null,
                    body["configuration"]?["query"]?["useQueryCache"]?.GetValue<bool>()));
                return new(200, "{\"jobReference\":{\"projectId\":\"varia-alpha\",\"jobId\":\"" + id + "\",\"location\":\"" + location + "\"},\"status\":{\"state\":\"RUNNING\"}}");
            });
            fake.On("GET", @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha/queries/[^/]+", request =>
            {
                var id = request.Url[(request.Url.LastIndexOf('/') + 1)..];
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
                return new(200, answer.ToJsonString());
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

        // The estimate: datasets.list's locations, the queries dry-run in each, at least 10 MiB per view.
        var (code, result, message) = await harness.Call("bigquery.indexEstimate", new JsonObject { ["connectionId"] = harness.ConnectionId });
        var estimate = result as BigQueryIndexEstimateResult;
        check(code == "ok" && estimate is { Cut: false, Locations: [{ Project: "varia-alpha", Location: "US" }, { Project: "varia-alpha", Location: "us-east1" }], Estimate: { BytesProcessed: 2 * (50L << 20), StatementType: "SELECT", Faked: false, Incomplete: null } }
            && jobs.DryRuns.Count == 6 && jobs.DryRuns.All(run => run.Location is "US" or "us-east1") && jobs.Created.IsEmpty,
            $"the estimate dry-runs each location's three queries in that location and counts each at its floor: {code} {message} {estimate?.Estimate.BytesProcessed} {string.Join(",", jobs.DryRuns.Select(run => run.Location))}");
        jobs.DryRunBytes = 1L << 30;
        var (_, bare, _) = await harness.Call("bigquery.indexEstimate", new JsonObject { ["connectionId"] = harness.ConnectionId, ["definitions"] = false, ["extraDetails"] = true });
        check(bare is BigQueryIndexEstimateResult { Locations: [_, _, { Project: "varia-beta", Location: "US" }], Estimate.BytesProcessed: 3L << 30 } && jobs.DryRuns.Count == 9 && jobs.Created.IsEmpty,
            "without definitions only the column query is estimated, a dry run above the floor counts as itself, and extraDetails adds the extra project's locations");

        // The build: the US location's queries run once each, billed under the cap, never cached; us-east1 holds nothing to read and bills nothing.
        var built = await harness.Index(more => more["bulk"] = new JsonObject
        {
            ["locations"] = new JsonArray(new JsonObject { ["project"] = "varia-alpha", ["location"] = "US" }, new JsonObject { ["project"] = "varia-alpha", ["location"] = "us-east1" },
                new JsonObject { ["project"] = "varia-alpha", ["location"] = "us" }),
            ["maximumBytesBilled"] = 1L << 30
        });
        var bulk = Entries(harness.Service, harness.ConnectionId, "varia-alpha", "sales");
        var created = jobs.Created.ToList();
        check(created.Count == 3 && created.All(job => job.Location == "US" && job.Cap == 1L << 30 && job.Cache == false) && built.Status.Bulk is { Locations: 1, Failed: 0 } && jobs.Cancels == 0,
            "the build runs the US location's three queries once, in the US, under the cap and uncached, none for a location with nothing to read, and cancels nothing it finished: "
            + string.Join(", ", created.Select(job => job.Location + " " + job.Cap)));
        check(rest.Count > 60 && rest.Any(entry => entry.StartsWith("bqColumn||orders|address.geo.lat|FLOAT64|", StringComparison.Ordinal)) && rest.Any(entry => entry.Contains("Order total in dollars.", StringComparison.Ordinal))
            && rest.Any(entry => entry.StartsWith("bqTable|clone|", StringComparison.Ordinal)) && rest.Any(entry => entry.Contains("GROUP BY day", StringComparison.Ordinal)),
            $"the REST read compared holds columns, descriptions, a clone and view text ({rest.Count} entries)");
        check(bulk.SequenceEqual(rest), "the bulk path fills exactly the entries pass 2 fills: " + string.Join(" ; ", bulk.Except(rest).Take(6)) + " vs " + string.Join(" ; ", rest.Except(bulk).Take(6)));
        var prefix = Sales.Replace("\\", "");
        var called = harness.Fake.Seen.Where(request => request.Method == "GET" && (request.Url.StartsWith(prefix + "/tables/", StringComparison.Ordinal) || request.Url.StartsWith(prefix + "/routines/", StringComparison.Ordinal)))
            .Select(request => request.Url[(request.Url.LastIndexOf('/') + 1)..]).Order(StringComparer.Ordinal).ToList();
        check(called is ["refresh_totals", "totals"], "only what the bulk rows lack goes to the free calls (a materialized view, a routine without a body): " + string.Join(", ", called));
        var plain = await harness.Index();
        check(jobs.Created.Count == 3 && jobs.DryRuns.Count == 9 && plain.Status.Bulk is null, "a build that names no bulk locations runs no job and no dry run, and its status has no bulk read");

        // Refused: bulk with a scope, stale, an unknown project, a hostile location, too many locations; and SQL Server refuses bulk.
        async Task<string> Refused(Action<JsonObject> more)
        {
            var args = new JsonObject { ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString() };
            more(args);
            return (await harness.Call("explorer.index", args)).Code;
        }
        static JsonObject Bulk(string project = "varia-alpha", string location = "US", int count = 1) =>
            new() { ["locations"] = new JsonArray([.. Enumerable.Range(0, count).Select(_ => (JsonNode)new JsonObject { ["project"] = project, ["location"] = location })]) };
        var codes = new[]
        {
            await Refused(more => { more["bulk"] = Bulk(); more["scope"] = new JsonObject { ["project"] = "varia-alpha" }; }),
            await Refused(more => { more["bulk"] = Bulk(); more["stale"] = true; }),
            await Refused(more => more["bulk"] = Bulk(project: "varia-beta")),
            await Refused(more => more["bulk"] = Bulk(location: "us`; --")),
            await Refused(more => more["bulk"] = Bulk(count: BigQueryBulkSql.MaxLocations + 1)),
            await Refused(more => more["bulk"] = new JsonObject { ["locations"] = new JsonArray() })
        };
        check(codes.All(value => value == "INVALID_PARAMS") && jobs.Created.Count == 3,
            "bulk is refused with a scope or stale, for a project the build does not detail, a hostile location, too many or no locations: " + string.Join(",", codes));

        // A location whose job fails falls back to the free calls for its datasets and says why; a failed or stopped read cancels its jobs.
        using var failing = new Harness();
        var failingJobs = new BulkJobs();
        failingJobs.Route(failing.Fake);
        failing.Fake.On("GET", @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha/queries/[^/]+", BigQueryFake.Fixture("error-access-denied", 403));
        failing.Fake.On("GET", @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha/jobs/[^/]+", new BigQueryFake.Reply(200,
            "{\"jobReference\":{\"projectId\":\"varia-alpha\",\"jobId\":\"x\"},\"status\":{\"state\":\"DONE\",\"errorResult\":{\"reason\":\"accessDenied\",\"message\":\"Access Denied: INFORMATION_SCHEMA\"}}}"));
        await failing.ConnectAsync(key);
        var fellBack = await failing.Index(more => more["bulk"] = Bulk());
        check(fellBack.Status.Bulk is { Locations: 0, Failed: 1, Code: "PERMISSION_DENIED" } && Entries(failing.Service, failing.ConnectionId, "varia-alpha", "sales").SequenceEqual(rest)
            && failingJobs.Cancels == 3 && fellBack.Status.Skipped.Count == 0,
            $"a refused bulk read falls back to the free calls, fills the same entries, cancels its jobs and is reported once ({fellBack.Status.Bulk?.Code}, {failingJobs.Cancels} cancels)");
        check(harness.Fake.Unmatched.IsEmpty && failing.Fake.Unmatched.IsEmpty,
            "every bulk request had a route: " + string.Join(", ", harness.Fake.Unmatched.Concat(failing.Fake.Unmatched).Select(request => request.Method + " " + request.Url)));
    }
}
