using System.Buffers.Binary;
using System.Globalization;
using System.Text;

namespace Varia.Backend.Results;

/// <summary>How a result's rows are told apart (results.identify): by one column's value, or by every value in the row.</summary>
internal enum IdentityBy { Auto, Column, Row }

/// <summary>A result's row identities: one 53-bit number per row, a hash of the key column's value (Column ≥ 0) or of the
/// whole row (Column -1), equal for values SQL Server compares equal (CellHasher). The same value hashes the same in any
/// result, so the renderer's highlights find their rows again after a sort or a re-run. Unique says no two rows share an
/// identity. Its array is charged to the result's query budget and returned when it is replaced or its result released.</summary>
internal sealed class ResultIdentity(ResultSetBuffer set, int column, bool unique, bool approximate, long[] ids, long charged)
{
    public ResultSetBuffer Set { get; } = set;
    public int Column { get; } = column;
    public bool Unique { get; } = unique;
    /// <summary>An identity hashed a truncated value's stored prefix.</summary>
    public bool Approximate { get; } = approximate;
    /// <summary>Each base row's identity.</summary>
    public long[] Ids { get; } = ids;
    internal long Charged { get; } = charged;
    public long Rows => Ids.Length;
}

/// <summary>Builds row identities. Auto picks the first unique, NULL-free column among the likeliest keys (a name ending in
/// id, key or guid, then integer and uniqueidentifier columns, then other short character and date columns), checking at most
/// <see cref="MaxCandidates"/>, and falls back to the whole row.</summary>
internal static class RowIdentity
{
    public const int MaxCandidates = 16;
    /// <summary>Identities are masked to 53 bits, so JavaScript numbers hold them exactly.</summary>
    public const long Mask = (1L << 53) - 1;
    private const int CancelEvery = 1 << 12;

    /// <summary>Bytes the check for uniqueness holds while it runs (the identities again, spread into parts that are each
    /// sorted, and a set of the first rows'), on top of the one ids array every column Auto tries and the whole-row
    /// fallback fill.</summary>
    public static long WorkingBytes(long rows) => rows * 8 + Math.Min(rows, Probe) * 24;

    /// <summary>What the check for uniqueness holds, made once and used by every pass over a result.</summary>
    internal sealed class Working(int rows)
    {
        public readonly HashSet<long> Seen = new(Math.Min(rows, Probe));
        public readonly long[] Spread = new long[rows];
    }

    public static (int Column, bool Unique, bool Approximate, long[] Ids) Build(ResultSetBuffer set, StoredPage[] pages, IdentityBy by, int column, CancellationToken token)
    {
        long total = 0;
        foreach (var page in pages) total += page.Rows;
        if (total > Array.MaxLength) throw new RequestException("TOO_LARGE", "This result has too many rows to tell apart.");
        var rows = (int)total;
        var hasher = new CellHasher(set.Columns, set.Wires);
        // One array and one working set serve every pass, so Auto's candidates and fallback hold no more than WorkingBytes and the ids.
        var ids = new long[rows];
        var working = new Working(rows);
        if (by == IdentityBy.Column)
        {
            var (unique, approximate) = Fill(hasher, pages, column, ids, stopEarly: false, token, working);
            return (column, unique, approximate, ids);
        }
        if (by == IdentityBy.Auto)
        {
            foreach (var candidate in Candidates(set.Columns, set.Wires).Take(MaxCandidates))
            {
                var (unique, approximate) = Fill(hasher, pages, candidate, ids, stopEarly: true, token, working);
                if (unique && !approximate) return (candidate, true, false, ids);
            }
        }
        var (rowsUnique, rowsApproximate) = Fill(hasher, pages, -1, ids, stopEarly: false, token, working);
        return (-1, rowsUnique, rowsApproximate, ids);
    }

    /// <summary>The fewest rows a thread hashing a result reads; a smaller result is hashed on one.</summary>
    internal const int MinSlice = 1 << 15;
    /// <summary>Rows a column is tried on, on one thread, before all of them are hashed: most columns that are no key say
    /// so within these.</summary>
    internal const int Probe = 1 << 15;

    internal delegate void PageRead(CellHasher hasher, StoredPage page, PageView view);

