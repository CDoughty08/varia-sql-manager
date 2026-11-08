using System.Xml;

namespace Varia.Backend.Plans;

internal sealed record PlanDetail(string Kind, List<PlanProperty> Properties);
internal sealed record PlanThread(double? Thread, double? Rows, double? RowsRead, double? Executions, double? CpuMs, double? ElapsedMs, string ExecutionMode, List<PlanProperty> Properties);
internal sealed record PlanParameter(string Name, string DataType, string? CompiledValue, string? RuntimeValue);
internal sealed record PlanIndexColumn(string Usage, string Name);
internal sealed record PlanMissingIndex(string Database, string Schema, string Table, double? Impact, List<PlanIndexColumn> Columns);
internal sealed record PlanPredicate(string Kind, string Comparison, List<string> Columns, List<string> Expressions);
internal sealed class OperatorDiagnostics
{
    public double? EstimatedExecutions { get; set; }
    public bool? Parallel { get; set; }
    public string EstimatedExecutionMode { get; set; } = "";
    public List<PlanPredicate> Predicates { get; } = [];
    public List<string> OutputColumns { get; } = [];
    public List<PlanDetail> Warnings { get; } = [];
    public List<PlanDetail> Spills { get; } = [];
    public List<PlanThread> Threads { get; } = [];
    public bool RuntimeDetailsAvailable { get; set; } = true;
}
internal sealed class StatementDiagnostics
{
    public double? DegreeOfParallelism { get; set; }
    public List<PlanProperty> MemoryGrant { get; } = [];
    public List<PlanParameter> Parameters { get; } = [];
    public List<PlanMissingIndex> MissingIndexes { get; } = [];
    public List<PlanDetail> Warnings { get; } = [];
}

