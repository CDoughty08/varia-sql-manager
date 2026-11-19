using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>The Find pre-check benchmark (tests/bench/search.bench.ts runs it with <see cref="Argument"/>): 400,000 cells of
/// fictional multilingual text (SearchFoldChecks.Sentences, numbered) in a Latin1_General_CI_AS column, searched on one
/// thread for a text no cell holds, by a culture matcher with the culture's fold (the pre-check) and without it. Prints one
/// JSON line per metric; measures only.</summary>
internal static class FindBench
{
    public const string Argument = "--find-bench";

    public static void Run()
    {
        var cells = new List<byte[]>(400_000);
        var sentences = SearchFoldChecks.Sentences;
        for (var i = 0; i < 400_000; i++)
        {
            var sentence = sentences[i % sentences.Length];
            var start = (int)((uint)i * 2654435761u % (uint)Math.Max(1, sentence.Length - 20));
            cells.Add(Encoding.UTF8.GetBytes(sentence[start..] + " #" + i.ToString(CultureInfo.InvariantCulture)));
        }
        var info = CultureInfo.GetCultureInfo(1033).CompareInfo;
        var options = CompareOptions.IgnoreCase | CompareOptions.IgnoreKanaType | CompareOptions.IgnoreWidth;
        var fold = SearchFold.Ready(1033, options);
        const string text = "zorbiquax";
        var scratch = new ResultSearcher.Scratch();
        double Time(SearchFold? with)
        {
            var times = new List<double>();
            for (var run = 0; run < 6; run++)
            {
                var matcher = new ResultSearcher.CultureMatcher(text, info, options, with);
                var watch = Stopwatch.StartNew();
                var found = 0;
                foreach (var cell in cells) if (matcher.Matches(cell, scratch)) found++;
                watch.Stop();
                if (found != 0) throw new InvalidOperationException("The find bench's text was found.");
                if (run > 0) times.Add(watch.Elapsed.TotalMilliseconds);
            }
            times.Sort();
            return times[times.Count / 2];
        }
        var alone = Time(null);
        var prechecked = Time(fold);
        var megabytes = cells.Sum(cell => (long)cell.Length) / 1e6;
        Print("node.find.prechecked", prechecked, "ms", $"{cells.Count:N0} multilingual cells ({megabytes:F0} MB), Latin1_General_CI_AS, one thread, text in no cell, median of 5; {alone:F0} ms without the pre-check");
        Print("node.find.precheckSpeedup", alone / prechecked, "x", $"culture compare alone {alone:F0} ms against pre-checked {prechecked:F0} ms over the same cells");

        // Type-ahead narrowing: a word typed a key at a time into a result's CI_AS column of the sentences the fold vouches
        // for (a cell it cannot vouch for, which Japanese, Chinese, Thai and Hindi text here holds, is searched again every
        // key, whatever the text before it ruled out, so it only dilutes the measure).
        var buffer = new char[256];
        var vouched = sentences.Where(sentence => fold.TryFold(sentence, ref buffer, out _)).ToArray();
        var texts = Enumerable.Range(0, 400_000).Select(i =>
        {
            var sentence = vouched[i % vouched.Length];
            var start = (int)((uint)i * 2654435761u % (uint)Math.Max(1, sentence.Length - 20));
            return sentence[start..] + " #" + i.ToString(CultureInfo.InvariantCulture);
        });
        var set = Store(new ResultStore(4L << 30, 4L << 30), texts);
        var (full, narrowed, steps) = TypeAhead(set, "reconciliation");
        Print("node.find.typeAhead", narrowed, "ms", $"\"reconciliation\" typed a key at a time into Find over 400,000 cells of {vouched.Length} sentences the fold vouches for, Latin1_General_CI_AS, one thread, median of 3; {full:F0} ms searching every row each key; per key saved {steps}");
        Print("node.find.typeAheadSpeedup", full / narrowed, "x", $"every row searched each key {full:F0} ms against narrowed {narrowed:F0} ms");
    }

    /// <summary>Run by hand with <see cref="MessagesArgument"/> and a server name: type-ahead over SQL Server's own messages
    /// in every language (sys.messages, read with one SELECT and Windows authentication), a few words a key at a time.</summary>
    public const string MessagesArgument = "--find-bench-messages";

