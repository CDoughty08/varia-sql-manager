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
        var store = service.Results;
        var session = Guid.NewGuid().ToString();
        Task<object> Call(string method, object args) => service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<QueryResult> Run(string sql, string? sessionId = null, string database = "master", bool stopOnError = false, int timeout = 30, string? queryId = null) =>
            (QueryResult)await Call("query.execute", new QueryArgs(info.Id, sessionId ?? session, database, sql, queryId ?? Guid.NewGuid().ToString(), 1000, timeout, StopOnError: stopOnError));
        List<string> Texts(QueryResult result) => LiveResultChecks.Texts(result);
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

            // A session that never opened did not close: no "session closed" note, and the tab's next execution opens one.
            var missingTab = Guid.NewGuid().ToString();
            var missing = await Run("SELECT 1;", missingTab, database: "VariaDatabaseThatDoesNotExist");
            check(missing.Status == "failed" && missing.Error?.BatchNumber == 0 && missing.Error.Message.Contains("Msg 4060") && !Texts(missing).Contains(ClosedNote),
                "a session that failed to open is not reported as closed: " + string.Join(" | ", Texts(missing)));
            var recovered = await Options(missingTab);
            check(recovered == Defaults, "the tab's next execution opens its session with the prologue: " + recovered);
            await Call("query.session.close", new SessionArgs(missingTab));

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
            // Severity 17 to 19 errors reach SqlClient as exceptions; they end their batch, not the script.
            var severe = await Run("RAISERROR('sev18', 18, 1);\nGO\nPRINT 'next';");
            check(severe.Status == "completedWithErrors" && Texts(severe).SequenceEqual(["Msg 50000, Level 18, State 1, Line 1\nsev18", "Batch 1 raised an error; execution continued with the next batch.", "next"]),
                "a severity 18 error ends its batch and the next batch runs: " + string.Join(" | ", Texts(severe)));
            var after = await Options();
            check(after == Defaults, "the session survives batches that raised errors: " + after);

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
            }
            else Console.WriteLine("Severity 20 check skipped: the login is neither sysadmin nor granted ALTER TRACE.");

            // A line that starts with :: is T-SQL, not a SQLCMD command.
            var colons = await Run("SELECT TOP (1) name\nFROM\n::fn_helpcollations();\nGO\nSELECT geography\n::Point(1, 2, 4326).STAsText() AS p;");
            check(colons.Status == "completed" && colons.ResultSets.Count == 2 && LiveResultChecks.RowsOf(store, colons.ResultSets[1])[0][0] == "POINT (2 1)",
                "lines starting with :: run as T-SQL: " + (colons.Error?.Message ?? colons.Status));
        }
        finally { await Call("query.session.close", new SessionArgs(session)); }
    }
}
