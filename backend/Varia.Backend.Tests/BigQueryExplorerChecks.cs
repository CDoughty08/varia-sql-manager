using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.BigQuery;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>
/// BigQuery's Object Explorer, Script As, Preview Rows and Properties offline (docs/bigquery.md, Object Explorer): names reach SQL
/// text only through BqNames, the templates render hostile names safely, and the listers, tables.get, tabledata.list and the rate
/// limiter are proved on <see cref="BigQueryFake"/> with the REST fixtures. No request leaves the process.
/// </summary>
internal static class BigQueryExplorerChecks
{
    static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    const string Base = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha";
    const string Sales = Base + "/datasets/sales";

    public static async Task RunAsync(Action<bool, string> check)
    {
        Catalog(check);
        Names(check);
        Templates(check);
        Facts(check);
        await LimiterAsync(check);
        using var rsa = System.Security.Cryptography.RSA.Create(2048);
        var key = BigQueryCredentialChecks.Key(rsa.ExportPkcs8PrivateKeyPem());
        await ListersAsync(check, key);
        await ScriptAsync(check, key);
        await CreateAsync(check, key);
        await PreviewAsync(check, key);
        await PropertiesAsync(check, key);
    }

    /// <summary>The embedded catalogue's BigQuery kinds serve BigQuery alone, list through BigQueryService's listers, and the
    /// connection node serves both engines.</summary>
    static void Catalog(Action<bool, string> check)
    {
        var catalog = Varia.Backend.Explorer.ExplorerCatalog.Current;
        var kinds = catalog.Kinds.Where(kind => kind.BigQuery).ToList();
        check(kinds.Count == 9 && kinds.All(kind => kind.Serves(Providers.BigQuery) && !kind.Serves(Providers.SqlServer)) && catalog.KindOf("server").Serves(Providers.BigQuery)
            && catalog.KindOf("server").Serves(Providers.SqlServer) && !catalog.KindOf("database").Serves(Providers.BigQuery)
            && kinds.Where(kind => kind.List is not null).All(kind => BigQueryService.Lists.Contains(kind.List!)),
            "BigQuery's Explorer kinds serve BigQuery alone and list through its REST listers; the connection node serves both engines");
    }

    static readonly string[] Hostile = ["a`b", "a\\b", "a;DROP TABLE x", "a\nb", "a'b", "a\"b", "a/*b", "a.b", "", new string('a', 1025)];

    /// <summary>Each kind's rule refuses backticks, backslashes, quotes, line breaks and over-long names before any quoting.</summary>
    static void Names(Action<bool, string> check)
    {
        check(BqNames.IsTable("orders") && BqNames.IsTable("Ünïcode table-1") && BqNames.IsDataset("sales_2024") && BqNames.IsProject("varia-alpha") && BqNames.IsRoutine("to_cents")
            && BqNames.IsColumn("a&b") && BqNames.IsFieldPath("address.geo.lat"),
            "BigQuery names BigQuery allows pass their rules");
        var refused = Hostile.Where(name => BqNames.IsTable(name) || BqNames.IsDataset(name) || BqNames.IsRoutine(name) || BqNames.IsModel(name)).ToArray();
        var columns = Hostile.Where(name => name != "a'b" && BqNames.IsColumn(name)).ToArray();
        check(refused.Length == 0 && columns.Length == 0, "hostile names fail every table, dataset, routine, model and column rule: " + string.Join(", ", refused.Concat(columns)));
        check(!BqNames.IsFieldPath(string.Join('.', Enumerable.Repeat("a", 16))) && !BqNames.IsFieldPath("a..b") && !BqNames.IsProject("Varia_Alpha") && !BqNames.IsTable(new string('é', 513)),
            "a field path keeps to 15 parts, a project id to its rule, and a table name to 1,024 UTF-8 bytes");
        var thrown = Hostile.Count(name =>
        {
            try { BqNames.TablePath("varia-alpha", "sales", name); return false; }
            catch (RequestException error) { return error.Code == "INVALID_PARAMS"; }
        });
        check(thrown == Hostile.Length && BqNames.TablePath("varia-alpha", "sales", "my table") == "`varia-alpha`.`sales`.`my table`"
            && BqNames.FieldPathText("address.geo") == "`address`.`geo`",
            $"a hostile name throws INVALID_PARAMS before reaching text ({thrown}/{Hostile.Length}); each part is quoted on its own");
        var create = BigQueryService.CreateSql("varia-alpha", "sales", routine: false);
        var routine = BigQueryService.CreateSql("varia-alpha", "sales", routine: true);
        check(create == "SELECT ddl FROM `varia-alpha`.`sales`.INFORMATION_SCHEMA.TABLES WHERE table_name = @name"
            && routine == "SELECT ddl FROM `varia-alpha`.`sales`.INFORMATION_SCHEMA.ROUTINES WHERE routine_name = @name",
            "Script As › CREATE reads INFORMATION_SCHEMA's ddl with the name only as a parameter: " + create);
    }

    static List<TableFieldSchema> Fields() =>
    [
        new() { Name = "id", Type = "INTEGER", Mode = "REQUIRED" },
        new() { Name = "customer", Type = "STRING" },
        new() { Name = "tags", Type = "STRING", Mode = "REPEATED" },
        new() { Name = "a<b>", Type = "STRING" },
        new() { Name = "bad`col", Type = "STRING" }
    ];

    /// <summary>The local templates: SELECT with the bytes-billed comment and LIMIT, DML for tables only, DROP by type; a column
    /// whose name its rule refuses is left out, never quoted.</summary>
    static void Templates(Action<bool, string> check)
    {
        const string path = "`varia-alpha`.`sales`.`orders`";
        var select = BigQueryService.Template("select", "TABLE", Fields(), path);
        check(select == "-- LIMIT does not lower the bytes billed: BigQuery bills every column the query reads.\nSELECT\n  `id`,\n  `customer`,\n  `tags`,\n  `a<b>`\nFROM " + path + "\nLIMIT 1000;",
            "SELECT lists the top-level columns, skips a refused name, says LIMIT does not lower the bytes billed: " + select);
        check(BigQueryService.Template("select", "VIEW", [], path)!.Contains("SELECT *\nFROM", StringComparison.Ordinal), "a SELECT with no known columns reads *");
        var insert = BigQueryService.Template("insert", "TABLE", Fields(), path);
        var update = BigQueryService.Template("update", "TABLE", Fields(), path);
        var delete = BigQueryService.Template("delete", "TABLE", Fields(), path);
        check(insert == "INSERT INTO " + path + " (`id`, `customer`, `tags`, `a<b>`)\nVALUES (<id, INT64,>, <customer, STRING,>, <tags, ARRAY(STRING),>, <a_b_, STRING,>);"
            && update == "UPDATE " + path + "\nSET\n  `id` = <id, INT64,>,\n  `customer` = <customer, STRING,>,\n  `tags` = <tags, ARRAY(STRING),>,\n  `a<b>` = <a_b_, STRING,>\nWHERE <Search Conditions,,>;"
            && delete == "DELETE FROM " + path + "\nWHERE <Search Conditions,,>;",
            $"INSERT, UPDATE and DELETE use SSMS's template placeholders: {insert} | {update} | {delete}");
        var dml = new[] { "SNAPSHOT", "VIEW", "MATERIALIZED_VIEW", "EXTERNAL" }.SelectMany(type => new[] { "insert", "update", "delete" }.Select(verb => BigQueryService.Template(verb, type, Fields(), path)));
        check(dml.All(text => text is null), "only a TABLE has INSERT, UPDATE and DELETE templates");
        var drops = new[] { "TABLE", "SNAPSHOT", "VIEW", "MATERIALIZED_VIEW", "EXTERNAL" }.Select(type => BigQueryService.Template("drop", type, [], path)).ToArray();
        var comments = BigQueryService.Template("insert", "TABLE", [new() { Name = "a#b", Type = "STRING" }, new() { Name = "c--d", Type = "STRING" }], path);
        check(comments == "INSERT INTO " + path + " (`a#b`, `c--d`)\nVALUES (<a_b, STRING,>, <c__d, STRING,>);",
            "a placeholder never holds # or --, which would start a GoogleSQL comment: " + comments);
        check(drops.SequenceEqual(["DROP TABLE IF EXISTS " + path + ";", "DROP SNAPSHOT TABLE IF EXISTS " + path + ";", "DROP VIEW IF EXISTS " + path + ";",
            "DROP MATERIALIZED VIEW IF EXISTS " + path + ";", "DROP EXTERNAL TABLE IF EXISTS " + path + ";"]), "DROP names the object's type: " + string.Join(" | ", drops));
    }

