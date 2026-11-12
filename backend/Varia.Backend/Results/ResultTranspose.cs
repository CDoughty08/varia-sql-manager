using System.Buffers;
using System.Globalization;
using System.Text;

namespace Varia.Backend.Results;

/// <summary>What a transpose takes: the source rows (base rows, in the order they become columns), how many rows it could
/// have taken (the view's or the selection's, before the column limit), the source columns that become rows (the shown
/// ones, in order), and the column whose values name the rows' columns (-1 for "Row 1", "Row 2"…). Positions[i] is the
/// view (or result) position <see cref="Numbers"/>[i] names.</summary>
internal sealed record TransposePlan(int[] Positions, int[] Numbers, long Available, int[] Columns, int HeaderColumn)
{
    public bool Truncated => Positions.Length < Available;
}

/// <summary>Transposes a stored result (results.transpose): its shown columns become rows and its rows (a view's, in its
/// order and with its filters, or only the selected ranges) become columns, as a new stored result (kind "transpose").
/// Rows become columns, so at most <see cref="MaxRows"/> of them (a page's columns less the "Column" column), and fewer when
/// the cells would pass <see cref="MaxCells"/>: past either it takes the first ones and says so (explicit truncation).
/// Every output cell is the source cell's display text as stored, with its NULL, error and truncation flags kept; the
/// output's columns are text (nvarchar), since one column now holds every source column's type.</summary>
internal static class ResultTransposer
{
    public const int MaxRows = ResultTextWriter.MaxTransposedRows, MaxRanges = 256, MaxCells = 4_000_000;
    /// <summary>The first column's name: it holds the source columns' names.</summary>
    public const string FirstColumn = "Column";
    private const int CancelEvery = 1 << 12;

    /// <summary>The rows a transpose takes: every row (the view's, through its order, or the sealed ones), or only
    /// <paramref name="ranges"/>' positions, merged as a filter's selection is; at most <see cref="MaxRows"/>, and at most
    /// <see cref="MaxCells"/> cells.</summary>
    public static TransposePlan Plan(ResultSetBuffer set, StoredPage[] pages, int[]? order, IReadOnlyList<(long First, long Count)>? ranges, int headerColumn)
    {
        long sealedRows = 0;
        foreach (var page in pages) sealedRows += page.Rows;
        if (sealedRows > Array.MaxLength) throw new RequestException("TOO_LARGE", "This result has too many rows to transpose.");
        var length = order?.Length ?? (int)sealedRows;
        var columns = Enumerable.Range(0, set.Columns.Count).Where(column => !ResultTextWriter.Hidden(set.Columns[column])).ToArray();
        var limit = Math.Min(MaxRows, MaxCells / Math.Max(1, columns.Length));
        var spans = ranges is null ? [(0, length)] : ViewSorter.Merge(ranges, length);
        long available = 0;
        foreach (var (first, end) in spans) available += end - first;
        var taken = (int)Math.Min(available, limit);
        var positions = new int[taken];
        var numbers = new int[taken];
        var count = 0;
        foreach (var (first, end) in spans)
        {
            for (var position = first; position < end && count < taken; position++)
            {
                var row = order is null ? position : order[position];
                if (row >= sealedRows) continue;
                numbers[count] = position;
                positions[count++] = row;
            }
        }
        if (count < taken)
        {
            Array.Resize(ref positions, count);
            Array.Resize(ref numbers, count);
        }
        return new TransposePlan(positions, numbers, available, columns, headerColumn);
    }

    /// <summary>The transpose's columns: "Column", then one per row taken, named by its position ("Row 1") or by the header
    /// column's value (as a pivot names its column groups: "NULL", "(blank)", binary as 0x hex), all made distinct.</summary>
    public static (IReadOnlyList<ResultColumn> Columns, IReadOnlyList<WireKind> Wires, IReadOnlyList<ColumnLength> Lengths) Shape(ResultSetBuffer source, StoredPage[] pages, TransposePlan plan)
    {
        var columns = new List<ResultColumn>(plan.Positions.Length + 1) { new(FirstColumn, "nvarchar(128)", "text", Nullable: false) };
        var access = new RowAccess(pages, source.Wires.Count);
        for (var i = 0; i < plan.Positions.Length; i++)
        {
            var name = plan.HeaderColumn >= 0 ? PivotOutput.GroupName(source, access, plan.HeaderColumn, plan.Positions[i])
                : "Row " + (plan.Numbers[i] + 1L).ToString(CultureInfo.InvariantCulture);
            columns.Add(new ResultColumn(name, "nvarchar(max)", "text"));
        }
        // "Column" keeps its name; the rows' columns are numbered " (2)", " (3)" in order when they repeat.
        ColumnNames.Unique(columns);
        return (columns, [.. columns.Select(_ => WireKind.Text)], [.. columns.Select(_ => ColumnLength.Utf16)]);
    }

