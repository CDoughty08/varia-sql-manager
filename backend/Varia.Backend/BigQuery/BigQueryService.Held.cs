using System.Net;
using Google;
using Google.Cloud.BigQuery.V2;
using Google.Apis.Bigquery.v2.Data;

namespace Varia.Backend.BigQuery;

/// <summary>
/// Jobs a session holds without a request, and sessions ended outside a close (docs/bigquery.md, Re-attaching to jobs): the
/// background poll of a detached job (or one cut off by the network), Disconnect's and bigquery.endIdleSessions' ends of
/// idle sessions, the retry of an abort that failed, bigquery.cancelJobs for a profile with no handle, and query.attach's
/// identity check. Stopping the backend never cancels a job: only Stop, Cancel the job and the prompt's session ends do.
/// </summary>
internal sealed partial class BigQueryService
{
    /// <summary>The background poll of a held job: its first wait, and the longest after backoff.</summary>
    internal TimeSpan HeldPoll { get; set; } = TimeSpan.FromSeconds(5);
    internal TimeSpan HeldPollMax { get; set; } = TimeSpan.FromSeconds(60);
    /// <summary>Past this a held job counts as finished even unread (a query job runs at most 6 hours), so a job that can no
    /// longer be read (permission revoked, credentials refused) never holds its session for ever.</summary>
    internal TimeSpan HeldGiveUp { get; set; } = TimeSpan.FromHours(7);
    /// <summary>Aborts that failed, retried once each the next time a handle reaches BigQuery, while the backend runs.</summary>
    internal const int MaxFailedAborts = 64;
    private readonly Lock failedGate = new();
    private readonly List<FailedAbort> failedAborts = [];
    /// <summary>Test seam: failed aborts waiting for their retry.</summary>
    internal int FailedAbortCount { get { lock (failedGate) return failedAborts.Count; } }

    sealed record FailedAbort(BigQueryConnection Connection, IDisposable Lease, string SessionId, string? Location);

    /// <summary>
    /// Polls a held tail (detached, cut off by the network) with backoff until BigQuery reports it DONE, then marks it
    /// <c>Finished</c>, so query.session.state answers job none, and applies its statements to the session's transaction
    /// when the session's queue is free (the next execution or close settles it otherwise). Holds a lease on the client, and
    /// ends with the backend, or once the session lets go of the tail.
    /// </summary>
    internal void WatchHeld(BigQueryTabSession session, BigQueryTail tail)
    {
        if (tail.Cancelled) return;
        var connection = session.Connection;
        var lease = connection.Lease();
        if (lease is null) return;
        _ = Task.Run(async () =>
        {
            using (lease)
            {
                var wait = HeldPoll;
                var since = System.Diagnostics.Stopwatch.StartNew();
                try
                {
                    while (!stopping.IsCancellationRequested && session.Tail == tail && !tail.Cancelled)
                    {
                        try
                        {
                            var job = await GetJobAsync(connection, connection.Options.Project, tail.JobId, tail.Location, stopping.Token);
                            Reached();
                            if (job.Status?.State == "DONE") { tail.Finished = true; break; }
                            wait = HeldPoll;
                        }
                        catch (GoogleApiException error) when (!tail.Created && error.HttpStatusCode == HttpStatusCode.NotFound) { tail.Finished = true; break; }
                        catch (Exception) when (!stopping.IsCancellationRequested) { wait = TimeSpan.FromTicks(Math.Min(wait.Ticks * 2, HeldPollMax.Ticks)); }
                        if (since.Elapsed >= HeldGiveUp) { tail.Finished = true; break; }
                        await Task.Delay(wait, stopping.Token);
                    }
                    if (!tail.Finished || session.Tail != tail || !await session.Queue.WaitAsync(0)) return;
                    try
                    {
                        if (session.Tail == tail) await SettleAsync(session, stopping.Token);
                    }
                    finally { session.Queue.Release(); }
                }
                catch (Exception) { /* The next execution or close settles the job. */ }
            }
        });
    }

    /// <summary>Ends idle sessions in parallel, outside each session (ABORT_SESSION), and counts the ends that failed; each
    /// failure is kept for one retry.</summary>
    internal async Task<int> EndSessionsAsync(IReadOnlyCollection<BigQueryTabSession> idle, CancellationToken token)
    {
        var ends = idle.Where(session => session.Id is not null).Select(async session =>
        {
            var (ended, _, _) = await AbortAsync(session.Connection, session.Id!, session.Location, token);
            if (!ended) RememberFailedAbort(session.Connection, session.Id!, session.Location);
            return ended;
        });
        return (await Task.WhenAll(ends)).Count(ended => !ended);
    }

