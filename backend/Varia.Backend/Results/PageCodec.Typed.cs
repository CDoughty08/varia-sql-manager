using System.Buffers;
using System.Globalization;
using System.Runtime.InteropServices;

namespace Varia.Backend.Results;

/// <summary>The typed form of a text column inside the lengths form (docs/page-compression-findings.md, "Typed form"): a
/// column whose every non-NULL cell on the page is the canonical text of one value shape (an integer, a decimal with a
/// fixed range of fraction digits, a GUID, a date and time, a time) is kept as those values, each the zigzag LEB128 of
/// its difference from the cell before (a GUID as its 16 bytes), instead of its cells' lengths and text. Unpacking writes
/// the same text back. The shape is read from the text alone, and a column is typed only when every cell is the one text
/// its value writes back (no leading zeros, a fixed layout, one letter case), so the page comes back byte for byte;
/// any other column keeps its lengths and text.</summary>
internal static partial class PageCodec
{
    /// <summary>The packed bytes' first byte for a lengths form with at least one typed column.</summary>
    private const byte AsTyped = 2;
    /// <summary>A typed column's kind, in place of <see cref="OneLength"/> or <see cref="EachLength"/>.</summary>
    private const byte TypedInteger = 2, TypedDecimal = 3, TypedGuid = 4, TypedMoment = 5, TypedTime = 6;
    /// <summary>Set in a typed column's kind when its values are their distances from the page's least value, which follows
    /// the parameters, rather than differences from the value before.</summary>
    private const byte Ranged = 0x80;
    /// <summary>The largest number of digits a decimal keeps as one long (10^18 fits).</summary>
    private const int MaxDecimalDigits = 18;

    private static readonly long[] Powers = [.. Enumerable.Range(0, 19).Select(power => (long)Math.Pow(10, power))];

