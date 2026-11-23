using System.Text;
using System.Text.RegularExpressions;

namespace Varia.Backend.BigQuery;

/// <summary>
/// BigQuery names in SQL text (docs/architecture.md, SQL the backend runs). BigQuery takes no identifier as a query parameter
/// and has no QUOTENAME, so a name reaches SQL only through one of these: each kind's rule (src/shared/bigquery/names.ts
/// bigQueryNameRules, checked again here), then backticks with backslashes and backticks escaped. A name its rule refuses
/// throws INVALID_PARAMS and never reaches the text. <c>BigQueryExplorerChecks</c> renders every template with hostile names.
/// </summary>
internal static partial class BqNames
{
    public const int Project = 128, Dataset = 1024, Table = 1024, Routine = 256, Model = 1024, Column = 300, FieldDepth = 15;
    /// <summary>The longest field path a ref carries: 15 column names joined by dots.</summary>
    public const int FieldPath = FieldDepth * Column + FieldDepth - 1;

    [GeneratedRegex(@"^[\p{L}\p{M}\p{N}\p{Pc}\p{Pd}\p{Zs}]+\z")]
    private static partial Regex TableRule();
    [GeneratedRegex(@"^[\p{L}\p{M}\p{N}\p{Pc}\p{Pd}\p{Zs}&%=+:'<>#|]+\z")]
    private static partial Regex ColumnRule();

    public static bool IsProject(string? value) => BigQueryLimits.IsProject(value);
    public static bool IsDataset(string? value) => value is { Length: > 0 and <= Dataset } && BigQueryLimits.DatasetId().IsMatch(value);
    /// <summary>Tables (and views, materialized views, external tables): the classes TableRule allows, up to 1,024 UTF-8 bytes.</summary>
    public static bool IsTable(string? value) => value is { Length: > 0 and <= Table } && Encoding.UTF8.GetByteCount(value) <= Table && TableRule().IsMatch(value);
    public static bool IsRoutine(string? value) => value is { Length: > 0 and <= Routine } && BigQueryLimits.DatasetId().IsMatch(value);
    public static bool IsModel(string? value) => value is { Length: > 0 and <= Model } && BigQueryLimits.DatasetId().IsMatch(value);
    public static bool IsColumn(string? value) => value is { Length: > 0 and <= Column } && ColumnRule().IsMatch(value);
    /// <summary>A column's path: 1 to 15 column names joined by dots (no column name holds one).</summary>
    public static bool IsFieldPath(string? value) => value is { Length: > 0 and <= FieldPath } && value.Split('.') is { Length: <= FieldDepth } parts && parts.All(IsColumn);

    static RequestException Invalid(string kind) => new("INVALID_PARAMS", "This is not a BigQuery " + kind + " name.");

    /// <summary>Backticks around text whose rule was checked; the escapes are a second guard, since no rule admits either character.</summary>
    static string Wrap(string text)
    {
        var builder = new StringBuilder(text.Length + 2).Append('`');
        foreach (var c in text)
        {
            if (c is '\\' or '`') builder.Append('\\');
            builder.Append(c);
        }
        return builder.Append('`').ToString();
    }

    public static string QuoteProject(string project) => IsProject(project) ? Wrap(project) : throw Invalid("project");
    public static string QuoteDataset(string dataset) => IsDataset(dataset) ? Wrap(dataset) : throw Invalid("dataset");
    public static string QuoteTable(string table) => IsTable(table) ? Wrap(table) : throw Invalid("table");
    public static string QuoteRoutine(string routine) => IsRoutine(routine) ? Wrap(routine) : throw Invalid("routine");
    public static string QuoteColumn(string column) => IsColumn(column) ? Wrap(column) : throw Invalid("column");

    /// <summary>`project`.`dataset`: a dataset's qualifier, as INFORMATION_SCHEMA views below it take it.</summary>
    public static string DatasetPath(string project, string dataset) => QuoteProject(project) + "." + QuoteDataset(dataset);
    /// <summary>`project`.`dataset`.`table`, each part quoted on its own.</summary>
    public static string TablePath(string project, string dataset, string table) => DatasetPath(project, dataset) + "." + QuoteTable(table);
    public static string RoutinePath(string project, string dataset, string routine) => DatasetPath(project, dataset) + "." + QuoteRoutine(routine);
    /// <summary>Whether a location can name a region qualifier: BigQuery's location ids (US, EU, us-central1, …).</summary>
    public static bool IsLocation(string? value) => value is { Length: > 0 and <= BigQueryLimits.Location } && BigQueryLimits.LocationId().IsMatch(value);
    /// <summary>`project`.`region-us`: a location's region qualifier, as region-scoped INFORMATION_SCHEMA views below it take it.</summary>
    public static string RegionPath(string project, string location) => QuoteProject(project) + "." + (IsLocation(location) ? Wrap("region-" + location.ToLowerInvariant()) : throw Invalid("location"));
    /// <summary>A field path as a query names it: each part quoted, joined by dots.</summary>
    public static string FieldPathText(string path) => IsFieldPath(path) ? string.Join('.', path.Split('.').Select(QuoteColumn)) : throw Invalid("column");
}
