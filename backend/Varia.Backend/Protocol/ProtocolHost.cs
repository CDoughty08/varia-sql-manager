using System.Buffers;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Protocol;

/// <summary>What the host dispatches requests to: SqlService in the application, a stub in the checks.</summary>
internal interface IRequestDispatcher : IDisposable
{
    /// <summary>Every method name, announced in HELLO so main can detect a stale build.</summary>
    IReadOnlyList<string> Methods { get; }
    RequestLane LaneOf(string method);
    (long GlobalBytes, long QueryBytes) ResultBudget { get; }
    Task<object> DispatchAsync(string method, JsonElement parameters, JsonSerializerOptions json, RequestContext? context);
    void CancelAll();
}

internal sealed record HostOptions
{
    public TimeSpan HelloTimeout { get; init; } = TimeSpan.FromSeconds(20);
    public TimeSpan DrainTimeout { get; init; } = TimeSpan.FromMilliseconds(1500);
    public TimeSpan MetadataWait { get; init; } = TimeSpan.FromSeconds(30);
    public int MaxInFlight { get; init; } = 288;
    public int MetadataSlots { get; init; } = 8;
    public int ResultSlots { get; init; } = 16;
    /// <summary>Ends the process; the checks record the code instead.</summary>
    public Action<int> Exit { get; init; } = Environment.Exit;
    /// <summary>Fixed-format diagnostics only: never SQL, messages, server names or connection strings.</summary>
    public Action<string> Diagnostic { get; init; } = line => Console.Error.WriteLine(line);
}

/// <summary>Protocol v2 over stdio. A dedicated reader thread validates every frame, answers PING itself (so liveness
/// survives thread-pool starvation by synchronous SMO calls) and dispatches requests as tasks; Outbound owns stdout.
/// Exit codes: 0 normal, 64 protocol error from main, 65 unsupported version, 70 crash.</summary>
internal sealed class ProtocolHost
{
    public const int ExitProtocolError = 64;
    public const int ExitUnsupported = 65;
    public const int ExitCrash = 70;
    private const int MaxMethodBytes = 64;
    private const int MaxErrorCharacters = 16384;
    private readonly FrameReader reader;
    private readonly Outbound outbound;
    private readonly Func<IRequestDispatcher> createDispatcher;
    private readonly JsonSerializerOptions json;
    private readonly HostOptions options;
    private readonly ConcurrentDictionary<uint, RequestContext> contexts = new();
    private readonly ConcurrentDictionary<Task, byte> work = new();
    private readonly SemaphoreSlim metadataSlots;
    private readonly SemaphoreSlim resultSlots;
    private IRequestDispatcher? dispatcher;
    private int responseLimit = ProtocolLimits.ResponseBody;
    private int exitCode = -1;
    private int helloState;

    public ProtocolHost(Stream input, Stream output, Func<IRequestDispatcher> createDispatcher, JsonSerializerOptions json, HostOptions? options = null)
    {
        this.options = options ?? new HostOptions();
        reader = new FrameReader(input, FrameDirection.ToBackend, ProtocolLimits.RequestBody);
        outbound = new Outbound(output, () => Terminate(0));
        this.createDispatcher = createDispatcher;
        this.json = json;
        metadataSlots = new SemaphoreSlim(this.options.MetadataSlots);
        resultSlots = new SemaphoreSlim(this.options.ResultSlots);
    }

    /// <summary>Requests registered and not yet finished (a settled request still counts until its work ends).</summary>
    public int InFlight => contexts.Count;

