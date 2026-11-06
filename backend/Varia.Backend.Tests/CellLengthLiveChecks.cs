using System.Globalization;
using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Live checks of the lengths recorded at ingest (docs/ipc.md, Cell lengths) against SQL Server's own: each cell's
/// bytes against DATALENGTH and its characters against LEN(x + 'x') - 1 (every trailing space counted) or, where LEN counts
/// a surrogate pair as one character (supplementary-character and _UTF8 collations) or does not apply (text, ntext, xml),
/// against DATALENGTH(CONVERT(nvarchar(max), x)) / 2; each row's bytes against the sum of DATALENGTH; and each character
/// column's collation against what the server says. Hostile values: trailing spaces, tabs, surrogate pairs, empty strings,
/// NULLs and values past every cap. Everything lives in one temporary table of the batch.</summary>
internal static class CellLengthLiveChecks
{
    // A column of #v: its type, the values of rows 1 to 4 (row 3 is all NULL, row 4 is past the caps), and the SQL for its
    // expected bytes and characters (null: the characters are display text SQL Server has no length for).
    private sealed record Spec(string Name, string Type, string[] Values, string? Bytes = null, string? Chars = null);

    private const string Emoji = "NCHAR(0xD83D) + NCHAR(0xDE00)";

    private static readonly Spec[] Specs =
    [
        new("nv", "nvarchar(max) COLLATE Latin1_General_CI_AS", ["N'a  '", "NCHAR(9) + " + Emoji + " + NCHAR(9)", "N''", "REPLICATE(CAST(N'é' + " + Emoji + " + N' ' AS nvarchar(max)), 30000)"], Chars: "LEN(nv + N'x') - 1"),
        new("v", "varchar(max) COLLATE Latin1_General_CI_AS", ["'é  '", "CHAR(9) + ' '", "''", "REPLICATE(CAST('é ' AS varchar(max)), 40000)"], Chars: "LEN(v + 'x') - 1"),
        new("u", "varchar(max) COLLATE Latin1_General_100_CI_AS_SC_UTF8", ["N'é' + " + Emoji + " + N' '", "N'" + "\t" + "'", "N' '", "REPLICATE(CAST(N'é' + " + Emoji + " + NCHAR(9) AS nvarchar(max)), 30000)"]),
        new("jp", "varchar(100) COLLATE Japanese_CI_AS", ["N'日本 '", "N'ｱ a'", "N''", "N'日本語の文字列'"], Chars: "LEN(jp + 'x') - 1"),
        new("sq", "char(6) COLLATE SQL_Latin1_General_CP1_CI_AS", ["'ab'", "' '", "'é'", "'abcdef'"], Chars: "LEN(sq + 'x') - 1"),
        new("nc", "nchar(5) COLLATE Latin1_General_CI_AS", ["N'x'", Emoji, "N''", "N'abcde'"], Chars: "LEN(nc + N'x') - 1"),
        new("tx", "text COLLATE Latin1_General_CI_AS", ["'abc '", "CHAR(9)", "''", "REPLICATE(CAST('t ' AS varchar(max)), 40000)"], Chars: "DATALENGTH(CONVERT(nvarchar(max), CONVERT(varchar(max), tx))) / 2"),
        new("nt", "ntext", ["N'ab '", Emoji, "N''", "REPLICATE(CAST(N'n ' AS nvarchar(max)), 40000)"], Chars: "DATALENGTH(nt) / 2"),
        new("vb", "varbinary(max)", ["0x0102", "0x", "0x00", "CONVERT(varbinary(max), REPLICATE(CAST('a' + CHAR(0) AS varchar(max)), 20000))"], Chars: "DATALENGTH(vb)"),
        new("d", "decimal(38,4)", ["1", "123456789012.3456", "0", "-9999999999999999999999999999999999.9999"]),
        new("i", "int", ["42", "-1", "0", "2147483647"]),
        new("b", "bit", ["1", "0", "0", "1"]),
        new("m", "smallmoney", ["1.5", "-2", "0", "214748.3647"]),
        new("f", "float", ["0.1", "1e300", "0", "-1e-300"]),
        new("r", "real", ["0.5", "-1e30", "0", "1"]),
        new("d2", "datetime2(3)", ["'2026-01-02 03:04:05.678'", "'0001-01-01'", "'9999-12-31'", "'2026-11-05'"]),
        new("dto", "datetimeoffset", ["'2026-01-02 03:04:05 +01:00'", "'0001-01-01 00:00 -14:00'", "'2026-11-05 00:00 -12:00'", "'2026-11-05'"]),
        new("t", "time(0)", ["'12:34:56'", "'00:00'", "'23:59:59'", "'01:02:03'"]),
        new("sd", "smalldatetime", ["'2026-01-02 03:04'", "'1900-01-01'", "'2079-06-06'", "'2026-11-05'"]),
        new("dt", "date", ["'2026-01-02'", "'0001-01-01'", "'9999-12-31'", "'2026-11-05'"]),
        new("g", "uniqueidentifier", ["NEWID()", "NEWID()", "NEWID()", "NEWID()"]),
        // xml's own DATALENGTH is its binary storage, which no client sees: its UTF-16 text as SQL Server sends it is compared.
        // Its characters are the display text's (SqlClient's serialisation writes <e /> for SQL Server's <e/>), checked below.
        new("x", "xml", ["N'<a b=\"1\">t &amp; x</a>'", "N'<r>  " + "\t" + "</r>'", "N'<e/>'", "N'<r>' + REPLICATE(CAST(N'y' AS nvarchar(max)), 3000000) + N'</r>'"],
            Bytes: "DATALENGTH(CONVERT(nvarchar(max), x))"),
        new("sv", "sql_variant", ["CAST(42 AS int)", "CAST(N'ab ' AS nvarchar(10))", "CAST(CAST(1.5 AS decimal(9,2)) AS sql_variant)", "CAST(0x0102 AS varbinary(10))"])
    ];

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var store = service.Results;
        var session = Guid.NewGuid().ToString();
        async Task<QueryResult> Run(string sql) => (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
            new QueryArgs(info.Id, session, "master", sql, Guid.NewGuid().ToString(), 1000, 120), json), json);
        try
        {
            var bytes = Specs.Select(spec => spec.Bytes ?? "DATALENGTH(" + spec.Name + ")").ToArray();
            var sum = string.Join(" + ", bytes.Select(expression => "ISNULL(" + expression + ", 0)"));
            var rows = Enumerable.Range(0, 4).Select(row => "(" + (row + 1) + ", " + string.Join(", ", Specs.Select(spec => spec.Values[row])) + ")")
                .Prepend("(5, " + string.Join(", ", Specs.Select(_ => "NULL")) + ")");
            var sql = "SET NOCOUNT ON; CREATE TABLE #v (id int NOT NULL PRIMARY KEY, " + string.Join(", ", Specs.Select(spec => spec.Name + " " + spec.Type + " NULL")) + ");\n"
                + "INSERT #v (id, " + string.Join(", ", Specs.Select(spec => spec.Name)) + ") VALUES " + string.Join(", ", rows) + ";\n"
                // The expected row size is a bigint column of the set itself, so it counts its own 8 bytes.
                + "SELECT " + string.Join(", ", Specs.Select(spec => spec.Name)) + ", CAST(" + sum + " + 8 AS bigint) AS expected FROM #v ORDER BY id;\n"
                + "SELECT " + string.Join(", ", Specs.Select((spec, i) => bytes[i] + ", " + (spec.Chars ?? "NULL"))) + " FROM #v ORDER BY id;\n"
                + "SELECT DATALENGTH(CONVERT(nvarchar(max), u)) / 2 FROM #v ORDER BY id;\n"
                + "DROP TABLE #v;";
            var result = await Run(sql);
            check(result.Status == "completed" && result.ResultSets.Count == 3, "the lengths batch runs: " + result.Status + " " + result.Error?.Message);
            if (result.ResultSets.Count != 3) return;
            var (values, references, utf8Chars) = (result.ResultSets[0], LiveResultChecks.RowsOf(store, result.ResultSets[1]), LiveResultChecks.RowsOf(store, result.ResultSets[2]));
            var set = store.Find(values.ResultId)!;
            var cells = LiveResultChecks.CellsOf(store, values);
            var wrong = new List<string>();
            for (var row = 0; row < 5; row++)
                for (var column = 0; column < Specs.Length; column++)
                {
                    var spec = Specs[column];
                    var expectedBytes = references[row][2 * column] is { } text ? long.Parse(text, CultureInfo.InvariantCulture) : (long?)null;
                    var charsText = spec.Name == "u" ? utf8Chars[row][0] : references[row][2 * column + 1];
                    var expectedChars = charsText is null ? (long?)null : long.Parse(charsText, CultureInfo.InvariantCulture);
                    var size = set.CellSize(row, column);
                    var ok = expectedBytes is null ? size is null
                        : size is { Exact: true } exact && exact.Bytes == expectedBytes && (expectedChars is null || exact.Chars == expectedChars);
                    if (!ok) wrong.Add(spec.Name + "[" + (row + 1) + "]: " + (size is { } s ? s.Chars + "/" + s.Bytes + (s.Exact ? "" : "?") : "null") + " vs " + expectedChars + "/" + expectedBytes);
                }
            var cut = Specs.Select((spec, column) => cells[3][column].Flags & PageReader.Truncated).Count(flag => flag != 0);
            // A cut xml value's characters are its UTF-16 text's, since the display text past the cap is never produced.
            var xmlColumn = Array.FindIndex(Specs, spec => spec.Name == "x");
            var cutXml = set.CellSize(3, xmlColumn);
            if (cutXml is not { } xmlSize || xmlSize.Chars * 2 != xmlSize.Bytes || xmlSize.Chars != 3_000_007) wrong.Add("x[4] characters: " + cutXml);
            check(wrong.Count == 0 && cut == 7, "every cell's bytes equal DATALENGTH and its characters LEN(x + 'x') - 1, past the caps (" + cut + " truncated cells) too: " + string.Join("; ", wrong));

            var expected = cells.Select(row => row[^1].Text is { } text ? long.Parse(text, CultureInfo.InvariantCulture) : -1).ToArray();
            var answer = (ResultsRowBytesResult)await service.DispatchAsync("results.rowBytes", JsonSerializer.SerializeToElement(new { resultId = values.ResultId, firstRow = 0, count = 100 }, json), json);
            check(answer.Bytes.SequenceEqual(expected) && answer.RowsAvailable == 5,
                "results.rowBytes answers each row's sum of DATALENGTH: " + string.Join(",", answer.Bytes) + " vs " + string.Join(",", expected));

            var collations = string.Join(" ", values.Columns.Take(7).Select(column => column.Collation is { } c ? c.Lcid + "/" + c.SortId + "/" + c.CodePage + "/" + (c.Utf8 ? "utf8" : "-") + "/" + c.Options : "none"));
            check(collations == "1033/0/1252/-/25 1033/0/1252/-/25 1033/0/0/utf8/25 1041/0/932/-/25 1033/52/1252/-/25 1033/0/1252/-/25 1033/0/1252/-/25"
                && values.Columns[7].Collation is { Utf8: false } && values.Columns.Skip(8).All(column => column.Collation is null),
                "character columns carry their collation (locale, SQL sort id, code page, UTF-8, comparison flags), and other columns none: " + collations);

            // A varchar sql_variant arrives as the same SqlString as an nvarchar one, so it counts 2 bytes a character (docs/ipc.md).
            result = await Run("SELECT CAST('ab' AS sql_variant) AS v, DATALENGTH(CAST('ab' AS sql_variant)) AS d;");
            var variant = store.Find(result.ResultSets[0].ResultId)!.CellSize(0, 0);
            check(variant == new CellSize(2, 4, true) && LiveResultChecks.RowsOf(store, result.ResultSets[0])[0][1] == "2",
                "a varchar sql_variant counts as nvarchar, the one base type SqlClient does not tell apart (DATALENGTH says 2)");

            var major = int.Parse(LiveResultChecks.RowsOf(store, (await Run("SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int);")).ResultSets[0])[0][0]!, CultureInfo.InvariantCulture);
            if (major >= 17)
            {
                // json's own DATALENGTH is its binary storage too: the UTF-8 text SQL Server sends is compared. A vector is
                // 8 bytes of header and 4 per dimension, as DATALENGTH reports. The json is ASCII: SqlClient 7.1.1's GetChars
                // under sequential access decodes json's UTF-8 one byte a character (é shows as Ã©), so its non-ASCII text,
                // and the lengths counted from it, are wrong until that is fixed (docs/ipc.md).
                result = await Run("DECLARE @j json = N'{\"a\":\"b  c\" , \"d\":[1, 2]}'; DECLARE @v vector(3) = '[1,2.5,-3]';"
                    + " SELECT @j AS j, @v AS v; SELECT DATALENGTH(CONVERT(varchar(max), CAST(@j AS nvarchar(max)) COLLATE Latin1_General_100_CI_AS_SC_UTF8)),"
                    + " DATALENGTH(CAST(@j AS nvarchar(max))) / 2, DATALENGTH(@v);");
                check(result.ResultSets.Count == 2, "the json and vector batch runs: " + result.Status + " " + result.Error?.Message);
                if (result.ResultSets.Count != 2) return;
                var modern = store.Find(result.ResultSets[0].ResultId)!;
                var refs = LiveResultChecks.RowsOf(store, result.ResultSets[1])[0];
                var json2 = modern.CellSize(0, 0);
                var vector = modern.CellSize(0, 1);
                check(json2 is { Exact: true } j && j.Bytes.ToString(CultureInfo.InvariantCulture) == refs[0] && j.Chars.ToString(CultureInfo.InvariantCulture) == refs[1]
                    && vector is { Exact: true } v && v.Bytes.ToString(CultureInfo.InvariantCulture) == refs[2] && v.Chars == "[1,2.5,-3]".Length,
                    "json counts its UTF-8 text and vector its stored size: " + json2 + " " + vector + " vs " + string.Join(",", refs));
            }
        }
        finally
        {
            await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(session), json), json);
        }
    }
}
