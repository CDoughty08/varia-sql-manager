using System.Buffers;
using System.Buffers.Binary;
using System.Text;
using System.Text.Unicode;

namespace Varia.Backend.Protocol;

/// <summary>A protocol violation. It carries a code and an offset only, never the offending bytes, which may hold SQL
/// text or a password. The codes match src/shared/ipc/wire (DecodeError, ProtocolError).</summary>
internal sealed class ProtocolException(string code, long offset) : Exception("Protocol " + code + " at offset " + offset)
{
    public string Code { get; } = code;
    public long Offset { get; } = offset;
}

internal enum MsgPackType : byte { Nil, Boolean, Integer, Float, String, Binary, Array, Map }

/// <summary>Reads the protocol's MessagePack subset: nil, booleans, integers within ±(2^53 − 1), float64, str, bin, arrays
/// and maps. c1, float32 and ext types are rejected. Lengths are checked against the remaining bytes before use;
/// container counts are returned raw so callers apply their own limits first.</summary>
internal ref struct MsgPackReader(ReadOnlySpan<byte> data)
{
    public const long MaxSafeInteger = 9_007_199_254_740_991;
    private readonly ReadOnlySpan<byte> data = data;
    private int position;

    public readonly int Consumed => position;
    public readonly int Remaining => data.Length - position;

    private readonly void Need(long bytes, int at)
    {
        if (bytes > data.Length - position) throw new ProtocolException("TRUNCATED", at);
    }

    public readonly byte PeekByte()
    {
        Need(1, position);
        return data[position];
    }

    public readonly MsgPackType PeekType() => PeekByte() switch
    {
        <= 0x7f or >= 0xe0 or (>= 0xcc and <= 0xd3) => MsgPackType.Integer,
        <= 0x8f or 0xde or 0xdf => MsgPackType.Map,
        <= 0x9f or 0xdc or 0xdd => MsgPackType.Array,
        <= 0xbf or 0xd9 or 0xda or 0xdb => MsgPackType.String,
        0xc0 => MsgPackType.Nil,
        0xc2 or 0xc3 => MsgPackType.Boolean,
        0xc4 or 0xc5 or 0xc6 => MsgPackType.Binary,
        0xcb => MsgPackType.Float,
        _ => throw new ProtocolException("TYPE", position)
    };

    private byte Byte()
    {
        Need(1, position);
        return data[position++];
    }

    private ushort UInt16(int at)
    {
        Need(2, at);
        var value = BinaryPrimitives.ReadUInt16BigEndian(data[position..]);
        position += 2;
        return value;
    }

    private uint UInt32(int at)
    {
        Need(4, at);
        var value = BinaryPrimitives.ReadUInt32BigEndian(data[position..]);
        position += 4;
        return value;
    }

    private ulong UInt64(int at)
    {
        Need(8, at);
        var value = BinaryPrimitives.ReadUInt64BigEndian(data[position..]);
        position += 8;
        return value;
    }

    public void ReadNil()
    {
        var at = position;
        if (Byte() != 0xc0) throw new ProtocolException("TYPE", at);
    }

    public bool ReadBoolean()
    {
        var at = position;
        return Byte() switch { 0xc2 => false, 0xc3 => true, _ => throw new ProtocolException("TYPE", at) };
    }

    /// <summary>Any integer format; the value must be within ±(2^53 − 1).</summary>
    public long ReadInt64()
    {
        var at = position;
        var tag = Byte();
        long value = tag switch
        {
            <= 0x7f => tag,
            >= 0xe0 => (sbyte)tag,
            0xcc => Byte(),
            0xcd => UInt16(at),
            0xce => UInt32(at),
            0xcf => UInt64(at) is var unsigned && unsigned <= MaxSafeInteger ? (long)unsigned : throw new ProtocolException("NUMBER", at),
            0xd0 => (sbyte)Byte(),
            0xd1 => (short)UInt16(at),
            0xd2 => (int)UInt32(at),
            0xd3 => (long)UInt64(at),
            _ => throw new ProtocolException("TYPE", at)
        };
        if (value is > MaxSafeInteger or < -MaxSafeInteger) throw new ProtocolException("NUMBER", at);
        return value;
    }

    /// <summary>Any integer format holding a value in 0..2^53 − 1.</summary>
    public ulong ReadUInt64()
    {
        var at = position;
        var value = ReadInt64();
        return value >= 0 ? (ulong)value : throw new ProtocolException("NUMBER", at);
    }

    /// <summary>A finite float64.</summary>
    public double ReadDouble()
    {
        var at = position;
        if (Byte() != 0xcb) throw new ProtocolException("TYPE", at);
        var value = BitConverter.Int64BitsToDouble((long)UInt64(at));
        return double.IsFinite(value) ? value : throw new ProtocolException("NUMBER", at);
    }

    /// <summary>The byte length from a str header; the payload is read with <see cref="ReadUtf8Payload"/>.</summary>
    public uint ReadStringHeader()
    {
        var at = position;
        var tag = Byte();
        return tag switch
        {
            >= 0xa0 and <= 0xbf => (uint)(tag & 0x1f),
            0xd9 => Byte(),
            0xda => UInt16(at),
            0xdb => UInt32(at),
            _ => throw new ProtocolException("TYPE", at)
        };
    }

    /// <summary>A str payload, validated as strict UTF-8 (no overlong forms, surrogates or truncated sequences).</summary>
    public ReadOnlySpan<byte> ReadUtf8Payload(uint length, int at)
    {
        Need(length, at);
        var value = data.Slice(position, (int)length);
        if (!Utf8.IsValid(value)) throw new ProtocolException("UTF8", at);
        position += (int)length;
        return value;
    }

    public ReadOnlySpan<byte> ReadStringUtf8()
    {
        var at = position;
        return ReadUtf8Payload(ReadStringHeader(), at);
    }

    public string ReadString() => Encoding.UTF8.GetString(ReadStringUtf8());

    public uint ReadBinaryHeader()
    {
        var at = position;
        return Byte() switch
        {
            0xc4 => Byte(),
            0xc5 => UInt16(at),
            0xc6 => UInt32(at),
            _ => throw new ProtocolException("TYPE", at)
        };
    }

    public ReadOnlySpan<byte> ReadBinary()
    {
        var at = position;
        var length = ReadBinaryHeader();
        Need(length, at);
        var value = data.Slice(position, (int)length);
        position += (int)length;
        return value;
    }

    /// <summary>The element count, unchecked against the remaining bytes.</summary>
    public uint ReadArrayHeader()
    {
        var at = position;
        var tag = Byte();
        return tag switch
        {
            >= 0x90 and <= 0x9f => (uint)(tag & 0x0f),
            0xdc => UInt16(at),
            0xdd => UInt32(at),
            _ => throw new ProtocolException("TYPE", at)
        };
    }

    /// <summary>The entry count, unchecked against the remaining bytes.</summary>
    public uint ReadMapHeader()
    {
        var at = position;
        var tag = Byte();
        return tag switch
        {
            >= 0x80 and <= 0x8f => (uint)(tag & 0x0f),
            0xde => UInt16(at),
            0xdf => UInt32(at),
            _ => throw new ProtocolException("TYPE", at)
        };
    }

    /// <summary>Checks that <paramref name="count"/> items of at least <paramref name="minimumBytes"/> each can follow.</summary>
    public readonly void EnsureItems(uint count, int minimumBytes, int at) => Need((long)count * minimumBytes, at);

    /// <summary>Skips one value of any supported type without recursion.</summary>
    public void Skip()
    {
        long pending = 1;
        while (pending-- > 0)
        {
            var at = position;
            switch (PeekType())
            {
                case MsgPackType.Nil: ReadNil(); break;
                case MsgPackType.Boolean: ReadBoolean(); break;
                case MsgPackType.Integer: ReadInt64(); break;
                case MsgPackType.Float: ReadDouble(); break;
                case MsgPackType.String: ReadStringUtf8(); break;
                case MsgPackType.Binary: ReadBinary(); break;
                case MsgPackType.Array:
                    var items = ReadArrayHeader();
                    EnsureItems(items, 1, at);
                    pending += items;
                    break;
                case MsgPackType.Map:
                    var entries = ReadMapHeader();
                    EnsureItems(entries, 2, at);
                    pending += 2L * entries;
                    break;
            }
        }
    }
}

