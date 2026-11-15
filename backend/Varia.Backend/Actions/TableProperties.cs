using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>Table Properties' reads: the database as master sees it (<see cref="Master"/>), then, inside the database through
/// ActionSql.ModuleCall, the table found by @schema and @name (Peek's lookup and its table expressions, so both say the same of a
/// table) with its lists (<see cref="Inside"/>), and the preflight Apply and Script share (<see cref="Preflight"/>), which the
/// transaction's first step runs again. Constant text per band; names reach SQL Server only as parameters; each list reads one row
/// more than the catalogue shows, which sets its truncation flag.</summary>
internal static class TableProperties
{
    /// <summary>In master, by @name: the database's state, whether this login can open it, whether it is read-only, and whether it
    /// tracks changes (sys.change_tracking_databases).</summary>
    public const string Master = "SELECT d.database_id AS database_id, d.state AS state, d.state_desc AS state_desc, " + ActionSql.ReadOnlyFact + " AS read_only, "
        + "CONVERT(bit, ISNULL(CASE WHEN d.user_access = 1 THEN 1 ELSE HAS_DBACCESS(d.name) END, 0)) AS has_access, "
        + "CONVERT(bit, CASE WHEN ct.database_id IS NULL THEN 0 ELSE 1 END) AS tracking "
        + "FROM sys.databases AS d LEFT JOIN sys.change_tracking_databases AS ct ON ct.database_id = d.database_id WHERE d.name = @name;";

    /// <summary>Peek's table lookup over ModuleCall's parameters: @object_id, one bit row, and the end of the batch when it is gone.</summary>
    private const string Lookup = "DECLARE @object_schema sysname = @schema, @object_name sysname = @name;\n";

