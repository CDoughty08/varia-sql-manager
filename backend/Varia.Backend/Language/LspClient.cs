using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace Varia.Backend.Language;

/// <summary>The provider's transport seam; document and connection semantics belong to its adapter.</summary>
internal interface ILspClient : IDisposable
{
    Task Completion { get; }
    Task<JsonElement> RequestAsync(string method, object? parameters, CancellationToken token = default, TimeSpan? timeout = null);
    Task NotifyAsync(string method, object? parameters, CancellationToken token = default);
}

/// <summary>Contains no server-supplied error text, which can include SQL or connection details.</summary>
internal sealed class LspResponseException(int code) : IOException("The language server rejected the request.")
{
    public int Code { get; } = code;
}

/// <summary>
/// A bounded LSP JSON-RPC transport over a trusted, locally configured executable's stdio. stdout is protocol only;
/// stderr is drained without logging, since SQL Tools Service can write SQL and credentials there. Reader failures
/// terminate the child and every pending request. Notification callbacks run in order outside the protocol reader,
/// so a callback may itself send a request. This transport does not authorize arbitrary renderer process launches.
/// </summary>
internal sealed class LspClient : ILspClient, IAsyncDisposable
{
    internal const int MaxMessageBytes = 16 * 1024 * 1024;
    internal const int MaxHeaderBytes = 8192;
    internal const int MaxPending = 128;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly TimeSpan WriteTimeout = TimeSpan.FromSeconds(5);
    private readonly Process process;
    private readonly Stream input;
    private readonly Stream output;
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim writes = new(1, 1);
    private readonly SemaphoreSlim slots = new(MaxPending, MaxPending);
    private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonElement>> pending = new();
    private readonly TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly Channel<(string Method, JsonElement Parameters, int Characters)> notifications = Channel.CreateBounded<(string, JsonElement, int)>(
        new BoundedChannelOptions(256) { SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait });
    private readonly Func<string, JsonElement, Task>? notification;
    private readonly Task[] workers;
    private long sequence;
    private int notificationCharacters;
    private int stopped;
    private int disposed;

