using System.Diagnostics;
using System.Globalization;
using Google.Apis.Bigquery.v2.Data;

namespace Varia.Backend.BigQuery;

/// <summary>
/// Properties for BigQuery's table-like objects (docs/bigquery.md, Properties): one tables.get, free, as read-only facts in four
/// groups. Values are formatted here (sizes in binary units, times in UTC) so the document only lays them out.
/// </summary>
internal sealed partial class BigQueryService
{
    public const int MaxFactValue = 2000;
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
            var (type, groups) = Facts(table, args.Project + "." + args.Dataset + "." + args.Name);
            return new(args.Name, type, groups, watch.ElapsedMilliseconds);
        }
        catch (Exception error) when (error is not RequestException { Code: "INVALID_PARAMS" }) { throw BigQueryErrors.Map(error, args.Project, "bigquery.tables.get", token: token); }
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
