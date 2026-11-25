using System.Net;
using Google;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.BigQuery;

namespace Varia.Backend;

/// <summary>What a BigQuery job's DDL may have changed in the Search Objects index (docs/object-search.md, BigQuery): the datasets
/// to read again whole, and whether the whole billing project must be, when which datasets cannot be known.</summary>
internal sealed record BigQueryIndexMarks(IReadOnlyCollection<(string Project, string Dataset)> Datasets, bool WholeProject)
{
    public static readonly BigQueryIndexMarks None = new([], false);
}

/// <summary>
/// The Search Objects index's stale marks for BigQuery DDL (docs/object-search.md, BigQuery). A finished query job marks the
/// datasets its DDL changed, read from the job's statistics (and, for a script, from each statement's entry in the child listing the
/// run reads anyway), so marking adds no call to the run; a job
/// that did not finish within its request (Stop, a lost connection, a tab closed or left running, a failed read) is followed in the
/// background until BigQuery reports it DONE, and marked then. Every read is free REST metadata; nothing here runs a query.
/// </summary>
internal sealed partial class SqlService
{
    /// <summary>The most background follows at once; a job past it is left to the next Refresh or rebuild.</summary>
    internal const int MaxIndexMarkWatches = 64;
    /// <summary>A script's DDL statements whose listing named no target, read with jobs.get in the background; past it they fall back
    /// to the default dataset, or the project.</summary>
    internal const int MaxDeferredReads = 32;
    /// <summary>A follow gives up after this many failed polls in a row (refused or expired credentials, a job it may not read).</summary>
    internal const int MaxFollowFailures = 10;
    /// <summary>The background follow of an unsettled job: its first wait, the longest after backoff, and when it gives up (a
    /// query job runs at most 6 hours).</summary>
    internal TimeSpan IndexMarkPoll { get; set; } = TimeSpan.FromSeconds(5);
    internal TimeSpan IndexMarkPollMax { get; set; } = TimeSpan.FromSeconds(60);
    internal TimeSpan IndexMarkGiveUp { get; set; } = TimeSpan.FromHours(7);
    private int indexMarkWatches;
    /// <summary>Test seam: the background follows of unsettled jobs still running.</summary>
    internal int IndexMarkWatches => Volatile.Read(ref indexMarkWatches);

    /// <summary>Whether a statement type can change what an index lists: DDL (CREATE_TABLE, DROP_VIEW, ALTER_TABLE, CREATE_SCHEMA,
    /// UNDROP_SCHEMA …) and LOAD DATA, which can create a table or change its schema. Row access policies, search and vector indexes,
    /// reservations, capacity commitments, assignments and project or organization options change nothing an index lists.</summary>
    internal static bool ChangesObjects(string? statement) =>
        statement is not null && (statement.StartsWith("CREATE_", StringComparison.Ordinal) || statement.StartsWith("DROP_", StringComparison.Ordinal) || statement.StartsWith("ALTER_", StringComparison.Ordinal)
            || statement.StartsWith("UNDROP_", StringComparison.Ordinal) || statement == "LOAD_DATA")
        && !Unlisted.Any(word => statement.Contains(word, StringComparison.Ordinal));
    private static readonly string[] Unlisted = ["ROW_ACCESS_POLIC", "SEARCH_INDEX", "VECTOR_INDEX", "RESERVATION", "CAPACITY", "ASSIGNMENT", "_PROJECT", "_ORGANIZATION"];

