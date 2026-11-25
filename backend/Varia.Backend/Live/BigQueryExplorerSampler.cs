using Varia.Backend.BigQuery;

namespace Varia.Backend.Live;

/// <summary>
/// bigquery.explorer (docs/bigquery.md, Object Explorer): the chip on a BigQuery connection's Object Explorer node, the principal's
/// own pending and running jobs in the billing project. Each sample lists them with jobs.list (stateFilter pending and running, no
/// allUsers, projection=minimal; top-level jobs only, so a running script counts once), a free API call through the principal's
/// shared rate limiter (<see cref="BigQueryService.ListHistoryAsync"/>), never a query. It counts up to <see cref="MaxJobs"/>; past
/// that, status <c>more</c> is 1. It holds no table and stores nothing.
/// </summary>
internal sealed class BigQueryExplorerSampler(BigQueryService service, string connectionId) : ILiveSampler
{
    public const string Source = "bigquery.explorer";
    public const string Probe = "explorer.bigquery";
    /// <summary>The most jobs one sample counts (bigQueryExplorerLimits.runningJobs in src/shared/live/catalog.ts), in pages of
    /// <see cref="PageJobs"/>.</summary>
    internal const int MaxJobs = 10_000, PageJobs = 1000;
    private static readonly string[] OpenStates = ["pending", "running"];

    public int? PeriodMs => null;
    public bool Ended => false;
    public bool HasRates => false;
    public void Apply(object args) { }
    public uint[] Keep() => [];
    public void Release() { }
    public void Dispose() { }

    public Task<LiveOpening> OpenAsync(IReadOnlyList<LiveProbeState> probes, IReadOnlyList<LiveCursor> resume, CancellationToken token) =>
        Task.FromResult(new LiveOpening([.. probes.Select(probe => new LiveOpenedProbe(probe.Spec.Id, probe.IntervalMs, probe.Spec.IntervalMs.Min, probe.Spec.IntervalMs.Max, "ok"))]));

    public async Task<LiveSampleBatch> SampleAsync(IReadOnlyList<LiveDue> due, CancellationToken token)
    {
        var samples = new List<LiveSample>();
        var errors = new List<LiveProbeError>();
        foreach (var item in due)
        {
            if (item.Probe.Spec.Id != Probe) continue;
            var started = Environment.TickCount64;
            var connection = service.Find(connectionId) ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
            using var lease = connection.Lease() ?? throw new RequestException("NOT_CONNECTED", "The connection is no longer open.");
            using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
            budget.CancelAfter(Math.Max(1000, item.BudgetMs));
            int count;
            bool more;
            try { (count, more) = await CountAsync(connection, budget.Token); }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                errors.Add(LiveErrors.Create(Probe, "TIMEOUT", "BigQuery did not answer the job listing within the refresh's time budget."));
                continue;
            }
            catch (BigQueryOverLimit)
            {
                errors.Add(LiveErrors.Create(Probe, "SQL_ERROR", "BigQuery's job listing was larger than Varia reads."));
                continue;
            }
            catch (Exception error) when (!token.IsCancellationRequested)
            {
                errors.Add(Failure(error, connection.Options.Project));
                continue;
            }
            var cost = (int)Math.Min(int.MaxValue, Environment.TickCount64 - started);
            samples.Add(new LiveSample(Probe, cost, item.Probe.IntervalMs, item.ElapsedMs, item.Gap, item.Skipped, [count], null, null, [new LiveStatus("more", more ? 1 : 0)]));
        }
        return new LiveSampleBatch(samples, errors);
    }

    /// <summary>The principal's open top-level jobs, page by page up to <see cref="MaxJobs"/>; More when the listing went on past it.</summary>
    private async Task<(int Count, bool More)> CountAsync(BigQueryConnection connection, CancellationToken token)
    {
        var listing = new HistoryListing(AllUsers: false, States: OpenStates, Minimal: true);
        var ids = new HashSet<string>(StringComparer.Ordinal);
        string? pageToken = null;
        while (true)
        {
            var page = await service.ListHistoryAsync(connection, listing, pageToken, PageJobs, BigQueryJobHistory.ResponseBytes, token);
            // Only jobs BigQuery still reports open: a listing is not a snapshot, so a job that finished meanwhile may still be named.
            foreach (var job in page.Items)
                if (job.Open && job.Parent is null) ids.Add(job.Id);
            if (ids.Count > MaxJobs || ids.Count == MaxJobs && page.Next is not null) return (MaxJobs, true);
            if (page.Next is not { } next) return (ids.Count, false);
            pageToken = next;
        }
    }

    /// <summary>A failure as the probe's error, by the codes Job History uses (BigQueryJobsSampler).</summary>
    private static LiveProbeError Failure(Exception error, string project)
    {
        var mapped = BigQueryErrors.Map(error, project, "bigquery.jobs.list");
        var request = mapped as RequestException ?? new RequestException("BACKEND_ERROR", "BigQuery could not list the jobs.");
        var code = request.Code switch
        {
            "AUTH_EXPIRED" or "AUTH_KEY_FILE" => "AUTH_EXPIRED",
            "AUTH_IDENTITY" => "AUTH_IDENTITY",
            "PERMISSION_DENIED" or "QUOTA" or "API_DISABLED" or "NOT_FOUND" or "TIMEOUT" or "CONNECTION_LOST" => request.Code,
            _ => "SQL_ERROR"
        };
        return LiveErrors.Create(Probe, code, request.Message);
    }
}
