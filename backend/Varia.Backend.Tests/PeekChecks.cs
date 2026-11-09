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
        check(peek.Kinds.Keys.Order(StringComparer.Ordinal).SequenceEqual(["function", "procedure", "table", "view"]) && peek.DefinitionChars == 1_000_000 && peek.BudgetMs == 15_000
            && peek.Kinds["table"].Definition == "script" && peek.Kinds["view"].Module && peek.Kinds["procedure"].Module && peek.Kinds["function"].Module,
            "the catalogue's peek block lists tables (scripted), views, procedures and functions (module text), with its limits");
        check(peek.Dependencies == 200, "Peek lists 200 dependencies each way");
        // Top rows runs Select Top Rows' script through query.execute: the catalogue gives the backend no rows of its own to read.
        JsonObject embedded;
        using (var stream = typeof(ExplorerCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Explorer.explorer-catalog.json")!) embedded = JsonNode.Parse(stream)!["peek"]!.AsObject();
        check(embedded.Select(item => item.Key).Order(StringComparer.Ordinal).SequenceEqual(["budgetMs", "definitionChars", "dependencies", "kinds"])
            && embedded["kinds"]!.AsArray().All(kind => kind!.AsObject().Select(item => item.Key).Order(StringComparer.Ordinal).SequenceEqual(["definition", "facts", "kind"])),
            "the catalogue's peek block holds kinds, the definition length, the budget and the dependencies, and nothing for rows: " + embedded.ToJsonString());
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
            ("a kind that is not a schema object", json => Kind(json, "view")["kind"] = "login"),
            ("a kind twice", json => Kind(json, "view")["kind"] = "table"),
            ("a definition budget of zero", json => json["peek"]!["definitionChars"] = 0),
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
        foreach (var spec in peek.Kinds.Values)
            for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
            {
                var render = new SqlRender(band);
                var batch = PeekSql.Render(spec, render, peek.DefinitionChars);
                renders++;
                problems.AddRange(CatalogSql.Lint(batch.Text, render, list: false, mayCheckAccess: false).Select(problem => spec.Kind + " " + band + ": " + problem));
                List<string> expected = [.. spec.FactsFor(band).Select(fact => fact.Id), .. PeekSql.Extras(spec)];
                List<string> aliases = [.. Alias().Matches(batch.Text).Select(match => match.Groups[1].Value)];
                if (!batch.Columns.SequenceEqual(expected) || !aliases.SequenceEqual(expected)) problems.Add(spec.Kind + " " + band + ": its columns are " + string.Join(",", aliases));
                if (!batch.Text.StartsWith(CatalogSql.ParentLookup(spec.Kind), StringComparison.Ordinal) || !batch.Text.EndsWith("WHERE o.object_id = @object_id;\n", StringComparison.Ordinal))
                    problems.Add(spec.Kind + " " + band + ": it does not find the object first and read it by id");
                if (spec.Module != batch.Text.Contains("LEFT(m.definition, 1000001) AS [definition]", StringComparison.Ordinal)) problems.Add(spec.Kind + " " + band + ": its module text");
            }
        check(renders == 24 && problems.Count == 0, "every peek kind renders for bands 12-17, passes the lint, and reads the catalogue's facts in order as their ids, then its helpers ("
            + renders + " renders" + (problems.Count > 0 ? "; first problem: " + problems[0] : ")"));
        // Dependencies are their own request: sys.sql_expression_dependencies needs more than VIEW DEFINITION, and a login refused
        // it must still get the facts.
        var dependencyProblems = new List<string>();
        foreach (var spec in peek.Kinds.Values)
        {
            for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
            {
                var render = new SqlRender(band);
                var text = PeekSql.Dependencies(spec.Kind, render);
                dependencyProblems.AddRange(CatalogSql.Lint(text, render, list: false, mayCheckAccess: false).Select(problem => spec.Kind + " " + band + ": " + problem));
                if (text != CatalogSql.ParentLookup(spec.Kind) + PeekSql.Uses(render) + PeekSql.UsedBy(render)) dependencyProblems.Add(spec.Kind + ": it does not find the object first");
            }
            for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
                if (PeekSql.Render(spec, new SqlRender(band), peek.DefinitionChars).Text.Contains("sql_expression_dependencies", StringComparison.OrdinalIgnoreCase)) dependencyProblems.Add(spec.Kind + " " + band + ": the facts read dependencies");
        }
        check(dependencyProblems.Count == 0, "each kind's dependencies batch, for bands 12-17, finds the object, then lists both ways, passes the lint, and the facts batch reads no dependencies"
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
                await Code(Body("{\"kind\":\"database\",\"name\":\"Sales\"}")),
                await Code(Body(Ref("synonym"))),
                await Code(Body(Ref("table", name: null))),
                await Code(Body(Ref("view", name: new string('v', 129)))),
                await Code(Body(Ref("view", schema: new string('s', 129)))),
                await Code(Body("{\"kind\":\"table\",\"database\":\"Sales\",\"schema\":\"dbo\",\"name\":\"Orders\",\"extra\":1}")),
                await Code(Body(Ref("procedure", name: new string('p', 128))))
            };
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
        var shaped = JsonSerializer.Serialize(new PeekResult(new() { ["schema"] = "dbo", ["rowCount"] = 3L, ["temporal"] = null, ["systemObject"] = false }, 4, "CREATE VIEW v AS SELECT 1", true), Json);
        check(shaped == "{\"facts\":{\"schema\":\"dbo\",\"rowCount\":3,\"temporal\":null,\"systemObject\":false},\"elapsedMs\":4,\"definition\":\"CREATE VIEW v AS SELECT 1\",\"definitionTruncated\":true}",
            "a peek reply keeps null facts and drops the members it does not have: " + shaped);
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
