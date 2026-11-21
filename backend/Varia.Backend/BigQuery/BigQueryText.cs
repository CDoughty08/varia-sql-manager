using System.Buffers.Text;
using System.Globalization;
using System.Numerics;
using System.Text;

namespace Varia.Backend.BigQuery;

/// <summary>
/// The display text of BigQuery's date, time, interval, range and decimal values, written from their numbers (Arrow) or
/// rebuilt from BigQuery's text (REST), so both readers write byte-identical cells (docs/bigquery.md, Types and display).
/// DATE is <c>2026-11-15</c>; TIME <c>09:30:00.5</c> and DATETIME <c>2026-11-15T09:30:00.5</c>, with the fraction's trailing
/// zeros left out; TIMESTAMP <c>2026-11-15 09:30:00.000000 UTC</c>; INTERVAL BigQuery's canonical <c>Y-M D H:M:S[.F]</c>;
/// RANGE <c>[start, end)</c> with <c>UNBOUNDED</c>. Text a reader does not recognise is shown as BigQuery wrote it.
/// </summary>
internal static class BigQueryText
{
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    public const long MicrosPerDay = 86_400_000_000;
    /// <summary>TIMESTAMP's and DATETIME's range, 0001-01-01 to 9999-12-31 23:59:59.999999, in microseconds from the epoch.</summary>
    public const long MinMicros = -62_135_596_800_000_000, MaxMicros = 253_402_300_799_999_999;
    /// <summary>DATE's range in days from the epoch.</summary>
    public const int MinDays = -719_162, MaxDays = 2_932_896;

    public static int Timestamp(long micros, Span<byte> destination)
    {
        if (micros is < MinMicros or > MaxMicros) throw new FormatException("The TIMESTAMP is out of range.");
        var instant = System.DateTime.UnixEpoch.AddTicks(micros * 10);
        return instant.TryFormat(destination, out var written, "yyyy-MM-dd HH:mm:ss.ffffff' UTC'", Invariant) ? written : throw new FormatException();
    }

    public static int Date(long days, Span<byte> destination)
    {
        if (days is < MinDays or > MaxDays) throw new FormatException("The DATE is out of range.");
        return System.DateTime.UnixEpoch.AddDays(days).TryFormat(destination, out var written, "yyyy-MM-dd", Invariant) ? written : throw new FormatException();
    }

    public static int DateTime(long micros, Span<byte> destination)
    {
        if (micros is < MinMicros or > MaxMicros) throw new FormatException("The DATETIME is out of range.");
        var instant = System.DateTime.UnixEpoch.AddTicks(micros * 10);
        if (!instant.TryFormat(destination, out var written, "yyyy-MM-dd'T'HH:mm:ss", Invariant)) throw new FormatException();
        return written + Fraction(Math.Abs(micros % 1_000_000 + 1_000_000) % 1_000_000, destination[written..]);
    }

    public static int Time(long micros, Span<byte> destination)
    {
        if (micros is < 0 or >= MicrosPerDay) throw new FormatException("The TIME is out of range.");
        var seconds = micros / 1_000_000;
        if (destination.Length < 15) throw new FormatException();
        Two(seconds / 3600, destination);
        destination[2] = (byte)':';
        Two(seconds / 60 % 60, destination[3..]);
        destination[5] = (byte)':';
        Two(seconds % 60, destination[6..]);
        return 8 + Fraction(micros % 1_000_000, destination[8..]);
    }

    static void Two(long value, Span<byte> destination)
    {
        destination[0] = (byte)('0' + value / 10);
        destination[1] = (byte)('0' + value % 10);
    }

    /// <summary>A fraction of a second in microseconds as <c>.5</c> or <c>.123456</c>; nothing when it is zero.</summary>
    static int Fraction(long micros, Span<byte> destination)
    {
        if (micros == 0) return 0;
        var digits = 6;
        while (micros % 10 == 0) { micros /= 10; digits--; }
        if (destination.Length < digits + 1) throw new FormatException();
        destination[0] = (byte)'.';
        for (var i = digits; i >= 1; i--) { destination[i] = (byte)('0' + micros % 10); micros /= 10; }
        return digits + 1;
    }

