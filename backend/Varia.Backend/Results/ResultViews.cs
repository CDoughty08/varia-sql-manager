using System.Buffers.Binary;
using System.Globalization;
using System.Text;

namespace Varia.Backend.Results;

/// <summary>How a sort key compares a column: its values (by SQL type and collation), or, for text and binary columns, each
/// cell's characters or bytes (DATALENGTH; CellLengths.cs).</summary>
internal enum SortMode { Value, Chars, Bytes }

internal sealed record ViewKey(int Column, bool Descending, SortMode Mode);

/// <summary>How a view filter keeps rows: a column's value among some values (In) or not (NotIn), between two values, or
/// rows whose values in some columns repeat (Duplicates).</summary>
internal enum FilterOp { In, NotIn, Between, Duplicates }

/// <summary>Cells a filter takes its values from: positions in a view's order (or the result's own when Order is null).</summary>
internal sealed record ViewCells(int[]? Order, (long First, long Count)[] Ranges);

/// <summary>One results.view filter. In, NotIn and Between compare Column's values with those of base rows (Rows: one row per
/// distinct value; Between's lowest and highest), or of the cells a selection named (Cells), which building the view
/// resolves to rows; Nulls says NULL is among In's and NotIn's values. Duplicates compares Columns. Equality and order are
/// the sort's (<see cref="ViewSorter"/>): a column's collation decides which texts are equal.</summary>
internal sealed record ViewFilter(FilterOp Op, int Column, int[]? Rows, bool Nulls, ViewCells? Cells, int[] Columns);

/// <summary>A view of one stored result: its rows in another order (and, later, only some of them), as base row numbers.
/// Reads through it build pages in view order from the stored ones (<see cref="ViewPages"/>), so the renderer caches and
/// draws them as it does a result's own. It covers the rows sealed when it was built; a view of a set still loading is
/// built again by the renderer once more rows arrive. Its order array is charged to the result's query budget and
/// returned when the view is closed, replaced, or its result is released.</summary>
internal sealed class ResultView(uint viewId, ResultSetBuffer set, int[] order, IReadOnlyList<ViewKey> keys, bool approximate, bool complete, long charged)
{
    public uint ViewId { get; } = viewId;
    public ResultSetBuffer Set { get; } = set;
    /// <summary>The base row shown at each view position.</summary>
    public int[] Order { get; } = order;
    public IReadOnlyList<ViewKey> Keys { get; } = keys;
    /// <summary>A key compared a truncated value's stored prefix, or a length that is only an estimate.</summary>
    public bool Approximate { get; } = approximate;
    /// <summary>The result had finished loading when the view was built: it covers every row.</summary>
    public bool Complete { get; } = complete;
    internal long Charged { get; } = charged;
    public long Rows => Order.Length;
}

/// <summary>Builds a view's order: a stable sort of the result's sealed rows by up to <see cref="MaxKeys"/> keys, as SQL
/// Server's ORDER BY would put them. NULL (and a cell that could not be read) sorts lowest: first ascending, last
/// descending. Exact numerics compare as numbers at any precision; real and float as doubles; uniqueidentifier in SQL
/// Server's byte order; datetimeoffset by its UTC instant; the other date and time types by their fixed-width display text;
/// binary values byte by byte; character columns by their collation (its locale and Ignore flags, or code-point order for
/// _BIN and _BIN2), ignoring trailing spaces as SQL Server does; every other type by its display text's code points.
/// Each row keeps 8 to 16 bytes per key while sorting (a number, or a prefix of its collation sort key), so most
/// comparisons never touch the stored cell; ties read it again from its page.</summary>
internal static class ViewSorter
{
    public const int MaxKeys = 16;
    /// <summary>Filters one view takes, distinct values one In or NotIn filter holds, and cell ranges one selection names
    /// (src/shared/ipc/wire/protocol.ts limits.views).</summary>
    public const int MaxFilters = 16, MaxFilterValues = 4096, MaxFilterRanges = 256;
    /// <summary>Bytes a row one filter holds at most while it runs, besides its column's key: Duplicates' positions (4), group
    /// starts (up to 8, as their list grows) and the rows it keeps (4); Keep and Pick hold less.</summary>
    public const int FilterBytes = 16;
    private const int CancelEvery = 1 << 14;

    /// <summary>Bytes a sort holds per row and key while it runs: the key's 8- or 16-byte value and a NULL bit.</summary>
    public static long WorkingBytes(long rows, int keys) => rows * (16L * keys + 4) + rows / 8 * keys;

