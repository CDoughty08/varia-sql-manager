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

/// <summary>Zstandard at level 2 with a 256 KiB window (one page), one page at a time, over the page's lengths form
/// (PageCodec.Lengths.cs): the codec and settings measured in docs/page-compression-findings.md. Pure functions; the
/// store decides what is packed.</summary>
internal static partial class PageCodec
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
    /// context per call), streamed so its working memory does not change with the page's size (<see cref="Stream"/>).</param>
    public static byte[]? Pack(ReadOnlySpan<byte> page, Action<bool>? quiet = null)
    {
        var need = (int)ZstandardEncoder.GetMaxCompressedLength(page.Length) + MaxPrefix;
        // A page's worst case is above the large object heap's threshold, so the rooms are pooled (bounded per core by the
        // shared pool) rather than allocated per page or kept on every thread that ever packs.
        var room = ArrayPool<byte>.Shared.Rent(need);
        var form = ArrayPool<byte>.Shared.Rent(Math.Max(1, page.Length));
        try
        {
            var formLength = ToLengths(page, form);
            var source = formLength < 0 ? page : form.AsSpan(0, formLength);
            // Made (and warmed in the room) before the prefix is written there.
            var encoder = quiet is null ? null : QuietEncoder(room);
            var prefix = 0;
            room[prefix++] = formLength < 0 ? AsSealed : AsLengths;
            WriteLeb(room, ref prefix, (uint)source.Length);
            if (encoder is null)
                return ZstandardEncoder.TryCompress(source, room.AsSpan(prefix), out var once, Quality, Window) ? room.AsSpan(0, prefix + once).ToArray() : null;
            encoder.Reset();
            int written;
            quiet!(true);
            try { written = Stream(encoder, source, room.AsSpan(prefix)); }
            finally { quiet(false); }
            return written < 0 ? null : room.AsSpan(0, prefix + written).ToArray();
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(form);
            ArrayPool<byte>.Shared.Return(room);
        }
    }

    /// <summary>Compresses a page as a stream of unknown length, then ends the frame: given the whole input at once with
    /// the frame's end, zstd would choose its tables from the page's size and resize its working memory when the size
    /// changes, which the policy must not do while lowered. With the length unknown every page uses the same tables (the
    /// window caps them), so the working memory made by the warm-up serves every page. Returns the bytes written, or -1
    /// when the room was too small (the page then stays raw).</summary>
    private static int Stream(ZstandardEncoder encoder, ReadOnlySpan<byte> page, Span<byte> room)
    {
        if (encoder.Compress(page, room, out var consumed, out var written, isFinalBlock: false) != OperationStatus.Done || consumed != page.Length) return -1;
        if (encoder.Compress(ReadOnlySpan<byte>.Empty, room[written..], out _, out var tail, isFinalBlock: true) != OperationStatus.Done) return -1;
        return written + tail;
    }

    /// <summary>This thread's encoder for the policy, made on first use and warmed with one window of zeros the same way
    /// pages are compressed, so its working memory exists before any compression runs lowered.</summary>
    private static ZstandardEncoder QuietEncoder(byte[] room)
    {
        if (quietEncoder is { } ready) return ready;
        var encoder = new ZstandardEncoder(Quality, Window);
        Stream(encoder, new byte[1 << Window], room);
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
        UnpackInto(packed, page);
        return page;
    }

    /// <summary>The page packed into <paramref name="packed"/> unpacked into <paramref name="room"/>, which is exactly its
    /// length as sealed: a fused read's own room, reused page after page (ViewSorter.PageRooms).</summary>
    public static void UnpackInto(byte[] packed, Span<byte> room)
    {
        if (packed.Length < 2 || packed[0] is not (AsSealed or AsLengths)) throw Unreadable();
        var prefix = 1;
        var formLength = ReadLeb(packed, ref prefix);
        if (formLength > room.Length || (packed[0] == AsSealed && formLength != room.Length)) throw Unreadable();
        var at = room.Length - (int)formLength;
        if (!ZstandardDecoder.TryDecompress(packed.AsSpan(prefix), room[at..], out var written) || written != formLength) throw Unreadable();
        if (packed[0] == AsLengths) FromLengths(room, at);
    }
}
