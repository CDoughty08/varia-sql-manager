using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using System.Text.Json.Serialization;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of ProtocolHost and Outbound over in-process pipes, with a stub dispatcher.</summary>
internal static class HostChecks
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    private static JsonElement Body(Frame frame) => JsonBridge.ParseControl(frame.Body);
    private static string? ErrorCode(Frame frame) => Body(frame).TryGetProperty("error", out var error) ? error.GetProperty("code").GetString() : null;

    public static void Run(Action<bool, string> check)
    {
        using (var host = new HostHarness())
        {
            var hello = host.Hello();
            check(hello.GetProperty("version").GetInt32() == 2 && hello.GetProperty("generation").GetInt32() == 3 && hello.GetProperty("pid").GetInt32() == Environment.ProcessId
                && hello.GetProperty("maxFrameBytes").GetInt32() == 4 * 1024 * 1024 && hello.GetProperty("methods").EnumerateArray().Any(method => method.GetString() == "test.echo")
                && hello.GetProperty("resultBudget").GetProperty("queryBytes").GetInt64() == 128L << 20, "the host answers HELLO with its version, the echoed generation, its methods and budget");
            host.Request(1, "test.echo", new { a = new object[] { 1, "x" } });
            var echo = host.Next(FrameKind.Response);
            check(echo?.Header.Id == 1 && Body(echo.Value).GetProperty("result").GetProperty("a")[1].GetString() == "x", "a request is dispatched and answered with its id");
            host.Request(90, "test.failure", new { });
            var failed = host.Next(FrameKind.Response);
            var failure = failed is null ? default : Body(failed.Value).GetProperty("error");
            check(failed?.Header.Id == 90 && failure.EnumerateObject().Select(member => member.Name).SequenceEqual(["code", "message", "details"])
                && failure.GetProperty("details").EnumerateObject().Select(member => member.Name).SequenceEqual(["number", "state", "class", "server"])
                && failure.GetProperty("details").GetProperty("number").GetInt32() == 18456 && failure.GetProperty("details").GetProperty("class").GetInt32() == 14
                && failure.GetProperty("details").GetProperty("server").GetString()!.Length == ConnectionFailures.MaxServerLength,
                "an error with details carries its number, state, class and server (cut at 256 characters) after the code and message");
            host.Request(91, "test.certificate", new { });
            var certificate = host.Next(FrameKind.Response) is { } certificateFrame ? Body(certificateFrame).GetProperty("error").GetProperty("details") : default;
            check(certificate.ValueKind == JsonValueKind.Object && certificate.EnumerateObject().Select(member => member.Name).SequenceEqual(["number", "state", "class", "server", "reason"])
                && certificate.GetProperty("reason").GetString() == "certificate", "a certificate failure's details end with the reason certificate");
            host.Request(92, "test.crash", new { });
            var crashed = host.Next(FrameKind.Response);
            var crash = crashed is null ? default : Body(crashed.Value).GetProperty("error");
            var crashText = crash.ValueKind == JsonValueKind.Object ? crash.GetRawText() : "";
            check(crashed?.Header.Id == 92 && crash.GetProperty("code").GetString() == "BACKEND_ERROR"
                && crash.GetProperty("message").GetString() == "The backend operation failed. Verify the connection and object permissions."
                && crash.GetProperty("details").EnumerateObject().Select(member => member.Name).SequenceEqual(["exception"])
                && crash.GetProperty("details").GetProperty("exception").GetString() == "System.InvalidOperationException (0x80131509) > System.TypeInitializationException (0x80131534) > System.DllNotFoundException (0x80131524)"
                && !crashText.Contains("marker") && !crashText.Contains("secret"),
                "an unexpected failure answers BACKEND_ERROR with its exception types and HRESULTs for Copy details, never their messages: " + crashText);
            var deep = new Exception("1", new Exception("2", new Exception("3", new Exception("4", new Exception("5")))));
            var summary = ErrorDetailsLimits.Summary(deep);
            check(summary == string.Join(" > ", Enumerable.Repeat("System.Exception (0x80131500)", 4)), "the exception summary names at most four exceptions, from the outer one inwards");

            host.Request(2, "test.wait", new { });
            Thread.Sleep(50);
            host.Send(FrameKind.Cancel, 2, 1, []);
            var cancelled = host.Next(FrameKind.Response);
            check(cancelled?.Header.Id == 2 && ErrorCode(cancelled.Value) == "CANCELLED", "CANCEL answers a unary request CANCELLED");

            // Stop on an object action: the reply waits for the action's own answer, which lists the steps it completed.
            var settling = Stopwatch.StartNew();
            host.Request(6, "test.settle", new { });
            Thread.Sleep(50);
            host.Send(FrameKind.Cancel, 6, 1, []);
            var settled = host.Next(FrameKind.Response);
            var settledMs = settling.ElapsedMilliseconds;
            host.Request(7, "test.settle", new { });
            Thread.Sleep(50);
            host.Send(FrameKind.Cancel, 7, 3, []);
            var gone = host.Next(FrameKind.Response);
            check(settled?.Header.Id == 6 && ErrorCode(settled.Value) is null && Body(settled.Value).GetProperty("result").GetProperty("settled").GetBoolean() && settledMs >= 250
                && gone?.Header.Id == 7 && ErrorCode(gone.Value) == "CANCELLED",
                "CANCEL reason 1 on the actions lane answers with the action's result once it settles; other reasons answer CANCELLED at once (" + settledMs + " ms)");
            // An SSIS write answers Stop the same way, on its own lane: the dispatcher says which methods do (ssis.execute).
            host.Request(60, "test.settleSsis", new { });
            Thread.Sleep(50);
            host.Send(FrameKind.Cancel, 60, 1, []);
            var ssisSettled = host.Next(FrameKind.Response);
            check(ssisSettled?.Header.Id == 60 && ErrorCode(ssisSettled.Value) is null && Body(ssisSettled.Value).GetProperty("result").GetProperty("settled").GetBoolean(),
                "CANCEL reason 1 on a method whose handler answers Stop (an SSIS write) waits for its result, whatever its lane");

            // Which frames hold a secret is the dispatcher's answer (SqlService: methodPolicies' sensitive set, ssis.execute included).
            host.Request(61, "test.secret", new { value = "s3cret" });
            var secret = host.Next(FrameKind.Response);
            check(secret?.Header.Id == 61 && Body(secret.Value).GetProperty("result").GetProperty("value").GetString() == "s3cret" && host.Dispatcher.AskedSensitive.Contains("test.secret"),
                "the host asks the dispatcher whether a request is sensitive before it parses the frame, and still answers it");

            var watch = Stopwatch.StartNew();
            host.Request(3, "test.slow", new { ms = 1500 }, deadline: 100);
            var timedOut = host.Next(FrameKind.Response);
            var elapsed = watch.ElapsedMilliseconds;
            check(timedOut?.Header.Id == 3 && ErrorCode(timedOut.Value) == "TIMEOUT" && elapsed is >= 90 and < 600 && host.Dispatcher.Completed == 0,
                "a deadline answers TIMEOUT within 100 ms while the handler keeps running (" + elapsed + " ms)");
            check(Body(timedOut!.Value).GetProperty("error").GetProperty("message").GetString() == "The operation exceeded its time limit of 1 seconds.", "TIMEOUT names the deadline");
            SpinWait.SpinUntil(() => host.Dispatcher.Completed == 1, 5000);
            check(host.Dispatcher.Completed == 1 && host.Next(FrameKind.Response, 300) is null, "the late result of a timed-out request is discarded: exactly one RESPONSE per id");

            host.Send(FrameKind.Request, 4, 0, new byte[ProtocolLimits.RequestBody + 1]);
            host.Request(5, "test.echo", new { b = true });
            var tooLarge = host.Next(FrameKind.Response);
            var after = host.Next(FrameKind.Response);
            check(tooLarge?.Header.Id == 4 && ErrorCode(tooLarge.Value) == "TOO_LARGE" && after?.Header.Id == 5 && ErrorCode(after.Value) is null,
                "an oversized REQUEST is skipped and answered TOO_LARGE with its id, and framing stays in sync");

            var duplicate = new ArrayBufferWriter<byte>();
            var writer = new MsgPackWriter(duplicate);
            writer.WriteMapHeader(2);
            writer.WriteString("method");
            writer.WriteString("test.echo");
            writer.WriteString("params");
            writer.WriteMapHeader(2);
            writer.WriteString("a");
            writer.WriteInt64(1);
            writer.WriteString("a");
            writer.WriteInt64(2);
            host.Send(FrameKind.Request, 6, 0, duplicate.WrittenSpan);
            var invalid = host.Next(FrameKind.Response);
            check(invalid?.Header.Id == 6 && ErrorCode(invalid.Value) == "INVALID_PARAMS" && host.Exits.IsEmpty, "invalid params are an INVALID_PARAMS answer, not a protocol error");

            // Malformed MessagePack inside params (float32, invalid UTF-8, an unsafe integer) is a bad parameter too.
            byte[][] malformed = [[0x81, 0xa1, 0x61, 0xca, 0, 0, 0, 0], [0x81, 0xa1, 0x61, 0xa2, 0xc3, 0x28], [0x81, 0xa1, 0x61, 0xcf, 0, 0x20, 0, 0, 0, 0, 0, 0]];
            var answers = new List<string?>();
            foreach (var (value, index) in malformed.Select((value, index) => (value, index)))
            {
                var raw = new ArrayBufferWriter<byte>();
                var envelope = new MsgPackWriter(raw);
                envelope.WriteMapHeader(2);
                envelope.WriteString("method");
                envelope.WriteString("test.echo");
                envelope.WriteString("params");
                raw.Write(value);
                host.Send(FrameKind.Request, 30 + (uint)index, 0, raw.WrittenSpan);
                answers.Add(host.Next(FrameKind.Response) is { } answer && answer.Header.Id == 30 + index ? ErrorCode(answer) : "missing");
            }
            host.Request(33, "test.echo", new { ok = true });
            check(answers.All(code => code == "INVALID_PARAMS") && host.Next(FrameKind.Response)?.Header.Id == 33 && host.Exits.IsEmpty,
                "malformed MessagePack inside params is answered INVALID_PARAMS and the host carries on: " + string.Join(", ", answers));

            // The { result } wrapper is one level of the body, so an echoed value 16 containers deep would be 17 on the wire,
            // past what main's decoder (and ParseControl) accepts: it must be refused, and 15 must pass.
            var nested = new List<string?>();
            foreach (var depth in new[] { 15, 16 })
            {
                var raw = new ArrayBufferWriter<byte>();
                var envelope = new MsgPackWriter(raw);
                envelope.WriteMapHeader(2);
                envelope.WriteString("method");
                envelope.WriteString("test.echo");
                envelope.WriteString("params");
                envelope.WriteMapHeader(1);
                envelope.WriteString("a");
                for (var level = 2; level < depth; level++) envelope.WriteArrayHeader(1);
                envelope.WriteArrayHeader(0);
                host.Send(FrameKind.Request, 40 + (uint)depth, 0, raw.WrittenSpan);
                var answer = host.Next(FrameKind.Response);
                try { nested.Add(answer is { } frame ? ErrorCode(frame) ?? "ok" : "missing"); }
                catch (ProtocolException error) { nested.Add("undecodable " + error.Code); }
            }
            check(nested.SequenceEqual(["ok", "BACKEND_ERROR"]), "a RESPONSE never nests deeper than main decodes: " + string.Join(", ", nested));

            host.Request(50, "test.unsent", new { });
            var unsent = host.Next(FrameKind.Response);
            check(unsent?.Header.Id == 50 && ErrorCode(unsent.Value) == "RESPONSE_TOO_LARGE" && host.Dispatcher.Unsent == 1,
                "a result too large to send is answered RESPONSE_TOO_LARGE and the handler is told, so it can release what it stored");

            host.Request(7, "test.stream", new { pages = 4, bytes = 40 * 1024 }, credit: 64 * 1024);
            var first = host.Next(FrameKind.Data);
            var second = host.Next(FrameKind.Data);
            var stalled = host.Next(FrameKind.Data, 300);
            check(first?.Header.Arg == 1 && second?.Header.Arg == 2 && stalled is null && host.Next(FrameKind.Response, 1) is null,
                "a stream sends while credit is positive, so it overdraws by at most one frame, then waits");
            host.Send(FrameKind.Credit, 7, 64 * 1024, []);
            var third = host.Next(FrameKind.Data);
            var fourth = host.Next(FrameKind.Data);
            var end = host.Next(FrameKind.Response);
            check(third?.Header.Arg == 3 && fourth?.Header.Arg == 4 && fourth.Value.Body.Length == 40 * 1024 && fourth.Value.Body[0] == 4 && end?.Header.Id == 7
                && Body(end.Value).GetProperty("result").GetProperty("pages").GetInt32() == 4 && host.ArrivalOf(end.Value) > host.ArrivalOf(fourth.Value),
                "CREDIT resumes the stream, and its RESPONSE follows its DATA in sequence");

            host.Request(8, "test.events", new { });
            var firstEvent = host.Next(FrameKind.Event);
            var secondEvent = host.Next(FrameKind.Event);
            var thirdEvent = host.Next(FrameKind.Event);
            var eventsDone = host.Next(FrameKind.Response);
            check(firstEvent?.Header.Id == 8 && Body(firstEvent.Value).GetProperty("messages")[0].GetString() == "first" && Body(secondEvent!.Value).GetProperty("type").GetString() == "resultSet.closed"
                && thirdEvent?.Body.Length > 1024 * 1024 && eventsDone?.Header.Id == 8 && host.ArrivalOf(eventsDone.Value) > host.ArrivalOf(thirdEvent.Value) && host.Next(FrameKind.Event, 200) is null,
                "a request's EVENT frames precede its RESPONSE; a droppable event over 256 KiB and an essential one over 4 MiB are dropped, a 1 MiB descriptor event is not");

            for (var id = 10u; id < 18; id++) host.Request(id, "test.slow", new { ms = 1500 });
            Thread.Sleep(100);
            watch.Restart();
            host.Send(FrameKind.Ping, 0, 4242, []);
            var pong = host.Next(FrameKind.Pong);
            check(pong?.Header.Arg == 4242 && watch.ElapsedMilliseconds < 500, "PING is answered by the reader thread while every metadata slot is busy");

            host.Request(20, "test.wait", new { });
            Thread.Sleep(100);
            host.Dispatcher.DrainFor = TimeSpan.FromMilliseconds(400);
            var closing = Stopwatch.StartNew();
            host.CloseInput();
            check(host.Exited.Wait(5000) && host.Exits.TryPeek(out var code) && code == 0 && host.Dispatcher.CancelAllCalls == 1 && host.Dispatcher.Disposed
                && host.Dispatcher.DrainCalls == 1 && !host.Dispatcher.DisposedBeforeDrain && closing.ElapsedMilliseconds >= 400,
                "stdin EOF cancels everything, waits for the work that must not end half done (a Create Catalog past its restore), then disposes the service and exits 0 ("
                + closing.ElapsedMilliseconds + " ms)");
        }

        using (var host = new HostHarness(new HostOptions { MaxInFlight = 2, MetadataSlots = 1, MetadataWait = TimeSpan.FromMilliseconds(200) }))
        {
            host.Hello();
            host.Request(1, "test.slow", new { ms = 1000 });
            Thread.Sleep(50);
            host.Request(2, "test.slow", new { ms = 1000 });
            host.Request(3, "test.echo", new { });
            var busy = host.Next(FrameKind.Response);
            var waited = host.Next(FrameKind.Response);
            check(busy?.Header.Id == 3 && ErrorCode(busy.Value) == "BUSY" && waited?.Header.Id == 2 && ErrorCode(waited.Value) == "BUSY",
                "past the in-flight cap a request is answered BUSY, and a metadata request answers BUSY once its slot wait expires");
        }

        using (var host = new HostHarness())
        {
            host.Request(1, "test.echo", new { });
            var goAway = host.Next(FrameKind.GoAway);
            check(goAway is { } frame && Body(frame).GetProperty("code").GetString() == "PROTOCOL_ERROR" && host.Exited.Wait(2000) && host.Exits.TryPeek(out var code) && code == 64,
                "a frame before HELLO is GOAWAY PROTOCOL_ERROR and exit 64");
        }

        using (var host = new HostHarness())
        {
            host.Send(FrameKind.Hello, 0, 0, JsonBridge.Encode(new { versions = new[] { 3, 4 }, generation = 1 }, Json));
            var goAway = host.Next(FrameKind.GoAway);
            check(goAway is { } frame && Body(frame).GetProperty("code").GetString() == "PROTOCOL_UNSUPPORTED" && Body(frame).GetProperty("versions")[1].GetInt32() == 2
                && host.Exited.Wait(2000) && host.Exits.TryPeek(out var code) && code == 65 && !host.Dispatcher.Created, "no shared version is GOAWAY PROTOCOL_UNSUPPORTED [2, 2], exit 65, before the service starts");
        }

        using (var host = new HostHarness(new HostOptions { HelloTimeout = TimeSpan.FromMilliseconds(200) }))
        {
            var goAway = host.Next(FrameKind.GoAway, 3000);
            check(goAway is { } frame && Body(frame).GetProperty("code").GetString() == "PROTOCOL_ERROR" && host.Exited.Wait(2000) && host.Exits.TryPeek(out var code) && code == 64,
                "no HELLO in time is GOAWAY PROTOCOL_ERROR and exit 64");
        }

        using (var host = new HostHarness())
        {
            host.Hello();
            host.Send(FrameKind.Request, 1, 0, JsonBridge.Encode(new { method = "test.echo", @params = new { }, extra = 1 }, Json));
            check(host.Next(FrameKind.GoAway) is { } frame && host.Exited.Wait(2000) && host.Exits.TryPeek(out var code) && code == 64 && Body(frame).GetProperty("code").GetString() == "PROTOCOL_ERROR",
                "an invalid request envelope means main is broken: GOAWAY and exit 64");
        }

        using (var host = new HostHarness())
        {
            host.Hello();
            host.Host.Crash(new InvalidOperationException("private detail"));
            var goAway = host.Next(FrameKind.GoAway);
            check(goAway is { } frame && Body(frame).GetProperty("code").GetString() == "BACKEND_CRASH" && Body(frame).GetProperty("message").GetString()!.Contains("InvalidOperationException")
                && !Body(frame).GetProperty("message").GetString()!.Contains("private detail") && host.Exited.Wait(2000) && host.Exits.TryPeek(out var code) && code == 70,
                "an unhandled exception is a GOAWAY BACKEND_CRASH naming only the exception type, and exit 70");
        }

        using (var host = new HostHarness(output: new BrokenStream()))
        {
            host.Send(FrameKind.Hello, 0, 0, JsonBridge.Encode(new { versions = new[] { 2, 2 }, generation = 1 }, Json));
            check(host.Exited.Wait(5000) && host.Exits.TryPeek(out var code) && code == 0, "a stdout that fails to write ends the writer and exits 0");
        }

        OutboundChecks(check);
        MemoryOrder(check);
        MemoryBackpressure(check);

        // HELLO announces MethodNames and main refuses a backend missing any of its methods, so every name must dispatch.
        using var service = new SqlService();
        var undispatched = new List<string>();
        foreach (var method in SqlService.MethodNames)
        {
            try { service.DispatchAsync(method, JsonDocument.Parse("{}").RootElement, Json).GetAwaiter().GetResult(); }
            catch (RequestException error) when (error.Code == "METHOD_NOT_FOUND") { undispatched.Add(method); }
            catch (Exception) { /* Empty parameters are invalid for most methods; any other failure means it was dispatched. */ }
        }
        check(undispatched.Count == 0 && service.LaneOf("query.execute") == RequestLane.Query && service.LaneOf("scripting.script") == RequestLane.Metadata
            && service.LaneOf("tables.columns") == RequestLane.Metadata
            && service.LaneOf("results.copy") == RequestLane.Results && service.LaneOf("results.export") == RequestLane.Results
            && service.LaneOf("query.cancel") == RequestLane.Control && service.LaneOf("no.such.method") == RequestLane.Control,
            "every method announced in HELLO is dispatched, on its lane: " + string.Join(", ", undispatched));
        // explorer.children replaced the v1 catalog lists and scripting.script replaced tables.script; a stale renderer or
        // main must get METHOD_NOT_FOUND, not data.
        string[] retiredMethods = ["tables.list", "server.objects.list", "tables.script"];
        var retired = new List<string>();
        foreach (var method in retiredMethods)
        {
            try { service.DispatchAsync(method, JsonDocument.Parse("{}").RootElement, Json).GetAwaiter().GetResult(); }
            catch (RequestException error) when (error.Code == "METHOD_NOT_FOUND") { retired.Add(method); }
            catch (Exception) { }
        }
        check(retired.Count == retiredMethods.Length && !retiredMethods.Any(SqlService.MethodNames.Contains),
            "the retired v1 catalog and table script methods are neither announced nor dispatched: " + string.Join(", ", retired));
    }

    /// <summary>A summary is written after SummaryBudget took its figure, so a results.close answered meanwhile (Close
    /// Results in another tab while a summary of a thousand sets is serialized) sends its fall first, and the older summary
    /// arrives last. Applied in arrival order, skipping any report older than one already applied (as the status bar
    /// does), the reports end on what the store holds.</summary>
    private static void MemoryOrder(Action<bool, string> check)
    {
        HostHarness? harness = null;
        var store = new ResultStore(1L << 30, 1L << 29);
        using var taken = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        using var host = harness = new HostHarness(dispatcher: () => new HeldSummary(new SqlService(store, hooks: true, publish: value => harness!.Host.Publish(value)), taken, release));
        host.Hello();
        host.Request(1, SqlService.SynthesizeMethod, new { shape = "W1", rows = 10_000 });
        var resultId = Body(host.Next(FrameKind.Response)!.Value).GetProperty("result").GetProperty("resultId").GetUInt32();
        host.Request(2, "test.summary", new { });
        var held = taken.Wait(5000);
        host.Request(3, "results.close", new { resultIds = new[] { resultId } });
        var closed = host.Next(FrameKind.Response);
        release.Set();
        var summary = host.Next(FrameKind.Response);
        var reports = new List<(long Arrival, long Seq, long Used, string Kind)>();
        while (host.Next(FrameKind.Event, 300) is { } frame)
        {
            var body = Body(frame);
            if (frame.Header.Id == 0 && body.GetProperty("type").GetString() == "results.memory")
                reports.Add((host.ArrivalOf(frame), body.TryGetProperty("seq", out var seq) ? seq.GetInt64() : -1, body.GetProperty("usedBytes").GetInt64(), "event"));
        }
        if (summary is { } answer && Body(answer).GetProperty("result").GetProperty("budget") is var budget)
            reports.Add((host.ArrivalOf(answer), budget.TryGetProperty("seq", out var seq) ? seq.GetInt64() : -1, budget.GetProperty("usedBytes").GetInt64(), "summary"));
        reports.Sort((left, right) => left.Arrival.CompareTo(right.Arrival));
        long shown = -1, shownSeq = 0;
        foreach (var report in reports.Where(report => report.Seq > shownSeq)) (shown, shownSeq) = (report.Used, report.Seq);
        var fall = reports.FindIndex(report => report is { Kind: "event", Used: 0 });
        check(held && closed?.Header.Id == 3 && summary?.Header.Id == 2 && fall >= 0 && reports[^1] is { Kind: "summary", Used: > 0 } && reports.All(report => report.Seq > 0)
            && reports.Select(report => report.Seq).Distinct().Count() == reports.Count && shown == store.UsedBytes && shown == 0,
            "a summary overtaken by a close's fall carries an older sequence number, so the newest report is what the store holds: "
            + string.Join(", ", reports.Select(report => report.Kind + " #" + report.Seq + " " + report.Used)));
    }

    /// <summary>results.memory is droppable: while main is not reading, the control lane refuses it. A refused fall must
    /// not count as reported, or the status bar keeps showing memory a close already returned; the 1 s timer sends it
    /// once the lane drains.</summary>
    private static void MemoryBackpressure(Action<bool, string> check)
    {
        HostHarness? harness = null;
        var store = new ResultStore(1L << 30, 1L << 29);
        using var host = harness = new HostHarness(dispatcher: () => new SqlService(store, hooks: true, publish: value => harness!.Host.Publish(value)), valve: true);
        host.Hello();
        host.Request(1, SqlService.SynthesizeMethod, new { shape = "W1", rows = 10_000 });
        var resultId = Body(host.Next(FrameKind.Response)!.Value).GetProperty("result").GetProperty("resultId").GetUInt32();
        long Memory(int timeoutMs, Func<long, bool> wanted)
        {
            var deadline = Environment.TickCount64 + timeoutMs;
            while (deadline - Environment.TickCount64 > 0 && host.Next(FrameKind.Event, (int)Math.Max(1, deadline - Environment.TickCount64)) is { } frame)
                if (frame.Header.Id == 0 && Body(frame) is var body && body.GetProperty("type").GetString() == "results.memory" && wanted(body.GetProperty("usedBytes").GetInt64()))
                    return body.GetProperty("usedBytes").GetInt64();
            return -1;
        }
        var rise = Memory(3000, used => used > 0);
        // Main stops reading: the writer blocks on its first frame, then a thousand queued events fill the control lane.
        host.Valve!.Shut();
        host.Host.Publish(new { Type = "test.filler" });
        var blocked = SpinWait.SpinUntil(() => host.Valve.Blocked, 2000);
        for (var i = 0; i < Outbound.MaxDroppableFrames + 10; i++) host.Host.Publish(new { Type = "test.filler" });
        host.Request(2, "results.close", new { resultIds = new[] { resultId } });
        var closedWhileFull = SpinWait.SpinUntil(() => store.UsedBytes == 0 && host.Host.InFlight == 0, 5000);
        // A timer tick while the lane is still full.
        Thread.Sleep(1200);
        host.Valve.Open();
        var closed = host.Next(FrameKind.Response);
        var fall = Memory(3000, used => used == 0);
        check(rise > 0 && blocked && closedWhileFull && closed?.Header.Id == 2 && fall == 0 && store.UsedBytes == 0,
            "a results.memory fall refused while the control lane is full is sent once it drains (rise " + rise + ", fall " + fall + ")");
    }

    private static void OutboundChecks(Action<bool, string> check)
    {
        var output = new GateStream();
        var broken = false;
        var outbound = new Outbound(output, () => broken = true);
        outbound.Start();
        var large = Frames.Encode(FrameKind.Data, 1, 1, new byte[70 * 1024]);
        outbound.Bulk(large);
        SpinWait.SpinUntil(() => output.Blocked, 2000);
        outbound.Bulk(Frames.Encode(FrameKind.Data, 2, 1, [2]));
        outbound.Control(Frames.Encode(FrameKind.Response, 3, 0, [3]));
        var accepted = 0;
        for (var i = 0; i < Outbound.MaxDroppableFrames + 1; i++) if (outbound.Control(Frames.Encode(FrameKind.Event, 4, 0, [4]), droppable: true)) accepted++;
        var essential = outbound.Control(Frames.Encode(FrameKind.Response, 5, 0, [5]));
        check(accepted == Outbound.MaxDroppableFrames - 1 && outbound.DroppedFrames == 2 && essential,
            "while main is not reading, droppable events past 1,000 queued frames are dropped and responses are not");
        output.Release();
        check(outbound.Complete(TimeSpan.FromSeconds(5)) && !broken, "the writer drains its queue when completed");
        var reader = new FrameReader(new MemoryStream(output.Written), FrameDirection.ToMain, 16 * 1024 * 1024);
        var ids = new List<uint>();
        while (reader.Read() is { } frame) ids.Add(frame.Header.Id);
        check(ids.Count == 4 + Outbound.MaxDroppableFrames - 1 && ids[0] == 1 && ids[1] == 3 && ids[^2] == 5 && ids[^1] == 2,
            "the control lane is drained before the bulk lane (" + string.Join(",", ids.Take(3)) + "…" + string.Join(",", ids.TakeLast(2)) + ")");
    }

    /// <summary>A stdout whose writes fail (the real console stream swallows EPIPE; backend-sidecar.test.ts covers that).</summary>
    private sealed class BrokenStream : MemoryStream
    {
        public override void Write(byte[] buffer, int offset, int count) => throw new IOException("Broken pipe");
    }

    /// <summary>A stdout whose writes block until released, as when main is busy, and that records what was written.</summary>
    private sealed class GateStream : Stream
    {
        private readonly ManualResetEventSlim gate = new();
        private readonly MemoryStream written = new();
        private int blocked;
        public bool Blocked => Volatile.Read(ref blocked) != 0;
        public byte[] Written { get { lock (written) return written.ToArray(); } }
        public void Release() => gate.Set();
        public override void Write(byte[] buffer, int offset, int count)
        {
            Volatile.Write(ref blocked, 1);
            gate.Wait();
            lock (written) written.Write(buffer, offset, count);
        }
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }
}

