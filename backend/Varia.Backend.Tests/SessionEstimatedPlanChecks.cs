using System.Text.Json;
using System.Xml.Linq;
using Varia.Backend.Plans;

namespace Varia.Backend.Tests;

internal static class SessionEstimatedPlanChecks
{
    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var session = Guid.NewGuid().ToString();
        var holder = Guid.NewGuid().ToString();
        var table = "##VariaSessionEstimate_" + Guid.NewGuid().ToString("N");
        Task<object> Call(string method, object args) => service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<QueryResult> Run(string sql, string? tab = null, string? request = null, bool actual = false) => (QueryResult)await Call("query.execute",
            new QueryArgs(info.Id, tab ?? session, "tempdb", sql, request ?? Guid.NewGuid().ToString(), 100, 15, IncludeActualPlan: actual));
        async Task<EstimatedPlanResult> Estimate(string sql, string? request = null, string database = "tempdb", int start = 1) => (EstimatedPlanResult)await Call("plans.estimate",
            new EstimatedPlanArgs(info.Id, session, request ?? Guid.NewGuid().ToString(), database, sql, start, "session"));
        string First(QueryResult result) => result.ResultSets.Count > 0 ? string.Join(",", LiveResultChecks.RowsOf(service.Results, result.ResultSets[0])[0]) : result.Error?.Message ?? result.Status;
        async Task Refused(string sql, string code, string name, int start = 1)
        {
            try { await Estimate(sql, start: start); check(false, name); }
            catch (RequestException error) { check(error.Code == code, name + ": " + error.Message); }
        }
        try
        {
            var open = service.Open;
            service.Open = (_, _) => throw ConnectionFailureChecks.Sql(0, 0, 16, "", "injected opening failure");
            try
            {
                try { await Estimate("SELECT 1;"); check(false, "session estimate opening failure"); }
                catch (RequestException error) { check(error.Code == "SQL_ERROR" && error.Message.Contains("No query session remains open"), "opening failure does not claim that a usable query session survived"); }
            }
            finally { service.Open = open; }
            // A new tab opens precisely the same persistent session as ordinary execution, without creating result handles.
            await Estimate("SELECT 1;");
            var before = await Run("CREATE TABLE #session_estimate(n int); INSERT #session_estimate VALUES(42); SET ARITHABORT OFF; SET TEXTSIZE 1234; SET QUOTED_IDENTIFIER OFF; BEGIN TRAN; INSERT #session_estimate VALUES(43);");
            var retained = await Run("SELECT @@SPID;");
            var result = await Estimate("SELECT n FROM #session_estimate;\nGO 2\nSET ARITHABORT ON; SET TEXTSIZE 999; SET QUOTED_IDENTIFIER ON;\nGO\nINSERT #session_estimate VALUES(99); DELETE #session_estimate; COMMIT;");
            check(result.Plans.Count >= 2 && result.Plans.Take(2).Select(p => (p.BatchNumber, p.Iteration)).SequenceEqual([(1, 1), (1, 2)])
                && result.Plans.All(p => XDocument.Parse(p.Xml).Root is not null && !p.Xml.Contains("RunTimeCountersPerThread")), "session estimation sees local temp objects, preserves GO ordering and returns complete compile-only XML even with low TEXTSIZE");
            check(result.Plans[0].Xml.Contains("ARITHABORT=\"false\""), "session estimation compiles with the tab's existing SET options");
            check(service.Results.Find(retained.ResultSets[0].ResultId) is not null, "session estimates retain ordinary result handles");
            var after = await Run("SELECT @@TRANCOUNT, SESSIONPROPERTY('ARITHABORT'), @@TEXTSIZE, SESSIONPROPERTY('QUOTED_IDENTIFIER'), (SELECT SUM(n) FROM #session_estimate);");
            check(after.Spid == before.Spid && First(after) == "1,0,1234,0,85", "session estimation preserves SPID, transaction, SET options and uncommitted temp data without executing DML or COMMIT: " + First(after));
            var switched = await Estimate("USE [tempdb];\nGO\nSELECT n FROM #session_estimate;", database: "master");
            check(switched.Database == "tempdb" && switched.Plans is [{ BatchNumber: 2 }], "session estimates apply selected database and standalone USE across batches");
            check(First(await Run("SELECT DB_NAME();")) == "tempdb", "session estimate restores the original database");
            await Refused("SELECT n FROM #missing_session_estimate;", "SQL_ERROR", "session compile errors fail without discarding the session", start: 17);
            await Refused("CREATE TABLE #never_estimated(n int);\nGO\nSELECT n FROM #never_estimated;", "SQL_ERROR", "estimated setup SQL never creates temporary objects");
            await Refused("SELECT 1;\nGO\nSET SHOWPLAN_XML OFF;\nGO\nDROP TABLE #session_estimate;", "INVALID_SCRIPT", "session capture toggle guard validates every batch before submission");
            check(First(await Run("SELECT @@TRANCOUNT, SUM(n) FROM #session_estimate;")) == "1,85", "compilation errors leave the open transaction and data usable");
            await Run("CREATE TABLE #uncommitted_schema(n int);");
            check((await Estimate("SELECT n FROM #uncommitted_schema;")).Plans.Count == 1, "session estimates see uncommitted schema created by earlier ordinary execution");
            await Refused("SELECT n FROM #session_estimate;\nGO 65", "TOO_LARGE", "session estimates enforce the shared document bound and clean up");
            await Run("ROLLBACK; SELECT 1/0;");
            await Estimate("SELECT n FROM #session_estimate;");
            check(First(await Run("SELECT @@ROWCOUNT, @@ERROR;")) == "0,0", "session capture cleanup resets @@ROWCOUNT and @@ERROR, including the preceding ordinary error");
            await Run("INSERT #session_estimate VALUES(44),(45);");
            await Estimate("SELECT n FROM #session_estimate;");
            check(First(await Run("SELECT @@ROWCOUNT, @@ERROR;")) == "0,0", "session capture cannot retain the preceding DML row count");

            // Existing capture/compile-only options are refused, rather than silently turned off on the user's behalf.
            foreach (var option in new[] { "SHOWPLAN_XML", "SHOWPLAN_TEXT", "SHOWPLAN_ALL", "NOEXEC", "PARSEONLY", "FMTONLY" })
            {
                await Run("SET " + option + " ON;");
                await Refused("SELECT 1;", "SQL_ERROR", "pre-existing " + option + " is refused without taking capture ownership");
                if (option == "SHOWPLAN_XML")
                    check((await Run("SELECT 1;")).ResultSets is [{ Kind: "executionPlan" }], "refused estimate preserves pre-existing SHOWPLAN_XML");
                await Run("SET " + option + " OFF;");
            }
            await Run("EXECUTE AS USER = 'guest';");
            await Refused("SELECT * FROM msdb.dbo.sysjobs;", "SQL_ERROR", "session estimate honors impersonation and permission errors");
            check(First(await Run("SELECT USER_NAME();")) == "guest", "permission failures retain impersonation until explicit REVERT");
            await Run("REVERT;");

            await Run("CREATE TABLE " + table + "(n int);", holder);
            await Run("BEGIN TRAN; ALTER TABLE " + table + " ADD extra int;", holder);
            await Run("BEGIN TRAN; INSERT #session_estimate VALUES(46);");
            var id = Guid.NewGuid().ToString();
            var blocked = Estimate("SELECT n FROM " + table, id);
            await Task.Delay(250);
            check(!blocked.IsCompleted, "session compilation can block on another session's schema lock");
            try { await Call("query.session.state", new SessionStateArgs(session)); check(false, "state read while estimating"); }
            catch (RequestException error) { check(error.Code == "SESSION_BUSY", "session estimate holds the gate against state reads"); }
            await Refused("SELECT 1;", "SESSION_BUSY", "second estimate on the same tab fails fast");
            try { await Run("SELECT 1;"); check(false, "execute while estimating"); }
            catch (RequestException error) { check(error.Code == "SESSION_BUSY", "ordinary execution cannot overlap session capture"); }
            await Call("query.cancel", new CancelArgs(id));
            try { await blocked; check(false, "session estimate cancel"); }
            catch (RequestException error) { check(error.Code == "CANCELLED", "session compilation cancellation settles after cleanup"); }
            service.EstimatedPlanBudget = TimeSpan.FromMilliseconds(250);
            try { await Refused("SELECT n FROM " + table, "TIMEOUT", "session estimates share the bounded compilation budget"); }
            finally { service.EstimatedPlanBudget = EstimatedPlanCapture.Budget; }
            check(First(await Run("SELECT @@TRANCOUNT, SUM(n) FROM #session_estimate;")) == "1,177", "cancel and timeout retain transaction and temp data after confirmed cleanup");
            await Run("SET XACT_ABORT ON;");
            var abortId = Guid.NewGuid().ToString();
            var abortRead = Estimate("SELECT n FROM " + table, abortId);
            await Task.Delay(250);
            await Call("query.cancel", new CancelArgs(abortId));
            try { await abortRead; check(false, "XACT_ABORT cancellation"); }
            catch (RequestException error) { check(error.Code == "CANCELLED", "session estimate cancellation with XACT_ABORT ON settles"); }
            check(First(await Run("SELECT @@TRANCOUNT, @@OPTIONS & 16384, SUM(n) FROM #session_estimate;")) == "0,16384,131",
                "SQL Server attention with XACT_ABORT ON rolls back the pre-existing transaction while capture cleanup preserves the option and usable session");
            await Run("SET XACT_ABORT OFF;");
            await Run("ROLLBACK;", holder);

            // A separate connection profile can disconnect during capture without disturbing this suite's holder.
            var user = Environment.GetEnvironmentVariable("VARIA_TEST_SQL_USER");
            var extra = (ConnectionInfo)await Call("connections.connect", new ConnectOptions(info.Server, "tempdb", string.IsNullOrWhiteSpace(user) ? "windows" : "sql", user,
                string.IsNullOrWhiteSpace(user) ? null : Environment.GetEnvironmentVariable("VARIA_TEST_SQL_PASSWORD"), true));
            try
            {
                await Run("BEGIN TRAN; ALTER TABLE " + table + " ADD extra int;", holder);
                var disconnected = Call("plans.estimate", new EstimatedPlanArgs(extra.Id, Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "tempdb", "SELECT n FROM " + table, Mode: "session"));
                await Task.Delay(250);
                await Call("connections.disconnect", new ConnectionArgs(extra.Id));
                try { await disconnected; check(false, "disconnect during estimate"); }
                catch (RequestException error) { check(error.Code == "CANCELLED", "disconnect cancels session estimation and defers physical disposal until capture cleanup"); }
                await Run("ROLLBACK;", holder);
            }
            finally { await Call("connections.disconnect", new ConnectionArgs(extra.Id)); }
            await Run("IF @@TRANCOUNT>0 ROLLBACK;");
            var ordinary = await Run("SELECT n FROM #session_estimate;", actual: true);
            check(ordinary.Status == "completed" && ordinary.ResultSets is [{ Kind: "rows" }] && ordinary.PlanSets is [{ Kind: "executionPlan" }, ..], "ordinary execution and actual capture remain usable after session estimates");

            var waitId = Guid.NewGuid().ToString();
            var waiting = Run("WAITFOR DELAY '00:00:10';", request: waitId);
            await Task.Delay(250);
            await Refused("SELECT 1;", "SESSION_BUSY", "session estimate refuses a tab already executing");
            await Call("query.cancel", new CancelArgs(waitId));
            await waiting;

            // Cleanup cannot be assumed: failure discards the session before releasing its gate, even after successful compilation.
            await Run("BEGIN TRAN; INSERT #session_estimate VALUES(999);");
            service.SessionFault = sql => sql == "SET SHOWPLAN_XML OFF" ? new InvalidOperationException("injected cleanup failure") : null;
            try { await Refused("SELECT n FROM #session_estimate;", "SESSION_LOST", "failed capture cleanup closes the borrowed physical session"); }
            finally { service.SessionFault = null; }
            check(First(await Run("SELECT @@TRANCOUNT, OBJECT_ID('tempdb..#session_estimate');")) == "0," , "execution after cleanup failure opens a clean session with no previous temp objects or transaction");

            // A transport failure during capture, not just cleanup, must never leave an apparently reusable session.
            service.SessionFault = sql => sql == "SET SHOWPLAN_XML ON" ? ConnectionFailureChecks.Sql(0, 0, 20, "", "injected transport failure") : null;
            try { await Refused("SELECT 1;", "SESSION_LOST", "fatal transport failure closes session even when SqlClient still reports Open"); }
            finally { service.SessionFault = null; }
            await Estimate("SELECT 1;");

            // Disconnect and session close cancel a blocked request and remove the session through existing ownership.
            await Run("BEGIN TRAN; ALTER TABLE " + table + " ADD extra int;", holder);
            var closeRead = Estimate("SELECT n FROM " + table);
            await Task.Delay(250);
            await Call("query.session.close", new SessionArgs(session));
            try { await closeRead; check(false, "close blocked estimate"); }
            catch (RequestException error) { check(error.Code == "CANCELLED", "closing a session cancels its blocked estimate and cleans capture before disposal"); }
            await Run("ROLLBACK;", holder);
        }
        finally
        {
            service.SessionFault = null;
            service.EstimatedPlanBudget = EstimatedPlanCapture.Budget;
            await Call("query.session.close", new SessionArgs(session));
            await Call("query.session.close", new SessionArgs(holder));
        }
    }
}
