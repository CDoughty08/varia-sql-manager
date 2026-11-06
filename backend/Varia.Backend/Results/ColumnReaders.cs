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
    Chars, Xml, Bytes, Timestamp, Stream, Variant, Vector, Value, LongText, Json, Unreadable
}

/// <summary>The codecs for one result set, chosen once from its schema (never by catching exceptions per cell). Reads
/// follow CommandBehavior.SequentialAccess: IsDBNull first, then each column once, in ordinal order. Long values are kept
/// up to their cap plus one unit, read in 8,192-unit chunks, and the rest of a longer value is read past in chunks too, so
/// a huge value never materialises. Left unread, it would be skipped by the next ReadAsync, which buffers all of it in
/// time quadratic in its size. xml is parsed as it streams and serialised up to its cap (see <see cref="Xml"/>). The
/// query's token is checked between chunks, so a cancel or timeout takes effect inside a long cell.</summary>
internal sealed class ColumnPlan
{
    public const int TextCap = 65_535;
    public const int DocumentCap = 2_097_152;
    public const int VectorCap = 65_535;
    public const int BinaryCap = 32_766;
    public const string ShowplanColumn = "Microsoft SQL Server 2005 XML Showplan";
    private const int Chunk = 8192;
    private const int JsonType = 35, VectorType = 36;
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    // SqlClient's own GetChars on xml serialises with these settings.
    private static readonly XmlWriterSettings XmlOutput = new() { ConformanceLevel = ConformanceLevel.Fragment, CloseOutput = false };
    private readonly Column[] columns;
    private char[] chars = new char[Chunk];
    private byte[] bytes = new byte[Chunk];
    private readonly Decoder utf8 = new UTF8Encoding(false).GetDecoder();
    // Reused by every xml cell: a fresh sink and feed per cell made a small cell cost about 45 KB instead of 28 KB.
    private CharSink? sink;
    private XmlFeed? feed;
    // The cell just read: its full characters and bytes, which ReadRow reports to the builder (PageBuilder.Measure); a
    // negative byte count measures nothing (a rowversion read as NULL).
    private long cellChars, cellBytes;
    // False when the reader could only estimate the cell's bytes; the cell then keeps an entry that says so.
    private bool cellExact;
    // True when an xml cell was stored but the rest of its value, past the cap, failed to parse (the GetXmlReader fallback).
    private bool cellTailFailed;

    /// <summary>Test seam: when set, xml cells read through this reader instead of the column's own stream, as when
    /// <see cref="SequentialXml.Open"/> finds none.</summary>
    internal Func<SqlDataReader, int, XmlReader>? XmlFallback { get; set; }

    private sealed class Column(string name, string type, CellCodec codec, WireKind wire, int scale, int cap, bool isLong, ColumnLength length)
    {
        public readonly string Name = name;
        public readonly ColumnLength Length = length;
        public readonly ByteCounter Counter = length.Counter();
        public readonly string Type = type;
        public readonly WireKind Wire = wire;
        public readonly int Scale = scale;
        public readonly int Cap = cap;
        public CellCodec Codec = codec;
        public readonly CellCodec Fallback = FallbackOf(codec, wire, isLong);
        public bool Warned;
        public bool TailWarned;
    }

    private ColumnPlan(Column[] columns, IReadOnlyList<ResultColumn> descriptors, bool isPlan, bool hasLong)
    {
        this.columns = columns;
        Columns = descriptors;
        Wires = [.. columns.Select(column => column.Wire)];
        Lengths = [.. columns.Select(column => column.Length)];
        IsPlan = isPlan;
        HasLong = hasLong;
        DescriptorBytes = DescriptorBytesOf(descriptors);
    }

