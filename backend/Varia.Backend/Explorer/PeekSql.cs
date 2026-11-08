using System.Globalization;
using System.Text;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Explorer;

/// <summary>explorer.peek's constant batches, one per peek kind, version band and (for an index or a trigger) parent kind.
/// Database-scoped kinds run in the object's database as every Object Explorer database statement does (through
/// <see cref="CatalogSql.ModuleCall"/>, or on a per-database pool); a database, a login and a server trigger run on the
/// server. Each batch finds the object (<see cref="Lookup"/>: one bit row, then nothing when it is gone), reads one row of the
/// kind's facts in catalogue order, aliased with their ids, then the helper columns <see cref="Extras"/> names (and a
/// module's text last), then the kind's lists in catalogue order (each TOP (@take) in a fixed order), and last the statement
/// of an optional group, which answers a refused row instead of failing the batch when the login may not read it. A login's
/// User mapping reads, in place of its list, the databases the login may enter; the service then reads each
/// (<see cref="MappingUsers"/>). The Dependencies tab's batch (<see cref="Dependencies"/>) is apart:
/// sys.sql_expression_dependencies needs more than VIEW DEFINITION (db_owner by default), so a login refused it still gets the
/// facts. Words SSMS shows for codes are made here, in C#, since the lint allows no string literals in the SQL.</summary>
internal static class PeekSql
{
    /// <summary>A rendered batch: its text, the facts row's columns, each list's columns (shown ones first, then helpers), the
    /// optional group's columns (empty when the kind or band has none), and whether it ends with User mapping's databases.</summary>
    internal sealed record Batch(string Text, IReadOnlyList<string> Columns, IReadOnlyList<ListBatch> Lists, IReadOnlyList<string> Optional, bool Mapping);
    internal sealed record ListBatch(string Id, IReadOnlyList<string> Columns);

    private const string Tools = "LEFT JOIN sys.extended_properties AS ep ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'microsoft_database_tools_support' ";
    private const string Owned = "FROM sys.all_objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id " + Tools;
    private const string Modules = "LEFT JOIN sys.all_sql_modules AS m ON m.object_id = o.object_id ";
    // CLR modules have their EXECUTE AS and NULL-input options in sys.assembly_modules; -1 stands for CALLER (NULL there), so
    // NULL is left for objects with neither row (extended procedures).
    private const string Assembly = "LEFT JOIN sys.assembly_modules AS am ON am.object_id = o.object_id "
        + "LEFT JOIN sys.database_principals AS dp ON dp.principal_id = COALESCE(m.execute_as_principal_id, am.execute_as_principal_id) ";
    private const string ExecuteAs = "CASE WHEN m.object_id IS NOT NULL THEN COALESCE(m.execute_as_principal_id, -1) WHEN am.object_id IS NOT NULL THEN COALESCE(am.execute_as_principal_id, -1) END";
    /// <summary>EXECUTE AS CALLER, as <see cref="ExecuteAs"/> returns it.</summary>
    internal const int Caller = -1;
    private const string ById = "WHERE o.object_id = @object_id";

    private static readonly Dictionary<string, string> Common = new(StringComparer.Ordinal)
    {
        ["schema"] = "s.name",
        ["created"] = "o.create_date",
        ["modified"] = "o.modify_date",
        // System objects as the tree's System folders take them: Microsoft-shipped, or marked as tools support.
        ["systemObject"] = "CONVERT(bit, CASE WHEN o.is_ms_shipped = 1 OR ep.major_id IS NOT NULL THEN 1 ELSE 0 END)",
        ["ansiNulls"] = "m.uses_ansi_nulls",
        ["quotedIdentifier"] = "m.uses_quoted_identifier",
        ["schemaBound"] = "m.is_schema_bound",
        ["nativelyCompiled"] = "m.uses_native_compilation",
        ["executeAs"] = ExecuteAs
    };

    /// <summary>A kind's SQL: its FROM and WHERE (finding the row by the lookup's variables), its own facts' expressions (over
    /// <see cref="Common"/>'s), and the helper columns its words need.</summary>
    private sealed record KindSql(string From, Dictionary<string, string> Facts, (string Column, string Expression)[] Helpers);

    private static Dictionary<string, string> Own(params (string Id, string Expression)[] facts) => facts.ToDictionary(item => item.Id, item => item.Expression, StringComparer.Ordinal);

    private static readonly (string, string)[] TriggerFacts =
    [
        ("disabled", "o.is_disabled"), ("clr", "CONVERT(bit, CASE WHEN o.type = 'TA' THEN 1 ELSE 0 END)")
    ];

