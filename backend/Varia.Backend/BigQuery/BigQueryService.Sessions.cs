using System.Collections.Concurrent;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.ExceptionServices;
using System.Text.Json;
using Google;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.MultiQuery;

namespace Varia.Backend.BigQuery;

/// <summary>A session's transaction as the backend tracks it from the statement types of its jobs (docs/bigquery.md,
/// Sessions): none, open, or unknown (a statement failed inside it, or a job's children could not all be read).</summary>
internal enum BigQueryTransaction { None, Open, Unknown }

/// <summary>A session job that had not reached DONE when its request ended: one Varia cancelled (Stop, the execution
/// timeout), or one cut off by a network failure, which the session still holds. The session runs nothing else until it
/// is DONE and its children are read. <c>Created</c> says BigQuery answered that the job exists; one it never confirmed
/// (an insert cut off in flight) and that jobs.get does not find ran nothing, and no longer holds the session. A tail Varia
/// did not cancel (a detached job, one cut off by the network) is polled in the background until it is DONE
/// (<c>Finished</c>), so query.session.state can answer whether the session still holds a job without a request.</summary>
internal sealed class BigQueryTail(string jobId, string? location, bool cancelled, bool created = true)
{
    public string JobId { get; } = jobId;
    public string? Location { get; } = location;
    public bool Cancelled { get; set; } = cancelled;
    public bool Created { get; } = created;
    private volatile bool finished;
    /// <summary>The background poll saw the job DONE (or found an unconfirmed insert never created it).</summary>
    public bool Finished { get => finished; set => finished = value; }
    /// <summary>Whether the session holds this job: running in BigQuery, and not cancelled by Varia.</summary>
    public bool Holds => !Cancelled && !Finished;
}

/// <summary>A script statement's job, as jobs.list's full projection reports it. TargetProject and TargetDataset: where its DDL
/// acted (statistics' ddlTargetTable, Routine or Dataset), for the Search Objects index's stale marks. ScriptStartLine,
/// ScriptStartColumn, ScriptFrameCount, InProcedure and ScriptEvaluationKind come from statistics.scriptStatistics (the
/// frame's SQL text is never read or kept) for binding #Name result markers.</summary>
internal sealed record BigQueryChild(string Id, string? Location, long Created, bool Done, string? StatementType, ErrorProto? Error, long? DmlAffected, string? Ddl,
    string? TargetProject = null, string? TargetDataset = null, int? ScriptStartLine = null, int? ScriptStartColumn = null, int ScriptFrameCount = 0, bool InProcedure = false,
    string? ScriptEvaluationKind = null);

/// <summary>
/// A query tab's BigQuery session (docs/bigquery.md, Sessions), keyed by Varia's tab id. BigQuery's own session id never
/// leaves the backend. Every job carrying the session id goes through <see cref="Queue"/>, since BigQuery runs one query
/// per session at a time and refuses another rather than waiting.
/// </summary>
internal sealed class BigQueryTabSession(string tabId, BigQueryConnection connection)
{
    public string TabId { get; } = tabId;
    public BigQueryConnection Connection { get; } = connection;
    public SemaphoreSlim Queue { get; } = new(1, 1);
    /// <summary>BigQuery's session id, once a job created it; null before the first execution and in emulator mode.</summary>
    public string? Id { get; set; }
    public string? Location { get; set; }
    public BigQueryTransaction Transaction { get; set; }
    public BigQueryTail? Tail { get; set; }
    /// <summary>A job a stopped re-attach could not cancel (its identity check or the cancel failed): the next close says the
    /// outcome is unknown, naming it.</summary>
    public string? CancelUnconfirmed { get; set; }
    readonly Queue<string> inserted = new();
    /// <summary>Records a job this session's execution inserted (the newest 64 are kept).</summary>
    public void AddInserted(string jobId) { lock (inserted) { inserted.Enqueue(jobId); if (inserted.Count > 64) inserted.Dequeue(); } }
    /// <summary>Whether this session (on its one connection) inserted the job: a re-attach to it needs no jobs.list.</summary>
    public bool HasInserted(string jobId) { lock (inserted) return inserted.Contains(jobId); }
    /// <summary>The execution holding the queue, and whether Varia stopped it; Stop issues its jobs.cancel.</summary>
    public Action? StopActive { get; set; }
    public bool ActiveCancelled { get; set; }
    /// <summary>Leave it running for the execution holding the queue: it ends with status detached, and its job stays the
    /// session's tail (docs/bigquery.md, Re-attaching to jobs).</summary>
    public Action? DetachActive { get; set; }
    /// <summary>Whether the execution holding the queue has a job running in BigQuery: inserted or re-attached and not yet
    /// DONE. Before its insert, or while it reads a finished job's rows, there is nothing to leave running.</summary>
    public volatile bool ActiveJob;
    /// <summary>Whether the execution holding the queue follows a running job in another BigQuery session (a re-attach that
    /// did not adopt it): a close leaves that job running, as it belongs to that session.</summary>
    public volatile bool FollowsJob;
    public bool Active => StopActive is not null;
    /// <summary>The job key of the tab's last execution or attach, so bigquery.endIdleSessions can keep a kept tab's session.</summary>
    public string? LastJobKey { get; set; }
    /// <summary>Whether the session holds a job: one running in it in BigQuery that Varia has not cancelled, or a detached one.
    /// An execution before its insert, or reading a finished job's rows, holds nothing.</summary>
    public bool HoldsJob => ActiveJob && !ActiveCancelled || Tail is { Holds: true };
}

/// <summary>What a close found when it settled the session's last job.</summary>
internal readonly record struct BigQuerySettled(bool Done, bool Committed, bool SawCommit = false, bool ListingComplete = true);

internal sealed partial class BigQueryService
{
    private readonly ConcurrentDictionary<string, BigQueryTabSession> sessions = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource stopping = new();
    /// <summary>Cancelled when the backend stops: background work outside a request (the index marks of an unsettled job) ends with it.</summary>
    internal CancellationToken Stopping => stopping.Token;

