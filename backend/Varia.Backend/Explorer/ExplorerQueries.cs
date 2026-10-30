using System.Globalization;
using System.Text;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Explorer;

/// <summary>Where a statement runs: on the server's connection, in one database (EXEC [db].sys.sp_executesql), or on the SSIS
/// read pool, whose connections are in the SSIS Catalog's database (D-ssis 3.2), so no wrapper is needed on any engine.</summary>
internal enum QueryScope { Server, Database, Ssis }

/// <summary>What a row's mapping knows about the request: the database it reads, and for child folders the parent object.</summary>
internal sealed record RowContext(ExplorerCatalog Catalog, ExplorerProfile Profile, string? Database, ObjectRefDto Owner, object? Prelude = null);

/// <summary>One row of a listing. Keys come first (column 0, and 1 for schema-scoped objects); the accessors number the
/// selected columns after them from 0.</summary>
internal sealed class Row(SqlDataReader reader, RowContext context, int keys)
{
    public RowContext Context => context;
    public string Key(int index) => reader.GetString(index);
    public int Ordinal => Convert.ToInt32(reader.GetValue(0), CultureInfo.InvariantCulture);
    public long Id => Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture);
    public bool Null(int index) => reader.IsDBNull(keys + index);
    /// <summary>A name or text, verbatim (identifiers may end in spaces).</summary>
    public string? S(int index) => Null(index) ? null : Convert.ToString(reader.GetValue(keys + index), CultureInfo.InvariantCulture);
    /// <summary>A char(2) catalog type code such as "PK" or "F ", without its padding.</summary>
    public string Code(int index) => S(index)?.TrimEnd() ?? "";
    public int I(int index) => Null(index) ? 0 : Convert.ToInt32(reader.GetValue(keys + index), CultureInfo.InvariantCulture);
    public int? N(int index) => Null(index) ? null : Convert.ToInt32(reader.GetValue(keys + index), CultureInfo.InvariantCulture);
    public bool B(int index) => !Null(index) && Convert.ToBoolean(reader.GetValue(keys + index), CultureInfo.InvariantCulture);
    public DateTime? D(int index) => Null(index) ? null : reader.GetDateTime(keys + index);
    /// <summary>A datetimeoffset, as the SSIS Catalog stores its times (never converted to datetime, which drops the offset).</summary>
    public DateTimeOffset? T(int index) => Null(index) ? null : reader.GetDateTimeOffset(keys + index);
    /// <summary>A candidate key's row passes the folder's predicate (the last column of a candidate listing).</summary>
    public bool Listed => reader.GetBoolean(reader.FieldCount - 1);
}

/// <summary>
/// Pages a schema-scoped listing by candidate keys: TOP (@take) (schema, name) keys of one object type from sys.objects,
/// which SQL Server reads in key order, then the catalog view's columns and the folder predicate for those rows only,
/// returned as a last "listed" column. A page can hold fewer rows than it read, so its cursor is the last candidate key.
/// </summary>
/// <param name="Type">The sys.objects type letters, e.g. 'U'.</param>
/// <param name="Join">Joins k (k1, k2, id, sp: the schema's principal) to the view and everything the select names.</param>
internal sealed record CandidateKeys(string Type, string Join);

/// <summary>A catalog listing: constant text per render (<see cref="SqlRender"/>), keyset paged, mapped row by row.</summary>
internal sealed class ExplorerQuery
{
    public required string Id { get; init; }
    public required QueryScope Scope { get; init; }
    public Keyset Keyset { get; init; } = Keyset.Name;
    /// <summary>A child folder: the statement first resolves the parent object by (schema, name).</summary>
    public bool ChildFolder { get; init; }
    /// <summary>Resolves the owner first, as a child folder's parent lookup does: it selects whether the owner exists and returns
    /// when it does not, so a listing below a deleted SSIS folder or project answers NOT_FOUND.</summary>
    public Func<SqlRender, string>? OwnerLookup { get; init; }
    /// <summary>The value an empty first page answers instead (the SSIS Catalog on Linux, which cannot exist there).</summary>
    public Func<RowContext, ExplorerError?>? WhenEmpty { get; init; }
    public required Func<SqlRender, string> From { get; init; }
    public Func<SqlRender, string>? Where { get; init; }
    public required string[] Keys { get; init; }
    public Func<SqlRender, string> Select { get; init; } = _ => "";
    /// <summary>Joins the owner as "own"; the count adds it only when filtering by owner.</summary>
    public string? OwnerJoin { get; init; }
    public bool RowsNeedOwner { get; init; }
    public FilterColumns Filter { get; init; } = new();
    public required Func<Row, ExplorerNode> Map { get; init; }
    /// <summary>Statements between the parent lookup and the count (Parameters: the module text and the return type).</summary>
    public Func<SqlRender, string>? Prelude { get; init; }
    public Func<SqlDataReader, CancellationToken, Task<object?>>? ReadPrelude { get; init; }
    /// <summary>A row after the last page (Parameters: the return value).</summary>
    public Func<RowContext, ExplorerNode?>? Tail { get; init; }
    /// <summary>The listing may call HAS_DBACCESS (the database lists).</summary>
    public bool ChecksAccess { get; init; }
    /// <summary>Pages by candidate keys (Tables: sorting every remaining sys.tables row per page is too slow at 100,000).</summary>
    public CandidateKeys? Candidates { get; init; }

