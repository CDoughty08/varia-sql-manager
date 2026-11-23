using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.BigQuery;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>
/// BigQuery's Object Explorer, Script As, Preview Rows and Properties offline (docs/bigquery.md, Object Explorer): names reach SQL
/// text only through BqNames, the templates render hostile names safely, and the listers, tables.get, tabledata.list and the rate
/// limiter are proved on <see cref="BigQueryFake"/> with the REST fixtures. No request leaves the process.
/// </summary>
internal static class BigQueryExplorerChecks
{
    static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    const string Base = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha";
    const string Sales = Base + "/datasets/sales";

    public static async Task RunAsync(Action<bool, string> check)
    {
        Catalog(check);
        Names(check);
        Templates(check);
        Facts(check);
        await LimiterAsync(check);
        using var rsa = System.Security.Cryptography.RSA.Create(2048);
        var key = BigQueryCredentialChecks.Key(rsa.ExportPkcs8PrivateKeyPem());
        await ListersAsync(check, key);
        await ScriptAsync(check, key);
        await CreateAsync(check, key);
        await PreviewAsync(check, key);
        await PropertiesAsync(check, key);
    }

    /// <summary>The embedded catalogue's BigQuery kinds serve BigQuery alone, list through BigQueryService's listers, and the
    /// connection node serves both engines.</summary>
    static void Catalog(Action<bool, string> check)
    {
        var catalog = Varia.Backend.Explorer.ExplorerCatalog.Current;
        var kinds = catalog.Kinds.Where(kind => kind.BigQuery).ToList();
        check(kinds.Count == 9 && kinds.All(kind => kind.Serves(Providers.BigQuery) && !kind.Serves(Providers.SqlServer)) && catalog.KindOf("server").Serves(Providers.BigQuery)
            && catalog.KindOf("server").Serves(Providers.SqlServer) && !catalog.KindOf("database").Serves(Providers.BigQuery)
            && kinds.Where(kind => kind.List is not null).All(kind => BigQueryService.Lists.Contains(kind.List!)),
            "BigQuery's Explorer kinds serve BigQuery alone and list through its REST listers; the connection node serves both engines");
    }

    static readonly string[] Hostile = ["a`b", "a\\b", "a;DROP TABLE x", "a\nb", "a'b", "a\"b", "a/*b", "a.b", "", new string('a', 1025)];

    /// <summary>Each kind's rule refuses backticks, backslashes, quotes, line breaks and over-long names before any quoting.</summary>
    static void Names(Action<bool, string> check)
    {
        check(BqNames.IsTable("orders") && BqNames.IsTable("Ünïcode table-1") && BqNames.IsDataset("sales_2024") && BqNames.IsProject("varia-alpha") && BqNames.IsRoutine("to_cents")
            && BqNames.IsColumn("a&b") && BqNames.IsFieldPath("address.geo.lat"),
            "BigQuery names BigQuery allows pass their rules");
        var refused = Hostile.Where(name => BqNames.IsTable(name) || BqNames.IsDataset(name) || BqNames.IsRoutine(name) || BqNames.IsModel(name)).ToArray();
        var columns = Hostile.Where(name => name != "a'b" && BqNames.IsColumn(name)).ToArray();
        check(refused.Length == 0 && columns.Length == 0, "hostile names fail every table, dataset, routine, model and column rule: " + string.Join(", ", refused.Concat(columns)));
        check(!BqNames.IsFieldPath(string.Join('.', Enumerable.Repeat("a", 16))) && !BqNames.IsFieldPath("a..b") && !BqNames.IsProject("Varia_Alpha") && !BqNames.IsTable(new string('é', 513)),
            "a field path keeps to 15 parts, a project id to its rule, and a table name to 1,024 UTF-8 bytes");
        var thrown = Hostile.Count(name =>
        {
            try { BqNames.TablePath("varia-alpha", "sales", name); return false; }
            catch (RequestException error) { return error.Code == "INVALID_PARAMS"; }
        });
        check(thrown == Hostile.Length && BqNames.TablePath("varia-alpha", "sales", "my table") == "`varia-alpha`.`sales`.`my table`"
            && BqNames.FieldPathText("address.geo") == "`address`.`geo`",
            $"a hostile name throws INVALID_PARAMS before reaching text ({thrown}/{Hostile.Length}); each part is quoted on its own");
        var create = BigQueryService.CreateSql("varia-alpha", "sales", routine: false);
        var routine = BigQueryService.CreateSql("varia-alpha", "sales", routine: true);
        check(create == "SELECT ddl FROM `varia-alpha`.`sales`.INFORMATION_SCHEMA.TABLES WHERE table_name = @name"
            && routine == "SELECT ddl FROM `varia-alpha`.`sales`.INFORMATION_SCHEMA.ROUTINES WHERE routine_name = @name",
            "Script As › CREATE reads INFORMATION_SCHEMA's ddl with the name only as a parameter: " + create);
    }

    static List<TableFieldSchema> Fields() =>
    [
        new() { Name = "id", Type = "INTEGER", Mode = "REQUIRED" },
        new() { Name = "customer", Type = "STRING" },
        new() { Name = "tags", Type = "STRING", Mode = "REPEATED" },
        new() { Name = "a<b>", Type = "STRING" },
        new() { Name = "bad`col", Type = "STRING" }
    ];