    /// <summary>jobs.list's page size for a script's children, and how many pages a full listing reads before it counts as
    /// cut short (the transaction is then unknown).</summary>
    internal int ChildPageSize { get; set; } = 200;
    /// <summary>The first page size of a listing between polls, which stops at the first child already read.</summary>
    internal int IncrementalChildPageSize { get; set; } = 20;
    internal int MaxChildPages { get; set; } = 500;
    /// <summary>A children page's byte limit: full jobs carry each statement's SQL (up to 1 MB), so a larger page is asked again
    /// with a quarter of the jobs (the retries count apart from the pages), and each page that fits doubles the next, up to
    /// <see cref="ChildPageSize"/> and half any size that was too large. 200 a page over 500 pages reads up to 100,000 short
    /// statements; long ones fill pages sooner, so fewer are read before the listing counts as cut short.</summary>
    internal int ChildPageBytes { get; set; } = 16 << 20;
    /// <summary>How long one getQueryResults call waits on a running parent before its children are listed again.</summary>
    internal int ChildPollMs { get; set; } = 2000;
    /// <summary>The wait between jobs.get calls on a job Varia waits to reach DONE.</summary>
    internal TimeSpan DonePoll { get; set; } = TimeSpan.FromSeconds(1);
    /// <summary>A close's budgets inside query.session.close's deadlines (60 s for a commit, 30 s otherwise): a
    /// cancelled job's DONE and listing, the commit's insert and lookups, and the abort.</summary>
    internal TimeSpan CloseWaitLimit { get; set; } = TimeSpan.FromSeconds(20);
    internal TimeSpan CommitWaitLimit { get; set; } = TimeSpan.FromSeconds(25);
    internal TimeSpan CommitLimit { get; set; } = TimeSpan.FromSeconds(25);
    internal TimeSpan AbortLimit { get; set; } = TimeSpan.FromSeconds(8);
    /// <summary>A pending abort after a commit with an unknown outcome: its polling interval, how long a COMMIT not found is
    /// waited for before it counts as never created, and when the abort gives up and leaves the session to expire.</summary>
    internal TimeSpan PendingPoll { get; set; } = TimeSpan.FromSeconds(5);
    internal TimeSpan PendingNotFound { get; set; } = TimeSpan.FromMinutes(2);
    internal TimeSpan PendingLimit { get; set; } = TimeSpan.FromMinutes(10);
    /// <summary>Test seam: pending aborts still running.</summary>
    internal int PendingAborts => Volatile.Read(ref pendingAborts);
    private int pendingAborts;

    public const string ExpiredNotice = "This query started a new BigQuery session. The previous session expired (BigQuery ends a session after 24 hours idle or 7 days), so its temp tables, variables and any open transaction are gone.";
    public const string ExpiredCommit = "The BigQuery session expired (BigQuery ends a session after 24 hours idle or 7 days), so its temp tables, variables and open transaction are gone. Nothing was committed.";

    /// <summary>The tab's session on this handle, created empty on first use. A session left from an earlier handle (the
    /// tab was reconnected) is replaced.</summary>
    internal BigQueryTabSession Session(string tabId, BigQueryConnection connection) =>
        sessions.AddOrUpdate(tabId, _ => new BigQueryTabSession(tabId, connection), (_, existing) => existing.Connection == connection ? existing : new BigQueryTabSession(tabId, connection));

    internal BigQueryTabSession? FindSession(string tabId) => sessions.GetValueOrDefault(tabId);

    /// <summary>A tab adopting BigQuery session <paramref name="sessionId"/> takes it from any other tab that held it (a
    /// re-attach from another tab): that tab's session leaves the map unended, so closing it never aborts the adopted one.</summary>
    internal void ForgetOthers(BigQueryTabSession adopting, string sessionId)
    {
        foreach (var item in sessions.Where(item => item.Value != adopting && item.Value.Id == sessionId)) Forget(item.Value);
    }
    /// <summary>Whether another tab's session is the same BigQuery session and still uses it (an execution, or a job it
    /// holds): an adopt then reads outside it rather than share its queue or abort it under that tab.</summary>
    internal bool UsedElsewhere(BigQueryTabSession adopting, string sessionId) =>
        sessions.Values.Any(other => other != adopting && other.Id == sessionId && (other.Active || other.Tail is not null));
    internal bool OwnsSession(string tabId) => sessions.ContainsKey(tabId);

    /// <summary>Removes the tab's session from the map if it is still this one: any close that answers ok does, so the next
    /// state read answers SESSION_CLOSED and the next execution starts a new session.</summary>
    internal void Forget(BigQueryTabSession session) => ((ICollection<KeyValuePair<string, BigQueryTabSession>>)sessions).Remove(new(session.TabId, session));

    /// <summary>A Disconnect drops the handle's sessions from the map and answers the idle ones BigQuery made, which it then
    /// ends; a session holding a running or detached job is left to BigQuery.</summary>
    List<BigQueryTabSession> ForgetSessions(BigQueryConnection connection)
    {
        var idle = new List<BigQueryTabSession>();
        foreach (var item in sessions.Where(item => item.Value.Connection == connection))
        {
            Forget(item.Value);
            if (!item.Value.HoldsJob && item.Value.Id is not null) idle.Add(item.Value);
        }
        return idle;
    }

    /// <summary>The transaction after one statement: BEGIN opens it, a successful COMMIT or ROLLBACK closes it, and any
    /// failed statement inside it leaves it possibly open (BigQuery names no reason for an aborted transaction, so Varia
    /// never reads message text).</summary>
    internal static BigQueryTransaction Apply(BigQueryTransaction state, string? statement, bool failed)
    {
        if (failed) return state == BigQueryTransaction.None ? BigQueryTransaction.None : BigQueryTransaction.Unknown;
        return statement switch
        {
            "BEGIN_TRANSACTION" => BigQueryTransaction.Open,
            "COMMIT_TRANSACTION" or "ROLLBACK_TRANSACTION" => BigQueryTransaction.None,
            _ => state
        };
    }

    internal static string? StatementOf(JobStatistics? statistics) =>
        statistics?.Query?.StatementType is { Length: > 0 and <= 64 } type && type.All(c => char.IsAsciiLetterUpper(c) || c == '_') ? type : null;

    /// <summary>
    /// A job's children (jobs.list with parentJobId), in statement order: ascending creation time, ties broken by job id.
    /// The full projection, because the minimal one leaves out statistics.query (the statement type, rows affected and DDL
    /// target). Full jobs carry their configuration and so each statement's SQL: each page is read as JSON under
    /// <see cref="ChildPageBytes"/>, a page too large is asked again with fewer jobs (see there), and only the fields <see cref="Child"/>
    /// names are decoded (the SQL is never kept). <paramref name="known"/> makes the listing incremental: BigQuery lists
    /// newest first, so paging stops at the first child already seen DONE. Otherwise every page is read up to
    /// <see cref="MaxChildPages"/>; <c>Complete</c> is false when that, or one child too large to read, cut it short. Only
    /// jobs naming this parent are kept.
    /// </summary>
    internal async Task<(List<BigQueryChild> Children, bool Complete)> ChildrenAsync(BigQueryConnection connection, string project, string parentId, IReadOnlySet<string>? known, CancellationToken token)
    {
        var children = new List<BigQueryChild>();
        string? pageToken = null;
        // A poll between reads usually finds a few new children, so it starts small; a page that fits doubles the next.
        var size = known is null ? ChildPageSize : Math.Min(ChildPageSize, IncrementalChildPageSize);
        // After a page too large, the page grows back to at most half its size, so it settles without asking that size again.
        var ceiling = ChildPageSize;
        var shrinks = 0;
        for (var page = 0; ; page++)
        {
            if (page >= MaxChildPages) return (Order(children), false);
            var service = connection.Client.Service;
            var request = service.Jobs.List(project);
            request.ParentJobId = parentId;
            request.MaxResults = size;
            request.PageToken = pageToken;
            request.Projection = Google.Apis.Bigquery.v2.JobsResource.ListRequest.ProjectionEnum.Full;
            BigQueryPage answer;
            try { answer = await ReadAsync(t => SendRawAsync(service, request, t, ChildPageBytes), token); }
            catch (BigQueryOverLimit)
            {
                // Long statements make a page of full jobs large: fewer a page, and a single child too large to read cuts the listing short.
                if (size == 1 || ++shrinks > MaxChildPages) return (Order(children), false);
                ceiling = Math.Max(1, size / 2);
                size = Math.Max(1, size / 4);
                page--;
                continue;
            }
            size = Math.Min(ceiling, size * 2);
            var stop = false;
            using (answer)
            {
                if (answer.Root.ValueKind == JsonValueKind.Object && answer.Root.TryGetProperty("jobs", out var jobs) && jobs.ValueKind == JsonValueKind.Array)
                    foreach (var item in jobs.EnumerateArray())
                    {
                        if (Child(item, parentId) is not { } child) continue;
                        if (known?.Contains(child.Id) == true) { stop = true; continue; }
                        children.Add(child);
                    }
                pageToken = BigQueryJobHistory.Text(answer.Root, "nextPageToken") is { Length: > 0 and <= BigQueryLimits.PageToken } next && !next.Any(char.IsControl) ? next : null;
            }
            if (stop || pageToken is null) return (Order(children), true);
        }

        static List<BigQueryChild> Order(List<BigQueryChild> list) => [.. list.OrderBy(child => child.Created).ThenBy(child => child.Id, StringComparer.Ordinal)];
    }