    /// <summary>Keeps a failed abort for one retry, with a lease on its client so the retry outlives a Disconnect.</summary>
    internal void RememberFailedAbort(BigQueryConnection connection, string sessionId, string? location)
    {
        var lease = connection.Lease();
        if (lease is null) return;
        FailedAbort? dropped = null;
        lock (failedGate)
        {
            if (failedAborts.Any(item => item.SessionId == sessionId)) { lease.Dispose(); return; }
            if (failedAborts.Count >= MaxFailedAborts) { dropped = failedAborts[0]; failedAborts.RemoveAt(0); }
            failedAborts.Add(new(connection, lease, sessionId, location));
        }
        dropped?.Lease.Dispose();
    }

    /// <summary>A handle reached BigQuery: every failed abort is retried once, in the background, through its own client.</summary>
    internal void Reached()
    {
        List<FailedAbort> due;
        lock (failedGate)
        {
            if (failedAborts.Count == 0) return;
            due = [.. failedAborts];
            failedAborts.Clear();
        }
        foreach (var item in due)
            _ = Task.Run(async () =>
            {
                using (item.Lease)
                {
                    try { await AbortAsync(item.Connection, item.SessionId, item.Location, stopping.Token); }
                    catch (Exception) { /* Retried once; the session expires otherwise. */ }
                }
            });
    }

    /// <summary>
    /// bigquery.endIdleSessions (main only, before every backend stop main makes): ends every idle session in parallel and
    /// answers how many ends failed. A session holding a running or detached job is left, and so is one whose last job
    /// carried one of <paramref name="keepJobKeys"/> (a tab kept at quit) while its transaction is open or unknown, so the
    /// next start re-attaches, adopts it and asks Commit or Roll Back. Every other session leaves the map.
    /// </summary>
    internal async Task<BigQueryEndIdleResult> EndIdleSessionsAsync(BigQueryEndIdleArgs args, CancellationToken token)
    {
        if (args.KeepJobKeys is { Count: > BigQueryJobLimits.Keys } || args.KeepJobKeys?.Any(key => !BigQueryLimits.Uuid().IsMatch(key ?? "")) == true)
            throw new RequestException("INVALID_PARAMS", "The job keys to keep are not valid.");
        var keep = new HashSet<string>(args.KeepJobKeys ?? [], StringComparer.OrdinalIgnoreCase);
        var idle = new List<BigQueryTabSession>();
        foreach (var session in sessions.Values)
        {
            if (session.HoldsJob) continue;
            // A finished job not yet settled has not applied its statements: its transaction is not known yet.
            if (session.LastJobKey is { } key && keep.Contains(key) && (session.Transaction != BigQueryTransaction.None || session.Tail is not null)) continue;
            Forget(session);
            if (session.Id is not null) idle.Add(session);
        }
        return new(await EndSessionsAsync(idle, token));
    }

    /// <summary>
    /// The identity check before query.attach reads a job (docs/bigquery.md, Re-attaching to jobs): jobs.list without
    /// allUsers lists only the caller's jobs, so one listing over the job's creation time must hold its id. Reading the
    /// creation time needs jobs.get, so a 403 or 404 there means another principal's job too. AUTH_IDENTITY either way.
    /// jobs.list needs bigquery.jobs.list, which the Job User role lacks: a 403 there is PERMISSION_DENIED naming it, and the
    /// job is left running (not AUTH_IDENTITY, which would let go of a job that may well be the user's), unless this backend
    /// inserted the job itself (`inserted`: the tab's own held job), which the listing would only confirm.
    /// </summary>
    internal async Task<Job> OwnJobAsync(BigQueryConnection connection, string jobId, string? location, CancellationToken token, bool inserted = false)
    {
        var project = connection.Options.Project;
        Job job;
        try { job = await GetJobAsync(connection, project, jobId, location, token); }
        catch (GoogleApiException error) when (error.HttpStatusCode is HttpStatusCode.NotFound || Refused(error)) { throw NotOwn(); }
        // The emulator lists no jobs by creation time; its single principal owns every job.
        if (environment.Emulator) return job;
        if (job.Statistics?.CreationTime is not { } created || created <= 0) throw NotOwn();
        string? pageToken = null;
        for (var page = 0; page < 10; page++)
        {
            var request = connection.Client.Service.Jobs.List(project);
            request.MinCreationTime = (ulong)Math.Max(0, created - 1);
            request.MaxCreationTime = (ulong)(created + 1);
            request.Projection = Google.Apis.Bigquery.v2.JobsResource.ListRequest.ProjectionEnum.Minimal;
            request.MaxResults = 1000;
            request.PageToken = pageToken;
            JobList answer;
            try { answer = await ReadAsync(t => request.ExecuteAsync(t), token); }
            catch (GoogleApiException error) when (Refused(error))
            {
                // The tab's own held job, which this backend inserted on this connection: the listing only confirms it.
                if (inserted) return job;
                throw new RequestException("PERMISSION_DENIED", "Re-attaching checks that this account started the BigQuery job, which needs the bigquery.jobs.list permission (the BigQuery User role grants it; Job User does not). Varia left the job running.");
            }
            if (answer.Jobs?.Any(item => item.JobReference?.JobId == jobId) == true) return job;
            pageToken = answer.NextPageToken is { Length: > 0 and <= BigQueryLimits.PageToken } next && !next.Any(char.IsControl) ? next : null;
            if (pageToken is null) break;
        }
        throw NotOwn();

        // BigQuery answers a rate limit or quota with 403 too: that is QUOTA (a passing failure that keeps the job), not a refusal.
        static bool Refused(GoogleApiException error) => error.HttpStatusCode == HttpStatusCode.Forbidden
            && error.Error?.Errors?.Any(item => item.Reason is "rateLimitExceeded" or "quotaExceeded") != true;
        static RequestException NotOwn() => new("AUTH_IDENTITY", "This BigQuery job was not started by the account this connection signs in as, or it no longer exists. Varia left it alone.");
    }

