using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;
using Varia.Backend.Explorer;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Live;

/// <summary>What the live service needs from SqlService.</summary>
internal interface ILiveHost
{
    /// <summary>VARIA_BACKEND_TEST_HOOKS=1: test-only sources (debug.synthetic) are accepted.</summary>
    bool TestHooks { get; }
    bool IsConnected(string connectionId);
    /// <summary>The server a connection reaches, the same for every login and database on it (the per-server cap), or
    /// null when the id is not connected.</summary>
    string? ServerOf(string connectionId);
    ResultStore Store { get; }
    /// <summary>What was probed at connect (version, edition), or null when the id is not connected.</summary>
    ServerProfile? Profile(string connectionId);
    /// <summary>An unopened connection from the connection's own pool under the program name plus <paramref name="suffix"/>
    /// (cleared on disconnect); throws NOT_CONNECTED for an unknown id.</summary>
    SqlConnection PoolConnection(string connectionId, string? database, string suffix);
    /// <summary>Opens it; a Kerberos or Entra sign-in failure throws AUTH_KERBEROS, AUTH_UNSUPPORTED or AUTH_ENTRA.</summary>
    Task OpenAsync(SqlConnection connection, CancellationToken token);
}

/// <summary>One probe of a subscription: its settings, its schedule and its back-off.</summary>
internal sealed class LiveProbeState(LiveProbeJson spec, int intervalMs)
{
    public LiveProbeJson Spec { get; } = spec;
    /// <summary>The interval asked for, clamped to the probe's own range.</summary>
    public int IntervalMs { get; set; } = intervalMs;
    /// <summary>The interval in force: the asked one, doubled by the load guard while the probe costs too much.</summary>
    public int EffectiveIntervalMs { get; set; } = intervalMs;
    public bool Paused { get; set; }
    public LiveSortArgs[]? Sort { get; set; }
    public string? View { get; set; }
    public LiveFilterArgs? Filter { get; set; }
    /// <summary>Track lists by table index: the latest one for each keyed snapshot table.</summary>
    public Dictionary<int, LiveTrackArgs> Tracks { get; } = [];
    /// <summary>When the probe is next due, on the service clock (ms); its last sample's time, or −1 before the first.</summary>
    public long DueAt { get; set; }
    public long LastSampleAt { get; set; } = -1;
    /// <summary>The next sample follows a pause: rates restart (gap resumed).</summary>
    public bool Resumed { get; set; }
    /// <summary>Failures in a row; the first retries at the interval, later ones back off.</summary>
    public int Failures { get; set; }
    /// <summary>The load guard's smoothed cost (EWMA, α 0.3) and how many samples in a row it has been over or under.</summary>
    public double? CostEwma { get; set; }
    public int Over { get; set; }
    public int Under { get; set; }
    /// <summary>The error that stopped the probe for good (a terminal one), until a refresh; null while it runs.</summary>
    public LiveProbeError? Stopped { get; set; }
    /// <summary>Opened unavailable (not on this server or edition, or no permission): even a refresh does not restart it.</summary>
    public bool Gated { get; set; }

    /// <summary>A statement's budget: 0.8 × the asked interval, within the probe's range.</summary>
    public int BudgetMs => Math.Clamp((int)Math.Min(int.MaxValue, 0.8 * IntervalMs), Spec.Budget.Min, Spec.Budget.Max);
}

/// <summary>A due probe as the sampler sees it: its gap marker, the slots it missed, the time since its last sample, the
/// settings an update may change (as they were when it came due: sort, track lists, view and filter), its statement budget,
/// and the interval in force.</summary>
internal sealed record LiveDue(LiveProbeState Probe, string? Gap, int? Skipped, long? ElapsedMs, LiveSortArgs[]? Sort, IReadOnlyDictionary<int, LiveTrackArgs> Tracks,
    int BudgetMs = 0, int EffectiveIntervalMs = 0, long TakenAt = 0, string? View = null, LiveFilterArgs? Filter = null);
/// <summary>One tick's samples and errors; Spid when the source opened a new session for it, and Cursors where its append
/// tables settled (the resume token follows them).</summary>
internal sealed record LiveSampleBatch(List<LiveSample> Samples, List<LiveProbeError> Errors, int? Spid = null, IReadOnlyList<LiveCursor>? Cursors = null);
/// <summary>The opened frame's facts: each probe's state, and for a SQL source its band, session and isolation.</summary>
internal sealed record LiveOpening(IReadOnlyList<LiveOpenedProbe> Probes, int? Band = null, int? Spid = null, string? Isolation = null);

