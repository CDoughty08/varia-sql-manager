using System.Text.Json.Nodes;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>
/// The editor's lookup into a BigQuery index (docs/object-search.md, Editor lookup): language.lookup by path over the reader
/// <see cref="BigQueryLookup"/> (projects, datasets, objects, columns and nested fields with types and facts), case resolution,
/// prefixes and limits, names-only projects, dataset states, and the request's bounds. Every request goes to <see cref="BigQueryFake"/>.
/// </summary>
internal static partial class BigQueryIndexChecks
{
    static JsonObject LookupArgs(string connectionId, params JsonObject[] requests) => new() { ["connectionId"] = connectionId, ["requests"] = new JsonArray(requests) };
    static JsonObject PathRequest(params string[] path) => new() { ["path"] = new JsonArray([.. path.Select(part => (JsonNode)part)]) };
    static string Items(LanguageLookupAnswer answer) => string.Join(",", answer.Items.Select(item => item.Name));

    /// <summary>Dataset and project states from a reader made directly: building, skipped, partial and absent.</summary>
    static void LookupStates(Action<bool, string> check)
    {
        var budget = new IndexBudget(1 << 20);
        var building = new BigQueryLookup("p", ["q", "p"], [], null, [], building: true, built: false, budget);
        check(building.Index == "building" && building.Projects is ["p", "q"] && building.Dataset("p", "d").State == LookupState.Building && building.ProjectState("q") == LookupState.Building,
            "while the first build runs, the index says building, its projects are billing then extras (once each), and a dataset not read yet is building");
        var skips = new List<ObjectIndexSkip> { new("d", "PERMISSION_DENIED", "x", Project: "p"), new("", "API_DISABLED", "y", Project: "q") };
        var skipped = new BigQueryLookup("p", ["q"], [], null, skips, building: false, built: true, budget);
        check(skipped.Dataset("p", "d") is { State: LookupState.Skipped, Skip.Code: "PERMISSION_DENIED" } && skipped.ProjectState("q") == LookupState.Skipped
            && skipped.Dataset("p", "other").State == LookupState.Absent && skipped.ProjectState("nope") == LookupState.Absent && skipped.Index == "ready",
            "a dataset whose read failed is skipped with its reason, a project whose listing failed is skipped, and a name the index never held is absent");
        check(skipped.Dataset("p", "D") is { State: LookupState.Skipped, Dataset: "d", Skip.Code: "PERMISSION_DENIED" }, "a skipped dataset asked for in another case finds its skip, spelled as the index holds it");
        var nullRequest = false;
        try { EditorLookup.Validate(new LanguageLookupArgs(Guid.NewGuid().ToString(), [null!])); }
        catch (RequestException error) { nullRequest = error.Code == "INVALID_PARAMS"; }
        check(nullRequest, "a null request is refused as invalid, not a backend failure");
        var none = new BigQueryLookup("p", [], [], null, [], building: false, built: false, budget);
        check(none.Index == "none" && none.ProjectState("p") == LookupState.Absent && none.Datasets("p").Count == 0, "a connection never indexed has no index and no datasets");
    }

    static async Task LookupAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        var id = harness.ConnectionId;
        async Task<LanguageLookupResult> Lookup(params JsonObject[] requests)
        {
            var (code, result, message) = await harness.Call("language.lookup", LookupArgs(id, requests));
            return code == "ok" ? (LanguageLookupResult)result! : throw new InvalidOperationException("lookup: " + code + " " + message);
        }

        var before = await Lookup(PathRequest(), PathRequest("varia-alpha"));
        check(before.Index == "none" && Items(before.Answers[0]) == "varia-alpha" && before.Answers[1] is { State: "absent", Items.Count: 0 },
            $"before any build the lookup names the billing project and knows no dataset: {before.Index} {Items(before.Answers[0])} {before.Answers[1].State}");
        var gets = harness.Fake.To(".*").Count();
        await harness.Index(more => more["starredProjects"] = new JsonArray("varia-beta"));
        var after = harness.Fake.To(".*").Count();
        await Lookup(PathRequest("varia-alpha", "sales", "orders"));
        check(harness.Fake.To(".*").Count() == after && after > gets, "a lookup reads the index in memory: no request reaches BigQuery");

