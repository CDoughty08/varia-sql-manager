using Google.Apis.Bigquery.v2;
using JobsList = Google.Apis.Bigquery.v2.JobsResource.ListRequest;

namespace Varia.Backend.BigQuery;

/// <summary>One jobs.list request of Job History: allUsers, the creation window (epoch ms), the BigQuery states it asks for (done,
/// pending, running), a parent script's id, and the projection (minimal when only ids are needed).</summary>
internal sealed record HistoryListing(bool AllUsers, long? MinCreated = null, long? MaxCreated = null, string[]? States = null, string? ParentJobId = null, bool Minimal = false);

/// <summary>
/// Job History's REST calls (docs/bigquery.md, Job History): jobs.list pages read from their JSON under a byte limit, jobs.get for
/// the details pane and for jobs that finished, and jobs.cancel. All of them are free API calls (never a query, never the
/// INFORMATION_SCHEMA.JOBS views) through the principal's shared rate limiter (<see cref="MetadataAsync"/>). Nothing is logged.
/// </summary>
internal sealed partial class BigQueryService
{
    /// <summary>One jobs.list page of the connection's billing project, read under <paramref name="limit"/> bytes: a larger page
    /// throws <see cref="BigQueryOverLimit"/>, so the caller asks for fewer jobs or stops for now.</summary>
    internal Task<HistoryPage> ListHistoryAsync(BigQueryConnection connection, HistoryListing listing, string? pageToken, int maxResults, int limit, CancellationToken token) =>
        MetadataAsync(connection, async t =>
        {
            var service = connection.Client.Service;
            var request = service.Jobs.List(connection.Options.Project);
            if (listing.AllUsers) request.AllUsers = true;
            if (listing.MinCreated is { } min) request.MinCreationTime = (ulong)Math.Max(0, min);
            if (listing.MaxCreated is { } max) request.MaxCreationTime = (ulong)Math.Max(0, max);
            request.MaxResults = maxResults;
            request.PageToken = pageToken;
            request.ParentJobId = listing.ParentJobId;
            request.Projection = listing.Minimal ? JobsList.ProjectionEnum.Minimal : JobsList.ProjectionEnum.Full;
            if (listing.States is { Length: > 0 } states)
                request.StateFilterList = new Google.Apis.Util.Repeatable<JobsList.StateFilterEnum>(states.Select(state => state switch
                {
                    "pending" => JobsList.StateFilterEnum.Pending,
                    "running" => JobsList.StateFilterEnum.Running,
                    _ => JobsList.StateFilterEnum.Done
                }).Distinct().ToList());
            using var page = await SendRawAsync(service, request, t, limit);
            return BigQueryJobHistory.Page(page.Root, page.Bytes);
        }, token);

    /// <summary>jobs.get read from its JSON (a job's whole query text is up to 1 MB): the job, or null when BigQuery answered
    /// something that names no job.</summary>
    internal Task<(HistoryJob? Job, BigQueryJobDetail? Detail, long Bytes)> ReadHistoryJobAsync(BigQueryConnection connection, string jobId, string? location, int limit, bool detail, CancellationToken token) =>
        MetadataAsync(connection, async t =>
        {
            var service = connection.Client.Service;
            var request = service.Jobs.Get(connection.Options.Project, jobId);
            request.Location = location;
            using var page = await SendRawAsync(service, request, t, limit);
            return (BigQueryJobHistory.Job(page.Root), detail ? BigQueryJobHistory.Detail(page.Root, connection.Options.Project) : null, page.Bytes);
        }, token);