/// <summary>What a source does: the probes' states when it opens, one batch per tick for the due probes, and its end.
/// debug.synthetic (SyntheticSampler) and the SQL sources (SqlSampler) implement it. A sampler is built before the registry
/// admits its subscription, which may still refuse it (BUSY, DUPLICATE_REQUEST), so its constructor acquires nothing (no
/// store session, pool or connection): OpenAsync does, once the subscription runs. Each stored revision takes its own
/// budget, so a failed one never stops later ones; the per-subscription memory cap (64 MiB, all live views within 25 % of
/// the result budget) belongs to the snapshot writers (L2b). Samplers report what happened; the subscription schedules:
/// it sets every sample's effective interval and every error's retry, and stops a probe whose error is terminal.</summary>
internal interface ILiveSampler : IDisposable
{
    /// <summary>A sampling period that replaces the probes' intervals (debug.synthetic's tickMs), or null.</summary>
    int? PeriodMs { get; }
    /// <param name="resume">Where append tables go on from (a resume token's cursors); empty for a fresh start.</param>
    Task<LiveOpening> OpenAsync(IReadOnlyList<LiveProbeState> probes, IReadOnlyList<LiveCursor> resume, CancellationToken token);
    Task<LiveSampleBatch> SampleAsync(IReadOnlyList<LiveDue> due, CancellationToken token);
    /// <summary>New args from live.update, already validated for the source.</summary>
    void Apply(object args);
    /// <summary>The source has ended (after the tick just sent): the subscription answers sourceEnded.</summary>
    bool Ended { get; }
    /// <summary>On sourceEnded: releases what is not kept and returns the results that stay readable until closed.</summary>
    uint[] Keep();
    /// <summary>On every other end: releases every result the source stored.</summary>
    void Release();
    /// <summary>Nothing is due for a while (every probe paused, or the next one far off): give back what is held between
    /// ticks, such as a pooled connection.</summary>
    void Idle() { }
}

/// <summary>A running live.subscribe: one task that samples its due probes on one schedule and sends one tick at a time.
/// The schedule is fixed rate per probe with a random phase (so many views never wake together), a quick second sample after
/// a baseline (rates within a second), exponential back-off with jitter after failures, and a load guard that doubles a
/// costly probe's interval and halves it back once it is cheap again. All of it is driven by the times passed in, so the
/// checks run it on a fake clock.</summary>
internal sealed class LiveSubscription : IDisposable
{
    /// <summary>EWMA weight of the newest cost, samples over the duty cycle before doubling, under 10 % before halving.</summary>
    private const double CostWeight = 0.3;
    private const int OverSamples = 3, UnderSamples = 10;
    private const double UnderShare = 0.1;
    /// <summary>The quick second sample's delay after a baseline or resume: rates need two samples.</summary>
    private const int QuickMs = 1000;
    private readonly CancellationTokenSource stop = new();
    private readonly CancellationTokenSource linked;
    private readonly SemaphoreSlim signal = new(0);
    private readonly Lock gate = new();
    private readonly Func<double> random;
    private readonly LiveLimitsJson limits;
    private string? endReason;
    private bool disposed;

    public LiveSubscription(string id, string connectionId, string server, LiveSourceJson source, List<LiveProbeState> probes, ILiveSampler sampler, RequestContext context,
        LiveLimitsJson limits, Func<double>? random = null, IReadOnlyList<LiveCursor>? resume = null, string? resumeToken = null)
    {
        Id = id;
        ConnectionId = connectionId;
        Server = server;
        Source = source;
        Probes = probes;
        Sampler = sampler;
        Context = context;
        this.limits = limits;
        this.random = random ?? Random.Shared.NextDouble;
        Resume = resume ?? [];
        ResumeToken = resumeToken;
        linked = CancellationTokenSource.CreateLinkedTokenSource(context.Token, stop.Token);
    }

    public string Id { get; }
    public string ConnectionId { get; }
    /// <summary>What the per-server cap counts by: the server the connection reaches, or the connection id for a source
    /// that reaches none.</summary>
    public string Server { get; }
    public LiveSourceJson Source { get; }
    public List<LiveProbeState> Probes { get; }
    public ILiveSampler Sampler { get; }
    public RequestContext Context { get; }
    /// <summary>The cursors and token the request resumed from (none for a fresh start).</summary>
    public IReadOnlyList<LiveCursor> Resume { get; }
    public string? ResumeToken { get; }
    public CancellationToken Token => linked.Token;
    /// <summary>Every probe, by the owner's visibility: no SQL while true.</summary>
    public bool Paused { get; private set; }
    public long Ticks { get; set; }
    public Lock Gate => gate;
    public string? EndReason { get { lock (gate) return endReason; } }
    /// <summary>Ending or ended; read under <see cref="Gate"/>, which Dispose also takes, so an update never touches a
    /// disposed subscription.</summary>
    public bool Ending => disposed || endReason is not null || Token.IsCancellationRequested;

    /// <summary>Ends the subscription with a reason (the first one wins): disconnected or shutdown.</summary>
    public void End(string reason)
    {
        lock (gate) endReason ??= reason;
        try { stop.Cancel(); } catch (ObjectDisposedException) { /* Ended concurrently. */ }
    }

    /// <summary>The longest a failing or costly probe waits: the back-off cap, or its asked interval when that is longer.</summary>
    public int CapOf(LiveProbeState probe) => Math.Min(limits.IntervalMs.Max, Math.Max(limits.BackoffMs, probe.IntervalMs));

    public int PeriodOf(LiveProbeState probe) => Sampler.PeriodMs ?? probe.EffectiveIntervalMs;

    /// <summary>A random start within a quarter of the subscription's first second, so views opened together never wake
    /// together. One phase for all of a subscription's probes, so probes with one interval share a tick (one round of SQL and
    /// one frame) rather than drift apart.</summary>
    private long phase;

    private long NewPhase() => phase = (long)(random() * Math.Min(Probes.Min(PeriodOf), 1000) * 0.25);

