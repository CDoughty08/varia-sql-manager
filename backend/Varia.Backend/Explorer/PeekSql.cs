using System.Globalization;
using System.Text;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Explorer;

/// <summary>explorer.peek's constant batches, one per peek kind and version band. Each runs in the object's database as every
/// Object Explorer database statement does (through <see cref="CatalogSql.ModuleCall"/>, or on a per-database pool), finds
/// the object by @object_schema and @object_name (<see cref="CatalogSql.ParentLookup"/>: one bit row, then nothing when it
/// is gone), and reads one row: the kind's facts in catalogue order, aliased with their ids, then the helper columns
/// <see cref="Extras"/> names (and a module's text last). The Dependencies tab's batch (<see cref="Dependencies"/>) is apart:
/// sys.sql_expression_dependencies needs more than VIEW DEFINITION (db_owner by default), so a login refused it still gets the
/// facts. Words SSMS shows for codes are made here, in C#, since the lint allows no string literals in the SQL.</summary>
internal static class PeekSql
{
    internal sealed record Batch(string Text, IReadOnlyList<string> Columns);

    private const string Owned = "FROM sys.all_objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id "
        + "LEFT JOIN sys.extended_properties AS ep ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'microsoft_database_tools_support' ";
    private const string Modules = "LEFT JOIN sys.all_sql_modules AS m ON m.object_id = o.object_id ";
    // CLR modules have their EXECUTE AS and NULL-input options in sys.assembly_modules; -1 stands for CALLER (NULL there), so
    // NULL is left for objects with neither row (extended procedures).
    private const string Assembly = "LEFT JOIN sys.assembly_modules AS am ON am.object_id = o.object_id "
        + "LEFT JOIN sys.database_principals AS dp ON dp.principal_id = COALESCE(m.execute_as_principal_id, am.execute_as_principal_id) ";
    private const string ExecuteAs = "CASE WHEN m.object_id IS NOT NULL THEN COALESCE(m.execute_as_principal_id, -1) WHEN am.object_id IS NOT NULL THEN COALESCE(am.execute_as_principal_id, -1) END";
    /// <summary>EXECUTE AS CALLER, as <see cref="ExecuteAs"/> returns it.</summary>
    internal const int Caller = -1;

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

    private static readonly Dictionary<string, Dictionary<string, string>> Facts = new(StringComparer.Ordinal)
    {
        ["table"] = new(StringComparer.Ordinal)
        {
            ["replicated"] = "t.is_replicated",
            ["lockEscalation"] = "t.lock_escalation_desc",
            ["memoryOptimized"] = "t.is_memory_optimized",
            ["temporal"] = "t.temporal_type_desc",
            ["ledger"] = "t.ledger_type_desc",
            ["rowCount"] = "pr.row_count",
            // sp_spaceused's split: data is the heap's or clustered index's leaf (in-row data pages) plus its LOB and
            // row-overflow pages; index space is every other page the table's indexes use.
            ["dataSpace"] = "CONVERT(bigint, sp.data_pages) * 8",
            ["indexSpace"] = "CONVERT(bigint, CASE WHEN sp.used_pages > sp.data_pages THEN sp.used_pages - sp.data_pages WHEN sp.used_pages IS NOT NULL THEN 0 END) * 8",
            ["filegroup"] = "CASE WHEN ds.type = 'FG' THEN ds.name END",
            ["textFilegroup"] = "lob.name",
            ["partitioned"] = "CONVERT(bit, CASE WHEN ds.type = 'PS' THEN 1 ELSE 0 END)",
            ["compression"] = "pr.compression"
        },
        ["view"] = new(StringComparer.Ordinal)
        {
            ["indexed"] = "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.indexes AS i WHERE i.object_id = o.object_id AND i.index_id > 0) THEN 1 ELSE 0 END)"
        },
        ["procedure"] = new(StringComparer.Ordinal)
        {
            ["recompile"] = "m.is_recompiled"
        },
        ["function"] = new(StringComparer.Ordinal)
        {
            ["functionType"] = "o.type_desc",
            // An inline function cannot take EXECUTE AS.
            ["executeAs"] = "CASE WHEN o.type = 'IF' THEN NULL ELSE " + ExecuteAs + " END",
            ["nullOnNullInput"] = "CASE WHEN m.object_id IS NOT NULL THEN m.null_on_null_input ELSE am.null_on_null_input END"
        }
    };

    private static readonly Dictionary<string, (string Column, string Expression)[]> Helpers = new(StringComparer.Ordinal)
    {
        ["table"] = [("compressions", "pr.compressions")],
        ["view"] = [],
        ["procedure"] = [("executeAsName", "dp.name")],
        ["function"] = [("executeAsName", "dp.name")]
    };

