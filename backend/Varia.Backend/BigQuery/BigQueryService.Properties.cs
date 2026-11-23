using System.Diagnostics;
using System.Globalization;
using Google.Apis.Bigquery.v2.Data;

namespace Varia.Backend.BigQuery;

/// <summary>
/// Properties for BigQuery's table-like objects (docs/bigquery.md, Properties): one tables.get, free, as read-only facts in four
/// groups, with a view's text and the columns and their descriptions (Search Objects' details pane shows them). A routine, which
/// only the details pane asks for, is one routines.get. Values are formatted here (sizes in binary units, times in UTC) so the
/// document only lays them out.
/// </summary>
internal sealed partial class BigQueryService
{
    public const int MaxFactValue = 2000;
    /// <summary>The longest view text or routine body returned (the details pane shows this much: SearchDetails' shownChars).</summary>
    public const int MaxDefinition = 1_000_000;
    /// <summary>Columns and nested fields returned at most.</summary>
    public const int MaxColumnFacts = 1000;
    /// <summary>The longest column type text or description returned.</summary>
    public const int MaxColumnText = 1024;
    static readonly string[] PropertyKinds = ["bqTable", "bqView", "bqMaterializedView", "bqExternalTable", "bqRoutine"];

    public async Task<BigQueryProperties> PropertiesAsync(BigQueryPropertiesArgs args, CancellationToken token)
    {
        var routine = args.Kind == "bqRoutine";
        if (!Guid.TryParse(args.RequestId, out _) || !PropertyKinds.Contains(args.Kind) || !BqNames.IsProject(args.Project) || !BqNames.IsDataset(args.Dataset)
            || !(routine ? BqNames.IsRoutine(args.Name) : BqNames.IsTable(args.Name)))
            throw new RequestException("INVALID_PARAMS", "The object is invalid.");
        var connection = Find(args.ConnectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        var watch = Stopwatch.StartNew();
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(PreConnectLimit);
        try
        {
            var fullName = args.Project + "." + args.Dataset + "." + args.Name;
            if (routine)
            {
                var found = await MetadataAsync(connection, t => connection.Client.Service.Routines.Get(args.Project, args.Dataset, args.Name).ExecuteAsync(t), budget.Token);
                var (kind, facts) = RoutineFacts(found, fullName);
                var (body, bodyCut) = Definition(found.DefinitionBody);
                return new(args.Name, kind, facts, watch.ElapsedMilliseconds, body, bodyCut);
            }
            var table = await MetadataAsync(connection, t => connection.Client.Service.Tables.Get(args.Project, args.Dataset, args.Name).ExecuteAsync(t), budget.Token);
            var (type, groups) = Facts(table, fullName);
            var (text, cut) = Definition(table.View?.Query ?? table.MaterializedView?.Query);
            var (columns, columnsCut) = ColumnFacts(table);
            return new(args.Name, type, groups, watch.ElapsedMilliseconds, text, cut, columns, columnsCut);
        }
        catch (Exception error) when (error is not RequestException { Code: "INVALID_PARAMS" }) { throw BigQueryErrors.Map(error, args.Project, routine ? "bigquery.routines.get" : "bigquery.tables.get", token: token); }
    }

    static (string? Text, bool? Cut) Definition(string? text) => text is null ? (null, null) : text.Length <= MaxDefinition ? (text, null)
        : (text[..(char.IsHighSurrogate(text[MaxDefinition - 1]) ? MaxDefinition - 1 : MaxDefinition)], true);

    /// <summary>The columns and nested fields as the index flattens them (Search.BigQueryEntries.FromTable): path, type and description.</summary>
    internal static (List<BigQueryColumnFact>? Columns, bool? Cut) ColumnFacts(Table table)
    {
        var detail = Search.BigQueryEntries.FromTable(table);
        var columns = detail.Columns;
        if (columns.Count == 0) return (null, null);
        static string Bound(string text) => text.Length <= MaxColumnText ? text : text[..(MaxColumnText - 1)] + "…";
        var kept = columns.Take(MaxColumnFacts).Select(column => new BigQueryColumnFact(column.Path, Bound(column.Type), column.Description is { Length: > 0 } description ? Bound(description) : null)).ToList();
        return (kept, columns.Count > MaxColumnFacts || detail.ColumnsCut ? true : null);
    }

    /// <summary>A routine's facts: Routine (full name, type, language, signature, description) and History.</summary>
    internal static (string Type, List<BigQueryFactGroup> Groups) RoutineFacts(Routine routine, string fullName)
    {
        var type = routine.RoutineType switch
        {
            "PROCEDURE" => "procedure", "TABLE_VALUED_FUNCTION" => "table function", "AGGREGATE_FUNCTION" => "aggregate function", _ => "function"
        };
        var groups = new List<BigQueryFactGroup>();
        void Group(string title, params (string Label, string? Value)[] facts)
        {
            var kept = facts.Where(fact => !string.IsNullOrEmpty(fact.Value)).Select(fact => new BigQueryFact(fact.Label, Clip(fact.Value!))).ToList();
            if (kept.Count > 0) groups.Add(new(title, kept));
        }
        Group("Routine",
            ("Full name", fullName),
            ("Type", type),
            ("Language", routine.Language is { Length: > 0 } language ? language.ToUpperInvariant() switch { "SQL" => "SQL", "JAVASCRIPT" => "JavaScript", "PYTHON" => "Python", "JAVA" => "Java", "SCALA" => "Scala", _ => language } : null),
            ("Signature", Search.BigQueryEntries.FromRoutine(routine).Signature),
            ("Description", routine.Description));
        Group("History",
            ("Created", Time(routine.CreationTime)),
            ("Last modified", Time(routine.LastModifiedTime)));
        return (type, groups);
    }

    internal static (string Type, List<BigQueryFactGroup> Groups) Facts(Table table, string fullName)
    {
        var type = table.Type switch { null => "table", "EXTERNAL" => "external table", var other => other.Replace('_', ' ').ToLowerInvariant() };
        if (table.Type == "TABLE" && table.CloneDefinition is not null) type = "clone";
        var groups = new List<BigQueryFactGroup>();
        void Group(string title, params (string Label, string? Value)[] facts)
        {
            var kept = facts.Where(fact => !string.IsNullOrEmpty(fact.Value)).Select(fact => new BigQueryFact(fact.Label, Clip(fact.Value!))).ToList();
            if (kept.Count > 0) groups.Add(new(title, kept));
        }
        Group("Table",
            ("Full name", fullName),
            ("Type", type),
            ("Location", table.Location),
            ("Description", table.Description),
            ("Labels", table.Labels is { Count: > 0 } labels ? string.Join(", ", labels.OrderBy(item => item.Key, StringComparer.Ordinal).Select(item => item.Key + ": " + item.Value)) : null),
            ("Base table", table.SnapshotDefinition?.BaseTableReference is { } snapshot ? Path(snapshot) : table.CloneDefinition?.BaseTableReference is { } clone ? Path(clone) : null));
        Group("Storage",
            ("Rows", table.NumRows is { } rows ? rows.ToString("N0", CultureInfo.InvariantCulture) : null),
            ("Logical size", table.NumBytes is { } bytes ? BigQueryCost.Bytes((long)bytes) : null),
            ("Long-term logical size", table.NumLongTermBytes is { } longTerm ? BigQueryCost.Bytes((long)longTerm) : null),
            ("Physical size", table.NumTotalPhysicalBytes is { } physical ? BigQueryCost.Bytes((long)physical) : null));
        Group("Layout",
            ("Partitioning", table.TimePartitioning is { } time ? (time.Type ?? "DAY") + " on " + (time.Field ?? "_PARTITIONTIME") + (time.ExpirationMs is { } ms ? ", partitions expire after " + Days(ms) : "")
                : table.RangePartitioning is { } range ? "integer range on " + range.Field : null),
            ("Require partition filter", table.RequirePartitionFilter == true ? "yes" : null),
            ("Clustering", table.Clustering?.Fields is { Count: > 0 } fields ? string.Join(", ", fields) : null),
            ("Columns", table.Schema?.Fields is { Count: > 0 } columns ? columns.Count.ToString("N0", CultureInfo.InvariantCulture) : null));
        Group("History",
            ("Created", Time(table.CreationTime)),
            ("Last modified", Time((long?)table.LastModifiedTime)),
            ("Expires", Time(table.ExpirationTime)),
            ("Snapshot taken", table.SnapshotDefinition?.SnapshotTimeDateTimeOffset?.UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss 'UTC'", CultureInfo.InvariantCulture)));
        return (type, groups);
    }

    static string Path(TableReference reference) => reference.ProjectId + "." + reference.DatasetId + "." + reference.TableId;
    static string Days(long ms) => (ms / 86_400_000d).ToString("0.##", CultureInfo.InvariantCulture) + " days";
    static string? Time(long? ms) => ms is > 0 and < 253_402_300_800_000 ? DateTimeOffset.FromUnixTimeMilliseconds(ms.Value).UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss 'UTC'", CultureInfo.InvariantCulture) : null;
    static string Clip(string text) => text.Length <= MaxFactValue ? text : text[..(MaxFactValue - 1)] + "…";
}
