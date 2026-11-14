namespace Varia.Backend.Results;

/// <summary>What the store holds, for the Memory panel's Nerd metrics (the results.memory event's detail). Kept apart from
/// the page code so the snapshot reads the store only through what each set already reports.</summary>
internal sealed partial class ResultStore
{
    /// <summary>The most results the detail names.</summary>
    public const int MaxLargest = 8;

    /// <summary>Totals over every stored set and the largest few. Nothing is compressed yet, so every page is raw: stored
    /// bytes equal the rows as read, the compressed figures are 0 and the codec is off. The sets are copied under the
    /// store's lock and read outside it, one set's lock at a time, as a progress event reads them.</summary>
    internal ResultMemoryDetail MemoryDetail()
    {
        ResultSetBuffer[] held;
        lock (gate) held = [.. sets.Values];
        long logical = 0;
        var largest = new List<ResultMemoryEntry>(MaxLargest + 1);
        foreach (var set in held)
        {
            var bytes = set.Progress().BytesStored;
            logical += bytes;
            if (bytes <= 0 || largest.Count == MaxLargest && bytes <= largest[^1].LogicalBytes) continue;
            var at = largest.FindIndex(entry => entry.LogicalBytes < bytes);
            largest.Insert(at < 0 ? largest.Count : at, new ResultMemoryEntry(set.ResultId, bytes, bytes, "raw", Live: set.Budget.Live is null ? null : true));
            if (largest.Count > MaxLargest) largest.RemoveAt(MaxLargest);
        }
        var heap = GC.GetGCMemoryInfo();
        return new ResultMemoryDetail(logical, logical, 0, 0, 0, largest, ResultCodecCounters.Off, new ManagedHeap(heap.TotalCommittedBytes, heap.FragmentedBytes));
    }
}