    public static void RunMessages(string server, string? language = null)
    {
        var texts = new List<string>();
        using (var connection = new Microsoft.Data.SqlClient.SqlConnection(new Microsoft.Data.SqlClient.SqlConnectionStringBuilder { DataSource = server, IntegratedSecurity = true, TrustServerCertificate = true, Encrypt = false }.ConnectionString))
        {
            connection.Open();
            using var command = new Microsoft.Data.SqlClient.SqlCommand("SELECT text FROM sys.messages WHERE @language IS NULL OR language_id = @language", connection);
            command.Parameters.AddWithValue("@language", language is null ? DBNull.Value : int.Parse(language, CultureInfo.InvariantCulture));
            using var reader = command.ExecuteReader();
            while (reader.Read()) texts.Add(reader.GetString(0));
        }
        var set = Store(new ResultStore(4L << 30, 4L << 30), texts);
        foreach (var word in new[] { "database", "permission", "Datenbank", "connexion", "transaction log" })
        {
            var (full, narrowed, steps) = TypeAhead(set, word);
            Console.WriteLine($"{word}: {texts.Count:N0} messages, every row {full:F0} ms, narrowed {narrowed:F0} ms ({full / narrowed:F1}x); per key {steps}");
        }
    }

    /// <summary>A result of one Latin1_General_CI_AS text column holding <paramref name="texts"/>.</summary>
    internal static ResultSetBuffer Store(ResultStore store, IEnumerable<string> texts)
    {
        ResultColumn[] columns = [new("text", "nvarchar", "text", Collation: new ResultCollation(1033, 0, 1252, false, 1 | 8 | 16))];
        var set = store.Open(store.BeginQuery("find-bench"), 0, 1, 1, "rows", columns, [WireKind.Text]) ?? throw new InvalidOperationException("The bench's result was not kept.");
        foreach (var text in texts)
        {
            set.CountRow();
            set.BeginRow()!.AppendText(text);
            if (!set.TryCommitRow()) throw new InvalidOperationException("The bench's result did not fit.");
        }
        set.Complete();
        return set;
    }

    /// <summary>Times typing <paramref name="word"/> a key at a time into Find on one thread, searching every row each key
    /// and narrowed (each key from the last), medians of three; with the share of time each key saved.</summary>
    internal static (double Full, double Narrowed, string Steps) TypeAhead(ResultSetBuffer set, string word)
    {
        var gate = new ViewSorter.WorkerGate(() => 1);
        var pages = set.SealedSnapshot();
        double[] Keys(bool narrow)
        {
            var times = new double[word.Length];
            for (var key = 1; key <= word.Length; key++)
            {
                var watch = Stopwatch.StartNew();
                if (ResultSearcher.Search(set, pages, null, word[..key], 0, false, 1000, CancellationToken.None, null, 1, gate, narrow) is null) throw new InvalidOperationException("The bench's search stopped.");
                times[key - 1] = watch.Elapsed.TotalMilliseconds;
            }
            return times;
        }
        var fulls = new List<double[]>();
        var narrows = new List<double[]>();
        for (var run = 0; run < 4; run++)
        {
            var f = Keys(false);
            var n = Keys(true);
            if (run == 0) continue;
            fulls.Add(f);
            narrows.Add(n);
        }
        double Median(IEnumerable<double> values) { var sorted = values.Order().ToArray(); return sorted[sorted.Length / 2]; }
        var full = Median(fulls.Select(keys => keys.Sum()));
        var narrowed = Median(narrows.Select(keys => keys.Sum()));
        var steps = string.Join(" ", Enumerable.Range(0, word.Length).Select(key =>
            $"{word[key]}:{100 * (1 - Median(narrows.Select(keys => keys[key])) / Median(fulls.Select(keys => keys[key]))):F0}%"));
        return (full, narrowed, steps);
    }

    private static void Print(string id, double value, string unit, string detail) =>
        Console.WriteLine(JsonSerializer.Serialize(new { id, value = Math.Round(value, 2), unit, detail }));
}
