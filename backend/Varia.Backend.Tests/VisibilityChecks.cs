using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>results.visibility: ResultVisibility's bookkeeping (the visible set, hidden-since times, releases, bounds) and
/// the method through SqlService (its lane, its bounds, and results.close forgetting released results).</summary>
internal static class VisibilityChecks
{
    public static void Run(Action<bool, string> check)
    {
        Bookkeeping(check);
        Dispatcher(check);
    }

    private static void Bookkeeping(Action<bool, string> check)
    {
        var stored = new HashSet<uint> { 1, 2, 3, 4 };
        long clock = 1000;
        var visibility = new ResultVisibility(stored.Contains, () => clock);

        // Nothing sent yet: a stored result counts as hidden from the first time it is asked about.
        check(visibility.IsHidden(1, out var since) && since == 1000 && visibility.TrackedCount == 1, "a stored result never shown is hidden from the first time it is asked about");
        clock = 1500;
        check(visibility.IsHidden(1, out since) && since == 1000, "asking again keeps the first hidden-since time");

        check(visibility.Set([1, 2, 99]) == 2 && visibility.VisibleCount == 2 && !visibility.IsHidden(1, out since) && since == 0 && !visibility.IsHidden(2, out _) && visibility.TrackedCount == 0,
            "a set makes its stored results visible, ignores ids that are not stored, and clears their hidden-since times");
        clock = 2000;
        check(visibility.Set([2]) == 1 && visibility.IsHidden(1, out since) && since == 2000 && !visibility.IsHidden(2, out _),
            "a result that leaves the set is hidden from the time of that set");
        clock = 2500;
        visibility.Set([2]);
        check(visibility.IsHidden(1, out since) && since == 2000, "the same set again changes no hidden-since time");
        clock = 3000;
        check(visibility.Set([]) == 0 && visibility.IsHidden(2, out since) && since == 3000 && visibility.IsHidden(1, out since) && since == 2000, "an empty set hides every result");

        // Releases: results.close forgets at once, and anything else released goes at the next set or question.
        visibility.Set([3]);
        visibility.Forget([1, 3]);
        check(visibility.VisibleCount == 0 && visibility.TrackedCount == 1, "Forget drops released results from both sets: " + visibility.TrackedCount);
        stored.Remove(2);
        check(!visibility.IsHidden(2, out since) && since == 0 && visibility.TrackedCount == 0, "a released result is neither hidden nor visible, and its entry goes");
        stored.Add(5);
        visibility.Set([5]);
        visibility.Set([]);
        stored.Remove(5);
        visibility.Set([4]);
        check(visibility.TrackedCount == 0 && visibility.VisibleCount == 1, "a set drops the hidden-since times of results released since");
        visibility.Clear();
        check(visibility.VisibleCount == 0 && visibility.TrackedCount == 0 && visibility.IsHidden(4, out _), "Clear forgets everything");

        // Bounds: a set keeps at most MaxResults ids, and the hidden-since entries at most MaxTracked, the longest hidden going first.
        var many = new HashSet<uint>(Enumerable.Range(1, ResultVisibility.MaxTracked + 10).Select(id => (uint)id));
        var bounded = new ResultVisibility(many.Contains, () => clock);
        check(bounded.Set(many.Take(ResultVisibility.MaxResults + 5)) == ResultVisibility.MaxResults, "a set keeps at most MaxResults ids");
        bounded.Set([]);
        for (uint id = 1; id <= ResultVisibility.MaxTracked + 10; id++) { clock = 10_000 + id; bounded.IsHidden(id, out _); }
        check(bounded.TrackedCount == ResultVisibility.MaxTracked && bounded.IsHidden((uint)ResultVisibility.MaxTracked + 10, out since) && since == 10_000 + ResultVisibility.MaxTracked + 10,
            "hidden-since entries stay within MaxTracked: " + bounded.TrackedCount);
        clock = 50_000;
        check(bounded.IsHidden(1, out since) && since == 50_000 && bounded.TrackedCount == ResultVisibility.MaxTracked, "the longest hidden went first, and starts again when asked about");
        check(ResultVisibility.MaxResults == 4096, "MaxResults matches src/shared/ipc/wire/protocol.ts limits.visibility.maxResults");
    }

    private static void Dispatcher(Action<bool, string> check)
    {
        var json = HostChecks.Json;
        using var service = new SqlService(new ResultStore(1L << 30, 1L << 29), hooks: true);
        uint Synthesize() => ((ResultDescriptor)service.DispatchAsync(SqlService.SynthesizeMethod, JsonSerializer.SerializeToElement(new { shape = "W1", rows = 100 }, json), json).GetAwaiter().GetResult()).ResultId;
        ResultsVisibilityResult Send(object parameters) => (ResultsVisibilityResult)service.DispatchAsync("results.visibility", JsonSerializer.SerializeToElement(parameters, json), json).GetAwaiter().GetResult();
        string? Code(object parameters)
        {
            try { Send(parameters); return null; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "INVALID_PARAMS"; }
        }
        var first = Synthesize();
        var second = Synthesize();
        check(SqlService.MethodNames.Contains("results.visibility") && service.LaneOf("results.visibility") == RequestLane.Control, "results.visibility is announced and answered on the control lane");
        check(Send(new { visible = new[] { first, 4242u } }).Visible == 1 && !service.Visibility.IsHidden(first, out _) && service.Visibility.IsHidden(second, out _),
            "results.visibility records the shown results; unknown ids are ignored and the others are hidden");
        check(Send(new { visible = Array.Empty<uint>() }).Visible == 0 && service.Visibility.IsHidden(first, out _), "an empty set hides them all");
        Send(new { visible = new[] { first } });
        service.DispatchAsync("results.close", JsonSerializer.SerializeToElement(new { resultIds = new[] { first } }, json), json).GetAwaiter().GetResult();
        check(service.Visibility.VisibleCount == 0 && !service.Visibility.IsHidden(first, out _), "results.close forgets the released result");
        check(Code(new { visible = new[] { second, second } }) == "INVALID_PARAMS" && Code(new { visible = new[] { 0u } }) == "INVALID_PARAMS"
            && Code(new { visible = Enumerable.Range(1, ResultVisibility.MaxResults + 1).Select(id => (uint)id).ToArray() }) == "INVALID_PARAMS" && Code(new { }) == "INVALID_PARAMS"
            && Code(new { visible = new[] { -1L } }) == "INVALID_PARAMS" && Code(new { visible = Enumerable.Range(1, ResultVisibility.MaxResults).Select(id => (uint)id).ToArray() }) is null,
            "results.visibility takes at most MaxResults distinct non-zero ids");
    }
}
