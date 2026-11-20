using System.Buffers;
using System.IO.Compression;
using System.Text;

namespace Varia.Backend.Search;

/// <summary>
/// A long definition as one zstd frame of its UTF-8 text: about a seventh of the UTF-16 string on real module definitions. Each
/// distinct definition is its own frame, and the same text always packs to the same bytes, so the <see cref="StringPool"/> still
/// holds a definition every database and connection shares once, and a preview unpacks only its own text. Equal by content.
/// Definitions shorter than <see cref="MinChars"/> (a default's ((0)), most computed columns) stay strings: a frame's overhead
/// would eat most of the gain, and they are the ones many objects share.
/// </summary>
internal sealed class PackedText : IEquatable<PackedText>
{
    /// <summary>The shortest definition packed.</summary>
    public const int MinChars = 512;
    /// <summary>zstd's level: 3 (its default) packs a module about as well as 9 at a fraction of the time.</summary>
    private const int Level = 3;

    private readonly byte[] frame;
    private readonly int hash;

    private PackedText(byte[] frame, int length, int byteLength)
    {
        this.frame = frame;
        Length = length;
        ByteLength = byteLength;
        var code = new HashCode();
        code.AddBytes(frame);
        hash = code.ToHashCode();
    }

    /// <summary>The text's length in UTF-16 code units.</summary>
    public int Length { get; }
    /// <summary>The text's length in UTF-8 bytes (what the frame unpacks to).</summary>
    public int ByteLength { get; }
    /// <summary>The frame's size.</summary>
    public int FrameLength => frame.Length;

    /// <summary>What the packed text costs the budget: the object (header, frame reference, lengths, hash) and its frame.</summary>
    public long Bytes => 40 + ((24L + frame.Length + 7) & ~7L);

    /// <summary>Whether a definition of <paramref name="length"/> characters is packed.</summary>
    public static bool Packs(int length) => length >= MinChars;

    public static PackedText Pack(ReadOnlySpan<char> text)
    {
        var count = Encoding.UTF8.GetByteCount(text);
        var utf8 = ArrayPool<byte>.Shared.Rent(count);
        var room = ArrayPool<byte>.Shared.Rent((int)ZstandardEncoder.GetMaxCompressedLength(count));
        try
        {
            var written = Encoding.UTF8.GetBytes(text, utf8);
            if (!ZstandardEncoder.TryCompress(utf8.AsSpan(0, written), room, out var packed, Level, 0)) throw new InvalidOperationException("A definition did not pack.");
            return new PackedText(room.AsSpan(0, packed).ToArray(), text.Length, written);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(utf8);
            ArrayPool<byte>.Shared.Return(room);
        }
    }

    /// <summary>The text, unpacked into <paramref name="scratch"/>'s buffers (grown as needed): valid until the scratch is used again.</summary>
    public ReadOnlySpan<char> Unpack(Scratch scratch)
    {
        var bytes = scratch.Bytes(ByteLength);
        if (!ZstandardDecoder.TryDecompress(frame, bytes, out var written) || written != ByteLength) throw new InvalidDataException("A packed definition did not unpack.");
        var chars = scratch.Chars(Length);
        var decoded = Encoding.UTF8.GetChars(bytes.AsSpan(0, written), chars);
        return chars.AsSpan(0, decoded);
    }

    /// <summary>The text as a string (checks and records; a search unpacks into a <see cref="Scratch"/> instead).</summary>
    public override string ToString() => new(Unpack(new Scratch()));

    public bool Equals(PackedText? other) =>
        other is not null && (ReferenceEquals(this, other) || hash == other.hash && Length == other.Length && frame.AsSpan().SequenceEqual(other.frame));

    public override bool Equals(object? obj) => Equals(obj as PackedText);
    public override int GetHashCode() => hash;

    /// <summary>The buffers one search (one thread) unpacks definitions into, reused from one definition to the next.</summary>
    internal sealed class Scratch
    {
        private byte[] bytes = [];
        private char[] chars = [];

        public byte[] Bytes(int length) => bytes.Length >= length ? bytes : bytes = new byte[Math.Max(length, Math.Min(2 * bytes.Length, Array.MaxLength))];
        public char[] Chars(int length) => chars.Length >= length ? chars : chars = new char[Math.Max(length, Math.Min(2 * chars.Length, Array.MaxLength))];
    }
}

/// <summary>A definition as the index holds it: a string, or a <see cref="PackedText"/> for a long one.</summary>
internal static class DefinitionText
{
    /// <summary>The text of <paramref name="stored"/> (a string or a packed text), unpacking into <paramref name="scratch"/>.</summary>
    public static ReadOnlySpan<char> Read(object stored, PackedText.Scratch scratch) => stored is string text ? text : ((PackedText)stored).Unpack(scratch);

    /// <summary>A stored text's length in characters.</summary>
    public static int Length(object stored) => stored is string text ? text.Length : ((PackedText)stored).Length;

    /// <summary>The stored text as a string.</summary>
    public static string ToText(object stored) => stored as string ?? stored.ToString()!;

    /// <summary>The form the index holds <paramref name="text"/> in: packed when it is long enough, else the string.</summary>
    public static object Hold(string text) => PackedText.Packs(text.Length) ? PackedText.Pack(text) : text;
}