    /// <summary>Runs the reader loop until stdin ends or main breaks the protocol; returns the exit code.</summary>
    public int Run()
    {
        outbound.Start();
        using var helloTimer = new Timer(_ =>
        {
            if (Interlocked.CompareExchange(ref helloState, 2, 0) == 0) Fatal("PROTOCOL_ERROR", "No HELLO was received.", ExitProtocolError, "hello timeout");
        }, null, options.HelloTimeout, Timeout.InfiniteTimeSpan);
        try
        {
            var first = reader.Read();
            if (first is null || Interlocked.CompareExchange(ref helloState, 1, 0) != 0) return Shutdown();
            if (first.Value.Header.Kind != FrameKind.Hello || first.Value.Oversize) return Fatal("PROTOCOL_ERROR", "The first frame must be HELLO.", ExitProtocolError, "frame before hello");
            if (Hello(first.Value.Body) is { } refused) return refused;
            while (reader.Read() is { } frame)
            {
                if (Volatile.Read(ref exitCode) >= 0) break;
                if (Handle(frame) is { } fatal) return fatal;
            }
        }
        catch (ProtocolException error) { return Fatal("PROTOCOL_ERROR", "Invalid frame from main (" + error.Code + ").", ExitProtocolError, "protocol " + error.Code); }
        catch (IOException) { /* stdin failed: main is gone, exactly like EOF. */ }
        return Shutdown();
    }

    /// <summary>Called from AppDomain.UnhandledException: a best-effort GOAWAY naming only the exception type, then exit 70.</summary>
    public void Crash(object? exception)
    {
        var type = exception?.GetType().Name ?? "Exception";
        options.Diagnostic("varia-backend: unhandled " + type + Where(exception as Exception));
        Fatal("BACKEND_CRASH", "The SQL backend failed unexpectedly (" + type + ").", ExitCrash, null);
    }

    private int? Hello(byte[] body)
    {
        JsonElement hello;
        try { hello = JsonBridge.ParseControl(body); }
        catch (ProtocolException error) { return Fatal("PROTOCOL_ERROR", "Invalid HELLO (" + error.Code + ").", ExitProtocolError, "hello " + error.Code); }
        if (hello.ValueKind != JsonValueKind.Object || !hello.TryGetProperty("versions", out var versions) || versions.ValueKind != JsonValueKind.Array || versions.GetArrayLength() != 2
            || !versions[0].TryGetInt32(out var min) || !versions[1].TryGetInt32(out var max) || min > max
            || !hello.TryGetProperty("generation", out var generationValue) || !generationValue.TryGetUInt32(out var generation))
            return Fatal("PROTOCOL_ERROR", "Invalid HELLO.", ExitProtocolError, "hello shape");
        if (min > ProtocolLimits.Version || max < ProtocolLimits.Version)
            return Fatal("PROTOCOL_UNSUPPORTED", "The SQL backend speaks protocol " + ProtocolLimits.Version + " only.", ExitUnsupported, "unsupported version", supported: true);
        if (hello.TryGetProperty("maxFrameBytes", out var maxFrame) && maxFrame.TryGetInt32(out var mainLimit) && mainLimit > 0)
            responseLimit = Math.Min(ProtocolLimits.ResponseBody, mainLimit);
        // SqlService (and the SQL client stack) starts only once main has proven it speaks this protocol.
        dispatcher = createDispatcher();
        var budget = dispatcher.ResultBudget;
        var reply = new
        {
            Version = ProtocolLimits.Version, Generation = generation, Pid = Environment.ProcessId,
            Runtime = RuntimeInformation.FrameworkDescription, Platform = RuntimeInformation.OSDescription,
            SqlClientVersion = typeof(SqlConnection).Assembly.GetName().Version?.ToString() ?? "",
            MaxFrameBytes = ProtocolLimits.RequestBody, ResultBudget = new { budget.GlobalBytes, budget.QueryBytes }, Methods = dispatcher.Methods
        };
        outbound.Control(Frames.Encode(FrameKind.Hello, 0, 0, JsonBridge.Encode(reply, json)));
        return null;
    }

    private int? Handle(Frame frame)
    {
        var header = frame.Header;
        switch (header.Kind)
        {
            case FrameKind.Request:
                if (frame.Oversize)
                {
                    // The body was skipped, so framing is intact: answer this id and carry on.
                    Respond(header.Id, Error("TOO_LARGE", "The request is too large for the SQL backend (limit 4 MB)."), stream: false);
                    return null;
                }
                return Request(header, frame.Body);
            case FrameKind.Cancel:
                if (header.Arg is < 1 or > 4) return Fatal("PROTOCOL_ERROR", "Invalid CANCEL reason.", ExitProtocolError, "cancel reason");
                // Unknown or finished ids are ignored: the request may have completed while the CANCEL was in flight.
                if (contexts.TryGetValue(header.Id, out var cancelled)) cancelled.Cancel((CancelReason)header.Arg);
                return null;
            case FrameKind.Credit:
                if (header.Arg is < 1 or > 16 * 1024 * 1024) return Fatal("PROTOCOL_ERROR", "Invalid CREDIT.", ExitProtocolError, "credit");
                if (contexts.TryGetValue(header.Id, out var stream) && stream.IsStream) stream.Grant(header.Arg);
                return null;
            case FrameKind.Ping:
                outbound.Control(Frames.Encode(FrameKind.Pong, 0, header.Arg, []));
                return null;
            default:
                return Fatal("PROTOCOL_ERROR", "Unexpected " + header.Kind + " frame.", ExitProtocolError, "unexpected " + header.Kind);
        }
    }

