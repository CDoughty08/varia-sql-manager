using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>results.visibility: ResultVisibility's bookkeeping (the visible set, hidden-since times, order, releases,
/// bounds) and the method through SqlService and the protocol host (its lane, its bounds, and results.close forgetting
/// released results).</summary>
internal static class VisibilityChecks
{
    public static void Run(Action<bool, string> check)
    {
        Bookkeeping(check);
        Bounds(check);
        Dispatcher(check);
    }

    private static void Bookkeeping(Action<bool, string> check)
    {
        var stored = new HashSet<uint> { 1, 2, 3, 4 };
        long clock = 1000;
        var visibility = new ResultVisibility(stored.Contains, () => clock);
        var source = Guid.NewGuid();
        long seq = 0;
        int Set(params uint[] ids) => visibility.Set(source, ++seq, ids, out var kept) ? kept : -1;

        // Nothing sent yet: a stored result counts as hidden from the first time it is asked about.
        check(visibility.IsHidden(1, out var since) && since == 1000 && visibility.TrackedCount == 1, "a stored result never shown is hidden from the first time it is asked about");
        clock = 1500;
        check(visibility.IsHidden(1, out since) && since == 1000, "asking again keeps the first hidden-since time");

        check(Set(1, 2, 99) == 2 && visibility.VisibleCount == 2 && !visibility.IsHidden(1, out since) && since == 0 && !visibility.IsHidden(2, out _) && visibility.TrackedCount == 0,
            "a set makes its stored results visible, ignores ids that are not stored, and clears their hidden-since times");
        clock = 2000;
        check(Set(2) == 1 && visibility.IsHidden(1, out since) && since == 2000 && !visibility.IsHidden(2, out _),
            "a result that leaves the set is hidden from the time of that set");
        clock = 2500;
        Set(2);
        check(visibility.IsHidden(1, out since) && since == 2000, "the same set again changes no hidden-since time");
        clock = 3000;
        check(Set() == 0 && visibility.IsHidden(2, out since) && since == 3000 && visibility.IsHidden(1, out since) && since == 2000, "an empty set hides every result");

        // Order: a set older than the last one applied (a late control request) changes nothing; a new renderer load's
        // first set is applied whatever its number.
        check(!visibility.Set(source, seq, [1], out var kept) && kept == 0 && !visibility.Set(source, seq - 1, [1], out _) && visibility.IsHidden(1, out _),
            "a set whose number is not above the last applied one is ignored");
        source = Guid.NewGuid();
        seq = 1;
        check(visibility.Set(source, seq, [1], out kept) && kept == 1 && !visibility.IsHidden(1, out _), "a new source's first set is applied");

        // Releases: results.close forgets at once, and anything else released goes when asked about or by a sweep.
        Set(3);
        visibility.Forget([1, 3]);
        check(visibility.VisibleCount == 0 && visibility.TrackedCount == 1, "Forget drops released results from both sets: " + visibility.TrackedCount);
        stored.Remove(2);
        check(!visibility.IsHidden(2, out since) && since == 0 && visibility.TrackedCount == 0, "a released result is neither hidden nor visible, and its entry goes");
        visibility.Clear();
        check(visibility.VisibleCount == 0 && visibility.TrackedCount == 0 && visibility.IsHidden(4, out _), "Clear forgets everything");
    }

    /// <summary>A set keeps at most MaxResults ids. Hidden-since entries are never evicted by age: a store holding more
    /// hidden results than any fixed bound keeps every first time, so a policy that sweeps them in order still sees them
    /// age (an age bound made each miss evict the next, and none ever reached its delay). Released results' entries are
    /// swept once the table doubles, at an amortized cost.</summary>
    private static void Bounds(Action<bool, string> check)
    {
        long clock = 0;
        var source = Guid.NewGuid();
        var total = ResultVisibility.SweepFloor * 20;
        var stored = new HashSet<uint>(Enumerable.Range(1, total).Select(id => (uint)id));
        var lookups = 0;
        var visibility = new ResultVisibility(id => { lookups++; return stored.Contains(id); }, () => clock);
        check(visibility.Set(source, 1, stored.Take(ResultVisibility.MaxResults + 5), out var kept) && kept == ResultVisibility.MaxResults, "a set keeps at most MaxResults ids");
        visibility.Set(source, 2, [], out _);
        clock = 10_000;
        for (uint id = 1; id <= total; id++) visibility.IsHidden(id, out _);
        clock = 20_000;
        var aged = Enumerable.Range(1, total).All(id => visibility.IsHidden((uint)id, out var at) && at == (id <= ResultVisibility.MaxResults ? 0 : 10_000));
        check(aged && visibility.TrackedCount == total, "every stored hidden result keeps its first time, however many there are: " + visibility.TrackedCount);
        foreach (var id in Enumerable.Range(1, total - 10)) stored.Remove((uint)id);
        lookups = 0;
        // New results arrive and are asked about until the table doubles and a sweep runs.
        for (var id = (uint)total + 1; id <= (uint)total * 2; id++) { stored.Add(id); visibility.IsHidden(id, out _); }
        check(visibility.TrackedCount == total + 10 && lookups < total * 4,
            "a sweep drops released results' entries once the table doubles, at an amortized cost: " + visibility.TrackedCount + " entries, " + lookups + " lookups");
    }