    /// <summary>A typed text column's head in the form (its kind, parameters and the length of its values) and its values,
    /// which go to the page's values apart from the form. Returns the head's length, or -1 when the column has no one shape
    /// or its head and values would not be shorter than its offsets and data together. The values go at <paramref name="valuesAt"/>
    /// in <paramref name="valuesRoom"/>, rented from the shared pool at <paramref name="roomLength"/> bytes once a column has a
    /// shape, so a page with none rents no room for them.</summary>
    private static int WriteTyped(ReadOnlySpan<byte> offsetBytes, ReadOnlySpan<byte> data, ReadOnlySpan<byte> validity, int rows, Span<byte> form, ref byte[]? valuesRoom, int valuesAt, int roomLength, out int valuesLength)
    {
        valuesLength = 0;
        var offsets = MemoryMarshal.Cast<byte, uint>(offsetBytes)[..(rows + 1)];
        // Offsets that do not run from 0 up to the data's length (bytes PageBuilder did not seal) are left to the lengths
        // form, which refuses them.
        if (offsets[0] != 0 || offsets[rows] != (uint)data.Length) return -1;
        var first = -1;
        for (var row = 0; row < rows; row++)
        {
            if (offsets[row + 1] < offsets[row]) return -1;
            var empty = offsets[row + 1] == offsets[row];
            if (!validity.IsEmpty && (validity[row >> 3] & (1 << (row & 7))) == 0) { if (!empty) return -1; }
            else if (first < 0) first = row;
        }
        if (first < 0) return -1;
        // A column of one-character cells (bits, single digits) packs as well as text, and typing it only slows unpacking.
        var wider = false;
        for (var row = first; row < rows && !wider; row++) wider = offsets[row + 1] - offsets[row] > 1;
        if (!wider) return -1;
        var sample = data[(int)offsets[first]..(int)offsets[first + 1]];
        var limit = offsetBytes.Length + data.Length;
        if (form.Length < 16) return -1;
        byte kind;
        int a = 0, b = 0;
        if (MomentShape(sample, out var hasTime, out var digits, out var hasOffset))
            (kind, a, b) = (TypedMoment, (hasTime ? 1 : 0) | (hasOffset ? 2 : 0), digits);
        else if (TimeShape(sample, out digits)) (kind, a) = (TypedTime, digits);
        else if (sample.Length == 36 && sample[8] == '-') (kind, a) = (TypedGuid, HasLower(data) ? 1 : 0);
        else if (!DecimalRange(data, offsets, validity, rows, out a, out b)) return -1;
        else kind = b == 0 ? TypedInteger : TypedDecimal;
        // Kind and parameters (and the page's least value, when values are kept as their distance from it), then the
        // values' length in a fixed three-byte LEB128, then the values.
        Span<byte> head = stackalloc byte[16];
        var headLength = 1;
        if (kind is TypedMoment or TypedDecimal) { head[headLength++] = (byte)a; head[headLength++] = (byte)b; }
        else if (kind is TypedTime or TypedGuid) head[headLength++] = (byte)a;
        limit = Math.Min(limit - headLength - 13, roomLength - valuesAt);
        if (kind == TypedGuid)
        {
            head[0] = kind;
            var values = (valuesRoom ??= Rent(Math.Max(1, roomLength))).AsSpan(valuesAt);
            var at = 0;
            for (var row = 0; row < rows; row++)
            {
                if (!validity.IsEmpty && (validity[row >> 3] & (1 << (row & 7))) == 0) continue;
                if (at + 16 > limit || !Guid(data[(int)offsets[row]..(int)offsets[row + 1]], a == 1, values.Slice(at, 16))) return -1;
                at += 16;
            }
            return Headed(form, head[..headLength], valuesLength = at);
        }
        var offset = kind == TypedMoment && (a & 2) != 0;
        var parsed = ArrayPool<long>.Shared.Rent(rows);
        var minutes = offset ? ArrayPool<long>.Shared.Rent(rows) : null;
        try
        {
            var count = 0;
            for (var row = 0; row < rows; row++)
            {
                if (!validity.IsEmpty && (validity[row >> 3] & (1 << (row & 7))) == 0) continue;
                var cell = data[(int)offsets[row]..(int)offsets[row + 1]];
                long value, minute = 0;
                var ok = kind switch
                {
                    TypedMoment => Moment(cell, (a & 1) != 0, b, offset, out value, out minute),
                    TypedTime => Time(cell, a, out value),
                    _ => Decimal(cell, a, b, out value),
                };
                if (!ok) return -1;
                if (minutes is not null) minutes[count] = minute;
                parsed[count++] = value;
            }
            // Each value as its difference from the one before (keys, times), or as its distance from the least
            // (values scattered over a range), whichever is shorter.
            long least = long.MaxValue, previous = 0, deltaBytes = 0, rangeBytes = 0;
            for (var i = 0; i < count; i++) least = Math.Min(least, parsed[i]);
            for (var i = 0; i < count; i++)
            {
                deltaBytes += LebLength(Zigzag(unchecked(parsed[i] - previous)));
                rangeBytes += LebLength(unchecked((ulong)(parsed[i] - least)));
                previous = parsed[i];
            }
            var ranged = rangeBytes < deltaBytes;
            head[0] = (byte)(kind | (ranged ? Ranged : 0));
            if (ranged) WriteLeb64(head, ref headLength, Zigzag(least));
            // Rented only now that every cell parsed: a column a cell rules out (text that only looked like a number) rents none.
            var values = (valuesRoom ??= Rent(Math.Max(1, roomLength))).AsSpan(valuesAt);
            var at = 0;
            previous = 0;
            for (var i = 0; i < count; i++)
            {
                if (at + 20 > limit) return -1;
                if (ranged) WriteLeb64(values, ref at, unchecked((ulong)(parsed[i] - least)));
                else WriteDelta(values, ref at, parsed[i], ref previous);
                if (minutes is not null) WriteLeb64(values, ref at, Zigzag(minutes[i]));
            }
            return Headed(form, head[..headLength], valuesLength = at);
        }
        finally
        {
            ArrayPool<long>.Shared.Return(parsed);
            if (minutes is not null) ArrayPool<long>.Shared.Return(minutes);
        }
    }

