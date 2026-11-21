using System.Data.SqlTypes;
using System.Globalization;
using System.IO.Compression;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>The typed form of packed pages (PageCodec.Typed.cs): columns the product's own writers fill are typed, every
/// page comes back byte for byte, text that is not exactly what its value writes back keeps its lengths and text, a damaged
/// typed page fails as unreadable, and a store's typed pages read back as sealed and charge their packed length.</summary>
internal static class TypedFormChecks
{
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;

    public static void Run(Action<bool, string> check)
    {
        Writers(check);
        NearMisses(check);
        Layouts(check);
        Damaged(check);
        BeforeDayOne(check);
        Stored(check);
        Scratch(check);
    }

    /// <summary>Packing rents from the shared pool only what a page needs: a page with no typed column (one 8 MiB row of four
    /// XML documents) the form and one frame's bound, as before the typed form, where it rented a second frame's bound and a
    /// room for values none of its columns has; a typed page also rents its values' room and their frame's bound.</summary>
    private static void Scratch(Action<bool, string> check)
    {
        var builder = new PageBuilder(1, [.. Enumerable.Repeat(WireKind.Text, 4)]);
        var document = "<x>" + new string('x', 2_097_152 - 7) + "</x>";
        builder.BeginRow();
        for (var c = 0; c < 4; c++) builder.AppendText(document);
        builder.CommitRow();
        var wide = builder.Seal();
        PageCodec.Rented = 0;
        var packed = PageCodec.Pack(wide);
        var rented = PageCodec.Rented;
        var bound = ZstandardEncoder.GetMaxCompressedLength(wide.Length);
        var typedPage = Page(4096, [(b, row) => b.AppendText((40_000_000_000L + 17 * row).ToString(Invariant))], holes: false);
        PageCodec.Rented = 0;
        var typedPacked = PageCodec.Pack(typedPage);
        var typedRented = PageCodec.Rented;
        check(packed is not null && PageCodec.Unpack(packed, wide.Length).AsSpan().SequenceEqual(wide) && rented <= wide.Length + bound + 64
            && typedPacked is { Length: > 0 } && typedPacked[0] == 2 && PageCodec.Unpack(typedPacked, typedPage.Length).AsSpan().SequenceEqual(typedPage)
            && typedRented > 2L * typedPage.Length && typedRented <= 2L * typedPage.Length + 2 * ZstandardEncoder.GetMaxCompressedLength(typedPage.Length) + 64,
            "packing rents the form and the frames' bounds, and a values room only for a typed page: " + rented + " for an " + wide.Length + "-byte page, " + typedRented + " for a typed " + typedPage.Length);
    }

    private delegate void Cell(PageBuilder builder, int row);

    /// <summary>A sealed page of text columns, each filled by its writer, with NULL and failed cells where
    /// <paramref name="holes"/> says.</summary>
    private static byte[] Page(int rows, IReadOnlyList<Cell> columns, bool holes = true)
    {
        var builder = new PageBuilder(1, [.. columns.Select(_ => WireKind.Text)]);
        for (var row = 0; row < rows; row++)
        {
            builder.BeginRow();
            for (var c = 0; c < columns.Count; c++)
            {
                if (holes && row > 2 && (row + c) % 7 == 0) builder.AppendNull();
                else if (holes && row > 2 && (row + c) % 11 == 0) builder.AppendNull(error: true);
                else columns[c](builder, row);
            }
            builder.CommitRow();
        }
        return builder.Seal();
    }

    /// <summary>Whether the page packs and unpacks to its bytes, alone and into a room of its length.</summary>
    private static bool RoundTrips(byte[] page)
    {
        try
        {
            var packed = PageCodec.Pack(page);
            if (packed is null || !PageCodec.Unpack(packed, page.Length).AsSpan().SequenceEqual(page)) return false;
            var room = new byte[page.Length];
            PageCodec.UnpackInto(packed, room);
            return room.AsSpan().SequenceEqual(page);
        }
        catch (Exception) { return false; }
    }

