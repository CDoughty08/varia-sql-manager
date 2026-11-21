using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Float and real values whose display text is the same (1E0 and 1.0000000000000002E0 both show as 1; a real
/// shows 7 digits) stay apart in every operation on a stored result: the page keeps the display text, and the exact value
/// beside it (PageLengths.Exacts) orders, filters, groups, compares and profiles them, while text cells that read back as
/// their value keep no entry.</summary>
internal static class FloatExactChecks
{
    private const double Low = 1d, High = 1.0000000000000002d;
    private static readonly float RealLow = 0.1f, RealHigh = MathF.BitIncrement(0.1f);

    private static readonly ResultColumn[] Columns = [new("Id", "int", "text"), new("F", "float", "text"), new("R", "real", "text")];
    private static int fills;

    public static void Run(Action<bool, string> check)
    {
        Builder(check);
        Operations(check);
        Comparison(check);
    }

    /// <summary>Rows of (Id, F, R); a NaN float or real stands for NULL.</summary>
    private static ResultSetBuffer Fill(ResultStore store, QueryBudget budget, (int Id, double F, float R)[] rows)
    {
        var set = store.Open(budget, Interlocked.Increment(ref fills), 1, 1, "rows", Columns, [.. Columns.Select(_ => WireKind.Text)]) ?? throw new InvalidOperationException("The result set was not kept.");
        foreach (var (id, f, r) in rows)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            builder.AppendText(id.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (double.IsNaN(f)) builder.AppendNull(); else builder.AppendFloat(f);
            if (float.IsNaN(r)) builder.AppendNull(); else builder.AppendReal(r);
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    private static string Text(PageView view, int column, int row) => System.Text.Encoding.UTF8.GetString(view.Span(column, row));

    private static void Builder(Action<bool, string> check)
    {
        check(CellText(High) == "1" && CellText(Low) == "1" && RealText(RealHigh) == "0.1" && RealText(RealLow) == "0.1",
            "the near-equal floats and reals the checks use show the same display text");
        var builder = new PageBuilder(1, [WireKind.Text, WireKind.Text]);
        builder.BeginRow();
        builder.AppendFloat(Low);
        builder.AppendFloat(0.1 + 0.2);
        builder.CommitRow();
        builder.BeginRow();
        builder.AppendFloat(High);
        builder.AppendReal(RealHigh);
        var open = builder.OpenRowLengthBytes;
        builder.AbortRow();
        builder.BeginRow();
        builder.AppendReal(RealLow);
        builder.AppendReal(RealHigh);
        builder.CommitRow();
        var page = builder.Seal(out var lengths);
        var view = PageView.Parse(page, 2).With(lengths);
        check(Text(view, 0, 0) == "1" && Text(view, 1, 0) == "0.3" && Text(view, 1, 1) == "0.1",
            "a float or real cell still holds its display text (15 or 7 significant digits)");
        check(lengths.Exacts.Count == 2 && !view.TryExact(0, 0, out _) && view.TryExact(1, 0, out var sum) && sum == 0.1 + 0.2
            && !view.TryExact(0, 1, out _) && view.TryExact(1, 1, out var real) && (float)real == RealHigh,
            "only cells whose text reads back as another value keep their exact value, and an aborted row keeps none: " + string.Join(",", lengths.Exacts));
        check(open >= 4 + 2 * PageLengths.ExactBytes && lengths.MemoryBytes == PageLengths.Overhead + 4 * 2 + 2 * PageLengths.ExactBytes,
            "the exact values are charged with the page's lengths sidecar, and an open row's are counted before it commits");
        check(!PageView.Parse(page, 2).TryExact(1, 0, out _), "a view without its page's sidecar reads only text");
    }

    private static string CellText(double value)
    {
        Span<byte> bytes = stackalloc byte[CellFormat.MaxFixedBytes];
        return System.Text.Encoding.ASCII.GetString(bytes[..CellFormat.WriteFloat(bytes, value)]);
    }

    private static string RealText(float value)
    {
        Span<byte> bytes = stackalloc byte[CellFormat.MaxFixedBytes];
        return System.Text.Encoding.ASCII.GetString(bytes[..CellFormat.WriteReal(bytes, value)]);
    }

    private static void Operations(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        // Rows 0 and 2 hold the larger values, row 1 the smaller ones, row 3 NULLs.
        var set = Fill(store, store.BeginQuery("floats"), [(0, High, RealHigh), (1, Low, RealLow), (2, High, RealHigh), (3, double.NaN, float.NaN)]);
        foreach (var (column, name) in new[] { (1, "float"), (2, "real") })
        {
            var sorted = ViewSorter.Build(set, set.SealedSnapshot(), [new ViewKey(column, false, SortMode.Value)], [], CancellationToken.None);
            check(string.Join(",", sorted.Order) == "3,1,0,2" && !sorted.Approximate,
                $"a {name} column sorts by exact value, the smaller of two values with one display text first, and the sort is exact: " + string.Join(",", sorted.Order));
            var descending = ViewSorter.Build(set, set.SealedSnapshot(), [new ViewKey(column, true, SortMode.Value)], [], CancellationToken.None).Order;
            check(string.Join(",", descending) == "0,2,1,3", $"a {name} column sorts descending by exact value: " + string.Join(",", descending));
            var filtered = ViewSorter.Build(set, set.SealedSnapshot(), [], [new ViewFilter(FilterOp.In, column, [1], false, null, [])], CancellationToken.None).Order;
            check(string.Join(",", filtered) == "1", $"a single-value filter on a {name} column keeps only that exact value: " + string.Join(",", filtered));
            var excluded = ViewSorter.Build(set, set.SealedSnapshot(), [], [new ViewFilter(FilterOp.NotIn, column, [0], false, null, [])], CancellationToken.None).Order;
            check(string.Join(",", excluded) == "1,3", $"excluding a {name} value drops only the rows of that exact value: " + string.Join(",", excluded));
            var duplicates = ViewSorter.Build(set, set.SealedSnapshot(), [], [new ViewFilter(FilterOp.Duplicates, -1, null, false, null, [column])], CancellationToken.None).Order;
            check(string.Join(",", duplicates) == "0,2", $"duplicates on a {name} column are the rows of one exact value: " + string.Join(",", duplicates));
            var distinct = ViewSorter.DistinctValues(set, set.SealedSnapshot(), null, column, set.IsComplete, CancellationToken.None);
            var values = distinct.Read(DistinctOrder.Value, 0, 10, null, CancellationToken.None).Values;
            var expected = column == 1 ? "1@1×1,1.0000000000000002@0×2" : "0.1@1×1,0.10000001@0×2";
            var listed = string.Join(",", values.Select(value => $"{value.Text}@{value.Row}×{value.Count}"));
            check(distinct.Distinct == 2 && listed == expected, $"a {name} column's distinct values count each exact value once, the one shown apart by its exact text: " + listed);
            var profile = ColumnProfiler.Profile(set, set.SealedSnapshot(), null, [column], set.IsComplete, CancellationToken.None).Columns[0];
            check(profile.Distinct == 2 && profile.DistinctExact, $"a {name} column's profile counts two distinct values: {profile.Distinct}");
        }
    }

    private static void Comparison(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var budget = store.BeginQuery("float-diff");
        var left = Fill(store, budget, [(1, High, RealHigh), (2, Low, RealLow)]);
        var right = Fill(store, budget, [(1, Low, RealLow), (2, High, RealHigh)]);
        foreach (var exact in new[] { false, true })
        {
            var model = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), exact, CancellationToken.None, match: new DiffMatch(DiffMatchMode.Columns, [0]));
            var kinds = string.Join(",", model.Entries.Select(entry => entry.Kind));
            check(kinds == "Changed,Changed" && !model.Approximate,
                $"floats and reals swapped across the same Ids are changed rows{(exact ? " in an exact-text comparison" : "")}, though their display text is equal: " + kinds);
        }
        var same = Fill(store, budget, [(1, High, RealHigh), (2, Low, RealLow)]);
        var unchanged = ResultDiffer.Compare(left, left.SealedSnapshot(), same, same.SealedSnapshot(), true, CancellationToken.None, match: new DiffMatch(DiffMatchMode.Columns, [0]));
        check(string.Join(",", unchanged.Entries.Select(entry => entry.Kind)) == "Same,Same", "the same exact values compare unchanged");
        var rows = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None, match: new DiffMatch(DiffMatchMode.Rows, []));
        check(rows.Entries.Count(entry => entry.Kind == DiffKind.Removed) == 2 && rows.Entries.Count(entry => entry.Kind == DiffKind.Added) == 2,
            "whole-row matching pairs no row whose exact values differ: " + string.Join(",", rows.Entries.Select(entry => entry.Kind)));
    }
}
