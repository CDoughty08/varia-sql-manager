using System.Data.SqlTypes;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of SSMS display formats, the page builder, and the golden pages that vitest decodes.</summary>
internal static class PageChecks
{
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;

    public static void Run(Action<bool, string> check)
    {
        DisplayFormats(check);
        GoldenPages(check);
        Builder(check);
        Throughput();
    }

    private static void DisplayFormats(Action<bool, string> check)
    {
        using var fixture = JsonDocument.Parse(File.ReadAllText(Fixtures.Path("tests/fixtures/sql-display.json")));
        var failures = new List<string>();
        var count = 0;
        foreach (var item in fixture.RootElement.GetProperty("cases").EnumerateArray())
        {
            var type = item.GetProperty("type").GetString()!;
            var expected = item.GetProperty("display").GetString()!;
            string actual;
            try { actual = Display(type, item.GetProperty("value"), item.TryGetProperty("wire", out var wire) && wire.GetString() == "binary"); }
            catch (Exception error) { actual = error.GetType().Name; }
            if (actual != expected) failures.Add(type + " " + item.GetProperty("value") + " gave '" + actual + "'");
            count++;
        }
        check(count >= 50 && failures.Count == 0, "CellFormat writes the SSMS display text of every sql-display.json case" + (failures.Count == 0 ? "" : ": " + string.Join("; ", failures)));
    }

    private static string Display(string type, JsonElement value, bool binary)
    {
        if (binary) return "0x" + value.GetString();
        var name = type.Split('(')[0];
        var arguments = type.Contains('(') ? type[(type.IndexOf('(') + 1)..type.IndexOf(')')].Split(',').Select(part => int.TryParse(part, out var number) ? number : -1).ToArray() : [];
        var text = value.ValueKind == JsonValueKind.String ? value.GetString()! : "";
        Span<byte> buffer = stackalloc byte[CellFormat.MaxFixedBytes];
        var written = name switch
        {
            "bit" => CellFormat.WriteBit(buffer, value.GetBoolean()),
            "tinyint" or "smallint" or "int" or "bigint" => CellFormat.WriteInteger(buffer, long.Parse(text, Invariant)),
            "decimal" or "numeric" when arguments[0] <= 28 => CellFormat.WriteDecimal(buffer, decimal.Parse(text, NumberStyles.Number, Invariant)),
            "decimal" or "numeric" => CellFormat.WriteSqlDecimal(buffer, SqlDecimal.Parse(text)),
            "money" or "smallmoney" => CellFormat.WriteMoney(buffer, decimal.Parse(text, NumberStyles.Number, Invariant)),
            "real" => CellFormat.WriteReal(buffer, float.Parse(text, NumberStyles.Float, Invariant)),
            "float" => CellFormat.WriteFloat(buffer, double.Parse(text, NumberStyles.Float, Invariant)),
            "date" => CellFormat.WriteDate(buffer, DateTime.Parse(text, Invariant, DateTimeStyles.RoundtripKind)),
            "time" => CellFormat.WriteTime(buffer, TimeSpan.Parse(text, Invariant), arguments[0]),
            "smalldatetime" => CellFormat.WriteSmallDateTime(buffer, DateTime.Parse(text, Invariant, DateTimeStyles.RoundtripKind)),
            "datetime" => CellFormat.WriteDateTime(buffer, DateTime.Parse(text, Invariant, DateTimeStyles.RoundtripKind)),
            "datetime2" => CellFormat.WriteDateTime2(buffer, DateTime.Parse(text, Invariant, DateTimeStyles.RoundtripKind), arguments[0]),
            "datetimeoffset" => CellFormat.WriteDateTimeOffset(buffer, DateTimeOffset.Parse(text, Invariant), arguments[0]),
            "uniqueidentifier" => CellFormat.WriteGuid(buffer, Guid.Parse(text)),
            "vector" => -1,
            _ => -2
        };
        return written switch
        {
            -1 => CellFormat.Vector([.. value.EnumerateArray().Select(item => item.GetSingle())], 65_535, out _),
            -2 => text,
            _ => Encoding.UTF8.GetString(buffer[..written])
        };
    }

