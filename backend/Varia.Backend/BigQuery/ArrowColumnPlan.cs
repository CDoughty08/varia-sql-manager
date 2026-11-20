using System.Buffers;
using System.Buffers.Binary;
using System.Buffers.Text;
using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.Json;
using Apache.Arrow;
using Apache.Arrow.Ipc;
using Apache.Arrow.Types;
using Varia.Backend.Results;

namespace Varia.Backend.BigQuery;

/// <summary>
/// The Storage Read reader of a BigQuery result set (docs/bigquery.md, Storage Read): each Arrow record batch decoded
/// straight into a <see cref="PageBuilder"/>, as <see cref="BigQueryColumnPlan"/> reads REST rows, with the same columns,
/// caps, read errors and display text, so a result reads byte-identically either way (the golden check). The REST schema
/// gives each column's GoogleSQL kind; the Arrow schema must name the same columns in the same order. A column Arrow sends
/// as text (a type it has no Arrow form for) is read as REST's text is.
/// </summary>
internal sealed class ArrowColumnPlan
{
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    private readonly BigQueryColumnPlan plan;
    private readonly IReadOnlyList<BigQueryField> fields;
    private readonly byte[] schema;
    private readonly ArrayBufferWriter<byte> json = new(1024);
    private byte[] message = [];
    private readonly byte[] scratch = new byte[256];

    private ArrowColumnPlan(BigQueryColumnPlan plan, byte[] schema)
    {
        this.plan = plan;
        fields = plan.Fields;
        this.schema = schema;
    }

    /// <summary>The plan for a read session's Arrow schema (its serialized IPC message), or null when its columns are not the
    /// REST schema's, in order.</summary>
    public static ArrowColumnPlan? From(BigQueryColumnPlan plan, ReadOnlyMemory<byte> serializedSchema)
    {
        Schema arrow;
        try
        {
            using var reader = new ArrowStreamReader(serializedSchema);
            arrow = reader.Schema;
        }
        catch (Exception error) when (error is InvalidDataException or IOException or ArgumentException or InvalidOperationException or NotSupportedException or OverflowException) { return null; }
        if (arrow is null || arrow.FieldsList.Count != plan.Fields.Count) return null;
        for (var i = 0; i < plan.Fields.Count; i++)
            if (!string.Equals(arrow.FieldsList[i].Name, plan.Fields[i].Name, StringComparison.OrdinalIgnoreCase)) return null;
        return new ArrowColumnPlan(plan, serializedSchema.ToArray());
    }

    /// <summary>One ReadRows message's record batch (its serialized IPC message), read with the session's schema. The batch
    /// refers to a buffer this plan reuses, so it is read before the next one is decoded.</summary>
    public RecordBatch Decode(ReadOnlySpan<byte> batch)
    {
        // The emulator sends a whole stream (its schema, then the batch) where Google sends the batch's message alone.
        var own = IsSchema(batch);
        var length = (own ? 0 : schema.Length) + batch.Length;
        // Exactly the size needed, so the buffer is never more than the largest batch (which its charge covers).
        if (message.Length < length) message = new byte[length];
        if (!own) schema.CopyTo(message, 0);
        batch.CopyTo(message.AsSpan(length - batch.Length));
        using var reader = new ArrowStreamReader(message.AsMemory(0, length));
        var decoded = reader.ReadNextRecordBatch() ?? throw new InvalidDataException("BigQuery answered a record batch Varia cannot read.");
        if (decoded.ColumnCount != fields.Count) { decoded.Dispose(); throw new InvalidDataException("BigQuery answered a record batch Varia cannot read."); }
        return decoded;
    }

