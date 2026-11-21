using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Apache.Arrow;
using Apache.Arrow.Ipc;
using Apache.Arrow.Types;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>
/// Offline read throughput, REST against Storage Read, run by hand (docs/bigquery.md, Storage Read):
/// <c>dotnet run --project backend/Varia.Backend.Tests --configuration Release -- --bigquery-read-bench [--rows N] [--runs N]</c>.
/// Every reader runs through query.execute against the in-process fakes (REST pages of 10,000 rows of JSON; Arrow batches of
/// 10,000 rows on four streams, or one for ORDER BY, uncompressed or with LZ4 frame or Zstandard buffers), so it measures
/// Varia's decoding and storing, not the network or the fakes (the REST fake serializes each page once, and the collection
/// one case's release schedules runs before the next case's clock starts). Two tables: "numbers" (an INT64 counter and
/// short strings, very repetitive) and "mixed" (random ids and amounts, a small set of countries, emails and free text with nulls, flags).
/// Prints one JSON line per case with the median time, rows per second and the Arrow bytes sent; measures only, no checks,
/// no floors, and never touches a real project.
/// </summary>
internal static partial class BigQueryExecutionChecks
{
    public const string ReadBenchArgument = "--bigquery-read-bench";

    public static async Task ReadBenchAsync(string[] args)
    {
        long Option(string name, long fallback) => System.Array.IndexOf(args, name) is var at and >= 0 && at + 1 < args.Length ? long.Parse(args[at + 1], CultureInfo.InvariantCulture) : fallback;
        var count = (int)Option("--rows", 500_000);
        var runs = (int)Option("--runs", 5);
        var previous = new ResultStore(1, 1);
        foreach (var (data, (jobs, storage)) in new[] { ("numbers", Numbers(count, 10_000, jobs => (jobs.PageCap, jobs.CacheRows) = (10_000, true))), ("mixed", Mixed(count, 10_000)) })
        {
            (string Name, bool Arrow, CompressionCodecType? Compression, string Sql)[] cases =
            [
                ("rest", false, null, "SELECT * FROM t"),
                ("arrow", true, null, "SELECT * FROM t"),
                ("arrow-lz4", true, CompressionCodecType.Lz4Frame, "SELECT * FROM t"),
                ("arrow-zstd", true, CompressionCodecType.Zstd, "SELECT * FROM t"),
                ("arrow-ordered", true, null, "SELECT * FROM t ORDER BY 1"),
                ("arrow-lz4-ordered", true, CompressionCodecType.Lz4Frame, "SELECT * FROM t ORDER BY 1")
            ];
            var sent = new Dictionary<string, long>();
            async Task<double> Time((string Name, bool Arrow, CompressionCodecType? Compression, string Sql) read)
            {
                // Uncompressed batches for "arrow"; LZ4 forced; Zstandard as Varia asks for it.
                storage.Compression = read.Compression == CompressionCodecType.Lz4Frame ? read.Compression : null;
                storage.IgnoreCompression = read.Compression is null;
                // The collection the previous case's release scheduled (64 MiB released, or a store emptied) runs before the clock
                // starts: in the timing it would be a blocking gen2 collection over this process's fixtures (gigabytes of
                // JSON rows), a pause the backend's own heap does not have and that only the larger result reached.
                await previous.Collection;
                var store = new ResultStore(8L << 30, 4L << 30);
                previous = store;
                using var harness = new Harness(jobs, store, read.Arrow ? storage : null);
                harness.Service.BigQuery.StorageReadMinBytes = 0;
                await harness.ConnectAsync();
                var before = Interlocked.Read(ref storage.SentBytes);
                var watch = Stopwatch.StartNew();
                var (code, result, message) = await harness.Execute(read.Sql);
                watch.Stop();
                if (code != "ok" || result?.ResultSets.Single().RowsStored != count) throw new InvalidOperationException($"The {read.Name} read failed: {code} {message} {result?.ResultSets.Single().RowsStored} {result?.ResultSets.Single().Truncated} {result?.Status} {result?.Error?.Message} {string.Join(" / ", result?.Messages.Select(entry => entry.Text) ?? [])}");
                sent[read.Name] = Interlocked.Read(ref storage.SentBytes) - before;
                return watch.Elapsed.TotalMilliseconds;
            }
            // Two untimed rounds of every case first, so tiered compilation favours none of them and the fake has serialized
            // every batch; then the cases take turns.
            for (var warm = 0; warm < 2; warm++)
                foreach (var read in cases) await Time(read);
            var times = cases.ToDictionary(read => read.Name, _ => new List<double>());
            for (var run = 0; run < runs; run++)
                foreach (var read in cases) times[read.Name].Add(await Time(read));
            foreach (var (name, list) in times)
            {
                list.Sort();
                var median = list[list.Count / 2];
                Console.WriteLine(JsonSerializer.Serialize(new { data, reader = name, rows = count, medianMs = Math.Round(median, 1), rowsPerSecond = Math.Round(count / (median / 1000)), arrowBytes = sent[name] }));
            }
        }
    }