    private static void Dispatcher(Action<bool, string> check)
    {
        var json = HostChecks.Json;
        using var service = new SqlService(new ResultStore(1L << 30, 1L << 29), hooks: true);
        var source = Guid.NewGuid().ToString();
        var seq = 0;
        uint Synthesize() => ((ResultDescriptor)service.DispatchAsync(SqlService.SynthesizeMethod, JsonSerializer.SerializeToElement(new { shape = "W1", rows = 100 }, json), json).GetAwaiter().GetResult()).ResultId;
        ResultsVisibilityResult Send(object parameters) => (ResultsVisibilityResult)service.DispatchAsync("results.visibility", JsonSerializer.SerializeToElement(parameters, json), json).GetAwaiter().GetResult();
        ResultsVisibilityResult Shown(params uint[] visible) => Send(new { source, seq = ++seq, visible });
        var first = Synthesize();
        var second = Synthesize();
        check(SqlService.MethodNames.Contains("results.visibility") && service.LaneOf("results.visibility") == RequestLane.Control, "results.visibility is announced and answered on the control lane");
        check(Shown(first, 4242u) is { Visible: 1, Applied: true } && !service.Visibility.IsHidden(first, out _) && service.Visibility.IsHidden(second, out _),
            "results.visibility records the shown results; unknown ids are ignored and the others are hidden");
        check(Shown().Visible == 0 && service.Visibility.IsHidden(first, out _), "an empty set hides them all");
        check(Send(new { source, seq, visible = new[] { first } }) is { Applied: false, Visible: 0 } && service.Visibility.IsHidden(first, out _), "a late set is answered as not applied and changes nothing");
        Shown(first);
        service.DispatchAsync("results.close", JsonSerializer.SerializeToElement(new { resultIds = new[] { first } }, json), json).GetAwaiter().GetResult();
        check(service.Visibility.VisibleCount == 0 && !service.Visibility.IsHidden(first, out _), "results.close forgets the released result");

        // The bounds, through the protocol host, so its own mapping of malformed parameters (unknown members, out-of-range
        // numbers) to INVALID_PARAMS is what is checked.
        using var host = new HostHarness(dispatcher: () => new SqlService(new ResultStore(1L << 30, 1L << 29)));
        host.Hello();
        uint request = 0;
        string? Code(object parameters)
        {
            host.Request(++request, "results.visibility", parameters);
            var body = JsonBridge.ParseControl(host.Next(FrameKind.Response, 15_000)!.Value.Body);
            return body.TryGetProperty("error", out var error) ? error.GetProperty("code").GetString() : null;
        }
        var most = Enumerable.Range(1, ResultVisibility.MaxResults).Select(id => (uint)id).ToArray();
        var refused = new object[]
        {
            new { source, seq = 1, visible = new[] { 2u, 2u } }, new { source, seq = 1, visible = new[] { 0u } }, new { source, seq = 1, visible = most.Append((uint)most.Length + 1).ToArray() },
            new { source, seq = 1 }, new { seq = 1, visible = most }, new { source = "tab-1", seq = 1, visible = most }, new { source, visible = most }, new { source, seq = 0, visible = most },
            new { source, seq = 1L << 31, visible = most }, new { source, seq = 1, visible = new[] { -1L } }, new { source, seq = 1, visible = new[] { 1L << 32 } },
            new { source, seq = 1, visible = new[] { 1u }, generation = 1 }
        };
        var codes = refused.Select(Code).ToList();
        check(codes.All(code => code == "INVALID_PARAMS") && Code(new { source, seq = 2, visible = most }) is null,
            "results.visibility takes a UUID source, a sequence number from 1 to 2^31 - 1 and at most MaxResults distinct non-zero ids, and nothing else: " + string.Join(",", codes));
    }
}
