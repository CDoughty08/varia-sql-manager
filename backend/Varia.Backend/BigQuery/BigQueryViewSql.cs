using System.Text;
using Google.Apis.Bigquery.v2.Data;

namespace Varia.Backend.BigQuery;

/// <summary>A value list a distinct query made (results.remoteQuery, kind distinct): its own result table, whose rows are
/// the column's values in value order (column r), the result and column it lists, how many rows it has, and whether the cap
/// cut it short.</summary>
internal sealed record RemoteValueList(TableReference Table, uint Source, int Column, int Rows, bool Capped);

internal enum RemoteFilterKind { In, NotIn, Between }

/// <summary>A remote filter resolved against its value list: keep (In) or drop (NotIn) the values at Rows of List, and NULL
/// when Nulls says, or keep the values from Rows[0]'s to Rows[1]'s (Between). In and NotIn with no rows name no list.</summary>
internal sealed record RemoteFilter(RemoteFilterKind Kind, int Column, RemoteValueList? List, int[] Rows, bool Nulls);

/// <summary>
/// The SQL of a sort, filter or value list over a windowed BigQuery result (docs/bigquery.md, Sort and filter in BigQuery):
/// <see cref="BigQuerySql"/>'s fragments joined around the result table's path and its own columns' names, each through
/// <see cref="BqNames"/>, with every value a query parameter. A filter's values are named by their rows in a value list,
/// whose own table the query reads (<see cref="Members"/>), so they are compared in BigQuery exactly as it grouped them.
/// </summary>
internal static class BigQueryViewSql
{
    public const int MaxKeys = 16, MaxFilters = 16;
    /// <summary>The most values a value list holds: the most frequent, so a cut list still names the values most rows have.</summary>
    public const int ValueListCap = 100_000;

    /// <summary>Whether BigQuery can order and group a column of this type: not ARRAY, STRUCT, GEOGRAPHY, JSON, RANGE or
    /// INTERVAL, nor a type this build does not know.</summary>
    public static bool Orderable(BigQueryField field) => !field.Repeated && field.Kind is BigQueryKind.Int64 or BigQueryKind.Float64 or BigQueryKind.Numeric or BigQueryKind.BigNumeric
        or BigQueryKind.Bool or BigQueryKind.String or BigQueryKind.Bytes or BigQueryKind.Date or BigQueryKind.Time or BigQueryKind.DateTime or BigQueryKind.Timestamp;

    /// <summary>The source a query reads: the result table, or the original query in parentheses when it expired.</summary>
    public static string Source(TableReference table) => BqNames.TablePath(table.ProjectId, table.DatasetId, table.TableId);

    public static string Source(string original) => BigQuerySql.SourceOpen + Trimmed(original) + BigQuerySql.SourceClose;

    /// <summary>The original text without the semicolons and blanks that end it, so it reads as one query in parentheses.</summary>
    internal static string Trimmed(string sql) => sql.TrimEnd().TrimEnd(';').TrimEnd();

    /// <summary>A sort or filter: <c>SELECT * FROM source WHERE … ORDER BY …</c>.</summary>
    public static string View(string source, IReadOnlyList<BigQueryField> fields, IReadOnlyList<RemoteSortArgs> sort, IReadOnlyList<RemoteFilter> filters, List<QueryParameter> parameters)
    {
        var sql = new StringBuilder(BigQuerySql.SelectAll).Append(source);
        Where(sql, fields, filters, parameters);
        for (var i = 0; i < sort.Count; i++)
        {
            sql.Append(i == 0 ? BigQuerySql.OrderBy : BigQuerySql.Comma).Append(Column(fields, sort[i].Column));
            sql.Append(sort[i].Descending ? BigQuerySql.Descending : BigQuerySql.Ascending);
        }
        return sql.ToString();
    }

    /// <summary>A value list of <paramref name="column"/> over the rows the filters keep: up to <see cref="ValueListCap"/>
    /// values with their counts, and whether the <paramref name="kept"/> filters' rows hold each (all of them when null).</summary>
    public static string Values(string source, IReadOnlyList<BigQueryField> fields, int column, IReadOnlyList<RemoteFilter> filters, IReadOnlyList<RemoteFilter>? kept, List<QueryParameter> parameters)
    {
        var sql = new StringBuilder(BigQuerySql.ValuesHead).Append(Column(fields, column)).Append(BigQuerySql.ValuesCount);
        if (kept is null || kept.Count == 0) sql.Append(BigQuerySql.True);
        else Conjunction(sql, fields, kept, parameters);
        sql.Append(BigQuerySql.ValuesFrom).Append(source);
        Where(sql, fields, filters, parameters);
        sql.Append(BigQuerySql.ValuesTail);
        parameters.Add(new QueryParameter { Name = BigQuerySql.CapParameter, ParameterType = new QueryParameterType { Type = "INT64" }, ParameterValue = new QueryParameterValue { Value = ValueListCap.ToString(System.Globalization.CultureInfo.InvariantCulture) } });
        return sql.ToString();
    }

