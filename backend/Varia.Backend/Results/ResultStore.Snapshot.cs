namespace Varia.Backend.Results;

/// <summary>What the store holds, for the Memory panel's Nerd metrics (the results.memory event's detail). Kept apart from
/// the page code so the snapshot reads the store only through what each set already reports.</summary>
internal sealed partial class ResultStore
{
    /// <summary>The most results the detail names.</summary>
    public const int MaxLargest = 8;

    /// <summary>The codec's name and level as the panel shows them while packing is on.</summary>
    internal const string CodecName = "zstd";

    /// <summary>Totals over every stored set and the largest few: the rows as read, what holds them now (raw pages plus packed
    /// ones), the packed pages and the rows they hold, and the unpacked pages cached for reads, each set's figures read under
    /// its own lock (<see cref="ResultSetBuffer.Memory"/>). The sets are copied under the store's lock and read outside it,
    /// one set's lock at a time, as a progress event reads them, so the totals are a sum of consistent per-set figures, not
    /// one instant. The codec's name and level are left out while packing is off; its counters are the store's.</summary>
    internal ResultMemoryDetail MemoryDetail()
    {
        long logical = 0, stored = 0, packed = 0, packedLogical = 0, cache = 0;
        var largest = new List<ResultMemoryEntry>(MaxLargest + 1);
        foreach (var set in Sets())
        {
            var figures = set.Memory();
            logical += figures.Logical;
            stored += figures.StoredBytes;
            packed += figures.Packed;
            packedLogical += figures.PackedLogical;
            cache += figures.Cache;
            var bytes = figures.Logical;
            if (bytes <= 0 || largest.Count == MaxLargest && bytes <= largest[^1].LogicalBytes) continue;
            var at = largest.FindIndex(entry => entry.LogicalBytes < bytes);
            // Packed once a whole pass ended; a pass stopped by a read, a pin or a lease leaves it partial until the next one.
            var state = figures.Unpacking is not null ? "unpacking" : figures.PackedLogical == 0 ? "raw" : figures.Whole ? "packed" : "partial";
            largest.Insert(at < 0 ? largest.Count : at, new ResultMemoryEntry(set.ResultId, bytes, figures.StoredBytes, state, figures.Unpacking, Live: set.Budget.Live is null ? null : true));
            if (largest.Count > MaxLargest) largest.RemoveAt(MaxLargest);
        }
        var heap = GC.GetGCMemoryInfo();
        return new ResultMemoryDetail(logical, stored, packed, packedLogical, cache, largest, Codec(), new ManagedHeap(heap.TotalCommittedBytes, heap.FragmentedBytes), WindowCacheBytes);
    }

    /// <summary>The codec's counters since the store began, times in microseconds.</summary>
    private ResultCodecCounters Codec()
    {
        var counters = PackingSnapshot();
        var on = Packing != PagePacking.Off;
        static long Micro(long ticks) => (long)(ticks * 1_000_000.0 / System.Diagnostics.Stopwatch.Frequency);
        return new ResultCodecCounters(on ? CodecName : null, on ? PageCodec.Quality : null, counters.PagesPacked, counters.PagesUnpacked, counters.PackedInBytes, Micro(counters.PackTicks),
            counters.UnpackedBytes, Micro(counters.UnpackTicks), counters.CacheHits, counters.CacheLookups, Micro(counters.LastUnpackTicks));
    }
}
