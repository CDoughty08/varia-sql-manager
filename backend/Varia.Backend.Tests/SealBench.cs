using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using Microsoft.Data.SqlClient;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Run by hand with <see cref="Argument"/> and a server name: whether packing a page as it seals would let a query
/// store more than the result budget holds today, and what it would cost the fill. Reads SQL Server's own catalog rows (SELECTs
/// only, Windows authentication), made large with a cross join, into the store as ingestion does (<see cref="ColumnPlan"/>,
/// <see cref="ResultSetBuffer"/>), and measures:
/// the fill rate raw; with each page packed on the reading thread as it seals; with each page handed to a packing thread;
/// the same with several queries at once; and, with the real <see cref="ResultPacker"/> as room maker and a small query
/// half, where a single result stops today against where it would stop packed at seal. Measures only; prints no values.</summary>
internal static class SealBench
{
    public const string Argument = "--seal-bench";

    // Each query runs this many times into one set, so the result is large without a cross join (which would put copies of
    // a row next to each other on a page and flatter the codec).
    private static readonly (string Name, string Sql, int Times)[] Queries =
    [
        ("messages", "SELECT * FROM sys.messages", 4),
        ("columns", "SELECT o.name AS object_name, o.type_desc, o.create_date, o.modify_date, c.* FROM sys.all_objects o JOIN sys.all_columns c ON c.object_id = o.object_id", 16),
    ];

    /// <summary>Raw: nothing packed while storing. Inline and Thread: each sealed page packed on the reading thread or a
    /// thread of the bench's, only to time it (the store keeps it raw). Product: the store packs at seal itself
    /// (<see cref="ResultStore.PackAtSeal"/>).</summary>
    private enum Mode { Raw, Inline, Thread, Product }

    private sealed record Fill(long Rows, long Kept, long Charged, long PackedCharged, double Seconds, double PackSeconds, double DrainSeconds, int MaxBacklog, TruncationReason Truncated);

    public static void Run(string server, int concurrent)
    {
        var connection = new SqlConnectionStringBuilder { DataSource = server, IntegratedSecurity = true, TrustServerCertificate = true, Encrypt = false, ApplicationName = "Varia seal bench" }.ConnectionString;
        Console.WriteLine("processors " + Environment.ProcessorCount + ", workers " + ViewSorter.Workers);
        foreach (var (name, sql, times) in Queries)
        {
            // Warm the JIT, the plan cache and the server's buffer pool.
            One(connection, sql, times, Mode.Raw, null);
            var drain = Enumerable.Range(0, times).Sum(_ => Drain(connection, sql));
            Console.WriteLine(name + ": reader alone (rows read, cells fetched, nothing stored) " + drain.ToString("0.00", CultureInfo.InvariantCulture) + " s");
            foreach (var mode in new[] { Mode.Raw, Mode.Product, Mode.Inline, Mode.Thread, Mode.Raw, Mode.Product, Mode.Inline, Mode.Thread, Mode.Raw, Mode.Product, Mode.Inline, Mode.Thread })
                Print(name, mode.ToString().ToLowerInvariant(), One(connection, sql, times, mode, null));
            foreach (var mode in new[] { Mode.Raw, Mode.Product, Mode.Raw, Mode.Product })
            {
                var watch = Stopwatch.StartNew();
                var fills = Enumerable.Range(0, concurrent).Select(_ => Task.Run(() => One(connection, sql, times, mode, null, measurePacked: false))).ToArray();
                Task.WaitAll(fills);
                var seconds = watch.Elapsed.TotalSeconds;
                var stored = fills.Sum(fill => fill.Result.Kept);
                Console.WriteLine("  " + concurrent + " at once, " + mode.ToString().ToLowerInvariant() + ": " + seconds.ToString("0.00", CultureInfo.InvariantCulture) + " s, " + (stored / 1e6 / seconds).ToString("0", CultureInfo.InvariantCulture) + " MB/s stored in all; slowest fill " + fills.Max(fill => fill.Result.Seconds).ToString("0.00", CultureInfo.InvariantCulture) + " s");
            }
            // A query half that a result of this size overflows raw but fits packed: where it stops today, with the policy
            // asked for room, against where packing at seal would let it go.
            var full = One(connection, sql, times, Mode.Raw, null);
            var half = (full.Charged + full.PackedCharged) / 2;
            var today = One(connection, sql, times, Mode.Raw, half);
            var sealedPacked = One(connection, sql, times, Mode.Product, half);
            Console.WriteLine("  query half " + (half >> 20) + " MiB (whole result " + (full.Charged >> 20) + " MiB raw, " + (full.PackedCharged >> 20) + " MiB packed): today " + Share(today, full) + "; packed at seal " + Share(sealedPacked, full));
        }
    }

