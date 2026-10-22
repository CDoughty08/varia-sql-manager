using System.Text;
using System.Text.RegularExpressions;

namespace Varia.Backend.Explorer;

/// <summary>Which filter operators a request uses, per property: the only part of a filter that reaches SQL text (the
/// values are parameters).</summary>
internal readonly record struct FilterShape(string? Name = null, string? Schema = null, string? Owner = null, string? Created = null)
{
    public static FilterShape From(ExplorerFilterDto? filter) => new(filter?.Name?.Op, filter?.Schema?.Op, filter?.Owner?.Op, filter?.Created?.Op);
}

/// <summary>Everything a statement's text depends on: the version band, the probe flags, the filter shape, and for child
/// folders the parent's kind. Two requests with equal renders run the same text, so plans are cached.</summary>
internal readonly record struct SqlRender(int Band, bool VectorDimensions = false, FilterShape Filter = default, string? ParentKind = null)
{
    /// <summary>A catalog column that exists from <paramref name="since"/>, or a constant of the same type before it.</summary>
    public string Col(int since, string expression, string fallback) => Band >= since ? expression : fallback;
}

/// <summary>The catalog columns a folder's filter properties apply to.</summary>
internal sealed record FilterColumns(string? Name = null, string? Schema = null, string? Owner = null, string? Created = null);

/// <summary>Fixed SQL text shared by every Object Explorer statement, and the offline lint that every rendered statement
/// passes (ExplorerChecks renders each query for every band, flag and filter shape).</summary>
internal static partial class CatalogSql
{
    /// <summary>Browsing never waits more than 5 s behind another session's uncommitted DDL, and loses deadlocks.</summary>
    public const string Prologue = "SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SET LOCK_TIMEOUT 5000; SET DEADLOCK_PRIORITY LOW;\n";
    /// <summary>One declaration list for every statement, so the scope wrapper's text is constant.</summary>
    public const string Declarations = "@object_schema sysname, @object_name sysname, @k1 sysname, @k2 sysname, @kn int, @take int, @first bit, "
        + "@fname nvarchar(400), @fschema nvarchar(400), @fowner nvarchar(400), @d1 date, @d2 date";
    /// <summary>Runs @stmt in another database without a connection (or pool) per database: the name reaches T-SQL only
    /// through QUOTENAME.</summary>
    public const string ModuleCall = "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\n"
        + "EXEC @module @stmt, @decl, @object_schema = @object_schema, @object_name = @object_name, @k1 = @k1, @k2 = @k2, @kn = @kn, @take = @take, "
        + "@first = @first, @fname = @fname, @fschema = @fschema, @fowner = @fowner, @d1 = @d1, @d2 = @d2;";

    /// <summary>The filter fragments, each "AND (…)", for the properties the shape uses.</summary>
    public static string Filters(FilterShape shape, FilterColumns columns)
    {
        var text = new StringBuilder();
        void Add(string? op, string? column, Func<string, string, string> fragment)
        {
            if (op is null) return;
            if (column is null) throw new InvalidOperationException("The query has no column for this filter.");
            text.Append(" AND (").Append(fragment(column, op)).Append(')');
        }
        Add(shape.Name, columns.Name, (column, op) => Text(column, op, "@fname"));
        Add(shape.Schema, columns.Schema, (column, op) => Text(column, op, "@fschema"));
        Add(shape.Owner, columns.Owner, (column, op) => Text(column, op, "@fowner"));
        Add(shape.Created, columns.Created, Date);
        return text.ToString();
    }

    public static string Text(string column, string op, string parameter) => op switch
    {
        "contains" => column + " LIKE N'%' + " + parameter + " + N'%' ESCAPE N'\\'",
        "notContains" => column + " NOT LIKE N'%' + " + parameter + " + N'%' ESCAPE N'\\'",
        "equals" => column + " = " + parameter,
        _ => throw new InvalidOperationException("Unknown text filter operator.")
    };

    /// <summary>create_date is server local time, compared by its date part: a day after 9999-12-31 cannot be computed.</summary>
    public static string Date(string column, string op)
    {
        var day = "CONVERT(date, " + column + ")";
        return op switch
        {
            "equals" => day + " = @d1",
            "lessThan" => day + " < @d1",
            "lessOrEqual" => day + " <= @d1",
            "greaterThan" => day + " > @d1",
            "greaterOrEqual" => day + " >= @d1",
            "between" => day + " BETWEEN @d1 AND @d2",
            "notBetween" => day + " NOT BETWEEN @d1 AND @d2",
            _ => throw new InvalidOperationException("Unknown date filter operator.")
        };
    }

