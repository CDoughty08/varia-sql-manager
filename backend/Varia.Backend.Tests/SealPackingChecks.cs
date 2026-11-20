using System.Text.Json;
using Varia.Backend.Results;
using static Varia.Backend.Tests.PackerChecks;

namespace Varia.Backend.Tests;

/// <summary>Packing at seal (ResultStore.PackAtSeal, docs/page-compression-findings.md): a query's pages packed on a thread-pool worker as
/// they seal once its set holds a mebibyte, so a result larger than its query's half raw stores every row; a small result
/// never packed; a pin or lease keeping pages raw until it ends; live tables and derived sets left to the policy; a release
/// or an operation's whole unpack dropping what is queued; and the backend process turning it on. No policy runs here
/// unless a check starts one: the seal worker alone makes room.</summary>
internal static class SealPackingChecks
{
    private const int Wait = 30_000;

    public static void Run(Action<bool, string> check)
    {
        Overflow(check);
        Floor(check);
        Held(check);
        LeftAlone(check);
        Dropped(check);
        Service(check);
    }

    private static ResultStore Store(long global, long query, bool atSeal = true) =>
        new(global, query) { Packing = PagePacking.OnRequest, PackAtSeal = atSeal };

    /// <summary>Stores rows as the query's ingestion does (SqlService), waiting for room when a row is refused
    /// (<see cref="SqlService.WaitAndCommitAsync"/>), and completes the set; returns how many rows waited.</summary>
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

    private static bool Settled(ResultSetBuffer set) => SpinWait.SpinUntil(() => set.Budget.SealPending == 0, Wait);

    private static void Overflow(Action<bool, string> check)
    {
        // About 22 MiB of W1 rows against a 12 MiB query half: raw, the query stops at its half.
        var rows = BigRows * 5 / 2;
        var raw = Store(64L << 20, 12L << 20, atSeal: false);
        var stopped = Open(raw, "raw");
        Ingest(raw, stopped, rows);
        check(stopped.Truncated == TruncationReason.QueryBudget && stopped.RowsAvailable < rows && !stopped.HasPacked,
            "the fixture: without packing at seal a result over its query's half stops there: " + stopped.RowsAvailable + " of " + rows + " rows");

        var store = Store(64L << 20, 12L << 20);
        var set = Open(store, "sealed");
        var waits = Ingest(store, set, rows);
        check(set.Truncated == TruncationReason.None && set.RowsAvailable == rows && set.Budget.Stopped == TruncationReason.None,
            "packed as it seals, the same result stores every row: " + set.RowsAvailable + " of " + rows + " rows, " + waits + " waits, " + set.Truncated);
        check(Settled(set) && AllPacked(set) && set.Budget.UsedBytes <= store.QueryBytes && store.UsedBytes == set.Budget.UsedBytes,
            "every page is packed and the query's half held: " + set.Budget.UsedBytes + " of " + store.QueryBytes);
        var copy = Store(1L << 30, 1L << 30, atSeal: false);
        var expected = Bodies(Filled(copy, "copy", rows));
        check(Same(expected, Bodies(set)), "every packed page reads back as it was sealed");
        store.Release(set.ResultId);
        check(store.UsedBytes == 0 && set.Budget.UsedBytes == 0, "releasing it returns every byte: " + store.UsedBytes);
    }

    private static void Floor(Action<bool, string> check)
    {
        // Three or four pages of W1, under a mebibyte, written behind a pin so a worker could not have packed them yet.
        var store = Store(1L << 30, 1L << 30);
        var small = Open(store, "small");
        using (small.Pin()) Write(small, 0, BigRows / 12);
        var queued = small.Budget.SealPending;
        small.Complete();
        check(small.BytesStored < ResultPacker.FloorBytes && small.SealedPages > 1 && queued == 0 && small.Budget.SealPending == 0 && !small.HasPacked,
            "a result under a mebibyte is never packed at seal: " + small.BytesStored + " bytes in " + small.SealedPages + " pages, " + queued + " queued");

        // Crossing a mebibyte queues the pages sealed before it as well, while the set is still open.
        var open = Open(store, "open");
        var pages = 0;
        long row = 0;
        while (open.BytesStored < ResultPacker.FloorBytes)
        {
            Write(open, row, 100);
            row += 100;
            pages = open.SealedPages;
        }
        check(open.IsOpen && Settled(open) && AllPacked(open) && pages > 1,
            "once a still-open result holds a mebibyte, its pages so far are packed, the first ones too: " + pages + " pages");
        open.Complete();
    }

