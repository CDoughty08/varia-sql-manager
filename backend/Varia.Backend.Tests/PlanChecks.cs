using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Varia.Backend.Plans;

namespace Varia.Backend.Tests;

internal static class PlanChecks
{
    private const string Open = "<ShowPlanXML xmlns=\"http://schemas.microsoft.com/sqlserver/2004/07/showplan\"><BatchSequence><Batch><Statements>";
    private const string Close = "</Statements></Batch></BatchSequence></ShowPlanXML>";
    private static PlanDocument Parse(string text, CancellationToken token = default) => PlanParser.Parse(new StringReader(text), token);
    public static void Run(Action<bool, string> check)
    {
        var fixture = File.ReadAllText(Path.Combine("tests", "fixtures", "plans", "multiple.sqlplan"));
        var plan = Parse(fixture);
        DiagnosticChecks(check);
        CompletenessChecks(check);
        check(plan.Statements.Count == 2 && plan.Version == "1.6" && plan.Build == "16.0.1000.6", "showplan batch statements and version");
        var root = plan.Statements[0].Nodes[0];
        var scan = plan.Statements[0].Nodes[1];
        check(root.ParentId is null && scan.ParentId == root.Id && scan.NodeId == "1", "operator parents survive non-operator wrappers");
        check(root.ActualRows == 1 && scan.ActualRows == 100 && scan.CpuMs == 18 && scan.ElapsedMs == 40 && scan.Executions == 2, "thread rows and CPU sum, elapsed takes maximum");
        check(scan.Properties.Any(property => property.Name == "RunTimeCountersPerThread[Thread=1].ActualRows" && property.Value == "40")
            && scan.Properties.Any(property => property.Name == "RunTimeCountersPerThread[Thread=2].ActualRows" && property.Value == "60"), "raw thread properties retain their thread identity");
        check(scan.Object == "[Sales].[dbo].[Orders].[IX_Status]" && scan.Warnings.Contains("PlanAffectingConvert") && plan.Statements[0].Warnings.Any(warning => warning.Contains("72.4")), "objects, conversion warnings and missing indexes");
        var target = new LivePlanTarget(1, Guid.Empty, "master", 1, 1);
        var signature = LivePlanSampler.Signature(target, plan);
        scan.ActualRows++;
        check(LivePlanSampler.Signature(target, plan) == signature, "live runtime counters do not resend a plan document");
        scan.Properties.Add(new("Const.ConstValue", "2"));
        check(LivePlanSampler.Signature(target, plan) != signature, "changed literal expressions resend topology even when live SQL text is omitted");
        scan.Properties.RemoveAt(scan.Properties.Count - 1);
        scan.ActualRows--;
        check(scan.Properties.Any(property => property.Value.Contains("完了")), "Unicode scalar expressions remain data");
        check(plan.Statements[1].Nodes[0] is { PhysicalOp: "Future SQL Operator", ActualRows: null } && plan.Statements[1].Nodes[0].Id != root.Id, "unknown operators and duplicate source node ids across statements");
        check(plan.Statements[1].Nodes[0].Properties.Any(property => property.Name == "FutureOperator.NewProperty"), "unknown operator properties preserved");
        var nested = Parse(Open + "<StmtCond StatementText=\"IF\"><Then><Statements><StmtSimple><QueryPlan><RelOp NodeId=\"0\" PhysicalOp=\"Scan\" /></QueryPlan></StmtSimple></Statements></Then></StmtCond>" + Close);
        check(nested.Statements.Count == 2 && nested.Statements[0].Nodes.Count == 0 && nested.Statements[1].Nodes[0].ParentId is null, "nested statements do not inherit another statement's operator");
        void Refused(string text, string name)
        {
            try { Parse(text); check(false, name); }
            catch (RequestException error) { check(error.Code == "INVALID_PARAMS" && !error.Message.Contains("SECRET"), name); }
        }
        Refused("<!DOCTYPE x [<!ENTITY e SYSTEM 'file:///SECRET'>]>" + Open + "<StmtSimple StatementText=\"&e;\"/>" + Close, "DTD and external entities refused without disclosing input");
        Refused("<ShowPlanXML><SECRET /></ShowPlanXML>", "wrong namespace refused");
        Refused(Open + "<StmtSimple>", "truncated XML refused");
        Refused(Open + string.Concat(Enumerable.Repeat("<X>", 260)) + string.Concat(Enumerable.Repeat("</X>", 260)) + Close, "XML depth bounded");
        Refused(Open + string.Concat(Enumerable.Repeat("<StmtSimple/>", PlanParser.Statements + 1)) + Close, "statement count bounded");
        Refused(Open + "<StmtSimple><QueryPlan>" + string.Concat(Enumerable.Repeat("<RelOp PhysicalOp=\"Scan\"/>", PlanParser.Nodes + 1)) + "</QueryPlan></StmtSimple>" + Close, "operator count bounded");
        Refused(Open + "<StmtSimple StatementText=\"" + new string('x', PlanParser.Characters) + "\"/>" + Close, "decompressed XML characters bounded");
        var large = Parse(Open + "<StmtSimple StatementText=\"" + new string('x', 20_000) + "\"/>" + Close);
        check(large.Notices.Count == 1 && large.Statements[0].Text.Length == 16_384, "shortened text is explicit and original input untouched");
        var attributes = string.Join(' ', Enumerable.Range(0, 100).Select(i => "P" + i + "=\"value\""));
        var properties = Parse(Open + "<StmtSimple><QueryPlan><RelOp PhysicalOp=\"Scan\"><Future " + attributes + "/></RelOp></QueryPlan></StmtSimple>" + Close);
        check(properties.Statements[0].Nodes[0].Properties.Count == PlanParser.Properties && properties.Notices.Count == 1, "operator properties bounded with notice");
        var verbose = string.Join(' ', Enumerable.Range(0, 64).Select(i => "P" + i + "=\"" + new string('x', 1024) + "\""));
        var heavy = Parse(Open + "<StmtSimple><QueryPlan>" + string.Concat(Enumerable.Range(0, 20).Select(i => "<RelOp NodeId=\"" + i + "\" PhysicalOp=\"Index Scan\"><Future " + verbose + "/><Object Table=\"[LastTable]\"/><Warnings NoJoinPredicate=\"true\"/></RelOp>")) + "</QueryPlan></StmtSimple>" + Close);
        check(heavy.Notices.Count == 1 && heavy.Statements[0].Nodes[^1] is { PhysicalOp: "Index Scan", Object: "[LastTable]" } last && last.Warnings.Contains("NoJoinPredicate"),
            "property budget exhaustion preserves later operator labels, objects and warnings");
        using var zipped = new MemoryStream();
        using (var gzip = new GZipStream(zipped, CompressionLevel.Fastest, leaveOpen: true)) gzip.Write(Encoding.UTF8.GetBytes(fixture));
        check(PlanParser.Read(new(Convert.ToBase64String(zipped.ToArray()), "gzip"), default).Statements.Count == 2, "compressed IPC input parses identically");
        try { PlanParser.Read(new("invalid", "gzip"), default); check(false, "invalid compressed input"); }
        catch (RequestException error) { check(error.Code == "INVALID_PARAMS", "invalid compressed input"); }
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        try { Parse(fixture, cancelled.Token); check(false, "plan parse cancellation"); }
        catch (OperationCanceledException) { check(true, "plan parse cancellation"); }
    }