    private static readonly (string Name, string Shape, uint ResultId, long FirstRow, int Rows)[] Golden =
    [
        ("w1", "W1", 1, 0, 10),
        ("n1", "N1", 7, 4096, 37),
        // A resultId above 2^16 and a firstRow above 2^32 exercise the wider integer forms in the header.
        ("b1", "B1", 70_000, 4_294_967_297, 2)
    ];

    private static (byte[] Page, string Json) GoldenCase(string name)
    {
        if (name == "wide")
        {
            // 20 columns take the array16 form for the column chunks.
            var columns = Enumerable.Range(0, 20).Select(i => new SyntheticRows.Column("c" + i, i % 5 == 4 ? "varbinary(8)" : "nvarchar(10)", i % 5 == 4 ? WireKind.Binary : WireKind.Text)).ToList();
            var builder = new PageBuilder(300, [.. columns.Select(column => column.Wire)]);
            for (var row = 0; row < 3; row++)
            {
                builder.BeginRow();
                for (var c = 0; c < columns.Count; c++)
                    if (columns[c].Wire == WireKind.Binary) builder.AppendBinary([(byte)row, (byte)c]);
                    else if ((row + c) % 7 == 0) builder.AppendNull();
                    else builder.AppendText("r" + row + "c" + c);
                builder.CommitRow();
            }
            var page = builder.Seal();
            return (page, Describe(page, columns));
        }
        var (_, shape, resultId, firstRow, rows) = Golden.Single(item => item.Name == name);
        var pages = SyntheticRows.Pages(shape, resultId, firstRow, rows).ToList();
        if (pages.Count != 1) throw new InvalidOperationException("A golden case must fit one page.");
        return (pages[0], Describe(pages[0], SyntheticRows.Columns(shape)));
    }

    /// <summary>The page as decoded by the test reader: one JSON row per line, cells as [text or null, flags].</summary>
    private static string Describe(byte[] page, IReadOnlyList<SyntheticRows.Column> columns)
    {
        var json = new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
        var decoded = PageReader.Read(page, [.. columns.Select(column => column.Wire)]);
        var header = JsonSerializer.Serialize(new
        {
            resultId = decoded.ResultId,
            firstRow = decoded.FirstRow,
            columns = columns.Select(column => new { name = column.Name, dataType = column.DataType, wire = column.Wire == WireKind.Text ? "text" : "binary" })
        }, json);
        var rows = decoded.Rows.Select(row => "    " + JsonSerializer.Serialize(row.Select(cell => new object?[] { cell.Text, cell.Flags }), json));
        return header[..^1] + ",\n  \"rows\": [\n" + string.Join(",\n", rows) + "\n  ]\n}\n";
    }

