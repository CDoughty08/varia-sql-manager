using System.Buffers;
using System.Runtime.InteropServices;
using Varia.Backend.Protocol;

namespace Varia.Backend.Results;

/// <summary>The lengths form a page takes inside the codec (docs/page-compression-findings.md, "Lengths form"): the
/// sealed page with each column's u32 offsets replaced by its cells' lengths, one LEB128 for a column whose every
/// non-NULL cell is one length, else each cell's LEB128, and the zero padding between regions dropped. Zstandard packs
/// a page's ascending offsets poorly and its lengths well, so the same budget holds more rows. Unpacking rebuilds the
/// page as sealed in its own room: the form is unpacked into the room's tail and expanded forward, which is safe
/// because no region's form is longer than the region (<see cref="ToLengths"/> keeps a page as sealed otherwise), so the
/// bytes written never reach the bytes still to read. Readers only ever see pages as sealed. Offsets are read and written
/// as native u32s: every platform the backend runs on is little-endian, as the page format is.</summary>
internal static partial class PageCodec
{
    /// <summary>The packed bytes' first byte: what the Zstandard frame after its LEB128 length holds.</summary>
    private const byte AsSealed = 0, AsLengths = 1;
    /// <summary>A column's lengths in the form: one length for every non-NULL cell (NULLs are empty), or each cell's.</summary>
    private const byte OneLength = 0, EachLength = 1;
    /// <summary>A column's header entry: its wire kind, then (offset, length) of validity, offsets, data, truncated and
    /// errors within the blob (PageBuilder.Seal; PageView reads the same).</summary>
    private const int Stride = 11;
    private const int Regions = 5;
    /// <summary>The prefix before the frames: the marker and a LEB128 length, and for a typed page two more (its values'
    /// length and the length of their frame).</summary>
    private const int MaxPrefix = 16;

    /// <summary>Writes the lengths form of <paramref name="page"/> into <paramref name="form"/> (at least the page's
    /// length) and returns its length, or -1 when the bytes are not a page this reads exactly back (anything PageBuilder
    /// did not seal: those are packed as they are). With <paramref name="typed"/>, typed columns' values go to
    /// <paramref name="values"/>, rented (the page's length) once a column has a shape.</summary>
    private static int ToLengths(ReadOnlySpan<byte> page, Span<byte> form, bool typed, ref byte[]? values, out int valuesLength)
    {
        valuesLength = 0;
        if (!ReadLayout(page, out var layout, out var blobStart, out var rows, out var columns)) return -1;
        try
        {
            var blob = page[blobStart..];
            if (!Placed(blob, layout, rows, columns)) return -1;
            page[..blobStart].CopyTo(form);
            var at = blobStart;
            for (var c = 0; c < columns; c++)
            {
                var typedColumn = false;
                for (var r = 0; r < Regions; r++)
                {
                    var (offset, length) = (layout[c * Stride + 1 + 2 * r], layout[c * Stride + 2 + 2 * r]);
                    if (r == 1)
                    {
                        var validity = layout[c * Stride + 2] == 0 ? default : blob.Slice(layout[c * Stride + 1], layout[c * Stride + 2]);
                        var columnValues = 0;
                        var written = typed && layout[c * Stride] == (int)WireKind.Text
                            ? WriteTyped(blob.Slice(offset, length), blob.Slice(layout[c * Stride + 5], layout[c * Stride + 6]), validity, rows, form[at..], ref values, valuesLength, page.Length, out columnValues)
                            : -1;
                        typedColumn = written >= 0;
                        if (typedColumn) valuesLength += columnValues;
                        if (!typedColumn) written = WriteLengths(blob.Slice(offset, length), validity, layout[c * Stride + 6], rows, form[at..]);
                        if (written < 0) return -1;
                        at += written;
                    }
                    else if (r == 2 && typedColumn) { }
                    else if (length > 0)
                    {
                        blob.Slice(offset, length).CopyTo(form[at..]);
                        at += length;
                    }
                }
            }
            return at;
        }
        finally { ArrayPool<int>.Shared.Return(layout); }
    }