    private static readonly Dictionary<string, KindSql> Kinds = new(StringComparer.Ordinal)
    {
        ["table"] = new(Owned + "LEFT JOIN sys.tables AS t ON t.object_id = o.object_id "
            + "LEFT JOIN sys.indexes AS i ON i.object_id = o.object_id AND i.index_id IN (0, 1) "
            + "LEFT JOIN sys.data_spaces AS ds ON ds.data_space_id = i.data_space_id "
            + "LEFT JOIN sys.data_spaces AS lob ON lob.data_space_id = t.lob_data_space_id "
            + "OUTER APPLY (SELECT SUM(p.rows) AS row_count, MIN(p.data_compression_desc) AS compression, COUNT(DISTINCT p.data_compression) AS compressions "
            + "FROM sys.partitions AS p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS pr "
            + "OUTER APPLY (SELECT SUM(CASE WHEN p.index_id IN (0, 1) THEN CASE WHEN au.type = 1 THEN au.data_pages ELSE au.used_pages END ELSE 0 END) AS data_pages, "
            + "SUM(au.used_pages) AS used_pages FROM sys.partitions AS p JOIN sys.allocation_units AS au ON (au.type IN (1, 3) AND au.container_id = p.hobt_id) OR (au.type = 2 AND au.container_id = p.partition_id) "
            + "WHERE p.object_id = o.object_id) AS sp " + ById, Own(
            ("replicated", "t.is_replicated"),
            ("lockEscalation", "t.lock_escalation_desc"),
            ("memoryOptimized", "t.is_memory_optimized"),
            ("temporal", "t.temporal_type_desc"),
            ("ledger", "t.ledger_type_desc"),
            ("rowCount", "pr.row_count"),
            // sp_spaceused's split: data is the heap's or clustered index's leaf (in-row data pages) plus its LOB and
            // row-overflow pages; index space is every other page the table's indexes use.
            ("dataSpace", "CONVERT(bigint, sp.data_pages) * 8"),
            ("indexSpace", "CONVERT(bigint, CASE WHEN sp.used_pages > sp.data_pages THEN sp.used_pages - sp.data_pages WHEN sp.used_pages IS NOT NULL THEN 0 END) * 8"),
            ("filegroup", "CASE WHEN ds.type = 'FG' THEN ds.name END"),
            ("textFilegroup", "lob.name"),
            ("partitioned", "CONVERT(bit, CASE WHEN ds.type = 'PS' THEN 1 ELSE 0 END)"),
            ("compression", "pr.compression")), [("compressions", "pr.compressions")]),
        ["view"] = new(Owned + Modules + ById, Own(
            ("indexed", "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.indexes AS i WHERE i.object_id = o.object_id AND i.index_id > 0) THEN 1 ELSE 0 END)")), []),
        ["procedure"] = new(Owned + Modules + Assembly + ById, Own(("recompile", "m.is_recompiled")), [("executeAsName", "dp.name")]),
        ["function"] = new(Owned + Modules + Assembly + ById, Own(
            ("functionType", "o.type_desc"),
            // An inline function cannot take EXECUTE AS.
            ("executeAs", "CASE WHEN o.type = 'IF' THEN NULL ELSE " + ExecuteAs + " END"),
            ("nullOnNullInput", "CASE WHEN m.object_id IS NOT NULL THEN m.null_on_null_input ELSE am.null_on_null_input END")), [("executeAsName", "dp.name")]),
        // The lookup leaves the parent in @object_id and the index in @index_id.
        ["index"] = new("FROM sys.indexes AS i LEFT JOIN sys.xml_indexes AS xi ON xi.object_id = i.object_id AND xi.index_id = i.index_id "
            + "LEFT JOIN sys.data_spaces AS ds ON ds.data_space_id = i.data_space_id LEFT JOIN sys.stats AS st ON st.object_id = i.object_id AND st.stats_id = i.index_id "
            + "OUTER APPLY (SELECT SUM(p.rows) AS row_count, COUNT(p.partition_id) AS partitions, MIN(p.data_compression_desc) AS compression, COUNT(DISTINCT p.data_compression) AS compressions "
            + "FROM sys.partitions AS p WHERE p.object_id = i.object_id AND p.index_id = i.index_id) AS pr "
            + "OUTER APPLY (SELECT SUM(au.used_pages) AS used_pages FROM sys.partitions AS p JOIN sys.allocation_units AS au "
            + "ON (au.type IN (1, 3) AND au.container_id = p.hobt_id) OR (au.type = 2 AND au.container_id = p.partition_id) WHERE p.object_id = i.object_id AND p.index_id = i.index_id) AS sp "
            + "WHERE i.object_id = @object_id AND i.index_id = @index_id", Own(
            ("indexType", "i.type"),
            ("unique", "i.is_unique"),
            ("primaryKey", "i.is_primary_key"),
            ("uniqueConstraint", "i.is_unique_constraint"),
            ("disabled", "i.is_disabled"),
            ("filter", "i.filter_definition"),
            ("fillFactor", "i.fill_factor"),
            ("padIndex", "i.is_padded"),
            ("ignoreDupKey", "i.ignore_dup_key"),
            ("allowRowLocks", "i.allow_row_locks"),
            ("allowPageLocks", "i.allow_page_locks"),
            ("noRecompute", "st.no_recompute"),
            ("optimizeForSequentialKey", "i.optimize_for_sequential_key"),
            ("rowCount", "pr.row_count"),
            ("space", "CONVERT(bigint, sp.used_pages) * 8"),
            ("filegroup", "CASE WHEN ds.type = 'FG' THEN ds.name END"),
            ("partitionScheme", "CASE WHEN ds.type = 'PS' THEN ds.name END"),
            ("partitions", "pr.partitions"),
            ("compression", "pr.compression")),
            [("primaryXml", "CONVERT(bit, CASE WHEN xi.object_id IS NOT NULL AND xi.using_xml_index_id IS NULL THEN 1 ELSE 0 END)"), ("compressions", "pr.compressions")]),
        ["trigger"] = new("FROM sys.triggers AS o " + Tools + Modules + Assembly + ById, Own([.. TriggerFacts, ("insteadOf", "o.is_instead_of_trigger"),
            ("notForReplication", "o.is_not_for_replication")]), [("executeAsName", "dp.name")]),
        ["databaseTrigger"] = new("FROM sys.triggers AS o " + Tools + Modules + Assembly + ById, Own(TriggerFacts), [("executeAsName", "dp.name")]),
        // A server trigger's module and EXECUTE AS principal are the server's; extended properties do not mark it.
        ["serverTrigger"] = new("FROM sys.server_triggers AS o LEFT JOIN sys.server_sql_modules AS m ON m.object_id = o.object_id "
            + "LEFT JOIN sys.server_assembly_modules AS am ON am.object_id = o.object_id "
            + "LEFT JOIN sys.server_principals AS dp ON dp.principal_id = COALESCE(m.execute_as_principal_id, am.execute_as_principal_id) " + ById,
            Own([.. TriggerFacts, ("systemObject", "o.is_ms_shipped")]), [("executeAsName", "dp.name")]),
        // sys.master_files on the server, so an offline or restoring database has its files too (where the login may see them).
        ["database"] = new("FROM sys.databases AS d LEFT JOIN sys.server_principals AS own ON own.sid = d.owner_sid "
            + "OUTER APPLY (SELECT SUM(CONVERT(bigint, mf.size)) AS pages, SUM(CASE WHEN mf.type = 1 THEN CONVERT(bigint, mf.size) ELSE 0 END) AS log_pages "
            + "FROM sys.master_files AS mf WHERE mf.database_id = d.database_id) AS f WHERE d.database_id = @object_id", Own(
            ("status", "d.state_desc"),
            ("owner", "own.name"),
            ("created", "d.create_date"),
            ("size", "f.pages * 8"),
            ("dataSize", "(f.pages - f.log_pages) * 8"),
            ("logSize", "f.log_pages * 8"),
            ("userAccess", "d.user_access_desc"),
            ("readOnly", "d.is_read_only"),
            ("recoveryModel", "d.recovery_model_desc"),
            ("compatibilityLevel", "d.compatibility_level"),
            ("collation", "d.collation_name"),
            ("containment", "d.containment_desc"),
            ("pageVerify", "d.page_verify_option_desc"),
            ("autoClose", "d.is_auto_close_on"),
            ("autoShrink", "d.is_auto_shrink_on"),
            ("autoCreateStats", "d.is_auto_create_stats_on"),
            ("autoUpdateStats", "d.is_auto_update_stats_on"),
            ("autoUpdateStatsAsync", "d.is_auto_update_stats_async_on"),
            ("snapshotIsolation", "d.snapshot_isolation_state_desc"),
            ("readCommittedSnapshot", "d.is_read_committed_snapshot_on"),
            ("encrypted", "d.is_encrypted"),
            ("queryStore", "d.is_query_store_on"),
            ("acceleratedRecovery", "d.is_accelerated_database_recovery_on"),
            ("ledger", "d.is_ledger_on")), []),
        // sys.sql_logins by named columns only (never *, which would read password_hash).
        ["login"] = new("FROM sys.server_principals AS p LEFT JOIN sys.sql_logins AS l ON l.principal_id = p.principal_id WHERE p.principal_id = @object_id", Own(
            ("loginType", "p.type"),
            ("created", "p.create_date"),
            ("modified", "p.modify_date"),
            ("defaultDatabase", "p.default_database_name"),
            ("defaultLanguage", "p.default_language_name"),
            ("disabled", "p.is_disabled"),
            ("connectDenied", "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.server_permissions AS sp WHERE sp.grantee_principal_id = p.principal_id AND sp.type = 'COSQ' AND sp.state = 'D') THEN 1 ELSE 0 END)"),
            ("enforcePolicy", "l.is_policy_checked"),
            ("enforceExpiration", "l.is_expiration_checked")), []),
        ["synonym"] = new(Owned + "JOIN sys.synonyms AS sy ON sy.object_id = o.object_id " + ById, Own(
            ("baseObject", "sy.base_object_name"),
            ("baseServer", "PARSENAME(sy.base_object_name, 4)"),
            ("baseDatabase", "PARSENAME(sy.base_object_name, 3)"),
            ("baseSchema", "PARSENAME(sy.base_object_name, 2)"),
            ("baseName", "PARSENAME(sy.base_object_name, 1)")), []),
        // Sequence values are sql_variant of the sequence's type (up to decimal(38, 0)), so they travel as text.
        ["sequence"] = new(Owned + "JOIN sys.sequences AS sq ON sq.object_id = o.object_id LEFT JOIN sys.types AS ty ON ty.user_type_id = sq.user_type_id " + ById, Own(
            ("dataType", "ty.name"),
            ("startValue", "CONVERT(nvarchar(64), sq.start_value)"),
            ("increment", "CONVERT(nvarchar(64), sq.increment)"),
            ("minimum", "CONVERT(nvarchar(64), sq.minimum_value)"),
            ("maximum", "CONVERT(nvarchar(64), sq.maximum_value)"),
            ("cycle", "sq.is_cycling"),
            ("cache", "sq.is_cached"),
            ("currentValue", "CONVERT(nvarchar(64), sq.current_value)"),
            ("lastUsedValue", "CONVERT(nvarchar(64), sq.last_used_value)"),
            ("exhausted", "sq.is_exhausted")), [("typePrecision", "sq.precision"), ("cacheSize", "sq.cache_size")]),
        // The lookup leaves the type's user_type_id in @object_id.
        ["type"] = new("FROM sys.types AS ty JOIN sys.schemas AS s ON s.schema_id = ty.schema_id "
            + "LEFT JOIN sys.types AS bt ON bt.user_type_id = ty.system_type_id AND ty.is_assembly_type = 0 "
            + "LEFT JOIN sys.assembly_types AS aty ON aty.user_type_id = ty.user_type_id LEFT JOIN sys.assemblies AS a ON a.assembly_id = aty.assembly_id "
            + "LEFT JOIN sys.all_objects AS dfo ON dfo.object_id = ty.default_object_id LEFT JOIN sys.schemas AS dfs ON dfs.schema_id = dfo.schema_id "
            + "LEFT JOIN sys.all_objects AS ro ON ro.object_id = ty.rule_object_id LEFT JOIN sys.schemas AS rs ON rs.schema_id = ro.schema_id "
            + "WHERE ty.user_type_id = @object_id", Own(
            ("allowNulls", "ty.is_nullable"),
            ("maxLength", "ty.max_length"),
            ("baseType", "bt.name"),
            ("collation", "ty.collation_name"),
            ("default", "dfo.name"),
            ("rule", "ro.name"),
            ("assembly", "a.name"),
            ("className", "aty.assembly_class"),
            ("binaryOrdered", "aty.is_binary_ordered"),
            ("fixedLength", "aty.is_fixed_length")),
            [("typePrecision", "ty.precision"), ("typeScale", "ty.scale"), ("defaultSchema", "dfs.name"), ("ruleSchema", "rs.name")]),
        // The lookup leaves the table type's user_type_id in @object_id; its dates are those of its table object.
        ["tableType"] = new("FROM sys.table_types AS tt JOIN sys.schemas AS s ON s.schema_id = tt.schema_id JOIN sys.all_objects AS o ON o.object_id = tt.type_table_object_id "
            + "WHERE tt.user_type_id = @object_id", Own(("memoryOptimized", "tt.is_memory_optimized")), [])
    };