    /// <summary>INTERVAL in BigQuery's canonical form: years and months under one sign, then days, then hours, minutes and
    /// seconds under one sign, the seconds' fraction to microseconds without trailing zeros (<c>1-2 3 4:5:6.789</c>,
    /// <c>-1-2 -3 -4:5:6</c>).</summary>
    public static int Interval(long months, long days, long micros, Span<byte> destination)
    {
        var text = new StringBuilder(48);
        if (months < 0) text.Append('-');
        var m = Math.Abs(months);
        text.Append((m / 12).ToString(Invariant)).Append('-').Append((m % 12).ToString(Invariant)).Append(' ').Append(days.ToString(Invariant)).Append(' ');
        if (micros < 0) text.Append('-');
        var t = micros == long.MinValue ? throw new FormatException("The INTERVAL is out of range.") : Math.Abs(micros);
        var seconds = t / 1_000_000;
        text.Append((seconds / 3600).ToString(Invariant)).Append(':').Append((seconds / 60 % 60).ToString(Invariant)).Append(':').Append((seconds % 60).ToString(Invariant));
        Span<byte> fraction = stackalloc byte[8];
        var length = Fraction(t % 1_000_000, fraction);
        var written = Encoding.ASCII.GetBytes(text.ToString(), destination);
        fraction[..length].CopyTo(destination[written..]);
        return written + length;
    }

    /// <summary>Decimal text at full precision with no exponent, no leading zeros and no trailing fractional zeros, from an
    /// unscaled integer and its scale (Arrow's NUMERIC and BIGNUMERIC).</summary>
    public static int Decimal(BigInteger unscaled, int scale, Span<byte> destination)
    {
        while (scale > 0 && !unscaled.IsZero && unscaled % 10 == 0) { unscaled /= 10; scale--; }
        if (unscaled.IsZero) scale = 0;
        var negative = unscaled.Sign < 0;
        var digits = BigInteger.Abs(unscaled).ToString(Invariant);
        if (scale > 0)
        {
            digits = digits.PadLeft(scale + 1, '0');
            digits = digits[..^scale] + "." + digits[^scale..];
        }
        if (negative) digits = "-" + digits;
        if (digits.Length > destination.Length) throw new FormatException("The decimal is too long.");
        return Encoding.ASCII.GetBytes(digits, destination);
    }

    /// <summary>The same for a NUMERIC that fits 128 bits, without BigInteger's allocations on the common path.</summary>
    public static int Decimal(Int128 unscaled, int scale, Span<byte> destination)
    {
        if (unscaled == Int128.MinValue) return Decimal((BigInteger)unscaled, scale, destination);
        while (scale > 0 && unscaled != 0 && unscaled % 10 == 0) { unscaled /= 10; scale--; }
        if (unscaled == 0) scale = 0;
        var negative = unscaled < 0;
        var magnitude = negative ? -unscaled : unscaled;
        Span<byte> digits = stackalloc byte[48];
        if (!magnitude.TryFormat(digits, out var count, default, Invariant)) throw new FormatException();
        // Sign, a leading "0." and zeros when every digit is fractional, the digits, and the point.
        var length = (negative ? 1 : 0) + (scale <= 0 ? count : count <= scale ? 2 + scale : count + 1);
        if (length > destination.Length) throw new FormatException("The decimal is too long.");
        var at = 0;
        if (negative) destination[at++] = (byte)'-';
        if (scale <= 0) digits[..count].CopyTo(destination[at..]);
        else if (count <= scale)
        {
            destination[at++] = (byte)'0';
            destination[at++] = (byte)'.';
            destination.Slice(at, scale - count).Fill((byte)'0');
            digits[..count].CopyTo(destination[(at + scale - count)..]);
        }
        else
        {
            digits[..(count - scale)].CopyTo(destination[at..]);
            destination[at + count - scale] = (byte)'.';
            digits[(count - scale)..count].CopyTo(destination[(at + count - scale + 1)..]);
        }
        return length;
    }

    // ---- BigQuery's REST text, read back into numbers so it is written as above ----

    /// <summary>DATE text (<c>2026-11-15</c>) as days from the epoch.</summary>
    public static bool TryParseDate(ReadOnlySpan<byte> text, out long days)
    {
        days = 0;
        if (text.Length != 10 || text[4] != '-' || text[7] != '-' || !Digits(text[..4], out var year) || !Digits(text[5..7], out var month) || !Digits(text[8..], out var day)
            || year < 1 || month is < 1 or > 12 || day < 1 || day > System.DateTime.DaysInMonth(year, month)) return false;
        days = (long)(new System.DateTime(year, month, day, 0, 0, 0, DateTimeKind.Utc) - System.DateTime.UnixEpoch).TotalDays;
        return true;
    }

