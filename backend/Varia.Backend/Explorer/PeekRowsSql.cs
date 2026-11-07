using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Varia.Backend.Results;

namespace Varia.Backend.Explorer;

/// <summary>explorer.peekRows' batch: Peek's Top rows tab, a table's or view's first rows as SSMS's Select Top Rows reads them
/// (SELECT TOP (n) *, in no order). It runs in the object's database as every Object Explorer statement does, finds the object
/// by @object_schema and @object_name and its kind (<see cref="CatalogSql.ParentLookup"/>), and only then reads it through the one
/// dynamic statement Object Explorer runs, which the server builds from constant text and QUOTENAME of those parameters (a
/// memory-optimized table, or a view in a database that can hold one, is read under READ COMMITTED, which SQL Server maps to
/// SNAPSHOT for memory-optimized tables in autocommit, since they refuse the explorer pool's READ UNCOMMITTED), with the row count as a
/// parameter. <see cref="Lint"/> holds it to that. Values are read with the results grid's own readers (ColumnPlan, under a
/// cap per value), so they show as the grid shows them.</summary>
internal static partial class PeekRowsSql
{
    // The isolation level set inside the dynamic statement ends with it.
    private const string Dynamic = "DECLARE @rows nvarchar(700) = CASE WHEN EXISTS (SELECT 1 FROM sys.tables AS t WHERE t.object_id = @object_id AND t.is_memory_optimized = 1) "
        + "OR EXISTS (SELECT 1 FROM sys.views AS v WHERE v.object_id = @object_id) AND EXISTS (SELECT 1 FROM sys.filegroups AS f WHERE f.type = 'FX') "
        + "THEN N'SET TRANSACTION ISOLATION LEVEL READ COMMITTED; ' ELSE N'' END + N'SELECT TOP (@take) * FROM ' + QUOTENAME(@object_schema) + N'.' + QUOTENAME(@object_name) + N';';\n"
        + "EXEC sys.sp_executesql @rows, N'@take int', @take = @take;\n";

    /// <summary>The literals <see cref="Dynamic"/> may hold, and nothing else.</summary>
    private static readonly HashSet<string> Literals = ["N'SET TRANSACTION ISOLATION LEVEL READ COMMITTED; '", "N'SELECT TOP (@take) * FROM '", "N'.'", "N''", "N';'", "N'@take int'"];

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
        if (count == 0) return new(names, [], 0, more);
        var page = builder.Seal();
        var view = PageView.Parse(page, plan.Columns.Count);
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
