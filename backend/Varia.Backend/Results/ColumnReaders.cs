using System.Data;
using System.Data.SqlTypes;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Microsoft.Data.SqlTypes;

namespace Varia.Backend.Results;

/// <summary>How one column's cells are read (docs/ipc.md, SQL type → reader → wire → display).</summary>
internal enum CellCodec : byte
{
    Bit, Byte, Int16, Int32, Int64, Decimal, SqlDecimal, Money, Real, Float, Date, Time, SmallDateTime, DateTime, DateTime2, DateTimeOffset, Guid,
    Chars, Bytes, Timestamp, Stream, Variant, Vector, Value, LongText, Unreadable
}

/// <summary>The codecs for one result set, chosen once from its schema (never by catching exceptions per cell). Reads
/// follow CommandBehavior.SequentialAccess: IsDBNull first, then each column once, in ordinal order. Long values are read
/// in 8,192-unit chunks only up to their cap plus one, so a huge value never materialises; SqlClient skips the rest.</summary>
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

    private ColumnPlan(Column[] columns, IReadOnlyList<ResultColumn> descriptors, bool isPlan)
    {
        this.columns = columns;
        Columns = descriptors;
        Wires = [.. columns.Select(column => column.Wire)];
        IsPlan = isPlan;
    }

    public IReadOnlyList<ResultColumn> Columns { get; }
    public IReadOnlyList<WireKind> Wires { get; }
    /// <summary>Today's rule: a single column named "Microsoft SQL Server 2005 XML Showplan" is an execution plan.</summary>
    public bool IsPlan { get; }

    public static ColumnPlan From(SqlDataReader reader)
    {
        var count = reader.FieldCount;
        var schema = reader.GetSchemaTable() ?? throw new InvalidOperationException("The result set has no schema.");
        var isPlan = count == 1 && reader.GetName(0).Equals(ShowplanColumn, StringComparison.OrdinalIgnoreCase);
        var columns = new Column[count];
        var descriptors = new ResultColumn[count];
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
            var nullable = row["AllowDBNull"] is not false;
            var clrType = row["DataType"] as Type;
            var (codec, wire, role, cap) = Choose(provider, precision, isLong, clrType, isPlan);
            columns[i] = new Column(name, type, codec, wire, scale is >= 0 and <= 7 ? scale.Value : 7, cap);
            var exact = codec is CellCodec.Decimal or CellCodec.SqlDecimal;
            var scaled = codec is CellCodec.Time or CellCodec.DateTime2 or CellCodec.DateTimeOffset;
            descriptors[i] = new ResultColumn(name, type, wire == WireKind.Text ? "text" : "binary", role,
                MaxLength: !isLong && size is > 0 and < int.MaxValue && codec is CellCodec.Chars or CellCodec.Bytes ? size : null,
                Precision: exact ? precision : null, Scale: exact || scaled ? scale : null, Nullable: nullable);
        }
        return new ColumnPlan(columns, descriptors, isPlan);
    }

    private static int? Int(DataRow row, string column) => row.Table.Columns.Contains(column) && row[column] is not DBNull and var value ? Convert.ToInt32(value, Invariant) : null;

    private static (CellCodec Codec, WireKind Wire, string? Role, int Cap) Choose(int provider, int? precision, bool isLong, Type? clrType, bool isPlan)
    {
        const WireKind text = WireKind.Text, binary = WireKind.Binary;
        if (isPlan) return (CellCodec.Chars, text, "plan", DocumentCap);
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
            (int)SqlDbType.Char or (int)SqlDbType.VarChar or (int)SqlDbType.Text or (int)SqlDbType.NChar or (int)SqlDbType.NVarChar or (int)SqlDbType.NText => (CellCodec.Chars, text, null, TextCap),
            (int)SqlDbType.Xml => (CellCodec.Chars, text, "xml", DocumentCap),
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
    public int ReadRow(SqlDataReader reader, PageBuilder builder, Action<string> warn)
    {
        var truncated = 0;
        for (var i = 0; i < columns.Length; i++)
        {
            var column = columns[i];
            if (reader.IsDBNull(i)) { builder.AppendNull(); continue; }
            try { if (Read(column, reader, i, builder)) truncated++; }
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
        or NotSupportedException or SqlTypeException or FileNotFoundException or FileLoadException or TypeLoadException or InvalidDataException;

    private bool Read(Column column, SqlDataReader reader, int i, PageBuilder builder)
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
            case CellCodec.Chars: return Chars(reader, i, column.Cap, builder);
            case CellCodec.Bytes: return Bytes(reader, i, column.Cap, builder);
            // SqlClient reports a NULL rowversion as not null with no bytes; a real one always has 8.
            case CellCodec.Timestamp:
                if (reader.GetBytes(i, 0, null, 0, 0) == 0) { builder.AppendNull(); return false; }
                return Bytes(reader, i, column.Cap, builder);
            case CellCodec.Stream:
            {
                using var stream = reader.GetStream(i);
                return Binary(stream, column.Cap, builder);
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
                return Chars(text, column.Cap, builder);
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

    /// <summary>Reads at most cap + 1 characters, so a longer value is known to be truncated without reading it all.</summary>
    private bool Chars(SqlDataReader reader, int i, int cap, PageBuilder builder)
    {
        var limit = cap + 1;
        var total = 0;
        while (total < limit)
        {
            var length = Math.Min(Chunk, limit - total);
            Chars(total + length);
            var read = (int)reader.GetChars(i, total, chars, total, length);
            if (read <= 0) break;
            total += read;
        }
        return Text(chars.AsSpan(0, total), cap, builder);
    }

    private bool Chars(TextReader reader, int cap, PageBuilder builder)
    {
        var limit = cap + 1;
        var total = 0;
        while (total < limit)
        {
            var length = Math.Min(Chunk, limit - total);
            var read = reader.Read(Chars(total + length).Slice(total, length));
            if (read <= 0) break;
            total += read;
        }
        return Text(chars.AsSpan(0, total), cap, builder);
    }

    private bool Bytes(SqlDataReader reader, int i, int cap, PageBuilder builder)
    {
        var limit = cap + 1;
        var total = 0;
        while (total < limit)
        {
            var length = Math.Min(Chunk, limit - total);
            Bytes(total + length);
            var read = (int)reader.GetBytes(i, total, bytes, total, length);
            if (read <= 0) break;
            total += read;
        }
        builder.AppendBinary(bytes.AsSpan(0, Math.Min(total, cap)), total > cap);
        return total > cap;
    }

    private bool Binary(Stream stream, int cap, PageBuilder builder)
    {
        var limit = cap + 1;
        var total = 0;
        while (total < limit)
        {
            var length = Math.Min(Chunk, limit - total);
            var read = stream.Read(Bytes(total + length).Slice(total, length));
            if (read <= 0) break;
            total += read;
        }
        builder.AppendBinary(bytes.AsSpan(0, Math.Min(total, cap)), total > cap);
        return total > cap;
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
