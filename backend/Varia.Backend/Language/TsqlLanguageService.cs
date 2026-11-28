using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.SqlServer.TransactSql.ScriptDom;
using Varia.Backend.Search;

namespace Varia.Backend.Language;

/// <summary>SQL Server's in-process language provider. Completion, hover, diagnostics, and cache refresh run 100%
/// in-process via ScriptDom (<see cref="TSql180Parser"/>) and Search Objects' <see cref="IndexLookup"/> across all
/// authentication modes (SQL Login, Windows, and Microsoft Entra ID) and disconnected tabs, with zero external
/// language-server child processes.</summary>
internal sealed class TsqlLanguageService : ILanguageServiceProvider
{
    internal const int MaxDocuments = 128;
    internal const int MaxTextCharacters = 250_000;
    internal const int MaxCompletionItems = 500;
    internal const int MaxDiagnosticItems = 1000;
    internal const int MaxDiagnosticMessageCharacters = 4096;
    internal const int MaxDiagnosticCharacters = 262_144;

    private readonly object gate = new();
    private readonly Dictionary<string, Document> documents = new(StringComparer.Ordinal);
    private readonly Func<string, IndexLookup?> indexLookup;
    private readonly Func<string, string?, CancellationToken, Task<IndexLookup?>> waitForLookup;
    private readonly Func<LanguageContext, string?> activeDatabase;
    private readonly Func<LanguageContext, CancellationToken, Task<bool>>? refreshIndex;
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

    internal TsqlLanguageService(
        Func<string, IndexLookup?>? indexLookup = null,
        Func<LanguageContext, string?>? activeDatabase = null,
        Func<LanguageContext, CancellationToken, Task<bool>>? refreshIndex = null,
        Func<string, string?, CancellationToken, Task<IndexLookup?>>? waitForLookup = null)
    {
        this.indexLookup = indexLookup ?? (_ => null);
        this.waitForLookup = waitForLookup ?? ((id, _, _) => Task.FromResult(this.indexLookup(id)));
        this.activeDatabase = activeDatabase ?? (context => context.Database);
        this.refreshIndex = refreshIndex;
    }

    public string Id => "sqlserver";

    public LanguageProviderStatus Status() => new(Id, Configured: true, Completion: true, Hover: true, Reason: null, Refresh: true, Diagnostics: true);

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
            var lookup = request.Context.ConnectionId is { } connectionId
                ? await waitForLookup(connectionId, db, operation.Token)
                : null;
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
            var lookup = request.Context.ConnectionId is { } connectionId
                ? await waitForLookup(connectionId, db, operation.Token)
                : null;
            return TsqlHoverService.Hover(request, lookup, db, operation.Token);
        }
        finally { lock (gate) if (ReferenceEquals(document.Active, operation)) document.Active = null; document.Serial.Release(); }
    }

    public async Task<LanguageDiagnosticResult> DiagnosticsAsync(LanguageRefreshRequest request, CancellationToken token)
    {
        var docRequest = new LanguageRequest(request.DocumentId, request.Version, request.Text, request.Context, new(0, 0));
        Validate(docRequest);
        var document = GetDocument(request.DocumentId);
        using var operation = CancellationTokenSource.CreateLinkedTokenSource(token);
        operation.CancelAfter(TimeSpan.FromSeconds(25));
        await document.Serial.WaitAsync(operation.Token);
        try
        {
            AcceptVersionLocked(document, docRequest, checkContextMatch: false, operation);
            var db = activeDatabase(request.Context);
            // Never block diagnostics waiting on an index build: run syntax-only immediately while Building,
            // and let SqlDiagnosticsService re-run when indexStateStore signals index completion.
            var lookup = request.Context.ConnectionId is { } connectionId
                ? indexLookup(connectionId)
                : null;
            return TsqlDiagnosticService.Analyze(request, lookup, db, operation.Token);
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
        lock (gate) ids = [.. documents.Where(pair => pair.Value.ConnectionId == id).Select(pair => pair.Key)];
        await Task.WhenAll(ids.Select(document => CloseAsync(document, CancellationToken.None)));
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
        // ScriptDom's grammar is recursive (including left-recursive binary operators such as ||, +, AND/OR, COLLATE, AT, ::
        // and chained method calls such as x.m().m()...). Tokenize before parsing so hostile nesting or chains fail fast.
        if (tokens.Count > 16_384) return false;
        var parentheses = 0;
        var totalParens = 0;
        var totalDots = 0;
        var chainedDots = 0;
        var recursiveKeywords = 0;
        var unary = 0;
        var operators = 0;
        var prevType = TSqlTokenType.None;
        foreach (var token in tokens)
        {
            if (token.TokenType is TSqlTokenType.WhiteSpace or TSqlTokenType.SingleLineComment or TSqlTokenType.MultilineComment) continue;
            if (token.TokenType == TSqlTokenType.LeftParenthesis && (++parentheses > 64 || ++totalParens > 256)) return false;
            if (token.TokenType == TSqlTokenType.RightParenthesis && --parentheses < 0) return false;
            if (token.TokenType == TSqlTokenType.Dot)
            {
                if (++totalDots > 256) return false;
                if (prevType == TSqlTokenType.RightParenthesis && ++chainedDots > 32) return false;
            }
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
            prevType = token.TokenType;
        }
        return true;
    }

    public void Dispose()
    {
        lock (gate)
        {
            disposed = true;
            foreach (var document in documents.Values) document.Active?.Cancel();
            documents.Clear();
        }
    }

    public void Reset()
    {
        lock (gate)
        {
            foreach (var document in documents.Values) document.Active?.Cancel();
        }
    }
}
