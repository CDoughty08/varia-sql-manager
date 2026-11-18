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
        var fold = SearchFold.Ready(1033);
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
    }

    private static void Print(string id, double value, string unit, string detail) =>
        Console.WriteLine(JsonSerializer.Serialize(new { id, value = Math.Round(value, 2), unit, detail }));
}