    private static void GoldenPages(Action<bool, string> check)
    {
        var bytes = new List<string>();
        var text = new List<string>();
        foreach (var name in Golden.Select(item => item.Name).Append("wide"))
        {
            var (page, json) = GoldenCase(name);
            var pagePath = Fixtures.Path("tests/fixtures/pages/" + name + ".page");
            var jsonPath = Path.ChangeExtension(pagePath, ".json");
            if (Fixtures.Update)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(pagePath)!);
                File.WriteAllBytes(pagePath, page);
                File.WriteAllText(jsonPath, json);
            }
            if (!File.Exists(pagePath) || !File.ReadAllBytes(pagePath).AsSpan().SequenceEqual(page)) bytes.Add(name);
            if (!File.Exists(jsonPath) || File.ReadAllText(jsonPath).ReplaceLineEndings("\n") != json) text.Add(name);
        }
        const string hint = " (if the format changed on purpose, rerun with VARIA_UPDATE_GOLDEN=1 and review the diff)";
        check(bytes.Count == 0, "PageBuilder reproduces the golden pages byte for byte" + (bytes.Count == 0 ? "" : ": " + string.Join(", ", bytes) + hint));
        check(text.Count == 0, "the golden pages decode to their committed display JSON" + (text.Count == 0 ? "" : ": " + string.Join(", ", text) + hint));

        var w1 = PageReader.Read(SyntheticRows.Pages("W1", 1, 0, 8).Single(), [.. SyntheticRows.Columns("W1").Select(column => column.Wire)]).Rows;
        var n1 = PageReader.Read(SyntheticRows.Pages("N1", 1, 0, 8).Single(), [.. SyntheticRows.Columns("N1").Select(column => column.Wire)]).Rows;
        check(w1[0][0].Text == "0" && w1[0][1].Text == "Customer 0000000000 GmbH" && w1[3][1].Text == "Société 0000000003 SARL" && w1[0][2].Text == "2026-01-01 00:00:00.0000000"
            && w1[1][2].Text == "2026-01-01 00:00:01.1234567" && w1[5][3].Text == "-395.95" && w1[1][4].Text == "00000001-0000-4A1F-9C2E-00C04FC90001"
            && w1[0][5].Text!.Length == 80 && w1[0][6].Text == "1" && w1[1][6].Text == "0" && w1[4][7] == new PageCell(null, PageReader.Null),
            "W1 synthetic rows carry the SSMS display text of their types");
        check(n1[4][2].Text == "a�b" && n1[5][2].Text == "�z" && n1[6][2].Text == "﻿bom" && n1[3][2].Text == "😀 astral" && n1[0][2].Text == ""
            && n1[1][1] == new PageCell(null, PageReader.Null) && n1[1][3] == new PageCell("truncated pre", PageReader.Truncated)
            && n1[2][4] == new PageCell(null, PageReader.Null | PageReader.Error) && n1[3][4] == new PageCell(null, PageReader.Null)
            && n1[0][5] == new PageCell("0x", 0) && n1[2][5] == new PageCell("0x02FF00", 0) && n1[3][5] == new PageCell("0x000102030405060708090A0B0C0D0E0F", PageReader.Truncated)
            && n1.All(row => row[6] == new PageCell(null, PageReader.Null)),
            "N1 pages keep NULLs, read errors, truncation flags, empty values, and replace lone surrogates with U+FFFD");
    }

    private static bool Throws(Action action)
    {
        try { action(); }
        catch (InvalidOperationException) { return true; }
        return false;
    }

    private static void Builder(Action<bool, string> check)
    {
        var narrow = new PageBuilder(1, [WireKind.Text]);
        var fullBefore = false;
        for (var row = 0; row < PageBuilder.MaxRows; row++)
        {
            fullBefore |= narrow.IsFull;
            narrow.BeginRow();
            narrow.AppendText("1");
            narrow.CommitRow();
        }
        check(!fullBefore && narrow.IsFull && narrow.RowCount == 4096 && Throws(narrow.BeginRow) && PageReader.Read(narrow.Seal(), [WireKind.Text]).Rows.Length == 4096 && narrow.FirstRow == 4096 && !narrow.HasRows,
            "a page seals at 4,096 rows and the builder continues at the next row");
        var wide = SyntheticRows.Builder("W1", 1);
        var row1 = 0L;
        for (; !wide.IsFull; row1++) SyntheticRows.Write("W1", row1, wide);
        var pages = SyntheticRows.Pages("W1", 2, 100, 10_000).ToList();
        var decoded = pages.Select(page => PageReader.Read(page, [.. SyntheticRows.Columns("W1").Select(column => column.Wire)])).ToList();
        check(wide.ByteCount >= PageBuilder.SealBytes && row1 < PageBuilder.MaxRows && pages.All(page => page.Length < PageBuilder.SealBytes + 64 * 1024)
            && decoded.Sum(page => page.Rows.Length) == 10_000 && decoded.Select((page, i) => page.FirstRow == 100 + decoded.Take(i).Sum(earlier => earlier.Rows.Length)).All(ok => ok),
            "a page seals at 256 KiB, and consecutive pages cover the rows without gaps (" + row1 + " W1 rows per page)");

        var reference = SyntheticRows.Builder("N1", 9);
        var aborted = SyntheticRows.Builder("N1", 9);
        for (var row = 0; row < 3; row++) { SyntheticRows.Write("N1", row, reference); SyntheticRows.Write("N1", row, aborted); }
        aborted.BeginRow();
        aborted.AppendText("123");
        aborted.AppendNull();
        aborted.AppendText("x", truncated: true);
        aborted.AppendText("y", truncated: true);
        aborted.AppendNull(error: true);
        aborted.AbortRow();
        var sameAfterAbort = aborted.Seal().AsSpan().SequenceEqual(reference.Seal());
        for (var row = 3; row < 6; row++) { SyntheticRows.Write("N1", row, reference); SyntheticRows.Write("N1", row, aborted); }
        aborted.BeginRow();
        aborted.AppendNull();
        aborted.AbortRow();
        check(sameAfterAbort && aborted.Seal().AsSpan().SequenceEqual(reference.Seal()), "AbortRow leaves no cell, flag, or bitmap of the discarded row in the page");

        var capped = new PageBuilder(1, [WireKind.Text, WireKind.Text, WireKind.Text, WireKind.Binary, WireKind.Text]);
        capped.BeginRow();
        capped.AppendText(new string('a', 3 * 1024 * 1024));
        capped.AppendUtf8(Encoding.UTF8.GetBytes(new string('é', 1024 * 1024)));
        capped.AppendText(new string('€', 1024 * 1024));
        capped.AppendBinary(new byte[16]);
        capped.AppendUtf8("€"u8);
        capped.CommitRow();
        var cells = PageReader.Read(capped.Seal(), [WireKind.Text, WireKind.Text, WireKind.Text, WireKind.Binary, WireKind.Text]).Rows[0];
        // 3 MiB + 2 MiB leave 3 MiB: 1,048,576 three-byte characters fit exactly, then nothing is left.
        var budget = 8 * 1024 * 1024 - 3 * 1024 * 1024 - 2 * 1024 * 1024;
        check(cells[0].Flags == 0 && cells[1].Flags == 0 && cells[2].Text!.Length == budget / 3 && cells[2].Flags == 0 && cells[3] == new PageCell("0x", PageReader.Truncated)
            && cells[4] == new PageCell("", PageReader.Truncated), "cells past the 8 MiB row budget become truncated prefixes at character boundaries");
        capped.BeginRow();
        capped.AppendText(new string('a', 8 * 1024 * 1024 - 1));
        capped.AppendText("€€");
        capped.AppendUtf8("é€"u8);
        capped.AppendBinary([1, 2]);
        capped.AppendText("z");
        capped.CommitRow();
        cells = PageReader.Read(capped.Seal(), [WireKind.Text, WireKind.Text, WireKind.Text, WireKind.Binary, WireKind.Text]).Rows[0];
        check(cells[1] == new PageCell("", PageReader.Truncated) && cells[2] == new PageCell("", PageReader.Truncated) && cells[3] == new PageCell("0x01", PageReader.Truncated) && cells[4] == new PageCell("", PageReader.Truncated),
            "a multi-byte character that does not fit the row budget is dropped whole, never split");

        var strict = new PageBuilder(1, [WireKind.Text, WireKind.Binary]);
        var outOfOrder = Throws(strict.CommitRow) && Throws(() => strict.AppendNull());
        strict.BeginRow();
        outOfOrder &= Throws(strict.BeginRow) && Throws(() => strict.AppendBinary([1])) && Throws(strict.CommitRow) && Throws(() => strict.Seal());
        strict.AppendText("a");
        outOfOrder &= Throws(() => strict.AppendText("b"));
        strict.AppendNull();
        outOfOrder &= Throws(() => strict.AppendNull());
        strict.CommitRow();
        check(outOfOrder && PageReader.Read(strict.Seal(), [WireKind.Text, WireKind.Binary]).Rows[0][1] == new PageCell(null, PageReader.Null)
            && Throws(() => new PageBuilder(1, [WireKind.Text]).Seal()),
            "the builder enforces one cell per column in order, matching wire kinds, and no empty or half-written pages");
    }

    private static void Throughput()
    {
        const int rows = 250_000;
        var watch = Stopwatch.StartNew();
        var bytes = SyntheticRows.Pages("W1", 1, 0, rows).Sum(page => (long)page.Length);
        watch.Stop();
        Console.WriteLine("PageBuilder W1 encoding (reported only): " + (rows / watch.Elapsed.TotalSeconds).ToString("N0", Invariant) + " rows/s, "
            + (bytes / watch.Elapsed.TotalSeconds / 1e6).ToString("N0", Invariant) + " MB/s, " + (bytes / (double)rows).ToString("N0", Invariant) + " bytes per row.");
    }
}
