using System.Buffers;
using System.Buffers.Binary;
using System.Text.Unicode;
using Varia.Backend.Protocol;

namespace Varia.Backend.Results;

internal enum WireKind : byte { Text = 1, Binary = 2 }

/// <summary>Builds columnar result pages (docs/ipc.md; src/shared/ipc/wire/pages.ts decodes them and its encodePage writes
/// identical bytes). Cells are appended in column order, each column once per row, between BeginRow and CommitRow;
/// AbortRow discards a partial row, so pages never hold one. Seal returns the exact-size page, which is both stored and
/// written to stdout.</summary>
internal sealed class PageBuilder
{
    public const int MaxRows = 4096;
    public const int MaxColumns = 4096;
    public const int SealBytes = 256 * 1024;
    public const int FirstPageRows = 64;
    public const int MaxRowBytes = 8 * 1024 * 1024;
    public const int FormatVersion = 1;

    private sealed class Column(WireKind wire)
    {
        public readonly WireKind Wire = wire;
        public byte[] Data = new byte[64];
        public int Length;
        public uint[] Offsets = new uint[FirstPageRows + 1];
        // Allocated on first use; bit 1 marks a NULL (inverted into the validity bitmap at seal), truncated or failed cell.
        public byte[]? Nulls, Truncated, Errors;

        public void Ensure(int bytes)
        {
            if (Length + bytes <= Data.Length) return;
            Array.Resize(ref Data, (int)Math.Min(Array.MaxLength, Math.Max((long)Length + bytes, Data.Length * 2L)));
        }
    }

    private static readonly byte[] Zeros = new byte[8];
    private readonly Column[] columns;
    private readonly ArrayBufferWriter<byte> header = new(256);
    private int rows;
    private int next = -1;
    private long rowBytes;
    private long dataBytes;

    public PageBuilder(uint resultId, IReadOnlyList<WireKind> wires, long firstRow = 0)
    {
        if (resultId == 0) throw new ArgumentOutOfRangeException(nameof(resultId));
        if (wires.Count is < 1 or > MaxColumns) throw new ArgumentOutOfRangeException(nameof(wires));
        ResultId = resultId;
        FirstRow = firstRow;
        columns = [.. wires.Select(wire => new Column(wire))];
    }

    public uint ResultId { get; }
    /// <summary>The row number of the page being built; it advances by the sealed row count.</summary>
    public long FirstRow { get; private set; }
    public int RowCount => rows;
    public bool HasRows => rows > 0;
    /// <summary>Approximate encoded size of the committed rows: cell bytes plus offsets.</summary>
    public long ByteCount => dataBytes + 4L * columns.Length * (rows + 1);
    public bool IsFull => rows >= MaxRows || ByteCount >= SealBytes;
    /// <summary>Bytes held by the builder's buffers, for memory accounting.</summary>
    public long WorkingBytes => columns.Sum(column => (long)column.Data.Length + 4L * column.Offsets.Length + (column.Nulls?.Length ?? 0) + (column.Truncated?.Length ?? 0) + (column.Errors?.Length ?? 0));

    public void BeginRow()
    {
        if (next >= 0) throw new InvalidOperationException("A row is already open.");
        if (rows >= MaxRows) throw new InvalidOperationException("The page is full; seal it first.");
        next = 0;
        rowBytes = 0;
    }

    private Column Cell()
    {
        if (next < 0 || next >= columns.Length) throw new InvalidOperationException("Cells must be appended in column order within a row.");
        return columns[next];
    }

    private void EndCell(Column column, bool truncated)
    {
        if (truncated) Set(ref column.Truncated, rows);
        if (rows + 2 > column.Offsets.Length) Array.Resize(ref column.Offsets, Math.Min(MaxRows + 1, column.Offsets.Length * 2));
        column.Offsets[rows + 1] = (uint)column.Length;
        next++;
    }

    private static void Set(ref byte[]? bitmap, int row)
    {
        bitmap ??= new byte[MaxRows / 8];
        bitmap[row >> 3] |= (byte)(1 << (row & 7));
    }

