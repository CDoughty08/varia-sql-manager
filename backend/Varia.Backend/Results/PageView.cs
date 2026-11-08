using System.Buffers.Binary;
using System.Numerics;
using Varia.Backend.Protocol;

namespace Varia.Backend.Results;

/// <summary>Reads a stored page in place for copy and export. Pages come only from <see cref="PageBuilder"/>, so the
/// header is parsed in O(columns) without the bounds and flag checks that the renderer's decoder and the test oracle
/// (Varia.Backend.Tests/PageReader.cs, kept independent on purpose) apply to bytes from another process.</summary>
internal readonly ref struct PageView
{
    // Per column: wire, then (offset, length) of validity, offsets, data, truncated and errors within the blob.
    private const int Stride = 11;
    private readonly ReadOnlySpan<byte> blob;
    private readonly int[] layout;
    private readonly int blobStart;

    private PageView(ReadOnlySpan<byte> blob, int blobStart, int[] layout, long firstRow, int rows, int columns)
    {
        this.blob = blob;
        this.blobStart = blobStart;
        this.layout = layout;
        FirstRow = firstRow;
        Rows = rows;
        Columns = columns;
    }

    public long FirstRow { get; }
    public int Rows { get; }
    public int Columns { get; }

    /// <param name="scratch">Reused for the column layout when it has room for <paramref name="columns"/>, so writing a
    /// result allocates nothing per page.</param>
    public static PageView Parse(ReadOnlySpan<byte> page, int columns, int[]? scratch = null)
    {
        var reader = new MsgPackReader(page);
        if (reader.ReadArrayHeader() != 7 || reader.ReadInt64() != PageBuilder.FormatVersion) throw new InvalidDataException("Unsupported result page.");
        reader.ReadInt64();
        var firstRow = reader.ReadInt64();
        var rows = (int)reader.ReadInt64();
        if (reader.ReadArrayHeader() != columns) throw new InvalidDataException("The page does not match its result set.");
        var layout = scratch is not null && scratch.Length >= columns * Stride ? scratch : new int[columns * Stride];
        for (var c = 0; c < columns; c++)
        {
            reader.ReadArrayHeader();
            for (var i = 0; i < Stride; i++) layout[c * Stride + i] = (int)reader.ReadInt64();
        }
        reader.ReadBinary();
        reader.ReadBinaryHeader();
        return new PageView(page[reader.Consumed..], reader.Consumed, layout, firstRow, rows, columns);
    }

    /// <summary>A page parsed before (<see cref="Layout"/> and <see cref="BlobStart"/> kept from its first parse), without
    /// reading its header again: views read scattered rows of many pages, and a wide page's header is O(columns).</summary>
    public static PageView At(ReadOnlySpan<byte> page, int blobStart, int[] layout, long firstRow, int rows, int columns) =>
        new(page[blobStart..], blobStart, layout, firstRow, rows, columns);

    /// <summary>The column layout this view reads, for <see cref="At"/>: the scratch array when one was passed, so a caller
    /// that keeps it parses without one.</summary>
    public int[] Layout => layout;
    /// <summary>Where the page's blob starts within the page, for <see cref="At"/>.</summary>
    public int BlobStart => blobStart;

    /// <summary>The page offsets of a column's offsets and data regions: a sort reads one column's cells straight from the
    /// stored page (cell k's bytes are data[offsets[k]..offsets[k + 1]], offsets little-endian u32).</summary>
    public (int Offsets, int Data) Regions(int column)
    {
        var at = column * Stride + 1;
        return (blobStart + layout[at + 2], blobStart + layout[at + 4]);
    }

    public static int ScratchLength(int columns) => columns * Stride;

    public WireKind Wire(int column) => (WireKind)layout[column * Stride];

    /// <summary>The cell's bytes: UTF-8 display text, or the binary value. Empty for NULL.</summary>
    public ReadOnlySpan<byte> Span(int column, int row)
    {
        var offsets = Region(column, 1);
        var start = (int)BinaryPrimitives.ReadUInt32LittleEndian(offsets[(4 * row)..]);
        var end = (int)BinaryPrimitives.ReadUInt32LittleEndian(offsets[(4 * row + 4)..]);
        return Region(column, 2)[start..end];
    }

    /// <summary>Bytes of rows [first, last] of a column, in O(1).</summary>
    public long SpanBytes(int column, int first, int last)
    {
        var offsets = Region(column, 1);
        return BinaryPrimitives.ReadUInt32LittleEndian(offsets[(4 * last + 4)..]) - (long)BinaryPrimitives.ReadUInt32LittleEndian(offsets[(4 * first)..]);
    }

    /// <summary>NULL (and read-error) cells among rows [first, last], by popcount over the validity bitmap.</summary>
    public int NullCount(int column, int first, int last)
    {
        var validity = Region(column, 0);
        if (validity.IsEmpty) return 0;
        var valid = 0;
        var row = first;
        for (; row <= last && (row & 7) != 0; row++) if ((validity[row >> 3] & (1 << (row & 7))) != 0) valid++;
        for (; row + 8 <= last + 1; row += 8) valid += BitOperations.PopCount(validity[row >> 3]);
        for (; row <= last; row++) if ((validity[row >> 3] & (1 << (row & 7))) != 0) valid++;
        return last - first + 1 - valid;
    }

    public bool IsNull(int column, int row)
    {
        var validity = Region(column, 0);
        return !validity.IsEmpty && (validity[row >> 3] & (1 << (row & 7))) == 0;
    }

    public bool IsTruncated(int column, int row) => Bit(Region(column, 3), row);
    public bool IsError(int column, int row) => Bit(Region(column, 4), row);

    private static bool Bit(ReadOnlySpan<byte> bitmap, int row) => !bitmap.IsEmpty && (bitmap[row >> 3] & (1 << (row & 7))) != 0;

    private ReadOnlySpan<byte> Region(int column, int region)
    {
        var at = column * Stride + 1 + 2 * region;
        return blob.Slice(layout[at], layout[at + 1]);
    }
}
