using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Varia.Backend.Results;

namespace Varia.Backend.Explorer;

/// <summary>explorer.peekRows' batch: Peek's Top rows tab, a table's or view's first rows as SSMS's Select Top Rows reads them
/// (SELECT TOP (n) *, in no order). It runs in the object's database as every Object Explorer statement does, finds the object
/// by @object_schema and @object_name and its kind (<see cref="CatalogSql.ParentLookup"/>), and only then reads it through the one
/// dynamic statement Object Explorer runs, which the server builds from constant text and QUOTENAME of those parameters, with
/// the row count as a parameter. Inside it, SET TEXTSIZE has the server send at most <see cref="TextSize"/> bytes of a large
/// text or binary value, enough to show and mark one cut, rather than all of it; and a memory-optimized table, which refuses the
/// explorer pool's READ UNCOMMITTED (error 10794), or a view over one, is read again under READ COMMITTED (which SQL Server maps
/// to SNAPSHOT for it in autocommit), so every other table and view keeps READ UNCOMMITTED. Both settings end with the dynamic
/// statement. <see cref="Lint"/> holds it to that. Values are read with the results grid's own readers (ColumnPlan, under a cap
/// per value), so they show as the grid shows them; xml and CLR values are not limited by TEXTSIZE and are read past whole.</summary>
internal static partial class PeekRowsSql
{
    /// <summary>Bytes of a large value the server sends: four per character and one character more than the cap, so any
    /// encoding still fills the cap and shows the value as cut.</summary>
    internal static readonly int TextSize = (ExplorerCatalog.Current.Peek.RowCellChars + 1) * 4;
    private static readonly string Head = "N'SET TEXTSIZE " + TextSize.ToString(CultureInfo.InvariantCulture) + "; BEGIN TRY SELECT TOP (@take) * FROM '";
    private const string Retry = "N'; END TRY BEGIN CATCH IF ERROR_NUMBER() <> 10794 THROW; SET TRANSACTION ISOLATION LEVEL READ COMMITTED; SELECT TOP (@take) * FROM '";
    private const string Name = "QUOTENAME(@object_schema) + N'.' + QUOTENAME(@object_name)";
    private static readonly string Dynamic = "DECLARE @rows nvarchar(max) = " + Head + " + " + Name + " + " + Retry + " + " + Name + " + N'; END CATCH;';\n"
        + "EXEC sys.sp_executesql @rows, N'@take int', @take = @take;\n";

    /// <summary>The literals <see cref="Dynamic"/> may hold, and nothing else.</summary>
    private static readonly HashSet<string> Literals = [Head, Retry, "N'.'", "N'; END CATCH;'", "N'@take int'"];

    [GeneratedRegex(@"QUOTENAME\((?<argument>[^)]*)\)")]
    private static partial Regex Quoted();

    /// <summary>The batch for a table or view.</summary>
    public static string Render(string kind) => kind is "table" or "view"
        ? CatalogSql.ParentLookup(kind) + Dynamic
        : throw new InvalidOperationException("Peek reads rows only of tables and views.");

