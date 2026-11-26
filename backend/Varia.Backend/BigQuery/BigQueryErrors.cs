using System.Net;
using System.Net.Sockets;
using System.Text.RegularExpressions;
using Google;
using Google.Apis.Auth.OAuth2;
using Google.Apis.Auth.OAuth2.Responses;
using Varia.Backend.Entra;

namespace Varia.Backend.BigQuery;

/// <summary>
/// Google's failures as Varia error values with user text and a recovery (docs/bigquery.md, Errors). Google's own
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
    // A domain-scoped project (example.com:proj) keeps its domain: the dataset is after the last colon.
    [GeneratedRegex(@"Dataset (?<project>[^\s:]+(?::[^\s:]+)?):(?<dataset>[A-Za-z\d_]{1,1024}) was not found in location (?<location>[A-Za-z\d-]{1,64})")]
    private static partial Regex DatasetLocationMessage();

    /// <summary>A NOT_FOUND naming a dataset "not found in location X": a dataset in another location (LOCATION_MISMATCH, found
    /// by asking where it is with datasets.get, free) told apart from one that does not exist (the error as it was).</summary>
    public static async Task<RequestException> LocationAsync(RequestException mapped, Google.Cloud.BigQuery.V2.BigQueryClient client, CancellationToken token = default)
    {
        if (mapped.Code != "NOT_FOUND" || DatasetLocationMessage().Match(mapped.Message) is not { Success: true } match) return mapped;
        string? actual;
        try
        {
            // The request's own deadline or Cancel stops it too, within 10 s at most.
            using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
            limit.CancelAfter(TimeSpan.FromSeconds(10));
            var found = await client.Service.Datasets.Get(match.Groups["project"].Value, match.Groups["dataset"].Value).ExecuteAsync(limit.Token);
            actual = found.Location;
        }
        // Any failure here (a refused token, a disposed client) leaves the query's own error as it was.
        catch (Exception) { return mapped; }
        var ran = match.Groups["location"].Value;
        if (actual is not { Length: > 0 and <= BigQueryLimits.Location } || !BigQueryLimits.LocationId().IsMatch(actual) || string.Equals(actual, ran, StringComparison.OrdinalIgnoreCase)) return mapped;
        return new RequestException("LOCATION_MISMATCH", "Dataset " + match.Groups["dataset"].Value + " is in location " + actual + ", but the query ran in " + ran
            + ". A query runs in one location: query datasets in " + ran + ", or connect with the location set to " + actual + ".");
    }

    [GeneratedRegex(@"\b(?:ya29\.|1//)[\w.-]+")]
    private static partial Regex GoogleToken();

    // BigQuery names no reason for a session that is gone (expired or ended), only a message; read here and nowhere else.
    [GeneratedRegex(@"\bsession\b[^\n]{0,200}?\b(?:expired|has expired|not found|was not found|terminated|is not active|no longer (?:exists|active|valid)|does not exist|was aborted|has ended)", RegexOptions.IgnoreCase)]
    private static partial Regex SessionGoneText();

    // The message is about a session itself: it opens with one, not with a name, table or field that happens to be called session.
    [GeneratedRegex(@"^\s*(?:Not found:\s*)?(?:The\s+|BigQuery\s+)?session\b", RegexOptions.IgnoreCase)]
    private static partial Regex SessionSubject();

    /// <summary>Whether BigQuery's message says a session is gone (docs/bigquery.md, Sessions): the message names the session
    /// (<paramref name="sessionId"/>) or opens with one, so an analysis error about a column or table named session never
    /// counts.</summary>
    public static bool IsSessionGone(string? message, string? sessionId = null) =>
        message is { Length: > 0 and <= 16384 } && SessionGoneText().IsMatch(message)
            && (sessionId is { Length: >= 8 } && message.Contains(sessionId, StringComparison.Ordinal) || SessionSubject().IsMatch(message));

    public static string Sanitize(string? text) => EntraFailures.Sanitize(GoogleToken().Replace(text ?? "", "<token>"));

    // VPC Service Controls refuses with the same accessDenied and 403 as a missing role; only its message, or the
    // ErrorInfo detail (SECURITY_POLICY_VIOLATED) in the raw response, tells the two apart. Only how the message opens
    // counts: a refusal that quotes an object ("Table p:ds.NAME: User does not have…") can spell any marker after it.
    [GeneratedRegex(@"^\s*(?:VPC Service Controls:|Request is prohibited by organization's policy\b)")]
    private static partial Regex PerimeterMessage();

    [GeneratedRegex(@"""reason""\s*:\s*""SECURITY_POLICY_VIOLATED""")]
    private static partial Regex PerimeterDetail();

    // An identifier longer than Varia shows is left out, never cut: the administrator searches the audit log for it whole.
    [GeneratedRegex(@"(?:\bvpcServiceControlsUniqueIdentifier: |""uniqueIdentifier""\s*:\s*"")(?<id>[A-Za-z\d_-]{1,128})(?![A-Za-z\d_-])")]
    private static partial Regex PerimeterIdentifier();

    /// <summary>The raw responses read for a VPC Service Controls detail at most; Google's error bodies are a few KB.</summary>
    const int PerimeterScan = 65_536;

    /// <summary>How a VPC Service Controls refusal opens (docs/bigquery.md, Errors); src/shared/bigquery/errors.ts holds the same
    /// text for the views that add permission advice to a PERMISSION_DENIED and must not add it to this one.</summary>
    public const string PerimeterOpening = "VPC Service Controls blocked this request";

    /// <summary>Whether Google's message, or its raw error body (an RPC's status details as text), marks a VPC Service
    /// Controls refusal, with its identifier when Google gave one Varia can show whole.</summary>
    internal static bool IsPerimeter(string? message, string? raw, out string? identifier)
    {
        identifier = null;
        message ??= "";
        raw = raw is { Length: <= PerimeterScan } ? raw : null;
        if (!PerimeterMessage().IsMatch(message) && (raw is null || !PerimeterDetail().IsMatch(raw))) return false;
        var match = PerimeterIdentifier().Match(message);
        if (!match.Success && raw is not null) match = PerimeterIdentifier().Match(raw);
        identifier = match.Success ? match.Groups["id"].Value : null;
        return true;
    }

    /// <summary>What to do about a VPC Service Controls refusal, with Google's identifier for the administrator's audit log.</summary>
    internal static string PerimeterAdvice(string? identifier) =>
        "Connect from inside the perimeter (for example the corporate network or VPN), or ask an administrator to allow access"
        + (identifier is null ? "" : " (VPC Service Controls identifier " + identifier + ")") + ".";

    /// <summary>A VPC Service Controls refusal as PERMISSION_DENIED that says so. It names no project: the blocked resource may
    /// be another project's table or a bucket an external table reads, not the project the request went to.</summary>
    internal static RequestException Perimeter(string? identifier) =>
        new("PERMISSION_DENIED", PerimeterOpening + ": the organization's service perimeter does not allow it from this network or account. " + PerimeterAdvice(identifier));

    /// <summary>Whether an error value is a VPC Service Controls refusal, which no permission or role fixes.</summary>
    internal static bool IsPerimeter(Exception? error) =>
        error is RequestException { Code: "PERMISSION_DENIED" } request && request.Message.StartsWith(PerimeterOpening, StringComparison.Ordinal);

    static RequestException? Perimeter(string google, string? raw) => IsPerimeter(google, raw, out var identifier) ? Perimeter(identifier) : null;

    /// <summary>The role that grants a permission Varia names, where one role is the usual answer.</summary>
    static string RoleFor(string permission) => permission switch
    {
        "bigquery.jobs.create" => " (BigQuery Job User)",
        "bigquery.datasets.get" or "bigquery.tables.get" or "bigquery.tables.list" or "bigquery.routines.get" or "bigquery.routines.list" or "bigquery.models.list" => " (BigQuery Metadata Viewer or Data Viewer)",
        "bigquery.tables.getData" => " (BigQuery Data Viewer)",
        _ => ""
    };

    /// <summary>
    /// The error value for a failure. <paramref name="project"/> names the project in permission and API messages;
    /// <paramref name="permission"/> is the permission the call needs (the connect probe's bigquery.jobs.create);
    /// <paramref name="kind"/> is the credential's kind, since a refused refresh means different things for a user
    /// sign-in and a service account key. <paramref name="quote"/> false leaves Google's text out of a permission refusal,
    /// for callers whose messages name no object (the Search Objects index). A cancellation the caller asked for passes through.
    /// </summary>
    public static Exception Map(Exception error, string? project = null, string? permission = null, string? kind = null, long? cap = null, CancellationToken token = default, bool prices = true, bool quote = true)
    {
        // Callers that know no project pass null or "": the messages then name none.
        if (project is { Length: 0 }) project = null;
        // A Varia error raised inside the library (a subject token rule, an identity pin) is the answer, however it was wrapped.
        for (Exception? current = error; current is not null; current = current.InnerException)
            if (current is RequestException request) return request;
        for (Exception? current = error; current is not null; current = current.InnerException)
        {
            switch (current)
            {
                case OperationCanceledException when token.IsCancellationRequested: return current;
                case TokenResponseException refused: return Refused(refused.Error?.Error, kind);
                case GoogleApiException api: return Api(api, project, permission, cap, prices, quote);
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

    static RequestException Api(GoogleApiException error, string? project, string? permission, long? cap, bool prices, bool quote)
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
            return new("QUOTA", EntraFailures.Sanitize((Has("rateLimitExceeded") || status == HttpStatusCode.TooManyRequests ? "BigQuery's rate limit was reached. Wait a moment, then try again." : "A BigQuery quota was exceeded. Wait for it to reset or raise it in the Google Cloud console.")
                + (google.Length > 0 ? " Google says: " + google : "")));
        if (status == HttpStatusCode.Unauthorized || Has("authError")) return new("AUTH_EXPIRED", Expired);
        if (ByReason(Has, google, cap, prices) is { } known) return known;
        if ((Has("accessDenied") || status == HttpStatusCode.Forbidden) && Perimeter(google, error.Error?.ErrorResponseContent) is { } perimeter) return perimeter;
        // Google's own text stays beside Varia's guess at the permission: a policy denial or a narrower rule reads as its own.
        if (Has("accessDenied") || status == HttpStatusCode.Forbidden)
            return new("PERMISSION_DENIED", EntraFailures.Sanitize((permission is null ? "The account lacks permission for this" + (project is null ? "" : " in " + where) + "."
                : "The account lacks the " + permission + " permission in " + where + ". Ask for a role that grants it" + RoleFor(permission) + ", or choose another project.")
                + (quote && google.Length > 0 ? " Google says: " + google : "")));
        if (Has("notFound") || status == HttpStatusCode.NotFound)
            return new("NOT_FOUND", (google.Length > 0 ? google : "Not found.") + (project is null ? "" : " Check the project id and that the account can see " + where + "."));
        if (status is >= HttpStatusCode.InternalServerError || Has("backendError") || Has("internalError"))
            return new("BACKEND_ERROR", "BigQuery reported an internal error (HTTP " + (int)status + "). Try again.");
        return new("SQL_ERROR", google.Length > 0 ? google : "BigQuery refused the request (HTTP " + (int)status + ").");
    }

    /// <summary>The reasons a query job ends with, whether the job's own error (its <c>status.errorResult</c>) or a call's.</summary>
    static RequestException? ByReason(Func<string, bool> has, string google, long? cap, bool prices)
    {
        string Says(string text) => google.Length > 0 ? EntraFailures.Sanitize(text + " Google says: " + google) : text;
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
        if (Has("quotaExceeded") || Has("rateLimitExceeded")) return new("QUOTA", EntraFailures.Sanitize("A BigQuery quota was exceeded." + (google.Length > 0 ? " Google says: " + google : "")));
        if (Has("accessDenied") && Perimeter(google, null) is { } perimeter) return perimeter;
        if (Has("accessDenied")) return new("PERMISSION_DENIED", google.Length > 0 ? google : "The account lacks permission for this in " + where + ".");
        if (Has("notFound")) return new("NOT_FOUND", google.Length > 0 ? google : "Not found.");
        if (Has("backendError") || Has("internalError")) return new("BACKEND_ERROR", "BigQuery reported an internal error. Try again.");
        return new("SQL_ERROR", google.Length > 0 ? google : "The BigQuery job failed.");
    }

    /// <summary>Whether GoogleSQL text opts into legacy SQL: a <c>#legacySQL</c> line before any statement, after blank lines
    /// and comments (docs/bigquery.md, Execution). Checked before a job is created; a legacy-only error from BigQuery maps the same way.</summary>
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
