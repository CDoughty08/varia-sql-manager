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
    // A column of #v: its type, the values of rows 1 to 4 (row 4 is past the caps; row 5 is all NULL), and the SQL for its
    // expected bytes and characters (null: the characters are display text SQL Server has no length for).
    private sealed record Spec(string Name, string Type, string[] Values, string? Bytes = null, string? Chars = null);

    private const string Emoji = "NCHAR(0xD83D) + NCHAR(0xDE00)";

    // _UTF8 collations came with SQL Server 2019 (15): before it, column u is a plain varchar of the same locale.
    private static Spec[] SpecsFor(int major) =>
    [
        new("nv", "nvarchar(max) COLLATE Latin1_General_CI_AS", ["N'a  '", "NCHAR(9) + " + Emoji + " + NCHAR(9)", "N''", "REPLICATE(CAST(N'é' + " + Emoji + " + N' ' AS nvarchar(max)), 30000)"], Chars: "LEN(nv + N'x') - 1"),
        new("v", "varchar(max) COLLATE Latin1_General_CI_AS", ["'é  '", "CHAR(9) + ' '", "''", "REPLICATE(CAST('é ' AS varchar(max)), 40000)"], Chars: "LEN(v + 'x') - 1"),
        new("u", "varchar(max) COLLATE Latin1_General_100_CI_AS_SC" + (major >= 15 ? "_UTF8" : ""), ["N'é' + " + Emoji + " + N' '", "N'" + "\t" + "'", "N' '", "REPLICATE(CAST(N'é' + " + Emoji + " + NCHAR(9) AS nvarchar(max)), 30000)"]),
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
        // xml's own DATALENGTH is its binary storage, which no client sees: its UTF-16 text as SQL Server sends it is compared,
        // for its characters too (SqlClient's display text writes <e /> for SQL Server's <e/>; lengths follow the server's).
        new("x", "xml", ["N'<a b=\"1\">t &amp; x</a>'", "N'<r>  " + "\t" + "</r>'", "N'<e/>'", "N'<r>' + REPLICATE(CAST(N'y' AS nvarchar(max)), 3000000) + N'</r>'"],
            Bytes: "DATALENGTH(CONVERT(nvarchar(max), x))", Chars: "DATALENGTH(CONVERT(nvarchar(max), x)) / 2"),
        // Only base types SqlClient tells apart, whose bytes are exact; the others are checked as estimates below.
        new("sv", "sql_variant", ["CAST(42 AS int)", "CAST(7 AS bigint)", "CAST(CAST(1.5 AS decimal(9,2)) AS sql_variant)", "CAST(0x0102 AS varbinary(10))"])
    ];

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var store = service.Results;
        var session = Guid.NewGuid().ToString();
        async Task<QueryResult> Run(string sql) => (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
            new QueryArgs(info.Id, session, "master", sql, Guid.NewGuid().ToString(), 1000, 120), json), json);
        try
        {
            var major = int.Parse(LiveResultChecks.RowsOf(store, (await Run("SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS int);")).ResultSets[0])[0][0]!, CultureInfo.InvariantCulture);
            var specs = SpecsFor(major);
            var bytes = specs.Select(spec => spec.Bytes ?? "DATALENGTH(" + spec.Name + ")").ToArray();
            var sum = string.Join(" + ", bytes.Select(expression => "ISNULL(" + expression + ", 0)"));
            var rows = Enumerable.Range(0, 4).Select(row => "(" + (row + 1) + ", " + string.Join(", ", specs.Select(spec => spec.Values[row])) + ")")
                .Prepend("(5, " + string.Join(", ", specs.Select(_ => "NULL")) + ")");
            var sql = "SET NOCOUNT ON; CREATE TABLE #v (id int NOT NULL PRIMARY KEY, " + string.Join(", ", specs.Select(spec => spec.Name + " " + spec.Type + " NULL")) + ");\n"
                + "INSERT #v (id, " + string.Join(", ", specs.Select(spec => spec.Name)) + ") VALUES " + string.Join(", ", rows) + ";\n"
                // The expected row size is a bigint column of the set itself, so it counts its own 8 bytes.
                + "SELECT " + string.Join(", ", specs.Select(spec => spec.Name)) + ", CAST(" + sum + " + 8 AS bigint) AS expected FROM #v ORDER BY id;\n"
                + "SELECT " + string.Join(", ", specs.Select((spec, i) => bytes[i] + ", " + (spec.Chars ?? "NULL"))) + " FROM #v ORDER BY id;\n"
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
                for (var column = 0; column < specs.Length; column++)
                {
                    var spec = specs[column];
                    var expectedBytes = references[row][2 * column] is { } text ? long.Parse(text, CultureInfo.InvariantCulture) : (long?)null;
                    var charsText = spec.Name == "u" ? utf8Chars[row][0] : references[row][2 * column + 1];
                    var expectedChars = charsText is null ? (long?)null : long.Parse(charsText, CultureInfo.InvariantCulture);
                    var size = set.CellSize(row, column);
                    var ok = expectedBytes is null ? size is null
                        : size is { Exact: true } exact && exact.Bytes == expectedBytes && (expectedChars is null || exact.Chars == expectedChars);
                    if (!ok) wrong.Add(spec.Name + "[" + (row + 1) + "]: " + (size is { } s ? s.Chars + "/" + s.Bytes + (s.Exact ? "" : "?") : "null") + " vs " + expectedChars + "/" + expectedBytes);
                }
            var cut = specs.Select((spec, column) => cells[3][column].Flags & PageReader.Truncated).Count(flag => flag != 0);
            check(wrong.Count == 0 && cut == 7, "every cell's bytes equal DATALENGTH and its characters LEN(x + 'x') - 1, past the caps (" + cut + " truncated cells) too: " + string.Join("; ", wrong));

            var expected = cells.Select(row => row[^1].Text is { } text ? long.Parse(text, CultureInfo.InvariantCulture) : -1).ToArray();
            var answer = (ResultsRowBytesResult)await service.DispatchAsync("results.rowBytes", JsonSerializer.SerializeToElement(new { resultId = values.ResultId, firstRow = 0, count = 100 }, json), json);
            check(answer.Bytes.SequenceEqual(expected) && answer.RowsAvailable == 5,
                "results.rowBytes answers each row's sum of DATALENGTH: " + string.Join(",", answer.Bytes) + " vs " + string.Join(",", expected));

            var collations = string.Join(" ", values.Columns.Take(7).Select(column => column.Collation is { } c ? c.Lcid + "/" + c.SortId + "/" + c.CodePage + "/" + (c.Utf8 ? "utf8" : "-") + "/" + c.Options : "none"));
            check(collations == "1033/0/1252/-/25 1033/0/1252/-/25 " + (major >= 15 ? "1033/0/0/utf8/25" : "1033/0/1252/-/25") + " 1041/0/932/-/25 1033/52/1252/-/25 1033/0/1252/-/25 1033/0/1252/-/25"
                && values.Columns[7].Collation is { Utf8: false } && values.Columns.Skip(8).All(column => column.Collation is null),
                "character columns carry their collation (locale, SQL sort id, code page, UTF-8, comparison flags), and other columns none: " + collations);

            // Base types SqlClient does not tell apart give estimates, marked so, and the row's sum carries the same figure
            // (docs/ipc.md): a varchar arrives as an nvarchar's SqlString (DATALENGTH 2, counted 4), smallmoney as money
            // (4, counted 8), and a date with no scale (3, counted 8 as datetime2(7)).
            result = await Run("SELECT CAST('ab' AS sql_variant) AS a, CAST(CAST(1 AS smallmoney) AS sql_variant) AS b, CAST(CAST('2026-11-05' AS date) AS sql_variant) AS c;");
            var estimates = store.Find(result.ResultSets[0].ResultId)!;
            var sizes = Enumerable.Range(0, 3).Select(column => estimates.CellSize(0, column)).ToArray();
            check(sizes is [{ Exact: false, Chars: 2, Bytes: 4 }, { Exact: false, Bytes: 8 }, { Exact: false, Bytes: 8 }] && estimates.RowBytes(0, 1) is [20],
                "sql_variant values whose base type SqlClient does not tell apart are estimates, marked inexact: " + string.Join(" ", sizes));

            if (major >= 17)
            {
                // json's own DATALENGTH is its binary storage too: the UTF-8 text SQL Server sends is compared. A vector is
                // 8 bytes of header and 4 per dimension, as DATALENGTH reports. The json holds two-, three- and four-byte
                // UTF-8 (SqlClient 7.1.1's GetChars decoded it one byte a character), and the long one passes the cap, so
                // its lengths are counted across chunks while it is read past.
                result = await Run("DECLARE @j json = N'{\"a\":\"b  é\" , \"d\":[1, 2], \"€\":\"😀\"}'; DECLARE @v vector(3) = '[1,2.5,-3]';"
                    + " DECLARE @l json = N'[\"' + REPLICATE(CAST(N'é€😀' AS nvarchar(max)), 600000) + N'\"]';"
                    + " SELECT @j AS j, @v AS v, @l AS l; SELECT DATALENGTH(CONVERT(varchar(max), CAST(@j AS nvarchar(max)) COLLATE Latin1_General_100_CI_AS_SC_UTF8)),"
                    + " DATALENGTH(CAST(@j AS nvarchar(max))) / 2, DATALENGTH(@v),"
                    + " DATALENGTH(CONVERT(varchar(max), CAST(@l AS nvarchar(max)) COLLATE Latin1_General_100_CI_AS_SC_UTF8)), DATALENGTH(CAST(@l AS nvarchar(max))) / 2;");
                check(result.ResultSets.Count == 2, "the json and vector batch runs: " + result.Status + " " + result.Error?.Message);
                if (result.ResultSets.Count != 2) return;
                var modern = store.Find(result.ResultSets[0].ResultId)!;
                var refs = LiveResultChecks.RowsOf(store, result.ResultSets[1])[0];
                var json2 = modern.CellSize(0, 0);
                var vector = modern.CellSize(0, 1);
                var longJson = modern.CellSize(0, 2);
                check(json2 is { Exact: true } j && j.Bytes.ToString(CultureInfo.InvariantCulture) == refs[0] && j.Chars.ToString(CultureInfo.InvariantCulture) == refs[1]
                    && vector is { Exact: true } v && v.Bytes.ToString(CultureInfo.InvariantCulture) == refs[2] && v.Chars == "[1,2.5,-3]".Length
                    && longJson is { Exact: true } l && l.Bytes.ToString(CultureInfo.InvariantCulture) == refs[3] && l.Chars.ToString(CultureInfo.InvariantCulture) == refs[4],
                    "json counts its UTF-8 text, past its cap too, and vector its stored size: " + json2 + " " + vector + " " + longJson + " vs " + string.Join(",", refs));
            }
        }
        finally
        {
            await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(session), json), json);
        }
    }
}