    /// <summary>The local templates: SELECT with the bytes-billed comment and LIMIT, DML for tables only, DROP by type; a column
    /// whose name its rule refuses is left out, never quoted.</summary>
    static void Templates(Action<bool, string> check)
    {
        const string path = "`varia-alpha`.`sales`.`orders`";
        var select = BigQueryService.Template("select", "TABLE", Fields(), path);
        check(select == "-- LIMIT does not lower the bytes billed: BigQuery bills every column the query reads.\nSELECT\n  `id`,\n  `customer`,\n  `tags`,\n  `a<b>`\nFROM " + path + "\nLIMIT 1000;",
            "SELECT lists the top-level columns, skips a refused name, says LIMIT does not lower the bytes billed: " + select);
        check(BigQueryService.Template("select", "VIEW", [], path)!.Contains("SELECT *\nFROM", StringComparison.Ordinal), "a SELECT with no known columns reads *");
        var insert = BigQueryService.Template("insert", "TABLE", Fields(), path);
        var update = BigQueryService.Template("update", "TABLE", Fields(), path);
        var delete = BigQueryService.Template("delete", "TABLE", Fields(), path);
        check(insert == "INSERT INTO " + path + " (`id`, `customer`, `tags`, `a<b>`)\nVALUES (<id, INT64,>, <customer, STRING,>, <tags, ARRAY(STRING),>, <a_b_, STRING,>);"
            && update == "UPDATE " + path + "\nSET\n  `id` = <id, INT64,>,\n  `customer` = <customer, STRING,>,\n  `tags` = <tags, ARRAY(STRING),>,\n  `a<b>` = <a_b_, STRING,>\nWHERE <Search Conditions,,>;"
            && delete == "DELETE FROM " + path + "\nWHERE <Search Conditions,,>;",
            $"INSERT, UPDATE and DELETE use SSMS's template placeholders: {insert} | {update} | {delete}");
        var dml = new[] { "SNAPSHOT", "VIEW", "MATERIALIZED_VIEW", "EXTERNAL" }.SelectMany(type => new[] { "insert", "update", "delete" }.Select(verb => BigQueryService.Template(verb, type, Fields(), path)));
        check(dml.All(text => text is null), "only a TABLE has INSERT, UPDATE and DELETE templates");
        var drops = new[] { "TABLE", "SNAPSHOT", "VIEW", "MATERIALIZED_VIEW", "EXTERNAL" }.Select(type => BigQueryService.Template("drop", type, [], path)).ToArray();
        var comments = BigQueryService.Template("insert", "TABLE", [new() { Name = "a#b", Type = "STRING" }, new() { Name = "c--d", Type = "STRING" }], path);
        check(comments == "INSERT INTO " + path + " (`a#b`, `c--d`)\nVALUES (<a_b, STRING,>, <c__d, STRING,>);",
            "a placeholder never holds # or --, which would start a GoogleSQL comment: " + comments);
        check(drops.SequenceEqual(["DROP TABLE IF EXISTS " + path + ";", "DROP SNAPSHOT TABLE IF EXISTS " + path + ";", "DROP VIEW IF EXISTS " + path + ";",
            "DROP MATERIALIZED VIEW IF EXISTS " + path + ";", "DROP EXTERNAL TABLE IF EXISTS " + path + ";"]), "DROP names the object's type: " + string.Join(" | ", drops));
    }