    /// <summary>Writes the head and its values' length, in a fixed three-byte LEB128, and returns the head's length.</summary>
    private static int Headed(Span<byte> form, ReadOnlySpan<byte> head, int length)
    {
        if (length >= 1 << 21) return -1;
        head.CopyTo(form);
        form[head.Length] = (byte)(length | 0x80);
        form[head.Length + 1] = (byte)((length >> 7) | 0x80);
        form[head.Length + 2] = (byte)(length >> 14);
        return head.Length + 3;
    }

    private static int LebLength(ulong value) => value < 1UL << 7 ? 1 : value < 1UL << 14 ? 2 : value < 1UL << 21 ? 3 : value < 1UL << 28 ? 4 : (64 - System.Numerics.BitOperations.LeadingZeroCount(value) + 6) / 7;

    /// <summary>Writes a typed column back: its offsets into <paramref name="offsetsRoom"/> and its text into
    /// <paramref name="dataRoom"/>, from its head in the form and its values at <paramref name="valuesAt"/>. Returns the
    /// head's length.</summary>
    private static int ReadTyped(ReadOnlySpan<byte> form, ReadOnlySpan<byte> allValues, ref int valuesAt, ReadOnlySpan<byte> validity, int rows, Span<byte> offsetsRoom, Span<byte> dataRoom)
    {
        var kind = (byte)(form[0] & ~Ranged);
        var ranged = (form[0] & Ranged) != 0;
        var at = 1;
        int a = 0, b = 0;
        if (form.Length < 4) throw Unreadable();
        if (kind is TypedMoment or TypedDecimal) { a = form[at++]; b = form[at++]; }
        else if (kind is TypedTime or TypedGuid) a = form[at++];
        else if (kind != TypedInteger) throw Unreadable();
        if (ranged && kind == TypedGuid) throw Unreadable();
        var least = ranged ? Unzigzag(ReadLeb64(form, ref at)) : 0;
        if (at + 3 > form.Length) throw Unreadable();
        var length = (form[at] & 0x7F) | (form[at + 1] & 0x7F) << 7 | form[at + 2] << 14;
        at += 3;
        if (length > allValues.Length - valuesAt) throw Unreadable();
        if (kind == TypedDecimal ? a > b || b > MaxDecimalDigits : kind is TypedMoment ? b > 7 || a > 3 : kind is TypedTime ? a > 7 : kind is TypedGuid && a > 1) throw Unreadable();
        {
            var values = allValues.Slice(valuesAt, length);
            var offsets = MemoryMarshal.Cast<byte, uint>(offsetsRoom);
            var read = 0;
            var written = 0;
            long previous = 0;
            offsets[0] = 0;
            // The last cells are written through a scratch, so no cell is written past the data's end.
            Span<byte> scratch = stackalloc byte[64];
            for (var row = 0; row < rows; row++)
            {
                if (!validity.IsEmpty && (validity[row >> 3] & (1 << (row & 7))) == 0) { offsets[row + 1] = (uint)written; continue; }
                var near = dataRoom.Length - written < scratch.Length;
                var to = near ? scratch : dataRoom[written..];
                var before = written;
                switch (kind)
                {
                    case TypedGuid:
                        if (values.Length - read < 16) throw Unreadable();
                        written += WriteGuid(values.Slice(read, 16), a == 1, to);
                        read += 16;
                        break;
                    case TypedMoment:
                    {
                        var value = ranged ? unchecked(least + (long)ReadLeb64(values, ref read)) : ReadDelta(values, ref read, ref previous);
                        var minutes = (a & 2) != 0 ? Unzigzag(ReadLeb64(values, ref read)) : 0;
                        written += WriteMoment(to, value, (a & 1) != 0, b, (a & 2) != 0, minutes);
                        break;
                    }
                    case TypedTime:
                        written += WriteTime(to, ranged ? unchecked(least + (long)ReadLeb64(values, ref read)) : ReadDelta(values, ref read, ref previous), a);
                        break;
                    default:
                        written += WriteDecimal(to, ranged ? unchecked(least + (long)ReadLeb64(values, ref read)) : ReadDelta(values, ref read, ref previous), a, b);
                        break;
                }
                if (near)
                {
                    if (written > dataRoom.Length) throw Unreadable();
                    scratch[..(written - before)].CopyTo(dataRoom[before..]);
                }
                offsets[row + 1] = (uint)written;
            }
            if (read != length || written != dataRoom.Length) throw Unreadable();
            valuesAt += length;
            return at;
        }
    }

