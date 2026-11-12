using System.Text;
using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Result views (results.view, results.viewClose, and results.read and results.rowBytes through a view): ORDER BY
/// order by SQL type and collation with NULL lowest, the text length modes, stable ties, the view registry's budget and
/// limits, and pages built in view order.</summary>
internal static class ViewChecks
{
    // Latin1_General_CI_AS (IgnoreCase, IgnoreKanaType, IgnoreWidth) and Latin1_General_BIN2.
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);
    private static readonly ResultCollation Bin2 = new(1033, 0, 1252, false, 16384);

    private static readonly ResultColumn[] Columns =
    [
        new("id", "int", "text"), new("amount", "decimal", "text", Precision: 38, Scale: 2), new("score", "float", "text"),
        new("at", "datetimeoffset", "text"), new("key", "uniqueidentifier", "text"), new("name", "nvarchar", "text", Collation: CaseInsensitive),
        new("code", "varchar", "text", Collation: Bin2), new("blob", "varbinary", "binary"), new("note", "nvarchar(20)", "text")
    ];
    private static readonly WireKind[] Wires = [.. Columns.Select(column => column.Wire == "binary" ? WireKind.Binary : WireKind.Text)];

    /// <summary>Rows: id, amount, score, at, key, name, code, blob, note (null for NULL).</summary>
    private static readonly object?[][] Rows =
    [
        ["10", "12345678901234567890123456789012.50", "1E+20", "2024-01-01 10:00:00.0000000 +02:00", "00000000-0000-0000-0000-010000000000", "b", "b", new byte[] { 2 }, "a  "],
        [null, "-0.00", "-1.5", "2024-01-01 09:00:00.0000000 +00:00", "FF000000-0000-0000-0000-000000000000", "A", "A", new byte[] { 1, 0 }, "bb"],
        ["2", "12345678901234567890123456789012.25", null, null, null, "a  ", "a", null, null],
        ["-5", "0", "3", "2023-12-31 23:00:00.0000000 -05:00", "00000000-0000-0000-0000-000000000001", "B", "B", new byte[] { 1 }, "c"],
        ["2", null, "3", "2024-01-01 08:00:00.0000000 +00:00", "00000000-0000-0000-0001-000000000000", null, null, new byte[] { 1, 0, 0 }, "dddd"]
    ];

    public static void Run(Action<bool, string> check)
    {
        Ordering(check);
        WholeKeys(check);
        Registry(check);
        HostReads(check);
        Jobs(check).GetAwaiter().GetResult();
        Instants(check);
        check(ViewSorter.CompareNumericText("12345678901234567890123456789012.5"u8, "12345678901234567890123456789012.25"u8) > 0
            && ViewSorter.CompareNumericText("-0.00"u8, "0"u8) == 0 && ViewSorter.CompareNumericText("-10"u8, "-9.5"u8) < 0 && ViewSorter.CompareNumericText("0.10"u8, "0.1"u8) == 0,
            "exact numerics compare as numbers at any precision: digits past double's, a negative zero, and trailing zeros");
    }

    /// <summary>Date and time text read directly is what the general parser reads: the same ticks for the text the backend
    /// writes, and nothing for any other text, which the general parser is then left to read.</summary>
    private static void Instants(Action<bool, string> check)
    {
        var invariant = System.Globalization.CultureInfo.InvariantCulture;
        string[] written =
        [
            "2024-01-01", "0001-01-01", "9999-12-31", "2024-02-29", "2024-01-01 10:20:30", "2024-01-01 10:20:30.5", "2024-01-01 10:20:30.123", "2024-01-01 23:59:59.9999999",
            "1900-01-01 00:00:00.0000000", "10:20:30", "23:59:59.9999999", "00:00:00.0000001", "2024-01-01 10:00:00.0000000 +02:00", "2024-01-01 10:00:00.0000000 -05:30",
            "0001-01-01 00:00:00.0000000 +00:00", "9999-12-31 23:59:59.9999999 -14:00", "2024-06-30 12:00:00 +14:00"
        ];
        string[] other =
        [
            "", "2024-1-1", "2023-02-29", "2024-13-01", "2024-01-32", "0000-01-01", "2024-01-01T10:20:30", "2024-01-01 24:00:00", "2024-01-01 10:60:00", "2024-01-01 10:20:60",
            "2024-01-01 10:20:30.", "2024-01-01 10:20:30.12345678", "2024-01-01 10:20", "2024-01-01 ", "10:20", "1.10:20:30", "2024-01-01 10:00:00 +15:00", "2024-01-01 10:00:00 +14:30",
            "2024-01-01 10:00:00 Z", "2024-01-01 10:00:00+02:00", " 2024-01-01", "2024-01-01 10:00:00 +02:0", "abcd-ef-gh", "2024-01-01 1a:00:00", "Jan 1 2024"
        ];
        var same = new List<string>();
        var wrong = new List<string>();
        foreach (var text in written)
        {
            var read = ViewSorter.TryInstant(Encoding.UTF8.GetBytes(text), out var ticks, out var offset, out var dated, out var zoned);
            long? expected = zoned ? (DateTimeOffset.TryParse(text, invariant, System.Globalization.DateTimeStyles.None, out var instant) ? instant.UtcTicks : null)
                : dated ? (DateTime.TryParse(text, invariant, System.Globalization.DateTimeStyles.None, out var date) ? date.Ticks : null)
                : TimeSpan.TryParse(text, invariant, out var time) ? time.Ticks : null;
            // The last instant of year 9999 at -14:00 is past the range once in UTC: read as written, and left to the general parser as an instant.
            var utc = zoned ? ViewSorter.UtcTicks(Encoding.UTF8.GetBytes(text)) : ticks;
            if (read && (zoned ? utc == expected : ticks == expected)) same.Add(text);
            else wrong.Add(text);
        }
        foreach (var text in other)
            if (ViewSorter.TryInstant(Encoding.UTF8.GetBytes(text), out _, out _, out _, out _)) wrong.Add(text);
        check(wrong.Count == 0 && same.Count == written.Length, "date and time text read directly gives the general parser's ticks for the text the backend writes, and declines any other: " + string.Join(" | ", wrong));
    }

    private static ResultSetBuffer Fill(ResultStore store)
    {
        var set = store.Open(store.BeginQuery("views"), 0, 1, 1, "rows", Columns, Wires) ?? throw new InvalidOperationException("The result set was not kept.");
        foreach (var row in Rows)
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

    private static int[] Order(ResultSetBuffer set, params (int Column, bool Descending, SortMode Mode)[] keys) =>
        ViewSorter.Sort(set, set.SealedSnapshot(), [.. keys.Select(key => new ViewKey(key.Column, key.Descending, key.Mode))], CancellationToken.None).Order;

    private static string Show(int[] order) => string.Join(",", order);

    /// <summary>Copy and Save through a view write its rows in its order; a closed view is VIEW_NOT_FOUND.</summary>
    private static async Task Jobs(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var jobs = new ResultJobs(store);
        var set = Fill(store);
        var view = (ResultsViewResult)(await service.DispatchAsync("results.view", JsonSerializer.SerializeToElement(new { resultId = set.ResultId, sort = new[] { new { column = 0, descending = false, mode = "value" } } }, HostChecks.Json), HostChecks.Json))!;
        static string[] Lines(byte[] text) => [.. Encoding.UTF8.GetString(text).Split('\n').Select(line => line.TrimEnd('\r')).Where(line => line.Length > 0)];
        var copied = await TextChecks.Copy(jobs, new ResultsCopyArgs(set.ResultId, [new([[1, 4]], [[0, 0]])], false, "crlf", 1 << 20, view.ViewId));
        var plain = await TextChecks.Copy(jobs, new ResultsCopyArgs(set.ResultId, [new([[1, 4]], [[0, 0]])], false, "crlf", 1 << 20));
        check(string.Join("|", Lines(copied.Text)) == "-5|2|2|10" && copied.Result is { Rows: 4, Partial: false } && string.Join("|", Lines(plain.Text)) == "NULL|2|-5|2",
            "a copy through a view copies its positions, in its order (" + string.Join("|", Lines(copied.Text)) + ")");
        var folder = Directory.CreateTempSubdirectory("varia-view-");
        try
        {
            var target = Path.Combine(folder.FullName, "sorted.csv");
            var saved = await jobs.ExportAsync(new ResultsExportArgs(set.ResultId, target, "csv", true, "empty", Guid.NewGuid().ToString("N"), view.ViewId), null);
            var ids = Encoding.UTF8.GetString(File.ReadAllBytes(target)).Split("\r\n").Skip(1).Where(line => line.Length > 0).Select(line => line.Split(',')[0]);
            check(saved.Rows == 5 && string.Join("|", ids) == "|-5|2|2|10", "a save through a view writes every row in its order (" + string.Join("|", ids) + ")");
        }
        finally { folder.Delete(true); }
        store.CloseViews(set.ResultId, [view.ViewId]);
        string? code = null;
        try { await TextChecks.Copy(jobs, new ResultsCopyArgs(set.ResultId, [new([[0, 0]], [[0, 0]])], false, "crlf", 1 << 20, view.ViewId)); }
        catch (RequestException error) { code = error.Code; }
        check(code == "VIEW_NOT_FOUND", "a copy through a closed view is VIEW_NOT_FOUND (" + code + ")");
    }

    /// <summary>A key that only says how many of its comparisons would read their cells again.</summary>
    private sealed class SlowKey(double share) : ViewSorter.Key(0)
    {
        public override double TieShare => share;
        public override void Set(int row, ReadOnlySpan<byte> cell, ViewSorter.Scratch scratch) { }
        public override int Compare(int a, int b) => 0;
    }

    /// <summary>A collated column's whole sort keys, the budget they come from, and the threads keys are built and rows sorted
    /// on: whatever the memory and however many threads, the order is the one comparing the cells gives.</summary>
    private static void WholeKeys(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        ResultColumn[] columns = [new("id", "int", "text"), new("name", "nvarchar", "text", Collation: CaseInsensitive), new("code", "nvarchar", "text", Collation: CaseInsensitive), new("path", "nvarchar", "text", Collation: CaseInsensitive)];
        var set = store.Open(store.BeginQuery("whole"), 0, 1, 1, "rows", columns, [WireKind.Text, WireKind.Text, WireKind.Text, WireKind.Text]) ?? throw new InvalidOperationException("The result set was not kept.");
        // Names share their first characters, repeat (each some thirty times, in either case) and are NULL now and then.
        // Paths are each their own and start alike, but for a few rows: other text, less of the start, or none.
        string[] others = ["", "/srv", "Zed", "/srv/data/customers", "/opt/data"];
        const int rows = 150_000;
        var names = new HashSet<uint>();
        for (var i = 0; i < rows; i++)
        {
            var scrambled = (uint)i * 2654435761u % 5_000;
            set.CountRow();
            var builder = set.BeginRow()!;
            builder.AppendText(i.ToString(System.Globalization.CultureInfo.InvariantCulture));
            if (i % 97 == 0) builder.AppendNull();
            else
            {
                names.Add(scrambled);
                builder.AppendText("Customer " + scrambled.ToString("D8", System.Globalization.CultureInfo.InvariantCulture) + (i % 2 == 0 ? " gmbh" : " GMBH"));
            }
            builder.AppendText(((uint)i * 2246822519u).ToString("X8", System.Globalization.CultureInfo.InvariantCulture));
            if (i % 7919 == 5) builder.AppendText(others[i / 7919 % others.Length]);
            else builder.AppendText("/srv/data/customers/" + ((uint)i * 2654435761u % 10_000_000).ToString("D7", System.Globalization.CultureInfo.InvariantCulture) + "/Invoice.pdf");
            set.TryCommitRow();
        }
        set.Complete();
        var pages = set.SealedSnapshot();
        var none = CancellationToken.None;
        long reserved = 0, returned = 0, asked = 0;
        var counted = new ViewSorter.KeyMemory(bytes => { Interlocked.Add(ref reserved, bytes); return true; }, bytes => Interlocked.Add(ref returned, bytes));
        var refusing = new ViewSorter.KeyMemory(_ => false, _ => { });
        // Room for a few pages' keys, then none: the ones kept are let go.
        var some = new ViewSorter.KeyMemory(bytes => Interlocked.Add(ref asked, bytes) <= 400_000, _ => { });
        ViewKey[] byName = [new(1, false, SortMode.Value)];
        var whole = ViewSorter.Build(set, pages, byName, [], none, counted).Order;
        var cells = ViewSorter.Build(set, pages, byName, [], none, refusing).Order;
        var partly = ViewSorter.Build(set, pages, byName, [], none, some).Order;
        int[] alone;
        var workers = ViewSorter.Workers;
        try
        {
            ViewSorter.Workers = 1;
            alone = ViewSorter.Build(set, pages, byName, [], none, refusing).Order;
        }
        finally { ViewSorter.Workers = workers; }
        check(pages.Length > 8 && whole.AsSpan().SequenceEqual(cells) && whole.AsSpan().SequenceEqual(partly) && whole.AsSpan().SequenceEqual(alone)
            && whole[0] == 0 && whole[1] == 97 && whole[rows / 97 + 1] % 97 != 0,
            "a collated sort gives one order with its whole sort keys, without them, with only some pages' and on one thread: NULLs first in row order, then the values");
        check(reserved > 0 && reserved == returned && asked > 400_000,
            "a collated key reserves what it holds beyond its rows' fixed bytes as it grows and returns it with the build (" + reserved + " bytes reserved, " + returned + " returned)");

        // Filters and a second key go through the same keys: duplicates of a name, by name descending then code.
        ViewKey[] twoKeys = [new(1, true, SortMode.Value), new(2, false, SortMode.Value)];
        ViewFilter[] duplicates = [new(FilterOp.Duplicates, 0, null, false, null, [1])];
        var kept = ViewSorter.Build(set, pages, twoKeys, duplicates, none, counted).Order;
        var keptCells = ViewSorter.Build(set, pages, twoKeys, duplicates, none, refusing).Order;
        var listed = ViewSorter.DistinctValues(set, pages, null, 1, true, none, null, counted);
        var listedCells = ViewSorter.DistinctValues(set, pages, null, 1, true, none, null, refusing);
        // Ranked values are grouped by their ranks in one pass; without the ranks, by a sort. The same groups either way.
        var grouped = ViewSorter.Build(set, pages, [], duplicates, none, counted).Order;
        var groupedCells = ViewSorter.Build(set, pages, [], duplicates, none, refusing).Order;
        string Listed(DistinctSnapshot snapshot) => JsonSerializer.Serialize(new { byValue = snapshot.Read(DistinctOrder.Value, 0, ViewSorter.MaxDistinctWindow, null, none), byCount = snapshot.Read(DistinctOrder.Count, 0, ViewSorter.MaxDistinctWindow, null, none), frozen = snapshot.Freeze().Rows, snapshot.Nulls, snapshot.Rows }, HostChecks.Json);
        var ids = ViewSorter.DistinctValues(set, pages, null, 0, true, none, null, counted);
        check(grouped.Length == kept.Length && grouped.AsSpan().SequenceEqual(groupedCells) && grouped[0] == 0 && grouped[1] == 97 && Listed(listed) == Listed(listedCells)
            && ids.Distinct == rows && ViewSorter.Build(set, pages, [], [new ViewFilter(FilterOp.Duplicates, 0, null, false, null, [0])], none, counted).Order.Length == 0,
            "duplicates and distinct values grouped by rank in one pass are the ones a sort groups, in the same order; more values than are grouped that way (" + ids.Distinct + ") are sorted");
        check(kept.Length > rows / 2 && kept.AsSpan().SequenceEqual(keptCells) && listed.Distinct == names.Count && listedCells.Distinct == names.Count && reserved == returned,
            "filtered rows sorted by two keys, and a column's distinct values, are the same with whole sort keys and without (" + kept.Length + " rows kept, " + listed.Distinct + " values)");

        // Without its whole keys, a key says how many comparisons would read their cells again; a sort that would spend
        // minutes there is refused rather than run.
        var approximate = false;
        var source = new ViewSorter.PageSource(pages, columns.Length);
        var shared = ViewSorter.Build(set, source, byName[0], null, rows, none, ref approximate, refusing);
        var held = ViewSorter.Build(set, source, byName[0], null, rows, none, ref approximate, counted);
        static string? Refused(Action sort)
        {
            try { sort(); return null; }
            catch (RequestException error) { return error.Code + ": " + error.Message; }
        }
        check(shared.TieShare > 0.2 && held.TieShare == 0 && held.Layout.StartsWith("ranked", StringComparison.Ordinal) && shared.Layout.StartsWith("prefix", StringComparison.Ordinal),
            "repeated values are ranked; without room for that or for whole sort keys, the key counts the rows that share their 8 bytes (" + shared.TieShare + "): " + held.Layout + " / " + shared.Layout);
        held.Drop();

        // Values that start alike leave their sort keys' shared bytes out; the few that start otherwise are marked and
        // compare by their whole keys, or by their cells without them.
        ViewKey[] byPath = [new(3, false, SortMode.Value)];
        var paths = ViewSorter.Build(set, source, byPath[0], null, rows, none, ref approximate, counted);
        var layout = paths.Layout.Split(", ");
        paths.Drop();
        var pathOrder = ViewSorter.Build(set, pages, byPath, [], none, counted).Order;
        var pathCells = ViewSorter.Build(set, pages, byPath, [], none, refusing).Order;
        var pathPartly = ViewSorter.Build(set, pages, byPath, [], none, new ViewSorter.KeyMemory(bytes => Interlocked.Add(ref asked, bytes) <= 1_200_000, _ => { })).Order;
        var codes = ViewSorter.Build(set, source, new ViewKey(2, false, SortMode.Value), null, rows, none, ref approximate, counted);
        var codeLayout = codes.Layout;
        codes.Drop();
        check(layout is ["whole", var start, var marked] && int.Parse(start.Split(' ')[0]) >= 8 && int.Parse(marked.Split(' ')[0]) == rows / 7919 + 1
            && pathOrder.AsSpan().SequenceEqual(pathCells) && pathOrder.AsSpan().SequenceEqual(pathPartly) && pathOrder[0] % 7919 == 5 && pathOrder[^1] % 7919 == 5
            && codeLayout.StartsWith("whole, 0 shared", StringComparison.Ordinal) && reserved == returned,
            "values that start alike drop their sort keys' shared bytes, the rows that start otherwise sort among them all the same, and values that share no start drop none: " + paths.Layout + " / " + codeLayout);
        check(reserved == returned && Refused(() => ViewSorter.ThrowIfSlow([new SlowKey(1)], int.MaxValue)) == "TOO_LARGE: " + ViewSorter.TooSlow
            && Refused(() => ViewSorter.ThrowIfSlow([new SlowKey(0), new SlowKey(1)], int.MaxValue)) is not null
            && Refused(() => ViewSorter.ThrowIfSlow([new SlowKey(1)], 1 << 16)) is null && Refused(() => ViewSorter.ThrowIfSlow([new SlowKey(0)], int.MaxValue)) is null,
            "a sort whose ties would read cells for minutes is refused as TOO_LARGE; a small one, or one whose keys settle their ties, is not");

        // The parallel sort is the sort: any range, the same order as one thread's.
        var values = new int[200_003];
        var random = new Random(7);
        for (var i = 0; i < values.Length; i++) values[i] = random.Next(5_000);
        var comparer = Comparer<int>.Create((a, b) => values[a] != values[b] ? values[a].CompareTo(values[b]) : a.CompareTo(b));
        var sorted = new int[values.Length];
        var expected = new int[values.Length];
        for (var i = 0; i < values.Length; i++) sorted[i] = expected[i] = values.Length - 1 - i;
        Array.Sort(expected, 7, values.Length - 20, comparer);
        ViewSorter.Sort(sorted, 7, values.Length - 20, comparer);
        string? cancelled = null;
        using (var stop = new CancellationTokenSource())
        {
            stop.Cancel();
            try { ViewSorter.Build(set, pages, byName, [], stop.Token, counted); }
            catch (OperationCanceledException) { cancelled = "cancelled"; }
        }
        check(sorted.AsSpan().SequenceEqual(expected) && cancelled == "cancelled" && reserved == returned,
            "a sort on several threads orders a range as one thread does and leaves the rest alone; a cancelled build stops as a cancellation and returns its keys");
    }

    private static void Ordering(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store);
        var ids = Order(set, (0, false, SortMode.Value));
        var idsDown = Order(set, (0, true, SortMode.Value));
        check(Show(ids) == "1,3,2,4,0" && Show(idsDown) == "0,2,4,3,1",
            "an int column sorts as numbers with NULL first ascending and last descending, and equal values keep their row order (" + Show(ids) + " / " + Show(idsDown) + ")");
        check(Show(Order(set, (1, false, SortMode.Value))) == "4,1,3,2,0", "decimal(38) values past double's precision still order exactly, and -0.00 ties 0 in row order");
        check(Show(Order(set, (2, false, SortMode.Value))) == "2,1,3,4,0", "float values sort as doubles, 1E+20 last");
        // Equal doubles are equal values while no cell has more digits than a double keeps, so those ties never read the
        // pages; one longer cell and ties compare their text again.
        int[] Exact(params string[] values)
        {
            var numbers = store.Open(store.BeginQuery("exact" + Guid.NewGuid()), 0, 1, 1, "rows", [new("n", "decimal", "text", Precision: 38, Scale: 2)], [WireKind.Text])
                ?? throw new InvalidOperationException("The result set was not kept.");
            foreach (var value in values)
            {
                numbers.CountRow();
                numbers.BeginRow()!.AppendText(value);
                numbers.TryCommitRow();
            }
            numbers.Complete();
            return Order(numbers, (0, false, SortMode.Value));
        }
        var shortTies = Exact("1.50", "0", "1.5", "-0.00", "2", "1.50");
        var atLimit = Exact("100000000000002", "100000000000001", "-99999999999.99", "100000000000001", "-99999999999.98");
        var pastLimit = Exact("9007199254740993", "1.50", "9007199254740992", "1.5", "9007199254740993", "9007199254740992.5");
        check(Show(shortTies) == "1,3,0,2,5,4" && Show(atLimit) == "2,4,1,3,0" && Show(pastLimit) == "1,3,2,5,0,4",
            "exact numerics tie by value in row order whether their doubles settle it (15 characters or fewer) or their text does (a longer cell in the column): "
            + Show(shortTies) + " / " + Show(atLimit) + " / " + Show(pastLimit));
        check(Show(Order(set, (3, false, SortMode.Value))) == "2,3,0,4,1", "datetimeoffset sorts by its UTC instant, not its display text");
        check(Show(Order(set, (4, false, SortMode.Value))) == "2,1,4,3,0", "uniqueidentifier sorts in SQL Server's byte order (its last six bytes first)");
        check(Show(Order(set, (5, false, SortMode.Value))) == "4,1,2,0,3",
            "a case-insensitive collation sorts A and 'a  ' together (trailing spaces ignored) in row order, then b and B");
        check(Show(Order(set, (6, false, SortMode.Value))) == "4,1,3,2,0", "a _BIN2 collation sorts by code point: capitals first");
        check(Show(Order(set, (7, false, SortMode.Value))) == "2,3,1,4,0", "varbinary sorts byte by byte, a prefix first");
        check(Show(Order(set, (8, false, SortMode.Chars))) == "2,3,1,0,4" && Show(Order(set, (8, false, SortMode.Bytes))) == "2,3,1,0,4"
            && Show(Order(set, (8, false, SortMode.Value))) == "2,0,1,3,4",
            "a text column sorts by each value's characters (spaces count) or bytes, or by its text");
        check(Show(Order(set, (5, false, SortMode.Value), (0, true, SortMode.Value))) == "4,2,1,0,3" && Show(Order(set, (6, true, SortMode.Value), (0, false, SortMode.Value))) == "0,2,3,1,4",
            "later keys order rows the first key ties");
        check(Show(Order(set, (0, false, SortMode.Chars))) == Show(ids), "a length mode on a column that is not text sorts it by value");
        check(Show(Order(set, (7, false, SortMode.Chars))) == Show(Order(set, (7, false, SortMode.Value))), "Chars sorts a binary column by value, as documented");
        var cancelled = false;
        try { ViewSorter.Sort(set, set.SealedSnapshot(), [new ViewKey(0, false, SortMode.Value)], new CancellationToken(canceled: true)); }
        catch (OperationCanceledException) { cancelled = true; }
        check(cancelled, "a Stop ends a sort");
        var view = store.AddView(set, ids, [new ViewKey(0, false, SortMode.Value)], false, true, 0, null);
        var pages = ViewPages.Build(view, 1, 3).Select(body => PageReader.Read(body, Wires)).ToList();
        var shown = pages.SelectMany(page => page.Rows).Select(row => row[0].Text ?? "NULL").ToList();
        check(pages.Count == 1 && pages[0].FirstRow == 1 && pages[0].ResultId == set.ResultId && string.Join(",", shown) == "-5,2,2" && pages[0].Rows[1][7].Flags == PageReader.Null,
            "a view's pages hold its rows in view order, numbered by view position, with each cell's flags");
        var estimated = new List<long>();
        var bytes = ViewPages.RowBytes(view, 0, 10, estimated);
        check(bytes.Length == 5 && bytes.SequenceEqual(view.Order.Select(row => set.RowBytes(row, 1)[0])), "row sizes through a view follow its order");
    }

    private static void Registry(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var set = Fill(store);
        var baseline = store.UsedBytes;
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        string? Code(string method, object args)
        {
            try { Call<object>(method, args); return null; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "INVALID_PARAMS"; }
        }
        var first = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 0, descending = false, mode = "value" } } });
        var held = store.UsedBytes - baseline;
        check(SqlService.MethodNames.Contains("results.view") && SqlService.MethodNames.Contains("results.viewClose") && first.Rows == 5 && first.Complete && !first.Approximate
            && held == 4 * 5 + ResultStore.ViewOverhead, "results.view sorts a result and keeps only its order, charged to the result's budget (" + held + " bytes)");
        var second = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 5, descending = true, mode = "value" } }, replaces = first.ViewId });
        check(store.FindView(set.ResultId, first.ViewId) is null && store.FindView(set.ResultId, second.ViewId) is not null && store.UsedBytes - baseline == held,
            "a view that replaces another closes it and returns its memory");
        for (var i = 0; i < ResultStore.MaxViewsPerResult; i++) Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 1, descending = false, mode = "value" } } });
        check(store.ViewCount == ResultStore.MaxViewsPerResult && store.FindView(set.ResultId, second.ViewId) is null && store.UsedBytes - baseline == held * ResultStore.MaxViewsPerResult,
            "a result keeps at most 8 views: a ninth replaces its oldest");
        var codes = new[]
        {
            Code("results.view", new { resultId = set.ResultId, sort = Array.Empty<object>() }),
            Code("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 9, descending = false, mode = "value" } } }),
            Code("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 0, descending = false, mode = "value" }, new { column = 0, descending = true, mode = "value" } } }),
            Code("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 0, descending = false, mode = "length" } } }),
            Code("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 0, descending = false, mode = "value", extra = 1 } } }),
            Code("results.view", new { resultId = 999, sort = new[] { new { column = 0, descending = false, mode = "value" } } }),
            Code("results.rowBytes", new { resultId = set.ResultId, firstRow = 0, count = 1, viewId = 12345 }),
            Code("results.viewClose", new { resultId = set.ResultId, viewIds = Array.Empty<uint>() })
        };
        check(string.Join(",", codes) == "INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,RESULT_NOT_FOUND,VIEW_NOT_FOUND,INVALID_PARAMS",
            "results.view needs 1 to 16 distinct columns of the result and a known mode, and a closed view answers VIEW_NOT_FOUND: " + string.Join(",", codes));
        var other = Fill(store);
        var foreign = Call<ResultsViewResult>("results.view", new { resultId = other.ResultId, sort = new[] { new { column = 0, descending = false, mode = "value" } } });
        var closedForeign = Call<ResultsViewCloseResult>("results.viewClose", new { resultId = set.ResultId, viewIds = new[] { foreign.ViewId } });
        check(closedForeign.Closed == 0 && store.FindView(set.ResultId, foreign.ViewId) is null && store.FindView(other.ResultId, foreign.ViewId) is not null,
            "a view is reached only through its own result");
        var sizes = Call<ResultsRowBytesResult>("results.rowBytes", new { resultId = other.ResultId, firstRow = 0, count = 10, viewId = foreign.ViewId });
        check(sizes.Bytes.Length == 5 && sizes.RowsAvailable == 5, "results.rowBytes reads through a view");
        var closed = Call<ResultsViewCloseResult>("results.viewClose", new { resultId = other.ResultId, viewIds = new[] { foreign.ViewId, foreign.ViewId } });
        store.Release(set.ResultId);
        store.Release(other.ResultId);
        check(closed.Closed == 1 && store.ViewCount == 0 && store.UsedBytes == 0, "closing a view or releasing its result returns every byte the views held");
        var tight = new ResultStore(4096, 4096);
        using var small = new SqlService(tight);
        var cramped = tight.Open(tight.BeginQuery("tight"), 0, 1, 1, "rows", [new("id", "int", "text")], [WireKind.Text])!;
        for (var row = 0; row < 10_000; row++)
        {
            if (cramped.BeginRow() is not { } builder) break;
            builder.AppendText(row.ToString(System.Globalization.CultureInfo.InvariantCulture));
            cramped.TryCommitRow();
        }
        cramped.Complete();
        var before = tight.UsedBytes;
        string? refused;
        try { small.DispatchAsync("results.view", JsonSerializer.SerializeToElement(new { resultId = cramped.ResultId, sort = new[] { new { column = 0, descending = false, mode = "value" } } }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); refused = null; }
        catch (RequestException error) { refused = error.Code; }
        check(refused == "TOO_LARGE" && tight.UsedBytes == before, "a sort the budget has no room for answers TOO_LARGE and takes nothing");
    }

    /// <summary>results.read through a view, over ProtocolHost with the real service and synthetic results.</summary>
    private static void HostReads(Action<bool, string> check)
    {
        using var host = new HostHarness(dispatcher: () => new SqlService(new ResultStore(1L << 30, 1L << 29), hooks: true));
        host.Hello();
        host.Request(1, SqlService.SynthesizeMethod, new { shape = "W1", rows = 10_000 });
        var id = JsonBridge.ParseControl(host.Next(FrameKind.Response, 15_000)!.Value.Body).GetProperty("result").GetProperty("resultId").GetUInt32();
        host.Request(2, "results.view", new { resultId = id, sort = new[] { new { column = 0, descending = true, mode = "value" } } });
        var view = JsonBridge.ParseControl(host.Next(FrameKind.Response, 15_000)!.Value.Body).GetProperty("result");
        var viewId = view.GetProperty("viewId").GetUInt32();
        host.Request(3, "results.read", new { resultId = id, firstRow = 5000, maxRows = 5000, viewId }, credit: 16 * 1024 * 1024);
        var endFrame = host.Next(FrameKind.Response, 15_000);
        var frames = new List<Frame>();
        while (host.Next(FrameKind.Data, 0) is { } data) frames.Add(data);
        var end = JsonBridge.ParseControl(endFrame!.Value.Body).GetProperty("result");
        var wires = SyntheticRows.Columns("W1").Select(column => column.Wire).ToList();
        var decoded = frames.Select(frame => PageReader.Read(frame.Body, wires)).ToList();
        var ids = decoded.SelectMany(page => page.Rows).Select(row => int.Parse(row[0].Text!, System.Globalization.CultureInfo.InvariantCulture)).ToList();
        check(view.GetProperty("rows").GetInt64() == 10_000 && decoded.Count > 0 && decoded[0].FirstRow == 5000 && ids.Count == 5000 && ids[0] == 4999 && ids[^1] == 0
            && ids.Zip(ids.Skip(1)).All(pair => pair.First == pair.Second + 1) && end.GetProperty("complete").GetBoolean() && end.GetProperty("nextRow").GetInt64() == 10_000
            && end.GetProperty("rowsAvailable").GetInt64() == 10_000, "results.read through a view streams its rows in view order from the position asked, and ends complete");
        host.Request(4, "results.viewClose", new { resultId = id, viewIds = new[] { viewId } });
        host.Next(FrameKind.Response, 15_000);
        host.Request(5, "results.read", new { resultId = id, firstRow = 0, maxRows = 10, viewId }, credit: 65_536);
        var closed = JsonBridge.ParseControl(host.Next(FrameKind.Response, 15_000)!.Value.Body);
        check(closed.TryGetProperty("error", out var error) && error.GetProperty("code").GetString() == "VIEW_NOT_FOUND", "a read through a closed view answers VIEW_NOT_FOUND");
    }
}
