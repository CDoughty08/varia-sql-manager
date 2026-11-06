using System.Data;
using System.Text;
using System.Text.Json;
using Varia.Backend.Live;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the lengths recorded at ingest (docs/ipc.md, Cell lengths): each type's byte rule, the
/// per-row DATALENGTH sums and sparse full lengths beside each page, their budget and release, the one helper that sizes
/// any cell, and results.rowBytes. The live suite CellLength compares them with SQL Server's own DATALENGTH.</summary>
internal static class CellLengthChecks
{
    private const int JsonType = 35, VectorType = 36;

    public static void Run(Action<bool, string> check)
    {
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
        Rules(check);
        Counting(check);
        Sidecar(check);
        Buffer(check);
        Service(check);
        Collectors(check);
    }

    private static string Name(ColumnLength length) => length.Rule == LengthRule.Fixed ? "Fixed(" + length.FixedBytes + ")" : length.Rule.ToString();

    private static void Rules(Action<bool, string> check)
    {
        static ColumnLength Of(SqlDbType type, int scale = 7) => ColumnPlan.LengthOf((int)type, scale, false, null, false, null);
        var fixeds = new (SqlDbType Type, int Bytes)[]
        {
            (SqlDbType.Bit, 1), (SqlDbType.TinyInt, 1), (SqlDbType.SmallInt, 2), (SqlDbType.Int, 4), (SqlDbType.BigInt, 8), (SqlDbType.SmallMoney, 4), (SqlDbType.Money, 8),
            (SqlDbType.Real, 4), (SqlDbType.Float, 8), (SqlDbType.Date, 3), (SqlDbType.SmallDateTime, 4), (SqlDbType.DateTime, 8), (SqlDbType.UniqueIdentifier, 16)
        };
        var wrong = fixeds.Where(item => Of(item.Type) is not { Rule: LengthRule.Fixed } rule || rule.FixedBytes != item.Bytes).Select(item => item.Type + "=" + Name(Of(item.Type))).ToList();
        check(wrong.Count == 0, "fixed-size types count their storage size, as DATALENGTH does: " + string.Join(", ", wrong));
        var scaled = string.Join(" ", Enumerable.Range(0, 8).Select(scale => Of(SqlDbType.Time, scale).FixedBytes + "/" + Of(SqlDbType.DateTime2, scale).FixedBytes + "/" + Of(SqlDbType.DateTimeOffset, scale).FixedBytes));
        check(scaled == "3/6/8 3/6/8 3/6/8 4/7/9 4/7/9 5/8/10 5/8/10 5/8/10", "time, datetime2 and datetimeoffset grow by a byte at scales 3 and 5: " + scaled);

        var shiftJis = Encoding.GetEncoding(932);
        var japanese = new SqlClientCollation.Column(new ResultCollation(1041, 0, 932, false, 25), shiftJis);
        var latin = new SqlClientCollation.Column(new ResultCollation(1033, 52, 1252, false, 25), Encoding.GetEncoding(1252));
        var utf8 = new SqlClientCollation.Column(new ResultCollation(1033, 0, 0, true, 25), null);
        ColumnLength Chars(SqlDbType type, SqlClientCollation.Column? collation) => ColumnPlan.LengthOf((int)type, 0, false, null, false, collation);
        var rules = string.Join(" ", new[]
        {
            Chars(SqlDbType.VarChar, latin), Chars(SqlDbType.Char, latin), Chars(SqlDbType.Text, latin), Chars(SqlDbType.VarChar, utf8), Chars(SqlDbType.VarChar, japanese),
            Chars(SqlDbType.VarChar, null), Chars(SqlDbType.NVarChar, japanese), Chars(SqlDbType.NChar, null), Chars(SqlDbType.NText, null), Of(SqlDbType.Decimal),
            Of(SqlDbType.Xml), ColumnPlan.LengthOf(JsonType, 0, true, typeof(string), false, null), ColumnPlan.LengthOf(VectorType, 0, false, null, false, null), Of(SqlDbType.Variant),
            Of(SqlDbType.VarBinary), Of(SqlDbType.Binary), Of(SqlDbType.Image), Of(SqlDbType.Timestamp), Of(SqlDbType.Udt), ColumnPlan.LengthOf(-1, 0, true, typeof(byte[]), false, null),
            ColumnPlan.LengthOf(-1, 0, false, null, false, null)
        }.Select(Name));
        check(rules == "SingleByte SingleByte SingleByte Utf8 CodePage SingleByte Utf16 Utf16 Utf16 Decimal Recorded Utf8 Recorded Recorded Binary Binary Binary Binary Binary Binary Utf16",
            "char types follow their collation's encoding (UTF-8, single- or double-byte code page; one byte a character without one), n-types count UTF-16, and xml, vector and sql_variant are recorded: " + rules);

        var decimals = new (string Text, int Bytes)[]
        {
            ("0", 5), ("1", 5), ("1.0000", 5), ("-1234567.89", 5), ("4294967295", 5), ("4294967296", 9), ("4294967295.0000", 9), ("12345678901", 9),
            ("18446744073709551616", 13), ("1234567890123456789012345678", 13), ("-79228162514264337593543950335", 13), ("79228162514264337593543950336", 17), (new string('9', 38), 17)
        };
        var decimalWrong = decimals.Where(item => ColumnLength.DecimalBytes(Encoding.ASCII.GetBytes(item.Text)) != item.Bytes).Select(item => item.Text + "=" + ColumnLength.DecimalBytes(Encoding.ASCII.GetBytes(item.Text))).ToList();
        check(decimalWrong.Count == 0, "decimal bytes are 1 plus 4 per 32-bit word of the unscaled value, whatever the precision, as DATALENGTH reports: " + string.Join(", ", decimalWrong));
        // Readers take the words from the value itself (no parse per cell); both must agree with the text rule.
        var fromValues = decimals.Where(item => ColumnLength.DecimalBytes(System.Data.SqlTypes.SqlDecimal.Parse(item.Text)) != item.Bytes
            || (item.Text.TrimStart('-').Replace(".", "").Length <= 28 && ColumnLength.DecimalBytes(decimal.Parse(item.Text, System.Globalization.CultureInfo.InvariantCulture)) != item.Bytes))
            .Select(item => item.Text).ToList();
        check(fromValues.Count == 0, "decimal bytes read from a System.Decimal's or SqlDecimal's words equal those from its digits: " + string.Join(", ", fromValues));

        // Without a collation the one-byte-a-character rule is a guess, and a _UTF8 value showing U+FFFD may have held bytes
        // that are not UTF-8: both are reported as estimates.
        var assumed = Chars(SqlDbType.VarChar, null);
        var utf8Rule = Chars(SqlDbType.VarChar, utf8);
        var counter = utf8Rule.Counter();
        counter.Add("a�b");
        var replaced = counter.Replaced;
        counter.Total();
        counter.Add("ab");
        check(assumed.Estimated && !Chars(SqlDbType.VarChar, latin).Estimated && assumed.Derive("abc"u8, WireKind.Text) == new CellSize(3, 3, false)
            && utf8Rule.Derive(Encoding.UTF8.GetBytes("a�b"), WireKind.Text) is { Exact: false, Bytes: 5 }
            && utf8Rule.Derive("aé"u8, WireKind.Text) == new CellSize(2, 3, true) && replaced && !counter.Replaced,
            "a char column without its collation, and a _UTF8 value showing U+FFFD, give estimates");
        check(ColumnPlan.FallbackOf(CellCodec.Json, WireKind.Text, true) == CellCodec.Json && ColumnPlan.FallbackOf(CellCodec.Xml, WireKind.Text, true) == CellCodec.Xml
            && ColumnPlan.FallbackOf(CellCodec.Chars, WireKind.Text, true) == CellCodec.LongText,
            "json keeps its own UTF-8 reader as its fallback, since GetTextReader throws inside a multi-byte sequence");
    }

