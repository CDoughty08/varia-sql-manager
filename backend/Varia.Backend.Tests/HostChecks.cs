using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using System.Text.Json.Serialization;
using Varia.Backend.Protocol;

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

            host.Request(2, "test.wait", new { });
            Thread.Sleep(50);
            host.Send(FrameKind.Cancel, 2, 1, []);
            var cancelled = host.Next(FrameKind.Response);
            check(cancelled?.Header.Id == 2 && ErrorCode(cancelled.Value) == "CANCELLED", "CANCEL answers a unary request CANCELLED");

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

            for (var id = 10u; id < 18; id++) host.Request(id, "test.slow", new { ms = 1500 });
            Thread.Sleep(100);
            watch.Restart();
            host.Send(FrameKind.Ping, 0, 4242, []);
            var pong = host.Next(FrameKind.Pong);
            check(pong?.Header.Arg == 4242 && watch.ElapsedMilliseconds < 500, "PING is answered by the reader thread while every metadata slot is busy");

            host.Request(20, "test.wait", new { });
            Thread.Sleep(100);
            host.CloseInput();
            check(host.Exited.Wait(5000) && host.Exits.TryPeek(out var code) && code == 0 && host.Dispatcher.CancelAllCalls == 1 && host.Dispatcher.Disposed,
                "stdin EOF cancels everything, disposes the service and exits 0");
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
            check(goAway is { } frame && Body(frame).GetProperty("code").GetString() == "PROTOCOL_ERROR" && host.Exits.TryPeek(out var code) && code == 64, "no HELLO in time is GOAWAY PROTOCOL_ERROR and exit 64");
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
                && !Body(frame).GetProperty("message").GetString()!.Contains("private detail") && host.Exits.TryPeek(out var code) && code == 70,
                "an unhandled exception is a GOAWAY BACKEND_CRASH naming only the exception type, and exit 70");
        }

        using (var host = new HostHarness(output: new BrokenStream()))
        {
            host.Send(FrameKind.Hello, 0, 0, JsonBridge.Encode(new { versions = new[] { 2, 2 }, generation = 1 }, Json));
            check(host.Exited.Wait(5000) && host.Exits.TryPeek(out var code) && code == 0, "a broken stdout (main gone) exits 0");
        }

        OutboundChecks(check);

        // HELLO announces MethodNames and main refuses a backend missing any of its methods, so every name must dispatch.
        using var service = new SqlService();
        var undispatched = new List<string>();
        foreach (var method in SqlService.MethodNames)
        {
            try { service.DispatchAsync(method, JsonDocument.Parse("{}").RootElement, Json).GetAwaiter().GetResult(); }
            catch (RequestException error) when (error.Code == "METHOD_NOT_FOUND") { undispatched.Add(method); }
            catch (Exception) { /* Empty parameters are invalid for most methods; any other failure means it was dispatched. */ }
        }
        check(undispatched.Count == 0 && service.LaneOf("query.execute") == RequestLane.Query && service.LaneOf("tables.list") == RequestLane.Metadata
            && service.LaneOf("query.cancel") == RequestLane.Control && service.LaneOf("no.such.method") == RequestLane.Control,
            "every method announced in HELLO is dispatched, on its lane: " + string.Join(", ", undispatched));
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

    /// <summary>A stdout whose reader is gone (EPIPE).</summary>
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
    public bool Disposed;
    public bool Created;
    public IReadOnlyList<string> Methods { get; } = ["test.echo", "test.slow", "test.wait", "test.stream"];
    public RequestLane LaneOf(string method) => method switch { "test.slow" => RequestLane.Metadata, "test.stream" => RequestLane.Results, _ => RequestLane.Control };
    public (long GlobalBytes, long QueryBytes) ResultBudget => (256L << 20, 128L << 20);

    public async Task<object> DispatchAsync(string method, JsonElement parameters, JsonSerializerOptions json, RequestContext? context)
    {
        switch (method)
        {
            case "test.echo": return parameters;
            case "test.slow":
                await Task.Delay(parameters.GetProperty("ms").GetInt32());
                Interlocked.Increment(ref Completed);
                return new { Done = true };
            case "test.wait":
                await Task.Delay(Timeout.Infinite, context!.Token);
                return new { };
            case "test.stream":
                var pages = parameters.GetProperty("pages").GetInt32();
                for (var page = 1; page <= pages; page++)
                {
                    var body = new byte[parameters.GetProperty("bytes").GetInt32()];
                    Array.Fill(body, (byte)page);
                    await context!.SendDataAsync(body);
                }
                return new { Pages = pages };
            default: throw new RequestException("METHOD_NOT_FOUND", "Unsupported backend method.");
        }
    }

    public void CancelAll() => Interlocked.Increment(ref CancelAllCalls);
    public void Dispose() => Disposed = true;
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

    public HostHarness(HostOptions? options = null, Stream? output = null)
    {
        hostInput = new AnonymousPipeClientStream(PipeDirection.In, toHost.ClientSafePipeHandle);
        hostOutput = new AnonymousPipeClientStream(PipeDirection.Out, fromHost.ClientSafePipeHandle);
        Host = new ProtocolHost(hostInput, output ?? hostOutput, () => { Dispatcher.Created = true; return Dispatcher; }, HostChecks.Json,
            (options ?? new HostOptions()) with { Exit = code => { Exits.Enqueue(code); Exited.Set(); }, Diagnostic = _ => { } });
        hostThread = new Thread(() => Host.Run()) { IsBackground = true, Name = "test-host" };
        hostThread.Start();
        if (output is null) new Thread(ReadFrames) { IsBackground = true }.Start();
    }

    public ProtocolHost Host { get; }
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
        toHost.Dispose();
        hostThread.Join(5000);
        // Closing the write end first ends the frame reader's blocked read.
        hostOutput.Dispose();
        hostInput.Dispose();
        fromHost.Dispose();
    }
}
