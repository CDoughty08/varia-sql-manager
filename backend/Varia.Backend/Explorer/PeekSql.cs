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
    /// <summary>A rendered batch: its text, the facts row's columns, each list's columns (shown ones first, then helpers, plus
    /// any detail result set's columns), the optional group's columns (empty when the kind or band has none), and whether it
    /// ends with User mapping's databases.</summary>
    internal sealed record Batch(string Text, IReadOnlyList<string> Columns, IReadOnlyList<ListBatch> Lists, IReadOnlyList<string> Optional, bool Mapping);
    internal sealed record ListBatch(string Id, IReadOnlyList<string> Columns, IReadOnlyList<string>? DetailColumns = null);
    /// <summary>User mapping's databases as the batch listed them (at most @take) and how many the login may enter in all.</summary>
    internal sealed record MappingList(List<string> Databases, int Total);

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
    private sealed record KindSql(Func<SqlRender, string> From, Dictionary<string, string> Facts, (string Column, string Expression)[] Helpers)
    {
        public KindSql(string from, Dictionary<string, string> facts, (string Column, string Expression)[] helpers) : this(_ => from, facts, helpers) { }
    }

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
            [("primaryXml", "CONVERT(bit, CASE WHEN xi.xml_index_type = 0 THEN 1 ELSE 0 END)"), ("compressions", "pr.compressions")]),
        // The lookup leaves the parent table (or table type's table object) in @object_id, the key's object_id in @key_id and
        // a PK/UQ's backing index_id in @index_id (NULL for a foreign key). Catalog *_desc columns use syspalnames' collation,
        // so they coerce to DATABASE_DEFAULT wherever a UNION ALL meets CONVERT(nvarchar, NULL).
        ["key"] = new("FROM (SELECT kc.object_id, kc.parent_object_id, kc.type_desc COLLATE DATABASE_DEFAULT AS type_desc, kc.create_date, kc.modify_date, kc.is_system_named, "
            + "CONVERT(int, NULL) AS referenced_object_id, CONVERT(nvarchar(60), NULL) AS delete_action, CONVERT(nvarchar(60), NULL) AS update_action, "
            + "i.is_disabled, CONVERT(bit, NULL) AS is_not_trusted, CONVERT(bit, NULL) AS is_not_for_replication, i.type AS index_type "
            + "FROM sys.key_constraints AS kc LEFT JOIN sys.indexes AS i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id WHERE kc.object_id = @key_id "
            + "UNION ALL SELECT fk.object_id, fk.parent_object_id, fk.type_desc COLLATE DATABASE_DEFAULT, fk.create_date, fk.modify_date, fk.is_system_named, "
            + "fk.referenced_object_id, fk.delete_referential_action_desc COLLATE DATABASE_DEFAULT, fk.update_referential_action_desc COLLATE DATABASE_DEFAULT, "
            + "fk.is_disabled, fk.is_not_trusted, fk.is_not_for_replication, CONVERT(tinyint, NULL) "
            + "FROM sys.foreign_keys AS fk WHERE fk.object_id = @key_id) AS k "
            + "JOIN sys.all_objects AS po ON po.object_id = k.parent_object_id LEFT JOIN sys.table_types AS tt ON tt.type_table_object_id = po.object_id "
            + "JOIN sys.schemas AS ps ON ps.schema_id = COALESCE(tt.schema_id, po.schema_id) "
            + "LEFT JOIN sys.all_objects AS ro ON ro.object_id = k.referenced_object_id LEFT JOIN sys.schemas AS rs ON rs.schema_id = ro.schema_id", Own(
            ("keyType", "k.type_desc"),
            ("parentTable", "COALESCE(tt.name, po.name)"),
            ("referencedTable", "ro.name"),
            ("deleteAction", "k.delete_action"),
            ("updateAction", "k.update_action"),
            ("created", "k.create_date"),
            ("modified", "k.modify_date"),
            ("systemNamed", "k.is_system_named"),
            ("disabled", "k.is_disabled"),
            ("notTrusted", "k.is_not_trusted"),
            ("notForReplication", "k.is_not_for_replication"),
            ("indexType", "k.index_type")),
            [("parentSchema", "ps.name"), ("referencedSchema", "rs.name")]),
        // The lookup leaves the parent table (or table type's table object) in @object_id and the constraint's object_id in
        // @constraint_id. sys.edge_constraints exists from SQL Server 2019 (band 15).
        ["constraint"] = new(r => "FROM (SELECT cc.object_id, cc.parent_object_id, cc.parent_column_id, cc.type_desc COLLATE DATABASE_DEFAULT AS type_desc, LEFT(cc.definition, 4001) AS expr, cc.create_date, cc.modify_date, "
            + "cc.is_system_named, cc.is_disabled, cc.is_not_trusted, cc.is_not_for_replication FROM sys.check_constraints AS cc WHERE cc.object_id = @constraint_id "
            + "UNION ALL SELECT dc.object_id, dc.parent_object_id, dc.parent_column_id, dc.type_desc COLLATE DATABASE_DEFAULT, LEFT(dc.definition, 4001), dc.create_date, dc.modify_date, "
            + "dc.is_system_named, CONVERT(bit, NULL), CONVERT(bit, NULL), CONVERT(bit, NULL) FROM sys.default_constraints AS dc WHERE dc.object_id = @constraint_id"
            + (r.Band >= 15 ? " UNION ALL SELECT ec.object_id, ec.parent_object_id, CONVERT(int, 0), ec.type_desc COLLATE DATABASE_DEFAULT, CONVERT(nvarchar(max), NULL), ec.create_date, ec.modify_date, "
                + "ec.is_system_named, ec.is_disabled, ec.is_not_trusted, CONVERT(bit, NULL) FROM sys.edge_constraints AS ec WHERE ec.object_id = @constraint_id" : "")
            + ") AS c JOIN sys.all_objects AS po ON po.object_id = c.parent_object_id LEFT JOIN sys.table_types AS tt ON tt.type_table_object_id = po.object_id "
            + "JOIN sys.schemas AS ps ON ps.schema_id = COALESCE(tt.schema_id, po.schema_id) "
            + "LEFT JOIN sys.all_columns AS col ON col.object_id = c.parent_object_id AND col.column_id = c.parent_column_id AND c.parent_column_id > 0", Own(
            ("constraintType", "c.type_desc"),
            ("parentTable", "COALESCE(tt.name, po.name)"),
            ("column", "col.name"),
            ("expression", "c.expr"),
            ("created", "c.create_date"),
            ("modified", "c.modify_date"),
            ("systemNamed", "c.is_system_named"),
            ("disabled", "c.is_disabled"),
            ("notTrusted", "c.is_not_trusted"),
            ("notForReplication", "c.is_not_for_replication")),
            [("parentSchema", "ps.name")]),
        ["trigger"] = new("FROM sys.triggers AS o " + Tools + Modules + Assembly + ById, Own([.. TriggerFacts, ("insteadOf", "o.is_instead_of_trigger"),
            ("notForReplication", "o.is_not_for_replication")]), [("executeAsName", "dp.name")]),
        ["databaseTrigger"] = new("FROM sys.triggers AS o " + Tools + Modules + Assembly + ById, Own(TriggerFacts), [("executeAsName", "dp.name")]),
        // A server trigger's module and EXECUTE AS principal are the server's; extended properties do not mark it.
        ["serverTrigger"] = new("FROM sys.server_triggers AS o LEFT JOIN sys.server_sql_modules AS m ON m.object_id = o.object_id "
            + "LEFT JOIN sys.server_assembly_modules AS am ON am.object_id = o.object_id "
            + "LEFT JOIN sys.server_principals AS dp ON dp.principal_id = COALESCE(m.execute_as_principal_id, am.execute_as_principal_id) " + ById,
            Own([.. TriggerFacts, ("systemObject", "o.is_ms_shipped")]), [("executeAsName", "dp.name")]),
        // sys.master_files on the server, so an offline or restoring database has its files too (where the login may see them).
        // A cloud server has no sys.master_files: <see cref="CloudDatabaseFrom"/> replaces this FROM there.
        ["database"] = new(DatabaseFrom + "OUTER APPLY (SELECT SUM(CONVERT(bigint, mf.size)) AS pages, SUM(CASE WHEN mf.type = 1 THEN CONVERT(bigint, mf.size) ELSE 0 END) AS log_pages "
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

    private const string DatabaseFrom = "FROM sys.databases AS d LEFT JOIN sys.server_principals AS own ON own.sid = d.owner_sid ";
    /// <summary>A database's FROM on a cloud server, which has no sys.master_files (nor another database's sys.database_files):
    /// its sizes are unknown, so absent.</summary>
    private const string CloudDatabaseFrom = DatabaseFrom + "CROSS JOIN (SELECT CONVERT(bigint, NULL) AS pages, CONVERT(bigint, NULL) AS log_pages) AS f WHERE d.database_id = @object_id";
    /// <summary>The Files list on a cloud server: none, in the list's columns.</summary>
    private const string CloudFiles = "SELECT CONVERT(sysname, NULL) AS [name], CONVERT(nvarchar(60), NULL) AS [type], CONVERT(bigint, NULL) AS [size], CONVERT(int, NULL) AS [growth], "
        + "CONVERT(nvarchar(260), NULL) AS [path], CONVERT(bit, NULL) AS [percentGrowth], CONVERT(int, NULL) AS [maxSize] WHERE @object_id IS NULL;\n";

    /// <summary>The lists whose columns <see cref="ListRow"/> composes from parts (a Definition, a Key, a default, or a table
    /// object's summary) rather than reads as the catalogue's ids, first and in order, as the other lists do.</summary>
    internal static readonly HashSet<string> Composed = new(StringComparer.Ordinal) { "columns", "tableObjects", "parameters" };
    /// <summary>The Columns, Table Objects and Parameters lists' column aliases, declared before <see cref="Lists"/>, which reads them as it starts.</summary>
    private static readonly string[] ColumnParts = ["name", "quotedName", "type", "quotedType", "quotedTypeSchema", "userDefined", "assemblyType", "baseType", "maxLength", "precision", "scale",
        "nullable", "identity", "seed", "increment", "notForReplication", "filestream", "computed", "computedText", "persisted", "defaultText", "collation", "sparse", "columnSet", "rowGuid", "generated", "hidden", "mask",
        "xmlDocument", "quotedXmlSchema", "quotedXmlCollection", "xmlSchema", "xmlCollection", "vectorDimensions", "primaryKey", "foreignKey"];
    private static readonly string[] TableObjectParts = ["kindCode", "name", "objectId", "indexId", "indexType", "primaryXml", "isUnique", "disabled", "notTrusted", "filter", "expr",
        "refSchema", "refTable", "colName", "insteadOf", "deleteAction"];
    private static readonly string[] TableObjectDetailParts = ["detailKind", "ownerId", "included", "descending", "colName", "refColName"];
    private static readonly string[] ParameterParts = ["name", "type", "quotedType", "quotedTypeSchema", "userDefined", "assemblyType", "tableType", "typeSchema", "baseType", "maxLength",
        "precision", "scale", "output", "readOnly", "hasDefault", "defaultValue", "xmlDocument", "quotedXmlSchema", "quotedXmlCollection", "xmlSchema", "xmlCollection", "cursor", "moduleType", "nullable"];

    /// <summary>The lists' statements for a kind and band, each at most @take rows in a fixed order, with their column aliases:
    /// the parts <see cref="ListRow"/> makes the list's columns from (and any detail result set's aliases).</summary>
    private static readonly Dictionary<string, (Func<string, SqlRender, string> Text, string[] Columns, string[]? DetailColumns)> Lists = new(StringComparer.Ordinal)
    {
        ["columns"] = (ColumnsList, ColumnParts, null),
        ["tableObjects"] = (TableObjectsList, TableObjectParts, TableObjectDetailParts),
        ["parameters"] = ((_, _) => ParametersList, ParameterParts, null),
        ["indexColumns"] = ((_, _) =>"SELECT TOP (@take) c.name AS [name], ic.is_included_column AS [included], ic.is_descending_key AS [descending], ty.name AS [type], "
            + "c.max_length AS [maxLength], c.precision AS [precision], c.scale AS [scale], ty.is_user_defined AS [userDefined] FROM sys.index_columns AS ic "
            + "JOIN sys.all_columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id "
            + "WHERE ic.object_id = @object_id AND ic.index_id = @index_id ORDER BY ic.is_included_column, CASE WHEN ic.key_ordinal = 0 THEN ic.index_column_id ELSE ic.key_ordinal END, ic.index_column_id;\n",
            ["name", "included", "descending", "type", "maxLength", "precision", "scale", "userDefined"], null),
        ["keyColumns"] = ((_, _) => "SELECT TOP (@take) k.name AS [name], k.referenced_column AS [referencedColumn], k.descending AS [descending], k.type_name AS [type], "
            + "k.max_length AS [maxLength], k.precision AS [precision], k.scale AS [scale], k.user_defined AS [userDefined] FROM ("
            + "SELECT CASE WHEN ic.key_ordinal = 0 THEN ic.index_column_id ELSE ic.key_ordinal END AS ord, ic.index_column_id AS tie, c.name, CONVERT(sysname, NULL) AS referenced_column, "
            + "ic.is_descending_key AS descending, ty.name AS type_name, c.max_length, c.precision, c.scale, ty.is_user_defined AS user_defined "
            + "FROM sys.index_columns AS ic JOIN sys.all_columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id "
            + "WHERE @index_id IS NOT NULL AND ic.object_id = @object_id AND ic.index_id = @index_id AND ic.is_included_column = 0 AND NOT (ic.key_ordinal = 0 AND ic.partition_ordinal > 0) "
            + "UNION ALL SELECT fkc.constraint_column_id AS ord, fkc.constraint_column_id AS tie, c.name, rc.name AS referenced_column, CONVERT(bit, NULL) AS descending, "
            + "ty.name AS type_name, c.max_length, c.precision, c.scale, ty.is_user_defined AS user_defined "
            + "FROM sys.foreign_key_columns AS fkc JOIN sys.all_columns AS c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id "
            + "LEFT JOIN sys.all_columns AS rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id "
            + "JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id "
            + "WHERE @index_id IS NULL AND fkc.constraint_object_id = @key_id) AS k ORDER BY k.ord, k.tie;\n",
            ["name", "referencedColumn", "descending", "type", "maxLength", "precision", "scale", "userDefined"], null),
        ["events"] = ((kind, _) =>"SELECT TOP (@take) te.type_desc AS [event], te.is_first AS [first], te.is_last AS [last] FROM "
            + (kind == "serverTrigger" ? "sys.server_trigger_events" : "sys.trigger_events") + " AS te WHERE te.object_id = @object_id ORDER BY te.type;\n", ["event", "first", "last"], null),
        ["files"] = ((_, _) =>"SELECT TOP (@take) mf.name AS [name], mf.type_desc AS [type], CONVERT(bigint, mf.size) * 8 AS [size], mf.growth AS [growth], mf.physical_name AS [path], "
            + "mf.is_percent_growth AS [percentGrowth], mf.max_size AS [maxSize] FROM sys.master_files AS mf WHERE mf.database_id = @object_id ORDER BY mf.file_id;\n",
            ["name", "type", "size", "growth", "path", "percentGrowth", "maxSize"], null),
        ["serverRoles"] = ((_, _) =>"SELECT TOP (@take) r.name AS [role], r.is_fixed_role AS [fixed] FROM sys.server_role_members AS rm "
            + "JOIN sys.server_principals AS r ON r.principal_id = rm.role_principal_id WHERE rm.member_principal_id = @object_id ORDER BY r.name;\n", ["role", "fixed"], null)
    };

    /// <summary>A table's, view's or table type's columns as the Columns folder lists them (<see cref="ExplorerQueries.ColumnVisibility"/>),
    /// in column order, with what a column's declaration needs: its name and its type's names through QUOTENAME, the type's
    /// sizes, its identity's seed and increment, its computed expression, its default (without the constraint's name), and its
    /// collation only where it is not the database's (compared under a binary collation: sys.databases is in the server's
    /// collation, sys.all_columns in the database's, and the two may conflict). A table type's lookup leaves its user_type_id in @object_id, so its
    /// columns are its table object's. Expressions are read one past a local grid's 4,000 characters a cell, which then says
    /// it cut them.</summary>
    private static string ColumnsList(string kind, SqlRender r) => "SELECT TOP (@take) c.name AS [name], QUOTENAME(c.name) AS [quotedName], ty.name AS [type], "
        + "QUOTENAME(ty.name) AS [quotedType], QUOTENAME(tys.name) AS [quotedTypeSchema], ty.is_user_defined AS [userDefined], ty.is_assembly_type AS [assemblyType], "
        + "bt.name AS [baseType], c.max_length AS [maxLength], c.precision AS [precision], c.scale AS [scale], c.is_nullable AS [nullable], c.is_identity AS [identity], "
        + "CONVERT(nvarchar(64), idc.seed_value) AS [seed], CONVERT(nvarchar(64), idc.increment_value) AS [increment], idc.is_not_for_replication AS [notForReplication], c.is_filestream AS [filestream], c.is_computed AS [computed], LEFT(cc.definition, 4001) AS [computedText], cc.is_persisted AS [persisted], "
        + "LEFT(dc.definition, 4001) AS [defaultText], CASE WHEN c.collation_name COLLATE Latin1_General_100_BIN2 <> d.collation_name COLLATE Latin1_General_100_BIN2 THEN c.collation_name END AS [collation], c.is_sparse AS [sparse], "
        + "c.is_column_set AS [columnSet], c.is_rowguidcol AS [rowGuid], " + r.Col(13, "c.generated_always_type", "CONVERT(tinyint, 0)") + " AS [generated], "
        + r.Col(13, "c.is_hidden", "CONVERT(bit, 0)") + " AS [hidden], "
        + r.Col(13, "(SELECT LEFT(mc.masking_function, 4001) FROM sys.masked_columns AS mc WHERE mc.object_id = c.object_id AND mc.column_id = c.column_id)", "CONVERT(nvarchar(4000), NULL)")
        + " AS [mask], c.is_xml_document AS [xmlDocument], QUOTENAME(xss.name) AS [quotedXmlSchema], "
        + "QUOTENAME(xs.name) AS [quotedXmlCollection], xss.name AS [xmlSchema], xs.name AS [xmlCollection], " + (r.VectorDimensions ? "c.vector_dimensions" : "CONVERT(int, NULL)")
        + " AS [vectorDimensions], CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.indexes AS i JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
        + "WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id) THEN 1 ELSE 0 END) AS [primaryKey], "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.foreign_key_columns AS f WHERE f.parent_object_id = c.object_id AND f.parent_column_id = c.column_id) THEN 1 ELSE 0 END) AS [foreignKey] "
        + "FROM sys.all_columns AS c JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id JOIN sys.schemas AS tys ON tys.schema_id = ty.schema_id "
        + "LEFT JOIN sys.types AS bt ON ty.is_user_defined = 1 AND ty.is_assembly_type = 0 AND ty.is_table_type = 0 AND bt.user_type_id = ty.system_type_id "
        + "LEFT JOIN sys.xml_schema_collections AS xs ON c.xml_collection_id <> 0 AND xs.xml_collection_id = c.xml_collection_id LEFT JOIN sys.schemas AS xss ON xss.schema_id = xs.schema_id "
        + "LEFT JOIN sys.identity_columns AS idc ON idc.object_id = c.object_id AND idc.column_id = c.column_id "
        + "LEFT JOIN sys.computed_columns AS cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id LEFT JOIN sys.default_constraints AS dc ON dc.object_id = c.default_object_id "
        + "LEFT JOIN sys.databases AS d ON d.database_id = DB_ID() WHERE c.object_id = "
        + (kind == "tableType" ? "(SELECT tt.type_table_object_id FROM sys.table_types AS tt WHERE tt.user_type_id = @object_id)" : "@object_id")
        + " AND " + ExplorerQueries.ColumnVisibility(r) + " ORDER BY c.column_id;\n";

    /// <summary>Maximum detail rows read beside <c>tableObjects</c> (one extra row detects overflow and names the owner it cut).</summary>
    internal const int TableObjectDetailCap = 16384;

    /// <summary>A table's keys, indexes, constraints and triggers (bounded at @take, in kind then name order) followed by a
    /// bounded detail result set of their FK columns, trigger events and index columns (FK and trigger details first, then PK/UQ
    /// before other indexes, reading one row past <see cref="TableObjectDetailCap"/> to detect truncation) so summaries compose
    /// in C# without STRING_AGG (SQL Server 2017+) or FOR XML (which refuses control characters in identifiers). Reads catalog
    /// views only (no DMV, no VIEW SERVER STATE) and coerces syspalnames columns to DATABASE_DEFAULT across UNION ALL.</summary>
    private static string TableObjectsList(string _, SqlRender r) => "SELECT TOP (@take) t.kind_code AS [kindCode], t.name AS [name], t.obj_id AS [objectId], t.idx_id AS [indexId], "
        + "t.idx_type AS [indexType], t.primary_xml AS [primaryXml], t.is_unique AS [isUnique], t.is_disabled AS [disabled], t.is_not_trusted AS [notTrusted], "
        + "t.filter_def AS [filter], t.expr AS [expr], t.ref_schema AS [refSchema], t.ref_table AS [refTable], t.col_name AS [colName], t.instead_of AS [insteadOf], t.del_action AS [deleteAction] FROM ("
        + "SELECT CASE WHEN kc.type = 'PK' THEN 1 ELSE 3 END AS kind_order, kc.type COLLATE DATABASE_DEFAULT AS kind_code, kc.name, kc.object_id AS obj_id, kc.unique_index_id AS idx_id, kc.object_id AS tie_id, "
        + "i.type AS idx_type, CONVERT(bit, 0) AS primary_xml, i.is_unique, i.is_disabled, CONVERT(bit, NULL) AS is_not_trusted, CONVERT(nvarchar(max), NULL) AS filter_def, "
        + "CONVERT(nvarchar(max), NULL) AS expr, CONVERT(sysname, NULL) AS ref_schema, CONVERT(sysname, NULL) AS ref_table, CONVERT(sysname, NULL) AS col_name, "
        + "CONVERT(bit, NULL) AS instead_of, CONVERT(nvarchar(60), NULL) AS del_action "
        + "FROM sys.key_constraints AS kc LEFT JOIN sys.indexes AS i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id WHERE kc.parent_object_id = @object_id "
        + "UNION ALL SELECT 2, 'F', fk.name, fk.object_id, CONVERT(int, NULL), fk.object_id, CONVERT(tinyint, NULL), CONVERT(bit, 0), CONVERT(bit, NULL), fk.is_disabled, fk.is_not_trusted, "
        + "CONVERT(nvarchar(max), NULL), CONVERT(nvarchar(max), NULL), rs.name, ro.name, CONVERT(sysname, NULL), CONVERT(bit, NULL), CONVERT(nvarchar(60), NULL) "
        + "FROM sys.foreign_keys AS fk LEFT JOIN sys.all_objects AS ro ON ro.object_id = fk.referenced_object_id LEFT JOIN sys.schemas AS rs ON rs.schema_id = ro.schema_id WHERE fk.parent_object_id = @object_id "
        + "UNION ALL SELECT 4, 'IX', i.name, i.object_id, i.index_id, i.index_id, i.type, CONVERT(bit, CASE WHEN xi.xml_index_type = 0 THEN 1 ELSE 0 END), i.is_unique, i.is_disabled, "
        + "CONVERT(bit, NULL), LEFT(i.filter_definition, 4001), CONVERT(nvarchar(max), NULL), CONVERT(sysname, NULL), CONVERT(sysname, NULL), CONVERT(sysname, NULL), CONVERT(bit, NULL), CONVERT(nvarchar(60), NULL) "
        + "FROM sys.indexes AS i LEFT JOIN sys.xml_indexes AS xi ON xi.object_id = i.object_id AND xi.index_id = i.index_id "
        + "WHERE i.object_id = @object_id AND i.type > 0 AND i.is_hypothetical = 0 AND i.is_primary_key = 0 AND i.is_unique_constraint = 0 AND i.name IS NOT NULL "
        + "UNION ALL SELECT 5, 'C', cc.name, cc.object_id, CONVERT(int, NULL), cc.object_id, CONVERT(tinyint, NULL), CONVERT(bit, 0), CONVERT(bit, NULL), cc.is_disabled, cc.is_not_trusted, "
        + "CONVERT(nvarchar(max), NULL), LEFT(cc.definition, 4001), CONVERT(sysname, NULL), CONVERT(sysname, NULL), CONVERT(sysname, NULL), CONVERT(bit, NULL), CONVERT(nvarchar(60), NULL) "
        + "FROM sys.check_constraints AS cc WHERE cc.parent_object_id = @object_id "
        + "UNION ALL SELECT 6, 'D', dc.name, dc.object_id, CONVERT(int, NULL), dc.object_id, CONVERT(tinyint, NULL), CONVERT(bit, 0), CONVERT(bit, NULL), CONVERT(bit, NULL), CONVERT(bit, NULL), "
        + "CONVERT(nvarchar(max), NULL), LEFT(dc.definition, 4001), CONVERT(sysname, NULL), CONVERT(sysname, NULL), col.name, CONVERT(bit, NULL), CONVERT(nvarchar(60), NULL) "
        + "FROM sys.default_constraints AS dc LEFT JOIN sys.all_columns AS col ON col.object_id = dc.parent_object_id AND col.column_id = dc.parent_column_id AND dc.parent_column_id > 0 WHERE dc.parent_object_id = @object_id"
        + (r.Band >= 15
            ? " UNION ALL SELECT 7, 'EC', ec.name, ec.object_id, CONVERT(int, NULL), ec.object_id, CONVERT(tinyint, NULL), CONVERT(bit, 0), CONVERT(bit, NULL), ec.is_disabled, ec.is_not_trusted, "
                + "CONVERT(nvarchar(max), NULL), CONVERT(nvarchar(max), NULL), CONVERT(sysname, NULL), CONVERT(sysname, NULL), CONVERT(sysname, NULL), CONVERT(bit, NULL), ec.delete_referential_action_desc COLLATE DATABASE_DEFAULT "
                + "FROM sys.edge_constraints AS ec WHERE ec.parent_object_id = @object_id"
            : "")
        + " UNION ALL SELECT 8, 'TR', tr.name, tr.object_id, CONVERT(int, NULL), tr.object_id, CONVERT(tinyint, NULL), CONVERT(bit, 0), CONVERT(bit, NULL), tr.is_disabled, CONVERT(bit, NULL), "
        + "CONVERT(nvarchar(max), NULL), CONVERT(nvarchar(max), NULL), CONVERT(sysname, NULL), CONVERT(sysname, NULL), CONVERT(sysname, NULL), tr.is_instead_of_trigger, CONVERT(nvarchar(60), NULL) "
        + "FROM sys.triggers AS tr WHERE tr.parent_class = 1 AND tr.parent_id = @object_id) AS t ORDER BY t.kind_order, t.name, t.tie_id;\n"
        + "SELECT TOP (" + (TableObjectDetailCap + 1).ToString(CultureInfo.InvariantCulture) + ") d.detail_kind AS [detailKind], d.owner_id AS [ownerId], d.is_included AS [included], d.is_descending AS [descending], d.col_name AS [colName], d.ref_col_name AS [refColName] FROM ("
        + "SELECT 1 AS grp, 0 AS prio, 'FK' AS detail_kind, fkc.constraint_object_id AS owner_id, CONVERT(bit, 0) AS is_included, CONVERT(bit, 0) AS is_descending, "
        + "fkc.constraint_column_id AS ord, fkc.constraint_column_id AS tie, c.name AS col_name, rc.name AS ref_col_name "
        + "FROM sys.foreign_key_columns AS fkc JOIN sys.all_columns AS c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id "
        + "LEFT JOIN sys.all_columns AS rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id WHERE fkc.parent_object_id = @object_id "
        + "UNION ALL SELECT 2, 0, 'TE', te.object_id, CONVERT(bit, 0), CONVERT(bit, 0), te.type, te.type, te.type_desc COLLATE DATABASE_DEFAULT, CONVERT(sysname, NULL) "
        + "FROM sys.triggers AS tr JOIN sys.trigger_events AS te ON te.object_id = tr.object_id WHERE tr.parent_class = 1 AND tr.parent_id = @object_id "
        + "UNION ALL SELECT 3, CASE WHEN i.is_primary_key = 1 THEN 0 WHEN i.is_unique_constraint = 1 THEN 1 ELSE 2 END, 'IC', ic.index_id, ic.is_included_column, ic.is_descending_key, "
        + "CASE WHEN ic.key_ordinal = 0 THEN ic.index_column_id ELSE ic.key_ordinal END, ic.index_column_id, c.name, CONVERT(sysname, NULL) "
        + "FROM sys.index_columns AS ic JOIN sys.indexes AS i ON i.object_id = ic.object_id AND i.index_id = ic.index_id JOIN sys.all_columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
        + "WHERE ic.object_id = @object_id AND i.type > 0 AND i.is_hypothetical = 0 AND NOT (ic.key_ordinal = 0 AND ic.is_included_column = 0 AND ic.partition_ordinal > 0)) AS d "
        + "ORDER BY d.grp, d.prio, d.owner_id, d.is_included, d.ord, d.tie;\n";

    /// <summary>A procedure's or function's parameters as the Parameters folder lists them (not the return value), in order, with
    /// what a declaration needs: the type's names through QUOTENAME, its sizes, and a CLR module's default (a T-SQL module's
    /// comes from its header, <see cref="ModuleHeader.ParameterDefaultTexts"/>).</summary>
    private const string ParametersList = "SELECT TOP (@take) p.name AS [name], ty.name AS [type], QUOTENAME(ty.name) AS [quotedType], QUOTENAME(tys.name) AS [quotedTypeSchema], "
        + "ty.is_user_defined AS [userDefined], ty.is_assembly_type AS [assemblyType], ty.is_table_type AS [tableType], tys.name AS [typeSchema], bt.name AS [baseType], "
        + "p.max_length AS [maxLength], p.precision AS [precision], p.scale AS [scale], p.is_output AS [output], p.is_readonly AS [readOnly], p.has_default_value AS [hasDefault], "
        + "p.default_value AS [defaultValue], p.is_xml_document AS [xmlDocument], QUOTENAME(xss.name) AS [quotedXmlSchema], QUOTENAME(xs.name) AS [quotedXmlCollection], "
        + "xss.name AS [xmlSchema], xs.name AS [xmlCollection], p.is_cursor_ref AS [cursor], o.type AS [moduleType], p.is_nullable AS [nullable] "
        + "FROM sys.all_parameters AS p JOIN sys.all_objects AS o ON o.object_id = p.object_id JOIN sys.types AS ty ON ty.user_type_id = p.user_type_id "
        + "JOIN sys.schemas AS tys ON tys.schema_id = ty.schema_id "
        + "LEFT JOIN sys.types AS bt ON ty.is_user_defined = 1 AND ty.is_assembly_type = 0 AND ty.is_table_type = 0 AND bt.user_type_id = ty.system_type_id "
        + "LEFT JOIN sys.xml_schema_collections AS xs ON p.xml_collection_id <> 0 AND xs.xml_collection_id = p.xml_collection_id LEFT JOIN sys.schemas AS xss ON xss.schema_id = xs.schema_id "
        + "WHERE p.object_id = @object_id AND p.parameter_id > 0 ORDER BY p.parameter_id;\n";

    /// <summary>User mapping's databases, in place of its list: those online that the login may enter, in name order, each with
    /// how many there are in all (so those past @take are counted unread). Only the login's batch calls HAS_DBACCESS, as the
    /// database listings do.</summary>
    internal const string MappingDatabases = "SELECT TOP (@take) d.name, COUNT(*) OVER () AS total FROM sys.databases AS d WHERE d.state = 0 AND HAS_DBACCESS(d.name) = 1 ORDER BY d.name;\n";

    /// <summary>The login's user in one database (run there through <see cref="CatalogSql.ModuleCall"/>): the database principal
    /// whose SID is the login's, found by its name in sys.server_principals, which every database sees.</summary>
    internal const string MappingUsers = "SELECT TOP (@take) dp.name AS [user], dp.default_schema_name AS [defaultSchema] FROM sys.database_principals AS dp "
        + "JOIN sys.server_principals AS sp ON sp.sid = dp.sid WHERE sp.name = @object_name AND sp.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X') "
        + "AND dp.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X') ORDER BY dp.name;\n";

    /// <summary>The optional groups' statements: an index's usage, which sys.dm_db_index_usage_stats keeps from the server's start
    /// and only a login with VIEW SERVER STATE may read. A refusal (229, 262, 297 or 300) answers one refused column instead of
    /// failing the batch; any other error is raised again.</summary>
    private static readonly Dictionary<string, (string Text, string[] Columns)> Optional = new(StringComparer.Ordinal)
    {
        ["index"] = ("BEGIN TRY\nSELECT COALESCE(us.user_seeks, 0) AS [userSeeks], COALESCE(us.user_scans, 0) AS [userScans], COALESCE(us.user_lookups, 0) AS [userLookups], "
            + "COALESCE(us.user_updates, 0) AS [userUpdates], us.last_user_seek AS [lastSeek], us.last_user_scan AS [lastScan], us.last_user_lookup AS [lastLookup], "
            + "us.last_user_update AS [lastUpdate] FROM sys.indexes AS i LEFT JOIN sys.dm_db_index_usage_stats AS us ON us.database_id = DB_ID() AND us.object_id = i.object_id "
            + "AND us.index_id = i.index_id WHERE i.object_id = @object_id AND i.index_id = @index_id;\nEND TRY\nBEGIN CATCH\nIF ERROR_NUMBER() NOT IN (229, 262, 297, 300) THROW;\n"
            + "SELECT CONVERT(bit, 1) AS [" + Refused + "];\nEND CATCH;\n",
            ["userSeeks", "userScans", "userLookups", "userUpdates", "lastSeek", "lastScan", "lastLookup", "lastUpdate"])
    };

    /// <summary>A table's FROM and WHERE (the row by @object_id, aliases o, s, t, i, ds, lob, pr and sp), which Table Properties reads its
    /// facts from too (Actions/TableProperties.cs), so both say the same of a table.</summary>
    internal static string TableFrom => Kinds["table"].From(new SqlRender(ExplorerCatalog.MinBand));

    /// <summary>A table fact's expression over <see cref="TableFrom"/>, as Peek reads it (its own facts, then the common ones).</summary>
    internal static string TableFact(string id) => Kinds["table"].Facts.GetValueOrDefault(id) ?? Common.GetValueOrDefault(id) ?? throw new InvalidOperationException("Peek has no table fact " + id + ".");

    /// <summary>The one column an optional statement answers when the login was refused.</summary>
    internal const string Refused = "refused";

    /// <summary>The statement that finds the object and answers whether it did (one bit row; the batch ends when it did not): the
    /// object's id in @object_id (a type's or table type's user_type_id), and for an index, key or constraint its parent's in
    /// @object_id and its own in @index_id, @key_id or @constraint_id. Child kinds are found below their parent, by the name in @k1.</summary>
    public static string Lookup(string kind, string? parentKind = null, int band = ExplorerCatalog.MaxBand) => kind switch
    {
        "table" or "view" or "procedure" or "function" or "synonym" or "sequence" => CatalogSql.ParentLookup(kind),
        "type" => "DECLARE @object_id int;\nSELECT @object_id = ty.user_type_id FROM sys.types AS ty JOIN sys.schemas AS ps ON ps.schema_id = ty.schema_id "
            + "WHERE ps.name = @object_schema AND ty.name = @object_name AND ty.is_user_defined = 1 AND ty.is_table_type = 0;\n" + CatalogSql.Found("@object_id"),
        "tableType" => "DECLARE @object_id int;\nSELECT @object_id = tt.user_type_id FROM sys.table_types AS tt JOIN sys.schemas AS ps ON ps.schema_id = tt.schema_id "
            + "WHERE ps.name = @object_schema AND tt.name = @object_name;\n" + CatalogSql.Found("@object_id"),
        "index" => CatalogSql.ParentSelect(Parent(kind, parentKind)) + "DECLARE @index_id int;\nSELECT @index_id = i.index_id FROM sys.indexes AS i "
            + "WHERE i.object_id = @object_id AND i.name = @k1 AND i.type > 0 AND i.is_hypothetical = 0;\n" + CatalogSql.Found("@index_id"),
        "key" => CatalogSql.ParentSelect(Parent(kind, parentKind)) + "DECLARE @key_id int, @index_id int;\nSELECT @key_id = k.object_id, @index_id = k.index_id FROM ("
            + "SELECT kc.object_id, kc.unique_index_id AS index_id FROM sys.key_constraints AS kc WHERE kc.parent_object_id = @object_id AND kc.name = @k1 "
            + "UNION ALL SELECT fk.object_id, CONVERT(int, NULL) AS index_id FROM sys.foreign_keys AS fk WHERE fk.parent_object_id = @object_id AND fk.name = @k1) AS k;\n"
            + CatalogSql.Found("@key_id"),
        "constraint" => CatalogSql.ParentSelect(Parent(kind, parentKind)) + "DECLARE @constraint_id int;\nSELECT @constraint_id = c.object_id FROM ("
            + "SELECT cc.object_id FROM sys.check_constraints AS cc WHERE cc.parent_object_id = @object_id AND cc.name = @k1 "
            + "UNION ALL SELECT dc.object_id FROM sys.default_constraints AS dc WHERE dc.parent_object_id = @object_id AND dc.name = @k1"
            + (band >= 15 ? " UNION ALL SELECT ec.object_id FROM sys.edge_constraints AS ec WHERE ec.parent_object_id = @object_id AND ec.name = @k1" : "")
            + ") AS c;\n" + CatalogSql.Found("@constraint_id"),
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

    /// <summary>The parent kinds a child peek lookup finds it below (the tree's Indexes, Keys, Constraints and Triggers folders).</summary>
    internal static readonly IReadOnlyDictionary<string, string[]> Parents = new Dictionary<string, string[]>(StringComparer.Ordinal)
    {
        ["index"] = ["table", "view", "tableType"],
        ["key"] = ["table", "tableType"],
        ["constraint"] = ["table", "tableType"],
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
    /// see the object: such a reference keeps the code's schema and name but still loses its server and database. A DML trigger
    /// also uses its table or view, as SSMS lists it (its ON clause is not a reference the server records).</summary>
    private const string UsesRows = "SELECT CASE WHEN d.referenced_id IS NULL THEN d.referenced_server_name END AS server_name, "
        + "CASE WHEN d.referenced_id IS NULL THEN d.referenced_database_name END AS database_name, COALESCE(rs.name, d.referenced_schema_name) AS schema_name, "
        + "COALESCE(ro.name, d.referenced_entity_name) AS entity_name, ro.object_id AS id, CONVERT(bit, 0) AS via, d.is_schema_bound_reference AS bound "
        + "FROM sys.sql_expression_dependencies AS d LEFT JOIN sys.all_objects AS ro ON ro.object_id = d.referenced_id LEFT JOIN sys.schemas AS rs ON rs.schema_id = ro.schema_id "
        + "WHERE d.referencing_id = @object_id AND d.referencing_class = 1 AND d.referenced_class = 1 AND d.referenced_entity_name IS NOT NULL "
        + "AND (d.referenced_id IS NULL OR d.referenced_id <> @object_id) "
        + "UNION SELECT NULL, NULL, rs.name, ro.name, ro.object_id, CONVERT(bit, 1), CONVERT(bit, 0) FROM sys.foreign_keys AS fk JOIN sys.all_objects AS ro ON ro.object_id = fk.referenced_object_id "
        + "JOIN sys.schemas AS rs ON rs.schema_id = ro.schema_id WHERE fk.parent_object_id = @object_id AND fk.referenced_object_id <> @object_id "
        + "UNION SELECT NULL, NULL, ts.name, tp.name, tp.object_id, CONVERT(bit, 0), CONVERT(bit, 0) FROM sys.triggers AS tr JOIN sys.all_objects AS tp ON tp.object_id = tr.parent_id "
        + "JOIN sys.schemas AS ts ON ts.schema_id = tp.schema_id WHERE tr.parent_class = 1 AND tr.object_id = @object_id";

    /// <summary>The objects whose code references the object (resolved references only), the tables whose foreign keys point
    /// at it, and its own DML triggers (as SSMS lists them: a trigger's ON clause is not a reference the server records), in
    /// <see cref="UsesRows"/>' columns.</summary>
    private const string UsedByRows = "SELECT CONVERT(sysname, NULL) AS server_name, CONVERT(sysname, NULL) AS database_name, s.name AS schema_name, o.name AS entity_name, o.object_id AS id, "
        + "CONVERT(bit, 0) AS via, d.is_schema_bound_reference AS bound FROM sys.sql_expression_dependencies AS d JOIN sys.all_objects AS o ON o.object_id = d.referencing_id JOIN sys.schemas AS s ON s.schema_id = o.schema_id "
        + "WHERE d.referenced_id = @object_id AND d.referencing_class = 1 AND d.referencing_id <> @object_id "
        + "UNION SELECT NULL, NULL, s.name, o.name, o.object_id, CONVERT(bit, 1), CONVERT(bit, 0) FROM sys.foreign_keys AS fk JOIN sys.all_objects AS o ON o.object_id = fk.parent_object_id "
        + "JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE fk.referenced_object_id = @object_id AND fk.parent_object_id <> @object_id "
        + "UNION SELECT NULL, NULL, s.name, o.name, o.object_id, CONVERT(bit, 0), CONVERT(bit, 0) FROM sys.triggers AS tr JOIN sys.all_objects AS o ON o.object_id = tr.object_id "
        + "JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE tr.parent_class = 1 AND tr.parent_id = @object_id";

    /// <summary>A synonym's base object, in <see cref="UsesRows"/>' columns: when it names no server, and no database or this one,
    /// the object of that name in its schema (dbo when it names none, as SQL Server falls back to) takes its current names and no
    /// server or database, so it can be followed; otherwise the parts as the synonym names them.</summary>
    private const string SynonymUsesRows = "SELECT CASE WHEN ro.object_id IS NULL THEN PARSENAME(sy.base_object_name, 4) END AS server_name, "
        + "CASE WHEN ro.object_id IS NULL THEN PARSENAME(sy.base_object_name, 3) END AS database_name, COALESCE(rs.name, PARSENAME(sy.base_object_name, 2)) AS schema_name, "
        + "COALESCE(ro.name, PARSENAME(sy.base_object_name, 1)) AS entity_name, ro.object_id AS id, CONVERT(bit, 0) AS via, CONVERT(bit, 0) AS bound FROM sys.synonyms AS sy "
        + "OUTER APPLY (SELECT TOP (1) bo.object_id, bo.name, bo.schema_id FROM sys.all_objects AS bo JOIN sys.schemas AS bs ON bs.schema_id = bo.schema_id "
        + "WHERE PARSENAME(sy.base_object_name, 4) IS NULL AND (PARSENAME(sy.base_object_name, 3) IS NULL OR PARSENAME(sy.base_object_name, 3) = DB_NAME()) "
        + "AND bo.name = PARSENAME(sy.base_object_name, 1) AND (bs.name = PARSENAME(sy.base_object_name, 2) OR PARSENAME(sy.base_object_name, 2) IS NULL AND bs.schema_id = 1) "
        + "ORDER BY bo.object_id) AS ro LEFT JOIN sys.schemas AS rs ON rs.schema_id = ro.schema_id WHERE sy.object_id = @object_id";

    /// <summary>What uses a type (the lookup's user_type_id): code that names it (class 6, a type), the objects with columns or
    /// parameters of it, and the table types with columns of it (by the table type's names, not its table object's).</summary>
    private const string TypeUsedByRows = "SELECT CONVERT(sysname, NULL) AS server_name, CONVERT(sysname, NULL) AS database_name, s.name AS schema_name, o.name AS entity_name, o.object_id AS id, "
        + "CONVERT(bit, 0) AS via, d.is_schema_bound_reference AS bound FROM sys.sql_expression_dependencies AS d JOIN sys.all_objects AS o ON o.object_id = d.referencing_id JOIN sys.schemas AS s ON s.schema_id = o.schema_id "
        + "WHERE d.referenced_class = 6 AND d.referenced_id = @object_id AND d.referencing_class = 1 "
        + "UNION SELECT NULL, NULL, s.name, o.name, o.object_id, CONVERT(bit, 0), CONVERT(bit, 1) FROM sys.all_columns AS c JOIN sys.all_objects AS o ON o.object_id = c.object_id "
        + "JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE c.user_type_id = @object_id AND o.type <> 'TT' "
        + "UNION SELECT NULL, NULL, s.name, tt.name, tt.type_table_object_id, CONVERT(bit, 0), CONVERT(bit, 1) FROM sys.all_columns AS c JOIN sys.table_types AS tt ON tt.type_table_object_id = c.object_id "
        + "JOIN sys.schemas AS s ON s.schema_id = tt.schema_id WHERE c.user_type_id = @object_id "
        + "UNION SELECT NULL, NULL, s.name, o.name, o.object_id, CONVERT(bit, 0), CONVERT(bit, 1) FROM sys.all_parameters AS pa JOIN sys.all_objects AS o ON o.object_id = pa.object_id "
        + "JOIN sys.schemas AS s ON s.schema_id = o.schema_id WHERE pa.user_type_id = @object_id";

    /// <summary>No rows, in <see cref="UsesRows"/>' columns: a type uses nothing Peek lists.</summary>
    private const string NoRows = "SELECT CONVERT(sysname, NULL) AS server_name, CONVERT(sysname, NULL) AS database_name, CONVERT(sysname, NULL) AS schema_name, "
        + "CONVERT(sysname, NULL) AS entity_name, CONVERT(int, NULL) AS id, CONVERT(bit, 0) AS via, CONVERT(bit, 0) AS bound WHERE @object_id IS NULL";

    /// <summary>One listing, at most @take rows in name order: server, database, schema, name, the type, whether a foreign key
    /// makes the link, then what the tree's listings read for a subtype (ExplorerQueries' Tables and views, the tools-support
    /// property as their system flag), each from its band; then whether the link is schema-bound and, for a trigger, its table's
    /// or view's schema, name and type, which name it in Object Explorer. The rows are grouped first, so an object whose
    /// references differ only in being schema-bound stays one row (schema-bound when any of them is).</summary>
    private static string Listing(string rows, SqlRender render) => "SELECT TOP (@take) x.server_name, x.database_name, x.schema_name, x.entity_name, o.type, x.via, "
        + render.Col(13, "t.temporal_type", "CONVERT(tinyint, 0)") + ", " + render.Col(16, "t.ledger_type", "CONVERT(tinyint, 0)") + ", "
        + render.Col(14, "t.is_node", "CONVERT(bit, 0)") + ", " + render.Col(14, "t.is_edge", "CONVERT(bit, 0)") + ", t.is_filetable, " + render.Col(13, "t.is_external", "CONVERT(bit, 0)") + ", "
        + render.Col(16, "t.is_dropped_ledger_table", "CONVERT(bit, 0)") + ", CONVERT(bit, CASE WHEN o.is_ms_shipped = 1 OR ep.major_id IS NOT NULL THEN 1 ELSE 0 END), "
        + render.Col(16, "v.ledger_view_type", "CONVERT(tinyint, 0)") + ", " + render.Col(16, "v.is_dropped_ledger_view", "CONVERT(bit, 0)") + ", x.bound, ps.name, po.name, po.type, "
        // A trigger's table's subtype, as for the row's own (Tables › Graph Tables, FileTables …), so the tree can walk to it.
        + render.Col(13, "pt.temporal_type", "CONVERT(tinyint, 0)") + ", " + render.Col(16, "pt.ledger_type", "CONVERT(tinyint, 0)") + ", "
        + render.Col(14, "pt.is_node", "CONVERT(bit, 0)") + ", " + render.Col(14, "pt.is_edge", "CONVERT(bit, 0)") + ", pt.is_filetable, " + render.Col(13, "pt.is_external", "CONVERT(bit, 0)") + ", "
        + render.Col(16, "pt.is_dropped_ledger_table", "CONVERT(bit, 0)") + ", CONVERT(bit, CASE WHEN po.is_ms_shipped = 1 OR pep.major_id IS NOT NULL THEN 1 ELSE 0 END) "
        + "FROM (SELECT r.server_name, r.database_name, r.schema_name, r.entity_name, r.id, r.via, CONVERT(bit, MAX(CONVERT(tinyint, r.bound))) AS bound FROM (" + rows + ") AS r "
        + "GROUP BY r.server_name, r.database_name, r.schema_name, r.entity_name, r.id, r.via) AS x "
        + "LEFT JOIN sys.all_objects AS o ON o.object_id = x.id LEFT JOIN sys.tables AS t ON t.object_id = x.id LEFT JOIN sys.all_views AS v ON v.object_id = x.id "
        + "LEFT JOIN sys.extended_properties AS ep ON ep.class = 1 AND ep.major_id = x.id AND ep.minor_id = 0 AND ep.name = N'microsoft_database_tools_support' "
        + "LEFT JOIN sys.all_objects AS po ON po.object_id = o.parent_object_id AND o.type IN ('TR', 'TA') LEFT JOIN sys.schemas AS ps ON ps.schema_id = po.schema_id "
        + "LEFT JOIN sys.tables AS pt ON pt.object_id = po.object_id "
        + "LEFT JOIN sys.extended_properties AS pep ON pep.class = 1 AND pep.major_id = po.object_id AND pep.minor_id = 0 AND pep.name = N'microsoft_database_tools_support' "
        + "ORDER BY x.server_name, x.database_name, x.schema_name, x.entity_name, x.via;\n";

    /// <summary>What the object uses, for the band.</summary>
    internal static string Uses(SqlRender render) => Listing(UsesRows, render);
    /// <summary>What uses the object, for the band.</summary>
    internal static string UsedBy(SqlRender render) => Listing(UsedByRows, render);

    /// <summary>The helper columns after a kind's facts, in order: a table's or index's count of compression settings, a module's
    /// EXECUTE AS principal name, the parts of a type's words, and a module kind's text (its first page), whole length and stamp.</summary>
    public static IReadOnlyList<string> Extras(PeekKindSpec spec) => [.. Kinds[spec.Kind].Helpers.Select(helper => helper.Column), .. spec.Module ? ModuleColumns : []];

    private static readonly string[] ModuleColumns = ["definition", "definitionLength", "definitionStamp"];
    // A binary collation without supplementary characters makes LEFT and SUBSTRING count UTF-16 code units, as JavaScript and
    // .NET strings do, whatever the database's collation; DATALENGTH halved is the same count.
    private const string ModuleText = "m.definition COLLATE Latin1_General_100_BIN2";
    private const string ModuleLength = "CONVERT(bigint, DATALENGTH(m.definition)) / 2";

    /// <summary>explorer.peekDefinition's batch for a module kind (and a trigger's parent kind): the peek's lookup, then one row of
    /// @take code units of the text from @offset, its whole length and the module's modify_date, from the kind's own FROM.</summary>
    public static string DefinitionPage(PeekKindSpec spec, string? parentKind = null)
    {
        if (!spec.Module || !Kinds.TryGetValue(spec.Kind, out var sql)) throw new InvalidOperationException("Peek reads no module text of " + spec.Kind + ".");
        return Lookup(spec.Kind, parentKind) + "SELECT SUBSTRING(" + ModuleText + ", @offset + 1, @take) AS [text], " + ModuleLength + " AS [length], o.modify_date AS [stamp] " + sql.From(new SqlRender(ExplorerCatalog.MinBand)) + ";\n";
    }

    /// <summary>The page after the lookup's row: null when the module is gone.</summary>
    public static async Task<PeekDefinitionResult?> ReadDefinitionPageAsync(SqlDataReader reader, int offset, CancellationToken token)
    {
        if (!await reader.ReadAsync(token)) return null;
        var length = reader.IsDBNull(1) ? 0 : reader.GetInt64(1);
        var stamp = Stamp(reader.GetDateTime(2));
        return new(reader.IsDBNull(0) ? null : Trim(reader.GetString(0), offset, length), length, stamp, 0);
    }

    /// <summary>A modify_date as the renderer compares it: milliseconds since 1970, which a JavaScript number holds exactly.</summary>
    internal static long Stamp(DateTime value) => new DateTimeOffset(DateTime.SpecifyKind(value, DateTimeKind.Utc)).ToUnixTimeMilliseconds();

    /// <summary>A page that started at <paramref name="offset"/> of a text <paramref name="length"/> long, without a high surrogate
    /// at its end when more text follows: the next page then starts with the whole pair.</summary>
    internal static string Trim(string page, int offset, long length) =>
        page.Length > 0 && offset + page.Length < length && char.IsHighSurrogate(page[^1]) ? page[..^1] : page;

    /// <summary>The kind's batch for the band (and an index's or trigger's parent kind), on a cloud server or not. Facts newer than
    /// the band are left out of the text and the reply.</summary>
    public static Batch Render(PeekKindSpec spec, SqlRender render, int definitionPageChars, string? parentKind = null, bool cloud = false)
    {
        if (!Kinds.TryGetValue(spec.Kind, out var sql)) throw new InvalidOperationException("Peek has no batch for " + spec.Kind + ".");
        var facts = spec.FactsFor(render.Band);
        var columns = new List<(string Column, string Expression)>();
        foreach (var fact in facts.Where(fact => !fact.Optional))
            columns.Add((fact.Id, sql.Facts.GetValueOrDefault(fact.Id) ?? Common.GetValueOrDefault(fact.Id) ?? throw new InvalidOperationException("Peek has no column for " + spec.Kind + "." + fact.Id + ".")));
        columns.AddRange(sql.Helpers);
        // The first page of the text, with its whole length and stamp: a longer text comes in pages (DefinitionPage).
        if (spec.Module)
        {
            columns.Add(("definition", "LEFT(" + ModuleText + ", " + definitionPageChars.ToString(CultureInfo.InvariantCulture) + ")"));
            columns.Add(("definitionLength", ModuleLength));
            columns.Add(("definitionStamp", "o.modify_date"));
        }
        var text = new StringBuilder(Lookup(spec.Kind, parentKind, render.Band)).Append("SELECT ");
        text.AppendJoin(", ", columns.Select(column => column.Expression + " AS [" + column.Column + "]"));
        text.Append(' ').Append(cloud && spec.Kind == "database" ? CloudDatabaseFrom : sql.From(render)).Append(";\n");
        var lists = new List<ListBatch>();
        var mapping = false;
        foreach (var list in spec.ListSpecs)
        {
            if (list.Id == "userMapping") { text.Append(MappingDatabases); mapping = true; continue; }
            if (!Lists.TryGetValue(list.Id, out var statement)) throw new InvalidOperationException("Peek has no statement for the list " + list.Id + ".");
            text.Append(cloud && list.Id == "files" ? CloudFiles : statement.Text(spec.Kind, render));
            lists.Add(new(list.Id, statement.Columns, statement.DetailColumns));
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
    /// the codes SSMS words, the module text's first page, with its length and stamp when the text is longer), each list up to the catalogue's rows, User mapping's
    /// databases (returned apart for the service to read), and the optional group, or its refusal. Null when the row is gone.</summary>
    public static async Task<(PeekResult Result, MappingList Mapping)?> ReadAsync(SqlDataReader reader, PeekKindSpec spec, Batch batch, int band, CatalogPeek limits, CancellationToken token)
    {
        if (!await reader.ReadAsync(token)) return null;
        var raw = Raw(reader, batch.Columns);
        var facts = new Dictionary<string, object?>(StringComparer.Ordinal);
        var bandFacts = spec.FactsFor(band);
        foreach (var fact in bandFacts.Where(fact => !fact.Optional)) facts[fact.Id] = Value(fact, raw);
        string? definition = null;
        long? definitionLength = null;
        long? definitionStamp = null;
        if (spec.Module && raw["definition"] is string text)
        {
            var length = Convert.ToInt64(raw["definitionLength"], CultureInfo.InvariantCulture);
            definition = Trim(text, 0, length);
            if (definition.Length < length)
            {
                definitionLength = length;
                definitionStamp = Stamp((DateTime)raw["definitionStamp"]!);
            }
        }
        Dictionary<string, PeekList>? lists = spec.ListSpecs.Count > 0 ? new(StringComparer.Ordinal) : null;
        // A T-SQL module's parameter defaults are only in its header, which the text's first page holds.
        var defaults = batch.Lists.Any(list => list.Id == "parameters") ? ModuleHeader.ParameterDefaultTexts(definition) : null;
        foreach (var list in batch.Lists)
        {
            if (!await reader.NextResultAsync(token)) throw new InvalidOperationException("Peek's batch ended before its list " + list.Id + ".");
            if (list.DetailColumns is { } detailColumns)
            {
                var rawRows = new List<Dictionary<string, object?>>();
                var moreDetails = false;
                while (await reader.ReadAsync(token))
                {
                    if (rawRows.Count == limits.ListRows) { moreDetails = true; break; }
                    rawRows.Add(Raw(reader, list.Columns));
                }
                if (!await reader.NextResultAsync(token)) throw new InvalidOperationException("Peek's batch ended before its list details " + list.Id + ".");
                var details = await ReadTableObjectDetailsAsync(reader, detailColumns, token);
                lists![list.Id] = TableObjectList(rawRows, moreDetails, details);
                continue;
            }
            var rows = new List<object?[]>();
            var more = false;
            while (await reader.ReadAsync(token))
            {
                if (rows.Count == limits.ListRows) { more = true; break; }
                rows.Add(ListRow(list.Id, Raw(reader, list.Columns), defaults));
            }
            lists![list.Id] = new(rows, more ? true : null);
        }
        var databases = new List<string>();
        var total = 0;
        if (batch.Mapping)
        {
            if (!await reader.NextResultAsync(token)) throw new InvalidOperationException("Peek's batch ended before User mapping's databases.");
            while (await reader.ReadAsync(token))
            {
                databases.Add(reader.GetString(0));
                total = reader.GetInt32(1);
            }
        }
        List<string>? refused = null;
        if (batch.Optional.Count > 0)
        {
            // A statement that fails in TRY after sending its columns leaves an empty result before CATCH's row.
            var found = false;
            while (!found && await reader.NextResultAsync(token)) found = await reader.ReadAsync(token);
            if (!found) throw new InvalidOperationException("Peek's batch ended before its optional group.");
            if (reader.FieldCount == 1 && reader.GetName(0) == Refused) refused = [spec.OptionalGroup ?? throw new InvalidOperationException("Peek's " + spec.Kind + " names no optional group.")];
            else
            {
                var optional = Raw(reader, batch.Optional);
                foreach (var fact in bandFacts.Where(fact => fact.Optional)) facts[fact.Id] = Value(fact, optional);
            }
        }
        return (new(facts, 0, definition, definitionLength, definitionStamp, Lists: lists, Refused: refused), new(databases, Math.Max(total, databases.Count)));
    }

    private static Dictionary<string, object?> Raw(SqlDataReader reader, IReadOnlyList<string> columns)
    {
        var raw = new Dictionary<string, object?>(columns.Count, StringComparer.Ordinal);
        for (var index = 0; index < columns.Count; index++) raw[columns[index]] = reader.IsDBNull(index) ? null : reader.GetValue(index);
        return raw;
    }

    /// <summary>A list's row as the catalogue's columns, in order: a column's or parameter's facts and its declaration, an index
    /// column's type as the tree writes it, a file's autogrowth in SSMS's words. <paramref name="defaults"/>: a T-SQL module's
    /// parameter defaults, from its header.</summary>
    internal static object?[] ListRow(string list, Dictionary<string, object?> raw, IReadOnlyDictionary<string, string>? defaults = null) => list switch
    {
        "columns" => ColumnRow(raw),
        "parameters" => ParameterRow(raw, defaults),
        "indexColumns" => [raw["name"], Bool(raw["included"]), Bool(raw["descending"]), raw["type"] is string type
            ? ExplorerLabels.TypeText(new SqlTypeInfo(type, Int(raw["maxLength"]), Int(raw["precision"]), Int(raw["scale"]), IsUserDefined: Bool(raw["userDefined"]) == true)) : null],
        "keyColumns" => [raw["name"], raw["referencedColumn"], Bool(raw["descending"]), raw["type"] is string keyType
            ? ExplorerLabels.TypeText(new SqlTypeInfo(keyType, Int(raw["maxLength"]), Int(raw["precision"]), Int(raw["scale"]), IsUserDefined: Bool(raw["userDefined"]) == true)) : null],
        "events" => [raw["event"], Bool(raw["first"]), Bool(raw["last"])],
        "files" => [raw["name"], raw["type"], raw["size"] is null ? null : Convert.ToInt64(raw["size"], CultureInfo.InvariantCulture),
            Growth(Int(raw["growth"]), Bool(raw["percentGrowth"]) == true, Int(raw["maxSize"])), raw["path"]],
        "serverRoles" => [raw["role"], Bool(raw["fixed"])],
        _ => throw new InvalidOperationException("Peek reads no list " + list + ".")
    };

    /// <summary>The detail rows read beside a table's <c>tableObjects</c> list: index key/included columns, foreign-key column
    /// pairs and trigger events. <see cref="Cut"/> is the owner (detail kind and owner id) whose rows the cap stopped in, when it
    /// stopped, and whether the first row left unread was an included column.</summary>
    internal sealed class TableObjectDetails
    {
        public Dictionary<int, List<(string Name, bool Included, bool Descending)>> IndexColumns { get; } = [];
        public Dictionary<int, List<(string Column, string? ReferencedColumn)>> ForeignKeyColumns { get; } = [];
        public Dictionary<int, List<string>> TriggerEvents { get; } = [];
        public (string Kind, int OwnerId, bool Included)? Cut { get; set; }

        /// <summary>Whether an owner's details may be missing rows: the cap stopped in this owner, or stopped before any of its
        /// rows came (rows come in kind group then owner order, so an owner with no rows after a cut was never reached).</summary>
        public bool Incomplete(string kind, int ownerId, bool anyRead) => Cut is { } cut && ((cut.Kind == kind && cut.OwnerId == ownerId) || !anyRead);
    }

    /// <summary>The <c>tableObjects</c> list: truncated only when objects were left out. Details the cap cut mark the summaries
    /// they cut short instead (<see cref="Incomplete"/>), since every object's row is still there.</summary>
    internal static PeekList TableObjectList(IEnumerable<Dictionary<string, object?>> rawRows, bool moreObjects, TableObjectDetails details) =>
        new([.. rawRows.Select(row => TableObjectRow(row, details))], moreObjects ? true : null);

    private static async Task<TableObjectDetails> ReadTableObjectDetailsAsync(SqlDataReader reader, IReadOnlyList<string> columns, CancellationToken token)
    {
        var details = new TableObjectDetails();
        var count = 0;
        while (await reader.ReadAsync(token) && AddTableObjectDetail(details, Raw(reader, columns), count++)) { }
        return details;
    }

    /// <summary>Adds the detail row at position <paramref name="read"/> (counted from 0) to <paramref name="details"/>, or, for
    /// the row past <see cref="TableObjectDetailCap"/>, records the owner the cut landed in (its earlier rows, if any, were read)
    /// and whether the cut came at an included column; false then, to stop reading.</summary>
    internal static bool AddTableObjectDetail(TableObjectDetails details, Dictionary<string, object?> raw, int read)
    {
        var kind = (raw["detailKind"] as string)?.TrimEnd();
        var ownerId = Int(raw["ownerId"]);
        if (read >= TableObjectDetailCap) { details.Cut = (kind ?? "", ownerId, Bool(raw.GetValueOrDefault("included")) == true); return false; }
        if (raw["colName"] is not string colName) return true;
        switch (kind)
        {
            case "IC":
                if (!details.IndexColumns.TryGetValue(ownerId, out var idxCols)) details.IndexColumns[ownerId] = idxCols = [];
                idxCols.Add((colName, Bool(raw["included"]) == true, Bool(raw["descending"]) == true));
                break;
            case "FK":
                if (!details.ForeignKeyColumns.TryGetValue(ownerId, out var fkCols)) details.ForeignKeyColumns[ownerId] = fkCols = [];
                fkCols.Add((colName, raw["refColName"] as string));
                break;
            case "TE":
                if (!details.TriggerEvents.TryGetValue(ownerId, out var events)) details.TriggerEvents[ownerId] = events = [];
                events.Add(colName);
                break;
        }
        return true;
    }

    /// <summary>One row of a table's <c>tableObjects</c> list: Kind, Name, Summary (names bracketed as scripts write them; a list
    /// the detail cap cut short ends in <see cref="Incomplete"/>) and Status.</summary>
    internal static object?[] TableObjectRow(Dictionary<string, object?> raw, TableObjectDetails? details = null)
    {
        var kindCode = (raw["kindCode"] as string)?.TrimEnd();
        var name = raw["name"] as string;
        var disabled = Bool(raw.GetValueOrDefault("disabled")) == true;
        var notTrusted = Bool(raw.GetValueOrDefault("notTrusted")) == true;
        string? kind, summary, status;
        switch (kindCode)
        {
            case "PK" or "UQ":
                kind = kindCode == "PK" ? "Primary key" : "Unique constraint";
                var keyType = raw.GetValueOrDefault("indexType") is not null ? IndexType(Int(raw["indexType"]), false) : null;
                var keyIndex = raw.GetValueOrDefault("indexId") is not null ? Int(raw["indexId"]) : (int?)null;
                var kCols = keyIndex is { } kId && details?.IndexColumns.TryGetValue(kId, out var kFound) == true ? kFound : null;
                var keyCols = ColumnList(kCols?.Where(c => !c.Included).Select(c => KeyColumn(c.Name, c.Descending)),
                    keyIndex is { } kOwner && details?.Incomplete("IC", kOwner, kCols is not null) == true);
                summary = keyType is not null && keyCols.Length > 0 ? keyType + " (" + keyCols + ")" : keyCols.Length > 0 ? "(" + keyCols + ")" : keyType;
                status = disabled ? "Disabled" : "Active";
                break;
            case "F":
                kind = "Foreign key";
                var fkId = raw.GetValueOrDefault("objectId") is not null ? Int(raw["objectId"]) : (int?)null;
                var fkCols = fkId is { } fId && details?.ForeignKeyColumns.TryGetValue(fId, out var fCols) == true ? fCols : null;
                var fkIncomplete = fkId is { } fOwner && details?.Incomplete("FK", fOwner, fkCols is not null) == true;
                var parentCols = ColumnList(fkCols?.Select(c => Bracket(c.Column)), fkIncomplete);
                var refCols = fkCols is { Count: > 0 } && fkCols.All(c => c.ReferencedColumn is not null)
                    ? ColumnList(fkCols.Select(c => Bracket(c.ReferencedColumn!)), fkIncomplete) : "";
                var refTable = raw.GetValueOrDefault("refTable") is string refName
                    ? (raw.GetValueOrDefault("refSchema") is string refSchema ? Bracket(refSchema) + "." : "") + Bracket(refName) : null;
                summary = refTable is not null
                    ? (parentCols.Length > 0 ? "(" + parentCols + ") \u2192 " : "\u2192 ") + refTable + (refCols.Length > 0 ? " (" + refCols + ")" : "")
                    : parentCols.Length > 0 ? "(" + parentCols + ")" : null;
                status = disabled ? "Disabled" : notTrusted ? "Not trusted" : "Trusted";
                break;
            case "IX":
                kind = "Index";
                var idxTypeCode = Int(raw.GetValueOrDefault("indexType"));
                var idxType = IndexType(idxTypeCode, Bool(raw.GetValueOrDefault("primaryXml")) == true);
                var prefix = Bool(raw.GetValueOrDefault("isUnique")) == true && idxType.Length > 0 ? "Unique " + char.ToLowerInvariant(idxType[0]) + idxType[1..] : idxType;
                var idxId = raw.GetValueOrDefault("indexId") is not null ? Int(raw["indexId"]) : (int?)null;
                var allCols = idxId is { } iId && details?.IndexColumns.TryGetValue(iId, out var iCols) == true ? iCols : null;
                var idxIncomplete = idxId is { } iOwner && details?.Incomplete("IC", iOwner, allCols is not null) == true;
                var filter = raw.GetValueOrDefault("filter") as string;
                var text = new StringBuilder(prefix);
                // Columnstore indexes store their columns with is_included_column = 1 in sys.index_columns: a clustered
                // columnstore covers every column (no column list), while a nonclustered columnstore lists its columns without INCLUDE.
                if (idxTypeCode == 6)
                {
                    var csCols = ColumnList(allCols?.Select(c => Bracket(c.Name)), idxIncomplete);
                    if (csCols.Length > 0) text.Append(" (").Append(csCols).Append(')');
                }
                else if (idxTypeCode != 5)
                {
                    // Key columns come before included ones: a cut at or after an included column leaves the keys whole and
                    // INCLUDE short, while one in the keys leaves the INCLUDE list unknown.
                    var cutInInclude = idxIncomplete && (allCols?.Any(c => c.Included) == true
                        || details?.Cut is { Kind: "IC", Included: true } cutRow && cutRow.OwnerId == idxId);
                    var idxKeyCols = ColumnList(allCols?.Where(c => !c.Included).Select(c => KeyColumn(c.Name, c.Descending)), idxIncomplete && !cutInInclude);
                    var incCols = ColumnList(allCols?.Where(c => c.Included).Select(c => Bracket(c.Name)), cutInInclude);
                    if (idxKeyCols.Length > 0) text.Append(" (").Append(idxKeyCols).Append(')');
                    if (incCols.Length > 0) text.Append(" INCLUDE (").Append(incCols).Append(')');
                }
                if (filter is not null) text.Append(" WHERE ").Append(filter);
                summary = text.ToString();
                status = disabled ? "Disabled" : "Active";
                break;
            case "C":
                kind = "Check constraint";
                summary = raw.GetValueOrDefault("expr") as string;
                status = disabled ? "Disabled" : notTrusted ? "Not trusted" : "Trusted";
                break;
            case "D":
                kind = "Default constraint";
                var expr = raw.GetValueOrDefault("expr") as string;
                var colName = raw.GetValueOrDefault("colName") as string;
                summary = colName is not null && expr is not null ? Bracket(colName) + " = " + expr : expr ?? (colName is null ? null : Bracket(colName));
                status = "Active";
                break;
            case "EC":
                kind = "Edge constraint";
                summary = string.Equals(raw.GetValueOrDefault("deleteAction") as string, "CASCADE", StringComparison.OrdinalIgnoreCase) ? "ON DELETE CASCADE" : null;
                status = disabled ? "Disabled" : notTrusted ? "Not trusted" : "Trusted";
                break;
            case "TR":
                kind = "Trigger";
                var timing = Bool(raw.GetValueOrDefault("insteadOf")) == true ? "INSTEAD OF" : "AFTER";
                var trId = raw.GetValueOrDefault("objectId") is not null ? Int(raw["objectId"]) : (int?)null;
                var events = trId is { } tId && details?.TriggerEvents.TryGetValue(tId, out var evs) == true ? evs : null;
                var eventList = ColumnList(events, trId is { } tOwner && details?.Incomplete("TE", tOwner, events is not null) == true);
                summary = eventList.Length > 0 ? timing + " " + eventList : timing;
                status = disabled ? "Disabled" : "Active";
                break;
            default:
                kind = kindCode;
                summary = null;
                status = null;
                break;
        }
        return [kind, name, ClipExpression(summary), status];
    }

    /// <summary>Ends a summary list the detail cap cut short.</summary>
    internal const string Incomplete = "…";

    /// <summary>A summary's comma-separated list, ending in <see cref="Incomplete"/> when the detail cap cut it short.</summary>
    private static string ColumnList(IEnumerable<string>? items, bool incomplete)
    {
        var text = items is null ? "" : string.Join(", ", items);
        return !incomplete ? text : text.Length > 0 ? text + ", " + Incomplete : Incomplete;
    }

    private static string KeyColumn(string name, bool descending) => descending ? Bracket(name) + " DESC" : Bracket(name);

    internal const int MaxExpressionChars = 4000;

    /// <summary>Clips a constraint or summary expression past <see cref="MaxExpressionChars"/> characters without splitting a
    /// UTF-16 surrogate pair so facts and list cells stay bounded.</summary>
    internal static string? ClipExpression(string? text)
    {
        if (text is not { Length: > MaxExpressionChars }) return text;
        var cut = char.IsHighSurrogate(text[MaxExpressionChars - 1]) ? MaxExpressionChars - 1 : MaxExpressionChars;
        return text[..cut] + "\u2026";
    }

    /// <summary>A column's Name, Type (as the tree writes it), Nullable, Key, Identity (seed and increment), Computed (its
    /// expression), Default (its expression) and Definition, its declaration (<see cref="ColumnDefinition"/>).</summary>
    private static object?[] ColumnRow(Dictionary<string, object?> raw)
    {
        bool primaryKey = Bool(raw["primaryKey"]) == true, foreignKey = Bool(raw["foreignKey"]) == true, identity = Bool(raw["identity"]) == true;
        var key = primaryKey && foreignKey ? "PK, FK" : primaryKey ? "PK" : foreignKey ? "FK" : null;
        string? seed = identity ? Number(raw["seed"]) : null, increment = identity ? Number(raw["increment"]) : null;
        var computed = Bool(raw["computed"]) == true ? raw["computedText"] as string : null;
        var defaultText = raw["defaultText"] as string;
        return [raw["name"], ExplorerLabels.TypeText(TypeOf(raw, tableType: false)), Bool(raw["nullable"]), key, seed is null || increment is null ? null : seed + ", " + increment,
            computed, defaultText, ColumnDefinition(raw, seed, increment, computed, defaultText)];
    }

    /// <summary>A column's declaration as CREATE TABLE writes it, <c>[OrderDate] datetime2(3) NOT NULL DEFAULT (sysutcdatetime())</c>:
    /// the name through QUOTENAME, the type as Script As writes it (sizes, max, user types schema-qualified, an XML column's schema
    /// collection), FILESTREAM, COLLATE only where it is not the database's, SPARSE, IDENTITY(seed,increment) [NOT FOR REPLICATION], a period column's GENERATED
    /// ALWAYS (and a ledger column's) and HIDDEN, MASKED WITH its masking function, ROWGUIDCOL, NULL or NOT NULL, and the default without its constraint's name; a computed column as
    /// <c>AS (expression)</c> with PERSISTED; a column set as XML COLUMN_SET FOR ALL_SPARSE_COLUMNS. Constraints over columns
    /// (keys, checks) are left to Script As.</summary>
    internal static string ColumnDefinition(Dictionary<string, object?> raw, string? seed, string? increment, string? computed, string? defaultText)
    {
        var text = new StringBuilder(raw["quotedName"] as string ?? Bracket((string)raw["name"]!));
        var nullable = Bool(raw["nullable"]) != false;
        if (computed is not null)
        {
            text.Append(" AS ").Append(computed);
            // Only a persisted computed column can be NOT NULL; sys.columns reports the others nullable.
            if (Bool(raw["persisted"]) == true) text.Append(nullable ? " PERSISTED" : " PERSISTED NOT NULL");
            return text.ToString();
        }
        text.Append(' ').Append(TypeSql(raw, cursor: false));
        if (Bool(raw["columnSet"]) == true) return text.Append(" COLUMN_SET FOR ALL_SPARSE_COLUMNS").ToString();
        if (Bool(raw.GetValueOrDefault("filestream")) == true) text.Append(" FILESTREAM");
        if (raw["collation"] is string collation) text.Append(" COLLATE ").Append(collation);
        if (Bool(raw["sparse"]) == true) text.Append(" SPARSE");
        // sys.masked_columns keeps the function as a literal holds it, its quotes already doubled: partial(1, "X''X", 0).
        if (raw.GetValueOrDefault("mask") is string mask) text.Append(" MASKED WITH (FUNCTION = N'").Append(mask).Append("')");
        if (seed is not null && increment is not null)
            text.Append(" IDENTITY(").Append(seed).Append(',').Append(increment).Append(')').Append(Bool(raw.GetValueOrDefault("notForReplication")) == true ? " NOT FOR REPLICATION" : "");
        var generated = Int(raw["generated"]);
        if (Generated(generated) is { } always) text.Append(" GENERATED ALWAYS AS ").Append(always).Append(Bool(raw["hidden"]) == true ? " HIDDEN" : "");
        if (Bool(raw["rowGuid"]) == true) text.Append(" ROWGUIDCOL");
        text.Append(nullable ? " NULL" : " NOT NULL");
        if (defaultText is not null) text.Append(" DEFAULT ").Append(defaultText);
        return text.ToString();
    }

    /// <summary>What a generated column is generated as, by sys.columns' generated_always_type: a period column's row start or
    /// end (2016), or a ledger table's transaction id or sequence number (2022).</summary>
    private static string? Generated(int type) => type switch
    {
        1 => "ROW START", 2 => "ROW END", 5 => "TRANSACTION_ID START", 6 => "TRANSACTION_ID END", 7 => "SEQUENCE_NUMBER START", 8 => "SEQUENCE_NUMBER END", _ => null
    };

    /// <summary>An identity's seed or increment, which the batch reads as text: a numeric(38) one can pass System.Decimal's range.</summary>
    private static string? Number(object? value) => value is string text ? text : Literal(value);

    private static readonly string[] ClrModules = ["PC", "FS", "FT", "AF"];

    /// <summary>A parameter's Name, Type (as the tree writes it), Direction (in the tree's words), Default (as written) and
    /// Definition, <c>@OrderId int = 0 OUTPUT</c> (a table-valued one READONLY, a cursor CURSOR VARYING OUTPUT). A T-SQL module's
    /// defaults come from its header (<paramref name="defaults"/>, none when its text is encrypted or unreadable), a CLR module's
    /// from sys.parameters.</summary>
    private static object?[] ParameterRow(Dictionary<string, object?> raw, IReadOnlyDictionary<string, string>? defaults)
    {
        var name = (string)raw["name"]!;
        bool cursor = Bool(raw["cursor"]) == true, output = Bool(raw["output"]) == true;
        var clr = raw["moduleType"] is string type && ClrModules.Contains(type.TrimEnd());
        var defaultText = clr ? (Bool(raw["hasDefault"]) == true ? Literal(raw["defaultValue"]) ?? "NULL" : null) : defaults?.GetValueOrDefault(name);
        var definition = new StringBuilder(name).Append(' ').Append(TypeSql(raw, cursor));
        // Only a natively compiled module's parameters can be NOT NULL; sys.parameters reports every other one nullable.
        if (Bool(raw.GetValueOrDefault("nullable")) == false && !cursor && Bool(raw["readOnly"]) != true) definition.Append(" NOT NULL");
        if (defaultText is not null) definition.Append(" = ").Append(defaultText);
        if (output) definition.Append(" OUTPUT");
        if (Bool(raw["readOnly"]) == true) definition.Append(" READONLY");
        return [name, cursor ? "cursor" : ExplorerLabels.TypeText(TypeOf(raw, tableType: Bool(raw.GetValueOrDefault("tableType")) == true)), output ? "Input/Output" : "Input", defaultText,
            definition.ToString()];
    }

    /// <summary>The type as the tree's labels read it, from a list row's parts.</summary>
    private static SqlTypeInfo TypeOf(Dictionary<string, object?> raw, bool tableType) => new((string)raw["type"]!, Int(raw["maxLength"]), Int(raw["precision"]), Int(raw["scale"]),
        Bool(raw["userDefined"]) == true, Bool(raw["assemblyType"]) == true, tableType, raw["baseType"] as string, Bool(raw["xmlDocument"]) == true, raw["xmlSchema"] as string,
        raw["xmlCollection"] as string, raw.GetValueOrDefault("vectorDimensions") is null ? null : Int(raw["vectorDimensions"]), raw.GetValueOrDefault("typeSchema") as string);

    /// <summary>The type as a declaration writes it (Script As's text): a user type by its quoted schema and name, a system type by
    /// its name and sizes, an XML column's or parameter's schema collection with CONTENT or DOCUMENT, a cursor CURSOR VARYING.</summary>
    internal static string TypeSql(Dictionary<string, object?> raw, bool cursor)
    {
        if (cursor) return "CURSOR VARYING";
        var name = (string)raw["type"]!;
        if (Bool(raw["userDefined"]) == true) return (raw["quotedTypeSchema"] as string ?? "[dbo]") + "." + (raw["quotedType"] as string ?? Bracket(name));
        if (name == "xml" && raw["quotedXmlCollection"] is string collection)
            return "xml(" + (Bool(raw["xmlDocument"]) == true ? "DOCUMENT " : "CONTENT ") + (raw["quotedXmlSchema"] as string ?? "[dbo]") + "." + collection + ")";
        return ExplorerLabels.TypeText(new SqlTypeInfo(name, Int(raw["maxLength"]), Int(raw["precision"]), Int(raw["scale"]),
            VectorDimensions: raw.GetValueOrDefault("vectorDimensions") is null ? null : Int(raw["vectorDimensions"])));
    }

    /// <summary>A name in brackets as QUOTENAME writes it, only for one QUOTENAME did not take (never a sysname).</summary>
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";

    /// <summary>A catalog value (an identity's seed, a CLR parameter's default) as a T-SQL literal: numbers in invariant digits,
    /// text as N'…' with its quotes doubled, a date as ISO text, binary as 0x…; null for NULL.</summary>
    internal static string? Literal(object? value) => value switch
    {
        null or DBNull => null,
        string text => "N'" + text.Replace("'", "''", StringComparison.Ordinal) + "'",
        bool flag => flag ? "1" : "0",
        byte[] bytes => "0x" + Convert.ToHexString(bytes),
        DateTime date => "'" + date.ToString("yyyy-MM-ddTHH:mm:ss.FFFFFFF", CultureInfo.InvariantCulture) + "'",
        DateTimeOffset date => "'" + date.ToString("yyyy-MM-ddTHH:mm:ss.FFFFFFFzzz", CultureInfo.InvariantCulture) + "'",
        Guid guid => "'" + guid.ToString("D") + "'",
        TimeSpan time => "'" + time.ToString("c", CultureInfo.InvariantCulture) + "'",
        IFormattable number => number.ToString(null, CultureInfo.InvariantCulture),
        _ => "N'" + (value.ToString() ?? "").Replace("'", "''", StringComparison.Ordinal) + "'"
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
    public static string Dependencies(string kind, SqlRender render, string? parentKind = null) => Lookup(kind, parentKind, render.Band) + UsesOf(kind, render) + UsedByOf(kind, render);

    /// <summary>explorer.dependencies' batch (View Dependencies, one level of its tree): the object found as its peek finds it, then
    /// one of Peek's two listings, the same text the Dependencies tab reads.</summary>
    public static string Level(string kind, SqlRender render, string? parentKind, bool usedBy) => Lookup(kind, parentKind, render.Band) + (usedBy ? UsedByOf(kind, render) : UsesOf(kind, render));

    private static string UsesOf(string kind, SqlRender render) => kind switch
    {
        "synonym" => Listing(SynonymUsesRows, render),
        "type" or "tableType" => Listing(NoRows, render),
        _ => Uses(render)
    };

    private static string UsedByOf(string kind, SqlRender render) => kind is "type" or "tableType" ? Listing(TypeUsedByRows, render) : UsedBy(render);

    /// <summary>The two dependency listings (the reader is on the first): at most <paramref name="max"/> each, marked truncated
    /// when the batch's TOP (@take), one more, found another.</summary>
    public static async Task<PeekDependenciesResult> ReadDependenciesAsync(SqlDataReader reader, int max, CancellationToken token)
    {
        var (uses, usesCut) = await ListingAsync(reader, max, token);
        var (usedBy, usedByCut) = await reader.NextResultAsync(token) ? await ListingAsync(reader, max, token) : ([], false);
        return new(uses, usedBy, 0, usesCut ? true : null, usedByCut ? true : null);
    }

    /// <summary>explorer.dependencies' one listing (the reader is on it): at most <paramref name="max"/>, marked truncated when there
    /// was another.</summary>
    public static async Task<DependenciesResult> ReadLevelAsync(SqlDataReader reader, int max, CancellationToken token)
    {
        var (items, cut) = await ListingAsync(reader, max, token);
        return new(items, 0, cut ? true : null);
    }

    private static async Task<(List<PeekDependency> Items, bool Cut)> ListingAsync(SqlDataReader reader, int max, CancellationToken token)
    {
        var items = new List<PeekDependency>();
        while (await reader.ReadAsync(token))
        {
            if (items.Count == max) return (items, true);
            var type = Text(reader, 4)?.TrimEnd();
            // A DML trigger is named below its table or view, which the row gives; one without them stays a leaf.
            var trigger = type is "TR" or "TA";
            var parent = trigger && Text(reader, 17) is { } parentSchema && Text(reader, 18) is { } parentName && ParentKindOf(Text(reader, 19)) is { } parentKind
                ? new ParentRefDto(parentKind, parentSchema, parentName) : null;
            var kind = trigger ? parent is null ? null : "trigger" : KindOf(type);
            var parentSubtype = parent?.Kind == "table" ? ExplorerLabels.TableSubtype(Number(reader, 20), Number(reader, 21), Flag(reader, 22), Flag(reader, 23), Flag(reader, 24), Flag(reader, 25), Flag(reader, 26), Flag(reader, 27)) : null;
            items.Add(new(reader.GetString(3), Text(reader, 2), Text(reader, 1), Text(reader, 0), kind, reader.GetBoolean(5) ? true : null,
                SubtypeOf(kind, type, Number(reader, 6), Number(reader, 7), Flag(reader, 8), Flag(reader, 9), Flag(reader, 10), Flag(reader, 11), Flag(reader, 12), Flag(reader, 13),
                    Number(reader, 14), Flag(reader, 15)), type, Flag(reader, 16) ? true : null, parent, parentSubtype));
        }
        return (items, false);
    }

    /// <summary>The Object Explorer kind of a trigger's parent object type.</summary>
    internal static string? ParentKindOf(string? type) => type?.TrimEnd() switch
    {
        "U" or "ET" => "table",
        "V" => "view",
        _ => null
    };

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
        "TT" => "tableType",
        _ => null
    };

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
            case "keyType" or "constraintType": return value is string typeDesc ? ConstraintType(typeDesc) : null;
            case "cache": return value is null ? null : CacheWord(Convert.ToBoolean(value, CultureInfo.InvariantCulture), raw.GetValueOrDefault("cacheSize") is { } size ? Convert.ToInt32(size, CultureInfo.InvariantCulture) : null);
            case "dataType" when value is string name: return name is "decimal" or "numeric" ? name + "(" + Int(raw.GetValueOrDefault("typePrecision")).ToString(CultureInfo.InvariantCulture) + ", 0)" : name;
            case "baseType": return value is string baseName ? ExplorerLabels.TypeText(new SqlTypeInfo(baseName, Int(raw.GetValueOrDefault("maxLength")), Int(raw.GetValueOrDefault("typePrecision")),
                Int(raw.GetValueOrDefault("typeScale")))) : null;
            case "default": return Qualified(raw.GetValueOrDefault("defaultSchema") as string, value as string);
            case "rule": return Qualified(raw.GetValueOrDefault("ruleSchema") as string, value as string);
            case "parentTable": return Qualified(raw.GetValueOrDefault("parentSchema") as string, value as string);
            case "referencedTable": return Qualified(raw.GetValueOrDefault("referencedSchema") as string, value as string);
            case "expression": return ClipExpression(value as string);
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

    /// <summary>A key's or constraint's type_desc in the words the Indexes &amp; keys list uses for its kind.</summary>
    internal static string ConstraintType(string typeDesc) => typeDesc.TrimEnd() switch
    {
        "PRIMARY_KEY_CONSTRAINT" => "Primary key",
        "UNIQUE_CONSTRAINT" => "Unique constraint",
        "FOREIGN_KEY_CONSTRAINT" => "Foreign key",
        "CHECK_CONSTRAINT" => "Check constraint",
        "DEFAULT_CONSTRAINT" => "Default constraint",
        "EDGE_CONSTRAINT" => "Edge constraint",
        var other => other
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
