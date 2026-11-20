using System.Diagnostics;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Run by hand with <see cref="Argument"/> and a server name: SQL Server's own catalog and DMV rows (read with
/// SELECTs and Windows authentication) stored as the product stores them, then each page packed with and without typed
/// columns (PageCodec.Typed.cs): bytes, unpack time, and that every page comes back byte for byte. Measures only; prints no
/// values.</summary>
internal static class TypedFormBench
{
    public const string Argument = "--typed-form-bench";

    private static readonly (string Name, string Sql)[] Queries =
    [
        ("messages", "SELECT * FROM sys.messages"),
        ("all_columns", "SELECT * FROM sys.all_columns"),
        ("all_objects", "SELECT * FROM sys.all_objects"),
        ("all_parameters", "SELECT * FROM sys.all_parameters"),
        ("query_stats", "SELECT * FROM sys.dm_exec_query_stats"),
        ("perf_counters", "SELECT * FROM sys.dm_os_performance_counters"),
        ("msdb_objects", "SELECT o.*, c.* FROM msdb.sys.all_objects o JOIN msdb.sys.all_columns c ON c.object_id = o.object_id"),
    ];

    public static void Run(string server)
    {
        var builder = new SqlConnectionStringBuilder { DataSource = server, IntegratedSecurity = true, TrustServerCertificate = true, Encrypt = false, ApplicationName = "Varia typed form bench" };
        using var connection = new SqlConnection(builder.ConnectionString);
        connection.Open();
        foreach (var (name, sql) in Queries)
        {
            var store = new ResultStore(4L << 30, 4L << 30);
            ResultSetBuffer? set = null;
            using (var command = new SqlCommand(sql, connection))
            using (var reader = command.ExecuteReader())
            {
                var plan = ColumnPlan.From(reader);
                set = store.Open(store.BeginQuery("typed-bench"), 0, 1, 1, "rows", plan.Columns, plan.Wires, lengths: plan.Lengths) ?? throw new InvalidOperationException("Not kept.");
                while (reader.Read())
                {
                    set.CountRow();
                    var row = set.BeginRow() ?? throw new InvalidOperationException("Not stored.");
                    plan.ReadRow(reader, row, _ => { });
                    if (!set.TryCommitRow()) throw new InvalidOperationException("Did not fit.");
                }
            }
            set.Complete();
            var pages = set.SealedSnapshot().Select(page => page.Body()).Where(page => page.Length >= 32 * 1024).ToArray();
            long raw = 0, lengths = 0, typed = 0;
            var typedPages = 0;
            foreach (var page in pages)
            {
                raw += page.Length;
                var a = PageCodec.Pack(page, typed: false)!;
                var b = PageCodec.Pack(page)!;
                lengths += a.Length;
                typed += b.Length;
                if (b[0] == 2) typedPages++;
                if (!PageCodec.Unpack(b, page.Length).AsSpan().SequenceEqual(page)) throw new InvalidOperationException(name + ": a typed page did not come back.");
            }
            Console.WriteLine(name + ": " + set.Columns.Count + " columns, " + typedPages + " pages typed; " + Compare(pages));
            if (Environment.GetEnvironmentVariable("VARIA_TYPED_COLUMNS") == "1") ColumnSizes(set.SealedSnapshot(), set.Columns);
            Console.WriteLine("  Find over every page, packed: " + FindTimes(set));
            store.Release(set.ResultId);
        }
    }

    /// <summary>A copy of <paramref name="source"/>'s rows in <paramref name="store"/>, cell by cell.</summary>
    private static ResultSetBuffer Copy(ResultSetBuffer source, ResultStore store)
    {
        var set = store.Open(store.BeginQuery("typed-copy"), 0, 1, 1, "rows", source.Columns, source.Wires) ?? throw new InvalidOperationException("Not kept.");
        using (source.Pin())
            foreach (var page in source.SealedSnapshot())
            {
                var body = page.Body();
                var view = PageView.Parse(body, source.Columns.Count);
                for (var row = 0; row < view.Rows; row++)
                {
                    set.CountRow();
                    var builder = set.BeginRow() ?? throw new InvalidOperationException("Not stored.");
                    for (var c = 0; c < source.Columns.Count; c++)
                    {
                        if (view.IsNull(c, row)) builder.AppendNull(view.IsError(c, row));
                        else if (view.Wire(c) == WireKind.Binary) builder.AppendBinary(view.Span(c, row), view.IsTruncated(c, row));
                        else builder.AppendUtf8(view.Span(c, row), view.IsTruncated(c, row));
                    }
                    if (!set.TryCommitRow()) throw new InvalidOperationException("Did not fit.");
                }
            }
        set.Complete();
        return set;
    }

