using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;
using Google;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.BigQuery;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend;

/// <summary>
/// query.execute for a BigQuery handle (docs/bigquery.md, Execution, Scripts, Sessions): one query job with a client job id
/// in the tab's BigQuery session (created by its first job; emulator mode has none), polled with jobs.getQueryResults.
/// A script's children are listed between polls and read in statement order as result sets 1…n, so early results show
/// before the script ends; DML and DDL children become Messages lines. Rows are read through REST into the result store as
/// SQL Server's are (BigQueryColumnPlan into ResultSetBuffer), truncated by the row limit and the budget, then the job's
/// statistics and cost go in Messages and the summary. A large result that did not arrive whole is read through Storage
/// Read instead (SqlService.BigQueryStorageRead.cs). Stop ends the read at once and calls jobs.cancel; the session's
/// next job waits for the stopped one to reach DONE. The session's transaction is tracked from the statement types of its
/// jobs, top-level and child.
/// </summary>
internal sealed partial class SqlService
{
    /// <summary>The tabs running a BigQuery query, so a tab runs one at a time (SESSION_BUSY), as a SQL Server session does.</summary>
    private readonly ConcurrentDictionary<string, byte> bigQueryTabs = new();

    /// <summary>The rows the first getQueryResults answer asks for (the page the grid shows first); later pages are sized by
    /// the result's width (<see cref="BigQueryPageRows"/>).</summary>
    internal const int BigQueryFirstPageRows = 500;
    /// <summary>About how many cells a later page holds, so a wide result's pages stay as small in memory as a narrow one's.</summary>
    internal const int BigQueryPageCells = 250_000;

    internal int BigQueryPageRows(int columns) => Math.Clamp(BigQueryPageCells / Math.Max(1, columns), BigQueryFirstPageRows, bigQuery.PageRows);

    /// <summary>BigQuery's error positions, [line:column] in the submitted text.</summary>
    [GeneratedRegex(@"\[(?<line>\d{1,7}):(?<column>\d{1,7})\]")]
    private static partial Regex ErrorPosition();

    /// <summary>Rewrites BigQuery's [line:column] positions into the editor's, adding the selection's offset (its first line,
    /// and its first column on that line); <paramref name="firstLine"/> is the first position's editor line.</summary>
    internal static string EditorPositions(string text, int startLine, int startColumn, out int? firstLine)
    {
        int? first = null;
        var mapped = ErrorPosition().Replace(text, match =>
        {
            var line = long.Parse(match.Groups["line"].Value, CultureInfo.InvariantCulture);
            var column = long.Parse(match.Groups["column"].Value, CultureInfo.InvariantCulture);
            if (line < 1 || column < 1) return match.Value;
            var editorLine = startLine + line - 1;
            var editorColumn = line == 1 ? startColumn + column - 1 : column;
            if (editorLine > int.MaxValue || editorColumn > int.MaxValue) return match.Value;
            first ??= (int)editorLine;
            return "[" + editorLine.ToString(CultureInfo.InvariantCulture) + ":" + editorColumn.ToString(CultureInfo.InvariantCulture) + "]";
        });
        firstLine = first;
        return mapped;
    }

    /// <summary>A script child's rows failed to read: the query fails, where a failed listing only stops the early reads.</summary>
    private sealed class ChildReadFailure(Exception inner) : Exception(inner.Message, inner);

    private static string TransactionName(BigQueryTransaction state) => state switch { BigQueryTransaction.Open => "open", BigQueryTransaction.Unknown => "unknown", _ => "none" };

    /// <summary>The attachment of each job query.attach follows, so a second attach takes the first's over (superseded).</summary>
    private readonly ConcurrentDictionary<string, RunningQuery> attachments = new(StringComparer.Ordinal);