    /// <summary>One jobs.list item as a child of <paramref name="parentId"/>: its id, location, creation time, state, error, and
    /// statistics.query's statement type, rows affected and DDL target. Null when it names no usable id or another parent. Its
    /// configuration (the statement's SQL) is never read.</summary>
    internal static BigQueryChild? Child(JsonElement item, string parentId)
    {
        if (item.ValueKind != JsonValueKind.Object) return null;
        var reference = BigQueryJobHistory.Member(item, "jobReference");
        var statistics = BigQueryJobHistory.Member(item, "statistics");
        if (BigQueryJobHistory.Text(reference, "jobId") is not { Length: > 0 and <= 1024 } id || BigQueryJobHistory.Text(statistics, "parentJobId") != parentId) return null;
        var status = BigQueryJobHistory.Member(item, "status");
        var done = BigQueryJobHistory.Text(item, "state") == "DONE" || BigQueryJobHistory.Text(status, "state") == "DONE";
        var query = BigQueryJobHistory.Member(statistics, "query");
        var target = BigQueryJobHistory.Member(query, "ddlTargetTable") ?? BigQueryJobHistory.Member(query, "ddlTargetRoutine") ?? BigQueryJobHistory.Member(query, "ddlTargetDataset");
        var failure = done ? BigQueryJobHistory.Member(status, "errorResult") ?? BigQueryJobHistory.Member(item, "errorResult") : null;
        // Callers read only whether a child failed; its reason and message are kept short.
        var error = failure is { } e ? new ErrorProto { Reason = Bounded(BigQueryJobHistory.Text(e, "reason"), 64), Message = BigQueryJobHistory.Clip(BigQueryJobHistory.Text(e, "message"), 1024) } : null;
        // statistics.scriptStatistics.stackFrames: 1-based line and column in the submitted script, frame depth and whether
        // the frame is inside a procedure; the frame's SQL text is never decoded.
        var script = BigQueryJobHistory.Member(statistics, "scriptStatistics");
        var evaluationKind = Bounded(BigQueryJobHistory.Text(script, "evaluationKind"), 32);
        int? scriptStartLine = null;
        int? scriptStartColumn = null;
        var scriptFrameCount = 0;
        var inProcedure = false;
        if (script is { } s && s.TryGetProperty("stackFrames", out var frames) && frames.ValueKind == JsonValueKind.Array)
        {
            scriptFrameCount = frames.GetArrayLength();
            if (scriptFrameCount == 1 && frames[0].ValueKind == JsonValueKind.Object)
            {
                var frame = frames[0];
                if (BigQueryJobHistory.Number(frame, "startLine") is >= 1 and <= int.MaxValue and var startLine) scriptStartLine = (int)startLine;
                if (BigQueryJobHistory.Number(frame, "startColumn") is >= 1 and <= int.MaxValue and var startColumn) scriptStartColumn = (int)startColumn;
                inProcedure = BigQueryJobHistory.Text(frame, "procedureId") is { Length: > 0 };
            }
            else if (scriptFrameCount > 1)
            {
                for (var i = 0; i < scriptFrameCount; i++)
                    if (frames[i].ValueKind == JsonValueKind.Object && BigQueryJobHistory.Text(frames[i], "procedureId") is { Length: > 0 }) { inProcedure = true; break; }
            }
        }
        return new(id, Bounded(BigQueryJobHistory.Text(reference, "location"), BigQueryLimits.Location), BigQueryJobHistory.Number(statistics, "creationTime") ?? 0, done,
            StatementOf(new JobStatistics { Query = new JobStatistics2 { StatementType = BigQueryJobHistory.Text(query, "statementType") } }), error,
            BigQueryJobHistory.Number(query, "numDmlAffectedRows"), Bounded(BigQueryJobHistory.Text(query, "ddlOperationPerformed"), 64),
            Bounded(BigQueryJobHistory.Text(target, "projectId"), 128), Bounded(BigQueryJobHistory.Text(target, "datasetId"), 1024),
            scriptStartLine, scriptStartColumn, scriptFrameCount, inProcedure, evaluationKind);

        static string? Bounded(string? name, int max) => name is { Length: > 0 } && name.Length <= max ? name : null;
    }

    /// <summary>Polls jobs.get until the job is DONE.</summary>
    internal async Task<Job> WaitDoneAsync(BigQueryConnection connection, string project, string jobId, string? location, CancellationToken token)
    {
        while (true)
        {
            var job = await GetJobAsync(connection, project, jobId, location, token);
            if (job.Status?.State == "DONE") return job;
            await Task.Delay(DonePoll, token);
        }
    }

    /// <summary>Cancels a job once the re-attach identity check proves it is this account's (a Stop that came first). Own is the
    /// checked job (null when the check failed, so the job was left alone); Cancelled says BigQuery took the cancel or the job
    /// had finished. Bounded to fit within a close's wait, which waits for the stopped attach.</summary>
    internal async Task<(Job? Own, bool Cancelled)> CancelOwnJobAsync(BigQueryConnection connection, string jobId, string? location, bool inserted)
    {
        using var lease = connection.Lease();
        if (lease is null) return (null, false);
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
        limit.CancelAfter(OwnCancelLimit);
        Job own;
        try { own = await OwnJobAsync(connection, jobId, location, limit.Token, inserted); }
        catch (Exception) { return (null, false); }
        if (own.Status?.State == "DONE") return (own, true);
        try
        {
            var request = connection.Client.Service.Jobs.Cancel(connection.Options.Project, jobId);
            request.Location = own.JobReference?.Location ?? location;
            await ReadAsync(t => request.ExecuteAsync(t), limit.Token);
            return (own, true);
        }
        catch (Exception) { return (own, false); }
    }
    internal TimeSpan OwnCancelLimit { get; set; } = TimeSpan.FromSeconds(15);

