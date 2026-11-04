using Varia.Backend.Explorer;

namespace Varia.Backend.Search;

/// <summary>
/// The object index's constant SQL: one listing of the databases to index and one server batch, read on the server's connection,
/// and one batch per database, run in it through <c>QUOTENAME(@db).sys.sp_executesql</c> (or directly on a connection already in
/// it, on Azure SQL Database). Catalog views only, joined for names; no metadata built-ins (they ignore the isolation level and
/// lock timeout), no values in the text. SQL Server's metadata visibility leaves out what the login may not see, and
/// sys.sql_modules shows a NULL definition where it may not VIEW DEFINITION, so the index holds only what Object Explorer and
/// Script As could show. Every kind Object Explorer lists is indexed, but the SSIS Catalog's (read from SSISDB on its own pool).
/// </summary>
internal static class ObjectSearchSql
{
    /// <summary>Browsing's own prologue: READ UNCOMMITTED, LOCK_TIMEOUT 5000, DEADLOCK_PRIORITY LOW.</summary>
    public const string Prologue = CatalogSql.Prologue;

    /// <summary>Online databases the login may open, but tempdb and snapshots (which repeat their source), by name.</summary>
    public const string Databases = "SELECT d.name FROM sys.databases AS d WHERE d.state = 0 AND d.database_id <> 2 AND d.source_database_id IS NULL"
        + " AND HAS_DBACCESS(d.name) = 1 ORDER BY d.name;";

    /// <summary>Runs @stmt in @db, whose name reaches T-SQL only through QUOTENAME.</summary>
    public const string ModuleCall = "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\nEXEC @module @stmt;";

    /// <summary>The sys.objects types the index lists, as Object Explorer's folders do: tables (and external tables), views,
    /// procedures (T-SQL, CLR, extended and replication-filter), functions, synonyms, sequences, rules, stand-alone defaults and
    /// security policies, and the children kept with their table or view: DML triggers, keys and constraints.</summary>
    internal const string ObjectTypes = "'U', 'ET', 'V', 'P', 'PC', 'X', 'RF', 'FN', 'FS', 'IF', 'TF', 'FT', 'AF', 'SN', 'SO', 'TR', 'R', 'D', 'SP', 'C', 'F', 'PK', 'UQ', 'EC'";

    /// <summary>The resource database's object types: its sys and INFORMATION_SCHEMA views, procedures and functions.</summary>
    internal const string ResourceTypes = "'U', 'V', 'P', 'PC', 'X', 'RF', 'FN', 'FS', 'IF', 'TF', 'FT', 'AF'";

    /// <summary>
    /// The server's own objects, in this order: every database (all states, snapshots and tempdb too, as the Databases folders
    /// list them), then, on box editions and Managed Instance (whose Security and Server Objects folders Object Explorer serves),
    /// the logins and server roles, the other named server objects by a two-letter code, the server DDL triggers, and with
    /// <paramref name="definitions"/> their definitions.
    /// </summary>
    public static string Server(bool box, bool definitions) =>
        "SELECT d.name, d.create_date, CONVERT(bit, CASE WHEN d.database_id <= 4 OR d.is_distributor = 1 THEN 1 ELSE 0 END),"
        + " CONVERT(bit, CASE WHEN d.source_database_id IS NULL THEN 0 ELSE 1 END) FROM sys.databases AS d ORDER BY d.name;\n"
        + (box
            ? "SELECT p.principal_id, p.name, p.type, p.modify_date, p.is_fixed_role FROM sys.server_principals AS p"
                + " WHERE p.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X', 'R') ORDER BY p.principal_id;\n"
                + "SELECT 'CR', c.name, c.modify_date FROM sys.credentials AS c"
                + " UNION ALL SELECT 'CP', cp.name, CONVERT(datetime, NULL) FROM sys.cryptographic_providers AS cp"
                + " UNION ALL SELECT 'AU', a.name, a.modify_date FROM sys.server_audits AS a"
                + " UNION ALL SELECT 'SA', sa.name, sa.modify_date FROM sys.server_audit_specifications AS sa"
                + " UNION ALL SELECT 'BD', b.name, CONVERT(datetime, NULL) FROM sys.backup_devices AS b"
                + " UNION ALL SELECT 'LS', s.name, s.modify_date FROM sys.servers AS s WHERE s.server_id > 0 AND s.is_linked = 1;\n"
                + "SELECT t.object_id, t.name, t.modify_date, t.is_ms_shipped FROM sys.server_triggers AS t ORDER BY t.object_id;\n"
                + (definitions ? "SELECT m.object_id, m.definition FROM sys.server_sql_modules AS m WHERE m.definition IS NOT NULL ORDER BY m.object_id;\n" : "")
            : "");

