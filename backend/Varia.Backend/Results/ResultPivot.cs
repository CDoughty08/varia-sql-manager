using System.Globalization;
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

/// <summary>One value's figures, a slot per cell: counts, sums (exact as System.Decimal, which flags a sum past its 28
/// digits as an overflow; approximate as doubles) or the row holding a lowest or highest value.</summary>
internal sealed class PivotFigures(PivotValue value, int cells, bool exact)
{
    public PivotValue Value { get; } = value;
    public bool Exact { get; } = exact;
    public readonly long[] Counts = value.Aggregate is PivotAggregate.Min or PivotAggregate.Max ? [] : new long[cells];
    public readonly decimal[] Decimals = value.Aggregate is PivotAggregate.Sum or PivotAggregate.Avg && exact ? new decimal[cells] : [];
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
    public static PivotModel Build(ResultSetBuffer set, StoredPage[] pages, int[]? order, PivotSpec spec, CancellationToken token, Func<long, bool> reserve)
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
                keys[column] = key = ViewSorter.Build(set, source, new ViewKey(column, false, SortMode.Value), null, rows, token, ref approximate);
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

        var rowKeys = spec.Rows.Select(KeyOf).ToArray();
        var (groupOf, rowReps) = Group(rowKeys, positions, rows, scratch, token, all: true);
        int[] columnOf;
        List<int> columnReps;
        if (spec.Column >= 0) (columnOf, columnReps) = Group([KeyOf(spec.Column)], positions, rows, scratch, token, all: false);
        else (columnOf, columnReps) = ([], []);

        var columnGroups = columnReps.Count;
        Limit(spec, rowReps.Count, columnGroups);
        var stride = columnGroups + 1;
        var cells = rowReps.Count * stride;
        long bytes = 0;
        foreach (var value in spec.Values) bytes += PivotFigures.CellBytes(value.Aggregate) * cells;
        if (!reserve(bytes)) throw new PivotTooLargeException();

        var figures = spec.Values.Select(value => new PivotFigures(value, cells, value.Column >= 0 && ViewSorter.KindOf(set.Columns[value.Column], set.Wires[value.Column]) == ViewSorter.Kind.Exact)).ToArray();
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
                        var parsed = decimal.TryParse(span, NumberStyles.Float, CultureInfo.InvariantCulture, out var number);
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
        foreach (var item in figures)
            if (item.Value.Aggregate == PivotAggregate.CountDistinct) Distinct(item, KeyOf(item.Value.Column), positions, scratch, CellOf, token);