        var top = await Lookup(PathRequest(), PathRequest("varia-alpha"), PathRequest("varia-alpha", "sales"), PathRequest("varia-beta", "census"), PathRequest("bigquery-public-data", "samples"), PathRequest("nope"));
        var objects = top.Answers[2];
        check(top.Index == "ready" && Items(top.Answers[0]) == "varia-alpha,varia-beta,bigquery-public-data,example.com:varia-beta"
            && top.Answers[0].Items.All(item => item is { Kind: "bqProject", Detail: null, NamesOnly: null, Partial: null })
            && top.Answers[0].Items.Select(item => (item.Name, item.Tier)).SequenceEqual([("varia-alpha", "billing"), ("varia-beta", "starred"), ("bigquery-public-data", "discovered"), ("example.com:varia-beta", "discovered")]),
            "projects come back in billing, starred, then discovered order with tiers and full details: " + Items(top.Answers[0]));
        check(top.Answers[1] is { State: "ready", Path: ["varia-alpha"] } && top.Answers[1].Items.Select(item => item.Name).ToList() is var datasets && datasets.Contains("sales") && datasets.Contains("staging")
            && datasets.SequenceEqual(datasets.Order(StringComparer.Ordinal)) && top.Answers[1].Items.All(item => item is { Kind: "bqDataset", Partial: null }),
            "a project's datasets come back by name: " + Items(top.Answers[1]));
        var ordersItem = objects.Items.Single(item => item.Name == "orders");
        check(objects is { State: "ready", Truncated: false } && ordersItem is { Kind: "bqTable", Rows: 1234567, Bytes: 5368709120, Partitioning: "DAY on placed", Clustering: "customer, region", Description: null, Partial: null }
            && objects.Items.Any(item => item is { Name: "daily", Kind: "bqView", Partial: null })
            && objects.Items.Any(item => item is { Name: "orders_copy", Kind: "bqTable", Subtype: "clone", Partial: null })
            && objects.Items.Any(item => item is { Name: "to_cents", Kind: "bqRoutine", Subtype: "scalar", Detail: "(dollars NUMERIC) RETURNS INT64", Partial: null })
            && objects.Items.Single(item => item.Name.StartsWith("events_2", StringComparison.Ordinal)) is { Name: "events_20260103", Shards: { Count: 3, Prefix: "events_" } }
            && objects.Items.Any(item => item.Kind == "bqModel") && objects.Items.All(item => item.Kind != "bqDataset" && item.Kind != "bqColumn"),
            "a dataset's objects come back with kinds, subtypes, summary metadata, a routine's signature and a sharded group as its newest shard, without descriptions unless asked: " + Items(objects));
        check(top.Answers[3] is { State: "ready" } && Items(top.Answers[3]) == "population"
            && top.Answers[4] is { State: "ready" } && Items(top.Answers[4]) == "shakespeare"
            && top.Answers[5] is { State: "absent", Path: ["nope"], Items.Count: 0 },
            $"starred and discovered datasets are ready with their objects, and an unknown project is absent: {top.Answers[3].State} {top.Answers[4].State} {top.Answers[5].State}");

        var detailedItems = (await Lookup(new JsonObject { ["path"] = new JsonArray("varia-alpha", "sales"), ["details"] = true })).Answers[0];
        check(detailedItems.Items.Single(item => item.Name == "orders").Description == "Orders placed online.",
            "object list items carry table descriptions only when details are requested");

        var orders = (await Lookup(PathRequest("varia-alpha", "sales", "orders"))).Answers[0];
        check(orders.Object is { Name: "orders", Kind: "bqTable", Detailed: true, Rows: 1234567, Bytes: 5368709120, Partitioning: "DAY on placed", Clustering: "customer, region", Description: "Orders placed online." },
            "a table's answer carries its facts: rows, size, partitioning, clustering and description");
        check(Items(orders) == "id,customer,tags,placed,address,address.city,address.geo,address.geo.lat"
            && orders.Items[0] is { Kind: "bqColumn", Type: "INT64", Nullable: false } && orders.Items[2].Type == "ARRAY<STRING>" && orders.Items[4] is { Subtype: "struct", Type: "STRUCT" }
            && orders.Items[7] is { Type: "FLOAT64", Nullable: true } && orders.Items.All(item => item.Description is null),
            "its columns come back in schema order with nested fields by path, types and nullability, and no descriptions unless asked: " + Items(orders));

        var narrowed = await Lookup(new JsonObject { ["path"] = new JsonArray("varia-alpha", "sales"), ["prefix"] = "ORDERS" },
            new JsonObject { ["path"] = new JsonArray("varia-alpha", "sales"), ["prefix"] = "o", ["limit"] = 2 },
            new JsonObject { ["path"] = new JsonArray("varia-alpha", "sales", "orders"), ["prefix"] = "ADDRESS.", ["details"] = true },
            new JsonObject { ["path"] = new JsonArray("varia-alpha", "sales", "orders"), ["prefix"] = "address.CITY", ["exact"] = true },
            new JsonObject { ["path"] = new JsonArray("VARIA-ALPHA", "SALES", "Orders") });
        check(Items(narrowed.Answers[0]) == "orders,orders_2024,orders_copy,orders_forecast" && narrowed.Answers[1] is { Items.Count: 2, Truncated: true },
            $"a prefix keeps the names that start with it, case ignored, and a limit cuts the answer and says so: {Items(narrowed.Answers[0])} / {Items(narrowed.Answers[1])}");
        check(Items(narrowed.Answers[2]) == "address.city,address.geo,address.geo.lat" && Items(narrowed.Answers[3]) == "address.city",
            "a column prefix narrows to a STRUCT's fields, and an exact request keeps the one column, case ignored");
        check(narrowed.Answers[4] is { Path: ["varia-alpha", "sales", "orders"], Object.Name: "orders" },
            "names that differ only in case resolve to the one the index holds, and the answer says how it spells them");

