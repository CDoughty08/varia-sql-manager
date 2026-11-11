using System.Collections.Concurrent;
using System.Diagnostics;

namespace Varia.Backend.Tests;

// Runs the offline suites in concurrent lanes. Most of their time is waiting (request budgets, timeouts, coalescing
// windows), not CPU: one after another they took 65 to 77 s, mostly idle (docs/ci.md). Each suite prints its time, as the
// live suites do, so Weights can be refreshed from a run's output.
static class OfflineSuites
{
    // Suites that change process-wide state run alone, before the lanes start: Entra redirects the console and sets
    // IDENTITY_ENDPOINT, Store measures the managed heap across forced collections, and Scripting sets
    // ScriptingCulture.Override.
    public static readonly string[] Alone = ["Entra", "Store", "Scripting"];

    // Measured seconds per suite, from a serial run's 'Offline suite' lines (VARIA_TEST_OFFLINE_LANES=1, Windows, 2026-11-08, after the timing checks were hardened for starved runners);
    // suites under 0.3 s are left out and count as 0.1 s. Refresh it when a suite moves by more than a second. Text is CPU-bound,
    // so it carries its contended CI time (9.6 to 20 s, 2.3 s alone): weighed alone it padded the slowest lane on every OS.
    public static readonly Dictionary<string, double> Weights = new()
    {
        ["Host"] = 12.5, ["Ssis"] = 7.7, ["Explorer"] = 7.1, ["ActivityAction"] = 6.2, ["LiveScheduler"] = 5.5, ["Restore"] = 5.1,
        ["Live"] = 4.4, ["ServerFiles"] = 4.2, ["LiveTable"] = 3.7, ["Store"] = 3.0, ["Entra"] = 2.4, ["Text"] = 12.0,
        ["Login"] = 2.2, ["Peek"] = 2.2, ["Seam"] = 2.2, ["ActionProgress"] = 1.8, ["LspTransport"] = 1.8, ["Action"] = 1.7, ["Scripting"] = 1.6,
        ["LoginDelete"] = 0.8, ["Unlock"] = 0.7, ["LoginAction"] = 0.7, ["SqlLanguage"] = 6.0, ["SqlLanguageDiagnostics"] = 1.0, ["SqlCompletion"] = 1.0, ["Page"] = 0.4, ["ActivitySource"] = 0.4,
    };

    // Six lanes. The lanes mostly wait, so more lanes than CI's 3 to 4 vCPUs still help: locally, 1 lane took 65 s, 4 took
    // 26 s, 6 took 22 s and 8 took 19 s, where Host (10 s, 12.5 s since its timing checks were hardened) is the floor. Six leaves headroom for vitest, which runs beside
    // this in npm run check. VARIA_TEST_OFFLINE_LANES overrides it.
    public const int DefaultLanes = 6;

    public static int Lanes => int.TryParse(Environment.GetEnvironmentVariable("VARIA_TEST_OFFLINE_LANES"), out var lanes) && lanes > 0 ? lanes : DefaultLanes;

    // Longest first, each onto the lane with the least work so far.
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

    static double Weight(string name) => Weights.TryGetValue(name, out var seconds) ? seconds : 0.1;

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
                foreach (var name in Alone.Where(byName.ContainsKey)) await Timed(name);
                var rest = suites.Select(suite => suite.Name).Where(name => !Alone.Contains(name));
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