    private static void Counting(Action<bool, string> check)
    {
        var shiftJis = ColumnLength.Chars(Encoding.GetEncoding(932), false);
        var cases = new (ColumnLength Length, string Text, long Bytes)[]
        {
            (ColumnLength.Utf16, "a b\t ", 10), (ColumnLength.Utf16, "😀", 4), (ColumnLength.Utf16, "\uD800", 2), (ColumnLength.SingleByte, "abc  ", 5), (ColumnLength.SingleByte, "é\t", 2),
            (ColumnLength.Utf8, "é😀 ", 7), (ColumnLength.Utf8, "abc", 3), (shiftJis, "日本", 4), (shiftJis, "a日 ", 4)
        };
        var wrong = cases.Where(item => item.Length.BytesOf(item.Text) != item.Bytes).Select(item => item.Length.Rule + ":" + item.Text + "=" + item.Length.BytesOf(item.Text)).ToList();
        check(wrong.Count == 0, "a text value's bytes follow its column's encoding, whitespace and surrogate pairs included: " + string.Join(", ", wrong));

        long Chunked(ColumnLength length, params string[] chunks)
        {
            var counter = length.Counter();
            counter.Add("stale");
            counter.Reset();
            foreach (var chunk in chunks) counter.Add(chunk);
            return counter.Total();
        }
        var split = Chunked(ColumnLength.Utf8, "é\uD83D", "\uDE00", "", "x\uD83D");
        var again = Chunked(ColumnLength.Utf8, "ab");
        check(split == 2 + 4 + 1 + 3 && again == 2 && Chunked(shiftJis, "日", "本 ") == 5 && Chunked(ColumnLength.Utf16, "ab", "😀") == 8 && Chunked(ColumnLength.SingleByte, "a ", "\t") == 3,
            "a value counted in chunks keeps a surrogate pair split across them whole (4 UTF-8 bytes), a lone high surrogate at its end counts alone, and the counter starts afresh: " + split);

        CellSize Derive(ColumnLength length, string text, WireKind wire = WireKind.Text) => length.Derive(Encoding.UTF8.GetBytes(text), wire);
        var derived = new[]
        {
            Derive(ColumnLength.Fixed(4), "-123"), Derive(ColumnLength.Decimal, "-1.0000"), Derive(ColumnLength.Utf16, "a😀 "), Derive(ColumnLength.Utf8, "é😀 "),
            Derive(ColumnLength.SingleByte, "é  "), Derive(shiftJis, "日本 "), Derive(ColumnLength.Recorded, "<a/>")
        };
        var binary = ColumnLength.Binary.Derive([1, 2, 3], WireKind.Binary);
        var text = string.Join(" ", derived.Select(size => size.Chars + "/" + size.Bytes + (size.Exact ? "" : "?")));
        check(text == "4/4 7/5 4/8 4/7 3/3 3/5 4/8?" && binary == new CellSize(3, 3, true),
            "a stored cell's characters are its UTF-16 units, every space counted, and its bytes follow from its text by the column's rule (a recorded column's only estimated): " + text);
    }

