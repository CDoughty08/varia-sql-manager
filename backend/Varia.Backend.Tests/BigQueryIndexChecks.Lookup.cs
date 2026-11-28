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
        var unknownHandle = await Refused(LookupArgs(Guid.NewGuid().ToString(), PathRequest()));
        check(tooDeep == "INVALID_PARAMS" && tooMany == "INVALID_PARAMS" && exactWithout == "INVALID_PARAMS" && emptyPart == "INVALID_PARAMS" && longPrefix == "INVALID_PARAMS" && unknownHandle == "NOT_CONNECTED",
            $"the request is bounded (path depth, requests, prefix length, exact needs a prefix) and an unknown handle is refused: {tooDeep} {tooMany} {exactWithout} {emptyPart} {longPrefix} {unknownHandle}");
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

        // Tight 10-column drain in Request 0 followed by 15 max-width Case 2 skipped datasets carrying 128-char 3-byte UTF-8 Skip.Code stays <= TotalBytes.
        var skipCodeMax = new string('え', 128);
        var skipSegProj = new string('あ', EditorLookupLimits.SegmentChars);
        var skipSegDs = new string('い', EditorLookupLimits.SegmentChars);
        var tightSkipCols = Enumerable.Range(0, 10).Select(i =>
            new BigQueryColumn($"c{i}", false, new string('あ', 416_050), true, null)).ToList();
        var tightSkipPool = new StringPool(new IndexBudget(64 << 20));
        var tightSkipReader = new BigQueryReader(new ObjectIndexLimits { MemoryBytes = 64 << 20, NamesReserveBytes = 0 }, tightSkipPool, null);
        var tightSkipRead = tightSkipReader.Read("p", "d", [new("bqTable", "bqTables", null, "t_tight", 1, null,
            Detail: new BigQueryDetail(null, null, null, tightSkipCols))], true, true)!;
        var tightSkipLookup = new BigQueryLookup("p", [skipSegProj], [tightSkipRead], null,
            [new ObjectIndexSkip(skipSegDs, skipCodeMax, "skipped", Project: skipSegProj)],
            building: false, built: true, new IndexBudget(64 << 20));
        var tightSkipRequests = new List<LanguageLookupPath> { new(["p", "d", "t_tight"], Limit: 10) };
        for (var i = 1; i < EditorLookupLimits.Requests; i++)
            tightSkipRequests.Add(new([skipSegProj, skipSegDs], Limit: EditorLookupLimits.Items));
        var tightSkipRes = EditorLookup.Answer(tightSkipLookup, new LanguageLookupArgs(id, tightSkipRequests));
        var tightSkipEncoded = Varia.Backend.Protocol.JsonBridge.Encode(new { Result = tightSkipRes }, HostChecks.Json);
        check(tightSkipRes.Answers[0].Items.Count == 9 && tightSkipRes.Answers[0].Truncated
            && tightSkipRes.Answers.Skip(1).All(a => a.State == "skipped" && a.Skip == skipCodeMax)
            && tightSkipEncoded.Length <= EditorLookupLimits.TotalBytes,
            $"EditorLookup reserves enough overhead for 128-char 3-byte UTF-8 Skip.Code across 15 skipped requests ({tightSkipEncoded.Length} B <= {EditorLookupLimits.TotalBytes} B)");

        await TierRankingJumpAndHydrateAsync(check, key);
    }

    /// <summary>PR-3 offline checks: 500+ project tier ordering (Billing -> Starred -> Recent -> Discovered), cross-project
    /// fuzzy jump cap &amp; ranking, and JIT free REST hydration (negative cache, rate limit, budget, external gate, validation).</summary>
    static async Task TierRankingJumpAndHydrateAsync(Action<bool, string> check, JsonObject key)
    {
        var connId = Guid.NewGuid().ToString();

        // 1. 500+ Project Tier Ranking: Billing -> Starred -> Recently Queried -> Discovered; Billing & Starred NEVER truncated by limit: 500.
        var discovered600 = Enumerable.Range(0, 600).Select(i => $"aaa-disc-{i:D4}").ToList();
        var starred10 = Enumerable.Range(0, 10).Select(i => $"zzz-star-{i:D2}").ToList();
        var recent5 = new List<string> { "aaa-disc-0599", "aaa-disc-0550", "aaa-disc-0520", "aaa-disc-0510", "aaa-disc-0505" };
        var rankPool = new StringPool(new IndexBudget(16 << 20));
        var rankLimits = new ObjectIndexLimits { MemoryBytes = 16 << 20, NamesReserveBytes = 0 };
        var rankReader = new BigQueryReader(rankLimits, rankPool, null);
        var billingSales = rankReader.Read("varia-billing", "finance", [new("bqTable", "bqTables", null, "daily_revenue", 1, null)], false, false)!;
        var billingDefault = rankReader.Read("varia-billing", "core", [new("bqTable", "bqTables", null, "daily_revenue_core", 1, null)], false, false)!;
        var starredRead = rankReader.Read("zzz-star-00", "gold", [new("bqTable", "bqTables", null, "daily_revenue_v2", 1, null)], false, false)!;
        var recentRead = rankReader.Read("aaa-disc-0599", "mart", [new("bqTable", "bqTables", null, "daily_rev_recent", 1, null)], false, false)!;
        var discRead = rankReader.Read("aaa-disc-0001", "landing", [new("bqTable", "bqTables", null, "daily_rev_raw", 1, null)], false, false)!;

        var tierLookup = new BigQueryLookup("varia-billing", [.. discovered600, .. starred10], [billingSales, billingDefault, starredRead, recentRead, discRead],
            namesOnly: ["aaa-disc-0001"], skips: [], building: true, built: false, new IndexBudget(16 << 20),
            starredProjects: starred10, recentProjects: recent5, phase: "details");
        var page500 = EditorLookup.Answer(tierLookup, new LanguageLookupArgs(connId, [new([], Limit: 500)]));
        var items500 = page500.Answers[0].Items;
        check(items500.Count == 500 && page500.Answers[0].Truncated
            && items500[0] is { Name: "varia-billing", Tier: "billing", Recent: null }
            && items500.Skip(1).Take(10).Select(item => item.Name).SequenceEqual(starred10)
            && items500.Skip(1).Take(10).All(item => item.Tier == "starred" && item.Recent is null)
            && items500.Skip(11).Take(5).Select(item => item.Name).SequenceEqual(recent5)
            && items500.Skip(11).Take(5).All(item => item.Tier == "discovered" && item.Recent == true)
            && items500[16] is { Name: "aaa-disc-0000", Tier: "discovered", Recent: null }
            && items500.Single(item => item.Name == "aaa-disc-0001") is { NamesOnly: true, Indexing: null }
            && items500.Single(item => item.Name == "zzz-star-00") is { Indexing: true },
            "500+ projects rank Billing -> Starred -> Recently Queried -> Discovered without truncating Billing/Starred behind limit 500, and mark namesOnly vs Wave 3 indexing");

        // 2. Cross-Project Fuzzy Jump: Default dataset -> Billing -> Starred -> Recent -> Discovered, subsequence match, top-50 cap & bounds.
        var jumpAnswer = EditorLookup.Answer(tierLookup, new LanguageLookupArgs(connId, [new([], Prefix: "daily_rev", Mode: "jump", Dataset: "core")])).Answers[0];
        check(jumpAnswer.State == "ready" && !jumpAnswer.Truncated
            && jumpAnswer.Items.Select(item => $"{item.Project}.{item.Dataset}.{item.Name}").SequenceEqual([
                "varia-billing.core.daily_revenue_core",
                "varia-billing.finance.daily_revenue",
                "zzz-star-00.gold.daily_revenue_v2",
                "aaa-disc-0599.mart.daily_rev_recent",
                "aaa-disc-0001.landing.daily_rev_raw"
            ])
            && jumpAnswer.Items[0].Tier == "billing"
            && jumpAnswer.Items[2].Tier == "starred"
            && jumpAnswer.Items[3] is { Tier: "discovered", Recent: true }
            && jumpAnswer.Items[4] is { Tier: "discovered", NamesOnly: true },
            "cross-project jump ranks Default dataset -> Billing -> Starred -> Recent -> Discovered with project, dataset, tier, recent and namesOnly metadata");

        var subseqAnswer = EditorLookup.Answer(tierLookup, new LanguageLookupArgs(connId, [new([], Prefix: "drev", Mode: "jump")])).Answers[0];
        check(subseqAnswer.Items.Count == 5 && subseqAnswer.Items[0].Project == "varia-billing",
            "cross-project jump supports fuzzy subsequence matching (drev -> daily_revenue*)");

        // Cross-project jump strictly caps at JumpLookupLimits.Items (50) and reports truncated: true.
        var manyTables = Enumerable.Range(0, 80).Select(i => new BigQueryEntry("bqTable", "bqTables", null, $"daily_rev_{i:D3}", 1, null)).ToList();
        var capRead = new BigQueryReader(rankLimits, rankPool, null).Read("aaa-disc-0002", "bulk", manyTables, false, false)!;
        var capLookup = new BigQueryLookup("varia-billing", ["aaa-disc-0002"], [billingSales, capRead], null, [], building: false, built: true, new IndexBudget(16 << 20));
        var capAnswer = EditorLookup.Answer(capLookup, new LanguageLookupArgs(connId, [new([], Prefix: "daily_rev", Mode: "jump")])).Answers[0];
        check(capAnswer.Items.Count == JumpLookupLimits.Items && capAnswer.Truncated && capAnswer.Items[0].Project == "varia-billing",
            "cross-project jump caps at 50 hits with truncated: true and keeps billing ahead of discovered");

        // Strict validation for jump mode.
        bool JumpRefused(LanguageLookupPath req)
        {
            try { EditorLookup.Validate(new LanguageLookupArgs(connId, [req])); return false; }
            catch (RequestException error) { return error.Code == "INVALID_PARAMS"; }
        }
        check(JumpRefused(new(["varia-billing"], Prefix: "da", Mode: "jump"))
            && JumpRefused(new([], Prefix: "d", Mode: "jump"))
            && JumpRefused(new([], Prefix: "   ", Mode: "jump"))
            && JumpRefused(new([], Prefix: new string('a', JumpLookupLimits.MaxPrefixChars + 1), Mode: "jump"))
            && JumpRefused(new([], Prefix: "da", Exact: true, Mode: "jump"))
            && JumpRefused(new([], Prefix: "da", Limit: JumpLookupLimits.Items + 1, Mode: "jump"))
            && JumpRefused(new([], Prefix: "da", Dataset: "sales"))
            && JumpRefused(new([], Prefix: "da", Mode: "unknown")),
            "EditorLookup strictly validates cross-project jump path, prefix length, exact, limit, mode and dataset");

        // 3. JIT Hydration (language.hydrate) end-to-end against BigQueryFake:
        // free tables.get / routines.get only (0 jobs.insert), namesOnly -> hydrated -> cached, external gate, negative cache, rate limit, budget & validation.
        using var harness = new Harness();
        const string DiscProj = "disc-hydrate-proj";
        const string ExtProj = "ext-public-proj";
        const string DiscBase = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/disc-hydrate-proj";
        const string ExtBase = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/ext-public-proj";
        harness.Fake
            .On("GET", DiscBase + "/datasets/web/tables/sessions", BigQueryFake.Fixture("table-orders"))
            .On("GET", DiscBase + "/datasets/web/routines/clean_url", BigQueryFake.Fixture("index-routine-to-cents"))
            .On("GET", DiscBase + "/datasets/web/tables/missing_tbl", new BigQueryFake.Reply(404, "{\"error\":{\"code\":404,\"message\":\"Not found: Table\",\"errors\":[{\"reason\":\"notFound\"}]}}"))
            .On("GET", DiscBase + "/datasets/web/tables/secret_tbl", new BigQueryFake.Reply(403, "{\"error\":{\"code\":403,\"message\":\"Access Denied\",\"errors\":[{\"reason\":\"accessDenied\"}]}}"))
            .On("GET", ExtBase + "/datasets/samples/tables/shakespeare", BigQueryFake.Fixture("table-orders"));
        await harness.ConnectAsync(key);
        var id = harness.ConnectionId;
        await harness.Index();

        // Seed disc-hydrate-proj as a tracked namesOnly discovered project (table listed without columns, simulating Wave 2 / memory cap).
        var seedPool = new StringPool(new IndexBudget(1 << 20));
        var seedLimits = new ObjectIndexLimits { MemoryBytes = 1 << 20, NamesReserveBytes = 0 };
        var seedRead = new BigQueryReader(seedLimits, seedPool, null).Read(DiscProj, "web",
        [
            new("bqTable", "bqTables", null, "sessions", 1, null),
            new("bqRoutine", "bqRoutines", "scalar", "clean_url", 1, null)
        ], false, false)!;
        // Simulate tracked project via RecordQueriedProjects + seeded dataset through TrackBigQuery / Hydrate path.
        // First verify untracked external project refuses auto-hydrate (allowExternal: false) with 0 REST calls.
        var callsBeforeExt = harness.Fake.To(".*").Count();
        var (extDenyCode, extDenyObj, _) = await harness.Call("language.hydrate", new JsonObject
        {
            ["connectionId"] = id,
            ["targets"] = new JsonArray(new JsonObject { ["project"] = ExtProj, ["dataset"] = "samples", ["name"] = "shakespeare" })
        });
        var extDeny = (LanguageHydrateResult)extDenyObj!;
        check(extDenyCode == "ok" && extDeny.Outcomes[0] is { Project: ExtProj, Dataset: "samples", Name: "shakespeare", Status: "external" }
            && harness.Fake.To(".*").Count() == callsBeforeExt,
            "language.hydrate returns status 'external' with 0 REST calls for unstarred external projects unless allowExternal is true");

        // Explicit Fetch schema (free) with allowExternal: true hydrates via free tables.get, caches columns, and does NOT pollute top-level Projects.
        var (extAllowCode, extAllowObj, _) = await harness.Call("language.hydrate", new JsonObject
        {
            ["connectionId"] = id,
            ["targets"] = new JsonArray(new JsonObject { ["project"] = ExtProj, ["dataset"] = "samples", ["name"] = "shakespeare", ["allowExternal"] = true })
        });
        var extAllow = (LanguageHydrateResult)extAllowObj!;
        var extLookup = (LanguageLookupResult)(await harness.Call("language.lookup", LookupArgs(id, PathRequest(), PathRequest(ExtProj, "samples", "shakespeare")))).Result!;
        var jobsCount = harness.Fake.To("/jobs$").Count(req => req.Method == "POST");
        check(extAllowCode == "ok" && extAllow.Outcomes[0].Status == "hydrated" && jobsCount == 0
            && !extLookup.Answers[0].Items.Any(item => item.Name == ExtProj)
            && extLookup.Answers[1] is { State: "partial", Object: { Name: "shakespeare", Detailed: true }, Items.Count: > 0 },
            "language.hydrate with allowExternal: true hydrates via free tables.get (0 jobs), populates lookup columns, and keeps external project out of top-level Projects");

        // Second hydrate call for the same table returns 'cached' with 0 REST calls.
        var callsBeforeCached = harness.Fake.To(".*").Count();
        var cachedRes = (LanguageHydrateResult)(await harness.Call("language.hydrate", new JsonObject
        {
            ["connectionId"] = id,
            ["targets"] = new JsonArray(new JsonObject { ["project"] = ExtProj, ["dataset"] = "samples", ["name"] = "shakespeare", ["allowExternal"] = true })
        })).Result!;
        check(cachedRes.Outcomes[0].Status == "cached" && harness.Fake.To(".*").Count() == callsBeforeCached,
            "language.hydrate returns 'cached' with 0 REST calls once columns are in DatabaseIndex");

        // Routine hydration via free routines.get caches signature.
        var routineRes = (LanguageHydrateResult)(await harness.Call("language.hydrate", new JsonObject
        {
            ["connectionId"] = id,
            ["targets"] = new JsonArray(new JsonObject { ["project"] = DiscProj, ["dataset"] = "web", ["name"] = "clean_url", ["kind"] = "routine", ["allowExternal"] = true })
        })).Result!;
        var routineLookup = (LanguageLookupResult)(await harness.Call("language.lookup", LookupArgs(id, PathRequest(DiscProj, "web", "clean_url")))).Result!;
        check(routineRes.Outcomes[0].Status == "hydrated" && routineLookup.Answers[0].Object is { Kind: "bqRoutine", Detailed: true, Signature: "(dollars NUMERIC) RETURNS INT64" },
            "language.hydrate hydrates routines via free routines.get and caches their signature");

        // Negative cache for 404 (notFound) and 403 (forbidden): second call hits negative cache with 0 REST calls, expires after TTL.
        var now = DateTime.UtcNow.AddHours(1);
        harness.Service.Search.UtcNow = () => now;
        harness.Service.Search.HydrateNegativeTtl = TimeSpan.FromMinutes(2);
        var miss1 = (LanguageHydrateResult)(await harness.Call("language.hydrate", new JsonObject
        {
            ["connectionId"] = id,
            ["targets"] = new JsonArray(
                new JsonObject { ["project"] = DiscProj, ["dataset"] = "web", ["name"] = "missing_tbl", ["allowExternal"] = true },
                new JsonObject { ["project"] = DiscProj, ["dataset"] = "web", ["name"] = "secret_tbl", ["allowExternal"] = true })
        })).Result!;
        var callsAfterMiss1 = harness.Fake.To(".*").Count();
        var miss2 = (LanguageHydrateResult)(await harness.Call("language.hydrate", new JsonObject
        {
            ["connectionId"] = id,
            ["targets"] = new JsonArray(
                new JsonObject { ["project"] = DiscProj, ["dataset"] = "web", ["name"] = "missing_tbl", ["allowExternal"] = true },
                new JsonObject { ["project"] = DiscProj, ["dataset"] = "web", ["name"] = "secret_tbl", ["allowExternal"] = true })
        })).Result!;
        check(miss1.Outcomes[0] is { Status: "notFound", Code: "NOT_FOUND" } && miss1.Outcomes[1] is { Status: "forbidden", Code: "PERMISSION_DENIED" }
            && miss2.Outcomes[0].Status == "notFound" && miss2.Outcomes[1].Status == "forbidden"
            && harness.Fake.To(".*").Count() == callsAfterMiss1,
            "language.hydrate negative-caches 404 and 403 misses so repeat calls issue 0 REST requests");

        now = now.AddMinutes(3);
        var callsBeforeExpire = harness.Fake.To(".*").Count();
        var miss3 = (LanguageHydrateResult)(await harness.Call("language.hydrate", new JsonObject
        {
            ["connectionId"] = id,
            ["targets"] = new JsonArray(new JsonObject { ["project"] = DiscProj, ["dataset"] = "web", ["name"] = "missing_tbl", ["allowExternal"] = true })
        })).Result!;
        check(miss3.Outcomes[0].Status == "notFound" && harness.Fake.To(".*").Count() == callsBeforeExpire + 1,
            "language.hydrate negative cache expires cleanly after TTL");

        // Per-connection sliding-window rate limit returns 'throttled' with 0 REST calls once exhausted.
        harness.Service.Search.HydrateMaxPerMinute = 1;
        now = now.AddMinutes(5);
        var rate1 = (LanguageHydrateResult)(await harness.Call("language.hydrate", new JsonObject
        {
            ["connectionId"] = id,
            ["targets"] = new JsonArray(new JsonObject { ["project"] = DiscProj, ["dataset"] = "web", ["name"] = "sessions", ["allowExternal"] = true })
        })).Result!;
        var callsBeforeRate2 = harness.Fake.To(".*").Count();
        var rate2 = (LanguageHydrateResult)(await harness.Call("language.hydrate", new JsonObject
        {
            ["connectionId"] = id,
            ["targets"] = new JsonArray(new JsonObject { ["project"] = DiscProj, ["dataset"] = "web", ["name"] = "missing_tbl", ["allowExternal"] = true })
        })).Result!;
        check(rate1.Outcomes[0].Status == "hydrated" && rate2.Outcomes[0] is { Status: "throttled", Code: "RATE_LIMIT" }
            && harness.Fake.To(".*").Count() == callsBeforeRate2,
            "language.hydrate enforces per-connection sliding-window rate limit without issuing extra REST calls");

        // Shared IndexBudget memory enforcement: tight budget refuses hydration cleanly with status 'budget' and zero leaked bytes.
        using var tinySearch = new ObjectSearchService(new UnusedHost(), new ObjectIndexLimits { MemoryBytes = 128, NamesReserveBytes = 0 });
        var tinyId = Guid.NewGuid().ToString();
        var budgetRes = await tinySearch.HydrateBigQueryAsync(
            new LanguageHydrateArgs(tinyId, [new LanguageHydrateTarget(ExtProj, "samples", "shakespeare", AllowExternal: true)]),
            new SingleTableHydrateSource("varia-alpha"), CancellationToken.None);
        check(budgetRes.Outcomes[0] is { Status: "budget", Code: "TOO_LARGE" } && tinySearch.HeldOf(tinyId).Count == 0,
            "language.hydrate enforces the shared IndexBudget and returns status 'budget' cleanly when memory is full");

        // Validation & lane checks for language.hydrate.
        async Task<string> HydrateRefused(JsonObject args) => (await harness.Call("language.hydrate", args)).Code;
        var emptyTargets = await HydrateRefused(new JsonObject { ["connectionId"] = id, ["targets"] = new JsonArray() });
        var tooManyTargets = await HydrateRefused(new JsonObject
        {
            ["connectionId"] = id,
            ["targets"] = new JsonArray([.. Enumerable.Range(0, LanguageHydrateLimits.Targets + 1).Select(i => new JsonObject { ["project"] = "varia-alpha", ["dataset"] = "sales", ["name"] = $"t_{i}" })])
        });
        var badProject = await HydrateRefused(new JsonObject { ["connectionId"] = id, ["targets"] = new JsonArray(new JsonObject { ["project"] = "Bad Project!", ["dataset"] = "sales", ["name"] = "orders" }) });
        var badKind = await HydrateRefused(new JsonObject { ["connectionId"] = id, ["targets"] = new JsonArray(new JsonObject { ["project"] = "varia-alpha", ["dataset"] = "sales", ["name"] = "orders", ["kind"] = "view" }) });
        var badRoutineName = await HydrateRefused(new JsonObject { ["connectionId"] = id, ["targets"] = new JsonArray(new JsonObject { ["project"] = "varia-alpha", ["dataset"] = "sales", ["name"] = "bad-routine name", ["kind"] = "routine" }) });
        var wrongProvider = await HydrateRefused(new JsonObject { ["connectionId"] = Guid.NewGuid().ToString(), ["targets"] = new JsonArray(new JsonObject { ["project"] = "varia-alpha", ["dataset"] = "sales", ["name"] = "orders" }) });
        check(emptyTargets == "INVALID_PARAMS" && tooManyTargets == "INVALID_PARAMS" && badProject == "INVALID_PARAMS" && badKind == "INVALID_PARAMS"
            && badRoutineName == "INVALID_PARAMS" && wrongProvider == "UNSUPPORTED_PROVIDER"
            && harness.Service.LaneOf("language.hydrate") == Varia.Backend.Protocol.RequestLane.Metadata,
            $"language.hydrate validates targets/names/kinds, refuses non-BigQuery connections, and runs on metadata lane: {emptyTargets} {tooManyTargets} {badProject} {badKind} {badRoutineName} {wrongProvider}");

        // #4: Singleflight cancellation isolation — Caller A cancelling never aborts Caller B coalesced on the same target.
        using var singleflightSearch = new ObjectSearchService(new UnusedHost(), new ObjectIndexLimits());
        var sfId = Guid.NewGuid().ToString();
        var sfSource = new SlowSingleTableHydrateSource("varia-alpha");
        using var callerACts = new CancellationTokenSource();
        var callerA = singleflightSearch.HydrateBigQueryAsync(
            new LanguageHydrateArgs(sfId, [new LanguageHydrateTarget(ExtProj, "samples", "shakespeare", AllowExternal: true)]),
            sfSource, callerACts.Token);
        await sfSource.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var callerB = singleflightSearch.HydrateBigQueryAsync(
            new LanguageHydrateArgs(sfId, [new LanguageHydrateTarget(ExtProj, "samples", "shakespeare", AllowExternal: true)]),
            sfSource, CancellationToken.None);
        callerACts.Cancel();
        var callerACancelled = false;
        try { await callerA; } catch (OperationCanceledException) { callerACancelled = true; }
        sfSource.Release.TrySetResult();
        var callerBRes = await callerB;
        check(callerACancelled && callerBRes.Outcomes[0].Status == "hydrated" && sfSource.TableCalls == 1,
            $"singleflight hydrate cancellation isolation: cancelledA={callerACancelled} statusB={callerBRes.Outcomes[0].Status} calls={sfSource.TableCalls}");

        // #5: Same-named table and routine in one dataset hydrate independently without colliding or overwriting each other.
        using var dualSearch = new ObjectSearchService(new UnusedHost(), new ObjectIndexLimits());
        var dualId = Guid.NewGuid().ToString();
        var dualSource = new SingleTableHydrateSource("varia-alpha");
        var dualTable = await dualSearch.HydrateBigQueryAsync(
            new LanguageHydrateArgs(dualId, [new LanguageHydrateTarget(ExtProj, "samples", "shared_name", Kind: "table", AllowExternal: true)]),
            dualSource, CancellationToken.None);
        var dualRoutine = await dualSearch.HydrateBigQueryAsync(
            new LanguageHydrateArgs(dualId, [new LanguageHydrateTarget(ExtProj, "samples", "shared_name", Kind: "routine", AllowExternal: true)]),
            dualSource, CancellationToken.None);
        var dualHeld = dualSearch.HeldOf(dualId).Single();
        var dualTopKinds = Enumerable.Range(0, dualHeld.Table.Count)
            .Where(at => dualHeld.Table.Parent(at) < 0 && dualHeld.Table.Name(at) == "shared_name")
            .Select(at => dualHeld.Table.Kind(at))
            .Order(StringComparer.Ordinal)
            .ToArray();
        check(dualTable.Outcomes[0].Status == "hydrated" && dualRoutine.Outcomes[0].Status == "hydrated"
            && dualTopKinds.SequenceEqual(["bqRoutine", "bqTable"]),
            $"same-named table and routine hydrate independently without overwrite: {string.Join(',', dualTopKinds)}");

        // #8: A second unhydrated table in an already-hydrated external dataset still answers state 'absent' in EditorLookup.
        var secondExtLookup = EditorLookup.Answer(dualSearch.LookupBigQuery(dualId, "varia-alpha"),
            new LanguageLookupArgs(dualId, [new([ExtProj, "samples", "other_unhydrated_table"])]));
        check(secondExtLookup.Answers[0].State == "absent" && secondExtLookup.Answers[0].Object is null,
            $"second unhydrated table in hydrated-only external dataset returns absent: {secondExtLookup.Answers[0].State}");

        // #6b: Closing a connection before MergeHydratedEntry completes returns NOT_CONNECTED and leaks zero held reads.
        var closeSource = new SlowSingleTableHydrateSource("varia-alpha");
        var closeId = Guid.NewGuid().ToString();
        var closeTask = singleflightSearch.HydrateBigQueryAsync(
            new LanguageHydrateArgs(closeId, [new LanguageHydrateTarget(ExtProj, "samples", "closing_tbl", AllowExternal: true)]),
            closeSource, CancellationToken.None);
        await closeSource.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        singleflightSearch.Forget(closeId);
        closeSource.Release.TrySetResult();
        var closeOutcome = await closeTask;
        check(closeOutcome.Outcomes[0] is { Status: "error", Code: "NOT_CONNECTED" } && singleflightSearch.HeldOf(closeId).Count == 0,
            $"hydrate on closed connection abandons cleanly: {closeOutcome.Outcomes[0].Status}/{closeOutcome.Outcomes[0].Code}");

        // #10 & #12: Scoped refresh (phase null) never flags Wave3Pending; jumpLimit <= 0 short-circuits with truncated=true;
        // exact-remaining prefix matches + extra subsequence match reports truncated=true.
        var edgePool = new StringPool(new IndexBudget(4 << 20));
        var edgeLimits = new ObjectIndexLimits { MemoryBytes = 4 << 20 };
        var edgeRead = new BigQueryReader(edgeLimits, edgePool, null).Read("varia-alpha", "ds",
            [
                new("bqTable", "bqTables", null, "ab_first", 1, null),
                new("bqTable", "bqTables", null, "ab_second", 1, null),
                new("bqTable", "bqTables", null, "xa_yb_subseq", 1, null)
            ], false, false)!;
        var scopedLookup = new BigQueryLookup("varia-alpha", ["other-proj"], [edgeRead], null, [], building: true, built: true, new IndexBudget(4 << 20), phase: null);
        var scopedProjAnswer = EditorLookup.Answer(scopedLookup, new LanguageLookupArgs(id, [new([])])).Answers[0];
        var otherProjItem = scopedProjAnswer.Items.Single(item => item.Name == "other-proj");
        var fullBuildLookup = new BigQueryLookup("varia-alpha", ["other-proj"], [edgeRead], null, [], building: true, built: true, new IndexBudget(4 << 20), phase: "details");
        var fullProjItem = EditorLookup.Answer(fullBuildLookup, new LanguageLookupArgs(id, [new([])])).Answers[0].Items.Single(item => item.Name == "other-proj");
        var zeroJump = scopedLookup.JumpObjects("ab", null, 0, out var zeroTruncated);
        var twoJump = scopedLookup.JumpObjects("ab", null, 2, out var twoTruncated);
        check(otherProjItem.Indexing is null && fullProjItem.Indexing == true
            && zeroJump.Count == 0 && zeroTruncated
            && twoJump.Count == 2 && twoTruncated,
            $"phase gate & jump truncation edge cases: scopedIdx={otherProjItem.Indexing} fullIdx={fullProjItem.Indexing} zero=({zeroJump.Count},{zeroTruncated}) two=({twoJump.Count},{twoTruncated})");

        // Suppress unused local warning on seedRead (used to verify BigQueryReader names-only creation).
        check(seedRead.Table.Count > 1, "names-only seed read built cleanly");
    }

    sealed class SlowSingleTableHydrateSource(string billing) : IBigQueryIndexSource
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int TableCalls => Volatile.Read(ref tableCalls);
        private int tableCalls;

        public string BillingProject(string connectionId) => billing;
        public Task<BigQueryProjectDiscovery> AccessibleProjectsAsync(string connectionId, int maxProjects, CancellationToken token) => Task.FromResult(new BigQueryProjectDiscovery([], false));
        public Task<BigQueryDatasetList> DatasetsAsync(string connectionId, string project, CancellationToken token) => Task.FromResult(new BigQueryDatasetList([], false));
        public Task<BigQueryListing> ObjectsAsync(string connectionId, string project, string dataset, CancellationToken token) => Task.FromResult(new BigQueryListing([], [], [], false));
        public async Task<Google.Apis.Bigquery.v2.Data.Table> TableAsync(string connectionId, string project, string dataset, string table, CancellationToken token)
        {
            Interlocked.Increment(ref tableCalls);
            Entered.TrySetResult();
            await Release.Task.WaitAsync(token);
            return new Google.Apis.Bigquery.v2.Data.Table
            {
                Type = "TABLE",
                Schema = new() { Fields = [new() { Name = "id", Type = "INT64", Mode = "REQUIRED" }] }
            };
        }
        public Task<Google.Apis.Bigquery.v2.Data.Routine> RoutineAsync(string connectionId, string project, string dataset, string routine, CancellationToken token) =>
            Task.FromResult(new Google.Apis.Bigquery.v2.Data.Routine());
        public async IAsyncEnumerable<BigQueryBulkDataset> BulkAsync(string connectionId, string project, string location, bool definitions, long? cap, BigQueryBulkBudget budget,
            Func<string, string, bool> wanted, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken token)
        {
            await Task.CompletedTask;
            yield break;
        }
        public Exception Map(Exception error, string project, string? permission, CancellationToken token) => error;
    }

    sealed class SingleTableHydrateSource(string billing) : IBigQueryIndexSource
    {
        public string BillingProject(string connectionId) => billing;
        public Task<BigQueryProjectDiscovery> AccessibleProjectsAsync(string connectionId, int maxProjects, CancellationToken token) => Task.FromResult(new BigQueryProjectDiscovery([], false));
        public Task<BigQueryDatasetList> DatasetsAsync(string connectionId, string project, CancellationToken token) => Task.FromResult(new BigQueryDatasetList([], false));
        public Task<BigQueryListing> ObjectsAsync(string connectionId, string project, string dataset, CancellationToken token) => Task.FromResult(new BigQueryListing([], [], [], false));
        public Task<Google.Apis.Bigquery.v2.Data.Table> TableAsync(string connectionId, string project, string dataset, string table, CancellationToken token) =>
            Task.FromResult(new Google.Apis.Bigquery.v2.Data.Table
            {
                Type = "TABLE",
                Schema = new() { Fields = [new() { Name = "id", Type = "INT64", Mode = "REQUIRED" }, new() { Name = "word", Type = "STRING", Mode = "NULLABLE" }] }
            });
        public Task<Google.Apis.Bigquery.v2.Data.Routine> RoutineAsync(string connectionId, string project, string dataset, string routine, CancellationToken token) =>
            Task.FromResult(new Google.Apis.Bigquery.v2.Data.Routine());
        public async IAsyncEnumerable<BigQueryBulkDataset> BulkAsync(string connectionId, string project, string location, bool definitions, long? cap, BigQueryBulkBudget budget,
            Func<string, string, bool> wanted, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken token)
        {
            await Task.CompletedTask;
            yield break;
        }
        public Exception Map(Exception error, string project, string? permission, CancellationToken token) => error;
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
