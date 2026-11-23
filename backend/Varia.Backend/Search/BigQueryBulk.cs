using System.Text;
using System.Text.RegularExpressions;
using Varia.Backend.BigQuery;

namespace Varia.Backend.Search;

/// <summary>
/// The billed bulk path's SQL (docs/object-search.md, BigQuery, Bulk index): region-scoped INFORMATION_SCHEMA in place of pass 2's
/// tables.get and routines.get. Constant text but for the region qualifier, which <see cref="BqNames.RegionPath"/> quotes; no value
/// reaches the text. BigQuery bills each query at least 10 MiB for every view it reads and never caches them, so the renderer sends
/// the build only after bigquery.indexEstimate's dry runs and the cost prompts (BigQueryCostService.beforeScript), and every job
/// carries the cap. <c>BigQueryIndexChecks</c> renders every template with hostile names.
/// </summary>
internal static class BigQueryBulkSql
{
    /// <summary>What BigQuery bills an INFORMATION_SCHEMA query at least, for each view it reads.</summary>
    public const long FloorBytes = 10L << 20;
    /// <summary>The most (project, location) pairs one estimate or build covers; datasets in others are read with free calls.</summary>
    public const int MaxLocations = 64;
    /// <summary>Characters of rows one dataset keeps while it is gathered (about 16 MiB); a dataset past it is read with free calls.</summary>
    public const long DatasetChars = 8_000_000;

    /// <summary>Every column and nested field with its type and description (COLUMN_FIELD_PATHS), the top-level column's position and
    /// nullability (COLUMNS: field paths carry neither) and the table's type (TABLES: a clone is a plain table to tables.list). Hidden and
    /// system columns (_PARTITIONTIME) are left out, as tables.get's schema leaves them out.</summary>
    public static string Columns(string project, string location)
    {
        var region = BqNames.RegionPath(project, location);
        return "SELECT p.table_schema, p.table_name, t.table_type, c.ordinal_position, c.is_nullable, p.field_path, p.data_type, p.description\n"
            + "FROM " + region + ".INFORMATION_SCHEMA.COLUMN_FIELD_PATHS AS p\n"
            + "JOIN " + region + ".INFORMATION_SCHEMA.COLUMNS AS c ON c.table_schema = p.table_schema AND c.table_name = p.table_name AND c.column_name = p.column_name\n"
            + "JOIN " + region + ".INFORMATION_SCHEMA.TABLES AS t ON t.table_schema = p.table_schema AND t.table_name = p.table_name\n"
            + "WHERE c.is_hidden = 'NO' AND c.is_system_defined = 'NO'\n"
            + "ORDER BY p.table_schema, p.table_name";
    }

    /// <summary>Each view's text.</summary>
    public static string Views(string project, string location) =>
        "SELECT table_schema, table_name, view_definition\nFROM " + BqNames.RegionPath(project, location) + ".INFORMATION_SCHEMA.VIEWS\nORDER BY table_schema, table_name";

    /// <summary>Each routine's body.</summary>
    public static string Routines(string project, string location) =>
        "SELECT routine_schema, routine_name, routine_definition\nFROM " + BqNames.RegionPath(project, location) + ".INFORMATION_SCHEMA.ROUTINES\nORDER BY routine_schema, routine_name";

    /// <summary>A location's queries in the order a build reads them, with the views each reads (its floor); without definitions,
    /// only the columns' (no view or routine text is kept).</summary>
    public static IReadOnlyList<(string Sql, int Views)> Queries(string project, string location, bool definitions) => definitions
        ? [(Columns(project, location), 3), (Views(project, location), 1), (Routines(project, location), 1)]
        : [(Columns(project, location), 3)];

    /// <summary>What a finished job billed at most: its bytes processed rounded up to whole MiB, at least its floor.</summary>
    public static long BilledAfter(long? processed, int views) =>
        Math.Max(views * FloorBytes, processed is > 0 and { } bytes ? (bytes + (1L << 20) - 1) / (1L << 20) * (1L << 20) : 0);