    static void Facts(Action<bool, string> check)
    {
        var table = JsonSerializer.Deserialize<Table>(BigQueryFake.FixtureText("table-orders"), new JsonSerializerOptions(JsonSerializerDefaults.Web))!;
        var mapped = BigQueryService.MapTable(table, "orders", "varia-alpha.sales.orders", 12);
        var (type, groups) = (mapped.Type, mapped.Groups);
        string? Fact(string group, string label) => groups.FirstOrDefault(item => item.Title == group)?.Facts.FirstOrDefault(fact => fact.Label == label)?.Value;
        check(type == "table" && groups.Select(group => group.Title).SequenceEqual(["Table", "Storage", "Layout", "History"])
            && Fact("Table", "Labels") == "env: dev, team: sales" && Fact("Storage", "Rows") == "1,234,567" && Fact("Storage", "Long-term logical size") is not null
            && Fact("Layout", "Partitioning") == "DAY on placed, partitions expire after 90 days" && Fact("Layout", "Clustering") == "customer, region" && Fact("Layout", "Columns") == "6"
            && Fact("History", "Created") == "2023-11-14 22:13:20 UTC" && Fact("History", "Expires") is null,
            "Properties' facts come from tables.get, formatted, empty facts left out: " + string.Join(" | ", groups.SelectMany(group => group.Facts.Select(fact => group.Title + "." + fact.Label + "=" + fact.Value))));

        // Structured metadata from the same free tables.get payload: identity, storage, layout, nested schema, labels, no native DDL.
        var address = mapped.Schema?.FirstOrDefault(column => column.Name == "address");
        var geo = address?.Fields?.FirstOrDefault(field => field.Name == "geo");
        var lat = geo?.Fields?.FirstOrDefault(field => field.Name == "lat");
        check(mapped.FullName == "varia-alpha.sales.orders" && mapped.Location == "US" && mapped.Description == "Orders placed online."
            && mapped.BaseTable is null && mapped.CreatedUtc == "2023-11-14 22:13:20 UTC" && mapped.ModifiedUtc == "2023-11-15 22:13:20 UTC"
            && mapped.ExpiresUtc is null && mapped.SnapshotTimeUtc is null
            && mapped.Storage == new BigQueryStorageInfo(1_234_567, 5_368_709_120, 0, 1_073_741_824)
            && mapped.Layout is { Partitioning: "DAY on placed, partitions expire after 90 days", RequirePartitionFilter: true }
            && mapped.Layout.Clustering is ["customer", "region"]
            && mapped.Labels is [BigQueryLabel { Key: "env", Value: "dev" }, BigQueryLabel { Key: "team", Value: "sales" }]
            && mapped.Schema is { Count: 6 } && mapped.SchemaTruncated is null
            && mapped.Schema[0] is { Name: "id", Type: "INT64", Mode: "REQUIRED", Fields: null }
            && mapped.Schema[2] is { Name: "tags", Type: "STRING", Mode: "REPEATED", Fields: null }
            && address is { Type: "STRUCT" } && geo is { Type: "STRUCT" } && lat is { Type: "FLOAT64", Fields: null }
            && mapped.Definition is null && mapped.DefinitionCut is null && mapped.DefinitionTruncated is null,
            "Properties' structured fields map native table identity, storage, layout, nested STRUCT/REPEATED schema and sorted labels with no definition");

        // Parameterized column types and surrogate-pair-safe clipping.
        var surrogateDescription = new string('a', BigQueryPropertiesLimits.ColumnDescription - 2) + "😀tail";
        var richSchema = BigQueryService.MapTable(new Table
        {
            Type = "TABLE",
            Schema = new TableSchema
            {
                Fields =
                [
                    new TableFieldSchema { Name = "code", Type = "STRING", MaxLength = 16, Description = surrogateDescription },
                    new TableFieldSchema { Name = "amount", Type = "DECIMAL", Precision = 10, Scale = 2 },
                    new TableFieldSchema { Name = "big", Type = "BIGDECIMAL", Precision = 38 },
                    new TableFieldSchema { Name = "flag", Type = "BOOLEAN" },
                    new TableFieldSchema { Name = "span", Type = "RANGE", RangeElementType = new TableFieldSchema.RangeElementTypeData { Type = "date" } },
                    new TableFieldSchema { Name = "", Type = "STRING" }
                ]
            }
        }, "typed", "p.d.typed", 1);
        var clippedDescription = richSchema.Schema![0].Description!;
        check(richSchema.Schema.Count == 5
            && richSchema.Schema[0].Type == "STRING(16)" && clippedDescription.Length == BigQueryPropertiesLimits.ColumnDescription - 1
            && clippedDescription.EndsWith('…') && !char.IsSurrogate(clippedDescription[^2])
            && richSchema.Schema[1].Type == "NUMERIC(10, 2)" && richSchema.Schema[2].Type == "BIGNUMERIC(38)"
            && richSchema.Schema[3].Type == "BOOL" && richSchema.Schema[4].Type == "RANGE<DATE>",
            "Parameterized column types normalize to GoogleSQL and surrogate pairs are never split on clip");

        // Views and materialized views expose their SQL free from tables.get; native/external/snapshot/clone never do.
        var view = BigQueryService.MapTable(new Table
        {
            Type = "VIEW",
            View = new ViewDefinition { Query = "SELECT id, customer FROM `varia-alpha.sales.orders`" }
        }, "orders_v", "varia-alpha.sales.orders_v", 2);
        var mv = BigQueryService.MapTable(new Table
        {
            Type = "MATERIALIZED_VIEW",
            MaterializedView = new MaterializedViewDefinition { Query = "SELECT customer, COUNT(*) AS n FROM `varia-alpha.sales.orders` GROUP BY 1" }
        }, "orders_mv", "varia-alpha.sales.orders_mv", 3);
        var longView = BigQueryService.MapTable(new Table
        {
            Type = "VIEW",
            View = new ViewDefinition { Query = new string('x', BigQueryPropertiesLimits.DefinitionChars - 1) + "😀" }
        }, "huge_v", "varia-alpha.sales.huge_v", 4);
        var nativeWithStrayView = BigQueryService.MapTable(new Table
        {
            Type = "TABLE",
            View = new ViewDefinition { Query = "SELECT 1" },
            MaterializedView = new MaterializedViewDefinition { Query = "SELECT 2" }
        }, "orders", "varia-alpha.sales.orders", 5);
        var externalWithStrayView = BigQueryService.MapTable(new Table
        {
            Type = "EXTERNAL",
            View = new ViewDefinition { Query = "SELECT 1" }
        }, "ext", "varia-alpha.sales.ext", 6);
        var untypedView = BigQueryService.MapTable(new Table
        {
            View = new ViewDefinition { Query = "SELECT 42" }
        }, "emu_v", "varia-alpha.sales.emu_v", 7);
        var untypedMv = BigQueryService.MapTable(new Table
        {
            Type = "",
            MaterializedView = new MaterializedViewDefinition { Query = "SELECT 99" }
        }, "emu_mv", "varia-alpha.sales.emu_mv", 8);
        check(view is { Type: "view", Definition: "SELECT id, customer FROM `varia-alpha.sales.orders`", DefinitionCut: null, DefinitionTruncated: null }
            && mv is { Type: "materialized view", Definition: "SELECT customer, COUNT(*) AS n FROM `varia-alpha.sales.orders` GROUP BY 1", DefinitionCut: null, DefinitionTruncated: null }
            && longView is { DefinitionCut: true, DefinitionTruncated: true } && longView.Definition!.Length == BigQueryPropertiesLimits.DefinitionChars - 1 && !char.IsSurrogate(longView.Definition[^1])
            && nativeWithStrayView is { Definition: null, DefinitionCut: null, DefinitionTruncated: null }
            && externalWithStrayView is { Type: "external table", Definition: null, DefinitionCut: null, DefinitionTruncated: null }
            && untypedView is { Definition: "SELECT 42", DefinitionCut: null, DefinitionTruncated: null }
            && untypedMv is { Definition: "SELECT 99", DefinitionCut: null, DefinitionTruncated: null },
            "View and materialized view SQL come from tables.get with surrogate-safe truncation (including when type is omitted by an emulator); native and external tables omit definition");

        // Snapshot, clone and malformed base table reference.
        var snapshotTime = new DateTimeOffset(2025, 6, 1, 12, 30, 0, TimeSpan.Zero);
        var snapshot = BigQueryService.MapTable(new Table
        {
            Type = "SNAPSHOT",
            SnapshotDefinition = new SnapshotDefinition
            {
                BaseTableReference = new TableReference { ProjectId = "varia-alpha", DatasetId = "sales", TableId = "orders" },
                SnapshotTimeDateTimeOffset = snapshotTime
            },
            View = new ViewDefinition { Query = "SELECT 1" }
        }, "orders_snap", "varia-alpha.sales.orders_snap", 1);
        table.CloneDefinition = new CloneDefinition { BaseTableReference = new TableReference { ProjectId = "varia-alpha", DatasetId = "sales", TableId = "base" } };
        table.Description = new string('x', 5000);
        var (clone, cloneGroups) = BigQueryService.Facts(table, "varia-alpha.sales.orders");
        var cloneMapped = BigQueryService.MapTable(table, "orders", "varia-alpha.sales.orders", 1);
        var description = cloneGroups[0].Facts.First(fact => fact.Label == "Description").Value;
        var partialRef = BigQueryService.MapTable(new Table { Type = "SNAPSHOT", SnapshotDefinition = new SnapshotDefinition { BaseTableReference = new TableReference { ProjectId = "p" } } }, "s", "p.d.s", 1);
        check(snapshot is { Type: "snapshot", BaseTable: "varia-alpha.sales.orders", SnapshotTimeUtc: "2025-06-01 12:30:00 UTC", Definition: null }
            && clone == "clone" && cloneGroups[0].Facts.Any(fact => fact.Label == "Base table" && fact.Value == "varia-alpha.sales.base")
            && cloneMapped is { Type: "clone", BaseTable: "varia-alpha.sales.base", Definition: null }
            && description.Length == BigQueryService.MaxFactValue && description.EndsWith('…') && partialRef.BaseTable is null,
            "snapshot and clone expose baseTable and snapshotTimeUtc cleanly, and a long value is clipped");

        // Storage clamps > MAX_SAFE_INTEGER and omits negatives; empty/minimal table omits optional fields.
        var extremeStorage = BigQueryService.MapTable(new Table
        {
            NumRows = ulong.MaxValue,
            NumBytes = long.MaxValue,
            NumLongTermBytes = -5,
            NumTotalPhysicalBytes = -1
        }, "huge", "p.d.huge", -10);
        var minimal = BigQueryService.MapTable(new Table(), "empty", "p.d.empty", 0);
        check(extremeStorage.ElapsedMs == 0
            && extremeStorage.Storage == new BigQueryStorageInfo(BigQueryLimits.MaxSafeInteger, BigQueryLimits.MaxSafeInteger, null, null)
            && minimal is { Type: "table", Storage: null, Layout: null, Columns: null, ColumnsCut: null, Schema: null, SchemaTruncated: null, Labels: null, Definition: null, DefinitionCut: null, DefinitionTruncated: null, Location: null, Description: null, BaseTable: null, CreatedUtc: null, ModifiedUtc: null, ExpiresUtc: null, SnapshotTimeUtc: null },
            "Storage clamps safe-integer overflows, drops negatives, and minimal tables omit empty structured sections");

        // Deep nesting (> SchemaDepth = 7), huge column count (> SchemaFields = 10,000), huge text bytes, and label/clustering caps.
        TableFieldSchema Nest(int levels)
        {
            var leaf = new TableFieldSchema { Name = "l" + levels, Type = "INT64" };
            for (var i = levels - 1; i >= 1; i--) leaf = new TableFieldSchema { Name = "l" + i, Type = "RECORD", Fields = [leaf] };
            return leaf;
        }
        var deep = BigQueryService.MapTable(new Table { Schema = new TableSchema { Fields = [Nest(12)] } }, "deep", "p.d.deep", 1);
        var depthCount = 0;
        for (var cur = deep.Schema!.Single(); cur is not null; cur = cur.Fields?.SingleOrDefault()) depthCount++;
        var wide = BigQueryService.MapTable(new Table
        {
            Schema = new TableSchema { Fields = [.. Enumerable.Range(0, BigQueryPropertiesLimits.SchemaFields + 50).Select(i => new TableFieldSchema { Name = "c" + i, Type = "STRING" })] },
            Labels = Enumerable.Range(0, 80).ToDictionary(i => $"k{i:D2}", i => $"v{i:D2}"),
            Clustering = new Clustering { Fields = [.. Enumerable.Range(0, 20).Select(i => "cl" + i)] }
        }, "wide", "p.d.wide", 1);
        var heavyText = BigQueryService.MapTable(new Table
        {
            Type = "VIEW",
            View = new ViewDefinition { Query = new string('é', BigQueryPropertiesLimits.DefinitionChars) },
            Schema = new TableSchema { Fields = [.. Enumerable.Range(0, 6000).Select(i => new TableFieldSchema { Name = "h" + i, Type = "STRING", Description = new string('é', 1000) })] }
        }, "heavy", "p.d.heavy", 1);
        check(depthCount == BigQueryPropertiesLimits.SchemaDepth && deep.SchemaTruncated == true
            && wide.Schema!.Count == BigQueryPropertiesLimits.SchemaFields && wide.SchemaTruncated == true
            && wide.Labels!.Count == BigQueryPropertiesLimits.Labels && wide.Labels[0].Key == "k00" && wide.Labels[^1].Key == "k63"
            && wide.Layout!.Clustering!.Count == BigQueryPropertiesLimits.ClusteringFields
            && heavyText.SchemaTruncated == true && heavyText.Schema!.Count < 6000,
            $"Schema depth, field count, text byte budget, labels and clustering enforce bounds cleanly: depth={depthCount} wide={wide.Schema?.Count} heavy={heavyText.Schema?.Count}");

        // Wire round-trip at exact RESPONSE depth=1 proves 7-level nested schema + max safe counts + worst-case combined heavy payload fit protocol v2 (MaxDepth=16, 16 MiB).
        byte[] EncodeResponse(BigQueryProperties payload)
        {
            var buffer = new System.Buffers.ArrayBufferWriter<byte>();
            var writer = new Varia.Backend.Protocol.MsgPackWriter(buffer);
            writer.WriteMapHeader(1);
            writer.WriteString("result");
            Varia.Backend.Protocol.JsonBridge.FromJson(JsonSerializer.SerializeToUtf8Bytes(payload, Wire), writer, depth: 1);
            return buffer.WrittenSpan.ToArray();
        }
        var deepWire = EncodeResponse(deep);
        var decodedDeep = Varia.Backend.Protocol.JsonBridge.ParseControl(deepWire);
        var heavyWire = EncodeResponse(heavyText);
        check(decodedDeep.GetProperty("result").GetProperty("schemaTruncated").GetBoolean()
            && heavyWire.Length < Varia.Backend.Protocol.ProtocolLimits.ResponseBody,
            $"7-level nested schema and combined worst-case heavy payload round-trip within protocol v2 depth and 16 MiB limits ({heavyWire.Length} bytes)");

        // Structured routine mapping: scalar, TVF return table type, determinism, arguments, truncation & wire round-trip.
        var richRoutine = BigQueryService.MapRoutine(new Routine
        {
            RoutineType = "TABLE_VALUED_FUNCTION",
            Language = "SQL",
            DeterminismLevel = "DETERMINISTIC",
            Description = "Orders for a customer.",
            CreationTime = 1700000000000,
            LastModifiedTime = 1700086400000,
            DefinitionBody = "SELECT id FROM `varia-alpha.sales.orders` WHERE customer = target_customer",
            Arguments =
            [
                new Argument { Name = "target_customer", Mode = "IN", ArgumentKind = "FIXED_TYPE", DataType = new StandardSqlDataType { TypeKind = "STRING" } },
                new Argument { Name = "tags", ArgumentKind = "FIXED_TYPE", DataType = new StandardSqlDataType { TypeKind = "ARRAY", ArrayElementType = new StandardSqlDataType { TypeKind = "STRING" } } },
                new Argument { Name = "dyn", ArgumentKind = "ANY_TYPE" }
            ],
            ReturnTableType = new StandardSqlTableType
            {
                Columns = [new StandardSqlField { Name = "id", Type = new StandardSqlDataType { TypeKind = "INT64" } }]
            }
        }, "orders_for_customer", "varia-alpha.sales.orders_for_customer", 5);
        var wideRoutine = BigQueryService.MapRoutine(new Routine
        {
            RoutineType = "PROCEDURE",
            Language = "SQL",
            DeterminismLevel = "DETERMINISM_LEVEL_UNSPECIFIED",
            DefinitionBody = "   ",
            Arguments = [.. Enumerable.Range(0, BigQueryPropertiesLimits.RoutineArguments + 10).Select(i => new Argument { Name = "p" + i, Mode = "INOUT", DataType = new StandardSqlDataType { TypeKind = "INT64" } })]
        }, "many_args", "p.d.many_args", 1);
        var routineWire = EncodeResponse(richRoutine);
        var decodedRoutine = Varia.Backend.Protocol.JsonBridge.ParseControl(routineWire).GetProperty("result");
        check(richRoutine is { Type: "table function", Routine: { RoutineType: "TABLE_VALUED_FUNCTION", Language: "SQL", Determinism: "DETERMINISTIC", ReturnType: "TABLE<id INT64>", ArgumentsTruncated: null } }
            && richRoutine.Routine.Arguments is [{ Name: "target_customer", Type: "STRING", Mode: "IN" }, { Name: "tags", Type: "ARRAY<STRING>" }, { Name: "dyn", Type: "ANY TYPE", Kind: "ANY_TYPE" }]
            && wideRoutine is { Definition: null, DefinitionCut: null, DefinitionTruncated: null, Routine: { RoutineType: "PROCEDURE", Determinism: null, ArgumentsTruncated: true } } && wideRoutine.Routine.Arguments!.Count == BigQueryPropertiesLimits.RoutineArguments
            && decodedRoutine.GetProperty("routine").GetProperty("arguments").GetArrayLength() == 3,
            "MapRoutine maps routine type, language, determinism, return type, bounded arguments, omits whitespace-only definition, and round-trips through Protocol v2");

        // Structured dataset mapping: location, default expirations, KMS encryption, collation, time travel, billing, sorted labels & wire round-trip.
        var richDataset = BigQueryService.MapDataset(new Dataset
        {
            Location = "EU",
            FriendlyName = "Sales Analytics",
            Description = "Primary commerce dataset.",
            DefaultTableExpirationMs = 86_400_000L * 90,
            DefaultPartitionExpirationMs = 86_400_000L * 30,
            DefaultEncryptionConfiguration = new EncryptionConfiguration { KmsKeyName = "projects/p/locations/eu/keyRings/r/cryptoKeys/k" },
            DefaultCollation = "und:ci",
            IsCaseInsensitive = true,
            MaxTimeTravelHours = 168,
            StorageBillingModel = "PHYSICAL",
            CreationTime = 1700000000000,
            LastModifiedTime = 1700086400000,
            Labels = new Dictionary<string, string> { ["tier"] = "gold", ["domain"] = "commerce" }
        }, "sales", "varia-alpha.sales", 4);
        var minimalDataset = BigQueryService.MapDataset(new Dataset(), "empty_ds", "p.empty_ds", 0);
        var longKmsDataset = BigQueryService.MapDataset(new Dataset
        {
            DefaultEncryptionConfiguration = new EncryptionConfiguration { KmsKeyName = new string('k', BigQueryPropertiesLimits.KmsKeyName + 50) }
        }, "kms_ds", "p.kms_ds", 1);
        var datasetWire = EncodeResponse(richDataset);
        var decodedDataset = Varia.Backend.Protocol.JsonBridge.ParseControl(datasetWire).GetProperty("result");
        check(richDataset is { Type: "dataset", FullName: "varia-alpha.sales", Location: "EU", Description: "Primary commerce dataset.", CreatedUtc: "2023-11-14 22:13:20 UTC", ModifiedUtc: "2023-11-15 22:13:20 UTC" }
            && richDataset.Dataset is { FriendlyName: "Sales Analytics", DefaultTableExpirationMs: 7_776_000_000, DefaultPartitionExpirationMs: 2_592_000_000, KmsKeyName: "projects/p/locations/eu/keyRings/r/cryptoKeys/k", DefaultCollation: "und:ci", IsCaseInsensitive: true, MaxTimeTravelHours: 168, StorageBillingModel: "PHYSICAL" }
            && richDataset.Labels is [BigQueryLabel { Key: "domain", Value: "commerce" }, BigQueryLabel { Key: "tier", Value: "gold" }]
            && minimalDataset is { Type: "dataset", Dataset: null, Labels: null, Location: null, Description: null }
            && longKmsDataset.Dataset!.KmsKeyName!.Length == BigQueryPropertiesLimits.KmsKeyName
            && decodedDataset.GetProperty("dataset").GetProperty("kmsKeyName").GetString() == "projects/p/locations/eu/keyRings/r/cryptoKeys/k",
            "MapDataset maps location, expirations, KMS encryption, collation, time travel, billing, sorted labels, bounds, and round-trips through Protocol v2");

        // Adversarial timestamps, cyclic/degenerate schemas, and range/non-positive-expiration partitioning.
        var badTimes = BigQueryService.MapTable(new Table
        {
            Type = "SNAPSHOT",
            CreationTime = 0,
            LastModifiedTime = ulong.MaxValue,
            ExpirationTime = -100,
            SnapshotDefinition = new SnapshotDefinition { SnapshotTimeRaw = "not-a-timestamp" }
        }, "bad_times", "p.d.bad_times", 1);
        var maxLongTimes = BigQueryService.MapTable(new Table
        {
            CreationTime = long.MaxValue,
            LastModifiedTime = 0,
            ExpirationTime = long.MaxValue
        }, "max_times", "p.d.max_times", 1);
        var cycle = new TableFieldSchema { Name = "loop", Type = "RECORD" };
        cycle.Fields = [cycle];
        var cyclic = BigQueryService.MapTable(new Table { Schema = new TableSchema { Fields = [cycle] } }, "cyclic", "p.d.cyclic", 1);
        var cycleDepth = 0;
        for (var cur = cyclic.Schema!.Single(); cur is not null; cur = cur.Fields?.SingleOrDefault()) cycleDepth++;
        var emptyFields = BigQueryService.MapTable(new Table
        {
            Schema = new TableSchema { Fields = [.. Enumerable.Range(0, BigQueryPropertiesLimits.SchemaFields * 4 + 5).Select(_ => new TableFieldSchema { Name = "", Type = "STRING" })] }
        }, "empty_fields", "p.d.empty_fields", 1);
        var rangeWithField = BigQueryService.MapTable(new Table { RangePartitioning = new RangePartitioning { Field = "bucket" } }, "r1", "p.d.r1", 1);
        var rangeNoField = BigQueryService.MapTable(new Table { RangePartitioning = new RangePartitioning() }, "r2", "p.d.r2", 1);
        var zeroExpiry = BigQueryService.MapTable(new Table { TimePartitioning = new TimePartitioning { Type = "DAY", Field = "ts", ExpirationMs = 0 } }, "t0", "p.d.t0", 1);
        var negExpiry = BigQueryService.MapTable(new Table { TimePartitioning = new TimePartitioning { Type = "HOUR", ExpirationMs = -5 } }, "tn", "p.d.tn", 1);
        check(badTimes is { CreatedUtc: null, ModifiedUtc: null, ExpiresUtc: null, SnapshotTimeUtc: null }
            && maxLongTimes is { CreatedUtc: null, ModifiedUtc: null, ExpiresUtc: null }
            && cycleDepth == BigQueryPropertiesLimits.SchemaDepth && cyclic.SchemaTruncated == true
            && emptyFields is { Schema: null, SchemaTruncated: true }
            && rangeWithField.Layout?.Partitioning == "integer range on bucket"
            && rangeNoField.Layout?.Partitioning == "integer range"
            && zeroExpiry.Layout?.Partitioning == "DAY on ts"
            && negExpiry.Layout?.Partitioning == "HOUR on _PARTITIONTIME",
            "Malformed timestamps, cyclic and degenerate schemas, range partitioning and non-positive expirations degrade cleanly without throwing");
    }

