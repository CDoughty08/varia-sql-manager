using System.Globalization;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>A replace's allowance (comparison plan PR 6, D14): results.diff's replaces raises the query's limit by the
/// replaced comparison's whole charge, for every limit reader (reservations on any thread, rooms, waits for room, spare
/// memory), summed across replaced results and held once per result; it ends when the replaced set's bytes go back (after
/// its last lease) or its last holder lets go, and only a comparison of the same two inputs may be replaced. Each store
/// sets its own packing, so the figures hold in the packed pass too.</summary>
internal static partial class DiffChecks
{
    private static void AllowanceChecks(Action<bool, string> check)
    {
        AllowanceLimits(check);
        AllowanceLifetime(check);
        AllowanceHost(check);
    }

    /// <summary>Long names, every tenth price changed: a comparison whose rows dwarf the reservation step.</summary>
    private static string?[][] Bulky(int count, bool changed) =>
        [.. Enumerable.Range(1, count).Select(i => new[] { i.ToString(CultureInfo.InvariantCulture), new string((char)('a' + i % 26), 500), changed && i % 10 == 0 ? "9.00" : "1.00" })];

    /// <summary>Every limit reader sees an allowance: working memory on the request's and on worker threads, waits for
    /// room, spare memory, and an operation's rooms over a packed result, made fresh and taken from the pool.</summary>
    private static void AllowanceLimits(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.OnRequest };
        using var service = new SqlService(store);
        var (left, right) = Pair(store, Bulky(2000, false), Bulky(2000, true));
        var budget = left.Budget;
        var diff = Call<ResultsDiffResult>(service, "results.diff", new { left = left.ResultId, right = right.ResultId, context = -1 });
        var replaced = store.Find(diff.Descriptor.ResultId)!;
        // A packed result of the same query for the rooms: repeated text packs well.
        var packed = Fill(store, budget, 3, [.. Enumerable.Range(0, 4000).Select(i => new[] { i.ToString(CultureInfo.InvariantCulture), new string('p', 400), "1.00" })]);
        packed.Pack();
        var other = Call<ResultsDiffResult>(service, "results.diff", new { left = right.ResultId, right = left.ResultId, context = 0 });
        var second = store.Find(other.Descriptor.ResultId)!;
        var bare = store.ChargeOf(replaced);
        var sorted = Call<ResultsViewResult>(service, "results.view", new { resultId = replaced.ResultId, sort = new[] { new { column = 0, descending = true, mode = "value" } } });
        var charge = store.ChargeOf(replaced);
        check(bare > 1L << 20 && charge == bare + store.FindView(replaced.ResultId, sorted.ViewId)!.Charged && charge > bare,
            $"a result's charge counts its own bytes and its views': {bare} + view = {charge}");

        // The query's limit is now exactly what it holds: nothing more fits.
        store.Resize(1L << 30, budget.UsedBytes);
        var chunk = charge / 8;
        bool Rooms()
        {
            using var pin = packed.Pin();
            var rooms = PageRooms.Over(packed.SealedSnapshot(), packed.Wires.Count, () => new RequestException("TOO_LARGE", "rooms"))!;
            try { rooms.Rent().Dispose(); return true; }
            catch (RequestException) { return false; }
            finally { rooms.Dispose(); }
        }
        bool Threads()
        {
            var granted = new bool[4];
            Parallel.For(0, 4, new ParallelOptions { MaxDegreeOfParallelism = 4 }, i => granted[i] = Task.Run(() => store.TryReserveWork(budget, chunk)).GetAwaiter().GetResult());
            foreach (var given in granted) if (given) store.Return(budget, chunk);
            return granted.All(given => given);
        }
        var before = (Work: store.TryReserveWork(budget, chunk), Wait: store.WaitForRoomAsync(budget, chunk, waitMs: 0).GetAwaiter().GetResult(), Spare: store.HasSpare(budget),
            Taken: store.TryReserveSpare(budget, 1024), Threads: Threads(), Rooms: Rooms());
        check(before == (false, false, false, false, false, false), "at a full query limit no reader grants anything: " + before);

