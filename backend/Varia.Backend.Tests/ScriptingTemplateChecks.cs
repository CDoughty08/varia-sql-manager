using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of SSMS's SELECT, INSERT, UPDATE, DELETE and EXECUTE templates over synthetic catalog rows
/// (spec B9, C6), the type text they use, and how the pipeline frames them.</summary>
internal static class ScriptingTemplateChecks
{
    private static readonly string NL = Environment.NewLine;
    private static string Lines(params string[] lines) => string.Join(NL, lines);

    private static TypeRow T(string name, int maxLength = 0, int precision = 0, int scale = 0) => new(name, "sys", false, maxLength, precision, scale);
    private static ColumnRow C(string name, TypeRow? type = null) => new(name, type ?? T("int", 4, 10));
    private static ParameterRow P(int id, string name, TypeRow? type = null, bool output = false, bool readOnly = false) => new(id, name, type ?? T("int", 4, 10), output, readOnly);

    public static void Run(Action<bool, string> check)
    {
        TypeText(check);
        Templates(check);
        Rules(check);
        Execute(check);
        Pipeline(check);
        Normalization(check);
    }

    /// <summary>The golden normalization (spec G5) on the vectors tests/scripting-goldens.test.ts also runs through
    /// scripts/compare-ssms-scripts.mjs, so the two implementations cannot drift apart.</summary>
    private static void Normalization(Action<bool, string> check)
    {
        var golden = GoldenText.Load();
        var vectors = System.Text.Json.Nodes.JsonNode.Parse(File.ReadAllText(Path.Combine(golden.Folder, "normalize-cases.json")))!["cases"]!.AsArray();
        var wrong = vectors.Where(vector => golden.Normalize(vector!["input"]!.GetValue<string>()) != vector["output"]!.GetValue<string>()).Select(vector => vector!["name"]!.GetValue<string>()).ToList();
        check(wrong.Count == 0 && vectors.Count >= 10, "golden normalization matches the shared vectors: " + string.Join(", ", wrong));
        check(GoldenText.FirstDifference("a\nb\tc\n", "a\nb c\n") == "line 2: expected `b\\tc` but got `b c`" && golden.Manifest.Count > 150
            && golden.Manifest.Keys.All(key => File.Exists(Path.Combine(golden.GoldenFolder, key))), "goldens report their first difference, and every manifest entry has its file");
    }

