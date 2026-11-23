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
        check(before.Index == "none" && Items(before.Answers[0]) == "varia-alpha,varia-beta" && before.Answers[1] is { State: "absent", Items.Count: 0 },
            $"before any build the lookup still names the connection's projects, billing first, and knows no dataset: {before.Index} {Items(before.Answers[0])} {before.Answers[1].State}");
        var gets = harness.Fake.To(".*").Count();
        await harness.Index();
        var after = harness.Fake.To(".*").Count();
        await Lookup(PathRequest("varia-alpha", "sales", "orders"));
        check(harness.Fake.To(".*").Count() == after && after > gets, "a lookup reads the index in memory: no request reaches BigQuery");

        var top = await Lookup(PathRequest(), PathRequest("varia-alpha"), PathRequest("varia-alpha", "sales"), PathRequest("varia-beta", "census"), PathRequest("nope"));
        var objects = top.Answers[2];
        check(top.Index == "ready" && top.Answers[0].Items.Single(item => item.Name == "varia-beta") is { Kind: "bqProject", Detail: "names" } && top.Answers[0].Items[0] is { Name: "varia-alpha", Detail: null },
            "projects come back with the extra project marked as read by name only");
        check(top.Answers[1] is { State: "ready", Path: ["varia-alpha"] } && top.Answers[1].Items.Select(item => item.Name).ToList() is var datasets && datasets.Contains("sales") && datasets.Contains("staging")
            && datasets.SequenceEqual(datasets.Order(StringComparer.Ordinal)) && top.Answers[1].Items.All(item => item.Kind == "bqDataset"),
            "a project's datasets come back by name: " + Items(top.Answers[1]));
        check(objects is { State: "ready", Truncated: false } && objects.Items.Any(item => item is { Name: "orders", Kind: "bqTable" }) && objects.Items.Any(item => item is { Name: "daily", Kind: "bqView" })
            && objects.Items.Any(item => item is { Name: "to_cents", Kind: "bqRoutine", Subtype: "scalar", Detail: "(dollars NUMERIC) RETURNS INT64" })
            && objects.Items.Single(item => item.Name.StartsWith("events_2", StringComparison.Ordinal)) is { Name: "events_20260103", Shards: { Count: 3, Prefix: "events_" } }
            && objects.Items.Any(item => item.Kind == "bqModel") && objects.Items.All(item => item.Kind != "bqDataset" && item.Kind != "bqColumn"),
            "a dataset's objects come back with kinds, subtypes, a routine's signature and a sharded group as its newest shard, without the dataset entry or columns: " + Items(objects));
        check(top.Answers[3] is { State: "partial" } && top.Answers[4] is { State: "absent", Path: ["nope"], Items.Count: 0 },
            $"a dataset of a project read by name only is partial, and an unknown project absent: {top.Answers[3].State} {top.Answers[4].State}");

        var orders = (await Lookup(PathRequest("varia-alpha", "sales", "orders"))).Answers[0];
        check(orders.Object is { Name: "orders", Kind: "bqTable", Detailed: true, Rows: 1234567, Bytes: 5368709120, Partitioning: "DAY on placed", Clustering: "customer, region" },
            "a table's answer carries its facts: rows, size, partitioning and clustering");
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
        var cut = (await Lookup(PathRequest("varia-alpha", "sales", "orders"))).Answers[0];
        salesRead.ChildrenLeftOut = false;
        check(cut.Object is { Detailed: false } && cut.State == "partial", "a table whose dataset's columns were left out is not detailed, and its dataset is partial");
        var census = (await Lookup(PathRequest("varia-beta", "census", "population"))).Answers[0];
        check(census is { State: "partial", Object: { Detailed: false }, Items.Count: 0 }, "an object of a project read by name only has no details and no columns");
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
    }
}
