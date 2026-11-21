using System.Globalization;
using System.Text;

namespace Varia.Backend.Scripting;

/// <summary>One column as the preflight's rowset reads it (sys.all_columns in column_id order).</summary>
/// <param name="GeneratedAlways">generated_always_type: period, ledger and transaction-id columns SQL Server fills.</param>
/// <param name="GraphType">graph_type: 2, 5 and 8 are $node_id/$edge_id, $from_id and $to_id; the rest are internal.</param>
/// <param name="SystemTypeId">189 is timestamp (rowversion), whatever the column's alias type is called.</param>
internal sealed record ColumnRow(string Name, TypeRow Type, bool Identity = false, bool Computed = false, bool Sparse = false, bool ColumnSet = false, int GeneratedAlways = 0,
    bool Hidden = false, int? GraphType = null, bool DroppedLedger = false, int SystemTypeId = 0);

/// <summary>One parameter as the preflight's rowset reads it (sys.all_parameters by parameter_id; 0 is a scalar
/// function's return value).</summary>
internal sealed record ParameterRow(int Id, string Name, TypeRow Type, bool Output = false, bool ReadOnly = false);

/// <summary>SSMS's SELECT, INSERT, UPDATE, DELETE and EXECUTE templates (spec B9, C6), built from the preflight's rows
/// without SMO. Each returns one batch for ScriptFormatter to frame. Identifiers are quoted, values are template
/// placeholders whose names cannot close or split them, and no comment carries a name.</summary>
internal static class DmlTemplates
{
    private static string NL => Environment.NewLine;
    private const int Rowversion = 189;
    private const string SearchConditions = "<Search Conditions,,>";

    /// <summary>The object as templates name it: schema-qualified when option 9 is on.</summary>
    public static string Object(string? schema, string name, bool schemaQualify) =>
        schemaQualify && schema is not null ? ScriptFormatter.Quote(schema) + "." + ScriptFormatter.Quote(name) : ScriptFormatter.Quote(name);

    /// <summary>&lt;name, type,&gt; with every character that could end or split the placeholder replaced by _ in the name
    /// and in any name inside the type; system type text such as decimal(10,2) keeps its comma, as in SSMS.</summary>
    public static string Placeholder(string name, TypeRow type, bool schemaQualify) => "<" + Clean(name) + ", " + SqlTypeText.ForTemplate(type, schemaQualify, Clean) + ",>";

    private static string Clean(string text)
    {
        var builder = new StringBuilder(text.Length);
        foreach (var c in text)
            builder.Append(c is '<' or '>' or ',' or '\u2028' or '\u2029' || c <= '\u001f' || c is >= '\u007f' and <= '\u009f' ? '_' : c);
        return builder.ToString();
    }

    /// <summary>The columns a template lists: no dropped ledger columns, only the graph pseudo-columns, and a column set
    /// in place of its sparse columns; SELECT also leaves out hidden columns, INSERT and UPDATE every column SQL Server
    /// fills itself, and UPDATE an edge's $from_id and $to_id, which an INSERT must set and nothing may change.</summary>
    public static IReadOnlyList<ColumnRow> Columns(IReadOnlyList<ColumnRow> columns, bool writable, bool update = false)
    {
        var columnSet = columns.Any(column => column.ColumnSet);
        return [.. columns.Where(column => !column.DroppedLedger && (column.GraphType is null or 2 or 5 or 8) && !(columnSet && column.Sparse)
            && (writable
                ? !column.Identity && !column.Computed && column.SystemTypeId != Rowversion && column.GeneratedAlways == 0 && (update ? column.GraphType is null : column.GraphType != 2)
                : !column.Hidden))];
    }

    public static string Select(string obj, IReadOnlyList<ColumnRow> columns)
    {
        var listed = Columns(columns, writable: false);
        var text = new StringBuilder("SELECT ");
        if (listed.Count == 0) text.Append('*');
        for (var i = 0; i < listed.Count; i++) text.Append(i == 0 ? "" : NL + "      ,").Append(ScriptFormatter.Quote(listed[i].Name));
        return text.Append(NL).Append("  FROM ").Append(obj).ToString();
    }

    public static string Insert(string obj, IReadOnlyList<ColumnRow> columns, bool schemaQualify)
    {
        var listed = Columns(columns, writable: true);
        if (listed.Count == 0) return "INSERT INTO " + obj + NL + "     DEFAULT VALUES";
        var text = new StringBuilder("INSERT INTO ").Append(obj);
        for (var i = 0; i < listed.Count; i++) text.Append(NL).Append("           ").Append(i == 0 ? '(' : ',').Append(ScriptFormatter.Quote(listed[i].Name));
        text.Append(')').Append(NL).Append("     VALUES");
        for (var i = 0; i < listed.Count; i++)
            text.Append(NL).Append("           ").Append(i == 0 ? '(' : ',').Append(Placeholder(listed[i].Name, listed[i].Type, schemaQualify));
        return text.Append(')').ToString();
    }