    /// <summary>The probes' states as the source opened them: an unavailable probe never runs (even a refresh leaves it).</summary>
    public void Opened(IReadOnlyList<LiveOpenedProbe> opened, long now)
    {
        lock (gate)
        {
            var start = now + NewPhase();
            foreach (var probe in Probes)
            {
                probe.DueAt = start;
                if (opened.FirstOrDefault(item => item.Probe == probe.Spec.Id) is not { State: "unavailable" } state) continue;
                probe.Gated = true;
                probe.Stopped = new(probe.Spec.Id, state.Reason ?? "NOT_SUPPORTED", state.Note ?? "This view is not available on this server.", null, 0, true);
            }
        }
    }

    public void SetPaused(bool paused, long now)
    {
        lock (gate)
        {
            if (Paused && !paused)
            {
                NewPhase();
                foreach (var probe in Probes) ResumeProbe(probe, now);
            }
            Paused = paused;
        }
    }

    /// <summary>A probe resumes at once (plus the subscription's phase), marked resumed so its rates start again.</summary>
    public void ResumeProbe(LiveProbeState probe, long now)
    {
        probe.DueAt = now + phase;
        probe.Resumed = probe.LastSampleAt >= 0;
    }

    /// <summary>A new asked interval: the load guard starts again from it, and a probe whose next slot is further away than
    /// the new interval moves up.</summary>
    public void SetInterval(LiveProbeState probe, int intervalMs)
    {
        probe.IntervalMs = probe.EffectiveIntervalMs = intervalMs;
        probe.CostEwma = null;
        probe.Over = probe.Under = 0;
        if (probe.LastSampleAt >= 0) probe.DueAt = Math.Min(probe.DueAt, probe.LastSampleAt + PeriodOf(probe));
    }

    /// <summary>Refresh now: every unpaused probe is due at once, but never within its minimum gap, nor its minimum interval,
    /// of its last attempt, so refreshes in a loop run a probe no more often than its fastest interval would. A probe that is
    /// backing off keeps its delay and its count (a refresh never hammers a failing server or sign-in); one a terminal error
    /// stopped starts again from a clean count (not one the source opened unavailable).</summary>
    public void Refresh(long now)
    {
        foreach (var probe in Probes)
        {
            if (probe.Paused || probe.Gated) continue;
            var due = probe.LastSampleAt < 0 ? now : Math.Max(now, probe.LastSampleAt + Math.Max(probe.Spec.MinGapMs, probe.Spec.IntervalMs.Min));
            if (probe.Stopped is not null)
            {
                probe.Stopped = null;
                probe.Failures = 0;
                probe.DueAt = due;
            }
            else if (probe.Failures == 0) probe.DueAt = Math.Min(probe.DueAt, due);
        }
    }

    /// <summary>Every probe stopped for good: the first one's error, which ends the subscription failed.</summary>
    public LiveProbeError? AllStopped()
    {
        lock (gate) return Probes.All(probe => probe.Stopped is not null) ? Probes[0].Stopped : null;
    }

    /// <summary>Whether the source gives back its connection before a wait of <paramref name="waitMs"/> (from WaitMs): while
    /// nothing is due until an update, when the next sample is at least idleMs away, and between the samples of probes that
    /// all run every idleMs or less often (the wait after a sample is a little under its interval), except before a quick
    /// second sample.</summary>
    public bool IdleFor(int waitMs)
    {
        if (waitMs < 0 || waitMs >= limits.IdleMs) return true;
        lock (gate)
        {
            var periods = Probes.Where(probe => !Paused && !probe.Paused && probe.Stopped is null).Select(PeriodOf).ToList();
            return periods.Count > 0 && periods.Min() >= limits.IdleMs && waitMs > QuickMs;
        }
    }

    /// <summary>How long until a probe is due: 0 when one is, −1 when none will be until an update.</summary>
    public int WaitMs(long now)
    {
        lock (gate)
        {
            long next = long.MaxValue;
            foreach (var probe in Probes) if (!Paused && !probe.Paused && probe.Stopped is null) next = Math.Min(next, probe.DueAt);
            return next == long.MaxValue ? -1 : (int)Math.Clamp(next - now, 0, int.MaxValue);
        }
    }

    /// <summary>The probes due now, each moved to its next slot. The schedule is fixed rate: slots missed while a frame
    /// was unacknowledged or a sample ran long are skipped and counted, never replayed in a burst.</summary>
    public List<LiveDue> TakeDue(long now)
    {
        lock (gate)
        {
            var due = new List<LiveDue>();
            foreach (var probe in Probes)
            {
                if (Paused || probe.Paused || probe.Stopped is not null || probe.DueAt > now) continue;
                var period = PeriodOf(probe);
                var missed = (int)Math.Min(int.MaxValue, (now - probe.DueAt) / period);
                var gap = probe.LastSampleAt < 0 ? "baseline" : probe.Resumed ? "resumed" : missed > 0 ? "late" : null;
                // The settings an update may change, as they are now: the sampler reads them outside the lock.
                // A first sample has no slots before it to miss, however long the opened frame waited for its acknowledgement.
                due.Add(new LiveDue(probe, gap, missed > 0 && probe.LastSampleAt >= 0 ? missed : null, probe.LastSampleAt < 0 ? null : now - probe.LastSampleAt, probe.Sort,
                    new Dictionary<int, LiveTrackArgs>(probe.Tracks), probe.BudgetMs, probe.EffectiveIntervalMs, now, probe.View, probe.Filter));
                probe.DueAt += (long)(missed + 1) * period;
                probe.LastSampleAt = now;
                probe.Resumed = false;
            }
            return due;
        }
    }