    private async Task<QueryResult> ExecuteBigQueryAsync(QueryArgs args, BigQueryConnection connection, RequestContext? context, BigQueryAttachArgs? attach = null)
    {
        if (attach is null && (string.IsNullOrWhiteSpace(args.Sql) || args.Sql.Length > 1_000_000) || args.MaxRows < 0 || args.MaxResultSets is < 1 or > 1000
            || args.TimeoutSeconds is < 0 or > 86400 || args.StartLine is < 1 or > 1_000_000 || args.StartColumn is < 1 or > 1_000_000 || !Guid.TryParse(args.QueryId, out _) || !Guid.TryParse(args.SessionId, out _))
            throw new RequestException("INVALID_PARAMS", "Query text, ID, session, timeout, or row limit is invalid.");
        // SQL Server's options have no BigQuery meaning; main refuses them first (methods.ts, providerOptionsAllow).
        if (args.StopOnError || args.IncludeActualPlan || args.IncludeLivePlan || args.IncludeClientStatistics)
            throw new RequestException("UNSUPPORTED_PROVIDER", "Stop on error, actual and live plans and client statistics are not available for BigQuery connections.");
        var dataset = args.Dataset ?? connection.Options.Dataset;
        if (dataset is not null && (dataset.Length is 0 or > BigQueryLimits.Dataset || !BigQueryLimits.DatasetId().IsMatch(dataset)))
            throw new RequestException("INVALID_PARAMS", "A dataset name has only letters, numbers and underscores.");
        if (args.JobKey is not null && !BigQueryLimits.Uuid().IsMatch(args.JobKey)) throw new RequestException("INVALID_PARAMS", "The job key is not valid.");
        if (attach is null && BigQueryErrors.IsLegacySql(args.Sql)) throw new RequestException("LEGACY_SQL", BigQueryErrors.LegacySql);
        if (args.MaximumBytesBilled is < 1 or > BigQueryLimits.MaxSafeInteger) throw new RequestException("INVALID_PARAMS", "Maximum bytes billed is outside its supported range.");
        // Checked before any job runs, so a bad setting costs nothing.
        ResidenceOf(args.Residence);
        CacheBytesOf(args.WindowCacheMiB);
        // The connection's own cap (Advanced Properties) wins over Tools › Options' default.
        var cap = connection.Options.MaximumBytesBilled ?? args.MaximumBytesBilled;

        using var cancellation = args.TimeoutSeconds == 0 ? new CancellationTokenSource() : new CancellationTokenSource(TimeSpan.FromSeconds(args.TimeoutSeconds));
        var running = new RunningQuery(args.ConnectionId, args.SessionId, cancellation) { Detachable = true, ReadsOutside = attach is { AdoptSession: false } };
        if (!Register(args.QueryId, running)) throw new RequestException("DUPLICATE_QUERY", "This query is already running.");
        // Ended completes only once the tab is free (bigQueryTabs, the session's queue), so an attach that superseded this one
        // and waits for it never finds the tab still busy.
        void Unregister(bool end = true)
        {
            queries.TryRemove(new(args.QueryId, running));
            if (attach is not null) attachments.TryRemove(new(attach.JobId, running));
            if (end) running.Ended.TrySetResult();
        }
        if (attach is not null)
        {
            // One attachment per job: a second re-attach (two reconnect paths racing) takes the first's events over, and the
            // first answers superseded at once, leaving the job to this one.
            RunningQuery? previous = null;
            attachments.AddOrUpdate(attach.JobId, running, (_, old) => { previous = old; return running; });
            if (previous is not null)
            {
                previous.Supersede();
                try { await previous.Ended.Task.WaitAsync(TimeSpan.FromSeconds(10), cancellation.Token); }
                catch (Exception) when (!cancellation.IsCancellationRequested) { }
                catch (Exception)
                {
                    Unregister();
                    throw new RequestException("CANCELLED", CancelledSentence);
                }
            }
        }
        if (!bigQueryTabs.TryAdd(args.SessionId, 0))
        {
            Unregister();
            throw new RequestException("SESSION_BUSY", "A query is already running in this tab.");
        }
        // A disconnect that came between finding the handle and registering cancelled nothing of this query's: refuse it.
        if (bigQuery.Find(args.ConnectionId) != connection)
        {
            bigQueryTabs.TryRemove(args.SessionId, out _);
            Unregister();
            throw new RequestException("NOT_CONNECTED", "The connection was closed.");
        }
        // An attach that does not adopt the job's session (Open results while another tab uses it) reads outside the tab's
        // session, so the tab never shares another tab's queue.
        var session = attach is { AdoptSession: false } ? new BigQueryTabSession(args.SessionId, connection) : bigQuery.Session(args.SessionId, connection);
        using var cancelled = context?.Token.Register(() => { if (context.Reason == CancelReason.Deadline) TryCancel(cancellation); else running.Cancel(); });
        using var events = new QueryEventSink(context is null ? null : context.SendEvent);
        var messages = new QueryMessages(events.Message);
        // Made once, not per row (tests/ingestion-row-lint.test.ts holds SQL Server's reader to the same rule).
        Action<string> warn = text => messages.Add(text);
        var token = cancellation.Token;
        var watch = Stopwatch.StartNew();
        var project = connection.Options.Project;
        var sets = new List<ResultSetBuffer>();
        ResultSetBuffer? currentSet = null;
        BigQueryColumnPlan? plan = null;
        QueryBudget? budget = null;
        var roomWaited = new RoomWaited();
        var status = "completed";
        QueryFailure? failure = null;
        long recordsAffected = -1;
        var discarded = 0;
        var jobId = attach?.JobId ?? BigQueryService.NewJobId();
        string? location = attach is null ? connection.Location : attach.Location ?? connection.Location;
        // Sent: an insert went out, so the job may exist; created: BigQuery answered that it does; complete: it finished.
        var sent = false;
        var created = false;
        var complete = false;
        // A re-attached job already DONE: only its rows are read, so there is nothing to leave running.
        var attachedDone = false;
        var queued = false;
        // The job ran in a session (it carried the id, or created the session), so its statements count for the transaction.
        var sessionJob = false;
        var startState = BigQueryTransaction.None;
        // The finished job's statements were applied to the session's transaction.
        var tracked = false;
        // The finished job's DDL marked the index (MarkIndexAsync); a job left unsettled is marked once it is DONE instead.
        var indexMarked = false;
        BigQueryJobSummary? summary = null;
        // A script's children read so far (DONE, in statement order), how many succeeded, and the rows their DML changed.
        var readChildren = new HashSet<string>(StringComparer.Ordinal);
        var succeededChildren = 0;
        long childRowsAffected = -1;
        // The rows the script's result sets have kept so far: Maximum rows counts over every result set of the execution, as
        // SQL Server's reader does, so a later SELECT keeps only what is left.
        long keptRows = 0;
        // Stop (or the timeout) cancels the job in BigQuery too, best-effort; the session's next job waits for its DONE. Asked
        // once, from the token and again where the run sees the cancellation: a cancel whose continuations run inline can
        // unwind the run and dispose the registration before its callback runs (callbacks run newest first).
        var stopAsked = 0;
        // A Stop during a re-attach's identity check: the check could not pass (unconfirmedCancel), or it passed and the cancel
        // could not be confirmed (cancelFailed).
        var unconfirmedCancel = false;
        var cancelFailed = false;
        void StopJob()
        {
            // Leave it running, or a later attach that took the job over: the job carries on in BigQuery.
            if (running.LeavesJob) return;
            if (Interlocked.Exchange(ref stopAsked, 1) != 0) return;
            session.ActiveCancelled = true;
            if (sent && !complete) bigQuery.CancelJob(connection, project, jobId, location);
        }
        using var stopJob = token.Register(StopJob);

        // One finished child of a script: a SELECT's rows as the next result set, a DML's row count, a DDL's sentence.
        async Task ChildAsync(BigQueryChild child)
        {
            if (child.Error is not null) return;
            succeededChildren++;
            var statement = child.StatementType;
            if (statement == "SELECT")
            {
                if (args.DiscardResults || sets.Count >= args.MaxResultSets) { discarded++; return; }
                var first = await bigQuery.QueryResultsAsync(connection, project, child.Id, child.Location ?? location, null, BigQueryFirstPageRows, 0, token);
                var childPlan = BigQueryColumnPlan.From(first.Schema);
                var rows = first.TotalRows ?? 0;
                if (childPlan is null) { first.Dispose(); return; }
                if (childPlan.TruncatedColumns)
                    messages.Add("The result has " + childPlan.SchemaColumns.ToString("N0", CultureInfo.InvariantCulture) + " columns; the first " + PageBuilder.MaxColumns.ToString("N0", CultureInfo.InvariantCulture) + " are shown.");
                var set = store.Open(budget!, sets.Count, 1, 1, "rows", childPlan.Columns, childPlan.Wires, lengths: childPlan.Lengths);
                if (set is null) { first.Dispose(); discarded++; return; }
                // What Maximum rows leaves this result set. With nothing left it stays in memory and keeps no rows (counted from
                // BigQuery's total, marked as cut by the row limit), since a window's MaxRows of 0 would show every row.
                var left = args.MaxRows > 0 ? args.MaxRows - keptRows : long.MaxValue;
                var childArgs = args.MaxRows <= 0 ? args : left > 0 ? args with { MaxRows = (int)left } : args with { Residence = "memory" };
                var keptBefore = left > 0 ? 0 : keptRows;
                sets.Add(set);
                currentSet = set;
                BigQueryWindow? window = null;
                RemoteResult? windowed;
                // The first page is the reader's only once the residence is decided: a failure or Stop while deciding frees it, and
                // the set is still announced, so the run's end closes a set the grid heard open.
                try { windowed = await DecideResidenceAsync(childArgs, connection, project, child.Id, child.Location ?? location, null, true, childPlan, first, set, budget!, messages, value => window = value, token, args.MaxRows); }
                catch
                {
                    first.Dispose();
                    events.Opened(set);
                    throw;
                }
                events.Opened(set);
                if (windowed is null) await ReadBigQueryRowsAsync(childArgs, connection, project, child.Id, child.Location ?? location, childPlan, first, set, budget!, rows, roomWaited, events, warn, token, window, messages, keptBefore);
                else first.Dispose();
                set.Complete();
                keptRows += set.RowsAvailable;
                events.Closed(set);
                currentSet = null;
                messages.Add(rows == 1 ? "(1 row affected)" : "(" + rows.ToString(CultureInfo.InvariantCulture) + " rows affected)");
            }
            else if (child.DmlAffected is { } affected and >= 0)
            {
                childRowsAffected = Math.Max(0, childRowsAffected) + affected;
                messages.Add(affected == 1 ? "(1 row affected)" : "(" + affected.ToString(CultureInfo.InvariantCulture) + " rows affected)");
            }
            else if (statement is { Length: > 0 }) messages.Add(StatementSentence(statement, child.Ddl));
        }

        // Lists the children and reads those newly DONE, in order, up to the first still running. Full: every page (the
        // final listing, whose children also decide the transaction); otherwise only the pages since the last read.
        async Task<(List<BigQueryChild> Children, bool Complete)> ChildrenAsync(bool full)
        {
            var listed = await bigQuery.ChildrenAsync(connection, project, jobId, full ? null : readChildren, token);
            foreach (var child in listed.Children)
            {
                if (readChildren.Contains(child.Id)) continue;
                if (!child.Done) break;
                readChildren.Add(child.Id);
                // A child's rows that fail to read fail the query, unlike a listing that fails: its set is cut short.
                try { await ChildAsync(child); }
                catch (Exception error) when (!token.IsCancellationRequested) { throw new ChildReadFailure(error); }
            }
            return listed;
        }

        try
        {
            // The session runs one job at a time: a close in progress goes first.
            await session.Queue.WaitAsync(token);
            queued = true;
            session.ActiveCancelled = false;
            session.StopActive = running.Cancel;
            session.DetachActive = running.Detach;
            // An earlier run's unconfirmed cancel was said by that run; only a close that stopped it names it again.
            session.CancelUnconfirmed = null;
            if ((attach?.JobKey ?? args.JobKey) is { } jobKey) session.LastJobKey = jobKey;
            // This query now owns the tab, so the tab's earlier results are released before any new row is stored.
            budget = store.BeginQuery(args.SessionId);
            budget.Executing = true;
            // A re-attach of the session's own held job (cut off by the network, left running, or followed by a superseded
            // attach) follows that job rather than waiting for it; the tail stays until the identity check passes.
            var following = attach is { AdoptSession: true } && session.Tail is { } held && held.JobId == attach.JobId;
            if (session.Tail is { } tail && !following)
            {
                // The session's last job (stopped, or cut off by the network) must reach DONE first; Stop cancels it.
                messages.Add("Waiting for BigQuery job " + JobName(project, tail.Location, tail.JobId) + " to finish: this tab's BigQuery session runs one job at a time.");
                // Every Stop asks again: an earlier jobs.cancel may have failed, or gone out before BigQuery created the job.
                // Asked from the catch too, as StopJob is: the settle's own cancellation can unwind first.
                var tailAsked = 0;
                void StopTail()
                {
                    if (running.LeavesJob || Interlocked.Exchange(ref tailAsked, 1) != 0) return;
                    tail.Cancelled = true;
                    bigQuery.CancelJob(connection, project, tail.JobId, tail.Location);
                }
                BigQuerySettled settled;
                using (token.Register(StopTail))
                {
                    try { settled = await bigQuery.SettleAsync(session, token); }
                    catch (Exception) when (token.IsCancellationRequested) { StopTail(); throw; }
                }
                if (settled.Committed) messages.Add("The stopped job committed a transaction before it stopped; stopping does not undo work already committed.");
            }
            if (attach is not null)
            {
                // The job already exists: after the identity check its session (when adopted) and state are taken over, and the
                // poll below follows it as it would a job this request inserted.
                Job own;
                // The checked job's location and, when adopted, its session (with the record's transaction, decision 54).
                void Adopt(Job checkedJob)
                {
                    location = KnownLocation(checkedJob.JobReference?.Location) ?? location;
                    if (attach.AdoptSession && checkedJob.Statistics?.SessionInfo?.SessionId is { } jobSession && BigQuerySql.SessionId().IsMatch(jobSession))
                    {
                        if (session.Id is null && !bigQuery.UsedElsewhere(session, jobSession))
                        {
                            bigQuery.ForgetOthers(session, jobSession);
                            session.Id = jobSession;
                            session.Location = location;
                            session.Transaction = attach.Transaction switch { "open" => BigQueryTransaction.Open, "unknown" => BigQueryTransaction.Unknown, _ => BigQueryTransaction.None };
                        }
                        sessionJob = session.Id == jobSession;
                    }
                }
                // Stop before the identity check answers cancels the held job this attach follows, as the waiting path does.
                using (following ? token.Register(() =>
                {
                    if (running.LeavesJob || session.Tail is not { } followed || followed.JobId != jobId || followed.Cancelled) return;
                    followed.Cancelled = true;
                    bigQuery.CancelJob(connection, project, followed.JobId, followed.Location);
                }) : default)
                {
                    var ours = following || session.HasInserted(jobId);
                    try { own = await bigQuery.OwnJobAsync(connection, jobId, location, token, inserted: ours); }
                    // Stop (or Cancel the job) before the check answered: the job is cancelled once it proves to be this account's.
                    // A close that cancels the job waits for this (it waits for the queue), and hears when it failed.
                    catch (Exception) when (!following && token.IsCancellationRequested && !running.LeavesJob && bigQuery.Find(args.ConnectionId) == connection)
                    {
                        var (checkedJob, ownCancelled) = await bigQuery.CancelOwnJobAsync(connection, jobId, location, ours);
                        if (checkedJob is null) { session.CancelUnconfirmed = jobId; unconfirmedCancel = true; }
                        else
                        {
                            // The job is this account's: its session is the tab's as after a check that passed, so a close asks
                            // about a transaction it holds, and the stopped job holds the session until DONE.
                            Adopt(checkedJob);
                            if (checkedJob.Status?.State != "DONE") sent = created = true;
                            if (!ownCancelled) { session.CancelUnconfirmed = jobId; cancelFailed = true; }
                        }
                        throw;
                    }
                }
                sent = created = true;
                // A Stop between the check and here found nothing sent to cancel: it is asked again now.
                if (token.IsCancellationRequested && Interlocked.Exchange(ref stopAsked, 0) != 0) StopJob();
                // The adopted session's transaction starts from the job record's (decision 54), not from a listing.
                Adopt(own);
                // Set before the tail is cleared, so a close in between still sees a job to leave running; only a job in the
                // tab's own session holds it.
                attachedDone = own.Status?.State == "DONE";
                session.ActiveJob = sessionJob && !attachedDone;
                // A running job outside the tab's session (another tab holds it, or the tab has a session of its own): a close
                // stops following it, never cancels it.
                session.FollowsJob = !sessionJob && !attachedDone;
                if (following) session.Tail = null;
                startState = session.Transaction;
                var since = own.Statistics?.CreationTime is { } createdAt and > 0 ? DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(createdAt) : (TimeSpan?)null;
                messages.Add("Re-attached to BigQuery job " + JobName(project, location, jobId) + (since is { } ago ? ", started " + Ago(ago) : "")
                    + (own.Status?.State == "DONE" ? ", which finished meanwhile." : ", which is still running."));
                if (attach.Detached) messages.Add("The job was left running: Varia waits for it to finish, holding the tab's BigQuery session, and reads no results.");
                events.Job(JobEvent(project, jobId, location, own.Status?.State == "DONE" ? "done" : "running", startState));
            }
            else location = await TabLocationAsync(session, connection, dataset, token);
            for (var attempt = 1; attach is null; attempt++)
            {
                sessionJob = session.Id is not null;
                startState = session.Transaction;
                var job = new Job
                {
                    JobReference = new JobReference { ProjectId = project, JobId = jobId, Location = location },
                    Configuration = new JobConfiguration
                    {
                        Labels = new Dictionary<string, string>(BigQueryService.Labels),
                        // BigQuery stops the job itself at the execution timeout, so a query cut off here does not run on.
                        JobTimeoutMs = args.TimeoutSeconds > 0 ? args.TimeoutSeconds * 1000L : null,
                        Query = new JobConfigurationQuery
                        {
                            Query = args.Sql, UseLegacySql = false,
                            DefaultDataset = dataset is null ? null : new DatasetReference { ProjectId = project, DatasetId = dataset },
                            MaximumBytesBilled = cap,
                            // The tab's first job creates its session (emulator mode has none); later jobs carry its id.
                            CreateSession = session.Id is null && !bigQuery.Environment.Emulator ? true : null,
                            ConnectionProperties = session.Id is { } id ? [new ConnectionProperty { Key = "session_id", Value = id }] : null
                        }
                    }
                };
                sent = true;
                // From here BigQuery may have the job: a close leaves it running (a held tail the poll settles, or drops on a
                // 404 if it never existed) rather than cancel it.
                session.ActiveJob = true;
                try
                {
                    var inserted = await bigQuery.InsertJobAsync(connection, job, dataset, token);
                    if (sessionJob && BigQueryJobException.Of(inserted) is { } gone && BigQueryService.SessionGone(gone, session.Id)) throw gone;
                    created = true;
                    session.AddInserted(jobId);
                    bigQuery.Reached();
                    location = KnownLocation(inserted.JobReference?.Location) ?? location;
                    BigQueryService.CaptureSession(session, inserted, location);
                    sessionJob |= session.Id is not null;
                    messages.Add("BigQuery job " + JobName(project, location, jobId) + ".");
                    // A job refused at insert is already DONE with its error: main drops its record rather than keep it running.
                    var refused = BigQueryJobException.Of(inserted);
                    events.Job(JobEvent(project, jobId, location, refused is null ? "running" : "done", startState));
                    if (refused is not null)
                    {
                        session.ActiveJob = false;
                        throw refused;
                    }
                    break;
                }
                // The session expired (24 hours idle or 7 days): the refused job ran nothing, so the query runs once more in a
                // new session, and Messages says what was lost.
                catch (Exception error) when (attempt == 1 && sessionJob && !created && BigQueryService.SessionGone(error, session.Id) && !token.IsCancellationRequested)
                {
                    session.Id = null;
                    session.Location = null;
                    session.Transaction = BigQueryTransaction.None;
                    messages.Add(BigQueryService.ExpiredNotice);
                    jobId = BigQueryService.NewJobId();
                    sent = false;
                    location = await TabLocationAsync(session, connection, dataset, token);
                }
            }

            // Poll the job, and its children between polls; the first complete answer carries the first page.
            BigQueryPage? page = null;
            BigQueryJobException? jobFailed = null;
            // Listing between polls only shows early results: one that fails (jobs.list needs bigquery.jobs.list, which the
            // Job User role lacks) stops it, and the final listing decides what the summary says.
            var listing = true;
            try
            {
                try
                {
                    while (true)
                    {
                        token.ThrowIfCancellationRequested();
                        page = await bigQuery.QueryResultsAsync(connection, project, jobId, location, null, args.DiscardResults ? 0 : BigQueryFirstPageRows, bigQuery.ChildPollMs, token);
                        if (page.JobComplete) break;
                        page.Dispose();
                        page = null;
                        if (!listing) continue;
                        try { await ChildrenAsync(full: false); }
                        catch (Exception error) when (!token.IsCancellationRequested && error is not ChildReadFailure) { listing = false; }
                    }
                }
                catch (BigQueryJobException error) { jobFailed = error; }
                complete = true;
                session.ActiveJob = false;
                session.FollowsJob = false;
                var finished = await bigQuery.GetJobAsync(connection, project, jobId, location, token);
                // A re-attach that did not adopt the job's session (another tab uses it, or adoptSession was false) never takes
                // it over when the job finishes: closing this tab would end the other tab's session.
                if (attach is null || sessionJob) BigQueryService.CaptureSession(session, finished, location);
                summary = JobSummary(project, location, jobId, finished);
                var statement = summary.StatementType;
                // A script's children: the rest are read now, and the full listing decides the transaction.
                var script = statement == "SCRIPT" || readChildren.Count > 0 || finished.Statistics?.NumChildJobs > 0;
                List<BigQueryChild>? children = null;
                var listedAll = false;
                if (script)
                {
                    try { (children, listedAll) = await ChildrenAsync(full: true); }
                    // A listing that fails leaves the children unread: the parent's own rows are shown, and the summary says so.
                    catch (Exception error) when (!token.IsCancellationRequested && error is not (BigQueryJobException or ChildReadFailure)) { children = null; }
                }
                // DDL changes what the Search Objects index holds: its datasets are re-read by the next stale-only build.
                // A re-attached job ran under its own default dataset (its configuration's), not this tab's.
                MarkIndex(args.ConnectionId, connection, finished, statement, children, listedAll, project, attach is null ? dataset : null, attach is null ? args.Sql : null);
                indexMarked = true;
                if (sessionJob)
                {
                    if (!script) session.Transaction = BigQueryService.Apply(startState, statement, jobFailed is not null);
                    else if (children is not null && listedAll)
                        session.Transaction = children.Aggregate(startState, (state, child) => BigQueryService.Apply(state, child.StatementType, child.Error is not null || !child.Done));
                    else session.Transaction = BigQueryTransaction.Unknown;
                }
                tracked = true;
                events.Job(JobEvent(project, jobId, location, "done", startState));
                if (jobFailed is not null)
                {
                    if (succeededChildren > 0)
                        messages.Add(succeededChildren == 1 ? "1 statement before the failing one ran, and BigQuery billed it."
                            : succeededChildren.ToString(CultureInfo.InvariantCulture) + " statements before the failing one ran, and BigQuery billed them.");
                    throw jobFailed;
                }
                // BigQuery reports a script's statements as children; with none listed (the emulator) the parent's rows stand.
                if (script && children is { Count: > 0 })
                {
                    // The children's rows are the script's results; the parent's page repeats the last statement's.
                    if (childRowsAffected >= 0) recordsAffected = childRowsAffected;
                    messages.Add("The script completed.");
                }
                else
                {
                    if (script && children is null) messages.Add("Varia could not list the script's statements, so only the last statement's rows are shown.");
                    plan = BigQueryColumnPlan.From(page!.Schema);
                    var totalRows = page.TotalRows ?? 0;
                    if (page.NumDmlAffectedRows is { } affected) recordsAffected = affected;
                    if (plan is not null && args.DiscardResults)
                    {
                        // Statistics only: nothing is read back; the rows are counted from BigQuery's total.
                        discarded = 1;
                    }
                    else if (plan is not null)
                    {
                        if (plan.TruncatedColumns)
                            messages.Add("The result has " + plan.SchemaColumns.ToString("N0", CultureInfo.InvariantCulture) + " columns; the first " + PageBuilder.MaxColumns.ToString("N0", CultureInfo.InvariantCulture) + " are shown.");
                        currentSet = store.Open(budget, 0, 1, 1, "rows", plan.Columns, plan.Wires, lengths: plan.Lengths);
                        if (currentSet is null) discarded = 1;
                        else
                        {
                            sets.Add(currentSet);
                            // In memory or windowed, decided from the first page before the set is announced.
                            BigQueryWindow? window = null;
                            RemoteResult? windowed;
                            // Announced even when deciding fails or is stopped, so the run's end closes a set the grid heard open.
                            try { windowed = await DecideResidenceAsync(args, connection, project, jobId, location, finished, false, plan, page, currentSet, budget, messages, value => window = value, token); }
                            catch
                            {
                                events.Opened(currentSet);
                                throw;
                            }
                            events.Opened(currentSet);
                            if (windowed is null)
                            {
                                // Large results that did not arrive whole are read through Storage Read; the rest, and every fallback, through REST.
                                var readSession = await BigQueryStorageSessionAsync(args, connection, project, jobId, location, plan, page, messages, token);
                                // The reader owns the page from here.
                                var reading = page;
                                page = null;
                                if (readSession is null) await ReadBigQueryRowsAsync(args, connection, project, jobId, location, plan, reading, currentSet, budget, totalRows, roomWaited, events, warn, token, window, messages);
                                else
                                {
                                    reading.Dispose();
                                    await ReadBigQueryArrowAsync(args, readSession, currentSet, budget, totalRows, roomWaited, events, warn, token, window, messages);
                                }
                            }
                            currentSet.Complete();
                            events.Closed(currentSet);
                            currentSet = null;
                        }
                    }
                    if (recordsAffected < 0 && finished.Statistics?.Query?.NumDmlAffectedRows is { } dml and >= 0) recordsAffected = dml;
                    if (recordsAffected >= 0) messages.Add(recordsAffected == 1 ? "(1 row affected)" : "(" + recordsAffected.ToString(CultureInfo.InvariantCulture) + " rows affected)");
                    else if (plan is not null) messages.Add(totalRows == 1 ? "(1 row affected)" : "(" + totalRows.ToString(CultureInfo.InvariantCulture) + " rows affected)");
                    else if (statement == "SCRIPT") messages.Add("The script completed.");
                    else if (statement is { Length: > 0 } && statement != "SELECT") messages.Add(StatementSentence(statement, finished.Statistics?.Query?.DdlOperationPerformed));
                    if (statement == "SCRIPT" && plan is not null) messages.Add("BigQuery returns the rows of a script's last statement only.");
                }
            }
            finally { page?.Dispose(); }
        }
        catch (Exception error)
        {
            // A script failed by a child's rows still runs in BigQuery: it is cancelled, as Stop does, and held until DONE.
            var childFailed = error is ChildReadFailure;
            if (error is ChildReadFailure read) error = read.InnerException!;
            // No job of this run is left in BigQuery (refused, or never created): a close during the slow work below (the
            // location lookup) ends the session as usual rather than leave it for a job.
            if (!created && BigQueryService.NeverCreated(error) || created && !complete && error is BigQueryJobException) session.ActiveJob = false;
            if (childFailed && sent && !complete)
            {
                bigQuery.CancelJob(connection, project, jobId, location);
                messages.Add("Varia asked BigQuery to cancel job " + JobName(project, location, jobId) + ", whose results could not be read. Cancelling is best-effort: BigQuery may still bill work done before the job stopped.");
            }
            if (currentSet is not null) currentSet.Incomplete = true;
            // A job this run did not see through to its marks (Stop, a lost connection, a tab closed or left running, a failed read)
            // marks the index once BigQuery reports it DONE.
            if (sent && !indexMarked && (created || error is BigQueryJobMayExist { Exists: true }))
                MarkIndexWhenDone(args.ConnectionId, connection, project, jobId, location, attach is null ? dataset : null, attach is null ? args.Sql : null);
            // A disconnect that closed the handle under the run (its client disposed) stopped it, as one that cancelled it does.
            if (!token.IsCancellationRequested && bigQuery.Find(args.ConnectionId) != connection) running.Cancel();
            // A job the session started and Varia stopped, or lost track of, holds the session until it is DONE.
            // An insert BigQuery refused, or one that never left, created nothing to wait for.
            // A job BigQuery refused at insert is already DONE with its error, and holds nothing either.
            // A job left running stays the session's held job, polled until DONE; one a later attach took over is that one's.
            // A superseded attach keeps the job for the session too, until the attach that took it over passes its own checks.
            if (sent && !complete && session.Id is not null && (attach is null || sessionJob) && (!running.Superseded || attach is { AdoptSession: true }) && !(created && error is BigQueryJobException) && (created || !BigQueryService.NeverCreated(error)))
            {
                var tail = new BigQueryTail(jobId, location, cancelled: token.IsCancellationRequested && !running.LeavesJob || childFailed, created || error is BigQueryJobMayExist { Exists: true });
                session.Tail = tail;
                bigQuery.WatchHeld(session, tail);
            }
            else if (sessionJob && created && !complete && error is BigQueryJobException)
                session.Transaction = BigQueryService.Apply(startState, null, failed: true);
            // The job finished, but a Stop or a failed read came before its statements were applied: what it left is unknown.
            else if (sessionJob && complete && !tracked)
                session.Transaction = BigQueryTransaction.Unknown;
            // Whatever a cancelled call threw, the run was stopped.
            // Leave it running once the job is DONE (reading its rows) is a stop: nothing is left running.
            if (token.IsCancellationRequested && running.LeavesJob && (sent && !complete && !attachedDone || running.Superseded))
            {
                status = running.Superseded ? "superseded" : "detached";
                messages.Add(!running.Superseded
                    ? "Varia stopped following BigQuery job " + JobName(project, location, jobId) + ", which keeps running in BigQuery"
                        + (session.Id is null || !sessionJob ? "." : " and holds this tab's BigQuery session: the next Execute waits for it, and Stop cancels it.")
                    : "Another re-attach to BigQuery job " + JobName(project, location, jobId) + " took it over.");
            }
            else if (token.IsCancellationRequested)
            {
                StopJob();
                // Leave it running before any job existed is a stop like any other.
                var stopRequested = running.UserCancelled || running.LeavesJob;
                status = stopRequested ? "cancelled" : "timedOut";
                var sentence = stopRequested ? CancelledSentence : TimedOutSentence;
                messages.Add(sentence, MessageKind.Error);
                if (unconfirmedCancel)
                    messages.Add("Varia could not confirm that BigQuery job " + JobName(project, location, jobId) + " was started by this account, so it was not cancelled; it may still be running. Check it in BigQuery's job history.");
                else if (cancelFailed)
                    messages.Add("Varia asked BigQuery to cancel job " + JobName(project, location, jobId) + " but could not confirm the request reached BigQuery; it may still be running. Check it in BigQuery's job history.");
                else if (running.UserCancelled && !complete && sent)
                    messages.Add((created ? "Varia asked BigQuery to cancel job " : "If BigQuery received job ") + JobName(project, location, jobId)
                        + (created ? "" : ", Varia asked it to cancel the job") + ". Cancelling is best-effort: BigQuery may still bill work done before the job stopped.");
                failure = new(stopRequested ? "CANCELLED" : "TIMEOUT", sentence, 1, 1);
            }
            else
            {
                // A re-attached job whose result table is gone (expired after about 24 hours, or a cache hit's table invalidated).
                var mapped = attach is not null && created && error is GoogleApiException { HttpStatusCode: System.Net.HttpStatusCode.NotFound }
                    ? new RequestException("REMOTE_EXPIRED", "BigQuery no longer has the results of job " + JobName(project, location, jobId) + ": it keeps them about 24 hours, and a cached result can expire sooner. Run the query again.")
                    : await BigQueryFailureAsync(error, connection, created, cap, args.Prices != false, CancellationToken.None);
                // A job BigQuery stopped (its timeout, or a cancel from elsewhere) ended as one Varia stopped would.
                status = error is BigQueryJobException && mapped.Code is "TIMEOUT" or "CANCELLED" ? (mapped.Code == "TIMEOUT" ? "timedOut" : "cancelled") : "failed";
                var text = EditorPositions(mapped.Message, args.StartLine, args.StartColumn, out var line);
                messages.Add(text, MessageKind.Error, line);
                if (sent && !text.Contains(jobId, StringComparison.Ordinal) && error is not BigQueryJobException)
                    messages.Add((created ? "The BigQuery job's id is " : "If BigQuery received the job, its id is ") + JobName(project, location, jobId) + ".");
                failure = new(mapped.Code, text.Length > 16384 ? text[..16384] + "…" : text, 1, 1);
            }
        }
        finally
        {
            watch.Stop();
            Unregister(end: false);
            foreach (var set in sets.Where(set => set.IsOpen))
            {
                set.Complete();
                events.Closed(set);
            }
            // Its sets are final now: Load into memory may take one.
            if (budget is not null) budget.Executing = false;
            if (queued)
            {
                session.StopActive = null;
                session.DetachActive = null;
                session.ActiveJob = false;
                session.FollowsJob = false;
                session.ActiveCancelled = false;
                session.Queue.Release();
            }
            bigQueryTabs.TryRemove(args.SessionId, out _);
            running.Ended.TrySetResult();
        }
        if (summary is not null && BigQueryCost.Summary(summary, args.Prices != false) is { } cost) messages.Add(cost);
        var output = messages.Snapshot();
        void Note(string text) => output.Add(new(text, QueryMessages.Info));
        var descriptors = sets.Select(set => set.Describe()).ToList();
        var reasons = descriptors.Select(set => set.Truncated).ToHashSet();
        if (budget?.Stopped is { } stopped and not TruncationReason.None) reasons.Add(ResultSetBuffer.Name(stopped));
        if (reasons.Contains("rowLimit") || descriptors.Any(set => set.TruncatedCells > 0)) Note("Results were truncated by display limits. Display limits do not stop script execution.");
        if (reasons.Contains("queryBudget") || reasons.Contains("globalBudget"))
            Note(BudgetFullNote(budget?.StoppedBytes ?? (reasons.Contains("queryBudget") ? (budget is null ? store.QueryBytes : store.QueryLimit(budget)) : store.GlobalBytes)));
        if (reasons.Contains("systemMemory")) Note("Results were truncated because the computer is low on memory. Execution continued.");
        if (discarded > 0 && args.DiscardResults && attach?.Detached != true) Note("Results were discarded after execution, as Query Options ask.");
        if (context is not null) context.Unsent = () => store.Release(descriptors.Select(set => set.ResultId));
        var completedAt = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffffffzzz", CultureInfo.InvariantCulture);
        return new(descriptors, discarded, output, recordsAffected, watch.ElapsedMilliseconds, status, failure, status is "completed" ? 1 : 0, 1,
            dataset ?? "", messages.Truncated, SummaryBudget(budget?.StoppedBytes), completedAt, Job: summary ?? (created ? new BigQueryJobSummary(project, jobId, location) : null),
            IndexStale: search.StaleMarkOf(args.ConnectionId));
    }

