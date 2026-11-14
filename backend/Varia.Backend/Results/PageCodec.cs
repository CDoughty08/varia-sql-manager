using System.Buffers;
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

    /// <summary>The policy thread's own encoder (<see cref="Pack"/> with a quiet callback): one native context, created and
    /// warmed at normal priority, then reset per page, so compressing at a lowered priority allocates nothing.</summary>
    [ThreadStatic] private static ZstandardEncoder? quietEncoder;

    /// <summary>A page's packed bytes, or null when Zstandard could not pack it (never expected).</summary>
    /// <param name="quiet">Called with true just before the compressor runs and with false just after: the hidden-result
    /// policy lowers its thread's priority for the compression alone. Never while anything allocates or takes a lock a
    /// starved thread must not hold: the room is rented, the result copied and the room returned outside the window, and
    /// the compression itself runs on this thread's reused encoder (the one-shot TryCompress creates and frees a native
    /// context per call).</param>
    public static byte[]? Pack(ReadOnlySpan<byte> page, Action<bool>? quiet = null)
    {
        var need = (int)ZstandardEncoder.GetMaxCompressedLength(page.Length);
        // A page's worst case is above the large object heap's threshold, so the room is pooled (bounded per core by the
        // shared pool) rather than allocated per page or kept on every thread that ever packs.
        var room = ArrayPool<byte>.Shared.Rent(need);
        try
        {
            if (quiet is null)
                return ZstandardEncoder.TryCompress(page, room, out var once, Quality, Window) ? room.AsSpan(0, once).ToArray() : null;
            var encoder = QuietEncoder(room);
            encoder.Reset();
            OperationStatus status;
            int consumed, written;
            quiet(true);
            try { status = encoder.Compress(page, room, out consumed, out written, isFinalBlock: true); }
            finally { quiet(false); }
            return status == OperationStatus.Done && consumed == page.Length ? room.AsSpan(0, written).ToArray() : null;
        }
        finally { ArrayPool<byte>.Shared.Return(room); }
    }

    /// <summary>This thread's encoder for the policy, made on first use and warmed with one page of zeros so its working
    /// memory exists before any compression runs lowered.</summary>
    private static ZstandardEncoder QuietEncoder(byte[] room)
    {
        if (quietEncoder is { } ready) return ready;
        var encoder = new ZstandardEncoder(Quality, Window);
        encoder.Compress(new byte[1 << Window], room, out _, out _, isFinalBlock: true);
        return quietEncoder = encoder;
    }

    /// <summary>Frees this thread's policy encoder (the policy's thread, as it ends).</summary>
    public static void ReleaseQuietEncoder()
    {
        quietEncoder?.Dispose();
        quietEncoder = null;
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