/// <summary>Streaming, owner-scoped extraction. Shares the parser's text budget; all lists also have item caps.
/// Unknown attributes on warning, grant, spill and thread records remain available across server versions.</summary>
internal sealed class PlanDiagnostics(Func<string?, int, string> bound, Action omitted)
{
    private sealed record Scope(int Depth, string Name, PlanStatement? Statement, PlanNode? Node, object? Value);
    private readonly List<Scope> path = [];
    private readonly Dictionary<PlanNode, int> runtimeCounts = [];
    private int entries;
    private bool Add<T>(List<T> list, Func<T> create, int cap = 64)
    {
        if (list.Count >= cap || entries >= 16_384) { omitted(); return false; }
        entries++;
        list.Add(create());
        return true;
    }
    private List<PlanProperty> Attributes(XmlReader xml)
    {
        var result = new List<PlanProperty>();
        if (!xml.MoveToFirstAttribute()) return result;
        do
        {
            if (xml.NamespaceURI.Length == 0) Add(result, () => new(bound(xml.LocalName, 128), bound(xml.Value, 4096)));
        } while (xml.MoveToNextAttribute());
        xml.MoveToElement();
        return result;
    }
    public void Read(XmlReader xml, PlanStatement? statement, PlanNode? node)
    {
        path.RemoveAll(scope => scope.Depth >= xml.Depth);
        bool In(string name) => path.Any(scope => scope.Name == name && scope.Statement == statement && scope.Node == node);
        T? Ancestor<T>() where T : class => path.LastOrDefault(scope => scope.Statement == statement && scope.Node == node && scope.Value is T)?.Value as T;
        var name = xml.LocalName;
        object? value = null;
        var diagnostic = node?.Diagnostics;
        string Field(string field, int cap = 1024) => bound(xml.GetAttribute(field), cap);
        string? OptionalField(string field)
        {
            if (xml.GetAttribute(field) is not { } original) return null;
            var retained = bound(original, 4096);
            return retained.Length == 0 && original.Length > 0 ? null : retained;
        }
        string Column() => bound(string.Join('.', new[] { "Database", "Schema", "Table", "Column" }.Select(xml.GetAttribute).Where(v => !string.IsNullOrEmpty(v))), 2048);
        if (name == "RelOp" && diagnostic is not null)
        {
            diagnostic.Parallel = xml.GetAttribute("Parallel") switch { "true" or "1" => true, "false" or "0" => false, _ => null };
            diagnostic.EstimatedExecutionMode = Field("EstimatedExecutionMode", 128);
            if (PlanParser.Number(xml.GetAttribute("EstimateRebinds")) is { } rebinds && PlanParser.Number(xml.GetAttribute("EstimateRewinds")) is { } rewinds
                && double.IsFinite(1 + rebinds + rewinds)) diagnostic.EstimatedExecutions = 1 + rebinds + rewinds;
        }
        if (statement is not null && node is null)
        {
            var data = statement.Diagnostics;
            if (name == "QueryPlan")
            {
                data.DegreeOfParallelism = PlanParser.Number(xml.GetAttribute("DegreeOfParallelism"));
                if (xml.GetAttribute("MemoryGrant") is { } grant) Add(data.MemoryGrant, () => new("MemoryGrant", bound(grant, 1024)));
            }
            if (name == "MemoryGrantInfo") foreach (var property in Attributes(xml)) Add(data.MemoryGrant, () => property);
            if (name == "ColumnReference" && In("ParameterList")) Add(data.Parameters, () => new(Field("Column"), Field("ParameterDataType"),
                OptionalField("ParameterCompiledValue"), OptionalField("ParameterRuntimeValue")));
            if (name == "MissingIndexGroup") value = new Impact(PlanParser.Number(xml.GetAttribute("Impact")));
            if (name == "MissingIndex")
            {
                var index = new PlanMissingIndex(Field("Database"), Field("Schema"), Field("Table"), Ancestor<Impact>()?.Value, []);
                if (Add(data.MissingIndexes, () => index)) value = index;
            }
            if (name == "ColumnGroup") value = new Usage(Field("Usage", 128));
            if (name == "Column" && Ancestor<PlanMissingIndex>() is { } missing) Add(missing.Columns, () => new(Ancestor<Usage>()?.Value ?? "", Field("Name")));
        }
        if (diagnostic is not null)
        {
            if (name == "ColumnReference" && In("OutputList")) Add(diagnostic.OutputColumns, Column);
            var seek = In("SeekPredicates") || In("SeekPredicate") || In("SeekPredicateNew");
            if (name is "Predicate" or "Residual" or "ProbeResidual" || seek && name is "Prefix" or "StartRange" or "EndRange"
                || name is "SeekPredicate" or "SeekPredicateNew")
            {
                var predicate = new PlanPredicate(name is "Predicate" or "Residual" or "ProbeResidual" ? "Residual" : "Seek " + name, Field("ScanType", 128), [], []);
                if (Add(diagnostic.Predicates, () => predicate)) value = predicate;
            }
            if (Ancestor<PlanPredicate>() is { } current)
            {
                if (name == "ColumnReference" && (In("RangeColumns") || !seek)) Add(current.Columns, Column);
                // Only outer scalar expressions: descendants repeat parts of the same expression.
                if (name == "ScalarOperator" && Ancestor<RenderedScalar>() is null && xml.GetAttribute("ScalarString") is { } expression)
                {
                    Add(current.Expressions, () => bound(expression, 4096));
                    value = new RenderedScalar();
                }
                // Older/sparse XML may omit ScalarString. Preserve available leaves without inventing SQL syntax.
                if (Ancestor<RenderedScalar>() is null)
                {
                    if (name == "Const" && xml.GetAttribute("ConstValue") is { } constant) Add(current.Expressions, () => bound(constant, 4096));
                    if (name == "ColumnReference" && In("RangeExpressions")) Add(current.Expressions, Column);
                }
            }
        }
        if (In("Warnings") && name != "Warnings")
        {
            var target = diagnostic?.Warnings ?? statement?.Diagnostics.Warnings;
            if (target is not null) Add(target, () => new(bound(name, 128), Attributes(xml)));
        }
        if (name == "Warnings" && xml.HasAttributes)
        {
            var target = diagnostic?.Warnings ?? statement?.Diagnostics.Warnings;
            if (target is not null)
                foreach (var property in Attributes(xml).Where(p => p.Value is not ("false" or "0"))) Add(target, () => new(property.Name, [property]));
        }
        if (diagnostic is not null && name.Contains("Spill", StringComparison.Ordinal))
            Add(diagnostic.Spills, () => new(bound(name, 128), Attributes(xml)));
        if (!xml.IsEmptyElement) path.Add(new(xml.Depth, name, statement, node, value));
    }
    private sealed record Impact(double? Value);
    private sealed record Usage(string Value);
    private sealed record RenderedScalar;