    /// <summary>Reads the pages in runs on several threads (one per <see cref="MinSlice"/> rows, up to the sort's threads),
    /// each with a hasher of its own.</summary>
    internal static void EachPage(CellHasher hasher, StoredPage[] pages, long rows, CancellationToken token, PageRead read)
    {
        var runs = (int)Math.Clamp(Math.Min(rows / MinSlice, pages.Length), 1, ViewSorter.Workers);
        void Run(int run)
        {
            var own = run == 0 ? hasher : hasher.Fork();
            var scratch = new int[PageView.ScratchLength(own.Count)];
            for (int index = (int)((long)pages.Length * run / runs), end = (int)((long)pages.Length * (run + 1) / runs); index < end; index++)
            {
                token.ThrowIfCancellationRequested();
                read(own, pages[index], PageView.Parse(pages[index].Body, own.Count, scratch));
            }
        }
        if (runs == 1)
        {
            Run(0);
            return;
        }
        try { Parallel.For(0, runs, new ParallelOptions { MaxDegreeOfParallelism = runs }, Run); }
        catch (AggregateException error) when (error.InnerExceptions.Count > 0)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerExceptions[0]).Throw();
        }
    }

    /// <summary>Hashes each row's identity into <paramref name="ids"/> (column -1: the whole row), the pages in runs on
    /// several threads; whether they were all distinct (a key column also needs no NULL), and whether a truncated value was
    /// hashed. With <paramref name="stopEarly"/> it stops at a NULL, a truncated value or, among the first
    /// <see cref="Probe"/> rows, a repeat, leaving the array partly set: such a column is no key.</summary>
    internal static (bool Unique, bool Approximate) Fill(CellHasher hasher, StoredPage[] pages, int column, long[] ids, bool stopEarly, CancellationToken token, Working? working = null)
    {
        working ??= new Working(ids.Length);
        if (stopEarly)
        {
            var unique = true;
            var approximate = false;
            var seen = working.Seen;
            seen.Clear();
            var scratch = new int[PageView.ScratchLength(hasher.Count)];
            var probed = 0;
            foreach (var page in pages)
            {
                token.ThrowIfCancellationRequested();
                var view = PageView.Parse(page.Body, hasher.Count, scratch);
                var first = (int)page.FirstRow;
                for (var r = 0; r < page.Rows && probed < Probe; r++, probed++)
                {
                    long id;
                    if (column < 0) id = hasher.Row(view, r, ref approximate);
                    else
                    {
                        if (view.IsNull(column, r)) unique = false;
                        if (view.IsTruncated(column, r)) approximate = true;
                        id = hasher.Cell(view, column, r);
                    }
                    id &= Mask;
                    ids[first + r] = id;
                    if (!seen.Add(id)) unique = false;
                    if (!unique || approximate) return (unique, approximate);
                }
                if (probed == Probe) break;
            }
            if (probed == ids.Length) return (true, false);
        }
        int nulls = 0, cut = 0, stop = 0;
        EachPage(hasher, pages, ids.Length, token, (own, page, view) =>
        {
            if (stopEarly && Volatile.Read(ref stop) != 0) return;
            var first = (int)page.FirstRow;
            bool isNull = false, inexact = false;
            for (var r = 0; r < page.Rows; r++)
            {
                long id;
                if (column < 0) id = own.Row(view, r, ref inexact);
                else
                {
                    if (view.IsNull(column, r)) isNull = true;
                    if (view.IsTruncated(column, r)) inexact = true;
                    id = own.Cell(view, column, r);
                }
                ids[first + r] = id & Mask;
            }
            if (isNull) Volatile.Write(ref nulls, 1);
            if (inexact) Volatile.Write(ref cut, 1);
            if (stopEarly && (isNull || inexact)) Volatile.Write(ref stop, 1);
        });
        if (nulls != 0 || (stopEarly && cut != 0)) return (false, cut != 0);
        return (Distinct(ids, working.Spread, token), cut != 0);
    }

    /// <summary>Whether no two identities are equal. They are hashes, so their high bits spread them evenly over as many
    /// parts as there are threads; each part is sorted on its own, and equal ones end side by side.</summary>
    internal static bool Distinct(long[] ids, long[] spread, CancellationToken token)
    {
        if (ids.Length < 2) return true;
        var bits = 0;
        while (2 << bits <= ViewSorter.Workers && ids.Length >> (bits + 1) >= MinSlice) bits++;
        var parts = 1 << bits;
        var shift = 53 - bits;
        var starts = new int[parts + 1];
        foreach (var id in ids) starts[(id >> shift) + 1]++;
        for (var part = 0; part < parts; part++) starts[part + 1] += starts[part];
        token.ThrowIfCancellationRequested();
        var places = starts.AsSpan(0, parts).ToArray();
        foreach (var id in ids) spread[places[id >> shift]++] = id;
        var repeated = 0;
        void Part(int part)
        {
            if (Volatile.Read(ref repeated) != 0) return;
            token.ThrowIfCancellationRequested();
            var span = spread.AsSpan(starts[part], starts[part + 1] - starts[part]);
            span.Sort();
            for (var i = 1; i < span.Length; i++)
                if (span[i] == span[i - 1]) { Volatile.Write(ref repeated, 1); return; }
        }
        if (parts == 1) Part(0);
        else
            try { Parallel.For(0, parts, new ParallelOptions { MaxDegreeOfParallelism = parts }, Part); }
            catch (AggregateException error) when (error.InnerExceptions.Count > 0)
            {
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(error.InnerExceptions[0]).Throw();
            }
        return repeated == 0;
    }

    /// <summary>The columns Auto tries, likeliest key first: names ending in id, key or guid, then integer and
    /// uniqueidentifier types, then character (up to 450 characters) and date types; never floats, binary, xml, json,
    /// large values or hidden columns.</summary>
    internal static IEnumerable<int> Candidates(IReadOnlyList<ResultColumn> columns, IReadOnlyList<WireKind> wires)
    {
        var ranked = new List<(int Rank, int Column)>();
        for (var c = 0; c < columns.Count; c++)
        {
            var column = columns[c];
            if (wires[c] == WireKind.Binary || ResultTextWriter.Hidden(column) || column.Role is not null) continue;
            var type = ViewSorter.TypeName(column);
            var keyType = type is "tinyint" or "smallint" or "int" or "bigint" or "uniqueidentifier" or "decimal" or "numeric";
            var other = type is "char" or "varchar" or "nchar" or "nvarchar" or "sysname" or "date" or "datetime" or "datetime2" or "smalldatetime" or "datetimeoffset" or "time"
                && (column.MaxLength is null or > 0 and <= 900);
            if (!keyType && !other) continue;
            var name = column.Name.Trim();
            var named = name.Equals("id", StringComparison.OrdinalIgnoreCase) || name.EndsWith("id", StringComparison.OrdinalIgnoreCase)
                || name.EndsWith("key", StringComparison.OrdinalIgnoreCase) || name.EndsWith("guid", StringComparison.OrdinalIgnoreCase);
            ranked.Add((named ? 0 : keyType ? 1 : 2, c));
        }
        return ranked.OrderBy(item => item.Rank).ThenBy(item => item.Column).Select(item => item.Column);
    }
}

