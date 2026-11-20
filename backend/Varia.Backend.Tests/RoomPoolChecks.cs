using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>The store's room pool (RoomPool): view reads and operations over a packed result rent their rooms from it and
/// give them back, so reading again makes none; the pool keeps rooms only up to its cap, never one twice, and lets them go
/// when idle; a room goes back only once nothing reads it. The suite sets each store's packing itself, so it is not in the
/// packed pass.</summary>
internal static class RoomPoolChecks
{
    private static readonly IReadOnlyList<ResultColumn> W1Columns = [.. SyntheticRows.Columns("W1").Select(column => new ResultColumn(column.Name, column.DataType, column.Wire == WireKind.Text ? "text" : "binary"))];
    private static readonly IReadOnlyList<WireKind> W1Wires = [.. SyntheticRows.Columns("W1").Select(column => column.Wire)];

    public static void Run(Action<bool, string> check)
    {
        Pool(check);
        ViewReads(check);
        HeldAcrossPages(check);
        Operations(check);
        Refused(check);
    }

    private static ResultSetBuffer Filled(ResultStore store, int rows)
    {
        var set = store.Open(store.BeginQuery("rooms"), 0, 1, 1, "rows", W1Columns, W1Wires) ?? throw new InvalidOperationException("The result set was not kept.");
        for (var row = 0L; row < rows; row++)
        {
            set.CountRow();
            if (set.BeginRow() is not { } builder) continue;
            SyntheticRows.WriteCells("W1", row, builder);
            set.TryCommitRow();
        }
        set.Complete();
        return set;
    }

    private static int[] Scattered(int rows) => [.. Enumerable.Range(0, rows).OrderBy(row => (row * 2654435761u) % 1000003)];

    private static void Pool(Action<bool, string> check)
    {
        var pool = new RoomPool();
        var first = pool.Rent(1000);
        pool.Return(first);
        var again = pool.Rent(500);
        check(first.Length >= 1000 && first.Length % (16 * 1024) == 0 && ReferenceEquals(first, again) && pool.Made == 1 && pool.Reused == 1 && pool.IdleRooms == 0,
            "a room given back is rented again for a page it holds, and rooms are made a multiple of 16 KiB");

        var small = pool.Rent(20_000);
        var large = pool.Rent(70_000);
        pool.Return(large);
        pool.Return(again);
        pool.Return(small);
        var fit = pool.Rent(17_000);
        var bigger = pool.Rent(40_000);
        check(ReferenceEquals(fit, small) && ReferenceEquals(bigger, large) && pool.IdleRooms == 1, "a reader gets the shortest idle room long enough");

        pool.Return(fit);
        pool.Return(fit);
        check(pool.IdleRooms == 2 && ReferenceEquals(pool.Rent(17_000), fit) && !ReferenceEquals(pool.Rent(17_000), fit),
            "a room given back twice is kept once, so two readers never share it");

        var huge = pool.Rent(RoomPool.LargestRoom + 1);
        var before = pool.IdleRooms;
        pool.Return(huge);
        check(huge.Length == RoomPool.LargestRoom + 1 && pool.IdleRooms == before, "a room longer than the largest kept is made to length and dropped when given back");

        var capped = new RoomPool();
        var rented = Enumerable.Range(0, (int)(RoomPool.IdleBytes / RoomPool.LargestRoom) + 4).Select(_ => capped.Rent(RoomPool.LargestRoom)).ToList();
        foreach (var room in rented) capped.Return(room);
        check(capped.Idle <= RoomPool.IdleBytes && capped.Idle > RoomPool.IdleBytes - RoomPool.LargestRoom, "the idle rooms stop at the pool's cap and the rest are dropped");

        var now = Environment.TickCount64;
        capped.Return(capped.Rent(10));
        capped.Trim(now + RoomPool.IdleMs / 2);
        var kept = capped.IdleRooms;
        capped.Trim(Environment.TickCount64 + RoomPool.IdleMs + 1);
        var trimmed = capped.IdleRooms;
        pool.Trim();
        check(kept > 0 && trimmed == 0 && capped.Idle == 0 && pool.IdleRooms == 0, "idle rooms are kept while rooms were rented lately and all let go once none has been for the idle time");
    }