    private static readonly Dictionary<string, string> From = new(StringComparer.Ordinal)
    {
        ["table"] = Owned + "LEFT JOIN sys.tables AS t ON t.object_id = o.object_id "
            + "LEFT JOIN sys.indexes AS i ON i.object_id = o.object_id AND i.index_id IN (0, 1) "
            + "LEFT JOIN sys.data_spaces AS ds ON ds.data_space_id = i.data_space_id "
            + "LEFT JOIN sys.data_spaces AS lob ON lob.data_space_id = t.lob_data_space_id "
            + "OUTER APPLY (SELECT SUM(p.rows) AS row_count, MIN(p.data_compression_desc) AS compression, COUNT(DISTINCT p.data_compression) AS compressions "
            + "FROM sys.partitions AS p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS pr "
            + "OUTER APPLY (SELECT SUM(CASE WHEN p.index_id IN (0, 1) THEN CASE WHEN au.type = 1 THEN au.data_pages ELSE au.used_pages END ELSE 0 END) AS data_pages, "
            + "SUM(au.used_pages) AS used_pages FROM sys.partitions AS p JOIN sys.allocation_units AS au ON (au.type IN (1, 3) AND au.container_id = p.hobt_id) OR (au.type = 2 AND au.container_id = p.partition_id) "
            + "WHERE p.object_id = o.object_id) AS sp ",
        ["view"] = Owned + Modules,
        ["procedure"] = Owned + Modules + Assembly,
        ["function"] = Owned + Modules + Assembly
    };

    /// <summary>What the object references by name (column references collapse into their object's row; itself left out), and
    /// the tables its foreign keys point at: server, database, schema, name, the object's id when it is in this database, and
    /// whether a foreign key makes the link. A reference SQL Server resolved takes the object's current names.</summary>
    private const string UsesRows = "SELECT d.referenced_server_name AS server_name, d.referenced_database_name AS database_name, COALESCE(rs.name, d.referenced_schema_name) AS schema_name, "
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

    /// <summary>The helper columns after a kind's facts, in order: the table's count of compression settings, a module's
    /// EXECUTE AS principal name, and a module kind's text.</summary>
    public static IReadOnlyList<string> Extras(PeekKindSpec spec) => [.. Helpers[spec.Kind].Select(helper => helper.Column), .. spec.Module ? new[] { "definition" } : []];

    /// <summary>The kind's batch for the band. Facts newer than the band are left out of the text and the reply.</summary>
    public static Batch Render(PeekKindSpec spec, SqlRender render, int definitionChars)
    {
        if (!Facts.TryGetValue(spec.Kind, out var own)) throw new InvalidOperationException("Peek has no batch for " + spec.Kind + ".");
        var columns = new List<(string Column, string Expression)>();
        foreach (var fact in spec.FactsFor(render.Band))
            columns.Add((fact.Id, own.GetValueOrDefault(fact.Id) ?? Common.GetValueOrDefault(fact.Id) ?? throw new InvalidOperationException("Peek has no column for " + spec.Kind + "." + fact.Id + ".")));
        columns.AddRange(Helpers[spec.Kind]);
        // One code unit past the limit tells the reader the text was cut.
        if (spec.Module) columns.Add(("definition", "LEFT(m.definition, " + (definitionChars + 1).ToString(CultureInfo.InvariantCulture) + ")"));
        var text = new StringBuilder(CatalogSql.ParentLookup(spec.Kind)).Append("SELECT ");
        text.AppendJoin(", ", columns.Select(column => column.Expression + " AS [" + column.Column + "]"));
        text.Append(' ').Append(From[spec.Kind]).Append("WHERE o.object_id = @object_id;\n");
        return new(text.ToString(), [.. columns.Select(column => column.Column)]);
    }

    /// <summary>The fact row as PeekResult carries it: each fact by its format, the codes SSMS words, and the module text cut
    /// to <paramref name="definitionChars"/>.</summary>
    public static PeekResult Read(SqlDataReader reader, PeekKindSpec spec, Batch batch, int band, int definitionChars)
    {
        var raw = new Dictionary<string, object?>(batch.Columns.Count, StringComparer.Ordinal);
        for (var index = 0; index < batch.Columns.Count; index++) raw[batch.Columns[index]] = reader.IsDBNull(index) ? null : reader.GetValue(index);
        var facts = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var fact in spec.FactsFor(band)) facts[fact.Id] = Value(fact, raw);
        if (!spec.Module || raw["definition"] is not string text) return new(facts, 0);
        var (definition, cut) = Cut(text, definitionChars);
        return new(facts, 0, definition, cut ? true : null);
    }

    /// <summary>explorer.peekDependencies' batch for a kind and band: the object found by name, then what it uses and what uses
    /// it, at most @take rows each in name order.</summary>
    public static string Dependencies(string kind, SqlRender render) => CatalogSql.ParentLookup(kind) + Uses(render) + UsedBy(render);

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
        }
        if (value is null) return null;
        return fact.Format switch
        {
            "text" => Convert.ToString(value, CultureInfo.InvariantCulture),
            "date" => ExplorerLabels.Created((DateTime)value),
            "bool" => Convert.ToBoolean(value, CultureInfo.InvariantCulture),
            "count" or "kb" => Convert.ToInt64(value, CultureInfo.InvariantCulture),
            _ => throw new InvalidOperationException("Unknown peek format.")
        };
    }

    /// <summary>A table whose partitions are compressed differently.</summary>
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
}
