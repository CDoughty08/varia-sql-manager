using System.Text;
using System.Text.RegularExpressions;

namespace Varia.Backend.Actions;

/// <summary>The OPENJSON rules the JSON builders' lints share: the table designer's (form 3, ActionSql.LintExecutable) and New
/// Database's (form 5, CreateDatabaseSql.Lint). A request's text reaches a builder only as an OPENJSON column, so every column is
/// read from its WITH clause, whatever its type, and its uses are checked: a text column only inside QUOTENAME (the caller first
/// reduces its other sanctioned forms to that), a JSON column only into one of the caller's array variables, an array only in
/// OPENJSON, an element only in OPENJSON or CONVERT(int, …), an index only in CONVERT(int, …), and no column named without its
/// alias. A column is int, bigint, smallint, tinyint, bit, decimal, or nvarchar(max) (AS JSON): text of any other type is refused
/// outright, so a short text type cannot hide a value from these rules.</summary>
internal static partial class JsonBuilderLint
{
    private enum Kind { Number, Text, Json, Element, Index }

    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex LiteralPattern();
    /// <summary>One OPENJSON at the start: its source, its WITH clause's columns if it has one, and its one-letter alias.</summary>
    [GeneratedRegex(@"\GOPENJSON\((?<source>[^()]*)\)(?: WITH \((?<columns>(?:[^()]|\([^()]*\))*)\))? AS (?<alias>[a-z])(?=[ ;\n)])")]
    private static partial Regex OpenJson();
    [GeneratedRegex(@"^(?<name>\[\w+\]|\w+) (?<type>.+?)(?<json> AS JSON)?$")]
    private static partial Regex Column();
    [GeneratedRegex(@"^(?:int|bigint|smallint|tinyint|bit|decimal\(\d+, \d+\))$")]
    private static partial Regex NumberType();
    [GeneratedRegex(@"\b([a-z])\.(\[\w+\]|\w+|\*)")]
    private static partial Regex Qualified();
    [GeneratedRegex(@"@\w+")]
    private static partial Regex Variable();