        var shards = (await Lookup(PathRequest("varia-alpha", "sales", "events_*"), PathRequest("varia-alpha", "sales", "events_20260101"), PathRequest("varia-alpha", "sales", "events_2026*"))).Answers;
        check(shards.All(answer => answer.Object?.Name == "events_20260103" && answer.Items.Count > 0),
            "a wildcard or an older shard of a date-sharded group answers with the group's newest shard and its columns: " + string.Join(",", shards.Select(answer => answer.Object?.Name ?? "-")));
        // Readers made over the held reads with skips a later build would leave: a re-read that failed, a listing that failed, a
        // dataset listed but never read, and a skip spelled exactly where a held dataset differs only in case.
        var held = harness.Service.Search.HeldOf(id);
        BigQueryLookup With(params ObjectIndexSkip[] skips) => new("varia-alpha", ["varia-beta"], held, ["varia-beta"], skips, building: false, built: true, new IndexBudget(1 << 20));
        check(With(new ObjectIndexSkip("sales", "TOO_LARGE", "x", Project: "varia-alpha")).Dataset("varia-alpha", "sales") is { State: LookupState.Partial, Skip.Code: "TOO_LARGE", Held: not null }
            && With().Dataset("varia-alpha", "sales").State == LookupState.Ready,
            "a held dataset whose later read failed or was cut is partial, with that skip, and ready without it");
        check(With(new ObjectIndexSkip("", "PERMISSION_DENIED", "x", Project: "varia-alpha")).ProjectState("varia-alpha") == LookupState.Partial
            && With(new ObjectIndexSkip("hidden", "TIMEOUT", "x", Project: "varia-alpha")).ProjectState("varia-alpha") == LookupState.Partial && With().ProjectState("varia-alpha") == LookupState.Ready,
            "a project whose listing failed after earlier reads, or with a dataset it never read, is partial");
        var unread = new BigQueryLookup("varia-alpha", ["varia-beta"], [.. held.Where(read => read.Database != "varia-beta")], ["varia-beta"],
            [new ObjectIndexSkip("census", "PERMISSION_DENIED", "x", Project: "varia-beta")], building: false, built: true, new IndexBudget(1 << 20));
        check(unread.ProjectState("varia-beta") == LookupState.Partial && unread.Dataset("varia-beta", "census").State == LookupState.Skipped,
            "a project listed but with no dataset read, because the reads failed, is partial");
        var early = new BigQueryLookup("varia-alpha", ["varia-beta"], [.. held.Where(read => read.Database != "varia-beta")], ["varia-beta"],
            [new ObjectIndexSkip("census", "PERMISSION_DENIED", "x", Project: "varia-beta")], building: true, built: false, new IndexBudget(1 << 20));
        check(early.ProjectState("varia-beta") == LookupState.Building, "a project whose first dataset failed while the build still runs is building");
        static BigQueryShardsDto Group(string prefix) => new(prefix, 2, "20260101", "20260102");
        (string, BigQueryShardsDto?)[] ga4 = [("events_20260102", Group("events_")), ("events_intraday_20260102", Group("events_intraday_")), ("orders", null)];
        check(BigQueryLookup.PickShardGroup("events_*", ga4) == 0 && BigQueryLookup.PickShardGroup("events_intraday_*", ga4) == 1 && BigQueryLookup.PickShardGroup("events_i*", ga4) == 1
            && BigQueryLookup.PickShardGroup("ev*", ga4) == -1 && BigQueryLookup.PickShardGroup("events_20260102", ga4) == 0
            && BigQueryLookup.PickShardGroup("e*", [("events_20260102", Group("events_")), ("employees", null)]) == -1 && BigQueryLookup.PickShardGroup("o*", ga4) == -1
            && BigQueryLookup.PickShardGroup("events_*", [("events_20260102", Group("events_")), ("events_summary", null)]) == 0
            && BigQueryLookup.PickShardGroup("ev*", [("events_20260102", Group("events_")), ("evaluations", null)]) == -1 && BigQueryLookup.PickShardGroup("ev*", [("events_20260102", Group("events_"))]) == 0
            && BigQueryLookup.PickShardGroup("events_20260101", [("events_20260102", Group("events_")), ("events_summary", null)]) == 0,
            "a wildcard means the group it covers whole before the tables and groups it only begins, else none when it begins a plain table and a group or two groups");
        check(With(new ObjectIndexSkip("SALES", "PERMISSION_DENIED", "x", Project: "varia-alpha")).Dataset("varia-alpha", "SALES") is { State: LookupState.Skipped, Dataset: "SALES" },
            "a skip spelled exactly as asked wins over a held dataset that differs from it only in case");
        var events = With().Dataset("varia-alpha", "sales");
        check(With().Object(events, "events_2026*") is { Name: "events_20260103" } && With().Object(events, "events_20990101") is null && With().Object(events, "EVENTS_20260101") is null
            && With().Object(events, "events_20251231") is null,
            "a shard outside the group's range, or the prefix in another case, names no group");
        var salesRead = held.Single(read => read.Database == "varia-alpha" && read.Dataset == "sales");
        salesRead.ChildrenLeftOut = true;
        var cut = (await Lookup(PathRequest("varia-alpha", "sales", "orders"), PathRequest("varia-alpha", "sales", "to_cents"), PathRequest("varia-alpha", "sales", "orders_forecast"), PathRequest("varia-alpha", "sales"))).Answers;
        salesRead.ChildrenLeftOut = false;
        check(cut[0].Object is { Detailed: false, Description: "Orders placed online." } && cut[0].State == "partial" && cut[1].Object is { Detailed: true }
            && cut[2].Object is { Kind: "bqModel", Detailed: true }
            && cut[3].Items.Single(item => item.Name == "orders").Partial == true
            && cut[3].Items.Single(item => item.Name == "to_cents").Partial is null
            && cut[3].Items.Single(item => item.Name == "orders_forecast").Partial is null,
            "a table whose dataset's columns were left out is not detailed and its item is marked partial; routines and models stay detailed");
        var namesOnlyWithModelRead = wideReadModelCheck(id, new ObjectIndexLimits { MemoryBytes = 64_000, NamesReserveBytes = 0 });
        check(namesOnlyWithModelRead, "a bqModel in a namesOnly project is marked Detailed: false and Partial: true even though models have no columns");
        var census = (await Lookup(PathRequest("varia-beta", "census", "population"))).Answers[0];
        var discoveredTable = (await Lookup(PathRequest("bigquery-public-data", "samples", "shakespeare"))).Answers[0];
        check(census is { State: "ready", Object: { Detailed: true }, Items.Count: > 0 }
            && discoveredTable is { State: "ready", Object: { Name: "shakespeare", Detailed: true }, Items.Count: > 0 }
            && Items(discoveredTable) == "id,customer,tags,placed,address,address.city,address.geo,address.geo.lat",
            "starred and discovered project tables resolve with full details and columns in language.lookup");
        var namesOnlyLookup = With();
        check(namesOnlyLookup.NamesOnly("varia-beta") && namesOnlyLookup.Dataset("varia-beta", "census").State == LookupState.Partial,
            "a project in NamesOnly reports partial state for its datasets");
        var tierAndPartialLookup = new BigQueryLookup("varia-alpha", ["varia-beta", "bigquery-public-data"], held, ["varia-beta"], [],
            building: false, built: true, new IndexBudget(1 << 20), partialProjects: ["bigquery-public-data"], starredProjects: ["varia-beta"]);
        var tierAnswer = EditorLookup.Answer(tierAndPartialLookup, new LanguageLookupArgs(id, [new([]), new(["varia-beta"]), new(["bigquery-public-data"])]));
        check(tierAnswer.Answers[0].Items[0] is { Name: "varia-alpha", Tier: "billing", Detail: null, NamesOnly: null, Partial: null }
            && tierAnswer.Answers[0].Items[1] is { Name: "varia-beta", Tier: "starred", Detail: "names", NamesOnly: true, Partial: null }
            && tierAnswer.Answers[0].Items[2] is { Name: "bigquery-public-data", Tier: "discovered", Detail: null, NamesOnly: null, Partial: true }
            && tierAnswer.Answers[1].Items.All(item => item.Partial == true),
            "EditorLookup distinguishes project tiers, namesOnly projects (whose datasets are partial), and partial projects");