    private static void Held(Action<bool, string> check)
    {
        // A read holds the set while rows go on: the worker leaves its pages raw, and packs them once the read ends.
        var store = Store(1L << 30, 1L << 30);
        var set = Open(store, "held");
        var pin = set.Pin();
        Write(set, 0, BigRows);
        check(set.Budget.SealPending > 0 && !set.HasPacked, "while a pin is held nothing is packed and the pages stay queued: " + set.Budget.SealPending);
        pin.Dispose();
        check(Settled(set) && AllPacked(set), "the pin's end starts the worker, which packs them all");

        // A read that begins while the worker compresses a page: the page is not replaced under it.
        var raced = Open(store, "raced");
        PagePin? late = null;
        store.SealCompressed = target => { if (ReferenceEquals(target, raced)) late ??= raced.Pin(); };
        Write(raced, 0, BigRows / 4);
        check(SpinWait.SpinUntil(() => late is not null, Wait) && SpinWait.SpinUntil(() => !raced.HasPacked && raced.Budget.SealPending > 0 && raced.Pins == 1, Wait) && !raced.HasPacked,
            "a pin taken while a page compresses keeps it raw and queued: " + raced.Budget.SealPending);
        store.SealCompressed = null;
        late!.Dispose();
        check(Settled(raced) && AllPacked(raced), "and the pin's end packs it");

        // A Copy leases a result still loading past its half: its queued pages cannot pack until the Copy ends, so a
        // refused row is refused at once rather than waiting for room nothing can make.
        var small = Store(64L << 20, 12L << 20);
        var copied = Open(small, "copied");
        check(copied.TryLease(), "the fixture: a Copy leases the loading result");
        var waited = new SqlService.RoomWaited();
        var waits = Ingest(small, copied, BigRows * 5 / 2, waited);
        check(copied.Truncated == TruncationReason.QueryBudget && copied.Budget.SealPending > 0 && waits == 1 && waited.Ms < ResultStore.RoomWaitMs / 2,
            "with every queued page held a refused row stops the query at once: " + waits + " waits, " + waited.Ms + " ms, " + copied.Budget.SealPending + " queued");
        copied.ReleaseLease();
        check(Settled(copied) && AllPacked(copied), "and the lease's end packs what was stored");

        // A read's pin at the refusal ends with the read: the row waits through it, and the query stores every row.
        var read = Store(64L << 20, 12L << 20);
        var scrolled = Open(read, "scrolled");
        var held = scrolled.Pin();
        var ends = Task.Run(() =>
        {
            SpinWait.SpinUntil(() => scrolled.RoomWanted > 0, Wait);
            held.Dispose();
        });
        var scrolledWaits = Ingest(read, scrolled, BigRows * 5 / 2);
        ends.Wait();
        check(scrolled.Truncated == TruncationReason.None && scrolled.RowsAvailable == BigRows * 5 / 2 && scrolledWaits > 0,
            "a row refused while a read pins the loading result waits for the pin's end and the query stores every row: " + scrolledWaits + " waits, " + scrolled.RowsAvailable + " rows");

        // The same for a lease (a Copy or Save).
        var leased = Open(store, "leased");
        check(leased.TryLease(), "the fixture: a lease");
        Write(leased, 0, BigRows);
        check(leased.Budget.SealPending > 0 && !leased.HasPacked, "while a lease is held nothing is packed");
        leased.ReleaseLease();
        check(Settled(leased) && AllPacked(leased), "the lease's end starts the worker");
    }

    /// <summary>Writes a result behind a pin, so no worker can have packed or dropped anything yet, and returns the pages
    /// it queued then and whether any was packed once the pin ended and the worker had its chance.</summary>
    private static (int Queued, bool Packed) Behind(ResultSetBuffer set)
    {
        int queued;
        using (set.Pin())
        {
            Write(set, 0, BigRows);
            set.Complete();
            queued = set.Budget.SealPending;
        }
        return (queued, Settled(set) && set.HasPacked);
    }

