using System.Globalization;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.Management.Common;
using Microsoft.SqlServer.Management.Sdk.Sfc;
using Microsoft.SqlServer.Management.Smo;
using Varia.Backend.Common;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Tests;

/// <summary>Offline Script As checks: the embedded catalogue, every preflight statement against the lint, subtype
/// derivation, URNs, SMO's options property by property, framing, the header guard, errors and messages, culture,
/// the request registry, and the service's validation, gates and cancellation with a fake host.</summary>
internal static class ScriptingChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
    };
    private static readonly ScriptingCatalog Catalog = ScriptingCatalog.Current;

    public static async Task RunAsync(Action<bool, string> check)
    {
        CatalogChecks(check);
        Statements(check);
        Subtypes(check);
        Urns(check);
        Options(check);
        Framing(check);
        Guard(check);
        Errors(check);
        Culture(check);
        Registry(check);
        ScriptingTemplateChecks.Run(check);
        await ServiceAsync(check);
    }

    private static void CatalogChecks(Action<bool, string> check)
    {
        var rows = Catalog.Targets.ToList();
        check(rows.Count > 0 && rows.Where(row => row.Scriptable).All(row => row.Urn.Length > 0 && row.Preflight.Length > 0 && Catalog.Titles.ContainsKey(row.Title))
            && rows.Where(row => !row.Scriptable).All(row => row.Enabled.Count == 0 && row.Urn.Length == 0), "every scriptable row of the embedded catalogue has a URN type, a preflight and a title");
        check(rows.All(row => ExplorerCatalog.Current.Kind(row.Kind) is { } kind && (row.Subtype == "" || kind.Subtypes.Contains(row.Subtype))), "every row names an Object Explorer kind and subtype");
        check(Catalog.Verbs.Select(verb => verb.Verb).SequenceEqual(Enum.GetValues<ScriptVerb>()) && Catalog.Verb("dropAndCreate") is { Name: "DROP And CREATE", Class: VerbClass.Ddl }
            && Catalog.Verb("execute")?.Class == VerbClass.Execute && Catalog.Verb("Create") is null, "the ten verbs map onto ScriptVerb in order");
        check(Catalog.ErrorCodes.Count() == 17 && Catalog.Retryable("AUTH_KERBEROS") && Catalog.Retryable("AUTH_ENTRA") && Catalog.Retryable("BLOCKED") && !Catalog.Retryable("NOT_FOUND") && Catalog.Limit("maxScriptChars") == 4_000_000
            && Catalog.Limit("maxDefinitionBytes") == ScriptPreflight.MaxDefinitionBytes && Catalog.Limit("budgetMs") == (long)new ScriptingServiceOptions().Budget.TotalMilliseconds
            && Catalog.Limit("gatePerConnection") == new ScriptingServiceOptions().PerConnection && Catalog.Limit("gateTotal") == new ScriptingServiceOptions().Total
            && Catalog.Limit("registered") == new ScriptingServiceOptions().MaxRegistered, "the backend's limits are the catalogue's");
        // The DTO's members are the options, in the catalogue's order, so a missing or extra option cannot go unnoticed.
        var members = typeof(ScriptingOptionsDto).GetProperties().Select(property => JsonNamingPolicy.CamelCase.ConvertName(property.Name)).ToList();
        check(members.SequenceEqual(Catalog.Options.Select(option => option.Key)) && members.Count == 36, "ScriptingOptionsDto has the 36 options in request order");
        var defaults = ScriptingLiveChecks.Defaults(Json);
        check(defaults.DelimitStatements && defaults.IncludeHeaders && !defaults.ScriptPermissions && !defaults.IncludeCollation && defaults.TargetServerVersion == "160"
            && defaults.TargetEngineEdition == "enterprise", "the catalogue's defaults deserialize into the DTO");
        check(ScriptPreflight.ObjectTypes("procedure", Catalog).SequenceEqual(["P", "PC", "X", "RF"]) && ScriptPreflight.ObjectTypes("view", Catalog).SequenceEqual(["V"]),
            "procedure preflights also find extended and replication-filter procedures, so their deferred subtype can refuse them");
    }

    private static IEnumerable<(string Kind, string? Parent)> ScriptableKinds() => Catalog.Targets.Where(row => row.Scriptable).GroupBy(row => row.Kind)
        .SelectMany(group => group.First().Parents.Count == 0 ? [(group.Key, (string?)null)] : group.First().Parents.Select(parent => (group.Key, (string?)parent)));

    private static void Statements(Action<bool, string> check)
    {
        var problems = new List<string>();
        var rendered = 0;
        foreach (var (kind, parent) in ScriptableKinds())
            for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
                foreach (var verbs in Enum.GetValues<VerbClass>())
                    foreach (var vector in new[] { false, true })
                    {
                        var text = ScriptPreflight.Statement(kind, band, Catalog, parent, verbs, vector);
                        rendered++;
                        foreach (var problem in ScriptPreflight.Lint(text, band, ScriptPreflight.ServerScope(kind), vector))
                            problems.Add(kind + "/" + parent + " band " + band + " " + verbs + (vector ? " vector " : " ") + problem);
                    }
        check(problems.Count == 0 && rendered > 1200, "every preflight statement passes the lint at every band, verb class and probe flag (" + rendered + " rendered): " + string.Join("; ", problems.Take(5)));
        check(ScriptPreflight.Rowset("table", VerbClass.Dml) == ScriptPreflight.RowsetKind.Columns && ScriptPreflight.Rowset("view", VerbClass.Dml) == ScriptPreflight.RowsetKind.Columns
            && ScriptPreflight.Rowset("function", VerbClass.Dml) == ScriptPreflight.RowsetKind.Parameters && ScriptPreflight.Rowset("procedure", VerbClass.Execute) == ScriptPreflight.RowsetKind.Parameters
            && ScriptPreflight.Rowset("table", VerbClass.Ddl) == ScriptPreflight.RowsetKind.None && ScriptPreflight.Rowset("login", VerbClass.Dml) == ScriptPreflight.RowsetKind.None
            && ScriptPreflight.Statement("table", 16, Catalog, verbs: VerbClass.Dml).Contains("TOP (@take)", StringComparison.Ordinal)
            && !ScriptPreflight.Statement("table", 16, Catalog, verbs: VerbClass.Ddl).Contains("sys.all_columns", StringComparison.Ordinal)
            && ScriptPreflight.Statement("table", 16, Catalog, verbs: VerbClass.Dml, vector: true).Contains("c.vector_dimensions", StringComparison.Ordinal)
            && !ScriptPreflight.Statement("table", 16, Catalog, verbs: VerbClass.Dml).Contains("vector_dimensions", StringComparison.Ordinal)
            && ScriptPreflight.Lint("SELECT c.vector_dimensions FROM c WHERE n = @name", 17, false).Any(problem => problem.Contains("probe flag"))
            && ScriptPreflight.Take(ScriptPreflight.RowsetKind.Columns, Catalog) == 30_001 && ScriptPreflight.Take(ScriptPreflight.RowsetKind.Parameters, Catalog) == 2_102,
            "template verbs read the columns or parameters in the same statement, at most one row past the catalogue's limit, and vector sizes only where the probe found them");
        check(ScriptPreflight.Lint("SELECT OBJECTPROPERTY(o.object_id, N'IsMsShipped') FROM x WHERE n = @name", 16, false).Any(problem => problem.Contains("OBJECTPROPERTY"))
            && ScriptPreflight.Lint("SELECT OBJECTPROPERTY(o.object_id, N'IsEncrypted') FROM x WHERE n = @name", 16, false).Count == 0
            && ScriptPreflight.Lint("SELECT 'x' FROM t WHERE n = @name", 16, false).Any(problem => problem.Contains("literal"))
            && ScriptPreflight.Lint("SELECT HAS_DBACCESS(@name)", 16, false).Any(problem => problem.Contains("HAS_DBACCESS"))
            && ScriptPreflight.Lint("SELECT HAS_DBACCESS(@name)", 16, true).Count == 0
            && ScriptPreflight.Lint("SELECT t.ledger_type FROM t WHERE n = @name", 15, false).Any(problem => problem.Contains("below band 16"))
            && ScriptPreflight.Lint("SELECT OBJECT_NAME(1) WHERE @name = 1", 16, false).Any() && ScriptPreflight.Lint("SELECT 1", 16, false).Any(problem => problem.Contains("@name")),
            "the preflight lint refuses other metadata functions, literals, HAS_DBACCESS inside a database, band gates and statements that ignore the name");
        check(ScriptPreflight.Statement("securityPolicy", 12, Catalog).Contains("WHERE 1 = 0", StringComparison.Ordinal)
            && !ScriptPreflight.Statement("constraint", 14, Catalog, "table").Contains("edge_constraints", StringComparison.Ordinal)
            && ScriptPreflight.Statement("constraint", 15, Catalog, "table").Contains("sys.edge_constraints", StringComparison.Ordinal)
            && ScriptPreflight.Statement("trigger", 16, Catalog, "view").Contains("po.type IN ('V')", StringComparison.Ordinal),
            "statements follow the band and the parent's kind");
        check(ScriptPreflight.ModuleCall.Contains("QUOTENAME(@db) + N'.sys.sp_executesql'", StringComparison.Ordinal) && ScriptPreflight.Declarations.Split(',').Length == 5
            && ScriptPreflight.Prologue.Contains("READ COMMITTED", StringComparison.Ordinal) && ScriptPreflight.Prologue.Contains("LOCK_TIMEOUT 10000", StringComparison.Ordinal),
            "database statements are reached only through the QUOTENAME scope wrapper, after a READ COMMITTED, 10 s lock timeout prologue");
    }

    private static ScriptPreflight.Row Row(params (string Name, object? Value)[] values) => new(values.ToDictionary(value => value.Name, value => value.Value));

    private static void Subtypes(Action<bool, string> check)
    {
        var cases = new (string Kind, ScriptPreflight.Row Row, string Subtype)[]
        {
            ("table", Row(("temporal_code", (byte)2)), "systemVersioned"), ("table", Row(("temporal_code", (byte)1)), "history"), ("table", Row(("ledger_code", (byte)2)), "updatableLedger"),
            ("table", Row(("ledger_code", (byte)3)), "appendOnlyLedger"), ("table", Row(("ledger_code", (byte)1)), "ledgerHistory"), ("table", Row(("dropped_flag", true)), "droppedLedger"),
            ("table", Row(("node_flag", true)), "graphNode"), ("table", Row(("edge_flag", true)), "graphEdge"), ("table", Row(("is_filetable", true)), "fileTable"),
            ("table", Row(("external_flag", true)), "external"), ("table", Row(("is_ms_shipped", true)), "system"), ("table", Row(), ""),
            ("view", Row(("ledger_view_code", (byte)1)), "ledger"), ("view", Row(("dropped_flag", true)), "droppedLedger"), ("view", Row(("is_ms_shipped", true)), "system"), ("view", Row(), ""),
            ("procedure", Row(("object_type", "P ")), "sql"), ("procedure", Row(("object_type", "PC")), "clr"), ("procedure", Row(("object_type", "X ")), "extended"),
            ("procedure", Row(("object_type", "RF")), "replicationFilter"), ("procedure", Row(("object_type", "P "), ("is_ms_shipped", true)), "system"),
            ("procedure", Row(("object_type", "X "), ("is_ms_shipped", true)), "extended"),
            ("function", Row(("object_type", "IF")), "inline"), ("function", Row(("object_type", "TF")), "tableValued"), ("function", Row(("object_type", "FN")), "scalar"),
            ("function", Row(("object_type", "FS")), "clrScalar"), ("function", Row(("object_type", "FT")), "clrTableValued"), ("function", Row(("object_type", "AF")), "aggregate"),
            ("database", Row(("is_snapshot", true)), "snapshot"), ("database", Row(("is_system", true)), "system"), ("database", Row(), ""),
            ("type", Row(("is_assembly_type", true)), "clr"), ("type", Row(("is_assembly_type", false)), "alias"),
            ("key", Row(("object_type", "PK")), "primary"), ("key", Row(("object_type", "UQ")), "unique"), ("key", Row(("object_type", "F ")), "foreign"),
            ("constraint", Row(("object_type", "C ")), "check"), ("constraint", Row(("object_type", "D ")), "default"), ("constraint", Row(("object_type", "EC")), "edge"),
            ("index", Row(("index_type", (byte)1)), "clustered"), ("index", Row(("index_type", (byte)6)), "nonclusteredColumnstore"), ("login", Row(), "")
        };
        var wrong = cases.Where(item => ScriptPreflight.Subtype(item.Kind, item.Row) != item.Subtype).Select(item => item.Kind + "→" + ScriptPreflight.Subtype(item.Kind, item.Row)).ToList();
        check(wrong.Count == 0, "the backend derives Object Explorer's subtype from the preflight row: " + string.Join(", ", wrong));
        check(Catalog.Row("procedure", "extended") is { Scriptable: false } && Catalog.Row("view", "ledger")!.Enabled.SequenceEqual(["create", "select"])
            && Catalog.Row("function", "aggregate")!.Urn == "UserDefinedAggregate" && Catalog.Row("type", "clr")!.Urn == "UserDefinedType" && Catalog.Row("constraint", "default")!.Urn == "Column/Default",
            "the derived subtype selects the catalogue row: deferred procedures, ledger views, aggregates, CLR types and default constraints");
    }

    private static void Urns(Action<bool, string> check)
    {
        const string server = "Server[@Name='HOST']";
        const string db = server + "/Database[@Name='Sales']";
        string Build(string kind, string urn, ObjectRefDto target, string? parentUrn = null, string? column = null) => UrnBuilder.Build(server, kind, urn, target, parentUrn, column);
        var child = new ParentRefDto("table", "dbo", "Orders");
        var goldens = new (string Actual, string Expected)[]
        {
            (Build("database", "Database", new("database", Name: "Sales")), db),
            (Build("table", "Table", new("table", "Sales", "dbo", "Orders")), db + "/Table[@Name='Orders' and @Schema='dbo']"),
            (Build("function", "UserDefinedAggregate", new("function", "Sales", "dbo", "Agg")), db + "/UserDefinedAggregate[@Name='Agg' and @Schema='dbo']"),
            (Build("type", "UserDefinedDataType", new("type", "Sales", "dbo", "Name")), db + "/UserDefinedDataType[@Name='Name' and @Schema='dbo']"),
            (Build("trigger", "Trigger", new("trigger", "Sales", Name: "TR", Parent: child), "Table"), db + "/Table[@Name='Orders' and @Schema='dbo']/Trigger[@Name='TR']"),
            (Build("trigger", "Trigger", new("trigger", "Sales", Name: "TR", Parent: child with { Kind = "view", Name = "v" }), "View"), db + "/View[@Name='v' and @Schema='dbo']/Trigger[@Name='TR']"),
            (Build("key", "ForeignKey", new("key", "Sales", Name: "FK", Parent: child), "Table"), db + "/Table[@Name='Orders' and @Schema='dbo']/ForeignKey[@Name='FK']"),
            (Build("key", "Index", new("key", "Sales", Name: "PK", Parent: child), "Table"), db + "/Table[@Name='Orders' and @Schema='dbo']/Index[@Name='PK']"),
            (Build("constraint", "Check", new("constraint", "Sales", Name: "CK", Parent: child), "Table"), db + "/Table[@Name='Orders' and @Schema='dbo']/Check[@Name='CK']"),
            (Build("constraint", "EdgeConstraint", new("constraint", "Sales", Name: "EC", Parent: child), "Table"), db + "/Table[@Name='Orders' and @Schema='dbo']/EdgeConstraint[@Name='EC']"),
            (Build("constraint", "Column/Default", new("constraint", "Sales", Name: "DF", Parent: child), "Table", "Created"),
                db + "/Table[@Name='Orders' and @Schema='dbo']/Column[@Name='Created']/Default[@Name='DF']"),
            (Build("statistic", "Statistic", new("statistic", "Sales", Name: "ST", Parent: child), "Table"), db + "/Table[@Name='Orders' and @Schema='dbo']/Statistic[@Name='ST']"),
            (Build("schema", "Schema", new("schema", "Sales", Name: "Sales")), db + "/Schema[@Name='Sales']"),
            (Build("databaseRole", "Role", new("databaseRole", "Sales", Name: "r")), db + "/Role[@Name='r']"),
            (Build("databaseTrigger", "DdlTrigger", new("databaseTrigger", "Sales", Name: "t")), db + "/DdlTrigger[@Name='t']"),
            (Build("serverRole", "Role", new("serverRole", Name: "sysadmin")), server + "/Role[@Name='sysadmin']"),
            (Build("serverTrigger", "DdlTrigger", new("serverTrigger", Name: "t")), server + "/DdlTrigger[@Name='t']"),
            (Build("login", "Login", new("login", Name: "O'Brien")), server + "/Login[@Name='O''Brien']")
        };
        var wrong = goldens.Where(item => item.Actual != item.Expected).Select(item => item.Actual).ToList();
        check(wrong.Count == 0, "URNs follow spec B4 for every scope: " + string.Join(", ", wrong));
        var names = new[] { "O'Brien", "a]b", "a]]b", "[x]", "''", "Ünïcødé表", "😀 x", new string('n', 127) + "'" };
        var trips = names.All(name =>
        {
            var urn = new Urn(Build("table", "Table", new("table", name, name, name)));
            return urn.GetAttribute("Name") == name && urn.GetAttribute("Schema") == name && urn.Parent.GetAttribute("Name") == name && urn.Type == "Table";
        });
        check(trips, "URN values round-trip names with quotes, brackets, Unicode and 128 characters");
        try { Build("login", "Table", new("login", Name: "x")); check(false, "a server-level URN accepted a database type"); }
        catch (InvalidOperationException) { check(true, "server-level URNs take only server types"); }
        check(SmoScriptRunner.ChildInitTypes.Length == 14 && !SmoScriptRunner.ChildInitTypes.Contains(typeof(Table)) && !SmoScriptRunner.ChildInitTypes.Contains(typeof(Database)),
            "SMO's init fields are set for child types only");
    }

    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);

    /// <summary>The options SMO's result depends on, as Map sets them for the defaults on SQL Server 2022 Enterprise (spec B7, B8).</summary>
    private static readonly Dictionary<string, object> DefaultMapping = new()
    {
        ["ScriptSchema"] = true, ["ScriptData"] = false, ["AllowSystemObjects"] = true, ["EnforceScriptingOptions"] = true, ["IncludeDatabaseRoleMemberships"] = true,
        ["ContinueScriptingOnError"] = false, ["IncludeScriptingParametersHeader"] = false, ["ScriptBatchTerminator"] = false, ["PrimaryObject"] = true, ["ToFileOnly"] = false,
        ["TimestampToBinary"] = false, ["LoginSid"] = false, ["NoExecuteAs"] = false, ["AgentAlertJob"] = false,
        ["ScriptDrops"] = false, ["ScriptForAlter"] = false, ["ScriptForCreateOrAlter"] = false, ["ScriptForCreateDrop"] = false,
        ["IncludeHeaders"] = true, ["NoVardecimal"] = true, ["ChangeTracking"] = false, ["FullTextCatalogs"] = false, ["IncludeDatabaseContext"] = true, ["IncludeIfNotExists"] = false,
        ["WithDependencies"] = false, ["SchemaQualify"] = true, ["ScriptDataCompression"] = false, ["ScriptXmlCompression"] = false, ["ExtendedProperties"] = true, ["ScriptOwner"] = false,
        ["Permissions"] = false, ["ConvertUserDefinedDataTypesToBaseType"] = false, ["AnsiPadding"] = true, ["NoCollation"] = true, ["NoIdentities"] = false,
        ["SchemaQualifyForeignKeysReferences"] = true, ["Bindings"] = true, ["DriChecks"] = true, ["DriDefaults"] = true, ["NoFileGroup"] = false, ["DriForeignKeys"] = true,
        ["FullTextIndexes"] = false, ["Indexes"] = true, ["ClusteredIndexes"] = true, ["NonClusteredIndexes"] = true, ["XmlIndexes"] = true, ["SpatialIndexes"] = true,
        ["ColumnStoreIndexes"] = true, ["NoTablePartitioningSchemes"] = true, ["NoIndexPartitioningSchemes"] = true, ["DriPrimaryKey"] = true, ["Statistics"] = false,
        ["OptimizerData"] = false, ["Triggers"] = false, ["DriUniqueKeys"] = true, ["NoViewColumns"] = true, ["DriIncludeSystemNames"] = false,
        ["TargetServerVersion"] = SqlServerVersion.Version160, ["TargetDatabaseEngineEdition"] = DatabaseEngineEdition.Enterprise, ["TargetDatabaseEngineType"] = DatabaseEngineType.Standalone
    };

    private static Dictionary<string, object> Read(ScriptingOptions options) =>
        DefaultMapping.Keys.ToDictionary(name => name, name => typeof(ScriptingOptions).GetProperty(name)!.GetValue(options)!);

    private static List<string> Changed(Dictionary<string, object> before, Dictionary<string, object> after) => [.. before.Keys.Where(key => !Equals(before[key], after[key])).Order()];

    private static void Options(Action<bool, string> check)
    {
        var dto = ScriptingLiveChecks.Defaults(Json);
        var baseline = Read(SmoOptionsMapper.Map(dto, ScriptVerb.Create, Box2022, dto.IncludeHeaders).Options);
        var differs = DefaultMapping.Where(item => !Equals(baseline[item.Key], item.Value)).Select(item => item.Key + "=" + baseline[item.Key]).ToList();
        check(differs.Count == 0, "the default options map to SMO property by property: " + string.Join(", ", differs));
        // Each option changes only its own SMO properties.
        var owned = new Dictionary<string, string[]>
        {
            ["delimitStatements"] = [], ["includeHeaders"] = ["IncludeHeaders"], ["includeVarDecimal"] = ["NoVardecimal"], ["scriptChangeTracking"] = ["ChangeTracking"],
            ["scriptFullTextCatalogs"] = ["FullTextCatalogs"], ["scriptUseDatabase"] = ["IncludeDatabaseContext"], ["checkExistence"] = ["IncludeIfNotExists"],
            ["generateDependentObjects"] = ["WithDependencies"], ["schemaQualify"] = ["SchemaQualify"], ["scriptDataCompression"] = ["ScriptDataCompression", "ScriptXmlCompression"],
            ["scriptExtendedProperties"] = ["ExtendedProperties"], ["scriptOwner"] = ["ScriptOwner"], ["scriptPermissions"] = ["Permissions"],
            ["convertUserDefinedDataTypes"] = ["ConvertUserDefinedDataTypesToBaseType"], ["generateAnsiPadding"] = ["AnsiPadding"], ["includeCollation"] = ["NoCollation"],
            ["includeIdentity"] = ["NoIdentities"], ["schemaQualifyForeignKeys"] = ["SchemaQualifyForeignKeysReferences"], ["scriptBindings"] = ["Bindings"],
            ["scriptCheckConstraints"] = ["DriChecks"], ["scriptDefaults"] = ["DriDefaults"], ["scriptFileGroups"] = ["NoFileGroup"], ["scriptForeignKeys"] = ["DriForeignKeys"],
            ["scriptFullTextIndexes"] = ["FullTextIndexes"], ["scriptIndexes"] = ["ClusteredIndexes", "ColumnStoreIndexes", "Indexes", "NonClusteredIndexes", "SpatialIndexes", "XmlIndexes"],
            ["scriptPartitionSchemes"] = ["NoIndexPartitioningSchemes", "NoTablePartitioningSchemes"], ["scriptPrimaryKeys"] = ["DriPrimaryKey"], ["scriptStatistics"] = ["Statistics"],
            ["scriptTriggers"] = ["Triggers"], ["scriptUniqueKeys"] = ["DriUniqueKeys"], ["scriptViewColumns"] = ["NoViewColumns"], ["includeDriSystemNames"] = ["DriIncludeSystemNames"],
            // Off, the version rows apply: 2016 Standard instead of the server's 2022 Enterprise.
            ["matchSourceSettings"] = ["TargetDatabaseEngineEdition", "TargetServerVersion"]
        };
        var wrong = new List<string>();
        foreach (var property in typeof(ScriptingOptionsDto).GetProperties().Where(property => property.PropertyType == typeof(bool)))
        {
            var key = JsonNamingPolicy.CamelCase.ConvertName(property.Name);
            var flipped = dto with { };
            property.SetValue(flipped, !(bool)property.GetValue(dto)!);
            if (key == "matchSourceSettings") flipped = flipped with { TargetServerVersion = "130", TargetEngineEdition = "standard" };
            var changed = Changed(baseline, Read(SmoOptionsMapper.Map(flipped, ScriptVerb.Create, Box2022, flipped.IncludeHeaders).Options));
            if (!changed.SequenceEqual(owned[key].Order())) wrong.Add(key + "→" + string.Join("/", changed));
        }
        check(wrong.Count == 0 && owned.Count == 33, "each option changes only its own SMO properties: " + string.Join(", ", wrong));
        var ignored = dto with { TargetServerVersion = "130", TargetEngineEdition = "express" };
        check(Changed(baseline, Read(SmoOptionsMapper.Map(ignored, ScriptVerb.Create, Box2022, true).Options)).Count == 0, "the version rows are ignored while Match script settings to source is True");
        var verbs = new (ScriptVerb Verb, string[] Changed)[] { (ScriptVerb.Create, []), (ScriptVerb.Drop, ["ScriptDrops"]), (ScriptVerb.Alter, ["ScriptForAlter"]), (ScriptVerb.CreateOrAlter, ["ScriptForCreateOrAlter"]) };
        check(verbs.All(item => Changed(baseline, Read(SmoOptionsMapper.Map(dto, item.Verb, Box2022, true).Options)).SequenceEqual(item.Changed)), "each DDL verb sets only its own SMO flag");
        check(SmoOptionsMapper.Passes(ScriptVerb.DropAndCreate).SequenceEqual([ScriptVerb.Drop, ScriptVerb.Create]) && SmoOptionsMapper.Passes(ScriptVerb.Alter).SequenceEqual([ScriptVerb.Alter]),
            "DROP And CREATE is a DROP pass and then a CREATE pass");
        check(SmoOptionsMapper.Walk(ScriptVerb.Create) == DependencyType.Parents && SmoOptionsMapper.Walk(ScriptVerb.CreateOrAlter) == DependencyType.Children
            && SmoOptionsMapper.Walk(ScriptVerb.Drop) == DependencyType.Children && SmoOptionsMapper.Walk(ScriptVerb.Alter) is null,
            "dependent objects are what a CREATE refers to, what refers to the object for CREATE OR ALTER and DROP, and nothing for ALTER, as SMO 181 walks them");
        try { SmoOptionsMapper.Map(dto, ScriptVerb.DropAndCreate, Box2022, true); check(false, "DROP And CREATE mapped to one pass"); }
        catch (InvalidOperationException) { check(true, "DROP And CREATE is never mapped as one SMO pass"); }
        check(!SmoOptionsMapper.Map(dto, ScriptVerb.Create, Box2022, true, cloud: true).Options.IncludeDatabaseContext, "a cloud database writes no USE");
        var dependents = dto with { GenerateDependentObjects = true };
        check(SmoOptionsMapper.Map(dependents, ScriptVerb.Create, Box2022, true).Options.WithDependencies && !SmoOptionsMapper.Map(dependents, ScriptVerb.Create, Box2022, true, dependencies: false).Options.WithDependencies
            && SmoOptionsMapper.Dependencies("View", null, false) && SmoOptionsMapper.Dependencies("Trigger", "Table", false) && SmoOptionsMapper.Dependencies("DdlTrigger", null, false)
            && !SmoOptionsMapper.Dependencies("Trigger", "View", false) && !SmoOptionsMapper.Dependencies("DdlTrigger", null, true) && !SmoOptionsMapper.Dependencies("Database", null, true)
            && !SmoOptionsMapper.Dependencies("Index", "Table", false) && !SmoOptionsMapper.Dependencies("Column/Default", "Table", false),
            "Generate script for dependent objects reaches SMO only for the kinds its dependency discovery takes");

        // Versions and editions (spec B8).
        var versions = new (int Major, SqlServerVersion Expected)[]
        {
            (12, SqlServerVersion.Version120), (13, SqlServerVersion.Version130), (14, SqlServerVersion.Version140), (15, SqlServerVersion.Version150), (16, SqlServerVersion.Version160),
            (17, SqlServerVersion.Version170), (0, SqlServerVersion.Version160)
        };
        check(versions.All(item => SmoOptionsMapper.Version(item.Major) == item.Expected), "server majors map to SMO versions; an unknown major targets the options page's default");
        var warnings = new List<string>();
        var newest = SmoOptionsMapper.Newest;
        var future = SmoOptionsMapper.Version(newest.Number / 10 + 1, warnings);
        check(future == newest.Value && warnings.SingleOrDefault() == "SQL Server " + (newest.Number / 10 + 1) + " is newer than this version of SQL Server Management Objects supports; the script targets "
            + ScriptingErrors.VersionName(newest.Value) + "." && SmoOptionsMapper.Version(newest.Number / 10, warnings) == newest.Value && warnings.Count == 1,
            "a server newer than SMO targets SMO's newest version, with a warning");
        var editions = new (int Edition, DatabaseEngineEdition Expected, DatabaseEngineType Type)[]
        {
            (1, DatabaseEngineEdition.Personal, DatabaseEngineType.Standalone), (2, DatabaseEngineEdition.Standard, DatabaseEngineType.Standalone),
            (3, DatabaseEngineEdition.Enterprise, DatabaseEngineType.Standalone), (4, DatabaseEngineEdition.Express, DatabaseEngineType.Standalone),
            (5, DatabaseEngineEdition.SqlDatabase, DatabaseEngineType.SqlAzureDatabase), (6, DatabaseEngineEdition.SqlDataWarehouse, DatabaseEngineType.SqlAzureDatabase),
            (8, DatabaseEngineEdition.SqlManagedInstance, DatabaseEngineType.Standalone), (9, DatabaseEngineEdition.SqlDatabaseEdge, DatabaseEngineType.Standalone),
            (11, DatabaseEngineEdition.SqlOnDemand, DatabaseEngineType.SqlAzureDatabase), (7, DatabaseEngineEdition.Standard, DatabaseEngineType.Standalone),
            (10, DatabaseEngineEdition.Standard, DatabaseEngineType.Standalone), (12, DatabaseEngineEdition.Standard, DatabaseEngineType.Standalone)
        };
        var editionsWrong = editions.Where(item => SmoOptionsMapper.Map(dto, ScriptVerb.Create, Box2022 with { EngineEdition = item.Edition }, true) is var mapped
            && (mapped.Edition != item.Expected || mapped.EngineType != item.Type)).Select(item => item.Edition).ToList();
        check(editionsWrong.Count == 0, "engine editions 1–12 map to SMO editions and engine types: " + string.Join(", ", editionsWrong));
        var chosen = SmoOptionsMapper.Map(dto with { MatchSourceSettings = false, TargetServerVersion = "170", TargetEngineEdition = "personal" }, ScriptVerb.Create, Box2022, true);
        check(chosen.Target == SqlServerVersion.Version170 && chosen.Edition == DatabaseEngineEdition.Personal && chosen.EngineType == DatabaseEngineType.Standalone,
            "with Match script settings to source off, the version rows decide");
        check(ScriptingErrors.VersionName(SqlServerVersion.Version130) == "SQL Server 2016" && ScriptingErrors.VersionName(SqlServerVersion.Version170) == "SQL Server 2025",
            "versions are named as the options page names them");
    }

    private static void Framing(Action<bool, string> check)
    {
        var nl = Environment.NewLine;
        check(ScriptFormatter.Frame("SELECT 1", true) == "SELECT 1" + nl + "GO" + nl + nl && ScriptFormatter.Frame("SELECT 1\n", true) == "SELECT 1\nGO" + nl + nl
            && ScriptFormatter.Frame("SELECT 1\r\n", true) == "SELECT 1\r\nGO" + nl + nl, "a batch is followed by GO and a blank line, adding a line break only when it has none");
        check(ScriptFormatter.Frame("SELECT 1", false) == "SELECT 1" + nl + nl && ScriptFormatter.Frame("SELECT 1\n", false) == "SELECT 1\n" + nl, "without delimiters a blank line separates batches");
        check(ScriptFormatter.Quote("a]b") == "[a]]b]" && ScriptFormatter.Use("d]b") == "USE [d]]b]" && ScriptFormatter.Quote("") == "[]", "names are quoted as QUOTENAME quotes them");
        var sink = new StringScriptSink(10);
        check(sink.Append("12345") && sink.Remaining == 5 && !sink.Append("123456") && sink.Append("12345") && sink.Remaining == 0 && sink.ToString() == "1234512345",
            "the string sink stops at its cap and keeps what it took");
    }

    private static void Guard(Action<bool, string> check)
    {
        const string date = "    Script Date: 10/9/2026 7:52:05 PM ******/";
        string Header(string name) => "/****** Object:  Table [dbo].[" + name + "]" + date;
        check(HeaderGuard.Safe(Header("Orders") + "\nSET ANSI_NULLS ON") && HeaderGuard.Safe(Header("Orders")) && HeaderGuard.Safe("CREATE PROC p AS SELECT 1 /****** Object: x */")
            && HeaderGuard.Safe("SELECT 1") && HeaderGuard.Safe(Header("O'Brien") + "\r\n" + Header("a]b") + "\n") && HeaderGuard.Safe("/****** Object:  Table ?" + date + "\n"),
            "SMO's headers pass the guard, and a module's own text is not a header");
        var crafted = new[] { Header("a*/b"), Header("x/*y"), Header("x*/ DROP TABLE t /*"), Header("line\r\nbreak"), Header("a\u2028b"), Header("Orders") + " DROP TABLE t",
            "SET ANSI_NULLS ON\n" + Header("x******/\nDROP TABLE t--"), Header("x" + date + "\nDROP TABLE t--"), Header("Script Date: x"), "/****** Object:  Table [dbo].[x" };
        check(crafted.All(text => !HeaderGuard.Safe(text)), "headers a name ends early, opens a comment in, or splits over lines fail the guard");
        var commented = Header("p") + "\r\nCREATE PROC p AS -- Script Date: kept from 2019\r\nSELECT 1 /* Script Date: */";
        check(HeaderGuard.Safe(commented) && HeaderGuard.Dated(commented) == 1 && HeaderGuard.Dated("CREATE PROC p AS -- Script Date: x") == 0
            && HeaderGuard.Dated("x\r" + Header("a") + "\u2028y") == 1, "a module's own mention of Script Date: is not a header, so it neither fails the guard nor counts");
        // A definition that keeps an old SSMS header, indented or commented out, fails the guard; the script without
        // headers then differs only by SMO's own header lines, so they stay.
        var body = "CREATE PROCEDURE [dbo].[p] AS\r\n    --   " + Header("Locked") + "\r\nSELECT 1;";
        string[] plain = ["USE [db]", "SET ANSI_NULLS ON", body];
        check(!HeaderGuard.Safe(body) && HeaderGuard.Aligned(["USE [db]", Header("p") + "\r\nSET ANSI_NULLS ON", body], plain)
            && HeaderGuard.Aligned(["USE [db]", Header("p") + "\nSET ANSI_NULLS ON", Header("p"), body], plain) && HeaderGuard.Aligned(plain, plain),
            "a script whose headers are all it adds to the script without them keeps them");
        check(!HeaderGuard.Aligned(["USE [db]", Header("p\r\nDROP TABLE t --") + "\r\nSET ANSI_NULLS ON", body], plain)
            && !HeaderGuard.Aligned(["USE [db]", "/****** Object:  Table [dbo].[x" + "\r\nSET ANSI_NULLS ON", body], plain)
            && !HeaderGuard.Aligned(["USE [db]", Header("a*/b") + "\r\nSET ANSI_NULLS ON", body], plain)
            && !HeaderGuard.Aligned(["USE [db]", Header("p") + "\rSET ANSI_NULLS ON", body], plain)
            && !HeaderGuard.Aligned(["USE [db]", Header("p") + "\r\nSET ANSI_NULLS ON", body + " "], plain) && !HeaderGuard.Aligned(["USE [db]", body], plain)
            && !HeaderGuard.Aligned(["USE [db]", "SET ANSI_NULLS ON", body, "DROP TABLE t"], plain),
            "one that a name splits, ends early, or changes in any other way does not");
        // A definition may start with an old header in any shape: a trailing space, a banner over lines, no date, or the
        // CREATE on the same line. It fails the guard, and the script keeps SMO's headers because they are all it adds.
        var leading = new[] { Header("old") + " \r\n", "/****** Object:  StoredProcedure [dbo].[p]\r\n** Purpose: nightly load\r\n******/\r\n",
            "/****** Object:  StoredProcedure [dbo].[p] ******/\r\n", Header("old") };
        check(leading.All(comment => comment + "CREATE PROCEDURE p AS SELECT 1;" is var definition && !HeaderGuard.Safe(definition)
            && HeaderGuard.Aligned(["USE [db]", Header("p") + "\r\nSET ANSI_NULLS ON", definition], ["USE [db]", "SET ANSI_NULLS ON", definition])),
            "a definition that starts with an old header of any shape keeps SMO's headers beside it");
        // SMO 181's own comment batch for a reference it could not resolve holds the name as is, with headers on or off.
        string Banner(string name) => HeaderGuard.Unresolved("Server[@Name='srv']/Database[@Name='Sales']/UnresolvedEntity[@Name='" + name + "' and @Schema='dbo']");
        check(Banner("t") == "/****** Cannot script Unresolved Entities : Server[@Name='srv']/Database[@Name='Sales']/UnresolvedEntity[@Name='t' and @Schema='dbo'] ******/",
            "the comment SMO writes for an unresolved reference is rebuilt exactly as SMO 181 formats it");
        var broken = new[] { Banner("x*/ DROP TABLE t /*"), Banner("a*/b") + "\r\n", Banner("n/*x"), Banner("a\r\nGO\r\nx*/ DROP TABLE t --"), Banner("a\r\nb"),
            Banner("a ******/\r\nDROP TABLE t\r\n/****** b"), Banner("a" + (char)0x2028 + "b"), "/****** Future : x*/ DROP TABLE t /* ******/" };
        check(broken.All(batch => !HeaderGuard.Closed(batch)), "a comment batch of SMO's that a name ends early, nests a comment in, or breaks over lines fails the comment check");
        check(HeaderGuard.Closed(Banner("t")) && HeaderGuard.Closed(Banner("O''Brien") + "\n") && HeaderGuard.Closed(Header("p")) && HeaderGuard.Closed(Header("p") + "\r\nSET ANSI_NULLS ON")
            && HeaderGuard.Closed("SET ANSI_NULLS ON") && leading.All(comment => HeaderGuard.Closed(comment + "CREATE PROCEDURE p AS SELECT 1;"))
            && HeaderGuard.Closed("/****** Script for SelectTopNRows command from SSMS  ******/\r\nCREATE VIEW v AS SELECT TOP (1000) 1 AS one")
            && HeaderGuard.Closed("/****** a ******/\r\nCREATE PROCEDURE p AS SELECT 1 /* x */") && HeaderGuard.Closed("CREATE PROCEDURE p AS SELECT 1 /****** x */ ******/"),
            "a whole comment batch, a header, and definitions with comments of their own pass the comment check");
        // A module's stored text may itself start and end with such a comment; it passes as the definition of an object the
        // script creates, which must be its first statement and the script's only one of that object, in a batch nothing
        // splits. Check for object existence writes a procedure's CREATE as an empty stub and then an ALTER, and wraps other
        // definitions in sp_executesql strings, which count.
        var scripted = new ScriptedObjects();
        scripted.Add("StoredProcedure", "p");
        scripted.Add("StoredProcedure", "it's");
        scripted.Add("View", "v");
        scripted.Add("DdlTrigger", "ddl");
        const string stub = "IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[p]') AND type in (N'P', N'PC'))\r\nBEGIN\r\n"
            + "EXEC dbo.sp_executesql @statement = N'CREATE PROCEDURE [dbo].[p] AS' \r\nEND";
        bool Passes(params string[] batches) => HeaderGuard.Closed(batches, module => scripted.Defines(module, triggers: false));
        bool WithTriggers(params string[] batches) => HeaderGuard.Closed(batches, module => scripted.Defines(module, triggers: true));
        const string banner = "/****** Nightly load ******/\r\n", end = "\r\n/****** End ******/";
        check(Passes("USE [db]", "SET ANSI_NULLS ON", banner + "CREATE PROCEDURE [dbo].[p] AS SELECT 1;" + end)
            && Passes(Header("p") + "\r\n" + banner + "-- note\r\n/* a /* nested */ comment */ CREATE OR ALTER VIEW [dbo].[v]  AS \r\nSELECT 1 AS one;" + end)
            && Passes(banner + "ALTER PROC [p] AS SELECT 1;" + end) && Passes(banner + "CREATE TRIGGER [ddl] ON DATABASE FOR CREATE_TABLE AS SELECT 1;" + end)
            && WithTriggers(banner + "CREATE OR ALTER TRIGGER [dbo].[tr] ON [dbo].[v] INSTEAD OF INSERT AS SET NOCOUNT ON;" + end)
            && Passes("USE [db]", stub, banner + "ALTER PROCEDURE [dbo].[p] AS SELECT 1;" + end, "DROP PROCEDURE [dbo].[p]"),
            "a definition of an object the script creates passes the comment check with a banner at both ends");
        check(!Passes("IF NOT EXISTS (SELECT * FROM sys.views WHERE object_id = OBJECT_ID(N'[dbo].[v]'))\r\nEXECUTE dbo.sp_executesql N'\r\nCREATE VIEW [dbo].[v] AS SELECT 1'",
                banner + "ALTER VIEW [dbo].[v] AS SELECT 2;" + end)
            && !Passes("EXEC dbo.sp_executesql @statement = N'ALTER PROCEDURE [dbo].[it''s] AS SELECT 1'", banner + "CREATE PROCEDURE [dbo].[it's] AS SELECT 2;" + end)
            && !Passes(stub.Replace("AS'", "AS SELECT 2'", StringComparison.Ordinal), banner + "ALTER PROCEDURE [dbo].[p] AS SELECT 1;" + end),
            "a second definition of the module, also inside an sp_executesql string, fails it");
        check(!Passes(banner + "CREATE PROCEDURE [dbo].[q] AS SELECT 1;" + end) && !Passes(banner + "CREATE VIEW [dbo].[p] AS SELECT 1;" + end)
            && !Passes(banner + "CREATE PROCEDURE [dbo].[p] AS SELECT 1;" + end, "CREATE PROCEDURE [dbo].[p] AS SELECT 2;")
            && !Passes(banner + "CREATE PROCEDURE [dbo].[p] AS SELECT 1\r\nGO\r\nDROP TABLE t" + end) && !Passes("/****** Future : x*/ CREATE TRIGGER [evil] ON DATABASE FOR DROP_TABLE AS ROLLBACK; /* ******/")
            && !Passes(banner + "CREATE OR ALTER TRIGGER [dbo].[tr] ON [dbo].[v] INSTEAD OF INSERT AS SET NOCOUNT ON;" + end)
            && !WithTriggers(banner + "CREATE TRIGGER [dbo].[tr] ON [dbo].[t] AFTER INSERT AS SET NOCOUNT ON;" + end) && !Passes("/****** Future : x */ DROP TABLE t /* ******/")
            && !Passes("/****** Future : x /* CREATE PROCEDURE [dbo].[p] AS SELECT 1; ******/") && broken.All(batch => !Passes(batch)),
            "one that creates something else, a module the script does not create or creates twice, or that a GO splits fails it, as does every broken comment");
        check(HeaderGuard.Defines("/* a /* b */ c */ -- d\r\n  create   or   alter proc [s].[a]]b] AS SELECT 1") is { Keyword: "PROCEDURE", Statement: "[s].[a]]b]", Name: "a]b", On: null }
            && HeaderGuard.Defines("CREATE TRIGGER [x] ON [dbo].[t]]1] AFTER INSERT AS SELECT 1") is { Keyword: "TRIGGER", Name: "x", On: "t]1" }
            && HeaderGuard.Defines("/* open CREATE PROCEDURE [p] AS SELECT 1") is null && HeaderGuard.Defines("SET ANSI_NULLS ON") is null
            && HeaderGuard.Defines("CREATE TABLE [dbo].[p] (id int)") is null && HeaderGuard.Defines("-- only a comment") is null,
            "the statement a batch starts with is read past its comments, which nest, with SMO's bracketed names");
        var entity = (string database, string name, string server) => new Urn("Server[@Name='" + server + "']/Database[@Name='" + database.Replace("'", "''") + "']/UnresolvedEntity[@Name='"
            + name.Replace("'", "''") + "' and @Schema='dbo']");
        var target = new Urn("Server[@Name='srv']/Database[@Name='Sales']/StoredProcedure[@Name='p' and @Schema='dbo']");
        check(SmoScriptRunner.UnresolvedWarning([entity("Sales", "x*/ DROP TABLE t /*", "srv"), entity("Archive", "a\r\nb", "SRV"), entity("Remote", "t", "ls")], target)
                == "The script does not create objects that a definition in it refers to but that SQL Server Management Objects could not resolve (they do not exist, you cannot see "
                + "them, or they are named with a server): dbo.x*/ DROP TABLE t /* in database Sales, dbo.a⟨U+000D⟩⟨U+000A⟩b in database Archive, dbo.t in database Remote on server ls."
            && SmoScriptRunner.UnresolvedWarning([.. Enumerable.Range(0, 5).Select(i => entity("Sales", "t" + i, "srv"))], target).EndsWith("dbo.t2 in database Sales and 2 more.", StringComparison.Ordinal)
            && SmoScriptRunner.UnresolvedWarning([entity("o's", "it's missing", "srv")], target).EndsWith(": dbo.it's missing in database o's.", StringComparison.Ordinal),
            "the warning names the unresolved references as messages show names (an apostrophe once), with their database and a linked server, three at most");
        check(SmoScriptRunner.Splits("CREATE PROC p AS SELECT 1\r\nGO\r\nDROP TABLE t") && SmoScriptRunner.Splits("CREATE PROC p AS SELECT 1\n:r other.sql")
            && !SmoScriptRunner.Splits("CREATE PROC p AS SELECT N'\r\nGO\r\n' /*\nGO\n*/") && !SmoScriptRunner.Splits("CREATE TABLE [a\r\nGO\r\nb] (id int)"),
            "a definition is flagged when the query window would split it at a GO or refuse a SQLCMD line, never for GO inside quotes, comments or names");
        check(SmoScriptRunner.Hex("a\uD800") == "610000D8" && SmoScriptRunner.Hex("") == "", "names reach the definition check as UTF-16 hex, unpaired surrogates included");
        check(ScriptingErrors.UnpairedSurrogate("ab😀c") == -1 && ScriptingErrors.UnpairedSurrogate("a\uD800b") == 1 && ScriptingErrors.UnpairedSurrogate("ab\uDC00") == 2
            && ScriptingErrors.UnpairedSurrogate("\uD83D") == 0, "the surrogate scan finds unpaired halves only");
    }

    private static void Errors(Action<bool, string> check)
    {
        var subject = new ScriptSubject("dbo.Orders", "Table", "CREATE", "Sales");
        ScriptError? Classify(Exception error, bool encrypted = false, SqlServerVersion? target = null, bool serverTrigger = false, bool broken = false) =>
            ScriptingErrors.Classify(Catalog, error, subject, encrypted, target, serverTrigger, broken);
        var codes = new (int Number, byte Severity, string Code)[]
        {
            (1222, 16, "BLOCKED"), (1205, 13, "BLOCKED"), (-2, 11, "TIMEOUT"), (229, 14, "PERMISSION_DENIED"), (15151, 16, "PERMISSION_DENIED"), (15247, 16, "PERMISSION_DENIED"),
            (916, 14, "DATABASE_UNAVAILABLE"), (4060, 11, "DATABASE_UNAVAILABLE"), (923, 14, "DATABASE_UNAVAILABLE"), (942, 14, "DATABASE_UNAVAILABLE"), (978, 14, "DATABASE_UNAVAILABLE"),
            (911, 16, "NOT_FOUND"),
            (10054, 20, "CONNECTION_LOST"), (233, 16, "CONNECTION_LOST"), (50000, 20, "CONNECTION_LOST"), (208, 16, "SQL_ERROR"), (102, 15, "SQL_ERROR")
        };
        check(codes.All(item => ScriptingErrors.SqlCode(item.Number, item.Severity) == item.Code), "SQL Server errors map to scripting codes (spec C9)");
        check(Classify(new ScriptTooLargeException())?.Code == "TOO_LARGE" && Classify(new EmptyScriptException()) is { Code: "EMPTY", Message: "SQL Server Management Objects produced no CREATE script for dbo.Orders." }
            && Classify(new SmoObjectMissingException())?.Code == "NOT_FOUND" && Classify(new FailedOperationException("Script failed.", new MissingObjectException("gone")))?.Code == "NOT_FOUND"
            && ScriptingErrors.Create(Catalog, "NOT_SUPPORTED", subject).Message == "CREATE scripts are not available for Table dbo.Orders. Refresh Object Explorer and try again.",
            "the pipeline's own failures and SMO's missing objects map to their codes");
        check(Classify(new FailedOperationException("Script failed.", new UnsupportedVersionException("Ledger tables need SQL Server 2022.")), target: SqlServerVersion.Version150) is
            { Code: "NOT_SUPPORTED", Retryable: false, Message: "dbo.Orders cannot be scripted for SQL Server 2019: Ledger tables need SQL Server 2022." }
            && Classify(new UnsupportedFeatureException("x"))?.Code == "NOT_SUPPORTED", "SMO's version and feature refusals are NOT_SUPPORTED, naming the target");
        check(Classify(new FailedOperationException("x", new DependentDefinitionException("ENCRYPTED", "dbo", "TR_\u202eA", "Orders", "Script triggers"))) is
            { Code: "ENCRYPTED", Retryable: false, Message: "Trigger TR_⟨U+202E⟩A of dbo.Orders is encrypted (WITH ENCRYPTION), so dbo.Orders cannot be scripted with Script triggers on. Turn it off in Tools › Options › Scripting and try again." }
            && Classify(new DependentDefinitionException("TOO_LARGE", "dbo", "fn_Rates", null, "Generate script for dependent objects")) is
            { Code: "TOO_LARGE", Message: "The definition of dbo.fn_Rates is larger than 8 MB, which Varia cannot open. Turn off Generate script for dependent objects in Tools › Options › Scripting and try again." },
            "a trigger or dependent definition SMO would read is refused naming that object and the option that brought it in");
        check(Classify(new DependentDefinitionException("TOO_LARGE", "dbo", "fn_Rates", null, "Generate script for dependent objects", "Archive‮")) is
            { Code: "TOO_LARGE", Message: "The definition of dbo.fn_Rates in database Archive⟨U+202E⟩ is larger than 8 MB, which Varia cannot open. Turn off Generate script for dependent objects in Tools › Options › Scripting and try again." }
            && Classify(new DependentDefinitionException("ENCRYPTED", "dbo", "TR_A", "Rates", "Generate script for dependent objects", "Archive"))?.Message ==
                "Trigger TR_A of dbo.Rates in database Archive is encrypted (WITH ENCRYPTION), so dbo.Orders cannot be scripted with Generate script for dependent objects on. Turn it off in Tools › Options › Scripting and try again.",
            "one in another database is named with that database");
        const string turnOff = " cannot be scripted with Generate script for dependent objects on. Turn it off in Tools › Options › Scripting and try again.";
        check(Classify(new DependentDefinitionException("ENCRYPTED", null, "trd_\u202eAudit", null, "Generate script for dependent objects", kind: "databaseTrigger")) is
                { Code: "ENCRYPTED", Retryable: false, Message: "Database trigger trd_⟨U+202E⟩Audit is encrypted (WITH ENCRYPTION), so dbo.Orders" + turnOff }
            && Classify(new DependentDefinitionException("TOO_LARGE", null, "trd_Audit", null, "Generate script for dependent objects", kind: "databaseTrigger"))?.Message
                == "The definition of database trigger trd_Audit is larger than 8 MB, which Varia cannot open. Turn off Generate script for dependent objects in Tools › Options › Scripting and try again."
            && Classify(new DependentDefinitionException("NO_DEFINITION", null, "trd_Audit", null, "Generate script for dependent objects", kind: "databaseTrigger", maybeEncrypted: true)) is
                { Code: "NO_DEFINITION", Retryable: false, Message: "The definition of database trigger trd_Audit is encrypted, or you do not have permission to view it, so dbo.Orders" + turnOff }
            && Classify(new DependentDefinitionException("NO_DEFINITION", null, "trs_Logon", null, "Generate script for dependent objects", kind: "serverTrigger", maybeEncrypted: true))?.Message
                == "The definition of server trigger trs_Logon is encrypted, or you do not have permission to view it, so dbo.Orders" + turnOff
            && Classify(new DependentDefinitionException("NO_DEFINITION", "dbo", "fn_Rates", null, "Generate script for dependent objects", "Archive")) is
                { Code: "NO_DEFINITION", Message: "You do not have permission to view the definition of dbo.fn_Rates in database Archive, so dbo.Orders" + turnOff }
            && Classify(new DependentDefinitionException("NO_DEFINITION", "dbo", "TR_A", "Rates", "Script triggers"))?.Message
                == "You do not have permission to view the definition of trigger TR_A of dbo.Rates, so dbo.Orders cannot be scripted with Script triggers on. Turn it off in Tools › Options › Scripting and try again.",
            "a database or server trigger is named as such, and a dependent whose definition the login cannot read is NO_DEFINITION naming it, its database and the option");
        var walkNode = (string path) => new Urn("Server[@Name='srv']" + path);
        check(SmoScriptRunner.Checked(walkNode("/Database[@Name='Sales']/UserDefinedFunction[@Name='f' and @Schema='dbo']")) == ("Sales", 'o', "dbo", "f")
            && SmoScriptRunner.Checked(walkNode("/Database[@Name='Sales']/Table[@Name='t' and @Schema='s']/Trigger[@Name='tr']")) == ("Sales", 'o', "s", "tr")
            && SmoScriptRunner.Checked(walkNode("/Database[@Name='Sales']/DdlTrigger[@Name='trd']")) == ("Sales", 'd', "", "trd")
            && SmoScriptRunner.Checked(walkNode("/DdlTrigger[@Name='trs']")) == ("master", 's', "", "trs")
            && SmoScriptRunner.Checked(walkNode("/Database[@Name='Sales']/PlanGuide[@Name='pg']")) is null,
            "the definition check reads every walk node with a definition: schema modules, DML triggers in their table's schema, and database and server triggers");
        check(Classify(new FailedOperationException("x", new DependentDatabaseException(null, "The server principal \"low\" is not able to access the database \"Archive\"."))) is
            { Code: "DATABASE_UNAVAILABLE", Retryable: true, Message: "A database that dbo.Orders depends on is not available (The server principal \"low\" is not able to access the database \"Archive\".), so dbo.Orders cannot be scripted with Generate script for dependent objects on. Turn it off in Tools › Options › Scripting and try again." }
            && Classify(new DependentDatabaseException("Archive", "OFFLINE"))?.Message == "Database Archive is not available (OFFLINE), so dbo.Orders cannot be scripted with Generate script for dependent objects on. Turn it off in Tools › Options › Scripting and try again.",
            "a dependent's database that cannot be opened is DATABASE_UNAVAILABLE naming it and the option, not the target's database");
        // When SMO's walk fails, only SQL Server's text names the database, after the login: both may be 128 characters.
        var database = "dependent_" + new string('q', 55) + "_end";
        var refused = "The server principal \"" + new string('l', 128) + "\" is not able to access the database \"" + database + "\" under the current security context.";
        var widest = ScriptingErrors.DependentDatabase(Catalog, new DependentDatabaseException(null, new string('d', 5000)), subject with { Display = new string('x', 400) });
        check(Classify(new DependentDatabaseException(null, refused))?.Message.Contains("\"" + database + "\" under the current security context.)", StringComparison.Ordinal) == true
            && widest.Message.Length <= ScriptingErrors.MaxMessage && widest.Message.EndsWith(" Turn it off in Tools › Options › Scripting and try again.", StringComparison.Ordinal),
            "a long login and database name in SQL Server's text both reach the message, which still ends with its advice within 2,048 characters");
        check(Classify(new PropertyCannotBeRetrievedException("Text"), encrypted: true)?.Code == "ENCRYPTED" && Classify(new PropertyCannotBeRetrievedException("Text"))?.Code == "NO_DEFINITION"
            && Classify(new PropertyCannotBeRetrievedException("Text"), serverTrigger: true)?.Message == "The definition of dbo.Orders is encrypted, or you do not have permission to view it.",
            "a definition SMO cannot read is ENCRYPTED or NO_DEFINITION");
        check(Classify(new FailedOperationException("Script failed for Table 'dbo.Orders'.", new SmoException("Inner\r\ntext."))) is
            { Code: "SMO_ERROR", Retryable: true, Message: "Could not script dbo.Orders: Script failed for Table 'dbo.Orders'. Inner text." }
            && Classify(new InvalidOperationException("x")) is null && Classify(new InvalidOperationException("x"), broken: true)?.Code == "CONNECTION_LOST",
            "SMO's own failures join their messages; anything unknown is not a value unless the connection broke");
        check(Classify(new ScriptRefusedException("it depends on an object in another database.")) is { Code: "SMO_ERROR", Message: "Could not script dbo.Orders: it depends on an object in another database." },
            "a script Varia refuses is a value that says why");
        var messages = Catalog.ErrorCodes.Select(code => ScriptingErrors.Create(Catalog, code, subject with { Display = new string('x', 400) }, new string('d', 5000), 1)).ToList();
        check(messages.All(error => error.Message.Length <= ScriptingErrors.MaxMessage && error.Retryable == Catalog.Retryable(error.Code)) && messages.Count == 17,
            "every message stays within 2,048 characters and carries the catalogue's retryability");
        check(ScriptingErrors.Display("a\u202eb\u0007\uD800") == "a⟨U+202E⟩b⟨U+0007⟩⟨U+D800⟩" && ScriptingErrors.Display(new string('x', 500)).Length == 400
            && ScriptingErrors.Display("😀") == "😀" && ScriptingErrors.Detail("a\r\nb\tc", 100) == "a b c", "names in messages show hidden characters as markers and stay within 400 characters");
        check(ScriptingErrors.Create(Catalog, "TIMEOUT", subject).Message == "Scripting dbo.Orders took longer than 55 seconds and was stopped."
            && ScriptingErrors.Create(Catalog, "DATABASE_UNAVAILABLE", subject, "OFFLINE").Message == "Database Sales is not available (OFFLINE), so dbo.Orders cannot be scripted."
            && ScriptingErrors.Create(Catalog, "SQL_ERROR", subject, "Invalid object name.", 208).Message == "Could not script dbo.Orders: Msg 208: Invalid object name.",
            "messages follow spec B10");
    }

    private static void Culture(Action<bool, string> check)
    {
        check(ScriptingCulture.Parse("de-DE").Name == "de-DE" && ScriptingCulture.Parse("zh-Hant-TW").Name == "zh-Hant-TW" && ScriptingCulture.Parse(null) == CultureInfo.InvariantCulture
            && ScriptingCulture.Parse("de_DE") == CultureInfo.InvariantCulture && ScriptingCulture.Parse("en-US; rm -rf") == CultureInfo.InvariantCulture
            && ScriptingCulture.Parse("qq-ZZ") == CultureInfo.InvariantCulture && ScriptingCulture.Parse("en-" + new string('a', 40)) == CultureInfo.InvariantCulture,
            "VARIA_LOCALE takes BCP 47 tags ICU knows, and falls back to the invariant culture");
        try
        {
            ScriptingCulture.Override = CultureInfo.GetCultureInfo("ja-JP");
            check(ScriptingCulture.Current.Name == "ja-JP", "checks can override the scripting culture");
            var formats = new List<string>();
            foreach (var name in new[] { "sv-SE", "he-IL", "ar-SA", "fa-IR" })
            {
                ScriptingCulture.Override = CultureInfo.GetCultureInfo(name);
                var culture = ScriptingCulture.Formatting;
                var date = new DateTime(2026, 10, 9, 19, 52, 5);
                if ((-100).ToString(culture) != "-100" || (-1.5m).ToString(culture) != "-1.5" || culture.Name != name || date.ToString(culture) != date.ToString(CultureInfo.GetCultureInfo(name))
                    || !ReferenceEquals(culture, ScriptingCulture.Formatting))
                    formats.Add(name);
            }
            check(formats.Count == 0, "scripting threads format numbers invariantly (no U+2212 or bidi-marked minus) and dates in the user's culture: " + string.Join(", ", formats));
        }
        finally { ScriptingCulture.Override = null; }
    }

    private static void Registry(Action<bool, string> check)
    {
        var registry = new RequestRegistry(2, "scripting");
        using var a = new CancellationTokenSource();
        using var b = new CancellationTokenSource();
        using var c = new CancellationTokenSource();
        var first = registry.Register("1", "x", a);
        try { registry.Register("1", "x", b); check(false, "a duplicate id registered"); }
        catch (RequestException error) { check(error.Code == "DUPLICATE_REQUEST" && error.Message == "This scripting request is already running.", "a running id cannot register again"); }
        var second = registry.Register("2", "y", b);
        try { registry.Register("3", "x", c); check(false, "the registry grew past its capacity"); }
        catch (RequestException error) { check(error.Code == "BUSY", "the registry is bounded"); }
        registry.Forget("x");
        check(a.IsCancellationRequested && first.Forgotten && !b.IsCancellationRequested && !second.Forgotten, "forgetting a connection cancels only its requests");
        registry.Unregister("1", second);
        check(registry.Count == 2, "unregistering needs the entry that registered the id");
        registry.Unregister("1", first);
        registry.ForgetAll();
        check(registry.Count == 1 && b.IsCancellationRequested && second.Forgotten, "unregistering frees the id, and ForgetAll cancels the rest");
    }

    /// <summary>A host whose connections never open (or block first), counting them.</summary>
    private sealed class FakeHost(int edition = 3) : IScriptingHost
    {
        public SemaphoreSlim? Hold { get; set; }
        public int Connections;
        public ServerProfile Profile(string connectionId) => connectionId == Missing ? throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.") : Box2022 with { EngineEdition = edition };
        public SqlConnection Connection(string connectionId, string? database)
        {
            Interlocked.Increment(ref Connections);
            Hold?.Wait();
            return new SqlConnection("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false");
        }
        /// <summary>Replaces the open, as SqlService's does for a Kerberos token failure.</summary>
        public Func<SqlConnection, CancellationToken, Task>? Opening { get; set; }
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => Opening?.Invoke(connection, token) ?? connection.OpenAsync(token);
    }

    private static readonly string Missing = Guid.NewGuid().ToString();

    private static async Task ServiceAsync(Action<bool, string> check)
    {
        var options = ScriptingLiveChecks.Defaults(Json);
        var table = new ObjectRefDto("table", "Sales", "dbo", "Orders");
        ScriptArgs Args(ObjectRefDto? target = null, string verb = "create", string? connectionId = null, string? requestId = null, ScriptingOptionsDto? with = null) =>
            new(connectionId ?? Guid.NewGuid().ToString(), requestId ?? Guid.NewGuid().ToString(), [target ?? table], verb, with ?? options);
        var host = new FakeHost();
        using var service = new ScriptingService(host);
        var invalid = new (string Name, ScriptArgs Args)[]
        {
            ("connection id", Args(connectionId: "server-a")), ("request id", Args(requestId: "r1")), ("no target", Args() with { Targets = [] }),
            ("two targets", Args() with { Targets = [table, table] }), ("ref shape", Args(new ObjectRefDto("table", "Sales", Name: "Orders"))),
            ("unscriptable kind", Args(new ObjectRefDto("column", "Sales", Name: "c", Parent: new ParentRefDto("table", "dbo", "Orders")))),
            ("deferred kind", Args(new ObjectRefDto("certificate", "Sales", Name: "c"))), ("verb", Args(verb: "truncate")), ("verb the kind never offers", Args(verb: "execute")),
            ("table type child", Args(new ObjectRefDto("index", "Sales", Name: "i", Parent: new ParentRefDto("tableType", "dbo", "t")))),
            ("enum option", Args(with: options with { TargetServerVersion = "120" })), ("engine type", Args(with: options with { TargetEngineType = "azure" })),
            ("no options", Args() with { Options = null! })
        };
        var accepted = new List<string>();
        foreach (var (name, args) in invalid)
        {
            try { await service.ScriptAsync(args, CancellationToken.None); accepted.Add(name); }
            catch (RequestException error) when (error.Code == "INVALID_PARAMS") { }
        }
        check(accepted.Count == 0 && host.Connections == 0, "invalid requests are INVALID_PARAMS before any connection: " + string.Join(", ", accepted));
        try { await service.ScriptAsync(Args(connectionId: Missing), CancellationToken.None); check(false, "an unknown connection scripted"); }
        catch (RequestException error) { check(error.Code == "NOT_CONNECTED" && host.Connections == 0, "an unknown connection is NOT_CONNECTED"); }
        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel();
            try { await service.ScriptAsync(Args(), cancelled.Token); check(false, "a cancelled request ran"); }
            catch (OperationCanceledException) { check(host.Connections == 0 && service.RunningCount == 0 && service.ActiveJobs == 0, "a request cancelled before it runs opens nothing and takes no gate"); }
        }
        var unreachable = await service.ScriptAsync(Args(), CancellationToken.None);
        check(unreachable.Error is { Retryable: true } && unreachable.Text is null && unreachable.Database == "Sales" && SpinWait.SpinUntil(() => service.ActiveJobs == 0, 2000),
            "a connection that cannot open is an error value: " + unreachable.Error?.Code);
        using (var expired = new ScriptingService(new FakeHost { Opening = ConnectionFailureChecks.ExpiredTicket }))
        {
            var refused = await expired.ScriptAsync(Args(), CancellationToken.None);
            check(refused.Error is { Code: "AUTH_KERBEROS", Retryable: true } && refused.Error.Message == "Could not script dbo.Orders: " + ConnectionFailures.Messages.Expired
                && refused.Text is null && refused.Database == "Sales" && SpinWait.SpinUntil(() => expired.ActiveJobs == 0 && expired.RunningCount == 0, 2000),
                "a scripting connection whose Kerberos ticket expired is the job's retryable AUTH_KERBEROS value with the kinit advice, as Object Explorer's node shows it");
        }
        var cloud = await new ScriptingService(new FakeHost(5)).ScriptAsync(Args(new ObjectRefDto("login", Name: "sa")), CancellationToken.None);
        check(cloud.Error?.Code == "NOT_SUPPORTED" && cloud.Database == "master", "cloud editions refuse server-level objects");

        // Duplicates, the per-connection gate, the registry's bound, and disconnect.
        var gated = new FakeHost { Hold = new SemaphoreSlim(0) };
        using var limited = new ScriptingService(gated, new ScriptingServiceOptions { PerConnection = 1, MaxRegistered = 3 });
        var connection = Guid.NewGuid().ToString();
        var requestId = Guid.NewGuid().ToString();
        var held = limited.ScriptAsync(Args(connectionId: connection, requestId: requestId), CancellationToken.None);
        check(SpinWait.SpinUntil(() => gated.Connections == 1, 5000), "the first job takes the connection's gate");
        try { await limited.ScriptAsync(Args(connectionId: connection, requestId: requestId), CancellationToken.None); check(false, "a duplicate request ran"); }
        catch (RequestException error) { check(error.Code == "DUPLICATE_REQUEST", "a running requestId cannot be sent again"); }
        var waiting = limited.ScriptAsync(Args(connectionId: connection), CancellationToken.None);
        var other = limited.ScriptAsync(Args(connectionId: Guid.NewGuid().ToString()), CancellationToken.None);
        SpinWait.SpinUntil(() => gated.Connections == 2 && limited.RunningCount == 3, 5000);
        check(gated.Connections == 2 && !waiting.IsCompleted, "the per-connection gate holds a connection's second job, not another connection's");
        try { await limited.ScriptAsync(Args(), CancellationToken.None); check(false, "more registered requests than allowed"); }
        catch (RequestException error) { check(error.Code == "BUSY", "registered requests are bounded"); }
        limited.Forget(connection);
        try { await waiting; check(false, "a forgotten connection's waiting job ran"); }
        catch (RequestException error) { check(error.Code == "CANCELLED", "disconnect cancels the connection's waiting jobs"); }
        try { await held; check(false, "a forgotten connection's running job answered"); }
        catch (RequestException error) { check(error.Code == "CANCELLED" && limited.ActiveJobs == 2, "disconnect answers a running job at once, which keeps its gate until its work ends"); }
        gated.Hold.Release(2);
        check((await other).Error is not null && SpinWait.SpinUntil(() => limited.ActiveJobs == 0 && limited.RunningCount == 0, 5000),
            "another connection's job is unaffected, and every job releases its gates when its work ends");

        // The JSON contract: every option is required, and unknown members are refused.
        using var sql = new SqlService();
        var valid = JsonSerializer.SerializeToElement(Args(), Json);
        var withoutOption = System.Text.Json.Nodes.JsonNode.Parse(valid.GetRawText())!;
        withoutOption["options"]!.AsObject().Remove("scriptOwner");
        var withExtra = System.Text.Json.Nodes.JsonNode.Parse(valid.GetRawText())!;
        withExtra["options"]!["extra"] = true;
        foreach (var body in new[] { withoutOption, withExtra })
        {
            try { await sql.DispatchAsync("scripting.script", JsonSerializer.SerializeToElement(body, Json), Json); check(false, "an incomplete options object was accepted"); }
            catch (JsonException) { check(true, "a missing or unknown option fails deserialization (INVALID_PARAMS)"); }
        }
        check(SqlService.MethodNames.Contains("scripting.script") && sql.LaneOf("scripting.script") == Protocol.RequestLane.Metadata, "scripting.script is announced and runs on the metadata lane");
    }
}