    /// <summary>
    /// The marks of a finished job. A DDL statement marks its target's dataset (table, routine or dataset, as its statistics name
    /// them; LOAD DATA's destination table otherwise); a target in an anonymous dataset (a temp table or function lives in the
    /// session's or script's own <c>_</c> dataset, which no index lists) marks nothing. DDL that names no target marks the default
    /// dataset, or with none the project. A script's DDL statements mark their own targets, from the child listing's statistics;
    /// one that names none (LOAD DATA, whose destination is configuration the listing leaves out) goes to <paramref name="deferred"/>
    /// to be read with jobs.get, or without it marks the default dataset, or with none the project. A listing that failed marks the
    /// default dataset, or with none the project; one cut short marks the project whole. Neither marks anything when the script's
    /// text holds no word of a statement that changes objects (<paramref name="mayChange"/> false).
    /// </summary>
    internal static BigQueryIndexMarks DdlMarks(Job job, string? statement, IReadOnlyList<BigQueryChild>? children, bool listedAll,
        string project, string? dataset, bool mayChange, ICollection<BigQueryChild>? deferred = null)
    {
        var found = new HashSet<(string, string)>();
        var whole = false;
        dataset ??= job.Configuration?.Query?.DefaultDataset is { ProjectId: { } defaultProject, DatasetId: { } defaultDataset } && defaultProject == project ? defaultDataset : null;
        void Mark((string, string)? target)
        {
            if (target is { } named) { if (!named.Item2.StartsWith('_')) found.Add(named); }
            else if (dataset is not null) found.Add((project, dataset));
            else whole = true;
        }
        var script = statement == "SCRIPT" || children is { Count: > 0 } || job.Statistics?.NumChildJobs > 0;
        if (!script)
        {
            if (ChangesObjects(statement)) Mark(TargetOf(job));
        }
        else if (children is null) { if (mayChange) Mark(null); }
        else if (!listedAll) whole = mayChange;
        else
            foreach (var child in children.Where(child => ChangesObjects(child.StatementType)))
            {
                if (child is { TargetProject: { } childProject, TargetDataset: { } childDataset }) Mark((childProject, childDataset));
                else if (deferred is not null) deferred.Add(child);
                else Mark(null);
            }
        return whole ? new(found, true) : found.Count == 0 ? BigQueryIndexMarks.None : new(found, false);
    }

    /// <summary>Where a statement job's DDL acted: its statistics' table, routine or dataset, else its destination table (LOAD DATA).</summary>
    internal static (string, string)? TargetOf(Job job)
    {
        var query = job.Statistics?.Query;
        return query?.DdlTargetTable is { ProjectId: { } tableProject, DatasetId: { } tableDataset } ? (tableProject, tableDataset)
            : query?.DdlTargetRoutine is { ProjectId: { } routineProject, DatasetId: { } routineDataset } ? (routineProject, routineDataset)
            : query?.DdlTargetDataset is { ProjectId: { } datasetProject, DatasetId: { } targetDataset } ? (datasetProject, targetDataset)
            : job.Configuration?.Query?.DestinationTable is { ProjectId: { } destinationProject, DatasetId: { } destinationDataset } ? (destinationProject, destinationDataset)
            : null;
    }

    /// <summary>Records a finished job's marks, from what the run already read: no call of its own. A script statement whose listing
    /// named no target is read in the background (<see cref="ResolveLater"/>).</summary>
    private void MarkIndex(string connectionId, BigQueryConnection connection, Job finished, string? statement, List<BigQueryChild>? children, bool listedAll, string project,
        string? dataset, string? sql)
    {
        var text = finished.Configuration?.Query?.Query ?? sql;
        var deferred = new List<BigQueryChild>();
        var marks = DdlMarks(finished, statement, children, listedAll, project, dataset, text is null || GoogleSqlScanner.MayChangeObjects(text), deferred);
        Record(connectionId, connection, project, marks);
        if (deferred.Count > 0)
        {
            dataset ??= finished.Configuration?.Query?.DefaultDataset is { ProjectId: { } defaultProject, DatasetId: { } defaultDataset } && defaultProject == project ? defaultDataset : null;
            ResolveLater(connectionId, connection, project, finished.JobReference?.Location, dataset, deferred);
        }
    }

    /// <summary>Spends marks on the index: only datasets of projects the index reads (the billing project and any starred, discovered or held project), since
    /// a mark on an unindexed project no build would read.</summary>
    private void Record(string connectionId, BigQueryConnection connection, string project, BigQueryIndexMarks marks)
    {
        foreach (var (markProject, markDataset) in marks.Datasets)
            if (markProject == connection.Options.Project || search.TracksBigQueryProject(connectionId, markProject))
                search.MarkStale(connectionId, markProject, markDataset);
        if (marks.WholeProject) search.MarkProjectStale(connectionId, project);
    }

