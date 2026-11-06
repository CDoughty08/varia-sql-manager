using System.Text;

namespace Varia.Backend.Results;

/// <summary>How a column's byte length (SQL Server's DATALENGTH) follows from its values (docs/ipc.md, Cell lengths).</summary>
internal enum LengthRule : byte
{
    /// <summary>The type's storage size, <see cref="ColumnLength.FixedBytes"/>: int, money, date, datetime2(n), uniqueidentifier.</summary>
    Fixed,
    /// <summary>decimal and numeric: DATALENGTH counts the unscaled value, 1 byte plus 4 per 32-bit word it needs (1 is 5
    /// bytes in a decimal(38,0)), so it follows from the display text.</summary>
    Decimal,
    /// <summary>2 bytes per UTF-16 unit: nchar, nvarchar, ntext, FOR XML and FOR JSON output, and text of unknown types.</summary>
    Utf16,
    /// <summary>The text's UTF-8 bytes: char, varchar and text in a _UTF8 collation, and json (as SQL Server sends it).</summary>
    Utf8,
    /// <summary>One byte per character: char, varchar and text in a single-byte code page.</summary>
    SingleByte,
    /// <summary>The code page's bytes for the text: char, varchar and text in a double-byte code page (932, 936, 949, 950).</summary>
    CodePage,
    /// <summary>The value's bytes: binary, varbinary, image, rowversion and CLR types.</summary>
    Binary,
    /// <summary>Measured from the value as it is read and kept for every cell, since the display text does not tell: xml
    /// (its UTF-16 text as SQL Server sends it), vector (8 bytes plus 4 per dimension) and sql_variant.</summary>
    Recorded
}

/// <summary>One column's <see cref="LengthRule"/>, chosen once from its type and collation (ColumnPlan).</summary>
internal sealed class ColumnLength
{
    public static readonly ColumnLength Utf16 = new(LengthRule.Utf16);
    public static readonly ColumnLength Utf8 = new(LengthRule.Utf8, encoding: new UTF8Encoding(false));
    public static readonly ColumnLength Binary = new(LengthRule.Binary);
    public static readonly ColumnLength Recorded = new(LengthRule.Recorded);
    public static readonly ColumnLength Decimal = new(LengthRule.Decimal);
    public static readonly ColumnLength SingleByte = new(LengthRule.SingleByte);
    private static readonly ColumnLength[] Fixeds = [.. Enumerable.Range(0, 17).Select(bytes => new ColumnLength(LengthRule.Fixed, bytes))];

    private ColumnLength(LengthRule rule, int fixedBytes = 0, Encoding? encoding = null)
    {
        Rule = rule;
        FixedBytes = fixedBytes;
        Encoding = encoding;
    }

    public LengthRule Rule { get; }
    public int FixedBytes { get; }
    /// <summary>The encoding SqlClient decoded the column's text with (Utf8 and CodePage rules).</summary>
    public Encoding? Encoding { get; }

    public static ColumnLength Fixed(int bytes) => Fixeds[bytes];

    /// <summary>A char, varchar or text column's rule from the encoding SqlClient decodes it with; without one (SqlClient's
    /// metadata unreadable) a single-byte code page is assumed.</summary>
    public static ColumnLength Chars(Encoding? encoding, bool utf8) =>
        utf8 ? Utf8 : encoding is null || encoding.IsSingleByte ? SingleByte : new ColumnLength(LengthRule.CodePage, encoding: encoding);

    /// <summary>A counter for one value read in chunks; one counter serves a column's cells in turn.</summary>
    public ByteCounter Counter() => new(this);

    /// <summary>The bytes of a whole value given as text (Utf16, Utf8, SingleByte and CodePage rules).</summary>
    public long BytesOf(ReadOnlySpan<char> text) => Rule switch
    {
        LengthRule.Utf16 => 2L * text.Length,
        LengthRule.SingleByte => text.Length,
        LengthRule.Utf8 or LengthRule.CodePage => Encoding!.GetByteCount(text),
        _ => throw new InvalidOperationException("The column's bytes do not follow from its text alone.")
    };

    /// <summary>A stored, untruncated cell's characters (UTF-16 units of its display text, every character counted) and
    /// bytes. Recorded columns keep every cell's lengths beside the page instead.</summary>
    public CellSize Derive(ReadOnlySpan<byte> stored, WireKind wire)
    {
        if (wire == WireKind.Binary) return new CellSize(stored.Length, stored.Length, true);
        var chars = System.Text.Encoding.UTF8.GetCharCount(stored);
        long bytes = Rule switch
        {
            LengthRule.Fixed => FixedBytes,
            LengthRule.Decimal => DecimalBytes(stored),
            LengthRule.Utf16 => 2L * chars,
            // The page holds the text as UTF-8: for a _UTF8 column, its bytes are SQL Server's.
            LengthRule.Utf8 => stored.Length,
            LengthRule.SingleByte => chars,
            LengthRule.CodePage => Encoding!.GetByteCount(System.Text.Encoding.UTF8.GetString(stored)),
            LengthRule.Binary => stored.Length,
            _ => -1
        };
        return bytes < 0 ? new CellSize(chars, 2L * chars, false) : new CellSize(chars, bytes, true);
    }