/// <summary>Methods that exercise the host: an echo, a slow handler that ignores its token, one that waits for its
/// token, and a stream of DATA pages.</summary>
internal sealed class StubDispatcher : IRequestDispatcher
{
    public int Completed;
    public int CancelAllCalls;
    public int Unsent;
    public bool Disposed;
    public bool Created;
    public IReadOnlyList<string> Methods { get; } = ["test.echo", "test.slow", "test.wait", "test.stream", "test.events", "test.unsent", "test.failure", "test.certificate", "test.crash", "test.settle", "test.settleSsis", "test.secret"];
    public RequestLane LaneOf(string method) => method switch { "test.slow" => RequestLane.Metadata, "test.stream" => RequestLane.Results, "test.settle" => RequestLane.Actions, "test.settleSsis" => RequestLane.Ssis, _ => RequestLane.Control };
    public bool AnswersStop(string method) => method is "test.settle" or "test.settleSsis";
    public readonly ConcurrentQueue<string> AskedSensitive = new();
    public bool Sensitive(string method)
    {
        AskedSensitive.Enqueue(method);
        return method == "test.secret";
    }
    public (long GlobalBytes, long QueryBytes) ResultBudget => (256L << 20, 128L << 20);

    public async Task<object> DispatchAsync(string method, JsonElement parameters, JsonSerializerOptions json, RequestContext? context)
    {
        switch (method)
        {
            case "test.echo" or "test.secret": return parameters;
            case "test.slow":
                await Task.Delay(parameters.GetProperty("ms").GetInt32());
                Interlocked.Increment(ref Completed);
                return new { Done = true };
            case "test.wait":
                await Task.Delay(Timeout.Infinite, context!.Token);
                return new { };
            case "test.settle" or "test.settleSsis":
                // As ActionService does on Stop: SQL Server ends the statement a moment after the attention, then it answers.
                try { await Task.Delay(Timeout.Infinite, context!.Token); }
                catch (OperationCanceledException) { await Task.Delay(300); }
                return new { Settled = true };
            case "test.stream":
                var pages = parameters.GetProperty("pages").GetInt32();
                for (var page = 1; page <= pages; page++)
                {
                    var body = new byte[parameters.GetProperty("bytes").GetInt32()];
                    Array.Fill(body, (byte)page);
                    await context!.SendDataAsync(body);
                }
                return new { Pages = pages };
            case "test.events":
                context!.SendEvent(new { Type = "messages", Messages = new[] { "first" } }, true);
                context.SendEvent(new { Type = "messages", Messages = new[] { new string('x', 300 * 1024) } }, true);
                context.SendEvent(new { Type = "resultSet.closed" }, false);
                // Essential events carry descriptors of up to 4,096 columns: 1 MiB passes, 5 MiB does not.
                context.SendEvent(new { Type = "resultSet.opened", Descriptor = new string('d', 1024 * 1024) }, false);
                context.SendEvent(new { Type = "resultSet.opened", Descriptor = new string('d', 5 * 1024 * 1024) }, false);
                return new { Sent = 5 };
            case "test.failure": throw new RequestException("SQL_ERROR", "Login failed for user 'reader'.", new ErrorDetails(18456, 1, 14, new string('s', 300)));
            case "test.certificate": throw new RequestException("SQL_ERROR", "The certificate chain was issued by an authority that is not trusted.",
                new ErrorDetails(unchecked((int)0x80090325), 0, 20, "localhost", ErrorDetailsLimits.Certificate));
            // An unexpected failure whose messages hold what must never leave the backend (a path, a name, a password).
            case "test.crash": throw new InvalidOperationException("crash-message-marker Password=secret", new TypeInitializationException("Interop+Sni",
                new DllNotFoundException(@"C:\deep\path-marker\Microsoft.Data.SqlClient.SNI.dll: The filename or extension is too long.")));
            case "test.unsent":
                context!.Unsent = () => Interlocked.Increment(ref Unsent);
                return new { Text = new string('x', ProtocolLimits.ResponseBody) };
            default: throw new RequestException("METHOD_NOT_FOUND", "Unsupported backend method.");
        }
    }