    /// <summary>Whether an IPC message is a schema (Arrow's Message flatbuffer: continuation marker, metadata length, then the
    /// root table, whose second field is the header type, 1 for a schema).</summary>
    internal static bool IsSchema(ReadOnlySpan<byte> message)
    {
        if (message.Length < 16 || BinaryPrimitives.ReadUInt32LittleEndian(message) != 0xFFFFFFFF) return false;
        // Offsets in long: a malformed message's offsets near int.MaxValue must answer false, not overflow past the checks.
        var flat = message[8..];
        long table = BinaryPrimitives.ReadUInt32LittleEndian(flat);
        if (table + 4 > flat.Length) return false;
        var vtable = table - BinaryPrimitives.ReadInt32LittleEndian(flat[(int)table..]);
        if (vtable < 0 || vtable + 4 > flat.Length) return false;
        var size = BinaryPrimitives.ReadUInt16LittleEndian(flat[(int)vtable..]);
        if (size < 8 || vtable + size > flat.Length) return false;
        var field = BinaryPrimitives.ReadUInt16LittleEndian(flat[(int)(vtable + 6)..]);
        return field != 0 && table + field < flat.Length && flat[(int)(table + field)] == 1;
    }

    /// <summary>Appends one row of a batch. Returns the number of cells stored as truncated prefixes.</summary>
    public int ReadRow(RecordBatch batch, int row, PageBuilder builder, Action<string> warn)
    {
        var truncated = 0;
        for (var i = 0; i < fields.Count; i++)
        {
            var array = batch.Column(i);
            if (array.IsNull(row)) { builder.AppendNull(); continue; }
            try { if (Read(fields[i], plan.CapOfColumn(i), array, row, builder)) truncated++; }
            catch (Exception error) when (error is FormatException or InvalidDataException or OverflowException or InvalidCastException or ArgumentException or JsonException)
            {
                plan.ReadError(i, builder, warn);
            }
        }
        return truncated;
    }

    bool Read(BigQueryField field, int cap, IArrowArray array, int row, PageBuilder builder)
    {
        if (field.Repeated || field.Kind == BigQueryKind.Struct) return Document(field, cap, array, row, builder);
        // A value Arrow carries as text is read as REST's text is.
        if (array is StringArray text && field.Kind is not (BigQueryKind.String or BigQueryKind.Geography or BigQueryKind.Json))
            return plan.ReadScalar(field, cap, text.GetBytes(row), builder);
        switch (field.Kind)
        {
            case BigQueryKind.Int64:
            {
                var value = Integer(array, row);
                return Utf8Formatter.TryFormat(value, scratch, out var written) ? BigQueryColumnPlan.Fixed(builder, scratch.AsSpan(0, written), 8) : throw new FormatException();
            }
            case BigQueryKind.Float64:
            {
                var value = array is DoubleArray doubles ? doubles.Values[row] : throw new InvalidCastException();
                return value.TryFormat(scratch, out var written, "R", Invariant) ? BigQueryColumnPlan.Fixed(builder, scratch.AsSpan(0, written), 8) : throw new FormatException();
            }
            case BigQueryKind.Bool:
                return BigQueryColumnPlan.Fixed(builder, ((BooleanArray)array).GetValue(row) == true ? "true"u8 : "false"u8, 1);
            case BigQueryKind.Numeric or BigQueryKind.BigNumeric:
                return BigQueryColumnPlan.Decimal(builder, scratch.AsSpan(0, Decimal(array, row, scratch)), field.Kind);
            case BigQueryKind.String or BigQueryKind.Geography or BigQueryKind.Json:
                return BigQueryColumnPlan.Utf8Text(((StringArray)array).GetBytes(row), cap, builder);
            case BigQueryKind.Bytes:
                return BigQueryColumnPlan.Binary(builder, ((BinaryArray)array).GetBytes(row), cap);
            case BigQueryKind.Date:
                return BigQueryColumnPlan.Fixed(builder, scratch.AsSpan(0, BigQueryText.Date(Days(array, row), scratch)), 8);
            case BigQueryKind.Time:
                return BigQueryColumnPlan.Fixed(builder, scratch.AsSpan(0, BigQueryText.Time(TimeMicros(array, row), scratch)), 8);
            case BigQueryKind.DateTime:
                return BigQueryColumnPlan.Fixed(builder, scratch.AsSpan(0, BigQueryText.DateTime(Micros(array, row), scratch)), 8);
            case BigQueryKind.Timestamp:
                return BigQueryColumnPlan.Fixed(builder, scratch.AsSpan(0, BigQueryText.Timestamp(Micros(array, row), scratch)), 8);
            case BigQueryKind.Interval:
                return BigQueryColumnPlan.Fixed(builder, scratch.AsSpan(0, Interval(array, row, scratch)), 16);
            case BigQueryKind.Range:
                return BigQueryColumnPlan.Text(Range(field.RangeElement, array, row), cap, builder);
            default:
                throw new FormatException("The value's type is not one Varia reads.");
        }
    }