    /// <summary>The lists' statements, each at most @take rows in a fixed order, with their column aliases: the list's shown
    /// columns in catalogue order, then the helpers their words need.</summary>
    private static readonly Dictionary<string, (Func<string, string> Text, string[] Columns)> Lists = new(StringComparer.Ordinal)
    {
        ["indexColumns"] = (_ => "SELECT TOP (@take) c.name AS [name], ic.is_included_column AS [included], ic.is_descending_key AS [descending], ty.name AS [type], "
            + "c.max_length AS [maxLength], c.precision AS [precision], c.scale AS [scale], ty.is_user_defined AS [userDefined] FROM sys.index_columns AS ic "
            + "JOIN sys.all_columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id "
            + "WHERE ic.object_id = @object_id AND ic.index_id = @index_id ORDER BY ic.is_included_column, CASE WHEN ic.key_ordinal = 0 THEN ic.index_column_id ELSE ic.key_ordinal END, ic.index_column_id;\n",
            ["name", "included", "descending", "type", "maxLength", "precision", "scale", "userDefined"]),
        ["events"] = (kind => "SELECT TOP (@take) te.type_desc AS [event], te.is_first AS [first], te.is_last AS [last] FROM "
            + (kind == "serverTrigger" ? "sys.server_trigger_events" : "sys.trigger_events") + " AS te WHERE te.object_id = @object_id ORDER BY te.type;\n", ["event", "first", "last"]),
        ["files"] = (_ => "SELECT TOP (@take) mf.name AS [name], mf.type_desc AS [type], CONVERT(bigint, mf.size) * 8 AS [size], mf.growth AS [growth], mf.physical_name AS [path], "
            + "mf.is_percent_growth AS [percentGrowth], mf.max_size AS [maxSize] FROM sys.master_files AS mf WHERE mf.database_id = @object_id ORDER BY mf.file_id;\n",
            ["name", "type", "size", "growth", "path", "percentGrowth", "maxSize"]),
        ["serverRoles"] = (_ => "SELECT TOP (@take) r.name AS [role], r.is_fixed_role AS [fixed] FROM sys.server_role_members AS rm "
            + "JOIN sys.server_principals AS r ON r.principal_id = rm.role_principal_id WHERE rm.member_principal_id = @object_id ORDER BY r.name;\n", ["role", "fixed"])
    };