        return new PivotModel
        {
            Rows = positions.Length, RowGroups = rowReps.Count, RowReps = [.. rowReps], ColumnGroups = columnGroups, ColumnReps = [.. columnReps],
            Figures = figures, Approximate = approximate
        };
    }

    /// <summary>The most column groups a pivot of <paramref name="spec"/> can have: 256, fewer when the row-group columns,
    /// each column group's values and the totals would pass a page's 4,096 columns.</summary>
    public static int ColumnGroupLimit(PivotSpec spec) => Math.Min(MaxColumnGroups, (PageBuilder.MaxColumns - spec.Rows.Length) / spec.Values.Length - 1);

    /// <summary>Refuses a pivot past its bounds, saying which and how to bring it within them. The messages name no column
    /// or value (the renderer knows which fields it asked for).</summary>
    private static void Limit(PivotSpec spec, long rowGroups, long columnGroups)
    {
        var invariant = CultureInfo.InvariantCulture;
        var columnLimit = ColumnGroupLimit(spec);
        if (columnGroups > columnLimit)
            throw new RequestException("INVALID_PARAMS", string.Format(invariant,
                "The column group has {0:N0} distinct values, and a pivot can have at most {1:N0} column groups{2}. Choose a column with fewer values, or move it to Rows.",
                columnGroups, columnLimit, columnLimit < MaxColumnGroups ? string.Format(invariant, " with {0} values", spec.Values.Length) : ""));
        if (rowGroups > MaxRowGroups)
            throw new RequestException("INVALID_PARAMS", string.Format(invariant,
                "The row groups make {0:N0} rows, and a pivot can have at most {1:N0}. Group by fewer columns, or filter the rows first.", rowGroups, MaxRowGroups));
        var cells = rowGroups * (columnGroups + 1) * spec.Values.Length;
        if (cells > MaxCells)
            throw new RequestException("INVALID_PARAMS", string.Format(invariant,
                "This pivot would have {0:N0} figures, and a pivot can have at most {1:N0}. Use fewer values, row groups or column groups.", cells, MaxCells));
    }

    /// <summary>Each position's group by the keys' values (equal values, NULL equal to NULL, as GROUP BY), numbered in
    /// ascending order, and each group's first row. With no keys every position is one group, which exists even without rows
    /// when <paramref name="all"/> (a pivot without row groups has its one row, as an aggregate without GROUP BY does).</summary>
    private static (int[] Of, List<int> Reps) Group(ViewSorter.Key[] keys, int[] positions, int rows, int[] scratch, CancellationToken token, bool all)
    {
        var of = new int[rows];
        Array.Fill(of, -1);
        var reps = new List<int>();
        if (keys.Length == 0)
        {
            if (all) reps.Add(positions.Length > 0 ? positions.Min() : -1);
            foreach (var row in positions) of[row] = 0;
            return (of, reps);
        }
        positions.CopyTo(scratch, 0);
        var comparer = new ViewSorter.Comparer(keys, null, token);
        if (scratch.Length > 1) Array.Sort(scratch, comparer);
        for (var i = 0; i < scratch.Length; i++)
        {
            var row = scratch[i];
            if (i == 0 || comparer.Values(scratch[i - 1], row) != 0) reps.Add(row);
            of[row] = reps.Count - 1;
        }
        return (of, reps);
    }

    private static void Add(PivotFigures figures, int cell, bool parsed, decimal number)
    {
        if (cell < 0) return;
        figures.Counts[cell]++;
        if (!parsed) { figures.Overflow[cell] = true; return; }
        if (figures.Overflow[cell]) return;
        try { figures.Decimals[cell] += number; }
        catch (OverflowException) { figures.Overflow[cell] = true; }
    }

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

    /// <summary>COUNT(DISTINCT): the non-NULL rows sorted by cell then value, counting each run of equal values once, then
    /// again by row group alone for the totals.</summary>
    private static void Distinct(PivotFigures figures, ViewSorter.Key key, int[] positions, int[] scratch, CellFinder cellOf, CancellationToken token)
    {
        foreach (var totals in new[] { false, true })
        {
            var count = 0;
            foreach (var row in positions)
            {
                if (key.IsNull(row)) continue;
                var cell = cellOf(row, out var total);
                if ((totals ? total : cell) >= 0) scratch[count++] = row;
            }
            int Cell(int row)
            {
                var cell = cellOf(row, out var total);
                return totals ? total : cell;
            }
            var calls = 0;
            int Compare(int a, int b)
            {
                if (++calls == CancelEvery) { calls = 0; token.ThrowIfCancellationRequested(); }
                var compared = Cell(a).CompareTo(Cell(b));
                return compared != 0 ? compared : key.Compare(a, b);
            }
            if (count > 1) Array.Sort(scratch, 0, count, Comparer<int>.Create((a, b) => Compare(a, b) is var c && c != 0 ? c : a.CompareTo(b)));
            for (var i = 0; i < count; i++)
                if (i == 0 || Compare(scratch[i - 1], scratch[i]) != 0) figures.Counts[Cell(scratch[i])]++;
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
        var text = view.Wire(column) == WireKind.Binary ? "0x" + Convert.ToHexString(span[..Math.Min(span.Length, ResultPivoter.MaxLabelChars / 2)]) + (span.Length > ResultPivoter.MaxLabelChars / 2 ? "…" : "")
            : Encoding.UTF8.GetString(span);
        if (text.Trim().Length == 0) return "(blank)";
        var cut = CellFormat.Prefix(text, ResultPivoter.MaxLabelChars, out var truncated);
        return truncated || view.IsTruncated(column, at) ? cut.ToString() + "…" : text;
    }

    /// <summary>The scale of an exact numeric column's values (decimal(p,s)'s s; money's 4; integers' 0).</summary>
    private static int Scale(ResultColumn column) => ViewSorter.TypeName(column) switch
    {
        "money" or "smallmoney" => 4,
        "decimal" or "numeric" => column.Scale ?? 0,
        _ => 0
    };

    /// <summary>A value's column: its name and the type its figures have. Counts are bigint; sums keep an exact type's scale
    /// (as SQL Server's SUM, widened to 38 digits) and floats; averages of exact numerics keep at least 6 decimals; lowest and
    /// highest are the source column's own type, collation included.</summary>
    private static ResultColumn ValueColumn(ResultSetBuffer source, PivotValue value, string name)
    {
        if (value.Aggregate is PivotAggregate.Count or PivotAggregate.CountDistinct) return new ResultColumn(name, "bigint", "text", Nullable: false);
        var column = source.Columns[value.Column];
        if (value.Aggregate is PivotAggregate.Min or PivotAggregate.Max) return column with { Name = name, Nullable = true };
        if (ViewSorter.KindOf(column, source.Wires[value.Column]) != ViewSorter.Kind.Exact) return new ResultColumn(name, "float", "text", Precision: 53);
        var scale = Scale(column);
        if (value.Aggregate == PivotAggregate.Avg) scale = Math.Max(scale, 6);
        else if (scale == 0) return new ResultColumn(name, "bigint", "text");
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
        return (columns, wires, lengths);
    }

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
                foreach (var column in spec.Rows) truncated += Copy(builder, access, source, column, rep);
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
            var sum = figures.Doubles[cell];
            builder.EndFormatted(CellFormat.WriteFloat(builder.BeginFormatted(), value.Aggregate == PivotAggregate.Avg ? sum / count : sum));
            return 0;
        }
        // An overflow (past System.Decimal's 28 digits) shows as a cell that could not be read, as a failed conversion does.
        if (figures.Overflow[cell]) { builder.AppendNull(error: true); return 0; }
        var total = figures.Decimals[cell];
        var scale = Scale(source.Columns[value.Column]);
        decimal shown;
        try
        {
            shown = value.Aggregate == PivotAggregate.Avg ? Rescale(Math.Round(total / count, Math.Max(scale, 6), MidpointRounding.AwayFromZero), Math.Max(scale, 6)) : Rescale(total, scale);
        }
        catch (OverflowException) { builder.AppendNull(error: true); return 0; }
        // An integer sum is a bigint, as SQL Server's SUM of bigint: past its range it overflows as SQL Server's would.
        if (value.Aggregate == PivotAggregate.Sum && scale == 0 && (shown > long.MaxValue || shown < long.MinValue)) { builder.AppendNull(error: true); return 0; }
        builder.EndFormatted(CellFormat.WriteDecimal(builder.BeginFormatted(), shown));
        return 0;
    }

    /// <summary>A value with exactly <paramref name="scale"/> decimals (2.5 at scale 2 is 2.50), as a decimal(38, s) shows.</summary>
    internal static decimal Rescale(decimal value, int scale)
    {
        var rounded = Math.Round(value, Math.Min(scale, 28), MidpointRounding.AwayFromZero);
        // Adding a zero with the scale wanted widens a smaller scale; Round already cut a larger one.
        return scale <= 0 ? rounded : rounded + new decimal(0, 0, 0, false, (byte)Math.Min(scale, 28));
    }

    /// <summary>Copies a source cell (flags, truncation and size included); returns 1 for a truncated one.</summary>
    private static int Copy(PageBuilder builder, RowAccess access, ResultSetBuffer source, int column, int row)
    {
        if (row < 0) { builder.AppendNull(); return 0; }
        var view = access.At(row, out var at, out var lengths);
        if (view.IsNull(column, at)) { builder.AppendNull(view.IsError(column, at)); return 0; }
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
