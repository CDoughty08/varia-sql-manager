using Varia.Backend.BigQuery;
using Varia.Backend.Results;

namespace Varia.Backend.Live;

/// <summary>
/// bigquery.jobs (docs/bigquery.md, Job History): a BigQuery connection's jobs, read through BigQuery's REST API by
/// <see cref="BigQueryService"/>, never by SQL. A new listing (the first sample, new scope or filters) reads the newest jobs of the
/// range page by page, newest first, up to <see cref="BigQueryJobHistory.MaxJobs"/>; each later sample asks for jobs created since
/// a minute before the newest one held, for the open jobs (stateFilter pending and running), and, for each held open job missing
/// from that answer, its final state (jobs.get, or one stateFilter=done listing over their creation window where jobs.get is not
/// allowed). A DONE job never changes, so it is kept and never read again. In All users a minimal My jobs listing marks the
/// principal's own jobs. A sample stops at its budget or <see cref="BigQueryJobHistory.ResponseBytes"/> of answers and goes on
/// from there at the next one, which comes at the asked interval while the list is loading or a job is open, else at the
/// catalogue's idleIntervalMs (<see cref="IsIdle"/>). Every table goes through the live table writers (LiveTables.cs).
/// </summary>
internal sealed class BigQueryJobsSampler : ILiveSampler
{
    public const string Source = "bigquery.jobs";
    public const string Probe = "bigquery.jobs.list";
    /// <summary>jobs.get calls one sample makes for open jobs that finished; the rest wait for the next sample.</summary>
    internal const int FinishedReads = 32;
    private readonly BigQueryService service;
    private readonly string connectionId;
    private readonly LiveTableSet tables;
    private readonly Lock gate = new();
    private BigQueryJobHistoryArgs pending;
    private View view;
    /// <summary>The last sample left nothing open and nothing to load (read by the subscription after the sample).</summary>
    private volatile bool idle;
    /// <summary>Answers read so far, and the samples in a row the budget cut before any answer landed (a stalled network, rate
    /// limits retried until the budget ran out): after <see cref="StallsBeforeTimeout"/> the probe fails with TIMEOUT rather than
    /// say "still loading" for ever.</summary>
    private long answers;
    private int stalls;
    internal const int StallsBeforeTimeout = 3;

    /// <summary>What one listing holds: the top-level jobs by id, which of them are the principal's (All users), how far the
    /// first listing has read, the newest creation time held, and the children of expanded scripts.</summary>
    private sealed class View(BigQueryJobHistoryArgs args)
    {
        public BigQueryJobHistoryArgs Args { get; set; } = args;
        public Dictionary<string, HistoryJob> Held { get; } = new(StringComparer.Ordinal);
        public HashSet<string> Mine { get; } = new(StringComparer.Ordinal);
        /// <summary>Jobs a My jobs listing has already been asked about (All users), so each is classified once.</summary>
        public HashSet<string> Classified { get; } = new(StringComparer.Ordinal);
        public string? FirstToken { get; set; }
        /// <summary>The first listing's window while it goes on from <see cref="FirstToken"/>: a page token belongs to its request.</summary>
        public HistoryListing? First { get; set; }
        /// <summary>Where the pinned jobs' reads start this sample, so a large answer early in the list cannot starve a later job.</summary>
        public int PinnedStart { get; set; }
        public bool FirstDone { get; set; }
        /// <summary>The newest creation time a listing has read so far; it becomes <see cref="Newest"/> only once that listing is
        /// whole, so a refresh stopped after its first page lists its later pages again rather than leave a gap.</summary>
        public long Candidate { get; set; } = -1;
        /// <summary>A refresh listing the budget stopped, and where it goes on next time.</summary>
        public HistoryListing? Since { get; set; }
        public string? SinceToken { get; set; }
        /// <summary>The jobs shown that the refresh under way has merged, over every sample it took: its cap.</summary>
        public int SinceMerged { get; set; }
        /// <summary>The unreachable locations the listing under way has reported (they replace the last whole listing's).</summary>
        public SortedSet<string> Reporting { get; } = new(StringComparer.Ordinal);
        /// <summary>All users: a My jobs listing the budget stopped while classifying, and where it goes on next time.</summary>
        public HistoryListing? Classifying { get; set; }
        public string? ClassifyToken { get; set; }
        /// <summary>The jobs the window under way classifies: those held when it began, since an earlier page went by before a
        /// job listed later was held.</summary>
        public HashSet<string>? ClassifyIds { get; set; }
        public bool More { get; set; }
        public long Newest { get; set; } = -1;
        public SortedSet<string> Unreachable { get; } = new(StringComparer.Ordinal);
        public bool AllUsersDenied { get; set; }
        /// <summary>jobs.get on another user's job was refused: finished jobs of others are read by a done listing instead.</summary>
        public bool GetDenied { get; set; }
        public Dictionary<string, (List<HistoryJob> Items, bool More)> Children { get; } = new(StringComparer.Ordinal);
        /// <summary>Pinned jobs BigQuery no longer has (or never had), left out without asking again.</summary>
        public HashSet<string> Missing { get; } = new(StringComparer.Ordinal);
    }

