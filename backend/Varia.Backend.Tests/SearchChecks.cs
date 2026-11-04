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
        Previews(check);
        Budget(check);
        SystemObjects(check);
        Kinds(check);
        Reader(check).GetAwaiter().GetResult();
        ResourceSets(check).GetAwaiter().GetResult();
        Requests(check);
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
        var index = await new DatabaseReader("Sales", new ObjectIndexLimits(), budget).ReadAsync(Batch(true, objects, types, named, columns, indexes, stats, parameters), false, CancellationToken.None);
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
        check(index is { Bytes: > 0 } && budget.Used == index.Bytes && index.Credited == 0, "a read charges the budget exactly what its index holds");

        // The budget is memory shared by every connection: a read that does not fit answers null and gives back what it took.
        var measure = new IndexBudget(1 << 20);
        var bare = (await new DatabaseReader("Sales", new ObjectIndexLimits(), measure).ReadAsync(Batch(false, objects, types, named, [], [], [], []), false, CancellationToken.None, children: false))!;
        var small = new IndexBudget(bare.Bytes);
        var tooSmall = await new DatabaseReader("Sales", new ObjectIndexLimits(), small).ReadAsync(Batch(true, objects, types, named, columns, indexes, stats, parameters), false, CancellationToken.None);
        check(tooSmall is null && small.Used == 0, "a read past the memory budget answers null and gives back what it took");
        var withoutChildren = await new DatabaseReader("Sales", new ObjectIndexLimits(), small).ReadAsync(Batch(false, objects, types, named, [], [], [], []), false, CancellationToken.None, children: false);
        check(withoutChildren is { } kept && kept.Objects.Any(item => item.Name == "Orders") && kept.Objects.All(item => item.Kind is not ("column" or "index" or "statistic" or "parameter"))
            && small.Used == small.Limit, "the batch without children fits where the one with them did not");

        // A rebuild may use the share of the read it replaces, so it fits where the build before it did, even with the budget full.
        var held = new ConnectionIndex(small);
        held.Put(withoutChildren!);
        var rebuild = await new DatabaseReader("Sales", new ObjectIndexLimits(), small, withoutChildren).ReadAsync(Batch(false, objects, types, named, [], [], [], []), false, CancellationToken.None, children: false);
        check(rebuild is { Credited: > 0 } && rebuild.Credited == rebuild.Bytes && small.Used == small.Limit, "a rebuild with a full budget takes the replaced read's share");
        held.Put(rebuild!);
        check(small.Used == small.Limit && held.Databases.Single() == rebuild, "the swap moves the share over: nothing is charged twice or given back twice");
        check(await new DatabaseReader("Other", new ObjectIndexLimits(), small).ReadAsync(Batch(false, objects, types, named, [], [], [], []), false, CancellationToken.None, children: false) is null,
            "another database finds the budget full");
        var late = await new DatabaseReader("Sales", new ObjectIndexLimits(), small, rebuild).ReadAsync(Batch(false, objects, types, named, [], [], [], []), false, CancellationToken.None, children: false);
        held.Keep(new HashSet<string>());
        check(small.Used == 0, "a listing that drops the database gives back its whole share");
        held.Put(late!);
        check(small.Used == late!.Bytes, "a read whose credit was dropped meanwhile takes its share from the budget instead");
        held.Dispose();
        check(small.Used == 0, "a disconnect gives back every database's share");

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
        var partial = new DatabaseReader("Sales", new ObjectIndexLimits(), spare);
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
        var catalog = new ResourceCatalog(budget);
        var reads = 0;
        IndexedObject[] Objects(params string[] definitions) => [.. definitions.Select((text, at) => new IndexedObject("procedure", "systemStoredProcedures", "sys", "sp_" + at, Definition: text, System: true))];
        Func<Task<IndexedObject[]>> Read(params string[] definitions) => () => { reads++; return Task.FromResult(Objects(definitions)); };
        var key = new ResourceKey("16.0.4135.4", 3, 2, DateTime.UnixEpoch, 42, true);
        var first = await catalog.AcquireAsync(key, Read("CREATE PROCEDURE sys.sp_0 AS 1", "CREATE PROCEDURE sys.sp_1 AS 2"));
        var second = await catalog.AcquireAsync(key with { }, Read("never read"));
        check(reads == 1 && ReferenceEquals(first, second) && catalog.Sets == 1, "connections to servers with the same fingerprint share one read of the system objects");
        var text = IndexMemory.StringBytes("CREATE PROCEDURE sys.sp_0 AS 1".Length);
        check(first.Bytes == 2 * IndexMemory.RecordBytes + 2 * IndexMemory.StringBytes(4) + IndexMemory.StringBytes(3), "a set's records are charged with each distinct name and schema once");
        check(budget.Used == first.Bytes + 2 * text && first.Modules == 2, "a shared set charges its records and definitions once");
        // Another build (a cumulative update) changes one module: the other's text is held once for both sets.
        var other = await catalog.AcquireAsync(key with { Version = "16.0.4140.3", Checksum = 7 }, Read("CREATE PROCEDURE sys.sp_0 AS 1", "CREATE PROCEDURE sys.sp_1 AS 3"));
        check(reads == 2 && catalog.Sets == 2 && catalog.Texts == 3 && ReferenceEquals(other.Objects[0].Definition, first.Objects[0].Definition),
            "two builds' sets hold the definitions they share once");
        check(budget.Used == first.Bytes + other.Bytes + 3 * text, "the budget is charged for distinct definitions only");
        try { await catalog.AcquireAsync(key with { Checksum = 9 }, () => throw new InvalidOperationException("boom")); check(false, "a failed read throws"); }
        catch (InvalidOperationException) { check(catalog.Sets == 2, "a failed read keeps nothing, so the next build reads again"); }

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
        check(catalog.Sets == 1 && budget.Used == other.Bytes + 2 * text,
            "the last connection to let a set go drops it, keeping the texts another set holds");
        catalog.Release(other);
        check(catalog.Sets == 0 && catalog.Texts == 0 && budget.Used == 0, "with no connection left, every system definition's share is given back");
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
