using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.Search;

namespace Varia.Backend.BigQuery;

/// <summary>
/// The index's billed bulk path (docs/object-search.md, BigQuery, Bulk index): region-scoped INFORMATION_SCHEMA queries
/// (<see cref="BigQueryBulkSql"/>) in place of pass 2's per-object calls, opt-in (textEditor.googleSql.bulkIndex). bigquery.indexEstimate
/// lists the projects' dataset locations and dry-runs each location's queries (free); the renderer shows the cost prompts and only then
/// sends explorer.index with those locations and the cap. Each job has Varia's own id, the location, the cap and no cache; leaving a
/// read early cancels its jobs.
/// </summary>
internal sealed partial class BigQueryService
{
    /// <summary>One location's queries' own time limit, every page included, inside the build; past it the location falls back to the free calls.</summary>
    internal TimeSpan BulkLimit { get; set; } = TimeSpan.FromMinutes(5);
    /// <summary>The estimate's own time limit inside its 120 s deadline.</summary>
    internal TimeSpan BulkEstimateLimit { get; set; } = TimeSpan.FromSeconds(110);

    /// <summary>bigquery.indexEstimate: the locations a full build's bulk path would read and what their queries would bill.</summary>
    public async Task<BigQueryIndexEstimateResult> IndexEstimateAsync(BigQueryIndexEstimateArgs args, CancellationToken token)
    {
        var watch = Stopwatch.StartNew();
        var connection = Find(args.ConnectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
        IBigQueryIndexSource source = this;
        var (billing, extras) = source.Projects(args.ConnectionId);
        List<string> projects = args.ExtraDetails == true ? [billing, .. extras] : [billing];
        var definitions = args.Definitions ?? true;
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(BulkEstimateLimit);
        try
        {
            var locations = new List<BigQueryIndexLocation>();
            var cut = false;
            foreach (var project in projects)
            {
                BigQueryDatasetList list;
                // A project whose datasets cannot be listed is skipped by the build too: there is nothing of it to estimate.
                try { list = await source.DatasetsAsync(args.ConnectionId, project, budget.Token); }
                catch (Exception error) when (!budget.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" }) { continue; }
                // Location ids are case-insensitive; each is kept as datasets.list spelled it first.
                foreach (var location in (list.Locations?.Values ?? []).Distinct(StringComparer.OrdinalIgnoreCase).Order(StringComparer.OrdinalIgnoreCase))
                {
                    if (locations.Count == BigQueryBulkSql.MaxLocations) { cut = true; break; }
                    locations.Add(new(project, location));
                }
            }
            // Each location's dry runs at once, through the principal's limiter; a location whose dry run fails is left out, so its
            // datasets get the free calls rather than a query no estimate covered.
            var estimates = await Task.WhenAll(locations.Select(async item =>
            {
                long bytes = 0;
                string? incomplete = null;
                try
                {
                    foreach (var (sql, views) in BigQueryBulkSql.Queries(item.Project, item.Location, definitions))
                    {
                        var dryRun = environment.Emulator ? new BigQueryEstimate(0, Faked: true)
                            : Estimate(await MetadataAsync(connection, t => DryRunAsync(connection.Client, billing, item.Location, sql, null, t), budget.Token));
                        // INFORMATION_SCHEMA reports no bytes for a view it bills at its floor: the floor is the figure, not an incomplete one.
                        if (dryRun.Incomplete is { } reason and not "zeroBytes") incomplete ??= reason;
                        bytes += BigQueryBulkSql.Billed(dryRun.BytesProcessed, views);
                    }
                    return (Item: item, Bytes: bytes, Incomplete: incomplete, Ok: true);
                }
                catch (Exception error) when (!budget.IsCancellationRequested && error is not RequestException { Code: "NOT_CONNECTED" })
                {
                    return (Item: item, Bytes: 0L, Incomplete: (string?)null, Ok: false);
                }
            }));
            var kept = estimates.Where(value => value.Ok).ToList();
            var total = kept.Aggregate(0L, (sum, value) => Math.Min(BigQueryLimits.MaxSafeInteger, sum + value.Bytes));
            return new([.. kept.Select(value => value.Item)], new(total, kept.Select(value => value.Incomplete).FirstOrDefault(value => value is not null), "SELECT", environment.Emulator),
                cut, watch.ElapsedMilliseconds);
        }
        catch (OperationCanceledException) when (budget.IsCancellationRequested && !token.IsCancellationRequested)
        {
            throw new RequestException("TIMEOUT", "BigQuery did not answer the estimate in time.");
        }
    }

    Job BulkJob(BigQueryConnection connection, string sql, string location, long? cap) => new()
    {
        JobReference = new JobReference { ProjectId = connection.Options.Project, JobId = NewJobId(), Location = location },
        Configuration = new JobConfiguration
        {
            Labels = new Dictionary<string, string>(Labels),
            Query = new JobConfigurationQuery { Query = sql, UseLegacySql = false, UseQueryCache = false, MaximumBytesBilled = cap }
        }
    };

    async IAsyncEnumerable<BigQueryBulkDataset> IBigQueryIndexSource.BulkAsync(string connectionId, string project, string location, bool definitions, long? cap,
        Func<string, string, bool> wanted, [EnumeratorCancellation] CancellationToken token)
    {
        var connection = Connection(connectionId);
        var billed = connection.Options.MaximumBytesBilled ?? cap;
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(BulkLimit);
        var stop = budget.Token;
        var references = new List<JobReference>();
        var cursors = new List<BulkCursor>();
        var finished = false;
        try
        {
            foreach (var (sql, _) in BigQueryBulkSql.Queries(project, location, definitions))
            {
                var request = BulkJob(connection, sql, location, billed);
                references.Add(request.JobReference);
                var job = await InsertJobAsync(connection, request, null, stop);
                if (BigQueryJobException.Of(job) is { } refused) throw BigQueryErrors.Job(refused.Result, refused.Errors, project, billed);
                cursors.Add(new BulkCursor(this, connection, job.JobReference ?? request.JobReference, location, billed, project, stop));
            }
            var columns = cursors[0];
            var views = cursors.ElementAtOrDefault(1);
            var routines = cursors.ElementAtOrDefault(2);
            while (true)
            {
                // The smallest dataset name any query is at: every query is in dataset order, so each dataset is gathered once.
                string? next = null;
                foreach (var cursor in cursors)
                    if (await cursor.DatasetAsync() is { } dataset && (next is null || string.CompareOrdinal(dataset, next) < 0)) next = dataset;
                if (next is null) break;
                // Only the objects the build still needs are kept (not a sharded group's older shards, nor objects with reused details),
                // under the dataset's character budget.
                var rows = new BigQueryBulkDataset(next);
                await columns.TakeAsync(next, row =>
                {
                    if (BulkCursor.Cell(row, 1) is { } table && wanted(next, table) && BulkCursor.Cell(row, 5) is { } path && BulkCursor.Cell(row, 6) is { } type)
                        rows.Add(table, BulkCursor.Cell(row, 2), new(path, type, BulkCursor.Cell(row, 7),
                            long.TryParse(BulkCursor.Cell(row, 3), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var ordinal) ? ordinal : long.MaxValue,
                            // tables.get's REPEATED mode is nullable to pass 2 (Mode != REQUIRED), while COLUMNS says an array is never NULL.
                            BulkCursor.Cell(row, 4) != "NO" || type.StartsWith("ARRAY<", StringComparison.OrdinalIgnoreCase)));
                });
                if (views is not null) await views.TakeAsync(next, row => { if (BulkCursor.Cell(row, 1) is { } name && wanted(next, name) && BulkCursor.Cell(row, 2) is { } text) rows.AddText(rows.Views, name, text); });
                if (routines is not null) await routines.TakeAsync(next, row => { if (BulkCursor.Cell(row, 1) is { } name && wanted(next, name) && BulkCursor.Cell(row, 2) is { } text) rows.AddText(rows.Routines, name, text); });
                // The time limit is BigQuery's: it stops while the build files the dataset's rows (and reads what they lack).
                budget.CancelAfter(Timeout.InfiniteTimeSpan);
                yield return rows;
                budget.CancelAfter(BulkLimit);
            }
            finished = true;
        }
        finally
        {
            foreach (var cursor in cursors) cursor.Dispose();
            // A read left early (Stop, the time limit, a failure, a superseded build) bills nothing more.
            if (!finished) foreach (var reference in references) _ = CancelDdlAsync(connection, reference);
        }
    }

    /// <summary>One bulk job's rows, a page at a time (jobs.getQueryResults), skipping rows whose dataset name is not one.</summary>
    sealed class BulkCursor(BigQueryService service, BigQueryConnection connection, JobReference job, string location, long? cap, string project, CancellationToken token) : IDisposable
    {
        BigQueryPage? page;
        int at;
        bool ended;

        public static string? Cell(JsonElement row, int index) =>
            row.TryGetProperty("f", out var cells) && cells.ValueKind == JsonValueKind.Array && index < cells.GetArrayLength()
            && cells[index].TryGetProperty("v", out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

        async Task<JsonElement?> PeekAsync()
        {
            while (true)
            {
                if (page is not null)
                {
                    for (; at < page.RowCount; at++)
                        if (BqNames.IsDataset(Cell(page.Rows[at], 0))) return page.Rows[at];
                    var next = page.PageToken;
                    page.Dispose();
                    page = null;
                    if (next is null) ended = true;
                    else page = await ReadAsync(next);
                    at = 0;
                    continue;
                }
                if (ended) return null;
                page = await ReadAsync(null);
                at = 0;
            }
        }

        /// <summary>A page; the first waits for the job to finish.</summary>
        async Task<BigQueryPage> ReadAsync(string? pageToken)
        {
            try
            {
                while (true)
                {
                    var fresh = await service.QueryResultsAsync(connection, job.ProjectId, job.JobId, job.Location ?? location, pageToken, service.PageRows, 10_000, token);
                    if (fresh.JobComplete) return fresh;
                    fresh.Dispose();
                    await Task.Delay(service.DdlPoll, token);
                }
            }
            catch (BigQueryJobException failed) { throw BigQueryErrors.Job(failed.Result, failed.Errors, project, cap); }
        }

        public async Task<string?> DatasetAsync() => await PeekAsync() is { } row ? Cell(row, 0) : null;

        public async Task TakeAsync(string dataset, Action<JsonElement> each)
        {
            while (await PeekAsync() is { } row && Cell(row, 0) == dataset)
            {
                each(row);
                at++;
            }
        }

        public void Dispose()
        {
            page?.Dispose();
            page = null;
        }
    }
}