    /// <summary>
    /// One database's batch, in its order:
    /// <list type="number">
    /// <item>the objects of <see cref="ObjectTypes"/>, each with its parent's id (a child's table or view), whether it is a system
    /// one (Microsoft-shipped, or a database diagrams support object, as Object Explorer's System folders decide), and for a table
    /// or view the folder variant it is listed in (FileTables, External Tables, Graph Tables, Dropped Ledger, or under its
    /// temporal or ledger table, whose id comes last);</item>
    /// <item>the user-defined types, with a table type's own object id, which its columns, keys and indexes name;</item>
    /// <item>the other named database objects (principals, schemas, assemblies, keys, certificates, storage and external
    /// resources, XML schema collections) by a two-letter code;</item>
    /// <item>the database DDL triggers; the plan guides (with their query text);</item>
    /// <item>with <paramref name="children"/>, the columns Object Explorer shows (with a computed column's expression), indexes,
    /// statistics and parameters, each by its object's id;</item>
    /// <item>with <paramref name="definitions"/>, the module, check and default constraint definitions by object id.</item>
    /// </list>
    /// Every object of the database's own catalog is listed, Microsoft-shipped ones too (master's spt_ tables, msdb's procedures).
    /// The resource database's sys and INFORMATION_SCHEMA objects, the same in every database, are not in sys.objects: the
    /// <see cref="ResourceObjects"/> read lists them once per server build. Text columns come last in their rows and
    /// definitions in id order, so a reader with sequential access reads each one only as far as the index keeps it.
    /// </summary>
    public static string Batch(SqlRender r, bool definitions, bool children = true) =>
        "SELECT o.object_id, s.name, o.name, o.type, o.modify_date, o.parent_object_id,"
        + " CONVERT(bit, CASE WHEN o.is_ms_shipped = 1 OR ep.major_id IS NOT NULL THEN 1 ELSE 0 END),"
        + " CONVERT(tinyint, CASE WHEN " + r.Col(16, "t.ledger_type", "CONVERT(tinyint, 0)") + " = 1 AND " + r.Col(16, "t.is_dropped_ledger_table", "CONVERT(bit, 0)") + " = 1 THEN 8"
        + " WHEN " + r.Col(16, "t.ledger_type", "CONVERT(tinyint, 0)") + " = 1 THEN 7 WHEN " + r.Col(13, "t.temporal_type", "CONVERT(tinyint, 0)") + " = 1 THEN 6"
        + " WHEN t.is_filetable = 1 THEN 1 WHEN " + r.Col(13, "t.is_external", "CONVERT(bit, 0)") + " = 1 THEN 2"
        + " WHEN " + r.Col(14, "t.is_node", "CONVERT(bit, 0)") + " = 1 THEN 3 WHEN " + r.Col(14, "t.is_edge", "CONVERT(bit, 0)") + " = 1 THEN 4"
        + " WHEN " + r.Col(16, "t.is_dropped_ledger_table", "CONVERT(bit, 0)") + " = 1 OR " + r.Col(16, "v.is_dropped_ledger_view", "CONVERT(bit, 0)") + " = 1 THEN 5 ELSE 0 END),"
        + " " + r.Col(13, "cur.object_id", "CONVERT(int, NULL)")
        + " FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id"
        + " LEFT JOIN sys.tables AS t ON t.object_id = o.object_id LEFT JOIN sys.views AS v ON v.object_id = o.object_id"
        + (r.Band >= 13 ? " LEFT JOIN sys.tables AS cur ON cur.history_table_id = o.object_id" : "")
        + " LEFT JOIN sys.extended_properties AS ep ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'microsoft_database_tools_support'"
        + " WHERE o.type IN (" + ObjectTypes + ") ORDER BY o.object_id;\n"
        + "SELECT t.user_type_id, s.name, t.name, t.is_table_type, t.is_assembly_type, tt.type_table_object_id FROM sys.types AS t JOIN sys.schemas AS s ON s.schema_id = t.schema_id"
        + " LEFT JOIN sys.table_types AS tt ON tt.user_type_id = t.user_type_id WHERE t.is_user_defined = 1 ORDER BY t.user_type_id;\n"
        + "SELECT 'US', CONVERT(sysname, NULL), dp.name, dp.modify_date, CONVERT(bit, CASE WHEN dp.principal_id BETWEEN 2 AND 4 THEN 1 ELSE 0 END) FROM sys.database_principals AS dp"
        + " WHERE dp.type IN ('S', 'U', 'G', 'E', 'X', 'C', 'K')"
        + " UNION ALL SELECT 'RL', NULL, dp.name, dp.modify_date, CONVERT(bit, CASE WHEN dp.is_fixed_role = 1 OR dp.principal_id = 0 THEN 1 ELSE 0 END) FROM sys.database_principals AS dp WHERE dp.type = 'R'"
        + " UNION ALL SELECT 'AR', NULL, dp.name, dp.modify_date, CONVERT(bit, 0) FROM sys.database_principals AS dp WHERE dp.type = 'A'"
        + " UNION ALL SELECT 'SC', NULL, sc.name, NULL, CONVERT(bit, CASE WHEN sc.schema_id BETWEEN 2 AND 4 OR sc.schema_id >= 16384 THEN 1 ELSE 0 END) FROM sys.schemas AS sc"
        + " UNION ALL SELECT 'AS', NULL, a.name, a.modify_date, CONVERT(bit, CASE WHEN a.is_user_defined = 1 THEN 0 ELSE 1 END) FROM sys.assemblies AS a"
        + " UNION ALL SELECT 'AK', NULL, k.name, NULL, CONVERT(bit, 0) FROM sys.asymmetric_keys AS k"
        + " UNION ALL SELECT 'CE', NULL, c.name, NULL, CONVERT(bit, 0) FROM sys.certificates AS c"
        + " UNION ALL SELECT 'SK', NULL, k.name, k.modify_date, CONVERT(bit, CASE WHEN k.symmetric_key_id = 101 THEN 1 ELSE 0 END) FROM sys.symmetric_keys AS k"
        + (r.Band >= 13
            ? " UNION ALL SELECT 'CM', NULL, k.name, k.modify_date, CONVERT(bit, 0) FROM sys.column_master_keys AS k"
                + " UNION ALL SELECT 'CK', NULL, k.name, k.modify_date, CONVERT(bit, 0) FROM sys.column_encryption_keys AS k"
                + " UNION ALL SELECT 'DS', NULL, e.name, NULL, CONVERT(bit, 0) FROM sys.external_data_sources AS e"
                + " UNION ALL SELECT 'FF', NULL, f.name, NULL, CONVERT(bit, 0) FROM sys.external_file_formats AS f"
            : "")
        + " UNION ALL SELECT 'DA', NULL, a.name, a.modify_date, CONVERT(bit, 0) FROM sys.database_audit_specifications AS a"
        + " UNION ALL SELECT 'FC', NULL, c.name, NULL, CONVERT(bit, 0) FROM sys.fulltext_catalogs AS c"
        + " UNION ALL SELECT 'FL', NULL, sl.name, sl.modify_date, CONVERT(bit, 0) FROM sys.fulltext_stoplists AS sl"
        + " UNION ALL SELECT 'PS', NULL, ps.name, NULL, CONVERT(bit, 0) FROM sys.partition_schemes AS ps"
        + " UNION ALL SELECT 'PF', NULL, pf.name, pf.modify_date, CONVERT(bit, 0) FROM sys.partition_functions AS pf"
        + " UNION ALL SELECT 'PL', NULL, sp.name, sp.modify_date, CONVERT(bit, 0) FROM sys.registered_search_property_lists AS sp"
        + " UNION ALL SELECT 'XS', xs.name, x.name, x.modify_date, CONVERT(bit, 0) FROM sys.xml_schema_collections AS x JOIN sys.schemas AS xs ON xs.schema_id = x.schema_id"
        + " WHERE x.xml_collection_id > 1;\n"
        + "SELECT tr.object_id, tr.name, tr.modify_date, tr.is_ms_shipped FROM sys.triggers AS tr WHERE tr.parent_class = 0 ORDER BY tr.object_id;\n"
        + "SELECT g.name, g.modify_date" + (definitions ? ", g.query_text" : "") + " FROM sys.plan_guides AS g ORDER BY g.plan_guide_id;\n"
        + (children
            ? "SELECT c.object_id, c.name" + (definitions ? ", cc.definition" : "") + " FROM sys.columns AS c"
                + (definitions ? " LEFT JOIN sys.computed_columns AS cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id" : "")
                + " WHERE " + ExplorerQueries.ColumnVisibility(r) + " ORDER BY c.object_id, c.column_id;\n"
                + "SELECT i.object_id, i.name, i.type FROM sys.indexes AS i WHERE i.type > 0 AND i.is_hypothetical = 0 AND i.name IS NOT NULL ORDER BY i.object_id, i.index_id;\n"
                + "SELECT st.object_id, st.name FROM sys.stats AS st ORDER BY st.object_id, st.stats_id;\n"
                + "SELECT p.object_id, p.name, p.is_output FROM sys.parameters AS p WHERE p.parameter_id > 0 ORDER BY p.object_id, p.parameter_id;\n"
            : "")
        + (definitions
            ? "SELECT m.object_id, m.definition FROM sys.sql_modules AS m WHERE m.definition IS NOT NULL"
                + " UNION ALL SELECT cc.object_id, cc.definition FROM sys.check_constraints AS cc WHERE cc.definition IS NOT NULL"
                + " UNION ALL SELECT dc.object_id, dc.definition FROM sys.default_constraints AS dc WHERE dc.definition IS NOT NULL ORDER BY object_id;\n"
            : "");

