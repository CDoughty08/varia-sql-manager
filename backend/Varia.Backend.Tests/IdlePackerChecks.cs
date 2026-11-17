using System.Diagnostics;
using System.Text.Json;
using Varia.Backend.Results;
using static Varia.Backend.Tests.PackerChecks;

namespace Varia.Backend.Tests;

/// <summary>Stage 2 of the page compression policy (ResultPacker, docs/page-compression-findings.md): shown results packed
/// once idle, what is not, a read arriving mid-pass, repeated use without packing and unpacking in a loop, fused and
/// rehydrating operations, release and shutdown while packing, the Memory panel's state, and a query's row waiting for
/// packing to make room (in the global budget and in its own half, refused at once when nothing can be packed, and given up
/// on shutdown). Most checks drive the policy with their own clock (PackDue); the room checks run its thread.</summary>
internal static class IdlePackerChecks
{
    private const long Idle = ResultPacker.VisibleIdleMs;

    public static void Run(Action<bool, string> check)
    {
        WhenAndWhat(check);
        Touched(check);
        ReadMidPass(check);
        GivesWay(check);
        Backoff(check);
        UnpackEdges(check);
        Operations(check);
        ReleaseAndStop(check);
        Room(check);
        RoomForQuery(check);
        RoomRecheck(check);
        RoomSpares(check);
        RoomEnough(check);
        NoRoom(check);
        Service(check);
    }

    private static void Read(ResultSetBuffer set, int page = 0)
    {
        using (set.Pin()) set.SealedSnapshot()[page % set.SealedPages].Body();
    }

    private static string State(ResultStore store, ResultSetBuffer set) => store.MemoryDetail().Largest.FirstOrDefault(entry => entry.ResultId == set.ResultId)?.State ?? "none";

    private static int PackedPages(ResultSetBuffer set) => set.SealedSnapshot().Count(page => page.StoredLength < page.Length);

    private static void WhenAndWhat(Action<bool, string> check)
    {
        var rig = new Rig(visibleIdle: Idle);
        var shown = Filled(rig.Store, "shown", BigRows);
        var small = Filled(rig.Store, "small", 2_000);
        var streaming = Open(rig.Store, "streaming");
        Write(streaming, 0, BigRows);
        streaming.Seal();
        var table = rig.Store.Open(new QueryBudget("live", new LiveBudget(64L << 20)), 0, 1, 1, "rows", W1Columns, W1Wires)!;
        Write(table, 0, BigRows / 4);
        table.Complete();
        var expected = Bodies(shown);
        rig.Clock = 1_000;
        rig.Show(shown.ResultId, small.ResultId, streaming.ResultId, table.ResultId);
        var used = rig.Store.UsedBytes;
        var next = rig.Packer.PackDue();
        check(next == 1_000 + Idle && !shown.HasPacked && rig.Store.UsedBytes == used,
            "a shown result is not packed before it has been idle for 30 s, and the policy knows when it falls due: " + next);
        rig.Clock += Idle - 1;
        check(rig.Packer.PackDue() == 1_000 + Idle && !shown.HasPacked, "a millisecond before its idle time a shown result is still raw");
        rig.Clock += 1;
        next = rig.Packer.PackDue();
        var saved = used - rig.Store.UsedBytes;
        check(next is null && AllPacked(shown) && !shown.NeedsPacking && saved > shown.BytesStored / 2 && State(rig.Store, shown) == "packed",
            "a complete shown result of 1 MiB or more untouched for 30 s is packed whole, its saving back in the budget at once: " + saved + " of " + shown.BytesStored);
        check(Same(expected, Bodies(shown)), "a packed shown result reads as it was sealed");
        check(!small.HasPacked && !streaming.HasPacked && !table.HasPacked, "a shown result under 1 MiB, one still storing rows and a live table are never packed");

        // Completing counts as a use: a result that completes while shown waits its idle time from then.
        rig.Clock += 5 * Idle;
        streaming.Complete();
        check(rig.Packer.PackDue() == rig.Clock + Idle && !streaming.HasPacked, "a shown result waits its idle time from when it completed, not from when it was shown");
        rig.Clock += Idle;
        rig.Packer.PackDue();
        check(AllPacked(streaming), "and is packed once idle that long");

        // A hidden result still waits only its 5 s, shown ones their 30 s.
        var hidden = Filled(rig.Store, "hidden", BigRows);
        var shownToo = Filled(rig.Store, "shownToo", BigRows);
        rig.Show(shownToo.ResultId);
        check(rig.Packer.PackDue() == rig.Clock + ResultPacker.DelayMs, "beside a shown result, a hidden one falls due after its own 5 s");
        rig.Clock += ResultPacker.DelayMs;
        rig.Packer.PackDue();
        check(AllPacked(hidden) && !shownToo.HasPacked, "the hidden one is packed then, the shown one not yet");

        // Stage 2 off packs no shown result, however long it is idle.
        var off = new Rig();
        var kept = Filled(off.Store, "kept", BigRows);
        off.Show(kept.ResultId);
        off.Packer.PackDue();
        off.Clock += 3_600_000;
        check(off.Packer.PackDue() is null && !kept.HasPacked, "with stage 2 off a shown result is never packed");
    }

