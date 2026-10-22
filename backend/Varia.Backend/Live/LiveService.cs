using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Live;

/// <summary>What the live service needs from SqlService.</summary>
internal interface ILiveHost
{
    /// <summary>VARIA_BACKEND_TEST_HOOKS=1: test-only sources (debug.synthetic) are accepted.</summary>
    bool TestHooks { get; }
    bool IsConnected(string connectionId);
    ResultStore Store { get; }
}

/// <summary>One probe of a subscription: its settings and its schedule.</summary>
internal sealed class LiveProbeState(LiveProbeJson spec, int intervalMs)
{
    public LiveProbeJson Spec { get; } = spec;
    public int IntervalMs { get; set; } = intervalMs;
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
}

/// <summary>A due probe as the sampler sees it: its gap marker, the slots it missed, and the time since its last sample.</summary>
internal sealed record LiveDue(LiveProbeState Probe, string? Gap, int? Skipped, long? ElapsedMs, LiveSortArgs[]? Sort, IReadOnlyDictionary<int, LiveTrackArgs> Tracks);
internal sealed record LiveSampleBatch(List<LiveSample> Samples, List<LiveProbeError> Errors);

/// <summary>What a source does: the probes' states when it opens, one batch per tick for the due probes, and its end.
/// debug.synthetic implements it here; the SQL sources' scheduler and pools implement it in later PRs.</summary>
internal interface ILiveSampler : IDisposable
{
    /// <summary>A sampling period that replaces the probes' intervals (debug.synthetic's tickMs), or null.</summary>
    int? PeriodMs { get; }
    IReadOnlyList<LiveOpenedProbe> Open(IReadOnlyList<LiveProbeState> probes);
    Task<LiveSampleBatch> SampleAsync(IReadOnlyList<LiveDue> due, CancellationToken token);
    /// <summary>New args from live.update, already validated for the source.</summary>
    void Apply(object args);
    /// <summary>The source has ended (after the tick just sent): the subscription answers sourceEnded.</summary>
    bool Ended { get; }
    /// <summary>On sourceEnded: releases what is not kept and returns the results that stay readable until closed.</summary>
    uint[] Keep();
    /// <summary>On every other end: releases every result the source stored.</summary>
    void Release();
}

/// <summary>A running live.subscribe: one task that samples its due probes on one schedule and sends one tick at a time.</summary>
internal sealed class LiveSubscription : IDisposable
{
    private readonly CancellationTokenSource stop = new();
    private readonly CancellationTokenSource linked;
    private readonly SemaphoreSlim signal = new(0);
    private readonly Lock gate = new();
    private string? endReason;
    private bool disposed;

    public LiveSubscription(string id, string connectionId, LiveSourceJson source, List<LiveProbeState> probes, ILiveSampler sampler, RequestContext context)
    {
        Id = id;
        ConnectionId = connectionId;
        Source = source;
        Probes = probes;
        Sampler = sampler;
        Context = context;
        linked = CancellationTokenSource.CreateLinkedTokenSource(context.Token, stop.Token);
    }

    public string Id { get; }
    public string ConnectionId { get; }
    public LiveSourceJson Source { get; }
    public List<LiveProbeState> Probes { get; }
    public ILiveSampler Sampler { get; }
    public RequestContext Context { get; }
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

    public void SetPaused(bool paused, long now)
    {
        if (Paused && !paused) foreach (var probe in Probes) Resume(probe, now);
        Paused = paused;
    }

    public static void Resume(LiveProbeState probe, long now)
    {
        probe.DueAt = now;
        probe.Resumed = probe.LastSampleAt >= 0;
    }

    public int PeriodOf(LiveProbeState probe) => Sampler.PeriodMs ?? probe.IntervalMs;

    /// <summary>How long until a probe is due: 0 when one is, −1 when none will be until an update.</summary>
    public int WaitMs(long now)
    {
        lock (gate)
        {
            long next = long.MaxValue;
            foreach (var probe in Probes) if (!Paused && !probe.Paused) next = Math.Min(next, probe.DueAt);
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
                if (Paused || probe.Paused || probe.DueAt > now) continue;
                var period = PeriodOf(probe);
                var missed = (int)Math.Min(int.MaxValue, (now - probe.DueAt) / period);
                var gap = probe.LastSampleAt < 0 ? "baseline" : probe.Resumed ? "resumed" : missed > 0 ? "late" : null;
                // The settings an update may change, as they are now: the sampler reads them outside the lock.
                due.Add(new LiveDue(probe, gap, missed > 0 ? missed : null, probe.LastSampleAt < 0 ? null : now - probe.LastSampleAt, probe.Sort, new Dictionary<int, LiveTrackArgs>(probe.Tracks)));
                probe.DueAt += (long)(missed + 1) * period;
                probe.LastSampleAt = now;
                probe.Resumed = false;
            }
            return due;
        }
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
/// in the backend and 8 per connection (BUSY), a duplicate id refused (DUPLICATE_REQUEST); a disconnect ends that
/// connection's subscriptions (disconnected) and a shutdown all of them. Every request is validated against the
/// catalogue as main's schemas validate it. Nothing is logged.</summary>
internal sealed partial class LiveService(ILiveHost host) : IDisposable
{
    private readonly ConcurrentDictionary<string, LiveSubscription> running = new(StringComparer.Ordinal);
    private readonly Lock registration = new();
    private static readonly Stopwatch Clock = Stopwatch.StartNew();
    private static long Now => Clock.ElapsedMilliseconds;