    public string Render(SqlRender render)
    {
        var text = new StringBuilder();
        if (ChildFolder) text.Append(CatalogSql.ParentLookup(render.ParentKind ?? throw new InvalidOperationException("A child folder needs its parent kind.")));
        if (OwnerLookup is not null) text.Append(OwnerLookup(render));
        if (Prelude is not null) text.Append(Prelude(render));
        var from = From(render);
        var where = Where?.Invoke(render);
        var filters = CatalogSql.Filters(render.Filter, Filter);
        var owner = OwnerJoin is null ? "" : " " + OwnerJoin;
        var keyset = Keyset switch
        {
            Keyset.Name => "(@k1 IS NULL OR " + Keys[0] + " > @k1)",
            Keyset.SchemaName => "(@k1 IS NULL OR " + Keys[0] + " > @k1 OR (" + Keys[0] + " = @k1 AND " + Keys[1] + " > @k2))",
            Keyset.Id => "(@kb IS NULL OR " + Keys[0] + " > @kb)",
            _ => Keys[0] + " > ISNULL(@kn, 0)"
        };
        string Conditions(params string?[] parts)
        {
            var present = parts.Where(part => !string.IsNullOrEmpty(part)).ToList();
            return present.Count == 0 && filters.Length == 0 ? "" : " WHERE " + (present.Count == 0 ? "1 = 1" : string.Join(" AND ", present)) + filters;
        }
        var select = Select(render);
        text.Append("IF @first = 1 SELECT COUNT_BIG(*) FROM ").Append(from).Append(render.Filter.Owner is null ? "" : owner).Append(Conditions(where)).Append(";\n");
        if (Candidates is { } candidates)
        {
            // The candidates take the filter on sys.objects' own columns, so a filtered folder still reads full pages.
            var candidateFilters = CatalogSql.Filters(render.Filter, new FilterColumns("o.name", "s.name", "own.name", "o.create_date"));
            text.Append("WITH k AS (SELECT TOP (@take) s.name AS k1, o.name AS k2, o.object_id AS id, s.principal_id AS sp FROM sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id")
                .Append(render.Filter.Owner is null ? "" : " LEFT JOIN sys.database_principals AS own ON own.principal_id = COALESCE(o.principal_id, s.principal_id)")
                .Append(" WHERE o.type = ").Append(candidates.Type).Append(" AND (@k1 IS NULL OR s.name > @k1 OR (s.name = @k1 AND o.name > @k2))").Append(candidateFilters)
                .Append(" ORDER BY s.name, o.name)\n");
            text.Append("SELECT k.k1, k.k2").Append(select.Length == 0 ? "" : ", " + select).Append(", CONVERT(bit, CASE WHEN ").Append(where ?? "1 = 1").Append(" THEN 1 ELSE 0 END) FROM k ")
                .Append(candidates.Join).Append(" ORDER BY k.k1, k.k2;");
            return text.ToString();
        }
        text.Append("SELECT TOP (@take) ").Append(string.Join(", ", Keys)).Append(select.Length == 0 ? "" : ", " + select).Append(" FROM ").Append(from)
            .Append(RowsNeedOwner || render.Filter.Owner is not null ? owner : "").Append(Conditions(where, keyset)).Append(" ORDER BY ").Append(string.Join(", ", Keys)).Append(';');
        return text.ToString();
    }

    public CursorKey KeyOf(Row row) => Keyset switch
    {
        Keyset.Name => new(row.Key(0), null, null),
        Keyset.SchemaName => new(row.Key(0), row.Key(1), null),
        Keyset.Id => new(null, null, null, row.Id),
        _ => new(null, null, row.Ordinal)
    };
}

/// <summary>Every catalog listing Object Explorer runs (B1–B5), by the id a catalogue folder names; the history row's
/// query (<see cref="HistoryTable"/>) is read by the service itself.</summary>
internal static class ExplorerQueries
{
    private const string ToolsSupport = "LEFT JOIN sys.extended_properties AS ep ON ep.class = 1 AND ep.major_id = {0}.object_id AND ep.minor_id = 0 AND ep.name = N'microsoft_database_tools_support'";
    private static string Tools(string alias) => string.Format(CultureInfo.InvariantCulture, ToolsSupport, alias);
    private static string SchemaOwner(string alias) => "LEFT JOIN sys.database_principals AS own ON own.principal_id = COALESCE(" + alias + ".principal_id, s.principal_id)";

    // --- Node builders --------------------------------------------------------------------------------------------

    public static ExplorerNode Node(RowContext context, ObjectRefDto value, string label, string? subtype = null, string? sublabel = null, string? detail = null,
        string? status = null, DateTime? created = null, string? icon = null, bool? hasChildren = null) =>
        new(new NodeRefDto("object", value), ExplorerLabels.Clip(label, ExplorerLabels.MaxLabel), icon ?? context.Catalog.IconFor(value.Kind, subtype),
            hasChildren ?? context.Catalog.HasChildren(value.Kind, subtype, context.Profile), sublabel is null ? null : ExplorerLabels.Clip(sublabel, ExplorerLabels.MaxSublabel),
            detail is null ? null : ExplorerLabels.Clip(detail, ExplorerLabels.MaxDetail), subtype, status, created is { } date ? ExplorerLabels.Created(date) : null);

    private static ExplorerNode ServerObject(Row row, string kind, string? subtype = null, string? detail = null, string? status = null, DateTime? created = null) =>
        Node(row.Context, new ObjectRefDto(kind, Name: row.Key(0)), row.Key(0), subtype, null, detail, status, created);

    private static ExplorerNode DatabaseObject(Row row, string kind, string? subtype = null, string? detail = null, string? status = null, DateTime? created = null) =>
        Node(row.Context, new ObjectRefDto(kind, row.Context.Database, Name: row.Key(0)), row.Key(0), subtype, null, detail, status, created);

    private static ExplorerNode SchemaObject(Row row, string kind, string? subtype = null, string? sublabel = null, string? detail = null, string? status = null, DateTime? created = null) =>
        Node(row.Context, new ObjectRefDto(kind, row.Context.Database, row.Key(0), row.Key(1)), row.Key(0) + "." + row.Key(1), subtype, sublabel, detail, status, created);

    private static ObjectRefDto Child(RowContext context, string kind, string? name) =>
        new(kind, context.Database, Name: name, Parent: new ParentRefDto(context.Owner.Kind, context.Owner.Schema!, context.Owner.Name!));

    private static string? Owner(string? name) => name is null ? null : "Owner " + name;
    private static string? Disabled(bool disabled) => disabled ? "disabled" : null;

    // --- Server scope -----------------------------------------------------------------------------------------------

    // HAS_DBACCESS waits about 2 s on a single-user database another session is in, and then says no: such a database is
    // listed as usable, and expanding it says whether it can be opened (DatabaseState).
    private static ExplorerQuery Databases(string id, string predicate, string? subtype) => new()
    {
        Id = id, Scope = QueryScope.Server, ChecksAccess = true, From = _ => "sys.databases AS d", Where = _ => predicate, Keys = ["d.name"],
        Select = _ => "d.state, d.user_access, d.is_read_only, d.is_in_standby, CONVERT(bit, ISNULL(CASE WHEN d.user_access = 1 THEN 1 ELSE HAS_DBACCESS(d.name) END, 0)), d.create_date, d.compatibility_level, "
            + "d.recovery_model_desc, own.name, CONVERT(bit, CASE WHEN d.source_database_id IS NULL THEN 0 ELSE 1 END)",
        OwnerJoin = "LEFT JOIN sys.server_principals AS own ON own.sid = d.owner_sid", RowsNeedOwner = true,
        Filter = new(Name: "d.name", Owner: "own.name", Created: "d.create_date"),
        Map = row =>
        {
            var (sublabel, status, hasChildren) = ExplorerLabels.Database(row.I(0), row.I(1), row.B(2), row.B(3), row.B(4));
            var kind = subtype ?? (row.B(9) ? "snapshot" : null);
            return Node(row.Context, new ObjectRefDto("database", Name: row.Key(0)), row.Key(0), kind, sublabel,
                ExplorerLabels.Join([Owner(row.S(8)), "Compatibility level " + row.I(6).ToString(CultureInfo.InvariantCulture), row.S(7) is { } model ? "Recovery model " + model : null]),
                status, row.D(5), hasChildren: hasChildren) with { Database = new(row.I(0), row.I(1), row.B(2), row.B(3)) };
        }
    };

