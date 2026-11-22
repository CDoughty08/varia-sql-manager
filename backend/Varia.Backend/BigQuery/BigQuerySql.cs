using System.Text.RegularExpressions;

namespace Varia.Backend.BigQuery;

/// <summary>
/// The SQL the backend itself runs against BigQuery (docs/architecture.md, SQL the backend runs): constant text, with
/// values as query parameters. The offline lint (BigQuerySessionChecks) holds every constant here to that rule.
/// </summary>
internal static partial class BigQuerySql
{
    /// <summary>Ends a tab's session, run outside it so it never waits behind a job of the session. Google documents a literal
    /// argument; the id goes as a STRING parameter (docs/bigquery.md, Sessions).</summary>
    public const string AbortSession = "CALL BQ.ABORT_SESSION(@session_id)";
    public const string AbortSessionParameter = "session_id";
    /// <summary>Commits the session's open transaction, run in the session.</summary>
    public const string Commit = "COMMIT TRANSACTION";

    /// <summary>Every statement above, for the lint.</summary>
    public static readonly IReadOnlyList<string> All = [AbortSession, Commit];

    // A sort, filter or value list over a windowed result (docs/bigquery.md, Sort and filter in BigQuery): these fragments,
    // with names only through BqNames (the destination table, the result's own columns) and every value a parameter.
    // BigQueryViewSql joins them; the offline lint renders every shape with hostile names.
    public const string SelectAll = "SELECT * FROM ";
    /// <summary>The original query as the source when its result table expired; the newline ends a trailing line comment.</summary>
    public const string SourceOpen = "(";
    public const string SourceClose = "\n)";
    public const string Where = " WHERE ";
    public const string And = " AND ";
    public const string OrderBy = " ORDER BY ";
    public const string Comma = ", ";
    public const string Ascending = " ASC NULLS FIRST";
    public const string Descending = " DESC NULLS LAST";
    public const string IsNull = " IS NULL";
    public const string IsNotNull = " IS NOT NULL";
    public const string Open = "(";
    public const string Close = ")";
    public const string Or = " OR ";
    public const string NotIn = " NOT IN ";
    public const string In = " IN ";
    public const string True = "TRUE";
    public const string False = "FALSE";
    public const string Between = " BETWEEN ";
    /// <summary>A value list's members, named by their rows in it: a subquery on the list's own result table. The one place
    /// a filter's values are encoded (BigQueryViewSql.Members), so another encoding replaces only it.</summary>
    public const string MembersFrom = "(SELECT value FROM ";
    public const string MembersWhere = " WHERE value IS NOT NULL AND r IN UNNEST(@";
    /// <summary>NaN equals nothing, itself included, yet BigQuery groups it as one value: a FLOAT64 filter matches it apart.</summary>
    public const string IsNan = "IS_NAN(";
    public const string NanMembersFrom = " AND EXISTS(SELECT 1 FROM ";
    public const string NanMembersWhere = " WHERE IS_NAN(value) AND r IN UNNEST(@";
    public const string Not = "NOT ";
    public const string AtMost = " <= ";
    public const string ValueAt = "(SELECT value FROM ";
    public const string RowIs = " WHERE r = @";
    public const string Parameter = "p";
    /// <summary>A value list: each distinct value, its count, its row in value order (where Varia reads it) and whether the
    /// kept rows hold it; the most frequent values up to the cap, then in value order.</summary>
    public const string ValuesHead = "SELECT value, n, ROW_NUMBER() OVER (ORDER BY value ASC NULLS FIRST) - 1 AS r, k FROM (SELECT ";
    public const string ValuesCount = " AS value, COUNT(*) AS n, COALESCE(LOGICAL_OR(";
    public const string ValuesFrom = "), FALSE) AS k FROM ";
    public const string ValuesTail = " GROUP BY 1 ORDER BY 2 DESC, 1 ASC NULLS FIRST LIMIT @cap) ORDER BY r";
    public const string CapParameter = "cap";

    /// <summary>Every fragment above, for the lint.</summary>
    public static readonly IReadOnlyList<string> ViewFragments = [SelectAll, SourceOpen, SourceClose, Where, And, OrderBy, Comma, Ascending, Descending, IsNull, IsNotNull,
        Open, Close, Or, NotIn, In, True, False, Between, MembersFrom, MembersWhere, IsNan, NanMembersFrom, NanMembersWhere, Not, AtMost, ValueAt, RowIs, Parameter, ValuesHead, ValuesCount, ValuesFrom, ValuesTail, CapParameter];

    /// <summary>A BigQuery session id as Varia keeps it: an opaque token of URL-safe base64 characters. Anything else
    /// BigQuery answers is not kept, so it can never reach a statement or a log.</summary>
    [GeneratedRegex(@"^[A-Za-z0-9_\-=+/.]{1,1024}$")]
    public static partial Regex SessionId();
}