    /// <summary>Tiles of a scattered view of a packed result read the same bytes as of the result unpacked, and reading
    /// them again makes no room: every room went back.</summary>
    private static void ViewReads(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 30) { Packing = PagePacking.OnRequest };
        var set = Filled(store, 60_000);
        var order = Scattered(60_000);
        var rawView = store.AddView(set, order, [], false, true, 0, null);
        byte[][] Read(ResultView view, long from) => [.. ViewPages.Build(view, from, 300).Select(page => page.Body())];
        var expected = new[] { 0L, 12_345, 59_800 }.Select(from => Read(rawView, from)).ToArray();
        set.Pack();
        var view = store.AddView(set, order, [], false, true, 0, null);
        var first = new[] { 0L, 12_345, 59_800 }.Select(from => Read(view, from)).ToArray();
        var made = store.Rooms.Made;
        var second = new[] { 0L, 12_345, 59_800 }.Select(from => Read(view, from)).ToArray();
        static bool Same(byte[][][] a, byte[][][] b) => a.Length == b.Length && a.Zip(b).All(pair => pair.First.Length == pair.Second.Length && pair.First.Zip(pair.Second).All(p => p.First.AsSpan().SequenceEqual(p.Second)));
        check(set.HasPacked && Same(first, expected) && Same(second, expected) && made > 0 && store.Rooms.Made == made && store.Rooms.Reused > 0
            && store.Rooms.IdleRooms == made,
            $"a packed view's tiles read as unpacked, through rooms from the pool, all back after each read and none made a second time (made {made}, then {store.Rooms.Made})");
        store.Release(set.ResultId);
    }

    /// <summary>A read (which may wait for credit with a page) holds no room between its pages; Copy and Save keep their
    /// group's rooms across pages, and those stay theirs: changing every idle room between pages changes no page.</summary>
    private static void HeldAcrossPages(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 30) { Packing = PagePacking.OnRequest };
        var set = Filled(store, 60_000);
        var order = Scattered(60_000);
        var rawView = store.AddView(set, order, [], false, true, 0, null);
        var expected = ViewPages.Stored(rawView, 100, 20_000).Select(page => page.Body()).ToArray();
        set.Pack();
        var view = store.AddView(set, order, [], false, true, 0, null);
        var allBack = true;
        var reads = 0;
        foreach (var _ in ViewPages.Build(view, 100, 20_000))
        {
            allBack &= store.Rooms.IdleRooms == store.Rooms.Made;
            reads++;
        }
        void Scribble()
        {
            var idle = new List<byte[]>();
            while (store.Rooms.IdleRooms > 0) idle.Add(store.Rooms.Rent(1));
            foreach (var room in idle)
            {
                room.AsSpan().Fill(0xEE);
                store.Rooms.Return(room);
            }
        }
        var copied = new List<byte[]>();
        var heldSome = false;
        foreach (var page in ViewPages.Stored(view, 100, 20_000))
        {
            heldSome |= store.Rooms.IdleRooms < store.Rooms.Made;
            copied.Add(page.Body());
            Scribble();
        }
        check(reads > 1 && allBack, "a view read of a packed result gives every room back before it hands over a page");
        check(heldSome && copied.Count == expected.Length && copied.Zip(expected).All(pair => pair.First.AsSpan().SequenceEqual(pair.Second)),
            "Copy and Save through a view keep their group's rooms across pages, and nothing else writes them meanwhile");
        store.Release(set.ResultId);
    }

    /// <summary>Find over a packed result rents its workers' rooms from the pool and gives them back, so a second Find makes
    /// none; a room still out when its operation's rooms are disposed is not given back.</summary>
    private static void Operations(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 30) { Packing = PagePacking.OnRequest };
        var set = Filled(store, 60_000);
        set.Pack();
        var pages = set.SealedSnapshot();
        ResultSearcher.Search(set, pages, null, "zqxjvk", 0, false, 10, CancellationToken.None, narrow: false, filters: false);
        var made = store.Rooms.Made;
        ResultSearcher.Search(set, pages, null, "zqxjvk", 0, false, 10, CancellationToken.None, narrow: false, filters: false);
        check(made > 0 && store.Rooms.Made == made && store.Rooms.IdleRooms == made, $"a second Find over a packed result makes no room (made {made}, then {store.Rooms.Made})");

        using (set.Pin())
        {
            var rooms = PageRooms.Over(pages, set.Wires.Count, () => new InvalidOperationException())!;
            var given = rooms.Rent();
            var kept = rooms.Rent();
            given.Dispose();
            var idle = store.Rooms.IdleRooms;
            rooms.Dispose();
            var afterDispose = store.Rooms.IdleRooms;
            kept.Dispose();
            check(afterDispose == idle + 1 && store.Rooms.IdleRooms == afterDispose && !RentsBack(store.Rooms, kept.Bytes),
                "an operation's rooms go back to the pool when they are disposed, but not a room its reader still holds");
        }
        store.Release(set.ResultId);
    }

    private static bool RentsBack(RoomPool pool, byte[] room)
    {
        var rented = new List<byte[]>();
        var found = false;
        while (pool.IdleRooms > 0)
        {
            var next = pool.Rent(1);
            found |= ReferenceEquals(next, room);
            rented.Add(next);
        }
        foreach (var back in rented) pool.Return(back);
        return found;
    }

    /// <summary>Pages read together that fail (cancelled) give their rooms back and hold nothing.</summary>
    private static void Refused(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 30) { Packing = PagePacking.OnRequest };
        var set = Filled(store, 60_000);
        set.Pack();
        var pages = set.SealedSnapshot();
        var used = store.UsedBytes;
        var rooms = new List<byte[]> { new byte[1] };
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        var failed = false;
        long reserved = -1;
        using (set.Pin())
        {
            try { set.BodiesTogether([.. pages.Take(8)], out reserved, cancelled.Token, rooms); }
            catch (OperationCanceledException) { failed = true; }
        }
        check(failed && reserved == 0 && rooms.Count == 1 && store.Rooms.IdleRooms == 8 && store.UsedBytes == used,
            "pages read together that are cancelled give their rooms back, leave the caller's earlier rooms, and hold nothing");
        store.Release(set.ResultId);
    }
}
