using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Language;

namespace Varia.Backend.Tests;

internal static class SqlLanguageChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    // These waits observe a condition, not a latency target. Leave headroom when five offline test processes share
    // three CPUs; assertions on request counts still prove that empty/offline responses do not enter retry loops.
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
        using (var missing = new SqlToolsLanguageService(_ => null, "relative-untrusted.exe"))
        {
            check(!missing.Status().Configured && missing.Status().Reason!.Contains("absolute path"), "SQL language status explains an invalid trusted executable path");
            check(await Code(async () => await missing.CompleteAsync(Request(), default)) == "BACKEND_UNAVAILABLE", "unconfigured language provider fails without launching a process");
        }
        check(SqlToolsLanguageService.PositionInText("a\r\n🙂\rx\ny", new(1, 2))
            && !SqlToolsLanguageService.PositionInText("a\r\n🙂\rx\ny", new(1, 3))
            && SqlToolsLanguageService.EndPosition("a\r\n🙂\rx\ny") == new LanguagePosition(3, 1), "language positions use UTF-16 and treat CRLF as one line break");

        var fake = new FakeClient();
        var id = Guid.NewGuid().ToString();
        var connectionId = Guid.NewGuid().ToString();
        var settings = "Server=unused;Database=One;User ID=test;Password=private-secret;Encrypt=Strict;Host Name In Certificate=db.example";
        using (var sql = new SqlToolsLanguageService(_ => settings, createClient: notify => { fake.Notification = notify; return fake; }))
        {
            var request = Request(id, text: "SELECT \r\n🙂", context: new("sqlserver", connectionId, "One"));
            var first = await sql.CompleteAsync(request, default);
            check(first.Items.Count == 1 && first.Items[0].TextEdit?.NewText == "[dbo].[People]" && first.Items[0].Documentation == "A table", "SQL completion preserves typed replacement ranges and flattens documentation");
            var calls = fake.Calls.ToArray();
            check(calls[0].Method == "initialize" && calls[1].Method == "initialized" && calls.Any(call => call.Method == "workspace/didChangeConfiguration"), "SQL provider initializes LSP before synchronizing a document");
            check(Array.FindIndex(calls, call => call.Method == "textDocument/didOpen") < Array.FindIndex(calls, call => call.Method == "connection/connect"),
                "the unsaved workspace buffer exists before SQL metadata connection prepopulation begins");
            var connect = calls.Single(call => call.Method == "connection/connect").Parameters;
            check(connect.GetProperty("ownerUri").GetString() == "varia-sql://query/" + id
                && connect.GetProperty("connection").GetProperty("options").GetProperty("connectionString").GetString() == settings,
                "SQL provider sends the backend-owned complete connection settings under its document URI");
            check(calls.Single(call => call.Method == "textDocument/didOpen").Parameters.GetProperty("textDocument").GetProperty("text").GetString() == request.Text,
                "SQL provider opens the exact unsaved document text");
            var changed = request with { Version = 2, Text = "SELECT 2", Position = new(0, 8) };
            var freshHover = await sql.HoverAsync(changed, default);
            await sql.HoverAsync(changed, default);
            check(freshHover?.Contents == "int\n\nA column" && fake.Calls.Count(call => call.Method == "textDocument/completion") == 2,
                "hover warms the changed parse tree once per version when STS diagnostics are disabled");
            var change = fake.Calls.Single(call => call.Method == "textDocument/didChange").Parameters.GetProperty("contentChanges")[0];
            check(change.GetProperty("range").GetProperty("end").GetProperty("line").GetInt32() == 1
                && change.GetProperty("range").GetProperty("end").GetProperty("character").GetInt32() == 2
                && change.GetProperty("rangeLength").GetInt32() == request.Text.Length
                && change.GetProperty("text").GetString() == "SELECT 2", "STS didChange replaces the old document with an explicit UTF-16 range");
            check(await Code(async () => await sql.CompleteAsync(request, default)) == "STALE", "SQL provider refuses a stale version before publishing completion");
            check(await Code(async () => await sql.CompleteAsync(request with { Version = 2, Text = "different", Position = new(0, 0) }, default)) == "STALE",
                "SQL provider refuses different text under an already synchronized version");
            var hover = await sql.HoverAsync(Request(id, 2, "SELECT 2", new("sqlserver", connectionId, "Two")), default);
            check(hover?.Contents == "int\n\nA column" && fake.Calls.Count(call => call.Method == "textDocument/didOpen") == 2
                && fake.Calls.Count(call => call.Method == "connection/disconnect") == 1, "changing database closes and reopens the document even when its text version is unchanged");
            check((await sql.CloseAsync(id, default)).Closed && !(await sql.CloseAsync(id, default)).Closed, "closing SQL language documents releases lifecycle state and is idempotent");
            await sql.CompleteAsync(Request(id, 1, "SELECT "), default);
            check(fake.Calls.Count(call => call.Method == "textDocument/didOpen") == 3, "closed document IDs can reopen with a fresh version sequence");
        }

        var delayed = new FakeClient { AutoConnect = false };
        using (var sql = new SqlToolsLanguageService(_ => settings, createClient: notify => { delayed.Notification = notify; return delayed; }))
        {
            var pending = sql.CompleteAsync(Request(), default);
            await delayed.ConnectionRequested.Task.WaitAsync(CheckWait);
            check(!pending.IsCompleted && !delayed.Calls.Any(call => call.Method == "textDocument/completion"), "connection acknowledgement does not permit completion before connection/complete");
            await delayed.CompleteConnectionAsync(success: false);
            check(await Code(async () => await pending) == "NOT_CONNECTED" && delayed.Disposed, "asynchronous SQL connection failure terminates the ambiguous metadata process");
        }

        var metadata = new FakeClient { AutoReady = false };
        using (var sql = new SqlToolsLanguageService(_ => settings, createClient: notify => { metadata.Notification = notify; return metadata; }))
        {
            var pending = sql.CompleteAsync(Request(), default);
            await metadata.LoginCompleted.Task.WaitAsync(CheckWait);
            check(!pending.IsCompleted && !metadata.Calls.Any(call => call.Method == "textDocument/completion"),
                "successful SQL login still waits for the server's metadata-ready notification");
            await metadata.ReadyAsync();
            check((await pending.WaitAsync(CheckWait)).Items.Count == 1, "metadata-ready notification releases the first schema-aware request");
        }

        var cold = new FakeClient { NullCompletionsRemaining = 2 };
        using (var sql = new SqlToolsLanguageService(_ => settings, createClient: notify => { cold.Notification = notify; return cold; }))
        {
            var request = Request(context: new("sqlserver", Guid.NewGuid().ToString(), "One"));
            var result = await sql.CompleteAsync(request, default).WaitAsync(CheckWait);
            check(result.Items.Count == 1 && cold.Calls.Count(call => call.Method == "textDocument/completion") == 3,
                "one public completion waits through raw null binding-busy responses until actual catalog items arrive");
            await sql.HoverAsync(request, default);
            check(cold.Calls.Count(call => call.Method == "textDocument/completion") == 3, "a non-null completion result marks the current parse ready for hover");
        }

        var empty = new FakeClient { EmptyCompletions = true };
        using (var sql = new SqlToolsLanguageService(_ => settings, createClient: notify => { empty.Notification = notify; return empty; }))
        {
            var result = await sql.CompleteAsync(Request(context: new("sqlserver", Guid.NewGuid().ToString())), default).WaitAsync(CheckWait);
            check(result.Items.Count == 0 && empty.Calls.Count(call => call.Method == "textDocument/completion") == 1,
                "a legitimate non-null empty completion array is returned immediately without retrying");
        }

        var offline = new FakeClient { AlwaysNullCompletions = true };
        using (var sql = new SqlToolsLanguageService(_ => null, createClient: notify => { offline.Notification = notify; return offline; }))
        {
            var result = await sql.CompleteAsync(Request(), default).WaitAsync(CheckWait);
            check(result.Items.Count == 0 && offline.Calls.Count(call => call.Method == "textDocument/completion") == 1,
                "an unconnected null completion result does not wait for a nonexistent catalog");
        }

        var cancelled = new FakeClient { AlwaysNullCompletions = true };
        using (var sql = new SqlToolsLanguageService(_ => settings, createClient: notify => { cancelled.Notification = notify; return cancelled; }))
        using (var stop = new CancellationTokenSource())
        {
            var pending = sql.CompleteAsync(Request(context: new("sqlserver", Guid.NewGuid().ToString())), stop.Token);
            await cancelled.CompletionRequested.Task.WaitAsync(CheckWait);
            stop.Cancel();
            try { await pending; check(false, "catalog wait observes cancellation"); }
            catch (OperationCanceledException) { check(cancelled.Calls.Count(call => call.Method == "textDocument/completion") == 1, "cancelling catalog readiness stops before another language read is sent"); }
        }

        var blocked = new FakeClient { HoldCompletion = true };
        using (var broker = new LanguageServiceBroker([new SqlToolsLanguageService(_ => null, createClient: notify => { blocked.Notification = notify; return blocked; })]))
        {
            var request = Request();
            var pending = broker.CompleteAsync(request, default);
            await blocked.CompletionRequested.Task.WaitAsync(CheckWait);
            var close = broker.CloseAsync(request.DocumentId, default);
            check(await Code(async () => await pending) == "STALE", "closing a model cancels its active language request");
            check((await close.WaitAsync(CheckWait)).Closed, "active-request cancellation lets language close finish before its request deadline");
            check(await Code(async () => await broker.CompleteAsync(request with { Context = new("bigquery") }, default)) == "INVALID_PARAMS", "broker rejects unavailable engines rather than routing them to T-SQL");
        }

        var firstProvider = new StubProvider("sqlserver"); var secondProvider = new StubProvider("postgresql");
        using (var broker = new LanguageServiceBroker([firstProvider, secondProvider]))
        {
            var request = Request();
            await broker.CompleteAsync(request, default);
            await broker.CompleteAsync(request with { Context = new("postgresql") }, default);
            check(firstProvider.Closes == 1 && secondProvider.Requests == 1 && broker.Status().Providers.Count == 2,
                "provider registry dispatches a second engine and closes the former provider on context change");
            using (broker.Suspend())
                check(await Code(async () => await broker.CompleteAsync(request, default)) == "BUSY" && firstProvider.Resets == 1 && secondProvider.Resets == 1,
                    "database-management suspension resets every provider and prevents metadata reconnection");
            await broker.CompleteAsync(request, default);
            check(firstProvider.Requests == 2, "language requests resume after the management suspension ends");
        }

        var restarted = new List<FakeClient>();
        await RefreshChecks(check, settings);
        await RetirementChecks(check, settings);
        using (var sql = new SqlToolsLanguageService(_ => null, createClient: notify => { var next = new FakeClient { Notification = notify }; restarted.Add(next); return next; }))
        {
            var request = Request();
            await sql.CompleteAsync(request, default);
            sql.Reset();
            await sql.CompleteAsync(request, default);
            check(restarted.Count == 2 && restarted[0].Disposed && restarted[1].Calls.Any(call => call.Method == "textDocument/didOpen"),
                "provider reset ends metadata connections and reopens unchanged models in a fresh process");
        }

        var initializing = new FakeClient { HoldInitialize = true };
        var starting = new SqlToolsLanguageService(_ => null, createClient: notify => { initializing.Notification = notify; return initializing; });
        var startupRequest = starting.CompleteAsync(Request(), default);
        await initializing.InitializeRequested.Task.WaitAsync(CheckWait);
        starting.Dispose();
        try { await startupRequest; } catch (OperationCanceledException) { }
        check(initializing.Disposed, "disposing during initialization terminates the starting child process");

        var tooMany = SqlToolsLanguageService.ReadCompletions(Element(Enumerable.Range(0, 501).Select(index => new { label = "column" + index })));
        check(tooMany.Items.Count == 500 && tooMany.IsIncomplete, "completion output is bounded and advertises truncation");
        CompletionSelection(check);
        var badRange = SqlToolsLanguageService.ReadCompletions(Element(new[] { new { label = "bad", textEdit = new { range = new { start = new { line = 99, character = 0 }, end = new { line = 99, character = 1 } }, newText = "bad" } } }), "SELECT ");
        check(badRange.Items.Count == 0, "completion edits outside the synchronized document are refused");
        check(await Code(() => { SqlToolsLanguageService.Validate(Request(text: new string('x', 250_001))); return Task.CompletedTask; }) == "INVALID_PARAMS", "backend independently bounds SQL language documents");

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
            && inherited.HostNameInCertificate == "db.example" && !inherited.Pooling, "language settings preserve auth and certificate requirements while safely overriding the selected database");
        var entra = service.Register("Server=unused;Authentication=Active Directory Interactive", ServerProfile.Fallback("16.0"), "One");
        check(await Code(() => { service.LanguageConnectionString(new("sqlserver", entra)); return Task.CompletedTask; }) == "AUTH_UNSUPPORTED", "external language process refuses Entra modes until token sharing is implemented");
        check(service.LaneOf("language.close") == Varia.Backend.Protocol.RequestLane.Control, "language close can cancel requests without waiting for a metadata lane");
        check(service.LaneOf("language.refresh") == Varia.Backend.Protocol.RequestLane.Control, "language refresh can supersede a pending completion without waiting for a metadata lane");
    }

    private static void CompletionSelection(Action<bool, string> check)
    {
        foreach (var (prefix, target) in new[] { ("Zzz", "ZzzTail"), ("ZzzTail", "ZzzTail"), ("zzzt", "ZzzTail"), ("ZT", "ZzzTail"),
            ("[Customer K", "Customer Key"), ("[ZzzTail]", "ZzzTail"), ("[A]]K", "A]Key"), ("\"A\"\"K", "A\"Key"), ("🙂", "Rocket🙂") })
        {
            var line = "SELECT f." + prefix + " FROM dbo.WideFixture AS f;";
            var text = "-- prior line\r\n" + line;
            var cursor = "SELECT f.".Length + prefix.Length;
            var labels = Enumerable.Range(0, 600).Select(index => "Alpha" + index.ToString("D3", System.Globalization.CultureInfo.InvariantCulture)).Append(target);
            var items = Element(labels.Select(label => new { label, textEdit = new { range = new LanguageRange(new(1, 9), new(1, cursor)), newText = label } }));
            var result = SqlToolsLanguageService.ReadCompletions(items, text, new(1, cursor));
            check(result.Items.Count == 500 && result.IsIncomplete && result.Items[0].Label == target && result.Items[0].TextEdit?.NewText == target,
                "completion truncation retains matching identifiers beyond the original cap with UTF-16, quoting and fuzzy prefixes: " + prefix);
        }
        const string fallback = "SELECT Zzz";
        var plain = Element(Enumerable.Range(0, 600).Select(index => new { label = "Alpha" + index }).Append(new { label = "ZzzTail" }));
        check(SqlToolsLanguageService.ReadCompletions(plain, fallback, new(0, fallback.Length)).Items[0].Label == "ZzzTail",
            "completion truncation also ranks the typed identifier when a server omits text edits");
        var verbose = Element(Enumerable.Range(0, 100).Select(index => new { label = "Alpha" + index, documentation = new string('d', 16_384) })
            .Append(new { label = "ZzzTail", documentation = "target" }));
        var bounded = SqlToolsLanguageService.ReadCompletions(verbose, fallback, new(0, fallback.Length));
        check(bounded.Items[0].Label == "ZzzTail" && bounded.IsIncomplete && bounded.Items.Sum(item => item.Label.Length + (item.Documentation?.Length ?? 0)) <= 1_000_000,
            "matching declarations also survive the aggregate completion character budget without increasing it");
    }

    private static async Task RetirementChecks(Action<bool, string> check, string settings)
    {
        var clients = new List<FakeClient>();
        using (var sql = new SqlToolsLanguageService(_ => settings, createClient: notify =>
            { var next = new FakeClient { Notification = notify }; clients.Add(next); return next; }))
        {
            var first = Request(context: new("sqlserver", Guid.NewGuid().ToString(), "One"));
            var same = Request(context: first.Context);
            var sibling = Request(context: new("sqlserver", Guid.NewGuid().ToString(), "Two"));
            await sql.CompleteAsync(first, default);
            await sql.CompleteAsync(same, default);
            await sql.CompleteAsync(sibling, default);
            var original = clients[0];
            await sql.CloseAsync(first.DocumentId, default);
            check(!original.Disposed && clients.Count == 1, "closing one of two context owners retains the shared language child");

            original.HoldCompletion = true;
            original.CompletionHeld = new(TaskCreationOptions.RunContinuationsAsynchronously);
            original.ReleaseCompletion = new(TaskCreationOptions.RunContinuationsAsynchronously);
            original.DisconnectObserved = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var active = sql.CompleteAsync(sibling with { Version = 2 }, default);
            await original.CompletionHeld.Task.WaitAsync(CheckWait);
            var closing = sql.CloseAsync(same.DocumentId, default);
            await original.DisconnectObserved.Task.WaitAsync(CheckWait);
            var calls = original.Calls.Count;
            var nextRequest = Request(context: sibling.Context);
            var queued = sql.CompleteAsync(nextRequest, default);
            check(!closing.IsCompleted && !original.Disposed && !queued.IsCompleted && original.Calls.Count == calls,
                "last-context close waits for unrelated active work while new work waits outside the retirement usage count");
            original.ReleaseCompletion.TrySetResult();
            check((await active.WaitAsync(CheckWait)).Items.Count == 1 && (await closing.WaitAsync(CheckWait)).Closed,
                "language retirement allows already admitted sibling completion to finish successfully");
            check((await queued.WaitAsync(CheckWait)).Items.Count == 1 && original.Disposed && clients.Count == 2,
                "work queued behind retirement initializes a fresh child");
            await sql.CompleteAsync(sibling with { Version = 3 }, default);
            check(clients[1].Calls.Any(call => call.Method == "textDocument/didOpen"
                && call.Parameters.GetProperty("textDocument").GetProperty("uri").GetString() == "varia-sql://query/" + sibling.DocumentId),
                "remaining documents lazily resynchronize their text after child retirement");
        }

        clients.Clear();
        using (var sql = new SqlToolsLanguageService(_ => null, createClient: notify =>
            { var next = new FakeClient { Notification = notify }; clients.Add(next); return next; }))
        {
            var pinned = Request();
            await sql.CompleteAsync(pinned, default);
            for (var index = 0; index < SqlToolsLanguageService.MaxDocuments; index++)
            {
                var temporary = Request();
                await sql.CompleteAsync(temporary, default);
                await sql.CloseAsync(temporary.DocumentId, default);
            }
            check(clients.Count == 1 && clients[0].Disposed, "offline parse caches are retired after bounded document churn even with a pinned context owner");
            await sql.CompleteAsync(pinned, default);
            check(clients.Count == 2, "a pinned offline document resumes in a fresh child after bounded cache cleanup");
        }

        clients.Clear();
        using (var sql = new SqlToolsLanguageService(_ => settings, createClient: notify =>
            { var next = new FakeClient { Notification = notify }; clients.Add(next); return next; }))
        {
            var first = Request(context: new("sqlserver", Guid.NewGuid().ToString(), "One"));
            var sibling = Request(context: first.Context with { Database = "Two" });
            await sql.CompleteAsync(first, default);
            await sql.CompleteAsync(sibling, default);
            var original = clients[0];
            original.HoldCompletion = true;
            original.CompletionHeld = new(TaskCreationOptions.RunContinuationsAsynchronously);
            original.DisconnectObserved = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var active = sql.CompleteAsync(sibling with { Version = 2 }, default);
            await original.CompletionHeld.Task.WaitAsync(CheckWait);
            var closing = sql.CloseAsync(first.DocumentId, default);
            await original.DisconnectObserved.Task.WaitAsync(CheckWait);
            var duplicate = sql.CloseAsync(first.DocumentId, default);
            var queued = sql.CompleteAsync(Request(context: sibling.Context), default);
            sql.Dispose();
            var cancelled = 0;
            foreach (var work in new[] { active, queued })
                try { await work.WaitAsync(CheckWait); }
                catch (OperationCanceledException) { cancelled++; }
            check(cancelled == 2 && (await closing.WaitAsync(CheckWait)).Closed && !(await duplicate.WaitAsync(CheckWait)).Closed && original.Disposed,
                "concurrent close, duplicate close and disposal settle active work and retirement waiters without deadlocking");
        }

        var provider = new StubProvider("sqlserver") { CloseRelease = new(TaskCreationOptions.RunContinuationsAsynchronously) };
        using (var broker = new LanguageServiceBroker([provider]))
        {
            var request = Request();
            await broker.CompleteAsync(request, default);
            var closing = broker.CloseAsync(request.DocumentId, default);
            await provider.CloseStarted.Task.WaitAsync(CheckWait);
            check((await closing.WaitAsync(CheckWait)).Closed && !provider.CloseRelease.Task.IsCompleted,
                "broker accepts slow document cleanup before the provider's idle retirement finishes");
            var replacement = request with { Context = new("sqlserver", Guid.NewGuid().ToString(), "Two") };
            var next = broker.CompleteAsync(replacement, default);
            var refresh = broker.RefreshAsync(new(replacement.DocumentId, replacement.Version, replacement.Text, replacement.Context), default);
            check(!next.IsCompleted && !refresh.IsCompleted && provider.Requests == 1, "requests registered after an accepted close wait for the next binding");
            provider.CloseRelease.TrySetResult();
            check((await next.WaitAsync(CheckWait)).Items.Count == 0 && (await refresh.WaitAsync(CheckWait)).Refreshed && provider.Requests == 2,
                "new context work resumes after accepted-close cleanup instead of receiving a stale binding error");
        }
    }

    private static async Task RefreshChecks(Action<bool, string> check, string settings)
    {
        static LanguageRefreshRequest Refresh(LanguageRequest request) => new(request.DocumentId, request.Version, request.Text, request.Context);
        var fake = new FakeClient { AutoRefreshReady = false };
        using (var sql = new SqlToolsLanguageService(_ => settings, createClient: notify => { fake.Notification = notify; return fake; }))
        {
            var request = Request(version: 2, context: new("sqlserver", Guid.NewGuid().ToString(), "One"));
            await sql.CompleteAsync(request, default);
            var pending = sql.RefreshAsync(Refresh(request), default);
            await fake.RefreshRequested.Task.WaitAsync(CheckWait);
            check(!pending.IsCompleted, "cache refresh waits for its targeted metadata-ready notification");
            await fake.RefreshReadyAsync("varia-sql://query/" + Guid.NewGuid());
            check(!pending.IsCompleted, "a different document's metadata-ready notification cannot complete this refresh");
            await fake.RefreshReadyAsync("varia-sql://query/" + request.DocumentId);
            check((await pending.WaitAsync(CheckWait)).Refreshed && sql.Status().Refresh,
                "SQL Server advertises refresh and returns ready only after rebuilding and parsing its cache");
            var rebuild = fake.Calls.Single(call => call.Method == "textDocument/rebuildIntelliSense");
            check(rebuild.Parameters.GetProperty("ownerUri").GetString() == "varia-sql://query/" + request.DocumentId
                && !fake.Disposed && fake.Calls.Count(call => call.Method == "initialize") == 1,
                "targeted cache refresh retains the language process and names only its owned document URI");
            check(await Code(async () => await sql.RefreshAsync(Refresh(request with { Version = 1 }), default)) == "STALE"
                && await Code(async () => await sql.RefreshAsync(Refresh(request with { Context = request.Context with { Database = "Two" } }), default)) == "STALE"
                && fake.Calls.Count(call => call.Method == "textDocument/rebuildIntelliSense") == 1,
                "stale versions and connection contexts are refused before any refresh is sent");
            var sibling = Request(context: new("sqlserver", Guid.NewGuid().ToString(), "Two"));
            await sql.CompleteAsync(sibling, default);
            fake.AutoRefreshReady = true;
            await sql.RefreshAsync(Refresh(request), default);
            await sql.CompleteAsync(sibling, default);
            check(fake.Calls.Count(call => call.Method == "connection/connect") == 2 && !fake.Disposed,
                "refreshing one database does not reconnect or close a sibling database document");
        }

        var unused = new FakeClient();
        using (var sql = new SqlToolsLanguageService(_ => settings, createClient: notify => { unused.Notification = notify; return unused; }))
        {
            check(!(await sql.RefreshAsync(Refresh(Request()), default)).Refreshed && unused.Calls.IsEmpty,
                "a disconnected refresh reports no database cache without starting a language process");
            var request = Request(context: new("sqlserver", Guid.NewGuid().ToString(), "One"));
            check((await sql.RefreshAsync(Refresh(request), default)).Refreshed, "a document can initialize its language connection directly through refresh");
            var calls = unused.Calls.ToArray();
            check(Array.FindIndex(calls, call => call.Method == "textDocument/didOpen") < Array.FindIndex(calls, call => call.Method == "textDocument/rebuildIntelliSense")
                && Array.FindIndex(calls, call => call.Method == "connection/connect") < Array.FindIndex(calls, call => call.Method == "textDocument/rebuildIntelliSense"),
                "refresh synchronizes an unused document and connects before rebuilding its metadata");
        }

        var cancelled = new FakeClient { AutoRefreshReady = false };
        using (var sql = new SqlToolsLanguageService(_ => settings, createClient: notify => { cancelled.Notification = notify; return cancelled; }))
        using (var stop = new CancellationTokenSource())
        {
            var request = Request(context: new("sqlserver", Guid.NewGuid().ToString(), "One"));
            var pending = sql.RefreshAsync(Refresh(request), stop.Token);
            await cancelled.RefreshRequested.Task.WaitAsync(CheckWait);
            stop.Cancel();
            try { await pending; check(false, "cache refresh cancellation is observed"); }
            catch (OperationCanceledException) { check(!cancelled.Disposed, "cancelling targeted refresh does not terminate other database analysis connections"); }
            await cancelled.RefreshReadyAsync("varia-sql://query/" + request.DocumentId);
            check((await sql.CompleteAsync(Request(context: request.Context with { Database = "Two" }), default)).Items.Count == 1,
                "another database remains usable after cancelling a refresh");
        }

        var blocked = new FakeClient { HoldCompletion = true };
        using (var broker = new LanguageServiceBroker([new SqlToolsLanguageService(_ => settings, createClient: notify => { blocked.Notification = notify; return blocked; })]))
        {
            var request = Request(context: new("sqlserver", Guid.NewGuid().ToString(), "One"));
            var active = broker.CompleteAsync(request, default);
            await blocked.CompletionRequested.Task.WaitAsync(CheckWait);
            var queued = broker.HoverAsync(request, default);
            blocked.HoldCompletion = false;
            var refresh = broker.RefreshAsync(Refresh(request), default);
            check(await Code(async () => await active) == "STALE" && await Code(async () => await queued) == "STALE"
                && (await refresh.WaitAsync(CheckWait)).Refreshed,
                "refresh supersedes active and queued old features before rebuilding the same document");
        }

        var late = new FakeClient();
        using (var broker = new LanguageServiceBroker([new SqlToolsLanguageService(_ => settings, createClient: notify => { late.Notification = notify; return late; })]))
        {
            var current = Request(version: 2, context: new("sqlserver", Guid.NewGuid().ToString(), "One"));
            await broker.CompleteAsync(current, default);
            check(await Code(async () => await broker.CompleteAsync(current with { Version = 1, Context = current.Context with { Database = "Two" } }, default)) == "STALE"
                && await Code(async () => await broker.HoverAsync(current with { Text = "SELECT 2", Context = current.Context with { Database = "Two" } }, default)) == "STALE",
                "broker rejects old versions and conflicting text before changing its accepted document context");
            check((await broker.RefreshAsync(Refresh(current), default)).Refreshed && late.Calls.Count(call => call.Method == "connection/connect") == 1,
                "late rejected feature requests cannot poison the current context used by manual cache refresh");
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

    private sealed record Call(string Method, JsonElement Parameters);
    private sealed class FakeClient : ILspClient
    {
        public readonly ConcurrentQueue<Call> Calls = new();
        public Func<string, JsonElement, Task>? Notification;
        public readonly TaskCompletionSource ConnectionRequested = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource CompletionRequested = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource InitializeRequested = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource LoginCompleted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public readonly TaskCompletionSource RefreshRequested = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private string? owner;
        public bool AutoConnect = true;
        public bool AutoReady = true;
        public bool AutoRefreshReady = true;
        public bool HoldCompletion;
        public TaskCompletionSource? CompletionHeld;
        public TaskCompletionSource? ReleaseCompletion;
        public TaskCompletionSource? DisconnectObserved;
        public bool HoldInitialize;
        public int NullCompletionsRemaining;
        public bool AlwaysNullCompletions;
        public bool EmptyCompletions;
        public bool Disposed;
        private int documentVersion;
        private int parsedVersion;
        public Task Completion => completion.Task;
        public async Task<JsonElement> RequestAsync(string method, object? parameters, CancellationToken token = default, TimeSpan? timeout = null)
        {
            token.ThrowIfCancellationRequested();
            var value = Element(parameters);
            Calls.Enqueue(new(method, value));
            switch (method)
            {
                case "initialize":
                    InitializeRequested.TrySetResult();
                    if (HoldInitialize) await Task.Delay(Timeout.InfiniteTimeSpan, token);
                    return Element(new { capabilities = new { textDocumentSync = 2 } });
                case "connection/connect":
                    owner = value.GetProperty("ownerUri").GetString();
                    ConnectionRequested.TrySetResult();
                    if (AutoConnect) await CompleteConnectionAsync(true);
                    return Element(true);
                case "textDocument/completion":
                    CompletionRequested.TrySetResult();
                    if (HoldCompletion)
                    {
                        CompletionHeld?.TrySetResult();
                        if (ReleaseCompletion is { } release) await release.Task.WaitAsync(token);
                        else await Task.Delay(Timeout.InfiniteTimeSpan, token);
                    }
                    if (AlwaysNullCompletions || NullCompletionsRemaining-- > 0) return Element(null);
                    parsedVersion = documentVersion;
                    if (EmptyCompletions) return Element(Array.Empty<object>());
                    using (var json = JsonDocument.Parse("""{"items":[{"label":"dbo.People","kind":7,"documentation":{"kind":"markdown","value":"A table"},"textEdit":{"range":{"start":{"line":0,"character":7},"end":{"line":0,"character":7}},"newText":"[dbo].[People]"},"command":{"command":"do-not-forward"}}],"isIncomplete":false}""")) return json.RootElement.Clone();
                case "textDocument/hover": return parsedVersion != documentVersion ? Element(null) : Element(new { contents = new object[] { new { language = "sql", value = "int" }, new { value = "A column" } } });
                case "connection/disconnect": DisconnectObserved?.TrySetResult(); return Element(true);
                default: return Element(true);
            }
        }
        public async Task NotifyAsync(string method, object? parameters, CancellationToken token = default)
        {
            token.ThrowIfCancellationRequested();
            var value = Element(parameters);
            if (method == "textDocument/didChange" && !value.GetProperty("contentChanges")[0].TryGetProperty("range", out _)) throw new Exception("STS requires an explicit change range.");
            if (method is "textDocument/didOpen" or "textDocument/didChange") documentVersion = value.GetProperty("textDocument").GetProperty("version").GetInt32();
            if (method == "textDocument/didOpen") parsedVersion = 0;
            Calls.Enqueue(new(method, value));
            if (method == "textDocument/rebuildIntelliSense")
            {
                parsedVersion = 0;
                RefreshRequested.TrySetResult();
                if (AutoRefreshReady) await RefreshReadyAsync(value.GetProperty("ownerUri").GetString()!);
            }
        }
        public async Task CompleteConnectionAsync(bool success)
        {
            await Notification!("connection/complete", Element(new { ownerUri = owner, connectionId = success ? Guid.NewGuid().ToString() : null, errorMessage = success ? null : "private-secret should never be returned" }));
            LoginCompleted.TrySetResult();
            if (success && AutoReady) await ReadyAsync();
        }
        public Task ReadyAsync() => Notification!("textDocument/intelliSenseReady", Element(new { ownerUri = owner }));
        public Task RefreshReadyAsync(string uri) => Notification!("textDocument/intelliSenseReady", Element(new { ownerUri = uri }));
        public void Dispose() { Disposed = true; completion.TrySetResult(); }
    }

    private sealed class StubProvider(string id) : ILanguageServiceProvider
    {
        public string Id => id;
        public int Requests;
        public int Closes;
        public int Resets;
        public readonly TaskCompletionSource CloseStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource? CloseRelease;
        public LanguageProviderStatus Status() => new(Id, true, true, true, Refresh: true);
        public Task<LanguageCompletionResult> CompleteAsync(LanguageRequest request, CancellationToken token) { Requests++; return Task.FromResult(new LanguageCompletionResult([], false)); }
        public Task<LanguageHover?> HoverAsync(LanguageRequest request, CancellationToken token) => Task.FromResult<LanguageHover?>(null);
        public Task<LanguageDiagnosticResult> DiagnosticsAsync(LanguageRefreshRequest request, CancellationToken token) => Task.FromResult(new LanguageDiagnosticResult(request.Version, [], false));
        public Task<LanguageRefreshResult> RefreshAsync(LanguageRefreshRequest request, CancellationToken token) => Task.FromResult(new LanguageRefreshResult(true));
        public async Task<LanguageCloseResult> CloseAsync(string documentId, CancellationToken token)
        {
            Closes++;
            CloseStarted.TrySetResult();
            if (CloseRelease is { } release) await release.Task.WaitAsync(token);
            return new(true);
        }
        public Task ForgetConnectionAsync(string connectionId) => Task.CompletedTask;
        public void Reset() { Resets++; }
        public void Dispose() { }
    }
}