    /// <summary>Schedules each due probe by what its sample did, and returns the batch as the tick sends it: every sample
    /// with the interval now in force, every error with when the probe tries again. A sample clears the failures, feeds the
    /// load guard and, after a baseline or a pause, brings the next sample within a second; an error backs off (the first
    /// retries at the interval, later ones double up to the cap, ±10 %), except BUDGET, which retries at the interval as
    /// memory may free at any time; a terminal error stops the probe.</summary>
    public LiveSampleBatch Complete(IReadOnlyList<LiveDue> due, LiveSampleBatch batch, long now)
    {
        lock (gate)
        {
            var samples = new List<LiveSample>(batch.Samples.Count);
            var errors = new List<LiveProbeError>(batch.Errors.Count);
            // A probe may fail in more than one way at once (a table cut by the budget and a statement that failed): one error
            // schedules it (a terminal one when nothing was sampled), and the others go with it while the tick has room
            // (limits.live.errors), every probe's first error first.
            var extra = new List<LiveProbeError>();
            foreach (var item in due)
            {
                var probe = item.Probe;
                var sample = batch.Samples.Find(entry => entry.Probe == probe.Spec.Id);
                var all = batch.Errors.FindAll(entry => entry.Probe == probe.Spec.Id);
                var error = (sample is null ? all.Find(entry => entry.Terminal) : null) ?? (all.Count > 0 ? all[0] : null);
                if (sample is not null)
                {
                    probe.Failures = 0;
                    Guard(probe, sample.CostMs, item.TakenAt);
                    // Rates need two samples: the second comes within a second, then the probe settles on its interval. The sample
                    // says whether it has rates: a source also starts again from a baseline after a failed first attempt or a lost
                    // connection, which the schedule cannot see. A baseline has no earlier slots to have skipped.
                    if (sample.Gap is "baseline" or "resumed") probe.DueAt = Math.Min(probe.DueAt, item.TakenAt + Math.Min(PeriodOf(probe), QuickMs));
                    samples.Add(sample with { EffectiveIntervalMs = probe.EffectiveIntervalMs, Skipped = sample.Gap == "baseline" ? null : sample.Skipped });
                }
                if (error is null) continue;
                int retry;
                if (error.Terminal && sample is null)
                {
                    probe.Stopped = error with { RetryInMs = 0 };
                    retry = 0;
                }
                else if (sample is not null || error.Code == "BUDGET") retry = (int)Math.Max(0, probe.DueAt - now);
                else
                {
                    probe.Failures++;
                    retry = Retry(probe);
                    probe.DueAt = item.TakenAt + retry;
                }
                // Terminal says the probe stopped: an error beside a sample (one table a statement could not read) never does.
                var retryInMs = Math.Clamp(retry, 0, limits.IntervalMs.Max);
                var stopped = probe.Stopped is not null;
                errors.Add(error with { RetryInMs = retryInMs, Terminal = error.Terminal && stopped });
                extra.AddRange(all.Where(other => !ReferenceEquals(other, error)).Select(other => other with { RetryInMs = retryInMs, Terminal = other.Terminal && stopped }));
            }
            errors.AddRange(extra.Take(Math.Max(0, limits.Errors - errors.Count)));
            // A sampler reports only probes it was given; anything else it sent is dropped rather than sent.
            return new(samples, errors, batch.Spid, batch.Cursors);
        }
    }

    /// <summary>The first failure retries at the interval; then min(interval × 2^(f−1), cap) × U(0.9, 1.1).</summary>
    private int Retry(LiveProbeState probe)
    {
        var period = PeriodOf(probe);
        if (probe.Failures <= 1) return period;
        var delay = Math.Min(period * Math.Pow(2, Math.Min(probe.Failures - 1, 30)), Math.Max(CapOf(probe), period));
        return (int)Math.Max(1, delay * (0.9 + 0.2 * random()));
    }

    /// <summary>The load guard: a probe whose smoothed cost passes its duty cycle of the interval in force for 3 samples in a
    /// row doubles that interval (up to the cap); one under 10 % for 10 samples halves it back toward the asked interval.
    /// Only the SQL sources' costs count (a test period has none to guard).</summary>
    private void Guard(LiveProbeState probe, int costMs, long takenAt)
    {
        if (Sampler.PeriodMs is not null) return;
        probe.CostEwma = probe.CostEwma is { } ewma ? CostWeight * costMs + (1 - CostWeight) * ewma : costMs;
        var effective = probe.EffectiveIntervalMs;
        if (probe.CostEwma > probe.Spec.MaxDutyCycle * effective) { probe.Over++; probe.Under = 0; }
        else if (probe.CostEwma < UnderShare * effective) { probe.Under = Math.Min(probe.Under + 1, UnderSamples); probe.Over = 0; }
        else probe.Over = probe.Under = 0;
        var next = probe.Over >= OverSamples ? Math.Min(effective * 2, CapOf(probe))
            : probe.Under >= UnderSamples && effective > probe.IntervalMs ? Math.Max(effective / 2, probe.IntervalMs) : effective;
        if (next == effective) return;
        probe.EffectiveIntervalMs = next;
        probe.Over = probe.Under = 0;
        probe.DueAt = takenAt + next;
    }

