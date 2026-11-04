using System.Text.Json;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>Offline object index checks: the SQL lint, the matcher's modes, ranking, definition previews, the shared budget,
/// request validation, and the service's answers with no index and for an unknown connection.</summary>
internal static class SearchChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
    };

    public static void Run(Action<bool, string> check)
    {
        Sql(check);
        Matcher(check);
        Ranking(check);
        Previews(check);
        Budget(check);
        Requests(check);
    }

    private static void Sql(Action<bool, string> check)
    {
        var problems = ObjectSearchSql.Lint();
        check(problems.Count == 0, "the object index's statements pass Object Explorer's lint" + (problems.Count == 0 ? "" : ": " + string.Join("; ", problems)));
        check(!ObjectSearchSql.Batch(false).Contains("sql_modules", StringComparison.Ordinal) && ObjectSearchSql.Batch(true).Contains("sys.sql_modules", StringComparison.Ordinal),
            "the object index reads definitions only when asked to");
        check(ObjectSearchSql.ModuleCall.Contains("QUOTENAME(@db)", StringComparison.Ordinal), "the object index reaches a database only through QUOTENAME");
        check(ObjectSearchSql.Databases.Contains("HAS_DBACCESS", StringComparison.Ordinal) && ObjectSearchSql.Databases.Contains("d.state = 0", StringComparison.Ordinal),
            "the object index lists only online databases the login may open");
    }

    private static SearchMatcher Make(string text, bool caseSensitive = false, bool wholeWord = false, bool regex = false) =>
        SearchMatcher.Create(text, caseSensitive, wholeWord, regex, TimeSpan.FromSeconds(1)).Matcher ?? throw new InvalidOperationException("No matcher for " + text);

    private static void Matcher(Action<bool, string> check)
    {
        check(Make("order").Find("usp_GetOrders", 0, out var at, out var length) && at == 7 && length == 5, "a plain search ignores case by default");
        check(!Make("order", caseSensitive: true).Find("usp_GetOrders", 0, out _, out _), "Match Case finds only the same case");
        check(Make("Order", caseSensitive: true).Find("usp_GetOrders", 0, out at, out _) && at == 7, "Match Case finds the same case");
        check(!Make("order", wholeWord: true).Find("usp_GetOrders", 0, out _, out _), "Whole Word skips a match inside a longer identifier");
        check(Make("Orders", wholeWord: true).Find("SELECT * FROM dbo.Orders WHERE 1 = 1", 0, out at, out _) && at == 18, "Whole Word finds an identifier between separators");
        check(Make("Orders", wholeWord: true).Find("Orders_old, [Orders]", 0, out at, out _) && at == 13, "Whole Word moves past a partial match to a later whole one");
        check(!Make("id", wholeWord: true).Find("@id #id $id", 0, out _, out _), "Whole Word counts @, # and $ as part of an identifier");
        check(Make("^CREATE\\s+PROC", regex: true).Find("-- header\nCREATE  PROCEDURE dbo.p", 0, out at, out _) && at == 10, "a regular expression matches at the start of any line");
        check(Make("get.*s$", regex: true).Find("usp_GetOrders", 0, out at, out length) && at == 4 && length == 9, "a regular expression ignores case by default");
        check(!Make("get.*s$", caseSensitive: true, regex: true).Find("usp_GetOrders", 0, out _, out _), "a regular expression with Match Case keeps case");
        check(Make("ord\\w*", wholeWord: true, regex: true).Find("x.ord_id, ord", 0, out at, out length) && at == 2 && length == 6, "a regular expression with Whole Word keeps whole identifiers");
        var (broken, problem) = SearchMatcher.Create("(abc", false, false, true, TimeSpan.FromSeconds(1));
        check(broken is null && problem is not null && problem.Contains("not closed", StringComparison.Ordinal), "an invalid regular expression is a value that says why");
        (broken, problem) = SearchMatcher.Create("(?<=a)b", false, false, true, TimeSpan.FromSeconds(1));
        check(broken is null && problem is not null && problem.Contains("lookarounds", StringComparison.Ordinal), "a lookaround is refused, since the matcher never backtracks");
        (broken, problem) = SearchMatcher.Create("(a)\\1", false, false, true, TimeSpan.FromSeconds(1));
        check(broken is null && problem is not null, "a backreference is refused");
        // The classic catastrophic pattern runs in linear time under NonBacktracking.
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var evil = Make("(a+)+$", regex: true).Find(new string('a', 50_000) + "!", 0, out _, out _);
        check(!evil && watch.Elapsed < TimeSpan.FromSeconds(2), "a pattern that backtracks exponentially elsewhere runs in linear time");
        check(!Make("x").Find("", 0, out _, out _) && Make("a").Find("a", 1, out _, out _) == false, "the matcher stops at the end of the text");
    }

    private static ConnectionIndex Sample(IndexBudget budget)
    {
        var index = new ConnectionIndex(budget);
        var definition = "CREATE PROCEDURE dbo.usp_GetOrders\nAS\n\tSELECT o.id FROM dbo.Orders AS o JOIN dbo.Customers AS c ON c.id = o.customer_id;\n-- Orders again\n";
        budget.TryTake(definition.Length);
        index.Put(new DatabaseIndex("Sales", [
            new("table", "tables", "dbo", "Orders"),
            new("table", "tables", "dbo", "OrdersArchive"),
            new("table", "tables", "audit", "PastOrders"),
            new("procedure", "storedProcedures", "dbo", "usp_GetOrders", Definition: definition),
            new("trigger", "tableTriggers", null, "trg_Orders", "table", "dbo", "Orders"),
            new("table", "tables", "dbo", "Customers")
        ], definition.Length, 1, 0));
        index.Put(new DatabaseIndex("Archive", [new("view", "views", "dbo", "Orders")], 0, 0, 0));
        return index;
    }

    private static readonly ObjectIndexStatus Ready = new("ready", 2, 2, 7, 1, 0, [], true);

    private static ObjectSearchResult Search(ConnectionIndex index, string text, bool names = true, bool definitions = true, int limit = 200, HashSet<string>? kinds = null, string? database = null,
        bool wholeWord = false, ObjectIndexLimits? limits = null) =>
        IndexSearch.Run(index, new(text, false, wholeWord, false, names, definitions, kinds, database, limit), Make(text, wholeWord: wholeWord), limits ?? new ObjectIndexLimits(), Ready);

    private static void Ranking(Action<bool, string> check)
    {
        var index = Sample(new IndexBudget(1 << 20));
        var result = Search(index, "orders", definitions: false);
        var labels = result.Hits.Select(hit => hit.Object.Database + ":" + hit.Label).ToList();
        check(labels.SequenceEqual(["Archive:dbo.Orders", "Sales:dbo.Orders", "Sales:dbo.OrdersArchive", "Sales:audit.PastOrders", "Sales:dbo.Orders.trg_Orders", "Sales:dbo.usp_GetOrders"]),
            "name hits rank an exact name first, then a prefix, then any match, each by database and name: " + string.Join(", ", labels));
        check(result.Total == 6 && !result.Partial, "a search counts every hit");
        var exact = result.Hits[1];
        check(exact.Range is [4, 6] && exact.Folder == "tables" && exact.Object.Schema == "dbo", "a name hit carries its range in the schema-qualified label and its folder");
        var trigger = result.Hits.Single(hit => hit.Object.Kind == "trigger");
        check(trigger.Object.Schema is null && trigger.Object.Parent is { Kind: "table", Schema: "dbo", Name: "Orders" } && trigger.Range is [15, 6],
            "a trigger hit names its parent table, as Object Explorer's ref does");
        result = Search(index, "dbo.orders", definitions: false);
        check(result.Hits.Count == 4 && result.Hits.All(hit => hit.Label.StartsWith("dbo.Orders", StringComparison.Ordinal)), "a name search with a dot matches the schema-qualified name");
        result = Search(index, "customer_id", names: false);
        check(result.Hits is [{ Label: "dbo.usp_GetOrders", Definition: { Line: 3, Matches: 1 } }], "a definition search finds the module and the match's line");
        result = Search(index, "orders", names: false);
        check(result.Hits is [{ Definition.Matches: 3 }], "a definition hit counts every match in the module");
        result = Search(index, "orders", kinds: ["view"]);
        check(result.Hits is [{ Object.Database: "Archive" }], "Kinds narrow a search");
        result = Search(index, "orders", database: "Sales", definitions: false);
        check(result.Hits.All(hit => hit.Object.Database == "Sales") && result.Total == 5, "Database narrows a search");
        result = Search(index, "orders", limit: 2);
        check(result.Hits.Count == 2 && result.Total == 6, "Limit keeps the best hits and still counts them all");
        result = Search(index, "orders", definitions: false, limits: new ObjectIndexLimits { Candidates = 3 });
        check(result.Partial && result.Total == 6 && result.Hits.Count == 3, "past the candidate cap a search is partial but counts on");
        result = Search(index, "Orders", wholeWord: true, definitions: false);
        check(result.Hits.Count == 2 && result.Hits.All(hit => hit.Label == "dbo.Orders"), "Whole Word finds exact names only");
    }

    private static void Previews(Action<bool, string> check)
    {
        var preview = IndexSearch.Preview("line one\r\n  SELECT needle FROM t\r\nlast", 19, 6, 1, 160, false);
        check(preview is { Line: 2, Column: 10, Preview: "  SELECT needle FROM t", Before: false, After: false } && preview.Range is [9, 6], "a preview is the match's line without its CR");
        var line = new string('x', 500) + "needle" + new string('y', 500);
        preview = IndexSearch.Preview(line, 500, 6, 1, 160, true);
        check(preview.Preview.Length == 160 && preview.Before && preview.After && preview.Preview.Substring(preview.Range[0], preview.Range[1]) == "needle" && preview.Cut,
            "a long line's preview is cut around the match and says so");
        preview = IndexSearch.Preview("a\tb needle", 4, 6, 1, 160, false);
        check(!preview.Preview.Contains('\t'), "a preview shows tabs as spaces");
        preview = IndexSearch.Preview("one\ntwo", 2, 3, 1, 160, false);
        check(preview.Line == 1 && preview.Range[1] == 1, "a match that spans lines shows up to its own line's end");
    }

    private static void Budget(Action<bool, string> check)
    {
        var budget = new IndexBudget(100);
        check(budget.TryTake(60) && !budget.TryTake(50) && budget.TryTake(40), "the definition budget refuses what would pass it");
        var index = new ConnectionIndex(budget);
        index.Put(new DatabaseIndex("a", [], 60, 0, 0));
        index.Put(new DatabaseIndex("b", [], 40, 0, 0));
        index.Put(new DatabaseIndex("a", [], 0, 0, 0));
        check(budget.Used == 40, "replacing a database gives its definitions' share back");
        index.Keep(new HashSet<string>(["a"]));
        check(budget.Used == 0 && index.Databases.Count == 1, "a database the listing no longer names is dropped with its share");
        index.Dispose();
        budget.TryTake(10);
        index.Put(new DatabaseIndex("late", [], 10, 0, 0));
        check(budget.Used == 0 && index.Databases.Count == 0, "a read that finishes after a disconnect is given back, not kept");
        check(DatabaseReader.Map("TR", "dbo", "t", DateTime.UnixEpoch, null, null, null) is null, "a trigger without a listable parent is left out");
        check(DatabaseReader.Map("IF", "dbo", "f", DateTime.UnixEpoch, null, null, null) is { Kind: "function", Folder: "tableValuedFunctions" }, "inline functions are table-valued functions");
        check(DatabaseReader.Map("TR", "dbo", "t", DateTime.UnixEpoch, "v", "s", "V") is { Kind: "trigger", ParentKind: "view", ParentSchema: "s", Schema: null }, "a view's trigger names its view");
    }

    private static void Requests(Action<bool, string> check)
    {
        var id = Guid.NewGuid().ToString();
        ObjectSearchArgs Args(string text = "x", string? scope = null, int? limit = null, List<string>? kinds = null, string? database = null) => new(id, Guid.NewGuid().ToString(), text, In: scope, Limit: limit, Kinds: kinds, Database: database);
        void Refused(ObjectSearchArgs args, string name)
        {
            try { ObjectSearchService.Validate(args); check(false, name); }
            catch (RequestException error) { check(error.Code == "INVALID_PARAMS", name); }
        }
        Refused(Args(""), "an empty search is refused");
        Refused(Args(new string('x', ObjectSearchService.MaxText + 1)), "an overlong search is refused");
        Refused(Args("a\0b"), "a search with U+0000 is refused");
        Refused(Args(scope: "columns"), "an unknown search scope is refused");
        Refused(Args(limit: ObjectSearchService.MaxLimit + 1), "a limit past 1000 is refused");
        Refused(Args(kinds: ["login"]), "a kind the index does not hold is refused");
        Refused(Args(database: new string('d', 129)), "an overlong database name is refused");
        Refused(Args() with { ConnectionId = "nope" }, "a search needs a connection id");
        var query = ObjectSearchService.Validate(Args(scope: "definitions"));
        check(!query.Names && query.Definitions && query.Limit == ObjectSearchService.DefaultLimit, "a definitions search skips names and takes the default limit");
        try { JsonSerializer.Deserialize<ObjectSearchArgs>("{\"connectionId\":\"" + id + "\",\"requestId\":\"" + id + "\",\"text\":\"x\",\"columns\":true}", Json); check(false, "an unknown search member is refused"); }
        catch (JsonException) { check(true, "an unknown search member is refused"); }

        using var service = new SqlService();
        try { service.Search.Search(Args(), CancellationToken.None); check(false, "a search on an unknown connection answers NOT_CONNECTED"); }
        catch (RequestException error) { check(error.Code == "NOT_CONNECTED", "a search on an unknown connection answers NOT_CONNECTED"); }
        var registered = service.Register("Server=offline;Integrated Security=true", Explorer.ServerProfile.Fallback("16.0.1000"), "master");
        var empty = service.Search.Search(Args() with { ConnectionId = registered }, CancellationToken.None);
        check(empty is { Hits.Count: 0, Index.State: "none" }, "a search before any build answers the index's state");
        check(service.Methods.Contains("explorer.index") && service.Methods.Contains("explorer.search"), "HELLO lists the object index's methods");
        check(service.LaneOf("explorer.index") == Protocol.RequestLane.Explorer && service.LaneOf("explorer.search") == Protocol.RequestLane.Explorer, "the object index runs on the explorer lane");
    }
}