    /// <summary>A column's lengths from its offsets, or -1 when its offsets do not run from 0 up to its data's length or
    /// its form would be longer than its offsets (which in-place expansion needs, and pages never come close to).</summary>
    private static int WriteLengths(ReadOnlySpan<byte> offsetBytes, ReadOnlySpan<byte> validity, int dataLength, int rows, Span<byte> form)
    {
        var offsets = MemoryMarshal.Cast<byte, uint>(offsetBytes)[..(rows + 1)];
        if (offsets[0] != 0) return -1;
        uint previous = 0, one = 0;
        bool seen = false, uniform = true;
        for (var row = 0; row < rows; row++)
        {
            var end = offsets[row + 1];
            if (end < previous) return -1;
            var length = end - previous;
            previous = end;
            if (!validity.IsEmpty && (validity[row >> 3] & (1 << (row & 7))) == 0) uniform &= length == 0;
            else if (!seen) (one, seen) = (length, true);
            else uniform &= length == one;
        }
        if (previous != (uint)dataLength) return -1;
        var at = 0;
        if (uniform)
        {
            form[at++] = OneLength;
            WriteLeb(form, ref at, one);
            return at;
        }
        form[at++] = EachLength;
        var limit = Math.Min(offsetBytes.Length, form.Length);
        for (var row = 0; row < rows; row++)
        {
            if (at + 5 > limit) return -1;
            var length = offsets[row + 1] - offsets[row];
            if (length < 0x80) form[at++] = (byte)length;
            else WriteLeb(form, ref at, length);
        }
        return at;
    }

    /// <summary>Rebuilds the page as sealed in <paramref name="room"/> from its lengths form, which fills the room's tail
    /// from <paramref name="at"/>.</summary>
    private static void FromLengths(Span<byte> room, int at, ReadOnlySpan<byte> values = default)
    {
        if (!ReadLayout(room[at..], out var layout, out var blobStart, out var rows, out var columns, room.Length)) throw Unreadable();
        var lengthsRoom = ArrayPool<uint>.Shared.Rent(rows);
        try
        {
            room.Slice(at, blobStart).CopyTo(room);
            var read = at + blobStart;
            var written = blobStart;
            var valuesAt = 0;
            var lengths = lengthsRoom.AsSpan(0, rows);
            var bitmap = (rows + 7) / 8;
            for (var c = 0; c < columns; c++)
            {
                var typedColumn = false;
                for (var r = 0; r < Regions; r++)
                {
                    var (offset, length) = (blobStart + (long)layout[c * Stride + 1 + 2 * r], layout[c * Stride + 2 + 2 * r]);
                    if (r == 1 ? length != 4 * (rows + 1) : r != 2 && length != 0 && length != bitmap) throw Unreadable();
                    if (Skipped(r, length)) continue;
                    if (offset < written || (offset > read && !(r == 2 && typedColumn)) || offset + length > room.Length) throw Unreadable();
                    room[written..(int)offset].Clear();
                    if (r == 1 && !values.IsEmpty && read < room.Length && room[read] >= TypedInteger)
                    {
                        // A typed column writes its offsets and its text at once, after reading its whole form.
                        var validity = layout[c * Stride + 2] == 0 ? default : room.Slice(blobStart + layout[c * Stride + 1], layout[c * Stride + 2]);
                        var data = blobStart + (long)layout[c * Stride + 5];
                        var dataLength = layout[c * Stride + 6];
                        if (data < offset + length || data + dataLength > room.Length) throw Unreadable();
                        read += ReadTyped(room[read..], values, ref valuesAt, validity, rows, room.Slice((int)offset, length), room.Slice((int)data, dataLength));
                        if (data + dataLength > read) throw Unreadable();
                        room[(int)(offset + length)..(int)data].Clear();
                        typedColumn = true;
                    }
                    else if (r == 2 && typedColumn) { }
                    else if (r == 1)
                    {
                        // The whole column's form is read before its offsets are written over it. Its validity bitmap
                        // precedes its offsets, so it is already in place.
                        var validity = layout[c * Stride + 2] == 0 ? default : room.Slice(blobStart + layout[c * Stride + 1], layout[c * Stride + 2]);
                        if (read >= room.Length) throw Unreadable();
                        read += ReadLengths(room[read..], validity, lengths);
                        // A form Pack wrote never needs its offsets written past the bytes read so far.
                        if (offset + length > read) throw Unreadable();
                        var offsets = MemoryMarshal.Cast<byte, uint>(room.Slice((int)offset, length));
                        ulong end = 0;
                        offsets[0] = 0;
                        for (var row = 0; row < lengths.Length; row++) offsets[row + 1] = (uint)(end += lengths[row]);
                        if (end != (ulong)layout[c * Stride + 6]) throw Unreadable();
                    }
                    else
                    {
                        if (length > room.Length - read) throw Unreadable();
                        room.Slice(read, length).CopyTo(room.Slice((int)offset, length));
                        read += length;
                    }
                    written = (int)offset + length;
                }
            }
            if (read != room.Length || written != room.Length || valuesAt != values.Length) throw Unreadable();
        }
        finally
        {
            ArrayPool<uint>.Shared.Return(lengthsRoom);
            ArrayPool<int>.Shared.Return(layout);
        }
    }