    /// <summary>Wakes the loop: an update changed the schedule.</summary>
    public void Signal() => signal.Release();

    public Task WaitAsync(int waitMs, CancellationToken token) => signal.WaitAsync(waitMs, token);

    public void Dispose()
    {
        lock (gate) disposed = true;
        linked.Dispose();
        stop.Dispose();
        signal.Dispose();
        Sampler.Dispose();
    }
}

/// <summary>live.subscribe and live.update (docs/ipc.md, Live subscriptions). A registry by subscription id: at most 32
/// in the backend and 8 per SQL Server, counted by the server a connection reaches (BUSY), a duplicate id refused
/// (DUPLICATE_REQUEST) before its sampler is built; a disconnect ends that connection's subscriptions (disconnected) and a
/// shutdown all of them. Every request is validated against the catalogue as main's schemas validate it. SQL sources run
/// their statements under the live gates, which unary methods on lane live share (RunGatedAsync). Nothing is logged.</summary>
internal sealed partial class LiveService(ILiveHost host, LiveCatalog? catalog = null) : IDisposable
{
    /// <summary>Settings an update may drop (LiveProbeArgs.Clear).</summary>
    private static readonly string[] Clearable = ["sort", "view", "filter"];
    private readonly ConcurrentDictionary<string, LiveSubscription> running = new(StringComparer.Ordinal);
    private readonly Lock registration = new();
    private readonly LiveCatalog catalog = Shared(host, catalog ?? LiveCatalog.Current);
    private static readonly Stopwatch Clock = Stopwatch.StartNew();
    private static long Now => Clock.ElapsedMilliseconds;

    public int Count => running.Count;
    private LiveLimitsJson Limits => catalog.Limits;
    /// <summary>Live statements at once: per connection id and in the backend.</summary>
    public LiveGates Gates { get; } = new((catalog ?? LiveCatalog.Current).Limits.StatementsPerConnection, (catalog ?? LiveCatalog.Current).Limits.Statements, host.IsConnected);
    /// <summary>The schedule's randomness (phases and retry jitter); the checks fix it.</summary>
    internal Func<double> Random { get; set; } = System.Random.Shared.NextDouble;
    /// <summary>Rewrites a SQL probe's command text (probe id, text → text), so the live checks can make a probe wait on a lock
    /// they hold. Only the checks set it; it is never reachable from a request.</summary>
    internal Func<string, string, string>? TestText { get; set; }
    /// <summary>Probes the live checks register (their queries, database, isolation and start); only the checks set it, with
    /// their own catalogue, and it is never reachable from a request.</summary>
    internal LiveTestSql? TestSql { get; set; }
    /// <summary>The store the live tables write to (the checks read revisions from it).</summary>
    internal ResultStore Store => host.Store;

    // \A and \z: .NET's $ also matches before a final newline, which main's pattern refuses.
    [GeneratedRegex(@"\A[A-Za-z0-9_-]+\z")]
    private static partial Regex ResumePattern();

    /// <summary>A resume token's characters (base64url), as main's resumeToken schema checks them.</summary>
    internal static bool IsResumeToken(string value) => ResumePattern().IsMatch(value);

    private static RequestException Invalid(string message) => new("INVALID_PARAMS", message);

    /// <summary>Gives live tables their share of the host's result budget (limits.live.budgetShare).</summary>
    private static LiveCatalog Shared(ILiveHost host, LiveCatalog catalog)
    {
        host.Store.ShareWithLive(catalog.Limits.BudgetShare);
        return catalog;
    }

    public async Task<LiveEnd> SubscribeAsync(LiveSubscribeArgs args, RequestContext? context, JsonSerializerOptions json)
    {
        if (context is not { IsStream: true }) throw Invalid("A live subscription is a stream: it needs credit.");
        if (!IsUuid(args.SubscriptionId) || !IsUuid(args.ConnectionId)) throw Invalid("A live subscription needs a subscription id and a connection id.");
        var source = SourceOf(args.Source);
        if (args.Probes is not { Length: >= 1 } || args.Probes.Length > Limits.Probes) throw Invalid("A live subscription names 1 to 8 probes.");
        var probes = new List<LiveProbeState>();
        foreach (var settings in args.Probes)
        {
            var spec = ProbeOf(source, settings.Probe);
            if (probes.Any(probe => probe.Spec.Id == spec.Id)) throw Invalid("Each probe may be named once.");
            if (settings.IntervalMs is not { } interval) throw Invalid("Each probe needs an interval.");
            var state = new LiveProbeState(spec, Clamp(spec, interval));
            Apply(state, settings);
            probes.Add(state);
        }
        var sourceArgs = ArgsOf(source, args.Args, json);
        IReadOnlyList<LiveCursor> cursors = [];
        if (args.Resume is { } resume)
        {
            if (resume.Length is 0 || resume.Length > Limits.ResumeCharacters || !IsResumeToken(resume)) throw Invalid("Invalid resume token.");
            // Only append tables have cursors to resume from.
            if (!probes.Any(probe => probe.Spec.Tables.Any(table => table.Mode == "append"))) throw Invalid("This live source cannot resume.");
            cursors = LiveResume.Parse(resume, source.Id, [.. probes.Select(probe => probe.Spec)], Limits.ResumeCharacters);
        }
        if (source.Scope != "none" && !host.IsConnected(args.ConnectionId)) throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");
        var server = host.ServerOf(args.ConnectionId) ?? args.ConnectionId;
        // Refused before the sampler exists, so a refusal touches nothing the running subscriptions hold.
        lock (registration) Admit(args.SubscriptionId, server);
        var subscription = new LiveSubscription(args.SubscriptionId, args.ConnectionId, server, source, probes, CreateSampler(source, sourceArgs, args.SubscriptionId, args.ConnectionId), context,
            Limits, Random, cursors, args.Resume);
        try
        {
            Register(subscription);
        }
        catch
        {
            subscription.Dispose();
            throw;
        }
        try { return await RunAsync(subscription).ConfigureAwait(false); }
        finally
        {
            ((ICollection<KeyValuePair<string, LiveSubscription>>)running).Remove(new(subscription.Id, subscription));
            subscription.Dispose();
        }
    }

