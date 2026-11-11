using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Xml;
using System.Xml.Linq;

namespace Varia.Backend.Plans;

internal sealed record PlanParseArgs(string Xml, string Encoding);
internal sealed record PlanProperty(string Name, string Value);
internal sealed class PlanNode
{
    public required string Id { get; init; }
    public string? ParentId { get; init; }
    public required string NodeId { get; init; }
    public required string PhysicalOp { get; init; }
    public required string LogicalOp { get; init; }
    public string Object { get; set; } = "";
    public double? EstimatedRows { get; init; }
    public double? EstimatedCost { get; init; }
    public double? ActualRows { get; set; }
    public double? ElapsedMs { get; set; }
    public double? CpuMs { get; set; }
    public double? Executions { get; set; }
    public List<string> Warnings { get; } = [];
    public List<PlanProperty> Properties { get; } = [];
    // Completeness travels with the value: a shortened field is evidence of its retained prefix only, never of equality.
    // True or absent. Identity covers the operator names and object; details cover properties, warnings and diagnostics.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? IdentityShortened { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? DetailsShortened { get; set; }
    // Live frames cannot refresh details; optional payloads also yield when the reply budget needs the legacy graph.
    [JsonIgnore] public OperatorDiagnostics Diagnostics { get; } = new();
    [JsonPropertyName("diagnostics"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public OperatorDiagnostics? DiagnosticPayload => Diagnostics.RuntimeDetailsAvailable ? Diagnostics : null;
}
internal sealed class PlanStatement
{
    public string? StatementId { get; init; }
    public string? QueryHash { get; init; }
    public required string Id { get; init; }
    public required string Text { get; init; }
    public required string Type { get; init; }
    public double? EstimatedCost { get; init; }
    public List<string> Warnings { get; } = [];
    public List<PlanNode> Nodes { get; } = [];
    // True or absent, as on PlanNode. Text covers the statement text and type; details cover warnings and diagnostics.
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? TextShortened { get; set; }
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] public bool? DetailsShortened { get; set; }
    [JsonIgnore] public StatementDiagnostics Diagnostics { get; } = new();
    internal bool IncludeDiagnostics { get; set; } = true;
    [JsonPropertyName("diagnostics"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public StatementDiagnostics? DiagnosticPayload => IncludeDiagnostics ? Diagnostics : null;
}
internal sealed record PlanDocument(string Version, string Build, List<PlanStatement> Statements, List<string> Notices);

/// <summary>Showplan is data: never execute it, resolve entities, load a schema or include SQL/names in an error.</summary>
internal static class PlanParser
{
    public const int Characters = 8_388_608, CompressedBytes = 2_097_152, Nodes = 10_000, Statements = 512, Depth = 256,
        Properties = 64, Text = 1_048_576, ReplyBytes = 12_582_912;
    private const string Namespace = "http://schemas.microsoft.com/sqlserver/2004/07/showplan";
    internal static readonly XName ShowplanName = XName.Get("ShowPlanXML", Namespace);
    private static RequestException Limit() => new("INVALID_PARAMS", "This execution plan exceeds the viewer's size, depth or operator limit. Open its XML source to inspect it.");

    public static PlanDocument Read(PlanParseArgs args, CancellationToken token)
    {
        if (args.Encoding != "gzip" || string.IsNullOrEmpty(args.Xml) || args.Xml.Length > (CompressedBytes + 2) / 3 * 4) throw Limit();
        try
        {
            var bytes = Convert.FromBase64String(args.Xml);
            if (bytes.Length > CompressedBytes) throw Limit();
            using var compressed = new MemoryStream(bytes, writable: false);
            using var unzip = new GZipStream(compressed, CompressionMode.Decompress);
            using var reader = new StreamReader(unzip, new UTF8Encoding(false, true), detectEncodingFromByteOrderMarks: false, bufferSize: 8192);
            return Parse(reader, token);
        }
        catch (Exception error) when (error is FormatException or InvalidDataException or DecoderFallbackException)
        { throw new RequestException("INVALID_PARAMS", "The execution plan input could not be read."); }
    }

    internal static PlanDocument Parse(TextReader input, CancellationToken token = default, bool includeDiagnostics = true)
    {
        try
        {
            using var xml = XmlReader.Create(input, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null,
                MaxCharactersInDocument = Characters, IgnoreComments = true, IgnoreProcessingInstructions = true });
            var statements = new List<PlanStatement>();
            var scopes = new Stack<(int Depth, PlanStatement? Statement, PlanNode? Node, bool Warning)>();
            PlanStatement? statement = null;
            PlanNode? node = null;
            var warning = false;
            var found = false;
            var version = "";
            var build = "";
            var count = 0;
            var remaining = Text;
            var stagedRemaining = Text;
            // Counted, not flagged: a change across one element attributes the loss to the statement or operator that owns it.
            var omissions = 0;
            // Properties keep the first value of a repeated attribute by design; the structured diagnostics carry the repeats.
            // That is worth the notice but is not a shortened field, or nearly every operator would be marked.
            var repeated = false;
            // Stage at most one text budget of details, then fit them into what legacy fields leave unused.
            // Details must never change the identity-bearing raw properties of the same live/actual XML.
            var diagnostics = new PlanDiagnostics((value, cap) => Budget(value, cap, ref stagedRemaining), () => omissions++);
            // Essential labels keep their own per-field caps: verbose early properties must not blank later operators.
            string Core(string? value, int cap = 1024)
            {
                value ??= "";
                if (value.Length <= cap) return value;
                omissions++;
                return value[..(cap - 1)] + "…";
            }
            string Bound(string? value, int cap = 1024) => Budget(value, cap, ref remaining);
            string Budget(string? value, int cap, ref int available)
            {
                value ??= "";
                var length = Math.Min(value.Length, Math.Min(cap, available));
                available -= length;
                if (length == value.Length) return value;
                omissions++;
                return length == 0 ? "" : value[..(length - 1)] + "…";
            }
            void Warn(List<string> target, string value)
            {
                if (target.Count < 32 && !target.Contains(value)) target.Add(Core(value));
                else if (target.Count >= 32) omissions++;
            }
            while (xml.Read())
            {
                token.ThrowIfCancellationRequested();
                if (xml.Depth > Depth) throw Limit();
                if (xml.NodeType == XmlNodeType.EndElement)
                {
                    if (scopes.TryPeek(out var scope) && scope.Depth == xml.Depth)
                    { scopes.Pop(); statement = scope.Statement; node = scope.Node; warning = scope.Warning; }
                    continue;
                }
                if (xml.NodeType != XmlNodeType.Element) continue;
                var name = xml.LocalName;
                if (!found)
                {
                    if (xml.Depth != 0 || name != "ShowPlanXML" || xml.NamespaceURI != Namespace)
                        throw new RequestException("INVALID_PARAMS", "This document is not SQL Server Showplan XML.");
                    found = true;
                    version = Core(xml.GetAttribute("Version"), 128);
                    build = Core(xml.GetAttribute("Build"), 128);
                }
                if (xml.NamespaceURI != Namespace) continue;
                var previous = (xml.Depth, statement, node, warning);
                var scoped = false;
                var mark = omissions;
                if (name.StartsWith("Stmt", StringComparison.Ordinal))
                {
                    if (statements.Count >= Statements) throw Limit();
                    var text = Bound(xml.GetAttribute("StatementText"), 16_384);
                    var type = Core(xml.GetAttribute("StatementType") ?? name, 128);
                    var textShortened = omissions != mark;
                    // A hash that cannot be kept whole is not identity evidence, so it is dropped rather than shortened.
                    var hash = xml.GetAttribute("QueryHash") ?? "";
                    if (hash.Length > 64) { hash = ""; omissions++; }
                    statement = new PlanStatement { Id = "s" + statements.Count, IncludeDiagnostics = includeDiagnostics, StatementId = Core(xml.GetAttribute("StatementId"), 64), QueryHash = hash, Text = text,
                        Type = type, EstimatedCost = Number(xml.GetAttribute("StatementSubTreeCost")), TextShortened = textShortened ? true : null };
                    if (textShortened) mark = omissions;
                    statements.Add(statement);
                    node = null;
                    warning = false;
                    scoped = true;
                }
                else if (name == "RelOp" && statement is not null)
                {
                    if (++count > Nodes) throw Limit();
                    node = new PlanNode { Id = statement.Id + "n" + count, ParentId = node?.Id, NodeId = Core(xml.GetAttribute("NodeId"), 64),
                        PhysicalOp = Core(xml.GetAttribute("PhysicalOp") ?? "Unknown operator", 128), LogicalOp = Core(xml.GetAttribute("LogicalOp"), 128),
                        EstimatedRows = Number(xml.GetAttribute("EstimateRows")), EstimatedCost = Number(xml.GetAttribute("EstimatedTotalSubtreeCost")) };
                    statement.Nodes.Add(node);
                    node.Diagnostics.RuntimeDetailsAvailable = includeDiagnostics;
                    if (omissions != mark) { node.IdentityShortened = true; mark = omissions; }
                    scoped = true;
                }
                else if (name == "Warnings") { warning = true; scoped = true; }
                if (scoped && !xml.IsEmptyElement) scopes.Push(previous);
                if (includeDiagnostics) diagnostics.Read(xml, statement, node);
                if (name == "MissingIndexGroup" && statement is not null) Warn(statement.Warnings, "Missing index (estimated impact " + (xml.GetAttribute("Impact") ?? "unknown") + "%)");
                if (node is not null)
                {
                    var thread = name == "RunTimeCountersPerThread" && int.TryParse(xml.GetAttribute("Thread"), NumberStyles.None, CultureInfo.InvariantCulture, out var threadId) ? threadId : (int?)null;
                    if (name == "Object")
                    {
                        var before = omissions;
                        node.Object = Core(string.Join('.', new[] { "Database", "Schema", "Table", "Index" }.Select(xml.GetAttribute).Where(value => !string.IsNullOrEmpty(value))), 512);
                        if (omissions != before) { node.IdentityShortened = true; mark += omissions - before; }
                    }
                    if (name == "RunTimeCountersPerThread")
                    {
                        // The collector aggregates all counter entries, including entries beyond the detail cap.
                        diagnostics.Runtime(xml, node, includeDiagnostics);
                    }
                    if (warning && name != "Warnings") Warn(node.Warnings, name);
                    if (xml.MoveToFirstAttribute())
                    {
                        do
                        {
                            if (xml.NamespaceURI.Length > 0) continue;
                            if (warning && name == "Warnings" && xml.Value is not ("false" or "0")) Warn(node.Warnings, xml.LocalName);
                            var key = name + (thread is null ? "" : "[Thread=" + thread.Value.ToString(CultureInfo.InvariantCulture) + "]") + "." + xml.LocalName;
                            if (node.Properties.FirstOrDefault(property => property.Name == key) is { } previousProperty)
                            { if (previousProperty.Value != xml.Value) repeated = true; continue; }
                            if (node.Properties.Count >= Properties || remaining == 0) { omissions++; continue; }
                            node.Properties.Add(new(Bound(key, 128), Bound(xml.Value)));
                        } while (xml.MoveToNextAttribute());
                        xml.MoveToElement();
                    }
                }
                else if (warning && statement is not null && name != "Warnings") Warn(statement.Warnings, name);
                if (omissions != mark)
                {
                    if (node is not null) node.DetailsShortened = true;
                    else if (statement is not null) statement.DetailsShortened = true;
                }
                if (scoped && xml.IsEmptyElement) { statement = previous.statement; node = previous.node; warning = previous.warning; }
            }
            if (!found) throw new RequestException("INVALID_PARAMS", "This document is not SQL Server Showplan XML.");
            if (includeDiagnostics) PlanDiagnostics.ApplyTextBudget(statements, (value, cap) => Bound(value, cap), token);
            var result = new PlanDocument(version, build, statements, omissions > 0 || repeated ? ["Some plan text, properties or diagnostic details were shortened to stay within the viewer's budgets. The XML source is unchanged."] : []);
            if (JsonSerializer.SerializeToUtf8Bytes(result).Length > ReplyBytes)
            {
                if (!includeDiagnostics) throw Limit();
                foreach (var entry in statements)
                {
                    entry.IncludeDiagnostics = false;
                    foreach (var operation in entry.Nodes) operation.Diagnostics.RuntimeDetailsAvailable = false;
                }
                result.Notices.Clear();
                result.Notices.Add("Some plan text, properties or diagnostics were omitted to fit the reply budget. The XML source is unchanged.");
                if (JsonSerializer.SerializeToUtf8Bytes(result).Length > ReplyBytes) throw Limit();
            }
            return result;
        }
        catch (XmlException) { throw new RequestException("INVALID_PARAMS", "The execution plan XML is invalid or exceeds the viewer's XML limit. DTDs and external entities are not allowed."); }
    }
    internal static double? Number(string? value) => double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) && double.IsFinite(number) && number >= 0 ? number : null;
}
