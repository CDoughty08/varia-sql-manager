using System.Text.Json;

namespace Varia.Backend.Language;

internal sealed partial class SqlToolsLanguageService
{
    internal const int MaxDiagnosticItems = 1000;
    internal const int MaxDiagnosticMessageCharacters = 4096;
    internal const int MaxDiagnosticCharacters = 262_144;
    internal static readonly TimeSpan DiagnosticIdleTimeout = TimeSpan.FromSeconds(60);
    private readonly TimeSpan diagnosticIdleTimeout;
    private readonly SemaphoreSlim diagnosticSerial = new(1, 1);
    private readonly Dictionary<string, DiagnosticPending> diagnosticPending = new(StringComparer.Ordinal);
    private ILspClient? diagnosticClient;
    private DiagnosticOwner? diagnosticOwner;
    private Timer? diagnosticIdle;
    private int diagnosticOwners;
    private bool diagnosticRunning;
    private string? diagnosticDocumentId;
    private string? diagnosticContextKey;

    private sealed record DiagnosticOwner(string Uri, string DocumentId, string ContextKey, ILspClient Client);
    private sealed record DiagnosticPending(ILspClient Client, LanguageRequest Request, TaskCompletionSource<LanguageDiagnosticResult> Answer);

    public async Task<LanguageDiagnosticResult> DiagnosticsAsync(LanguageRefreshRequest request, CancellationToken token)
    {
        var result = await RequestAsync("varia/diagnostics", new(request.DocumentId, request.Version, request.Text, request.Context, new(0, 0)), token);
        return result.Deserialize<LanguageDiagnosticResult>() ?? throw new IOException("Invalid language diagnostics response.");
    }

