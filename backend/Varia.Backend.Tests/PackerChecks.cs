using System.Diagnostics;
using System.Text.Json;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>The hidden-result packing policy (ResultPacker, stage 1 of docs/page-compression-findings.md): what is packed
/// and when, what never is, stopping when a result is shown, held or released, the budget and the Memory panel's figures
/// before and after, packing again after an operation unpacked a result, reads and a new query while packing, and the
/// thread's lifetime. Most checks drive the policy with their own clock (PackDue); the last ones run its thread.</summary>
internal static class PackerChecks
{
    private static readonly IReadOnlyList<ResultColumn> W1Columns = [.. SyntheticRows.Columns("W1").Select(column => new ResultColumn(column.Name, column.DataType, column.Wire == WireKind.Text ? "text" : "binary"))];
    private static readonly IReadOnlyList<WireKind> W1Wires = [.. SyntheticRows.Columns("W1").Select(column => column.Wire)];
    /// <summary>W1 rows of about 9 MiB, well over the policy's floor, in about 35 pages.</summary>
    private const int BigRows = 40_000;

    private static ResultSetBuffer Open(ResultStore store, string session) =>
        store.Open(store.BeginQuery(session), 0, 1, 1, "rows", W1Columns, W1Wires) ?? throw new InvalidOperationException("The result set was not kept.");

    private static void Write(ResultSetBuffer set, long from, long rows)
    {
        for (var row = from; row < from + rows; row++)
        {
            set.CountRow();
            if (set.BeginRow() is not { } builder) continue;
            SyntheticRows.WriteCells("W1", row, builder);
            set.TryCommitRow();
        }
    }

    private static ResultSetBuffer Filled(ResultStore store, string session, long rows)
    {
        var set = Open(store, session);
        Write(set, 0, rows);
        set.Complete();
        return set;
    }

    private static byte[][] Bodies(ResultSetBuffer set)
    {
        using var pin = set.Pin();
        return [.. set.SealedSnapshot().Select(page => page.Body())];
    }

    private static bool Same(byte[][] left, byte[][] right) => left.Length == right.Length && left.Zip(right).All(pair => pair.First.AsSpan().SequenceEqual(pair.Second));

    /// <summary>Every page is held packed: W1 pages always pack smaller. (Only the accessor and PackingChecks read the stored form;
    /// tests/result-page-access.test.ts.)</summary>
    private static bool AllPacked(ResultSetBuffer set) => set.SealedSnapshot().All(page => page.StoredLength < page.Length);

    /// <summary>A store on request, a visibility table on the check's clock and a policy over them, its thread not started.</summary>
    private sealed class Rig
    {
        public long Clock;
        public readonly ResultStore Store;
        public readonly ResultVisibility Visibility;
        public readonly ResultPacker Packer;
        public int Pokes;
        /// <summary>Runs once inside the visibility table's next lookups, counting down (the checks' way into a pass).</summary>
        public Func<uint, bool>? OnLookup;
        private readonly Guid source = Guid.NewGuid();
        private long seq;

        public Rig(long global = 1L << 30)
        {
            Store = new ResultStore(global, global) { Packing = PagePacking.OnRequest };
            Visibility = new ResultVisibility(id => (OnLookup?.Invoke(id) ?? true) && Store.Find(id) is not null, () => Clock);
            // The checks run passes on their own threads: compressing at the product's lowest priority would starve them on
            // a busy machine (offline-stress), and the priority is not what they test (Priorities does).
            Packer = new ResultPacker(Store, Visibility) { Priority = ThreadPriority.Normal };
            Store.Settled = () => Interlocked.Increment(ref Pokes);
        }

        public void Show(params uint[] ids) => Visibility.Set(source, ++seq, ids, out _);
    }

    public static void Run(Action<bool, string> check)
    {
        WhenAndWhat(check);
        Held(check);
        StopsWhenShown(check);
        ReleaseWhilePacking(check);
        Figures(check);
        PacksAgain(check);
        UsedWhileDue(check);
        Priorities(check);
        Concurrent(check);
        Service(check);
        Thread(check);
    }

