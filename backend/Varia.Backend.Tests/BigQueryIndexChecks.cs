using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Varia.Backend.BigQuery;
using Varia.Backend.Protocol;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>
/// The Search Objects index for BigQuery offline (docs/object-search.md, BigQuery): the two REST passes, date-sharded groups, extra
/// projects by name, kinds and their subtype variants, column types and nested paths, definitions, project and dataset narrowing,
/// refresh reuse, scoped and stale refreshes, failures as skips, the memory budget, and the disconnect. Every request goes to
/// <see cref="BigQueryFake"/>; none leaves the process, and no check runs a job.
/// </summary>
internal static partial class BigQueryIndexChecks
{
    static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    const string Alpha = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha";
    const string Beta = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-beta";
    const string Sales = Alpha + "/datasets/sales";

    public static async Task RunAsync(Action<bool, string> check)
    {
        Entries(check);
        Ddl(check);
        Budget(check);
        Reuse(check);
        using var rsa = System.Security.Cryptography.RSA.Create(2048);
        var key = BigQueryCredentialChecks.Key(rsa.ExportPkcs8PrivateKeyPem());
        await BuildAsync(check, key);
        await RefreshAsync(check, key);
        await FailuresAsync(check, key);
        LookupStates(check);
        await LookupAsync(check, key);
    }

    sealed class Harness : IDisposable
    {
        public BigQueryFake Fake { get; }
        public SqlService Service { get; }
        public string ConnectionId { get; private set; } = "";

        public Harness()
        {
            Fake = BigQueryFake.Google()
                .On("GET", Alpha + "/datasets/[^/]+/(tables|routines|models)", BigQueryFake.Fixture("index-empty"))
                .On("GET", Sales + "/tables", BigQueryFake.Fixture("index-tables"))
                .On("GET", Sales + "/routines", BigQueryFake.Fixture("index-routines"))
                .On("GET", Sales + "/models", BigQueryFake.Fixture("index-models"))
                .On("GET", Sales + "/tables/[^/]+", BigQueryFake.Fixture("table-orders"))
                .On("GET", Sales + "/tables/daily", BigQueryFake.Fixture("index-view-daily"))
                .On("GET", Sales + "/tables/orders_copy", BigQueryFake.Fixture("index-table-copy"))
                .On("GET", Sales + "/tables/events_20260103", BigQueryFake.Fixture("index-table-events"))
                .On("GET", Sales + "/routines/[^/]+", BigQueryFake.Fixture("routine-procedure"))
                .On("GET", Sales + "/routines/to_cents", BigQueryFake.Fixture("index-routine-to-cents"))
                .On("GET", Sales + "/routines/top_customers", new BigQueryFake.Reply(200, "{\"routineReference\":{\"projectId\":\"varia-alpha\",\"datasetId\":\"sales\",\"routineId\":\"top_customers\"},\"routineType\":\"TABLE_VALUED_FUNCTION\",\"creationTime\":\"1700000000000\",\"lastModifiedTime\":\"1700000600000\",\"definitionBody\":\"SELECT 1 AS n\"}"))
                .On("GET", Beta + "/datasets", BigQueryFake.Fixture("index-beta-datasets"))
                .On("GET", Beta + "/datasets/[^/]+/(routines|models)", BigQueryFake.Fixture("index-empty"))
                .On("GET", Beta + "/datasets/census/tables", BigQueryFake.Fixture("index-beta-tables"))
                .On("GET", Beta + "/datasets/census/tables/[^/]+", BigQueryFake.Fixture("table-orders"));
            Service = new SqlService(CheckStores.Unprobed(), bigQuery: new BigQueryEnvironment(null, Fake.Factory, new SubjectTokens([])));
            Service.BigQuery.RetryDelay = TimeSpan.FromMilliseconds(1);
        }

