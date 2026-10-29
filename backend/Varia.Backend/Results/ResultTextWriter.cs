using System.Buffers;
using System.Text;

namespace Varia.Backend.Results;

internal enum TextFormat { Tsv, Csv, Json }

/// <summary>How text is laid out. Copy: tab-separated, NULL as "NULL", the platform's end of line between lines and none
/// after the last, NUL as a space. Save: a header row, a BOM for CSV and TSV, CRLF after every line (LF for JSON).
/// docs/ipc.md has the table; tests/fixtures/results-text/cases.json pins the bytes.</summary>
internal sealed record TextOptions(TextFormat Format, bool Headers, bool NullAsEmpty, bool Crlf, bool TrailingEol, bool Bom)
{
    /// <summary>Text for the clipboard, which Windows ends at the first NUL: each becomes a space, or the rest of the copy
    /// would be lost.</summary>
    public bool Clipboard { get; init; }

    public static TextOptions Copy(bool headers, bool crlf) => new(TextFormat.Tsv, headers, false, crlf, false, false) { Clipboard = true };

    /// <param name="nullText">"empty" or "NULL"; JSON always writes null.</param>
    public static TextOptions Export(TextFormat format, bool headers, string nullText) =>
        new(format, headers && format != TextFormat.Json, nullText == "empty", format != TextFormat.Json, true, format != TextFormat.Json);
}

/// <summary>The only formatter of Copy and Save Results As text. It reads stored pages through <see cref="PageView"/> and
/// writes UTF-8 straight to the output: CSV quoting, TSV replacement and JSON escaping work on bytes, which is safe
/// because every byte that needs attention is ASCII (and U+2028/U+2029, matched as their three bytes). Writes ask the
/// output for at least one byte at a time, so any chunk size works and no value is ever copied whole.</summary>
internal sealed class ResultTextWriter
{
    public const string NoColumnName = "(No column name)";
    private static readonly SearchValues<byte> TsvSpecial = SearchValues.Create("\t\n\r"u8);
    private static readonly SearchValues<byte> ClipboardSpecial = SearchValues.Create("\t\n\r\0"u8);
    private static readonly SearchValues<byte> CsvSpecial = SearchValues.Create(",\"\n\r"u8);
    private static readonly SearchValues<byte> JsonSpecial = SearchValues.Create([.. Enumerable.Range(0, 0x20).Select(value => (byte)value), (byte)'"', (byte)'\\', 0xE2]);
    private static readonly HashSet<string> NumberTypes = ["tinyint", "smallint", "int", "bigint", "decimal", "numeric", "money", "smallmoney", "real", "float"];
    private static readonly byte[] Hex = "0123456789ABCDEF"u8.ToArray();
    private enum ValueKind : byte { Text, Number, Bit, Binary }

    private readonly IBufferWriter<byte> output;
    private readonly TextOptions options;
    private readonly IReadOnlyList<ResultColumn> columns;
    private readonly ValueKind[] kinds;
    private readonly byte[][]? keys;
    private long lines;

    public ResultTextWriter(IBufferWriter<byte> output, TextOptions options, IReadOnlyList<ResultColumn> columns)
    {
        this.output = output;
        this.options = options;
        this.columns = columns;
        kinds = [.. columns.Select(Kind)];
        if (options.Format == TextFormat.Json) keys = JsonKeys(columns);
    }

    public long Bytes { get; private set; }
    public long Rows { get; private set; }
    public long TruncatedCells { get; private set; }
    private ReadOnlySpan<byte> Eol => options.Crlf ? "\r\n"u8 : "\n"u8;

    /// <summary>A column that is never text to copy or save: a live table's row tone (role tone), which the grid shows as the
    /// row's colour. Copy and Save leave it out of their columns, headers and JSON keys alike.</summary>
    public static bool Hidden(ResultColumn column) => column.Role == "tone";

    private static ValueKind Kind(ResultColumn column)
    {
        if (column.Wire == "binary") return ValueKind.Binary;
        var type = column.DataType.Split('(')[0].Trim().ToLowerInvariant();
        return type == "bit" ? ValueKind.Bit : NumberTypes.Contains(type) ? ValueKind.Number : ValueKind.Text;
    }

    /// <summary>JSON object keys: a blank name becomes Column{ordinal}, and a repeated one gets _2, _3 and so on.</summary>
    private static byte[][] JsonKeys(IReadOnlyList<ResultColumn> columns)
    {
        var used = new HashSet<string>(StringComparer.Ordinal);
        var keys = new byte[columns.Count][];
        for (var i = 0; i < columns.Count; i++)
        {
            var name = string.IsNullOrEmpty(columns[i].Name) ? "Column" + (i + 1) : columns[i].Name;
            var key = name;
            for (var n = 2; !used.Add(key); n++) key = name + "_" + n;
            var buffer = new ArrayBufferWriter<byte>();
            new ResultTextWriter(buffer, new TextOptions(TextFormat.Json, false, false, false, false, false), []).JsonString(Encoding.UTF8.GetBytes(key));
            keys[i] = buffer.WrittenSpan.ToArray();
        }
        return keys;
    }