    /// <summary>jobs.cancel, best-effort: BigQuery may already have finished the job, and may still bill work done before it
    /// stops. Leases the client, so a Stop that comes with a Disconnect still reaches BigQuery. With <paramref name="maybeUnborn"/>
    /// the job's insert was cut off in flight, so BigQuery may still be creating it: a 404 is asked again for a while
    /// (<see cref="UnbornCancelLimit"/>) rather than read as a job that never ran.</summary>
    internal void CancelJob(BigQueryConnection connection, string project, string jobId, string? location, bool maybeUnborn = false)
    {
        var lease = connection.Lease();
        if (lease is null) return;
        _ = Task.Run(async () =>
        {
            using (lease)
            {
                try
                {
                    using var limit = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
                    limit.CancelAfter(maybeUnborn ? UnbornCancelLimit + TimeSpan.FromSeconds(15) : TimeSpan.FromSeconds(15));
                    var request = connection.Client.Service.Jobs.Cancel(project, jobId);
                    request.Location = location;
                    var giveUp = DateTime.UtcNow + UnbornCancelLimit;
                    while (true)
                    {
                        try { await ReadAsync(t => request.ExecuteAsync(t), limit.Token); return; }
                        catch (GoogleApiException error) when (maybeUnborn && error.HttpStatusCode == HttpStatusCode.NotFound && DateTime.UtcNow < giveUp) { await Task.Delay(UnbornCancelPoll, limit.Token); }
                    }
                }
                catch (Exception) { /* Best-effort: the next execution and the close wait for DONE either way. */ }
            }
        });
    }
    /// <summary>How long a cancel of a job whose insert was cut off keeps asking while jobs.cancel answers 404, and how often.</summary>
    internal TimeSpan UnbornCancelLimit { get; set; } = TimeSpan.FromSeconds(10);
    internal TimeSpan UnbornCancelPoll { get; set; } = TimeSpan.FromMilliseconds(500);

    /// <summary>
    /// Waits for the session's last job to reach DONE and applies what it ran: its children in statement order when it has
    /// any (a listing that fails or is cut short makes the transaction unknown), its own statement type otherwise.
    /// <c>Committed</c> says a cancelled job's children include a COMMIT TRANSACTION that succeeded.
    /// </summary>
    internal async Task<BigQuerySettled> SettleAsync(BigQueryTabSession session, CancellationToken token, bool waitUnborn = false)
    {
        if (session.Tail is not { } tail) return new(true, false);
        var connection = session.Connection;
        var project = connection.Options.Project;
        Job job;
        if (!tail.Created && waitUnborn)
        {
            var unbornWatch = System.Diagnostics.Stopwatch.StartNew();
            while (true)
            {
                try { job = await WaitDoneAsync(connection, project, tail.JobId, tail.Location, token); break; }
                catch (GoogleApiException error) when (error.HttpStatusCode == HttpStatusCode.NotFound)
                {
                    var remaining = UnbornCancelLimit - unbornWatch.Elapsed;
                    if (remaining <= TimeSpan.Zero)
                    {
                        session.Tail = null;
                        return new(true, false);
                    }
                    await Task.Delay(TimeSpan.FromTicks(Math.Min(UnbornCancelPoll.Ticks, remaining.Ticks)), token);
                }
            }
        }
        else
        {
            try { job = await WaitDoneAsync(connection, project, tail.JobId, tail.Location, token); }
            catch (GoogleApiException error) when (!tail.Created && error.HttpStatusCode == HttpStatusCode.NotFound)
            {
                // The insert never created the job, so nothing ran and the session is free.
                session.Tail = null;
                return new(true, false);
            }
        }
        CaptureSession(session, job, tail.Location);
        var sawCommit = false;
        var listingComplete = true;
        if (session.Id is not null)
        {
            try
            {
                // Only a script has children; listing a single statement would need bigquery.jobs.list for nothing.
                var script = StatementOf(job.Statistics) == "SCRIPT" || job.Statistics?.NumChildJobs > 0;
                var (children, complete) = script ? await ChildrenAsync(connection, project, tail.JobId, null, token) : ([], true);
                if (script && job.Statistics?.NumChildJobs is { } expectedChildren && children.Count < expectedChildren)
                    complete = false;
                if (!script && children.Count == 0 && complete)
                {
                    var stmt = StatementOf(job.Statistics);
                    var failed = job.Status?.ErrorResult is not null;
                    if (stmt == "COMMIT_TRANSACTION" && !failed) sawCommit = true;
                    session.Transaction = Apply(session.Transaction, stmt, failed);
                }
                else
                {
                    foreach (var child in children)
                    {
                        if (!child.Done) complete = false;
                        session.Transaction = Apply(session.Transaction, child.StatementType, child.Error is not null || !child.Done);
                        if (child.StatementType == "COMMIT_TRANSACTION" && child.Done && child.Error is null) sawCommit = true;
                    }
                    if (!complete) session.Transaction = BigQueryTransaction.Unknown;
                    else if (job.Status?.ErrorResult is not null && !children.Any(c => c.Error is not null || !c.Done))
                        session.Transaction = Apply(session.Transaction, StatementOf(job.Statistics), failed: true);
                }
                listingComplete = complete;
            }
            catch (Exception) when (!token.IsCancellationRequested)
            {
                session.Transaction = BigQueryTransaction.Unknown;
                listingComplete = false;
            }
        }
        session.Tail = null;
        return new(true, tail.Cancelled && sawCommit, sawCommit, listingComplete);
    }

    /// <summary>Keeps the session id a job reports (statistics.sessionInfo) when it is one Varia can keep.</summary>
    internal static void CaptureSession(BigQueryTabSession session, Job job, string? location)
    {
        if (session.Id is not null || job.Statistics?.SessionInfo?.SessionId is not { } id || !BigQuerySql.SessionId().IsMatch(id)) return;
        session.Id = id;
        session.Location ??= location;
    }

    /// <summary>Whether a failure says the session is gone (expired after 24 hours idle or 7 days, or ended). BigQuery names
    /// no reason for it, so its message is read here and only here.</summary>
    internal static bool SessionGone(Exception error, string? sessionId)
    {
        for (var current = error; current is not null; current = current.InnerException)
        {
            if (current is BigQueryJobException job) return BigQueryErrors.IsSessionGone(job.Result.Message, sessionId);
            if (current is GoogleApiException api && (int)api.HttpStatusCode is >= 400 and < 500) return BigQueryErrors.IsSessionGone(api.Error?.Message ?? api.Message, sessionId);
        }
        return false;
    }

    /// <summary>A transport failure before any byte of the request left: the name did not resolve or the connection was
    /// refused or unreachable. Such a request was never submitted.</summary>
    internal static bool NotSent(Exception error)
    {
        for (var current = error; current is not null; current = current.InnerException)
        {
            if (current is HttpRequestException { HttpRequestError: HttpRequestError.NameResolutionError or HttpRequestError.ConnectionError }) return true;
            if (current is SocketException { SocketErrorCode: SocketError.HostNotFound or SocketError.TryAgain or SocketError.NoData or SocketError.ConnectionRefused
                or SocketError.NetworkUnreachable or SocketError.HostUnreachable or SocketError.NetworkDown or SocketError.AddressNotAvailable }) return true;
        }
        return false;
    }

