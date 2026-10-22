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
    }

    private static void CatalogChecks(Action<bool, string> check)
    {
        var catalog = LiveCatalog.Current;
        check(catalog.Limits is { PortStreams: 16, BackendSubscriptions: 32, PerConnection: 8, Probes: 8, InitialCredit: Credit, EventBody: ProtocolLimits.EventBody, FrameBudget: 192 * 1024 }
            && catalog.Sources.TryGetValue(SyntheticSampler.Source, out var source) && source.TestOnly
            && source.Probes.SequenceEqual([SyntheticSampler.MetricsProbe, SyntheticSampler.TableProbe, SyntheticSampler.StatusProbe])
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
        host.Request(1, "live.subscribe", Subscribe(subscription, Guid.NewGuid().ToString()), credit: Credit);
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
            && ticks[0].GetProperty("samples").EnumerateArray().All(sample => sample.GetProperty("gap").GetString() == "baseline" && !sample.TryGetProperty("elapsedMs", out _))
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
            ["subscription id"] = Refused(With(subscription: "not-a-uuid"))
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
            ["args"] = Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, args = new { tickMs = 5 } })
        };
        check(updates.All(item => item.Value == "INVALID_PARAMS") && Update(new { subscriptionId = Guid.NewGuid().ToString(), source = SyntheticSampler.Source, paused = true }) == "NOT_FOUND"
            && Update(new { subscriptionId = subscription, source = SyntheticSampler.Source, refresh = true, args = new { rows = 5 } }) == "accepted",
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
            "at most 8 live subscriptions per connection and 32 in the backend; the next is BUSY");
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
        for (var i = 0; i < 3; i++) if (Next(host, 2, ref frame) is { } value && value.GetProperty("type").GetString() == "live.tick") errorTicks.Add(value);
        check(errorTicks.Count == 2 && errorTicks.All(tick => tick.GetProperty("errors")[0].GetProperty("code").GetString() == "SQL_ERROR" && !tick.GetProperty("errors")[0].GetProperty("terminal").GetBoolean()
            && tick.GetProperty("samples").EnumerateArray().Single().GetProperty("probe").GetString() == SyntheticSampler.StatusProbe),
            "a probe's failure is a value in the tick, and the subscription and its other probes keep going");
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

    /// <summary>A sampler whose one sample is over the event limit (17 statuses of 128 characters would not be; this is bigger).</summary>
    private sealed class OversizedSampler : ILiveSampler
    {
        public int? PeriodMs => 10;
        public bool Ended => false;
        public IReadOnlyList<LiveOpenedProbe> Open(IReadOnlyList<LiveProbeState> probes) => [.. probes.Select(probe => new LiveOpenedProbe(probe.Spec.Id, 1000, 1000, 1000, "ok"))];
        public Task<LiveSampleBatch> SampleAsync(IReadOnlyList<LiveDue> due, CancellationToken token) =>
            Task.FromResult(new LiveSampleBatch([new LiveSample(due[0].Probe.Spec.Id, 0, 1000, Status: [new LiveStatus("phase", new string('x', 300 * 1024))])], []));
        public void Apply(object args) { }
        public uint[] Keep() => [];
        public void Release() { }
        public void Dispose() { }
    }
}
