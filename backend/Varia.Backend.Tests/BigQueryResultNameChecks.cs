using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Web;
using Varia.Backend.BigQuery;

namespace Varia.Backend.Tests;

/// <summary>
/// BigQuery / GoogleSQL #Name="…" named result sets offline (docs/named-result-sets-scope.md, docs/bigquery.md):
/// marker scanning (--, /* */, # #Name, bare #Name=, malformed/refused/bounds), GoogleSQL statement splitting and
/// control-flow safety, stackFrames and safe positional script binding, windowed/load/rerun/re-attach execution against a
/// scripted fake BigQuery, Messages notes cap, and zero SQL/name logging.
/// </summary>
internal static class BigQueryResultNameChecks
{
    static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    const string Base = "http://localhost:9050/bigquery/v2/projects/varia-emulator";

    public static async Task RunAsync(Action<bool, string> check)
    {
        Markers(check);
        StatementsAndPlanning(check);
        BoundsAndNotes(check);
        NoLoggingCheck(check);
        await ExecutionAsync(check);
    }

    static string Show(ResultMarker marker) => marker.Line + ":" + (marker.Name is null ? "malformed" : "\"" + marker.Name + "\"");

    static void Markers(Action<bool, string> check)
    {
        static string Found(string sql, int startLine = 1) =>
            string.Join(" ", GoogleSqlScanner.ScanMarkers(sql, startLine).Select(Show));

        check(Found("-- #Name=\"Open orders\"\nSELECT 1;") == "1:\"Open orders\"", "GoogleSQL scanner parses -- #Name");
        check(Found("/* #Name=\"Sample Query\" */\nSELECT 1;") == "1:\"Sample Query\"", "GoogleSQL scanner parses /* #Name */");
        check(Found("SELECT 0;\n/*\n  #Name=\"Own line\"\n*/\nSELECT 1;") == "3:\"Own line\"", "multiline block comment reports the marker's own line");
        check(Found("# #Name=\"Hash spaced\"\nSELECT 1;") == "1:\"Hash spaced\"", "GoogleSQL scanner parses # #Name");
        check(Found("##Name=\"Double hash\"\nSELECT 1;") == "1:\"Double hash\"", "GoogleSQL scanner parses ##Name");
        check(Found("#Name=\"Bare hash\"\nSELECT 1;") == "1:\"Bare hash\"", "GoogleSQL scanner parses bare #Name=");
        check(Found("#name = \"Says \"\"hello\"\"\"\nSELECT 1;") == "1:\"Says \"hello\"\"", "bare #name = supports case-insensitivity, whitespace around = and doubled quotes");
        check(Found("#Name=\"Tag #1\"\nSELECT 1;") == "1:\"Tag #1\"", "bare #Name= handles '#' inside the quoted name");
        check(Found("-- #Name=\"   Open\t \torders   \"\nSELECT 1;") == "1:\"Open orders\"", "whitespace and tabs collapse to single spaces");

        // Prose comments, #Names, #standardSQL, strings and backtick identifiers must never fire.
        var nonMarkers = string.Join("\n",
            "#Names=\"not a marker\"",
            "#name_list = \"not a marker\"",
            "#Name of the report",
            "#Name: customer orders",
            "# Name=\"space before Name\"",
            "#standardSQL",
            "-- @Name=\"param\"",
            "-- see #Name=\"not alone\"",
            "# see #Name=\"not alone\"",
            "/* note: #Name=\"not alone\" */",
            "/* -- #Name=\"inside block\" */",
            "/* # #Name=\"inside block\" */",
            "SELECT '-- #Name=\"s1\"', \"#Name=\\\"s2\\\"\", '''\n#Name=\"s3\"\n''', \"\"\"\n#Name=\"s4\"\n\"\"\", r'''#Name=\"s5\"''', b\"#Name=\\\"s6\\\"\", rb'#Name=\"s7\"', br\"#Name=\\\"s8\\\"\", 1 AS `#Name=\"s9\"`;");
        check(Found(nonMarkers) == "", "prose # comments, #Names, #standardSQL, strings and backtick identifiers are not markers: " + Found(nonMarkers));

        // Malformed markers across --, /* */, # #Name and bare #Name=
        var max128 = new string('x', ResultNames.MaxChars);
        var over129 = new string('x', ResultNames.MaxChars + 1);
        check(Found($"#Name=\"{max128}\"\nSELECT 1;") == $"1:\"{max128}\"", "128-character name is accepted");
        check(Found($"#Name=\"{over129}\"\nSELECT 1;") == "1:malformed", "129-character name is malformed");
        check(Found("#Name=\"\"\nSELECT 1;") == "1:malformed", "empty bare #Name is malformed");
        check(Found("#Name=\"   \"\nSELECT 1;") == "1:malformed", "whitespace-only bare #Name is malformed");
        check(Found("#Name=\"unclosed\nSELECT 1;") == "1:malformed", "unclosed bare #Name is malformed");
        check(Found("#Name=\"a\" extra\nSELECT 1;") == "1:malformed", "trailing text after bare #Name is malformed");
        check(Found("#Name='single'\nSELECT 1;") == "1:malformed", "single-quoted bare #Name is malformed");
        check(Found("# #Name=\"unclosed\nSELECT 1;") == "1:malformed", "unclosed # #Name is malformed");
        check(Found("-- #Name=\"bad\u202ebidi\"\nSELECT 1;") == "1:malformed", "bidi override character makes marker malformed");
        check(Found("-- #Name=\"bad\u0085c1\"\nSELECT 1;") == "1:malformed", "C1 control character makes marker malformed");
        check(Found("-- #Name=\"bad\ufeffbom\"\nSELECT 1;") == "1:malformed", "BOM makes marker malformed");
        check(Found("/* #Name=\"line\nbreak\" */\nSELECT 1;") == "1:malformed", "line break in block comment name makes marker malformed");

        // CRLF, lone CR and selection startLine
        check(Found("SELECT 0;\r\n/*\r\n #Name=\"Crlf\"\r\n*/\r\nSELECT 1;", startLine: 10) == "12:\"Crlf\"", "CRLF line breaks and startLine offset work");
        check(Found("SELECT 0;\r/*\r #Name=\"Cr\"\r*/\rSELECT 1;", startLine: 5) == "7:\"Cr\"", "lone CR line breaks and startLine offset work");
    }

