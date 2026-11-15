using System.Collections.Concurrent;

namespace Varia.Backend.Results;

/// <summary>The rooms a fused read unpacks packed pages into (docs/page-compression-findings.md, Fused per-page reads):
/// each worker of an operation over a packed result takes one (<see cref="Rent"/>), unpacks the page it is about to read
/// into it (<see cref="ResultSetBuffer.Read"/>), reads it and moves on, so the operation holds about one page a worker
/// rather than the result's bytes as sealed. Each room is the size of the largest packed page, reserved from the result's
/// budget as working memory when it is first made (refused: <see cref="Rent"/> throws the operation's refusal) and reused
/// after; every reservation is returned when the rooms are disposed. The rooms ask the system's memory load once for
/// every <see cref="ResultStore.WorkCheckBytes"/> they take together, as one reservation of that size would, so many
/// small rooms (a diff's page caches) are refused under high load as other working memory is. Each room is an array of
/// its own, dropped with the rooms, so memory charged only while the operation runs is not kept by a pool after it.</summary>
internal sealed class PageRooms(ResultSetBuffer set, int length, int layout, Func<Exception> refusal) : IDisposable
{
    private readonly ConcurrentBag<PageRoom> free = [];
    private readonly List<PageRoom> made = [];
    private long reserved;
    // Every byte asked for, refused asks taken back: where the next ask of the system's memory load falls.
    private long asked;
    private bool disposed;

    /// <summary>Rooms for reading <paramref name="pages"/> (of one set) fused, each the largest packed page's length, or null
    /// when none of them is packed now. The caller holds the set's pin, so no page is packed while it reads.</summary>
    public static PageRooms? Over(StoredPage[] pages, int columns, Func<Exception> refusal)
    {
        ResultSetBuffer? owner = null;
        var largest = 0;
        foreach (var page in pages)
        {
            if (page.Set is not { } set || set.Raw(page) is not null) continue;
            owner = set;
            largest = Math.Max(largest, page.Length);
        }
        return owner is null ? null : new PageRooms(owner, largest, PageView.ScratchLength(columns), refusal);
    }

    /// <summary>The set whose pages the rooms are for.</summary>
    public ResultSetBuffer Set => set;
    /// <summary>The bytes of one room: the largest packed page's length as sealed.</summary>
    public int Length => length;
    /// <summary>Rooms made so far, which is the most in use at once.</summary>
    public int Made { get { lock (made) return made.Count; } }
    /// <summary>Working memory the rooms hold now.</summary>
    public long Reserved { get { lock (made) return reserved; } }

    /// <summary>How much the rooms take between asks of the system's memory load; smaller only in the checks.</summary>
    internal long CheckBytes { get; init; } = ResultStore.WorkCheckBytes;

    /// <summary>A room for one reader, which disposes it (it goes back to the pool) when it stops reading.</summary>
    public PageRoom Rent()
    {
        PageRoom? room;
        lock (made)
        {
            if (disposed) throw new ObjectDisposedException(nameof(PageRooms));
            if (free.TryTake(out room))
            {
                room.Taken();
                return room;
            }
        }
        var total = Interlocked.Add(ref asked, length);
        var ask = total / CheckBytes != (total - length) / CheckBytes;
        if (!set.TryReserveWork(length, ask))
        {
            Interlocked.Add(ref asked, -length);
            throw refusal();
        }
        lock (made)
        {
            if (disposed)
            {
                set.ReturnWork(length);
                throw new ObjectDisposedException(nameof(PageRooms));
            }
            reserved += length;
            room = new PageRoom(this, GC.AllocateUninitializedArray<byte>(length), new int[layout]);
            made.Add(room);
        }
        return room;
    }

    internal void Return(PageRoom room)
    {
        lock (made) if (!disposed) free.Add(room);
    }

    /// <summary>Returns every room's reservation, once its readers have all stopped.</summary>
    public void Dispose()
    {
        lock (made)
        {
            if (disposed) return;
            disposed = true;
            free.Clear();
            made.Clear();
            set.ReturnWork(reserved);
            reserved = 0;
        }
    }
}

/// <summary>One reader's room (<see cref="PageRooms"/>): the bytes a packed page is unpacked into and the layout it is
/// parsed into. Disposing it gives it back for another reader.</summary>
internal sealed class PageRoom(PageRooms owner, byte[] bytes, int[] layout) : IDisposable
{
    public byte[] Bytes { get; } = bytes;
    public int[] Layout { get; } = layout;
    private int returned;

    /// <summary>Taken again from the free rooms: its next Dispose returns it.</summary>
    internal void Taken() => Volatile.Write(ref returned, 0);

    /// <summary>Gives the room back once: a second Dispose would put it in the free rooms twice, so that two readers shared it.</summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref returned, 1) == 0) owner.Return(this);
    }
}