    private static void Clear(byte[]? bitmap, int row)
    {
        if (bitmap is not null) bitmap[row >> 3] &= (byte)~(1 << (row & 7));
    }

    /// <summary>Bytes the current row may still add before its cells become truncated prefixes.</summary>
    private int RowBudget => (int)Math.Max(0, MaxRowBytes - rowBytes);

    public void AppendNull(bool error = false)
    {
        var column = Cell();
        Set(ref column.Nulls, rows);
        if (error) Set(ref column.Errors, rows);
        EndCell(column, false);
    }

    /// <summary>Text as UTF-8; lone surrogates become U+FFFD. A cell that would push the row past 8 MiB is cut at a
    /// character boundary and marked truncated.</summary>
    public void AppendText(ReadOnlySpan<char> text, bool truncated = false)
    {
        var column = Text();
        var room = (int)Math.Min(RowBudget, 3L * text.Length);
        column.Ensure(room);
        var status = Utf8.FromUtf16(text, column.Data.AsSpan(column.Length, room), out _, out var written, replaceInvalidSequences: true);
        Commit(column, written, truncated || status == OperationStatus.DestinationTooSmall);
    }

    /// <summary>UTF-8 the caller has validated; cut at a character boundary when the row budget runs out.</summary>
    public void AppendUtf8(ReadOnlySpan<byte> utf8, bool truncated = false)
    {
        var column = Text();
        var length = Math.Min(utf8.Length, RowBudget);
        if (length < utf8.Length)
        {
            while (length > 0 && (utf8[length] & 0xc0) == 0x80) length--;
            truncated = true;
        }
        column.Ensure(length);
        utf8[..length].CopyTo(column.Data.AsSpan(column.Length));
        Commit(column, length, truncated);
    }

    /// <summary>Space for a fixed-size formatted value (see <see cref="CellFormat"/>); finish with <see cref="EndFormatted"/>.</summary>
    public Span<byte> BeginFormatted()
    {
        var column = Text();
        column.Ensure(CellFormat.MaxFixedBytes);
        return column.Data.AsSpan(column.Length, CellFormat.MaxFixedBytes);
    }

    public void EndFormatted(int written) => Commit(Text(), written, false);

    public void AppendBinary(ReadOnlySpan<byte> bytes, bool truncated = false)
    {
        var column = Cell();
        if (column.Wire != WireKind.Binary) throw new InvalidOperationException("This column holds text.");
        var length = Math.Min(bytes.Length, RowBudget);
        column.Ensure(length);
        bytes[..length].CopyTo(column.Data.AsSpan(column.Length));
        Commit(column, length, truncated || length < bytes.Length);
    }

    private Column Text()
    {
        var column = Cell();
        return column.Wire == WireKind.Text ? column : throw new InvalidOperationException("This column holds binary values.");
    }

    private void Commit(Column column, int written, bool truncated)
    {
        column.Length += written;
        rowBytes += written;
        EndCell(column, truncated);
    }

    public void CommitRow()
    {
        if (next != columns.Length) throw new InvalidOperationException("Every column needs a cell before the row is committed.");
        dataBytes += rowBytes;
        rows++;
        next = -1;
    }

    /// <summary>Discards the open row's cells and flags.</summary>
    public void AbortRow()
    {
        if (next < 0) return;
        for (var i = 0; i < next; i++)
        {
            var column = columns[i];
            column.Length = (int)column.Offsets[rows];
            Clear(column.Nulls, rows);
            Clear(column.Truncated, rows);
            Clear(column.Errors, rows);
        }
        next = -1;
    }

    private static bool Any(byte[]? bitmap, int rows)
    {
        if (bitmap is null) return false;
        var span = bitmap.AsSpan(0, (rows + 7) / 8);
        return span.ContainsAnyExcept((byte)0);
    }

