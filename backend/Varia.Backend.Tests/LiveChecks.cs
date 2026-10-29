using System.Text.Json;
using Varia.Backend.Live;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of live subscriptions: RequestContext's stop-and-wait credit, and live.subscribe and live.update
/// over ProtocolHost with the debug.synthetic source (test hooks), against main's rules in src/shared/live/schema.ts.</summary>
internal static class LiveChecks
{
    private const int Credit = 64 * 1024;
    private static JsonElement Body(Frame frame) => JsonBridge.ParseControl(frame.Body);
    private static string? ErrorCode(Frame? frame) => frame is { } value && Body(value).TryGetProperty("error", out var error) ? error.GetProperty("code").GetString() : null;
    private static JsonElement Result(Frame? frame) => frame is { } value ? Body(value).GetProperty("result") : default;

    public static async Task RunAsync(Action<bool, string> check)
    {
        await ContextChecks(check);
        CatalogChecks(check);
        StreamChecks(check);
        RequestChecks(check);
        RegistryChecks(check);
        EndChecks(check);
        BudgetChecks(check);
        await LaneChecks(check);
        await FixtureChecks(check);
    }

    private static async Task ContextChecks(Action<bool, string> check)
    {
        var sent = new List<object>();
        var length = 1000;
        using var context = new RequestContext(1, "live.subscribe", RequestLane.Live, 0, Credit, sendCreditedEvent: (_, value) => { sent.Add(value); return length; });
        var first = context.TrySendCreditedEvent("opened");
        var second = context.TrySendCreditedEvent("tick");
        var waiting = context.WaitForAckAsync(CancellationToken.None);
        await Task.Delay(50);
        var stalled = !waiting.IsCompleted;
        context.Grant(999);
        await Task.Delay(50);
        var partial = !waiting.IsCompleted;
        context.Grant(1);
        var acked = await Task.WhenAny(waiting, Task.Delay(2000)) == waiting;
        check(first && !second && stalled && partial && acked && context.TrySendCreditedEvent("tick") && sent.Count == 2,
            "a live EVENT is sent only while all of its initial credit is back, and the wait ends exactly when the outstanding frame is acknowledged");
        // A frame larger than the credit overdraws by that one frame, then still waits for all of it.
        context.Grant(1000);
        length = 100_000;
        var large = context.TrySendCreditedEvent("large");
        context.Grant(64 * 1024);
        check(large && !context.TrySendCreditedEvent("next") && context.WaitForAckAsync(CancellationToken.None) is { IsCompleted: false }, "a frame larger than the initial credit is sent once, and nothing follows until all of it is acknowledged");
        using var stop = new CancellationTokenSource();
        var cancelled = context.WaitForAckAsync(stop.Token);
        stop.Cancel();
        var woken = false;
        try { await cancelled.WaitAsync(TimeSpan.FromSeconds(2)); }
        catch (OperationCanceledException) { woken = true; }
        context.Cancel(CancelReason.User);
        var refused = false;
        try { context.TrySendCreditedEvent("after"); }
        catch (OperationCanceledException) { refused = true; }
        check(woken && refused, "cancellation wakes a wait for the acknowledgement, and a cancelled subscription sends nothing more");

        using var oversized = new RequestContext(2, "live.subscribe", RequestLane.Live, 0, Credit, sendCreditedEvent: (_, _) => -1);
        var tooLarge = false;
        try { oversized.TrySendCreditedEvent("huge"); }
        catch (RequestException error) when (error.Code == "BACKEND_ERROR") { tooLarge = true; }
        using var unary = new RequestContext(3, "live.subscribe", RequestLane.Live, 0, sendCreditedEvent: (_, _) => 1);
        var notStream = false;
        try { unary.TrySendCreditedEvent("x"); }
        catch (InvalidOperationException) { notStream = true; }
        check(tooLarge && notStream, "a live frame over the event limit is a BACKEND_ERROR, never a silent drop, and only a stream sends credited EVENTs");
        check(LiveService.IsResumeToken("AAAA_-9z") && !LiveService.IsResumeToken("AAAA\n") && !LiveService.IsResumeToken("\nAAAA") && !LiveService.IsResumeToken("a=b") && !LiveService.IsResumeToken(""),
            "a resume token is base64url only, as main's pattern is: a trailing newline is refused");
    }

    private static void CatalogChecks(Action<bool, string> check)
    {
        var catalog = LiveCatalog.Current;
        check(catalog.Limits is { PortStreams: 16, BackendSubscriptions: 32, PerServer: 8, Probes: 8, InitialCredit: Credit, EventBody: ProtocolLimits.EventBody, FrameBudget: 192 * 1024 }
            && catalog.Sources.TryGetValue(SyntheticSampler.Source, out var source) && source.TestOnly
            && source.Probes.SequenceEqual([SyntheticSampler.MetricsProbe, SyntheticSampler.TableProbe, SyntheticSampler.StatusProbe, SyntheticSampler.GridProbe, SyntheticSampler.LogProbe, SyntheticSampler.WideProbe])
            && catalog.Probes[SyntheticSampler.TableProbe].Tables is [{ Mode: "snapshot", Key: ["id"], Columns.Count: 3 }],
            "the embedded live catalogue carries main's limits and the synthetic source's probes");
        using var service = new SqlService();
        check(service.LaneOf("live.subscribe") == RequestLane.Live && service.LaneOf("live.update") == RequestLane.Control
            && SqlService.MethodNames.Contains("live.subscribe") && SqlService.MethodNames.Contains("live.update"),
            "live.subscribe takes no slot (lane live) and live.update runs at once (control), and HELLO announces both");
    }

