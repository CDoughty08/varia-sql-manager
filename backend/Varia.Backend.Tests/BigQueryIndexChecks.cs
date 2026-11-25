using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Varia.Backend.BigQuery;
using Varia.Backend.Protocol;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>
/// The Search Objects index for BigQuery offline (docs/object-search.md, BigQuery): cross-project discovery, three-wave
/// prioritized build, noise filtering, 500-project cap, budget early-stop, date-sharded groups, kinds and their subtype
/// variants, column types and nested paths, definitions, project and dataset narrowing, refresh reuse, scoped and stale
/// refreshes, failures as skips, the memory budget, and the disconnect. Every request goes to <see cref="BigQueryFake"/>;
/// none leaves the process, and no check runs a job.
/// </summary>
internal static partial class BigQueryIndexChecks
{
    static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    const string Alpha = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha";
    const string Beta = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-beta";
    const string PublicData = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/bigquery-public-data";
    const string ScopedBeta = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/example\.com:varia-beta";
    const string Sales = Alpha + "/datasets/sales";

    public static async Task RunAsync(Action<bool, string> check)
    {
        Entries(check);
        Ddl(check);
        Budget(check);
        Reuse(check);
        BulkSql(check);
        BulkTypes(check);
        using var rsa = System.Security.Cryptography.RSA.Create(2048);
        var key = BigQueryCredentialChecks.Key(rsa.ExportPkcs8PrivateKeyPem());
        await BuildAsync(check, key);
        await RefreshAsync(check, key);
        await FailuresAsync(check, key);
        await DiscoveryAndNoiseAsync(check, key);
        await WavesAndBudgetAsync(check, key);
        await BulkAsync(check, key);
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
                .On("GET", Beta + "/datasets/census/tables/[^/]+", BigQueryFake.Fixture("table-orders"))
                .On("GET", PublicData + "/datasets", new BigQueryFake.Reply(200, "{\"datasets\":[{\"datasetReference\":{\"projectId\":\"bigquery-public-data\",\"datasetId\":\"samples\"},\"location\":\"US\"}]}"))
                .On("GET", PublicData + "/datasets/samples/(routines|models)", BigQueryFake.Fixture("index-empty"))
                .On("GET", PublicData + "/datasets/samples/tables", new BigQueryFake.Reply(200, "{\"tables\":[{\"tableReference\":{\"projectId\":\"bigquery-public-data\",\"datasetId\":\"samples\",\"tableId\":\"shakespeare\"},\"type\":\"TABLE\",\"creationTime\":\"1700000000000\"}]}"))
                .On("GET", PublicData + "/datasets/samples/tables/shakespeare", BigQueryFake.Fixture("table-orders"))
                .On("GET", ScopedBeta + "/datasets", new BigQueryFake.Reply(200, "{\"datasets\":[]}"));
            Service = new SqlService(CheckStores.Unprobed(), bigQuery: new BigQueryEnvironment(null, Fake.Factory, new SubjectTokens([])));
            Service.BigQuery.RetryDelay = TimeSpan.FromMilliseconds(1);
        }

