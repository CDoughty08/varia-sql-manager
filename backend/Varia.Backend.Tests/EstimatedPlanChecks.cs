using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Plans;

namespace Varia.Backend.Tests;

internal static class EstimatedPlanChecks
{
    public static void Run(Action<bool, string> check)
    {
        foreach (var sql in new[] { "SET SHOWPLAN_XML OFF\nGO\nSELECT 1", "SET /* nested /* x */ */ SHOWPLAN_XML OFF", "IF 1=1 SET SHOWPLAN_TEXT OFF",
            "SET SHOWPLAN_ALL ON", "SET NOEXEC ON", "SET PARSEONLY ON", "SET FMTONLY ON", "SELECT 1\nGO\nSET SHOWPLAN_XML OFF" })
        {
            try { EstimatedPlanScript.Parse(sql, 1); check(false, "estimated SQL guard: " + sql); }
            catch (RequestException error) { check(error.Code == "INVALID_SCRIPT", "capture controls refused before any submission: " + sql); }
        }
        var harmless = EstimatedPlanScript.Parse("SELECT 'SET SHOWPLAN_XML OFF', N'GO', 'it''s safe'; -- SET SHOWPLAN_XML OFF\n/* SET SHOWPLAN_XML OFF */\nGO 2\nUSE [temp]]db];\nGO\nSELECT 2 OPTION(USE HINT('DISABLE_PARAMETER_SNIFFING'));", 5);
        check(harmless.Count == 3 && harmless[0].Source.RepeatCount == 2 && harmless[1].Database == "temp]db", "estimated guard handles literals, GO repetitions, nested comments and quoted USE");
        check(EstimatedPlanScript.Parse("USE \"tempdb\";", 1)[0].Database == "tempdb", "quoted USE database decodes without concatenating SQL");
        foreach (var database in new[] { "HINT", "PLAN" })
            check(EstimatedPlanScript.Parse("USE " + database + ";", 1)[0].Database == database, "standalone USE is a database switch even when named " + database);
        foreach (var sql in new[] { "USE tempdb; SELECT 1", "SELECT 1; USE master", "SELECT 1; USE HINT;", "SELECT 1; USE PLAN;", "USE master; USE tempdb", "SELECT 1\nGO 0", "SELECT 1\n:r x", "SELECT 'unterminated" })
        {
            try { EstimatedPlanScript.Parse(sql, 12); check(false, "invalid estimate accepted: " + sql); }
            catch (RequestException error) { check(error.Code == "INVALID_SCRIPT" && error.Message.Contains("Line "), "invalid estimated script has source line: " + sql); }
        }
    }

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var session = Guid.NewGuid().ToString();
        var lockTable = "##VariaEstimate_" + Guid.NewGuid().ToString("N");
        Task<object> Call(string method, object args) => service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<QueryResult> RunSql(string sql, bool actual = false) => (QueryResult)await Call("query.execute", new QueryArgs(info.Id, session, "tempdb", sql, Guid.NewGuid().ToString(), 100, 15, IncludeActualPlan: actual));
        async Task<EstimatedPlanResult> Estimate(string sql, string? request = null, int start = 1) => (EstimatedPlanResult)await Call("plans.estimate", new EstimatedPlanArgs(info.Id, session, request ?? Guid.NewGuid().ToString(), "master", sql, start));
        async Task Refused(string sql, string code, string name, int start = 1)
        {
            try { var result = await Estimate(sql, start: start); check(false, name + $" ({result.Plans.Count} documents, {result.Plans.Sum(p => p.Xml.Length)} XML characters)"); }
            catch (RequestException error) { check(error.Code == code, name + ": " + error.Message); }
        }
        try
        {
            var before = await RunSql("CREATE TABLE #estimate_existing(n int); INSERT #estimate_existing VALUES(42); SET ARITHABORT OFF; SET TEXTSIZE 1234; BEGIN TRAN;");
            var estimated = await Estimate("SELECT name FROM sys.objects;\nGO 2\nSELECT 2;");
            check(estimated.Plans.Count == 3 && estimated.Plans.Select(p => (p.BatchNumber, p.Iteration)).SequenceEqual([(1, 1), (1, 2), (2, 1)])
                && estimated.Plans.All(p => p.Xml.Contains("ShowPlanXML") && !p.Xml.Contains("RunTimeCountersPerThread")), "estimated plans contain compile metrics only and preserve batch/repetition order");
            var context = await Estimate("USE [tempdb];\nGO\nSELECT name FROM sys.objects WHERE object_id > 0;");
            check(context.Database == "tempdb" && context.Plans is [{ BatchNumber: 2 }] && context.Plans[0].Xml.Contains("[tempdb]"), "standalone USE sets the compilation database across GO");
            var setup = await Estimate("CREATE TABLE #estimate_never_created(n int);");
            check(setup.Plans.Count == 0 || setup.Plans.All(p => !p.Xml.Contains("RunTimeCountersPerThread")), "DDL is compiled without execution");
            await Refused("CREATE TABLE #estimate_never_created(n int);\nGO\nSELECT n FROM #estimate_never_created;", "SQL_ERROR", "a temp object created only by submitted SQL is unavailable");
            await Refused("SELECT n FROM #estimate_existing;", "SQL_ERROR", "existing tab-local temp objects are unavailable on the isolated compiler");
            await Refused("SELECT 1;\nGO\nSET SHOWPLAN_XML OFF\nGO\nDROP TABLE " + lockTable, "INVALID_SCRIPT", "a later SHOWPLAN OFF rejects the whole selection");
            await Refused("SELECT * FROM dbo.VariaMissingEstimatedTable;", "SQL_ERROR", "compile errors use the dedicated failure path", start: 9);
            var state = await RunSql("SELECT @@SPID, @@TRANCOUNT, CONVERT(int,SESSIONPROPERTY('ARITHABORT')), @@TEXTSIZE, n FROM #estimate_existing;");
            check(state.Spid == before.Spid && state.ResultSets is [var set] && LiveResultChecks.RowsOf(service.Results, set)[0].SequenceEqual([before.Spid.ToString(), "1", "0", "1234", "42"]), "estimation preserves the original SPID, transaction, SET options and temp data after success and errors");
            var retainedId = state.ResultSets[0].ResultId;
            await Estimate("SELECT 3;");
            check(service.Results.Find(retainedId) is not null, "estimation preserves existing ordinary result handles");
            await RunSql("ROLLBACK; CREATE TABLE " + lockTable + "(n int); INSERT " + lockTable + " VALUES(1);");
            await Estimate("EXEC(N'SET SHOWPLAN_XML OFF');\nGO\nINSERT " + lockTable + " VALUES(2); UPDATE " + lockTable + " SET n=9; DELETE FROM " + lockTable + "; BEGIN TRAN; COMMIT;");
            var noEffects = await RunSql("SELECT n FROM " + lockTable + ";");
            check(noEffects.ResultSets is [var unchanged] && LiveResultChecks.RowsOf(service.Results, unchanged).Select(row => row[0]).SequenceEqual(["1"]), "estimated dynamic SQL, DML and transaction commands have no execution effects");
            await Refused("SELECT 1;\nGO 65", "TOO_LARGE", "estimated XML document count is bounded before the IPC response");
            var wide = "SELECT " + string.Join(",", Enumerable.Range(0, 1000).Select(i => $"object_id+{i} AS [C{i}_" + new string('x', 100) + "]")) + " FROM sys.objects;\nGO 16";
            await Refused(wide, "TOO_LARGE", "estimated XML characters are bounded while streaming from SQL Server");
            await RunSql("BEGIN TRAN; ALTER TABLE " + lockTable + " ADD extra int NULL;");
            var cancelId = Guid.NewGuid().ToString();
            var pending = Estimate("SELECT n FROM " + lockTable, cancelId);
            await Task.Delay(250);
            check(!pending.IsCompleted, "estimated compilation waits for a schema lock without executing SQL");
            var ordinaryState = (SessionState)await Call("query.session.state", new SessionStateArgs(session));
            check(ordinaryState is { TransactionCount: 1, Checked: true }, "the ordinary transaction remains readable while its isolated estimate is blocked");
            await Call("query.cancel", new CancelArgs(cancelId));
            try { await pending; check(false, "estimated cancellation"); }
            catch (RequestException error) { check(error.Code == "CANCELLED", "estimated cancellation settles with CANCELLED"); }
            service.EstimatedPlanBudget = TimeSpan.FromMilliseconds(250);
            try { await Refused("SELECT n FROM " + lockTable, "TIMEOUT", "one bounded estimate budget interrupts schema-lock waits"); }
            finally { service.EstimatedPlanBudget = EstimatedPlanCapture.Budget; }
            var afterCancel = await RunSql("SELECT @@TRANCOUNT, n FROM #estimate_existing; ROLLBACK; DROP TABLE " + lockTable + ";");
            check(afterCancel.Status == "completed" && afterCancel.ResultSets is [var remaining] && LiveResultChecks.RowsOf(service.Results, remaining)[0].SequenceEqual(["1", "42"]), "cancel and timeout keep the ordinary session's transaction and temp objects");
            var normal = await RunSql("SELECT n FROM #estimate_existing;", actual: true);
            check(normal.Status == "completed" && normal.ResultSets is [{ Kind: "rows", RowsStored: 1 }] && normal.PlanSets is [{ Kind: "executionPlan" }, ..], "ordinary execution and actual capture still work after estimation");

            var open = service.Open;
            service.Open = async (connection, token) =>
            {
                await open(connection, token);
                await using var command = connection.CreateCommand();
                command.CommandText = "EXECUTE AS USER = 'guest';";
                await command.ExecuteNonQueryAsync(token);
            };
            try { await Refused("SELECT * FROM msdb.dbo.sysjobs;", "SQL_ERROR", "a restricted principal's permission failure is an actionable SQL error"); }
            finally { service.Open = open; }
            await Estimate("SELECT name FROM sys.objects;");
            check(true, "permission failure does not contaminate the next estimate connection");

            var earlyId = Guid.NewGuid().ToString();
            await Call("query.cancel", new CancelArgs(earlyId));
            try { await Estimate("SELECT 1;", earlyId); check(false, "early estimate cancellation"); }
            catch (RequestException error) { check(error.Code == "CANCELLED", "Stop that overtakes estimate registration prevents acquisition"); }

            // Hold two fresh compiler connections at Open, independently of metadata/live slots. A third fails fast;
            // cancellation must dispose both physical connections and release every slot for the next estimate.
            var opened = new List<SqlConnection>();
            var both = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var hold = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var normalOpen = service.Open;
            service.Open = async (connection, token) =>
            {
                await normalOpen(connection, token);
                lock (opened) { opened.Add(connection); if (opened.Count == 2) both.TrySetResult(); }
                await hold.Task.WaitAsync(token);
            };
            var ids = new[] { Guid.NewGuid().ToString(), Guid.NewGuid().ToString() };
            var compilerSessions = new[] { Guid.NewGuid().ToString(), Guid.NewGuid().ToString() };
            var reads = ids.Select((id, index) => Call("plans.estimate", new EstimatedPlanArgs(info.Id, compilerSessions[index], id, "master", "SELECT 1;"))).ToArray();
            try
            {
                await both.Task.WaitAsync(TimeSpan.FromSeconds(10));
                await Refused("SELECT 1;", "BUSY", "a third estimate is refused without queuing behind blocked compilers");
                await Call("query.cancel", new CancelArgs(ids[0]));
                await Call("query.session.close", new SessionArgs(compilerSessions[1]));
                foreach (var read in reads)
                {
                    try { await read; check(false, "cancel held compiler"); }
                    catch (RequestException error) { check(error.Code == "CANCELLED", "held compiler cancellation settles"); }
                }
                check(opened.All(c => c.State == System.Data.ConnectionState.Closed), "cancel closes the unpooled physical compiler sessions");
            }
            finally
            {
                hold.TrySetResult(); service.Open = normalOpen;
                foreach (var id in ids) await Call("query.cancel", new CancelArgs(id));
                foreach (var read in reads) try { await read; } catch (RequestException) { }
            }
            await Estimate("SELECT 1;");
            check(true, "a subsequent estimate acquires a released slot");
        }
        finally
        {
            service.EstimatedPlanBudget = EstimatedPlanCapture.Budget;
            await RunSql("IF @@TRANCOUNT>0 ROLLBACK; DROP TABLE IF EXISTS " + lockTable + ";");
            await Call("query.session.close", new SessionArgs(session));
        }
    }
}