    internal static void ApplyTextBudget(IEnumerable<PlanStatement> statements, Func<string?, int, string> retain, CancellationToken token)
    {
        string Text(string? value) => retain(value, 16_384);
        string? Optional(string? value)
        {
            if (value is null) return null;
            var retained = Text(value);
            return retained.Length == 0 && value.Length > 0 ? null : retained;
        }
        void Strings(List<string> values) { for (var i = 0; i < values.Count; i++) values[i] = Text(values[i]); }
        void Properties(List<PlanProperty> values)
        {
            for (var i = 0; i < values.Count; i++) values[i] = new(Text(values[i].Name), Text(values[i].Value));
        }
        void Details(List<PlanDetail> values)
        {
            for (var i = 0; i < values.Count; i++) { values[i] = values[i] with { Kind = Text(values[i].Kind) }; Properties(values[i].Properties); }
        }
        foreach (var statement in statements)
        {
            token.ThrowIfCancellationRequested();
            var data = statement.Diagnostics;
            Properties(data.MemoryGrant);
            Details(data.Warnings);
            for (var i = 0; i < data.Parameters.Count; i++)
            {
                var parameter = data.Parameters[i];
                data.Parameters[i] = new(Text(parameter.Name), Text(parameter.DataType), Optional(parameter.CompiledValue), Optional(parameter.RuntimeValue));
            }
            for (var i = 0; i < data.MissingIndexes.Count; i++)
            {
                var index = data.MissingIndexes[i];
                data.MissingIndexes[i] = index with { Database = Text(index.Database), Schema = Text(index.Schema), Table = Text(index.Table) };
                for (var c = 0; c < index.Columns.Count; c++) index.Columns[c] = new(Text(index.Columns[c].Usage), Text(index.Columns[c].Name));
            }
            foreach (var node in statement.Nodes)
            {
                token.ThrowIfCancellationRequested();
                var diagnostic = node.Diagnostics;
                diagnostic.EstimatedExecutionMode = Text(diagnostic.EstimatedExecutionMode);
                Strings(diagnostic.OutputColumns);
                for (var i = 0; i < diagnostic.Predicates.Count; i++)
                {
                    var predicate = diagnostic.Predicates[i];
                    diagnostic.Predicates[i] = predicate with { Kind = Text(predicate.Kind), Comparison = Text(predicate.Comparison) };
                    Strings(predicate.Columns); Strings(predicate.Expressions);
                }
                Details(diagnostic.Warnings); Details(diagnostic.Spills);
                for (var i = 0; i < diagnostic.Threads.Count; i++)
                {
                    diagnostic.Threads[i] = diagnostic.Threads[i] with { ExecutionMode = Text(diagnostic.Threads[i].ExecutionMode) };
                    Properties(diagnostic.Threads[i].Properties);
                }
            }
        }
    }

    public void Runtime(XmlReader xml, PlanNode node, bool retainDetails)
    {
        var rows = PlanParser.Number(xml.GetAttribute("ActualRows"));
        var executions = PlanParser.Number(xml.GetAttribute("ActualExecutions"));
        var cpu = PlanParser.Number(xml.GetAttribute("ActualCPUms"));
        var elapsed = PlanParser.Number(xml.GetAttribute("ActualElapsedms"));
        var first = !runtimeCounts.ContainsKey(node);
        runtimeCounts[node] = runtimeCounts.GetValueOrDefault(node) + 1;
        // Missing/invalid on any worker makes that aggregate unavailable; a real zero remains zero.
        double? Aggregate(double? previous, double? next, bool maximum = false) => next is null || !first && previous is null ? null
            : maximum ? Math.Max(previous ?? 0, next.Value) : double.IsFinite((previous ?? 0) + next.Value) ? (previous ?? 0) + next.Value : null;
        node.ActualRows = Aggregate(node.ActualRows, rows);
        node.Executions = Aggregate(node.Executions, executions);
        node.CpuMs = Aggregate(node.CpuMs, cpu);
        node.ElapsedMs = Aggregate(node.ElapsedMs, elapsed, true);
        if (retainDetails) Add(node.Diagnostics.Threads, () => new(PlanParser.Number(xml.GetAttribute("Thread")), rows, PlanParser.Number(xml.GetAttribute("ActualRowsRead")),
            executions, cpu, elapsed, bound(xml.GetAttribute("ActualExecutionMode"), 128), Attributes(xml)), 128);
    }
}