        public async Task ConnectAsync(JsonObject key)
        {
            var options = new JsonObject
            {
                ["provider"] = "bigquery", ["project"] = "varia-alpha", ["authentication"] = "serviceAccountKey", ["dataset"] = "sales", ["location"] = "US",
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

    /// <summary>DDL marks its target's dataset (a temp table's anonymous dataset nothing); a script's DDL marks each statement's own target;
    /// what cannot be known marks the project whole; queries mark nothing.</summary>
    static void Ddl(Action<bool, string> check)
    {
        static Google.Apis.Bigquery.v2.Data.Job Table(string dataset) => new()
        {
            Statistics = new() { Query = new() { DdlTargetTable = new() { ProjectId = "varia-alpha", DatasetId = dataset, TableId = "t" } } }
        };
        static string Text(BigQueryIndexMarks marks) => string.Join(",", marks.Datasets.Select(item => item.Project + "." + item.Dataset).Order()) + (marks.WholeProject ? " +project" : "");
        var job = Table("staging");
        var none = new Google.Apis.Bigquery.v2.Data.Job();
        var marked = SqlService.DdlMarks(job, "CREATE_TABLE", null, false, "varia-alpha", "sales", true);
        var select = SqlService.DdlMarks(job, "SELECT", null, false, "varia-alpha", "sales", true);
        check(Text(marked) == "varia-alpha.staging" && select == BigQueryIndexMarks.None, "DDL marks its target's dataset, and SELECT nothing: " + Text(marked));
        var restored = new Google.Apis.Bigquery.v2.Data.Job { Statistics = new() { Query = new() { DdlTargetDataset = new() { ProjectId = "varia-alpha", DatasetId = "archive" } } } };
        check(Text(SqlService.DdlMarks(restored, "UNDROP_SCHEMA", null, false, "varia-alpha", null, true)) == "varia-alpha.archive", "UNDROP SCHEMA marks the dataset it restored");
        // A temp table lives in the session's anonymous dataset, which no index lists: it marks nothing, and no fallback.
        check(SqlService.DdlMarks(Table("_8f2c0d1e"), "CREATE_TABLE", null, false, "varia-alpha", "sales", true) == BigQueryIndexMarks.None,
            "a temp table's DDL (its target in an anonymous _ dataset) marks nothing");
        // LOAD DATA counts: its target table's dataset, or its destination table's.
        var load = new Google.Apis.Bigquery.v2.Data.Job { Configuration = new() { Query = new() { DestinationTable = new() { ProjectId = "varia-alpha", DatasetId = "landing", TableId = "raw" } } } };
        check(!SqlService.ChangesObjects("CREATE_ROW_ACCESS_POLICY") && !SqlService.ChangesObjects("DROP_ALL_ROW_ACCESS_POLICIES") && !SqlService.ChangesObjects("CREATE_SEARCH_INDEX")
            && !SqlService.ChangesObjects("ALTER_PROJECT") && !SqlService.ChangesObjects("CREATE_RESERVATION") && SqlService.ChangesObjects("CREATE_TABLE_AS_SELECT") && SqlService.ChangesObjects("ALTER_TABLE"),
            "row access policies, search indexes, reservations and project options change nothing the index lists");
        check(Text(SqlService.DdlMarks(load, "LOAD_DATA", null, false, "varia-alpha", null, true)) == "varia-alpha.landing" && SqlService.ChangesObjects("LOAD_DATA"),
            "LOAD DATA marks its destination table's dataset");
        // DDL with no target: the default dataset (from the job's configuration when the request named none), else the project.
        var defaulted = new Google.Apis.Bigquery.v2.Data.Job { Configuration = new() { Query = new() { DefaultDataset = new() { ProjectId = "varia-alpha", DatasetId = "sales" } } } };
        check(Text(SqlService.DdlMarks(defaulted, "CREATE_FUNCTION", null, false, "varia-alpha", null, true)) == "varia-alpha.sales"
            && Text(SqlService.DdlMarks(none, "CREATE_FUNCTION", null, false, "varia-alpha", null, true)) == " +project",
            "DDL that names no target marks the default dataset, or the project when there is none");
        // A script: each DDL statement's entry in the child listing names its target, in any dataset, with or without a default dataset.
        List<BigQueryChild> children = [new("c1", null, 1, true, "DROP_VIEW", null, null, "DROP", "varia-alpha", "marketing"), new("c2", null, 2, true, "INSERT", null, 3, null),
            new("c3", null, 3, true, "CREATE_TABLE", null, null, "CREATE", "varia-alpha", "_session_temp")];
        check(Text(SqlService.DdlMarks(none, "SCRIPT", children, true, "varia-alpha", null, true)) == "varia-alpha.marketing",
            "a script's DDL marks each statement's own target (another dataset, no default dataset), and its temp table nothing: " + Text(SqlService.DdlMarks(none, "SCRIPT", children, true, "varia-alpha", null, true)));
        // A DDL statement that names no target (LOAD DATA: its destination is configuration) marks the default dataset, else the project.
        List<BigQueryChild> loads = [.. children, new("c4", null, 4, true, "LOAD_DATA", null, null, null)];
        check(Text(SqlService.DdlMarks(none, "SCRIPT", loads, true, "varia-alpha", "sales", true)) == "varia-alpha.marketing,varia-alpha.sales"
            && Text(SqlService.DdlMarks(none, "SCRIPT", loads, true, "varia-alpha", null, true)) == "varia-alpha.marketing +project",
            "a script statement that names no target marks the default dataset, or the project when there is none");
        // With deferred reads asked for, an untargeted statement waits for its job's own read instead.
        var deferred = new List<BigQueryChild>();
        check(Text(SqlService.DdlMarks(none, "SCRIPT", loads, true, "varia-alpha", null, true, deferred)) == "varia-alpha.marketing" && deferred.Select(child => child.Id).SequenceEqual(["c4"]),
            "a script statement that names no target is deferred to a jobs.get when asked, and marks nothing yet");
        // Unknown: a listing cut short marks the project whole; one that failed the default dataset, or the project with none.
        check(SqlService.DdlMarks(none, "SCRIPT", children, false, "varia-alpha", "sales", true).WholeProject
            && Text(SqlService.DdlMarks(none, "SCRIPT", null, false, "varia-alpha", "sales", true)) == "varia-alpha.sales"
            && SqlService.DdlMarks(none, "SCRIPT", null, false, "varia-alpha", null, true).WholeProject,
            "a capped child listing marks the project whole, and an unread listing the default dataset, or the project with none");
        // ...unless the script's text has no word of a statement that changes objects.
        check(SqlService.DdlMarks(none, "SCRIPT", null, false, "varia-alpha", "sales", false) == BigQueryIndexMarks.None
            && SqlService.DdlMarks(none, "SCRIPT", [new("c", null, 0, true, "INSERT", null, null, null)], true, "varia-alpha", "sales", true) == BigQueryIndexMarks.None,
            "an unread script whose text changes no object, and a script of DML only, mark nothing");
        check(!GoogleSqlScanner.MayChangeObjects("SELECT 'CREATE TABLE x' AS t -- DROP TABLE y\n/* ALTER */ FROM `create`")
            && GoogleSqlScanner.MayChangeObjects("DECLARE x INT64; create temp table t AS SELECT 1") && GoogleSqlScanner.MayChangeObjects("LOAD DATA INTO d.t FROM FILES(format = 'CSV', uris = ['gs://b/f.csv'])")
            && GoogleSqlScanner.MayChangeObjects("EXECUTE IMMEDIATE 'x'"),
            "the scanner finds DDL words only outside strings, comments and backtick identifiers");
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
        check(creditedFrom && next.CreditFrom is null && held.Get("p\u0001d") == next, "a held read keeps no reference to the read it replaced");
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
        check(none.Index is { State: "none", Provider: "bigquery", Projects: 0 } && none.Hits.Count == 0, "a BigQuery connection without an index searches nothing and says so");
        var progress = new List<string>();
        var built = await harness.Service.Search.IndexBigQueryAsync(
            new ObjectIndexArgs(harness.ConnectionId, Guid.NewGuid().ToString(), StarredProjects: ["varia-beta", "varia-alpha"]),
            harness.Service.BigQuery, CancellationToken.None,
            value => { lock (progress) progress.Add(JsonSerializer.Serialize(value, Wire)); });
        var status = built.Status;
        check(status is { State: "ready", Provider: "bigquery", Databases: 5, Indexed: 5, Phase: null, Projects: 3 } && status.NamesOnly is null && status.Skipped.Count == 0,
            $"the default build lists billing (3), starred (1) and discovered (1) datasets across 3 projects with full details: {status.Databases}/{status.Indexed} projects={status.Projects} {string.Join(",", status.Skipped.Select(skip => skip.Code))}");
        var progressValid = progress.All(item =>
        {
            using var doc = JsonDocument.Parse(item);
            return doc.RootElement.GetProperty("done").GetInt32() <= doc.RootElement.GetProperty("total").GetInt32();
        });
        check(progress.Any(item => item.Contains("\"phase\":\"projects\"", StringComparison.Ordinal))
            && progress.Any(item => item.Contains("\"phase\":\"names\"", StringComparison.Ordinal))
            && progress.Any(item => item.Contains("\"phase\":\"details\"", StringComparison.Ordinal))
            && progressValid,
            "progress events name projects, names and details phases and keep done <= total: " + string.Join(" ", progress.Take(4)));
        check(harness.Gets(Beta + "/datasets/census/tables/population") == 1 && harness.Gets(PublicData + "/datasets/samples/tables/shakespeare") == 1
            && harness.Gets(Sales + "/tables/orders") == 1 && harness.Gets(Sales + "/tables/events_2026010[12]") == 0
            && harness.Gets(Sales + "/tables/events_20260103") == 1 && harness.Gets(Sales + "/models/.+") == 0,
            "pass 2 reads billing, starred and discovered tables once (a shard group's newest shard only, no model)");
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
        var shakespeare = await harness.Search("shakespeare");
        var shakespeareCol = await harness.Search("shakespeare.address.city");
        var populationCol = await harness.Search("population.address.city");
        var narrowed = await harness.Search("orders", more => { more["project"] = "varia-alpha"; more["dataset"] = "staging"; });
        var project = await harness.Search("population", more => more["project"] = "varia-alpha");
        check(census.Hits.SingleOrDefault() is { Object: { Project: "varia-beta", Dataset: "census" } } && populationCol.Hits.Count == 1
            && shakespeare.Hits.SingleOrDefault() is { Object: { Project: "bigquery-public-data", Dataset: "samples" } } && shakespeareCol.Hits.Count == 1
            && narrowed.Hits.Count == 0 && project.Hits.Count == 0,
            "starred and discovered projects are indexed with full details and columns, and searches narrow to a project or dataset");
        // allProjects: false skips projects.list and prunes previously discovered projects.
        var projectCallsBefore = harness.Gets(BigQueryFake.Projects);
        var billingAndStarred = await harness.Index(more => { more["allProjects"] = false; more["starredProjects"] = new JsonArray("varia-beta"); });
        check(harness.Gets(BigQueryFake.Projects) == projectCallsBefore
            && billingAndStarred.Status is { Databases: 4, Indexed: 4, Projects: 2 }
            && (await harness.Search("shakespeare")).Hits.Count == 0
            && (await harness.Search("population")).Hits.Count == 1,
            "allProjects: false skips projects.list and prunes previously discovered projects while keeping billing and starred");
        // Scoped refresh works on ANY valid project (including a session-only project not in billing/starred/discovered).
        const string SessionProj = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/session-only-proj";
        harness.Fake
            .On("GET", SessionProj + "/datasets", new BigQueryFake.Reply(200, "{\"datasets\":[{\"datasetReference\":{\"projectId\":\"session-only-proj\",\"datasetId\":\"adhoc\"},\"location\":\"US\"}]}"))
            .On("GET", SessionProj + "/datasets/adhoc/(routines|models)", BigQueryFake.Fixture("index-empty"))
            .On("GET", SessionProj + "/datasets/adhoc/tables", new BigQueryFake.Reply(200, "{\"tables\":[{\"tableReference\":{\"projectId\":\"session-only-proj\",\"datasetId\":\"adhoc\",\"tableId\":\"scratch_tbl\"},\"type\":\"TABLE\",\"creationTime\":\"1700000000000\"}]}"))
            .On("GET", SessionProj + "/datasets/adhoc/tables/scratch_tbl", BigQueryFake.Fixture("table-orders"));
        var sessionScoped = await harness.Index(more => more["scope"] = new JsonObject { ["project"] = "session-only-proj" });
        check(sessionScoped.Status.Projects == 3 && (await harness.Search("scratch_tbl")).Hits.Count == 1 && (await harness.Search("scratch_tbl.address.city")).Hits.Count == 1,
            "a scoped refresh indexes any valid project (including session-revealed projects) with both pass 1 and pass 2 details");
        // Parameter validation for BigQuery and SQL Server refusal of BigQuery-only args.
        var (code, _, _) = await harness.Call("explorer.search", new JsonObject { ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["text"] = "x", ["database"] = "sales" });
        var (badKind, _, _) = await harness.Call("explorer.search", new JsonObject { ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["text"] = "x", ["kinds"] = Kinds("bqTable:view") });
        var (badScope, _, _) = await harness.Call("explorer.index", new JsonObject { ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["scope"] = new JsonObject { ["project"] = "Bad Project" } });
        var (badStarredName, _, _) = await harness.Call("explorer.index", new JsonObject { ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["starredProjects"] = new JsonArray("NOT A PROJECT") });
        var tooManyStarred = new JsonArray([.. Enumerable.Range(0, BigQueryIndexLimits.StarredProjects + 1).Select(index => (JsonNode)$"varia-star-{index:D4}")]);
        var (badStarredCount, _, _) = await harness.Call("explorer.index", new JsonObject { ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["starredProjects"] = tooManyStarred });
        check(code == "INVALID_PARAMS" && badKind == "INVALID_PARAMS" && badScope == "INVALID_PARAMS" && badStarredName == "INVALID_PARAMS" && badStarredCount == "INVALID_PARAMS",
            $"BigQuery search and index validate database, kind variants, scope project and starredProjects bounds: {code} {badKind} {badScope} {badStarredName} {badStarredCount}");
        var sqlId = Guid.NewGuid().ToString();
        var sqlRefused = new[]
        {
            (await harness.Call("explorer.index", new JsonObject { ["connectionId"] = sqlId, ["requestId"] = Guid.NewGuid().ToString(), ["starredProjects"] = new JsonArray("varia-beta") })).Code,
            (await harness.Call("explorer.index", new JsonObject { ["connectionId"] = sqlId, ["requestId"] = Guid.NewGuid().ToString(), ["allProjects"] = false })).Code,
            (await harness.Call("explorer.index", new JsonObject { ["connectionId"] = sqlId, ["requestId"] = Guid.NewGuid().ToString(), ["maxProjects"] = 10 })).Code,
            (await harness.Call("explorer.index", new JsonObject { ["connectionId"] = sqlId, ["requestId"] = Guid.NewGuid().ToString(), ["scope"] = new JsonObject { ["project"] = "varia-alpha" } })).Code,
            (await harness.Call("explorer.index", new JsonObject { ["connectionId"] = sqlId, ["requestId"] = Guid.NewGuid().ToString(), ["stale"] = true })).Code
        };
        check(sqlRefused.All(value => value == "INVALID_PARAMS"), "SQL Server refuses starredProjects, allProjects, maxProjects, scope and stale: " + string.Join(",", sqlRefused));
        var refreshed = await harness.Index(more => more["scope"] = new JsonObject { ["project"] = "varia-alpha", ["dataset"] = "sales" });
        var bare = await harness.Index(more => { more["stale"] = true; more["definitions"] = false; });
        check(refreshed.Status.NamesOnly is null && bare.Status.NamesOnly is null && bare.Status.Definitions,
            "a refresh leaves what the index as a whole holds as the last full build said: names-only, definitions");
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
        await harness.Index(more => more["starredProjects"] = new JsonArray("varia-beta"));
        var first = harness.Gets(Sales + "/tables/.+") + harness.Gets(Sales + "/routines/.+");
        await harness.Index(more => more["starredProjects"] = new JsonArray("varia-beta"));
        var again = harness.Gets(Sales + "/tables/.+") + harness.Gets(Sales + "/routines/.+");
        check(first > 0 && again == first && (await harness.Search("city")).Hits.Count > 0,
            $"a rebuild re-lists but re-reads no object whose creation time and last change are the same, and keeps their columns ({first} then {again})");
        // orders recreated (a new creation time): only it is read again.
        var recreated = BigQueryFake.FixtureText("index-tables").Replace("\"tableId\":\"orders\"},\"type\":\"TABLE\",\"creationTime\":\"1700000000000\"", "\"tableId\":\"orders\"},\"type\":\"TABLE\",\"creationTime\":\"1800000000000\"", StringComparison.Ordinal);
        harness.Fake.On("GET", Sales + "/tables", new BigQueryFake.Reply(200, recreated));
        var before = harness.Gets(Sales + "/tables/orders");
        var others = harness.Gets(Sales + "/tables/daily");
        await harness.Index(more => more["starredProjects"] = new JsonArray("varia-beta"));
        check(harness.Gets(Sales + "/tables/orders") == before + 1 && harness.Gets(Sales + "/tables/daily") == others, "a recreated table alone is read again");
        // Object Explorer's Refresh on the dataset re-reads every object in it; another dataset is not listed.
        var daily = harness.Gets(Sales + "/tables/daily");
        var staging = harness.Gets(Alpha + "/datasets/staging/tables");
        var scoped = await harness.Index(more => more["scope"] = new JsonObject { ["project"] = "varia-alpha", ["dataset"] = "sales" });
        check(harness.Gets(Sales + "/tables/daily") == daily + 1 && harness.Gets(Alpha + "/datasets/staging/tables") == staging && scoped.Status.Databases == 5,
            "a dataset refresh re-reads its objects whole, leaves other datasets alone, and the status still counts every dataset: " + scoped.Status.Databases);
        // DDL marks sales and a discovered project's dataset stale: a stale-only build reads both and spends the marks.
        harness.Service.Search.MarkStale(harness.ConnectionId, "varia-alpha", "sales");
        harness.Service.Search.MarkStale(harness.ConnectionId, "bigquery-public-data", "samples");
        var marked = harness.Service.Search.StaleOf(harness.ConnectionId).Count;
        daily = harness.Gets(Sales + "/tables/daily");
        var shakespeareReads = harness.Gets(PublicData + "/datasets/samples/tables/shakespeare");
        var datasets = harness.Gets(Alpha + "/datasets");
        await harness.Index(more => more["stale"] = true);
        check(marked == 2 && harness.Gets(Sales + "/tables/daily") == daily + 1 && harness.Gets(PublicData + "/datasets/samples/tables/shakespeare") == shakespeareReads + 1
            && harness.Gets(Alpha + "/datasets") == datasets && harness.Service.Search.StaleOf(harness.ConnectionId).Count == 0,
            "a stale-only build re-reads marked billing and discovered datasets, lists nothing else, and spends the marks");
        // DDL whose datasets cannot be known marks the project whole: a stale-only build lists the project again and reads each
        // dataset whole, and the status numbers the mark until it is spent, so the renderer asks once per mark.
        harness.Service.Search.MarkProjectStale(harness.ConnectionId, "varia-alpha");
        var projectMark = harness.Service.Search.StaleMarkOf(harness.ConnectionId);
        daily = harness.Gets(Sales + "/tables/daily");
        datasets = harness.Gets(Alpha + "/datasets");
        var wholeRead = await harness.Index(more => more["stale"] = true);
        // The project's dataset listing is two pages.
        check(projectMark > 0 && harness.Gets(Alpha + "/datasets") == datasets + 2 && harness.Gets(Sales + "/tables/daily") == daily + 1 && wholeRead.Status.StaleMark is null
            && harness.Service.Search.StaleProjectsOf(harness.ConnectionId).Count == 0 && harness.Service.Search.StaleOf(harness.ConnectionId).Count == 0,
            $"a project marked whole is listed again and each dataset read whole by a stale-only build, spending every mark (mark {projectMark}, status {wholeRead.Status.StaleMark}, datasets {harness.Gets(Alpha + "/datasets") - datasets}, daily {harness.Gets(Sales + "/tables/daily") - daily}, projects {harness.Service.Search.StaleProjectsOf(harness.ConnectionId).Count}, left {string.Join(",", harness.Service.Search.StaleOf(harness.ConnectionId))})");
        // A dataset whose read fails keeps the project's mark (numbered the same), so the status keeps it and no new build is asked for it.
        harness.Service.Search.MarkProjectStale(harness.ConnectionId, "varia-alpha");
        var failingMark = harness.Service.Search.StaleMarkOf(harness.ConnectionId);
        harness.Fake.On("GET", Sales + "/tables", BigQueryFake.Fixture("error-access-denied", 403));
        var failedWhole = await harness.Index(more => more["stale"] = true);
        harness.Fake.On("GET", Sales + "/tables", new BigQueryFake.Reply(200, recreated));
        check(failedWhole.Status.StaleMark == failingMark && harness.Service.Search.StaleOf(harness.ConnectionId).SequenceEqual([("varia-alpha", "sales")]) && harness.Service.Search.StaleProjectsOf(harness.ConnectionId).Count == 0,
            "a dataset of a project marked whole whose read fails keeps the project's mark number; the project's own mark is spent");
        await harness.Index(more => more["stale"] = true);
        // DDL that lands while a build reads the dataset keeps its mark: the build read the listing from before it.
        harness.Fake.On("GET", Sales + "/tables", _ =>
        {
            harness.Service.Search.MarkStale(harness.ConnectionId, "varia-alpha", "sales");
            return new BigQueryFake.Reply(200, recreated);
        });
        await harness.Index(more => more["starredProjects"] = new JsonArray("varia-beta"));
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
        await harness.Index(more => more["starredProjects"] = new JsonArray("varia-beta"));
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
        await harness.Index(more => more["starredProjects"] = new JsonArray("varia-beta"));
        check((await harness.Search("orders")).Hits.Count == 0 && (await harness.Search("population")).Hits.Count == 1,
            "a dataset its project no longer lists is dropped, the starred project's kept");
    }

    static async Task FailuresAsync(Action<bool, string> check, JsonObject key)
    {
        // A build without definitions, then one with them: unchanged views are read again for their text.
        using (var texts = new Harness())
        {
            await texts.ConnectAsync(key);
            await texts.Index(more => { more["definitions"] = false; more["allProjects"] = false; });
            var before = texts.Gets(Sales + "/tables/daily");
            await texts.Index(more => more["allProjects"] = false);
            var found = await texts.Search("GROUP BY day", more => more["in"] = "definitions");
            check(texts.Gets(Sales + "/tables/daily") == before + 1 && found.Hits.Any(hit => hit.Object.Name == "daily"),
                "turning definitions on reads unchanged views again, so their text is searchable");
        }
        using var harness = new Harness();
        harness.Fake.On("GET", Alpha + "/datasets/archive/tables", BigQueryFake.Fixture("error-access-denied", 403));
        harness.Fake.On("GET", Sales + "/tables/totals", BigQueryFake.Fixture("error-access-denied", 403));
        harness.Fake.On("GET", Beta + "/datasets", BigQueryFake.Fixture("error-access-denied", 403));
        await harness.ConnectAsync(key);
        var result = await harness.Index(more => { more["starredProjects"] = new JsonArray("varia-beta"); more["allProjects"] = false; });
        var skips = result.Status.Skipped;
        check(skips.Any(skip => skip is { Project: "varia-alpha", Database: "archive", Code: "PERMISSION_DENIED" })
            && skips.Any(skip => skip is { Project: "varia-beta", Database: "", Code: "PERMISSION_DENIED" })
            && skips.Any(skip => skip is { Project: "varia-alpha", Database: "sales", Code: "PERMISSION_DENIED", Details: true } && skip.Message.StartsWith("The details of 1 object", StringComparison.Ordinal))
            && skips.Where(skip => skip.Database != "sales").All(skip => skip.Details is null),
            "a refused dataset, a refused starred project listing and a refused object's details are skips naming their project: " + string.Join(" | ", skips.Select(skip => skip.Project + "/" + skip.Database + " " + skip.Code + " " + skip.Message)));
        check((await harness.Search("totals")).Hits.Any(hit => hit.Object.Name == "totals") && (await harness.Search("city")).Hits.Count > 0 && result.Status.State == "ready",
            "the rest is indexed: an object whose details failed keeps its name");
        check(!skips.Any(skip => skip.Message.Contains("orders", StringComparison.Ordinal) || skip.Message.Contains("totals", StringComparison.Ordinal)),
            "skip messages name no object");
    }

    /// <summary>Noise filtering on discovered vs starred projects, projects.list failure fallback, 500-project cap (Cut), and emulator id-only fallback.</summary>
    static async Task DiscoveryAndNoiseAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        const string Base = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/";
        // projects.list returns billing + discovered projects with various error modes (plus an id-only emulator-shaped entry).
        harness.Fake.On("GET", BigQueryFake.Projects, new BigQueryFake.Reply(200,
            "{\"projects\":["
            + "{\"projectReference\":{\"projectId\":\"varia-alpha\"}},"
            + "{\"projectReference\":{\"projectId\":\"disc-disabled\"}},"
            + "{\"projectReference\":{\"projectId\":\"disc-denied\"}},"
            + "{\"projectReference\":{\"projectId\":\"disc-missing\"}},"
            + "{\"projectReference\":{\"projectId\":\"disc-quota\"}},"
            + "{\"id\":\"disc-ok\"}"
            + "]}"));
        harness.Fake
            .On("GET", Base + "disc-disabled/datasets", new BigQueryFake.Reply(403, "{\"error\":{\"code\":403,\"message\":\"BigQuery API has not been used\",\"errors\":[{\"reason\":\"accessNotConfigured\"}]}}"))
            .On("GET", Base + "disc-denied/datasets", BigQueryFake.Fixture("error-access-denied", 403))
            .On("GET", Base + "disc-missing/datasets", new BigQueryFake.Reply(404, "{\"error\":{\"code\":404,\"message\":\"Not found\",\"errors\":[{\"reason\":\"notFound\"}]}}"))
            .On("GET", Base + "disc-quota/datasets", new BigQueryFake.Reply(403, "{\"error\":{\"code\":403,\"message\":\"Quota exceeded\",\"errors\":[{\"reason\":\"quotaExceeded\"}]}}"))
            .On("GET", Base + "disc-ok/datasets", new BigQueryFake.Reply(200, "{\"datasets\":[{\"datasetReference\":{\"projectId\":\"disc-ok\",\"datasetId\":\"analytics\"},\"location\":\"US\"}]}"))
            .On("GET", Base + "disc-ok/datasets/analytics/(routines|models)", BigQueryFake.Fixture("index-empty"))
            .On("GET", Base + "disc-ok/datasets/analytics/tables", new BigQueryFake.Reply(200, "{\"tables\":[{\"tableReference\":{\"projectId\":\"disc-ok\",\"datasetId\":\"analytics\",\"tableId\":\"metrics\"},\"type\":\"TABLE\",\"creationTime\":\"1700000000000\"}]}"))
            .On("GET", Base + "disc-ok/datasets/analytics/tables/metrics", BigQueryFake.Fixture("table-orders"))
            .On("GET", Base + "star-denied/datasets", BigQueryFake.Fixture("error-access-denied", 403))
            .On("GET", Base + "star-missing/datasets", new BigQueryFake.Reply(404, "{\"error\":{\"code\":404,\"message\":\"Not found\",\"errors\":[{\"reason\":\"notFound\"}]}}"));
        await harness.ConnectAsync(key);
        var built = await harness.Index(more => more["starredProjects"] = new JsonArray("star-denied", "star-missing"));
        var skips = built.Status.Skipped;
        check(!skips.Any(skip => skip.Project is "disc-disabled" or "disc-denied" or "disc-missing")
            && skips.Any(skip => skip is { Project: "disc-quota", Database: "", Code: "QUOTA" })
            && skips.Any(skip => skip is { Project: "star-denied", Database: "", Code: "PERMISSION_DENIED" })
            && skips.Any(skip => skip is { Project: "star-missing", Database: "", Code: "NOT_FOUND" })
            && (await harness.Search("metrics")).Hits.Any(hit => hit.Object is { Project: "disc-ok", Dataset: "analytics", Name: "metrics" })
            && (await harness.Search("metrics.address.city")).Hits.Count == 1,
            "noise filtering ignores API_DISABLED/PERMISSION_DENIED/NOT_FOUND on discovered projects, keeps QUOTA and starred errors, and indexes id-only discovered projects: "
            + string.Join(" | ", skips.Select(skip => skip.Project + ":" + skip.Code)));

        // Noise-filtered discovered projects (API_DISABLED/PERMISSION_DENIED/NOT_FOUND) are excluded from LookupBigQuery (autocomplete).
        var lookupAfterNoise = harness.Service.Search.LookupBigQuery(harness.ConnectionId, "varia-alpha");
        check(!lookupAfterNoise.Projects.Contains("disc-disabled", StringComparer.Ordinal)
            && !lookupAfterNoise.Projects.Contains("disc-denied", StringComparer.Ordinal)
            && !lookupAfterNoise.Projects.Contains("disc-missing", StringComparer.Ordinal)
            && lookupAfterNoise.Projects.Contains("disc-ok", StringComparer.Ordinal),
            "noise-filtered discovered projects do not pollute LookupBigQuery project suggestions");

        // Pruning discovered projects with allProjects: false also clears orphaned stale marks so StaleMark returns to null.
        harness.Service.Search.MarkStale(harness.ConnectionId, "disc-ok", "analytics");
        check(harness.Service.Search.StaleMarkOf(harness.ConnectionId) is > 0, "stale mark is recorded on a tracked discovered project");
        var pruned = await harness.Index(more => { more["allProjects"] = false; more["starredProjects"] = new JsonArray("varia-beta"); });
        check(pruned.Status.StaleMark is null && harness.Service.Search.StaleOf(harness.ConnectionId).Count == 0,
            "pruning discovered projects clears orphaned stale marks so StaleMark does not stay stuck non-null");
        // Restore discovered projects before testing failed discovery retention.
        await harness.Index(more => more["starredProjects"] = new JsonArray("varia-beta"));

        // Invalid connectionId on bigquery.connectionProjects and bigquery.indexEstimate returns INVALID_PARAMS, never BACKEND_ERROR.
        var (badProjConn, _, _) = await harness.Call("bigquery.connectionProjects", new JsonObject());
        var (badEstConn, _, _) = await harness.Call("bigquery.indexEstimate", new JsonObject());
        check(badProjConn == "INVALID_PARAMS" && badEstConn == "INVALID_PARAMS",
            $"omitted connectionId on bigquery.connectionProjects and bigquery.indexEstimate returns INVALID_PARAMS: {badProjConn} {badEstConn}");

        // Discovery failure records one skip (Project: "") and keeps billing + starred + unpruned earlier reads.
        harness.Fake.On("GET", BigQueryFake.Projects, BigQueryFake.Fixture("error-access-denied", 403));
        var failedDiscovery = await harness.Index(more => more["starredProjects"] = new JsonArray("varia-beta"));
        check(failedDiscovery.Status.Skipped.Any(skip => skip is { Project: "", Database: "", Code: "PERMISSION_DENIED" })
            && (await harness.Search("orders")).Hits.Count > 0
            && (await harness.Search("population")).Hits.Count > 0
            && (await harness.Search("metrics")).Hits.Count > 0,
            "when projects.list fails, one discovery skip is recorded, billing + starred still build, and earlier discovered reads are not pruned");

        // 500-project default cap (Cut): > 500 projects in one page, and 500 projects + nextPageToken.
        var fiveHundredOne = new JsonArray([.. Enumerable.Range(0, BigQueryIndexLimits.MaxProjects + 1).Select(index => (JsonNode)new JsonObject { ["id"] = $"cap-proj-{index:D4}" })]);
        harness.Fake.On("GET", BigQueryFake.Projects, new BigQueryFake.Reply(200, new JsonObject { ["projects"] = fiveHundredOne }.ToJsonString()));
        var overCap = await ((IBigQueryIndexSource)harness.Service.BigQuery).AccessibleProjectsAsync(harness.ConnectionId, BigQueryIndexLimits.MaxProjects, CancellationToken.None);
        var fiveHundred = new JsonArray([.. Enumerable.Range(0, BigQueryIndexLimits.MaxProjects).Select(index => (JsonNode)new JsonObject { ["projectReference"] = new JsonObject { ["projectId"] = $"cap-proj-{index:D4}" } })]);
        var fiveHundredJson = new JsonObject { ["projects"] = fiveHundred, ["nextPageToken"] = "p2" }.ToJsonString();
        var page2Called = false;
        harness.Fake.On("GET", BigQueryFake.Projects, request =>
        {
            if (request.Uri.Query.Contains("pageToken=p2", StringComparison.Ordinal)) { page2Called = true; return new(200, "{\"projects\":[]}"); }
            return new(200, fiveHundredJson);
        });
        var pageCap = await ((IBigQueryIndexSource)harness.Service.BigQuery).AccessibleProjectsAsync(harness.ConnectionId, BigQueryIndexLimits.MaxProjects, CancellationToken.None);
        var customCap = await ((IBigQueryIndexSource)harness.Service.BigQuery).AccessibleProjectsAsync(harness.ConnectionId, 3, CancellationToken.None);
        check(overCap is { Projects.Count: BigQueryIndexLimits.MaxProjects, Cut: true }
            && pageCap is { Projects.Count: BigQueryIndexLimits.MaxProjects, Cut: true } && !page2Called
            && customCap is { Projects.Count: 3, Cut: true }
            && overCap.Projects.SequenceEqual(overCap.Projects.Order(StringComparer.Ordinal)),
            $"AccessibleProjectsAsync caps at the requested limit (default {BigQueryIndexLimits.MaxProjects} or custom 3), sorts ordinally, and sets Cut on both in-page overflow and nextPageToken");

        // Full build with Cut == true records a TOO_LARGE truncation skip mentioning the active cap and does not prune earlier reads.
        harness.Fake.On("GET", Base + @"cap-proj-\d+/datasets", new BigQueryFake.Reply(200, "{\"datasets\":[]}"));
        var cutBuild = await harness.Index();
        var customCutBuild = await harness.Index(more => more["maxProjects"] = 3);
        check(cutBuild.Status.Skipped.Any(skip => skip is { Project: "", Database: "", Code: "TOO_LARGE" } && skip.Message.Contains("500", StringComparison.Ordinal))
            && customCutBuild.Status.Skipped.Any(skip => skip is { Project: "", Database: "", Code: "TOO_LARGE" } && skip.Message.Contains("3", StringComparison.Ordinal))
            && (await harness.Search("metrics")).Hits.Count > 0,
            "a cut project discovery records a TOO_LARGE skip noting the active project cap (500 or custom 3) and does not prune earlier reads");

        // Out-of-range maxProjects is refused with INVALID_PARAMS.
        var (badLow, _, _) = await harness.Call("explorer.index", new JsonObject { ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["maxProjects"] = 0 });
        var (badHigh, _, _) = await harness.Call("explorer.index", new JsonObject { ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["maxProjects"] = BigQueryIndexLimits.MaxProjectsCap + 1 });
        check(badLow == "INVALID_PARAMS" && badHigh == "INVALID_PARAMS", $"maxProjects below 1 or above MaxProjectsCap is refused with INVALID_PARAMS: {badLow} {badHigh}");
    }

    /// <summary>Three-wave execution order (billing full -> starred+discovered names -> starred details -> discovered details) and Wave 2/3 budget early-stop.</summary>
    static async Task WavesAndBudgetAsync(Action<bool, string> check, JsonObject key)
    {
        // 1. Verify strict 3-wave prioritization ordering.
        using (var order = new Harness())
        {
            await order.ConnectAsync(key);
            await order.Index(more => more["starredProjects"] = new JsonArray("varia-beta"));
            var urls = order.Fake.Seen.Where(request => request.Method == "GET").Select(request => request.Url).ToList();
            var lastWave1Detail = urls.FindLastIndex(url => url.Contains("/projects/varia-alpha/datasets/sales/tables/", StringComparison.Ordinal) || url.Contains("/projects/varia-alpha/datasets/sales/routines/", StringComparison.Ordinal));
            var projectsListAt = urls.FindIndex(url => url.EndsWith("/bigquery/v2/projects", StringComparison.Ordinal));
            var wave2StarredList = urls.FindIndex(url => url.EndsWith("/projects/varia-beta/datasets/census/tables", StringComparison.Ordinal));
            var wave2DiscoveredList = urls.FindIndex(url => url.EndsWith("/projects/bigquery-public-data/datasets/samples/tables", StringComparison.Ordinal));
            var wave3StarredDetail = urls.FindIndex(url => url.EndsWith("/projects/varia-beta/datasets/census/tables/population", StringComparison.Ordinal));
            var wave3DiscoveredDetail = urls.FindIndex(url => url.EndsWith("/projects/bigquery-public-data/datasets/samples/tables/shakespeare", StringComparison.Ordinal));
            check(lastWave1Detail >= 0 && lastWave1Detail < projectsListAt
                && projectsListAt < wave2StarredList && wave2StarredList < wave2DiscoveredList
                && wave2DiscoveredList < wave3StarredDetail && wave3StarredDetail < wave3DiscoveredDetail,
                $"three-wave ordering completes billing details ({lastWave1Detail}) before projects.list ({projectsListAt}), starred names ({wave2StarredList}) before discovered names ({wave2DiscoveredList}), and starred details ({wave3StarredDetail}) before discovered details ({wave3DiscoveredDetail})");
        }

        // 2. Wave 2 budget early-stop: discovered project hits TOO_LARGE -> stops further Wave 2 calls, records one summary skip, keeps Wave 1 intact.
        {
            var source = new FakeBudgetSource(discoveredProjects: ["disc-a", "disc-b", "disc-c", "disc-d", "disc-e", "disc-f", "disc-g", "disc-h"], tablesPerDiscovered: 80, columnsPerTable: 0);
            using var search = new ObjectSearchService(new UnusedHost(), new ObjectIndexLimits { MemoryBytes = 6_000, NamesReserveBytes = 0 });
            var id = Guid.NewGuid().ToString();
            var result = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
            var billingHeld = search.HeldOf(id).Any(read => read.Database == "varia-alpha" && read.Dataset == "sales");
            check(billingHeld
                && result.Status.Skipped.Count(skip => skip is { Project: "", Database: "", Code: "TOO_LARGE" }) == 1
                && source.DiscoveredObjectCalls < 8,
                $"wave 2 budget early-stop halts further discovered listing calls ({source.DiscoveredObjectCalls}/8), records one summary TOO_LARGE skip, and keeps Wave 1 intact");
        }

        // 3. Wave 3 budget early-stop (via Hold returning CHILDREN_LEFT_OUT on a wide discovered table, and via NamesReserveBytes / 2 floor).
        {
            var source = new FakeBudgetSource(discoveredProjects: ["disc-01", "disc-02", "disc-03", "disc-04", "disc-05", "disc-06", "disc-07", "disc-08"], tablesPerDiscovered: 1, columnsPerTable: 300);
            // Large enough for Wave 1 (billing) + Wave 2 (all 8 discovered project names), too small for wide discovered columns in Wave 3.
            using var search = new ObjectSearchService(new UnusedHost(), new ObjectIndexLimits { MemoryBytes = 25_000, NamesReserveBytes = 0 });
            var id = Guid.NewGuid().ToString();
            var result = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
            var billingHeld = search.HeldOf(id).SingleOrDefault(read => read.Database == "varia-alpha" && read.Dataset == "sales");
            var discoveredHeld = search.HeldOf(id).Where(read => read.Database.StartsWith("disc-", StringComparison.Ordinal)).ToList();
            check(billingHeld is { ChildrenLeftOut: false }
                && discoveredHeld.Count == 8
                && result.Status.NamesOnly is { Count: > 0 } namesOnly && namesOnly.All(project => project.StartsWith("disc-", StringComparison.Ordinal))
                && source.DiscoveredDetailCalls < 8,
                $"wave 3 budget early-stop (CHILDREN_LEFT_OUT) stops further discovered detail reads ({source.DiscoveredDetailCalls}/8), records NamesOnly ({result.Status.NamesOnly?.Count ?? 0}), and keeps Wave 1 details + all Wave 2 names");
        }
        {
            var source = new FakeBudgetSource(discoveredProjects: ["disc-01", "disc-02", "disc-03"], tablesPerDiscovered: 1, columnsPerTable: 5);
            // Reserve floor (NamesReserveBytes / 2) already exceeded after Wave 1 + Wave 2 -> Wave 3 issues 0 discovered detail calls!
            using var search = new ObjectSearchService(new UnusedHost(), new ObjectIndexLimits { MemoryBytes = 200_000, NamesReserveBytes = 399_000 });
            var id = Guid.NewGuid().ToString();
            var result = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
            check(source.DiscoveredDetailCalls == 0
                && result.Status.NamesOnly is ["disc-01", "disc-02", "disc-03"]
                && search.HeldOf(id).Count(read => read.Database.StartsWith("disc-", StringComparison.Ordinal)) == 3,
                $"wave 3 reserve floor stops before issuing discovered detail calls ({source.DiscoveredDetailCalls}) and marks all 3 discovered projects NamesOnly while keeping Wave 2 names");

            // 4. Cancelled rebuild preserves prior NamesOnly instead of eagerly wiping it at build start.
            using var cancel = new CancellationTokenSource();
            cancel.Cancel();
            var cancelled = false;
            try { await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, cancel.Token); }
            catch (RequestException error) when (error.Code == "CANCELLED") { cancelled = true; }
            var afterCancel = search.LookupBigQuery(id, "varia-alpha");
            check(cancelled && afterCancel.NamesOnly("disc-01") && afterCancel.NamesOnly("disc-02") && afterCancel.NamesOnly("disc-03"),
                "cancelled full rebuild preserves prior NamesOnly list");

            // 5. Whole-project scoped refresh that hits a detail failure keeps the project in NamesOnly; a clean scoped refresh clears only that project.
            source.FailTableForProject = "disc-01";
            var failedScope = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), Scope: new("disc-01")), source, CancellationToken.None);
            check(failedScope.Status.NamesOnly is ["disc-01", "disc-02", "disc-03"],
                "whole-project scoped refresh with detail failure keeps the project in NamesOnly");

            source.FailTableForProject = null;
            var cleanScope = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), Scope: new("disc-01")), source, CancellationToken.None);
            check(cleanScope.Status.NamesOnly is ["disc-02", "disc-03"],
                "clean whole-project scoped refresh clears only that project from NamesOnly");
        }

        // 6. Wave 2 budget early-stop racing with a sibling non-OCE API error still completes cleanly (does not crash with TIMEOUT).
        {
            var source = new FakeBudgetSource(discoveredProjects: ["disc-a", "disc-b", "disc-c", "disc-d"], tablesPerDiscovered: 80, columnsPerTable: 0)
            {
                ThrowOnCancelObjectsProject = "disc-b"
            };
            using var search = new ObjectSearchService(new UnusedHost(), new ObjectIndexLimits { MemoryBytes = 6_000, NamesReserveBytes = 0 });
            var id = Guid.NewGuid().ToString();
            var result = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
            check(search.HeldOf(id).Any(read => read.Database == "varia-alpha" && read.Dataset == "sales")
                && result.Status.Skipped.Count(skip => skip is { Project: "", Database: "", Code: "TOO_LARGE" }) == 1,
                "wave 2 early-stop survives a sibling non-OCE API error racing with cancellation");
        }

        // 7. Dataset-scoped refresh of a dropped stale dataset on a session-only project clears its stale mark (no leaked StaleMark).
        {
            var source = new FakeBudgetSource(discoveredProjects: [], tablesPerDiscovered: 1, columnsPerTable: 1)
            {
                CustomDatasets = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal) { ["session-only-proj"] = ["adhoc"] }
            };
            using var search = new ObjectSearchService(new UnusedHost());
            var id = Guid.NewGuid().ToString();
            await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), AllProjects: false), source, CancellationToken.None);
            await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), Scope: new("session-only-proj")), source, CancellationToken.None);
            search.MarkStale(id, "session-only-proj", "adhoc");
            var hadMark = search.StaleMarkOf(id) is not null && search.StaleOf(id).Contains(("session-only-proj", "adhoc"));
            source.CustomDatasets["session-only-proj"] = [];
            var refreshed = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), Scope: new("session-only-proj", "adhoc")), source, CancellationToken.None);
            check(hadMark
                && !search.HeldOf(id).Any(read => read.Database == "session-only-proj")
                && search.StaleOf(id).Count == 0
                && search.StaleMarkOf(id) is null
                && refreshed.Status.StaleMark is null,
                "dataset-scoped refresh of a dropped stale dataset clears its stale mark even for session-only projects");
        }

        // 8. Full rebuild with priorNamesOnly retains failed projects, clears clean ones, and drops newly noise-filtered projects + stale marks.
        {
            var source = new FakeBudgetSource(discoveredProjects: ["disc-01", "disc-02", "disc-03"], tablesPerDiscovered: 1, columnsPerTable: 300);
            using var search = new ObjectSearchService(new UnusedHost(), new ObjectIndexLimits { MemoryBytes = 25_000, NamesReserveBytes = 0 });
            var id = Guid.NewGuid().ToString();
            var build1 = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
            var hadNamesOnly = build1.Status.NamesOnly is { Count: > 0 } && build1.Status.NamesOnly.Contains("disc-02", StringComparer.Ordinal);

            // Shrink tables so full details fit; fail DatasetsAsync on disc-02 so it stays NamesOnly while others clear.
            source.ColumnsPerTable = 2;
            source.FailDatasetsForProject = ("disc-02", "TIMEOUT");
            var build2 = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
            var retainedFailed = build2.Status.NamesOnly is ["disc-02"];

            // Clean full rebuild clears NamesOnly completely.
            source.FailDatasetsForProject = null;
            var build3 = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
            var clearedAll = build3.Status.NamesOnly is null;

            // Previously indexed discovered project transitioning to noise-filtered (API_DISABLED) drops its datasets, stale marks, and lookup presence.
            search.MarkStale(id, "disc-01", "ds");
            search.MarkProjectStale(id, "disc-01");
            source.FailDatasetsForProject = ("disc-01", "API_DISABLED");
            var build4 = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
            var lookup4 = search.LookupBigQuery(id, "varia-alpha");
            check(hadNamesOnly && retainedFailed && clearedAll
                && !search.HeldOf(id).Any(read => read.Database == "disc-01")
                && !search.StaleOf(id).Any(item => item.Project == "disc-01")
                && !search.StaleProjectsOf(id).Contains("disc-01")
                && !lookup4.Projects.Contains("disc-01")
                && !build4.Status.Skipped.Any(skip => skip.Project == "disc-01"),
                "full rebuild retains priorNamesOnly on failed re-reads, clears on clean rebuild, and drops datasets/stale marks when a discovered project becomes API_DISABLED");
        }

        // 9. Superseded concurrent build answers CANCELLED without corrupting the superseding build or leaking index memory.
        {
            var enteredBuild1 = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var releaseBuild1 = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var callCount = 0;
            var source = new FakeBudgetSource(discoveredProjects: ["disc-01"], tablesPerDiscovered: 2, columnsPerTable: 3)
            {
                OnObjectsAsync = async (project, _) =>
                {
                    if (project == "varia-alpha" && Interlocked.Increment(ref callCount) == 1)
                    {
                        enteredBuild1.TrySetResult();
                        await releaseBuild1.Task;
                    }
                }
            };
            using var search = new ObjectSearchService(new UnusedHost());
            var id = Guid.NewGuid().ToString();
            var build1Task = search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
            await enteredBuild1.Task;
            var build2 = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
            releaseBuild1.TrySetResult();
            var build1Cancelled = false;
            try { await build1Task; }
            catch (RequestException error) when (error.Code == "CANCELLED") { build1Cancelled = true; }
            var heldAfter = search.HeldOf(id).Count;
            search.Forget(id);
            check(build1Cancelled && build2.Status.State == "ready" && heldAfter == 2 && search.MemoryUsed == 0,
                $"superseded concurrent build answers CANCELLED ({build1Cancelled}), leaves superseding build intact ({heldAfter} datasets), and leaks 0 bytes on Forget ({search.MemoryUsed})");
        }

        // 10. Connection-level BigQuery skips (maxProjects truncation / discovery failure) survive even after >256 dataset skips in Wave 1.
        {
            var manyDatasets = Enumerable.Range(0, 265).Select(index => "ds_" + index).ToList();
            var source = new FakeBudgetSource(discoveredProjects: ["disc-01", "disc-02"], tablesPerDiscovered: 1, columnsPerTable: 1)
            {
                CustomDatasets = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal) { ["varia-alpha"] = manyDatasets },
                FailObjectsForProject = ("varia-alpha", "PERMISSION_DENIED")
            };
            using var search = new ObjectSearchService(new UnusedHost());
            var id = Guid.NewGuid().ToString();
            var result = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), MaxProjects: 1), source, CancellationToken.None);
            check(result.Status.Skipped.Any(skip => skip is { Project: "", Database: "", Code: "TOO_LARGE" }),
                "connection-level maxProjects truncation skip is preserved via SkipList.Server even after >256 Wave 1 dataset skips");
        }

        // 11. Mid-project Wave 2 memory early-stop reports ProjectState.Partial and Dataset.Skipped in BigQueryLookup.
        {
            var source = new FakeBudgetSource(discoveredProjects: ["disc-mid"], tablesPerDiscovered: 40, columnsPerTable: 0)
            {
                CustomDatasets = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal) { ["disc-mid"] = ["ds1", "ds2", "ds3", "ds4", "ds5", "ds6"] },
                TablesPerDataset = new Dictionary<(string, string), int> { [("disc-mid", "ds1")] = 1, [("disc-mid", "ds2")] = 200, [("disc-mid", "ds3")] = 200, [("disc-mid", "ds4")] = 200, [("disc-mid", "ds5")] = 200, [("disc-mid", "ds6")] = 200 }
            };
            using var search = new ObjectSearchService(new UnusedHost(), new ObjectIndexLimits { MemoryBytes = 6_000, NamesReserveBytes = 0 });
            var id = Guid.NewGuid().ToString();
            var result = await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
            var lookup = search.LookupBigQuery(id, "varia-alpha");
            var missing = new[] { "ds2", "ds3", "ds4", "ds5", "ds6" }.FirstOrDefault(ds => !lookup.Datasets("disc-mid").Contains(ds));
            var missingInfo = missing is not null ? lookup.Dataset("disc-mid", missing) : null;
            check(lookup.Datasets("disc-mid").Contains("ds1")
                && lookup.ProjectState("disc-mid") == LookupState.Partial
                && missingInfo is { State: LookupState.Skipped, Skip.Code: "TOO_LARGE" }
                && result.Status.Skipped.Any(skip => skip is { Project: "", Database: "", Code: "TOO_LARGE" }),
                $"mid-project Wave 2 memory early-stop reports Partial project state ({lookup.ProjectState("disc-mid")}) and Skipped for unheld dataset {missing} ({missingInfo?.State})");

            // Promoting disc-mid to starred and cleanly refreshing it clears Partial even if AccessibleProjectsAsync fails.
            source.CustomDatasets["disc-mid"] = ["ds1", "ds2"];
            source.TablesPerDataset = new Dictionary<(string, string), int> { [("disc-mid", "ds1")] = 1, [("disc-mid", "ds2")] = 1 };
            source.FailDiscovery = true;
            await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString(), StarredProjects: ["disc-mid"]), source, CancellationToken.None);
            var promotedLookup = search.LookupBigQuery(id, "varia-alpha");
            check(promotedLookup.ProjectState("disc-mid") == LookupState.Ready,
                $"clean starred rebuild clears PartialProjects even when discovery fails ({promotedLookup.ProjectState("disc-mid")})");
        }

        // 12. Wave 2 budget-stop does not conflate NOT_FOUND or PERMISSION_DENIED on earlier projects with budget cuts.
        {
            var source = new FakeBudgetSource(discoveredProjects: ["disc-a", "disc-b", "disc-c"], tablesPerDiscovered: 1, columnsPerTable: 0)
            {
                CustomDatasets = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal)
                {
                    ["disc-a"] = ["ds_ok", "ds_gone"],
                    ["disc-b"] = ["ds_denied"],
                    ["disc-c"] = ["ds_huge1", "ds_huge2"]
                },
                TablesPerDataset = new Dictionary<(string, string), int>
                {
                    [("disc-a", "ds_ok")] = 1,
                    [("disc-c", "ds_huge1")] = 200,
                    [("disc-c", "ds_huge2")] = 200
                },
                FailObjectsForDataset = new Dictionary<(string, string), string>
                {
                    [("disc-a", "ds_gone")] = "NOT_FOUND",
                    [("disc-b", "ds_denied")] = "PERMISSION_DENIED"
                }
            };
            using var search = new ObjectSearchService(new UnusedHost(), new ObjectIndexLimits { MemoryBytes = 6_000, NamesReserveBytes = 0 });
            var id = Guid.NewGuid().ToString();
            await search.IndexBigQueryAsync(new ObjectIndexArgs(id, Guid.NewGuid().ToString()), source, CancellationToken.None);
            var lookup = search.LookupBigQuery(id, "varia-alpha");
            check(lookup.ProjectState("disc-a") == LookupState.Ready
                && lookup.Dataset("disc-b", "ds_denied") is { State: LookupState.Skipped, Skip.Code: "PERMISSION_DENIED" },
                $"Wave 2 budget-stop keeps NOT_FOUND project Ready ({lookup.ProjectState("disc-a")}) and preserves PERMISSION_DENIED dataset skip ({lookup.Dataset("disc-b", "ds_denied").State}/{lookup.Dataset("disc-b", "ds_denied").Skip?.Code})");
        }
    }

    sealed class UnusedHost : IObjectSearchHost
    {
        public Varia.Backend.Explorer.ServerProfile Profile(string connectionId) => throw new NotSupportedException();
        public Microsoft.Data.SqlClient.SqlConnection Connection(string connectionId, string? database) => throw new NotSupportedException();
        public Task OpenAsync(Microsoft.Data.SqlClient.SqlConnection connection, CancellationToken token) => throw new NotSupportedException();
    }

    sealed class FakeBudgetSource(IReadOnlyList<string> discoveredProjects, int tablesPerDiscovered, int columnsPerTable) : IBigQueryIndexSource
    {
        private int discoveredObjectCalls, discoveredDetailCalls;
        public int DiscoveredObjectCalls => Volatile.Read(ref discoveredObjectCalls);
        public int DiscoveredDetailCalls => Volatile.Read(ref discoveredDetailCalls);
        public int ColumnsPerTable { get; set; } = columnsPerTable;
        public bool FailDiscovery { get; set; }
        public string? FailTableForProject { get; set; }
        public (string Project, string Code)? FailDatasetsForProject { get; set; }
        public (string Project, string Code)? FailObjectsForProject { get; set; }
        public Dictionary<(string Project, string Dataset), string>? FailObjectsForDataset { get; set; }
        public string? ThrowOnCancelObjectsProject { get; set; }
        public Dictionary<string, IReadOnlyList<string>>? CustomDatasets { get; set; }
        public Dictionary<(string Project, string Dataset), int>? TablesPerDataset { get; set; }
        public Func<string, CancellationToken, Task>? OnObjectsAsync { get; set; }

        public string BillingProject(string connectionId) => "varia-alpha";
        public Task<BigQueryProjectDiscovery> AccessibleProjectsAsync(string connectionId, int maxProjects, CancellationToken token)
        {
            if (FailDiscovery) throw new RequestException("TIMEOUT", "Simulated discovery failure.");
            return Task.FromResult(new BigQueryProjectDiscovery([.. discoveredProjects.Take(maxProjects)], discoveredProjects.Count > maxProjects));
        }
        public Task<BigQueryDatasetList> DatasetsAsync(string connectionId, string project, CancellationToken token)
        {
            if (FailDatasetsForProject is { } fail && fail.Project == project)
                throw new RequestException(fail.Code, "Simulated datasets failure.");
            if (CustomDatasets is not null && CustomDatasets.TryGetValue(project, out var custom))
                return Task.FromResult(new BigQueryDatasetList([.. custom], false));
            return Task.FromResult(new BigQueryDatasetList([project == "varia-alpha" ? "sales" : "ds"], false));
        }
        public async Task<BigQueryListing> ObjectsAsync(string connectionId, string project, string dataset, CancellationToken token)
        {
            if (OnObjectsAsync is not null) await OnObjectsAsync(project, token);
            if (FailObjectsForProject is { } failObjects && failObjects.Project == project)
                throw new RequestException(failObjects.Code, "Simulated objects failure.");
            if (FailObjectsForDataset is not null && FailObjectsForDataset.TryGetValue((project, dataset), out var datasetFail))
                throw new RequestException(datasetFail, "Simulated dataset objects failure.");
            if (project == ThrowOnCancelObjectsProject)
            {
                var canceled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                using var registration = token.Register(() => canceled.TrySetResult());
                await canceled.Task;
                throw new RequestException("TIMEOUT", "Simulated non-OCE sibling failure after cancel.");
            }
            if (project != "varia-alpha")
            {
                Interlocked.Increment(ref discoveredObjectCalls);
                await Task.Yield();
            }
            var count = TablesPerDataset is not null && TablesPerDataset.TryGetValue((project, dataset), out var customCount)
                ? customCount
                : project == "varia-alpha" ? 1 : tablesPerDiscovered;
            var tables = Enumerable.Range(0, count).Select(index => new Google.Apis.Bigquery.v2.Data.TableList.TablesData
            {
                TableReference = new() { ProjectId = project, DatasetId = dataset, TableId = project + "_tbl_" + index },
                Type = "TABLE", CreationTime = 1700000000000
            }).ToList();
            return new BigQueryListing(tables, [], [], false);
        }
        public async Task<Google.Apis.Bigquery.v2.Data.Table> TableAsync(string connectionId, string project, string dataset, string table, CancellationToken token)
        {
            if (project == FailTableForProject) throw new RequestException("TIMEOUT", "Simulated detail timeout.");
            if (project != "varia-alpha")
            {
                Interlocked.Increment(ref discoveredDetailCalls);
                await Task.Yield();
            }
            var count = project == "varia-alpha" ? 2 : ColumnsPerTable;
            var fields = Enumerable.Range(0, count).Select(index => new Google.Apis.Bigquery.v2.Data.TableFieldSchema
            {
                Name = "col_" + project + "_" + index, Type = "STRING", Mode = "NULLABLE"
            }).ToList();
            return new Google.Apis.Bigquery.v2.Data.Table { Type = "TABLE", Schema = new() { Fields = fields } };
        }
        public Task<Google.Apis.Bigquery.v2.Data.Routine> RoutineAsync(string connectionId, string project, string dataset, string routine, CancellationToken token) =>
            throw new NotSupportedException();
        public IAsyncEnumerable<BigQueryBulkDataset> BulkAsync(string connectionId, string project, string location, bool definitions, long? cap, BigQueryBulkBudget budget,
            Func<string, string, bool> wanted, CancellationToken token) => throw new NotSupportedException();
        public Exception Map(Exception error, string project, string permission, CancellationToken token) => error;
    }
}
