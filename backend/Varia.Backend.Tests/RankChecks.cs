using System.Globalization;
using System.Text;
using Varia.Backend;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Ranked keys: a text, date or binary key whose values repeat compares them by rank, and must order and group
/// exactly as the comparison it replaces: by collation, by code point for _BIN2 and types without a collation, ignoring
/// trailing spaces, NULL lowest; a key whose values are each a row's own is held another way and orders the same. Checked
/// against the runtime's own comparison, pair by pair, and through a sorted view, a filtered one and a pivot.</summary>
internal static class RankChecks
{
    // Latin1_General_CI_AS (IgnoreCase, IgnoreKanaType, IgnoreWidth), Latin1_General_CI_AI and Latin1_General_BIN2.
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);
    private static readonly ResultCollation AccentInsensitive = new(1033, 0, 1252, false, 1 | 2 | 8 | 16);
    private static readonly ResultCollation Bin2 = new(1033, 0, 1252, false, 16384);
    private static readonly ResultColumn[] Columns =
    [
        new("name", "nvarchar(60)", "text", Collation: CaseInsensitive), new("plain", "nvarchar(60)", "text", Collation: AccentInsensitive),
        new("code", "varchar(60)", "text", Collation: Bin2), new("day", "datetime2(7)", "text"), new("blob", "varbinary(60)", "binary"),
        new("id", "int", "text"), new("unique", "nvarchar(60)", "text", Collation: CaseInsensitive), new("long", "nvarchar(max)", "text", Collation: CaseInsensitive)
    ];
    private static readonly WireKind[] Wires = [.. Columns.Select(column => column.Wire == "binary" ? WireKind.Binary : WireKind.Text)];

    /// <summary>Values that differ only by case, accent, width, kana or trailing spaces, that share their first characters
    /// (so their keys' prefixes are equal), an empty one and NULL.</summary>
    private static readonly string?[] Names =
    [
        "apple", "Apple", "APPLE  ", "äpple", "Äpple", "apple pie", "applé", "ａｐｐｌｅ", "アップル", "ｱｯﾌﾟﾙ", "あっぷる", "", "   ", "résumé", "resume", "Résumé",
        "straße", "strasse", "Customer 0000000001", "Customer 0000000002", "customer 0000000001 ", "Customer 0000000001a", null, "zebra", "Zebra", "😀", "á", "á"
    ];
    private const int RowCount = 3000;

    private static string? Name(int row) => Names[row * 11 % Names.Length];
    private static string Day(int row) => new DateTime(2026, 1, 1).AddDays(row * 11 % 40).ToString("yyyy-MM-dd HH:mm:ss.fffffff", CultureInfo.InvariantCulture);
    private static byte[] Blob(int row) => [1, 2, 3, 4, 5, 6, 7, 8, 9, (byte)(row * 5 % 30), .. new byte[row % 3]];

    public static void Run(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = store.Open(store.BeginQuery("ranks"), 0, 1, 1, "rows", Columns, Wires) ?? throw new InvalidOperationException("The result set was not kept.");
        var longValue = new string('x', 1024) + "y";
        for (var row = 0; row < RowCount; row++)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            foreach (var column in new[] { 0, 1, 2 })
            {
                if (Name(row + column) is { } name) builder.AppendText(name);
                else builder.AppendNull();
            }
            builder.AppendText(Day(row));
            builder.AppendBinary(Blob(row));
            builder.AppendText(row.ToString(CultureInfo.InvariantCulture));
            builder.AppendText("Customer " + row.ToString("D10", CultureInfo.InvariantCulture));
            // One long value; a stored prefix (a truncated cell) in every 50th row.
            builder.AppendText(row == 1500 ? longValue : Name(row) ?? "", truncated: row % 50 == 0);
            set.TryCommitRow();
        }
        set.Complete();
        var pages = set.SealedSnapshot();
        var source = new ViewSorter.PageSource(pages, Wires.Length);
        var approximate = false;
        ViewSorter.Key Key(int column, int[]? kept = null) => ViewSorter.Build(set, source, new ViewKey(column, false, SortMode.Value), kept, RowCount, CancellationToken.None, ref approximate);
        static string Trim(string value) => value.TrimEnd(' ');
        // A date and time is held by its ticks, which compare as ranks do: without its cells.
        static bool Ranked(ViewSorter.Key key) => key.Layout.StartsWith("ranked", StringComparison.Ordinal) || key.Layout == "ticks";
        var culture = CultureInfo.GetCultureInfo(1033).CompareInfo;
        const CompareOptions insensitive = CompareOptions.IgnoreCase | CompareOptions.IgnoreKanaType | CompareOptions.IgnoreWidth;
        // What each column's comparison is, from the values themselves (never from a key).
        int Expected(int column, int a, int b)
        {
            switch (column)
            {
                case 0 or 1:
                    var (x, y) = (Name(a + column), Name(b + column));
                    if (x is null || y is null) return x is null ? y is null ? 0 : -1 : 1;
                    return Math.Sign(culture.Compare(Trim(x), Trim(y), column == 0 ? insensitive : insensitive | CompareOptions.IgnoreNonSpace));
                case 2:
                    var (left, right) = (Name(a + 2), Name(b + 2));
                    if (left is null || right is null) return left is null ? right is null ? 0 : -1 : 1;
                    return Math.Sign(Encoding.UTF8.GetBytes(Trim(left)).AsSpan().SequenceCompareTo(Encoding.UTF8.GetBytes(Trim(right))));
                case 3: return Math.Sign(string.CompareOrdinal(Day(a), Day(b)));
                default: return Math.Sign(Blob(a).AsSpan().SequenceCompareTo(Blob(b)));
            }
        }
        // Every pair among the first rows (each value meets each other), through the comparer a sort and a pivot use.
        string Pairs(int column, ViewSorter.Key key, Func<int, int>? row = null)
        {
            var comparer = new ViewSorter.Comparer([key], null, CancellationToken.None);
            for (var a = 0; a < 2 * Names.Length; a++)
                for (var b = 0; b < 2 * Names.Length; b++)
                    if (Math.Sign(comparer.Values(a, b)) != Expected(column, row?.Invoke(a) ?? a, row?.Invoke(b) ?? b)) return a + " and " + b;
            return "";
        }
        var names = new[] { "case-insensitive text", "accent-insensitive text", "_BIN2 text", "datetime2", "binary" };
        var wrong = new List<string>();
        for (var column = 0; column < 5; column++)
        {
            var key = Key(column);
            var pair = Pairs(column, key);
            var ranked = Ranked(key);
            if (!ranked || pair.Length > 0) wrong.Add(names[column] + (ranked ? ": rows " + pair : ": not ranked (" + key.Layout + ")"));
        }
        check(wrong.Count == 0, "a key of repeated text, dates or bytes compares by rank exactly as the values compare (collation, trailing spaces, code points, NULL lowest): " + string.Join("; ", wrong));

        // A view sorted by a ranked key is the stable sort of the same comparison, and so is one through a filter's kept rows.
        var (order, _) = ViewSorter.Sort(set, pages, [new ViewKey(0, false, SortMode.Value)], CancellationToken.None);
        var stable = Enumerable.Range(0, RowCount).ToArray();
        Array.Sort(stable, (a, b) => Expected(0, a, b) is var c && c != 0 ? c : a.CompareTo(b));
        var descending = ViewSorter.Sort(set, pages, [new ViewKey(3, true, SortMode.Value), new ViewKey(0, false, SortMode.Value)], CancellationToken.None).Order;
        var twoKeys = Enumerable.Range(0, RowCount).ToArray();
        Array.Sort(twoKeys, (a, b) => -Expected(3, a, b) is var c && c != 0 ? c : Expected(0, a, b) is var d && d != 0 ? d : a.CompareTo(b));
        check(order.SequenceEqual(stable) && descending.SequenceEqual(twoKeys), "a sort by ranked keys is the stable sort the values give, ascending, descending and by two keys");
        var kept = Enumerable.Range(0, RowCount).Where(row => row % 3 == 1).ToArray();
        var partial = Key(0, kept);
        check(Ranked(partial) && Pairs(0, partial, index => kept[index]).Length == 0, "a key built over the rows a filter kept ranks them by their place among those rows");
        var filtered = ViewSorter.Build(set, pages, [new ViewKey(0, true, SortMode.Value)], [new ViewFilter(FilterOp.In, 0, [0, 7], false, null, [])], CancellationToken.None).Order;
        var matching = Enumerable.Range(0, RowCount).Where(row => Expected(0, row, 0) == 0 || Expected(0, row, 7) == 0).ToArray();
        Array.Sort(matching, (a, b) => -Expected(0, a, b) is var c && c != 0 ? c : a.CompareTo(b));
        check(filtered.SequenceEqual(matching) && matching.Length > 0, "a filter on a ranked column keeps the rows whose values equal the chosen ones, and its sort shares the key");

        // A key whose values are each a row's own is not ranked, and a long value among repeated ones still is; both order as the values do.
        var unique = Key(6);
        var ascending = ViewSorter.Sort(set, pages, [new ViewKey(6, false, SortMode.Value)], CancellationToken.None).Order;
        approximate = false;
        var withLong = Key(7);
        var byLong = ViewSorter.Sort(set, pages, [new ViewKey(7, false, SortMode.Value)], CancellationToken.None).Order;
        int Long(int a, int b) => Math.Sign(culture.Compare(Trim(a == 1500 ? longValue : Name(a) ?? ""), Trim(b == 1500 ? longValue : Name(b) ?? ""), insensitive));
        var longOrder = Enumerable.Range(0, RowCount).ToArray();
        Array.Sort(longOrder, (a, b) => Long(a, b) is var c && c != 0 ? c : a.CompareTo(b));
        check(!Ranked(unique) && ascending.SequenceEqual(Enumerable.Range(0, RowCount)) && Ranked(withLong) && approximate && byLong.SequenceEqual(longOrder),
            "a key of values that are each a row's own is not ranked and sorts as they do; repeated values with a long one among them are, and a truncated cell still marks the order approximate: "
            + unique.Layout + " / " + withLong.Layout);
        // A pivot groups by the same comparison: one group a distinct value under the collation, NULL first, each counted once.
        var spec = new PivotSpec([0], 3, [new PivotValue(PivotAggregate.Count, -1), new PivotValue(PivotAggregate.CountDistinct, 2), new PivotValue(PivotAggregate.Max, 1)]);
        var model = ResultPivoter.Build(set, pages, null, spec, CancellationToken.None, _ => true);
        var groups = stable.Where((row, at) => at == 0 || Expected(0, stable[at - 1], row) != 0).ToArray();
        var counts = groups.Select(first => Enumerable.Range(0, RowCount).Count(row => Expected(0, row, first) == 0)).ToArray();
        var codes = groups.Select(first => (long)Enumerable.Range(0, RowCount).Where(row => Expected(0, row, first) == 0 && Name(row + 2) is not null)
            .Select(row => Convert.ToHexString(Encoding.UTF8.GetBytes(Trim(Name(row + 2)!)))).Distinct().Count()).ToArray();
        var highest = groups.Select(first => Enumerable.Range(0, RowCount).Where(row => Expected(0, row, first) == 0 && Name(row + 1) is not null)
            .Aggregate(-1, (best, row) => best < 0 || Expected(1, row, best) > 0 ? row : best)).ToArray();
        var total = model.ColumnReps.Length;
        check(model.RowGroups == groups.Length && model.RowReps.SequenceEqual(groups) && model.ColumnGroups == 40
            && groups.Select((_, g) => model.Figures[0].Counts[g * model.Stride + total]).SequenceEqual(counts.Select(count => (long)count))
            && groups.Select((_, g) => model.Figures[1].Counts[g * model.Stride + total]).SequenceEqual(codes)
            && groups.Select((_, g) => model.Figures[2].Best[g * model.Stride + total]).SequenceEqual(highest),
            "a pivot over ranked keys has one row group a distinct value under the collation (NULL first, named by its first row), 40 column groups of dates, "
            + "and its counts, distinct counts and highest values are the values': " + model.RowGroups + " groups for " + groups.Length);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var stopped = false;
        try { ResultPivoter.Build(set, pages, null, spec, cancelled.Token, _ => true); }
        catch (OperationCanceledException) { stopped = true; }
        check(stopped, "a pivot over ranked keys still stops when it is cancelled");
    }
}