    static async Task LimiterAsync(Action<bool, string> check)
    {
        var limiter = new BigQueryRateLimiter(2);
        var first = await limiter.EnterAsync("ada", CancellationToken.None);
        var second = await limiter.EnterAsync("ada", CancellationToken.None);
        var other = await limiter.EnterAsync("grace", CancellationToken.None);
        var third = limiter.EnterAsync("ada", CancellationToken.None);
        var waited = !third.IsCompleted && limiter.InUse("ada") == 2 && limiter.InUse("grace") == 1;
        first.Dispose();
        first.Dispose();
        var entered = await third.WaitAsync(TimeSpan.FromSeconds(30));
        check(waited && limiter.InUse("ada") == 2, "a principal's calls wait for one of its slots, another principal's do not, and a slot is returned once");
        using var cancel = new CancellationTokenSource();
        var fourth = limiter.EnterAsync("ada", cancel.Token);
        cancel.Cancel();
        var refused = false;
        try { await fourth; } catch (OperationCanceledException) { refused = true; }
        second.Dispose();
        entered.Dispose();
        other.Dispose();
        check(refused && limiter.InUse("ada") == 0 && limiter.InUse("grace") == 0, "a call waiting for a slot ends with its deadline and takes none");
        var rate = Api(429, "rateLimitExceeded");
        var forbidden = Api(403, "rateLimitExceeded");
        var denied = Api(403, "accessDenied");
        check(BigQueryRateLimiter.RateLimited(rate) && BigQueryRateLimiter.RateLimited(new HttpRequestException("x", forbidden)) && !BigQueryRateLimiter.RateLimited(denied)
            && !BigQueryRateLimiter.RateLimited(new TimeoutException()),
            "a 429, or a 403 for rateLimitExceeded, is a rate limit; an access denial is not");
    }