    private static decimal Scaled(long magnitude, bool negative, byte scale) => new((int)magnitude, (int)(magnitude >> 32), 0, negative, scale);

    private static Cell Formatted(Func<int, Func<Span<byte>, int>> write) => (builder, row) => builder.EndFormatted(write(row)(builder.BeginFormatted()));
    private static Cell Text(Func<int, string> text) => (builder, row) => builder.AppendText(text(row));

    /// <summary>Columns written by CellFormat, as the column readers write them, with each type's extremes in the first rows:
    /// each is typed as its kind, and the page comes back.</summary>
    private static void Writers(Action<bool, string> check)
    {
        var random = new Random(7);
        long Next(long below) => random.NextInt64(below);
        // Each column's own values, the type's extremes first.
        DateTime Moment(int row) => row switch { 0 => DateTime.MinValue, 1 => DateTime.MaxValue, _ => new DateTime(Next(DateTime.MaxValue.Ticks)) };
        var columns = new List<(string Name, byte Kind, Cell Cell)>
        {
            ("int", PageCodec.Kind.Integer, Formatted(row => to => CellFormat.WriteInteger(to, row switch { 0 => int.MinValue, 1 => int.MaxValue, _ => (int)Next(1L << 32) - int.MaxValue }))),
            ("key", PageCodec.Kind.Integer, Formatted(row => to => CellFormat.WriteInteger(to, 1_000_000 + row))),
            ("bigint within 18 digits", PageCodec.Kind.Integer, Formatted(row => to => CellFormat.WriteInteger(to, row switch { 0 => -999_999_999_999_999_999, 1 => 999_999_999_999_999_999, _ => Next(2_000_000_000_000_000_000) - 1_000_000_000_000_000_000 }))),
            ("tinyint", PageCodec.Kind.Integer, Formatted(row => to => CellFormat.WriteInteger(to, (byte)(row * 37)))),
            ("decimal(18,4)", PageCodec.Kind.Decimal, Formatted(row => to => CellFormat.WriteDecimal(to, row == 1 ? 99_999_999_999_999.9999m : Scaled(Next(100_000_000_000_000), row % 3 == 0, 4)))),
            ("decimal(5,2)", PageCodec.Kind.Decimal, Formatted(row => to => CellFormat.WriteDecimal(to, Scaled(Next(100_000), false, 2)))),
            ("money", PageCodec.Kind.Decimal, Formatted(row => to => CellFormat.WriteMoney(to, Scaled(Next(10_000_000_000), row % 5 == 0, 4)))),
            ("date", PageCodec.Kind.Moment, Formatted(row => to => CellFormat.WriteDate(to, Moment(row).Date))),
            ("smalldatetime", PageCodec.Kind.Moment, Formatted(row => to => CellFormat.WriteSmallDateTime(to, new DateTime(1900, 1, 1).AddMinutes(Next(94_670_000))))),
            ("datetime", PageCodec.Kind.Moment, Formatted(row => to => CellFormat.WriteDateTime(to, new DateTime(1753, 1, 1).AddMilliseconds(Next(260_000_000_000_000) / 3 * 3)))),
            ("time(0)", PageCodec.Kind.Time, Formatted(row => to => CellFormat.WriteTime(to, new TimeSpan(Next(TimeSpan.TicksPerDay)), 0))),
            ("time(7)", PageCodec.Kind.Time, Formatted(row => to => CellFormat.WriteTime(to, new TimeSpan(row == 1 ? TimeSpan.TicksPerDay - 1 : Next(TimeSpan.TicksPerDay)), 7))),
            ("uniqueidentifier", PageCodec.Kind.Guid, Formatted(row => to => CellFormat.WriteGuid(to, new Guid([.. Enumerable.Range(0, 16).Select(_ => (byte)Next(256))])))),
        };
        for (var scale = 0; scale <= 7; scale++)
        {
            var s = scale;
            columns.Add(($"datetime2({s})", PageCodec.Kind.Moment, Formatted(row => to => CellFormat.WriteDateTime2(to, Moment(row), s))));
            // Offsets from -14:00 to +14:00 in quarter hours, on dates a day inside the range so every offset fits.
            columns.Add(($"datetimeoffset({s})", PageCodec.Kind.Moment, Formatted(row => to => CellFormat.WriteDateTimeOffset(to, row < 2
                ? new DateTimeOffset(Moment(row), TimeSpan.Zero)
                : new DateTimeOffset(new DateTime(TimeSpan.TicksPerDay + Next(DateTime.MaxValue.Ticks - 2 * TimeSpan.TicksPerDay)), TimeSpan.FromMinutes(15 * (Next(113) - 56))), s))));
        }
        // Text that is a number in a text column is typed too; nothing about the column's type is consulted.
        columns.Add(("varchar of numbers", PageCodec.Kind.Integer, Text(row => (row * 7919 % 100_003).ToString(Invariant))));
        var page = Page(1000, [.. columns.Select(column => column.Cell)]);
        var kinds = PageCodec.TypedKinds(page);
        var wrong = columns.Select((column, c) => (column, c)).Where(item => kinds[item.c] != item.column.Kind).Select(item => item.column.Name + " " + kinds[item.c]).ToList();
        check(wrong.Count == 0, "columns written by CellFormat are typed as their kind: " + string.Join(", ", wrong));
        var untyped = PageCodec.Pack(page, typed: false)!.Length;
        var typed = PageCodec.Pack(page)!.Length;
        check(RoundTrips(page) && typed < untyped * 0.9, $"a page of typed columns comes back byte for byte and packs smaller ({typed} against {untyped} bytes)");

        // Values that are not always typed: real and float are typed while they read as decimals, never with an exponent,
        // and bigint's 19-digit values keep their text; either way the page comes back.
        Cell[] others =
        [
            Formatted(row => to => CellFormat.WriteReal(to, row switch { 0 => float.MaxValue, 1 => float.Epsilon, _ => (float)(random.NextDouble() * 2000 - 1000) })),
            Formatted(row => to => CellFormat.WriteFloat(to, row switch { 0 => double.MaxValue, 1 => -0.0, _ => random.NextDouble() * 1000 })),
            Formatted(row => to => CellFormat.WriteFloat(to, Math.Round(random.NextDouble() * 1000, 2))),
            Formatted(row => to => CellFormat.WriteInteger(to, row switch { 0 => long.MinValue, 1 => long.MaxValue, _ => random.NextInt64() })),
            Formatted(row => to => CellFormat.WriteSqlDecimal(to, SqlDecimal.Parse(row == 0 ? "-99999999999999999999999999999999999999" : Next(1_000_000).ToString(Invariant) + "." + Next(1_000_000).ToString("D6", Invariant)))),
            Formatted(row => to => CellFormat.WriteBit(to, row % 3 == 0)),
        ];
        var mixed = Page(1000, others);
        var otherKinds = PageCodec.TypedKinds(mixed);
        check(RoundTrips(mixed) && otherKinds is [PageCodec.Kind.None, PageCodec.Kind.None, PageCodec.Kind.Decimal, PageCodec.Kind.None, PageCodec.Kind.None, PageCodec.Kind.None],
            "real and float with an exponent, 19-digit bigints, 38-digit decimals and bits keep their text, rounded floats are typed, and the page comes back: " + string.Join(",", otherKinds));
    }