    /// <summary>What identifies the resource database's objects as the login sees them (negative ids, in every database): how many,
    /// the latest change, and a checksum of their ids, names, types, schemas and dates. With the server's version and edition it
    /// keys the shared set (<see cref="ResourceCatalog"/>), so a server whose set differs never reuses another's, even where its
    /// version string is the same (Azure SQL Database keeps one across deployments).</summary>
    public const string ResourceFingerprint = "SELECT COUNT_BIG(*), MAX(o.modify_date), CHECKSUM_AGG(BINARY_CHECKSUM(o.object_id, o.name, o.type, o.schema_id, o.modify_date))"
        + " FROM sys.all_objects AS o WHERE o.object_id < 0;";

    /// <summary>The resource database's objects of the indexed types, their columns and parameters, then (with
    /// <paramref name="definitions"/>) their definitions, each in id order. Every one is a system object.</summary>
    public static string ResourceObjects(bool definitions) =>
        "SELECT o.object_id, s.name, o.name, o.type, o.modify_date FROM sys.all_objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id"
        + " WHERE o.object_id < 0 AND o.type IN (" + ResourceTypes + ") ORDER BY o.object_id;\n"
        + "SELECT c.object_id, c.name FROM sys.all_columns AS c WHERE c.object_id < 0 ORDER BY c.object_id, c.column_id;\n"
        + "SELECT p.object_id, p.name, p.is_output FROM sys.all_parameters AS p WHERE p.object_id < 0 AND p.parameter_id > 0 ORDER BY p.object_id, p.parameter_id;\n"
        + (definitions ? "SELECT m.object_id, m.definition FROM sys.all_sql_modules AS m WHERE m.object_id < 0 AND m.definition IS NOT NULL ORDER BY m.object_id;\n" : "");

