using System.IO.Compression;
using System.Text;
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
        check(plan.Statements.Count == 2 && plan.Version == "1.6" && plan.Build == "16.0.1000.6", "showplan batch statements and version");
        var root = plan.Statements[0].Nodes[0];
        var scan = plan.Statements[0].Nodes[1];
        check(root.ParentId is null && scan.ParentId == root.Id && scan.NodeId == "1", "operator parents survive non-operator wrappers");
        check(root.ActualRows == 1 && scan.ActualRows == 100 && scan.CpuMs == 18 && scan.ElapsedMs == 40 && scan.Executions == 2, "thread rows and CPU sum, elapsed takes maximum");
        check(scan.Properties.Any(property => property.Name == "RunTimeCountersPerThread[Thread=1].ActualRows" && property.Value == "40")
            && scan.Properties.Any(property => property.Name == "RunTimeCountersPerThread[Thread=2].ActualRows" && property.Value == "60"), "raw thread properties retain their thread identity");
        check(scan.Object == "[Sales].[dbo].[Orders].[IX_Status]" && scan.Warnings.Contains("PlanAffectingConvert") && plan.Statements[0].Warnings.Any(warning => warning.Contains("72.4")), "objects, conversion warnings and missing indexes");
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
}