    private static ExplorerQuery ServerList(string id, string kind, string from, string key, string select, Func<Row, ExplorerNode> map, string? where = null, FilterColumns? filter = null) => new()
    {
        Id = id, Scope = QueryScope.Server, From = _ => from, Where = where is null ? null : _ => where, Keys = [key], Select = _ => select, Filter = filter ?? new(Name: key), Map = map
    };

    // --- Database scope ---------------------------------------------------------------------------------------------

    private const string TableFrom = "sys.tables AS t JOIN sys.schemas AS s ON s.schema_id = t.schema_id ";

    private static ExplorerQuery Tables(string id, Func<SqlRender, string> predicate, string[] filters, bool candidates = false) => new()
    {
        Id = id, Scope = QueryScope.Database, Keyset = Keyset.SchemaName, From = _ => TableFrom + Tools("t"), Where = predicate, Keys = ["s.name", "t.name"],
        // Only the main folder: nearly every user table is listed there, while the other folders list a few of them.
        Candidates = candidates ? new("'U'", "JOIN sys.tables AS t ON t.object_id = k.id " + Tools("t") + " LEFT JOIN sys.database_principals AS own ON own.principal_id = COALESCE(t.principal_id, k.sp)") : null,
        Select = r => "t.create_date, " + r.Col(13, "t.temporal_type", "CONVERT(tinyint, 0)") + ", " + r.Col(16, "t.ledger_type", "CONVERT(tinyint, 0)") + ", "
            + r.Col(14, "t.is_node", "CONVERT(bit, 0)") + ", " + r.Col(14, "t.is_edge", "CONVERT(bit, 0)") + ", t.is_filetable, " + r.Col(13, "t.is_external", "CONVERT(bit, 0)") + ", "
            + r.Col(16, "t.is_dropped_ledger_table", "CONVERT(bit, 0)") + ", CONVERT(bit, CASE WHEN t.is_ms_shipped = 1 OR ep.major_id IS NOT NULL THEN 1 ELSE 0 END), own.name",
        OwnerJoin = SchemaOwner("t"), RowsNeedOwner = true, Filter = Columns(filters, "t"),
        Map = row =>
        {
            var subtype = ExplorerLabels.TableSubtype(row.I(1), row.I(2), row.B(3), row.B(4), row.B(5), row.B(6), row.B(7), row.B(8));
            return SchemaObject(row, "table", subtype, ExplorerLabels.TableSublabel(row.I(1), row.I(2), row.B(7)), Owner(row.S(9)), created: row.D(0));
        }
    };

    private static FilterColumns Columns(string[] properties, string alias) => new(
        properties.Contains("name") ? alias + ".name" : null, properties.Contains("schema") ? "s.name" : null, properties.Contains("owner") ? "own.name" : null,
        properties.Contains("created") ? alias + ".create_date" : null);

    private static readonly string[] Full = ["name", "schema", "owner", "created"], SchemaNamed = ["name", "schema"];

    /// <summary>A schema-scoped list: (schema, name) keyset over a source aliased <paramref name="alias"/> joined to sys.schemas as s.</summary>
    private static ExplorerQuery SchemaList(string id, string from, string alias, string? where, string select, Func<Row, ExplorerNode> map, string[] filters, bool owner = false) => new()
    {
        Id = id, Scope = QueryScope.Database, Keyset = Keyset.SchemaName, From = _ => from, Where = where is null ? null : _ => where, Keys = ["s.name", alias + ".name"],
        Select = _ => select, OwnerJoin = owner || filters.Contains("owner") ? SchemaOwner(alias) : null, RowsNeedOwner = owner, Filter = Columns(filters, alias), Map = map
    };

    private static ExplorerQuery DatabaseList(string id, string from, string key, string select, Func<Row, ExplorerNode> map, string? where = null, FilterColumns? filter = null,
        string? ownerJoin = null) => new()
    {
        Id = id, Scope = QueryScope.Database, From = _ => from, Where = where is null ? null : _ => where, Keys = [key], Select = _ => select, Filter = filter ?? new(Name: key),
        OwnerJoin = ownerJoin, RowsNeedOwner = ownerJoin is not null, Map = map
    };

    private static ExplorerQuery ChildList(string id, Func<SqlRender, string> from, string key, Func<SqlRender, string> select, Func<Row, ExplorerNode> map, string? where = null) => new()
    {
        Id = id, Scope = QueryScope.Database, ChildFolder = true, From = from, Where = where is null ? null : _ => where, Keys = [key], Select = select, Map = map
    };

    private static string ColumnVisibility(SqlRender r) =>
        "NOT (" + r.Col(13, "c.is_hidden", "CONVERT(bit, 0)") + " = 1 AND " + r.Col(14, "c.graph_type", "CONVERT(int, NULL)") + " IS NOT NULL) AND "
        + r.Col(16, "c.is_dropped_ledger_column", "CONVERT(bit, 0)") + " = 0";

    private static ExplorerQuery ColumnsQuery() => new()
    {
        Id = "columns", Scope = QueryScope.Database, ChildFolder = true, Keyset = Keyset.Ordinal,
        From = _ => "sys.all_columns AS c JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id "
            + "LEFT JOIN sys.types AS bt ON ty.is_user_defined = 1 AND ty.is_assembly_type = 0 AND ty.is_table_type = 0 AND bt.user_type_id = ty.system_type_id "
            + "LEFT JOIN sys.xml_schema_collections AS xs ON c.xml_collection_id <> 0 AND xs.xml_collection_id = c.xml_collection_id "
            + "LEFT JOIN sys.schemas AS xss ON xss.schema_id = xs.schema_id",
        Where = r => "c.object_id = @object_id AND " + ColumnVisibility(r), Keys = ["c.column_id"],
        Select = r => "c.name, ty.name, ty.is_user_defined, ty.is_assembly_type, bt.name, c.max_length, c.precision, c.scale, c.is_nullable, c.is_computed, c.is_identity, "
            + "c.is_sparse, c.is_column_set, " + r.Col(13, "c.generated_always_type", "CONVERT(tinyint, 0)") + ", " + r.Col(13, "c.is_hidden", "CONVERT(bit, 0)") + ", "
            + r.Col(13, "c.is_masked", "CONVERT(bit, 0)") + ", " + r.Col(13, "c.encryption_type", "CONVERT(int, NULL)") + ", " + r.Col(14, "c.graph_type", "CONVERT(int, NULL)") + ", "
            + "c.collation_name, c.is_xml_document, xss.name, xs.name, " + (r.VectorDimensions ? "c.vector_dimensions" : "CONVERT(int, NULL)") + ", "
            + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.indexes AS i JOIN sys.index_columns AS ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
            + "WHERE i.object_id = @object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id) THEN 1 ELSE 0 END), "
            + "CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.foreign_key_columns AS f WHERE f.parent_object_id = @object_id AND f.parent_column_id = c.column_id) THEN 1 ELSE 0 END)",
        Map = row =>
        {
            var type = new SqlTypeInfo(row.S(1)!, row.I(5), row.I(6), row.I(7), row.B(2), row.B(3), false, row.S(4), row.B(19), row.S(20), row.S(21), row.N(22));
            bool primaryKey = row.B(23), foreignKey = row.B(24), computed = row.B(9);
            var variants = row.Context.Catalog.KindOf("column").VariantIcons;
            var icon = primaryKey ? variants["primaryKey"] : foreignKey ? variants["foreignKey"] : computed ? variants["computed"] : null;
            var name = row.S(0)!;
            return Node(row.Context, Child(row.Context, "column", name), name, null, ExplorerLabels.ColumnSublabel(primaryKey, foreignKey, computed, ExplorerLabels.TypeText(type), row.B(8)),
                ExplorerLabels.ColumnDetail(row.B(10), row.B(11), row.B(12), row.B(14), row.B(15), row.N(16) is > 0, row.I(13), !row.Null(17), row.S(18)), icon: icon);
        }
    };

