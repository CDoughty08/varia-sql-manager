using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

/// <summary>The object search benchmark (tests/bench/search.bench.ts runs it with <see cref="Argument"/>): a synthetic index of a
/// million objects in 20 databases (tables and their columns), searched for one letter, as the first key typed in the search box
/// is: nearly every object matches, so the scan runs past the candidate cap. Then a search inside packed definitions that matches
/// none of them. Prints one JSON line per metric; measures only.</summary>
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
        Definitions(limits);
    }

    /// <summary>A search inside definitions for text no definition holds, so every packed definition is unpacked and scanned:
    /// 10,000 distinct procedures of about 4,000 characters each.</summary>
    private static void Definitions(ObjectIndexLimits limits)
    {
        var index = new ConnectionIndex(new IndexBudget(long.MaxValue));
        var characters = 0L;
        for (var database = 0; database < 5; database++)
        {
            var items = new List<IndexedObject>(2_000);
            for (var procedure = 0; procedure < 2_000; procedure++)
            {
                var id = database * 2_000 + procedure;
                var text = new System.Text.StringBuilder("CREATE PROCEDURE dbo.usp_Ledger_" + id.ToString("D5", CultureInfo.InvariantCulture) + " @from date, @to date\r\nAS\r\nBEGIN\r\n");
                for (var line = 0; line < 40; line++)
                    text.Append("\tUPDATE dbo.Ledger_").Append(id % 97).Append(" SET Amount = Amount + ").Append(line * 7 + id).Append(" WHERE PostedAt BETWEEN @from AND @to AND RuleId = ").Append(line).Append(";\r\n");
                var definition = text.Append("END\r\n").ToString();
                characters += definition.Length;
                items.Add(new IndexedObject("procedure", "storedProcedures", "dbo", "usp_Ledger_" + id.ToString("D5", CultureInfo.InvariantCulture), Modified: DateTime.UnixEpoch, Definition: definition));
            }
            var value = new DatabaseIndex("Db" + database.ToString("D2", CultureInfo.InvariantCulture), [.. items], 0, 0, 0);
            if (value.Table.StoredDefinition(0) is not PackedText) throw new InvalidOperationException("The search bench's definitions were not packed.");
            index.Put(value);
        }
        var status = new ObjectIndexStatus("ready", 5, 5, 10_000, 0, 0, [], false);
        var query = new SearchQuery("never_written", false, false, false, false, true, null, null, ObjectSearchService.DefaultLimit);
        var matcher = SearchMatcher.Create(query.Text, false, false, false, limits.MatchTimeout).Matcher!;
        var times = new List<double>();
        for (var run = 0; run < 15; run++)
        {
            var watch = Stopwatch.StartNew();
            var result = IndexSearch.Run(index, query, matcher, limits, status, CancellationToken.None);
            watch.Stop();
            if (result.Hits.Count != 0 || result.Partial) throw new InvalidOperationException("The search bench's definition scan found something or stopped early.");
            if (run >= 5) times.Add(watch.Elapsed.TotalMilliseconds);
        }
        times.Sort();
        Print("node.search.definitionScanP95Ms", times[(int)Math.Ceiling(0.95 * times.Count) - 1], "ms",
            "10,000 packed definitions, " + (characters / 1e6).ToString("0.0", CultureInfo.InvariantCulture) + " M characters; 10 warm runs");
    }

    private static void Print(string id, double value, string unit, string detail) =>
        Console.WriteLine(JsonSerializer.Serialize(new { id, value, unit, detail }));
}