    /// <summary>bigquery.jobs.get: one job's details and full SQL, and a script's children in statement order (at most
    /// <see cref="BigQueryJobHistory.Children"/>, within the response budget; ChildrenMore says more exist). A refusal or failure
    /// listing the children leaves the job's details and says so in ChildrenError.</summary>
    public async Task<BigQueryJobDetails> JobDetailsAsync(BigQueryJobArgs args, CancellationToken token)
    {
        BigQueryJobHistory.Check(args);
        var connection = Find(args.ConnectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        using var lease = connection.Lease() ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        var project = connection.Options.Project;
        HistoryJob job;
        BigQueryJobDetail detail;
        long spent;
        try
        {
            var read = await ReadHistoryJobAsync(connection, args.JobId, args.Location, BigQueryJobHistory.JobBytes, detail: true, token);
            if (read.Job is null || read.Detail is null) throw new RequestException("BACKEND_ERROR", "BigQuery answered without the job.");
            (job, detail, spent) = (read.Job, read.Detail, read.Bytes);
        }
        catch (BigQueryOverLimit) { throw new RequestException("RESULT_TOO_LARGE", "BigQuery's answer for this job is larger than Varia reads."); }
        catch (Exception error) when (error is not RequestException { Code: "INVALID_PARAMS" or "NOT_CONNECTED" or "BACKEND_ERROR" or "RESULT_TOO_LARGE" })
        {
            throw BigQueryErrors.Map(error, project, "bigquery.jobs.get", token: token);
        }
        if (!job.Script) return new(detail, []);
        var budget = (int)Math.Max(0, BigQueryJobHistory.ResponseBytes - spent);
        try
        {
            var (children, more, _) = await ChildJobsAsync(connection, job.Id, args.AllUsers == true, budget, token);
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            return new(detail, [.. children.Select(child => BigQueryJobHistory.Child(child, now))], more ? true : null);
        }
        catch (Exception error) when (!token.IsCancellationRequested)
        {
            var mapped = BigQueryErrors.Map(error, project, "bigquery.jobs.list", token: token);
            // Clipped to the answer's bound (childrenError), so a long message from Google never costs the job's details.
            return new(detail, [], null, BigQueryJobHistory.Clip(mapped is RequestException request ? request.Message : "BigQuery could not list the script's statements.", BigQueryJobHistory.ChildrenErrorChars)!);
        }
    }

    /// <summary>A script's children (jobs.list with parentJobId, full projection), in statement order: ascending creation time,
    /// ties by job id. At most <see cref="BigQueryJobHistory.Children"/>, read within <paramref name="budget"/> bytes; More says
    /// the listing was cut, and Bytes is what the answers took.</summary>
    internal async Task<(List<HistoryJob> Children, bool More, long Bytes)> ChildJobsAsync(BigQueryConnection connection, string parentId, bool allUsers, int budget, CancellationToken token)
    {
        var children = new Dictionary<string, HistoryJob>(StringComparer.Ordinal);
        string? pageToken = null;
        var size = BigQueryJobHistory.PageJobs;
        var more = false;
        var start = budget;
        while (true)
        {
            HistoryPage page;
            try { page = await ListHistoryAsync(connection, new(allUsers, ParentJobId: parentId), pageToken, size, budget, token); }
            catch (BigQueryOverLimit)
            {
                // A page of whole query texts larger than what is left: fewer jobs a page, or stop here once a job alone is too large.
                if (size > 1 && budget >= BigQueryJobHistory.JobBytes) { size = Math.Max(1, size / 4); continue; }
                more = true;
                break;
            }
            budget -= (int)Math.Min(budget, page.Bytes);
            foreach (var child in page.Items)
                if (child.Parent == parentId && children.Count < BigQueryJobHistory.Children) children[child.Id] = child;
            pageToken = page.Next;
            if (pageToken is null) break;
            if (children.Count >= BigQueryJobHistory.Children || budget <= 0) { more = true; break; }
        }
        return ([.. children.Values.OrderBy(child => child.Created ?? 0).ThenBy(child => child.Id, StringComparer.Ordinal)], more, start - budget);
    }

    /// <summary>bigquery.jobs.cancel: asks BigQuery to cancel one job, which it answers at once (the job ends shortly after).
    /// Cancelling another user's job needs bigquery.jobs.update; the refusal is PERMISSION_DENIED.</summary>
    public async Task<BigQueryJobCancelResult> CancelHistoryJobAsync(BigQueryJobArgs args, CancellationToken token)
    {
        BigQueryJobHistory.Check(args);
        if (args.AllUsers is not null) throw new RequestException("INVALID_PARAMS", "The job is invalid.");
        var connection = Find(args.ConnectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        using var lease = connection.Lease() ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        try
        {
            var answer = await MetadataAsync(connection, t =>
            {
                var request = connection.Client.Service.Jobs.Cancel(connection.Options.Project, args.JobId);
                request.Location = args.Location;
                return request.ExecuteAsync(t);
            }, token);
            var error = answer?.Job?.Status?.ErrorResult;
            var state = answer?.Job?.Status?.State switch
            {
                "PENDING" => "pending", "RUNNING" => "running",
                "DONE" => error is null ? "done" : BigQueryJobHistory.Cancelled(error.Reason, error.Message) ? "cancelled" : "failed", _ => null
            };
            return new(true, state);
        }
        catch (Exception error) { throw BigQueryErrors.Map(error, connection.Options.Project, "bigquery.jobs.update", token: token); }
    }
}
