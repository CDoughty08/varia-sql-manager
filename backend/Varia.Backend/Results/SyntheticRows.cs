using System.Globalization;

namespace Varia.Backend.Results;

/// <summary>Deterministic synthetic result sets for the test hooks, benchmarks and golden pages. Every cell is a pure
/// function of (shape, row), so any range can be regenerated.
/// W1: a typical wide row (about 220 encoded bytes). B1: two nvarchar(max) values of about 4 KB. N1: edge cases
/// (NULLs, read errors, truncated cells, empty values, astral characters, lone surrogates, a BOM, binary values).</summary>
internal static class SyntheticRows
{
    internal sealed record Column(string Name, string DataType, WireKind Wire);

    public static readonly IReadOnlyList<string> Shapes = ["W1", "B1", "N1"];

    private static readonly Column[] W1 =
    [
        new("id", "int", WireKind.Text), new("name", "nvarchar(50)", WireKind.Text), new("created", "datetime2(7)", WireKind.Text),
        new("amount", "decimal(18,2)", WireKind.Text), new("key", "uniqueidentifier", WireKind.Text), new("note", "nvarchar(200)", WireKind.Text),
        new("active", "bit", WireKind.Text), new("score", "int", WireKind.Text)
    ];
    private static readonly Column[] B1 = [new("first", "nvarchar(max)", WireKind.Text), new("second", "nvarchar(max)", WireKind.Text)];
    private static readonly Column[] N1 =
    [
        new("id", "int", WireKind.Text), new("maybe", "nvarchar(20)", WireKind.Text), new("unicode", "nvarchar(max)", WireKind.Text),
        new("clipped", "nvarchar(max)", WireKind.Text), new("failed", "int", WireKind.Text), new("bytes", "varbinary(16)", WireKind.Binary),
        new("none", "int", WireKind.Text)
    ];
    private static readonly string[] Unicode = ["", "é", "日本語", "😀 astral", "a\uD800b", "\uDC00z", "﻿bom", "tab\tline\nquote\"\\"];
    private const string Lorem = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ";
    private static readonly string Filler = string.Concat(Enumerable.Repeat(Lorem, 40))[..4096];
    private static readonly DateTime Epoch = new(2026, 1, 1, 0, 0, 0, DateTimeKind.Unspecified);

    public static IReadOnlyList<Column> Columns(string shape) => shape switch
    {
        "W1" => W1,
        "B1" => B1,
        "N1" => N1,
        _ => throw new ArgumentOutOfRangeException(nameof(shape))
    };

    public static PageBuilder Builder(string shape, uint resultId, long firstRow = 0) => new(resultId, [.. Columns(shape).Select(column => column.Wire)], firstRow);

    /// <summary>Pages for <paramref name="count"/> rows, sealed by the builder's size and row thresholds.</summary>
    public static IEnumerable<byte[]> Pages(string shape, uint resultId, long firstRow, long count)
    {
        var builder = Builder(shape, resultId, firstRow);
        for (var row = firstRow; row < firstRow + count; row++)
        {
            Write(shape, row, builder);
            if (builder.IsFull) yield return builder.Seal();
        }
        if (builder.HasRows) yield return builder.Seal();
    }

    /// <summary>Appends one committed row.</summary>
    public static void Write(string shape, long row, PageBuilder builder)
    {
        builder.BeginRow();
        WriteCells(shape, row, builder);
        builder.CommitRow();
    }

    /// <summary>Appends one row's cells to a row the caller began and will commit.</summary>
    public static void WriteCells(string shape, long row, PageBuilder builder)
    {
        switch (shape)
        {
            case "W1": WriteW1(row, builder); break;
            case "B1": WriteB1(row, builder); break;
            case "N1": WriteN1(row, builder); break;
            default: throw new ArgumentOutOfRangeException(nameof(shape));
        }
    }

    private static void Integer(PageBuilder builder, long value) => builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), value));

    private static void WriteW1(long row, PageBuilder builder)
    {
        Span<char> text = stackalloc char[200];
        Integer(builder, row);
        int length;
        if (row % 7 == 3) text.TryWrite(CultureInfo.InvariantCulture, $"Société {row:D10} SARL", out length);
        else text.TryWrite(CultureInfo.InvariantCulture, $"Customer {row:D10} GmbH", out length);
        builder.AppendText(text[..length]);
        builder.EndFormatted(CellFormat.WriteDateTime2(builder.BeginFormatted(), Epoch.AddTicks(row * 10_000_000 + row * 1_234_567 % 10_000_000), 7));
        builder.EndFormatted(CellFormat.WriteDecimal(builder.BeginFormatted(), new decimal((int)(row * 7919 % 100_000_000), 0, 0, row % 11 == 5, 2)));
        builder.EndFormatted(CellFormat.WriteGuid(builder.BeginFormatted(), new Guid((int)row, (short)(row >> 32), 0x4a1f, 0x9c, 0x2e, 0x00, 0xc0, 0x4f, 0xc9, (byte)(row >> 8), (byte)row)));
        text.TryWrite(CultureInfo.InvariantCulture, $"Note {row}: ", out length);
        Lorem.AsSpan(0, 80 - length).CopyTo(text[length..]);
        builder.AppendText(text[..80]);
        builder.EndFormatted(CellFormat.WriteBit(builder.BeginFormatted(), row % 3 == 0));
        if (row % 5 == 4) builder.AppendNull();
        else Integer(builder, row * 31 % 1000);
    }

    private static void WriteB1(long row, PageBuilder builder)
    {
        Span<char> text = stackalloc char[Filler.Length];
        Filler.CopyTo(text);
        row.TryFormat(text, out _, "D10", CultureInfo.InvariantCulture);
        builder.AppendText(text);
        row.TryFormat(text, out _, "X10", CultureInfo.InvariantCulture);
        builder.AppendText(text[..^7]);
    }

    private static void WriteN1(long row, PageBuilder builder)
    {
        Integer(builder, row);
        if (row % 3 == 1) builder.AppendNull();
        else builder.AppendText("n" + row.ToString(CultureInfo.InvariantCulture));
        builder.AppendText(Unicode[row % Unicode.Length]);
        if (row % 4 == 1) builder.AppendText("truncated pre", truncated: true);
        else builder.AppendText("complete " + row.ToString(CultureInfo.InvariantCulture));
        switch (row % 5)
        {
            case 2: builder.AppendNull(error: true); break;
            case 3: builder.AppendNull(); break;
            default: Integer(builder, row * 37 % 100); break;
        }
        switch (row % 4)
        {
            case 0: builder.AppendBinary([]); break;
            case 1: builder.AppendNull(); break;
            case 2: builder.AppendBinary([(byte)row, 0xff, 0x00]); break;
            default: builder.AppendBinary([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], truncated: true); break;
        }
        builder.AppendNull();
    }
}