    public LspClient(string executablePath, IReadOnlyList<string>? arguments = null, Func<string, JsonElement, Task>? notification = null)
    {
        if (string.IsNullOrWhiteSpace(executablePath) || !Path.IsPathFullyQualified(executablePath) || !File.Exists(executablePath))
            throw new ArgumentException("The language server executable must be an existing absolute path.", nameof(executablePath));
        this.notification = notification;
        var start = new ProcessStartInfo(executablePath)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(executablePath)!
        };
        if (arguments is not null) foreach (var argument in arguments) start.ArgumentList.Add(argument);
        process = Process.Start(start) ?? throw new IOException("The language server could not be started.");
        output = process.StandardInput.BaseStream;
        input = new BufferedStream(process.StandardOutput.BaseStream, 16 * 1024);
        workers = [ReadAsync(), NotificationsAsync(), DrainErrorAsync(), WatchExitAsync()];
    }

    /// <summary>Faulted when the server is lost or its protocol is invalid; completed normally on disposal.</summary>
    public Task Completion => completion.Task;

    public async Task<JsonElement> RequestAsync(string method, object? parameters, CancellationToken token = default, TimeSpan? timeout = null)
    {
        CheckMethod(method);
        token.ThrowIfCancellationRequested();
        ThrowIfStopped();
        if (!slots.Wait(0)) throw new IOException("Too many language server requests are pending.");
        var id = Interlocked.Increment(ref sequence);
        var answer = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending.TryAdd(id, answer);
        var sent = false;
        try
        {
            // Closing can race registration. Rechecking also settles a request registered just after Stop enumerated.
            ThrowIfStopped();
            await SendAsync(new { jsonrpc = "2.0", id, method, @params = parameters }, token);
            sent = true;
            return await answer.Task.WaitAsync(timeout ?? TimeSpan.FromSeconds(15), token);
        }
        catch (Exception error) when (error is OperationCanceledException or TimeoutException)
        {
            if (sent && Volatile.Read(ref stopped) == 0) await CancelAsync(id);
            throw;
        }
        finally { pending.TryRemove(id, out _); slots.Release(); }
    }

    public Task NotifyAsync(string method, object? parameters, CancellationToken token = default)
    {
        CheckMethod(method);
        return SendAsync(new { jsonrpc = "2.0", method, @params = parameters }, token);
    }

    private static void CheckMethod(string method)
    {
        if (string.IsNullOrWhiteSpace(method) || method.Length > 256) throw new ArgumentException("Invalid language server method.", nameof(method));
    }

    private void ThrowIfStopped()
    {
        if (Volatile.Read(ref stopped) != 0) throw new IOException("The language server is unavailable.");
    }

    private async Task CancelAsync(long id)
    {
        using var budget = new CancellationTokenSource(TimeSpan.FromSeconds(1));
        try { await NotifyAsync("$/cancelRequest", new { id }, budget.Token); }
        catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException) { }
    }

    private async Task SendAsync(object message, CancellationToken token)
    {
        ThrowIfStopped();
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message, Json);
        try
        {
            if (bytes.Length > MaxMessageBytes) throw new IOException("The language server message exceeds its size limit.");
            await writes.WaitAsync(token);
            try
            {
                ThrowIfStopped();
                // Once a frame begins, caller cancellation must not leave half a frame on the stream. A short internal
                // deadline aborts the entire transport if the child stops reading; cancellation before this point writes none.
                token.ThrowIfCancellationRequested();
                using var budget = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                budget.CancelAfter(WriteTimeout);
                try
                {
                    var header = Encoding.ASCII.GetBytes("Content-Length: " + bytes.Length.ToString(CultureInfo.InvariantCulture) + "\r\n\r\n");
                    await output.WriteAsync(header, budget.Token);
                    await output.WriteAsync(bytes, budget.Token);
                    await output.FlushAsync(budget.Token);
                }
                catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException)
                {
                    Stop(new IOException("The language server stream could not be written."));
                    throw new IOException("The language server stream could not be written.");
                }
            }
            finally { writes.Release(); }
        }
        // A SQL Server connection/connect payload contains the password. Do not retain its serialized byte array after
        // it is sent, or after a cancelled gate wait/serialization-size refusal.
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    private async Task ReadAsync()
    {
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                var message = await ReadMessageAsync(input, lifetime.Token);
                if (message.ValueKind != JsonValueKind.Object || !message.TryGetProperty("jsonrpc", out var rpc) || rpc.GetString() != "2.0")
                    throw new IOException("The language server returned invalid JSON-RPC.");
                if (message.TryGetProperty("method", out var methodValue))
                {
                    var method = methodValue.GetString();
                    if (string.IsNullOrEmpty(method) || method.Length > 256) throw new IOException("The language server returned an invalid method.");
                    var parameters = message.TryGetProperty("params", out var value) ? value.Clone() : JsonSerializer.SerializeToElement<object?>(null);
                    if (message.TryGetProperty("id", out var requestId)) await AnswerServerAsync(requestId.Clone(), method, parameters);
                    else if (notification is not null)
                    {
                        var characters = parameters.GetRawText().Length;
                        if (Interlocked.Add(ref notificationCharacters, characters) > 8 * 1024 * 1024 || !notifications.Writer.TryWrite((method, parameters, characters)))
                            throw new IOException("The language server notification queue exceeded its limit.");
                    }
                    continue;
                }
                if (!message.TryGetProperty("id", out var idValue) || idValue.ValueKind != JsonValueKind.Number || !idValue.TryGetInt64(out var id))
                    throw new IOException("The language server returned an invalid response.");
                // Validate before removing the waiter, so malformed response fields cannot strand it outside Stop's set.
                if (message.TryGetProperty("error", out var error))
                {
                    if (error.ValueKind != JsonValueKind.Object || !error.TryGetProperty("code", out var codeValue) || codeValue.ValueKind != JsonValueKind.Number || !codeValue.TryGetInt32(out var code))
                        throw new IOException("The language server returned an invalid error response.");
                    if (pending.TryRemove(id, out var answer)) answer.TrySetException(new LspResponseException(code));
                }
                else if (message.TryGetProperty("result", out var result))
                {
                    // A timed out/cancelled request may answer later; it owns no pending slot then.
                    if (pending.TryRemove(id, out var answer)) answer.TrySetResult(result.Clone());
                }
                else throw new IOException("The language server response has no result.");
            }
        }
        catch (Exception error) when (error is IOException or JsonException or OperationCanceledException or ObjectDisposedException or InvalidOperationException)
        {
            if (!lifetime.IsCancellationRequested) Stop(new IOException("The language server closed or returned invalid protocol data."));
        }
    }

    private Task AnswerServerAsync(JsonElement id, string method, JsonElement parameters)
    {
        if (id.ValueKind is not (JsonValueKind.String or JsonValueKind.Number)) throw new IOException("The language server returned an invalid request id.");
        if (method == "workspace/configuration")
        {
            // No workspace settings are disclosed to a child. Match one null answer per requested configuration item.
            var count = parameters.ValueKind == JsonValueKind.Object && parameters.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array ? items.GetArrayLength() : 0;
            if (count > 256) throw new IOException("The language server requested too many configuration items.");
            return SendAsync(new { jsonrpc = "2.0", id, result = new object?[count] }, lifetime.Token);
        }
        if (method is "client/registerCapability" or "client/unregisterCapability" or "window/workDoneProgress/create")
            return SendAsync(new { jsonrpc = "2.0", id, result = (object?)null }, lifetime.Token);
        return SendAsync(new { jsonrpc = "2.0", id, error = new { code = -32601, message = "Method not supported." } }, lifetime.Token);
    }

    internal static async Task<JsonElement> ReadMessageAsync(Stream stream, CancellationToken token)
    {
        var header = new byte[MaxHeaderBytes];
        var single = new byte[1];
        var length = 0;
        while (true)
        {
            if (length == header.Length) throw new IOException("The language server header exceeds its size limit.");
            if (await stream.ReadAsync(single, token) == 0) throw new EndOfStreamException("The language server stream closed.");
            var next = single[0];
            if (next > 127 || next == 0) throw new IOException("The language server header is invalid.");
            header[length++] = next;
            if (length >= 4 && header[length - 4] == '\r' && header[length - 3] == '\n' && header[length - 2] == '\r' && header[length - 1] == '\n') break;
        }
        int? bodyLength = null;
        foreach (var line in Encoding.ASCII.GetString(header, 0, length - 4).Split("\r\n", StringSplitOptions.None))
        {
            var colon = line.IndexOf(':');
            if (colon <= 0) throw new IOException("The language server header is invalid.");
            if (!line[..colon].Equals("Content-Length", StringComparison.OrdinalIgnoreCase)) continue;
            if (bodyLength is not null || !int.TryParse(line[(colon + 1)..].Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var count) || count <= 0 || count > MaxMessageBytes)
                throw new IOException("The language server content length is invalid.");
            bodyLength = count;
        }
        if (bodyLength is null) throw new IOException("The language server content length is missing.");
        var body = new byte[bodyLength.Value];
        try
        {
            await stream.ReadExactlyAsync(body, token);
            using var document = JsonDocument.Parse(body, new JsonDocumentOptions { MaxDepth = 128 });
            return document.RootElement.Clone();
        }
        finally { CryptographicOperations.ZeroMemory(body); }
    }

    private async Task NotificationsAsync()
    {
        try
        {
            await foreach (var (method, parameters, characters) in notifications.Reader.ReadAllAsync(lifetime.Token))
            {
                Interlocked.Add(ref notificationCharacters, -characters);
                try { await notification!(method, parameters); }
                catch (Exception) { /* Adapter failures do not poison framing or unrelated requests. */ }
            }
        }
        catch (OperationCanceledException) { }
    }

    private async Task DrainErrorAsync()
    {
        var buffer = new byte[4096];
        try { while (await process.StandardError.BaseStream.ReadAsync(buffer, lifetime.Token) != 0) CryptographicOperations.ZeroMemory(buffer); }
        catch (Exception error) when (error is IOException or OperationCanceledException or ObjectDisposedException or InvalidOperationException) { }
        finally { CryptographicOperations.ZeroMemory(buffer); }
    }

    private async Task WatchExitAsync()
    {
        try { await process.WaitForExitAsync(lifetime.Token); if (!lifetime.IsCancellationRequested) Stop(new IOException("The language server process exited.")); }
        catch (Exception error) when (error is OperationCanceledException or ObjectDisposedException or InvalidOperationException) { }
    }

    private void Stop(Exception? error)
    {
        if (Interlocked.Exchange(ref stopped, 1) != 0) return;
        lifetime.Cancel();
        notifications.Writer.TryComplete();
        foreach (var (id, answer) in pending)
            if (pending.TryRemove(id, out _)) answer.TrySetException(error ?? new ObjectDisposedException(nameof(LspClient)));
        if (error is null) completion.TrySetResult();
        else { completion.TrySetException(error); _ = completion.Task.Exception; }
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); }
        catch (Exception failure) when (failure is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref disposed, 1) != 0) return;
        Stop(null);
        input.Dispose();
        output.Dispose();
        process.Dispose();
        // A provider callback may be stuck in its own code; cleanup never waits for it synchronously.
        _ = Task.WhenAll(workers).ContinueWith(_ => lifetime.Dispose(), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
    }

    public async ValueTask DisposeAsync()
    {
        Dispose();
        try { await Task.WhenAll(workers).WaitAsync(TimeSpan.FromSeconds(1)); }
        catch (Exception error) when (error is TimeoutException or IOException or OperationCanceledException or ObjectDisposedException) { }
    }
}