        var used = budget.UsedBytes;
        var hold = store.Allow(budget, replaced)!;
        var made = store.Rooms.Made;
        var after = (Work: store.TryReserveWork(budget, chunk), Wait: store.WaitForRoomAsync(budget, chunk, waitMs: 0).GetAwaiter().GetResult(), Spare: store.HasSpare(budget),
            Taken: store.TryReserveSpare(budget, 1024), Threads: Threads(), Rooms: Rooms());
        store.Return(budget, chunk);
        store.Return(budget, 1024);
        var reused = store.Rooms.Reused;
        var pooled = Rooms();
        check(after == (true, true, true, true, true, true) && store.Rooms.Made > made && pooled && store.Rooms.Reused > reused,
            $"an allowance raises every limit reader by the replaced result's charge: working memory on the request's and worker threads, a wait for room, spare memory, and rooms made and pooled: {after}");
        check(hold.Bytes == charge && budget.AllowedBytes == charge && store.QueryLimit(budget) == used + charge && budget.UsedBytes == used && store.UsedBytes <= store.GlobalBytes,
            "the allowance is the whole charge, raises the query's limit by it and charges nothing itself");

        // The global budget is not raised.
        store.Resize(store.UsedBytes, budget.UsedBytes);
        check(!store.TryReserveWork(budget, chunk), "an allowance does not raise the global budget");
        store.Resize(1L << 30, budget.UsedBytes);