    /// <summary>A LIKE operand matches its text literally under ESCAPE N'\'.</summary>
    public static string EscapeLike(string value) => value.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_").Replace("[", "\\[");

    /// <summary>The kinds' catalog types for a child folder's parent lookup.</summary>
    public static string ParentLookup(string parentKind) => parentKind switch
    {
        "tableType" => "DECLARE @object_id int;\nSELECT @object_id = tt.type_table_object_id FROM sys.table_types AS tt JOIN sys.schemas AS ps ON ps.schema_id = tt.schema_id "
            + "WHERE ps.name = @object_schema AND tt.name = @object_name;\n" + ParentFound,
        _ => "DECLARE @object_id int;\nSELECT @object_id = po.object_id FROM sys.all_objects AS po JOIN sys.schemas AS ps ON ps.schema_id = po.schema_id "
            + "WHERE ps.name = @object_schema AND po.name = @object_name AND po.type IN (" + parentKind switch
            {
                "table" => "'U', 'ET'",
                "view" => "'V'",
                "procedure" => "'P', 'PC', 'X', 'RF'",
                "function" => "'IF', 'TF', 'FT', 'FN', 'FS', 'AF'",
                _ => throw new InvalidOperationException("Unknown parent kind.")
            } + ");\n" + ParentFound
    };

    private const string ParentFound = "SELECT CONVERT(bit, CASE WHEN @object_id IS NULL THEN 0 ELSE 1 END);\nIF @object_id IS NULL RETURN;\n";

    // Metadata functions ignore the isolation level and LOCK_TIMEOUT, so the catalog is read through joins only.
    internal static readonly string[] Builtins = ["OBJECT_NAME(", "OBJECT_SCHEMA_NAME(", "SCHEMA_NAME(", "TYPE_NAME(", "USER_NAME(", "SUSER_SNAME(", "SUSER_NAME(",
        "OBJECTPROPERTY", "COL_NAME(", "INDEX_COL(", "DATABASEPROPERTYEX(", "OBJECT_DEFINITION("];
    /// <summary>Catalog columns and views that appear only from a version band (B6).</summary>
    public static readonly (string Token, int Since)[] Gates =
    [
        ("temporal_type", 13), ("history_table_id", 13), ("is_external", 13), ("generated_always_type", 13), ("is_hidden", 13), ("is_masked", 13), ("encryption_type", 13),
        ("sys.external_data_sources", 13), ("sys.external_file_formats", 13), ("sys.security_policies", 13), ("sys.column_master_keys", 13), ("sys.column_encryption_keys", 13),
        ("is_node", 14), ("is_edge", 14), ("graph_type", 14), ("sys.edge_constraints", 15),
        ("ledger_type", 16), ("is_dropped_ledger_table", 16), ("ledger_view_type", 16), ("is_dropped_ledger_view", 16), ("is_dropped_ledger_column", 16),
        // Database Properties (Actions/DatabaseProperties.cs).
        ("is_ledger_on", 16), ("sys.database_scoped_configurations", 13), ("is_autogrow_all_files", 13)
    ];
    private static readonly HashSet<string> Literals = ["N'microsoft_database_tools_support'", "N'%'", "N'\\'", "N'.sys.sp_executesql'"];

    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    [GeneratedRegex(@"^'[A-Z]{1,4}'$")]
    private static partial Regex TypeLetters();

    /// <summary>Problems with one rendered statement; empty when it passes.</summary>
    /// <param name="list">A paged listing: it must take TOP (@take) rows in keyset order.</param>
    /// <param name="mayCheckAccess">Database listings may call HAS_DBACCESS.</param>
    public static List<string> Lint(string text, SqlRender render, bool list, bool mayCheckAccess)
    {
        var problems = new List<string>();
        foreach (var builtin in Builtins) if (text.Contains(builtin, StringComparison.OrdinalIgnoreCase)) problems.Add("uses " + builtin);
        if (!mayCheckAccess && text.Contains("HAS_DBACCESS(", StringComparison.OrdinalIgnoreCase)) problems.Add("uses HAS_DBACCESS outside the database listings");
        if (list && (!text.Contains("SELECT TOP (@take) ", StringComparison.Ordinal) || !text.Contains(" ORDER BY ", StringComparison.Ordinal))) problems.Add("is not a TOP (@take) keyset listing");
        foreach (var (token, since) in Gates) if (render.Band < since && text.Contains(token, StringComparison.Ordinal)) problems.Add("uses " + token + " below band " + since);
        if (!render.VectorDimensions && text.Contains("vector_dimensions", StringComparison.Ordinal)) problems.Add("uses vector_dimensions without the probe flag");
        foreach (Match literal in LiteralPattern().Matches(text))
            if (!Literals.Contains(literal.Value) && !TypeLetters().IsMatch(literal.Value)) problems.Add("has the literal " + literal.Value);
        if (text.Contains("@db", StringComparison.Ordinal)) problems.Add("names @db inside a statement");
        return problems;
    }
}
