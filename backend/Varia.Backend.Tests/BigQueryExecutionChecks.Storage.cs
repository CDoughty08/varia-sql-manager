using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Numerics;
using System.Text;
using System.Text.Json.Nodes;
using Apache.Arrow;
using Apache.Arrow.Scalars;
using Apache.Arrow.Types;
using Grpc.Core;
using Varia.Backend.BigQuery;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>
/// Storage Read offline (docs/bigquery.md, Storage Read): query.execute reading a large result through
/// <see cref="BigQueryStorageFake"/>. The REST/Arrow golden check (the same values through both readers give identical
/// cells for every type), the session request and stream count by the backend's scanner, parallel streams appended, the
/// REST fallbacks and their once-per-connection messages, the size threshold, the row limit and budget, a stream read
/// again from its offset, read failures and errors, the text writers, and the proxy check (gRPC through CONNECT).
/// </summary>
internal static partial class BigQueryExecutionChecks
{
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;
    static readonly JsonObject Destination = new() { ["projectId"] = "varia-emulator", ["datasetId"] = "_anon0123", ["tableId"] = "anon_result_1" };

    /// <summary>One row of the golden check's values, from which both the REST JSON and the Arrow batch are written.</summary>
    sealed record Golden(long? I, double? F, BigInteger? N, BigInteger? Bn, bool? B, string? S, byte[]? Y, DateOnly? D, long? T, long? Dt, long? Ts,
        (int M, int D, long Micros)? Iv, (DateOnly? Lo, DateOnly? Hi)? Rd, (long? Lo, long? Hi)? Rt, string? G, string? J, (long? A, string[] B)? St, long[]? Ai, (double X, long? T)[]? As);

    const long MinMicros = -62_135_596_800_000_000, MaxMicros = 253_402_300_799_999_999;
    static readonly BigInteger Scale9 = BigInteger.Pow(10, 9), Scale38 = BigInteger.Pow(10, 38);