    static void Where(StringBuilder sql, IReadOnlyList<BigQueryField> fields, IReadOnlyList<RemoteFilter> filters, List<QueryParameter> parameters)
    {
        if (filters.Count == 0) return;
        sql.Append(BigQuerySql.Where);
        Conjunction(sql, fields, filters, parameters);
    }

    static void Conjunction(StringBuilder sql, IReadOnlyList<BigQueryField> fields, IReadOnlyList<RemoteFilter> filters, List<QueryParameter> parameters)
    {
        for (var i = 0; i < filters.Count; i++)
        {
            if (i > 0) sql.Append(BigQuerySql.And);
            Predicate(sql, fields, filters[i], parameters);
        }
    }

    /// <summary>One filter as a predicate that is never NULL, in parentheses.</summary>
    static void Predicate(StringBuilder sql, IReadOnlyList<BigQueryField> fields, RemoteFilter filter, List<QueryParameter> parameters)
    {
        var column = Column(fields, filter.Column);
        sql.Append(BigQuerySql.Open);
        switch (filter.Kind)
        {
            case RemoteFilterKind.Between:
            {
                // Rows ascend in value order, so the lower row is the lower bound.
                var (low, high) = filter.Rows[0] <= filter.Rows[1] ? (filter.Rows[0], filter.Rows[1]) : (filter.Rows[1], filter.Rows[0]);
                sql.Append(column).Append(BigQuerySql.IsNotNull).Append(BigQuerySql.And).Append(column).Append(BigQuerySql.Between);
                ValueAt(sql, filter.List!, low, parameters);
                sql.Append(BigQuerySql.And);
                ValueAt(sql, filter.List!, high, parameters);
                break;
            }
            case RemoteFilterKind.In when filter.Rows.Length == 0:
                sql.Append(filter.Nulls ? column + BigQuerySql.IsNull : BigQuerySql.False);
                break;
            case RemoteFilterKind.NotIn when filter.Rows.Length == 0:
                sql.Append(filter.Nulls ? column + BigQuerySql.IsNotNull : BigQuerySql.True);
                break;
            case RemoteFilterKind.In:
                // A value among the members, or NULL when it is kept too.
                sql.Append(column).Append(BigQuerySql.IsNotNull).Append(BigQuerySql.And).Append(column).Append(BigQuerySql.In);
                Members(sql, filter.List!, filter.Rows, parameters);
                if (filter.Nulls) sql.Append(BigQuerySql.Or).Append(column).Append(BigQuerySql.IsNull);
                break;
            case RemoteFilterKind.NotIn:
                // NOT IN over a NULL is NULL, so NULL is asked apart: dropped when Nulls says, else kept. Members are never NULL.
                sql.Append(column).Append(filter.Nulls ? BigQuerySql.IsNotNull + BigQuerySql.And : BigQuerySql.IsNull + BigQuerySql.Or);
                sql.Append(column).Append(BigQuerySql.NotIn);
                Members(sql, filter.List!, filter.Rows, parameters);
                break;
        }
        sql.Append(BigQuerySql.Close);
    }

    /// <summary>The values at <paramref name="rows"/> of a value list: the only encoding of a filter's values.</summary>
    static void Members(StringBuilder sql, RemoteValueList list, int[] rows, List<QueryParameter> parameters)
    {
        var name = BigQuerySql.Parameter + parameters.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);
        parameters.Add(new QueryParameter
        {
            Name = name,
            ParameterType = new QueryParameterType { Type = "ARRAY", ArrayType = new QueryParameterType { Type = "INT64" } },
            ParameterValue = new QueryParameterValue { ArrayValues = [.. rows.Select(row => new QueryParameterValue { Value = row.ToString(System.Globalization.CultureInfo.InvariantCulture) })] }
        });
        sql.Append(BigQuerySql.MembersFrom).Append(Source(list.Table)).Append(BigQuerySql.MembersWhere).Append(name).Append(BigQuerySql.Close).Append(BigQuerySql.Close);
    }

    static void ValueAt(StringBuilder sql, RemoteValueList list, int row, List<QueryParameter> parameters)
    {
        var name = BigQuerySql.Parameter + parameters.Count.ToString(System.Globalization.CultureInfo.InvariantCulture);
        parameters.Add(new QueryParameter { Name = name, ParameterType = new QueryParameterType { Type = "INT64" }, ParameterValue = new QueryParameterValue { Value = row.ToString(System.Globalization.CultureInfo.InvariantCulture) } });
        sql.Append(BigQuerySql.ValueAt).Append(Source(list.Table)).Append(BigQuerySql.RowIs).Append(name).Append(BigQuerySql.Close);
    }

    static string Column(IReadOnlyList<BigQueryField> fields, int column) => BqNames.QuoteColumn(fields[column].Name);
}