    /// <summary>Problems with the OPENJSON columns of <paramref name="text"/>, whose sanctioned text forms the caller has already
    /// reduced to QUOTENAME(alias.column). <paramref name="arrays"/> are the variables a JSON column may be assigned to.</summary>
    public static List<string> Problems(string text, IReadOnlyCollection<string> arrays)
    {
        var problems = new List<string>();
        // Literals cannot hold a use; WITH clauses are declarations, not uses.
        var scrubbed = LiteralPattern().Replace(text, "N''");
        var columns = new Dictionary<string, Kind>(StringComparer.OrdinalIgnoreCase);
        void Declare(string alias, string column, Kind kind)
        {
            var key = alias + "." + column;
            if (columns.TryGetValue(key, out var known) && known != kind) problems.Add("declares " + key + " as two kinds of column");
            else columns[key] = kind;
        }
        var uses = new StringBuilder();
        var at = 0;
        for (var start = scrubbed.IndexOf("OPENJSON(", StringComparison.OrdinalIgnoreCase); start >= 0; start = scrubbed.IndexOf("OPENJSON(", start + 1, StringComparison.OrdinalIgnoreCase))
        {
            var match = OpenJson().Match(scrubbed, start);
            if (!match.Success) { problems.Add("has an OPENJSON the lint cannot read"); continue; }
            var alias = match.Groups["alias"].Value;
            if (!match.Groups["columns"].Success)
            {
                Declare(alias, "key", Kind.Index);
                Declare(alias, "value", Kind.Element);
                continue;
            }
            foreach (var declared in Split(match.Groups["columns"].Value))
            {
                var column = Column().Match(declared);
                if (!column.Success) { problems.Add("has an OPENJSON column the lint cannot read: " + declared); continue; }
                var name = column.Groups["name"].Value.Trim('[', ']');
                var type = column.Groups["type"].Value;
                if (column.Groups["json"].Success ? type != "nvarchar(max)" : type != "nvarchar(max)" && !NumberType().IsMatch(type))
                    problems.Add("declares " + alias + "." + name + " as " + type + column.Groups["json"].Value + ": a design column is a number or nvarchar(max)");
                Declare(alias, name, column.Groups["json"].Success ? Kind.Json : NumberType().IsMatch(type) ? Kind.Number : Kind.Text);
            }
            uses.Append(scrubbed, at, match.Groups["columns"].Index - at);
            at = match.Groups["columns"].Index + match.Groups["columns"].Length;
        }
        uses.Append(scrubbed, at, scrubbed.Length - at);
        var body = uses.ToString();
        if (Regex.IsMatch(body, @"\bSELECT\s+\*", RegexOptions.IgnoreCase)) problems.Add("selects every column");

        var aliases = columns.Keys.Select(key => key[..1]).ToHashSet(StringComparer.Ordinal);
        foreach (Match used in Qualified().Matches(body))
        {
            var alias = used.Groups[1].Value;
            if (!aliases.Contains(alias)) continue;
            var name = used.Groups[2].Value.Trim('[', ']');
            var before = body[..used.Index];
            var after = body[(used.Index + used.Length)..];
            bool Inside(string open) => before.EndsWith(open, StringComparison.Ordinal) && after.StartsWith(')');
            if (!columns.TryGetValue(alias + "." + name, out var kind)) { problems.Add("uses " + used.Value + ", which no OPENJSON declares"); continue; }
            var allowed = kind switch
            {
                Kind.Number => true,
                Kind.Text => Inside("QUOTENAME("),
                Kind.Json => arrays.Any(array => before.EndsWith(array + " = ", StringComparison.Ordinal)),
                Kind.Element => Inside("OPENJSON(") || Inside("CONVERT(int, "),
                _ => Inside("CONVERT(int, ")
            };
            if (!allowed) problems.Add(kind switch
            {
                Kind.Text => "uses the design text " + used.Value + " outside QUOTENAME",
                Kind.Json => "uses the JSON " + used.Value + " outside an array's assignment",
                Kind.Element => "uses " + used.Value + " outside OPENJSON or an index's CONVERT",
                _ => "uses " + used.Value + " outside CONVERT(int, …)"
            });
        }
        // A text or JSON column named without its alias would escape the rules above.
        // (KEY is reserved, so PRIMARY KEY never names a column.)
        var bare = Qualified().Replace(body, "x.x").Replace("nvarchar(max)", "", StringComparison.OrdinalIgnoreCase).Replace("PRIMARY KEY", "", StringComparison.Ordinal);
        foreach (var name in columns.Where(item => item.Value is Kind.Text or Kind.Json).Select(item => item.Key[2..]).Distinct(StringComparer.OrdinalIgnoreCase))
            if (Regex.IsMatch(bare, @"(?<![\w@#.\[])\[?" + Regex.Escape(name) + @"\]?(?![\w\]])", RegexOptions.IgnoreCase)) problems.Add("uses the design column " + name + " without its alias");
        foreach (var array in arrays)
        {
            var rest = body.Replace("OPENJSON(" + array + ")", "", StringComparison.Ordinal).Replace(array + " IS NULL", "", StringComparison.Ordinal)
                .Replace(array + " nvarchar(max)", "", StringComparison.Ordinal);
            rest = Regex.Replace(rest, Regex.Escape(array) + @" = [a-z]\.(\[\w+\]|\w+)", match => columns.GetValueOrDefault(match.Value[(array.Length + 3)..].Replace("[", "").Replace("]", "")) == Kind.Json ? "" : match.Value);
            if (Variable().Matches(rest).Any(used => used.Value == array)) problems.Add("uses " + array + " outside OPENJSON");
        }
        return problems;
    }

    /// <summary>A WITH clause's columns, split at its top-level commas (decimal(38, 0) holds one).</summary>
    private static IEnumerable<string> Split(string columns)
    {
        var depth = 0;
        var start = 0;
        for (var i = 0; i < columns.Length; i++)
        {
            if (columns[i] == '(') depth++;
            else if (columns[i] == ')') depth--;
            else if (columns[i] == ',' && depth == 0)
            {
                yield return columns[start..i].Trim();
                start = i + 1;
            }
        }
        yield return columns[start..].Trim();
    }
}