/// <summary>Writes the subset canonically: the smallest form, with non-negative integers in the unsigned family, so its
/// bytes equal those of the TypeScript MsgPackWriter.</summary>
internal readonly struct MsgPackWriter(IBufferWriter<byte> output)
{
    public void WriteNil() => WriteByte(0xc0);
    public void WriteBoolean(bool value) => WriteByte(value ? (byte)0xc3 : (byte)0xc2);

    private void WriteByte(byte value)
    {
        output.GetSpan(1)[0] = value;
        output.Advance(1);
    }

    private void WriteTagged(byte tag, int bytes, ulong value)
    {
        var span = output.GetSpan(1 + bytes);
        span[0] = tag;
        switch (bytes)
        {
            case 1: span[1] = (byte)value; break;
            case 2: BinaryPrimitives.WriteUInt16BigEndian(span[1..], (ushort)value); break;
            case 4: BinaryPrimitives.WriteUInt32BigEndian(span[1..], (uint)value); break;
            default: BinaryPrimitives.WriteUInt64BigEndian(span[1..], value); break;
        }
        output.Advance(1 + bytes);
    }

    /// <summary>An integer within ±(2^53 − 1), the range JavaScript reads exactly.</summary>
    public void WriteInt64(long value)
    {
        if (value is > MsgPackReader.MaxSafeInteger or < -MsgPackReader.MaxSafeInteger) throw new ArgumentOutOfRangeException(nameof(value));
        if (value >= 0) WriteUInt64((ulong)value);
        else if (value >= -32) WriteByte((byte)(sbyte)value);
        else if (value >= sbyte.MinValue) WriteTagged(0xd0, 1, (byte)(sbyte)value);
        else if (value >= short.MinValue) WriteTagged(0xd1, 2, (ushort)(short)value);
        else if (value >= int.MinValue) WriteTagged(0xd2, 4, (uint)(int)value);
        else WriteTagged(0xd3, 8, (ulong)value);
    }

    public void WriteUInt64(ulong value)
    {
        if (value > MsgPackReader.MaxSafeInteger) throw new ArgumentOutOfRangeException(nameof(value));
        if (value < 0x80) WriteByte((byte)value);
        else if (value <= byte.MaxValue) WriteTagged(0xcc, 1, value);
        else if (value <= ushort.MaxValue) WriteTagged(0xcd, 2, value);
        else if (value <= uint.MaxValue) WriteTagged(0xce, 4, value);
        else WriteTagged(0xcf, 8, value);
    }

    public void WriteDouble(double value)
    {
        if (!double.IsFinite(value)) throw new ArgumentOutOfRangeException(nameof(value));
        WriteTagged(0xcb, 8, (ulong)BitConverter.DoubleToInt64Bits(value));
    }

    /// <summary>JSON semantics, as in TypeScript: an integral value within ±(2^53 − 1) as an integer (−0 as 0),
    /// anything else as float64.</summary>
    public void WriteNumber(double value)
    {
        if (Math.Floor(value) == value && Math.Abs(value) <= MsgPackReader.MaxSafeInteger) WriteInt64((long)value);
        else WriteDouble(value);
    }

    private void WriteLengthHeader(byte fix, int fixLimit, byte tag8, int length)
    {
        if (length < fixLimit) WriteByte((byte)(fix | length));
        else if (length <= byte.MaxValue) WriteTagged(tag8, 1, (ulong)length);
        else if (length <= ushort.MaxValue) WriteTagged((byte)(tag8 + 1), 2, (ulong)length);
        else WriteTagged((byte)(tag8 + 2), 4, (ulong)length);
    }

    /// <summary>Lone surrogates become U+FFFD, as TextEncoder does.</summary>
    public void WriteString(ReadOnlySpan<char> value)
    {
        var length = Encoding.UTF8.GetByteCount(value);
        WriteLengthHeader(0xa0, 32, 0xd9, length);
        var span = output.GetSpan(length);
        Encoding.UTF8.GetBytes(value, span);
        output.Advance(length);
    }

    /// <summary>A str from bytes the caller knows to be valid UTF-8.</summary>
    public void WriteStringUtf8(ReadOnlySpan<byte> utf8)
    {
        WriteLengthHeader(0xa0, 32, 0xd9, utf8.Length);
        WriteRaw(utf8);
    }

    /// <summary>A bin header; <paramref name="bin32"/> forces the 5-byte form (page data, so its payload offset is known).</summary>
    public void WriteBinaryHeader(int length, bool bin32 = false)
    {
        if (bin32 || length > ushort.MaxValue) WriteTagged(0xc6, 4, (ulong)length);
        else if (length > byte.MaxValue) WriteTagged(0xc5, 2, (ulong)length);
        else WriteTagged(0xc4, 1, (ulong)length);
    }

    public void WriteBinary(ReadOnlySpan<byte> value)
    {
        WriteBinaryHeader(value.Length);
        WriteRaw(value);
    }

    public void WriteArrayHeader(int count)
    {
        if (count < 16) WriteByte((byte)(0x90 | count));
        else if (count <= ushort.MaxValue) WriteTagged(0xdc, 2, (ulong)count);
        else WriteTagged(0xdd, 4, (ulong)count);
    }

    public void WriteMapHeader(int count)
    {
        if (count < 16) WriteByte((byte)(0x80 | count));
        else if (count <= ushort.MaxValue) WriteTagged(0xde, 2, (ulong)count);
        else WriteTagged(0xdf, 4, (ulong)count);
    }

    public void WriteRaw(ReadOnlySpan<byte> bytes)
    {
        if (bytes.IsEmpty) return;
        bytes.CopyTo(output.GetSpan(bytes.Length));
        output.Advance(bytes.Length);
    }
}
