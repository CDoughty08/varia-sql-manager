using System.Text.Json;

namespace Varia.Backend.Tests;

/// <summary>Named result sets against a server (docs/named-result-sets-scope.md): what the parse cannot know is checked here,
/// in the stream SQL Server sends. A multi-set EXEC, an error between two sets (seen before the second set opens, PR 1's first
/// measurement), GO 3, SET STATISTICS XML ON and PROFILE ON, a permission failure, and a trigger's set caught by the column
/// count. Run only with VARIA_TEST_SQL_SERVER; the trigger's table lives in a transaction that is rolled back.</summary>
internal static class ResultNameLiveChecks
{
    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var session = Guid.NewGuid().ToString();
        async Task<QueryResult> Run(string sql, string database = "tempdb", int timeoutSeconds = 30, bool stopOnError = false) =>
            (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(new QueryArgs(info.Id, session, database, sql, Guid.NewGuid().ToString(), 1000, timeoutSeconds,
                MaxResultSets: 100, StopOnError: stopOnError), json), json);
        static string Names(QueryResult result) => string.Join(", ", result.ResultSets.Select(set => (set.Kind == "rows" ? "" : set.Kind + ":") + (set.Name ?? "-")));
        static List<string> Notes(QueryResult result) => [.. result.Messages.Where(message => message.Text.StartsWith("Result name", StringComparison.Ordinal)).Select(message => message.Text)];
        static string Show(QueryResult result) => Names(result) + " | " + string.Join(" / ", LiveResultChecks.Texts(result));
        try
        {
            // The user's SQL reaches the server as written: the marker is a comment the server sees too.
            var sample = await Run("/* #Name=\"Sample Query\" */\nSELECT @@SERVERNAME AS server_name, DB_NAME() AS database_name, SYSDATETIME() AS server_time;\n\nSELECT name FROM sys.databases WHERE database_id = 1;");
            check(sample.Status == "completed" && Names(sample) == "Sample Query, -" && Notes(sample).Count == 0, "a named SELECT and an unnamed one: " + Show(sample));
            var text = await Run("-- #Name=\"Text\"\nSELECT t.text FROM sys.dm_exec_requests AS r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) AS t WHERE r.session_id = @@SPID;");
            check(text.ResultSets is [{ Name: "Text" } own] && LiveResultChecks.RowsOf(service.Results, own)[0][0]?.StartsWith("-- #Name=\"Text\"", StringComparison.Ordinal) == true,
                "the batch the server runs is the user's text, marker comment included: " + Show(text));

            // A multi-set EXEC: stacked markers name its sets in order; a marker past its last set is noted, not applied.
            var exec = await Run("-- #Name=\"Order\"\n-- #Name=\"Lines\"\n-- #Name=\"Totals\"\n-- #Name=\"Spare\"\nEXEC sp_executesql N'SELECT 1 AS a; SELECT 2 AS b, 3 AS c; SELECT 4 AS d;';");
            check(exec.Status == "completed" && Names(exec) == "Order, Lines, Totals" && Notes(exec) is [var spare]
                && spare == "Result name \"Spare\" (line 4) is unused: its statement returned fewer result sets than there are names.", "stacked markers name an EXEC's sets in order: " + Show(exec));

            // An error between two sets arrives before the second set opens, so no name after it is applied.
            var raised = await Run("-- #Name=\"A\"\nSELECT 1 AS a;\nRAISERROR('Varia live check', 16, 1);\n-- #Name=\"B\"\nSELECT 2 AS b;");
            check(raised.Status == "completedWithErrors" && Names(raised) == "A, -" && Notes(raised) is [var afterError]
                && afterError == "Result name \"B\" (line 4) was not applied: an error earlier in its batch made the place of its result set unknown.",
                "after an error between two sets, the second is not named: " + Show(raised));
            // A statement that fails while it runs has opened its set first; the stop rule still holds after it.
            var divided = await Run("-- #Name=\"A\"\nSELECT 1 AS a;\nSELECT 1 / 0 AS z;\n-- #Name=\"B\"\nSELECT 2 AS b;");
            check(divided.Status == "completedWithErrors" && Names(divided) == "A, -, -" && Notes(divided).Count == 1, "a run-time error stops naming for the rest of its batch: " + Show(divided));
            // A permission failure ends its statement, not its batch, and returns no set: every count after it would be one off.
            var denied = await Run("-- #Name=\"Before\"\nSELECT 1 AS a;\nEXECUTE AS USER = 'guest';\n-- #Name=\"Waits\"\nSELECT TOP (1) wait_type FROM sys.dm_os_wait_stats;\nREVERT;\n-- #Name=\"After\"\nSELECT 2 AS b;");
            check(denied.Status == "completedWithErrors" && Names(denied) == "Before, -" && Notes(denied) is [var waits, var after]
                && waits.StartsWith("Result name \"Waits\" (line 4) was not applied: an error", StringComparison.Ordinal) && after.StartsWith("Result name \"After\" (line 7) was not applied: an error", StringComparison.Ordinal),
                "after a permission failure neither the failed statement's name nor a later one is applied: " + Show(denied));
            // The next batch starts its own count.
            var nextBatch = await Run("SELECT 1 / 0 AS z;\nGO\n-- #Name=\"Fresh\"\nSELECT 2 AS b;");
            check(Names(nextBatch) == "-, Fresh", "an error in one batch does not stop names in the next: " + Show(nextBatch));

            // SET NOEXEC ON in one batch and OFF in the next: SQL Server skips the second batch's first SELECT without an error,
            // so the set that arrives first is the second SELECT's. No name in a batch with SET NOEXEC is applied.
            var noexec = await Run("SET NOEXEC ON;\nGO\n-- #Name=\"A\"\nSELECT 1 AS a;\nSET NOEXEC OFF;\n-- #Name=\"B\"\nSELECT 2 AS b;");
            check(noexec.Status == "completed" && noexec.ResultSets is [{ Name: null } skipped] && skipped.Columns[0].Name == "b" && Notes(noexec) is [var noexecA, var noexecB]
                && noexecA.Contains("SET NOEXEC statement on line 5", StringComparison.Ordinal) && noexecB.StartsWith("Result name \"B\"", StringComparison.Ordinal),
                "a set after SET NOEXEC skipped a statement does not take that statement's name: " + Show(noexec));
            // A timeout ends the run inside a batch: the names its batch never reached are still noted.
            var timedOut = await Run("-- #Name=\"A\"\nSELECT 1 AS a;\nWAITFOR DELAY '00:00:10';\n-- #Name=\"B\"\nSELECT 2 AS b;", timeoutSeconds: 1);
            check(timedOut.Status == "timedOut" && Names(timedOut) == "A" && Notes(timedOut) is [var cut]
                && cut == "Result name \"B\" (line 4) was not applied: its batch stopped before its result set arrived.", "a run that times out notes the names its batch did not reach: " + Show(timedOut));

            // An error that ends the script (stopOnError): the names in the batches it never ran are noted too.
            var ended = await Run("SELECT 1 / 0 AS z;\nGO\n-- #Name=\"B\"\nSELECT 2 AS b;", stopOnError: true);
            check(ended.Status == "failed" && Notes(ended) is [var unreached] && unreached == "Result name \"B\" (line 3) was not applied: the run ended before its batch ran.",
                "a script an error ends notes the names in the batches it did not run: " + Show(ended));
            var endedRepeat = await Run("-- #Name=\"X\"\nSELECT 1 / 0 AS z;\nGO 3", stopOnError: true);
            check(endedRepeat.Status == "failed" && Names(endedRepeat) == "X" && Notes(endedRepeat) is [var laterRepetitions]
                && laterRepetitions == "Result name \"X\" (line 1) was not applied: the run ended before repetitions 2 to 3 ran.", "a script an error ends notes the repetitions it did not run: " + Show(endedRepeat));

            // GO 3: the batch is parsed once and each repetition's set is named.
            var repeated = await Run("-- #Name=\"Repeated\"\nSELECT 1 AS a;\nGO 3");
            check(repeated.Status == "completed" && Names(repeated) == "Repeated, Repeated, Repeated" && repeated.ResultSets.Select(set => set.Iteration).SequenceEqual([1, 2, 3]) && Notes(repeated).Count == 0,
                "each GO 3 repetition names its set: " + Show(repeated));

            // SET STATISTICS XML ON: plan sets are left out of the count and not named.
            // (A SELECT of constants has no plan, so these read a catalog view.)
            var xml = await Run("SET STATISTICS XML ON;\n-- #Name=\"Rows A\"\nSELECT TOP (1) name AS a FROM sys.objects;\n-- #Name=\"Rows B\"\nSELECT TOP (1) object_id AS b, name FROM sys.objects;\nSET STATISTICS XML OFF;");
            check(xml.Status == "completed" && Names(xml) == "Rows A, executionPlan:-, Rows B, executionPlan:-" && Notes(xml).Count == 0, "with STATISTICS XML the rows keep their names: " + Show(xml));
            // SET STATISTICS PROFILE ON adds row-shaped sets the parse cannot count: they stop binding.
            var profile = await Run("SET STATISTICS PROFILE ON;\n-- #Name=\"First\"\nSELECT * FROM (VALUES (1)) AS v (a);\n-- #Name=\"Second\"\nSELECT * FROM (VALUES (2)) AS v (b);\nSET STATISTICS PROFILE OFF;");
            check(profile.Status == "completed" && profile.ResultSets.Count == 4 && Names(profile) == "First, -, -, -" && Notes(profile) is [var second]
                && second.Contains("SHOWPLAN or STATISTICS PROFILE output", StringComparison.Ordinal), "STATISTICS PROFILE's sets stop naming: " + Show(profile));

            // A trigger that returns rows: its set comes first and nothing in the stream tells it apart (PR 1's third measurement).
            // The column count catches it when the named statement selects another number of columns; with the same count it is
            // a documented limit.
            var table = "VariaNames_" + Guid.NewGuid().ToString("N")[..8];
            var trigger = await Run($"BEGIN TRANSACTION;\nCREATE TABLE dbo.{table} (id int);\nINSERT dbo.{table} VALUES (1);\nGO\nCREATE TRIGGER dbo.{table}_t ON dbo.{table} AFTER UPDATE AS SELECT 'trigger' AS t, 1 AS u;\nGO\n"
                + $"UPDATE dbo.{table} SET id = 2;\n-- #Name=\"Named\"\nSELECT 7 AS named;\nGO\nROLLBACK;");
            check(trigger.Status == "completed" && Names(trigger) == "-, -" && Notes(trigger) is [var caught] && caught.Contains("a result set arrived that its batch's statements do not select", StringComparison.Ordinal),
                "a trigger's set of another column count stops naming instead of taking the name: " + Show(trigger));
        }
        finally
        {
            await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(session), json), json);
        }
    }
}