    public void CancelAll() => Interlocked.Increment(ref CancelAllCalls);
    /// <summary>How long DrainCommitted holds shutdown, as a Create Catalog finishing its removal would.</summary>
    public TimeSpan DrainFor;
    public int DrainCalls;
    public bool DisposedBeforeDrain;
    public void DrainCommitted()
    {
        if (Disposed) DisposedBeforeDrain = true;
        Thread.Sleep(DrainFor);
        Interlocked.Increment(ref DrainCalls);
    }
    public void Dispose() => Disposed = true;
}

/// <summary>SqlService plus test.summary: a summary budget taken at once and answered only when the check says so, as a
/// summary of a thousand result sets is still being serialized when a close from another tab is answered.</summary>
internal sealed class HeldSummary(SqlService service, ManualResetEventSlim taken, ManualResetEventSlim release) : IRequestDispatcher
{
    public IReadOnlyList<string> Methods { get; } = [.. service.Methods, "test.summary"];
    public RequestLane LaneOf(string method) => method == "test.summary" ? RequestLane.Query : service.LaneOf(method);
    public bool AnswersStop(string method) => service.AnswersStop(method);
    public bool Sensitive(string method) => service.Sensitive(method);
    public (long GlobalBytes, long QueryBytes) ResultBudget => service.ResultBudget;