        public async Task ConnectAsync(JsonObject key)
        {
            var options = new JsonObject
            {
                ["provider"] = "bigquery", ["project"] = "varia-alpha", ["authentication"] = "serviceAccountKey", ["dataset"] = "sales", ["location"] = "US",
                ["extraProjects"] = new JsonArray("varia-beta", "varia-alpha"),
                ["credential"] = new JsonObject { ["source"] = "file", ["json"] = key.ToJsonString() }, ["keyFile"] = Guid.NewGuid().ToString()
            };
            var (code, result, message) = await Call("connections.connect", options);
            if (code != "ok") throw new InvalidOperationException("connect: " + code + " " + message);
            ConnectionId = ((ConnectionInfo)result!).Id;
        }

        public async Task<(string Code, object? Result, string Message)> Call(string method, JsonNode parameters)
        {
            using var document = JsonDocument.Parse(parameters.ToJsonString());
            try { return ("ok", await Service.DispatchAsync(method, document.RootElement.Clone(), Wire), ""); }
            catch (RequestException error) { return (error.Code, null, error.Message); }
        }

        public async Task<ObjectIndexResult> Index(Action<JsonObject>? more = null)
        {
            var args = new JsonObject { ["connectionId"] = ConnectionId, ["requestId"] = Guid.NewGuid().ToString() };
            more?.Invoke(args);
            var (code, result, message) = await Call("explorer.index", args);
            return code == "ok" ? (ObjectIndexResult)result! : throw new InvalidOperationException("index: " + code + " " + message);
        }

        public async Task<ObjectSearchResult> Search(string text, Action<JsonObject>? more = null)
        {
            var args = new JsonObject { ["connectionId"] = ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["text"] = text };
            more?.Invoke(args);
            var (code, result, message) = await Call("explorer.search", args);
            return code == "ok" ? (ObjectSearchResult)result! : throw new InvalidOperationException("search: " + code + " " + message);
        }

        public int Gets(string pattern) => Fake.To(pattern).Count(request => request.Method == "GET");

        public void Dispose() => Service.Dispose();
    }

    static string Names(ObjectSearchResult result) => string.Join(", ", result.Hits.Select(hit => hit.Label + (hit.Subtype is { } subtype ? "/" + subtype : "")));

    /// <summary>Listings become entries: shards grouped by a real yyyyMMdd suffix only, refused names dropped, kinds and folders as Explorer lists them.</summary>
    static void Entries(Action<bool, string> check)
    {
        var tables = Google.Apis.Json.NewtonsoftJsonSerializer.Instance.Deserialize<Google.Apis.Bigquery.v2.Data.TableList>(BigQueryFake.FixtureText("index-tables"));
        var routines = Google.Apis.Json.NewtonsoftJsonSerializer.Instance.Deserialize<Google.Apis.Bigquery.v2.Data.ListRoutinesResponse>(BigQueryFake.FixtureText("index-routines"));
        var listing = new BigQueryListing([.. tables.Tables], [.. routines.Routines], [], false);
        var entries = BigQueryEntries.FromListing(listing);
        var events = entries.Where(entry => entry.Name.StartsWith("events_", StringComparison.Ordinal)).ToList();
        check(events.Count == 2 && events[0] is { Name: "events_20260103", Shards: { Prefix: "events_", Count: 3, First: "20260101", Last: "20260103" } } && events[1].Shards is null,
            "date-sharded tables become one entry, their newest shard, with the group's prefix, count and range; events_summary stays apart: " + string.Join(", ", events.Select(entry => entry.Name)));
        check(entries.Count(entry => entry.Name.StartsWith("audit_", StringComparison.Ordinal)) == 2 && !entries.Any(entry => entry.Name.Contains('`')),
            "a suffix that is not a real date is not a shard, and a name BigQuery's rule refuses is left out");
        check(entries.Single(entry => entry.Name == "orders_2024") is { Kind: "bqTable", Subtype: "snapshot", Folder: "bqTables" }
            && entries.Single(entry => entry.Name == "totals") is { Kind: "bqMaterializedView", Folder: "bqMaterializedViews" }
            && entries.Single(entry => entry.Name == "top_customers") is { Kind: "bqRoutine", Subtype: "tableValued", Modified: 1700000600000 },
            "kinds, subtypes, folders and routines' last change come from the listings");
        var field = new Google.Apis.Bigquery.v2.Data.TableFieldSchema { Name = "n", Type = "NUMERIC", Precision = 10, Scale = 2, Mode = "REPEATED" };
        check(BigQueryEntries.TypeText(field) == "ARRAY<NUMERIC(10, 2)>" && BigQueryEntries.TypeText(new Google.Apis.Bigquery.v2.Data.TableFieldSchema { Type = "RECORD" }) == "STRUCT",
            "a column's type text carries precision and scale, ARRAY for REPEATED and STRUCT for RECORD: " + BigQueryEntries.TypeText(field));
    }