    /// <summary>Each column's typed kind on <paramref name="page"/> (0 for a column that keeps its lengths and text, or for
    /// bytes that are not a sealed page), for the checks.</summary>
    internal static byte[] TypedKinds(ReadOnlySpan<byte> page)
    {
        if (!ReadLayout(page, out var layout, out var blobStart, out var rows, out var columns)) return [];
        try
        {
            var kinds = new byte[columns];
            var blob = page[blobStart..];
            var form = new byte[64];
            byte[]? values = new byte[page.Length];
            for (var c = 0; c < columns; c++)
            {
                if (layout[c * Stride] != (int)WireKind.Text) continue;
                var validity = layout[c * Stride + 2] == 0 ? default : blob.Slice(layout[c * Stride + 1], layout[c * Stride + 2]);
                if (WriteTyped(blob.Slice(layout[c * Stride + 3], layout[c * Stride + 4]), blob.Slice(layout[c * Stride + 5], layout[c * Stride + 6]), validity, rows, form, ref values, 0, page.Length, out _) >= 0)
                    kinds[c] = (byte)(form[0] & ~Ranged);
            }
            return kinds;
        }
        finally { ArrayPool<int>.Shared.Return(layout); }
    }

    /// <summary>The kinds <see cref="TypedKinds"/> reports, by name, for the checks.</summary>
    internal static class Kind
    {
        public const byte None = 0, Integer = TypedInteger, Decimal = TypedDecimal, Guid = TypedGuid, Moment = TypedMoment, Time = TypedTime;
    }

    // ---- Shapes: what the first cell looks like decides what every cell must be.

    /// <summary>Whether the column's first hex letter is lowercase: its GUIDs are then all lowercase, or it is not typed. A
    /// GUID of digits alone fits either case.</summary>
    private static bool HasLower(ReadOnlySpan<byte> data)
    {
        foreach (var unit in data)
        {
            if (unit is >= (byte)'A' and <= (byte)'F') return false;
            if (unit is >= (byte)'a' and <= (byte)'f') return true;
        }
        return false;
    }

    /// <summary>yyyy-MM-dd, then optionally " HH:mm:ss", ".f" to seven digits, and " +hh:mm".</summary>
    private static bool MomentShape(ReadOnlySpan<byte> text, out bool hasTime, out int digits, out bool hasOffset)
    {
        (hasTime, digits, hasOffset) = (false, 0, false);
        if (text.Length < 10 || text[4] != '-' || text[7] != '-') return false;
        var at = 10;
        if (text.Length >= 19 && text[10] == ' ' && text[13] == ':' && text[16] == ':')
        {
            hasTime = true;
            at = 19;
            if (at < text.Length && text[at] == '.')
            {
                at++;
                while (at < text.Length && text[at] is >= (byte)'0' and <= (byte)'9') { at++; digits++; }
                if (digits is 0 or > 7) return false;
            }
        }
        if (at + 7 == text.Length && text[at] == ' ' && text[at + 1] is (byte)'+' or (byte)'-' && text[at + 4] == ':') { hasOffset = true; at += 7; }
        return at == text.Length;
    }

    /// <summary>HH:mm:ss and ".f" to seven digits.</summary>
    private static bool TimeShape(ReadOnlySpan<byte> text, out int digits)
    {
        digits = 0;
        if (text.Length < 8 || text[2] != ':' || text[5] != ':') return false;
        if (text.Length == 8) return true;
        digits = text.Length - 9;
        return text[8] == '.' && digits is >= 1 and <= 7;
    }