    /// <summary>An insert that created no job: refused outright (a 4xx other than a timeout or conflict, including
    /// non-ambiguous 429 rate-limit rejections), a pre-send auth/disposed client failure, or never sent.</summary>
    internal static bool NeverCreated(Exception error) =>
        error is not BigQueryJobMayExist && (NotSent(error) || PreSendClientFailure(error)
            || error is GoogleApiException api && (int)api.HttpStatusCode is >= 400 and < 500
                && api.HttpStatusCode is not (HttpStatusCode.Conflict or HttpStatusCode.RequestTimeout));

    /// <summary>The byte cap on Varia's own session jobs (COMMIT TRANSACTION and ABORT_SESSION), which bill nothing, so no job
    /// Varia submits is uncapped: BigQuery's 10 MiB minimum for a billed query, whatever lower cap the connection sets, so the
    /// cap can never refuse a commit (a refused commit rolls the transaction back).</summary>
    internal const long SessionControlCap = 10L << 20;

    Job SessionJob(BigQueryTabSession session, string sql, string jobId) => new()
    {
        JobReference = new JobReference { ProjectId = session.Connection.Options.Project, JobId = jobId, Location = session.Location },
        Configuration = new JobConfiguration
        {
            Labels = new Dictionary<string, string>(Labels),
            Query = new JobConfigurationQuery
            {
                Query = sql, UseLegacySql = false, MaximumBytesBilled = SessionControlCap,
                ConnectionProperties = [new ConnectionProperty { Key = "session_id", Value = session.Id }]
            }
        }
    };

    /// <summary>
    /// CALL BQ.ABORT_SESSION outside the session, so it never waits behind a job of it, waited to DONE within
    /// <see cref="AbortLimit"/>. A session BigQuery reports gone has ended all the same: <c>Expired</c>.
    /// </summary>
    internal async Task<(bool Ended, bool Expired, string? Error)> AbortAsync(BigQueryConnection connection, string sessionId, string? location, CancellationToken token)
    {
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
        limit.CancelAfter(AbortLimit);
        var project = connection.Options.Project;
        var jobId = NewJobId();
        var job = new Job
        {
            JobReference = new JobReference { ProjectId = project, JobId = jobId, Location = location },
            Configuration = new JobConfiguration
            {
                Labels = new Dictionary<string, string>(Labels),
                Query = new JobConfigurationQuery
                {
                    Query = BigQuerySql.AbortSession, UseLegacySql = false, ParameterMode = "NAMED", MaximumBytesBilled = SessionControlCap,
                    QueryParameters = [new QueryParameter
                    {
                        Name = BigQuerySql.AbortSessionParameter, ParameterType = new QueryParameterType { Type = "STRING" },
                        ParameterValue = new QueryParameterValue { Value = sessionId }
                    }]
                }
            }
        };
        try
        {
            var inserted = await InsertJobAsync(connection, job, null, limit.Token);
            var done = inserted.Status?.State == "DONE" ? inserted : await WaitDoneAsync(connection, project, jobId, inserted.JobReference?.Location ?? location, limit.Token);
            if (BigQueryJobException.Of(done) is { } failed) throw failed;
            return (true, false, null);
        }
        catch (Exception error) when (SessionGone(error, sessionId)) { return (true, true, null); }
        catch (Exception error) when (!token.IsCancellationRequested)
        {
            var mapped = error is BigQueryJobException failed ? BigQueryErrors.Job(failed.Result, failed.Errors, project, null) : BigQueryErrors.Map(error, project) as RequestException;
            return (false, false, mapped?.Message ?? "BigQuery did not end the session in time.");
        }
    }

    /// <summary>
    /// After a commit whose outcome is unknown: waits for the COMMIT job to reach DONE, then aborts the session, so an
    /// abort never races a commit. A COMMIT still not found after <see cref="PendingNotFound"/> was never created, and the
    /// session is aborted then. Holds its own lease on the client, so it survives Disconnect; gives up after
    /// <see cref="PendingLimit"/>, or when the backend stops, and the session is left to expire.
    /// </summary>
    internal void PendingAbort(BigQueryConnection connection, string sessionId, string? location, string commitJobId, string? commitLocation)
    {
        var lease = connection.Lease();
        if (lease is null) return;
        Interlocked.Increment(ref pendingAborts);
        _ = Task.Run(async () =>
        {
            using (lease)
            {
                try
                {
                    using var limit = CancellationTokenSource.CreateLinkedTokenSource(stopping.Token);
                    limit.CancelAfter(PendingLimit);
                    var started = System.Diagnostics.Stopwatch.StartNew();
                    var project = connection.Options.Project;
                    while (true)
                    {
                        try
                        {
                            var job = await GetJobAsync(connection, project, commitJobId, commitLocation, limit.Token);
                            if (job.Status?.State == "DONE") break;
                        }
                        catch (GoogleApiException error) when (error.HttpStatusCode == HttpStatusCode.NotFound && started.Elapsed >= PendingNotFound) { break; }
                        catch (Exception) when (!limit.IsCancellationRequested) { }
                        await Task.Delay(PendingPoll, limit.Token);
                    }
                    await AbortAsync(connection, sessionId, location, limit.Token);
                }
                catch (Exception) { /* Left to expire, as a crash would leave it. */ }
                finally { Interlocked.Decrement(ref pendingAborts); }
            }
        });
    }

    /// <summary>query.session.state for a BigQuery tab: the tracked transaction, read without a request to BigQuery. An
    /// execution holding the session answers SESSION_BUSY; a session whose last job is not yet DONE and read answers
    /// unchecked, as an unknown transaction does.</summary>
    internal SessionState State(string tabId)
    {
        if (!sessions.TryGetValue(tabId, out var session)) throw new RequestException("SESSION_CLOSED", "This query has no open BigQuery session.");
        if (session.Active && !session.ActiveCancelled) throw new RequestException("SESSION_BUSY", "A query is running in this tab.");
        // job: a detached job (or one held after a network failure) the background poll has not yet seen DONE.
        var job = session.Tail is { Holds: true } ? "running" : "none";
        if (session.Tail is not null || session.Active) return new SessionState(0, false, job);
        return session.Transaction switch
        {
            BigQueryTransaction.Open => new SessionState(1, true, job),
            BigQueryTransaction.Unknown => new SessionState(0, false, job),
            _ => new SessionState(0, true, job)
        };
    }