    private static void WhenAndWhat(Action<bool, string> check)
    {
        var rig = new Rig();
        var hidden = Filled(rig.Store, "hidden", BigRows);
        var shown = Filled(rig.Store, "shown", BigRows);
        var small = Filled(rig.Store, "small", 2_000);
        var streaming = Open(rig.Store, "streaming");
        Write(streaming, 0, BigRows);
        streaming.Seal();
        var table = rig.Store.Open(new QueryBudget("live", new LiveBudget(64L << 20)), 0, 1, 1, "rows", W1Columns, W1Wires)!;
        Write(table, 0, BigRows / 4);
        table.Complete();
        rig.Show(shown.ResultId);
        var used = rig.Store.UsedBytes;
        var expected = Bodies(hidden);
        check(small.BytesStored < ResultPacker.FloorBytes && hidden.BytesStored >= ResultPacker.FloorBytes && streaming.BytesStored >= ResultPacker.FloorBytes && table.BytesStored >= ResultPacker.FloorBytes,
            "the policy's fixtures: a small result under the floor, the others over it");

        rig.Clock = 1_000;
        var next = rig.Packer.PackDue();
        check(next == 1_000 + ResultPacker.DelayMs && !hidden.HasPacked && rig.Store.UsedBytes == used,
            "a hidden result is not packed before its delay, and the policy knows when it falls due: " + next);
        rig.Clock += ResultPacker.DelayMs - 1;
        check(rig.Packer.PackDue() == 1_000 + ResultPacker.DelayMs && !hidden.HasPacked, "a millisecond before its delay a hidden result is still raw");
        rig.Clock += 1;
        next = rig.Packer.PackDue();
        var saved = used - rig.Store.UsedBytes;
        check(next is null && AllPacked(hidden) && !hidden.NeedsPacking && saved > hidden.BytesStored / 2,
            "a complete result of 1 MiB or more hidden for 5 s is packed whole, and its saving goes back to the budget at once: " + saved + " of " + hidden.BytesStored);
        check(Same(expected, Bodies(hidden)), "a packed result reads as it was sealed, with no wait to unpack it whole");
        check(!shown.HasPacked && !small.HasPacked && !streaming.HasPacked && !table.HasPacked && small.NeedsPacking && !table.NeedsPacking,
            "a shown result, one under 1 MiB, one still storing rows and a live table are never packed");

        // Hidden from the moment it leaves the visible set, not from when it was stored.
        rig.Clock += 60_000;
        rig.Show();
        check(rig.Packer.PackDue() == rig.Clock + ResultPacker.DelayMs && !shown.HasPacked, "a result hidden after being shown waits its delay from the moment it was hidden");
        rig.Clock += ResultPacker.DelayMs;
        rig.Packer.PackDue();
        check(AllPacked(shown), "and is packed once the delay has passed");

        // Flicking away and back within the delay packs nothing.
        var flicked = Filled(rig.Store, "flicked", BigRows);
        rig.Show(flicked.ResultId);
        rig.Clock += 1_000;
        rig.Show();
        rig.Clock += ResultPacker.DelayMs / 2;
        rig.Show(flicked.ResultId);
        rig.Clock += ResultPacker.DelayMs;
        check(rig.Packer.PackDue() is null && !flicked.HasPacked, "a result shown again before its delay passed is not packed");

        // A result that completes after it was hidden is packed once complete.
        streaming.Complete();
        check(streaming.NeedsPacking && rig.Packer.PackDue() is null && AllPacked(streaming), "a result hidden while it stored rows is packed once it completes and its delay has passed");
        check(rig.Pokes >= 1, "a completing result wakes the policy");
    }

    private static void Held(Action<bool, string> check)
    {
        var rig = new Rig();
        var set = Filled(rig.Store, "held", BigRows);
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs;
        var pin = set.Pin();
        var pokes = rig.Pokes;
        check(rig.Packer.PackDue() is null && !set.HasPacked && set.NeedsPacking, "a pinned result is not packed, and the policy does not wait on a clock for it");
        pin.Dispose();
        check(rig.Pokes == pokes + 1, "the pin's end wakes the policy");
        rig.Packer.PackDue();
        check(AllPacked(set), "and the result is packed then");

        var leased = Filled(rig.Store, "leased", BigRows);
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs;
        check(leased.TryLease(), "a complete result can be leased");
        rig.Packer.PackDue();
        var whileLeased = leased.HasPacked;
        pokes = rig.Pokes;
        leased.ReleaseLease();
        rig.Packer.PackDue();
        check(!whileLeased && rig.Pokes == pokes + 1 && AllPacked(leased), "a leased result (Copy, Save) is packed only after its lease ends, which wakes the policy");

        // Reading a visible result never wakes the policy: only a pin that stopped packing does.
        var visible = Filled(rig.Store, "visible", BigRows);
        rig.Show(visible.ResultId);
        rig.Packer.PackDue();
        pokes = rig.Pokes;
        for (var i = 0; i < 10; i++) using (visible.Pin()) visible.SealedSnapshot()[0].Body();
        check(rig.Pokes == pokes, "reads of a result the policy never tried to pack do not wake it");
    }

