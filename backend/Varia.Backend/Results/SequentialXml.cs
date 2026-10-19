using System.Reflection;
using System.Text;
using System.Xml;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Results;

/// <summary>Streams an xml cell under CommandBehavior.SequentialAccess. SqlClient sends xml as UTF-16 text, and its
/// GetXmlReader there lets XmlReader guess the encoding from the first bytes: a value that does not start with '<' throws,
/// or, when both bytes of its first characters are printable (U+3441 is "A4"), reads as other text. SqlClient fixed that
/// after 7.1.1 (dotnet/SqlClient#4757); until a release has it, this opens the column's sequential stream exactly as
/// GetXmlReader does, through the internals the offline checks pin, and reads it as UTF-16. Without them, it falls back to
/// GetXmlReader.</summary>
internal static class SequentialXml
{
    private const BindingFlags Internal = BindingFlags.Instance | BindingFlags.NonPublic;
    private static readonly ConstructorInfo? NewStream = typeof(SqlDataReader).Assembly.GetType("Microsoft.Data.SqlClient.SqlSequentialStream")
        ?.GetConstructor(Internal, [typeof(SqlDataReader), typeof(int)]);
    private static readonly FieldInfo? CurrentStream = typeof(SqlDataReader).GetField("_currentStream", Internal);
    private static readonly FieldInfo? LastColumnRead = typeof(SqlDataReader).GetField("_lastColumnWithDataChunkRead", Internal);
    private static readonly XmlReaderSettings Settings = new() { ConformanceLevel = ConformanceLevel.Fragment, CloseInput = false };
    private static readonly XmlParserContext Utf16 = new(null, null, string.Empty, XmlSpace.None, Encoding.Unicode);

    /// <summary>Whether this SqlClient has the internals <see cref="Open"/> uses, with the types it expects.</summary>
    public static bool Available { get; } = NewStream is not null && typeof(Stream).IsAssignableFrom(NewStream.DeclaringType)
        && CurrentStream?.FieldType == NewStream.DeclaringType && LastColumnRead?.FieldType == typeof(int);

    /// <summary>The raw UTF-16 stream of column <paramref name="i"/>, whose IsDBNull was the reader's last call, or null when
    /// <see cref="Available"/> is false. The reader closes it when it moves to a later column or row, as it does
    /// GetXmlReader's.</summary>
    public static Stream? Open(SqlDataReader reader, int i)
    {
        if (!Available) return null;
        var stream = (Stream)NewStream!.Invoke([reader, i]);
        CurrentStream!.SetValue(reader, stream);
        LastColumnRead!.SetValue(reader, i);
        return stream;
    }

    /// <summary>An XmlReader over <see cref="Open"/>'s stream, with the settings SqlClient's own uses, as UTF-16; it leaves the
    /// stream open, so the rest of a long value can be read past without parsing it.</summary>
    public static XmlReader Read(Stream stream) => XmlReader.Create(stream, Settings, Utf16);
}

/// <summary>Feeds an XmlReader from an xml cell's stream while the text it produces keeps growing. XmlReader streams the
/// value of a text node (ReadValueChunk), but holds a whole start tag, attribute, comment or processing instruction before
/// returning it, so once <see cref="Window"/> bytes pass with no new output, this reports the end of the stream instead:
/// such a node's text is cut, and XmlReader holds no more than that window of it. One feed serves a column plan's cells in
/// turn (<see cref="Reset"/>).</summary>
internal sealed class XmlFeed(Func<int> output) : Stream
{
    /// <summary>8 MiB: 4,194,304 UTF-16 characters, twice the document cap, so any node that would still fit in a stored
    /// value is read whole (unless character references shrink it more than twofold).</summary>
    public const long Window = 8L * 1024 * 1024;
    private Stream inner = Null;
    private long consumed;
    private long mark;
    private int seen;

    /// <summary>The feed stopped, so the value is cut before the node XmlReader was reading.</summary>
    public bool Starved { get; private set; }

    /// <summary>Feeds the next cell from <paramref name="stream"/> with a fresh window, counting output from what it is now.</summary>
    public void Reset(Stream stream)
    {
        inner = stream;
        consumed = mark = 0;
        seen = output();
        Starved = false;
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        var written = output();
        if (written != seen)
        {
            seen = written;
            mark = consumed;
        }
        var room = Window - (consumed - mark);
        if (room <= 0)
        {
            Starved = true;
            return 0;
        }
        var read = inner.Read(buffer, offset, (int)Math.Min(count, room));
        consumed += read;
        return read;
    }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}