/// <summary>Hashes cells so that values SQL Server compares equal hash equal: character columns by their collation's sort
/// key without trailing spaces (code points for _BIN and _BIN2), exact numerics by their numeric value, uniqueidentifier by
/// its 16 bytes, datetimeoffset by its UTC instant, every other type by its stored bytes. NULL and a cell that could not be
/// read hash alike. 64-bit FNV-1a, then a SplitMix64 finish; collisions are possible but vanishingly rare.</summary>
internal sealed class CellHasher
{
    private enum Kind { Bytes, Collated, Trimmed, Exact, Guid, Ticks }

    private readonly Kind[] kinds;
    private readonly (CompareInfo Info, CompareOptions Options)?[] cultures;
    private readonly bool[] hidden;
    private char[] chars = new char[256];
    private byte[] sortKey = new byte[512];
    private const ulong Offset = 14695981039346656037UL, Prime = 1099511628211UL;
    private const ulong NullHash = 0x9e3779b97f4a7c15UL;

    private CellHasher(CellHasher other)
    {
        Count = other.Count;
        kinds = other.kinds;
        cultures = other.cultures;
        hidden = other.hidden;
    }

    /// <summary>A hasher of the same columns with buffers of its own, for another thread.</summary>
    public CellHasher Fork() => new(this);

    public CellHasher(IReadOnlyList<ResultColumn> columns, IReadOnlyList<WireKind> wires)
    {
        Count = columns.Count;
        kinds = new Kind[Count];
        cultures = new (CompareInfo, CompareOptions)?[Count];
        hidden = new bool[Count];
        for (var c = 0; c < Count; c++)
        {
            var column = columns[c];
            hidden[c] = ResultTextWriter.Hidden(column);
            if (wires[c] == WireKind.Binary) { kinds[c] = Kind.Bytes; continue; }
            var type = ViewSorter.TypeName(column);
            if (column.Collation is not null && type is "char" or "varchar" or "nchar" or "nvarchar" or "text" or "ntext" or "sysname")
            {
                cultures[c] = ViewSorter.Culture(column.Collation);
                kinds[c] = cultures[c] is null ? Kind.Trimmed : Kind.Collated;
                continue;
            }
            kinds[c] = type switch
            {
                "bit" or "tinyint" or "smallint" or "int" or "bigint" or "decimal" or "numeric" or "money" or "smallmoney" => Kind.Exact,
                "uniqueidentifier" => Kind.Guid,
                "datetimeoffset" => Kind.Ticks,
                _ => Kind.Bytes
            };
        }
    }