    public static (int[] Order, bool Approximate) Sort(ResultSetBuffer set, StoredPage[] pages, IReadOnlyList<ViewKey> keys, CancellationToken token)
    {
        var built = Build(set, pages, keys, [], token);
        return (built.Order, built.Approximate);
    }

    /// <summary>Keys a view holds while it is built: one per column its filters compare and one per sort key, except that a
    /// Value sort key on a filtered column is that filter's key.</summary>
    public static int KeyCount(IReadOnlyList<ViewKey> keys, IReadOnlyList<ViewFilter> filters)
    {
        var columns = new HashSet<int>();
        foreach (var filter in filters)
        {
            if (filter.Op == FilterOp.Duplicates) columns.UnionWith(filter.Columns);
            else columns.Add(filter.Column);
        }
        var count = columns.Count;
        foreach (var key in keys)
            if (key.Mode != SortMode.Value || !columns.Contains(key.Column)) count++;
        return count;
    }

    /// <summary>A view's order: the sealed rows its filters keep, in turn (each over the rows the ones before it kept), then
    /// sorted by its keys. Without keys, rows keep the result's order, except that Duplicates puts each group of equal rows
    /// together, in the order of their first rows. Returns the filters with their cells resolved to rows.</summary>
    public static (int[] Order, bool Approximate, ViewFilter[] Filters) Build(ResultSetBuffer set, StoredPage[] pages, IReadOnlyList<ViewKey> keys, IReadOnlyList<ViewFilter> filters, CancellationToken token)
    {
        long total = 0;
        foreach (var page in pages) total += page.Rows;
        if (total > Array.MaxLength) throw new RequestException("TOO_LARGE", "This result has too many rows to sort.");
        var rows = (int)total;
        var source = new PageSource(pages, set.Wires.Count);
        var approximate = false;
        var values = new Dictionary<int, Key>();
        Key ValueKey(int column)
        {
            if (!values.TryGetValue(column, out var key))
                values[column] = key = Build(set, source, new ViewKey(column, false, SortMode.Value), null, rows, token, ref approximate);
            return key;
        }
        var order = new int[rows];
        for (var i = 0; i < rows; i++) order[i] = i;
        var resolved = new ViewFilter[filters.Count];
        for (var f = 0; f < filters.Count; f++)
        {
            var filter = filters[f];
            if (filter.Op == FilterOp.Duplicates)
            {
                var columns = new Key[filter.Columns.Length];
                for (var c = 0; c < columns.Length; c++) columns[c] = ValueKey(filter.Columns[c]);
                order = Duplicates(order, columns, token);
                resolved[f] = filter;
                continue;
            }
            var key = ValueKey(filter.Column);
            var (reps, nulls) = filter.Cells is { } cells ? Pick(key, cells, rows, token) : Distinct(key, filter.Rows!, rows, token);
            nulls |= filter.Nulls;
            if (filter.Op == FilterOp.Between)
            {
                if (filter.Rows is not null && (filter.Nulls || nulls || filter.Rows.Length != 2))
                    throw new RequestException("INVALID_PARAMS", "Between takes two rows with distinct values, not NULL.");
                if (reps.Length == 0) throw new RequestException("INVALID_PARAMS", "Select at least one value that is not NULL to filter between.");
                reps = [reps[0], reps[^1]];
                nulls = false;
            }
            else if (reps.Length > MaxFilterValues)
                throw new RequestException("TOO_LARGE", "Select at most 4,096 different values to filter by.");
            else if (reps.Length == 0 && !nulls) throw new RequestException("INVALID_PARAMS", "A filter needs at least one value.");
            order = Keep(order, key, filter.Op, reps, nulls, token);
            resolved[f] = filter with { Rows = reps, Nulls = nulls, Cells = null };
        }
        if (keys.Count == 0 || order.Length <= 1) return (order, approximate, resolved);
        // Sort keys are built after the filters, over only the rows they kept (indexed by their place in kept, which is in
        // base row order, so ties still keep base row order); a Value key on a filtered column is the filter's own key. The
        // sorted positions (4 bytes a kept row) fit in the FilterBytes a row the filters reserved and no longer use.
        int[]? kept = null;
        if (order.Length < rows)
        {
            kept = order;
            Array.Sort(kept);
        }
        var built = new Key[keys.Count];
        var descending = new bool[keys.Count];
        for (var k = 0; k < keys.Count; k++)
        {
            descending[k] = keys[k].Descending;
            if (keys[k].Mode == SortMode.Value && values.TryGetValue(keys[k].Column, out var shared)) built[k] = kept is null ? shared : new MappedKey(shared, kept);
        }
        // Filter keys no sort key shares are done with: let them go before the sort keys are built.
        values.Clear();
        for (var k = 0; k < keys.Count; k++)
            built[k] ??= Build(set, source, keys[k], kept, rows, token, ref approximate);
        var comparer = new Comparer(built, descending, token);
        if (kept is null)
        {
            Array.Sort(order, comparer);
            return (order, approximate, resolved);
        }
        var sorted = new int[kept.Length];
        for (var i = 0; i < sorted.Length; i++) sorted[i] = i;
        Array.Sort(sorted, comparer);
        for (var i = 0; i < sorted.Length; i++) sorted[i] = kept[sorted[i]];
        return (sorted, approximate, resolved);
    }