        // Table/view descriptions: empty/null normalization, FactChars clipping, Weight accounting, and IndexBudget charging above detailsFloor.
        var blankDesc = BigQueryEntries.FromTable(new Google.Apis.Bigquery.v2.Data.Table { Type = "TABLE", Description = "" });
        var longDescText = new string('d', BigQueryIndexLimits.FactChars + 400);
        var longDesc = BigQueryEntries.FromTable(new Google.Apis.Bigquery.v2.Data.Table { Type = "VIEW", Description = longDescText, View = new() { Query = "SELECT 1" } });
        var emptyDesc = new BigQueryDetail(null, null, null, []);
        var emptyStrings = new BigQueryDetail(null, null, null, [], Partitioning: "", Clustering: "", Signature: "", Description: "");
        check(blankDesc.Description is null && longDesc.Description == longDescText && BigQueryReader.Weight(longDesc) > BigQueryReader.Weight(emptyDesc)
            && BigQueryReader.Weight(emptyStrings) == 0,
            "FromTable normalizes empty descriptions to null and Weight ignores empty strings while accounting for table descriptions");
        var descEntry = new BigQueryEntry("bqView", "bqViews", null, "v", 1, null, Detail: longDesc);
        var plainEntry = descEntry with { Detail = longDesc with { Description = null } };
        var baseLimits = new ObjectIndexLimits { MemoryBytes = 64_000, NamesReserveBytes = 0 };
        var basePool = new StringPool(new IndexBudget(baseLimits.MemoryBytes));
        var plainRead = new BigQueryReader(baseLimits, basePool, null).Read("p", "d", [plainEntry], true, true)!;
        var descPool = new StringPool(new IndexBudget(baseLimits.MemoryBytes));
        var descRead = new BigQueryReader(baseLimits, descPool, null).Read("p", "d", [descEntry], true, true)!;
        var clipped = descRead.Facts!.Of(1)?.Description;
        var expectedCharge = IndexMemory.StringBytes(BigQueryIndexLimits.FactChars);
        check(clipped is { Length: BigQueryIndexLimits.FactChars } && clipped.EndsWith('…')
            && descRead.Bytes - plainRead.Bytes == expectedCharge
            && BigQueryEntries.Known(descRead, true)[("bqView", "v")].Detail.Description == clipped,
            "BigQueryReader clips table descriptions to FactChars, charges them to the budget, and preserves them in Known");
        var tightPool = new StringPool(new IndexBudget(baseLimits.MemoryBytes));
        var floor = baseLimits.MemoryBytes - (plainRead.Bytes + plainPoolCost(plainRead)) - (expectedCharge / 2);
        var refusedDesc = new BigQueryReader(baseLimits, tightPool, null, namesFloor: 0, detailsFloor: floor).Read("p", "d", [descEntry], true, true);
        check(refusedDesc is null && tightPool.Budget.Used == 0,
            "a table description is charged above detailsFloor and returns all bytes to the budget when refused");
        static long plainPoolCost(DatabaseIndex index) => index.Pooled.Sum(StringPool.Cost);

