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
    /// <summary>@ssis_folder and @ssis_project carry the owner's SSIS folder and project, @ssis_catalog the SSIS Catalog's
    /// database (SSISDB); @kb is the bigint keyset key; @offset is where a page of Peek's module text starts.</summary>
    public const string Declarations = "@object_schema sysname, @object_name sysname, @k1 sysname, @k2 sysname, @kn int, @take int, @first bit, "
        + "@fname nvarchar(400), @fschema nvarchar(400), @fowner nvarchar(400), @d1 date, @d2 date, @ssis_folder nvarchar(128), @ssis_project nvarchar(128), @kb bigint, @ssis_catalog sysname, @offset int";
    /// <summary>Runs @stmt in another database without a connection (or pool) per database: the name reaches T-SQL only
    /// through QUOTENAME.</summary>
    public const string ModuleCall = "DECLARE @module nvarchar(300) = QUOTENAME(@db) + N'.sys.sp_executesql';\n"
        + "EXEC @module @stmt, @decl, @object_schema = @object_schema, @object_name = @object_name, @k1 = @k1, @k2 = @k2, @kn = @kn, @take = @take, "
        + "@first = @first, @fname = @fname, @fschema = @fschema, @fowner = @fowner, @d1 = @d1, @d2 = @d2, @ssis_folder = @ssis_folder, @ssis_project = @ssis_project, @kb = @kb, "
        + "@ssis_catalog = @ssis_catalog, @offset = @offset;";

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
    public static string ParentLookup(string parentKind) => ParentSelect(parentKind) + Found("@object_id");

    /// <summary>Sets @object_id to the parent object found by @object_schema and @object_name (NULL when there is none), without
    /// the found row: Peek's child lookups find the child before they answer.</summary>
    public static string ParentSelect(string parentKind) => parentKind switch
    {
        "tableType" => "DECLARE @object_id int;\nSELECT @object_id = tt.type_table_object_id FROM sys.table_types AS tt JOIN sys.schemas AS ps ON ps.schema_id = tt.schema_id "
            + "WHERE ps.name = @object_schema AND tt.name = @object_name;\n",
        _ => "DECLARE @object_id int;\nSELECT @object_id = po.object_id FROM sys.all_objects AS po JOIN sys.schemas AS ps ON ps.schema_id = po.schema_id "
            + "WHERE ps.name = @object_schema AND po.name = @object_name AND po.type IN (" + parentKind switch
            {
                "table" => "'U', 'ET'",
                "view" => "'V'",
                "procedure" => "'P', 'PC', 'X', 'RF'",
                "function" => "'IF', 'TF', 'FT', 'FN', 'FS', 'AF'",
                // Peek's own kinds, found the same way.
                "synonym" => "'SN'",
                "sequence" => "'SO'",
                _ => throw new InvalidOperationException("Unknown parent kind.")
            } + ");\n"
    };

    /// <summary>The one bit row that says whether a lookup found its object (the variable it set), and the end of the batch when
    /// it did not.</summary>
    public static string Found(string variable) => "SELECT CONVERT(bit, CASE WHEN " + variable + " IS NULL THEN 0 ELSE 1 END);\nIF " + variable + " IS NULL RETURN;\n";

    // Metadata functions ignore the isolation level: behind another session's uncommitted DDL they wait out LOCK_TIMEOUT and
    // fail with 1222 where a join under READ UNCOMMITTED returns at once (HAS_PERMS_BY_NAME waits too, then answers 0 with no
    // error), so the catalog is read through joins only. LOGINPROPERTY
    // waits on a login another session alters even under READ UNCOMMITTED (D4 P8; its one exception is ActionSql.LoginLock,
    // D4d, whose own lint lifts it for allowlisted properties only), and a password hash never leaves the server: no Varia SQL reads sys.sql_logins.password_hash or LOGINPROPERTY's
    // PasswordHash and PasswordHashAlgorithm (critic A15; "PasswordHash" covers both). Every lint built on this list refuses them.
    internal static readonly string[] Builtins = ["OBJECT_NAME(", "OBJECT_SCHEMA_NAME(", "SCHEMA_NAME(", "TYPE_NAME(", "USER_NAME(", "SUSER_SNAME(", "SUSER_NAME(",
        "OBJECTPROPERTY", "COL_NAME(", "INDEX_COL(", "DATABASEPROPERTYEX(", "OBJECT_DEFINITION(", "LOGINPROPERTY(", "password_hash", "PasswordHash"];
    /// <summary>What critic A15 refuses in every statement, whatever its lint: LOGINPROPERTY as a word (a space before its parenthesis
    /// hides nothing), a password hash by name, and a * in a statement that names sys.sql_logins, which reads password_hash without
    /// naming it (COUNT(*) aside). Every lint calls it, besides its Contains loop over <see cref="Builtins"/>.</summary>
    public static IEnumerable<string> SecretUses(string text)
    {
        // The text as written and with its names unwrapped (Names), so neither a bracket nor a comment hides a name.
        var both = text + "\n" + Names(text);
        if (LoginFunction().IsMatch(both)) yield return "uses LOGINPROPERTY";
        foreach (var token in new[] { "password_hash", "PasswordHash" }) if (both.Contains(token, StringComparison.OrdinalIgnoreCase)) yield return "uses " + token;
        if (both.Contains("sql_logins", StringComparison.OrdinalIgnoreCase) && Star().IsMatch(both)) yield return "reads sys.sql_logins through *";
        if (Unprintable().IsMatch(Rewrite(text, unwrap: true, literals: false))) yield return "has a character outside printable ASCII in its code or names";
    }
    [GeneratedRegex(@"\bLOGINPROPERTY\s*\(", RegexOptions.IgnoreCase)]
    private static partial Regex LoginFunction();
    [GeneratedRegex(@"(?<!\(\s*)\*")]
    private static partial Regex Star();

    /// <summary>Comments, literals, and bracketed or quoted identifiers, as T-SQL reads them.</summary>
    [GeneratedRegex(@"--[^\r\n]*|/\*[\s\S]*?\*/|N?'(?:[^']|'')*'|\[(?:[^\]]|\]\])*\]|""(?:[^""]|"""")*""", RegexOptions.CultureInvariant)]
    private static partial Regex Token();
    /// <summary>Code outside printable ASCII, tab and line breaks. SQL Server resolves a full-width name in brackets
    /// (l.[ｐａｓｓｗｏｒｄ_ｈａｓｈ], sys.[ｓｑｌ_ｌｏｇｉｎｓ]) as its ASCII twin, and reads some characters .NET's <c>\s</c> does not as whitespace.</summary>
    [GeneratedRegex(@"[^\x20-\x7E\t\r\n]", RegexOptions.CultureInvariant)]
    private static partial Regex Unprintable();
    /// <summary>A number and whatever is glued to it. T-SQL ends a number where its digits end, so <c>1DELETE</c> is the number 1
    /// and the keyword DELETE, which a word boundary reads as one word (as it does <c>1e1EXEC</c>, <c>$1EXEC</c>, <c>0x1INSERT</c>).</summary>
    [GeneratedRegex(@"(?<![\w@#])[0-9][\w$.]*", RegexOptions.CultureInvariant)]
    private static partial Regex Number();
    [GeneratedRegex(@"^(?:[0-9]+(?:\.[0-9]*)?|0[xX][0-9A-Fa-f]*)$", RegexOptions.CultureInvariant)]
    private static partial Regex PlainNumber();

    private static string Rewrite(string text, bool unwrap, bool literals) => Token().Replace(text, token => token.Value[0] switch
    {
        '-' or '/' => " ",
        '[' => unwrap ? token.Value[1..^1].Replace("]]", "]", StringComparison.Ordinal) : "[x]",
        '"' => unwrap ? token.Value[1..^1].Replace("\"\"", "\"", StringComparison.Ordinal) : "[x]",
        _ => literals ? token.Value : "''"
    });

    /// <summary>The text a lint reads names in: a bracketed or quoted identifier is the name it holds (l.[password_hash],
    /// sys.[sysprocesses]), and a comment is a space (OBJECT_ID/**/(…)). Literals stay as written.</summary>
    internal static string Names(string text) => Rewrite(text, unwrap: true, literals: true);

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, Regex> TokenPatterns = new(StringComparer.Ordinal);
    /// <summary>The tokens of <paramref name="tokens"/> that <paramref name="text"/> uses: written as they are, or in its
    /// <see cref="Names"/> with any whitespace before a function's parenthesis (OBJECT_ID (…)) or around a dot (sys . sysprocesses).</summary>
    internal static IEnumerable<string> Uses(string text, IEnumerable<string> tokens)
    {
        var names = Names(text);
        foreach (var token in tokens)
        {
            var pattern = TokenPatterns.GetOrAdd(token, key => new Regex(Regex.Escape(key.TrimEnd('(')).Replace(@"\.", @"\s*\.\s*", StringComparison.Ordinal) + (key.EndsWith('(') ? @"\s*\(" : ""),
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant));
            if (text.Contains(token, StringComparison.OrdinalIgnoreCase) || pattern.IsMatch(names)) yield return token;
        }
    }

    /// <summary>For the lints with a word list of writes: each number with a word glued to it, outside literals, comments and
    /// bracketed names. Only a hex literal may hold letters.</summary>
    internal static IEnumerable<string> GluedNumbers(string text)
    {
        foreach (Match number in Number().Matches(Rewrite(text, unwrap: false, literals: false)))
            if (!PlainNumber().IsMatch(number.Value)) yield return "glues a word to the number " + number.Value;
    }
    /// <summary>Catalog columns and views that appear only from a version band (B6).</summary>
    public static readonly (string Token, int Since)[] Gates =
    [
        ("temporal_type", 13), ("history_table_id", 13), ("is_external", 13), ("generated_always_type", 13), ("is_hidden", 13), ("is_masked", 13), ("encryption_type", 13),
        ("sys.external_data_sources", 13), ("sys.external_file_formats", 13), ("sys.security_policies", 13), ("sys.column_master_keys", 13), ("sys.column_encryption_keys", 13), ("sys.masked_columns", 13),
        ("is_node", 14), ("is_edge", 14), ("graph_type", 14), ("sys.edge_constraints", 15),
        ("ledger_type", 16), ("is_dropped_ledger_table", 16), ("ledger_view_type", 16), ("is_dropped_ledger_view", 16), ("is_dropped_ledger_column", 16),
        // Database Properties (Actions/DatabaseProperties.cs).
        ("is_ledger_on", 16), ("sys.database_scoped_configurations", 13), ("is_autogrow_all_files", 13),
        // Peek (Explorer/PeekSql.cs).
        ("is_query_store_on", 13), ("last_used_value", 14), ("optimize_for_sequential_key", 15), ("is_accelerated_database_recovery_on", 15),
        // Table Properties (Actions/TableProperties.cs).
        ("sys.periods", 13), ("history_retention_period", 14), ("ledger_view_id", 16)
    ];
    private static readonly HashSet<string> Literals = ["N'microsoft_database_tools_support'", "N'%'", "N'\\'", "N'.sys.sp_executesql'"];

    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    [GeneratedRegex(@"^'[A-Z]{1,4}'$")]
    private static partial Regex TypeLetters();

    /// <summary>Problems with one rendered statement; empty when it passes.</summary>
    /// <param name="list">A paged listing: it must take TOP (@take) rows in keyset order.</param>
    /// <param name="mayCheckAccess">Database listings may call HAS_DBACCESS.</param>
    /// <param name="literals">More literals this statement may hold (Peek's rows batch).</param>
    public static List<string> Lint(string text, SqlRender render, bool list, bool mayCheckAccess, IReadOnlySet<string>? literals = null)
    {
        var problems = new List<string>();
        foreach (var builtin in Uses(text, Builtins)) problems.Add("uses " + builtin);
        problems.AddRange(SecretUses(text));
        if (!mayCheckAccess && Uses(text, ["HAS_DBACCESS("]).Any()) problems.Add("uses HAS_DBACCESS outside the database listings");
        if (list && (!text.Contains("SELECT TOP (@take) ", StringComparison.Ordinal) || !text.Contains(" ORDER BY ", StringComparison.Ordinal))) problems.Add("is not a TOP (@take) keyset listing");
        foreach (var (token, since) in Gates) if (render.Band < since && text.Contains(token, StringComparison.Ordinal)) problems.Add("uses " + token + " below band " + since);
        if (!render.VectorDimensions && text.Contains("vector_dimensions", StringComparison.Ordinal)) problems.Add("uses vector_dimensions without the probe flag");
        foreach (Match literal in LiteralPattern().Matches(text))
            if (!Literals.Contains(literal.Value) && literals?.Contains(literal.Value) != true && !TypeLetters().IsMatch(literal.Value)) problems.Add("has the literal " + literal.Value);
        if (text.Contains("@db", StringComparison.Ordinal)) problems.Add("names @db inside a statement");
        return problems;
    }
}
