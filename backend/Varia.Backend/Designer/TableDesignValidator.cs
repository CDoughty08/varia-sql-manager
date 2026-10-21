using System.Text.RegularExpressions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Designer;

/// <summary>A validated column: its name, the catalogue type (and its id), the parameters its kind takes, nullability,
/// and the identity's seed and increment as SQL Server writes them.</summary>
internal sealed record PlanColumn(string Name, DesignerTypeJson Type, int TypeId, int? Length, bool Max, int? Precision, int? Scale, int? Dimensions, bool AllowNulls,
    string? Seed = null, string? Increment = null)
{
    public bool Identity => Seed is not null;
    /// <summary>Stored off-row, so the table gets TEXTIMAGE_ON.</summary>
    public bool Lob => Type.Lob == true || Max;
}

/// <summary>A new table as Save creates it: names verbatim, columns in order, the key as column indexes in key order,
/// and the constraint name PK_&lt;table&gt;.</summary>
internal sealed record TablePlan(string Schema, string Name, IReadOnlyList<PlanColumn> Columns, IReadOnlyList<int> PrimaryKey, string PrimaryKeyName)
{
    /// <summary>The newest band any column's type needs (json and vector: 17), or 0.</summary>
    public int Since(DesignerCatalog catalog) => Columns.Select(column => column.Type.Since ?? 0).DefaultIfEmpty(0).Max();
}

/// <summary>Re-validates what src/shared/designer/schema.ts' zod schema accepts for createTable and normalises it into a
/// plan: sysname names (a table name not starting with #, a temporary table), catalogue types with parameters in their bounds, at most one identity and one timestamp column, an
/// identity only on the integer types or decimal and numeric with scale 0, whole-number seeds and non-zero increments, a
/// key of distinct existing columns that do not allow nulls, and the design's string budget. Messages never echo values.</summary>
internal static partial class TableDesignValidator
{
    private static RequestException Invalid(string detail) => new("INVALID_PARAMS", "Invalid object action request: " + detail);
    // \z, not $: $ also matches before a final line break, which zod's pattern refuses.
    [GeneratedRegex(@"^-?[0-9]{1,38}\z")]
    private static partial Regex WholeNumber();

    /// <summary>SQL Server's way of writing a whole number: no leading zeros, and 0 for -0 (schema.ts' canonicalNumber).</summary>
    public static string Canonical(string text)
    {
        var negative = text.StartsWith('-');
        var digits = (negative ? text[1..] : text).TrimStart('0');
        if (digits.Length == 0) digits = "0";
        return negative && digits != "0" ? "-" + digits : digits;
    }

    /// <summary>The PK_ constraint name within a sysname, never splitting a surrogate pair (catalog.ts' primaryKeyName).</summary>
    public static string PrimaryKeyName(string table)
    {
        var name = "PK_" + table;
        if (name.Length <= ExplorerRefs.MaxIdentifier) return name;
        var end = char.IsHighSurrogate(name[ExplorerRefs.MaxIdentifier - 1]) ? ExplorerRefs.MaxIdentifier - 1 : ExplorerRefs.MaxIdentifier;
        return name[..end];
    }

