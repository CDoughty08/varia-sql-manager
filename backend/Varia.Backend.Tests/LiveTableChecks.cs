using System.Text.Json;
using Varia.Backend.Live;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the live tables (Live/LiveTables.cs): live memory (the subscription limit, the live share,
/// small pages, no forced collection), snapshot revisions (two alive, diff, tracking, departed rows, sort, filter, view, row
/// cap, facets, cell text equal to a query's), append segments (settle window, late ids, dedupe bound, roll, restart, start,
/// budget), and the synthetic source's multi-table, state-built, append and wide probes through LiveService.</summary>
internal static class LiveTableChecks
{
    private static readonly LiveLimitsJson Limits = LiveCatalog.Current.Limits;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static async Task RunAsync(Action<bool, string> check)
    {
        CatalogChecks(check);
        StoreChecks(check);
        SnapshotChecks(check);
        CellChecks(check);
        FacetChecks(check);
        AppendChecks(check);
        await SyntheticChecks(check);
        await LogChecks(check);
        await EndChecks(check);
        SqlChecks(check);
    }

    private static LiveColumnJson Column(string id, string type = "int") => new(id, id, type);
    private static LiveProbeJson Probe(params LiveTableJson[] tables) => new("test.tables", "test", "Tables", "Tables", new(1000, 1000, 3_600_000), [], [.. tables], [], [], "memory");
    private static LiveTableJson ItemsTable(int rowCap = 100, bool departed = false, List<string>? facets = null) =>
        new("items", "snapshot", [Column("id"), Column("grp", "nvarchar"), Column("amount")], ["id"], rowCap, departed, facets);
    private static LiveTableJson Log(int batchRows = 100, int settleTicks = 2, int settleMs = 0) =>
        new("log", "append", [Column("id", "bigint"), Column("text", "nvarchar")], ["id"], Settle: new(settleTicks, settleMs), BatchRows: batchRows);
    private static LiveRow Item(long id, string? group, long? amount) => new([LiveCell.Of(id), LiveCell.Of(group), LiveCell.Of(amount)]);
    private static LiveRow Message(long id) => new([LiveCell.Of(id), LiveCell.Of("Message " + id)]);
    private static List<LiveRow> Items(params long[] ids) => [.. ids.Select(id => Item(id, "G" + id % 3, id * 10))];
    private static List<string?[]> Rows(ResultStore store, ResultDescriptor descriptor) => LiveResultChecks.RowsOf(store, descriptor);
    private static List<string?> Ids(ResultStore store, ResultDescriptor descriptor) => [.. Rows(store, descriptor).Select(row => row[0])];
    private static ResultStore Store(long global = 1L << 30) => new(global, global / 2);

    private static void CatalogChecks(Action<bool, string> check)
    {
        var catalog = LiveCatalog.Current;
        var grid = catalog.Probes[SyntheticSampler.GridProbe];
        var log = catalog.Probes[SyntheticSampler.LogProbe];
        check(catalog.Limits is { SnapshotRows: 10_000, SegmentRows: 200_000, SegmentBytes: 32L << 20, Segments: 2, BatchRows: 10_000, SubscriptionBytes: 64L << 20, BudgetShare: 0.25,
                FacetColumns: 7, FacetValues: 100, FacetCharacters: 128, FacetBytes: 32 * 1024, HiddenIntervalMs: 30_000 }
            && grid.Tables is [{ Mode: "snapshot", RowCap: 10_000, Departed: true, Facets: ["group"] }, { Mode: "snapshot", RowCap: 10, Departed: false, Facets: [] }]
            && grid.Views is ["even"] && grid.FilterMode == "memory"
            && log.Tables is [{ Mode: "append", Key: ["messageId"], Settle: { Ticks: 2, Ms: 0 }, BatchRows: 5000 }] && log.FilterMode == "restart"
            && catalog.Probes[SyntheticSampler.WideProbe].Tables is [{ Columns.Count: 23 }] && catalog.Sources.Values.All(source => source.Hidden == "pause"),
            "the embedded catalogue carries the table limits, and each table's row cap, departed rows, facets, settle window and reads");
        check(LiveErrors.IsTerminal("CATALOG_MISSING") && LiveErrors.IsTerminal("NOT_FOUND") && !LiveErrors.IsTerminal("BUDGET") && !LiveErrors.IsTerminal("BLOCKED"),
            "a missing SSISDB catalog and a missing followed object stop their probe (terminal); BUDGET and BLOCKED retry");
    }

    private static void StoreChecks(Action<bool, string> check)
    {
        // Live sets seal pages under the large object heap's threshold; a query's seal at 256 KiB.
        var store = Store();
        var text = new string('x', 100);
        ResultSetBuffer Fill(QueryBudget budget)
        {
            var set = store.Open(budget, 0, 1, 1, "rows", [new ResultColumn("t", "nvarchar", "text")], [WireKind.Text])!;
            for (var i = 0; i < 20_000; i++) LiveTableSet.Write(set, new([LiveCell.Of(text)]));
            set.Complete();
            return set;
        }
        var live = Fill(new QueryBudget("live:pages", new LiveBudget(64L << 20)));
        var query = Fill(store.BeginQuery("query"));
        var livePages = live.PagesFor(0, int.MaxValue);
        var queryPages = query.PagesFor(0, int.MaxValue);
        check(livePages.Count > 10 && livePages.All(page => page.Body.Length < 85_000) && queryPages.Max(page => page.Body.Length) > 200_000 && live.RowsAvailable == 20_000,
            "a live table seals 64 KiB pages (off the large object heap) while a query's pages stay 256 KiB: " + livePages.Max(page => page.Body.Length) + " and " + queryPages.Max(page => page.Body.Length));
        var before = store.FreedSinceCollect;
        store.Release(live.ResultId);
        var afterLive = store.FreedSinceCollect;
        store.Release(query.ResultId);
        check(afterLive == before && store.FreedSinceCollect > afterLive && store.LiveUsedBytes == 0,
            "releasing a live table does not count toward the forced gen2 collection (a 1 s snapshot would trigger it every few seconds); a query's release does");

        // The subscription's limit: every revision has its own budget, and they share the subscription's.
        var limited = new LiveTableSet(Store(), Guid.NewGuid().ToString(), Limits with { SubscriptionBytes = 300 * 1024 });
        var wide = Enumerable.Range(1, 20_000).Select(id => Item(id, new string('g', 40), id)).ToList();
        var cut = limited.Snapshot(Probe(ItemsTable(20_000)), 0).Write(wide, new());
        check(cut is { Budget: true, Sample.Descriptor: { Truncated: "queryBudget", State: "complete" } } && cut.Sample.Descriptor.RowsStored < 20_000 && limited.Budget.UsedBytes <= 300 * 1024,
            "a revision past its subscription's limit stores what fits, marked queryBudget, and reports BUDGET");

        // All live tables together stay within the live share of the result budget; queries keep the rest.
        var shared = Store(1L << 20);
        shared.ShareWithLive(0.25);
        var first = new LiveTableSet(shared, Guid.NewGuid().ToString(), Limits);
        var share = first.Snapshot(Probe(ItemsTable(20_000)), 0).Write(wide, new());
        var hog = shared.BeginQuery("hog");
        var queryRoom = shared.TryReserve(hog, 500 * 1024, false, out _);
        check(share is { Budget: true, Sample.Descriptor.Truncated: "globalBudget" } && shared.LiveBytes == 256 * 1024 && shared.LiveUsedBytes <= 256 * 1024 && queryRoom,
            "live tables together hold at most a quarter of the result budget (globalBudget past it), and queries keep the rest: " + shared.LiveUsedBytes);
        shared.Return(hog, 500 * 1024);
        first.Release();
        check(shared.LiveUsedBytes == 0 && shared.UsedBytes == 0 && shared.Count == 0, "releasing a subscription's tables returns all of their live memory");
    }

    private static void SnapshotChecks(Action<bool, string> check)
    {
        var store = Store();
        var set = new LiveTableSet(store, Guid.NewGuid().ToString(), Limits);
        var probe = Probe(ItemsTable());
        var table = set.Snapshot(probe, 0);
        var one = table.Write(Items(1, 2, 3), new()).Sample!;
        var changed = Items(2, 3, 4);
        changed[0] = Item(2, "G2", 999);
        var two = table.Write(changed, new()).Sample!;
        var three = table.Write(Items(3, 4, 5), new(Track: new LiveTrackArgs("test.tables", 0, 5, ["4", "9", "3"]))).Sample!;
        check(one is { Revision: 1, Retired: null, Diff: null } && two is { Revision: 2, Retired: null, Diff: { Added: 1, Removed: 1, Changed: 1 } }
            && three is { Revision: 3, Diff: { Added: 1, Removed: 1, Changed: 0 } } && three.Retired is [var retired] && retired == one.Descriptor.ResultId && store.Find(retired) is null
            && store.Find(two.Descriptor.ResultId) is { IsComplete: true } && three.Tracked is { Seq: 5, Rows: [1, -1, 0] },
            "a snapshot keeps two revisions (the third retires the first), diffs keys against the previous one (added, removed, changed cells), and finds each tracked key's new row");

        // Sort: the user's keys, then the key, so equal values never trade places; NULL sorts first ascending.
        var tied = new List<LiveRow> { Item(5, "a", 7), Item(3, "b", 7), Item(4, "c", 9), Item(6, "d", null) };
        var descending = table.Write(tied, new([new LiveSortArgs("amount", true)])).Sample!;
        var descendingRows = Rows(store, descending.Descriptor);
        var ascending = table.Write(tied, new([new LiveSortArgs("amount", false)])).Sample!;
        var ascendingRows = Rows(store, ascending.Descriptor);
        var byText = table.Write([Item(1, "b", 1), Item(2, "B", 1), Item(3, "a", 1)], new([new LiveSortArgs("grp", false)])).Sample!;
        var byTextRows = Rows(store, byText.Descriptor);
        check(descendingRows.Select(row => row[0]).SequenceEqual(["4", "3", "5", "6"]) && ascendingRows.Select(row => row[0]).SequenceEqual(["6", "3", "5", "4"])
            && byTextRows.Select(row => row[0]).SequenceEqual(["3", "2", "1"]),
            "a sort orders by the user's columns, then the key; numbers as numbers, NULL first ascending, text case-insensitively and then exactly");

        // Filter (case-insensitive, on the named columns of this table only), view, row cap.
        var rows = new List<LiveRow> { Item(1, "Blue", 1), Item(2, "red", 2), Item(3, "BLUE", 3), Item(4, "green", 4) };
        var filtered = table.Write(rows, new(Filter: new LiveFilterArgs("blue"))).Sample!;
        var filteredRows = Rows(store, filtered.Descriptor);
        var named = table.Write(rows, new(Filter: new LiveFilterArgs("2", ["amount"]))).Sample!;
        var namedRows = Rows(store, named.Descriptor);
        var other = table.Write(rows, new(Filter: new LiveFilterArgs("blue", ["someOtherTablesColumn"]))).Sample!;
        var otherRows = Rows(store, other.Descriptor);
        var viewed = table.Write(rows, new(View: row => row.Cells[0].Value is long id && id % 2 == 0)).Sample!;
        var viewedRows = Rows(store, viewed.Descriptor);
        check(filteredRows.Select(row => row[0]).SequenceEqual(["1", "3"]) && namedRows.Select(row => row[0]).SequenceEqual(["2"]) && otherRows.Count == 4
            && viewedRows.Select(row => row[0]).SequenceEqual(["2", "4"]),
            "a memory filter matches stored cell text case-insensitively, in the columns it names (another table's columns leave this one whole), and a view keeps its own rows");
        var capped = new LiveTableSet(store, Guid.NewGuid().ToString(), Limits).Snapshot(Probe(ItemsTable(3)), 0).Write(Items(1, 2, 3, 4, 5), new(), more: 2).Sample!;
        check(capped.Descriptor is { RowsStored: 3, RowsRead: 7, Truncated: "rowLimit" }, "a revision past its row cap stores the cap and says rowLimit, counting the rows the source left out");

        // Departed rows: a tracked row that left the source stays one revision, at the row it had, listed as departed.
        var departedSet = new LiveTableSet(store, Guid.NewGuid().ToString(), Limits);
        var keeping = departedSet.Snapshot(Probe(ItemsTable(departed: true)), 0);
        var track = new LiveTrackArgs("test.tables", 0, 1, ["2"]);
        keeping.Write(Items(1, 2, 3), new(Track: track));
        var gone = keeping.Write(Items(3, 4, 5), new(Track: track)).Sample!;
        var goneRows = Rows(store, gone.Descriptor);
        var after = keeping.Write(Items(4, 5, 6), new(Track: track)).Sample!;
        var afterRows = Rows(store, after.Descriptor);
        var hidden = keeping.Write(Items(4, 5, 6), new(Filter: new LiveFilterArgs("nothing matches"), Track: new LiveTrackArgs("test.tables", 0, 2, ["5"]))).Sample!;
        var hiddenRows = Rows(store, hidden.Descriptor);
        var plain = new LiveTableSet(store, Guid.NewGuid().ToString(), Limits).Snapshot(Probe(ItemsTable()), 0);
        plain.Write(Items(1, 2, 3), new(Track: track));
        var plainGone = plain.Write(Items(3, 4, 5), new(Track: track)).Sample!;
        var plainGoneRows = Rows(store, plainGone.Descriptor);
        check(goneRows.Select(row => row[0]).SequenceEqual(["3", "2", "4", "5"]) && gone.Departed is [1] && gone.Tracked is { Rows: [1] } && gone.Diff is { Added: 2, Removed: 1, Changed: 0 }
            && goneRows[1].SequenceEqual(["2", "G2", "20"])
            && afterRows.Select(row => row[0]).SequenceEqual(["4", "5", "6"]) && after.Departed is null && after.Tracked is { Rows: [-1] }
            && hidden.Departed is null && hiddenRows.Count == 0
            && plainGone.Departed is null && plainGoneRows.Select(row => row[0]).SequenceEqual(["3", "4", "5"]),
            "a tracked row that left the source stays exactly one more revision, where it was and listed as departed; untracked, filtered-out rows and tables without departed rows never linger");

        // The renderer tracks a key after the revision that showed it: the next revision still keeps the row once it leaves.
        var late = new LiveTableSet(store, Guid.NewGuid().ToString(), Limits).Snapshot(Probe(ItemsTable(departed: true)), 0);
        late.Write(Items(1, 2, 3), new());
        var lateGone = late.Write(Items(3, 4, 5), new(Track: new LiveTrackArgs("test.tables", 0, 1, ["2"]))).Sample!;
        var lateRows = Rows(store, lateGone.Descriptor);
        check(lateGone is { Departed: [1], Tracked.Rows: [1] } && lateRows[1].SequenceEqual(["2", "G2", "20"]),
            "a key tracked only after the revision that held it still keeps its row for one revision once it leaves");

        // Out of budget: nothing stored, BUDGET; the revision released for it is named by the next one stored.
        var full = new ResultStore(1L << 30, 1L << 29);
        var fullTable = new LiveTableSet(full, Guid.NewGuid().ToString(), Limits).Snapshot(Probe(ItemsTable()), 0);
        var a = fullTable.Write(Items(1), new()).Sample!;
        var b = fullTable.Write(Items(2), new()).Sample!;
        full.ShareWithLive(0);
        var refused = fullTable.Write(Items(3), new());
        full.ShareWithLive(0.25);
        var back = fullTable.Write(Items(4), new());
        check(refused is { Sample: null, Budget: true } && back.Sample is { Retired: [var named1] } && named1 == a.Descriptor.ResultId && !back.Budget
            && full.Find(a.Descriptor.ResultId) is null && full.Find(b.Descriptor.ResultId) is { IsComplete: true },
            "a revision that cannot be stored reports BUDGET; the revisions released for it are named by the next stored one, so main forgets them");
    }

    private static void CellChecks(Action<bool, string> check)
    {
        var store = Store();
        var spec = new LiveTableJson("cells", "snapshot", [Column("k", "nvarchar"), Column("n", "bigint"), Column("f", "float"), Column("r", "real"), Column("b", "bit"), Column("d", "decimal"),
            Column("t", "datetime2"), Column("m", "datetime"), Column("o", "datetimeoffset"), Column("g", "uniqueidentifier"), Column("z", "nvarchar")], ["k", "n"]);
        var moment = new DateTime(2026, 10, 8, 12, 34, 56, 123);
        LiveCell[] cells = [LiveCell.Of("ka"), LiveCell.Of(-42L), LiveCell.Of(0.1 + 0.2), LiveCell.Real(3.1415927f), LiveCell.Bit(true), LiveCell.Of(-123.4500m),
            LiveCell.DateTime2(moment, 3), LiveCell.DateTime(moment), LiveCell.Offset(new DateTimeOffset(moment, TimeSpan.FromHours(2)), 0), LiveCell.Of(Guid.Parse("6f9619ff-8b86-d011-b42d-00c04fc964ff")), LiveCell.Null];
        var sample = new LiveTableSet(store, Guid.NewGuid().ToString(), Limits).Snapshot(new LiveProbeJson("p", "s", "P", "P", new(1000, 1000, 1000), [], [spec], [], [], "none"), 0)
            .Write([new LiveRow(cells)], new(Track: new LiveTrackArgs("p", 0, 1, ["ka\u001f-42"]))).Sample!;
        var stored = Rows(store, sample.Descriptor)[0];
        string?[] expected = ["ka", "-42", "0.3", "3.141593", "1", "-123.4500", "2026-10-08 12:34:56.123", "2026-10-08 12:34:56.123", "2026-10-08 12:34:56 +02:00", "6F9619FF-8B86-D011-B42D-00C04FC964FF", null];
        check(stored.SequenceEqual(expected) && cells.Select(cell => cell.Text).SequenceEqual(expected) && sample.Tracked is { Rows: [0] }
            && new LiveRow(cells).Key([0, 1]) == string.Join('\u001f', stored[0], stored[1]) && sample.Descriptor.Columns.All(column => column.Wire == "text"),
            "live cells store exactly a query's display text (CellFormat) for every type they hold, and a key is the stored texts of its columns joined with U+001F: " + string.Join(" | ", stored));
        var longText = LiveCell.Of(new string('y', ColumnPlan.TextCap + 10));
        check(longText is { Truncated: true } && longText.Text!.Length == ColumnPlan.TextCap && LiveCell.Compare(LiveCell.Null, LiveCell.Of(1L)) < 0 && LiveCell.Compare(LiveCell.Of(2L), LiveCell.Of(10L)) < 0,
            "a text cell past the stored cell cap is cut and marked truncated, as a query's is; NULL sorts before values and numbers sort as numbers");
    }

    private static void FacetChecks(Action<bool, string> check)
    {
        var store = Store();
        var set = new LiveTableSet(store, Guid.NewGuid().ToString(), Limits);
        var table = set.Snapshot(Probe(ItemsTable(facets: ["grp"])), 0);
        set.BeginTick();
        var rows = new List<LiveRow> { Item(1, "b", 1), Item(2, "a", 1), Item(3, "b", 1), Item(4, null, 1), Item(5, "c", 1) };
        var first = table.Write(rows, new(Filter: new LiveFilterArgs("zzz"))).Sample!;
        var firstRows = Rows(store, first.Descriptor);
        set.BeginTick();
        var same = table.Write(rows, new()).Sample!;
        set.BeginTick();
        var moved = table.Write([.. rows, Item(6, "c", 1)], new()).Sample!;
        check(first.Facets is [{ Column: "grp", More: null } facet] && facet.Values.SequenceEqual([new LiveFacetValue("b", 2), new LiveFacetValue("a", 1), new LiveFacetValue("c", 1)])
            && firstRows.Count == 0 && same.Facets is null
            && moved.Facets is [{ Values: [{ Text: "b", Count: 2 }, { Text: "c", Count: 2 }, { Text: "a", Count: 1 }] }],
            "facets count each value over every row the source gave (before the filter, NULL left out), most frequent first, and are sent only when they change");

        var many = Enumerable.Range(0, 150).Select(i => Item(i, (i < 120 ? "v" + i.ToString("D3") : new string('w', 200)), 1)).ToList();
        set.BeginTick();
        var capped = set.Snapshot(Probe(ItemsTable(facets: ["grp"])), 0).Write(many, new()).Sample!;
        var longOnly = new LiveTableSet(store, Guid.NewGuid().ToString(), Limits).Snapshot(Probe(ItemsTable(facets: ["grp"])), 0);
        var cut = longOnly.Write([Item(1, new string('w', 200), 1)], new()).Sample!;
        check(capped.Facets is [{ More: true, Values.Count: 100 }] && capped.Facets[0].Values[0] is { Text.Length: 128, Count: 30 }
            && cut.Facets is [{ Values: [{ Text.Length: 128 }] }],
            "a facet holds at most 100 values (more: true past them) of at most 128 characters, so values that differ only past them count together");

        var tight = new LiveTableSet(store, Guid.NewGuid().ToString(), Limits with { FacetBytes = 4 });
        tight.BeginTick();
        var budgeted = tight.Snapshot(Probe(ItemsTable(facets: ["grp"])), 0).Write(rows, new()).Sample!;
        var next = tight.Snapshot(Probe(ItemsTable(facets: ["grp"]), ItemsTable(facets: ["grp"])), 1).Write(rows, new()).Sample!;
        tight.BeginTick();
        var later = tight.Snapshot(Probe(ItemsTable(facets: ["grp"]), ItemsTable(facets: ["grp"])), 1).Write(rows, new()).Sample!;
        check(budgeted.Facets is [{ More: null, Values.Count: 3 }] && next.Facets is [{ More: true, Values.Count: 1 }] && later.Facets is [{ Values.Count: 3, More: null }],
            "a tick's facet text is bounded across its tables (limits.live.facetBytes): what does not fit is left out (more), and a later tick sends it");
    }

    private static void AppendChecks(Action<bool, string> check)
    {
        var store = Store();
        var limits = Limits with { SegmentRows = 5 };
        var set = new LiveTableSet(store, Guid.NewGuid().ToString(), limits);
        var probe = Probe(Log(batchRows: 3));
        var log = set.Append(probe, 0);
        log.Start(0, null, null, "p");
        var first = log.Append([Message(1), Message(2), Message(4)], 0).Sample!;
        var readRows = log.ReadRows;
        // Id 3 committed after 4: the next read covers 1 to 5 again, and only 3 and 5 are new.
        var second = log.Append([Message(1), Message(2), Message(3), Message(4), Message(5)], 0).Sample!;
        var settledBefore = log.SettledId;
        var third = log.Append([Message(3), Message(5)], 0);
        check(first is { Segment: 0, RolledFrom: null, Restarted: null, Descriptor: { RowsAvailable: 3, State: "open" } } && readRows == 6
            && second.Descriptor.RowsAvailable == 5 && Ids(store, second.Descriptor).SequenceEqual(["1", "2", "4", "3", "5"]) && settledBefore == 0
            && third.Sample is null && log.SettledId == 4 && log.Unsettled == 1,
            "an append table re-reads its unsettled ids, appends a late lower id once in arrival order, skips repeats, sends nothing when nothing changed, and settles ids seen two ticks ago");

        // A roll at the segment's row cap keeps two segments, naming the oldest retired.
        var rolled = log.Append([Message(6), Message(7)], 0).Sample!;
        var rolledIds = Ids(store, rolled.Descriptor);
        var firstComplete = store.Find(first.Descriptor.ResultId) is { IsComplete: true, RowsAvailable: 5 };
        var again = log.Append([.. Enumerable.Range(8, 5).Select(id => Message(id))], 0).Sample!;
        check(rolled is { Segment: 1, RolledFrom: { } from, Retired: null } && from == first.Descriptor.ResultId && rolledIds.SequenceEqual(["6", "7"]) && firstComplete
            && again is { Segment: 2, Retired: [var oldest] } && oldest == first.Descriptor.ResultId && store.Find(oldest) is null && Ids(store, again.Descriptor).SequenceEqual(["11", "12"]),
            "a segment at its cap completes and rolls to a new one (rolledFrom), and the oldest past two segments is released and named retired");

        // A new start retires every segment, starts the table again and carries the note row first.
        log.Start(10, null, new LiveRow([LiveCell.Null, LiveCell.Of(LiveStart.Note(10))]), "q");
        var restarted = log.Append([Message(9), Message(11), Message(12)], 0).Sample!;
        check(restarted is { Restarted: true, Segment: 3, Retired.Length: 2 } && log.Predicate == "q" && store.Find(restarted.Retired[0]) is null && store.Find(restarted.Retired[1]) is null
            && Rows(store, restarted.Descriptor) is [[null, "10 earlier rows are not shown."], ["11", _], ["12", _]],
            "a restart retires every segment it had, starts a new one with its note row, and reads only above its start");
        log.Start(0, 3, null, "r");
        var bounded = log.Append([Message(1), Message(2), Message(3), Message(4)], 0).Sample!;
        check(Ids(store, bounded.Descriptor).SequenceEqual(["1", "2"]) && log.Before == 3, "a start before an id ends the table there");

        // The remembered ids stay within twice the rows a read takes: the lowest settle early.
        var bounding = new LiveTableSet(store, Guid.NewGuid().ToString(), Limits).Append(Probe(Log(batchRows: 3, settleTicks: 100)), 0);
        bounding.Start(0, null, null, "");
        bounding.Append([.. Enumerable.Range(1, 10).Select(id => Message(id))], 0);
        var timed = new LiveTableSet(store, Guid.NewGuid().ToString(), Limits).Append(Probe(Log(settleTicks: 1, settleMs: 1000)), 0);
        timed.Start(0, null, null, "");
        timed.Append([Message(1)], 0);
        timed.Append([], 500);
        var early = timed.SettledId;
        timed.Append([], 1000);
        check(bounding is { DedupeBound: 6, Unsettled: 6, SettledId: 4 } && early == 0 && timed.SettledId == 1,
            "unsettled ids stay within the dedupe bound (the lowest settle first), and an id settles only after both the settle ticks and milliseconds");

        // Out of budget: the rows that did not fit are never seen, so the next read appends them once.
        var small = new ResultStore(1L << 20, 1L << 20);
        var tight = new LiveTableSet(small, Guid.NewGuid().ToString(), Limits).Append(Probe(Log()), 0);
        tight.Start(0, null, null, "");
        tight.Append([Message(1)], 0);
        var hog = small.BeginQuery("hog");
        small.TryReserve(hog, small.GlobalBytes - small.UsedBytes, false, out _);
        var big = Enumerable.Range(2, 3000).Select(id => new LiveRow([LiveCell.Of((long)id), LiveCell.Of(new string('m', 400))])).ToList();
        var refused = tight.Append(big, 0);
        var unseen = tight.Unsettled;
        small.Return(hog, hog.UsedBytes);
        var retried = tight.Append(big.Take(200).ToList(), 0);
        var segmentIds = retried.Sample is { } sample ? Ids(small, sample.Descriptor) : [];
        check(refused.Budget && unseen <= 1 && retried is { Budget: false, Sample: not null } && segmentIds.Count == segmentIds.Distinct().Count() && segmentIds.Contains("2"),
            "an append that runs out of budget reports BUDGET and leaves the rows unseen, so the next read stores them once: " + unseen + " " + segmentIds.Count);

        var cursors = set.Cursors();
        var kept = set.Keep(1);
        check(cursors is [{ Probe: "test.tables", Table: 0, SettledId: 0 }] && kept.Length == 1 && store.Find(kept[0]) is { IsComplete: true } && store.Find(bounded.Descriptor.ResultId) is not null,
            "a table set reports each started append table's cursor, and keeping completes and keeps the newest segment within the limit");
    }

    private static (Task<LiveEnd> Task, LiveRecorder Recorder, string Id) Subscribe(SqlService service, string[] probes, object args, string? resume = null, uint id = 1)
    {
        var recorder = new LiveRecorder(id);
        var subscription = Guid.NewGuid().ToString();
        var task = service.Live.SubscribeAsync(new LiveSubscribeArgs(subscription, Guid.NewGuid().ToString(), SyntheticSampler.Source, [.. probes.Select(probe => new LiveProbeArgs(probe, 1000))],
            JsonSerializer.SerializeToElement(args, Json), resume), recorder.Context, Json);
        return (task, recorder, subscription);
    }

    private static async Task<LiveEnd> Stop((Task<LiveEnd> Task, LiveRecorder Recorder, string Id) view)
    {
        view.Recorder.Context.Cancel(CancelReason.User);
        var end = await view.Task.WaitAsync(TimeSpan.FromSeconds(10));
        view.Recorder.Dispose();
        return end;
    }

    private static LiveSample? SampleOf(LiveTickEvent tick, string probe) => tick.Samples.FirstOrDefault(sample => sample.Probe == probe);

    private static async Task SyntheticChecks(Action<bool, string> check)
    {
        var service = new SqlService(new ResultStore(1L << 30, 1L << 29), hooks: true);
        var store = service.Results;
        // Five items a sample, one per group: the group facets never change after the first.
        var view = Subscribe(service, [SyntheticSampler.GridProbe], new { tickMs = 20, rows = 5, errorEvery = 3 });
        await view.Recorder.WaitAsync(recorder => recorder.Ticks.Count >= 3);
        // Paused, so the newest revisions stay readable while they are checked.
        service.Live.Update(new LiveUpdateArgs(view.Id, SyntheticSampler.Source, Paused: true), Json);
        await Task.Delay(200);
        var ticks = view.Recorder.Ticks.Take(3).ToList();
        var grids = ticks.Select(tick => SampleOf(tick, SyntheticSampler.GridProbe)).ToList();
        var groups = view.Recorder.Ticks.Select(tick => SampleOf(tick, SyntheticSampler.GridProbe)?.Tables?.FirstOrDefault(table => table.Table == 1)).Last(table => table is not null);
        check(grids[0]?.Tables is [{ Table: 0, Facets: [{ Column: "group", Values.Count: 5 }] }, { Table: 1 }] && groups is not null
            && Rows(store, groups.Descriptor).Select(row => row[0] + "=" + row[1]).SequenceEqual(["G0=1", "G1=1", "G2=1", "G3=1", "G4=1"])
            && grids[1]?.Tables is [{ Facets: null }, { Table: 1 }]
            && grids[2]?.Tables is [{ Table: 0 }] && ticks[2].Errors is [{ Code: "SQL_ERROR", Tables: [1], Terminal: false }],
            "one probe stores two tables a sample, the second built from the source's own state; facets come when they change; one failed statement names its table while the other arrives");

        // A view, a memory filter and departed rows, through live.update.
        async Task<List<string?[]>> Next(LiveProbeArgs patch)
        {
            // One revision under the new settings, read while the subscription is paused again.
            service.Live.Update(new LiveUpdateArgs(view.Id, SyntheticSampler.Source, Paused: false, Probes: [patch]), Json);
            var seen = view.Recorder.Ticks.Count;
            await view.Recorder.WaitAsync(recorder => recorder.Ticks.Count >= seen + 2);
            service.Live.Update(new LiveUpdateArgs(view.Id, SyntheticSampler.Source, Paused: true), Json);
            await Task.Delay(200);
            var latest = view.Recorder.Ticks.Select(tick => SampleOf(tick, SyntheticSampler.GridProbe)?.Tables?.FirstOrDefault(table => table.Table == 0)).Last(table => table is not null)!;
            return Rows(store, latest.Descriptor);
        }
        var evens = await Next(new LiveProbeArgs(SyntheticSampler.GridProbe, View: "even"));
        var filtered = await Next(new LiveProbeArgs(SyntheticSampler.GridProbe, Filter: new LiveFilterArgs("ITEM 1"), Clear: ["view"]));
        check(evens.Count > 0 && evens.All(row => long.Parse(row[0]!) % 2 == 0) && filtered.All(row => row[2]!.Contains("Item 1", StringComparison.Ordinal)),
            "an update's view keeps the view's rows, and its filter matches stored text case-insensitively");
        await Stop(view);

        // Paused while the track list is set, so the next revision is the first to see it.
        var tracked = Subscribe(service, [SyntheticSampler.GridProbe], new { tickMs = 300, rows = 4 }, id: 2);
        await tracked.Recorder.WaitAsync(recorder => recorder.Ticks.Count >= 1);
        service.Live.Update(new LiveUpdateArgs(tracked.Id, SyntheticSampler.Source, Paused: true), Json);
        await Task.Delay(200);
        var last = tracked.Recorder.Ticks[^1];
        var lowest = Ids(store, SampleOf(last, SyntheticSampler.GridProbe)!.Tables![0].Descriptor)[0]!;
        service.Live.Update(new LiveUpdateArgs(tracked.Id, SyntheticSampler.Source, Paused: false, Track: [new LiveTrackArgs(SyntheticSampler.GridProbe, 0, 3, [lowest])]), Json);
        var seen = tracked.Recorder.Ticks.Count;
        await tracked.Recorder.WaitAsync(recorder => recorder.Ticks.Count >= seen + 1);
        var departedRows = Rows(store, SampleOf(tracked.Recorder.Ticks[seen], SyntheticSampler.GridProbe)!.Tables![0].Descriptor);
        await tracked.Recorder.WaitAsync(recorder => recorder.Ticks.Count >= seen + 2);
        var departedTable = tracked.Recorder.Ticks.Skip(seen).Select(tick => SampleOf(tick, SyntheticSampler.GridProbe)?.Tables?.FirstOrDefault(table => table.Table == 0)).ToList();
        check(departedTable[0] is { Departed: [0], Tracked: { Seq: 3, Rows: [0] } } && departedRows[0][0] == lowest && departedTable[1] is { Departed: null, Tracked.Rows: [-1] },
            "a tracked item that left stays one revision as departed, then is gone");
        await Stop(tracked);

        var wide = Subscribe(service, [SyntheticSampler.WideProbe], new { tickMs = 20, rows = 50 }, id: 3);
        await wide.Recorder.WaitAsync(recorder => recorder.Ticks.Count >= 2);
        service.Live.Update(new LiveUpdateArgs(wide.Id, SyntheticSampler.Source, Paused: true), Json);
        await Task.Delay(200);
        var wideSample = SampleOf(wide.Recorder.Ticks[^1], SyntheticSampler.WideProbe);
        check(wideSample is { Tables: [{ Descriptor: { Columns.Count: 23, RowsAvailable: 50 } }], Status: [{ Id: "gen2", Value: int }] }
            && Rows(store, wideSample.Tables[0].Descriptor)[0][3] is { Length: 27 },
            "the wide probe stores 23 typed columns a sample and reports the backend's gen2 collections");
        await Stop(wide);

        var refused = new List<string>();
        foreach (var args in new object[] { new { start = new { tail = 0 } }, new { start = new { tail = 200_001 } }, new { start = "end" }, new { start = new { tail = 1, before = 2 } },
            new { start = new { before = 0 } }, new { logLevel = 4 }, new { logRows = 10_001 }, new { lateEvery = 0 } })
        {
            try
            {
                var bad = Subscribe(service, [SyntheticSampler.LogProbe], args, id: 9);
                await bad.Task.WaitAsync(TimeSpan.FromSeconds(5));
                refused.Add("accepted " + JsonSerializer.Serialize(args));
            }
            catch (RequestException error) when (error.Code == "INVALID_PARAMS") { }
        }
        check(refused.Count == 0, "the synthetic args refuse what main's schema refuses: start positions, log level, rows and lateness out of bounds: " + string.Join(", ", refused));
    }

    private static async Task LogChecks(Action<bool, string> check)
    {
        var service = new SqlService(new ResultStore(1L << 30, 1L << 29), hooks: true);
        var store = service.Results;
        var log = Subscribe(service, [SyntheticSampler.LogProbe], new { tickMs = 20, logRows = 4, lateEvery = 2 });
        await log.Recorder.WaitAsync(recorder => recorder.Ticks.Count >= 8);
        // Paused, so the segment stops growing while it is read.
        service.Live.Update(new LiveUpdateArgs(log.Id, SyntheticSampler.Source, Paused: true), Json);
        await Task.Delay(200);
        var appended = log.Recorder.Ticks.Select(tick => SampleOf(tick, SyntheticSampler.LogProbe)?.Append?[0]).Where(sample => sample is not null).ToList();
        var ids = Ids(store, appended[^1]!.Descriptor).Select(text => long.Parse(text!)).ToList();
        var resume = log.Recorder.Ticks.LastOrDefault(tick => tick.Resume is not null)?.Resume;
        var outOfOrder = ids.Zip(ids.Skip(1)).Any(pair => pair.Second < pair.First);
        // Every visible message is there once; only the one held back for the next sample may be missing.
        check(ids.Count == ids.Distinct().Count() && outOfOrder && Enumerable.Range(1, (int)ids.Max()).Select(id => (long)id).Except(ids).Count() <= 1 && resume is not null,
            "late messages (an id visible after higher ones) are appended exactly once, in arrival order, and the settled id moves the resume token: " + string.Join(",", ids.Take(12)));

        // A filter change restarts the table under the new predicate.
        service.Live.Update(new LiveUpdateArgs(log.Id, SyntheticSampler.Source, Paused: false, Probes: [new LiveProbeArgs(SyntheticSampler.LogProbe, Filter: new LiveFilterArgs("7"))]), Json);
        var seen = log.Recorder.Ticks.Count;
        await log.Recorder.WaitAsync(recorder => recorder.Ticks.Skip(seen).Any(tick => SampleOf(tick, SyntheticSampler.LogProbe)?.Append?[0].Restarted == true));
        var restart = log.Recorder.Ticks.Skip(seen).Select(tick => SampleOf(tick, SyntheticSampler.LogProbe)?.Append?[0]).First(sample => sample?.Restarted == true)!;
        check(restart.Retired is { Length: >= 1 } retired && retired.All(id => store.Find(id) is null) && Rows(store, restart.Descriptor).All(row => row[2]!.Contains('7')),
            "a new filter on a restart-mode probe retires the table's segments and starts it again under the filter");
        var end = await Stop(log);
        check(end.Resume is { } token && LiveResume.Decode(token).Contains(SyntheticSampler.LogProbe, StringComparison.Ordinal), "the end carries the last resume token");

        // Resumed from a token: the table reads only above the settled id it names.
        var settled = long.Parse(LiveResume.Decode(resume!).Split(',')[^1].TrimEnd(']', '}'));
        var resumed = Subscribe(service, [SyntheticSampler.LogProbe], new { tickMs = 20, logRows = 200 }, resume, id: 4);
        await resumed.Recorder.WaitAsync(recorder => recorder.Ticks.Count >= 1);
        var resumedRows = SampleOf(resumed.Recorder.Ticks[0], SyntheticSampler.LogProbe)?.Append?[0] is { } first ? Ids(store, first.Descriptor).Select(text => long.Parse(text!)).ToList() : [];
        check(settled > 0 && resumedRows.Count > 0 && resumedRows.Min() == settled + 1, "a subscription resumed with a token starts its append table after the settled id: " + settled + " then " + resumedRows.FirstOrDefault());
        await Stop(resumed);

        // A tail start: the last rows, after a note row naming the ones left out; a new start through args restarts.
        var tail = Subscribe(service, [SyntheticSampler.LogProbe], new { tickMs = 20, logRows = 5, start = new { tail = 2 } }, id: 5);
        await tail.Recorder.WaitAsync(recorder => recorder.Ticks.Count >= 1);
        // The segment goes on growing; the first sample's rows are the ones its descriptor counts.
        var tailFirst = SampleOf(tail.Recorder.Ticks[0], SyntheticSampler.LogProbe)!.Append![0].Descriptor;
        var tailRows = Rows(store, tailFirst).Take((int)tailFirst.RowsAvailable).ToList();
        service.Live.Update(new LiveUpdateArgs(tail.Id, SyntheticSampler.Source, Args: JsonSerializer.SerializeToElement(new { start = new { before = 3 } }, Json)), Json);
        seen = tail.Recorder.Ticks.Count;
        await tail.Recorder.WaitAsync(recorder => recorder.Ticks.Skip(seen).Any(tick => SampleOf(tick, SyntheticSampler.LogProbe)?.Append?[0].Restarted == true));
        var before = tail.Recorder.Ticks.Skip(seen).Select(tick => SampleOf(tick, SyntheticSampler.LogProbe)?.Append?[0]).FirstOrDefault(sample => sample?.Restarted == true);
        check(tailRows is [[null, null, "3 earlier rows are not shown."], ["4", "0", "Message 4"], ["5", "1", "Message 5"]] && before is not null && Ids(store, before.Descriptor).SequenceEqual(["1", "2"]),
            "a tail start shows the last rows after a note row, and a new start before an id restarts the table ending there: " + string.Join(" | ", tailRows.Select(row => string.Join(",", row))));
        await Stop(tail);
        check(store.Count == 0, "ended subscriptions leave no live table stored");
    }

    private static async Task EndChecks(Action<bool, string> check)
    {
        var service = new SqlService(new ResultStore(1L << 30, 1L << 29), hooks: true);
        var store = service.Results;
        var view = Subscribe(service, [SyntheticSampler.GridProbe, SyntheticSampler.LogProbe, SyntheticSampler.TableProbe], new { tickMs = 20, endAfterTicks = 4, logRows = 2 });
        var end = await view.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var ticks = view.Recorder.Ticks;
        uint Newest(string probe, int table, bool append = false) => ticks.Select(tick => SampleOf(tick, probe)).Select(sample => append ? sample?.Append?.FirstOrDefault(entry => entry.Table == table)?.Descriptor.ResultId
            : sample?.Tables?.FirstOrDefault(entry => entry.Table == table)?.Descriptor.ResultId).Last(id => id is not null)!.Value;
        uint[] expected = [Newest(SyntheticSampler.GridProbe, 0), Newest(SyntheticSampler.GridProbe, 1), Newest(SyntheticSampler.TableProbe, 0), Newest(SyntheticSampler.LogProbe, 0, true)];
        check(end is { Ended: "sourceEnded" } && end.Kept is { } kept && kept.Order().SequenceEqual(expected.Order()) && kept.All(id => store.Find(id) is { IsComplete: true }) && store.Count == kept.Length,
            "a source that ends keeps each snapshot table's newest revision and each append table's segments, complete and readable, and releases the rest");
        store.Release(end.Kept!);
        view.Recorder.Dispose();
    }

    private static void SqlChecks(Action<bool, string> check)
    {
        check(SqlSampler.Pattern("50%_a[b]\\") == "%50\\%\\_a\\[b]\\\\%" && SqlSampler.Pattern("x") == "%x%",
            "a restart filter becomes a LIKE pattern with its wildcards escaped (ESCAPE N'\\'), so the text matches only itself");
        var spec = Probe(ItemsTable(), Log());
        var good = new LiveQuery("test.tables", 17, "SELECT 1;", [], null, null, []) { Tables = [new(0), new(1, "SELECT 1;")] };
        var missing = good with { Tables = [new(0)] };
        var tailOnSnapshot = good with { Tables = [new(0, "SELECT 1;"), new(1)] };
        var badType = new LiveQuery("p", 17, "SELECT 1;", [], null, null, []) { Tables = [new(0)] };
        var badSpec = new LiveProbeJson("p", "s", "P", "P", new(1000, 1000, 1000), [], [new LiveTableJson("t", "snapshot", [Column("x", "image")], ["x"])], [], [], "none");
        check(good.Problems(spec).Count == 0 && missing.Problems(spec).Count == 1 && tailOnSnapshot.Problems(spec).Count == 1 && badType.Problems(badSpec).Count == 1
            && good.Texts(LiveSql.UncommittedPrologue).Count() == 2 && LiveCells.Supports("datetimeoffset") && !LiveCells.Supports("image") && LiveCells.Matches("sysname", "nvarchar") && !LiveCells.Matches("int", "bigint"),
            "a SQL probe's query reads each of its tables once, in order, with a tail only for append tables and only types live tables store");
    }
}
