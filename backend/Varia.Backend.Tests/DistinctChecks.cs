using System.Globalization;
using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Distinct snapshots (results.distinct and its windows, ticks and groups filter, the header funnel's checklist):
/// collation equality, NULL counted apart, counts and the two orders, a search, a view's rows, starting ticks from a kept
/// view, ticks by group, by search and for every value, the filter a snapshot freezes into, no cap on the values, long
/// values cut, and the methods' limits and budget.</summary>
internal static class DistinctChecks
{
    // Latin1_General_CI_AS and Latin1_General_BIN2.
    private static readonly ResultCollation CaseInsensitive = new(1033, 0, 1252, false, 1 | 8 | 16);
    private static readonly ResultCollation Bin2 = new(1033, 0, 1252, false, 16384);

    private static readonly ResultColumn[] Columns =
    [
        new("name", "nvarchar", "text", Collation: CaseInsensitive), new("code", "varchar", "text", Collation: Bin2),
        new("amount", "decimal", "text", Precision: 10, Scale: 2), new("blob", "varbinary", "binary")
    ];

    private static readonly object?[][] Rows =
    [
        ["b", "b", "1.50", new byte[] { 2 }],
        ["A", "A", "1.5", new byte[] { 1 }],
        ["a  ", "a  ", null, null],
        [null, null, "0", new byte[] { 1 }],
        ["B", "B", "-0.00", new byte[] { 1 }],
        ["a", "a", "2", null]
    ];

    public static void Run(Action<bool, string> check)
    {
        Values(check);
        Ticks(check);
        Filters(check);
        Uncapped(check);
        Requests(check);
    }

    private static ResultSetBuffer Fill(ResultStore store, ResultColumn[] columns, IEnumerable<object?[]> rows, bool complete = true)
    {
        var wires = columns.Select(column => column.Wire == "binary" ? WireKind.Binary : WireKind.Text).ToArray();
        var set = store.Open(store.BeginQuery("distinct-" + columns[0].Name), 0, 1, 1, "rows", columns, wires) ?? throw new InvalidOperationException("The result set was not kept.");
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
        if (complete) set.Complete();
        else set.Seal();
        return set;
    }

    private static DistinctSnapshot Snapshot(ResultSetBuffer set, int column, ResultView? view = null, ResultView? kept = null) =>
        ViewSorter.DistinctValues(set, set.SealedSnapshot(), view, column, set.IsComplete, CancellationToken.None, kept);

    private static DistinctValue[] List(DistinctSnapshot snapshot, DistinctOrder order = DistinctOrder.Count, string? search = null, int offset = 0, int count = ViewSorter.MaxDistinctWindow) =>
        snapshot.Read(order, offset, count, search, CancellationToken.None).Values;

    private static string Describe(DistinctSnapshot snapshot, DistinctValue[] values) =>
        $"rows {snapshot.Rows}, nulls {snapshot.Nulls}, distinct {snapshot.Distinct}: " + string.Join(", ", values.Select(value => $"{value.Text}@{value.Row}×{value.Count}{(value.Checked ? "" : "-")}"));

    private static int[] Kept(ResultSetBuffer set, DistinctSnapshot snapshot)
    {
        var (op, rows, nulls) = snapshot.Freeze();
        return ViewSorter.Build(set, set.SealedSnapshot(), [], [new ViewFilter(op, snapshot.Column, rows, nulls, null, [], 1)], CancellationToken.None).Order;
    }

    private static void Values(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store, Columns, Rows);
        var name = Snapshot(set, 0);
        var listed = List(name);
        check(name.Rows == 6 && name.Nulls == 1 && name.Distinct == 2 && listed is [{ Group: 0, Row: 1, Text: "A", Count: 3, Checked: true }, { Group: 1, Row: 0, Text: "b", Count: 2, Checked: true }],
            "a case-insensitive column counts a, A and 'a  ' as one value, shown by its lowest row, and NULL apart: " + Describe(name, listed));
        var code = List(Snapshot(set, 1), DistinctOrder.Value);
        check(code.Select(value => value.Text).SequenceEqual(["A", "B", "a  ", "b"]) && code[2].Count == 2 && code.Select(value => value.Group).SequenceEqual([0, 1, 2, 3]),
            "a _BIN2 column tells case apart, orders by code point and still ignores trailing spaces; groups number value order");
        var amount = Snapshot(set, 2);
        check(List(amount, DistinctOrder.Value) is [{ Text: "0", Count: 2 }, { Text: "1.50", Count: 2 }, { Text: "2", Count: 1 }] && amount.Nulls == 1,
            "exact numerics are equal by value (1.50 and 1.5, -0.00 and 0), in numeric order");
        check(List(amount).Select(value => value.Text).SequenceEqual(["0", "1.50", "2"]), "equal counts keep value order when ordered by count");
        var blob = Snapshot(set, 3);
        check(List(blob) is [{ Text: "0x01", Count: 3 }, { Text: "0x02", Count: 1 }] && blob.Nulls == 2, "binary values are compared by bytes and shown as hex");
        var searched = name.Read(DistinctOrder.Count, 0, 10, "B", CancellationToken.None);
        check(searched.Total == 1 && searched.Values is [{ Group: 1, Text: "b", Count: 2 }],
            "a search keeps the values containing it, by the column's collation (b for B), with their groups");
        check(List(Snapshot(set, 1), search: "B") is [{ Text: "B", Count: 1 }] && List(blob, search: "zz").Length == 0 && List(blob, search: "02") is [{ Text: "0x02" }],
            "a _BIN2 search tells case apart, and a binary column matches hex only");
        var paged = Snapshot(set, 1);
        check(List(paged, DistinctOrder.Value, offset: 1, count: 2).Select(value => value.Text).SequenceEqual(["B", "a  "]) && List(paged, offset: 9).Length == 0
            && paged.Read(DistinctOrder.Value, 3, 5, null, CancellationToken.None) is { Total: 4, Values: [{ Text: "b" }] },
            "a window starts at its offset and stops at the last value");
        var view = store.AddView(set, [5, 4, 3], [new ViewKey(0, false, SortMode.Value)], false, true, 0, null);
        var viewed = Snapshot(set, 0, view);
        check(viewed.Rows == 3 && viewed.Nulls == 1 && List(viewed) is [{ Row: 5, Text: "a", Count: 1 }, { Row: 4, Text: "B", Count: 1 }],
            "through a view only its rows count, each value shown by the lowest of them: " + Describe(viewed, List(viewed)));
        var cancelled = false;
        try { ViewSorter.DistinctValues(set, set.SealedSnapshot(), null, 0, true, new CancellationToken(true)); }
        catch (OperationCanceledException) { cancelled = true; }
        var searchCancelled = false;
        try { Snapshot(set, 0).Read(DistinctOrder.Count, 0, 10, "a", new CancellationToken(true)); }
        catch (OperationCanceledException) { searchCancelled = true; }
        check(cancelled && searchCancelled, "a cancelled snapshot, or a cancelled search of one, stops");
        var longText = new string('x', 300) + "\U0001F600";
        var wide = Fill(store, [new("text", "nvarchar(max)", "text", Collation: Bin2), new("bin", "varbinary(max)", "binary")], [[longText, Enumerable.Repeat((byte)0xAB, 200).ToArray()]]);
        var text = List(Snapshot(wide, 0))[0].Text;
        var hex = List(Snapshot(wide, 1))[0].Text;
        check(text.Length == ViewSorter.DistinctValueChars + 1 && text.EndsWith('…') && hex.StartsWith("0xABAB", StringComparison.Ordinal) && hex.EndsWith('…') && hex.Length <= ViewSorter.DistinctValueChars + 1,
            "a long value's text is cut to 256 characters and marked");
    }

    private static void Ticks(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store, Columns, Rows);
        var code = Snapshot(set, 1);
        check(code.Ticks == (4, true), "every value and NULL start ticked without a kept view");
        check(code.Tick(false, [0, 2], false, null, null, CancellationToken.None) == (2, true) && List(code, DistinctOrder.Value).Select(value => value.Checked).SequenceEqual([false, true, false, true]),
            "ticking by group clears just those values");
        check(code.Tick(true, null, true, "a", false, CancellationToken.None) == (3, false) && List(code, DistinctOrder.Value).Select(value => value.Checked).SequenceEqual([true, true, true, true]) is false
            && List(code, DistinctOrder.Value)[2].Checked && !List(code, DistinctOrder.Value)[0].Checked,
            "ticking every value a search finds ticks only those (a  under _BIN2, not A), and NULL's tick is set alone");
        check(code.Tick(false, null, true, null, null, CancellationToken.None) == (0, false) && code.Tick(true, null, true, null, true, CancellationToken.None) == (4, true),
            "Select none and Select all tick every value at once");
        var refused = "";
        try { code.Tick(true, [4], false, null, null, CancellationToken.None); }
        catch (RequestException error) { refused = error.Code; }
        check(refused == "INVALID_PARAMS", "a group the list does not have is refused");
        code.Freeze();
        refused = "";
        try { code.Tick(false, [0], false, null, null, CancellationToken.None); }
        catch (RequestException error) { refused = error.Code; }
        check(refused == "INVALID_PARAMS", "a snapshot a filter froze takes no more ticks");
        // A kept view starts each value ticked when it holds any of its rows, matched by value, not row; NULL likewise.
        var excluded = ViewSorter.Build(set, set.SealedSnapshot(), [], [new ViewFilter(FilterOp.NotIn, 0, [0], true, null, [])], CancellationToken.None).Order;
        var filtered = store.AddView(set, excluded, [], false, true, 0, null);
        var marked = Snapshot(set, 0, kept: filtered);
        check(List(marked) is [{ Text: "A", Checked: true }, { Text: "b", Checked: false }] && marked.Ticks == (1, false),
            "a kept view ticks the values it holds and not those its filter dropped, nor NULL");
        var some = store.AddView(set, [2, 3], [], false, true, 0, null);
        check(List(Snapshot(set, 0, kept: some)) is [{ Row: 1, Checked: true }, { Checked: false }] && Snapshot(set, 0, kept: some).Ticks.NullChecked,
            "a value is ticked when any of its rows is kept (row 2 holds A, listed by row 1)");
        var many = Fill(store, [new("n", "int", "text")], Enumerable.Range(0, 300).Select(i => new object?[] { i.ToString(CultureInfo.InvariantCulture) }));
        var early = store.AddView(many, [0], [], false, false, 0, null, 100);
        var loading = List(Snapshot(many, 0, kept: early), DistinctOrder.Value);
        check(loading[0].Checked && !loading[1].Checked && !loading[99].Checked && loading[100].Checked && loading[299].Checked,
            "rows sealed after a kept view was built count as kept");
    }

    /// <summary>The checklist's filter: the rows of exactly the values ticked, In or NotIn whichever names fewer.</summary>
    private static void Filters(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var set = Fill(store, Columns, Rows);
        var name = Snapshot(set, 0);
        name.Tick(false, [1], false, null, false, CancellationToken.None);
        var kept = Kept(set, name);
        check(name.Freeze() is { Op: FilterOp.In, Rows: [1], Nulls: false } && kept.SequenceEqual([1, 2, 5]),
            "a checklist keeping fewer than it drops is an In by the ticked value's row, and keeps the rows it counted: " + string.Join(",", kept));
        var code = Snapshot(set, 1);
        code.Tick(false, [3], false, null, false, CancellationToken.None);
        check(code.Freeze() is { Op: FilterOp.NotIn, Rows: [0], Nulls: true } && Kept(set, code).SequenceEqual([1, 2, 4, 5]),
            "a checklist dropping fewer is a NotIn by the cleared values' rows, NULL dropped with them");
        try { name.Tick(false, null, true, null, null, CancellationToken.None); }
        catch (RequestException) { /* Refused: checked in Ticks. */ }
        check(name.Freeze() is { Op: FilterOp.In, Rows: [1] } && name.Ticks == (1, false), "the first filter freezes its rows and ticks");
        // While rows still arrive the filter drops what was cleared, so values in rows not yet seen stay shown.
        var loading = Fill(store, [new("n", "int", "text")], Enumerable.Range(0, 10).Select(i => new object?[] { i.ToString(CultureInfo.InvariantCulture) }), complete: false);
        var partial = Snapshot(loading, 0);
        partial.Tick(false, null, true, null, null, CancellationToken.None);
        partial.Tick(true, [3], false, null, null, CancellationToken.None);
        // NULL cleared on a list that never showed one: NULLs that arrive later are not dropped with the cleared values.
        partial.Tick(false, null, false, null, false, CancellationToken.None);
        check(!partial.Complete && partial.Nulls == 0 && partial.Freeze() is { Op: FilterOp.NotIn, Rows.Length: 9, Nulls: false },
            "a snapshot of a set still loading always drops its cleared values, and no NULL it never saw");
        // Freezing takes only the ticks' lock: a search scanning the values (which holds the search lock) never delays it.
        var scanned = Snapshot(set, 0);
        Monitor.Enter(scanned.SearchLock);
        try { check(Task.Run(scanned.Freeze).Wait(TimeSpan.FromSeconds(30)), "freezing never waits for a search"); }
        finally { Monitor.Exit(scanned.SearchLock); }
        // A column without NULL names no NULL in its In, whatever NULL's tick, so the filter keeps exactly one value.
        var whole = Fill(store, [new("n", "int", "text")], Enumerable.Range(0, 4).Select(i => new object?[] { (i % 2).ToString(CultureInfo.InvariantCulture) }));
        var bit = Snapshot(whole, 0);
        bit.Tick(false, [1], false, null, null, CancellationToken.None);
        check(bit.Nulls == 0 && bit.Ticks == (1, true) && bit.Freeze() is { Op: FilterOp.In, Rows: [0], Nulls: false }, "a column without NULL keeps no NULL");
        var all = Snapshot(set, 3);
        check(all.Freeze() is { Op: FilterOp.NotIn, Rows: [], Nulls: false } && Kept(set, all).Length == 6, "every value and NULL ticked drops nothing");
    }

    /// <summary>No cap: every value of a column with more of them than an In filter holds lists, ticks and filters.</summary>
    private static void Uncapped(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        const int count = 60_000;
        var set = Fill(store, [new("n", "int", "text")], Enumerable.Range(0, count).Select(i => new object?[] { (count - 1 - i).ToString(CultureInfo.InvariantCulture) }));
        var snapshot = Snapshot(set, 0);
        var tail = snapshot.Read(DistinctOrder.Value, count - 2, 10, null, CancellationToken.None);
        check(snapshot.Distinct == count && tail.Total == count && tail.Values is [{ Text: "59998", Group: count - 2, Row: 1 }, { Text: "59999", Row: 0 }],
            "a snapshot keeps all 60,000 values and reads the last window");
        var nines = snapshot.Read(DistinctOrder.Value, 0, 512, "9999", CancellationToken.None);
        check(nines.Total == 6 && nines.Values.Select(value => value.Text).SequenceEqual(["9999", "19999", "29999", "39999", "49999", "59999"]), "a search runs over every value");
        snapshot.Tick(false, null, true, "9", null, CancellationToken.None);
        var (ticked, _) = snapshot.Ticks;
        var noNine = Enumerable.Range(0, count).Count(i => !i.ToString(CultureInfo.InvariantCulture).Contains('9'));
        check(ticked == noNine, $"Select none over a search clears every value it finds, not just a window: {ticked} ticked, {noNine} expected");
        var kept = Kept(set, snapshot);
        check(snapshot.Freeze().Op == FilterOp.NotIn && kept.Length == noNine && kept.All(row => !(count - 1 - row).ToString(CultureInfo.InvariantCulture).Contains('9')),
            "the filter drops exactly the rows of the values cleared, however many");
    }

    private static void Requests(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new SqlService(store);
        var set = Fill(store, Columns, Rows);
        var baseline = Held.Bytes(store);
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        string? Code(string method, object args)
        {
            try { Call<object>(method, args); return null; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "INVALID_PARAMS"; }
        }
        var opened = Call<ResultsDistinctResult>("results.distinct", new { resultId = set.ResultId, column = 0 });
        check(new[] { "results.distinct", "results.distinctRead", "results.distinctTick", "results.distinctClose" }.All(SqlService.MethodNames.Contains)
            && service.LaneOf("results.distinct") == RequestLane.Results && service.LaneOf("results.distinctRead") == RequestLane.Results && service.LaneOf("results.distinctTick") == RequestLane.Results
            && service.LaneOf("results.distinctClose") == RequestLane.Control
            && opened is { Rows: 6, Complete: true, Nulls: 1, Distinct: 2, Checked: 2, NullsChecked: true } && opened.SnapshotId > 0
            && Held.Bytes(store) == baseline + ViewSorter.DistinctSnapshotBytes(2) && store.SnapshotCount == 1,
            "results.distinct keeps a snapshot, charged its own memory and no more");
        var window = Call<ResultsDistinctReadResult>("results.distinctRead", new { resultId = set.ResultId, snapshotId = opened.SnapshotId, order = "count", offset = 0, count = 1 });
        check(window is { Total: 2, Offset: 0, Checked: 2 } && window.Values is [{ Group: 0, Row: 1, Text: "A", Count: 3, Checked: true }], "results.distinctRead reads a window");
        var ticked = Call<ResultsDistinctTickResult>("results.distinctTick", new { resultId = set.ResultId, snapshotId = opened.SnapshotId, @checked = false, groups = new[] { 1 }, nulls = false });
        check(ticked is { Checked: 1, NullsChecked: false }, "results.distinctTick clears a value and NULL");
        var view = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = Array.Empty<object>(), filters = new object[] { new { op = "groups", column = 0, snapshotId = opened.SnapshotId } } });
        check(view.Rows == 3 && view.Filters is [{ Op: "groups", Column: 0, SnapshotId: var id, Keep: true, Values: 1, Row: 1, Nulls: false, Rows: null }] && id == opened.SnapshotId,
            "a groups filter keeps the ticked value's rows and comes back as asked, saying what it keeps");
        var again = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 1, descending = false, mode = "value" } }, filters = new object[] { new { op = "groups", column = 0, snapshotId = opened.SnapshotId } } });
        check(again.Rows == 3 && Code("results.distinctTick", new { resultId = set.ResultId, snapshotId = opened.SnapshotId, @checked = true, all = true }) == "INVALID_PARAMS",
            "a view built again keeps the same rows, and the snapshot takes no more ticks");
        var other = Call<ResultsDistinctResult>("results.distinct", new { resultId = set.ResultId, column = 1, viewId = view.ViewId, keptViewId = view.ViewId });
        var otherValues = Call<ResultsDistinctReadResult>("results.distinctRead", new { resultId = set.ResultId, snapshotId = other.SnapshotId, order = "value", offset = 0, count = 10, search = "a" });
        check(other is { Rows: 3, Distinct: 2, Checked: 2 } && otherValues is { Total: 1 } && otherValues.Values is [{ Text: "a  ", Row: 2 }],
            "results.distinct reads through a filtered view and searches its values");
        var codes = new[]
        {
            Code("results.distinct", new { resultId = set.ResultId, column = 4 }),
            Code("results.distinct", new { resultId = set.ResultId, column = -1 }),
            Code("results.distinct", new { resultId = set.ResultId, column = 0, order = "count" }),
            Code("results.distinct", new { resultId = set.ResultId, column = 0, viewId = 0 }),
            Code("results.distinct", new { resultId = set.ResultId, column = 0, viewId = 12345 }),
            Code("results.distinct", new { resultId = set.ResultId, column = 0, keptViewId = 12345 }),
            Code("results.distinct", new { resultId = 999, column = 0 }),
            Code("results.distinctRead", new { resultId = set.ResultId, snapshotId = opened.SnapshotId, order = "random", offset = 0, count = 1 }),
            Code("results.distinctRead", new { resultId = set.ResultId, snapshotId = opened.SnapshotId, order = "count", offset = -1, count = 1 }),
            Code("results.distinctRead", new { resultId = set.ResultId, snapshotId = opened.SnapshotId, order = "count", offset = 0, count = 0 }),
            Code("results.distinctRead", new { resultId = set.ResultId, snapshotId = opened.SnapshotId, order = "count", offset = 0, count = ViewSorter.MaxDistinctWindow + 1 }),
            Code("results.distinctRead", new { resultId = set.ResultId, snapshotId = opened.SnapshotId, order = "count", offset = 0, count = 1, search = "" }),
            Code("results.distinctRead", new { resultId = set.ResultId, snapshotId = opened.SnapshotId, order = "count", offset = 0, count = 1, search = new string('x', ResultSearcher.MaxText + 1) }),
            Code("results.distinctRead", new { resultId = set.ResultId, snapshotId = 12345, order = "count", offset = 0, count = 1 }),
            Code("results.distinctTick", new { resultId = set.ResultId, snapshotId = other.SnapshotId, @checked = true }),
            Code("results.distinctTick", new { resultId = set.ResultId, snapshotId = other.SnapshotId, @checked = true, all = true, groups = new[] { 0 } }),
            Code("results.distinctTick", new { resultId = set.ResultId, snapshotId = other.SnapshotId, @checked = true, groups = new[] { 0 }, search = "a" }),
            Code("results.distinctTick", new { resultId = set.ResultId, snapshotId = other.SnapshotId, @checked = true, groups = Array.Empty<int>() }),
            Code("results.distinctTick", new { resultId = set.ResultId, snapshotId = other.SnapshotId, @checked = true, groups = Enumerable.Repeat(0, ViewSorter.MaxDistinctWindow + 1).ToArray() }),
            Code("results.distinctTick", new { resultId = set.ResultId, snapshotId = other.SnapshotId, @checked = true, groups = new[] { 2 } }),
            Code("results.distinctTick", new { resultId = set.ResultId, snapshotId = other.SnapshotId, @checked = true, all = false, nulls = true }),
            Code("results.distinctClose", new { resultId = set.ResultId, snapshotIds = Array.Empty<uint>() }),
            Code("results.distinctClose", new { resultId = set.ResultId, snapshotIds = new uint[] { 0 } }),
            Code("results.view", new { resultId = set.ResultId, sort = Array.Empty<object>(), filters = new object[] { new { op = "groups", column = 1, snapshotId = opened.SnapshotId } } }),
            Code("results.view", new { resultId = set.ResultId, sort = Array.Empty<object>(), filters = new object[] { new { op = "groups", column = 0, snapshotId = 12345 } } }),
            Code("results.view", new { resultId = set.ResultId, sort = Array.Empty<object>(), filters = new object[] { new { op = "groups", column = 0, snapshotId = opened.SnapshotId, rows = new[] { 0 } } } }),
            Code("results.view", new { resultId = set.ResultId, sort = Array.Empty<object>(), filters = new object[] { new { op = "in", column = 0, rows = new[] { 0 }, snapshotId = opened.SnapshotId } } })
        };
        check(string.Join(",", codes) == "INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,VIEW_NOT_FOUND,VIEW_NOT_FOUND,RESULT_NOT_FOUND,"
            + "INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,VIEW_NOT_FOUND,"
            + "INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,INVALID_PARAMS,"
            + "INVALID_PARAMS,VIEW_NOT_FOUND,INVALID_PARAMS,INVALID_PARAMS",
            "the distinct methods and the groups filter check every input: " + string.Join(",", codes));
        var closed = Call<ResultsDistinctCloseResult>("results.distinctClose", new { resultId = set.ResultId, snapshotIds = new[] { opened.SnapshotId, opened.SnapshotId, 12345u } });
        check(closed.Closed == 1 && store.SnapshotCount == 1 && Code("results.view", new { resultId = set.ResultId, sort = Array.Empty<object>(), filters = new object[] { new { op = "groups", column = 0, snapshotId = opened.SnapshotId } } }) == "VIEW_NOT_FOUND",
            "results.distinctClose closes a snapshot once, and a filter naming it then fails");
        store.CloseViews(set.ResultId, [view.ViewId, again.ViewId]);
        var limit = new List<uint>();
        string? full = null;
        for (var i = 0; i < ViewSorter.MaxDistinctSnapshots; i++)
        {
            try { limit.Add(Call<ResultsDistinctResult>("results.distinct", new { resultId = set.ResultId, column = 2 }).SnapshotId); }
            catch (RequestException error) { full = error.Code; break; }
        }
        check(full == "TOO_LARGE" && store.SnapshotCount == ViewSorter.MaxDistinctSnapshots, "a result keeps at most 24 snapshots and refuses more, dropping none");
        store.Release(set.ResultId);
        check(store.SnapshotCount == 0 && Held.Bytes(store) == 0, "releasing a result releases its snapshots and their memory");
        var tight = new ResultStore(4096, 4096);
        using var small = new SqlService(tight);
        var cramped = Fill(tight, [new("id", "int", "text")], [["1"]]);
        var before = Held.Bytes(tight);
        string? refused;
        try { small.DispatchAsync("results.distinct", JsonSerializer.SerializeToElement(new { resultId = cramped.ResultId, column = 0 }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); refused = null; }
        catch (RequestException error) { refused = error.Code; }
        check(refused == "TOO_LARGE" && Held.Bytes(tight) == before, "distinct values the budget has no room for answer TOO_LARGE and take nothing");
    }
}