    public static TablePlan Validate(DesignerCatalog catalog, TableDesignDto? design)
    {
        if (design is null) throw Invalid("design is required.");
        if (!ExplorerRefs.Ident(design.Schema)) throw Invalid("design.schema.");
        if (!ExplorerRefs.Ident(design.Name)) throw Invalid("design.name.");
        // SQL Server puts a table named #… in tempdb whatever its schema (schema.ts' tableNameProblem).
        if (design.Name.StartsWith('#')) throw Invalid("a table name that starts with # (a temporary table).");
        if (design.Columns is not { Count: > 0 } columns || columns.Count > catalog.Limit("columns")) throw Invalid("design.columns.");
        if (design.PrimaryKey is not { } key || key.Count > catalog.Limit("keyColumns")) throw Invalid("design.primaryKey.");
        long chars = design.Schema.Length + design.Name.Length;
        // Trailing spaces never tell names apart (SQL Server pads); case and accents are the collation's, which SQL Server checks.
        var names = new HashSet<string>(StringComparer.Ordinal);
        var plan = new List<PlanColumn>(columns.Count);
        var identities = 0;
        var timestamps = 0;
        foreach (var column in columns)
        {
            if (column is null || !ExplorerRefs.Ident(column.Name) || !names.Add(column.Name.TrimEnd(' '))) throw Invalid("a column name.");
            if (column.Type is not { System: { } system } type || catalog.Type(system) is not { } spec) throw Invalid("a column type.");
            chars += column.Name.Length + system.Length;
            var planned = Type(catalog, spec, type, column);
            if (spec.OnePerTable == true && ++timestamps > 1) throw Invalid("a table has at most one timestamp column.");
            if (column.Identity is { } identity)
            {
                if (++identities > 1) throw Invalid("a table has at most one identity column.");
                if (spec.Identity != true || (planned.Scale ?? 0) != 0) throw Invalid("an identity column's type.");
                if (identity.Seed is not { } seed || !WholeNumber().IsMatch(seed) || identity.Increment is not { } increment || !WholeNumber().IsMatch(increment)) throw Invalid("an identity's seed or increment.");
                if (Canonical(increment) == "0") throw Invalid("an identity increment of 0.");
                if (column.AllowNulls) throw Invalid("an identity column that allows nulls.");
                chars += seed.Length + increment.Length;
                planned = planned with { Seed = Canonical(seed), Increment = Canonical(increment) };
            }
            plan.Add(planned);
        }
        if (chars > catalog.Limit("designChars")) throw Invalid("the design is too large.");
        var used = new HashSet<int>();
        foreach (var index in key)
        {
            if (index < 0 || index >= plan.Count || !used.Add(index)) throw Invalid("design.primaryKey.");
            if (plan[index].AllowNulls) throw Invalid("a primary key column that allows nulls.");
        }
        return new TablePlan(design.Schema, design.Name, plan, [.. key], PrimaryKeyName(design.Name));
    }

    /// <summary>The column's type with exactly the parameters its kind takes, each in its bounds (type-text.ts' typeProblem).</summary>
    private static PlanColumn Type(DesignerCatalog catalog, DesignerTypeJson spec, DesignTypeDto type, DesignColumnDto column)
    {
        var id = catalog.IdOf(spec.Name);
        bool Only(params string[] allowed) =>
            (type.Length is null || allowed.Contains("length")) && (type.Max is null || allowed.Contains("max")) && (type.Precision is null || allowed.Contains("precision"))
            && (type.Scale is null || allowed.Contains("scale")) && (type.Dimensions is null || allowed.Contains("dimensions"));
        static bool Between(int? value, int min, int max) => value is { } number && number >= min && number <= max;
        var row = new PlanColumn(column.Name, spec, id, null, false, null, null, null, column.AllowNulls);
        switch (spec.Params)
        {
            case "none":
                return Only() ? row : throw Invalid("a column type's parameters.");
            case "length" or "nlength":
                if (!Only("length", "max")) throw Invalid("a column type's parameters.");
                if (type.Max is { } max)
                    return max && spec.Max == true && type.Length is null ? row with { Max = true } : throw Invalid("a column type's length.");
                return Between(type.Length, catalog.Bound("length", max: false), spec.MaxLength ?? 0) ? row with { Length = type.Length } : throw Invalid("a column type's length.");
            case "precisionScale":
                if (!Only("precision", "scale") || !Between(type.Precision, catalog.Bound("precision", false), catalog.Bound("precision", true)) || !Between(type.Scale, 0, type.Precision ?? 0))
                    throw Invalid("a column type's precision or scale.");
                return row with { Precision = type.Precision, Scale = type.Scale };
            case "scale":
                return Only("scale") && Between(type.Scale, catalog.Bound("scale", false), catalog.Bound("scale", true)) ? row with { Scale = type.Scale } : throw Invalid("a column type's scale.");
            case "dimensions":
                return Only("dimensions") && Between(type.Dimensions, catalog.Bound("dimensions", false), catalog.Bound("dimensions", true)) ? row with { Dimensions = type.Dimensions }
                    : throw Invalid("a vector's dimensions.");
            default:
                throw new InvalidOperationException("Unknown parameter kind " + spec.Params);
        }
    }
}
