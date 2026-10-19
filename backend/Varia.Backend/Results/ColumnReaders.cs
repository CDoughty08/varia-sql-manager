using System.Data;
using System.Data.SqlTypes;
using System.Globalization;
using System.Text;
using System.Xml;
using Microsoft.Data.SqlClient;
using Microsoft.Data.SqlTypes;

namespace Varia.Backend.Results;

/// <summary>How one column's cells are read (docs/ipc.md, SQL type → reader → wire → display).</summary>
internal enum CellCodec : byte
{
    Bit, Byte, Int16, Int32, Int64, Decimal, SqlDecimal, Money, Real, Float, Date, Time, SmallDateTime, DateTime, DateTime2, DateTimeOffset, Guid,
    Chars, Xml, Bytes, Timestamp, Stream, Variant, Vector, Value, LongText, Unreadable
}

/// <summary>The codecs for one result set, chosen once from its schema (never by catching exceptions per cell). Reads
/// follow CommandBehavior.SequentialAccess: IsDBNull first, then each column once, in ordinal order. Long values are kept
/// up to their cap plus one unit, read in 8,192-unit chunks, and the rest of a longer value is read past in chunks too, so
/// a huge value never materialises. Left unread, it would be skipped by the next ReadAsync, which buffers all of it in
/// time quadratic in its size. xml is the exception (see <see cref="Xml"/>). The query's token is checked between
/// chunks, so a cancel or timeout takes effect inside a long cell.</summary>
internal sealed class ColumnPlan
{
    public const int TextCap = 65_535;
    public const int DocumentCap = 2_097_152;
    public const int VectorCap = 65_535;
    public const int BinaryCap = 32_766;
    public const string ShowplanColumn = "Microsoft SQL Server 2005 XML Showplan";
    private const int Chunk = 8192;
    /// <summary>An xml cell that allocates at least this much counts toward <see cref="TransientBytes"/>.</summary>
    private const long TransientCell = 1024 * 1024;
    private const int JsonType = 35, VectorType = 36;
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    // SqlClient's own GetChars on xml serialises with these settings.
    private static readonly XmlWriterSettings XmlOutput = new() { ConformanceLevel = ConformanceLevel.Fragment, CloseOutput = false };
    private readonly Column[] columns;
    private char[] chars = new char[Chunk];
    private byte[] bytes = new byte[Chunk];

    private sealed class Column(string name, string type, CellCodec codec, WireKind wire, int scale, int cap)
    {
        public readonly string Name = name;
        public readonly string Type = type;
        public readonly WireKind Wire = wire;
        public readonly int Scale = scale;
        public readonly int Cap = cap;
        public CellCodec Codec = codec;
        public bool Warned;
    }

    private ColumnPlan(Column[] columns, IReadOnlyList<ResultColumn> descriptors, bool isPlan, bool hasLong)
    {
        this.columns = columns;
        Columns = descriptors;
        Wires = [.. columns.Select(column => column.Wire)];
        IsPlan = isPlan;
        HasLong = hasLong;
        DescriptorBytes = DescriptorBytesOf(descriptors);
    }

    public IReadOnlyList<ResultColumn> Columns { get; }
    public IReadOnlyList<WireKind> Wires { get; }
    /// <summary>An upper bound on this set's descriptor in the query.execute summary and its resultSet events (MessagePack):
    /// its names and types, plus 96 bytes of keys and values per column and 512 per set.</summary>
    public long DescriptorBytes { get; }

    public static long DescriptorBytesOf(IEnumerable<ResultColumn> columns) =>
        512 + columns.Sum(column => Encoding.UTF8.GetByteCount(column.Name) + Encoding.UTF8.GetByteCount(column.DataType) + 96L);

    /// <summary>"xml" or "json" when the set is FOR XML or FOR JSON output, which <see cref="ForXmlCollector"/> joins into
    /// one value; otherwise null.</summary>
    public string? ForXml { get; private init; }
    /// <summary>Today's rule: a single column named "Microsoft SQL Server 2005 XML Showplan" is an execution plan.</summary>
    public bool IsPlan { get; }
    /// <summary>Whether the set has a long column (max types, text, ntext, image, xml, CLR types), whose values can reach
    /// 2 GB. Rows that are not stored are then read past synchronously, on a thread of their own
    /// (SqlService.SkipRowsAsync).</summary>
    public bool HasLong { get; }

