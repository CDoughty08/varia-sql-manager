using System.Buffers.Binary;
using System.Globalization;
using System.Text;

namespace Varia.Backend.Results;

/// <summary>How a sort key compares a column: its values (by SQL type and collation), or, for text and binary columns, each
/// cell's characters or bytes (DATALENGTH; CellLengths.cs).</summary>
internal enum SortMode { Value, Chars, Bytes }

internal sealed record ViewKey(int Column, bool Descending, SortMode Mode);

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
    private const int CancelEvery = 1 << 14;

    /// <summary>Bytes a sort holds per row and key while it runs: the key's 8- or 16-byte value and a NULL bit.</summary>
    public static long WorkingBytes(long rows, int keys) => rows * (16L * keys + 4) + rows / 8 * keys;

    public static (int[] Order, bool Approximate) Sort(ResultSetBuffer set, StoredPage[] pages, IReadOnlyList<ViewKey> keys, CancellationToken token)
    {
        long total = 0;
        foreach (var page in pages) total += page.Rows;
        if (total > Array.MaxLength) throw new RequestException("TOO_LARGE", "This result has too many rows to sort.");
        var rows = (int)total;
        var source = new PageSource(pages, set.Wires.Count);
        var approximate = false;
        var built = new Key[keys.Count];
        for (var k = 0; k < keys.Count; k++)
        {
            built[k] = Build(set, source, keys[k], rows, token, ref approximate);
        }
        var order = new int[rows];
        for (var i = 0; i < rows; i++) order[i] = i;
        if (rows > 1) Array.Sort(order, new Comparer(built, token));
        return (order, approximate);
    }

    private static Key Build(ResultSetBuffer set, PageSource source, ViewKey sort, int rows, CancellationToken token, ref bool approximate)
    {
        var column = sort.Column;
        var meta = set.Columns[column];
        var wire = set.Wires[column];
        var kind = sort.Mode != SortMode.Value && (wire == WireKind.Binary || IsText(meta)) ? KindFor(sort.Mode) : KindOf(meta, wire);
        Key key = kind switch
        {
            Kind.Chars or Kind.Bytes => new LengthKey(rows),
            Kind.Exact => new NumberKey(rows, source, column, exact: true),
            Kind.Approximate => new NumberKey(rows, source, column, exact: false),
            Kind.Ticks => new TicksKey(rows),
            Kind.Guid => new GuidKey(rows),
            Kind.Collated when Culture(meta.Collation) is { } culture => new CollatedKey(rows, source, column, culture.Info, culture.Options),
            _ => new OrdinalKey(rows, source, column, trim: meta.Collation is not null)
        };
        key.Descending = sort.Descending;
        var lengths = set.Lengths[column];
        foreach (var (index, page) in source.Pages())
        {
            token.ThrowIfCancellationRequested();
            var view = source.View(index);
            var first = (int)page.FirstRow;
            for (var r = 0; r < page.Rows; r++)
            {
                var row = first + r;
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

    private enum Kind { Exact, Approximate, Ticks, Guid, Collated, Ordinal, Chars, Bytes }

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

    private static Kind KindOf(ResultColumn column, WireKind wire)
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

    private abstract class Key(int rows)
    {
        private readonly byte[] nulls = new byte[(rows + 7) / 8];
        public bool Descending { get; set; }
        public void SetNull(int row) => nulls[row >> 3] |= (byte)(1 << (row & 7));
        public bool IsNull(int row) => (nulls[row >> 3] & (1 << (row & 7))) != 0;
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
    private sealed class NumberKey(int rows, PageSource source, int column, bool exact) : Key(rows)
    {
        private readonly double[] values = new double[rows];
        public override void Set(int row, ReadOnlySpan<byte> cell) =>
            values[row] = double.TryParse(cell, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : double.NaN;
        public override int Compare(int a, int b)
        {
            var compared = values[a].CompareTo(values[b]);
            if (compared != 0 || !exact) return compared;
            return CompareNumericText(source.Cell(a, column), source.Cell(b, column));
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
    private sealed class OrdinalKey(int rows, PageSource source, int column, bool trim) : Key(rows)
    {
        private readonly ulong[] prefixes = new ulong[rows];
        public override void Set(int row, ReadOnlySpan<byte> cell) => prefixes[row] = Prefix(trim ? TrimEnd(cell) : cell);
        public override int Compare(int a, int b)
        {
            var compared = prefixes[a].CompareTo(prefixes[b]);
            if (compared != 0) return compared;
            var left = source.Cell(a, column);
            var right = source.Cell(b, column);
            if (trim) { left = TrimEnd(left); right = TrimEnd(right); }
            return Math.Sign(left.SequenceCompareTo(right));
        }
    }

    /// <summary>A collation's order: the first 8 bytes of each value's sort key, and the full comparison for equal prefixes.</summary>
    private sealed class CollatedKey(int rows, PageSource source, int column, CompareInfo info, CompareOptions options) : Key(rows)
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
            var x = Decode(TrimEnd(source.Cell(a, column)), ref left);
            var y = Decode(TrimEnd(source.Cell(b, column)), ref right);
            return Math.Sign(info.Compare(x, y, options));
        }

        private static ReadOnlySpan<char> Decode(ReadOnlySpan<byte> utf8, ref char[] buffer)
        {
            if (buffer.Length < utf8.Length) buffer = new char[Math.Max(utf8.Length, 2 * buffer.Length)];
            return buffer.AsSpan(0, Encoding.UTF8.GetChars(utf8, buffer));
        }
    }

    /// <summary>The keys in order, NULL lowest, then the base row, so equal rows keep their order (a stable sort).</summary>
    private sealed class Comparer(Key[] keys, CancellationToken token) : IComparer<int>
    {
        private int calls;

        public int Compare(int a, int b)
        {
            if (++calls == CancelEvery)
            {
                calls = 0;
                token.ThrowIfCancellationRequested();
            }
            foreach (var key in keys)
            {
                var nullA = key.IsNull(a);
                var nullB = key.IsNull(b);
                int compared;
                if (nullA || nullB) compared = nullA == nullB ? 0 : nullA ? -1 : 1;
                else compared = key.Compare(a, b);
                if (compared != 0) return key.Descending ? -compared : compared;
            }
            return a.CompareTo(b);
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