    /// <summary>The fewest and most fraction digits over the column's cells, when every cell is a decimal's text.</summary>
    private static bool DecimalRange(ReadOnlySpan<byte> data, ReadOnlySpan<uint> offsets, ReadOnlySpan<byte> validity, int rows, out int min, out int max)
    {
        (min, max) = (int.MaxValue, 0);
        for (var row = 0; row < rows; row++)
        {
            if (!validity.IsEmpty && (validity[row >> 3] & (1 << (row & 7))) == 0) continue;
            var cell = data[(int)offsets[row]..(int)offsets[row + 1]];
            var point = cell.IndexOf((byte)'.');
            var fraction = point < 0 ? 0 : cell.Length - point - 1;
            if (point == 0 || fraction == 0 && point > 0) return false;
            (min, max) = (Math.Min(min, fraction), Math.Max(max, fraction));
        }
        return max <= MaxDecimalDigits;
    }

    // ---- Values: each is the cell's text exactly, or false.

    private static bool Digits(ReadOnlySpan<byte> text, int at, int count, out int value)
    {
        value = 0;
        for (var i = at; i < at + count; i++)
        {
            var digit = text[i] - '0';
            if ((uint)digit > 9) return false;
            value = value * 10 + digit;
        }
        return true;
    }

    /// <summary>An integer or decimal's text: an optional minus, an integer part without leading zeros, and between
    /// <paramref name="min"/> and <paramref name="max"/> fraction digits that end in a non-zero digit past
    /// <paramref name="min"/> (what <see cref="WriteDecimal"/> writes back). A negative zero is not typed.</summary>
    private static bool Decimal(ReadOnlySpan<byte> text, int min, int max, out long value)
    {
        value = 0;
        var negative = text.Length > 0 && text[0] == '-';
        var at = negative ? 1 : 0;
        var point = text.IndexOf((byte)'.');
        var whole = (point < 0 ? text.Length : point) - at;
        var fraction = point < 0 ? 0 : text.Length - point - 1;
        if (whole < 1 || (whole > 1 && text[at] == '0') || whole + max > MaxDecimalDigits || fraction < min || fraction > max) return false;
        if (fraction > min && text[^1] == '0') return false;
        long magnitude = 0;
        for (var i = at; i < at + whole; i++)
        {
            var digit = text[i] - '0';
            if ((uint)digit > 9) return false;
            magnitude = magnitude * 10 + digit;
        }
        for (var i = 0; i < fraction; i++)
        {
            var digit = text[point + 1 + i] - '0';
            if ((uint)digit > 9) return false;
            magnitude = magnitude * 10 + digit;
        }
        magnitude *= Powers[max - fraction];
        if (negative && magnitude == 0) return false;
        value = negative ? -magnitude : magnitude;
        return true;
    }

    private static int WriteDecimal(Span<byte> to, long value, int min, int max)
    {
        var at = 0;
        if (value < 0) { to[at++] = (byte)'-'; value = -value; }
        if (max == 0)
        {
            ((ulong)value).TryFormat(to[at..], out var integer, default, CultureInfo.InvariantCulture);
            return at + integer;
        }
        var (whole, fraction) = Math.DivRem((ulong)value, (ulong)Powers[max]);
        whole.TryFormat(to[at..], out var written, default, CultureInfo.InvariantCulture);
        at += written;
        var keep = max;
        while (keep > min && fraction % 10 == 0) { fraction /= 10; keep--; }
        if (keep == 0) return at;
        to[at++] = (byte)'.';
        Fraction(to.Slice(at, keep), fraction);
        return at + keep;
    }

    /// <summary>Writes <paramref name="value"/> with leading zeros into all of <paramref name="to"/>, two digits at a time.</summary>
    private static void Fraction(Span<byte> to, ulong value)
    {
        var i = to.Length;
        for (; i >= 2; i -= 2)
        {
            (value, var pair) = Math.DivRem(value, 100UL);
            Two(to, i - 2, (int)pair);
        }
        if (i == 1) to[0] = (byte)('0' + value % 10);
    }