    public static string Update(string obj, IReadOnlyList<ColumnRow> columns, bool schemaQualify)
    {
        var listed = Columns(columns, writable: true, update: true);
        // Fixed text: a name with a line break would end a line comment and run as SQL.
        if (listed.Count == 0) return "-- This object has no updatable columns.";
        var text = new StringBuilder("UPDATE ").Append(obj);
        for (var i = 0; i < listed.Count; i++)
            text.Append(NL).Append(i == 0 ? "   SET " : "      ,").Append(ScriptFormatter.Quote(listed[i].Name)).Append(" = ")
                .Append(Placeholder(listed[i].Name, listed[i].Type, schemaQualify));
        return text.Append(NL).Append(" WHERE ").Append(SearchConditions).ToString();
    }

    public static string Delete(string obj) => "DELETE FROM " + obj + NL + "      WHERE " + SearchConditions;

    /// <summary>EXECUTE To, in sqltoolsservice's layout: DECLAREs for the return code and every parameter, the TODO line,
    /// then the call with one parameter per line. The space after the object name is SSMS's. A CLR procedure is called
    /// without a return code; a scalar function's return code has its return type. The return code is @RC unless a
    /// parameter could have that name under some collation: then @RC1, @RC2 and on (ReturnCodeName).</summary>
    public static string Execute(string obj, IReadOnlyList<ParameterRow> parameters, bool clr, bool schemaQualify)
    {
        var returnValue = parameters.FirstOrDefault(parameter => parameter.Id == 0);
        var inputs = parameters.Where(parameter => parameter.Id > 0).ToList();
        var rc = returnValue is not null || !clr ? ReturnCodeName(inputs) : null;
        var declares = new List<string>();
        if (rc is not null) declares.Add("DECLARE " + rc + " " + (returnValue is null ? "int" : SqlTypeText.ForTemplate(returnValue.Type, schemaQualify)));
        declares.AddRange(inputs.Select(parameter => "DECLARE " + parameter.Name + " " + SqlTypeText.ForTemplate(parameter.Type, schemaQualify)));
        var text = new StringBuilder();
        foreach (var declare in declares) text.Append(declare).Append(NL);
        if (declares.Count > 0) text.Append(NL);
        text.Append("-- TODO: Set parameter values here.").Append(NL).Append(NL);
        text.Append("EXECUTE ").Append(rc is null ? "" : rc + " = ").Append(obj).Append(' ');
        for (var i = 0; i < inputs.Count; i++) text.Append(NL).Append(i == 0 ? "   " : "  ,").Append(inputs[i].Name).Append(inputs[i].Output ? " OUTPUT" : "");
        return text.ToString();
    }

    /// <summary>Bounds the work names built to clash with every candidate can cost; past it the call has no return code.</summary>
    internal const int MaxReturnCodeMatches = 20_000;

    /// <summary>The first of @RC, @RC1, @RC2 and on that no parameter could equal under any collation, or null (no return
    /// code, still a valid call) when parameters built to block them exhaust the bound.</summary>
    /// <remarks>An all-ASCII name clashes case-insensitively: no collation ignores or equates the ASCII characters a name
    /// may hold. A non-ASCII character may count as nothing (the default SQL_Latin1_General_CP1_CI_AS weighs thousands
    /// zero, so @RC followed by U+0219 is @RC) or as its NFKD fold (a fullwidth R is R, Ç is C); a number may
    /// also equal any one digit, and some symbols, Latin letters and marks any one character (U+0280 is R in the default collation, U+0661 is
    /// 1 in accent-insensitive _100_ ones; NameChar.Of). A needless @RC1 is harmless.</remarks>
    private static string? ReturnCodeName(IReadOnlyList<ParameterRow> inputs)
    {
        var ascii = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var other = new List<NameChar[]>();
        foreach (var parameter in inputs)
            if (parameter.Name.All(char.IsAscii)) ascii.Add(parameter.Name);
            // A name whose ASCII characters are not all in @RC0-9 can never match one.
            else if (parameter.Name.All(c => !char.IsAscii(c) || c is '@' or 'R' or 'r' or 'C' or 'c' or (>= '0' and <= '9')))
                other.Add([.. parameter.Name.Select(NameChar.Of)]);
        var matches = 0;
        // All-ASCII names block at most inputs.Count candidates; the bound ends the rest.
        for (var suffix = 0; ; suffix++)
        {
            var name = suffix == 0 ? "@RC" : "@RC" + suffix.ToString(CultureInfo.InvariantCulture);
            if (ascii.Contains(name)) continue;
            var clash = false;
            foreach (var parameter in other)
            {
                if (++matches > MaxReturnCodeMatches) return null;
                if (CouldBe(parameter, name)) { clash = true; break; }
            }
            if (!clash) return name;
        }
    }