    /// <summary>The query.job event body (docs/ipc.md, Query events): the request's top-level job, never its session id.</summary>
    private static object JobEvent(string project, string jobId, string? location, string state, BigQueryTransaction transaction) =>
        new { Type = "query.job", JobId = jobId, Project = project, Location = location, State = state, Auxiliary = false, Transaction = TransactionName(transaction) };

    /// <summary>
    /// Where the tab's job runs: its session's location once it has one; otherwise, when the connection's location is
    /// Automatic, its dataset's (datasets.get, free, kept per connection), else the connection's. A dataset in another
    /// location than the tab's session is refused up front (LOCATION_MISMATCH): switching it ends the session first
    /// (decision 18), which the tab's Dataset box asks about.
    /// </summary>
    private async Task<string?> TabLocationAsync(BigQueryTabSession session, BigQueryConnection connection, string? dataset, CancellationToken token)
    {
        string? datasetLocation = null;
        if (connection.Options.Location is null && dataset is not null && dataset != connection.Options.Dataset && !bigQuery.Environment.Emulator
            && !connection.DatasetLocations.TryGetValue(dataset, out datasetLocation))
        {
            try
            {
                using var limit = CancellationTokenSource.CreateLinkedTokenSource(token);
                limit.CancelAfter(TimeSpan.FromSeconds(10));
                var found = await connection.Client.Service.Datasets.Get(connection.Options.Project, dataset).ExecuteAsync(limit.Token);
                datasetLocation = KnownLocation(found.Location);
                connection.DatasetLocations[dataset] = datasetLocation;
            }
            // The query's own failure says more than this lookup's (a missing dataset, a refused permission).
            catch (Exception) when (!token.IsCancellationRequested) { datasetLocation = null; }
        }
        if (session.Id is not null && session.Location is { } sessionLocation)
        {
            if (datasetLocation is not null && !string.Equals(datasetLocation, sessionLocation, StringComparison.OrdinalIgnoreCase))
                throw new RequestException("LOCATION_MISMATCH", "Dataset " + dataset + " is in location " + datasetLocation + ", but this tab's BigQuery session is in " + sessionLocation
                    + ". Choose the dataset again with Query › Change Database… to switch the tab to " + datasetLocation + ", which ends its session.");
            return sessionLocation;
        }
        return datasetLocation ?? connection.Location;
    }