    static void Facts(Action<bool, string> check)
    {
        var table = JsonSerializer.Deserialize<Table>(BigQueryFake.FixtureText("table-orders"), new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        var (type, groups) = BigQueryService.Facts(table, "varia-alpha.sales.orders");
        string? Fact(string group, string label) => groups.FirstOrDefault(item => item.Title == group)?.Facts.FirstOrDefault(fact => fact.Label == label)?.Value;
        check(type == "table" && groups.Select(group => group.Title).SequenceEqual(["Table", "Storage", "Layout", "History"])
            && Fact("Table", "Labels") == "env: dev, team: sales" && Fact("Storage", "Rows") == "1,234,567" && Fact("Storage", "Long-term logical size") is not null
            && Fact("Layout", "Partitioning") == "DAY on placed, partitions expire after 90 days" && Fact("Layout", "Clustering") == "customer, region" && Fact("Layout", "Columns") == "6"
            && Fact("History", "Created") == "2023-11-14 22:13:20 UTC" && Fact("History", "Expires") is null,
            "Properties' facts come from tables.get, formatted, empty facts left out: " + string.Join(" | ", groups.SelectMany(group => group.Facts.Select(fact => group.Title + "." + fact.Label + "=" + fact.Value))));
        table.CloneDefinition = new CloneDefinition { BaseTableReference = new TableReference { ProjectId = "varia-alpha", DatasetId = "sales", TableId = "base" } };
        table.Description = new string('x', 5000);
        var (clone, cloneGroups) = BigQueryService.Facts(table, "varia-alpha.sales.orders");
        var description = cloneGroups[0].Facts.First(fact => fact.Label == "Description").Value;
        check(clone == "clone" && cloneGroups[0].Facts.Any(fact => fact.Label == "Base table" && fact.Value == "varia-alpha.sales.base") && description.Length == BigQueryService.MaxFactValue && description.EndsWith('…'),
            "a clone names its base table, and a long value is clipped");
    }

    static async Task LimiterAsync(Action<bool, string> check)
    {
        var limiter = new BigQueryRateLimiter(2);
        var first = await limiter.EnterAsync("ada", CancellationToken.None);
        var second = await limiter.EnterAsync("ada", CancellationToken.None);
        var other = await limiter.EnterAsync("grace", CancellationToken.None);
        var third = limiter.EnterAsync("ada", CancellationToken.None);
        var waited = !third.IsCompleted && limiter.InUse("ada") == 2 && limiter.InUse("grace") == 1;
        first.Dispose();
        first.Dispose();
        var entered = await third.WaitAsync(TimeSpan.FromSeconds(30));
        check(waited && limiter.InUse("ada") == 2, "a principal's calls wait for one of its slots, another principal's do not, and a slot is returned once");
        using var cancel = new CancellationTokenSource();
        var fourth = limiter.EnterAsync("ada", cancel.Token);
        cancel.Cancel();
        var refused = false;
        try { await fourth; } catch (OperationCanceledException) { refused = true; }
        second.Dispose();
        entered.Dispose();
        other.Dispose();
        check(refused && limiter.InUse("ada") == 0 && limiter.InUse("grace") == 0, "a call waiting for a slot ends with its deadline and takes none");
        var rate = Api(429, "rateLimitExceeded");
        var forbidden = Api(403, "rateLimitExceeded");
        var denied = Api(403, "accessDenied");
        check(BigQueryRateLimiter.RateLimited(rate) && BigQueryRateLimiter.RateLimited(new HttpRequestException("x", forbidden)) && !BigQueryRateLimiter.RateLimited(denied)
            && !BigQueryRateLimiter.RateLimited(new TimeoutException()),
            "a 429, or a 403 for rateLimitExceeded, is a rate limit; an access denial is not");
    }

    static Google.GoogleApiException Api(int status, string reason) => new("bigquery", "refused")
    {
        HttpStatusCode = (System.Net.HttpStatusCode)status,
        Error = new Google.Apis.Requests.RequestError { Code = status, Message = "refused", Errors = [new Google.Apis.Requests.SingleError { Reason = reason, Message = "refused" }] }
    };

    // tables.get selects table columns with selectedFields, so any caller asking for a complete schema must leave it unset.
    static BigQueryFake.Reply TableSchema(BigQueryFake.Request request, string fixture)
    {
        var reply = BigQueryFake.Fixture(fixture);
        var selected = System.Web.HttpUtility.ParseQueryString(request.Uri.Query)["selectedFields"];
        if (selected is null) return reply;
        var table = JsonNode.Parse(reply.Body)!.AsObject();
        var fields = table["schema"]!["fields"]!.AsArray();
        var names = selected.Split(',').ToHashSet(StringComparer.Ordinal);
        table["schema"]!["fields"] = new JsonArray(fields.Where(field => names.Contains(field!["name"]!.GetValue<string>())).Select(field => field!.DeepClone()).ToArray());
        return reply with { Body = table.ToJsonString() };
    }

    sealed class Harness : IDisposable
    {
        public BigQueryFake Fake { get; }
        public SqlService Service { get; }
        public string ConnectionId { get; private set; } = "";

        public Harness(Varia.Backend.Results.ResultStore? store = null)
        {
            Fake = BigQueryFake.Google()
                .On("GET", Base + "/datasets/sales/tables", BigQueryFake.Fixture("tables"))
                .On("GET", Sales + "/tables/orders", request => TableSchema(request, "table-orders"))
                .On("GET", Sales + "/tables/preview", request => TableSchema(request, "table-preview"))
                .On("GET", Sales + "/tables/preview/data", BigQueryFake.Fixture("tabledata"))
                .On("GET", Sales + "/routines", BigQueryFake.Fixture("routines"))
                .On("GET", Sales + "/routines/refresh_totals", BigQueryFake.Fixture("routine-procedure"))
                .On("GET", Sales + "/models", BigQueryFake.Fixture("models"));
            Service = new SqlService(store, bigQuery: new BigQueryEnvironment(null, Fake.Factory, new SubjectTokens([])));
            Service.BigQuery.RetryDelay = TimeSpan.FromMilliseconds(1);
        }

        public async Task ConnectAsync(JsonObject key, long? cap = null)
        {
            var options = new JsonObject
            {
                ["provider"] = "bigquery", ["project"] = "varia-alpha", ["authentication"] = "serviceAccountKey", ["dataset"] = "sales", ["location"] = "US",
                ["extraProjects"] = new JsonArray("varia-beta", "varia-alpha"),
                ["credential"] = new JsonObject { ["source"] = "file", ["json"] = key.ToJsonString() }, ["keyFile"] = Guid.NewGuid().ToString()
            };
            if (cap is { } bytes) options["maximumBytesBilled"] = bytes;
            var (code, result, message) = await Call("connections.connect", options);
            if (code != "ok") throw new InvalidOperationException("connect: " + code + " " + message);
            ConnectionId = ((ConnectionInfo)result!).Id;
        }

        public async Task<(string Code, object? Result, string Message)> Call(string method, JsonNode parameters, RequestContext? context = null)
        {
            using var document = JsonDocument.Parse(parameters.ToJsonString());
            try { return ("ok", await Service.DispatchAsync(method, document.RootElement.Clone(), Wire, context), ""); }
            catch (RequestException error) { return (error.Code, null, error.Message); }
        }

        public async Task<ExplorerChildrenResult?> Children(JsonObject node, string? cursor = null, int pageSize = 500)
        {
            var args = new JsonObject { ["connectionId"] = ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["node"] = node, ["pageSize"] = pageSize };
            if (cursor is not null) args["cursor"] = cursor;
            var (code, result, message) = await Call("explorer.children", args);
            return code == "ok" ? result as ExplorerChildrenResult : throw new InvalidOperationException(code + " " + message);
        }

        public async Task<(string Code, ScriptResult? Result)> Script(string verb, JsonObject target, bool? estimateOnly = null, long? cap = null)
        {
            var args = new JsonObject
            {
                ["connectionId"] = ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["targets"] = new JsonArray(target), ["verb"] = verb,
                ["options"] = JsonSerializer.SerializeToNode(ScriptingLiveChecks.Defaults(Wire), Wire)
            };
            if (estimateOnly is { } estimate) args["estimateOnly"] = estimate;
            if (cap is { } bytes) args["maximumBytesBilled"] = bytes;
            var (code, result, _) = await Call("scripting.script", args);
            return (code, result as ScriptResult);
        }

        public void Dispose() => Service.Dispose();
    }

    static JsonObject Object(string kind, string name, string? dataset = "sales", string? table = null)
    {
        var value = new JsonObject { ["kind"] = kind, ["name"] = name };
        if (kind != "bqProject") value["project"] = "varia-alpha";
        if (dataset is not null && kind != "bqProject" && kind != "bqDataset") value["dataset"] = dataset;
        if (table is not null) value["table"] = table;
        return new JsonObject { ["type"] = "object", ["object"] = value };
    }

    static JsonObject Folder(JsonObject owner, string folder) => new() { ["type"] = "folder", ["owner"] = owner["object"]!.DeepClone(), ["folder"] = folder };

    static string Labels(ExplorerChildrenResult? result) => result is null ? "null" : string.Join(", ", result.Nodes.Select(node => node.Label + (node.Subtype is { } s ? "/" + s : "") + (node.Sublabel is { } l ? " (" + l + ")" : "")));

    static async Task ListersAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        var server = await harness.Children(new JsonObject { ["type"] = "object", ["object"] = new JsonObject { ["kind"] = "server" } });
        check(Labels(server) == "varia-alpha (billing project), varia-beta" && server!.Nodes.All(node => node.Ref.Object!.Kind == "bqProject" && node.HasChildren),
            "the connection node lists the billing project, then its extra projects once: " + Labels(server));
        var datasets = await harness.Children(Object("bqProject", "varia-alpha"));
        check(Labels(datasets) == "staging (US), sales" && datasets!.Cursor is { } cursor && cursor.StartsWith("v1.bqDatasets.", StringComparison.Ordinal)
            && datasets.Nodes.All(node => node.Ref.Object is { Kind: "bqDataset", Project: "varia-alpha" }),
            "a project lists datasets.list's datasets with their location (a malformed id or location dropped) and a cursor: " + Labels(datasets) + " " + datasets?.Cursor);
        var second = await harness.Children(Object("bqProject", "varia-alpha"), datasets!.Cursor);
        check(harness.Fake.To(Base + "/datasets").Any(request => request.Uri.Query.Contains("pageToken=page-2", StringComparison.Ordinal)) && second is { Cursor: null },
            "the cursor carries datasets.list's page token back to it");
        var folders = await harness.Children(Object("bqDataset", "sales"));
        check(Labels(folders) == "Tables, Views, Materialized Views, External Tables, Routines, Models" && folders!.Nodes.All(node => node.Ref.Type == "folder"),
            "a dataset shows its six static folders without a request: " + Labels(folders));
        var dataset = Object("bqDataset", "sales");
        var tables = await harness.Children(Folder(dataset, "bqTables"));
        var views = await harness.Children(Folder(dataset, "bqViews"));
        var materialized = await harness.Children(Folder(dataset, "bqMaterializedViews"));
        var external = await harness.Children(Folder(dataset, "bqExternalTables"));
        check(Labels(tables) == "orders, orders_2024/snapshot" && Labels(views) == "daily" && Labels(materialized) == "totals" && Labels(external) == "landing"
            && tables!.Cursor is { } tableCursor && System.Text.RegularExpressions.Regex.IsMatch(tableCursor, "^v1\\.bqTables\\.[A-Za-z0-9_-]+$"),
            $"tables.list fills each folder with its types (a snapshot is a table), drops a refused name, and its cursor stays URL-safe: {Labels(tables)} | {Labels(views)} | {Labels(materialized)} | {Labels(external)} {tables?.Cursor}");
        await harness.Children(Folder(dataset, "bqTables"), tables!.Cursor);
        check(harness.Fake.To(Base + "/datasets/sales/tables").Any(request => Uri.UnescapeDataString(request.Uri.Query).Contains("pageToken=tables/page+2=", StringComparison.Ordinal)),
            "a page token with / + and = survives the cursor round trip");
        var routines = await harness.Children(Folder(dataset, "bqRoutines"));
        var models = await harness.Children(Folder(dataset, "bqModels"));
        check(Labels(routines) == "refresh_totals/procedure, to_cents/scalar (JAVASCRIPT)" && Labels(models) == "churn (logistic regression)" && !routines!.Nodes[0].HasChildren,
            $"routines.list and models.list fill Routines and Models: {Labels(routines)} | {Labels(models)}");
        var orders = Object("bqTable", "orders");
        var columns = await harness.Children(Folder(orders, "bqColumns"));
        check(Labels(columns) == "id (INT64, required), customer (STRING), tags (ARRAY<STRING>), placed (TIMESTAMP), address/struct (STRUCT)" && columns!.Total == 6
            && columns.Nodes.Single(node => node.Label == "address") is { HasChildren: true, Ref.Object: { Kind: "bqColumn", Table: "orders", Name: "address" } },
            "a table's Columns come from tables.get's schema with their types; a STRUCT expands: " + Labels(columns));
        var paged = await harness.Children(Folder(orders, "bqColumns"), pageSize: 2);
        var rest = await harness.Children(Folder(orders, "bqColumns"), paged!.Cursor, pageSize: 2);
        check(Labels(paged) == "id (INT64, required), customer (STRING)" && paged.Cursor == "v1.bqColumns.2" && Labels(rest).StartsWith("tags", StringComparison.Ordinal),
            "Columns page by offset: " + Labels(paged) + " | " + Labels(rest));
        var fields = await harness.Children(Object("bqColumn", "address", table: "orders"));
        var deeper = await harness.Children(Object("bqColumn", "address.geo", table: "orders"));
        var missing = await harness.Children(Object("bqColumn", "customer", table: "orders"));
        check(Labels(fields) == "city (STRING), geo/struct (STRUCT)" && Labels(deeper) == "lat (FLOAT64)" && deeper!.Nodes[0].Ref.Object!.Name == "address.geo.lat"
            && missing is { Error.Code: "NOT_FOUND" },
            $"a STRUCT column lists its fields by path; a column that is not a STRUCT answers NOT_FOUND: {Labels(fields)} | {Labels(deeper)} | {missing?.Error?.Code}");
        var (refusedCode, _, _) = await harness.Call("explorer.children", new JsonObject
        {
            ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["node"] = new JsonObject { ["type"] = "object", ["object"] = new JsonObject { ["kind"] = "database", ["name"] = "master" } }
        });
        var (hostileCode, _, _) = await harness.Call("explorer.children", new JsonObject
        {
            ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["node"] = Folder(Object("bqDataset", "sa`les"), "bqTables")
        });
        check(refusedCode == "INVALID_PARAMS" && hostileCode == "INVALID_PARAMS", $"a SQL Server kind, or a dataset its rule refuses, is refused before any request: {refusedCode} {hostileCode}");

        // The rate limit: two refusals, then the listing; a denial is the row's error, not retried.
        var limited = 0;
        harness.Fake.On("GET", Sales + "/models", _ => Interlocked.Increment(ref limited) <= 2 ? BigQueryFake.Fixture("error-rate-limit", 403) : BigQueryFake.Fixture("models"));
        var retried = await harness.Children(Folder(dataset, "bqModels"));
        harness.Fake.On("GET", Sales + "/routines", BigQueryFake.Fixture("error-access-denied", 403));
        var before = harness.Fake.To(Sales + "/routines").Count();
        var denied = await harness.Children(Folder(dataset, "bqRoutines"));
        check(limited == 3 && Labels(retried) == "churn (logistic regression)" && denied is { Nodes.Count: 0, Error: { Code: "PERMISSION_DENIED", Retryable: false } }
            && harness.Fake.To(Sales + "/routines").Count() == before + 1 && harness.Service.BigQuery.Limiter.InUse(harness.Service.BigQuery.Find(harness.ConnectionId)!.Principal.PrincipalId) == 0,
            $"a rate-limited listing retries until it lists; a denial is the row's error after one request, and the slots are returned: {limited} {denied?.Error?.Code} {denied?.Error?.Message}");
        check(harness.Fake.Unmatched.IsEmpty, "every listing request was answered by a fixture: " + string.Join(", ", harness.Fake.Unmatched.Select(request => request.Method + " " + request.Url)));
    }