    /// <summary>User mapping's databases, in place of its list: those online that the login may enter, in name order. Only
    /// the login's batch calls HAS_DBACCESS, as the database listings do.</summary>
    internal const string MappingDatabases = "SELECT TOP (@take) d.name FROM sys.databases AS d WHERE d.state = 0 AND HAS_DBACCESS(d.name) = 1 ORDER BY d.name;\n";

    /// <summary>The login's user in one database (run there through <see cref="CatalogSql.ModuleCall"/>): the database principal
    /// whose SID is the login's, found by its name in sys.server_principals, which every database sees.</summary>
    internal const string MappingUsers = "SELECT TOP (@take) dp.name AS [user], dp.default_schema_name AS [defaultSchema] FROM sys.database_principals AS dp "
        + "JOIN sys.server_principals AS sp ON sp.sid = dp.sid WHERE sp.name = @object_name AND sp.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X') "
        + "AND dp.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X') ORDER BY dp.name;\n";

    /// <summary>The optional groups' statements: an index's usage, which sys.dm_db_index_usage_stats keeps from the server's start
    /// and only a login with VIEW SERVER STATE may read. A refusal (229, 297 or 300) answers one refused column instead of
    /// failing the batch; any other error is raised again.</summary>
    private static readonly Dictionary<string, (string Text, string[] Columns)> Optional = new(StringComparer.Ordinal)
    {
        ["index"] = ("BEGIN TRY\nSELECT COALESCE(us.user_seeks, 0) AS [userSeeks], COALESCE(us.user_scans, 0) AS [userScans], COALESCE(us.user_lookups, 0) AS [userLookups], "
            + "COALESCE(us.user_updates, 0) AS [userUpdates], us.last_user_seek AS [lastSeek], us.last_user_scan AS [lastScan], us.last_user_lookup AS [lastLookup], "
            + "us.last_user_update AS [lastUpdate] FROM sys.indexes AS i LEFT JOIN sys.dm_db_index_usage_stats AS us ON us.database_id = DB_ID() AND us.object_id = i.object_id "
            + "AND us.index_id = i.index_id WHERE i.object_id = @object_id AND i.index_id = @index_id;\nEND TRY\nBEGIN CATCH\nIF ERROR_NUMBER() NOT IN (229, 297, 300) THROW;\n"
            + "SELECT CONVERT(bit, 1) AS [" + Refused + "];\nEND CATCH;\n",
            ["userSeeks", "userScans", "userLookups", "userUpdates", "lastSeek", "lastScan", "lastLookup", "lastUpdate"])
    };

    /// <summary>The one column an optional statement answers when the login was refused.</summary>
    internal const string Refused = "refused";

    /// <summary>The statement that finds the object and answers whether it did (one bit row; the batch ends when it did not): the
    /// object's id in @object_id (a type's or table type's user_type_id), and for an index its parent's in @object_id and its own
    /// in @index_id. An index or a trigger is found below its parent, by the name in @k1.</summary>
    public static string Lookup(string kind, string? parentKind = null) => kind switch
    {
        "table" or "view" or "procedure" or "function" or "synonym" or "sequence" => CatalogSql.ParentLookup(kind),
        "type" => "DECLARE @object_id int;\nSELECT @object_id = ty.user_type_id FROM sys.types AS ty JOIN sys.schemas AS ps ON ps.schema_id = ty.schema_id "
            + "WHERE ps.name = @object_schema AND ty.name = @object_name AND ty.is_user_defined = 1 AND ty.is_table_type = 0;\n" + CatalogSql.Found("@object_id"),
        "tableType" => "DECLARE @object_id int;\nSELECT @object_id = tt.user_type_id FROM sys.table_types AS tt JOIN sys.schemas AS ps ON ps.schema_id = tt.schema_id "
            + "WHERE ps.name = @object_schema AND tt.name = @object_name;\n" + CatalogSql.Found("@object_id"),
        "index" => CatalogSql.ParentSelect(Parent(kind, parentKind)) + "DECLARE @index_id int;\nSELECT @index_id = i.index_id FROM sys.indexes AS i "
            + "WHERE i.object_id = @object_id AND i.name = @k1 AND i.type > 0 AND i.is_hypothetical = 0;\n" + CatalogSql.Found("@index_id"),
        "trigger" => CatalogSql.ParentSelect(Parent(kind, parentKind)) + "DECLARE @trigger_id int;\nSELECT @trigger_id = tr.object_id FROM sys.triggers AS tr "
            + "WHERE tr.parent_class = 1 AND tr.parent_id = @object_id AND tr.name = @k1;\nSET @object_id = @trigger_id;\n" + CatalogSql.Found("@object_id"),
        "databaseTrigger" => "DECLARE @object_id int;\nSELECT @object_id = tr.object_id FROM sys.triggers AS tr WHERE tr.parent_class = 0 AND tr.name = @object_name;\n"
            + CatalogSql.Found("@object_id"),
        "serverTrigger" => "DECLARE @object_id int;\nSELECT @object_id = tr.object_id FROM sys.server_triggers AS tr WHERE tr.name = @object_name;\n" + CatalogSql.Found("@object_id"),
        "database" => "DECLARE @object_id int;\nSELECT @object_id = d.database_id FROM sys.databases AS d WHERE d.name = @object_name;\n" + CatalogSql.Found("@object_id"),
        "login" => "DECLARE @object_id int;\nSELECT @object_id = p.principal_id FROM sys.server_principals AS p WHERE p.name = @object_name "
            + "AND p.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X');\n" + CatalogSql.Found("@object_id"),
        _ => throw new InvalidOperationException("Peek has no lookup for " + kind + ".")
    };