    /// <summary>Reads the result's rows into its set, page by page, until BigQuery has no more or the set stores no more (the
    /// row limit, the budget). Rows not read then are counted from BigQuery's total, as SQL Server's reader counts the rows
    /// it reads past. Each page's bytes are charged to the query's budget while its rows are decoded (one page at a time).</summary>
    private async Task ReadBigQueryRowsAsync(QueryArgs args, BigQueryConnection connection, string project, string jobId, string? location, BigQueryColumnPlan plan,
        BigQueryPage first, ResultSetBuffer set, QueryBudget budget, long totalRows, RoomWaited roomWaited, QueryEventSink events, Action<string> warn, CancellationToken token,
        BigQueryWindow? window = null, QueryMessages? messages = null, long keptBefore = 0)
    {
        var page = first;
        long counted = 0;
        // Maximum rows counts over the execution: a script's earlier result sets kept keptBefore of them.
        long storedRows = keptBefore;
        var storing = true;
        try
        {
            while (true)
            {
                var charge = page.Cost(plan.Columns.Count);
                // Under Maximum rows only the rows the set will still store are decoded: the page's share for them is charged,
                // so a small capped result is not refused (or switched to windowed) for a page mostly read past.
                if (args.MaxRows > 0 && page.RowCount > 0 && args.MaxRows - storedRows < page.RowCount)
                    charge = (long)Math.Ceiling((double)charge * Math.Max(0, args.MaxRows - storedRows) / page.RowCount);
                if (!store.TryReserve(budget, charge, true, out var refusal))
                {
                    // The page does not fit beside the rows already stored, so neither would its rows.
                    charge = 0;
                    // An Automatic read switches to windowed instead (docs/bigquery.md, Residence: Misestimate).
                    if (window is not null && SwitchesOn(set, refusal) && SwitchToWindowed(set, window, events, messages!, refusal)) return;
                    set.Skip(refusal);
                    // A derived set (a view or value list in BigQuery) stops only itself: its source keeps its budget.
                    if (!set.Derived) budget.Stop(refusal);
                    storing = false;
                }
                try
                {
                    foreach (var row in page.Rows.ValueKind == System.Text.Json.JsonValueKind.Array ? page.Rows.EnumerateArray() : default)
                    {
                        token.ThrowIfCancellationRequested();
                        set.CountRow();
                        counted++;
                        if (!storing) continue;
                        if (args.MaxRows > 0 && storedRows >= args.MaxRows) { set.Skip(TruncationReason.RowLimit); storing = false; continue; }
                        var builder = set.BeginRow();
                        if (builder is null) { storing = false; continue; }
                        int truncatedCells;
                        try { truncatedCells = plan.ReadRow(row, builder, warn); }
                        catch { set.AbortRow(); throw; }
                        var sealedBefore = set.SealedPages;
                        var committed = set.TryCommitRow(truncatedCells, mayWait: true);
                        if (!committed && set.RoomWanted > 0) committed = await WaitAndCommitAsync(store, set, truncatedCells, roomWaited, token);
                        if (committed) storedRows++;
                        else storing = false;
                        if (set.SealedPages != sealedBefore) events.Sealed(set);
                    }
                }
                finally { store.Return(budget, charge); }
                events.RowsChanged();
                // A row the budget refused in an Automatic read: the set switches to windowed rather than truncating.
                if (!storing && Switches(set, window) && SwitchToWindowed(set, window!, events, messages!)) return;
                // The rows so far become readable while the next page loads.
                if (set.HasPendingRows)
                {
                    set.Seal();
                    events.Sealed(set);
                }
                var next = page.PageToken;
                page.Dispose();
                // A limit reached on a page's last row stops here, not one page later.
                if (storing && args.MaxRows > 0 && storedRows >= args.MaxRows && next is not null) { set.Skip(TruncationReason.RowLimit); storing = false; }
                if (next is null || !storing) break;
                // No more rows than Maximum rows still lets the set store (the rows past it are counted from BigQuery's total).
                var pageRows = BigQueryPageRows(plan.Columns.Count);
                if (args.MaxRows > 0) pageRows = (int)Math.Max(1, Math.Min(pageRows, args.MaxRows - storedRows));
                page = await bigQuery.QueryResultsAsync(connection, project, jobId, location, next, pageRows, 0, token);
            }
        }
        finally { page.Dispose(); }
        // The rows past the stop stay in BigQuery: counted, not read.
        if (totalRows > counted) set.CountRows(totalRows - counted);
        events.RowsChanged();
    }

