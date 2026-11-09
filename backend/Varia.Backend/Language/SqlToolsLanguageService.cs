using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Language;

/// <summary>SQL Server's provider. The public boundary is a small, engine-neutral LSP-shaped API; SQL Tools Service's
/// proprietary connection protocol and executable configuration stay here, outside Monaco and the renderer.</summary>
internal sealed class SqlToolsLanguageService : ILanguageServiceProvider
{
    internal const int MaxDocuments = 128;
    internal const int MaxTextCharacters = 250_000;
    internal const int MaxTotalCharacters = 8_000_000;
    internal const int MaxCompletionItems = 500;
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(20);
    private readonly object gate = new();
    private readonly Dictionary<string, Document> documents = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (ILspClient Client, TaskCompletionSource<JsonElement> Complete, TaskCompletionSource Ready)> connecting = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (ILspClient Client, TaskCompletionSource Ready)> refreshing = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim startup = new(1, 1);
    private readonly Func<LanguageContext, string?> connectionString;
    private readonly Func<Func<string, JsonElement, Task>, ILspClient> createClient;
    private readonly string? configurationReason;
    private ILspClient? client;
    private ILspClient? startingClient;
    private int generation;
    private int totalCharacters;
    private int operations;
    private int closedDocuments;
    private TaskCompletionSource? idle;
    private TaskCompletionSource? retirement;
    private bool disposed;

    private sealed class Document(string id)
    {
        public readonly SemaphoreSlim Serial = new(1, 1);
        public readonly string Uri = "varia-sql://query/" + id;
        public string? ConnectionId;
        public string? ContextKey;
        public string Text = "";
        public int Version;
        public int Generation;
        public int ParsedVersion;
        public bool CompletionReady;
        public bool Closing;
        public CancellationTokenSource? Active;
        public Task<LanguageCloseResult>? CloseTask;
    }

    internal SqlToolsLanguageService(Func<LanguageContext, string?> connectionString, string? executablePath = null,
        Func<Func<string, JsonElement, Task>, ILspClient>? createClient = null)
    {
        this.connectionString = connectionString;
        var runtime = SqlToolsRuntime.Resolve(executablePath);
        configurationReason = createClient is not null ? null : runtime.UnavailableReason();
        this.createClient = createClient ?? (notification => new LspClient(runtime.ExecutablePath, runtime.Arguments, notification));
    }

    internal static string? ConfigurationReason(string? path) => SqlToolsRuntime.Resolve(path).UnavailableReason();

    public string Id => "sqlserver";
    public LanguageProviderStatus Status() => new(Id, configurationReason is null, true, true, configurationReason, Refresh: true);

