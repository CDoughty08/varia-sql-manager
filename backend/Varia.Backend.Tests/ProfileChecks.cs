using System.Globalization;
using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Column profiles (results.profile): counts, NULLs, collation-aware distinct counts and their estimate past the
/// exact cap, lowest and highest values as a sort orders them, length figures from the stored lengths, histograms, the
/// rows' byte sizes, profiles through a view, and the method's limits and budget.</summary>
internal static class ProfileChecks
{
    // Latin1_General_CI_AS and Latin1_General_BIN2.
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);
    private static readonly ResultCollation Bin2 = new(1033, 0, 1252, false, 16384);

    private static readonly ResultColumn[] Columns =
    [
        new("id", "int", "text"), new("amount", "decimal", "text", Precision: 10, Scale: 2), new("name", "nvarchar", "text", Collation: CaseInsensitive),
        new("code", "varchar", "text", Collation: Bin2), new("blob", "varbinary", "binary"), new("at", "datetime2", "text"), new("key", "uniqueidentifier", "text")
    ];

    private static readonly object?[][] Rows =
    [
        ["10", "1.50", "b", "b", new byte[] { 2 }, "2024-01-01 00:00:00.0000000", "00000000-0000-0000-0000-000000000001"],
        [null, "1.5", "A", "A", new byte[] { 1, 0 }, "2024-01-02 00:00:00.0000000", "00000000-0000-0000-0000-000000000001"],
        ["2", "-0.00", "a  ", "a  ", null, null, null],
        ["-5", "0", "B", "B", new byte[] { 1 }, "2024-01-11 00:00:00.0000000", "00000000-0000-0000-0000-000000000002"],
        ["2", null, null, null, new byte[] { 1, 0, 0 }, "2024-01-06 00:00:00.0000000", "00000000-0000-0000-0000-000000000003"]
    ];

    public static void Run(Action<bool, string> check)
    {
        Figures(check);
        Estimates(check);
        Pages(check);
        Charged(check);
        Requests(check);
        Hashes(check);
    }

    private static ResultSetBuffer Fill(ResultStore store, ResultColumn[] columns, IEnumerable<object?[]> rows)
    {
        var wires = columns.Select(column => column.Wire == "binary" ? WireKind.Binary : WireKind.Text).ToArray();
        var set = store.Open(store.BeginQuery("profiles-" + columns[0].Name), 0, 1, 1, "rows", columns, wires) ?? throw new InvalidOperationException("The result set was not kept.");
        foreach (var row in rows)
        {
            set.CountRow();
            var builder = set.BeginRow()!;
            for (var c = 0; c < row.Length; c++)
            {
                if (row[c] is null) builder.AppendNull();
                else if (row[c] is byte[] bytes) builder.AppendBinary(bytes);
                else builder.AppendText((string)row[c]!);
            }
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    private static ResultsProfileResult Profile(ResultSetBuffer set, ResultView? view, params int[] columns) =>
        ColumnProfiler.Profile(set, set.SealedSnapshot(), view, columns, set.IsComplete, CancellationToken.None);

    private static void Figures(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store, Columns, Rows);
        var all = Profile(set, null, 0, 1, 2, 3, 4, 5, 6);
        var (id, amount, name, code, blob, at, key) = (all.Columns[0], all.Columns[1], all.Columns[2], all.Columns[3], all.Columns[4], all.Columns[5], all.Columns[6]);
        check(all.Rows == 5 && all.Complete && id.Values == 4 && id.Nulls == 1 && id.Distinct == 3 && id.DistinctExact && id.Min == "-5" && id.Max == "10" && id.Chars is null && id.Bytes is null,
            "an int column's profile counts values, NULLs and distinct values, and its lowest and highest by number: " + Describe(id));
        check(id.Histogram is { Basis: "value", Low: -5, High: 10 } histogram && histogram.Counts.Length == ColumnProfiler.Bins && histogram.Counts.Sum() == 4
            && histogram.Counts[0] == 1 && histogram.Counts[^1] == 1, "a number column's histogram buckets its values from its lowest to its highest");
        check(amount.Distinct == 2 && amount.Min == "-0.00" && amount.Max == "1.50", "exact numerics are equal by value: 1.50 and 1.5, -0.00 and 0 are one value each: " + Describe(amount));
        check(name.Distinct == 2 && name.Min == "A" && name.Max == "b" && name.Chars is { Min: 1, Max: 3, Average: 1.5, Exact: true } && name.Bytes is { Min: 2, Max: 6, Average: 3 }
            && name.Histogram is { Basis: "chars", Low: 1, High: 3 }, "a case-insensitive column counts a and A as one value, ignores trailing spaces, and measures every character: " + Describe(name));
        check(code.Distinct == 4 && code.Min == "A" && code.Max == "b", "a _BIN2 column tells case apart and orders by code point, still ignoring trailing spaces: " + Describe(code));
        check(blob.Distinct == 4 && blob.Min == "0x01" && blob.Max == "0x02" && blob.Chars is null && blob.Bytes is { Min: 1, Max: 3, Exact: true } && blob.Histogram is { Basis: "bytes" },
            "a binary column compares bytes, shows its values as hex, and measures DATALENGTH: " + Describe(blob));
        check(at.Histogram is { Basis: "time" } times && times.Low < times.High && times.Counts.Sum() == 4 && at.Min == "2024-01-01 00:00:00.0000000" && at.Max == "2024-01-11 00:00:00.0000000",
            "a datetime2 column's histogram buckets its instants");
        check(key.Distinct == 3 && key.Histogram is null && key.Min == "00000000-0000-0000-0000-000000000001", "a uniqueidentifier column has no histogram");
        var sizes = set.RowBytes(0, 5);
        check(all.RowBytes is { } rowBytes && rowBytes.Min == sizes.Min() && rowBytes.Max == sizes.Max() && Math.Abs(rowBytes.Average - sizes.Average()) < 1e-9 && rowBytes.Exact,
            "a profile gives the rows' byte sizes from their stored sums");
        var none = Profile(set, null);
        check(none.Columns.Length == 0 && none.RowBytes?.Max == sizes.Max(), "a profile of no columns gives only the rows' byte sizes");
        var order = ViewSorter.Sort(set, set.SealedSnapshot(), [new ViewKey(0, true, SortMode.Value)], CancellationToken.None).Order;
        var view = store.AddView(set, order, [new ViewKey(0, true, SortMode.Value)], false, true, 0, null);
        var viewed = Profile(set, view, 0, 2);
        check(viewed.Rows == 5 && viewed.Columns[0].Distinct == 3 && viewed.Columns[0].Min == "-5" && viewed.Columns[1].Min == "A" && viewed.Columns[1].Chars?.Average == 1.5,
            "a profile through a view describes the view's rows");
        var partial = store.AddView(set, [3, 0], [new ViewKey(0, true, SortMode.Value)], false, true, 0, null);
        var some = Profile(set, partial, 0);
        check(some.Rows == 2 && some.Columns[0].Values == 2 && some.Columns[0].Min == "-5" && some.Columns[0].Max == "10" && some.RowBytes?.Max == Math.Max(sizes[0], sizes[3]),
            "a view holding only some rows profiles only those rows (filters build on this)");
        var longText = new string('x', 300) + "\U0001F600";
        var wide = Fill(store, [new("text", "nvarchar(max)", "text", Collation: Bin2), new("bin", "varbinary(max)", "binary")], [[longText, Enumerable.Repeat((byte)0xAB, 200).ToArray()]]);
        var cut = Profile(wide, null, 0, 1);
        check(cut.Columns[0].Max is { Length: ColumnProfiler.ValueChars + 1 } max && max.EndsWith('…') && cut.Columns[0].Chars?.Max == 302
            && cut.Columns[1].Max is { } hex && hex.StartsWith("0xABAB", StringComparison.Ordinal) && hex.EndsWith('…') && hex.Length <= ColumnProfiler.ValueChars + 1,
            "a long lowest or highest value is cut to 256 characters and marked, while its length is counted in full");
        var cancelled = false;
        try { ColumnProfiler.Profile(set, set.SealedSnapshot(), null, [0], true, new CancellationToken(true)); }
        catch (OperationCanceledException) { cancelled = true; }
        check(cancelled, "a cancelled profile stops");
    }

    /// <summary>Past 16,384 distinct values the count is an estimate within a few percent; few distinct values stay exact.</summary>
    private static void Estimates(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        const int count = 60_000;
        var set = Fill(store, [new("n", "bigint", "text"), new("same", "varchar(4)", "text", Collation: CaseInsensitive)],
            Enumerable.Range(0, count).Select(i => new object?[] { (i * 7L).ToString(CultureInfo.InvariantCulture), i % 2 == 0 ? "x" : "X" }));
        var result = Profile(set, null, 0, 1);
        var many = result.Columns[0];
        var error = Math.Abs(many.Distinct - count) / (double)count;
        check(!many.DistinctExact && error < 0.03 && many.Distinct <= count && result.Columns[1] is { Distinct: 1, DistinctExact: true, Values: count },
            "past the exact cap a distinct count is an estimate (" + many.Distinct + " for " + count + "), and a column of one value stays exact");
    }

    /// <summary>Rows over many pages: every page counts, the histogram's second pass sees every value, and a column of
    /// only NULLs has no lowest, highest or histogram.</summary>
    private static void Pages(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        const int count = 5000;
        var set = Fill(store, [new("n", "int", "text"), new("none", "int", "text")],
            Enumerable.Range(0, count).Select(i => new object?[] { i % 10 == 0 ? null : i.ToString(CultureInfo.InvariantCulture), null }));
        var pages = set.SealedSnapshot();
        var result = Profile(set, null, 0, 1);
        var n = result.Columns[0];
        check(pages.Length > 1 && result.Rows == count && n is { Values: 4500, Nulls: 500, Distinct: 4500, DistinctExact: true, Min: "1", Max: "4999" }
            && n.Histogram is { Basis: "value", Low: 1, High: 4999 } histogram && histogram.Counts.Sum() == 4500,
            "a profile over " + pages.Length + " pages counts every row and bins every value: " + Describe(n));
        check(result.Columns[1] is { Values: 0, Nulls: count, Distinct: 0, Min: null, Max: null, Histogram: null, Chars: null },
            "a column of only NULLs has no lowest, highest or histogram: " + Describe(result.Columns[1]));
        var sizes = ColumnProfiler.Profile(set, pages, null, [], true, CancellationToken.None);
        var each = set.RowBytes(0, count);
        check(sizes.Columns.Length == 0 && sizes.Rows == count && sizes.RowBytes is { } bytes && bytes.Min == each.Min() && bytes.Max == each.Max() && bytes == result.RowBytes,
            "a profile of no columns sizes every row of every page, as one with columns does");
    }

    /// <summary>Long values are charged as the profile keeps them, and a refusal ends it; the service returns every charge.</summary>
    private static void Charged(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var set = Fill(store, [new("doc", "xml", "text"), new("name", "nvarchar(max)", "text", Collation: CaseInsensitive)],
            new[] { 100_000, 200_000, 300_000 }.Select(size => new object?[] { new string('a', size), new string('b', size) }));
        long charged = 0;
        ColumnProfiler.Profile(set, set.SealedSnapshot(), null, [0, 1], true, CancellationToken.None, new ColumnProfiler.Charges(bytes => { charged += bytes; return true; }));
        // Each column keeps a lowest and a highest key; the longest is 300,000 bytes (xml compares its stored text).
        check(charged >= 2 * 300_000, "a profile charges the long keys it keeps (" + charged + " bytes)");
        string refused;
        try { ColumnProfiler.Profile(set, set.SealedSnapshot(), null, [0], true, CancellationToken.None, new ColumnProfiler.Charges(bytes => bytes < 50_000)); refused = "ran"; }
        catch (ColumnProfiler.ProfileTooLargeException) { refused = "TOO_LARGE"; }
        check(refused == "TOO_LARGE", "a profile whose long keys the budget refuses stops");
        var baseline = store.UsedBytes;
        var answered = (ResultsProfileResult)service.DispatchAsync("results.profile", JsonSerializer.SerializeToElement(new { resultId = set.ResultId, columns = new[] { 0, 1 } }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        check(answered.Columns[0].Max?.Length == ColumnProfiler.ValueChars + 1 && store.UsedBytes == baseline, "results.profile returns what it charged for long keys");
    }

    private static void Requests(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var set = Fill(store, Columns, Rows);
        var baseline = store.UsedBytes;
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        string? Code(object args)
        {
            try { Call<object>("results.profile", args); return null; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "INVALID_PARAMS"; }
        }
        var result = Call<ResultsProfileResult>("results.profile", new { resultId = set.ResultId, columns = new[] { 2, 0 } });
        check(SqlService.MethodNames.Contains("results.profile") && service.LaneOf("results.profile") == RequestLane.Results && result.Columns.Select(column => column.Column).SequenceEqual([2, 0])
            && store.UsedBytes == baseline, "results.profile answers the columns asked, in order, and returns its working memory");
        var view = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 2, descending = false, mode = "value" } } });
        var viewed = Call<ResultsProfileResult>("results.profile", new { resultId = set.ResultId, columns = new[] { 0 }, viewId = view.ViewId });
        check(viewed.Rows == 5 && viewed.Columns[0].Distinct == 3, "results.profile reads through a view");
        var codes = new[]
        {
            Code(new { resultId = set.ResultId, columns = Enumerable.Range(0, ColumnProfiler.MaxColumns + 1).ToArray() }),
            Code(new { resultId = set.ResultId, columns = new[] { 0, 0 } }),
            Code(new { resultId = set.ResultId, columns = new[] { 7 } }),
            Code(new { resultId = set.ResultId, columns = new[] { -1 } }),
            Code(new { resultId = set.ResultId, columns = new[] { 0 }, extra = 1 }),
            Code(new { resultId = set.ResultId, columns = new[] { 0 }, viewId = 0 }),
            Code(new { resultId = set.ResultId, columns = new[] { 0 }, viewId = 12345 }),
            Code(new { resultId = 999, columns = new[] { 0 } })
        };
        check(string.Join(",", codes) == "INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,VIEW_NOT_FOUND,RESULT_NOT_FOUND",
            "results.profile takes up to 32 distinct columns of the result, and a closed view answers VIEW_NOT_FOUND: " + string.Join(",", codes));
        var tight = new ResultStore(4096, 4096);
        using var small = new SqlService(tight);
        var cramped = Fill(tight, [new("id", "int", "text")], [["1"]]);
        var before = tight.UsedBytes;
        string? refused;
        try { small.DispatchAsync("results.profile", JsonSerializer.SerializeToElement(new { resultId = cramped.ResultId, columns = new[] { 0 } }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); refused = null; }
        catch (RequestException error) { refused = error.Code; }
        check(refused == "TOO_LARGE" && tight.UsedBytes == before, "a profile the budget has no room for answers TOO_LARGE and takes nothing");
    }

    private static void Hashes(Action<bool, string> check)
    {
        var seen = new HashSet<ulong>();
        for (var i = 0; i < 100_000; i++) seen.Add(ColumnProfiler.Hash(BitConverter.GetBytes(i)));
        check(seen.Count == 100_000 && ColumnProfiler.Hash("a"u8) != ColumnProfiler.Hash("b"u8), "the distinct hash tells 100,000 nearby keys apart");
    }

    private static string Describe(ColumnProfile profile) =>
        $"values {profile.Values}, nulls {profile.Nulls}, distinct {profile.Distinct}, min {profile.Min}, max {profile.Max}";
}