    /// <summary>DDL marks its target's dataset; DDL inside a script marks the tab's dataset; queries mark nothing.</summary>
    static void Ddl(Action<bool, string> check)
    {
        var job = new Google.Apis.Bigquery.v2.Data.Job
        {
            Statistics = new() { Query = new() { DdlTargetTable = new() { ProjectId = "varia-alpha", DatasetId = "staging", TableId = "t" } } }
        };
        var none = new Google.Apis.Bigquery.v2.Data.Job();
        var marked = SqlService.DdlDatasets(job, "CREATE_TABLE", null, "varia-alpha", "sales").ToList();
        var script = SqlService.DdlDatasets(none, "SCRIPT", [new BigQueryChild("c", null, 0, true, "DROP_VIEW", null, null, "DROP")], "varia-alpha", "sales").ToList();
        var select = SqlService.DdlDatasets(job, "SELECT", [new BigQueryChild("c", null, 0, true, "INSERT", null, null, null)], "varia-alpha", "sales").ToList();
        check(marked is [("varia-alpha", "staging")] && script is [("varia-alpha", "sales")] && select.Count == 0,
            "DDL marks its target's dataset, a script's DDL the tab's dataset, and DML or SELECT nothing");
        var restored = new Google.Apis.Bigquery.v2.Data.Job { Statistics = new() { Query = new() { DdlTargetDataset = new() { ProjectId = "varia-alpha", DatasetId = "archive" } } } };
        check(SqlService.DdlDatasets(restored, "UNDROP_SCHEMA", null, "varia-alpha", null).ToList() is [("varia-alpha", "archive")], "UNDROP SCHEMA marks the dataset it restored");
        check(SqlService.DdlDatasets(none, "SCRIPT", null, "varia-alpha", "sales").ToList() is [("varia-alpha", "sales")] && SqlService.DdlDatasets(none, "SELECT", null, "varia-alpha", "sales").ToList().Count == 0,
            "a script whose child jobs could not be listed marks the tab's dataset; a SELECT still marks nothing");
    }

    /// <summary>A dataset that does not fit with its columns is read again without them, and one that still does not fit is refused, giving back what it took.</summary>
    static void Budget(Action<bool, string> check)
    {
        var detail = new BigQueryDetail(null, null, null, [.. Enumerable.Range(0, 400).Select(at => new BigQueryColumn("c" + at, false, "STRING", true, null))]);
        List<BigQueryEntry> entries = [new("bqTable", "bqTables", null, "wide", 1, null, Detail: detail)];
        var limits = new ObjectIndexLimits { MemoryBytes = 40_000, NamesReserveBytes = 0 };
        var pool = new StringPool(new IndexBudget(limits.MemoryBytes));
        var whole = new BigQueryReader(limits, pool, null).Read("p", "d", entries, true, true);
        var used = pool.Budget.Used;
        var names = new BigQueryReader(limits, pool, null).Read("p", "d", entries, false, true);
        check(whole is null && used == 0 && names is { ChildrenLeftOut: true, Table.Count: 2 } && pool.Budget.Used == names.Bytes + pool.Stats.Bytes,
            $"a read past the budget gives back what it took ({used}) and fits without columns: {names?.Table.Count} entries, {pool.Budget.Used} bytes");
    }