    /// <summary>Writes a row per source column into <paramref name="set"/> (opened with <see cref="Shape"/>), then completes
    /// it.</summary>
    public static void Write(ResultSetBuffer set, ResultSetBuffer source, StoredPage[] pages, TransposePlan plan, CancellationToken token)
    {
        var access = new RowAccess(pages, source.Wires.Count);
        // Every source column reads every row taken: find each row's page once, not once a cell.
        var pageOf = new int[plan.Positions.Length];
        var indexOf = new int[plan.Positions.Length];
        for (var i = 0; i < pageOf.Length; i++) pageOf[i] = access.PageOf(plan.Positions[i], out indexOf[i]);
        var hex = Array.Empty<char>();
        var counter = 0;
        try
        {
            foreach (var column in plan.Columns)
            {
                token.ThrowIfCancellationRequested();
                set.CountRow();
                var builder = set.BeginRow();
                if (builder is null) break;
                builder.AppendText(source.Columns[column].Name);
                builder.Measure(source.Columns[column].Name.Length, 2L * source.Columns[column].Name.Length);
                var truncated = 0;
                for (var i = 0; i < pageOf.Length; i++)
                {
                    if ((++counter & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                    var view = access.Page(pageOf[i], out var lengths);
                    truncated += Cell(builder, view, lengths, column, indexOf[i], ref hex);
                }
                if (!set.TryCommitRow(truncated)) break;
            }
        }
        finally
        {
            set.Complete();
            if (hex.Length > 0) ArrayPool<char>.Shared.Return(hex);
        }
    }

    /// <summary>Copies a source cell as text (binary as 0x hex, as the grid shows it), its NULL, error and truncation flags
    /// kept, with its full length when it was stored truncated; returns 1 for a cell stored truncated: cut in the source, or
    /// cut here by the output row's 8 MiB limit.</summary>
    private static int Cell(PageBuilder builder, PageView view, PageLengths lengths, int column, int at, ref char[] hex)
    {
        if (view.IsNull(column, at)) { builder.AppendNull(view.IsError(column, at)); return 0; }
        var cut = view.IsTruncated(column, at);
        var span = view.Span(column, at);
        var kept = lengths.TryCell(at, column, out var entry) ? entry : (CellLength?)null;
        long chars;
        var exact = true;
        if (view.Wire(column) == WireKind.Binary)
        {
            // Only as many bytes as a row can hold as hex: the rest could never be stored, and is said by the truncation.
            var bytes = Math.Min(span.Length, PageBuilder.MaxRowBytes / 2);
            var need = 2 + 2 * bytes;
            if (hex.Length < need)
            {
                if (hex.Length > 0) ArrayPool<char>.Shared.Return(hex);
                hex = ArrayPool<char>.Shared.Rent(need);
            }
            hex[0] = '0';
            hex[1] = 'x';
            Convert.TryToHexString(span[..bytes], hex.AsSpan(2), out var written);
            builder.AppendText(hex.AsSpan(0, 2 + written), cut || bytes < span.Length);
            // A binary value shows as 0x and two hex digits a byte: its full bytes, when kept, give its full text's length.
            chars = 2 + 2L * (kept?.Bytes ?? span.Length);
            if (cut && kept is null) exact = false;
        }
        else
        {
            builder.AppendUtf8(span, cut);
            chars = kept?.Chars ?? Encoding.UTF8.GetCharCount(span);
            if (cut && kept is null) exact = false;
            else if (kept is { Exact: false }) exact = false;
        }
        // The builder's flag, not the source's: a cell the output row's limit cut is truncated too, and counts.
        var stored = builder.LastTruncated;
        // The output is nvarchar: two bytes a character, as DATALENGTH counts it.
        builder.Measure(chars, 2 * chars, exact: exact);
        return stored ? 1 : 0;
    }
}
