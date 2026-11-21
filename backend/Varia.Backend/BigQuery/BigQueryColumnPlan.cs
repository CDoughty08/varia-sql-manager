using System.Buffers;
using System.Buffers.Text;
using System.Globalization;
using System.Numerics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.BigQuery;

/// <summary>GoogleSQL's types as a result schema names them; the legacy spellings (INTEGER, FLOAT, BOOLEAN, RECORD) read as
/// the GoogleSQL ones.</summary>
internal enum BigQueryKind : byte
{
    Int64, Float64, Numeric, BigNumeric, Bool, String, Bytes, Date, Time, DateTime, Timestamp, Interval, Range, Geography, Json, Struct, Unknown
}

/// <summary>One field of a result schema (a column, or a STRUCT's member): its kind, whether it is an ARRAY (mode REPEATED),
/// its members, a RANGE's element kind, and its GoogleSQL type text.</summary>
internal sealed class BigQueryField
{
    /// <summary>BigQuery nests STRUCTs at most 15 deep; a deeper schema is not one BigQuery sends.</summary>
    public const int MaxDepth = 15;
    /// <summary>The most fields Varia reads from one schema, members included (BigQuery allows 10,000 columns).</summary>
    public const int MaxFields = 20_000;

    public required string Name { get; init; }
    public required BigQueryKind Kind { get; init; }
    public bool Repeated { get; init; }
    public bool Required { get; init; }
    public BigQueryField[] Fields { get; init; } = [];
    public BigQueryKind RangeElement { get; init; } = BigQueryKind.Unknown;
    /// <summary>The type name as the schema gave it, for a type Varia does not know (letters, digits and underscores only).</summary>
    public string? Unknown { get; init; }
    public long? Precision { get; init; }
    public long? Scale { get; init; }
    public long? MaxLength { get; init; }

    /// <summary>The fields of a schema's <c>fields</c> array, refusing a shape BigQuery does not send.</summary>
    public static BigQueryField[] Parse(JsonElement fields)
    {
        var count = 0;
        return ParseFields(fields, 0, ref count);
    }

    static BigQueryField[] ParseFields(JsonElement fields, int depth, ref int count)
    {
        if (fields.ValueKind != JsonValueKind.Array || depth > MaxDepth) throw new InvalidDataException("BigQuery answered a result schema Varia cannot read.");
        var result = new BigQueryField[fields.GetArrayLength()];
        var index = 0;
        foreach (var field in fields.EnumerateArray())
        {
            if (++count > MaxFields || field.ValueKind != JsonValueKind.Object) throw new InvalidDataException("BigQuery answered a result schema Varia cannot read.");
            var type = String(field, "type")?.ToUpperInvariant() ?? "";
            var mode = String(field, "mode")?.ToUpperInvariant();
            var kind = KindOf(type);
            var members = kind == BigQueryKind.Struct
                ? field.TryGetProperty("fields", out var nested) ? ParseFields(nested, depth + 1, ref count) : throw new InvalidDataException("BigQuery answered a STRUCT without its fields.")
                : [];
            var element = kind == BigQueryKind.Range && field.TryGetProperty("rangeElementType", out var range) && range.ValueKind == JsonValueKind.Object
                ? KindOf(String(range, "type")?.ToUpperInvariant() ?? "") : BigQueryKind.Unknown;
            result[index++] = new BigQueryField
            {
                Name = String(field, "name") ?? "", Kind = kind, Repeated = mode == "REPEATED", Required = mode == "REQUIRED", Fields = members, RangeElement = element,
                Unknown = kind == BigQueryKind.Unknown ? Sanitized(type) : null,
                Precision = Number(field, "precision"), Scale = Number(field, "scale"), MaxLength = Number(field, "maxLength")
            };
        }
        return result;
    }

    static string? String(JsonElement value, string name) => value.TryGetProperty(name, out var member) && member.ValueKind == JsonValueKind.String ? member.GetString() : null;

    /// <summary>A parameterized type's figure (precision, scale, maxLength), sent as a decimal string.</summary>
    static long? Number(JsonElement value, string name) =>
        value.TryGetProperty(name, out var member) && member.ValueKind == JsonValueKind.String && long.TryParse(member.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out var number) ? number
        : value.TryGetProperty(name, out member) && member.ValueKind == JsonValueKind.Number && member.TryGetInt64(out number) && number >= 0 ? number : null;

    static string Sanitized(string type)
    {
        var kept = new string([.. type.Where(c => char.IsAsciiLetterOrDigit(c) || c == '_').Take(64)]);
        return kept.Length == 0 ? "UNKNOWN" : kept;
    }

