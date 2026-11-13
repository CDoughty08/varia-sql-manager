using System.Diagnostics;
using System.Globalization;
using System.Numerics;
using System.Text;

namespace Varia.Backend.Results;

/// <summary>What a pivot value computes over the rows of one cell: COUNT(*) (Count without a column), COUNT(column),
/// COUNT(DISTINCT column), SUM, AVG, MIN or MAX.</summary>
internal enum PivotAggregate { Count, CountDistinct, Sum, Avg, Min, Max }

/// <summary>One pivot value: an aggregate of a column, or of the rows (Count with Column -1).</summary>
internal sealed record PivotValue(PivotAggregate Aggregate, int Column);

/// <summary>A pivot of a result: its row-group columns (in order), its column-group column (-1 for none) and its values.</summary>
internal sealed record PivotSpec(int[] Rows, int Column, PivotValue[] Values);

/// <summary>The pivot ran out of the memory its result's query budget had room for.</summary>
internal sealed class PivotTooLargeException : Exception;

/// <summary>Where one build's time went, for the pivot benchmark (--pivot-bench): Stopwatch ticks spent building sort keys,
/// grouping (the sorts by row groups and by the column group), aggregating over the pages and counting distinct values. Times
/// only: nothing of the rows. <see cref="Placed"/> is called each time distinct counting has placed its rows, just before it
/// sorts and counts them on several threads, so a check can cancel the build there.</summary>
internal sealed class PivotStages
{
    public long Keys, Grouping, Aggregation, Distinct;
    public Action? Placed;
}

/// <summary>Groups and aggregates, ready to write: each row group's and column group's first row (by the source's row
/// order), and each value's per-cell figures. Cell (g, c) is g * (ColumnGroups + 1) + c; c = ColumnGroups is the row group's
/// total over all its rows (the only cell without a column group).</summary>
internal sealed class PivotModel
{
    public required long Rows { get; init; }
    public required long RowGroups { get; init; }
    public required int[] RowReps { get; init; }
    public required long ColumnGroups { get; init; }
    public required int[] ColumnReps { get; init; }
    public required PivotFigures[] Figures { get; init; }
    public required bool Approximate { get; init; }
    public int Stride => ColumnReps.Length + 1;
}

/// <summary>One value's figures, a slot per cell: counts, sums (exact as whole numbers of the column's smallest unit, so
/// decimal(38, s) sums keep all 38 digits, flagged as an overflow past them; approximate as doubles) or the row holding a
/// lowest or highest value. <paramref name="scale"/> is an exact column's scale.</summary>
internal sealed class PivotFigures(PivotValue value, int cells, bool exact, int scale = 0)
{
    public PivotValue Value { get; } = value;
    public bool Exact { get; } = exact;
    public int Scale { get; } = scale;
    public readonly long[] Counts = value.Aggregate is PivotAggregate.Min or PivotAggregate.Max ? [] : new long[cells];
    public readonly Int128[] Sums = value.Aggregate is PivotAggregate.Sum or PivotAggregate.Avg && exact ? new Int128[cells] : [];
    public readonly double[] Doubles = value.Aggregate is PivotAggregate.Sum or PivotAggregate.Avg && !exact ? new double[cells] : [];
    public readonly bool[] Overflow = value.Aggregate is PivotAggregate.Sum or PivotAggregate.Avg && exact ? new bool[cells] : [];
    public readonly int[] Best = value.Aggregate is PivotAggregate.Min or PivotAggregate.Max ? Filled(cells) : [];

    /// <summary>Bytes a cell's slot holds for an aggregate.</summary>
    public static long CellBytes(PivotAggregate aggregate) => aggregate switch
    {
        PivotAggregate.Sum or PivotAggregate.Avg => 8 + 16 + 1,
        PivotAggregate.Min or PivotAggregate.Max => 4,
        _ => 8
    };

    private static int[] Filled(int cells)
    {
        var best = new int[cells];
        Array.Fill(best, -1);
        return best;
    }
}

/// <summary>Pivots a stored result's rows in memory (results.pivot), over its sealed rows or a view's (so sorts and filters
/// apply): rows grouped by the row-group columns' values, columns by the column-group column's, as GROUP BY groups them.
/// Values are equal by the sort's comparison (<see cref="ViewSorter"/>): a column's collation decides which texts are equal,
/// exact numerics compare as numbers, and NULL is a group of its own. Groups come in ascending order, NULL first. Bounds:
/// <see cref="MaxRowGroups"/> row groups, <see cref="MaxColumnGroups"/> column groups (fewer when its columns would pass a
/// page's) and <see cref="MaxCells"/> figures; a pivot past any of them is refused (INVALID_PARAMS) once its groups are known,
/// never shown in part: a summary missing groups would mislead. Its keys and figures are charged to the result's query
/// budget while it runs.</summary>
internal static class ResultPivoter
{
    public const int MaxRowFields = 8, MaxValues = 16, MaxRowGroups = 100_000, MaxColumnGroups = 256, MaxCells = 4_000_000;
    /// <summary>The longest column-group name, in UTF-16 units, before "…".</summary>
    public const int MaxLabelChars = 128;
    private const int CancelEvery = 1 << 14;