    public int Count => running.Count;
    private static LiveLimitsJson Limits => LiveCatalog.Current.Limits;

    [GeneratedRegex("^[A-Za-z0-9_-]+$")]
    private static partial Regex ResumePattern();

    private static RequestException Invalid(string message) => new("INVALID_PARAMS", message);

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
        if (args.Resume is { } resume)
        {
            if (resume.Length is 0 || resume.Length > Limits.ResumeCharacters || !ResumePattern().IsMatch(resume)) throw Invalid("Invalid resume token.");
            // Only append tables have cursors to resume from.
            if (!probes.Any(probe => probe.Spec.Tables.Any(table => table.Mode == "append"))) throw Invalid("This live source cannot resume.");
        }
        if (source.Scope != "none" && !host.IsConnected(args.ConnectionId)) throw new RequestException("NOT_CONNECTED", "Connect to a SQL Server first.");
        var subscription = new LiveSubscription(args.SubscriptionId, args.ConnectionId, source, probes, CreateSampler(source, sourceArgs, args.SubscriptionId), context);
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
            }
        }
        var sourceArgs = args.Args is null ? null : ArgsOf(source, args.Args, json);
        lock (subscription.Gate)
        {
            if (subscription.Ending) throw new RequestException("CANCELLED", "This live view is ending.");
            var now = Now;
            foreach (var (patch, state) in states)
            {
                if (patch.IntervalMs is { } interval) state.IntervalMs = Clamp(state.Spec, interval);
                if (patch.Paused is { } paused)
                {
                    if (state.Paused && !paused) LiveSubscription.Resume(state, now);
                    state.Paused = paused;
                }
                if (patch.Sort is not null) state.Sort = patch.Sort;
                if (patch.View is not null) state.View = patch.View;
                if (patch.Filter is not null) state.Filter = patch.Filter;
            }
            foreach (var track in args.Track ?? []) subscription.Probes.Find(probe => probe.Spec.Id == track.Probe)!.Tracks[track.Table] = track;
            if (sourceArgs is not null) subscription.Sampler.Apply(sourceArgs);
            if (args.Paused is { } all) subscription.SetPaused(all, now);
            // Refresh: every unpaused probe is due now.
            if (args.Refresh is true) foreach (var probe in subscription.Probes) if (!probe.Paused) probe.DueAt = Math.Min(probe.DueAt, now);
            subscription.Signal();
            return new LiveUpdateResult(true, [.. subscription.Probes.Select(probe => new LiveProbeApplied(probe.Spec.Id, probe.IntervalMs, probe.IntervalMs, subscription.Paused || probe.Paused))]);
        }
    }

    /// <summary>A disconnect: that connection's subscriptions end with disconnected.</summary>
    public void Forget(string connectionId)
    {
        foreach (var subscription in running.Values.Where(subscription => subscription.ConnectionId == connectionId)) subscription.End("disconnected");
    }

    /// <summary>Shutdown: every subscription ends with shutdown.</summary>
    public void CancelAll()
    {
        foreach (var subscription in running.Values) subscription.End("shutdown");
    }

    public void Dispose() => CancelAll();

    private void Register(LiveSubscription subscription)
    {
        lock (registration)
        {
            if (running.Count >= Limits.BackendSubscriptions || running.Values.Count(other => other.ConnectionId == subscription.ConnectionId) >= Limits.PerConnection)
                throw new RequestException("BUSY", "Too many live views are open for this server. Close one and retry.");
            if (!running.TryAdd(subscription.Id, subscription)) throw new RequestException("DUPLICATE_REQUEST", "This live view is already open.");
        }
    }

    private async Task<LiveEnd> RunAsync(LiveSubscription subscription)
    {
        var started = Now;
        var context = subscription.Context;
        var token = subscription.Token;
        var kept = false;
        long seq = 0, sampledAt = 0;
        LiveEnd End(string ended, string? code = null, string? message = null, uint[]? keep = null) => new(ended, code, message, keep, null, subscription.Ticks, Now - started);
        try
        {
            var now = Now;
            foreach (var probe in subscription.Probes) probe.DueAt = now;
            if (!context.TrySendCreditedEvent(new LiveOpenedEvent("live.opened", 0, subscription.Source.Id, null, null, null, subscription.Sampler.Open(subscription.Probes))))
                throw new InvalidOperationException("The first live frame could not be sent.");
            while (true)
            {
                token.ThrowIfCancellationRequested();
                var waitMs = subscription.WaitMs(Now);
                if (waitMs != 0)
                {
                    await subscription.WaitAsync(waitMs, token).ConfigureAwait(false);
                    continue;
                }
                // Never sample while the renderer has not applied the previous frame.
                await context.WaitForAckAsync(token).ConfigureAwait(false);
                var due = subscription.TakeDue(Now);
                if (due.Count == 0) continue;
                var batch = await subscription.Sampler.SampleAsync(due, token).ConfigureAwait(false);
                if (batch.Samples.Count == 0 && batch.Errors.Count == 0) continue;
                sampledAt = Math.Max(sampledAt + 1, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                var tick = new LiveTickEvent("live.tick", ++seq, sampledAt, null, null, batch.Samples, batch.Errors.Count == 0 ? null : batch.Errors);
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
        finally
        {
            if (!kept) subscription.Sampler.Release();
        }
    }

    /// <summary>Replaces the sampler a source would get, so the checks can drive a frame the shipped sources never send (an
    /// oversized one). Only the checks set it; it is never reachable from a request.</summary>
    internal Func<LiveSourceJson, ILiveSampler?>? TestSampler { get; set; }

    private ILiveSampler CreateSampler(LiveSourceJson source, object? args, string subscriptionId) => TestSampler?.Invoke(source) ?? source.Id switch
    {
        SyntheticSampler.Source => new SyntheticSampler(host.Store, subscriptionId, (SyntheticLiveArgs?)args ?? new SyntheticLiveArgs()),
        _ => throw Invalid("Unknown live source.")
    };

    private LiveSourceJson SourceOf(string? id)
    {
        if (id is null || !LiveCatalog.Current.Sources.TryGetValue(id, out var source) || source.TestOnly && !host.TestHooks) throw Invalid("Unknown live source.");
        return source;
    }

    private static LiveProbeJson ProbeOf(LiveSourceJson source, string? id)
    {
        if (id is null || !LiveCatalog.Current.Probes.TryGetValue(id, out var spec) || spec.Source != source.Id) throw Invalid("The probe is not one of this source's.");
        return spec;
    }

    private static int Clamp(LiveProbeJson spec, int interval)
    {
        if (interval < Limits.IntervalMs.Min || interval > Limits.IntervalMs.Max) throw Invalid("A probe's interval is 1,000 to 3,600,000 ms.");
        return Math.Clamp(interval, spec.IntervalMs.Min, spec.IntervalMs.Max);
    }

    private static void Apply(LiveProbeState state, LiveProbeArgs settings)
    {
        Validate(state.Spec, settings);
        state.Paused = settings.Paused ?? false;
        state.Sort = settings.Sort;
        state.View = settings.View;
        state.Filter = settings.Filter;
    }

    /// <summary>Sort by the probe's snapshot columns, a view it declares, a filter only where it has a filter mode.</summary>
    private static void Validate(LiveProbeJson spec, LiveProbeArgs settings)
    {
        if (settings.Sort is { } sort)
        {
            var sortable = spec.Tables.Where(table => table.Mode == "snapshot").SelectMany(table => table.Columns).Select(column => column.Id).ToHashSet(StringComparer.Ordinal);
            if (sort.Length is 0 || sort.Length > Limits.SortColumns || sort.Any(key => key?.Column is null || !sortable.Contains(key.Column))
                || sort.Select(key => key.Column).Distinct(StringComparer.Ordinal).Count() != sort.Length)
                throw Invalid("Sort names a column the probe does not sort by.");
        }
        if (settings.View is { } view && !spec.Views.Contains(view, StringComparer.Ordinal)) throw Invalid("Unknown view.");
        if (settings.Filter is { } filter)
        {
            var columns = spec.Tables.SelectMany(table => table.Columns).Select(column => column.Id).ToHashSet(StringComparer.Ordinal);
            if (spec.FilterMode == "none" || filter.Text is not { Length: >= 1 } text || text.Length > Limits.FilterCharacters
                || filter.Columns is { } named && (named.Length is 0 || named.Length > Limits.FilterColumns || named.Any(column => column is null || !columns.Contains(column))))
                throw Invalid("The probe does not take this filter.");
        }
    }

    /// <summary>The source's own args, read strictly (unknown members refused) and bounded.</summary>
    private static object? ArgsOf(LiveSourceJson source, JsonElement? args, JsonSerializerOptions json)
    {
        if (args is not { } element) return null;
        if (element.ValueKind != JsonValueKind.Object) throw Invalid("Invalid arguments for this source.");
        try
        {
            return source.Id switch
            {
                SyntheticSampler.Source => SyntheticSampler.Check(element.Deserialize<SyntheticLiveArgs>(json) ?? throw Invalid("Invalid arguments for this source.")),
                _ => throw Invalid("This source takes no arguments.")
            };
        }
        catch (JsonException) { throw Invalid("Invalid arguments for this source."); }
    }

    private static bool IsUuid(string? value) => value is { Length: 36 } && Guid.TryParseExact(value, "D", out _);
}