    private static object Subscribe(string id, string connection, string[]? probes = null, object? args = null) => new
    {
        subscriptionId = id, connectionId = connection, source = SyntheticSampler.Source,
        probes = (probes ?? [SyntheticSampler.TableProbe, SyntheticSampler.MetricsProbe, SyntheticSampler.StatusProbe]).Select(probe => new { probe, intervalMs = 1000 }).ToArray(),
        args = args ?? new { tickMs = 20 }
    };

    /// <summary>The next live EVENT of a request, after acknowledging the previous one.</summary>
    private static JsonElement? Next(HostHarness host, uint id, ref Frame? previous)
    {
        if (previous is { } frame) host.Send(FrameKind.Credit, id, (uint)frame.Body.Length, []);
        previous = host.Next(FrameKind.Event);
        return previous is { } next && next.Header.Id == id ? Body(next) : null;
    }

    private static ResultSetBuffer? Stored(ResultStore store, JsonElement table) => store.Find(table.GetProperty("descriptor").GetProperty("resultId").GetUInt32());

    private static void StreamChecks(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        using var host = new HostHarness(dispatcher: () => new SqlService(store, hooks: true));
        host.Hello();
        var subscription = Guid.NewGuid().ToString();
        // 200 ms between samples: tick 2 is not late unless an acknowledgement takes that long, even on a loaded machine.
        host.Request(1, "live.subscribe", Subscribe(subscription, Guid.NewGuid().ToString(), args: new { tickMs = 200 }), credit: Credit);
        Frame? frame = null;
        var opened = Next(host, 1, ref frame);
        // Nothing more until the opened frame is acknowledged.
        var early = host.Next(FrameKind.Event, 300);
        check(opened is { } value && value.GetProperty("type").GetString() == "live.opened" && value.GetProperty("seq").GetInt64() == 0 && value.GetProperty("probes").GetArrayLength() == 3
            && value.GetProperty("probes")[0].GetProperty("state").GetString() == "ok" && early is null,
            "a subscription opens with live.opened (seq 0) and sends nothing more until it is acknowledged");
        var ticks = new List<JsonElement>();
        for (var i = 0; i < 3; i++) if (Next(host, 1, ref frame) is { } tick) ticks.Add(tick);
        var tables = ticks.Select(tick => tick.GetProperty("samples").EnumerateArray().First(sample => sample.GetProperty("probe").GetString() == SyntheticSampler.TableProbe).GetProperty("tables")[0]).ToList();
        check(ticks.Count == 3 && ticks.Select(tick => tick.GetProperty("seq").GetInt64()).SequenceEqual([1L, 2L, 3L])
            && ticks[0].GetProperty("samples").EnumerateArray().All(sample => sample.GetProperty("gap").GetString() == "baseline" && !sample.TryGetProperty("elapsedMs", out _) && !sample.TryGetProperty("skipped", out _))
            && ticks[1].GetProperty("samples").EnumerateArray().All(sample => !sample.TryGetProperty("gap", out _) && sample.GetProperty("elapsedMs").GetInt64() >= 0)
            && ticks[0].GetProperty("samples").EnumerateArray().First(sample => sample.GetProperty("probe").GetString() == SyntheticSampler.MetricsProbe).GetProperty("metrics")[2].ValueKind == JsonValueKind.Null
            && ticks[1].GetProperty("sampledAt").GetInt64() > ticks[0].GetProperty("sampledAt").GetInt64(),
            "each acknowledged tick carries every due probe once, the first marked baseline with no rate, the later ones with their measured interval");
        check(tables.Select(table => table.GetProperty("revision").GetInt64()).SequenceEqual([1L, 2L, 3L]) && !tables[1].TryGetProperty("retired", out _)
            && tables[2].GetProperty("retired")[0].GetUInt32() == tables[0].GetProperty("descriptor").GetProperty("resultId").GetUInt32()
            && Stored(store, tables[0]) is null && Stored(store, tables[1]) is { IsComplete: true } && Stored(store, tables[2]) is { IsComplete: true, RowsAvailable: 3 }
            && tables[2].GetProperty("diff").GetProperty("added").GetInt32() == 1 && tables[2].GetProperty("diff").GetProperty("removed").GetInt32() == 1,
            "a snapshot keeps two revisions: the third retires the first, which the store releases, and its diff counts the row that left and the one that came");

        // Sort and tracking: the next revision's rows by value descending, and where its first id went.
        host.Request(2, "live.update", new
        {
            subscriptionId = subscription, source = SyntheticSampler.Source,
            probes = new[] { new { probe = SyntheticSampler.TableProbe, sort = new[] { new { column = "id", descending = true } } } },
            track = new[] { new { probe = SyntheticSampler.TableProbe, table = 0, seq = 7, keys = new[] { "4", "1" } } }
        });
        var updated = host.Next(FrameKind.Response);
        var sorted = Next(host, 1, ref frame);
        var sortedTable = sorted?.GetProperty("samples").EnumerateArray().First(sample => sample.GetProperty("probe").GetString() == SyntheticSampler.TableProbe).GetProperty("tables")[0];
        var set = sortedTable is { } t ? Stored(store, t) : null;
        var page = set?.PagesFor(0, 10) is [{ } stored] ? PageReader.Read(stored.Body, set.Wires) : null;
        check(updated?.Header.Id == 2 && Result(updated).GetProperty("applied").GetBoolean() && sortedTable?.GetProperty("revision").GetInt64() == 4
            && page?.Rows.Select(row => row[0].Text).SequenceEqual(["6", "5", "4"]) == true
            && sortedTable?.GetProperty("tracked").GetProperty("seq").GetInt32() == 7 && sortedTable?.GetProperty("tracked").GetProperty("rows").EnumerateArray().Select(row => row.GetInt32()).SequenceEqual([2, -1]) == true,
            "an update's sort orders the next revision, and its track list finds each key, the stored cell text, at its new row (−1 when gone)");

        // Clearing the sort returns the next revision to the source's own order.
        host.Request(20, "live.update", new { subscriptionId = subscription, source = SyntheticSampler.Source, probes = new[] { new { probe = SyntheticSampler.TableProbe, clear = new[] { "sort" } } } });
        var cleared = host.Next(FrameKind.Response);
        var unsorted = Next(host, 1, ref frame)?.GetProperty("samples").EnumerateArray().First(sample => sample.GetProperty("probe").GetString() == SyntheticSampler.TableProbe).GetProperty("tables")[0];
        var plainSet = unsorted is { } u ? Stored(store, u) : null;
        var plainPage = plainSet?.PagesFor(0, 10) is [{ } plainStored] ? PageReader.Read(plainStored.Body, plainSet.Wires) : null;
        check(cleared?.Header.Id == 20 && Result(cleared).GetProperty("applied").GetBoolean() && unsorted?.GetProperty("revision").GetInt64() == 5
            && plainPage?.Rows.Select(row => row[0].Text).SequenceEqual(["5", "6", "7"]) == true, "an update's clear drops the probe's sort: the next revision is in the source's order");

        // Pause stops sampling; resuming marks the next samples resumed.
        host.Request(3, "live.update", new { subscriptionId = subscription, source = SyntheticSampler.Source, paused = true });
        var pause = host.Next(FrameKind.Response);
        host.Send(FrameKind.Credit, 1, (uint)frame!.Value.Body.Length, []);
        var quiet = host.Next(FrameKind.Event, 300);
        host.Request(4, "live.update", new { subscriptionId = subscription, source = SyntheticSampler.Source, paused = false });
        var resume = host.Next(FrameKind.Response);
        frame = host.Next(FrameKind.Event);
        check(pause?.Header.Id == 3 && Result(pause).GetProperty("probes").EnumerateArray().All(probe => probe.GetProperty("paused").GetBoolean()) && quiet is null
            && resume?.Header.Id == 4 && frame is { } resumed && Body(resumed).GetProperty("samples").EnumerateArray().All(sample => sample.GetProperty("gap").GetString() == "resumed"),
            "a paused subscription samples nothing, and its first samples after resuming are marked resumed");

        // One probe paused: the others go on.
        host.Request(5, "live.update", new { subscriptionId = subscription, source = SyntheticSampler.Source, probes = new[] { new { probe = SyntheticSampler.MetricsProbe, paused = true } } });
        host.Next(FrameKind.Response);
        var partial = Next(host, 1, ref frame);
        check(partial?.GetProperty("samples").EnumerateArray().Select(sample => sample.GetProperty("probe").GetString()).OrderBy(probe => probe, StringComparer.Ordinal)
            .SequenceEqual([SyntheticSampler.StatusProbe, SyntheticSampler.TableProbe]) == true, "a paused probe is left out while the others keep sampling");

        // A user cancel answers ended cancelled after the last event, on the control lane, and releases every revision.
        var last = frame;
        host.Send(FrameKind.Cancel, 1, 1, []);
        var end = host.Next(FrameKind.Response);
        check(end?.Header.Id == 1 && Result(end).GetProperty("ended").GetString() == "cancelled" && Result(end).GetProperty("ticks").GetInt64() >= 6
            && !Result(end).TryGetProperty("kept", out _) && host.ArrivalOf(end.Value) > host.ArrivalOf(last!.Value) && store.Count == 0,
            "CANCEL ends a subscription with its answer (ended cancelled, its tick count) after its last event, and releases its results");
        host.Request(6, "live.update", new { subscriptionId = subscription, source = SyntheticSampler.Source, paused = true });
        check(ErrorCode(host.Next(FrameKind.Response)) == "NOT_FOUND", "an update of an ended subscription is NOT_FOUND");
    }