        // Surrogate-safe clipping in BigQueryReader.Clip when a surrogate pair straddles FactChars - 2..FactChars - 1.
        var surrogateDetail = BigQueryEntries.FromTable(new Google.Apis.Bigquery.v2.Data.Table { Type = "TABLE", Description = new string('a', 1022) + "🚀" + "bbb" });
        var surrogatePool = new StringPool(new IndexBudget(baseLimits.MemoryBytes));
        var surrogateRead = new BigQueryReader(baseLimits, surrogatePool, null).Read("p", "d", [new BigQueryEntry("bqTable", "bqTables", null, "surrogate_tbl", 1, null, Detail: surrogateDetail)], true, true)!;
        var surrogateClipped = surrogateRead.Facts!.Of(1)?.Description;
        var surrogateJson = System.Text.Json.JsonSerializer.Serialize(surrogateClipped);
        check(surrogateClipped == new string('a', 1022) + "…" && !char.IsHighSurrogate(surrogateClipped[^2])
            && !surrogateJson.Contains('\uFFFD') && !surrogateJson.Contains("\\uFFFD", StringComparison.OrdinalIgnoreCase),
            "BigQueryReader.Clip backs off before a straddling surrogate pair and produces valid UTF-16 JSON");

        // EditorLookup SafeCount bounds: Rows and Bytes are preserved up to MaxSafeInteger and omitted as null above it or when negative.
        var safeMax = Varia.Backend.BigQuery.BigQueryLimits.MaxSafeInteger;
        var countsPool = new StringPool(new IndexBudget(baseLimits.MemoryBytes));
        var countsRead = new BigQueryReader(baseLimits, countsPool, null).Read("p", "d",
        [
            new("bqTable", "bqTables", null, "t_safe", 1, null, Detail: new BigQueryDetail(null, null, null, [], safeMax, safeMax)),
            new("bqTable", "bqTables", null, "t_over", 1, null, Detail: new BigQueryDetail(null, null, null, [], safeMax + 1, safeMax + 1)),
            new("bqTable", "bqTables", null, "t_max", 1, null, Detail: BigQueryEntries.FromTable(new Google.Apis.Bigquery.v2.Data.Table { Type = "TABLE", NumRows = (ulong)long.MaxValue, NumBytes = long.MaxValue })),
            new("bqTable", "bqTables", null, "t_neg", 1, null, Detail: new BigQueryDetail(null, null, null, [], -1L, -1L))
        ], true, true)!;
        var countsLookup = new BigQueryLookup("p", [], [countsRead], [], [], building: false, built: true, new IndexBudget(1 << 20));
        var countsRes = EditorLookup.Answer(countsLookup, new LanguageLookupArgs(id,
        [
            new(["p", "d"]),
            new(["p", "d", "t_safe"]),
            new(["p", "d", "t_over"]),
            new(["p", "d", "t_max"]),
            new(["p", "d", "t_neg"])
        ]));
        var case2Items = countsRes.Answers[0].Items.ToDictionary(item => item.Name);
        check(countsRead.Facts!.Of(3)?.Rows == long.MaxValue && countsRead.Facts!.Of(3)?.Bytes == long.MaxValue,
            "BigQueryEntries.FromTable and BigQueryObjectFacts continue storing counts up to long.MaxValue");
        check(case2Items["t_safe"] is { Rows: 9_007_199_254_740_991L, Bytes: 9_007_199_254_740_991L }
            && case2Items["t_over"] is { Rows: null, Bytes: null }
            && case2Items["t_max"] is { Rows: null, Bytes: null }
            && case2Items["t_neg"] is { Rows: null, Bytes: null },
            "EditorLookup case 2 preserves Rows/Bytes up to MaxSafeInteger and omits counts above MaxSafeInteger or below 0");
        check(countsRes.Answers[1].Object is { Rows: 9_007_199_254_740_991L, Bytes: 9_007_199_254_740_991L }
            && countsRes.Answers[2].Object is { Rows: null, Bytes: null }
            && countsRes.Answers[3].Object is { Rows: null, Bytes: null }
            && countsRes.Answers[4].Object is { Rows: null, Bytes: null },
            "EditorLookup case 3 preserves Rows/Bytes up to MaxSafeInteger and omits counts above MaxSafeInteger or below 0");

