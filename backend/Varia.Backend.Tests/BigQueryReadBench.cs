using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>
/// Offline read throughput, REST against Storage Read, run by hand (docs/bigquery.md, Storage Read):
/// <c>dotnet run --project backend/Varia.Backend.Tests --configuration Release -- --bigquery-read-bench [--rows N] [--runs N]</c>.
/// Both readers run through query.execute against the in-process fakes (REST pages of 10,000 rows of JSON; Arrow batches of
/// 10,000 rows on four streams, or one for ORDER BY), so it measures Varia's decoding and storing, not the network. Prints
/// one JSON line per case with the median time and rows per second; measures only, no checks, no floors, and never
/// touches a real project.
/// </summary>
internal static partial class BigQueryExecutionChecks
{
    public const string ReadBenchArgument = "--bigquery-read-bench";

    public static async Task ReadBenchAsync(string[] args)
    {
        long Option(string name, long fallback) => Array.IndexOf(args, name) is var at and >= 0 && at + 1 < args.Length ? long.Parse(args[at + 1], CultureInfo.InvariantCulture) : fallback;
        var count = (int)Option("--rows", 500_000);
        var runs = (int)Option("--runs", 5);
        var (jobs, storage) = Numbers(count, 10_000, jobs => jobs.PageCap = 10_000);
        (string Name, bool Arrow, string Sql)[] cases = [("rest", false, "SELECT n, s FROM t"), ("arrow", true, "SELECT n, s FROM t"), ("arrow-ordered", true, "SELECT n, s FROM t ORDER BY n")];
        async Task<double> Time((string Name, bool Arrow, string Sql) read)
        {
            using var harness = new Harness(jobs, new ResultStore(8L << 30, 4L << 30), read.Arrow ? storage : null);
            harness.Service.BigQuery.StorageReadMinBytes = 0;
            await harness.ConnectAsync();
            var watch = Stopwatch.StartNew();
            var (code, result, message) = await harness.Execute(read.Sql);
            watch.Stop();
            if (code != "ok" || result?.ResultSets.Single().RowsStored != count) throw new InvalidOperationException($"The {read.Name} read failed: {code} {message}");
            return watch.Elapsed.TotalMilliseconds;
        }
        // Two untimed rounds of every case first, so tiered compilation favours none of them; then the cases take turns.
        for (var warm = 0; warm < 2; warm++)
            foreach (var read in cases) await Time(read);
        var times = cases.ToDictionary(read => read.Name, _ => new List<double>());
        for (var run = 0; run < runs; run++)
            foreach (var read in cases) times[read.Name].Add(await Time(read));
        foreach (var (name, list) in times)
        {
            list.Sort();
            var median = list[list.Count / 2];
            Console.WriteLine(JsonSerializer.Serialize(new { reader = name, rows = count, medianMs = Math.Round(median, 1), rowsPerSecond = Math.Round(count / (median / 1000)) }));
        }
    }
}