    /// <summary>The parent kinds an index's or trigger's lookup finds it below (the tree's Indexes and Triggers folders).</summary>
    internal static readonly IReadOnlyDictionary<string, string[]> Parents = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["index"] = ["table", "view", "tableType"],
        ["trigger"] = ["table", "view"]
    };

    private static string Parent(string kind, string? parentKind) => parentKind is not null && Parents[kind].Contains(parentKind) ? parentKind
        : throw new InvalidOperationException("Peek finds no " + kind + " below a " + (parentKind ?? "missing parent") + ".");

    /// <summary>What the object references by name (column references collapse into their object's row; itself left out), and
    /// the tables its foreign keys point at: server, database, schema, name, the object's id when it is in this database, and
    /// whether a foreign key makes the link. A reference SQL Server resolved takes the object's current names and no server or
    /// database: referenced_id is set only for this database's objects, and referenced_database_name keeps the code's spelling,
    /// so dropping it lets a reference that names this database in another case be followed, and merges one made both ways. A
    /// four-part name through the local server's own name resolves too, so it loses that server, which is harmless: SQL Server
    /// runs it locally. The test is referenced_id, not the object's row, which sys.all_objects hides from a login that may not
    /// see the object: such a reference keeps the code's schema and name but still loses its server and database.</summary>
    private const string UsesRows = "SELECT CASE WHEN d.referenced_id IS NULL THEN d.referenced_server_name END AS server_name, "
        + "CASE WHEN d.referenced_id IS NULL THEN d.referenced_database_name END AS database_name, COALESCE(rs.name, d.referenced_schema_name) AS schema_name, "
        + "COALESCE(ro.name, d.referenced_entity_name) AS entity_name, ro.object_id AS id, CONVERT(bit, 0) AS via "
        + "FROM sys.sql_expression_dependencies AS d LEFT JOIN sys.all_objects AS ro ON ro.object_id = d.referenced_id LEFT JOIN sys.schemas AS rs ON rs.schema_id = ro.schema_id "
        + "WHERE d.referencing_id = @object_id AND d.referencing_class = 1 AND d.referenced_class = 1 AND d.referenced_entity_name IS NOT NULL "
        + "AND (d.referenced_id IS NULL OR d.referenced_id <> @object_id) "
        + "UNION SELECT NULL, NULL, rs.name, ro.name, ro.object_id, CONVERT(bit, 1) FROM sys.foreign_keys AS fk JOIN sys.all_objects AS ro ON ro.object_id = fk.referenced_object_id "
        + "JOIN sys.schemas AS rs ON rs.schema_id = ro.schema_id WHERE fk.parent_object_id = @object_id AND fk.referenced_object_id <> @object_id";

    /// <summary>The objects whose code references the object (resolved references only), and the tables whose foreign keys point
    /// at it, in <see cref="UsesRows"/>' columns.</summary>
    private const string UsedByRows = "SELECT CONVERT(sysname, NULL) AS server_name, CONVERT(sysname, NULL) AS database_name, s.name AS schema_name, o.name AS entity_name, o.object_id AS id, "
        + "CONVERT(bit, 0) AS via FROM sys.sql_expression_dependencies AS d JOIN sys.all_objects AS o ON o.object_id = d.referencing_id JOIN sys.schemas AS s ON s.schema_id = o.schema_id "
        + "WHERE d.referenced_id = @object_id AND d.referencing_class = 1 AND d.referencing_id <> @object_id "
        + "UNION SELECT NULL, NULL, s.name, o.name, o.object_id, CONVERT(bit, 1) FROM sys.foreign_keys AS fk JOIN sys.all_objects AS o ON o.object_id = fk.parent_object_id "
        + "JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE fk.referenced_object_id = @object_id AND fk.parent_object_id <> @object_id";

    /// <summary>A synonym's base object, in <see cref="UsesRows"/>' columns: when it names no server, and no database or this one,
    /// the object of that name in its schema (dbo when it names none, as SQL Server falls back to) takes its current names and no
    /// server or database, so it can be followed; otherwise the parts as the synonym names them.</summary>
    private const string SynonymUsesRows = "SELECT CASE WHEN ro.object_id IS NULL THEN PARSENAME(sy.base_object_name, 4) END AS server_name, "
        + "CASE WHEN ro.object_id IS NULL THEN PARSENAME(sy.base_object_name, 3) END AS database_name, COALESCE(rs.name, PARSENAME(sy.base_object_name, 2)) AS schema_name, "
        + "COALESCE(ro.name, PARSENAME(sy.base_object_name, 1)) AS entity_name, ro.object_id AS id, CONVERT(bit, 0) AS via FROM sys.synonyms AS sy "
        + "OUTER APPLY (SELECT TOP (1) bo.object_id, bo.name, bo.schema_id FROM sys.all_objects AS bo JOIN sys.schemas AS bs ON bs.schema_id = bo.schema_id "
        + "WHERE PARSENAME(sy.base_object_name, 4) IS NULL AND (PARSENAME(sy.base_object_name, 3) IS NULL OR PARSENAME(sy.base_object_name, 3) = DB_NAME()) "
        + "AND bo.name = PARSENAME(sy.base_object_name, 1) AND (bs.name = PARSENAME(sy.base_object_name, 2) OR PARSENAME(sy.base_object_name, 2) IS NULL AND bs.schema_id = 1) "
        + "ORDER BY bo.object_id) AS ro LEFT JOIN sys.schemas AS rs ON rs.schema_id = ro.schema_id WHERE sy.object_id = @object_id";

    /// <summary>What uses a type (the lookup's user_type_id): code that names it (class 6, a type), and the objects with columns
    /// or parameters of it, but not a table type's own table object.</summary>
    private const string TypeUsedByRows = "SELECT CONVERT(sysname, NULL) AS server_name, CONVERT(sysname, NULL) AS database_name, s.name AS schema_name, o.name AS entity_name, o.object_id AS id, "
        + "CONVERT(bit, 0) AS via FROM sys.sql_expression_dependencies AS d JOIN sys.all_objects AS o ON o.object_id = d.referencing_id JOIN sys.schemas AS s ON s.schema_id = o.schema_id "
        + "WHERE d.referenced_class = 6 AND d.referenced_id = @object_id AND d.referencing_class = 1 "
        + "UNION SELECT NULL, NULL, s.name, o.name, o.object_id, CONVERT(bit, 0) FROM sys.all_columns AS c JOIN sys.all_objects AS o ON o.object_id = c.object_id "
        + "JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE c.user_type_id = @object_id AND o.type <> 'TT' "
        + "UNION SELECT NULL, NULL, s.name, o.name, o.object_id, CONVERT(bit, 0) FROM sys.all_parameters AS pa JOIN sys.all_objects AS o ON o.object_id = pa.object_id "
        + "JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE pa.user_type_id = @object_id";

    /// <summary>No rows, in <see cref="UsesRows"/>' columns: a type uses nothing Peek lists.</summary>
    private const string NoRows = "SELECT CONVERT(sysname, NULL) AS server_name, CONVERT(sysname, NULL) AS database_name, CONVERT(sysname, NULL) AS schema_name, "
        + "CONVERT(sysname, NULL) AS entity_name, CONVERT(int, NULL) AS id, CONVERT(bit, 0) AS via WHERE @object_id IS NULL";

    /// <summary>One listing, at most @take rows in name order: server, database, schema, name, the type, whether a foreign key
    /// makes the link, then what the tree's listings read for a subtype (ExplorerQueries' Tables and views, the tools-support
    /// property as their system flag), each from its band.</summary>
    private static string Listing(string rows, SqlRender render) => "SELECT TOP (@take) x.server_name, x.database_name, x.schema_name, x.entity_name, o.type, x.via, "
        + render.Col(13, "t.temporal_type", "CONVERT(tinyint, 0)") + ", " + render.Col(16, "t.ledger_type", "CONVERT(tinyint, 0)") + ", "
        + render.Col(14, "t.is_node", "CONVERT(bit, 0)") + ", " + render.Col(14, "t.is_edge", "CONVERT(bit, 0)") + ", t.is_filetable, " + render.Col(13, "t.is_external", "CONVERT(bit, 0)") + ", "
        + render.Col(16, "t.is_dropped_ledger_table", "CONVERT(bit, 0)") + ", CONVERT(bit, CASE WHEN o.is_ms_shipped = 1 OR ep.major_id IS NOT NULL THEN 1 ELSE 0 END), "
        + render.Col(16, "v.ledger_view_type", "CONVERT(tinyint, 0)") + ", " + render.Col(16, "v.is_dropped_ledger_view", "CONVERT(bit, 0)") + " FROM (" + rows + ") AS x "
        + "LEFT JOIN sys.all_objects AS o ON o.object_id = x.id LEFT JOIN sys.tables AS t ON t.object_id = x.id LEFT JOIN sys.all_views AS v ON v.object_id = x.id "
        + "LEFT JOIN sys.extended_properties AS ep ON ep.class = 1 AND ep.major_id = x.id AND ep.minor_id = 0 AND ep.name = N'microsoft_database_tools_support' "
        + "ORDER BY x.server_name, x.database_name, x.schema_name, x.entity_name, x.via;\n";

    /// <summary>What the object uses, for the band.</summary>
    internal static string Uses(SqlRender render) => Listing(UsesRows, render);
    /// <summary>What uses the object, for the band.</summary>
    internal static string UsedBy(SqlRender render) => Listing(UsedByRows, render);

    /// <summary>The helper columns after a kind's facts, in order: a table's or index's count of compression settings, a module's
    /// EXECUTE AS principal name, the parts of a type's words, and a module kind's text.</summary>
    public static IReadOnlyList<string> Extras(PeekKindSpec spec) => [.. Kinds[spec.Kind].Helpers.Select(helper => helper.Column), .. spec.Module ? new[] { "definition" } : []];

    /// <summary>The kind's batch for the band (and an index's or trigger's parent kind). Facts newer than the band are left out of
    /// the text and the reply.</summary>
    public static Batch Render(PeekKindSpec spec, SqlRender render, int definitionChars, string? parentKind = null)
    {
        if (!Kinds.TryGetValue(spec.Kind, out var sql)) throw new InvalidOperationException("Peek has no batch for " + spec.Kind + ".");
        var facts = spec.FactsFor(render.Band);
        var columns = new List<(string Column, string Expression)>();
        foreach (var fact in facts.Where(fact => !fact.Optional))
            columns.Add((fact.Id, sql.Facts.GetValueOrDefault(fact.Id) ?? Common.GetValueOrDefault(fact.Id) ?? throw new InvalidOperationException("Peek has no column for " + spec.Kind + "." + fact.Id + ".")));
        columns.AddRange(sql.Helpers);
        // One code unit past the limit tells the reader the text was cut.
        if (spec.Module) columns.Add(("definition", "LEFT(m.definition, " + (definitionChars + 1).ToString(CultureInfo.InvariantCulture) + ")"));
        var text = new StringBuilder(Lookup(spec.Kind, parentKind)).Append("SELECT ");
        text.AppendJoin(", ", columns.Select(column => column.Expression + " AS [" + column.Column + "]"));
        text.Append(' ').Append(sql.From).Append(";\n");
        var lists = new List<ListBatch>();
        var mapping = false;
        foreach (var list in spec.ListSpecs)
        {
            if (list.Id == "userMapping") { text.Append(MappingDatabases); mapping = true; continue; }
            if (!Lists.TryGetValue(list.Id, out var statement)) throw new InvalidOperationException("Peek has no statement for the list " + list.Id + ".");
            text.Append(statement.Text(spec.Kind));
            lists.Add(new(list.Id, statement.Columns));
        }
        IReadOnlyList<string> optional = [];
        if (facts.Any(fact => fact.Optional))
        {
            var (statement, optionalColumns) = Optional.TryGetValue(spec.Kind, out var found) ? found : throw new InvalidOperationException("Peek has no optional statement for " + spec.Kind + ".");
            text.Append(statement);
            optional = optionalColumns;
        }
        return new(text.ToString(), [.. columns.Select(column => column.Column)], lists, optional, mapping);
    }

    /// <summary>The rest of a peek's batch after the lookup's row: the fact row as PeekResult carries it (each fact by its format,
    /// the codes SSMS words, the module text cut to the catalogue's limit), each list up to the catalogue's rows, User mapping's
    /// databases (returned apart for the service to read), and the optional group, or its refusal. Null when the row is gone.</summary>
    public static async Task<(PeekResult Result, List<string> MappingDatabases)?> ReadAsync(SqlDataReader reader, PeekKindSpec spec, Batch batch, int band, CatalogPeek limits, CancellationToken token)
    {
        if (!await reader.ReadAsync(token)) return null;
        var raw = Raw(reader, batch.Columns);
        var facts = new Dictionary<string, object?>(StringComparer.Ordinal);
        var bandFacts = spec.FactsFor(band);
        foreach (var fact in bandFacts.Where(fact => !fact.Optional)) facts[fact.Id] = Value(fact, raw);
        string? definition = null;
        bool? cut = null;
        if (spec.Module && raw["definition"] is string text)
        {
            var (kept, wasCut) = Cut(text, limits.DefinitionChars);
            definition = kept;
            cut = wasCut ? true : null;
        }
        Dictionary<string, PeekList>? lists = spec.ListSpecs.Count > 0 ? new(StringComparer.Ordinal) : null;
        foreach (var list in batch.Lists)
        {
            if (!await reader.NextResultAsync(token)) throw new InvalidOperationException("Peek's batch ended before its list " + list.Id + ".");
            var rows = new List<object?[]>();
            var more = false;
            while (await reader.ReadAsync(token))
            {
                if (rows.Count == limits.ListRows) { more = true; break; }
                rows.Add(ListRow(list.Id, Raw(reader, list.Columns)));
            }
            lists![list.Id] = new(rows, more ? true : null);
        }
        var databases = new List<string>();
        if (batch.Mapping)
        {
            if (!await reader.NextResultAsync(token)) throw new InvalidOperationException("Peek's batch ended before User mapping's databases.");
            while (await reader.ReadAsync(token)) databases.Add(reader.GetString(0));
        }
        List<string>? refused = null;
        if (batch.Optional.Count > 0)
        {
            if (!await reader.NextResultAsync(token) || !await reader.ReadAsync(token)) throw new InvalidOperationException("Peek's batch ended before its optional group.");
            if (reader.FieldCount == 1 && reader.GetName(0) == Refused) refused = [spec.OptionalGroup ?? throw new InvalidOperationException("Peek's " + spec.Kind + " names no optional group.")];
            else
            {
                var optional = Raw(reader, batch.Optional);
                foreach (var fact in bandFacts.Where(fact => fact.Optional)) facts[fact.Id] = Value(fact, optional);
            }
        }
        return (new(facts, 0, definition, cut, Lists: lists, Refused: refused), databases);
    }

    private static Dictionary<string, object?> Raw(SqlDataReader reader, IReadOnlyList<string> columns)
    {
        var raw = new Dictionary<string, object?>(columns.Count, StringComparer.Ordinal);
        for (var index = 0; index < columns.Count; index++) raw[columns[index]] = reader.IsDBNull(index) ? null : reader.GetValue(index);
        return raw;
    }

    /// <summary>A list's row as the catalogue's columns, in order: an index column's type as the tree writes it, a file's
    /// autogrowth in SSMS's words.</summary>
    internal static object?[] ListRow(string list, Dictionary<string, object?> raw) => list switch
    {
        "indexColumns" => [raw["name"], Bool(raw["included"]), Bool(raw["descending"]), raw["type"] is string type
            ? ExplorerLabels.TypeText(new SqlTypeInfo(type, Int(raw["maxLength"]), Int(raw["precision"]), Int(raw["scale"]), IsUserDefined: Bool(raw["userDefined"]) == true)) : null],
        "events" => [raw["event"], Bool(raw["first"]), Bool(raw["last"])],
        "files" => [raw["name"], raw["type"], raw["size"] is null ? null : Convert.ToInt64(raw["size"], CultureInfo.InvariantCulture),
            Growth(Int(raw["growth"]), Bool(raw["percentGrowth"]) == true, Int(raw["maxSize"])), raw["path"]],
        "serverRoles" => [raw["role"], Bool(raw["fixed"])],
        _ => throw new InvalidOperationException("Peek reads no list " + list + ".")
    };

    private static int Int(object? value) => value is null ? 0 : Convert.ToInt32(value, CultureInfo.InvariantCulture);
    private static bool? Bool(object? value) => value is null ? null : Convert.ToBoolean(value, CultureInfo.InvariantCulture);

    /// <summary>A file's Autogrowth / Maxsize as SSMS's Files page words it, from sys.master_files' growth (8 KB pages, or a
    /// percentage), its percentage flag and max_size (pages; -1 unlimited, 0 no growth).</summary>
    internal static string Growth(int growth, bool percent, int maxSize)
    {
        if (growth == 0 || maxSize == 0) return "None";
        var by = percent ? "By " + growth.ToString(CultureInfo.InvariantCulture) + " percent" : "By " + Megabytes(growth);
        return by + ", " + (maxSize == -1 ? "unlimited" : "limited to " + Megabytes(maxSize));
    }

    private static string Megabytes(long pages) => (pages * 8 / 1024.0).ToString("#,0.##", CultureInfo.InvariantCulture) + " MB";

    /// <summary>explorer.peekDependencies' batch for a kind and band: the object found as its peek finds it, then what it uses
    /// and what uses it, at most @take rows each in name order. A synonym uses its base object; a type uses nothing, and is used
    /// by code that names it and by the objects with columns or parameters of it.</summary>
    public static string Dependencies(string kind, SqlRender render, string? parentKind = null) => Lookup(kind, parentKind) + kind switch
    {
        "synonym" => Listing(SynonymUsesRows, render) + UsedBy(render),
        "type" or "tableType" => Listing(NoRows, render) + Listing(TypeUsedByRows, render),
        _ => Uses(render) + UsedBy(render)
    };

    /// <summary>The two dependency listings (the reader is on the first): at most <paramref name="max"/> each, marked truncated
    /// when the batch's TOP (@take), one more, found another.</summary>
    public static async Task<PeekDependenciesResult> ReadDependenciesAsync(SqlDataReader reader, int max, CancellationToken token)
    {
        var (uses, usesCut) = await ListingAsync(reader, max, token);
        var (usedBy, usedByCut) = await reader.NextResultAsync(token) ? await ListingAsync(reader, max, token) : ([], false);
        return new(uses, usedBy, 0, usesCut ? true : null, usedByCut ? true : null);
    }

    private static async Task<(List<PeekDependency> Items, bool Cut)> ListingAsync(SqlDataReader reader, int max, CancellationToken token)
    {
        var items = new List<PeekDependency>();
        while (await reader.ReadAsync(token))
        {
            if (items.Count == max) return (items, true);
            var type = Text(reader, 4);
            var kind = KindOf(type);
            items.Add(new(reader.GetString(3), Text(reader, 2), Text(reader, 1), Text(reader, 0), kind, reader.GetBoolean(5) ? true : null,
                SubtypeOf(kind, type, Number(reader, 6), Number(reader, 7), Flag(reader, 8), Flag(reader, 9), Flag(reader, 10), Flag(reader, 11), Flag(reader, 12), Flag(reader, 13),
                    Number(reader, 14), Flag(reader, 15))));
        }
        return (items, false);
    }

    private static int Number(SqlDataReader reader, int index) => reader.IsDBNull(index) ? 0 : Convert.ToInt32(reader.GetValue(index), CultureInfo.InvariantCulture);
    private static bool Flag(SqlDataReader reader, int index) => !reader.IsDBNull(index) && reader.GetBoolean(index);

    /// <summary>The subtype the tree lists a dependency with (ExplorerQueries: Tables, views, procedures, functions), so a followed
    /// one offers the same Script As verbs and folders.</summary>
    internal static string? SubtypeOf(string? kind, string? type, int temporal, int ledger, bool node, bool edge, bool fileTable, bool external, bool droppedLedger, bool system,
        int ledgerView, bool droppedLedgerView) => kind switch
    {
        "table" => ExplorerLabels.TableSubtype(temporal, ledger, node, edge, fileTable, external, droppedLedger, system),
        "view" => droppedLedgerView ? "droppedLedger" : ledgerView == 1 ? "ledger" : system ? "system" : null,
        "procedure" => type?.TrimEnd() is "X" or "RF" ? ExplorerLabels.ProcedureSubtype(type.TrimEnd()) : system ? "system" : ExplorerLabels.ProcedureSubtype(type?.TrimEnd() ?? "P"),
        "function" => ExplorerLabels.FunctionSubtype(type?.TrimEnd() ?? "FN"),
        _ => null
    };

    private static string? Text(SqlDataReader reader, int index) => reader.IsDBNull(index) ? null : reader.GetString(index);

    /// <summary>The Object Explorer kind of an object type the tree lists by schema and name; null for the rest (triggers, which
    /// the tree lists under their table, and types it does not list).</summary>
    internal static string? KindOf(string? type) => type?.TrimEnd() switch
    {
        "U" or "ET" => "table",
        "V" => "view",
        "P" or "PC" or "X" or "RF" => "procedure",
        "FN" or "IF" or "TF" or "FS" or "FT" or "AF" => "function",
        "SN" => "synonym",
        "SO" => "sequence",
        _ => null
    };

    /// <summary>Module text kept to <paramref name="max"/> code units, never ending inside a surrogate pair.</summary>
    internal static (string Text, bool Cut) Cut(string text, int max)
    {
        if (text.Length <= max) return (text, false);
        return (text[..(char.IsHighSurrogate(text[max - 1]) ? max - 1 : max)], true);
    }

    private static object? Value(PeekFactSpec fact, Dictionary<string, object?> raw)
    {
        var value = raw[fact.Id];
        switch (fact.Id)
        {
            case "executeAs": return ExecuteAsWord(value is null ? null : Convert.ToInt32(value, CultureInfo.InvariantCulture), raw.GetValueOrDefault("executeAsName") as string);
            case "functionType": return value is string type ? FunctionType(type) : null;
            case "compression" when raw.GetValueOrDefault("compressions") is { } count && Convert.ToInt32(count, CultureInfo.InvariantCulture) > 1: return Mixed;
            case "indexType": return value is null ? null : IndexType(Convert.ToInt32(value, CultureInfo.InvariantCulture), Bool(raw.GetValueOrDefault("primaryXml")) == true);
            case "loginType": return value is string login ? LoginType(login) : null;
            case "cache": return value is null ? null : CacheWord(Convert.ToBoolean(value, CultureInfo.InvariantCulture), raw.GetValueOrDefault("cacheSize") is { } size ? Convert.ToInt32(size, CultureInfo.InvariantCulture) : null);
            case "dataType" when value is string name: return name is "decimal" or "numeric" ? name + "(" + Int(raw.GetValueOrDefault("typePrecision")).ToString(CultureInfo.InvariantCulture) + ", 0)" : name;
            case "baseType": return value is string baseName ? ExplorerLabels.TypeText(new SqlTypeInfo(baseName, Int(raw.GetValueOrDefault("maxLength")), Int(raw.GetValueOrDefault("typePrecision")),
                Int(raw.GetValueOrDefault("typeScale")))) : null;
            case "default": return Qualified(raw.GetValueOrDefault("defaultSchema") as string, value as string);
            case "rule": return Qualified(raw.GetValueOrDefault("ruleSchema") as string, value as string);
        }
        if (value is null) return null;
        return fact.Format switch
        {
            "text" or "code" => Convert.ToString(value, CultureInfo.InvariantCulture),
            "date" => ExplorerLabels.Created((DateTime)value),
            "bool" => Convert.ToBoolean(value, CultureInfo.InvariantCulture),
            "count" or "kb" => Convert.ToInt64(value, CultureInfo.InvariantCulture),
            _ => throw new InvalidOperationException("Unknown peek format.")
        };
    }

    private static string? Qualified(string? schema, string? name) => name is null ? null : schema is null ? name : schema + "." + name;

    /// <summary>A table or index whose partitions are compressed differently.</summary>
    internal const string Mixed = "MIXED";

    /// <summary>EXECUTE AS as a module's script says it: CALLER, OWNER, or the user's name (SELF stores its creator's).</summary>
    internal static string? ExecuteAsWord(int? principal, string? name) => principal switch
    {
        null => null,
        Caller => "CALLER",
        -2 => "OWNER",
        _ => name
    };

    /// <summary>The function's type in SSMS's words.</summary>
    internal static string FunctionType(string typeDesc) => typeDesc switch
    {
        "SQL_SCALAR_FUNCTION" => "Scalar-valued",
        "SQL_INLINE_TABLE_VALUED_FUNCTION" => "Inline table-valued",
        "SQL_TABLE_VALUED_FUNCTION" => "Multi-statement table-valued",
        "CLR_SCALAR_FUNCTION" => "CLR scalar-valued",
        "CLR_TABLE_VALUED_FUNCTION" => "CLR table-valued",
        "AGGREGATE_FUNCTION" => "CLR aggregate",
        _ => typeDesc
    };

    /// <summary>sys.indexes.type in Index Properties' words; an XML index says whether it is primary.</summary>
    internal static string IndexType(int type, bool primaryXml) => type switch
    {
        0 => "Heap",
        1 => "Clustered",
        2 => "Nonclustered",
        3 => primaryXml ? "Primary XML" : "Secondary XML",
        4 => "Spatial",
        5 => "Clustered columnstore",
        6 => "Nonclustered columnstore",
        7 => "Nonclustered hash",
        _ => "Other"
    };

    /// <summary>sys.server_principals.type in Login Properties' words.</summary>
    internal static string LoginType(string type) => type.TrimEnd() switch
    {
        "S" => "SQL Server authentication",
        "U" => "Windows user",
        "G" => "Windows group",
        "C" => "Mapped to certificate",
        "K" => "Mapped to asymmetric key",
        "E" => "Microsoft Entra user",
        "X" => "Microsoft Entra group",
        var other => other
    };

    /// <summary>A sequence's cache in its script's words: no cache, the server's default size, or a size.</summary>
    internal static string CacheWord(bool cached, int? size) => !cached ? "No cache" : size is { } value ? value.ToString("N0", CultureInfo.InvariantCulture) : "Default size";
}