        var missing = (await Lookup(PathRequest("varia-alpha", "sales", "nothing"), PathRequest("varia-alpha", "nothing", "t"))).Answers;
        check(missing[0] is { State: "ready", Object: null, Path: ["varia-alpha", "sales"] } && missing[1] is { State: "absent", Object: null },
            "an object the dataset does not hold has no answer object, and a dataset the index does not hold is absent");

        async Task<string> Refused(JsonObject args) => (await harness.Call("language.lookup", args)).Code;
        var tooDeep = await Refused(LookupArgs(id, PathRequest("a", "b", "c", "d")));
        var tooMany = await Refused(LookupArgs(id, [.. Enumerable.Range(0, EditorLookupLimits.Requests + 1).Select(_ => PathRequest())]));
        var exactWithout = await Refused(LookupArgs(id, new JsonObject { ["path"] = new JsonArray(), ["exact"] = true }));
        var emptyPart = await Refused(LookupArgs(id, PathRequest("")));
        var longPrefix = await Refused(LookupArgs(id, new JsonObject { ["path"] = new JsonArray(), ["prefix"] = new string('x', EditorLookupLimits.PrefixChars + 1) }));
        var sqlServer = await Refused(LookupArgs(Guid.NewGuid().ToString(), PathRequest()));
        check(tooDeep == "INVALID_PARAMS" && tooMany == "INVALID_PARAMS" && exactWithout == "INVALID_PARAMS" && emptyPart == "INVALID_PARAMS" && longPrefix == "INVALID_PARAMS" && sqlServer == "UNSUPPORTED_PROVIDER",
            $"the request is bounded (path depth, requests, prefix length, exact needs a prefix) and a handle BigQuery does not own is refused: {tooDeep} {tooMany} {exactWithout} {emptyPart} {longPrefix} {sqlServer}");
        var lane = harness.Service.LaneOf("language.lookup");
        check(lane == Varia.Backend.Protocol.RequestLane.Metadata, "language.lookup runs on the metadata lane: " + lane);

        // 5,000-project O(1) ProjectState & EditorLookup.One scaling with 50,000 datasetSkips and 256 skips.
        var largeExtras = Enumerable.Range(1, 4999).Select(i => $"proj-{i:D4}").ToList();
        var largePool = new StringPool(new IndexBudget(16 << 20));
        var largeReader = new BigQueryReader(baseLimits, largePool, null);
        var heldProj2 = largeReader.Read("proj-0002", "ds_held", [], false, false)!;
        var heldProj3 = largeReader.Read("proj-0003", "ds_held", [], false, false)!;
        var largeDatasetSkips = new Dictionary<(string Project, string Dataset), ObjectIndexSkip>();
        for (var p = 3000; p < 5000; p++)
            for (var d = 0; d < 25; d++)
                largeDatasetSkips[($"proj-{p:D4}", $"ds_{d:D2}")] = new($"ds_{d:D2}", "PERMISSION_DENIED", "x", Project: $"proj-{p:D4}");
        largeDatasetSkips[("proj-0002", "ds_held")] = new("ds_held", "TIMEOUT", "x", Project: "proj-0002");
        largeDatasetSkips[("proj-0003", "ds_unread")] = new("ds_unread", "TIMEOUT", "x", Project: "proj-0003");
        var largeSkips = Enumerable.Range(0, 256).Select(i => new ObjectIndexSkip($"skip_{i}", "PERMISSION_DENIED", "x", Project: $"proj-{2500 + i:D4}")).ToList();
        var largeLookup = new BigQueryLookup("proj-0000", largeExtras, [heldProj2, heldProj3], null, largeSkips,
            building: false, built: true, new IndexBudget(16 << 20), partialProjects: ["proj-0004"],
            projectListingSkips: new Dictionary<string, ObjectIndexSkip>(StringComparer.Ordinal) { ["proj-0005"] = new("", "API_DISABLED", "x", Project: "proj-0005") },
            datasetSkips: largeDatasetSkips);
        // Warm JIT before timing the 5,000-project case 0 lookup.
        _ = EditorLookup.Answer(largeLookup, new LanguageLookupArgs(id, [new([], Limit: 500)]));
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var page1 = EditorLookup.Answer(largeLookup, new LanguageLookupArgs(id, [new([], Limit: 2000)]));
        var allStatesOk = true;
        for (var i = 0; i < largeLookup.Projects.Count; i++)
        {
            var p = largeLookup.Projects[i];
            var expected = i == 2 ? LookupState.Ready
                : i == 3 || i == 4 || (i >= 2500 && i < 2756) || i >= 3000 ? LookupState.Partial
                : i == 5 ? LookupState.Skipped
                : LookupState.Ready;
            if (largeLookup.ProjectState(p) != expected) { allStatesOk = false; break; }
        }
        watch.Stop();
        check(allStatesOk && page1.Answers[0].Items.Count == 2000 && page1.Answers[0].Items[0].Partial is null
            && page1.Answers[0].Items[2].Partial is null && page1.Answers[0].Items[3].Partial == true && page1.Answers[0].Items[4].Partial == true
            && watch.ElapsedMilliseconds < 1000,
            $"5,000-project ProjectState and EditorLookup case 0 stay O(1) across 50,000 datasetSkips and 256 skips ({watch.ElapsedMilliseconds} ms)");

