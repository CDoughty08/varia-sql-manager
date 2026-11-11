using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Varia.Backend.Common;
using Varia.Backend.Language;

namespace Varia.Backend.Tests;

internal static class LspTransportChecks
{
    public const string FixtureArgument = "--lsp-transport-fixture";
    private static readonly TimeSpan CheckWait = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan StartupWait = TimeSpan.FromSeconds(60);

    public static async Task RunAsync(Action<bool, string> check)
    {
        var unicode = JsonSerializer.SerializeToUtf8Bytes(new { jsonrpc = "2.0", result = "hello \U0001f680 \u4e16\u754c" }, new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping });
        await using (var split = new FragmentedStream(Frame(unicode)))
        {
            var decoded = await LspClient.ReadMessageAsync(split, CancellationToken.None);
            check(decoded.GetProperty("result").GetString() == "hello \U0001f680 \u4e16\u754c", "LSP framing counts UTF-8 bytes and accepts fragmented reads");
        }
        foreach (var header in new[]
        {
            "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}", "Content-Type: application/json\r\n\r\n{}",
            "Content-Length: -1\r\n\r\n", "Content-Length: " + (LspClient.MaxMessageBytes + 1) + "\r\n\r\n",
            new string('x', LspClient.MaxHeaderBytes + 1), "Content-Length: 5\r\n\r\n{}", "Content-Length: 1\r\n\r\nx"
        })
        {
            var rejected = false;
            try { await LspClient.ReadMessageAsync(new MemoryStream(Encoding.ASCII.GetBytes(header)), CancellationToken.None); }
            catch (Exception error) when (error is IOException or JsonException) { rejected = true; }
            check(rejected, "LSP framing rejects malformed, oversized, or incomplete frames");
        }
        var relativeRejected = false;
        try { using var invalid = new LspClient("language-server.exe"); }
        catch (ArgumentException) { relativeRejected = true; }
        check(relativeRejected, "LSP process launch requires an existing absolute executable path");

