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

        // Bare \r comment termination & #legacySQL bypass hardening.
        check(!GoogleSqlScanner.IsReadOnlySelect("SELECT 1 -- comment\r; DELETE FROM ds.t WHERE TRUE;"),
            "IsReadOnlySelect terminates -- comment on bare CR and rejects trailing DELETE");
        check(!GoogleSqlScanner.IsReadOnlySelect("SELECT 1 # comment\r; DROP TABLE ds.t;"),
            "IsReadOnlySelect terminates # comment on bare CR and rejects trailing DROP");
        check(GoogleSqlScanner.FindTransactionBlockers("SELECT 1; -- x\rEXPORT DATA OPTIONS(uri='gs://b/*', format='CSV') AS SELECT 1;").Count > 0,
            "FindTransactionBlockers terminates -- comment on bare CR and catches EXPORT DATA");
        check(GoogleSqlScanner.IsMultiStatementScript("SELECT 1 -- x\r; INSERT INTO ds.t VALUES (1);"),
            "IsMultiStatementScript terminates -- comment on bare CR and detects multiple statements");
        check(GoogleSqlScanner.IsMultiStatementScript("`lbl`: BEGIN END `lbl`"),
            "IsMultiStatementScript detects backtick-quoted block labels");
        check(BigQueryErrors.IsLegacySql("-- header\r#legacySQL\nSELECT 1"),
            "BigQueryErrors.IsLegacySql terminates -- comment on bare CR and catches #legacySQL");

        // WHILE ... DO FROM pipe-syntax bypass & unreserved mod/div/xor/[do] hardening.
        var whileFromBlockers = GoogleSqlScanner.FindTransactionBlockers(
            "WHILE TRUE DO\n  FROM ds.t |> SELECT 1;\n  EXPORT DATA OPTIONS(uri='gs://b/*', format='CSV') AS SELECT 1;\n  DROP TABLE ds.perm;\n  COMMIT TRANSACTION;\nEND WHILE;");
        check(whileFromBlockers.Count >= 3,
            $"FindTransactionBlockers catches EXPORT DATA, DROP TABLE, and COMMIT inside WHILE ... DO FROM pipe body (found {whileFromBlockers.Count})");
        check(GoogleSqlScanner.FindTransactionBlockers("DECLARE mod BOOL DEFAULT TRUE; WHILE mod DO DROP TABLE ds.perm; END WHILE;").Count == 1,
            "FindTransactionBlockers catches DROP TABLE inside WHILE mod DO");
        check(GoogleSqlScanner.FindTransactionBlockers("DECLARE do BOOL DEFAULT TRUE; WHILE [do][OFFSET(0)] DO COMMIT TRANSACTION; END WHILE;").Count == 1,
            "FindTransactionBlockers catches COMMIT TRANSACTION inside WHILE [do][OFFSET(0)] DO");

        // @-prefixed parameter names (@then, @case, @do) are treated as qualified identifiers, not control-flow keywords.
        check(GoogleSqlScanner.FindTransactionBlockers("IF @then = 1 THEN DROP TABLE ds.perm; END IF;").Count == 1,
            "FindTransactionBlockers catches DROP TABLE after @then parameter in IF header");
        check(GoogleSqlScanner.FindTransactionBlockers("IF @case = 1 THEN DROP TABLE ds.perm; END IF;").Count == 1,
            "FindTransactionBlockers catches DROP TABLE after @case parameter in IF header");
        check(GoogleSqlScanner.FindTransactionBlockers("WHILE x = @do DO DROP TABLE ds.perm; END WHILE;").Count == 1,
            "FindTransactionBlockers catches DROP TABLE after @do parameter in WHILE header");
        check(GoogleSqlScanner.FindTransactionBlockers("BEGIN transaction: BEGIN INSERT INTO ds.t VALUES (1); END transaction; END;").Count == 0,
            "FindTransactionBlockers does not false-positive on labeled BEGIN transaction: block");

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

        // 5. HTTP 429 on Jobs.Insert hitting CommitLimit returns Refused/QUOTA (not CONNECTION_LOST), and concurrent 429+cancel returns CancelledBeforeSend.
        {
            var prevLimit = service.BigQuery.CommitLimit;
            var prevRetry = service.BigQuery.RetryDelay;
            service.BigQuery.RetryDelay = TimeSpan.FromSeconds(5);
            service.BigQuery.CommitLimit = prevLimit;
            service.BigQuery.CommitBackingOff = limit => limit.Cancel();
            bq.CommitReply = job =>
            {
                // A 429 rate-limit response rejects the insert before BigQuery creates the job.
                bq.Jobs.TryRemove(job.Id, out _);
                return new(429, BigQuerySessionChecks.Bq.Error(429, "Rate limit exceeded", "rateLimitExceeded"));
            };
            var session429 = new BigQueryTabSession("ephem-429", conn) { Id = "sess-429", Location = "US", Transaction = BigQueryTransaction.Open };
            var res429 = await service.BigQuery.CommitCoreAsync(session429, CancellationToken.None);
            service.BigQuery.CommitBackingOff = null;
            check(res429.Outcome == MultiCommitOutcome.Refused && res429.Error?.Code == "QUOTA",
                $"CommitCoreAsync 429 hitting CommitLimit returns Refused/QUOTA (not CONNECTION_LOST): {res429}");

            using var cancel429 = new CancellationTokenSource();
            service.BigQuery.RetryDelay = TimeSpan.FromSeconds(5);
            service.BigQuery.CommitLimit = prevLimit;
            service.BigQuery.CommitBackingOff = _ => cancel429.Cancel();
            bq.CommitReply = job =>
            {
                bq.Jobs.TryRemove(job.Id, out _);
                return new(429, BigQuerySessionChecks.Bq.Error(429, "Rate limit exceeded", "rateLimitExceeded"));
            };
            var res429Cancel = await service.BigQuery.CommitCoreAsync(session429, cancel429.Token);
            service.BigQuery.CommitBackingOff = null;
            bq.CommitReply = null;
            service.BigQuery.RetryDelay = prevRetry;
            service.BigQuery.CommitLimit = prevLimit;
            check(res429Cancel.Outcome == MultiCommitOutcome.CancelledBeforeSend,
                $"CommitCoreAsync concurrent 429 + cancellation returns CancelledBeforeSend (not InDoubt): {res429Cancel}");

            // Pre-send ObjectDisposedException / client failure returns Refused immediately without waiting for CommitLimit.
            using var dispService = NewService(new BigQuerySessionChecks.Bq().Fake());
            var dispId = await ConnectGoogleAsync(dispService, key, location: "US", dataset: "sales");
            var dispConnReal = dispService.BigQuery.Find(dispId)!;
            dispConnReal.Dispose();
            var dispSession = new BigQueryTabSession("ephem-disp", dispConnReal) { Id = "sess-disp", Location = "US", Transaction = BigQueryTransaction.Open };
            var swDisp = System.Diagnostics.Stopwatch.StartNew();
            var resDisp = await dispService.BigQuery.CommitCoreAsync(dispSession, CancellationToken.None);
            swDisp.Stop();
            check(resDisp.Outcome == MultiCommitOutcome.Refused && resDisp.Error?.Code == "NOT_CONNECTED" && swDisp.Elapsed < TimeSpan.FromSeconds(5),
                $"CommitCoreAsync pre-send ObjectDisposedException returns Refused/NOT_CONNECTED immediately ({resDisp}, {swDisp.ElapsedMilliseconds}ms)");
        }

        // 6. Cancelled/peer-aborted running DML in Transaction mode settles cleanly as rolledBack (NOT commitInDoubt) and emits done job event.
        {
            var runner = new BigQueryMultiRunner(service);
            var budget = service.Results.BeginQuery("bq-peer-abort");
            var jobStates = new List<string>();
            using var events = new QueryEventSink((e, _) =>
            {
                var json = JsonSerializer.Serialize(e, Wire);
                if (json.Contains("\"type\":\"query.job\"", StringComparison.Ordinal) && json.Contains("\"targetKey\":\"bq-peer\"", StringComparison.Ordinal))
                {
                    using var doc = JsonDocument.Parse(json);
                    if (doc.RootElement.TryGetProperty("state", out var st) && st.GetString() is { } s) jobStates.Add(s);
                }
            });
            var messages = new QueryMessages(events.Message);
            using var phase1Cts = new CancellationTokenSource();
            bq.Statements["BEGIN TRANSACTION;"] = "BEGIN_TRANSACTION";
            bq.Statements["INSERT INTO ds.t VALUES (1);"] = "INSERT";
            var insertHeld = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            bq.AlsoHang = req =>
            {
                if (!req.Url.Contains("/queries/", StringComparison.Ordinal)) return false;
                var id = req.Url[(req.Url.LastIndexOf('/') + 1)..];
                if (bq.Jobs.TryGetValue(id, out var job) && job.Sql.StartsWith("INSERT", StringComparison.Ordinal))
                {
                    job.Hold = true;
                    insertHeld.TrySetResult();
                    return true;
                }
                return false;
            };
            var ctx = MakeContext("bq-peer", connId, "transaction", "INSERT INTO ds.t VALUES (1);", budget, messages, events) with
            {
                IsUserCancelled = () => false,
                IsTimedOut = () => false
            };
            var runTask = runner.ExecutePhase1Async(ctx, phase1Cts.Token);
            var completed = await Task.WhenAny(insertHeld.Task, Task.Delay(TimeSpan.FromSeconds(5)));
            check(completed == insertHeld.Task, "Peer-abort test observed held INSERT job");
            phase1Cts.Cancel();
            bq.AlsoHang = null;
            var outcome = await runTask;
            check(outcome.Result.Outcome.Status == "rolledBack" && !outcome.Result.NeedsCommit && jobStates.Contains("done"),
                $"Peer-aborted running BigQuery DML settles as rolledBack (NOT commitInDoubt) and emits done job event: {outcome.Result.Outcome.Status}, states=[{string.Join(',', jobStates)}]");
        }

        // 7. GoogleSqlScanner labeled END / END LOOP / END REPEAT with non-reserved keyword labels (exception/elseif/begin) never bypasses or false-positives.
        {
            var bypass1 = GoogleSqlScanner.FindTransactionBlockers("exception: BEGIN\n  SELECT 1;\nEND exception;\nDROP TABLE ds.perm;\nCOMMIT TRANSACTION;");
            check(bypass1.Count >= 2 && bypass1.Any(b => b.Keyword == "DROP TABLE") && bypass1.Any(b => b.Keyword == "COMMIT TRANSACTION"),
                $"Scanner catches DROP TABLE and COMMIT TRANSACTION after labeled END exception; ({string.Join(", ", bypass1.Select(b => b.Keyword))})");
            var bypass2 = GoogleSqlScanner.FindTransactionBlockers("elseif: LOOP\n  LEAVE elseif;\nEND LOOP elseif;\nEXECUTE IMMEDIATE 'DROP TABLE ds.perm';");
            check(bypass2.Any(b => b.Keyword == "EXECUTE IMMEDIATE"),
                $"Scanner catches EXECUTE IMMEDIATE after labeled END LOOP elseif; ({bypass2.Count})");
            var bypass3 = GoogleSqlScanner.FindTransactionBlockers("exception: REPEAT\n  SELECT 1;\nUNTIL TRUE\nEND REPEAT exception;\nEXPORT DATA OPTIONS(uri='gs://b/*', format='CSV') AS SELECT 1;");
            check(bypass3.Any(b => b.Keyword == "EXPORT DATA"),
                $"Scanner catches EXPORT DATA after labeled END REPEAT exception; ({bypass3.Count})");
            var benign = GoogleSqlScanner.FindTransactionBlockers("begin: BEGIN\n  SELECT 1;\nEND begin;\ncommit: LOOP\n  LEAVE commit;\nEND LOOP commit;");
            check(benign.Count == 0,
                $"Scanner accepts benign labeled blocks using unreserved labels begin/commit without false positives ({benign.Count})");

            // Trailing-decimal numeric literals (`1.`) must not look like struct-member dots hiding THEN/DO/WHEN/END.
            var numBypass1 = GoogleSqlScanner.FindTransactionBlockers("IF 1 = 1. THEN DROP TABLE ds.perm; END IF;");
            var numBypass2 = GoogleSqlScanner.FindTransactionBlockers("WHILE 1 = 1. DO COMMIT TRANSACTION; END WHILE;");
            var numBypass3 = GoogleSqlScanner.FindTransactionBlockers("IF CASE WHEN TRUE THEN 1. END = 1 THEN EXECUTE IMMEDIATE 'DROP TABLE ds.perm'; END IF;");
            check(numBypass1.Any(b => b.Keyword == "DROP TABLE")
                && numBypass2.Any(b => b.Keyword == "COMMIT TRANSACTION")
                && numBypass3.Any(b => b.Keyword == "EXECUTE IMMEDIATE"),
                $"Scanner rejects forbidden statements after trailing-decimal float literals 1. ({numBypass1.Count}/{numBypass2.Count}/{numBypass3.Count})");

            // NeverCreated covers pre-send client failures and non-ambiguous 429; cancelled unborn job settles as rolledBack (NOT commitInDoubt).
            check(BigQueryService.NeverCreated(new ObjectDisposedException("client"))
                && BigQueryService.NeverCreated(new Google.GoogleApiException("bq", "rate") { HttpStatusCode = System.Net.HttpStatusCode.TooManyRequests }),
                "BigQueryService.NeverCreated returns true for ObjectDisposedException and non-ambiguous 429");
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

        // Stub tabledata.list for the windowed destination table so kind="sample" (method="first") succeeds.
        fake.On("GET", BaseUrl + "/datasets/_anon/tables/anon_preview_tbl/data", _ =>
        {
            var sampleRows = new JsonArray([.. Enumerable.Range(0, 10).Select(i => (JsonNode)new JsonObject
            {
                ["f"] = new JsonArray(
                    new JsonObject { ["v"] = i.ToString(CultureInfo.InvariantCulture) },
                    new JsonObject { ["v"] = new string('A', 200) })
            })]);
            return new(200, new JsonObject
            {
                ["kind"] = "bigquery#tableDataList",
                ["totalRows"] = totalRows.ToString(CultureInfo.InvariantCulture),
                ["rows"] = sampleRows
            }.ToJsonString());
        });

        // Verify SqlService.BigQueryViews derived view/sample propagates RolledBackPreview and multi-target metadata.
        var sampleArgs = new JsonObject
        {
            ["queryId"] = Guid.NewGuid().ToString(),
            ["resultId"] = windowedSet.ResultId,
            ["generation"] = 1,
            ["kind"] = "sample",
            ["rows"] = 10,
            ["method"] = "first"
        };
        var (sampleCode, sampleResObj, sampleErr) = await DispatchAsync(service, "results.remoteQuery", sampleArgs);
        var sampleSetId = (sampleResObj as QueryResult)?.ResultSets.FirstOrDefault()?.ResultId;
        var sampleBuf = sampleSetId is { } sid ? service.Results.Find(sid) : null;
        check(sampleCode == "ok" && sampleBuf is { RolledBackPreview: true, TargetKey: "bq-win-1", TargetProvider: Providers.BigQuery } && sampleBuf.StatementSlot == windowedSet.StatementSlot,
            $"Derived BigQuery sample propagates RolledBackPreview and target metadata ({sampleCode} {sampleErr}, rb={sampleBuf?.RolledBackPreview}, tk={sampleBuf?.TargetKey})");

        // Verify real non-cancellation error (500 -> 403 -> BigQueryJobMayExist) racing peer cancellation during SettleAsync
        // is NOT masked as rolledBack, and CancelJob + SettleAsync + AbortEphemeralSessionAsync all run.
        await ConcurrentErrorAndAmbiguousCancelChecksAsync(check, key);
    }

    static async Task ConcurrentErrorAndAmbiguousCancelChecksAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new BigQuerySessionChecks.Bq();
        var fake = bq.Fake();
        using var service = NewService(fake);
        service.BigQuery.UnbornCancelLimit = TimeSpan.FromMilliseconds(150);
        service.BigQuery.UnbornCancelPoll = TimeSpan.FromMilliseconds(20);
        service.BigQuery.CloseWaitLimit = TimeSpan.FromMilliseconds(300);
        var connId = await ConnectGoogleAsync(service, key, location: "US", dataset: "sales");

        var cancelCalled = 0;
        var r6CancelSeen = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var abortedSessions = new ConcurrentBag<string>();
        using var cts = new CancellationTokenSource();
        var userInsertAttempts = 0;

        fake.On("POST", BaseUrl + "/jobs", request =>
        {
            var body = JsonNode.Parse(request.Body!)!.AsObject();
            var id = body["jobReference"]?["jobId"]?.GetValue<string>() ?? Guid.NewGuid().ToString("N");
            var queryText = body["configuration"]!["query"]!["query"]!.GetValue<string>();
            if (queryText.StartsWith("BEGIN TRANSACTION", StringComparison.OrdinalIgnoreCase))
            {
                return new(200, new JsonObject
                {
                    ["kind"] = "bigquery#job",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                    ["status"] = new JsonObject { ["state"] = "DONE" },
                    ["statistics"] = new JsonObject { ["sessionInfo"] = new JsonObject { ["sessionId"] = "sess-r6-race" } }
                }.ToJsonString());
            }
            if (queryText.Contains("ABORT_SESSION", StringComparison.Ordinal))
            {
                abortedSessions.Add(request.Body ?? queryText);
                return new(200, new JsonObject
                {
                    ["kind"] = "bigquery#job",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                    ["status"] = new JsonObject { ["state"] = "DONE" }
                }.ToJsonString());
            }
            var attempt = Interlocked.Increment(ref userInsertAttempts);
            if (attempt == 1)
                return new(500, "{\"error\":{\"code\":500,\"message\":\"Transient backend error\",\"errors\":[{\"reason\":\"backendError\"}]}}");
            // Attempt 2: return 403 after an ambiguous 500 -> InsertJobAsync wraps in BigQueryJobMayExist!
            return new(403, "{\"error\":{\"code\":403,\"message\":\"Access Denied\",\"errors\":[{\"reason\":\"accessDenied\"}]}}");
        });
        fake.On("POST", BaseUrl + "/jobs/[^/]+/cancel", _ =>
        {
            Interlocked.Increment(ref cancelCalled);
            // Simulate a peer failing and cancelling phase1Cts while this target is cleaning up in catch/SettleAsync!
            cts.Cancel();
            r6CancelSeen.TrySetResult();
            return new(200, "{\"kind\":\"bigquery#jobCancelResponse\",\"job\":{\"status\":{\"state\":\"DONE\"}}}");
        });
        fake.On("GET", BaseUrl + "/jobs/[^/]+", request =>
        {
            var id = request.Uri.Segments[^1].TrimEnd('/');
            if (Volatile.Read(ref userInsertAttempts) < 2)
                return new(404, "{\"error\":{\"code\":404,\"message\":\"Not found\",\"errors\":[{\"reason\":\"notFound\"}]}}");
            // Ensure phase1Cts is cancelled during SettleAsync even if fire-and-forget CancelJob runs later under CPU contention.
            cts.Cancel();
            return new(200, new JsonObject
            {
                ["kind"] = "bigquery#job",
                ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                ["status"] = new JsonObject { ["state"] = "DONE" },
                ["statistics"] = new JsonObject { ["query"] = new JsonObject { ["statementType"] = "INSERT" } }
            }.ToJsonString());
        });
        fake.On("GET", BaseUrl + "/jobs", _ => new(200, "{\"kind\":\"bigquery#jobList\",\"jobs\":[]}"));

        var runner = new BigQueryMultiRunner(service);
        var budget = service.Results.BeginQuery(Guid.NewGuid().ToString());
        using var events = new QueryEventSink(null);
        var messages = new QueryMessages(events.Message);

        var ctx = MakeContext("bq-r6", connId, "transaction", "INSERT INTO sales.t VALUES (1);", budget, messages, events) with
        {
            IsUserCancelled = () => false,
            IsTimedOut = () => false
        };
        var res = await runner.ExecutePhase1Async(ctx, cts.Token);
        // CancelJob is fire-and-forget; await its HTTP delivery before checking cancelCalled or snapshotting preCancelCount.
        await Task.WhenAny(r6CancelSeen.Task, Task.Delay(5000));
        check(res.Result.Outcome.Status == "failed" && res.Result.Outcome.Error is not null
            && Volatile.Read(ref cancelCalled) >= 1 && abortedSessions.Any(q => q.Contains("sess-r6-race", StringComparison.Ordinal)),
            $"500->403+cancel reports real failed error (not masked rolledBack) and still cancels job + aborts session ({res.Result.Outcome.Status}/{res.Result.Outcome.Error?.Code}, cancel={cancelCalled}, aborted={abortedSessions.Count})");

        // Pre-cancelled token before BEGIN TRANSACTION completes immediately without CancelJob or UnbornCancelLimit wait.
        var preCancelCount = Volatile.Read(ref cancelCalled);
        using var alreadyCancelled = new CancellationTokenSource();
        alreadyCancelled.Cancel();
        service.BigQuery.UnbornCancelLimit = TimeSpan.FromSeconds(5);
        var preSw = System.Diagnostics.Stopwatch.StartNew();
        var preCtx = MakeContext("bq-r7-pre", connId, "transaction", "SELECT 1;", budget, messages, events) with
        {
            IsUserCancelled = () => true,
            IsTimedOut = () => false
        };
        var preRes = await runner.ExecutePhase1Async(preCtx, alreadyCancelled.Token);
        preSw.Stop();
        check(preRes.Result.Outcome.Status == "cancelled" && Volatile.Read(ref cancelCalled) == preCancelCount && preSw.ElapsedMilliseconds < 2000,
            $"Pre-cancelled token before BEGIN TRANSACTION skips phantom CancelJob and UnbornCancelLimit ({preRes.Result.Outcome.Status}, cancels={Volatile.Read(ref cancelCalled) - preCancelCount}, ms={preSw.ElapsedMilliseconds})");

        // Transport-wrapped ObjectDisposedException during CommitCoreAsync is ambiguous (InDoubt), not PreSendClientFailure Refused.
        {
            var dispBq = new BigQuerySessionChecks.Bq();
            var dispFake = dispBq.Fake();
            using var dispSvc = NewService(dispFake);
            dispSvc.BigQuery.CommitLimit = TimeSpan.FromMilliseconds(150);
            dispSvc.BigQuery.RetryDelay = TimeSpan.FromMilliseconds(10);
            var dispConnId = await ConnectGoogleAsync(dispSvc, key, location: "US", dataset: "sales");
            var dispConn = dispSvc.BigQuery.Find(dispConnId)!;
            dispFake.Fault = req => req.Method == "POST" && req.Url.EndsWith("/jobs", StringComparison.Ordinal)
                ? new HttpRequestException("stream torn down", new IOException("closed", new ObjectDisposedException("SslStream")))
                : null;
            dispFake.On("GET", BaseUrl + "/jobs/[^/]+", _ => new(404, "{\"error\":{\"code\":404,\"message\":\"Not found\",\"errors\":[{\"reason\":\"notFound\"}]}}"));
            var dispSession = new BigQueryTabSession("ephem-disp", dispConn) { Id = "sess-disp", Location = "US", Transaction = BigQueryTransaction.Open };
            var dispRes = await dispSvc.BigQuery.CommitCoreAsync(dispSession, CancellationToken.None);
            check(dispRes.Outcome == MultiCommitOutcome.InDoubt,
                $"Transport-wrapped ObjectDisposedException in CommitCoreAsync returns InDoubt (not Refused): {dispRes.Outcome}");
        }

        // Failed SCRIPT job with 0 child jobs transitions SettleAsync session.Transaction from Open to Unknown.
        {
            var scrBq = new BigQuerySessionChecks.Bq();
            var scrFake = scrBq.Fake();
            using var scrSvc = NewService(scrFake);
            var scrConnId = await ConnectGoogleAsync(scrSvc, key, location: "US", dataset: "sales");
            var scrConn = scrSvc.BigQuery.Find(scrConnId)!;
            scrFake.On("GET", BaseUrl + "/jobs/script-zero-child", _ => new(200, new JsonObject
            {
                ["kind"] = "bigquery#job",
                ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = "script-zero-child", ["location"] = "US" },
                ["status"] = new JsonObject
                {
                    ["state"] = "DONE",
                    ["errorResult"] = new JsonObject { ["reason"] = "invalidQuery", ["message"] = "RAISE boom" }
                },
                ["statistics"] = new JsonObject
                {
                    ["query"] = new JsonObject { ["statementType"] = "SCRIPT" },
                    ["numChildJobs"] = "0"
                }
            }.ToJsonString()));
            scrFake.On("GET", BaseUrl + "/jobs", _ => new(200, "{\"kind\":\"bigquery#jobList\",\"jobs\":[]}"));
            var scrSession = new BigQueryTabSession("ephem-scr", scrConn)
            {
                Id = "sess-scr",
                Location = "US",
                Transaction = BigQueryTransaction.Open,
                Tail = new BigQueryTail("script-zero-child", "US", cancelled: false, created: true)
            };
            await scrSvc.BigQuery.SettleAsync(scrSession, CancellationToken.None);
            check(scrSession.Transaction == BigQueryTransaction.Unknown,
                $"SettleAsync transitions Open -> Unknown when SCRIPT fails with 0 child jobs ({scrSession.Transaction})");
        }

        // Fire-and-Forget PreflightDryRun on a SCRIPT with Automatic location and no dataset does NOT pin Phase 1 location to US.
        {
            var ffBq = new BigQuerySessionChecks.Bq();
            var ffFake = ffBq.Fake();
            using var ffSvc = NewService(ffFake);
            var ffConnId = await ConnectGoogleAsync(ffSvc, key, location: null, dataset: null);
            string? realJobLocation = "NOT_SENT";
            ffFake.On("POST", BaseUrl + "/jobs", req =>
            {
                var body = JsonNode.Parse(req.Body!)!.AsObject();
                var isDry = body["configuration"]?["dryRun"]?.GetValue<bool>() == true;
                var id = body["jobReference"]?["jobId"]?.GetValue<string>() ?? "dry-1";
                if (isDry)
                {
                    return new(200, new JsonObject
                    {
                        ["kind"] = "bigquery#job",
                        ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                        ["status"] = new JsonObject { ["state"] = "DONE" },
                        ["statistics"] = new JsonObject
                        {
                            ["query"] = new JsonObject { ["statementType"] = "SCRIPT", ["totalBytesProcessed"] = "0" }
                        }
                    }.ToJsonString());
                }
                realJobLocation = body["jobReference"]?["location"]?.GetValue<string>();
                return new(200, new JsonObject
                {
                    ["kind"] = "bigquery#job",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "EU" },
                    ["status"] = new JsonObject { ["state"] = "DONE" },
                    ["statistics"] = new JsonObject { ["query"] = new JsonObject { ["statementType"] = "SCRIPT" }, ["numChildJobs"] = "0" }
                }.ToJsonString());
            });
            ffFake.On("GET", BaseUrl + "/jobs/[^/]+", req => new(200, new JsonObject
            {
                ["kind"] = "bigquery#job",
                ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = req.Uri.Segments[^1], ["location"] = "EU" },
                ["status"] = new JsonObject { ["state"] = "DONE" },
                ["statistics"] = new JsonObject { ["query"] = new JsonObject { ["statementType"] = "SCRIPT" }, ["numChildJobs"] = "0" }
            }.ToJsonString()));
            ffFake.On("GET", BaseUrl + "/jobs", _ => new(200, "{\"kind\":\"bigquery#jobList\",\"jobs\":[]}"));
            var ffRunner = new BigQueryMultiRunner(ffSvc);
            var ffBudget = ffSvc.Results.BeginQuery(Guid.NewGuid().ToString());
            using var ffEvents = new QueryEventSink(null);
            var ffMessages = new QueryMessages(ffEvents.Message);
            var ffCtx = MakeContext("bq-r7-ff", ffConnId, "fireAndForget", "SELECT 1; SELECT 2;", ffBudget, ffMessages, ffEvents, preflightDryRun: true);
            var ffPre = await ffRunner.PreflightAsync([ffCtx], CancellationToken.None);
            await ffRunner.ExecutePhase1Async(ffCtx, CancellationToken.None);
            check(ffPre[0].Passed && realJobLocation is null,
                $"Fire-and-Forget SCRIPT dry-run with Automatic location does not pin Phase 1 to US (location={realJobLocation ?? "<null>"})");
        }

        // Round 8 hardening checks:
        // 1. IsCancellationError classifies Storage Read Grpc.Core.RpcException(Cancelled) & wrapped OCE, while rejecting BigQueryJobMayExist & non-cancel RpcException.
        {
            var grpcCancel = new Grpc.Core.RpcException(new Grpc.Core.Status(Grpc.Core.StatusCode.Cancelled, "cancelled"));
            var grpcPerm = new Grpc.Core.RpcException(new Grpc.Core.Status(Grpc.Core.StatusCode.PermissionDenied, "denied"));
            var wrappedOce = new AggregateException(new OperationCanceledException());
            var mayExist = new BigQueryJobMayExist(new HttpRequestException("drop"), exists: false);
            check(BigQueryMultiRunner.IsCancellationError(grpcCancel, timedOut: false)
                && BigQueryMultiRunner.IsCancellationError(wrappedOce, timedOut: false)
                && !BigQueryMultiRunner.IsCancellationError(grpcPerm, timedOut: false)
                && !BigQueryMultiRunner.IsCancellationError(mayExist, timedOut: false),
                "BigQueryMultiRunner.IsCancellationError classifies gRPC Cancelled and wrapped OCE without masking non-cancel errors");
        }

        // 2. InsertJobAsync recovering an already-DONE failed SCRIPT (409 -> GetJobAsync) with COMMIT_TRANSACTION child detects commitInDoubt.
        {
            var r8Bq = new BigQuerySessionChecks.Bq();
            var r8Fake = r8Bq.Fake();
            using var r8Svc = NewService(r8Fake);
            var r8ConnId = await ConnectGoogleAsync(r8Svc, key, location: "US", dataset: "sales");
            string? parentScriptId = null;
            r8Fake.On("POST", BaseUrl + "/jobs", req =>
            {
                var body = JsonNode.Parse(req.Body!)!.AsObject();
                var id = body["jobReference"]?["jobId"]?.GetValue<string>() ?? Guid.NewGuid().ToString("N");
                var q = body["configuration"]!["query"]!["query"]!.GetValue<string>();
                if (q.StartsWith("BEGIN TRANSACTION", StringComparison.OrdinalIgnoreCase))
                {
                    return new(200, new JsonObject
                    {
                        ["kind"] = "bigquery#job",
                        ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                        ["status"] = new JsonObject { ["state"] = "DONE" },
                        ["statistics"] = new JsonObject { ["sessionInfo"] = new JsonObject { ["sessionId"] = "sess-r8-409" } }
                    }.ToJsonString());
                }
                if (q.Contains("ABORT_SESSION", StringComparison.Ordinal))
                {
                    return new(200, new JsonObject
                    {
                        ["kind"] = "bigquery#job",
                        ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                        ["status"] = new JsonObject { ["state"] = "DONE" }
                    }.ToJsonString());
                }
                parentScriptId = id;
                // Simulate 409 Conflict so InsertJobAsync recovers an already-DONE failed SCRIPT via GetJobAsync!
                return new(409, "{\"error\":{\"code\":409,\"message\":\"Already Exists\",\"errors\":[{\"reason\":\"duplicate\"}]}}");
            });
            r8Fake.On("GET", BaseUrl + "/jobs/[^/]+", req =>
            {
                var id = req.Uri.Segments[^1].TrimEnd('/');
                return new(200, new JsonObject
                {
                    ["kind"] = "bigquery#job",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                    ["status"] = new JsonObject
                    {
                        ["state"] = "DONE",
                        ["errorResult"] = new JsonObject { ["reason"] = "invalidQuery", ["message"] = "failed after commit" }
                    },
                    ["statistics"] = new JsonObject
                    {
                        ["query"] = new JsonObject { ["statementType"] = "SCRIPT" },
                        ["numChildJobs"] = "1"
                    }
                }.ToJsonString());
            });
            r8Fake.On("GET", BaseUrl + "/jobs", _ => new(200, new JsonObject
            {
                ["kind"] = "bigquery#jobList",
                ["jobs"] = new JsonArray(new JsonObject
                {
                    ["id"] = "varia-alpha:US.child-commit-1",
                    ["state"] = "DONE",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = "child-commit-1", ["location"] = "US" },
                    ["status"] = new JsonObject { ["state"] = "DONE" },
                    ["statistics"] = new JsonObject
                    {
                        ["parentJobId"] = parentScriptId,
                        ["query"] = new JsonObject { ["statementType"] = "COMMIT_TRANSACTION" }
                    }
                })
            }.ToJsonString()));
            var r8Runner = new BigQueryMultiRunner(r8Svc);
            var r8Budget = r8Svc.Results.BeginQuery(Guid.NewGuid().ToString());
            using var r8Events = new QueryEventSink(null);
            var r8Messages = new QueryMessages(r8Events.Message);
            var r8Ctx = MakeContext("bq-r8-409", r8ConnId, "transaction", "SELECT 1; SELECT 2;", r8Budget, r8Messages, r8Events);
            var r8Res = await r8Runner.ExecutePhase1Async(r8Ctx, CancellationToken.None);
            check(r8Res.Result.Outcome.Status == "commitInDoubt" && parentScriptId is not null
                && (r8Res.Result.Outcome.Error?.Message.Contains("committed a transaction before it stopped", StringComparison.Ordinal) ?? false),
                $"Already-DONE failed SCRIPT from InsertJobAsync 409 recovery runs SettleAsync and detects COMMIT_TRANSACTION ({r8Res.Result.Outcome.Status}: {r8Res.Result.Outcome.Error?.Message})");
        }

        // 3. Job-backed results.remoteQuery (kind="view") on a rolled-back windowed multi-target result propagates RolledBackPreview + target metadata.
        {
            var vBq = new BigQuerySessionChecks.Bq();
            vBq.Statements["BEGIN TRANSACTION;"] = "BEGIN_TRANSACTION";
            vBq.Statements["SELECT * FROM sales.big_view"] = "SELECT";
            var vFake = vBq.Fake();
            var vDest = new JsonObject { ["projectId"] = "varia-alpha", ["datasetId"] = "_anon", ["tableId"] = "anon_view_tbl" };
            vFake.On("GET", BaseUrl + "/jobs/[^/]+", req =>
            {
                var id = req.Uri.Segments[^1].TrimEnd('/');
                if (vBq.Jobs.TryGetValue(id, out var job))
                {
                    job.State = "DONE";
                    return new(200, new JsonObject
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
                            ["query"] = new JsonObject { ["query"] = job.Sql, ["useLegacySql"] = false, ["destinationTable"] = vDest.DeepClone() }
                        }
                    }.ToJsonString());
                }
                return new(404, "{\"error\":{\"code\":404,\"message\":\"Not found\"}}");
            });
            vFake.On("GET", BaseUrl + "/queries/[^/]+", req =>
            {
                var id = req.Uri.Segments[^1].TrimEnd('/');
                if (vBq.Jobs.TryGetValue(id, out var job) && job.Sql == "SELECT * FROM sales.big_view")
                {
                    var rows = new JsonArray([.. Enumerable.Range(0, 500).Select(i => (JsonNode)new JsonObject
                    {
                        ["f"] = new JsonArray(new JsonObject { ["v"] = i.ToString(CultureInfo.InvariantCulture) }, new JsonObject { ["v"] = new string('B', 200) })
                    })]);
                    return new(200, new JsonObject
                    {
                        ["kind"] = "bigquery#getQueryResultsResponse",
                        ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                        ["jobComplete"] = true,
                        ["totalRows"] = "2000",
                        ["schema"] = new JsonObject { ["fields"] = new JsonArray(new JsonObject { ["name"] = "id", ["type"] = "INT64" }, new JsonObject { ["name"] = "payload", ["type"] = "STRING" }) },
                        ["rows"] = rows,
                        ["pageToken"] = "page-500"
                    }.ToJsonString());
                }
                // Derived view query returns 2 rows fitting in memory.
                return new(200, new JsonObject
                {
                    ["kind"] = "bigquery#getQueryResultsResponse",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                    ["jobComplete"] = true,
                    ["totalRows"] = "2",
                    ["schema"] = new JsonObject { ["fields"] = new JsonArray(new JsonObject { ["name"] = "id", ["type"] = "INT64" }, new JsonObject { ["name"] = "payload", ["type"] = "STRING" }) },
                    ["rows"] = new JsonArray(
                        new JsonObject { ["f"] = new JsonArray(new JsonObject { ["v"] = "2" }, new JsonObject { ["v"] = "x" }) },
                        new JsonObject { ["f"] = new JsonArray(new JsonObject { ["v"] = "1" }, new JsonObject { ["v"] = "y" }) })
                }.ToJsonString());
            });
            using var vSvc = new SqlService(new ResultStore(4L << 20, 64 * 1024), bigQuery: new BigQueryEnvironment(null, vFake.Factory, new SubjectTokens([])));
            vSvc.BigQuery.RetryDelay = TimeSpan.FromMilliseconds(1);
            vSvc.BigQuery.ChildPollMs = 20;
            vSvc.BigQuery.DonePoll = TimeSpan.FromMilliseconds(10);
            var vConnId = await ConnectGoogleAsync(vSvc, key, location: "US", dataset: "sales");
            var vRunner = new BigQueryMultiRunner(vSvc);
            var vBudget = vSvc.Results.BeginQuery(Guid.NewGuid().ToString());
            vBudget.Executing = true;
            using var vEvents = new QueryEventSink(null);
            var vMessages = new QueryMessages(vEvents.Message);
            var vCtx = MakeContext("bq-r8-view", vConnId, "transaction", "SELECT * FROM sales.big_view", vBudget, vMessages, vEvents, residence: "automatic");
            await vRunner.PreflightAsync([vCtx], CancellationToken.None);
            var vPhase1 = await vRunner.ExecutePhase1Async(vCtx, CancellationToken.None);
            var vWinSet = vPhase1.Result.ResultSets[0];
            await using (var h = vPhase1.Phase2!) { await h.RollbackAsync(CancellationToken.None); }
            vBudget.Executing = false;
            var viewArgs = new JsonObject
            {
                ["queryId"] = Guid.NewGuid().ToString(),
                ["resultId"] = vWinSet.ResultId,
                ["generation"] = 1,
                ["kind"] = "view",
                ["sort"] = new JsonArray(new JsonObject { ["column"] = 0, ["descending"] = true })
            };
            var (viewCode, viewResObj, viewErr) = await DispatchAsync(vSvc, "results.remoteQuery", viewArgs);
            var viewSetId = (viewResObj as QueryResult)?.ResultSets.FirstOrDefault()?.ResultId;
            var viewBuf = viewSetId is { } vsid ? vSvc.Results.Find(vsid) : null;
            check(viewCode == "ok" && viewBuf is { RolledBackPreview: true, TargetKey: "bq-r8-view", TargetProvider: Providers.BigQuery } && viewBuf.StatementSlot == vWinSet.StatementSlot,
                $"Job-backed BigQuery view propagates RolledBackPreview and target metadata ({viewCode} {viewErr}, rb={viewBuf?.RolledBackPreview}, tk={viewBuf?.TargetKey})");
        }

        // Round 9 hardening checks:
        // 1. SettleAsync returns ListingComplete == false when a DONE parent still has an unfinished (!child.Done) child.
        {
            var r9Bq = new BigQuerySessionChecks.Bq();
            var r9Fake = r9Bq.Fake();
            using var r9Svc = NewService(r9Fake);
            var r9ConnId = await ConnectGoogleAsync(r9Svc, key, location: "US", dataset: "sales");
            var r9Conn = r9Svc.BigQuery.Find(r9ConnId)!;
            r9Fake.On("GET", BaseUrl + "/jobs/script-ec-child", _ => new(200, new JsonObject
            {
                ["kind"] = "bigquery#job",
                ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = "script-ec-child", ["location"] = "US" },
                ["status"] = new JsonObject { ["state"] = "DONE" },
                ["statistics"] = new JsonObject
                {
                    ["query"] = new JsonObject { ["statementType"] = "SCRIPT" },
                    ["numChildJobs"] = "1"
                }
            }.ToJsonString()));
            r9Fake.On("GET", BaseUrl + "/jobs", _ => new(200, new JsonObject
            {
                ["kind"] = "bigquery#jobList",
                ["jobs"] = new JsonArray(new JsonObject
                {
                    ["id"] = "varia-alpha:US.child-running-1",
                    ["state"] = "RUNNING",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = "child-running-1", ["location"] = "US" },
                    ["status"] = new JsonObject { ["state"] = "RUNNING" },
                    ["statistics"] = new JsonObject
                    {
                        ["parentJobId"] = "script-ec-child",
                        ["query"] = new JsonObject { ["statementType"] = "COMMIT_TRANSACTION" }
                    }
                })
            }.ToJsonString()));
            var r9Session = new BigQueryTabSession("ephem-ec", r9Conn)
            {
                Id = "sess-ec",
                Location = "US",
                Transaction = BigQueryTransaction.Open,
                Tail = new BigQueryTail("script-ec-child", "US", cancelled: true, created: true)
            };
            var settled = await r9Svc.BigQuery.SettleAsync(r9Session, CancellationToken.None);
            check(settled.Done && !settled.ListingComplete && r9Session.Transaction == BigQueryTransaction.Unknown,
                $"SettleAsync marks ListingComplete=false when DONE parent has unfinished child ({settled}, tx={r9Session.Transaction})");
        }

        // 2. Peer-aborted BigQuery target stays rolledBack even if IsTimedOut flips true while awaiting SettleAsync/AbortEphemeralSessionAsync.
        {
            var r9tBq = new BigQuerySessionChecks.Bq();
            var r9tFake = r9tBq.Fake();
            using var r9tSvc = NewService(r9tFake);
            var r9tConnId = await ConnectGoogleAsync(r9tSvc, key, location: "US", dataset: "sales");
            var timedOutFlag = 0;
            using var r9tCts = new CancellationTokenSource();
            r9tFake.On("POST", BaseUrl + "/jobs", req =>
            {
                var body = JsonNode.Parse(req.Body!)!.AsObject();
                var id = body["jobReference"]?["jobId"]?.GetValue<string>() ?? Guid.NewGuid().ToString("N");
                var q = body["configuration"]!["query"]!["query"]!.GetValue<string>();
                if (q.StartsWith("BEGIN TRANSACTION", StringComparison.OrdinalIgnoreCase))
                {
                    return new(200, new JsonObject
                    {
                        ["kind"] = "bigquery#job",
                        ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                        ["status"] = new JsonObject { ["state"] = "DONE" },
                        ["statistics"] = new JsonObject { ["sessionInfo"] = new JsonObject { ["sessionId"] = "sess-r9-timeout" } }
                    }.ToJsonString());
                }
                if (q.Contains("ABORT_SESSION", StringComparison.Ordinal))
                {
                    // Flip IsTimedOut to true during cleanup!
                    Volatile.Write(ref timedOutFlag, 1);
                    return new(200, new JsonObject
                    {
                        ["kind"] = "bigquery#job",
                        ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                        ["status"] = new JsonObject { ["state"] = "DONE" }
                    }.ToJsonString());
                }
                return new(200, new JsonObject
                {
                    ["kind"] = "bigquery#job",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                    ["status"] = new JsonObject { ["state"] = "RUNNING" }
                }.ToJsonString());
            });
            r9tFake.On("GET", BaseUrl + "/queries/[^/]+", _ =>
            {
                // Peer fails -> cancel token while IsTimedOut is still false!
                r9tCts.Cancel();
                return new(200, "{\"kind\":\"bigquery#getQueryResultsResponse\",\"jobComplete\":false}");
            });
            r9tFake.On("POST", BaseUrl + "/jobs/[^/]+/cancel", _ => new(200, "{\"kind\":\"bigquery#jobCancelResponse\",\"job\":{\"status\":{\"state\":\"DONE\"}}}"));
            r9tFake.On("GET", BaseUrl + "/jobs/[^/]+", req => new(200, new JsonObject
            {
                ["kind"] = "bigquery#job",
                ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = req.Uri.Segments[^1].TrimEnd('/'), ["location"] = "US" },
                ["status"] = new JsonObject { ["state"] = "DONE" },
                ["statistics"] = new JsonObject { ["query"] = new JsonObject { ["statementType"] = "INSERT" } }
            }.ToJsonString()));
            var r9tRunner = new BigQueryMultiRunner(r9tSvc);
            var r9tBudget = r9tSvc.Results.BeginQuery(Guid.NewGuid().ToString());
            using var r9tEvents = new QueryEventSink(null);
            var r9tMessages = new QueryMessages(r9tEvents.Message);
            var r9tCtx = MakeContext("bq-r9-to", r9tConnId, "transaction", "INSERT INTO sales.t VALUES (1);", r9tBudget, r9tMessages, r9tEvents) with
            {
                IsTimedOut = () => Volatile.Read(ref timedOutFlag) != 0,
                IsUserCancelled = () => false
            };
            var r9tRes = await r9tRunner.ExecutePhase1Async(r9tCtx, r9tCts.Token);
            check(r9tRes.Result.Outcome.Status == "rolledBack" && r9tRes.Result.Outcome.Error is null && Volatile.Read(ref timedOutFlag) == 1,
                $"Peer-aborted target keeps rolledBack even if IsTimedOut flips true during cleanup ({r9tRes.Result.Outcome.Status}/{r9tRes.Result.Outcome.Error?.Code}, timedOut={timedOutFlag})");
        }

        // Round 10 hardening checks:
        // 1. IsCancellationError treats BigQuery server-side jobTimeoutMs (Reason=="stopped" + "timed out") as timeout-only, never peer-abort rolledBack.
        {
            var serverTimeoutEx = new BigQueryJobException(
                new Google.Apis.Bigquery.v2.Data.ErrorProto { Reason = "stopped", Message = "Job execution timed out after 10s" },
                []);
            var plainStoppedEx = new BigQueryJobException(
                new Google.Apis.Bigquery.v2.Data.ErrorProto { Reason = "stopped", Message = "Job execution was cancelled: User requested cancellation" },
                []);
            check(!BigQueryMultiRunner.IsCancellationError(serverTimeoutEx, timedOut: false)
                && BigQueryMultiRunner.IsCancellationError(serverTimeoutEx, timedOut: true)
                && BigQueryMultiRunner.IsCancellationError(plainStoppedEx, timedOut: false)
                && !BigQueryMultiRunner.IsCancellationError(new TimeoutException("BigQuery did not answer in time.", new OperationCanceledException()), timedOut: false)
                && !BigQueryMultiRunner.IsCancellationError(new TaskCanceledException("HttpClient timeout", new TimeoutException()), timedOut: false),
                "IsCancellationError requires timedOut=true for BigQuery Reason==stopped with 'timed out' and rejects CallAsync/HttpClient TimeoutExceptions");
        }

        // 2. Regional auto-location job cancelled while InsertJobAsync returns uses inserted.JobReference.Location in CancelJob.
        {
            var regBq = new BigQuerySessionChecks.Bq();
            var regFake = regBq.Fake();
            using var regSvc = NewService(regFake);
            var regConnId = await ConnectGoogleAsync(regSvc, key, location: null, dataset: null);
            using var regCts = new CancellationTokenSource();
            string? cancelLocation = null;
            regFake.On("POST", BaseUrl + "/jobs", req =>
            {
                var body = JsonNode.Parse(req.Body!)!.AsObject();
                var id = body["jobReference"]?["jobId"]?.GetValue<string>() ?? Guid.NewGuid().ToString("N");
                return new(200, new JsonObject
                {
                    ["kind"] = "bigquery#job",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "asia-northeast1" },
                    ["status"] = new JsonObject { ["state"] = "RUNNING" }
                }.ToJsonString());
            });
            regFake.On("GET", BaseUrl + "/queries/[^/]+", _ =>
            {
                regCts.Cancel();
                return new(200, "{\"kind\":\"bigquery#getQueryResultsResponse\",\"jobComplete\":false}");
            });
            var cancelSeen = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            regFake.On("POST", BaseUrl + "/jobs/[^/]+/cancel", req =>
            {
                cancelLocation = HttpUtility.ParseQueryString(req.Uri.Query)["location"];
                cancelSeen.TrySetResult();
                return new(200, "{\"kind\":\"bigquery#jobCancelResponse\",\"job\":{\"status\":{\"state\":\"DONE\"}}}");
            });
            var regRunner = new BigQueryMultiRunner(regSvc);
            var regBudget = regSvc.Results.BeginQuery(Guid.NewGuid().ToString());
            using var regEvents = new QueryEventSink(null);
            var regMessages = new QueryMessages(regEvents.Message);
            var regCtx = MakeContext("bq-r10-reg", regConnId, "fireAndForget", "SELECT 1;", regBudget, regMessages, regEvents) with
            {
                IsUserCancelled = () => true,
                IsTimedOut = () => false
            };
            var regRes = await regRunner.ExecutePhase1Async(regCtx, regCts.Token);
            await Task.WhenAny(cancelSeen.Task, Task.Delay(5000));
            check(regRes.Result.Outcome.Status == "cancelled" && cancelLocation == "asia-northeast1",
                $"Regional auto-location cancel passes inserted location to CancelJob (status={regRes.Result.Outcome.Status}, cancelLoc={cancelLocation ?? "<null>"})");
        }

        // Round 12 hardening checks:
        // 1. Post-jobFailed peer cancellation during GetJobAsync preserves real BigQueryJobException (failed/SQL_ERROR, not masked rolledBack).
        {
            var jfBq = new BigQuerySessionChecks.Bq();
            var jfFake = jfBq.Fake();
            using var jfSvc = NewService(jfFake);
            var jfConnId = await ConnectGoogleAsync(jfSvc, key, location: "US", dataset: "sales");
            using var jfCts = new CancellationTokenSource();
            var getJobCount = 0;
            jfFake.On("POST", BaseUrl + "/jobs", req =>
            {
                var body = JsonNode.Parse(req.Body!)!.AsObject();
                var id = body["jobReference"]?["jobId"]?.GetValue<string>() ?? Guid.NewGuid().ToString("N");
                var q = body["configuration"]!["query"]!["query"]!.GetValue<string>();
                if (q.StartsWith("BEGIN TRANSACTION", StringComparison.OrdinalIgnoreCase))
                {
                    return new(200, new JsonObject
                    {
                        ["kind"] = "bigquery#job",
                        ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                        ["status"] = new JsonObject { ["state"] = "DONE" },
                        ["statistics"] = new JsonObject { ["sessionInfo"] = new JsonObject { ["sessionId"] = "sess-r12-jf" } }
                    }.ToJsonString());
                }
                if (q.Contains("ABORT_SESSION", StringComparison.Ordinal))
                {
                    return new(200, new JsonObject
                    {
                        ["kind"] = "bigquery#job",
                        ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                        ["status"] = new JsonObject { ["state"] = "DONE" }
                    }.ToJsonString());
                }
                return new(200, new JsonObject
                {
                    ["kind"] = "bigquery#job",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                    ["status"] = new JsonObject { ["state"] = "RUNNING" }
                }.ToJsonString());
            });
            // QueryResults returns 400 job error -> QueryResultsAsync calls GetJobAsync (#1) to construct BigQueryJobException!
            jfFake.On("GET", BaseUrl + "/queries/[^/]+", _ =>
                new(400, "{\"error\":{\"code\":400,\"message\":\"Division by zero\",\"errors\":[{\"reason\":\"invalidQuery\",\"message\":\"Division by zero\"}]}}"));
            jfFake.On("GET", BaseUrl + "/jobs/[^/]+", req =>
            {
                var n = Interlocked.Increment(ref getJobCount);
                if (n == 2)
                {
                    // Second GetJobAsync (post-jobFailed in BigQueryMultiRunner) races peer cancellation!
                    jfCts.Cancel();
                }
                return new(200, new JsonObject
                {
                    ["kind"] = "bigquery#job",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = req.Uri.Segments[^1].TrimEnd('/'), ["location"] = "US" },
                    ["status"] = new JsonObject
                    {
                        ["state"] = "DONE",
                        ["errorResult"] = new JsonObject { ["reason"] = "invalidQuery", ["message"] = "Division by zero" }
                    },
                    ["statistics"] = new JsonObject { ["query"] = new JsonObject { ["statementType"] = "SELECT" } }
                }.ToJsonString());
            });
            jfFake.On("POST", BaseUrl + "/jobs/[^/]+/cancel", _ => new(200, "{\"kind\":\"bigquery#jobCancelResponse\",\"job\":{\"status\":{\"state\":\"DONE\"}}}"));
            var jfRunner = new BigQueryMultiRunner(jfSvc);
            var jfBudget = jfSvc.Results.BeginQuery(Guid.NewGuid().ToString());
            using var jfEvents = new QueryEventSink(null);
            var jfMessages = new QueryMessages(jfEvents.Message);
            var jfCtx = MakeContext("bq-r12-jf", jfConnId, "transaction", "SELECT 1/0;", jfBudget, jfMessages, jfEvents) with
            {
                IsUserCancelled = () => false,
                IsTimedOut = () => false
            };
            var jfRes = await jfRunner.ExecutePhase1Async(jfCtx, jfCts.Token);
            check(jfRes.Result.Outcome.Status == "failed" && jfRes.Result.Outcome.Error?.Code == "SQL_ERROR"
                && (jfRes.Result.Outcome.Error?.Message.Contains("Division by zero", StringComparison.Ordinal) ?? false),
                $"Post-jobFailed peer cancel during GetJobAsync preserves BigQueryJobException ({jfRes.Result.Outcome.Status}/{jfRes.Result.Outcome.Error?.Code}: {jfRes.Result.Outcome.Error?.Message})");
        }

        // 2. BEGIN TRANSACTION cancelled mid-WaitDoneAsync captures sessionId via GetJobAsync and aborts ephemeral session.
        {
            var bgBq = new BigQuerySessionChecks.Bq();
            var bgFake = bgBq.Fake();
            using var bgSvc = NewService(bgFake);
            var bgConnId = await ConnectGoogleAsync(bgSvc, key, location: "US", dataset: "sales");
            using var bgCts = new CancellationTokenSource();
            var bgAborts = new ConcurrentBag<string>();
            var bgGets = 0;
            bgFake.On("POST", BaseUrl + "/jobs", req =>
            {
                var body = JsonNode.Parse(req.Body!)!.AsObject();
                var id = body["jobReference"]?["jobId"]?.GetValue<string>() ?? Guid.NewGuid().ToString("N");
                var q = body["configuration"]!["query"]!["query"]!.GetValue<string>();
                if (q.StartsWith("BEGIN TRANSACTION", StringComparison.OrdinalIgnoreCase))
                {
                    // Return RUNNING without sessionInfo yet so WaitDoneAsync polls!
                    return new(200, new JsonObject
                    {
                        ["kind"] = "bigquery#job",
                        ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                        ["status"] = new JsonObject { ["state"] = "RUNNING" }
                    }.ToJsonString());
                }
                if (q.Contains("ABORT_SESSION", StringComparison.Ordinal))
                {
                    bgAborts.Add(req.Body ?? q);
                    return new(200, new JsonObject
                    {
                        ["kind"] = "bigquery#job",
                        ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = id, ["location"] = "US" },
                        ["status"] = new JsonObject { ["state"] = "DONE" }
                    }.ToJsonString());
                }
                return new(200, "{}");
            });
            bgFake.On("GET", BaseUrl + "/jobs/[^/]+", req =>
            {
                var n = Interlocked.Increment(ref bgGets);
                if (n == 1)
                {
                    // Cancel mid-WaitDoneAsync!
                    bgCts.Cancel();
                    return new(200, new JsonObject
                    {
                        ["kind"] = "bigquery#job",
                        ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = req.Uri.Segments[^1].TrimEnd('/'), ["location"] = "US" },
                        ["status"] = new JsonObject { ["state"] = "RUNNING" }
                    }.ToJsonString());
                }
                // Catch settle loop captures sessionId from DONE BEGIN job!
                return new(200, new JsonObject
                {
                    ["kind"] = "bigquery#job",
                    ["jobReference"] = new JsonObject { ["projectId"] = "varia-alpha", ["jobId"] = req.Uri.Segments[^1].TrimEnd('/'), ["location"] = "US" },
                    ["status"] = new JsonObject { ["state"] = "DONE" },
                    ["statistics"] = new JsonObject { ["sessionInfo"] = new JsonObject { ["sessionId"] = "sess-r12-begin-abort" } }
                }.ToJsonString());
            });
            bgFake.On("POST", BaseUrl + "/jobs/[^/]+/cancel", _ => new(200, "{\"kind\":\"bigquery#jobCancelResponse\",\"job\":{\"status\":{\"state\":\"DONE\"}}}"));
            var bgRunner = new BigQueryMultiRunner(bgSvc);
            var bgBudget = bgSvc.Results.BeginQuery(Guid.NewGuid().ToString());
            using var bgEvents = new QueryEventSink(null);
            var bgMessages = new QueryMessages(bgEvents.Message);
            var bgCtx = MakeContext("bq-r12-bg", bgConnId, "transaction", "SELECT 1;", bgBudget, bgMessages, bgEvents) with
            {
                IsUserCancelled = () => true,
                IsTimedOut = () => false
            };
            var bgRes = await bgRunner.ExecutePhase1Async(bgCtx, bgCts.Token);
            check(bgRes.Result.Outcome.Status == "cancelled" && bgAborts.Any(b => b.Contains("sess-r12-begin-abort", StringComparison.Ordinal)),
                $"BEGIN TRANSACTION cancelled mid-WaitDoneAsync captures sessionId and aborts ephemeral session ({bgRes.Result.Outcome.Status}, aborts={bgAborts.Count})");
        }

        // Round 13 Low hardening checks:
        // 1. BigQueryMultiRunner.PreflightAsync + ExecutePhase1Async in crossEngineReadOnly mode delegates to CrossEngineRunner dry-run and runs sessionless.
        {
            var ceBq = new BigQuerySessionChecks.Bq();
            ceBq.Statements["SELECT 1 AS n"] = "SELECT";
            var ceFake = ceBq.Fake();
            using var ceSvc = NewService(ceFake);
            var ceConnId = await ConnectGoogleAsync(ceSvc, key, location: null, dataset: null);
            var ceRunner = new BigQueryMultiRunner(ceSvc);
            var ceBudget = ceSvc.Results.BeginQuery(Guid.NewGuid().ToString());
            using var ceEvents = new QueryEventSink(null);
            var ceMessages = new QueryMessages(ceEvents.Message);
            var ceCtx = MakeContext("bq-r13-ce", ceConnId, "crossEngineReadOnly", "SELECT 1 AS n", ceBudget, ceMessages, ceEvents, preflightDryRun: true);
            var cePre = await ceRunner.PreflightAsync([ceCtx], CancellationToken.None);
            var ceRun = await ceRunner.ExecutePhase1Async(ceCtx, CancellationToken.None);
            check(cePre[0].Passed && ceRun.Result.Outcome.Status == "succeeded" && ceRun.Phase2 is null && ceBq.Aborts.Count == 0,
                $"BigQueryMultiRunner crossEngineReadOnly preflight+Phase1 runs sessionless ({cePre[0].Passed}/{ceRun.Result.Outcome.Status})");

            // Defense-in-depth static check without PreflightAsync preserves offset Line.
            var badStaticCtx = MakeContext("bq-r13-line", ceConnId, "transaction", "\nDROP TABLE ds.perm;", ceBudget, ceMessages, ceEvents, startLine: 5);
            var badStaticRes = await ceRunner.ExecutePhase1Async(badStaticCtx, CancellationToken.None);
            check(badStaticRes.Result.Outcome.Status == "failed" && badStaticRes.Result.Outcome.Error?.Line == 6,
                $"Defense-in-depth static check preserves offset Line ({badStaticRes.Result.Outcome.Error?.Code} line={badStaticRes.Result.Outcome.Error?.Line})");
        }

        // 2. Shutdown IsAbandoned()==true skips BigQuery HTTP calls in BigQueryPhase2Handle.RollbackAsync while marking RolledBackPreview.
        {
            var abBq = new BigQuerySessionChecks.Bq();
            abBq.Statements["BEGIN TRANSACTION;"] = "BEGIN_TRANSACTION";
            abBq.Statements["SELECT 1 AS a"] = "SELECT";
            var abFake = abBq.Fake();
            using var abSvc = NewService(abFake);
            var abConnId = await ConnectGoogleAsync(abSvc, key, location: "US", dataset: "sales");
            var abRunner = new BigQueryMultiRunner(abSvc);
            var abBudget = abSvc.Results.BeginQuery(Guid.NewGuid().ToString());
            using var abEvents = new QueryEventSink(null);
            var abMessages = new QueryMessages(abEvents.Message);
            var abandoned = false;
            var abCtx = MakeContext("bq-r13-ab", abConnId, "transaction", "SELECT 1 AS a", abBudget, abMessages, abEvents) with
            {
                IsAbandoned = () => abandoned
            };
            await abRunner.PreflightAsync([abCtx], CancellationToken.None);
            var abPhase1 = await abRunner.ExecutePhase1Async(abCtx, CancellationToken.None);
            abandoned = true;
            var abortsBefore = abBq.Aborts.Count;
            await using (var h = abPhase1.Phase2!) { await h.RollbackAsync(CancellationToken.None); }
            check(abBq.Aborts.Count == abortsBefore && abPhase1.Result.ResultSets.All(s => s.RolledBackPreview),
                $"IsAbandoned()==true skips BigQuery ABORT_SESSION HTTP call while marking RolledBackPreview (aborts={abBq.Aborts.Count - abortsBefore})");
        }
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