    /// <summary>Text one character away from what its value writes back keeps its lengths and text; the same column without
    /// that cell is typed, so each case shows the rule that refuses it.</summary>
    private static void NearMisses(Action<bool, string> check)
    {
        string Guid(int row, bool lower)
        {
            var text = new Guid(row, (short)row, (short)(row * 3), [1, 2, 3, 4, 5, 6, 7, (byte)row]).ToString("D");
            return lower ? text : text.ToUpperInvariant();
        }
        (string Name, byte Kind, Func<int, string> Good, string Bad)[] cases =
        [
            ("leading zero", PageCodec.Kind.Integer, row => (row * 13).ToString(Invariant), "007"),
            ("negative zero", PageCodec.Kind.Integer, row => (row * 13 - 300).ToString(Invariant), "-0"),
            ("plus sign", PageCodec.Kind.Integer, row => (row * 13).ToString(Invariant), "+5"),
            ("space", PageCodec.Kind.Integer, row => (row * 13).ToString(Invariant), " 5"),
            ("empty", PageCodec.Kind.Integer, row => (row * 13).ToString(Invariant), ""),
            ("Arabic-Indic digits", PageCodec.Kind.Integer, row => (row * 13).ToString(Invariant), "١٢٣"),
            ("19 digits", PageCodec.Kind.Integer, row => (row * 13).ToString(Invariant), "1234567890123456789"),
            ("point without digits", PageCodec.Kind.Decimal, row => (row * 13 / 10.0).ToString("0.0", Invariant), "5."),
            ("no whole digits", PageCodec.Kind.Decimal, row => (row * 13 / 10.0).ToString("0.0", Invariant), ".5"),
            ("trailing zero past the fewest digits", PageCodec.Kind.Decimal, row => row % 2 == 0 ? (row / 4.0 + 1).ToString("0.0#", Invariant) : (row + 0.25).ToString("0.00", Invariant), "1.50"),
            ("negative zero decimal", PageCodec.Kind.Decimal, row => (row * 1.25m).ToString("0.00##", Invariant), "-0.00"),
            ("leading zero decimal", PageCodec.Kind.Decimal, row => (row * 1.25m).ToString("0.00", Invariant), "01.25"),
            ("exponent", PageCodec.Kind.Decimal, row => (row * 1.25m).ToString("0.00", Invariant), "1E+20"),
            ("decimal past 18 digits", PageCodec.Kind.Decimal, row => (row * 1.25m).ToString("0.00", Invariant), "12345678901234567.75"),
            ("lowercase GUID among uppercase", PageCodec.Kind.Guid, row => Guid(row, false), "ABCDEF01-0000-0000-0000-00000000000a"),
            ("uppercase GUID among lowercase", PageCodec.Kind.Guid, row => Guid(row, true), "abcdef01-0000-0000-0000-00000000000A"),
            ("GUID of another case later", PageCodec.Kind.Guid, row => Guid(row, true), "ABCDEF01-0000-0000-0000-000000000000"),
            ("GUID in braces", PageCodec.Kind.Guid, row => Guid(row, false), "{" + Guid(99, false) + "}"),
            ("GUID with a letter past F", PageCodec.Kind.Guid, row => Guid(row, false), "G" + Guid(99, false)[1..]),
            ("GUID with a digit where a dash goes", PageCodec.Kind.Guid, row => Guid(row, false), Guid(99, false)[..23] + "0" + Guid(99, false)[24..]),
            ("29 February outside a leap year", PageCodec.Kind.Moment, row => new DateOnly(2024, 1, 1).AddDays(row).ToString("yyyy-MM-dd", Invariant), "2023-02-29"),
            ("month 13", PageCodec.Kind.Moment, row => new DateOnly(2024, 1, 1).AddDays(row).ToString("yyyy-MM-dd", Invariant), "2024-13-01"),
            ("year 0", PageCodec.Kind.Moment, row => new DateOnly(2024, 1, 1).AddDays(row).ToString("yyyy-MM-dd", Invariant), "0000-01-01"),
            ("a time in a date column", PageCodec.Kind.Moment, row => new DateOnly(2024, 1, 1).AddDays(row).ToString("yyyy-MM-dd", Invariant), "2024-01-05 10:00:00"),
            ("one-digit month", PageCodec.Kind.Moment, row => new DateOnly(2024, 1, 1).AddDays(row).ToString("yyyy-MM-dd", Invariant), "2024-1-01"),
            ("fewer fraction digits", PageCodec.Kind.Moment, row => new DateTime(2024, 1, 1).AddMilliseconds(row * 1013).ToString("yyyy-MM-dd HH:mm:ss.fff", Invariant), "2024-01-01 10:00:00.12"),
            ("hour 24", PageCodec.Kind.Moment, row => new DateTime(2024, 1, 1).AddSeconds(row * 1013).ToString("yyyy-MM-dd HH:mm:ss", Invariant), "2024-01-01 24:00:00"),
            ("minute 60", PageCodec.Kind.Moment, row => new DateTime(2024, 1, 1).AddSeconds(row * 1013).ToString("yyyy-MM-dd HH:mm:ss", Invariant), "2024-01-01 10:60:00"),
            ("second 60", PageCodec.Kind.Moment, row => new DateTime(2024, 1, 1).AddSeconds(row * 1013).ToString("yyyy-MM-dd HH:mm:ss", Invariant), "2024-01-01 10:00:60"),
            ("offset -00:00", PageCodec.Kind.Moment, row => new DateTimeOffset(2024, 1, 1, 0, 0, 0, TimeSpan.FromHours(row % 25 - 12)).AddSeconds(row).ToString("yyyy-MM-dd HH:mm:ss zzz", Invariant), "2024-01-01 10:00:00 -00:00"),
            ("offset +15:00", PageCodec.Kind.Moment, row => new DateTimeOffset(2024, 1, 1, 0, 0, 0, TimeSpan.FromHours(row % 25 - 12)).AddSeconds(row).ToString("yyyy-MM-dd HH:mm:ss zzz", Invariant), "2024-01-01 10:00:00 +15:00"),
            ("offset minute 60", PageCodec.Kind.Moment, row => new DateTimeOffset(2024, 1, 1, 0, 0, 0, TimeSpan.FromHours(row % 25 - 12)).AddSeconds(row).ToString("yyyy-MM-dd HH:mm:ss zzz", Invariant), "2024-01-01 10:00:00 +05:60"),
            ("time hour 24", PageCodec.Kind.Time, row => TimeSpan.FromSeconds(row * 97).ToString(@"hh\:mm\:ss", Invariant), "24:00:00"),
            ("time one-digit hour", PageCodec.Kind.Time, row => TimeSpan.FromSeconds(row * 97).ToString(@"hh\:mm\:ss", Invariant), "1:00:00"),
            ("time fraction digits", PageCodec.Kind.Time, row => TimeSpan.FromMilliseconds(row * 97).ToString(@"hh\:mm\:ss\.fff", Invariant), "00:00:01.5"),
        ];
        var failures = new List<string>();
        foreach (var (name, kind, good, bad) in cases)
        {
            var clean = Page(60, [Text(good)], holes: false);
            var spoiled = Page(60, [Text(row => row == 30 ? bad : good(row))], holes: false);
            try
            {
                if (PageCodec.TypedKinds(clean) is not [var typed] || typed != kind || !RoundTrips(clean)) failures.Add(name + ": the clean column is not typed as expected");
                if (PageCodec.TypedKinds(spoiled) is not [PageCodec.Kind.None] || !RoundTrips(spoiled)) failures.Add(name + ": typed or not back");
            }
            catch (Exception error) { failures.Add(name + ": " + error.GetType().Name); }
        }
        check(failures.Count == 0, $"text that is not what its value writes back keeps its lengths and text ({cases.Length} cases): " + string.Join("; ", failures));
    }

