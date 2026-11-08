using System.Text.Json;

namespace Varia.Backend.Tests;

/// <summary>Live checks of SSMS's execution semantics: the SET options a tab's session opens (and reopens) with, the next
/// GO batch running after one that raised an error, stopOnError, and what still ends a script (a cancel, the deadline, a
/// severity 20 error). Run only with VARIA_TEST_SQL_SERVER; every object is temporary.</summary>
internal static class ExecutionLiveChecks
{
    /// <summary>The options SSMS's query window sets, as the session reports them back.</summary>
    private const string OptionsQuery = "SELECT CONCAT('ARITHABORT=', CONVERT(int, SESSIONPROPERTY('ARITHABORT')), ' ANSI_NULLS=', CONVERT(int, SESSIONPROPERTY('ANSI_NULLS')),"
        + " ' ANSI_PADDING=', CONVERT(int, SESSIONPROPERTY('ANSI_PADDING')), ' ANSI_WARNINGS=', CONVERT(int, SESSIONPROPERTY('ANSI_WARNINGS')),"
        + " ' ANSI_NULL_DFLT_ON=', SIGN(@@OPTIONS & 1024), ' CONCAT_NULL_YIELDS_NULL=', CONVERT(int, SESSIONPROPERTY('CONCAT_NULL_YIELDS_NULL')),"
        + " ' QUOTED_IDENTIFIER=', CONVERT(int, SESSIONPROPERTY('QUOTED_IDENTIFIER')), ' NUMERIC_ROUNDABORT=', CONVERT(int, SESSIONPROPERTY('NUMERIC_ROUNDABORT')),"
        + " ' TEXTSIZE=', @@TEXTSIZE, ' sessions=', s.arithabort, s.ansi_nulls, s.ansi_padding, s.ansi_warnings, s.ansi_null_dflt_on, s.concat_null_yields_null,"
        + " s.quoted_identifier, ',', s.text_size) FROM sys.dm_exec_sessions AS s WHERE s.session_id = @@SPID;";
    private const string Defaults = "ARITHABORT=1 ANSI_NULLS=1 ANSI_PADDING=1 ANSI_WARNINGS=1 ANSI_NULL_DFLT_ON=1 CONCAT_NULL_YIELDS_NULL=1 QUOTED_IDENTIFIER=1"
        + " NUMERIC_ROUNDABORT=0 TEXTSIZE=2147483647 sessions=1111111,2147483647";

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        await PlanDiagnosticLiveChecks.RunAsync(check, service, info, json);
        await LivePlanLiveChecks.RunAsync(check, service, info, json);
        var store = service.Results;
        var session = Guid.NewGuid().ToString();
        Task<object> Call(string method, object args) => service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<QueryResult> Run(string sql, string? sessionId = null, string database = "master", bool stopOnError = false, int timeout = 30, string? queryId = null,
            bool includeActualPlan = false, int maxRows = 1000, int maxResultSets = 10) =>
            (QueryResult)await Call("query.execute", new QueryArgs(info.Id, sessionId ?? session, database, sql, queryId ?? Guid.NewGuid().ToString(), maxRows, timeout,
                StopOnError: stopOnError, IncludeActualPlan: includeActualPlan, MaxResultSets: maxResultSets));
        List<string> Texts(QueryResult result) => LiveResultChecks.Texts(result);
        bool MeasuresPlan(ResultDescriptor descriptor)
        {
            var text = LiveResultChecks.RowsOf(store, descriptor)[0][0];
            var set = store.Find(descriptor.ResultId);
            return text is not null && set?.CellSize(0, 0) is { Exact: true } size
                && size.Chars == text.Length && size.Bytes == 2L * text.Length && set.RowBytes(0, 1).SequenceEqual([size.Bytes]);
        }
        async Task<string?> Options(string? sessionId = null)
        {
            var result = await Run(OptionsQuery, sessionId);
            return result.Status == "completed" ? LiveResultChecks.RowsOf(store, result.ResultSets[0])[0][0] : result.Error?.Message;
        }
        const string ClosedNote = "The SQL session closed. The next execution opens a new session; previous SET options and temporary objects will be lost.";
        try
        {
            // SSMS's SET prologue: on open, kept across executions (a script's own SET wins), and again on every reopen.
            var opened = await Options();
            check(opened == Defaults, "a tab's session opens with SSMS's SET options: " + opened);
            var changed = await Run("SET ARITHABORT OFF; SET TEXTSIZE 100;");
            var kept = await Options();
            check(changed.Status == "completed" && kept is not null && kept.StartsWith("ARITHABORT=0 ") && kept.Contains(" TEXTSIZE=100 "),
                "the prologue runs only when the session opens, so a script's SET options persist across executions: " + kept);
            await Call("query.session.close", new SessionArgs(session));
            var reopened = await Options();
            check(reopened == Defaults, "a reopened session runs the prologue again: " + reopened);

            // The toolbar capture shares the executing session and keeps plans even after the grid limits are reached.
            var beforeCapture = await Run("CREATE TABLE #capture (n int); BEGIN TRAN;");
            var captured = await Run("INSERT #capture VALUES (42);\nGO\nSELECT n FROM #capture;\nGO\nSELECT n + 1 FROM #capture;",
                includeActualPlan: true, maxRows: 1, maxResultSets: 1);
            check(captured.Status == "completed" && captured.Spid == beforeCapture.Spid && captured.DiscardedResultSets == 1
                && captured.ResultSets is [{ Kind: "rows", RowsStored: 1 } data] && LiveResultChecks.RowsOf(store, data)[0][0] == "42"
                && captured.PlanSets is { } capturedPlans && capturedPlans.Select(set => set.BatchNumber).Distinct().SequenceEqual([1, 2, 3])
                && new[] { 1, 2, 3 }.All(batch => capturedPlans.Any(set => set.Kind == "executionPlan" && set.RowsStored == 1 && set.BatchNumber == batch
                    && LiveResultChecks.RowsOf(store, set)[0][0] is { } xml && xml.Contains("ShowPlanXML") && xml.Contains("RunTimeCountersPerThread"))),
                "toolbar capture returns actual plans in batch order outside the grid limits: " + string.Join(" | ", Texts(captured)));
            var afterCapture = await Run("SELECT @@TRANCOUNT, n FROM #capture; ROLLBACK; DROP TABLE #capture;");
            check(afterCapture.PlanSets is null && afterCapture.ResultSets is [{ Kind: "rows" } remaining]
                && LiveResultChecks.RowsOf(store, remaining)[0].SequenceEqual(["1", "42"]),
                "toolbar capture leaves the tab's transaction and temp table in place");

            QueryResult failedRead;
            service.PlanReadFault = () => new IOException("Varia live check: the collector stream broke.",
                ConnectionFailureChecks.Sql(0, 0, 20, "", "The transport closed."));
            try
            {
                failedRead = await Run("CREATE TABLE #collector_fault (n int); INSERT #collector_fault VALUES (42); SELECT n FROM #collector_fault;",
                    includeActualPlan: true);
            }
            finally { service.PlanReadFault = null; }
            check(failedRead.Status == "completed" && failedRead.PlanSets is null
                && failedRead.ResultSets is [{ RowsStored: 1 } retained] && LiveResultChecks.RowsOf(store, retained)[0][0] == "42"
                && Texts(failedRead).Contains("Actual plans could not be read from the Extended Events session."),
                "a collector stream failure preserves the completed execution and data grids");
            var afterReadFault = await Run("SELECT n FROM #collector_fault; DROP TABLE #collector_fault;");
            check(afterReadFault.Status == "completed" && afterReadFault.Spid == failedRead.Spid
                && afterReadFault.ResultSets is [{ RowsStored: 1 } reused] && LiveResultChecks.RowsOf(store, reused)[0][0] == "42",
                "the next execution reuses the same SQL session after a collector read failure");

            await Run("CREATE TABLE #capture_rowcount(n int);");
            const string InsertTwo = "INSERT #capture_rowcount VALUES (1), (2);";
            const string BranchOnRows = "IF @@ROWCOUNT = 2 PRINT 'two'; ELSE PRINT 'different';";
            await Run(InsertTwo);
            var beforeWithCapture = await Run(BranchOnRows, includeActualPlan: true);
            await Run(InsertTwo, includeActualPlan: true);
            var afterWithCapture = await Run(BranchOnRows);
            check(Texts(beforeWithCapture).Contains("two") && Texts(afterWithCapture).Contains("two"),
                "capture setup and collection preserve cross-execution @@ROWCOUNT");

            var zeroUpdate = await Run("UPDATE #capture_rowcount SET n = 1 WHERE n = -1;", includeActualPlan: true);
            check(zeroUpdate.PlanSets is [{ RowsStored: 1 }, ..] && zeroUpdate.RecordsAffected == 0 && Texts(zeroUpdate).SequenceEqual(["(0 rows affected)"]),
                "capture does not add a synthetic row count to a zero-row update (" + zeroUpdate.PlanSets?.Count + " plans, "
                + zeroUpdate.RecordsAffected + " affected): " + string.Join(" | ", Texts(zeroUpdate)));

            var aliased = await Run("SELECT 42 AS [Microsoft SQL Server 2005 XML Showplan];"
                + "SELECT CAST(REPLICATE(N'q', 3000) AS nvarchar(max)) AS [Microsoft SQL Server 2005 XML Showplan];", includeActualPlan: true);
            check(aliased.ResultSets is [{ Kind: "rows" } numeric, { Kind: "rows" } text]
                && LiveResultChecks.RowsOf(store, numeric)[0][0] == "42" && LiveResultChecks.RowsOf(store, text)[0][0] == new string('q', 3000),
                "ordinary values under the Showplan column alias keep their types and content in Results");

            const string QueryWithPlan = "SELECT name FROM sys.databases WHERE database_id = 1;";
            const string PairedQuery = "SELECT n FROM #capture_pair WHERE n < 3;";
            await Run("CREATE TABLE #capture_pair (n int PRIMARY KEY); INSERT #capture_pair VALUES (1),(2),(3),(4);");
            await Run(PairedQuery + "SELECT n FROM #capture_pair WHERE n < 4;");
            await Run("SET STATISTICS XML ON;");
            var manualCapture = await Run(PairedQuery + PairedQuery, includeActualPlan: true);
            var manualStillOn = await Run(PairedQuery);
            check(manualCapture.PlanSets is null
                && manualCapture.ResultSets is [{ Kind: "rows" }, { Kind: "executionPlan" }, { Kind: "rows" }, { Kind: "executionPlan" }]
                && manualStillOn.PlanSets is null && manualStillOn.ResultSets is [{ Kind: "rows" }, { Kind: "executionPlan" }],
                "two identical native executions remain distinct with one representation each: " + manualCapture.PlanSets?.Count
                + " additional captures, then " + string.Join(", ", manualStillOn.ResultSets.Select(set => set.Kind)) + " without the toggle");
            await Run("SET STATISTICS XML OFF;");
            var mixedCapture = await Run("SET STATISTICS XML ON; " + PairedQuery
                + " SET STATISTICS XML OFF; SELECT n FROM #capture_pair WHERE n < 4;", includeActualPlan: true);
            check(mixedCapture.PlanSets is [{ Kind: "executionPlan" } observerOnly]
                && LiveResultChecks.RowsOf(store, observerOnly)[0][0]?.Contains("ActualRows=\"3\"") == true
                && mixedCapture.ResultSets is [{ Kind: "rows" }, { Kind: "executionPlan" } native, { Kind: "rows" }]
                && mixedCapture.PlanOrder?.SequenceEqual([native.ResultId, observerOnly.ResultId]) == true,
                "the paired native result stays in Results and the distinct observer-only execution stays in Execution Plan: " + mixedCapture.PlanSets?.Count);
            check(mixedCapture.ResultSets.Concat(mixedCapture.PlanSets ?? []).Where(set => set.Kind == "executionPlan").Count(MeasuresPlan) == 2,
                "the stored native and observer plans report their full UTF-16 sizes, including the native plan's prefetched prefix");
            var reverseMixed = await Run("SELECT n FROM #capture_pair WHERE n < 4; SET STATISTICS XML ON; "
                + PairedQuery + " SET STATISTICS XML OFF;", includeActualPlan: true);
            check(reverseMixed.PlanSets is [{ Kind: "executionPlan" } firstPlan]
                && reverseMixed.ResultSets is [{ Kind: "rows" }, { Kind: "rows" }, { Kind: "executionPlan" } lastPlan]
                && reverseMixed.PlanOrder?.SequenceEqual([firstPlan.ResultId, lastPlan.ResultId]) == true,
                "within one batch, the observer-only execution can also precede the paired native result");
            var gridLimitedCapture = await Run("SET STATISTICS XML ON; " + PairedQuery + " SET STATISTICS XML OFF;",
                includeActualPlan: true, maxResultSets: 1);
            check(gridLimitedCapture.ResultSets is [{ Kind: "rows" }] && gridLimitedCapture.DiscardedResultSets == 1
                && gridLimitedCapture.PlanSets is [{ Kind: "executionPlan", RowsStored: 1 }, ..],
                "the collector copy is kept when the grid limit discarded the manual plan");

            await Run("CREATE TABLE #cold_capture (n int PRIMARY KEY); INSERT #cold_capture VALUES (1),(2),(3),(4);\nGO\n"
                + "CREATE PROCEDURE #cold_capture_proc AS BEGIN SELECT n FROM #cold_capture WHERE n < 3; SELECT n FROM #cold_capture WHERE n < 4; END;");
            var cold = await Run("SET STATISTICS XML ON; EXEC #cold_capture_proc; SET STATISTICS XML OFF;", includeActualPlan: true);
            check(cold.Status == "completed" && cold.PlanSets is null
                && cold.ResultSets is [{ Kind: "rows", RowsStored: 2 }, { Kind: "executionPlan" }, { Kind: "rows", RowsStored: 3 }, { Kind: "executionPlan" }],
                "a cold procedure keeps its two user plans without exposing automatic statistics: " + cold.PlanSets?.Count + " additional plans");
            var namedStatman = await Run("SELECT n AS STATMAN FROM #cold_capture WHERE n < 3;", includeActualPlan: true);
            check(namedStatman.Status == "completed" && namedStatman.PlanSets is [{ RowsStored: 1 }]
                && namedStatman.ResultSets is [{ Columns: [{ Name: "STATMAN" }], RowsStored: 2 }],
                "a user statement with a STATMAN column name still returns its actual plan");

            var timedCapture = await Run(QueryWithPlan + "\nGO\nWAITFOR DELAY '00:00:10';", timeout: 2, includeActualPlan: true);
            var afterTimeout = await Run(QueryWithPlan);
            check(timedCapture.Status == "timedOut" && timedCapture.PlanSets?.Any(set => set is { BatchNumber: 1, RowsStored: 1 }) == true
                && afterTimeout.PlanSets is null && afterTimeout.ResultSets is [{ Kind: "rows" }],
                "timeout keeps completed plans and leaves the session ready to reuse: " + timedCapture.Status
                + ", plans in batches " + string.Join(", ", timedCapture.PlanSets?.Select(set => set.BatchNumber) ?? [])
                + ", next " + afterTimeout.Status + " with " + afterTimeout.ResultSets.Count + " results. " + string.Join(" | ", Texts(timedCapture)));

            await Run(QueryWithPlan + "\nGO\nSET NOEXEC ON;", includeActualPlan: true);
            var noExecOff = await Run("SET NOEXEC OFF;\nGO\n" + QueryWithPlan);
            var afterNoExec = await Run(QueryWithPlan);
            check(noExecOff.Status == "completed" && noExecOff.PlanSets is null && noExecOff.ResultSets is [{ Kind: "rows" }]
                && afterNoExec.PlanSets is null && afterNoExec.ResultSets is [{ Kind: "rows" }],
                "a captured run that leaves NOEXEC on does not leak plan result sets into later grids");

            if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") == "1") await SweepsOrphans(check, Run, store, QueryWithPlan, tab => Call("query.session.close", new SessionArgs(tab)));

            // A session that never opened did not close: no "session closed" note, and the tab's next execution opens one.
            var missingTab = Guid.NewGuid().ToString();
            var missing = await Run("SELECT 1;", missingTab, database: "VariaDatabaseThatDoesNotExist");
            check(missing.Status == "failed" && missing.Error?.BatchNumber == 0 && missing.Error.Message.Contains("Msg 4060") && !Texts(missing).Contains(ClosedNote),
                "a session that failed to open is not reported as closed: " + string.Join(" | ", Texts(missing)));
            var recovered = await Options(missingTab);
            check(recovered == Defaults, "the tab's next execution opens its session with the prologue: " + recovered);
            await Call("query.session.close", new SessionArgs(missingTab));

            // A session whose prologue fails is closed, so the tab's next execution opens one and runs the prologue instead
            // of running scripts without SSMS's settings.
            var failingTab = Guid.NewGuid().ToString();
            QueryResult unprepared;
            service.Prologue = "SET ARITHABORT OFF; SET TEXTSIZE 100; RAISERROR('Varia live check: the prologue failed.', 16, 1);";
            try { unprepared = await Run("PRINT 'SHOULD_NOT_RUN';", failingTab); }
            finally { service.Prologue = SqlService.SessionPrologue; }
            check(unprepared.Status == "failed" && unprepared.Error?.BatchNumber == 0 && unprepared.Error.Message.Contains("the prologue failed")
                && !Texts(unprepared).Contains("SHOULD_NOT_RUN") && !Texts(unprepared).Contains(ClosedNote),
                "a failed prologue fails the execution before any batch: " + string.Join(" | ", Texts(unprepared)));
            var prepared = await Options(failingTab);
            check(prepared == Defaults, "a session whose prologue failed is not reused; the next execution runs the prologue: " + prepared);
            await Call("query.session.close", new SessionArgs(failingTab));

            // Like SSMS, the next GO batch runs after one that raised an error; each batch's errors stay in Messages in order,
            // with a line saying that execution continued, and the run reports that errors occurred.
            const string script = "PRINT 'one';\nGO\nRAISERROR('sev16', 16, 1);\nPRINT 'after';\nGO\nSELECT 3 AS three;\nGO\nSELECT 4 AS four; SELECT 1/0 AS boom;\nGO\nPRINT 'last';";
            var continued = await Run(script);
            var texts = Texts(continued);
            check(continued.Status == "completedWithErrors" && continued.CompletedBatches == 5 && continued.TotalBatches == 5
                && texts.SequenceEqual(["one", "Msg 50000, Level 16, State 1, Line 3\nsev16", "after", "Batch 2 raised an error; execution continued with the next batch.", "(1 row affected)",
                    "(1 row affected)", "Msg 8134, Level 16, State 1, Line 8\nDivide by zero error encountered.", "Batch 4 raised an error; execution continued with the next batch.", "last"]),
                "batches after an error still run, and Messages keep every batch's errors in order: " + string.Join(" | ", texts));
            check(continued.Error is { Code: "SQL_ERROR", BatchNumber: 2, Iteration: 1 } && continued.Error.Message.StartsWith("Msg 50000, Level 16, State 1, Line 3\nsev16")
                && continued.Error.Message.Contains("Msg 8134"), "the summary's error holds every batch's errors and names the first batch that raised one");
            var sets = continued.ResultSets.Select(set => (set.Columns[0].Name, set.BatchNumber)).ToList();
            check(sets.Take(2).SequenceEqual([("three", 3), ("four", 4)]) && sets.Skip(2).All(set => set == ("boom", 4))
                && LiveResultChecks.RowsOf(store, continued.ResultSets[1])[0][0] == "4",
                "result sets keep their batch numbers in order, a failed batch's sets included: " + string.Join(", ", sets));
            var repeated = await Run("SELECT 1/0;\nGO 2\nPRINT 'end';");
            check(repeated.Status == "completedWithErrors" && repeated.CompletedBatches == 3 && Texts(repeated).Where(text => text.StartsWith("Batch ")).SequenceEqual([
                    "Batch 1, repetition 1, raised an error; execution continued with the next repetition.", "Batch 1, repetition 2, raised an error; execution continued with the next batch."])
                && Texts(repeated)[^1] == "end", "GO n repetitions continue after an error, and the line names the repetition: " + string.Join(" | ", Texts(repeated)));
            var lastOnly = await Run("PRINT 'a';\nGO\nSELECT 1/0;");
            check(lastOnly.Status == "completedWithErrors" && lastOnly.CompletedBatches == 2 && !Texts(lastOnly).Any(text => text.StartsWith("Batch ")),
                "an error in the last batch adds no line about continuing");
            // Severity 17 to 19 errors reach SqlClient as exceptions; the script goes on with the next batch.
            var severe = await Run("RAISERROR('sev18', 18, 1);\nGO\nPRINT 'next';");
            check(severe.Status == "completedWithErrors" && severe.CompletedBatches == 2 && Texts(severe).SequenceEqual(["Msg 50000, Level 18, State 1, Line 1\nsev18", "Batch 1 raised an error; execution continued with the next batch.", "next"]),
                "a severity 18 error ends its batch and the next batch runs: " + string.Join(" | ", Texts(severe)));
            // SQL Server does not stop a batch at them, and no attention follows them, so the batch's later statements run (even
            // after a wait, which an attention would have cut short) and it counts as completed.
            var ranOn = await Run("CREATE TABLE #sev (n int);\nGO\nSELECT 1 AS a; RAISERROR('sev18', 18, 1); WAITFOR DELAY '00:00:01'; INSERT #sev VALUES (1);\nGO\nSELECT COUNT(*) AS c FROM #sev; DROP TABLE #sev;");
            check(ranOn.Status == "completedWithErrors" && ranOn.CompletedBatches == 3 && ranOn.ResultSets.Count == 2 && LiveResultChecks.RowsOf(store, ranOn.ResultSets[1])[0][0] == "1",
                "a batch with a severity 18 error runs to its end on the server: " + string.Join(", ", ranOn.ResultSets.Select(set => set.Columns[0].Name)));
            // After the batch's first result set, SqlClient raises a severity 17 to 19 error where SQL Server sent it and keeps
            // the reader, so the batch's later result sets and messages follow it in order, as SSMS shows them.
            var ordered = await Run("SELECT 1 AS a; PRINT 'p1'; RAISERROR('sev18', 18, 1); PRINT 'p2'; SELECT 2 AS b; RAISERROR('sev17', 17, 1); SELECT 3 AS c; PRINT 'p3';\nGO\nPRINT 'next';");
            check(ordered.Status == "completedWithErrors" && ordered.CompletedBatches == 2 && ordered.TotalBatches == 2
                && ordered.ResultSets.Select(set => set.Columns[0].Name + set.BatchNumber).SequenceEqual(["a1", "b1", "c1"]) && ordered.ResultSets.All(set => !set.Incomplete)
                && LiveResultChecks.RowsOf(store, ordered.ResultSets[2])[0][0] == "3",
                "result sets after a severity 17 or 18 error in the same batch are shown, in order: " + string.Join(", ", ordered.ResultSets.Select(set => set.Columns[0].Name + set.BatchNumber)));
            check(Texts(ordered).SequenceEqual(["(1 row affected)", "p1", "Msg 50000, Level 18, State 1, Line 1\nsev18", "p2", "(1 row affected)", "Msg 50000, Level 17, State 1, Line 1\nsev17",
                    "(1 row affected)", "p3", "Batch 1 raised an error; execution continued with the next batch.", "next"])
                && ordered.Error is { Code: "SQL_ERROR", BatchNumber: 1 } && ordered.Error.Message.Contains("sev18") && ordered.Error.Message.Contains("sev17"),
                "messages after a severity 17 or 18 error keep their order around it: " + string.Join(" | ", Texts(ordered)));
            // Before the batch's first result set SqlClient cannot do that: ExecuteReader reads the rest of the batch, discarding
            // its result sets and delivering its messages, and only then raises the error (README, docs/ipc.md). SQL Server still
            // ran the whole batch. This pins SqlClient 7.1's behaviour; a SqlClient that changes it fails here.
            var early = await Run("PRINT 'p1'; RAISERROR('sev18', 18, 1); PRINT 'p2'; SELECT 2 AS b; PRINT 'p3';\nGO\nPRINT 'next';");
            check(early.Status == "completedWithErrors" && early.CompletedBatches == 2 && early.ResultSets.Count == 0
                && Texts(early).SequenceEqual(["p1", "p2", "(1 row affected)", "p3", "Msg 50000, Level 18, State 1, Line 1\nsev18", "Batch 1 raised an error; execution continued with the next batch.", "next"]),
                "before a batch's first result set, a severity 18 error comes after the batch's messages (its SELECT counted, but its rows lost) (SqlClient): " + string.Join(" | ", Texts(early)));
            // Partway through a result set's rows (a resource error such as 701, which no statement raises on demand, so the
            // backend's row hook throws what SqlClient would): the set ends as incomplete with the rows read so far, and the
            // batch's later messages and result sets still follow it in order.
            var rowsRead = 0;
            service.RowFault = () => ++rowsRead == 2 ? ConnectionFailureChecks.Sql(701, 1, 17, "", "Varia live check: there is insufficient system memory.") : null;
            QueryResult midSet;
            try { midSet = await Run("SELECT n FROM (VALUES (1), (2), (3)) AS v (n); PRINT 'p1'; SELECT 2 AS b;\nGO\nPRINT 'next';"); }
            finally { service.RowFault = null; }
            var midTexts = Texts(midSet);
            var faulted = midTexts.FindIndex(text => text.StartsWith("Msg 701, Level 17,"));
            check(midSet.Status == "completedWithErrors" && midSet.CompletedBatches == 2 && midSet.ResultSets.Select(set => set.Columns[0].Name).SequenceEqual(["n", "b"])
                && midSet.ResultSets[0] is { Incomplete: true, State: "complete", RowsStored: 1 } && midSet.ResultSets[1] is { Incomplete: false, State: "complete" }
                && LiveResultChecks.RowsOf(store, midSet.ResultSets[1])[0][0] == "2"
                && faulted >= 0 && midTexts.IndexOf("p1") > faulted && midTexts[^2] == "Batch 1 raised an error; execution continued with the next batch." && midTexts[^1] == "next",
                "a severity 17 error partway through a result set leaves it incomplete, and the batch's later output follows in order: "
                + string.Join(", ", midSet.ResultSets.Select(set => set.Columns[0].Name + (set.Incomplete ? "*" : "") + set.State)) + " | " + string.Join(" | ", midTexts));
            var after = await Options();
            check(after == Defaults, "the session survives batches that raised errors: " + after);
            // Managed SNI can raise a fatal transport error (a KILL from another tab, say) before its asynchronous close
            // updates Connection.State; the row hook raises one while the connection still reads Open. The script must end the
            // session there and say so, not report the dead session's SPID and keep it for the next execution to find lost.
            var doomed = Guid.NewGuid().ToString();
            var doomedOpen = await Run("SELECT 1;", doomed);
            service.RowFault = () => ConnectionFailureChecks.Sql(0, 0, 20, "", "Varia live check: a transport-level error has occurred.");
            QueryResult severed;
            try { severed = await Run("SELECT n FROM (VALUES (1), (2)) AS v (n);\nGO\nPRINT 'SHOULD_NOT_RUN';", doomed); }
            finally { service.RowFault = null; }
            string? severedState = null;
            try { await Call("query.session.state", new SessionStateArgs(doomed)); }
            catch (RequestException error) { severedState = error.Code; }
            check(doomedOpen.Spid > 0 && severed.Status == "failed" && severed.Spid is null && severed.Login is null && Texts(severed).Contains(ClosedNote)
                && !Texts(severed).Contains("SHOULD_NOT_RUN") && severedState == "SESSION_CLOSED",
                "a fatal error while the connection still reads open ends the session with the script, without its SPID: " + severed.Spid + ", " + severedState + " | " + string.Join(" | ", Texts(severed)));
            var renewed = await Run("SELECT 1;", doomed);
            check(renewed.Status == "completed" && renewed.Spid > 0, "the next execution in that tab opens a new session rather than answering SESSION_LOST: " + renewed.Status);
            await Call("query.session.close", new SessionArgs(doomed, null));

            // stopOnError keeps the stop-at-first-error policy (SQLCMD's :on error exit).
            var stopped = await Run(script, stopOnError: true);
            check(stopped.Status == "failed" && stopped.CompletedBatches == 1 && stopped.ResultSets.Count == 0 && stopped.Error is { Code: "SQL_ERROR", BatchNumber: 2 }
                && Texts(stopped).SequenceEqual(["one", "Msg 50000, Level 16, State 1, Line 3\nsev16", "after", "Batch 2 raised an error; later batches were not executed."]),
                "stopOnError stops at the first batch that raised an error: " + string.Join(" | ", Texts(stopped)));

            // Never after a cancel or the deadline, even when an earlier batch raised an error.
            var slowId = Guid.NewGuid().ToString();
            var slow = Run("SELECT 1/0;\nGO\nWAITFOR DELAY '00:00:10';\nGO\nPRINT 'SHOULD_NOT_RUN';", queryId: slowId);
            await Task.Delay(800);
            await Call("query.cancel", new CancelArgs(slowId));
            var cancelled = await slow;
            check(cancelled.Status == "cancelled" && cancelled.CompletedBatches == 1 && !Texts(cancelled).Contains("SHOULD_NOT_RUN")
                && cancelled.Error!.Message.StartsWith("The script was cancelled.") && cancelled.Error.Message.Contains("Msg 8134"),
                "a cancel ends the script even after a batch that raised an error: " + string.Join(" | ", Texts(cancelled)));
            // A batch streaming info messages stops where the Stop finds it: SqlClient's cancel from another thread would wait
            // for the loop to end, so the INSERT after it would run although the script reports cancelled.
            var probeTab = Guid.NewGuid().ToString();
            try
            {
                await Run("CREATE TABLE #VariaStopProbe (n int);", probeTab);
                string? Probed(QueryResult probe) => probe.Status == "completed" ? LiveResultChecks.RowsOf(store, probe.ResultSets[0])[0][0] : probe.Error?.Message;
                var floodId = Guid.NewGuid().ToString();
                var flood = Run("DECLARE @until datetime2 = DATEADD(second, 20, SYSDATETIME());\nWHILE SYSDATETIME() < @until RAISERROR (N'Varia live check: heartbeat', 0, 1) WITH NOWAIT;\nINSERT #VariaStopProbe VALUES (1);",
                    probeTab, queryId: floodId);
                await Task.Delay(800);
                var stopWatch = System.Diagnostics.Stopwatch.StartNew();
                await Call("query.cancel", new CancelArgs(floodId));
                var flooded = await flood;
                stopWatch.Stop();
                var afterFlood = Probed(await Run("SELECT COUNT(*) FROM #VariaStopProbe;", probeTab));
                check(flooded.Status == "cancelled" && Texts(flooded).Contains("Varia live check: heartbeat") && afterFlood == "0",
                    "a Stop ends a batch that streams info messages before its later statements run: " + flooded.Status + ", " + afterFlood + " rows, " + stopWatch.ElapsedMilliseconds + " ms");
                // A Stop that overtakes its query.execute (main relays both at once) still stops it: nothing runs.
                var earlyId = Guid.NewGuid().ToString();
                await Call("query.cancel", new CancelArgs(earlyId));
                var overtaken = await Run("INSERT #VariaStopProbe VALUES (2);", probeTab, queryId: earlyId);
                var afterEarly = Probed(await Run("SELECT COUNT(*) FROM #VariaStopProbe;", probeTab));
                check(overtaken.Status == "cancelled" && overtaken.CompletedBatches == 0 && afterEarly == "0",
                    "a Stop that reaches the backend before its query runs nothing: " + overtaken.Status + ", " + afterEarly + " rows");
            }
            finally { await Call("query.session.close", new SessionArgs(probeTab)); }
            var expired = await Run("SELECT 1/0;\nGO\nWAITFOR DELAY '00:00:10';\nGO\nPRINT 'SHOULD_NOT_RUN';", timeout: 1);
            check(expired.Status == "timedOut" && expired.CompletedBatches == 1 && !Texts(expired).Contains("SHOULD_NOT_RUN"),
                "the deadline ends the script even after a batch that raised an error");

            // A severity 20 error closes the session: nothing more runs, and the next execution reopens it with the prologue.
            var allowed = await Run("SELECT CONVERT(int, IS_SRVROLEMEMBER('sysadmin')) + HAS_PERMS_BY_NAME(NULL, NULL, 'ALTER TRACE');");
            if (allowed.Status == "completed" && LiveResultChecks.RowsOf(store, allowed.ResultSets[0])[0][0] is not (null or "0"))
            {
                var fatal = await Run("SET ARITHABORT OFF;\nGO\nRAISERROR('Varia live check: severity 20 closes the session.', 20, 1) WITH LOG;\nGO\nPRINT 'SHOULD_NOT_RUN';");
                check(fatal.Status == "failed" && fatal.CompletedBatches == 1 && !Texts(fatal).Contains("SHOULD_NOT_RUN") && Texts(fatal).Contains(ClosedNote)
                    && !Texts(fatal).Any(text => text.Contains("execution continued")),
                    "a severity 20 error that closes the session ends the script: " + string.Join(" | ", Texts(fatal)));
                var restored = await Options();
                check(restored == Defaults, "the session reopened after a severity 20 error has SSMS's SET options again: " + restored);
                // Still so after the batch's first result set, where severity 17 to 19 errors let the batch go on.
                var fatalLater = await Run("SELECT 1 AS a; RAISERROR('Varia live check: severity 20 closes the session.', 20, 1) WITH LOG; SELECT 2 AS b;\nGO\nPRINT 'SHOULD_NOT_RUN';");
                check(fatalLater.Status == "failed" && fatalLater.CompletedBatches == 0 && fatalLater.ResultSets.Select(set => set.Columns[0].Name).SequenceEqual(["a"])
                    && !Texts(fatalLater).Contains("SHOULD_NOT_RUN") && Texts(fatalLater).Contains(ClosedNote),
                    "a severity 20 error after a result set still ends the script: " + string.Join(" | ", Texts(fatalLater)));
                check(await Options() == Defaults, "the session reopens after it");
            }
            else Console.WriteLine("Severity 20 check skipped: the login is neither sysadmin nor granted ALTER TRACE.");

            // A line that starts with :: is T-SQL, not a SQLCMD command.
            var colons = await Run("SELECT TOP (1) name\nFROM\n::fn_helpcollations();\nGO\nSELECT geography\n::Point(1, 2, 4326).STAsText() AS p;");
            check(colons.Status == "completed" && colons.ResultSets.Count == 2 && LiveResultChecks.RowsOf(store, colons.ResultSets[1])[0][0] == "POINT (2 1)",
                "lines starting with :: run as T-SQL: " + (colons.Error?.Message ?? colons.Status));
        }
        finally { await Call("query.session.close", new SessionArgs(session)); }
    }

    /// <summary>A capture's start drops the Extended Events sessions that captures left when their backend died (scratch only:
    /// it creates server-level sessions, dropped in finally): one named for a connection that is gone goes, while one named
    /// for a live connection, and one an older build named with a random GUID, stay.</summary>
    private static async Task SweepsOrphans(Action<bool, string> check, Func<string, string?, string, bool, int, string?, bool, int, int, Task<QueryResult>> run,
        Results.ResultStore store, string queryWithPlan, Func<string, Task<object>> close)
    {
        var keeper = Guid.NewGuid().ToString();
        var setup = Guid.NewGuid().ToString();
        var own = await run("SELECT CONVERT(nchar(36), connection_id) FROM sys.dm_exec_connections WHERE session_id = @@SPID;", keeper, "master", false, 30, null, false, 1000, 10);
        var live = Plans.ActualPlanSql.NameFor(Guid.Parse(LiveResultChecks.RowsOf(store, own.ResultSets[0])[0][0]!));
        var orphan = Plans.ActualPlanSql.NameFor(Guid.NewGuid());
        var legacy = Plans.ActualPlanSql.Prefix + Guid.NewGuid().ToString("N");
        string[] names = [orphan, live, legacy];
        static string Create(string name) => "CREATE EVENT SESSION [" + name + "] ON SERVER ADD EVENT sqlserver.sql_batch_starting(SET collect_batch_text=(0) WHERE ([sqlserver].[session_id]=(0)));\n";
        var listed = "SELECT name FROM sys.server_event_sessions WHERE name IN (" + string.Join(", ", names.Select(name => "N'" + name + "'")) + ") ORDER BY name;";
        try
        {
            var made = await run(string.Concat(names.Select(Create)), setup, "master", false, 30, null, false, 1000, 10);
            var captured = await run(queryWithPlan, null, "master", false, 30, null, true, 1000, 10);
            var left = await run(listed, setup, "master", false, 30, null, false, 1000, 10);
            var kept = LiveResultChecks.RowsOf(store, left.ResultSets[0]).Select(row => row[0]).ToList();
            check(made.Status == "completed" && captured.Status == "completed" && captured.PlanSets is [{ RowsStored: 1 }]
                && kept.Order(StringComparer.Ordinal).SequenceEqual(new[] { live, legacy }.Order(StringComparer.Ordinal)),
                "an actual plan capture drops a session an earlier capture left for a closed connection, and keeps a live connection's and an older build's: "
                + made.Status + ", " + captured.Status + ", left " + kept.Count + " of 3 (" + string.Join(" | ", LiveResultChecks.Texts(captured)) + ")");
        }
        finally
        {
            await run(string.Concat(names.Select(name => "IF EXISTS (SELECT 1 FROM sys.server_event_sessions WHERE name = N'" + name + "') DROP EVENT SESSION [" + name + "] ON SERVER;\n")),
                setup, "master", false, 30, null, false, 1000, 10);
            await close(setup);
            await close(keeper);
        }
    }
}