    static Golden[] GoldenRows() =>
    [
        new(long.MinValue, 1.5e20, 12345678_900000000, BigInteger.Parse("-1234567890123456789012345678901234567890123456789012345678", Inv), true, "héllo \"q\"\n",
            [0xDE, 0xAD, 0xBE, 0xEF], new DateOnly(2026, 11, 15), 34_200_123_456, 1_794_735_000_500_000, 1_794_735_000_123_456, (14, 3, 14_706_789_000),
            (new DateOnly(2026, 1, 1), new DateOnly(2026, 12, 31)), (1_794_735_000_000_000, null), "POINT(1 2)", "{\"k\":[1,2]}", (7, ["a\"b", "c"]), [1, 2], [(double.NaN, 0)]),
        new(0, -0.0, 0, 1000 * Scale38, false, "", [], new DateOnly(1, 1, 1), 0, -1, MinMicros, (-14, -3, -14_706_000_000), (null, null), (null, 0),
            "GEOMETRYCOLLECTION EMPTY", "null", (null, []), [], []),
        new(null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
        new(42, double.PositiveInfinity, -1, 1, true, "日本語 ✓", [.. Enumerable.Range(0, 256).Select(b => (byte)b)], new DateOnly(9999, 12, 31), 86_399_999_999, MaxMicros, MaxMicros,
            (0, 0, 0), (null, new DateOnly(9999, 12, 31)), (MinMicros + 1, MaxMicros), "LINESTRING(0 0, 1 1)", "[1,{\"a\":\"b\"}]", (-1, ["x"]), [long.MaxValue], [(0.1, null), (1.25, 1_794_735_000_123_456)]),
        new(-7, 0.1, 5 * Scale9 / 10, -Scale38 / 4, false, new string('z', 300), [0x00], new DateOnly(1969, 12, 31), 1, -62_135_596_800_000_000 + 1, -1, (1, -1, 1),
            (new DateOnly(1970, 1, 1), null), (-1, 1), "POLYGON((0 0, 1 0, 1 1, 0 0))", "\"text\"", (0, []), [0, -1], [(-2.5e-300, MinMicros)])
    ];

    static JsonObject GoldenSchema() => Schema(
        Field("i", "INTEGER"), Field("f", "FLOAT"), Field("n", "NUMERIC"), Field("bn", "BIGNUMERIC"), Field("b", "BOOLEAN"), Field("s", "STRING"), Field("y", "BYTES"),
        Field("d", "DATE"), Field("t", "TIME"), Field("dt", "DATETIME"), Field("ts", "TIMESTAMP"), Field("iv", "INTERVAL"),
        Field("rd", "RANGE", change: field => field["rangeElementType"] = new JsonObject { ["type"] = "DATE" }),
        Field("rt", "RANGE", change: field => field["rangeElementType"] = new JsonObject { ["type"] = "TIMESTAMP" }), Field("g", "GEOGRAPHY"), Field("j", "JSON"),
        Field("st", "RECORD", fields: new JsonArray(Field("a", "INTEGER"), Field("b", "STRING", "REPEATED"))), Field("ai", "INTEGER", "REPEATED"),
        Field("as", "RECORD", "REPEATED", new JsonArray(Field("x", "FLOAT"), Field("t", "TIMESTAMP"))));

    // ---- REST, as BigQuery writes it (deliberately not always Varia's canonical text) ----

    static string Fixed6(long micros) => micros % 1_000_000 is var f and not 0 ? "." + Math.Abs(f).ToString("D6", Inv) : "";
    static string RestDate(DateOnly date) => date.ToString("yyyy-MM-dd", Inv);
    static string RestTime(long micros) => TimeOnly.FromTimeSpan(TimeSpan.FromTicks(micros * 10)).ToString("HH:mm:ss", Inv) + Fixed6(micros);
    static string RestDateTime(long micros)
    {
        var instant = DateTime.UnixEpoch.AddTicks(micros * 10);
        return instant.ToString("yyyy-MM-dd'T'HH:mm:ss", Inv) + (instant.Ticks % 10_000_000 is var f and not 0 ? "." + (f / 10).ToString("D6", Inv) : "");
    }
    static string RestDecimal(BigInteger unscaled, int scale)
    {
        var digits = BigInteger.Abs(unscaled).ToString(Inv).PadLeft(scale + 1, '0');
        return (unscaled.Sign < 0 ? "-" : "") + digits[..^scale] + "." + digits[^scale..];
    }
    static string RestInterval((int M, int D, long Micros) v)
    {
        var m = Math.Abs(v.M);
        var t = Math.Abs(v.Micros);
        var seconds = t / 1_000_000;
        var fraction = t % 1_000_000 is var f and not 0 ? "." + f.ToString("D6", Inv).TrimEnd('0') : "";
        return (v.M < 0 ? "-" : "") + (m / 12) + "-" + (m % 12) + " " + v.D + " " + (v.Micros < 0 ? "-" : "") + (seconds / 3600) + ":" + (seconds / 60 % 60) + ":" + (seconds % 60) + fraction;
    }
    static string RestFloat(double value) => double.IsNaN(value) ? "NaN" : double.IsPositiveInfinity(value) ? "Infinity" : double.IsNegativeInfinity(value) ? "-Infinity" : value.ToString("R", Inv);
    static JsonObject V(JsonNode? value) => new() { ["v"] = value };

    static JsonObject RestRow(Golden g) => Row(
        g.I?.ToString(Inv), g.F is { } f ? RestFloat(f) : null, g.N is { } n ? RestDecimal(n, 9) : null, g.Bn is { } bn ? RestDecimal(bn, 38).TrimEnd('0').TrimEnd('.') : null,
        g.B is { } b ? (b ? "true" : "false") : null, g.S, g.Y is { } y ? Convert.ToBase64String(y) : null, g.D is { } d ? RestDate(d) : null, g.T is { } t ? RestTime(t) : null,
        g.Dt is { } dt ? RestDateTime(dt) : null, g.Ts?.ToString(Inv), g.Iv is { } iv ? RestInterval(iv) : null,
        g.Rd is { } rd ? "[" + (rd.Lo is { } lo ? RestDate(lo) : "UNBOUNDED") + ", " + (rd.Hi is { } hi ? RestDate(hi) : "UNBOUNDED") + ")" : null,
        g.Rt is { } rt ? "[" + (rt.Lo?.ToString(Inv) ?? "UNBOUNDED") + ", " + (rt.Hi?.ToString(Inv) ?? "UNBOUNDED") + ")" : null, g.G, g.J,
        g.St is { } st ? new JsonObject { ["f"] = new JsonArray(V(st.A?.ToString(Inv)), V(new JsonArray([.. st.B.Select(item => (JsonNode)V(item))]))) } : null,
        g.Ai is { } ai ? new JsonArray([.. ai.Select(item => (JsonNode)V(item.ToString(Inv)))]) : null,
        g.As is { } items ? new JsonArray([.. items.Select(item => (JsonNode)V(new JsonObject { ["f"] = new JsonArray(V(RestFloat(item.X)), V(item.T?.ToString(Inv))) }))]) : null);

    // ---- Arrow, as Storage Read sends it ----

    static readonly TimestampType Utc = new(TimeUnit.Microsecond, "UTC");
    static readonly TimestampType Civil = new(TimeUnit.Microsecond, (string?)null);
    static readonly StructType DateRange = new([new("start", Date32Type.Default, true), new("end", Date32Type.Default, true)]);
    static readonly StructType TimestampRange = new([new("start", Utc, true), new("end", Utc, true)]);
    static readonly StructType Member = new([new("a", Int64Type.Default, true), new("b", new ListType(new Field("item", StringType.Default, false)), false)]);
    static readonly StructType Point = new([new("x", DoubleType.Default, true), new("t", Utc, true)]);

    static Schema GoldenArrowSchema() => new([
        new("i", Int64Type.Default, true), new("f", DoubleType.Default, true), new("n", new Decimal128Type(38, 9), true), new("bn", new Decimal256Type(76, 38), true),
        new("b", BooleanType.Default, true), new("s", StringType.Default, true), new("y", BinaryType.Default, true), new("d", Date32Type.Default, true),
        new("t", new Time64Type(TimeUnit.Microsecond), true), new("dt", Civil, true), new("ts", Utc, true), new("iv", new IntervalType(IntervalUnit.MonthDayNanosecond), true),
        new("rd", DateRange, true), new("rt", TimestampRange, true), new("g", StringType.Default, true), new("j", StringType.Default, true), new("st", Member, true),
        new("ai", new ListType(new Field("item", Int64Type.Default, false)), true), new("as", new ListType(new Field("item", Point, false)), true)], null);

    static (ArrowBuffer Bitmap, int Nulls) Validity(IReadOnlyList<bool> valid)
    {
        var bitmap = new ArrowBuffer.BitmapBuilder();
        foreach (var item in valid) bitmap.Append(item);
        return (bitmap.Build(), valid.Count(item => !item));
    }

    static IArrowArray Primitive<T>(IArrowType type, IReadOnlyList<T?> values) where T : struct
    {
        var buffer = new ArrowBuffer.Builder<T>();
        foreach (var value in values) buffer.Append(value ?? default);
        var (bitmap, nulls) = Validity([.. values.Select(value => value.HasValue)]);
        return ArrowArrayFactory.BuildArray(new ArrayData(type, values.Count, nulls, 0, [bitmap, buffer.Build()]));
    }

    static IArrowArray Decimals(IArrowType type, int width, IReadOnlyList<BigInteger?> values)
    {
        var buffer = new ArrowBuffer.Builder<byte>();
        foreach (var value in values)
        {
            var bytes = new byte[width];
            if (value is { } number)
            {
                if (number.Sign < 0) System.Array.Fill(bytes, (byte)0xFF);
                if (!number.TryWriteBytes(bytes, out _, isUnsigned: false, isBigEndian: false)) throw new InvalidOperationException("The decimal does not fit.");
            }
            buffer.Append(bytes);
        }
        var (bitmap, nulls) = Validity([.. values.Select(value => value.HasValue)]);
        return ArrowArrayFactory.BuildArray(new ArrayData(type, values.Count, nulls, 0, [bitmap, buffer.Build()]));
    }

    static StringArray Strings(IEnumerable<string?> values)
    {
        var builder = new StringArray.Builder();
        foreach (var value in values) { if (value is null) builder.AppendNull(); else builder.Append(value); }
        return builder.Build();
    }

    static IArrowArray Struct(StructType type, IReadOnlyList<bool> valid, params IArrowArray[] children)
    {
        var (bitmap, nulls) = Validity(valid);
        return new StructArray(type, valid.Count, children, bitmap, nulls);
    }

    static IArrowArray List(IArrowType type, IReadOnlyList<int?> lengths, IArrowArray values)
    {
        var offsets = new ArrowBuffer.Builder<int>();
        var at = 0;
        offsets.Append(0);
        foreach (var length in lengths) { at += length ?? 0; offsets.Append(at); }
        var (bitmap, nulls) = Validity([.. lengths.Select(length => length.HasValue)]);
        return new ListArray(type, lengths.Count, offsets.Build(), values, bitmap, nulls);
    }

    static int? Days(DateOnly? date) => date is { } d ? d.DayNumber - DateOnly.FromDateTime(DateTime.UnixEpoch).DayNumber : null;

    static RecordBatch ArrowBatch(Schema schema, IReadOnlyList<Golden> rows)
    {
        var all = rows.Select(_ => true).ToList();
        var interval = new MonthDayNanosecondIntervalArray.Builder();
        foreach (var row in rows) { if (row.Iv is { } iv) interval.Append(new MonthDayNanosecondInterval(iv.M, iv.D, iv.Micros * 1000)); else interval.AppendNull(); }
        var binary = new BinaryArray.Builder();
        foreach (var row in rows) { if (row.Y is { } y) binary.Append(y.AsSpan()); else binary.AppendNull(); }
        var booleans = new BooleanArray.Builder();
        foreach (var row in rows) { if (row.B is { } b) booleans.Append(b); else booleans.AppendNull(); }
        var members = rows.SelectMany(row => row.St?.B ?? []).ToList();
        var points = rows.SelectMany(row => row.As ?? []).ToList();
        IArrowArray[] columns =
        [
            Primitive(Int64Type.Default, [.. rows.Select(row => row.I)]),
            Primitive(DoubleType.Default, [.. rows.Select(row => row.F)]),
            Decimals(new Decimal128Type(38, 9), 16, [.. rows.Select(row => row.N)]),
            Decimals(new Decimal256Type(76, 38), 32, [.. rows.Select(row => row.Bn)]),
            booleans.Build(),
            Strings(rows.Select(row => row.S)),
            binary.Build(),
            Primitive(Date32Type.Default, [.. rows.Select(row => Days(row.D))]),
            Primitive(new Time64Type(TimeUnit.Microsecond), [.. rows.Select(row => row.T)]),
            Primitive(Civil, [.. rows.Select(row => row.Dt)]),
            Primitive(Utc, [.. rows.Select(row => row.Ts)]),
            interval.Build(),
            Struct(DateRange, [.. rows.Select(row => row.Rd.HasValue)], Primitive(Date32Type.Default, [.. rows.Select(row => Days(row.Rd?.Lo))]), Primitive(Date32Type.Default, [.. rows.Select(row => Days(row.Rd?.Hi))])),
            Struct(TimestampRange, [.. rows.Select(row => row.Rt.HasValue)], Primitive(Utc, [.. rows.Select(row => row.Rt?.Lo)]), Primitive(Utc, [.. rows.Select(row => row.Rt?.Hi)])),
            Strings(rows.Select(row => row.G)),
            Strings(rows.Select(row => row.J)),
            Struct(Member, [.. rows.Select(row => row.St.HasValue)], Primitive(Int64Type.Default, [.. rows.Select(row => row.St?.A)]),
                List(new ListType(new Field("item", StringType.Default, false)), [.. rows.Select(row => (int?)(row.St?.B.Length ?? 0))], Strings(members))),
            List(new ListType(new Field("item", Int64Type.Default, false)), [.. rows.Select(row => row.Ai?.Length)], Primitive(Int64Type.Default, [.. rows.SelectMany(row => row.Ai ?? []).Select(value => (long?)value)])),
            List(new ListType(new Field("item", Point, false)), [.. rows.Select(row => row.As?.Length)],
                Struct(Point, [.. points.Select(_ => true)], Primitive(DoubleType.Default, [.. points.Select(point => (double?)point.X)]), Primitive(Utc, [.. points.Select(point => point.T)])))
        ];
        return new RecordBatch(schema, columns, rows.Count);
    }

    /// <summary>The golden values repeated past the first REST page, and the same rows cut into Arrow batches.</summary>
    static (List<JsonNode> Json, List<RecordBatch> Batches) GoldenResult(int copies, int batchRows)
    {
        var rows = Enumerable.Range(0, copies).SelectMany(_ => GoldenRows()).ToList();
        var schema = GoldenArrowSchema();
        return ([.. rows.Select(row => (JsonNode)RestRow(row))], [.. rows.Chunk(batchRows).Select(chunk => ArrowBatch(schema, chunk))]);
    }

    /// <summary>A simple two-column result of <paramref name="count"/> rows, for the reading checks.</summary>
    static (Jobs Jobs, BigQueryStorageFake Storage) Numbers(int count, int batchRows, Action<Jobs>? change = null)
    {
        var jobs = new Jobs { Schema = Schema(Field("n", "INTEGER"), Field("s", "STRING")), Rows = [.. Enumerable.Range(0, count).Select(i => Row(i.ToString(Inv), "row " + i))], Destination = Destination };
        change?.Invoke(jobs);
        var schema = new Schema([new("n", Int64Type.Default, true), new("s", StringType.Default, true)], null);
        var batches = Enumerable.Range(0, count).Chunk(batchRows)
            .Select(chunk => new RecordBatch(schema, [Primitive(Int64Type.Default, [.. chunk.Select(i => (long?)i)]), Strings(chunk.Select(i => "row " + i))], chunk.Length)).ToList();
        return (jobs, new BigQueryStorageFake(schema, batches));
    }

    static Harness StorageHarness(Jobs jobs, BigQueryStorageFake? storage, ResultStore? store = null)
    {
        var harness = new Harness(jobs, store, storage);
        harness.Service.BigQuery.StorageReadMinBytes = 0;
        return harness;
    }

    static int PageReads(Jobs jobs) => jobs.Reads.Count(uri => uri.Query.Contains("pageToken=", StringComparison.Ordinal));

    static async Task StorageReadAsync(Action<bool, string> check)
    {
        Trace("StorageText");
        StorageText(check);
        Trace("Scanner");
        Scanner(check);
        Trace("StorageGoldenAsync");
        await StorageGoldenAsync(check);
        Trace("StorageSessionAsync");
        await StorageSessionAsync(check);
        Trace("StorageFallbackAsync");
        await StorageFallbackAsync(check);
        Trace("StorageLimitsAsync");
        await StorageLimitsAsync(check);
        Trace("StorageFailuresAsync");
        await StorageFailuresAsync(check);
        Trace("StorageProxyAsync");
        await StorageProxyAsync(check);
    }

    /// <summary>BigQueryText: the writers both readers share, against independently written text.</summary>
    static void StorageText(Action<bool, string> check)
    {
        string Write(Func<byte[], int> write)
        {
            var buffer = new byte[128];
            return Encoding.ASCII.GetString(buffer, 0, write(buffer));
        }
        var intervals = new (int M, int D, long Micros)[] { (14, 3, 14_706_789_000), (-14, -3, -14_706_000_000), (0, 0, 0), (1, -1, 1), (-1, 5, 360_000_000_000_000), (120_000, 3_660_000, -315_576_000_000_000_000) };
        var wrong = intervals.Where(v => Write(b => BigQueryText.Interval(v.M, v.D, v.Micros, b)) != RestInterval(v)).Select(v => Write(b => BigQueryText.Interval(v.M, v.D, v.Micros, b)) + " ≠ " + RestInterval(v)).ToList();
        var parsed = intervals.All(v => BigQueryText.TryParseInterval(Encoding.ASCII.GetBytes(RestInterval(v)), out var m, out var d, out var micros) && (m, d, micros) == (v.M, v.D, v.Micros));
        check(wrong.Count == 0 && parsed && !BigQueryText.TryParseInterval("1-13 0 0:0:0"u8, out _, out _, out _) && !BigQueryText.TryParseInterval("P1Y"u8, out _, out _, out _),
            "INTERVAL text is BigQuery's canonical form both ways, and malformed text is not taken for it: " + string.Join(", ", wrong));
        var decimals = new BigInteger[] { 0, 1, -1, 12345678_900000000, -Scale9 / 2, BigInteger.Parse("99999999999999999999999999999999999999", Inv), -BigInteger.Parse("99999999999999999999999999999999999999", Inv), 10, 100_000_000_000 };
        var mismatched = decimals.Where(d => Write(b => BigQueryText.Decimal((Int128)d, 9, b)) != Write(b => BigQueryText.Decimal(d, 9, b))
            || Write(b => BigQueryText.Decimal(d, 9, b)) != Write(b => BigQueryColumnPlan.CanonicalDecimal(Encoding.ASCII.GetBytes(RestDecimal(d, 9)), b))).Select(d => d.ToString(Inv)).ToList();
        check(mismatched.Count == 0 && Write(b => BigQueryText.Decimal((Int128)12345678_900000000, 9, b)) == "12345678.9" && Write(b => BigQueryText.Decimal(-(BigInteger)1, 38, b)) == "-0." + new string('0', 37) + "1"
            && Write(b => BigQueryText.Decimal((Int128)(-500_000_000), 9, b)) == "-0.5" && Write(b => BigQueryText.Decimal(Int128.MinValue, 0, b)) == Int128.MinValue.ToString(Inv),
            "decimal text from an unscaled integer matches REST's canonical text, through Int128 and BigInteger alike: " + string.Join(", ", mismatched));
        check(Write(b => BigQueryText.Time(34_200_500_000, b)) == "09:30:00.5" && Write(b => BigQueryText.Time(86_399_999_999, b)) == "23:59:59.999999" && Write(b => BigQueryText.Time(0, b)) == "00:00:00"
            && Write(b => BigQueryText.DateTime(-1, b)) == "1969-12-31T23:59:59.999999" && Write(b => BigQueryText.DateTime(MinMicros, b)) == "0001-01-01T00:00:00"
            && Write(b => BigQueryText.Date(-719_162, b)) == "0001-01-01" && Write(b => BigQueryText.Date(2_932_896, b)) == "9999-12-31"
            && Write(b => BigQueryText.Timestamp(MaxMicros, b)) == "9999-12-31 23:59:59.999999 UTC",
            "TIME and DATETIME leave a zero fraction's digits out, DATE and TIMESTAMP span BigQuery's range");
        Func<byte[], int>[] outOfRange = [b => BigQueryText.Date(2_932_897, b), b => BigQueryText.Time(86_400_000_000, b), b => BigQueryText.Timestamp(MaxMicros + 1, b), b => BigQueryText.DateTime(MinMicros - 1, b)];
        check(outOfRange.All(write => { try { write(new byte[64]); return false; } catch (FormatException) { return true; } }), "a value outside its type's range is a read error, not wrapped text");
        var rest = new[] { ("2026-11-15T09:30:00.500000", BigQueryKind.DateTime, "2026-11-15T09:30:00.5"), ("2026-11-15 09:30:00", BigQueryKind.DateTime, "2026-11-15T09:30:00"),
            ("09:30:00.000000", BigQueryKind.Time, "09:30:00"), ("0-0 0 0:0:0", BigQueryKind.Interval, "0-0 0 0:0:0"), ("not a date", BigQueryKind.Date, "not a date") };
        var restWrong = rest.Where(item => Write(b => BigQueryColumnPlan.Temporal(item.Item2, Encoding.ASCII.GetBytes(item.Item1), b)) != item.Item3).Select(item => item.Item1).ToList();
        check(restWrong.Count == 0 && BigQueryColumnPlan.RangeText("[2026-01-01T00:00:00.000000, UNBOUNDED)", BigQueryKind.DateTime) == "[2026-01-01T00:00:00, UNBOUNDED)",
            "REST's date and time text is rewritten as Varia writes it, and text it does not recognise stays as sent: " + string.Join(", ", restWrong));
    }

    /// <summary>GoogleSqlScanner: a top-level ORDER BY, and none hidden in a subquery, window, aggregate, string or comment.</summary>
    static void Scanner(Action<bool, string> check)
    {
        string[] ordered =
        [
            "SELECT * FROM t ORDER BY a", "select a from t order\n  by a desc limit 10", "SELECT a FROM t ORDER /* c */ BY a", "(SELECT a FROM t ORDER BY a)", "((SELECT a FROM t ORDER BY a));",
            "WITH c AS (SELECT 1 a) SELECT a FROM c ORDER BY a", "FROM t |> ORDER BY a", "SELECT ')' AS x FROM t ORDER BY x", "SELECT a FROM t -- note\nORDER BY a",
            "SELECT r'\\' x FROM t ORDER BY x", "SELECT \"\"\"a ( b\"\"\" FROM t ORDER BY 1", "SELECT `weird ( name` FROM t ORDER BY 1", "SELECT 1 AS order_ FROM t ORDER BY order_"
        ];
        string[] unordered =
        [
            "SELECT * FROM t", "SELECT * FROM (SELECT a FROM t ORDER BY a)", "SELECT ARRAY_AGG(a ORDER BY a) FROM t", "SELECT ROW_NUMBER() OVER (ORDER BY a) FROM t",
            "SELECT 'ORDER BY a' FROM t", "SELECT a FROM t -- ORDER BY a", "SELECT a FROM t /* ORDER BY a */", "SELECT a FROM t # ORDER BY a", "SELECT `order` FROM t",
            "SELECT \"\"\"\nORDER BY a\n\"\"\" FROM t", "(SELECT a FROM t ORDER BY a) UNION ALL (SELECT b FROM u)", "SELECT a.order, b FROM t", "SELECT b'ORDER BY' FROM t", "SELECT a FROM t WHERE b IN (SELECT c FROM u ORDER BY c LIMIT 1)"
        ];
        var missed = ordered.Where(sql => !GoogleSqlScanner.HasTopLevelOrderBy(sql)).Concat(unordered.Where(GoogleSqlScanner.HasTopLevelOrderBy)).ToList();
        check(missed.Count == 0, "the backend's scanner finds a top-level ORDER BY and only that one: " + string.Join(" | ", missed));
    }

    /// <summary>The golden check: the same rows through REST and through Storage Read give identical columns and cells.</summary>
    static async Task StorageGoldenAsync(Action<bool, string> check)
    {
        var (rest, batches) = GoldenResult(120, 70);
        var jobs = new Jobs { Schema = GoldenSchema(), Rows = rest, Destination = Destination };
        List<PageCell[]> restRows, arrowRows;
        ResultDescriptor? restSet, arrowSet;
        using (var harness = new Harness(jobs))
        {
            await harness.ConnectAsync();
            var (code, result, message) = await harness.Execute("SELECT * FROM t ORDER BY i");
            restSet = result?.ResultSets.SingleOrDefault();
            restRows = restSet is null ? [] : harness.Rows(restSet);
            check(code == "ok" && PageReads(jobs) > 0, $"without Storage Read the golden result is read through REST pages: {code} {message} {PageReads(jobs)}");
        }
        var storage = new BigQueryStorageFake(GoldenArrowSchema(), batches);
        var arrowJobs = new Jobs { Schema = GoldenSchema(), Rows = rest, Destination = Destination };
        using (var harness = StorageHarness(arrowJobs, storage))
        {
            await harness.ConnectAsync();
            var (code, result, message) = await harness.Execute("SELECT * FROM t ORDER BY i");
            arrowSet = result?.ResultSets.SingleOrDefault();
            arrowRows = arrowSet is null ? [] : harness.Rows(arrowSet);
            check(code == "ok" && storage.Sessions.Count == 1 && PageReads(arrowJobs) == 0 && !Says(result, "could not be read"),
                $"with Storage Read the golden result is read from its destination table, no REST page after the first: {code} {message} {PageReads(arrowJobs)} {Texts(result?.Messages ?? [])}");
        }
        var differences = new List<string>();
        for (var r = 0; r < Math.Min(restRows.Count, arrowRows.Count) && differences.Count < 12; r++)
            for (var c = 0; c < restRows[r].Length; c++)
                if (restRows[r][c].Text != arrowRows[r][c].Text || restRows[r][c].Flags != arrowRows[r][c].Flags)
                    differences.Add(restSet!.Columns[c].Name + "[" + r + "]: REST ‘" + restRows[r][c].Text + "’ Arrow ‘" + arrowRows[r][c].Text + "’");
        var columns = restSet is null || arrowSet is null ? "" : string.Join(",", restSet.Columns.Zip(arrowSet.Columns, (a, b) => a == b ? "" : a.Name).Where(name => name.Length > 0));
        check(restRows.Count == 600 && arrowRows.Count == 600 && differences.Count == 0 && columns == "" && restSet?.RowsRead == arrowSet?.RowsRead,
            $"REST and Arrow reads of the same rows give byte-identical cells for every type: {restRows.Count} {arrowRows.Count} {string.Join("; ", differences)} {columns}");
        string?[] expected = ["-9223372036854775808", "1.5E+20", "12345678.9", "-12345678901234567890.12345678901234567890123456789012345678", "true", "héllo \"q\"\n", "0xDEADBEEF",
            "2026-11-15", "09:30:00.123456", "2026-11-15T09:30:00.5", "2026-11-15 09:30:00.123456 UTC", "1-2 3 4:5:6.789", "[2026-01-01, 2026-12-31)",
            "[2026-11-15 09:30:00.000000 UTC, UNBOUNDED)", "POINT(1 2)", "{\"k\":[1,2]}", "{\"a\":\"7\",\"b\":[\"a\\\"b\",\"c\"]}", "[\"1\",\"2\"]", "[{\"x\":\"NaN\",\"t\":\"1970-01-01 00:00:00.000000 UTC\"}]"];
        var first = arrowRows.Count > 0 ? arrowRows[0].Select(cell => cell.Text).ToArray() : [];
        check(first.SequenceEqual(expected), "the golden row reads as docs/bigquery.md's Types and display says: " + string.Join(" | ", first));
        check(arrowRows.Count > 1 && arrowRows[1][7].Text == "0001-01-01" && arrowRows[1][9].Text == "1969-12-31T23:59:59.999999" && arrowRows[1][11].Text == "-1-2 -3 -4:5:6"
            && arrowRows[1][12].Text == "[UNBOUNDED, UNBOUNDED)" && arrowRows[1][16].Text == "{\"a\":null,\"b\":[]}" && arrowRows.Count > 2 && arrowRows[2].All(cell => cell.Flags == PageReader.Null)
            && arrowRows[3][1].Text == "Infinity" && arrowRows[3][2].Text == "-0.000000001" && arrowRows[3][3].Text == "0." + new string('0', 37) + "1",
            "edge values read the same: the first day, before the epoch, negative intervals, unbounded ranges, empty arrays, nulls and infinity");
    }

    /// <summary>The read session: Arrow, the destination table, one stream for a top-level ORDER BY and four otherwise,
    /// streams appended as they come, and every row stored once.</summary>
    static async Task StorageSessionAsync(Action<bool, string> check)
    {
        var (jobs, storage) = Numbers(5000, 250);
        using (var harness = StorageHarness(jobs, storage))
        {
            await harness.ConnectAsync();
            var (code, result, message) = await harness.Execute("SELECT n, s FROM t");
            var set = result?.ResultSets.Single();
            var request = storage.Sessions.SingleOrDefault();
            var rows = set is null ? [] : harness.Rows(set);
            var numbers = rows.Select(row => long.Parse(row[0].Text!, Inv)).Order().ToList();
            check(code == "ok" && request is { Parent: "projects/varia-emulator", MaxStreamCount: BigQueryService.MaxStreams } && request.ReadSession.Table == "projects/varia-emulator/datasets/_anon0123/tables/anon_result_1"
                && request.ReadSession.DataFormat == Google.Cloud.BigQuery.Storage.V1.DataFormat.Arrow && request.ReadSession.ReadOptions is null && storage.Reads.Count == 4,
                $"an unordered result is read in Arrow from its destination table on up to four streams, billed to the connection's project: {code} {message} {request} {storage.Reads.Count}");
            check(set is { RowsRead: 5000, RowsStored: 5000, Truncated: null, Incomplete: false } && numbers.SequenceEqual(Enumerable.Range(0, 5000).Select(i => (long)i)) && Says(result, "(5000 rows affected)"),
                $"the streams' rows are all stored once, appended as they come: {set?.RowsRead} {set?.RowsStored} {numbers.Count}");
        }
        (jobs, storage) = Numbers(5000, 250);
        using (var harness = StorageHarness(jobs, storage))
        {
            await harness.ConnectAsync();
            var (_, result, _) = await harness.Execute("SELECT n, s FROM t -- latest first\nORDER BY n");
            var set = result?.ResultSets.Single();
            var rows = set is null ? [] : harness.Rows(set);
            check(storage.Sessions.SingleOrDefault()?.MaxStreamCount == 1 && rows.Select(row => row[0].Text).SequenceEqual(Enumerable.Range(0, 5000).Select(i => i.ToString(Inv))),
                $"a top-level ORDER BY reads one stream, so the rows keep their order: {storage.Sessions.SingleOrDefault()?.MaxStreamCount} {rows.Count}");
        }

        // The emulator's shape: each batch a whole stream, schema first.
        (jobs, storage) = Numbers(2000, 300);
        storage.WholeStreams = true;
        using (var harness = StorageHarness(jobs, storage))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n, s FROM t ORDER BY n");
            var rows = result?.ResultSets.Single() is { } set ? harness.Rows(set) : [];
            check(code == "ok" && rows.Select(row => row[0].Text).SequenceEqual(Enumerable.Range(0, 2000).Select(i => i.ToString(Inv)))
                && ArrowColumnPlan.IsSchema(BigQueryStorageFake.SchemaBytes(storage.Schema)) && !ArrowColumnPlan.IsSchema(BigQueryStorageFake.BatchBytes(storage.Batches[0])),
                $"a batch sent as a whole stream (the emulator's shape) reads as one sent alone: {code} {rows.Count}");
        }

        // A result that arrived whole, one under the threshold and a script read through REST, without a session.
        (jobs, storage) = Numbers(300, 100);
        using (var harness = StorageHarness(jobs, storage))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n, s FROM t");
            check(code == "ok" && storage.Sessions.IsEmpty && result?.ResultSets.Single().RowsStored == 300 && !harness.Fake.To(Base + "/jobs/[^/]+").Skip(1).Any(),
                "a result that arrives whole in the first answer is read through REST, with no session and no extra call");
        }
        (jobs, storage) = Numbers(2000, 500, jobs => jobs.TableBytes = 19_000_000);
        using (var harness = StorageHarness(jobs, storage))
        {
            harness.Service.BigQuery.StorageReadMinBytes = 20_000_000;
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n, s FROM t");
            check(code == "ok" && storage.Sessions.IsEmpty && result?.ResultSets.Single().RowsStored == 2000 && PageReads(jobs) > 0,
                "a result under about 20 MB (tables.get's numBytes) is read through REST: a read session costs more than it saves");
            jobs.TableBytes = 25_000_000;
            (code, result, _) = await harness.Execute("SELECT n, s FROM t", args => args["maxRows"] = 1000);
            check(code == "ok" && storage.Sessions.IsEmpty, "only the rows the row limit keeps count toward the threshold");
            (code, result, _) = await harness.Execute("SELECT n, s FROM t");
            check(code == "ok" && storage.Sessions.Count == 1 && result?.ResultSets.Single().RowsStored == 2000, "a result over the threshold is read through Storage Read");
        }
        (jobs, storage) = Numbers(2000, 500, jobs => jobs.StatementType = "SCRIPT");
        using (var harness = StorageHarness(jobs, storage))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("DECLARE x INT64 DEFAULT 1; SELECT n, s FROM t");
            check(code == "ok" && storage.Sessions.IsEmpty && result?.ResultSets.Single().RowsStored == 2000, "a script's rows (its last statement's) are read through REST");
        }

        // More columns than a descriptor holds: only the kept ones are read.
        var wide = Enumerable.Range(0, PageBuilder.MaxColumns + 3).Select(i => Field("c" + i, "INTEGER")).ToArray();
        var wideSchema = new Schema([.. Enumerable.Range(0, PageBuilder.MaxColumns).Select(i => new Apache.Arrow.Field("c" + i, Int64Type.Default, true))], null);
        var wideBatch = new RecordBatch(wideSchema, [.. Enumerable.Range(0, PageBuilder.MaxColumns).Select(_ => Primitive(Int64Type.Default, [.. Enumerable.Range(0, 600).Select(i => (long?)i)]))], 600);
        var wideJobs = new Jobs { Schema = Schema(wide), Rows = [.. Enumerable.Range(0, 600).Select(i => Row([.. Enumerable.Range(0, wide.Length).Select(_ => (JsonNode?)i.ToString(Inv))]))], Destination = Destination };
        var wideStorage = new BigQueryStorageFake(wideSchema, [wideBatch]);
        using (var harness = StorageHarness(wideJobs, wideStorage))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT * FROM wide");
            var selected = wideStorage.Sessions.SingleOrDefault()?.ReadSession.ReadOptions?.SelectedFields;
            check(code == "ok" && selected?.Count == PageBuilder.MaxColumns && selected[0] == "c0" && result?.ResultSets.Single() is { RowsStored: 600 } set && set.Columns.Count == PageBuilder.MaxColumns,
                $"a result wider than a descriptor reads only the columns it keeps: {selected?.Count}");
        }
    }

    static RpcException Rpc(StatusCode code, string detail) => new(new Status(code, detail));

    /// <summary>The REST fallbacks: API off and no permission (said once, not asked again on the connection), unreachable
    /// (said once, asked again), a refusal, and an Arrow schema that does not match.</summary>
    static async Task StorageFallbackAsync(Action<bool, string> check)
    {
        var cases = new (string Name, Exception Fault, string Says, bool Lasting)[]
        {
            ("disabled", Rpc(StatusCode.PermissionDenied, "BigQuery Storage API has not been used in project varia-emulator before or it is disabled. Enable it by visiting ... SERVICE_DISABLED"),
                "the BigQuery Storage API is not enabled in project varia-emulator", true),
            ("permission", Rpc(StatusCode.PermissionDenied, "Permission denied: bigquery.readsessions.create"), "bigquery.readsessions.create, which the BigQuery Read Session User role grants", true),
            ("unreachable", Rpc(StatusCode.Unavailable, "failed to connect to all addresses"), "could not reach the BigQuery Storage API", false),
            ("refused", Rpc(StatusCode.InvalidArgument, "Table type ANONYMOUS not supported"), "could not read this result in project varia-emulator", false)
        };
        foreach (var (name, fault, says, lasting) in cases)
        {
            var (jobs, storage) = Numbers(1500, 500);
            storage.SessionFault = _ => fault;
            using var harness = StorageHarness(jobs, storage);
            await harness.ConnectAsync();
            var (code, result, message) = await harness.Execute("SELECT n, s FROM t");
            var sessions = storage.Sessions.Count;
            var (second, again, _) = await harness.Execute("SELECT n, s FROM t");
            var told = (result?.Messages ?? []).Count(entry => entry.Text.Contains(says, StringComparison.Ordinal));
            var retold = (again?.Messages ?? []).Count(entry => entry.Text.Contains(says, StringComparison.Ordinal));
            check(code == "ok" && second == "ok" && result?.ResultSets.Single() is { RowsStored: 1500, Truncated: null } && again?.ResultSets.Single().RowsStored == 1500 && told == 1 && retold == 0
                && result!.Messages.Single(entry => entry.Text.Contains(says, StringComparison.Ordinal)).Text.StartsWith("Large results are read through the BigQuery API, which is slower: ", StringComparison.Ordinal)
                && sessions == (name == "unreachable" ? 2 : 1) && storage.Sessions.Count == sessions + (lasting ? 0 : name == "unreachable" ? 2 : 1),
                $"Storage Read {name}: the result is read through REST, Messages says why once per connection, and the connection {(lasting ? "stops asking" : "asks again")}: {code} {message} {sessions} {storage.Sessions.Count} {told} {retold} {Texts(result?.Messages ?? [])}");
        }

        var (mismatchJobs, mismatch) = Numbers(1500, 500);
        mismatch.SessionSchema = new Schema([new("other", Int64Type.Default, true), new("s", StringType.Default, true)], null);
        using (var harness = StorageHarness(mismatchJobs, mismatch))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n, s FROM t");
            check(code == "ok" && result?.ResultSets.Single().RowsStored == 1500 && mismatch.Reads.IsEmpty && Says(result, "could not read this result"),
                "a session whose Arrow columns are not the result's is not read; REST reads the result");
        }

        // Emulator mode reads through Storage Read only with the emulator's gRPC port named, and only a loopback one.
        var emulator = new BigQueryEnvironment(new Uri("http://127.0.0.1:9050/"), new BigQueryFake().Factory, new SubjectTokens([]));
        check(!emulator.StorageRead && (emulator with { StorageEndpoint = new Uri("http://127.0.0.1:9060/") }).StorageRead && BigQueryEnvironment.Production().StorageRead,
            "Storage Read is on against Google and, in emulator mode, only with the emulator's gRPC port");
        check(BigQueryService.StreamCount(BigQueryEnvironment.Production(), ordered: false) == BigQueryService.MaxStreams && BigQueryService.StreamCount(BigQueryEnvironment.Production(), ordered: true) == 1
            && BigQueryService.StreamCount(emulator with { StorageEndpoint = new Uri("http://127.0.0.1:9060/") }, ordered: false) == 1,
            "a session asks Google for up to four streams unless ordered, and the emulator (which serves one) for one");
        var refusedEndpoint = false;
        try { BigQueryEnvironment.EmulatorEndpoint("http://emulator.example.com:9060", "VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT", 9060); }
        catch (InvalidOperationException error) { refusedEndpoint = error.Message.StartsWith("VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT must be a loopback", StringComparison.Ordinal); }
        check(refusedEndpoint && BigQueryEnvironment.EmulatorEndpoint("http://127.0.0.1:9060", "VARIA_TEST_BIGQUERY_STORAGE_ENDPOINT", 9060)?.Port == 9060,
            "the emulator's gRPC endpoint is honoured only as a loopback http address");
    }

    /// <summary>The row limit and the budget stop a Storage Read as they stop REST's, and every charge is given back.</summary>
    static async Task StorageLimitsAsync(Action<bool, string> check)
    {
        var (jobs, storage) = Numbers(5000, 250);
        using (var harness = StorageHarness(jobs, storage))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n, s FROM t ORDER BY n", args => args["maxRows"] = 700);
            var set = result?.ResultSets.Single();
            var rows = set is null ? [] : harness.Rows(set);
            check(code == "ok" && set is { RowsRead: 5000, RowsStored: 700, Truncated: "rowLimit" } && rows[^1][0].Text == "699" && storage.Reads.Count == 1
                && Says(result, "Results were truncated by display limits."),
                $"the row limit stops a Storage Read, and the rows past it are counted from BigQuery's total: {set?.RowsRead} {set?.RowsStored} {set?.Truncated}");
            harness.Service.Results.Release([.. result!.ResultSets.Select(item => item.ResultId)]);
            check(harness.Service.Results.UsedBytes == 0, "a stopped read gives back every batch's charge: " + harness.Service.Results.UsedBytes);
        }
        (jobs, storage) = Numbers(20000, 500);
        using (var harness = StorageHarness(jobs, storage, new ResultStore(256 * 1024, 128 * 1024)))
        {
            await harness.ConnectAsync();
            var (code, result, message) = await harness.Execute("SELECT n, s FROM t");
            var set = result?.ResultSets.Single();
            check(code == "ok" && result?.Status == "completed" && set is { RowsRead: 20000, Truncated: "queryBudget" } && set.RowsStored is > 0 and < 20000
                && Says(result, "Results were truncated because the result memory budget"),
                $"the result budget stops a Storage Read, the query completes, and the rows are counted: {code} {message} {set?.RowsStored} {set?.Truncated}");
            check(harness.Service.Results.UsedBytes <= 256 * 1024, "the batches being decoded stay within the budget: " + harness.Service.Results.UsedBytes);
            harness.Service.Results.Release([.. result!.ResultSets.Select(item => item.ResultId)]);
            check(harness.Service.Results.UsedBytes == 0, "a budget-stopped read gives back every batch's charge: " + harness.Service.Results.UsedBytes);
        }
    }

    /// <summary>A stream that fails transiently is read again from its offset; one that fails for good fails the query.</summary>
    static async Task StorageFailuresAsync(Action<bool, string> check)
    {
        var (jobs, storage) = Numbers(5000, 250);
        var failed = 0;
        storage.ReadFault = (request, index) => index == 3 && request.Offset == 0 && Interlocked.Increment(ref failed) <= 2 ? Rpc(StatusCode.Unavailable, "RST_STREAM") : null;
        using (var harness = StorageHarness(jobs, storage))
        {
            await harness.ConnectAsync();
            var (code, result, message) = await harness.Execute("SELECT n, s FROM t");
            var set = result?.ResultSets.Single();
            var numbers = set is null ? [] : harness.Rows(set).Select(row => long.Parse(row[0].Text!, Inv)).Order().ToList();
            var resumed = storage.Reads.Where(request => request.Offset > 0).ToList();
            check(code == "ok" && set is { RowsStored: 5000 } && numbers.SequenceEqual(Enumerable.Range(0, 5000).Select(i => (long)i)) && resumed.Count == 2 && resumed.All(request => request.Offset == 750),
                $"a stream cut off mid-read is read again from the rows already queued, and no row is stored twice: {code} {message} {set?.RowsStored} {string.Join(",", resumed.Select(r => r.Offset))}");
        }
        (jobs, storage) = Numbers(3000, 250);
        storage.ReadFault = (_, index) => index == 2 ? Rpc(StatusCode.PermissionDenied, "Access Denied: Table anon_result_1 ya29.abcdefghijklmnop") : null;
        using (var harness = StorageHarness(jobs, storage))
        {
            await harness.ConnectAsync();
            var (code, result, message) = await harness.Execute("SELECT n, s FROM t");
            check(code == "ok" && result is { Status: "failed", Error.Code: "BACKEND_ERROR" } && result.Error!.Message.StartsWith("Reading the result through the BigQuery Storage API failed: Access Denied", StringComparison.Ordinal)
                && !result.Error!.Message.Contains("ya29.", StringComparison.Ordinal) && result.ResultSets.Single().Incomplete,
                $"a stream that fails for good fails the query with Google's words, tokens redacted, and its set marked incomplete: {code} {message} {result?.Status} {result?.Error?.Message}");
        }
        (jobs, storage) = Numbers(3000, 250);
        storage.ReadFault = (_, _) => Rpc(StatusCode.Unavailable, "unreachable");
        using (var harness = StorageHarness(jobs, storage))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n, s FROM t");
            check(code == "ok" && result is { Status: "failed", Error.Code: "CONNECTION_LOST" } && storage.Reads.Count == BigQueryService.MaxStreams * harness.Service.BigQuery.ReadAttempts,
                $"a stream that stays unreachable is tried a bounded number of times, then fails as the network: {result?.Error?.Code} {storage.Reads.Count}");
        }

        // A column whose Arrow type is not its kind's reads as NULL with the read-error flag, and one message names it.
        var schema = new Schema([new("n", DoubleType.Default, true), new("s", StringType.Default, true)], null);
        var batches = Enumerable.Range(0, 1200).Chunk(400).Select(chunk => new RecordBatch(schema, [Primitive(DoubleType.Default, [.. chunk.Select(i => (double?)i)]), Strings(chunk.Select(i => "r" + i))], chunk.Length)).ToList();
        var typedJobs = new Jobs { Schema = Schema(Field("n", "INTEGER"), Field("s", "STRING")), Rows = [.. Enumerable.Range(0, 1200).Select(i => Row(i.ToString(Inv), "r" + i))], Destination = Destination };
        using (var harness = StorageHarness(typedJobs, new BigQueryStorageFake(schema, batches)))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n, s FROM t");
            var rows = result?.ResultSets.Single() is { } set ? harness.Rows(set) : [];
            check(code == "ok" && rows.Count == 1200 && rows.All(row => row[0].Flags == (PageReader.Null | PageReader.Error) && row[1].Text is not null)
                && result!.Messages.Count(entry => entry.Text.Contains("could not be read", StringComparison.Ordinal)) == 1,
                "a value Arrow sends in a type Varia cannot read is NULL with the read-error flag, and one message names its column");
        }

        // Stop during a Storage Read cancels the streams.
        (jobs, storage) = Numbers(5000, 100);
        var reading = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        storage.ReadFault = (_, index) =>
        {
            if (index != 1) return null;
            reading.TrySetResult();
            hold.Task.Wait(TimeSpan.FromSeconds(30));
            return null;
        };
        using (var harness = StorageHarness(jobs, storage))
        {
            await harness.ConnectAsync();
            var args = harness.Query("SELECT n, s FROM t");
            var running = harness.Call("query.execute", args);
            await reading.Task.WaitAsync(TimeSpan.FromSeconds(30));
            var (cancelCode, _, _) = await harness.Call("query.cancel", new JsonObject { ["queryId"] = args["queryId"]!.GetValue<string>() });
            hold.TrySetResult();
            var (code, value, _) = await running.WaitAsync(TimeSpan.FromSeconds(30));
            var result = value as QueryResult;
            check(cancelCode == "ok" && code == "ok" && result?.Status == "cancelled" && result.ResultSets.All(set => set.Incomplete || set.RowsStored < 5000),
                $"Stop during a Storage Read ends it as cancelled: {cancelCode} {code} {result?.Status}");
        }
    }

    /// <summary>The proxy check (decision 19): the Storage Read channel goes through the system proxy with CONNECT, as
    /// Google's endpoint needs TLS, and an unreachable proxy is a REST fallback, not a failed query.</summary>
    static async Task StorageProxyAsync(Action<bool, string> check)
    {
        using (var handler = GrpcStorageRead.Handler(null))
            check(handler.UseProxy && ReferenceEquals(handler.Proxy, HttpClient.DefaultProxy) && handler.EnableMultipleHttp2Connections,
                "the Storage Read channel uses the system proxy (HttpClient.DefaultProxy) and the platform's certificate store");
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var seen = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var serve = Task.Run(async () =>
        {
            using var client = await listener.AcceptTcpClientAsync();
            var stream = client.GetStream();
            var buffer = new byte[4096];
            var text = new StringBuilder();
            while (!text.ToString().Contains("\r\n\r\n", StringComparison.Ordinal) && await stream.ReadAsync(buffer) is var read and > 0) text.Append(Encoding.ASCII.GetString(buffer, 0, read));
            seen.TrySetResult(text.ToString());
            await stream.WriteAsync("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"u8.ToArray());
        });
        Exception? failure = null;
        using (var storage = new GrpcStorageRead(GrpcStorageRead.GoogleEndpoint, null, new WebProxy(new Uri("http://127.0.0.1:" + port.ToString(Inv)))))
        {
            using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(20));
            try { await storage.CreateReadSessionAsync(new Google.Cloud.BigQuery.Storage.V1.CreateReadSessionRequest { Parent = "projects/varia-emulator" }, limit.Token); }
            catch (Exception error) { failure = error; }
        }
        var request = await seen.Task.WaitAsync(TimeSpan.FromSeconds(20));
        listener.Stop();
        await serve.WaitAsync(TimeSpan.FromSeconds(20));
        check(request.StartsWith("CONNECT bigquerystorage.googleapis.com:443 HTTP/1.1\r\n", StringComparison.Ordinal),
            "Storage Read goes through an HTTP proxy with CONNECT to Google's endpoint: " + request.Split("\r\n")[0]);
        check(failure is not null && BigQueryService.Fallback(failure, "varia-emulator")?.Reason == "unreachable",
            $"a proxy that refuses the tunnel is the unreachable fallback (REST reads the result): {failure?.GetType().Name} {(failure as RpcException)?.StatusCode}");
    }
}