    /// <summary>Typed columns anywhere in a page, among binary, truncated, empty and NULL columns, at row counts that end
    /// bitmaps mid-byte and at both page limits; a column whose only value is one cell; truncated text that reads as a value.</summary>
    private static void Layouts(Action<bool, string> check)
    {
        var failures = new List<string>();
        foreach (var rows in new[] { 1, 2, 7, 64, 1000, PageBuilder.MaxRows })
            foreach (var shape in new[] { "first", "only", "last", "all", "mixed" })
            {
                var wires = shape switch
                {
                    "only" or "all" => new[] { WireKind.Text, WireKind.Text },
                    _ => [WireKind.Text, WireKind.Binary, WireKind.Text, WireKind.Text, WireKind.Text],
                };
                var builder = new PageBuilder(1, wires);
                for (var row = 0; row < rows; row++)
                {
                    builder.BeginRow();
                    for (var c = 0; c < wires.Length; c++)
                    {
                        var typed = shape switch { "first" => c == 0, "last" => c == wires.Length - 1, "only" => c == 0, "all" => true, _ => c != 1 && c != 3 };
                        if (wires[c] == WireKind.Binary) builder.AppendBinary(BitConverter.GetBytes((long)row * 2654435761)[..(1 + row % 8)]);
                        else if (!typed) { if (row % 3 == 0) builder.AppendNull(); else builder.AppendText("note " + row * 7919 % 1000 + new string('x', row % 30)); }
                        else if (c == 4 && shape == "mixed") { if (row == rows / 2) builder.AppendText("2026-11-19 10:00:00"); else builder.AppendNull(); }
                        else if (c == 2 && shape == "mixed") builder.AppendText((row * 37 - 500).ToString(Invariant), truncated: row % 13 == 0);
                        else if (row % 5 == 4) builder.AppendNull(error: row % 10 == 9);
                        else builder.AppendText((1000 + row * 3).ToString(Invariant));
                    }
                    builder.CommitRow();
                }
                var page = builder.Seal();
                // A page with a typed column is packed typed (its marker says so), and comes back.
                if (!RoundTrips(page)) failures.Add($"{shape} at {rows} rows did not come back");
                else if ((PageCodec.Pack(page)![0] == 2) != PageCodec.TypedKinds(page).Any(kind => kind != 0)) failures.Add($"{shape} at {rows} rows: marker and kinds disagree");
                else if (rows >= 7 && PageCodec.TypedKinds(page)[0] != PageCodec.Kind.Integer && shape != "last") failures.Add($"{shape} at {rows} rows: first column not typed");
            }
        check(failures.Count == 0, "typed columns anywhere in a page, among other columns and at every row count, come back byte for byte: " + string.Join("; ", failures));
        var single = Page(64, [Text(row => row == 40 ? "123" : ""), Text(row => (row * 11).ToString(Invariant))], holes: false);
        check(PageCodec.TypedKinds(single) is [PageCodec.Kind.None, PageCodec.Kind.Integer] && RoundTrips(single), "a column of empty strings keeps its text beside a typed column");
    }

