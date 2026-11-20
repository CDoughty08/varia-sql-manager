using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>The room pool benchmark (tests/bench/search.bench.ts runs it with <see cref="Argument"/>): 400,000 W1 rows
/// packed, a view of them in a scattered order (a sorted grid's), and 200 random 128-row tiles read through it as
/// results.read reads them, which unpacks a page or so a row into rooms from the store's pool (<see cref="RoomPool"/>).
/// Reports the memory a tile allocates and the full collections the reads cause. Prints one JSON line per metric; measures
/// only.</summary>
internal static class RoomPoolBench
{
    public const string Argument = "--room-pool-bench";

    public static void Run()
    {
        const int rows = 400_000, tile = 128, reads = 200;
        var meta = SyntheticRows.Columns("W1");
        var store = new ResultStore(2L << 30, 2L << 30) { Packing = PagePacking.OnRequest };
        var set = store.Open(store.BeginQuery("bench"), 0, 1, 1, "rows",
            [.. meta.Select(column => new ResultColumn(column.Name, column.DataType, column.Wire == WireKind.Text ? "text" : "binary"))], [.. meta.Select(column => column.Wire)])!;
        for (long row = 0; row < rows; row++)
        {
            set.CountRow();
            if (set.BeginRow() is not { } builder) continue;
            SyntheticRows.WriteCells("W1", row, builder);
            set.TryCommitRow();
        }
        set.Complete();
        set.Pack();
        var view = store.AddView(set, [.. Enumerable.Range(0, rows).OrderBy(row => (row * 2654435761u) % 1000003)], [], false, true, 0, null);
        var seed = 7L;
        long Next() { seed = (seed * 1103515245 + 12345) % (1L << 31); return (long)(seed / (double)(1L << 31) * (rows / tile)) * tile; }
        long read = 0;
        for (var i = 0; i < 20; i++)
            foreach (var page in ViewPages.Build(view, Next(), tile)) read += page.Rows;
        GC.Collect();
        GC.WaitForPendingFinalizers();
        var allocated = GC.GetTotalAllocatedBytes(true);
        var full = GC.CollectionCount(2);
        var watch = Stopwatch.StartNew();
        for (var i = 0; i < reads; i++)
            foreach (var page in ViewPages.Build(view, Next(), tile)) read += page.Rows;
        watch.Stop();
        var perTile = (GC.GetTotalAllocatedBytes(true) - allocated) / (double)reads;
        var collections = GC.CollectionCount(2) - full;
        if (read != (reads + 20L) * tile) throw new InvalidOperationException("A tile came back short.");
        var detail = string.Create(CultureInfo.InvariantCulture,
            $"{reads} random {tile}-row tiles of a scattered 400,000-row W1 view of a packed result ({set.SealedSnapshot().Length} pages), {watch.Elapsed.TotalMilliseconds / reads:F2} ms a tile; the pool reused {store.Rooms.Reused:N0} rooms and made {store.Rooms.Made:N0}");
        Print("node.roomPool.tileAllocatedMb", perTile / 1e6, "MB", detail);
        Print("node.roomPool.tileGen2", collections, "collections", detail);
        store.Release(set.ResultId);
    }

    private static void Print(string id, double value, string unit, string detail) =>
        Console.WriteLine(JsonSerializer.Serialize(new { id, value = Math.Round(value, 3), unit, detail }));
}