    /// <summary>
    /// bigquery.cancelJobs (main only; docs/bigquery.md, Re-attaching to jobs): signs in with the profile's
    /// credential, then for each job in parallel cancels it, waits for its DONE (up to 30 s, within the call's deadline) and lists
    /// its final children (committedBeforeCancel, or outcomeUnknown when that does not finish), and ends its session
    /// (statistics.sessionInfo) outside the session, since no tab will.
    /// </summary>
    internal async Task<BigQueryCancelJobsResult> CancelJobsAsync(BigQueryCancelJobsArgs args, CancellationToken token)
    {
        BigQueryLimits.CheckCredential(args.Authentication, args.KeyFile, args.ImpersonateServiceAccount, args.Credential, environment.Emulator);
        if (!BigQueryLimits.IsProject(args.Project)) throw new RequestException("INVALID_PARAMS", "Enter a Google Cloud project id.");
        if (args.References is not { Count: > 0 and <= BigQueryJobLimits.Cancel } || args.References.Any(job => job is null || !BigQueryJobLimits.IsJobId(job.JobId) || !BigQueryJobLimits.IsLocation(job.Location)))
            throw new RequestException("INVALID_PARAMS", "The jobs to cancel are not valid.");
        BigQueryClient client;
        try
        {
            using var signIn = CancellationTokenSource.CreateLinkedTokenSource(token);
            signIn.CancelAfter(PreConnectLimit);
            var (credential, _) = await SignInAsync(args.Authentication, args.ImpersonateServiceAccount, args.Credential!, signIn.Token);
            client = Client(args.Project, credential, null);
        }
        catch (Exception error) { throw BigQueryErrors.Map(error, args.Project, kind: KindOf(args.Authentication), token: token); }
        var options = new BigQueryConnectOptions(Providers.BigQuery, args.Project, args.Authentication);
        using var connection = new BigQueryConnection(Guid.NewGuid().ToString(), options, client, BigQueryIdentity.Anonymous, null);
        var jobs = await Task.WhenAll(args.References.DistinctBy(job => job.JobId).Select(job => CancelOneAsync(connection, job, token)));
        return new(jobs);
    }

    async Task<BigQueryCancelledJob> CancelOneAsync(BigQueryConnection connection, BigQueryJobReference reference, CancellationToken token)
    {
        var project = connection.Options.Project;
        try
        {
            var cancel = connection.Client.Service.Jobs.Cancel(project, reference.JobId);
            cancel.Location = reference.Location;
            var answer = await ReadAsync(t => cancel.ExecuteAsync(t), token);
            var location = answer.Job?.JobReference?.Location ?? reference.Location;
            Job? done = null;
            var committed = false;
            var complete = false;
            using (var wait = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                wait.CancelAfter(CloseWaitLimit);
                try
                {
                    done = await WaitDoneAsync(connection, project, reference.JobId, location, wait.Token);
                    var script = StatementOf(done.Statistics) == "SCRIPT" || done.Statistics?.NumChildJobs > 0;
                    var (children, listed) = script ? await ChildrenAsync(connection, project, reference.JobId, null, wait.Token) : ([], true);
                    committed = children.Any(child => child.StatementType == "COMMIT_TRANSACTION" && child.Done && child.Error is null);
                    complete = listed;
                }
                catch (Exception) when (!token.IsCancellationRequested) { }
            }
            SessionCloseNote? note = committed ? Note("committedBeforeCancel", jobId: reference.JobId)
                : !complete ? Note("outcomeUnknown", jobId: reference.JobId) : null;
            // The session the job ran in ends here, since no tab will end it; one not read (the job not DONE) is left to expire.
            var sessionId = done?.Statistics?.SessionInfo?.SessionId;
            if (sessionId is not null && BigQuerySql.SessionId().IsMatch(sessionId))
            {
                var (ended, _, error) = await AbortAsync(connection, sessionId, location, token);
                if (!ended) note = Note("abortFailed", note is null ? error : Prior(note) + " " + error, reference.JobId);
            }
            return new(reference.JobId, true, note);
        }
        catch (Exception error) when (!token.IsCancellationRequested)
        {
            var mapped = BigQueryErrors.Map(error, project) as RequestException;
            return new(reference.JobId, false, Error: mapped?.Message ?? "BigQuery did not cancel the job.");
        }
    }
}