    static Google.GoogleApiException Api(int status, string reason) => new("bigquery", "refused")
    {
        HttpStatusCode = (System.Net.HttpStatusCode)status,
        Error = new Google.Apis.Requests.RequestError { Code = status, Message = "refused", Errors = [new Google.Apis.Requests.SingleError { Reason = reason, Message = "refused" }] }
    };

    // tables.get selects table columns with selectedFields, so any caller asking for a complete schema must leave it unset.
    static BigQueryFake.Reply TableSchema(BigQueryFake.Request request, string fixture)
    {
        var reply = BigQueryFake.Fixture(fixture);
        var selected = System.Web.HttpUtility.ParseQueryString(request.Uri.Query)["selectedFields"];
        if (selected is null) return reply;
        var table = JsonNode.Parse(reply.Body)!.AsObject();
        var fields = table["schema"]!["fields"]!.AsArray();
        var names = selected.Split(',').ToHashSet(StringComparer.Ordinal);
        table["schema"]!["fields"] = new JsonArray(fields.Where(field => names.Contains(field!["name"]!.GetValue<string>())).Select(field => field!.DeepClone()).ToArray());
        return reply with { Body = table.ToJsonString() };
    }

    sealed class Harness : IDisposable
    {
        public BigQueryFake Fake { get; }
        public SqlService Service { get; }
        public string ConnectionId { get; private set; } = "";

        public Harness(Varia.Backend.Results.ResultStore? store = null)
        {
            Fake = BigQueryFake.Google()
                .On("GET", Base + "/datasets/sales/tables", BigQueryFake.Fixture("tables"))
                .On("GET", Sales + "/tables/orders", request => TableSchema(request, "table-orders"))
                .On("GET", Sales + "/tables/preview", request => TableSchema(request, "table-preview"))
                .On("GET", Sales + "/tables/preview/data", BigQueryFake.Fixture("tabledata"))
                .On("GET", Sales + "/routines", BigQueryFake.Fixture("routines"))
                .On("GET", Sales + "/routines/refresh_totals", BigQueryFake.Fixture("routine-procedure"))
                .On("GET", Sales + "/models", BigQueryFake.Fixture("models"));
            Service = new SqlService(store ?? CheckStores.Unprobed(), bigQuery: new BigQueryEnvironment(null, Fake.Factory, new SubjectTokens([])));
            Service.BigQuery.RetryDelay = TimeSpan.FromMilliseconds(1);
        }

        public async Task ConnectAsync(JsonObject key, long? cap = null)
        {
            var options = new JsonObject
            {
                ["provider"] = "bigquery", ["project"] = "varia-alpha", ["authentication"] = "serviceAccountKey", ["dataset"] = "sales", ["location"] = "US",
                ["credential"] = new JsonObject { ["source"] = "file", ["json"] = key.ToJsonString() }, ["keyFile"] = Guid.NewGuid().ToString()
            };
            if (cap is { } bytes) options["maximumBytesBilled"] = bytes;
            var (code, result, message) = await Call("connections.connect", options);
            if (code != "ok") throw new InvalidOperationException("connect: " + code + " " + message);
            ConnectionId = ((ConnectionInfo)result!).Id;
        }

        public async Task<(string Code, object? Result, string Message)> Call(string method, JsonNode parameters, RequestContext? context = null)
        {
            using var document = JsonDocument.Parse(parameters.ToJsonString());
            try { return ("ok", await Service.DispatchAsync(method, document.RootElement.Clone(), Wire, context), ""); }
            catch (RequestException error) { return (error.Code, null, error.Message); }
        }

        public async Task<ExplorerChildrenResult?> Children(JsonObject node, string? cursor = null, int pageSize = 500)
        {
            var args = new JsonObject { ["connectionId"] = ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["node"] = node, ["pageSize"] = pageSize };
            if (cursor is not null) args["cursor"] = cursor;
            var (code, result, message) = await Call("explorer.children", args);
            return code == "ok" ? result as ExplorerChildrenResult : throw new InvalidOperationException(code + " " + message);
        }