    /// <summary>Reads, in the background, the jobs of a script's DDL statements whose listing named no target (at most
    /// <see cref="MaxDeferredReads"/>), and marks each one's target; one that cannot be read marks the default dataset, or the project.</summary>
    private void ResolveLater(string connectionId, BigQueryConnection connection, string project, string? location, string? dataset, List<BigQueryChild> deferred)
    {
        var fallback = new BigQueryIndexMarks(dataset is null ? [] : [(project, dataset)], dataset is null);
        if (Interlocked.Increment(ref indexMarkWatches) > MaxIndexMarkWatches) { Interlocked.Decrement(ref indexMarkWatches); Record(connectionId, connection, project, fallback); return; }
        var lease = connection.Lease();
        if (lease is null) { Interlocked.Decrement(ref indexMarkWatches); return; }
        _ = Task.Run(async () =>
        {
            try
            {
                using (lease)
                {
                    var stop = bigQuery.Stopping;
                    var found = new HashSet<(string, string)>();
                    var unknown = deferred.Count > MaxDeferredReads;
                    foreach (var child in deferred.Take(MaxDeferredReads))
                    {
                        if (bigQuery.Find(connectionId) != connection) return;
                        try
                        {
                            if (TargetOf(await bigQuery.GetJobAsync(connection, project, child.Id, child.Location ?? location, stop)) is { } target) { if (!target.Item2.StartsWith('_')) found.Add(target); }
                            else unknown = true;
                        }
                        catch (Exception) when (!stop.IsCancellationRequested) { unknown = true; }
                    }
                    if (bigQuery.Find(connectionId) != connection) return;
                    Record(connectionId, connection, project, new(found, false));
                    if (unknown) Record(connectionId, connection, project, fallback);
                }
            }
            catch (Exception) { /* Best-effort: the next full build or Refresh reads the change. */ }
            finally { Interlocked.Decrement(ref indexMarkWatches); }
        });
    }

    /// <summary>
    /// Follows a job its request left unsettled (Stop, a lost connection, a tab closed or left running, a read that failed) in the
    /// background until BigQuery reports it DONE, then marks what its DDL changed, as a finished run does. Text with no word of a
    /// statement that changes objects needs no follow (a re-attach, which has no text, reads the job's own first). Polls jobs.get
    /// on its own lease of the client, its wait doubling from <see cref="IndexMarkPoll"/> to <see cref="IndexMarkPollMax"/>, at most
    /// <see cref="MaxIndexMarkWatches"/> at once; gives up when the handle is disconnected, the backend stops, the job stays missing
    /// (an insert that never created it), or after <see cref="IndexMarkGiveUp"/>.
    /// </summary>
    private void MarkIndexWhenDone(string connectionId, BigQueryConnection connection, string project, string jobId, string? location, string? dataset, string? sql)
    {
        if (sql is { Length: > 0 } && !GoogleSqlScanner.MayChangeObjects(sql)) return;
        if (Interlocked.Increment(ref indexMarkWatches) > MaxIndexMarkWatches) { Interlocked.Decrement(ref indexMarkWatches); return; }
        var lease = connection.Lease();
        if (lease is null) { Interlocked.Decrement(ref indexMarkWatches); return; }
        _ = Task.Run(async () =>
        {
            try
            {
                using (lease)
                {
                    var stop = bigQuery.Stopping;
                    var wait = IndexMarkPoll;
                    var since = System.Diagnostics.Stopwatch.StartNew();
                    Job? done = null;
                    int missing = 0, failures = 0;
                    while (!stop.IsCancellationRequested && since.Elapsed < IndexMarkGiveUp && bigQuery.Find(connectionId) == connection)
                    {
                        try
                        {
                            var job = await bigQuery.GetJobAsync(connection, project, jobId, location, stop);
                            // A re-attached job's own text: one that changes no object needs no follow.
                            if (sql is null && job.Configuration?.Query?.Query is { } text && !GoogleSqlScanner.MayChangeObjects(text)) return;
                            if (job.Status?.State == "DONE") { done = job; break; }
                            failures = 0;
                        }
                        // An insert cut off in flight may still be created for a short while; one that stays missing never ran.
                        catch (GoogleApiException error) when (error.HttpStatusCode == HttpStatusCode.NotFound) { if (++missing >= 3) return; }
                        catch (Exception) when (!stop.IsCancellationRequested) { if (++failures >= MaxFollowFailures) return; }
                        await Task.Delay(wait, stop);
                        wait = TimeSpan.FromTicks(Math.Min(wait.Ticks * 2, IndexMarkPollMax.Ticks));
                    }
                    if (done is null || bigQuery.Find(connectionId) != connection) return;
                    var statement = BigQueryService.StatementOf(done.Statistics);
                    List<BigQueryChild>? children = null;
                    var listedAll = false;
                    if (statement == "SCRIPT" || done.Statistics?.NumChildJobs > 0)
                    {
                        try { (children, listedAll) = await bigQuery.ChildrenAsync(connection, project, jobId, null, stop); }
                        catch (Exception) when (!stop.IsCancellationRequested) { children = null; }
                    }
                    MarkIndex(connectionId, connection, done, statement, children, listedAll, project, dataset, sql);
                }
            }
            catch (Exception) { /* Best-effort: the next full build or Refresh reads the change. */ }
            finally { Interlocked.Decrement(ref indexMarkWatches); }
        });
    }
}
