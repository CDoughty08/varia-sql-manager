using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Varia.Backend.Ssis;

namespace Varia.Backend.Tests;

/// <summary>Live checks of PR S-A, ssis.execute's Stop Operation, against the fake SSIS catalog (VARIA_TEST_SQL_SCRATCH=1), which
/// the backend reaches through its internal SsisOptions.CatalogDatabase: a running execution stops (Stopping, with the catalog's
/// own stop operation), a second stop and an ended operation answer ALREADY_FINAL without asking the catalog, a missing one
/// NOT_FOUND, another type NOT_SUPPORTED, a created one NOT_RUNNING after the catalog refuses it, an operation that ends between
/// the preflight and the stop ALREADY_FINAL; the write runs on its own unpooled " - Integration Services Actions" session at
/// READ COMMITTED without a lock timeout, and Stop ends it waiting on a lock with the step cancelled and nothing changed; the
/// preflight answers TIMEOUT within its budget and BLOCKED after its 10 s lock timeout; a SQL Server login is refused before
/// anything runs (and by the catalog's 27123 past the seam), one without EXECUTE gets PERMISSION_DENIED; and a missing catalog
/// answers CATALOG_MISSING. On CI's SQL Server authentication the internal SsisOptions.IgnoreSqlAuthentication lets the rest
/// run. Nothing here claims real SSIS behaviour: no package runs.</summary>
internal static class SsisActionLiveChecks
{
    private static string Literal(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static string Dump(object? value) => JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
    private const string Folder = "VariaActions] '--";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json,
        ScratchDatabase scratch, string db, Func<string, string, string?, Task<SqlRun>> sql, Func<string, Task<object>> close)
    {
        async Task<SqlRun> Exec(string text, string? session = null)
        {
            var result = await sql(text, db, session);
            if (result.Status != "completed") throw new InvalidOperationException("SSIS action fixture step failed: " + result.Error);
            return result;
        }
        var options = service.Ssis.Options;
        var sqlAuth = ((ISsisHost)service).Authentication(info.Id) == "sql";
        try
        {
            options.CatalogDatabase = db;
            options.IgnoreLinuxHost = true;
            // Locking READ COMMITTED, so the preflight waits on a writer's row (the describe checks leave it so; this makes it certain).
            service.ClearPoolsFor(info.Id, db);
            var rcsi = await sql("ALTER DATABASE " + Bracket(db) + " SET READ_COMMITTED_SNAPSHOT OFF WITH ROLLBACK IMMEDIATE;", "master", null);
            if (rcsi.Status != "completed") throw new InvalidOperationException("RCSI could not be turned off on the fake catalog: " + rcsi.Error);
            await Exec("EXEC [catalog].[varia_fake_seed] " + Literal(Folder) + ", N'Project', N'Package.dtsx';");
            if (sqlAuth)
            {
                // This run's own login is a SQL Server login: refused before anything runs, then the seam lets the rest reach the fake.
                var refused = await StopAsync(service, info.Id, 1);
                check(refused is { Steps: [], Error: { Code: "WINDOWS_AUTH_REQUIRED", Retryable: false } }, "a SQL Server login's Stop Operation on a box server is refused before it connects: " + Dump(refused));
                options.IgnoreSqlAuthentication = true;
            }
            await StopsAsync(check, service, info, db, Exec, sql, close);
            await LockedAsync(check, service, info, db, Exec, sql, close);
            await LoginsAsync(check, service, live, json, scratch, db, sqlAuth, Exec);
            await MissingAsync(check, service, info, db);
            var left = await Exec("SELECT COUNT(*) FROM sys.dm_exec_sessions AS s WHERE s.program_name LIKE N'% - Integration Services Actions' AND s.database_id = DB_ID(" + Literal(db) + ");");
            check(left.Scalar == "0", "no Integration Services Actions session is left in the catalog's database: each write's connection closes with it (" + left.Scalar + ")");
        }
        finally
        {
            options.CatalogDatabase = SsisCatalog.Current.CatalogDatabase;
            options.IgnoreLinuxHost = false;
            options.IgnoreSqlAuthentication = false;
            options.BeforeWrite = null;
            options.PreflightBudget = new SsisOptions().PreflightBudget;
            service.Ssis.Forget(info.Id);
            service.ClearPoolsFor(info.Id, db);
        }
    }

    private static Task<SsisExecuteResult> StopAsync(SqlService service, string connectionId, long operationId, CancellationToken token = default, string? requestId = null) =>
        service.SsisActions.ExecuteAsync(new(connectionId, requestId ?? Guid.NewGuid().ToString(), new SsisActionDto("stopOperation", operationId)), token);

