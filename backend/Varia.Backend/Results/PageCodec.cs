using System.IO.Compression;

namespace Varia.Backend.Results;

/// <summary>How the store keeps complete results' pages (<see cref="ResultStore.Packing"/>): an internal switch, not a
/// setting. The product's store is <see cref="OnRequest"/>, and the hidden-result policy (<see cref="ResultPacker"/>)
/// decides what to pack; the checks' stores are <see cref="Off"/> unless a check chooses otherwise
/// (docs/page-compression-findings.md).</summary>
internal enum PagePacking
{
    /// <summary>Pages stay as sealed; <see cref="ResultSetBuffer.Pack"/> does nothing.</summary>
    Off,
    /// <summary><see cref="ResultSetBuffer.Pack"/> packs a complete, unpinned, unleased result's pages that save at least
    /// a tenth of their bytes. The product's mode, which the service running the hidden-result policy sets.</summary>
    OnRequest,
    /// <summary>The checks' mode: every complete result is packed at once, and again whenever its last pin or lease ends,
    /// every page whatever it saves, so every reader meets packed pages.</summary>
    EveryComplete,
}

/// <summary>Zstandard at level 2 with a 256 KiB window (one page), one page at a time: the codec and settings measured in
/// docs/page-compression-findings.md. Pure functions; the store decides what is packed.</summary>
internal static class PageCodec
{
    public const int Quality = 2;
    public const int Window = 18;

    /// <summary>A page's packed bytes, or null when Zstandard could not pack it (never expected).</summary>
    public static byte[]? Pack(ReadOnlySpan<byte> page)
    {
        var need = (int)ZstandardEncoder.GetMaxCompressedLength(page.Length);
        // A page's worst case is above the large object heap's threshold, so the room is pooled (bounded per core by the
        // shared pool) rather than allocated per page or kept on every thread that ever packs.
        var room = System.Buffers.ArrayPool<byte>.Shared.Rent(need);
        try { return ZstandardEncoder.TryCompress(page, room, out var written, Quality, Window) ? room.AsSpan(0, written).ToArray() : null; }
        finally { System.Buffers.ArrayPool<byte>.Shared.Return(room); }
    }

    /// <summary>The page packed into <paramref name="packed"/>, of <paramref name="length"/> bytes as sealed.</summary>
    public static byte[] Unpack(byte[] packed, int length)
    {
        var page = new byte[length];
        if (!ZstandardDecoder.TryDecompress(packed, page, out var written) || written != length)
            throw new InvalidDataException("A packed result page could not be read.");
        return page;
    }
}
