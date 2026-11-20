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

    /// <summary>A BigQuery session id as Varia keeps it: an opaque token of URL-safe base64 characters. Anything else
    /// BigQuery answers is not kept, so it can never reach a statement or a log.</summary>
    [GeneratedRegex(@"^[A-Za-z0-9_\-=+/.]{1,1024}$")]
    public static partial Regex SessionId();
}