    /// <summary>What the last <see cref="ReadRow"/> allocated to read large xml values, which are read whole (see
    /// <see cref="Xml"/>), about 2 bytes per character outside the result budget: garbage once the reader moves on.</summary>
    public long TransientBytes { get; private set; }

    /// <summary><see cref="HasLong"/> for a set that has no plan because none of its rows are stored.</summary>
    public static bool HasLongColumns(SqlDataReader reader) => reader.GetColumnSchema().Any(column => column.IsLong == true);

    public static ColumnPlan From(SqlDataReader reader)
    {
        var count = reader.FieldCount;
        var schema = reader.GetSchemaTable() ?? throw new InvalidOperationException("The result set has no schema.");
        var isPlan = count == 1 && reader.GetName(0).Equals(ShowplanColumn, StringComparison.OrdinalIgnoreCase);
        string? forXml = null;
        var columns = new Column[count];
        var descriptors = new ResultColumn[count];
        var hasLong = false;
        for (var i = 0; i < count; i++)
        {
            var row = schema.Rows[i];
            var name = reader.GetName(i);
            var typeName = reader.GetDataTypeName(i);
            // CLR UDTs report database.schema.type; SSMS shows the type name.
            var type = typeName.Contains('.') ? typeName[(typeName.LastIndexOf('.') + 1)..] : typeName;
            var provider = Int(row, "ProviderType") ?? -1;
            var precision = Int(row, "NumericPrecision");
            var scale = Int(row, "NumericScale");
            var size = Int(row, "ColumnSize");
            var isLong = row["IsLong"] is true;
            hasLong |= isLong;
            var nullable = row["AllowDBNull"] is not false;
            var clrType = row["DataType"] as Type;
            var (codec, wire, role, cap) = Choose(provider, precision, isLong, clrType, isPlan);
            if (count == 1 && ForXmlCollector.RoleOf(name, provider) is { } documentRole) role = forXml = documentRole;
            columns[i] = new Column(name, type, codec, wire, scale is >= 0 and <= 7 ? scale.Value : 7, cap);
            var exact = codec is CellCodec.Decimal or CellCodec.SqlDecimal;
            var scaled = codec is CellCodec.Time or CellCodec.DateTime2 or CellCodec.DateTimeOffset;
            descriptors[i] = new ResultColumn(name, type, wire == WireKind.Text ? "text" : "binary", role,
                MaxLength: !isLong && size is > 0 and < int.MaxValue && codec is CellCodec.Chars or CellCodec.Bytes ? size : null,
                Precision: exact ? precision : null, Scale: exact || scaled ? scale : null, Nullable: nullable);
        }
        return new ColumnPlan(columns, descriptors, isPlan, hasLong) { ForXml = forXml };
    }

    private static int? Int(DataRow row, string column) => row.Table.Columns.Contains(column) && row[column] is not DBNull and var value ? Convert.ToInt32(value, Invariant) : null;

