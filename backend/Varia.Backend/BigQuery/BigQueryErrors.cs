using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using Google;
using Google.Apis.Auth.OAuth2;
using Google.Apis.Auth.OAuth2.Responses;
using Varia.Backend.Entra;

namespace Varia.Backend.BigQuery;

/// <summary>
/// Google's failures as Varia error values with user text and a recovery (docs/bigquery-plan.md, Errors). Google's own
/// message is kept only where it says what to fix, as one line of at most 2,000 characters with tokens redacted; key file
/// content never reaches a message.
/// </summary>
internal static partial class BigQueryErrors
{
    public const string SignInCommand = "gcloud auth application-default login";
    public const string Expired = "Your Google sign-in has expired. Run " + SignInCommand + ", then connect again.";
    public const string NoCredentials = "No Google credentials were found. Run " + SignInCommand + " to sign in, or choose a service account key.";
    public const string Unreachable = "Varia could not reach Google Cloud. Check the network connection and proxy settings, then try again.";
    public const string LegacySql = "Varia runs GoogleSQL only. Remove #legacySQL and write the query in GoogleSQL.";

    // Google access and refresh tokens ("ya29.", "1//"), beside the JSON Web Tokens EntraFailures.Sanitize removes.
    [GeneratedRegex(@"\b(?:ya29\.|1//)[\w.-]+")]
    private static partial Regex GoogleToken();

    public static string Sanitize(string? text) => EntraFailures.Sanitize(GoogleToken().Replace(text ?? "", "<token>"));

    /// <summary>
    /// The error value for a failure. <paramref name="project"/> names the project in permission and API messages;
    /// <paramref name="permission"/> is the permission the call needs (the connect probe's bigquery.jobs.create);
    /// <paramref name="kind"/> is the credential's kind, since a refused refresh means different things for a user
    /// sign-in and a service account key. A cancellation the caller asked for passes through.
    /// </summary>
    public static Exception Map(Exception error, string? project = null, string? permission = null, string? kind = null, long? cap = null, CancellationToken token = default, bool prices = true)
    {
        // A Varia error raised inside the library (a subject token rule, an identity pin) is the answer, however it was wrapped.
        for (Exception? current = error; current is not null; current = current.InnerException)
            if (current is RequestException request) return request;
        for (Exception? current = error; current is not null; current = current.InnerException)
        {
            switch (current)
            {
                case OperationCanceledException when token.IsCancellationRequested: return current;
                case TokenResponseException refused: return Refused(refused.Error?.Error, kind);
                case GoogleApiException api: return Api(api, project, permission, cap, prices);
                // A source that timed out, was cancelled or could not be reached is not a bad configuration: the loops on either
        // side answer it.
                case SubjectTokenException when !Interrupted(current.InnerException): return new RequestException("AUTH_KEY_FILE", "The federation configuration's subject token could not be read.");
            }
        }
        for (Exception? current = error; current is not null; current = current.InnerException)
        {
            if (current is OperationCanceledException or TimeoutException) return new RequestException("TIMEOUT", "Google Cloud did not answer in time. Try again.");
            if (current is HttpRequestException { StatusCode: null } or SocketException or IOException) return new RequestException("CONNECTION_LOST", Unreachable);
        }
        return error;
    }

    static bool Interrupted(Exception? error)
    {
        for (var current = error; current is not null; current = current.InnerException)
            if (current is OperationCanceledException or TimeoutException or HttpRequestException { StatusCode: null } or SocketException or IOException) return true;
        return false;
    }