    private static bool Guid(ReadOnlySpan<byte> text, bool lower, Span<byte> to)
    {
        if (text.Length != 36 || text[8] != '-' || text[13] != '-' || text[18] != '-' || text[23] != '-') return false;
        var at = 0;
        for (var i = 0; i < 36; i += 2)
        {
            if (i is 8 or 13 or 18 or 23) i++;
            var high = Hex(text[i], lower);
            var low = Hex(text[i + 1], lower);
            if ((high | low) < 0) return false;
            to[at++] = (byte)(high << 4 | low);
        }
        return true;
    }

    private static int Hex(byte unit, bool lower) => unit switch
    {
        >= (byte)'0' and <= (byte)'9' => unit - '0',
        >= (byte)'A' and <= (byte)'F' when !lower => unit - 'A' + 10,
        >= (byte)'a' and <= (byte)'f' when lower => unit - 'a' + 10,
        _ => -1,
    };

    private static int WriteGuid(ReadOnlySpan<byte> bytes, bool lower, Span<byte> to)
    {
        var letters = lower ? "0123456789abcdef"u8 : "0123456789ABCDEF"u8;
        var at = 0;
        for (var i = 0; i < 16; i++)
        {
            if (i is 4 or 6 or 8 or 10) to[at++] = (byte)'-';
            to[at++] = letters[bytes[i] >> 4];
            to[at++] = letters[bytes[i] & 15];
        }
        return 36;
    }

    /// <summary>A date's text (days since 0001-01-01), with its time in units of 10^-digits seconds when it has one, and
    /// its offset's minutes ("+00:00" for zero; "-00:00" is not typed).</summary>
    private static bool Moment(ReadOnlySpan<byte> text, bool hasTime, int digits, bool hasOffset, out long value, out long minutes)
    {
        (value, minutes) = (0, 0);
        var length = 10 + (hasTime ? 9 + (digits > 0 ? digits + 1 : 0) : 0) + (hasOffset ? 7 : 0);
        if (text.Length != length || text[4] != '-' || text[7] != '-') return false;
        if (!Digits(text, 0, 4, out var year) || !Digits(text, 5, 2, out var month) || !Digits(text, 8, 2, out var day)) return false;
        if (year < 1 || month is < 1 or > 12 || day < 1 || day > DateTime.DaysInMonth(year, month)) return false;
        value = new DateOnly(year, month, day).DayNumber;
        var at = 10;
        if (hasTime)
        {
            if (text[10] != ' ' || !Clock(text, 11, digits, out var clock)) return false;
            value = value * 86_400 * Powers[digits] + clock;
            at = 19 + (digits > 0 ? digits + 1 : 0);
        }
        if (!hasOffset) return true;
        if (text[at] != ' ' || text[at + 1] is not ((byte)'+' or (byte)'-') || text[at + 4] != ':') return false;
        if (!Digits(text, at + 2, 2, out var hours) || !Digits(text, at + 5, 2, out var mins) || hours > 14 || mins > 59) return false;
        minutes = hours * 60 + mins;
        if (text[at + 1] == '-') { if (minutes == 0) return false; minutes = -minutes; }
        return true;
    }

    private static bool Time(ReadOnlySpan<byte> text, int digits, out long value)
    {
        value = 0;
        return text.Length == 8 + (digits > 0 ? digits + 1 : 0) && Clock(text, 0, digits, out value);
    }

    /// <summary>HH:mm:ss at <paramref name="at"/> and, with digits, a point and that many fraction digits.</summary>
    private static bool Clock(ReadOnlySpan<byte> text, int at, int digits, out long value)
    {
        value = 0;
        if (text[at + 2] != ':' || text[at + 5] != ':') return false;
        if (!Digits(text, at, 2, out var hours) || !Digits(text, at + 3, 2, out var minutes) || !Digits(text, at + 6, 2, out var seconds)) return false;
        if (hours > 23 || minutes > 59 || seconds > 59) return false;
        var fraction = 0;
        if (digits > 0 && (text[at + 8] != '.' || !Digits(text, at + 9, digits, out fraction))) return false;
        value = (hours * 3600L + minutes * 60 + seconds) * Powers[digits] + fraction;
        return true;
    }