        public async Task<(string Code, ScriptResult? Result)> Script(string verb, JsonObject target, bool? estimateOnly = null, long? cap = null)
        {
            var args = new JsonObject
            {
                ["connectionId"] = ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["targets"] = new JsonArray(target), ["verb"] = verb,
                ["options"] = JsonSerializer.SerializeToNode(ScriptingLiveChecks.Defaults(Wire), Wire)
            };
            if (estimateOnly is { } estimate) args["estimateOnly"] = estimate;
            if (cap is { } bytes) args["maximumBytesBilled"] = bytes;
            var (code, result, _) = await Call("scripting.script", args);
            return (code, result as ScriptResult);
        }

        public void Dispose() => Service.Dispose();
    }

    static JsonObject Object(string kind, string name, string? dataset = "sales", string? table = null)
    {
        var value = new JsonObject { ["kind"] = kind, ["name"] = name };
        if (kind != "bqProject") value["project"] = "varia-alpha";
        if (dataset is not null && kind != "bqProject" && kind != "bqDataset") value["dataset"] = dataset;
        if (table is not null) value["table"] = table;
        return new JsonObject { ["type"] = "object", ["object"] = value };
    }

    static JsonObject Folder(JsonObject owner, string folder) => new() { ["type"] = "folder", ["owner"] = owner["object"]!.DeepClone(), ["folder"] = folder };

    static string Labels(ExplorerChildrenResult? result) => result is null ? "null" : string.Join(", ", result.Nodes.Select(node => node.Label + (node.Subtype is { } s ? "/" + s : "") + (node.Sublabel is { } l ? " (" + l + ")" : "")));

    static async Task ListersAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        var server = await harness.Children(new JsonObject { ["type"] = "object", ["object"] = new JsonObject { ["kind"] = "server" } });
        check(Labels(server) == "varia-alpha (billing project)" && server!.Total == 1 && server.Nodes.All(node => node.Ref.Object!.Kind == "bqProject" && node.HasChildren),
            "the connection node lists only the billing project (starred and session projects live in Object Explorer): " + Labels(server));
        var datasets = await harness.Children(Object("bqProject", "varia-alpha"));
        check(Labels(datasets) == "staging (US), sales" && datasets!.Cursor is { } cursor && cursor.StartsWith("v1.bqDatasets.", StringComparison.Ordinal)
            && datasets.Nodes.All(node => node.Ref.Object is { Kind: "bqDataset", Project: "varia-alpha" }),
            "a project lists datasets.list's datasets with their location (a malformed id or location dropped) and a cursor: " + Labels(datasets) + " " + datasets?.Cursor);
        var second = await harness.Children(Object("bqProject", "varia-alpha"), datasets!.Cursor);
        check(harness.Fake.To(Base + "/datasets").Any(request => request.Uri.Query.Contains("pageToken=page-2", StringComparison.Ordinal)) && second is { Cursor: null },
            "the cursor carries datasets.list's page token back to it");
        var folders = await harness.Children(Object("bqDataset", "sales"));
        check(Labels(folders) == "Tables, Views, Materialized Views, External Tables, Routines, Models" && folders!.Nodes.All(node => node.Ref.Type == "folder"),
            "a dataset shows its six static folders without a request: " + Labels(folders));
        var dataset = Object("bqDataset", "sales");
        var tables = await harness.Children(Folder(dataset, "bqTables"));
        var views = await harness.Children(Folder(dataset, "bqViews"));
        var materialized = await harness.Children(Folder(dataset, "bqMaterializedViews"));
        var external = await harness.Children(Folder(dataset, "bqExternalTables"));
        check(Labels(tables) == "orders, orders_2024/snapshot" && Labels(views) == "daily" && Labels(materialized) == "totals" && Labels(external) == "landing"
            && tables!.Cursor is { } tableCursor && System.Text.RegularExpressions.Regex.IsMatch(tableCursor, "^v1\\.bqTables\\.[A-Za-z0-9_-]+$"),
            $"tables.list fills each folder with its types (a snapshot is a table), drops a refused name, and its cursor stays URL-safe: {Labels(tables)} | {Labels(views)} | {Labels(materialized)} | {Labels(external)} {tables?.Cursor}");
        await harness.Children(Folder(dataset, "bqTables"), tables!.Cursor);
        check(harness.Fake.To(Base + "/datasets/sales/tables").Any(request => Uri.UnescapeDataString(request.Uri.Query).Contains("pageToken=tables/page+2=", StringComparison.Ordinal)),
            "a page token with / + and = survives the cursor round trip");
        var routines = await harness.Children(Folder(dataset, "bqRoutines"));
        var models = await harness.Children(Folder(dataset, "bqModels"));
        check(Labels(routines) == "refresh_totals/procedure, to_cents/scalar (JAVASCRIPT)" && Labels(models) == "churn (logistic regression)" && !routines!.Nodes[0].HasChildren,
            $"routines.list and models.list fill Routines and Models: {Labels(routines)} | {Labels(models)}");
        var orders = Object("bqTable", "orders");
        var columns = await harness.Children(Folder(orders, "bqColumns"));
        check(Labels(columns) == "id (INT64, required), customer (STRING), tags (ARRAY<STRING>), placed (TIMESTAMP), address/struct (STRUCT)" && columns!.Total == 6
            && columns.Nodes.Single(node => node.Label == "address") is { HasChildren: true, Ref.Object: { Kind: "bqColumn", Table: "orders", Name: "address" } },
            "a table's Columns come from tables.get's schema with their types; a STRUCT expands: " + Labels(columns));
        var paged = await harness.Children(Folder(orders, "bqColumns"), pageSize: 2);
        var rest = await harness.Children(Folder(orders, "bqColumns"), paged!.Cursor, pageSize: 2);
        check(Labels(paged) == "id (INT64, required), customer (STRING)" && paged.Cursor == "v1.bqColumns.2" && Labels(rest).StartsWith("tags", StringComparison.Ordinal),
            "Columns page by offset: " + Labels(paged) + " | " + Labels(rest));
        var fields = await harness.Children(Object("bqColumn", "address", table: "orders"));
        var deeper = await harness.Children(Object("bqColumn", "address.geo", table: "orders"));
        var missing = await harness.Children(Object("bqColumn", "customer", table: "orders"));
        check(Labels(fields) == "city (STRING), geo/struct (STRUCT)" && Labels(deeper) == "lat (FLOAT64)" && deeper!.Nodes[0].Ref.Object!.Name == "address.geo.lat"
            && missing is { Error.Code: "NOT_FOUND" },
            $"a STRUCT column lists its fields by path; a column that is not a STRUCT answers NOT_FOUND: {Labels(fields)} | {Labels(deeper)} | {missing?.Error?.Code}");
        var (refusedCode, _, _) = await harness.Call("explorer.children", new JsonObject
        {
            ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["node"] = new JsonObject { ["type"] = "object", ["object"] = new JsonObject { ["kind"] = "database", ["name"] = "master" } }
        });
        var (hostileCode, _, _) = await harness.Call("explorer.children", new JsonObject
        {
            ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["node"] = Folder(Object("bqDataset", "sa`les"), "bqTables")
        });
        check(refusedCode == "INVALID_PARAMS" && hostileCode == "INVALID_PARAMS", $"a SQL Server kind, or a dataset its rule refuses, is refused before any request: {refusedCode} {hostileCode}");