    /// <summary>A refused token request: invalid_grant is an expired or revoked sign-in (or, for a key, a deleted key).</summary>
    static RequestException Refused(string? code, string? kind)
    {
        if (code == "invalid_grant")
            return kind switch
            {
                "serviceAccount" => new("AUTH_KEY_FILE", "Google refused the service account key: it may have been deleted or disabled. Choose a current key."),
                "externalAccount" => new("AUTH_KEY_FILE", "Google's security token service refused the federated credential. Check the configuration's pool, provider and audience, and that its source token is current."),
                _ => new("AUTH_EXPIRED", Expired)
            };
        var reason = code is { Length: > 0 and <= 64 } && code.All(c => char.IsAsciiLetterOrDigit(c) || c == '_') ? " (" + code + ")" : "";
        return new("AUTH_KEY_FILE", "Google refused the credential" + reason + ". Check the key file or sign in again with " + SignInCommand + ".");
    }

    static RequestException Api(GoogleApiException error, string? project, string? permission, long? cap, bool prices)
    {
        var reasons = error.Error?.Errors?.Select(item => item.Reason).Where(reason => reason is not null).ToArray() ?? [];
        bool Has(string reason) => reasons.Contains(reason, StringComparer.Ordinal);
        var status = error.HttpStatusCode;
        var google = Sanitize(error.Error?.Message);
        var where = project is null ? "this project" : "project " + project;
        if (Has("accessNotConfigured") || google.Contains("SERVICE_DISABLED", StringComparison.Ordinal))
            return new("API_DISABLED", "The BigQuery API is not enabled for " + where + ". Enable it in the Google Cloud console (APIs & Services › BigQuery API), then try again.");
        if (Has("billingNotEnabled"))
            return new("BILLING_DISABLED", "Billing is not enabled for " + where + ". It can run queries in the BigQuery sandbox, which has no DML and expires tables after 60 days; enable billing to lift those limits.");
        if (Has("quotaExceeded") || Has("rateLimitExceeded") || status == HttpStatusCode.TooManyRequests)
            return new("QUOTA", (Has("rateLimitExceeded") || status == HttpStatusCode.TooManyRequests ? "BigQuery's rate limit was reached. Wait a moment, then try again." : "A BigQuery quota was exceeded. Wait for it to reset or raise it in the Google Cloud console.")
                + (google.Length > 0 ? " Google says: " + google : ""));
        if (status == HttpStatusCode.Unauthorized || Has("authError")) return new("AUTH_EXPIRED", Expired);
        if (ByReason(Has, google, cap, prices) is { } known) return known;
        if (Has("accessDenied") || status == HttpStatusCode.Forbidden)
            return new("PERMISSION_DENIED", permission is null ? "The account lacks permission for this in " + where + "." + (google.Length > 0 ? " Google says: " + google : "")
                : "The account lacks the " + permission + " permission in " + where + ". Ask for a role that grants it (BigQuery Job User), or choose another project.");
        if (Has("notFound") || status == HttpStatusCode.NotFound)
            return new("NOT_FOUND", (google.Length > 0 ? google : "Not found.") + (project is null ? "" : " Check the project id and that the account can see " + where + "."));
        if (status is >= HttpStatusCode.InternalServerError || Has("backendError") || Has("internalError"))
            return new("BACKEND_ERROR", "BigQuery reported an internal error (HTTP " + (int)status + "). Try again.");
        return new("SQL_ERROR", google.Length > 0 ? google : "BigQuery refused the request (HTTP " + (int)status + ").");
    }

