using System.Buffers.Binary;
using System.Linq.Expressions;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Xml;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Results;

/// <summary>Streams an xml cell under CommandBehavior.SequentialAccess. SqlClient sends xml as UTF-16 text, and its
/// GetXmlReader there lets XmlReader guess the encoding from the first bytes: a value that does not start with '<' throws,
/// or, when both bytes of its first characters are printable (U+3441 is "A4"), reads as other text. SqlClient fixed that
/// after 7.1.1 (dotnet/SqlClient#4757); until a release has it, this opens the column's sequential stream exactly as
/// GetXmlReader does, through the internals the offline checks pin, and <see cref="XmlFeed"/> reads it as UTF-16. Without
/// them, it falls back to GetXmlReader.</summary>
internal static class SequentialXml
{
    private const BindingFlags Internal = BindingFlags.Instance | BindingFlags.NonPublic;
    private static readonly ConstructorInfo? NewStream = typeof(SqlDataReader).Assembly.GetType("Microsoft.Data.SqlClient.SqlSequentialStream")
        ?.GetConstructor(Internal, [typeof(SqlDataReader), typeof(int)]);
    private static readonly FieldInfo? CurrentStream = typeof(SqlDataReader).GetField("_currentStream", Internal);
    private static readonly FieldInfo? LastColumnRead = typeof(SqlDataReader).GetField("_lastColumnWithDataChunkRead", Internal);

    /// <summary>Whether this SqlClient has the internals <see cref="Open"/> uses, with the types it expects.</summary>
    public static bool Available { get; } = NewStream is not null && typeof(Stream).IsAssignableFrom(NewStream.DeclaringType)
        && CurrentStream?.FieldType == NewStream.DeclaringType && LastColumnRead?.FieldType == typeof(int);

    // Compiled once: reflection's Invoke and SetValue allocate an argument array and box the column on every cell.
    private static readonly Func<SqlDataReader, int, Stream>? Opener = Available ? Compile() : null;

    private static Func<SqlDataReader, int, Stream> Compile()
    {
        var reader = Expression.Parameter(typeof(SqlDataReader), "reader");
        var column = Expression.Parameter(typeof(int), "column");
        var stream = Expression.Variable(NewStream!.DeclaringType!, "stream");
        var body = Expression.Block([stream],
            Expression.Assign(stream, Expression.New(NewStream, reader, column)),
            Expression.Assign(Expression.Field(reader, CurrentStream!), stream),
            Expression.Assign(Expression.Field(reader, LastColumnRead!), column),
            Expression.Convert(stream, typeof(Stream)));
        return Expression.Lambda<Func<SqlDataReader, int, Stream>>(body, reader, column).Compile();
    }

    /// <summary>The raw UTF-16 stream of column <paramref name="i"/>, whose IsDBNull was the reader's last call, or null when
    /// <see cref="Available"/> is false. The reader closes it when it moves to a later column or row, as it does
    /// GetXmlReader's.</summary>
    public static Stream? Open(SqlDataReader reader, int i) => Opener?.Invoke(reader, i);
}

/// <summary>Feeds an XmlReader the UTF-16 text of an xml cell's stream while the text it produces keeps growing. XmlReader
/// streams the value of a text node (ReadValueChunk), but holds a whole start tag, attribute, comment or processing
/// instruction before returning it, so once <see cref="Window"/> characters pass with no new output, this reports the end of
/// the text instead: such a node's text is cut, and XmlReader holds no more than that window of it. It decodes the stream
/// itself (SQL Server sends xml as UTF-16 without a byte order mark), so an XmlReader over it builds no decoder or byte
/// buffer of its own. One feed serves a column plan's cells in turn (<see cref="Reset"/>).
/// <para>So that a cut value still shows the start of the node it cut, as the first characters of the whole value would, the
/// feed keeps the raw text from the first '&lt;' XmlReader has not yet returned a node for, up to <see cref="Keep"/>
/// characters (<see cref="Tail"/>). Every markup node starts with a '&lt;', and only a comment, processing instruction or
/// CDATA section holds more (a start tag's attribute values cannot), so counting them (<see cref="Returned"/>) finds it;
/// text and whitespace hold none.</para></summary>
internal sealed class XmlFeed(Func<int> output) : TextReader
{
    /// <summary>4,194,304 characters (8 MiB of UTF-16), twice the document cap, so any node that would still fit in a stored
    /// value is read whole (unless character references shrink it more than twofold).</summary>
    public const long Window = 4L * 1024 * 1024;
    // XmlReader asks for at most 4,096 characters a read.
    private readonly byte[] bytes = new byte[2 * 4096 + 2];
    private Stream inner = Stream.Null;
    private long consumed;
    private long produced;
    private long mark;
    private int seen;
    // A read can end inside a character: its first byte waits here for the next read.
    private int pending = -1;
    // The tail: raw text from the '<' numbered tailOrdinal (counting from 1 in this cell), at tail[tailStart..+tailLength].
    // Kept up to 16 Ki characters between cells; a larger one goes when the cell ends, outside the result budget otherwise.
    private const int KeptTail = 16 * 1024;
    private char[] tail = [];
    private int tailStart;
    private int tailLength;
    private long tailOrdinal;
    // The tail reached Keep and stopped growing: the '<' after its retained part may be lost.
    private bool clipped;
    // A '<' XmlReader has not returned was not kept: no tail until every '<' handed out is returned.
    private bool lost;
    private long lessThans;
    private long markup;