    static void StatementsAndPlanning(Action<bool, string> check)
    {
        // Single queries: SELECT, WITH, FROM (pipe syntax), parenthesized SELECT
        foreach (var (label, sql) in new[]
        {
            ("SELECT", "#Name=\"Orders\"\nSELECT 1 AS a;"),
            ("WITH", "-- #Name=\"Orders\"\nWITH cte AS (SELECT 1 AS a) SELECT * FROM cte;"),
            ("FROM pipe", "/* #Name=\"Orders\" */\nFROM orders |> WHERE total > 10 |> SELECT id;"),
            ("parenthesized", "# #Name=\"Orders\"\n((SELECT 1 AS a) UNION ALL (SELECT 2 AS a));")
        })
        {
            var plan = BigQueryResultNamePlan.Build(sql);
            check(plan is { SingleQuery: true, Slots: [{ Name: "Orders", QueryIndex: 0, StartLine: 2, StartColumn: 1, BlockerBefore: null }], Notes.Count: 0 },
                $"single {label} query plans cleanly");
        }

        // Multiple markers before one query: last marker wins with note for earlier ones.
        var multi = BigQueryResultNamePlan.Build("-- #Name=\"First\"\n#Name=\"Second\"\n/* #Name=\"Winner\" */\nSELECT 1 AS a;");
        check(multi is { SingleQuery: true, Slots: [{ Name: "Winner", MarkerLine: 3 }], Notes.Count: 2 }
            && multi.Notes[0].Contains("\"First\" (line 1) is unused: a later name takes its statement's result set.", StringComparison.Ordinal)
            && multi.Notes[1].Contains("\"Second\" (line 2) is unused: a later name takes its statement's result set.", StringComparison.Ordinal),
            "multiple markers before one query: last marker wins and earlier ones are noted");

        // Malformed marker after valid marker does not steal or emit notes.
        var validThenBad = BigQueryResultNamePlan.Build("-- #Name=\"Good\"\n#Name=\"unclosed\nSELECT 1;");
        check(validThenBad is { SingleQuery: true, Slots: [{ Name: "Good" }], Notes.Count: 0 },
            "malformed marker does not override a valid marker or emit a note");
        check(BigQueryResultNamePlan.Build("#Name=\"unclosed\nSELECT 1;") is null,
            "query with only a malformed marker builds no plan and emits no notes");

        // Non-result statements and BEGIN TRANSACTION do not block later SELECTs.
        var dmlScript = """
            BEGIN TRANSACTION;
            DECLARE cutoff INT64 DEFAULT 10;
            -- #Name="Upd"
            UPDATE orders SET x = 1 WHERE id > cutoff;
            -- #Name="Kept"
            SELECT id FROM orders FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP();
            COMMIT TRANSACTION;
            """;
        var dmlPlan = BigQueryResultNamePlan.Build(dmlScript);
        check(dmlPlan is { Slots: [{ Name: "Kept", QueryIndex: 0, StartLine: 6, BlockerBefore: null }], Notes: [var updNote] }
            && updNote.Contains("\"Upd\" (line 3) is unused: its statement returns no result set.", StringComparison.Ordinal),
            "BEGIN TRANSACTION, DECLARE, UPDATE and FOR SYSTEM_TIME AS OF plan accurately");

        // CREATE PROCEDURE ... BEGIN ... END; keeps its BEGIN...END inside CREATE.
        var procScript = """
            CREATE OR REPLACE PROCEDURE ds.p()
            BEGIN
              SELECT CASE WHEN 1 = 1 THEN 'a' ELSE 'b' END;
            END;
            #Name="AfterProc"
            SELECT 1 AS ok;
            """;
        var procPlan = BigQueryResultNamePlan.Build(procScript);
        check(procPlan is { Slots: [{ Name: "AfterProc", QueryIndex: 0, StartLine: 6, BlockerBefore: null }], Notes.Count: 0 },
            "CREATE PROCEDURE with BEGIN...END and CASE expression does not leak or block later SELECT");

        // Control-flow statements: marker before OR inside each control-flow kind is refused with a clear note.
        foreach (var (kind, sql) in new[]
        {
            ("IF", "-- #Name=\"Before\"\nIF TRUE THEN\n  -- #Name=\"Inside\"\n  SELECT 1;\nEND IF;"),
            ("LOOP", "-- #Name=\"Before\"\nmy_loop: LOOP\n  -- #Name=\"Inside\"\n  SELECT 1;\n  LEAVE my_loop;\nEND LOOP my_loop;"),
            ("WHILE", "-- #Name=\"Before\"\nWHILE FALSE DO\n  -- #Name=\"Inside\"\n  SELECT 1;\nEND WHILE;"),
            ("REPEAT", "-- #Name=\"Before\"\nREPEAT\n  -- #Name=\"Inside\"\n  SELECT 1;\nUNTIL TRUE END REPEAT;"),
            ("FOR", "-- #Name=\"Before\"\nFOR r IN (SELECT 1 AS x) DO\n  -- #Name=\"Inside\"\n  SELECT r.x;\nEND FOR;"),
            ("BEGIN … END", "-- #Name=\"Before\"\nBEGIN\n  SELECT CASE WHEN 1=1 THEN 1 ELSE 2 END;\n  -- #Name=\"Inside\"\n  SELECT 1;\nEND;"),
            ("CASE", "-- #Name=\"Before\"\nCASE 1 WHEN 1 THEN\n  -- #Name=\"Inside\"\n  SELECT 1;\nEND CASE;")
        })
        {
            var cfPlan = BigQueryResultNamePlan.Build(sql);
            check(cfPlan is { Slots.Count: 0, Notes.Count: 2 }
                && cfPlan.Notes[0].Contains("\"Before\"", StringComparison.Ordinal) && cfPlan.Notes[0].Contains(kind, StringComparison.Ordinal)
                && cfPlan.Notes[1].Contains("\"Inside\"", StringComparison.Ordinal) && cfPlan.Notes[1].Contains("where how often a statement runs is not known", StringComparison.Ordinal),
                $"control-flow {kind} refuses markers before and inside it: " + string.Join(" / ", cfPlan?.Notes ?? []));
        }

        // CALL and EXECUTE IMMEDIATE refuse markers before them.
        var callPlan = BigQueryResultNamePlan.Build("-- #Name=\"Proc\"\nCALL ds.my_proc();\n-- #Name=\"Dyn\"\nEXECUTE IMMEDIATE 'SELECT 1';");
        check(callPlan is { Slots.Count: 0, Notes.Count: 2 }
            && callPlan.Notes[0].Contains("a CALL statement on line 2", StringComparison.Ordinal)
            && callPlan.Notes[1].Contains("an EXECUTE IMMEDIATE statement on line 4", StringComparison.Ordinal),
            "CALL and EXECUTE IMMEDIATE refuse markers with clear notes");

        // Marker inside a SELECT (before UNION ALL) and trailing marker after last statement.
        var insideAndTrailing = BigQueryResultNamePlan.Build("SELECT 1 AS a\n-- #Name=\"UnionBranch\"\nUNION ALL\nSELECT 2 AS a;\n-- #Name=\"Trailing\"");
        check(insideAndTrailing is { Slots.Count: 0, Notes.Count: 2 }
            && insideAndTrailing.Notes[0].Contains("inside a SELECT statement on line 1, not before one", StringComparison.Ordinal)
            && insideAndTrailing.Notes[1].Contains("\"Trailing\" (line 5) is unused: no statement follows it in its script.", StringComparison.Ordinal),
            "marker inside SELECT and trailing marker are refused with notes");

        // Marker after semicolon on the same line binds to the next statement.
        var afterSemi = BigQueryResultNamePlan.Build("SELECT 1 AS a; -- #Name=\"Second\"\nSELECT 2 AS b;");
        check(afterSemi is { Slots: [{ Name: "Second", QueryIndex: 1, StartLine: 2, StartColumn: 1 }], Notes.Count: 0 },
            "marker after semicolon binds to the next statement");

        // Two SELECTs on the same line: UniqueSlotByLine must NOT include that line, while SlotByPosition distinguishes them.
        var sameLine = BigQueryResultNamePlan.Build("SELECT 1 AS a; /* #Name=\"Second\" */ SELECT 2 AS b;");
        check(sameLine is { Slots: [{ Name: "Second", StartLine: 1, StartColumn: 37 }] }
            && !sameLine.UniqueSlotByLine.ContainsKey(1)
            && sameLine.SlotByPosition.ContainsKey((1, 37)),
            "same-line statements match only by exact (line, column), never by line alone");

        // Control-flow / dynamic statement sharing or spanning into the line of a named SELECT must NOT populate UniqueSlotByLine.
        var inlineIf = BigQueryResultNamePlan.Build("IF TRUE THEN SELECT 1; END IF; /* #Name=\"Second\" */ SELECT 2;");
        check(inlineIf is { Slots: [{ Name: "Second", StartLine: 1, StartColumn: 53 }] }
            && !inlineIf.UniqueSlotByLine.ContainsKey(1)
            && inlineIf.SlotByPosition.ContainsKey((1, 53)),
            "single-line IF sharing a line with a named SELECT disables UniqueSlotByLine for that line");
        var multilineIf = BigQueryResultNamePlan.Build("IF TRUE THEN\n  SELECT 1; END IF; /* #Name=\"Second\" */ SELECT 2;");
        check(multilineIf is { Slots: [{ Name: "Second", StartLine: 2, StartColumn: 42 }] }
            && !multilineIf.UniqueSlotByLine.ContainsKey(2)
            && multilineIf.SlotByPosition.ContainsKey((2, 42)),
            "multi-line IF ending on the same line as a named SELECT disables UniqueSlotByLine for that line");

        // CASE expression followed by non-reserved aliases (loop, while, repeat) must stay balanced.
        var caseAliases = BigQueryResultNamePlan.Build("#Name=\"Orders\"\nSELECT CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END loop, CASE WHEN status = 'HOLD' THEN 1 ELSE 0 END while, CASE WHEN status = 'NEW' THEN 1 ELSE 0 END repeat FROM orders;");
        check(caseAliases is { SingleQuery: true, Slots: [{ Name: "Orders", StartLine: 2, StartColumn: 1 }], Notes.Count: 0 },
            "CASE expression followed by non-reserved aliases (loop, while, repeat) does not mark the script unbalanced");

        // CREATE VIEW/TABLE named 'procedure' referencing 'begin' must not falsely trigger CREATE PROCEDURE BEGIN...END.
        var viewProc = BigQueryResultNamePlan.Build("CREATE VIEW procedure AS SELECT begin FROM t;\n#Name=\"AfterView\"\nSELECT 1 AS ok;");
        check(viewProc is { Slots: [{ Name: "AfterView", QueryIndex: 0, StartLine: 3, BlockerBefore: null }], Notes.Count: 0 },
            "CREATE VIEW procedure referencing begin does not trigger CREATE PROCEDURE block tracking");
        var tableProc = BigQueryResultNamePlan.Build("CREATE TABLE procedure (begin INT64);\n#Name=\"AfterTable\"\nSELECT 1 AS ok;");
        check(tableProc is { Slots: [{ Name: "AfterTable", QueryIndex: 0, StartLine: 3, BlockerBefore: null }], Notes.Count: 0 },
            "CREATE TABLE procedure with column begin does not trigger CREATE PROCEDURE block tracking");

        // EXPRESSION child without stackFrames must not consume or shift positional matching.
        var exprPlan = BigQueryResultNamePlan.Build("#Name=\"First\"\nSELECT 1 AS a;")!;
        var exprBinder = new BigQueryResultNameBinder(exprPlan);
        var exprName = exprBinder.TakeChild(new("expr_1", null, 1, true, "SELECT", null, null, null, ScriptEvaluationKind: "EXPRESSION"), incompleteListing: false);
        var realName = exprBinder.TakeChild(new("stmt_1", null, 2, true, "SELECT", null, null, null), incompleteListing: false);
        check(exprName is null && realName == "First",
            "EXPRESSION child without stackFrames returns null and does not shift positional matching");
    }

