using System.Security.Cryptography;
using System.Text;
using System.Xml;
using System.Xml.Linq;
using Varia.Backend.Results;

namespace Varia.Backend.Plans;

/// <summary>Pairs overlapping toolbar and STATISTICS XML results while keeping every manual result readable.</summary>
internal static class PlanExecutionDeduplication
{
    private static readonly XNamespace Ns = PlanParser.ShowplanName.Namespace;

    /// <summary>Maps observer positions to the native result IDs that represent the same executions.</summary>
    public static Dictionary<int, uint>? Pair(ActualPlanCapture.Snapshot snapshot, List<ResultSetBuffer> sets, long byteLimit)
    {
        // A dropped event or an unknown batch makes matching repeated executions ambiguous.
        if (snapshot.Incomplete || snapshot.Plans.Count == 0 || !sets.Any(set => set.Kind == "executionPlan")) return null;
        var available = new Dictionary<(int Batch, int Iteration, string Key), Queue<int>>();
        for (var index = 0; index < snapshot.Plans.Count; index++)
        {
            var plan = snapshot.Plans[index];
            if (plan.Batch == 0 || Fingerprint(plan.Xml) is not { } key) continue;
            var position = (plan.Batch, plan.Iteration, key);
            if (!available.TryGetValue(position, out var matches)) available.Add(position, matches = new());
            matches.Enqueue(index);
        }
        if (available.Count == 0) return null;

        var paired = new Dictionary<int, uint>();
        foreach (var set in sets)
        {
            if (set.Kind != "executionPlan") continue;
            var descriptor = set.Describe();
            // Prefer a full manual document, which normally carries the original statement text. Keep the observer
            // copy when the manual result was skipped, truncated, unreadable, or holds more than one document.
            if (descriptor is not { RowsRead: 1, RowsAvailable: 1, TruncatedCells: 0, Incomplete: false }) continue;
            using var pin = set.Pin();
            if (set.PagesFor(0, 1).FirstOrDefault() is not { } page) continue;
            var view = PageView.Parse(set.Body(page), 1);
            if (view.IsNull(0, 0) || view.IsError(0, 0) || view.IsTruncated(0, 0)) continue;
            var xml = view.Span(0, 0);
            if (xml.Length > byteLimit) break;
            byteLimit -= xml.Length;
            if (Fingerprint(Encoding.UTF8.GetString(xml)) is not { } key
                || !available.TryGetValue((descriptor.BatchNumber, descriptor.Iteration, key), out var matches)) continue;
            paired.Add(matches.Dequeue(), descriptor.ResultId);
            if (matches.Count == 0) available.Remove((descriptor.BatchNumber, descriptor.Iteration, key));
            if (available.Count == 0) break;
        }
        return paired.Count > 0 ? paired : null;
    }

    private static string? Fingerprint(string xml)
    {
        XElement? root;
        try
        {
            using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings
            {
                DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = PlanParser.Characters
            });
            root = XDocument.Load(reader).Root;
        }
        catch (XmlException) { return null; }
        if (root?.Name != PlanParser.ShowplanName) return null;
        var statements = root.Elements(Ns + "BatchSequence").Elements(Ns + "Batch").Elements(Ns + "Statements").Elements().Take(2).ToArray();
        if (statements is not [var statement] || (string?)statement.Attribute("QueryHash") is not { Length: > 0 } queryHash
            || (string?)statement.Attribute("QueryPlanHash") is not { Length: > 0 } planHash
            || statement.Element(Ns + "QueryPlan") is not { } plan) return null;

        // Statement text and statement IDs differ between the two providers. Match the compiled plan, the runtime
        // parameters, and each operator's actual counters. Consume each match once, even for identical executions.
        var signature = new StringBuilder();
        void Add(string? value) => signature.Append(value).Append('\0');
        Add(queryHash);
        Add(planHash);
        Add((string?)statement.Attribute("StatementType"));
        // The compiled hashes can agree when only a literal changes.
        foreach (var scalar in plan.Descendants(Ns + "ScalarOperator"))
        {
            Add("scalar");
            Add((string?)scalar.Attribute("ScalarString"));
        }
        foreach (var parameter in plan.Elements(Ns + "ParameterList").Elements(Ns + "ColumnReference")
            .OrderBy(element => (string?)element.Attribute("Column"), StringComparer.Ordinal))
        {
            Add("parameter");
            Add((string?)parameter.Attribute("Column"));
            Add((string?)parameter.Attribute("ParameterRuntimeValue"));
        }
        var hasCounters = false;
        foreach (var op in plan.Descendants(Ns + "RelOp"))
        {
            Add("operator");
            Add((string?)op.Attribute("NodeId"));
            Add((string?)op.Attribute("PhysicalOp"));
            foreach (var counter in op.Elements(Ns + "RunTimeInformation").Elements(Ns + "RunTimeCountersPerThread")
                .OrderBy(element => (string?)element.Attribute("Thread"), StringComparer.Ordinal))
            {
                Add("thread");
                hasCounters |= counter.Attribute("ActualRows") is not null;
                foreach (var attribute in counter.Attributes().OrderBy(attribute => attribute.Name.LocalName, StringComparer.Ordinal))
                {
                    Add(attribute.Name.LocalName);
                    Add(attribute.Value);
                }
            }
        }
        return hasCounters ? Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(signature.ToString()))) : null;
    }
}