    private int? Request(FrameHeader header, byte[] body)
    {
        string method;
        int start, length;
        long? credit;
        try { (method, start, length, credit) = Envelope(body); }
        catch (ProtocolException error) { return Fatal("PROTOCOL_ERROR", "Invalid request envelope (" + error.Code + ").", ExitProtocolError, "envelope " + error.Code); }
        if (header.Id == 0 || contexts.ContainsKey(header.Id)) return Fatal("PROTOCOL_ERROR", "Invalid request id.", ExitProtocolError, "request id");
        if (start < 0)
        {
            Respond(header.Id, Error("INVALID_PARAMS", "Invalid request parameters."), stream: false);
            return null;
        }
        if (contexts.Count >= options.MaxInFlight)
        {
            Respond(header.Id, Error("BUSY", "The backend is busy. Retry after a running operation finishes."), stream: credit is not null);
            return null;
        }
        var context = new RequestContext(header.Id, method, dispatcher!.LaneOf(method), header.Arg, credit, Cancelled, SendData, SendEvent);
        contexts[header.Id] = context;
        var task = Task.Run(() => HandleAsync(context, body, start, length));
        work[task] = 0;
        _ = task.ContinueWith(done => work.TryRemove(done, out _), TaskScheduler.Default);
        return null;
    }

    /// <summary>The envelope { method: str ≤ 64 bytes, params: map, credit?: uint }. Only its structure is checked here;
    /// params are transcoded on the request's own task. A malformed value inside params returns start −1: the frame's
    /// length keeps framing intact, so that request is answered INVALID_PARAMS like any other bad parameter.</summary>
    private static (string Method, int Start, int Length, long? Credit) Envelope(byte[] body)
    {
        var reader = new MsgPackReader(body);
        var count = reader.ReadMapHeader();
        if (count is < 2 or > 3) throw new ProtocolException("ENVELOPE", 0);
        string? method = null;
        int start = -1, length = 0;
        long? credit = null;
        for (var i = 0; i < count; i++)
        {
            var at = reader.Consumed;
            var key = reader.ReadStringUtf8();
            if (key.SequenceEqual("method"u8) && method is null)
            {
                var name = reader.ReadStringUtf8();
                if (name.Length is 0 or > MaxMethodBytes) throw new ProtocolException("ENVELOPE", at);
                method = Encoding.UTF8.GetString(name);
            }
            else if (key.SequenceEqual("params"u8) && start < 0)
            {
                if (reader.PeekType() != MsgPackType.Map) throw new ProtocolException("ENVELOPE", at);
                start = reader.Consumed;
                try { reader.Skip(); }
                catch (ProtocolException) { return (method ?? "", -1, 0, null); }
                length = reader.Consumed - start;
            }
            else if (key.SequenceEqual("credit"u8) && credit is null)
            {
                var value = reader.ReadUInt64();
                if (value is < 64 * 1024 or > 16 * 1024 * 1024) throw new ProtocolException("ENVELOPE", at);
                credit = (long)value;
            }
            else throw new ProtocolException("ENVELOPE", at);
        }
        if (method is null || start < 0) throw new ProtocolException("ENVELOPE", 0);
        if (reader.Remaining > 0) throw new ProtocolException("TRAILING", reader.Consumed);
        return (method, start, length, credit);
    }