    public async Task<object> DispatchAsync(string method, JsonElement parameters, JsonSerializerOptions json, RequestContext? context)
    {
        if (method != "test.summary") return await service.DispatchAsync(method, parameters, json, context);
        var budget = service.SummaryBudget();
        taken.Set();
        await Task.Run(() => release.Wait(10_000));
        return new { Budget = budget };
    }

    public void CancelAll() => service.CancelAll();
    public void DrainCommitted() => service.DrainCommitted();
    public void Dispose() => service.Dispose();
}

/// <summary>A ProtocolHost on its own thread, spoken to through anonymous pipes as main would.</summary>
internal sealed class HostHarness : IDisposable
{
    private readonly AnonymousPipeServerStream toHost = new(PipeDirection.Out);
    private readonly AnonymousPipeClientStream hostInput;
    private readonly AnonymousPipeServerStream fromHost = new(PipeDirection.In);
    private readonly AnonymousPipeClientStream hostOutput;
    private readonly BlockingCollection<(Frame Frame, long Arrival)> incoming = new();
    private readonly List<(Frame Frame, long Arrival)> held = [];
    private readonly Thread hostThread;
    private long arrivals;

    /// <param name="dispatcher">Replaces the stub dispatcher, for example with a SqlService.</param>
    /// <param name="valve">Puts a <see cref="ValveStream"/> in front of the pipe the frames are read from.</param>
    public HostHarness(HostOptions? options = null, Stream? output = null, Func<IRequestDispatcher>? dispatcher = null, bool valve = false)
    {
        hostInput = new AnonymousPipeClientStream(PipeDirection.In, toHost.ClientSafePipeHandle);
        hostOutput = new AnonymousPipeClientStream(PipeDirection.Out, fromHost.ClientSafePipeHandle);
        if (valve && output is null) Valve = new ValveStream(hostOutput);
        Host = new ProtocolHost(hostInput, output ?? Valve ?? (Stream)hostOutput, () => { Dispatcher.Created = true; return dispatcher?.Invoke() ?? Dispatcher; }, HostChecks.Json,
            (options ?? new HostOptions()) with { Exit = code => { Exits.Enqueue(code); Exited.Set(); }, Diagnostic = _ => { } });
        hostThread = new Thread(() => Host.Run()) { IsBackground = true, Name = "test-host" };
        hostThread.Start();
        if (output is null) new Thread(ReadFrames) { IsBackground = true }.Start();
    }