    /// <summary>A typed page changed anywhere (its values, its form, its prefix) unpacks to some bytes or fails as
    /// unreadable, never with another error.</summary>
    private static void Damaged(Action<bool, string> check)
    {
        var random = new Random(9);
        var page = Page(700, [
            Text(row => (row * 7).ToString(Invariant)), Text(row => (row * 1.25m - 300).ToString("0.00##", Invariant)),
            Text(row => new DateTimeOffset(2024, 1, 1, 0, 0, 0, TimeSpan.FromMinutes(row % 57 * 15 - 420)).AddSeconds(row * 977.25).ToString("yyyy-MM-dd HH:mm:ss.fff zzz", Invariant)),
            Text(row => TimeSpan.FromMilliseconds(row * 9977).ToString(@"hh\:mm\:ss\.fff", Invariant)),
            Text(row => new Guid(row, 1, 2, [1, 2, 3, 4, 5, 6, 7, 8]).ToString("D").ToUpperInvariant()),
            Text(row => "word " + row % 17)]);
        var packed = PageCodec.Pack(page)!;
        var at = 1;
        uint Leb() { uint value = 0; for (var shift = 0; ; shift += 7) { var b = packed[at++]; value |= (uint)(b & 0x7F) << shift; if (b < 0x80) return value; } }
        var (formLength, valuesLength, valuesFrame) = (Leb(), Leb(), Leb());
        var values = new byte[valuesLength];
        var form = new byte[formLength];
        ZstandardDecoder.TryDecompress(packed.AsSpan(at, (int)valuesFrame), values, out _);
        ZstandardDecoder.TryDecompress(packed.AsSpan(at + (int)valuesFrame), form, out _);
        byte[] Frame(byte[] source)
        {
            var frame = new byte[ZstandardEncoder.GetMaxCompressedLength(Math.Max(1, source.Length))];
            ZstandardEncoder.TryCompress(source, frame, out var length, PageCodec.Quality, PageCodec.Window);
            return frame[..length];
        }
        byte[] Packed(byte[] newForm, byte[] newValues, uint? claimedValues = null)
        {
            var valuesBytes = Frame(newValues);
            var prefix = new List<byte> { 2 };
            foreach (var value in new[] { (uint)newForm.Length, claimedValues ?? (uint)newValues.Length, (uint)valuesBytes.Length })
                for (var v = value; ; v >>= 7) { if (v < 0x80) { prefix.Add((byte)v); break; } prefix.Add((byte)(v | 0x80)); }
            return [.. prefix, .. valuesBytes, .. Frame(newForm)];
        }
        var sane = Packed(form, values);
        var unexpected = new List<string>();
        var unreadable = 0;
        void Try(byte[] bytes)
        {
            try { PageCodec.Unpack(bytes, page.Length); }
            catch (InvalidDataException) { unreadable++; }
            catch (Exception error) { unexpected.Add(error.GetType().Name + " " + error.Message); }
        }
        Try(sane);
        var saneWorks = unreadable == 0 && unexpected.Count == 0 && PageCodec.Unpack(sane, page.Length).AsSpan().SequenceEqual(page);
        for (var trial = 0; trial < 3000; trial++)
        {
            var changedValues = values.ToArray();
            var changedForm = form.ToArray();
            if (trial % 2 == 0) changedValues[random.Next(changedValues.Length)] ^= (byte)(1 + random.Next(255));
            else changedForm[random.Next(trial % 4 == 1 ? changedForm.Length : Math.Min(changedForm.Length, 4096))] ^= (byte)(1 + random.Next(255));
            Try(Packed(changedForm, changedValues));
        }
        var beforeFrames = unreadable;
        foreach (var cut in new[] { 1, 2, 3, 16, values.Length / 2 }) Try(Packed(form, values[..^cut]));
        // A values frame with a byte left over after the last typed column is refused, not read past.
        Try(Packed(form, [.. values, 0]));
        Try(Packed(form, values, 0));
        Try(Packed(form, values, (uint)page.Length + 1));
        Try(packed[..(at + 2)]);
        check(unreadable - beforeFrames == 9, $"a cut, longer or misdeclared values frame is unreadable ({unreadable - beforeFrames} of 9)");
        check(saneWorks && unexpected.Count == 0 && unreadable > 300,
            $"a changed typed page unpacks or fails as unreadable ({unreadable} unreadable; other outcomes: {string.Join(", ", unexpected.Distinct().Take(4))})");
    }