    private static void Touched(Action<bool, string> check)
    {
        var rig = new Rig(visibleIdle: Idle);
        var set = Filled(rig.Store, "touched", BigRows);
        rig.Show(set.ResultId);
        rig.Packer.PackDue();
        var pokes = rig.Pokes;
        // Read every 20 s for five minutes, as a user scrolling now and then does: never idle for 30 s, so never packed, and
        // the reads never wake the policy.
        for (var i = 0; i < 15; i++)
        {
            rig.Clock += 20_000;
            Read(set, i);
            rig.Packer.PackDue();
        }
        check(!set.HasPacked && rig.Pokes == pokes && rig.Store.PackingSnapshot().PagesPacked == 0, "a shown result read every 20 s is never packed, and its reads do not wake the policy");
        check(rig.Packer.PackDue() == rig.Clock + Idle, "it falls due 30 s after its last read");

        // Held across its due time (a long sort or a Save): in use while held, and idle only from when the hold ends.
        rig.Clock += Idle / 2;
        var pin = set.Pin();
        rig.Clock += Idle * 2;
        var heldNext = rig.Packer.PackDue();
        var heldPokes = rig.Pokes;
        rig.Clock += 1_000;
        pin.Dispose();
        // Not even tried while held: a try would compress a page for nothing and its refusal would poke when the hold ends.
        check(heldNext == rig.Clock - 1_000 + Idle && !set.HasPacked && rig.Store.PackingSnapshot().PagesPacked == 0 && rig.Pokes == heldPokes,
            "a shown result held past its due time is in use while it is held, and not tried: " + rig.Store.PackingSnapshot().PagesPacked + " pages, " + (rig.Pokes - heldPokes) + " pokes");
        var ended = rig.Clock;
        rig.Clock += Idle - 1;
        check(rig.Packer.PackDue() == ended + Idle && !set.HasPacked, "and waits its idle time from when the hold ended");
        rig.Clock += 1;
        rig.Packer.PackDue();
        check(AllPacked(set), "then it is packed");

        // A packed shown result read again stays packed: reads go through the cache, so reading never undoes packing.
        var unpacked = rig.Store.PackingSnapshot().PagesUnpacked;
        for (var i = 0; i < 20; i++) Read(set, i);
        rig.Clock += Idle * 10;
        rig.Packer.PackDue();
        check(AllPacked(set) && !set.NeedsPacking && rig.Store.PackingSnapshot().PagesUnpacked > unpacked && rig.Store.PackingSnapshot().PagesPacked == set.SealedPages,
            "reading a packed shown result unpacks pages into the cache only: it stays packed and is never packed twice");
    }

    private static void ReadMidPass(Action<bool, string> check)
    {
        var rig = new Rig(visibleIdle: Idle);
        var set = Filled(rig.Store, "mid", BigRows);
        var expected = Bodies(set);
        rig.Show(set.ResultId);
        rig.Packer.PackDue();
        rig.Clock += Idle;
        // The pass asks before each page: two are packed, then the grid reads the result before the third.
        var pages = 0;
        rig.Packer.OnPage = page =>
        {
            if (page == set && ++pages == 3) Read(set, 5);
        };
        var stoppedNext = rig.Packer.PackDue();
        rig.Packer.OnPage = null;
        // The read pokes nothing (it never reached the set's lock): the pass it stopped must itself say when to look again.
        check(stoppedNext == rig.Clock + Idle, "the pass a read stopped returns when the rest falls due, its idle time after the read: " + (stoppedNext - rig.Clock));
        check(PackedPages(set) == 2 && set.NeedsPacking && State(rig.Store, set) == "partial",
            "a read arriving while a shown result is packed stops the pass at its next page, keeping what was packed, and the Memory panel says partly packed: " + PackedPages(set));
        check(Same(expected, Bodies(set)), "a partly packed result reads as it was sealed");
        var readAt = rig.Clock;
        check(rig.Packer.PackDue() == readAt + Idle && PackedPages(set) == 2, "the rest waits its idle time from the read");
        rig.Clock += Idle;
        rig.Packer.PackDue();
        check(AllPacked(set) && State(rig.Store, set) == "packed", "and is packed once idle again");

        // A read on another thread while a pass packs never waits for it: every read during a pass of a large result
        // finishes, and the pass stops for them.
        var large = Filled(rig.Store, "large", BigRows * 4);
        var bodies = Bodies(large);
        rig.Show(large.ResultId);
        var matched = true;
        var reads = 0;
        void ReadOne()
        {
            using (large.Pin())
            {
                var at = reads++ * 7 % bodies.Length;
                matched &= large.SealedSnapshot()[at].Body().AsSpan().SequenceEqual(bodies[at]);
            }
        }
        ReadOne();
        rig.Clock += Idle;
        // Reads start on another thread once three pages are packed, and run until the pass has stopped for them.
        var largePages = 0;
        var reading = new ManualResetEventSlim();
        var done = false;
        var reader = Task.Run(() =>
        {
            reading.Wait();
            while (!Volatile.Read(ref done) || reads < 50) ReadOne();
        });
        rig.Packer.OnPage = page =>
        {
            if (page != large || ++largePages != 4) return;
            // Wait until the reader has read once, so the next page sees the result touched however the threads are scheduled.
            var before = Volatile.Read(ref reads);
            reading.Set();
            SpinWait.SpinUntil(() => Volatile.Read(ref reads) > before, 30_000);
        };
        rig.Packer.PackDue();
        rig.Packer.OnPage = null;
        reading.Set();
        Volatile.Write(ref done, true);
        reader.Wait();
        check(matched && PackedPages(large) >= 3 && large.NeedsPacking && reads >= 50,
            "reads on another thread during a pass of a shown result see every page as sealed, and the pass stops for them: " + reads + " reads, " + PackedPages(large) + " pages packed");
    }