    private static async Task<long> ExecutionAsync(Func<string, string?, Task<SqlRun>> exec, bool start)
    {
        var id = long.Parse((await exec("DECLARE @id bigint; EXEC [catalog].[create_execution] @folder_name = " + Literal(Folder) + ", @project_name = N'Project', @package_name = N'Package.dtsx', "
            + "@execution_id = @id OUTPUT; SELECT @id;", null)).Scalar!, CultureInfo.InvariantCulture);
        if (start) await exec("EXEC [catalog].[start_execution] @execution_id = " + id + ";", null);
        return id;
    }

    private static async Task<string?> StatusAsync(Func<string, string?, Task<SqlRun>> exec, long id) =>
        (await exec("SELECT CONCAT(o.status, ' ', e.status) FROM [catalog].[operations] AS o JOIN [catalog].[executions] AS e ON e.execution_id = o.operation_id WHERE o.operation_id = " + id + ";", null)).Scalar;

    /// <summary>The catalog's own stop operations (202), with one status or in all.</summary>
    private static async Task<long> StopOperationsAsync(Func<string, string?, Task<SqlRun>> exec, string? status) =>
        long.Parse((await exec("SELECT COUNT(*) FROM [catalog].[operations] WHERE operation_type = 202" + (status is null ? "" : " AND status = " + status) + ";", null)).Scalar!, CultureInfo.InvariantCulture);