    /// <summary>Bytes the grouping holds besides the figures: a sort key per keyed column, the rows being sorted, and each
    /// row's row group and column group.</summary>
    public static long WorkingBytes(long rows, int keys) => ViewSorter.WorkingBytes(rows, keys) + 12 * rows;

    /// <summary>The columns a pivot needs a sort key of: its group columns, and the columns of its lowest, highest and
    /// distinct values.</summary>
    public static int KeyColumns(PivotSpec spec)
    {
        var columns = new HashSet<int>(spec.Rows);
        if (spec.Column >= 0) columns.Add(spec.Column);
        foreach (var value in spec.Values)
            if (value.Aggregate is PivotAggregate.Min or PivotAggregate.Max or PivotAggregate.CountDistinct) columns.Add(value.Column);
        return columns.Count;
    }

    /// <summary>A column SUM and AVG take: exact or approximate numerics (not bit), as SQL Server's SUM does.</summary>
    public static bool IsNumeric(ResultColumn column, WireKind wire) =>
        ViewSorter.KindOf(column, wire) is ViewSorter.Kind.Approximate || (ViewSorter.KindOf(column, wire) is ViewSorter.Kind.Exact && ViewSorter.TypeName(column) != "bit");

    /// <summary>Groups the rows (the view's, in its order, or the sealed ones) and aggregates each value. <paramref name="reserve"/>
    /// is asked for the figures' bytes once the groups are known; false throws <see cref="PivotTooLargeException"/>.</summary>
    public static PivotModel Build(ResultSetBuffer set, StoredPage[] pages, int[]? order, PivotSpec spec, CancellationToken token, Func<long, bool> reserve, ViewSorter.KeyMemory? memory = null,
        PivotStages? stages = null)
    {
        try { return Build(set, pages, order, spec, reserve, memory, stages, token); }
        finally { memory?.ReturnAll(); }
    }