    private sealed record ParameterPrelude(IReadOnlySet<string>? Defaults, string ObjectType, string? ReturnType);

    private static readonly string[] ClrModules = ["PC", "FS", "FT", "AF"];

    private static ExplorerQuery ParametersQuery() => new()
    {
        Id = "parameters", Scope = QueryScope.Database, ChildFolder = true, Keyset = Keyset.Ordinal,
        Prelude = _ => "SELECT SUBSTRING(m.definition, 1, " + ModuleHeader.MaxDefinition.ToString(CultureInfo.InvariantCulture) + ") FROM sys.all_sql_modules AS m WHERE m.object_id = @object_id;\n"
            + "SELECT o.type, rt.name, rt.is_user_defined, rt.is_assembly_type, rbt.name, r.max_length, r.precision, r.scale, r.is_xml_document, rxss.name, rxs.name "
            + "FROM sys.all_objects AS o LEFT JOIN sys.all_parameters AS r ON r.object_id = o.object_id AND r.parameter_id = 0 "
            + "LEFT JOIN sys.types AS rt ON rt.user_type_id = r.user_type_id "
            + "LEFT JOIN sys.types AS rbt ON rt.is_user_defined = 1 AND rt.is_assembly_type = 0 AND rt.is_table_type = 0 AND rbt.user_type_id = rt.system_type_id "
            + "LEFT JOIN sys.xml_schema_collections AS rxs ON r.xml_collection_id <> 0 AND rxs.xml_collection_id = r.xml_collection_id "
            + "LEFT JOIN sys.schemas AS rxss ON rxss.schema_id = rxs.schema_id WHERE o.object_id = @object_id;\n",
        ReadPrelude = async (reader, token) =>
        {
            string? definition = null;
            if (await reader.ReadAsync(token) && !reader.IsDBNull(0)) definition = reader.GetString(0);
            await reader.NextResultAsync(token);
            if (!await reader.ReadAsync(token)) return null;
            var objectType = reader.GetString(0).TrimEnd();
            string? returnType = reader.IsDBNull(1) ? null : ExplorerLabels.TypeText(new SqlTypeInfo(reader.GetString(1), Convert.ToInt32(reader.GetValue(5), CultureInfo.InvariantCulture),
                Convert.ToInt32(reader.GetValue(6), CultureInfo.InvariantCulture), Convert.ToInt32(reader.GetValue(7), CultureInfo.InvariantCulture), reader.GetBoolean(2), reader.GetBoolean(3),
                false, reader.IsDBNull(4) ? null : reader.GetString(4), !reader.IsDBNull(8) && reader.GetBoolean(8), reader.IsDBNull(9) ? null : reader.GetString(9),
                reader.IsDBNull(10) ? null : reader.GetString(10)));
            await reader.NextResultAsync(token);
            return new ParameterPrelude(ClrModules.Contains(objectType) ? null : ModuleHeader.ParameterDefaults(definition), objectType, returnType);
        },
        From = _ => "sys.all_parameters AS p JOIN sys.types AS ty ON ty.user_type_id = p.user_type_id JOIN sys.schemas AS tys ON tys.schema_id = ty.schema_id "
            + "LEFT JOIN sys.types AS bt ON ty.is_user_defined = 1 AND ty.is_assembly_type = 0 AND ty.is_table_type = 0 AND bt.user_type_id = ty.system_type_id "
            + "LEFT JOIN sys.xml_schema_collections AS xs ON p.xml_collection_id <> 0 AND xs.xml_collection_id = p.xml_collection_id "
            + "LEFT JOIN sys.schemas AS xss ON xss.schema_id = xs.schema_id",
        Where = _ => "p.object_id = @object_id AND p.parameter_id > 0", Keys = ["p.parameter_id"],
        Select = _ => "p.name, ty.name, ty.is_user_defined, ty.is_assembly_type, ty.is_table_type, tys.name, bt.name, p.max_length, p.precision, p.scale, p.is_output, "
            + "p.is_readonly, p.has_default_value, p.is_xml_document, xss.name, xs.name, p.is_cursor_ref",
        Map = row =>
        {
            var prelude = row.Context.Prelude as ParameterPrelude;
            var name = row.S(0)!;
            var type = new SqlTypeInfo(row.S(1)!, row.I(7), row.I(8), row.I(9), row.B(2), row.B(3), row.B(4), row.S(6), row.B(13), row.S(14), row.S(15), null, row.S(5));
            bool? hasDefault = prelude is { ObjectType: var objectType } && ClrModules.Contains(objectType) ? row.B(12) : prelude?.Defaults?.Contains(name);
            var output = row.B(10);
            // A CURSOR parameter is catalogued with user_type_id 56 (int); only is_cursor_ref says what it is.
            var typeText = row.B(16) ? "cursor" : ExplorerLabels.TypeText(type);
            return Node(row.Context, Child(row.Context, "parameter", name), name, output ? "output" : "input", ExplorerLabels.ParameterSublabel(typeText, output, row.B(11), hasDefault));
        },
        Tail = context => context.Prelude is ParameterPrelude prelude
            ? Node(context, Child(context, "returnValue", null), ExplorerLabels.ReturnLabel(prelude.ObjectType, prelude.ReturnType))
            : null
    };

    private static ExplorerQuery KeysQuery() => ChildList("keys",
        _ => "(SELECT kc.name, kc.type, CONVERT(bit, 0) AS is_disabled, CONVERT(bit, 0) AS is_not_trusted, kc.create_date FROM sys.key_constraints AS kc WHERE kc.parent_object_id = @object_id "
            + "UNION ALL SELECT fk.name, fk.type, fk.is_disabled, fk.is_not_trusted, fk.create_date FROM sys.foreign_keys AS fk WHERE fk.parent_object_id = @object_id) AS k",
        "k.name", _ => "k.type, k.is_disabled, k.is_not_trusted, k.create_date",
        row =>
        {
            var subtype = row.Code(0) switch { "PK" => "primary", "UQ" => "unique", _ => "foreign" };
            return Node(row.Context, Child(row.Context, "key", row.Key(0)), row.Key(0), subtype, null, row.B(2) ? "Not trusted" : null, Disabled(row.B(1)), row.D(3));
        });

