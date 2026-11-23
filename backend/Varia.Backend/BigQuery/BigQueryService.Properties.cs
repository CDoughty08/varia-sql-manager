using System.Diagnostics;
using System.Globalization;
using System.Text;
using Google.Apis.Bigquery.v2.Data;

namespace Varia.Backend.BigQuery;

/// <summary>
/// Properties for BigQuery's table-like objects (docs/bigquery.md, Properties): one tables.get, free, returning both the
/// legacy formatted fact groups and structured identity, storage, layout, schema, labels and free View/Materialized View SQL.
/// </summary>
internal sealed partial class BigQueryService
{
    public const int MaxFactValue = BigQueryPropertiesLimits.FactValue;
    static readonly string[] PropertyKinds = ["bqTable", "bqView", "bqMaterializedView", "bqExternalTable"];

    public async Task<BigQueryProperties> PropertiesAsync(BigQueryPropertiesArgs args, CancellationToken token)
    {
        if (!Guid.TryParse(args.RequestId, out _) || !PropertyKinds.Contains(args.Kind) || !BqNames.IsProject(args.Project) || !BqNames.IsDataset(args.Dataset) || !BqNames.IsTable(args.Name))
            throw new RequestException("INVALID_PARAMS", "The object is invalid.");
        var connection = Find(args.ConnectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        var watch = Stopwatch.StartNew();
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(PreConnectLimit);
        try
        {
            var table = await MetadataAsync(connection, t => connection.Client.Service.Tables.Get(args.Project, args.Dataset, args.Name).ExecuteAsync(t), budget.Token);
            return MapTable(table, args.Name, args.Project + "." + args.Dataset + "." + args.Name, watch.ElapsedMilliseconds);
        }
        catch (Exception error) when (error is not RequestException { Code: "INVALID_PARAMS" }) { throw BigQueryErrors.Map(error, args.Project, "bigquery.tables.get", token: token); }
    }

    internal static (string Type, List<BigQueryFactGroup> Groups) Facts(Table table, string fullName)
    {
        var mapped = MapTable(table, table.TableReference?.TableId ?? fullName, fullName, 0);
        return (mapped.Type, mapped.Groups);
    }

    internal static BigQueryProperties MapTable(Table table, string name, string fullName, long elapsedMs)
    {
        var type = table.Type switch
        {
            null or "" => "table",
            "EXTERNAL" => "external table",
            "TABLE" when table.CloneDefinition is not null => "clone",
            var other => Clip(other, BigQueryPropertiesLimits.Type).Replace('_', ' ').ToLowerInvariant()
        };
        var clippedName = Clip(name, BigQueryPropertiesLimits.Name);
        var clippedFullName = string.IsNullOrEmpty(fullName) ? null : Clip(fullName, BigQueryPropertiesLimits.FullName);
        var location = string.IsNullOrEmpty(table.Location) ? null : Clip(table.Location, BigQueryPropertiesLimits.Location);
        var description = string.IsNullOrEmpty(table.Description) ? null : Clip(table.Description, BigQueryPropertiesLimits.FactValue);
        var baseTable = Path(table.SnapshotDefinition?.BaseTableReference) ?? Path(table.CloneDefinition?.BaseTableReference);
        var labels = MapLabels(table.Labels);

        var rows = SafeCount(table.NumRows);
        var logicalBytes = SafeCount(table.NumBytes);
        var longTermLogicalBytes = SafeCount(table.NumLongTermBytes);
        var physicalBytes = SafeCount(table.NumTotalPhysicalBytes);
        BigQueryStorageInfo? storage = rows is not null || logicalBytes is not null || longTermLogicalBytes is not null || physicalBytes is not null
            ? new(rows, logicalBytes, longTermLogicalBytes, physicalBytes)
            : null;

        var partitioning = FormatPartitioning(table);
        var clustering = MapClustering(table.Clustering?.Fields);
        BigQueryLayoutInfo? layout = partitioning is not null || table.RequirePartitionFilter is not null || clustering is not null
            ? new(partitioning, table.RequirePartitionFilter, clustering)
            : null;

        var createdUtc = Time(table.CreationTime);
        var modifiedUtc = Time(table.LastModifiedTime);
        var expiresUtc = Time(table.ExpirationTime);
        var snapshotTimeUtc = SnapshotTime(table.SnapshotDefinition);

        var (columns, columnsTruncated) = MapColumns(table.Schema?.Fields);
        var (definition, definitionTruncated) = MapDefinition(table);

        var groups = new List<BigQueryFactGroup>();
        void Group(string title, params (string Label, string? Value)[] facts)
        {
            var kept = facts.Where(fact => !string.IsNullOrEmpty(fact.Value)).Select(fact => new BigQueryFact(fact.Label, Clip(fact.Value!, MaxFactValue))).ToList();
            if (kept.Count > 0) groups.Add(new(title, kept));
        }
        Group("Table",
            ("Full name", clippedFullName),
            ("Type", type),
            ("Location", location),
            ("Description", description),
            ("Labels", labels is { Count: > 0 } ? string.Join(", ", labels.Select(item => item.Key + ": " + item.Value)) : null),
            ("Base table", baseTable));
        Group("Storage",
            ("Rows", table.NumRows is { } rawRows ? rawRows.ToString("N0", CultureInfo.InvariantCulture) : null),
            ("Logical size", table.NumBytes is >= 0 and var bytes ? BigQueryCost.Bytes(bytes) : null),
            ("Long-term logical size", table.NumLongTermBytes is >= 0 and var longTerm ? BigQueryCost.Bytes(longTerm) : null),
            ("Physical size", table.NumTotalPhysicalBytes is >= 0 and var physical ? BigQueryCost.Bytes(physical) : null));
        Group("Layout",
            ("Partitioning", partitioning),
            ("Require partition filter", table.RequirePartitionFilter == true ? "yes" : null),
            ("Clustering", clustering is { Count: > 0 } ? string.Join(", ", clustering) : null),
            ("Columns", table.Schema?.Fields is { Count: > 0 } rawColumns ? rawColumns.Count.ToString("N0", CultureInfo.InvariantCulture) : null));
        Group("History",
            ("Created", createdUtc),
            ("Last modified", modifiedUtc),
            ("Expires", expiresUtc),
            ("Snapshot taken", snapshotTimeUtc));

        return new(
            clippedName,
            type,
            groups,
            Math.Clamp(elapsedMs, 0, BigQueryLimits.MaxSafeInteger),
            clippedFullName,
            location,
            description,
            baseTable,
            createdUtc,
            modifiedUtc,
            expiresUtc,
            snapshotTimeUtc,
            storage,
            layout,
            columns,
            columnsTruncated,
            labels,
            definition,
            definitionTruncated);
    }

    static string? FormatPartitioning(Table table)
    {
        if (table.TimePartitioning is { } time)
        {
            var kind = string.IsNullOrEmpty(time.Type) ? "DAY" : time.Type;
            var field = string.IsNullOrEmpty(time.Field) ? "_PARTITIONTIME" : time.Field;
            var expiry = time.ExpirationMs is > 0 and var ms ? ", partitions expire after " + Days(ms) : "";
            return Clip(kind + " on " + field + expiry, BigQueryPropertiesLimits.Partitioning);
        }
        if (table.RangePartitioning is { } range)
            return Clip(string.IsNullOrEmpty(range.Field) ? "integer range" : "integer range on " + range.Field, BigQueryPropertiesLimits.Partitioning);
        return null;
    }

    static List<string>? MapClustering(IList<string>? fields)
    {
        if (fields is not { Count: > 0 }) return null;
        var kept = new List<string>(Math.Min(fields.Count, BigQueryPropertiesLimits.ClusteringFields));
        foreach (var field in fields)
        {
            if (string.IsNullOrEmpty(field)) continue;
            kept.Add(Clip(field, BigQueryPropertiesLimits.ColumnName));
            if (kept.Count >= BigQueryPropertiesLimits.ClusteringFields) break;
        }
        return kept.Count > 0 ? kept : null;
    }

    static List<BigQueryLabel>? MapLabels(IDictionary<string, string>? labels)
    {
        if (labels is not { Count: > 0 }) return null;
        var kept = new List<BigQueryLabel>(Math.Min(labels.Count, BigQueryPropertiesLimits.Labels));
        foreach (var item in labels.OrderBy(entry => entry.Key, StringComparer.Ordinal))
        {
            if (string.IsNullOrEmpty(item.Key)) continue;
            kept.Add(new(Clip(item.Key, BigQueryPropertiesLimits.LabelKey), Clip(item.Value ?? "", BigQueryPropertiesLimits.LabelValue)));
            if (kept.Count >= BigQueryPropertiesLimits.Labels) break;
        }
        return kept.Count > 0 ? kept : null;
    }

    static (List<BigQuerySchemaField>? Columns, bool? Truncated) MapColumns(IList<TableFieldSchema>? fields)
    {
        if (fields is not { Count: > 0 }) return (null, null);
        var total = 0;
        var visited = 0;
        var textBytes = 0;
        var truncated = false;
        var budgetExhausted = false;
        const int MaxVisited = BigQueryPropertiesLimits.ColumnFields * 4;

        List<BigQuerySchemaField>? MapLevel(IList<TableFieldSchema>? source, int depth)
        {
            if (source is not { Count: > 0 } || budgetExhausted) return null;
            var mapped = new List<BigQuerySchemaField>(Math.Min(source.Count, BigQueryPropertiesLimits.ColumnFields - total));
            foreach (var field in source)
            {
                if (budgetExhausted) break;
                if (++visited > MaxVisited) { truncated = budgetExhausted = true; break; }
                if (field is null || string.IsNullOrEmpty(field.Name)) continue;
                if (total >= BigQueryPropertiesLimits.ColumnFields) { truncated = budgetExhausted = true; break; }

                var name = Clip(field.Name, BigQueryPropertiesLimits.ColumnName);
                var type = FieldType(field);
                var mode = string.IsNullOrEmpty(field.Mode) ? null : Clip(field.Mode, BigQueryPropertiesLimits.ColumnMode).ToUpperInvariant();
                var description = string.IsNullOrEmpty(field.Description) ? null : Clip(field.Description, BigQueryPropertiesLimits.ColumnDescription);
                var fieldBytes = 64 + Encoding.UTF8.GetByteCount(name) + Encoding.UTF8.GetByteCount(type)
                    + (mode is null ? 0 : Encoding.UTF8.GetByteCount(mode))
                    + (description is null ? 0 : Encoding.UTF8.GetByteCount(description));
                if (textBytes + fieldBytes > BigQueryPropertiesLimits.ColumnsTextBytes) { truncated = budgetExhausted = true; break; }

                total++;
                textBytes += fieldBytes;

                List<BigQuerySchemaField>? children = null;
                if (field.Fields is { Count: > 0 })
                {
                    if (depth >= BigQueryPropertiesLimits.ColumnDepth) truncated = true;
                    else children = MapLevel(field.Fields, depth + 1);
                }

                mapped.Add(new(name, type, mode, description, children));
            }
            return mapped.Count > 0 ? mapped : null;
        }

        var root = MapLevel(fields, 1);
        return (root, truncated ? true : null);
    }

    static string FieldType(TableFieldSchema field)
    {
        var raw = string.IsNullOrEmpty(field.Type) ? "?" : Clip(field.Type, BigQueryPropertiesLimits.ColumnType).ToUpperInvariant();
        var type = raw switch
        {
            "RECORD" => "STRUCT",
            "INTEGER" => "INT64",
            "FLOAT" => "FLOAT64",
            "BOOLEAN" => "BOOL",
            "DECIMAL" => "NUMERIC",
            "BIGDECIMAL" => "BIGNUMERIC",
            var other => other
        };
        if (field.MaxLength is > 0 and var length && type is "STRING" or "BYTES")
            type += "(" + length.ToString(CultureInfo.InvariantCulture) + ")";
        else if (field.Precision is > 0 and var precision && type is "NUMERIC" or "BIGNUMERIC")
            type += "(" + precision.ToString(CultureInfo.InvariantCulture) + (field.Scale is >= 0 and var scale ? ", " + scale.ToString(CultureInfo.InvariantCulture) : "") + ")";
        else if (type == "RANGE" && field.RangeElementType?.Type is { Length: > 0 } element)
            type += "<" + Clip(element, BigQueryPropertiesLimits.ColumnType).ToUpperInvariant() + ">";
        return Clip(type, BigQueryPropertiesLimits.ColumnType);
    }

    static (string? Definition, bool? Truncated) MapDefinition(Table table)
    {
        var query = table.Type switch
        {
            "VIEW" => table.View?.Query,
            "MATERIALIZED_VIEW" => table.MaterializedView?.Query,
            _ => null
        };
        if (string.IsNullOrWhiteSpace(query)) return (null, null);
        if (query.Length <= BigQueryPropertiesLimits.DefinitionChars) return (query, null);
        return (Clip(query, BigQueryPropertiesLimits.DefinitionChars, ellipsis: false), true);
    }

    static long? SafeCount(ulong? value) => value is { } number ? (long)Math.Min(number, (ulong)BigQueryLimits.MaxSafeInteger) : null;
    static long? SafeCount(long? value) => value is >= 0 and var number ? Math.Min(number, BigQueryLimits.MaxSafeInteger) : null;
    static string? Path(TableReference? reference) =>
        reference is { ProjectId.Length: > 0, DatasetId.Length: > 0, TableId.Length: > 0 }
            ? Clip(reference.ProjectId + "." + reference.DatasetId + "." + reference.TableId, BigQueryPropertiesLimits.FullName)
            : null;
    static string Days(long ms) => (ms / 86_400_000d).ToString("0.##", CultureInfo.InvariantCulture) + " days";
    static string? Time(long? ms) => ms is > 0 and < 253_402_300_800_000 ? DateTimeOffset.FromUnixTimeMilliseconds(ms.Value).UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss 'UTC'", CultureInfo.InvariantCulture) : null;
    static string? Time(ulong? ms) => ms is > 0 and < 253_402_300_800_000UL ? Time((long)ms.Value) : null;
    static string? SnapshotTime(SnapshotDefinition? snapshot) =>
        snapshot?.SnapshotTimeRaw is { Length: > 0 } raw
        && DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed)
            ? parsed.UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss 'UTC'", CultureInfo.InvariantCulture)
            : null;

    /// <summary>Clips <paramref name="text"/> to at most <paramref name="max"/> UTF-16 code units without splitting a surrogate pair.</summary>
    internal static string Clip(string text, int max, bool ellipsis = true)
    {
        if (max <= 0) return "";
        if (text.Length <= max) return text;
        var cut = ellipsis ? max - 1 : max;
        if (cut <= 0) return ellipsis ? "…" : "";
        if (char.IsHighSurrogate(text[cut - 1])) cut--;
        return ellipsis ? text[..cut] + "…" : text[..cut];
    }
}
