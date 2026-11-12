using System.Globalization;

namespace Varia.Backend.Results;

/// <summary>Distinct column names for a derived result (a pivot), so no two headers match (ignoring case) and a
/// JSON save has no repeated key.</summary>
internal static class ColumnNames
{
    /// <summary>Makes every column's name distinct, visiting the columns in <paramref name="order"/> (every index once): the
    /// first to take a name keeps it, and a later one is numbered " (2)", " (3)", never with a number another column already
    /// has as its own name.</summary>
    public static void Unique(List<ResultColumn> columns, IEnumerable<int> order)
    {
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var names = new HashSet<string>(columns.Select(column => column.Name), StringComparer.OrdinalIgnoreCase);
        foreach (var i in order)
        {
            var name = columns[i].Name;
            if (used.Add(name)) continue;
            var n = 2;
            while (names.Contains(Numbered(name, n)) || !used.Add(Numbered(name, n))) n++;
            columns[i] = columns[i] with { Name = Numbered(name, n) };
        }
    }

    /// <summary>Distinct names keeping the columns' order: earlier columns keep theirs.</summary>
    public static void Unique(List<ResultColumn> columns) => Unique(columns, Enumerable.Range(0, columns.Count));

    private static string Numbered(string name, int n) => name + " (" + n.ToString(CultureInfo.InvariantCulture) + ")";
}