    private static ExplorerQuery ConstraintsQuery() => ChildList("constraints",
        r => "(SELECT cc.name, cc.type, cc.is_disabled, cc.is_not_trusted, cc.create_date FROM sys.check_constraints AS cc WHERE cc.parent_object_id = @object_id "
            + "UNION ALL SELECT dc.name, dc.type, CONVERT(bit, 0), CONVERT(bit, 0), dc.create_date FROM sys.default_constraints AS dc WHERE dc.parent_object_id = @object_id"
            + (r.Band >= 15 ? " UNION ALL SELECT ec.name, ec.type, ec.is_disabled, ec.is_not_trusted, ec.create_date FROM sys.edge_constraints AS ec WHERE ec.parent_object_id = @object_id" : "")
            + ") AS k",
        "k.name", _ => "k.type, k.is_disabled, k.is_not_trusted, k.create_date",
        row =>
        {
            var subtype = row.Code(0) switch { "D" => "default", "EC" => "edge", _ => "check" };
            return Node(row.Context, Child(row.Context, "constraint", row.Key(0)), row.Key(0), subtype, null, row.B(2) ? "Not trusted" : null, Disabled(row.B(1)), row.D(3));
        });

    public static readonly IReadOnlyDictionary<string, ExplorerQuery> All = new ExplorerQuery[]
    {
        Databases("userDatabases", "d.database_id > 4 AND d.is_distributor = 0 AND d.source_database_id IS NULL", null),
        Databases("systemDatabases", "(d.database_id <= 4 OR d.is_distributor = 1)", "system"),
        Databases("databaseSnapshots", "d.source_database_id IS NOT NULL", "snapshot"),
        ServerList("logins", "login", "sys.server_principals AS p", "p.name",
            "p.is_disabled, CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.server_permissions AS sp WHERE sp.grantee_principal_id = p.principal_id AND sp.type = 'COSQ' AND sp.state = 'D') THEN 1 ELSE 0 END), p.create_date",
            row => ServerObject(row, "login", status: Disabled(row.B(0) || row.B(1)), created: row.D(2)), "p.type IN ('S', 'U', 'G', 'C', 'K', 'E', 'X')", new(Name: "p.name", Created: "p.create_date")),
        ServerList("serverRoles", "serverRole", "sys.server_principals AS p", "p.name", "p.is_fixed_role, p.create_date",
            row => ServerObject(row, "serverRole", detail: row.B(0) ? "Fixed server role" : null, created: row.D(1)), "p.type = 'R'"),
        ServerList("credentials", "credential", "sys.credentials AS c", "c.name", "c.create_date", row => ServerObject(row, "credential", created: row.D(0))),
        ServerList("cryptographicProviders", "cryptographicProvider", "sys.cryptographic_providers AS c", "c.name", "c.is_enabled",
            row => ServerObject(row, "cryptographicProvider", status: Disabled(!row.B(0)))),
        ServerList("audits", "audit", "sys.server_audits AS a", "a.name", "a.is_state_enabled, a.create_date",
            row => ServerObject(row, "audit", status: Disabled(!row.B(0)), created: row.D(1))),
        ServerList("serverAuditSpecifications", "serverAuditSpecification", "sys.server_audit_specifications AS a", "a.name", "a.is_state_enabled, a.create_date",
            row => ServerObject(row, "serverAuditSpecification", status: Disabled(!row.B(0)), created: row.D(1))),
        ServerList("backupDevices", "backupDevice", "sys.backup_devices AS b", "b.name", "b.physical_name", row => ServerObject(row, "backupDevice", detail: row.S(0))),
        ServerList("linkedServers", "linkedServer", "sys.servers AS s", "s.name", "s.product, s.provider",
            row => ServerObject(row, "linkedServer", detail: ExplorerLabels.Join([row.S(0) is { Length: > 0 } product ? "Product " + product : null, row.S(1) is { } provider ? "Provider " + provider : null])),
            "s.server_id > 0 AND s.is_linked = 1"),
        ServerList("serverTriggers", "serverTrigger", "sys.server_triggers AS t", "t.name", "t.is_disabled, t.create_date",
            row => ServerObject(row, "serverTrigger", status: Disabled(row.B(0)), created: row.D(1))),

        Tables("tables", r => "t.is_ms_shipped = 0 AND ep.major_id IS NULL AND t.is_filetable = 0 AND " + r.Col(13, "t.is_external", "CONVERT(bit, 0)") + " = 0 AND "
            + r.Col(14, "t.is_node", "CONVERT(bit, 0)") + " = 0 AND " + r.Col(14, "t.is_edge", "CONVERT(bit, 0)") + " = 0 AND " + r.Col(13, "t.temporal_type", "CONVERT(tinyint, 0)") + " <> 1 AND "
            + r.Col(16, "t.ledger_type", "CONVERT(tinyint, 0)") + " <> 1 AND " + r.Col(16, "t.is_dropped_ledger_table", "CONVERT(bit, 0)") + " = 0", Full, candidates: true),
        Tables("systemTables", _ => "(t.is_ms_shipped = 1 OR ep.major_id IS NOT NULL)", SchemaNamed),
        Tables("fileTables", _ => "t.is_filetable = 1", Full),
        Tables("externalTables", r => r.Col(13, "t.is_external", "CONVERT(bit, 0)") + " = 1", Full),
        Tables("graphTables", r => "(" + r.Col(14, "t.is_node", "CONVERT(bit, 0)") + " = 1 OR " + r.Col(14, "t.is_edge", "CONVERT(bit, 0)") + " = 1)", Full),
        Tables("droppedLedgerTables", r => r.Col(16, "t.is_dropped_ledger_table", "CONVERT(bit, 0)") + " = 1 AND " + r.Col(16, "t.ledger_type", "CONVERT(tinyint, 0)") + " <> 1", SchemaNamed),
        new ExplorerQuery
        {
            Id = "views", Scope = QueryScope.Database, Keyset = Keyset.SchemaName, From = _ => "sys.views AS v JOIN sys.schemas AS s ON s.schema_id = v.schema_id",
            Where = r => "v.is_ms_shipped = 0 AND " + r.Col(16, "v.is_dropped_ledger_view", "CONVERT(bit, 0)") + " = 0", Keys = ["s.name", "v.name"],
            Select = r => "v.create_date, own.name, " + r.Col(16, "v.ledger_view_type", "CONVERT(tinyint, 0)"), OwnerJoin = SchemaOwner("v"), RowsNeedOwner = true, Filter = Columns(Full, "v"),
            Map = row => SchemaObject(row, "view", row.I(2) == 1 ? "ledger" : null, detail: Owner(row.S(1)), created: row.D(0))
        },
        SchemaList("systemViews", "sys.all_views AS v JOIN sys.schemas AS s ON s.schema_id = v.schema_id", "v", "v.is_ms_shipped = 1", "v.create_date",
            row => SchemaObject(row, "view", "system", created: row.D(0)), SchemaNamed),
        new ExplorerQuery
        {
            Id = "droppedLedgerViews", Scope = QueryScope.Database, Keyset = Keyset.SchemaName, From = _ => "sys.views AS v JOIN sys.schemas AS s ON s.schema_id = v.schema_id",
            Where = r => r.Col(16, "v.is_dropped_ledger_view", "CONVERT(bit, 0)") + " = 1", Keys = ["s.name", "v.name"], Select = _ => "v.create_date",
            Filter = Columns(SchemaNamed, "v"), Map = row => SchemaObject(row, "view", "droppedLedger", created: row.D(0))
        },
        DatabaseList("externalDataSources", "sys.external_data_sources AS e", "e.name", "e.location",
            row => DatabaseObject(row, "externalDataSource", detail: row.S(0) is { } location ? "Location " + location : null)),
        DatabaseList("externalFileFormats", "sys.external_file_formats AS f", "f.name", "f.format_type",
            row => DatabaseObject(row, "externalFileFormat", detail: row.S(0) is { } format ? "Format " + format : null)),
        SchemaList("synonyms", "sys.synonyms AS sy JOIN sys.schemas AS s ON s.schema_id = sy.schema_id", "sy", null, "sy.create_date, sy.base_object_name, own.name",
            row => SchemaObject(row, "synonym", detail: ExplorerLabels.Join(["Refers to " + row.S(1), Owner(row.S(2))]), created: row.D(0)), Full, owner: true),
        SchemaList("procedures", "sys.procedures AS p JOIN sys.schemas AS s ON s.schema_id = p.schema_id " + Tools("p"), "p",
            "p.type IN ('P', 'PC') AND p.is_ms_shipped = 0 AND ep.major_id IS NULL", "p.type, p.create_date, own.name",
            row => SchemaObject(row, "procedure", ExplorerLabels.ProcedureSubtype(row.Code(0)), detail: Owner(row.S(2)), created: row.D(1)), Full, owner: true),
        SchemaList("systemProcedures", "sys.all_objects AS p JOIN sys.schemas AS s ON s.schema_id = p.schema_id " + Tools("p"), "p",
            "p.type IN ('P', 'PC', 'X', 'RF') AND (p.is_ms_shipped = 1 OR ep.major_id IS NOT NULL)", "p.type, p.create_date",
            // Extended and replication-filter procedures keep their own subtype, which Script As defers.
            row => SchemaObject(row, "procedure", row.Code(0) is "X" or "RF" ? ExplorerLabels.ProcedureSubtype(row.Code(0)) : "system", created: row.D(1)), SchemaNamed),
        Functions("tableValuedFunctions", "'IF', 'TF', 'FT'", Full),
        Functions("scalarFunctions", "'FN', 'FS'", Full),
        Functions("aggregateFunctions", "'AF'", SchemaNamed),
        DatabaseList("databaseTriggers", "sys.triggers AS t", "t.name", "t.is_disabled, t.create_date",
            row => DatabaseObject(row, "databaseTrigger", status: Disabled(row.B(0)), created: row.D(1)), "t.parent_class = 0"),
        DatabaseList("assemblies", "sys.assemblies AS a", "a.name", "a.create_date, own.name",
            row => DatabaseObject(row, "assembly", detail: Owner(row.S(1)), created: row.D(0)), filter: new(Name: "a.name", Owner: "own.name", Created: "a.create_date"),
            ownerJoin: "LEFT JOIN sys.database_principals AS own ON own.principal_id = a.principal_id"),
        SchemaList("aliasTypes", "sys.types AS ty JOIN sys.schemas AS s ON s.schema_id = ty.schema_id JOIN sys.types AS bt ON bt.user_type_id = ty.system_type_id", "ty",
            "ty.is_user_defined = 1 AND ty.is_assembly_type = 0 AND ty.is_table_type = 0", "bt.name, ty.max_length, ty.precision, ty.scale, ty.is_nullable",
            row => SchemaObject(row, "type", "alias", "(" + ExplorerLabels.TypeText(new SqlTypeInfo(row.S(0)!, row.I(1), row.I(2), row.I(3))) + ", " + (row.B(4) ? "null" : "not null") + ")"),
            SchemaNamed),
        SchemaList("tableTypes", "sys.table_types AS tt JOIN sys.schemas AS s ON s.schema_id = tt.schema_id JOIN sys.objects AS o ON o.object_id = tt.type_table_object_id", "tt",
            null, "o.create_date", row => SchemaObject(row, "tableType", created: row.D(0)), SchemaNamed),
        SchemaList("clrTypes", "sys.assembly_types AS ty JOIN sys.schemas AS s ON s.schema_id = ty.schema_id", "ty", "ty.is_user_defined = 1", "",
            row => SchemaObject(row, "type", "clr"), SchemaNamed),
        SchemaList("xmlSchemaCollections", "sys.xml_schema_collections AS x JOIN sys.schemas AS s ON s.schema_id = x.schema_id", "x", "x.xml_collection_id > 1", "x.create_date",
            row => SchemaObject(row, "xmlSchemaCollection", created: row.D(0)), SchemaNamed),
        SchemaList("rules", "sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id", "o", "o.type = 'R' AND o.is_ms_shipped = 0", "o.create_date",
            row => SchemaObject(row, "rule", created: row.D(0)), SchemaNamed),
        SchemaList("defaults", "sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id", "o", "o.type = 'D' AND o.parent_object_id = 0 AND o.is_ms_shipped = 0", "o.create_date",
            row => SchemaObject(row, "default", created: row.D(0)), SchemaNamed),
        DatabaseList("planGuides", "sys.plan_guides AS g", "g.name", "g.is_disabled, g.create_date",
            row => DatabaseObject(row, "planGuide", status: Disabled(row.B(0)), created: row.D(1))),
        SchemaList("sequences", "sys.sequences AS sq JOIN sys.schemas AS s ON s.schema_id = sq.schema_id", "sq", null, "sq.create_date, own.name",
            row => SchemaObject(row, "sequence", detail: Owner(row.S(1)), created: row.D(0)), Full, owner: true),
        DatabaseList("fullTextCatalogs", "sys.fulltext_catalogs AS c", "c.name", "c.is_default", row => DatabaseObject(row, "fullTextCatalog", detail: row.B(0) ? "Default catalog" : null)),
        DatabaseList("partitionSchemes", "sys.partition_schemes AS ps JOIN sys.partition_functions AS pf ON pf.function_id = ps.function_id", "ps.name", "pf.name",
            row => DatabaseObject(row, "partitionScheme", detail: "Function " + row.S(0))),
        DatabaseList("partitionFunctions", "sys.partition_functions AS pf", "pf.name", "pf.create_date, pf.fanout",
            row => DatabaseObject(row, "partitionFunction", detail: row.I(1).ToString(CultureInfo.InvariantCulture) + " partitions", created: row.D(0)),
            filter: new(Name: "pf.name", Created: "pf.create_date")),
        DatabaseList("fullTextStoplists", "sys.fulltext_stoplists AS sl", "sl.name", "sl.create_date", row => DatabaseObject(row, "fullTextStoplist", created: row.D(0))),
        DatabaseList("searchPropertyLists", "sys.registered_search_property_lists AS sp", "sp.name", "sp.create_date", row => DatabaseObject(row, "searchPropertyList", created: row.D(0))),
        DatabaseList("users", "sys.database_principals AS dp", "dp.name",
            "dp.create_date, CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.database_permissions AS pe WHERE pe.grantee_principal_id = dp.principal_id AND pe.type = 'CO' AND pe.state IN ('G', 'W')) THEN 1 ELSE 0 END)",
            row => DatabaseObject(row, "user", status: Disabled(!row.B(1)), created: row.D(0)), "dp.type IN ('S', 'U', 'G', 'E', 'X', 'C', 'K')",
            new(Name: "dp.name", Created: "dp.create_date")),
        DatabaseList("databaseRoles", "sys.database_principals AS dp", "dp.name", "dp.is_fixed_role, dp.create_date, own.name",
            row => DatabaseObject(row, "databaseRole", detail: ExplorerLabels.Join([row.B(0) ? "Fixed database role" : null, Owner(row.S(2))]), created: row.D(1)), "dp.type = 'R'",
            new(Name: "dp.name", Owner: "own.name"), "LEFT JOIN sys.database_principals AS own ON own.principal_id = dp.owning_principal_id"),
        DatabaseList("applicationRoles", "sys.database_principals AS dp", "dp.name", "dp.create_date", row => DatabaseObject(row, "applicationRole", created: row.D(0)), "dp.type = 'A'"),
        DatabaseList("schemas", "sys.schemas AS sc", "sc.name", "own.name", row => DatabaseObject(row, "schema", detail: Owner(row.S(0))),
            filter: new(Name: "sc.name", Owner: "own.name"), ownerJoin: "LEFT JOIN sys.database_principals AS own ON own.principal_id = sc.principal_id"),
        DatabaseList("asymmetricKeys", "sys.asymmetric_keys AS k", "k.name", "k.algorithm_desc", row => DatabaseObject(row, "asymmetricKey", detail: row.S(0) is { } algorithm ? "Algorithm " + algorithm : null)),
        DatabaseList("certificates", "sys.certificates AS c", "c.name", "c.subject, c.expiry_date",
            row => DatabaseObject(row, "certificate", detail: ExplorerLabels.Join([row.S(0) is { Length: > 0 } subject ? "Subject " + subject : null,
                row.D(1) is { } expiry ? "Expires " + expiry.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) : null]))),
        DatabaseList("symmetricKeys", "sys.symmetric_keys AS k", "k.name", "k.create_date, k.algorithm_desc",
            row => DatabaseObject(row, "symmetricKey", detail: row.S(1) is { } algorithm ? "Algorithm " + algorithm : null, created: row.D(0))),
        DatabaseList("columnMasterKeys", "sys.column_master_keys AS k", "k.name", "k.create_date, k.key_store_provider_name",
            row => DatabaseObject(row, "columnMasterKey", detail: row.S(1) is { } store ? "Key store " + store : null, created: row.D(0))),
        DatabaseList("columnEncryptionKeys", "sys.column_encryption_keys AS k", "k.name", "k.create_date", row => DatabaseObject(row, "columnEncryptionKey", created: row.D(0))),
        DatabaseList("databaseAuditSpecifications", "sys.database_audit_specifications AS a", "a.name", "a.is_state_enabled, a.create_date",
            row => DatabaseObject(row, "databaseAuditSpecification", status: Disabled(!row.B(0)), created: row.D(1))),
        SchemaList("securityPolicies", "sys.security_policies AS p JOIN sys.schemas AS s ON s.schema_id = p.schema_id", "p", null, "p.is_enabled, p.create_date",
            row => SchemaObject(row, "securityPolicy", status: Disabled(!row.B(0)), created: row.D(1)), SchemaNamed),