    private async Task HandleAsync(RequestContext context, byte[] body, int start, int length)
    {
        SemaphoreSlim? slot = null;
        try
        {
            JsonElement parameters;
            var sensitive = context.Method is "connections.connect" or "connections.databases" or "connections.preview";
            try { parameters = JsonBridge.ParseControl(body.AsSpan(start, length), sensitive); }
            catch (ProtocolException) { throw new RequestException("INVALID_PARAMS", "Invalid request parameters."); }
            // The frame body holds the password in clear text; managed strings made from it cannot be zeroed.
            finally { if (sensitive) Array.Clear(body); }
            var lane = context.Lane switch { RequestLane.Metadata => metadataSlots, RequestLane.Results => resultSlots, _ => null };
            if (lane is not null)
            {
                var wait = context.Remaining is { } remaining && remaining < options.MetadataWait ? remaining : options.MetadataWait;
                if (!await lane.WaitAsync(wait, context.Token).ConfigureAwait(false))
                {
                    context.Token.ThrowIfCancellationRequested();
                    throw new RequestException("BUSY", "The backend is busy. Retry after a running operation finishes.");
                }
                slot = lane;
            }
            var result = await dispatcher!.DispatchAsync(context.Method, parameters, json, context).ConfigureAwait(false);
            byte[] answer;
            try { answer = Result(result); }
            catch
            {
                context.Unsent?.Invoke();
                throw;
            }
            Respond(context, answer);
        }
        catch (Exception error) { Respond(context, Failure(context, error)); }
        finally
        {
            // A request answered TIMEOUT keeps its slot until its work really ends (SMO cannot be interrupted).
            slot?.Release();
            contexts.TryRemove(context.Id, out _);
            context.Dispose();
        }
    }

    /// <summary>A unary request answers as soon as it is cancelled or its deadline passes; work that ignores the token
    /// keeps running and its late result is discarded. Queries answer with their summary, and streams after their
    /// current page.</summary>
    private void Cancelled(RequestContext context)
    {
        if (context.Lane == RequestLane.Query || context.IsStream) return;
        Respond(context, CancelledError(context));
    }

    private byte[] CancelledError(RequestContext context) => context.Reason == CancelReason.Expired
        ? Error("TIMEOUT", "The operation exceeded its time limit of " + (context.DeadlineMs + 999) / 1000 + " seconds.")
        : Error("CANCELLED", "The operation was cancelled.");

    private byte[] Failure(RequestContext context, Exception error)
    {
        // SqlClient reports a cancelled command as a SqlException; either way the token says why it stopped.
        if (context.Token.IsCancellationRequested && (error is OperationCanceledException || Find<SqlException>(error) is not null)) return CancelledError(context);
        return error switch
        {
            RequestException request => Error(request.Code, request.Message),
            JsonException => Error("INVALID_PARAMS", "Invalid request parameters."),
            // The operation's own time limit (for example database discovery's 30 seconds), not main's deadline.
            OperationCanceledException => Error("TIMEOUT", "The operation exceeded its time limit."),
            _ when Find<SqlException>(error) is { } sql => Error("SQL_ERROR", sql.Message),
            // SMO wraps server failures (permissions, missing objects) in its own exception types.
            _ when error.GetType().Namespace?.StartsWith("Microsoft.SqlServer.Management", StringComparison.Ordinal) == true => Error("SMO_ERROR", error.GetBaseException().Message),
            _ => Error("BACKEND_ERROR", "The backend operation failed. Verify the connection and object permissions.")
        };
    }

    private byte[] Result(object result)
    {
        var buffer = new ArrayBufferWriter<byte>();
        var writer = new MsgPackWriter(buffer);
        writer.WriteMapHeader(1);
        writer.WriteString("result");
        JsonBridge.FromJson(JsonSerializer.SerializeToUtf8Bytes(result, json), writer, depth: 1);
        if (buffer.WrittenCount > responseLimit) throw new RequestException("RESPONSE_TOO_LARGE", "The backend result is too large to return (limit 16 MB).");
        return buffer.WrittenSpan.ToArray();
    }

    private static byte[] Error(string code, string message)
    {
        var buffer = new ArrayBufferWriter<byte>();
        var writer = new MsgPackWriter(buffer);
        writer.WriteMapHeader(1);
        writer.WriteString("error");
        writer.WriteMapHeader(2);
        writer.WriteString("code");
        writer.WriteString(code);
        writer.WriteString("message");
        writer.WriteString(message.Length > MaxErrorCharacters ? message[..MaxErrorCharacters] : message);
        return buffer.WrittenSpan.ToArray();
    }