    private static void Backoff(Action<bool, string> check)
    {
        var rig = new Rig(visibleIdle: Idle);
        var set = Filled(rig.Store, "backoff", BigRows);
        rig.Show(set.ResultId);
        rig.Packer.PackDue();
        rig.Clock += Idle;
        rig.Packer.PackDue();
        check(AllPacked(set), "the fixture: a shown result packed once idle");
        // Each operation that unpacks it whole (a search through a sorted grid, a comparison read far out of order, a
        // transposed Copy or Save) doubles its wait, up to eight times.
        var waits = new List<long>();
        var ok = true;
        for (var k = 1; k <= 5; k++)
        {
            using (set.Pin()) ok &= set.TryUnpackAll() && !set.HasPacked;
            var next = rig.Packer.PackDue();
            waits.Add((next ?? 0) - rig.Clock);
            rig.Clock = (next ?? rig.Clock) - 1;
            rig.Packer.PackDue();
            ok &= !set.HasPacked;
            rig.Clock += 1;
            rig.Packer.PackDue();
            ok &= AllPacked(set);
        }
        check(ok && waits.SequenceEqual([2 * Idle, 4 * Idle, 8 * Idle, 8 * Idle, 8 * Idle]),
            "a shown result an operation keeps unpacking waits twice as long each time, up to four minutes, so it is not packed and unpacked in a loop: " + string.Join(",", waits));
        check(rig.Store.PackingSnapshot().PagesPacked == 6L * set.SealedPages, "each of those packings packed every page once");
    }

    private static void GivesWay(Action<bool, string> check)
    {
        // An idle pass gives way at its next page to a query that asks for room, and the policy goes straight to its pass.
        var rig = new Rig(visibleIdle: Idle);
        var shown = Filled(rig.Store, "idle", BigRows);
        var spare = Filled(rig.Store, "spare", BigRows);
        var query = rig.Store.BeginQuery("query");
        rig.Show(shown.ResultId, spare.ResultId);
        rig.Packer.PackDue();
        rig.Clock += Idle / 2;
        Read(spare);
        rig.Clock += Idle / 2;
        var asked = false;
        var seen = 0;
        // Asked before its second page: the first is packed, and the pass stops before the next.
        rig.Packer.OnPage = page =>
        {
            if (page != shown || ++seen != 2) return;
            asked = rig.Packer.MakeRoom(query, global: true);
        };
        var next = rig.Packer.PackDue();
        rig.Packer.OnPage = null;
        check(asked && next == rig.Clock && shown.HasPacked && !AllPacked(shown) && !spare.HasPacked,
            "an idle pass stops at its next page when a query asks for room, and the policy runs again at once: " + PackedPages(shown) + " of " + shown.SealedPages + " pages, next " + (next - rig.Clock));
    }

    private static void UnpackEdges(Action<bool, string> check)
    {
        var rig = new Rig(visibleIdle: Idle);
        // A comparison unpacks every side once one is packed: a raw side changes nothing and is no use of it.
        var raw = Filled(rig.Store, "raw side", BigRows);
        using (raw.Pin()) raw.UnpackAll(0);
        check(raw.Unpacks == 0, "unpacking a result with nothing packed is not counted as an unpack");
        // A cancelled unpack changes nothing: the whole packing still holds, so it is neither partly packed nor due again.
        var packed = Filled(rig.Store, "cancelled unpack", BigRows);
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs;
        rig.Packer.PackDue();
        var fixture = AllPacked(packed) && !packed.NeedsPacking;
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        string? thrown = null;
        try { using (packed.Pin()) packed.TryUnpackAll(cancelled.Token); }
        catch (OperationCanceledException error) { thrown = error.GetType().Name; }
        check(fixture && thrown is not null && AllPacked(packed) && !packed.NeedsPacking && State(rig.Store, packed) == "packed",
            "a cancelled unpack leaves the result packed, not partly packed or due again: " + thrown + ", " + State(rig.Store, packed));
    }