    public LiveUpdateResult Update(LiveUpdateArgs args, JsonSerializerOptions json)
    {
        if (!IsUuid(args.SubscriptionId)) throw Invalid("A live update needs a subscription id.");
        var source = SourceOf(args.Source);
        if (!running.TryGetValue(args.SubscriptionId, out var subscription)) throw new RequestException("NOT_FOUND", "This live view has ended.");
        if (subscription.Source.Id != source.Id) throw Invalid("The update names another source.");
        if (args.Paused is null && args.Probes is null && args.Refresh is null && args.Track is null && args.Args is null) throw Invalid("The update changes nothing.");
        if (args.Refresh is false) throw Invalid("Refresh is true or absent.");
        if (args.Probes is { } patches && (patches.Length is 0 || patches.Length > Limits.Probes || patches.Select(patch => patch.Probe).Distinct(StringComparer.Ordinal).Count() != patches.Length))
            throw Invalid("An update names each of up to 8 probes once.");
        var states = (args.Probes ?? []).Select(patch => (Patch: patch, State: subscription.Probes.Find(probe => probe.Spec.Id == patch.Probe)
            ?? throw Invalid("The probe is not part of this subscription."))).ToList();
        foreach (var (patch, state) in states)
        {
            if (patch.IntervalMs is { } interval) Clamp(state.Spec, interval);
            Validate(state.Spec, patch);
            if (patch.Clear is { } clear && (clear.Length is 0 || clear.Length > Clearable.Length || clear.Any(setting => !Clearable.Contains(setting, StringComparer.Ordinal))
                || clear.Distinct(StringComparer.Ordinal).Count() != clear.Length
                || clear.Contains("sort") && patch.Sort is not null || clear.Contains("view") && patch.View is not null || clear.Contains("filter") && patch.Filter is not null))
                throw Invalid("Clear names sort, view or filter once each, and none the update also sets.");
        }
        if (args.Track is { } tracks)
        {
            if (tracks.Length is 0 || tracks.Length > Limits.Probes || tracks.Select(track => track.Probe + "/" + track.Table).Distinct(StringComparer.Ordinal).Count() != tracks.Length)
                throw Invalid("An update tracks each of up to 8 tables once.");
            foreach (var track in tracks)
            {
                var state = subscription.Probes.Find(probe => probe.Spec.Id == track.Probe) ?? throw Invalid("The probe is not part of this subscription.");
                if (track.Table < 0 || track.Table >= state.Spec.Tables.Count || state.Spec.Tables[track.Table] is not { Mode: "snapshot", Key.Count: > 0 })
                    throw Invalid("Only keyed snapshot tables are tracked.");
                if (track.Seq < 1 || track.Keys is null || track.Keys.Length > Limits.TrackedKeys || track.Keys.Any(key => key is null || key.Length > Limits.KeyCharacters))
                    throw Invalid("A track list has up to 64 keys of up to 512 characters.");
                if (track.Linger is { } linger && (linger < 0 || linger > track.Keys.Length)) throw Invalid("A track list lingers at most its own keys.");
            }
        }
        var sourceArgs = args.Args is null ? null : ArgsOf(source, args.Args, json);
        lock (subscription.Gate)
        {
            if (subscription.Ending) throw new RequestException("CANCELLED", "This live view is ending.");
            var now = Now;
            foreach (var (patch, state) in states)
            {
                if (patch.IntervalMs is { } interval) subscription.SetInterval(state, Clamp(state.Spec, interval));
                if (patch.Paused is { } paused)
                {
                    if (state.Paused && !paused) subscription.ResumeProbe(state, now);
                    state.Paused = paused;
                }
                if (patch.Sort is not null) state.Sort = patch.Sort;
                if (patch.View is not null) state.View = patch.View;
                if (patch.Filter is not null) state.Filter = patch.Filter;
                foreach (var setting in patch.Clear ?? [])
                {
                    if (setting == "sort") state.Sort = null;
                    else if (setting == "view") state.View = null;
                    else state.Filter = null;
                }
            }
            foreach (var track in args.Track ?? []) subscription.Probes.Find(probe => probe.Spec.Id == track.Probe)!.Tracks[track.Table] = track;
            if (sourceArgs is not null) subscription.Sampler.Apply(sourceArgs);
            if (args.Paused is { } all) subscription.SetPaused(all, now);
            if (args.Refresh is true) subscription.Refresh(now);
            subscription.Signal();
            return new LiveUpdateResult(true, [.. subscription.Probes.Select(probe => new LiveProbeApplied(probe.Spec.Id, probe.IntervalMs, probe.EffectiveIntervalMs, subscription.Paused || probe.Paused))]);
        }
    }

