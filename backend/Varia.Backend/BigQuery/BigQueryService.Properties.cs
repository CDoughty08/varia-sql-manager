using System.Diagnostics;
using System.Globalization;
using System.Text;
using Google.Apis.Bigquery.v2.Data;

namespace Varia.Backend.BigQuery;

/// <summary>
/// Properties for BigQuery's table-like objects (docs/bigquery.md, Properties): one tables.get, free, returning formatted
/// fact groups, Search Objects' flat column facts and definition, and structured identity, storage, layout, nested schema,
/// labels and free View/Materialized View SQL. A routine, which Search Objects' details pane asks for, is one routines.get.
/// </summary>
internal sealed partial class BigQueryService
{
    public const int MaxFactValue = BigQueryPropertiesLimits.FactValue;
    /// <summary>The longest view text or routine body returned (the details pane shows this much: SearchDetails' shownChars).</summary>
    public const int MaxDefinition = BigQueryPropertiesLimits.DefinitionChars;
    /// <summary>Columns and nested fields returned at most in the flat details-pane list.</summary>
    public const int MaxColumnFacts = 1000;
    /// <summary>The longest flat column type text or description returned.</summary>
    public const int MaxColumnText = 1024;
    /// <summary>Characters of flat column paths, types and descriptions returned in all, keeping the response well under the frame limit.</summary>
    public const int MaxColumnChars = 1_000_000;
    /// <summary>The Search Objects index, told of each object's details read here so it holds them (docs/object-search.md, Freshness).</summary>
    internal Search.ObjectSearchService? ObjectDetails { get; set; }
    static readonly string[] PropertyKinds = ["bqTable", "bqView", "bqMaterializedView", "bqExternalTable", "bqRoutine", "bqDataset"];

