using Varia.Backend.Language;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

internal static class SqlLanguageDiagnosticChecks
{
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(15);
    private static LanguageRefreshRequest Request(string? id = null, int version = 1, string text = "SELECT ( FROM dbo.T", LanguageContext? context = null) =>
        new(id ?? Guid.NewGuid().ToString(), version, text, context ?? new("sqlserver"));

    public static async Task RunAsync(Action<bool, string> check)
    {
        await BrokerSnapshotChecks(check);
        await BrokerPreemptionChecks(check);

        // Provider version, context, non-blocking index lookup, and close/forget lifecycle checks.
        var budget = new IndexBudget(1 << 20);
        var connIndex = new ConnectionIndex(budget);
        connIndex.Put(new DatabaseIndex("One", ObjectTable.Of([
            new IndexedObject("table", "tables", "dbo", "Orders"),
            new IndexedObject("column", "columns", null, "OrderId", "table", "dbo", "Orders")
        ]), 0, 0, 0) { CaseSensitive = false });
        connIndex.Put(new DatabaseIndex("Two", ObjectTable.Of([
            new IndexedObject("table", "tables", "dbo", "Invoices"),
            new IndexedObject("column", "columns", null, "InvoiceId", "table", "dbo", "Invoices")
        ]), 0, 0, 0) { CaseSensitive = false });
        var lookup = new IndexLookup(connIndex, budget, false, new LookupLedger().Snapshot());
        var connId = Guid.NewGuid().ToString();
        var waitForLookupCalls = 0;

        try
        {
            using var sql = new TsqlLanguageService(
                indexLookup: cid => cid == connId ? lookup : null,
                waitForLookup: (_, _, _) => { Interlocked.Increment(ref waitForLookupCalls); return Task.FromResult<IndexLookup?>(lookup); });

            var docId = Guid.NewGuid().ToString();
            var first = await sql.DiagnosticsAsync(Request(docId, 1, "SELECT o.MissingCol FROM dbo.Orders AS o", new("sqlserver", connId, "One")), default);
            check(first.Version == 1 && first.Items.Any(i => i.Code == "SQL207") && waitForLookupCalls == 0,
                "diagnostics run in-process against current IndexLookup without blocking on WaitForLookupAsync");

            var fixedSql = await sql.DiagnosticsAsync(Request(docId, 2, "SELECT o.OrderId FROM dbo.Orders AS o", new("sqlserver", connId, "One")), default);
            check(fixedSql.Version == 2 && fixedSql.Items.Count == 0 && !fixedSql.IsIncomplete,
                "fixing an invalid column clears semantic diagnostics immediately");

            check(await Code(() => sql.DiagnosticsAsync(Request(docId, 1, "SELECT o.MissingCol FROM dbo.Orders AS o", new("sqlserver", connId, "One")), default)) == "STALE",
                "provider rejects diagnostic versions older than its latest accepted snapshot");

            var otherDb = await sql.DiagnosticsAsync(Request(docId, 3, "SELECT o.OrderId FROM dbo.Orders AS o", new("sqlserver", connId, "Two")), default);
            check(otherDb.Version == 3 && otherDb.Items.Any(i => i.Code == "SQL208"),
                "switching database context re-binds diagnostics against the newly selected database");

            await sql.ForgetConnectionAsync(connId);
            var reopened = await sql.DiagnosticsAsync(Request(docId, 1, "SELECT ( FROM dbo.Orders", new("sqlserver", connId, "One")), default);
            check(reopened.Version == 1 && reopened.Items.Count > 0,
                "forgetting a connection closes its documents so a fresh version sequence can reopen cleanly");
        }
        finally
        {
            connIndex.Dispose();
        }
    }

    private static async Task BrokerSnapshotChecks(Action<bool, string> check)
    {
        using var broker = new LanguageServiceBroker([new TsqlLanguageService()]);
        var buffer = SubmitSnapshot(broker);
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        check(!buffer.IsAlive, "the language broker does not retain a completed diagnostic buffer solely for stale-request checks");

        var request = Request(version: 2, text: "SELECT N'🙂'; SELECT ( FROM dbo.T");
        await broker.DiagnosticsAsync(request, default);
        var same = await broker.DiagnosticsAsync(request with { Text = new string(request.Text.ToCharArray()) }, default);
        check(same.Version == request.Version, "broker snapshot identity accepts equal UTF-16 text in a different string instance");
        var changed = request with { Text = "SELECT N'🙃'; SELECT ( FROM dbo.T" };
        check(await Code(async () => await broker.DiagnosticsAsync(request with { Version = 1 }, default)) == "STALE"
            && await Code(async () => await broker.DiagnosticsAsync(changed, default)) == "STALE"
            && await Code(async () => await broker.RefreshAsync(changed, default)) == "STALE"
            && await Code(async () => await broker.CompleteAsync(new(changed.DocumentId, changed.Version, changed.Text, changed.Context, new(0, 0)), default)) == "STALE"
            && await Code(async () => await broker.HoverAsync(new(changed.DocumentId, changed.Version, changed.Text, changed.Context, new(0, 0)), default)) == "STALE",
            "broker fingerprints preserve old-version and same-version text rejection across every language operation");
        check(await Code(async () => await broker.DiagnosticsAsync(request with { Version = 3, Text = null! }, default)) == "INVALID_PARAMS"
            && (await broker.DiagnosticsAsync(request with { Version = 3 }, default)).Version == 3,
            "malformed null diagnostic text returns a validation failure and does not prevent a subsequent valid snapshot");
    }