        // Max-width 4,000-item case 2 details: true batch with shards and 3-byte UTF-8 strings stops cleanly with truncated: true below ProtocolLimits.ResponseBody.
        var widePool = new StringPool(new IndexBudget(64 << 20));
        var wideLimits = new ObjectIndexLimits { MemoryBytes = 64 << 20, NamesReserveBytes = 0 };
        var wideReader = new BigQueryReader(wideLimits, widePool, null);
        var partText = new string('あ', BigQueryIndexLimits.FactChars);
        var clustText = new string('い', BigQueryIndexLimits.FactChars);
        var sigText = new string('う', BigQueryIndexLimits.FactChars);
        var descText = new string('え', BigQueryIndexLimits.FactChars);
        var namePad = new string('お', 990);
        List<BigQueryEntry> WideEntries(string tag) => [.. Enumerable.Range(0, EditorLookupLimits.Items).Select(i =>
        {
            var prefix = $"{tag}_{i:D4}_{namePad}_";
            return new BigQueryEntry("bqTable", "bqTables", null, $"{prefix}20260102", 1, null,
                Shards: new(prefix, 2, "20260101", "20260102"),
                Detail: new BigQueryDetail(null, null, null, [], Rows: 123, Bytes: 456,
                    Partitioning: partText, Clustering: clustText, Signature: sigText, Description: descText));
        })];
        var d1Read = wideReader.Read("p", "d1", WideEntries("a"), true, true)!;
        var d2Read = wideReader.Read("p", "d2", WideEntries("b"), true, true)!;
        var wideLookup = new BigQueryLookup("p", [], [d1Read, d2Read], null, [], building: false, built: true, new IndexBudget(64 << 20));
        var wideRes = EditorLookup.Answer(wideLookup, new LanguageLookupArgs(id,
        [
            new(["p", "d1"], Limit: EditorLookupLimits.Items, Details: true),
            new(["p", "d2"], Limit: EditorLookupLimits.Items, Details: true)
        ]));
        var wideEncoded = Varia.Backend.Protocol.JsonBridge.Encode(new { Result = wideRes }, HostChecks.Json);
        check(wideRes.Answers[0].Items.Count > 0 && wideRes.Answers[0].Truncated && wideRes.Answers[1].Truncated
            && wideRes.Answers.Sum(answer => answer.Items.Count) < EditorLookupLimits.TotalItems
            && wideEncoded.Length <= Varia.Backend.Protocol.ProtocolLimits.ResponseBody
            && wideEncoded.Length <= EditorLookupLimits.TotalBytes,
            $"EditorLookup byte budget truncates max-width 4,000-item case 2 details:true batches below TotalBytes ({wideEncoded.Length} B)");

