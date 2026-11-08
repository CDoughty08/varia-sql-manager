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
        RowsSql(check);
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
                "table", "tableType", "trigger", "type", "view"]) && peek.DefinitionChars == 1_000_000 && peek.BudgetMs == 15_000
            && peek.Kinds.Values.Where(kind => kind.Module).Select(kind => kind.Kind).Order(StringComparer.Ordinal).SequenceEqual(["databaseTrigger", "function", "procedure", "serverTrigger", "trigger", "view"]),
            "the catalogue's peek block lists its kinds, the modules and triggers with their text and the rest scripted, with its limits");
        check(peek.Kinds.Values.Where(kind => !kind.Dependencies).Select(kind => kind.Kind).Order(StringComparer.Ordinal).SequenceEqual(["database", "databaseTrigger", "index", "login", "serverTrigger"])
            && peek.Kinds.Values.Where(kind => kind.Rows).Select(kind => kind.Kind).Order(StringComparer.Ordinal).SequenceEqual(["table", "view"])
            && peek.Kinds["login"].ListSpecs.Select(list => list.Id).SequenceEqual(["serverRoles", "userMapping"]) && peek.Kinds["index"].ListSpecs is [{ Id: "indexColumns" }]
            && peek.Kinds["database"].ListSpecs is [{ Id: "files" }] && peek.Kinds["trigger"].ListSpecs is [{ Id: "events" }] && peek.Kinds["synonym"].ListSpecs.Count == 0
            && peek.Kinds["index"].OptionalGroup == "usage" && peek.Kinds["index"].Facts.Where(fact => fact.Optional).Select(fact => fact.Id).First() == "userSeeks"
            && peek.Kinds.Values.Count(kind => kind.OptionalGroup is not null) == 1 && peek.ListRows == 1024 && peek.MappingDatabases == 256,
            "each peek kind declares its tabs: no dependencies for a database, a login, an index or a DDL trigger, rows only of tables and views, its lists, and an index's usage as its one optional group");
        check(peek.Dependencies == 200 && peek.Rows == 10 && peek.RowColumns == 100 && peek.RowCellChars == 256 && peek.Kinds["table"].Rows && peek.Kinds["view"].Rows
            && !peek.Kinds["procedure"].Rows && !peek.Kinds["function"].Rows, "Peek lists 200 dependencies each way and samples 10 rows of tables and views, 100 columns, 256 characters a value");
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
            ("no list rows", json => json["peek"]!["listRows"] = 0),
            ("a kind twice", json => Kind(json, "view")["kind"] = "table"),
            ("a definition budget of zero", json => json["peek"]!["definitionChars"] = 0),
            ("rows of a procedure", json => Kind(json, "procedure")["rows"] = true),
            ("no dependencies", json => json["peek"]!["dependencies"] = 0),
            ("a value length under 16", json => json["peek"]!["rowCellChars"] = 8)
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
        foreach (var (spec, parent) in Variants(peek))
            for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
            {
                var render = new SqlRender(band);
                var batch = PeekSql.Render(spec, render, peek.DefinitionChars, parent);
                var name = spec.Kind + (parent is null ? "" : " of a " + parent) + " " + band;
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
                if (spec.Module != batch.Text.Contains("LEFT(m.definition, 1000001) AS [definition]", StringComparison.Ordinal)) problems.Add(name + ": its module text");
                // Each list reads the catalogue's columns first, in order, then its helpers; User mapping reads databases instead.
                var lists = spec.ListSpecs.Where(list => list.Id != "userMapping").ToList();
                if (!batch.Lists.Select(list => list.Id).SequenceEqual(lists.Select(list => list.Id)) || batch.Mapping != spec.ListSpecs.Any(list => list.Id == "userMapping")
                    || batch.Lists.Zip(lists).Any(pair => !pair.First.Columns.Take(pair.Second.Columns.Count).SequenceEqual(pair.Second.Columns.Select(column => column.Id))))
                    problems.Add(name + ": its lists are not the catalogue's");
                if (batch.Mapping != batch.Text.Contains(PeekSql.MappingDatabases, StringComparison.Ordinal)) problems.Add(name + ": User mapping's databases");
                if (batch.Lists.Count + (batch.Mapping ? 1 : 0) > 0 && System.Text.RegularExpressions.Regex.Matches(batch.Text, @"SELECT TOP \(@take\) ").Count != batch.Lists.Count + (batch.Mapping ? 1 : 0))
                    problems.Add(name + ": a list without TOP (@take)");
            }
        check(renders == 102 && problems.Count == 0, "every peek kind (an index and a trigger below each parent kind) renders for bands 12-17, passes the lint, and reads the catalogue's facts in order "
            + "as their ids, then its helpers, its lists and its optional group (" + renders + " renders" + (problems.Count > 0 ? "; first problem: " + problems[0] : ")"));
        var mappingProblems = CatalogSql.Lint(PeekSql.MappingUsers, new SqlRender(ExplorerCatalog.MinBand), list: false, mayCheckAccess: false);
        check(mappingProblems.Count == 0 && PeekSql.MappingUsers.Contains("sp.name = @object_name", StringComparison.Ordinal) && !PeekSql.MappingUsers.Contains("sql_logins", StringComparison.Ordinal),
            "User mapping's statement in each database passes the lint and finds the login's user by its SID, through the login's name: " + string.Join(", ", mappingProblems));
        var index = PeekSql.Render(peek.Kinds["index"], new SqlRender(17), peek.DefinitionChars, "table");
        var usage = index.Text[index.Text.IndexOf("BEGIN TRY", StringComparison.Ordinal)..];
        check(usage.Contains("sys.dm_db_index_usage_stats", StringComparison.Ordinal) && usage.Contains("IF ERROR_NUMBER() NOT IN (229, 297, 300) THROW;", StringComparison.Ordinal)
            && index.Text.IndexOf("sys.dm_db_index_usage_stats", StringComparison.Ordinal) > index.Text.IndexOf("FROM sys.index_columns", StringComparison.Ordinal)
            && !PeekSql.Render(peek.Kinds["index"], new SqlRender(14), peek.DefinitionChars, "view").Text.Contains("optimize_for_sequential_key", StringComparison.Ordinal),
            "an index's usage is read last, inside TRY…CATCH that answers a refusal and raises any other error, and its band 15 option is left out below it");
        var refusedLookup = false;
        try { PeekSql.Render(peek.Kinds["trigger"], new SqlRender(17), peek.DefinitionChars, "tableType"); } catch (InvalidOperationException) { refusedLookup = true; }
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
                if (PeekSql.Render(spec, new SqlRender(band), peek.DefinitionChars, parent).Text.Contains("sql_expression_dependencies", StringComparison.OrdinalIgnoreCase)) dependencyProblems.Add(spec.Kind + " " + band + ": the facts read dependencies");
        }
        var synonymUses = PeekSql.Dependencies("synonym", new SqlRender(17));
        var typeUses = PeekSql.Dependencies("type", new SqlRender(17));
        check(dependencyProblems.Count == 0 && synonymUses.Contains("PARSENAME(sy.base_object_name, 1)", StringComparison.Ordinal) && typeUses.Contains("d.referenced_class = 6", StringComparison.Ordinal)
            && typeUses.Contains("sys.all_parameters", StringComparison.Ordinal),
            "each kind with a Dependencies tab has a batch, for bands 12-17, that finds the object, then lists both ways (a synonym's base object, what uses a type), passes the lint, and the facts batch reads no dependencies"
            + (dependencyProblems.Count > 0 ? ": " + dependencyProblems[0] : ""));
        var table = peek.Kinds["table"];
        var old = PeekSql.Render(table, new SqlRender(12), peek.DefinitionChars);
        var newest = PeekSql.Render(table, new SqlRender(17), peek.DefinitionChars);
        check(!old.Text.Contains("temporal_type") && !old.Text.Contains("ledger_type") && !old.Columns.Contains("temporal") && newest.Text.Contains("t.temporal_type_desc AS [temporal]")
            && newest.Text.Contains("t.ledger_type_desc AS [ledger]") && newest.Text.Contains("ep.name = N'microsoft_database_tools_support'"),
            "a table's temporal and ledger facts appear only from their bands, and System object counts tools-support objects as the tree does");
        // The lint still refuses what the batches avoid.
        check(CatalogSql.Lint(newest.Text, new SqlRender(13), false, false).Any(problem => problem.Contains("ledger_type")), "a table's band 17 batch fails the lint on a band 13 server");
    }

    /// <summary>Each peek kind with the parent kinds it is found below (none for a kind that is not a child).</summary>
    private static IEnumerable<(PeekKindSpec Spec, string? Parent)> Variants(CatalogPeek peek) =>
        peek.Kinds.Values.SelectMany(spec => PeekSql.Parents.TryGetValue(spec.Kind, out var parents) ? parents.Select(parent => (spec, (string?)parent)) : [(spec, null)]);

    private static void RowsSql(Action<bool, string> check)
    {
        var problems = new List<string>();
        foreach (var kind in new[] { "table", "view" })
        {
            var text = PeekRowsSql.Render(kind);
            problems.AddRange(PeekRowsSql.Lint(text, kind).Select(problem => kind + ": " + problem));
        }
        check(problems.Count == 0, "Peek's rows batch finds the table or view first and passes its lint: " + string.Join(" | ", problems));
        var rendered = PeekRowsSql.Render("table");
        check(PeekRowsSql.TextSize == (ExplorerCatalog.Current.Peek.RowCellChars + 1) * 4 && rendered.Contains("N'SET TEXTSIZE 1028; BEGIN TRY SELECT TOP (@take) * FROM '", StringComparison.Ordinal)
            && rendered.Contains("BEGIN CATCH IF ERROR_NUMBER() <> 10794 THROW; SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SELECT TOP (@take) * FROM '", StringComparison.Ordinal)
            && !rendered.Contains("filegroups", StringComparison.Ordinal),
            "Peek's rows limit large values with SET TEXTSIZE (four bytes a character, one past the cap) and read again under READ COMMITTED only after error 10794");
        var refused = false;
        try { PeekRowsSql.Render("procedure"); } catch (InvalidOperationException) { refused = true; }
        check(refused, "Peek renders no rows batch for a procedure");
        var table = PeekRowsSql.Render("table");
        var mutants = new (string Name, string Text)[]
        {
            ("a name outside QUOTENAME", table.Replace("QUOTENAME(@object_name)", "@object_name", StringComparison.Ordinal)),
            ("QUOTENAME of another value", table.Replace("QUOTENAME(@object_name)", "QUOTENAME(@fname)", StringComparison.Ordinal)),
            ("another literal", table.Replace("N'; END CATCH;'", "N'; END CATCH; DROP TABLE x;'", StringComparison.Ordinal)),
            ("a second dynamic statement", table + "EXEC sys.sp_executesql @rows;\n"),
            ("EXEC of a string", table + "EXEC (@rows);\n"),
            ("a metadata built-in", table.Replace("QUOTENAME(@object_schema)", "QUOTENAME(OBJECT_SCHEMA_NAME(@object_id))", StringComparison.Ordinal)),
            ("the database parameter", table + "SELECT @db;\n"),
            ("a name copied into another variable", table.Replace("DECLARE @rows", "DECLARE @n sysname = @object_name;\nDECLARE @rows", StringComparison.Ordinal).Replace("QUOTENAME(@object_name)", "@n", StringComparison.Ordinal)),
            ("a name assigned to a declared variable", table.Replace("EXEC sys.sp_executesql", "SET @rows = @rows + @object_name;\nEXEC sys.sp_executesql", StringComparison.Ordinal)),
            ("the rows read without the lookup", table[CatalogSql.ParentLookup("table").Length..])
        };
        var passed = mutants.Where(mutant => PeekRowsSql.Lint(mutant.Text, "table").Count == 0).Select(mutant => mutant.Name).ToList();
        check(passed.Count == 0, "Peek's rows lint refuses names outside QUOTENAME, other literals and other dynamic SQL: " + string.Join(", ", passed));
    }

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
        // The rows page: shown values as text (binary as 0x…), cut ones and unreadable ones listed apart.
        var builder = new Varia.Backend.Results.PageBuilder(1, [Varia.Backend.Results.WireKind.Text, Varia.Backend.Results.WireKind.Binary, Varia.Backend.Results.WireKind.Text]);
        builder.BeginRow(); builder.AppendText("a"); builder.AppendBinary([0xAB, 0x01]); builder.AppendText("hidden"); builder.CommitRow();
        builder.BeginRow(); builder.AppendNull(error: true); builder.AppendBinary([0xFF], truncated: true); builder.AppendNull(); builder.CommitRow();
        builder.BeginRow(); builder.AppendText(new string('x', 300)); builder.AppendNull(); builder.AppendNull(); builder.CommitRow();
        var page = PeekRowsSql.FromPage(builder.Seal(), 3, 3, [new("A", "nvarchar"), new("B", "varbinary")], 1, 256);
        check(page.Rows.Count == 3 && page.Rows[0] is ["a", "0xAB01"] && page.Rows[1] is [null, "0xFF"] && page.Rows[2][0] is { Length: 256 } && page.Rows[2][1] is null
            && page.Unread is [[1, 0]] && page.Cut is { Count: 2 } cut && cut.Any(cell => cell is [1, 1]) && cut.Any(cell => cell is [2, 0]) && page.MoreColumns == 1,
            "a rows page shows the shown columns as text, binary as 0x…, lists cut values, and lists a value the readers could not read apart from NULL: "
            + JsonSerializer.Serialize(new { page.Rows, page.Cut, page.Unread }));
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
        var pair = new string('x', 9) + "\U0001F600";
        check(PeekSql.Cut("abc", 3) == ("abc", false) && PeekSql.Cut("abcd", 3) == ("abc", true) && PeekSql.Cut(pair, 10) == (new string('x', 9), true) && PeekSql.Cut(pair, 11) == (pair, false),
            "module text is cut at the limit, never inside a surrogate pair, and marked cut only when it was");
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
            async Task<string> Rows(string body)
            {
                try { await sql.DispatchAsync("explorer.peekRows", JsonDocument.Parse(body).RootElement, Json); return "ok"; }
                catch (RequestException error) { return error.Code; }
                catch (JsonException) { return "JSON"; }
            }
            var rows = new[] { await Rows(Body(Ref("procedure"))), await Rows(Body(Ref("synonym"))), await Rows(Body(Ref("table"), connection: "x")), await Rows(Body(Ref("view"))) };
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
            check(sql.Methods.Contains("explorer.peekRows") && sql.LaneOf("explorer.peekRows") == RequestLane.Explorer && rows.SequenceEqual(["INVALID_PARAMS", "INVALID_PARAMS", "INVALID_PARAMS", "NOT_CONNECTED"]),
                "HELLO lists explorer.peekRows on the explorer lane, and it refuses procedures, other kinds and bad ids before the connection: " + string.Join(", ", rows));
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
        var shaped = JsonSerializer.Serialize(new PeekResult(new() { ["schema"] = "dbo", ["rowCount"] = 3L, ["temporal"] = null, ["systemObject"] = false }, 4, "CREATE VIEW v AS SELECT 1", true), Json);
        check(shaped == "{\"facts\":{\"schema\":\"dbo\",\"rowCount\":3,\"temporal\":null,\"systemObject\":false},\"elapsedMs\":4,\"definition\":\"CREATE VIEW v AS SELECT 1\",\"definitionTruncated\":true}",
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
        var failedRows = await service.PeekRowsAsync(new PeekRowsArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new ObjectRefDto("table", "Sales", "dbo", "Orders")), CancellationToken.None);
        var rowsJson = JsonSerializer.Serialize(failedRows, Json);
        check(failedRows is { Error.Retryable: true, Columns.Count: 0, Rows.Count: 0 } && service.RunningCount == 0 && rowsJson.StartsWith("{\"columns\":[],\"rows\":[],\"elapsedMs\":", StringComparison.Ordinal),
            "a rows read that cannot reach the server is a retryable error value with no columns or rows, and unregisters: " + rowsJson);
        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel();
            var before = host.Connections;
            try { await service.PeekAsync(new PeekArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target), cancelled.Token); check(false, "a cancelled peek runs"); }
            catch (OperationCanceledException) { check(host.Connections == before && service.RunningCount == 0, "a peek cancelled before it runs opens nothing and is unregistered"); }
        }
    }
}
