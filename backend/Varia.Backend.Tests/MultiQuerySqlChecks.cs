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
            var fakeRunner = new FakeRunner(Providers.SqlServer, (targetCtx, _) =>
            {
                observedTimeout = targetCtx.TimeoutSeconds;
                if (targetCtx.Target.TargetKey == "a")
                {
                    var set = OpenFakeSet(service.Results, targetCtx, slot: 0);
                    var handle = new FakePhase2Handle(
                        onCommit: _ => Task.FromResult(new MultiCommitResult(MultiCommitOutcome.Committed)),
                        onRollback: _ => { peerRolledBack = true; return Task.CompletedTask; });
                    return Task.FromResult(new MultiTargetPhase1Outcome(
                        new MultiTargetPhase1Result(new MultiTargetOutcome("a", Providers.SqlServer, "S1", "succeeded", 1, 1, 1, 2, [set.ResultId]), [set], NeedsCommit: true), handle));
                }
                var doubtSet = OpenFakeSet(service.Results, targetCtx, slot: 0);
                var doubtErr = new MultiTargetError("SQL_ERROR", "Transaction closed mid-script without error");
                return Task.FromResult(new MultiTargetPhase1Outcome(
                    new MultiTargetPhase1Result(new MultiTargetOutcome("b", Providers.SqlServer, "S2", "commitInDoubt", 1, 1, 0, 2, [doubtSet.ResultId], Error: doubtErr), [doubtSet], NeedsCommit: false)));
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