    /// <summary>A date and time column whose first value is changed to a moment just before 0001-01-01 (day 0 with a
    /// negative time once divided) is unreadable, whatever its fraction digits.</summary>
    private static void BeforeDayOne(Action<bool, string> check)
    {
        var start = new DateTime(2024, 1, 1);
        var outcomes = new List<string>();
        foreach (var (format, step, first) in new[] { ("yyyy-MM-dd HH:mm:ss", 1.0, new byte[] { 0x01 }), ("yyyy-MM-dd HH:mm:ss.fff", 1.001, [0xCF, 0x0F]) })
        {
            var page = Page(200, [Text(row => start.AddSeconds(row * step).ToString(format, Invariant))], holes: false);
            var packed = PageCodec.Pack(page)!;
            if (packed[0] != 2) { outcomes.Add(format + ": not packed typed"); continue; }
            var at = 1;
            uint Leb() { uint value = 0; for (var shift = 0; ; shift += 7) { var b = packed[at++]; value |= (uint)(b & 0x7F) << shift; if (b < 0x80) return value; } }
            var (formLength, valuesLength, valuesFrame) = (Leb(), Leb(), Leb());
            var values = new byte[valuesLength];
            var form = new byte[formLength];
            ZstandardDecoder.TryDecompress(packed.AsSpan(at, (int)valuesFrame), values, out _);
            ZstandardDecoder.TryDecompress(packed.AsSpan(at + (int)valuesFrame), form, out _);
            // Delta-coded from 0: the first value's bytes become the zigzag of a small negative moment.
            first.CopyTo(values, 0);
            var head = new List<byte> { 2 };
            byte[] Frame(byte[] source)
            {
                var frame = new byte[ZstandardEncoder.GetMaxCompressedLength(Math.Max(1, source.Length))];
                ZstandardEncoder.TryCompress(source, frame, out var length, PageCodec.Quality, PageCodec.Window);
                return frame[..length];
            }
            var valuesBytes = Frame(values);
            foreach (var value in new[] { formLength, valuesLength, (uint)valuesBytes.Length })
                for (var v = value; ; v >>= 7) { if (v < 0x80) { head.Add((byte)v); break; } head.Add((byte)(v | 0x80)); }
            try { PageCodec.Unpack([.. head, .. valuesBytes, .. Frame(form)], page.Length); outcomes.Add(format + ": read"); }
            catch (InvalidDataException) { }
            catch (Exception error) { outcomes.Add(format + ": " + error.GetType().Name); }
            if (PageCodec.TypedKinds(page) is not [PageCodec.Kind.Moment]) outcomes.Add(format + ": not typed");
        }
        check(outcomes.Count == 0, "a moment before 0001-01-01 in a typed column is unreadable (" + string.Join(", ", outcomes) + ")");
    }