    private async Task<LanguageDiagnosticResult> DiagnosticsRemoteAsync(LanguageRequest request, string? settings, CancellationToken token)
    {
        await diagnosticSerial.WaitAsync(token);
        var uri = "varia-sql://diagnostics/" + Guid.NewGuid().ToString("D");
        try
        {
            var contextKey = JsonSerializer.Serialize(request.Context);
            DiagnosticOwner? previous;
            lock (gate)
            {
                diagnosticRunning = true;
                diagnosticDocumentId = request.DocumentId;
                diagnosticContextKey = contextKey;
                diagnosticIdle?.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
                // STS retains parse/binding owners after didClose. Bound that retention and keep only the current
                // database context; the separate child also isolates its global diagnostic debounce from edits.
                if (diagnosticOwner is { } owner && owner.ContextKey != contextKey || diagnosticOwners >= MaxDocuments)
                    ResetDiagnostics();
                previous = diagnosticOwner;
            }
            var current = await GetDiagnosticClientAsync(token);
            var answer = new TaskCompletionSource<LanguageDiagnosticResult>(TaskCreationOptions.RunContinuationsAsynchronously);
            // Keep checking off until this exact buffer has a connected binding. STS requires the open workspace
            // buffer during connection setup, and otherwise can publish a misleading empty offline analysis.
            await ConfigureDiagnosticsAsync(current, false, token);
            await current.NotifyAsync("textDocument/didOpen", new { textDocument = new { uri, languageId = "sql", version = request.Version, text = request.Text } }, token);
            if (settings is not null) await ConnectAsync(current, uri, settings, token);
            if (previous is not null && ReferenceEquals(previous.Client, current)) await CloseRemoteAsync(current, previous.Uri, token);
            lock (gate)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                token.ThrowIfCancellationRequested();
                if (!ReferenceEquals(current, diagnosticClient)) throw new OperationCanceledException(token);
                diagnosticPending.Add(uri, new(current, request, answer));
                diagnosticOwner = new(uri, request.DocumentId, contextKey, current);
                diagnosticOwners++;
            }
            await ConfigureDiagnosticsAsync(current, true, token);
            // Configuration updates do not consistently requeue analysis in the pinned service. Replace this
            // immutable buffer with itself to request its connected pass without changing its identity or text.
            await current.NotifyAsync("textDocument/didChange", new
            {
                textDocument = new { uri, version = request.Version },
                contentChanges = new[] { new { range = new LanguageRange(new(0, 0), EndPosition(request.Text)), rangeLength = request.Text.Length, text = request.Text } }
            }, token);
            var finished = await Task.WhenAny(answer.Task, current.Completion).WaitAsync(TimeSpan.FromSeconds(20), token);
            if (finished != answer.Task) throw new IOException("The diagnostic language server stopped.");
            return await answer.Task;
        }
        catch
        {
            // No unversioned publication from a cancelled pass may become the answer to a later pass.
            lock (gate) ResetDiagnostics();
            throw;
        }
        finally
        {
            lock (gate)
            {
                diagnosticPending.Remove(uri);
                diagnosticRunning = false;
                diagnosticDocumentId = null;
                diagnosticContextKey = null;
                if (!disposed && diagnosticClient is not null)
                {
                    diagnosticIdle ??= new Timer(_ =>
                    {
                        lock (gate) if (!diagnosticRunning) ResetDiagnostics();
                    });
                    diagnosticIdle.Change(diagnosticIdleTimeout, Timeout.InfiniteTimeSpan);
                }
            }
            diagnosticSerial.Release();
        }
    }

    private async Task<ILspClient> GetDiagnosticClientAsync(CancellationToken token)
    {
        ILspClient current;
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (diagnosticClient is { } running && !running.Completion.IsCompleted) return running;
            ResetDiagnostics();
            ILspClient? source = null;
            current = source = createClient((method, parameters) => NotificationAsync(source, method, parameters));
            diagnosticClient = current;
        }
        await current.RequestAsync("initialize", new
        {
            processId = Environment.ProcessId, rootUri = (string?)null,
            capabilities = new { textDocument = new { publishDiagnostics = new { versionSupport = true } } }
        }, token);
        await current.NotifyAsync("initialized", new { }, token);
        await ConfigureDiagnosticsAsync(current, false, token);
        return current;
    }

    private static Task ConfigureDiagnosticsAsync(ILspClient current, bool enabled, CancellationToken token) =>
        current.NotifyAsync("workspace/didChangeConfiguration", new
        {
            settings = new { mssql = new { intelliSense = new { enableIntelliSense = true, enableErrorChecking = enabled, enableSuggestions = true, enableQuickInfo = true } } }
        }, token);

    private void PublishDiagnostics(ILspClient? source, JsonElement parameters)
    {
        var uri = String(parameters, "uri");
        lock (gate)
        {
            if (uri is null || !diagnosticPending.TryGetValue(uri, out var pending) || !ReferenceEquals(source, pending.Client)
                || !ReferenceEquals(source, diagnosticClient)) return;
            var version = Property(parameters, "version");
            if (version.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined)
                && (version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var number) || number != pending.Request.Version)) return;
            pending.Answer.TrySetResult(ReadDiagnostics(Property(parameters, "diagnostics"), pending.Request.Text, pending.Request.Version));
        }
    }

    internal static LanguageDiagnosticResult ReadDiagnostics(JsonElement values, string text, int version)
    {
        if (values.ValueKind != JsonValueKind.Array) return new(version, [], true);
        List<LanguageDiagnostic> items = [];
        var lineLengths = DiagnosticLineLengths(text);
        var characters = 0;
        var incomplete = false;
        foreach (var value in values.EnumerateArray())
        {
            if (items.Count >= MaxDiagnosticItems) { incomplete = true; break; }
            var range = ReadRange(Property(value, "range"));
            var message = String(value, "message");
            if (range is null || !InSnapshot(range.Start) || !InSnapshot(range.End) || string.IsNullOrWhiteSpace(message))
            { incomplete = true; continue; }
            if (message.Length > MaxDiagnosticMessageCharacters) { message = message[..MaxDiagnosticMessageCharacters]; incomplete = true; }
            var severity = Number(value, "severity") ?? 1;
            if (severity is < 1 or > 4) { incomplete = true; continue; }
            var codeValue = Property(value, "code");
            var code = codeValue.ValueKind == JsonValueKind.String ? codeValue.GetString() : codeValue.ValueKind == JsonValueKind.Number ? codeValue.GetRawText() : null;
            var source = String(value, "source");
            if (code is { Length: > 128 }) { code = code[..128]; incomplete = true; }
            if (source is { Length: > 128 }) { source = source[..128]; incomplete = true; }
            characters += message.Length + (code?.Length ?? 0) + (source?.Length ?? 0);
            if (characters > MaxDiagnosticCharacters) { incomplete = true; break; }
            items.Add(new(range, message, severity, code, source));
        }
        return new(version, items, incomplete);

        bool InSnapshot(LanguagePosition position) => position.Line < lineLengths.Count && position.Character <= lineLengths[position.Line];
    }

    private static List<int> DiagnosticLineLengths(string text)
    {
        List<int> lengths = [];
        var start = 0;
        for (var at = 0; at < text.Length; at++)
        {
            if (text[at] is not ('\r' or '\n')) continue;
            lengths.Add(at - start);
            if (text[at] == '\r' && at + 1 < text.Length && text[at + 1] == '\n') at++;
            start = at + 1;
        }
        lengths.Add(text.Length - start);
        return lengths;
    }

    // Called under gate: both ordinary document close/reset and the idle callback can release the analysis child.
    private void ResetDiagnostics()
    {
        diagnosticIdle?.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        var previous = diagnosticClient;
        diagnosticClient = null;
        diagnosticOwner = null;
        diagnosticOwners = 0;
        foreach (var pending in diagnosticPending.Values) pending.Answer.TrySetCanceled();
        diagnosticPending.Clear();
        // Transport disposal stops the process first. A later stream-handle failure must not escape an idle timer
        // callback or leave the disposed transport registered as the next analysis client's owner.
        try { previous?.Dispose(); } catch (Exception) { }
        if (disposed) { diagnosticIdle?.Dispose(); diagnosticIdle = null; }
    }
}