    public BigQueryJobsSampler(BigQueryService service, ResultStore store, string subscriptionId, string connectionId, BigQueryJobHistoryArgs? args, LiveLimitsJson limits)
    {
        this.service = service;
        this.connectionId = connectionId;
        tables = new LiveTableSet(store, subscriptionId, limits);
        pending = args ?? new BigQueryJobHistoryArgs("mine");
        view = new(pending);
    }

    public int? PeriodMs => null;
    public bool Ended => false;
    public bool HasRates => false;
    public bool IsIdle(string probe) => idle;

    public void Apply(object value)
    {
        lock (gate) pending = (BigQueryJobHistoryArgs)value;
    }

    public Task<LiveOpening> OpenAsync(IReadOnlyList<LiveProbeState> probes, IReadOnlyList<LiveCursor> resume, CancellationToken token) =>
        Task.FromResult(new LiveOpening([.. probes.Select(probe => new LiveOpenedProbe(probe.Spec.Id, probe.IntervalMs, probe.Spec.IntervalMs.Min, probe.Spec.IntervalMs.Max, "ok"))]));

    public async Task<LiveSampleBatch> SampleAsync(IReadOnlyList<LiveDue> due, CancellationToken token)
    {
        BigQueryJobHistoryArgs args;
        lock (gate) args = pending;
        // New scope or filters list from scratch; new expanded scripts or prices only change what is written.
        if (!args.SameListing(view.Args)) view = new(args);
        else view.Args = args;
        tables.BeginTick();
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
            var loading = false;
            LiveProbeError? failure = null;
            var answered = answers;
            try
            {
                loading = !await RefreshAsync(connection, view, item.BudgetMs, budget.Token);
                stalls = 0;
            }
            catch (OperationCanceledException) when (!token.IsCancellationRequested)
            {
                loading = true;
                stalls = answers == answered ? stalls + 1 : 0;
                if (stalls >= StallsBeforeTimeout)
                {
                    stalls = 0;
                    failure = LiveErrors.Create(Probe, "TIMEOUT", "BigQuery did not answer the job listing within the refresh's time budget, several times in a row.");
                }
            }
            catch (Exception error) when (!token.IsCancellationRequested)
            {
                failure = Failure(error, connection.Options.Project);
            }
            if (failure is not null)
            {
                errors.Add(failure);
                idle = false;
                continue;
            }
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var rows = Rows(view, now);
            // Idle only once nothing followed is open, shown or not; the status line counts what the filters show.
            idle = !loading && !view.Held.Values.Any(job => job.Open) && view.Children.Values.All(children => !children.Items.Any(child => child.Open));
            var shown = view.Held.Values.Where(job => Shown(view.Args, job)).ToList();
            var open = shown.Count(job => job.Open);
            var unreachable = string.Join(", ", view.Unreachable);
            var status = new List<LiveStatus>
            {
                new("held", shown.Count), new("more", view.More ? 1 : 0), new("loading", loading ? 1 : 0),
                new("unreachable", unreachable.Length <= 128 ? unreachable : unreachable[..127] + "…"), new("open", open), new("allUsersDenied", view.AllUsersDenied ? 1 : 0)
            };
            var write = tables.Snapshot(item.Probe.Spec, 0).Write(rows, new(item.Sort, item.Filter, null, item.Tracks.GetValueOrDefault(0)));
            var cost = (int)Math.Min(int.MaxValue, Environment.TickCount64 - started);
            samples.Add(new LiveSample(Probe, cost, item.Probe.IntervalMs, item.ElapsedMs, item.Gap, item.Skipped, null, write.Sample is { } table ? [table] : null, null, status));
            if (write.Budget) errors.Add(LiveErrors.Create(Probe, "BUDGET", LiveErrors.BudgetMessage) with { Tables = [0] });
        }
        return new LiveSampleBatch(samples, errors);
    }

    /// <summary>A failure as the probe's error: BigQuery's refusals by their codes (AUTH_EXPIRED, PERMISSION_DENIED, QUOTA,
    /// API_DISABLED, NOT_FOUND, TIMEOUT, CONNECTION_LOST), anything else as a failed read with its message.</summary>
    static LiveProbeError Failure(Exception error, string project)
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

    /// <summary>One sample's reads; false when the budget stopped the listing before it was whole (it goes on next time).</summary>
    private async Task<bool> RefreshAsync(BigQueryConnection connection, View state, int budgetMs, CancellationToken token)
    {
        long bytes = BigQueryJobHistory.ResponseBytes;
        // Every loop asks Left() before its next request: past three quarters of the time budget it answers 0, so a listing stops
        // between pages. Each listing saves its page token as each page lands, so the budget's cancellation, the backstop, loses
        // only the request it cut.
        var deadline = Environment.TickCount64 + Math.Max(1000, budgetMs) * 3 / 4;
        int Left() => Environment.TickCount64 >= deadline ? 0 : (int)Math.Clamp(bytes, 0, int.MaxValue);
        void Spend(long spent) { bytes -= spent; answers++; }
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var args = state.Args;
        var (min, max) = Range(args, now);
        if (args.Pinned is { } pinned)
        {
            var whole = await PinnedAsync(connection, state, pinned, token, Left, Spend);
            if (!whole) return false;
        }
        else if (args.AllUsers && state.AllUsersDenied)
        {
            // BigQuery refused All users: nothing to list until the renderer turns the toggle off (new args).
            return true;
        }
        else
        {
            // What leaves the range as it slides (Last hour and the rest are counted back from now) leaves the view.
            foreach (var old in state.Held.Values.Where(job => job.Created is { } created && created < min).Select(job => job.Id).ToList()) state.Held.Remove(old);
            var listing = new HistoryListing(args.AllUsers, min, max, ServerStates(args));
            var whole = true;
            try
            {
                if (!state.FirstDone)
                {
                    state.First ??= listing;
                    var done = await ListAsync(connection, state, state.First, state.FirstToken, next => state.FirstToken = next, token, Left, Spend, first: true);
                    if (done) (state.First, state.FirstToken, state.FirstDone) = (null, null, true);
                    else whole = false;
                    // A first listing that takes several samples follows the open jobs it has read so far.
                    if (!done && !await FinishedAsync(connection, state, listing, token, Left, Spend)) whole = false;
                }
                else
                {
                    // A stopped refresh goes on from its page with its own window; a new one starts at the newest job read whole.
                    state.Since ??= listing with { MinCreated = Math.Max(min, state.Newest - BigQueryJobHistory.OverlapMs) };
                    var done = await ListAsync(connection, state, state.Since, state.SinceToken, next => state.SinceToken = next, token, Left, Spend, first: false);
                    if (done) (state.Since, state.SinceToken, state.SinceMerged) = (null, null, 0);
                    else whole = false;
                    // Open jobs are followed even while new jobs are still being listed.
                    if (!await FinishedAsync(connection, state, listing, token, Left, Spend)) whole = false;
                }
            }
            finally { Trim(state); }
            if (args.AllUsers && !state.AllUsersDenied && !await ClassifyAsync(connection, state, token, Left, Spend)) whole = false;
            return await ExpandAsync(connection, state, token, Left, Spend) && whole;
        }
        return await ExpandAsync(connection, state, token, Left, Spend);
    }

    /// <summary>The range's creation window in epoch ms: hours back from now, or a custom from and to kept within BigQuery's
    /// retention.</summary>
    internal static (long Min, long? Max) Range(BigQueryJobHistoryArgs args, long now)
    {
        var oldest = now - BigQueryJobHistory.RetentionMs;
        if (args.From is { } from && args.To is { } to) return (Math.Max(from, oldest), Math.Max(to, oldest));
        return (Math.Max(now - (args.Hours ?? 24) * 3_600_000L, oldest), null);
    }

    /// <summary>The states the listing asks BigQuery for: pending and running when the state filter names only those (both, since
    /// a pending job the listing left out could start running behind its watermark), else every state, since an open job is
    /// followed until it finishes (and done, failed and cancelled split only after).</summary>
    internal static string[]? ServerStates(BigQueryJobHistoryArgs args) =>
        args.States is { Length: > 0 } states && states.All(state => state is "running" or "pending") ? ["pending", "running"] : null;

    /// <summary>Whether a job passes the type, statement and Started from Varia filters (the state filter applies as rows are
    /// written).</summary>
    internal static bool Passes(BigQueryJobHistoryArgs args, HistoryJob job) =>
        (args.Types is not { } types || types.Contains(job.Type, StringComparer.Ordinal))
        && (args.Statements is not { } statements || job.Statement is { } statement && statements.Contains(statement, StringComparer.Ordinal))
        && (args.Varia is not true || job.Varia);

    /// <summary>Pages of a listing merged into the view; with <paramref name="first"/> the newest jobs up to the cap (More says
    /// the range holds more). Returns whether it read to the end; <paramref name="save"/> gets the token to go on from as each
    /// page lands.</summary>
    private async Task<bool> ListAsync(BigQueryConnection connection, View state, HistoryListing listing, string? pageToken, Action<string?> save, CancellationToken token,
        Func<int> left, Action<long> spend, bool first)
    {
        var size = BigQueryJobHistory.PageJobs;
        while (true)
        {
            token.ThrowIfCancellationRequested();
            if (left() <= 0) return false;
            HistoryPage? page;
            try { page = await ListPageAsync(connection, state, listing, pageToken, size, left(), token); }
            catch (BigQueryOverLimit)
            {
                if (size > 1 && left() >= BigQueryJobHistory.JobBytes) { size = Math.Max(1, size / 4); continue; }
                return false;
            }
            if (page is null) return true;
            spend(page.Bytes);
            foreach (var place in page.Unreachable) state.Reporting.Add(place);
            foreach (var job in page.Items)
            {
                // Every top-level job moves the watermark, filtered out or not: else a rare filter would list the whole range anew.
                if (job.Parent is null && job.Created is { } created && created > state.Candidate) state.Candidate = created;
                if (Merge(state, job) && !first) state.SinceMerged++;
            }
            pageToken = page.Next;
            save(pageToken);
            // The cap: the newest 1,000 jobs shown. A refresh after a long pause stops there too, since Trim keeps only those.
            if (pageToken is null || (first ? state.Held.Values.Count(job => Shown(state.Args, job)) : state.SinceMerged) >= BigQueryJobHistory.MaxJobs)
            {
                if (pageToken is not null) state.More = true;
                Whole(state);
                return true;
            }
        }
    }

    /// <summary>A listing read to its end (or to the cap): its newest job and its unreachable locations stand.</summary>
    private static void Whole(View state)
    {
        state.Newest = Math.Max(state.Newest, state.Candidate);
        state.Unreachable.Clear();
        state.Unreachable.UnionWith(state.Reporting);
        state.Reporting.Clear();
    }

    /// <summary>One page; a refused All users listing (PERMISSION_DENIED) marks the view denied and answers null (an empty list),
    /// so the renderer turns the toggle off and says why.</summary>
    private async Task<HistoryPage?> ListPageAsync(BigQueryConnection connection, View state, HistoryListing listing, string? pageToken, int size, int limit, CancellationToken token)
    {
        try { return await service.ListHistoryAsync(connection, listing, pageToken, size, limit, token); }
        catch (Exception error) when (listing.AllUsers && !token.IsCancellationRequested && error is not BigQueryOverLimit
            && BigQueryErrors.Map(error, connection.Options.Project) is RequestException { Code: "PERMISSION_DENIED" })
        {
            state.AllUsersDenied = true;
            state.Held.Clear();
            return null;
        }
    }

    /// <summary>A listed top-level job into the view: one the filters show, or any open one, which is followed until it finishes
    /// (a pending job may not show its statement type yet, nor a running one its final state; Rows writes only those shown). A
    /// finished job the filters leave out never changes, so it is dropped. True when it is shown.</summary>
    private static bool Merge(View state, HistoryJob job)
    {
        if (job.Parent is not null) return false;
        // A finished job never opens again: an older listing's answer (the refresh's overlap) does not undo what jobs.get read.
        if (job.Open && state.Held.TryGetValue(job.Id, out var held) && !held.Open) return Shown(state.Args, held);
        var shown = Shown(state.Args, job);
        if (shown || job.Open) state.Held[job.Id] = job;
        else state.Held.Remove(job.Id);
        return shown;
    }

    /// <summary>The cap: the newest jobs shown stay, and apart from them the newest open jobs the filters leave out, followed
    /// until they finish into the filters (each up to <see cref="BigQueryJobHistory.MaxJobs"/>); dropping a shown one says the range
    /// holds more.</summary>
    private static void Trim(View state)
    {
        // What the view no longer holds needs no classification kept (All users would otherwise remember every job it saw).
        state.Classified.IntersectWith(state.Held.Keys);
        state.Mine.IntersectWith(state.Held.Keys);
        if (state.Held.Count <= BigQueryJobHistory.MaxJobs) return;
        static IEnumerable<HistoryJob> Newest(IEnumerable<HistoryJob> jobs) => jobs.OrderByDescending(job => job.Created ?? 0).ThenBy(job => job.Id, StringComparer.Ordinal);
        var shown = Newest(state.Held.Values.Where(job => Shown(state.Args, job))).Skip(BigQueryJobHistory.MaxJobs).ToList();
        var followed = Newest(state.Held.Values.Where(job => !Shown(state.Args, job) && job.Open)).Skip(BigQueryJobHistory.MaxJobs);
        if (shown.Count > 0) state.More = true;
        foreach (var job in shown.Concat(followed).ToList())
        {
            state.Held.Remove(job.Id);
            state.Children.Remove(job.Id);
        }
        state.Classified.IntersectWith(state.Held.Keys);
        state.Mine.IntersectWith(state.Held.Keys);
    }

    /// <summary>The open jobs: a pending and running listing updates them, and those missing from it have finished since, read by
    /// jobs.get (the principal's own, and others' unless BigQuery refused that once) or by one done listing over their creation
    /// window.</summary>
    private async Task<bool> FinishedAsync(BigQueryConnection connection, View state, HistoryListing listing, CancellationToken token, Func<int> left, Action<long> spend)
    {
        var held = state.Held.Values.Where(job => job.Open).ToList();
        if (held.Count == 0) return true;
        var open = held.Select(job => job.Id).ToHashSet(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        // Over the held open jobs' own window: an open job created before the oldest of them is new, and the refresh lists it.
        var start = listing.MinCreated ?? 0;
        var oldest = held.All(job => job.Created is not null) ? held.Min(job => job.Created!.Value) : start;
        var openListing = listing with { States = ["pending", "running"], MinCreated = Math.Max(start, oldest) };
        var unreachable = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string? pageToken = null;
        var size = BigQueryJobHistory.PageJobs;
        while (true)
        {
            if (left() <= 0) return false;
            HistoryPage? page;
            try { page = await ListPageAsync(connection, state, openListing, pageToken, size, left(), token); }
            catch (BigQueryOverLimit)
            {
                // Pages of long query texts: fewer jobs a page, as the listing does.
                if (size > 1 && left() >= BigQueryJobHistory.JobBytes) { size = Math.Max(1, size / 4); continue; }
                return false;
            }
            if (page is null) return true;
            spend(page.Bytes);
            unreachable.UnionWith(page.Unreachable);
            foreach (var job in page.Items)
            {
                seen.Add(job.Id);
                Merge(state, job);
            }
            pageToken = page.Next;
            if (pageToken is null) break;
        }
        // Missing from the answer is finished, unless its location could not be read: it stays open till the next sample.
        var finished = open.Where(id => !seen.Contains(id) && state.Held.TryGetValue(id, out var job) && job.Open && (job.Location is null || !unreachable.Contains(job.Location)))
            .Select(id => state.Held[id]).ToList();
        if (finished.Count == 0) return true;
        var others = new List<HistoryJob>();
        var reads = 0;
        foreach (var job in finished)
        {
            var own = !state.Args.AllUsers || state.Mine.Contains(job.Id);
            if (!own && state.GetDenied) { others.Add(job); continue; }
            // The read's limit is what is left (a job without its details is small); an over-long answer stops it till next time.
            if (reads++ >= FinishedReads || left() <= 0) return false;
            var limit = Math.Min(left(), BigQueryJobHistory.JobBytes);
            try
            {
                var read = await service.ReadHistoryJobAsync(connection, job.Id, job.Location, limit, detail: false, token);
                spend(read.Bytes);
                // Merged: a job that finished in a state the filters leave out is dropped.
                if (read.Job is { } done && done.Id == job.Id) Merge(state, done);
            }
            catch (BigQueryOverLimit) when (limit < BigQueryJobHistory.JobBytes) { return false; }
            // Larger than a job's whole limit: its own done listing, which may take what is left of the sample, reads it.
            catch (BigQueryOverLimit) { others.Add(job); }
            catch (Exception error) when (!token.IsCancellationRequested && BigQueryErrors.Map(error, connection.Options.Project) is RequestException { Code: var code } && code is "PERMISSION_DENIED" or "NOT_FOUND")
            {
                if (code == "NOT_FOUND") state.Held.Remove(job.Id);
                else if (own) throw;
                else { state.GetDenied = true; others.Add(job); }
            }
        }
        if (others.Count == 0) return true;
        // Others' jobs that finished, where jobs.get is refused: one done listing over their creation window.
        // Each one's own millisecond, so an old one is never starved behind the pages of every job that finished since.
        foreach (var other in others)
        {
            var window = listing with { States = ["done"], MinCreated = other.Created ?? 0, MaxCreated = (other.Created ?? 0) + 1 };
            pageToken = null;
            size = BigQueryJobHistory.PageJobs;
            while (true)
            {
                if (left() <= 0) return false;
                HistoryPage? page;
                try { page = await ListPageAsync(connection, state, window, pageToken, size, left(), token); }
                catch (BigQueryOverLimit)
                {
                    if (size > 1 && left() >= BigQueryJobHistory.JobBytes) { size = Math.Max(1, size / 4); continue; }
                    return false;
                }
                if (page is null) return true;
                spend(page.Bytes);
                if (page.Items.FirstOrDefault(job => job.Id == other.Id) is { } done) { Merge(state, done); break; }
                pageToken = page.Next;
                if (pageToken is null) break;
            }
        }
        return true;
    }

    /// <summary>Which held jobs are the principal's, from minimal My jobs listings: All users lists the creation window of those
    /// not yet asked about, going on from its page next time when the budget stops it; pinned jobs (<paramref name="narrow"/>),
    /// which can be months apart, list each one's own millisecond rather than every job between them. Never an email
    /// comparison.</summary>
    private async Task<bool> ClassifyAsync(BigQueryConnection connection, View state, CancellationToken token, Func<int> left, Action<long> spend, bool narrow = false)
    {
        var unknown = state.Held.Values.Where(job => !state.Classified.Contains(job.Id) && job.Created is not null).ToList();
        if (unknown.Count == 0 && state.Classifying is null) return true;
        if (narrow)
        {
            foreach (var job in unknown)
            {
                if (!await MineAsync(connection, state, new HistoryListing(false, job.Created!.Value, job.Created.Value + 1, Minimal: true), null, _ => { }, token, left, spend)) return false;
                state.Classified.Add(job.Id);
            }
            return true;
        }
        if (state.Classifying is null)
        {
            state.Classifying = new HistoryListing(false, unknown.Min(job => job.Created!.Value), unknown.Max(job => job.Created!.Value) + 1, Minimal: true);
            state.ClassifyIds = [.. unknown.Select(job => job.Id)];
        }
        if (!await MineAsync(connection, state, state.Classifying, state.ClassifyToken, next => state.ClassifyToken = next, token, left, spend)) return false;
        // Only the jobs held when the window began: one listed since waits for the next window.
        state.Classified.UnionWith(state.ClassifyIds!.Where(state.Held.ContainsKey));
        (state.Classifying, state.ClassifyToken, state.ClassifyIds) = (null, null, null);
        return true;
    }

    /// <summary>Pages of a minimal My jobs listing, each held job marked the principal's; whether it read to the end, with
    /// <paramref name="save"/> getting the token to go on from as each page lands.</summary>
    private async Task<bool> MineAsync(BigQueryConnection connection, View state, HistoryListing listing, string? pageToken, Action<string?> save, CancellationToken token,
        Func<int> left, Action<long> spend)
    {
        while (true)
        {
            if (left() <= 0) return false;
            HistoryPage page;
            try { page = await service.ListHistoryAsync(connection, listing, pageToken, BigQueryJobHistory.PageJobs, left(), token); }
            catch (BigQueryOverLimit) { return false; }
            spend(page.Bytes);
            foreach (var job in page.Items.Where(job => state.Held.ContainsKey(job.Id))) state.Mine.Add(job.Id);
            pageToken = page.Next;
            save(pageToken);
            if (pageToken is null) return true;
        }
    }

    /// <summary>Pinned jobs (a Messages link, records without a tab): each read with jobs.get whatever its age, again only while
    /// it is open, and marked the principal's by a minimal My jobs listing over their creation window.</summary>
    private async Task<bool> PinnedAsync(BigQueryConnection connection, View state, BigQueryJobReference[] pinned, CancellationToken token, Func<int> left, Action<long> spend)
    {
        var start = state.PinnedStart++ % pinned.Length;
        foreach (var reference in pinned.Skip(start).Concat(pinned.Take(start)))
        {
            if (state.Missing.Contains(reference.JobId) || state.Held.TryGetValue(reference.JobId, out var held) && !held.Open) continue;
            if (left() <= 0) return false;
            var limit = Math.Min(left(), BigQueryJobHistory.JobBytes);
            try
            {
                var read = await service.ReadHistoryJobAsync(connection, reference.JobId, reference.Location, limit, detail: false, token);
                spend(read.Bytes);
                // A pinned view shows its jobs whatever the other filters say.
                if (read.Job is { } job && job.Id == reference.JobId) state.Held[job.Id] = job;
                else state.Missing.Add(reference.JobId);
            }
            // Over what was left of this sample's budget: next time. Over a job's whole limit: it is never shown.
            catch (BigQueryOverLimit) when (limit < BigQueryJobHistory.JobBytes) { return false; }
            catch (BigQueryOverLimit) { state.Missing.Add(reference.JobId); }
            catch (Exception error) when (!token.IsCancellationRequested && BigQueryErrors.Map(error, connection.Options.Project) is RequestException { Code: "NOT_FOUND" or "PERMISSION_DENIED" })
            {
                state.Missing.Add(reference.JobId);
            }
        }
        return await ClassifyAsync(connection, state, token, left, spend, narrow: true);
    }

    /// <summary>The children of expanded scripts, read again only while the script runs (or until a read was whole).</summary>
    private async Task<bool> ExpandAsync(BigQueryConnection connection, View state, CancellationToken token, Func<int> left, Action<long> spend)
    {
        var expanded = state.Args.Expand?.Select(job => job.JobId).ToHashSet(StringComparer.Ordinal) ?? [];
        foreach (var gone in state.Children.Keys.Where(id => !expanded.Contains(id)).ToList()) state.Children.Remove(gone);
        foreach (var id in expanded)
        {
            if (!state.Held.TryGetValue(id, out var parent) || !parent.Script)
            {
                // A script the view no longer holds (finished out of the filters, slid out of the range) keeps no children,
                // which would otherwise keep the probe from ever going idle.
                state.Children.Remove(id);
                continue;
            }
            // Read once after the script finished; again only while a budget cut its statements short of the cap.
            if (state.Children.TryGetValue(id, out var cached) && !parent.Open && cached.Items.All(child => !child.Open)
                && (!cached.More || cached.Items.Count >= BigQueryJobHistory.Children)) continue;
            if (left() <= 0) return false;
            var before = left();
            var allUsers = state.Args.AllUsers && !state.Mine.Contains(id) && !state.AllUsersDenied;
            try
            {
                // Past the soft deadline it keeps the statements read so far, with More, and reads them again next time.
                var (items, more, spent) = await service.ChildJobsAsync(connection, id, allUsers, before, token, () => left() <= 0);
                state.Children[id] = (items, more);
                spend(spent);
            }
            catch (Exception error) when (!token.IsCancellationRequested && error is not OperationCanceledException
                && BigQueryErrors.Map(error, connection.Options.Project) is RequestException { Code: "PERMISSION_DENIED" or "NOT_FOUND" })
            {
                state.Children[id] = ([], false);
            }
        }
        return true;
    }

    /// <summary>Whether a held job is a row: it passes the filters, or the view is pinned, which shows its jobs whatever they say.</summary>
    private static bool Shown(BigQueryJobHistoryArgs args, HistoryJob job) =>
        args.Pinned is not null || Passes(args, job) && (args.States is not { } states || states.Contains(job.State, StringComparer.Ordinal));

    /// <summary>The grid's rows: held jobs newest first that pass the state filter, each expanded script's children under it in
    /// statement order.</summary>
    private static List<LiveRow> Rows(View state, long now)
    {
        var args = state.Args;
        var rows = new List<LiveRow>();
        var expanded = args.Expand?.Select(job => job.JobId).ToHashSet(StringComparer.Ordinal) ?? [];
        // A pinned statement of a script that is pinned and expanded too shows under its script alone: a row's key is its job id.
        var under = expanded.Where(state.Held.ContainsKey).SelectMany(id => state.Children.TryGetValue(id, out var listed) ? listed.Items : []).Select(child => child.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var job in state.Held.Values.OrderByDescending(job => job.Created ?? 0).ThenBy(job => job.Id, StringComparer.Ordinal))
        {
            if (under.Contains(job.Id)) continue;
            if (!Shown(args, job)) continue;
            var mine = args.AllUsers || args.Pinned is not null ? state.Mine.Contains(job.Id) : true;
            var open = expanded.Contains(job.Id) && state.Children.TryGetValue(job.Id, out var children) ? children.Items : null;
            rows.Add(Row(job, now, mine, args.Prices != false, job.Script ? open is null ? "▸ " : "▾ " : "", null));
            foreach (var child in open ?? []) rows.Add(Row(child, now, mine, args.Prices != false, "    ↳ ", job.Id));
        }
        return rows;
    }

    private static readonly Dictionary<string, string> StateLabels = new(StringComparer.Ordinal)
    {
        ["running"] = "Running", ["pending"] = "Pending", ["done"] = "Done", ["failed"] = "Failed", ["cancelled"] = "Cancelled"
    };
    private static readonly Dictionary<string, string> TypeLabels = new(StringComparer.Ordinal)
    {
        ["query"] = "Query", ["load"] = "Load", ["extract"] = "Extract", ["copy"] = "Copy", ["other"] = "Other"
    };

    /// <summary>One row in the catalogue's column order (jobHistoryColumns).</summary>
    internal static LiveRow Row(HistoryJob job, long now, bool mine, bool prices, string prefix, string? parent)
    {
        var duration = BigQueryJobHistory.DurationOf(job, now);
        LiveCell Bytes(long? value) => value is { } bytes ? new LiveCell(bytes, BigQueryCost.Bytes(bytes)) : LiveCell.Null;
        LiveCell Time(long? value) => value is { } ms ? new LiveCell(ms, BigQueryCost.SlotTime(ms)) : LiveCell.Null;
        var hidden = job.Hidden && !mine;
        return new LiveRow([
            LiveCell.Of(StateLabels[job.State]),
            LiveCell.Of(prefix + job.Id),
            LiveCell.Of(TypeLabels[job.Type]),
            LiveCell.Of(job.Statement),
            LiveCell.Of(job.User),
            job.Created is { } created ? LiveCell.DateTime2(DateTimeOffset.FromUnixTimeMilliseconds(created).LocalDateTime, 0) : LiveCell.Null,
            Time(duration),
            Bytes(job.Processed),
            Bytes(job.Billed),
            prices && job.Billed is { } billed ? new LiveCell(billed, BigQueryCost.Dollars(billed)) : LiveCell.Null,
            Time(job.SlotMs),
            LiveCell.Of(job.CacheHit switch { true => "Yes", false => "No", null => null }),
            LiveCell.Of(job.Location),
            LiveCell.Of(job.Varia ? "Varia" : null),
            LiveCell.Of(job.Destination),
            LiveCell.Of(job.ErrorMessage is null ? null : (job.ErrorReason is null ? "" : job.ErrorReason + ": ") + job.ErrorMessage),
            LiveCell.Of(hidden ? "Details hidden by BigQuery" : job.Sql),
            LiveCell.Of(job.Id),
            LiveCell.Of(parent),
            LiveCell.Bit(mine),
            LiveCell.Bit(hidden),
            LiveCell.Of(job.Children),
            LiveCell.Of(job.State switch { "running" => "running", "failed" => "error", "cancelled" => "muted", _ => null })
        ]);
    }

    public LiveSampleBatch Resort(IReadOnlyList<LiveDue> probes) => tables.Resort(probes);
    public uint[] Keep() => tables.Keep(tables.Limits.Kept);
    public void Release() => tables.Release();
    public void Dispose() { }
}
