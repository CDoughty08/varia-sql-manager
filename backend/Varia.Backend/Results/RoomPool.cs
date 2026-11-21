using System.Runtime.CompilerServices;

namespace Varia.Backend.Results;

/// <summary>The store's rooms for view reads, kept between reads (docs/page-compression-findings.md, Room pool). A sorted
/// view's tile unpacks a page or so a row (<see cref="ViewPages.UnpackTogether"/> at a time) and every operation over a
/// packed result unpacks into a room a worker (<see cref="PageRooms"/>); without the pool each read made its rooms anew,
/// 256 KiB arrays on the large object heap that only a full collection frees, so a grid scrolling a sorted view of a packed
/// result allocated 33 MB a tile and collected every other tile. A reader rents a room at least a page's length, uses
/// its first page-length bytes, and gives it back when it stops reading it; the pool then keeps it while the rooms it holds
/// stay under <see cref="IdleBytes"/>, those given back longest ago making way for one given back now, and lets them all
/// go once none has been rented for <see cref="IdleMs"/> (<see cref="Trim"/>). A room kept here is not charged to the
/// budget: it holds no rows, and the cap bounds it, as a sort's or a filter's pooled scratch is bounded. A rented room is
/// charged by its reader as before. Rooms longer than <see cref="LargestRoom"/> (a page of very wide rows) are made for
/// the read and never kept.</summary>
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

    // Oldest given back first.
    private readonly List<byte[]> idle = [];
    // Rooms out now that were rented for a shorter page than they were made for (rounded), with that page's room length;
    // one is marked for each room made for a page no longer than the one it was lent to: what the current reads need less
    // of. Weak, so a room its reader never gave back is still collected.
    private readonly ConditionalWeakTable<byte[], Misfit> misfits = [];
    private sealed class Misfit(int rented) { public readonly int Rented = rented; public bool Lacked; }
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
                // In order, so the list stays in the order rooms were given back.
                idle.RemoveAt(best);
                idleBytes -= room.Length;
                if (room.Length > Rounded(length)) misfits.AddOrUpdate(room, new Misfit(Rounded(length)));
                Interlocked.Increment(ref reused);
                return room;
            }
            // Made when no idle room was long enough (rare, and itself the cost the pool saves): one room the reads lack, so one
            // room lent to a page no shorter than this one (it took the room this page could have had) is marked, the longest,
            // to make way for it. One lent to a shorter page still serves pages of its own length and is not.
            var making = Rounded(length);
            Misfit? longest = null;
            byte[]? longestRoom = null;
            foreach (var (lent, mark) in misfits)
                if (!mark.Lacked && making <= mark.Rented && (longestRoom is null || lent.Length > longestRoom.Length)) (longest, longestRoom) = (mark, lent);
            longest?.Lacked = true;
        }
        Interlocked.Increment(ref made);
        return GC.AllocateUninitializedArray<byte>(Rounded(length));
    }

    // A new room's length: rounded up, so pages of nearly one length share rooms.
    private static int Rounded(int length) => length <= LargestRoom ? (int)Math.Min(LargestRoom, ((long)length + RoundTo - 1) / RoundTo * RoundTo) : length;

    /// <summary>Gives a room back once its reader has stopped reading it: nothing may read or write it after.</summary>
    public void Return(byte[] room)
    {
        if (room.Length > LargestRoom) return;
        lock (idle)
        {
            // A room given back twice would be rented to two readers at once.
            if (idle.Exists(kept => ReferenceEquals(kept, room))) return;
            // A room lent to a shorter page than its own is dropped if it was marked to make way for a room made while it was
            // out (the reads lacked rooms that short, which it would keep out of the pool) and otherwise kept only while the pool
            // has space, the first to make way.
            if (misfits.TryGetValue(room, out var misfit))
            {
                misfits.Remove(room);
                if (misfit.Lacked || idleBytes + room.Length > IdleBytes) return;
                idle.Insert(0, room);
                idleBytes += room.Length;
                return;
            }
            // Full: the rooms given back longest ago make way, whatever their length, so the rooms the current reads use stay
            // and those an earlier read left, narrower or wider, age out within a tile or two.
            var oldest = 0;
            for (var freed = 0L; idleBytes - freed + room.Length > IdleBytes; oldest++) freed += idle[oldest].Length;
            for (var i = 0; i < oldest; i++) idleBytes -= idle[i].Length;
            idle.RemoveRange(0, oldest);
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
            misfits.Clear();
            idleBytes = 0;
        }
    }
}