    static void BoundsAndNotes(Action<bool, string> check)
    {
        // Oversized script (> MaxParseChars): not split, every valid marker noted.
        var filler = string.Concat(Enumerable.Repeat("SELECT 1 AS a;\n", ResultNames.MaxParseChars / 15 + 2));
        var oversized = "#Name=\"TooBig1\"\n" + filler + "#Name=\"TooBig2\"\nSELECT 2 AS b;";
        var oversizedPlan = BigQueryResultNamePlan.Build(oversized);
        check(oversized.Length > ResultNames.MaxParseChars && oversizedPlan is { Slots.Count: 0, Notes: [var n1, var n2] }
            && n1.Contains("\"TooBig1\" (line 1) was not applied: its script is longer than 262,144 characters.", StringComparison.Ordinal)
            && n2.Contains("\"TooBig2\"", StringComparison.Ordinal),
            "oversized script refuses naming and notes every valid marker");

        // Unbalanced script refuses naming cleanly.
        var unbalanced = BigQueryResultNamePlan.Build("#Name=\"Broken\"\nBEGIN\nSELECT 1;");
        check(unbalanced is { Slots.Count: 0, Notes: [var broken] } && broken.Contains("could not be parsed cleanly", StringComparison.Ordinal),
            "unbalanced script refuses naming with a note");

        // Notes cap (MaxNotes = 20): 25 unused markers -> 20 notes + summary line.
        var manyUnused = string.Join("\n", Enumerable.Range(1, 25).Select(k => $"-- #Name=\"U{k}\"\nSET x = {k};"));
        var manyPlan = BigQueryResultNamePlan.Build(manyUnused)!;
        var emitted = new List<string>();
        var notes = new ResultNameNotes(emitted.Add);
        foreach (var note in manyPlan.Notes) notes.Add(note);
        notes.Finish();
        check(emitted.Count == ResultNames.MaxNotes + 1 && emitted[^1] == "… and 5 more notes about result names.",
            "Messages notes cap at MaxNotes (20) with a count of the rest");
    }