    /// <summary>TIME text (<c>09:30:00</c>, <c>09:30:00.123456</c>) as microseconds since midnight.</summary>
    public static bool TryParseTime(ReadOnlySpan<byte> text, out long micros)
    {
        micros = 0;
        if (text.Length < 8 || text[2] != ':' || text[5] != ':' || !Digits(text[..2], out var hour) || !Digits(text[3..5], out var minute) || !Digits(text[6..8], out var second)
            || hour > 23 || minute > 59 || second > 59 || !TryFraction(text[8..], out var fraction)) return false;
        micros = ((hour * 60L + minute) * 60 + second) * 1_000_000 + fraction;
        return true;
    }

    /// <summary>DATETIME text (<c>2026-11-15T09:30:00.5</c>, or with a space) as microseconds from the epoch.</summary>
    public static bool TryParseDateTime(ReadOnlySpan<byte> text, out long micros)
    {
        micros = 0;
        if (text.Length < 19 || text[10] is not ((byte)'T' or (byte)' ') || !TryParseDate(text[..10], out var days) || !TryParseTime(text[11..], out var time)) return false;
        micros = days * MicrosPerDay + time;
        return true;
    }

    /// <summary>INTERVAL text in BigQuery's canonical form (<c>[-]Y-M [-]D [-]H:M:S[.F]</c>) as months, days and microseconds.</summary>
    public static bool TryParseInterval(ReadOnlySpan<byte> text, out long months, out long days, out long micros)
    {
        months = days = micros = 0;
        var first = text.IndexOf((byte)' ');
        if (first <= 0) return false;
        var second = text[(first + 1)..].IndexOf((byte)' ');
        if (second <= 0) return false;
        var yearMonth = text[..first];
        var day = text[(first + 1)..(first + 1 + second)];
        var time = text[(first + second + 2)..];
        var negativeMonths = yearMonth.Length > 0 && yearMonth[0] == '-';
        if (negativeMonths) yearMonth = yearMonth[1..];
        var dash = yearMonth.IndexOf((byte)'-');
        if (dash <= 0 || !Digits(yearMonth[..dash], out var y) || !Digits(yearMonth[(dash + 1)..], out var m) || m > 11) return false;
        if (!Utf8Parser.TryParse(day, out days, out var consumed) || consumed != day.Length) return false;
        var negativeTime = time.Length > 0 && time[0] == '-';
        if (negativeTime) time = time[1..];
        var c1 = time.IndexOf((byte)':');
        if (c1 <= 0) return false;
        var rest = time[(c1 + 1)..];
        var c2 = rest.IndexOf((byte)':');
        if (c2 <= 0) return false;
        var secondsText = rest[(c2 + 1)..];
        var point = secondsText.IndexOf((byte)'.');
        var wholeSeconds = point < 0 ? secondsText : secondsText[..point];
        if (!LongDigits(time[..c1], out var h) || !Digits(rest[..c2], out var min) || min > 59 || !Digits(wholeSeconds, out var s) || s > 59
            || !TryFraction(point < 0 ? [] : secondsText[point..], out var fraction)) return false;
        months = (y * 12L + m) * (negativeMonths ? -1 : 1);
        micros = ((h * 60 + min) * 60 + s) * 1_000_000 + fraction;
        if (negativeTime) micros = -micros;
        return true;
    }

    /// <summary>An optional fraction (<c>.5</c>, <c>.123456</c>; up to nine digits, read to the microsecond) as microseconds.</summary>
    static bool TryFraction(ReadOnlySpan<byte> text, out long micros)
    {
        micros = 0;
        if (text.Length == 0) return true;
        if (text[0] != '.' || text.Length is < 2 or > 10 || text[1..].ContainsAnyExceptInRange((byte)'0', (byte)'9')) return false;
        var digits = text[1..];
        for (var i = 0; i < 6; i++) micros = micros * 10 + (i < digits.Length ? digits[i] - '0' : 0);
        return digits.Length <= 6 || !digits[6..].ContainsAnyExcept((byte)'0');
    }

    static bool Digits(ReadOnlySpan<byte> text, out int value)
    {
        value = 0;
        if (text.Length is 0 or > 9 || text.ContainsAnyExceptInRange((byte)'0', (byte)'9')) return false;
        foreach (var digit in text) value = value * 10 + (digit - '0');
        return true;
    }

    static bool LongDigits(ReadOnlySpan<byte> text, out long value)
    {
        value = 0;
        if (text.Length is 0 or > 15 || text.ContainsAnyExceptInRange((byte)'0', (byte)'9')) return false;
        foreach (var digit in text) value = value * 10 + (digit - '0');
        return true;
    }
}