    private static (CellCodec Codec, WireKind Wire, string? Role, int Cap) Choose(int provider, int? precision, bool isLong, Type? clrType, bool isPlan)
    {
        const WireKind text = WireKind.Text, binary = WireKind.Binary;
        if (isPlan) return (provider == (int)SqlDbType.Xml ? CellCodec.Xml : CellCodec.Chars, text, "plan", DocumentCap);
        return provider switch
        {
            (int)SqlDbType.Bit => (CellCodec.Bit, text, null, 0),
            (int)SqlDbType.TinyInt => (CellCodec.Byte, text, null, 0),
            (int)SqlDbType.SmallInt => (CellCodec.Int16, text, null, 0),
            (int)SqlDbType.Int => (CellCodec.Int32, text, null, 0),
            (int)SqlDbType.BigInt => (CellCodec.Int64, text, null, 0),
            (int)SqlDbType.Decimal => (precision is > 28 ? CellCodec.SqlDecimal : CellCodec.Decimal, text, null, 0),
            (int)SqlDbType.Money or (int)SqlDbType.SmallMoney => (CellCodec.Money, text, null, 0),
            (int)SqlDbType.Real => (CellCodec.Real, text, null, 0),
            (int)SqlDbType.Float => (CellCodec.Float, text, null, 0),
            (int)SqlDbType.Date => (CellCodec.Date, text, null, 0),
            (int)SqlDbType.Time => (CellCodec.Time, text, null, 0),
            (int)SqlDbType.SmallDateTime => (CellCodec.SmallDateTime, text, null, 0),
            (int)SqlDbType.DateTime => (CellCodec.DateTime, text, null, 0),
            (int)SqlDbType.DateTime2 => (CellCodec.DateTime2, text, null, 0),
            (int)SqlDbType.DateTimeOffset => (CellCodec.DateTimeOffset, text, null, 0),
            (int)SqlDbType.UniqueIdentifier => (CellCodec.Guid, text, null, 0),
            (int)SqlDbType.Char or (int)SqlDbType.VarChar or (int)SqlDbType.NChar or (int)SqlDbType.NVarChar => (CellCodec.Chars, text, null, TextCap),
            // GetChars on text and ntext reads the whole value at its first call; GetTextReader streams it.
            (int)SqlDbType.Text or (int)SqlDbType.NText => (CellCodec.LongText, text, null, TextCap),
            (int)SqlDbType.Xml => (CellCodec.Xml, text, "xml", DocumentCap),
            JsonType => (CellCodec.Chars, text, "json", DocumentCap),
            VectorType => (CellCodec.Vector, text, "vector", VectorCap),
            (int)SqlDbType.Binary or (int)SqlDbType.VarBinary or (int)SqlDbType.Image => (CellCodec.Bytes, binary, null, BinaryCap),
            (int)SqlDbType.Timestamp => (CellCodec.Timestamp, binary, null, BinaryCap),
            // SSMS shows CLR UDT values (hierarchyid, geometry, geography) as their serialized bytes; no assembly is loaded.
            (int)SqlDbType.Udt => (CellCodec.Stream, binary, "udt", BinaryCap),
            (int)SqlDbType.Variant => (CellCodec.Variant, text, null, TextCap),
            _ when !isLong => (CellCodec.Value, text, null, TextCap),
            _ when clrType == typeof(string) => (CellCodec.LongText, text, null, TextCap),
            _ when clrType == typeof(byte[]) => (CellCodec.Stream, binary, null, BinaryCap),
            _ => (CellCodec.Unreadable, text, null, TextCap)
        };
    }

    /// <summary>Appends one row's cells. A value that cannot be read becomes NULL with the read-error flag, the column switches
    /// to its fallback reader for later rows, and one message names the column. SQL Server errors propagate.
    /// Returns the number of cells stored as truncated prefixes.</summary>
    public int ReadRow(SqlDataReader reader, PageBuilder builder, Action<string> warn, CancellationToken token = default)
    {
        TransientBytes = 0;
        var truncated = 0;
        for (var i = 0; i < columns.Length; i++)
        {
            var column = columns[i];
            if (reader.IsDBNull(i)) { builder.AppendNull(); continue; }
            try { if (Read(column, reader, i, builder, token)) truncated++; }
            catch (Exception error) when (IsCellFailure(error))
            {
                builder.AppendNull(error: true);
                if (!column.Warned)
                {
                    column.Warned = true;
                    warn("Column ‘" + column.Name + "’ (" + column.Type + "): some values could not be read and are shown as NULL.");
                }
                column.Codec = column.Wire == WireKind.Binary ? CellCodec.Stream : CellCodec.Value;
            }
        }
        return truncated;
    }

    /// <summary>A value the provider cannot convert; anything else (SQL errors, a closed connection, cancellation) ends the read.</summary>
    private static bool IsCellFailure(Exception error) => error is InvalidCastException or OverflowException or FormatException or ArgumentException
        or NotSupportedException or SqlTypeException or FileNotFoundException or FileLoadException or TypeLoadException or InvalidDataException or XmlException;

