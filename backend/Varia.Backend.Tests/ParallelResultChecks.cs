using System.Globalization;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>The result work split over threads last: a pivot's Distinct Count, Compare Results' matching and alignment, and
/// a column's distinct values past the coded-grouping limit. Each is run with eight threads and with one, on rows chosen so
/// equal values, NULLs and copies span the threads' runs, and their answers must be the same (and, where it is simple to
/// say, the expected one); the pivot without room for its cell bounds and a diff refused part way are checked too, and
/// a cancellation from inside the work stops it as itself.</summary>
internal static class ParallelResultChecks
{
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);
    // Enough rows for eight runs of the parallel steps (each at least ViewSorter.MinSlice rows).
    private const int Rows = 300_000;

    public static void Run(Action<bool, string> check)
    {
        DistinctValues(check);
        PivotDistinct(check);
        Diff(check);
    }

    private static string Text(int value, int row) => (row % 2 == 0 ? "Name " : "NAME ") + value.ToString(CultureInfo.InvariantCulture);

    private static ResultSetBuffer Fill(ResultStore store, QueryBudget budget, int index, int rows, ResultColumn[] columns, Func<int, string?[]> row)
    {
        var set = store.Open(budget, index, 1, 1, "rows", columns, [.. columns.Select(_ => WireKind.Text)]) ?? throw new InvalidOperationException("The result set was not kept.");
        for (var r = 0; r < rows; r++)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            foreach (var cell in row(r))
            {
                if (cell is null) builder.AppendNull();
                else builder.AppendText(cell);
            }
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    /// <summary>Runs <paramref name="work"/> with eight threads, then with one. The count is set for this check's flow
    /// alone, so suites running beside it neither change it nor see it. The steps split their rows by the threads they ask
    /// for, so the eight-thread run crosses eight runs' boundaries even when the gate, busy with other suites, grants fewer.</summary>
    private static (T Parallel, T Alone) Both<T>(Func<T> work)
    {
        T parallel;
        using (ViewSorter.WorkersHere(8)) parallel = work();
        using (ViewSorter.WorkersHere(1)) return (parallel, work());
    }

    private static void DistinctValues(Action<bool, string> check)
    {
        var store = new ResultStore(2L << 30, 1L << 30);
        // An int of 100,000 values (past the 65,536 grouped without sorting), one of them on a third of the rows so its run
        // spans several threads' runs (one holding no value's start), and NULL every seventh row; and text of 90,000 values
        // each in two cases.
        var set = Fill(store, store.BeginQuery("parallel-distinct"), 0, Rows, [new("n", "int", "text"), new("t", "nvarchar(20)", "text", Collation: CaseInsensitive)], row =>
        [
            row % 7 == 0 ? null : (row % 3 == 0 ? 42 : row % 100_000).ToString(CultureInfo.InvariantCulture),
            row % 11 == 0 ? null : Text(row % 90_000, row / 90_000)
        ]);
        var pages = set.SealedSnapshot();
        // A kept view of every fifth row: a value is ticked when one of them holds it.
        var keptOrder = Enumerable.Range(0, Rows).Where(row => row % 5 == 0).ToArray();
        var kept = new ResultView(1, set, keptOrder, [], false, true, 0);
        (int Distinct, long Nulls, bool NullTicked, (int Row, long Count, bool Checked)[] ByValue, int[] ByCount) List(int column, ResultView? keptView)
        {
            var snapshot = ViewSorter.DistinctValues(set, pages, null, column, true, CancellationToken.None, keptView);
            var byValue = snapshot.Read(DistinctOrder.Value, 0, snapshot.Distinct, null, CancellationToken.None).Values;
            var byCount = snapshot.Read(DistinctOrder.Count, 0, snapshot.Distinct, null, CancellationToken.None).Values;
            return (snapshot.Distinct, snapshot.Nulls, snapshot.Ticks.NullChecked, [.. byValue.Select(value => (value.Row, value.Count, value.Checked))], [.. byCount.Select(value => value.Group)]);
        }
        foreach (var (column, name) in new[] { (0, "an int"), (1, "case-insensitive text") })
        {
            var (parallel, alone) = Both(() => List(column, kept));
            check(parallel.Distinct == alone.Distinct && parallel.Nulls == alone.Nulls && parallel.NullTicked == alone.NullTicked
                && parallel.ByValue.AsSpan().SequenceEqual(alone.ByValue) && parallel.ByCount.AsSpan().SequenceEqual(alone.ByCount),
                $"the distinct values of {name} past the coded limit are the same on eight threads as on one: groups, representative rows, counts, ticks and count order");
        }
        var (ints, _) = Both(() => List(0, null));
        var expected = Enumerable.Range(0, Rows).Where(row => row % 7 != 0).GroupBy(row => row % 3 == 0 ? 42 : row % 100_000).ToDictionary(group => group.Key, group => (Row: group.Min(), Count: (long)group.Count()));
        var values = expected.Keys.Order().ToArray();
        check(ints.Distinct == expected.Count && ints.Distinct > ViewSorter.MaxGroups && ints.Nulls == (Rows + 6) / 7
            && ints.ByValue.Select(value => (value.Row, value.Count)).SequenceEqual(values.Select(value => expected[value]))
            && ints.ByValue.All(value => value.Checked) && ints.ByCount[0] == Array.IndexOf(values, 42),
            "an int's distinct values past the coded limit on eight threads are each value once in value order, with its lowest row and its count, the most frequent first by count");
        var (texts, _) = Both(() => List(1, null));
        check(texts.Distinct == 90_000 && texts.ByValue.Sum(value => value.Count) == Rows - (Rows + 10) / 11,
            "text equal by its collation (two cases of each value) is one value on eight threads");
    }

    private static void PivotDistinct(Action<bool, string> check)
    {
        var store = new ResultStore(2L << 30, 1L << 30);
        var budget = store.BeginQuery("parallel-pivot");
        // 300 row groups (one NULL) by 7 column groups; the counted int repeats within and across cells, NULL every
        // thirteenth row; the counted text is equal by its collation in two cases. A second column group, h, has three
        // values of about 100,000 rows each (cells past a thread's slice, two of them not at the start) and three of 300.
        var set = Fill(store, budget, 0, Rows, [new("g", "int", "text"), new("c", "int", "text"), new("v", "int", "text"), new("t", "nvarchar(20)", "text", Collation: CaseInsensitive), new("h", "int", "text")], row =>
        [
            row % 301 == 0 ? null : (row % 300).ToString(CultureInfo.InvariantCulture),
            (row % 7).ToString(CultureInfo.InvariantCulture),
            row % 13 == 0 ? null : (row / 3 % 5_000).ToString(CultureInfo.InvariantCulture),
            row % 17 == 0 ? null : Text(row / 2 % 4_000, row),
            (row % 1_000 < 3 ? 3 + row % 1_000 : row % 3).ToString(CultureInfo.InvariantCulture)
        ]);
        var pages = set.SealedSnapshot();
        PivotSpec Spec(int[] rows, int column) => new(rows, column, [new PivotValue(PivotAggregate.CountDistinct, 2), new PivotValue(PivotAggregate.CountDistinct, 3)]);
        long[][] Counts(PivotSpec spec, Func<long, bool> reserve, CancellationToken token = default) =>
            [.. ResultPivoter.Build(set, pages, null, spec, token, reserve).Figures.Select(figures => figures.Counts)];
        // The second reservation is the distinct counts' cell bounds: refused, one sort counts them.
        Func<long, bool> NoBounds()
        {
            var calls = 0;
            return _ => ++calls == 1;
        }
        bool Same(long[][] a, long[][] b) => a.Length == b.Length && a.Zip(b).All(pair => pair.First.AsSpan().SequenceEqual(pair.Second));
        foreach (var (spec, name) in new[] { (Spec([0], 1), "by row and column groups"), (Spec([], -1), "of all rows, one cell of more rows than a thread's slice"),
            (Spec([], 4), "by a column group of three large cells and three small ones") })
        {
            var (parallel, alone) = Both(() => Counts(spec, _ => true));
            var (sorted, sortedAlone) = Both(() => Counts(spec, NoBounds()));
            check(Same(parallel, alone) && Same(parallel, sorted) && Same(parallel, sortedAlone),
                $"Distinct Count {name} is the same on eight threads as on one, and without room for the cell bounds (one sort by cell and value)");
        }
        // The expected figures, counted by hand: cell (g, c) and the row group's total.
        var (figures, _) = Both(() => Counts(Spec([0], 1), _ => true));
        // Groups ascending, NULL first; column groups 0 to 6, then the row group's total.
        static int Group(int row) => row % 301 == 0 ? 0 : row % 300 + 1;
        const int stride = 8;
        var seen = new HashSet<(int Cell, int Value)>[2];
        seen[0] = [];
        seen[1] = [];
        for (var row = 0; row < Rows; row++)
        {
            foreach (var cell in new[] { Group(row) * stride + row % 7, Group(row) * stride + 7 })
            {
                if (row % 13 != 0) seen[0].Add((cell, row / 3 % 5_000));
                if (row % 17 != 0) seen[1].Add((cell, row / 2 % 4_000));
            }
        }
        var expected = new long[301 * stride];
        var textExpected = new long[301 * stride];
        foreach (var (cell, _) in seen[0]) expected[cell]++;
        foreach (var (cell, _) in seen[1]) textExpected[cell]++;
        check(figures[0].AsSpan().SequenceEqual(expected) && figures[1].AsSpan().SequenceEqual(textExpected),
            "Distinct Count on eight threads counts each cell's and each row group's distinct values, NULL not among them and text equal by its collation as one");
        // A cancellation once a pass has placed its rows, as its cells are sorted and counted on several threads, stops the
        // build as itself: with the cell bounds, small cells, large cells (sorted by the parallel sort) and without the bounds.
        // Each pass places its rows (the cells, then the row groups' totals) for each value; a pivot without column groups
        // has rows only in its totals, the second placing.
        foreach (var (spec, reserve, at, name) in new[]
        {
            (Spec([0], 1), (Func<Func<long, bool>>)(() => _ => true), 1, "small cells"), (Spec([], -1), () => _ => true, 2, "one large cell"),
            (Spec([], 4), () => _ => true, 1, "large cells after the first"), (Spec([0], 1), NoBounds, 1, "no cell bounds")
        })
        {
            using var eight = ViewSorter.WorkersHere(8);
            using var cancel = new CancellationTokenSource();
            var placed = 0;
            var stages = new PivotStages { Placed = () => { if (++placed == at) cancel.Cancel(); } };
            string stopped;
            try { ResultPivoter.Build(set, pages, null, spec, cancel.Token, reserve(), null, stages); stopped = "finished"; }
            catch (OperationCanceledException) { stopped = "cancelled"; }
            catch (Exception error) { stopped = error.GetType().Name; }
            check(stopped == "cancelled", $"a pivot cancelled while its distinct values are counted on several threads ({name}) stops with the cancellation, as itself ({stopped})");
        }
    }

    private static void Diff(Action<bool, string> check)
    {
        var store = new ResultStore(2L << 30, 1L << 30);
        var budget = store.BeginQuery("parallel-diff");
        ResultColumn[] keyed = [new("id", "int", "text", Nullable: false), new("a", "int", "text"), new("t", "nvarchar(20)", "text", Collation: CaseInsensitive)];
        ResultColumn[] whole = [new("a", "int", "text"), new("t", "nvarchar(20)", "text", Collation: CaseInsensitive)];
        // The second result drops every 97th row and changes every 50th; a case change is a soft difference. Without a key,
        // rows repeat (each value on about a twentieth of the rows), so the k-th copy matches the k-th across threads' runs.
        string?[] Keyed(int source, bool second) =>
        [
            source.ToString(CultureInfo.InvariantCulture),
            second && source % 50 == 7 ? "-1" : (source % 1_000).ToString(CultureInfo.InvariantCulture),
            source % 9 == 0 ? null : Text(source % 2_000, second && source % 31 == 3 ? 1 : 0)
        ];
        string?[] Whole(int source, bool second) =>
        [
            (source % 20).ToString(CultureInfo.InvariantCulture),
            second && source % 50 == 7 ? "changed" : source % 9 == 0 ? null : Text(source % 3, second && source % 31 == 3 ? 1 : 0)
        ];
        int Source(int row) => row + row / 96;
        var right = Rows - Rows / 97;
        foreach (var (columns, make, name) in new[] { (keyed, (Func<int, bool, string?[]>)Keyed, "by a unique id"), (whole, Whole, "by whole rows that repeat") })
        {
            var left = Fill(store, budget, 0, Rows, columns, row => make(row, false));
            var other = Fill(store, budget, 1, right, columns, row => make(Source(row), true));
            var (parallel, alone) = Both(() => ResultDiffer.Compare(left, left.SealedSnapshot(), other, other.SealedSnapshot(), false, CancellationToken.None));
            var counts = parallel.Counts();
            check(parallel.Entries.AsSpan().SequenceEqual(alone.Entries) && parallel.Cells.AsSpan().SequenceEqual(alone.Cells) && parallel.KeyPair == alone.KeyPair
                && parallel.Approximate == alone.Approximate && counts.Removed >= Rows / 97 && (counts.Changed > 0) == (columns == keyed) && counts.Soft > 0 && (parallel.KeyPair >= 0) == (columns == keyed),
                $"results compared {name} align the same on eight threads as on one: entries, their order and their differing cells ({counts})");
            // A refusal fails the diff as TOO_LARGE, from any thread; each chunk is asked for once, never at once.
            var granted = 0;
            var asking = 0;
            var overlapped = false;
            string? Refused()
            {
                granted = 0;
                try
                {
                    ResultDiffer.Compare(left, left.SealedSnapshot(), other, other.SealedSnapshot(), true, CancellationToken.None, _ =>
                    {
                        overlapped |= Interlocked.Increment(ref asking) > 1;
                        var ok = ++granted <= 0;
                        Interlocked.Decrement(ref asking);
                        return ok;
                    });
                    return null;
                }
                catch (RequestException error) { return error.Code; }
            }
            if (columns == whole)
            {
                var (refused, refusedAlone) = Both(Refused);
                check(refused == "TOO_LARGE" && refusedAlone == "TOO_LARGE" && !overlapped,
                    "a diff whose differing cells pass the memory it is given fails as TOO_LARGE on eight threads as on one, each chunk asked for one at a time");
            }
            // A cancellation while cells are compared stops every thread, as itself.
            using var cancel = new CancellationTokenSource();
            string? Stopped()
            {
                try
                {
                    ResultDiffer.Compare(left, left.SealedSnapshot(), other, other.SealedSnapshot(), true, cancel.Token, _ =>
                    {
                        cancel.Cancel();
                        return true;
                    });
                    return null;
                }
                catch (OperationCanceledException) { return "cancelled"; }
                catch (Exception error) { return error.GetType().Name; }
            }
            if (columns == whole)
            {
                var (stopped, _) = Both(Stopped);
                check(stopped == "cancelled", "a diff cancelled while its cells are compared on several threads stops with the cancellation (" + stopped + ")");
            }
            store.Release([left.ResultId, other.ResultId]);
        }
    }
}