    static long Integer(IArrowArray array, int row) => array switch
    {
        Int64Array values => values.Values[row],
        Int32Array values => values.Values[row],
        _ => throw new InvalidCastException()
    };

    /// <summary>NUMERIC (Arrow decimal128, scale 9) and BIGNUMERIC (decimal256, scale 38) as canonical decimal text.</summary>
    static int Decimal(IArrowArray array, int row, Span<byte> destination)
    {
        switch (array)
        {
            case Decimal128Array values:
            {
                var bytes = values.GetBytes(row);
                var unscaled = new Int128(BinaryPrimitives.ReadUInt64LittleEndian(bytes[8..]), BinaryPrimitives.ReadUInt64LittleEndian(bytes));
                return BigQueryText.Decimal(unscaled, ((Decimal128Type)values.Data.DataType).Scale, destination);
            }
            case Decimal256Array values:
                return BigQueryText.Decimal(new BigInteger(values.GetBytes(row), isUnsigned: false, isBigEndian: false), ((Decimal256Type)values.Data.DataType).Scale, destination);
            default:
                throw new InvalidCastException();
        }
    }

    static long Days(IArrowArray array, int row) => array switch
    {
        Date32Array values => values.Values[row],
        Date64Array values => Math.DivRem(values.Values[row], 86_400_000L).Quotient,
        _ => throw new InvalidCastException()
    };

    static long TimeMicros(IArrowArray array, int row) => array switch
    {
        Time64Array values => ((Time64Type)values.Data.DataType).Unit == TimeUnit.Nanosecond ? values.Values[row] / 1000 : values.Values[row],
        Time32Array values => ((Time32Type)values.Data.DataType).Unit == TimeUnit.Millisecond ? values.Values[row] * 1000L : values.Values[row] * 1_000_000L,
        _ => throw new InvalidCastException()
    };

    /// <summary>A TIMESTAMP or DATETIME (an Arrow timestamp with or without a zone) in microseconds from the epoch.</summary>
    static long Micros(IArrowArray array, int row)
    {
        if (array is not TimestampArray values) throw new InvalidCastException();
        var value = values.Values[row];
        return ((TimestampType)values.Data.DataType).Unit switch
        {
            TimeUnit.Second => checked(value * 1_000_000),
            TimeUnit.Millisecond => checked(value * 1000),
            TimeUnit.Nanosecond => Math.DivRem(value, 1000L) is var (q, r) && r < 0 ? q - 1 : q,
            _ => value
        };
    }

    static int Interval(IArrowArray array, int row, Span<byte> destination)
    {
        if (array is not MonthDayNanosecondIntervalArray values || values.GetValue(row) is not { } value) throw new InvalidCastException();
        return BigQueryText.Interval(value.Months, value.Days, value.Nanoseconds / 1000, destination);
    }

    /// <summary>RANGE: Arrow's struct of start and end, a null bound unbounded.</summary>
    string Range(BigQueryKind element, IArrowArray array, int row)
    {
        if (array is not StructArray range || range.Fields.Count != 2) throw new InvalidCastException();
        var index = range.Offset + row;
        return "[" + Bound(element, range.Fields[0], index) + ", " + Bound(element, range.Fields[1], index) + ")";
    }

    string Bound(BigQueryKind element, IArrowArray array, int index)
    {
        if (array.IsNull(index)) return "UNBOUNDED";
        Span<byte> buffer = stackalloc byte[64];
        var written = element switch
        {
            BigQueryKind.Date => BigQueryText.Date(Days(array, index), buffer),
            BigQueryKind.DateTime => BigQueryText.DateTime(Micros(array, index), buffer),
            BigQueryKind.Timestamp => BigQueryText.Timestamp(Micros(array, index), buffer),
            _ => throw new FormatException("The RANGE's element is not one Varia reads.")
        };
        return Encoding.ASCII.GetString(buffer[..written]);
    }