        // Worst-case 16-request case 3 details:true batch where request 0 drains 12 MiB still encodes strictly <= EditorLookupLimits.TotalBytes.
        var maxCols = Enumerable.Range(0, EditorLookupLimits.Items).Select(i =>
            new BigQueryColumn($"c_{i:D4}_{new string('あ', 500)}", false, "STRING", true, descText)).ToList();
        var maxProj = new string('p', 900);
        var maxDataset = new string('d', 900);
        var maxTableEntries = Enumerable.Range(0, EditorLookupLimits.Requests).Select(i =>
            new BigQueryEntry("bqTable", "bqTables", null, $"t_{i:D2}_{new string('お', 900)}", 1, null,
                Shards: new($"t_{i:D2}_", 2, "20260101", "20260102"),
                Detail: new BigQueryDetail(null, null, null, maxCols, Rows: 123, Bytes: 456,
                    Partitioning: partText, Clustering: clustText, Signature: sigText, Description: descText))).ToList();
        var case3Pool = new StringPool(new IndexBudget(256 << 20));
        var case3Reader = new BigQueryReader(new ObjectIndexLimits { MemoryBytes = 256 << 20, NamesReserveBytes = 0 }, case3Pool, null);
        var case3Read = case3Reader.Read(maxProj, maxDataset, maxTableEntries, true, true)!;
        var case3Lookup = new BigQueryLookup(maxProj, [], [case3Read], null, [], building: false, built: true, new IndexBudget(256 << 20));
        var case3Requests = maxTableEntries.Select(e => new LanguageLookupPath([maxProj, maxDataset, e.Name], Limit: EditorLookupLimits.Items, Details: true)).ToList();
        var case3Res = EditorLookup.Answer(case3Lookup, new LanguageLookupArgs(id, case3Requests));
        var case3Encoded = Varia.Backend.Protocol.JsonBridge.Encode(new { Result = case3Res }, HostChecks.Json);
        check(case3Res.Answers[0].Object is { Partitioning: not null, Clustering: not null, Signature: not null, Description: not null }
            && case3Res.Answers[0].Items.Count > 0
            && case3Res.Answers.All(a => a.Object is null ? (a.Items.Count == 0 && a.Truncated) : (a.Object.Partitioning is not null && a.Object.Clustering is not null && a.Object.Signature is not null && a.Object.Description is not null))
            && case3Encoded.Length <= EditorLookupLimits.TotalBytes,
            $"EditorLookup 16-request max-width case 3 batch preserves intact objects or omits them with empty items & truncated:true <= TotalBytes ({case3Encoded.Length} B <= {EditorLookupLimits.TotalBytes} B)");

        // When Request 0 leaves availableForObject smaller than full shown (whether in the old compact band or below it),
        // EditorLookup never emits a stripped Object with Truncated:false and never wastes Take on discarded Items.
        var budgetDrainCols = Enumerable.Range(0, EditorLookupLimits.Items).Select(i =>
            new BigQueryColumn($"c_{i:D4}_{new string('あ', 1500)}", false, "STRING", true, descText)).ToList();
        var smallCols = Enumerable.Range(0, 5).Select(i => new BigQueryColumn($"col_{i}", false, "INT64", true, null)).ToList();
        var compactBandEntries = new List<BigQueryEntry>
        {
            new("bqTable", "bqTables", null, "t_drain", 1, null,
                Detail: new BigQueryDetail(null, null, null, budgetDrainCols, Rows: 1, Bytes: 2,
                    Partitioning: partText, Clustering: clustText, Signature: sigText, Description: descText)),
            new("bqTable", "bqTables", null, "t_target", 1, null,
                Detail: new BigQueryDetail(null, null, null, smallCols, Rows: 10, Bytes: 20,
                    Partitioning: partText, Clustering: clustText, Signature: sigText, Description: descText))
        };
        var compactPool = new StringPool(new IndexBudget(64 << 20));
        var compactReader = new BigQueryReader(new ObjectIndexLimits { MemoryBytes = 64 << 20, NamesReserveBytes = 0 }, compactPool, null);
        var compactRead = compactReader.Read("p", "d", compactBandEntries, true, true)!;
        var compactLookup = new BigQueryLookup("p", [], [compactRead], null, [], building: false, built: true, new IndexBudget(64 << 20));
        var compactRes = EditorLookup.Answer(compactLookup, new LanguageLookupArgs(id,
        [
            new(["p", "d", "t_drain"], Limit: EditorLookupLimits.Items, Details: true),
            new(["p", "d", "t_target"], Limit: EditorLookupLimits.Items, Details: true)
        ]));
        check(compactRes.Answers[0].Object is { Description: not null, Partitioning: not null } && compactRes.Answers[0].Items.Count > 0 && compactRes.Answers[0].Truncated
            && compactRes.Answers[1] is { Object: null, Items.Count: 0, Truncated: true },
            "EditorLookup omits Object with Items.Count == 0 and Truncated == true (never stripping Object metadata or emitting discarded Items) when full shown cannot fit");
    }

    static bool wideReadModelCheck(string id, ObjectIndexLimits wideBaseLimits)
    {
        var pool = new StringPool(new IndexBudget(wideBaseLimits.MemoryBytes));
        var read = new BigQueryReader(wideBaseLimits, pool, null).Read("p", "d", [new("bqModel", "bqModels", null, "m", 1, null)], false, false)!;
        read.ChildrenLeftOut = true;
        var namesOnlyLookup = new BigQueryLookup("p", [], [read], ["p"], [], building: false, built: true, new IndexBudget(1 << 20));
        var res = EditorLookup.Answer(namesOnlyLookup, new LanguageLookupArgs(id, [new(["p", "d", "m"]), new(["p", "d"])]));
        return res.Answers[0].Object is { Detailed: false } && res.Answers[1].Items.Single(item => item.Name == "m").Partial == true;
    }
}