    private static void Operations(Action<bool, string> check)
    {
        var rig = new Rig(visibleIdle: Idle);
        using var service = new SqlService(rig.Store);
        var set = Filled(rig.Store, "operations", BigRows);
        rig.Show(set.ResultId);
        rig.Packer.PackDue();
        rig.Clock += Idle;
        rig.Packer.PackDue();
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        // A sort reads a packed result fused, page by page, and leaves it packed: nothing to pack again afterwards.
        var view = Call<ResultsViewResult>("results.view", new { resultId = set.ResultId, sort = new[] { new { column = 0, descending = true, mode = "value" } } });
        check(view.Rows == set.RowsAvailable && AllPacked(set) && !set.NeedsPacking && set.Unpacks == 0 && State(rig.Store, set) == "packed",
            "a sort of a packed shown result reads it packed and leaves it packed");
        // An operation that still unpacks first (a search through a grid sorted far from the pages' order, a transposed Copy
        // or Save) counts as a use.
        bool unpacked;
        using (set.Pin()) unpacked = set.TryUnpackAll();
        check(unpacked && !set.HasPacked && set.NeedsPacking && set.Unpacks == 1, "an operation's unpack of a packed shown result leaves it raw and due again");
        // Its grid is still sorted (the view is open): it is packed once idle all the same, its wait doubled by the unpack,
        // and its screens read the packed pages.
        var next = rig.Packer.PackDue();
        rig.Clock += 2 * Idle;
        rig.Packer.PackDue();
        check(next == rig.Clock && AllPacked(set) && rig.Store.FindView(set.ResultId, view.ViewId) is not null,
            "a shown result whose grid is sorted or filtered is packed once idle, its wait doubled by the unpack: " + next);
        check(rig.Store.CloseViews(set.ResultId, [view.ViewId]) == 1 && AllPacked(set), "closing its view leaves it packed");
        // Hidden, a sorted result is packed as any other (stage 1).
        var sorted = Filled(rig.Store, "sorted", BigRows);
        var sortedView = Call<ResultsViewResult>("results.view", new { resultId = sorted.ResultId, sort = new[] { new { column = 0, descending = true, mode = "value" } } });
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs;
        rig.Packer.PackDue();
        check(AllPacked(sorted), "a hidden result with an open view is packed after its 5 s");
        rig.Show(sorted.ResultId);
        rig.Packer.PackDue();
        check(AllPacked(sorted) && rig.Store.FindView(sorted.ResultId, sortedView.ViewId) is not null && sorted.Unpacks == 0, "shown again with its grid still sorted, it stays packed: its screens read the packed pages");

        // A shown result packed while idle, then sorted: the sort reads it packed and the policy leaves it packed, so sorting
        // never costs the raw bytes back (Stage 2 once unpacked it whole for the view's screens).
        var later = Filled(rig.Store, "sorted later", BigRows);
        rig.Show(later.ResultId);
        rig.Packer.PackDue();
        rig.Clock += Idle;
        rig.Packer.PackDue();
        check(AllPacked(later), "the fixture: a shown result packed once idle");
        long unpackNeed;
        using (later.Pin()) unpackNeed = later.UnpackNeed();
        var usedPacked = rig.Store.UsedBytes;
        var sortedLater = Call<ResultsViewResult>("results.view", new { resultId = later.ResultId, sort = new[] { new { column = 0, descending = true, mode = "value" } } });
        rig.Packer.PackDue();
        var grown = rig.Store.UsedBytes - usedPacked;
        check(AllPacked(later) && later.Unpacks == 0 && State(rig.Store, later) == "packed" && grown < unpackNeed / 4,
            "sorting a packed shown result leaves it packed after the policy looks: grew " + grown + " bytes, unpacking would add " + unpackNeed);
        // Its screens read through the view without unpacking it whole.
        var screen = rig.Store.FindView(later.ResultId, sortedLater.ViewId) ?? throw new InvalidOperationException("The view was not kept.");
        var screenRows = 0;
        foreach (var page in ViewPages.Build(screen, later.RowsAvailable / 2, 256)) screenRows += page.Rows;
        rig.Packer.PackDue();
        check(screenRows == 256 && AllPacked(later) && later.Unpacks == 0, "a sorted screen of a packed shown result reads it packed: " + screenRows + " rows");
        rig.Clock += 100 * Idle;
        check(rig.Packer.PackDue() is null && AllPacked(later), "and it stays packed while the view is open");

        foreach (var done in new[] { later, sorted }) rig.Store.Release(done.ResultId);

        // A column's value list (a distinct snapshot) keeps its result's pages, not their bytes, and reads them packed: a
        // result with one open is packed as any other, and the budget gets the raw bytes back.
        var listed = Filled(rig.Store, "listed", BigRows);
        var snapshot = Call<ResultsDistinctResult>("results.distinct", new { resultId = listed.ResultId, column = 0 });
        var usedRaw = rig.Store.UsedBytes;
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs;
        rig.Packer.PackDue();
        check(AllPacked(listed) && rig.Store.FindSnapshot(listed.ResultId, snapshot.SnapshotId) is not null && rig.Store.UsedBytes < usedRaw, "a result with an open value list is packed as any hidden result, its raw bytes given back: " + rig.Store.UsedBytes + " of " + usedRaw);
    }

    private static void ReleaseAndStop(Action<bool, string> check)
    {
        var rig = new Rig(visibleIdle: Idle);
        var other = Filled(rig.Store, "other", 2_000);
        var set = Filled(rig.Store, "released", BigRows);
        rig.Show(set.ResultId, other.ResultId);
        rig.Packer.PackDue();
        rig.Clock += Idle;
        var pages = 0;
        rig.Packer.OnPage = page =>
        {
            if (page == set && ++pages == 4) rig.Store.Release(set.ResultId);
        };
        rig.Packer.PackDue();
        rig.Packer.OnPage = null;
        check(set.IsReleased && rig.Store.UsedBytes == other.Budget.UsedBytes && rig.Store.PackingSnapshot() is { PackedBytes: 0, PackedLogicalBytes: 0, CacheBytes: 0 },
            "a shown result released while it is packed stops packing and returns every byte, packed or raw, exactly once");

        // Shutdown while a shown result is packed: the pass stops at its next page, what was packed stays packed and reads.
        var stopped = Filled(rig.Store, "stopped", BigRows);
        var expected = Bodies(stopped);
        rig.Show(stopped.ResultId);
        rig.Clock += 1;
        rig.Packer.PackDue();
        rig.Clock += Idle;
        pages = 0;
        rig.Packer.OnPage = page =>
        {
            if (page == stopped && ++pages == 3) rig.Packer.Dispose();
        };
        rig.Packer.PackDue();
        check(PackedPages(stopped) == 2 && rig.Store.RoomMaker is null && Same(expected, Bodies(stopped)),
            "disposing the policy while it packs a shown result stops at the next page, and what was packed reads as sealed: " + PackedPages(stopped));
    }