    static void NoLoggingCheck(Action<bool, string> check)
    {
        var root = GoldenText.Repository();
        foreach (var relative in new[] { "backend/Varia.Backend/BigQuery/BigQueryResultNames.cs", "backend/Varia.Backend/BigQuery/GoogleSqlScanner.cs" })
        {
            var source = File.ReadAllText(Path.Combine(root, relative));
            check(!source.Contains("Console.", StringComparison.Ordinal) && !source.Contains("Debug.Write", StringComparison.Ordinal)
                && !source.Contains("Trace.Write", StringComparison.Ordinal),
                relative + " never logs SQL text or result names");
        }
        // Notes never echo SQL text from statements.
        var secretSql = "-- #Name=\"Label\"\nUPDATE secret_payroll_table SET salary = 999999 WHERE ssn = '123-45-6789';";
        var plan = BigQueryResultNamePlan.Build(secretSql)!;
        check(plan.Notes.All(note => !note.Contains("secret_payroll_table", StringComparison.Ordinal) && !note.Contains("123-45-6789", StringComparison.Ordinal)),
            "Messages notes never quote SQL text");
    }

    sealed class ScriptFake
    {
        public sealed record ChildSpec(string Id, string StatementType, JsonObject? ScriptStatistics = null, long? DmlAffected = null, JsonNode? Error = null,
            List<JsonNode>? Rows = null, JsonNode? Schema = null);

        public string StatementType = "SELECT";
        public bool DenyChildrenList;
        public List<ChildSpec> Children = [];
        public List<JsonNode> DefaultRows = [Row(1, "alpha")];
        public JsonNode DefaultSchema = Schema("id", "label");
        public JsonObject? Destination;
        public readonly ConcurrentQueue<string> SubmittedSql = new();
        public readonly Dictionary<string, string?> StoredJobSql = new(StringComparer.Ordinal);
        public string? PresetJobId;
        public string? PresetJobSql;

        public static JsonNode Schema(params string[] cols) => new JsonObject
        {
            ["fields"] = new JsonArray([.. cols.Select(c => (JsonNode)new JsonObject { ["name"] = c, ["type"] = "STRING", ["mode"] = "NULLABLE" })])
        };

        public static JsonNode Row(params object[] values) => new JsonObject
        {
            ["f"] = new JsonArray([.. values.Select(v => (JsonNode)new JsonObject { ["v"] = Convert.ToString(v, CultureInfo.InvariantCulture) })])
        };

        public static JsonObject Frame(int startLine, int startColumn, string? procedureId = null, string evaluationKind = "STATEMENT", int extraFrames = 0)
        {
            var frames = new JsonArray();
            for (var i = 0; i < extraFrames; i++)
                frames.Add(new JsonObject { ["startLine"] = 1, ["startColumn"] = 1, ["procedureId"] = procedureId ?? "ds.proc" });
            var top = new JsonObject { ["startLine"] = startLine, ["startColumn"] = startColumn };
            if (procedureId is not null) top["procedureId"] = procedureId;
            frames.Add(top);
            return new JsonObject { ["evaluationKind"] = evaluationKind, ["stackFrames"] = frames };
        }