    /// <summary>
    /// query.session.close for a BigQuery tab (docs/bigquery.md, Sessions). Commit runs COMMIT TRANSACTION in
    /// the session, then ends it; rollback and a plain close end it (ABORT_SESSION, which ends the transaction with it).
    /// A session holding a running job is never aborted: a commit or rollback close is refused with JOB_RUNNING, and a
    /// plain close leaves the session. A job Varia cancelled is waited for (20 s, or 25 s for a commit) so the abort never
    /// races it. Any close that answers ok removes the session from the map; the note says what became of a commit or of
    /// the session's end.
    /// </summary>
    internal async Task<SessionCloseResult> CloseAsync(string tabId, string? transaction, bool abortOnRefusedCommit, CancellationToken token, bool keepJob = false, bool cancelJob = false)
    {
        if (!sessions.TryGetValue(tabId, out var session)) return new SessionCloseResult(false);
        var commit = transaction == "commit";
        var connection = session.Connection;
        if (session.Active && !session.ActiveCancelled)
        {
            // Cancel the job stops the tab's execution; the stopped job is then waited for below.
            if (cancelJob) session.StopActive?.Invoke();
            else if (transaction is not null) throw JobRunning(commit);
            // Nothing running in BigQuery (before the insert, or reading a finished job's rows) and no held job it waits behind:
            // the execution stops and the close goes on as usual, so a transaction the job left is asked about (JOB_FINISHED for
            // keepJob), never leaked.
            else if (!session.ActiveJob && session.Tail is not { Holds: true })
            {
                // Leave it running never stops: a re-attach still checking its job's identity leaves the job alone.
                if (session.FollowsJob || keepJob) session.DetachActive?.Invoke();
                else session.StopActive?.Invoke();
            }
            else
            {
                // The safety net: a plain close or Leave it running never aborts a session holding a job. The execution ends
                // detached, and its job carries on in BigQuery with the session.
                session.DetachActive?.Invoke();
                Forget(session);
                return new SessionCloseResult(true);
            }
        }
        var waitLimit = commit ? CommitWaitLimit : CloseWaitLimit;
        using var wait = CancellationTokenSource.CreateLinkedTokenSource(token);
        wait.CancelAfter(waitLimit);
        var entered = false;
        try
        {
            try { await session.Queue.WaitAsync(wait.Token); entered = true; }
            catch (OperationCanceledException) when (!token.IsCancellationRequested) { }
            if (!entered)
            {
                // The stopped execution has not let go of the session in time.
                if (commit) throw JobRunning(true);
                return await EndAsync(session, Note("outcomeUnknown", jobId: session.Tail?.JobId), token);
            }
            SessionCloseNote? note = session.CancelUnconfirmed is { } unconfirmed ? Note("outcomeUnknown", jobId: unconfirmed) : null;
            session.CancelUnconfirmed = null;
            if (session.Tail is { } tail)
            {
                if (!tail.Cancelled)
                {
                    // A job cut off by a network failure: the session still holds it unless it has finished meanwhile.
                    var finished = false;
                    try
                    {
                        using var look = CancellationTokenSource.CreateLinkedTokenSource(token);
                        look.CancelAfter(TimeSpan.FromSeconds(5));
                        var job = await GetJobAsync(connection, connection.Options.Project, tail.JobId, tail.Location, look.Token);
                        finished = job.Status?.State == "DONE";
                    }
                    catch (GoogleApiException error) when (!tail.Created && error.HttpStatusCode == HttpStatusCode.NotFound) { finished = true; }
                    catch (Exception) when (!token.IsCancellationRequested) { }
                    if (!finished && cancelJob)
                    {
                        // Cancel the job: the held job is cancelled, then waited for and settled as a stopped one.
                        tail.Cancelled = true;
                        CancelJob(connection, connection.Options.Project, tail.JobId, tail.Location);
                    }
                    else if (!finished)
                    {
                        if (transaction is not null) throw JobRunning(commit);
                        Forget(session);
                        return new SessionCloseResult(true);
                    }
                }
                BigQuerySettled settled;
                try { settled = await SettleAsync(session, wait.Token); }
                catch (Exception) when (!token.IsCancellationRequested) { settled = new(false, false); }
                if (!settled.Done)
                {
                    // Not DONE in time: a commit runs nothing and keeps the session; any other close ends it anyway, since a
                    // script may still have committed.
                    if (commit) throw JobRunning(true);
                    return await EndAsync(session, Note("outcomeUnknown", jobId: tail.JobId), token);
                }
                if (settled.Committed) note = Note("committedBeforeCancel", jobId: tail.JobId);
            }
            // Leave it running on a job that finished meanwhile is a normal close, unless the job left a transaction open (or
            // possibly open): that is never rolled back unasked, so the close is refused and the next close asks.
            if (keepJob && transaction is null && note is null && session.Id is not null && session.Transaction != BigQueryTransaction.None)
                throw new RequestException("JOB_FINISHED", "The BigQuery job finished before it could be left running, and its session may hold an open transaction. The query stays open; close it again to commit or roll back.");
            if (commit && session.Transaction != BigQueryTransaction.None && session.Id is not null)
            {
                // A stopped script's commit (note) is stated by whatever the commit itself comes to.
                try
                {
                    var committed = await CommitAsync(session, abortOnRefusedCommit, token);
                    if (committed is not null) return note is null ? committed : committed with { Note = Note(committed.Note!.Code, Join(note, committed.Note.Message), committed.Note.JobId) };
                }
                catch (FallThrough fall)
                {
                    // A refused commit on an unchecked session ends it, still holding the queue; an end that fails answers
                    // abortFailed, carrying BigQuery's commit message.
                    return await EndAsync(session, note is null ? fall.Note : Note(fall.Note.Code, Join(note, fall.Note.Message), fall.Note.JobId), token);
                }
                catch (RequestException error) when (note is not null) { throw new RequestException(error.Code, Join(note, error.Message)); }
            }
            return await EndAsync(session, note, token);
        }
        finally { if (entered) session.Queue.Release(); }
    }

    static RequestException JobRunning(bool commit) => new("JOB_RUNNING", (commit ? "The transaction was not committed" : "The transaction was not rolled back")
        + ": a job is still running in this tab's BigQuery session, and ending the session would stop it. The tab stays open; close it again once the job finishes.");

    static SessionCloseNote Note(string code, string? message = null, string? jobId = null) =>
        new(code, message is { Length: > 2000 } ? message[..2000] + "…" : message, jobId is { Length: > 0 and <= 1024 } ? jobId : null);

    /// <summary>Ends the session (when BigQuery made one) and removes it from the map. A failed abort answers abortFailed;
    /// a session found expired answers sessionExpired when it had a tracked transaction, which expiry rolled back.</summary>
    async Task<SessionCloseResult> EndAsync(BigQueryTabSession session, SessionCloseNote? note, CancellationToken token)
    {
        Forget(session);
        if (session.Id is not { } id) return new SessionCloseResult(true, note);
        var tracked = session.Transaction != BigQueryTransaction.None;
        var (ended, expired, error) = await AbortAsync(session.Connection, id, session.Location, token);
        // A failed end outranks the note it carried, whose fact leads its message, since the session then stays open; it is
        // retried once the next time a handle reaches BigQuery.
        if (!ended) RememberFailedAbort(session.Connection, id, session.Location);
        if (!ended) return new SessionCloseResult(true, Note("abortFailed", note is null ? error : Prior(note) + " " + error, note?.JobId));
        if (expired && tracked && note is null) return new SessionCloseResult(true, Note("sessionExpired"));
        return new SessionCloseResult(true, note);
    }

    static string Join(SessionCloseNote prior, string? message) => message is { Length: > 0 } ? Prior(prior) + " " + message : Prior(prior);

    static string Prior(SessionCloseNote note) => note.Code switch
    {
        "commitNotApplied" => "The transaction was not committed: " + note.Message,
        "committedBeforeCancel" => "The stopped job committed a transaction before it stopped.",
        "outcomeUnknown" => "Varia could not learn whether the stopped job committed.",
        _ => ""
    };

    private readonly record struct CommitCoreDetail(
        MultiCommitResult Result,
        string JobId,
        Exception? RawError = null,
        bool Retryable = false,
        bool ConnectionLost = false,
        bool Cancelled = false);

