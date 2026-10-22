using System.Diagnostics;
using System.Text.Json;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of PR S-A, ssis.execute: the catalogue's verbs, the write templates and their lint (which catches
/// what it exists for), request validation and dispatch, Stop Operation's refusals, and the action service's refusals before
/// it connects, its own connection, gates, Stop and disconnect, with a fake host that never reaches a server.</summary>
internal static class SsisActionChecks
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
    };
    private const long MaxSafeInteger = 9_007_199_254_740_991;

    public static async Task RunAsync(Action<bool, string> check)
    {
        Catalog(check);
        Lint(check);
        await ValidationAsync(check);
        Refusals(check);
        await RefusedFirstAsync(check);
        await GatesAsync(check);
    }

    private static SsisExecuteArgs Stop(long? operationId = 42, string? connectionId = null, string? revision = null) =>
        new(connectionId ?? Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), new SsisActionDto("stopOperation", operationId), revision);

    private static void Catalog(Action<bool, string> check)
    {
        var catalog = SsisCatalog.Current;
        var stop = catalog.Action("stopOperation");
        check(catalog.Actions.Select(action => action.Verb).SequenceEqual(["stopOperation"]) && stop is { Title: "Stop Operation", Revision: false, WindowsAuthOnBox: true }
            && stop.Steps.SequenceEqual(["Stop the operation"]) && stop.Procedures.SequenceEqual(["stop_operation"]) && catalog.Action("startExecution") is null,
            "the embedded catalogue's ssis.execute verbs: Stop Operation, one step calling catalog.stop_operation, no revision, Windows authentication on a box server");
        check(catalog.StoppableOperationTypes.Order().SequenceEqual([200, 300, 301]) && catalog.FinalStatuses.Order().SequenceEqual([3, 4, 6, 7, 9]) && catalog.OpenStatuses.Order().SequenceEqual([1, 2, 5, 8])
            && !catalog.Retryable("WINDOWS_AUTH_REQUIRED") && !catalog.Retryable("ALREADY_FINAL") && catalog.Retryable("NOT_RUNNING") && catalog.Retryable("CANCELLED"),
            "Stop Operation applies to executions and validations; the catalogue's open and final statuses and the write error codes come from the catalogue");
        check(catalog.Limit("writePerConnection") == 1 && catalog.Limit("writeTotal") == 2 && catalog.Limit("registeredWrites") == 64 && catalog.Limit("preflightLockTimeoutMs") == 10_000
            && catalog.Limit("preflightMs") == 25_000 && catalog.Limit("stopGraceMs") == 10_000 && new SsisOptions() is { WritePerConnection: 1, WriteTotal: 2, MaxRegisteredWrites: 64 } options
            && options.PreflightBudget == TimeSpan.FromSeconds(25) && options.StopGrace == TimeSpan.FromSeconds(10) && !options.IgnoreSqlAuthentication && options.BeforeWrite is null,
            "the write path's bounds are the catalogue's (D-ssis 10): 1 write per connection, 2 in all, 64 registered, a 10 s preflight lock timeout within 25 s, 10 s of grace after Stop");
    }

    private static void Lint(Action<bool, string> check)
    {
        var problems = SsisCatalog.Current.Actions.SelectMany(spec => SsisSql.WriteTemplates(spec.Verb).SelectMany(text => SsisSql.LintWrite(text, spec.Procedures).Select(problem => spec.Verb + ": " + problem))).ToList();
        var templates = SsisCatalog.Current.Actions.ToDictionary(spec => spec.Verb, spec => SsisSql.WriteTemplates(spec.Verb).Count);
        check(problems.Count == 0 && templates.All(pair => pair.Value == SsisCatalog.Current.Action(pair.Key)!.Steps.Count),
            "every verb's write templates pass the write lint, one per step: " + string.Join("; ", problems));
        check(SsisSql.All(SsisCatalog.Current.Views).Any(item => item.Id == "operationPreflight" && item.Text == SsisSql.OperationPreflight && SsisSql.Lint(item.Text, item.List).Count == 0)
            && SsisSql.OperationPreflight.StartsWith("SET LOCK_TIMEOUT 10000;\n", StringComparison.Ordinal) && SsisSql.WriteTemplates("stopOperation")[0].StartsWith("SET LOCK_TIMEOUT -1;\n", StringComparison.Ordinal)
            && SsisSql.ActionPrologue.Contains("READ COMMITTED;", StringComparison.Ordinal) && SsisSql.ActionPrologue.Contains("LOCK_TIMEOUT -1", StringComparison.Ordinal)
            && !SsisSql.ActionPrologue.Contains("XACT_ABORT", StringComparison.Ordinal),
            "the preflight is a read that passes the read lint with LOCK_TIMEOUT 10000; the write waits for locks (-1) at READ COMMITTED, and leaves XACT_ABORT to the catalog's procedures, as SSMS does");
        string[] Problems(string text) => [.. SsisSql.LintWrite(text, ["stop_operation"])];
        var caught = new (string Text, string Expected)[]
        {
            ("EXEC [catalog].[start_execution] @execution_id = @id;", "calls catalog.start_execution, which its verb does not allow"),
            ("EXEC [dbo].[stop_operation] @operation_id = @operation_id;", "calls [dbo].[stop_operation], which is not a catalog procedure"),
            ("EXEC catalog.stop_operation @operation_id = @operation_id;", "calls catalog.stop_operation, which is not a catalog procedure"),
            ("EXEC sp_executesql @stmt;", "runs dynamic SQL"),
            ("EXEC (@stmt);", "runs dynamic SQL"),
            ("EXECUTE @procedure;", "runs dynamic SQL"),
            ("EXEC [catalog].[stop_operation] @operation_id = @operation_id; UPDATE [catalog].[operations] SET status = 3;", "writes on its own: UPDATE"),
            ("EXEC [catalog].[stop_operation] @operation_id = @operation_id; DROP TABLE [catalog].[operations];", "writes on its own: DROP"),
            ("EXEC [catalog].[stop_operation] @operation_id = N'1';", "has the literal N'1'"),
            ("EXEC [catalog].[stop_operation] @operation_id = @operation_id; -- SYNCHRONIZED", "names SYNCHRONIZED"),
            ("SELECT OBJECT_ID(N'x'); EXEC [catalog].[stop_operation] @operation_id = @operation_id;", "uses OBJECT_ID("),
            ("SELECT 1;", "calls no catalog procedure")
        };
        var missed = caught.Where(item => !Problems(item.Text).Contains(item.Expected)).Select(item => item.Expected + " in " + item.Text + " (" + string.Join("; ", Problems(item.Text)) + ")").ToList();
        check(missed.Count == 0, "the write lint rejects other procedures, unbracketed or non-catalog names, dynamic SQL, DML and DDL of its own, literals, SYNCHRONIZED, metadata built-ins and a template that calls nothing: "
            + string.Join("; ", missed));
    }

    private static async Task ValidationAsync(Action<bool, string> check)
    {
        using var reads = new SsisService(new SsisChecks.FakeHost());
        using var service = new SsisActionService(new SsisChecks.FakeHost(), reads);
        string Code(SsisExecuteArgs args)
        {
            try { service.Validate(args); return "ok"; }
            catch (RequestException error) { return error.Code; }
        }
        var revision = new string('a', 64);
        var cases = new (SsisExecuteArgs Args, string Expected)[]
        {
            (Stop(), "ok"), (Stop(1), "ok"), (Stop(MaxSafeInteger), "ok"),
            (Stop(0), "INVALID_PARAMS"), (Stop(-1), "INVALID_PARAMS"), (Stop(MaxSafeInteger + 1), "INVALID_PARAMS"), (Stop(null), "INVALID_PARAMS"),
            (Stop() with { Action = new("startExecution", 42) }, "INVALID_PARAMS"), (Stop() with { Action = null! }, "INVALID_PARAMS"), (Stop() with { Action = new(null!, 42) }, "INVALID_PARAMS"),
            (Stop(revision: revision), "INVALID_PARAMS"), (Stop(revision: "x"), "INVALID_PARAMS"),
            (Stop() with { ConnectionId = "x" }, "INVALID_PARAMS"), (Stop() with { RequestId = "y" }, "INVALID_PARAMS")
        };
        var wrong = cases.Where(item => Code(item.Args) != item.Expected).Select(item => JsonSerializer.Serialize(item.Args, Json) + " " + Code(item.Args)).ToList();
        check(wrong.Count == 0, "ssis.execute accepts Stop Operation with an id from 1 to 2^53 - 1, and refuses other ids, unknown verbs, a revision Stop Operation does not take, and bad ids: " + string.Join("; ", wrong));

        using var sql = new SqlService();
        async Task<string> Dispatch(string body)
        {
            try { await sql.DispatchAsync("ssis.execute", JsonDocument.Parse(body).RootElement, Json); return "ok"; }
            catch (RequestException error) { return error.Code; }
            catch (JsonException) { return "JSON"; }
        }
        var ids = "\"connectionId\":\"" + Guid.NewGuid() + "\",\"requestId\":\"" + Guid.NewGuid() + "\"";
        var codes = new[]
        {
            await Dispatch("{" + ids + ",\"action\":{\"verb\":\"stopOperation\",\"operationId\":42}}"),
            await Dispatch("{" + ids + ",\"action\":{\"verb\":\"stopOperation\",\"operationId\":0}}"),
            await Dispatch("{" + ids + ",\"action\":{\"verb\":\"stopOperation\",\"operationId\":42,\"synchronized\":true}}"),
            await Dispatch("{" + ids + ",\"action\":{\"verb\":\"stopOperation\",\"operationId\":42},\"extra\":1}")
        };
        check(sql.LaneOf("ssis.execute") == RequestLane.Ssis && sql.Methods.Contains("ssis.execute") && SqlService.MethodNames.Contains("ssis.execute") && sql.AnswersStop("ssis.execute")
            && sql.AnswersStop("actions.execute") && !sql.AnswersStop("ssis.describe") && !sql.AnswersStop("explorer.children")
            && codes.SequenceEqual(["NOT_CONNECTED", "INVALID_PARAMS", "JSON", "JSON"]),
            "ssis.execute runs on the ssis lane, answers Stop itself, rejects unknown members, and checks its action before the connection: " + string.Join(", ", codes));
    }

    private static void Refusals(Action<bool, string> check)
    {
        using var reads = new SsisService(new SsisChecks.FakeHost());
        using var service = new SsisActionService(new SsisChecks.FakeHost(), reads);
        var cases = new ((int Type, int Status)? Row, string? Code, string Text)[]
        {
            (null, "NOT_FOUND", "Operation 42 does not exist, or you may not read it"),
            ((101, 2), "NOT_SUPPORTED", "its type is Deploy project (101)"), ((1000, 2), "NOT_SUPPORTED", "Configure catalog (1000)"), ((999, 2), "NOT_SUPPORTED", "unknown (999)"),
            ((200, 7), "ALREADY_FINAL", "has already ended (Succeeded)"), ((300, 4), "ALREADY_FINAL", "(Failed)"), ((200, 3), "ALREADY_FINAL", "(Canceled)"), ((301, 6), "ALREADY_FINAL", "(Ended unexpectedly)"),
            ((200, 9), "ALREADY_FINAL", "(Completed)"), ((200, 8), "ALREADY_FINAL", "is already stopping"),
            ((200, 2), null, ""), ((300, 2), null, ""), ((301, 2), null, ""), ((200, 1), null, ""), ((200, 5), null, "")
        };
        var wrong = cases.Where(item => service.Unstoppable(42, item.Row) is var error && (error?.Code != item.Code || error is not null && !error.Message.Contains(item.Text, StringComparison.Ordinal)))
            .Select(item => item.Row + " " + JsonSerializer.Serialize(service.Unstoppable(42, item.Row), Json)).ToList();
        check(wrong.Count == 0, "Stop Operation's preflight refuses an operation it cannot see, one that is not an execution or validation, one that has ended or is stopping, "
            + "and leaves running, created and pending ones to the catalog: " + string.Join("; ", wrong));
    }

    /// <summary>What the server cannot do is answered at once, with no connection: no catalog before 2016 or on Linux, and SQL
    /// Server authentication on a box server, which SSISDB refuses (27123).</summary>
    private static async Task RefusedFirstAsync(Action<bool, string> check)
    {
        async Task<(SsisExecuteResult Result, SsisChecks.FakeHost Host)> Run(SsisChecks.FakeHost host, SsisOptions? options = null)
        {
            using var reads = new SsisService(host, options);
            using var service = new SsisActionService(host, reads);
            return (await service.ExecuteAsync(Stop(), CancellationToken.None), host);
        }
        var old = await Run(new SsisChecks.FakeHost(12));
        var linux = await Run(new SsisChecks.FakeHost(17, linux: true));
        var sqlLogin = await Run(new SsisChecks.FakeHost(auth: "sql"));
        check(old.Result is { Steps: [], Error: { Code: "NOT_SUPPORTED", Retryable: false } } && linux.Result.Error?.Message == "The SSIS Catalog isn't supported on SQL Server on Linux."
            && sqlLogin.Result.Error is { Code: "WINDOWS_AUTH_REQUIRED", Retryable: false } refusal && refusal.Message == SsisErrors.WindowsAuthRequired
            && old.Host.ActionConnections + linux.Host.ActionConnections + sqlLogin.Host.ActionConnections == 0 && sqlLogin.Result.Steps.Count == 0,
            "a write is refused before it connects on a server older than 2016, on Linux, and for a SQL Server login on a box server: " + JsonSerializer.Serialize(sqlLogin.Result, Json));
        // Azure SQL Database (5) and Managed Instance (8) host an integration runtime's catalog, which the box rule does not cover;
        // Windows and Microsoft Entra sign-ins pass; the checks' seams lift the Linux and SQL Server authentication rules for the fake catalog.
        var azure = await Run(new SsisChecks.FakeHost(auth: "sql", edition: 5));
        var managed = await Run(new SsisChecks.FakeHost(auth: "sql", edition: 8));
        var entra = await Run(new SsisChecks.FakeHost(auth: "entra"));
        var ignored = await Run(new SsisChecks.FakeHost(17, linux: true, auth: "sql"), new SsisOptions { IgnoreLinuxHost = true, IgnoreSqlAuthentication = true });
        check(new[] { azure, managed, entra, ignored }.All(item => item.Result.Error is { Code: "AUTH_KERBEROS" } && item.Host.ActionConnections == 1 && item.Host.ActionCatalog == "SSISDB"),
            "a SQL Server login on Azure SQL Database or Managed Instance, a Microsoft Entra sign-in, and the checks' seams reach the write's own connection in the catalog's database");
    }

    private static async Task GatesAsync(Action<bool, string> check)
    {
        var host = new SsisChecks.FakeHost { Hold = new SemaphoreSlim(0) };
        using var reads = new SsisService(host, new SsisOptions { GateWait = TimeSpan.FromMilliseconds(300) });
        using var service = new SsisActionService(host, reads);
        var watch = Stopwatch.StartNew();
        async Task Until(Func<bool> done) { while (!done() && watch.ElapsedMilliseconds < 10_000) await Task.Delay(10); }
        async Task<string> Code(Task<SsisExecuteResult> request)
        {
            try { return (await request).Error?.Code ?? "ok"; }
            catch (RequestException error) { return error.Code; }
        }
        // One write per connection and two in all: a second on the same connection, or a third anywhere, waits, then answers BUSY.
        var first = Guid.NewGuid().ToString();
        var held = service.ExecuteAsync(Stop(connectionId: first), CancellationToken.None);
        await Until(() => host.Opens == 1);
        var same = await Code(service.ExecuteAsync(Stop(connectionId: first), CancellationToken.None));
        var second = service.ExecuteAsync(Stop(), CancellationToken.None);
        await Until(() => host.Opens == 2);
        var third = await Code(service.ExecuteAsync(Stop(), CancellationToken.None));
        host.Hold.Release(2);
        var answers = await Task.WhenAll(held, second);
        await Until(() => service.ActiveJobs == 0);
        check(same == "BUSY" && third == "BUSY" && host.Opens == 2 && host.ActionConnections == 2 && reads.RunningCount == 0
            && answers.All(answer => answer is { Steps: [], Error: { Code: "AUTH_KERBEROS", Retryable: true } }) && service.RunningCount == 0 && service.ActiveJobs == 0,
            "SSIS writes take one gate per connection and two in all, on their own connections, never the read service's; a sign-in failure is a value, and every gate comes back");

        // Cancelled before it runs: no gate, no connection.
        using (var cancelled = new CancellationTokenSource())
        {
            cancelled.Cancel();
            var before = host.ActionConnections;
            try { await service.ExecuteAsync(Stop(), cancelled.Token); check(false, "a cancelled write runs"); }
            catch (OperationCanceledException) { check(host.ActionConnections == before && service.RunningCount == 0, "a write cancelled before it runs takes no gate and opens nothing"); }
        }
        // Stop while the write waits (here, to sign in): no step started, so the reply says nothing changed.
        using (var stop = new CancellationTokenSource())
        {
            var opens = host.Opens;
            var stopping = service.ExecuteAsync(Stop(), stop.Token);
            await Until(() => host.Opens == opens + 1);
            stop.Cancel();
            var stopped = await stopping;
            check(stopped is { Steps: [], Error: { Code: "CANCELLED", Retryable: true } } && stopped.Error.Message == "The action was stopped before it changed anything." && service.RunningCount == 0,
                "Stop on a write that has not reached its first step answers CANCELLED, saying nothing changed: " + JsonSerializer.Serialize(stopped, Json));
        }
        // A disconnect cancels the connection's writes.
        var connection = Guid.NewGuid().ToString();
        var opened = host.Opens;
        var waiting = service.ExecuteAsync(Stop(connectionId: connection), CancellationToken.None);
        await Until(() => host.Opens == opened + 1);
        service.Forget(connection);
        try { await waiting; check(false, "a disconnected write answers"); }
        catch (RequestException error) { check(error.Code == "CANCELLED" && service.RunningCount == 0, "a disconnect cancels the connection's writes"); }
        await Until(() => service.ActiveJobs == 0);
        check(service.ActiveJobs == 0 && service.SessionOf(Guid.NewGuid().ToString()) is null, "every write's job ends, and no session is left registered");
    }
}