    /// <summary>The page for the committed rows, in one exact-size array; the builder then starts the next page.</summary>
    public byte[] Seal()
    {
        if (next >= 0) throw new InvalidOperationException("Commit or abort the open row first.");
        if (rows == 0) throw new InvalidOperationException("A page needs at least one row.");
        var bitmapBytes = (rows + 7) / 8;
        // Per column: validity, offsets, data, truncated, errors; each present region starts 8-aligned in the blob.
        var regions = new (int Offset, int Length)[columns.Length, 5];
        var position = 0;
        for (var c = 0; c < columns.Length; c++)
        {
            var column = columns[c];
            regions[c, 0] = Place(ref position, Any(column.Nulls, rows) ? bitmapBytes : -1);
            regions[c, 1] = Place(ref position, 4 * (rows + 1));
            regions[c, 2] = Place(ref position, column.Length);
            regions[c, 3] = Place(ref position, Any(column.Truncated, rows) ? bitmapBytes : -1);
            regions[c, 4] = Place(ref position, Any(column.Errors, rows) ? bitmapBytes : -1);
        }
        header.ResetWrittenCount();
        var writer = new MsgPackWriter(header);
        writer.WriteArrayHeader(7);
        writer.WriteInt64(FormatVersion);
        writer.WriteInt64(ResultId);
        writer.WriteInt64(FirstRow);
        writer.WriteInt64(rows);
        writer.WriteArrayHeader(columns.Length);
        for (var c = 0; c < columns.Length; c++)
        {
            writer.WriteArrayHeader(11);
            writer.WriteInt64((long)columns[c].Wire);
            for (var r = 0; r < 5; r++)
            {
                writer.WriteInt64(regions[c, r].Offset);
                writer.WriteInt64(regions[c, r].Length);
            }
        }
        // bin8 pad header (2 bytes) + pad + bin32 header (5 bytes) end 8-aligned, so the blob's u32 offsets can be
        // viewed in place by the decoder.
        var pad = (8 - (header.WrittenCount + 7) % 8) % 8;
        writer.WriteBinaryHeader(pad);
        writer.WriteRaw(Zeros.AsSpan(0, pad));
        writer.WriteBinaryHeader(position, bin32: true);
        var page = GC.AllocateUninitializedArray<byte>(header.WrittenCount + position);
        header.WrittenSpan.CopyTo(page);
        var blob = page.AsSpan(header.WrittenCount);
        var end = 0;
        for (var c = 0; c < columns.Length; c++)
        {
            var column = columns[c];
            for (var r = 0; r < 5; r++)
            {
                var (offset, length) = regions[c, r];
                if (r != 1 && r != 2 && length == 0) continue;
                blob[end..offset].Clear();
                var region = blob.Slice(offset, length);
                end = offset + length;
                switch (r)
                {
                    case 0:
                        // Validity is the inverted NULL bitmap; bits past the last row stay zero.
                        for (var i = 0; i < bitmapBytes; i++) region[i] = (byte)~column.Nulls![i];
                        if (rows % 8 != 0) region[^1] &= (byte)((1 << (rows % 8)) - 1);
                        break;
                    case 1:
                        BinaryPrimitives.WriteUInt32LittleEndian(region, 0);
                        for (var row = 1; row <= rows; row++) BinaryPrimitives.WriteUInt32LittleEndian(region[(4 * row)..], column.Offsets[row]);
                        break;
                    case 2: column.Data.AsSpan(0, length).CopyTo(region); break;
                    case 3: column.Truncated.AsSpan(0, length).CopyTo(region); break;
                    default: column.Errors.AsSpan(0, length).CopyTo(region); break;
                }
            }
        }
        Reset();
        return page;
    }

    private static (int Offset, int Length) Place(ref int position, int length)
    {
        if (length < 0) return (0, 0);
        position = (position + 7) & ~7;
        var offset = position;
        position += length;
        return (offset, length);
    }

    private void Reset()
    {
        FirstRow += rows;
        var bitmapBytes = (rows + 7) / 8;
        foreach (var column in columns)
        {
            column.Length = 0;
            column.Nulls?.AsSpan(0, bitmapBytes).Clear();
            column.Truncated?.AsSpan(0, bitmapBytes).Clear();
            column.Errors?.AsSpan(0, bitmapBytes).Clear();
        }
        rows = 0;
        dataBytes = 0;
    }
}