    /// <summary>The base rows the cells name, one per distinct non-NULL value in ascending order, and whether one is NULL.</summary>
    private static (int[] Rows, bool Nulls) Pick(Key key, ViewCells cells, int rows, CancellationToken token)
    {
        // Overlapping ranges are merged first, so the cells read are at most the positions there are.
        var spans = Merge(cells.Ranges, cells.Order?.Length ?? rows);
        long total = 0;
        foreach (var (first, end) in spans) total += end - first;
        var picked = new int[total];
        var count = 0;
        var nulls = false;
        foreach (var (first, end) in spans)
        {
            for (var position = first; position < end; position++)
            {
                if ((position & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
                var row = cells.Order is { } order ? order[position] : position;
                if (row >= rows) continue;
                if (key.IsNull(row)) nulls = true;
                else picked[count++] = row;
            }
        }
        return (Unique(key, picked, count, token), nulls);
    }

    /// <summary>[first, count] ranges as sorted, disjoint [first, end) spans of the positions below <paramref name="length"/>.</summary>
    internal static List<(int First, int End)> Merge(IReadOnlyList<(long First, long Count)> ranges, int length)
    {
        var spans = new List<(int First, int End)>(ranges.Count);
        foreach (var (first, count) in ranges)
        {
            var end = Math.Min(length, first + count);
            if (first < end) spans.Add(((int)first, (int)end));
        }
        spans.Sort((a, b) => a.First.CompareTo(b.First));
        var merged = new List<(int First, int End)>(spans.Count);
        foreach (var span in spans)
        {
            if (merged.Count > 0 && span.First <= merged[^1].End) merged[^1] = (merged[^1].First, Math.Max(merged[^1].End, span.End));
            else merged.Add(span);
        }
        return merged;
    }

    /// <summary>Rows a request named, checked and reduced to one per distinct value in ascending order.</summary>
    private static (int[] Rows, bool Nulls) Distinct(Key key, int[] named, int rows, CancellationToken token)
    {
        var picked = new int[named.Length];
        var count = 0;
        var nulls = false;
        foreach (var row in named)
        {
            if (row < 0 || row >= rows) throw new RequestException("INVALID_PARAMS", "A filter's rows must be rows of the result.");
            if (key.IsNull(row)) nulls = true;
            else picked[count++] = row;
        }
        return (Unique(key, picked, count, token), nulls);
    }

    /// <summary>The first <paramref name="count"/> rows, sorted and reduced in place to one per distinct value.</summary>
    private static int[] Unique(Key key, int[] rows, int count, CancellationToken token)
    {
        if (count > 1) Array.Sort(rows, 0, count, new Comparer([key], null, token));
        var unique = 0;
        for (var i = 0; i < count; i++)
            if (unique == 0 || key.Compare(rows[unique - 1], rows[i]) != 0) rows[unique++] = rows[i];
        Array.Resize(ref rows, unique);
        return rows;
    }

    private static int[] Keep(int[] order, Key key, FilterOp op, int[] reps, bool nulls, CancellationToken token)
    {
        var kept = new int[order.Length];
        var count = 0;
        for (var i = 0; i < order.Length; i++)
        {
            if ((i & (CancelEvery - 1)) == 0) token.ThrowIfCancellationRequested();
            var row = order[i];
            bool keep;
            if (key.IsNull(row)) keep = op == FilterOp.In ? nulls : op == FilterOp.NotIn && !nulls;
            else if (op == FilterOp.Between) keep = key.Compare(row, reps[0]) >= 0 && key.Compare(row, reps[1]) <= 0;
            else keep = Contains(key, reps, row) == (op == FilterOp.In);
            if (keep) kept[count++] = row;
        }
        Array.Resize(ref kept, count);
        return kept;
    }

    private static bool Contains(Key key, int[] reps, int row)
    {
        int low = 0, high = reps.Length - 1;
        while (low <= high)
        {
            var mid = (low + high) >>> 1;
            var compared = key.Compare(reps[mid], row);
            if (compared == 0) return true;
            if (compared < 0) low = mid + 1;
            else high = mid - 1;
        }
        return false;
    }

    /// <summary>The rows whose values in the columns equal another row's (NULL equal to NULL, as GROUP BY has it), each
    /// group together in the order of its first row and its rows in their order.</summary>
    private static int[] Duplicates(int[] order, Key[] columns, CancellationToken token)
    {
        var positions = new int[order.Length];
        for (var i = 0; i < positions.Length; i++) positions[i] = i;
        var equal = new Comparer(columns, null, token);
        int Same(int a, int b) => equal.Values(order[a], order[b]);
        if (positions.Length > 1) Array.Sort(positions, Comparer<int>.Create((a, b) => Same(a, b) is var c && c != 0 ? c : a.CompareTo(b)));
        // Each group is a run of positions whose first is its first row's (ties keep their order); a run's start names it.
        var starts = new List<int>();
        var total = 0;
        for (var start = 0; start < positions.Length;)
        {
            var end = start + 1;
            while (end < positions.Length && Same(positions[start], positions[end]) == 0) end++;
            if (end - start > 1)
            {
                starts.Add(start);
                total += end - start;
            }
            start = end;
        }
        starts.Sort((a, b) => positions[a].CompareTo(positions[b]));
        var kept = new int[total];
        var count = 0;
        foreach (var start in starts)
        {
            var first = positions[start];
            for (var i = start; i < positions.Length && (i == start || Same(first, positions[i]) == 0); i++) kept[count++] = order[positions[i]];
        }
        return kept;
    }

    /// <summary>A key over every row (indexed by base row), or over only <paramref name="kept"/>'s rows, in ascending base
    /// row order (indexed by their place in it). Its direction is the comparer's: keys compare ascending.</summary>
    private static Key Build(ResultSetBuffer set, PageSource source, ViewKey sort, int[]? kept, int rows, CancellationToken token, ref bool approximate)
    {
        var column = sort.Column;
        var meta = set.Columns[column];
        var wire = set.Wires[column];
        // Chars orders character, xml and json columns by length; Bytes those and binary ones (DATALENGTH). Others sort by value.
        var byLength = sort.Mode == SortMode.Chars ? IsText(meta) : sort.Mode == SortMode.Bytes && (wire == WireKind.Binary || IsText(meta));
        var kind = byLength ? KindFor(sort.Mode) : KindOf(meta, wire);
        var capacity = kept?.Length ?? rows;
        Key key = kind switch
        {
            Kind.Chars or Kind.Bytes => new LengthKey(capacity),
            Kind.Exact => new NumberKey(capacity, kept, source, column, exact: true),
            Kind.Approximate => new NumberKey(capacity, kept, source, column, exact: false),
            Kind.Ticks => new TicksKey(capacity),
            Kind.Guid => new GuidKey(capacity),
            Kind.Collated when Culture(meta.Collation) is { } culture => new CollatedKey(capacity, kept, source, column, culture.Info, culture.Options),
            _ => new OrdinalKey(capacity, kept, source, column, trim: meta.Collation is not null)
        };
        var lengths = set.Lengths[column];
        var next = 0;
        foreach (var (index, page) in source.Pages())
        {
            token.ThrowIfCancellationRequested();
            var first = (int)page.FirstRow;
            var end = first + page.Rows;
            int start, stop;
            if (kept is null) (start, stop) = (first, end);
            else
            {
                start = next;
                while (next < kept.Length && kept[next] < end) next++;
                stop = next;
                if (start == stop) continue;
            }
            var view = source.View(index);
            for (var row = start; row < stop; row++)
            {
                var r = (kept is null ? row : kept[row]) - first;
                if (view.IsNull(column, r)) { key.SetNull(row); continue; }
                var span = view.Span(column, r);
                var truncated = view.IsTruncated(column, r);
                if (kind is Kind.Chars or Kind.Bytes)
                {
                    CellSize size;
                    if (page.Lengths.TryCell(r, column, out var cell)) size = new CellSize(cell.Chars, cell.Bytes, cell.Exact && !lengths.Estimated);
                    else
                    {
                        size = lengths.Derive(span, wire);
                        if (truncated || lengths.Rule == LengthRule.Recorded) size = size with { Exact = false };
                    }
                    if (!size.Exact) approximate = true;
                    ((LengthKey)key).Values[row] = kind == Kind.Chars ? size.Chars : size.Bytes;
                    continue;
                }
                if (truncated) approximate = true;
                key.Set(row, span);
            }
        }
        return key;
    }

    internal enum Kind { Exact, Approximate, Ticks, Guid, Collated, Ordinal, Chars, Bytes }

    private static Kind KindFor(SortMode mode) => mode == SortMode.Chars ? Kind.Chars : Kind.Bytes;

    /// <summary>A column's type name without its size or precision ("decimal(18,2)" is decimal), in lower case.</summary>
    internal static string TypeName(ResultColumn column)
    {
        var type = column.DataType;
        var cut = type.IndexOf('(');
        return (cut < 0 ? type : type[..cut]).Trim().ToLowerInvariant();
    }

    /// <summary>A column whose lengths a Chars or Bytes key may sort by: character types, xml and json.</summary>
    internal static bool IsText(ResultColumn column) => column.Collation is not null || column.Role is "xml" or "json"
        || TypeName(column) is "char" or "varchar" or "nchar" or "nvarchar" or "text" or "ntext" or "sysname" or "xml" or "json";

    internal static Kind KindOf(ResultColumn column, WireKind wire)
    {
        if (wire == WireKind.Binary) return Kind.Ordinal;
        return TypeName(column) switch
        {
            "bit" or "tinyint" or "smallint" or "int" or "bigint" or "decimal" or "numeric" or "money" or "smallmoney" => Kind.Exact,
            "real" or "float" => Kind.Approximate,
            "datetimeoffset" => Kind.Ticks,
            "uniqueidentifier" => Kind.Guid,
            "char" or "varchar" or "nchar" or "nvarchar" or "text" or "ntext" or "sysname" when column.Collation is not null => Kind.Collated,
            _ => Kind.Ordinal
        };
    }

    /// <summary>The comparison a collation implies, or null for code-point order (_BIN, _BIN2, or a locale this runtime does
    /// not know).</summary>
    internal static (CompareInfo Info, CompareOptions Options)? Culture(ResultCollation? collation)
    {
        // SqlCompareOptions: BinarySort2 16384, BinarySort 32768.
        if (collation is null || (collation.Options & (16384 | 32768)) != 0) return null;
        CompareInfo info;
        try { info = CultureInfo.GetCultureInfo(collation.Lcid).CompareInfo; }
        catch (CultureNotFoundException) { return null; }
        var options = CompareOptions.None;
        if ((collation.Options & 1) != 0) options |= CompareOptions.IgnoreCase;
        if ((collation.Options & 2) != 0) options |= CompareOptions.IgnoreNonSpace;
        if ((collation.Options & 8) != 0) options |= CompareOptions.IgnoreKanaType;
        if ((collation.Options & 16) != 0) options |= CompareOptions.IgnoreWidth;
        return (info, options);
    }

    /// <summary>A UTF-8 cell without its trailing spaces (U+0020), which SQL Server's comparisons ignore.</summary>
    internal static ReadOnlySpan<byte> TrimEnd(ReadOnlySpan<byte> utf8)
    {
        var end = utf8.Length;
        while (end > 0 && utf8[end - 1] == (byte)' ') end--;
        return utf8[..end];
    }

    /// <summary>Compares exact numeric display text (an optional '-', digits, an optional '.' and digits) at any precision,
    /// as decimal(38) values exceed both double and System.Decimal.</summary>
    internal static int CompareNumericText(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b)
    {
        var negativeA = a.Length > 0 && a[0] == (byte)'-';
        var negativeB = b.Length > 0 && b[0] == (byte)'-';
        if (negativeA) a = a[1..];
        if (negativeB) b = b[1..];
        if (IsZero(a)) negativeA = false;
        if (IsZero(b)) negativeB = false;
        if (negativeA != negativeB) return negativeA ? -1 : 1;
        var magnitude = CompareMagnitude(a, b);
        return negativeA ? -magnitude : magnitude;
    }

    private static bool IsZero(ReadOnlySpan<byte> digits)
    {
        foreach (var c in digits) if (c is >= (byte)'1' and <= (byte)'9') return false;
        return true;
    }

    private static int CompareMagnitude(ReadOnlySpan<byte> a, ReadOnlySpan<byte> b)
    {
        var pointA = a.IndexOf((byte)'.');
        var pointB = b.IndexOf((byte)'.');
        var intA = (pointA < 0 ? a : a[..pointA]).TrimStart((byte)'0');
        var intB = (pointB < 0 ? b : b[..pointB]).TrimStart((byte)'0');
        if (intA.Length != intB.Length) return intA.Length < intB.Length ? -1 : 1;
        var compared = intA.SequenceCompareTo(intB);
        if (compared != 0) return Math.Sign(compared);
        var fracA = (pointA < 0 ? [] : a[(pointA + 1)..]).TrimEnd((byte)'0');
        var fracB = (pointB < 0 ? [] : b[(pointB + 1)..]).TrimEnd((byte)'0');
        return Math.Sign(fracA.SequenceCompareTo(fracB));
    }

    /// <summary>The first 8 bytes of a span, big-endian, so that comparing two prefixes as numbers orders them as their spans
    /// would (a shorter span pads with zeros, so equal prefixes still need the spans themselves).</summary>
    internal static ulong Prefix(ReadOnlySpan<byte> bytes)
    {
        Span<byte> eight = stackalloc byte[8];
        eight.Clear();
        bytes[..Math.Min(8, bytes.Length)].CopyTo(eight);
        return BinaryPrimitives.ReadUInt64BigEndian(eight);
    }

    /// <summary>The 16 bytes of a uniqueidentifier in the order SQL Server compares them: bytes 10–15, 8–9, 6–7, 4–5, then
    /// 0–3 of its storage (Guid.TryWriteBytes's order), most significant first.</summary>
    internal static (ulong High, ulong Low) GuidOrder(Guid value)
    {
        Span<byte> stored = stackalloc byte[16];
        value.TryWriteBytes(stored);
        Span<byte> ordered = stackalloc byte[16];
        stored[10..16].CopyTo(ordered);
        stored[8..10].CopyTo(ordered[6..]);
        stored[6..8].CopyTo(ordered[8..]);
        stored[4..6].CopyTo(ordered[10..]);
        stored[0..4].CopyTo(ordered[12..]);
        return (BinaryPrimitives.ReadUInt64BigEndian(ordered), BinaryPrimitives.ReadUInt64BigEndian(ordered[8..]));
    }

    /// <summary>The sealed pages a sort reads, each parsed once, and a row's cell found again by binary search.</summary>
    private sealed class PageSource
    {
        private readonly StoredPage[] pages;
        private readonly long[] starts;
        private readonly int[][] layouts;
        private readonly int[] blobStarts;
        private readonly int columns;

        public PageSource(StoredPage[] pages, int columns)
        {
            this.pages = pages;
            this.columns = columns;
            starts = new long[pages.Length];
            layouts = new int[pages.Length][];
            blobStarts = new int[pages.Length];
            for (var i = 0; i < pages.Length; i++)
            {
                starts[i] = pages[i].FirstRow;
                var view = PageView.Parse(pages[i].Body, columns);
                layouts[i] = view.Layout;
                blobStarts[i] = view.BlobStart;
            }
        }

        public IEnumerable<(int Index, StoredPage Page)> Pages()
        {
            for (var i = 0; i < pages.Length; i++) yield return (i, pages[i]);
        }

        public PageView View(int index) => PageView.At(pages[index].Body, blobStarts[index], layouts[index], pages[index].FirstRow, pages[index].Rows, columns);

        /// <summary>Row <paramref name="row"/>'s stored bytes in a column (empty for NULL).</summary>
        public ReadOnlySpan<byte> Cell(int row, int column)
        {
            var index = Array.BinarySearch(starts, (long)row);
            if (index < 0) index = ~index - 1;
            return View(index).Span(column, (int)(row - starts[index]));
        }
    }

    /// <summary>A column's values in ascending order, indexed by base row or, built over some rows (<c>map</c>), by their
    /// place in that list; <see cref="Comparer"/> applies a sort key's direction.</summary>
    private abstract class Key(int rows, int[]? map = null)
    {
        private readonly byte[] nulls = new byte[(rows + 7) / 8];
        public void SetNull(int row) => nulls[row >> 3] |= (byte)(1 << (row & 7));
        public virtual bool IsNull(int row) => (nulls[row >> 3] & (1 << (row & 7))) != 0;
        /// <summary>The base row at an index, where a comparison reads the stored cell again.</summary>
        protected int Row(int index) => map is null ? index : map[index];
        public abstract void Set(int row, ReadOnlySpan<byte> cell);
        /// <summary>Two non-NULL rows, ascending.</summary>
        public abstract int Compare(int a, int b);
    }

    private sealed class LengthKey(int rows) : Key(rows)
    {
        public readonly long[] Values = new long[rows];
        public override void Set(int row, ReadOnlySpan<byte> cell) { }
        public override int Compare(int a, int b) => Values[a].CompareTo(Values[b]);
    }

    /// <summary>A number's double; for exact numerics, equal doubles (rounding is monotonic, so unequal ones already order
    /// the values) compare their text exactly.</summary>
    private sealed class NumberKey(int rows, int[]? map, PageSource source, int column, bool exact) : Key(rows, map)
    {
        private readonly double[] values = new double[rows];
        public override void Set(int row, ReadOnlySpan<byte> cell) =>
            values[row] = double.TryParse(cell, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : double.NaN;
        public override int Compare(int a, int b)
        {
            var compared = values[a].CompareTo(values[b]);
            if (compared != 0 || !exact) return compared;
            return CompareNumericText(source.Cell(Row(a), column), source.Cell(Row(b), column));
        }
    }

    private sealed class TicksKey(int rows) : Key(rows)
    {
        private readonly long[] values = new long[rows];
        public override void Set(int row, ReadOnlySpan<byte> cell)
        {
            Span<char> chars = stackalloc char[64];
            var length = Encoding.UTF8.GetChars(cell[..Math.Min(cell.Length, 64)], chars);
            values[row] = DateTimeOffset.TryParse(chars[..length], CultureInfo.InvariantCulture, DateTimeStyles.None, out var value) ? value.UtcTicks : long.MinValue;
        }
        public override int Compare(int a, int b) => values[a].CompareTo(values[b]);
    }

    private sealed class GuidKey(int rows) : Key(rows)
    {
        private readonly ulong[] high = new ulong[rows];
        private readonly ulong[] low = new ulong[rows];
        public override void Set(int row, ReadOnlySpan<byte> cell)
        {
            Span<char> chars = stackalloc char[40];
            var length = Encoding.UTF8.GetChars(cell[..Math.Min(cell.Length, 40)], chars);
            (high[row], low[row]) = Guid.TryParse(chars[..length], out var value) ? GuidOrder(value) : (0UL, 0UL);
        }
        public override int Compare(int a, int b)
        {
            var compared = high[a].CompareTo(high[b]);
            return compared != 0 ? compared : low[a].CompareTo(low[b]);
        }
    }

    /// <summary>Code-point order (UTF-8 bytes order as code points do), for binary values, _BIN and _BIN2 text and types
    /// with no collation.</summary>
    private sealed class OrdinalKey(int rows, int[]? map, PageSource source, int column, bool trim) : Key(rows, map)
    {
        private readonly ulong[] prefixes = new ulong[rows];
        public override void Set(int row, ReadOnlySpan<byte> cell) => prefixes[row] = Prefix(trim ? TrimEnd(cell) : cell);
        public override int Compare(int a, int b)
        {
            var compared = prefixes[a].CompareTo(prefixes[b]);
            if (compared != 0) return compared;
            var left = source.Cell(Row(a), column);
            var right = source.Cell(Row(b), column);
            if (trim) { left = TrimEnd(left); right = TrimEnd(right); }
            return Math.Sign(left.SequenceCompareTo(right));
        }
    }

    /// <summary>A collation's order: the first 8 bytes of each value's sort key, and the full comparison for equal prefixes.</summary>
    private sealed class CollatedKey(int rows, int[]? map, PageSource source, int column, CompareInfo info, CompareOptions options) : Key(rows, map)
    {
        private readonly ulong[] prefixes = new ulong[rows];
        private char[] left = new char[256], right = new char[256];
        private byte[] sortKey = new byte[512];

        public override void Set(int row, ReadOnlySpan<byte> cell)
        {
            var text = Decode(TrimEnd(cell), ref left);
            var length = info.GetSortKeyLength(text, options);
            if (length > sortKey.Length) sortKey = new byte[Math.Max(length, 2 * sortKey.Length)];
            var written = info.GetSortKey(text, sortKey, options);
            prefixes[row] = Prefix(sortKey.AsSpan(0, written));
        }

        public override int Compare(int a, int b)
        {
            var compared = prefixes[a].CompareTo(prefixes[b]);
            if (compared != 0) return compared;
            var x = Decode(TrimEnd(source.Cell(Row(a), column)), ref left);
            var y = Decode(TrimEnd(source.Cell(Row(b), column)), ref right);
            return Math.Sign(info.Compare(x, y, options));
        }

        private static ReadOnlySpan<char> Decode(ReadOnlySpan<byte> utf8, ref char[] buffer)
        {
            if (buffer.Length < utf8.Length) buffer = new char[Math.Max(utf8.Length, 2 * buffer.Length)];
            return buffer.AsSpan(0, Encoding.UTF8.GetChars(utf8, buffer));
        }
    }

    /// <summary>A key built over every row, read through a list of base rows: a filter's key serving a sort key that is
    /// built over only the rows the filters kept.</summary>
    private sealed class MappedKey(Key inner, int[] map) : Key(0)
    {
        public override bool IsNull(int row) => inner.IsNull(map[row]);
        public override void Set(int row, ReadOnlySpan<byte> cell) => throw new InvalidOperationException("A mapped key is built by its own.");
        public override int Compare(int a, int b) => inner.Compare(map[a], map[b]);
    }

    /// <summary>The keys in order, each descending where <paramref name="descending"/> says (null: all ascending), NULL
    /// lowest, then the index, so equal rows keep their order (a stable sort).</summary>
    private sealed class Comparer(Key[] keys, bool[]? descending, CancellationToken token) : IComparer<int>
    {
        private int calls;

        public int Compare(int a, int b)
        {
            var compared = Values(a, b);
            return compared != 0 ? compared : a.CompareTo(b);
        }

        /// <summary>The keys alone: 0 when the rows' values are equal.</summary>
        public int Values(int a, int b)
        {
            if (++calls == CancelEvery)
            {
                calls = 0;
                token.ThrowIfCancellationRequested();
            }
            for (var k = 0; k < keys.Length; k++)
            {
                var key = keys[k];
                var nullA = key.IsNull(a);
                var nullB = key.IsNull(b);
                int compared;
                if (nullA || nullB) compared = nullA == nullB ? 0 : nullA ? -1 : 1;
                else compared = key.Compare(a, b);
                if (compared != 0) return descending is not null && descending[k] ? -compared : compared;
            }
            return 0;
        }
    }
}

/// <summary>Pages in view order for results.read: up to 4,096 rows or 256 KiB each, as ingestion seals them, built from
/// each base row's stored cells (flags and truncation included) and numbered by view position. Each base page's header
/// is parsed once per read.</summary>
internal static class ViewPages
{
    public static IEnumerable<byte[]> Build(ResultView view, long firstRow, int maxRows)
    {
        foreach (var page in Stored(view, firstRow, maxRows)) yield return page.Body;
    }

    /// <summary>The same pages as stored pages numbered by view position (Copy and Save through a view), with no length
    /// sidecar, which neither reads.</summary>
    public static IEnumerable<StoredPage> Stored(ResultView view, long firstRow, int maxRows)
    {
        var set = view.Set;
        var end = Math.Min(view.Rows, firstRow + maxRows);
        if (firstRow >= end) yield break;
        var pages = set.SealedSnapshot();
        var starts = new long[pages.Length];
        for (var i = 0; i < pages.Length; i++) starts[i] = pages[i].FirstRow;
        var parsed = new Dictionary<int, (int[] Layout, int BlobStart)>();
        var columns = set.Wires.Count;
        var builder = new PageBuilder(set.ResultId, set.Wires, firstRow);
        var start = firstRow;
        for (var position = firstRow; position < end; position++)
        {
            var row = view.Order[position];
            var index = Array.BinarySearch(starts, (long)row);
            if (index < 0) index = ~index - 1;
            var page = pages[index];
            if (!parsed.TryGetValue(index, out var layout))
            {
                var first = PageView.Parse(page.Body, columns);
                parsed[index] = layout = (first.Layout, first.BlobStart);
            }
            Copy(builder, PageView.At(page.Body, layout.BlobStart, layout.Layout, page.FirstRow, page.Rows, columns), (int)(row - page.FirstRow), set.Wires);
            if (builder.IsFull)
            {
                yield return new StoredPage(start, (int)(position + 1 - start), builder.Seal(), PageLengths.Empty);
                start = position + 1;
                parsed.Clear();
            }
        }
        if (builder.HasRows) yield return new StoredPage(start, (int)(end - start), builder.Seal(), PageLengths.Empty);
    }

    private static void Copy(PageBuilder builder, PageView source, int row, IReadOnlyList<WireKind> wires)
    {
        builder.BeginRow();
        for (var c = 0; c < wires.Count; c++)
        {
            if (source.IsNull(c, row)) builder.AppendNull(source.IsError(c, row));
            else if (wires[c] == WireKind.Binary) builder.AppendBinary(source.Span(c, row), source.IsTruncated(c, row));
            else builder.AppendUtf8(source.Span(c, row), source.IsTruncated(c, row));
        }
        builder.CommitRow();
    }

    /// <summary>Each view position's row bytes (results.rowBytes through a view), with the positions whose sum is an estimate.</summary>
    public static long[] RowBytes(ResultView view, long firstRow, int count, List<long> estimated)
    {
        var end = Math.Min(view.Rows, firstRow + count);
        if (firstRow >= end) return [];
        var result = new long[end - firstRow];
        var row = new List<long>(1);
        for (var position = firstRow; position < end; position++)
        {
            row.Clear();
            var bytes = view.Set.RowBytes(view.Order[position], 1, row);
            result[position - firstRow] = bytes.Length == 1 ? bytes[0] : 0;
            if (row.Count > 0) estimated.Add(position);
        }
        return result;
    }
}
