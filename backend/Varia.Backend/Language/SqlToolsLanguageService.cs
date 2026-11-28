using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.TransactSql.ScriptDom;
using Varia.Backend.Search;

namespace Varia.Backend.Language;

/// <summary>SQL Server's language provider. Completion and hover run in-process via ScriptDom (<see cref="TsqlScopeReader"/>)
/// and Search Objects' <see cref="IndexLookup"/> across all authentication modes (SQL Login, Windows, and Microsoft Entra ID),
/// with zero STS interactive completion child process. Only the isolated SQL Tools Service diagnostic child remains active for
/// <see cref="DiagnosticsAsync"/> until Phase 2 retires STS completely.</summary>
internal sealed partial class SqlToolsLanguageService : ILanguageServiceProvider
{
    internal const int MaxDocuments = 128;
    internal const int MaxTextCharacters = 250_000;
    internal const int MaxTotalCharacters = 8_000_000;
    internal const int MaxCompletionItems = 500;
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(20);
    private readonly object gate = new();
    private readonly Dictionary<string, Document> documents = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, (ILspClient Client, TaskCompletionSource<JsonElement> Complete, TaskCompletionSource Ready)> connecting = new(StringComparer.Ordinal);
    private readonly Func<LanguageContext, string?> connectionString;
    private readonly Func<string, IndexLookup?> indexLookup;
    private readonly Func<LanguageContext, string?> activeDatabase;
    private readonly Func<LanguageContext, CancellationToken, Task<bool>>? refreshIndex;
    private readonly Func<Func<string, JsonElement, Task>, ILspClient> createClient;
    private readonly string? configurationReason;
    private bool disposed;

    private sealed class Document(string id)
    {
        public readonly SemaphoreSlim Serial = new(1, 1);
        public string? ConnectionId;
        public int AcceptedVersion;
        public string? AcceptedFingerprint;
        public string? AcceptedContextKey;
        public bool Closing;
        public CancellationTokenSource? Active;
        public Task<LanguageCloseResult>? CloseTask;
        public string Id { get; } = id;
    }

    internal SqlToolsLanguageService(
        Func<LanguageContext, string?> connectionString,
        string? executablePath = null,
        Func<Func<string, JsonElement, Task>, ILspClient>? createClient = null,
        TimeSpan? diagnosticIdleTimeout = null,
        Func<string, IndexLookup?>? indexLookup = null,
        Func<LanguageContext, string?>? activeDatabase = null,
        Func<LanguageContext, CancellationToken, Task<bool>>? refreshIndex = null)
    {
        this.connectionString = connectionString;
        this.indexLookup = indexLookup ?? (_ => null);
        this.activeDatabase = activeDatabase ?? (context => context.Database);
        this.refreshIndex = refreshIndex;
        this.diagnosticIdleTimeout = diagnosticIdleTimeout ?? DiagnosticIdleTimeout;
        var runtime = SqlToolsRuntime.Resolve(executablePath);
        configurationReason = createClient is not null ? null : runtime.UnavailableReason();
        this.createClient = createClient ?? (notification => new LspClient(runtime.ExecutablePath, runtime.Arguments, notification));
    }

    internal static string? ConfigurationReason(string? path) => SqlToolsRuntime.Resolve(path).UnavailableReason();

    public string Id => "sqlserver";

    /// <summary>Completion, hover, and cache refresh run in-process via ScriptDom + IndexLookup and need no external executable.
    /// Diagnostics still require SQL Tools Service until Phase 2.</summary>
    public LanguageProviderStatus Status() => new(Id, Configured: true, Completion: true, Hover: true, Reason: configurationReason, Refresh: true, Diagnostics: configurationReason is null);