    /// <summary>A disconnect: that connection's subscriptions end with disconnected.</summary>
    public void Forget(string connectionId)
    {
        foreach (var subscription in running.Values.Where(subscription => subscription.ConnectionId == connectionId)) subscription.End("disconnected");
        Gates.Forget(connectionId);
    }

    /// <summary>A unary method on lane live (it takes no protocol slot): its SQL runs under the live gates, waiting at most
    /// <paramref name="waitMs"/> for one, else BUSY; an id that is not connected is NOT_CONNECTED, and gets no gate.</summary>
    public async Task<T> RunGatedAsync<T>(string connectionId, int waitMs, Func<CancellationToken, Task<T>> work, CancellationToken token)
    {
        using var lease = await Gates.WaitAsync(connectionId, waitMs, token).ConfigureAwait(false)
            ?? throw new RequestException("BUSY", "Too many live views are reading this server at once. Retry in a moment.");
        return await work(token).ConfigureAwait(false);
    }

    /// <summary>Shutdown: every subscription ends with shutdown.</summary>
    public void CancelAll()
    {
        foreach (var subscription in running.Values) subscription.End("shutdown");
    }

    public void Dispose() => CancelAll();

    /// <summary>Under <see cref="registration"/>: refuses a duplicate id, then a full backend or server.</summary>
    private void Admit(string id, string server)
    {
        if (running.ContainsKey(id)) throw new RequestException("DUPLICATE_REQUEST", "This live view is already open.");
        if (running.Count >= Limits.BackendSubscriptions || running.Values.Count(other => other.Server == server) >= Limits.PerServer)
            throw new RequestException("BUSY", "Too many live views are open for this server. Close one and retry.");
    }

    /// <summary>Admits again, since another subscription may have registered while the sampler was built, and adds it.</summary>
    private void Register(LiveSubscription subscription)
    {
        lock (registration)
        {
            Admit(subscription.Id, subscription.Server);
            running[subscription.Id] = subscription;
        }
    }

