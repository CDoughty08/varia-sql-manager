using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using Google;

namespace Varia.Backend.BigQuery;

/// <summary>The REST methods the metadata calls name to the limiter: BigQuery's per-user rate limits count each method apart.</summary>
internal static class BqMethod
{
    public const string ProjectsList = "projects.list";
    public const string DatasetsList = "datasets.list";
    public const string DatasetsGet = "datasets.get";
    public const string TablesList = "tables.list";
    public const string TablesGet = "tables.get";
    public const string RoutinesList = "routines.list";
    public const string RoutinesGet = "routines.get";
    public const string ModelsList = "models.list";
    /// <summary>Preview Rows' table row listing (named apart from the row readers tests/working-memory-lint.test.ts pins).</summary>
    public const string TableRows = "tabledata.list";
    public const string JobsList = "jobs.list";
    public const string JobsGet = "jobs.get";
    public const string JobsInsert = "jobs.insert";
    public const string JobsCancel = "jobs.cancel";
}

/// <summary>
/// The metadata calls' shared limiter (docs/bigquery.md, Rate limiter), matching BigQuery's API (core) system limits, which count
/// the user (the principal) across every connection and client: each principal sends each method at most
/// <see cref="PerSecond"/> requests a second (<see cref="ProjectsListPerSecond"/> for projects.list), evenly spaced with no burst
/// on top so no one-second window holds more while slots are free (calls that waited for a slot go as slots free), and keeps at most <see cref="InFlight"/> calls in flight across all methods (BigQuery
/// allows 300; the rest is left to queries). A call first takes its method's turn, then an in-flight slot, so a method at its rate
/// never holds slots another method needs. Rate-limit refusals halve that method's rate, once per <see cref="ThrottleWindow"/> and
/// never for a call paced before the last halving (a burst of refusals from calls already queued or in flight counts once), down
/// to <see cref="MinimumFraction"/> of it; the rate then climbs back by the full rate each <see cref="Recovery"/>, pro rata.
/// </summary>
internal sealed class BigQueryRateLimiter(int inFlight = BigQueryRateLimiter.InFlight, Func<long>? clock = null)
{
    public const int InFlight = 250;
    public const double PerSecond = 100;
    public const double ProjectsListPerSecond = 10;
    /// <summary>The slowest a refused method is paced at, as a fraction of its full rate: low enough to back off, high enough that
    /// the calls a build queues (64 details at most) still go well within an index call's 30 s budget.</summary>
    public const double MinimumFraction = 0.1;
    /// <summary>A slowed method's rate climbs back by its full rate per this much time, pro rata (from the floor it takes 90% of it).</summary>
    public static readonly TimeSpan Recovery = TimeSpan.FromSeconds(10);
    /// <summary>Refusals within this of the last one that slowed the method do not slow it again.</summary>
    public static readonly TimeSpan ThrottleWindow = TimeSpan.FromSeconds(1);
    /// <summary>How long a principal counts as rate limited after its last refusal (the index's status says so).</summary>
    public static readonly TimeSpan Shown = TimeSpan.FromSeconds(5);

    private readonly Func<long> now = clock ?? Stopwatch.GetTimestamp;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> slots = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<(string Principal, string Method), Pace> paces = new();
    private readonly ConcurrentDictionary<string, long> refused = new(StringComparer.Ordinal);

    public static double RateOf(string method) => method == BqMethod.ProjectsList ? ProjectsListPerSecond : PerSecond;

    /// <summary>Waits for the method's turn, then one of the principal's slots; disposing the result returns the slot. A call
    /// whose deadline ends while it waits gives its turn back and takes no slot.</summary>
    public async Task<Lease> EnterAsync(string principal, string method, CancellationToken token)
    {
        var pace = paces.GetOrAdd((principal, method), key => new Pace(RateOf(key.Method)));
        var reserved = Seconds(now());
        var (wait, start, turn) = pace.Reserve(reserved);
        if (wait > TimeSpan.Zero)
        {
            try { await Task.Delay(wait, token); }
            catch (OperationCanceledException) { pace.Refund(start, turn); throw; }
        }
        var gate = slots.GetOrAdd(principal, _ => new SemaphoreSlim(inFlight, inFlight));
        try { await gate.WaitAsync(token); }
        catch (OperationCanceledException) { pace.Refund(start, turn); throw; }
        return new Lease(gate, reserved);
    }

