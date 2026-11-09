using System.Collections.Concurrent;
using System.Text.Json;
using Varia.Backend.Language;

namespace Varia.Backend.Tests;

internal static class SqlLanguageDiagnosticChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(15);
    private static JsonElement Element(object? value) => JsonSerializer.SerializeToElement(value, Json);
    private static LanguageRefreshRequest Request(string? id = null, int version = 1, string text = "SELECT missing", LanguageContext? context = null) =>
        new(id ?? Guid.NewGuid().ToString(), version, text, context ?? new("sqlserver"));
    private static object Marker(string message = "Invalid column", int severity = 1) =>
        new { range = new { start = new { line = 0, character = 7 }, end = new { line = 0, character = 14 } }, message, severity, code = 207, source = "MSSQL" };

    public static async Task RunAsync(Action<bool, string> check)
    {
        var normalized = SqlToolsLanguageService.ReadDiagnostics(Element(new[] { Marker(severity: 2) }), "SELECT missing", 3);
        check(normalized.Version == 3 && normalized.Items is [{ Severity: 2, Code: "207", Source: "MSSQL" }] && !normalized.IsIncomplete,
            "diagnostics retain UTF-16 ranges, warning severity, numeric codes and their document version");
        var many = SqlToolsLanguageService.ReadDiagnostics(Element(Enumerable.Range(0, 1001).Select(_ => Marker()).ToArray()), "SELECT missing", 1);
        check(many.Items.Count == SqlToolsLanguageService.MaxDiagnosticItems && many.IsIncomplete, "diagnostic item cap reports explicit truncation");
        var large = SqlToolsLanguageService.ReadDiagnostics(Element(Enumerable.Range(0, 1000).Select(_ => Marker(new string('x', 5000))).ToArray()), "SELECT missing", 1);
        check(large.IsIncomplete && large.Items.All(item => item.Message.Length == 4096)
            && large.Items.Sum(item => item.Message.Length + item.Code!.Length + item.Source!.Length) <= SqlToolsLanguageService.MaxDiagnosticCharacters,
            "diagnostics bound individual messages and aggregate retained response text");
        var invalid = SqlToolsLanguageService.ReadDiagnostics(Element(new[] { Marker(), new { range = new { start = new { line = 0, character = 100 }, end = new { line = 0, character = 101 } }, message = "outside", severity = 1, code = 207, source = "MSSQL" } }), "SELECT missing", 1);
        check(invalid.Items.Count == 1 && invalid.IsIncomplete, "diagnostics reject ranges outside the actual immutable snapshot");

        await BrokerSnapshotChecks(check);

        List<Client> clients = [];
        using (var sql = new SqlToolsLanguageService(_ => null, createClient: notify =>
            { var value = new Client(notify); clients.Add(value); return value; }))
        {
            var request = Request();
            var first = await sql.DiagnosticsAsync(request, default);
            var source = clients.Single();
            var oldUri = source.OpenUris.Single();
            check(first.Items.Count == 1 && clients.Count == 1 && source.Methods.All(method => method != "textDocument/completion"),
                "diagnostics-only editing launches one analysis child without a completion child or completion requests");
            check(source.ErrorChecking && source.LiveUris.Count == 1, "analysis child enables SQL Tools parser and binder diagnostics and retains one snapshot");
            source.AutoPublish = false;
            source.Opened = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var second = sql.DiagnosticsAsync(request with { Version = 2, Text = "SELECT missing;" }, default);
            var newUri = await source.Opened.Task.WaitAsync(Wait);
            await source.Publish(oldUri);
            await source.Publish(newUri, version: 1);
            check(!second.IsCompleted && newUri != oldUri, "late unversioned snapshots and mismatched explicit versions cannot answer a newer analysis");
            await source.Publish(newUri);
            check((await second.WaitAsync(Wait)).Version == 2 && source.LiveUris.Count == 1,
                "unversioned SQL Tools diagnostics bind to an immutable unique URI and release the previous snapshot");
            try { await sql.DiagnosticsAsync(request, default); check(false, "older diagnostic versions reject"); }
            catch (RequestException error) { check(error.Code == "STALE", "provider rejects diagnostic versions older than its latest accepted snapshot"); }
            source.AutoPublish = true;
            await sql.CompleteAsync(new(request.DocumentId, 2, "SELECT missing;", request.Context, new(0, 0)), default);
            check(clients.Count == 2 && clients[1].OpenUris.Count == 1, "completion remains lazy and synchronizes text after diagnostic acceptance");
            await sql.CloseAsync(request.DocumentId, default);
            check(source.Disposed && clients.All(client => client.Disposed), "closing the owning document releases both analysis and completion processes");
        }

        clients.Clear();
        using (var sql = new SqlToolsLanguageService(_ => "Server=unused;Database=One;Integrated Security=true;TrustServerCertificate=true", createClient: notify =>
            { var value = new Client(notify); clients.Add(value); return value; }))
        {
            var first = Request(context: new("sqlserver", Guid.NewGuid().ToString(), "One"));
            await sql.DiagnosticsAsync(first, default);
            var source = clients.Single();
            check(source.OpenedWithCheckingDisabled && source.ErrorChecking,
                "analysis opens and connects with checking disabled before requesting a connected semantic pass");
            var second = Request(context: first.Context with { Database = "Two" });
            await sql.DiagnosticsAsync(second, default);
            check(source.Disposed && clients.Count == 2 && clients[1].LiveUris.Count == 1, "changing analysis context retires the previous database metadata cache");
            await sql.ForgetConnectionAsync(first.Context.ConnectionId!);
            check(clients.All(client => client.Disposed), "disconnecting a connection releases its retained diagnostic snapshot and metadata process");
        }

        clients.Clear();
        using (var sql = new SqlToolsLanguageService(_ => "Server=unused;Database=One;Integrated Security=true;TrustServerCertificate=true", createClient: notify =>
            { var value = new Client(notify); clients.Add(value); return value; }))
        {
            var first = Request(context: new("sqlserver", Guid.NewGuid().ToString(), "One"));
            await sql.DiagnosticsAsync(first, default);
            var source = clients.Single();
            source.ConnectionHeld = new(TaskCreationOptions.RunContinuationsAsynchronously);
            source.ReleaseConnection = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var second = sql.DiagnosticsAsync(Request(context: first.Context), default);
            await source.ConnectionHeld.Task.WaitAsync(Wait);
            await sql.CloseAsync(first.DocumentId, default);
            check(!source.Disposed && !second.IsCompleted, "closing a prior snapshot owner preserves another document's in-flight diagnostic connection");
            source.ReleaseConnection.TrySetResult();
            check((await second.WaitAsync(Wait)).Items.Count == 1 && source.LiveUris.Count == 1,
                "a sibling document completes its connected diagnostic pass after the previous owner closes");
        }

        clients.Clear();
        using (var sql = new SqlToolsLanguageService(_ => null, createClient: notify =>
            { var value = new Client(notify); clients.Add(value); return value; }))
        {
            var request = Request();
            await sql.DiagnosticsAsync(request, default);
            clients[0].Dispose();
            var restarted = await sql.DiagnosticsAsync(request with { Version = 2 }, default);
            check(restarted.Items.Count == 1 && clients.Count == 2 && !clients[1].Methods.Contains("textDocument/didClose"),
                "analysis process loss restarts cleanly without closing an old process's URI in its replacement");
        }

        clients.Clear();
        using (var sql = new SqlToolsLanguageService(_ => null, createClient: notify =>
            { var value = new Client(notify); clients.Add(value); return value; }))
        using (var stop = new CancellationTokenSource())
        {
            var request = Request();
            await sql.CompleteAsync(new(request.DocumentId, request.Version, request.Text, request.Context, new(0, 0)), default);
            var ordinary = clients.Single();
            await sql.DiagnosticsAsync(request, default);
            var source = clients[1];
            source.AutoPublish = false;
            source.Opened = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var pending = sql.DiagnosticsAsync(request with { Version = 2 }, stop.Token);
            await source.Opened.Task.WaitAsync(Wait);
            stop.Cancel();
            try { await pending; check(false, "cancelled diagnostics observe cancellation"); }
            catch (OperationCanceledException) { check(source.Disposed && !ordinary.Disposed, "cancelling analysis releases its ambiguous child and preserves completion metadata"); }
            await sql.DiagnosticsAsync(request with { Version = 3 }, default);
            var restarted = clients[^1];
            restarted.AutoPublish = false;
            restarted.Opened = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var resetPending = sql.DiagnosticsAsync(request with { Version = 4 }, default);
            await restarted.Opened.Task.WaitAsync(Wait);
            sql.Reset();
            try { await resetPending; check(false, "reset settles pending diagnostic requests"); }
            catch (OperationCanceledException) { check(true, "management reset cancels an analysis waiting on an unversioned publication"); }
            check(clients.All(client => client.Disposed), "database management reset retires every analysis child and clears pending publications");
        }

        clients.Clear();
        using (var sql = new SqlToolsLanguageService(_ => null, createClient: notify =>
            { var value = new Client(notify); clients.Add(value); return value; }))
        {
            var request = Request();
            for (var version = 1; version <= SqlToolsLanguageService.MaxDocuments + 1; version++)
                await sql.DiagnosticsAsync(request with { Version = version }, default);
            check(clients.Count == 2 && clients[0].Disposed && clients[1].LiveUris.Count == 1,
                "immutable diagnostic owner churn retires retained SQL Tools parse state at a fixed bound");
        }

        clients.Clear();
        using (var sql = new SqlToolsLanguageService(_ => null, createClient: notify =>
            { var value = new Client(notify); clients.Add(value); return value; }))
        {
            var request = Request(text: new string('x', SqlToolsLanguageService.MaxTextCharacters));
            var snapshots = SqlToolsLanguageService.MaxTotalCharacters / request.Text.Length;
            for (var version = 1; version <= snapshots; version++)
                await sql.DiagnosticsAsync(request with { Version = version }, default);
            check(clients.Count == 1 && !clients[0].Disposed,
                "diagnostic snapshots can fill the aggregate retained text budget exactly without premature retirement");
            await sql.DiagnosticsAsync(request with { Version = snapshots + 1, Text = "x" }, default);
            check(clients.Count == 2 && clients[0].Disposed && clients[1].LiveUris.Count == 1,
                "one character beyond the diagnostic snapshot budget retires retained parse state before opening another buffer");
            await sql.DiagnosticsAsync(request with { Version = snapshots + 2 }, default);
            check(clients.Count == 2 && clients[1].LiveUris.Count == 1,
                "diagnostic process retirement resets the cumulative snapshot text budget");
        }

        Client? idle = null;
        using (var sql = new SqlToolsLanguageService(_ => null, createClient: notify => idle = new Client(notify), diagnosticIdleTimeout: TimeSpan.FromMilliseconds(25)))
        {
            await sql.DiagnosticsAsync(Request(), default);
            await idle!.DisposedSignal.Task.WaitAsync(Wait);
            check(idle.Disposed, "an idle analysis child releases its metadata cache without requiring a document close");
        }
    }

    private static async Task BrokerSnapshotChecks(Action<bool, string> check)
    {
        using var broker = new LanguageServiceBroker([new SqlToolsLanguageService(_ => null, createClient: notify => new Client(notify))]);
        var buffer = SubmitSnapshot(broker);
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        check(!buffer.IsAlive, "the language broker does not retain a completed diagnostic buffer solely for stale-request checks");

        var request = Request(version: 2, text: "SELECT N'🙂'; SELECT missing");
        await broker.DiagnosticsAsync(request, default);
        var same = await broker.DiagnosticsAsync(request with { Text = new string(request.Text.ToCharArray()) }, default);
        check(same.Version == request.Version, "broker snapshot identity accepts equal UTF-16 text in a different string instance");
        var changed = request with { Text = "SELECT N'🙃'; SELECT missing" };
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

    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    private static WeakReference SubmitSnapshot(LanguageServiceBroker broker)
    {
        var text = new string('x', SqlToolsLanguageService.MaxTextCharacters);
        var buffer = new WeakReference(text);
        _ = broker.DiagnosticsAsync(Request(text: text), default).GetAwaiter().GetResult();
        return buffer;
    }

    private static async Task<string?> Code(Func<Task> run)
    {
        try { await run(); return null; }
        catch (RequestException error) { return error.Code; }
    }

    private sealed class Client(Func<string, JsonElement, Task> notification) : ILspClient
    {
        public readonly ConcurrentQueue<string> Methods = new();
        public readonly List<string> OpenUris = [];
        public readonly HashSet<string> LiveUris = [];
        public TaskCompletionSource<string> Opened = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource DisposedSignal = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool AutoPublish = true;
        public bool ErrorChecking;
        public bool OpenedWithCheckingDisabled;
        public bool Disposed;
        public TaskCompletionSource? ConnectionHeld;
        public TaskCompletionSource? ReleaseConnection;
        public Task Completion => completion.Task;
        public async Task<JsonElement> RequestAsync(string method, object? parameters, CancellationToken token = default, TimeSpan? timeout = null)
        {
            token.ThrowIfCancellationRequested();
            Methods.Enqueue(method);
            var value = Element(parameters);
            if (method == "connection/connect")
            {
                if (ReleaseConnection is { } release)
                {
                    ConnectionHeld?.TrySetResult();
                    await release.Task.WaitAsync(token);
                }
                var uri = value.GetProperty("ownerUri").GetString()!;
                await notification("connection/complete", Element(new { ownerUri = uri, connectionId = "connected" }));
                await notification("textDocument/intelliSenseReady", Element(new { ownerUri = uri }));
            }
            return method == "textDocument/completion" ? Element(Array.Empty<object>()) : Element(true);
        }
        public async Task NotifyAsync(string method, object? parameters, CancellationToken token = default)
        {
            token.ThrowIfCancellationRequested();
            Methods.Enqueue(method);
            var value = Element(parameters);
            if (method == "workspace/didChangeConfiguration")
            {
                ErrorChecking = value.GetProperty("settings").GetProperty("mssql").GetProperty("intelliSense").GetProperty("enableErrorChecking").GetBoolean();
                if (AutoPublish && ErrorChecking) foreach (var uri in LiveUris) await Publish(uri);
            }
            if (method == "textDocument/didOpen")
            {
                var uri = value.GetProperty("textDocument").GetProperty("uri").GetString()!;
                OpenUris.Add(uri); LiveUris.Add(uri); OpenedWithCheckingDisabled = !ErrorChecking; Opened.TrySetResult(uri);
                if (AutoPublish && ErrorChecking) await Publish(uri);
            }
            if (method == "textDocument/didClose") LiveUris.Remove(value.GetProperty("textDocument").GetProperty("uri").GetString()!);
        }
        public Task Publish(string uri, int? version = null) => notification("textDocument/publishDiagnostics", Element(new { uri, version, diagnostics = new[] { Marker() } }));
        public void Dispose() { Disposed = true; LiveUris.Clear(); completion.TrySetResult(); DisposedSignal.TrySetResult(); }
    }
}