        ColumnsQuery(),
        KeysQuery(),
        ConstraintsQuery(),
        ChildList("tableTriggers", _ => "sys.triggers AS t", "t.name", _ => "t.is_disabled, t.is_instead_of_trigger, t.create_date",
            row => Node(row.Context, Child(row.Context, "trigger", row.Key(0)), row.Key(0), null, null, row.B(1) ? "INSTEAD OF" : "AFTER", Disabled(row.B(0)), row.D(2)),
            "t.parent_id = @object_id"),
        ChildList("indexes", _ => "sys.indexes AS i LEFT JOIN sys.xml_indexes AS xi ON xi.object_id = i.object_id AND xi.index_id = i.index_id", "i.name",
            _ => "i.type, i.type_desc, i.is_unique, i.is_primary_key, i.is_disabled, i.has_filter, CONVERT(bit, CASE WHEN xi.using_xml_index_id IS NULL THEN 1 ELSE 0 END)",
            row =>
            {
                var type = row.I(0);
                return Node(row.Context, Child(row.Context, "index", row.Key(0)), row.Key(0), ExplorerLabels.IndexSubtype(type), ExplorerLabels.IndexSublabel(type, row.B(2), row.B(6), row.S(1)),
                    ExplorerLabels.Join([row.B(3) ? "Primary key" : null, row.B(5) ? "Filtered" : null]), Disabled(row.B(4)));
            }, "i.object_id = @object_id AND i.type > 0 AND i.is_hypothetical = 0"),
        ChildList("statistics", _ => "sys.stats AS st", "st.name", _ => "st.auto_created, st.user_created",
            row => Node(row.Context, Child(row.Context, "statistic", row.Key(0)), row.Key(0), null, null, row.B(0) ? "Auto-created" : row.B(1) ? "User-created" : null),
            "st.object_id = @object_id"),
        ParametersQuery(),

