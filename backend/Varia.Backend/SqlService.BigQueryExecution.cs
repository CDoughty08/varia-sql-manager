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
/// query.execute for a BigQuery handle (docs/bigquery.md, Execution): one query job with a client job id, polled with
/// jobs.getQueryResults, its rows read through REST into the result store as SQL Server's are (BigQueryColumnPlan into
/// ResultSetBuffer), truncated by the row limit and the budget as SQL Server's are, then the job's statistics and cost in
/// Messages and the summary. Results stay in memory: windowed results, Storage Read, scripts' child jobs, sessions and
/// Stop's jobs.cancel are later lanes (docs/bigquery-plan.md).
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

    [GeneratedRegex(@"Dataset (?<project>[^\s:]+):(?<dataset>[A-Za-z\d_]{1,1024}) was not found in location (?<location>[A-Za-z\d-]{1,64})")]
    private static partial Regex DatasetLocationMessage();

    private async Task<QueryResult> ExecuteBigQueryAsync(QueryArgs args, BigQueryConnection connection, RequestContext? context)
    {
        if (string.IsNullOrWhiteSpace(args.Sql) || args.Sql.Length > 1_000_000 || args.MaxRows < 0 || args.MaxResultSets is < 1 or > 1000
            || args.TimeoutSeconds is < 0 or > 86400 || args.StartLine is < 1 or > 1_000_000 || !Guid.TryParse(args.QueryId, out _) || !Guid.TryParse(args.SessionId, out _))
            throw new RequestException("INVALID_PARAMS", "Query text, ID, session, timeout, or row limit is invalid.");
        // SQL Server's options have no BigQuery meaning; main refuses them first (methods.ts, providerOptionsAllow).
        if (args.StopOnError || args.IncludeActualPlan || args.IncludeLivePlan || args.IncludeClientStatistics)
            throw new RequestException("UNSUPPORTED_PROVIDER", "Stop on error, actual and live plans and client statistics are not available for BigQuery connections.");
        var dataset = args.Dataset ?? connection.Options.Dataset;
        if (dataset is not null && (dataset.Length is 0 or > BigQueryLimits.Dataset || !BigQueryLimits.DatasetId().IsMatch(dataset)))
            throw new RequestException("INVALID_PARAMS", "A dataset name has only letters, numbers and underscores.");
        if (BigQueryErrors.IsLegacySql(args.Sql)) throw new RequestException("LEGACY_SQL", BigQueryErrors.LegacySql);

        using var cancellation = args.TimeoutSeconds == 0 ? new CancellationTokenSource() : new CancellationTokenSource(TimeSpan.FromSeconds(args.TimeoutSeconds));
        var running = new RunningQuery(args.ConnectionId, args.SessionId, cancellation);
        if (!Register(args.QueryId, running)) throw new RequestException("DUPLICATE_QUERY", "This query is already running.");
        if (!bigQueryTabs.TryAdd(args.SessionId, 0))
        {
            queries.TryRemove(new(args.QueryId, running));
            throw new RequestException("SESSION_BUSY", "A query is already running in this tab.");
        }
        // A disconnect that came between finding the handle and registering cancelled nothing of this query's: refuse it.
        if (bigQuery.Find(args.ConnectionId) != connection)
        {
            bigQueryTabs.TryRemove(args.SessionId, out _);
            queries.TryRemove(new(args.QueryId, running));
            throw new RequestException("NOT_CONNECTED", "The connection was closed.");
        }
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
        var jobId = BigQueryService.NewJobId();
        string? location = connection.Location;
        // Sent: an insert went out, so the job may exist; created: BigQuery answered that it does; complete: it finished.
        var sent = false;
        var created = false;
        var complete = false;
        BigQueryJobSummary? summary = null;
        try
        {
            // This query now owns the tab, so the tab's earlier results are released before any new row is stored.
            budget = store.BeginQuery(args.SessionId);
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
                        MaximumBytesBilled = connection.Options.MaximumBytesBilled
                    }
                }
            };
            sent = true;
            var inserted = await bigQuery.InsertJobAsync(connection, job, dataset, token);
            created = true;
            location = KnownLocation(inserted.JobReference?.Location) ?? location;
            messages.Add("BigQuery job " + JobName(project, location, jobId) + ".");
            if (BigQueryJobException.Of(inserted) is { } refused) throw refused;

            // The first complete answer carries the first page.
            BigQueryPage page;
            while (true)
            {
                token.ThrowIfCancellationRequested();
                page = await bigQuery.QueryResultsAsync(connection, project, jobId, location, null, args.DiscardResults ? 0 : BigQueryFirstPageRows, bigQuery.PollMs, token);
                if (page.JobComplete) break;
                page.Dispose();
            }
            complete = true;
            plan = BigQueryColumnPlan.From(page.Schema);
            var totalRows = page.TotalRows ?? 0;
            if (page.NumDmlAffectedRows is { } affected) recordsAffected = affected;
            if (plan is not null && args.DiscardResults)
            {
                // Statistics only: nothing is read back; the rows are counted from BigQuery's total.
                page.Dispose();
                discarded = 1;
            }
            else if (plan is not null)
            {
                if (plan.TruncatedColumns)
                    messages.Add("The result has " + plan.SchemaColumns.ToString("N0", CultureInfo.InvariantCulture) + " columns; the first " + PageBuilder.MaxColumns.ToString("N0", CultureInfo.InvariantCulture) + " are shown.");
                currentSet = store.Open(budget, 0, 1, 1, "rows", plan.Columns, plan.Wires, lengths: plan.Lengths);
                if (currentSet is null) { page.Dispose(); discarded = 1; }
                else
                {
                    sets.Add(currentSet);
                    events.Opened(currentSet);
                    await ReadBigQueryRowsAsync(args, connection, project, jobId, location, plan, page, currentSet, budget, totalRows, roomWaited, events, warn, token);
                    currentSet.Complete();
                    events.Closed(currentSet);
                    currentSet = null;
                }
            }
            else page.Dispose();

            var finished = await bigQuery.GetJobAsync(connection, project, jobId, location, token);
            summary = JobSummary(project, location, jobId, finished);
            var statement = summary.StatementType;
            if (recordsAffected < 0 && finished.Statistics?.Query?.NumDmlAffectedRows is { } dml and >= 0) recordsAffected = dml;
            if (recordsAffected >= 0) messages.Add(recordsAffected == 1 ? "(1 row affected)" : "(" + recordsAffected.ToString(CultureInfo.InvariantCulture) + " rows affected)");
            else if (plan is not null) messages.Add(totalRows == 1 ? "(1 row affected)" : "(" + totalRows.ToString(CultureInfo.InvariantCulture) + " rows affected)");
            else if (statement == "SCRIPT") messages.Add("The script completed.");
            else if (statement is { Length: > 0 } && statement != "SELECT") messages.Add(StatementSentence(statement, finished.Statistics?.Query?.DdlOperationPerformed));
            if (statement == "SCRIPT" && plan is not null) messages.Add("BigQuery returns the rows of a script's last statement only.");
        }
        catch (Exception error)
        {
            if (currentSet is not null) currentSet.Incomplete = true;
            // A disconnect that closed the handle under the run (its client disposed) stopped it, as one that cancelled it does.
            if (!token.IsCancellationRequested && bigQuery.Find(args.ConnectionId) != connection) running.Cancel();
            // Whatever a cancelled call threw, the run was stopped.
            if (token.IsCancellationRequested)
            {
                status = running.UserCancelled ? "cancelled" : "timedOut";
                var sentence = running.UserCancelled ? CancelledSentence : TimedOutSentence;
                messages.Add(sentence, MessageKind.Error);
                // jobs.cancel comes with Stop (docs/bigquery-plan.md, BQ-3a-2); BigQuery ends a timed-out job itself (jobTimeoutMs).
                if (running.UserCancelled && !complete && sent)
                    messages.Add((created ? "The BigQuery job keeps running in BigQuery until it finishes; its id is " : "If BigQuery received the job, it keeps running there until it finishes; its id is ")
                        + JobName(project, location, jobId) + ".");
                failure = new(running.UserCancelled ? "CANCELLED" : "TIMEOUT", sentence, 1, 1);
            }
            else
            {
                var mapped = await BigQueryFailureAsync(error, connection, created, CancellationToken.None);
                // A job BigQuery stopped (its timeout, or a cancel from elsewhere) ended as one Varia stopped would.
                status = error is BigQueryJobException && mapped.Code is "TIMEOUT" or "CANCELLED" ? (mapped.Code == "TIMEOUT" ? "timedOut" : "cancelled") : "failed";
                messages.Add(mapped.Message, MessageKind.Error);
                if (sent && !mapped.Message.Contains(jobId, StringComparison.Ordinal) && error is not BigQueryJobException)
                    messages.Add((created ? "The BigQuery job's id is " : "If BigQuery received the job, its id is ") + JobName(project, location, jobId) + ".");
                failure = new(mapped.Code, mapped.Message.Length > 16384 ? mapped.Message[..16384] + "…" : mapped.Message, 1, 1);
            }
        }
        finally
        {
            watch.Stop();
            queries.TryRemove(new(args.QueryId, running));
            foreach (var set in sets.Where(set => set.IsOpen))
            {
                set.Complete();
                events.Closed(set);
            }
            bigQueryTabs.TryRemove(args.SessionId, out _);
        }
        if (summary is not null && BigQueryCost.Summary(summary) is { } cost) messages.Add(cost);
        var output = messages.Snapshot();
        void Note(string text) => output.Add(new(text, QueryMessages.Info));
        var descriptors = sets.Select(set => set.Describe()).ToList();
        var reasons = descriptors.Select(set => set.Truncated).ToHashSet();
        if (budget?.Stopped is { } stopped and not TruncationReason.None) reasons.Add(ResultSetBuffer.Name(stopped));
        if (reasons.Contains("rowLimit") || descriptors.Any(set => set.TruncatedCells > 0)) Note("Results were truncated by display limits. Display limits do not stop script execution.");
        if (reasons.Contains("queryBudget") || reasons.Contains("globalBudget"))
            Note("Results were truncated because the result memory budget (" + (budget?.StoppedBytes ?? (reasons.Contains("queryBudget") ? store.QueryBytes : store.GlobalBytes)) / (1024 * 1024)
                + " MB) is full. Execution continued; close other query results to free memory.");
        if (reasons.Contains("systemMemory")) Note("Results were truncated because the computer is low on memory. Execution continued.");
        if (discarded > 0 && args.DiscardResults) Note("Results were discarded after execution, as Query Options ask.");
        if (context is not null) context.Unsent = () => store.Release(descriptors.Select(set => set.ResultId));
        var completedAt = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffffffzzz", CultureInfo.InvariantCulture);
        return new(descriptors, discarded, output, recordsAffected, watch.ElapsedMilliseconds, status, failure, status is "completed" ? 1 : 0, 1,
            dataset ?? "", messages.Truncated, SummaryBudget(budget?.StoppedBytes), completedAt, Job: summary ?? (created ? new BigQueryJobSummary(project, jobId, location) : null));
    }

    /// <summary>Reads the result's rows into its set, page by page, until BigQuery has no more or the set stores no more (the
    /// row limit, the budget). Rows not read then are counted from BigQuery's total, as SQL Server's reader counts the rows
    /// it reads past. Each page's bytes are charged to the query's budget while its rows are decoded (one page at a time).</summary>
    private async Task ReadBigQueryRowsAsync(QueryArgs args, BigQueryConnection connection, string project, string jobId, string? location, BigQueryColumnPlan plan,
        BigQueryPage first, ResultSetBuffer set, QueryBudget budget, long totalRows, RoomWaited roomWaited, QueryEventSink events, Action<string> warn, CancellationToken token)
    {
        var page = first;
        long counted = 0;
        long storedRows = 0;
        var storing = true;
        try
        {
            while (true)
            {
                var charge = page.Cost(plan.Columns.Count);
                if (!store.TryReserve(budget, charge, true, out var refusal))
                {
                    // The page does not fit beside the rows already stored, so neither would its rows.
                    charge = 0;
                    set.Skip(refusal);
                    budget.Stop(refusal);
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
                page = await bigQuery.QueryResultsAsync(connection, project, jobId, location, next, BigQueryPageRows(plan.Columns.Count), 0, token);
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
    private async Task<RequestException> BigQueryFailureAsync(Exception error, BigQueryConnection connection, bool created, CancellationToken token)
    {
        var project = connection.Options.Project;
        var mapped = error is BigQueryJobException job ? BigQueryErrors.Job(job.Result, job.Errors, project, connection.Options.MaximumBytesBilled)
            : BigQueryErrors.Map(error, project, created ? null : BigQueryService.ProbePermission, cap: connection.Options.MaximumBytesBilled, token: token) as RequestException
            ?? new RequestException("BACKEND_ERROR", "Execution stopped unexpectedly: " + BigQueryErrors.Sanitize(error.Message));
        if (mapped.Code != "NOT_FOUND" || DatasetLocationMessage().Match(mapped.Message) is not { Success: true } match) return mapped;
        string? actual;
        try
        {
            using var limit = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var found = await connection.Client.Service.Datasets.Get(match.Groups["project"].Value, match.Groups["dataset"].Value).ExecuteAsync(limit.Token);
            actual = found.Location;
        }
        // Any failure here (a refused token, a disposed client) leaves the query's own error as it was.
        catch (Exception) { return mapped; }
        var ran = match.Groups["location"].Value;
        if (actual is not { Length: > 0 and <= BigQueryLimits.Location } || !BigQueryLimits.LocationId().IsMatch(actual) || string.Equals(actual, ran, StringComparison.OrdinalIgnoreCase)) return mapped;
        return new RequestException("LOCATION_MISMATCH", "Dataset " + match.Groups["dataset"].Value + " is in location " + actual + ", but the query ran in " + ran
            + ". A query runs in one location: query datasets in " + ran + ", or connect with the location set to " + actual + ".");
    }
}