    /// <summary>A shortened field must say so on its owner: the comparison treats it as a prefix, never as equality.</summary>
    private static void CompletenessChecks(Action<bool, string> check)
    {
        string Statement(string text, string hash, string body = "") => Open + "<StmtSimple StatementType=\"SELECT\" QueryHash=\"" + hash + "\" StatementText=\"" + text + "\"><QueryPlan>" + body + "</QueryPlan></StmtSimple>" + Close;
        var prefix = "SELECT N'" + new string('x', 16_400);
        var first = Parse(Statement(prefix + "A'", "0x1111111111111111")).Statements[0];
        var second = Parse(Statement(prefix + "B'", "0x2222222222222222")).Statements[0];
        check(first.Text == second.Text && first.Text.Length == 16_384 && first is { TextShortened: true, DetailsShortened: null } && second.TextShortened == true
            && first.QueryHash == "0x1111111111111111" && second.QueryHash == "0x2222222222222222", "statements that differ past the text cap are marked shortened and keep their complete hashes");
        string Parameters(char last) => "<ParameterList><ColumnReference Column=\"@p\" ParameterDataType=\"nvarchar(max)\" ParameterCompiledValue=\"" + new string('x', 4_100) + last + "\" ParameterRuntimeValue=\"(1)\"/></ParameterList>";
        var compiledA = Parse(Statement("SELECT @p", "0x1", Parameters('A'))).Statements[0];
        var compiledB = Parse(Statement("SELECT @p", "0x1", Parameters('B'))).Statements[0];
        check(compiledA.Diagnostics.Parameters[0].CompiledValue == compiledB.Diagnostics.Parameters[0].CompiledValue && compiledA.Diagnostics.Parameters[0].CompiledValue!.Length == 4_096
            && compiledA is { TextShortened: null, DetailsShortened: true } && compiledB.DetailsShortened == true, "parameter values that differ past their cap mark the statement's details shortened");
        var operators = Parse(Statement("SELECT 1", "0x1",
            "<RelOp NodeId=\"0\" PhysicalOp=\"Index Seek\" LogicalOp=\"Index Seek\"><Object Table=\"[" + new string('t', 600) + "]\"/>"
            + "<RelOp NodeId=\"1\" PhysicalOp=\"Filter\" LogicalOp=\"Filter\"><Predicate><ScalarOperator ScalarString=\"" + new string('p', 5_000) + "\"/></Predicate>"
            + "<RelOp NodeId=\"2\" PhysicalOp=\"" + new string('o', 200) + "\" LogicalOp=\"Scan\"/></RelOp></RelOp>")).Statements[0];
        check(operators is { TextShortened: null, DetailsShortened: null } && operators.Nodes[0] is { IdentityShortened: true, DetailsShortened: null }
            && operators.Nodes[1] is { IdentityShortened: null, DetailsShortened: true } && operators.Nodes[2] is { IdentityShortened: true, DetailsShortened: null },
            "shortened object, operator name and predicate text mark only the operator and the kind of field that lost text");
        var capped = Parse(Statement("SELECT 1", "0x1", "<RelOp NodeId=\"0\" PhysicalOp=\"Scan\"><OutputList>" + string.Concat(Enumerable.Repeat("<ColumnReference Column=\"x\"/>", 100)) + "</OutputList></RelOp><RelOp NodeId=\"1\" PhysicalOp=\"Sort\"/>")).Statements[0];
        check(capped.Nodes[0] is { IdentityShortened: null, DetailsShortened: true } && capped.Nodes[1] is { IdentityShortened: null, DetailsShortened: null }, "a capped diagnostic list marks its operator and no other");
        var longHash = Parse(Statement("SELECT 1", new string('f', 65))).Statements[0];
        check(longHash.QueryHash == "" && longHash.TextShortened is null, "a query hash that cannot be kept whole is dropped, not shortened into false identity");
        var web = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        var complete = JsonSerializer.Serialize(Parse(File.ReadAllText(Path.Combine("tests", "fixtures", "plans", "diagnostics.sqlplan"))), web);
        check(!complete.Contains("Shortened", StringComparison.Ordinal) && JsonSerializer.Serialize(first, web).Contains("\"textShortened\":true", StringComparison.Ordinal)
            && JsonSerializer.Serialize(operators, web).Contains("\"identityShortened\":true", StringComparison.Ordinal), "completeness flags are serialized only when set");
    }
    private static void DiagnosticChecks(Action<bool, string> check)
    {
        var plan = Parse(File.ReadAllText(Path.Combine("tests", "fixtures", "plans", "diagnostics.sqlplan")));
        var statement = plan.Statements[0];
        var sort = statement.Nodes[0];
        var seek = statement.Nodes[1];
        check(sort.Id == "s0n1" && seek.Id == "s0n2" && seek.ParentId == sort.Id, "diagnostic extraction preserves stable traversal IDs and hierarchy");
        check(sort.Diagnostics.Parallel == true && sort.Diagnostics.EstimatedExecutionMode == "Row" && statement.Diagnostics.DegreeOfParallelism == 2,
            "parallelism and estimated execution mode are independent fields");
        check(sort.ActualRows == 100 && sort.CpuMs == 18 && sort.ElapsedMs == 30 && sort.Executions == 2 && sort.Diagnostics.Threads.Count == 3
            && sort.Diagnostics.Threads[0] is { Rows: 0, Executions: 0, CpuMs: 0 }, "parallel counters retain coordinator zeros and worker entries");
        check(seek.Diagnostics.EstimatedExecutions == 5 && seek.ActualRows == 10 && seek.Executions == 5 && seek.CpuMs == 0,
            "repeated executions use cumulative rows and CPU without multiplying counters");
        check(sort.Diagnostics.OutputColumns.SequenceEqual(["[Sales].[dbo].[Orders].[Amount]"]) && seek.Diagnostics.OutputColumns.SequenceEqual(["[Amount]"]),
            "output columns belong only to their enclosing operator");
        var predicates = seek.Diagnostics.Predicates;
        check(predicates.Any(p => p.Kind == "Seek Prefix" && p.Comparison == "EQ" && p.Columns.SequenceEqual(["[Status]"]) && p.Expressions.SequenceEqual(["[@status]"]))
            && predicates.Any(p => p.Kind == "Seek StartRange" && p.Comparison == "GT" && p.Expressions.SequenceEqual(["(0)"]))
            && predicates.Any(p => p.Kind == "Residual" && p.Expressions.SequenceEqual(["[Amount]>(0)"])) && sort.Diagnostics.Predicates.Count == 0,
            "seek ranges and residuals retain structure, outer expressions and owner scope");
        check(statement.Diagnostics.Parameters is [{ CompiledValue: "N'新規'", RuntimeValue: "N'完了'" }, { CompiledValue: "(0)", RuntimeValue: null }],
            "parameter values retain Unicode, zeros and absent runtime availability");
        check(statement.Diagnostics.MemoryGrant.Any(p => p.Name == "GrantWaitTime" && p.Value == "0")
            && sort.Diagnostics.Spills.Any(s => s.Kind == "SortSpillDetails" && s.Properties.Any(p => p.Name == "WritesToTempDb" && p.Value == "16")),
            "memory grants and spill detail attributes are retained");
        check(statement.Diagnostics.MissingIndexes is [{ Impact: 72.4, Columns.Count: 3 }] && statement.Diagnostics.MissingIndexes[0].Columns.Select(c => c.Usage).SequenceEqual(["EQUALITY", "INEQUALITY", "INCLUDE"])
            && statement.Diagnostics.Warnings.Single().Properties.Any(p => p.Name == "Expression"), "missing-index usage and statement warning details survive outside RelOp");
        string Wrap(string body) => Open + "<StmtSimple><QueryPlan><RelOp NodeId=\"0\" PhysicalOp=\"Scan\">" + body + "</RelOp></QueryPlan></StmtSimple>" + Close;
        var partial = Parse(Wrap("<RunTimeInformation><RunTimeCountersPerThread Thread=\"1\" ActualRows=\"0\" ActualCPUms=\"0\" ActualElapsedms=\"0\" ActualExecutions=\"1\"/><RunTimeCountersPerThread Thread=\"2\" ActualRows=\"0\" ActualElapsedms=\"3\"/></RunTimeInformation>")).Statements[0].Nodes[0];
        check(partial.ActualRows == 0 && partial.CpuMs is null && partial.ElapsedMs == 3 && partial.Executions is null, "missing counters on one worker never masquerade as complete sums");
        var repeated = Parse(Wrap("<RunTimeInformation>" + string.Concat(Enumerable.Repeat("<RunTimeCountersPerThread Thread=\"0\" ActualRows=\"2\" ActualCPUms=\"1\" ActualElapsedms=\"4\" ActualExecutions=\"3\"/>", 140)) + "</RunTimeInformation>"));
        check(repeated.Statements[0].Nodes[0] is { ActualRows: 280, CpuMs: 140, ElapsedMs: 4, Executions: 420, Diagnostics.Threads.Count: 128 } && repeated.Notices.Count == 1,
            "repeated thread IDs remain separate and detail truncation does not truncate aggregates");
        var hugeColumns = Parse(Wrap("<OutputList>" + string.Concat(Enumerable.Repeat("<ColumnReference Column=\"x\"/>", 100)) + "</OutputList>"));
        check(hugeColumns.Statements[0].Nodes[0].Diagnostics.OutputColumns.Count == 64 && hugeColumns.Notices.Count == 1, "structured diagnostic collections are capped explicitly");
        var sparse = Parse(Wrap("<IndexScan><SeekPredicates><SeekPredicate><StartRange ScanType=\"GE\"><RangeColumns><ColumnReference Column=\"[id]\"/></RangeColumns><RangeExpressions><ScalarOperator><Const ConstValue=\"(0)\"/></ScalarOperator></RangeExpressions></StartRange></SeekPredicate></SeekPredicates></IndexScan>"));
        check(sparse.Statements[0].Nodes[0].Diagnostics.Predicates.Any(p => p.Comparison == "GE" && p.Expressions.SequenceEqual(["(0)"])), "legacy SeekPredicate and missing scalar display text preserve available leaves");
        var invalid = Parse(Wrap("<Warnings NoJoinPredicate=\"0\"/><RunTimeInformation><RunTimeCountersPerThread Thread=\"0\" ActualRows=\"NaN\" ActualCPUms=\"-1\" ActualElapsedms=\"INF\" ActualExecutions=\"bad\"/></RunTimeInformation>"));
        check(invalid.Statements[0].Nodes[0] is { ActualRows: null, CpuMs: null, ElapsedMs: null, Executions: null, Warnings.Count: 0, Diagnostics.Warnings.Count: 0 }, "invalid measurements remain unavailable and numeric false is not a warning");
        var exhaustive = Parse(Open + "<StmtSimple><QueryPlan>" + string.Concat(Enumerable.Range(0, 300).Select(i => "<RelOp PhysicalOp=\"Scan\"><OutputList>" + string.Concat(Enumerable.Repeat("<ColumnReference Column=\"c\"/>", 64))
            + "</OutputList><RunTimeInformation><RunTimeCountersPerThread Thread=\"0\" ActualRows=\"1\" ActualCPUms=\"0\" ActualElapsedms=\"0\" ActualExecutions=\"1\"/></RunTimeInformation></RelOp>")) + "</QueryPlan></StmtSimple>" + Close);
        check(exhaustive.Notices.Count == 1 && exhaustive.Statements[0].Nodes[^1] is { ActualRows: 1, CpuMs: 0, Diagnostics.Threads.Count: 0 }, "document diagnostic-entry exhaustion preserves all later runtime aggregates");
        var live = PlanParser.Parse(new StringReader(File.ReadAllText(Path.Combine("tests", "fixtures", "plans", "diagnostics.sqlplan"))), includeDiagnostics: false);
        check(live.Statements[0].DiagnosticPayload is null && live.Statements[0].Nodes.All(n => n.DiagnosticPayload is null)
            && live.Statements[0].Nodes[0] is { ActualRows: 100, CpuMs: 18, ElapsedMs: 30 }, "live parse skips detailed text allocation and serialization while retaining aggregate counters");
        var verbosePredicates = Open + "<StmtSimple><QueryPlan>" + string.Concat(Enumerable.Range(0, 215).Select(i =>
            "<RelOp NodeId=\"" + i + "\" PhysicalOp=\"Filter\"><Predicate><ScalarOperator ScalarString=\"" + new string('x', 4096) + "\"/></Predicate></RelOp>"))
            + "<RelOp NodeId=\"215\" PhysicalOp=\"Compute Scalar\"><Const ConstValue=\"identity literal\"/></RelOp></QueryPlan></StmtSimple>" + Close;
        var verboseActual = Parse(verbosePredicates);
        var verboseLive = PlanParser.Parse(new StringReader(verbosePredicates), includeDiagnostics: false);
        check(verbosePredicates.Length < 1_048_576 && verboseActual.Statements[0].Nodes.SelectMany(n => n.Properties).SequenceEqual(verboseLive.Statements[0].Nodes.SelectMany(n => n.Properties)),
            "diagnostic text exhaustion cannot change legacy raw fields or live-to-actual scalar identity");
        var emptyGrant = new StatementDiagnostics();
        emptyGrant.Parameters.Add(new("@missing", "int", "(0)", "(1)"));
        emptyGrant.Parameters.Add(new("@empty", "nvarchar(1)", "", ""));
        var exhausted = new PlanStatement { Id = "s", Text = "", Type = "" };
        exhausted.Diagnostics.Parameters.AddRange(emptyGrant.Parameters);
        PlanDiagnostics.ApplyTextBudget([exhausted], (_, _) => "", default);
        check(exhausted.Diagnostics.Parameters is [{ CompiledValue: null, RuntimeValue: null }, { CompiledValue: "", RuntimeValue: "" }],
            "budget-omitted parameter values are unavailable while genuinely empty values remain available");
        var shortAttributes = string.Join(' ', "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".Select(letter => letter + "=\"\""));
        var nearReplyLimit = Open + "<StmtSimple><QueryPlan>" + string.Concat(Enumerable.Repeat("<RelOp PhysicalOp=\"x\"><X " + shortAttributes + "/></RelOp>", 6500))
            + string.Concat(Enumerable.Repeat("<RelOp PhysicalOp=\"Index Scan\"><Object Table=\"[" + new string('t', 126) + "]\"/></RelOp>", 3500)) + "</QueryPlan></StmtSimple>" + Close;
        var legacyReply = PlanParser.Parse(new StringReader(nearReplyLimit), includeDiagnostics: false);
        var diagnosticReply = Parse(nearReplyLimit);
        check(diagnosticReply.Statements[0].Nodes.Count == legacyReply.Statements[0].Nodes.Count
            && diagnosticReply.Statements[0].Nodes.All(n => n.DiagnosticPayload is null) && diagnosticReply.Notices.Any(n => n.Contains("reply budget")),
            "optional diagnostics yield to a legacy graph at the existing reply budget");
    }
}