/// <summary>One thread's reader of pages for a fused read (<see cref="PageRooms"/>). Pages the store holds as sealed are
/// parsed in place. A packed page is unpacked into a room of the reader's own (rented when first needed) and kept there:
/// up to <c>slots</c> pages, the room of the page read least lately reused first, so a reader that comes back to pages it
/// read lately (a diff's first result, read in the second result's order) does not unpack them again. With no rooms
/// (no page was packed when the operation began) every page is read through its set's accessor, exactly as before fused
/// reads. A view of a page held as sealed shares the reader's one layout, so it is valid until the reader's next read; a
/// view of a packed page, until its room is reused. Disposing the reader gives its rooms back.</summary>
internal sealed class RoomReader(PageRooms? rooms, int columns, int slots = 1) : IDisposable
{
    private readonly PageRoom?[] held = new PageRoom?[slots];
    private readonly StoredPage?[] kept = new StoredPage?[slots];
    private readonly int[] blobStarts = new int[slots];
    private readonly long[] used = new long[slots];
    private readonly int[] scratch = new int[PageView.ScratchLength(columns)];
    private long clock;

    /// <summary>Packed pages this reader has unpacked.</summary>
    public long Unpacked { get; private set; }

    /// <summary>For checks: run between asking whether a page is packed and reading it, where another operation may unpack
    /// it in place.</summary>
    internal Action? BeforeRead { get; init; }

    /// <summary>A page, as sealed. Read only while its set is pinned.</summary>
    public PageView Read(StoredPage page)
    {
        if (rooms is null || page.Set is not { } set) return PageView.Parse(page.Body(), columns, scratch);
        if (set.Raw(page) is { } raw) return PageView.Parse(raw, columns, scratch);
        var slot = 0;
        for (var i = 0; i < held.Length; i++)
        {
            if (ReferenceEquals(kept[i], page))
            {
                used[i] = ++clock;
                return PageView.At(held[i]!.Bytes.AsSpan(0, page.Length), blobStarts[i], held[i]!.Layout, page.FirstRow, page.Rows, columns);
            }
            if (used[i] < used[slot]) slot = i;
        }
        var room = held[slot] ??= rooms.Rent();
        // Not the old page's any more, whether or not the new one unpacks.
        kept[slot] = null;
        // Another operation may have unpacked the page in place since Raw was asked (pins allow it): then Read answers
        // the page's own array, read as a sealed page is, and the room keeps nothing.
        BeforeRead?.Invoke();
        var body = set.Read(page, room.Bytes);
        if (!ReferenceEquals(body, room.Bytes)) return PageView.Parse(body, columns, scratch);
        var view = PageView.Parse(room.Bytes.AsSpan(0, page.Length), columns, room.Layout);
        kept[slot] = page;
        blobStarts[slot] = view.BlobStart;
        used[slot] = ++clock;
        Unpacked++;
        return view;
    }

    public void Dispose()
    {
        for (var i = 0; i < held.Length; i++)
        {
            held[i]?.Dispose();
            held[i] = null;
            kept[i] = null;
        }
    }
}

/// <summary>Packed pages unpacked ahead for one thread that reads them in an order known beforehand (a unified diff's
/// writer, <see cref="UnifiedDiff.Write"/>): <c>uses</c> lists the pages' indices in the order the reader will first ask
/// for each, a page read again straight after not repeated. They are unpacked a batch at a time on the workers, the next
/// batch while the reader reads the one before, as a pivot's in-order pass does (<see cref="ViewSorter.PageSource.InOrder"/>).
/// Its two batches of rooms only make the read faster, so they are taken together from memory the budget can spare
/// (<see cref="ResultSetBuffer.TryReserveSpare"/>) or not at all (<see cref="TryStart"/> answers null and the reader
/// unpacks its pages itself), and the reader gives them back once the budget reaches that free eighth
/// (<see cref="ResultSetBuffer.HasSpare"/>), so the operation's own output keeps the room it would have had. <see cref="TryRead"/> serves the
/// page being read, the pages of its batch already reached, and the next one listed; any other page is the caller's to
/// read (false). Disposing it waits for a
/// batch still being unpacked and gives the rooms back.</summary>
internal sealed class PageAhead : IDisposable
{
    private readonly ResultSetBuffer set;
    private readonly StoredPage[] pages;
    private readonly int[] uses;
    private readonly int columns;
    private readonly CancellationToken token;
    private readonly int batch;
    private readonly byte[,][] bytes;
    private readonly int[,][] layouts;
    private readonly int[,] blobStarts;
    private long reserved;
    // The use being read (-1 before the first), the first use of the batch it is in, and that batch's half.
    private int at = -1;
    private int start;
    private int half;
    private Task? ahead;

    /// <summary>Unpacks the pages <paramref name=uses/> lists ahead, its first batch before it returns; null when there are
    /// none or the budget cannot spare two batches of rooms of <paramref name=roomLength/> bytes.</summary>
    public static PageAhead? TryStart(ResultSetBuffer set, StoredPage[] pages, int[] uses, int roomLength, int columns, CancellationToken token)
    {
        if (uses.Length == 0) return null;
        var batch = Math.Min(Batch, uses.Length);
        var bytes = 2L * Math.Min(batch, uses.Length) * roomLength;
        if (!set.TryReserveSpare(bytes)) return null;
        var reader = new PageAhead(set, pages, uses, columns, token, batch, roomLength) { reserved = bytes };
        try { reader.Fill(0, 0); }
        catch { reader.Dispose(); throw; }
        return reader;
    }