    public async Task<BigQueryProperties> PropertiesAsync(BigQueryPropertiesArgs args, CancellationToken token)
    {
        var routine = args.Kind == "bqRoutine";
        var dataset = args.Kind == "bqDataset";
        var validName = dataset
            ? args.Name == args.Dataset
            : routine
                ? BqNames.IsRoutine(args.Name)
                : BqNames.IsTable(args.Name);
        if (!Guid.TryParse(args.RequestId, out _) || !PropertyKinds.Contains(args.Kind) || !BqNames.IsProject(args.Project) || !BqNames.IsDataset(args.Dataset) || !validName)
            throw new RequestException("INVALID_PARAMS", "The object is invalid.");
        var connection = Find(args.ConnectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        var watch = Stopwatch.StartNew();
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(PreConnectLimit);
        try
        {
            if (dataset)
            {
                var found = await MetadataAsync(connection, BqMethod.DatasetsGet, t => connection.Client.Service.Datasets.Get(args.Project, args.Dataset).ExecuteAsync(t), budget.Token);
                return MapDataset(found, args.Dataset, args.Project + "." + args.Dataset, watch.ElapsedMilliseconds);
            }
            var fullName = args.Project + "." + args.Dataset + "." + args.Name;
            if (routine)
            {
                var found = await MetadataAsync(connection, BqMethod.RoutinesGet, t => connection.Client.Service.Routines.Get(args.Project, args.Dataset, args.Name).ExecuteAsync(t), budget.Token);
                ObjectDetails?.RoutineRead(args.ConnectionId, args.Project, args.Dataset, args.Name, found);
                return MapRoutine(found, args.Name, fullName, watch.ElapsedMilliseconds);
            }
            var table = await MetadataAsync(connection, BqMethod.TablesGet, t => connection.Client.Service.Tables.Get(args.Project, args.Dataset, args.Name).ExecuteAsync(t), budget.Token);
            ObjectDetails?.TableRead(args.ConnectionId, args.Project, args.Dataset, args.Name, table);
            return MapTable(table, args.Name, fullName, watch.ElapsedMilliseconds);
        }
        catch (Exception error) when (error is not RequestException { Code: "INVALID_PARAMS" })
        {
            var permission = dataset ? "bigquery.datasets.get" : routine ? "bigquery.routines.get" : "bigquery.tables.get";
            throw BigQueryErrors.Map(error, args.Project, permission, token: token);
        }
    }

    static (string? Text, bool? Cut) Definition(string? text) => string.IsNullOrWhiteSpace(text) ? (null, null) : text.Length <= MaxDefinition ? (text, null)
        : (text[..(char.IsHighSurrogate(text[MaxDefinition - 1]) ? MaxDefinition - 1 : MaxDefinition)], true);

    /// <summary>The columns and nested fields as the index flattens them (Search.BigQueryEntries.FromTable): path, type and description.</summary>
    internal static (List<BigQueryColumnFact>? Columns, bool? Cut) ColumnFacts(Table table)
    {
        var detail = Search.BigQueryEntries.FromTable(table);
        var columns = detail.Columns;
        if (columns.Count == 0) return (null, null);
        static string Bound(string text) => text.Length <= MaxColumnText ? text : text[..(char.IsHighSurrogate(text[MaxColumnText - 2]) ? MaxColumnText - 2 : MaxColumnText - 1)] + "…";
        var kept = new List<BigQueryColumnFact>();
        long chars = 0;
        foreach (var column in columns.Take(MaxColumnFacts))
        {
            var fact = new BigQueryColumnFact(column.Path, Bound(column.Type), column.Description is { Length: > 0 } description ? Bound(description) : null);
            chars += fact.Name.Length + fact.Type.Length + (fact.Description?.Length ?? 0);
            if (chars > MaxColumnChars) break;
            kept.Add(fact);
        }
        return (kept, kept.Count < columns.Count || detail.ColumnsCut ? true : null);
    }

    /// <summary>A routine's facts: Routine (full name, type, language, determinism, signature, description) and History.</summary>
    internal static (string Type, List<BigQueryFactGroup> Groups) RoutineFacts(Routine routine, string fullName)
    {
        var mapped = MapRoutine(routine, routine.RoutineReference?.RoutineId ?? fullName, fullName, 0);
        return (mapped.Type, mapped.Groups);
    }

    internal static BigQueryProperties MapRoutine(Routine routine, string name, string fullName, long elapsedMs)
    {
        var type = routine.RoutineType switch
        {
            "PROCEDURE" => "procedure",
            "TABLE_VALUED_FUNCTION" => "table function",
            "AGGREGATE_FUNCTION" => "aggregate function",
            _ => "function"
        };
        var clippedName = Clip(name, BigQueryPropertiesLimits.Name);
        var clippedFullName = string.IsNullOrEmpty(fullName) ? null : Clip(fullName, BigQueryPropertiesLimits.FullName);
        var description = string.IsNullOrEmpty(routine.Description) ? null : Clip(routine.Description, BigQueryPropertiesLimits.FactValue);
        var routineType = string.IsNullOrEmpty(routine.RoutineType) ? null : Clip(routine.RoutineType.ToUpperInvariant(), BigQueryPropertiesLimits.Type);
        var language = FormatRoutineLanguage(routine.Language);
        var determinism = FormatDeterminism(routine.DeterminismLevel);
        var returnType = FormatRoutineReturnType(routine);
        var rawSignature = Search.BigQueryEntries.FromRoutine(routine).Signature;
        var signature = string.IsNullOrEmpty(rawSignature) ? null : Clip(rawSignature, BigQueryPropertiesLimits.FactValue);
        var (arguments, argumentsTruncated) = MapRoutineArguments(routine.Arguments);
        var createdUtc = Time(routine.CreationTime);
        var modifiedUtc = Time(routine.LastModifiedTime);
        var (body, bodyCut) = Definition(routine.DefinitionBody);

        var groups = new List<BigQueryFactGroup>();
        void Group(string title, params (string Label, string? Value)[] facts)
        {
            var kept = facts.Where(fact => !string.IsNullOrEmpty(fact.Value)).Select(fact => new BigQueryFact(fact.Label, Clip(fact.Value!, MaxFactValue))).ToList();
            if (kept.Count > 0) groups.Add(new(title, kept));
        }
        Group("Routine",
            ("Full name", clippedFullName),
            ("Type", type),
            ("Language", language),
            ("Determinism", determinism),
            ("Return type", returnType),
            ("Signature", signature),
            ("Description", description));
        Group("History",
            ("Created", createdUtc),
            ("Last modified", modifiedUtc));

        BigQueryRoutineInfo? routineInfo = routineType is not null || language is not null || determinism is not null || returnType is not null || signature is not null || arguments is not null
            ? new(routineType, language, determinism, returnType, signature, arguments, argumentsTruncated)
            : null;

        return new(
            clippedName,
            type,
            groups,
            Math.Clamp(elapsedMs, 0, BigQueryLimits.MaxSafeInteger),
            Definition: body,
            DefinitionCut: bodyCut,
            FullName: clippedFullName,
            Description: description,
            CreatedUtc: createdUtc,
            ModifiedUtc: modifiedUtc,
            DefinitionTruncated: bodyCut,
            Routine: routineInfo);
    }

    internal static BigQueryProperties MapDataset(Dataset dataset, string name, string fullName, long elapsedMs)
    {
        var type = dataset.Type switch
        {
            null or "" or "DEFAULT" => "dataset",
            var other => Clip(other, BigQueryPropertiesLimits.Type).Replace('_', ' ').ToLowerInvariant()
        };
        var clippedName = Clip(name, BigQueryPropertiesLimits.Name);
        var clippedFullName = string.IsNullOrEmpty(fullName) ? null : Clip(fullName, BigQueryPropertiesLimits.FullName);
        var location = string.IsNullOrEmpty(dataset.Location) ? null : Clip(dataset.Location, BigQueryPropertiesLimits.Location);
        var description = string.IsNullOrEmpty(dataset.Description) ? null : Clip(dataset.Description, BigQueryPropertiesLimits.FactValue);
        var labels = MapLabels(dataset.Labels);
        var createdUtc = Time(dataset.CreationTime);
        var modifiedUtc = Time(dataset.LastModifiedTime);

        var friendlyName = string.IsNullOrEmpty(dataset.FriendlyName) ? null : Clip(dataset.FriendlyName, BigQueryPropertiesLimits.Name);
        var defaultTableExpirationMs = dataset.DefaultTableExpirationMs is > 0 ? SafeCount(dataset.DefaultTableExpirationMs) : null;
        var defaultPartitionExpirationMs = dataset.DefaultPartitionExpirationMs is > 0 ? SafeCount(dataset.DefaultPartitionExpirationMs) : null;
        var kmsKeyName = string.IsNullOrEmpty(dataset.DefaultEncryptionConfiguration?.KmsKeyName)
            ? null
            : Clip(dataset.DefaultEncryptionConfiguration.KmsKeyName, BigQueryPropertiesLimits.KmsKeyName);
        var defaultCollation = string.IsNullOrEmpty(dataset.DefaultCollation) ? null : Clip(dataset.DefaultCollation, BigQueryPropertiesLimits.Type);
        var isCaseInsensitive = dataset.IsCaseInsensitive;
        var maxTimeTravelHours = dataset.MaxTimeTravelHours is > 0 ? SafeCount(dataset.MaxTimeTravelHours) : null;
        var storageBillingModel = string.IsNullOrEmpty(dataset.StorageBillingModel)
            ? null
            : Clip(dataset.StorageBillingModel.ToUpperInvariant(), BigQueryPropertiesLimits.Type);

        BigQueryDatasetInfo? datasetInfo = friendlyName is not null || defaultTableExpirationMs is not null || defaultPartitionExpirationMs is not null
            || kmsKeyName is not null || defaultCollation is not null || isCaseInsensitive is not null
            || maxTimeTravelHours is not null || storageBillingModel is not null
            ? new(friendlyName, defaultTableExpirationMs, defaultPartitionExpirationMs, kmsKeyName, defaultCollation, isCaseInsensitive, maxTimeTravelHours, storageBillingModel)
            : null;

        var groups = new List<BigQueryFactGroup>();
        void Group(string title, params (string Label, string? Value)[] facts)
        {
            var kept = facts.Where(fact => !string.IsNullOrEmpty(fact.Value)).Select(fact => new BigQueryFact(fact.Label, Clip(fact.Value!, MaxFactValue))).ToList();
            if (kept.Count > 0) groups.Add(new(title, kept));
        }
        Group("Dataset",
            ("Full name", clippedFullName),
            ("Location", location),
            ("Friendly name", friendlyName),
            ("Description", description),
            ("Default table expiration", defaultTableExpirationMs is { } tableExp ? Days(tableExp) : null),
            ("Default partition expiration", defaultPartitionExpirationMs is { } partExp ? Days(partExp) : null),
            ("Encryption (KMS)", kmsKeyName),
            ("Default collation", defaultCollation),
            ("Case-insensitive", isCaseInsensitive == true ? "yes" : null),
            ("Time travel window", maxTimeTravelHours is { } hours ? hours.ToString("N0", CultureInfo.InvariantCulture) + " hours" : null),
            ("Storage billing model", storageBillingModel),
            ("Labels", labels is { Count: > 0 } ? string.Join(", ", labels.Select(item => item.Key + ": " + item.Value)) : null));
        Group("History",
            ("Created", createdUtc),
            ("Last modified", modifiedUtc));

        return new(
            clippedName,
            type,
            groups,
            Math.Clamp(elapsedMs, 0, BigQueryLimits.MaxSafeInteger),
            FullName: clippedFullName,
            Location: location,
            Description: description,
            CreatedUtc: createdUtc,
            ModifiedUtc: modifiedUtc,
            Labels: labels,
            Dataset: datasetInfo);
    }

    static string? FormatRoutineLanguage(string? language) => language is { Length: > 0 }
        ? Clip(language.ToUpperInvariant() switch { "SQL" => "SQL", "JAVASCRIPT" => "JavaScript", "PYTHON" => "Python", "JAVA" => "Java", "SCALA" => "Scala", _ => language }, BigQueryPropertiesLimits.Type)
        : null;

    static string? FormatDeterminism(string? level) => level is { Length: > 0 } && !string.Equals(level, "DETERMINISM_LEVEL_UNSPECIFIED", StringComparison.OrdinalIgnoreCase)
        ? Clip(level.ToUpperInvariant(), BigQueryPropertiesLimits.Type)
        : null;

    static string? FormatRoutineReturnType(Routine routine)
    {
        if (routine.ReturnType is { } scalar)
            return Clip(FormatStandardSqlType(scalar, 0), BigQueryPropertiesLimits.RoutineTypeText);
        if (routine.ReturnTableType is { } table)
        {
            if (table.Columns is { Count: > 0 } cols)
            {
                var parts = new List<string>(Math.Min(cols.Count, BigQueryPropertiesLimits.RoutineArguments));
                foreach (var col in cols.Take(BigQueryPropertiesLimits.RoutineArguments))
                {
                    if (col is null) continue;
                    var colType = col.Type is { } t ? FormatStandardSqlType(t, 0) : "?";
                    parts.Add(string.IsNullOrEmpty(col.Name) ? colType : col.Name + " " + colType);
                }
                return Clip("TABLE<" + string.Join(", ", parts) + ">", BigQueryPropertiesLimits.RoutineTypeText);
            }
            return "TABLE";
        }
        return null;
    }

    static (List<BigQueryRoutineArgument>? Arguments, bool? Truncated) MapRoutineArguments(IList<Argument>? arguments)
    {
        if (arguments is not { Count: > 0 }) return (null, null);
        var kept = new List<BigQueryRoutineArgument>(Math.Min(arguments.Count, BigQueryPropertiesLimits.RoutineArguments));
        var truncated = false;
        foreach (var argument in arguments)
        {
            if (argument is null) continue;
            if (kept.Count >= BigQueryPropertiesLimits.RoutineArguments) { truncated = true; break; }
            var argName = Clip(argument.Name ?? "", BigQueryPropertiesLimits.ColumnName);
            var argType = argument.DataType is { } dataType
                ? Clip(FormatStandardSqlType(dataType, 0), BigQueryPropertiesLimits.RoutineTypeText)
                : string.Equals(argument.ArgumentKind, "ANY_TYPE", StringComparison.OrdinalIgnoreCase)
                    ? "ANY TYPE"
                    : null;
            var mode = string.IsNullOrEmpty(argument.Mode) ? null : Clip(argument.Mode.ToUpperInvariant(), BigQueryPropertiesLimits.ColumnMode);
            var kind = string.IsNullOrEmpty(argument.ArgumentKind) ? null : Clip(argument.ArgumentKind.ToUpperInvariant(), BigQueryPropertiesLimits.ColumnMode);
            kept.Add(new(argName, argType, mode, kind));
        }
        return (kept.Count > 0 ? kept : null, truncated ? true : null);
    }

    static string FormatStandardSqlType(StandardSqlDataType type, int depth)
    {
        if (depth >= 8) return type.TypeKind ?? "?";
        return type.TypeKind switch
        {
            "ARRAY" => "ARRAY<" + (type.ArrayElementType is { } element ? FormatStandardSqlType(element, depth + 1) : "?") + ">",
            "STRUCT" => "STRUCT<" + string.Join(", ", (type.StructType?.Fields ?? []).Take(64).Select(field =>
                (string.IsNullOrEmpty(field?.Name) ? "" : field.Name + " ") + (field?.Type is { } inner ? FormatStandardSqlType(inner, depth + 1) : "?"))) + ">",
            "RANGE" => "RANGE<" + (type.RangeElementType is { } range ? FormatStandardSqlType(range, depth + 1) : "?") + ">",
            null or "" => "?",
            var kind => kind
        };
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

        var (columns, columnsCut) = ColumnFacts(table);
        var (schema, schemaTruncated) = MapSchema(table.Schema?.Fields);
        var (definition, definitionCut) = MapDefinition(table);

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
            definition,
            definitionCut,
            columns,
            columnsCut,
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
            schema,
            schemaTruncated,
            labels,
            definitionCut);
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

    static (List<BigQuerySchemaField>? Schema, bool? Truncated) MapSchema(IList<TableFieldSchema>? fields)
    {
        if (fields is not { Count: > 0 }) return (null, null);
        var total = 0;
        var visited = 0;
        var textBytes = 0;
        var truncated = false;
        var budgetExhausted = false;
        const int MaxVisited = BigQueryPropertiesLimits.SchemaFields * 4;

        List<BigQuerySchemaField>? MapLevel(IList<TableFieldSchema>? source, int depth)
        {
            if (source is not { Count: > 0 } || budgetExhausted) return null;
            var mapped = new List<BigQuerySchemaField>(Math.Min(source.Count, BigQueryPropertiesLimits.SchemaFields - total));
            foreach (var field in source)
            {
                if (budgetExhausted) break;
                if (++visited > MaxVisited) { truncated = budgetExhausted = true; break; }
                if (field is null || string.IsNullOrEmpty(field.Name)) continue;
                if (total >= BigQueryPropertiesLimits.SchemaFields) { truncated = budgetExhausted = true; break; }

                var name = Clip(field.Name, BigQueryPropertiesLimits.ColumnName);
                var type = FieldType(field);
                var mode = string.IsNullOrEmpty(field.Mode) ? null : Clip(field.Mode, BigQueryPropertiesLimits.ColumnMode).ToUpperInvariant();
                var description = string.IsNullOrEmpty(field.Description) ? null : Clip(field.Description, BigQueryPropertiesLimits.ColumnDescription);
                var fieldBytes = 64 + Encoding.UTF8.GetByteCount(name) + Encoding.UTF8.GetByteCount(type)
                    + (mode is null ? 0 : Encoding.UTF8.GetByteCount(mode))
                    + (description is null ? 0 : Encoding.UTF8.GetByteCount(description));
                if (textBytes + fieldBytes > BigQueryPropertiesLimits.SchemaTextBytes) { truncated = budgetExhausted = true; break; }

                total++;
                textBytes += fieldBytes;

                List<BigQuerySchemaField>? children = null;
                if (field.Fields is { Count: > 0 })
                {
                    if (depth >= BigQueryPropertiesLimits.SchemaDepth) truncated = true;
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
            // Emulators may omit table.Type on views; preserve the pre-OP-2a fallback when type is absent.
            null or "" => !string.IsNullOrWhiteSpace(table.View?.Query) ? table.View.Query : table.MaterializedView?.Query,
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