    public async Task<LanguageRefreshResult> RefreshAsync(LanguageRefreshRequest request, CancellationToken token)
    {
        var document = new LanguageRequest(request.DocumentId, request.Version, request.Text, request.Context, new(0, 0));
        Validate(document);
        if (request.Context.ConnectionId is null) return new(false);
        var refreshContext = JsonSerializer.Serialize(request.Context);
        lock (gate)
        {
            if (documents.TryGetValue(request.DocumentId, out var current))
            {
                if (request.Version < current.AcceptedVersion || request.Version == current.AcceptedVersion && current.AcceptedFingerprint is not null && TextFingerprint(request.Text) != current.AcceptedFingerprint)
                    throw new RequestException("STALE", "The language refresh refers to an older document version.");
                if (current.AcceptedContextKey is { } context && context != refreshContext)
                    throw new RequestException("STALE", "The language refresh refers to an older connection context.");
                current.Active?.Cancel();
            }
            if ((diagnosticRunning ? diagnosticContextKey : diagnosticOwner?.ContextKey) == refreshContext) ResetDiagnostics();
        }
        var doc = GetDocument(request.DocumentId);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(25));
        using var active = new CancellationTokenSource();
        using var combined = CancellationTokenSource.CreateLinkedTokenSource(token, timeout.Token, active.Token);
        try
        {
            await doc.Serial.WaitAsync(combined.Token);
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested && !token.IsCancellationRequested)
        {
            throw new RequestException("TIMEOUT", "The IntelliSense cache refresh exceeded its time limit.");
        }
        try
        {
            AcceptVersionLocked(doc, document, checkContextMatch: true, active);
            // Verify connection is live (supports SQL Login, Windows, and Microsoft Entra ID).
            _ = activeDatabase(request.Context);
            if (refreshIndex is not null)
                return new(await refreshIndex(request.Context, combined.Token));
            return new(true);
        }
        catch (OperationCanceledException) when (active.IsCancellationRequested && !token.IsCancellationRequested && !timeout.IsCancellationRequested)
        {
            throw new RequestException("STALE", "The language refresh was superseded or its document closed.");
        }
        catch (OperationCanceledException) when (timeout.IsCancellationRequested && !token.IsCancellationRequested)
        {
            throw new RequestException("TIMEOUT", "The IntelliSense cache refresh exceeded its time limit.");
        }
        finally { lock (gate) if (ReferenceEquals(doc.Active, active)) doc.Active = null; doc.Serial.Release(); }
    }

    public async Task<LanguageCompletionResult> CompleteAsync(LanguageRequest request, CancellationToken token)
    {
        Validate(request);
        var document = GetDocument(request.DocumentId);
        using var operation = CancellationTokenSource.CreateLinkedTokenSource(token);
        operation.CancelAfter(TimeSpan.FromSeconds(25));
        await document.Serial.WaitAsync(operation.Token);
        try
        {
            AcceptVersionLocked(document, request, checkContextMatch: false, operation);
            var db = activeDatabase(request.Context);
            var lookup = request.Context.ConnectionId is { } connectionId ? indexLookup(connectionId) : null;
            return TsqlCompletionService.Complete(request, lookup, db, operation.Token);
        }
        finally { lock (gate) if (ReferenceEquals(document.Active, operation)) document.Active = null; document.Serial.Release(); }
    }

    public async Task<LanguageHover?> HoverAsync(LanguageRequest request, CancellationToken token)
    {
        Validate(request);
        var document = GetDocument(request.DocumentId);
        using var operation = CancellationTokenSource.CreateLinkedTokenSource(token);
        operation.CancelAfter(TimeSpan.FromSeconds(25));
        await document.Serial.WaitAsync(operation.Token);
        try
        {
            AcceptVersionLocked(document, request, checkContextMatch: false, operation);
            var db = activeDatabase(request.Context);
            var lookup = request.Context.ConnectionId is { } connectionId ? indexLookup(connectionId) : null;
            return TsqlHoverService.Hover(request, lookup, db, operation.Token);
        }
        finally { lock (gate) if (ReferenceEquals(document.Active, operation)) document.Active = null; document.Serial.Release(); }
    }

    private void AcceptVersionLocked(Document document, LanguageRequest request, bool checkContextMatch, CancellationTokenSource operation)
    {
        var fingerprint = TextFingerprint(request.Text);
        if (request.Version < document.AcceptedVersion
            || request.Version == document.AcceptedVersion && document.AcceptedFingerprint is not null && fingerprint != document.AcceptedFingerprint)
            throw new RequestException("STALE", "The SQL language request refers to an older document version.");
        var contextKey = JsonSerializer.Serialize(request.Context);
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (document.Closing) throw new RequestException("STALE", "The SQL language document has closed.");
            if (checkContextMatch && document.AcceptedContextKey is { } existing && existing != contextKey)
                throw new RequestException("STALE", "The language refresh refers to an older connection context.");
            document.ConnectionId = request.Context.ConnectionId;
            document.AcceptedVersion = request.Version;
            document.AcceptedFingerprint = fingerprint;
            document.AcceptedContextKey = contextKey;
            document.Active = operation;
        }
    }

    private async Task<LanguageDiagnosticResult> DiagnosticsRequestAsync(LanguageRequest request, CancellationToken token)
    {
        Validate(request);
        if (configurationReason is not null) throw new RequestException("BACKEND_UNAVAILABLE", configurationReason);
        // Resolve before opening state or starting a diagnostic child: unknown connections and unsupported Entra auth fail locally.
        var settings = connectionString(request.Context);
        var document = GetDocument(request.DocumentId);
        using var operation = CancellationTokenSource.CreateLinkedTokenSource(token);
        operation.CancelAfter(TimeSpan.FromSeconds(25));
        token = operation.Token;
        await document.Serial.WaitAsync(token);
        try
        {
            AcceptVersionLocked(document, request, checkContextMatch: false, operation);
            settings = connectionString(request.Context);
            return await DiagnosticsRemoteAsync(request, settings, token);
        }
        catch (OperationCanceledException) { throw; }
        catch (RequestException) { throw; }
        catch (TimeoutException) { throw new RequestException("TIMEOUT", "SQL language service timed out. Try IntelliSense again."); }
        catch (Exception) { throw new RequestException("BACKEND_UNAVAILABLE", "SQL language service stopped or returned an invalid response. Try IntelliSense again; reinstall Varia if it keeps failing."); }
        finally { lock (gate) document.Active = null; document.Serial.Release(); }
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
            var initialized = await Task.WhenAny(ready.Task, current.Completion).WaitAsync(ConnectTimeout, token);
            if (initialized != ready.Task) throw new RequestException("BACKEND_UNAVAILABLE", "SQL Tools Service stopped while preparing database IntelliSense.");
            await ready.Task;
        }
        catch
        {
            current.Dispose();
            throw;
        }
        finally { connecting.TryRemove(uri, out _); }
    }

    private Task NotificationAsync(ILspClient? source, string method, JsonElement parameters)
    {
        if (method == "textDocument/publishDiagnostics") PublishDiagnostics(source, parameters);
        if (String(parameters, "ownerUri") is { } uri && connecting.TryGetValue(uri, out var pending) && ReferenceEquals(source, pending.Client))
        {
            if (method == "connection/complete") pending.Complete.TrySetResult(parameters.Clone());
            else if (method == "textDocument/intelliSenseReady") pending.Ready.TrySetResult();
        }
        return Task.CompletedTask;
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
            if ((diagnosticRunning ? diagnosticDocumentId : diagnosticOwner?.DocumentId) == id) ResetDiagnostics();
            cleanup = document.CloseTask ??= Task.Run(CloseCoreAsync);
        }
        return await cleanup.WaitAsync(token);

        async Task<LanguageCloseResult> CloseCoreAsync()
        {
            await document.Serial.WaitAsync(CancellationToken.None);
            try
            {
                lock (gate)
                {
                    if (documents.TryGetValue(id, out var found) && ReferenceEquals(found, document))
                        documents.Remove(id);
                }
                return new(true);
            }
            finally { document.Serial.Release(); }
        }
    }

    public async Task ForgetConnectionAsync(string id)
    {
        string[] ids;
        lock (gate)
        {
            ids = [.. documents.Where(pair => pair.Value.ConnectionId == id).Select(pair => pair.Key)];
            var ownerConnection = diagnosticRunning ? diagnosticConnectionId : diagnosticOwner?.ConnectionId;
            if (ownerConnection == id) ResetDiagnostics();
        }
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

    private static string TextFingerprint(string text) => Convert.ToBase64String(SHA256.HashData(MemoryMarshal.AsBytes(text.AsSpan())));

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

    internal static int CompletionOffset(string text, LanguagePosition position)
    {
        if (!PositionInText(text, position)) return -1;
        var line = 0;
        var start = 0;
        for (var at = 0; at < text.Length && line < position.Line; at++)
        {
            if (text[at] is not ('\r' or '\n')) continue;
            if (text[at] == '\r' && at + 1 < text.Length && text[at + 1] == '\n') at++;
            start = at + 1;
            line++;
        }
        return start + position.Character;
    }

    internal static bool BoundedCompletionSyntax(IList<TSqlParserToken> tokens)
    {
        // ScriptDom's grammar is recursive (including left-recursive binary operators such as ||, +, AND/OR, COLLATE, AT, ::).
        // Tokenize before parsing so hostile nesting or operator chains cannot overflow even a 512 KB ThreadPool stack.
        if (tokens.Count > 16_384) return false;
        var parentheses = 0;
        var recursiveKeywords = 0;
        var unary = 0;
        var operators = 0;
        foreach (var token in tokens)
        {
            if (token.TokenType is TSqlTokenType.WhiteSpace or TSqlTokenType.SingleLineComment or TSqlTokenType.MultilineComment) continue;
            if (token.TokenType == TSqlTokenType.LeftParenthesis && ++parentheses > 64) return false;
            if (token.TokenType == TSqlTokenType.RightParenthesis && --parentheses < 0) return false;
            if (token.TokenType is TSqlTokenType.Select or TSqlTokenType.Begin or TSqlTokenType.Case or TSqlTokenType.If or TSqlTokenType.While or TSqlTokenType.Join
                || string.Equals(token.Text, "APPLY", StringComparison.OrdinalIgnoreCase))
                if (++recursiveKeywords > 64) return false;
            unary = token.Text is "+" or "-" or "~" || string.Equals(token.Text, "NOT", StringComparison.OrdinalIgnoreCase) ? unary + 1 : 0;
            if (unary > 32) return false;
            if (token.TokenType is TSqlTokenType.DoubleColon or TSqlTokenType.Collate
                || token.Text is "+" or "-" or "~" or "*" or "/" or "%" or "^" or "|" or "||" or "&" or "=" or "<" or ">" or "<>" or "<=" or ">=" or "!=" or "!<" or "!>" or "+=" or "-=" or "*=" or "/=" or "%=" or "&=" or "|=" or "^=" or "::"
                || string.Equals(token.Text, "AND", StringComparison.OrdinalIgnoreCase)
                || string.Equals(token.Text, "OR", StringComparison.OrdinalIgnoreCase)
                || string.Equals(token.Text, "COLLATE", StringComparison.OrdinalIgnoreCase)
                || string.Equals(token.Text, "AT", StringComparison.OrdinalIgnoreCase))
                if (++operators > 128) return false;
        }
        return true;
    }

    private static JsonElement Property(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var property) ? property : default;
    private static string? String(JsonElement value, string name) => Property(value, name) is { ValueKind: JsonValueKind.String } property ? property.GetString() : null;
    private static int? Number(JsonElement value, string name) => Property(value, name) is { ValueKind: JsonValueKind.Number } property && property.TryGetInt32(out var number) ? number : null;
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
            ResetDiagnostics();
        }
        foreach (var waiter in connecting.Values) { waiter.Complete.TrySetCanceled(); waiter.Ready.TrySetCanceled(); }
        connecting.Clear();
    }

    public void Reset()
    {
        lock (gate)
        {
            ResetDiagnostics();
            foreach (var document in documents.Values) document.Active?.Cancel();
        }
    }
}