    /// <summary>Problems with a rendered batch; empty when it passes: Object Explorer's lint (no metadata built-ins or secrets,
    /// only its literals and the dynamic statement's, no database name), the object found by name first, and after that lookup the
    /// names only inside QUOTENAME, no variable but @rows declared, and one dynamic statement.</summary>
    public static List<string> Lint(string text, string kind)
    {
        var problems = CatalogSql.Lint(text, new SqlRender(ExplorerCatalog.MaxBand), list: false, mayCheckAccess: false, Literals);
        var lookup = CatalogSql.ParentLookup(kind);
        if (!text.StartsWith(lookup, StringComparison.Ordinal)) { problems.Add("does not find the object first"); return problems; }
        // After the lookup, which compares the names as values, they may appear only quoted; a copy into another variable would
        // smuggle one in unquoted, so no other variable is declared.
        var rest = text[lookup.Length..];
        foreach (Match quoted in Quoted().Matches(text))
            if (quoted.Groups["argument"].Value is not ("@object_schema" or "@object_name")) problems.Add("quotes " + quoted.Groups["argument"].Value);
        if (Regex.IsMatch(Quoted().Replace(rest, ""), "@object_(schema|name)")) problems.Add("uses a name outside QUOTENAME");
        foreach (Match declared in Regex.Matches(rest, @"\bDECLARE\s+(?<name>@\w+)", RegexOptions.IgnoreCase))
            if (declared.Groups["name"].Value != "@rows") problems.Add("declares " + declared.Groups["name"].Value);
        if (Regex.Count(rest, @"\bSELECT\s+@\w+\s*=|\bSET\s+@", RegexOptions.IgnoreCase) > 0) problems.Add("assigns a variable after the lookup");
        if (Regex.Count(text, "sp_executesql", RegexOptions.IgnoreCase) != 1 || !rest.Contains("EXEC sys.sp_executesql @rows, N'@take int', @take = @take;", StringComparison.Ordinal))
            problems.Add("runs other dynamic SQL");
        if (Regex.IsMatch(text, @"\bEXEC(UTE)?\s*\(", RegexOptions.IgnoreCase)) problems.Add("uses EXEC (string)");
        return problems;
    }

    /// <summary>The rows result (the reader is on it, read sequentially): at most <paramref name="rows"/> rows, the first
    /// <paramref name="columns"/> columns, each value as the grid shows it, cut to <paramref name="cellChars"/>.</summary>
    public static async Task<PeekRowsResult> ReadAsync(SqlDataReader reader, int rows, int columns, int cellChars, CancellationToken token)
    {
        var plan = ColumnPlan.From(reader, cellChars: cellChars);
        var shown = Math.Min(columns, plan.Columns.Count);
        var names = plan.Columns.Take(shown).Select(column => new PeekRowsColumn(string.IsNullOrEmpty(column.Name) ? ResultTextWriter.NoColumnName : column.Name, column.DataType)).ToList();
        var more = plan.Columns.Count > shown ? plan.Columns.Count - shown : (int?)null;
        var builder = new PageBuilder(1, plan.Wires);
        var count = 0;
        // Every column is read, shown or not: a value left unread would be buffered whole by the next row's read.
        while (count < rows && await reader.ReadAsync(token))
        {
            token.ThrowIfCancellationRequested();
            builder.BeginRow();
            plan.ReadRow(reader, builder, _ => { }, token);
            builder.CommitRow();
            count++;
        }
        return count == 0 ? new(names, [], 0, more) : FromPage(builder.Seal(), count, plan.Columns.Count, names, more, cellChars);
    }

    /// <summary>A sealed page's first <paramref name="count"/> rows as the tab shows them: the shown columns' values as text
    /// (binary as 0x…), cut to <paramref name="cellChars"/>, with the cut values and those the readers could not read listed.</summary>
    internal static PeekRowsResult FromPage(byte[] page, int count, int columnCount, List<PeekRowsColumn> names, int? more, int cellChars)
    {
        var view = PageView.Parse(page, columnCount);
        var shown = names.Count;
        var values = new List<string?[]>(count);
        var cut = new List<int[]>();
        var unread = new List<int[]>();
        for (var row = 0; row < count; row++)
        {
            var line = new string?[shown];
            for (var column = 0; column < shown; column++)
            {
                if (view.IsNull(column, row))
                {
                    if (view.IsError(column, row)) unread.Add([row, column]);
                    continue;
                }
                var text = view.Wire(column) == WireKind.Binary ? "0x" + Convert.ToHexString(view.Span(column, row)) : Encoding.UTF8.GetString(view.Span(column, row));
                var (kept, shorter) = PeekSql.Cut(text, cellChars);
                line[column] = kept;
                if (shorter || view.IsTruncated(column, row)) cut.Add([row, column]);
            }
            values.Add(line);
        }
        return new(names, values, 0, more, cut.Count == 0 ? null : cut, Unread: unread.Count == 0 ? null : unread);
    }
}