    /// <summary>A query's billed bytes as the estimate counts them: the dry run's figure, never below the floor of the views it reads.</summary>
    public static long Billed(long dryRun, int views) => Math.Max(dryRun, views * FloorBytes);
}

/// <summary>One column or nested field as COLUMN_FIELD_PATHS gives it, with its top-level column's position and nullability.</summary>
internal sealed record BigQueryBulkField(string Path, string Type, string? Description, long Ordinal, bool Nullable);

/// <summary>A table's rows from the column query: its INFORMATION_SCHEMA type and its fields; Cut when it had more than the index keeps.</summary>
internal sealed class BigQueryBulkTable(string? type)
{
    public string? Type { get; } = type;
    public List<BigQueryBulkField> Fields { get; } = [];
    public bool Cut { get; set; }
}

/// <summary>What is left of the estimate the cost prompts showed, shared by a build's locations: each job is capped at it, and a job
/// whose floor it no longer covers is not started.</summary>
internal sealed class BigQueryBulkBudget(long bytes)
{
    public long Remaining { get; set; } = bytes;
}

/// <summary>What the bulk queries returned for one dataset: tables by name, view text by name and routine bodies by name (both empty
/// without definitions).</summary>
internal sealed class BigQueryBulkDataset(string dataset)
{
    public string Dataset { get; } = dataset;
    public Dictionary<string, BigQueryBulkTable> Tables { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> Views { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> Routines { get; } = new(StringComparer.Ordinal);
    /// <summary>Characters kept so far; past <see cref="BigQueryBulkSql.DatasetChars"/> the dataset keeps nothing (<see cref="Over"/>).</summary>
    public long Chars { get; private set; }
    /// <summary>The dataset's rows went past their budget and were dropped: its objects get their details from the free calls.</summary>
    public bool Over { get; private set; }

    /// <summary>A field row for a table, keeping at most <see cref="BigQueryIndexLimits.Columns"/> (BigQuery's own limit, nested fields included).</summary>
    public void Add(string table, string? type, BigQueryBulkField field)
    {
        if (!Charge(table.Length + field.Path.Length + field.Type.Length + (field.Description?.Length ?? 0))) return;
        if (!Tables.TryGetValue(table, out var rows)) Tables[table] = rows = new(type);
        if (rows.Fields.Count >= BigQueryIndexLimits.Columns) rows.Cut = true;
        else rows.Fields.Add(field);
    }

    /// <summary>A view's text or a routine's body.</summary>
    public void AddText(Dictionary<string, string> into, string name, string text)
    {
        if (!into.ContainsKey(name) && Charge(name.Length + text.Length)) into[name] = text;
    }

    bool Charge(long chars)
    {
        if (Over) return false;
        Chars += chars;
        if (Chars <= BigQueryBulkSql.DatasetChars) return true;
        Over = true;
        Tables.Clear();
        Views.Clear();
        Routines.Clear();
        return false;
    }
}

/// <summary>How the bulk path's rows become the same details pass 2 reads (<see cref="BigQueryEntries.FromTable"/> and FromRoutine).</summary>
internal static partial class BigQueryBulk
{
    /// <summary>
    /// The detail of a listed object from its dataset's bulk rows, or null when they do not cover it, so pass 2 reads it with free
    /// calls instead: an object created after the queries ran, a view or materialized view whose text the views query lacks (it lists
    /// no materialized views), a routine the routines query lacks. Without definitions a routine needs no row (pass 2 would keep only
    /// its signature, which the bulk path does not read).
    /// </summary>
    public static BigQueryDetail? Detail(BigQueryBulkDataset rows, BigQueryEntry entry, bool definitions)
    {
        if (rows.Over) return null;
        if (entry.Kind == "bqRoutine")
            return !definitions ? new(null, null, null, [], Bulk: true) : rows.Routines.TryGetValue(entry.Name, out var body) ? new(null, null, body, [], Bulk: true) : null;
        if (entry.Kind == "bqModel" || !rows.Tables.TryGetValue(entry.Name, out var table)) return null;
        string? text = null;
        if (entry.Kind is "bqView" or "bqMaterializedView" && definitions && !rows.Views.TryGetValue(entry.Name, out text)) return null;
        return FromTable(table, text);
    }

    /// <summary>A table's fields as pass 2 flattens tables.get's schema: top-level columns by position, each STRUCT's fields below it
    /// in their declared order (read from its type text), the same names, depth, limit and type text.</summary>
    public static BigQueryDetail FromTable(BigQueryBulkTable table, string? definition)
    {
        var byPath = new Dictionary<string, BigQueryBulkField>(StringComparer.Ordinal);
        foreach (var field in table.Fields) byPath.TryAdd(field.Path, field);
        var columns = new List<BigQueryColumn>();
        var cut = table.Cut;
        void Walk(IEnumerable<(string Name, string Type, bool Nullable)> fields, string? path, int depth)
        {
            foreach (var (name, declared, nullable) in fields)
            {
                if (columns.Count >= BigQueryIndexLimits.Columns) { cut = true; return; }
                if (!BqNames.IsColumn(name)) continue;
                var full = path is null ? name : path + "." + name;
                if (!BqNames.IsFieldPath(full)) continue;
                byPath.TryGetValue(full, out var row);
                var type = row?.Type ?? declared;
                var shown = TypeText(type);
                var record = shown is "STRUCT" or "ARRAY<STRUCT>";
                columns.Add(new(full, record, shown, nullable, row?.Description));
                if (record && depth < BqNames.FieldDepth && StructBody(type) is { } body) Walk(Fields(body), full, depth + 1);
            }
        }
        Walk(table.Fields.Where(field => !field.Path.Contains('.')).OrderBy(field => field.Ordinal).Select(field => (field.Path, field.Type, field.Nullable)), null, 1);
        var subtype = table.Type switch { "CLONE" => "clone", "SNAPSHOT" => "snapshot", _ => null };
        return new(subtype, null, definition, columns, ColumnsCut: cut, Bulk: true);
    }

    /// <summary>
    /// INFORMATION_SCHEMA's type text as pass 2 shows tables.get's (<see cref="BigQueryEntries.TypeText(Google.Apis.Bigquery.v2.Data.TableFieldSchema)"/>):
    /// STRUCT for any STRUCT&lt;…&gt;, ARRAY&lt;STRUCT&gt; for a repeated one, RANGE without its element, parameters as (10, 2), and
    /// any NOT NULL, COLLATE, OPTIONS or DEFAULT after the type left out.
    /// </summary>
    public static string TypeText(string type)
    {
        var text = Bare(type);
        if (Starts(text, "ARRAY<") && text.EndsWith('>')) return "ARRAY<" + TypeText(text[6..^1]) + ">";
        if (Starts(text, "STRUCT<") || text.Equals("STRUCT", StringComparison.OrdinalIgnoreCase) || text.Equals("RECORD", StringComparison.OrdinalIgnoreCase)) return "STRUCT";
        if (Starts(text, "RANGE<")) return "RANGE";
        var open = text.IndexOf('(');
        var name = (open < 0 ? text : text[..open]).Trim().ToUpperInvariant() switch { "INTEGER" => "INT64", "FLOAT" => "FLOAT64", "BOOLEAN" => "BOOL", var other => other };
        // Pass 2 shows parameters only for these (maxLength, precision and scale); TIMESTAMP(12)'s precision it leaves out.
        if (open < 0 || !text.EndsWith(')') || name is not ("STRING" or "BYTES" or "NUMERIC" or "BIGNUMERIC")) return name;
        return name + "(" + string.Join(", ", text[(open + 1)..^1].Split(',').Select(part => part.Trim())) + ")";
    }

    /// <summary>The field list inside a STRUCT&lt;…&gt; or ARRAY&lt;STRUCT&lt;…&gt;&gt; type, or null for any other type.</summary>
    public static string? StructBody(string type)
    {
        var text = Bare(type);
        if (Starts(text, "ARRAY<") && text.EndsWith('>')) text = Bare(text[6..^1]);
        return Starts(text, "STRUCT<") && text.EndsWith('>') ? text[7..^1] : null;
    }

    /// <summary>A STRUCT's fields in order: each one's name (a backticked name unquoted), its type text and whether it may be NULL.</summary>
    public static IEnumerable<(string Name, string Type, bool Nullable)> Fields(string body)
    {
        foreach (var part in Split(body))
        {
            var text = part.Trim();
            if (text.Length == 0) continue;
            string name;
            int rest;
            if (text[0] == '`')
            {
                var builder = new StringBuilder();
                var at = 1;
                for (; at < text.Length && text[at] != '`'; at++)
                {
                    if (text[at] == '\\' && at + 1 < text.Length) at++;
                    builder.Append(text[at]);
                }
                if (at >= text.Length) continue;
                name = builder.ToString();
                rest = at + 1;
            }
            else
            {
                rest = 0;
                while (rest < text.Length && !char.IsWhiteSpace(text[rest])) rest++;
                name = text[..rest];
            }
            var declared = text[rest..].Trim();
            // An unnamed field (STRUCT<INT64>) has nothing a path could name; no table holds one.
            if (declared.Length == 0) continue;
            yield return (name, declared, !NotNull(declared));
        }
    }

    static bool Starts(string text, string prefix) => text.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);

    [GeneratedRegex(@"\s(?:NOT\s+NULL|COLLATE|OPTIONS|DEFAULT)\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Trailer();

    /// <summary>The type text alone: cut at the first NOT NULL, COLLATE, OPTIONS or DEFAULT outside brackets and quotes.</summary>
    static string Bare(string type)
    {
        var text = type.Trim();
        foreach (Match match in Trailer().Matches(text))
            if (Depth(text, match.Index) == 0) return text[..match.Index].Trim();
        return text;
    }

    static bool NotNull(string declared)
    {
        foreach (Match match in Trailer().Matches(declared))
            if (Depth(declared, match.Index) == 0) return match.Value.TrimStart().StartsWith("NOT", StringComparison.OrdinalIgnoreCase);
        return false;
    }

    /// <summary>How deep <paramref name="at"/> is inside &lt;…&gt; and (…), with quoted and backticked text counted as inside.</summary>
    static int Depth(string text, int at)
    {
        var depth = 0;
        char? quote = null;
        for (var i = 0; i < at; i++)
        {
            var c = text[i];
            if (quote is { } open)
            {
                if (c == '\\') i++;
                else if (c == open) quote = null;
                continue;
            }
            if (c is '`' or '\'' or '"') quote = c;
            else if (c is '<' or '(') depth++;
            else if (c is '>' or ')') depth--;
        }
        return quote is null ? depth : 1;
    }

    /// <summary>The body split at its top-level commas.</summary>
    static IEnumerable<string> Split(string body)
    {
        var start = 0;
        var depth = 0;
        char? quote = null;
        for (var i = 0; i < body.Length; i++)
        {
            var c = body[i];
            if (quote is { } open)
            {
                if (c == '\\') i++;
                else if (c == open) quote = null;
                continue;
            }
            if (c is '`' or '\'' or '"') quote = c;
            else if (c is '<' or '(') depth++;
            else if (c is '>' or ')') depth--;
            else if (c == ',' && depth == 0)
            {
                yield return body[start..i];
                start = i + 1;
            }
        }
        yield return body[start..];
    }
}