    /// <summary>Bytes read from the cell's stream since <see cref="Reset"/>.</summary>
    public long Consumed => consumed;
    /// <summary>The feed stopped, so the value is cut before the node XmlReader was reading.</summary>
    public bool Starved { get; private set; }

    /// <summary>The most raw characters <see cref="Tail"/> keeps (0, the default, keeps none).</summary>
    public int Keep { get; set; }

    /// <summary>The raw text of the node XmlReader was reading when the feed starved, from its '&lt;' and at most
    /// <see cref="Keep"/> characters of it, or empty when that start was not kept (a node with no '&lt;' of its own, or one
    /// within XmlReader's look-ahead of a kept node that already reached <see cref="Keep"/>).</summary>
    public ReadOnlySpan<char> Tail
    {
        get
        {
            Trim();
            return lost ? [] : tail.AsSpan(tailStart, tailLength);
        }
    }

    /// <summary>XmlReader returned a node holding <paramref name="count"/> '&lt;' characters of the raw text.</summary>
    public void Returned(int count) => markup += count;

    /// <summary>Feeds the next cell from <paramref name="stream"/> with a fresh window, counting output from what it is now.</summary>
    public void Reset(Stream stream)
    {
        inner = stream;
        consumed = produced = mark = 0;
        pending = -1;
        seen = output();
        Starved = false;
        tailStart = tailLength = 0;
        tailOrdinal = lessThans = markup = 0;
        clipped = lost = false;
        if (tail.Length > KeptTail) tail = [];
    }

    public override int Read(char[] buffer, int index, int count) => Read(buffer.AsSpan(index, count));

    public override int Read()
    {
        Span<char> one = stackalloc char[1];
        return Read(one) == 1 ? one[0] : -1;
    }

    public override int Peek() => -1;

    public override int Read(Span<char> buffer)
    {
        if (buffer.IsEmpty) return 0;
        var written = output();
        if (written != seen)
        {
            seen = written;
            mark = produced;
        }
        var room = Window - (produced - mark);
        if (room <= 0)
        {
            Starved = true;
            return 0;
        }
        var want = (int)Math.Min(Math.Min(buffer.Length, room), bytes.Length / 2 - 1);
        while (true)
        {
            var have = 0;
            if (pending >= 0)
            {
                bytes[0] = (byte)pending;
                pending = -1;
                have = 1;
            }
            var read = inner.Read(bytes, have, 2 * want - have);
            if (read == 0) return 0;
            consumed += read;
            have += read;
            var count = have / 2;
            if ((have & 1) != 0) pending = bytes[have - 1];
            if (count == 0) continue;
            if (BitConverter.IsLittleEndian) MemoryMarshal.Cast<byte, char>(bytes.AsSpan(0, 2 * count)).CopyTo(buffer);
            else for (var i = 0; i < count; i++) buffer[i] = (char)BinaryPrimitives.ReadUInt16LittleEndian(bytes.AsSpan(2 * i));
            produced += count;
            if (Keep > 0) Capture(buffer[..count]);
            return count;
        }
    }

    /// <summary>Drops the tail's start while XmlReader has returned the node it begins.</summary>
    private void Trim()
    {
        if (lost && markup >= lessThans) lost = false;
        while (tailLength > 0 && tailOrdinal <= markup)
        {
            var next = tail.AsSpan(tailStart + 1, tailLength - 1).IndexOf('<');
            if (next < 0)
            {
                tailLength = 0;
                // A '<' that is still to be returned lies past what a clipped tail kept.
                lost = clipped && lessThans > markup;
                clipped = false;
                break;
            }
            tailStart += next + 1;
            tailLength -= next + 1;
            tailOrdinal++;
        }
        if (tailLength == 0) tailStart = 0;
    }

