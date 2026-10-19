using System.Buffers.Binary;

namespace Varia.Backend.Protocol;

/// <summary>Protocol v2 limits shared with src/shared/ipc/wire/protocol.ts.</summary>
internal static class ProtocolLimits
{
    public const int Version = 2;
    public const int RequestBody = 4 * 1024 * 1024;
    public const int ResponseBody = 16 * 1024 * 1024;
    public const int EventBody = 256 * 1024;
    /// <summary>Essential (non-droppable) events: a result set's descriptor, whose 4,096 columns may take about 3.5 MB.</summary>
    public const int EssentialEventBody = 4 * 1024 * 1024;
}

internal enum FrameKind : byte { Hello = 1, Request = 2, Response = 3, Event = 4, Data = 5, Cancel = 6, Credit = 7, Ping = 8, Pong = 9, GoAway = 10 }

/// <summary>Which way the frames being read travel.</summary>
internal enum FrameDirection { ToBackend, ToMain }

/// <summary>The 16-byte little-endian header: magic 56 0A ("V", LF), kind, flags (0), body length, id, arg.</summary>
internal readonly record struct FrameHeader(FrameKind Kind, uint Length, uint Id, uint Arg)
{
    public const int Size = 16;
    public const byte Magic0 = 0x56;
    public const byte Magic1 = 0x0a;

    /// <summary>Kinds whose information is all in the header; every other kind has a non-empty body.</summary>
    public static bool HasEmptyBody(FrameKind kind) => kind is FrameKind.Cancel or FrameKind.Credit or FrameKind.Ping or FrameKind.Pong;

    public static bool Travels(FrameKind kind, FrameDirection direction) => direction == FrameDirection.ToBackend
        ? kind is FrameKind.Hello or FrameKind.Request or FrameKind.Cancel or FrameKind.Credit or FrameKind.Ping
        : kind is FrameKind.Hello or FrameKind.Response or FrameKind.Event or FrameKind.Data or FrameKind.Pong or FrameKind.GoAway;

    /// <summary>Validates magic, kind, direction, flags and the length rule (empty exactly for CANCEL, CREDIT, PING and
    /// PONG). The maximum body size is the reader's concern, so an oversized body can be skipped.</summary>
    public static FrameHeader Parse(ReadOnlySpan<byte> header, FrameDirection direction, long offset = 0)
    {
        if (header[0] != Magic0 || header[1] != Magic1) throw new ProtocolException(offset == 0 && header[0] == (byte)'{' ? "LEGACY" : "BAD_MAGIC", offset);
        var kind = (FrameKind)header[2];
        if (kind is < FrameKind.Hello or > FrameKind.GoAway) throw new ProtocolException("BAD_KIND", offset);
        if (!Travels(kind, direction)) throw new ProtocolException("BAD_DIRECTION", offset);
        if (header[3] != 0) throw new ProtocolException("BAD_FLAGS", offset);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(header[4..]);
        if ((length == 0) != HasEmptyBody(kind)) throw new ProtocolException("BAD_LENGTH", offset);
        return new(kind, length, BinaryPrimitives.ReadUInt32LittleEndian(header[8..]), BinaryPrimitives.ReadUInt32LittleEndian(header[12..]));
    }

    public void Write(Span<byte> destination)
    {
        destination[0] = Magic0;
        destination[1] = Magic1;
        destination[2] = (byte)Kind;
        destination[3] = 0;
        BinaryPrimitives.WriteUInt32LittleEndian(destination[4..], Length);
        BinaryPrimitives.WriteUInt32LittleEndian(destination[8..], Id);
        BinaryPrimitives.WriteUInt32LittleEndian(destination[12..], Arg);
    }
}

/// <summary>A frame read from the stream. An oversized body was skipped: <see cref="Body"/> is empty and
/// <see cref="Oversize"/> is set, so the caller can answer it and stay in sync.</summary>
internal readonly record struct Frame(FrameHeader Header, byte[] Body, bool Oversize = false);

internal static class Frames
{
    /// <summary>One array holding the header and body, for a single write.</summary>
    public static byte[] Encode(FrameKind kind, uint id, uint arg, ReadOnlySpan<byte> body)
    {
        if ((body.Length == 0) != FrameHeader.HasEmptyBody(kind)) throw new ArgumentException("Invalid frame body length for its kind.", nameof(body));
        var frame = GC.AllocateUninitializedArray<byte>(FrameHeader.Size + body.Length);
        new FrameHeader(kind, (uint)body.Length, id, arg).Write(frame);
        body.CopyTo(frame.AsSpan(FrameHeader.Size));
        return frame;
    }
}

/// <summary>Reads frames on a dedicated thread. The header is validated before the body is allocated; an oversized
/// body is drained through a 64 KiB scratch buffer.</summary>
internal sealed class FrameReader(Stream input, FrameDirection direction, int maxBody)
{
    private readonly byte[] header = new byte[FrameHeader.Size];
    private byte[]? scratch;
    private long position;

    /// <summary>Stream offset of the next frame.</summary>
    public long Position => position;

    /// <summary>The next frame, or null at a clean end of stream. A stream ending inside a frame is TRUNCATED.</summary>
    public Frame? Read()
    {
        var start = position;
        var filled = input.ReadAtLeast(header, FrameHeader.Size, throwOnEndOfStream: false);
        if (filled == 0) return null;
        if (filled < FrameHeader.Size) throw new ProtocolException("TRUNCATED", start);
        var parsed = FrameHeader.Parse(header, direction, start);
        position += FrameHeader.Size;
        if (parsed.Length > maxBody)
        {
            scratch ??= new byte[64 * 1024];
            for (var remaining = (long)parsed.Length; remaining > 0;)
            {
                var read = input.Read(scratch, 0, (int)Math.Min(scratch.Length, remaining));
                if (read == 0) throw new ProtocolException("TRUNCATED", start);
                remaining -= read;
            }
            position += parsed.Length;
            return new Frame(parsed, [], Oversize: true);
        }
        var body = parsed.Length == 0 ? [] : new byte[parsed.Length];
        if (input.ReadAtLeast(body, body.Length, throwOnEndOfStream: false) < body.Length) throw new ProtocolException("TRUNCATED", start);
        position += parsed.Length;
        return new Frame(parsed, body);
    }
}
