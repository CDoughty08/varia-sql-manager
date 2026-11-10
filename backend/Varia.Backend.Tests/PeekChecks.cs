using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Offline explorer.peek checks: the catalogue's peek block, every kind's batch for every band against the lint and
/// the catalogue's column order, request validation before the connection, the words made from codes, and the service's
/// failure values with a fake host.</summary>
internal static partial class PeekChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
    };

    [GeneratedRegex(@" AS \[([A-Za-z]+)\]")]
    private static partial Regex Alias();

    public static async Task RunAsync(Action<bool, string> check)
    {
        Catalog(check);
        Sql(check);
        Words(check);
        await RequestsAsync(check);
        await LiveFixturesAsync(check);
    }

    /// <summary>The live Peek checks' fixtures against fake servers, since every CI server compares database names without case
    /// and has a local name: one that compares by case (a CREATE VIEW naming the database in another case fails its batch) and
    /// whose @@SERVERNAME is NULL makes every fixture but VC and PL, and never sends either; one that can make both gets each
    /// in a script of its own, so neither can stop the main batch.</summary>
    private static async Task LiveFixturesAsync(Action<bool, string> check)
    {
        const string database = "VariaScratch_20261108000000_abcdef12";
        const string recased = "vARIAsCRATCH_20261108000000_ABCDEF12";
        foreach (var (caseless, named) in new[] { (false, false), (true, true) })
        {
            var sent = new List<(string Script, string Database)>();
            Task<SqlRun> Fake(string script, string db)
            {
                sent.Add((script, db));
                string? scalar = script.Contains("DB_ID(", StringComparison.Ordinal) ? (caseless ? "1" : "0")
                    : script.Contains("@@SERVERNAME IS NULL", StringComparison.Ordinal) ? (named ? "1" : "0") : null;
                var failed = !caseless && db == database && script.Contains("[" + recased + "]", StringComparison.Ordinal);
                return Task.FromResult(new SqlRun(failed ? "failed" : "completed", failed ? "Database '" + recased + "' does not exist." : null,
                    scalar is null ? [] : [[[scalar]]]));
            }
            var (created, probedCaseless, probedNamed) = await PeekLiveChecks.CreateFixturesAsync(database, Fake);
            var made = sent.Where(item => item.Database == database).Select(item => item.Script).ToList();
            var view = made.Where(script => script.Contains("[" + recased + "]", StringComparison.Ordinal)).ToList();
            var loopback = made.Where(script => script.Contains("@@SERVERNAME", StringComparison.Ordinal)).ToList();
            bool Alone(List<string> scripts) => scripts is [var only] && !only.Contains("\nGO\n", StringComparison.Ordinal) && !only.Contains("[Blob]", StringComparison.Ordinal);
            check(created.Status == "completed" && probedCaseless == caseless && probedNamed == named && made.Any(script => script.Contains("CREATE TABLE [Peek]]'Ü].[Blob]", StringComparison.Ordinal))
                && (caseless ? Alone(view) : view.Count == 0) && (named ? Alone(loopback) : loopback.Count == 0),
                "Peek's live fixtures on a server that " + (caseless ? "compares database names without case and has a local name" : "compares database names by case and has no local name")
                + " are made, with " + (caseless ? "VC and PL each in a script of its own" : "neither VC nor PL attempted") + ": " + created.Error);
        }
    }

    private static void Catalog(Action<bool, string> check)
    {
        var peek = ExplorerCatalog.Current.Peek;
        check(peek.Kinds.Keys.Order(StringComparer.Ordinal).SequenceEqual(["database", "databaseTrigger", "function", "index", "login", "procedure", "sequence", "serverTrigger", "synonym",
                "table", "tableType", "trigger", "type", "view"]) && peek.DefinitionPageChars == 1_000_000 && peek.DefinitionMaxChars == 134_217_728 && peek.BudgetMs == 15_000
            && peek.Kinds.Values.Where(kind => kind.Module).Select(kind => kind.Kind).Order(StringComparer.Ordinal).SequenceEqual(["databaseTrigger", "function", "procedure", "serverTrigger", "trigger", "view"]),
            "the catalogue's peek block lists its kinds, the modules and triggers with their text and the rest scripted, with its limits");
        check(peek.Kinds.Values.Where(kind => !kind.Dependencies).Select(kind => kind.Kind).Order(StringComparer.Ordinal).SequenceEqual(["database", "databaseTrigger", "index", "login", "serverTrigger"])
            && peek.Kinds["login"].ListSpecs.Select(list => list.Id).SequenceEqual(["serverRoles", "userMapping"]) && peek.Kinds["index"].ListSpecs is [{ Id: "indexColumns" }]
            && peek.Kinds["database"].ListSpecs is [{ Id: "files" }] && peek.Kinds["trigger"].ListSpecs is [{ Id: "events" }] && peek.Kinds["synonym"].ListSpecs.Count == 0
            && peek.Kinds["index"].OptionalGroup == "usage" && peek.Kinds["index"].Facts.Where(fact => fact.Optional).Select(fact => fact.Id).First() == "userSeeks"
            && peek.Kinds.Values.Count(kind => kind.OptionalGroup is not null) == 1 && peek.ListRows == 1024 && peek.MappingDatabases == 256,
            "each peek kind declares its tabs: no dependencies for a database, a login, an index or a DDL trigger, its lists, and an index's usage as its one optional group");
        check(peek.Dependencies == 200, "Peek lists 200 dependencies each way");
        // Top rows runs Select Top Rows' script through query.execute: the catalogue gives the backend no rows of its own to read.
        JsonObject embedded;
        using (var stream = typeof(ExplorerCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Explorer.explorer-catalog.json")!) embedded = JsonNode.Parse(stream)!["peek"]!.AsObject();
        check(embedded.Select(item => item.Key).Order(StringComparer.Ordinal).SequenceEqual(["budgetMs", "definitionMaxChars", "definitionPageChars", "dependencies", "kinds", "listRows", "mappingDatabases"])
            && embedded["kinds"]!.AsArray().All(kind => kind!.AsObject().Select(item => item.Key).Order(StringComparer.Ordinal).SequenceEqual(["definition", "dependencies", "facts", "kind", "lists", "optionalGroup"])),
            "the catalogue's peek block holds kinds, the definition's page and longest length, the budget, the dependencies and the lists' limits, and nothing for rows: " + embedded.ToJsonString());
        var table = peek.Kinds["table"];
        check(table.Facts.Select(fact => fact.Id).Take(4).SequenceEqual(["schema", "created", "modified", "systemObject"]) && table.Facts.Single(fact => fact.Id == "temporal").Since == 13
            && table.Facts.Single(fact => fact.Id == "ledger").Since == 16 && table.FactsFor(12).All(fact => fact.Since is null) && table.FactsFor(16).Count == table.Facts.Count
            && table.Facts.Single(fact => fact.Id == "rowCount").Format == "count" && table.Facts.Single(fact => fact.Id == "dataSpace").Format == "kb",
            "peek facts keep their catalogue order, formats and bands; a band leaves out the facts newer than it");

        var malformed = new (string Name, Action<JsonObject> Change)[]
        {
            ("no peek block", json => json.Remove("peek")),
            ("a fact id that is not a plain word", json => Fact(json, "table", 0)["id"] = "row count]"),
            ("a repeated fact id", json => Fact(json, "view", 1)["id"] = "schema"),
            ("a fact named definition", json => Fact(json, "view", 1)["id"] = "definition"),
            ("an unknown format", json => Fact(json, "view", 0)["format"] = "money"),
            ("a band past the catalogue's", json => Fact(json, "view", 0)["since"] = 18),
            ("an unknown definition source", json => Kind(json, "view")["definition"] = "file"),
            ("a kind of a scope Peek does not read", json => Kind(json, "view")["kind"] = "ssisFolder"),
            ("an optional fact before a fact always read", json => Fact(json, "view", 0)["optional"] = true),
            ("optional facts without their group", json => Kind(json, "index")["optionalGroup"] = null),
            ("a list column with a band", json => Kind(json, "index")["lists"]!.AsArray()[0]!["columns"]!.AsArray()[0]!["since"] = 15),
            ("a list column of an unknown format", json => Kind(json, "login")["lists"]!.AsArray()[0]!["columns"]!.AsArray()[0]!["format"] = "money"),
            ("a repeated list", json => Kind(json, "login")["lists"]!.AsArray()[1]!["id"] = "serverRoles"),
            ("User mapping before another list", json => { var lists = Kind(json, "login")["lists"]!.AsArray(); var mapping = lists[1]!; lists.RemoveAt(1); lists.Insert(0, mapping); }),
            ("no list rows", json => json["peek"]!["listRows"] = 0),
            ("a kind twice", json => Kind(json, "view")["kind"] = "table"),
            ("a definition page of zero", json => json["peek"]!["definitionPageChars"] = 0),
            ("a definition page past 4M code units", json => json["peek"]!["definitionPageChars"] = 4_000_001),
            ("a longest definition below its page", json => json["peek"]!["definitionMaxChars"] = 999_999),
            ("no dependencies", json => json["peek"]!["dependencies"] = 0)
        };
        var accepted = new List<string>();
        foreach (var (name, change) in malformed)
        {
            try { ExplorerChecks.Variant(change); accepted.Add(name); }
            catch (InvalidOperationException) { }
        }
        check(accepted.Count == 0, "a malformed peek block fails the catalogue's parse: " + string.Join(", ", accepted));
    }

    private static JsonObject Kind(JsonObject json, string kind) => json["peek"]!["kinds"]!.AsArray().Single(item => (string?)item!["kind"] == kind)!.AsObject();
    private static JsonObject Fact(JsonObject json, string kind, int index) => Kind(json, kind)["facts"]!.AsArray()[index]!.AsObject();

    private static void Sql(Action<bool, string> check)
    {
        var peek = ExplorerCatalog.Current.Peek;
        var problems = new List<string>();
        var renders = 0;
        foreach (var cloud in new[] { false, true })
        foreach (var (spec, parent) in Variants(peek))
            for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
            {
                var render = new SqlRender(band);
                var batch = PeekSql.Render(spec, render, peek.DefinitionPageChars, parent, cloud);
                var name = spec.Kind + (parent is null ? "" : " of a " + parent) + " " + band + (cloud ? " (cloud)" : "");
                // A cloud server has no sys.master_files; its database reads no files.
                if (cloud && batch.Text.Contains("master_files", StringComparison.Ordinal)) problems.Add(name + ": it reads sys.master_files");
                var noFiles = cloud && spec.Kind == "database" ? 1 : 0;
                renders++;
                // Only the login's batch lists the databases it may enter, as the tree's database listings do.
                problems.AddRange(CatalogSql.Lint(batch.Text, render, list: false, mayCheckAccess: spec.Kind == "login").Select(problem => name + ": " + problem));
                var facts = spec.FactsFor(band);
                List<string> expected = [.. facts.Where(fact => !fact.Optional).Select(fact => fact.Id), .. PeekSql.Extras(spec)];
                List<string> optional = [.. facts.Where(fact => fact.Optional).Select(fact => fact.Id)];
                List<string> aliases = [.. Alias().Matches(batch.Text).Select(match => match.Groups[1].Value)];
                List<string> all = [.. expected, .. batch.Lists.SelectMany(list => list.Columns), .. optional, .. optional.Count > 0 ? new[] { PeekSql.Refused } : []];
                if (!batch.Columns.SequenceEqual(expected) || !batch.Optional.SequenceEqual(optional) || !aliases.SequenceEqual(all)) problems.Add(name + ": its columns are " + string.Join(",", aliases));
                if (!batch.Text.StartsWith(PeekSql.Lookup(spec.Kind, parent), StringComparison.Ordinal)) problems.Add(name + ": it does not find the object first");
                if (spec.Module != batch.Text.Contains("LEFT(m.definition COLLATE Latin1_General_100_BIN2, 1000000) AS [definition], CONVERT(bigint, DATALENGTH(m.definition)) / 2 AS [definitionLength], o.modify_date AS [definitionStamp]", StringComparison.Ordinal))
                    problems.Add(name + ": its module text");
                if (spec.Module)
                {
                    // A later page finds the object as the peek does, then reads from the kind's own FROM by code units.
                    var page = PeekSql.DefinitionPage(spec, parent);
                    problems.AddRange(CatalogSql.Lint(page, render, list: false, mayCheckAccess: false).Select(problem => name + " (page): " + problem));
                    if (!page.StartsWith(PeekSql.Lookup(spec.Kind, parent), StringComparison.Ordinal)
                        || !page.Contains("SELECT SUBSTRING(m.definition COLLATE Latin1_General_100_BIN2, @offset + 1, @take) AS [text], CONVERT(bigint, DATALENGTH(m.definition)) / 2 AS [length], o.modify_date AS [stamp] FROM ", StringComparison.Ordinal)
                        || !page.EndsWith("WHERE o.object_id = @object_id;\n", StringComparison.Ordinal))
                        problems.Add(name + ": its page");
                }
                // Each list reads the catalogue's columns first, in order, then its helpers; User mapping reads databases instead.
                var lists = spec.ListSpecs.Where(list => list.Id != "userMapping").ToList();
                if (!batch.Lists.Select(list => list.Id).SequenceEqual(lists.Select(list => list.Id)) || batch.Mapping != spec.ListSpecs.Any(list => list.Id == "userMapping")
                    || batch.Lists.Zip(lists).Any(pair => !pair.First.Columns.Take(pair.Second.Columns.Count).SequenceEqual(pair.Second.Columns.Select(column => column.Id))))
                    problems.Add(name + ": its lists are not the catalogue's");
                if (batch.Mapping != batch.Text.Contains(PeekSql.MappingDatabases, StringComparison.Ordinal)) problems.Add(name + ": User mapping's databases");
                if (batch.Lists.Count + (batch.Mapping ? 1 : 0) > 0 && System.Text.RegularExpressions.Regex.Matches(batch.Text, @"SELECT TOP \(@take\) ").Count != batch.Lists.Count + (batch.Mapping ? 1 : 0) - noFiles)
                    problems.Add(name + ": a list without TOP (@take)");
            }
        check(renders == 204 && problems.Count == 0, "every peek kind (an index and a trigger below each parent kind) renders for bands 12-17, on a box and a cloud server, passes the lint, and reads the catalogue's facts in order "
            + "as their ids, then its helpers, its lists and its optional group (" + renders + " renders" + (problems.Count > 0 ? "; first problem: " + problems[0] : ")"));
        var mappingProblems = CatalogSql.Lint(PeekSql.MappingUsers, new SqlRender(ExplorerCatalog.MinBand), list: false, mayCheckAccess: false);
        check(mappingProblems.Count == 0 && PeekSql.MappingUsers.Contains("sp.name = @object_name", StringComparison.Ordinal) && !PeekSql.MappingUsers.Contains("sql_logins", StringComparison.Ordinal),
            "User mapping's statement in each database passes the lint and finds the login's user by its SID, through the login's name: " + string.Join(", ", mappingProblems));
        var index = PeekSql.Render(peek.Kinds["index"], new SqlRender(17), peek.DefinitionPageChars, "table");
        var usage = index.Text[index.Text.IndexOf("BEGIN TRY", StringComparison.Ordinal)..];
        check(usage.Contains("sys.dm_db_index_usage_stats", StringComparison.Ordinal) && usage.Contains("IF ERROR_NUMBER() NOT IN (229, 262, 297, 300) THROW;", StringComparison.Ordinal)
            && index.Text.IndexOf("sys.dm_db_index_usage_stats", StringComparison.Ordinal) > index.Text.IndexOf("FROM sys.index_columns", StringComparison.Ordinal)
            && !PeekSql.Render(peek.Kinds["index"], new SqlRender(14), peek.DefinitionPageChars, "view").Text.Contains("optimize_for_sequential_key", StringComparison.Ordinal),
            "an index's usage is read last, inside TRY…CATCH that answers a refusal and raises any other error, and its band 15 option is left out below it");
        // A selective XML index also has no using index; only xml_index_type says which is primary. User mapping counts every
        // database the login may enter, past the batch's TOP, and a table type that uses a type is listed by its own names.
        var type = PeekSql.Dependencies("type", new SqlRender(17));
        check(index.Text.Contains("xi.xml_index_type = 0", StringComparison.Ordinal) && !index.Text.Contains("using_xml_index_id", StringComparison.Ordinal)
            && PeekSql.MappingDatabases.Contains("COUNT(*) OVER () AS total", StringComparison.Ordinal)
            && type.Contains("tt.name, tt.type_table_object_id", StringComparison.Ordinal) && PeekSql.KindOf("TT") == "tableType",
            "a primary XML index is told by its type, User mapping counts every database, and a table type is a type's user by its own names");
        var refusedLookup = false;
        try { PeekSql.Render(peek.Kinds["trigger"], new SqlRender(17), peek.DefinitionPageChars, "tableType"); } catch (InvalidOperationException) { refusedLookup = true; }
        check(refusedLookup, "Peek finds no trigger below a table type");
        // Dependencies are their own request: sys.sql_expression_dependencies needs more than VIEW DEFINITION, and a login refused
        // it must still get the facts.
        var dependencyProblems = new List<string>();
        foreach (var (spec, parent) in Variants(peek))
        {
            if (spec.Dependencies)
                for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
                {
                    var render = new SqlRender(band);
                    var text = PeekSql.Dependencies(spec.Kind, render, parent);
                    dependencyProblems.AddRange(CatalogSql.Lint(text, render, list: false, mayCheckAccess: false).Select(problem => spec.Kind + " " + band + ": " + problem));
                    if (!text.StartsWith(PeekSql.Lookup(spec.Kind, parent), StringComparison.Ordinal) || System.Text.RegularExpressions.Regex.Matches(text, @"SELECT TOP \(@take\) x\.server_name").Count != 2)
                        dependencyProblems.Add(spec.Kind + ": it does not find the object first, then list both ways");
                    if (spec.Kind is not ("synonym" or "type" or "tableType") && text != PeekSql.Lookup(spec.Kind, parent) + PeekSql.Uses(render) + PeekSql.UsedBy(render))
                        dependencyProblems.Add(spec.Kind + ": it does not read the code's dependencies");
                }
            for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
                if (PeekSql.Render(spec, new SqlRender(band), peek.DefinitionPageChars, parent).Text.Contains("sql_expression_dependencies", StringComparison.OrdinalIgnoreCase)) dependencyProblems.Add(spec.Kind + " " + band + ": the facts read dependencies");
        }
        var synonymUses = PeekSql.Dependencies("synonym", new SqlRender(17));
        var typeUses = PeekSql.Dependencies("type", new SqlRender(17));
        check(dependencyProblems.Count == 0 && synonymUses.Contains("PARSENAME(sy.base_object_name, 1)", StringComparison.Ordinal) && typeUses.Contains("d.referenced_class = 6", StringComparison.Ordinal)
            && typeUses.Contains("sys.all_parameters", StringComparison.Ordinal),
            "each kind with a Dependencies tab has a batch, for bands 12-17, that finds the object, then lists both ways (a synonym's base object, what uses a type), passes the lint, and the facts batch reads no dependencies"
            + (dependencyProblems.Count > 0 ? ": " + dependencyProblems[0] : ""));
        var table = peek.Kinds["table"];
        var old = PeekSql.Render(table, new SqlRender(12), peek.DefinitionPageChars);
        var newest = PeekSql.Render(table, new SqlRender(17), peek.DefinitionPageChars);
        check(!old.Text.Contains("temporal_type") && !old.Text.Contains("ledger_type") && !old.Columns.Contains("temporal") && newest.Text.Contains("t.temporal_type_desc AS [temporal]")
            && newest.Text.Contains("t.ledger_type_desc AS [ledger]") && newest.Text.Contains("ep.name = N'microsoft_database_tools_support'"),
            "a table's temporal and ledger facts appear only from their bands, and System object counts tools-support objects as the tree does");
        // The lint still refuses what the batches avoid.
        check(CatalogSql.Lint(newest.Text, new SqlRender(13), false, false).Any(problem => problem.Contains("ledger_type")), "a table's band 17 batch fails the lint on a band 13 server");
    }

    /// <summary>A text read as the renderer reads it: SUBSTRING's page of <paramref name="size"/> from each offset, trimmed as the backend trims it.</summary>
    private static List<string> Pages(string text, int size)
    {
        var pages = new List<string>();
        for (var offset = 0; offset < text.Length;)
        {
            var page = PeekSql.Trim(text.Substring(offset, Math.Min(size, text.Length - offset)), offset, text.Length);
            pages.Add(page);
            offset += page.Length;
        }
        return pages;
    }

    /// <summary>Each peek kind with the parent kinds it is found below (none for a kind that is not a child).</summary>
    private static IEnumerable<(PeekKindSpec Spec, string? Parent)> Variants(CatalogPeek peek) =>
        peek.Kinds.Values.SelectMany(spec => PeekSql.Parents.TryGetValue(spec.Kind, out var parents) ? parents.Select(parent => (spec, (string?)parent)) : [(spec, null)]);

    private static void Words(Action<bool, string> check)
    {
        check(PeekSql.KindOf("U ") == "table" && PeekSql.KindOf("ET") == "table" && PeekSql.KindOf("V ") == "view" && PeekSql.KindOf("PC") == "procedure" && PeekSql.KindOf("IF") == "function"
            && PeekSql.KindOf("SN") == "synonym" && PeekSql.KindOf("SO") == "sequence" && PeekSql.KindOf("TR") is null && PeekSql.KindOf(null) is null,
            "a dependency's type maps to the Object Explorer kind the tree lists it as, and triggers and unknown types to none");
        string? Sub(string kind, string type, int temporal = 0, int ledger = 0, bool node = false, bool system = false, int ledgerView = 0) =>
            PeekSql.SubtypeOf(kind, type, temporal, ledger, node, false, false, false, false, system, ledgerView, false);
        check(Sub("function", "AF") == "aggregate" && Sub("function", "IF") == "inline" && Sub("function", "FS") == "clrScalar" && Sub("procedure", "PC") == "clr"
            && Sub("procedure", "X ", system: true) == "extended" && Sub("procedure", "P ", system: true) == "system" && Sub("procedure", "P ") == "sql"
            && Sub("table", "U ", ledger: 1) == "ledgerHistory" && Sub("table", "U ", temporal: 2) == "systemVersioned" && Sub("table", "U ", node: true) == "graphNode" && Sub("table", "U ") is null
            && Sub("view", "V ", ledgerView: 1) == "ledger" && Sub("view", "V ", system: true) == "system" && Sub("view", "V ") is null && PeekSql.SubtypeOf("synonym", "SN", 0, 0, false, false, false, false, false, false, 0, false) is null,
            "a dependency's subtype is the one the tree lists it with: a function's and procedure's by type, a table's and view's by their flags");
        check(PeekSql.ExecuteAsWord(PeekSql.Caller, null) == "CALLER" && PeekSql.ExecuteAsWord(-2, "dbo") == "OWNER" && PeekSql.ExecuteAsWord(5, "app") == "app"
            && PeekSql.ExecuteAsWord(null, null) is null, "EXECUTE AS reads CALLER, OWNER or the user's name, and nothing for an object without a module");
        check(PeekSql.Growth(8192, false, -1) == "By 64 MB, unlimited" && PeekSql.Growth(10, true, 268435456) == "By 10 percent, limited to 2,097,152 MB"
            && PeekSql.Growth(0, false, -1) == "None" && PeekSql.Growth(64, false, 0) == "None" && PeekSql.Growth(100, false, 1000) == "By 0.78 MB, limited to 7.81 MB",
            "a file's autogrowth reads as SSMS's Files page words it: by size or percent, and its limit");
        check(PeekSql.IndexType(1, false) == "Clustered" && PeekSql.IndexType(2, false) == "Nonclustered" && PeekSql.IndexType(3, true) == "Primary XML" && PeekSql.IndexType(3, false) == "Secondary XML"
            && PeekSql.IndexType(6, false) == "Nonclustered columnstore" && PeekSql.IndexType(9, false) == "Other", "an index's type reads in Index Properties' words");
        check(PeekSql.LoginType("S ") == "SQL Server authentication" && PeekSql.LoginType("U") == "Windows user" && PeekSql.LoginType("E") == "Microsoft Entra user" && PeekSql.LoginType("Q") == "Q"
            && PeekSql.CacheWord(false, 50) == "No cache" && PeekSql.CacheWord(true, null) == "Default size" && PeekSql.CacheWord(true, 1000) == "1,000",
            "a login's type and a sequence's cache read in SSMS's words");
        var listRow = PeekSql.ListRow("indexColumns", new() { ["name"] = "Name", ["included"] = true, ["descending"] = false, ["type"] = "nvarchar", ["maxLength"] = (short)100, ["precision"] = (byte)0,
            ["scale"] = (byte)0, ["userDefined"] = false });
        var fileRow = PeekSql.ListRow("files", new() { ["name"] = "f", ["type"] = "ROWS", ["size"] = 8192L, ["growth"] = 8192, ["path"] = "C:\\x.mdf", ["percentGrowth"] = false, ["maxSize"] = -1 });
        check(listRow is ["Name", true, false, "nvarchar(50)"] && fileRow is ["f", "ROWS", 8192L, "By 64 MB, unlimited", "C:\\x.mdf"],
            "an index column's type and a file's growth read as the tree and SSMS's Files page write them: " + JsonSerializer.Serialize(listRow) + " " + JsonSerializer.Serialize(fileRow));
        check(PeekSql.FunctionType("SQL_SCALAR_FUNCTION") == "Scalar-valued" && PeekSql.FunctionType("SQL_INLINE_TABLE_VALUED_FUNCTION") == "Inline table-valued"
            && PeekSql.FunctionType("SQL_TABLE_VALUED_FUNCTION") == "Multi-statement table-valued" && PeekSql.FunctionType("AGGREGATE_FUNCTION") == "CLR aggregate"
            && PeekSql.FunctionType("SOMETHING_NEW") == "SOMETHING_NEW", "a function's type is in SSMS's words, and an unknown type as the server names it");
        // A page of 10 code units whose last is a pair's first half: kept at the text's end, otherwise the half moves to the next page.
        var pair = new string('x', 9) + "\U0001F600"[..1];
        check(PeekSql.Trim("abc", 0, 3) == "abc" && PeekSql.Trim("abc", 0, 9) == "abc" && PeekSql.Trim(pair, 0, 11) == new string('x', 9) && PeekSql.Trim(pair, 5, 15) == pair
            && PeekSql.Trim(pair, 5, 16) == new string('x', 9) && PeekSql.Trim("", 3, 9) == "",
            "a page never ends inside a surrogate pair before the text's end, so the pages put together are the text");
        var whole = new string('a', 999_999) + "\U0001F600" + new string('b', 999_999) + "\U0001F600";
        var pages = Pages(whole, 1_000_000);
        check(pages.Count == 3 && pages[0].Length == 999_999 && pages[1].Length == 1_000_000 && pages[2] == "b\U0001F600" && string.Concat(pages) == whole,
            "a long module's pages, each from the offset the last ended at, start with a whole pair and put together the text: " + string.Join(",", pages.Select(page => page.Length)));
        check(PeekSql.Stamp(new DateTime(2026, 11, 9, 12, 30, 15, 123)) == 1_794_227_415_123L
            && PeekSql.Stamp(new DateTime(2026, 11, 9, 12, 30, 15, 124)) - PeekSql.Stamp(new DateTime(2026, 11, 9, 12, 30, 15, 123)) == 1,
            "a module's stamp is its modify_date in milliseconds since 1970, which tells two edits a millisecond apart");
    }

    private static async Task RequestsAsync(Action<bool, string> check)
    {
        using (var sql = new SqlService())
        {
            async Task<string> Code(string body)
            {
                try { await sql.DispatchAsync("explorer.peek", JsonDocument.Parse(body).RootElement, Json); return "ok"; }
                catch (RequestException error) { return error.Code; }
                catch (JsonException) { return "JSON"; }
            }
            string Body(string target, string? connection = null, string? request = null) =>
                "{\"connectionId\":\"" + (connection ?? Guid.NewGuid().ToString()) + "\",\"requestId\":\"" + (request ?? Guid.NewGuid().ToString()) + "\",\"target\":" + target + "}";
            string Ref(string kind, string schema = "dbo", string? name = "Orders") => "{\"kind\":\"" + kind + "\",\"database\":\"Sales\",\"schema\":\"" + schema + "\"" + (name is null ? "" : ",\"name\":\"" + name + "\"") + "}";
            var codes = new[]
            {
                await Code(Body(Ref("table"), connection: "x")),
                await Code(Body(Ref("table"), request: "x")),
                await Code(Body("{\"kind\":\"user\",\"database\":\"Sales\",\"name\":\"u\"}")),
                await Code(Body("{\"kind\":\"column\",\"database\":\"Sales\",\"parent\":{\"kind\":\"table\",\"schema\":\"dbo\",\"name\":\"T\"},\"name\":\"c\"}")),
                await Code(Body(Ref("table", name: null))),
                await Code(Body(Ref("view", name: new string('v', 129)))),
                await Code(Body(Ref("view", schema: new string('s', 129)))),
                await Code(Body("{\"kind\":\"table\",\"database\":\"Sales\",\"schema\":\"dbo\",\"name\":\"Orders\",\"extra\":1}")),
                await Code(Body(Ref("procedure", name: new string('p', 128))))
            };
            async Task<string> Dependencies(string body)
            {
                try { await sql.DispatchAsync("explorer.peekDependencies", JsonDocument.Parse(body).RootElement, Json); return "ok"; }
                catch (RequestException error) { return error.Code; }
            }
            var peeks = new[]
            {
                await Code(Body("{\"kind\":\"database\",\"name\":\"Sales\"}")), await Code(Body("{\"kind\":\"login\",\"name\":\"sa\"}")), await Code(Body(Ref("synonym"))),
                await Code(Body("{\"kind\":\"index\",\"database\":\"Sales\",\"parent\":{\"kind\":\"table\",\"schema\":\"dbo\",\"name\":\"T\"},\"name\":\"IX\"}")),
                await Code(Body("{\"kind\":\"index\",\"database\":\"Sales\",\"parent\":{\"kind\":\"procedure\",\"schema\":\"dbo\",\"name\":\"P\"},\"name\":\"IX\"}")),
                await Code(Body("{\"kind\":\"serverTrigger\",\"name\":\"t\"}"))
            };
            check(peeks.SequenceEqual(["NOT_CONNECTED", "NOT_CONNECTED", "NOT_CONNECTED", "NOT_CONNECTED", "INVALID_PARAMS", "NOT_CONNECTED"]),
                "explorer.peek takes a database, a login, a synonym, an index below a table and a server trigger, and refuses an index below a procedure, before the connection: " + string.Join(", ", peeks));
            var dependencies = new[]
            {
                await Dependencies(Body("{\"kind\":\"login\",\"name\":\"sa\"}")), await Dependencies(Body("{\"kind\":\"database\",\"name\":\"Sales\"}")),
                await Dependencies(Body("{\"kind\":\"index\",\"database\":\"Sales\",\"parent\":{\"kind\":\"table\",\"schema\":\"dbo\",\"name\":\"T\"},\"name\":\"IX\"}")),
                await Dependencies(Body(Ref("synonym"))), await Dependencies(Body(Ref("sequence")))
            };
            check(dependencies.SequenceEqual(["INVALID_PARAMS", "INVALID_PARAMS", "INVALID_PARAMS", "NOT_CONNECTED", "NOT_CONNECTED"]),
                "explorer.peekDependencies refuses the kinds without the tab (a login, a database, an index) and takes a synonym and a sequence: " + string.Join(", ", dependencies));
            async Task<string> Page(string target, string offset)
            {
                var body = "{\"connectionId\":\"" + Guid.NewGuid() + "\",\"requestId\":\"" + Guid.NewGuid() + "\",\"target\":" + target + offset + "}";
                try { await sql.DispatchAsync("explorer.peekDefinition", JsonDocument.Parse(body).RootElement, Json); return "ok"; }
                catch (RequestException error) { return error.Code; }
                catch (JsonException) { return "JSON"; }
            }
            var pages = new[]
            {
                await Page(Ref("procedure"), ",\"offset\":1000000"), await Page(Ref("view"), ",\"offset\":134217727"),
                await Page("{\"kind\":\"trigger\",\"database\":\"Sales\",\"parent\":{\"kind\":\"table\",\"schema\":\"dbo\",\"name\":\"T\"},\"name\":\"tr\"}", ",\"offset\":5"),
                await Page("{\"kind\":\"serverTrigger\",\"name\":\"t\"}", ",\"offset\":5"),
                await Page(Ref("table"), ",\"offset\":5"), await Page(Ref("synonym"), ",\"offset\":5"), await Page(Ref("procedure"), ",\"offset\":0"),
                await Page(Ref("procedure"), ",\"offset\":134217728"), await Page(Ref("procedure"), ""), await Page(Ref("procedure"), ",\"offset\":5,\"take\":5")
            };
            check(sql.Methods.Contains("explorer.peekDefinition") && sql.LaneOf("explorer.peekDefinition") == RequestLane.Explorer
                && pages.SequenceEqual(["NOT_CONNECTED", "NOT_CONNECTED", "NOT_CONNECTED", "NOT_CONNECTED", "INVALID_PARAMS", "INVALID_PARAMS", "INVALID_PARAMS", "INVALID_PARAMS", "INVALID_PARAMS", "JSON"]),
                "HELLO lists explorer.peekDefinition on the explorer lane; it takes a module kind's offset past the first code unit and below the longest text, and refuses "
                + "a table, a synonym, offset 0 or the longest text, a missing offset (read as 0) and any other field before the connection: " + string.Join(", ", pages));
            string removed;
            try { await sql.DispatchAsync("explorer.peekRows", JsonDocument.Parse(Body(Ref("table"))).RootElement, Json); removed = "ok"; }
            catch (RequestException error) { removed = error.Code; }
            check(!sql.Methods.Contains("explorer.peekRows") && removed == "METHOD_NOT_FOUND",
                "HELLO no longer lists explorer.peekRows (Top rows runs through query.execute), and the backend refuses it as unknown: " + removed);
            check(sql.Methods.Contains("explorer.peek") && sql.LaneOf("explorer.peek") == RequestLane.Explorer
                && codes.SequenceEqual(["INVALID_PARAMS", "INVALID_PARAMS", "INVALID_PARAMS", "INVALID_PARAMS", "INVALID_PARAMS", "INVALID_PARAMS", "INVALID_PARAMS", "JSON", "NOT_CONNECTED"]),
                "HELLO lists explorer.peek on the explorer lane, and it refuses bad ids, kinds Peek does not describe, missing fields and names past 128 before the connection: " + string.Join(", ", codes));
        }

        var host = new ExplorerChecks.FakeHost();
        using var service = new ExplorerService(host);
        var target = new ObjectRefDto("procedure", "Sales", "dbo", "Refresh");
        var failed = await service.PeekAsync(new PeekArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target), CancellationToken.None);
        check(failed is { Error.Retryable: true, Facts.Count: 0, Definition: null } && host.Connections == 1 && service.RunningCount == 0,
            "a peek that cannot reach the server is a retryable error value with no facts, and unregisters: " + failed.Error?.Code);
        var json = JsonSerializer.Serialize(failed, Json);
        check(json.StartsWith("{\"facts\":{},\"elapsedMs\":", StringComparison.Ordinal) && json.Contains("\"error\":{\"code\":") && !json.Contains("definition"),
            "a failed peek serializes as facts, elapsedMs and error, without a definition");
        var shaped = JsonSerializer.Serialize(new PeekResult(new() { ["schema"] = "dbo", ["rowCount"] = 3L, ["temporal"] = null, ["systemObject"] = false }, 4, "CREATE VIEW v AS SELECT 1", 2_000_001, 1_794_486_615_123), Json);
        check(shaped == "{\"facts\":{\"schema\":\"dbo\",\"rowCount\":3,\"temporal\":null,\"systemObject\":false},\"elapsedMs\":4,\"definition\":\"CREATE VIEW v AS SELECT 1\",\"definitionLength\":2000001,\"definitionStamp\":1794486615123}",
            "a peek reply keeps null facts and drops the members it does not have: " + shaped);
        var listed = JsonSerializer.Serialize(new PeekResult(new() { ["disabled"] = false }, 1, Lists: new() { ["serverRoles"] = new([["sysadmin", true]]), ["userMapping"] = new([], Unread: 2) },
            Refused: ["usage"]), Json);
        check(listed == "{\"facts\":{\"disabled\":false},\"elapsedMs\":1,\"lists\":{\"serverRoles\":{\"rows\":[[\"sysadmin\",true]]},\"userMapping\":{\"rows\":[],\"unread\":2}},\"refused\":[\"usage\"]}",
            "a peek reply carries its lists by id, and the groups the login was refused: " + listed);
        var linked = JsonSerializer.Serialize(new PeekDependenciesResult([new("Orders", "dbo", Kind: "table", ForeignKey: true), new("Remote", "dbo", "Other", "LINKED")], [], 1, UsedByTruncated: true), Json);
        check(linked == "{\"uses\":[{\"name\":\"Orders\",\"schema\":\"dbo\",\"kind\":\"table\",\"foreignKey\":true},{\"name\":\"Remote\",\"schema\":\"dbo\",\"database\":\"Other\",\"server\":\"LINKED\"}],\"usedBy\":[],\"elapsedMs\":1,\"usedByTruncated\":true}",
            "a dependencies reply keeps only the fields each dependency has: " + linked);
        var failedDependencies = await service.PeekDependenciesAsync(new PeekArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target), CancellationToken.None);
        check(failedDependencies is { Error.Retryable: true, Uses.Count: 0, UsedBy.Count: 0 } && service.RunningCount == 0,
            "a dependencies read that cannot reach the server is a retryable error value with empty lists, and unregisters: " + failedDependencies.Error?.Code);
        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel();
            var before = host.Connections;
            try { await service.PeekAsync(new PeekArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target), cancelled.Token); check(false, "a cancelled peek runs"); }
            catch (OperationCanceledException) { check(host.Connections == before && service.RunningCount == 0, "a peek cancelled before it runs opens nothing and is unregistered"); }
        }
    }
}
