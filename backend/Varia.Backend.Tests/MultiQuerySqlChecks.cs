using System.Collections;
using System.Collections.Concurrent;
using System.Data.Common;
using System.Text.Json;
using Varia.Backend.Explorer;
using Varia.Backend.MultiQuery;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Offline checks for Wave 1 SQL Server multi-query components: <see cref="ReadOnlySqlValidator"/>,
/// <see cref="SqlServerMultiRunner"/> pre-flight and transaction probe guards, and <see cref="MultiQueryCoordinator"/>
/// orchestration (2-phase commit, rollback with rolledBackPreview + resultSet.meta, commitInDoubt, sequential skip,
/// SESSION_BUSY, cancellation, concurrency cap, and post-Phase-2 autoCombine).</summary>
internal static class MultiQuerySqlChecks
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        await ReadOnlyValidatorChecksAsync(check);
        await SqlServerPreflightAndProbeChecksAsync(check);
        await CoordinatorChecksAsync(check);
    }

    /// <summary>Live SQL Server multi-query checks against VARIA_TEST_SQL_SERVER using only ephemeral session-local
    /// temp objects: parallel fire-and-forget + autoCombine + results.combine, sequential stop-on-first-error,
    /// duplicate-physical-server self-deadlock pre-flight guard, and coordinated transaction commit &amp; rollback with
    /// rolledBackPreview.</summary>
    public static async Task RunLiveAsync(Action<bool, string> check, SqlService service, ConnectionInfo primary,
        Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        async Task<T> Call<T>(string method, object args) =>
            (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);

        var secondary = await Call<ConnectionInfo>("connections.connect", live("tempdb"));
        var sessionId = Guid.NewGuid().ToString();
        try
        {
            var t1 = new MultiQueryTargetArgs("t-master", primary.Id, "srv-master", "Development", "master");
            var t2 = new MultiQueryTargetArgs("t-tempdb", secondary.Id, "srv-tempdb", "Development", "tempdb");

            // 1. Fire-and-forget parallel across 2 live connections + autoCombine + results.combine rebuild.
            var fanOut = await Call<QueryMultiResult>("query.executeMulti", new QueryMultiArgs(
                Guid.NewGuid().ToString(), sessionId, "fireAndForget", [t1, t2],
                MaxRows: 100, TimeoutSeconds: 15, MaxResultSets: 10, AutoCombine: true,
                Sql: "SELECT DB_NAME() AS DbName, 42 AS Answer;"));
            var combined = fanOut.ResultSets.SingleOrDefault(set => set.Kind == "combined");
            var rowSets = fanOut.ResultSets.Where(set => set.Kind == "rows").ToList();
            check(fanOut.Status == "completed" && fanOut.Targets.Count == 2
                && fanOut.Targets.All(t => t.Status == "succeeded")
                && rowSets.Count == 2 && combined is not null,
                "live fire-and-forget query.executeMulti succeeds across two SQL connections and builds an auto-combined result");
            if (combined is not null)
            {
                var rows = LiveResultChecks.RowsOf(service.Results, combined);
                var paired = rows
                    .Select(r => (Server: r.ElementAtOrDefault(0), Db: r.ElementAtOrDefault(1), Answer: r.ElementAtOrDefault(2)))
                    .OrderBy(r => r.Server, StringComparer.Ordinal)
                    .ToArray();
                check(combined.Columns.Count == 3 && combined.Columns[0].Name == "_server"
                    && paired.Length == 2
                    && paired[0] == ("srv-master", "master", "42")
                    && paired[1] == ("srv-tempdb", "tempdb", "42"),
                    "live auto-combined result pairs _server metadata with each SQL database's own row values");
                var rebuilt = await Call<ResultsCombineResult>("results.combine", new ResultsCombineArgs(
                    [.. rowSets.Select(set => set.ResultId)], "LiveRebuild"));
                check(rebuilt.Descriptor.Kind == "combined" && rebuilt.Descriptor.Name == "LiveRebuild" && rebuilt.Descriptor.RowsRead == 2,
                    "live results.combine rebuilds a named combined result set from two live SQL Server result sets");
            }

            // 2. Sequential rollout stops on first failing target and skips remaining peers.
            var seq = await Call<QueryMultiResult>("query.executeMulti", new QueryMultiArgs(
                Guid.NewGuid().ToString(), sessionId, "fireAndForget", [t1, t2],
                MaxRows: 100, TimeoutSeconds: 15, MaxResultSets: 10, Sequential: true, AutoCombine: false, StopOnError: true,
                Sql: "IF DB_NAME() = N'master' RAISERROR(N'varia-live-seq-stop', 16, 1); SELECT 1 AS Ok;"));
            check(seq.Status == "failed" && seq.Targets.Count == 2 && seq.Targets[0].Status == "failed"
                && seq.Targets[0].Error?.Code == "SQL_ERROR" && seq.Targets[1].Status == "skipped",
                "live sequential fire-and-forget stops after the first failing target and marks subsequent targets skipped");

            // 3. Coordinated transaction pre-flight rejects two connections targeting the same physical SQL Server.
            var dup = await Call<QueryMultiResult>("query.executeMulti", new QueryMultiArgs(
                Guid.NewGuid().ToString(), sessionId, "transaction", [t1, t2],
                MaxRows: 100, TimeoutSeconds: 15, MaxResultSets: 10, AutoCombine: false,
                Sql: "SELECT 1 AS Blocked;"));
            check(dup.Status == "failed" && dup.Targets.Count == 2
                && dup.Targets[1].Status == "failed" && dup.Targets[1].Error?.Code == "INVALID_PARAMS"
                && dup.Targets[0].Status == "skipped" && dup.ResultSets.Count == 0,
                "live coordinated transaction pre-flight refuses duplicate connections to the same physical SQL Server instance");

            // 4. Coordinated transaction commit against a real SQL Server session (verifies CURRENT_TRANSACTION_ID probe + COMMIT).
            var committed = await Call<QueryMultiResult>("query.executeMulti", new QueryMultiArgs(
                Guid.NewGuid().ToString(), sessionId, "transaction", [t1],
                MaxRows: 100, TimeoutSeconds: 15, MaxResultSets: 10, AutoCombine: false,
                Sql: "CREATE TABLE #VariaMqLive (Id int NOT NULL); INSERT INTO #VariaMqLive (Id) VALUES (7); SELECT Id FROM #VariaMqLive;"));
            var commitSet = committed.ResultSets.SingleOrDefault(set => set.Kind == "rows");
            check(committed.Status == "completed" && committed.Targets.Count == 1
                && committed.Targets[0].Status == "committed" && commitSet is not null && commitSet.RolledBackPreview != true
                && LiveResultChecks.RowsOf(service.Results, commitSet) is [["7"]],
                "live coordinated transaction executes DDL/DML/SELECT under SET XACT_ABORT ON + BEGIN TRANSACTION, passes post-batch probe, and commits");

            // 5. Coordinated transaction rollback preserves earlier SELECT rows with rolledBackPreview = true.
            var rolledBack = await Call<QueryMultiResult>("query.executeMulti", new QueryMultiArgs(
                Guid.NewGuid().ToString(), sessionId, "transaction", [t1],
                MaxRows: 100, TimeoutSeconds: 15, MaxResultSets: 10, AutoCombine: false,
                Sql: "SELECT 99 AS PreviewVal;\nGO\nRAISERROR(N'varia-live-rollback', 16, 1);"));
            var previewSet = rolledBack.ResultSets.SingleOrDefault(set => set.Kind == "rows");
            check(rolledBack.Status == "failed" && rolledBack.Targets.Count == 1
                && rolledBack.Targets[0].Status == "failed" && rolledBack.Targets[0].Error?.Code == "SQL_ERROR"
                && previewSet is not null && previewSet.RolledBackPreview == true
                && LiveResultChecks.RowsOf(service.Results, previewSet) is [["99"]],
                "live coordinated transaction rollback on batch error marks streamed SELECT result sets as rolledBackPreview");

            check(service.ActiveEphemeralSqlConnections == 0,
                "live multi-query executions release every ephemeral SQL Server connection on completion");
        }
        finally
        {
            service.Results.ReleaseSession(sessionId);
            await Call<object>("connections.disconnect", new ConnectionArgs(secondary.Id));
        }
    }

    private static async Task ReadOnlyValidatorChecksAsync(Action<bool, string> check)
    {
        var validator = new ReadOnlySqlValidator();

        // Valid read-only SELECTs (simple, CTE, UNION, subquery, multiple batches).
        var validSimple = await validator.ValidateTSqlAsync("SELECT 1 AS a, 'ok' AS b;", 1, CancellationToken.None);
        check(validSimple.Count == 0, "ReadOnlySqlValidator allows a plain SELECT");

        var validComplex = await validator.ValidateTSqlAsync(
            "WITH cte AS (SELECT 1 AS id UNION ALL SELECT 2 AS id) SELECT id FROM cte ORDER BY id;\nGO\nSELECT * FROM (SELECT 3 AS x) AS sub;",
            1, CancellationToken.None);
        check(validComplex.Count == 0, "ReadOnlySqlValidator allows CTEs, UNION ALL, subqueries, and multi-batch GO");

        // Top-level non-SELECT statements.
        foreach (var (name, sql) in new[]
        {
            ("INSERT", "INSERT INTO dbo.T VALUES (1);"),
            ("UPDATE", "UPDATE dbo.T SET a = 1;"),
            ("DELETE", "DELETE FROM dbo.T;"),
            ("MERGE", "MERGE dbo.T USING dbo.S ON dbo.T.id = dbo.S.id WHEN MATCHED THEN DELETE;"),
            ("CREATE TABLE", "CREATE TABLE dbo.T (id int);"),
            ("DROP TABLE", "DROP TABLE dbo.T;"),
            ("EXEC", "EXEC sp_who2;"),
            ("DECLARE", "DECLARE @x int = 1; SELECT @x;"),
            ("SET", "SET NOCOUNT ON; SELECT 1;"),
            ("BEGIN TRAN", "BEGIN TRANSACTION; SELECT 1;")
        })
        {
            var violations = await validator.ValidateTSqlAsync(sql, 1, CancellationToken.None);
            check(violations.Count > 0, $"ReadOnlySqlValidator rejects top-level {name}");
        }

        // SELECT INTO (top-level and with CTE).
        var selectInto = await validator.ValidateTSqlAsync("SELECT 1 AS a INTO #tmp;", 1, CancellationToken.None);
        check(selectInto.Count == 1 && selectInto[0].Keyword == "SELECT INTO", "ReadOnlySqlValidator rejects SELECT INTO");

        var cteInto = await validator.ValidateTSqlAsync("WITH c AS (SELECT 1 AS a) SELECT a INTO #tmp FROM c;", 1, CancellationToken.None);
        check(cteInto.Count == 1 && cteInto[0].Keyword == "SELECT INTO", "ReadOnlySqlValidator rejects CTE SELECT INTO");

        // Composable DML AST bypasses: SELECT * FROM (DELETE/INSERT/UPDATE/MERGE ... OUTPUT ...).
        foreach (var (name, sql) in new[]
        {
            ("DELETE OUTPUT", "SELECT * FROM (DELETE FROM dbo.T OUTPUT DELETED.Id) AS d;"),
            ("INSERT OUTPUT", "SELECT * FROM (INSERT INTO dbo.T (Id) OUTPUT INSERTED.Id VALUES (1)) AS i;"),
            ("UPDATE OUTPUT", "SELECT * FROM (UPDATE dbo.T SET Name = 'x' OUTPUT INSERTED.Id) AS u;"),
            ("MERGE OUTPUT", "SELECT * FROM (MERGE dbo.T USING dbo.S ON dbo.T.Id = dbo.S.Id WHEN MATCHED THEN DELETE OUTPUT DELETED.Id) AS m;")
        })
        {
            var violations = await validator.ValidateTSqlAsync(sql, 1, CancellationToken.None);
            check(violations.Count > 0, $"ReadOnlySqlValidator blocks composable DML bypass: {name}");
        }

        // Verify SubtreeVisitor directly catches DataModificationTableReference when ScriptDom constructs one inside a SelectQuery.
        {
            using var sr = new StringReader("INSERT INTO dbo.Dest SELECT * FROM (DELETE FROM dbo.T OUTPUT DELETED.Id) AS d;");
            var parsed = new Microsoft.SqlServer.TransactSql.ScriptDom.TSql180Parser(true).Parse(sr, out var parseErrors);
            var insertStmt = (Microsoft.SqlServer.TransactSql.ScriptDom.InsertStatement)((Microsoft.SqlServer.TransactSql.ScriptDom.TSqlScript)parsed).Batches[0].Statements[0];
            var selectSource = ((Microsoft.SqlServer.TransactSql.ScriptDom.SelectInsertSource)insertStmt.InsertSpecification.InsertSource).Select;
            var subtreeViolations = ReadOnlySqlValidator.InspectSubtree(selectSource, 1);
            check(parseErrors.Count == 0 && subtreeViolations.Any(v => v.Keyword == "DML_TABLE_SOURCE"),
                "ReadOnlySqlValidator SubtreeVisitor catches DataModificationTableReference directly");
        }

        // Rowset / external-access table references.
        var openRowset = await validator.ValidateTSqlAsync(
            "SELECT * FROM OPENROWSET('SQLNCLI', 'Server=x;Trusted_Connection=yes;', 'SELECT 1');", 1, CancellationToken.None);
        check(openRowset.Count > 0 && openRowset[0].Keyword == "OPENROWSET", "ReadOnlySqlValidator rejects OPENROWSET");

        var bulkOpenRowset = await validator.ValidateTSqlAsync(
            "SELECT * FROM OPENROWSET(BULK 'C:\\data.txt', SINGLE_CLOB) AS f;", 1, CancellationToken.None);
        check(bulkOpenRowset.Count > 0 && bulkOpenRowset[0].Keyword == "OPENROWSET", "ReadOnlySqlValidator rejects OPENROWSET(BULK ...)");

        var openQuery = await validator.ValidateTSqlAsync(
            "SELECT * FROM OPENQUERY(LinkedSrv, 'SELECT 1');", 1, CancellationToken.None);
        check(openQuery.Count > 0 && openQuery[0].Keyword == "OPENQUERY", "ReadOnlySqlValidator rejects OPENQUERY");

        var openDataSource = await validator.ValidateTSqlAsync(
            "SELECT * FROM OPENDATASOURCE('MSOLEDBSQL', 'Data Source=srv').master.dbo.spt_values;", 1, CancellationToken.None);
        check(openDataSource.Count > 0 && openDataSource[0].Keyword == "OPENDATASOURCE", "ReadOnlySqlValidator rejects OPENDATASOURCE (AdHocTableReference)");

        var openXml = await validator.ValidateTSqlAsync(
            "SELECT * FROM OPENXML(@doc, '/root/row', 1) WITH (id int);", 1, CancellationToken.None);
        check(openXml.Count > 0 && openXml[0].Keyword == "OPENXML", "ReadOnlySqlValidator rejects OPENXML");

        // Sequence mutation (NEXT VALUE FOR) even nested inside CTE / expression.
        var nextVal = await validator.ValidateTSqlAsync(
            "WITH c AS (SELECT NEXT VALUE FOR dbo.MySeq AS n) SELECT n FROM c;", 1, CancellationToken.None);
        check(nextVal.Count > 0 && nextVal[0].Keyword == "NEXT VALUE FOR", "ReadOnlySqlValidator rejects NEXT VALUE FOR in subtree");

        // Variable assignment (SELECT @v = 1).
        var assign = await validator.ValidateTSqlAsync("SELECT @v = 1;", 1, CancellationToken.None);
        check(assign.Count > 0 && assign[0].Keyword == "SELECT_ASSIGNMENT", "ReadOnlySqlValidator rejects SELECT @v = 1");

        // Comment-only, empty, and semicolon-only scripts fail closed.
        var commentOnly = await validator.ValidateTSqlAsync("-- only a comment\n/* block comment */", 5, CancellationToken.None);
        check(commentOnly.Count > 0 && commentOnly[0].Line == 5 && commentOnly[0].Keyword == "EMPTY", "ReadOnlySqlValidator fails closed on comment-only script");

        var semiOnly = await validator.ValidateTSqlAsync(";\n;", 7, CancellationToken.None);
        check(semiOnly.Count > 0 && semiOnly[0].Line == 7 && semiOnly[0].Keyword == "EMPTY", "ReadOnlySqlValidator fails closed on semicolon-only batch");

        // GO 2 repetition fails closed.
        var goRepeat = await validator.ValidateTSqlAsync("SELECT 1;\nGO 2", 10, CancellationToken.None);
        check(goRepeat.Count > 0 && goRepeat[0].Keyword == "GO" && goRepeat[0].Line == 10, "ReadOnlySqlValidator rejects GO 2 batch repetition");

        // MaxParenDepth (128) fails closed without stack overflow.
        var deepParens = "SELECT " + new string('(', ResultNames.MaxParenDepth + 1) + "1" + new string(')', ResultNames.MaxParenDepth + 1) + ";";
        var parenResult = await validator.ValidateTSqlAsync(deepParens, 3, CancellationToken.None);
        check(parenResult.Count > 0 && parenResult[0].Keyword == "NESTING_DEPTH" && parenResult[0].Line == 3,
            "ReadOnlySqlValidator fails closed above ResultNames.MaxParenDepth");

        // MaxParseChars (262,144) fails closed.
        var hugeBatch = "SELECT '" + new string('a', ResultNames.MaxParseChars + 10) + "';";
        var hugeResult = await validator.ValidateTSqlAsync(hugeBatch, 4, CancellationToken.None);
        check(hugeResult.Count > 0 && hugeResult[0].Keyword == "BATCH_TOO_LARGE" && hugeResult[0].Line == 4,
            "ReadOnlySqlValidator fails closed above ResultNames.MaxParseChars");

        // Syntax errors fail closed with mapped line.
        var syntaxErr = await validator.ValidateTSqlAsync("SELECT 1;\nGO\nSELECT FROM WHERE;", 10, CancellationToken.None);
        check(syntaxErr.Count > 0 && syntaxErr[0].Keyword == "SYNTAX" && syntaxErr[0].Line == 12,
            "ReadOnlySqlValidator fails closed on syntax error with mapped line offset");

        // Multi-batch line mapping with startLine offset:
        // Line 10: SELECT 1;
        // Line 11: GO
        // Line 12: -- comment inside batch 2
        // Line 13: SELECT @x = 42;
        var mapped = await validator.ValidateTSqlAsync("SELECT 1;\nGO\n-- comment\nSELECT @x = 42;", 10, CancellationToken.None);
        check(mapped.Count == 1 && mapped[0].Line == 13 && mapped[0].Keyword == "SELECT_ASSIGNMENT",
            $"ReadOnlySqlValidator maps batch + fragment StartLine accurately (got line {(mapped.Count > 0 ? mapped[0].Line : -1)})");
    }

    private static async Task SqlServerPreflightAndProbeChecksAsync(Action<bool, string> check)
    {
        // 1. Valid transactional script (including savepoint rollback) passes pre-flight.
        var validTx = await SqlServerMultiRunner.ValidateTransactionScriptAsync(
            "INSERT INTO dbo.T VALUES (1);\nSAVE TRANSACTION sp1;\nUPDATE dbo.T SET a = 2;\nROLLBACK TRANSACTION sp1;\nSELECT * FROM dbo.T;",
            1, 1, CancellationToken.None);
        check(validTx.Count == 0, "SqlServerMultiRunner allows DML, SELECT, and savepoint ROLLBACK TRANSACTION sp1 in Transaction mode");

        // 2. Explicit COMMIT and bare ROLLBACK (without savepoint) rejected, including nested inside IF.
        var commitViol = await SqlServerMultiRunner.ValidateTransactionScriptAsync("SELECT 1;\nCOMMIT TRANSACTION;", 5, 1, CancellationToken.None);
        check(commitViol.Count == 1 && commitViol[0].StatementKind == "COMMIT TRANSACTION" && commitViol[0].Line == 6,
            "SqlServerMultiRunner rejects explicit COMMIT TRANSACTION with mapped line");

        var rollbackViol = await SqlServerMultiRunner.ValidateTransactionScriptAsync("IF 1 = 1\nBEGIN\n    ROLLBACK TRANSACTION;\nEND", 10, 1, CancellationToken.None);
        check(rollbackViol.Count == 1 && rollbackViol[0].StatementKind == "ROLLBACK TRANSACTION" && rollbackViol[0].Line == 12,
            "SqlServerMultiRunner rejects bare ROLLBACK TRANSACTION nested in IF/BEGIN with mapped line");

        // 3. StartColumn forwarding on line 1.
        var colViol = await SqlServerMultiRunner.ValidateTransactionScriptAsync("COMMIT;", 1, 8, CancellationToken.None);
        check(colViol.Count == 1 && colViol[0].Line == 1 && colViol[0].Column == 8,
            $"SqlServerMultiRunner forwards StartColumn on first line (got col {(colViol.Count > 0 ? colViol[0].Column : -1)})");

        // 4. Full Msg 226/574 non-transactional statement list.
        foreach (var (name, sql) in new[]
        {
            ("CREATE DATABASE", "CREATE DATABASE TestDb;"),
            ("ALTER DATABASE", "ALTER DATABASE TestDb SET RECOVERY SIMPLE;"),
            ("DROP DATABASE", "DROP DATABASE TestDb;"),
            ("BACKUP DATABASE", "BACKUP DATABASE TestDb TO DISK = 'NUL';"),
            ("BACKUP LOG", "BACKUP LOG TestDb TO DISK = 'NUL';"),
            ("RESTORE DATABASE", "RESTORE DATABASE TestDb FROM DISK = 'NUL';"),
            ("RECONFIGURE", "RECONFIGURE WITH OVERRIDE;"),
            ("DBCC", "DBCC CHECKDB;"),
            ("CREATE FULLTEXT CATALOG", "CREATE FULLTEXT CATALOG ftCat;"),
            ("DROP FULLTEXT INDEX", "DROP FULLTEXT INDEX ON dbo.T;"),
            ("CREATE AVAILABILITY GROUP", "CREATE AVAILABILITY GROUP ag1 FOR DATABASE TestDb REPLICA ON N'S1' WITH (ENDPOINT_URL = N'TCP://s1:5022', AVAILABILITY_MODE = SYNCHRONOUS_COMMIT, FAILOVER_MODE = AUTOMATIC);"),
            ("DROP AVAILABILITY GROUP", "DROP AVAILABILITY GROUP ag1;"),
            ("ALTER SERVER CONFIGURATION", "ALTER SERVER CONFIGURATION SET PROCESS AFFINITY AUTO;"),
            ("CREATE RESOURCE POOL", "CREATE RESOURCE POOL p1;"),
            ("ALTER RESOURCE GOVERNOR", "ALTER RESOURCE GOVERNOR RECONFIGURE;"),
            ("SHUTDOWN", "SHUTDOWN WITH NOWAIT;"),
            ("KILL", "KILL 55;")
        })
        {
            var violations = await SqlServerMultiRunner.ValidateTransactionScriptAsync(sql, 1, 1, CancellationToken.None);
            check(violations.Count > 0, $"SqlServerMultiRunner Transaction pre-flight rejects {name}");
        }

        // 5. Fail closed on MaxParenDepth, MaxParseChars, and syntax error in Transaction pre-flight.
        var deepTx = await SqlServerMultiRunner.ValidateTransactionScriptAsync(
            "SELECT " + new string('(', ResultNames.MaxParenDepth + 1) + "1" + new string(')', ResultNames.MaxParenDepth + 1) + ";",
            2, 1, CancellationToken.None);
        check(deepTx.Count == 1 && deepTx[0].StatementKind == "NESTING_DEPTH" && deepTx[0].Line == 2,
            "SqlServerMultiRunner Transaction pre-flight fails closed above MaxParenDepth");

        var syntaxTx = await SqlServerMultiRunner.ValidateTransactionScriptAsync("UPDATE SET WHERE;", 3, 1, CancellationToken.None);
        check(syntaxTx.Count > 0 && syntaxTx[0].StatementKind == "SYNTAX" && syntaxTx[0].Line == 3,
            "SqlServerMultiRunner Transaction pre-flight fails closed on syntax errors");

        // 6. Duplicate physical server rejection via ServerOf(connectionId).
        using var service = new SqlService(new ResultStore(8 * 1024 * 1024, 4 * 1024 * 1024));
        var connA = service.Register("Server=sql01;Database=dbA;", new ServerProfile(16, "16.0.1000", 3, "sa", false, false, false, ServerName: "SQL01"), "dbA");
        var connB = service.Register("Server=sql01.corp;Database=dbB;", new ServerProfile(16, "16.0.1000", 3, "sa", false, false, false, ServerName: "sql01"), "dbB");
        var connC = service.Register("Server=sql02;Database=dbA;", new ServerProfile(16, "16.0.1000", 3, "sa", false, false, false, ServerName: "SQL02"), "dbA");

        var runner = new SqlServerMultiRunner(service);
        var budget = service.Results.BeginQuery(Guid.NewGuid().ToString());
        using var events = new QueryEventSink(null);
        var messages = new QueryMessages(events.Message);
        var quota = new MultiQueryQuota(10, SqlService.MaxSummaryDescriptorBytes);

        MultiTargetContext MakeCtx(string key, string connId, string label) => new(
            Guid.NewGuid().ToString(), budget.SessionId, "transaction", false,
            new MultiQueryTargetArgs(key, connId, label, Database: "dbA"),
            Providers.SqlServer, "SELECT 1;", 1, 1, 1000, 10, 60, false, false, null, null, null, null,
            quota, () => false, budget, messages, events);

        var dupPreflight = await runner.PreflightAsync([MakeCtx("t1", connA, "SQL01 (dbA)"), MakeCtx("t2", connB, "SQL01 (dbB)")], CancellationToken.None);
        check(dupPreflight.Count == 2 && dupPreflight[0].Passed && !dupPreflight[1].Passed && dupPreflight[1].Error?.Code == "INVALID_PARAMS",
            "SqlServerMultiRunner rejects duplicate physical SQL Servers in Transaction mode");

        var distinctPreflight = await runner.PreflightAsync([MakeCtx("t1", connA, "SQL01"), MakeCtx("t3", connC, "SQL02")], CancellationToken.None);
        check(distinctPreflight.Count == 2 && distinctPreflight.All(o => o.Passed),
            "SqlServerMultiRunner accepts distinct physical SQL Servers in Transaction mode");

        // 7. CURRENT_TRANSACTION_ID() gating: Major >= 13 || EngineEdition is 5 or 8.
        check(!SqlServerMultiRunner.SupportsCurrentTransactionId(new ServerProfile(11, "11.0", 3, null, false, false, false)),
            "SQL Server 2012 box does not use CURRENT_TRANSACTION_ID()");
        check(!SqlServerMultiRunner.SupportsCurrentTransactionId(new ServerProfile(12, "12.0", 3, null, false, false, false)),
            "SQL Server 2014 box does not use CURRENT_TRANSACTION_ID()");
        check(SqlServerMultiRunner.SupportsCurrentTransactionId(new ServerProfile(13, "13.0", 3, null, false, false, false)),
            "SQL Server 2016 box uses CURRENT_TRANSACTION_ID()");
        check(SqlServerMultiRunner.SupportsCurrentTransactionId(new ServerProfile(12, "12.0", 5, null, false, false, false)),
            "Azure SQL Database (Major 12, EngineEdition 5) uses CURRENT_TRANSACTION_ID()");
        check(SqlServerMultiRunner.SupportsCurrentTransactionId(new ServerProfile(12, "12.0", 8, null, false, false, false)),
            "Azure SQL Managed Instance (Major 12, EngineEdition 8) uses CURRENT_TRANSACTION_ID()");

        // 8. Transaction probe schema & SHOWPLAN / NOEXEC guard (must never throw InvalidCastException).
        await using (var ok3 = new FakeProbeReader([typeof(short), typeof(int), typeof(long)], [[(short)1, 1, 987654321L]]))
        {
            var probe = await SqlServerMultiRunner.ReadTransactionProbeAsync(ok3, expectTransactionId: true, CancellationToken.None);
            check(probe.Valid && probe.XactState == 1 && probe.TranCount == 1 && probe.TransactionId == 987654321L,
                "3-column transaction probe reads XACT_STATE, @@TRANCOUNT, and CURRENT_TRANSACTION_ID()");
        }

        await using (var ok2 = new FakeProbeReader([typeof(short), typeof(int)], [[(short)1, 1]]))
        {
            var probe = await SqlServerMultiRunner.ReadTransactionProbeAsync(ok2, expectTransactionId: false, CancellationToken.None);
            check(probe.Valid && probe.XactState == 1 && probe.TranCount == 1 && probe.TransactionId is null,
                "2-column legacy transaction probe reads XACT_STATE and @@TRANCOUNT");
        }

        await using (var showplanXml = new FakeProbeReader([typeof(string)], [["<ShowPlanXML />"]]))
        {
            var probe = await SqlServerMultiRunner.ReadTransactionProbeAsync(showplanXml, expectTransactionId: true, CancellationToken.None);
            check(!probe.Valid && probe.FailureReason is not null,
                "SHOWPLAN_XML 1-string-column probe aborts cleanly without InvalidCastException");
        }

        await using (var showplanAll = new FakeProbeReader([typeof(string), typeof(int), typeof(int)], [["StmtText", 1, 2]]))
        {
            var probe = await SqlServerMultiRunner.ReadTransactionProbeAsync(showplanAll, expectTransactionId: true, CancellationToken.None);
            check(!probe.Valid, "SHOWPLAN_ALL wrong-typed 3-column probe aborts cleanly before reading");
        }

        await using (var noexecEmpty = new FakeProbeReader([typeof(short), typeof(int), typeof(long)], []))
        {
            var probe = await SqlServerMultiRunner.ReadTransactionProbeAsync(noexecEmpty, expectTransactionId: true, CancellationToken.None);
            check(!probe.Valid, "NOEXEC / empty probe aborts cleanly");
        }
    }

    private static async Task CoordinatorChecksAsync(Action<bool, string> check)
    {
        using var service = new SqlService(new ResultStore(16 * 1024 * 1024, 8 * 1024 * 1024));
        var c1 = service.Register("Server=s1;Database=d1;", new ServerProfile(16, "16.0", 3, "sa", false, false, false, ServerName: "S1"), "d1");
        var c2 = service.Register("Server=s2;Database=d2;", new ServerProfile(16, "16.0", 3, "sa", false, false, false, ServerName: "S2"), "d2");
        var c3 = service.Register("Server=s3;Database=d3;", new ServerProfile(16, "16.0", 3, "sa", false, false, false, ServerName: "S3"), "d3");

        MultiQueryTargetArgs T(string key, string connId, string label) => new(key, connId, label, Database: "d1");

        // 1. Two-phase Commit succeeds across 2 targets + autoCombine runs AFTER Phase 2 commits.
        {
            var commitOrder = new ConcurrentQueue<string>();
            var combineCalledAfterCommits = false;
            var committedCount = 0;

            var fakeRunner = new FakeRunner(Providers.SqlServer, (ctx, token) =>
            {
                var set = OpenFakeSet(service.Results, ctx, slot: 0);
                var handle = new FakePhase2Handle(
                    onCommit: _ =>
                    {
                        Interlocked.Increment(ref committedCount);
                        commitOrder.Enqueue("commit:" + ctx.Target.TargetKey);
                        return Task.FromResult(new MultiCommitResult(MultiCommitOutcome.Committed));
                    },
                    onRollback: _ => Task.CompletedTask);
                var outcome = new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded", 1, 1, 1, 5, [set.ResultId]);
                return Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(outcome, [set], NeedsCommit: true), handle));
            });

            var fakeCombiner = new FakeCombiner((store, budget, sources, index, batch, iter, name) =>
            {
                combineCalledAfterCommits = Volatile.Read(ref committedCount) == 2;
                var cols = new List<ResultColumn> { new("Server", "nvarchar", "text"), new("v", "int", "text") };
                var combined = store.Open(budget, index, batch, iter, "combined", cols, [WireKind.Text, WireKind.Text], derived: true, name: name, statementSlot: sources[0].StatementSlot)!;
                combined.Complete();
                return new CombineOutput(combined, []);
            });

            var coordinator = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = fakeRunner }, fakeCombiner);
            var args = new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "transaction", [T("a", c1, "S1"), T("b", c2, "S2")], 1000, 30, Sql: "SELECT 1;");
            var result = await coordinator.ExecuteAsync(args, context: null);

            check(result.Status == "completed" && result.Targets.All(t => t.Status == "committed") && committedCount == 2,
                "MultiQueryCoordinator 2-phase commit commits all targets and returns completed");
            check(combineCalledAfterCommits && result.ResultSets.Any(r => r.Kind == "combined") && result.ResultSets.Count == 3,
                "MultiQueryCoordinator runs autoCombine strictly after Phase 2 commits and includes the combined descriptor");

            // AutoCombine == false skips combiner.
            var combineCalledWhenFalse = false;
            var coordinatorNoCombine = new MultiQueryCoordinator(
                service,
                new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = fakeRunner },
                new FakeCombiner((_, _, _, _, _, _, _) => { combineCalledWhenFalse = true; return new CombineOutput(null, []); }));
            var resNoCombine = await coordinatorNoCombine.ExecuteAsync(args with { QueryId = Guid.NewGuid().ToString(), AutoCombine = false }, context: null);
            check(!combineCalledWhenFalse && resNoCombine.ResultSets.Count == 2,
                "MultiQueryCoordinator skips autoCombine when autoCombine == false");
        }

        // 2. Two-phase Rollback when Target 2 fails Phase 1: Target 1 rolls back with fresh token, marks RolledBackPreview + emits resultSet.meta.
        {
            var events = new ConcurrentQueue<(object Body, bool Droppable)>();
            using var ctx = new RequestContext(1, "query.executeMulti", RequestLane.Query, 0, sendEvent: (_, body, droppable) => events.Enqueue((body, droppable)));

            var target1AtBarrier = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var rollbackTokenWasCancelled = true;
            var rollbackCalled = 0;

            var fakeRunner = new FakeRunner(Providers.SqlServer, async (targetCtx, token) =>
            {
                if (targetCtx.Target.TargetKey == "a")
                {
                    var set = OpenFakeSet(service.Results, targetCtx, slot: 0);
                    var handle = new FakePhase2Handle(
                        onCommit: _ => Task.FromResult(new MultiCommitResult(MultiCommitOutcome.Committed)),
                        onRollback: rbToken =>
                        {
                            Interlocked.Increment(ref rollbackCalled);
                            rollbackTokenWasCancelled = rbToken.IsCancellationRequested;
                            return Task.CompletedTask;
                        });
                    target1AtBarrier.TrySetResult();
                    var outcome = new MultiTargetOutcome("a", Providers.SqlServer, "S1", "succeeded", 1, 1, 1, 5, [set.ResultId]);
                    return new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(outcome, [set], NeedsCommit: true), handle);
                }

                await target1AtBarrier.Task;
                var err = new MultiTargetError("SQL_ERROR", "Divide by zero", 1, 1);
                var failOutcome = new MultiTargetOutcome("b", Providers.SqlServer, "S2", "failed", 0, 1, 0, 5, [], Error: err);
                return new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(failOutcome, [], NeedsCommit: false), Phase2: null);
            });

            var coordinator = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = fakeRunner });
            var args = new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "transaction", [T("a", c1, "S1"), T("b", c2, "S2")], 1000, 30, Sql: "SELECT 1;");
            var result = await coordinator.ExecuteAsync(args, ctx);

            var metaEvents = events.Where(e => e.Body is ResultSetMetaEvent).ToList();
            check(result.Status == "rolledBack" && rollbackCalled == 1 && !rollbackTokenWasCancelled,
                "MultiQueryCoordinator rolls back barrier peers with a fresh non-cancelled token on peer Phase 1 failure");
            check(result.Targets[0].Status == "rolledBack" && result.Targets[1].Status == "failed",
                "Rollback sets barrier peer to rolledBack and keeps failing target as failed");
            check(result.ResultSets.Count == 1 && result.ResultSets[0].RolledBackPreview == true
                && metaEvents.Count == 1 && !metaEvents[0].Droppable && ((ResultSetMetaEvent)metaEvents[0].Body).RolledBackPreview,
                "Rollback marks stored ResultSetBuffer RolledBackPreview = true and emits non-droppable resultSet.meta");
        }

        // 3. commitInDoubt during Phase 2 Commit.
        {
            var fakeRunner = new FakeRunner(Providers.SqlServer, (targetCtx, _) =>
            {
                var handle = new FakePhase2Handle(
                    onCommit: _ => targetCtx.Target.TargetKey == "a"
                        ? Task.FromResult(new MultiCommitResult(MultiCommitOutcome.Committed))
                        : Task.FromResult(new MultiCommitResult(MultiCommitOutcome.InDoubt, new MultiTargetError("SESSION_LOST", "Lost during commit"))),
                    onRollback: _ => Task.CompletedTask);
                var outcome = new MultiTargetOutcome(targetCtx.Target.TargetKey, Providers.SqlServer, targetCtx.Target.Label, "succeeded", 1, 1, 0, 3, []);
                return Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(outcome, [], NeedsCommit: true), handle));
            });

            var coordinator = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = fakeRunner });
            var args = new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "transaction", [T("a", c1, "S1"), T("b", c2, "S2")], 1000, 30, Sql: "UPDATE dbo.T SET a = 1;");
            var result = await coordinator.ExecuteAsync(args, context: null);

            check(result.Status == "commitInDoubt" && result.Targets[0].Status == "committed" && result.Targets[1].Status == "commitInDoubt",
                "MultiQueryCoordinator classifies Phase 2 InDoubt failure as overall commitInDoubt without claiming rollback");
        }

        // 4. Sequential Fire-and-Forget stops on first error and marks remaining targets skipped.
        {
            var executed = new List<string>();
            var fakeRunner = new FakeRunner(Providers.SqlServer, (targetCtx, _) =>
            {
                executed.Add(targetCtx.Target.TargetKey);
                if (targetCtx.Target.TargetKey == "b")
                {
                    var err = new MultiTargetError("SQL_ERROR", "boom", 1, 1);
                    return Task.FromResult(new MultiTargetPhase1Outcome(
                        new MultiTargetPhase1Result(new MultiTargetOutcome("b", Providers.SqlServer, "S2", "failed", 0, 1, 0, 2, [], Error: err), [], NeedsCommit: false)));
                }
                return Task.FromResult(new MultiTargetPhase1Outcome(
                    new MultiTargetPhase1Result(new MultiTargetOutcome(targetCtx.Target.TargetKey, Providers.SqlServer, targetCtx.Target.Label, "succeeded", 1, 1, 1, 2, []), [], NeedsCommit: false)));
            });

            var coordinator = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = fakeRunner });
            var args = new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "fireAndForget",
                [T("a", c1, "S1"), T("b", c2, "S2"), T("c", c3, "S3")], 1000, 30, Sequential: true, Sql: "UPDATE dbo.T SET a = 1;");
            var result = await coordinator.ExecuteAsync(args, context: null);

            check(result.Status == "partialFailure"
                && executed.SequenceEqual(["a", "b"])
                && result.Targets[0].Status == "succeeded"
                && result.Targets[1].Status == "failed"
                && result.Targets[2].Status == "skipped",
                "Sequential fireAndForget stops on first error and marks remaining targets skipped");
        }

        // 5. SESSION_BUSY gate + Detachable == false + Cancellation via query.cancel.
        {
            var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var budgetExecutingObserved = false;
            var cancelledObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

            var fakeRunner = new FakeRunner(Providers.SqlServer, async (targetCtx, token) =>
            {
                budgetExecutingObserved = targetCtx.Budget.Executing;
                started.TrySetResult();
                try { await Task.Delay(Timeout.Infinite, token); }
                catch (OperationCanceledException)
                {
                    cancelledObserved.TrySetResult();
                    throw;
                }
                return new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(targetCtx.Target.TargetKey, Providers.SqlServer, targetCtx.Target.Label, "succeeded", 1, 1, 0, 1, []), [], NeedsCommit: false));
            });

            var coordinator = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = fakeRunner });
            var sessionId = Guid.NewGuid().ToString();
            var queryId = Guid.NewGuid().ToString();
            var args = new QueryMultiArgs(queryId, sessionId, "fireAndForget", [T("a", c1, "S1")], 1000, 30, Sql: "SELECT 1;");

            var runTask = coordinator.ExecuteAsync(args, context: null);
            await started.Task;

            check(budgetExecutingObserved, "QueryBudget.Executing is true during multi-server execution");

            // Concurrent run on the same sessionId must throw SESSION_BUSY.
            string? busyCode = null;
            try
            {
                await coordinator.ExecuteAsync(args with { QueryId = Guid.NewGuid().ToString() }, context: null);
            }
            catch (RequestException error)
            {
                busyCode = error.Code;
            }
            check(busyCode == "SESSION_BUSY", "MultiQueryCoordinator enforces SESSION_BUSY on concurrent run of same sessionId");

            // Detach must be refused (Detachable == false).
            var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
            string? detachCode = null;
            try
            {
                await service.DispatchAsync("query.cancel", JsonSerializer.SerializeToElement(new CancelArgs(queryId, Detach: true), json), json);
            }
            catch (RequestException error)
            {
                detachCode = error.Code;
            }
            check(detachCode == "UNSUPPORTED_PROVIDER", "query.cancel(detach: true) is refused on multi-server runs (Detachable = false)");

            // Cancel via query.cancel cancels the running multi-server query cleanly.
            await service.DispatchAsync("query.cancel", JsonSerializer.SerializeToElement(new CancelArgs(queryId), json), json);
            await cancelledObserved.Task;
            var cancelledResult = await runTask;
            check(cancelledResult.Status == "cancelled" && cancelledResult.Targets[0].Status == "cancelled" && coordinator.ActiveRuns == 0,
                "query.cancel cancels running multi-server query and releases active run count");
        }

        // 6. Cross-Engine Read-Only pre-flight aborts immediately with READ_ONLY_VIOLATION and 0 executions.
        {
            var phase1Invoked = 0;
            var sqlRunner = new FakeRunner(Providers.SqlServer, (_, _) =>
            {
                Interlocked.Increment(ref phase1Invoked);
                throw new InvalidOperationException("Must not execute Phase 1 after READ_ONLY_VIOLATION");
            });
            var bqRunner = new FakeRunner(Providers.BigQuery, (_, _) =>
            {
                Interlocked.Increment(ref phase1Invoked);
                throw new InvalidOperationException("Must not execute Phase 1 after READ_ONLY_VIOLATION");
            });

            var bqConn = Guid.NewGuid().ToString();
            var coordinator = new MultiQueryCoordinator(
                service,
                new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = sqlRunner, [Providers.BigQuery] = bqRunner },
                sqlValidator: new ReadOnlySqlValidator(),
                providerOf: id => id == bqConn ? Providers.BigQuery : Providers.SqlServer);

            var crossArgs = new QueryMultiArgs(
                Guid.NewGuid().ToString(),
                Guid.NewGuid().ToString(),
                "crossEngineReadOnly",
                [T("sql1", c1, "SQL1"), new MultiQueryTargetArgs("bq1", bqConn, "BQ1", Dataset: "ds")],
                1000,
                30,
                Scripts: new MultiQueryScripts("SELECT * FROM (DELETE FROM dbo.T OUTPUT DELETED.Id) AS d;", "SELECT 1"),
                StartLines: new MultiQueryStartLines(Sqlserver: 4, Bigquery: 10));

            var crossResult = await coordinator.ExecuteAsync(crossArgs, context: null);
            check(crossResult.Status == "failed"
                && phase1Invoked == 0
                && crossResult.Targets[0].Status == "failed"
                && crossResult.Targets[0].Error?.Code == "READ_ONLY_VIOLATION"
                && crossResult.Targets[0].Error?.Line == 4
                && crossResult.Targets[1].Status == "skipped",
                "Cross-Engine pre-flight rejects T-SQL AST bypass with READ_ONLY_VIOLATION, mapped line, skipped peers, and 0 executions");
        }

        // 7. Default 300 s Transaction barrier cap when timeoutSeconds == 0 + Phase 1 commitInDoubt aborts and rolls back peer.
        {
            var observedTimeout = -1;
            var peerRolledBack = false;
            var aReachedBarrier = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var fakeRunner = new FakeRunner(Providers.SqlServer, async (targetCtx, _) =>
            {
                observedTimeout = targetCtx.TimeoutSeconds;
                if (targetCtx.Target.TargetKey == "a")
                {
                    var set = OpenFakeSet(service.Results, targetCtx, slot: 0);
                    var handle = new FakePhase2Handle(
                        onCommit: _ => Task.FromResult(new MultiCommitResult(MultiCommitOutcome.Committed)),
                        onRollback: _ => { peerRolledBack = true; return Task.CompletedTask; });
                    aReachedBarrier.TrySetResult();
                    return new MultiTargetPhase1Outcome(
                        new MultiTargetPhase1Result(new MultiTargetOutcome("a", Providers.SqlServer, "S1", "succeeded", 1, 1, 1, 2, [set.ResultId]), [set], NeedsCommit: true), handle);
                }
                await aReachedBarrier.Task;
                var doubtSet = OpenFakeSet(service.Results, targetCtx, slot: 0);
                var doubtErr = new MultiTargetError("SQL_ERROR", "Transaction closed mid-script without error");
                return new MultiTargetPhase1Outcome(
                    new MultiTargetPhase1Result(new MultiTargetOutcome("b", Providers.SqlServer, "S2", "commitInDoubt", 1, 1, 0, 2, [doubtSet.ResultId], Error: doubtErr), [doubtSet], NeedsCommit: false));
            });

            var coordinator = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = fakeRunner });
            var args = new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "transaction", [T("a", c1, "S1"), T("b", c2, "S2")], 1000, 0, Sql: "SELECT 1;");
            var result = await coordinator.ExecuteAsync(args, context: null);

            var setA = result.ResultSets.Single(r => r.TargetKey == "a");
            var setB = result.ResultSets.Single(r => r.TargetKey == "b");
            check(observedTimeout == MultiQueryCoordinator.DefaultTransactionTimeoutSeconds,
                "Transaction mode applies default 300 s barrier timeout when timeoutSeconds == 0");
            check(result.Status == "commitInDoubt" && peerRolledBack && result.Targets[0].Status == "rolledBack" && result.Targets[1].Status == "commitInDoubt"
                && setA.RolledBackPreview == true && setB.RolledBackPreview != true,
                "Phase 1 commitInDoubt rolls back barrier peer with rolledBackPreview while preserving commitInDoubt target");
        }

        // 8. Global cap of 8 concurrent multi-server runs refuses the 9th with SESSION_LIMIT.
        {
            var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var startedCount = 0;
            var allEightStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var fakeRunner = new FakeRunner(Providers.SqlServer, async (targetCtx, _) =>
            {
                if (Interlocked.Increment(ref startedCount) == MultiQueryCoordinator.MaxConcurrentRuns)
                    allEightStarted.TrySetResult();
                await gate.Task;
                return new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(targetCtx.Target.TargetKey, Providers.SqlServer, targetCtx.Target.Label, "succeeded", 1, 1, 0, 1, []), [], NeedsCommit: false));
            });

            var coordinator = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = fakeRunner });
            var active = Enumerable.Range(0, MultiQueryCoordinator.MaxConcurrentRuns)
                .Select(_ => coordinator.ExecuteAsync(new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "fireAndForget", [T("a", c1, "S1")], 1000, 30, Sql: "SELECT 1;"), context: null))
                .ToArray();
            await allEightStarted.Task;

            string? limitCode = null;
            try
            {
                await coordinator.ExecuteAsync(new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "fireAndForget", [T("a", c1, "S1")], 1000, 30, Sql: "SELECT 1;"), context: null);
            }
            catch (RequestException error)
            {
                limitCode = error.Code;
            }
            gate.TrySetResult();
            await Task.WhenAll(active);

            check(limitCode == "SESSION_LIMIT" && coordinator.ActiveRuns == 0,
                "MultiQueryCoordinator enforces global cap of 8 concurrent multi-server runs (SESSION_LIMIT)");
        }

        // 9. autoCombine budget refusal leaves individual server sets intact and surfaces CombineWarnings.
        {
            var fakeRunner = new FakeRunner(Providers.SqlServer, (ctx, _) =>
            {
                var set = OpenFakeSet(service.Results, ctx, slot: 0);
                return Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded", 1, 1, 1, 2, [set.ResultId]), [set], NeedsCommit: false)));
            });
            var refusingCombiner = new FakeCombiner((_, _, _, _, _, _, _) => new CombineOutput(null, ["Combined view skipped: result memory full."]));
            var coordinator = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = fakeRunner }, refusingCombiner);
            var args = new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "fireAndForget", [T("a", c1, "S1"), T("b", c2, "S2")], 1000, 30, Sql: "SELECT 1;");
            var result = await coordinator.ExecuteAsync(args, context: null);

            check(result.Status == "completed" && result.ResultSets.Count == 2 && result.ResultSets.All(r => r.Kind == "rows")
                && result.CombineWarnings is ["Combined view skipped: result memory full."],
                "autoCombine budget refusal preserves individual server results and reports CombineWarnings");
        }

        // 10. Clamping of combineWarnings (<= 64, <= 512 chars) and MultiTargetError (<= 64 code, <= 16385 msg), plus surrogate safety.
        {
            var longMsg = new string('x', 20_000);
            var clampedErr = MultiQueryCoordinator.ClampError(new MultiTargetError(new string('E', 100), longMsg));
            check(clampedErr.Code.Length == 64 && clampedErr.Message.Length == 16385 && clampedErr.Message.EndsWith("…", StringComparison.Ordinal),
                "MultiQueryCoordinator.ClampError caps Code to 64 and Message to 16385");

            var surrogateText = new string('a', 510) + "😀tail";
            var clampedText = MultiQueryCoordinator.ClampText(surrogateText, 512);
            check(clampedText.Length <= 512 && !char.IsHighSurrogate(clampedText[^2]),
                "MultiQueryCoordinator.ClampText never splits a UTF-16 surrogate pair");

            var fakeRunner = new FakeRunner(Providers.SqlServer, (ctx, _) =>
            {
                var set = OpenFakeSet(service.Results, ctx, slot: 0);
                return Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded", 1, 1, 1, 2, [set.ResultId]), [set], NeedsCommit: false)));
            });
            var noisyCombiner = new FakeCombiner((_, _, _, _, _, _, _) =>
                new CombineOutput(null, [.. Enumerable.Range(0, 80).Select(i => $"Warning {i}: " + new string('w', 600))]));
            var coordinator = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = fakeRunner }, noisyCombiner);
            var args = new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "fireAndForget", [T("a", c1, "S1"), T("b", c2, "S2")], 1000, 30, Sql: "SELECT 1;");
            var res = await coordinator.ExecuteAsync(args, context: null);
            check(res.CombineWarnings is { Count: 64 } && res.CombineWarnings.All(w => w.Length is > 0 and <= 512),
                "FinalizeResult clamps combineWarnings to at most 64 entries of <= 512 chars");
        }

        // 11. Disconnect TOCTOU: disconnected provider returns NOT_CONNECTED instead of silently routing to SqlServer.
        {
            var calls = 0;
            var fakeRunner = new FakeRunner(Providers.SqlServer, (ctx, _) =>
                Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded", 1, 1, 0, 1, []), [], NeedsCommit: false))));
            var coordinator = new MultiQueryCoordinator(
                service,
                new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = fakeRunner },
                providerOf: id => ++calls <= 2 ? Providers.SqlServer : null);
            var args = new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "fireAndForget", [T("a", c1, "S1"), T("b", c2, "S2")], 1000, 30, Sql: "SELECT 1;");
            string? toctouCode = null;
            try { await coordinator.ExecuteAsync(args, context: null); }
            catch (RequestException error) { toctouCode = error.Code; }
            check(toctouCode == "NOT_CONNECTED",
                $"MultiQueryCoordinator re-verifies target connectivity after Register() to close disconnect TOCTOU ({toctouCode})");
        }

        // 12. Pre-flight timeout is classified as timedOut (TIMEOUT) and logs an error message.
        {
            var slowPreflightRunner = new FakeRunner(
                Providers.SqlServer,
                (_, _) => Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome("a", Providers.SqlServer, "S1", "succeeded", 1, 1, 0, 1, []), [], NeedsCommit: false))),
                preflight: async (_, token) => { await Task.Delay(TimeSpan.FromSeconds(5), token); return []; });
            var coordinator = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = slowPreflightRunner });
            var args = new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "fireAndForget", [T("a", c1, "S1")], 1000, TimeoutSeconds: 1, Sql: "SELECT 1;");
            var res = await coordinator.ExecuteAsync(args, context: null);
            check(res.Status == "timedOut" && res.Targets[0].Status == "timedOut" && res.Targets[0].Error?.Code == "TIMEOUT"
                && res.Messages.Any(m => m.Kind == QueryMessages.Error),
                $"Pre-flight timeout classifies as timedOut/TIMEOUT and logs a Messages error ({res.Status}/{res.Targets[0].Error?.Code})");
        }

        // 13. Additional ReadOnlySqlValidator checks: CTE + DELETE and compound assignment SELECT @v += 1.
        {
            var validator = new ReadOnlySqlValidator();
            var cteDelete = await validator.ValidateTSqlAsync("WITH c AS (SELECT 1 AS x) DELETE FROM dbo.T WHERE x IN (SELECT x FROM c);", 1, CancellationToken.None);
            var assignVar = await validator.ValidateTSqlAsync("SELECT @v += 1;", 1, CancellationToken.None);
            check(cteDelete.Count > 0 && assignVar.Count > 0,
                "ReadOnlySqlValidator rejects CTE + DELETE and SELECT @v += 1");
        }

        // 14. EstimateCombinedDescriptorBytes accounts for real column name/type/collation sizes.
        {
            var wideStore = new ResultStore(1L << 28, 1L << 27);
            var wideBudget = wideStore.BeginQuery("wide-est");
            var wideCols = Enumerable.Range(0, 200).Select(i =>
                new ResultColumn("col_" + i + "_" + new string('n', 80), "nvarchar(4000)", "text", Collation: new ResultCollation(1033, 0, 0, false, 0))).ToList();
            var s1 = wideStore.Open(wideBudget, 0, 1, 1, "rows", wideCols, [.. Enumerable.Repeat(WireKind.Text, 200)], targetKey: "a", targetLabel: "S1", statementSlot: 0)!;
            s1.Complete();
            var s2 = wideStore.Open(wideBudget, 1, 1, 1, "rows", wideCols, [.. Enumerable.Repeat(WireKind.Text, 200)], targetKey: "b", targetLabel: "S2", statementSlot: 0)!;
            s2.Complete();
            var est = MultiQueryCoordinator.EstimateCombinedDescriptorBytes([s1, s2], "MyResult");
            var actual = ColumnPlan.DescriptorBytesOf(wideCols);
            check(est >= actual, $"EstimateCombinedDescriptorBytes ({est}) covers actual ColumnPlan.DescriptorBytesOf ({actual})");
        }

        // 15. INVOKE_EXTERNAL_API blocked by ReadOnlySqlValidator, null sqlValidator fails closed, context.Unsent releases sets,
        // and MultiCommitOutcome.Refused marks RolledBackPreview.
        {
            var validator = new ReadOnlySqlValidator();
            var extApi = await validator.ValidateTSqlAsync("SELECT INVOKE_EXTERNAL_API('MySet', 'MyFn', 1);", 1, CancellationToken.None);
            check(extApi.Count > 0 && extApi.Any(v => v.Keyword == "INVOKE_EXTERNAL_API"),
                "ReadOnlySqlValidator rejects INVOKE_EXTERNAL_API");

            var fakeSqlRunner = new FakeRunner(Providers.SqlServer, (_, _) =>
                Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome("a", Providers.SqlServer, "S1", "succeeded", 1, 1, 0, 1, []), [], NeedsCommit: false))));
            var fakeBqRunner = new FakeRunner(Providers.BigQuery, (_, _) =>
                Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome("b", Providers.BigQuery, "BQ1", "succeeded", 1, 1, 0, 1, []), [], NeedsCommit: false))));
            // Omitting sqlValidator still defaults to ReadOnlySqlValidator (never fails open).
            var failClosed = new MultiQueryCoordinator(
                service,
                new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = fakeSqlRunner, [Providers.BigQuery] = fakeBqRunner },
                providerOf: id => id == c1 ? Providers.SqlServer : Providers.BigQuery);
            var ceArgs = new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "crossEngineReadOnly",
                [T("a", c1, "S1"), T("b", c2, "BQ1")], 1000, 30,
                Scripts: new MultiQueryScripts("DELETE FROM dbo.T;", "SELECT 1"));
            var ceRes = await failClosed.ExecuteAsync(ceArgs, context: null);
            check(ceRes.Status == "failed" && ceRes.Targets[0].Error?.Code == "READ_ONLY_VIOLATION",
                $"MultiQueryCoordinator fails closed on crossEngineReadOnly even when sqlValidator parameter is omitted ({ceRes.Status}/{ceRes.Targets[0].Error?.Code})");

            // context.Unsent releases all stored ResultSetBuffers if response framing fails, and Refused commit marks RolledBackPreview.
            ResultSetBuffer? refSet = null;
            var refusedCommitRunner = new FakeRunner(Providers.SqlServer, (ctx, _) =>
            {
                var set = OpenFakeSet(service.Results, ctx, slot: 0);
                refSet = set;
                var handle = new FakePhase2Handle(
                    onCommit: _ => Task.FromResult(new MultiCommitResult(MultiCommitOutcome.Refused, new MultiTargetError("SQL_ERROR", "refused"))),
                    onRollback: _ => Task.CompletedTask);
                return Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded", 1, 1, 1, 1, [set.ResultId]), [set], NeedsCommit: true), handle));
            });
            using var reqCtx = new RequestContext(2, "query.executeMulti", RequestLane.Query, 0);
            var refCoord = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = refusedCommitRunner });
            var refRes = await refCoord.ExecuteAsync(new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "transaction", [T("a", c1, "S1")], 1000, 30, Sql: "SELECT 1;"), reqCtx);
            check(refRes.Status == "failed" && refSet is { RolledBackPreview: true } && reqCtx.Unsent is not null,
                "MultiCommitOutcome.Refused marks RolledBackPreview and registers context.Unsent");
            reqCtx.Unsent!.Invoke();
            check(refSet!.IsReleased, "Invoking context.Unsent releases all stored ResultSetBuffers");
        }

        // 16. Round 3 hardening & coverage checks: external AI rejection, MultiQueryQuota, single-parse crossEngineReadOnly,
        // single terminal event on OCE, sequential cancel (not skipped), partialFailure, completedWithErrors, DispatchAsync, SessionLimit.
        {
            // (a) ReadOnlySqlValidator rejects all 8 external AI model calls (specialized & FunctionCall forms) and sys.INVOKE_EXTERNAL_API
            var aiValidator = new ReadOnlySqlValidator();
            var aiViolations = await aiValidator.ValidateTSqlAsync("SELECT AI_GENERATE_EMBEDDINGS(N'hello' USE MODEL MyModel);", 1, CancellationToken.None);
            check(aiViolations.Count > 0 && aiViolations.Any(v => v.Keyword == "EXTERNAL_AI_CALL"),
                "ReadOnlySqlValidator rejects AI_GENERATE_EMBEDDINGS external model call");
            foreach (var aiSql in new[]
            {
                "SELECT AI_GENERATE_RESPONSE(N'hi');",
                "SELECT AI_ANALYZE_SENTIMENT(N'hi');",
                "SELECT AI_CLASSIFY(N'hi', N'a,b');",
                "SELECT AI_EXTRACT(N'hi', N'name');",
                "SELECT AI_FIX_GRAMMAR(N'hi');",
                "SELECT AI_SUMMARIZE(N'hi');",
                "SELECT AI_TRANSLATE(N'hi', N'es');"
            })
            {
                var vs = await aiValidator.ValidateTSqlAsync(aiSql, 1, CancellationToken.None);
                check(vs.Any(v => v.Keyword == "EXTERNAL_AI_CALL"), $"ReadOnlySqlValidator rejects plain FunctionCall {aiSql}");
            }
            var sysExt = await aiValidator.ValidateTSqlAsync("SELECT sys.INVOKE_EXTERNAL_API('a', 'b', 1);", 1, CancellationToken.None);
            check(sysExt.Any(v => v.Keyword == "INVOKE_EXTERNAL_API"), "ReadOnlySqlValidator rejects sys.INVOKE_EXTERNAL_API");

            // (a2) BatchHasExecuteStatementAsync catches EXEC, implicit proc calls, and INSERT ... EXEC while allowing THROW and (SELECT 1/0)
            check(!await SqlServerMultiRunner.BatchHasExecuteStatementAsync(SqlScript.Parse("THROW 50001, 'err', 1;", 1)[0], CancellationToken.None)
                && !await SqlServerMultiRunner.BatchHasExecuteStatementAsync(SqlScript.Parse("(SELECT 1/0);", 1)[0], CancellationToken.None)
                && await SqlServerMultiRunner.BatchHasExecuteStatementAsync(SqlScript.Parse("dbo.MyProc;", 1)[0], CancellationToken.None)
                && await SqlServerMultiRunner.BatchHasExecuteStatementAsync(SqlScript.Parse("INSERT INTO dbo.T EXEC dbo.MyProc;", 1)[0], CancellationToken.None),
                "BatchHasExecuteStatementAsync distinguishes safe THROW/(SELECT 1/0) from dbo.MyProc and INSERT ... EXEC");

            // (a3) Transaction pre-flight rejects variable-named ROLLBACK TRANSACTION @sp (while allowing literal savepoints)
            var txRunner = new SqlServerMultiRunner(service);
            var txBudget = service.Results.BeginQuery("tx-rb-var");
            using var txEvents = new QueryEventSink(null);
            var txMsgs = new QueryMessages(txEvents.Message);
            var rbVarCtx = new MultiTargetContext(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "transaction", false,
                T("t1", c1, "S1"), Providers.SqlServer, "DECLARE @sp sysname = NULL; ROLLBACK TRANSACTION @sp;",
                1, 1, 1000, 10, 30, false, false, null, null, null, null, new MultiQueryQuota(10, 1 << 20), () => false, txBudget, txMsgs, txEvents);
            var rbVarPre = await txRunner.PreflightAsync([rbVarCtx], CancellationToken.None);
            check(!rbVarPre[0].Passed && rbVarPre[0].Error?.Code == "INVALID_SCRIPT",
                "Transaction pre-flight rejects variable-named ROLLBACK TRANSACTION @sp");
            check(MultiQueryCoordinator.ClampText("😀abc", 1) == "",
                "ClampText(maxChars: 1) never splits leading UTF-16 surrogate pair");

            // (b) MultiQueryQuota count cap, descriptor byte cap, Release recycling & idempotency
            var quota = new MultiQueryQuota(maxResultSets: 2, maxSummaryDescriptorBytes: 100);
            check(quota.TryAllocate(60, out var qi0, out var ov0) && qi0 == 0 && !ov0, "MultiQueryQuota allocates slot 0");
            check(!quota.TryAllocate(50, out _, out var ov1) && ov1, "MultiQueryQuota enforces descriptor byte cap");
            check(quota.TryAllocate(40, out var qi1, out var ov2) && qi1 == 1 && !ov2, "MultiQueryQuota allocates slot 1 up to exact cap");
            check(!quota.TryAllocate(0, out _, out var ov3) && !ov3, "MultiQueryQuota enforces count cap");
            quota.Release(0, 60);
            quota.Release(0, 60); // idempotent duplicate release
            check(quota.KeptResultSets == 1 && quota.TryAllocate(60, out var qiReused, out _) && qiReused == 0,
                "MultiQueryQuota.Release recycles index idempotently");

            // (c) crossEngineReadOnly invokes ValidateTSqlAsync exactly once (not 2 + N) via ReadOnlyValidated
            var parseCalls = 0;
            var countingValidator = new CountingSqlValidator(() => Interlocked.Increment(ref parseCalls));
            var sqlRunCount = 0;
            var realSqlRunner = new FakeRunner(Providers.SqlServer, (ctx, _) =>
            {
                if (!ctx.ReadOnlyValidated) Interlocked.Increment(ref parseCalls);
                Interlocked.Increment(ref sqlRunCount);
                return Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded", 1, 1, 0, 1, []), [], NeedsCommit: false)));
            }, preflight: (ts, _) =>
            {
                if (ts.Any(t => !t.ReadOnlyValidated)) Interlocked.Increment(ref parseCalls);
                return Task.FromResult<IReadOnlyList<MultiTargetPreflightOutcome>>([.. ts.Select(t => new MultiTargetPreflightOutcome(t.Target.TargetKey, true))]);
            });
            var okBqRunner = new FakeRunner(Providers.BigQuery, (ctx, _) =>
                Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded", 1, 1, 0, 1, []), [], NeedsCommit: false))));
            var onceCoord = new MultiQueryCoordinator(service,
                new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = realSqlRunner, [Providers.BigQuery] = okBqRunner },
                sqlValidator: countingValidator,
                providerOf: id => id == c2 ? Providers.BigQuery : Providers.SqlServer);
            var onceRes = await onceCoord.ExecuteAsync(new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "crossEngineReadOnly",
                [T("s1", c1, "S1"), T("s2", c1, "S2"), T("b1", c2, "BQ1")], 1000, 30,
                Scripts: new MultiQueryScripts("SELECT 1;", "SELECT 1;")), context: null);
            check(onceRes.Status == "completed" && parseCalls == 1 && sqlRunCount == 2,
                $"crossEngineReadOnly validates T-SQL once across 2 SQL targets (calls={parseCalls}, runs={sqlRunCount})");

            // (d) Runner throwing OperationCanceledException on timeout emits exactly ONE terminal event (timedOut)
            var termEvents = new List<MultiQueryTargetStateEvent>();
            var oceRunner = new FakeRunner(Providers.SqlServer, async (_, tok) =>
            {
                await Task.Delay(TimeSpan.FromSeconds(10), tok);
                throw new InvalidOperationException("unreachable");
            });
            var oceCoord = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = oceRunner });
            using var oceCtx = new RequestContext(3, "query.executeMulti", RequestLane.Query, 0, sendEvent: (_, e, _) =>
            {
                if (e is MultiQueryTargetStateEvent ts && ts.Phase is not ("queued" or "preflight" or "running" or "committing"))
                    termEvents.Add(ts);
            });
            var oceRes = await oceCoord.ExecuteAsync(new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "fireAndForget",
                [T("t1", c1, "S1")], 1000, TimeoutSeconds: 1, Sql: "SELECT 1;"), oceCtx);
            check(oceRes.Status == "timedOut" && termEvents.Count == 1 && termEvents[0].Phase == "timedOut",
                $"Runner OCE on timeout emits single timedOut terminal event (status={oceRes.Status}, events={termEvents.Count}/{termEvents.FirstOrDefault()?.Phase})");

            // (e) Sequential Fire-and-Forget cancellation marks remaining target cancelled (NOT skipped)
            var seqQueryId = Guid.NewGuid().ToString();
            using var seqCtx = new RequestContext(4, "query.executeMulti", RequestLane.Query, 0);
            var seqRunner = new FakeRunner(Providers.SqlServer, (ctx, tok) =>
            {
                if (ctx.Target.TargetKey == "seq1")
                {
                    seqCtx.Cancel(CancelReason.User);
                    tok.ThrowIfCancellationRequested();
                }
                return Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded", 1, 1, 0, 1, []), [], NeedsCommit: false)));
            });
            var seqCoord = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = seqRunner });
            var seqRes = await seqCoord.ExecuteAsync(new QueryMultiArgs(seqQueryId, Guid.NewGuid().ToString(), "fireAndForget",
                [T("seq1", c1, "S1"), T("seq2", c2, "S2")], 1000, 30, Sequential: true, Sql: "SELECT 1;"), seqCtx);
            check(seqRes.Status == "cancelled" && seqRes.Targets[1].Status == "cancelled",
                $"Sequential Fire-and-Forget cancel marks remaining targets cancelled, not skipped ({seqRes.Status}/{seqRes.Targets[1].Status})");

            // (f) partialFailure (1 committed + 1 refused) and completedWithErrors (Fire-and-Forget 1 succeeded + 1 failed)
            var pfRunner = new FakeRunner(Providers.SqlServer, (ctx, _) =>
            {
                var outcome = ctx.Target.TargetKey == "p1"
                    ? new MultiCommitResult(MultiCommitOutcome.Committed)
                    : new MultiCommitResult(MultiCommitOutcome.Refused, new MultiTargetError("SQL_ERROR", "refused"));
                var handle = new FakePhase2Handle(_ => Task.FromResult(outcome), _ => Task.CompletedTask);
                return Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded", 1, 1, 1, 1, []), [], NeedsCommit: true), handle));
            });
            var pfCoord = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = pfRunner });
            var pfRes = await pfCoord.ExecuteAsync(new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "transaction",
                [T("p1", c1, "S1"), T("p2", c2, "S2")], 1000, 30, Sql: "UPDATE dbo.T SET x = 1;"), context: null);
            check(pfRes.Status == "partialFailure" && pfRes.Targets[0].Status == "committed" && pfRes.Targets[1].Status == "failed",
                $"Transaction 1 committed + 1 refused produces partialFailure ({pfRes.Status})");

            var ffPartialRunner = new FakeRunner(Providers.SqlServer, (ctx, _) =>
            {
                var failed = ctx.Target.TargetKey == "e2";
                return Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, failed ? "failed" : "succeeded",
                        1, 1, 0, 1, [], Error: failed ? new MultiTargetError("SQL_ERROR", "boom") : null), [], NeedsCommit: false)));
            });
            var ffPartialCoord = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = ffPartialRunner });
            var ffPartialRes = await ffPartialCoord.ExecuteAsync(new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "fireAndForget",
                [T("e1", c1, "S1"), T("e2", c2, "S2")], 1000, 30, Sql: "SELECT 1;"), context: null);
            check(ffPartialRes.Status == "partialFailure", $"Fire-and-Forget 1 succeeded + 1 failed produces partialFailure ({ffPartialRes.Status})");

            var cweRunner = new FakeRunner(Providers.SqlServer, (ctx, _) =>
            {
                var nonFatalErr = ctx.Target.TargetKey == "e2" ? new MultiTargetError("SQL_ERROR", "non-fatal batch error") : null;
                return Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded",
                        2, 2, 0, 1, [], Error: nonFatalErr), [], NeedsCommit: false)));
            });
            var cweCoord = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = cweRunner });
            var cweRes = await cweCoord.ExecuteAsync(new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "fireAndForget",
                [T("e1", c1, "S1"), T("e2", c2, "S2")], 1000, 30, Sql: "SELECT 1;\nGO\nSELECT 2;"), context: null);
            check(cweRes.Status == "completedWithErrors", $"Fire-and-Forget all succeeded with non-fatal batch error produces completedWithErrors ({cweRes.Status})");

            // (g) SqlService.DispatchAsync("query.executeMulti", ...) validates parameters & AcquireEphemeralSqlSlot honors SessionLimit
            var wire = new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web);
            using var badDoc = System.Text.Json.JsonDocument.Parse(System.Text.Json.JsonSerializer.Serialize(new
            {
                queryId = Guid.NewGuid().ToString(), sessionId = Guid.NewGuid().ToString(),
                mode = "bogusMode", targets = new[] { new { targetKey = "k1", connectionId = c1, label = "S1" } }, sql = "SELECT 1;"
            }, wire));
            var badDispatchCode = "";
            try { await service.DispatchAsync("query.executeMulti", badDoc.RootElement.Clone(), wire, null); }
            catch (RequestException ex) { badDispatchCode = ex.Code; }
            check(badDispatchCode == "INVALID_PARAMS", $"SqlService query.executeMulti rejects invalid mode ({badDispatchCode})");

            using var slotSvc = new SqlService(new ResultStore(1L << 22, 1L << 21));
            var limit = slotSvc.SessionLimit;
            for (var i = 0; i < limit; i++) slotSvc.AcquireEphemeralSqlSlot(limit);
            var slotErr = "";
            try { slotSvc.AcquireEphemeralSqlSlot(limit); }
            catch (RequestException ex) { slotErr = ex.Code; }
            for (var i = 0; i < limit; i++) slotSvc.ReleaseEphemeralSqlSlot();
            check(slotErr == "SESSION_LIMIT", $"AcquireEphemeralSqlSlot enforces SessionLimit ({slotErr})");

            // (h) Round 6 hardening checks:
            // - ReadOnlySqlValidator rejects 3-part db.sys.* external API / AI calls
            var roVal = new ReadOnlySqlValidator();
            var threePartExt = await roVal.ValidateTSqlAsync("SELECT master.sys.INVOKE_EXTERNAL_API('a', 'b', 1);", 1, CancellationToken.None);
            var threePartAi = await roVal.ValidateTSqlAsync("SELECT master.sys.AI_GENERATE_EMBEDDINGS(N'x');", 1, CancellationToken.None);
            check(threePartExt.Count > 0 && threePartAi.Count > 0,
                $"ReadOnlySqlValidator rejects 3-part db.sys.INVOKE_EXTERNAL_API and AI_* calls ({threePartExt.Count}/{threePartAi.Count})");

            // - SqlServerMultiRunner pre-flight rejects ALTER DATABASE SCOPED CONFIGURATION in transaction mode
            var sqlRunner = new SqlServerMultiRunner(service);
            var scopedBudget = service.Results.BeginQuery(Guid.NewGuid().ToString());
            using var scopedEvents = new QueryEventSink(null);
            var scopedMessages = new QueryMessages(scopedEvents.Message);
            var scopedCtx = new MultiTargetContext(
                Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "transaction", false,
                T("sc1", c1, "S1"), Providers.SqlServer, "ALTER DATABASE SCOPED CONFIGURATION SET MAXDOP = 2;",
                1, 1, 1000, 100, 30, true, false, null, null, null, Guid.NewGuid().ToString(),
                new MultiQueryQuota(100, 8L << 20), () => false, scopedBudget, scopedMessages, scopedEvents);
            var scopedPre = await sqlRunner.PreflightAsync([scopedCtx], CancellationToken.None);
            check(!scopedPre[0].Passed && (scopedPre[0].Error?.Message.Contains("ALTER DATABASE", StringComparison.OrdinalIgnoreCase) ?? false),
                "SqlServerMultiRunner rejects ALTER DATABASE SCOPED CONFIGURATION in transaction mode");

            // - SqlServerMultiRunner defense-in-depth validates crossEngineReadOnly when ReadOnlyValidated == false and handles bad SqlScript.Parse cleanly
            var unvalCtx = scopedCtx with { Mode = "crossEngineReadOnly", Sql = "DELETE FROM dbo.T;", ReadOnlyValidated = false };
            var unvalRes = await sqlRunner.ExecutePhase1Async(unvalCtx, CancellationToken.None);
            check(unvalRes.Result.Outcome.Status == "failed" && unvalRes.Result.Outcome.Error?.Code == "READ_ONLY_VIOLATION",
                $"SqlServerMultiRunner refuses unvalidated crossEngineReadOnly DML ({unvalRes.Result.Outcome.Status}/{unvalRes.Result.Outcome.Error?.Code})");

            var badBatchCtx = scopedCtx with { Mode = "fireAndForget", Sql = "SELECT 1;\nGO 999999999999999999999" };
            var badBatchRes = await sqlRunner.ExecutePhase1Async(badBatchCtx, CancellationToken.None);
            check(badBatchRes.Result.Outcome.Status == "failed" && badBatchRes.Result.Outcome.Error?.Code == "INVALID_SCRIPT",
                $"SqlServerMultiRunner handles SqlScript.Parse failure cleanly ({badBatchRes.Result.Outcome.Status}/{badBatchRes.Result.Outcome.Error?.Code})");

            // - ComputeOverallStatus does not override all-failed or all-timedOut to cancelled on late UserCancelled
            using var lateCts = new CancellationTokenSource();
            var lateRun = new SqlService.RunningQuery(new HashSet<string> { c1 }, "s1", lateCts);
            lateRun.Cancel();
            var allFailed = new[] { new MultiTargetOutcome("f1", Providers.SqlServer, "S1", "failed", 0, 1, 0, 1, [], Error: new("SQL_ERROR", "err")) };
            var allTimedOut = new[] { new MultiTargetOutcome("t1", Providers.SqlServer, "S1", "timedOut", 0, 1, 0, 1, [], Error: new("TIMEOUT", "to")) };
            check(MultiQueryCoordinator.ComputeOverallStatus("fireAndForget", allFailed, lateRun) == "failed"
                && MultiQueryCoordinator.ComputeOverallStatus("transaction", allFailed, lateRun) == "failed"
                && MultiQueryCoordinator.ComputeOverallStatus("fireAndForget", allTimedOut, lateRun) == "timedOut"
                && MultiQueryCoordinator.ComputeOverallStatus("transaction", allTimedOut, lateRun) == "timedOut",
                "ComputeOverallStatus preserves failed/timedOut even when late UserCancelled arrives");

            // - Stage 3 does not rewrite externally-cancelled target or emit duplicate terminal events when a peer times out
            var extRunner = new FakeRunner(Providers.SqlServer, async (ctx, ct) =>
            {
                if (ctx.Target.TargetKey == "ext1")
                {
                    var err = new MultiTargetError("CANCELLED", "Externally cancelled job");
                    ctx.Events.TargetState(new MultiQueryTargetStateEvent("ext1", "cancelled", 0, 1, 0, 0, 1, ErrorCode: err.Code, ErrorMessage: err.Message));
                    return new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                        new MultiTargetOutcome("ext1", ctx.Provider, ctx.Target.Label, "cancelled", 0, 1, 0, 1, [], Error: err), [], NeedsCommit: false));
                }
                await Task.Delay(Timeout.Infinite, ct);
                throw new InvalidOperationException("unreachable");
            });
            var extCoord = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = extRunner });
            var extRes = await extCoord.ExecuteAsync(new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "fireAndForget",
                [T("ext1", c1, "S1"), T("ext2", c2, "S2")], 1000, TimeoutSeconds: 1, Sql: "SELECT 1;"), context: null);
            check(extRes.Targets[0].Status == "cancelled" && extRes.Targets[0].Error?.Message == "Externally cancelled job"
                && extRes.Targets[1].Status == "timedOut",
                $"Stage 3 preserves externally-cancelled target when peer times out ({extRes.Targets[0].Status}/{extRes.Targets[1].Status})");

            // - RunAutoCombineAsync skips mixed committed + rolledBack (partialFailure) and commitInDoubt + rolledBack slots
            var mixCombinedCalled = 0;
            var mixCombiner = new FakeCombiner((_, _, _, _, _, _, _) => { mixCombinedCalled++; return new CombineOutput(null, []); });
            var mixRunner = new FakeRunner(Providers.SqlServer, (ctx, _) =>
            {
                var set = OpenFakeSet(service.Results, ctx, slot: 0);
                var phase2 = new FakePhase2Handle(
                    onCommit: _ => Task.FromResult(ctx.Target.TargetKey == "m1"
                        ? new MultiCommitResult(MultiCommitOutcome.Committed)
                        : new MultiCommitResult(MultiCommitOutcome.Refused, new MultiTargetError("SQL_ERROR", "commit failed"))),
                    onRollback: _ => Task.CompletedTask);
                return Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded", 1, 1, 1, 1, [set.ResultId]),
                    [set], NeedsCommit: true), phase2));
            });
            var mixCoord = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = mixRunner }, combiner: mixCombiner);
            var mixRes = await mixCoord.ExecuteAsync(new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "transaction",
                [T("m1", c1, "S1"), T("m2", c2, "S2")], 1000, 30, Sql: "SELECT 1;", AutoCombine: true), context: null);
            check(mixRes.Status == "partialFailure" && mixCombinedCalled == 0 && (mixRes.CombineWarnings?.Any(w => w.Contains("mixed transaction outcomes", StringComparison.OrdinalIgnoreCase)) ?? false),
                $"RunAutoCombineAsync skips mixed committed+rolledBack slot (called={mixCombinedCalled}, warnings={mixRes.CombineWarnings?.Count ?? 0})");

            // - Phase 2 CommitAsync CancelledBeforeSend with !UserCancelled maps to timedOut/TIMEOUT
            var p2TimeoutRunner = new FakeRunner(Providers.SqlServer, (ctx, _) =>
            {
                var phase2 = new FakePhase2Handle(
                    onCommit: _ => Task.FromResult(new MultiCommitResult(MultiCommitOutcome.CancelledBeforeSend, new MultiTargetError("TIMEOUT", "timed out"))),
                    onRollback: _ => Task.CompletedTask);
                return Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded", 1, 1, 0, 1, []),
                    [], NeedsCommit: true), phase2));
            });
            var p2TimeoutCoord = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = p2TimeoutRunner });
            var p2TimeoutRes = await p2TimeoutCoord.ExecuteAsync(new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "transaction",
                [T("pt1", c1, "S1")], 1000, 30, Sql: "SELECT 1;"), context: null);
            check(p2TimeoutRes.Targets[0].Status == "timedOut" && p2TimeoutRes.Targets[0].Error?.Code == "TIMEOUT",
                $"Phase 2 CommitAsync CancelledBeforeSend without UserCancelled maps to timedOut/TIMEOUT ({p2TimeoutRes.Targets[0].Status}/{p2TimeoutRes.Targets[0].Error?.Code})");

            // - > 8 target throttle waiter yields skipped on peer failure in transaction mode
            var tenTargets = Enumerable.Range(1, 10).Select(idx => T($"th{idx}", idx % 2 == 0 ? c2 : c1, $"S{idx}")).ToArray();
            var thStarted = 0;
            var thRunner = new FakeRunner(Providers.SqlServer, async (ctx, ct) =>
            {
                var order = Interlocked.Increment(ref thStarted);
                if (order == 8)
                {
                    return new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                        new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "failed", 0, 1, 0, 1, [], Error: new("SQL_ERROR", "boom")), [], NeedsCommit: false));
                }
                await Task.Delay(Timeout.Infinite, ct);
                throw new InvalidOperationException("unreachable");
            });
            var thCoord = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = thRunner });
            var thRes = await thCoord.ExecuteAsync(new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "transaction",
                tenTargets, 1000, 30, Sql: "SELECT 1;"), context: null);
            check(thRes.Targets.Count(t => t.Status == "skipped") == 2,
                $"Transaction throttle waiter (>8 targets) transitions to skipped on peer failure (skipped={thRes.Targets.Count(t => t.Status == "skipped")})");

            // (i) Round 7 hardening checks:
            // - ActiveEphemeralConnections returns to 0 after pre-cancelled and NOT_CONNECTED ExecutePhase1Async calls
            using var preCancel = new CancellationTokenSource();
            preCancel.Cancel();
            var preRes = await sqlRunner.ExecutePhase1Async(scopedCtx with { Mode = "fireAndForget", Sql = "SELECT 1;" }, preCancel.Token);
            var notConnRes = await sqlRunner.ExecutePhase1Async(scopedCtx with { Mode = "fireAndForget", Sql = "SELECT 1;", Target = T("nc1", "missing-conn", "Missing") }, CancellationToken.None);
            check(preRes.Result.Outcome.Status == "cancelled" && notConnRes.Result.Outcome.Status == "failed" && sqlRunner.ActiveEphemeralConnections == 0,
                $"SqlServerMultiRunner ActiveEphemeralConnections returns to 0 on cancel/NOT_CONNECTED (active={sqlRunner.ActiveEphemeralConnections})");

            // - EvaluateTransactionProbeUncertainty decision matrix
            var txValidSame = new TransactionProbeResult(true, 1, 1, 42);
            var txReplaced = new TransactionProbeResult(true, 1, 1, 99);
            var txZero = new TransactionProbeResult(true, 0, 0, null);
            check(!SqlServerMultiRunner.EvaluateTransactionProbeUncertainty(true, 42, txValidSame, xactAbortOn: true, sawTriggerTranEnd: false, isCancellation: false)
                && SqlServerMultiRunner.EvaluateTransactionProbeUncertainty(true, 42, txReplaced, xactAbortOn: true, sawTriggerTranEnd: false, isCancellation: false)
                && !SqlServerMultiRunner.EvaluateTransactionProbeUncertainty(true, 42, txZero, xactAbortOn: true, sawTriggerTranEnd: false, isCancellation: false)
                && SqlServerMultiRunner.EvaluateTransactionProbeUncertainty(true, 42, txZero, xactAbortOn: false, sawTriggerTranEnd: false, isCancellation: false)
                && SqlServerMultiRunner.EvaluateTransactionProbeUncertainty(true, 42, txZero, xactAbortOn: true, sawTriggerTranEnd: true, isCancellation: false)
                && SqlServerMultiRunner.EvaluateTransactionProbeUncertainty(true, 42, txZero, xactAbortOn: true, sawTriggerTranEnd: false, isCancellation: true),
                "EvaluateTransactionProbeUncertainty classifies same/replaced/XACT_ABORT/trigger/cancel accurately");

            // - Pre-flight rejects ALTER DATABASE SCOPED CONFIGURATION CLEAR PROCEDURE_CACHE, COMMIT WORK, ROLLBACK WORK, and OPENROWSET(PROVIDER=...)
            var clearPre = await sqlRunner.PreflightAsync([scopedCtx with { Sql = "ALTER DATABASE SCOPED CONFIGURATION CLEAR PROCEDURE_CACHE;" }], CancellationToken.None);
            var commitWorkPre = await sqlRunner.PreflightAsync([scopedCtx with { Sql = "COMMIT WORK;" }], CancellationToken.None);
            var rollbackWorkPre = await sqlRunner.PreflightAsync([scopedCtx with { Sql = "ROLLBACK WORK;" }], CancellationToken.None);
            var orProviderViol = await roVal.ValidateTSqlAsync("SELECT * FROM OPENROWSET(PROVIDER = 'SQLNCLI', 'Server=x;', 'SELECT 1');", 1, CancellationToken.None);
            check(!clearPre[0].Passed && !commitWorkPre[0].Passed && !rollbackWorkPre[0].Passed && orProviderViol.Count > 0,
                "Pre-flight blocks ALTER DATABASE SCOPED CONFIGURATION CLEAR, COMMIT WORK, ROLLBACK WORK, and OPENROWSET(PROVIDER=...)");

            // - RunAutoCombineAsync combines uniform rolled-back previews (propagating RolledBackPreview) and skips commitInDoubt
            var uniformCombined = (ResultSetBuffer?)null;
            var uniformCombiner = new FakeCombiner((st, bud, srcs, idx, bn, it, name) =>
            {
                var c = st.Open(bud, idx, bn, it, "combined", [new("_server", "nvarchar(256)", "text"), new("v", "int", "text")], [WireKind.Text, WireKind.Text], statementSlot: 0)!;
                c.Complete();
                uniformCombined = c;
                return new CombineOutput(c, []);
            });
            var u1ReachedBarrier = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var uniformRbRunner = new FakeRunner(Providers.SqlServer, async (ctx, _) =>
            {
                if (ctx.Target.TargetKey == "u2") await u1ReachedBarrier.Task;
                var set = OpenFakeSet(service.Results, ctx, slot: 0);
                var phase2 = new FakePhase2Handle(_ => Task.FromResult(new MultiCommitResult(MultiCommitOutcome.Committed)), _ => Task.CompletedTask);
                if (ctx.Target.TargetKey == "u1") u1ReachedBarrier.TrySetResult();
                return new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, ctx.Target.TargetKey == "u1" ? "succeeded" : "failed", 1, 1, 1, 1, [set.ResultId],
                        Error: ctx.Target.TargetKey == "u2" ? new("SQL_ERROR", "fail") : null),
                    [set], NeedsCommit: ctx.Target.TargetKey == "u1"), ctx.Target.TargetKey == "u1" ? phase2 : null);
            });
            var uniformCoord = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = uniformRbRunner }, combiner: uniformCombiner);
            var uniformRes = await uniformCoord.ExecuteAsync(new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "transaction",
                [T("u1", c1, "S1"), T("u2", c2, "S2")], 1000, 30, Sql: "SELECT 1;", AutoCombine: true), context: null);
            check(uniformRes.Status == "rolledBack" && uniformCombined is { RolledBackPreview: true },
                $"RunAutoCombineAsync combines uniform rolled-back previews and marks RolledBackPreview=true ({uniformRes.Status}, rb={uniformCombined?.RolledBackPreview})");

            // (j) Round 8 hardening checks:
            // - AssessTransactionUncertaintyAsync with sessionLost=true returns false for plain DML and true for EXEC or trigger Msg 3609
            using var dummyConn = new Microsoft.Data.SqlClient.SqlConnection();
            Microsoft.Data.SqlClient.SqlInfoMessageEventHandler noopInfo = (_, _) => { };
            var safeDmlBatch = SqlScript.Parse("UPDATE dbo.Orders SET Status = 'Shipped';", 1, [])[0];
            var execBatch = SqlScript.Parse("EXEC dbo.CommitThenDie;", 1, [])[0];
            var lostSafe = await SqlServerMultiRunner.AssessTransactionUncertaintyAsync(dummyConn, noopInfo, true, 1, safeDmlBatch, false, false, sessionLost: true);
            var lostExec = await SqlServerMultiRunner.AssessTransactionUncertaintyAsync(dummyConn, noopInfo, true, 1, execBatch, false, false, sessionLost: true);
            var lostTrig = await SqlServerMultiRunner.AssessTransactionUncertaintyAsync(dummyConn, noopInfo, true, 1, safeDmlBatch, sawTriggerTranEnd: true, false, sessionLost: true);
            check(!lostSafe && lostExec && lostTrig
                && SqlServerMultiRunner.IsSessionLostError(new IOException("drop"), dummyConn)
                && SqlServerMultiRunner.IsSessionLostError(new ObjectDisposedException("sni"), dummyConn),
                $"AssessTransactionUncertaintyAsync sessionLost distinguishes plain DML from EXEC/trigger ({lostSafe}/{lostExec}/{lostTrig})");

            // - Phase 2 CancelledBeforeSend keeps status and error.Code aligned even if late UserCancelled flips before return
            var lateCancelQid = Guid.NewGuid().ToString();
            var lateCancelRunner = new FakeRunner(Providers.SqlServer, (ctx, _) =>
            {
                var phase2 = new FakePhase2Handle(
                    onCommit: async _ =>
                    {
                        await service.DispatchAsync("query.cancel", JsonSerializer.SerializeToElement(new CancelArgs(lateCancelQid), wire), wire);
                        return new MultiCommitResult(MultiCommitOutcome.CancelledBeforeSend, new MultiTargetError("TIMEOUT", "timed out"));
                    },
                    onRollback: _ => Task.CompletedTask);
                return Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded", 1, 1, 0, 1, []),
                    [], NeedsCommit: true), phase2));
            });
            var lateCancelCoord = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = lateCancelRunner });
            var lateCancelRes = await lateCancelCoord.ExecuteAsync(new QueryMultiArgs(lateCancelQid, Guid.NewGuid().ToString(), "transaction",
                [T("lc1", c1, "S1")], 1000, 30, Sql: "SELECT 1;"), context: null);
            check(lateCancelRes.Targets[0].Status == "timedOut" && lateCancelRes.Targets[0].Error?.Code == "TIMEOUT",
                $"Phase 2 CancelledBeforeSend preserves consistent timedOut/TIMEOUT even on late UserCancelled ({lateCancelRes.Targets[0].Status}/{lateCancelRes.Targets[0].Error?.Code})");

            // (k) Round 9 hardening checks:
            // - Phase 1 timeout expiring while Phase 2 Commit is in flight does NOT suppress Stage 4 autoCombine on a completed run
            var postCommitCombined = 0;
            var postCommitCombiner = new FakeCombiner((st, bud, srcs, idx, bn, it, name) =>
            {
                postCommitCombined++;
                var c = st.Open(bud, idx, bn, it, "combined", [new("_server", "nvarchar(256)", "text"), new("v", "int", "text")], [WireKind.Text, WireKind.Text], statementSlot: 0)!;
                c.Complete();
                return new CombineOutput(c, []);
            });
            var postCommitRunner = new FakeRunner(Providers.SqlServer, (ctx, _) =>
            {
                var set = OpenFakeSet(service.Results, ctx, slot: 0);
                var phase2 = new FakePhase2Handle(
                    onCommit: async _ =>
                    {
                        await Task.Delay(1200);
                        return new MultiCommitResult(MultiCommitOutcome.Committed);
                    },
                    onRollback: _ => Task.CompletedTask);
                return Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded", 1, 1, 1, 1, [set.ResultId]),
                    [set], NeedsCommit: true), phase2));
            });
            var postCommitCoord = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = postCommitRunner }, combiner: postCommitCombiner);
            var postCommitRes = await postCommitCoord.ExecuteAsync(new QueryMultiArgs(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "transaction",
                [T("pc1", c1, "S1"), T("pc2", c2, "S2")], 1000, TimeoutSeconds: 1, Sql: "SELECT 1;", AutoCombine: true), context: null);
            check(postCommitRes.Status == "completed" && postCommitCombined == 1,
                $"Expiring Phase 1 timer during Phase 2 Commit does not suppress Stage 4 autoCombine ({postCommitRes.Status}, combined={postCommitCombined})");

            // - ComputeOverallStatus with empty outcomes returns cancelled when UserCancelled and failed otherwise (never vacuously completed)
            using var emptyNotCancelCts = new CancellationTokenSource();
            var emptyNotCancelRun = new SqlService.RunningQuery(new HashSet<string> { c1 }, "s-empty", emptyNotCancelCts);
            check(MultiQueryCoordinator.ComputeOverallStatus("transaction", [], lateRun) == "cancelled"
                && MultiQueryCoordinator.ComputeOverallStatus("fireAndForget", [], lateRun) == "cancelled"
                && MultiQueryCoordinator.ComputeOverallStatus("transaction", [], emptyNotCancelRun) == "failed"
                && MultiQueryCoordinator.ComputeOverallStatus("fireAndForget", [], emptyNotCancelRun) == "failed",
                "ComputeOverallStatus handles empty outcomes without vacuous completed");

            // - Post-preflight / pre-start cancellation in sequential mode logs error to Messages
            var postPreQid = Guid.NewGuid().ToString();
            var postPreRunner = new FakeRunner(Providers.SqlServer,
                execute: (ctx, _) => Task.FromResult(new MultiTargetPhase1Outcome(new MultiTargetPhase1Result(
                    new MultiTargetOutcome(ctx.Target.TargetKey, ctx.Provider, ctx.Target.Label, "succeeded", 1, 1, 0, 1, []), [], NeedsCommit: false))),
                preflight: async (targets, _) =>
                {
                    await service.DispatchAsync("query.cancel", JsonSerializer.SerializeToElement(new CancelArgs(postPreQid), wire), wire);
                    return [.. targets.Select(t => new MultiTargetPreflightOutcome(t.Target.TargetKey, Passed: true))];
                });
            var postPreCoord = new MultiQueryCoordinator(service, new Dictionary<string, IMultiTargetRunner> { [Providers.SqlServer] = postPreRunner });
            var postPreRes = await postPreCoord.ExecuteAsync(new QueryMultiArgs(postPreQid, Guid.NewGuid().ToString(), "fireAndForget",
                [T("pp1", c1, "S1")], 1000, 30, Sql: "SELECT 1;", Sequential: true), context: null);
            check(postPreRes.Status == "cancelled" && postPreRes.Messages.Any(m => m.Kind == "error" && m.Text.Contains("cancelled", StringComparison.OrdinalIgnoreCase)),
                $"Post-preflight sequential cancel logs error to Messages (status={postPreRes.Status}, msgs={postPreRes.Messages.Count})");
        }
    }

    private sealed class CountingSqlValidator(Action onCall) : IReadOnlySqlValidator
    {
        public Task<IReadOnlyList<ReadOnlySqlViolation>> ValidateTSqlAsync(string sql, int startLine, CancellationToken token)
        {
            onCall();
            return Task.FromResult<IReadOnlyList<ReadOnlySqlViolation>>([]);
        }
    }

    private static ResultSetBuffer OpenFakeSet(ResultStore store, MultiTargetContext ctx, int slot)
    {
        ctx.Quota.TryAllocate(256, out var index, out _);
        var cols = new List<ResultColumn> { new("v", "int", "text") };
        var set = store.Open(ctx.Budget, index, 1, 1, "rows", cols, [WireKind.Text],
            targetKey: ctx.Target.TargetKey, targetLabel: ctx.Target.Label, targetEnvironment: ctx.Target.Environment,
            targetProvider: ctx.Provider, statementSlot: slot)!;
        set.CountRow();
        var row = set.BeginRow()!;
        row.AppendText("1".AsSpan());
        set.TryCommitRow(0);
        set.Complete();
        ctx.Events.Opened(set);
        ctx.Events.Closed(set);
        return set;
    }

    private sealed class FakeRunner(
        string provider,
        Func<MultiTargetContext, CancellationToken, Task<MultiTargetPhase1Outcome>> execute,
        Func<IReadOnlyList<MultiTargetContext>, CancellationToken, Task<IReadOnlyList<MultiTargetPreflightOutcome>>>? preflight = null) : IMultiTargetRunner
    {
        public string Provider { get; } = provider;

        public Task<IReadOnlyList<MultiTargetPreflightOutcome>> PreflightAsync(IReadOnlyList<MultiTargetContext> targets, CancellationToken token) =>
            preflight is not null
                ? preflight(targets, token)
                : Task.FromResult<IReadOnlyList<MultiTargetPreflightOutcome>>([.. targets.Select(t => new MultiTargetPreflightOutcome(t.Target.TargetKey, Passed: true))]);

        public Task<MultiTargetPhase1Outcome> ExecutePhase1Async(MultiTargetContext target, CancellationToken token) => execute(target, token);
    }

    private sealed class FakePhase2Handle(
        Func<CancellationToken, Task<MultiCommitResult>> onCommit,
        Func<CancellationToken, Task> onRollback) : IMultiTargetPhase2Handle
    {
        public Task<MultiCommitResult> CommitAsync(CancellationToken token) => onCommit(token);
        public Task RollbackAsync(CancellationToken token) => onRollback(token);
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class FakeCombiner(
        Func<ResultStore, QueryBudget, IReadOnlyList<ResultSetBuffer>, int, int, int, string?, CombineOutput> combine) : IResultCombiner
    {
        public Task<CombineOutput> CombineAsync(
            ResultStore store,
            QueryBudget budget,
            IReadOnlyList<ResultSetBuffer> sources,
            int index,
            int batchNumber,
            int iteration,
            string? statementName,
            bool throwOnBudgetRefusal,
            CancellationToken token) =>
            Task.FromResult(combine(store, budget, sources, index, batchNumber, iteration, statementName));
    }

    private sealed class FakeProbeReader(Type[] types, object?[][] rows) : DbDataReader
    {
        private int rowIndex = -1;

        public override int FieldCount => types.Length;
        public override bool HasRows => rows.Length > 0;
        public override bool IsClosed => false;
        public override int RecordsAffected => -1;
        public override int Depth => 0;
        public override object this[int ordinal] => rows[rowIndex][ordinal] ?? DBNull.Value;
        public override object this[string name] => throw new NotSupportedException();
        public override bool Read() => ++rowIndex < rows.Length;
        public override Task<bool> ReadAsync(CancellationToken cancellationToken) => Task.FromResult(Read());
        public override bool NextResult() => false;
        public override Type GetFieldType(int ordinal) => types[ordinal];
        public override bool IsDBNull(int ordinal) => rows[rowIndex][ordinal] is null or DBNull;
        public override short GetInt16(int ordinal) => (short)rows[rowIndex][ordinal]!;
        public override int GetInt32(int ordinal) => (int)rows[rowIndex][ordinal]!;
        public override long GetInt64(int ordinal) => (long)rows[rowIndex][ordinal]!;
        public override string GetString(int ordinal) => (string)rows[rowIndex][ordinal]!;
        public override object GetValue(int ordinal) => rows[rowIndex][ordinal] ?? DBNull.Value;
        public override string GetName(int ordinal) => "c" + ordinal;
        public override string GetDataTypeName(int ordinal) => types[ordinal].Name;
        public override int GetOrdinal(string name) => throw new NotSupportedException();
        public override bool GetBoolean(int ordinal) => (bool)rows[rowIndex][ordinal]!;
        public override byte GetByte(int ordinal) => (byte)rows[rowIndex][ordinal]!;
        public override long GetBytes(int ordinal, long dataOffset, byte[]? buffer, int bufferOffset, int length) => throw new NotSupportedException();
        public override char GetChar(int ordinal) => (char)rows[rowIndex][ordinal]!;
        public override long GetChars(int ordinal, long dataOffset, char[]? buffer, int bufferOffset, int length) => throw new NotSupportedException();
        public override DateTime GetDateTime(int ordinal) => (DateTime)rows[rowIndex][ordinal]!;
        public override decimal GetDecimal(int ordinal) => (decimal)rows[rowIndex][ordinal]!;
        public override double GetDouble(int ordinal) => (double)rows[rowIndex][ordinal]!;
        public override float GetFloat(int ordinal) => (float)rows[rowIndex][ordinal]!;
        public override Guid GetGuid(int ordinal) => (Guid)rows[rowIndex][ordinal]!;
        public override int GetValues(object[] values) => throw new NotSupportedException();
        public override IEnumerator GetEnumerator() => throw new NotSupportedException();
    }
}