    private static void StopsWhenShown(Action<bool, string> check)
    {
        var rig = new Rig();
        var set = Filled(rig.Store, "shown", BigRows);
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs;
        // The scan looks the result up once (one lookup per IsHidden), then the pass before each page: two pages are packed
        // and the result is shown before the third.
        var lookups = 0;
        rig.OnLookup = id =>
        {
            if (id == set.ResultId && ++lookups == 4) rig.Show(set.ResultId);
            return true;
        };
        rig.Packer.PackDue();
        rig.OnLookup = null;
        var packed = set.SealedSnapshot().Count(page => page.StoredLength < page.Length);
        check(packed == 2 && set.NeedsPacking && set.HasPacked, "a result shown again while packed stops at its next page and keeps what was packed: " + packed);
        check(Same(Bodies(set), Bodies(set)) && set.SealedSnapshot().Length > packed, "a partly packed result reads through the accessor");
        rig.Show();
        rig.Clock += ResultPacker.DelayMs;
        rig.Packer.PackDue();
        check(AllPacked(set) && !set.NeedsPacking, "hidden again for its delay, the rest is packed");
    }

    private static void ReleaseWhilePacking(Action<bool, string> check)
    {
        var rig = new Rig();
        var other = Filled(rig.Store, "other", 2_000);
        var set = Filled(rig.Store, "released", BigRows);
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs;
        var lookups = 0;
        rig.OnLookup = id =>
        {
            // Released between two pages, from inside the pass, as a results.close on another thread would be.
            if (id == set.ResultId && ++lookups == 4) rig.Store.Release(set.ResultId);
            return true;
        };
        rig.Packer.PackDue();
        rig.OnLookup = null;
        var counters = rig.Store.PackingSnapshot();
        check(set.IsReleased && rig.Store.UsedBytes == other.Budget.UsedBytes && counters is { PackedBytes: 0, PackedLogicalBytes: 0, CacheBytes: 0 },
            "a result released while it is packed stops packing and returns every byte, packed or raw, exactly once");

        // A release from another thread while the pass runs: whatever page it lands on, the budget ends where it began.
        var racer = Filled(rig.Store, "racer", BigRows);
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs;
        var packing = Task.Run(rig.Packer.PackDue);
        var waited = Stopwatch.StartNew();
        while (rig.Store.PackingSnapshot().PackedBytes == 0 && !packing.IsCompleted && waited.ElapsedMilliseconds < 30_000) System.Threading.Thread.Yield();
        rig.Store.Release(racer.ResultId);
        packing.Wait();
        check(rig.Store.UsedBytes == other.Budget.UsedBytes && rig.Store.PackingSnapshot() is { PackedBytes: 0, PackedLogicalBytes: 0 },
            "a release on another thread during packing leaves the budget as it was before the result was stored");
    }

