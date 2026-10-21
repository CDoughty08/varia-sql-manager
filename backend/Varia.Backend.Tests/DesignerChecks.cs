using System.Text.Json;
using System.Text.Json.Nodes;
using Varia.Backend.Actions;
using Varia.Backend.Designer;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Offline table designer checks: the embedded catalogue, validation parity with zod (src/shared/designer/schema.ts),
/// the change script's minimal quoting and goldens (tests/fixtures/designer), the bracketed statements, and the lint over
/// every builder and catalog statement with mutations it must catch.</summary>
internal static class DesignerChecks
{
    private static readonly DesignerCatalog Catalog = DesignerCatalog.Current;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static void Run(Action<bool, string> check)
    {
        CatalogChecks(check);
        Validation(check);
        Names(check);
        Goldens(check);
        Lint(check);
    }

    private static void CatalogChecks(Action<bool, string> check)
    {
        var listed = Catalog.Types.Where(type => type.Unlisted != true).Select(type => type.Name).ToList();
        check(DesignerCatalog.Version == 1 && Catalog.Describes.SetEquals(["tableDesigner"]) && Catalog.Requests.SetEquals(["createTable"]) && listed.Count == 35 && listed[0] == "bigint" && listed[^1] == "xml"
            && Catalog.Type("vector") is { Unlisted: true, Since: 17, Params: "dimensions" } && Catalog.Type("json") is { Since: 17, Lob: true } && Catalog.IdOf("bigint") == 0 && Catalog.IdOf("nope") == -1,
            "the embedded designer catalogue is version 1: SSMS's 35 listed types in order, json and vector from band 17, and the describe and request ids");
        check(Catalog.Limit("columns") == 1_024 && Catalog.Limit("keyColumns") == 32 && Catalog.Limit("designChars") == 400_000 && Catalog.Limit("scriptChars") == 1_000_000
            && Catalog.Limit("schemas") == 2_048 && Catalog.Bound("precision", max: true) == 38 && Catalog.Bound("dimensions", max: true) == 1998,
            "the designer's limits equal TypeScript's: 1,024 columns, 32 key columns, a 400,000-unit design, a 1,000,000-character script");
    }

