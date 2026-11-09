using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace Varia.Backend.Language;

/// <summary>An engine owns its grammar, metadata/auth adapter and server lifecycle. Implementations may use stdio LSP,
/// an in-process library, or another transport without changing the renderer API.</summary>
internal interface ILanguageServiceProvider : IDisposable
{
    string Id { get; }
    LanguageProviderStatus Status();
    Task<LanguageCompletionResult> CompleteAsync(LanguageRequest request, CancellationToken token);
    Task<LanguageHover?> HoverAsync(LanguageRequest request, CancellationToken token);
    Task<LanguageDiagnosticResult> DiagnosticsAsync(LanguageRefreshRequest request, CancellationToken token);
    Task<LanguageRefreshResult> RefreshAsync(LanguageRefreshRequest request, CancellationToken token);
    Task<LanguageCloseResult> CloseAsync(string documentId, CancellationToken token);
    Task ForgetConnectionAsync(string connectionId);
    void Reset();
}

/// <summary>Routes by explicit engine identity. Each document switches providers in order, including closing the old
/// provider before opening its new context. No SQL Server naming or connection assumptions belong to this registry.</summary>
internal sealed class LanguageServiceBroker(IEnumerable<ILanguageServiceProvider> providers) : IDisposable
{
    internal const int MaxDocuments = 128;
    private readonly Dictionary<string, ILanguageServiceProvider> providers = providers.ToDictionary(provider => provider.Id, StringComparer.Ordinal);
    private readonly object gate = new();
    private readonly Dictionary<string, Binding> documents = new(StringComparer.Ordinal);
    private bool disposed;
    private int suspensions;
    private sealed class Binding
    {
        public readonly SemaphoreSlim Serial = new(1, 1);
        public ILanguageServiceProvider? Provider;
        public CancellationTokenSource? Active;
        public string? ConnectionId;
        public LanguageContext? Context;
        public int Version;
        public string? TextFingerprint;
        public long Epoch;
        public Task<LanguageCloseResult>? CloseTask;
        public bool Closing;
    }

    internal LanguageStatus Status() => new([.. providers.Values.Select(provider => provider.Status())]);
    internal Task<LanguageCompletionResult> CompleteAsync(LanguageRequest request, CancellationToken token) =>
        RequestAsync(request, token, (provider, requestToken) => provider.CompleteAsync(request, requestToken));
    internal Task<LanguageHover?> HoverAsync(LanguageRequest request, CancellationToken token) =>
        RequestAsync(request, token, (provider, requestToken) => provider.HoverAsync(request, requestToken));
    internal Task<LanguageDiagnosticResult> DiagnosticsAsync(LanguageRefreshRequest request, CancellationToken token) =>
        RequestAsync(new(request.DocumentId, request.Version, request.Text, request.Context, new(0, 0)), token,
            (provider, requestToken) => provider.DiagnosticsAsync(request, requestToken));
    internal Task<LanguageRefreshResult> RefreshAsync(LanguageRefreshRequest request, CancellationToken token)
    {
        ValidateId(request.DocumentId);
        if (request.Context is null || !providers.TryGetValue(request.Context.ProviderId, out var provider) || !provider.Status().Refresh)
            throw new RequestException("INVALID_PARAMS", "This database language provider does not support cache refresh.");
        var fingerprint = TextFingerprint(request.Text);
        lock (gate)
        {
            if (documents.TryGetValue(request.DocumentId, out var binding) && !binding.Closing)
            {
                if (binding.Context is not null && binding.Context != request.Context)
                    throw new RequestException("STALE", "The language refresh refers to an older connection context.");
                if (request.Version < binding.Version || request.Version == binding.Version && binding.TextFingerprint is not null && fingerprint != binding.TextFingerprint)
                    throw new RequestException("STALE", "The language refresh refers to an older document version.");
                binding.Epoch++;
                binding.Active?.Cancel();
            }
            // Queue under the gate: subsequent completion/hover requests cannot overtake the refresh. Requests
            // already queued before the epoch changed are discarded when they reach their document gate.
            var document = new LanguageRequest(request.DocumentId, request.Version, request.Text, request.Context, new(0, 0));
            return RequestAsync(document, token, (provider, refreshToken) => provider.RefreshAsync(request, refreshToken));
        }
    }