    private static void Sidecar(Action<bool, string> check)
    {
        var builder = new PageBuilder(1, [WireKind.Text, WireKind.Text, WireKind.Binary]);
        check(Throws(() => builder.Measure(1, 1)), "Measure needs a cell to describe");
        builder.BeginRow();
        builder.AppendNull();
        Exception? negative = null;
        try { builder.Measure(-1, 1); } catch (Exception error) { negative = error; }
        builder.AbortRow();
        check(negative is InvalidOperationException, "a negative length ends the read (InvalidOperationException), never a cell failure that would append the cell twice: " + negative?.GetType().Name);
        // Row 0: an int, an nvarchar with trailing whitespace, and binary.
        builder.BeginRow();
        builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), 42));
        builder.Measure(2, 4);
        builder.AppendText("ab \t");
        builder.Measure(4, 8);
        builder.AppendBinary([1, 2, 3]);
        builder.Measure(3, 3);
        var twice = Throws(() => builder.Measure(1, 1));
        builder.CommitRow();
        // Row 1: NULLs count 0; a truncated cell keeps its full lengths.
        builder.BeginRow();
        builder.AppendNull();
        builder.AppendText("abc", truncated: true);
        builder.Measure(100_000, 200_000);
        builder.AppendNull();
        builder.CommitRow();
        // An aborted row leaves no sum or entry behind.
        builder.BeginRow();
        builder.AppendNull();
        builder.AppendText("x", truncated: true);
        builder.Measure(9, 9);
        builder.AbortRow();
        // Row 2: a recorded column's cell keeps its entry untruncated, and a row of 4 GiB or more keeps its exact size.
        builder.BeginRow();
        builder.AppendNull();
        builder.AppendText("<a/>");
        builder.Measure(4, 8, keep: true);
        builder.AppendBinary([0]);
        builder.Measure(3_000_000_000, 5_000_000_000);
        var openLength = builder.OpenRowLengthBytes;
        builder.CommitRow();
        builder.Seal(out var lengths);
        var sums = string.Join(",", Enumerable.Range(0, lengths.Rows).Select(lengths.RowBytes));
        var entries = string.Join(",", lengths.Cells.Select(cell => cell.Row + ":" + cell.Column + "=" + cell.Chars + "/" + cell.Bytes));
        check(twice && sums == "15,200000,5000000008" && entries == "1:1=100000/200000,2:1=4/8" && lengths.Large.Count == 1 && openLength == 4 + PageLengths.CellBytes + PageLengths.LargeBytes
            && lengths.TryCell(1, 1, out var cut) && cut.Chars == 100_000 && !lengths.TryCell(0, 1, out _) && !lengths.TryCell(2, 2, out _)
            && lengths.MemoryBytes == PageLengths.Overhead + 3 * 4 + 2 * PageLengths.CellBytes + PageLengths.LargeBytes,
            "a page's sidecar holds each row's DATALENGTH sum (NULL as 0, 4 GiB and more exactly) and the full lengths of truncated and recorded cells only, none of an aborted row: " + sums + " " + entries);

        // The builder's own 8 MiB row limit cuts a cell its reader stored whole: the full lengths are kept all the same.
        builder.BeginRow();
        var big = new string('x', PageBuilder.MaxRowBytes + 10);
        builder.AppendText(big);
        builder.Measure(big.Length, big.Length);
        builder.AppendNull();
        builder.AppendNull();
        builder.CommitRow();
        builder.Seal(out lengths);
        check(lengths.Cells is [{ Row: 0, Column: 0 } entry] && entry.Chars == big.Length && lengths.RowBytes(0) == big.Length,
            "a cell the 8 MiB row limit cuts keeps the full lengths its reader measured");

        // An estimate (a sql_variant SqlClient does not tell apart, a fallback reader) keeps an entry that says so, in the
        // same 24 bytes, so the row's sum and the cell's size agree and neither claims to be exact.
        builder.BeginRow();
        builder.AppendText("ab");
        builder.Measure(2, 4, exact: false);
        builder.AppendText("cd");
        builder.Measure(2, 4, keep: true);
        builder.AppendNull();
        builder.CommitRow();
        builder.Seal(out lengths);
        var packed = new CellLength(1, int.MaxValue, 1, 2, exact: false);
        check(lengths.Cells is [{ Row: 0, Column: 0, Exact: false, Bytes: 4 }, { Row: 0, Column: 1, Exact: true }] && lengths.RowBytes(0) == 8
            && lengths.TryCell(0, 0, out var estimated) && !estimated.Exact && packed.Column == int.MaxValue && !packed.Exact
            && System.Runtime.CompilerServices.Unsafe.SizeOf<CellLength>() == PageLengths.CellBytes,
            "an estimated cell keeps a 24-byte entry marked inexact, and a kept exact one stays exact");
    }

    private static ResultSetBuffer Measured(ResultStore store, QueryBudget query, long rows, int textCap = int.MaxValue)
    {
        IReadOnlyList<ResultColumn> columns = [new("id", "int", "text"), new("name", "nvarchar", "text"), new("data", "varbinary", "binary")];
        var set = store.Open(query, 0, 1, 1, "rows", columns, [WireKind.Text, WireKind.Text, WireKind.Binary], lengths: [ColumnLength.Fixed(4), ColumnLength.Utf16, ColumnLength.Binary])
            ?? throw new InvalidOperationException("The result set was not kept.");
        for (long row = 0; row < rows; row++)
        {
            set.CountRow();
            if (set.BeginRow() is not { } builder) continue;
            builder.EndFormatted(CellFormat.WriteInteger(builder.BeginFormatted(), row));
            builder.Measure(0, 4);
            if (row % 7 == 3) builder.AppendNull();
            else
            {
                var name = "row " + row + new string(' ', (int)(row % 5));
                builder.AppendText(name.Length > textCap ? name[..textCap] : name, name.Length > textCap);
                builder.Measure(name.Length, 2L * name.Length);
            }
            var bytes = new byte[row % 11];
            builder.AppendBinary(bytes);
            builder.Measure(bytes.Length, bytes.Length);
            set.TryCommitRow();
        }
        return set;
    }

    private static long Expected(long row) => 4 + (row % 7 == 3 ? 0 : 2L * ("row " + row).Length + 2 * (row % 5)) + row % 11;

    private static void Buffer(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var query = store.BeginQuery("s");
        var set = Measured(store, query, 10_000);
        var midway = set.RowBytes(9000, 100).Length;
        set.Complete();
        var pages = set.PagesFor(0, int.MaxValue);
        var all = set.RowBytes(0, 16_384);
        var across = set.RowBytes(60, 10);
        var tail = set.RowBytes(9_998, 100);
        var past = set.RowBytes(10_000, 5);
        check(midway == 0 && all.Length == 10_000 && all.Select((bytes, row) => bytes == Expected(row)).All(same => same) && across.SequenceEqual(Enumerable.Range(60, 10).Select(row => Expected(row)))
            && tail.Length == 2 && past.Length == 0 && pages.Count > 2,
            "row bytes read back for any range, across page boundaries, only as far as sealed pages go (" + pages.Count + " pages)");

        var metadata = 512 + (2 * "idnamedata".Length + 3 * 64);
        var charged = metadata + pages.Sum(page => page.Body.Length + ResultStore.PageOverhead + page.Lengths.MemoryBytes);
        var sidecar = pages.Sum(page => page.Lengths.MemoryBytes);
        check(store.UsedBytes == charged && query.UsedBytes == charged && sidecar >= 4L * 10_000 && sidecar < 4L * 10_000 + pages.Count * (PageLengths.Overhead + 64),
            "a complete set is charged its metadata and each page's bytes, overhead and lengths sidecar (4 bytes a row here): " + store.UsedBytes + " of " + charged + ", sidecar " + sidecar);

        var cutSet = Measured(store, store.BeginQuery("t"), 20, textCap: 6);
        cutSet.Complete();
        var cell = cutSet.CellSize(12, 1);
        var whole = cutSet.CellSize(1, 1);
        var nullCell = cutSet.CellSize(3, 1);
        var data = cutSet.CellSize(5, 2);
        var id = cutSet.CellSize(19, 0);
        var cutCells = Enumerable.Range(0, 20).Count(row => row % 7 != 3 && ("row " + row).Length + row % 5 > 6);
        check(cell == new CellSize(8, 16, true) && whole == new CellSize(6, 12, true) && nullCell is null && data == new CellSize(5, 5, true) && id == new CellSize(2, 4, true)
            && cutSet.CellSize(20, 0) is null && Throws(() => cutSet.CellSize(0, 3)) && cutSet.PagesFor(0, 20)[0].Lengths.Cells.Count == cutCells,
            "one helper sizes any stored cell: a truncated one from its recorded entry, others from their text and type, NULL and missing rows as null: " + cell + " " + whole + " " + data + " " + id);

        // Live tables count their cells as nvarchar text; a cut cell, whose full text the probe never had, counts its kept
        // text in the row's sum and keeps an entry marked inexact.
        var live = store.Open(store.BeginQuery("live"), 0, 1, 1, "rows", [new("a", "nvarchar", "text"), new("b", "nvarchar", "text")], [WireKind.Text, WireKind.Text])!;
        LiveTableSet.Write(live, new LiveRow([LiveCell.Of("ab "), new LiveCell(null, "cut", Truncated: true)]));
        LiveTableSet.Write(live, new LiveRow([LiveCell.Of((string?)null), LiveCell.Of("x")]));
        live.Complete();
        check(live.RowBytes(0, 2).SequenceEqual([12L, 2L]) && live.CellSize(0, 1) == new CellSize(3, 6, false) && live.CellSize(0, 0) == new CellSize(3, 6, true)
            && live.PagesFor(0, 2)[0].Lengths.Cells is [{ Row: 0, Column: 1, Exact: false }],
            "a live table's rows count their cells as nvarchar text, and a cut cell's kept text as an estimate marked inexact");

        var leased = set.TryLease();
        var released = store.Release(set.ResultId);
        var whileLeased = set.RowBytes(0, 10).Length;
        set.ReleaseLease();
        store.Release(cutSet.ResultId);
        store.Release(live.ResultId);
        check(leased && released && whileLeased == 10 && set.RowBytes(0, 10).Length == 0 && store.UsedBytes == 0,
            "the sidecar is freed with its pages: a lease keeps both, and the last release returns every byte");
    }

    private static void Service(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var set = Measured(store, store.BeginQuery("s"), 5000);
        set.Complete();
        ResultsRowBytesResult Bytes(object args) => (ResultsRowBytesResult)service.DispatchAsync("results.rowBytes", JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        string? Code(object args)
        {
            try { Bytes(args); return null; }
            catch (RequestException error) { return error.Code; }
            // ProtocolHost answers a member the record lacks as INVALID_PARAMS.
            catch (JsonException) { return "INVALID_PARAMS"; }
        }
        var range = Bytes(new { resultId = set.ResultId, firstRow = 4990, count = 16_384 });
        var first = Bytes(new { resultId = set.ResultId, firstRow = 0, count = 3 });
        check(SqlService.MethodNames.Contains("results.rowBytes") && range.FirstRow == 4990 && range.RowsAvailable == 5000 && range.Bytes.SequenceEqual(Enumerable.Range(4990, 10).Select(row => Expected(row)))
            && first.Bytes.SequenceEqual([Expected(0), Expected(1), Expected(2)]),
            "results.rowBytes answers each row's bytes for a range, stopping at the rows available, and HELLO offers it");
        var codes = new[]
        {
            Code(new { resultId = set.ResultId, firstRow = 0, count = 0 }), Code(new { resultId = set.ResultId, firstRow = 0, count = SqlService.MaxRowBytesRows + 1 }),
            Code(new { resultId = set.ResultId, firstRow = -1, count = 1 }), Code(new { resultId = 0, firstRow = 0, count = 1 }), Code(new { resultId = 999, firstRow = 0, count = 1 }),
            Code(new { resultId = set.ResultId, firstRow = 0, count = 1, extra = 1 })
        };
        store.Release(set.ResultId);
        var afterRelease = Code(new { resultId = set.ResultId, firstRow = 0, count = 1 });
        check(string.Join(",", codes) == "INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,RESULT_NOT_FOUND,INVALID_PARAMS" && afterRelease == "RESULT_RELEASED" && SqlService.MaxRowBytesRows == 16_384,
            "results.rowBytes bounds its range to 16,384 rows, rejects unknown members, and tells a released result from one that never existed: " + string.Join(",", codes) + "," + afterRelease);
    }

    private static void Collectors(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using (var collector = new ForXmlCollector(store, store.BeginQuery("x"), cap: 10))
        {
            collector.Append("<row a=\"1\"/>");
            collector.Append("<row a=\"2\"/>");
            var builder = new PageBuilder(1, [WireKind.Text]);
            builder.BeginRow();
            var cut = collector.Write(builder);
            builder.CommitRow();
            builder.Seal(out var lengths);
            check(cut && collector.TotalChars == 24 && lengths.Cells is [{ Chars: 24, Bytes: 48 }] && lengths.RowBytes(0) == 48,
                "FOR XML output keeps its whole length, as nvarchar, past the cap it is cut at");
        }
        var text = CellFormat.Vector([1f, 2.5f, -3f, 0.1f], 6, out var truncated, out var length);
        var full = CellFormat.Vector([1f, 2.5f, -3f, 0.1f], 100, out var whole, out var wholeLength);
        check(truncated && !whole && full == "[1,2.5,-3,0.1]" && length == full.Length && wholeLength == full.Length && text.Length <= 6,
            "a cut vector reports the length of its whole text");
        check(SqlClientCollation.Available, "SqlClient still has the column metadata internals collations are read through (SqlClientCollation)");
    }

    private static bool Throws(Action action)
    {
        try { action(); return false; }
        catch (Exception error) when (error is InvalidOperationException or ArgumentOutOfRangeException) { return true; }
    }
}