    public int Count { get; }

    /// <summary>A character column, whose equal values may differ in case or trailing spaces (a diff's soft difference).</summary>
    public bool IsText(int column) => kinds[column] is Kind.Collated or Kind.Trimmed;

    /// <summary>One cell's hash (not masked).</summary>
    public long Cell(PageView view, int column, int row) =>
        view.IsNull(column, row) ? (long)Finish(NullHash) : (long)Finish(Value(view.Span(column, row), column, Offset));

    /// <summary>A cell's hash, and whether the cell is NULL or unreadable: what the diff compares per cell.</summary>
    public ulong CellValue(PageView view, int column, int row) =>
        view.IsNull(column, row) ? NullHash : Finish(Value(view.Span(column, row), column, Offset));

    /// <summary>Whether two non-NULL cells hold the same value by this column's rules (<paramref name="other"/> hashes its
    /// column the same way, and is another hasher, whose buffers it decodes into): what a diff checks rather than trusting
    /// two hashes, which can collide.</summary>
    public bool Same(PageView view, int column, int row, CellHasher other, PageView otherView, int otherColumn, int otherRow)
    {
        var a = view.Span(column, row);
        var b = otherView.Span(otherColumn, otherRow);
        switch (kinds[column])
        {
            case Kind.Collated:
            {
                var (info, options) = cultures[column]!.Value;
                return info.Compare(Decode(ViewSorter.TrimEnd(a)), other.Decode(ViewSorter.TrimEnd(b)), options) == 0;
            }
            case Kind.Trimmed: return ViewSorter.TrimEnd(a).SequenceEqual(ViewSorter.TrimEnd(b));
            case Kind.Exact:
            {
                var negativeA = NumericParts(a, out var wholeA, out var fractionA);
                var negativeB = NumericParts(b, out var wholeB, out var fractionB);
                return negativeA == negativeB && wholeA.SequenceEqual(wholeB) && fractionA.SequenceEqual(fractionB);
            }
            case Kind.Guid:
                return Guid.TryParse(Decode(a[..Math.Min(a.Length, 40)]), out var x) && Guid.TryParse(other.Decode(b[..Math.Min(b.Length, 40)]), out var y) ? x == y : a.SequenceEqual(b);
            case Kind.Ticks:
                return DateTimeOffset.TryParse(Decode(a[..Math.Min(a.Length, 64)]), CultureInfo.InvariantCulture, DateTimeStyles.None, out var p)
                    && DateTimeOffset.TryParse(other.Decode(b[..Math.Min(b.Length, 64)]), CultureInfo.InvariantCulture, DateTimeStyles.None, out var q)
                    ? p.UtcTicks == q.UtcTicks : a.SequenceEqual(b);
            default: return a.SequenceEqual(b);
        }
    }

    /// <summary>The whole row's hash: every visible column's value, in order, NULL apart from any value.</summary>
    public long Row(PageView view, int row, ref bool approximate)
    {
        var hash = Offset;
        for (var c = 0; c < Count; c++) if (!hidden[c]) hash = Column(view, c, row, hash, ref approximate);
        return (long)Finish(hash);
    }

    /// <summary>The hash of the given columns' values, in that order: a diff's whole-row identity over the shared columns,
    /// which hashes alike in both results when their values compare equal.</summary>
    public long Row(PageView view, int row, int[] columns, ref bool approximate)
    {
        var hash = Offset;
        foreach (var c in columns) hash = Column(view, c, row, hash, ref approximate);
        return (long)Finish(hash);
    }

    private ulong Column(PageView view, int c, int row, ulong hash, ref bool approximate)
    {
        if (view.IsNull(c, row)) hash = Step(hash, 0);
        else
        {
            if (view.IsTruncated(c, row)) approximate = true;
            hash = Step(hash, 1);
            hash = Value(view.Span(c, row), c, hash);
        }
        return Step(hash, 0xff);
    }