        // The rate limit: two refusals, then the listing; a denial is the row's error, not retried.
        var limited = 0;
        harness.Fake.On("GET", Sales + "/models", _ => Interlocked.Increment(ref limited) <= 2 ? BigQueryFake.Fixture("error-rate-limit", 403) : BigQueryFake.Fixture("models"));
        var retried = await harness.Children(Folder(dataset, "bqModels"));
        harness.Fake.On("GET", Sales + "/routines", BigQueryFake.Fixture("error-access-denied", 403));
        var before = harness.Fake.To(Sales + "/routines").Count();
        var denied = await harness.Children(Folder(dataset, "bqRoutines"));
        check(limited == 3 && Labels(retried) == "churn (logistic regression)" && denied is { Nodes.Count: 0, Error: { Code: "PERMISSION_DENIED", Retryable: false } }
            && harness.Fake.To(Sales + "/routines").Count() == before + 1 && harness.Service.BigQuery.Limiter.InUse(harness.Service.BigQuery.Find(harness.ConnectionId)!.Principal.PrincipalId) == 0,
            $"a rate-limited listing retries until it lists; a denial is the row's error after one request, and the slots are returned: {limited} {denied?.Error?.Code} {denied?.Error?.Message}");
        check(harness.Fake.Unmatched.IsEmpty, "every listing request was answered by a fixture: " + string.Join(", ", harness.Fake.Unmatched.Select(request => request.Method + " " + request.Url)));
    }

    static async Task ScriptAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        var orders = Object("bqTable", "orders")["object"]!.AsObject();
        var select = await harness.Script("select", (JsonObject)orders.DeepClone());
        check(select is { Code: "ok", Result: { Error: null, Database: "sales", Commands: 0 } } && select.Result.Text!.Contains("  `address`\nFROM", StringComparison.Ordinal) && !select.Result.Text.Contains("bad", StringComparison.Ordinal)
            && System.Web.HttpUtility.ParseQueryString(harness.Fake.To(Sales + "/tables/orders").Last().Uri.Query)["fields"] == "schema,type",
            "Script As › SELECT reads tables.get's schema and runs in the dataset: " + select.Result?.Text);
        var drop = await harness.Script("drop", (JsonObject)Object("bqRoutine", "refresh_totals")["object"]!.DeepClone());
        check(drop.Result?.Text == "DROP PROCEDURE IF EXISTS `varia-alpha`.`sales`.`refresh_totals`;", "a routine's DROP reads its type from routines.get: " + drop.Result?.Text);
        harness.Fake.On("GET", Sales + "/routines/total", new BigQueryFake.Reply(200, """{"routineType":"AGGREGATE_FUNCTION"}"""));
        var aggregate = await harness.Script("drop", (JsonObject)Object("bqRoutine", "total")["object"]!.DeepClone());
        check(aggregate.Result?.Text == "DROP FUNCTION IF EXISTS `varia-alpha`.`sales`.`total`;", "an aggregate routine uses DROP FUNCTION: " + aggregate.Result?.Text);
        var jobsBefore = harness.Fake.To(BigQueryFake.Jobs).Count();
        var estimate = await harness.Script("create", (JsonObject)orders.DeepClone(), estimateOnly: true);
        var dryRun = harness.Fake.To(BigQueryFake.Jobs).Skip(jobsBefore).Select(request => JsonNode.Parse(request.Body)!).ToArray();
        check(estimate is { Code: "ok", Result: { Text: null, Estimate: not null } } && dryRun.Length == 1 && dryRun[0]["configuration"]!["dryRun"]!.GetValue<bool>()
            && dryRun[0]["configuration"]!["query"]!["query"]!.GetValue<string>() == BigQueryService.CreateSql("varia-alpha", "sales", false)
            && dryRun[0]["configuration"]!["query"]!["queryParameters"]![0]!["parameterValue"]!["value"]!.GetValue<string>() == "orders",
            "Script As › CREATE first asks for a dry run of its INFORMATION_SCHEMA query, the name a parameter: " + estimate.Code);
        var sqlServerKind = await harness.Script("select", new JsonObject { ["kind"] = "table", ["database"] = "sales", ["schema"] = "dbo", ["name"] = "orders" });
        check(sqlServerKind.Code == "INVALID_PARAMS", "a SQL Server kind cannot be scripted on a BigQuery connection: " + sqlServerKind.Code);
        var estimateDrop = await harness.Script("drop", (JsonObject)orders.DeepClone(), estimateOnly: true);
        harness.Fake.On("GET", Sales + "/tables/orders", BigQueryFake.Fixture("error-not-found", 404));
        var gone = await harness.Script("select", (JsonObject)orders.DeepClone());
        check(estimateDrop.Code == "INVALID_PARAMS" && gone.Result?.Error?.Code == "NOT_FOUND", $"only CREATE has an estimate, and a vanished table is the script's NOT_FOUND: {estimateDrop.Code} {gone.Result?.Error?.Code}");
    }

    /// <summary>The billed CREATE run: the job's query, parameter, location and cap; polling until its results are ready; zero rows
    /// and a NULL ddl; a script past 4,000,000 characters; and the job cancelled when the budget abandons it.</summary>
    static async Task CreateAsync(Action<bool, string> check, JsonObject key)
    {
        var inserts = new System.Collections.Concurrent.ConcurrentQueue<JsonNode>();
        var cancels = new System.Collections.Concurrent.ConcurrentQueue<string>();
        var polls = 0;
        JsonNode? ddl = "CREATE TABLE `varia-alpha.sales.orders`\n(\n  id INT64 NOT NULL\n)";
        var rows = 1;
        var hold = false;
        JsonObject? jobError = null;
        var dryRunDenied = false;
        BigQueryFake Routes(BigQueryFake fake) => fake
            .On("POST", BigQueryFake.Jobs, request =>
            {
                var body = JsonNode.Parse(request.Body)!;
                if (body["configuration"]?["dryRun"]?.GetValue<bool>() == true)
                    return dryRunDenied ? new BigQueryFake.Reply(403, "{\"error\":{\"code\":403,\"message\":\"Access Denied: Table varia-alpha:sales.orders: Permission bigquery.tables.get denied\",\"errors\":[{\"reason\":\"accessDenied\",\"message\":\"Access Denied\"}]}}")
                        : BigQueryFake.Fixture("dry-run");
                inserts.Enqueue(body);
                var id = body["jobReference"]!["jobId"]!.GetValue<string>();
                return new BigQueryFake.Reply(200, new JsonObject
                {
                    ["kind"] = "bigquery#job", ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "EU" },
                    ["status"] = jobError is null ? new JsonObject { ["state"] = "RUNNING" }
                        : new JsonObject { ["state"] = "DONE", ["errorResult"] = jobError.DeepClone(), ["errors"] = new JsonArray(jobError.DeepClone()) },
                    ["configuration"] = new JsonObject { ["jobType"] = "QUERY" }
                }.ToJsonString());
            })
            .On("GET", Base + "/queries/[^/]+", request =>
            {
                var id = request.Url[(request.Url.LastIndexOf('/') + 1)..];
                var reference = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "EU" };
                if (hold || Interlocked.Increment(ref polls) == 1)
                    return new BigQueryFake.Reply(200, new JsonObject { ["jobReference"] = reference, ["jobComplete"] = false }.ToJsonString());
                var answer = new JsonObject
                {
                    ["jobReference"] = reference, ["jobComplete"] = true, ["totalRows"] = rows.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    ["schema"] = new JsonObject { ["fields"] = new JsonArray(new JsonObject { ["name"] = "ddl", ["type"] = "STRING" }) }
                };
                if (rows > 0) answer["rows"] = new JsonArray(new JsonObject { ["f"] = new JsonArray(new JsonObject { ["v"] = ddl?.DeepClone() }) });
                return new BigQueryFake.Reply(200, answer.ToJsonString());
            })
            .On("POST", Base + "/jobs/[^/]+/cancel", request =>
            {
                var id = request.Url[..request.Url.LastIndexOf('/')];
                cancels.Enqueue(id[(id.LastIndexOf('/') + 1)..]);
                return new BigQueryFake.Reply(200, "{\"kind\":\"bigquery#jobCancelResponse\",\"job\":{\"jobReference\":{\"projectId\":\"varia-alpha\",\"jobId\":\"x\"},\"status\":{\"state\":\"DONE\"}}}");
            });
        var orders = Object("bqTable", "orders")["object"]!.AsObject();

        using (var harness = new Harness())
        {
            Routes(harness.Fake);
            harness.Service.BigQuery.DdlPoll = TimeSpan.FromMilliseconds(5);
            await harness.ConnectAsync(key);
            var created = await harness.Script("create", (JsonObject)orders.DeepClone(), cap: 50_000_000);
            var body = inserts.LastOrDefault();
            var query = body?["configuration"]?["query"];
            check(created is { Code: "ok", Result: { Error: null, Commands: 1, Database: "sales" } } && created.Result.Text == "CREATE TABLE `varia-alpha.sales.orders`\n(\n  id INT64 NOT NULL\n);"
                && polls == 2 && body?["configuration"]?["dryRun"]?.GetValue<bool>() != true && query?["query"]?.GetValue<string>() == BigQueryService.CreateSql("varia-alpha", "sales", false)
                && query?["queryParameters"]?[0]?["parameterValue"]?["value"]?.GetValue<string>() == "orders" && query?["maximumBytesBilled"]?.ToString() == "50000000"
                && body?["jobReference"]?["location"]?.GetValue<string>() is { Length: > 0 } && cancels.IsEmpty,
                $"Script As › CREATE runs its INFORMATION_SCHEMA query under the cap in the dataset's location, polls until ready, and ends the script: {created.Code} {created.Result?.Error?.Message} {created.Result?.Text} polls {polls} {body?.ToJsonString()}");
            rows = 0;
            var missing = await harness.Script("create", (JsonObject)orders.DeepClone());
            rows = 1;
            ddl = null;
            var empty = await harness.Script("create", (JsonObject)orders.DeepClone());
            check(missing.Result?.Error?.Code == "NOT_FOUND" && empty.Result?.Error?.Code == "NOT_SUPPORTED" && cancels.IsEmpty,
                $"no row is NOT_FOUND and a NULL ddl NOT_SUPPORTED, and a read job is not cancelled: {missing.Result?.Error?.Code} {empty.Result?.Error?.Code} {cancels.Count}");

            // The budget abandons a job that never finishes: TIMEOUT, and jobs.cancel for that job.
            hold = true;
            harness.Service.BigQuery.ScriptLimit = TimeSpan.FromMilliseconds(300);
            var abandoned = await harness.Script("create", (JsonObject)orders.DeepClone());
            var abandonedId = inserts.Last()["jobReference"]!["jobId"]!.GetValue<string>();
            var cancelled = await BigQuerySessionChecks.Poll(() => cancels.Contains(abandonedId));
            check(abandoned.Result?.Error?.Code == "TIMEOUT" && cancelled, $"a CREATE its budget abandons is TIMEOUT, and its job is cancelled: {abandoned.Result?.Error?.Code} {string.Join(",", cancels)}");
        }

        using (var capped = new Harness())
        {
            Routes(capped.Fake);
            hold = false;
            ddl = "CREATE VIEW v AS SELECT 1";
            capped.Service.BigQuery.DdlPoll = TimeSpan.FromMilliseconds(5);
            await capped.ConnectAsync(key, cap: 1_048_576);
            var run = await capped.Script("create", (JsonObject)orders.DeepClone(), cap: 50_000_000);
            jobError = new JsonObject { ["reason"] = "bytesBilledLimitExceeded", ["message"] = "Query exceeded limit for bytes billed: 1048576. 10485760 or higher required." };
            var overCap = await capped.Script("create", (JsonObject)orders.DeepClone());
            jobError = new JsonObject { ["reason"] = "accessDenied", ["message"] = "Access Denied: Table varia-alpha:sales.INFORMATION_SCHEMA.TABLES" };
            var denied = await capped.Script("create", (JsonObject)orders.DeepClone());
            jobError = null;
            dryRunDenied = true;
            var estimateDenied = await capped.Script("create", (JsonObject)orders.DeepClone(), estimateOnly: true);
            dryRunDenied = false;
            check(estimateDenied.Result?.Error is { Code: "PERMISSION_DENIED" } refusal && !refusal.Message.Contains("jobs.create", StringComparison.Ordinal) && refusal.Message.Contains("bigquery.tables.get", StringComparison.Ordinal),
                "a CREATE estimate refused for the table shows Google's reason, not jobs.create: " + estimateDenied.Result?.Error?.Message);
            check(overCap.Result?.Error?.Code == "COST_CAP" && denied.Result?.Error?.Code == "PERMISSION_DENIED",
                $"a CREATE job BigQuery fails keeps its own error (COST_CAP, PERMISSION_DENIED): {overCap.Result?.Error?.Code} {overCap.Result?.Error?.Message} {denied.Result?.Error?.Code}");
            check(run.Result?.Error is null && inserts.Last()["configuration"]!["query"]!["maximumBytesBilled"]!.ToString() == "1048576",
                "the connection's own cap wins over the one the prompts set: " + inserts.Last()["configuration"]!["query"]!["maximumBytesBilled"]);

            // A 10,000-column table's INSERT template passes 4,000,000 characters: TOO_LARGE, not an unbounded answer.
            var fields = new JsonArray([.. Enumerable.Range(0, 10_000).Select(i => (JsonNode)new JsonObject { ["name"] = "c" + i.ToString("D5", System.Globalization.CultureInfo.InvariantCulture) + new string('x', 290), ["type"] = "STRING" })]);
            capped.Fake.On("GET", Sales + "/tables/wide", new BigQueryFake.Reply(200, new JsonObject { ["type"] = "TABLE", ["schema"] = new JsonObject { ["fields"] = fields } }.ToJsonString()));
            var wide = await capped.Script("insert", (JsonObject)Object("bqTable", "wide")["object"]!.DeepClone());
            var narrow = await capped.Script("select", (JsonObject)Object("bqTable", "wide")["object"]!.DeepClone());
            check(wide.Result is { Text: null, Error.Code: "TOO_LARGE" } && narrow.Result?.Text is { Length: > 3_000_000 and <= 4_000_000 },
                $"a script past 4,000,000 characters is TOO_LARGE: {wide.Result?.Error?.Code} {narrow.Result?.Text?.Length}");
        }
    }

    static async Task PreviewAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        JsonObject Query(string table) => new()
        {
            ["connectionId"] = harness.ConnectionId, ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = "SELECT 1",
            ["maxRows"] = 0, ["timeoutSeconds"] = 0, ["preview"] = new JsonObject { ["project"] = "varia-alpha", ["dataset"] = "sales", ["table"] = table }
        };
        var jobsBefore = harness.Fake.To(BigQueryFake.Jobs).Count();
        var (code, result, message) = await harness.Call("query.execute", Query("preview"));
        var preview = result as QueryResult;
        var read = harness.Fake.To(Sales + "/tables/preview/data").Single();
        check(code == "ok" && preview is { Status: "completed", Database: "sales" } && preview.ResultSets is [{ RowsStored: 3, Columns: [{ Name: "id" }, { Name: "customer" }] } set]
            && LiveResultChecks.RowsOf(harness.Service.Results, set) is [["1", "ada"], ["2", null], ["3", "grace"]] && harness.Fake.To(BigQueryFake.Jobs).Count() == jobsBefore
            && read.Uri.Query.Contains("maxResults=1000", StringComparison.Ordinal) && read.Uri.Query.Contains("formatOptions.useInt64Timestamp=true", StringComparison.Ordinal)
            && preview.Messages.Any(item => item.Text.Contains("tabledata.list", StringComparison.Ordinal)),
            $"Preview Rows reads tabledata.list into a result and runs no job: {code} {message} {preview?.Status} {preview?.ResultSets.FirstOrDefault()?.RowsStored}");
        harness.Fake.On("GET", Sales + "/tables/daily", new BigQueryFake.Reply(200, "{\"type\":\"VIEW\",\"schema\":{\"fields\":[{\"name\":\"a\",\"type\":\"STRING\"}]}}"));
        var (_, viewResult, _) = await harness.Call("query.execute", Query("daily"));
        var view = viewResult is QueryResult { Status: "failed", Error.Code: "INVALID_PARAMS" } refused ? refused.Error.Message : null;
        harness.Fake.On("GET", Sales + "/tables/preview/data", BigQueryFake.Fixture("error-row-access", 400));
        var (rowCode, rowResult, _) = await harness.Call("query.execute", Query("preview"));
        var rows = rowResult as QueryResult;
        check(view is not null && view.Contains("Script As", StringComparison.Ordinal) && rows is { Status: "failed", Error.Code: "ROW_ACCESS" },
            $"a view is refused with Script As › SELECT offered; row access policies answer ROW_ACCESS: {view} {rows?.Status} {rows?.Error?.Code}");
        var (hostile, _, _) = await harness.Call("query.execute", Query("pre`view"));
        var badDataset = Query("preview");
        badDataset["dataset"] = "sa`les";
        var (datasetCode, _, _) = await harness.Call("query.execute", badDataset);
        var plan = Query("preview");
        plan["includeActualPlan"] = true;
        var (planCode, _, _) = await harness.Call("query.execute", plan);
        check(hostile == "INVALID_PARAMS" && datasetCode == "INVALID_PARAMS" && planCode == "UNSUPPORTED_PROVIDER",
            $"a preview of a refused name, with a refused tab dataset, or with SQL Server's options is refused: {hostile} {datasetCode} {planCode}");
        // A preview reads into memory whatever Keep results says, but its residence and window cache are bounded as Execute's.
        var badResidence = Query("preview");
        badResidence["residence"] = "disk";
        var (residenceCode, _, _) = await harness.Call("query.execute", badResidence);
        var badCache = Query("preview");
        badCache["windowCacheMiB"] = 1;
        var (cacheCode, _, _) = await harness.Call("query.execute", badCache);
        check(residenceCode == "INVALID_PARAMS" && cacheCode == "INVALID_PARAMS", $"a preview refuses an invalid residence or window cache: {residenceCode} {cacheCode}");

        // The tab keeps its own dataset (here the connection's), not the previewed table's, which may be another project's.
        harness.Fake.On("GET", Base + "/datasets/staging/tables/preview", BigQueryFake.Fixture("table-preview"));
        harness.Fake.On("GET", Base + "/datasets/staging/tables/preview/data", BigQueryFake.Fixture("tabledata"));
        var elsewhere = Query("preview");
        elsewhere["preview"]!["dataset"] = "staging";
        var (_, otherResult, _) = await harness.Call("query.execute", elsewhere);
        check(otherResult is QueryResult { Status: "completed", Database: "sales" }, "Preview Rows reports the tab's dataset, not the table's: " + (otherResult as QueryResult)?.Database);

        // A full result budget stops the reading: no page after the one the budget refused.
        using var small = new Harness(new Varia.Backend.Results.ResultStore(256 * 1024, 128 * 1024));
        await small.ConnectAsync(key);
        var wide = new string('w', 2000);
        small.Fake.On("GET", Sales + "/tables/preview/data", request =>
        {
            var page = request.Uri.Query.Contains("pageToken=", StringComparison.Ordinal) ? int.Parse(System.Web.HttpUtility.ParseQueryString(request.Uri.Query)["pageToken"]!, System.Globalization.CultureInfo.InvariantCulture) : 0;
            var rows = string.Join(",", Enumerable.Range(0, 50).Select(i => "{\"f\":[{\"v\":\"" + (page * 50 + i) + "\"},{\"v\":\"" + wide + "\"}]}"));
            return new BigQueryFake.Reply(200, "{\"totalRows\":\"1000\",\"rows\":[" + rows + "]" + (page < 19 ? ",\"pageToken\":\"" + (page + 1) + "\"" : "") + "}");
        });
        JsonObject SmallQuery() => new()
        {
            ["connectionId"] = small.ConnectionId, ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["sql"] = "SELECT 1",
            ["maxRows"] = 0, ["timeoutSeconds"] = 0, ["preview"] = new JsonObject { ["project"] = "varia-alpha", ["dataset"] = "sales", ["table"] = "preview" }
        };
        var (_, fullResult, _) = await small.Call("query.execute", SmallQuery());
        var full = fullResult as QueryResult;
        var pages = small.Fake.To(Sales + "/tables/preview/data").Count();
        check(full is { Status: "completed" } && full.ResultSets.Single() is { Truncated: "queryBudget" or "globalBudget" } && pages < 20,
            $"a preview the result budget stops completes without reading the table's other pages: {full?.Status} {full?.ResultSets.FirstOrDefault()?.Truncated} {pages} pages");
        check(full?.Messages.Any(message => message.Text.Contains("result memory budget is full", StringComparison.Ordinal)) == true, "a preview the result budget stops says so in Messages");
        // A low-memory stop says so, not that the budget is full.
        check(SqlService.PreviewStopNote(["systemMemory"]) is { } low && low.Contains("low on memory", StringComparison.Ordinal) && !low.Contains("budget", StringComparison.Ordinal)
            && SqlService.PreviewStopNote(["globalBudget", "systemMemory"])!.Contains("budget is full", StringComparison.Ordinal) && SqlService.PreviewStopNote([null, "rowLimit"]) is null,
            "Preview Rows says a low-memory stop is the computer's memory, and a budget stop the budget's");
    }

    static async Task PropertiesAsync(Action<bool, string> check, JsonObject key)
    {
        using var harness = new Harness();
        await harness.ConnectAsync(key);
        JsonObject Args(string kind, string name) => new()
        {
            ["connectionId"] = harness.ConnectionId, ["requestId"] = Guid.NewGuid().ToString(), ["kind"] = kind, ["project"] = "varia-alpha", ["dataset"] = "sales", ["name"] = name
        };
        var connected = harness.Fake.Seen.Count;
        var (code, result, _) = await harness.Call("bigquery.properties", Args("bqTable", "orders"));
        var properties = result as BigQueryProperties;
        var tableGets = harness.Fake.To(Sales + "/tables/orders").Count();
        var (model, _, _) = await harness.Call("bigquery.properties", Args("bqModel", "orders"));
        var (badRoutine, _, _) = await harness.Call("bigquery.properties", Args("bqRoutine", "a.b"));
        // The details pane's columns: the fields flattened depth first as the index has them (a bad name left out), descriptions beside them.
        var columns = properties?.Columns?.Select(column => column.Name + ":" + column.Type + (column.Description is { } description ? ":" + description : "")).ToArray() ?? [];
        check(columns.SequenceEqual(["id:INT64", "customer:STRING", "tags:ARRAY<STRING>", "placed:TIMESTAMP", "address:STRUCT", "address.city:STRING", "address.geo:STRUCT", "address.geo.lat:FLOAT64"])
            && properties is { Definition: null, DefinitionCut: null, DefinitionTruncated: null, ColumnsCut: null, Storage.Rows: 1_234_567, Schema.Count: 6, Labels.Count: 2 } && tableGets == 1,
            $"bigquery.properties answers a table's flat columns, structured metadata and no definition in one tables.get: {string.Join(" ", columns)}");
        var described = JsonNode.Parse(BigQueryFake.FixtureText("table-orders"))!;
        described["schema"]!["fields"]![1]!["description"] = "Who placed it.";
        described["schema"]!["fields"]![4]!["fields"]![0]!["description"] = new string('d', 2000);
        harness.Fake.On("GET", Sales + "/tables/orders", new BigQueryFake.Reply(200, described.ToJsonString()));
        var withDescriptions = (await harness.Call("bigquery.properties", Args("bqTable", "orders"))).Result as BigQueryProperties;
        check(withDescriptions?.Columns?[1].Description == "Who placed it." && withDescriptions.Columns[5].Description is { Length: BigQueryService.MaxColumnText } bounded && bounded.EndsWith('…')
            && withDescriptions.Columns[0].Description is null,
            "bigquery.properties carries column descriptions, bounded at 1,024 characters");
        // 1000 long columns with long descriptions pass the response's character budget: the list is cut there, and says so.
        var wide = new Table
        {
            Schema = new TableSchema { Fields = [.. Enumerable.Range(0, BigQueryService.MaxColumnFacts).Select(at => new TableFieldSchema { Name = "c" + at.ToString("D4", System.Globalization.CultureInfo.InvariantCulture) + new string('x', 290), Type = "STRING", Description = new string('d', 1024) })] }
        };
        var (wideColumns, wideCut) = BigQueryService.ColumnFacts(wide);
        check(wideColumns is { Count: > 0 and < BigQueryService.MaxColumnFacts } && wideCut == true
            && wideColumns.Sum(column => column.Name.Length + column.Type.Length + (column.Description?.Length ?? 0)) <= BigQueryService.MaxColumnChars,
            $"the column facts stop at their character budget and say they were cut ({wideColumns?.Count} kept)");
        harness.Fake.On("GET", Sales + "/tables/daily", BigQueryFake.Fixture("index-view-daily"));
        var view = (await harness.Call("bigquery.properties", Args("bqView", "daily"))).Result as BigQueryProperties;
        check(view is { Type: "view", Definition: { } query } && query.StartsWith("SELECT DATE(placed)", StringComparison.Ordinal) && view.Columns?.Count == 2,
            $"bigquery.properties answers a view's query text and columns: {view?.Type} {view?.Columns?.Count}");
        harness.Fake.On("GET", Sales + "/tables/daily_mv", new BigQueryFake.Reply(200,
            "{\"type\":\"MATERIALIZED_VIEW\",\"location\":\"US\",\"materializedView\":{\"query\":\"SELECT customer, COUNT(*) AS n FROM `varia-alpha.sales.orders` GROUP BY 1\"}}"));
        var (mvCode, mvResult, _) = await harness.Call("bigquery.properties", Args("bqMaterializedView", "daily_mv"));
        var mvProps = mvResult as BigQueryProperties;
        check(mvCode == "ok" && mvProps is { Type: "materialized view", Definition: "SELECT customer, COUNT(*) AS n FROM `varia-alpha.sales.orders` GROUP BY 1", DefinitionCut: null, DefinitionTruncated: null }
            && harness.Fake.To(Sales + "/tables/daily_mv").Count() == 1,
            $"bigquery.properties answers a materialized view's query text in one free tables.get: {mvCode}");
        harness.Fake.On("GET", Sales + "/tables/long", new BigQueryFake.Reply(200, new JsonObject
        {
            ["type"] = "VIEW", ["view"] = new JsonObject { ["query"] = "SELECT '" + new string('x', BigQueryService.MaxDefinition) + "'" }
        }.ToJsonString()));
        var longView = (await harness.Call("bigquery.properties", Args("bqView", "long"))).Result as BigQueryProperties;
        check(longView is { DefinitionCut: true, DefinitionTruncated: true, Definition.Length: BigQueryService.MaxDefinition, Columns: null },
            $"bigquery.properties cuts a view's text at 1,000,000 characters: {longView?.Definition?.Length} {longView?.DefinitionCut}");
        harness.Fake.On("GET", Sales + "/routines/to_cents", new BigQueryFake.Reply(200, """
            {"routineReference":{"projectId":"varia-alpha","datasetId":"sales","routineId":"to_cents"},"routineType":"SCALAR_FUNCTION","language":"SQL",
             "determinismLevel":"DETERMINISTIC","description":"Dollars to cents.","creationTime":"1700000000000","lastModifiedTime":"1700086400000","definitionBody":"CAST(x * 100 AS INT64)",
             "arguments":[{"name":"x","mode":"IN","dataType":{"typeKind":"NUMERIC"}}],"returnType":{"typeKind":"INT64"}}
            """));
        var (routineCode, routineResult, _) = await harness.Call("bigquery.properties", Args("bqRoutine", "to_cents"));
        var routine = routineResult as BigQueryProperties;
        var routineFacts = routine?.Groups.SelectMany(group => group.Facts.Select(fact => group.Title + "/" + fact.Label + "=" + fact.Value)).ToArray() ?? [];
        check(routineCode == "ok" && routine is { Name: "to_cents", Type: "function", Definition: "CAST(x * 100 AS INT64)", Columns: null }
            && routine.Routine is { RoutineType: "SCALAR_FUNCTION", Language: "SQL", Determinism: "DETERMINISTIC", ReturnType: "INT64", Arguments: [{ Name: "x", Type: "NUMERIC", Mode: "IN" }] }
            && routineFacts.Contains("Routine/Full name=varia-alpha.sales.to_cents") && routineFacts.Contains("Routine/Language=SQL")
            && routineFacts.Contains("Routine/Signature=(x NUMERIC) RETURNS INT64") && routineFacts.Contains("Routine/Description=Dollars to cents.")
            && routine.Groups.Select(group => group.Title).SequenceEqual(["Routine", "History"]) && harness.Fake.To(Sales + "/routines/to_cents").Count() == 1,
            $"bigquery.properties answers a routine's structured metadata, facts and body from one routines.get: {routineCode} {string.Join(" | ", routineFacts)}");

        harness.Fake.On("GET", Sales + "$", new BigQueryFake.Reply(200, """
            {"datasetReference":{"projectId":"varia-alpha","datasetId":"sales"},"location":"US","friendlyName":"Sales Data",
             "description":"Commerce tables.","defaultTableExpirationMs":"7776000000","defaultPartitionExpirationMs":"2592000000",
             "defaultEncryptionConfiguration":{"kmsKeyName":"projects/varia-alpha/locations/us/keyRings/bq/cryptoKeys/k1"},
             "creationTime":"1700000000000","lastModifiedTime":"1700086400000","labels":{"team":"sales","env":"prod"}}
            """));
        var (datasetCode, datasetResult, _) = await harness.Call("bigquery.properties", Args("bqDataset", "sales"));
        var datasetProps = datasetResult as BigQueryProperties;
        var (mismatchedDataset, _, _) = await harness.Call("bigquery.properties", Args("bqDataset", "other"));
        var badDatasetArgs = Args("bqDataset", "sa`les");
        badDatasetArgs["dataset"] = "sa`les";
        var (hostileDataset, _, _) = await harness.Call("bigquery.properties", badDatasetArgs);
        check(datasetCode == "ok" && datasetProps is { Name: "sales", Type: "dataset", FullName: "varia-alpha.sales", Location: "US", Description: "Commerce tables." }
            && datasetProps.Dataset is { FriendlyName: "Sales Data", DefaultTableExpirationMs: 7_776_000_000, DefaultPartitionExpirationMs: 2_592_000_000, KmsKeyName: "projects/varia-alpha/locations/us/keyRings/bq/cryptoKeys/k1" }
            && datasetProps.Labels is [BigQueryLabel { Key: "env", Value: "prod" }, BigQueryLabel { Key: "team", Value: "sales" }]
            && mismatchedDataset == "INVALID_PARAMS" && hostileDataset == "INVALID_PARAMS",
            $"bigquery.properties answers a dataset's metadata from one free datasets.get and validates dataset names: {datasetCode} {mismatchedDataset} {hostileDataset}");
        harness.Fake.On("GET", Sales + "/tables/orders", BigQueryFake.Fixture("error-not-found", 404));
        var (gone, _, _) = await harness.Call("bigquery.properties", Args("bqTable", "orders"));
        check(code == "ok" && properties is { Name: "orders", Type: "table" } && properties.Groups.Count == 4 && model == "INVALID_PARAMS" && badRoutine == "INVALID_PARAMS" && gone == "NOT_FOUND",
            $"bigquery.properties answers tables.get's facts for table-like kinds and routines.get's for routines, and NOT_FOUND for a vanished table: {code} {model} {badRoutine} {gone}");
        check(harness.Fake.Seen.Skip(connected).All(request => !request.Uri.AbsolutePath.EndsWith("/queries", StringComparison.Ordinal) && !request.Uri.AbsolutePath.EndsWith("/jobs", StringComparison.Ordinal)),
            "bigquery.properties runs no query or job: every fact is free metadata");
    }
}
