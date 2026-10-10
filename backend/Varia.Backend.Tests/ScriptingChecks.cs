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
        check(Catalog.ErrorCodes.Count() == 14 && Catalog.Retryable("BLOCKED") && !Catalog.Retryable("NOT_FOUND") && Catalog.Limit("maxScriptChars") == 4_000_000
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
        try { SmoOptionsMapper.Map(dto, ScriptVerb.DropAndCreate, Box2022, true); check(false, "DROP And CREATE mapped to one pass"); }
        catch (InvalidOperationException) { check(true, "DROP And CREATE is never mapped as one SMO pass"); }
        check(!SmoOptionsMapper.Map(dto, ScriptVerb.Create, Box2022, true, databaseContext: false).Options.IncludeDatabaseContext
            && !SmoOptionsMapper.Map(dto, ScriptVerb.Create, Box2022, true, cloud: true).Options.IncludeDatabaseContext, "a later pass and a cloud database write no USE");

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
            (916, 14, "DATABASE_UNAVAILABLE"), (4060, 11, "DATABASE_UNAVAILABLE"), (942, 14, "DATABASE_UNAVAILABLE"), (978, 14, "DATABASE_UNAVAILABLE"), (911, 16, "NOT_FOUND"),
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
        check(Classify(new PropertyCannotBeRetrievedException("Text"), encrypted: true)?.Code == "ENCRYPTED" && Classify(new PropertyCannotBeRetrievedException("Text"))?.Code == "NO_DEFINITION"
            && Classify(new PropertyCannotBeRetrievedException("Text"), serverTrigger: true)?.Message == "The definition of dbo.Orders is encrypted, or you do not have permission to view it.",
            "a definition SMO cannot read is ENCRYPTED or NO_DEFINITION");
        check(Classify(new FailedOperationException("Script failed for Table 'dbo.Orders'.", new SmoException("Inner\r\ntext."))) is
            { Code: "SMO_ERROR", Retryable: true, Message: "Could not script dbo.Orders: Script failed for Table 'dbo.Orders'. Inner text." }
            && Classify(new InvalidOperationException("x")) is null && Classify(new InvalidOperationException("x"), broken: true)?.Code == "CONNECTION_LOST",
            "SMO's own failures join their messages; anything unknown is not a value unless the connection broke");
        var messages = Catalog.ErrorCodes.Select(code => ScriptingErrors.Create(Catalog, code, subject with { Display = new string('x', 400) }, new string('d', 5000), 1)).ToList();
        check(messages.All(error => error.Message.Length <= ScriptingErrors.MaxMessage && error.Retryable == Catalog.Retryable(error.Code)) && messages.Count == 14,
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