    /// <summary>The BOM and, for JSON, the opening bracket.</summary>
    public void Begin()
    {
        if (options.Bom) Write("﻿"u8);
        if (options.Format == TextFormat.Json) Write("["u8);
    }

    /// <summary>A header line for the selected columns, when headers are on (never for JSON, whose rows carry their keys).</summary>
    public void Header(ReadOnlySpan<int> selected)
    {
        if (options.Format == TextFormat.Json || !options.Headers) return;
        BeginLine();
        for (var i = 0; i < selected.Length; i++)
        {
            if (i > 0) Write(options.Format == TextFormat.Csv ? ","u8 : "\t"u8);
            var name = columns[selected[i]].Name;
            var bytes = Encoding.UTF8.GetBytes(string.IsNullOrEmpty(name) ? NoColumnName : name);
            if (options.Format == TextFormat.Csv) CsvField(bytes);
            else TsvText(bytes);
        }
        EndLine();
    }

    public void Row(in PageView page, int row, ReadOnlySpan<int> selected)
    {
        if (options.Format == TextFormat.Json)
        {
            Write(Rows == 0 ? "\n{"u8 : ",\n{"u8);
            for (var i = 0; i < selected.Length; i++)
            {
                if (i > 0) Write(","u8);
                Write(keys![selected[i]]);
                Write(":"u8);
                Cell(page, row, selected[i]);
            }
            Write("}"u8);
        }
        else
        {
            BeginLine();
            for (var i = 0; i < selected.Length; i++)
            {
                if (i > 0) Write(options.Format == TextFormat.Csv ? ","u8 : "\t"u8);
                Cell(page, row, selected[i]);
            }
            EndLine();
        }
        Rows++;
    }

    /// <summary>JSON's closing bracket; an empty result is "[]".</summary>
    public void End()
    {
        if (options.Format == TextFormat.Json) Write(Rows == 0 ? "]\n"u8 : "\n]\n"u8);
    }

    private void BeginLine()
    {
        if (!options.TrailingEol && lines > 0) Write(Eol);
    }

    private void EndLine()
    {
        if (options.TrailingEol) Write(Eol);
        lines++;
    }

    private void Cell(in PageView page, int row, int column)
    {
        // A cell that could not be read is stored as NULL with an error flag, and written as NULL.
        if (page.IsNull(column, row))
        {
            if (options.Format == TextFormat.Json) Write("null"u8);
            else if (!options.NullAsEmpty) Write("NULL"u8);
            return;
        }
        if (page.IsTruncated(column, row)) TruncatedCells++;
        var value = page.Span(column, row);
        switch (kinds[column])
        {
            case ValueKind.Binary:
                if (options.Format == TextFormat.Json) Write("\""u8);
                Write("0x"u8);
                HexBytes(value);
                if (options.Format == TextFormat.Json) Write("\""u8);
                return;
            case ValueKind.Number when options.Format == TextFormat.Json && IsJsonNumber(value):
                Write(value);
                return;
            case ValueKind.Bit when options.Format == TextFormat.Json && value.Length == 1 && value[0] is (byte)'0' or (byte)'1':
                Write(value[0] == '1' ? "true"u8 : "false"u8);
                return;
        }
        switch (options.Format)
        {
            case TextFormat.Tsv: TsvText(value); break;
            case TextFormat.Csv: CsvField(value); break;
            default: JsonString(value); break;
        }
    }

    /// <summary>CRLF, CR, LF and TAB (and NUL on the clipboard) each become one space, so a value stays on its line and in
    /// its column.</summary>
    private void TsvText(ReadOnlySpan<byte> text)
    {
        var special = options.Clipboard ? ClipboardSpecial : TsvSpecial;
        while (!text.IsEmpty)
        {
            var at = text.IndexOfAny(special);
            if (at < 0) { Write(text); return; }
            Write(text[..at]);
            Write(" "u8);
            if (text[at] == '\r' && at + 1 < text.Length && text[at + 1] == '\n') at++;
            text = text[(at + 1)..];
        }
    }

    /// <summary>RFC 4180: quoted only when it holds a comma, quote, CR or LF, or is empty (so '' differs from NULL);
    /// quotes are doubled and line breaks kept.</summary>
    private void CsvField(ReadOnlySpan<byte> text)
    {
        if (!text.IsEmpty && text.IndexOfAny(CsvSpecial) < 0) { Write(text); return; }
        Write("\""u8);
        while (!text.IsEmpty)
        {
            var at = text.IndexOf((byte)'"');
            if (at < 0) { Write(text); break; }
            Write(text[..(at + 1)]);
            Write("\""u8);
            text = text[(at + 1)..];
        }
        Write("\""u8);
    }

