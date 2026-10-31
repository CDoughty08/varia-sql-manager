using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of D1c: the 3211 parser and the progress throttle, progress kept out of an action's messages, runner v2's
/// step progress, the long gate (per Varia connection and in all, critic A26) and the shutdown drain of long jobs.</summary>
internal static class ActionProgressChecks
{
    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);

    public static async Task RunAsync(Action<bool, string> check)
    {
        Parser(check);
        Throttle(check);
        Messages(check);
        Catalogue(check);
        await RunnerAsync(check);
        await GatesAsync(check);
        await DrainAsync(check);
    }

    /// <summary>A host whose connections open only once released, so a job holds its gates for as long as a check needs.</summary>
    private sealed class HeldHost : IActionHost
    {
        public readonly ConcurrentQueue<string> Opened = new();
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool IgnoreStop { get; init; }
        public ServerProfile Profile(string connectionId) => Box2022;
        public SqlConnection Connection(string connectionId) => new("Application Name=" + connectionId + ";Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false");
        public async Task OpenAsync(SqlConnection connection, CancellationToken token)
        {
            Opened.Enqueue(new SqlConnectionStringBuilder(connection.ConnectionString).ApplicationName);
            await (IgnoreStop ? Release.Task : Release.Task.WaitAsync(token));
            throw new OperationCanceledException(token);
        }
        public bool ClearPoolsFor(string connectionId, string database) => false;
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
        public bool FreeDatabase(string connectionId, string database) => false;
        public IReadOnlySet<int> PoolSessions(string connectionId) => new HashSet<int>();
    }

    /// <summary>The embedded catalogue with one action marked long (and its cleanup budget set), as D1f's restore will be.</summary>
    internal static ActionsCatalog WithLong(string action, long? cleanupMs = null)
    {
        using var stream = typeof(ActionsCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Actions.actions-catalog.json")!;
        var json = JsonNode.Parse(stream)!;
        foreach (var row in json["actions"]!.AsArray())
            if (row!["action"]!.GetValue<string>() == action)
            {
                row["long"] = true;
                if (cleanupMs is { } ms) row["cleanupMs"] = ms;
            }
        return ActionsCatalog.Parse(new MemoryStream(JsonSerializer.SerializeToUtf8Bytes(json)));
    }

    private static void Parser(Action<bool, string> check)
    {
        check(ActionProgress.Parse("5 percent processed.") == 5 && ActionProgress.Parse("100 percent processed.") == 100 && ActionProgress.Parse("0 percent processed.") == 0
            && ActionProgress.Parse("Verarbeitet: 37 Prozent.") == 37 && ActionProgress.Parse("percent processed.") is null && ActionProgress.Parse("101 percent processed.") is null
            && ActionProgress.Parse("1000 percent processed.") is null && ActionProgress.Parse("") is null,
            "message 3211's percent is its first number of up to three digits, 0 to 100, whatever the server's language");
    }

    private static void Throttle(Action<bool, string> check)
    {
        long now = 1_000;
        var sent = new List<string>();
        var progress = new ActionProgress(value => sent.Add(JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web))), TimeSpan.FromMilliseconds(250), () => now);
        var early = progress.Observe(3211, "5 percent processed.");
        progress.Begin(2);
        var other = progress.Observe(4035, "Processed 100 pages.");
        progress.Observe(3211, "10 percent processed.");
        now += 100;
        progress.Observe(3211, "20 percent processed.");
        now += 150;
        progress.Observe(3211, "30 percent processed.");
        progress.Begin(3);
        now += 10;
        progress.Observe(3211, "40 percent processed.");
        now += 300;
        progress.Observe(3211, "garbled");
        check(early && !other && sent.SequenceEqual(["{\"type\":\"action.progress\",\"step\":2,\"percent\":10}", "{\"type\":\"action.progress\",\"step\":2,\"percent\":30}"])
            && progress.PercentOf(2) == 30 && progress.PercentOf(3) == 40 && progress.PercentOf(0) is null,
            "progress EVENTs carry the running step's index and percent at most once per interval, and every percent still counts for its step's reply: " + string.Join(" ", sent));
        var silent = new ActionProgress(null, TimeSpan.Zero);
        silent.Begin(0);
        check(silent.Observe(3211, "50 percent processed.") && silent.PercentOf(0) == 50, "with no listener a step still records its percent");
    }

    private static void Messages(Action<bool, string> check)
    {
        var progress = new ActionProgress(null, TimeSpan.Zero);
        progress.Begin(0);
        var log = new ActionService.MessageLog(2, 20, progress);
        for (var percent = 1; percent <= 50; percent++) log.Add(10, 3211, percent + " percent processed.");
        log.Add(16, 50000, "an error is not an informational message");
        log.Add(0, 4035, "Processed 368 pages for database 'x', file 'x' on file 1.");
        log.Add(10, 3014, "BACKUP DATABASE successfully processed 370 pages.");
        log.Add(10, 15477, "Caution: one more than kept.");
        var bare = new ActionService.MessageLog(4, 20, null);
        bare.Add(10, 3211, "5 percent processed.");
        bare.Add(10, 5701, "Changed database context.");
        var kept = log.Collected();
        check(kept.Count == 2 && kept[0].StartsWith("Processed 368", StringComparison.Ordinal) && kept[0].Length == 20 && kept[1].StartsWith("BACKUP DATABASE", StringComparison.Ordinal)
            && progress.PercentOf(0) == 50 && bare.Collected().SequenceEqual(["Changed database context."[..19] + "…"]),
            "progress messages (3211) feed the step's percent and never count toward an action's kept messages: " + string.Join(" | ", kept) + " / " + string.Join(" | ", bare.Collected()));
    }

    private static void Catalogue(Action<bool, string> check)
    {
        var catalog = ActionsCatalog.Current;
        var options = new ActionServiceOptions();
        check(catalog.Limit("longPerConnection") == options.LongPerConnection && catalog.Limit("longTotal") == options.LongTotal
            && catalog.Limit("progressEventMs") == (long)options.ProgressInterval.TotalMilliseconds && options.LongPerConnection == 1 && options.LongTotal == 2,
            "the long gate and the progress interval come from the catalogue's limits");
        var marked = WithLong("delete", 30_000);
        check(catalog.Actions.All(action => !catalog.IsLong(action)) && marked.IsLong("delete") && !marked.IsLong("rename") && !marked.IsLong("createTable")
            && marked.CleanupBudget("delete") == TimeSpan.FromSeconds(30),
            "an action is long only when the catalogue marks it (none yet; D1f marks the restores and the backup)");
    }

    private static async Task RunnerAsync(Action<bool, string> check)
    {
        using var service = new ActionService(new HeldHost());
        await using var connection = new SqlConnection("Data Source=tcp:127.0.0.1,1;Connect Timeout=1;Pooling=false;Encrypt=false");
        var events = new List<string>();
        var progress = new ActionProgress(value => events.Add(JsonSerializer.Serialize(value, new JsonSerializerOptions(JsonSerializerDefaults.Web))), TimeSpan.Zero);
        RunStep Step(string title, params int[] percents) => new(title, _ =>
        {
            foreach (var percent in percents) progress.Observe(3211, percent + " percent processed.");
            return title == "Fail" ? Task.FromException(ConnectionFailureChecks.Sql(3013, 1, 16, "server", "BACKUP DATABASE is terminating abnormally.")) : Task.CompletedTask;
        });
        RunStep[] plan = [Step("Prepare"), Step("Restore", 10, 60, 100), Step("Verify", 40), Step("Fail"), Step("After")];
        var outcome = await service.RunStepsAsync(connection, plan, null, CancellationToken.None, TimeSpan.FromSeconds(1), progress: progress);
        check(outcome.Steps.Select(step => step.Title + ":" + step.Progress).SequenceEqual(["Prepare:", "Restore:100", "Verify:40", "Fail:", "After:"])
            && events.SequenceEqual([
                "{\"type\":\"action.progress\",\"step\":1,\"percent\":10}", "{\"type\":\"action.progress\",\"step\":1,\"percent\":60}", "{\"type\":\"action.progress\",\"step\":1,\"percent\":100}",
                "{\"type\":\"action.progress\",\"step\":2,\"percent\":40}"]),
            "runner v2 counts a step's progress for its index in the reply, and each step carries the last percent it reached: "
            + string.Join(", ", outcome.Steps.Select(step => step.Title + ":" + step.Progress)) + " | " + string.Join(" ", events));
    }

    private static async Task<string> Outcome(Task<ActionExecuteResult> run)
    {
        try { var result = await run; return result.Error?.Code ?? "OK"; }
        catch (RequestException error) { return error.Code + ": " + error.Message; }
        catch (OperationCanceledException) { return "CANCELLED"; }
    }

    private static RunStep[] Nothing(SqlConnection _) => [];

    private static async Task GatesAsync(Action<bool, string> check)
    {
        var host = new HeldHost();
        using var service = new ActionService(host, new ActionServiceOptions { GateWait = TimeSpan.FromMilliseconds(200) }, WithLong("delete"));
        using var stop = new CancellationTokenSource();
        var first = Outcome(service.ExecuteStepsAsync("A", Guid.NewGuid().ToString(), "delete", Nothing, null, stop.Token));
        var second = Outcome(service.ExecuteStepsAsync("B", Guid.NewGuid().ToString(), "delete", Nothing, null, stop.Token));
        SpinWait.SpinUntil(() => host.Opened.Count == 2, 5_000);
        // A's long gate is taken: another long action on A waits gateWaitMs, then BUSY; one on C finds both long slots taken.
        var sameConnection = await Outcome(service.ExecuteStepsAsync("A", Guid.NewGuid().ToString(), "delete", Nothing, null, stop.Token));
        var third = await Outcome(service.ExecuteStepsAsync("C", Guid.NewGuid().ToString(), "delete", Nothing, null, stop.Token));
        // A rename on A takes the execute gate, which the running long action does not hold.
        var rename = Outcome(service.ExecuteStepsAsync("A", Guid.NewGuid().ToString(), "rename", Nothing, null, stop.Token));
        var renameOpened = SpinWait.SpinUntil(() => host.Opened.Count == 3, 5_000);
        stop.Cancel();
        host.Release.TrySetResult();
        var ended = await Task.WhenAll(first, second, rename);
        const string LongBusy = "BUSY: Another restore or backup is running on this connection. Retry after it finishes.";
        check(sameConnection == LongBusy && third == LongBusy && renameOpened && host.Opened.ToArray().SequenceEqual(["A", "B", "A"]) && ended.All(code => code.StartsWith("CANCELLED", StringComparison.Ordinal)),
            $"the long gate allows one long action per Varia connection and two in all, says so for this connection, and leaves the execute gate free: {sameConnection} / {third} / {string.Join(", ", ended)} / {string.Join(",", host.Opened)}");

        var shortHost = new HeldHost();
        using var shortService = new ActionService(shortHost, new ActionServiceOptions { GateWait = TimeSpan.FromMilliseconds(200) });
        using var shortStop = new CancellationTokenSource();
        var holding = Outcome(shortService.ExecuteStepsAsync("A", Guid.NewGuid().ToString(), "delete", Nothing, null, shortStop.Token));
        SpinWait.SpinUntil(() => shortHost.Opened.Count == 1, 5_000);
        var busy = await Outcome(shortService.ExecuteStepsAsync("A", Guid.NewGuid().ToString(), "rename", Nothing, null, shortStop.Token));
        shortStop.Cancel();
        shortHost.Release.TrySetResult();
        await holding;
        check(busy == "BUSY: Other object actions are running on this connection. Retry after they finish.",
            "a second action on a Varia connection whose execute gate is taken is BUSY, worded for this connection (critic A26): " + busy);
    }

    private static async Task DrainAsync(Action<bool, string> check)
    {
        check(new ActionService(new HeldHost()).DrainLong(), "with no long action running, a shutdown has nothing to wait for");
        // A long job that ignores Stop (SQL Server still ending a RESTORE): the drain waits for its Stop wait, then gives up.
        var stuck = new HeldHost { IgnoreStop = true };
        using var stuckService = new ActionService(stuck, new ActionServiceOptions { StopGrace = TimeSpan.FromMilliseconds(100) }, WithLong("delete", 200));
        var stuckRun = Outcome(stuckService.ExecuteStepsAsync("A", Guid.NewGuid().ToString(), "delete", Nothing, null, CancellationToken.None));
        var shortRun = Outcome(stuckService.ExecuteStepsAsync("B", Guid.NewGuid().ToString(), "rename", Nothing, null, CancellationToken.None));
        SpinWait.SpinUntil(() => stuck.Opened.Count == 2, 5_000);
        stuckService.CancelAll();
        var watch = Stopwatch.StartNew();
        var gaveUp = !stuckService.DrainLong();
        var waited = watch.ElapsedMilliseconds;
        // The same job finishing inside its wait: the drain returns once it ended.
        var held = new HeldHost { IgnoreStop = true };
        using var service = new ActionService(held, new ActionServiceOptions { StopGrace = TimeSpan.FromSeconds(5) }, WithLong("delete", 5_000));
        var run = Outcome(service.ExecuteStepsAsync("A", Guid.NewGuid().ToString(), "delete", Nothing, null, CancellationToken.None));
        SpinWait.SpinUntil(() => held.Opened.Count == 1, 5_000);
        service.CancelAll();
        _ = Task.Delay(300).ContinueWith(_ => held.Release.TrySetResult(), TaskScheduler.Default);
        watch.Restart();
        var drained = service.DrainLong();
        var drainedMs = watch.ElapsedMilliseconds;
        var jobEnded = run.IsCompleted || await Task.WhenAny(run, Task.Delay(1_000)) == run;
        stuck.Release.TrySetResult();
        await Task.WhenAll(stuckRun, shortRun, run);
        check(gaveUp && waited is >= 250 and < 2_000 && drained && drainedMs is >= 250 and < 4_000 && jobEnded,
            $"after CancelAll a shutdown waits for each long job (not the others) up to its Stop wait plus cleanup budget, and returns once they ended: gave up after {waited} ms, drained in {drainedMs} ms");
    }
}