        public BigQueryFake Build()
        {
            var fake = new BigQueryFake();
            fake.On("GET", Base + "/datasets/varia_fixture", new BigQueryFake.Reply(200, "{\"datasetReference\":{\"projectId\":\"varia-emulator\",\"datasetId\":\"varia_fixture\"}}"));
            fake.On("POST", Base + "/jobs", request =>
            {
                var body = JsonNode.Parse(request.Body)!;
                var id = body["jobReference"]!["jobId"]!.GetValue<string>();
                var sql = body["configuration"]?["query"]?["query"]?.GetValue<string>() ?? "";
                SubmittedSql.Enqueue(sql);
                StoredJobSql[id] = sql;
                return new(200, JobJson(id, "RUNNING", StatementType, sql, error: null).ToJsonString());
            });
            fake.On("GET", Base + "/jobs", request =>
            {
                var q = HttpUtility.ParseQueryString(request.Uri.Query);
                if (q["parentJobId"] is { } parent)
                {
                    if (DenyChildrenList)
                        return new(403, "{\"error\":{\"code\":403,\"message\":\"Access Denied: bigquery.jobs.list\",\"errors\":[{\"reason\":\"accessDenied\",\"message\":\"Access Denied\"}]}}");
                    var arr = new JsonArray();
                    for (var i = 0; i < Children.Count; i++)
                    {
                        var c = Children[i];
                        var stats = new JsonObject
                        {
                            ["creationTime"] = (i + 1).ToString(CultureInfo.InvariantCulture),
                            ["parentJobId"] = parent,
                            ["query"] = new JsonObject { ["statementType"] = c.StatementType }
                        };
                        if (c.DmlAffected is { } aff) stats["query"]!["numDmlAffectedRows"] = aff.ToString(CultureInfo.InvariantCulture);
                        if (c.ScriptStatistics is not null) stats["scriptStatistics"] = c.ScriptStatistics.DeepClone();
                        var status = new JsonObject { ["state"] = "DONE" };
                        if (c.Error is not null) { status["errorResult"] = c.Error.DeepClone(); status["errors"] = new JsonArray(c.Error.DeepClone()); }
                        arr.Add(new JsonObject
                        {
                            ["jobReference"] = new JsonObject { ["projectId"] = "varia-emulator", ["jobId"] = c.Id },
                            ["state"] = "DONE",
                            ["status"] = status,
                            ["statistics"] = stats
                        });
                    }
                    return new(200, new JsonObject { ["kind"] = "bigquery#jobList", ["jobs"] = arr }.ToJsonString());
                }
                // OwnJobAsync lists jobs for identity check during query.attach.
                var listed = new JsonArray();
                if (PresetJobId is not null)
                    listed.Add(new JsonObject { ["jobReference"] = new JsonObject { ["projectId"] = "varia-emulator", ["jobId"] = PresetJobId }, ["state"] = "DONE" });
                return new(200, new JsonObject { ["kind"] = "bigquery#jobList", ["jobs"] = listed }.ToJsonString());
            });
            fake.On("GET", Base + "/jobs/[^/]+", request =>
            {
                var id = request.Url[(request.Url.LastIndexOf('/') + 1)..];
                if (Children.FirstOrDefault(c => c.Id == id) is { } child)
                    return new(200, JobJson(id, "DONE", child.StatementType, "SELECT 1", child.Error).ToJsonString());
                var sql = id == PresetJobId ? PresetJobSql : StoredJobSql.GetValueOrDefault(id);
                var failed = Children.FirstOrDefault(c => c.Error is not null)?.Error;
                return new(200, JobJson(id, "DONE", StatementType, sql, failed, numChildJobs: Children.Count > 0 ? Children.Count : null).ToJsonString());
            });
            fake.On("GET", Base + "/queries/[^/]+", request =>
            {
                var id = request.Url[(request.Url.LastIndexOf('/') + 1)..];
                var q = HttpUtility.ParseQueryString(request.Uri.Query);
                var max = int.Parse(q["maxResults"] ?? "500", CultureInfo.InvariantCulture);
                var token = q["pageToken"];
                var offset = token is not null ? int.Parse(token[5..], CultureInfo.InvariantCulture) : 0;
                if (Children.FirstOrDefault(c => c.Id == id) is { } child)
                    return PageReply(child.Schema ?? DefaultSchema, child.Rows ?? DefaultRows, offset, max);
                if (Children.Any(c => c.Error is not null))
                    return new(400, "{\"error\":{\"code\":400,\"message\":\"Child statement failed\"}}");
                return PageReply(DefaultSchema, DefaultRows, offset, max);
            });
            fake.On("GET", Base + "/datasets/[^/]+/tables/[^/]+/data", request =>
            {
                var q = HttpUtility.ParseQueryString(request.Uri.Query);
                var start = int.Parse(q["startIndex"] ?? "0", CultureInfo.InvariantCulture);
                var max = int.Parse(q["maxResults"] ?? "500", CultureInfo.InvariantCulture);
                return PageReply(DefaultSchema, DefaultRows, start, max, tableData: true);
            });
            return fake;
        }

        static BigQueryFake.Reply PageReply(JsonNode schema, List<JsonNode> rows, int offset, int max, bool tableData = false)
        {
            var count = Math.Max(0, Math.Min(max, rows.Count - offset));
            var arr = new JsonArray([.. rows.Skip(offset).Take(count).Select(r => r.DeepClone())]);
            var obj = new JsonObject
            {
                ["kind"] = tableData ? "bigquery#tableDataList" : "bigquery#getQueryResultsResponse",
                ["totalRows"] = rows.Count.ToString(CultureInfo.InvariantCulture),
                ["rows"] = arr
            };
            if (!tableData) { obj["jobComplete"] = true; obj["schema"] = schema.DeepClone(); }
            if (offset + count < rows.Count) obj["pageToken"] = "page-" + (offset + count).ToString(CultureInfo.InvariantCulture);
            return new(200, obj.ToJsonString());
        }

        JsonObject JobJson(string id, string state, string statementType, string? sql, JsonNode? error, int? numChildJobs = null)
        {
            var status = new JsonObject { ["state"] = state };
            if (error is not null) { status["errorResult"] = error.DeepClone(); status["errors"] = new JsonArray(error.DeepClone()); }
            var queryConfig = new JsonObject { ["useLegacySql"] = false };
            if (sql is not null) queryConfig["query"] = sql;
            if (Destination is not null) queryConfig["destinationTable"] = Destination.DeepClone();
            var stats = new JsonObject
            {
                ["creationTime"] = "1700000000000",
                ["query"] = new JsonObject { ["statementType"] = statementType, ["totalBytesProcessed"] = "0", ["totalBytesBilled"] = "0" }
            };
            if (numChildJobs is { } n) stats["numChildJobs"] = n.ToString(CultureInfo.InvariantCulture);
            return new JsonObject
            {
                ["kind"] = "bigquery#job",
                ["jobReference"] = new JsonObject { ["projectId"] = "varia-emulator", ["jobId"] = id },
                ["status"] = status,
                ["configuration"] = new JsonObject { ["jobType"] = "QUERY", ["query"] = queryConfig },
                ["statistics"] = stats
            };
        }
    }

