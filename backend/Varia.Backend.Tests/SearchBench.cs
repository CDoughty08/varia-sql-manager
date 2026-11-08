using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>The object search benchmark (tests/bench/search.bench.ts runs it with <see cref="Argument"/>): a synthetic index of a
/// million objects in 20 databases (tables and their columns), searched for one letter, as the first key typed in the search box
/// is: nearly every object matches, so the scan runs past the candidate cap. Prints one JSON line per metric; measures only.</summary>
internal static class SearchBench
{
    public const string Argument = "--search-bench";

    public static void Run()
    {
        var index = new ConnectionIndex(new IndexBudget(long.MaxValue));
        string[] columns = ["Id", "Name", "CreatedAt", "ModifiedAt", "Amount", "Status", "OwnerId", "Notes", "RowVersion"];
        var objects = 0;
        for (var database = 0; database < 20; database++)
        {
            var items = new List<IndexedObject>(50_000);
            for (var table = 0; table < 5_000; table++)
            {
                var parent = new IndexedObject("table", "tables", table % 3 == 0 ? "sales" : "dbo", "Customer_Orders_" + table.ToString("D5", CultureInfo.InvariantCulture), Modified: DateTime.UnixEpoch);
                items.Add(parent);
                foreach (var column in columns) items.Add(DatabaseReader.Child(parent, "column", "columns", column)!);
            }
            objects += items.Count;
            index.Put(new DatabaseIndex("Db" + database.ToString("D2", CultureInfo.InvariantCulture), [.. items], 0, 0, 0));
        }
        var limits = new ObjectIndexLimits { SearchBudget = TimeSpan.FromMinutes(1) };
        var status = new ObjectIndexStatus("ready", 20, 20, objects, 0, 0, [], false);
        var query = new SearchQuery("e", false, false, false, true, false, null, null, ObjectSearchService.DefaultLimit);
        var matcher = SearchMatcher.Create(query.Text, false, false, false, limits.MatchTimeout).Matcher!;
        var times = new List<double>();
        var allocated = new List<long>();
        var total = 0;
        for (var run = 0; run < 25; run++)
        {
            var before = GC.GetAllocatedBytesForCurrentThread();
            var watch = Stopwatch.StartNew();
            var result = IndexSearch.Run(index, query, matcher, limits, status, CancellationToken.None);
            watch.Stop();
            if (result.Hits.Count != query.Limit || !result.Partial) throw new InvalidOperationException("The search bench's search did not fill its hits.");
            total = result.Total;
            if (run < 5) continue;
            times.Add(watch.Elapsed.TotalMilliseconds);
            allocated.Add(GC.GetAllocatedBytesForCurrentThread() - before);
        }
        times.Sort();
        allocated.Sort();
        var detail = objects.ToString("N0", CultureInfo.InvariantCulture) + " objects, " + total.ToString("N0", CultureInfo.InvariantCulture) + " hits; 20 warm runs";
        Print("node.search.firstLetterP95Ms", times[(int)Math.Ceiling(0.95 * times.Count) - 1], "ms", detail);
        Print("node.search.firstLetterAllocatedMb", allocated[allocated.Count / 2] / 1e6, "MB", detail + ", median");
    }

    private static void Print(string id, double value, string unit, string detail) =>
        Console.WriteLine(JsonSerializer.Serialize(new { id, value, unit, detail }));
}
