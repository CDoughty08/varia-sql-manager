using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Google;
using Google.Apis.Bigquery.v2.Data;

namespace Varia.Backend.BigQuery;

/// <summary>A query job that ended with an error (its <c>status.errorResult</c>, with the other errors BigQuery listed).</summary>
internal sealed class BigQueryJobException(ErrorProto result, IReadOnlyList<ErrorProto> errors) : Exception(result.Message)
{
    public ErrorProto Result { get; } = result;
    public IReadOnlyList<ErrorProto> Errors { get; } = errors;

    public static BigQueryJobException? Of(Job job) => job.Status is { State: "DONE", ErrorResult: { } result } status
        ? new BigQueryJobException(result, [.. status.Errors ?? []]) : null;
}

/// <summary>
/// One <c>jobs.getQueryResults</c> answer, parsed from its bytes rather than into Google's object model, so a page costs
/// its JSON once and its rows are decoded straight into the result's pages (<see cref="BigQueryColumnPlan"/>). Holds the
/// response's bytes until disposed; <see cref="Bytes"/> is what the caller charges to the query's budget meanwhile.
/// </summary>
internal sealed class BigQueryPage(JsonDocument document, long bytes) : IDisposable
{
    private readonly JsonElement root = document.RootElement;
    public long Bytes { get; } = bytes;
    /// <summary>The whole answer, for a reader of another shape (Job History's job listings).</summary>
    public JsonElement Root => root;
    public bool JobComplete => root.TryGetProperty("jobComplete", out var value) && value.ValueKind == JsonValueKind.True;
    public JsonElement? Schema => root.TryGetProperty("schema", out var value) && value.ValueKind == JsonValueKind.Object ? value : null;
    public JsonElement Rows => root.TryGetProperty("rows", out var value) && value.ValueKind == JsonValueKind.Array ? value : default;
    public int RowCount => Rows.ValueKind == JsonValueKind.Array ? Rows.GetArrayLength() : 0;
    public long? TotalRows => Count("totalRows");
    public long? NumDmlAffectedRows => Count("numDmlAffectedRows");
    /// <summary>A top-level string property (tables.get's type), or null.</summary>
    public string? Text(string name) => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    /// <summary>The next page's token; null on the last page. One Varia cannot send back fails the read rather than ending it
    /// early with rows unread.</summary>
    public string? PageToken => !root.TryGetProperty("pageToken", out var value) || value.ValueKind == JsonValueKind.Null || value.ValueKind == JsonValueKind.String && value.GetString() is ""
        ? null
        : value.ValueKind == JsonValueKind.String && value.GetString() is { Length: <= BigQueryLimits.PageToken } token ? token
        : throw new RequestException("BACKEND_ERROR", "BigQuery answered a page token Varia cannot use.");

    long? Count(string name) => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var count) ? count
        : root.TryGetProperty(name, out value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out count) && count >= 0 ? count : null;

    /// <summary>The page's memory while its rows are decoded: its bytes, and the parsed document's index, about 12 bytes per
    /// JSON element, where a row is an object, its "f" array and an object and value per cell.</summary>
    public long Cost(int columns) => Bytes + 12L * RowCount * (2 + 2L * Math.Max(1, columns));

    public void Dispose() => document.Dispose();
}

/// <summary>
/// Query jobs (docs/bigquery.md, Execution). Every query is a <c>jobs.insert</c> with a client-generated job id,
/// so a request that may have reached Google is never sent twice as a new job: after a transport failure
/// or a 5xx the backend asks <c>jobs.get</c> for that id, sends the insert again with the same id only when Google
/// answers that no such job exists, and takes a 409 as the job existing. Reads (<c>jobs.get</c>,
/// <c>jobs.getQueryResults</c>) are idempotent and get bounded retries with backoff on transport failures, 429 and 5xx.
/// </summary>
internal sealed partial class BigQueryService
{
    /// <summary>The first wait between retries; each later wait doubles it. The checks shorten it.</summary>
    internal TimeSpan RetryDelay { get; set; } = TimeSpan.FromSeconds(1);
    internal int InsertAttempts { get; set; } = 3;
    internal int ReadAttempts { get; set; } = 4;
    /// <summary>Rows asked per result page; BigQuery also cuts a page at about 10 MB.</summary>
    internal int PageRows { get; set; } = 10_000;
    /// <summary>The largest response body Varia reads; a larger one fails the read rather than being buffered.</summary>
    internal int MaxPageBytes { get; set; } = 64 << 20;
    /// <summary>One HTTP call's limit, past a poll's own wait, inside the query's deadline.</summary>
    internal TimeSpan CallLimit { get; set; } = TimeSpan.FromSeconds(60);