    /// <summary>DATALENGTH of a decimal or numeric from its display text ("-123.4500"): 1 byte plus 4 per 32-bit word of
    /// the unscaled value's magnitude (at least one), as SQL Server reports it whatever the declared precision.</summary>
    public static int DecimalBytes(ReadOnlySpan<byte> text)
    {
        UInt128 value = 0;
        foreach (var unit in text)
            if (unit is >= (byte)'0' and <= (byte)'9') value = value * 10 + (uint)(unit - '0');
        var bits = 128 - (int)UInt128.LeadingZeroCount(value);
        return 1 + 4 * Math.Max(1, (bits + 31) / 32);
    }
}

/// <summary>Counts a value's bytes from chunks of its text, in order. A high surrogate that ends a chunk waits for the
/// next one, so a pair split across two chunks counts as one character (4 UTF-8 bytes, not two lone halves of 3).
/// (Encoder.GetByteCount would not do: it never changes the encoder's state.)</summary>
internal sealed class ByteCounter(ColumnLength length)
{
    private readonly Encoding? encoding = length.Rule is LengthRule.Utf8 or LengthRule.CodePage ? length.Encoding : null;
    private readonly int perChar = length.Rule == LengthRule.Utf16 ? 2 : 1;
    private long bytes;
    private char carry;

    public void Reset()
    {
        bytes = 0;
        carry = '\0';
    }

    public void Add(ReadOnlySpan<char> chunk)
    {
        if (chunk.IsEmpty) return;
        if (encoding is null)
        {
            bytes += (long)perChar * chunk.Length;
            return;
        }
        if (carry != '\0')
        {
            Span<char> pair = [carry, chunk[0]];
            var whole = char.IsLowSurrogate(chunk[0]);
            bytes += encoding.GetByteCount(whole ? pair : pair[..1]);
            if (whole) chunk = chunk[1..];
            carry = '\0';
        }
        if (!chunk.IsEmpty && char.IsHighSurrogate(chunk[^1]))
        {
            carry = chunk[^1];
            chunk = chunk[..^1];
        }
        bytes += encoding.GetByteCount(chunk);
    }

    /// <summary>The value's bytes; the counter then starts the next value.</summary>
    public long Total()
    {
        var total = bytes;
        if (carry != '\0') total += encoding!.GetByteCount([carry]);
        Reset();
        return total;
    }
}

/// <summary>A cell's characters (UTF-16 units, whitespace included: not LEN, which drops trailing spaces) and bytes
/// (DATALENGTH). Exact is false only for a truncated cell with no recorded lengths (a live table's) or a recorded
/// column's cell without its entry, whose figures then describe the stored prefix.</summary>
internal readonly record struct CellSize(long Chars, long Bytes, bool Exact);

/// <summary>The full lengths of one cell kept beside its page: a truncated cell, or any cell of a Recorded column.</summary>
internal readonly record struct CellLength(int Row, int Column, long Chars, long Bytes);

/// <summary>The lengths sidecar of a sealed page: every row's bytes (the sum of DATALENGTH over its cells, NULL counting
/// 0) as a uint32, a row of 4 GiB or more stored as uint.MaxValue with its exact figure in <see cref="Large"/>, and the
/// sparse <see cref="CellLength"/> entries in row and column order.</summary>
internal sealed class PageLengths(uint[] rowBytes, CellLength[] cells, (int Row, long Bytes)[] large)
{
    /// <summary>Bookkeeping charged per page on top of the arrays: three array headers and this object.</summary>
    public const long Overhead = 96;
    /// <summary>What one sparse entry costs.</summary>
    public const int CellBytes = 24;
    public const int LargeBytes = 16;
    public static readonly PageLengths Empty = new([], [], []);

    public int Rows => rowBytes.Length;
    public IReadOnlyList<CellLength> Cells => cells;
    public IReadOnlyList<(int Row, long Bytes)> Large => large;
    /// <summary>The memory the sidecar holds, as charged to the query's budget.</summary>
    public long MemoryBytes => Overhead + 4L * rowBytes.Length + (long)CellBytes * cells.Length + (long)LargeBytes * large.Length;

    public long RowBytes(int row)
    {
        var value = rowBytes[row];
        if (value != uint.MaxValue) return value;
        foreach (var (at, bytes) in large) if (at == row) return bytes;
        return value;
    }

    public bool TryCell(int row, int column, out CellLength cell)
    {
        int low = 0, high = cells.Length;
        while (low < high)
        {
            var middle = (low + high) >>> 1;
            var probe = cells[middle];
            if (probe.Row < row || (probe.Row == row && probe.Column < column)) low = middle + 1;
            else high = middle;
        }
        if (low < cells.Length && cells[low].Row == row && cells[low].Column == column)
        {
            cell = cells[low];
            return true;
        }
        cell = default;
        return false;
    }
}