    private async Task<T> RequestAsync<T>(LanguageRequest request, CancellationToken token, Func<ILanguageServiceProvider, CancellationToken, Task<T>> run)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(25));
        ValidateId(request.DocumentId);
        if (request.Context is null || request.Context.ProviderId is null || !providers.TryGetValue(request.Context.ProviderId, out var provider))
            throw new RequestException("INVALID_PARAMS", "This database language provider is not installed.");
        var fingerprint = TextFingerprint(request.Text);
        Binding binding;
        long epoch;
        while (true)
        {
            Task? closing;
            lock (gate)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                if (suspensions != 0) throw new RequestException("BUSY", "SQL language services are paused while a database management action finishes.");
                if (!documents.TryGetValue(request.DocumentId, out binding!))
                {
                    if (documents.Count >= MaxDocuments) throw new RequestException("BUSY", "Too many SQL language documents are open. Close unused query tabs.");
                    binding = new();
                    documents.Add(request.DocumentId, binding);
                }
                closing = binding.Closing ? binding.CloseTask : null;
                epoch = binding.Epoch;
            }
            if (closing is null) break;
            // An accepted close can still be retiring an idle language process. A newly registered request belongs
            // to the next binding; requests registered before Closing retain the old binding and reject as stale.
            await closing.WaitAsync(deadline.Token);
        }
        await binding.Serial.WaitAsync(deadline.Token);
        try
        {
            lock (gate)
            {
                if (binding.Closing) throw new RequestException("STALE", "The SQL language document has closed.");
                if (binding.Epoch != epoch) throw new RequestException("STALE", "A newer language refresh superseded this request.");
                if (suspensions != 0) throw new RequestException("BUSY", "SQL language services are paused while a database management action finishes.");
                if (request.Version < binding.Version || request.Version == binding.Version && binding.TextFingerprint is not null && fingerprint != binding.TextFingerprint)
                    throw new RequestException("STALE", "The SQL language request refers to an older document version.");
                binding.Active = deadline; binding.ConnectionId = request.Context.ConnectionId; binding.Context = request.Context;
                binding.Version = request.Version; binding.TextFingerprint = fingerprint;
            }
            if (binding.Provider is { } previous && !ReferenceEquals(previous, provider)) await previous.CloseAsync(request.DocumentId, deadline.Token);
            binding.Provider = provider;
            return await run(provider, deadline.Token);
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            var stale = binding.Closing || binding.Epoch != epoch;
            throw new RequestException(stale ? "STALE" : "TIMEOUT", stale ? "The SQL language request was superseded or its document closed." : "The SQL language request exceeded its time limit.");
        }
        finally { lock (gate) binding.Active = null; binding.Serial.Release(); }
    }

    internal async Task<LanguageCloseResult> CloseAsync(string id, CancellationToken token)
    {
        ValidateId(id);
        Binding? binding;
        Task<LanguageCloseResult> cleanup;
        lock (gate)
        {
            if (!documents.TryGetValue(id, out binding)) return new(false);
            binding.Closing = true;
            binding.Active?.Cancel();
            cleanup = binding.CloseTask ??= Task.Run(CloseCoreAsync);
        }
        _ = cleanup.ContinueWith(done => _ = done.Exception, TaskContinuationOptions.OnlyOnFaulted);
        try { return await cleanup.WaitAsync(TimeSpan.FromSeconds(5), token); }
        catch (TimeoutException) { return new(true); } // Accepted: marked closed immediately; bounded cleanup finishes in the background.

        async Task<LanguageCloseResult> CloseCoreAsync()
        {
            // Closing is cleanup: finish releasing state even when the renderer's close deadline expires while queued.
            await binding.Serial.WaitAsync(CancellationToken.None);
            try
            {
                if (binding.Provider is { } provider) await provider.CloseAsync(id, CancellationToken.None);
                return new(true);
            }
            finally
            {
                lock (gate) if (documents.TryGetValue(id, out var current) && ReferenceEquals(current, binding)) documents.Remove(id);
                binding.Serial.Release();
            }
        }
    }

    internal async Task ForgetConnectionAsync(string id)
    {
        string[] ids;
        lock (gate) ids = [.. documents.Where(pair => pair.Value.ConnectionId == id).Select(pair => pair.Key)];
        await Task.WhenAll(ids.Select(document => CloseAsync(document, CancellationToken.None)));
        foreach (var provider in providers.Values) await provider.ForgetConnectionAsync(id);
    }

    /// <summary>Exclusive database actions must not be blocked by this app's own metadata connections. Hold a suspension
    /// through the action so typing cannot open them again between pool cleanup and the actual DDL.</summary>
    internal IDisposable Suspend()
    {
        lock (gate) suspensions++;
        Reset();
        return new Suspension(this);
    }

    internal void Reset()
    {
        lock (gate) foreach (var binding in documents.Values) binding.Active?.Cancel();
        foreach (var provider in providers.Values) provider.Reset();
    }

    private sealed class Suspension(LanguageServiceBroker owner) : IDisposable
    {
        private int ended;
        public void Dispose() { if (Interlocked.Exchange(ref ended, 1) == 0) lock (owner.gate) owner.suspensions--; }
    }

    private static void ValidateId(string? id)
    {
        if (!Guid.TryParseExact(id, "D", out _)) throw new RequestException("INVALID_PARAMS", "A language document ID is required.");
    }

    // Providers own their document budget; stale-request checks must not retain another full copy of every buffer.
    private static string? TextFingerprint(string? text) => text is null ? null : Convert.ToBase64String(SHA256.HashData(MemoryMarshal.AsBytes(text.AsSpan())));

    public void Dispose()
    {
        lock (gate) { disposed = true; foreach (var binding in documents.Values) binding.Active?.Cancel(); documents.Clear(); }
        foreach (var provider in providers.Values) provider.Dispose();
    }
}