        SsisCatalogs(),
        SsisList("ssisFolders", "[catalog].[folders] AS f", "f.name", "f.description, f.created_time", null, null,
            row => Node(row.Context, new ObjectRefDto("ssisFolder", Name: row.Key(0)), row.Key(0), detail: row.S(0), created: row.T(1)?.DateTime)),
        SsisList("ssisProjects", "[catalog].[projects] AS p", "p.name", "p.last_deployed_time, p.description, p.deployed_by_name", "p.folder_id = @owner_id", FolderOwner,
            row => Node(row.Context, new ObjectRefDto("ssisProject", Name: row.Key(0), SsisFolder: row.Context.Owner.Name), row.Key(0), sublabel: ExplorerLabels.Deployed(row.T(0)),
                detail: ExplorerLabels.Join([row.S(1), row.S(2) is { } by ? "Deployed by " + by : null]))),
        SsisList("ssisEnvironments", "[catalog].[environments] AS e", "e.name",
            "(SELECT COUNT_BIG(*) FROM [catalog].[environment_variables] AS v WHERE v.environment_id = e.environment_id), e.description, e.created_time", "e.folder_id = @owner_id", FolderOwner,
            row => Node(row.Context, new ObjectRefDto("ssisEnvironment", Name: row.Key(0), SsisFolder: row.Context.Owner.Name), row.Key(0), sublabel: ExplorerLabels.Variables(row.I(0)),
                detail: row.S(1), created: row.T(2)?.DateTime)),
        // Package names can be longer than a sysname cursor key (nvarchar(260)), so packages page by package_id: deployment order.
        new ExplorerQuery
        {
            Id = "ssisPackages", Scope = QueryScope.Ssis, Keyset = Keyset.Id, OwnerLookup = ProjectOwner, From = _ => "[catalog].[packages] AS pk", Where = _ => "pk.project_id = @owner_id",
            Keys = ["pk.package_id"], Select = _ => "pk.name, pk.entry_point, pk.description", Filter = new(Name: "pk.name"),
            Map = row => Node(row.Context, new ObjectRefDto("ssisPackage", Name: row.S(0), SsisFolder: row.Context.Owner.SsisFolder, SsisProject: row.Context.Owner.Name), row.S(0)!,
                row.B(1) ? "entryPoint" : "child", detail: ExplorerLabels.Join([row.B(1) ? null : "Not an entry point", row.S(2)]))
        }
    }.ToDictionary(query => query.Id, StringComparer.Ordinal);

    // --- SSIS Catalog (D-ssis 3.2) ---------------------------------------------------------------------------------------

    /// <summary>The catalog's database, if this server has one: the parameter is SSISDB (or the checks' fake catalog). On
    /// Linux no catalog can exist, and Azure SQL Database lists other databases only to a connection in master.</summary>
    private static ExplorerQuery SsisCatalogs() => new()
    {
        Id = "ssisCatalogs", Scope = QueryScope.Server, ChecksAccess = true, From = _ => "sys.databases AS d", Where = _ => "d.name = @ssis_catalog", Keys = ["d.name"],
        Select = _ => "d.state, d.user_access, d.is_read_only, d.is_in_standby, CONVERT(bit, ISNULL(CASE WHEN d.user_access = 1 THEN 1 ELSE HAS_DBACCESS(d.name) END, 0))",
        Map = row =>
        {
            var (sublabel, status, hasChildren) = ExplorerLabels.Database(row.I(0), row.I(1), row.B(2), row.B(3), row.B(4));
            return Node(row.Context, new ObjectRefDto("ssisCatalog", Name: row.Key(0)), row.Key(0), null, sublabel, status: status, hasChildren: hasChildren);
        },
        WhenEmpty = context => context.Profile.Linux ? ExplorerErrors.Create("NOT_SUPPORTED", "Integration Services Catalogs", null, 0, "The SSIS Catalog isn't supported on SQL Server on Linux.")
            : context.Profile.Cloud ? ExplorerErrors.Create("NOT_SUPPORTED", "Integration Services Catalogs", null, 0,
                "No SSIS Catalog is visible. On Azure SQL Database, connect with Database set to SSISDB or master to see it.")
            : null
    };

    private static ExplorerQuery SsisList(string id, string from, string key, string select, string? where, Func<SqlRender, string>? owner, Func<Row, ExplorerNode> map) => new()
    {
        Id = id, Scope = QueryScope.Ssis, OwnerLookup = owner, From = _ => from, Where = where is null ? null : _ => where, Keys = [key], Select = _ => select, Filter = new(Name: key), Map = map
    };

    private const string OwnerFound = "SELECT CONVERT(bit, CASE WHEN @owner_id IS NULL THEN 0 ELSE 1 END);\nIF @owner_id IS NULL RETURN;\n";
    /// <summary>A folder's projects and environments: the folder by its name (@object_name).</summary>
    private static string FolderOwner(SqlRender _) => "DECLARE @owner_id bigint;\nSELECT @owner_id = f.folder_id FROM [catalog].[folders] AS f WHERE f.name = @object_name;\n" + OwnerFound;
    /// <summary>A project's packages: the project by its folder (@ssis_folder) and name (@object_name).</summary>
    private static string ProjectOwner(SqlRender _) => "DECLARE @owner_id bigint;\nSELECT @owner_id = p.project_id FROM [catalog].[projects] AS p JOIN [catalog].[folders] AS f ON f.folder_id = p.folder_id "
        + "WHERE f.name = @ssis_folder AND p.name = @object_name;\n" + OwnerFound;

    /// <summary>The SSIS Catalog's database state and user access (server scope), after its pool could not open it: no row when it does not exist.</summary>
    public const string SsisCatalogState = "SELECT d.state, d.user_access FROM sys.databases AS d WHERE d.name = @ssis_catalog;";

    private static ExplorerQuery Functions(string id, string types, string[] filters) => SchemaList(id, "sys.objects AS o JOIN sys.schemas AS s ON s.schema_id = o.schema_id", "o",
        "o.type IN (" + types + ") AND o.is_ms_shipped = 0", "o.type, o.create_date, own.name",
        row => SchemaObject(row, "function", ExplorerLabels.FunctionSubtype(row.Code(0)), detail: Owner(row.S(2)), created: row.D(1)), filters, owner: true);

    /// <summary>The history row of a temporal or updatable ledger table: whether the table still exists, then its history table.</summary>
    public static string HistoryTable(SqlRender r) =>
        "SELECT CONVERT(bit, CASE WHEN EXISTS (SELECT 1 FROM sys.tables AS t JOIN sys.schemas AS ts ON ts.schema_id = t.schema_id WHERE ts.name = @object_schema AND t.name = @object_name) THEN 1 ELSE 0 END);\n"
        + "SELECT hs.name, h.name, h.create_date, " + r.Col(16, "h.ledger_type", "CONVERT(tinyint, 0)") + " FROM sys.tables AS t JOIN sys.schemas AS ts ON ts.schema_id = t.schema_id "
        + "JOIN sys.tables AS h ON h.object_id = " + r.Col(13, "t.history_table_id", "CONVERT(int, NULL)") + " JOIN sys.schemas AS hs ON hs.schema_id = h.schema_id "
        + "WHERE ts.name = @object_schema AND t.name = @object_name;";

    /// <summary>Whether a database can be expanded: its state, user access and the login's access (server scope).</summary>
    public const string DatabaseState = "SELECT d.state, d.user_access, CONVERT(bit, ISNULL(HAS_DBACCESS(d.name), 0)) FROM sys.databases AS d WHERE d.name = @object_name;";
}