    private static PivotModel Build(ResultSetBuffer set, StoredPage[] pages, int[]? order, PivotSpec spec, Func<long, bool> reserve, ViewSorter.KeyMemory? memory, PivotStages? stages, CancellationToken token)
    {
        long total = 0;
        foreach (var page in pages) total += page.Rows;
        if (total > Array.MaxLength) throw new RequestException("TOO_LARGE", "This result has too many rows to pivot.");
        var rows = (int)total;
        var source = new ViewSorter.PageSource(pages, set.Wires.Count);
        var approximate = false;
        var keys = new Dictionary<int, ViewSorter.Key>();
        ViewSorter.Key KeyOf(int column)
        {
            if (!keys.TryGetValue(column, out var key))
            {
                var started = Stopwatch.GetTimestamp();
                keys[column] = key = ViewSorter.Build(set, source, new ViewKey(column, false, SortMode.Value), null, rows, token, ref approximate, memory);
                if (stages is not null) stages.Keys += Stopwatch.GetTimestamp() - started;
            }
            return key;
        }
        int[] positions;
        if (order is null)
        {
            positions = new int[rows];
            for (var i = 0; i < rows; i++) positions[i] = i;
        }
        else positions = order;
        var scratch = new int[positions.Length];

        // Each grouping keeps its groups' first rows only up to its bound, still counting past it for the refusal's message,
        // and is refused before the next grouping runs. The messages name no column or value (the renderer knows which).
        var rowKeys = spec.Rows.Select(KeyOf).ToArray();
        var grouping = Stopwatch.GetTimestamp();
        var (groupOf, rowReps, rowGroups) = Group(rowKeys, positions, rows, scratch, token, all: true, MaxRowGroups);
        if (stages is not null) stages.Grouping += Stopwatch.GetTimestamp() - grouping;
        if (rowGroups > MaxRowGroups)
            throw new RequestException("INVALID_PARAMS", string.Format(CultureInfo.InvariantCulture,
                "The row groups make {0:N0} rows, and a pivot can have at most {1:N0}. Group by fewer columns, or filter the rows first.", rowGroups, MaxRowGroups));
        int[] columnOf;
        List<int> columnReps;
        if (spec.Column >= 0)
        {
            var columnLimit = ColumnGroupLimit(spec);
            var columnKey = KeyOf(spec.Column);
            grouping = Stopwatch.GetTimestamp();
            (columnOf, columnReps, var counted) = Group([columnKey], positions, rows, scratch, token, all: false, columnLimit);
            if (stages is not null) stages.Grouping += Stopwatch.GetTimestamp() - grouping;
            if (counted > columnLimit)
                throw new RequestException("INVALID_PARAMS", string.Format(CultureInfo.InvariantCulture,
                    "The column group has {0:N0} distinct values, and a pivot can have at most {1:N0} column groups{2}. Choose a column with fewer values, or move it to Rows.",
                    counted, columnLimit, columnLimit < MaxColumnGroups ? string.Format(CultureInfo.InvariantCulture, " with {0} values", spec.Values.Length) : ""));
        }
        else (columnOf, columnReps) = ([], []);

        var columnGroups = columnReps.Count;
        var figureCount = (long)rowReps.Count * (columnGroups + 1) * spec.Values.Length;
        if (figureCount > MaxCells)
            throw new RequestException("INVALID_PARAMS", string.Format(CultureInfo.InvariantCulture,
                "This pivot would have {0:N0} figures, and a pivot can have at most {1:N0}. Use fewer values, row groups or column groups.", figureCount, MaxCells));
        var stride = columnGroups + 1;
        var cells = rowReps.Count * stride;
        long bytes = 0;
        foreach (var value in spec.Values) bytes += PivotFigures.CellBytes(value.Aggregate) * cells;
        if (!reserve(bytes)) throw new PivotTooLargeException();

        var figures = spec.Values.Select(value => value.Column >= 0 && ViewSorter.KindOf(set.Columns[value.Column], set.Wires[value.Column]) == ViewSorter.Kind.Exact
            ? new PivotFigures(value, cells, true, Scale(set.Columns[value.Column])) : new PivotFigures(value, cells, false)).ToArray();
        // A row outside the view (no row group) counts nowhere; every other row counts in its cell and its row group's total.
        int CellOf(int row, out int total)
        {
            var g = groupOf[row];
            if (g < 0) { total = -1; return -1; }
            total = g * stride + columnGroups;
            if (columnOf.Length == 0) return -1;
            var c = columnOf[row];
            return c >= 0 ? g * stride + c : -1;
        }
        var extremes = figures.Where(item => item.Value.Aggregate is PivotAggregate.Min or PivotAggregate.Max).Select(item => (Figures: item, Key: KeyOf(item.Value.Column))).ToArray();
        var counter = 0;
        var aggregating = Stopwatch.GetTimestamp();
        foreach (var (index, page) in source.Pages())
        {
            var view = source.View(index);
            var first = (int)page.FirstRow;
            for (var r = 0; r < page.Rows; r++)
            {
                if ((++counter & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                var row = first + r;
                var cell = CellOf(row, out var totalCell);
                if (totalCell < 0) continue;
                foreach (var item in figures)
                {
                    var value = item.Value;
                    if (value.Aggregate is PivotAggregate.Min or PivotAggregate.Max or PivotAggregate.CountDistinct) continue;
                    if (value.Column >= 0 && view.IsNull(value.Column, r)) continue;
                    if (value.Aggregate == PivotAggregate.Count)
                    {
                        if (cell >= 0) item.Counts[cell]++;
                        item.Counts[totalCell]++;
                        continue;
                    }
                    var span = view.Span(value.Column, r);
                    if (item.Exact)
                    {
                        var parsed = TryScaled(span, item.Scale, out var number);
                        Add(item, cell, parsed, number);
                        Add(item, totalCell, parsed, number);
                    }
                    else if (double.TryParse(span, NumberStyles.Float, CultureInfo.InvariantCulture, out var number))
                    {
                        if (cell >= 0) { item.Doubles[cell] += number; item.Counts[cell]++; }
                        item.Doubles[totalCell] += number;
                        item.Counts[totalCell]++;
                    }
                }
                foreach (var (item, key) in extremes)
                {
                    if (key.IsNull(row)) continue;
                    var max = item.Value.Aggregate == PivotAggregate.Max;
                    Extreme(item.Best, cell, row, key, max);
                    Extreme(item.Best, totalCell, row, key, max);
                }
            }
        }
        if (stages is not null) stages.Aggregation += Stopwatch.GetTimestamp() - aggregating;
        // Distinct counts place each cell's rows together first, which takes a bound per cell: without room for them, one
        // sort by cell and value does.
        int[]? bounds = null;
        if (figures.Any(item => item.Value.Aggregate == PivotAggregate.CountDistinct) && reserve(DistinctBoundsBytes(cells))) bounds = new int[cells + 1];
        foreach (var item in figures)
        {
            if (item.Value.Aggregate != PivotAggregate.CountDistinct) continue;
            var distinctKey = KeyOf(item.Value.Column);
            var counting = Stopwatch.GetTimestamp();
            Distinct(item, distinctKey, positions, scratch, CellOf, bounds, stages?.Placed, token);
            if (stages is not null) stages.Distinct += Stopwatch.GetTimestamp() - counting;
        }

        return new PivotModel
        {
            Rows = positions.Length, RowGroups = rowReps.Count, RowReps = [.. rowReps], ColumnGroups = columnGroups, ColumnReps = [.. columnReps],
            Figures = figures, Approximate = approximate
        };
    }

    /// <summary>The most column groups a pivot of <paramref name="spec"/> can have: 256, fewer when the row-group columns,
    /// each column group's values and the totals would pass a page's 4,096 columns.</summary>
    public static int ColumnGroupLimit(PivotSpec spec) => Math.Min(MaxColumnGroups, (PageBuilder.MaxColumns - spec.Rows.Length) / spec.Values.Length - 1);

    /// <summary>Each position's group by the keys' values (equal values, NULL equal to NULL, as GROUP BY), numbered in
    /// ascending order, and each group's first row. With no keys every position is one group, which exists even without rows
    /// when <paramref name="all"/> (a pivot without row groups has its one row, as an aggregate without GROUP BY does). Past
    /// <paramref name="limit"/> groups it keeps no more first rows, only counting them (the pivot is then refused).</summary>
    private static (int[] Of, List<int> Reps, long Count) Group(ViewSorter.Key[] keys, int[] positions, int rows, int[] scratch, CancellationToken token, bool all, int limit)
    {
        var of = new int[rows];
        Array.Fill(of, -1);
        var reps = new List<int>();
        if (keys.Length == 0)
        {
            if (all) reps.Add(positions.Length > 0 ? positions.Min() : -1);
            foreach (var row in positions) of[row] = 0;
            return (of, reps, reps.Count);
        }
        positions.CopyTo(scratch, 0);
        var comparer = new ViewSorter.Comparer(keys, null, token);
        ViewSorter.ThrowIfSlow(keys, scratch);
        ViewSorter.Sort(scratch, 0, scratch.Length, comparer);
        long count = 0;
        for (var i = 0; i < scratch.Length; i++)
        {
            var row = scratch[i];
            if (i == 0 || comparer.Values(scratch[i - 1], row) != 0)
            {
                count++;
                if (count <= limit) reps.Add(row);
            }
            if (count <= limit) of[row] = (int)count - 1;
        }
        return (of, reps, count);
    }

    /// <summary>10^38: a decimal(38, s) holds whole numbers of its smallest unit below it.</summary>
    internal static readonly Int128 Decimal38 = Int128.Parse("100000000000000000000000000000000000000", CultureInfo.InvariantCulture);

    private static void Add(PivotFigures figures, int cell, bool parsed, Int128 number)
    {
        if (cell < 0) return;
        figures.Counts[cell]++;
        if (!parsed) { figures.Overflow[cell] = true; return; }
        if (figures.Overflow[cell]) return;
        // Both are below 10^38 in size, so the bound is tested before adding: their sum could pass Int128's range.
        var current = figures.Sums[cell];
        if (number > 0 ? current >= Decimal38 - number : current <= -Decimal38 - number) figures.Overflow[cell] = true;
        else figures.Sums[cell] = current + number;
    }

    /// <summary>An exact numeric's text ("-12.50", as decimal, money and the integers are stored) as a whole number of
    /// 10^-<paramref name="scale"/>: false for anything else, for more decimals than the scale, or at 10^38 units or more.</summary>
    internal static bool TryScaled(ReadOnlySpan<byte> text, int scale, out Int128 value)
    {
        value = 0;
        var i = 0;
        var negative = false;
        if (i < text.Length && text[i] is (byte)'-' or (byte)'+') negative = text[i++] == '-';
        int digits = 0, decimals = 0, significant = 0;
        var point = false;
        for (; i < text.Length; i++)
        {
            var c = text[i];
            if (c == '.' && !point) { point = true; continue; }
            if (c is < (byte)'0' or > (byte)'9') return false;
            digits++;
            if (point && ++decimals > scale) return false;
            if (significant == 0 && c == '0') continue;
            if (++significant > 38) return false;
            value = value * 10 + (c - '0');
        }
        if (digits == 0) return false;
        // Tested before multiplying: a 38-digit value times 10 would pass Int128's range and wrap.
        for (; decimals < scale; decimals++)
        {
            if (value >= Decimal38 / 10) return false;
            value *= 10;
        }
        if (value >= Decimal38) return false;
        if (negative) value = -value;
        return true;
    }

    /// <summary>The scale of an exact numeric column's values (decimal(p,s)'s s; money's 4; integers' 0).</summary>
    internal static int Scale(ResultColumn column) => ViewSorter.TypeName(column) switch
    {
        "money" or "smallmoney" => 4,
        "decimal" or "numeric" => column.Scale ?? 0,
        _ => 0
    };

    /// <summary>An integer type, whose SUM is a bigint as SQL Server's is.</summary>
    internal static bool IsInteger(ResultColumn column) => ViewSorter.TypeName(column) is "tinyint" or "smallint" or "int" or "bigint";

    /// <summary>Keeps the lower (or higher) of a cell's row and this one; equal values keep the earlier row.</summary>
    private static void Extreme(int[] best, int cell, int row, ViewSorter.Key key, bool max)
    {
        if (cell < 0) return;
        var current = best[cell];
        if (current < 0) { best[cell] = row; return; }
        var compared = key.Compare(row, current);
        if (max ? compared > 0 : compared < 0) best[cell] = row;
    }

    private delegate int CellFinder(int row, out int total);

    /// <summary>Bytes the distinct counts' cell bounds take: one int a cell and one more.</summary>
    internal static long DistinctBoundsBytes(int cells) => 4L * (cells + 1);

    /// <summary>COUNT(DISTINCT): each cell's non-NULL rows counted once per run of equal values, then again by row group alone
    /// for the totals. With <paramref name="bounds"/> the rows are placed by cell (a counting sort, in one pass) and the cells
    /// shared among the threads the gate has free, each sorting and counting its own; a cell of many rows is sorted on
    /// several threads and its runs counted in parts. Without, one sort by cell then value (on several threads) and one pass.
    /// Either way a cell's count is its number of distinct values, whatever order its rows were met in.</summary>
    private static void Distinct(PivotFigures figures, ViewSorter.Key key, int[] positions, int[] scratch, CellFinder cellOf, int[]? bounds, Action? placed, CancellationToken token)
    {
        var comparer = new ViewSorter.Comparer([key], null, token);
        foreach (var totals in new[] { false, true })
        {
            int Cell(int row)
            {
                var cell = cellOf(row, out var total);
                return totals ? total : cell;
            }
            if (bounds is null)
            {
                Sorted(figures, key, positions, scratch, Cell, comparer, placed, token);
                continue;
            }
            // Counts by cell, shifted one up, become each cell's start; placing a row moves its cell's start on, so after
            // placing, bounds[c] is where cell c ends (and cell c + 1 starts).
            Array.Clear(bounds);
            var count = 0;
            for (var i = 0; i < positions.Length; i++)
            {
                if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                var row = positions[i];
                if (key.IsNull(row)) continue;
                var cell = Cell(row);
                if (cell < 0) continue;
                bounds[cell + 1]++;
                count++;
            }
            var cells = bounds.Length - 1;
            for (var cell = 0; cell < cells; cell++) bounds[cell + 1] += bounds[cell];
            for (var i = 0; i < positions.Length; i++)
            {
                if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                var row = positions[i];
                if (key.IsNull(row)) continue;
                var cell = Cell(row);
                if (cell >= 0) scratch[bounds[cell]++] = row;
            }
            placed?.Invoke();
            int Start(int cell) => cell == 0 ? 0 : bounds[cell - 1];
            // A cell of many rows is sorted by the parallel sort, its runs counted in parts on the threads the gate has free.
            for (var cell = 0; cell < cells; cell++)
            {
                var (start, end) = (Start(cell), bounds[cell]);
                if (end - start < 2 * ViewSorter.MinSlice) continue;
                ViewSorter.Sort(scratch, start, end - start, comparer);
                var parts = Math.Min(ViewSorter.Workers, (end - start) / ViewSorter.MinSlice);
                using var threads = ViewSorter.Gate.Take(parts);
                var found = new long[parts];
                threads.For(parts, part =>
                {
                    long runs = 0;
                    for (int i = start + ViewSorter.RunStart(end - start, part, parts), stop = start + ViewSorter.RunStart(end - start, part + 1, parts); i < stop; i++)
                        if (i == start || comparer.Values(scratch[i - 1], scratch[i]) != 0) runs++;
                    found[part] = runs;
                }, token);
                figures.Counts[cell] = found.Sum();
            }
            // The other cells in even runs of rows, each cell in the run its first row is in.
            {
                var wanted = Math.Clamp(count / ViewSorter.MinSlice, 1, ViewSorter.Workers);
                using var threads = ViewSorter.Gate.Take(wanted);
                // More runs than threads, so a run of slow cells does not keep the rest waiting.
                var runs = wanted == 1 ? 1 : 8 * wanted;
                threads.For(runs, run =>
                {
                    var stop = ViewSorter.RunStart(count, run + 1, runs);
                    for (var cell = FirstCell(bounds, ViewSorter.RunStart(count, run, runs)); cell < cells && Start(cell) < stop; cell++)
                    {
                        var (start, end) = (Start(cell), bounds[cell]);
                        if (end == start || end - start >= 2 * ViewSorter.MinSlice) continue;
                        token.ThrowIfCancellationRequested();
                        if (end - start > 1) Array.Sort(scratch, start, end - start, comparer);
                        long distinct = 1;
                        for (var i = start + 1; i < end; i++)
                            if (comparer.Values(scratch[i - 1], scratch[i]) != 0) distinct++;
                        figures.Counts[cell] = distinct;
                    }
                }, token);
            }
        }
    }

    /// <summary>The first cell starting at or after <paramref name="row"/>, given each cell's end.</summary>
    private static int FirstCell(int[] ends, int row)
    {
        if (row <= 0) return 0;
        // The first cell ending at or after the row; the next one starts there.
        int low = 0, high = ends.Length - 1;
        while (low < high)
        {
            var middle = (low + high) / 2;
            if (ends[middle] >= row) high = middle;
            else low = middle + 1;
        }
        return low + 1;
    }

    /// <summary>COUNT(DISTINCT) without cell bounds: the non-NULL rows sorted by cell then value (on several threads),
    /// counting each run of equal values once.</summary>
    private static void Sorted(PivotFigures figures, ViewSorter.Key key, int[] positions, int[] scratch, Func<int, int> cellOf, ViewSorter.Comparer comparer, Action? placed, CancellationToken token)
    {
        var count = 0;
        for (var i = 0; i < positions.Length; i++)
        {
            if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
            var row = positions[i];
            if (!key.IsNull(row) && cellOf(row) >= 0) scratch[count++] = row;
        }
        placed?.Invoke();
        var byCell = new CellOrder(cellOf, comparer);
        ViewSorter.Sort(scratch, 0, count, byCell);
        for (var i = 0; i < count; i++)
        {
            if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
            if (i == 0 || byCell.Values(scratch[i - 1], scratch[i]) != 0) figures.Counts[cellOf(scratch[i])]++;
        }
    }

    /// <summary>Rows by cell, then value, then row: a total order, as the parallel sort needs.</summary>
    private sealed class CellOrder(Func<int, int> cellOf, ViewSorter.Comparer values) : IComparer<int>
    {
        public int Values(int a, int b)
        {
            var compared = cellOf(a).CompareTo(cellOf(b));
            return compared != 0 ? compared : values.Values(a, b);
        }
        public int Compare(int a, int b)
        {
            var compared = Values(a, b);
            return compared != 0 ? compared : a.CompareTo(b);
        }
    }
}

/// <summary>The pivot as a stored result (kind "pivot"): the row-group columns, then for each column group each value,
/// then each value's total over the row group. Copy and Save read it as any result (ResultTextWriter).</summary>
internal static class PivotOutput
{
    public static string Label(PivotValue value, IReadOnlyList<ResultColumn> columns)
    {
        var name = value.Column >= 0 ? columns[value.Column].Name : "";
        return value.Aggregate switch
        {
            PivotAggregate.Count when value.Column < 0 => "Count of rows",
            PivotAggregate.Count => "Count of " + name,
            PivotAggregate.CountDistinct => "Distinct Count of " + name,
            PivotAggregate.Sum => "Sum of " + name,
            PivotAggregate.Avg => "Average of " + name,
            PivotAggregate.Min => "Min of " + name,
            _ => "Max of " + name
        };
    }

    /// <summary>A column group's name: its value's display text ("NULL", "(blank)" for empty or spaces, binary as 0x hex), at
    /// most <see cref="ResultPivoter.MaxLabelChars"/> characters and "…".</summary>
    public static string GroupName(ResultSetBuffer set, RowAccess access, int column, int row)
    {
        var view = access.At(row, out var at);
        if (view.IsNull(column, at)) return "NULL";
        var span = view.Span(column, at);
        if (view.Wire(column) == WireKind.Binary)
            return "0x" + Convert.ToHexString(span[..Math.Min(span.Length, ResultPivoter.MaxLabelChars / 2)]) + (span.Length > ResultPivoter.MaxLabelChars / 2 ? "…" : "");
        // Only the first characters are kept: decode a prefix that holds more than them (four bytes a character at most),
        // cut at a character boundary, not a value of megabytes.
        var take = Math.Min(span.Length, 4 * (ResultPivoter.MaxLabelChars + 1));
        while (take < span.Length && take > 0 && (span[take] & 0xc0) == 0x80) take--;
        var text = Encoding.UTF8.GetString(span[..take]);
        // Blank only when the whole value is: a long run of spaces may still end in text.
        if (text.AsSpan().Trim().Length == 0 && (take == span.Length || Encoding.UTF8.GetString(span).AsSpan().Trim().Length == 0)) return "(blank)";
        var cut = CellFormat.Prefix(text, ResultPivoter.MaxLabelChars, out var truncated);
        return truncated || take < span.Length || view.IsTruncated(column, at) ? cut.ToString() + "…" : text;
    }

    /// <summary>A value's column: its name and the type its figures have. Counts are bigint; sums of integers are bigint and
    /// other exact sums keep their scale (as SQL Server's SUM, widened to 38 digits), floats stay floats; averages of exact numerics keep at least 6 decimals; lowest and
    /// highest are the source column's own type, collation included.</summary>
    private static ResultColumn ValueColumn(ResultSetBuffer source, PivotValue value, string name)
    {
        if (value.Aggregate is PivotAggregate.Count or PivotAggregate.CountDistinct) return new ResultColumn(name, "bigint", "text", Nullable: false);
        var column = source.Columns[value.Column];
        if (value.Aggregate is PivotAggregate.Min or PivotAggregate.Max) return column with { Name = name, Nullable = true };
        if (ViewSorter.KindOf(column, source.Wires[value.Column]) != ViewSorter.Kind.Exact) return new ResultColumn(name, "float", "text", Precision: 53);
        var scale = ResultPivoter.Scale(column);
        if (value.Aggregate == PivotAggregate.Avg) scale = Math.Max(scale, 6);
        else if (ResultPivoter.IsInteger(column)) return new ResultColumn(name, "bigint", "text");
        return new ResultColumn(name, "decimal(38," + scale.ToString(CultureInfo.InvariantCulture) + ")", "text", Precision: 38, Scale: scale);
    }

    public static (IReadOnlyList<ResultColumn> Columns, IReadOnlyList<WireKind> Wires, IReadOnlyList<ColumnLength> Lengths) Shape(ResultSetBuffer source, StoredPage[] pages, PivotSpec spec, PivotModel model)
    {
        var columns = new List<ResultColumn>();
        var wires = new List<WireKind>();
        var lengths = new List<ColumnLength>();
        foreach (var column in spec.Rows)
        {
            columns.Add(source.Columns[column] with { Nullable = true });
            wires.Add(source.Wires[column]);
            lengths.Add(source.Lengths[column]);
        }
        var access = new RowAccess(pages, source.Wires.Count);
        var groups = model.ColumnReps.Select(row => GroupName(source, access, spec.Column, row)).ToList();
        if (spec.Column >= 0) groups.Add("Total");
        else groups.Add("");
        Distinguish(groups, spec.Column >= 0);
        foreach (var group in groups)
        {
            foreach (var value in spec.Values)
            {
                var label = Label(value, source.Columns);
                var name = group.Length == 0 ? label : spec.Values.Length == 1 ? group : group + " · " + label;
                columns.Add(ValueColumn(source, value, name));
                var copied = value.Aggregate is PivotAggregate.Min or PivotAggregate.Max;
                wires.Add(copied ? source.Wires[value.Column] : WireKind.Text);
                lengths.Add(copied ? source.Lengths[value.Column] : ColumnLength.Utf16);
            }
        }
        Unique(columns, spec.Rows.Length, spec.Values.Length);
        return (columns, wires, lengths);
    }

    /// <summary>Makes every column's name distinct (ignoring case), so no two headers match and a JSON save has no repeated
    /// key: the row-group columns keep the source's names, then the totals (or, without a column group, the values) keep
    /// theirs, then the column groups' columns in order; a later name already taken is numbered " (2)", " (3)".</summary>
    internal static void Unique(List<ResultColumn> columns, int rows, int values) =>
        ColumnNames.Unique(columns, Enumerable.Range(0, rows).Concat(Enumerable.Range(columns.Count - values, values)).Concat(Enumerable.Range(rows, columns.Count - rows - values)));

    /// <summary>Makes the column groups' names distinct, so no two columns share a header (and a JSON save no key): the NULL
    /// group keeps "NULL" and Total keeps "Total"; a text value of the same name, or values that share their first 128
    /// characters, are numbered " (2)", " (3)" in group order.</summary>
    internal static void Distinguish(List<string> groups, bool total)
    {
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (total) used.Add(groups[^1]);
        // The NULL group (first when present, as groups sort NULL first) keeps its name over a text 'NULL'.
        for (var i = 0; i < groups.Count - (total ? 1 : 0); i++)
        {
            var name = groups[i];
            if (!used.Add(name))
            {
                var n = 2;
                while (!used.Add(name + " (" + n.ToString(CultureInfo.InvariantCulture) + ")")) n++;
                groups[i] = name + " (" + n.ToString(CultureInfo.InvariantCulture) + ")";
            }
        }
    }

    /// <summary>Writes a row per row group shown into <paramref name="set"/> (opened with <see cref="Shape"/>), then
    /// completes it.</summary>
    public static void Write(ResultSetBuffer set, ResultSetBuffer source, StoredPage[] pages, PivotSpec spec, PivotModel model, CancellationToken token)
    {
        var access = new RowAccess(pages, source.Wires.Count);
        try
        {
            for (var g = 0; g < model.RowReps.Length; g++)
            {
                if ((g & 1023) == 1023) token.ThrowIfCancellationRequested();
                set.CountRow();
                var builder = set.BeginRow();
                if (builder is null) break;
                var truncated = 0;
                var rep = model.RowReps[g];
                // A row group's key shows as its value: a cell that could not be read groups (and shows) as NULL.
                foreach (var column in spec.Rows) truncated += Copy(builder, access, source, column, rep, error: false);
                for (var c = 0; c < model.Stride; c++)
                {
                    var cell = g * model.Stride + c;
                    foreach (var figures in model.Figures) truncated += Figure(builder, access, source, figures, cell);
                }
                if (!set.TryCommitRow(truncated)) break;
            }
        }
        finally { set.Complete(); }
    }

    private static int Figure(PageBuilder builder, RowAccess access, ResultSetBuffer source, PivotFigures figures, int cell)
    {
        var value = figures.Value;
        switch (value.Aggregate)
        {
            case PivotAggregate.Count or PivotAggregate.CountDistinct:
                builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), figures.Counts[cell]));
                return 0;
            case PivotAggregate.Min or PivotAggregate.Max:
                if (figures.Best[cell] < 0) { builder.AppendNull(); return 0; }
                return Copy(builder, access, source, value.Column, figures.Best[cell]);
        }
        var count = figures.Counts[cell];
        if (count == 0) { builder.AppendNull(); return 0; }
        if (!figures.Exact)
        {
            var approximate = figures.Doubles[cell];
            builder.EndFormatted(CellFormat.WriteFloat(builder.BeginFormatted(), value.Aggregate == PivotAggregate.Avg ? approximate / count : approximate));
            return 0;
        }
        // An overflow (past decimal(38)'s digits) shows as a cell that could not be read, where SQL Server's SUM would fail.
        if (figures.Overflow[cell]) { builder.AppendNull(error: true); return 0; }
        var sum = figures.Sums[cell];
        var scale = figures.Scale;
        if (value.Aggregate == PivotAggregate.Avg)
        {
            var shown = Math.Max(scale, 6);
            if (Average(sum, count, scale, shown) is not { } average) { builder.AppendNull(error: true); return 0; }
            builder.EndFormatted(WriteScaled(builder.BeginFormatted(), average, shown));
            return 0;
        }
        // An integer sum is a bigint, as SQL Server's SUM of an integer: past its range it overflows as SQL Server's would.
        if (ResultPivoter.IsInteger(source.Columns[value.Column]) && (sum > long.MaxValue || sum < long.MinValue)) { builder.AppendNull(error: true); return 0; }
        builder.EndFormatted(WriteScaled(builder.BeginFormatted(), sum, scale));
        return 0;
    }

    /// <summary>A sum of <paramref name="count"/> values at <paramref name="scale"/> divided by the count at
    /// <paramref name="shown"/> decimals, rounded half away from zero; null past decimal(38)'s digits.</summary>
    internal static Int128? Average(Int128 sum, long count, int scale, int shown)
    {
        var scaled = (BigInteger)sum * BigInteger.Pow(10, shown - scale);
        var quotient = BigInteger.DivRem(BigInteger.Abs(scaled), count, out var remainder);
        if (remainder * 2 >= count) quotient++;
        if (scaled.Sign < 0) quotient = -quotient;
        if (BigInteger.Abs(quotient) >= (BigInteger)ResultPivoter.Decimal38) return null;
        return (Int128)quotient;
    }

    /// <summary>A whole number of 10^-<paramref name="scale"/> as decimal text with exactly that many decimals (250 at scale 2
    /// is "2.50"), as a decimal(38, s) shows.</summary>
    internal static int WriteScaled(Span<byte> destination, Int128 value, int scale)
    {
        var digits = Int128.Abs(value).ToString(CultureInfo.InvariantCulture).PadLeft(scale + 1, '0');
        var text = (value < 0 ? "-" : "") + (scale == 0 ? digits : digits[..^scale] + "." + digits[^scale..]);
        return Encoding.ASCII.GetBytes(text, destination);
    }

    /// <summary>Copies a source cell (flags, truncation and size included, the error flag only when <paramref name="error"/>);
    /// returns 1 for a truncated one.</summary>
    private static int Copy(PageBuilder builder, RowAccess access, ResultSetBuffer source, int column, int row, bool error = true)
    {
        if (row < 0) { builder.AppendNull(); return 0; }
        var view = access.At(row, out var at, out var lengths);
        if (view.IsNull(column, at)) { builder.AppendNull(error && view.IsError(column, at)); return 0; }
        var cut = view.IsTruncated(column, at);
        var span = view.Span(column, at);
        if (view.Wire(column) == WireKind.Binary) builder.AppendBinary(span, cut);
        else builder.AppendUtf8(span, cut);
        var rule = source.Lengths[column];
        CellSize size;
        if (lengths.TryCell(at, column, out var kept)) size = new CellSize(kept.Chars, kept.Bytes, kept.Exact && !rule.Estimated);
        else
        {
            size = rule.Derive(span, view.Wire(column));
            if (cut) size = size with { Exact = false };
        }
        builder.Measure(size.Chars, size.Bytes, keep: rule.Rule == LengthRule.Recorded, exact: size.Exact);
        return cut ? 1 : 0;
    }
}
