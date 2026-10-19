using System.Diagnostics;
using System.Globalization;
using System.Text.Json;

namespace Varia.Backend.Tests;

/// <summary>Live checks of a tab's session as the workbench's prompts see it: its SPID and login read once when it opens,
/// nothing run in it after a script (so @@ROWCOUNT, @@ERROR and its most recent SQL stay the script's), its open
/// transaction read on demand (query.session.state) only when it is about to end, and query.session.close committing or
/// rolling back that transaction before the session ends. A holder session owns a uniquely named global temporary table,
/// so another session can see what a commit kept; it is dropped with that session. Run only with VARIA_TEST_SQL_SERVER.</summary>
internal static class TransactionLiveChecks
{
    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var store = service.Results;
        Task<object> Call(string method, object args) => service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<QueryResult> Run(string sql, string sessionId, string database = "master", string? queryId = null) =>
            (QueryResult)await Call("query.execute", new QueryArgs(info.Id, sessionId, database, sql, queryId ?? Guid.NewGuid().ToString(), 1000, 30));
        async Task<string?> Close(string sessionId, string? transaction)
        {
            try { await Call("query.session.close", new SessionArgs(sessionId, transaction)); return null; }
            catch (RequestException error) { return error.Code + ": " + error.Message; }
        }
        // "count" when read, "count?" when the session's SET options kept it from being read, or the error code.
        async Task<string> State(string sessionId)
        {
            try
            {
                var state = (SessionState)await Call("query.session.state", new SessionStateArgs(sessionId));
                return state.TransactionCount.ToString(CultureInfo.InvariantCulture) + (state.Checked ? "" : "?");
            }
            catch (RequestException error) { return error.Code; }
        }
        string First(QueryResult result) => result.ResultSets.Count > 0 ? string.Join(",", LiveResultChecks.RowsOf(store, result.ResultSets[0])[0]) : result.Error?.Message ?? result.Status;
        var holder = Guid.NewGuid().ToString();
        var tab = Guid.NewGuid().ToString();
        var table = "##VariaTransactions_" + Guid.NewGuid().ToString("N");
        async Task<string?> Rows()
        {
            var counted = await Run("SELECT COUNT(*) FROM " + table + ";", holder);
            return counted.Status == "completed" ? LiveResultChecks.RowsOf(store, counted.ResultSets[0])[0][0] : counted.Error?.Message;
        }
        try
        {
            var created = await Run("CREATE TABLE " + table + " (n int);", holder);
            check(created.Status == "completed" && await State(holder) == "0", "a holder session creates the global temporary table outside any transaction");

            // The summary carries the session's SPID and login, read when it opened; the transaction is read on demand.
            var begun = await Run("BEGIN TRANSACTION; INSERT " + table + " VALUES (1);", tab);
            var spid = await Run("SELECT @@SPID;", tab);
            var opened = await State(tab);
            check(begun.Status == "completed" && opened == "1" && begun.Spid > 0 && spid.Spid == begun.Spid && First(spid) == begun.Spid.ToString()
                && !string.IsNullOrEmpty(begun.Login) && begun.Login == info.Login && spid.Login == begun.Login,
                "after BEGIN TRANSACTION the session reports 1 open transaction on demand, and the summary its SPID and login (" + opened + ", " + begun.Spid + ", " + begun.Login + ")");
            await Run("BEGIN TRANSACTION;", tab);
            var nested = await State(tab);
            check(nested == "2", "a nested BEGIN TRANSACTION reports 2: " + nested);
            var committed = await Run("COMMIT; COMMIT;", tab);
            var none = await State(tab);
            check(committed.Status == "completed" && none == "0", "after COMMIT the session reports 0: " + none);
            check(await Rows() == "1", "the committed row is visible to another session");

            // Nothing runs in the session after a script, so the next one sees what the last statement left, as in SSMS.
            await Run("SELECT 1 AS n UNION ALL SELECT 2;", tab);
            var rowCount = await Run("SELECT @@ROWCOUNT;", tab);
            check(rowCount.Status == "completed" && First(rowCount) == "2", "@@ROWCOUNT survives into the next execution: " + First(rowCount));
            await Run("SELECT 1/0;", tab);
            var lastError = await Run("SELECT @@ERROR;", tab);
            check(lastError.Status == "completed" && First(lastError) == "8134", "@@ERROR survives into the next execution: " + First(lastError));

            // A cancel does not roll back: the session still holds the transaction the cancelled script opened.
            var slowId = Guid.NewGuid().ToString();
            var slow = Run("BEGIN TRANSACTION; INSERT " + table + " VALUES (2); WAITFOR DELAY '00:00:10';", tab, queryId: slowId);
            await Task.Delay(800);
            await Call("query.cancel", new CancelArgs(slowId));
            var cancelled = await slow;
            var afterCancel = await State(tab);
            check(cancelled.Status == "cancelled" && afterCancel == "1", "a cancelled script's open transaction is still reported: " + cancelled.Status + ", " + afterCancel);

            // While a script runs, the state is not read (it never waits) and a commit is refused; the session keeps its transaction.
            var busyId = Guid.NewGuid().ToString();
            var busy = Run("WAITFOR DELAY '00:00:10';", tab, queryId: busyId);
            await Task.Delay(400);
            var busyState = await State(tab);
            var refused = await Close(tab, "commit");
            await Call("query.cancel", new CancelArgs(busyId));
            await busy;
            var stillOpen = await State(tab);
            check(busyState == "SESSION_BUSY" && refused?.StartsWith("SESSION_BUSY") == true && stillOpen == "1",
                "a running script's session answers SESSION_BUSY rather than waiting, and a commit is refused: " + busyState + ", " + refused);

            // Close with commit: the transaction is kept, then the session ends.
            check(await Close(tab, "commit") is null && await Rows() == "2", "closing with commit commits the open transaction before the session ends");
            var closedState = await State(tab);
            var fresh = await Run("SELECT 1;", tab);
            check(closedState == "SESSION_CLOSED" && await State(tab) == "0" && fresh.Spid is not null, "a closed session answers SESSION_CLOSED; the next execution opens a new one without a transaction");

            // Close with rollback.
            await Run("BEGIN TRANSACTION; INSERT " + table + " VALUES (3);", tab);
            check(await Close(tab, "rollback") is null && await Rows() == "2", "closing with rollback discards the open transaction");

            // A rollback is the close itself, so it does not wait for SQL Server to undo the work: an explicit ROLLBACK (or an
            // attention sent during one) would hold the request for as long as the rollback takes.
            await Run("SELECT TOP (500000) CONVERT(char(100), 'y') AS v INTO #VariaRollback FROM sys.all_objects a CROSS JOIN sys.all_objects b;", tab);
            var updated = await Run("BEGIN TRANSACTION; UPDATE #VariaRollback SET v = 'z';", tab);
            var updatedState = await State(tab);
            var closing = Stopwatch.StartNew();
            var rolledBack = await Close(tab, "rollback");
            closing.Stop();
            check(updated.Status == "completed" && updatedState == "1" && rolledBack is null && closing.ElapsedMilliseconds * 4 < updated.ElapsedMs,
                "closing with rollback returns before SQL Server has rolled back the work (" + closing.ElapsedMilliseconds + " ms to close, " + updated.ElapsedMs + " ms to update)");

            // An error that dooms the transaction ends it by the batch's end (3998), and the session says so.
            await Run("SET XACT_ABORT ON; BEGIN TRANSACTION; INSERT " + table + " VALUES (4); BEGIN TRY SELECT 1/0; END TRY BEGIN CATCH END CATCH; SET XACT_ABORT OFF;", tab);
            var doomed = await State(tab);
            check(doomed == "0" && await Rows() == "2", "a transaction an error doomed is rolled back by the end of its batch, and the session reports 0: " + doomed);

            // A session killed with its transaction open: the state says it was lost, the commit that nothing was committed.
            var allowed = await Run("SELECT CONVERT(int, IS_SRVROLEMEMBER('sysadmin')) + HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER ANY CONNECTION');", holder);
            if (allowed.Status == "completed" && LiveResultChecks.RowsOf(store, allowed.ResultSets[0])[0][0] is not (null or "0"))
            {
                var victim = await Run("BEGIN TRANSACTION; INSERT " + table + " VALUES (5);", tab);
                var killed = await Run("KILL " + victim.Spid + ";", holder);
                var lostState = await State(tab);
                var afterLost = await State(tab);
                check(killed.Status == "completed" && lostState == "SESSION_LOST" && afterLost == "SESSION_CLOSED" && await Rows() == "2",
                    "a killed session's state says it was lost, and the session is then gone: " + lostState + ", " + afterLost);
                var victimAgain = await Run("BEGIN TRANSACTION; INSERT " + table + " VALUES (5);", tab);
                await Run("KILL " + victimAgain.Spid + ";", holder);
                var lost = await Close(tab, "commit");
                check(lost == "SESSION_LOST: The SQL session was lost, so SQL Server rolled back its transaction. Nothing was committed." && await Rows() == "2"
                    && await Close(tab, "commit") is null, "a commit in a killed session says nothing was committed: " + lost);

                // Another session sees the user's own SQL as the session's most recent, as with SSMS: nothing follows it.
                const string own = "SELECT TOP (1) 1 AS own FROM sys.objects;";
                var last = await Run(own, tab);
                var buffer = await Run("SELECT event_info FROM sys.dm_exec_input_buffer(" + last.Spid + ", NULL);", holder);
                check(buffer.Status == "completed" && First(buffer) == own, "another session sees the user's own SQL as the session's most recent: " + First(buffer));

                // A session lost while its commit runs: the outcome is unknown, and the error says so rather than that nothing
                // was committed.
                service.CommitSql = "WAITFOR DELAY '00:00:10'; " + SqlService.DefaultCommitSql;
                try
                {
                    var committing = await Run("BEGIN TRANSACTION; INSERT " + table + " VALUES (8);", tab);
                    var commit = Close(tab, "commit");
                    await Task.Delay(800);
                    await Run("KILL " + committing.Spid + ";", holder);
                    var unknown = await commit;
                    check(unknown == "SESSION_LOST: The SQL session was lost while committing, so it is not known whether its transaction was committed. Check the data before running the work again."
                        && await Close(tab, "commit") is null, "a session lost while committing says the outcome is unknown: " + unknown);
                }
                finally { service.CommitSql = SqlService.DefaultCommitSql; }
            }
            else Console.WriteLine("Killed-session and input buffer checks skipped: the login is neither sysadmin nor granted ALTER ANY CONNECTION.");
            await Run("BEGIN TRANSACTION; INSERT " + table + " VALUES (6);", tab);
            check(await Close(tab, "rollback") is null && await Rows() == "2", "closing with rollback after a lost session opens a new one and rolls it back");

            // Options that compile without executing keep the state's SELECT from returning a count: the answer is unchecked,
            // the options stay (the user may keep the session), and a commit turns them off and still commits.
            var expected = 2;
            foreach (var option in new[] { "SET SHOWPLAN_XML ON", "SET SHOWPLAN_TEXT ON", "SET NOEXEC ON;", "SET FMTONLY ON;", "SET PARSEONLY ON;" })
            {
                var began = await Run("BEGIN TRANSACTION; INSERT " + table + " VALUES (7);", tab);
                var unread = await Run(option, tab);
                var first = await State(tab);
                var again = await State(tab);
                var commit = await Close(tab, "commit");
                check(unread.Status == "completed" && first == "0?" && again == "0?" && unread.Spid == began.Spid && unread.Login == began.Login
                    && commit is null && await Rows() == (++expected).ToString(CultureInfo.InvariantCulture),
                    option + " leaves the transaction unchecked without turning the option off, and a commit still commits: " + first + ", " + again + ", " + commit);
            }

            // Without a transaction, both are a plain close; a session that never opened needs no commit and has no state.
            await Run("SELECT 1;", tab);
            check(await Close(tab, "commit") is null && await Close(Guid.NewGuid().ToString(), "commit") is null, "closing with commit and no open transaction, or no session, just closes");
            var missing = await Run("SELECT 1;", tab, database: "VariaDatabaseThatDoesNotExist");
            check(missing.Status == "failed" && missing.Spid is null && missing.Login is null && await State(tab) == "SESSION_CLOSED" && await State(Guid.NewGuid().ToString()) == "SESSION_CLOSED",
                "a session that never opened has no SPID, login or state");
            await Close(tab, null);

            // The session limit refuses the next session with an actionable sentence, and the tab already open still runs.
            var limit = service.SessionLimit;
            service.SessionLimit = 1;
            try
            {
                var refusedSession = "";
                try { await Run("SELECT 1;", tab); }
                catch (RequestException error) { refusedSession = error.Code + ": " + error.Message; }
                var holderRuns = await Run("SELECT 1;", holder);
                check(refusedSession.StartsWith("SESSION_LIMIT: This query was not executed: 1 query tabs already hold SQL sessions") && refusedSession.Contains("Close query tabs you no longer need")
                    && holderRuns.Status == "completed", "the session limit names what to do: " + refusedSession);
            }
            finally { service.SessionLimit = limit; }
        }
        finally
        {
            await Close(tab, null);
            await Close(holder, null);
        }
    }
}
