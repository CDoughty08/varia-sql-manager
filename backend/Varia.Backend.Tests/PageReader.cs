using System.Buffers.Binary;
using System.Text;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

internal sealed class PageFormatException(string code) : Exception("Invalid result page: " + code)
{
    public string Code { get; } = code;
}

/// <summary>A cell's display text (null for NULL) and flags: 1 NULL, 2 truncated, 4 read error.</summary>
internal sealed record PageCell(string? Text, int Flags);
internal sealed record DecodedPage(uint ResultId, long FirstRow, PageCell[][] Rows);

/// <summary>A test-only page decoder, written independently of PageBuilder and with the same checks and error codes as
/// decodePage in src/shared/ipc/wire/pages.ts.</summary>
internal static class PageReader
{
    public const int Null = 1, Truncated = 2, Error = 4;

    public static DecodedPage Read(ReadOnlySpan<byte> body, IReadOnlyList<WireKind> wires)
    {
        var reader = new MsgPackReader(body);
        uint resultId;
        long firstRow;
        int rowCount, dataStart;
        long blobLength;
        var chunks = new List<(WireKind Wire, long[] Regions)>();
        try
        {
            if (reader.ReadArrayHeader() != 7) throw new PageFormatException("HEADER");
            if (reader.ReadUInt64() != 1) throw new PageFormatException("VERSION");
            var id = reader.ReadUInt64();
            if (id is < 1 or > uint.MaxValue) throw new PageFormatException("HEADER");
            resultId = (uint)id;
            firstRow = (long)reader.ReadUInt64();
            var rows = reader.ReadUInt64();
            if (rows is < 1 or > PageBuilder.MaxRows) throw new PageFormatException("ROWS");
            rowCount = (int)rows;
            var count = reader.ReadArrayHeader();
            if (count is < 1 or > PageBuilder.MaxColumns || count != wires.Count) throw new PageFormatException("COLUMNS");
            for (var i = 0; i < count; i++)
            {
                if (reader.ReadArrayHeader() != 11) throw new PageFormatException("HEADER");
                var wire = reader.ReadUInt64() switch { 1 => WireKind.Text, 2 => WireKind.Binary, _ => (WireKind)0 };
                if (wire == 0 || wire != wires[i]) throw new PageFormatException("WIRE");
                var regions = new long[10];
                for (var r = 0; r < 10; r++) regions[r] = (long)reader.ReadUInt64();
                chunks.Add((wire, regions));
            }
            var pad = reader.ReadBinary();
            if (pad.Length > 7 || pad.ContainsAnyExcept((byte)0)) throw new PageFormatException("PAD");
            if (reader.PeekByte() != 0xc6) throw new PageFormatException("HEADER");
            blobLength = reader.ReadBinaryHeader();
            dataStart = reader.Consumed;
        }
        catch (ProtocolException) { throw new PageFormatException("HEADER"); }
        if (dataStart % 8 != 0) throw new PageFormatException("ALIGN");
        if (dataStart + blobLength != body.Length) throw new PageFormatException(dataStart + blobLength > body.Length ? "BOUNDS" : "TRAILING");
        var blob = body.Slice(dataStart);
        var bitmapBytes = (rowCount + 7) / 8;
        var cells = new PageCell[rowCount][];
        for (var row = 0; row < rowCount; row++) cells[row] = new PageCell[chunks.Count];
        for (var c = 0; c < chunks.Count; c++)
        {
            var (wire, regions) = chunks[c];
            for (var r = 0; r < 10; r += 2) if (regions[r] + regions[r + 1] > blobLength) throw new PageFormatException("BOUNDS");
            var validity = Bitmap(blob, regions[0], regions[1], bitmapBytes, rowCount);
            var truncated = Bitmap(blob, regions[6], regions[7], bitmapBytes, rowCount);
            var errors = Bitmap(blob, regions[8], regions[9], bitmapBytes, rowCount);
            if (regions[3] != 4L * (rowCount + 1)) throw new PageFormatException("OFFSETS");
            if (regions[2] % 8 != 0) throw new PageFormatException("ALIGN");
            var offsets = blob.Slice((int)regions[2], (int)regions[3]);
            var data = blob.Slice((int)regions[4], (int)regions[5]);
            if (Offset(offsets, 0) != 0 || Offset(offsets, rowCount) != regions[5]) throw new PageFormatException("OFFSETS");
            for (var row = 0; row < rowCount; row++)
            {
                var (start, end) = (Offset(offsets, row), Offset(offsets, row + 1));
                if (end < start) throw new PageFormatException("OFFSETS");
                var valid = validity is null || Bit(validity, row);
                if (!valid && end != start) throw new PageFormatException("NULL_SPAN");
                if (truncated is not null && Bit(truncated, row) && !valid || errors is not null && Bit(errors, row) && valid) throw new PageFormatException("FLAGS");
            }
            for (var row = 0; row < rowCount; row++)
            {
                var span = data[(int)Offset(offsets, row)..(int)Offset(offsets, row + 1)];
                var valid = validity is null || Bit(validity, row);
                var text = !valid ? null : wire == WireKind.Text ? Encoding.UTF8.GetString(span) : "0x" + Convert.ToHexString(span);
                cells[row][c] = new(text, (valid ? 0 : Null) | (truncated is not null && Bit(truncated, row) ? Truncated : 0) | (errors is not null && Bit(errors, row) ? Error : 0));
            }
        }
        return new(resultId, firstRow, cells);
    }

    private static uint Offset(ReadOnlySpan<byte> offsets, int row) => BinaryPrimitives.ReadUInt32LittleEndian(offsets[(4 * row)..]);

    private static bool Bit(byte[] bitmap, int row) => (bitmap[row >> 3] & (1 << (row & 7))) != 0;

    private static byte[]? Bitmap(ReadOnlySpan<byte> blob, long offset, long length, int expected, int rows)
    {
        if (length == 0) return offset == 0 ? null : throw new PageFormatException("BITMAP");
        if (length != expected) throw new PageFormatException("BITMAP");
        var bitmap = blob.Slice((int)offset, (int)length).ToArray();
        if (rows % 8 != 0 && bitmap[^1] >> (rows % 8) != 0) throw new PageFormatException("BITMAP");
        return bitmap;
    }
}

/// <summary>Repository files for the checks, found by walking up to the solution file.</summary>
internal static class Fixtures
{
    private static readonly Lazy<string> Root = new(() =>
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
            if (File.Exists(System.IO.Path.Combine(directory.FullName, "Varia.SqlManager.slnx"))) return directory.FullName;
        throw new InvalidOperationException("Varia.SqlManager.slnx was not found above " + AppContext.BaseDirectory);
    });

    public static string Path(string relative) => System.IO.Path.Combine(Root.Value, relative);

    /// <summary>VARIA_UPDATE_GOLDEN=1 rewrites golden files instead of comparing against them.</summary>
    public static bool Update => Environment.GetEnvironmentVariable("VARIA_UPDATE_GOLDEN") == "1";
}