    private static void LeftAlone(Action<bool, string> check)
    {
        var store = Store(1L << 30, 1L << 30);
        var table = store.Open(new QueryBudget("live", new LiveBudget(64L << 20)), 0, 1, 1, "rows", W1Columns, W1Wires)!;
        check(Behind(table) == (0, false), "a live table is never packed at seal");

        var derived = store.Open(store.BeginQuery("derived"), 0, 1, 1, "rows", W1Columns, W1Wires, derived: true)!;
        check(Behind(derived) == (0, false), "nor a derived set an operation builds (the policy packs it once complete)");

        var off = Store(1L << 30, 1L << 30, atSeal: false);
        check(Behind(Open(off, "plain")) == (0, false), "nor anything when the store does not pack at seal");

        var never = new ResultStore(1L << 30, 1L << 30) { Packing = PagePacking.Off, PackAtSeal = true };
        check(Behind(Open(never, "never")) == (0, false), "nor anything when packing is off");

        var query = Behind(Open(store, "query"));
        check(query.Queued > 0 && query.Packed, "the fixture: a query's own set in the same store is: " + query.Queued + " queued");
    }

    private static void Dropped(Action<bool, string> check)
    {
        // Released while its pages wait behind a pin: the queue goes, and every byte with the last pin.
        var store = Store(1L << 30, 1L << 30);
        var released = Open(store, "released");
        var pin = released.Pin();
        Write(released, 0, BigRows);
        check(released.Budget.SealPending > 0, "the fixture: pages queued behind a pin");
        store.Release(released.ResultId);
        check(released.Budget.SealPending == 0, "a release drops the pages queued");
        pin.Dispose();
        check(store.UsedBytes == 0 && !released.HasPacked, "and the last pin frees every byte, nothing packed: " + store.UsedBytes);

        // Some pages packed, more queued behind a pin, then an operation unpacks the complete result whole: a use, so the
        // queued pages stay raw, left to the policy.
        var used = Open(store, "used");
        Write(used, 0, BigRows);
        check(Settled(used) && used.HasPacked, "the fixture: the first pages packed");
        var hold = used.Pin();
        Write(used, BigRows, BigRows);
        used.Complete();
        check(used.Budget.SealPending > 0 && used.TryUnpackAll() && used.Unpacks == 1 && !used.HasPacked, "the fixture: more queued, and an operation unpacks the result whole");
        hold.Dispose();
        check(Settled(used) && !used.HasPacked, "the queued pages of a result an operation unpacked whole are dropped, not packed");

        // A defect while packing (here the checks' hook throws) drops the queue, leaves the pages raw and readable, and the
        // next result packs as before.
        var failing = Open(store, "failing");
        store.SealCompressed = target => { if (ReferenceEquals(target, failing)) throw new InvalidOperationException("The checks' failure."); };
        Write(failing, 0, BigRows / 4);
        failing.Complete();
        check(Settled(failing) && !failing.HasPacked && Bodies(failing).Length == failing.SealedPages, "a failure while packing at seal drops the queue and leaves every page raw and readable");
        store.SealCompressed = null;
        var after = Open(store, "after");
        Write(after, 0, BigRows / 4);
        check(Settled(after) && AllPacked(after), "and the next result packs as before");
    }

    private static void Service(Action<bool, string> check)
    {
        var service = new SqlService(new ResultStore(1L << 30, 1L << 30), packHidden: true);
        check(service.Results.PackAtSeal, "the backend process packs pages as they seal");
        service.Dispose();
        var plain = new SqlService(new ResultStore(1L << 30, 1L << 30));
        check(!plain.Results.PackAtSeal, "and only the backend process: a service without the policy does not");
        plain.Dispose();

        // The synthesize test hook keeps its result raw unless asked to pack: the checks and benchmarks that compare a raw
        // result with a packed one, or count its raw bytes against a budget, get the result they asked for.
        var json = HostChecks.Json;
        using var hooked = new SqlService(new ResultStore(1L << 30, 1L << 30), hooks: true, packHidden: true);
        var descriptor = (ResultDescriptor)hooked.DispatchAsync(SqlService.SynthesizeMethod, JsonSerializer.SerializeToElement(new { shape = "W1", rows = 200_000 }, json), json).GetAwaiter().GetResult();
        var synthesized = hooked.Results.Find(descriptor.ResultId)!;
        check(descriptor.BytesStored > 4 * ResultPacker.FloorBytes && synthesized.Budget.SealPending == 0 && !synthesized.HasPacked,
            "a synthesized result is never packed at seal: " + descriptor.BytesStored + " bytes, " + synthesized.Budget.SealPending + " queued");
    }
}