    /// <summary>A column's cell lengths from its form; returns the form's length.</summary>
    private static int ReadLengths(ReadOnlySpan<byte> form, ReadOnlySpan<byte> validity, Span<uint> lengths)
    {
        var at = 1;
        if (form[0] == OneLength)
        {
            var one = ReadLeb(form, ref at);
            if (validity.IsEmpty) lengths.Fill(one);
            else for (var row = 0; row < lengths.Length; row++) lengths[row] = (validity[row >> 3] & (1 << (row & 7))) == 0 ? 0 : one;
            return at;
        }
        if (form[0] != EachLength) throw Unreadable();
        for (var row = 0; row < lengths.Length; row++)
        {
            if (at < form.Length && form[at] < 0x80) lengths[row] = form[at++];
            else lengths[row] = ReadLeb(form, ref at);
        }
        return at;
    }

    /// <summary>The page's header: its row and column counts and each column's regions (in a pooled array the caller
    /// returns when this is true), and where its blob starts. False for bytes that are not a sealed page of
    /// <paramref name="total"/> bytes (the page's own length when 0).</summary>
    private static bool ReadLayout(ReadOnlySpan<byte> page, out int[] layout, out int blobStart, out int rows, out int columns, int total = 0)
    {
        (layout, blobStart, rows, columns) = ([], 0, 0, 0);
        if (page.IsEmpty || page[0] != 0x97) return false;
        var rented = false;
        try
        {
            var reader = new MsgPackReader(page);
            reader.ReadArrayHeader();
            if (reader.ReadInt64() != PageBuilder.FormatVersion) return false;
            reader.ReadInt64();
            reader.ReadInt64();
            var rowCount = reader.ReadInt64();
            var columnCount = reader.ReadArrayHeader();
            if (rowCount is < 1 or > PageBuilder.MaxRows || columnCount > PageBuilder.MaxColumns) return false;
            layout = ArrayPool<int>.Shared.Rent(Math.Max(1, (int)columnCount * Stride));
            rented = true;
            for (var c = 0; c < columnCount; c++)
            {
                if (reader.ReadArrayHeader() != Stride) return Fail(ref layout);
                for (var i = 0; i < Stride; i++)
                {
                    var value = reader.ReadInt64();
                    if (value is < 0 or > int.MaxValue) return Fail(ref layout);
                    layout[c * Stride + i] = (int)value;
                }
            }
            reader.ReadBinary();
            var blobLength = reader.ReadBinaryHeader();
            blobStart = reader.Consumed;
            (rows, columns) = ((int)rowCount, (int)columnCount);
            return blobLength == (total == 0 ? page.Length : total) - (long)blobStart || Fail(ref layout);
        }
        catch (ProtocolException) { return rented && Fail(ref layout); }
    }

    private static bool Fail(ref int[] layout)
    {
        ArrayPool<int>.Shared.Return(layout);
        layout = [];
        return false;
    }

    /// <summary>Whether the blob is exactly its regions in order with zero padding between them, which the form drops
    /// and expansion restores, and every bitmap and offsets region has its page's size.</summary>
    private static bool Placed(ReadOnlySpan<byte> blob, int[] layout, int rows, int columns)
    {
        var end = 0;
        var bitmap = (rows + 7) / 8;
        for (var c = 0; c < columns; c++)
            for (var r = 0; r < Regions; r++)
            {
                var (offset, length) = (layout[c * Stride + 1 + 2 * r], layout[c * Stride + 2 + 2 * r]);
                if (r == 1 ? length != 4 * (rows + 1) : r != 2 && length != 0 && length != bitmap) return false;
                if (Skipped(r, length)) continue;
                if (offset < end || (long)offset + length > blob.Length || blob[end..offset].ContainsAnyExcept((byte)0)) return false;
                end = offset + length;
            }
        return end == blob.Length;
    }

    /// <summary>Whether a region has no place in the blob: an empty validity, truncated or errors bitmap. Seal places
    /// every offsets and data region, an empty data region too (8-aligned after its offsets, so a page whose last column
    /// holds no data can end in padding after the offsets).</summary>
    private static bool Skipped(int region, int length) => region is not (1 or 2) && length == 0;

    private static void WriteLeb(Span<byte> to, ref int at, uint value)
    {
        for (; value >= 0x80; value >>= 7) to[at++] = (byte)(value | 0x80);
        to[at++] = (byte)value;
    }

    private static uint ReadLeb(ReadOnlySpan<byte> from, ref int at)
    {
        uint value = 0;
        for (var shift = 0; shift < 35 && at < from.Length; shift += 7)
        {
            var b = from[at++];
            value |= (uint)(b & 0x7F) << shift;
            if (b < 0x80) return value;
        }
        throw Unreadable();
    }

    private static InvalidDataException Unreadable() => new("A packed result page could not be read.");
}