    /// <summary>Stores rows as the query's ingestion does (SqlService), through its own wait for room when a row is refused
    /// (<see cref="SqlService.WaitAndCommitAsync"/>); returns how many rows waited. <paramref name="waited"/> is how long they
    /// waited in all, without the time spent storing rows.</summary>
    private static int Ingest(ResultStore store, ResultSetBuffer set, long rows, SqlService.RoomWaited? waited = null)
    {
        waited ??= new SqlService.RoomWaited();
        var waits = 0;
        for (long row = 0; row < rows; row++)
        {
            set.CountRow();
            if (set.BeginRow() is not { } builder) continue;
            SyntheticRows.WriteCells("W1", row, builder);
            if (set.TryCommitRow(0, mayWait: true) || set.RoomWanted == 0) continue;
            waits++;
            SqlService.WaitAndCommitAsync(store, set, 0, waited, CancellationToken.None).GetAwaiter().GetResult();
        }
        set.Complete();
        return waits;
    }

    /// <summary>A store and its policy on the real clock, the thread started, with delays so long that only room packs.</summary>
    private static (ResultStore Store, ResultVisibility Visibility, ResultPacker Packer) Running(long global, long query)
    {
        var store = new ResultStore(global, query) { Packing = PagePacking.OnRequest };
        var visibility = new ResultVisibility(id => store.Find(id) is not null);
        // Above normal shows that packing for room never lowers its threads (it counts pages compressed lowered).
        var packer = new ResultPacker(store, visibility, delayMs: 1L << 40, visibleIdleMs: 1L << 40) { Priority = ThreadPriority.AboveNormal };
        packer.Start();
        return (store, visibility, packer);
    }

    private static void Room(Action<bool, string> check)
    {
        // About 18 MiB shown and in use, and a 23 MiB query in a 32 MiB budget: it fits only once the first is packed.
        var (store, visibility, packer) = Running(32L << 20, 32L << 20);
        using var running = packer;
        var shown = Filled(store, "shown", BigRows * 2);
        var expected = Bodies(shown);
        visibility.Set(Guid.NewGuid(), 1, [shown.ResultId], out _);
        var table = store.Open(new QueryBudget("live", new LiveBudget(64L << 20)), 0, 1, 1, "rows", W1Columns, W1Wires)!;
        Write(table, 0, 2_000);
        table.Complete();
        var gate = new ViewSorter.WorkerGate(() => 4);
        packer.RoomGate = gate;
        var query = Open(store, "query");
        var timer = Stopwatch.StartNew();
        var waits = Ingest(store, query, BigRows * 5 / 2);
        timer.Stop();
        // The query goes on as soon as enough pages are packed; the pass packs the rest of the result after it.
        SpinWait.SpinUntil(() => AllPacked(shown), 60_000);
        check(query.IsComplete && query.Truncated == TruncationReason.None && query.RowsAvailable == BigRows * 5 / 2 && query.Budget.Stopped == TruncationReason.None && waits > 0,
            "a query refused for the global budget waits while a complete result is packed for it, and stores every row: " + waits + " waits, " + timer.ElapsedMilliseconds + " ms, " + query.RowsAvailable + " rows");
        check(AllPacked(shown) && !table.HasPacked && Same(expected, Bodies(shown)) && store.UsedBytes <= store.GlobalBytes && packer.RoomPasses > 0,
            "the shown result was packed for it at once, though not idle, a live table was not, and the budget held: " + store.UsedBytes + " of " + store.GlobalBytes);
        // The last page is replaced just before the pass gives its lease back.
        SpinWait.SpinUntil(() => gate.Busy == 0, 30_000);
        check(gate.Peak > 0 && gate.Busy == 0 && packer.PagesAtPriority == 0, "packing for room runs on the results' shared workers at normal priority: peak " + gate.Peak + ", busy " + gate.Busy + ", lowered " + packer.PagesAtPriority);
    }

    private static void RoomForQuery(Action<bool, string> check)
    {
        // The query's own half is full (24 MiB of a 64 MiB budget): only its own complete result can make room for it.
        var (store, _, packer) = Running(64L << 20, 24L << 20);
        using var running = packer;
        var stranger = Filled(store, "stranger", BigRows * 2);
        var budget = store.BeginQuery("query");
        var first = store.Open(budget, 0, 1, 1, "rows", W1Columns, W1Wires)!;
        Write(first, 0, BigRows * 2);
        first.Complete();
        var second = store.Open(budget, 1, 1, 1, "rows", W1Columns, W1Wires)!;
        var waits = Ingest(store, second, BigRows * 7 / 4);
        SpinWait.SpinUntil(() => AllPacked(first), 60_000);
        check(second.IsComplete && second.Truncated == TruncationReason.None && second.RowsAvailable == BigRows * 7 / 4 && waits > 0 && AllPacked(first) && !stranger.HasPacked,
            "a query refused for its own half waits while its own earlier result is packed, not other queries' results: " + waits + " waits, " + second.RowsAvailable + " rows, " + second.Truncated + ", first packed " + AllPacked(first) + ", stranger packed " + stranger.HasPacked);
    }