    public static BigQueryKind KindOf(string type) => type switch
    {
        "INT64" or "INTEGER" => BigQueryKind.Int64,
        "FLOAT64" or "FLOAT" => BigQueryKind.Float64,
        "NUMERIC" or "DECIMAL" => BigQueryKind.Numeric,
        "BIGNUMERIC" or "BIGDECIMAL" => BigQueryKind.BigNumeric,
        "BOOL" or "BOOLEAN" => BigQueryKind.Bool,
        "STRING" => BigQueryKind.String,
        "BYTES" => BigQueryKind.Bytes,
        "DATE" => BigQueryKind.Date,
        "TIME" => BigQueryKind.Time,
        "DATETIME" => BigQueryKind.DateTime,
        "TIMESTAMP" => BigQueryKind.Timestamp,
        "INTERVAL" => BigQueryKind.Interval,
        "RANGE" => BigQueryKind.Range,
        "GEOGRAPHY" => BigQueryKind.Geography,
        "JSON" => BigQueryKind.Json,
        "STRUCT" or "RECORD" => BigQueryKind.Struct,
        _ => BigQueryKind.Unknown
    };

    static string BaseName(BigQueryKind kind) => kind switch
    {
        BigQueryKind.Int64 => "INT64", BigQueryKind.Float64 => "FLOAT64", BigQueryKind.Numeric => "NUMERIC", BigQueryKind.BigNumeric => "BIGNUMERIC",
        BigQueryKind.Bool => "BOOL", BigQueryKind.String => "STRING", BigQueryKind.Bytes => "BYTES", BigQueryKind.Date => "DATE", BigQueryKind.Time => "TIME",
        BigQueryKind.DateTime => "DATETIME", BigQueryKind.Timestamp => "TIMESTAMP", BigQueryKind.Interval => "INTERVAL", BigQueryKind.Range => "RANGE",
        BigQueryKind.Geography => "GEOGRAPHY", BigQueryKind.Json => "JSON", BigQueryKind.Struct => "STRUCT", _ => "UNKNOWN"
    };

    /// <summary>The GoogleSQL type text (<c>ARRAY&lt;STRUCT&lt;a INT64, b STRING&gt;&gt;</c>), cut to <paramref name="maxChars"/>
    /// with an ellipsis, as the descriptor's 256-character limit asks.</summary>
    public string TypeText(int maxChars = 256)
    {
        var text = new StringBuilder();
        Append(text, maxChars + 1);
        return text.Length <= maxChars ? text.ToString() : text.ToString(0, maxChars - 1) + "…";
    }

    void Append(StringBuilder text, int limit)
    {
        if (text.Length > limit) return;
        if (Repeated) text.Append("ARRAY<");
        AppendElement(text, limit);
        if (Repeated) text.Append('>');
    }

    void AppendElement(StringBuilder text, int limit)
    {
        text.Append(Kind == BigQueryKind.Unknown ? Unknown : BaseName(Kind));
        switch (Kind)
        {
            case BigQueryKind.Numeric or BigQueryKind.BigNumeric when Precision is { } precision:
                text.Append('(').Append(precision.ToString(CultureInfo.InvariantCulture));
                if (Scale is { } scale) text.Append(", ").Append(scale.ToString(CultureInfo.InvariantCulture));
                text.Append(')');
                break;
            case BigQueryKind.String or BigQueryKind.Bytes when MaxLength is { } length:
                text.Append('(').Append(length.ToString(CultureInfo.InvariantCulture)).Append(')');
                break;
            case BigQueryKind.Range:
                text.Append('<').Append(RangeElement == BigQueryKind.Unknown ? "UNKNOWN" : BaseName(RangeElement)).Append('>');
                break;
            case BigQueryKind.Struct:
                text.Append('<');
                for (var i = 0; i < Fields.Length && text.Length <= limit; i++)
                {
                    if (i > 0) text.Append(", ");
                    text.Append(Fields[i].Name).Append(' ');
                    Fields[i].Append(text, limit);
                }
                text.Append('>');
                break;
        }
    }

    /// <summary>How a column of this field sorts and filters (ColumnTypes): GoogleSQL's kinds, with ARRAY and STRUCT as
    /// documents.</summary>
    public string SortKind => Repeated ? ColumnTypes.Json : Kind switch
    {
        BigQueryKind.Int64 => ColumnTypes.Integer,
        BigQueryKind.Numeric or BigQueryKind.BigNumeric => ColumnTypes.Decimal,
        BigQueryKind.Float64 => ColumnTypes.Float,
        BigQueryKind.Bool => ColumnTypes.Boolean,
        BigQueryKind.Date => ColumnTypes.Date,
        BigQueryKind.Time => ColumnTypes.Time,
        BigQueryKind.DateTime => ColumnTypes.DateTime,
        BigQueryKind.Timestamp => ColumnTypes.Timestamp,
        BigQueryKind.Bytes => ColumnTypes.Binary,
        BigQueryKind.String => ColumnTypes.Text,
        BigQueryKind.Json or BigQueryKind.Struct => ColumnTypes.Json,
        _ => ColumnTypes.Other
    };
}