    private static async Task BrokerPreemptionChecks(Action<bool, string> check)
    {
        using (var provider = new AdmissionProvider())
        using (var broker = new LanguageServiceBroker([provider]))
        {
            var request = Request();
            var active = Code(async () => await broker.DiagnosticsAsync(request, default));
            await provider.AnalysisStarted.Task.WaitAsync(Wait);
            var queued = Code(async () => await broker.DiagnosticsAsync(request, default));
            using var cancel = new CancellationTokenSource();
            var cancelledForeground = broker.CompleteAsync(new(request.DocumentId, 1, request.Text, request.Context, new(0, 7)), cancel.Token);
            await provider.AnalysisCancelled.Task.WaitAsync(Wait);
            var hover = broker.HoverAsync(new(request.DocumentId, 1, request.Text, request.Context, new(0, 7)), default);
            check(await queued.WaitAsync(Wait) == "STALE" && provider.Analyses == 1,
                "foreground admission also preempts diagnostics still queued behind the document gate");
            cancel.Cancel();
            try { await cancelledForeground.WaitAsync(Wait); check(false, "cancelled queued foreground preserves caller cancellation"); }
            catch (OperationCanceledException) { check(true, "cancelled queued foreground preserves caller cancellation"); }
            check(await Code(async () => await broker.DiagnosticsAsync(request, default)).WaitAsync(Wait) == "STALE",
                "a remaining queued foreground request keeps new diagnostics paused after another foreground caller cancels");
            provider.ReleaseAnalysis.TrySetResult();
            await provider.ForegroundStarted.Task.WaitAsync(Wait);
            check(await active.WaitAsync(Wait) == "STALE", "preempted active diagnostics report supersession instead of a timeout");
            var completion = broker.CompleteAsync(new(request.DocumentId, 1, request.Text, request.Context, new(0, 7)), default);
            check(await Code(async () => await broker.DiagnosticsAsync(request, default)).WaitAsync(Wait) == "STALE",
                "running and queued foreground requests prevent a new analysis from overtaking them");
            provider.ReleaseForeground.TrySetResult();
            await hover.WaitAsync(Wait);
            await completion.WaitAsync(Wait);
            var resumed = await broker.DiagnosticsAsync(request, default).WaitAsync(Wait);
            check(resumed.Version == 1 && provider.Analyses == 2,
                "foreground preemption does not invalidate queued foreground work or leak cancelled admission counts");
        }

        foreach (var close in new[] { false, true })
        {
            using var provider = new AdmissionProvider();
            using var broker = new LanguageServiceBroker([provider]);
            var request = Request();
            var active = Code(async () => await broker.DiagnosticsAsync(request, default));
            await provider.AnalysisStarted.Task.WaitAsync(Wait);
            Task finish = close ? broker.CloseAsync(request.DocumentId, default) : broker.RefreshAsync(request, default);
            await provider.AnalysisCancelled.Task.WaitAsync(Wait);
            provider.ReleaseAnalysis.TrySetResult();
            provider.ReleaseForeground.TrySetResult();
            await finish.WaitAsync(Wait);
            var retry = await broker.DiagnosticsAsync(request, default).WaitAsync(Wait);
            check(await active.WaitAsync(Wait) == "STALE" && retry.Version == request.Version && (!close || provider.Closes == 1),
                close ? "closing a preempted analysis releases its binding and permits a fresh document registration"
                    : "refresh supersedes held analysis while preserving a subsequent diagnostic retry");
        }
    }

    private sealed class AdmissionProvider : ILanguageServiceProvider
    {
        public readonly TaskCompletionSource AnalysisStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource AnalysisCancelled = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource ReleaseAnalysis = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource ForegroundStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource ReleaseForeground = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int Analyses;
        public int Closes;
        public string Id => "sqlserver";
        public LanguageProviderStatus Status() => new(Id, true, true, true, Refresh: true, Diagnostics: true);
        public async Task<LanguageDiagnosticResult> DiagnosticsAsync(LanguageRefreshRequest request, CancellationToken token)
        {
            if (++Analyses == 1)
            {
                AnalysisStarted.TrySetResult();
                try { await Task.Delay(Timeout.Infinite, token); }
                catch (OperationCanceledException)
                {
                    AnalysisCancelled.TrySetResult();
                    // Keep cleanup controllable so tests can register queued work before releasing the gate.
                    await ReleaseAnalysis.Task.WaitAsync(Wait);
                    throw;
                }
            }
            return new(request.Version, []);
        }
        private async Task ForegroundAsync(CancellationToken token)
        {
            ForegroundStarted.TrySetResult();
            await ReleaseForeground.Task.WaitAsync(token);
        }
        public async Task<LanguageCompletionResult> CompleteAsync(LanguageRequest request, CancellationToken token)
        { await ForegroundAsync(token); return new([], false); }
        public async Task<LanguageHover?> HoverAsync(LanguageRequest request, CancellationToken token)
        { await ForegroundAsync(token); return null; }
        public async Task<LanguageRefreshResult> RefreshAsync(LanguageRefreshRequest request, CancellationToken token)
        { await ForegroundAsync(token); return new(true); }
        public Task<LanguageCloseResult> CloseAsync(string id, CancellationToken token) { Closes++; return Task.FromResult(new LanguageCloseResult(true)); }
        public Task ForgetConnectionAsync(string id) => Task.CompletedTask;
        public void Reset() { }
        public void Dispose() { ReleaseAnalysis.TrySetResult(); ReleaseForeground.TrySetResult(); }
    }

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static WeakReference SubmitSnapshot(LanguageServiceBroker broker)
    {
        var text = new string(' ', TsqlLanguageService.MaxTextCharacters);
        var buffer = new WeakReference(text);
        _ = broker.DiagnosticsAsync(Request(text: text), default).GetAwaiter().GetResult();
        return buffer;
    }

    private static async Task<string?> Code(Func<Task> run)
    {
        try { await run(); return null; }
        catch (RequestException error) { return error.Code; }
    }
}
