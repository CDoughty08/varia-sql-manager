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

    /// <summary>Bytes the check for uniqueness holds per row while it runs (a HashSet entry), on top of the ids.</summary>
    public static long WorkingBytes(long rows) => rows * 24;

    public static (int Column, bool Unique, bool Approximate, long[] Ids) Build(ResultSetBuffer set, StoredPage[] pages, IdentityBy by, int column, CancellationToken token)
    {
        long total = 0;
        foreach (var page in pages) total += page.Rows;
        if (total > Array.MaxLength) throw new RequestException("TOO_LARGE", "This result has too many rows to tell apart.");
        var rows = (int)total;
        var hasher = new CellHasher(set.Columns, set.Wires);
        if (by == IdentityBy.Column)
        {
            var ids = new long[rows];
            var (unique, approximate) = Fill(hasher, pages, column, ids, stopEarly: false, token);
            return (column, unique, approximate, ids);
        }
        if (by == IdentityBy.Auto)
        {
            var ids = new long[rows];
            foreach (var candidate in Candidates(set.Columns, set.Wires).Take(MaxCandidates))
            {
                var (unique, approximate) = Fill(hasher, pages, candidate, ids, stopEarly: true, token);
                if (unique && !approximate) return (candidate, true, false, ids);
            }
        }
        var rowIds = new long[rows];
        var (rowsUnique, rowsApproximate) = Fill(hasher, pages, -1, rowIds, stopEarly: false, token);
        return (-1, rowsUnique, rowsApproximate, rowIds);
    }

    /// <summary>Hashes each row's identity into <paramref name="ids"/> (column -1: the whole row); whether they were all
    /// distinct (a key column also needs no NULL), and whether a truncated value was hashed. With <paramref name="stopEarly"/>
    /// it stops at the first NULL, truncated value or repeat, leaving the rest of the array unset.</summary>
    private static (bool Unique, bool Approximate) Fill(CellHasher hasher, StoredPage[] pages, int column, long[] ids, bool stopEarly, CancellationToken token)
    {
        var seen = new HashSet<long>(ids.Length);
        var unique = true;
        var approximate = false;
        var columns = hasher.Count;
        var scratch = new int[PageView.ScratchLength(columns)];
        var counter = 0;
        foreach (var page in pages)
        {
            token.ThrowIfCancellationRequested();
            var view = PageView.Parse(page.Body, columns, scratch);
            var first = (int)page.FirstRow;
            for (var r = 0; r < page.Rows; r++)
            {
                if (++counter == CancelEvery) { counter = 0; token.ThrowIfCancellationRequested(); }
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
                if (unique && !seen.Add(id)) unique = false;
                if (stopEarly && (!unique || approximate)) return (unique, approximate);
            }
        }
        return (unique, approximate);
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

    /// <summary>One cell's hash (not masked).</summary>
    public long Cell(PageView view, int column, int row) =>
        view.IsNull(column, row) ? (long)Finish(NullHash) : (long)Finish(Value(view.Span(column, row), column, Offset));

    /// <summary>A cell's hash, and whether the cell is NULL or unreadable: what the diff compares per cell.</summary>
    public ulong CellValue(PageView view, int column, int row) =>
        view.IsNull(column, row) ? NullHash : Finish(Value(view.Span(column, row), column, Offset));

    /// <summary>The whole row's hash: every visible column's value, in order, NULL apart from any value.</summary>
    public long Row(PageView view, int row, ref bool approximate)
    {
        var hash = Offset;
        for (var c = 0; c < Count; c++)
        {
            if (hidden[c]) continue;
            if (view.IsNull(c, row)) hash = Step(hash, 0);
            else
            {
                if (view.IsTruncated(c, row)) approximate = true;
                hash = Step(hash, 1);
                hash = Value(view.Span(c, row), c, hash);
            }
            hash = Step(hash, 0xff);
        }
        return (long)Finish(hash);
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
        var negative = text.Length > 0 && text[0] == (byte)'-';
        if (negative) text = text[1..];
        var point = text.IndexOf((byte)'.');
        var whole = (point < 0 ? text : text[..point]).TrimStart((byte)'0');
        var fraction = (point < 0 ? [] : text[(point + 1)..]).TrimEnd((byte)'0');
        if (whole.IsEmpty && fraction.IsEmpty) negative = false;
        if (negative) hash = Step(hash, (byte)'-');
        hash = Bytes(hash, whole);
        if (!fraction.IsEmpty) { hash = Step(hash, (byte)'.'); hash = Bytes(hash, fraction); }
        return hash;
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