    public ProtocolHost Host { get; }
    public ValveStream? Valve { get; }
    public StubDispatcher Dispatcher { get; } = new();
    public ConcurrentQueue<int> Exits { get; } = new();
    public ManualResetEventSlim Exited { get; } = new();

    private void ReadFrames()
    {
        var reader = new FrameReader(fromHost, FrameDirection.ToMain, 16 * 1024 * 1024);
        try { while (reader.Read() is { } frame) incoming.Add((frame, Interlocked.Increment(ref arrivals))); }
        catch (Exception error) when (error is IOException or ObjectDisposedException or ProtocolException) { }
        incoming.CompleteAdding();
    }

    public void Send(FrameKind kind, uint id, uint arg, ReadOnlySpan<byte> body)
    {
        try
        {
            toHost.Write(Frames.Encode(kind, id, arg, body));
            toHost.Flush();
        }
        catch (IOException) { /* The host may already have exited. */ }
    }

    public void Request(uint id, string method, object parameters, uint deadline = 0, long? credit = null) =>
        Send(FrameKind.Request, id, deadline, credit is null
            ? JsonBridge.Encode(new { Method = method, Params = parameters }, HostChecks.Json)
            : JsonBridge.Encode(new { Method = method, Params = parameters, Credit = credit }, HostChecks.Json));