    private const string Tracking = "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.change_tracking_tables AS ctt WHERE ctt.object_id = o.object_id) THEN 1 ELSE 0 END) AS tracking, "
        + "CONVERT(bit, ISNULL((SELECT ctt.is_track_columns_updated_on FROM sys.change_tracking_tables AS ctt WHERE ctt.object_id = o.object_id), 0)) AS track_columns, "
        + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.indexes AS pk WHERE pk.object_id = o.object_id AND pk.is_primary_key = 1) THEN 1 ELSE 0 END) AS primary_key";

    /// <summary>The kinds of table the menu's subtypes name, as ActionSql.Object reads them.</summary>
    private static string Kinds(SqlRender render) =>
        render.Col(13, "t.temporal_type", "CONVERT(tinyint, 0)") + " AS temporal_code, " + render.Col(16, "t.ledger_type", "CONVERT(tinyint, 0)") + " AS ledger_code, "
        + render.Col(13, "t.is_external", "CONVERT(bit, 0)") + " AS external_flag, " + render.Col(16, "t.is_dropped_ledger_table", "CONVERT(bit, 0)") + " AS dropped_flag";

    /// <summary>A table named by its schema and name, from an object id expression: two columns, prefixed.</summary>
    private static string NameOf(string prefix, string id) =>
        "(SELECT xs.name FROM sys.all_objects AS x JOIN sys.schemas AS xs ON xs.schema_id = x.schema_id WHERE x.object_id = " + id + ") AS " + prefix + "_schema, "
        + "(SELECT x.name FROM sys.all_objects AS x WHERE x.object_id = " + id + ") AS " + prefix + "_name";

    /// <summary>The facts row: Peek's table facts (by their ids), then what only Table Properties shows.</summary>
    private static string FactsRow(SqlRender render)
    {
        var band = render.Band;
        string Fact(string id) => PeekSql.TableFact(id) + " AS [" + id + "]";
        var columns = new List<string>
        {
            "o.name AS name", "o.object_id AS object_id", Fact("schema"), Fact("created"), Fact("modified"), Fact("systemObject"), Fact("replicated"), Fact("lockEscalation"), Fact("memoryOptimized"),
            Fact("rowCount"), Fact("dataSpace"), Fact("indexSpace"), Fact("filegroup"), Fact("textFilegroup"), Fact("partitioned"), Fact("compression"), "pr.compressions AS compressions",
            "t.uses_ansi_nulls AS ansi_nulls", "t.durability_desc AS durability", "t.is_filetable AS file_table", Kinds(render),
            render.Col(14, "t.is_node", "CONVERT(bit, 0)") + " AS node_flag", render.Col(14, "t.is_edge", "CONVERT(bit, 0)") + " AS edge_flag",
            "(SELECT fs.name FROM sys.data_spaces AS fs WHERE fs.data_space_id = t.filestream_data_space_id) AS filestream_filegroup",
            "CASE WHEN ds.type = 'PS' THEN ds.name END AS partition_scheme",
            "(SELECT c.name FROM sys.index_columns AS ic JOIN sys.columns AS c ON c.object_id = ic.object_id AND c.column_id = ic.column_id "
                + "WHERE ic.object_id = o.object_id AND ic.index_id = i.index_id AND ic.partition_ordinal = 1) AS partition_column",
            Tracking
        };
        if (band >= 13)
        {
            columns.Add(Fact("temporal"));
            // A system-versioned table names its history table; a history table, the table it keeps.
            columns.Add(NameOf("temporal_other", "CASE WHEN t.temporal_type = 2 THEN t.history_table_id WHEN t.temporal_type = 1 THEN (SELECT pt.object_id FROM sys.tables AS pt WHERE pt.history_table_id = o.object_id) END"));
            columns.Add("(SELECT c.name FROM sys.periods AS pd JOIN sys.columns AS c ON c.object_id = pd.object_id AND c.column_id = pd.start_column_id WHERE pd.object_id = o.object_id) AS period_start");
            columns.Add("(SELECT c.name FROM sys.periods AS pd JOIN sys.columns AS c ON c.object_id = pd.object_id AND c.column_id = pd.end_column_id WHERE pd.object_id = o.object_id) AS period_end");
        }
        if (band >= 14) columns.Add("t.history_retention_period AS retention_period, t.history_retention_period_unit_desc AS retention_unit");
        if (band >= 16)
        {
            columns.Add(Fact("ledger"));
            columns.Add(NameOf("ledger_view", "t.ledger_view_id"));
            columns.Add(NameOf("ledger_history", "CASE WHEN t.ledger_type = 2 THEN t.history_table_id END"));
        }
        return "SELECT " + string.Join(", ", columns) + " " + PeekSql.TableFrom + ";\n";
    }

    /// <summary>The list statements' row bounds, one more than the catalogue shows.</summary>
    private static string Top(TablesCatalogJson tables, string limit) => "TOP (" + (tables.Limit(limit) + 1).ToString(CultureInfo.InvariantCulture) + ")";

    /// <summary>Inside the database: the lookup, the facts row, then the table's permissions (class 1, columns by name), its heap's or
    /// clustered index's partitions with their filegroups, its row-level security predicates (band 13 and later), and its own extended
    /// properties (minor_id 0), each value as text and, when it is not text, its base type (binary as 0x hexadecimal).</summary>
    public static string Inside(int band, TablesCatalogJson tables)
    {
        var render = new SqlRender(band);
        var text = Lookup + CatalogSql.ParentLookup("table") + FactsRow(render)
            + "SELECT " + Top(tables, "permissions") + " dp.name AS principal, dp.type_desc AS principal_type, pe.permission_name AS permission, pe.state_desc AS state, gr.name AS grantor, c.name AS column_name "
            + "FROM sys.database_permissions AS pe JOIN sys.database_principals AS dp ON dp.principal_id = pe.grantee_principal_id "
            + "LEFT JOIN sys.database_principals AS gr ON gr.principal_id = pe.grantor_principal_id "
            + "LEFT JOIN sys.columns AS c ON c.object_id = pe.major_id AND c.column_id = pe.minor_id AND pe.minor_id > 0 "
            + "WHERE pe.class = 1 AND pe.major_id = @object_id ORDER BY dp.name, c.name, pe.permission_name, pe.state_desc;\n"
            + "SELECT " + Top(tables, "partitions") + " p.partition_number AS number, p.rows AS row_count, p.data_compression_desc AS compression, fg.name AS filegroup "
            + "FROM sys.partitions AS p JOIN sys.indexes AS i ON i.object_id = p.object_id AND i.index_id = p.index_id "
            + "LEFT JOIN sys.destination_data_spaces AS dds ON dds.partition_scheme_id = i.data_space_id AND dds.destination_id = p.partition_number "
            + "LEFT JOIN sys.data_spaces AS fg ON fg.data_space_id = COALESCE(dds.data_space_id, i.data_space_id) AND fg.type = 'FG' "
            + "WHERE p.object_id = @object_id AND p.index_id IN (0, 1) ORDER BY p.partition_number;\n";
        if (band >= 13)
            text += "SELECT " + Top(tables, "securityPredicates") + " sps.name AS policy_schema, spo.name AS policy_name, spr.predicate_type_desc AS predicate_type, spr.operation_desc AS operation, "
                + "LEFT(spr.predicate_definition, " + tables.Limit("predicateChars").ToString(CultureInfo.InvariantCulture) + ") AS predicate, CONVERT(bigint, LEN(spr.predicate_definition)) AS predicate_length, "
                + "spo.is_enabled AS enabled FROM sys.security_predicates AS spr JOIN sys.security_policies AS spo ON spo.object_id = spr.object_id "
                + "JOIN sys.schemas AS sps ON sps.schema_id = spo.schema_id WHERE spr.target_object_id = @object_id ORDER BY sps.name, spo.name, spr.security_predicate_id;\n";
        return text + "SELECT " + Top(tables, "extendedProperties") + " ep.name AS name, CONVERT(sysname, SQL_VARIANT_PROPERTY(ep.value, 'BaseType')) AS base_type, "
            + "CASE WHEN CONVERT(sysname, SQL_VARIANT_PROPERTY(ep.value, 'BaseType')) IN (N'binary', N'varbinary') THEN CONVERT(nvarchar(4000), CONVERT(varbinary(8000), ep.value), 1) "
            + "ELSE CONVERT(nvarchar(4000), ep.value) END AS value, "
            // The text above holds 4,000 characters: 1,999 bytes as hex, or a varchar of more (sql_variant holds up to 8,000 bytes).
            + "CASE WHEN CONVERT(sysname, SQL_VARIANT_PROPERTY(ep.value, 'BaseType')) IN (N'binary', N'varbinary') THEN CASE WHEN DATALENGTH(ep.value) > 1999 THEN 1 ELSE 0 END "
            + "WHEN DATALENGTH(ep.value) > 4000 AND LEN(CONVERT(nvarchar(4000), ep.value)) >= 4000 AND CONVERT(sysname, SQL_VARIANT_PROPERTY(ep.value, 'BaseType')) IN (N'varchar', N'char') THEN 1 ELSE 0 END AS value_cut "
            + "FROM sys.extended_properties AS ep WHERE ep.class = 1 AND ep.major_id = @object_id AND ep.minor_id = 0 ORDER BY ep.name;";
    }

    /// <summary>Apply's and Script's preflight inside the database, and the transaction's first step: the table's identity, the facts
    /// its plan reads (lock escalation, change tracking, a primary key, a memory-optimized table) and the facts that refuse a change.
    /// One row, from sys.tables only, so a recheck in the transaction holds few locks.</summary>
    public static string Preflight(int band)
    {
        var render = new SqlRender(band);
        return Lookup + CatalogSql.ParentLookup("table") + "SELECT o.object_id AS object_id, o.create_date AS create_date, " + PeekSql.TableFact("systemObject") + " AS system_object, "
            + "t.is_memory_optimized AS memory_optimized, t.lock_escalation_desc AS lock_escalation, " + Kinds(render) + ", " + Tracking + " "
            + "FROM sys.all_objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id "
            + "LEFT JOIN sys.extended_properties AS ep ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'microsoft_database_tools_support' "
            + "LEFT JOIN sys.tables AS t ON t.object_id = o.object_id WHERE o.object_id = @object_id;";
    }

    /// <summary>What the preflight read.</summary>
    internal sealed record Facts(int Id, string Created, bool System, bool MemoryOptimized, string LockEscalation, bool External, bool DroppedLedger, bool Tracking, bool TrackColumns, bool PrimaryKey);

    internal static Facts FactsOf(ScriptPreflight.Row row) => new(row.Int("object_id"), DatabaseProperties.Iso(row.Raw("create_date")), row.Bool("system_object"), row.Bool("memory_optimized"),
        row.Text("lock_escalation") ?? "", row.Bool("external_flag"), row.Bool("dropped_flag"), row.Bool("tracking"), row.Bool("track_columns"), row.Bool("primary_key"));

    /// <summary>HISTORY_RETENTION_PERIOD as SSMS words it: INFINITE, or the count and its unit in the plural ("6 MONTHS").</summary>
    internal static string? Retention(long? period, string? unit) => unit is null ? null : period is null or < 0 || unit == "INFINITE" ? "INFINITE"
        : period.Value.ToString(CultureInfo.InvariantCulture) + " " + unit + (period == 1 ? "" : "S");

    /// <summary>schema.name as Object Explorer shows a table, or null when either is unknown.</summary>
    private static string? Qualified(ScriptPreflight.Row row, string prefix) =>
        row.Name(prefix + "_schema") is { Length: > 0 } schema && row.Name(prefix + "_name") is { Length: > 0 } name ? schema + "." + name : null;

    private static async Task<List<ScriptPreflight.Row>> ListAsync(SqlDataReader reader, CancellationToken token)
    {
        var rows = new List<ScriptPreflight.Row>();
        if (!await reader.NextResultAsync(token)) return rows;
        while (await reader.ReadAsync(token)) rows.Add(Read(reader));
        return rows;
    }

    internal static ScriptPreflight.Row Read(SqlDataReader reader)
    {
        var values = new Dictionary<string, object?>(reader.FieldCount, StringComparer.Ordinal);
        for (var i = 0; i < reader.FieldCount; i++) values[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
        return new ScriptPreflight.Row(values);
    }

    /// <summary>Reads <see cref="Inside"/>'s results after its lookup row (true: found), into the model; <paramref name="database"/> is
    /// what <see cref="Master"/> read.</summary>
    public static async Task<TablePropertiesDto?> ReadAsync(SqlDataReader reader, int band, TablesCatalogJson tables, ScriptPreflight.Row database, CancellationToken token)
    {
        if (!await reader.ReadAsync(token) || !reader.GetBoolean(0)) return null;
        if (!await reader.NextResultAsync(token) || !await reader.ReadAsync(token)) return null;
        var row = Read(reader);
        var permissions = await ListAsync(reader, token);
        var partitions = await ListAsync(reader, token);
        var predicates = band >= 13 ? await ListAsync(reader, token) : null;
        var properties = await ListAsync(reader, token);
        int Limit(string key) => (int)tables.Limit(key);

        var general = new TableGeneralDto(row.Name("name"), row.Name("schema"), DatabaseProperties.Iso(row.Raw("created")), row.Bool("systemObject"), row.Bool("replicated"),
            row.Text("lockEscalation") ?? "", row.Bool("memoryOptimized"), row.Bool("file_table"), row.Bool("external_flag"), row.Int("object_id"),
            DatabaseProperties.Iso(row.Raw("modified")) is { Length: > 0 } modified ? modified : null, row.NullableBool("ansi_nulls"),
            row.Bool("memoryOptimized") ? row.Text("durability") : null, row.Bool("node_flag") ? "node" : row.Bool("edge_flag") ? "edge" : null);
        var storage = new TableStorageDto(row.Bool("partitioned"),
            [.. partitions.Take(Limit("partitions")).Select(item => new TablePartitionDto(item.Int("number"), item.Long("row_count") ?? 0, item.Text("compression") ?? "", NameOrNull(item, "filegroup")))],
            partitions.Count > Limit("partitions"), row.Long("rowCount"), row.Long("dataSpace"), row.Long("indexSpace"),
            row.Long("compressions") > 1 ? PeekSql.Mixed : row.Text("compression"), NameOrNull(row, "filegroup"), NameOrNull(row, "textFilegroup"), NameOrNull(row, "filestream_filegroup"),
            NameOrNull(row, "partition_scheme"), NameOrNull(row, "partition_column"));
        var temporalType = row.Text("temporal");
        var temporal = band >= 13 && temporalType is { } type && type != "NON_TEMPORAL_TABLE"
            ? new TableTemporalDto(type, Qualified(row, "temporal_other"), NameOrNull(row, "period_start"), NameOrNull(row, "period_end"),
                type == "SYSTEM_VERSIONED_TEMPORAL_TABLE" && band >= 14 ? Retention(row.Long("retention_period"), row.Text("retention_unit")) : null)
            : null;
        var ledgerType = row.Text("ledger");
        var ledger = band >= 16 && ledgerType is { } kind && kind != "NON_LEDGER_TABLE"
            ? new TableLedgerDto(kind, row.Bool("dropped_flag"), Qualified(row, "ledger_view"), Qualified(row, "ledger_history"))
            : null;
        var tracking = new TableChangeTrackingDto(database.Bool("tracking"), row.Bool("tracking"), row.Bool("track_columns"), row.Bool("primary_key"));
        var chars = Limit("predicateChars");
        var reason = general.SystemObject ? tables.Message("systemTable") : database.Bool("read_only") ? tables.Message("readOnlyDatabase")
            : general.External ? tables.Message("externalTable") : row.Bool("dropped_flag") ? tables.Message("droppedLedger") : null;
        return new TablePropertiesDto(general, storage, tracking,
            [.. permissions.Take(Limit("permissions")).Select(item => new TablePermissionDto(item.Name("principal"), item.Text("principal_type") ?? "", item.Text("permission") ?? "", item.Text("state") ?? "",
                item.Name("grantor"), NameOrNull(item, "column_name")))],
            permissions.Count > Limit("permissions"),
            [.. properties.Take(Limit("extendedProperties")).Select(item => new TableExtendedPropertyDto(item.Name("name"), item.Raw("value") as string ?? "", TextType(item.Text("base_type")), item.Int("value_cut") == 1 ? true : null))],
            properties.Count > Limit("extendedProperties"), band, temporal, ledger,
            predicates is null ? null : [.. predicates.Take(Limit("securityPredicates")).Select(item => new TableSecurityPredicateDto(Qualified(item, "policy") ?? item.Name("policy_name"), item.Text("predicate_type") ?? "",
                item.Raw("predicate") as string ?? "", item.Bool("enabled"), item.Text("operation"), item.Long("predicate_length") > chars ? true : null))],
            predicates is null ? null : predicates.Count > Limit("securityPredicates"), reason);
    }

    /// <summary>A name column as stored, or null when it is absent.</summary>
    private static string? NameOrNull(ScriptPreflight.Row row, string column) => row.Name(column) is { Length: > 0 } name ? name : null;

    /// <summary>A value's base type when it is not text (null for nvarchar, varchar, nchar and char, which Apply may change).</summary>
    internal static string? TextType(string? type) => type is null or "nvarchar" or "varchar" or "nchar" or "char" ? null : type;
}