    /// <summary>Problems with every statement the index runs; empty when they pass. Each passes Object Explorer's own lint
    /// (<see cref="CatalogSql.Lint"/>): the database listing may call HAS_DBACCESS, the batches may not.</summary>
    public static List<string> Lint()
    {
        var problems = new List<string>();
        var texts = new List<string> { Databases, ResourceFingerprint, ModuleCall, ResourceObjects(true), Server(true, true) };
        for (var band = ExplorerCatalog.MinBand; band <= ExplorerCatalog.MaxBand; band++)
        {
            var render = new SqlRender(band);
            problems.AddRange(CatalogSql.Lint(Databases, render, list: false, mayCheckAccess: true).Select(problem => "databases " + problem));
            foreach (var definitions in new[] { false, true })
            {
                foreach (var children in new[] { false, true })
                {
                    texts.Add(Batch(render, definitions, children));
                    problems.AddRange(CatalogSql.Lint(Batch(render, definitions, children), render, list: false, mayCheckAccess: false).Select(problem => "batch " + band + " " + problem));
                }
                problems.AddRange(CatalogSql.Lint(ResourceObjects(definitions), render, list: false, mayCheckAccess: false).Select(problem => "resource " + problem));
                foreach (var box in new[] { false, true })
                    problems.AddRange(CatalogSql.Lint(Server(box, definitions), render, list: false, mayCheckAccess: false).Select(problem => "server " + problem));
            }
            problems.AddRange(CatalogSql.Lint(ResourceFingerprint, render, list: false, mayCheckAccess: false).Select(problem => "fingerprint " + problem));
        }
        foreach (var text in texts)
        {
            if (text.Contains("OBJECT_DEFINITION", StringComparison.OrdinalIgnoreCase)) problems.Add("reads OBJECT_DEFINITION");
            foreach (var write in new[] { "INSERT ", "UPDATE ", "DELETE ", "MERGE ", "CREATE ", "ALTER ", "DROP ", "EXEC (", "EXECUTE (", "#" })
                if (text.Contains(write, StringComparison.OrdinalIgnoreCase)) problems.Add("contains " + write.Trim());
        }
        if (Batch(new SqlRender(ExplorerCatalog.MaxBand), true).Contains("@db", StringComparison.Ordinal)) problems.Add("the batch names @db");
        return problems;
    }
}