    /// <summary>
    /// Shared commit core returning a structured <see cref="MultiCommitResult"/> (Committed, Refused, CancelledBeforeSend,
    /// or InDoubt). <see cref="MultiCommitOutcome.InDoubt"/> guarantees <see cref="Unknown"/>/<see cref="PendingAbort"/>
    /// has already started. Sets <c>maySent = true</c> immediately before <c>Jobs.Insert</c> (resetting only on
    /// <see cref="NotSent"/> before retry) so mid-insert cancellation always transitions to InDoubt.
    /// </summary>
    internal async Task<MultiCommitResult> CommitCoreAsync(BigQueryTabSession session, CancellationToken token) =>
        (await CommitCoreDetailedAsync(session, token)).Result;

    /// <summary>
    /// Commits an ephemeral multi-query session and ensures the session never leaks for 24h: calls <see cref="AbortAsync"/>
    /// (with a fresh bounded token, remembering failed aborts) on Committed, Refused, or CancelledBeforeSend; on InDoubt
    /// returns InDoubt without calling <see cref="AbortAsync"/> or double-calling <see cref="PendingAbort"/>.
    /// </summary>
    internal async Task<MultiCommitResult> CommitEphemeralSessionAsync(BigQueryTabSession session, CancellationToken token)
    {
        if (session.Id is not { } sessionId) return new MultiCommitResult(MultiCommitOutcome.Committed);
        var detail = await CommitCoreDetailedAsync(session, token);
        if (detail.Result.Outcome == MultiCommitOutcome.InDoubt) return detail.Result;
        await AbortEphemeralSessionAsync(session.Connection, sessionId, session.Location);
        return detail.Result;
    }

    /// <summary>Ends an ephemeral multi-query session using a fresh bounded token, remembering failed aborts for retry.</summary>
    internal async Task<bool> AbortEphemeralSessionAsync(BigQueryConnection connection, string sessionId, string? location, CancellationToken token = default)
    {
        using var linked = token.CanBeCanceled
            ? CancellationTokenSource.CreateLinkedTokenSource(stopping.Token, token)
            : null;
        var effective = linked?.Token ?? stopping.Token;
        try
        {
            var (ended, _, _) = await AbortAsync(connection, sessionId, location, effective);
            if (!ended) RememberFailedAbort(connection, sessionId, location);
            return ended;
        }
        catch (Exception) when (stopping.IsCancellationRequested)
        {
            return false;
        }
        catch (Exception)
        {
            RememberFailedAbort(connection, sessionId, location);
            return false;
        }
    }

    /// <summary>Deterministic test seam invoked in <see cref="CommitCoreDetailedAsync"/> immediately before backoff delay after a 429 response.</summary>
    internal Action<CancellationTokenSource>? CommitBackingOff { get; set; }

    async Task<CommitCoreDetail> CommitCoreDetailedAsync(BigQueryTabSession session, CancellationToken token)
    {
        var connection = session.Connection;
        var project = connection.Options.Project;
        var jobId = NewJobId();
        var job = SessionJob(session, BigQuerySql.Commit, jobId);
        using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
        limit.CancelAfter(CommitLimit);
        var maySent = false;
        GoogleApiException? lastRateLimit = null;
        Job? done = null;
        var location = session.Location;
        try
        {
            for (var attempt = 1; done is null && !maySent; attempt++)
            {
                token.ThrowIfCancellationRequested();
                limit.Token.ThrowIfCancellationRequested();
                maySent = true;
                try
                {
                    var inserted = await CallAsync(t => connection.Client.Service.Jobs.Insert(job, project).ExecuteAsync(t), limit.Token);
                    location = inserted.JobReference?.Location ?? location;
                    done = inserted.Status?.State == "DONE" ? inserted : null;
                }
                catch (GoogleApiException error) when (error.HttpStatusCode == HttpStatusCode.TooManyRequests)
                {
                    // Rate limited before job creation: always reset maySent even if caller cancelled concurrently.
                    maySent = false;
                    lastRateLimit = error;
                    if (token.IsCancellationRequested) throw;
                    if (attempt >= InsertAttempts || limit.IsCancellationRequested)
                        return new(new(MultiCommitOutcome.Refused, MapCommitRefusal(session, error, project)), jobId, RawError: error, Retryable: true);
                    CommitBackingOff?.Invoke(limit);
                    await Task.Delay(Backoff(attempt), limit.Token);
                }
                catch (GoogleApiException error) when ((int)error.HttpStatusCode is >= 400 and < 500 && error.HttpStatusCode is not HttpStatusCode.Conflict and not HttpStatusCode.RequestTimeout and not HttpStatusCode.TooManyRequests)
                {
                    return new(new(MultiCommitOutcome.Refused, MapCommitRefusal(session, error, project)), jobId, RawError: error, Retryable: Retryable(error));
                }
                catch (Exception error) when (NotSent(error))
                {
                    // Nothing reached BigQuery: always reset maySent before retry, cancellation, or connection-lost refusal.
                    maySent = false;
                    lastRateLimit = null;
                    if (token.IsCancellationRequested) throw;
                    if (attempt >= InsertAttempts || limit.IsCancellationRequested)
                        return new(new(MultiCommitOutcome.Refused, new MultiTargetError("CONNECTION_LOST", "The transaction was not committed: " + BigQueryErrors.Unreachable)), jobId, ConnectionLost: true);
                    await Task.Delay(Backoff(attempt), limit.Token);
                }
                catch (Exception error) when (PreSendClientFailure(error))
                {
                    // Auth token refresh, pinned-identity check, or disposed client failed before any bytes left the client.
                    // Mark Retryable: true so single-server unchecked-session Close->Commit keeps the tab open instead of falling through to ABORT_SESSION.
                    maySent = false;
                    lastRateLimit = null;
                    if (token.IsCancellationRequested) throw;
                    return new(new(MultiCommitOutcome.Refused, MapCommitRefusal(session, error, project)), jobId, RawError: error, Retryable: true);
                }
                catch (Exception) when (!token.IsCancellationRequested) { }
            }
            // The COMMIT may exist: look it up by its id until it is DONE.
            while (done is null)
            {
                try
                {
                    var found = await GetJobAsync(connection, project, jobId, location, limit.Token);
                    if (found.Status?.State == "DONE") done = found;
                }
                // A 404 is inconclusive, and so is any other failed lookup: the COMMIT may have run, so only the budget ends
                // the search, as an unknown outcome.
                catch (Exception) when (!limit.IsCancellationRequested) { }
                if (done is null) await Task.Delay(DonePoll, limit.Token);
            }
        }
        catch (Exception) when (!token.IsCancellationRequested && limit.IsCancellationRequested)
        {
            // The budget ran out while only retrying an insert that never left or was rate-limited: nothing was submitted.
            if (!maySent)
            {
                if (lastRateLimit is not null)
                    return new(new(MultiCommitOutcome.Refused, MapCommitRefusal(session, lastRateLimit, project)), jobId, RawError: lastRateLimit, Retryable: true);
                return new(new(MultiCommitOutcome.Refused, new MultiTargetError("CONNECTION_LOST", "The transaction was not committed: " + BigQueryErrors.Unreachable)), jobId, ConnectionLost: true);
            }
            Unknown(session, jobId, location);
            return new(new(MultiCommitOutcome.InDoubt, new MultiTargetError("TIMEOUT", "BigQuery did not confirm the transaction commit in time (job " + jobId + ").")), jobId, Cancelled: false);
        }
        catch (Exception error) when (token.IsCancellationRequested)
        {
            if (!maySent)
                return new(new(MultiCommitOutcome.CancelledBeforeSend, new MultiTargetError("CANCELLED", "The transaction commit was cancelled before it was sent to BigQuery.")), jobId, RawError: error, Cancelled: true);
            // Main's deadline or caller cancellation won after send may have started: the COMMIT may still run, so the session is aborted only once it is DONE.
            Unknown(session, jobId, location);
            return new(new(MultiCommitOutcome.InDoubt, new MultiTargetError("CANCELLED", "The transaction commit was cancelled after submission started; outcome is unknown (job " + jobId + ").")), jobId, RawError: error, Cancelled: true);
        }
        if (BigQueryJobException.Of(done) is not { } failed)
        {
            session.Transaction = BigQueryTransaction.None;
            return new(new(MultiCommitOutcome.Committed), jobId);
        }
        var retryable = failed.Errors.Append(failed.Result).Any(item => item.Reason is "backendError" or "internalError" or "jobBackendError" or "jobInternalError" or "rateLimitExceeded");
        return new(new(MultiCommitOutcome.Refused, MapCommitRefusal(session, failed, project)), jobId, RawError: failed, Retryable: retryable);
    }