    private bool Read(Column column, SqlDataReader reader, int i, PageBuilder builder, CancellationToken token)
    {
        switch (column.Codec)
        {
            case CellCodec.Bit: builder.EndFormatted(CellFormat.WriteBit(builder.BeginFormatted(), reader.GetBoolean(i))); return false;
            case CellCodec.Byte: builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), reader.GetByte(i))); return false;
            case CellCodec.Int16: builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), reader.GetInt16(i))); return false;
            case CellCodec.Int32: builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), reader.GetInt32(i))); return false;
            case CellCodec.Int64: builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), reader.GetInt64(i))); return false;
            case CellCodec.Decimal: builder.EndFormatted(CellFormat.WriteDecimal(builder.BeginFormatted(), reader.GetDecimal(i))); return false;
            case CellCodec.SqlDecimal: builder.EndFormatted(CellFormat.WriteSqlDecimal(builder.BeginFormatted(), reader.GetSqlDecimal(i))); return false;
            case CellCodec.Money: builder.EndFormatted(CellFormat.WriteMoney(builder.BeginFormatted(), reader.GetDecimal(i))); return false;
            case CellCodec.Real: builder.EndFormatted(CellFormat.WriteReal(builder.BeginFormatted(), reader.GetFloat(i))); return false;
            case CellCodec.Float: builder.EndFormatted(CellFormat.WriteFloat(builder.BeginFormatted(), reader.GetDouble(i))); return false;
            case CellCodec.Date: builder.EndFormatted(CellFormat.WriteDate(builder.BeginFormatted(), reader.GetDateTime(i))); return false;
            case CellCodec.Time: builder.EndFormatted(CellFormat.WriteTime(builder.BeginFormatted(), reader.GetTimeSpan(i), column.Scale)); return false;
            case CellCodec.SmallDateTime: builder.EndFormatted(CellFormat.WriteSmallDateTime(builder.BeginFormatted(), reader.GetDateTime(i))); return false;
            case CellCodec.DateTime: builder.EndFormatted(CellFormat.WriteDateTime(builder.BeginFormatted(), reader.GetDateTime(i))); return false;
            case CellCodec.DateTime2: builder.EndFormatted(CellFormat.WriteDateTime2(builder.BeginFormatted(), reader.GetDateTime(i), column.Scale)); return false;
            case CellCodec.DateTimeOffset: builder.EndFormatted(CellFormat.WriteDateTimeOffset(builder.BeginFormatted(), reader.GetDateTimeOffset(i), column.Scale)); return false;
            case CellCodec.Guid: builder.EndFormatted(CellFormat.WriteGuid(builder.BeginFormatted(), reader.GetGuid(i))); return false;
            case CellCodec.Chars: return Chars(reader, i, column.Cap, builder, token);
            case CellCodec.Xml: return Xml(reader, i, column.Cap, builder, token);
            case CellCodec.Bytes: return Bytes(reader, i, column.Cap, builder, token);
            // SqlClient reports a NULL rowversion as not null with no bytes; a real one always has 8.
            case CellCodec.Timestamp:
                if (reader.GetBytes(i, 0, null, 0, 0) == 0) { builder.AppendNull(); return false; }
                return Bytes(reader, i, column.Cap, builder, token);
            case CellCodec.Stream:
            {
                using var stream = reader.GetStream(i);
                return Binary(stream, column.Cap, builder, token);
            }
            case CellCodec.Variant: return Variant(reader.GetSqlValue(i), builder);
            case CellCodec.Vector:
            {
                var text = CellFormat.Vector(reader.GetFieldValue<SqlVector<float>>(i).Memory.Span, VectorCap, out var cut);
                builder.AppendText(text, cut);
                return cut;
            }
            case CellCodec.Value: return Text(Convert.ToString(reader.GetValue(i), Invariant) ?? "", TextCap, builder);
            case CellCodec.LongText:
            {
                using var text = reader.GetTextReader(i);
                return Chars(text, column.Cap, builder, token);
            }
            default: throw new NotSupportedException("The column type cannot be read.");
        }
    }

    private static bool Text(ReadOnlySpan<char> value, int cap, PageBuilder builder)
    {
        var prefix = CellFormat.Prefix(value, cap, out var truncated);
        builder.AppendText(prefix, truncated);
        return truncated;
    }

    private Span<char> Chars(int length)
    {
        if (chars.Length < length) Array.Resize(ref chars, Math.Max(length, Math.Min(chars.Length * 2, DocumentCap + 1)));
        return chars;
    }

    private Span<byte> Bytes(int length)
    {
        if (bytes.Length < length) Array.Resize(ref bytes, Math.Max(length, bytes.Length * 2));
        return bytes;
    }

    /// <summary>Keeps at most cap + 1 characters, so a longer value is known to be truncated. The rest of a longer value is
    /// read in chunks into the buffer after the kept prefix, which stays intact (see the class summary); the other chunked
    /// readers below do the same.</summary>
    private bool Chars(SqlDataReader reader, int i, int cap, PageBuilder builder, CancellationToken token)
    {
        var limit = cap + 1;
        var total = 0;
        while (total < limit)
        {
            token.ThrowIfCancellationRequested();
            var length = Math.Min(Chunk, limit - total);
            Chars(total + length);
            var read = (int)reader.GetChars(i, total, chars, total, length);
            if (read <= 0) break;
            total += read;
        }
        if (total == limit)
        {
            Chars(total + Chunk);
            for (long offset = total, read; (read = reader.GetChars(i, offset, chars, total, Chunk)) > 0; offset += read) token.ThrowIfCancellationRequested();
        }
        return Text(chars.AsSpan(0, total), cap, builder);
    }

    private bool Chars(TextReader reader, int cap, PageBuilder builder, CancellationToken token)
    {
        var limit = cap + 1;
        var total = 0;
        while (total < limit)
        {
            token.ThrowIfCancellationRequested();
            var length = Math.Min(Chunk, limit - total);
            var read = reader.Read(Chars(total + length).Slice(total, length));
            if (read <= 0) break;
            total += read;
        }
        if (total == limit) while (reader.Read(Chars(total + Chunk).Slice(total, Chunk)) > 0) token.ThrowIfCancellationRequested();
        return Text(chars.AsSpan(0, total), cap, builder);
    }

    private bool Bytes(SqlDataReader reader, int i, int cap, PageBuilder builder, CancellationToken token)
    {
        var limit = cap + 1;
        var total = 0;
        while (total < limit)
        {
            token.ThrowIfCancellationRequested();
            var length = Math.Min(Chunk, limit - total);
            Bytes(total + length);
            var read = (int)reader.GetBytes(i, total, bytes, total, length);
            if (read <= 0) break;
            total += read;
        }
        if (total == limit)
        {
            Bytes(total + Chunk);
            for (long offset = total, read; (read = reader.GetBytes(i, offset, bytes, total, Chunk)) > 0; offset += read) token.ThrowIfCancellationRequested();
        }
        builder.AppendBinary(bytes.AsSpan(0, Math.Min(total, cap)), total > cap);
        return total > cap;
    }

    private bool Binary(Stream stream, int cap, PageBuilder builder, CancellationToken token)
    {
        var limit = cap + 1;
        var total = 0;
        while (total < limit)
        {
            token.ThrowIfCancellationRequested();
            var length = Math.Min(Chunk, limit - total);
            var read = stream.Read(Bytes(total + length).Slice(total, length));
            if (read <= 0) break;
            total += read;
        }
        if (total == limit) while (stream.Read(Bytes(total + Chunk).Slice(total, Chunk)) > 0) token.ThrowIfCancellationRequested();
        builder.AppendBinary(bytes.AsSpan(0, Math.Min(total, cap)), total > cap);
        return total > cap;
    }

    /// <summary>xml, up to cap + 1 characters. SqlClient's GetChars on xml copies each chunk out of a StringBuilder that holds
    /// the whole serialised node, which is quadratic in a large text node, GetXmlReader under sequential access misdetects
    /// the encoding of a value that starts with text (FOR XML PATH('') output), and GetStream and GetTextReader reject
    /// xml. So GetSqlXml reads the whole value, in linear time and about 2 bytes per character (up to 4 GB for the largest
    /// value), then it is serialised node by node as GetChars would, stopping at the cap. That memory is outside the
    /// result budget and garbage once the reader moves past the row; <see cref="TransientBytes"/> reports it so it is
    /// collected then rather than left to pile up across rows.</summary>
    private bool Xml(SqlDataReader reader, int i, int cap, PageBuilder builder, CancellationToken token)
    {
        var allocated = GC.GetAllocatedBytesForCurrentThread();
        try { return Xml(reader.GetSqlXml(i), cap, builder, token); }
        finally
        {
            allocated = GC.GetAllocatedBytesForCurrentThread() - allocated;
            if (allocated >= TransientCell) TransientBytes += allocated;
        }
    }

    private bool Xml(SqlXml value, int cap, PageBuilder builder, CancellationToken token)
    {
        var sink = new CharSink(cap + 1);
        using (var xml = value.CreateReader())
        {
            // Never closed: closing ends open elements, which would only add text past a full sink.
            var writer = XmlWriter.Create(sink, XmlOutput);
            while (!sink.Full && xml.Read())
            {
                token.ThrowIfCancellationRequested();
                switch (xml.NodeType)
                {
                    case XmlNodeType.Element:
                        writer.WriteStartElement(xml.Prefix, xml.LocalName, xml.NamespaceURI);
                        writer.WriteAttributes(xml, true);
                        if (xml.IsEmptyElement) writer.WriteEndElement();
                        break;
                    case XmlNodeType.Text:
                        int read;
                        while (!sink.Full && (read = xml.ReadValueChunk(chars, 0, Chunk)) > 0) writer.WriteChars(chars, 0, read);
                        break;
                    case XmlNodeType.Whitespace or XmlNodeType.SignificantWhitespace: writer.WriteWhitespace(xml.Value); break;
                    case XmlNodeType.CDATA: writer.WriteCData(xml.Value); break;
                    case XmlNodeType.EntityReference: writer.WriteEntityRef(xml.Name); break;
                    case XmlNodeType.XmlDeclaration or XmlNodeType.ProcessingInstruction: writer.WriteProcessingInstruction(xml.Name, xml.Value); break;
                    case XmlNodeType.Comment: writer.WriteComment(xml.Value); break;
                    case XmlNodeType.EndElement: writer.WriteFullEndElement(); break;
                }
            }
            if (!sink.Full) writer.Flush();
        }
        return Text(sink.Text, cap, builder);
    }

    /// <summary>A TextWriter that keeps the first <c>limit</c> characters written to it and drops the rest.</summary>
    private sealed class CharSink(int limit) : TextWriter
    {
        private char[] buffer = new char[Math.Min(limit, Chunk)];
        private int count;
        public bool Full => count == limit;
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

    /// <summary>sql_variant: formatted by its base type as the rows above would; binary values become 0x text.</summary>
    private static bool Variant(object value, PageBuilder builder)
    {
        switch (value)
        {
            case SqlBoolean bit: builder.EndFormatted(CellFormat.WriteBit(builder.BeginFormatted(), bit.Value)); return false;
            case SqlByte number: builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), number.Value)); return false;
            case SqlInt16 number: builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), number.Value)); return false;
            case SqlInt32 number: builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), number.Value)); return false;
            case SqlInt64 number: builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), number.Value)); return false;
            case SqlDecimal number when number.Precision <= 28: builder.EndFormatted(CellFormat.WriteDecimal(builder.BeginFormatted(), number.Value)); return false;
            case SqlDecimal number: builder.EndFormatted(CellFormat.WriteSqlDecimal(builder.BeginFormatted(), number)); return false;
            case SqlMoney money: builder.EndFormatted(CellFormat.WriteMoney(builder.BeginFormatted(), money.Value)); return false;
            case SqlSingle number: builder.EndFormatted(CellFormat.WriteReal(builder.BeginFormatted(), number.Value)); return false;
            case SqlDouble number: builder.EndFormatted(CellFormat.WriteFloat(builder.BeginFormatted(), number.Value)); return false;
            case SqlDateTime date: builder.EndFormatted(CellFormat.WriteDateTime(builder.BeginFormatted(), date.Value)); return false;
            // date, time, datetime2 and datetimeoffset have no Sql* type; their scale is not reported, so all 7 digits show.
            case DateTime date: builder.EndFormatted(CellFormat.WriteDateTime2(builder.BeginFormatted(), date, 7)); return false;
            case TimeSpan time: builder.EndFormatted(CellFormat.WriteTime(builder.BeginFormatted(), time, 7)); return false;
            case DateTimeOffset date: builder.EndFormatted(CellFormat.WriteDateTimeOffset(builder.BeginFormatted(), date, 7)); return false;
            case SqlGuid guid: builder.EndFormatted(CellFormat.WriteGuid(builder.BeginFormatted(), guid.Value)); return false;
            case SqlString text: return Text(text.Value, TextCap, builder);
            case SqlBinary binary:
            {
                var bytes = binary.Value;
                var fits = Math.Min(bytes.Length, (TextCap - 2) / 2);
                builder.AppendText("0x" + Convert.ToHexString(bytes, 0, fits), fits < bytes.Length);
                return fits < bytes.Length;
            }
            default: return Text(Convert.ToString(value, Invariant) ?? "", TextCap, builder);
        }
    }
}