        var path = Environment.ProcessPath ?? throw new Exception("The check program's path is unknown.");
        List<string> arguments = [];
        if (Path.GetFileNameWithoutExtension(path).Equals("dotnet", StringComparison.OrdinalIgnoreCase)) arguments.Add(typeof(LspTransportChecks).Assembly.Location);
        arguments.Add(FixtureArgument);
        var reentered = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        LspClient client = null!;
        // No time for other writers: the cancel below finds the write gate free, and must then be sent however little of
        // its budget is left. The budget once covered the whole send, and a starved runner spent it before the gate.
        client = new LspClient(path, arguments, async (method, parameters) =>
        {
            if (method == "fixture/reenter")
            {
                var answer = await client.RequestAsync("echo", new { text = parameters.GetProperty("text").GetString() }, timeout: CheckWait);
                reentered.TrySetResult(answer.GetProperty("text").GetString()!);
                throw new InvalidOperationException("A provider callback can fail without taking down the reader.");
            }
            if (method == "fixture/cancelled") cancelled.TrySetResult();
        }) { CancelGateWait = TimeSpan.Zero };
        await using (client)
        {
            // Cold CLR/apphost startup is unrelated to framing correctness and can take much longer when the stress
            // runner pins five copies to three CPUs. Every wait still returns as soon as the expected event arrives.
            var echo = await client.RequestAsync("echo", new { text = "SQL \U0001f680" }, timeout: StartupWait);
            check(echo.GetProperty("text").GetString() == "SQL \U0001f680", "LSP client sends UTF-8 requests and pairs responses by id");
            var concurrent = await Task.WhenAll(Enumerable.Range(0, 24).Select(index => client.RequestAsync("echo", new { index }, timeout: CheckWait)));
            check(concurrent.Select((answer, index) => answer.GetProperty("index").GetInt32() == index).All(same => same), "LSP concurrent writers preserve complete frames and distinct request ids");
            await client.RequestAsync("reenter", null, timeout: CheckWait);
            check(await reentered.Task.WaitAsync(CheckWait) == "callback", "LSP notification callbacks can make requests without blocking response reads");
            check((await client.RequestAsync("configuration", null, timeout: CheckWait)).GetBoolean(), "LSP workspace/configuration answers one null per requested item");
            check((await client.RequestAsync("unsupported", null, timeout: CheckWait)).GetBoolean(), "LSP unsupported server requests receive method-not-found responses");
            check((await client.RequestAsync("stderr", null, timeout: CheckWait)).GetBoolean(), "LSP drains child stderr without blocking protocol responses");
            var safeError = false;
            try { await client.RequestAsync("error", null, timeout: CheckWait); }
            catch (LspResponseException error) { safeError = error.Code == -32602 && !error.Message.Contains("secret", StringComparison.Ordinal); }
            check(safeError, "LSP errors retain the error code without disclosing server error text");
            var timedOut = false;
            try { await client.RequestAsync("hang", null, timeout: TimeSpan.FromMilliseconds(100)); }
            catch (TimeoutException) { timedOut = true; }
            await cancelled.Task.WaitAsync(CheckWait);
            check(timedOut, "LSP request deadlines send a cancel notification, whatever is left of its budget, and release pending requests");
            using var cancel = new CancellationTokenSource();
            var hanging = client.RequestAsync("hang", null, cancel.Token, CheckWait);
            cancel.Cancel();
            var callerCancelled = false;
            try { await hanging; }
            catch (OperationCanceledException) { callerCancelled = true; }
            check(callerCancelled, "LSP caller cancellation settles a pending request");
            var pending = client.RequestAsync("hang", null, timeout: CheckWait);
            var exiting = client.RequestAsync("exit", null, timeout: CheckWait);
            var lost = 0;
            foreach (var request in new[] { pending, exiting })
                try { await request.WaitAsync(CheckWait); }
                catch (IOException) { lost++; }
            var completionLost = false;
            try { await client.Completion; }
            catch (IOException) { completionLost = true; }
            check(lost == 2 && completionLost, "LSP child exit faults every pending request and the provider completion task");
        }
        await using var disposed = new LspClient(path, arguments);
        disposed.Dispose();
        check(disposed.Completion.IsCompletedSuccessfully, "LSP expected disposal completes without a process-loss fault");
        await using (var malformed = new LspClient(path, arguments))
        {
            await malformed.RequestAsync("echo", new { }, timeout: StartupWait);
            var waiting = malformed.RequestAsync("hang", null, timeout: CheckWait);
            var invalid = malformed.RequestAsync("malformed", null, timeout: CheckWait);
            var failed = 0;
            foreach (var request in new[] { waiting, invalid })
                try { await request.WaitAsync(CheckWait); }
                catch (IOException) { failed++; }
            check(failed == 2, "LSP malformed response fields fail the transport without stranding their pending waiter");
        }
        await using (var bounded = new LspClient(path, arguments))
        {
            // Warm up the child before testing the cap, without depending on process startup timing.
            await bounded.RequestAsync("echo", new { }, timeout: StartupWait);
            var waiting = Enumerable.Range(0, LspClient.MaxPending).Select(_ => bounded.RequestAsync("hang", null, timeout: CheckWait)).ToArray();
            var refused = false;
            try { await bounded.RequestAsync("hang", null, timeout: CheckWait); }
            catch (IOException) { refused = true; }
            bounded.Dispose();
            foreach (var request in waiting)
                try { await request.WaitAsync(CheckWait); }
                catch (Exception error) when (error is IOException or ObjectDisposedException) { }
            check(refused, "LSP pending requests have a strict capacity and disposal releases all slots");
        }
        // A read of the child's stdout that is in flight when the client is disposed can still complete with data. Dispose
        // used to dispose the reader's BufferedStream under it, which drops the buffer the read then copies from, and the
        // reader died of an ArgumentOutOfRangeException that left DisposeAsync.
        HeldReadStream? holding = null;
        var racing = new LspClient(path, arguments, readThrough: stream => holding = new HeldReadStream(stream));
        try
        {
            await racing.RequestAsync("echo", new { }, timeout: StartupWait);
            holding!.Hold();
            // The fixture answers a cancel with a notification: bytes for the reader without a request waiting on them.
            await racing.NotifyAsync("$/cancelRequest", new { id = 0 });
            await holding.Held.WaitAsync(CheckWait);
            racing.Dispose();
            holding.Release();
            var readerSurvived = true;
            try { await racing.DisposeAsync(); }
            catch (Exception) { readerSurvived = false; }
            check(readerSurvived && racing.Completion.IsCompletedSuccessfully, "LSP disposal leaves a read that completes after it to the reader");
        }
        finally { racing.Dispose(); holding?.Release(); }
        // .NET's tree kill stops the child (SIGSTOP), lists its children and then kills it. A Dispose that found another
        // thread's stop under way used to return at once and release the process handle, and the backend's exit could land
        // inside the kill; either left the child stopped for good. Both now wait at the gate until the kill has ended.
        var gate = new ExitGate();
        using var killing = new ManualResetEventSlim();
        using var disposeReturned = new ManualResetEventSlim();
        using var exited = new ManualResetEventSlim();
        using var entered = new CountdownEvent(2);
        bool overtaken = true, killEnded = false;
        await using (var held = new LspClient(path, arguments, kill: child =>
        {
            killing.Set();
            // At least two, not exactly: on a starved pool the request's own write can still be in flight when its answer
            // stops the transport, and that write then fails and waits here as a third caller.
            SpinWait.SpinUntil(() => entered.IsSet && gate.Waiting >= 2 || disposeReturned.IsSet || exited.IsSet, CheckWait);
            overtaken = disposeReturned.IsSet || exited.IsSet;
            child.Kill(entireProcessTree: true);
            killEnded = true;
        }, exitGate: gate))
        {
            await held.RequestAsync("echo", new { }, timeout: StartupWait);
            // The reader stops the transport on the malformed answer, with the child still running.
            var failing = held.RequestAsync("malformed", null, timeout: CheckWait);
            var started = killing.Wait(CheckWait);
            bool killedBeforeDisposeReturned = false, killedBeforeExit = false;
            var disposer = new Thread(() => { entered.Signal(); held.Dispose(); killedBeforeDisposeReturned = killEnded; disposeReturned.Set(); }) { IsBackground = true };
            var exiter = new Thread(() => { entered.Signal(); gate.Exit(_ => { killedBeforeExit = killEnded; exited.Set(); }, 0); }) { IsBackground = true };
            if (started) { disposer.Start(); exiter.Start(); }
            var settled = started && disposeReturned.Wait(CheckWait) && exited.Wait(CheckWait);
            try { await failing.WaitAsync(CheckWait); } catch (IOException) { }
            check(settled && !overtaken && killedBeforeDisposeReturned && killedBeforeExit, "LSP disposal and the backend's exit wait for a tree kill another thread has under way");
        }
        // The gate cannot cover a backend that main kills (SIGKILL) inside a tree kill, which left the SQL Tools Service stopped
        // and retained-plans-smoke waiting 45 s for the app's pipes. Off Windows the kill is therefore one signal, with no
        // stopped state in between; this child must still be ended by it.
        var plainStart = new ProcessStartInfo(path) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var argument in arguments) plainStart.ArgumentList.Add(argument);
        using var plain = Process.Start(plainStart)!;
        LspClient.Kill(plain);
        check(LspClient.KillsTree == OperatingSystem.IsWindows() && plain.WaitForExit(CheckWait),
            "a language server is killed with its tree only on Windows; elsewhere by one signal that cannot leave it stopped, and the kill ends it");
    }

    /// <summary>A real stdio child, dispatched by Program before the regular test suite.</summary>
    public static async Task FixtureAsync()
    {
        var output = Console.OpenStandardOutput();
        Console.SetOut(Console.Error);
        var input = Console.OpenStandardInput();
        JsonElement? awaiting = null;
        var awaitingMethod = "";
        async Task Send(object value)
        {
            await output.WriteAsync(Frame(JsonSerializer.SerializeToUtf8Bytes(value)));
            await output.FlushAsync();
        }
        while (true)
        {
            JsonElement message;
            try { message = await LspClient.ReadMessageAsync(input, CancellationToken.None); }
            catch (EndOfStreamException) { return; }
            if (!message.TryGetProperty("method", out var methodValue))
            {
                var result = awaitingMethod == "configuration"
                    ? message.TryGetProperty("result", out var configuration) && configuration.ValueKind == JsonValueKind.Array && configuration.GetArrayLength() == 2 && configuration.EnumerateArray().All(item => item.ValueKind == JsonValueKind.Null)
                    : message.TryGetProperty("error", out var error) && error.GetProperty("code").GetInt32() == -32601;
                await Send(new { jsonrpc = "2.0", id = awaiting!.Value, result });
                awaiting = null;
                continue;
            }
            var method = methodValue.GetString();
            if (method == "$/cancelRequest")
            {
                await Send(new { jsonrpc = "2.0", method = "fixture/cancelled", @params = new { } });
                continue;
            }
            if (!message.TryGetProperty("id", out var id)) continue;
            switch (method)
            {
                case "echo": await Send(new { jsonrpc = "2.0", id, result = message.GetProperty("params") }); break;
                case "reenter":
                    await Send(new { jsonrpc = "2.0", method = "fixture/reenter", @params = new { text = "callback" } });
                    await Send(new { jsonrpc = "2.0", id, result = true }); break;
                case "configuration":
                case "unsupported":
                    awaiting = id.Clone(); awaitingMethod = method;
                    await Send(new { jsonrpc = "2.0", id = "server-request", method = method == "configuration" ? "workspace/configuration" : "fixture/unknown", @params = new { items = new[] { new { section = "a" }, new { section = "b" } } } });
                    break;
                case "stderr":
                    await Console.Error.WriteAsync(new string('x', 20_000));
                    await Console.Error.FlushAsync();
                    await Send(new { jsonrpc = "2.0", id, result = true }); break;
                case "error": await Send(new { jsonrpc = "2.0", id, error = new { code = -32602, message = "secret password and SQL" } }); break;
                case "malformed": await Send(new { jsonrpc = "2.0", id, error = new { code = "invalid" } }); break;
                case "exit": return;
                case "hang": break;
            }
        }
    }

    private static byte[] Frame(byte[] body) => [.. Encoding.ASCII.GetBytes("Content-Length: " + body.Length + "\r\n\r\n"), .. body];

    /// <summary>Holds back one read that has already taken bytes from the child, as a starved thread pool does.</summary>
    private sealed class HeldReadStream(Stream inner) : Stream
    {
        private readonly TaskCompletionSource held = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource released = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int holdNext;

        public Task Held => held.Task;
        public void Hold() => Volatile.Write(ref holdNext, 1);
        public void Release() => released.TrySetResult();

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default)
        {
            var count = await inner.ReadAsync(buffer, token);
            if (count > 0 && Interlocked.Exchange(ref holdNext, 0) == 1)
            {
                held.TrySetResult();
                await released.Task;
            }
            return count;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) inner.Dispose(); base.Dispose(disposing); }
    }

    private sealed class FragmentedStream(byte[] bytes) : MemoryStream(bytes)
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) => base.ReadAsync(buffer[..Math.Min(buffer.Length, 3)], token);
    }
}