    /// <summary>STRUCT and ARRAY: compact JSON text written as REST's reader writes it.</summary>
    bool Document(BigQueryField field, int cap, IArrowArray array, int row, PageBuilder builder)
    {
        json.Clear();
        using (var writer = new Utf8JsonWriter(json, BigQueryColumnPlan.Compact)) WriteValue(writer, field, array, row, field.Repeated, 0);
        return BigQueryColumnPlan.Utf8Text(json.WrittenSpan, cap, builder);
    }

    void WriteValue(Utf8JsonWriter writer, BigQueryField field, IArrowArray array, int index, bool repeated, int depth)
    {
        if (depth > BigQueryField.MaxDepth * 2 + 2) throw new InvalidDataException("The value nests deeper than BigQuery allows.");
        if (array.IsNull(index)) { writer.WriteNullValue(); return; }
        if (repeated)
        {
            if (array is not ListArray list) throw new InvalidCastException();
            var offsets = list.ValueOffsets;
            writer.WriteStartArray();
            for (var item = offsets[index]; item < offsets[index + 1]; item++) WriteValue(writer, field, list.Values, item, false, depth + 1);
            writer.WriteEndArray();
            return;
        }
        if (field.Kind == BigQueryKind.Struct)
        {
            if (array is not StructArray members || members.Fields.Count != field.Fields.Length) throw new InvalidCastException();
            writer.WriteStartObject();
            for (var i = 0; i < field.Fields.Length; i++)
            {
                var child = field.Fields[i];
                writer.WritePropertyName(child.Name);
                WriteValue(writer, child, members.Fields[i], members.Offset + index, child.Repeated, depth + 1);
            }
            writer.WriteEndObject();
            return;
        }
        if (array is StringArray text && field.Kind is not (BigQueryKind.String or BigQueryKind.Geography))
        {
            plan.WriteScalarText(writer, field, text.GetBytes(index));
            return;
        }
        Span<byte> buffer = stackalloc byte[128];
        switch (field.Kind)
        {
            case BigQueryKind.Bool: writer.WriteBooleanValue(((BooleanArray)array).GetValue(index) == true); break;
            case BigQueryKind.Int64:
                writer.WriteStringValue(Utf8Formatter.TryFormat(Integer(array, index), buffer, out var integer) ? buffer[..integer] : throw new FormatException());
                break;
            case BigQueryKind.Numeric or BigQueryKind.BigNumeric: writer.WriteStringValue(buffer[..Decimal(array, index, buffer)]); break;
            case BigQueryKind.Float64: BigQueryColumnPlan.WriteFloatMember(writer, ((DoubleArray)array).Values[index]); break;
            case BigQueryKind.Timestamp: writer.WriteStringValue(buffer[..BigQueryText.Timestamp(Micros(array, index), buffer)]); break;
            case BigQueryKind.Date: writer.WriteStringValue(buffer[..BigQueryText.Date(Days(array, index), buffer)]); break;
            case BigQueryKind.Time: writer.WriteStringValue(buffer[..BigQueryText.Time(TimeMicros(array, index), buffer)]); break;
            case BigQueryKind.DateTime: writer.WriteStringValue(buffer[..BigQueryText.DateTime(Micros(array, index), buffer)]); break;
            case BigQueryKind.Interval: writer.WriteStringValue(buffer[..Interval(array, index, buffer)]); break;
            case BigQueryKind.Range: writer.WriteStringValue(Range(field.RangeElement, array, index)); break;
            case BigQueryKind.Bytes: writer.WriteStringValue(Convert.ToBase64String(((BinaryArray)array).GetBytes(index))); break;
            case BigQueryKind.Json: BigQueryColumnPlan.WriteJsonMember(writer, Encoding.UTF8.GetString(((StringArray)array).GetBytes(index))); break;
            case BigQueryKind.String or BigQueryKind.Geography: writer.WriteStringValue(((StringArray)array).GetBytes(index)); break;
            default: throw new FormatException("The value's type is not one Varia reads.");
        }
    }
}