    private static void RoomRecheck(Action<bool, string> check)
    {
        // An operation that takes hold of a later shown candidate while packing for room works on an earlier one: that
        // candidate is asked again before it is packed, so a result an operation is reading is not packed under it.
        var (store, visibility, packer) = Running(40L << 20, 40L << 20);
        using var running = packer;
        var first = Filled(store, "hidden first", BigRows * 2);
        var later = Filled(store, "shown later", BigRows);
        // Smaller than the later one, so it comes after it in the pass: packing it shows the pass went past the later one.
        var spare = Filled(store, "shown spare", BigRows / 2);
        visibility.Set(Guid.NewGuid(), 1, [later.ResultId, spare.ResultId], out _);
        var query = Open(store, "query");
        var opened = 0;
        IDisposable? hold = null;
        packer.OnPage = page =>
        {
            if (page != first || Interlocked.Exchange(ref opened, 1) != 0) return;
            hold = later.Pin();
        };
        // A wait for more than packing everything can free: it asks again on every page's saving and stays until nothing is
        // left to pack, so the pass goes on past the first to every later candidate.
        var fits = store.WaitForRoomAsync(query.Budget, 39L << 20, waitMs: 60_000).GetAwaiter().GetResult();
        SpinWait.SpinUntil(() => AllPacked(first) && AllPacked(spare), 60_000);
        packer.OnPage = null;
        check(!fits && opened == 1 && AllPacked(first) && AllPacked(spare) && !later.HasPacked,
            "a shown result an operation took hold of while packing for room works on another is not packed for it: " + opened + ", first packed " + AllPacked(first) + ", spare packed " + AllPacked(spare) + ", later packed " + later.HasPacked);
        hold?.Dispose();
    }

    private static void RoomSpares(Action<bool, string> check)
    {
        // Packing for room passes over a result an operation has just unpacked (a search through a sorted grid, say) and may
        // need again, but not a shown one whose grid is sorted: that one is packed with the hidden one, which makes the room
        // the query needs.
        var (store, visibility, packer) = Running(40L << 20, 40L << 20);
        using var running = packer;
        using var service = new SqlService(store);
        T Call<T>(string method, object args) => (T)service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        var fodder = Filled(store, "hidden", BigRows);
        var viewed = Filled(store, "shown sorted", BigRows);
        var searched = Filled(store, "shown searched", BigRows);
        visibility.Set(Guid.NewGuid(), 1, [viewed.ResultId, searched.ResultId], out _);
        Call<ResultsViewResult>("results.view", new { resultId = viewed.ResultId, sort = new[] { new { column = 0, descending = true, mode = "value" } } });
        searched.Pack(() => true);
        using (searched.Pin()) searched.TryUnpackAll();
        var fixture = !viewed.HasPacked && !searched.HasPacked && searched.Unpacks == 1;
        var query = Open(store, "query");
        var waited = new SqlService.RoomWaited();
        Ingest(store, query, BigRows * 3, waited);
        SpinWait.SpinUntil(() => AllPacked(fodder), 60_000);
        // The searched one is no candidate; packing the other two makes room for all the query's rows, without waiting out its cap.
        SpinWait.SpinUntil(() => AllPacked(viewed), 60_000);
        check(fixture && AllPacked(fodder) && AllPacked(viewed) && !searched.HasPacked && query.Truncated == TruncationReason.None && waited.Ms < ResultStore.RoomWaitMs,
            "packing for room packs a shown result with a sorted grid and passes over one an operation has just unpacked: fodder " + AllPacked(fodder) + ", viewed " + viewed.HasPacked + ", searched " + searched.HasPacked + ", " + query.Truncated + ", " + waited.Ms + " ms waited");
    }

    private static void RoomEnough(Action<bool, string> check)
    {
        // A pass for room stops once no query waits: the rows asked for are stored, so the next candidate stays raw, though
        // the wait asked again during the pass. Driven by its own clock, so the pass ends before the checks look.
        var rig = new Rig(visibleIdle: Idle);
        rig.Store.RoomMaker = rig.Packer.MakeRoom;
        var first = Filled(rig.Store, "hidden larger", BigRows * 2);
        var second = Filled(rig.Store, "hidden smaller", BigRows);
        rig.Store.Resize(rig.Store.UsedBytes, rig.Store.UsedBytes);
        var query = rig.Store.BeginQuery("query");
        var pages = 0;
        Task<bool>? waiting = null;
        rig.Packer.OnPage = page =>
        {
            if (page != first) return;
            var at = Interlocked.Increment(ref pages);
            // As a wait does on a page's saving that is not yet enough: ask again.
            if (at == 1) rig.Packer.MakeRoom(query, global: true);
            // By its last page the first has saved far more than the 1 MiB asked for: the wait has ended.
            if (at == first.SealedPages) SpinWait.SpinUntil(() => waiting!.IsCompleted, 30_000);
        };
        waiting = rig.Store.WaitForRoomAsync(query, 1L << 20, waitMs: 60_000);
        rig.Packer.PackDue();
        rig.Packer.OnPage = null;
        var fits = waiting.Wait(TimeSpan.FromSeconds(30)) && waiting.Result;
        check(fits && AllPacked(first) && !second.HasPacked && rig.Packer.RoomPasses == 1,
            "a pass for room stops once no query waits, leaving the next candidate raw: fits " + fits + ", first packed " + AllPacked(first) + ", second packed " + second.HasPacked + ", " + rig.Packer.RoomPasses + " passes");
    }

