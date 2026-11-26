using System.Collections.Concurrent;
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
        Trace("StoreProbe");
        StoreProbe(check);
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
        Trace("StorageEdgesAsync");
        await StorageEdgesAsync(check);
    }

    /// <summary>The BigQuery checks never read the machine's memory load (docs/testing.md): with the real probe, a busy machine
    /// past its 90 % threshold truncated every result, and Storage Read checks failed as fallbacks, empty sets and timeouts.</summary>
    static void StoreProbe(Action<bool, string> check)
    {
        using (var harness = new Harness(new Jobs()))
            check(!harness.Service.Results.ChecksSystemMemory && harness.Service.Results.GlobalBytes >= ResultStore.MinBytes,
                "the BigQuery execution harness stores results under the machine's budget without the memory-load probe");
        var folder = Path.Combine(GoldenText.Repository(), "backend", "Varia.Backend.Tests");
        var probing = Directory.GetFiles(folder, "BigQuery*.cs").SelectMany(file => File.ReadLines(file).Select((line, index) => (file, line, index)))
            .Where(item => item.line.Contains("new SqlService(", StringComparison.Ordinal) && !item.line.Contains("CheckStores.Unprobed()", StringComparison.Ordinal))
            .Select(item => Path.GetFileName(item.file) + ":" + (item.index + 1)).ToList();
        check(probing.Count == 0, "every BigQuery check's SqlService gets a store without the memory-load probe (CheckStores.Unprobed): " + string.Join(", ", probing));
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
            "SELECT r'\\\\' x FROM t ORDER BY x", "SELECT \"\"\"a ( b\"\"\" FROM t ORDER BY 1", "SELECT `weird ( name` FROM t ORDER BY 1", "SELECT 1 AS order_ FROM t ORDER BY order_",
            // A backslash keeps the quote after it in a raw string too; pipe syntax orders through a grouping's DESC.
            "SELECT r'x\\'' AS s, a FROM t ORDER BY a", "SELECT r'''a\\'''' , a FROM t ORDER BY a", "FROM t |> AGGREGATE SUM(v) AS s GROUP BY k DESC",
            "FROM t |> AGGREGATE SUM(v) AS s ASC GROUP BY k", "(SELECT a FROM t ORDER BY a); -- done", "SELECT a FROM t ORDER BY a; /* done */ ;",
            "WITH c AS (SELECT 1 a) (SELECT a FROM c ORDER BY a)", "WITH c AS (SELECT 1 a) ((SELECT a FROM c ORDER BY a))",
            // LIMIT, OFFSET and pipe operators keep a parenthesised query's order.
            "(SELECT x FROM t ORDER BY x) LIMIT 1000000", "(SELECT x FROM t ORDER BY x) LIMIT 10 OFFSET 5", "WITH a AS (SELECT 1 x) (SELECT x FROM a ORDER BY x) LIMIT 100",
            "((SELECT x FROM t) ORDER BY x) LIMIT 5", "(FROM t |> ORDER BY x) |> LIMIT 100", "(SELECT x FROM t ORDER BY x) |> SELECT x",
            // A first set-operation branch's own ORDER BY counts too: one stream is only slower.
            "(SELECT a FROM t ORDER BY a) UNION ALL (SELECT b FROM u)"
        ];
        string[] unordered =
        [
            "SELECT * FROM t", "SELECT * FROM (SELECT a FROM t ORDER BY a)", "SELECT ARRAY_AGG(a ORDER BY a) FROM t", "SELECT ROW_NUMBER() OVER (ORDER BY a) FROM t",
            "SELECT 'ORDER BY a' FROM t", "SELECT a FROM t -- ORDER BY a", "SELECT a FROM t /* ORDER BY a */", "SELECT a FROM t # ORDER BY a", "SELECT `order` FROM t",
            "SELECT \"\"\"\nORDER BY a\n\"\"\" FROM t", "SELECT (a + b) * (SELECT MAX(c) FROM u ORDER BY 1) FROM t", "SELECT a.order, b FROM t", "SELECT b'ORDER BY' FROM t", "SELECT a FROM t WHERE b IN (SELECT c FROM u ORDER BY c LIMIT 1)",
            "SELECT ROW_NUMBER() OVER (ORDER BY a DESC) FROM t", "WITH c AS (SELECT a FROM t ORDER BY a) SELECT a FROM c", "SELECT a FROM t UNION ALL (SELECT b FROM u ORDER BY b)",
            "SELECT 'desc' FROM t", "SELECT r'a\\' ORDER BY' FROM t"
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
        // The read bench's REST fake serializes each page's rows once and reuses the text: the same cells as pages built anew.
        var cached = new Jobs { Schema = GoldenSchema(), Rows = rest, Destination = Destination, PageCap = 70, CacheRows = true };
        var sameCells = true;
        for (var read = 0; read < 2; read++)
        {
            using var harness = new Harness(cached);
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT * FROM t ORDER BY i");
            var rows = result?.ResultSets.SingleOrDefault() is { } set ? harness.Rows(set) : [];
            sameCells &= code == "ok" && rows.Count == restRows.Count
                && rows.Zip(restRows).All(pair => pair.First.Zip(pair.Second).All(cells => cells.First.Text == cells.Second.Text && cells.First.Flags == cells.Second.Flags));
        }
        check(sameCells && PageReads(cached) > 2, $"REST pages whose rows the fake serialized once read the same cells, twice over: {PageReads(cached)}");
        check(storage.Asked == Apache.Arrow.Ipc.CompressionCodecType.Zstd && storage.Sessions.Single().ReadSession.ReadOptions.ArrowSerializationOptions.BufferCompression
            == Google.Cloud.BigQuery.Storage.V1.ArrowSerializationOptions.Types.CompressionCodec.Zstd, "the read session asks for Zstandard buffer compression");
        // Batches sent uncompressed (an endpoint that ignores the option) or with LZ4 read the same as the Zstandard ones.
        foreach (var (name, ignore, codec) in new[] { ("uncompressed", true, (Apache.Arrow.Ipc.CompressionCodecType?)null), ("LZ4", false, Apache.Arrow.Ipc.CompressionCodecType.Lz4Frame) })
        {
            var other = new BigQueryStorageFake(GoldenArrowSchema(), batches) { IgnoreCompression = ignore, Compression = codec };
            using var harness = StorageHarness(new Jobs { Schema = GoldenSchema(), Rows = rest, Destination = Destination }, other);
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT * FROM t ORDER BY i");
            var rows = result?.ResultSets.SingleOrDefault() is { } set ? harness.Rows(set) : [];
            var same = code == "ok" && other.Sessions.Count == 1 && rows.Count == arrowRows.Count
                && rows.Zip(arrowRows).All(pair => pair.First.Zip(pair.Second).All(cell => cell.First.Text == cell.Second.Text && cell.First.Flags == cell.Second.Flags));
            check(same, $"{name} batches read the same cells as Zstandard ones: {code} {rows.Count}");
        }
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
                && request.ReadSession.DataFormat == Google.Cloud.BigQuery.Storage.V1.DataFormat.Arrow && request.ReadSession.ReadOptions.SelectedFields.Count == 0 && storage.Reads.Count == 4,
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
                && sessions == (name == "unreachable" ? 2 : 1) && storage.Sessions.Count == sessions + (lasting || name == "unreachable" ? 0 : 1),
                $"Storage Read {name}: the result is read through REST, Messages says why once per connection, and the connection {(lasting ? "stops asking" : name == "unreachable" ? "pauses" : "asks again")}: {code} {message} {sessions} {storage.Sessions.Count} {told} {retold} {Texts(result?.Messages ?? [])}");
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
            var (code, result, message) = await harness.Execute("SELECT n, s FROM t", Memory);
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
        storage.ReadFault = (_, index) => index == 2 ? Rpc(StatusCode.FailedPrecondition, "Read session expired: Table anon_result_1 ya29.abcdefghijklmnop") : null;
        using (var harness = StorageHarness(jobs, storage))
        {
            await harness.ConnectAsync();
            var (code, result, message) = await harness.Execute("SELECT n, s FROM t");
            check(code == "ok" && result is { Status: "failed", Error.Code: "BACKEND_ERROR" } && result.Error!.Message.StartsWith("Reading the result through the BigQuery Storage API failed: Read session expired", StringComparison.Ordinal)
                && !result.Error!.Message.Contains("ya29.", StringComparison.Ordinal) && result.ResultSets.Single().Incomplete,
                $"a stream that fails for good fails the query with Google's words, tokens redacted, and its set marked incomplete: {code} {message} {result?.Status} {result?.Error?.Message}");
        }
        (jobs, storage) = Numbers(3000, 250);
        storage.ReadFault = (_, _) => Rpc(StatusCode.Unavailable, "unreachable");
        using (var harness = StorageHarness(jobs, storage))
        {
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n, s FROM t");
            check(code == "ok" && result is { Status: "failed", Error.Code: "CONNECTION_LOST" } 
                // The first stream to give up ends the read, so the others may stop before their last attempt.
                && storage.Reads.Count >= harness.Service.BigQuery.ReadAttempts && storage.Reads.Count <= BigQueryService.MaxStreams * harness.Service.BigQuery.ReadAttempts,
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

    /// <summary>The proxy check: the Storage Read channel goes through the system proxy with CONNECT, as
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

    /// <summary>The edges an adversarial review found: an endpoint that cannot be reached through the real channel (refused
    /// or silent) falls back within one call's limit and pauses the connection; a disposed client, a cancelled call and a
    /// failed jobs.get leave the result to REST; one stream's failure ends the read without waiting for the others;
    /// concurrent reservations never pass the query's budget; and malformed input never throws where it should not.</summary>
    static async Task StorageEdgesAsync(Action<bool, string> check)
    {
        check(GrpcStorageRead.Settings().CreateReadSessionSettings?.Retry is null,
            "CreateReadSession runs without the library's own retry, so an unreachable endpoint fails within Varia's call limit");

        // The real gRPC channel against a closed loopback port and against a listener that never answers.
        var closed = new TcpListener(IPAddress.Loopback, 0);
        closed.Start();
        var closedPort = ((IPEndPoint)closed.LocalEndpoint).Port;
        closed.Stop();
        var silent = new TcpListener(IPAddress.Loopback, 0);
        silent.Start();
        var silentPort = ((IPEndPoint)silent.LocalEndpoint).Port;
        var held = new ConcurrentQueue<TcpClient>();
        var accepting = Task.Run(async () =>
        {
            try { while (true) held.Enqueue(await silent.AcceptTcpClientAsync()); }
            catch (Exception error) when (error is SocketException or ObjectDisposedException) { }
        });
        try
        {
            foreach (var (name, port) in new[] { ("refused", closedPort), ("silent", silentPort) })
            {
                var (jobs, _) = Numbers(1500, 500);
                using var harness = new Harness(jobs, environment: settings => settings with { StorageEndpoint = new Uri("http://127.0.0.1:" + port.ToString(Inv) + "/") });
                harness.Service.BigQuery.StorageReadMinBytes = 0;
                harness.Service.BigQuery.CallLimit = TimeSpan.FromSeconds(3);
                await harness.ConnectAsync();
                var (code, result, message) = await harness.Execute("SELECT n, s FROM t").WaitAsync(TimeSpan.FromSeconds(60));
                var (again, second, _) = await harness.Execute("SELECT n, s FROM t").WaitAsync(TimeSpan.FromSeconds(60));
                check(code == "ok" && result?.ResultSets.Single().RowsStored == 1500 && Says(result, "could not reach the BigQuery Storage API")
                    && again == "ok" && second?.ResultSets.Single().RowsStored == 1500 && harness.Service.BigQuery.StorageSessions == 0,
                    $"a Storage endpoint that is {name} falls back to REST through the real channel, and the connection pauses Storage Read: {code} {message} {Texts(result?.Messages ?? [])}");
            }
        }
        finally
        {
            silent.Stop();
            await accepting.WaitAsync(TimeSpan.FromSeconds(20));
            foreach (var client in held) client.Dispose();
        }

        // The pause ends: a later query asks again.
        {
            var (jobs, storage) = Numbers(1500, 500);
            storage.SessionFault = _ => Rpc(StatusCode.Unavailable, "failed to connect to all addresses");
            using var harness = StorageHarness(jobs, storage);
            harness.Service.BigQuery.UnreachablePause = TimeSpan.Zero;
            await harness.ConnectAsync();
            await harness.Execute("SELECT n, s FROM t");
            var first = storage.Sessions.Count;
            await harness.Execute("SELECT n, s FROM t");
            check(first == 2 && storage.Sessions.Count == 4, $"once the pause after an unreachable endpoint ends, Storage Read is tried again: {first} {storage.Sessions.Count}");
        }

        // A call cancelled by the library (not by Stop), a disposed client and a failed jobs.get each leave the result to REST.
        foreach (var (name, fault, says) in new (string, Exception, string)[]
        {
            ("a call the library cancelled", Rpc(StatusCode.Cancelled, "Call canceled by the client."), "could not reach the BigQuery Storage API"),
            ("a disposed client", new ObjectDisposedException("GrpcChannel"), "could not read this result")
        })
        {
            var (jobs, storage) = Numbers(1500, 500);
            storage.SessionFault = _ => fault;
            using var harness = StorageHarness(jobs, storage);
            await harness.ConnectAsync();
            var (code, result, message) = await harness.Execute("SELECT n, s FROM t");
            check(code == "ok" && result?.ResultSets.Single().RowsStored == 1500 && Says(result, says), $"{name} while opening a session leaves the result to REST: {code} {message}");
        }
        {
            var (jobs, storage) = Numbers(1500, 500);
            using var harness = StorageHarness(jobs, storage);
            await harness.ConnectAsync();
            // Only the decision's jobs.get fails: the summary's, read before the rows, answers first.
            var failed = 0;
            var denied = new BigQueryFake.Reply(403, "{\"error\":{\"code\":403,\"message\":\"Access Denied\",\"errors\":[{\"reason\":\"accessDenied\",\"message\":\"Access Denied\"}]}}");
            harness.Fake.On("GET", Base + "/jobs/[^/]+", request => Interlocked.Increment(ref failed) == 2 ? denied : jobs.Get(request));
            var (code, result, message) = await harness.Execute("SELECT n, s FROM t");
            check(code == "ok" && result is { Status: "completed" } && result.ResultSets.Single().RowsStored == 1500 && storage.Sessions.IsEmpty && failed == 2,
                $"a jobs.get that fails while deciding on Storage Read leaves the result to REST: {code} {message}");
        }

        // One stream fails for good while the others are still reading: the query fails without waiting for them.
        {
            var (jobs, storage) = Numbers(8000, 250);
            var never = new TaskCompletionSource();
            storage.ReadFault = (request, index) => request.ReadStream.EndsWith("/0", StringComparison.Ordinal) && index == 1 ? Rpc(StatusCode.InvalidArgument, "bad stream") : null;
            storage.ReadWait = (request, index, token) => !request.ReadStream.EndsWith("/0", StringComparison.Ordinal) && index >= 2 ? never.Task.WaitAsync(token) : Task.CompletedTask;
            var store = new ResultStore(1L << 30, 1L << 29);
            using var harness = StorageHarness(jobs, storage, store);
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n, s FROM t").WaitAsync(TimeSpan.FromSeconds(60));
            check(result is { Status: "failed", Error.Code: "BACKEND_ERROR" },
                $"one stream's failure fails the read at once, while the other streams are still reading: {code} {result?.Status} {result?.Error?.Code} {store.UsedBytes}");
        }

        // Concurrent reservations against one query never pass its half of the budget.
        {
            var store = new ResultStore(1L << 30, 10_000);
            var budget = store.BeginQuery("edges");
            var over = 0;
            var holders = 0;
            // Holders of 1,000 bytes on every core against a 10,000-byte query limit: only ten fit at once.
            Parallel.For(0, 64, new ParallelOptions { MaxDegreeOfParallelism = 64 }, _ =>
            {
                for (var i = 0; i < 2000; i++)
                {
                    if (!store.TryReserve(budget, 1_000, false, out TruncationReason _)) continue;
                    if (Interlocked.Increment(ref holders) > 10) Interlocked.Exchange(ref over, 1);
                    Thread.SpinWait(50);
                    Interlocked.Decrement(ref holders);
                    store.Return(budget, 1_000);
                }
            });
            check(over == 0 && budget.UsedBytes == 0 && store.UsedBytes == 0, "concurrent reservations against one query never pass its half of the budget, and all come back");
        }

        // Malformed input: an IPC header whose offsets overflow is not a schema; a long unreadable DATE inside a STRUCT is
        // copied as sent rather than failing the query.
        byte[] overflow = [0xFF, 0xFF, 0xFF, 0xFF, 0x08, 0, 0, 0, 0xFE, 0xFF, 0xFF, 0x7F, 0, 0, 0, 0];
        bool schema;
        try { schema = ArrowColumnPlan.IsSchema(overflow); }
        catch (ArgumentOutOfRangeException) { schema = true; }
        check(!schema, "an IPC message whose offsets overflow is not taken for a schema and does not throw");
        {
            var longText = new string('x', 2000);
            var jobs = new Jobs
            {
                Schema = Schema(Field("st", "RECORD", fields: new JsonArray(Field("d", "DATE")))),
                Rows = [Row(new JsonObject { ["f"] = new JsonArray(new JsonObject { ["v"] = longText }) })]
            };
            using var harness = new Harness(jobs);
            await harness.ConnectAsync();
            var (code, result, message) = await harness.Execute("SELECT st FROM t");
            var cell = result?.ResultSets.Single() is { } set ? harness.Rows(set)[0][0].Text : null;
            check(code == "ok" && cell == "{\"d\":\"" + longText + "\"}", $"a long unreadable DATE inside a STRUCT is copied as sent: {code} {message} {cell?.Length}");
        }

        // A sign-in failure inside the channel (a refused token refresh, status Internal with the cause attached) is the
        // sign-in error REST gives, never retried, and never a Storage fallback; Google's own refusals map as REST's do.
        var refresh = new RpcException(new Status(StatusCode.Internal, "Error starting gRPC call.", new Google.Apis.Auth.OAuth2.Responses.TokenResponseException(
            new Google.Apis.Auth.OAuth2.Responses.TokenErrorResponse { Error = "invalid_grant", ErrorDescription = "reauth related error" })));
        check(BigQueryService.ReadFailure(refresh, "varia-emulator").Code == "AUTH_EXPIRED" && !BigQueryService.TransientRead(refresh, CancellationToken.None)
            && BigQueryService.Fallback(refresh, "varia-emulator") is null && BigQueryService.Fallback(Rpc(StatusCode.Unauthenticated, "expired"), "varia-emulator") is null
            && BigQueryService.ReadFailure(Rpc(StatusCode.Unauthenticated, "expired"), "varia-emulator").Code == "AUTH_EXPIRED"
            && BigQueryService.ReadFailure(Rpc(StatusCode.PermissionDenied, "no getData"), "varia-emulator").Code == "PERMISSION_DENIED"
            && BigQueryService.TransientRead(Rpc(StatusCode.Internal, "RST_STREAM"), CancellationToken.None),
            "a refused token refresh inside the channel is AUTH_EXPIRED and not retried; Unauthenticated and PermissionDenied map as REST's do");

        // VPC Service Controls guards the Storage API as it does REST: its refusal, in the message or in an ErrorInfo trailer,
        // is no missing read-session permission. A refused name that merely spells the reason is not one.
        var perimeterDetail = Rpc(StatusCode.PermissionDenied, "VPC Service Controls: Request is prohibited by organization's policy. vpcServiceControlsUniqueIdentifier: Rpc-Id_3");
        var errorInfo = new Google.Rpc.Status { Code = (int)StatusCode.PermissionDenied, Message = "Request is prohibited by organization's policy." };
        errorInfo.Details.Add(Google.Protobuf.WellKnownTypes.Any.Pack(new Google.Rpc.ErrorInfo { Reason = "SECURITY_POLICY_VIOLATED", Domain = "googleapis.com", Metadata = { ["uniqueIdentifier"] = "Trailer-Id_5" } }));
        var perimeterTrailer = new RpcException(new Status(StatusCode.PermissionDenied, "Request is prohibited by organization's policy."),
            new Metadata { { "grpc-status-details-bin", Google.Protobuf.MessageExtensions.ToByteArray(errorInfo) } });
        var namedLikeIt = Rpc(StatusCode.PermissionDenied, "Permission denied on table ds.SECURITY_POLICY_VIOLATED");
        var detailFallback = BigQueryService.Fallback(perimeterDetail, "varia-emulator");
        var trailerFallback = BigQueryService.Fallback(perimeterTrailer, "varia-emulator");
        var trailerRead = BigQueryService.ReadFailure(perimeterTrailer, "varia-emulator");
        check(detailFallback is { Reason: "perimeter", Lasting: false } && detailFallback.Sentence.Contains("identifier Rpc-Id_3", StringComparison.Ordinal)
            && trailerFallback is { Reason: "perimeter" } && trailerFallback.Sentence.Contains("identifier Trailer-Id_5", StringComparison.Ordinal) && !trailerFallback.Sentence.Contains("readsessions", StringComparison.Ordinal)
            && trailerRead.Code == "PERMISSION_DENIED" && trailerRead.Message.StartsWith(BigQueryErrors.PerimeterOpening, StringComparison.Ordinal) && trailerRead.Message.Contains("Trailer-Id_5", StringComparison.Ordinal)
            && BigQueryService.Fallback(namedLikeIt, "varia-emulator") is { Reason: "permission" } && !BigQueryService.ReadFailure(namedLikeIt, "varia-emulator").Message.StartsWith(BigQueryErrors.PerimeterOpening, StringComparison.Ordinal),
            $"a Storage API refusal VPC Service Controls made says so, from its message or its ErrorInfo trailer: {detailFallback?.Sentence} | {trailerFallback?.Sentence} | {trailerRead.Message}");
        {
            var (jobs, storage) = Numbers(1500, 500);
            storage.ReadFault = (_, _) => refresh;
            using var harness = StorageHarness(jobs, storage);
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n, s FROM t");
            check(result is { Status: "failed", Error.Code: "AUTH_EXPIRED" } && storage.Reads.Count == 3,
                $"a sign-in that expires during a Storage read fails the query with AUTH_EXPIRED, without retries: {code} {result?.Error?.Code} {storage.Reads.Count}");
        }

        // An endpoint that answers more streams than asked is refused (reading only some would lose rows); REST reads it.
        {
            var (jobs, storage) = Numbers(1500, 100);
            storage.AnswerStreams = 9;
            using var harness = StorageHarness(jobs, storage);
            await harness.ConnectAsync();
            var (code, result, _) = await harness.Execute("SELECT n, s FROM t");
            check(code == "ok" && result?.ResultSets.Single().RowsStored == 1500 && storage.Reads.IsEmpty && Says(result, "could not read this result"),
                $"a session with more streams than asked is not read; REST reads the result: {code} {storage.Reads.Count}");
        }

        // Streams waiting for the reader hold no budget: a query budget a little over the stored result (five batches'
        // charges) is enough, as for REST, however many streams are read.
        {
            var (jobs, storage) = Numbers(100_000, 2_000);
            long stored;
            {
                var roomy = new ResultStore(1L << 32, 1L << 31);
                using var harness = StorageHarness(jobs, storage, roomy);
                await harness.ConnectAsync();
                await harness.Execute("SELECT n, s FROM t");
                stored = roomy.UsedBytes;
            }
            // A Zstandard batch's charge: its message, the decoded copy of it, and the buffers it decompresses into.
            var charge = 2L * BigQueryStorageFake.BatchBytes(storage.Batches[0], Apache.Arrow.Ipc.CompressionCodecType.Zstd).Length + ArrowColumnPlan.DecodedBytes(storage.Batches[0]);
            var tight = new ResultStore(1L << 32, stored + 5 * charge);
            using (var harness = StorageHarness(jobs, storage, tight))
            {
                await harness.ConnectAsync();
                var (code, result, _) = await harness.Execute("SELECT n, s FROM t", Memory);
                check(code == "ok" && result?.ResultSets.Single() is { RowsStored: 100_000, Truncated: null },
                    $"batches waiting for the reader hold no budget: a budget of the result and five batches stores it whole: {result?.ResultSets.Single().RowsStored} {result?.ResultSets.Single().Truncated}");
            }
        }

        // A compressed batch's decoded buffers are charged while it is stored: a budget that holds its message but not what it
        // decompresses into stops the read at the budget (an uncompressed batch, read in place, is not charged twice).
        {
            var (jobs, storage) = Numbers(20_000, 10_000);
            var wire = BigQueryStorageFake.BatchBytes(storage.Batches[0], Apache.Arrow.Ipc.CompressionCodecType.Zstd).Length;
            var plain = BigQueryStorageFake.BatchBytes(storage.Batches[0]).Length;
            var decoded = ArrowColumnPlan.DecodedBytes(storage.Batches[0]);
            var limit = 2L * wire + decoded / 2;
            check(decoded > 2L * wire, $"the numbers batch compresses well enough for the check: {wire} {decoded}");
            var tight = new ResultStore(1L << 32, limit);
            using (var harness = StorageHarness(jobs, storage, tight))
            {
                await harness.ConnectAsync();
                var (code, result, _) = await harness.Execute("SELECT n, s FROM t", Memory);
                check(code == "ok" && result?.ResultSets.Single() is { RowsStored: 0, Truncated: "queryBudget" } && tight.UsedBytes < 2L * wire,
                    $"a compressed batch whose decoded buffers do not fit the budget stops the read at the budget and gives every charge back (the empty set's own bytes stay): {code} {result?.ResultSets.Single().RowsStored} {result?.ResultSets.Single().Truncated} {tight.UsedBytes}");
            }
            storage.IgnoreCompression = true;
            var roomy = new ResultStore(1L << 32, 2L * plain + 4L * 1024 * 1024);
            using (var harness = StorageHarness(jobs, storage, roomy))
            {
                await harness.ConnectAsync();
                var (code, result, _) = await harness.Execute("SELECT n, s FROM t");
                check(code == "ok" && result?.ResultSets.Single().RowsStored > 0,
                    $"an uncompressed batch is read in place and charged once: {code} {result?.ResultSets.Single().RowsStored} {result?.ResultSets.Single().Truncated}");
            }
        }
    }
}