    /// <summary>A JSON string: quote, backslash, C0 controls, U+2028 and U+2029 escaped; everything else raw UTF-8.</summary>
    private void JsonString(ReadOnlySpan<byte> text)
    {
        Write("\""u8);
        Span<byte> escape = stackalloc byte[6];
        while (!text.IsEmpty)
        {
            var at = text.IndexOfAny(JsonSpecial);
            if (at < 0) { Write(text); break; }
            Write(text[..at]);
            var value = text[at];
            if (value == 0xE2)
            {
                if (at + 2 < text.Length && text[at + 1] == 0x80 && text[at + 2] is 0xA8 or 0xA9)
                {
                    Write(text[at + 2] == 0xA8 ? "\\u2028"u8 : "\\u2029"u8);
                    text = text[(at + 3)..];
                }
                else
                {
                    Write(text.Slice(at, 1));
                    text = text[(at + 1)..];
                }
                continue;
            }
            switch (value)
            {
                case (byte)'"': Write("\\\""u8); break;
                case (byte)'\\': Write("\\\\"u8); break;
                case (byte)'\n': Write("\\n"u8); break;
                case (byte)'\r': Write("\\r"u8); break;
                case (byte)'\t': Write("\\t"u8); break;
                case (byte)'\b': Write("\\b"u8); break;
                case (byte)'\f': Write("\\f"u8); break;
                default:
                    "\\u00"u8.CopyTo(escape);
                    escape[4] = Hex[value >> 4];
                    escape[5] = Hex[value & 15];
                    Write(escape);
                    break;
            }
            text = text[(at + 1)..];
        }
        Write("\""u8);
    }

    /// <summary>The JSON number grammar: -?(0|[1-9][0-9]*)(.[0-9]+)?([eE][+-]?[0-9]+)?</summary>
    public static bool IsJsonNumber(ReadOnlySpan<byte> text)
    {
        var i = 0;
        if (i < text.Length && text[i] == '-') i++;
        if (i >= text.Length) return false;
        if (text[i] == '0') i++;
        else if (text[i] is >= (byte)'1' and <= (byte)'9') while (i < text.Length && char.IsAsciiDigit((char)text[i])) i++;
        else return false;
        if (i < text.Length && text[i] == '.')
        {
            var start = ++i;
            while (i < text.Length && char.IsAsciiDigit((char)text[i])) i++;
            if (i == start) return false;
        }
        if (i < text.Length && text[i] is (byte)'e' or (byte)'E')
        {
            i++;
            if (i < text.Length && text[i] is (byte)'+' or (byte)'-') i++;
            var start = i;
            while (i < text.Length && char.IsAsciiDigit((char)text[i])) i++;
            if (i == start) return false;
        }
        return i == text.Length;
    }

    private void HexBytes(ReadOnlySpan<byte> bytes)
    {
        Span<byte> pair = stackalloc byte[2];
        while (!bytes.IsEmpty)
        {
            var span = output.GetSpan(2);
            var count = Math.Min(bytes.Length, span.Length / 2);
            if (count == 0)
            {
                pair[0] = Hex[bytes[0] >> 4];
                pair[1] = Hex[bytes[0] & 15];
                Write(pair);
                bytes = bytes[1..];
                continue;
            }
            for (var i = 0; i < count; i++)
            {
                span[2 * i] = Hex[bytes[i] >> 4];
                span[2 * i + 1] = Hex[bytes[i] & 15];
            }
            output.Advance(2 * count);
            Bytes += 2 * count;
            bytes = bytes[count..];
        }
    }

    private void Write(ReadOnlySpan<byte> bytes)
    {
        while (!bytes.IsEmpty)
        {
            var span = output.GetSpan(1);
            var count = Math.Min(span.Length, bytes.Length);
            bytes[..count].CopyTo(span);
            output.Advance(count);
            Bytes += count;
            bytes = bytes[count..];
        }
    }

    /// <summary>An upper bound on Copy's bytes for rows [first, last] of a page: the stored text (replacements never
    /// lengthen it), 2 bytes per binary byte plus "0x", 4 per NULL, and the separators and ends of line.</summary>
    public static long EstimateCopyRows(in PageView page, int first, int last, ReadOnlySpan<int> selected, int eolBytes)
    {
        var rows = last - first + 1;
        var bytes = (long)rows * (selected.Length - 1 + eolBytes);
        foreach (var column in selected)
        {
            var nulls = page.NullCount(column, first, last);
            var span = page.SpanBytes(column, first, last);
            bytes += 4L * nulls + (page.Wire(column) == WireKind.Binary ? 2 * span + 2L * (rows - nulls) : span);
        }
        return bytes;
    }

    /// <summary>An upper bound on a header line's bytes.</summary>
    public static long EstimateHeader(IReadOnlyList<ResultColumn> columns, ReadOnlySpan<int> selected, int eolBytes)
    {
        long bytes = selected.Length - 1 + eolBytes;
        foreach (var column in selected)
            bytes += string.IsNullOrEmpty(columns[column].Name) ? NoColumnName.Length : Encoding.UTF8.GetByteCount(columns[column].Name);
        return bytes;
    }
}