    /// <summary>The reasons a query job ends with, whether the job's own error (its <c>status.errorResult</c>) or a call's.</summary>
    static RequestException? ByReason(Func<string, bool> has, string google, long? cap, bool prices)
    {
        string Says(string text) => google.Length > 0 ? text + " Google says: " + google : text;
        if (has("responseTooLarge"))
            return new("RESULT_TOO_LARGE", "The result is over BigQuery's 10 GB result limit. Filter or aggregate the query so it returns fewer rows or columns.");
        if (has("bytesBilledLimitExceeded"))
            return new("COST_CAP", Says("The query would bill more than its maximum bytes billed" + (cap is { } limit ? " (" + (prices ? BigQueryCost.Priced(limit) : BigQueryCost.Bytes(limit)) + ")" : "")
                + ", so BigQuery did not run it. Raise the cap in the connection's Advanced Properties or in Tools › Options › Query Execution › BigQuery › Cost, or make the query read less."));
        // A job BigQuery stopped at its jobTimeoutMs says "stopped" too, with "timed out" in its message.
        if (has("stopped") && google.Contains("timed out", StringComparison.OrdinalIgnoreCase)) return new("TIMEOUT", "The BigQuery job exceeded its execution timeout, and BigQuery stopped it.");
        if (has("stopped")) return new("CANCELLED", "The BigQuery job was cancelled.");
        if (has("timeout")) return new("TIMEOUT", "The BigQuery job exceeded its execution timeout, and BigQuery stopped it.");
        if (has("invalidQuery")) return new("SQL_ERROR", google.Length > 0 ? google : "BigQuery refused the query.");
        if (has("jobInternalError") || has("jobBackendError")) return new("BACKEND_ERROR", Says("BigQuery reported an internal error running the job. Try again."));
        return null;
    }

    /// <summary>The error value for a query job that ended with an error: its reason mapped as a call's is, with Google's
    /// message (BigQuery's own text for a query error, with its line and column).</summary>
    public static RequestException Job(Google.Apis.Bigquery.v2.Data.ErrorProto result, IReadOnlyList<Google.Apis.Bigquery.v2.Data.ErrorProto> errors, string? project, long? cap, bool prices = true)
    {
        var reasons = errors.Select(item => item.Reason).Append(result.Reason).Where(reason => reason is not null).ToArray();
        bool Has(string reason) => reasons.Contains(reason, StringComparer.Ordinal);
        var google = Sanitize(result.Message);
        var where = project is null ? "this project" : "project " + project;
        if (ByReason(Has, google, cap, prices) is { } known) return known;
        if (Has("billingNotEnabled"))
            return new("BILLING_DISABLED", "Billing is not enabled for " + where + ". It can run queries in the BigQuery sandbox, which has no DML and expires tables after 60 days; enable billing to lift those limits.");
        if (Has("quotaExceeded") || Has("rateLimitExceeded")) return new("QUOTA", "A BigQuery quota was exceeded." + (google.Length > 0 ? " Google says: " + google : ""));
        if (Has("accessDenied")) return new("PERMISSION_DENIED", google.Length > 0 ? google : "The account lacks permission for this in " + where + ".");
        if (Has("notFound")) return new("NOT_FOUND", google.Length > 0 ? google : "Not found.");
        if (Has("backendError") || Has("internalError")) return new("BACKEND_ERROR", "BigQuery reported an internal error. Try again.");
        return new("SQL_ERROR", google.Length > 0 ? google : "The BigQuery job failed.");
    }

    /// <summary>Whether GoogleSQL text opts into legacy SQL: a <c>#legacySQL</c> line before any statement, after blank lines
    /// and comments (decision 13). Checked before a job is created; a legacy-only error from BigQuery maps the same way.</summary>
    public static bool IsLegacySql(string text)
    {
        var position = 0;
        while (position < text.Length)
        {
            if (char.IsWhiteSpace(text[position])) { position++; continue; }
            if (string.Compare(text, position, "#legacysql", 0, 10, StringComparison.OrdinalIgnoreCase) == 0
                && (position + 10 == text.Length || !char.IsLetterOrDigit(text[position + 10]) && text[position + 10] != '_')) return true;
            if (text[position] == '#' || text.AsSpan(position).StartsWith("--"))
            {
                var end = text.IndexOf('\n', position);
                position = end < 0 ? text.Length : end + 1;
                continue;
            }
            if (text.AsSpan(position).StartsWith("/*"))
            {
                var end = text.IndexOf("*/", position + 2, StringComparison.Ordinal);
                position = end < 0 ? text.Length : end + 2;
                continue;
            }
            return false;
        }
        return false;
    }
}
