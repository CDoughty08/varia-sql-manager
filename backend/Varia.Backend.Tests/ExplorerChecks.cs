using System.Diagnostics;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Offline Object Explorer checks: the embedded catalogue, every rendered statement against the lint, label
/// goldens, the module-header parser, error classification, cursors, ref validation, filters, and the service's
/// static path, gates and cancellation with a fake host.</summary>
internal static class ExplorerChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
    };

    public static async Task RunAsync(Action<bool, string> check)
    {
        Catalog(check);
        Sql(check);
        Labels(check);
        Header(check);
        Errors(check);
        Cursors(check);
        Refs(check);
        Filters(check);
        await SweepAsync(check);
        await ServiceAsync(check);
    }

    /// <summary>The stale-scratch sweep against a fake server: what it drops, and what it leaves.</summary>
    private static async Task SweepAsync(Action<bool, string> check)
    {
        const string prefix = "VariaScratch_20200101000000_";
        // name, state (0 = ONLINE), older than 6 h, HAS_DBACCESS; the marker each online database reports (null: the query fails).
        var databases = new (string Name, string State, string Stale, string Access, string? Marker)[]
        {
            (prefix + "0000000a", "0", "1", "0", "1"), (prefix + "0000000b", "0", "1", "1", "1"), (prefix + "0000000c", "0", "1", "1", "0"),
            (prefix + "0000000d", "0", "1", "1", null), (prefix + "0000000e_off", "6", "1", "0", null), (prefix + "0000000f", "0", "0", "1", "1"),
            ("VariaScratch_other", "6", "1", "0", null)
        };
        var markers = new List<string>();
        var dropped = new List<string>();
        Task<SqlRun> Run(string sql, string database)
        {
            static SqlRun Rows(params string?[][] rows) => new("completed", null, [[.. rows]]);
            if (sql.StartsWith("SELECT d.name", StringComparison.Ordinal)) return Task.FromResult(Rows([.. databases.Select(item => new string?[] { item.Name, item.State, item.Stale, item.Access })]));
            if (sql.Contains("varia.scratch", StringComparison.Ordinal))
            {
                var item = databases.Single(item => sql.Contains("N'" + item.Name + "'", StringComparison.Ordinal));
                markers.Add(item.Name);
                return Task.FromResult(item.Marker is null ? new SqlRun("failed", "The server principal is not able to access the database.", []) : Rows([item.Marker]));
            }
            if (sql.Contains("DROP DATABASE", StringComparison.Ordinal)) dropped.Add(databases.Single(item => sql.Contains("DROP DATABASE [" + item.Name + "]", StringComparison.Ordinal)).Name);
            return Task.FromResult(Rows());
        }
        await ScratchDatabase.SweepAsync(Run, _ => { });
        check(dropped.SequenceEqual([prefix + "0000000b", prefix + "0000000e_off"]) && markers.SequenceEqual([prefix + "0000000b", prefix + "0000000c", prefix + "0000000d"]),
            "the stale-scratch sweep drops only marked online databases and offline ones; an online one whose marker cannot be read is left alone: dropped "
            + string.Join(", ", dropped) + "; marker read for " + string.Join(", ", markers));
    }

    private static void Catalog(Action<bool, string> check)
    {
        var catalog = ExplorerCatalog.Current;
        check(catalog.FolderIds.Count == 72 && catalog.Kinds.Count() == 51 && catalog.CloudEditions.SetEquals([5, 6, 9, 11, 12]), "the embedded Object Explorer catalogue loads");
        var lists = catalog.FolderIds.Select(id => catalog.Folder(id)!.List).OfType<string>().ToHashSet();
        var queries = ExplorerQueries.All.Keys.Append("historyTable").ToHashSet();
        check(queries.SetEquals(catalog.Queries) && lists.All(ExplorerQueries.All.ContainsKey) && ExplorerQueries.All.Keys.All(lists.Contains),
            "every catalogue query is implemented and every implemented query is listed by a folder");
        check(catalog.Kinds.Any(kind => kind.HistoryLookup.Count > 0), "the history row's query is referenced through historyLookup");
        foreach (var cloud in new[] { false, true })
            for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
            {
                var profile = new ExplorerProfile(band, cloud);
                var served = catalog.FolderIds.Where(id => catalog.Served(id, profile)).ToList();
                check(served.All(id => catalog.Folder(id)!.Parent is not { } parent || served.Contains(parent)), "a served folder's parent is served (band " + band + (cloud ? ", cloud)" : ")"));
            }
        string Names(IEnumerable<string> ids) => string.Join(",", ids);
        check(catalog.Profile(12, 5, 16) == new ExplorerProfile(16, true) && catalog.Profile(12, 5) == new ExplorerProfile(12, true) && catalog.Profile(15, 9, 14) == new ExplorerProfile(15, true)
            && catalog.Profile(12, 3) == new ExplorerProfile(12, false) && catalog.Profile(16, 3, 13) == new ExplorerProfile(16, false) && catalog.Profile(17, 3, 16) == new ExplorerProfile(17, false)
            && catalog.Profile(12, 8, 16) == new ExplorerProfile(16, false) && catalog.Profile(16, 8, 16) == new ExplorerProfile(16, false)
            && new ServerProfile(12, "12.0.2000.8", 5, "sa", false, false, true, 16).Explorer(catalog) == new ExplorerProfile(16, true),
            "a server's band is its version's, raised to that of the catalog columns it has (Azure SQL Database and Managed Instance report 12)");
        var box12 = new ExplorerProfile(12, false);
        check(Names(catalog.StaticFolders("server", null, box12)) == "databases,serverSecurity,serverObjects"
            && Names(catalog.StaticFolders("server", null, new ExplorerProfile(16, true))) == "databases", "the server's folders; cloud editions browse only Databases");
        check(Names(catalog.Subfolders("tables", box12)) == "systemTables,fileTables" && Names(catalog.Subfolders("tables", new ExplorerProfile(14, false))) == "systemTables,fileTables,externalTables,graphTables"
            && Names(catalog.Subfolders("tables", new ExplorerProfile(16, false))) == "systemTables,fileTables,externalTables,graphTables,droppedLedgerTables",
            "Tables' subfolders follow the version band");
        check(!catalog.StaticFolders("database", null, box12).Contains("externalResources") && catalog.StaticFolders("database", null, new ExplorerProfile(13, false)).Contains("externalResources"),
            "External Resources appears from SQL Server 2016");
        check(Names(catalog.StaticFolders("table", "history", box12)) == "columns,indexes,statistics" && Names(catalog.StaticFolders("function", "inline", box12)) == "columns,parameters"
            && Names(catalog.StaticFolders("function", "scalar", box12)) == "parameters" && catalog.HasChildren("table", "systemVersioned", new ExplorerProfile(13, false)),
            "object folder sets follow the subtype");
        check(catalog.FolderOwnerKinds("columns").SequenceEqual(["table", "view", "function", "tableType"]) && catalog.FolderOwnerKinds("logins").SequenceEqual(["server"]),
            "folder owners come from the kinds' folder sets");
    }

    private static void Sql(Action<bool, string> check)
    {
        var catalog = ExplorerCatalog.Current;
        var folders = catalog.FolderIds.Select(id => catalog.Folder(id)!).Where(folder => folder.List is not null).ToList();
        var renders = 0;
        var problems = new List<string>();
        foreach (var folder in folders)
        {
            var query = ExplorerQueries.All[folder.List!];
            string?[] parents = query.ChildFolder ? [.. catalog.FolderOwnerKinds(folder.Id)] : [null];
            var shapes = new List<FilterShape> { default };
            foreach (var property in folder.Filter)
                foreach (var op in property == "created" ? new[] { "equals", "lessThan", "lessOrEqual", "greaterThan", "greaterOrEqual", "between", "notBetween" } : ["contains", "equals", "notContains"])
                    shapes.Add(property switch { "name" => new(Name: op), "schema" => new(Schema: op), "owner" => new(Owner: op), _ => new(Created: op) });
            if (folder.Filter.Count > 1) shapes.Add(new(folder.Filter.Contains("name") ? "contains" : null, folder.Filter.Contains("schema") ? "equals" : null,
                folder.Filter.Contains("owner") ? "notContains" : null, folder.Filter.Contains("created") ? "between" : null));
            for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
            {
                if ((folder.Since ?? 0) > band) continue;
                foreach (var vector in new[] { false, true })
                    foreach (var parent in parents)
                        foreach (var shape in shapes)
                        {
                            var render = new SqlRender(band, vector, shape, parent);
                            string text;
                            try { text = query.Render(render); }
                            catch (Exception error) { problems.Add(folder.Id + " band " + band + ": " + error.Message); continue; }
                            renders++;
                            problems.AddRange(CatalogSql.Lint(text, render, list: true, query.ChecksAccess).Select(problem => folder.Id + " band " + band + " " + parent + " " + shape + ": " + problem));
                        }
            }
        }
        for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
        {
            problems.AddRange(CatalogSql.Lint(ExplorerQueries.HistoryTable(new SqlRender(band)), new SqlRender(band), list: false, mayCheckAccess: false).Select(problem => "historyTable " + band + ": " + problem));
            renders++;
        }
        problems.AddRange(CatalogSql.Lint(ExplorerQueries.DatabaseState, new SqlRender(17), list: false, mayCheckAccess: true));
        check(renders > 5000 && problems.Count == 0, "every query renders for bands 12-17, both probe flags, every filter shape and parent kind, and passes the lint ("
            + renders + " renders" + (problems.Count > 0 ? "; first problem: " + problems[0] : ")"));
        // The wrapper names @db only through QUOTENAME, and the prologue fixes the isolation level and lock timeout.
        var wrapper = CatalogSql.Prologue + CatalogSql.ModuleCall;
        check(wrapper.Contains("QUOTENAME(@db) + N'.sys.sp_executesql'") && wrapper.Split("@db").Length == 2 && CatalogSql.Lint(wrapper.Replace("@db", "@x"), new SqlRender(12), false, false).Count == 0
            && CatalogSql.Prologue.Contains("READ UNCOMMITTED") && CatalogSql.Prologue.Contains("LOCK_TIMEOUT 5000") && CatalogSql.Prologue.Contains("DEADLOCK_PRIORITY LOW"),
            "the scope wrapper passes the database name only through QUOTENAME");
        // The lint itself catches what it exists for.
        var lint = CatalogSql.Lint("SELECT OBJECT_NAME(o.object_id), t.temporal_type, 'x' FROM sys.objects AS o WHERE HAS_DBACCESS(o.name) = 1", new SqlRender(12), true, false);
        check(lint.Count == 5, "the SQL lint rejects metadata built-ins, gated columns below their band, literals, access checks and unpaged lists: " + string.Join("; ", lint));
        var columns = ExplorerQueries.All["columns"].Render(new SqlRender(12, false, default, "table"));
        check(!columns.Contains("is_hidden") && !columns.Contains("graph_type") && columns.Contains("CONVERT(bit, 0) = 1 AND CONVERT(int, NULL) IS NOT NULL"),
            "gated columns keep their predicates with the fallback substituted");
        check(!ExplorerQueries.All["constraints"].Render(new SqlRender(14, ParentKind: "table")).Contains("sys.edge_constraints")
            && ExplorerQueries.All["constraints"].Render(new SqlRender(15, ParentKind: "table")).Contains("sys.edge_constraints"), "the edge-constraint arm appears from SQL Server 2019");
    }

    private static void Labels(Action<bool, string> check)
    {
        var types = new (SqlTypeInfo Type, string Text)[]
        {
            (new("int", 4, 10, 0), "int"), (new("bigint", 8, 19, 0), "bigint"), (new("smallint", 2, 5, 0), "smallint"), (new("tinyint", 1, 3, 0), "tinyint"), (new("bit", 1, 1, 0), "bit"),
            (new("money", 8, 19, 4), "money"), (new("smallmoney", 4, 10, 4), "smallmoney"), (new("real", 4, 24, 0), "real"), (new("float", 8, 53, 0), "float"),
            (new("datetime", 8, 23, 3), "datetime"), (new("smalldatetime", 4, 16, 0), "smalldatetime"), (new("date", 3, 10, 0), "date"), (new("uniqueidentifier", 16), "uniqueidentifier"),
            (new("text", 16), "text"), (new("ntext", 16), "ntext"), (new("image", 16), "image"), (new("sql_variant", 8016), "sql_variant"), (new("timestamp", 8), "timestamp"),
            (new("sysname", 256), "sysname"), (new("xml", -1), "xml"), (new("hierarchyid", 892, IsAssembly: true), "hierarchyid"), (new("geography", -1, IsAssembly: true), "geography"),
            (new("geometry", -1, IsAssembly: true), "geometry"), (new("char", 10), "char(10)"), (new("varchar", 50), "varchar(50)"), (new("varchar", -1), "varchar(max)"),
            (new("nchar", 20), "nchar(10)"), (new("nvarchar", 100), "nvarchar(50)"), (new("nvarchar", 256), "nvarchar(128)"), (new("nvarchar", -1), "nvarchar(max)"),
            (new("binary", 16), "binary(16)"), (new("varbinary", -1), "varbinary(max)"), (new("decimal", 5, 8, 2), "decimal(8,2)"), (new("numeric", 9, 18, 0), "numeric(18,0)"),
            (new("datetime2", 8, 27, 7), "datetime2(7)"), (new("datetime2", 7, 23, 3), "datetime2(3)"), (new("time", 4, 12, 3), "time(3)"), (new("time", 3, 8, 0), "time(0)"),
            (new("datetimeoffset", 10, 34, 7), "datetimeoffset(7)"), (new("Name", 100, IsUserDefined: true, BaseName: "nvarchar"), "Name(nvarchar(50))"),
            (new("Amount", 9, 10, 2, IsUserDefined: true, BaseName: "decimal"), "Amount(decimal(10,2))"), (new("xml", -1, XmlDocument: true, XmlSchema: "dbo", XmlCollection: "Coll"), "XML(DOCUMENT dbo.Coll)"),
            (new("xml", -1, XmlSchema: "dbo", XmlCollection: "Coll"), "XML(CONTENT dbo.Coll)"), (new("Point", 20, IsUserDefined: true, IsAssembly: true), "Point"),
            (new("OrderLines", -1, IsUserDefined: true, IsTableType: true, TypeSchema: "Sales"), "Sales.OrderLines"), (new("vector", 20, VectorDimensions: 3), "vector(3)"),
            (new("vector", 20), "vector"), (new("json", -1), "json")
        };
        var wrong = types.Where(item => ExplorerLabels.TypeText(item.Type) != item.Text).Select(item => item.Text + " != " + ExplorerLabels.TypeText(item.Type)).ToList();
        check(types.Length >= 40 && wrong.Count == 0, "SSMS type text for " + types.Length + " column types: " + string.Join("; ", wrong));
        check(ExplorerLabels.ColumnSublabel(true, false, false, "int", false) == "(PK, int, not null)" && ExplorerLabels.ColumnSublabel(false, true, false, "int", true) == "(FK, int, null)"
            && ExplorerLabels.ColumnSublabel(true, true, false, "int", false) == "(PK, FK, int, not null)" && ExplorerLabels.ColumnSublabel(false, false, true, "money", true) == "(Computed, money, null)"
            && ExplorerLabels.ColumnSublabel(false, false, false, "Name(nvarchar(50))", false) == "(Name(nvarchar(50)), not null)", "column sublabels join PK, FK, Computed, the type and nullability");
        check(ExplorerLabels.IndexSublabel(1, true, false, null) == "(Clustered)" && ExplorerLabels.IndexSublabel(2, true, false, null) == "(Unique, Non-Clustered)"
            && ExplorerLabels.IndexSublabel(2, false, false, null) == "(Non-Unique, Non-Clustered)" && ExplorerLabels.IndexSublabel(3, false, true, null) == "(Primary XML)"
            && ExplorerLabels.IndexSublabel(3, false, false, null) == "(Secondary XML)" && ExplorerLabels.IndexSublabel(4, false, false, null) == "(Spatial)"
            && ExplorerLabels.IndexSublabel(5, false, false, null) == "(Clustered Columnstore)" && ExplorerLabels.IndexSublabel(6, false, false, null) == "(Non-Clustered Columnstore)"
            && ExplorerLabels.IndexSublabel(7, false, false, null) == "(Non-Clustered Hash)" && ExplorerLabels.IndexSublabel(9, false, false, "JSON") == "(Json)"
            && ExplorerLabels.IndexSublabel(8, false, false, "VECTOR_INDEX") == "(Vector Index)" && ExplorerLabels.IndexSubtype(5) == "clusteredColumnstore" && ExplorerLabels.IndexSubtype(9) == "other",
            "index sublabels for types 1-7, XML primary and secondary, and unknown types");
        var states = Enumerable.Range(0, 11).Where(state => state is not (8 or 9)).Select(state => ExplorerLabels.Database(state, 0, false, false, true)).ToList();
        check(string.Join("|", states.Select(item => item.Sublabel)) == "|(Restoring...)|(In Recovery)|(Recovery Pending)|(Suspect)|(Emergency)|(Offline)|(Copying)|(Offline)"
            && states[0] == (null, null, true) && states[5].HasChildren && states[5].Status is null && states.Where((_, index) => index is not (0 or 5)).All(item => item.Status == "unavailable" && !item.HasChildren),
            "database states: their text, unavailable status, and which expand");
        check(ExplorerLabels.Database(0, 0, true, false, true) == ("(Read-Only)", "readOnly", true) && ExplorerLabels.Database(0, 1, true, true, true) == ("(Standby / Read-Only, Single User)", "readOnly", true)
            && ExplorerLabels.Database(6, 2, true, false, true) == ("(Offline, Read-Only, Restricted User)", "unavailable", false) && ExplorerLabels.Database(0, 0, false, false, false) == (null, "noAccess", true)
            && ExplorerLabels.Database(6, 0, false, false, false) == ("(Offline)", "unavailable", false),
            "database sublabels combine state, read-only and user access in one pair of parentheses; no access is its own status and still expands, to explain why");
        check(ExplorerLabels.ParameterSublabel("int", false, false, false) == "(int, Input, No default)" && ExplorerLabels.ParameterSublabel("int", true, false, true) == "(int, Input/Output, Default)"
            && ExplorerLabels.ParameterSublabel("Sales.OrderLines", false, true, false) == "(Sales.OrderLines, Input, ReadOnly, No default)" && ExplorerLabels.ParameterSublabel("int", false, false, null) == "(int, Input)",
            "parameter sublabels: direction, ReadOnly, and the default token");
        check(ExplorerLabels.ReturnLabel("P", null) == "Returns integer" && ExplorerLabels.ReturnLabel("FN", "decimal(10,2)") == "Returns decimal(10,2)" && ExplorerLabels.ReturnLabel("IF", null) == "Returns Table"
            && ExplorerLabels.ReturnLabel("TF", null) == "Returns Table", "return rows of procedures, scalar and table-valued functions");
        check(ExplorerLabels.TableSublabel(2, 0, false) == "(System-Versioned)" && ExplorerLabels.TableSublabel(0, 2, false) == "(Updatable Ledger)" && ExplorerLabels.TableSublabel(0, 3, false) == "(Append-Only Ledger)"
            && ExplorerLabels.TableSublabel(0, 3, true) is null && ExplorerLabels.TableSublabel(1, 0, false) is null, "table sublabels for temporal and ledger tables; dropped ledger tables have none");
        check(ExplorerLabels.TableSubtype(2, 0, false, false, false, false, false, false) == "systemVersioned" && ExplorerLabels.TableSubtype(1, 0, false, false, false, false, false, false) == "history"
            && ExplorerLabels.TableSubtype(0, 2, false, false, false, false, false, false) == "updatableLedger" && ExplorerLabels.TableSubtype(0, 1, false, false, false, false, false, false) == "ledgerHistory"
            && ExplorerLabels.TableSubtype(0, 3, false, false, false, false, true, false) == "droppedLedger" && ExplorerLabels.TableSubtype(0, 0, true, false, false, false, false, false) == "graphNode"
            && ExplorerLabels.TableSubtype(0, 0, false, true, false, false, false, false) == "graphEdge" && ExplorerLabels.TableSubtype(0, 0, false, false, true, false, false, false) == "fileTable"
            && ExplorerLabels.TableSubtype(0, 0, false, false, false, true, false, false) == "external" && ExplorerLabels.TableSubtype(0, 0, false, false, false, false, false, true) == "system"
            && ExplorerLabels.TableSubtype(0, 0, false, false, false, false, false, false) is null, "table subtypes from the catalog flags");
        check(ExplorerLabels.Clip(new string('x', 400), ExplorerLabels.MaxLabel).Length == 300 && ExplorerLabels.Created(new DateTime(2026, 10, 9, 8, 7, 6)) == "2026-10-09T08:07:06",
            "labels are clipped to their limits and creation dates use one format");
    }

    private static void Header(Action<bool, string> check)
    {
        string Show(IReadOnlySet<string>? set) => set is null ? "null" : string.Join(",", set.Order(StringComparer.Ordinal));
        var cases = new (string? Definition, string Expected)[]
        {
            ("CREATE PROCEDURE dbo.p @a int = 1, @b nvarchar(10), @c int OUTPUT AS SELECT 1", "@a"),
            ("/* @x int = 1 */ CREATE PROC p -- @y = 2\n @a varchar(10) = 'x = 1, @z = 3', @b int AS SELECT 1", "@a"),
            ("/* a /* nested @n = 1 */ still */ CREATE PROC p @a int = 1 AS", "@a"),
            ("CREATE PROCEDURE [dbo].[my ]] proc] @a int = NULL, @b int AS", "@a"),
            ("CREATE PROCEDURE \"dbo\".\"p\" @a int, @b int AS", ""),
            ("CREATE PROC p @c CURSOR VARYING OUTPUT, @t dbo.TT READONLY, @o int = 5 OUT AS", "@o"),
            ("CREATE OR ALTER PROCEDURE p @a int = -1, @b money = $1.50, @c float = 1.5e-3 AS", "@a,@b,@c"),
            ("CREATE PROCEDURE p;2 @a int = 1 AS", "@a"),
            ("ALTER PROC p @a int=1 WITH RECOMPILE AS", "@a"),
            ("CREATE FUNCTION dbo.f (@a int = 1, @b decimal(10, 2)) RETURNS int AS BEGIN RETURN 1 END", "@a"),
            ("CREATE FUNCTION dbo.f() RETURNS TABLE AS RETURN SELECT 1 AS x", ""),
            ("CREATE PROC p @x xml(CONTENT dbo.c) = NULL, @n nvarchar(max) = N'it''s' AS", "@n,@x"),
            ("CREATE PROCEDURE p @a int NOT NULL = 1 WITH NATIVE_COMPILATION, SCHEMABINDING AS BEGIN ATOMIC WITH (TRANSACTION ISOLATION LEVEL = SNAPSHOT, LANGUAGE = N'English') END", "@a"),
            ("create procedure p @A int = 0x1F for replication as", "@A"),
            ("SELECT 1", "null"), (null, "null"), ("CREATE PROC p /* unterminated", "null"), ("CREATE PROC p @a int = AS", "null"), ("CREATE VIEW v AS SELECT 1", "null")
        };
        var wrong = cases.Where(item => Show(ModuleHeader.ParameterDefaults(item.Definition)) != item.Expected)
            .Select(item => (item.Definition ?? "null") + " => " + Show(ModuleHeader.ParameterDefaults(item.Definition))).ToList();
        check(wrong.Count == 0, "module headers: defaults found past strings, comments, quoted names, OUTPUT, READONLY, VARYING, CREATE OR ALTER and ;n; surprises give null: " + string.Join(" | ", wrong));
        var many = "CREATE PROC p " + string.Join(", ", Enumerable.Range(0, 2101).Select(i => "@p" + i + " int")) + " AS";
        check(ModuleHeader.ParameterDefaults(many) is null, "more than 2,100 parameters is a surprise");
    }

    private static void Errors(Action<bool, string> check)
    {
        var expected = new (int Number, byte Class, ErrorPhase Phase, string Code)[]
        {
            (229, 14, ErrorPhase.Statement, "PERMISSION_DENIED"), (230, 14, ErrorPhase.Statement, "PERMISSION_DENIED"), (262, 14, ErrorPhase.Statement, "PERMISSION_DENIED"),
            (297, 16, ErrorPhase.Statement, "PERMISSION_DENIED"), (300, 14, ErrorPhase.Statement, "PERMISSION_DENIED"), (916, 14, ErrorPhase.Scope, "NO_DB_ACCESS"),
            (4060, 11, ErrorPhase.Statement, "NO_DB_ACCESS"), (922, 14, ErrorPhase.Scope, "DATABASE_UNAVAILABLE"), (924, 14, ErrorPhase.Scope, "DATABASE_UNAVAILABLE"),
            (926, 14, ErrorPhase.Scope, "DATABASE_UNAVAILABLE"), (927, 14, ErrorPhase.Scope, "DATABASE_UNAVAILABLE"), (942, 14, ErrorPhase.Scope, "DATABASE_UNAVAILABLE"),
            (945, 14, ErrorPhase.Scope, "DATABASE_UNAVAILABLE"), (952, 16, ErrorPhase.Scope, "DATABASE_UNAVAILABLE"), (976, 14, ErrorPhase.Scope, "DATABASE_UNAVAILABLE"),
            (978, 14, ErrorPhase.Scope, "DATABASE_UNAVAILABLE"), (911, 16, ErrorPhase.Scope, "NOT_FOUND"), (2812, 16, ErrorPhase.Scope, "NOT_FOUND"), (2812, 16, ErrorPhase.Statement, "SQL_ERROR"),
            (1222, 16, ErrorPhase.Statement, "BLOCKED"), (1205, 13, ErrorPhase.Statement, "BLOCKED"), (-2, 11, ErrorPhase.Statement, "TIMEOUT"), (-1, 20, ErrorPhase.Statement, "CONNECTION_LOST"),
            (2, 20, ErrorPhase.Statement, "CONNECTION_LOST"), (53, 20, ErrorPhase.Statement, "CONNECTION_LOST"), (64, 20, ErrorPhase.Statement, "CONNECTION_LOST"),
            (121, 20, ErrorPhase.Statement, "CONNECTION_LOST"), (233, 20, ErrorPhase.Statement, "CONNECTION_LOST"), (10053, 20, ErrorPhase.Statement, "CONNECTION_LOST"),
            (10054, 20, ErrorPhase.Statement, "CONNECTION_LOST"), (10060, 20, ErrorPhase.Statement, "CONNECTION_LOST"), (596, 21, ErrorPhase.Statement, "CONNECTION_LOST"),
            (208, 16, ErrorPhase.Statement, "SQL_ERROR")
        };
        var wrong = expected.Where(item => ExplorerErrors.Classify(item.Number, item.Class, item.Phase) != item.Code).Select(item => item.Number + " " + item.Phase).ToList();
        check(wrong.Count == 0, "SQL error numbers map to Object Explorer codes by phase: " + string.Join(", ", wrong));
        var notFound = ExplorerErrors.Create("NOT_FOUND", "dbo.Orders", "Sales");
        var sql = ExplorerErrors.Create("SQL_ERROR", "Tables", "Sales", 50000, new string('x', 600));
        var unavailable = ExplorerErrors.Create("DATABASE_UNAVAILABLE", "Tables", "Sales", 942, "Database 'Sales' cannot be opened because it is offline.");
        check(notFound is { Retryable: false, Action: "refreshParent", Message: "dbo.Orders no longer exists." } && sql.Message.StartsWith("Msg 50000: xxx") && sql.Message.Length == 512 && sql.Retryable
            && unavailable.Message == "Database Sales is not available (Database 'Sales' cannot be opened because it is offline.)." && !ExplorerErrors.Create("NO_DB_ACCESS", "Tables", "Sales").Retryable,
            "error values carry a bounded message, retryability and the refresh-parent action");
    }

    private static void Cursors(Action<bool, string> check)
    {
        var names = new[] { "a", "]", "x\u0001y", "emoji 🐟", new string('n', 128), "lone \ud800 surrogate", "Ünïcødé表", "50%_off" };
        var roundTrips = names.All(name => ExplorerCursor.Parse(ExplorerCursor.Encode("tables", new(name, names[^1], null)), "tables", Keyset.SchemaName) == new CursorKey(name, names[^1], null)
            && ExplorerCursor.Parse(ExplorerCursor.Encode("logins", new(name, null, null)), "logins", Keyset.Name) == new CursorKey(name, null, null));
        var longest = ExplorerCursor.Encode("tableValuedFunctions", new(new string('￿', 128), new string('￿', 128), null));
        check(roundTrips && ExplorerCursor.Parse(ExplorerCursor.Encode("columns", new(null, null, 0)), "columns", Keyset.Ordinal) == new CursorKey(null, null, 0)
            && ExplorerCursor.Parse(ExplorerCursor.Encode("columns", new(null, null, int.MaxValue)), "columns", Keyset.Ordinal).Kn == int.MaxValue && longest.Length < 720,
            "cursors round-trip any sysname exactly, and the longest stays under 720 characters");
        bool Rejected(string cursor, string query, Keyset keyset)
        {
            try { ExplorerCursor.Parse(cursor, query, keyset); return false; }
            catch (RequestException error) { return error.Code == "INVALID_PARAMS"; }
        }
        var valid = ExplorerCursor.Encode("tables", new("dbo", "Orders", null));
        var payload = valid["v1.tables.".Length..];
        string Raw(params byte[] bytes) => "v1.columns." + Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        check(Rejected(valid, "views", Keyset.SchemaName) && Rejected(valid, "tables", Keyset.Name) && Rejected("v2.tables." + payload, "tables", Keyset.SchemaName)
            && Rejected("v1.tables." + payload[..^2] + "+/", "tables", Keyset.SchemaName) && Rejected("v1.tables." + new string('A', 1601), "tables", Keyset.SchemaName)
            && Rejected("v1.tables.", "tables", Keyset.SchemaName) && Rejected("v1.tables." + payload + "AAAA", "tables", Keyset.SchemaName)
            && Rejected(Raw(3, 0xff, 0xff, 0xff, 0xff), "columns", Keyset.Ordinal) && Rejected(Raw(3, 1, 0, 0), "columns", Keyset.Ordinal)
            && Rejected(Raw(1, 129), "columns", Keyset.Name) && Rejected(Raw(1, 0), "columns", Keyset.Name) && Rejected(Raw(1, 2, 65, 0), "columns", Keyset.Name),
            "tampered, oversized, wrong-query, wrong-shape, non-base64url and out-of-range cursors are rejected");
    }

    private static ExplorerChildrenArgs Args(NodeRefDto node, string? subtype = null, string? cursor = null, int? pageSize = null, ExplorerFilterDto? filter = null, string? requestId = null) =>
        new(Guid.NewGuid().ToString(), requestId ?? Guid.NewGuid().ToString(), node, subtype, cursor, pageSize, filter);
    private static NodeRefDto Object(ObjectRefDto value) => new("object", value);
    private static NodeRefDto Folder(ObjectRefDto owner, string folder) => new("folder", Owner: owner, Folder: folder);

    private static void Refs(Action<bool, string> check)
    {
        var catalog = ExplorerCatalog.Current;
        bool Valid(ExplorerChildrenArgs args)
        {
            try { ExplorerRefs.Validate(args, catalog); return true; }
            catch (RequestException error) when (error.Code == "INVALID_PARAMS") { return false; }
        }
        var table = new ObjectRefDto("table", "Sales", "dbo", "Orders");
        var minimal = new[]
        {
            new ObjectRefDto("server"), new ObjectRefDto("login", Name: "sa"), new ObjectRefDto("database", Name: "Sales"), new ObjectRefDto("user", "Sales", Name: "dbo"), table,
            new ObjectRefDto("column", "Sales", Name: "Id", Parent: new ParentRefDto("table", "dbo", "Orders")), new ObjectRefDto("returnValue", "Sales", Parent: new ParentRefDto("procedure", "dbo", "p"))
        };
        check(minimal.All(item => Valid(Args(Object(item)))) && Valid(Args(Folder(table, "columns"))) && Valid(Args(Folder(new ObjectRefDto("database", Name: " "), "tables")))
            && Valid(Args(Folder(new ObjectRefDto("server"), "logins"), pageSize: 2000, filter: new(Name: new("contains", "x"), Created: new("between", "1753-01-01", "9999-12-31")))),
            "each scope's minimal ref is accepted, names are used verbatim (a space is a name)");
        var invalid = new (string Name, ExplorerChildrenArgs Args)[]
        {
            ("server with a name", Args(Object(new ObjectRefDto("server", Name: "x")))),
            ("database without a name", Args(Object(new ObjectRefDto("database")))),
            ("table without a schema", Args(Object(table with { Schema = null }))),
            ("table with a parent", Args(Object(table with { Parent = new("table", "dbo", "x") }))),
            ("column with a schema", Args(Object(new ObjectRefDto("column", "Sales", "dbo", "Id", new ParentRefDto("table", "dbo", "Orders"))))),
            ("column below a procedure", Args(Object(new ObjectRefDto("column", "Sales", Name: "Id", Parent: new ParentRefDto("procedure", "dbo", "p"))))),
            ("returnValue with a name", Args(Object(new ObjectRefDto("returnValue", "Sales", Name: "x", Parent: new ParentRefDto("procedure", "dbo", "p"))))),
            ("129 characters", Args(Object(table with { Name = new string('x', 129) }))),
            ("an empty name", Args(Object(table with { Name = "" }))),
            ("NUL", Args(Object(table with { Schema = "a\0b" }))),
            ("unknown kind", Args(Object(new ObjectRefDto("folder")))),
            ("unknown node type", Args(new NodeRefDto("other", table))),
            ("object and owner", Args(new NodeRefDto("object", table, table))),
            ("unknown folder", Args(Folder(table, "endpoints"))),
            ("folder below the wrong owner", Args(Folder(table, "logins"))),
            ("parameters below a table", Args(Folder(table, "parameters"))),
            ("subtype on a folder", Args(Folder(table, "columns"), subtype: "history")),
            ("subtype of another kind", Args(Object(table), subtype: "inline")),
            ("page size 0", Args(Folder(table, "columns"), pageSize: 0)),
            ("page size 2001", Args(Folder(table, "columns"), pageSize: 2001)),
            ("cursor of another folder", Args(Folder(table, "columns"), cursor: ExplorerCursor.Encode("keys", new("a", null, null)))),
            ("cursor on an object", Args(Object(table), cursor: ExplorerCursor.Encode("tables", new("a", "b", null)))),
            ("filter not allowed", Args(Folder(new ObjectRefDto("server"), "logins"), filter: new(Schema: new("equals", "dbo")))),
            ("filter on a static folder", Args(Folder(new ObjectRefDto("database", Name: "Sales"), "programmability"), filter: new(Name: new("equals", "x")))),
            ("empty filter", Args(Folder(new ObjectRefDto("server"), "logins"), filter: new())),
            ("unknown operator", Args(Folder(new ObjectRefDto("server"), "logins"), filter: new(Name: new("startsWith", "x")))),
            ("empty filter value", Args(Folder(new ObjectRefDto("server"), "logins"), filter: new(Name: new("equals", "")))),
            ("between without value2", Args(Folder(new ObjectRefDto("server"), "logins"), filter: new(Created: new("between", "2020-01-01")))),
            ("value2 on equals", Args(Folder(new ObjectRefDto("server"), "logins"), filter: new(Created: new("equals", "2020-01-01", "2020-01-02")))),
            ("value2 before value", Args(Folder(new ObjectRefDto("server"), "logins"), filter: new(Created: new("between", "2020-01-02", "2020-01-01")))),
            ("date before 1753", Args(Folder(new ObjectRefDto("server"), "logins"), filter: new(Created: new("equals", "1752-12-31")))),
            ("date format", Args(Folder(new ObjectRefDto("server"), "logins"), filter: new(Created: new("equals", "2020-1-1")))),
            ("impossible date", Args(Folder(new ObjectRefDto("server"), "logins"), filter: new(Created: new("equals", "2021-02-29")))),
            ("connection id", Args(Object(table)) with { ConnectionId = "x" }),
            ("request id", Args(Object(table)) with { RequestId = "x" })
        };
        var accepted = invalid.Where(item => Valid(item.Args)).Select(item => item.Name).ToList();
        check(accepted.Count == 0, "invalid refs, folders, subtypes, cursors, page sizes and filters are rejected: " + string.Join(", ", accepted));
        var request = ExplorerRefs.Validate(Args(Folder(new ObjectRefDto("database", Name: "Sales"), "graphTables")), catalog);
        bool Served(ExplorerProfile profile)
        {
            try { ExplorerRefs.CheckServed(request, catalog, profile); return true; }
            catch (RequestException) { return false; }
        }
        check(!Served(new(13, false)) && Served(new(14, false)) && Served(new(16, true)) && request.Database == "Sales", "folders are checked against the server's version band");
        var cloudSecurity = ExplorerRefs.Validate(Args(Folder(new ObjectRefDto("server"), "logins")), catalog);
        try { ExplorerRefs.CheckServed(cloudSecurity, catalog, new(16, true)); check(false, "a box-only folder is refused on a cloud edition"); }
        catch (RequestException error) { check(error.Code == "INVALID_PARAMS", "a box-only folder is refused on a cloud edition"); }
    }

    private static void Filters(Action<bool, string> check)
    {
        check(CatalogSql.EscapeLike("50%_off") == "50\\%\\_off" && CatalogSql.EscapeLike("[x]") == "\\[x]" && CatalogSql.EscapeLike("a\\b") == "a\\\\b" && CatalogSql.EscapeLike("plain") == "plain",
            "LIKE operands escape %, _, [ and the escape character");
        check(CatalogSql.Text("t.name", "contains", "@fname") == "t.name LIKE N'%' + @fname + N'%' ESCAPE N'\\'" && CatalogSql.Text("t.name", "notContains", "@fname") == "t.name NOT LIKE N'%' + @fname + N'%' ESCAPE N'\\'"
            && CatalogSql.Text("own.name", "equals", "@fowner") == "own.name = @fowner", "text filter fragments");
        var dateOps = new[] { "equals", "lessThan", "lessOrEqual", "greaterThan", "greaterOrEqual", "between", "notBetween" };
        check(string.Join(" | ", dateOps.Select(op => CatalogSql.Date("c", op))) == "CONVERT(date, c) = @d1 | CONVERT(date, c) < @d1 | CONVERT(date, c) <= @d1 | CONVERT(date, c) > @d1 | "
            + "CONVERT(date, c) >= @d1 | CONVERT(date, c) BETWEEN @d1 AND @d2 | CONVERT(date, c) NOT BETWEEN @d1 AND @d2" && dateOps.All(op => !CatalogSql.Date("c", op).Contains("DATEADD", StringComparison.Ordinal)),
            "date filter fragments compare the date part, so 9999-12-31 never overflows");
        var text = ExplorerQueries.All["tables"].Render(new SqlRender(16, false, new FilterShape("contains", "equals", "notContains", "between")));
        check(text.Contains(" AND (t.name LIKE N'%' + @fname + N'%' ESCAPE N'\\') AND (s.name = @fschema) AND (own.name NOT LIKE N'%' + @fowner + N'%' ESCAPE N'\\') AND (CONVERT(date, t.create_date) BETWEEN @d1 AND @d2)")
            && text.Contains("WHERE o.type = 'U' AND (@k1 IS NULL OR s.name > @k1 OR (s.name = @k1 AND o.name > @k2)) AND (o.name LIKE N'%' + @fname + N'%' ESCAPE N'\\') AND (s.name = @fschema) "
                + "AND (own.name NOT LIKE N'%' + @fowner + N'%' ESCAPE N'\\') AND (CONVERT(date, o.create_date) BETWEEN @d1 AND @d2) ORDER BY s.name, o.name)")
            && text.Split("LEFT JOIN sys.database_principals AS own").Length == 4, "filters combine with AND, and the count and Tables' candidate keys join the owner only when filtering by it");
        var tables = ExplorerQueries.All["tables"].Render(new SqlRender(16));
        var candidates = tables[tables.IndexOf("WITH k AS (", StringComparison.Ordinal)..tables.IndexOf(")\nSELECT k.k1", StringComparison.Ordinal)];
        check(candidates.StartsWith("WITH k AS (SELECT TOP (@take) s.name AS k1, o.name AS k2, o.object_id AS id, s.principal_id AS sp FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE o.type = 'U' ", StringComparison.Ordinal)
            && !candidates.Contains("sys.tables", StringComparison.Ordinal) && !candidates.Contains("own", StringComparison.Ordinal)
            && tables.Contains(", CONVERT(bit, CASE WHEN t.is_ms_shipped = 0 AND ep.major_id IS NULL AND t.is_filetable = 0 ", StringComparison.Ordinal)
            && tables.EndsWith(" THEN 1 ELSE 0 END) FROM k JOIN sys.tables AS t ON t.object_id = k.id LEFT JOIN sys.extended_properties AS ep ON ep.class = 1 AND ep.major_id = t.object_id AND ep.minor_id = 0 "
                + "AND ep.name = N'microsoft_database_tools_support' LEFT JOIN sys.database_principals AS own ON own.principal_id = COALESCE(t.principal_id, k.sp) ORDER BY k.k1, k.k2;", StringComparison.Ordinal)
            && ExplorerQueries.All.Values.Count(query => query.Candidates is not null) == 1,
            "Tables pages by candidate keys from sys.objects, then reads sys.tables and its predicate for those rows only");
        check(ExplorerRefs.Date("2024-02-29") == new DateTime(2024, 2, 29) && ExplorerRefs.Date("1753-01-01") is not null && ExplorerRefs.Date("9999-12-31") is not null && ExplorerRefs.Date("2023-02-29") is null,
            "filter dates parse within datetime's range");
        var node = new ExplorerNode(new NodeRefDto("object", new ObjectRefDto("column", new string('d', 128), Name: new string('c', 128), Parent: new ParentRefDto("table", new string('s', 128), new string('t', 128)))),
            new string('c', 128), "symbol-field", false, "(nvarchar(128), not null)");
        check(ExplorerService.Estimate(node) * 2000 > new ExplorerOptions().SizeCut, "a page of 2,000 rows with 128-character names passes the size cut, so it is split");
    }

    /// <summary>A host whose connections never reach a server; <see cref="Hold"/> blocks connection requests until released.</summary>
    private sealed class FakeHost(int major = 16, int edition = 3, int catalogBand = ExplorerCatalog.MinBand) : IExplorerHost
    {
        public SemaphoreSlim? Hold { get; set; }
        public int Connections;
        public ServerProfile Profile(string connectionId) => new(major, major + ".0.1.1", edition, "sa", false, true, false, catalogBand);
        public SqlConnection Connection(string connectionId, string? database)
        {
            Interlocked.Increment(ref Connections);
            Hold?.Wait();
            return new SqlConnection("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false");
        }
    }

    private static async Task ServiceAsync(Action<bool, string> check)
    {
        using (var sql = new SqlService())
        {
            async Task<string> Code(string body)
            {
                try { await sql.DispatchAsync("explorer.children", JsonDocument.Parse(body).RootElement, Json); return "ok"; }
                catch (RequestException error) { return error.Code; }
                catch (JsonException) { return "JSON"; }
            }
            var ids = "\"connectionId\":\"" + Guid.NewGuid() + "\",\"requestId\":\"" + Guid.NewGuid() + "\"";
            var codes = new[]
            {
                await Code("{" + ids + ",\"node\":{\"type\":\"object\",\"object\":{\"kind\":\"table\"}}}"),
                await Code("{" + ids + ",\"node\":{\"type\":\"folder\",\"owner\":{\"kind\":\"server\"},\"folder\":\"logins\"},\"cursor\":\"v1.logins.AQ\"}"),
                await Code("{" + ids + ",\"node\":{\"type\":\"object\",\"object\":{\"kind\":\"server\"}}}"),
                await Code("{" + ids + ",\"node\":{\"type\":\"object\",\"object\":{\"kind\":\"server\",\"extra\":1}}}")
            };
            check(sql.LaneOf("explorer.children") == RequestLane.Explorer && sql.Methods.Contains("explorer.children") && codes.SequenceEqual(["INVALID_PARAMS", "INVALID_PARAMS", "NOT_CONNECTED", "JSON"]),
                "explorer.children runs on the explorer lane and checks refs and cursors before the connection: " + string.Join(", ", codes));
        }
        var host = new FakeHost();
        using var service = new ExplorerService(host);
        var server = new ObjectRefDto("server");
        var root = await service.ChildrenAsync(Args(Object(server)), CancellationToken.None);
        check(root.Nodes.Select(node => node.Label).SequenceEqual(["Databases", "Security", "Server Objects"]) && root.Total == 3 && root.Error is null && host.Connections == 0
            && root.Nodes.All(node => node is { Icon: "folder", HasChildren: true, Ref: { Type: "folder", Owner.Kind: "server" } }), "the server's folders come from the catalogue without SQL");
        var database = new ObjectRefDto("database", Name: "Sales");
        var programmability = await service.ChildrenAsync(Args(Folder(database, "programmability")), CancellationToken.None);
        check(programmability.Nodes.Select(node => node.Ref.Folder).SequenceEqual(["storedProcedures", "functions", "databaseTriggers", "assemblies", "types", "rules", "defaults", "planGuides", "sequences"])
            && programmability.Nodes.All(node => node.Ref.Owner == database) && host.Connections == 0, "static subfolders keep their owner and need no connection");
        var table = new ObjectRefDto("table", "Sales", "dbo", "Orders");
        var folders = await service.ChildrenAsync(Args(Object(table), subtype: "history"), CancellationToken.None);
        check(folders.Nodes.Select(node => node.Label).SequenceEqual(["Columns", "Indexes", "Statistics"]) && host.Connections == 0, "a history table's folder set");
        var watch = Stopwatch.StartNew();
        var many = await Task.WhenAll(Enumerable.Range(0, 64).Select(_ => service.ChildrenAsync(Args(Folder(database, "programmability")), CancellationToken.None)));
        check(many.All(page => page.Nodes.Count == 9) && watch.ElapsedMilliseconds < 2000 && host.Connections == 0, "64 concurrent static expansions take no slot (" + watch.ElapsedMilliseconds + " ms)");
        var json = JsonSerializer.Serialize(root, Json);
        check(json.Contains("\"ref\":{\"type\":\"folder\",\"owner\":{\"kind\":\"server\"},\"folder\":\"databases\"}") && !json.Contains("null"), "nodes serialize without null members");
        var cloud = new ExplorerService(new FakeHost(16, 5));
        check((await cloud.ChildrenAsync(Args(Object(server)), CancellationToken.None)).Nodes.Select(node => node.Label).SequenceEqual(["Databases"]), "cloud editions show only Databases");
        try { await cloud.ChildrenAsync(Args(Folder(server, "logins")), CancellationToken.None); check(false, "a box-only folder is refused on a cloud edition"); }
        catch (RequestException error) { check(error.Code == "INVALID_PARAMS", "the service checks folders against the server's profile"); }
        // Azure SQL Database reports version 12 but has every catalog column up to the ledger ones.
        var azure = new ExplorerService(new FakeHost(12, 5, 16));
        var azureTables = (await azure.ChildrenAsync(Args(Folder(database, "tables")), CancellationToken.None)).Nodes.Select(node => node.Ref.Folder).ToList();
        var azureDatabase = (await azure.ChildrenAsync(Args(Folder(database, "databaseSecurity")), CancellationToken.None)).Nodes.Select(node => node.Ref.Folder).ToList();
        check(azureTables.SequenceEqual(["systemTables", "fileTables", "externalTables", "graphTables", "droppedLedgerTables"]) && azureDatabase.Contains("alwaysEncryptedKeys")
            && azureDatabase.Contains("securityPolicies"), "a cloud edition reporting version 12 serves the folders its catalog columns allow: " + string.Join(",", azureTables));
        // Managed Instance (EngineEdition 8) reports version 12 too, and is browsed like SQL Server.
        var instance = new ExplorerService(new FakeHost(12, 8, 16));
        var instanceServer = (await instance.ChildrenAsync(Args(Object(server)), CancellationToken.None)).Nodes.Select(node => node.Ref.Folder).ToList();
        var instanceTables = (await instance.ChildrenAsync(Args(Folder(database, "tables")), CancellationToken.None)).Nodes.Select(node => node.Ref.Folder).ToList();
        var instanceDatabase = ExplorerCatalog.Current.StaticFolders("database", null, new FakeHost(12, 8, 16).Profile("x").Explorer(ExplorerCatalog.Current));
        var instanceSecurity = (await instance.ChildrenAsync(Args(Folder(database, "databaseSecurity")), CancellationToken.None)).Nodes.Select(node => node.Ref.Folder).ToList();
        check(instanceServer.SequenceEqual(["databases", "serverSecurity", "serverObjects"]) && instanceTables.SequenceEqual(["systemTables", "fileTables", "externalTables", "graphTables", "droppedLedgerTables"])
            && instanceDatabase.Contains("externalResources") && instanceSecurity.Contains("alwaysEncryptedKeys") && instanceSecurity.Contains("securityPolicies"),
            "Managed Instance reporting version 12 serves the server folders and the folders its catalog columns allow: " + string.Join(",", instanceTables));

        // A request cancelled before it runs takes no slot and opens nothing.
        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel();
            var before = host.Connections;
            try { await service.ChildrenAsync(Args(Folder(server, "logins")), cancelled.Token); check(false, "a cancelled request runs"); }
            catch (OperationCanceledException) { check(host.Connections == before && service.RunningCount == 0, "a request cancelled before it runs takes no slot and is unregistered"); }
        }
        // A failed open is a value on the node, never an exception.
        var unreachable = await service.ChildrenAsync(Args(Folder(server, "logins")), CancellationToken.None);
        check(unreachable.Error is { Retryable: true } && unreachable.Nodes.Count == 0, "a connection failure becomes the node's error value: " + unreachable.Error?.Code);

        // Duplicates, the per-connection gate, and disconnect.
        var gated = new FakeHost { Hold = new SemaphoreSlim(0) };
        using var limited = new ExplorerService(gated, new ExplorerOptions { PerConnection = 1, MaxRegistered = 3 });
        var connection = Guid.NewGuid().ToString();
        var requestId = Guid.NewGuid().ToString();
        // The fake host blocks inside the gates on the caller's thread, so each held request starts on its own.
        var first = Task.Run(() => limited.ChildrenAsync(Args(Folder(server, "logins"), requestId: requestId) with { ConnectionId = connection }, CancellationToken.None));
        SpinWait.SpinUntil(() => gated.Connections == 1, 5000);
        try { await limited.ChildrenAsync(Args(Folder(server, "logins"), requestId: requestId) with { ConnectionId = connection }, CancellationToken.None); check(false, "a duplicate request runs"); }
        catch (RequestException error) { check(error.Code == "DUPLICATE_REQUEST", "a running requestId cannot be sent again"); }
        var waiting = Task.Run(() => limited.ChildrenAsync(Args(Folder(server, "credentials")) with { ConnectionId = connection }, CancellationToken.None));
        var other = Task.Run(() => limited.ChildrenAsync(Args(Folder(server, "audits")) with { ConnectionId = Guid.NewGuid().ToString() }, CancellationToken.None));
        SpinWait.SpinUntil(() => gated.Connections == 2 && limited.RunningCount == 3, 5000);
        check(gated.Connections == 2 && !waiting.IsCompleted, "the per-connection gate holds a connection's next statement, not another connection's");
        try { await limited.ChildrenAsync(Args(Folder(server, "logins")), CancellationToken.None); check(false, "more registered requests than allowed"); }
        catch (RequestException error) { check(error.Code == "BUSY", "registered requests are bounded"); }
        limited.Forget(connection);
        try { await waiting; check(false, "a forgotten connection's waiting request ran"); }
        catch (RequestException error) { check(error.Code == "CANCELLED", "disconnect cancels the connection's waiting requests"); }
        gated.Hold.Release(2);
        try { await first; check(false, "a forgotten connection's running request completed"); }
        catch (RequestException error) { check(error.Code == "CANCELLED", "disconnect cancels the connection's running requests"); }
        check((await other).Error is not null && limited.RunningCount == 0, "another connection's request is unaffected, and every request unregisters when it ends");
    }
}