    private static void TypeText(Action<bool, string> check)
    {
        var cases = new (TypeRow Type, string Expected)[]
        {
            (T("int", 4, 10), "int"), (T("bigint", 8, 19), "bigint"), (T("smallint", 2, 5), "smallint"), (T("tinyint", 1, 3), "tinyint"), (T("bit", 1, 1), "bit"),
            (T("float", 8, 53), "float"), (T("real", 4, 24), "real"), (T("money", 8, 19, 4), "money"), (T("smallmoney", 4, 10, 4), "smallmoney"),
            (T("datetime", 8, 23, 3), "datetime"), (T("smalldatetime", 4, 16), "smalldatetime"), (T("date", 3, 10), "date"),
            (T("datetime2", 8, 27, 7), "datetime2(7)"), (T("datetime2", 7, 23, 3), "datetime2(3)"), (T("datetime2", 6, 19, 0), "datetime2(0)"),
            (T("time", 5, 16, 7), "time(7)"), (T("time", 3, 8, 0), "time(0)"), (T("datetimeoffset", 10, 34, 7), "datetimeoffset(7)"), (T("datetimeoffset", 8, 26, 0), "datetimeoffset(0)"),
            (T("char", 10), "char(10)"), (T("char", 1), "char(1)"), (T("varchar", 50), "varchar(50)"), (T("varchar", -1), "varchar(max)"), (T("varchar", 8000), "varchar(8000)"),
            (T("binary", 16), "binary(16)"), (T("varbinary", -1), "varbinary(max)"), (T("varbinary", 8000), "varbinary(8000)"),
            (T("nchar", 20), "nchar(10)"), (T("nchar", 2), "nchar(1)"), (T("nvarchar", 100), "nvarchar(50)"), (T("nvarchar", -1), "nvarchar(max)"), (T("nvarchar", 8000), "nvarchar(4000)"),
            (T("decimal", 9, 18, 0), "decimal(18,0)"), (T("decimal", 5, 8, 2), "decimal(8,2)"), (T("numeric", 17, 38, 10), "numeric(38,10)"),
            (T("uniqueidentifier", 16), "uniqueidentifier"), (T("sql_variant", 8016), "sql_variant"), (T("xml", -1), "xml"),
            (T("xml", -1) with { XmlSchema = "dbo", XmlCollection = "Coll" }, "xml ([dbo].[Coll])"), (T("xml", -1) with { XmlSchema = "a]b", XmlCollection = "c]" }, "xml ([a]]b].[c]]])"),
            (new TypeRow("sysname", "sys", false, 256), "sysname"), (T("text", 16), "text"), (T("ntext", 16), "ntext"), (T("image", 16), "image"), (T("timestamp", 8), "timestamp"),
            (T("hierarchyid", 892), "hierarchyid"), (T("geometry", -1), "geometry"), (T("geography", -1), "geography"), (T("json", -1), "json"),
            (T("vector", 20) with { VectorDimensions = 3 }, "vector(3)"), (T("vector", 20), "vector"),
            (new TypeRow("Name", "dbo", true, 100), "[dbo].[Name]"), (new TypeRow("Point", "geo", true, -1), "[geo].[Point]"), (new TypeRow("OrderLines", "Sales", true, -1), "[Sales].[OrderLines]"),
            (new TypeRow("a]b", "s]", true), "[s]]].[a]]b]"), (new TypeRow("int", "sys", false, 4) with { Cursor = true }, "cursor")
        };
        var wrong = cases.Where(item => SqlTypeText.ForTemplate(item.Type, true) != item.Expected).Select(item => item.Expected + "≠" + SqlTypeText.ForTemplate(item.Type, true)).ToList();
        check(wrong.Count == 0 && cases.Length >= 40, "template type text follows sqltoolsservice's GetDatatype for " + cases.Length + " types: " + string.Join(", ", wrong));
        check(SqlTypeText.ForTemplate(new TypeRow("Name", "dbo", true, 100), false) == "[Name]" && SqlTypeText.ForTemplate(T("nvarchar", 100), false) == "nvarchar(50)"
            && SqlTypeText.ForTemplate(T("xml", -1) with { XmlSchema = "dbo", XmlCollection = "Coll" }, false) == "xml ([dbo].[Coll])",
            "Schema qualify object names off drops only user types' schemas");
    }