    private static void NoRoom(Action<bool, string> check)
    {
        // Nothing to pack (the only other result is held by a Save): the row is refused at once, as before.
        var (store, visibility, packer) = Running(24L << 20, 24L << 20);
        using (packer)
        {
            var held = Filled(store, "held", BigRows * 2);
            check(held.TryLease(), "the fixture: a Save holds the result");
            var passes = packer.RoomPasses;
            var query = Open(store, "query");
            var waited = new SqlService.RoomWaited();
            var waits = Ingest(store, query, BigRows * 2, waited);
            check(waits == 1 && query.Truncated == TruncationReason.GlobalBudget && packer.RoomPasses == passes && !held.HasPacked && waited.Ms < ResultStore.RoomWaitMs,
                "with nothing that could be packed a refused row stops the query at once: " + waits + " waits, " + waited.Ms + " ms waited");
            held.ReleaseLease();

            // A held result first in line (hidden) is passed over, not waited on: the shown one after it makes the room.
            store.ReleaseAll();
            store.Resize(40L << 20, 40L << 20);
            var leased = Filled(store, "leased", BigRows);
            check(leased.TryLease(), "the fixture: a Save holds the hidden result");
            var free = Filled(store, "free", BigRows * 2);
            visibility.Set(Guid.NewGuid(), 1, [free.ResultId], out _);
            var after = Open(store, "after");
            waited = new SqlService.RoomWaited();
            var freeWaits = Ingest(store, after, BigRows * 5 / 2, waited);
            SpinWait.SpinUntil(() => AllPacked(free), 60_000);
            check(after.Truncated == TruncationReason.None && freeWaits > 0 && AllPacked(free) && !leased.HasPacked && waited.Ms < ResultStore.RoomWaitMs,
                "a held result never stalls packing for room: the next one is packed and the query stores every row: " + freeWaits + " waits, " + waited.Ms + " ms waited");
            leased.ReleaseLease();
            store.ReleaseAll();
            store.Resize(24L << 20, 24L << 20);

            // Packing cannot make enough room: the query waits while it does, then stops for the budget, its rows a prefix.
            store.ReleaseAll();
            var packable = Filled(store, "packable", BigRows * 2);
            var greedy = Open(store, "greedy");
            waited = new SqlService.RoomWaited();
            waits = Ingest(store, greedy, BigRows * 4, waited);
            check(waits > 0 && greedy.Truncated == TruncationReason.GlobalBudget && greedy.RowsAvailable < BigRows * 4 && greedy.Describe().RowsStored == greedy.RowsAvailable
                && AllPacked(packable) && waited.Ms < ResultStore.RoomWaitMs,
                "a query that does not fit even with everything packed stops for the budget once nothing more can be packed: " + waits + " waits, " + waited.Ms + " ms waited");

            // A derived set (a pivot, a comparison) never waits: it is refused whole and can be made again.
            var derived = store.Open(store.BeginQuery("derived"), 0, 1, 1, "rows", W1Columns, W1Wires, derived: true)!;
            var refusedAt = -1L;
            for (long row = 0; row < BigRows * 4 && refusedAt < 0; row++)
            {
                if (derived.BeginRow() is not { } builder) break;
                SyntheticRows.WriteCells("W1", row, builder);
                if (!derived.TryCommitRow(0, mayWait: true)) refusedAt = row;
            }
            check(refusedAt >= 0 && derived.RoomWanted == 0, "a derived set refused for room does not wait for packing");
        }

        // Shutdown while a row waits: the wait ends at once rather than at its deadline.
        var store2 = new ResultStore(24L << 20, 24L << 20) { Packing = PagePacking.OnRequest };
        var visibility2 = new ResultVisibility(id => store2.Find(id) is not null);
        var idle = new ResultPacker(store2, visibility2, delayMs: 1L << 40, visibleIdleMs: 1L << 40);
        // Hooked but never started: nothing packs, so only disposal can end the wait.
        store2.RoomMaker = idle.MakeRoom;
        Filled(store2, "waiting on", BigRows * 2);
        var full = store2.BeginQuery("full");
        store2.TryReserve(full, store2.GlobalBytes - store2.UsedBytes, false, out _);
        var timer2 = Stopwatch.StartNew();
        var wait = store2.WaitForRoomAsync(full, 1L << 20, waitMs: 60_000);
        var waiting = !wait.IsCompleted;
        idle.Dispose();
        var given = wait.Wait(TimeSpan.FromSeconds(30)) ? wait.Result : (bool?)null;
        check(waiting && given == false && timer2.ElapsedMilliseconds < 30_000 && store2.RoomMaker is null, "disposing the policy ends a wait for room long before its deadline: " + timer2.ElapsedMilliseconds + " ms");
        using var cancelled = new CancellationTokenSource();
        store2.RoomMaker = (_, _) => true;
        var cancel = store2.WaitForRoomAsync(full, 1L << 20, cancelled.Token, waitMs: 60_000);
        cancelled.Cancel();
        string? error = null;
        try { cancel.Wait(TimeSpan.FromSeconds(30)); }
        catch (AggregateException failure) { error = failure.InnerException?.GetType().Name; }
        check(error is nameof(TaskCanceledException) or nameof(OperationCanceledException), "a cancelled query stops waiting for room: " + error);

        // Its own half and the global budget both full: only its own results can make room in its half, so it asks for
        // those alone rather than packing every query's results for nothing.
        var store3 = new ResultStore(32L << 20, 8L << 20) { Packing = PagePacking.OnRequest };
        var own = store3.BeginQuery("own");
        var filler = store3.BeginQuery("filler");
        var reserved = store3.TryReserve(own, 8L << 20, false, out _) && store3.TryReserve(filler, 8L << 20, false, out _)
            && store3.TryReserve(store3.BeginQuery("more"), 8L << 20, false, out _) && store3.TryReserve(store3.BeginQuery("last"), 8L << 20, false, out _);
        var asked = new List<bool>();
        store3.RoomMaker = (_, global) => { lock (asked) asked.Add(global); return false; };
        var refused = store3.WaitForRoomAsync(own, 1L << 20, waitMs: 60_000).GetAwaiter().GetResult();
        check(reserved && !refused && asked.SequenceEqual([false]), "a query whose own half is full asks for room in its own half only: " + string.Join(",", asked));

        // A policy that says it is packing but never makes room: the query's rows wait the query's cap in all, however
        // many rows and result sets wait, then stop for the budget as they would have.
        var store4 = new ResultStore(8L << 20, 8L << 20) { Packing = PagePacking.OnRequest, RoomMaker = (_, _) => true };
        var capped = new SqlService.RoomWaited();
        const long CapMs = 300;
        bool Refused(ResultSetBuffer set, out long stored)
        {
            stored = 0;
            for (long row = 0; ; row++)
            {
                set.CountRow();
                if (set.BeginRow() is not { } builder) return false;
                SyntheticRows.WriteCells("W1", row, builder);
                if (!set.TryCommitRow(0, mayWait: true)) return set.RoomWanted > 0;
                stored++;
            }
        }
        var waitingSet = Open(store4, "capped");
        var firstRefused = Refused(waitingSet, out var firstStored);
        var firstStoredIt = SqlService.WaitAndCommitAsync(store4, waitingSet, 0, capped, CancellationToken.None, CapMs).GetAwaiter().GetResult();
        var afterFirst = capped.Ms;
        waitingSet.Complete();
        check(firstRefused && !firstStoredIt && waitingSet.Truncated is TruncationReason.GlobalBudget or TruncationReason.QueryBudget && waitingSet.Budget.Stopped != TruncationReason.None && waitingSet.RowsAvailable == firstStored && afterFirst >= CapMs - 50 && afterFirst < ResultStore.RoomWaitMs,
            "a row that never gets room waits at most the query's cap, then stops the query for the budget, its rows a prefix: " + afterFirst + " ms waited, " + waitingSet.RowsAvailable + " of " + firstStored + " rows");
        // The query's next result set shares what it waited: with the cap spent, its refused row stops at once.
        store4.Release(waitingSet.ResultId);
        var nextSet = Open(store4, "capped next");
        var nextRefused = Refused(nextSet, out _);
        var nextStoredIt = SqlService.WaitAndCommitAsync(store4, nextSet, 0, capped, CancellationToken.None, CapMs).GetAwaiter().GetResult();
        check(nextRefused && !nextStoredIt && capped.Ms - afterFirst < CapMs / 2 && nextSet.Budget.Stopped != TruncationReason.None,
            "a later result set of the same query does not wait again once the query's cap is spent: " + (capped.Ms - afterFirst) + " ms more");

        // Cancelled while a row waits: the open row is rolled back and the cancellation reaches the query.
        var store5 = new ResultStore(8L << 20, 8L << 20) { Packing = PagePacking.OnRequest, RoomMaker = (_, _) => true };
        var cancelledSet = Open(store5, "cancelled");
        var cancelledRefused = Refused(cancelledSet, out var cancelledStored);
        using var stop = new CancellationTokenSource();
        stop.Cancel();
        string? thrown = null;
        try { SqlService.WaitAndCommitAsync(store5, cancelledSet, 0, new SqlService.RoomWaited(), stop.Token).GetAwaiter().GetResult(); }
        catch (OperationCanceledException failure) { thrown = failure.GetType().Name; }
        cancelledSet.Seal();
        check(cancelledRefused && thrown is not null && cancelledSet.RowsAvailable == cancelledStored,
            "a query cancelled while a row waits for room rolls that row back and stops: " + thrown + ", " + cancelledSet.RowsAvailable + " of " + cancelledStored + " rows");
    }

    private static void Service(Action<bool, string> check)
    {
        var service = new SqlService(new ResultStore(1L << 30, 1L << 30), packHidden: true);
        check(service.Packer is { VisibleDelay: ResultPacker.VisibleIdleMs } && service.Results.RoomMaker is not null,
            "the backend process's policy packs shown results idle for 30 s and makes room for refused rows");
        service.Dispose();
        check(service.Results.RoomMaker is null, "and stops making room when the service ends");
    }
}