    private void Capture(ReadOnlySpan<char> text)
    {
        Trim();
        var count = text.Count('<');
        if (lost || count == 0 && tailLength == 0)
        {
            lessThans += count;
            return;
        }
        if (tailLength == 0)
        {
            // Every '<' handed out before was returned, so the first one here is the next node's.
            var first = text.IndexOf('<');
            text = text[first..];
            tailOrdinal = lessThans + 1;
        }
        lessThans += count;
        if (clipped) return;
        var take = Math.Min(text.Length, Keep - tailLength);
        if (take < text.Length) clipped = true;
        if (take <= 0) return;
        if (tailStart + tailLength + take > tail.Length)
        {
            if (tailLength + take > tail.Length) Array.Resize(ref tail, Math.Min(Keep, Math.Max(tailLength + take, Math.Max(tail.Length * 2, 4096))));
            tail.AsSpan(tailStart, tailLength).CopyTo(tail);
            tailStart = 0;
        }
        text[..take].CopyTo(tail.AsSpan(tailStart + tailLength));
        tailLength += take;
    }
}

/// <summary>A NameTable shared by a column plan's xml cells, so that each cell's XmlReader does not build one of its own. The
/// names it holds come from the data, which can be hostile, so it counts what it adds, and the plan drops it as soon as the
/// cell that grew it past <see cref="MaxNames"/> names or <see cref="MaxChars"/> characters ends (<see cref="Overgrown"/>).</summary>
internal sealed class BoundedNameTable : NameTable
{
    public const int MaxNames = 4096;
    public const long MaxChars = 256 * 1024;
    public int Names { get; private set; }
    public long Chars { get; private set; }
    public bool Overgrown => Names > MaxNames || Chars > MaxChars;

    public override string Add(char[] key, int start, int len)
    {
        // A name seen before costs one lookup, as NameTable.Add would; only a new one is looked up twice.
        if (Get(key, start, len) is { } found) return found;
        Names++;
        Chars += len;
        return base.Add(key, start, len);
    }

    public override string Add(string key)
    {
        ArgumentNullException.ThrowIfNull(key);
        if (Get(key) is { } found) return found;
        Names++;
        Chars += key.Length;
        return base.Add(key);
    }
}

/// <summary>Serialises a column plan's xml cells one at a time, as SqlClient's GetChars would, into a <see cref="CharSink"/>
/// that keeps a cell's first characters up to its limit. What one cell needs is kept for the next: the sink, the feed, the
/// text chunk, the reader settings with their <see cref="BoundedNameTable"/>, and the XmlWriter, which is rebuilt only after
/// a cell that did not end cleanly (cut, starved, unbalanced or failed), since its writer may hold open elements. Each cell's
/// XmlReader is still its own: an XmlReader cannot be reset.</summary>
internal sealed class XmlCellWriter
{
    private const int Chunk = 8192;
    // SqlClient's own GetChars on xml serialises with these settings.
    private static readonly XmlWriterSettings Output = new() { ConformanceLevel = ConformanceLevel.Fragment, CloseOutput = false };
    private readonly CharSink sink = new();
    private readonly char[] chars = new char[Chunk];
    private XmlWriter? writer;
    private BoundedNameTable? names;
    private XmlReaderSettings? input;

    public XmlCellWriter() => Feed = new XmlFeed(() => sink.Count);

    /// <summary>The feed every cell read from a column's own stream goes through.</summary>
    public XmlFeed Feed { get; }
    public ReadOnlySpan<char> Text => sink.Text;
    public int Count => sink.Count;
    public bool Full => sink.Full;
    /// <summary>XmlWriters and NameTables built so far (the offline checks count reuse).</summary>
    internal int Writers { get; private set; }
    internal int NameTables { get; private set; }

    /// <summary>Starts the next cell, keeping at most <paramref name="limit"/> characters of it.</summary>
    public void Reset(int limit)
    {
        sink.Reset(limit);
        Feed.Keep = limit;
    }

    /// <summary>The NameTable the writer holds for the next cell, if any (the offline checks look for its release).</summary>
    internal BoundedNameTable? CurrentNames => names;

    /// <summary>An XmlReader over <see cref="Feed"/> with the settings SqlClient's own uses and the shared, bounded NameTable;
    /// it leaves the feed open, so the rest of a long value can be read past without parsing it.</summary>
    public XmlReader OpenReader()
    {
        if (input is null || names!.Overgrown)
        {
            names = new BoundedNameTable();
            input = new XmlReaderSettings { ConformanceLevel = ConformanceLevel.Fragment, CloseInput = false, NameTable = names };
            NameTables++;
        }
        return XmlReader.Create(Feed, input);
    }