    private static void Templates(Action<bool, string> check)
    {
        var obj = DmlTemplates.Object("dbo", "T", true);
        var columns = new[] { C("c1"), C("c2", T("nvarchar", 100)) };
        check(obj == "[dbo].[T]" && DmlTemplates.Object("dbo", "T", false) == "[T]" && DmlTemplates.Object("d]bo", "a]b", true) == "[d]]bo].[a]]b]",
            "templates name the object schema-qualified when option 9 is on");
        check(DmlTemplates.Select(obj, columns) == Lines("SELECT [c1]", "      ,[c2]", "  FROM [dbo].[T]") && DmlTemplates.Select(obj, [C("only")]) == Lines("SELECT [only]", "  FROM [dbo].[T]"),
            "SELECT To lists the columns, one per line");
        check(DmlTemplates.Insert(obj, columns, true) == Lines("INSERT INTO [dbo].[T]", "           ([c1]", "           ,[c2])", "     VALUES", "           (<c1, int,>",
            "           ,<c2, nvarchar(50),>)") && DmlTemplates.Insert(obj, [C("only")], true) == Lines("INSERT INTO [dbo].[T]", "           ([only])", "     VALUES", "           (<only, int,>)"),
            "INSERT To lists the columns and a placeholder for each");
        check(DmlTemplates.Insert(obj, [C("id") with { Identity = true }], true) == Lines("INSERT INTO [dbo].[T]", "     DEFAULT VALUES"),
            "INSERT To a table with nothing to insert uses DEFAULT VALUES");
        check(DmlTemplates.Update(obj, columns, true) == Lines("UPDATE [dbo].[T]", "   SET [c1] = <c1, int,>", "      ,[c2] = <c2, nvarchar(50),>", " WHERE <Search Conditions,,>")
            && DmlTemplates.Update(obj, [C("id") with { Computed = true }], true) == "-- This object has no updatable columns.",
            "UPDATE To sets each column to a placeholder, and names no column when none can be updated");
        check(DmlTemplates.Delete(obj) == Lines("DELETE FROM [dbo].[T]", "      WHERE <Search Conditions,,>"), "DELETE To");
        check(DmlTemplates.SelectFunction(obj, [P(1, "@p1"), P(2, "@p2", T("nvarchar", 100))], true, true) == Lines("SELECT * FROM [dbo].[T] (", "   <@p1, int,>", "  ,<@p2, nvarchar(50),>)")
            && DmlTemplates.SelectFunction(obj, [], true, true) == "SELECT * FROM [dbo].[T] ()"
            && DmlTemplates.SelectFunction(obj, [P(0, "", T("decimal", 9, 10, 2)), P(1, "@p1")], false, true) == Lines("SELECT [dbo].[T] (", "   <@p1, int,>)")
            && DmlTemplates.SelectFunction(obj, [P(0, "", T("int", 4))], false, true) == "SELECT [dbo].[T] ()",
            "SELECT To a function selects from a table-valued one and the value of a scalar one, a placeholder per parameter");
        // Names that would close a placeholder, split it, or start a new line become _; quoted names keep every character.
        var crafted = new[] { C("a]b"), C("x<y>,z" + NL + "GO" + (char)0x2028 + (char)0x85, new TypeRow("t,>", "s<", true)) };
        check(DmlTemplates.Insert(obj, crafted, true) == Lines("INSERT INTO [dbo].[T]", "           ([a]]b]", "           ,[x<y>,z" + NL + "GO" + (char)0x2028 + (char)0x85 + "])", "     VALUES",
            "           (<a]b, int,>", "           ,<x_y__z" + new string('_', NL.Length) + "GO__, [s_].[t__],>)") && DmlTemplates.Placeholder("a\tb\u007f", "c,d") == "<a_b_, c_d,>",
            "placeholders replace <, >, commas, controls and line separators with _, and identifiers stay quoted");
        check(DmlTemplates.Insert(DmlTemplates.Object("dbo", "T", false), [C("n", new TypeRow("Name", "dbo", true, 100))], false) == Lines("INSERT INTO [T]", "           ([n])", "     VALUES",
            "           (<n, [Name],>)"), "with option 9 off, neither the object nor user types are schema-qualified");
    }