    public JsonElement Hello()
    {
        Send(FrameKind.Hello, 0, 0, JsonBridge.Encode(new { Versions = new[] { 2, 2 }, Generation = 3, MaxFrameBytes = 16 * 1024 * 1024, App = "checks" }, HostChecks.Json));
        return JsonBridge.ParseControl(Next(FrameKind.Hello)!.Value.Body);
    }

    /// <summary>The next frame of a kind; frames of other kinds stay queued in arrival order.</summary>
    public Frame? Next(FrameKind kind, int timeoutMs = 5000)
    {
        var deadline = Environment.TickCount64 + timeoutMs;
        while (true)
        {
            var index = held.FindIndex(item => item.Frame.Header.Kind == kind);
            if (index >= 0)
            {
                var found = held[index];
                held.RemoveAt(index);
                arrivalOf[found.Frame.Body] = found.Arrival;
                return found.Frame;
            }
            var remaining = deadline - Environment.TickCount64;
            if (remaining <= 0 || !incoming.TryTake(out var next, (int)remaining)) return null;
            held.Add(next);
        }
    }

    private readonly Dictionary<byte[], long> arrivalOf = new(ReferenceEqualityComparer.Instance);
    public long ArrivalOf(Frame frame) => arrivalOf.TryGetValue(frame.Body, out var arrival) ? arrival : -1;

    public void CloseInput() => toHost.Dispose();

    public void Dispose()
    {
        Valve?.Open();
        toHost.Dispose();
        hostThread.Join(5000);
        // Closing the write end first ends the frame reader's blocked read.
        hostOutput.Dispose();
        hostInput.Dispose();
        fromHost.Dispose();
    }
}

/// <summary>Passes writes through, but holds them while shut, as when main stops reading the backend's stdout.</summary>
internal sealed class ValveStream(Stream inner) : Stream
{
    private readonly ManualResetEventSlim open = new(true);
    private int blocked;
    /// <summary>A write is waiting for the valve to open.</summary>
    public bool Blocked => Volatile.Read(ref blocked) != 0;
    public void Shut() => open.Reset();
    public void Open() => open.Set();
    public override void Write(byte[] buffer, int offset, int count)
    {
        if (!open.IsSet) Volatile.Write(ref blocked, 1);
        open.Wait();
        Volatile.Write(ref blocked, 0);
        inner.Write(buffer, offset, count);
    }
    public override void Flush() => inner.Flush();
    public override bool CanRead => false;
    public override bool CanSeek => false;
    public override bool CanWrite => true;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
}