    /// <summary>A location Google answered, when it is one (main's schema holds the summary's to 64 characters).</summary>
    static string? KnownLocation(string? location) => location is { Length: > 0 and <= BigQueryLimits.Location } && BigQueryLimits.LocationId().IsMatch(location) ? location : null;

    /// <summary><c>project:LOCATION.job_id</c>, the fully qualified id the console and bq show.</summary>
    internal static string JobName(string project, string? location, string jobId) => project + ":" + (location is null ? "" : location + ".") + jobId;

    /// <summary>"CREATE TABLE completed." from a statement type and DDL operation BigQuery reports.</summary>
    internal static string StatementSentence(string statement, string? ddl)
    {
        var words = statement.Replace('_', ' ');
        return ddl switch
        {
            "SKIP" => words + " did nothing: the object already exists, or does not.",
            _ => words + " completed."
        };
    }

    private static BigQueryJobSummary JobSummary(string project, string? location, string jobId, Job job)
    {
        var statistics = job.Statistics;
        var query = statistics?.Query;
        var statement = query?.StatementType is { Length: > 0 and <= 64 } type && type.All(c => char.IsAsciiLetterUpper(c) || c == '_') ? type : null;
        return new(project, jobId, KnownLocation(job.JobReference?.Location) ?? location, statement, Count(query?.TotalBytesProcessed ?? statistics?.TotalBytesProcessed),
            Count(query?.TotalBytesBilled), query?.CacheHit, Count(query?.TotalSlotMs ?? statistics?.TotalSlotMs));
        static long? Count(long? value) => value >= 0 ? value : null;
    }

    /// <summary>The error value for a failed execution: the job's own error, or the failed call's, with a location mismatch
    /// told apart from a missing dataset by asking where the dataset is (datasets.get, free).</summary>
    private async Task<RequestException> BigQueryFailureAsync(Exception error, BigQueryConnection connection, bool created, long? cap, bool prices, CancellationToken token)
    {
        var project = connection.Options.Project;
        var mapped = error is BigQueryJobException job ? BigQueryErrors.Job(job.Result, job.Errors, project, cap, prices)
            : BigQueryErrors.Map(error, project, created ? null : BigQueryService.ProbePermission, cap: cap, token: token, prices: prices) as RequestException
            ?? new RequestException("BACKEND_ERROR", "Execution stopped unexpectedly: " + BigQueryErrors.Sanitize(error.Message));
        return await BigQueryErrors.LocationAsync(mapped, connection.Client);
    }
}