    private static void Rules(Action<bool, string> check)
    {
        var all = new[]
        {
            C("id") with { Identity = true }, C("total") with { Computed = true }, C("version", T("timestamp", 8)) with { SystemTypeId = 189 },
            C("rv", new TypeRow("rowversionAlias", "dbo", true, 8)) with { SystemTypeId = 189 }, C("from", T("datetime2", 8, 27, 7)) with { GeneratedAlways = 1, Hidden = true },
            C("start") with { GeneratedAlways = 1 }, C("hidden") with { Hidden = true }, C("dropped") with { DroppedLedger = true },
            C("$node_id_X") with { GraphType = 2 }, C("graph_id_X") with { GraphType = 1, Hidden = true }, C("$from_id_X") with { GraphType = 5 }, C("from_obj_id_X") with { GraphType = 4, Hidden = true },
            C("$to_id_X") with { GraphType = 8 }, C("plain")
        };
        check(DmlTemplates.Columns(all, writable: false).Select(column => column.Name).SequenceEqual(["id", "total", "version", "rv", "start", "$node_id_X", "$from_id_X", "$to_id_X", "plain"]),
            "SELECT lists every visible column, the graph pseudo-columns, and no hidden, internal graph or dropped ledger column");
        check(DmlTemplates.Columns(all, writable: true).Select(column => column.Name).SequenceEqual(["hidden", "$from_id_X", "$to_id_X", "plain"]),
            "INSERT and UPDATE also leave out identity, computed, rowversion, generated always and $node_id columns");
        var sparse = new[] { C("id"), C("a") with { Sparse = true }, C("b") with { Sparse = true }, C("cs", T("xml", -1)) with { ColumnSet = true, Sparse = false } };
        check(DmlTemplates.Columns(sparse, false).Select(column => column.Name).SequenceEqual(["id", "cs"]) && DmlTemplates.Columns(sparse[..3], false).Count == 3,
            "a column set stands in for its sparse columns; without one, sparse columns are listed");
        check(DmlTemplates.Select("[t]", [C("h") with { Hidden = true }]) == Lines("SELECT *", "  FROM [t]"), "SELECT To an object whose columns are all hidden selects *");
    }

    private static void Execute(Action<bool, string> check)
    {
        var obj = "[dbo].[p]";
        var parameters = new[] { P(1, "@a"), P(2, "@b", T("nvarchar", 100), output: true), P(3, "@Lines", new TypeRow("OrderLines", "Sales", true, -1), readOnly: true),
            P(4, "@Rows", new TypeRow("int", "sys", false, 4) with { Cursor = true }, output: true) };
        check(DmlTemplates.Execute(obj, parameters, false, true) == Lines("DECLARE @RC int", "DECLARE @a int", "DECLARE @b nvarchar(50)", "DECLARE @Lines [Sales].[OrderLines]",
            "DECLARE @Rows cursor", "", "-- TODO: Set parameter values here.", "", "EXECUTE @RC = [dbo].[p] ", "   @a", "  ,@b OUTPUT", "  ,@Lines", "  ,@Rows OUTPUT"),
            "EXECUTE To declares the return code and each parameter, then passes them, OUTPUT ones marked, after SSMS's trailing space");
        check(DmlTemplates.Execute(obj, [], false, true) == Lines("DECLARE @RC int", "", "-- TODO: Set parameter values here.", "", "EXECUTE @RC = [dbo].[p] "),
            "EXECUTE To a procedure without parameters");
        check(DmlTemplates.Execute(obj, [P(1, "@a")], true, true) == Lines("DECLARE @a int", "", "-- TODO: Set parameter values here.", "", "EXECUTE [dbo].[p] ", "   @a")
            && DmlTemplates.Execute(obj, [], true, true) == Lines("-- TODO: Set parameter values here.", "", "EXECUTE [dbo].[p] "),
            "a CLR procedure is executed without a return code");
        check(DmlTemplates.Execute("[dbo].[f]", [P(0, "", T("decimal", 9, 10, 2), output: true), P(1, "@a", T("decimal", 9, 10, 2)), P(2, "@b")], false, true)
            == Lines("DECLARE @RC decimal(10,2)", "DECLARE @a decimal(10,2)", "DECLARE @b int", "", "-- TODO: Set parameter values here.", "", "EXECUTE @RC = [dbo].[f] ", "   @a", "  ,@b")
            && DmlTemplates.Execute("[dbo].[f]", [P(0, "", T("int", 4), output: true)], true, true).StartsWith("DECLARE @RC int" + NL, StringComparison.Ordinal),
            "a scalar function's return code has its return type, CLR or not");
    }

    private static ResolvedTarget Target(string kind, string subtype = "", string? objectType = null, IReadOnlyList<ColumnRow>? columns = null, IReadOnlyList<ParameterRow>? parameters = null,
        string database = "Sales")
    {
        var row = ScriptingCatalog.Current.Row(kind, subtype)!;
        var reference = new ObjectRefDto(kind, database, "dbo", "o");
        return new(reference, database, kind, subtype, row, new ScriptSubject("dbo.o", kind, "SELECT", database), ObjectType: objectType, Columns: columns, Parameters: parameters);
    }