    private PageAhead(ResultSetBuffer set, StoredPage[] pages, int[] uses, int columns, CancellationToken token, int batch, int roomLength)
    {
        this.set = set;
        this.pages = pages;
        this.uses = uses;
        this.columns = columns;
        this.token = token;
        this.batch = batch;
        bytes = new byte[2, batch][];
        layouts = new int[2, batch][];
        blobStarts = new int[2, batch];
        var layout = PageView.ScratchLength(columns);
        for (var h = 0; h < 2; h++)
            for (var k = 0; k < batch; k++)
            {
                bytes[h, k] = GC.AllocateUninitializedArray<byte>(roomLength);
                layouts[h, k] = new int[layout];
            }
    }

    /// <summary>Pages unpacked together: one a worker. A caller lists a page once a batch (uses[k * Batch ..]).</summary>
    public static int Batch => Math.Max(1, ViewSorter.Workers);

    /// <summary>Packed pages this reader has unpacked.</summary>
    public long Unpacked => Interlocked.Read(ref unpacked);
    private long unpacked;

    private void Fill(int into, int from)
    {
        var count = Math.Min(uses.Length, from + batch) - from;
        // A lease a batch, so threads go back to other operations between batches.
        using var threads = ViewSorter.Gate.Take(Math.Min(ViewSorter.Workers, count));
        threads.For(count, k =>
        {
            var page = pages[uses[from + k]];
            // A page unpacked in place meanwhile answers its own array: copied, so the batch reads like any other.
            var body = set.Read(page, bytes[into, k]);
            if (!ReferenceEquals(body, bytes[into, k])) body.AsSpan(0, page.Length).CopyTo(bytes[into, k]);
            blobStarts[into, k] = PageView.Parse(bytes[into, k].AsSpan(0, page.Length), columns, layouts[into, k]).BlobStart;
        }, token);
        Interlocked.Add(ref unpacked, count);
    }

    /// <summary>The page <paramref name="index"/> when it is the one being read or the next listed (which it then becomes,
    /// waiting for its batch if it is still being unpacked); otherwise false and the caller reads it.</summary>
    public bool TryRead(int index, out PageView view)
    {
        // The page being read, or one its batch listed and already reached.
        for (var use = at; use >= start && use >= 0; use--)
            if (uses[use] == index)
            {
                view = View(use);
                return true;
            }
        if (at + 1 >= uses.Length || uses[at + 1] != index)
        {
            view = default;
            return false;
        }
        at++;
        if (at == start + batch)
        {
            // Into the batch unpacked ahead: the half just read is free for the batch after it.
            ahead!.GetAwaiter().GetResult();
            ahead = null;
            start += batch;
            half ^= 1;
        }
        if (at == start && start + batch < uses.Length)
        {
            var next = start + batch;
            var into = half ^ 1;
            ahead = Task.Run(() => Fill(into, next), token);
        }
        view = View(at);
        return true;
    }

    private PageView View(int use)
    {
        var page = pages[uses[use]];
        var k = use - start;
        return PageView.At(bytes[half, k].AsSpan(0, page.Length), blobStarts[half, k], layouts[half, k], page.FirstRow, page.Rows, columns);
    }

    public void Dispose()
    {
        // A batch still being unpacked finishes (or fails) before its rooms go back.
        try { ahead?.Wait(); } catch (AggregateException) { }
        ahead = null;
        set.ReturnWork(Interlocked.Exchange(ref reserved, 0));
    }
}

/// <summary>The room a reader on one thread that must never be refused unpacks a packed page into before it reads it (a
/// plain Copy or Save, a distinct list's values): one page, the largest met, reserved from the result's budget as working
/// memory while the reader reads and returned when it ends. Without room, or for a view's pages (built for the read), a
/// page is read through its set's accessor as before. Pages held as sealed are read in place.</summary>
internal sealed class ReadRoom(ResultSetBuffer set) : IDisposable
{
    private byte[]? bytes;
    private long reserved;
    private bool refused;

    public ReadOnlySpan<byte> Body(StoredPage page)
    {
        if (page.Set != set) return page.Body();
        if (set.Raw(page) is { } raw) return raw;
        if (!refused && (bytes is null || bytes.Length < page.Length))
        {
            if (set.TryReserveWork(page.Length - reserved))
            {
                reserved = page.Length;
                bytes = new byte[page.Length];
            }
            else refused = true;
        }
        return bytes is not null && bytes.Length >= page.Length ? set.Read(page, bytes).AsSpan(0, page.Length) : page.Body();
    }

    public void Dispose()
    {
        set.ReturnWork(reserved);
        reserved = 0;
        bytes = null;
    }
}
