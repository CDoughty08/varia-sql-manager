using System.Collections.Concurrent;

namespace Varia.Backend.Results;

/// <summary>The rooms a fused read unpacks packed pages into (docs/page-compression-findings.md, Fused per-page reads):
/// each worker of an operation over a packed result takes one (<see cref="Rent"/>), unpacks the page it is about to read
/// into it (<see cref="ResultSetBuffer.Read"/>), reads it and moves on, so the operation holds about one page a worker
/// rather than the result's bytes as sealed. Each room is the size of the largest packed page, reserved from the result's
/// budget as working memory when it is first made (refused: <see cref="Rent"/> throws the operation's refusal) and reused
/// after; every reservation is returned when the rooms are disposed. The arrays come from the shared pool.</summary>
internal sealed class PageRooms(ResultSetBuffer set, int length, int layout, Func<Exception> refusal) : IDisposable
{
    private readonly ConcurrentBag<PageRoom> free = [];
    private readonly List<PageRoom> made = [];
    private long reserved;
    private bool disposed;

    /// <summary>The bytes of one room: the largest packed page's length as sealed.</summary>
    public int Length => length;
    /// <summary>Rooms made so far, which is the most in use at once.</summary>
    public int Made { get { lock (made) return made.Count; } }
    /// <summary>Working memory the rooms hold now.</summary>
    public long Reserved { get { lock (made) return reserved; } }

    /// <summary>A room for one reader, which disposes it (it goes back to the pool) when it stops reading.</summary>
    public PageRoom Rent()
    {
        if (free.TryTake(out var room)) return room;
        if (!set.TryReserveWork(length)) throw refusal();
        lock (made)
        {
            if (disposed)
            {
                set.ReturnWork(length);
                throw new ObjectDisposedException(nameof(PageRooms));
            }
            reserved += length;
            // Its own array, not a pooled one: it goes with the operation, so memory charged as working memory is not kept after it.
            room = new PageRoom(this, GC.AllocateUninitializedArray<byte>(length), new int[layout]);
            made.Add(room);
        }
        return room;
    }

    internal void Return(PageRoom room)
    {
        lock (made) if (disposed) return;
        free.Add(room);
    }

    /// <summary>Returns every room's reservation, once its readers have all stopped.</summary>
    public void Dispose()
    {
        lock (made)
        {
            if (disposed) return;
            disposed = true;
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
    public void Dispose() => owner.Return(this);
}