    private static string Share(Fill fill, Fill full) =>
        fill.Rows.ToString("N0", CultureInfo.InvariantCulture) + " of " + full.Rows.ToString("N0", CultureInfo.InvariantCulture) + " rows (" + (100.0 * fill.Rows / full.Rows).ToString("0", CultureInfo.InvariantCulture) + " %, " + (fill.Truncated == TruncationReason.None ? "whole" : ResultSetBuffer.Name(fill.Truncated)) + ")";

    private static void Print(string name, string mode, Fill fill) =>
        Console.WriteLine("  " + mode + ": " + fill.Seconds.ToString("0.00", CultureInfo.InvariantCulture) + " s, " + fill.Rows.ToString("N0", CultureInfo.InvariantCulture) + " rows, "
            + (fill.Kept / 1e6 / fill.Seconds).ToString("0", CultureInfo.InvariantCulture) + " MB/s stored; charged " + (fill.Charged >> 20) + " MiB raw, " + (fill.PackedCharged >> 20) + " MiB packed ("
            + ((double)fill.Charged / Math.Max(1, fill.PackedCharged)).ToString("0.00", CultureInfo.InvariantCulture) + "x)"
            + (fill.PackSeconds > 0 ? "; packing " + fill.PackSeconds.ToString("0.00", CultureInfo.InvariantCulture) + " s of one thread (" + (fill.Kept / 1e6 / fill.PackSeconds).ToString("0", CultureInfo.InvariantCulture) + " MB/s)" : "")
            + (mode is "thread" or "product" ? ", backlog at most " + fill.MaxBacklog + " pages, " + (fill.DrainSeconds * 1000).ToString("0", CultureInfo.InvariantCulture) + " ms after the last row" : ""));

    private static double Drain(string connection, string sql)
    {
        using var open = new SqlConnection(connection);
        open.Open();
        using var command = new SqlCommand(sql, open) { CommandTimeout = 0 };
        var watch = Stopwatch.StartNew();
        using var reader = command.ExecuteReader();
        var values = new object[reader.FieldCount];
        while (reader.Read()) reader.GetValues(values);
        return watch.Elapsed.TotalSeconds;
    }