    private void Respond(RequestContext context, byte[] body)
    {
        if (context.TrySettle()) Respond(context.Id, body, context.IsStream);
    }

    private void Respond(uint id, byte[] body, bool stream)
    {
        var frame = Frames.Encode(FrameKind.Response, id, 0, body);
        // A stream's terminal RESPONSE follows its DATA frames on the bulk lane.
        if (stream) outbound.Bulk(frame);
        else outbound.Control(frame);
    }

    private void SendData(RequestContext context, uint sequence, byte[] body)
    {
        var header = new byte[FrameHeader.Size];
        new FrameHeader(FrameKind.Data, (uint)body.Length, context.Id, sequence).Write(header);
        outbound.Bulk(header, body);
    }

    private void SendEvent(RequestContext context, object value, bool droppable) => Event(context.Id, value, droppable);

    /// <summary>A global EVENT (id 0), such as results.memory. Always droppable: false when it was not queued (the control
    /// lane is full while main is not reading), so the publisher can send it again later.</summary>
    public bool Publish(object value) => Event(0, value, droppable: true);

    private bool Event(uint id, object value, bool droppable)
    {
        byte[] body;
        try { body = JsonBridge.Encode(value, json); }
        catch (InvalidOperationException) { return false; }
        // Events are best effort and bounded at the source; the summary carries everything that matters.
        if (body.Length > (droppable ? ProtocolLimits.EventBody : ProtocolLimits.EssentialEventBody) || Volatile.Read(ref exitCode) >= 0) return false;
        return outbound.Control(Frames.Encode(FrameKind.Event, id, 0, body), droppable);
    }

    private int Fatal(string code, string message, int exit, string? diagnostic, bool supported = false)
    {
        if (diagnostic is not null) options.Diagnostic("varia-backend: " + diagnostic);
        var buffer = new ArrayBufferWriter<byte>();
        var writer = new MsgPackWriter(buffer);
        writer.WriteMapHeader(supported ? 3 : 2);
        writer.WriteString("code");
        writer.WriteString(code);
        writer.WriteString("message");
        writer.WriteString(message);
        if (supported)
        {
            writer.WriteString("versions");
            writer.WriteArrayHeader(2);
            writer.WriteInt64(ProtocolLimits.Version);
            writer.WriteInt64(ProtocolLimits.Version);
        }
        outbound.Control(Frames.Encode(FrameKind.GoAway, 0, 0, buffer.WrittenSpan));
        return Terminate(exit);
    }

    /// <summary>stdin ended: main closed the pipe or exited. Cancel everything, give work a moment to stop, and end
    /// every session (open transactions roll back when their connections close).</summary>
    private int Shutdown()
    {
        if (Volatile.Read(ref exitCode) >= 0) return exitCode;
        foreach (var context in contexts.Values) context.Cancel(CancelReason.Shutdown);
        try { dispatcher?.CancelAll(); } catch (Exception) { /* Best effort while exiting. */ }
        try { Task.WaitAll([.. work.Keys], options.DrainTimeout); } catch (AggregateException) { }
        // Closing a session can wait on the network; main may already be gone, so never let that keep the process alive.
        var disposed = Task.Run(() => dispatcher?.Dispose());
        try { disposed.Wait(options.DrainTimeout); } catch (AggregateException) { /* Best effort while exiting. */ }
        return Terminate(0);
    }

    private int Terminate(int code)
    {
        if (Interlocked.CompareExchange(ref exitCode, code, -1) != -1) return exitCode;
        outbound.Complete(TimeSpan.FromSeconds(1));
        options.Exit(code);
        return code;
    }

    private static string Where(Exception? error) =>
        error?.TargetSite is { } site ? " at " + (site.DeclaringType?.Name ?? "?") + "." + site.Name : "";

    private static T? Find<T>(Exception? error) where T : Exception
    {
        for (; error is not null; error = error.InnerException) if (error is T match) return match;
        return null;
    }
}