    private static void Pipeline(Action<bool, string> check)
    {
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var options = ScriptingLiveChecks.Defaults(json);
        var catalog = ScriptingCatalog.Current;
        check(DmlTemplates.Batch(Target("function", "inline", "IF", parameters: [P(1, "@x")]), ScriptVerb.Select, true) == Lines("SELECT * FROM [dbo].[o] (", "   <@x, int,>)")
            && DmlTemplates.Batch(Target("function", "clrTableValued", "FT"), ScriptVerb.Select, true) == "SELECT * FROM [dbo].[o] ()"
            && DmlTemplates.Batch(Target("function", "scalar", "FN", parameters: [P(0, "", T("int", 4), true)]), ScriptVerb.Select, true) == "SELECT [dbo].[o] ()"
            && DmlTemplates.Batch(Target("procedure", "clr", "PC"), ScriptVerb.Execute, true).StartsWith("-- TODO", StringComparison.Ordinal)
            && DmlTemplates.Batch(Target("procedure", "sql", "P"), ScriptVerb.Execute, true).StartsWith("DECLARE @RC int", StringComparison.Ordinal)
            && DmlTemplates.Batch(Target("view", "", "V", columns: [C("a")]), ScriptVerb.Delete, false) == Lines("DELETE FROM [o]", "      WHERE <Search Conditions,,>"),
            "each verb and kind picks its template");
        var session = new ScriptSession(new SqlConnection(), new ServerProfile(16, null, 3, null, false, false, false, 16), false);
        string Run(ScriptVerb verb, ScriptingOptionsDto with, bool cloud = false, params ResolvedTarget[] targets)
        {
            var sink = new StringScriptSink(catalog.Limit("maxScriptChars"));
            var warnings = ScriptPipeline.Run(new ScriptJob("c", targets, catalog.Verbs.Single(row => row.Verb == verb), with), new SmoScriptRunner(session, CancellationToken.None), sink,
                CancellationToken.None, cloud);
            return warnings.Count == 0 ? sink.ToString() : "warned";
        }
        var table = Target("table", columns: [C("a")]);
        check(Run(ScriptVerb.Select, options, false, table) == Lines("USE [Sales]", "GO", "", "SELECT [a]", "  FROM [dbo].[o]", "GO", "", ""),
            "a template follows a USE batch, each with GO and a blank line");
        check(Run(ScriptVerb.Delete, options with { DelimitStatements = false }, false, table) == Lines("USE [Sales]", "", "DELETE FROM [dbo].[o]", "      WHERE <Search Conditions,,>", "", "")
            && Run(ScriptVerb.Delete, options with { ScriptUseDatabase = false }, false, table) == Lines("DELETE FROM [dbo].[o]", "      WHERE <Search Conditions,,>", "GO", "", "")
            && Run(ScriptVerb.Delete, options, true, table) == Lines("DELETE FROM [dbo].[o]", "      WHERE <Search Conditions,,>", "GO", "", ""),
            "Delimit individual statements and Script USE turn their parts off, and cloud databases get no USE");
        var other = Target("table", columns: [C("b")], database: "Other");
        check(Run(ScriptVerb.Delete, options, false, table, table, other).Split("USE [").Length == 3, "templates write USE once per database context");
        var crowded = new StringScriptSink(10);
        try
        {
            ScriptPipeline.Run(new ScriptJob("c", [table], catalog.Verb("select")!, options), new SmoScriptRunner(session, CancellationToken.None), crowded, CancellationToken.None);
            check(false, "a template longer than the cap was accepted");
        }
        catch (ScriptTooLargeException) { check(crowded.ToString() == "", "a template past the output cap is TOO_LARGE"); }
    }
}