    /// <summary>One fill. <paramref name="queryHalf"/> null: room for it all. Otherwise the store has that query half and the
    /// real policy as room maker.</summary>
    private static Fill One(string connection, string sql, int times, Mode mode, long? queryHalf, bool measurePacked = true)
    {
        var store = queryHalf is { } limit ? new ResultStore(4 * limit, limit) : new ResultStore(64L << 30, 64L << 30);
        ResultPacker? packer = null;
        if (mode == Mode.Product)
        {
            store.Packing = PagePacking.OnRequest;
            store.PackAtSeal = true;
        }
        if (queryHalf is not null)
        {
            store.Packing = PagePacking.OnRequest;
            packer = new ResultPacker(store, new ResultVisibility(id => store.Find(id) is not null, () => 0));
            packer.Start();
        }
        using var open = new SqlConnection(connection);
        open.Open();
        using var command = new SqlCommand(sql, open) { CommandTimeout = 0 };
        var watch = Stopwatch.StartNew();
        var reader = command.ExecuteReader();
        var plan = ColumnPlan.From(reader);
        var query = store.BeginQuery("seal-bench");
        var set = store.Open(query, 0, 1, 1, "rows", plan.Columns, plan.Wires, lengths: plan.Lengths) ?? throw new InvalidOperationException("Not kept.");
        var queue = new BlockingCollection<byte[]>();
        long packedBytes = 0;
        double packSeconds = 0;
        var maxBacklog = 0;
        var packing = mode == Mode.Thread ? new Thread(() =>
        {
            foreach (var body in queue.GetConsumingEnumerable())
            {
                var start = Stopwatch.GetTimestamp();
                packedBytes += store.Pack(body)?.Length ?? body.Length;
                packSeconds += Stopwatch.GetElapsedTime(start).TotalSeconds;
            }
        }) { IsBackground = true } : null;
        packing?.Start();
        var seen = 0;
        var waited = new SqlService.RoomWaited();
        void Sealed()
        {
            if (mode == Mode.Product) maxBacklog = Math.Max(maxBacklog, query.SealPending);
            if (mode is not (Mode.Inline or Mode.Thread)) return;
            var pages = set.SealedSnapshot();
            for (; seen < pages.Length; seen++)
            {
                byte[] body;
                using (set.Pin()) body = pages[seen].Body();
                if (mode == Mode.Inline)
                {
                    var start = Stopwatch.GetTimestamp();
                    var packed = store.Pack(body)?.Length ?? body.Length;
                    packSeconds += Stopwatch.GetElapsedTime(start).TotalSeconds;
                    packedBytes += packed;
                }
                else if (mode == Mode.Thread)
                {
                    queue.Add(body);
                    maxBacklog = Math.Max(maxBacklog, queue.Count);
                }
            }
        }
        for (var time = 0; time < times; time++)
        {
            if (time > 0)
            {
                reader.Dispose();
                reader = command.ExecuteReader();
            }
            while (reader.Read())
            {
                set.CountRow();
                var builder = set.BeginRow();
                if (builder is null) continue;
                plan.ReadRow(reader, builder, _ => { });
                var before = set.SealedPages;
                var committed = set.TryCommitRow(0, mayWait: true);
                if (!committed && set.RoomWanted > 0) SqlService.WaitAndCommitAsync(store, set, 0, waited, CancellationToken.None).GetAwaiter().GetResult();
                if (set.SealedPages != before) Sealed();
            }
        }
        reader.Dispose();
        set.Complete();
        Sealed();
        var seconds = watch.Elapsed.TotalSeconds;
        queue.CompleteAdding();
        packing?.Join();
        var drain = watch.Elapsed.TotalSeconds - seconds;
        long charged = 0, lengthBytes = 0;
        foreach (var page in set.SealedSnapshot())
        {
            charged += page.Length + ResultStore.PageOverhead + page.Lengths.MemoryBytes;
            lengthBytes += ResultStore.PageOverhead + page.Lengths.MemoryBytes;
        }
        if (mode == Mode.Product)
        {
            SpinWait.SpinUntil(() => query.SealPending == 0, 60_000);
            drain = watch.Elapsed.TotalSeconds - seconds;
            packedBytes = set.Memory().StoredBytes;
        }
        else if (mode == Mode.Raw && queryHalf is null && measurePacked)
            using (set.Pin()) foreach (var page in set.SealedSnapshot()) packedBytes += store.Pack(page.Body())?.Length ?? page.Length;
        var fill = new Fill(set.RowsAvailable, set.BytesStored, charged, packedBytes + lengthBytes, seconds, mode == Mode.Raw ? 0 : packSeconds, drain, maxBacklog, set.Truncated);
        packer?.Dispose();
        store.Release(set.ResultId);
        return fill;
    }
}