    private static void Figures(Action<bool, string> check)
    {
        var rig = new Rig();
        var set = Filled(rig.Store, "figures", BigRows);
        var raw = rig.Store.MemoryDetail();
        var codecOff = new ResultStore(1L << 30, 1L << 30).MemoryDetail().Codec;
        check(raw.LogicalBytes == set.BytesStored && raw.StoredBytes == raw.LogicalBytes && raw.CompressedBytes == 0 && raw.PackedLogicalBytes == 0
            && raw.Largest is [{ State: "raw" } entry] && entry.StoredBytes == entry.LogicalBytes && raw.Codec is { Name: ResultStore.CodecName, Level: PageCodec.Quality, PagesPacked: 0 }
            && codecOff.Name is null && codecOff.Level is null,
            "before packing the Memory panel shows every byte raw, and names the codec only while packing is on");
        var used = rig.Store.UsedBytes;
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs;
        rig.Packer.PackDue();
        var packed = rig.Store.MemoryDetail();
        var compressed = set.SealedSnapshot().Sum(page => (long)page.StoredLength);
        check(packed.LogicalBytes == raw.LogicalBytes && packed.CompressedBytes == compressed && packed.PackedLogicalBytes == raw.LogicalBytes && packed.StoredBytes == compressed
            && packed.Largest is [{ State: "packed", Progress: null } after] && after.StoredBytes == compressed && after.LogicalBytes == raw.LogicalBytes
            && used - rig.Store.UsedBytes == raw.StoredBytes - packed.StoredBytes,
            "packed, the panel shows the rows as read, the packed bytes that hold them, and the same saving the budget got back: " + packed.StoredBytes + " of " + packed.LogicalBytes);
        check(packed.Codec is { PagesPacked: > 0, PackInputBytes: > 0, PackMicroseconds: > 0 } && packed.Codec.PackInputBytes == raw.LogicalBytes,
            "the panel's codec counters count what was packed and how long it took");
        using (set.Pin()) set.SealedSnapshot()[0].Body();
        using (set.Pin()) set.SealedSnapshot()[0].Body();
        var read = rig.Store.MemoryDetail();
        check(read.CacheBytes == set.SealedSnapshot()[0].Length && read.Codec.CacheLookups == 2 && read.Codec.CacheHits == 1 && read.Codec.PagesUnpacked == 1 && read.Codec.UnpackMicroseconds > 0,
            "reads of a packed result show the cache's bytes, its lookups and hits, and the pages unpacked");
        using (set.Pin()) set.TryUnpackAll();
        var unpacked = rig.Store.MemoryDetail();
        check(unpacked.Largest is [{ State: "raw" }] && unpacked.CompressedBytes == 0 && unpacked.StoredBytes == unpacked.LogicalBytes && unpacked.CacheBytes == 0
            && unpacked.Codec.LastUnpackMicroseconds > 0 && set.Memory().Unpacking is null,
            "once an operation unpacked the result whole, the panel shows it raw and how long the unpack took");
    }

