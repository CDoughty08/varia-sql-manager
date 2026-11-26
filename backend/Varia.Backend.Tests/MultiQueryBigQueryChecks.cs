using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Web;
using Varia.Backend.BigQuery;
using Varia.Backend.MultiQuery;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>
/// Offline fake-HTTP checks for Multi-Server &amp; Cross-Engine BigQuery execution:
/// GoogleSqlScanner allowlist/blockers, free dry-run pre-flight and estimate.Location, emulator refusal,
/// location resolution before BEGIN TRANSACTION, DML transactions + post-Phase-1 ChildrenAsync verification,
/// structured CommitCoreAsync + mid-insert cancellation + ephemeral session AbortAsync, CrossEngineRunner
/// statementType guard &amp; line rewriting, multi-target residence room division, and rolledBackPreview rerun refusal.
/// </summary>
internal static class MultiQueryBigQueryChecks
{
    static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    const string BaseUrl = @"https://bigquery\.googleapis\.com/bigquery/v2/projects/varia-alpha";

    public static async Task RunAsync(Action<bool, string> check)
    {
        ScannerChecks(check);
        using var rsa = RSA.Create(2048);
        var key = BigQueryCredentialChecks.Key(rsa.ExportPkcs8PrivateKeyPem());
        await DryRunAndLocationChecksAsync(check, key);
        await EmulatorRefusalChecksAsync(check);
        await TransactionAndPhase2ChecksAsync(check, key);
        await CommitCoreChecksAsync(check, key);
        await CrossEngineChecksAsync(check, key);
        await ResidenceAndRolledBackPreviewChecksAsync(check, key);
    }

    static void ScannerChecks(Action<bool, string> check)
    {
        // IsReadOnlySelect: allow single SELECT / WITH ... SELECT with comments, strings, raw/triple strings, backticks, CTEs, parens.
        check(GoogleSqlScanner.IsReadOnlySelect("SELECT 1"), "IsReadOnlySelect allows plain SELECT");
        check(GoogleSqlScanner.IsReadOnlySelect("SELECT 1; -- trailing comment\n"), "IsReadOnlySelect allows trailing semicolon and comment");
        check(GoogleSqlScanner.IsReadOnlySelect("-- header\n# hash\n/* DROP TABLE x; */ SELECT 'INSERT; DELETE', r'\\'; DROP', \"\"\"CALL p();\"\"\", `begin` FROM `proj.ds.t`"),
            "IsReadOnlySelect ignores keywords and semicolons inside comments, strings, raw/triple strings, and backticks");
        check(GoogleSqlScanner.IsReadOnlySelect("WITH cte AS (SELECT 1 AS n) SELECT * FROM cte"), "IsReadOnlySelect allows WITH ... SELECT");
        check(GoogleSqlScanner.IsReadOnlySelect("WITH RECURSIVE a AS (SELECT 1), update AS (SELECT 2) SELECT * FROM a JOIN update"),
            "IsReadOnlySelect allows CTE named after a keyword before SELECT");
        check(GoogleSqlScanner.IsReadOnlySelect("(SELECT 1) UNION ALL (SELECT 2)"), "IsReadOnlySelect allows parenthesized SELECT");
        check(GoogleSqlScanner.IsReadOnlySelect("WITH cte AS (SELECT 1) (SELECT * FROM cte)"), "IsReadOnlySelect allows WITH ... (SELECT)");
        check(GoogleSqlScanner.IsReadOnlySelect("WITH outer_c AS (SELECT 1) (WITH inner_c AS (SELECT * FROM outer_c) SELECT * FROM inner_c)"),
            "IsReadOnlySelect allows nested WITH inside parenthesized main query");

        // IsReadOnlySelect: reject multi-statement, empty, DML, DDL, procedural, CTE + DML.
        check(!GoogleSqlScanner.IsReadOnlySelect(""), "IsReadOnlySelect rejects empty string");
        check(!GoogleSqlScanner.IsReadOnlySelect("-- only comment\n;"), "IsReadOnlySelect rejects comment-only/semicolon-only");
        check(!GoogleSqlScanner.IsReadOnlySelect("SELECT 1; SELECT 2"), "IsReadOnlySelect rejects multi-statement SELECT script");
        check(!GoogleSqlScanner.IsReadOnlySelect("INSERT INTO ds.t VALUES (1)"), "IsReadOnlySelect rejects INSERT");
        check(!GoogleSqlScanner.IsReadOnlySelect("UPDATE ds.t SET a = 1 WHERE TRUE"), "IsReadOnlySelect rejects UPDATE");
        check(!GoogleSqlScanner.IsReadOnlySelect("DELETE FROM ds.t WHERE TRUE"), "IsReadOnlySelect rejects DELETE");
        check(!GoogleSqlScanner.IsReadOnlySelect("CREATE TEMP TABLE t AS SELECT 1"), "IsReadOnlySelect rejects CREATE TEMP TABLE");
        check(!GoogleSqlScanner.IsReadOnlySelect("EXPORT DATA OPTIONS(uri='gs://b/*') AS SELECT 1"), "IsReadOnlySelect rejects EXPORT DATA");
        check(!GoogleSqlScanner.IsReadOnlySelect("CALL ds.my_proc()"), "IsReadOnlySelect rejects CALL");
        check(!GoogleSqlScanner.IsReadOnlySelect("EXECUTE IMMEDIATE 'SELECT 1'"), "IsReadOnlySelect rejects EXECUTE IMMEDIATE");
        check(!GoogleSqlScanner.IsReadOnlySelect("WITH cte AS (SELECT 1) INSERT INTO ds.t SELECT * FROM cte"), "IsReadOnlySelect rejects WITH ... INSERT");
        check(!GoogleSqlScanner.IsReadOnlySelect("FROM ds.t |> SELECT *"), "IsReadOnlySelect enforces strict SELECT/WITH allowlist");

        // FindTransactionBlockers: allow DML, SELECT, CREATE/DROP TEMP TABLE, DROP TABLE _SESSION.*, and BEGIN...END script blocks.
        var allowedTx = """
            -- Permanent DDL inside comment: DROP TABLE ds.t;
            DECLARE x INT64 DEFAULT 1;
            CREATE TEMP TABLE tmp_stage AS SELECT 1 AS id, 'COMMIT TRANSACTION' AS note, '''EXPORT DATA''' AS body, r'\'LOAD DATA' AS raw_s;
            CREATE OR REPLACE TEMPORARY TABLE tmp_stage2 AS SELECT * FROM tmp_stage;
            INSERT INTO ds.orders (id) SELECT id FROM tmp_stage;
            UPDATE ds.orders SET status = 'ok' WHERE id = x;
            DELETE FROM ds.orders WHERE id = 0;
            MERGE ds.orders t USING tmp_stage s ON t.id = s.id WHEN MATCHED THEN DELETE;
            BEGIN
                SET x = 2;
                SELECT `drop`, `call`, `begin` FROM ds.orders;
            END;
            DROP TEMP TABLE tmp_stage;
            DROP TEMPORARY TABLE IF EXISTS tmp_stage2;
            DROP TABLE IF EXISTS _SESSION.tmp_stage;
            DROP TABLE `_SESSION`.tmp_stage;
            DROP TABLE `_SESSION.tmp_stage`;
            """;
        var allowedBlockers = GoogleSqlScanner.FindTransactionBlockers(allowedTx);
        check(allowedBlockers.Count == 0, $"FindTransactionBlockers allows DML, TEMP TABLE, _SESSION.* drops, and BEGIN...END blocks: {string.Join(", ", allowedBlockers)}");

        // FindTransactionBlockers: detect every forbidden statement.
        foreach (var (sql, expectedKeyword, label) in new (string, string, string)[]
        {
            ("CREATE TABLE ds.perm (id INT64);", "CREATE TABLE", "permanent CREATE TABLE"),
            ("CREATE OR REPLACE VIEW ds.v AS SELECT 1;", "CREATE VIEW", "CREATE VIEW"),
            ("CREATE TEMP FUNCTION f(x INT64) AS (x + 1);", "CREATE TEMP FUNCTION", "CREATE TEMP FUNCTION"),
            ("ALTER TABLE ds.t ADD COLUMN c INT64;", "ALTER TABLE", "ALTER TABLE"),
            ("DROP TABLE ds.perm;", "DROP TABLE", "permanent DROP TABLE"),
            ("DROP VIEW ds.v;", "DROP VIEW", "DROP VIEW"),
            ("DROP TEMP FUNCTION f;", "DROP TEMP FUNCTION", "DROP TEMP FUNCTION"),
            ("UNDROP SCHEMA ds;", "UNDROP SCHEMA", "UNDROP SCHEMA"),
            ("BEGIN TRANSACTION;\nINSERT INTO ds.t VALUES (1);", "BEGIN TRANSACTION", "explicit BEGIN TRANSACTION"),
            ("INSERT INTO ds.t VALUES (1);\nCOMMIT TRANSACTION;", "COMMIT TRANSACTION", "explicit COMMIT TRANSACTION"),
            ("INSERT INTO ds.t VALUES (1);\nCOMMIT;", "COMMIT", "explicit COMMIT"),
            ("ROLLBACK TRANSACTION;", "ROLLBACK TRANSACTION", "explicit ROLLBACK TRANSACTION"),
            ("ROLLBACK;", "ROLLBACK", "explicit ROLLBACK"),
            ("EXECUTE IMMEDIATE 'INSERT INTO ds.t VALUES (1)';", "EXECUTE IMMEDIATE", "EXECUTE IMMEDIATE"),
            ("CALL ds.my_proc();", "CALL", "CALL"),
            ("EXPORT DATA OPTIONS(uri='gs://b/*.csv', format='CSV') AS SELECT 1;", "EXPORT DATA", "EXPORT DATA"),
            ("EXPORT TABLE METADATA FROM ds.t OPTIONS(uri='gs://b/*');", "EXPORT TABLE METADATA", "EXPORT TABLE METADATA"),
            ("LOAD DATA INTO ds.t FROM FILES(format='CSV', uris=['gs://b/a.csv']);", "LOAD DATA", "LOAD DATA"),
            ("IF TRUE THEN\n  DROP TABLE ds.nested_perm;\nEND IF;", "DROP TABLE", "permanent DDL nested inside IF block"),
            ("BEGIN\n  EXECUTE IMMEDIATE 'COMMIT TRANSACTION';\nEND;", "EXECUTE IMMEDIATE", "EXECUTE IMMEDIATE nested inside BEGIN...END"),
            ("GRANT `roles/bigquery.dataViewer` ON TABLE ds.t TO 'user:a@b.com';", "GRANT", "GRANT")
        })
        {
            var found = GoogleSqlScanner.FindTransactionBlockers(sql);
            check(found.Count > 0 && found[0].Keyword == expectedKeyword,
                $"FindTransactionBlockers detects {label} as {expectedKeyword}: got {(found.Count == 0 ? "none" : found[0].Keyword)}");
        }

        // Line number reporting on blockers.
        var lineBlockers = GoogleSqlScanner.FindTransactionBlockers("SELECT 1;\n\nDROP TABLE ds.t;");
        check(lineBlockers.Count == 1 && lineBlockers[0].Line == 3, $"FindTransactionBlockers reports exact 1-based line number: {(lineBlockers.Count == 1 ? lineBlockers[0].Line : -1)}");
    }

    static async Task DryRunAndLocationChecksAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new BigQuerySessionChecks.Bq();
        var fake = bq.Fake();
        string dryRunLocation = "EU";
        string dryRunStatement = "INSERT";
        long dryRunBytes = 4_096;
        bool failDryRun = false;

        fake.On("POST", BaseUrl + "/jobs", request =>
        {
            var body = JsonNode.Parse(request.Body)!;
            if (body["configuration"]?["dryRun"]?.GetValue<bool>() == true)
            {
                bq.DryRuns.Enqueue(body);
                if (failDryRun)
                {
                    var errText = "Syntax error: Unexpected keyword DROP at [2:8]";
                    return new(400, BigQuerySessionChecks.Bq.Error(400, errText, "invalidQuery"));
                }
                var answer = new JsonObject
                {
                    ["kind"] = "bigquery#job",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["location"] = dryRunLocation },
                    ["configuration"] = new JsonObject { ["dryRun"] = true, ["jobType"] = "QUERY" },
                    ["statistics"] = new JsonObject
                    {
                        ["totalBytesProcessed"] = dryRunBytes.ToString(CultureInfo.InvariantCulture),
                        ["query"] = new JsonObject { ["totalBytesProcessed"] = dryRunBytes.ToString(CultureInfo.InvariantCulture), ["statementType"] = dryRunStatement }
                    },
                    ["status"] = new JsonObject { ["state"] = "DONE" }
                };
                return new(200, answer.ToJsonString());
            }
            return bq.InsertReply(request);
        });
        fake.On("GET", BaseUrl + "/datasets/eu_sales", new BigQueryFake.Reply(200,
            "{\"kind\":\"bigquery#dataset\",\"datasetReference\":{\"projectId\":\"varia-alpha\",\"datasetId\":\"eu_sales\"},\"location\":\"EU\"}"));

        using var service = NewService(fake);
        // Connection with Automatic location (location omitted) and no default dataset.
        var autoConnId = await ConnectGoogleAsync(service, key, location: null, dataset: null);
        // Connection with explicit US location.
        var usConnId = await ConnectGoogleAsync(service, key, location: "US", dataset: null);

        var autoConn = service.BigQuery.Find(autoConnId)!;
        // 1. EstimateAsync exposes Location and routes through MetadataAsync (rate limiter).
        var est = await service.BigQuery.EstimateAsync(autoConn, "INSERT INTO proj.eu_sales.t VALUES (1)", CancellationToken.None);
        check(!est.Faked && est.Location == "EU" && est.BytesProcessed == 4_096 && est.StatementType == "INSERT",
            $"BigQueryEstimate exposes Location and statementType from dryRun: {est}");

        // 2. Verify MetadataAsync rate limiter is used for DryRunAsync and TabLocationAsync (429 retry succeeds).
        var rateLimitedCount = 0;
        fake.On("GET", BaseUrl + "/datasets/asia_ds", _ =>
        {
            if (Interlocked.Increment(ref rateLimitedCount) == 1)
                return new(429, BigQuerySessionChecks.Bq.Error(429, "Rate limit exceeded", "rateLimitExceeded"));
            return new(200, "{\"kind\":\"bigquery#dataset\",\"datasetReference\":{\"projectId\":\"varia-alpha\",\"datasetId\":\"asia_ds\"},\"location\":\"asia-northeast1\"}");
        });
        var asiaLoc = await service.ResolveBigQueryLocationAsync(autoConn, "asia_ds", CancellationToken.None);
        check(asiaLoc == "asia-northeast1" && rateLimitedCount == 2,
            $"TabLocationAsync routes through MetadataAsync and retries 429 cleanly: loc={asiaLoc}, attempts={rateLimitedCount}");

        var runner = new BigQueryMultiRunner(service);
        var budget = service.Results.BeginQuery(Guid.NewGuid().ToString());
        using var events = new QueryEventSink(null);
        var messages = new QueryMessages(events.Message);

        // 3. Location resolution in Transaction mode:
        //    (a) dataset via TabLocationAsync (eu_sales -> EU)
        //    (b) connection Location (usConn -> US)
        //    (c) single-statement Automatic with no dataset -> free dryRun's estimate.Location (EU)
        var tDataset = MakeContext("bq-ds", autoConnId, "transaction", "INSERT INTO t VALUES (1)", budget, messages, events, dataset: "eu_sales");
        var tConnLoc = MakeContext("bq-us", usConnId, "transaction", "INSERT INTO t VALUES (1)", budget, messages, events);
        var tSingleAuto = MakeContext("bq-auto", autoConnId, "transaction", "INSERT INTO `varia-alpha.eu_sales.t` VALUES (1)", budget, messages, events);
        var dryBefore = bq.DryRuns.Count;
        var locOutcomes = await runner.PreflightAsync([tDataset, tConnLoc, tSingleAuto], CancellationToken.None);
        check(locOutcomes.All(o => o.Passed) && bq.DryRuns.Count == dryBefore + 1 && locOutcomes[2].EstimatedBytes == 4_096,
            $"Transaction pre-flight resolves dataset/connection/single-statement dryRun locations: passed={locOutcomes.Count(o => o.Passed)}, dryRuns={bq.DryRuns.Count - dryBefore}");

        // 4. Multi-statement script with location: Automatic and no default dataset fails pre-flight with clear guidance.
        var multiScript = "INSERT INTO t VALUES (1);\nUPDATE t SET a = 2 WHERE TRUE;";
        var tMultiAuto = MakeContext("bq-auto-script", autoConnId, "transaction", multiScript, budget, messages, events);
        var scriptOutcomes = await runner.PreflightAsync([tMultiAuto], CancellationToken.None);
        check(scriptOutcomes.Count == 1 && !scriptOutcomes[0].Passed && scriptOutcomes[0].Error is { Code: "INVALID_PARAMS" } scriptErr
            && scriptErr.Message.Contains("default dataset", StringComparison.OrdinalIgnoreCase),
            $"Multi-statement script with Automatic location and no dataset fails pre-flight with guidance: {scriptOutcomes[0]}");

        // 5. PreflightDryRun error rewrites [line:column] with StartLine/StartColumn via EditorPositions.
        failDryRun = true;
        var tErr = MakeContext("bq-err", usConnId, "fireAndForget", "SELECT 1\nSELECT BAD", budget, messages, events,
            preflightDryRun: true, startLine: 10, startColumn: 5);
        var errOutcomes = await runner.PreflightAsync([tErr], CancellationToken.None);
        check(errOutcomes.Count == 1 && !errOutcomes[0].Passed && errOutcomes[0].Error is { Line: 11 } dryErr
            && dryErr.Message.Contains("[11:8]", StringComparison.Ordinal),
            $"PreflightDryRun rewrites error [line:col] with StartLine/StartColumn: {errOutcomes[0].Error}");
        failDryRun = false;

        // 6. Transaction blockers fail pre-flight with zero dry-runs or jobs executed.
        var dryCountBefore = bq.DryRuns.Count;
        var insertCountBefore = bq.Inserts.Count;
        var tBlocker = MakeContext("bq-block", usConnId, "transaction", "SELECT 1;\nEXPORT DATA OPTIONS(uri='gs://x/*') AS SELECT 1;", budget, messages, events, startLine: 5);
        var blockerOutcomes = await runner.PreflightAsync([tBlocker], CancellationToken.None);
        check(blockerOutcomes.Count == 1 && !blockerOutcomes[0].Passed && blockerOutcomes[0].Error is { Code: "INVALID_SCRIPT", Line: 6 }
            && bq.DryRuns.Count == dryCountBefore && bq.Inserts.Count == insertCountBefore,
            $"Transaction blockers fail pre-flight with offset line and zero jobs: {blockerOutcomes[0].Error}");
    }

    static async Task EmulatorRefusalChecksAsync(Action<bool, string> check)
    {
        var fake = new BigQueryFake();
        using var service = new SqlService(CheckStores.Unprobed(), bigQuery: new BigQueryEnvironment(new Uri("http://localhost:9050/"), fake.Factory, new SubjectTokens([])));
        var connectArgs = new JsonObject
        {
            ["provider"] = "bigquery", ["project"] = "varia-emulator", ["authentication"] = "gcloud",
            ["credential"] = new JsonObject { ["source"] = "anonymous" }
        };
        var (code, info, msg) = await DispatchAsync(service, "connections.connect", connectArgs);
        check(code == "ok", $"emulator connect succeeded: {code} {msg}");
        var connId = ((ConnectionInfo)info!).Id;

        var runner = new BigQueryMultiRunner(service);
        var budget = service.Results.BeginQuery(Guid.NewGuid().ToString());
        using var events = new QueryEventSink(null);
        var messages = new QueryMessages(events.Message);
        var ctx = MakeContext("emu-1", connId, "transaction", "INSERT INTO ds.t VALUES (1)", budget, messages, events);
        var outcomes = await runner.PreflightAsync([ctx], CancellationToken.None);
        check(outcomes.Count == 1 && !outcomes[0].Passed && outcomes[0].Error is { Code: "UNSUPPORTED_PROVIDER" } emuErr
            && emuErr.Message.Contains("emulator", StringComparison.OrdinalIgnoreCase),
            $"Transaction mode refuses emulator cleanly in pre-flight: {outcomes[0]}");
    }

    static async Task TransactionAndPhase2ChecksAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new BigQuerySessionChecks.Bq();
        bq.Statements["BEGIN TRANSACTION;"] = "BEGIN_TRANSACTION";
        bq.Statements["INSERT INTO sales.orders VALUES (1)"] = "INSERT";
        bq.Scripts["SCRIPT dml ok"] = [("INSERT", null), ("SELECT", null)];
        bq.Scripts["SCRIPT sneaky commit"] = [("INSERT", null), ("COMMIT_TRANSACTION", null)];
        bq.Scripts["SCRIPT unknown children"] = [("INSERT", null), ("UPDATE", null)];

        var fake = bq.Fake();
        using var service = NewService(fake);
        var connId = await ConnectGoogleAsync(service, key, location: "US", dataset: "sales");
        var runner = new BigQueryMultiRunner(service);

        // 1. Pure SELECT / Fire-and-Forget creates NO BigQuery session and emits query.job with targetKey + multiQuery.targetState.
        {
            var recorded = new ConcurrentQueue<(string Type, bool Droppable, JsonElement Body)>();
            var budget = service.Results.BeginQuery(Guid.NewGuid().ToString());
            using var events = new QueryEventSink((body, droppable) =>
            {
                var el = JsonSerializer.SerializeToElement(body, body.GetType(), Wire);
                recorded.Enqueue((el.GetProperty("type").GetString() ?? "", droppable, el));
            });
            var messages = new QueryMessages(events.Message);
            var ctx = MakeContext("bq-ff", connId, "fireAndForget", "SELECT 1", budget, messages, events);
            var insertsBefore = bq.Inserts.Count;
            var abortsBefore = bq.Aborts.Count;
            var phase1 = await runner.ExecutePhase1Async(ctx, CancellationToken.None);
            var newInserts = bq.Inserts.Skip(insertsBefore).ToArray();
            var hasCreateSession = newInserts.Any(n => n["configuration"]?["query"]?["createSession"]?.GetValue<bool>() == true);
            var hasSessionProp = newInserts.Any(n => n["configuration"]?["query"]?["connectionProperties"] is not null);
            var jobEvents = recorded.Where(e => e.Type == "query.job").ToArray();
            var stateEvents = recorded.Where(e => e.Type == "multiQuery.targetState").ToArray();
            check(phase1.Result.Outcome.Status == "succeeded" && !phase1.Result.NeedsCommit && phase1.Phase2 is null
                && !hasCreateSession && !hasSessionProp && bq.Aborts.Count == abortsBefore
                && jobEvents.Any(e => e.Body.TryGetProperty("targetKey", out var tk) && tk.GetString() == "bq-ff")
                && stateEvents.Any(e => e.Body.GetProperty("phase").GetString() == "succeeded" && !e.Droppable),
                $"Fire-and-Forget creates no session and emits query.job(targetKey) + terminal targetState: status={phase1.Result.Outcome.Status}, jobs={jobEvents.Length}, states={stateEvents.Length}");
        }

        // 2. DML transaction with ChildrenAsync(full: true) -> Open -> Phase 2 Commit + ephemeral session AbortAsync.
        {
            var budget = service.Results.BeginQuery(Guid.NewGuid().ToString());
            using var events = new QueryEventSink(null);
            var messages = new QueryMessages(events.Message);
            var ctx = MakeContext("bq-tx-ok", connId, "transaction", "SCRIPT dml ok", budget, messages, events);
            var pre = await runner.PreflightAsync([ctx], CancellationToken.None);
            var abortsBefore = bq.Aborts.Count;
            var commitsBefore = bq.Commits.Count();
            var phase1 = await runner.ExecutePhase1Async(ctx, CancellationToken.None);
            check(pre[0].Passed && phase1.Result.NeedsCommit && phase1.Phase2 is not null && phase1.Result.ResultSets.Count == 1,
                $"DML transaction Phase 1 verified Open and returned Phase 2 handle: needsCommit={phase1.Result.NeedsCommit}, sets={phase1.Result.ResultSets.Count}");
            await using (var handle = phase1.Phase2!)
            {
                var commit = await handle.CommitAsync(CancellationToken.None);
                check(commit.Outcome == MultiCommitOutcome.Committed && bq.Commits.Count() == commitsBefore + 1 && bq.Aborts.Count == abortsBefore + 1,
                    $"Phase 2 Commit ran COMMIT TRANSACTION and aborted ephemeral session: {commit}, commits={bq.Commits.Count() - commitsBefore}, aborts={bq.Aborts.Count - abortsBefore}");
            }
        }

        // 3. Post-Phase-1 ChildrenAsync sees COMMIT_TRANSACTION -> commitInDoubt (NeedsCommit == false) and aborts session.
        {
            var budget = service.Results.BeginQuery(Guid.NewGuid().ToString());
            using var events = new QueryEventSink(null);
            var messages = new QueryMessages(events.Message);
            var ctx = MakeContext("bq-tx-commit", connId, "transaction", "SCRIPT sneaky commit", budget, messages, events);
            var abortsBefore = bq.Aborts.Count;
            var phase1 = await runner.ExecutePhase1Async(ctx, CancellationToken.None);
            check(phase1.Result.Outcome.Status == "commitInDoubt" && !phase1.Result.NeedsCommit && phase1.Phase2 is null
                && bq.Aborts.Count == abortsBefore + 1,
                $"Script child COMMIT_TRANSACTION classifies target as commitInDoubt: status={phase1.Result.Outcome.Status}, aborts={bq.Aborts.Count - abortsBefore}");
        }

        // 4. Post-Phase-1 ChildrenAsync fails (ListDenied -> children == null -> Unknown) -> aborts cleanly.
        {
            bq.ListDenied = true;
            var budget = service.Results.BeginQuery(Guid.NewGuid().ToString());
            using var events = new QueryEventSink(null);
            var messages = new QueryMessages(events.Message);
            var ctx = MakeContext("bq-tx-unk", connId, "transaction", "SCRIPT unknown children", budget, messages, events);
            var abortsBefore = bq.Aborts.Count;
            var phase1 = await runner.ExecutePhase1Async(ctx, CancellationToken.None);
            bq.ListDenied = false;
            check(phase1.Result.Outcome.Status == "failed" && !phase1.Result.NeedsCommit && phase1.Phase2 is null
                && bq.Aborts.Count == abortsBefore + 1,
                $"Unverifiable script children (Unknown transaction) aborts cleanly: status={phase1.Result.Outcome.Status}, aborts={bq.Aborts.Count - abortsBefore}");
        }

        // 5. Phase 2 Rollback calls AbortAsync (and RememberFailedAbort on failure), marks stored buffers RolledBackPreview = true, emits non-droppable resultSet.meta.
        {
            var recorded = new ConcurrentQueue<(string Type, bool Droppable, JsonElement Body)>();
            var budget = service.Results.BeginQuery(Guid.NewGuid().ToString());
            using var events = new QueryEventSink((body, droppable) =>
            {
                var el = JsonSerializer.SerializeToElement(body, body.GetType(), Wire);
                recorded.Enqueue((el.GetProperty("type").GetString() ?? "", droppable, el));
            });
            var messages = new QueryMessages(events.Message);
            var ctx = MakeContext("bq-tx-rb", connId, "transaction", "SCRIPT dml ok", budget, messages, events);
            var phase1 = await runner.ExecutePhase1Async(ctx, CancellationToken.None);
            check(phase1.Phase2 is not null && phase1.Result.ResultSets.Count == 1, "Rollback test produced a stored result set");

            bq.AbortError = new JsonObject { ["reason"] = "backendError", ["message"] = "Transient abort error" };
            var abortsBeforeFail = bq.Aborts.Count;
            await using (var handle = phase1.Phase2!)
            {
                await handle.RollbackAsync(CancellationToken.None);
            }
            bq.AbortError = null;
            // Verify RememberFailedAbort queued the failed abort for retry when Reached() fires.
            service.BigQuery.Reached();
            var retriedAbort = await BigQuerySessionChecks.Poll(() => bq.Aborts.Count >= abortsBeforeFail + 2);
            var set = phase1.Result.ResultSets[0];
            var metaEvents = recorded.Where(e => e.Type == "resultSet.meta").ToArray();
            check(set.RolledBackPreview && set.Describe().RolledBackPreview == true
                && metaEvents.Length == 1 && !metaEvents[0].Droppable
                && metaEvents[0].Body.GetProperty("resultId").GetUInt32() == set.ResultId
                && metaEvents[0].Body.GetProperty("rolledBackPreview").GetBoolean()
                && retriedAbort,
                $"Phase 2 Rollback marks RolledBackPreview, emits non-droppable resultSet.meta, and remembers failed abort: rb={set.RolledBackPreview}, meta={metaEvents.Length}, retriedAbort={retriedAbort}");
        }
    }

    static async Task CommitCoreChecksAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new BigQuerySessionChecks.Bq();
        var fake = bq.Fake();
        using var service = NewService(fake);
        var connId = await ConnectGoogleAsync(service, key, location: "US", dataset: "sales");
        var conn = service.BigQuery.Find(connId)!;

        // 1. Committed + ephemeral session AbortAsync.
        {
            var session = new BigQueryTabSession("ephem-ok", conn) { Id = "sess-ok", Location = "US", Transaction = BigQueryTransaction.Open };
            var abortsBefore = bq.Aborts.Count;
            var res = await service.BigQuery.CommitEphemeralSessionAsync(session, CancellationToken.None);
            check(res.Outcome == MultiCommitOutcome.Committed && session.Transaction == BigQueryTransaction.None && bq.Aborts.Count == abortsBefore + 1,
                $"CommitEphemeralSessionAsync returns Committed and calls AbortAsync: {res}, aborts={bq.Aborts.Count - abortsBefore}");
        }

        // 2. Refused (400 / DONE job error) + ephemeral session AbortAsync.
        {
            bq.CommitError = new JsonObject { ["reason"] = "invalidQuery", ["message"] = "Transaction aborted due to conflict" };
            var session = new BigQueryTabSession("ephem-refused", conn) { Id = "sess-refused", Location = "US", Transaction = BigQueryTransaction.Open };
            var abortsBefore = bq.Aborts.Count;
            var res = await service.BigQuery.CommitEphemeralSessionAsync(session, CancellationToken.None);
            bq.CommitError = null;
            check(res.Outcome == MultiCommitOutcome.Refused && res.Error is not null && bq.Aborts.Count == abortsBefore + 1,
                $"CommitEphemeralSessionAsync returns Refused and cleans up ephemeral session via AbortAsync: {res}, aborts={bq.Aborts.Count - abortsBefore}");
        }

        // 3. CancelledBeforeSend (already-cancelled token before Jobs.Insert) -> zero Jobs.Insert, zero PendingAbort, ephemeral AbortAsync runs.
        {
            var session = new BigQueryTabSession("ephem-cancel-before", conn) { Id = "sess-cancel-before", Location = "US", Transaction = BigQueryTransaction.Open };
            var commitsBefore = bq.Commits.Count();
            var abortsBefore = bq.Aborts.Count;
            using var cancelled = new CancellationTokenSource();
            cancelled.Cancel();
            var res = await service.BigQuery.CommitEphemeralSessionAsync(session, cancelled.Token);
            check(res.Outcome == MultiCommitOutcome.CancelledBeforeSend && bq.Commits.Count() == commitsBefore
                && service.BigQuery.PendingAborts == 0 && bq.Aborts.Count == abortsBefore + 1,
                $"CommitEphemeralSessionAsync returns CancelledBeforeSend with zero Jobs.Insert and cleans up ephemeral session: {res}, commits={bq.Commits.Count() - commitsBefore}, aborts={bq.Aborts.Count - abortsBefore}");
        }

        // 4. Mid-Jobs.Insert cancellation -> maySent is already true -> InDoubt + Unknown()/PendingAbort() started, NO direct AbortAsync or double PendingAbort.
        {
            var insertEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            bq.AlsoHang = req =>
            {
                if (req.Method == "POST" && req.Url.EndsWith("/jobs", StringComparison.Ordinal)
                    && req.Body.Contains(BigQuerySql.Commit, StringComparison.Ordinal))
                {
                    insertEntered.TrySetResult();
                    return true;
                }
                return false;
            };
            var session = new BigQueryTabSession("ephem-mid-cancel", conn) { Id = "sess-mid-cancel", Location = "US", Transaction = BigQueryTransaction.Open };
            service.BigQuery.PendingNotFound = TimeSpan.FromMilliseconds(30);
            service.BigQuery.PendingPoll = TimeSpan.FromMilliseconds(10);
            var abortsBefore = bq.Aborts.Count;
            using var cts = new CancellationTokenSource();
            var commitTask = service.BigQuery.CommitEphemeralSessionAsync(session, cts.Token);
            await insertEntered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            cts.Cancel();
            var res = await commitTask;
            bq.AlsoHang = null;
            // Wait for the single PendingAbort background worker to observe 404 past PendingNotFound and abort once.
            var abortedOnce = await BigQuerySessionChecks.Poll(() => bq.Aborts.Count >= abortsBefore + 1 && service.BigQuery.PendingAborts == 0);
            check(res.Outcome == MultiCommitOutcome.InDoubt && abortedOnce && bq.Aborts.Count == abortsBefore + 1,
                $"Mid-Jobs.Insert cancellation transitions to InDoubt with exactly one PendingAbort (no direct AbortAsync / double PendingAbort): {res}, aborts={bq.Aborts.Count - abortsBefore}");
        }

        // 5. CommitLimit expiry while polling -> InDoubt with PendingAbort started.
        {
            bq.CommitReply = job =>
            {
                job.State = "RUNNING";
                job.Hold = true;
                return new(500, BigQuerySessionChecks.Bq.Error(500, "Backend error", "backendError"));
            };
            var prevLimit = service.BigQuery.CommitLimit;
            service.BigQuery.CommitLimit = TimeSpan.FromMilliseconds(60);
            var session = new BigQueryTabSession("ephem-timeout", conn) { Id = "sess-timeout", Location = "US", Transaction = BigQueryTransaction.Open };
            var abortsBefore = bq.Aborts.Count;
            var res = await service.BigQuery.CommitEphemeralSessionAsync(session, CancellationToken.None);
            bq.CommitReply = null;
            service.BigQuery.CommitLimit = prevLimit;
            // Release the RUNNING commit job so PendingAbort finishes cleanly.
            foreach (var job in bq.Jobs.Values.Where(j => j.Sql == BigQuerySql.Commit && j.State != "DONE"))
                bq.Release(job);
            var settled = await BigQuerySessionChecks.Poll(() => bq.Aborts.Count >= abortsBefore + 1 && service.BigQuery.PendingAborts == 0);
            check(res.Outcome == MultiCommitOutcome.InDoubt && settled && bq.Aborts.Count == abortsBefore + 1,
                $"CommitLimit expiry returns InDoubt and triggers single PendingAbort: {res}, aborts={bq.Aborts.Count - abortsBefore}");
        }
    }

    sealed class StubSqlValidator(Func<string, int, IReadOnlyList<ReadOnlySqlViolation>> validate) : IReadOnlySqlValidator
    {
        public Task<IReadOnlyList<ReadOnlySqlViolation>> ValidateTSqlAsync(string sql, int startLine, CancellationToken token) =>
            Task.FromResult(validate(sql, startLine));
    }

    static async Task CrossEngineChecksAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new BigQuerySessionChecks.Bq();
        var fake = bq.Fake();
        string dryRunStatementType = "SELECT";
        string? dryRunError = null;

        fake.On("POST", BaseUrl + "/jobs", request =>
        {
            var body = JsonNode.Parse(request.Body)!;
            if (body["configuration"]?["dryRun"]?.GetValue<bool>() == true)
            {
                bq.DryRuns.Enqueue(body);
                if (dryRunError is not null)
                    return new(400, BigQuerySessionChecks.Bq.Error(400, dryRunError, "invalidQuery"));
                var query = new JsonObject { ["totalBytesProcessed"] = "1024" };
                if (dryRunStatementType is not null) query["statementType"] = dryRunStatementType;
                var answer = new JsonObject
                {
                    ["kind"] = "bigquery#job",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["location"] = "US" },
                    ["configuration"] = new JsonObject { ["dryRun"] = true, ["jobType"] = "QUERY" },
                    ["statistics"] = new JsonObject { ["totalBytesProcessed"] = "1024", ["query"] = query },
                    ["status"] = new JsonObject { ["state"] = "DONE" }
                };
                return new(200, answer.ToJsonString());
            }
            return bq.InsertReply(request);
        });

        using var service = NewService(fake);
        var connId = await ConnectGoogleAsync(service, key, location: "US", dataset: "sales");
        var budget = service.Results.BeginQuery(Guid.NewGuid().ToString());
        using var events = new QueryEventSink(null);
        var messages = new QueryMessages(events.Message);
        var bqTarget = MakeContext("bq-1", connId, "crossEngineReadOnly", "SELECT 1", budget, messages, events, startLine: 10);

        // 1. T-SQL violation stops pre-flight with READ_ONLY_VIOLATION and 0 BigQuery dry-runs.
        var tsqlFail = new CrossEngineRunner(service, new StubSqlValidator((_, startLine) =>
            [new ReadOnlySqlViolation(startLine + 1, 1, startLine + 1, 7, "DELETE", "DELETE is not allowed in Cross-Engine SELECT.")]));
        var dryBefore = bq.DryRuns.Count;
        var res1 = await tsqlFail.ValidatePreflightAsync("SELECT 1;\nDELETE FROM dbo.t;", 3, "SELECT 1", 10, [bqTarget], CancellationToken.None);
        check(!res1.Passed && res1.ErrorCode == "READ_ONLY_VIOLATION" && res1.Dialect == Providers.SqlServer
            && res1.Line == 4 && bq.DryRuns.Count == dryBefore,
            $"CrossEngineRunner stops on T-SQL violation with READ_ONLY_VIOLATION and 0 dry-runs: {res1}");

        var okSql = new StubSqlValidator((_, _) => []);
        var cross = new CrossEngineRunner(service, okSql);

        // 2. BigQuery static multi-statement violation -> READ_ONLY_VIOLATION with startLine offset and 0 dry-runs.
        dryBefore = bq.DryRuns.Count;
        var res2 = await cross.ValidatePreflightAsync("SELECT 1", 1, "SELECT 1;\nSELECT 2;", 10, [bqTarget], CancellationToken.None);
        check(!res2.Passed && res2.ErrorCode == "READ_ONLY_VIOLATION" && res2.Dialect == Providers.BigQuery
            && res2.Line == 11 && bq.DryRuns.Count == dryBefore,
            $"CrossEngineRunner rejects BigQuery multi-statement statically with startLine offset: {res2}");

        // 3. BigQuery dry-run non-SELECT statementType (e.g. SCRIPT or INSERT) -> READ_ONLY_VIOLATION.
        dryRunStatementType = "SCRIPT";
        var res3 = await cross.ValidatePreflightAsync("SELECT 1", 1, "SELECT 1", 10, [bqTarget], CancellationToken.None);
        check(!res3.Passed && res3.ErrorCode == "READ_ONLY_VIOLATION" && res3.Dialect == Providers.BigQuery
            && res3.Line == 10 && res3.Message!.Contains("SCRIPT", StringComparison.Ordinal),
            $"CrossEngineRunner rejects non-SELECT dryRun statementType with READ_ONLY_VIOLATION: {res3}");

        // 4. BigQuery dry-run SQL error rewrites [line:col] via EditorPositions using startLines.Bigquery, 1.
        dryRunStatementType = "SELECT";
        dryRunError = "Unrecognized name: bad_col at [2:9]";
        var res4 = await cross.ValidatePreflightAsync("SELECT 1", 1, "SELECT\n  bad_col", 10, [bqTarget], CancellationToken.None);
        dryRunError = null;
        check(!res4.Passed && res4.ErrorCode == "SQL_ERROR" && res4.Line == 11
            && res4.Message!.Contains("[11:9]", StringComparison.Ordinal),
            $"CrossEngineRunner rewrites BigQuery dry-run error positions with startLines.Bigquery: {res4}");

        // 5. Valid T-SQL + valid GoogleSQL SELECT with dryRun statementType == "SELECT" -> passes!
        dryRunStatementType = "SELECT";
        var res5 = await cross.ValidatePreflightAsync("SELECT 1", 1, "SELECT 1", 10, [bqTarget], CancellationToken.None);
        check(res5.Passed && res5.BigQueryOutcomes is [{ Passed: true, EstimatedBytes: 1024 }],
            $"CrossEngineRunner passes valid T-SQL + BigQuery SELECT dry-run: {res5}");

        // 6. Emulator mode (estimate.Faked == true) passes when static allowlists pass!
        var emuFake = new BigQueryFake();
        using var emuService = new SqlService(CheckStores.Unprobed(), bigQuery: new BigQueryEnvironment(new Uri("http://localhost:9050/"), emuFake.Factory, new SubjectTokens([])));
        var (_, emuInfo, _) = await DispatchAsync(emuService, "connections.connect",
            new JsonObject
            {
                ["provider"] = "bigquery", ["project"] = "varia-emulator", ["authentication"] = "gcloud",
                ["credential"] = new JsonObject { ["source"] = "anonymous" }
            });
        var emuId = ((ConnectionInfo)emuInfo!).Id;
        var emuTarget = MakeContext("bq-emu", emuId, "crossEngineReadOnly", "SELECT 1", budget, messages, events, startLine: 1);
        var emuCross = new CrossEngineRunner(emuService, okSql);
        var res6 = await emuCross.ValidatePreflightAsync("SELECT 1", 1, "SELECT 1", 1, [emuTarget], CancellationToken.None);
        check(res6.Passed, $"CrossEngineRunner accepts faked emulator estimate when static allowlists pass: {res6}");
    }

    static async Task ResidenceAndRolledBackPreviewChecksAsync(Action<bool, string> check, JsonObject key)
    {
        // Build a fake BigQuery returning 2,000 rows in pages of 500 with a destination table so tight query budget windows it.
        var bq = new BigQuerySessionChecks.Bq();
        bq.Statements["BEGIN TRANSACTION;"] = "BEGIN_TRANSACTION";
        bq.Statements["SELECT * FROM sales.big_preview"] = "SELECT";
        var fake = bq.Fake();

        const int totalRows = 2000;
        const int pageSize = 500;
        var destTable = new JsonObject { ["projectId"] = "varia-alpha", ["datasetId"] = "_anon", ["tableId"] = "anon_preview_tbl" };
        fake.On("GET", BaseUrl + "/jobs/[^/]+", request =>
        {
            var id = request.Url[(request.Url.LastIndexOf('/') + 1)..];
            if (bq.Jobs.TryGetValue(id, out var job) && job.Sql == "SELECT * FROM sales.big_preview")
            {
                job.State = "DONE";
                var obj = new JsonObject
                {
                    ["kind"] = "bigquery#job",
                    ["id"] = "varia-alpha:US." + job.Id,
                    ["state"] = "DONE",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = job.Id, ["location"] = "US" },
                    ["status"] = new JsonObject { ["state"] = "DONE" },
                    ["statistics"] = new JsonObject
                    {
                        ["creationTime"] = job.Created.ToString(CultureInfo.InvariantCulture),
                        ["query"] = new JsonObject { ["statementType"] = "SELECT", ["totalBytesProcessed"] = "2048" },
                        ["sessionInfo"] = job.Session is null ? null : new JsonObject { ["sessionId"] = job.Session }
                    },
                    ["configuration"] = new JsonObject
                    {
                        ["jobType"] = "QUERY",
                        ["query"] = new JsonObject
                        {
                            ["query"] = job.Sql,
                            ["useLegacySql"] = false,
                            ["destinationTable"] = destTable.DeepClone()
                        }
                    }
                };
                return new(200, obj.ToJsonString());
            }
            return bq.GetReply(request);
        });
        fake.On("GET", BaseUrl + "/queries/[^/]+", request =>
        {
            var id = request.Url[(request.Url.LastIndexOf('/') + 1)..];
            if (bq.Jobs.TryGetValue(id, out var job) && job.Sql == "SELECT * FROM sales.big_preview")
            {
                job.State = "DONE";
                var qs = HttpUtility.ParseQueryString(request.Uri.Query);
                var offset = qs["pageToken"] is { } pt ? int.Parse(pt[5..], CultureInfo.InvariantCulture) : 0;
                var count = Math.Min(pageSize, totalRows - offset);
                var rows = new JsonArray([.. Enumerable.Range(offset, count).Select(i => (JsonNode)new JsonObject
                {
                    ["f"] = new JsonArray(
                        new JsonObject { ["v"] = i.ToString(CultureInfo.InvariantCulture) },
                        new JsonObject { ["v"] = new string('A', 200) })
                })]);
                var answer = new JsonObject
                {
                    ["kind"] = "bigquery#getQueryResultsResponse",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                    ["jobComplete"] = true,
                    ["totalRows"] = totalRows.ToString(CultureInfo.InvariantCulture),
                    ["schema"] = new JsonObject
                    {
                        ["fields"] = new JsonArray(
                            new JsonObject { ["name"] = "id", ["type"] = "INT64" },
                            new JsonObject { ["name"] = "payload", ["type"] = "STRING" })
                    },
                    ["rows"] = rows
                };
                if (offset + count < totalRows) answer["pageToken"] = "page-" + (offset + count).ToString(CultureInfo.InvariantCulture);
                return new(200, answer.ToJsonString());
            }
            return new(200, "{\"kind\":\"bigquery#getQueryResultsResponse\",\"jobComplete\":true,\"totalRows\":\"0\"}");
        });

        // Use a small query budget (64 KiB) so 2,000 rows (~440 KiB) automatically switches to windowed!
        using var service = new SqlService(new ResultStore(4L << 20, 64 * 1024), bigQuery: new BigQueryEnvironment(null, fake.Factory, new SubjectTokens([])));
        service.BigQuery.RetryDelay = TimeSpan.FromMilliseconds(1);
        service.BigQuery.ChildPollMs = 20;
        service.BigQuery.DonePoll = TimeSpan.FromMilliseconds(10);

        var connId = await ConnectGoogleAsync(service, key, location: "US", dataset: "sales");
        var runner = new BigQueryMultiRunner(service);
        var budget = service.Results.BeginQuery(Guid.NewGuid().ToString());
        budget.Executing = true;
        using var events = new QueryEventSink(null);
        var messages = new QueryMessages(events.Message);

        var ctx = MakeContext("bq-win-1", connId, "transaction", "SELECT * FROM sales.big_preview", budget, messages, events, residence: "automatic");
        var pre = await runner.PreflightAsync([ctx], CancellationToken.None);
        var phase1 = await runner.ExecutePhase1Async(ctx, CancellationToken.None);
        check(pre[0].Passed && phase1.Phase2 is not null && phase1.Result.ResultSets.Count == 1,
            $"Windowed multi-target query produced a result set and Phase 2 handle: sets={phase1.Result.ResultSets.Count}");

        var windowedSet = phase1.Result.ResultSets[0];
        check(windowedSet.IsRemote && windowedSet.Remote?.Source is SqlService.BigQueryWindow win && win.Args.ConnectionId == connId,
            $"Windowed multi-target result constructed per-target QueryArgs on BigQueryWindow: remote={windowedSet.IsRemote}");

        // Roll back Phase 2 so windowedSet.RolledBackPreview == true, then end execution and attempt rerun.
        await using (var handle = phase1.Phase2!)
        {
            await handle.RollbackAsync(CancellationToken.None);
        }
        budget.Executing = false;
        check(windowedSet.RolledBackPreview, "Windowed result is marked RolledBackPreview after rollback");

        var rerunArgs = new JsonObject
        {
            ["queryId"] = Guid.NewGuid().ToString(),
            ["resultId"] = windowedSet.ResultId,
            ["generation"] = 1,
            ["kind"] = "rerun"
        };
        var (rerunCode, _, rerunMsg) = await DispatchAsync(service, "results.remoteQuery", rerunArgs);
        check(rerunCode == "INVALID_PARAMS" && rerunMsg.Contains("rolled-back preview", StringComparison.OrdinalIgnoreCase),
            $"PlanAuxiliary refuses rerun when windowed result has RolledBackPreview == true: {rerunCode} {rerunMsg}");

        // Also verify residence room division across 2 targets:
        // Total 2,000 rows * ~220 B ≈ 440 KiB. With query budget = 1,200 KiB:
        // - Single target: room = 1,200 KiB -> half = 600 KiB >= 440 KiB -> fits in memory!
        // - Two targets: room / 2 = 600 KiB -> half = 300 KiB < 440 KiB -> windowed!
        using var twoTargetService = new SqlService(new ResultStore(8L << 20, 1200 * 1024), bigQuery: new BigQueryEnvironment(null, fake.Factory, new SubjectTokens([])));
        twoTargetService.BigQuery.RetryDelay = TimeSpan.FromMilliseconds(1);
        twoTargetService.BigQuery.ChildPollMs = 20;
        twoTargetService.BigQuery.DonePoll = TimeSpan.FromMilliseconds(10);
        var c1 = await ConnectGoogleAsync(twoTargetService, key, location: "US", dataset: "sales");
        var c2 = await ConnectGoogleAsync(twoTargetService, key, location: "US", dataset: "sales");
        var twoRunner = new BigQueryMultiRunner(twoTargetService);
        var twoBudget = twoTargetService.Results.BeginQuery(Guid.NewGuid().ToString());
        using var twoEvents = new QueryEventSink(null);
        var twoMessages = new QueryMessages(twoEvents.Message);
        var ctx1 = MakeContext("bq-r1", c1, "fireAndForget", "SELECT * FROM sales.big_preview", twoBudget, twoMessages, twoEvents, residence: "automatic");
        var ctx2 = MakeContext("bq-r2", c2, "fireAndForget", "SELECT * FROM sales.big_preview", twoBudget, twoMessages, twoEvents, residence: "automatic");
        await twoRunner.PreflightAsync([ctx1, ctx2], CancellationToken.None);
        var r1 = await twoRunner.ExecutePhase1Async(ctx1, CancellationToken.None);
        check(r1.Result.ResultSets.Count == 1 && r1.Result.ResultSets[0].IsRemote,
            $"Residence divides remaining room across remaining BigQuery targets (2 targets -> windowed where 1 would fit): remote={r1.Result.ResultSets.FirstOrDefault()?.IsRemote}");
    }

    static SqlService NewService(BigQueryFake fake)
    {
        var service = new SqlService(CheckStores.Unprobed(), bigQuery: new BigQueryEnvironment(null, fake.Factory, new SubjectTokens([])));
        service.BigQuery.RetryDelay = TimeSpan.FromMilliseconds(1);
        service.BigQuery.ChildPollMs = 20;
        service.BigQuery.DonePoll = TimeSpan.FromMilliseconds(10);
        service.BigQuery.PendingPoll = TimeSpan.FromMilliseconds(20);
        service.BigQuery.HeldPoll = TimeSpan.FromMilliseconds(20);
        return service;
    }

    static async Task<string> ConnectGoogleAsync(SqlService service, JsonObject key, string? location, string? dataset)
    {
        var options = new JsonObject
        {
            ["provider"] = "bigquery",
            ["project"] = "varia-alpha",
            ["authentication"] = "serviceAccountKey",
            ["credential"] = new JsonObject { ["source"] = "file", ["json"] = key.ToJsonString() },
            ["keyFile"] = Guid.NewGuid().ToString()
        };
        if (location is not null) options["location"] = location;
        if (dataset is not null) options["dataset"] = dataset;
        var (code, info, msg) = await DispatchAsync(service, "connections.connect", options);
        if (code != "ok") throw new InvalidOperationException("connect failed: " + code + " " + msg);
        return ((ConnectionInfo)info!).Id;
    }

    static async Task<(string Code, object? Result, string Message)> DispatchAsync(SqlService service, string method, JsonNode parameters)
    {
        using var doc = JsonDocument.Parse(parameters.ToJsonString());
        try { return ("ok", await service.DispatchAsync(method, doc.RootElement.Clone(), Wire, null), ""); }
        catch (RequestException error) { return (error.Code, null, error.Message); }
    }

    static MultiTargetContext MakeContext(
        string targetKey,
        string connectionId,
        string mode,
        string sql,
        QueryBudget budget,
        QueryMessages messages,
        QueryEventSink events,
        string? dataset = null,
        bool preflightDryRun = false,
        int startLine = 1,
        int startColumn = 1,
        string? residence = null) => new(
        QueryId: Guid.NewGuid().ToString(),
        SessionId: Guid.NewGuid().ToString(),
        Mode: mode,
        PreflightDryRun: preflightDryRun,
        Target: new MultiQueryTargetArgs(targetKey, connectionId, "BQ " + targetKey, Dataset: dataset),
        Provider: Providers.BigQuery,
        Sql: sql,
        StartLine: startLine,
        StartColumn: startColumn,
        MaxRows: 0,
        MaxResultSets: 100,
        TimeoutSeconds: 0,
        StopOnError: false,
        DiscardResults: false,
        Prices: true,
        Residence: residence,
        WindowCacheMiB: null,
        JobKey: Guid.NewGuid().ToString(),
        Quota: new MultiQueryQuota(100, 8L << 20),
        IsAbandoned: () => false,
        Budget: budget,
        Messages: messages,
        Events: events);
}