    public async Task<LanguageRefreshResult> RefreshAsync(LanguageRefreshRequest request, CancellationToken token)
    {
        var document = new LanguageRequest(request.DocumentId, request.Version, request.Text, request.Context, new(0, 0));
        Validate(document);
        if (request.Context.ConnectionId is null) return new(false);
        lock (gate)
        {
            if (documents.TryGetValue(request.DocumentId, out var current))
            {
                if (request.Version < current.Version || request.Version == current.Version && request.Text != current.Text)
                    throw new RequestException("STALE", "The language refresh refers to an older document version.");
                if (current.ContextKey is { } context && context != JsonSerializer.Serialize(request.Context))
                    throw new RequestException("STALE", "The language refresh refers to an older connection context.");
                current.Active?.Cancel();
            }
        }
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(25));
        try
        {
            await RequestAsync("textDocument/rebuildIntelliSense", document, deadline.Token);
            return new(true);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new RequestException("TIMEOUT", "The IntelliSense cache refresh exceeded its time limit.");
        }
    }

    public async Task<LanguageCompletionResult> CompleteAsync(LanguageRequest request, CancellationToken token)
    {
        var result = await RequestAsync("textDocument/completion", request, token);
        return ReadCompletions(result, request.Text, request.Position);
    }

    public async Task<LanguageHover?> HoverAsync(LanguageRequest request, CancellationToken token)
    {
        var result = await RequestAsync("textDocument/hover", request, token);
        if (result.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return null;
        var contents = Property(result, "contents");
        var text = ReadContents(contents, 16_384);
        var range = ReadRange(Property(result, "range"));
        if (range is not null && (!PositionInText(request.Text, range.Start) || !PositionInText(request.Text, range.End))) range = null;
        return text.Length == 0 ? null : new(text, range);
    }

    private async Task<JsonElement> RequestAsync(string method, LanguageRequest request, CancellationToken token)
    {
        Validate(request);
        if (configurationReason is not null) throw new RequestException("BACKEND_UNAVAILABLE", configurationReason);
        // Resolve before opening state or starting a process: unknown connections and unsupported authentication fail locally.
        var settings = connectionString(request.Context);
        var document = GetDocument(request.DocumentId);
        using var operation = CancellationTokenSource.CreateLinkedTokenSource(token);
        operation.CancelAfter(TimeSpan.FromSeconds(25));
        token = operation.Token;
        await document.Serial.WaitAsync(token);
        try
        {
            if (request.Version < document.Version || request.Version == document.Version && request.Text != document.Text)
                throw new RequestException("STALE", "The SQL language request refers to an older document version.");
            // Check again under the document gate so Disconnect cannot leave a captured credential string usable.
            lock (gate)
            {
                if (document.Closing) throw new RequestException("STALE", "The SQL language document has closed.");
                if (method == "textDocument/rebuildIntelliSense" && document.ContextKey is { } context && context != JsonSerializer.Serialize(request.Context))
                    throw new RequestException("STALE", "The language refresh refers to an older connection context.");
                document.ConnectionId = request.Context.ConnectionId;
                document.Active = operation;
            }
            using var usage = await EnterOperationAsync(token);
            settings = connectionString(request.Context);
            var current = await GetClientAsync(token);
            await SynchronizeAsync(current, document, request, settings, token);
            var position = new { textDocument = new { uri = document.Uri }, position = request.Position };
            if (method == "textDocument/rebuildIntelliSense")
            {
                document.ParsedVersion = 0;
                document.CompletionReady = false;
                if (settings is not null) await RefreshRemoteAsync(current, document.Uri, token);
                // STS serializes completion and rebuild work for the same URI. Besides making the refreshed parse
                // immediately usable by hover, this barrier drains the rebuild handler's final readiness notifications
                // before another refresh can register a waiter for this URI.
                await CompletionAsync(current, document, request, position, token);
                return JsonSerializer.SerializeToElement(true);
            }
            if (method == "textDocument/hover" && document.ParsedVersion != request.Version)
            {
                // Pinned STS 6.0's hover handler reads the cached parse tree without reparsing changed text.
                // With diagnostics off, completion is the supported request that parses/binds the current buffer.
                await CompletionAsync(current, document, request, position, token);
            }
            return method == "textDocument/completion"
                ? await CompletionAsync(current, document, request, position, token)
                : await current.RequestAsync(method, position, token);
        }
        catch (OperationCanceledException) { throw; }
        catch (RequestException) { throw; }
        catch (TimeoutException) { throw new RequestException("TIMEOUT", "SQL language service timed out. Try IntelliSense again."); }
        catch (Exception) { throw new RequestException("BACKEND_UNAVAILABLE", "SQL language service stopped or returned an invalid response. Try IntelliSense again; reinstall Varia if it keeps failing."); }
        finally { lock (gate) document.Active = null; document.Serial.Release(); }
    }

    private async Task<Operation?> EnterOperationAsync(CancellationToken token, bool cleanup = false)
    {
        while (true)
        {
            Task waiting;
            lock (gate)
            {
                if (disposed && cleanup) return null;
                ObjectDisposedException.ThrowIf(disposed, this);
                token.ThrowIfCancellationRequested();
                if (retirement is null)
                {
                    if (operations++ == 0) idle = new(TaskCreationOptions.RunContinuationsAsynchronously);
                    return new(this);
                }
                waiting = retirement.Task;
            }
            // Waiting for retirement must not keep that same retirement from reaching idle.
            await waiting.WaitAsync(token);
        }
    }

    private sealed class Operation(SqlToolsLanguageService owner) : IDisposable
    {
        private int ended;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref ended, 1) != 0) return;
            lock (owner.gate)
                if (--owner.operations == 0) { owner.idle?.TrySetResult(); owner.idle = null; }
        }
    }

    private Task? RetireClosedContext(Document document)
    {
        lock (gate)
        {
            if (disposed || document.Generation != generation || document.ContextKey is null) return null;
            // Upstream keeps binding contexts after disconnect, and didClose also retains offline parse state.
            // Retire the last owner of a context, or after bounded owner churn under a pinned sibling context.
            if (++closedDocuments < MaxDocuments && documents.Values.Any(other => !ReferenceEquals(other, document)
                && !other.Closing && other.ContextKey == document.ContextKey)) return null;
            return RetireClient();
        }
    }

    private Task RetireClient()
    {
        // Called under gate. Keep admissions blocked until disposal, including when idle is already reached.
        if (retirement is { } pending) return pending.Task;
        var finished = retirement = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var wait = idle?.Task ?? Task.CompletedTask;
        var epoch = generation;
        _ = Task.Run(async () =>
        {
            await wait;
            ILspClient? previous = null, starting = null;
            lock (gate)
            {
                if (!disposed && generation == epoch)
                {
                    generation++;
                    closedDocuments = 0;
                    starting = startingClient;
                    previous = client;
                    startingClient = null;
                    client = null;
                }
            }
            // LspClient stops the child before releasing stream handles; a handle cleanup failure must not strand admission.
            try { starting?.Dispose(); } catch (Exception) { }
            try { previous?.Dispose(); } catch (Exception) { }
            lock (gate)
            {
                if (ReferenceEquals(retirement, finished)) retirement = null;
                finished.TrySetResult();
            }
        });
        return finished.Task;
    }

    private static async Task<JsonElement> CompletionAsync(ILspClient current, Document document, LanguageRequest request, object position, CancellationToken token)
    {
        // Pinned STS returns null when its parse/binding work timed out or its metadata lock is busy. Its genuine
        // no-suggestion result is a non-null empty array. Keep a cold catalog's loading state within this one read
        // request rather than exposing a definitive empty suggestion list and relying on another user keystroke.
        var budget = document.CompletionReady ? TimeSpan.FromSeconds(2) : TimeSpan.FromSeconds(15);
        var elapsed = Stopwatch.StartNew();
        while (true)
        {
            token.ThrowIfCancellationRequested();
            var result = await current.RequestAsync("textDocument/completion", position, token);
            if (result.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined))
            {
                document.ParsedVersion = request.Version;
                document.CompletionReady = true;
                return result;
            }
            // Disconnected documents have no database catalog to wait for. A server may legitimately supply no
            // offline result, so bundled-app startup and unconnected editing must remain immediate.
            if (request.Context.ConnectionId is null) return result;
            if (elapsed.Elapsed >= budget)
                throw new RequestException("TIMEOUT", "SQL IntelliSense is still preparing database metadata. Try again shortly.");
            await Task.Delay(TimeSpan.FromMilliseconds(150), token);
        }
    }

    private Document GetDocument(string id)
    {
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (documents.TryGetValue(id, out var document)) return document;
            if (documents.Count >= MaxDocuments) throw new RequestException("BUSY", "Too many SQL language documents are open. Close unused query tabs.");
            document = new(id);
            documents.Add(id, document);
            return document;
        }
    }

    private async Task<ILspClient> GetClientAsync(CancellationToken token)
    {
        await startup.WaitAsync(token);
        try
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (client is { } running && !running.Completion.IsCompleted) return running;
            client?.Dispose();
            var epoch = Volatile.Read(ref generation);
            ILspClient? source = null;
            var created = source = createClient((method, parameters) => NotificationAsync(source, method, parameters));
            try
            {
                lock (gate)
                {
                    ObjectDisposedException.ThrowIf(disposed, this);
                    if (epoch != generation) throw new RequestException("BUSY", "SQL language service was reset during initialization. Try again after the database action finishes.");
                    startingClient = created;
                }
                await created.RequestAsync("initialize", new
                {
                    processId = Environment.ProcessId, rootUri = (string?)null,
                    capabilities = new { textDocument = new { completion = new { completionItem = new { snippetSupport = true, documentationFormat = new[] { "plaintext", "markdown" } } }, hover = new { contentFormat = new[] { "plaintext" } } } }
                }, token);
                await created.NotifyAsync("initialized", new { }, token);
                // Completion/hover only in this first slice. Diagnostics need their own versioned push boundary.
                await created.NotifyAsync("workspace/didChangeConfiguration", new { settings = new { mssql = new { intelliSense = new { enableIntelliSense = true, enableErrorChecking = false, enableSuggestions = true, enableQuickInfo = true } } } }, token);
                lock (gate)
                {
                    ObjectDisposedException.ThrowIf(disposed, this);
                    if (epoch != generation) throw new RequestException("BUSY", "SQL language service was reset during initialization. Try again after the database action finishes.");
                    client = created;
                    startingClient = null;
                    Interlocked.Increment(ref generation);
                    closedDocuments = 0;
                }
                return created;
            }
            catch
            {
                lock (gate) if (ReferenceEquals(startingClient, created)) startingClient = null;
                created.Dispose();
                throw;
            }
        }
        finally { startup.Release(); }
    }

    private async Task SynchronizeAsync(ILspClient current, Document document, LanguageRequest request, string? settings, CancellationToken token)
    {
        var previousLength = document.Text.Length;
        lock (gate)
        {
            if (totalCharacters - previousLength + request.Text.Length > MaxTotalCharacters)
                throw new RequestException("TOO_LARGE", "The SQL language document budget is full. Close unused query tabs.");
            totalCharacters += request.Text.Length - previousLength;
        }
        try
        {
            var currentGeneration = Volatile.Read(ref generation);
            var contextKey = JsonSerializer.Serialize(request.Context);
            if (document.Generation != currentGeneration)
            {
                document.Generation = 0;
                document.ContextKey = null;
            }
            if (document.Generation != 0 && document.ContextKey != contextKey)
            {
                await CloseRemoteAsync(current, document.Uri, token);
                _ = RetireClosedContext(document);
                document.Generation = 0;
                document.ContextKey = null;
            }
            if (document.Generation == 0)
            {
                document.ParsedVersion = 0;
                document.CompletionReady = false;
                // STS's metadata prepopulation resolves the owner's current workspace buffer. Open it before
                // connecting, so its IntelliSense-ready notification includes the actual unsaved document.
                await current.NotifyAsync("textDocument/didOpen", new { textDocument = new { uri = document.Uri, languageId = "sql", version = request.Version, text = request.Text } }, token);
                if (settings is not null) await ConnectAsync(current, document.Uri, settings, token);
                document.Generation = currentGeneration;
            }
            else if (document.Version != request.Version)
                // STS's workspace handler requires Range.Value even for a whole-buffer replacement.
                await current.NotifyAsync("textDocument/didChange", new { textDocument = new { uri = document.Uri, version = request.Version }, contentChanges = new[] { new { range = new LanguageRange(new(0, 0), EndPosition(document.Text)), rangeLength = document.Text.Length, text = request.Text } } }, token);
            document.Text = request.Text;
            document.Version = request.Version;
            document.ConnectionId = request.Context.ConnectionId;
            document.ContextKey = contextKey;
        }
        catch
        {
            lock (gate) totalCharacters -= request.Text.Length - previousLength;
            // A partially sent lifecycle change cannot be reconciled safely by reusing the same URI/version.
            current.Dispose();
            throw;
        }
    }

    private async Task ConnectAsync(ILspClient current, string uri, string settings, CancellationToken token)
    {
        var complete = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!connecting.TryAdd(uri, (current, complete, ready))) throw new RequestException("BUSY", "The SQL language document is already connecting.");
        try
        {
            var builder = new SqlConnectionStringBuilder(settings);
            var accepted = await current.RequestAsync("connection/connect", new
            {
                ownerUri = uri,
                connection = new { options = new { connectionString = settings, server = builder.DataSource, database = builder.InitialCatalog, user = builder.UserID, authenticationType = builder.IntegratedSecurity ? "Integrated" : "SqlLogin" } }
            }, token);
            if (accepted.ValueKind != JsonValueKind.True) throw new RequestException("BACKEND_UNAVAILABLE", "SQL Tools Service refused the IntelliSense connection.");
            // connection/connect only acknowledges dispatch; connection/complete determines whether it really opened.
            var finished = await Task.WhenAny(complete.Task, current.Completion).WaitAsync(ConnectTimeout, token);
            if (finished != complete.Task) throw new RequestException("BACKEND_UNAVAILABLE", "SQL Tools Service stopped while connecting IntelliSense.");
            var result = await complete.Task;
            if (!string.IsNullOrEmpty(String(result, "errorMessage")) || string.IsNullOrEmpty(String(result, "connectionId")))
                // SQL Tools error strings can include server/credential details; keep the renderer error bounded and generic.
                throw new RequestException("NOT_CONNECTED", "SQL Tools Service could not connect IntelliSense using this query's connection settings. Check authentication, network access and certificate trust.");
            // Login completion precedes the asynchronous metadata binding setup. Publishing schema results before
            // IntelliSenseReady would produce keyword-only completions and null/stale hovers on a newly bound query.
            var initialized = await Task.WhenAny(ready.Task, current.Completion).WaitAsync(ConnectTimeout, token);
            if (initialized != ready.Task) throw new RequestException("BACKEND_UNAVAILABLE", "SQL Tools Service stopped while preparing database IntelliSense.");
            await ready.Task;
        }
        catch
        {
            // A cancelled/late connection/complete must not bind a subsequent request under this stable URI.
            // Disposing an ambiguous process also closes any metadata connections it may have opened.
            current.Dispose();
            throw;
        }
        finally { connecting.TryRemove(uri, out _); }
    }

    private Task NotificationAsync(ILspClient? source, string method, JsonElement parameters)
    {
        if (String(parameters, "ownerUri") is { } uri && connecting.TryGetValue(uri, out var pending) && ReferenceEquals(source, pending.Client))
        {
            if (method == "connection/complete") pending.Complete.TrySetResult(parameters.Clone());
            else if (method == "textDocument/intelliSenseReady") pending.Ready.TrySetResult();
        }
        if (method == "textDocument/intelliSenseReady" && String(parameters, "ownerUri") is { } refreshedUri
            && refreshing.TryGetValue(refreshedUri, out var rebuild) && ReferenceEquals(source, rebuild.Client)) rebuild.Ready.TrySetResult();
        return Task.CompletedTask;
    }

    private async Task RefreshRemoteAsync(ILspClient current, string uri, CancellationToken token)
    {
        var ready = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!refreshing.TryAdd(uri, (current, ready))) throw new RequestException("BUSY", "This IntelliSense cache is already refreshing.");
        try
        {
            await current.NotifyAsync("textDocument/rebuildIntelliSense", new { ownerUri = uri }, token);
            var finished = await Task.WhenAny(ready.Task, current.Completion).WaitAsync(ConnectTimeout, token);
            if (finished != ready.Task) throw new RequestException("BACKEND_UNAVAILABLE", "SQL Tools Service stopped while refreshing IntelliSense.");
            await ready.Task;
        }
        finally { refreshing.TryRemove(uri, out _); }
    }

    public async Task<LanguageCloseResult> CloseAsync(string id, CancellationToken token)
    {
        ValidateId(id);
        Document? document;
        Task<LanguageCloseResult> cleanup;
        lock (gate)
        {
            if (!documents.TryGetValue(id, out document)) return new(false);
            document.Closing = true;
            document.Active?.Cancel();
            cleanup = document.CloseTask ??= Task.Run(CloseCoreAsync);
        }
        return await cleanup.WaitAsync(token);

        async Task<LanguageCloseResult> CloseCoreAsync()
        {
            // Once Closing is set, local and remote state must still be reclaimed if this request's deadline expires.
            await document.Serial.WaitAsync(CancellationToken.None);
            try
            {
                Task? retired;
                using (var usage = await EnterOperationAsync(CancellationToken.None, cleanup: true))
                {
                    if (usage is null) return new(true);
                    ILspClient? current;
                    lock (gate)
                    {
                        if (!documents.TryGetValue(id, out var found) || !ReferenceEquals(found, document)) return new(true);
                        documents.Remove(id);
                        totalCharacters -= document.Text.Length;
                        document.Text = "";
                        current = document.Generation == generation ? client : null;
                        retired = RetireClosedContext(document);
                    }
                    if (current is not null && !current.Completion.IsCompleted)
                    {
                        using var budget = new CancellationTokenSource(TimeSpan.FromSeconds(5));
                        try { await CloseRemoteAsync(current, document.Uri, budget.Token); }
                        catch { lock (gate) retired = RetireClient(); }
                    }
                }
                // Release our own usage before waiting for every admitted operation to leave the child.
                if (retired is not null) await retired;
                return new(true);
            }
            finally { document.Serial.Release(); }
        }
    }

    public async Task ForgetConnectionAsync(string id)
    {
        string[] ids;
        lock (gate) ids = [.. documents.Where(pair => pair.Value.ConnectionId == id).Select(pair => pair.Key)];
        await Task.WhenAll(ids.Select(document => CloseAsync(document, CancellationToken.None)));
    }

    private static async Task CloseRemoteAsync(ILspClient current, string uri, CancellationToken token)
    {
        await current.NotifyAsync("textDocument/didClose", new { textDocument = new { uri } }, token);
        await current.RequestAsync("connection/disconnect", new { ownerUri = uri }, token, TimeSpan.FromSeconds(2));
    }

    internal static void Validate(LanguageRequest request)
    {
        ValidateId(request.DocumentId);
        if (request.Version < 1 || request.Text is null || request.Text.Length > MaxTextCharacters || request.Context is null || request.Position is null)
            throw new RequestException("INVALID_PARAMS", "Invalid SQL language document.");
        if (request.Context.ProviderId != "sqlserver") throw new RequestException("INVALID_PARAMS", "This database language provider is not installed.");
        if (request.Context.ConnectionId is { } id) ValidateId(id);
        if (request.Context.Database is { Length: > 128 } || request.Context.DefaultSchema is { Length: > 128 }
            || request.Context.Project is { Length: > 1024 } || request.Context.Dataset is { Length: > 1024 })
            throw new RequestException("INVALID_PARAMS", "Invalid SQL language connection context.");
        if (!string.IsNullOrEmpty(request.Context.DefaultSchema) || !string.IsNullOrEmpty(request.Context.Project) || !string.IsNullOrEmpty(request.Context.Dataset))
            throw new RequestException("INVALID_PARAMS", "The SQL Server language provider supports database context; schema overrides, projects and datasets are not supported.");
        if (!PositionInText(request.Text, request.Position)) throw new RequestException("INVALID_PARAMS", "The SQL language position is outside its document.");
    }

    private static void ValidateId(string? id)
    {
        if (!Guid.TryParseExact(id, "D", out _)) throw new RequestException("INVALID_PARAMS", "A document or connection ID is required.");
    }

    internal static bool PositionInText(string text, LanguagePosition position)
    {
        if (position.Line < 0 || position.Character < 0) return false;
        var line = 0;
        var start = 0;
        for (var at = 0; at < text.Length; at++)
        {
            if (text[at] is not ('\r' or '\n')) continue;
            if (line == position.Line) return position.Character <= at - start;
            if (text[at] == '\r' && at + 1 < text.Length && text[at + 1] == '\n') at++;
            start = at + 1;
            line++;
        }
        return line == position.Line && position.Character <= text.Length - start;
    }

    internal static LanguagePosition EndPosition(string text)
    {
        var line = 0;
        var start = 0;
        for (var at = 0; at < text.Length; at++)
        {
            if (text[at] is not ('\r' or '\n')) continue;
            if (text[at] == '\r' && at + 1 < text.Length && text[at + 1] == '\n') at++;
            start = at + 1;
            line++;
        }
        return new(line, text.Length - start);
    }

    internal static LanguageCompletionResult ReadCompletions(JsonElement result, string? text = null, LanguagePosition? position = null)
    {
        var array = result.ValueKind == JsonValueKind.Array ? result : Property(result, "items");
        if (array.ValueKind != JsonValueKind.Array) return new([], false);
        var items = new List<LanguageCompletionItem>();
        var characters = 0;
        var incomplete = Property(result, "isIncomplete").ValueKind == JsonValueKind.True;
        var prefix = text is not null && position is not null ? CompletionPrefix(array, text, position) : "";
        // STS returns every declaration even after typing a complete identifier. Rank before applying our bounded
        // response limits, or a name beyond the first 500 declarations can never reach Monaco's own filtering.
        IEnumerable<JsonElement> candidates = array.EnumerateArray();
        if (prefix.Length != 0) candidates = candidates.OrderBy(item => CompletionRank(item, prefix));
        foreach (var item in candidates)
        {
            if (items.Count == MaxCompletionItems) { incomplete = true; break; }
            var label = String(item, "label");
            if (string.IsNullOrEmpty(label) || label.Length > 1024) continue;
            var insertText = String(item, "insertText");
            var edit = Property(item, "textEdit");
            var range = ReadRange(Property(edit, "range")) ?? ReadRange(Property(edit, "replace"));
            if (text is not null && range is not null && (!PositionInText(text, range.Start) || !PositionInText(text, range.End))) continue;
            var newText = String(edit, "newText");
            // Truncating insertion text would silently alter the SQL the user accepts.
            if (insertText is { Length: > 16_384 } || newText is { Length: > 16_384 }) { incomplete = true; continue; }
            // Commands, workspace edits, additionalTextEdits and arbitrary data are deliberately not forwarded.
            var completion = new LanguageCompletionItem(label, Number(item, "kind") is >= 1 and <= 25 ? Number(item, "kind") : null,
                Bounded(String(item, "detail"), 4096), EmptyToNull(ReadContents(Property(item, "documentation"), 16_384)),
                insertText, Number(item, "insertTextFormat") is 1 or 2 ? Number(item, "insertTextFormat") : null,
                range is not null && newText is { Length: <= 16_384 } ? new(range, newText) : null);
            characters += completion.Label.Length + (completion.Detail?.Length ?? 0) + (completion.Documentation?.Length ?? 0) + (completion.InsertText?.Length ?? 0) + (completion.TextEdit?.NewText.Length ?? 0);
            if (characters > 1_000_000) { incomplete = true; break; }
            items.Add(completion);
        }
        return new(items, incomplete);
    }

    private static string CompletionPrefix(JsonElement array, string text, LanguagePosition position)
    {
        if (!PositionInText(text, position)) return "";
        var line = 0;
        var start = 0;
        for (var at = 0; at < text.Length && line < position.Line; at++)
        {
            if (text[at] is not ('\r' or '\n')) continue;
            if (text[at] == '\r' && at + 1 < text.Length && text[at + 1] == '\n') at++;
            start = at + 1;
            line++;
        }
        var before = text.Substring(start, position.Character);
        var end = text.IndexOfAny(['\r', '\n'], start);
        var lineLength = (end < 0 ? text.Length : end) - start;
        foreach (var item in array.EnumerateArray())
        {
            var edit = Property(item, "textEdit");
            var range = ReadRange(Property(edit, "range")) ?? ReadRange(Property(edit, "replace"));
            if (range is not null && range.Start.Line == position.Line && range.End.Line == position.Line
                && range.Start.Character <= position.Character && range.End.Character >= position.Character && range.End.Character <= lineLength)
                return UnquoteCompletion(before[range.Start.Character..]);
        }
        var word = before.Length;
        while (word > 0 && (char.IsLetterOrDigit(before[word - 1]) || before[word - 1] is '_' or '@' or '#' or '$')) word--;
        return before[word..];
    }

    private static string UnquoteCompletion(string value)
    {
        if (value.StartsWith('[')) return (value.EndsWith(']') ? value[1..^1] : value[1..]).Replace("]]", "]", StringComparison.Ordinal);
        if (value.StartsWith('"')) return (value.EndsWith('"') && value.Length > 1 ? value[1..^1] : value[1..]).Replace("\"\"", "\"", StringComparison.Ordinal);
        return value;
    }

    private static int CompletionRank(JsonElement item, string prefix)
    {
        var rank = 4;
        foreach (var value in new[] { String(item, "filterText"), String(item, "label"), String(item, "insertText"), String(Property(item, "textEdit"), "newText") })
        {
            if (string.IsNullOrEmpty(value) || value.Length > 16_384) continue;
            var candidate = UnquoteCompletion(value);
            if (candidate.Equals(prefix, StringComparison.OrdinalIgnoreCase)) return 0;
            if (candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) rank = Math.Min(rank, 1);
            else if (candidate.Contains(prefix, StringComparison.OrdinalIgnoreCase)) rank = Math.Min(rank, 2);
            else if (prefix.Length <= candidate.Length)
            {
                var matched = 0;
                foreach (var character in candidate)
                    if (char.ToUpperInvariant(character) == char.ToUpperInvariant(prefix[matched]) && ++matched == prefix.Length) break;
                if (matched == prefix.Length) rank = Math.Min(rank, 3);
            }
        }
        return rank;
    }

    private static JsonElement Property(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var property) ? property : default;
    private static string? String(JsonElement value, string name) => Property(value, name) is { ValueKind: JsonValueKind.String } property ? property.GetString() : null;
    private static int? Number(JsonElement value, string name) => Property(value, name) is { ValueKind: JsonValueKind.Number } property && property.TryGetInt32(out var number) ? number : null;
    private static string? Bounded(string? text, int limit) => text is { Length: > 0 } ? text[..Math.Min(text.Length, limit)] : null;
    private static string? EmptyToNull(string text) => text.Length == 0 ? null : text;
    private static string ReadContents(JsonElement contents, int limit)
    {
        var text = contents.ValueKind switch
        {
            JsonValueKind.String => contents.GetString() ?? "",
            JsonValueKind.Object => String(contents, "value") ?? "",
            JsonValueKind.Array => string.Join("\n\n", contents.EnumerateArray().Take(32).Select(value => ReadContents(value, limit))),
            _ => ""
        };
        return text[..Math.Min(text.Length, limit)];
    }
    private static LanguageRange? ReadRange(JsonElement range)
    {
        var start = Property(range, "start");
        var end = Property(range, "end");
        var sl = Number(start, "line"); var sc = Number(start, "character"); var el = Number(end, "line"); var ec = Number(end, "character");
        return sl is >= 0 && sc is >= 0 && el is >= 0 && ec is >= 0 && (el > sl || el == sl && ec >= sc)
            ? new(new(sl.Value, sc.Value), new(el.Value, ec.Value)) : null;
    }

    public void Dispose()
    {
        lock (gate)
        {
            disposed = true;
            foreach (var document in documents.Values) document.Active?.Cancel();
            documents.Clear();
            totalCharacters = 0;
            startingClient?.Dispose();
            client?.Dispose();
            startingClient = null;
            client = null;
            retirement?.TrySetResult();
        }
        foreach (var waiter in connecting.Values) { waiter.Complete.TrySetCanceled(); waiter.Ready.TrySetCanceled(); }
        connecting.Clear();
        foreach (var waiter in refreshing.Values) waiter.Ready.TrySetCanceled();
        refreshing.Clear();
    }

    public void Reset()
    {
        lock (gate)
        {
            Interlocked.Increment(ref generation);
            closedDocuments = 0;
            startingClient?.Dispose();
            client?.Dispose();
            startingClient = null;
            client = null;
            foreach (var document in documents.Values) document.Active?.Cancel();
        }
    }
}