    /// <summary>Varia's job ids: a prefix Job History can match, and 32 hex digits (BigQuery allows letters, digits, _ and -).</summary>
    public const string JobIdPrefix = "varia_";
    public static string NewJobId() => JobIdPrefix + Guid.NewGuid().ToString("N");

    TimeSpan Backoff(int attempt) => RetryDelay * (1 << Math.Min(attempt - 1, 6));

    /// <summary>One HTTP call under <see cref="CallLimit"/> (plus <paramref name="extra"/>, a poll's own wait). A call cut off by
    /// that limit, not by <paramref name="token"/>, fails as a timeout the retry rules treat as a transport failure.</summary>
    async Task<T> CallAsync<T>(Func<CancellationToken, Task<T>> call, CancellationToken token, TimeSpan extra = default)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
        limit.CancelAfter(CallLimit + extra);
        try { return await call(limit.Token); }
        catch (OperationCanceledException error) when (!token.IsCancellationRequested) { throw new TimeoutException("BigQuery did not answer in time.", error); }
    }

    /// <summary>A failure after which the request may or may not have reached Google: the transport failed or timed out, or
    /// Google answered 5xx. A 429 refused it, but is retried the same way.</summary>
    internal static bool Transient(Exception error, CancellationToken token)
    {
        if (token.IsCancellationRequested) return false;
        for (var current = error; current is not null; current = current.InnerException)
        {
            if (current is GoogleApiException api) return api.HttpStatusCode is HttpStatusCode.TooManyRequests || (int)api.HttpStatusCode >= 500;
            if (current is TimeoutException or SocketException or IOException or HttpRequestException { StatusCode: null }) return true;
        }
        return false;
    }

    /// <summary>An idempotent read with bounded retries on transient failures; with <paramref name="rateLimits"/> false a
    /// rate limit reaches the caller at once, for a caller that backs off on its own clock (a windowed result's blocks).</summary>
    async Task<T> ReadAsync<T>(Func<CancellationToken, Task<T>> call, CancellationToken token, TimeSpan extra = default, bool rateLimits = true)
    {
        for (var attempt = 1; ; attempt++)
        {
            try { return await CallAsync(call, token, extra); }
            catch (Exception error) when (attempt < ReadAttempts && Transient(error, token) && (rateLimits || !RateLimited(error))) { await Task.Delay(Backoff(attempt), token); }
        }
    }

    /// <summary>BigQuery refused a request for its rate limit: HTTP 429, or the rateLimitExceeded reason.</summary>
    internal static bool RateLimited(Exception error)
    {
        for (var current = error; current is not null; current = current.InnerException)
            if (current is GoogleApiException api) return api.HttpStatusCode == HttpStatusCode.TooManyRequests || api.Error?.Errors?.Any(item => item.Reason == "rateLimitExceeded") == true;
        return false;
    }

    /// <summary>Creates a query job under its client job id, never twice (see the class summary). <paramref name="dataset"/>,
    /// the query's default dataset, tells where a job sent without a location runs, for the lookups after a failure:
    /// jobs.get outside the US and EU multi-regions finds a job only in its location.</summary>
    internal async Task<Job> InsertJobAsync(BigQueryConnection connection, Job job, string? dataset, CancellationToken token)
    {
        var reference = job.JobReference;
        // The first failure after which the job may exist (not one that never left, nor a 429, which created nothing). The
        // caller then hears the last failure wrapped in BigQueryJobMayExist, so its reason shows while no caller reads it as
        // a job never created.
        Exception? ambiguous = null;
        for (var attempt = 1; ; attempt++)
        {
            try { return await CallAsync(t => connection.Client.Service.Jobs.Insert(job, reference.ProjectId).ExecuteAsync(t), token); }
            // The id is this request's own, so the job is the one an earlier attempt (or the library's own retry of it) created.
            catch (GoogleApiException error) when (error.HttpStatusCode == HttpStatusCode.Conflict)
            {
                // The job exists: a lookup that fails says nothing against that, so the caller hears the 409 (or the earlier
                // failure), which no caller reads as a job never created.
                try
                {
                    await LocateAsync(connection, reference, dataset, token);
                    return await GetJobAsync(connection, reference.ProjectId, reference.JobId, reference.Location, token);
                }
                catch (Exception) when (!token.IsCancellationRequested) { throw new BigQueryJobMayExist(error, exists: true); }
            }
            catch (Exception error) when (Transient(error, token))
            {
                if (!NotSent(error) && error is not GoogleApiException { HttpStatusCode: HttpStatusCode.TooManyRequests }) ambiguous ??= error;
                // Before sending again, ask whether the first one arrived, where it would run.
                try
                {
                    await LocateAsync(connection, reference, dataset, token);
                    return await CallAsync(t => GetJobRequest(connection, reference.ProjectId, reference.JobId, reference.Location).ExecuteAsync(t), token);
                }
                catch (GoogleApiException lookup) when (lookup.HttpStatusCode == HttpStatusCode.NotFound && attempt < InsertAttempts) { }
                catch (Exception lookup) when (attempt < InsertAttempts && Transient(lookup, token)) { }
                // A lookup that fails in a way not retried (a 403, a 400) still leaves the first insert's fate unknown.
                catch (Exception) when (attempt >= InsertAttempts || !token.IsCancellationRequested) { throw ambiguous is null ? error : new BigQueryJobMayExist(error, exists: false); }
                await Task.Delay(Backoff(attempt), token);
            }
            // A later attempt refused outright (a 403, a 400) says nothing about an earlier one that may have created the job.
            catch (Exception error) when (ambiguous is not null && !token.IsCancellationRequested) { throw new BigQueryJobMayExist(error, exists: false); }
        }
    }

    /// <summary>Gives a reference sent without a location its default dataset's (datasets.get, free), where BigQuery runs the
    /// job. Left unset when there is no dataset or it cannot be read; the lookup then asks without one.</summary>
    async Task LocateAsync(BigQueryConnection connection, JobReference reference, string? dataset, CancellationToken token)
    {
        if (reference.Location is not null || dataset is null) return;
        try { reference.Location = await CallAsync(t => DatasetLocationAsync(connection.Client, reference.ProjectId, dataset, t), token); }
        catch (Exception error) when (!token.IsCancellationRequested && error is GoogleApiException or TimeoutException or HttpRequestException or IOException) { }
    }

    static Google.Apis.Bigquery.v2.JobsResource.GetRequest GetJobRequest(BigQueryConnection connection, string project, string jobId, string? location)
    {
        var request = connection.Client.Service.Jobs.Get(project, jobId);
        request.Location = location;
        return request;
    }

    /// <summary>jobs.get: a job's state, statistics and error.</summary>
    internal Task<Job> GetJobAsync(BigQueryConnection connection, string project, string jobId, string? location, CancellationToken token) =>
        ReadAsync(t => GetJobRequest(connection, project, jobId, location).ExecuteAsync(t), token);

    /// <summary>
    /// One <c>jobs.getQueryResults</c> call: with no page token it waits up to <paramref name="waitMs"/> for the job to
    /// finish (the first complete answer carries the first page), with one it reads that page. Times are epoch
    /// microseconds (<c>formatOptions.useInt64Timestamp</c>). A job that failed answers its own error: the job is read
    /// (jobs.get) and its error thrown as <see cref="BigQueryJobException"/>.
    /// </summary>
    internal async Task<BigQueryPage> QueryResultsAsync(BigQueryConnection connection, string project, string jobId, string? location, string? pageToken, int maxResults, int waitMs, CancellationToken token)
    {
        try { return await ReadAsync(t => ResultsPageAsync(connection, project, jobId, location, pageToken, maxResults, waitMs, t), token, TimeSpan.FromMilliseconds(waitMs)); }
        catch (GoogleApiException error) when (!Transient(error, token))
        {
            Job job;
            try { job = await GetJobAsync(connection, project, jobId, location, token); }
            catch (Exception) when (!token.IsCancellationRequested) { throw error; }
            throw BigQueryJobException.Of(job) is { } failed ? failed : error;
        }
    }

    async Task<BigQueryPage> ResultsPageAsync(BigQueryConnection connection, string project, string jobId, string? location, string? pageToken, int maxResults, int waitMs, CancellationToken token)
    {
        var service = connection.Client.Service;
        var request = service.Jobs.GetQueryResults(project, jobId);
        request.Location = location;
        request.PageToken = pageToken;
        request.MaxResults = maxResults;
        request.TimeoutMs = waitMs;
        request.FormatOptionsUseInt64Timestamp = true;
        return await SendRawAsync(service, request, token);
    }

    /// <summary>
    /// One <c>tabledata.list</c> page of a result's destination table (docs/bigquery.md, Residence): free, and random access
    /// by <paramref name="startIndex"/>, then following <paramref name="pageToken"/>. Times are epoch microseconds, as
    /// getQueryResults' are. Idempotent, so transport failures and 5xx are retried as other reads are; a rate limit reaches
    /// the caller at once (a block's fetch backs off on its own clock).
    /// </summary>
    internal Task<BigQueryPage> TableRowsAsync(BigQueryConnection connection, TableReference table, long? startIndex, int maxResults, string? pageToken, CancellationToken token) =>
        ReadAsync(t =>
        {
            var service = connection.Client.Service;
            var request = service.Tabledata.List(table.ProjectId, table.DatasetId, table.TableId);
            request.StartIndex = startIndex is { } start ? (ulong)start : null;
            request.PageToken = pageToken;
            request.MaxResults = maxResults;
            request.FormatOptionsUseInt64Timestamp = true;
            return SendRawAsync(service, request, t);
        }, token, rateLimits: false);

    /// <summary>A REST read whose JSON body Varia parses itself, under <see cref="MaxPageBytes"/> (or <paramref name="limit"/>, past
    /// which it throws <see cref="BigQueryOverLimit"/> so the caller can ask for less): sent through the service's client (its
    /// credential and the library's own retries).</summary>
    internal async Task<BigQueryPage> SendRawAsync(Google.Apis.Bigquery.v2.BigqueryService service, Google.Apis.Requests.IClientServiceRequest request, CancellationToken token, int? limit = null)
    {
        var cap = Math.Min(limit ?? MaxPageBytes, MaxPageBytes);
        Exception Over() => limit is not null ? new BigQueryOverLimit() : TooLarge();
        using var message = request.CreateRequest();
        using var response = await service.HttpClient.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, token);
        if (!response.IsSuccessStatusCode)
        {
            var error = await service.DeserializeError(response);
            throw new GoogleApiException(service.Name, error.Message ?? "BigQuery refused the request.") { Error = error, HttpStatusCode = response.StatusCode };
        }
        if (response.Content.Headers.ContentLength > cap) throw Over();
        await using var stream = await response.Content.ReadAsStreamAsync(token);
        using var body = new MemoryStream();
        var buffer = new byte[81920];
        for (int read; (read = await stream.ReadAsync(buffer, token)) > 0;)
        {
            if (body.Length + read > cap) throw Over();
            body.Write(buffer, 0, read);
        }
        var bytes = body.Length;
        return new BigQueryPage(JsonDocument.Parse(body.GetBuffer().AsMemory(0, (int)bytes), new JsonDocumentOptions { MaxDepth = 256 }), bytes);
    }

    RequestException TooLarge() => new("BACKEND_ERROR", "BigQuery answered with a result page larger than " + BigQueryCost.Bytes(MaxPageBytes) + ", which Varia does not read.");
}

/// <summary>A REST answer larger than its caller's limit (<see cref="BigQueryService.SendRawAsync"/>): the caller asks for less
/// or stops for now. Never retried.</summary>
internal sealed class BigQueryOverLimit() : Exception("BigQuery's answer is larger than this read allows.");

/// <summary>An insert's failure after which its job may exist (an earlier attempt's answer was lost), or does (a 409). The
/// message and inner exception are the last failure's, which the error mapping and the session-expiry check read; no caller
/// reads it as a job never created.</summary>
internal sealed class BigQueryJobMayExist(Exception inner, bool exists) : Exception(inner.Message, inner)
{
    public bool Exists { get; } = exists;
}