    private static int WriteMoment(Span<byte> to, long value, bool hasTime, int digits, bool hasOffset, long minutes)
    {
        // A moment before 0001-01-01 (only damaged bytes give one) would divide to day 0 and a negative time.
        if (value < 0) throw Unreadable();
        var day = value;
        long clock = 0;
        if (hasTime)
        {
            var perDay = 86_400 * Powers[digits];
            day = Math.DivRem(value, perDay, out clock);
        }
        if ((ulong)day > (ulong)DateOnly.MaxValue.DayNumber) throw Unreadable();
        var date = DateOnly.FromDayNumber((int)day);
        Two(to, 0, date.Year / 100);
        Two(to, 2, date.Year % 100);
        to[4] = (byte)'-';
        Two(to, 5, date.Month);
        to[7] = (byte)'-';
        Two(to, 8, date.Day);
        var at = 10;
        if (hasTime)
        {
            to[at++] = (byte)' ';
            at += WriteClock(to[at..], clock, digits);
        }
        if (hasOffset)
        {
            to[at] = (byte)' ';
            if (minutes is < -(14 * 60 + 59) or > 14 * 60 + 59) throw Unreadable();
            to[at + 1] = minutes < 0 ? (byte)'-' : (byte)'+';
            var magnitude = Math.Abs(minutes);
            Two(to, at + 2, (int)(magnitude / 60));
            to[at + 4] = (byte)':';
            Two(to, at + 5, (int)(magnitude % 60));
            at += 7;
        }
        return at;
    }

    private static int WriteTime(Span<byte> to, long value, int digits)
    {
        if ((ulong)value >= (ulong)(86_400 * Powers[digits])) throw Unreadable();
        return WriteClock(to, value, digits);
    }

    private static int WriteClock(Span<byte> to, long clock, int digits)
    {
        var seconds = Math.DivRem(clock, Powers[digits], out var fraction);
        Two(to, 0, (int)(seconds / 3600));
        to[2] = (byte)':';
        Two(to, 3, (int)(seconds / 60 % 60));
        to[5] = (byte)':';
        Two(to, 6, (int)(seconds % 60));
        if (digits == 0) return 8;
        to[8] = (byte)'.';
        Fraction(to.Slice(9, digits), (ulong)fraction);
        return 9 + digits;
    }

    private static ReadOnlySpan<byte> Pairs => "00010203040506070809101112131415161718192021222324252627282930313233343536373839404142434445464748495051525354555657585960616263646566676869707172737475767778798081828384858687888990919293949596979899"u8;

    private static void Two(Span<byte> to, int at, int value) => Pairs.Slice(2 * value, 2).CopyTo(to[at..]);

    // ---- Integers: differences from the cell before, zigzagged so small negative steps stay short.

    private static ulong Zigzag(long value) => (ulong)((value << 1) ^ (value >> 63));
    private static long Unzigzag(ulong value) => (long)(value >> 1) ^ -(long)(value & 1);

    private static void WriteDelta(Span<byte> to, ref int at, long value, ref long previous)
    {
        WriteLeb64(to, ref at, Zigzag(unchecked(value - previous)));
        previous = value;
    }

    private static long ReadDelta(ReadOnlySpan<byte> from, ref int at, ref long previous) => previous = unchecked(previous + Unzigzag(ReadLeb64(from, ref at)));

    private static void WriteLeb64(Span<byte> to, ref int at, ulong value)
    {
        for (; value >= 0x80; value >>= 7) to[at++] = (byte)(value | 0x80);
        to[at++] = (byte)value;
    }

    private static ulong ReadLeb64(ReadOnlySpan<byte> from, ref int at)
    {
        ulong value = 0;
        for (var shift = 0; shift < 70 && at < from.Length; shift += 7)
        {
            var b = from[at++];
            value |= (ulong)(b & 0x7F) << shift;
            if (b < 0x80) return value;
        }
        throw Unreadable();
    }
}
