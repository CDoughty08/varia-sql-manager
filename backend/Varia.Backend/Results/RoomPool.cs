namespace Varia.Backend.Results;

/// <summary>The store's rooms for view reads, kept between reads (docs/page-compression-findings.md, Room pool). A sorted
/// view's tile unpacks a page or so a row (<see cref="ViewPages.UnpackTogether"/> at a time) and every operation over a
/// packed result unpacks into a room a worker (<see cref="PageRooms"/>); without the pool each read made its rooms anew,
/// 256 KiB arrays on the large object heap that only a full collection frees, so a grid scrolling a sorted view of a packed
/// result allocated 33 MB a tile and collected every other tile. A reader rents a room at least a page's length, uses
/// its first page-length bytes, and gives it back when it stops reading it; the pool then keeps it while the rooms it holds
/// stay under <see cref="IdleBytes"/> (the rest are dropped), and lets them all go once none has been rented for
/// <see cref="IdleMs"/> (<see cref="Trim"/>). A room kept here is not charged to the budget: it holds no rows, and the
/// cap bounds it, as a sort's or a filter's pooled scratch is bounded. A rented room is charged by its reader as before.
/// Rooms longer than <see cref="LargestRoom"/> (a page of very wide rows) are made for the read and never kept.</summary>
internal sealed class RoomPool
{
    /// <summary>The most the idle rooms hold together: one tile's rooms and one room a worker.</summary>
    public static readonly long IdleBytes = (long)(ViewPages.UnpackTogether + ViewSorter.Workers) * (PageBuilder.SealBytes + RoundTo);
    /// <summary>The longest room kept: four sealed pages' length.</summary>
    public const int LargestRoom = 4 * PageBuilder.SealBytes;
    /// <summary>How long the idle rooms are kept with no room rented.</summary>
    public const long IdleMs = 30_000;
    // Rooms are made a multiple of this, so pages of nearly one length (most end within a row of the seal) share rooms.
    private const int RoundTo = 16 * 1024;

    private readonly List<byte[]> idle = [];
    private long idleBytes;
    private long rentedAt = Environment.TickCount64;

    /// <summary>The bytes the idle rooms hold now.</summary>
    public long Idle { get { lock (idle) return idleBytes; } }
    /// <summary>The idle rooms now.</summary>
    public int IdleRooms { get { lock (idle) return idle.Count; } }
    /// <summary>Rooms rented that the pool had kept, and rooms it made: for the checks and benchmarks.</summary>
    public long Reused => Interlocked.Read(ref reused);
    public long Made => Interlocked.Read(ref made);
    private long reused, made;

    /// <summary>A room of at least <paramref name="length"/> bytes: the shortest idle one long enough, or a new one.</summary>
    public byte[] Rent(int length)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(length);
        Volatile.Write(ref rentedAt, Environment.TickCount64);
        lock (idle)
        {
            var best = -1;
            for (var i = 0; i < idle.Count; i++)
                if (idle[i].Length >= length && (best < 0 || idle[i].Length < idle[best].Length)) best = i;
            if (best >= 0)
            {
                var room = idle[best];
                idle[best] = idle[^1];
                idle.RemoveAt(idle.Count - 1);
                idleBytes -= room.Length;
                Interlocked.Increment(ref reused);
                return room;
            }
        }
        Interlocked.Increment(ref made);
        var rounded = length <= LargestRoom ? (int)Math.Min(LargestRoom, ((long)length + RoundTo - 1) / RoundTo * RoundTo) : length;
        return GC.AllocateUninitializedArray<byte>(Math.Max(rounded, length));
    }

    /// <summary>Gives a room back once its reader has stopped reading it: nothing may read or write it after.</summary>
    public void Return(byte[] room)
    {
        if (room.Length > LargestRoom) return;
        lock (idle)
        {
            // A room given back twice would be rented to two readers at once.
            if (idleBytes + room.Length > IdleBytes || idle.Exists(kept => ReferenceEquals(kept, room))) return;
            idle.Add(room);
            idleBytes += room.Length;
        }
    }

    /// <summary>Lets every idle room go when none has been rented for <see cref="IdleMs"/> (the memory report's timer
    /// asks once a second) or when <paramref name="now"/> is null.</summary>
    public void Trim(long? now = null)
    {
        if (now is { } at && at - Volatile.Read(ref rentedAt) < IdleMs) return;
        lock (idle)
        {
            idle.Clear();
            idleBytes = 0;
        }
    }
}