    /// <summary>A store packs a result's pages typed: they read back as sealed, charge their packed length, and pack smaller
    /// than the same result packed without typing.</summary>
    private static void Stored(Action<bool, string> check)
    {
        ResultColumn[] columns = [new("id", "int", "text"), new("at", "datetime2", "text", Scale: 7), new("amount", "decimal", "text", Precision: 18, Scale: 2), new("note", "nvarchar", "text")];
        ResultSetBuffer Fill(ResultStore store)
        {
            var set = store.Open(store.BeginQuery("typed"), 0, 1, 1, "rows", columns, [WireKind.Text, WireKind.Text, WireKind.Text, WireKind.Text])!;
            for (var row = 0; row < 20_000; row++)
            {
                set.CountRow();
                var builder = set.BeginRow()!;
                builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), row));
                builder.EndFormatted(CellFormat.WriteDateTime2(builder.BeginFormatted(), new DateTime(2026, 1, 1).AddTicks(row * 12_345_678L), 7));
                builder.EndFormatted(CellFormat.WriteDecimal(builder.BeginFormatted(), Scaled(row * 7919 % 1_000_000, false, 2)));
                builder.AppendText("note " + row % 97);
                set.TryCommitRow();
            }
            set.Complete();
            return set;
        }
        var plain = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.Off };
        var typedStore = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.EveryComplete };
        var untypedStore = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.EveryComplete, TypedPacking = false };
        var (raw, typed, untyped) = (Fill(plain), Fill(typedStore), Fill(untypedStore));
        byte[][] Bodies(ResultSetBuffer set)
        {
            using var pin = set.Pin();
            return [.. set.SealedSnapshot().Select(page => page.Body())];
        }
        var same = Bodies(raw).Zip(Bodies(typed)).All(pair => pair.First.AsSpan().SequenceEqual(pair.Second));
        var typedPages = typed.SealedSnapshot();
        var typedBytes = typedPages.Sum(page => (long)page.PackedLength!.Value);
        var untypedBytes = untyped.SealedSnapshot().Sum(page => (long)page.PackedLength!.Value);
        var charged = typedPages.All(page => page.StoredLength == page.PackedLength!.Value + (page.Filter?.Bytes ?? 0));
        check(same && charged && typedPages.Length > 2 && typedBytes < untypedBytes * 0.8,
            $"a store's typed pages read back as sealed, charge their packed length and pack smaller ({typedBytes} against {untypedBytes} bytes)");
        plain.Release(raw.ResultId);
        typedStore.Release(typed.ResultId);
        untypedStore.Release(untyped.ResultId);
    }
}