    /// <summary>A table closer to real data than <see cref="Numbers"/>: random ids and amounts, a few countries, emails, free
    /// text (a fifth null) and a flag, the same rows in REST JSON and Arrow.</summary>
    static (Jobs Jobs, BigQueryStorageFake Storage) Mixed(int count, int batchRows)
    {
        var random = new Random(20261119);
        string[] countries = ["US", "GB", "DE", "FR", "JP", "BR", "IN", "CA", "AU", "MX", "ES", "IT", "NL", "SE", "PL", "KR", "ZA", "AR", "NG", "EG"];
        string[] names = ["ava", "liam", "noah", "emma", "olivia", "mia", "lucas", "amir", "sofia", "kenji", "priya", "omar", "lena", "marco", "yuki", "zoe"];
        var words = Enumerable.Range(0, 300).Select(i => new string([.. Enumerable.Range(0, 3 + random.Next(7)).Select(_ => (char)('a' + random.Next(26)))])).ToArray();
        var ids = new long[count];
        var amounts = new double[count];
        var country = new string[count];
        var email = new string[count];
        var note = new string?[count];
        var active = new bool[count];
        for (var i = 0; i < count; i++)
        {
            ids[i] = random.NextInt64(1L << 40);
            amounts[i] = Math.Round(random.NextDouble() * 10_000, 2);
            country[i] = countries[random.Next(countries.Length)];
            email[i] = names[random.Next(names.Length)] + "." + names[random.Next(names.Length)] + random.Next(10_000).ToString(Inv) + "@example.com";
            note[i] = random.Next(5) == 0 ? null : string.Join(' ', Enumerable.Range(0, 3 + random.Next(8)).Select(_ => words[random.Next(words.Length)]));
            active[i] = random.Next(3) != 0;
        }
        var jobs = new Jobs
        {
            Schema = Schema(Field("id", "INTEGER"), Field("amount", "FLOAT"), Field("country", "STRING"), Field("email", "STRING"), Field("note", "STRING"), Field("active", "BOOLEAN")),
            Rows = [.. Enumerable.Range(0, count).Select(i => Row(ids[i].ToString(Inv), amounts[i].ToString("R", Inv), country[i], email[i], note[i] is { } text ? JsonValue.Create(text) : null, active[i] ? "true" : "false"))],
            Destination = Destination,
            PageCap = 10_000,
            CacheRows = true
        };
        var schema = new Schema([new("id", Int64Type.Default, true), new("amount", DoubleType.Default, true), new("country", StringType.Default, true),
            new("email", StringType.Default, true), new("note", StringType.Default, true), new("active", BooleanType.Default, true)], null);
        var batches = Enumerable.Range(0, count).Chunk(batchRows).Select(chunk =>
        {
            var flags = new BooleanArray.Builder();
            foreach (var i in chunk) flags.Append(active[i]);
            return new RecordBatch(schema, [Primitive(Int64Type.Default, [.. chunk.Select(i => (long?)ids[i])]), Primitive(DoubleType.Default, [.. chunk.Select(i => (double?)amounts[i])]),
                Strings(chunk.Select(i => country[i])), Strings(chunk.Select(i => email[i])), Strings(chunk.Select(i => note[i])), flags.Build()], chunk.Length);
        }).ToList();
        return (jobs, new BigQueryStorageFake(schema, batches));
    }
}
