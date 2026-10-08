using System.Data.SqlTypes;
using System.Globalization;
using System.Text;

namespace Varia.Backend.Results;

/// <summary>SSMS display text for SQL values (owner decision: bits as 1/0, money with 2–4 decimals, shortest round-trip
/// floats, space-separated dates), written as UTF-8 straight into a page. tests/fixtures/sql-display.json holds the
/// sample strings; docs/ipc.md has the table.</summary>
internal static class CellFormat
{
    /// <summary>Room for any fixed-size value (the longest, decimal(38) with sign and point, is 40 bytes).</summary>
    public const int MaxFixedBytes = 64;
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    private static readonly string[] DateTime2Formats = [.. Enumerable.Range(0, 8).Select(scale => "yyyy-MM-dd HH:mm:ss" + Fraction(scale, "."))];
    private static readonly string[] OffsetFormats = [.. DateTime2Formats.Select(format => format + " zzz")];
    private static readonly string[] TimeFormats = [.. Enumerable.Range(0, 8).Select(scale => @"hh\:mm\:ss" + Fraction(scale, @"\."))];

    private static string Fraction(int scale, string point) => scale == 0 ? "" : point + new string('f', scale);

    public static int WriteBit(Span<byte> destination, bool value)
    {
        destination[0] = value ? (byte)'1' : (byte)'0';
        return 1;
    }

    public static int WriteInteger(Span<byte> destination, long value) => Format(destination, value, default);

    /// <summary>decimal/numeric up to precision 28; System.Decimal keeps the column's scale (-123.4500).</summary>
    public static int WriteDecimal(Span<byte> destination, decimal value) => Format(destination, value, default);

    /// <summary>decimal/numeric with precision 29–38, beyond System.Decimal.</summary>
    public static int WriteSqlDecimal(Span<byte> destination, SqlDecimal value) => Encoding.ASCII.GetBytes(value.ToString(), destination);

    public static int WriteMoney(Span<byte> destination, decimal value) => Format(destination, value, "0.00##");

    /// <summary>real: the shortest text that round-trips (0.1, 3.4028235E+38).</summary>
    public static int WriteReal(Span<byte> destination, float value) => Format(destination, value, default);

    /// <summary>float: the shortest text that round-trips (0.1, 1E+20, 1E-05).</summary>
    public static int WriteFloat(Span<byte> destination, double value) => Format(destination, value, default);

    public static int WriteDate(Span<byte> destination, DateTime value) => Format(destination, value, "yyyy-MM-dd");
    public static int WriteSmallDateTime(Span<byte> destination, DateTime value) => Format(destination, value, "yyyy-MM-dd HH:mm:ss");
    public static int WriteDateTime(Span<byte> destination, DateTime value) => Format(destination, value, "yyyy-MM-dd HH:mm:ss.fff");

    /// <summary>datetime2(n): n fractional digits, none when n is 0.</summary>
    public static int WriteDateTime2(Span<byte> destination, DateTime value, int scale) => Format(destination, value, DateTime2Formats[Scale(scale)]);

    public static int WriteDateTimeOffset(Span<byte> destination, DateTimeOffset value, int scale) => Format(destination, value, OffsetFormats[Scale(scale)]);

    public static int WriteTime(Span<byte> destination, TimeSpan value, int scale) => Format(destination, value, TimeFormats[Scale(scale)]);

    /// <summary>Uppercase, as SSMS shows uniqueidentifier values.</summary>
    public static int WriteGuid(Span<byte> destination, Guid value)
    {
        var written = Format(destination, value, "D");
        foreach (ref var unit in destination[..written])
            if (unit is >= (byte)'a' and <= (byte)'f') unit -= 'a' - 'A';
        return written;
    }

    /// <summary>A vector as a JSON-style list of float32 values in shortest round-trip form, cut at
    /// <paramref name="maxChars"/>.</summary>
    public static string Vector(ReadOnlySpan<float> values, int maxChars, out bool truncated)
    {
        var text = new StringBuilder("[");
        for (var i = 0; i < values.Length && text.Length <= maxChars; i++)
            text.Append(i == 0 ? "" : ",").Append(values[i].ToString(Invariant));
        text.Append(']');
        truncated = text.Length > maxChars;
        return truncated ? Prefix(text.ToString(), maxChars, out _).ToString() : text.ToString();
    }

    /// <summary>At most <paramref name="maxChars"/> UTF-16 units without splitting a surrogate pair.</summary>
    public static ReadOnlySpan<char> Prefix(ReadOnlySpan<char> text, int maxChars, out bool truncated)
    {
        truncated = text.Length > maxChars;
        if (!truncated) return text;
        var end = maxChars > 0 && char.IsHighSurrogate(text[maxChars - 1]) ? maxChars - 1 : maxChars;
        return text[..end];
    }

    private static int Scale(int scale) => scale is >= 0 and <= 7 ? scale : throw new ArgumentOutOfRangeException(nameof(scale));

    private static int Format<T>(Span<byte> destination, T value, ReadOnlySpan<char> format) where T : IUtf8SpanFormattable
        => value.TryFormat(destination, out var written, format, Invariant) ? written : throw new ArgumentException("The destination is too small for the value.", nameof(destination));
}
