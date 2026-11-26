using System.Collections.Concurrent;
using System.Diagnostics;

namespace Varia.Backend.Tests;

// Runs the offline suites in concurrent lanes. Most of their time is waiting (request budgets, timeouts, coalescing
// windows), not CPU: one after another they took 65 to 77 s, mostly idle (docs/ci.md). Each suite prints its time, as the
// live suites do, so Weights can be refreshed from a run's output.
static class OfflineSuites
{
    // Suites that change process-wide state run alone, before the lanes start: Entra redirects the console and sets
    // IDENTITY_ENDPOINT, Store measures the managed heap across forced collections, Scripting sets
    // ScriptingCulture.Override, SessionDisconnect reads the process-wide Monitor.LockContentionCount, and BigQuery sets
    // Google's and AWS's environment variables.
    public static readonly string[] Alone = ["Entra", "ConnectionPrincipal", "Store", "Scripting", "SessionDisconnect", "BigQuery"];

    // Pure in-memory managed suites with zero OS API, P/Invoke, filesystem-write or OS-collation branches.
    // Linux Check and local runs always execute every suite plus the packed pass; macOS and Windows Check set
    // VARIA_TEST_OFFLINE_SCOPE=os to skip only these suites and the packed second pass while keeping every
    // OS, filesystem, process, pipe/socket, Entra/Kerberos, line-ending and ICU collation check.
    public static readonly string[] PureManaged =
    [
        "ParallelResult",
        "FusedRead", "FusedWhole.Diffs", "FusedWhole.DistinctsSearch", "FusedWhole.MixedServices", "FusedWhole.Faults",
        "BigQueryExecution.Residence", "BigQueryExecution.Storage",
        "BigQuerySession", "BigQueryJobHistory",
        "Packing", "Packer", "IdlePacker", "SealPacking", "PageFilter", "RoomPool",
    ];

    public static bool OsScope => string.Equals(Environment.GetEnvironmentVariable("VARIA_TEST_OFFLINE_SCOPE"), "os", StringComparison.OrdinalIgnoreCase);

    // Measured seconds per suite on CI (PR #729, 2026-11-24; suites under 0.3 s count as 0.1 s). Refresh when a suite moves
    // by more than a few seconds. Heavy CPU-bound suites carry their contended CI times so no two land on the same lane.
    public static readonly Dictionary<string, double> Weights = new()
    {
        ["SearchNarrowing"] = 85.0, ["BigQueryExecution.Residence"] = 73.0, ["ParallelResult"] = 72.0, ["FusedWhole.Diffs"] = 64.0,
        ["BigQueryExecution.Storage"] = 60.0, ["Host"] = 40.0, ["Packing"] = 38.0, ["FusedRead"] = 36.0,
        ["FusedWhole.DistinctsSearch"] = 36.0, ["BigQueryJobHistory"] = 34.0, ["Text"] = 33.0, ["SearchFold"] = 32.0,
        ["View"] = 22.0, ["BigQuerySession"] = 20.0, ["PageFilter"] = 19.0, ["IdlePacker"] = 19.0,
        ["FusedWhole.Faults"] = 15.0, ["Explorer"] = 13.0, ["FusedWhole.MixedServices"] = 12.0, ["SealPacking"] = 11.0,
        ["LoginDelete"] = 11.0, ["Profile"] = 10.0, ["Store"] = 9.0, ["Ssis"] = 9.0, ["LiveScheduler"] = 8.5,
        ["Search"] = 8.4, ["IndexFile"] = 8.0, ["Live"] = 7.8, ["AgentActions"] = 7.1, ["SqlLanguage"] = 6.2,
        ["BigQueryExecution.ViewsCopySave"] = 6.0, ["Packer"] = 5.8, ["RoomPool"] = 5.6, ["Restore"] = 5.5, ["Page"] = 5.5,
        ["Seam"] = 5.1, ["LiveTable"] = 5.0, ["Plan"] = 4.8, ["ActionProgress"] = 4.6, ["ServerFiles"] = 4.2,
        ["SqlLanguageDiagnostics"] = 4.2, ["BigQueryExecution.Core"] = 4.0, ["ActivityAction"] = 4.0, ["Agent"] = 3.9,
        ["BigQueryIndex"] = 3.9, ["TypedForm"] = 3.7, ["LspTransport"] = 3.4, ["Login"] = 3.0, ["Entra"] = 2.5,
        ["ResultSearch"] = 2.3, ["Peek"] = 2.2, ["TransposedText"] = 2.1, ["Action"] = 1.7, ["Diff"] = 1.6, ["Scripting"] = 1.6,
        ["SqlCompletion"] = 1.0, ["Unlock"] = 0.7, ["LoginAction"] = 0.7, ["OperationProgress"] = 0.5, ["ActivitySource"] = 0.4,
    };

    // Six lanes. The lanes mostly wait, so more lanes than CI's 3 to 4 vCPUs still help: locally, 1 lane took 65 s, 4 took
    // 26 s, 6 took 22 s and 8 took 19 s, where Host (10 s, 12.5 s since its timing checks were hardened) is the floor. Six leaves headroom for vitest, which runs beside
    // this in npm run check. VARIA_TEST_OFFLINE_LANES overrides it.
    public const int DefaultLanes = 6;

    public static int Lanes => int.TryParse(Environment.GetEnvironmentVariable("VARIA_TEST_OFFLINE_LANES"), out var lanes) && lanes > 0 ? lanes : DefaultLanes;