    private static void PacksAgain(Action<bool, string> check)
    {
        var rig = new Rig();
        using var service = new SqlService(rig.Store);
        var set = Filled(rig.Store, "again", BigRows);
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs;
        rig.Packer.PackDue();
        var packedUse = rig.Store.UsedBytes;
        var pokes = rig.Pokes;
        // A search needs every row at once, so it unpacks a packed result first (a sort, filter, profile or pivot reads it
        // fused and leaves it packed: FusedReadChecks).
        var search = (ResultsSearchResult)service.DispatchAsync("results.search", JsonSerializer.SerializeToElement(new { resultId = set.ResultId, text = "no such text", fromRow = 0, maxMatches = 10 }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        check(search.Rows == set.RowsAvailable && !set.HasPacked && set.NeedsPacking && rig.Pokes > pokes && rig.Store.UsedBytes > packedUse,
            "a search of a packed hidden result unpacks it first, charging its raw size, and its end wakes the policy");
        // The operation counts as a use: packed again only once the result has gone unused for the delay, so a search or
        // comparison that reads a hidden result run after run does not unpack and pack it each time.
        var again = rig.Packer.PackDue();
        check(again == rig.Clock + ResultPacker.DelayMs && !set.HasPacked, "after an operation unpacked it, a hidden result waits its delay again: " + again);
        rig.Clock += ResultPacker.DelayMs;
        rig.Packer.PackDue();
        check(AllPacked(set), "still hidden and unused for its delay, the result is packed again");

        // A long operation: another wake-up scans while it still holds the result, past the delay. The delay runs from
        // when the operation ends, so the scan after its end does not pack straight away.
        var held = set.Pin();
        check(set.TryUnpackAll() && !set.HasPacked, "an operation unpacks the result and still holds it");
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs * 2;
        rig.Packer.PackDue();
        held.Dispose();
        var after = rig.Packer.PackDue();
        check(after == rig.Clock + ResultPacker.DelayMs && !set.HasPacked, "a result held by an operation longer than the delay waits the delay from the operation's end: " + after);
        rig.Clock += ResultPacker.DelayMs;
        rig.Packer.PackDue();
        check(AllPacked(set), "and is packed once unused for the delay after it");

        // A plain lease (Copy, Save) on a result an operation once unpacked is not a use: once it ends the result is packed
        // at once, as one never unpacked would be.
        using (var sort = set.Pin()) set.TryUnpackAll();
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs;
        check(set.TryLease(), "the unpacked result can be leased");
        var leased = rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs * 2;
        var stillLeased = rig.Packer.PackDue();
        set.ReleaseLease();
        rig.Packer.PackDue();
        check(leased is null && stillLeased is null && AllPacked(set), "a lease after an operation's use is not a use: no clock wait while it lasts, packed as soon as it ends");

        // Refused: the budget filled while the result was packed. The sort answers TOO_LARGE and nothing changes.
        var filler = rig.Store.BeginQuery("filler");
        rig.Store.TryReserve(filler, rig.Store.GlobalBytes - rig.Store.UsedBytes - 1024, false, out _);
        var used = rig.Store.UsedBytes;
        string? code = null;
        try { service.DispatchAsync("results.search", JsonSerializer.SerializeToElement(new { resultId = set.ResultId, text = "still no such text", fromRow = 0, maxMatches = 10 }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult(); }
        catch (RequestException error) { code = error.Code; }
        check(code == "TOO_LARGE" && AllPacked(set) && rig.Store.UsedBytes == used, "a search refused the budget to unpack a packed result answers TOO_LARGE and leaves it packed");
    }

    private static void UsedWhileDue(Action<bool, string> check)
    {
        // Two results fall due together; while the larger is packed (seconds, for a large one), an operation unpacks the
        // smaller. That is a use: the pass must not pack it straight after, but wait the delay from the use.
        var rig = new Rig();
        var small = Filled(rig.Store, "small", BigRows);
        var large = Filled(rig.Store, "large", BigRows * 2);
        rig.Show(large.ResultId);
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs;
        // Pack one page of the smaller, so an operation has something to unpack and the result still needs packing.
        var lookups = 0;
        rig.OnLookup = id =>
        {
            if (id == small.ResultId && ++lookups == 3) rig.Show(large.ResultId, small.ResultId);
            return true;
        };
        rig.Packer.PackDue();
        rig.OnLookup = null;
        check(small.HasPacked && small.NeedsPacking && !large.HasPacked, "the fixture: the smaller result is partly packed and the larger raw");
        rig.Show();
        rig.Clock += ResultPacker.DelayMs;
        lookups = 0;
        var unpacked = false;
        rig.OnLookup = id =>
        {
            if (id == large.ResultId && ++lookups == 3)
                using (small.Pin()) unpacked = small.TryUnpackAll();
            return true;
        };
        var next = rig.Packer.PackDue();
        rig.OnLookup = null;
        check(unpacked && AllPacked(large) && !small.HasPacked && small.NeedsPacking,
            "a result an operation unpacked while the pass packed another is not packed by that pass");
        next = rig.Packer.PackDue();
        check(next == rig.Clock + ResultPacker.DelayMs && !small.HasPacked, "the next scan waits the delay from that use: " + next);
        rig.Clock += ResultPacker.DelayMs;
        rig.Packer.PackDue();
        check(AllPacked(small), "and packs it once it has gone unused for the delay");
    }

    private static void Priorities(Action<bool, string> check)
    {
        // The priority applies to compressing a page only; every lock the pass takes (here, the visibility lookup inside
        // the table's lock) is taken at normal priority, and the thread is back at normal priority afterwards. A raised
        // priority shows the switch without starving the check on a busy machine. Off Windows .NET accepts the request
        // without changing the scheduling, so there this checks the bookkeeping, not the scheduler.
        var rig = new Rig();
        var set = Filled(rig.Store, "priorities", BigRows);
        var page = Bodies(set)[1];
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs;
        var packer = new ResultPacker(rig.Store, rig.Visibility) { Priority = ThreadPriority.AboveNormal };
        var seen = new List<ThreadPriority>();
        rig.OnLookup = id =>
        {
            if (id == set.ResultId) seen.Add(System.Threading.Thread.CurrentThread.Priority);
            return true;
        };
        var priority = ThreadPriority.Lowest;
        var worker = new System.Threading.Thread(() =>
        {
            packer.PackDue();
            priority = System.Threading.Thread.CurrentThread.Priority;
        });
        worker.Start();
        worker.Join();
        rig.OnLookup = null;
        var pages = set.SealedSnapshot().Length;
        check(AllPacked(set) && seen.Count == pages + 1 && seen.All(value => value == ThreadPriority.Normal) && priority == ThreadPriority.Normal,
            "the policy takes its locks at normal priority and ends a pass at normal priority: " + string.Join(",", seen.Distinct()));
        check(packer.PagesAtPriority == pages || !packer.CanLower, "and compresses each page at its own priority where the platform allows it: " + packer.PagesAtPriority + " of " + pages);

        // While lowered nothing is allocated: the thread's encoder is made and warmed before the window opens, and the room
        // is rented and the result copied outside it. (Managed allocations are counted here; the encoder's native context
        // is reused for the same reason.)
        var allocated = new List<long>();
        long opened = 0;
        void Window(bool compressing)
        {
            if (compressing) opened = GC.GetAllocatedBytesForCurrentThread();
            else allocated.Add(GC.GetAllocatedBytesForCurrentThread() - opened);
        }
        var first = PageCodec.Pack(page, Window);
        var second = PageCodec.Pack(page, Window);
        check(first is not null && second is not null && first.AsSpan().SequenceEqual(second) && PageCodec.Unpack(second, page.Length).AsSpan().SequenceEqual(page) && allocated is [0, 0],
            "a page compressed for the policy reads back as sealed, and nothing is allocated while its thread is lowered: " + string.Join(",", allocated));
        // Pages of every size use the same encoder, streamed: a small page, one of exactly the window, and one larger than
        // the window each read back as sealed, and each frame is one the one-shot reader takes.
        byte[][] sizes = [page[..10_000], page.Length >= 1 << PageCodec.Window ? page[..(1 << PageCodec.Window)] : page, [.. page, .. page]];
        var allRead = sizes.All(sample => PageCodec.Pack(sample, Window) is { } packedSample && PageCodec.Unpack(packedSample, sample.Length).AsSpan().SequenceEqual(sample));
        check(allRead && allocated.All(bytes => bytes == 0), "pages smaller than, equal to and larger than the window pack and read back, allocating nothing while lowered: " + string.Join(",", allocated));
    }

    private static void Concurrent(Action<bool, string> check)
    {
        var rig = new Rig();
        var set = Filled(rig.Store, "concurrent", BigRows * 2);
        var expected = Bodies(set);
        rig.Packer.PackDue();
        rig.Clock += ResultPacker.DelayMs;
        // Reads pin the result, which stops packing at its next page; the policy finishes after the reads.
        var matched = true;
        var reads = 0;
        void ReadOne()
        {
            using (set.Pin())
            {
                var pages = set.SealedSnapshot();
                var at = reads * 7 % pages.Length;
                matched &= pages[at].Body().AsSpan().SequenceEqual(expected[at]);
            }
            reads++;
        }
        ReadOne();
        using var done = new CancellationTokenSource();
        var packing = Task.Run(() =>
        {
            while (!done.IsCancellationRequested && set.NeedsPacking) rig.Packer.PackDue();
        });
        var newQuery = Task.Run(() => Filled(rig.Store, "new", BigRows));
        // Bounded by reads, not time: a pin stops packing at its next page, so the reads may hold it off until they end.
        while (!packing.IsCompleted && reads < 5_000) ReadOne();
        done.Cancel();
        packing.Wait();
        var stored = newQuery.Result;
        // Bounded: a result the policy could never finish fails the check rather than hanging the suite.
        for (var pass = 0; set.NeedsPacking && pass < 100; pass++) rig.Packer.PackDue();
        long Charges(ResultSetBuffer item) => 512 + item.Columns.Sum(column => 2L * column.Name.Length + 64)
            + item.SealedSnapshot().Sum(page => page.StoredLength + ResultStore.PageOverhead + page.Lengths.MemoryBytes);
        check(matched && reads > 0 && AllPacked(set) && Same(expected, Bodies(set)),
            "reads during packing see every page as sealed, and the policy finishes packing between them: " + reads + " reads");
        check(stored.IsComplete && rig.Store.UsedBytes - rig.Store.PackingSnapshot().CacheBytes == Charges(set) + Charges(stored),
            "a new query stores its rows while another result is packed, and the budget holds exactly what both keep");
    }

    private static void Service(Action<bool, string> check)
    {
        using (var plain = new SqlService(new ResultStore(1L << 30, 1L << 30)))
            check(plain.Packer is null && plain.Results.Packing == PagePacking.Off, "a service not asked to pack hidden results runs no policy");
        using var service = new SqlService(new ResultStore(1L << 30, 1L << 30), packHidden: true);
        check(service.Packer is not null && service.Results.Packing == PagePacking.OnRequest, "the backend process's service turns packing on request and runs the policy");
        var packer = service.Packer!;
        // This check runs passes on its own thread (below); at the product's lowest priority they could starve.
        packer.Priority = ThreadPriority.Normal;
        // The service's thread runs on the real clock: a long delay keeps it from packing the result before it is shown,
        // however long this check is held up between storing and showing it.
        packer.Delay = 1L << 40;
        var store = service.Results;
        var set = Filled(store, "service", BigRows);
        var source = Guid.NewGuid().ToString();
        object Visible(long seq, params uint[] ids) => service.DispatchAsync("results.visibility", JsonSerializer.SerializeToElement(new { source, seq, visible = ids }, HostChecks.Json), HostChecks.Json).GetAwaiter().GetResult();
        Visible(1, set.ResultId);
        // With no delay at all a shown result is still not due: a pass, run here, skips it whatever the time.
        packer.Delay = 0;
        packer.PackDue();
        check(!set.HasPacked, "a result shown through results.visibility is not packed, even with no delay");
        // Hidden through results.visibility, the result is due at once with no delay. The pass runs here rather than waiting on the
        // service's lowest-priority thread, which a starved machine may not run for many seconds (Thread below checks the thread).
        var pokes = packer.Pokes;
        Visible(2);
        check(packer.Pokes == pokes + 1, "an applied results.visibility wakes the policy, which may have nothing else to wait for");
        Visible(2);
        check(packer.Pokes == pokes + 1, "a repeated results.visibility, not applied, does not");
        packer.PackDue();
        check(AllPacked(set) && store.Settled is not null, "hidden through results.visibility, the service's policy packs the result, and the store wakes it");
    }

    private static void Thread(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 30) { Packing = PagePacking.OnRequest };
        var clock = 0L;
        var visibility = new ResultVisibility(id => store.Find(id) is not null, () => Interlocked.Read(ref clock));
        var packer = new ResultPacker(store, visibility, delayMs: 200) { Priority = ThreadPriority.Normal };
        packer.Start();
        var first = Filled(store, "first", BigRows);
        var waited = Stopwatch.StartNew();
        // Waits until a pass has looked the result up (its hidden time is recorded), not merely begun: a pass counts at its start.
        while (visibility.TrackedCount < 1 && waited.ElapsedMilliseconds < 30_000) System.Threading.Thread.Sleep(5);
        check(visibility.TrackedCount == 1 && visibility.IsHidden(first.ResultId, out var since) && since == 0 && !first.HasPacked, "the policy's thread wakes, records when the result was hidden, and packs nothing before its delay");
        // The clock passes the delay with no event: the thread's own deadline, not a poke, packs the result.
        Interlocked.Exchange(ref clock, 200);
        waited.Restart();
        while (!AllPacked(first) && waited.ElapsedMilliseconds < 30_000) System.Threading.Thread.Sleep(10);
        var hiddenNow = visibility.IsHidden(first.ResultId, out var hiddenAt);
        check(AllPacked(first), "the policy's thread packs a hidden result at its deadline: " + packer.Passes + " passes, " + first.SealedSnapshot().Count(page => page.StoredLength < page.Length)
            + " of " + first.SealedSnapshot().Length + " pages packed, needs packing " + first.NeedsPacking + ", hidden " + hiddenNow + " since " + hiddenAt + ", pins " + first.Pins + ", leases " + first.Leases + ", " + store.PackingSnapshot());
        waited.Restart();
        packer.Dispose();
        var stopped = waited.ElapsedMilliseconds;
        var passes = packer.Passes;
        packer.Poke();
        check(store.Settled is null && !packer.Running && packer.Passes == passes && stopped < 5_000, "disposing the policy ends its thread and unhooks it from the store, and a later poke runs no pass: " + stopped + " ms");
    }
}