    /// <summary>Serialises <paramref name="xml"/> node by node until it ends or the sink is full. Returns whether
    /// <paramref name="feed"/> starved, which cuts the value inside the node XmlReader was reading: what was written before
    /// it is kept, the parent's start tag closed, and then the node's own raw text from the feed (<see cref="XmlFeed.Tail"/>)
    /// up to the limit, as the first characters of the whole value would show it.</summary>
    public bool Write(XmlReader xml, XmlFeed? feed, CancellationToken token)
    {
        var writer = this.writer ??= Create();
        var depth = 0;
        var clean = false;
        // The last node written was a start tag whose '>' the writer holds until the element's content begins.
        var open = false;
        try
        {
            while (!sink.Full && xml.Read())
            {
                token.ThrowIfCancellationRequested();
                var type = xml.NodeType;
                // Counted before anything more is read, so the feed's tail starts at the next node's '<'.
                feed?.Returned(type switch
                {
                    XmlNodeType.Element or XmlNodeType.EndElement => 1,
                    XmlNodeType.Comment or XmlNodeType.ProcessingInstruction or XmlNodeType.CDATA or XmlNodeType.XmlDeclaration => 1 + xml.Value.AsSpan().Count('<'),
                    _ => 0
                });
                open = false;
                switch (type)
                {
                    case XmlNodeType.Element:
                        writer.WriteStartElement(xml.Prefix, xml.LocalName, xml.NamespaceURI);
                        writer.WriteAttributes(xml, true);
                        if (xml.IsEmptyElement) writer.WriteEndElement();
                        else
                        {
                            depth++;
                            open = true;
                        }
                        break;
                    case XmlNodeType.Text:
                        int read;
                        while (!sink.Full && (read = xml.ReadValueChunk(chars, 0, Chunk)) > 0) writer.WriteChars(chars, 0, read);
                        break;
                    case XmlNodeType.Whitespace or XmlNodeType.SignificantWhitespace: writer.WriteWhitespace(xml.Value); break;
                    case XmlNodeType.CDATA: writer.WriteCData(xml.Value); break;
                    case XmlNodeType.EntityReference: writer.WriteEntityRef(xml.Name); break;
                    case XmlNodeType.XmlDeclaration:
                        // A writer takes a declaration only first; a reused one has written earlier cells.
                        if (writer.WriteState != WriteState.Start) writer = this.writer = Create();
                        writer.WriteProcessingInstruction(xml.Name, xml.Value);
                        break;
                    case XmlNodeType.ProcessingInstruction: writer.WriteProcessingInstruction(xml.Name, xml.Value); break;
                    case XmlNodeType.Comment: writer.WriteComment(xml.Value); break;
                    case XmlNodeType.EndElement:
                        writer.WriteFullEndElement();
                        depth--;
                        break;
                }
            }
            clean = !sink.Full && depth == 0 && feed?.Starved != true;
        }
        // The feed ended the stream inside a node, which XmlReader reports as an unexpected end.
        catch (XmlException) when (feed?.Starved == true) { }
        finally
        {
            // Never closed: closing ends open elements, which would only add text past a full sink. A writer left inside an
            // element (or failed) is dropped, and the next cell builds a fresh one.
            if (!clean) this.writer = null;
            // A table a hostile cell grew past its cap goes with the cell, not when the next xml cell opens a reader.
            if (names?.Overgrown == true)
            {
                names = null;
                input = null;
            }
        }
        if (!sink.Full) writer.Flush();
        if (feed?.Starved != true) return false;
        if (!sink.Full)
        {
            // Written past the writer, which is dropped: the parent's '>', then the cut node as the stream had it.
            if (open) sink.Write('>');
            sink.Write(feed.Tail);
        }
        return true;
    }

    private XmlWriter Create()
    {
        Writers++;
        return XmlWriter.Create(sink, Output);
    }
}

/// <summary>A TextWriter that keeps the first <c>limit</c> characters written to it since <see cref="Reset"/> and drops the
/// rest. Its buffer is kept across cells.</summary>
internal sealed class CharSink : TextWriter
{
    private char[] buffer = new char[8192];
    private int count;
    private int limit;
    public void Reset(int limit)
    {
        this.limit = limit;
        count = 0;
    }
    public bool Full => count == limit;
    public int Count => count;
    public ReadOnlySpan<char> Text => buffer.AsSpan(0, count);
    public override Encoding Encoding => Encoding.Unicode;
    public override void Write(char value) => Write([value]);
    public override void Write(char[] buffer, int index, int count) => Write(buffer.AsSpan(index, count));
    public override void Write(string? value) => Write(value.AsSpan());
    public override void Write(ReadOnlySpan<char> value)
    {
        var take = Math.Min(value.Length, limit - count);
        if (take <= 0) return;
        if (buffer.Length < count + take) Array.Resize(ref buffer, Math.Min(limit, Math.Max(count + take, buffer.Length * 2)));
        value[..take].CopyTo(buffer.AsSpan(count));
        count += take;
    }
}