    /// <summary>The write's server session once it waits on another session's lock, or null if it is never seen blocked (30 s).</summary>
    private static async Task<string?> BlockedSessionAsync(SqlService service, string requestId, Task request, Func<string, string?, Task<SqlRun>> exec)
    {
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < 30_000 && !request.IsCompleted)
        {
            if (service.SsisActions.SessionOf(requestId) is { } session
                && (await exec("SELECT COUNT(*) FROM sys.dm_exec_requests WHERE session_id = " + session + " AND blocking_session_id <> 0;", null)).Scalar == "1")
                return session.ToString(CultureInfo.InvariantCulture);
            await Task.Delay(50);
        }
        return null;
    }

    private static async Task StopsAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, string db, Func<string, string?, Task<SqlRun>> exec,
        Func<string, string, string?, Task<SqlRun>> sql, Func<string, Task<object>> close)
    {
        // A running execution stops: the catalog records its own stop operation (202, Succeeded), and the execution is Stopping
        // until the package ends.
        var running = await ExecutionAsync(exec, start: true);
        var stopped = await StopAsync(service, info.Id, running);
        var stop = (await exec("SELECT TOP (1) CONCAT(operation_id, ' ', status, ' ', object_id) FROM [catalog].[operations] WHERE operation_type = 202 ORDER BY operation_id DESC;", null)).Scalar!.Split(' ');
        check(stopped is { Error: null, Steps: [{ Status: "done", Message: "Stop the operation" }] } && await StatusAsync(exec, running) == "8 8" && stop[1] == "7" && stop[2].Length > 0,
            "Stop Operation stops a running execution: one step done, the execution Stopping (8), and the catalog's own stop operation Succeeded: " + Dump(stopped));

        // A second stop, and a stop of an ended operation, are answered from the preflight: the catalog records no failed stop.
        var failed = await StopOperationsAsync(exec, "4");
        var again = await StopAsync(service, info.Id, running);
        await exec("EXEC [catalog].[varia_fake_finish] " + running + ", 3;", null);
        var ended = await StopAsync(service, info.Id, running);
        check(again is { Steps: [], Error: { Code: "ALREADY_FINAL", Retryable: false } } && again.Error.Message == "Operation " + running + " is already stopping."
            && ended is { Steps: [], Error: { Code: "ALREADY_FINAL" } } && ended.Error.Message == "Operation " + running + " has already ended (Canceled)." && await StopOperationsAsync(exec, "4") == failed,
            "a second Stop Operation, and one on an ended execution, answer ALREADY_FINAL from the preflight, so the catalog records no failed stop: " + Dump(again) + Dump(ended));

        // An operation that does not exist, and one that is not an execution or validation (the stop operation itself).
        var missing = await StopAsync(service, info.Id, long.Parse(stop[0], CultureInfo.InvariantCulture) + 1_000_000);
        var other = await StopAsync(service, info.Id, long.Parse(stop[0], CultureInfo.InvariantCulture));
        check(missing is { Steps: [], Error: { Code: "NOT_FOUND", Retryable: false } } && other is { Steps: [], Error: { Code: "NOT_SUPPORTED" } } && other.Error.Message.Contains("Stop operation (202)", StringComparison.Ordinal),
            "Stop Operation on an operation that does not exist answers NOT_FOUND, and on one that is not an execution or validation NOT_SUPPORTED: " + Dump(missing) + Dump(other));

        // A created execution nobody started never runs: the preflight answers NOT_STARTED, which no retry helps, without asking the
        // catalog, which would record a failed stop for every attempt.
        var created = await ExecutionAsync(exec, start: false);
        var early = await StopAsync(service, info.Id, created);
        var twice = await StopAsync(service, info.Id, created);
        check(early is { Steps: [], Error: { Code: "NOT_STARTED", Retryable: false } } && early.Error.Message == "Operation " + created + " was created but has not been started, so there is nothing to stop."
            && twice is { Steps: [], Error.Code: "NOT_STARTED" } && await StopOperationsAsync(exec, "4") == failed && await StatusAsync(exec, created) == "1 1",
            "Stop Operation on a created execution nobody started answers NOT_STARTED (not retryable) from the preflight, and the catalog records no failed stop: " + Dump(early));

        // An execution that ends between the preflight and the stop: the catalog refuses (27124), and a second look says it ended.
        var racing = await ExecutionAsync(exec, start: true);
        var options = service.Ssis.Options;
        options.BeforeWrite = async _ => await exec("EXEC [catalog].[varia_fake_finish] " + racing + ", 7;", null);
        SsisExecuteResult raced;
        try { raced = await StopAsync(service, info.Id, racing); }
        finally { options.BeforeWrite = null; }
        check(raced is { Steps: [{ Status: "failed" }], Error: { Code: "ALREADY_FINAL" } } && raced.Error.Message == "Operation " + racing + " has already ended (Succeeded)." && await StatusAsync(exec, racing) == "7 7",
            "an execution that ends between the preflight and the stop answers ALREADY_FINAL after the catalog refuses: " + Dump(raced));

        // The same refusal, when the second look fails (here its connection is lost): the catalog's refusal stands, and the step
        // stays failed rather than the outcome being called unknown.
        var unread = await ExecutionAsync(exec, start: true);
        var requestId = Guid.NewGuid().ToString();
        options.BeforeWrite = async _ => await exec("EXEC [catalog].[varia_fake_finish] " + unread + ", 7;", null);
        options.BeforeReread = async _ => await exec("KILL " + service.SsisActions.SessionOf(requestId) + ";", null);
        SsisExecuteResult refusedUnread;
        try { refusedUnread = await StopAsync(service, info.Id, unread, requestId: requestId); }
        finally
        {
            options.BeforeWrite = null;
            options.BeforeReread = null;
        }
        check(refusedUnread is { Steps: [{ Status: "failed" }], Error: { Code: "SQL_ERROR" } } && refusedUnread.Error.Message.StartsWith("Msg 27124: ", StringComparison.Ordinal)
            && refusedUnread.Steps[0].Message == refusedUnread.Error.Message && await StatusAsync(exec, unread) == "7 7",
            "when the second look after the catalog's refusal fails, the reply keeps the refusal and the step failed: " + Dump(refusedUnread));
    }

    /// <summary>The write's own session, waiting on another session's lock: unpooled, named " - Integration Services Actions", in
    /// the catalog's database, READ COMMITTED with no lock timeout; Stop ends it, its step cancelled and nothing changed. The
    /// preflight, behind a lock on the operation's row, answers TIMEOUT within its budget and BLOCKED after its lock timeout.</summary>
    private static async Task LockedAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, string db, Func<string, string?, Task<SqlRun>> exec,
        Func<string, string, string?, Task<SqlRun>> sql, Func<string, Task<object>> close)
    {
        var options = service.Ssis.Options;
        var target = await ExecutionAsync(exec, start: true);
        async Task<T> Holding<T>(string table, string key, Func<Task<T>> run)
        {
            var holder = Guid.NewGuid().ToString();
            await exec("BEGIN TRANSACTION; SELECT 1 FROM [catalog].[" + table + "] WITH (XLOCK, ROWLOCK, HOLDLOCK) WHERE " + key + " = " + target + ";", holder);
            try { return await run(); }
            finally
            {
                await sql("IF @@TRANCOUNT > 0 ROLLBACK;", db, holder);
                await close(holder);
            }
        }

        // The stop's UPDATE of the execution waits on the held row, without a lock timeout, until Stop. The catalog has already
        // committed its own Stop operation (202, Running) by then, and a cancelled statement never reaches the procedure's error
        // path: that row stays Running, and the reply says so.
        var running = await StopOperationsAsync(exec, "2");
        var watch = Stopwatch.StartNew();
        var (stopped, facts, stoppedMs) = await Holding("executions", "execution_id", async () =>
        {
            using var stop = new CancellationTokenSource();
            var requestId = Guid.NewGuid().ToString();
            var request = StopAsync(service, info.Id, target, stop.Token, requestId);
            string?[]? row = null;
            while (row is null && watch.ElapsedMilliseconds < 30_000 && !request.IsCompleted)
            {
                if (service.SsisActions.SessionOf(requestId) is { } session)
                {
                    var found = await exec("SELECT r.lock_timeout, r.transaction_isolation_level, s.program_name, CASE WHEN s.database_id = DB_ID(" + Literal(db) + ") THEN 1 ELSE 0 END, r.wait_type "
                        + "FROM sys.dm_exec_requests AS r JOIN sys.dm_exec_sessions AS s ON s.session_id = r.session_id WHERE r.session_id = " + session + " AND r.blocking_session_id <> 0;", null);
                    row = found.Sets[0].FirstOrDefault();
                }
                if (row is null) await Task.Delay(50);
            }
            var stopping = Stopwatch.StartNew();
            stop.Cancel();
            var result = await request;
            return (result, row, stoppedMs: stopping.ElapsedMilliseconds);
        });
        // The cancelled statement's transaction ends with its connection, which closes with the request.
        var settled = Stopwatch.StartNew();
        string? status;
        while ((status = await StatusAsync(exec, target)) != "2 2" && settled.ElapsedMilliseconds < 10_000) await Task.Delay(100);
        check(facts is [var timeout, "2", var program, "1", _] && timeout == "-1" && program?.EndsWith(" - Integration Services Actions", StringComparison.Ordinal) == true,
            "a write runs on its own session in the catalog's database, named \" - Integration Services Actions\", at READ COMMITTED, and waits for a lock without a lock timeout, as SSMS does: "
            + (facts is null ? "never seen blocked" : string.Join(", ", facts)));
        // An answer at all proves Stop ended it within the grace: past it, the request throws instead of answering.
        var orphans = await StopOperationsAsync(exec, "2") - running;
        check(stopped is { Steps: [{ Status: "cancelled", Message: "Stop the operation" }], Error: { Code: "CANCELLED", Retryable: true } }
            && stopped.Error.Message == "The action was stopped at \"Stop the operation\"; SQL Server cancelled that statement." + SsisActionService.StoppedStopNote
            && status == "2 2" && service.SsisActions.RunningCount == 0 && orphans == 1,
            "Stop ends a write waiting on a lock within its grace, with its step cancelled, the operation left as it was, and the catalog's own Stop operation left Running, "
            + "which the reply says (" + stoppedMs + " ms, status " + status + ", " + orphans + " left Running): " + Dump(stopped));

        // The preflight reads the operation's row behind a writer: within a 1 s budget it answers TIMEOUT; with its own 25 s, the
        // 10 s lock timeout answers BLOCKED; and a connection lost while it waits says nothing changed. None reaches the catalog.
        var stops = await StopOperationsAsync(exec, null);
        options.PreflightBudget = TimeSpan.FromSeconds(1);
        SsisExecuteResult timedOut, blocked, lost;
        long blockedMs;
        string? killed;
        try
        {
            (timedOut, blocked, blockedMs, lost, killed) = await Holding("operations", "operation_id", async () =>
            {
                var first = await StopAsync(service, info.Id, target);
                options.PreflightBudget = new SsisOptions().PreflightBudget;
                var waited = Stopwatch.StartNew();
                var second = await StopAsync(service, info.Id, target);
                var secondMs = waited.ElapsedMilliseconds;
                // This run's own write session, ended while its preflight waits.
                var requestId = Guid.NewGuid().ToString();
                var request = StopAsync(service, info.Id, target, requestId: requestId);
                var session = await BlockedSessionAsync(service, requestId, request, exec);
                if (session is not null) await exec("KILL " + session + ";", null);
                return (first, second, secondMs, await request, session);
            });
        }
        finally { options.PreflightBudget = new SsisOptions().PreflightBudget; }
        check(timedOut is { Steps: [], Error: { Code: "TIMEOUT", Retryable: true } } && timedOut.Error.Message == "Checking operation " + target + " took longer than 1 seconds. Try again."
            && blocked is { Steps: [], Error: { Code: "BLOCKED", Retryable: true } } && blockedMs >= 9_000
            && killed is not null && lost is { Steps: [], Error: { Code: "CONNECTION_LOST", Retryable: true } }
            && lost.Error.Message == "The connection to the server was lost before Varia could stop operation " + target + ", so nothing changed. Try again."
            && await StopOperationsAsync(exec, null) == stops,
            "a preflight behind a writer's lock answers TIMEOUT past its budget, BLOCKED after its 10 s lock timeout, and CONNECTION_LOST saying nothing changed when its connection is lost, "
            + "before the catalog is asked (" + blockedMs + " ms, session " + (killed ?? "never seen blocked") + "): " + Dump(timedOut) + Dump(blocked) + Dump(lost));
        await exec("EXEC [catalog].[varia_fake_finish] " + target + ", 3;", null);
    }

    /// <summary>The scratch SQL Server login: refused before it connects on a box server; past the seam, the fake catalog refuses it
    /// with 27123 as the real one does (WINDOWS_AUTH_REQUIRED), and a login without EXECUTE gets PERMISSION_DENIED naming the action.</summary>
    private static async Task LoginsAsync(Action<bool, string> check, SqlService service, Func<string, ConnectOptions> live, JsonSerializerOptions json, ScratchDatabase scratch, string db,
        bool sqlAuth, Func<string, string?, Task<SqlRun>> exec)
    {
        if (scratch.Login is null && !await scratch.CreateLoginAsync())
        {
            Console.WriteLine("The SSIS write checks for a SQL Server login are skipped: this server accepts Windows logins only.");
            return;
        }
        var login = scratch.Login!;
        await exec("IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = " + Literal(login) + ") CREATE USER " + Bracket(login) + " FOR LOGIN " + Bracket(login) + ";\n"
            + "GRANT SELECT ON SCHEMA::[catalog] TO " + Bracket(login) + "; REVOKE EXECUTE ON SCHEMA::[catalog] FROM " + Bracket(login) + ";", null);
        var target = await ExecutionAsync(exec, start: true);
        var reader = (ConnectionInfo)await service.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(live("master") with
        {
            Authentication = "sql", Username = login, Password = scratch.Password
        }, json), json);
        var options = service.Ssis.Options;
        try
        {
            options.IgnoreSqlAuthentication = false;
            var refused = await StopAsync(service, reader.Id, target);
            options.IgnoreSqlAuthentication = true;
            var denied = await StopAsync(service, reader.Id, target);
            check(refused is { Steps: [], Error.Code: "WINDOWS_AUTH_REQUIRED" } && refused.Error.Message == SsisErrors.WindowsAuthRequired
                && denied is { Steps: [{ Status: "failed" }], Error: { Code: "PERMISSION_DENIED", Retryable: false } } && denied.Error.Message.StartsWith("You do not have permission to stop operation " + target + " (", StringComparison.Ordinal)
                && await StatusAsync(exec, target) == "2 2",
                "a SQL Server login is refused before it connects; past the seam, one without EXECUTE on the catalog's procedures gets PERMISSION_DENIED naming the action, and nothing stops: "
                + Dump(refused) + Dump(denied));
            // The fake refuses SQL Server logins (27123) unless this run itself signed in that way (then the fake's refusal is off).
            if (!sqlAuth)
            {
                await exec("GRANT EXECUTE ON SCHEMA::[catalog] TO " + Bracket(login) + ";", null);
                var catalogRefused = await StopAsync(service, reader.Id, target);
                check(catalogRefused is { Steps: [{ Status: "failed" }], Error: { Code: "WINDOWS_AUTH_REQUIRED", Retryable: false } } && catalogRefused.Error.Message == SsisErrors.WindowsAuthRequired
                    && await StatusAsync(exec, target) == "2 2",
                    "the catalog's own refusal of a SQL Server login (27123) answers WINDOWS_AUTH_REQUIRED, and nothing stops: " + Dump(catalogRefused));
            }
        }
        finally
        {
            options.IgnoreSqlAuthentication = sqlAuth;
            await service.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(reader.Id), json), json);
            await exec("REVOKE EXECUTE ON SCHEMA::[catalog] FROM " + Bracket(login) + "; EXEC [catalog].[varia_fake_finish] " + target + ", 3;", null);
        }
    }

    private static async Task MissingAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, string db)
    {
        var options = service.Ssis.Options;
        options.CatalogDatabase = db + "_gone";
        try
        {
            var gone = await StopAsync(service, info.Id, 1);
            check(gone is { Steps: [], Error: { Code: "CATALOG_MISSING", Retryable: false } } && gone.Error.Message.Contains(db + "_gone", StringComparison.Ordinal),
                "a write to a catalog whose database does not exist answers CATALOG_MISSING: " + Dump(gone));
        }
        finally { options.CatalogDatabase = db; }
    }
}
