using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Language;
using Varia.Backend.Search;

namespace Varia.Backend.Tests;

internal static class SqlLanguageChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly TimeSpan CheckWait = TimeSpan.FromSeconds(15);
    private static JsonElement Element(object? value) => JsonSerializer.SerializeToElement(value, Json);
    private static async Task<string?> Code(Func<Task> run)
    {
        try { await run(); return null; }
        catch (RequestException error) { return error.Code; }
    }
    private static LanguageRequest Request(string? id = null, int version = 1, string text = "SELECT ", LanguageContext? context = null) =>
        new(id ?? Guid.NewGuid().ToString(), version, text, context ?? new("sqlserver"), SqlToolsLanguageService.EndPosition(text));

    public static async Task RunAsync(Action<bool, string> check)
    {
        RuntimeResolution(check);

        // Even when the STS runtime path is invalid, in-process ScriptDom completion/hover/refresh stay configured & working,
        // while diagnostics accurately reports unavailable without launching a process.
        using (var missing = new SqlToolsLanguageService(_ => null, "relative-untrusted.exe"))
        {
            var status = missing.Status();
            check(status.Configured && status.Completion && status.Hover && status.Refresh && !status.Diagnostics
                && status.Reason!.Contains("absolute path"),
                "SQL language status keeps ScriptDom completion/hover configured when STS diagnostics path is invalid");
            var offline = await missing.CompleteAsync(Request(text: "SELECT @@ROW"), default);
            check(offline.Items.Any(i => i.Label == "@@ROWCOUNT"),
                "in-process ScriptDom completion works even when STS diagnostic executable is unavailable");
            check(await Code(async () => await missing.DiagnosticsAsync(new(Guid.NewGuid().ToString(), 1, "SELECT 1", new("sqlserver")), default)) == "BACKEND_UNAVAILABLE",
                "diagnostics fails without launching a process when STS executable is unavailable");
        }

        check(SqlToolsLanguageService.PositionInText("a\r\n🙂\rx\ny", new(1, 2))
            && !SqlToolsLanguageService.PositionInText("a\r\n🙂\rx\ny", new(1, 3))
            && SqlToolsLanguageService.EndPosition("a\r\n🙂\rx\ny") == new LanguagePosition(3, 1), "language positions use UTF-16 and treat CRLF as one line break");

        // Verify zero STS child processes are spawned for completion, hover, and refresh.
        var spawnedClients = 0;
        var refreshCalls = 0;
        var budget = new IndexBudget(1 << 20);
        var connIndex = new ConnectionIndex(budget);
        var people = new IndexedObject("table", "tables", "dbo", "People");
        var idCol = new IndexedObject("column", "columns", null, "PersonId", "table", "dbo", "People");
        connIndex.Put(new DatabaseIndex("One", ObjectTable.Of([people, idCol]), 0, 0, 0) { CaseSensitive = false });
        var twoTable = new IndexedObject("table", "tables", "dbo", "Orders");
        var orderCol = new IndexedObject("column", "columns", null, "OrderId", "table", "dbo", "Orders");
        connIndex.Put(new DatabaseIndex("Two", ObjectTable.Of([twoTable, orderCol]), 0, 0, 0) { CaseSensitive = false });
        var lookup = new IndexLookup(connIndex, budget, false, new LookupLedger().Snapshot());

        var id = Guid.NewGuid().ToString();
        var connectionId = Guid.NewGuid().ToString();
        var settings = "Server=unused;Database=One;User ID=test;Password=private-secret;Encrypt=Strict;Host Name In Certificate=db.example";
        using (var sql = new SqlToolsLanguageService(
            _ => settings,
            createClient: _ => { Interlocked.Increment(ref spawnedClients); throw new InvalidOperationException("Completion/hover/refresh must never spawn an STS child."); },
            indexLookup: cid => cid == connectionId ? lookup : null,
            refreshIndex: (_, _) => { Interlocked.Increment(ref refreshCalls); return Task.FromResult(true); }))
        {
            var request = Request(id, text: "SELECT * FROM dbo.Peop", context: new("sqlserver", connectionId, "One"));
            var first = await sql.CompleteAsync(request, default);
            check(first.Items.Any(item => item.Label == "[People]" && item.TextEdit?.NewText == "[People]") && spawnedClients == 0,
                "in-process SQL completion resolves indexed tables with bracketed text edits and spawns zero STS processes");

            var hoverReq = new LanguageRequest(id, 2, "SELECT p.PersonId FROM dbo.People AS p", new("sqlserver", connectionId, "One"), new(0, 12));
            var freshHover = await sql.HoverAsync(hoverReq, default);
            check(freshHover is not null && freshHover.Contents.Contains("PersonId", StringComparison.Ordinal) && spawnedClients == 0,
                "in-process SQL hover describes indexed columns and spawns zero STS processes");

            check(await Code(async () => await sql.CompleteAsync(request, default)) == "STALE", "SQL provider refuses a stale version before publishing completion");
            check(await Code(async () => await sql.CompleteAsync(hoverReq with { Text = "different", Position = new(0, 0) }, default)) == "STALE",
                "SQL provider refuses different text under an already accepted version");

            var otherDb = await sql.HoverAsync(new(id, 3, "SELECT o.OrderId FROM dbo.Orders AS o", new("sqlserver", connectionId, "Two"), new(0, 12)), default);
            check(otherDb is not null && otherDb.Contents.Contains("OrderId", StringComparison.Ordinal) && spawnedClients == 0,
                "switching database reads that database from IndexLookup in-process without spawning STS");

            var refreshed = await sql.RefreshAsync(new(id, 3, "SELECT o.OrderId FROM dbo.Orders AS o", new("sqlserver", connectionId, "Two")), default);
            check(refreshed.Refreshed && refreshCalls == 1 && spawnedClients == 0,
                "SQL Server cache refresh invokes index refresh in-process without spawning an STS completion child");
            check(!(await sql.RefreshAsync(new(Guid.NewGuid().ToString(), 1, "SELECT 1", new("sqlserver")), default)).Refreshed && refreshCalls == 1,
                "disconnected refresh reports no database cache without invoking index refresh");
            check(await Code(async () => await sql.RefreshAsync(new(id, 2, "SELECT o.OrderId FROM dbo.Orders AS o", new("sqlserver", connectionId, "Two")), default)) == "STALE"
                && await Code(async () => await sql.RefreshAsync(new(id, 3, "SELECT o.OrderId FROM dbo.Orders AS o", new("sqlserver", connectionId, "One")), default)) == "STALE",
                "stale versions and mismatched contexts are refused before any refresh runs");

            check((await sql.CloseAsync(id, default)).Closed && !(await sql.CloseAsync(id, default)).Closed, "closing SQL language documents releases lifecycle state and is idempotent");
            var reopened = await sql.CompleteAsync(Request(id, 1, "SELECT * FROM dbo.Peop", new("sqlserver", connectionId, "One")), default);
            check(reopened.Items.Any(i => i.Label == "[People]"), "closed document IDs can reopen with a fresh version sequence");
            check(spawnedClients == 0, "zero STS processes were created across all completion, hover, refresh, and close calls");
        }
        connIndex.Dispose();

        // Broker routing, suspension, document cap LRU reclamation, and busy refusal.
        var firstProvider = new StubProvider("sqlserver");
        var secondProvider = new StubProvider("postgresql");
        using (var broker = new LanguageServiceBroker([firstProvider, secondProvider]))
        {
            var request = Request();
            await broker.CompleteAsync(request, default);
            await broker.CompleteAsync(request with { Context = new("postgresql") }, default);
            check(firstProvider.Closes == 1 && secondProvider.Requests == 1 && broker.Status().Providers.Count == 2,
                "provider registry dispatches a second engine and closes the former provider on context change");
            check(await Code(async () => await broker.CompleteAsync(request with { Context = new("bigquery") }, default)) == "INVALID_PARAMS",
                "broker rejects unavailable engines rather than routing them to T-SQL");
            using (broker.Suspend())
                check(await Code(async () => await broker.CompleteAsync(request, default)) == "BUSY" && firstProvider.Resets == 1 && secondProvider.Resets == 1,
                    "database-management suspension resets every provider and prevents metadata reconnection");
            await broker.CompleteAsync(request, default);
            check(firstProvider.Requests == 2, "language requests resume after the management suspension ends");
        }

        await BrokerLifecycleChecks(check);

        check(await Code(() => { SqlToolsLanguageService.Validate(Request(text: new string('x', 250_001))); return Task.CompletedTask; }) == "INVALID_PARAMS",
            "backend independently bounds SQL language documents");

        using var service = new SqlService();
        var strict = new JsonSerializerOptions(JsonSerializerDefaults.Web) { UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow };
        try
        {
            await service.DispatchAsync("language.status", Element(new { unexpected = true }), strict);
            check(false, "language status rejects unexpected request properties");
        }
        catch (JsonException) { check(true, "language status rejects unexpected properties for ProtocolHost's INVALID_PARAMS response"); }

        var registered = service.Register(settings, ServerProfile.Fallback("16.0"), "One");
        var inherited = new SqlConnectionStringBuilder(service.LanguageConnectionString(new("sqlserver", registered, "Other;Name"))!);
        check(inherited.InitialCatalog == "Other;Name" && inherited.Encrypt == SqlConnectionEncryptOption.Strict && inherited.Password == "private-secret"
            && inherited.HostNameInCertificate == "db.example" && !inherited.Pooling,
            "language diagnostic settings preserve auth and certificate requirements while safely overriding the selected database");

        // Microsoft Entra ID: unlocked for ScriptDom + IndexLookup completion & hover; diagnostics still returns AUTH_UNSUPPORTED until PR-6.
        var entra = service.Register("Server=unused;Authentication=Active Directory Interactive", ServerProfile.Fallback("16.0"), "EntraDb");
        var entraTable = new IndexedObject("table", "tables", "dbo", "EntraCustomers");
        var entraCol = new IndexedObject("column", "columns", null, "TenantName", "table", "dbo", "EntraCustomers");
        service.Search.Held(entra).Put(new DatabaseIndex("EntraDb", ObjectTable.Of([entraTable, entraCol]), 0, 0, 0) { CaseSensitive = false });

        check(service.LanguageActiveDatabase(new("sqlserver", entra)) == "EntraDb",
            "Microsoft Entra ID resolves active database for in-process ScriptDom completion and hover");
        var entraDoc = Guid.NewGuid().ToString();
        var entraComp = (LanguageCompletionResult)await service.DispatchAsync("language.complete", Element(new LanguageRequest(
            entraDoc, 1, "SELECT c. FROM dbo.EntraCustomers AS c", new("sqlserver", entra, "EntraDb"), new(0, 9))), strict);
        check(entraComp.Items.Any(i => i.Label == "[TenantName]"),
            "Microsoft Entra ID SQL Server connections complete table columns via ScriptDom + IndexLookup");
        var entraHover = (LanguageHover?)await service.DispatchAsync("language.hover", Element(new LanguageRequest(
            entraDoc, 2, "SELECT c.TenantName FROM dbo.EntraCustomers AS c", new("sqlserver", entra, "EntraDb"), new(0, 12))), strict);
        check(entraHover is not null && entraHover.Contents.Contains("TenantName", StringComparison.Ordinal) && entraHover.Contents.Contains("EntraCustomers", StringComparison.Ordinal),
            "Microsoft Entra ID SQL Server connections serve column hover via ScriptDom + IndexLookup");
        check(await Code(() => { service.LanguageConnectionString(new("sqlserver", entra)); return Task.CompletedTask; }) == "AUTH_UNSUPPORTED",
            "STS diagnostic connection string still refuses Entra ID until Phase 2 replaces STS diagnostics");
        check(service.LaneOf("language.close") == Varia.Backend.Protocol.RequestLane.Control, "language close can cancel requests without waiting for a metadata lane");
        check(service.LaneOf("language.refresh") == Varia.Backend.Protocol.RequestLane.Control, "language refresh can supersede a pending completion without waiting for a metadata lane");
    }

    private static async Task BrokerLifecycleChecks(Action<bool, string> check)
    {
        var provider = new StubProvider("sqlserver") { CloseRelease = new(TaskCreationOptions.RunContinuationsAsynchronously) };
        using (var broker = new LanguageServiceBroker([provider]))
        {
            var request = Request();
            await broker.CompleteAsync(request, default);
            var closing = broker.CloseAsync(request.DocumentId, default);
            await provider.CloseStarted.Task.WaitAsync(CheckWait);
            check((await closing.WaitAsync(CheckWait)).Closed && !provider.CloseRelease.Task.IsCompleted,
                "broker accepts slow document cleanup before the provider's cleanup finishes");
            var replacement = request with { Context = new("sqlserver", Guid.NewGuid().ToString(), "Two") };
            var next = broker.CompleteAsync(replacement, default);
            var refresh = broker.RefreshAsync(new(replacement.DocumentId, replacement.Version, replacement.Text, replacement.Context), default);
            check(!next.IsCompleted && !refresh.IsCompleted && provider.Requests == 1, "requests registered after an accepted close wait for the next binding");
            provider.CloseRelease.TrySetResult();
            check((await next.WaitAsync(CheckWait)).Items.Count == 0 && (await refresh.WaitAsync(CheckWait)).Refreshed && provider.Requests == 2,
                "new context work resumes after accepted-close cleanup instead of receiving a stale binding error");
        }

        // At the document cap, the broker reclaims the least recently used idle document.
        var capped = new StubProvider("sqlserver");
        using (var broker = new LanguageServiceBroker([capped]))
        {
            var open = Enumerable.Range(0, LanguageServiceBroker.MaxDocuments).Select(_ => Request()).ToArray();
            foreach (var document in open) await broker.CompleteAsync(document, default);
            await broker.CompleteAsync(open[0] with { Version = 2 }, default);
            var extra = Request();
            var admitted = (await broker.CompleteAsync(extra, default).WaitAsync(CheckWait)).Items.Count == 0;
            check(admitted && capped.Closed.SequenceEqual([open[1].DocumentId]) && capped.Requests == LanguageServiceBroker.MaxDocuments + 2,
                "at the document cap the broker reclaims the least recently used idle document and admits the new one");
            await broker.CompleteAsync(open[1] with { Version = 2 }, default).WaitAsync(CheckWait);
            check(capped.Closed.SequenceEqual([open[1].DocumentId, open[2].DocumentId]), "a reclaimed document opens again on its next request, reclaiming the next idle one");
        }

        var draining = new StubProvider("sqlserver");
        using (var broker = new LanguageServiceBroker([draining]))
        {
            var open = Enumerable.Range(0, LanguageServiceBroker.MaxDocuments).Select(_ => Request()).ToArray();
            foreach (var document in open) await broker.CompleteAsync(document, default);
            draining.CloseRelease = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var closing = broker.CloseAsync(open[^1].DocumentId, default);
            await draining.CloseStarted.Task.WaitAsync(CheckWait);
            var waiting = broker.CompleteAsync(Request(), default);
            var held = !waiting.IsCompleted;
            draining.CloseRelease.TrySetResult();
            await waiting.WaitAsync(CheckWait);
            await closing.WaitAsync(CheckWait);
            check(held && draining.Closed.SequenceEqual([open[^1].DocumentId]),
                "at the document cap a new document waits for a close already under way rather than releasing a live idle one");
        }

        var busy = new StubProvider("sqlserver") { CompleteRelease = new(TaskCreationOptions.RunContinuationsAsynchronously) };
        using (var broker = new LanguageServiceBroker([busy]))
        {
            var held = Enumerable.Range(0, LanguageServiceBroker.MaxDocuments).Select(_ => broker.CompleteAsync(Request(), default)).ToArray();
            var all = SpinWait.SpinUntil(() => Volatile.Read(ref busy.Requests) == LanguageServiceBroker.MaxDocuments, CheckWait);
            string? refused = null;
            try { await broker.CompleteAsync(Request(), default).WaitAsync(CheckWait); }
            catch (RequestException error) { refused = error.Code; }
            busy.CompleteRelease.TrySetResult();
            await Task.WhenAll(held).WaitAsync(CheckWait);
            check(all && refused == "BUSY" && busy.Closes == 0, "at the document cap with every document in use, a new document is refused BUSY and none is reclaimed");
        }
    }

    private static void RuntimeResolution(Action<bool, string> check)
    {
        var directory = Path.Combine(Path.GetTempPath(), "varia-sqltools-runtime-" + Guid.NewGuid().ToString("N"));
        try
        {
            var backend = Path.Combine(directory, "backend", "Varia.Backend", "bin", "Debug", "net11.0");
            var source = Path.Combine(directory, "artifacts", "sqltools-service", "win-x64", "MicrosoftSqlToolsServiceLayer.exe");
            Directory.CreateDirectory(Path.GetDirectoryName(source)!);
            File.WriteAllText(source, "path fixture only");
            var runtime = SqlToolsRuntime.Bundled(backend, "win", "x64");
            check(runtime.ExecutablePath == source && !runtime.IsOverride && runtime.UnavailableReason() is null,
                "direct source backend resolves the prepared host RID runtime without environment configuration");
            check(runtime.Arguments.SequenceEqual(new[] { "--parent-pid", Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture), "--tracing-level", "Off" }),
                "production SQL Tools launch disables implicit disk logs that could contain SQL or exception details");
            var installedBackend = Path.Combine(directory, "resources", "backend");
            var installed = Path.Combine(directory, "resources", "sqltools-service", "MicrosoftSqlToolsServiceLayer");
            Directory.CreateDirectory(Path.GetDirectoryName(installed)!);
            File.WriteAllText(installed, "path fixture only");
            check(SqlToolsRuntime.Bundled(installedBackend, "osx", "arm64").ExecutablePath == installed,
                "installed backend resolves its sibling bundled runtime");
            check(SqlToolsRuntime.Resolve("missing-explicit-override.exe").IsOverride
                && SqlToolsRuntime.Resolve("missing-explicit-override.exe").ExecutablePath == "missing-explicit-override.exe",
                "an explicit invalid runtime override never falls back to bundled files");
            check(new SqlToolsRuntime(Path.Combine(directory, "missing"), false).UnavailableReason()!.Contains("Reinstall Varia"),
                "missing bundled runtime explains repair without requiring an environment variable");
        }
        finally { if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true); }
    }

    private sealed class StubProvider(string id) : ILanguageServiceProvider
    {
        public string Id { get; } = id;
        public int Requests;
        public int Closes;
        public int Resets;
        public readonly ConcurrentQueue<string> Closed = new();
        public readonly TaskCompletionSource CloseStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource? CloseRelease;
        public TaskCompletionSource? CompleteRelease;
        public LanguageProviderStatus Status() => new(Id, true, true, true, Refresh: true, Diagnostics: true);
        public async Task<LanguageCompletionResult> CompleteAsync(LanguageRequest request, CancellationToken token)
        {
            Interlocked.Increment(ref Requests);
            if (CompleteRelease is { } release) await release.Task.WaitAsync(token);
            return new([], false);
        }
        public Task<LanguageHover?> HoverAsync(LanguageRequest request, CancellationToken token) => Task.FromResult<LanguageHover?>(null);
        public Task<LanguageDiagnosticResult> DiagnosticsAsync(LanguageRefreshRequest request, CancellationToken token) => Task.FromResult(new LanguageDiagnosticResult(request.Version, []));
        public Task<LanguageRefreshResult> RefreshAsync(LanguageRefreshRequest request, CancellationToken token) => Task.FromResult(new LanguageRefreshResult(true));
        public async Task<LanguageCloseResult> CloseAsync(string documentId, CancellationToken token)
        {
            CloseStarted.TrySetResult();
            if (CloseRelease is { } release) await release.Task.WaitAsync(token);
            Closed.Enqueue(documentId);
            Interlocked.Increment(ref Closes);
            return new(true);
        }
        public Task ForgetConnectionAsync(string connectionId) => Task.CompletedTask;
        public void Reset() => Interlocked.Increment(ref Resets);
        public void Dispose() { CloseRelease?.TrySetResult(); CompleteRelease?.TrySetResult(); }
    }
}