    /// <summary>Find for a text no row holds, so it reads every page, with page filters off: packed untyped, then typed,
    /// alternately, medians of five on the result workers.</summary>
    internal static string FindTimes(ResultSetBuffer source)
    {
        var untypedStore = new ResultStore(4L << 30, 4L << 30) { Packing = PagePacking.EveryComplete, TypedPacking = false };
        var typedStore = new ResultStore(4L << 30, 4L << 30) { Packing = PagePacking.EveryComplete };
        var (untyped, typed) = (Copy(source, untypedStore), Copy(source, typedStore));
        var times = (new List<double>(), new List<double>());
        for (var run = 0; run < 6; run++)
            foreach (var (set, list) in new[] { (untyped, times.Item1), (typed, times.Item2) })
            {
                var watch = Stopwatch.StartNew();
                ResultSearcher.Search(set, set.SealedSnapshot(), null, "zqxjvk", 0, false, 10, CancellationToken.None, narrow: false, filters: false);
                if (run > 0) list.Add(watch.Elapsed.TotalMilliseconds);
            }
        times.Item1.Sort();
        times.Item2.Sort();
        untypedStore.Release(untyped.ResultId);
        typedStore.Release(typed.ResultId);
        return string.Create(CultureInfo.InvariantCulture, $"{times.Item1[2]:F1} -> {times.Item2[2]:F1} ms ({times.Item2[2] / times.Item1[2]:F2}x)");
    }

    /// <summary>Each column of a sample of pages on its own (one-column pages rebuilt from the page's cells): packed bytes
    /// with and without typing, so a column's shape can be judged apart from the rest of its page.</summary>
    internal static void ColumnSizes(IReadOnlyList<StoredPage> pages, IReadOnlyList<ResultColumn> columns)
    {
        var sample = Enumerable.Range(0, Math.Min(40, pages.Count)).Select(i => pages[i * pages.Count / Math.Min(40, pages.Count)].Body()).ToArray();
        for (var c = 0; c < columns.Count; c++)
        {
            long text = 0, lengths = 0, typed = 0;
            foreach (var page in sample)
            {
                var view = PageView.Parse(page, columns.Count);
                var builder = new PageBuilder(1, [view.Wire(c)], view.FirstRow);
                for (var row = 0; row < view.Rows; row++)
                {
                    builder.BeginRow();
                    if (view.IsNull(c, row)) builder.AppendNull();
                    else if (view.Wire(c) == WireKind.Binary) builder.AppendBinary(view.Span(c, row));
                    else builder.AppendUtf8(view.Span(c, row));
                    builder.CommitRow();
                }
                var one = builder.Seal();
                text += one.Length;
                lengths += PageCodec.Pack(one, typed: false)!.Length;
                var packed = PageCodec.Pack(one)!;
                typed += packed.Length;
            }
            Console.WriteLine(string.Create(CultureInfo.InvariantCulture, $"  {columns[c].Name} ({columns[c].DataType}): raw {text / 1024} KiB, lengths {lengths / 1024} KiB, typed {typed / 1024} KiB ({100.0 * (typed - lengths) / lengths:+0.0;-0.0}%)"));
        }
    }

    /// <summary>Bytes packed with and without typing, pack and unpack time a page (medians over every page, both forms
    /// timed alternately page by page so load on the machine falls on both), and that every typed page comes back.</summary>
    internal static string Compare(byte[][] pages)
    {
        if (pages.Length == 0) return "no pages";
        var lengths = new byte[pages.Length][];
        var typed = new byte[pages.Length][];
        var (packLengths, packTyped) = (new List<double>(), new List<double>());
        for (var i = 0; i < pages.Length; i++)
        {
            var watch = Stopwatch.StartNew();
            lengths[i] = PageCodec.Pack(pages[i], typed: false)!;
            packLengths.Add(watch.Elapsed.TotalMicroseconds);
            watch.Restart();
            typed[i] = PageCodec.Pack(pages[i])!;
            packTyped.Add(watch.Elapsed.TotalMicroseconds);
            if (!PageCodec.Unpack(typed[i], pages[i].Length).AsSpan().SequenceEqual(pages[i])) throw new InvalidOperationException("A typed page did not come back.");
        }
        var room = new byte[pages.Max(page => page.Length)];
        var (unpackLengths, unpackTyped) = (new List<double>(), new List<double>());
        for (var pass = 0; pass < 4; pass++)
            for (var i = 0; i < pages.Length; i++)
            {
                var watch = Stopwatch.StartNew();
                PageCodec.UnpackInto(lengths[i], room.AsSpan(0, pages[i].Length));
                var a = watch.Elapsed.TotalMicroseconds;
                watch.Restart();
                PageCodec.UnpackInto(typed[i], room.AsSpan(0, pages[i].Length));
                if (pass == 0) continue;
                unpackLengths.Add(a);
                unpackTyped.Add(watch.Elapsed.TotalMicroseconds);
            }
        double raw = pages.Sum(page => (long)page.Length), small = lengths.Sum(page => (long)page.Length), smaller = typed.Sum(page => (long)page.Length);
        static double Median(List<double> values) { values.Sort(); return values[values.Count / 2]; }
        return string.Create(CultureInfo.InvariantCulture,
            $"{pages.Length} pages, {raw / 1048576:F1} MiB; lengths {raw / small:F2}x, typed {raw / smaller:F2}x ({100 * (small - smaller) / small:F1}% smaller); pack {Median(packLengths):F0} -> {Median(packTyped):F0} us, unpack {Median(unpackLengths):F0} -> {Median(unpackTyped):F0} us a page ({Median(unpackTyped) / Median(unpackLengths):F2}x)");
    }
}