    private static TableDesignDto Design(params DesignColumnDto[] columns) => new("dbo", "T", [.. columns], []);
    private static DesignColumnDto Column(string name, string type, int? length = null, bool nulls = true, DesignIdentityDto? identity = null, bool? max = null, int? precision = null, int? scale = null,
        int? dimensions = null) => new(name, new DesignTypeDto(type, length, max, precision, scale, dimensions), nulls, identity);

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new NoHost());
        string Verdict(ActionArgs args)
        {
            try { service.Validate(args); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        ActionArgs Create(TableDesignDto? design, ObjectRefDto? target = null) => new("createTable", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target ?? new ObjectRefDto("database", Name: "master"), Design: design);
        var id = new DesignIdentityDto("1", "1");
        var good = Design(Column("Id", "int", nulls: false, identity: id), Column("Name", "nvarchar", 50)) with { PrimaryKey = [0] };
        var many = Enumerable.Range(0, 1_025).Select(index => Column("c" + index, "int")).ToArray();
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("no design", Create(null)), ("a table target", Create(good, new ObjectRefDto("table", "master", "dbo", "T"))), ("a new name", Create(good) with { NewName = "x" }),
            ("delete options", Create(good) with { CloseConnections = false }), ("1,025 columns", Create(Design(many))), ("no columns", Create(Design())),
            ("a 129-unit table name", Create(good with { Name = new string('t', 129) })), ("a 129-unit column name", Create(Design(Column(new string('c', 129), "int")))),
            ("U+0000 in a schema", Create(good with { Schema = "d\0bo" })), ("an empty column name", Create(Design(Column("", "int")))), ("a column twice", Create(Design(Column("a", "int"), Column("a", "bit")))),
            ("an unknown type", Create(Design(Column("a", "varchar2")))), ("char(8001)", Create(Design(Column("a", "char", 8001)))), ("nchar(MAX)", Create(Design(Column("a", "nchar", max: true)))),
            ("varchar(MAX) with a length", Create(Design(Column("a", "varchar", 10, max: true)))), ("max false", Create(Design(Column("a", "varchar", 10, max: false)))),
            ("decimal(39, 0)", Create(Design(Column("a", "decimal", precision: 39, scale: 0)))), ("decimal(5, 6)", Create(Design(Column("a", "decimal", precision: 5, scale: 6)))),
            ("time(8)", Create(Design(Column("a", "time", scale: 8)))), ("vector(0)", Create(Design(Column("a", "vector", dimensions: 0)))), ("int(4)", Create(Design(Column("a", "int", 4)))),
            ("a length on decimal", Create(Design(Column("a", "decimal", 4, precision: 5, scale: 0)))), ("two identities", Create(Design(Column("a", "int", nulls: false, identity: id), Column("b", "int", nulls: false, identity: id)))),
            ("an identity on varchar", Create(Design(Column("a", "varchar", 10, nulls: false, identity: id)))), ("an identity on decimal(5, 2)", Create(Design(Column("a", "decimal", precision: 5, scale: 2, nulls: false, identity: id)))),
            ("a nullable identity", Create(Design(Column("a", "int", identity: id)))), ("an increment of 0", Create(Design(Column("a", "int", nulls: false, identity: new("1", "-000"))))),
            ("a 39-digit seed", Create(Design(Column("a", "int", nulls: false, identity: new(new string('9', 39), "1"))))), ("a seed with a space", Create(Design(Column("a", "int", nulls: false, identity: new(" 1", "1"))))),
            ("two timestamps", Create(Design(Column("a", "timestamp"), Column("b", "timestamp")))), ("a key out of range", Create(good with { PrimaryKey = [2] })), ("a key column twice", Create(good with { PrimaryKey = [0, 0] })),
            ("a negative key index", Create(good with { PrimaryKey = [-1] })), ("a nullable key column", Create(good with { PrimaryKey = [1] })),
            ("33 key columns", Create(Design([.. Enumerable.Range(0, 33).Select(index => Column("c" + index, "int", nulls: false))]) with { PrimaryKey = [.. Enumerable.Range(0, 33)] })),
            ("a design on rename", new("rename", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new ObjectRefDto("table", "db", "dbo", "T"), NewName: "U", Design: good))
        };
        var accepted = invalid.Where(item => Verdict(item.Args) != "INVALID_PARAMS").Select(item => item.Name).ToList();
        check(accepted.Count == 0, "the backend refuses every createTable zod refuses: " + string.Join(", ", accepted));
        var valid = new (string Name, ActionArgs Args)[]
        {
            ("an identity primary key", Create(good)), ("master as the database", Create(good, new ObjectRefDto("database", Name: "tempdb"))),
            ("every listed type with its defaults", Create(Design([.. Catalog.Types.Select((type, index) => Column("c" + index, type.Name, type.Params is "length" or "nlength" ? type.Length : null,
                precision: type.Precision, scale: type.Params is "precisionScale" or "scale" ? type.Scale : null, dimensions: type.Dimensions))]))),
            ("the (MAX) forms", Create(Design(Column("a", "varchar", max: true), Column("b", "nvarchar", max: true), Column("c", "varbinary", max: true)))),
            ("a 38-digit seed and a negative increment", Create(Design(Column("a", "decimal", precision: 38, scale: 0, nulls: false, identity: new("-" + new string('9', 38), "-1"))))),
            ("1,024 columns and 32 key columns", Create(Design([.. Enumerable.Range(0, 1_024).Select(index => Column("c" + index, "int", nulls: false))]) with { PrimaryKey = [.. Enumerable.Range(0, 32)] }))
        };
        var refused = valid.Where(item => Verdict(item.Args) != "accepted").Select(item => item.Name).ToList();
        check(refused.Count == 0, "the backend accepts the designs zod accepts: " + string.Join(", ", refused));
        var plan = TableDesignValidator.Validate(Catalog, Design(Column("a", "int", nulls: false, identity: new("-0007", "001"))));
        check(plan.Columns[0] is { Seed: "-7", Increment: "1", Identity: true } && TableDesignValidator.Canonical("-0") == "0" && TableDesignValidator.Canonical("000") == "0"
            && TableDesignValidator.PrimaryKeyName(new string('t', 125) + "\U0001F600") == "PK_" + new string('t', 125) && TableDesignValidator.PrimaryKeyName("T") == "PK_T",
            "seeds and increments are written as SQL Server writes them, and PK_<table> is cut to a sysname without splitting a surrogate pair");
        string Describe(string dialog, ObjectRefDto target)
        {
            try { service.Validate(new ActionDescribeArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), dialog, target)); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        check(Describe("tableDesigner", new ObjectRefDto("database", Name: "master")) == "accepted" && Describe("tableDesigner", new ObjectRefDto("table", "db", "dbo", "T")) == "INVALID_PARAMS"
            && Describe("tableDesigner", new ObjectRefDto("database", "db", Name: "x")) == "INVALID_PARAMS" && Describe("tableDesignerX", new ObjectRefDto("database", Name: "x")) == "INVALID_PARAMS",
            "the designer's describe takes a database, SQL Server's own included, and nothing else");
    }

    private static void Names(Action<bool, string> check)
    {
        var bare = new[] { "dbo", "_x1", "a$", "Table_1", "x@y#" };
        var bracketed = new[] { "select", "Select", "GO", "go", "a b", "1a", "@x", "#t", "a]b", "Ünïcode", "", "a-b", "TRY_CONVERT" };
        check(bare.All(name => DesignerSql.ScriptName(Catalog, name) == name) && bracketed.All(name => DesignerSql.ScriptName(Catalog, name) == ScriptingQuote(name)),
            "the change script leaves only regular identifiers that are not reserved keywords or GO bare, as SSMS does, and brackets the rest with ]] doubled");
    }

    private static string ScriptingQuote(string name) => "[" + name.Replace("]", "]]") + "]";

    /// <summary>tests/fixtures/designer: each case's change script equals its golden (source "varia" until the owner captures
    /// SSMS 22's; VARIA_UPDATE_SCRIPT_GOLDENS=1 rewrites those), and its statements bracket every name.</summary>
    private static void Goldens(Action<bool, string> check)
    {
        var folder = Path.Combine(GoldenText.Repository(), "tests", "fixtures", "designer");
        var updating = Environment.GetEnvironmentVariable("VARIA_UPDATE_SCRIPT_GOLDENS") == "1";
        var manifestPath = Path.Combine(folder, "golden", "manifest.json");
        var manifest = File.Exists(manifestPath) ? JsonNode.Parse(File.ReadAllText(manifestPath))!["files"]!.AsObject().ToDictionary(item => item.Key, item => item.Value!.GetValue<string>()) : [];
        var differences = new List<string>();
        var unbracketed = new List<string>();
        var cases = JsonNode.Parse(File.ReadAllText(Path.Combine(folder, "cases.json")))!["cases"]!.AsArray();
        foreach (var item in cases)
        {
            var id = item!["id"]!.GetValue<string>();
            var plan = TableDesignValidator.Validate(Catalog, item["design"].Deserialize<TableDesignDto>(Json));
            var filegroup = item["filegroup"]!.GetValue<string>();
            var script = DesignerSql.Script(Catalog, plan, filegroup).ReplaceLineEndings("\n");
            var file = Path.Combine(folder, "golden", id + ".sql");
            var source = manifest.GetValueOrDefault(id + ".sql", "varia");
            if (updating && source == "varia") { File.WriteAllText(file, script); manifest[id + ".sql"] = "varia"; }
            else if (!File.Exists(file) || File.ReadAllText(file).ReplaceLineEndings("\n") != script) differences.Add(id);
            var statements = DesignerSql.Statements(plan, filegroup);
            var names = plan.Columns.Select(column => column.Name).Append(plan.Schema).Append(plan.Name).Append(filegroup).ToList();
            if (!names.All(name => statements[0].Text.Contains(ScriptingQuote(name), StringComparison.Ordinal))
                || statements.Any(statement => !statement.Text.Contains(ScriptingQuote(plan.Schema) + "." + ScriptingQuote(plan.Name), StringComparison.Ordinal))
                || plan.PrimaryKey.Count > 0 && !statements[1].Text.Contains(ScriptingQuote(plan.PrimaryKeyName), StringComparison.Ordinal))
                unbracketed.Add(id);
        }
        if (updating)
            File.WriteAllText(manifestPath, new JsonObject { ["files"] = new JsonObject(manifest.OrderBy(item => item.Key, StringComparer.Ordinal).Select(item => KeyValuePair.Create(item.Key, (JsonNode?)JsonValue.Create(item.Value)))) }
                .ToJsonString(new JsonSerializerOptions { WriteIndented = true }).ReplaceLineEndings("\n") + "\n");
        check(differences.Count == 0 && cases.Count == 5, "each designer case's change script equals its golden in tests/fixtures/designer/golden: " + string.Join(", ", differences));
        check(unbracketed.Count == 0, "every statement Save runs for the fixture designs brackets every name: " + string.Join(", ", unbracketed));
        var lob = TableDesignValidator.Validate(Catalog, Design(Column("a", "int"), Column("b", "varchar", max: true)));
        var plain = TableDesignValidator.Validate(Catalog, Design(Column("a", "int"), Column("b", "hierarchyid"), Column("c", "vector", dimensions: 3)));
        check(DesignerSql.Statements(lob, "FG 1")[0].Text.EndsWith(") ON [FG 1] TEXTIMAGE_ON [FG 1]", StringComparison.Ordinal) && DesignerSql.Statements(plain, "PRIMARY")[0].Text.EndsWith(") ON [PRIMARY]", StringComparison.Ordinal)
            && DesignerSql.Statements(plain, "PRIMARY").Select(statement => statement.Part).SequenceEqual([DesignerPart.CreateTable, DesignerPart.LockEscalation]),
            "TEXTIMAGE_ON follows only a column stored off-row, and a table without a key skips the key's step");
        var keyed = Design(Column("a]", "decimal", precision: 9, scale: 0, nulls: false, identity: new("05", "2"))) with { PrimaryKey = [0] };
        var json = JsonNode.Parse(DesignerSql.DesignJson(Catalog, TableDesignValidator.Validate(Catalog, keyed), "P G"))!;
        check(json["schema"]!.GetValue<string>() == "dbo" && json["pk"]!.GetValue<string>() == "PK_T" && json["filegroup"]!.GetValue<string>() == "P G" && json["key"]!.AsArray().Single()!.GetValue<int>() == 0
            && json["columns"]![0]!["type"]!.GetValue<int>() == Catalog.IdOf("decimal") && json["columns"]![0]!["seed"]!.GetValue<string>() == "5" && json["columns"]![0]!["name"]!.GetValue<string>() == "a]"
            && json["columns"]![0]!["nullable"]!.GetValue<bool>() == false && json["columns"]![0]!["max"]!.GetValue<bool>() == false,
            "the builders' one parameter carries names verbatim, types by catalogue id, typed numbers and canonical seeds");
    }

    private static void Lint(Action<bool, string> check)
    {
        var results = DesignerSql.Lint(Catalog).ToList();
        var failing = results.Where(result => result.Problems.Count > 0).Select(result => result.Name + ": " + string.Join("; ", result.Problems)).ToList();
        check(failing.Count == 0 && results.Count == 6 + 2 * (ExplorerCatalog.MaxBand - ExplorerCatalog.MinBand + 1) + 1,
            "every table designer builder (run and dry run) and catalog statement passes its lint: " + string.Join(" | ", failing.Take(3)));
        var good = DesignerSql.Builder(Catalog, DesignerPart.CreateTable);
        var rules = new DesignBuilderRules(DesignerSql.Messages, Catalog.Types.Select(type => type.Name).ToHashSet(StringComparer.Ordinal));
        var mutations = new (string Name, string Text)[]
        {
            ("a raw column name", good.Replace("QUOTENAME(j.[name]) + N' ' + t.keyword", "j.[name] + N' ' + t.keyword", StringComparison.Ordinal)),
            ("a raw schema", good.Replace("QUOTENAME(d.[schema])", "d.[schema]", StringComparison.Ordinal)),
            ("a raw filegroup", good.Replace("@filegroup = QUOTENAME(d.filegroup)", "@filegroup = d.filegroup", StringComparison.Ordinal)),
            ("@db outside QUOTENAME", good.Replace("QUOTENAME(@db) + N'.sys.sp_executesql'", "@db + N'.sys.sp_executesql'", StringComparison.Ordinal)),
            ("@design concatenated", good.Replace("N'CREATE TABLE ' + @table", "N'CREATE TABLE ' + @design", StringComparison.Ordinal)),
            ("a JSON element concatenated", good.Replace("OPENJSON(a.value)", "OPENJSON(N'[]') + a.value", StringComparison.Ordinal)),
            ("@columns concatenated", good.Replace("N' (' + @body", "N' (' + @columns", StringComparison.Ordinal)),
            ("an undeclared variable", good.Replace("+ @body +", "+ @other +", StringComparison.Ordinal)),
            ("a quote in a literal", good.Replace("N' NOT NULL'", "N' NOT NULL''", StringComparison.Ordinal)),
            ("a comment literal", good.Replace("N' NOT NULL'", "N' NOT NULL --'", StringComparison.Ordinal)),
            ("an unknown type keyword", good.Replace("N'bigint'", "N'bogus'", StringComparison.Ordinal)),
            ("no quoting guard", good.Replace(ActionSql.Guard, "", StringComparison.Ordinal)),
            ("a format hole", good.Replace("N'CREATE TABLE '", "N'CREATE TABLE {0}'", StringComparison.Ordinal))
        };
        var missed = mutations.Where(mutation => mutation.Text == good || ActionSql.LintExecutable(mutation.Text, rules).Count == 0).Select(mutation => mutation.Name).ToList();
        check(missed.Count == 0 && ActionSql.LintExecutable(good, rules).Count == 0, "the designer builder lint catches every mutation that would let request text reach a statement: " + string.Join(", ", missed));
    }

    private sealed class NoHost : IActionHost
    {
        public ServerProfile Profile(string connectionId) => throw new RequestException("NOT_CONNECTED", "Not connected.");
        public Microsoft.Data.SqlClient.SqlConnection Connection(string connectionId) => throw new InvalidOperationException();
        public Task OpenAsync(Microsoft.Data.SqlClient.SqlConnection connection, CancellationToken token) => Task.CompletedTask;
        public bool ClearPoolsFor(string connectionId, string database) => false;
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
    }
}