    static bool PreSendClientFailure(Exception error)
    {
        var inTransport = false;
        for (Exception? cur = error; cur is not null; cur = cur.InnerException)
        {
            if (cur is RequestException or Google.Apis.Auth.OAuth2.Responses.TokenResponseException or Google.Apis.Auth.OAuth2.SubjectTokenException)
                return true;
            if (cur is HttpRequestException or IOException)
                inTransport = true;
            else if (cur is ObjectDisposedException && !inTransport)
                return true;
        }
        return false;
    }

    static bool HasDisposed(Exception error)
    {
        for (Exception? cur = error; cur is not null; cur = cur.InnerException)
            if (cur is ObjectDisposedException) return true;
        return false;
    }

    static MultiTargetError MapCommitRefusal(BigQueryTabSession session, Exception error, string project)
    {
        if (SessionGone(error, session.Id)) return new("SESSION_LOST", ExpiredCommit);
        var mapped = error is BigQueryJobException job ? BigQueryErrors.Job(job.Result, job.Errors, project, null) : BigQueryErrors.Map(error, project) as RequestException
            ?? (HasDisposed(error) ? new RequestException("NOT_CONNECTED", "The connection was closed.") : new RequestException("SQL_ERROR", "BigQuery refused the commit."));
        var code = mapped.Code is "TIMEOUT" or "CANCELLED" ? "SQL_ERROR" : mapped.Code;
        return new(code, mapped.Message);
    }

    /// <summary>
    /// COMMIT TRANSACTION in the session (docs/bigquery.md, Sessions). Answers null when the commit succeeded and the
    /// session is to be ended; a result when the close is answered here (commitNotApplied, outcomeUnknown); throws to keep
    /// the session (a refused commit on a checked session, a retryable refusal, abortOnRefusedCommit false) or with
    /// SESSION_LOST for an expired one. The insert and every lookup by the COMMIT's client job id share
    /// <see cref="CommitLimit"/>; a 409, a 5xx, a transport failure after sending or the limit itself is an unknown
    /// outcome until a lookup proves it, and a 404 from a lookup is inconclusive.
    /// </summary>
    async Task<SessionCloseResult?> CommitAsync(BigQueryTabSession session, bool abortOnRefusedCommit, CancellationToken token)
    {
        var detail = await CommitCoreDetailedAsync(session, token);
        switch (detail.Result.Outcome)
        {
            case MultiCommitOutcome.Committed:
                return null;
            case MultiCommitOutcome.Refused:
                if (detail.ConnectionLost)
                    throw new RequestException("CONNECTION_LOST", "The transaction was not committed, and the query stays open: " + BigQueryErrors.Unreachable);
                throw Refused(session, detail.RawError!, detail.Retryable, abortOnRefusedCommit, session.Connection.Options.Project);
            case MultiCommitOutcome.CancelledBeforeSend:
                ExceptionDispatchInfo.Capture(detail.RawError ?? new OperationCanceledException(token)).Throw();
                return null;
            case MultiCommitOutcome.InDoubt:
                if (detail.Cancelled)
                {
                    ExceptionDispatchInfo.Capture(detail.RawError ?? new OperationCanceledException(token)).Throw();
                    return null;
                }
                return new SessionCloseResult(true, Note("outcomeUnknown", jobId: detail.JobId));
            default:
                throw new InvalidOperationException("Unexpected commit outcome.");
        }
    }

    static bool Retryable(GoogleApiException error) =>
        error.HttpStatusCode == HttpStatusCode.TooManyRequests || error.Error?.Errors?.Any(item => item.Reason == "rateLimitExceeded") == true;

    /// <summary>A commit BigQuery refused. An expired session answers SESSION_LOST (nothing was committed) and is removed;
    /// a retryable refusal, any refusal on a checked session, and abortOnRefusedCommit false keep it. On an unchecked session
    /// the refusal may only mean no transaction was active, so the session is ended and the note says the commit was not
    /// applied (abortFailed with BigQuery's message when that end fails too).</summary>
    Exception Refused(BigQueryTabSession session, Exception error, bool retryable, bool abortOnRefusedCommit, string project)
    {
        if (SessionGone(error, session.Id))
        {
            Forget(session);
            return new RequestException("SESSION_LOST", ExpiredCommit);
        }
        var mapped = error is BigQueryJobException job ? BigQueryErrors.Job(job.Result, job.Errors, project, null) : BigQueryErrors.Map(error, project) as RequestException
            ?? (HasDisposed(error) ? new RequestException("NOT_CONNECTED", "The connection was closed.") : new RequestException("SQL_ERROR", "BigQuery refused the commit."));
        // A COMMIT job that timed out or was stopped refused the commit: TIMEOUT stays the code of main's own deadline, whose
        // outcome is unknown.
        var code = mapped.Code is "TIMEOUT" or "CANCELLED" ? "SQL_ERROR" : mapped.Code;
        if (retryable || session.Transaction == BigQueryTransaction.Open || !abortOnRefusedCommit)
            return new RequestException(code, "The transaction was not committed, and the query stays open. " + mapped.Message);
        // Answered by CloseAsync's end of the session, which may turn this into abortFailed.
        return new FallThrough(Note("commitNotApplied", mapped.Message));
    }

    SessionCloseResult Unknown(BigQueryTabSession session, string jobId, string? location)
    {
        Forget(session);
        if (session.Id is { } id) PendingAbort(session.Connection, id, session.Location, jobId, location);
        return new SessionCloseResult(true, Note("outcomeUnknown", jobId: jobId));
    }

    /// <summary>A refused commit on an unchecked session that falls through to the session's end.</summary>
    internal sealed class FallThrough(SessionCloseNote note) : Exception(note.Message)
    {
        public SessionCloseNote Note { get; } = note;
    }
}