    static async Task<(SqlService Service, ConnectionInfo Info)> ConnectAsync(BigQueryFake fake)
    {
        var env = new BigQueryEnvironment(new Uri("http://localhost:9050/"), fake.Factory, new SubjectTokens([]));
        var service = new SqlService(store: CheckStores.Unprobed(), bigQuery: env);
        service.BigQuery.RetryDelay = TimeSpan.FromMilliseconds(1);
        service.BigQuery.ChildPollMs = 50;
        var options = new JsonObject
        {
            ["provider"] = "bigquery", ["project"] = "varia-emulator", ["authentication"] = "gcloud", ["dataset"] = "varia_fixture",
            ["credential"] = new JsonObject { ["source"] = "anonymous" }
        };
        using var doc = JsonDocument.Parse(options.ToJsonString());
        var info = (ConnectionInfo)await service.DispatchAsync("connections.connect", doc.RootElement.Clone(), Wire);
        return (service, info);
    }

    static async Task<QueryResult> ExecuteAsync(SqlService service, ConnectionInfo info, string sql, string? residence = null, int startLine = 1, int maxResultSets = 100, bool discardResults = false) =>
        (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
            new QueryArgs(info.Id, Guid.NewGuid().ToString(), null, sql, Guid.NewGuid().ToString(), 0, 30, StartLine: startLine, MaxResultSets: maxResultSets, Residence: residence, DiscardResults: discardResults), Wire), Wire);

    static async Task ExecutionAsync(Action<bool, string> check)
    {
        // 1. Single query in memory: SQL sent to BigQuery is untouched, descriptor carries Name, zero name notes.
        {
            var script = new ScriptFake();
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var sql = "#Name=\"Open orders\"\nSELECT 1 AS id, 'alpha' AS label;";
                var res = await ExecuteAsync(service, info, sql);
                check(res.Status == "completed" && res.ResultSets is [{ Name: "Open orders", Residence: "memory" }]
                    && script.SubmittedSql.TryDequeue(out var sent) && sent == sql
                    && !res.Messages.Any(m => m.Text.Contains("Result name", StringComparison.Ordinal)),
                    "single BigQuery query binds #Name in memory without altering SQL");
            }
        }

        // 2. Windowed BigQuery result: keeps Name through windowed open, Load into memory, and Re-run!
        {
            var script = new ScriptFake
            {
                Destination = new JsonObject { ["projectId"] = "varia-emulator", ["datasetId"] = "_anon_fake", ["tableId"] = "t1" },
                DefaultRows = [.. Enumerable.Range(0, 600).Select(i => ScriptFake.Row(i, "r" + i))]
            };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var sql = "-- #Name=\"Windowed orders\"\nSELECT id, label FROM orders;";
                var res = await ExecuteAsync(service, info, sql, residence: "windowed");
                check(res.Status == "completed" && res.ResultSets is [{ Name: "Windowed orders", Residence: "remote" } win],
                    "windowed BigQuery result carries #Name on its ResultDescriptor");
                var id = res.ResultSets[0].ResultId;
                const int gen = 1;
                // Re-run preserves Name on the new ResultDescriptor
                var rerun = (QueryResult)await service.DispatchAsync("results.remoteQuery",
                    JsonSerializer.SerializeToElement(new RemoteQueryArgs(Guid.NewGuid().ToString(), id, gen, "rerun"), Wire), Wire);
                check(rerun.Status == "completed" && rerun.ResultSets is [{ Name: "Windowed orders" }],
                    "re-run of a windowed BigQuery result preserves #Name");
                // Load into memory promotes in place and preserves Name
                var loaded = (QueryResult)await service.DispatchAsync("results.remoteQuery",
                    JsonSerializer.SerializeToElement(new RemoteQueryArgs(Guid.NewGuid().ToString(), id, gen, "load"), Wire), Wire);
                check(loaded.Status == "completed" && loaded.ResultSets is [{ Name: "Windowed orders", Residence: "memory" }],
                    "Load into memory on a windowed BigQuery result preserves #Name");
            }
        }

        // 3. Multi-statement script WITH statistics.scriptStatistics.stackFrames:
        //    DECLARE + named SELECT + UPDATE + unnamed SELECT + IF (unnamed) + CALL (2 frames, unnamed) + named SELECT after blockers!
        {
            var sql = string.Join("\n",
                "DECLARE min_id INT64 DEFAULT 1;",
                "-- #Name=\"Orders\"",
                "SELECT 1 AS id;",
                "UPDATE orders SET seen = TRUE WHERE id >= min_id;",
                "SELECT 2 AS id;",
                "IF TRUE THEN",
                "  SELECT 3 AS id;",
                "END IF;",
                "CALL ds.audit();",
                "#Name=\"Summary\"",
                "SELECT 4 AS id;");
            var script = new ScriptFake
            {
                StatementType = "SCRIPT",
                Children =
                [
                    new("c1", "SCRIPT", ScriptFake.Frame(1, 1)),
                    new("c2", "SELECT", ScriptFake.Frame(3, 1)),
                    new("c3", "UPDATE", ScriptFake.Frame(4, 1), DmlAffected: 5),
                    new("c4", "SELECT", ScriptFake.Frame(5, 1)),
                    new("c5", "SELECT", ScriptFake.Frame(7, 3)),
                    new("c6", "SELECT", ScriptFake.Frame(9, 1, procedureId: "ds.audit", extraFrames: 1)),
                    new("c7", "SELECT", ScriptFake.Frame(11, 1))
                ]
            };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var res = await ExecuteAsync(service, info, sql);
                var names = res.ResultSets.Select(s => s.Name).ToArray();
                check(res.Status == "completed" && names.SequenceEqual(["Orders", null, null, null, "Summary"])
                    && !res.Messages.Any(m => m.Text.Contains("Result name", StringComparison.Ordinal)),
                    "script with stackFrames names exact top-level SELECTs and leaves IF/CALL/unnamed sets unnamed: [" + string.Join(", ", names.Select(x => x ?? "null")) + "]");
            }
        }

        // 4. Multi-statement script with repeated execution on same stackFrame line: second execution stays unnamed with note.
        {
            var sql = "#Name=\"Once\"\nSELECT 1 AS id;";
            var script = new ScriptFake
            {
                StatementType = "SCRIPT",
                Children =
                [
                    new("c1", "SELECT", ScriptFake.Frame(2, 1)),
                    new("c2", "SELECT", ScriptFake.Frame(2, 1))
                ]
            };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var res = await ExecuteAsync(service, info, sql);
                check(res.ResultSets.Select(s => s.Name).SequenceEqual(["Once", null])
                    && res.Messages.Any(m => m.Text.Contains("was not applied to a repeated execution", StringComparison.Ordinal)),
                    "repeated execution of a named statement leaves the repeat unnamed and emits a note");
            }
        }

        // 5. Multi-statement script WITHOUT stackFrames (emulator/fake child jobs):
        //    5a) Deterministic script binds positionally.
        {
            var sql = "DECLARE x INT64 DEFAULT 1;\n-- #Name=\"First\"\nSELECT x;\nUPDATE t SET a = 1;\n#Name=\"Second\"\nSELECT 2;";
            var script = new ScriptFake
            {
                StatementType = "SCRIPT",
                Children = [new("c1", "DECLARE"), new("c2", "SELECT"), new("c3", "UPDATE", DmlAffected: 1), new("c4", "SELECT")]
            };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var res = await ExecuteAsync(service, info, sql);
                check(res.Status == "completed" && res.ResultSets.Select(s => s.Name).SequenceEqual(["First", "Second"])
                    && !res.Messages.Any(m => m.Text.Contains("Result name", StringComparison.Ordinal)),
                    "script without stackFrames safely binds deterministic top-level SELECTs positionally");
            }
        }
        //    5b) Script with IF before named SELECT and NO stackFrames refuses to guess and explains why.
        {
            var sql = "IF TRUE THEN\n  SELECT 1;\nEND IF;\n#Name=\"AfterIf\"\nSELECT 2;";
            var script = new ScriptFake
            {
                StatementType = "SCRIPT",
                Children = [new("c1", "SELECT"), new("c2", "SELECT")]
            };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var res = await ExecuteAsync(service, info, sql);
                check(res.Status == "completed" && res.ResultSets.Select(s => s.Name).SequenceEqual([null, null])
                    && res.Messages.Any(m => m.Text.Contains("\"AfterIf\" (line 4) was not applied: an IF statement on line 1 before it", StringComparison.Ordinal)),
                    "script without stackFrames refuses to name SELECT after IF and emits a clear note");
            }
        }

        // 6. Script where jobs.list fails (403): parent rows stay unnamed and Messages says why.
        {
            var sql = "-- #Name=\"First\"\nSELECT 1;\n-- #Name=\"Second\"\nSELECT 2;";
            var script = new ScriptFake { StatementType = "SCRIPT", DenyChildrenList = true };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var res = await ExecuteAsync(service, info, sql);
                check(res.Status == "completed" && res.ResultSets is [{ Name: null }]
                    && res.Messages.Any(m => m.Text.Contains("\"First\" (line 1) was not applied: Varia could not list the script's statements", StringComparison.Ordinal))
                    && res.Messages.Any(m => m.Text.Contains("\"Second\" (line 3) was not applied: Varia could not list the script's statements", StringComparison.Ordinal)),
                    "script with denied jobs.list leaves parent result unnamed and notes every marker");
            }
        }

        // 7. Script failing mid-run: earlier completed SELECT keeps its name; unreached SELECT gets failure note.
        {
            var sql = "-- #Name=\"First\"\nSELECT 1;\n-- #Name=\"Second\"\nSELECT 1/0;";
            var script = new ScriptFake
            {
                StatementType = "SCRIPT",
                Children =
                [
                    new("c1", "SELECT", ScriptFake.Frame(2, 1)),
                    new("c2", "SELECT", ScriptFake.Frame(4, 1), Error: new JsonObject { ["reason"] = "invalidQuery", ["message"] = "division by zero" })
                ]
            };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var res = await ExecuteAsync(service, info, sql);
                check(res.Status == "failed" && res.ResultSets is [{ Name: "First" }]
                    && res.Messages.Any(m => m.Text.Contains("\"Second\" (line 3) was not applied: the run failed before its result set arrived.", StringComparison.Ordinal)),
                    "mid-script failure preserves earlier result name and notes unreached name");
            }
        }

        // 8. Re-attaching (query.attach): restores #Name from job's SQL, handles missing SQL safely, and skips notes on Detached.
        {
            var script = new ScriptFake { PresetJobId = "varia_attach1", PresetJobSql = "#Name=\"Reattached\"\nSELECT 1 AS id;" };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var attach = (QueryResult)await service.DispatchAsync("query.attach", JsonSerializer.SerializeToElement(
                    new BigQueryAttachArgs(info.Id, Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "varia_attach1", "varia-emulator"), Wire), Wire);
                check(attach.Status == "completed" && attach.ResultSets is [{ Name: "Reattached" }],
                    "query.attach restores #Name from the job's SQL");
            }
        }
        {
            var script = new ScriptFake { PresetJobId = "varia_attach2", PresetJobSql = null };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var attach = (QueryResult)await service.DispatchAsync("query.attach", JsonSerializer.SerializeToElement(
                    new BigQueryAttachArgs(info.Id, Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "varia_attach2", "varia-emulator"), Wire), Wire);
                check(attach.Status == "completed" && attach.ResultSets is [{ Name: null }],
                    "query.attach without job SQL leaves result unnamed safely");
            }
        }
        {
            var script = new ScriptFake { PresetJobId = "varia_attach3", PresetJobSql = "-- #Name=\"Unused\"\nUPDATE t SET a = 1;" };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var attach = (QueryResult)await service.DispatchAsync("query.attach", JsonSerializer.SerializeToElement(
                    new BigQueryAttachArgs(info.Id, Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), "varia_attach3", "varia-emulator",
                        Detached: true), Wire), Wire);
                check(attach.Status == "completed" && !attach.Messages.Any(m => m.Text.Contains("Result name", StringComparison.Ordinal)),
                    "detached query.attach emits no result-name notes");
            }
        }

        // 9. Selection execute (StartLine > 1) on a script: stackFrames match 1-based submitted lines, notes report editor lines.
        {
            var sql = "UPDATE t SET a = 1;\n-- #Name=\"Unused\"\nUPDATE t SET a = 2;\n#Name=\"Selected\"\nSELECT 1 AS id;";
            var script = new ScriptFake
            {
                StatementType = "SCRIPT",
                Children =
                [
                    new("c1", "UPDATE", ScriptFake.Frame(1, 1), DmlAffected: 1),
                    new("c2", "UPDATE", ScriptFake.Frame(3, 1), DmlAffected: 1),
                    new("c3", "SELECT", ScriptFake.Frame(5, 1))
                ]
            };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var res = await ExecuteAsync(service, info, sql, startLine: 20);
                check(res.Status == "completed" && res.ResultSets is [{ Name: "Selected" }]
                    && res.Messages.Any(m => m.Text.Contains("\"Unused\" (line 21) is unused: its statement returns no result set.", StringComparison.Ordinal)),
                    "selection execute matches 1-based stackFrames and reports editor line numbers in notes");
            }
        }

        // 10. Two SELECTs on the same line disambiguated by stackFrames startColumn.
        {
            var sql = "SELECT 1 AS id; /* #Name=\"Second\" */ SELECT 2 AS id;";
            var script = new ScriptFake
            {
                StatementType = "SCRIPT",
                Children =
                [
                    new("c1", "SELECT", ScriptFake.Frame(1, 1)),
                    new("c2", "SELECT", ScriptFake.Frame(1, 38))
                ]
            };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var res = await ExecuteAsync(service, info, sql);
                check(res.Status == "completed" && res.ResultSets.Select(s => s.Name).SequenceEqual([null, "Second"]),
                    "same-line script SELECTs disambiguate via stackFrames startColumn");
            }
        }

        // 11. Windowed child in a script keeps #Name; MaxResultSets cap notes unkept child; DiscardResults emits no spurious unused note.
        {
            var sql = "#Name=\"Child1\"\nSELECT 1 AS id;\n#Name=\"Child2\"\nSELECT 2 AS id;";
            var script = new ScriptFake
            {
                StatementType = "SCRIPT",
                Destination = new JsonObject { ["projectId"] = "varia-emulator", ["datasetId"] = "_anon_fake", ["tableId"] = "tchild" },
                DefaultRows = [.. Enumerable.Range(0, 600).Select(i => ScriptFake.Row(i, "r" + i))],
                Children =
                [
                    new("c1", "SELECT", ScriptFake.Frame(2, 1)),
                    new("c2", "SELECT", ScriptFake.Frame(4, 1))
                ]
            };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var capped = await ExecuteAsync(service, info, sql, residence: "windowed", maxResultSets: 1);
                check(capped.Status == "completed" && capped.ResultSets is [{ Name: "Child1", Residence: "remote" }]
                    && capped.Messages.Any(m => m.Text.Contains("\"Child2\" (line 3) was not applied: the run kept no more result sets.", StringComparison.Ordinal)),
                    "windowed script child preserves #Name and MaxResultSets refusal is noted");
                var discarded = await ExecuteAsync(service, info, sql, discardResults: true);
                check(discarded.Status == "completed" && discarded.ResultSets.Count == 0
                    && !discarded.Messages.Any(m => m.Text.Contains("Result name", StringComparison.Ordinal)),
                    "DiscardResults on a named script emits no spurious unused-name notes");
            }
        }

        // 12. Regression: IF / EXECUTE IMMEDIATE sharing or ending on the line of a named SELECT never steals its name.
        {
            var sql = "IF TRUE THEN SELECT 1; END IF; /* #Name=\"Second\" */ SELECT 2;";
            var script = new ScriptFake
            {
                StatementType = "SCRIPT",
                Children =
                [
                    new("c1", "SELECT", ScriptFake.Frame(1, 14)),
                    new("c2", "SELECT", ScriptFake.Frame(1, 53))
                ]
            };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var res = await ExecuteAsync(service, info, sql);
                check(res.Status == "completed" && res.ResultSets.Select(s => s.Name).SequenceEqual([null, "Second"])
                    && !res.Messages.Any(m => m.Text.Contains("Result name", StringComparison.Ordinal)),
                    "single-line IF sharing a line with a named SELECT does not steal its name");
            }
        }
        {
            var sql = "IF TRUE THEN\n  SELECT 1; END IF; /* #Name=\"Second\" */ SELECT 2;";
            var script = new ScriptFake
            {
                StatementType = "SCRIPT",
                Children =
                [
                    new("c1", "SELECT", ScriptFake.Frame(2, 3)),
                    new("c2", "SELECT", ScriptFake.Frame(2, 42))
                ]
            };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var res = await ExecuteAsync(service, info, sql);
                check(res.Status == "completed" && res.ResultSets.Select(s => s.Name).SequenceEqual([null, "Second"])
                    && !res.Messages.Any(m => m.Text.Contains("Result name", StringComparison.Ordinal)),
                    "multi-line IF ending on the line of a named SELECT does not steal its name");
            }
        }
        {
            var sql = "EXECUTE IMMEDIATE 'SELECT 1'; /* #Name=\"Second\" */ SELECT 2;";
            var script = new ScriptFake
            {
                StatementType = "SCRIPT",
                Children =
                [
                    new("c1", "SELECT", ScriptFake.Frame(1, 1)),
                    new("c2", "SELECT", ScriptFake.Frame(1, 52))
                ]
            };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var res = await ExecuteAsync(service, info, sql);
                check(res.Status == "completed" && res.ResultSets.Select(s => s.Name).SequenceEqual([null, "Second"])
                    && !res.Messages.Any(m => m.Text.Contains("Result name", StringComparison.Ordinal)),
                    "EXECUTE IMMEDIATE sharing a line with a named SELECT does not steal its name");
            }
        }

        // 13. Regression: schema-less SELECT child without stackFrames stops positional matching instead of mis-naming later sets.
        {
            var sql = "SELECT 1 AS a;\n#Name=\"Second\"\nSELECT 2 AS b;";
            var script = new ScriptFake
            {
                StatementType = "SCRIPT",
                Children =
                [
                    new("c1", "SELECT", Schema: new JsonObject { ["fields"] = new JsonArray() }),
                    new("c2", "SELECT")
                ]
            };
            var (service, info) = await ConnectAsync(script.Build());
            using (service)
            {
                var res = await ExecuteAsync(service, info, sql);
                check(res.Status == "completed" && res.ResultSets is [{ Name: null }]
                    && res.Messages.Any(m => m.Text.Contains("\"Second\" (line 2) was not applied: a SELECT statement returned no columns", StringComparison.Ordinal)),
                    "schema-less SELECT child in positional mode stops positional naming rather than shifting names");
            }
        }
    }
}