    /// <summary>BigQuery refused one of the principal's calls to <paramref name="method"/> for its rate: the method slows down,
    /// unless the call was paced before the method last slowed down (<paramref name="lease"/> says when; none means now).</summary>
    public void Throttled(string principal, string method, Lease? lease = null)
    {
        var at = now();
        refused[principal] = at;
        paces.GetOrAdd((principal, method), key => new Pace(RateOf(key.Method))).Throttle(Seconds(at), lease?.Reserved ?? Seconds(at));
    }

    /// <summary>Whether BigQuery refused one of the principal's calls for its rate within the last <see cref="Shown"/>.</summary>
    public bool IsThrottled(string principal) =>
        refused.TryGetValue(principal, out var at) && Stopwatch.GetElapsedTime(at, now()) < Shown;

    /// <summary>Slots in use for a principal (the checks read it).</summary>
    public int InUse(string principal) => slots.TryGetValue(principal, out var gate) ? inFlight - gate.CurrentCount : 0;

    /// <summary>The method's current rate for a principal (the checks read it).</summary>
    public double RateFor(string principal, string method) =>
        paces.TryGetValue((principal, method), out var pace) ? pace.Rate(Seconds(now())) : RateOf(method);

    /// <summary>Reserves the method's next turn at <paramref name="timestamp"/> without waiting (the checks pace calls through it).</summary>
    internal TimeSpan Reserve(string principal, string method, long timestamp) =>
        paces.GetOrAdd((principal, method), key => new Pace(RateOf(key.Method))).Reserve(Seconds(timestamp)).Wait;

    /// <summary>Reserves a turn at <paramref name="timestamp"/>, with the action that gives it back as a stopped call does (the checks
    /// give turns back out of order through it).</summary>
    internal (TimeSpan Wait, Action Refund) ReserveRefundable(string principal, string method, long timestamp)
    {
        var pace = paces.GetOrAdd((principal, method), key => new Pace(RateOf(key.Method)));
        var (wait, start, turn) = pace.Reserve(Seconds(timestamp));
        return (wait, () => pace.Refund(start, turn));
    }

    static double Seconds(long timestamp) => (double)timestamp / Stopwatch.Frequency;

    /// <summary>
    /// One method's pace for one principal: <c>next</c> is when the next turn is due, each turn one interval at the rate it was
    /// taken at after the one before, and an idle method's first turn goes at once. A turn given back moves <c>next</c> back only
    /// when no scheduled turn follows it; one given back from the middle of the queue is kept as a gap and taken back once the
    /// turns after it are, so no later call is ever paced alongside one already scheduled. Rates and times are seconds.
    /// </summary>
    sealed class Pace(double rate)
    {
        private readonly double full = rate;
        private readonly object gate = new();
        private double next = double.NegativeInfinity;
        private double reduced = rate;
        private double throttledAt = double.NegativeInfinity;
        // Turns given back with scheduled turns after them, by start: one for each call stopped while it waited for its turn or a
        // slot, so as many as the callers that wait at once; all are dropped once the method is idle.
        private readonly SortedList<double, double> gaps = [];
        const double Epsilon = 1e-9;

        public double Rate(double at)
        {
            lock (gate) return RateLocked(at);
        }

        double RateLocked(double at) => reduced >= full ? full : Math.Min(full, reduced + full * Math.Max(0, at - throttledAt) / Recovery.TotalSeconds);

        /// <summary>The wait before the turn this takes, and the turn's start and length (given back by <see cref="Refund"/>).</summary>
        public (TimeSpan Wait, double Start, double Turn) Reserve(double at)
        {
            lock (gate)
            {
                var turn = 1 / RateLocked(at);
                if (next < at)
                {
                    next = at;
                    gaps.Clear();
                }
                var start = next;
                next += turn;
                return (TimeSpan.FromSeconds(start - at), start, turn);
            }
        }