/// <summary>
/// The REST reader of a BigQuery result set (docs/bigquery.md, Types and display): the schema's columns, and each
/// <c>TableRow</c> (<c>{"f":[{"v":…}]}</c>) decoded by Varia's own converter straight into a <see cref="PageBuilder"/>, as
/// <see cref="ColumnPlan"/> reads a SqlDataReader. Not BigQueryRow: the client throws on RANGE and INTERVAL, and would format
/// values and take memory outside the budget's accounting. Values are read from the page's JSON without copying where
/// they need no unescaping. A value that cannot be read becomes NULL with the read-error flag, and one message names its
/// column.
/// </summary>
internal sealed class BigQueryColumnPlan
{
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    internal static readonly JsonWriterOptions Compact = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, Indented = false, SkipValidation = false };
    private readonly BigQueryField[] fields;
    private readonly int[] caps;
    private readonly bool[] warned;
    internal IReadOnlyList<BigQueryField> Fields => fields;
    internal int CapOfColumn(int column) => caps[column];
    private readonly ArrayBufferWriter<byte> json = new(1024);
    private byte[] scratch = new byte[1024];

    private BigQueryColumnPlan(BigQueryField[] fields, bool truncatedColumns)
    {
        this.fields = fields;
        TruncatedColumns = truncatedColumns;
        Columns = [.. fields.Select(Describe)];
        Wires = [.. fields.Select(WireOf)];
        Lengths = [.. fields.Select(LengthOf)];
        caps = [.. fields.Select(CapOf)];
        warned = new bool[fields.Length];
        DescriptorBytes = ColumnPlan.DescriptorBytesOf(Columns);
    }

    private BigQueryColumnPlan(BigQueryColumnPlan from)
    {
        fields = from.fields;
        TruncatedColumns = from.TruncatedColumns;
        Columns = from.Columns;
        Wires = from.Wires;
        Lengths = from.Lengths;
        caps = from.caps;
        warned = (bool[])from.warned.Clone();
        DescriptorBytes = from.DescriptorBytes;
    }

    /// <summary>The same columns with working buffers of its own: a plan decodes on one thread at a time, so each concurrent
    /// reader of a result (a windowed result's block fetches, and Load into memory through tabledata.list beside them) takes a fork.</summary>
    internal BigQueryColumnPlan Fork() => new(this);

    public IReadOnlyList<ResultColumn> Columns { get; }
    public IReadOnlyList<WireKind> Wires { get; }
    public IReadOnlyList<ColumnLength> Lengths { get; }
    public long DescriptorBytes { get; }
    /// <summary>Whether the schema had more columns than a descriptor holds (<see cref="PageBuilder.MaxColumns"/>); the
    /// first ones are kept.</summary>
    public bool TruncatedColumns { get; }
    public int SchemaColumns { get; private init; }

    /// <summary>The plan for a schema's <c>fields</c>; null when it has none (DML, DDL, a script whose last statement returned no rows).</summary>
    public static BigQueryColumnPlan? From(JsonElement? schema)
    {
        if (schema is not { ValueKind: JsonValueKind.Object } value || !value.TryGetProperty("fields", out var list)) return null;
        var fields = BigQueryField.Parse(list);
        if (fields.Length == 0) return null;
        var truncated = fields.Length > PageBuilder.MaxColumns;
        return new BigQueryColumnPlan(truncated ? fields[..PageBuilder.MaxColumns] : fields, truncated) { SchemaColumns = fields.Length };
    }

    static ResultColumn Describe(BigQueryField field) => new(CellFormat.Prefix(field.Name, 512, out _).ToString(), field.TypeText(), WireOf(field) == WireKind.Binary ? "binary" : "text",
        IsDocument(field) ? "json" : null, Nullable: !field.Required && !field.Repeated) { SortKind = field.SortKind };

    internal static bool IsDocument(BigQueryField field) => field.Repeated || field.Kind is BigQueryKind.Json or BigQueryKind.Struct;
    static WireKind WireOf(BigQueryField field) => field.Kind == BigQueryKind.Bytes && !field.Repeated ? WireKind.Binary : WireKind.Text;

    /// <summary>Each column's bytes for the row size bar: BigQuery's logical size for its fixed-size types, the text's UTF-8
    /// bytes for the rest, and BYTES' own length.</summary>
    static ColumnLength LengthOf(BigQueryField field) => field.Repeated ? ColumnLength.Utf8 : field.Kind switch
    {
        BigQueryKind.Bool => ColumnLength.Fixed(1),
        BigQueryKind.Int64 or BigQueryKind.Float64 or BigQueryKind.Date or BigQueryKind.Time or BigQueryKind.DateTime or BigQueryKind.Timestamp => ColumnLength.Fixed(8),
        BigQueryKind.Numeric or BigQueryKind.Interval => ColumnLength.Fixed(16),
        BigQueryKind.Bytes => ColumnLength.Binary,
        _ => ColumnLength.Utf8
    };

    /// <summary>The cell caps SQL Server's reader keeps: text 65,535 characters, documents (JSON, STRUCT, ARRAY, GEOGRAPHY) 2 MiB, bytes 32,766.</summary>
    static int CapOf(BigQueryField field) => IsDocument(field) || field.Kind == BigQueryKind.Geography ? ColumnPlan.DocumentCap
        : field.Kind == BigQueryKind.Bytes ? ColumnPlan.BinaryCap : ColumnPlan.TextCap;

    /// <summary>Appends one row's cells (a <c>TableRow</c>). Returns the number of cells stored as truncated prefixes.</summary>
    public int ReadRow(JsonElement row, PageBuilder builder, Action<string> warn)
    {
        if (row.ValueKind != JsonValueKind.Object || !row.TryGetProperty("f", out var cells) || cells.ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("BigQuery answered a row Varia cannot read.");
        var truncated = 0;
        var cell = cells.EnumerateArray();
        for (var i = 0; i < fields.Length; i++)
        {
            var field = fields[i];
            JsonElement value = default;
            var present = cell.MoveNext() && cell.Current.ValueKind == JsonValueKind.Object && cell.Current.TryGetProperty("v", out value);
            if (present && value.ValueKind == JsonValueKind.Null) { builder.AppendNull(); continue; }
            try
            {
                if (!present) throw new InvalidDataException("The row has no value for this column.");
                if (Read(field, caps[i], value, builder)) truncated++;
            }
            catch (Exception error) when (error is FormatException or InvalidDataException or OverflowException or JsonException)
            {
                ReadError(i, builder, warn);
            }
        }
        return truncated;
    }

    /// <summary>A value that could not be read: NULL with the read-error flag, and one message for its column.</summary>
    internal void ReadError(int column, PageBuilder builder, Action<string> warn)
    {
        builder.AppendNull(error: true);
        builder.Measure(0, 0, exact: false);
        if (warned[column]) return;
        warned[column] = true;
        warn("Column ‘" + Columns[column].Name + "’ (" + Columns[column].DataType + "): some values could not be read and are shown as NULL.");
    }

    /// <summary>One cell; true when it was stored as a truncated prefix.</summary>
    bool Read(BigQueryField field, int cap, JsonElement value, PageBuilder builder)
    {
        if (field.Repeated || field.Kind == BigQueryKind.Struct) return Document(field, cap, value, builder);
        switch (field.Kind)
        {
            case BigQueryKind.String or BigQueryKind.Geography or BigQueryKind.Json:
                return StringValue(value, cap, builder);
            case BigQueryKind.Range:
                if (value.ValueKind != JsonValueKind.String) throw new FormatException("The value is not text.");
                return Text(RangeText(value.GetString()!, field.RangeElement), cap, builder);
            case BigQueryKind.Unknown when value.ValueKind != JsonValueKind.String:
                // A type this build does not know, sent as JSON: its JSON text.
                return Text(value.GetRawText(), cap, builder);
            default:
                return ReadScalar(field, cap, Scalar(value), builder);
        }
    }

    /// <summary>One non-document cell from its text as BigQuery writes it in REST (also the Arrow reader's path for a
    /// column it receives as text); true when it was stored as a truncated prefix.</summary>
    internal bool ReadScalar(BigQueryField field, int cap, ReadOnlySpan<byte> text, PageBuilder builder)
    {
        switch (field.Kind)
        {
            case BigQueryKind.Int64: return Fixed(builder, Integer(text), 8);
            case BigQueryKind.Bool: return Fixed(builder, Boolean(text), 1);
            case BigQueryKind.Float64:
            {
                var written = WriteFloat(text, Room(32));
                return Fixed(builder, scratch.AsSpan(0, written), 8);
            }
            case BigQueryKind.Numeric:
            case BigQueryKind.BigNumeric:
            {
                var written = CanonicalDecimal(text, Room(256));
                return Decimal(builder, scratch.AsSpan(0, written), field.Kind);
            }
            case BigQueryKind.Timestamp:
            {
                var written = WriteTimestamp(text, Room(40));
                return Fixed(builder, scratch.AsSpan(0, written), 8);
            }
            case BigQueryKind.Range:
                return Text(RangeText(Encoding.UTF8.GetString(text), field.RangeElement), cap, builder);
            case BigQueryKind.Bytes:
            {
                var bytes = Room(Base64.GetMaxDecodedFromUtf8Length(text.Length));
                if (Base64.DecodeFromUtf8(text, bytes, out _, out var length) != OperationStatus.Done) throw new FormatException("The value is not base64.");
                return Binary(builder, bytes[..length], cap);
            }
            case BigQueryKind.Date or BigQueryKind.Time or BigQueryKind.DateTime or BigQueryKind.Interval:
            {
                var written = Temporal(field.Kind, text, Room(text.Length + 64));
                return Fixed(builder, scratch.AsSpan(0, written), field.Kind == BigQueryKind.Interval ? 16 : 8);
            }
            default:
                // STRING, GEOGRAPHY, JSON, and a type this build does not know: the text as BigQuery sent it.
                return Utf8Text(text, cap, builder);
        }
    }

    /// <summary>NUMERIC (16 bytes for the row size bar) or BIGNUMERIC (its text's length).</summary>
    internal static bool Decimal(PageBuilder builder, ReadOnlySpan<byte> text, BigQueryKind kind)
    {
        builder.AppendUtf8(text);
        builder.Measure(text.Length, kind == BigQueryKind.Numeric ? 16 : text.Length);
        return false;
    }

    /// <summary>BYTES, cut at the column's cap.</summary>
    internal static bool Binary(PageBuilder builder, ReadOnlySpan<byte> bytes, int cap)
    {
        var cut = bytes.Length > cap;
        builder.AppendBinary(bytes[..Math.Min(bytes.Length, cap)], cut);
        builder.Measure(bytes.Length, bytes.Length);
        return cut;
    }

    /// <summary>UTF-8 text as is, cut at the column's cap. A UTF-16 unit takes at least one UTF-8 byte, so text of at most
    /// <paramref name="cap"/> bytes has at most that many characters.</summary>
    internal static bool Utf8Text(ReadOnlySpan<byte> text, int cap, PageBuilder builder)
    {
        if (text.Length <= cap)
        {
            builder.AppendUtf8(text);
            // Characters as well as bytes: a cell the row limit cuts keeps both beside the page.
            builder.Measure(Encoding.UTF8.GetCharCount(text), text.Length);
            return false;
        }
        return Text(Encoding.UTF8.GetString(text), cap, builder);
    }

    Span<byte> Room(int bytes)
    {
        if (scratch.Length < bytes) scratch = new byte[Math.Max(bytes, scratch.Length * 2)];
        return scratch.AsSpan(0, bytes);
    }

    /// <summary>A scalar's characters as BigQuery sent them: a JSON string's content, read from the response's own bytes
    /// unless an encoder escaped some of them (base64's + and /, an exponent's +), or a JSON number's text.</summary>
    static ReadOnlySpan<byte> Scalar(JsonElement value)
    {
        var raw = JsonMarshal.GetRawUtf8Value(value);
        if (value.ValueKind == JsonValueKind.Number) return raw;
        if (value.ValueKind != JsonValueKind.String || raw.Length < 2) throw new FormatException("The value is not text.");
        var inner = raw[1..^1];
        return inner.Contains((byte)'\\') ? Encoding.UTF8.GetBytes(value.GetString()!) : inner;
    }

    internal static bool Fixed(PageBuilder builder, ReadOnlySpan<byte> text, int bytes)
    {
        builder.AppendUtf8(text);
        builder.Measure(text.Length, bytes);
        return false;
    }

    static ReadOnlySpan<byte> Integer(ReadOnlySpan<byte> text)
    {
        var digits = text.Length > 0 && text[0] == '-' ? text[1..] : text;
        if (digits.Length is 0 or > 19 || digits.ContainsAnyExceptInRange((byte)'0', (byte)'9')) throw new FormatException("The value is not an INT64.");
        return text;
    }

    static ReadOnlySpan<byte> Boolean(ReadOnlySpan<byte> text) =>
        text.SequenceEqual("true"u8) || text.SequenceEqual("false"u8) ? text : throw new FormatException("The value is not a BOOL.");

    /// <summary>FLOAT64 in .NET's shortest round-trip form (1.5, 1E+20, -0), with NaN, Infinity and -Infinity as BigQuery writes them.</summary>
    internal static int WriteFloat(ReadOnlySpan<byte> text, Span<byte> destination)
    {
        if (!double.TryParse(text, NumberStyles.Float, Invariant, out var number)) throw new FormatException("The value is not a FLOAT64.");
        return number.TryFormat(destination, out var written, "R", Invariant) ? written : throw new FormatException();
    }

    /// <summary>NUMERIC and BIGNUMERIC as plain decimal text at full precision: no exponent, no leading zeros, no trailing
    /// fractional zeros (1.50 is 1.5, 1E-9 is 0.000000001), so REST and Arrow reads write the same text. BigQuery's own text
    /// is already canonical and is copied as is; anything else is rebuilt from its digits.</summary>
    internal static int CanonicalDecimal(ReadOnlySpan<byte> text, Span<byte> destination)
    {
        if (IsCanonical(text))
        {
            if (text.Length > destination.Length) throw new FormatException("The decimal is too long.");
            text.CopyTo(destination);
            return text.Length;
        }
        var negative = text.Length > 0 && text[0] == '-';
        if (text.Length > 0 && text[0] is (byte)'-' or (byte)'+') text = text[1..];
        var exponentAt = text.IndexOfAny((byte)'e', (byte)'E');
        var exponent = 0;
        if (exponentAt >= 0)
        {
            if (!int.TryParse(text[(exponentAt + 1)..], NumberStyles.AllowLeadingSign, Invariant, out exponent) || exponent is < -100 or > 100) throw new FormatException("The value is not a decimal.");
            text = text[..exponentAt];
        }
        var point = text.IndexOf((byte)'.');
        var whole = point < 0 ? text : text[..point];
        var fraction = point < 0 ? [] : text[(point + 1)..];
        if (whole.Length + fraction.Length is 0 or > 100 || whole.ContainsAnyExceptInRange((byte)'0', (byte)'9') || fraction.ContainsAnyExceptInRange((byte)'0', (byte)'9'))
            throw new FormatException("The value is not a decimal.");
        var unscaled = BigInteger.Parse(Encoding.ASCII.GetString(whole) + Encoding.ASCII.GetString(fraction), Invariant);
        var scale = fraction.Length - exponent;
        if (scale < 0)
        {
            unscaled *= BigInteger.Pow(10, -scale);
            scale = 0;
        }
        while (scale > 0 && !unscaled.IsZero && unscaled % 10 == 0) { unscaled /= 10; scale--; }
        if (unscaled.IsZero) scale = 0;
        var digits = unscaled.ToString(Invariant);
        if (scale > 0)
        {
            digits = digits.PadLeft(scale + 1, '0');
            digits = digits[..^scale] + "." + digits[^scale..];
        }
        if (negative && !unscaled.IsZero) digits = "-" + digits;
        if (digits.Length > destination.Length) throw new FormatException("The decimal is too long.");
        return Encoding.ASCII.GetBytes(digits, destination);
    }

    /// <summary>Whether decimal text is already as Varia writes it: an optional minus, digits with no leading zero (or a
    /// lone zero), and a fraction that does not end in zero; never negative zero.</summary>
    static bool IsCanonical(ReadOnlySpan<byte> text)
    {
        var negative = text.Length > 0 && text[0] == '-';
        var body = negative ? text[1..] : text;
        var point = body.IndexOf((byte)'.');
        var whole = point < 0 ? body : body[..point];
        var fraction = point < 0 ? [] : body[(point + 1)..];
        if (whole.Length == 0 || whole.ContainsAnyExceptInRange((byte)'0', (byte)'9') || whole.Length > 1 && whole[0] == '0') return false;
        if (point >= 0 && (fraction.Length == 0 || fraction.ContainsAnyExceptInRange((byte)'0', (byte)'9') || fraction[^1] == '0')) return false;
        return !(negative && whole.SequenceEqual("0"u8) && fraction.Length == 0) && whole.Length + fraction.Length <= 100;
    }

    /// <summary>TIMESTAMP in UTC at microsecond precision, fixed width: <c>2026-11-15 09:30:00.000000 UTC</c> (decision 14).
    /// REST sends microseconds since the epoch (formatOptions.useInt64Timestamp), or seconds with a fraction without it.</summary>
    internal static int WriteTimestamp(ReadOnlySpan<byte> text, Span<byte> destination)
    {
        if (!long.TryParse(text, NumberStyles.AllowLeadingSign, Invariant, out var micros))
        {
            if (!decimal.TryParse(text, NumberStyles.Float, Invariant, out var seconds) || Math.Abs(seconds) > 300_000_000_000m) throw new FormatException("The value is not a TIMESTAMP.");
            micros = (long)decimal.Round(seconds * 1_000_000m, MidpointRounding.AwayFromZero);
        }
        return BigQueryText.Timestamp(micros, destination);
    }

    /// <summary>DATE, TIME, DATETIME and INTERVAL text as Varia writes it (<see cref="BigQueryText"/>), rebuilt from BigQuery's
    /// text so the REST and Arrow readers agree; text it does not recognise is copied as BigQuery wrote it.</summary>
    internal static int Temporal(BigQueryKind kind, ReadOnlySpan<byte> text, Span<byte> destination)
    {
        switch (kind)
        {
            case BigQueryKind.Date when BigQueryText.TryParseDate(text, out var days): return BigQueryText.Date(days, destination);
            case BigQueryKind.Time when BigQueryText.TryParseTime(text, out var time): return BigQueryText.Time(time, destination);
            case BigQueryKind.DateTime when BigQueryText.TryParseDateTime(text, out var micros): return BigQueryText.DateTime(micros, destination);
            case BigQueryKind.Interval when BigQueryText.TryParseInterval(text, out var months, out var intervalDays, out var intervalMicros):
                return BigQueryText.Interval(months, intervalDays, intervalMicros, destination);
        }
        if (text.Length > destination.Length) throw new FormatException("The value is too long.");
        text.CopyTo(destination);
        return text.Length;
    }

    /// <summary>One RANGE bound's text: <c>UNBOUNDED</c>, or the element's value as Varia writes it. REST sends a TIMESTAMP
    /// bound as epoch microseconds.</summary>
    internal static string Bound(BigQueryKind element, string bound)
    {
        if (bound == "UNBOUNDED") return bound;
        Span<byte> buffer = stackalloc byte[64];
        var utf8 = Encoding.UTF8.GetBytes(bound);
        if (element == BigQueryKind.Timestamp)
            return long.TryParse(bound, NumberStyles.AllowLeadingSign, Invariant, out _) ? Encoding.ASCII.GetString(buffer[..WriteTimestamp(utf8, buffer)]) : bound;
        return element is BigQueryKind.Date or BigQueryKind.DateTime && utf8.Length <= 48 ? Encoding.UTF8.GetString(buffer[..Temporal(element, utf8, buffer)]) : bound;
    }

    /// <summary>RANGE text (<c>[2026-01-01, 2026-12-31)</c>) with each bound as <see cref="Bound"/> writes it; text it does
    /// not recognise stays as BigQuery wrote it.</summary>
    internal static string RangeText(string text, BigQueryKind element)
    {
        var comma = text.IndexOf(", ", StringComparison.Ordinal);
        if (text.Length < 4 || text[0] != '[' || text[^1] != ')' || comma < 0) return text;
        return "[" + Bound(element, text[1..comma]) + ", " + Bound(element, text[(comma + 2)..^1]) + ")";
    }

    /// <summary>STRING, GEOGRAPHY and JSON: the text as is, cut at the column's cap. A value with no escapes goes to the page
    /// from the response's own bytes.</summary>
    static bool StringValue(JsonElement value, int cap, PageBuilder builder)
    {
        if (value.ValueKind != JsonValueKind.String) throw new FormatException("The value is not text.");
        var raw = JsonMarshal.GetRawUtf8Value(value);
        var inner = raw[1..^1];
        // A UTF-16 unit takes at least one UTF-8 byte, so text of at most `cap` bytes has at most `cap` characters.
        if (inner.Length <= cap && !inner.Contains((byte)'\\'))
        {
            builder.AppendUtf8(inner);
            // Characters as well as bytes: a cell the row limit cuts keeps both beside the page.
            builder.Measure(Encoding.UTF8.GetCharCount(inner), inner.Length);
            return false;
        }
        return Text(value.GetString()!, cap, builder);
    }

    internal static bool Text(string text, int cap, PageBuilder builder)
    {
        var prefix = CellFormat.Prefix(text, cap, out var cut);
        builder.AppendText(prefix, cut);
        builder.Measure(text.Length, Encoding.UTF8.GetByteCount(text));
        return cut;
    }

    /// <summary>STRUCT and ARRAY: compact JSON text, so a cell stays one cell (Open Value shows it formatted). Members keep
    /// their names; INT64, NUMERIC and BIGNUMERIC are strings, as BigQuery's console writes them, so no digit is lost to a
    /// JSON reader's doubles.</summary>
    bool Document(BigQueryField field, int cap, JsonElement value, PageBuilder builder)
    {
        json.Clear();
        using (var writer = new Utf8JsonWriter(json, Compact)) WriteValue(writer, field, value, field.Repeated);
        var utf8 = json.WrittenSpan;
        if (utf8.Length <= cap)
        {
            builder.AppendUtf8(utf8);
            builder.Measure(Encoding.UTF8.GetCharCount(utf8), utf8.Length);
            return false;
        }
        return Text(Encoding.UTF8.GetString(utf8), cap, builder);
    }

    void WriteValue(Utf8JsonWriter writer, BigQueryField field, JsonElement value, bool repeated)
    {
        if (value.ValueKind == JsonValueKind.Null) { writer.WriteNullValue(); return; }
        if (repeated)
        {
            if (value.ValueKind != JsonValueKind.Array) throw new FormatException("The ARRAY is not a list.");
            writer.WriteStartArray();
            foreach (var item in value.EnumerateArray())
                WriteValue(writer, field, item.ValueKind == JsonValueKind.Object && item.TryGetProperty("v", out var element) ? element : throw new FormatException("The ARRAY's element has no value."), false);
            writer.WriteEndArray();
            return;
        }
        switch (field.Kind)
        {
            case BigQueryKind.Struct:
            {
                if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("f", out var members) || members.ValueKind != JsonValueKind.Array) throw new FormatException("The STRUCT has no members.");
                writer.WriteStartObject();
                var member = members.EnumerateArray();
                foreach (var child in field.Fields)
                {
                    writer.WritePropertyName(child.Name);
                    WriteValue(writer, child, member.MoveNext() && member.Current.ValueKind == JsonValueKind.Object && member.Current.TryGetProperty("v", out var inner) ? inner : throw new FormatException("The STRUCT lacks a member."), child.Repeated);
                }
                writer.WriteEndObject();
                break;
            }
            default:
                // Kinds that are not read from their text keep a JSON value BigQuery sent as one.
                if (value.ValueKind is not (JsonValueKind.String or JsonValueKind.Number) && field.Kind is BigQueryKind.String or BigQueryKind.Bytes or BigQueryKind.Geography or BigQueryKind.Range or BigQueryKind.Unknown)
                {
                    value.WriteTo(writer);
                    break;
                }
                WriteScalarText(writer, field, Scalar(value));
                break;
        }
    }

    /// <summary>A document member that is not a STRUCT or ARRAY, from its text as BigQuery writes it in REST (also the Arrow
    /// reader's path for a member it receives as text).</summary>
    internal void WriteScalarText(Utf8JsonWriter writer, BigQueryField field, ReadOnlySpan<byte> text)
    {
        switch (field.Kind)
        {
            case BigQueryKind.Bool: writer.WriteBooleanValue(Boolean(text)[0] == 't'); break;
            case BigQueryKind.Int64: writer.WriteStringValue(Integer(text)); break;
            case BigQueryKind.Numeric or BigQueryKind.BigNumeric:
            {
                Span<byte> digits = stackalloc byte[256];
                writer.WriteStringValue(digits[..CanonicalDecimal(text, digits)]);
                break;
            }
            case BigQueryKind.Float64:
            {
                if (!double.TryParse(text, NumberStyles.Float, Invariant, out var number)) throw new FormatException("The value is not a FLOAT64.");
                WriteFloatMember(writer, number);
                break;
            }
            case BigQueryKind.Timestamp:
            {
                Span<byte> buffer = stackalloc byte[40];
                writer.WriteStringValue(buffer[..WriteTimestamp(text, buffer)]);
                break;
            }
            case BigQueryKind.Json: WriteJsonMember(writer, Encoding.UTF8.GetString(text)); break;
            case BigQueryKind.Date or BigQueryKind.Time or BigQueryKind.DateTime or BigQueryKind.Interval:
            {
                // Room may replace the scratch buffer, so the span is taken after Temporal wrote into it.
                var written = Temporal(field.Kind, text, Room(text.Length + 64));
                writer.WriteStringValue(scratch.AsSpan(0, written));
                break;
            }
            case BigQueryKind.Range: writer.WriteStringValue(RangeText(Encoding.UTF8.GetString(text), field.RangeElement)); break;
            default: writer.WriteStringValue(text); break;
        }
    }

    /// <summary>A FLOAT64 member: a JSON number, or its text for NaN and the infinities, which JSON cannot hold.</summary>
    internal static void WriteFloatMember(Utf8JsonWriter writer, double number)
    {
        if (double.IsFinite(number)) writer.WriteNumberValue(number);
        else writer.WriteStringValue(number.ToString("R", Invariant));
    }

    /// <summary>A JSON member is embedded as JSON when it parses, else kept as its text.</summary>
    internal static void WriteJsonMember(Utf8JsonWriter writer, string text)
    {
        if (IsJson(text)) writer.WriteRawValue(text, skipInputValidation: true);
        else writer.WriteStringValue(text);
    }

    internal static bool IsJson(string text)
    {
        try
        {
            var reader = new Utf8JsonReader(Encoding.UTF8.GetBytes(text), new JsonReaderOptions { MaxDepth = 64 });
            while (reader.Read()) { }
            return reader.BytesConsumed > 0;
        }
        catch (JsonException) { return false; }
    }
}