    /// <param name="Fold">Null for an ASCII character, which must match itself (uppercased); otherwise the letters and digits
    /// of its NFKD form, uppercased, possibly empty.</param>
    /// <param name="Any">May equal any one character.</param>
    /// <param name="Digit">May equal any one digit.</param>
    private readonly record struct NameChar(char Char, string? Fold, bool Any, bool Digit)
    {
        public static NameChar Of(char c)
        {
            if (char.IsAscii(c)) return new(char.ToUpperInvariant(c), null, false, false);
            // Where a scan of every CI_AS and CI_AI collation found characters equal to R, C, @ or a digit beyond NFKD: numbers
            // of any script, only ever equal to a digit; symbols (U+211E is R); letters only in the Latin and IPA extensions
            // (never Greek, Cyrillic or CJK, so an ordinary name in those keeps @RC); the combining Latin letters and two
            // Quranic marks.
            var category = CharUnicodeInfo.GetUnicodeCategory(c);
            var digit = category is UnicodeCategory.DecimalDigitNumber or UnicodeCategory.LetterNumber or UnicodeCategory.OtherNumber;
            var any = category switch
            {
                UnicodeCategory.OtherSymbol => true,
                UnicodeCategory.UppercaseLetter or UnicodeCategory.LowercaseLetter or UnicodeCategory.TitlecaseLetter or UnicodeCategory.ModifierLetter
                    or UnicodeCategory.OtherLetter => c is >= '\u0080' and <= '\u02FF' or >= '\u1D00' and <= '\u1EFF' or >= '\u2C60' and <= '\u2C7F'
                        or >= '\uA720' and <= '\uA7FF' or >= '\uAB30' and <= '\uAB6F',
                UnicodeCategory.NonSpacingMark => c is >= '\u0300' and <= '\u036F' or >= '\u1DC0' and <= '\u1DFF' or >= '\u06D6' and <= '\u06ED',
                _ => false
            };
            string decomposed;
            try { decomposed = c.ToString().Normalize(NormalizationForm.FormKD); }
            catch (ArgumentException) { decomposed = ""; }
            var fold = new StringBuilder(decomposed.Length);
            foreach (var part in decomposed) if (char.IsAsciiLetterOrDigit(part)) fold.Append(char.ToUpperInvariant(part));
            return new(c, fold.ToString(), any, digit);
        }
    }

    private static bool CouldBe(NameChar[] name, string candidate)
    {
        Span<bool> reach = stackalloc bool[candidate.Length + 1], next = stackalloc bool[candidate.Length + 1];
        reach.Clear();
        reach[0] = true;
        foreach (var (c, fold, any, digit) in name)
        {
            next.Clear();
            var live = false;
            for (var at = 0; at < reach.Length; at++)
            {
                if (!reach[at]) continue;
                if (fold is null)
                {
                    if (at < candidate.Length && c == candidate[at]) live = next[at + 1] = true;
                    continue;
                }
                live = next[at] = true;
                if (at < candidate.Length && (any || digit && char.IsAsciiDigit(candidate[at]))) next[at + 1] = true;
                if (fold.Length > 0 && candidate.AsSpan(at).StartsWith(fold, StringComparison.Ordinal)) next[at + fold.Length] = true;
            }
            if (!live) return false;
            next.CopyTo(reach);
        }
        return reach[candidate.Length];
    }

    /// <summary>SELECT To on a function: FROM a table-valued one, or the value of a scalar one, with a placeholder per parameter.</summary>
    public static string SelectFunction(string obj, IReadOnlyList<ParameterRow> parameters, bool tableValued, bool schemaQualify)
    {
        var inputs = parameters.Where(parameter => parameter.Id > 0).ToList();
        var text = new StringBuilder(tableValued ? "SELECT * FROM " : "SELECT ").Append(obj).Append(" (");
        for (var i = 0; i < inputs.Count; i++)
            text.Append(NL).Append(i == 0 ? "   " : "  ,").Append(Placeholder(inputs[i].Name, inputs[i].Type, schemaQualify));
        return text.Append(')').ToString();
    }

    private static readonly HashSet<string> TableValued = ["inline", "tableValued", "clrTableValued"];

    /// <summary>The template batch for a resolved target and verb, from the rows its preflight read.</summary>
    public static string Batch(ResolvedTarget target, ScriptVerb verb, bool schemaQualify)
    {
        var obj = Object(target.Ref.Schema, target.Ref.Name!, schemaQualify);
        var columns = target.Columns ?? [];
        var parameters = target.Parameters ?? [];
        return (target.Kind, verb) switch
        {
            ("function", ScriptVerb.Select) => SelectFunction(obj, parameters, TableValued.Contains(target.Subtype), schemaQualify),
            (_, ScriptVerb.Select) => Select(obj, columns),
            (_, ScriptVerb.Insert) => Insert(obj, columns, schemaQualify),
            (_, ScriptVerb.Update) => Update(obj, columns, schemaQualify),
            (_, ScriptVerb.Delete) => Delete(obj),
            (_, ScriptVerb.Execute) => Execute(obj, parameters, target.ObjectType is "PC", schemaQualify),
            _ => throw new InvalidOperationException("Not a template verb: " + verb)
        };
    }
}