    static async Task ScriptAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        var orders = Object("bqTable", "orders")["object"]!.AsObject();
        var select = await harness.Script("select", (JsonObject)orders.DeepClone());
        check(select is { Code: "ok", Result: { Error: null, Database: "sales", Commands: 0 } } && select.Result.Text!.Contains("  `address`\nFROM", StringComparison.Ordinal) && !select.Result.Text.Contains("bad", StringComparison.Ordinal)
            && System.Web.HttpUtility.ParseQueryString(harness.Fake.To(Sales + "/tables/orders").Last().Uri.Query)["fields"] == "schema,type",
            "Script As › SELECT reads tables.get's schema and runs in the dataset: " + select.Result?.Text);
        var drop = await harness.Script("drop", (JsonObject)Object("bqRoutine", "refresh_totals")["object"]!.DeepClone());
        check(drop.Result?.Text == "DROP PROCEDURE IF EXISTS `varia-alpha`.`sales`.`refresh_totals`;", "a routine's DROP reads its type from routines.get: " + drop.Result?.Text);
        harness.Fake.On("GET", Sales + "/routines/total", new BigQueryFake.Reply(200, """{"routineType":"AGGREGATE_FUNCTION"}"""));
        var aggregate = await harness.Script("drop", (JsonObject)Object("bqRoutine", "total")["object"]!.DeepClone());
        check(aggregate.Result?.Text == "DROP FUNCTION IF EXISTS `varia-alpha`.`sales`.`total`;", "an aggregate routine uses DROP FUNCTION: " + aggregate.Result?.Text);
        var jobsBefore = harness.Fake.To(BigQueryFake.Jobs).Count();
        var estimate = await harness.Script("create", (JsonObject)orders.DeepClone(), estimateOnly: true);
        var dryRun = harness.Fake.To(BigQueryFake.Jobs).Skip(jobsBefore).Select(request => JsonNode.Parse(request.Body)!).ToArray();
        check(estimate is { Code: "ok", Result: { Text: null, Estimate: not null } } && dryRun.Length == 1 && dryRun[0]["configuration"]!["dryRun"]!.GetValue<bool>()
            && dryRun[0]["configuration"]!["query"]!["query"]!.GetValue<string>() == BigQueryService.CreateSql("varia-alpha", "sales", false)
            && dryRun[0]["configuration"]!["query"]!["queryParameters"]![0]!["parameterValue"]!["value"]!.GetValue<string>() == "orders",
            "Script As › CREATE first asks for a dry run of its INFORMATION_SCHEMA query, the name a parameter: " + estimate.Code);
        var sqlServerKind = await harness.Script("select", new JsonObject { ["kind"] = "table", ["database"] = "sales", ["schema"] = "dbo", ["name"] = "orders" });
        check(sqlServerKind.Code == "INVALID_PARAMS", "a SQL Server kind cannot be scripted on a BigQuery connection: " + sqlServerKind.Code);
        var estimateDrop = await harness.Script("drop", (JsonObject)orders.DeepClone(), estimateOnly: true);
        harness.Fake.On("GET", Sales + "/tables/orders", BigQueryFake.Fixture("error-not-found", 404));
        var gone = await harness.Script("select", (JsonObject)orders.DeepClone());
        check(estimateDrop.Code == "INVALID_PARAMS" && gone.Result?.Error?.Code == "NOT_FOUND", $"only CREATE has an estimate, and a vanished table is the script's NOT_FOUND: {estimateDrop.Code} {gone.Result?.Error?.Code}");
    }

    /// <summary>The billed CREATE run: the job's query, parameter, location and cap; polling until its results are ready; zero rows
    /// and a NULL ddl; a script past 4,000,000 characters; and the job cancelled when the budget abandons it.</summary>
    static async Task CreateAsync(Action<bool, string> check, JsonObject key)
    {
        var inserts = new System.Collections.Concurrent.ConcurrentQueue<JsonNode>();
        var cancels = new System.Collections.Concurrent.ConcurrentQueue<string>();
        var polls = 0;
        JsonNode? ddl = "CREATE TABLE `varia-alpha.sales.orders`\n(\n  id INT64 NOT NULL\n)";
        var rows = 1;
        var hold = false;
        JsonObject? jobError = null;
        var dryRunDenied = false;
        BigQueryFake Routes(BigQueryFake fake) => fake
            .On("POST", BigQueryFake.Jobs, request =>
            {
                var body = JsonNode.Parse(request.Body)!;
                if (body["configuration"]?["dryRun"]?.GetValue<bool>() == true)
                    return dryRunDenied ? new BigQueryFake.Reply(403, "{\"error\":{\"code\":403,\"message\":\"Access Denied: Table varia-alpha:sales.orders: Permission bigquery.tables.get denied\",\"errors\":[{\"reason\":\"accessDenied\",\"message\":\"Access Denied\"}]}}")
                        : BigQueryFake.Fixture("dry-run");
                inserts.Enqueue(body);
                var id = body["jobReference"]!["jobId"]!.GetValue<string>();
                return new BigQueryFake.Reply(200, new JsonObject
                {
                    ["kind"] = "bigquery#job", ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "EU" },
                    ["status"] = jobError is null ? new JsonObject { ["state"] = "RUNNING" }
                        : new JsonObject { ["state"] = "DONE", ["errorResult"] = jobError.DeepClone(), ["errors"] = new JsonArray(jobError.DeepClone()) },
                    ["configuration"] = new JsonObject { ["jobType"] = "QUERY" }
                }.ToJsonString());
            })
            .On("GET", Base + "/queries/[^/]+", request =>
            {
                var id = request.Url[(request.Url.LastIndexOf('/') + 1)..];
                var reference = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "EU" };
                if (hold || Interlocked.Increment(ref polls) == 1)
                    return new BigQueryFake.Reply(200, new JsonObject { ["jobReference"] = reference, ["jobComplete"] = false }.ToJsonString());
                var answer = new JsonObject
                {
                    ["jobReference"] = reference, ["jobComplete"] = true, ["totalRows"] = rows.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ["schema"] = new JsonObject { ["fields"] = new JsonArray(new JsonObject { ["name"] = "ddl", ["type"] = "STRING" }) }
                };
                if (rows > 0) answer["rows"] = new JsonArray(new JsonObject { ["f"] = new JsonArray(new JsonObject { ["v"] = ddl?.DeepClone() }) });
                return new BigQueryFake.Reply(200, answer.ToJsonString());
            })
            .On("POST", Base + "/jobs/[^/]+/cancel", request =>
            {
                var id = request.Url[..request.Url.LastIndexOf('/')];
                cancels.Enqueue(id[(id.LastIndexOf('/') + 1)..]);
                return new BigQueryFake.Reply(200, "{\"kind\":\"bigquery#jobCancelResponse\",\"job\":{\"jobReference\":{\"projectId\":\"varia-alpha\",\"jobId\":\"x\"},\"status\":{\"state\":\"DONE\"}}}");
            });
        var orders = Object("bqTable", "orders")["object"]!.AsObject();

        using (var harness = new Harness())
        {
            Routes(harness.Fake);
            harness.Service.BigQuery.DdlPoll = TimeSpan.FromMilliseconds(5);
            await harness.ConnectAsync(key);
            var created = await harness.Script("create", (JsonObject)orders.DeepClone(), cap: 50_000_000);
            var body = inserts.LastOrDefault();
            var query = body?["configuration"]?["query"];
            check(created is { Code: "ok", Result: { Error: null, Commands: 1, Database: "sales" } } && created.Result.Text == "CREATE TABLE `varia-alpha.sales.orders`\n(\n  id INT64 NOT NULL\n);"
                && polls == 2 && body?["configuration"]?["dryRun"]?.GetValue<bool>() != true && query?["query"]?.GetValue<string>() == BigQueryService.CreateSql("varia-alpha", "sales", false)
                && query?["queryParameters"]?[0]?["parameterValue"]?["value"]?.GetValue<string>() == "orders" && query?["maximumBytesBilled"]?.ToString() == "50000000"
                && body?["jobReference"]?["location"]?.GetValue<string>() is { Length: > 0 } && cancels.IsEmpty,
                $"Script As › CREATE runs its INFORMATION_SCHEMA query under the cap in the dataset's location, polls until ready, and ends the script: {created.Code} {created.Result?.Error?.Message} {created.Result?.Text} polls {polls} {body?.ToJsonString()}");
            rows = 0;
            var missing = await harness.Script("create", (JsonObject)orders.DeepClone());
            rows = 1;
            ddl = null;
            var empty = await harness.Script("create", (JsonObject)orders.DeepClone());
            check(missing.Result?.Error?.Code == "NOT_FOUND" && empty.Result?.Error?.Code == "NOT_SUPPORTED" && cancels.IsEmpty,
                $"no row is NOT_FOUND and a NULL ddl NOT_SUPPORTED, and a read job is not cancelled: {missing.Result?.Error?.Code} {empty.Result?.Error?.Code} {cancels.Count}");

            // The budget abandons a job that never finishes: TIMEOUT, and jobs.cancel for that job.
            hold = true;
            harness.Service.BigQuery.ScriptLimit = TimeSpan.FromMilliseconds(300);
            var abandoned = await harness.Script("create", (JsonObject)orders.DeepClone());
            var abandonedId = inserts.Last()["jobReference"]!["jobId"]!.GetValue<string>();
            var cancelled = await BigQuerySessionChecks.Poll(() => cancels.Contains(abandonedId));
            check(abandoned.Result?.Error?.Code == "TIMEOUT" && cancelled, $"a CREATE its budget abandons is TIMEOUT, and its job is cancelled: {abandoned.Result?.Error?.Code} {string.Join(",", cancels)}");
        }

        using (var capped = new Harness())
        {
            Routes(capped.Fake);
            hold = false;
            ddl = "CREATE VIEW v AS SELECT 1";
            capped.Service.BigQuery.DdlPoll = TimeSpan.FromMilliseconds(5);
            await capped.ConnectAsync(key, cap: 1_048_576);
            var run = await capped.Script("create", (JsonObject)orders.DeepClone(), cap: 50_000_000);
            jobError = new JsonObject { ["reason"] = "bytesBilledLimitExceeded", ["message"] = "Query exceeded limit for bytes billed: 1048576. 10485760 or higher required." };
            var overCap = await capped.Script("create", (JsonObject)orders.DeepClone());
            jobError = new JsonObject { ["reason"] = "accessDenied", ["message"] = "Access Denied: Table varia-alpha:sales.INFORMATION_SCHEMA.TABLES" };
            var denied = await capped.Script("create", (JsonObject)orders.DeepClone());
            jobError = null;
            dryRunDenied = true;
            var estimateDenied = await capped.Script("create", (JsonObject)orders.DeepClone(), estimateOnly: true);
            dryRunDenied = false;
            check(estimateDenied.Result?.Error is { Code: "PERMISSION_DENIED" } refusal && !refusal.Message.Contains("jobs.create", StringComparison.Ordinal) && refusal.Message.Contains("bigquery.tables.get", StringComparison.Ordinal),
                "a CREATE estimate refused for the table shows Google's reason, not jobs.create: " + estimateDenied.Result?.Error?.Message);
            check(overCap.Result?.Error?.Code == "COST_CAP" && denied.Result?.Error?.Code == "PERMISSION_DENIED",
                $"a CREATE job BigQuery fails keeps its own error (COST_CAP, PERMISSION_DENIED): {overCap.Result?.Error?.Code} {overCap.Result?.Error?.Message} {denied.Result?.Error?.Code}");
            check(run.Result?.Error is null && inserts.Last()["configuration"]!["query"]!["maximumBytesBilled"]!.ToString() == "1048576",
                "the connection's own cap wins over the one the prompts set: " + inserts.Last()["configuration"]!["query"]!["maximumBytesBilled"]);

            // A 10,000-column table's INSERT template passes 4,000,000 characters: TOO_LARGE, not an unbounded answer.
            var fields = new JsonArray([.. Enumerable.Range(0, 10_000).Select(i => (JsonNode)new JsonObject { ["name"] = "c" + i.ToString("D5", System.Globalization.CultureInfo.InvariantCulture) + new string('x', 290), ["type"] = "STRING" })]);
            capped.Fake.On("GET", Sales + "/tables/wide", new BigQueryFake.Reply(200, new JsonObject { ["type"] = "TABLE", ["schema"] = new JsonObject { ["fields"] = fields } }.ToJsonString()));
            var wide = await capped.Script("insert", (JsonObject)Object("bqTable", "wide")["object"]!.DeepClone());
            var narrow = await capped.Script("select", (JsonObject)Object("bqTable", "wide")["object"]!.DeepClone());
            check(wide.Result is { Text: null, Error.Code: "TOO_LARGE" } && narrow.Result?.Text is { Length: > 3_000_000 and <= 4_000_000 },
                $"a script past 4,000,000 characters is TOO_LARGE: {wide.Result?.Error?.Code} {narrow.Result?.Text?.Length}");
        }
    }

    static async Task PreviewAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        JsonObject Query(string table) => new()
        {
            ["connectionId"] = harness.ConnectionId, ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = "SELECT 1",
            ["maxRows"] = 0, ["timeoutSeconds"] = 0, ["preview"] = new JsonObject { ["project"] = "varia-alpha", ["dataset"] = "sales", ["table"] = table }
        };
        var jobsBefore = harness.Fake.To(BigQueryFake.Jobs).Count();
        var (code, result, message) = await harness.Call("query.execute", Query("preview"));
        var preview = result as QueryResult;
        var read = harness.Fake.To(Sales + "/tables/preview/data").Single();
        check(code == "ok" && preview is { Status: "completed", Database: "sales" } && preview.ResultSets is [{ RowsStored: 3, Columns: [{ Name: "id" }, { Name: "customer" }] } set]
            && LiveResultChecks.RowsOf(harness.Service.Results, set) is [["1", "ada"], ["2", null], ["3", "grace"]] && harness.Fake.To(BigQueryFake.Jobs).Count() == jobsBefore
            && read.Uri.Query.Contains("maxResults=1000", StringComparison.Ordinal) && read.Uri.Query.Contains("formatOptions.useInt64Timestamp=true", StringComparison.Ordinal)
            && preview.Messages.Any(item => item.Text.Contains("tabledata.list", StringComparison.Ordinal)),
            $"Preview Rows reads tabledata.list into a result and runs no job: {code} {message} {preview?.Status} {preview?.ResultSets.FirstOrDefault()?.RowsStored}");
        harness.Fake.On("GET", Sales + "/tables/daily", new BigQueryFake.Reply(200, "{\"type\":\"VIEW\",\"schema\":{\"fields\":[{\"name\":\"a\",\"type\":\"STRING\"}]}}"));
        var (_, viewResult, _) = await harness.Call("query.execute", Query("daily"));
        var view = viewResult is QueryResult { Status: "failed", Error.Code: "INVALID_PARAMS" } refused ? refused.Error.Message : null;
        harness.Fake.On("GET", Sales + "/tables/preview/data", BigQueryFake.Fixture("error-row-access", 400));
        var (rowCode, rowResult, _) = await harness.Call("query.execute", Query("preview"));
        var rows = rowResult as QueryResult;
        check(view is not null && view.Contains("Script As", StringComparison.Ordinal) && rows is { Status: "failed", Error.Code: "ROW_ACCESS" },
            $"a view is refused with Script As › SELECT offered; row access policies answer ROW_ACCESS: {view} {rows?.Status} {rows?.Error?.Code}");
        var (hostile, _, _) = await harness.Call("query.execute", Query("pre`view"));
        var badDataset = Query("preview");
        badDataset["dataset"] = "sa`les";
        var (datasetCode, _, _) = await harness.Call("query.execute", badDataset);
        var plan = Query("preview");
        plan["includeActualPlan"] = true;
        var (planCode, _, _) = await harness.Call("query.execute", plan);
        check(hostile == "INVALID_PARAMS" && datasetCode == "INVALID_PARAMS" && planCode == "UNSUPPORTED_PROVIDER",
            $"a preview of a refused name, with a refused tab dataset, or with SQL Server's options is refused: {hostile} {datasetCode} {planCode}");
        // A preview reads into memory whatever Keep results says, but its residence and window cache are bounded as Execute's.
        var badResidence = Query("preview");
        badResidence["residence"] = "disk";
        var (residenceCode, _, _) = await harness.Call("query.execute", badResidence);
        var badCache = Query("preview");
        badCache["windowCacheMiB"] = 1;
        var (cacheCode, _, _) = await harness.Call("query.execute", badCache);
        check(residenceCode == "INVALID_PARAMS" && cacheCode == "INVALID_PARAMS", $"a preview refuses an invalid residence or window cache: {residenceCode} {cacheCode}");

        // The tab keeps its own dataset (here the connection's), not the previewed table's, which may be another project's.
        harness.Fake.On("GET", Base + "/datasets/staging/tables/preview", BigQueryFake.Fixture("table-preview"));
        harness.Fake.On("GET", Base + "/datasets/staging/tables/preview/data", BigQueryFake.Fixture("tabledata"));
        var elsewhere = Query("preview");
        elsewhere["preview"]!["dataset"] = "staging";
        var (_, otherResult, _) = await harness.Call("query.execute", elsewhere);
        check(otherResult is QueryResult { Status: "completed", Database: "sales" }, "Preview Rows reports the tab's dataset, not the table's: " + (otherResult as QueryResult)?.Database);

        // A full result budget stops the reading: no page after the one the budget refused.
        using var small = new Harness(new Varia.Backend.Results.ResultStore(256 * 1024, 128 * 1024));
        await small.ConnectAsync(key);
        var wide = new string('w', 2000);
        small.Fake.On("GET", Sales + "/tables/preview/data", request =>
        {
            var page = request.Uri.Query.Contains("pageToken=", StringComparison.Ordinal) ? int.Parse(System.Web.HttpUtility.ParseQueryString(request.Uri.Query)["pageToken"]!, System.Globalization.CultureInfo.InvariantCulture) : 0;
            var rows = string.Join(",", Enumerable.Range(0, 50).Select(i => "{\"f\":[{\"v\":\"" + (page * 50 + i) + "\"},{\"v\":\"" + wide + "\"}]}"));
            return new BigQueryFake.Reply(200, "{\"totalRows\":\"1000\",\"rows\":[" + rows + "]" + (page < 19 ? ",\"pageToken\":\"" + (page + 1) + "\"" : "") + "}");
        });
        JsonObject SmallQuery() => new()
        {
            ["connectionId"] = small.ConnectionId, ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = "SELECT 1",
            ["maxRows"] = 0, ["timeoutSeconds"] = 0, ["preview"] = new JsonObject { ["project"] = "varia-alpha", ["dataset"] = "sales", ["table"] = "preview" }
        };
        var (_, fullResult, _) = await small.Call("query.execute", SmallQuery());
        var full = fullResult as QueryResult;
        var pages = small.Fake.To(Sales + "/tables/preview/data").Count();
        check(full is { Status: "completed" } && full.ResultSets.Single() is { Truncated: "queryBudget" or "globalBudget" } && pages < 20,
            $"a preview the result budget stops completes without reading the table's other pages: {full?.Status} {full?.ResultSets.FirstOrDefault()?.Truncated} {pages} pages");
    }

    static async Task PropertiesAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        JsonObject Args(string kind, string name) => new()
        {
            ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["kind"] = kind, ["project"] = "varia-alpha", ["dataset"] = "sales", ["name"] = name
        };
        var connected = harness.Fake.Seen.Count;
        var (code, result, _) = await harness.Call("bigquery.properties", Args("bqTable", "orders"));
        var properties = result as BigQueryProperties;
        var (model, _, _) = await harness.Call("bigquery.properties", Args("bqModel", "orders"));
        var (badRoutine, _, _) = await harness.Call("bigquery.properties", Args("bqRoutine", "a.b"));
        // The details pane's columns: the fields flattened depth first as the index has them (a bad name left out), descriptions beside them.
        var columns = properties?.Columns?.Select(column => column.Name + ":" + column.Type + (column.Description is { } description ? ":" + description : "")).ToArray() ?? [];
        check(columns.SequenceEqual(["id:INT64", "customer:STRING", "tags:ARRAY<STRING>", "placed:TIMESTAMP", "address:STRUCT", "address.city:STRING", "address.geo:STRUCT", "address.geo.lat:FLOAT64"])
            && properties is { Definition: null, DefinitionCut: null, ColumnsCut: null },
            $"bigquery.properties answers a table's columns as the index flattens them, with no definition: {string.Join(" ", columns)}");
        var described = JsonNode.Parse(BigQueryFake.FixtureText("table-orders"))!;
        described["schema"]!["fields"]![1]!["description"] = "Who placed it.";
        described["schema"]!["fields"]![4]!["fields"]![0]!["description"] = new string('d', 2000);
        harness.Fake.On("GET", Sales + "/tables/orders", new BigQueryFake.Reply(200, described.ToJsonString()));
        var withDescriptions = (await harness.Call("bigquery.properties", Args("bqTable", "orders"))).Result as BigQueryProperties;
        check(withDescriptions?.Columns?[1].Description == "Who placed it." && withDescriptions.Columns[5].Description is { Length: BigQueryService.MaxColumnText } bounded && bounded.EndsWith('…')
            && withDescriptions.Columns[0].Description is null,
            "bigquery.properties carries column descriptions, bounded at 1,024 characters");
        harness.Fake.On("GET", Sales + "/tables/daily", BigQueryFake.Fixture("index-view-daily"));
        var view = (await harness.Call("bigquery.properties", Args("bqView", "daily"))).Result as BigQueryProperties;
        check(view is { Type: "view", Definition: { } query } && query.StartsWith("SELECT DATE(placed)", StringComparison.Ordinal) && view.Columns?.Count == 2,
            $"bigquery.properties answers a view's query text and columns: {view?.Type} {view?.Columns?.Count}");
        harness.Fake.On("GET", Sales + "/tables/long", new BigQueryFake.Reply(200, new JsonObject
        {
            ["type"] = "VIEW", ["view"] = new JsonObject { ["query"] = "SELECT '" + new string('x', BigQueryService.MaxDefinition) + "'" }
        }.ToJsonString()));
        var longView = (await harness.Call("bigquery.properties", Args("bqView", "long"))).Result as BigQueryProperties;
        check(longView is { DefinitionCut: true, Definition.Length: BigQueryService.MaxDefinition, Columns: null },
            $"bigquery.properties cuts a view's text at 1,000,000 characters: {longView?.Definition?.Length} {longView?.DefinitionCut}");
        harness.Fake.On("GET", Sales + "/routines/to_cents", new BigQueryFake.Reply(200, """
            {"routineReference":{"projectId":"varia-alpha","datasetId":"sales","routineId":"to_cents"},"routineType":"SCALAR_FUNCTION","language":"SQL",
             "description":"Dollars to cents.","creationTime":"1700000000000","lastModifiedTime":"1700086400000","definitionBody":"CAST(x * 100 AS INT64)",
             "arguments":[{"name":"x","dataType":{"typeKind":"NUMERIC"}}],"returnType":{"typeKind":"INT64"}}
            """));
        var (routineCode, routineResult, _) = await harness.Call("bigquery.properties", Args("bqRoutine", "to_cents"));
        var routine = routineResult as BigQueryProperties;
        var routineFacts = routine?.Groups.SelectMany(group => group.Facts.Select(fact => group.Title + "/" + fact.Label + "=" + fact.Value)).ToArray() ?? [];
        check(routineCode == "ok" && routine is { Name: "to_cents", Type: "function", Definition: "CAST(x * 100 AS INT64)", Columns: null }
            && routineFacts.Contains("Routine/Full name=varia-alpha.sales.to_cents") && routineFacts.Contains("Routine/Language=SQL")
            && routineFacts.Contains("Routine/Signature=(x NUMERIC) RETURNS INT64") && routineFacts.Contains("Routine/Description=Dollars to cents.")
            && routine.Groups.Select(group => group.Title).SequenceEqual(["Routine", "History"]) && harness.Fake.To(Sales + "/routines/to_cents").Count() == 1,
            $"bigquery.properties answers a routine's facts and body from one routines.get: {routineCode} {string.Join(" | ", routineFacts)}");
        harness.Fake.On("GET", Sales + "/tables/orders", BigQueryFake.Fixture("error-not-found", 404));
        var (gone, _, _) = await harness.Call("bigquery.properties", Args("bqTable", "orders"));
        check(code == "ok" && properties is { Name: "orders", Type: "table" } && properties.Groups.Count == 4 && model == "INVALID_PARAMS" && badRoutine == "INVALID_PARAMS" && gone == "NOT_FOUND",
            $"bigquery.properties answers tables.get's facts for table-like kinds and routines.get's for routines, and NOT_FOUND for a vanished table: {code} {model} {badRoutine} {gone}");
        check(harness.Fake.Seen.Skip(connected).All(request => !request.Uri.AbsolutePath.EndsWith("/queries", StringComparison.Ordinal) && !request.Uri.AbsolutePath.EndsWith("/jobs", StringComparison.Ordinal)),
            "bigquery.properties runs no query or job: every fact is free metadata");
    }
}