        // Another replaced result's allowance adds to it; a second replace of the same one holds it, not a second grant.
        var otherCharge = store.ChargeOf(second);
        var again = store.Allow(budget, replaced)!;
        var summed = store.Allow(budget, second)!;
        check(budget.AllowanceCount == 2 && budget.AllowedBytes == charge + otherCharge, $"allowances of different results add up; one result's is granted once: {budget.AllowedBytes} = {charge} + {otherCharge}");
        hold.Dispose();
        hold.Dispose();
        check(budget.AllowanceCount == 2 && budget.AllowedBytes == charge + otherCharge, "a holder's drop (disposed twice, dropped once) leaves the allowance while another holds it");
        again.Dispose();
        summed.Dispose();
        check(budget.AllowanceCount == 0 && budget.AllowedBytes == 0 && store.QueryLimit(budget) == used && !store.TryReserveWork(budget, chunk),
            "the last holder's drop ends the allowance: the limit is the query's half again");
    }

    /// <summary>The allowance outlives the replace's holders while the replaced set is leased, ends when its bytes go back,
    /// and none is granted for a set already freed.</summary>
    private static void AllowanceLifetime(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.Off };
        using var service = new SqlService(store);
        var (left, right) = Pair(store, Bulky(200, false), Bulky(200, true));
        var budget = left.Budget;
        var diff = Call<ResultsDiffResult>(service, "results.diff", new { left = left.ResultId, right = right.ResultId, context = -1 });
        var replaced = store.Find(diff.Descriptor.ResultId)!;
        var hold = store.Allow(budget, replaced)!;
        var charge = hold.Bytes;
        check(replaced.TryLease() && store.Release(replaced.ResultId) && budget.AllowedBytes == charge && budget.AllowanceCount == 1,
            "a released result still leased keeps its bytes and so the allowance for them");
        replaced.ReleaseLease();
        check(budget.AllowedBytes == 0 && budget.AllowanceCount == 0, "the last lease's end frees the replaced result and ends its allowance, though a replace still holds it");
        hold.Dispose();
        check(budget.AllowedBytes == 0 && budget.AllowanceCount == 0, "a holder let go after the end changes nothing");
        check(store.Allow(budget, replaced) is null && budget.AllowanceCount == 0, "no allowance is granted for a result already freed");
    }

    /// <summary>results.diff's replaces: refused for anything but a comparison of the same two inputs (either way round),
    /// lets a comparison the query's limit could not hold beside the old one be written, keeps the allowance with the new
    /// set until either is released, lets it go when the replace fails, and leaves the other refusals their codes.</summary>
    private static void AllowanceHost(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29) { Packing = PagePacking.Off };
        using var service = new SqlService(store);
        var (left, right) = Pair(store, Bulky(2000, false), Bulky(2000, true));
        var third = Fill(store, left.Budget, 2, Bulky(10, false));
        var budget = left.Budget;
        object Args(uint l, uint r, uint? replaces, int context = -1, string? layout = null) =>
            replaces is { } id ? new { left = l, right = r, context, layout, replaces = id } : new { left = l, right = r, context, layout };
        var first = Call<ResultsDiffResult>(service, "results.diff", Args(left.ResultId, right.ResultId, null));
        var unrelated = Call<ResultsDiffResult>(service, "results.diff", Args(left.ResultId, third.ResultId, null));
        store.Release(unrelated.Descriptor.ResultId);
        var unrelatedLive = Call<ResultsDiffResult>(service, "results.diff", Args(left.ResultId, third.ResultId, null, 0));
        var elsewhere = Pair(store, Bulky(5, false), Bulky(5, true));
        var elsewhereDiff = Call<ResultsDiffResult>(service, "results.diff", Args(elsewhere.Left.ResultId, elsewhere.Right.ResultId, null));
        string? Code(object args) => Refusal(service, "results.diff", args)?.Split(':')[0];
        var codes = (Rows: Code(Args(left.ResultId, right.ResultId, left.ResultId)), Gone: Code(Args(left.ResultId, right.ResultId, unrelated.Descriptor.ResultId)),
            Inputs: Code(Args(left.ResultId, right.ResultId, unrelatedLive.Descriptor.ResultId)), Query: Code(Args(left.ResultId, right.ResultId, elsewhereDiff.Descriptor.ResultId)));
        check(codes == ("INVALID_PARAMS", "RESULT_RELEASED", "INVALID_PARAMS", "INVALID_PARAMS") && budget.AllowanceCount == 0,
            "replaces must name a comparison of the same two results of the same query that is still there: " + codes);
        store.Release(unrelatedLive.Descriptor.ResultId);
        store.Release(elsewhereDiff.Descriptor.ResultId);
        store.Release(elsewhere.Left.ResultId);
        store.Release(elsewhere.Right.ResultId);

        var old = store.Find(first.Descriptor.ResultId)!;
        var charge = store.ChargeOf(old);
        // Room for a comparison's alignment and index and some slack, but not for its rows beside the old one's.
        var working = ResultDiffer.WorkingBytes(2000, 2000) + ResultDiffer.CellChunk * ResultDiffer.CellBytes + DiffIndex.BytesFor(2000, 0) + 4 * ResultStore.ReserveStep;
        store.Resize(1L << 30, budget.UsedBytes + working);
        var without = Code(Args(left.ResultId, right.ResultId, null));
        check(without == "DIFF_ROWS_TOO_LARGE" && budget.AllowanceCount == 0 && budget.Stopped == TruncationReason.None,
            "without replaces, an All rows comparison beside the old one is refused DIFF_ROWS_TOO_LARGE: " + without);
        var used = budget.UsedBytes;
        store.Resize(1L << 30, used);
        var failed = Code(Args(left.ResultId, right.ResultId, old.ResultId));
        check(failed == "DIFF_ROWS_TOO_LARGE" && budget.AllowanceCount == 0 && budget.AllowedBytes == 0 && budget.UsedBytes == used,
            "a replace refused even under its allowance lets the allowance go and keeps nothing: " + failed);
        store.Resize(1L << 30, used + working);
        var replaced = Call<ResultsDiffResult>(service, "results.diff", Args(right.ResultId, left.ResultId, old.ResultId, -1, "entry"));
        var kept = store.Find(replaced.Descriptor.ResultId)!;
        check(replaced.Layout == "entry" && budget.AllowanceCount == 1 && budget.AllowedBytes == charge && kept.DiffInputs == (right.ResultId, left.ResultId),
            "a replace (of the swapped inputs, in the other layout) is written under the old comparison's charge, which its set keeps");
        // A re-filter and a sort of the new comparison while the old one is held are not refused.
        var filtered = Call<ResultsViewResult>(service, "results.view", new { resultId = kept.ResultId, sort = new[] { new { column = 0, descending = true, mode = "value" } }, filters = new[] { new { op = "kind", kinds = new[] { "changed" } } } });
        check(filtered.Rows == 200, "a re-filter of the new comparison while the old one is held is not refused: " + filtered.Rows);
        var stillOld = store.Find(old.ResultId) is not null;
        store.Release(old.ResultId);
        check(stillOld && budget.AllowanceCount == 0 && budget.AllowedBytes == 0 && store.Find(kept.ResultId) is not null,
            "releasing the old comparison ends the allowance; the new one stays");

        // Released the other way round: the new set's free lets its hold go.
        store.Resize(1L << 30, 1L << 29);
        var oldAgain = Call<ResultsDiffResult>(service, "results.diff", Args(left.ResultId, right.ResultId, kept.ResultId, 0));
        check(budget.AllowanceCount == 1, "a replace's set keeps its allowance");
        store.Release(oldAgain.Descriptor.ResultId);
        check(budget.AllowanceCount == 0 && budget.AllowedBytes == 0 && store.Find(kept.ResultId) is not null, "releasing the new comparison first lets its hold go, ending the allowance");
        store.Release(kept.ResultId);
    }
}