        /// <summary>A turn its caller gave up unsent (its deadline ended while it waited for the turn or a slot): later callers may
        /// use it once no scheduled turn follows it.</summary>
        public void Refund(double start, double turn)
        {
            lock (gate)
            {
                var end = start + turn;
                if (end < next - Epsilon)
                {
                    gaps[start] = turn;
                    return;
                }
                if (Math.Abs(end - next) > Epsilon) return;
                next = start;
                while (gaps.Count > 0)
                {
                    var gapStart = gaps.Keys[^1];
                    if (Math.Abs(gapStart + gaps.Values[^1] - next) > Epsilon) break;
                    gaps.RemoveAt(gaps.Count - 1);
                    next = gapStart;
                }
            }
        }

        /// <summary>A refusal at <paramref name="at"/> of a call whose turn was reserved at <paramref name="reserved"/>.</summary>
        public void Throttle(double at, double reserved)
        {
            lock (gate)
            {
                if (reserved < throttledAt || at - throttledAt < ThrottleWindow.TotalSeconds) return;
                reduced = Math.Max(full * MinimumFraction, RateLocked(at) / 2);
                throttledAt = at;
            }
        }
    }

    /// <summary>One call's in-flight slot (disposing returns it) and when its turn was reserved.</summary>
    internal sealed class Lease(SemaphoreSlim gate, double reserved) : IDisposable
    {
        private int done;
        internal double Reserved => reserved;
        public void Dispose() { if (Interlocked.Exchange(ref done, 1) == 0) gate.Release(); }
    }

    /// <summary>BigQuery's rate limit refused the call (429, or 403 with reason rateLimitExceeded): retried after a backoff
    /// with jitter until the caller's deadline, since it did nothing.</summary>
    public static bool RateLimited(Exception error)
    {
        for (var current = error; current is not null; current = current.InnerException)
            if (current is GoogleApiException api)
                return api.HttpStatusCode == HttpStatusCode.TooManyRequests
                    || api.HttpStatusCode == HttpStatusCode.Forbidden && api.Error?.Errors?.Any(item => item.Reason == "rateLimitExceeded") == true;
        return false;
    }
}

internal sealed partial class BigQueryService
{
    /// <summary>Shared by every handle of this backend (one per principal).</summary>
    internal BigQueryRateLimiter Limiter { get; } = new();

    /// <summary>A free, idempotent metadata read of <paramref name="method"/> under the principal's limiter, which every attempt
    /// goes through again: rate-limit refusals slow the method down and retry with jittered backoff until <paramref name="token"/>
    /// ends, each one told to <paramref name="throttled"/> (Job History reports QUOTA for a sample they used up); other transient
    /// failures retry <see cref="ReadAttempts"/> times. No slot is held during a backoff.</summary>
    internal async Task<T> MetadataAsync<T>(BigQueryConnection connection, string method, Func<CancellationToken, Task<T>> call, CancellationToken token, Action<Exception>? throttled = null)
    {
        var principal = connection.Principal.PrincipalId;
        for (int attempt = 1, transient = 1; ; attempt++)
        {
            TimeSpan wait;
            using (var lease = await Limiter.EnterAsync(principal, method, token))
            {
                try { return await CallAsync(call, token); }
                catch (Exception error) when (!token.IsCancellationRequested && BigQueryRateLimiter.RateLimited(error))
                {
                    Limiter.Throttled(principal, method, lease);
                    throttled?.Invoke(error);
                    var backoff = Backoff(Math.Min(attempt, 5));
                    wait = backoff + TimeSpan.FromMilliseconds(Random.Shared.NextDouble() * backoff.TotalMilliseconds / 2);
                }
                catch (Exception error) when (transient++ < ReadAttempts && Transient(error, token)) { wait = Backoff(transient - 1); }
            }
            await Task.Delay(wait, token);
        }
    }
}
