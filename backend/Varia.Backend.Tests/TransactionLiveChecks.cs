using System.Text.Json;

namespace Varia.Backend.Tests;

/// <summary>Live checks of a tab's session as the workbench's prompts see it: the probe after every script (@@TRANCOUNT,
/// @@SPID, the login), and query.session.close committing or rolling back the open transaction before the session ends. A
/// holder session owns a uniquely named global temporary table, so another session can see what a commit kept; it is
/// dropped with that session. Run only with VARIA_TEST_SQL_SERVER.</summary>
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
            check(created.Status == "completed" && created.TransactionCount == 0, "a holder session creates the global temporary table outside any transaction");

            // The probe follows every script: the open transaction's nesting, the session id, and the login.
            var begun = await Run("BEGIN TRANSACTION; INSERT " + table + " VALUES (1);", tab);
            var spid = await Run("SELECT @@SPID;", tab);
            check(begun.Status == "completed" && begun.TransactionCount == 1 && begun.Spid > 0 && spid.Spid == begun.Spid
                && LiveResultChecks.RowsOf(store, spid.ResultSets[0])[0][0] == begun.Spid.ToString() && !string.IsNullOrEmpty(begun.Login) && begun.Login == info.Login,
                "after BEGIN TRANSACTION the probe reports 1 open transaction, the session's SPID and its login (" + begun.TransactionCount + ", " + begun.Spid + ", " + begun.Login + ")");
            var nested = await Run("BEGIN TRANSACTION;", tab);
            check(nested.TransactionCount == 2, "a nested BEGIN TRANSACTION reports 2: " + nested.TransactionCount);
            var committed = await Run("COMMIT; COMMIT;", tab);
            check(committed.Status == "completed" && committed.TransactionCount == 0, "after COMMIT the probe reports 0: " + committed.TransactionCount);
            check(await Rows() == "1", "the committed row is visible to another session");

            // A cancel does not roll back: the probe still sees the transaction the cancelled script opened.
            var slowId = Guid.NewGuid().ToString();
            var slow = Run("BEGIN TRANSACTION; INSERT " + table + " VALUES (2); WAITFOR DELAY '00:00:10';", tab, queryId: slowId);
            await Task.Delay(800);
            await Call("query.cancel", new CancelArgs(slowId));
            var cancelled = await slow;
            check(cancelled.Status == "cancelled" && cancelled.TransactionCount == 1, "a cancelled script's open transaction is still reported: " + cancelled.Status + ", " + cancelled.TransactionCount);

            // Committing while a script runs is refused, and the session keeps its transaction.
            var busyId = Guid.NewGuid().ToString();
            var busy = Run("WAITFOR DELAY '00:00:10';", tab, queryId: busyId);
            await Task.Delay(400);
            var refused = await Close(tab, "commit");
            await Call("query.cancel", new CancelArgs(busyId));
            var stillOpen = await busy;
            check(refused?.StartsWith("SESSION_BUSY") == true && stillOpen.TransactionCount == 1, "a commit is refused while the tab's script runs: " + refused);

            // Close with commit: the transaction is kept, then the session ends.
            check(await Close(tab, "commit") is null && await Rows() == "2", "closing with commit commits the open transaction before the session ends");
            var fresh = await Run("SELECT 1;", tab);
            check(fresh.TransactionCount == 0 && fresh.Spid is not null, "the tab's next execution opens a new session without a transaction");

            // Close with rollback.
            await Run("BEGIN TRANSACTION; INSERT " + table + " VALUES (3);", tab);
            check(await Close(tab, "rollback") is null && await Rows() == "2", "closing with rollback discards the open transaction");

            // An error that dooms the transaction ends it by the batch's end (3998), and the probe says so.
            var doomed = await Run("SET XACT_ABORT ON; BEGIN TRANSACTION; INSERT " + table + " VALUES (4); BEGIN TRY SELECT 1/0; END TRY BEGIN CATCH END CATCH; SET XACT_ABORT OFF;", tab);
            check(doomed.TransactionCount == 0 && await Rows() == "2", "a transaction an error doomed is rolled back by the end of its batch, and the probe reports 0: " + doomed.TransactionCount);

            // A session killed with its transaction open: the commit reports that nothing was committed, and the session is gone.
            var allowed = await Run("SELECT CONVERT(int, IS_SRVROLEMEMBER('sysadmin')) + HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER ANY CONNECTION');", holder);
            if (allowed.Status == "completed" && LiveResultChecks.RowsOf(store, allowed.ResultSets[0])[0][0] is not (null or "0"))
            {
                var victim = await Run("BEGIN TRANSACTION; INSERT " + table + " VALUES (5);", tab);
                var killed = await Run("KILL " + victim.Spid + ";", holder);
                var lost = await Close(tab, "commit");
                check(killed.Status == "completed" && lost == "SESSION_LOST: The SQL session was lost, so SQL Server rolled back its transaction. Nothing was committed." && await Rows() == "2"
                    && await Close(tab, "commit") is null, "a commit in a killed session says nothing was committed: " + lost);
            }
            else Console.WriteLine("Killed-session commit check skipped: the login is neither sysadmin nor granted ALTER ANY CONNECTION.");
            await Run("BEGIN TRANSACTION; INSERT " + table + " VALUES (6);", tab);
            check(await Close(tab, "rollback") is null && await Rows() == "2", "closing with rollback after a lost session opens a new one and rolls it back");

            // Without a transaction, both are a plain close; a session that never opened needs no commit.
            await Run("SELECT 1;", tab);
            check(await Close(tab, "commit") is null && await Close(Guid.NewGuid().ToString(), "commit") is null, "closing with commit and no open transaction, or no session, just closes");
            var missing = await Run("SELECT 1;", tab, database: "VariaDatabaseThatDoesNotExist");
            check(missing.Status == "failed" && missing.TransactionCount is null && missing.Spid is null && missing.Login is null, "a session that never opened has no probe");
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
