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
        Derived(check);
    }

    /// <summary>A result of the given columns, each row written by its own action.</summary>
    private static ResultSetBuffer FillRows(ResultStore store, QueryBudget budget, ResultColumn[] columns, params Action<PageBuilder>[] rows)
    {
        var set = store.Open(budget, Interlocked.Increment(ref fills), 1, 1, "rows", columns, [.. columns.Select(_ => WireKind.Text)]) ?? throw new InvalidOperationException("The result set was not kept.");
        foreach (var row in rows)
        {
            set.CountRow();
            row(set.BeginRow()!);
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    /// <summary>A result's exact values as (row, column, value), in order.</summary>
    private static List<(long Row, int Column, double Value)> Exacts(ResultSetBuffer set) =>
        [.. set.SealedSnapshot().SelectMany(page => page.Lengths.Exacts.Select(exact => (page.FirstRow + exact.Row, exact.Column, exact.Value)))];

    private static string Distinct(ResultSetBuffer set, int column, string? search = null) =>
        string.Join(",", ViewSorter.DistinctValues(set, set.SealedSnapshot(), null, column, set.IsComplete, CancellationToken.None)
            .Read(DistinctOrder.Value, 0, 20, search, CancellationToken.None).Values.Select(value => value.Text + "×" + value.Count));

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
        check(ResultStore.DefaultPacking == PagePacking.Off || set.HasPacked, "in the packed pass the result is packed, so its readers attach the sidecar of packed pages");
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
            var exactSearch = column == 1 ? "0002" : "00001";
            var searched = Distinct(set, column, exactSearch);
            check(searched == (column == 1 ? "1.0000000000000002×2" : "0.10000001×2"), $"the funnel's search on a {name} column matches the exact text it lists: " + searched);
            var identity = RowIdentity.Build(set, set.SealedSnapshot(), IdentityBy.Column, column, CancellationToken.None);
            check(!identity.Unique && identity.Ids[0] == identity.Ids[2] && identity.Ids[0] != identity.Ids[1],
                $"row identities on a {name} column are equal for one exact value and differ for values of one display text");
        }
        // Between from the lowest to the highest selected value keeps nothing past the highest, though it shows the same.
        var three = Fill(store, store.BeginQuery("between"), [(0, Low, RealLow), (1, High, RealHigh), (2, 1.0000000000000004d, MathF.BitIncrement(RealHigh))]);
        foreach (var column in new[] { 1, 2 })
        {
            var between = ViewSorter.Build(three, three.SealedSnapshot(), [], [new ViewFilter(FilterOp.Between, column, [1, 0], false, null, [])], CancellationToken.None).Order;
            check(string.Join(",", between) == "0,1", "Between ends at the highest selected exact value: " + string.Join(",", between));
        }
        // A sql_variant holding floats keeps their exact values too; its rows' identities tell them apart.
        ResultColumn[] variant = [new("V", "sql_variant", "text")];
        var variants = FillRows(store, store.BeginQuery("variant"), variant, row => row.AppendFloat(High), row => row.AppendFloat(Low));
        check(RowIdentity.Build(variants, variants.SealedSnapshot(), IdentityBy.Column, 0, CancellationToken.None).Unique,
            "a sql_variant column's floats of one display text have distinct row identities");
    }

    /// <summary>Results made from others (a Pivot, a comparison) keep the exact values of their float and real columns, and
    /// only theirs.</summary>
    private static void Derived(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store, store.BeginQuery("pivot"), [(0, High, RealHigh), (1, Low, RealLow), (2, High, RealHigh)]);
        var pages = set.SealedSnapshot();
        var spec = new PivotSpec([1], -1, [new PivotValue(PivotAggregate.Sum, 1), new PivotValue(PivotAggregate.Max, 1)]);
        var model = ResultPivoter.Build(set, pages, null, spec, CancellationToken.None, _ => true);
        var (columns, wires, lengths) = PivotOutput.Shape(set, pages, spec, model);
        var pivot = store.Open(set.Budget, set.Index, 1, 1, "pivot", columns, wires, lengths: lengths) ?? throw new InvalidOperationException("The pivot was not kept.");
        PivotOutput.Write(pivot, set, pages, spec, model, CancellationToken.None);
        var groups = Distinct(pivot, 0);
        var sums = Distinct(pivot, 1);
        var maxes = Distinct(pivot, 2);
        check(groups.Contains("1×1", StringComparison.Ordinal) && groups.Contains("1.0000000000000002×1", StringComparison.Ordinal),
            "a Pivot's row groups by a float keep their exact values, so its rows are two values: " + groups);
        check(sums.Contains("2.0000000000000004×1", StringComparison.Ordinal) && maxes.Contains("1.0000000000000002×1", StringComparison.Ordinal),
            $"a Pivot's float Sum is stored with its exact value, and its Max keeps its source's: {sums} / {maxes}");

        var budget = store.BeginQuery("unified");
        var left = Fill(store, budget, [(1, High, RealHigh), (2, Low, RealLow)]);
        var right = Fill(store, budget, [(1, Low, RealLow), (2, High, RealHigh)]);
        var diff = ResultDiffer.Compare(left, left.SealedSnapshot(), right, right.SealedSnapshot(), false, CancellationToken.None, match: new DiffMatch(DiffMatchMode.Columns, [0]));
        var unified = store.Open(budget, 90, 1, 1, "diff", UnifiedDiff.Columns(left, right, diff, true), UnifiedDiff.Wires(left, right, diff, true), lengths: UnifiedDiff.Lengths(left, right, diff, true))
            ?? throw new InvalidOperationException("The comparison was not kept.");
        UnifiedDiff.Write(unified, left, left.SealedSnapshot(), right, right.SealedSnapshot(), diff, -1, CancellationToken.None, oneRow: true);
        var kept = string.Join(",", Exacts(unified).Select(exact => $"{exact.Row}:{exact.Column}"));
        // One row a change: Id, F, R, then Id (old), F (old), R (old). Row 0 (Id 1) holds the new low values and the old high
        // ones; row 1 (Id 2) the new high values and the old low ones.
        check(kept == "0:4,0:5,1:1,1:2", "a comparison keeps the exact values of its float and real columns, new and old: " + kept);
        check(Distinct(unified, 1) == "1×1,1.0000000000000002×1" && Distinct(unified, 4) == "1×1,1.0000000000000002×1",
            "a comparison's float and old float columns list two values: " + Distinct(unified, 1) + " / " + Distinct(unified, 4));

        // A column whose type changed (float on the left, int on the right) takes no exact value from the left's rows.
        ResultColumn[] ints = [new("Id", "int", "text"), new("F", "int", "text")];
        ResultColumn[] floats = [new("Id", "int", "text"), new("F", "float", "text")];
        var was = FillRows(store, budget, floats, row => { row.AppendText("1"); row.AppendFloat(High); });
        var now = FillRows(store, budget, ints, row => { row.AppendText("2"); row.AppendText("1"); });
        var changed = ResultDiffer.Compare(was, was.SealedSnapshot(), now, now.SealedSnapshot(), false, CancellationToken.None, match: new DiffMatch(DiffMatchMode.Columns, [0]));
        var typed = store.Open(budget, 91, 1, 1, "diff", UnifiedDiff.Columns(now, changed), UnifiedDiff.Wires(now, changed), lengths: UnifiedDiff.Lengths(now, changed))
            ?? throw new InvalidOperationException("The comparison was not kept.");
        UnifiedDiff.Write(typed, was, was.SealedSnapshot(), now, now.SealedSnapshot(), changed, -1, CancellationToken.None);
        check(Exacts(typed).Count == 0, "a removed row's float in a column that is int in the newer result keeps no exact value there");
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