    public IReadOnlyList<ResultColumn> Columns { get; }
    public IReadOnlyList<WireKind> Wires { get; }
    /// <summary>Each column's byte rule (CellLengths.cs), from its type and, for char, varchar and text, its collation.</summary>
    public IReadOnlyList<ColumnLength> Lengths { get; }
    /// <summary>An upper bound on this set's descriptor in the query.execute summary and its resultSet events (MessagePack):
    /// its names and types, plus 96 bytes of keys and values per column (160 with a collation) and 512 per set.</summary>
    public long DescriptorBytes { get; }

    public static long DescriptorBytesOf(IEnumerable<ResultColumn> columns) =>
        512 + columns.Sum(column => Encoding.UTF8.GetByteCount(column.Name) + Encoding.UTF8.GetByteCount(column.DataType) + (column.Collation is null ? 96L : 160L));

    /// <summary>"xml" or "json" when the set is FOR XML or FOR JSON output, which <see cref="ForXmlCollector"/> joins into
    /// one value; otherwise null.</summary>
    public string? ForXml { get; private init; }
    /// <summary>Today's rule: a single column named "Microsoft SQL Server 2005 XML Showplan" is an execution plan.</summary>
    public bool IsPlan { get; }
    /// <summary>Whether the set has a long column (max types, text, ntext, image, xml, CLR types), whose values can reach
    /// 2 GB. Rows that are not stored are then read past synchronously, on a thread of their own
    /// (SqlService.SkipRowsAsync).</summary>
    public bool HasLong { get; }

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
            var timeScale = scale is >= 0 and <= 7 ? scale.Value : 7;
            var collation = IsCharType(provider) ? SqlClientCollation.Of(reader, i) : null;
            columns[i] = new Column(name, type, codec, wire, timeScale, cap, isLong, LengthOf(provider, timeScale, isLong, clrType, isPlan, collation));
            var exact = codec is CellCodec.Decimal or CellCodec.SqlDecimal;
            var scaled = codec is CellCodec.Time or CellCodec.DateTime2 or CellCodec.DateTimeOffset;
            descriptors[i] = new ResultColumn(name, type, wire == WireKind.Text ? "text" : "binary", role,
                MaxLength: !isLong && size is > 0 and < int.MaxValue && codec is CellCodec.Chars or CellCodec.Bytes ? size : null,
                Precision: exact ? precision : null, Scale: exact || scaled ? scale : null, Nullable: nullable, Collation: collation?.Info);
        }
        return new ColumnPlan(columns, descriptors, isPlan, hasLong) { ForXml = forXml };
    }

    private static bool IsCharType(int provider) => provider is (int)SqlDbType.Char or (int)SqlDbType.VarChar or (int)SqlDbType.Text
        or (int)SqlDbType.NChar or (int)SqlDbType.NVarChar or (int)SqlDbType.NText;

    /// <summary>A column's byte rule (CellLengths.cs): what DATALENGTH reports for its values, or for xml and json, which SQL
    /// Server stores in binary forms whose size no client sees, the size of the text it sends (UTF-16 and UTF-8).</summary>
    internal static ColumnLength LengthOf(int provider, int scale, bool isLong, Type? clrType, bool isPlan, SqlClientCollation.Column? collation)
    {
        var fraction = scale <= 2 ? 0 : scale <= 4 ? 1 : 2;
        return provider switch
        {
            (int)SqlDbType.Bit or (int)SqlDbType.TinyInt => ColumnLength.Fixed(1),
            (int)SqlDbType.SmallInt => ColumnLength.Fixed(2),
            (int)SqlDbType.Int or (int)SqlDbType.SmallMoney or (int)SqlDbType.Real or (int)SqlDbType.SmallDateTime => ColumnLength.Fixed(4),
            (int)SqlDbType.BigInt or (int)SqlDbType.Money or (int)SqlDbType.Float or (int)SqlDbType.DateTime => ColumnLength.Fixed(8),
            (int)SqlDbType.Decimal => ColumnLength.Decimal,
            (int)SqlDbType.Date => ColumnLength.Fixed(3),
            (int)SqlDbType.Time => ColumnLength.Fixed(3 + fraction),
            (int)SqlDbType.DateTime2 => ColumnLength.Fixed(6 + fraction),
            (int)SqlDbType.DateTimeOffset => ColumnLength.Fixed(8 + fraction),
            (int)SqlDbType.UniqueIdentifier => ColumnLength.Fixed(16),
            (int)SqlDbType.Char or (int)SqlDbType.VarChar or (int)SqlDbType.Text => ColumnLength.Chars(collation?.Encoding, collation?.Info.Utf8 == true),
            (int)SqlDbType.NChar or (int)SqlDbType.NVarChar or (int)SqlDbType.NText => ColumnLength.Utf16,
            (int)SqlDbType.Xml or VectorType or (int)SqlDbType.Variant => ColumnLength.Recorded,
            JsonType => ColumnLength.Utf8,
            (int)SqlDbType.Binary or (int)SqlDbType.VarBinary or (int)SqlDbType.Image or (int)SqlDbType.Timestamp or (int)SqlDbType.Udt => ColumnLength.Binary,
            _ when isLong && clrType == typeof(byte[]) => ColumnLength.Binary,
            // Execution plans and types this build does not know show as their text, counted as UTF-16.
            _ => ColumnLength.Utf16
        };
    }

    private static int? Int(DataRow row, string column) => row.Table.Columns.Contains(column) && row[column] is not DBNull and var value ? Convert.ToInt32(value, Invariant) : null;

    internal static (CellCodec Codec, WireKind Wire, string? Role, int Cap) Choose(int provider, int? precision, bool isLong, Type? clrType, bool isPlan)
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
            JsonType => (CellCodec.Json, text, "json", DocumentCap),
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
        var truncated = 0;
        for (var i = 0; i < columns.Length; i++)
        {
            var column = columns[i];
            if (reader.IsDBNull(i)) { builder.AppendNull(); continue; }
            try
            {
                cellChars = 0;
                cellBytes = column.Length.FixedBytes;
                cellExact = true;
                cellTailFailed = false;
                if (Read(column, reader, i, builder, token)) truncated++;
                if (cellBytes >= 0) builder.Measure(cellChars, cellBytes, column.Length.Rule == LengthRule.Recorded, cellExact);
                // The cell is stored, so it stays; only the column says that some values ended in an error.
                if (cellTailFailed && !column.TailWarned)
                {
                    column.TailWarned = true;
                    warn("Column ‘" + column.Name + "’ (" + column.Type + "): some values could not be read to the end and show only the part read before the error.");
                }
            }
            catch (Exception error) when (IsCellFailure(error))
            {
                builder.AppendNull(error: true);
                if (!column.Warned)
                {
                    column.Warned = true;
                    warn("Column ‘" + column.Name + "’ (" + column.Type + "): some values could not be read and are shown as NULL.");
                }
                column.Codec = column.Fallback;
            }
        }
        return truncated;
    }

    /// <summary>The reader a column switches to after a value its own could not read. GetValue reads a whole value, so long
    /// columns keep a streaming reader: GetTextReader for text, and xml and json their own (GetTextReader rejects xml, and
    /// throws on json when a read ends inside a multi-byte sequence).</summary>
    internal static CellCodec FallbackOf(CellCodec codec, WireKind wire, bool isLong) =>
        wire == WireKind.Binary ? CellCodec.Stream : codec == CellCodec.Json ? codec : !isLong ? CellCodec.Value : codec == CellCodec.Xml ? codec : CellCodec.LongText;

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
            case CellCodec.Decimal:
            {
                var span = builder.BeginFormatted();
                var value = reader.GetDecimal(i);
                return Decimal(builder, CellFormat.WriteDecimal(span, value), ColumnLength.DecimalBytes(value));
            }
            case CellCodec.SqlDecimal:
            {
                var span = builder.BeginFormatted();
                var value = reader.GetSqlDecimal(i);
                return Decimal(builder, CellFormat.WriteSqlDecimal(span, value), ColumnLength.DecimalBytes(value));
            }
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
            case CellCodec.Chars: return Chars(reader, i, column, builder, token);
            case CellCodec.Xml: return Xml(reader, i, column.Cap, builder, token);
            case CellCodec.Bytes: return Bytes(reader, i, column.Cap, builder, token);
            // SqlClient reports a NULL rowversion as not null with no bytes; a real one always has 8.
            case CellCodec.Timestamp:
                if (reader.GetBytes(i, 0, null, 0, 0) == 0)
                {
                    builder.AppendNull();
                    cellBytes = -1;
                    return false;
                }
                return Bytes(reader, i, column.Cap, builder, token);
            case CellCodec.Stream:
            {
                using var stream = reader.GetStream(i);
                return Binary(stream, column.Cap, builder, token);
            }
            case CellCodec.Variant: return Variant(reader.GetSqlValue(i), builder);
            case CellCodec.Vector:
            {
                var values = reader.GetFieldValue<SqlVector<float>>(i).Memory.Span;
                var text = CellFormat.Vector(values, VectorCap, out var cut, out var length);
                builder.AppendText(text, cut);
                // A vector is stored as an 8-byte header and 4 bytes per float32 dimension.
                cellChars = length;
                cellBytes = 8 + 4L * values.Length;
                return cut;
            }
            case CellCodec.Value: return Whole(column, Convert.ToString(reader.GetValue(i), Invariant) ?? "", builder);
            case CellCodec.Json: return Json(reader, i, column.Cap, builder, token);
            case CellCodec.LongText:
            {
                using var text = reader.GetTextReader(i);
                return Chars(text, column, builder, token);
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

    /// <summary>A formatted decimal: its bytes follow from its unscaled value's words (ColumnLength.DecimalBytes), read
    /// from the value rather than parsed back from its digits.</summary>
    private bool Decimal(PageBuilder builder, int written, int bytes)
    {
        cellChars = written;
        cellBytes = bytes;
        builder.EndFormatted(written);
        return false;
    }

    /// <summary>A value read whole as text: its lengths are the text's, its bytes by the column's rule.</summary>
    private bool Whole(Column column, ReadOnlySpan<char> value, PageBuilder builder)
    {
        column.Counter.Reset();
        column.Counter.Add(value);
        Counted(column, value.Length);
        return Text(value, TextCap, builder);
    }

    /// <summary>Sets the cell's lengths once its whole text has passed through the column's counter. A column whose rule is
    /// not text (one read through a fallback reader) keeps its fixed size; a decimal or recorded one counts 2 bytes a
    /// character as an estimate, kept in an entry so the row's sum and the cell's size agree.</summary>
    private void Counted(Column column, long chars)
    {
        cellChars = chars;
        if (column.Counter.Replaced) cellExact = false;
        var counted = column.Counter.Total();
        cellBytes = column.Length.Rule switch
        {
            LengthRule.Fixed => column.Length.FixedBytes,
            LengthRule.Utf16 or LengthRule.Utf8 or LengthRule.SingleByte or LengthRule.CodePage => counted,
            _ => 2 * chars
        };
        if (column.Length.Rule is not (LengthRule.Fixed or LengthRule.Utf16 or LengthRule.Utf8 or LengthRule.SingleByte or LengthRule.CodePage)) cellExact = false;
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
    private bool Chars(SqlDataReader reader, int i, Column column, PageBuilder builder, CancellationToken token)
    {
        var cap = column.Cap;
        var counter = column.Counter;
        counter.Reset();
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
        counter.Add(chars.AsSpan(0, total));
        long full = total;
        if (total == limit)
        {
            Chars(total + Chunk);
            for (long read; (read = reader.GetChars(i, full, chars, total, Chunk)) > 0; full += read)
            {
                token.ThrowIfCancellationRequested();
                counter.Add(chars.AsSpan(total, (int)read));
            }
        }
        Counted(column, full);
        return Text(chars.AsSpan(0, total), cap, builder);
    }

    /// <summary>json arrives as UTF-8, which it is decoded from here: SqlClient 7.1.1's GetChars under SequentialAccess
    /// decodes it one byte a character (é reads as Ã©), and its GetTextReader throws when a read ends inside a multi-byte
    /// sequence. The decoder carries a sequence split between chunks. Up to cap + 1 characters (and at most one chunk's
    /// more) are kept; the rest is decoded into the buffer after them only to be counted. The bytes are the UTF-8 read.</summary>
    private bool Json(SqlDataReader reader, int i, int cap, PageBuilder builder, CancellationToken token)
    {
        utf8.Reset();
        var limit = cap + 1;
        var kept = 0;
        long full = 0, offset = 0;
        Bytes(Chunk);
        while (true)
        {
            token.ThrowIfCancellationRequested();
            var read = (int)reader.GetBytes(i, offset, bytes, 0, Chunk);
            var input = bytes.AsSpan(0, Math.Max(read, 0));
            // A chunk decodes to at most one character a byte, plus one for a sequence carried from the last chunk.
            var decoded = utf8.GetChars(input, Chars(kept + input.Length + 1).Slice(kept, input.Length + 1), flush: read <= 0);
            full += decoded;
            if (kept < limit) kept += decoded;
            if (read <= 0) break;
            offset += read;
        }
        cellChars = full;
        cellBytes = offset;
        return Text(chars.AsSpan(0, kept), cap, builder);
    }

    private bool Chars(TextReader reader, Column column, PageBuilder builder, CancellationToken token)
    {
        var cap = column.Cap;
        var counter = column.Counter;
        counter.Reset();
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
        counter.Add(chars.AsSpan(0, total));
        long full = total;
        if (total == limit)
            for (int read; (read = reader.Read(Chars(total + Chunk).Slice(total, Chunk))) > 0; full += read)
            {
                token.ThrowIfCancellationRequested();
                counter.Add(chars.AsSpan(total, read));
            }
        Counted(column, full);
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
        long full = total;
        if (total == limit)
        {
            Bytes(total + Chunk);
            for (long read; (read = reader.GetBytes(i, full, bytes, total, Chunk)) > 0; full += read) token.ThrowIfCancellationRequested();
        }
        cellChars = cellBytes = full;
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
        long full = total;
        if (total == limit)
            for (int read; (read = stream.Read(Bytes(total + Chunk).Slice(total, Chunk))) > 0; full += read) token.ThrowIfCancellationRequested();
        cellChars = cellBytes = full;
        builder.AppendBinary(bytes.AsSpan(0, Math.Min(total, cap)), total > cap);
        return total > cap;
    }

    /// <summary>xml, up to cap + 1 characters, serialised node by node as SqlClient's GetChars would. GetChars itself holds
    /// each whole node in a StringBuilder and copies chunks out of it, in time quadratic in a large text node, and GetSqlXml
    /// reads the whole value (about 4 GB for a 2 GB one). Here XmlReader parses the column's stream as it arrives
    /// (<see cref="SequentialXml"/>), a text node's value is copied out in chunks, an <see cref="XmlFeed"/> cuts a node too
    /// large to hold, and once the cap is reached the rest of the value is read past as bytes, without parsing it.</summary>
    private bool Xml(SqlDataReader reader, int i, int cap, PageBuilder builder, CancellationToken token)
    {
        var sink = this.sink ??= new CharSink();
        sink.Reset(cap + 1);
        if ((XmlFallback is null ? SequentialXml.Open(reader, i) : null) is not { } stream)
        {
            using var fallback = XmlFallback?.Invoke(reader, i) ?? reader.GetXmlReader(i);
            var truncated = Xml(fallback, sink, null, cap, builder, token);
            // Without the column's own stream the bytes SQL Server sent are unknown: the serialised text (whole, or kept
            // up to the cap) stands in, as an estimate.
            cellChars = sink.Count;
            cellBytes = 2L * sink.Count;
            cellExact = false;
            // GetXmlReader owns its stream, so the rest is read past by parsing it.
            cellTailFailed = !ReadPastXml(fallback, chars, token);
            return truncated;
        }
        using (stream)
        {
            var feed = this.feed ??= new XmlFeed(() => this.sink!.Count);
            feed.Reset(stream);
            bool truncated;
            long consumed;
            try
            {
                using var xml = SequentialXml.Read(feed);
                truncated = Xml(xml, sink, feed, cap, builder, token);
            }
            catch (XmlException)
            {
                ReadPast(stream, token);
                throw;
            }
            finally
            {
                consumed = feed.Consumed;
                feed.Reset(Stream.Null);
            }
            // The stream is the value's UTF-16 text as SQL Server sends it (no byte order mark): its bytes are the cell's,
            // and so are its characters, cut or not, so that lengths compare across a column (the display text may differ:
            // SqlClient's serialisation writes <e /> for SQL Server's <e/>).
            cellBytes = consumed + ReadPast(stream, token);
            cellChars = cellBytes / 2;
            return truncated;
        }
    }

    /// <summary>Reads past the rest of an xml value that GetXmlReader parses, once its cell is stored. A parse failure (any
    /// exception ReadRow counts as a cell failure) ends the read-past and returns false, so ReadRow warns for the column:
    /// thrown, it would make ReadRow append the cell a second time.</summary>
    internal static bool ReadPastXml(XmlReader xml, char[] buffer, CancellationToken token)
    {
        try
        {
            while (xml.Read())
            {
                token.ThrowIfCancellationRequested();
                if (xml.NodeType == XmlNodeType.Text) while (xml.ReadValueChunk(buffer, 0, Math.Min(buffer.Length, Chunk)) > 0) token.ThrowIfCancellationRequested();
            }
            return true;
        }
        catch (Exception error) when (IsCellFailure(error))
        {
            // A Stop can cut the value short, which parses as a malformed end: that is the Stop, not a value to warn about.
            token.ThrowIfCancellationRequested();
            return false;
        }
    }

    private bool Xml(XmlReader xml, CharSink sink, XmlFeed? feed, int cap, PageBuilder builder, CancellationToken token)
    {
        // Never closed: closing ends open elements, which would only add text past a full sink.
        var writer = XmlWriter.Create(sink, XmlOutput);
        try
        {
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
        }
        // The feed ended the stream inside a node, which XmlReader reports as an unexpected end.
        catch (XmlException) when (feed?.Starved == true) { }
        if (!sink.Full) writer.Flush();
        if (feed?.Starved != true || sink.Full) return Text(sink.Text, cap, builder);
        // The text before the node the feed cut is kept, marked truncated.
        var text = sink.Text;
        if (text.Length > 0 && char.IsHighSurrogate(text[^1])) text = text[..^1];
        builder.AppendText(text, true);
        return true;
    }

    /// <summary>Reads past the rest of a column's stream in chunks; returns the bytes read.</summary>
    private long ReadPast(Stream stream, CancellationToken token)
    {
        Bytes(Chunk);
        long total = 0;
        for (int read; (read = stream.Read(bytes, 0, Chunk)) > 0; total += read) token.ThrowIfCancellationRequested();
        return total;
    }

    /// <summary>A TextWriter that keeps the first <c>limit</c> characters written to it since <see cref="Reset"/> and drops the
    /// rest. Its buffer is kept across cells, as <see cref="chars"/> is.</summary>
    private sealed class CharSink : TextWriter
    {
        private char[] buffer = new char[Chunk];
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

    /// <summary>sql_variant: formatted by its base type as the rows above would; binary values become 0x text. Its bytes are
    /// the base value's, as DATALENGTH reports them, where SqlClient tells the base type apart. Where it does not, the bytes
    /// are an estimate and the cell's entry says so: a varchar value arrives as the same SqlString as an nvarchar one and
    /// counts 2 bytes a character, smallmoney and smalldatetime count as money and datetime (8), and date, time, datetime2
    /// and datetimeoffset as at scale 7 (8, 5, 8 and 10).</summary>
    private bool Variant(object value, PageBuilder builder)
    {
        switch (value)
        {
            case SqlBoolean bit: return Formatted(builder, CellFormat.WriteBit(builder.BeginFormatted(), bit.Value), 1);
            case SqlByte number: return Formatted(builder, CellFormat.WriteInteger(builder.BeginFormatted(), number.Value), 1);
            case SqlInt16 number: return Formatted(builder, CellFormat.WriteInteger(builder.BeginFormatted(), number.Value), 2);
            case SqlInt32 number: return Formatted(builder, CellFormat.WriteInteger(builder.BeginFormatted(), number.Value), 4);
            case SqlInt64 number: return Formatted(builder, CellFormat.WriteInteger(builder.BeginFormatted(), number.Value), 8);
            case SqlDecimal number:
            {
                var span = builder.BeginFormatted();
                return Decimal(builder, number.Precision <= 28 ? CellFormat.WriteDecimal(span, number.Value) : CellFormat.WriteSqlDecimal(span, number), ColumnLength.DecimalBytes(number));
            }
            case SqlMoney money: return Estimated(Formatted(builder, CellFormat.WriteMoney(builder.BeginFormatted(), money.Value), 8));
            case SqlSingle number: return Formatted(builder, CellFormat.WriteReal(builder.BeginFormatted(), number.Value), 4);
            case SqlDouble number: return Formatted(builder, CellFormat.WriteFloat(builder.BeginFormatted(), number.Value), 8);
            case SqlDateTime date: return Estimated(Formatted(builder, CellFormat.WriteDateTime(builder.BeginFormatted(), date.Value), 8));
            // date, time, datetime2 and datetimeoffset have no Sql* type; their scale is not reported, so all 7 digits show.
            case DateTime date: return Estimated(Formatted(builder, CellFormat.WriteDateTime2(builder.BeginFormatted(), date, 7), 8));
            case TimeSpan time: return Estimated(Formatted(builder, CellFormat.WriteTime(builder.BeginFormatted(), time, 7), 5));
            case DateTimeOffset date: return Estimated(Formatted(builder, CellFormat.WriteDateTimeOffset(builder.BeginFormatted(), date, 7), 10));
            case SqlGuid guid: return Formatted(builder, CellFormat.WriteGuid(builder.BeginFormatted(), guid.Value), 16);
            case SqlString text: return Estimated(Unicode(text.Value, builder));
            case SqlBinary binary:
            {
                var bytes = binary.Value;
                var fits = Math.Min(bytes.Length, (TextCap - 2) / 2);
                builder.AppendText("0x" + Convert.ToHexString(bytes, 0, fits), fits < bytes.Length);
                cellChars = 2 + 2L * bytes.Length;
                cellBytes = bytes.Length;
                return fits < bytes.Length;
            }
            default: return Estimated(Unicode(Convert.ToString(value, Invariant) ?? "", builder));
        }
    }

    private bool Estimated(bool truncated)
    {
        cellExact = false;
        return truncated;
    }

    private bool Formatted(PageBuilder builder, int written, long bytes)
    {
        builder.EndFormatted(written);
        cellChars = written;
        cellBytes = bytes;
        return false;
    }

    private bool Unicode(string value, PageBuilder builder)
    {
        cellChars = value.Length;
        cellBytes = 2L * value.Length;
        return Text(value, TextCap, builder);
    }
}
