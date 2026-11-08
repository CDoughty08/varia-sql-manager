using System.Data;
using System.Text.Json;
using Varia.Backend.Explorer;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>Offline object index checks: the SQL lint, the matcher's modes, ranking, definition previews, the shared budget,
/// system objects' folders, every Object Explorer kind's identity (server objects, database objects and children), the shared
/// resource sets, request validation, and the service's answers with no index and for an unknown connection.</summary>
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
        Fuzzy(check);
        Deadline(check);
        Qualified(check);
        Previews(check);
        Budget(check);
        SystemObjects(check);
        Kinds(check);
        Reader(check).GetAwaiter().GetResult();
        ResourceSets(check).GetAwaiter().GetResult();
        Requests(check);
        SearchCostChecks.Run(check);
    }

    private static void Sql(Action<bool, string> check)
    {
        var problems = ObjectSearchSql.Lint();
        check(problems.Count == 0, "the object index's statements pass Object Explorer's lint" + (problems.Count == 0 ? "" : ": " + string.Join("; ", problems)));
        var latest = new SqlRender(ExplorerCatalog.MaxBand);
        string Batch(bool definitions) => ObjectSearchSql.Batch(latest, definitions);
        check(new[] { "sql_modules", "definition", "query_text", "computed_columns" }.All(text => !Batch(false).Contains(text, StringComparison.Ordinal))
            && !ObjectSearchSql.Server(true, false).Contains("server_sql_modules", StringComparison.Ordinal)
            && new[] { "sys.sql_modules", "sys.check_constraints", "sys.default_constraints", "cc.definition", "g.query_text" }.All(text => Batch(true).Contains(text, StringComparison.Ordinal))
            && ObjectSearchSql.Server(true, true).Contains("sys.server_sql_modules", StringComparison.Ordinal),
            "the object index reads definitions (modules, constraints, computed columns, plan guides, server triggers) only when asked to");
        check(new[] { "sys.columns", "sys.indexes", "sys.stats", "sys.parameters", "sys.database_principals", "sys.schemas AS sc", "sys.assemblies", "sys.certificates",
            "sys.partition_functions", "sys.xml_schema_collections", "sys.plan_guides", "sys.column_master_keys", "sys.external_data_sources" }.All(text => Batch(false).Contains(text, StringComparison.Ordinal))
            && !ObjectSearchSql.Batch(new SqlRender(12), false).Contains("sys.column_master_keys", StringComparison.Ordinal),
            "a database's batch lists its children, principals, schemas and every other kind Object Explorer shows, each where its version has it");
        check(new[] { "sys.server_principals", "sys.credentials", "sys.server_audits", "sys.servers AS s", "sys.server_triggers", "sys.backup_devices" }
            .All(text => ObjectSearchSql.Server(true, false).Contains(text, StringComparison.Ordinal)) && ObjectSearchSql.Server(true, false).Contains("FROM sys.databases", StringComparison.Ordinal)
            && !ObjectSearchSql.Server(false, true).Contains("server_principals", StringComparison.Ordinal) && ObjectSearchSql.Server(false, true).Contains("FROM sys.databases", StringComparison.Ordinal),
            "the server batch lists the databases everywhere, and server objects only where Object Explorer serves their folders");
        check(ObjectSearchSql.ModuleCall.Contains("QUOTENAME(@db)", StringComparison.Ordinal), "the object index reaches a database only through QUOTENAME");
        check(ObjectSearchSql.Databases.Contains("HAS_DBACCESS", StringComparison.Ordinal) && ObjectSearchSql.Databases.Contains("d.state = 0", StringComparison.Ordinal),
            "the object index lists only online databases the login may open");
        check(!Batch(true).Contains("is_ms_shipped = 0", StringComparison.Ordinal) && !Batch(true).Contains("ep.major_id IS NULL", StringComparison.Ordinal)
            && Batch(true).Contains("FROM sys.objects AS o", StringComparison.Ordinal),
            "a database's batch lists every object of its own catalog, Microsoft-shipped and diagram support ones too");
        check(ObjectSearchSql.ResourceObjects(true).Contains("sys.all_objects AS o", StringComparison.Ordinal) && ObjectSearchSql.ResourceObjects(true).Contains("o.object_id < 0", StringComparison.Ordinal)
            && ObjectSearchSql.ResourceObjects(true).Contains("sys.all_sql_modules AS m WHERE m.object_id < 0", StringComparison.Ordinal) && !ObjectSearchSql.ResourceObjects(false).Contains("sql_modules", StringComparison.Ordinal),
            "the resource database's objects and definitions are read apart, by their negative ids");
        check(ObjectSearchSql.ResourceFingerprint.Contains("o.object_id < 0", StringComparison.Ordinal) && ObjectSearchSql.ResourceFingerprint.Contains("CHECKSUM_AGG", StringComparison.Ordinal),
            "the resource fingerprint covers exactly the objects the shared set holds");
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
        check(Make("ord*s").Find("usp_GetOrders", 0, out at, out length) && at == 7 && length == 6, "a plain search's * stands for any characters");
        check(Make("*Orders*").Find("usp_GetOrders", 0, out at, out length) && at == 7 && length == 6, "a plain search's outer *s change nothing, since it matches anywhere");
        check(Make("Cust*", wholeWord: true).Find("dbo.Customers x", 0, out at, out length) && at == 4 && length == 9, "under Whole Word an outer * matches the rest of the identifier");
        check(Make("a?c").Find("xabcx", 0, out at, out length) && at == 1 && length == 3 && !Make("a?c").Find("ac", 0, out _, out _), "a plain search's ? stands for one character");
        check(Make("a+b*c").Find("a+bXc", 0, out at, out _) && at == 0 && Make("[x]?").Find("[x]1", 0, out at, out _) && at == 0, "a wildcard search keeps every other character literal");
        check(SearchMatcher.Wildcard("a**b?c") == "a.*?b.c" && SearchMatcher.Wildcard("*ab*") == "[\\p{L}\\p{Nd}_@#$]*ab[\\p{L}\\p{Nd}_@#$]*", "wildcards become a NonBacktracking pattern");
    }

    private static void Qualified(Action<bool, string> check)
    {
        var index = new ConnectionIndex(new IndexBudget(1 << 20));
        index.Put(new DatabaseIndex("AppData", [
            new("schema", "schemas", null, "Sales"),
            new("table", "tables", "Sales", "Orders"),
            new("table", "tables", "dbo", "SalesOrders"),
            new("table", "tables", "PartialSchemaOne", "TableTable"),
            new("table", "tables", "PartialSchemaTwo", "TableTable"),
            new("table", "tables", "dbo", "TableTable")
        ], 0, 0, 0));
        index.Put(new DatabaseIndex("Archive", [new("table", "tables", "Sales", "Orders")], 0, 0, 0));
        string Labels(ObjectSearchResult result) => string.Join(", ", result.Hits.Select(hit => hit.Object.Database + ":" + hit.Label));
        var result = Search(index, ".sales", definitions: false);
        check(Labels(result) == "AppData:Sales, AppData:Sales.Orders, Archive:Sales.Orders, AppData:dbo.SalesOrders" && result.Hits[0].Range is [0, 5],
            "a leading dot finds a schema by its name, then what starts with it: " + Labels(result));
        result = Search(index, "Sales.", definitions: false);
        check(Labels(result) == "AppData:Sales, AppData:Sales.Orders, Archive:Sales.Orders", "a trailing dot finds the schema and its objects: " + Labels(result));
        result = Search(index, "appdata.sales.orders", definitions: false);
        check(Labels(result) == "AppData:Sales.Orders" && result.Hits[0].Range is [0, 12], "a database-qualified name finds the object in that database only: " + Labels(result));
        result = Search(index, "PartialSchema*.TableTable", definitions: false);
        check(Labels(result) == "AppData:PartialSchemaOne.TableTable, AppData:PartialSchemaTwo.TableTable", "a wildcard spans schemas: " + Labels(result));
        result = Search(index, "Table?able", definitions: false);
        check(result.Hits.Count == 3, "a wildcard search without a dot matches names");
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
        bool wholeWord = false, ObjectIndexLimits? limits = null, CancellationToken token = default, bool fuzzy = false) =>
        IndexSearch.Run(index, new(text, false, wholeWord, false, names, definitions, kinds, database, limit, fuzzy), Make(text, wholeWord: wholeWord), limits ?? new ObjectIndexLimits(), Ready, token);

    /// <summary>Fuzzy Match: how names split into words, the sound key, the bounded edit distance, and how approximate hits rank
    /// below exact ones, mark their words, honour Whole Word and dots, and leave definitions exact.</summary>
    private static void Fuzzy(Action<bool, string> check)
    {
        string Words(string value)
        {
            var spans = new List<(int Start, int Length)>();
            FuzzyName.Split(value, spans);
            return string.Join("|", spans.Select(span => value.Substring(span.Start, span.Length)));
        }
        check(Words("XMLParser") == "XML|Parser" && Words("usp_GetOrders2") == "usp|Get|Orders|2" && Words("orderLines") == "order|Lines" && Words("ID") == "ID"
            && Words("[Sales Order]-Line") == "Sales|Order|Line" && Words("Ünïcode_Ä") == "Ünïcode|Ä",
            "fuzzy matching splits names at punctuation, camelCase, a capital run's end and digits: " + Words("XMLParser") + ", " + Words("usp_GetOrders2"));
        check(FuzzyName.Phonetic("Customer") == "KSTMR" && FuzzyName.Phonetic("Kustomer") == "KSTMR" && FuzzyName.Phonetic("Phone") == FuzzyName.Phonetic("Fone")
            && FuzzyName.Phonetic("Address") == FuzzyName.Phonetic("Adres") && FuzzyName.Phonetic("Knight") == FuzzyName.Phonetic("Night") && FuzzyName.Phonetic("Orders") != FuzzyName.Phonetic("Users"),
            "the sound key joins sound-alikes (Kustomer, Fone, Adres, Knight) and keeps others apart: " + FuzzyName.Phonetic("Customer") + ", " + FuzzyName.Phonetic("Address"));
        var matcher = FuzzyName.Create("x", false)!;
        check(matcher.Distance("custmer", "customer", 2, false) == 1 && matcher.Distance("cusotmer", "customer", 2, false) == 1 && matcher.Distance("custm", "customer", 1, true) == 1
            && matcher.Distance("custm", "customer", 1, false) == -1 && matcher.Distance("orders", "users", 2, false) == -1,
            "the edit distance counts a swap as one edit, can compare with the nearest prefix, and gives up past its bound");
        check(FuzzyName.Create(string.Join(" ", Enumerable.Repeat("word", FuzzyName.MaxWords + 1)), false) is null && FuzzyName.Create(new string('a', FuzzyName.MaxWordChars + 1), false) is null
            && FuzzyName.Create("*.?", false) is null && FuzzyName.Create(string.Join(" ", Enumerable.Repeat("word", FuzzyName.MaxWords)), false) is not null,
            "a search with too many or too long words, or none, matches exactly only");

        var index = new ConnectionIndex(new IndexBudget(1 << 20));
        index.Put(new DatabaseIndex("Sales", [
            new("table", "tables", "Sales", "Customer"),
            new("table", "tables", "Sales", "CustomerAddress"),
            new("table", "tables", "dbo", "Customer"),
            new("table", "tables", "dbo", "Order"),
            new("table", "tables", "dbo", "Orders"),
            new("table", "tables", "dbo", "Users"),
            new("table", "tables", "dbo", "PhoneNumber"),
            new("table", "tables", "dbo", "Product"),
            new("column", "columns", null, "AddressLine1", "table", "Sales", "CustomerAddress"),
            new("procedure", "storedProcedures", "dbo", "usp_Report", Definition: "SELECT customer FROM Sales.Customer")
        ], 0, 1, 0));
        string Labels(ObjectSearchResult result) => string.Join(", ", result.Hits.Select(hit => hit.Label + (hit.Approximate == true ? "~" : "")));

        var result = Search(index, "custmer adress", fuzzy: true);
        check(result.Hits is [{ Label: "Sales.CustomerAddress", Approximate: true, Range: [6, 15] }], "a fuzzy search finds a name with a typo in each word and marks the words it matched: " + Labels(result));
        check(Search(index, "custmer adress").Hits.Count == 0, "without Fuzzy Match the same search finds nothing");
        result = Search(index, "orders", definitions: false, fuzzy: true);
        check(Labels(result) == "dbo.Orders, dbo.Order~", "exact hits keep their rank and approximate ones follow, but a different word does not match: " + Labels(result));
        result = Search(index, "ord", definitions: false, fuzzy: true);
        check(Labels(result) == "dbo.Order, dbo.Orders", "a short word is no typo of another word's start, nor of a word with another first letter: " + Labels(result));
        index.Put(new DatabaseIndex("Words", [new("table", "tables", "dbo", "Artist"), new("table", "tables", "dbo", "Kit"), new("table", "tables", "dbo", "Coat")], 0, 0, 0));
        check(Search(index, "ord", definitions: false, fuzzy: true, database: "Words").Hits.Count == 0 && Search(index, "cat", definitions: false, fuzzy: true, database: "Words").Hits.All(hit => hit.Label != "dbo.Kit")
            && Search(index, "code", definitions: false, fuzzy: true, database: "Words").Hits.Any(hit => hit.Label == "dbo.Coat"),
            "a word of fewer than 4 letters never matches by sound (ord is not Artist, cat not Kit), a longer one does (code, Coat)");
        result = Search(index, "fone", fuzzy: true);
        check(result.Hits is [{ Label: "dbo.PhoneNumber", Approximate: true, Range: [4, 5] }], "a word that sounds alike matches: " + Labels(result));
        result = Search(index, "custmeraddres", fuzzy: true);
        check(result.Hits is [{ Label: "Sales.CustomerAddress" }], "a search typed without separators is compared with the whole name: " + Labels(result));
        result = Search(index, "addr cust", definitions: false, fuzzy: true);
        check(Labels(result) == "Sales.CustomerAddress~", "words match in any order and as prefixes: " + Labels(result));
        result = Search(index, "custome", definitions: false, fuzzy: true);
        check(Labels(result) == "dbo.Customer, Sales.Customer, Sales.CustomerAddress", "a search that is a name's start is an exact prefix hit, not an approximate one: " + Labels(result));
        result = Search(index, "custmr", definitions: false, fuzzy: true);
        check(result.Hits.Take(2).All(hit => hit.Label.EndsWith(".Customer", StringComparison.Ordinal)) && result.Hits.Count == 3, "fewer edits rank first: " + Labels(result));
        result = Search(index, "custm", definitions: false, fuzzy: true, wholeWord: true);
        check(result.Hits.Count == 0 && Search(index, "custm", definitions: false, fuzzy: true).Hits.Count == 3, "under Whole Word a fuzzy word must match a whole word, not a prefix: " + Labels(result));
        result = Search(index, "custmer", definitions: false, fuzzy: true, wholeWord: true);
        check(Labels(result) == "dbo.Customer~, Sales.Customer~, Sales.CustomerAddress~", "under Whole Word a fuzzy word may match any whole word of a name: " + Labels(result));
        result = Search(index, "sales.custmer", definitions: false, fuzzy: true);
        check(Labels(result) == "Sales.Customer~, Sales.CustomerAddress~", "a fuzzy search with a dot matches the schema before it (dbo.Customer is left out): " + Labels(result));
        result = Search(index, "slaes.custmer.adress", definitions: false, fuzzy: true);
        check(result.Hits is [{ Object.Kind: "column", Approximate: true }], "a child's words before the dot match its parent's schema or name: " + Labels(result));
        var numbers = new ConnectionIndex(new IndexBudget(1 << 20));
        numbers.Put(new DatabaseIndex("Numbers", [
            new("table", "tables", "dbo", "Orders20"),
            new("table", "tables", "dbo", "Sales2018"),
            new("table", "tables", "dbo", "Sales20190"),
            new("table", "tables", "dbo", "StringList"),
            new("table", "tables", "dbo", "StoreList")
        ], 0, 1, 0));
        result = Search(numbers, "orders2000", definitions: false, fuzzy: true);
        check(result.Hits.Count == 0, "a number never matches a shorter one by sound: " + Labels(result));
        result = Search(numbers, "sales2019", definitions: false, fuzzy: true);
        check(Labels(result) == "dbo.Sales20190", "a number matches only exactly or as a prefix, never within edits: " + Labels(result));
        result = Search(numbers, "store list", definitions: false, fuzzy: true);
        check(Labels(result) == "dbo.StoreList~", "a three-code sound key never matches a longer word's start (store is not String): " + Labels(result));
        numbers.Dispose();
        result = Search(index, "custmer", names: false, fuzzy: true);
        check(result.Hits.Count == 0, "definitions stay exact under Fuzzy Match");
        result = Search(index, "customer", fuzzy: true);
        check(result.Hits[^1] is { Label: "dbo.usp_Report", Definition: not null, Range: null }, "a definition hit ranks after every approximate name hit: " + Labels(result));
        // Past the candidate cap, an exact hit scanned last still takes the place of approximate ones scanned first.
        var crowded = new ConnectionIndex(new IndexBudget(1 << 20));
        crowded.Put(new DatabaseIndex("A", [new("table", "tables", "dbo", "Ordrs"), new("table", "tables", "x", "Ordrs"), new("table", "tables", "y", "Ordrs")], 0, 0, 0));
        crowded.Put(new DatabaseIndex("B", [new("table", "tables", "dbo", "Orders")], 0, 0, 0));
        result = Search(crowded, "orders", definitions: false, fuzzy: true, limits: new ObjectIndexLimits { Candidates = 2 });
        check(result is { Partial: true, Total: 4, Hits: [{ Object.Database: "B", Approximate: null }, { Approximate: true }] }, "past the candidate cap a better hit replaces the worst: " + Labels(result));
        crowded.Dispose();
        result = IndexSearch.Run(index, new("custmer", false, false, true, true, false, null, null, 200, true), Make("custmer", regex: true), new ObjectIndexLimits(), Ready, CancellationToken.None);
        check(result.Hits.Count == 0, "a regular expression never matches approximately");
        index.Dispose();
    }

    /// <summary>One early hit, then many long definitions that do not match: the budget and Stop must still end the scan, since
    /// they are checked by objects scanned, not hits found. The definitions share one string, so the index holds little memory
    /// while a full scan would read about 10^10 characters.</summary>
    private static void Deadline(Action<bool, string> check)
    {
        var filler = new string('x', 100_000);
        var objects = new IndexedObject[100_001];
        objects[0] = new("procedure", "storedProcedures", "dbo", "needle_first");
        for (var i = 1; i < objects.Length; i++) objects[i] = new("procedure", "storedProcedures", "dbo", "p" + i, Definition: filler);
        var index = new ConnectionIndex(new IndexBudget(1 << 20));
        index.Put(new DatabaseIndex("Big", objects, 0, objects.Length - 1, 0));
        var result = Search(index, "needle", limits: new ObjectIndexLimits { SearchBudget = TimeSpan.FromMilliseconds(50) });
        check(result.Partial && result.Total == 1 && result.Hits is [{ Label: "dbo.needle_first" }],
            $"a search past its budget answers partial with the hits it found, even after an early hit ({result.Total} hits, partial {result.Partial}, {result.ElapsedMs} ms)");
        var roomy = new ObjectIndexLimits { SearchBudget = TimeSpan.FromHours(1) };
        using var stop = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var stopped = false;
        try { Search(index, "needle", limits: roomy, token: stop.Token); }
        catch (OperationCanceledException) { stopped = true; }
        check(stopped, $"a cancelled search stops scanning after an early hit ({watch.ElapsedMilliseconds} ms)");
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        stopped = false;
        try { Search(index, "needle", limits: roomy, token: cancelled.Token); }
        catch (OperationCanceledException) { stopped = true; }
        check(stopped, "a search whose request was already cancelled does not scan");
        index.Dispose();
    }

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
        check(budget.TryTake(60) && !budget.TryTake(50) && budget.TryTake(40), "the memory budget refuses what would pass it");
        budget.Release(100);
        check(budget.TryTake(60) && !budget.TryTake(30, keepFree: 20) && budget.TryTake(20, keepFree: 20) && budget.Used == 80, "a definition leaves names their reserve");
        budget.Release(80);
        budget.TryTake(100);
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
        check(DatabaseReader.Map("TR", "dbo", "t", DateTime.UnixEpoch) is null && DatabaseReader.ChildOf("TR", 5) is ("trigger", "tableTriggers", null), "a trigger is a child, never a top-level object");
        check(DatabaseReader.Map("IF", "dbo", "f", DateTime.UnixEpoch) is { Kind: "function", Folder: "tableValuedFunctions", Subtype: "inline" }, "inline functions are table-valued functions");
        var view = DatabaseReader.Map("V", "s", "v", DateTime.UnixEpoch)!;
        check(DatabaseReader.Child(view, "trigger", "tableTriggers", "t") is { Kind: "trigger", ParentKind: "view", ParentSchema: "s", ParentName: "v", ParentFolder: "views", Schema: null },
            "a view's trigger names its view and the view's folder");
    }

    private static void SystemObjects(Action<bool, string> check)
    {
        IndexedObject? Map(string type, bool system, string? parentType = null) => parentType is null ? DatabaseReader.Map(type, "dbo", "x", DateTime.UnixEpoch, system)
            : DatabaseReader.Child(DatabaseReader.Map(parentType, "dbo", "p", DateTime.UnixEpoch, system)!, DatabaseReader.ChildOf(type, 1)!.Value.Kind, DatabaseReader.ChildOf(type, 1)!.Value.Folder, "x");
        check(Map("U", true) is { Kind: "table", Folder: "systemTables", System: true } && Map("U", false) is { Folder: "tables", System: false },
            "a Microsoft-shipped table (master's spt_fallback_db) is under System Tables, as Object Explorer lists it");
        check(Map("V", true) is { Kind: "view", Folder: "systemViews", System: true }, "a system view is under System Views");
        check(new[] { "P", "PC", "X", "RF" }.All(type => Map(type, true) is { Kind: "procedure", Folder: "systemStoredProcedures", System: true }),
            "system procedures of every kind are under System Stored Procedures");
        check(Map("X", false) is { Folder: "systemStoredProcedures", System: false } && Map("P", false) is { Folder: "storedProcedures" },
            "a user's extended procedure is where Object Explorer lists extended procedures, and still a user object");
        check(new[] { "FN", "IF", "TF", "AF" }.All(type => Map(type, true) is { Kind: "function", Folder: "functions", System: true }), "a system function is under Functions");
        check(Map("TR", true, "U") is { Kind: "trigger", Folder: "tableTriggers", System: true, ParentKind: "table" }, "a Microsoft-shipped trigger is kept with its table");
        check(Map("SN", true) is { Kind: "synonym", System: true } && Map("SO", true) is { Kind: "sequence", System: true }, "nothing the login may see is left out for being Microsoft-shipped");

        var index = new ConnectionIndex(new IndexBudget(1 << 20));
        index.Put(new DatabaseIndex("master", [new("table", "systemTables", "dbo", "spt_fallback_db", System: true), new("table", "tables", "dbo", "spt_mine")], 0, 0, 0));
        index.Put(new DatabaseIndex("Sales", [new("table", "tables", "dbo", "spt_fallback_db")], 0, 0, 0));
        var labels = Search(index, "spt_fallback_db", definitions: false).Hits.Select(hit => hit.Object.Database + ":" + hit.Folder).ToList();
        check(labels.SequenceEqual(["Sales:tables", "master:systemTables"]), "within a rank, user objects come before system ones whatever their database: " + string.Join(", ", labels));
        check(Search(index, "spt_", definitions: false).Hits.Select(hit => hit.Object.Name).SequenceEqual(["spt_mine", "spt_fallback_db", "spt_fallback_db"]),
            "a system object still ranks by how its name matches first");
    }

    private static void Kinds(Action<bool, string> check)
    {
        // Tables and views go where Object Explorer lists them, by the batch's folder variant.
        string? Folder(string type, int variant) => DatabaseReader.Map(type, "dbo", "x", DateTime.UnixEpoch, false, variant)?.Folder;
        check(Folder("U", 1) == "fileTables" && Folder("U", 2) == "externalTables" && Folder("U", 3) == "graphTables" && Folder("U", 4) == "graphTables" && Folder("U", 5) == "droppedLedgerTables"
            && Folder("V", 5) == "droppedLedgerViews" && Folder("ET", 0) == "externalTables" && Folder("U", 0) == "tables",
            "FileTables, external, graph and dropped ledger tables and views are in their own folders");
        check(DatabaseReader.Map("R", "dbo", "r", DateTime.UnixEpoch) is { Kind: "rule", Folder: "rules" } && DatabaseReader.Map("D", "dbo", "d", DateTime.UnixEpoch) is { Kind: "default", Folder: "defaults" }
            && DatabaseReader.Map("SP", "dbo", "p", DateTime.UnixEpoch) is { Kind: "securityPolicy", Folder: "securityPolicies" },
            "rules, stand-alone defaults and security policies are indexed");
        check(DatabaseReader.ChildOf("D", 0) is null && DatabaseReader.ChildOf("D", 7) is ("constraint", "constraints", "default") && DatabaseReader.ChildOf("PK", 7) is ("key", "keys", "primary")
            && DatabaseReader.ChildOf("F", 7) is ("key", "keys", "foreign") && DatabaseReader.ChildOf("C", 7) is ("constraint", "constraints", "check") && DatabaseReader.ChildOf("EC", 7) is ("constraint", "constraints", "edge"),
            "keys and constraints are children of their table, a default with no parent a stand-alone one");

        // Children only go where Object Explorer lists a folder for them, under the parent's own folder.
        var table = DatabaseReader.Map("U", "dbo", "Orders", DateTime.UnixEpoch, false, 3)!;
        var external = DatabaseReader.Map("ET", "dbo", "Remote", DateTime.UnixEpoch)!;
        var procedure = DatabaseReader.Map("P", "dbo", "usp", DateTime.UnixEpoch)!;
        var tableType = new IndexedObject("tableType", "userDefinedTableTypes", "dbo", "List");
        check(DatabaseReader.Child(table, "column", "columns", "id") is { Kind: "column", ParentKind: "table", ParentFolder: "graphTables", Label: "dbo.Orders.id" },
            "a column names its table and the folder that lists it (a graph table's)");
        check(DatabaseReader.Child(external, "key", "keys", "pk") is null && DatabaseReader.Child(external, "column", "columns", "c") is not null && DatabaseReader.Child(external, "statistic", "statistics", "s") is not null,
            "an external table keeps only the columns and statistics Object Explorer lists below it");
        check(DatabaseReader.Child(procedure, "parameter", "parameters", "@id", "input") is { Subtype: "input", ParentKind: "procedure" } && DatabaseReader.Child(procedure, "column", "columns", "c") is null,
            "a procedure keeps its parameters, never columns");
        check(DatabaseReader.Child(tableType, "key", "keys", "pk", "primary") is { ParentKind: "tableType", ParentFolder: "userDefinedTableTypes" } && DatabaseReader.Child(tableType, "statistic", "statistics", "s") is null,
            "a table type keeps its keys, under User-Defined Table Types");
        var codes = new[] { "US", "RL", "AR", "SC", "AS", "AK", "CE", "SK", "CM", "CK", "DS", "FF", "DA", "FC", "FL", "PS", "PF", "PL", "XS" };
        check(codes.All(code => DatabaseReader.Named(code) is { } named && ObjectSearchService.Kinds.Contains(named.Kind) && ObjectSearchSql.Batch(new SqlRender(ExplorerCatalog.MaxBand), false).Contains("'" + code + "'", StringComparison.Ordinal)),
            "every named database object code the batch writes maps to a kind the index holds");
        check(new[] { "CR", "CP", "AU", "SA", "BD", "LS" }.All(code => DatabaseReader.ServerNamed(code) is { } named && ObjectSearchService.Kinds.Contains(named.Kind) && ObjectSearchSql.Server(true, false).Contains("'" + code + "'", StringComparison.Ordinal)),
            "every named server object code the batch writes maps to a kind the index holds");
        var catalog = ExplorerCatalog.Current;
        var served = catalog.Kinds.Where(kind => kind.Scope is not ("server" or "childUnnamed") && !kind.Scope.StartsWith("ssis", StringComparison.Ordinal)).Select(kind => kind.Kind).ToHashSet();
        check(served.SetEquals(ObjectSearchService.Kinds), "the index holds every kind Object Explorer lists but the server, return values and the SSIS Catalog's: "
            + string.Join(", ", served.Except(ObjectSearchService.Kinds).Concat(ObjectSearchService.Kinds.Except(served))));

        // The server's own objects name no database, and a search of one database leaves them out.
        var index = new ConnectionIndex(new IndexBudget(1 << 20));
        index.PutServer(new DatabaseIndex(ObjectSearchService.ServerScope, [new("login", "logins", null, "Sales_reader", Subtype: "sql"), new("database", "databases", null, "Sales")], 0, 0, 0));
        index.Put(new DatabaseIndex("Sales", [new("user", "users", null, "Sales_reader"), new("schema", "schemas", null, "sales"),
            DatabaseReader.Child(table, "column", "columns", "sales_id")!], 0, 0, 0));
        var hits = Search(index, "sales", definitions: false).Hits;
        check(hits.Any(hit => hit.Object is { Kind: "login", Database: null, Name: "Sales_reader" } && hit.Folder == "logins" && hit.Subtype == "sql")
            && hits.Any(hit => hit.Object is { Kind: "database", Database: null, Name: "Sales" })
            && hits.Any(hit => hit.Object is { Kind: "user", Database: "Sales", Schema: null })
            && hits.Any(hit => hit.Object is { Kind: "column", Database: "Sales", Parent: { Kind: "table", Name: "Orders" } } && hit.ParentFolder == "graphTables"),
            "logins, databases, users, schemas and columns are found, each with Object Explorer's ref: " + string.Join(", ", hits.Select(hit => hit.Object.Kind + ":" + hit.Label)));
        check(Search(index, "sales", definitions: false, database: "Sales").Hits.All(hit => hit.Object.Database == "Sales"), "a search of one database leaves out the server's objects");
        check(index.Objects == 5, "the server's objects count toward the connection's");
        var budget = new IndexBudget(100);
        var held = new ConnectionIndex(budget);
        budget.TryTake(30);
        held.PutServer(new DatabaseIndex(ObjectSearchService.ServerScope, [], 30, 1, 0));
        budget.TryTake(20);
        held.PutServer(new DatabaseIndex(ObjectSearchService.ServerScope, [], 20, 1, 0));
        check(budget.Used == 20, "a new read of the server's objects gives the old one's definitions back");
        held.Dispose();
        check(budget.Used == 0 && held.Server is null, "a disconnect gives the server's definitions back");
    }

    private static DataTable Rows((string Name, Type Type)[] columns, params object?[][] rows)
    {
        var table = new DataTable();
        foreach (var (name, type) in columns) table.Columns.Add(name, type);
        foreach (var row in rows) table.Rows.Add([.. row.Select(value => value ?? DBNull.Value)]);
        return table;
    }

    /// <summary>A database batch's result sets (without definitions) as DataTables, in the batch's order and column types.</summary>
    private static DataTableReader Batch(bool children, object?[][] objects, object?[][] types, object?[][] named, object?[][] columns, object?[][] indexes, object?[][] stats, object?[][] parameters)
    {
        var sets = new List<DataTable>
        {
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("type", typeof(string)), ("modified", typeof(DateTime)), ("parent", typeof(int)),
                ("system", typeof(bool)), ("variant", typeof(byte)), ("current", typeof(int))], objects),
            Rows([("id", typeof(int)), ("schema", typeof(string)), ("name", typeof(string)), ("table", typeof(bool)), ("assembly", typeof(bool)), ("object", typeof(int))], types),
            Rows([("code", typeof(string)), ("schema", typeof(string)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))], named),
            Rows([("id", typeof(int)), ("name", typeof(string)), ("modified", typeof(DateTime)), ("system", typeof(bool))]),
            Rows([("name", typeof(string)), ("modified", typeof(DateTime))], ["pg_orders", DateTime.UnixEpoch])
        };
        if (children)
        {
            sets.Add(Rows([("id", typeof(int)), ("name", typeof(string))], columns));
            sets.Add(Rows([("id", typeof(int)), ("name", typeof(string)), ("type", typeof(byte))], indexes));
            sets.Add(Rows([("id", typeof(int)), ("name", typeof(string))], stats));
            sets.Add(Rows([("id", typeof(int)), ("name", typeof(string)), ("output", typeof(bool))], parameters));
        }
        return new DataTableReader([.. sets]);
    }

    private static async Task Reader(Action<bool, string> check)
    {
        var at = DateTime.UnixEpoch;
        object?[][] objects =
        [
            [5, "dbo", "trg_orders", "TR", at, 10, false, (byte)0, null],
            [10, "dbo", "Orders", "U", at, 0, false, (byte)0, null],
            [11, "dbo", "Prices_History", "U", at, 0, false, (byte)6, 12],
            [12, "dbo", "Prices", "U", at, 0, false, (byte)0, null],
            [13, "dbo", "Gone_History", "U", at, 0, false, (byte)8, 14],
            [14, "dbo", "Gone", "U", at, 0, false, (byte)5, null],
            [15, "dbo", "pk_list", "PK", at, 900, false, (byte)0, null],
            [16, "dbo", "ck_orphan", "C", at, 999, false, (byte)0, null],
            [17, "dbo", "fn_rows", "IF", at, 0, false, (byte)0, null]
        ];
        object?[][] types = [[257, "dbo", "List", true, false, 900], [258, "dbo", "Phone", false, false, null]];
        object?[][] named = [["SC", null, "sales", null, false], ["XS", "dbo", "Shapes", at, false], ["ZZ", null, "unknown", null, false]];
        object?[][] columns = [[10, "id"], [11, "valid_from"], [17, "item"], [900, "value"], [999, "lost"]];
        object?[][] indexes = [[10, "ix_orders", (byte)2]];
        object?[][] stats = [[10, "_WA_Sys_1"], [900, "st_list"]];
        object?[][] parameters = [[17, "@top", false]];
        var budget = new IndexBudget(1 << 20);
        var pool = new StringPool(budget);
        static long Costs(IEnumerable<string> values) => values.Sum(StringPool.Cost);
        var index = await new DatabaseReader("Sales", new ObjectIndexLimits(), pool).ReadAsync(Batch(true, objects, types, named, columns, indexes, stats, parameters), false, CancellationToken.None);
        IndexedObject? Find(string name) => index?.Objects.SingleOrDefault(item => item.Name == name);
        check(Find("trg_orders") is { Kind: "trigger", ParentName: "Orders", ParentFolder: "tables", Schema: null }, "a child that comes before its parent in id order is placed under it");
        check(Find("Prices_History") is { Kind: "table", Subtype: "history", Via: { Name: "Prices", Folder: "tables" } }, "a history table names the table whose history row shows it");
        check(Find("valid_from") is { Kind: "column", ParentName: "Prices_History", Via.Name: "Prices" }, "a history table's column names the table that shows its parent");
        check(Find("Gone_History") is null && Find("Gone") is { Folder: "droppedLedgerTables" }, "a dropped ledger table's history, which Object Explorer does not list, is left out");
        check(Find("pk_list") is { Kind: "key", Subtype: "primary", ParentKind: "tableType", ParentName: "List" } && Find("value") is { ParentKind: "tableType" },
            "a table type's keys and columns are placed under it by its own object id");
        check(Find("st_list") is null && Find("ck_orphan") is null && Find("lost") is null, "children with no parent the index lists, or under one without that folder, are left out");
        check(Find("ix_orders") is { Kind: "index", Subtype: "nonclustered" } && Find("@top") is { Kind: "parameter", Subtype: "input", ParentKind: "function" } && Find("item") is { ParentName: "fn_rows" },
            "indexes, parameters and a function's columns are read with their subtypes");
        check(Find("sales") is { Kind: "schema", Folder: "schemas", Schema: null } && Find("Shapes") is { Kind: "xmlSchemaCollection", Schema: "dbo" } && Find("unknown") is null
            && Find("pg_orders") is { Kind: "planGuide" } && Find("Phone") is { Kind: "type", Subtype: "alias" },
            "named database objects, plan guides and types are read; an unknown code is left out");
        check(index is { Bytes: > 0 } && budget.Used == index.Bytes + Costs(index.Pooled) && index.Credited == 0 && pool.Count == index.Pooled.Length
            && index.Pooled.Distinct().Count() == index.Pooled.Length, "a read charges the budget its records and one pool entry per distinct text");
        check(index!.Objects.All(item => item.Schema is null || index.Pooled.Contains(item.Schema)) && index.Objects.All(item => index.Pooled.Contains(item.Name)),
            "every name a read keeps is the pool's");

        // Another connection reading the same objects shares every text: it is charged only its records and slots.
        var before = budget.Used;
        var again = (await new DatabaseReader("Sales", new ObjectIndexLimits(), pool).ReadAsync(Batch(true, objects, types, named, columns, indexes, stats, parameters), false, CancellationToken.None))!;
        check(budget.Used - before == again.Bytes && pool.Count == index.Pooled.Length
            && ReferenceEquals(again.Objects.Single(item => item.Name == "Orders").Name, index.Objects.Single(item => item.Name == "Orders").Name),
            "a second connection's read of the same objects holds each name once, with the first");
        var one = new ConnectionIndex(budget, pool: pool);
        var two = new ConnectionIndex(budget, pool: pool);
        one.Put(index);
        two.Put(again);
        one.Dispose();
        check(pool.Count == again.Pooled.Length && budget.Used == again.Bytes + Costs(again.Pooled), "a disconnect keeps the texts another connection holds");
        two.Dispose();
        check(pool.Count == 0 && budget.Used == 0, "the last connection to let a text go gives it back");

        // The budget is memory shared by every connection: a read that does not fit answers null and gives back what it took.
        var measure = new IndexBudget(1 << 20);
        await new DatabaseReader("Sales", new ObjectIndexLimits(), new StringPool(measure)).ReadAsync(Batch(false, objects, types, named, [], [], [], []), false, CancellationToken.None, children: false);
        var small = new IndexBudget(measure.Used);
        var smallPool = new StringPool(small);
        var tooSmall = await new DatabaseReader("Sales", new ObjectIndexLimits(), smallPool).ReadAsync(Batch(true, objects, types, named, columns, indexes, stats, parameters), false, CancellationToken.None);
        check(tooSmall is null && small.Used == 0 && smallPool.Count == 0, "a read past the memory budget answers null and gives back what it took, its texts included");
        var withoutChildren = await new DatabaseReader("Sales", new ObjectIndexLimits(), smallPool).ReadAsync(Batch(false, objects, types, named, [], [], [], []), false, CancellationToken.None, children: false);
        check(withoutChildren is { } kept && kept.Objects.Any(item => item.Name == "Orders") && kept.Objects.All(item => item.Kind is not ("column" or "index" or "statistic" or "parameter"))
            && small.Used == small.Limit, "the batch without children fits where the one with them did not");

        // A rebuild may use the share of the read it replaces, so it fits where the build before it did, even with the budget full.
        var held = new ConnectionIndex(small, pool: smallPool);
        held.Put(withoutChildren!);
        var rebuild = await new DatabaseReader("Sales", new ObjectIndexLimits(), smallPool, withoutChildren).ReadAsync(Batch(false, objects, types, named, [], [], [], []), false, CancellationToken.None, children: false);
        check(rebuild is { Credited: > 0 } && rebuild.Credited == rebuild.Bytes && small.Used == small.Limit, "a rebuild with a full budget takes the replaced read's share");
        held.Put(rebuild!);
        check(small.Used == small.Limit && held.Databases.Single() == rebuild, "the swap moves the share over: nothing is charged twice or given back twice");
        check(await new DatabaseReader("Other", new ObjectIndexLimits(), smallPool).ReadAsync(Batch(false, objects, types, named, [], [], [], []), false, CancellationToken.None, children: false) is null,
            "another database finds the budget full");
        var late = await new DatabaseReader("Sales", new ObjectIndexLimits(), smallPool, rebuild).ReadAsync(Batch(false, objects, types, named, [], [], [], []), false, CancellationToken.None, children: false);
        held.Keep(new HashSet<string>());
        check(small.Used == Costs(late!.Pooled), "a listing that drops the database gives back its records' share, and the texts no other read holds");
        held.Put(late);
        check(small.Used == late.Bytes + Costs(late.Pooled), "a read whose credit was dropped meanwhile takes its share from the budget instead");
        held.Dispose();
        check(small.Used == 0 && smallPool.Count == 0, "a disconnect gives back every database's share");

        // A database too large with its children is read again without them, and still counts as indexed.
        var asked = new List<bool>();
        Func<bool, Task<ObjectIndexSkip?>> Reads(params ObjectIndexSkip?[] answers) => children => { asked.Add(children); return Task.FromResult(answers[asked.Count - 1]); };
        var large = new ObjectIndexSkip("Sales", "TOO_LARGE", "m");
        check(await ObjectSearchService.WithFallbackAsync("Sales", Reads(large, null)) is { Code: ObjectSearchService.ChildrenLeftOut } && asked.SequenceEqual([true, false]),
            "a database too large with its children is kept without them");
        asked.Clear();
        check(await ObjectSearchService.WithFallbackAsync("Sales", Reads(large, large)) is { Code: "TOO_LARGE" } && asked.Count == 2, "one too large even without children is skipped");
        asked.Clear();
        check(await ObjectSearchService.WithFallbackAsync("Sales", Reads([null])) is null && asked.SequenceEqual([true]), "a database that fits is read once");

        // A read that failed part way is held only when nothing was held before.
        var spare = new IndexBudget(1 << 20);
        DatabaseIndex? put = null;
        var partial = new DatabaseReader("Sales", new ObjectIndexLimits(), new StringPool(spare));
        await partial.ReadAsync(Batch(false, objects, types, named, [], [], [], []), false, CancellationToken.None, children: false);
        ObjectSearchService.KeepPartial(partial, held: true, value => put = value);
        check(put is null, "a failed rebuild keeps the earlier read whole");
        ObjectSearchService.KeepPartial(partial, held: false, value => put = value);
        check(put is { Database: "Sales" } && put.Objects.Length > 0, "a first read that failed part way keeps what it read");

        // Every folder a hit names, its own or its parent's, is one Object Explorer lists rows in, so Reveal can reach it (system
        // functions aside: their System Functions folder is planned).
        var catalog = ExplorerCatalog.Current;
        var produced = new List<IndexedObject>();
        foreach (var type in new[] { "U", "ET", "V", "P", "PC", "X", "RF", "FN", "FS", "IF", "TF", "FT", "AF", "SN", "SO", "R", "D", "SP" })
            foreach (var system in new[] { false, true })
                for (var variant = 0; variant <= 8; variant++)
                    if (DatabaseReader.Map(type, "dbo", "x", at, system, variant) is { } item && !(item.Kind == "function" && item.System)) produced.Add(item);
        produced.AddRange(index!.Objects);
        var folders = produced.Select(item => item.Folder).Concat(produced.Select(item => item.ParentFolder).OfType<string>()).Concat(produced.Select(item => item.Via?.Folder).OfType<string>())
            .Concat(new[] { "US", "RL", "AR", "SC", "AS", "AK", "CE", "SK", "CM", "CK", "DS", "FF", "DA", "FC", "FL", "PS", "PF", "PL", "XS" }.Select(code => DatabaseReader.Named(code)!.Value.Folder))
            .Concat(new[] { "CR", "CP", "AU", "SA", "BD", "LS" }.Select(code => DatabaseReader.ServerNamed(code)!.Value.Folder))
            .Concat(["logins", "serverRoles", "serverTriggers", "databases", "systemDatabases", "databaseSnapshots", "databaseTriggers", "planGuides", "userDefinedTableTypes", "userDefinedDataTypes", "userDefinedTypes"])
            .Distinct().ToList();
        var unlisted = folders.Where(folder => catalog.Folder(folder)?.List is null).ToList();
        check(unlisted.Count == 0, "every folder the index names lists rows in Object Explorer: " + string.Join(", ", unlisted));
        var systemFunction = DatabaseReader.Map("IF", "sys", "dm_exec_sessions", at, system: true)!;
        check(DatabaseReader.Child(systemFunction, "column", "columns", "session_id") is null, "a system function's columns, which no folder lists, are left out");
    }

    private static async Task ResourceSets(Action<bool, string> check)
    {
        var budget = new IndexBudget(1 << 20);
        var pool = new StringPool(budget);
        var catalog = new ResourceCatalog(pool);
        static long Costs(params string[] values) => values.Distinct().Sum(StringPool.Cost);
        var reads = 0;
        IndexedObject[] Objects(params string[] definitions) => [.. definitions.Select((text, at) => new IndexedObject("procedure", "systemStoredProcedures", "sys", "sp_" + at, Definition: text, System: true))];
        Func<CancellationToken, Task<IndexedObject[]>> Read(params string[] definitions) => _ => { reads++; return Task.FromResult(Objects(definitions)); };
        var key = new ResourceKey("16.0.4135.4", 3, 2, DateTime.UnixEpoch, 42, true);
        var first = await catalog.AcquireAsync(key, Read("CREATE PROCEDURE sys.sp_0 AS 1", "CREATE PROCEDURE sys.sp_1 AS 2"));
        var second = await catalog.AcquireAsync(key with { }, Read("never read"));
        check(reads == 1 && ReferenceEquals(first, second) && catalog.Sets == 1, "connections to servers with the same fingerprint share one read of the system objects");
        check(first.Bytes == 2 * IndexMemory.RecordBytes, "a set's records are charged once");
        check(budget.Used == first.Bytes + Costs("sp_0", "sp_1", "sys", "CREATE PROCEDURE sys.sp_0 AS 1", "CREATE PROCEDURE sys.sp_1 AS 2") && first.Modules == 2 && pool.Count == 5,
            "a shared set's names and definitions are the pool's, each distinct text once");
        // Another build (a cumulative update) changes one module: the other's text is held once for both sets.
        var other = await catalog.AcquireAsync(key with { Version = "16.0.4140.3", Checksum = 7 }, Read("CREATE PROCEDURE sys.sp_0 AS 1", "CREATE PROCEDURE sys.sp_1 AS 3"));
        check(reads == 2 && catalog.Sets == 2 && pool.Count == 6 && ReferenceEquals(other.Objects[0].Definition, first.Objects[0].Definition)
            && ReferenceEquals(other.Objects[1].Name, first.Objects[1].Name), "two builds' sets hold the names and definitions they share once");
        check(budget.Used == first.Bytes + other.Bytes + Costs("sp_0", "sp_1", "sys", "CREATE PROCEDURE sys.sp_0 AS 1", "CREATE PROCEDURE sys.sp_1 AS 2", "CREATE PROCEDURE sys.sp_1 AS 3"),
            "the budget is charged for distinct texts only");
        try { await catalog.AcquireAsync(key with { Checksum = 9 }, _ => throw new InvalidOperationException("boom")); check(false, "a failed read throws"); }
        catch (InvalidOperationException) { check(catalog.Sets == 2, "a failed read keeps nothing, so the next build reads again"); }

        // The connection whose build started a shared read stops (or disconnects): another connection waiting for the same set
        // still gets it, because the read runs under its own lifetime, not the first caller's token.
        var gated = key with { Checksum = 11 };
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var readStopped = false;
        using (var starter = new CancellationTokenSource())
        {
            var started = catalog.AcquireAsync(gated, async readToken =>
            {
                readToken.Register(() => readStopped = true);
                await release.Task;
                return Objects("CREATE PROCEDURE sys.sp_0 AS 1");
            }, token: starter.Token);
            var waiter = catalog.AcquireAsync(gated with { }, Read("never read"));
            starter.Cancel();
            try { await started; check(false, "the stopped build stops waiting"); }
            catch (OperationCanceledException) { check(!readStopped && catalog.Sets == 3, "stopping the build that started a shared read leaves the read running for the others"); }
            release.SetResult();
            var shared = await waiter;
            check(shared.Objects.Length == 1 && !readStopped && catalog.Sets == 3, "a connection waiting on a shared read the first connection stopped still gets the set");
            catalog.Release(shared);
            check(catalog.Sets == 2, "the waiter's reference is the set's only one");
        }
        // When every waiter has gone, the read is stopped and kept nowhere, so the next build reads again.
        var abandon = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using (var only = new CancellationTokenSource())
        {
            var lone = catalog.AcquireAsync(key with { Checksum = 12 }, async readToken =>
            {
                readToken.Register(() => stopped.TrySetResult());
                await abandon.Task;
                return Objects("x");
            }, token: only.Token);
            only.Cancel();
            try { await lone; } catch (OperationCanceledException) { }
            check(await Task.WhenAny(stopped.Task, Task.Delay(5000)) == stopped.Task && catalog.Sets == 2, "the last waiter leaving stops the shared read and keeps nothing");
            abandon.SetResult();
        }
        // A shared read past its limit answers TimeoutException, not a caller's cancellation.
        try
        {
            await catalog.AcquireAsync(key with { Checksum = 13 }, async readToken => { await Task.Delay(Timeout.Infinite, readToken); return Objects("x"); }, TimeSpan.FromMilliseconds(50));
            check(false, "a shared read past its limit throws");
        }
        catch (TimeoutException) { check(catalog.Sets == 2, "a shared read past its limit times out and keeps nothing"); }

        // A connection's index searches its share once, as master's, or as the database a search names.
        var index = new ConnectionIndex(budget, catalog);
        index.Put(new DatabaseIndex("master", [], 0, 0, 0));
        index.Put(new DatabaseIndex("Sales", [], 0, 0, 0));
        index.PutResource(first);
        var hits = Search(index, "sp_0", names: true, definitions: false).Hits;
        check(hits is [{ Object: { Database: "master", Schema: "sys", Name: "sp_0" }, Folder: "systemStoredProcedures" }], "a system object every database shows is one hit, under master");
        check(Search(index, "sp_0", definitions: false, database: "Sales").Hits is [{ Object.Database: "Sales" }], "a search of one database finds the system objects in it");
        check(index.Objects == 2, "a connection counts its share of the system objects once");
        index.Dispose();
        catalog.Release(second);
        check(catalog.Sets == 1 && pool.Count == 5 && budget.Used == other.Bytes + Costs("sp_0", "sp_1", "sys", "CREATE PROCEDURE sys.sp_0 AS 1", "CREATE PROCEDURE sys.sp_1 AS 3"),
            "the last connection to let a set go drops it, keeping the texts another set holds");
        catalog.Release(other);
        check(catalog.Sets == 0 && pool.Count == 0 && budget.Used == 0, "with no connection left, every system text's share is given back");
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
        Refused(Args(kinds: ["ssisPackage"]), "a kind the index does not hold is refused");
        Refused(Args(kinds: [.. Enumerable.Repeat("table", ObjectSearchService.MaxKinds + 1)]), "more kinds than a search may name are refused");
        check(ObjectSearchService.Validate(Args(kinds: ["login", "column", "schema"])).Kinds!.Count == 3, "a search may narrow to server objects, children and database objects");
        Refused(Args(database: new string('d', 129)), "an overlong database name is refused");
        Refused(Args() with { ConnectionId = "nope" }, "a search needs a connection id");
        Refused(Args() with { Match = "soundex" }, "an unknown match mode is refused");
        Refused(Args() with { Match = "fuzzy", Regex = true }, "Fuzzy Match with a regular expression is refused");
        check(ObjectSearchService.Validate(Args() with { Match = "fuzzy" }).Fuzzy && !ObjectSearchService.Validate(Args() with { Match = "exact" }).Fuzzy && !ObjectSearchService.Validate(Args()).Fuzzy,
            "Match fuzzy asks for approximate name matches, and exact or none does not");
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