    /// <summary>What a later build reuses: nothing from a read without columns or (when text is wanted) without definitions, nor an
    /// object whose text the reserve left out; a reused cut definition stays cut. Too many distinct types is a read too large, not a fault.</summary>
    static void Reuse(Action<bool, string> check)
    {
        var limits = new ObjectIndexLimits { DefinitionChars = 10 };
        var pool = new StringPool(new IndexBudget(limits.MemoryBytes));
        var view = new BigQueryDetail(null, null, "SELECT 1 AS a, 2 AS b FROM t", [new BigQueryColumn("a", false, "INT64", true, null)]);
        List<BigQueryEntry> entries = [new("bqView", "bqViews", null, "v", 1, null, Detail: view)];
        var read = new BigQueryReader(limits, pool, null).Read("p", "d", entries, true, true)!;
        var known = BigQueryEntries.Known(read, true);
        var again = new BigQueryReader(limits, pool, null).Read("p", "d", [entries[0] with { Detail = known[("bqView", "v")].Detail }], true, true)!;
        check(read.Cut == 1 && known[("bqView", "v")].Detail is { DefinitionCut: true, Columns.Count: 1 } && again.Cut == 1 && again.Table.DefinitionCut(1),
            $"a definition cut at the limit is still cut when an unchanged view is reused ({read.Cut}, {again.Cut})");
        // A held read lets go of the read it took its share from, so reads replaced build after build are freed.
        var held = new ConnectionIndex(pool.Budget, pool: pool);
        held.Put(read);
        var next = new BigQueryReader(limits, pool, read).Read("p", "d", entries, true, true)!;
        var creditedFrom = next.CreditFrom is not null;
        held.Put(next);
        check(creditedFrom && next.CreditFrom is null && held.Get("pd") == next, "a held read keeps no reference to the read it replaced");
        var names = new BigQueryReader(limits, pool, null).Read("p", "d", entries, false, true)!;
        var bare = new BigQueryReader(limits, pool, null).Read("p", "d", entries, true, false)!;
        check(BigQueryEntries.Known(names, true).Count == 0 && BigQueryEntries.Known(bare, true).Count == 0 && BigQueryEntries.Known(bare, false).Count == 1,
            "a read that left columns out is never reused, nor one without definitions by a build that wants them");
        var reserved = new ObjectIndexLimits { NamesReserveBytes = long.MaxValue / 4 };
        var tight = new BigQueryReader(reserved, new StringPool(new IndexBudget(reserved.MemoryBytes)), null).Read("p", "d", entries, true, true)!;
        check(tight.Cut == 1 && BigQueryEntries.Known(tight, true).Count == 0, "a view whose text the names' reserve left out is read again by the next build");
        var columns = Enumerable.Range(0, BigQueryReader.MaxTypes + 1).Select(at => new BigQueryColumn("c" + at, false, "STRING(" + at + ")", true, null)).ToList();
        List<BigQueryEntry> wide = [new("bqTable", "bqTables", null, "wide", 1, null, Detail: new BigQueryDetail(null, null, null, columns))];
        var budget = new StringPool(new IndexBudget(limits.MemoryBytes));
        var whole = new BigQueryReader(limits, budget, null).Read("p", "d", wide, true, true);
        var used = budget.Budget.Used;
        var kept = new BigQueryReader(limits, budget, null).Read("p", "d", wide, false, true);
        check(whole is null && used == 0 && kept is { ChildrenLeftOut: true }, $"more distinct column types than a read numbers is too large for columns, giving back what it took ({used})");
    }