    // Longest first, each onto the lane with the least work so far. Within each lane, raw suites run before Packed suites
    // so a suite and its Packed twin (e.g. SearchNarrowing + Packed SearchNarrowing) never contend for CPU/GC at t=0.
    public static List<string>[] Assign(IEnumerable<string> names, int lanes)
    {
        var assigned = Enumerable.Range(0, lanes).Select(_ => new List<string>()).ToArray();
        var load = new double[lanes];
        foreach (var name in names.OrderByDescending(Weight).ThenBy(name => name, StringComparer.Ordinal))
        {
            var lane = Array.IndexOf(load, load.Min());
            assigned[lane].Add(name);
            load[lane] += Weight(name);
        }
        foreach (var lane in assigned)
            lane.Sort((a, b) =>
            {
                var packed = IsPacked(a).CompareTo(IsPacked(b));
                if (packed != 0) return packed;
                var weight = Weight(b).CompareTo(Weight(a));
                return weight != 0 ? weight : StringComparer.Ordinal.Compare(a, b);
            });
        return assigned;
    }

    // A suite that never ends used to run the check to the CI step's 20 minute timeout, which named only the lane's output so
    // far. Every suite ends within a minute even on a stalled runner, so past this the run names the suites still going and
    // exits. VARIA_TEST_OFFLINE_SUITE_MS overrides it (a debugger held at a breakpoint).
    public const int DefaultSuiteLimitMs = 180_000;

    public static int SuiteLimitMs => int.TryParse(Environment.GetEnvironmentVariable("VARIA_TEST_OFFLINE_SUITE_MS"), out var limit) && limit > 0 ? limit : DefaultSuiteLimitMs;

    static void Stuck(string message)
    {
        Console.Error.WriteLine(message);
        Console.Out.Flush();
        Environment.Exit(1);
    }

    static double Weight(string name) => Weights.TryGetValue(Base(name), out var seconds) ? seconds : 0.1;

    /// <summary>Prefixed to the result suites' second run with every result packed (Program.cs): the same suite, alone or
    /// weighed as the first run's.</summary>
    public const string PackedPrefix = "Packed ";

    static bool IsPacked(string name) => name.StartsWith(PackedPrefix, StringComparison.Ordinal);

    static string Base(string name) => IsPacked(name) ? name[PackedPrefix.Length..] : name;

    /// <param name="limitMs">How long one suite may run before <paramref name="stuck"/> is told (by default the run exits).</param>
    public static async Task RunAsync((string Name, Func<Task> Run)[] suites, bool serial, int? limitMs = null, Action<string>? stuck = null, Action<string>? log = null)
    {
        log ??= Console.WriteLine;
        stuck ??= Stuck;
        var limit = limitMs ?? SuiteLimitMs;
        var started = Stopwatch.StartNew();
        var times = new ConcurrentDictionary<string, long>();
        var underWay = new ConcurrentDictionary<string, long>();
        var byName = suites.ToDictionary(suite => suite.Name, suite => suite.Run);
        async Task Timed(string name)
        {
            var watch = Stopwatch.StartNew();
            underWay[name] = started.ElapsedMilliseconds;
            await byName[name]();
            underWay.TryRemove(name, out _);
            times[name] = watch.ElapsedMilliseconds;
            log("Offline suite " + name + ": " + watch.ElapsedMilliseconds + " ms");
        }
        // Its own thread: a pool timer would wait behind the very starvation or deadlock it is there to report.
        using var ended = new ManualResetEventSlim();
        var watchdog = new Thread(() =>
        {
            while (!ended.Wait(Math.Clamp(limit / 4, 10, 1000)))
            {
                var now = started.ElapsedMilliseconds;
                var late = underWay.Where(pair => now - pair.Value >= limit).Select(pair => pair.Key).Order(StringComparer.Ordinal).ToArray();
                if (late.Length == 0) continue;
                stuck("Offline " + (late.Length == 1 ? "suite " : "suites ") + string.Join(", ", late) + " did not finish within " + limit + " ms; still running: "
                    + string.Join(", ", underWay.Keys.Order(StringComparer.Ordinal)) + ". The suites queued behind them in their lanes never ran.");
                return;
            }
        }) { IsBackground = true, Name = "Offline suite watchdog" };
        watchdog.Start();
        // VARIA_TEST_SLOW_MS times the gaps between checks, which only means something one suite at a time.
        var lanes = serial ? 1 : Lanes;
        try
        {
            if (lanes == 1)
            {
                foreach (var (name, _) in suites) await Timed(name);
            }
            else
            {
                // Synchronous lanes occupy ThreadPool workers; on 3-vCPU CI runners the default min-threads (3) leaves zero
                // spare threads for async continuations and timers until hill-climbing injects them slowly.
                ThreadPool.GetMinThreads(out var minWorker, out var minIo);
                ThreadPool.SetMinThreads(Math.Max(minWorker, lanes + 4), Math.Max(minIo, 8));
                foreach (var name in suites.Select(suite => suite.Name).Where(name => Alone.Contains(Base(name)))) await Timed(name);
                var rest = suites.Select(suite => suite.Name).Where(name => !Alone.Contains(Base(name)));
                await Task.WhenAll(Assign(rest, lanes).Select(lane => Task.Run(async () => { foreach (var name in lane) await Timed(name); })));
            }
        }
        finally
        {
            // The watchdog has left before its event is disposed.
            ended.Set();
            watchdog.Join();
        }
        log("Offline suites: " + started.ElapsedMilliseconds + " ms in " + lanes + (lanes == 1 ? " lane" : " lanes") + " (their sum " + times.Values.Sum() + " ms)");
    }
}