    private ulong Value(ReadOnlySpan<byte> cell, int column, ulong hash)
    {
        switch (kinds[column])
        {
            case Kind.Collated:
            {
                var (info, options) = cultures[column]!.Value;
                var text = Decode(ViewSorter.TrimEnd(cell));
                var length = info.GetSortKeyLength(text, options);
                if (length > sortKey.Length) sortKey = new byte[Math.Max(length, 2 * sortKey.Length)];
                var written = info.GetSortKey(text, sortKey, options);
                return Bytes(hash, sortKey.AsSpan(0, written));
            }
            case Kind.Trimmed: return Bytes(hash, ViewSorter.TrimEnd(cell));
            case Kind.Exact: return Numeric(hash, cell);
            case Kind.Guid:
            {
                Span<byte> bytes = stackalloc byte[16];
                var text = Decode(cell[..Math.Min(cell.Length, 40)]);
                if (!Guid.TryParse(text, out var value)) return Bytes(hash, cell);
                value.TryWriteBytes(bytes);
                return Bytes(hash, bytes);
            }
            case Kind.Ticks:
            {
                var text = Decode(cell[..Math.Min(cell.Length, 64)]);
                if (!DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.None, out var value)) return Bytes(hash, cell);
                Span<byte> bytes = stackalloc byte[8];
                BinaryPrimitives.WriteInt64LittleEndian(bytes, value.UtcTicks);
                return Bytes(hash, bytes);
            }
            default: return Bytes(hash, cell);
        }
    }

    /// <summary>An exact numeric's digits without a sign on zero, leading zeros or trailing fractional zeros, so 1.50, 01.5
    /// and 1.5 hash alike.</summary>
    private static ulong Numeric(ulong hash, ReadOnlySpan<byte> text)
    {
        var negative = NumericParts(text, out var whole, out var fraction);
        if (negative) hash = Step(hash, (byte)'-');
        hash = Bytes(hash, whole);
        if (!fraction.IsEmpty) { hash = Step(hash, (byte)'.'); hash = Bytes(hash, fraction); }
        return hash;
    }

    /// <summary>Whether an exact numeric is negative (never zero), its whole digits without leading zeros and its fraction
    /// without trailing ones.</summary>
    private static bool NumericParts(ReadOnlySpan<byte> text, out ReadOnlySpan<byte> whole, out ReadOnlySpan<byte> fraction)
    {
        var negative = text.Length > 0 && text[0] == (byte)'-';
        if (negative) text = text[1..];
        var point = text.IndexOf((byte)'.');
        whole = (point < 0 ? text : text[..point]).TrimStart((byte)'0');
        fraction = (point < 0 ? [] : text[(point + 1)..]).TrimEnd((byte)'0');
        return negative && !(whole.IsEmpty && fraction.IsEmpty);
    }

    private ReadOnlySpan<char> Decode(ReadOnlySpan<byte> utf8)
    {
        if (chars.Length < utf8.Length) chars = new char[Math.Max(utf8.Length, 2 * chars.Length)];
        return chars.AsSpan(0, Encoding.UTF8.GetChars(utf8, chars));
    }

    private static ulong Step(ulong hash, byte value) => (hash ^ value) * Prime;

    private static ulong Bytes(ulong hash, ReadOnlySpan<byte> bytes)
    {
        foreach (var b in bytes) hash = (hash ^ b) * Prime;
        // The length closes the value, so adjacent values cannot run together.
        return Step(Step(hash, (byte)bytes.Length), (byte)(bytes.Length >> 8));
    }

    private static ulong Finish(ulong x)
    {
        x ^= x >> 30; x *= 0xbf58476d1ce4e5b9UL;
        x ^= x >> 27; x *= 0x94d049bb133111ebUL;
        return x ^ (x >> 31);
    }
}

/// <summary>Finds rows by identity (results.findRows): each position, in a view's order or the result's own, whose row's
/// identity is one of the asked ones.</summary>
internal static class IdentityMatches
{
    public static (List<long> Positions, List<int> Marks, bool Truncated) Find(ResultIdentity identity, ResultView? view, long[] ids, int maxMatches, CancellationToken token)
    {
        var wanted = new Dictionary<long, int>(ids.Length);
        for (var i = 0; i < ids.Length; i++) wanted.TryAdd(ids[i], i);
        var positions = new List<long>();
        var marks = new List<int>();
        var source = identity.Ids;
        var count = view?.Rows ?? source.LongLength;
        for (long p = 0; p < count; p++)
        {
            if ((p & 0xffff) == 0) token.ThrowIfCancellationRequested();
            var row = view is null ? p : view.Order[p];
            if (row >= source.Length || !wanted.TryGetValue(source[row], out var mark)) continue;
            if (positions.Count == maxMatches) return (positions, marks, true);
            positions.Add(p);
            marks.Add(mark);
        }
        return (positions, marks, false);
    }
}
