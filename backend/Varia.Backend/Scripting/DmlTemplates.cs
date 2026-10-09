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

    /// <summary>&lt;name, type,&gt; with every character that could end or split the placeholder replaced by _.</summary>
    public static string Placeholder(string name, string type) => "<" + Clean(name) + ", " + Clean(type) + ",>";

    private static string Clean(string text)
    {
        var builder = new StringBuilder(text.Length);
        foreach (var c in text)
            builder.Append(c is '<' or '>' or ',' or '\u2028' or '\u2029' || c <= '\u001f' || c is >= '\u007f' and <= '\u009f' ? '_' : c);
        return builder.ToString();
    }

    /// <summary>The columns a template lists: no dropped ledger columns, only the graph pseudo-columns, and a column set
    /// in place of its sparse columns; SELECT also leaves out hidden columns, and INSERT and UPDATE every column SQL
    /// Server fills itself.</summary>
    public static IReadOnlyList<ColumnRow> Columns(IReadOnlyList<ColumnRow> columns, bool writable)
    {
        var columnSet = columns.Any(column => column.ColumnSet);
        return [.. columns.Where(column => !column.DroppedLedger && (column.GraphType is null or 2 or 5 or 8) && !(columnSet && column.Sparse)
            && (writable
                ? !column.Identity && !column.Computed && column.SystemTypeId != Rowversion && column.GeneratedAlways == 0 && column.GraphType != 2
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
            text.Append(NL).Append("           ").Append(i == 0 ? '(' : ',').Append(Placeholder(listed[i].Name, SqlTypeText.ForTemplate(listed[i].Type, schemaQualify)));
        return text.Append(')').ToString();
    }

    public static string Update(string obj, IReadOnlyList<ColumnRow> columns, bool schemaQualify)
    {
        var listed = Columns(columns, writable: true);
        // Fixed text: a name with a line break would end a line comment and run as SQL.
        if (listed.Count == 0) return "-- This object has no updatable columns.";
        var text = new StringBuilder("UPDATE ").Append(obj);
        for (var i = 0; i < listed.Count; i++)
            text.Append(NL).Append(i == 0 ? "   SET " : "      ,").Append(ScriptFormatter.Quote(listed[i].Name)).Append(" = ")
                .Append(Placeholder(listed[i].Name, SqlTypeText.ForTemplate(listed[i].Type, schemaQualify)));
        return text.Append(NL).Append(" WHERE ").Append(SearchConditions).ToString();
    }

    public static string Delete(string obj) => "DELETE FROM " + obj + NL + "      WHERE " + SearchConditions;

    /// <summary>EXECUTE To, in sqltoolsservice's layout: DECLAREs for the return code and every parameter, the TODO line,
    /// then the call with one parameter per line. The space after the object name is SSMS's. A CLR procedure is called
    /// without a return code; a scalar function's return code has its return type.</summary>
    public static string Execute(string obj, IReadOnlyList<ParameterRow> parameters, bool clr, bool schemaQualify)
    {
        var returnValue = parameters.FirstOrDefault(parameter => parameter.Id == 0);
        var inputs = parameters.Where(parameter => parameter.Id > 0).ToList();
        var returnCode = returnValue is not null || !clr;
        var declares = new List<string>();
        if (returnCode) declares.Add("DECLARE @RC " + (returnValue is null ? "int" : SqlTypeText.ForTemplate(returnValue.Type, schemaQualify)));
        declares.AddRange(inputs.Select(parameter => "DECLARE " + parameter.Name + " " + SqlTypeText.ForTemplate(parameter.Type, schemaQualify)));
        var text = new StringBuilder();
        foreach (var declare in declares) text.Append(declare).Append(NL);
        if (declares.Count > 0) text.Append(NL);
        text.Append("-- TODO: Set parameter values here.").Append(NL).Append(NL);
        text.Append("EXECUTE ").Append(returnCode ? "@RC = " : "").Append(obj).Append(' ');
        for (var i = 0; i < inputs.Count; i++) text.Append(NL).Append(i == 0 ? "   " : "  ,").Append(inputs[i].Name).Append(inputs[i].Output ? " OUTPUT" : "");
        return text.ToString();
    }

    /// <summary>SELECT To on a function: FROM a table-valued one, or the value of a scalar one, with a placeholder per parameter.</summary>
    public static string SelectFunction(string obj, IReadOnlyList<ParameterRow> parameters, bool tableValued, bool schemaQualify)
    {
        var inputs = parameters.Where(parameter => parameter.Id > 0).ToList();
        var text = new StringBuilder(tableValued ? "SELECT * FROM " : "SELECT ").Append(obj).Append(" (");
        for (var i = 0; i < inputs.Count; i++)
            text.Append(NL).Append(i == 0 ? "   " : "  ,").Append(Placeholder(inputs[i].Name, SqlTypeText.ForTemplate(inputs[i].Type, schemaQualify)));
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