    static async Task BuildAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        var none = await harness.Search("orders");
        check(none.Index is { State: "none", Provider: "bigquery" } && none.Hits.Count == 0, "a BigQuery connection without an index searches nothing and says so");
        var progress = new List<string>();
        var built = await harness.Service.Search.IndexBigQueryAsync(new ObjectIndexArgs(harness.ConnectionId, Guid.NewGuid().ToString()), harness.Service.BigQuery, CancellationToken.None,
            value => { lock (progress) progress.Add(JsonSerializer.Serialize(value, Wire)); });
        var status = built.Status;
        check(status is { State: "ready", Provider: "bigquery", Databases: 4, Indexed: 4, Phase: null } && status.NamesOnly is ["varia-beta"] && status.Skipped.Count == 0,
            $"the build lists both projects' datasets (staging, sales, archive and the extra project's census) and names the extra project as names only: {status.Databases}/{status.Indexed} {string.Join(",", status.Skipped.Select(skip => skip.Code))}");
        check(progress.Any(item => item.Contains("\"phase\":\"names\"", StringComparison.Ordinal)) && progress.Any(item => item.Contains("\"phase\":\"details\"", StringComparison.Ordinal)),
            "progress events name the pass: " + string.Join(" ", progress.Take(3)));
        check(harness.Gets(Beta + "/datasets/census/tables/.+") == 0 && harness.Gets(Sales + "/tables/orders") == 1 && harness.Gets(Sales + "/tables/events_2026010[12]") == 0
            && harness.Gets(Sales + "/tables/events_20260103") == 1 && harness.Gets(Sales + "/models/.+") == 0,
            "pass 2 reads each billing-project table once (a shard group's newest shard only, no model), and the extra project not at all");
        var detailReads = harness.Fake.Seen.Where(request => request.Method == "GET" && System.Text.RegularExpressions.Regex.IsMatch(request.Url, "/tables/[^/]+$")).ToList();
        check(detailReads.Count > 0 && detailReads.All(request => System.Web.HttpUtility.ParseQueryString(request.Uri.Query) is var query && query["selectedFields"] is null
                && query["fields"] == Varia.Backend.BigQuery.BigQueryService.IndexTableFields),
            "pass 2 trims tables.get with a partial response (fields), never selectedFields, which would keep only columns of those names");
        var orders = await harness.Search("orders");
        var table = orders.Hits.FirstOrDefault(hit => hit.Label == "sales.orders");
        check(table is { Folder: "bqTables", Object: { Kind: "bqTable", Project: "varia-alpha", Dataset: "sales", Name: "orders", Database: null, Schema: null } }
            && orders.Hits.Any(hit => hit.Label == "sales.orders_copy" && hit.Subtype == "clone") && orders.Hits.Any(hit => hit.Label == "sales.orders_2024" && hit.Subtype == "snapshot")
            && orders.Hits.Any(hit => hit.Object.Kind == "bqModel" && hit.Folder == "bqModels"),
            "hits carry BigQuery refs (project › dataset › name), a clone found by tables.get and a snapshot by tables.list: " + Names(orders));
        var city = await harness.Search("city");
        check(city.Hits.FirstOrDefault(hit => hit.Object.Table == "orders") is { Label: "sales.orders.address.city", Type: "STRING", Folder: "bqColumns", ParentFolder: "bqTables", Object: { Kind: "bqColumn", Table: "orders", Dataset: "sales", Name: "address.city" } },
            "column search covers nested field paths, with the column's type and its table: " + Names(city));
        var items = await harness.Search("items.sku");
        check(items.Hits.Any(hit => hit.Object.Name == "items.sku") && (await harness.Search("items")).Hits.Any(hit => hit.Type == "ARRAY<STRUCT>"),
            "a dotted search finds a nested path, and a repeated STRUCT's type is ARRAY<STRUCT>");
        var events = await harness.Search("events");
        check(events.Hits.FirstOrDefault(hit => hit.Shards is not null) is { Label: "sales.events_20260103", Shards: { Count: 3, Prefix: "events_" } } && events.Hits.All(hit => hit.Object.Name != "events_20260101"),
            "a shard group is one hit carrying its range: " + Names(events));
        var view = await harness.Search("varia-alpha.sales.orders", more => more["in"] = "definitions");
        var body = await harness.Search("ROUND", more => more["in"] = "definitions");
        check(view.Hits.Any(hit => hit.Object.Name == "daily" && hit.Definition is { Line: 2 }) && body.Hits.SingleOrDefault() is { Object.Name: "to_cents", Object.Kind: "bqRoutine" },
            "definition search covers view text and routine bodies: " + Names(view) + " | " + Names(body));
        var qualified = await harness.Search("varia-alpha.sales.daily");
        var dataset = await harness.Search("sales", more => more["kinds"] = new JsonArray("bqDataset"));
        check(qualified.Hits.Any(hit => hit.Object.Name == "daily") && dataset.Hits.SingleOrDefault() is { Folder: "", Object: { Kind: "bqDataset", Project: "varia-alpha", Name: "sales" } },
            "name search covers the project and dataset in a dotted name, and datasets themselves: " + Names(dataset));
        static JsonArray Kinds(params string[] kinds) => new([.. kinds.Select(kind => (JsonNode)kind)]);
        var plain = await harness.Search("orders", more => more["kinds"] = Kinds("bqTable"));
        var snapshots = await harness.Search("orders", more => more["kinds"] = Kinds("bqTable:snapshot"));
        var procedures = await harness.Search("t", more => more["kinds"] = Kinds("bqRoutine:procedure"));
        var routines = await harness.Search("t", more => more["kinds"] = Kinds("bqRoutine"));
        check(Names(plain) == "sales.orders" && Names(snapshots) == "sales.orders_2024/snapshot" && Names(procedures) == "sales.refresh_totals/procedure" && Names(routines) == "sales.to_cents/scalar",
            $"a plain kind keeps objects without a split subtype and each variant only its own: {Names(plain)} | {Names(snapshots)} | {Names(procedures)} | {Names(routines)}");
        var census = await harness.Search("population");
        var narrowed = await harness.Search("orders", more => { more["project"] = "varia-alpha"; more["dataset"] = "staging"; });
        var project = await harness.Search("population", more => more["project"] = "varia-alpha");
        check(census.Hits.SingleOrDefault() is { Object: { Project: "varia-beta", Dataset: "census" } } && narrowed.Hits.Count == 0 && project.Hits.Count == 0
            && (await harness.Search("population", more => more["kinds"] = Kinds("bqColumn"))).Hits.Count == 0,
            "the extra project's names are searchable without columns, and a search narrows to a project or dataset");
        var (code, _, _) = await harness.Call("explorer.search", new JsonObject { ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["text"] = "x", ["database"] = "sales" });
        var (badKind, _, _) = await harness.Call("explorer.search", new JsonObject { ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["text"] = "x", ["kinds"] = Kinds("bqTable:view") });
        var (badScope, _, _) = await harness.Call("explorer.index", new JsonObject { ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["scope"] = new JsonObject { ["project"] = "elsewhere" } });
        check(code == "INVALID_PARAMS" && badKind == "INVALID_PARAMS" && badScope == "INVALID_PARAMS",
            "a BigQuery search refuses database, an unknown kind variant is refused, and a refresh scope must be one of the connection's projects");
        var extra = await harness.Index(more => more["extraDetails"] = true);
        check(extra.Status.NamesOnly is null && harness.Gets(Beta + "/datasets/census/tables/population") == 1 && (await harness.Search("population.address.city")).Hits.Count == 1,
            "extraDetails reads the extra projects' schemas too");
        var refreshed = await harness.Index(more => more["scope"] = new JsonObject { ["project"] = "varia-alpha", ["dataset"] = "sales" });
        var bare = await harness.Index(more => { more["stale"] = true; more["definitions"] = false; });
        check(refreshed.Status.NamesOnly is null && bare.Status.NamesOnly is null && bare.Status.Definitions,
            "a refresh leaves what the index as a whole holds as the last full build said: extra projects' details, definitions");
        var used = harness.Service.Search.MemoryUsed;
        await harness.Call("connections.disconnect", new JsonObject { ["connectionId"] = harness.ConnectionId });
        check(used > 0 && harness.Service.Search.MemoryUsed == 0 && harness.Service.Search.IndexOf(harness.ConnectionId) is null,
            $"a disconnect drops the BigQuery index and gives back its memory ({used} bytes)");
        check(harness.Fake.Unmatched.IsEmpty && !harness.Fake.Seen.Any(request => request.Url.EndsWith("/jobs", StringComparison.Ordinal) && request.Method == "POST" && !request.Body.Contains("dryRun", StringComparison.Ordinal)),
            "the index runs no job and every request it made had a route: " + string.Join(", ", harness.Fake.Unmatched.Select(request => request.Url)));
    }

    static async Task RefreshAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        await harness.Index();
        var first = harness.Gets(Sales + "/tables/.+") + harness.Gets(Sales + "/routines/.+");
        await harness.Index();
        var again = harness.Gets(Sales + "/tables/.+") + harness.Gets(Sales + "/routines/.+");
        check(first > 0 && again == first && (await harness.Search("city")).Hits.Count > 0,
            $"a rebuild re-lists but re-reads no object whose creation time and last change are the same, and keeps their columns ({first} then {again})");
        // orders recreated (a new creation time): only it is read again.
        var recreated = BigQueryFake.FixtureText("index-tables").Replace("\"tableId\":\"orders\"},\"type\":\"TABLE\",\"creationTime\":\"1700000000000\"", "\"tableId\":\"orders\"},\"type\":\"TABLE\",\"creationTime\":\"1800000000000\"", StringComparison.Ordinal);
        harness.Fake.On("GET", Sales + "/tables", new BigQueryFake.Reply(200, recreated));
        var before = harness.Gets(Sales + "/tables/orders");
        var others = harness.Gets(Sales + "/tables/daily");
        await harness.Index();
        check(harness.Gets(Sales + "/tables/orders") == before + 1 && harness.Gets(Sales + "/tables/daily") == others, "a recreated table alone is read again");
        // Object Explorer's Refresh on the dataset re-reads every object in it; another dataset is not listed.
        var daily = harness.Gets(Sales + "/tables/daily");
        var staging = harness.Gets(Alpha + "/datasets/staging/tables");
        var scoped = await harness.Index(more => more["scope"] = new JsonObject { ["project"] = "varia-alpha", ["dataset"] = "sales" });
        check(harness.Gets(Sales + "/tables/daily") == daily + 1 && harness.Gets(Alpha + "/datasets/staging/tables") == staging && scoped.Status.Databases == 4,
            "a dataset refresh re-reads its objects whole, leaves other datasets alone, and the status still counts every dataset: " + scoped.Status.Databases);
        // DDL marks sales stale: a stale-only build reads it alone, and the mark is spent.
        harness.Service.Search.MarkStale(harness.ConnectionId, "varia-alpha", "sales");
        var marked = harness.Service.Search.StaleOf(harness.ConnectionId).Count;
        daily = harness.Gets(Sales + "/tables/daily");
        var datasets = harness.Gets(Alpha + "/datasets");
        await harness.Index(more => more["stale"] = true);
        check(marked == 1 && harness.Gets(Sales + "/tables/daily") == daily + 1 && harness.Gets(Alpha + "/datasets") == datasets && harness.Service.Search.StaleOf(harness.ConnectionId).Count == 0,
            "a stale-only build re-reads the dataset DDL marked, lists nothing else, and spends the mark");
        // DDL that lands while a build reads the dataset keeps its mark: the build read the listing from before it.
        harness.Fake.On("GET", Sales + "/tables", _ =>
        {
            harness.Service.Search.MarkStale(harness.ConnectionId, "varia-alpha", "sales");
            return new BigQueryFake.Reply(200, recreated);
        });
        await harness.Index();
        check(harness.Service.Search.StaleOf(harness.ConnectionId).Contains(("varia-alpha", "sales")), "a dataset marked stale while a build read it stays marked for the next stale-only build");
        // DDL that lands after a build began but before it reached the dataset: the build reads the dataset whole and spends the mark.
        harness.Fake.On("GET", Sales + "/tables", new BigQueryFake.Reply(200, recreated));
        await harness.Index(more => more["stale"] = true);
        BigQueryFake.Reply Datasets(BigQueryFake.Request request) => BigQueryFake.Fixture(request.Uri.Query.Contains("pageToken=page-2", StringComparison.Ordinal) ? "datasets-page-2" : "datasets");
        harness.Fake.On("GET", Alpha + "/datasets", request =>
        {
            harness.Service.Search.MarkStale(harness.ConnectionId, "varia-alpha", "sales");
            return Datasets(request);
        });
        daily = harness.Gets(Sales + "/tables/daily");
        await harness.Index();
        check(harness.Gets(Sales + "/tables/daily") == daily + 1 && !harness.Service.Search.StaleOf(harness.ConnectionId).Contains(("varia-alpha", "sales")),
            "a dataset marked after a build began is read whole when the build reaches it, so the cleared mark loses no change");
        harness.Fake.On("GET", Alpha + "/datasets", Datasets);
        // A stale-only build replaces its target's old skip: failing again lists it once, succeeding lists it no more.
        harness.Service.Search.MarkStale(harness.ConnectionId, "varia-alpha", "sales");
        harness.Fake.On("GET", Sales + "/tables", BigQueryFake.Fixture("error-access-denied", 403));
        await harness.Index(more => more["stale"] = true);
        var failedTwice = await harness.Index(more => more["stale"] = true);
        harness.Fake.On("GET", Sales + "/tables", new BigQueryFake.Reply(200, recreated));
        var recovered = await harness.Index(more => more["stale"] = true);
        check(failedTwice.Status.Skipped.Count(skip => skip.Database == "sales") == 1 && !recovered.Status.Skipped.Any(skip => skip.Database == "sales"),
            "a stale-only build's skip of a dataset replaces the earlier one, and goes once the dataset is read: "
            + string.Join(" | ", failedTwice.Status.Skipped.Select(skip => skip.Database + " " + skip.Code)));
        // A dataset gone from the listing leaves the index.
        harness.Fake.On("GET", Alpha + "/datasets", new BigQueryFake.Reply(200, "{\"datasets\":[{\"datasetReference\":{\"projectId\":\"varia-alpha\",\"datasetId\":\"staging\"}}]}"));
        await harness.Index();
        check((await harness.Search("orders")).Hits.Count == 0 && (await harness.Search("population")).Hits.Count == 1,
            "a dataset its project no longer lists is dropped, the extra project's kept");
    }

    static async Task FailuresAsync(Action<bool, string> check, JsonObject key)
    {
        // A build without definitions, then one with them: unchanged views are read again for their text.
        using (var texts = new Harness())
        {
            await texts.ConnectAsync(key);
            await texts.Index(more => more["definitions"] = false);
            var before = texts.Gets(Sales + "/tables/daily");
            await texts.Index();
            var found = await texts.Search("GROUP BY day", more => more["in"] = "definitions");
            check(texts.Gets(Sales + "/tables/daily") == before + 1 && found.Hits.Any(hit => hit.Object.Name == "daily"),
                "turning definitions on reads unchanged views again, so their text is searchable");
        }
        using var harness = new Harness();
        harness.Fake.On("GET", Alpha + "/datasets/archive/tables", BigQueryFake.Fixture("error-access-denied", 403));
        harness.Fake.On("GET", Sales + "/tables/totals", BigQueryFake.Fixture("error-access-denied", 403));
        harness.Fake.On("GET", Beta + "/datasets", BigQueryFake.Fixture("error-access-denied", 403));
        await harness.ConnectAsync(key);
        var result = await harness.Index();
        var skips = result.Status.Skipped;
        check(skips.Any(skip => skip is { Project: "varia-alpha", Database: "archive", Code: "PERMISSION_DENIED" })
            && skips.Any(skip => skip is { Project: "varia-beta", Database: "", Code: "PERMISSION_DENIED" })
            && skips.Any(skip => skip is { Project: "varia-alpha", Database: "sales", Code: "PERMISSION_DENIED", Details: true } && skip.Message.StartsWith("The details of 1 object", StringComparison.Ordinal))
            && skips.Where(skip => skip.Database != "sales").All(skip => skip.Details is null),
            "a refused dataset, a refused project listing and a refused object's details are skips naming their project: " + string.Join(" | ", skips.Select(skip => skip.Project + "/" + skip.Database + " " + skip.Code + " " + skip.Message)));
        check((await harness.Search("totals")).Hits.Any(hit => hit.Object.Name == "totals") && (await harness.Search("city")).Hits.Count > 0 && result.Status.State == "ready",
            "the rest is indexed: an object whose details failed keeps its name");
        check(!skips.Any(skip => skip.Message.Contains("orders", StringComparison.Ordinal) || skip.Message.Contains("totals", StringComparison.Ordinal)),
            "skip messages name no object");
    }
}