    private async Task<LiveEnd> RunAsync(LiveSubscription subscription)
    {
        var started = Now;
        var context = subscription.Context;
        var token = subscription.Token;
        var kept = false;
        long seq = 0, sampledAt = 0;
        var resume = subscription.ResumeToken;
        LiveEnd End(string ended, string? code = null, string? message = null, uint[]? keep = null) => new(ended, code, message, keep, resume, subscription.Ticks, Now - started);
        try
        {
            var opening = await subscription.Sampler.OpenAsync(subscription.Probes, subscription.Resume, token).ConfigureAwait(false);
            subscription.Opened(opening.Probes, Now);
            if (!context.TrySendCreditedEvent(new LiveOpenedEvent("live.opened", 0, subscription.Source.Id, opening.Band, opening.Spid, opening.Isolation, opening.Probes)))
                throw new InvalidOperationException("The first live frame could not be sent.");
            while (true)
            {
                token.ThrowIfCancellationRequested();
                // Every probe stopped for good (no permission, not on this server): nothing will ever be sampled.
                if (subscription.AllStopped() is { } stopped) return End("failed", stopped.Code, stopped.Message);
                var waitMs = subscription.WaitMs(Now);
                if (waitMs != 0)
                {
                    // Nothing due for a while: the connection goes back to the pool rather than sit idle on the server.
                    if (subscription.IdleFor(waitMs)) subscription.Sampler.Idle();
                    await subscription.WaitAsync(waitMs, token).ConfigureAwait(false);
                    continue;
                }
                // Never sample while the renderer has not applied the previous frame.
                await context.WaitForAckAsync(token).ConfigureAwait(false);
                var due = subscription.TakeDue(Now);
                if (due.Count == 0) continue;
                var batch = subscription.Complete(due, await subscription.Sampler.SampleAsync(due, token).ConfigureAwait(false), Now);
                if (batch.Samples.Count == 0 && batch.Errors.Count == 0) continue;
                sampledAt = Math.Max(sampledAt + 1, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                // A token only when an append table's cursor moved and it fits: the renderer keeps the last one it saw.
                string? moved = null;
                if (batch.Cursors is { Count: > 0 } cursors && LiveResume.Encode(subscription.Source.Id, cursors, Limits.ResumeCharacters) is { } next && next != resume) resume = moved = next;
                var tick = new LiveTickEvent("live.tick", ++seq, sampledAt, batch.Spid, moved, batch.Samples, batch.Errors.Count == 0 ? null : batch.Errors);
                if (!context.TrySendCreditedEvent(tick)) throw new InvalidOperationException("A live frame was sent while another was outstanding.");
                subscription.Ticks++;
                if (subscription.Sampler.Ended)
                {
                    kept = true;
                    return End("sourceEnded", keep: subscription.Sampler.Keep());
                }
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return End(subscription.EndReason ?? (context.Reason == CancelReason.Shutdown ? "shutdown" : "cancelled"));
        }
        catch (RequestException error) when (error.Code == "BACKEND_ERROR")
        {
            return End("failed", error.Code, error.Message);
        }
        catch (RequestException error) when (error.Code == "NOT_CONNECTED")
        {
            // The connection id went away while the source reached for it (a disconnect racing Forget): Forget's end.
            return End(subscription.EndReason ?? "disconnected");
        }
        finally
        {
            if (!kept) subscription.Sampler.Release();
        }
    }

    /// <summary>Replaces the sampler a source would get, so the checks can drive a frame the shipped sources never send (an
    /// oversized one). Only the checks set it; it is never reachable from a request.</summary>
    internal Func<LiveSourceJson, ILiveSampler?>? TestSampler { get; set; }

    private ILiveSampler CreateSampler(LiveSourceJson source, object? args, string subscriptionId, string connectionId) => TestSampler?.Invoke(source) ?? source.Id switch
    {
        SyntheticSampler.Source => new SyntheticSampler(host.Store, subscriptionId, (SyntheticLiveArgs?)args ?? new SyntheticLiveArgs(), Limits),
        _ when source.Scope == "server" => new SqlSampler(host, Gates, subscriptionId, connectionId, source, Limits, TestText, TestSql),
        _ => throw Invalid("Unknown live source.")
    };

    private LiveSourceJson SourceOf(string? id)
    {
        if (id is null || !catalog.Sources.TryGetValue(id, out var source) || source.TestOnly && !host.TestHooks) throw Invalid("Unknown live source.");
        return source;
    }

    private LiveProbeJson ProbeOf(LiveSourceJson source, string? id)
    {
        if (id is null || !catalog.Probes.TryGetValue(id, out var spec) || spec.Source != source.Id) throw Invalid("The probe is not one of this source's.");
        return spec;
    }

    private int Clamp(LiveProbeJson spec, int interval)
    {
        if (interval < Limits.IntervalMs.Min || interval > Limits.IntervalMs.Max) throw Invalid("A probe's interval is 1,000 to 3,600,000 ms.");
        return Math.Clamp(interval, spec.IntervalMs.Min, spec.IntervalMs.Max);
    }

    private void Apply(LiveProbeState state, LiveProbeArgs settings)
    {
        Validate(state.Spec, settings);
        if (settings.Clear is not null) throw Invalid("Only an update clears settings.");
        state.Paused = settings.Paused ?? false;
        state.Sort = settings.Sort;
        state.View = settings.View;
        state.Filter = settings.Filter;
    }

    /// <summary>Sort by the probe's snapshot columns, a view it declares, a filter only where it has a filter mode.</summary>
    private void Validate(LiveProbeJson spec, LiveProbeArgs settings)
    {
        if (settings.Sort is { } sort)
        {
            // A row's tone column is never data: no sort or filter names it.
            var sortable = spec.Tables.Where(table => table.Mode == "snapshot").SelectMany(table => table.Columns).Where(LiveColumnJson.IsData).Select(column => column.Id).ToHashSet(StringComparer.Ordinal);
            bool Sorts(LiveSortArgs key) => key.Table is not { } table ? sortable.Contains(key.Column)
                : table >= 0 && table < spec.Tables.Count && spec.Tables[table].Mode == "snapshot" && spec.Tables[table].Columns.Exists(column => column.Id == key.Column && LiveColumnJson.IsData(column));
            if (sort.Length is 0 || sort.Length > Limits.SortColumns || sort.Any(key => key?.Column is null || !Sorts(key))
                || sort.Select(key => key.Table + "/" + key.Column).Distinct(StringComparer.Ordinal).Count() != sort.Length)
                throw Invalid("Sort names a column the probe does not sort by.");
        }
        if (settings.View is { } view && !spec.Views.Contains(view, StringComparer.Ordinal)) throw Invalid("Unknown view.");
        if (settings.Filter is { } filter)
        {
            var columns = spec.Tables.SelectMany(table => table.Columns).Where(LiveColumnJson.IsData).Select(column => column.Id).ToHashSet(StringComparer.Ordinal);
            if (spec.FilterMode == "none" || filter.Text is not { Length: >= 1 } text || text.Length > Limits.FilterCharacters
                || filter.Columns is { } named && (named.Length is 0 || named.Length > Limits.FilterColumns || named.Any(column => column is null || !columns.Contains(column))))
                throw Invalid("The probe does not take this filter.");
        }
    }

    /// <summary>The source's own args, read strictly (unknown members refused) and bounded.</summary>
    private object? ArgsOf(LiveSourceJson source, JsonElement? args, JsonSerializerOptions json)
    {
        var maxTail = Limits.SegmentRows;
        if (args is not { } element) return null;
        if (element.ValueKind != JsonValueKind.Object) throw Invalid("Invalid arguments for this source.");
        try
        {
            return source.Id switch
            {
                SyntheticSampler.Source => SyntheticSampler.Check(element.Deserialize<SyntheticLiveArgs>(json) ?? throw Invalid("Invalid arguments for this source."), maxTail),
                _ => throw Invalid("This source takes no arguments.")
            };
        }
        catch (JsonException) { throw Invalid("Invalid arguments for this source."); }
    }

    private static bool IsUuid(string? value) => value is { Length: 36 } && Guid.TryParseExact(value, "D", out _);
}