    private static void RequestChecks(Action<bool, string> check)
    {
        using var host = new HostHarness(dispatcher: () => new SqlService(new ResultStore(1L << 30, 1L << 29), hooks: true));
        host.Hello();
        var connection = Guid.NewGuid().ToString();
        uint id = 100;
        string? Refused(object parameters, long? credit = Credit)
        {
            host.Request(++id, "live.subscribe", parameters, credit: credit);
            return host.Next(FrameKind.Response) is { } answer && answer.Header.Id == id ? ErrorCode(answer) ?? "accepted" : "missing";
        }
        var probe = new { probe = SyntheticSampler.TableProbe, intervalMs = 1000 };
        object With(object? probes = null, object? args = null, string source = SyntheticSampler.Source, string? resume = null, string? subscription = null) =>
            new { subscriptionId = subscription ?? Guid.NewGuid().ToString(), connectionId = connection, source, probes = probes ?? new[] { probe }, args, resume };
        var refused = new Dictionary<string, string?>
        {
            ["no credit"] = Refused(With(), credit: null),
            ["unknown source"] = Refused(With(source: "activity")),
            ["no probes"] = Refused(With(probes: Array.Empty<object>())),
            ["nine probes"] = Refused(With(probes: Enumerable.Repeat(probe, 9).ToArray())),
            ["repeated probe"] = Refused(With(probes: new[] { probe, probe })),
            ["unknown probe"] = Refused(With(probes: new[] { new { probe = "activity.overview", intervalMs = 1000 } })),
            ["fast interval"] = Refused(With(probes: new[] { new { probe = SyntheticSampler.TableProbe, intervalMs = 999 } })),
            ["slow interval"] = Refused(With(probes: new[] { new { probe = SyntheticSampler.TableProbe, intervalMs = 3_600_001 } })),
            ["no interval"] = Refused(With(probes: new[] { new { probe = SyntheticSampler.TableProbe } })),
            ["unknown member"] = Refused(new { subscriptionId = Guid.NewGuid().ToString(), connectionId = connection, source = SyntheticSampler.Source, probes = new[] { probe }, extra = 1 }),
            ["probe member"] = Refused(With(probes: new[] { new { probe = SyntheticSampler.TableProbe, intervalMs = 1000, extra = 1 } })),
            ["args member"] = Refused(With(args: new { rows = 1, other = 1 })),
            ["args bound"] = Refused(With(args: new { rows = 10_001 })),
            ["args type"] = Refused(With(args: "rows")),
            ["resume"] = Refused(With(resume: "abc")),
            ["metrics sort"] = Refused(With(probes: new[] { new { probe = SyntheticSampler.MetricsProbe, intervalMs = 1000, sort = new[] { new { column = "id", descending = true } } } })),
            ["unknown sort"] = Refused(With(probes: new[] { new { probe = SyntheticSampler.TableProbe, intervalMs = 1000, sort = new[] { new { column = "nope", descending = true } } } })),
            ["view"] = Refused(With(probes: new[] { new { probe = SyntheticSampler.TableProbe, intervalMs = 1000, view = "blocked" } })),
            ["filter"] = Refused(With(probes: new[] { new { probe = SyntheticSampler.TableProbe, intervalMs = 1000, filter = new { text = "x" } } })),
            ["subscription id"] = Refused(With(subscription: "not-a-uuid")),
            ["clear"] = Refused(With(probes: new[] { new { probe = SyntheticSampler.TableProbe, intervalMs = 1000, clear = new[] { "sort" } } }))
        };
        check(refused.All(item => item.Value == "INVALID_PARAMS"), "live.subscribe refuses what main's schema refuses, as INVALID_PARAMS: "
            + string.Join(", ", refused.Where(item => item.Value != "INVALID_PARAMS").Select(item => item.Key + " " + item.Value)));

        var subscription = Guid.NewGuid().ToString();
        host.Request(200, "live.subscribe", Subscribe(subscription, connection, [SyntheticSampler.TableProbe]), credit: Credit);
        host.Next(FrameKind.Event);
        string? Update(object parameters)
        {
            host.Request(++id, "live.update", parameters);
            return host.Next(FrameKind.Response) is { } answer && answer.Header.Id == id ? ErrorCode(answer) ?? "accepted" : "missing";
        }
        var updates = new Dictionary<string, string?>
        {
            ["nothing"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source }),
            ["another source"] = Update(new { subscriptionId = subscription, source = "activity", paused = true }),
            ["unsubscribed probe"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, probes = new[] { new { probe = SyntheticSampler.MetricsProbe, paused = true } } }),
            ["refresh false"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, refresh = false }),
            ["track keys"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, track = new[] { new { probe = SyntheticSampler.TableProbe, table = 0, seq = 1, keys = Enumerable.Repeat("k", 65).ToArray() } } }),
            ["track key length"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, track = new[] { new { probe = SyntheticSampler.TableProbe, table = 0, seq = 1, keys = new[] { new string('k', 513) } } } }),
            ["track table"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, track = new[] { new { probe = SyntheticSampler.TableProbe, table = 1, seq = 1, keys = Array.Empty<string>() } } }),
            ["args"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, args = new { tickMs = 5 } }),
            ["track linger"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, track = new[] { new { probe = SyntheticSampler.TableProbe, table = 0, seq = 1, keys = new[] { "k" }, linger = 2 } } }),
            ["track linger sign"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, track = new[] { new { probe = SyntheticSampler.TableProbe, table = 0, seq = 1, keys = new[] { "k" }, linger = -1 } } }),
            ["sort table"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, probes = new[] { new { probe = SyntheticSampler.TableProbe, sort = new[] { new { column = "id", descending = true, table = 1 } } } } }),
            ["repeated table sort"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, probes = new[] { new { probe = SyntheticSampler.TableProbe, sort = new[] { new { column = "id", descending = true, table = 0 }, new { column = "id", descending = false, table = 0 } } } } }),
            ["track seq"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, track = new[] { new { probe = SyntheticSampler.TableProbe, table = 0, seq = 0, keys = Array.Empty<string>() } } }),
            ["unknown sort"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, probes = new[] { new { probe = SyntheticSampler.TableProbe, sort = new[] { new { column = "nope", descending = true } } } } }),
            ["repeated sort"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, probes = new[] { new { probe = SyntheticSampler.TableProbe, sort = new[] { new { column = "id", descending = true }, new { column = "id", descending = false } } } } }),
            ["view"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, probes = new[] { new { probe = SyntheticSampler.TableProbe, view = "blocked" } } }),
            ["filter"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, probes = new[] { new { probe = SyntheticSampler.TableProbe, filter = new { text = "x" } } } }),
            ["clear unknown"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, probes = new[] { new { probe = SyntheticSampler.TableProbe, clear = new[] { "rows" } } } }),
            ["clear twice"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, probes = new[] { new { probe = SyntheticSampler.TableProbe, clear = new[] { "sort", "sort" } } } }),
            ["clear empty"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, probes = new[] { new { probe = SyntheticSampler.TableProbe, clear = Array.Empty<string>() } } }),
            ["clear and set"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, probes = new[] { new { probe = SyntheticSampler.TableProbe, sort = new[] { new { column = "id", descending = true } }, clear = new[] { "sort" } } } })
        };
        check(updates.All(item => item.Value == "INVALID_PARAMS") && Update(new { subscriptionId = Guid.NewGuid().ToString(), source = SyntheticSampler.Source, paused = true }) == "NOT_FOUND"
            && Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, refresh = true, args = new { rows = 5 } }) == "accepted"
            && Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, probes = new[] { new { probe = SyntheticSampler.TableProbe, sort = new object[] { new { column = "id", descending = true, table = 0 }, new { column = "id", descending = false } } } }, track = new[] { new { probe = SyntheticSampler.TableProbe, table = 0, seq = 2, keys = new[] { "k" }, linger = 1 } } }) == "accepted",
            "live.update refuses what main's schema refuses and names only running subscriptions: " + string.Join(", ", updates.Where(item => item.Value != "INVALID_PARAMS").Select(item => item.Key + " " + item.Value)));

        using var plain = new HostHarness(dispatcher: () => new SqlService(new ResultStore(1L << 30, 1L << 29)));
        plain.Hello();
        plain.Request(1, "live.subscribe", Subscribe(Guid.NewGuid().ToString(), connection), credit: Credit);
        check(ErrorCode(plain.Next(FrameKind.Response)) == "INVALID_PARAMS", "without test hooks the synthetic source does not exist");
    }

    private static void RegistryChecks(Action<bool, string> check)
    {
        var service = new SqlService(new ResultStore(1L << 30, 1L << 29), hooks: true);
        using var host = new HostHarness(dispatcher: () => service);
        host.Hello();
        var connections = Enumerable.Range(0, 5).Select(_ => Guid.NewGuid().ToString()).ToArray();
        uint id = 0;
        var answers = new List<string?>();
        // Eight on the first connection, then a ninth.
        for (var i = 0; i < 9; i++) host.Request(++id, "live.subscribe", Subscribe(Guid.NewGuid().ToString(), connections[0], [SyntheticSampler.StatusProbe]), credit: Credit);
        // Requests run on their own tasks, so which one is refused is not fixed; how many is.
        var ninth = host.Next(FrameKind.Response);
        var perConnection = ninth?.Header.Id <= 9 && ErrorCode(ninth) == "BUSY" && SpinWait.SpinUntil(() => service.Live.Count == 8, 2000);
        for (var c = 1; c < 5; c++) for (var i = 0; i < 8; i++) host.Request(++id, "live.subscribe", Subscribe(Guid.NewGuid().ToString(), connections[c], [SyntheticSampler.StatusProbe]), credit: Credit);
        // 24 more fit (32 in all); the last connection's eight do not.
        var over = Enumerable.Range(0, 8).Select(_ => host.Next(FrameKind.Response)).ToList();
        check(perConnection && over.All(answer => ErrorCode(answer) == "BUSY") && over.All(answer => answer?.Header.Id > 9)
            && SpinWait.SpinUntil(() => service.Live.Count == 32, 2000),
            "at most 8 live subscriptions per server (a connection id that reaches none counts as its own) and 32 in the backend; the next is BUSY");
        var duplicate = Guid.NewGuid().ToString();
        host.Request(++id, "live.subscribe", Subscribe(duplicate, connections[4], [SyntheticSampler.StatusProbe]), credit: Credit);
        var full = host.Next(FrameKind.Response);

        // A disconnect ends that connection's subscriptions; the backend's shutdown ends the rest.
        host.Request(++id, "connections.disconnect", new { connectionId = connections[0] });
        var ended = new Dictionary<uint, string?>();
        while (ended.Count < 9 && host.Next(FrameKind.Response) is { } answer) ended[answer.Header.Id] = Body(answer).TryGetProperty("result", out var result) && result.TryGetProperty("ended", out var reason) ? reason.GetString() : "disconnect";
        check(ErrorCode(full) == "BUSY" && ended.Count(item => item.Value == "disconnected") == 8 && ended.Keys.Where(key => ended[key] == "disconnected").All(key => key <= 9)
            && SpinWait.SpinUntil(() => service.Live.Count == 24, 2000), "a disconnect ends that connection's live subscriptions, answered ended disconnected");
        host.Request(++id, "live.subscribe", Subscribe(duplicate, Guid.NewGuid().ToString(), [SyntheticSampler.StatusProbe]), credit: Credit);
        host.Request(++id, "live.subscribe", Subscribe(duplicate, Guid.NewGuid().ToString(), [SyntheticSampler.StatusProbe]), credit: Credit);
        var second = host.Next(FrameKind.Response);
        check(second?.Header.Id >= id - 1 && ErrorCode(second) == "DUPLICATE_REQUEST", "a subscription id already running is DUPLICATE_REQUEST");
        service.CancelAll();
        var shutdown = new List<string?>();
        while (shutdown.Count < 25 && host.Next(FrameKind.Response) is { } answer) shutdown.Add(Result(answer).GetProperty("ended").GetString());
        check(shutdown.Count == 25 && shutdown.All(reason => reason == "shutdown") && SpinWait.SpinUntil(() => service.Live.Count == 0, 2000), "the backend's shutdown ends every live subscription with ended shutdown");
    }

    private static void EndChecks(Action<bool, string> check)
    {
        var store = new ResultStore(1L << 30, 1L << 29);
        var service = new SqlService(store, hooks: true);
        using var host = new HostHarness(dispatcher: () => service);
        host.Hello();
        host.Request(1, "live.subscribe", Subscribe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), [SyntheticSampler.TableProbe], new { tickMs = 20, endAfterTicks = 3 }), credit: Credit);
        Frame? frame = null;
        var tables = new List<JsonElement>();
        for (var i = 0; i < 4; i++) if (Next(host, 1, ref frame) is { } value && value.GetProperty("type").GetString() == "live.tick") tables.Add(value.GetProperty("samples")[0].GetProperty("tables")[0]);
        host.Send(FrameKind.Credit, 1, (uint)frame!.Value.Body.Length, []);
        var end = host.Next(FrameKind.Response);
        var kept = Result(end).TryGetProperty("kept", out var ids) ? ids.EnumerateArray().Select(item => item.GetUInt32()).ToArray() : [];
        check(tables.Count == 3 && Result(end).GetProperty("ended").GetString() == "sourceEnded" && Result(end).GetProperty("ticks").GetInt64() == 3
            && kept.SequenceEqual([tables[2].GetProperty("descriptor").GetProperty("resultId").GetUInt32()]) && store.Count == 1 && Stored(store, tables[2]) is { IsComplete: true },
            "a source that ends answers sourceEnded and keeps its last table readable, releasing the rest");
        store.Release(kept);

        host.Request(2, "live.subscribe", Subscribe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), [SyntheticSampler.TableProbe, SyntheticSampler.StatusProbe], new { tickMs = 20, errorEvery = 1 }), credit: Credit);
        frame = null;
        var errorTicks = new List<JsonElement>();
        for (var i = 0; i < 9; i++) if (Next(host, 2, ref frame) is { } value && value.GetProperty("type").GetString() == "live.tick") errorTicks.Add(value);
        var failures = errorTicks.Where(tick => tick.TryGetProperty("errors", out _)).Select(tick => tick.GetProperty("errors")[0]).ToList();
        // The failing probe backs off (20 ms, then about 40 and 80), so later ticks carry only the status probe.
        check(errorTicks.Count == 8 && failures.Count is >= 2 and < 8 && failures.All(error => error.GetProperty("code").GetString() == "SQL_ERROR" && !error.GetProperty("terminal").GetBoolean())
            && failures[0].GetProperty("retryInMs").GetInt32() == 20 && failures[1].GetProperty("retryInMs").GetInt32() is >= 36 and <= 44
            && errorTicks.All(tick => tick.GetProperty("samples").EnumerateArray().All(sample => sample.GetProperty("probe").GetString() == SyntheticSampler.StatusProbe))
            && errorTicks.Count(tick => tick.GetProperty("samples").GetArrayLength() == 1) >= 6,
            "a probe's failure is a value in the tick that says when it retries, backing off, and the subscription and its other probes keep going");
        host.Send(FrameKind.Cancel, 2, 3, []);
        check(Result(host.Next(FrameKind.Response)).GetProperty("ended").GetString() == "cancelled", "CANCEL reason 3 (the port closed) also ends it as cancelled");

        // A frame over the event limit is never sent: the subscription fails with BACKEND_ERROR and releases its results.
        service.Live.TestSampler = _ => new OversizedSampler();
        host.Request(3, "live.subscribe", Subscribe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), [SyntheticSampler.StatusProbe]), credit: Credit);
        frame = null;
        Next(host, 3, ref frame);
        host.Send(FrameKind.Credit, 3, (uint)frame!.Value.Body.Length, []);
        var failed = host.Next(FrameKind.Response);
        service.Live.TestSampler = null;
        check(failed?.Header.Id == 3 && Result(failed).GetProperty("ended").GetString() == "failed" && Result(failed).GetProperty("code").GetString() == "BACKEND_ERROR"
            && Result(failed).GetProperty("message").GetString()!.Length > 0 && host.Next(FrameKind.Event, 200) is null, "a tick over 256 KiB ends the subscription failed (BACKEND_ERROR) and is never sent");
    }

    /// <summary>Live SQL: a second connection to the same server, with another database, counts against the same
    /// per-server cap, by the server's own name.</summary>
    public static async Task LiveAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, ConnectOptions other, JsonSerializerOptions json)
    {
        var second = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(other, json), json);
        try
        {
            var server = service.ServerOf(info.Id);
            check(server is { Length: > 7 } && server.StartsWith("server:", StringComparison.Ordinal) && service.ServerOf(second.Id) == server && service.ServerOf(Guid.NewGuid().ToString()) is null,
                "two connections to one SQL Server, with different databases, resolve to the same server for the live per-server cap");
        }
        finally { await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(second.Id), json), json); }
    }

    /// <summary>The table probe's sample or error in a tick.</summary>
    private static (JsonElement? Table, string? Error) TableOf(JsonElement? tick)
    {
        if (tick is not { } value) return (null, null);
        foreach (var sample in value.GetProperty("samples").EnumerateArray())
            if (sample.GetProperty("probe").GetString() == SyntheticSampler.TableProbe) return (sample.GetProperty("tables")[0], null);
        return value.TryGetProperty("errors", out var errors) ? (null, errors[0].GetProperty("code").GetString()) : (null, null);
    }

    private static void BudgetChecks(Action<bool, string> check)
    {
        // A refused duplicate leaves the running subscription's revisions alone.
        var store = new ResultStore(1L << 30, 1L << 29);
        using (var host = new HostHarness(dispatcher: () => new SqlService(store, hooks: true)))
        {
            host.Hello();
            var subscription = Guid.NewGuid().ToString();
            host.Request(1, "live.subscribe", Subscribe(subscription, Guid.NewGuid().ToString(), [SyntheticSampler.TableProbe]), credit: Credit);
            Frame? frame = null;
            Next(host, 1, ref frame);
            var (table, _) = TableOf(Next(host, 1, ref frame));
            host.Request(2, "live.subscribe", Subscribe(subscription, Guid.NewGuid().ToString(), [SyntheticSampler.TableProbe]), credit: Credit);
            var refused = host.Next(FrameKind.Response);
            check(refused?.Header.Id == 2 && ErrorCode(refused) == "DUPLICATE_REQUEST" && table is { } t && Stored(store, t) is { IsComplete: true, RowsAvailable: 3 },
                "a refused duplicate subscription leaves the running one's current revision readable");
            host.Send(FrameKind.Cancel, 1, 1, []);
            host.Next(FrameKind.Response);
        }

        // Revisions that fill the budget together: each has its own budget and the oldest goes before the next is stored,
        // so the probe keeps storing, and a smaller row count afterwards is stored in full.
        var small = new ResultStore(1L << 20, 1L << 19);
        using (var host = new HostHarness(dispatcher: () => new SqlService(small, hooks: true)))
        {
            host.Hello();
            var subscription = Guid.NewGuid().ToString();
            host.Request(1, "live.subscribe", Subscribe(subscription, Guid.NewGuid().ToString(), [SyntheticSampler.TableProbe], new { tickMs = 20, rows = 10_000 }), credit: Credit);
            Frame? frame = null;
            Next(host, 1, ref frame);
            var full = Enumerable.Range(0, 5).Select(_ => TableOf(Next(host, 1, ref frame))).ToList();
            host.Request(2, "live.update", new { subscriptionId = subscription, source = SyntheticSampler.Source, args = new { rows = 3 } });
            var updated = host.Next(FrameKind.Response);
            var after = Enumerable.Range(0, 4).Select(_ => TableOf(Next(host, 1, ref frame))).ToList();
            check(full.All(item => item.Table is not null) && ErrorCode(updated) is null
                && after.TakeLast(2).All(item => item.Table is { } value && Stored(small, value) is { RowsAvailable: 3 }) && small.Count <= 2,
                "revisions that fill the result budget keep being stored, each with its own budget, and a smaller row count afterwards is stored in full: " + string.Join(", ", full.Concat(after).Select(item => item.Error ?? "table")));
            host.Send(FrameKind.Cancel, 1, 1, []);
            host.Next(FrameKind.Response);
        }

        // A budget full of other results: the probe reports BUDGET, and stores again once they are closed.
        var held = new ResultStore(1L << 20, 1L << 19);
        var hogs = new[] { held.BeginQuery("hog-1"), held.BeginQuery("hog-2") };
        var reserved = hogs.All(hog => held.TryReserve(hog, 1L << 19, false, out _));
        using (var host = new HostHarness(dispatcher: () => new SqlService(held, hooks: true)))
        {
            host.Hello();
            host.Request(1, "live.subscribe", Subscribe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), [SyntheticSampler.TableProbe]), credit: Credit);
            Frame? frame = null;
            Next(host, 1, ref frame);
            var refused = Enumerable.Range(0, 2).Select(_ => TableOf(Next(host, 1, ref frame))).ToList();
            foreach (var hog in hogs) held.Return(hog, 1L << 19);
            var recovered = Enumerable.Range(0, 2).Select(_ => TableOf(Next(host, 1, ref frame))).ToList();
            check(reserved && refused.All(item => item.Error == "BUDGET") && recovered.All(item => item.Table is { } value && Stored(held, value) is { RowsAvailable: 3 }),
                "a probe reports BUDGET while the result budget is full, and stores again as soon as memory is free: " + string.Join(", ", refused.Concat(recovered).Select(item => item.Error ?? "table")));
            host.Send(FrameKind.Cancel, 1, 1, []);
            host.Next(FrameKind.Response);
        }
    }

    /// <summary>A live EVENT is never droppable: with the control lane full (main not reading), droppable events are refused
    /// but the subscription's frame is still queued, since the source would otherwise wait for an acknowledgement forever.</summary>
    private static async Task LaneChecks(Action<bool, string> check)
    {
        var service = new SqlService(new ResultStore(1L << 30, 1L << 29), hooks: true);
        using var host = new HostHarness(dispatcher: () => service, valve: true);
        host.Hello();
        host.Valve!.Shut();
        var full = false;
        for (var i = 0; i < 1_000_000 && !full; i++) full = !host.Host.Publish(new { type = "results.memory", usedBytes = 0, globalBytes = 1, seq = i });
        host.Request(1, "live.subscribe", Subscribe(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), [SyntheticSampler.StatusProbe]), credit: Credit);
        var running = SpinWait.SpinUntil(() => service.Live.Count == 1, 5000);
        // The opened frame is queued synchronously once the subscription is registered.
        await Task.Delay(200);
        host.Valve.Open();
        var opened = false;
        while (!opened && host.Next(FrameKind.Event, 5000) is { } frame) opened = frame.Header.Id == 1 && Body(frame).GetProperty("type").GetString() == "live.opened";
        check(full && running && opened, "a live EVENT is queued even while the control lane is full, where droppable events are refused");
        host.Send(FrameKind.Cancel, 1, 1, []);
        host.Next(FrameKind.Response);
    }

    /// <summary>The backend's rules against a catalogue with shapes the shipped one lacks: two sources, a probe with a view
    /// and a filter mode. Driven on LiveService directly, with a host whose connections reach named servers.</summary>
    private static async Task FixtureChecks(Action<bool, string> check)
    {
        LiveColumnJson Column(string id) => new(id, id, "int");
        LiveTableJson Table(string key) => new("rows", "snapshot", [Column(key), Column("v")], [key]);
        var interval = new LiveIntervalJson(1000, 1000, 3_600_000);
        var catalog = LiveCatalog.Create(LiveCatalog.Current.Limits,
            [new("fixture.one.rows", "fixture.one", "Rows", "Rows", interval, [], [Table("k")], [], ["blocked"], "memory"), new("fixture.two.rows", "fixture.two", "Rows", "Rows", interval, [], [Table("j")], [], [], "none")],
            [new("fixture.one", "One", "One", "server", false, ["fixture.one.rows"]), new("fixture.two", "Two", "Two", "server", false, ["fixture.two.rows"])]);
        var servers = new Dictionary<string, string>
        {
            [Guid.NewGuid().ToString()] = "server:A", [Guid.NewGuid().ToString()] = "server:A", [Guid.NewGuid().ToString()] = "server:B"
        };
        var ids = servers.Keys.ToArray();
        var store = new ResultStore(1L << 30, 1L << 29);
        using var service = new LiveService(new FixtureHost(servers, store), catalog) { TestSampler = _ => new IdleSampler() };
        var contexts = new List<RequestContext>();
        var tasks = new List<Task<LiveEnd>>();
        uint next = 0;
        Task<LiveEnd> Start(string connection, LiveProbeArgs? probe = null, string source = "fixture.one", string? subscription = null)
        {
            var context = new RequestContext(++next, "live.subscribe", RequestLane.Live, 0, Credit, sendCreditedEvent: (_, _) => 10);
            contexts.Add(context);
            var task = service.SubscribeAsync(new LiveSubscribeArgs(subscription ?? Guid.NewGuid().ToString(), connection, source, [probe ?? new LiveProbeArgs(source + ".rows", 1000)]), context, HostChecks.Json);
            tasks.Add(task);
            return task;
        }
        static string Code(Task task) => task.IsFaulted ? (task.Exception!.InnerException as RequestException)?.Code ?? "other" : task.IsCompleted ? "ended" : "running";
        string Updated(LiveUpdateArgs args)
        {
            try { service.Update(args, HostChecks.Json); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        async Task Settle()
        {
            service.CancelAll();
            try { await Task.WhenAll(tasks); }
            catch (RequestException) { /* The refused ones. */ }
            tasks.Clear();
        }

        // 8 per server: two connections to server A share its 8; server B has its own.
        var first = Enumerable.Range(0, 8).Select(index => Code(Start(ids[index % 2]))).ToList();
        var ninth = Code(Start(ids[1]));
        var other = Code(Start(ids[2]));
        check(first.All(code => code == "running") && ninth == "BUSY" && other == "running" && service.Count == 9,
            "at most 8 live subscriptions per SQL Server, counted across every connection that reaches it: " + string.Join(", ", first) + ", " + ninth + ", " + other);
        await Settle();

        string Subscribed(LiveProbeArgs probe) => Code(Start(ids[2], probe));
        var subscribes = new Dictionary<string, string>
        {
            ["filter"] = Subscribed(new("fixture.one.rows", 1000, Filter: new(new string('x', 400), ["k", "v"]))),
            ["view"] = Subscribed(new("fixture.one.rows", 1000, View: "blocked")),
            ["long filter"] = Subscribed(new("fixture.one.rows", 1000, Filter: new(new string('x', 401)))),
            ["filter column"] = Subscribed(new("fixture.one.rows", 1000, Filter: new("x", ["j"]))),
            ["unknown view"] = Subscribed(new("fixture.one.rows", 1000, View: "other")),
            ["no filter mode"] = Code(Start(ids[2], new("fixture.two.rows", 1000, Filter: new("x")), "fixture.two")),
            ["other source's probe"] = Subscribed(new("fixture.two.rows", 1000))
        };
        check(subscribes.Take(2).All(item => item.Value == "running") && subscribes.Skip(2).All(item => item.Value == "INVALID_PARAMS"),
            "live.subscribe takes a filter of up to 400 characters on the probe's columns and a view it declares, only where it has them: "
            + string.Join(", ", subscribes.Select(item => item.Key + " " + item.Value)));
        await Settle();

        var id = Guid.NewGuid().ToString();
        _ = Start(ids[2], subscription: id);
        LiveUpdateArgs Patch(LiveProbeArgs probe) => new(id, "fixture.one", Probes: [probe]);
        var updates = new Dictionary<string, string>
        {
            ["filter"] = Updated(Patch(new("fixture.one.rows", Filter: new(new string('x', 400))))),
            ["clear"] = Updated(Patch(new("fixture.one.rows", Clear: ["filter", "view", "sort"]))),
            ["long filter"] = Updated(Patch(new("fixture.one.rows", Filter: new(new string('x', 401))))),
            ["filter column"] = Updated(Patch(new("fixture.one.rows", Filter: new("x", ["j"])))),
            ["unknown view"] = Updated(Patch(new("fixture.one.rows", View: "other"))),
            ["another source"] = Updated(new(id, "fixture.two", Paused: true)),
            ["another source's probe"] = Updated(new(id, "fixture.two", Probes: [new("fixture.two.rows", Paused: true)])),
            ["another source's table"] = Updated(new(id, "fixture.one", Track: [new("fixture.two.rows", 0, 1, [])]))
        };
        check(updates.Take(2).All(item => item.Value == "accepted") && updates.Skip(2).All(item => item.Value == "INVALID_PARAMS"),
            "live.update checks filters, views and the source against the catalogue as subscribe does: " + string.Join(", ", updates.Select(item => item.Key + " " + item.Value)));
        await Settle();
        foreach (var context in contexts) context.Dispose();
    }
}
