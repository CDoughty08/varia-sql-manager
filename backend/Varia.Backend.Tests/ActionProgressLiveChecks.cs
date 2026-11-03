using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

/// <summary>Live checks of D1c, with VARIA_TEST_SQL_SCRATCH=1 in a marked VariaScratch_…_ap database. First a real actions.execute
/// of a catalogue action marked long goes through SqlService.DispatchAsync, as main sends it, and its step starts come back as
/// droppable EVENTs on the request (an action not marked long sends none). Then a long action's step runs a BACKUP DATABASE … WITH
/// STATS = 5 and reads a table another session holds locked; that session lets go only once two rising 3211 EVENTs arrived, so
/// they must arrive while the step still runs: a batch run through ExecuteNonQueryAsync, whose info messages SqlClient holds until
/// the batch ends, waits out the bound and fails (D1 risk: "a refactor back to ExecuteNonQueryAsync silently kills progress").
/// The BACKUP is made to take a while (64 MiB through one 64 KiB buffer), and its EVENTs must be spread over it rather than arrive
/// together, as they would if they were delivered only at the statement's end: a RESTORE is one statement that runs for minutes.
/// Then a long job stopped by a closing backend (CancelAll) still runs its cleanup step before SqlService.DrainCommitted returns.</summary>
internal static class ActionProgressLiveChecks
{
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static readonly TimeSpan Bound = TimeSpan.FromSeconds(60);
    /// <summary>How far apart a BACKUP's first and last 3211 EVENTs must arrive. Delivered at the statement's end, they arrive within
    /// a millisecond or two; delivered as they come, they span the copy, about 100 ms for 64 MiB on a fast local disk.</summary>
    private const long SpreadMs = 40;
    /// <summary>64 MiB of pages: they compress to nothing, but the copy still reads each one.</summary>
    private const string Pad = "SELECT TOP (8192) CONVERT(char(8000), 'x') AS pad FROM sys.all_columns AS a CROSS JOIN sys.all_columns AS b";

    /// <summary>An action.progress EVENT as step:percent.</summary>
    private static string Short(object value, JsonSerializerOptions json)
    {
        var element = JsonSerializer.SerializeToElement(value, json);
        return element.GetProperty("type").GetString() == "action.progress" ? element.GetProperty("step").GetInt32() + ":" + element.GetProperty("percent").GetInt32() : "?";
    }

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, Func<string, ConnectOptions> live, JsonSerializerOptions json)
    {
        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("Action progress scratch checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named database on a disposable development server.");
            return;
        }
        async Task<T> Call<T>(SqlService on, string method, object args) => (T)await on.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<SqlRun> Sql(string text, string database = "master")
        {
            var id = Guid.NewGuid().ToString();
            try
            {
                var result = await Call<QueryResult>(service, "query.execute", new QueryArgs(info.Id, id, database, text, Guid.NewGuid().ToString(), 100_000, 300, StopOnError: true));
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await Call<object>(service, "query.session.close", new SessionArgs(id)); }
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        var db = await scratch.CreateProgressAsync();
        // Simple recovery, so the padding is minimally logged.
        var created = await Sql("ALTER DATABASE CURRENT SET RECOVERY SIMPLE;\n"
            + "CREATE TABLE dbo.Held (id int NOT NULL); INSERT dbo.Held (id) SELECT TOP (20000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) FROM sys.all_columns AS a CROSS JOIN sys.all_columns AS b;\n"
            + "SELECT pad INTO dbo.Pad FROM (" + Pad + ") AS p;\nCREATE TABLE dbo.GoneLong (id int); CREATE TABLE dbo.GoneShort (id int);", db);
        if (created.Status != "completed") throw new InvalidOperationException("Action progress setup failed: " + created.Error);
        var backup = await ScratchDatabase.Backup.ForAsync((text, database) => Sql(text, database), db);
        // The held read: another session takes the table with TABLOCKX inside an open transaction until the check lets go.
        var holder = "";
        async Task Hold()
        {
            holder = Guid.NewGuid().ToString();
            var held = await Call<QueryResult>(service, "query.execute", new QueryArgs(info.Id, holder, db, "BEGIN TRANSACTION; SELECT COUNT(*) FROM dbo.Held WITH (TABLOCKX, HOLDLOCK);", Guid.NewGuid().ToString(), 10, 30, StopOnError: true));
            if (held.Status != "completed") throw new InvalidOperationException("Action progress setup failed: " + held.Error?.Message);
        }
        Task LetGo() => Call<object>(service, "query.session.close", new SessionArgs(holder, "rollback"));
        var readHeld = "SELECT CONVERT(nvarchar(20), COUNT(*)) FROM " + Bracket(db) + ".dbo.Held;";

        using var longService = new SqlService(actionsCatalog: ActionProgressChecks.WithLong("delete", 30_000));
        var longInfo = (ConnectionInfo)await longService.DispatchAsync("connections.connect", JsonSerializer.SerializeToElement(live("master"), json), json);
        try
        {
            // The wire path: SqlService gives actions.execute a sink for droppable EVENTs on the request, and a long action's runner
            // announces each step it starts (the statements run through RunStatementAsync, as every catalogue action's do).
            async Task<(ActionExecuteResult Result, List<string> Events)> Delete(SqlService on, string connectionId, string table)
            {
                var events = new List<string>();
                using var context = new RequestContext(7, "actions.execute", RequestLane.Actions, 0,
                    sendEvent: (_, value, droppable) => { lock (events) events.Add(Short(value, json) + (droppable ? "" : " (kept)")); });
                var result = (ActionExecuteResult)await on.DispatchAsync("actions.execute", JsonSerializer.SerializeToElement(
                    new ActionArgs("delete", connectionId, Guid.NewGuid().ToString(), new ObjectRefDto("table", db, "dbo", table), null, false, false), json), json, context);
                lock (events) return (result, [.. events]);
            }
            var (longDelete, longEvents) = await Delete(longService, longInfo.Id, "GoneLong");
            var (shortDelete, shortEvents) = await Delete(service, info.Id, "GoneShort");
            check(longDelete is { Error: null, Steps.Count: > 0 } && longDelete.Steps.All(step => step.Status == "done")
                && longEvents.SequenceEqual(longDelete.Steps.Select((_, index) => index + ":0"))
                && shortDelete is { Error: null } && shortEvents.Count == 0,
                "actions.execute through SqlService sends a long action's step starts as droppable action.progress EVENTs on the request, and a short action's none: "
                + string.Join(" ", longEvents) + " | " + string.Join(" ", shortEvents) + " | " + longDelete.Error?.Message + shortDelete.Error?.Message);

            var actions = longService.Actions;
            actions.Options.ProgressInterval = TimeSpan.Zero;
            async Task<(ActionExecuteResult? Result, bool DuringStep, (int Step, int Percent, long At)[] Seen, long BackupMs)> BackUp()
            {
                var percents = new ConcurrentQueue<(int Step, int Percent, long At)>();
                var rising = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                void Event(object value)
                {
                    var element = JsonSerializer.SerializeToElement(value, json);
                    if (element.GetProperty("type").GetString() != "action.progress") return;
                    percents.Enqueue((element.GetProperty("step").GetInt32(), element.GetProperty("percent").GetInt32(), Stopwatch.GetTimestamp()));
                    // The step's start (percent 0) comes first, then its 3211s.
                    var stats = percents.Skip(1).ToArray();
                    if (stats.Length >= 2 && stats[^1].Percent > stats[0].Percent) rising.TrySetResult();
                }
                var backupMs = -1L;
                IReadOnlyList<RunStep> Plan(SqlConnection connection) =>
                [
                    new("Back up", async context =>
                    {
                        await using var command = new SqlCommand("DECLARE @at datetime2 = SYSUTCDATETIME();\n" + backup.DatabaseSql("COPY_ONLY, STATS = 5, BUFFERCOUNT = 1, MAXTRANSFERSIZE = 65536")
                            + "\nSELECT CONVERT(nvarchar(20), DATEDIFF(millisecond, @at, SYSUTCDATETIME()));\n" + readHeld, connection) { CommandTimeout = 0 };
                        var values = await ActionService.ReadAllAsync(command, context.Token);
                        backupMs = long.Parse(values[0]!, CultureInfo.InvariantCulture);
                    })
                ];
                ActionExecuteResult? result;
                bool duringStep;
                await Hold();
                try
                {
                    var run = actions.ExecuteStepsAsync(longInfo.Id, Guid.NewGuid().ToString(), "delete", Plan, Event, CancellationToken.None);
                    await Task.WhenAny(rising.Task, run, Task.Delay(Bound));
                    duringStep = rising.Task.IsCompleted && !run.IsCompleted;
                    await LetGo();
                    result = await run.WaitAsync(Bound);
                }
                finally { await LetGo(); }
                return (result, duringStep, percents.ToArray(), backupMs);
            }
            static long Spread((int Step, int Percent, long At)[] seen) => seen.Length < 3 ? 0 : (long)Stopwatch.GetElapsedTime(seen[1].At, seen[^1].At).TotalMilliseconds;
            (ActionExecuteResult? Result, bool DuringStep, (int Step, int Percent, long At)[] Seen, long BackupMs) attempt;
            try
            {
                attempt = await BackUp();
                if (Spread(attempt.Seen) < SpreadMs)
                {
                    // A copy too quick to tell apart (a fast disk, a quiet server): twice the pages, once more. Delivered at the
                    // statement's end, the EVENTs arrive together however large the BACKUP is.
                    Console.WriteLine("Timing: a BACKUP's progress EVENTs arrived within " + Spread(attempt.Seen) + " ms of each other (the BACKUP took " + attempt.BackupMs
                        + " ms); measuring a larger one once more.");
                    var grown = await Sql("INSERT dbo.Pad WITH (TABLOCK) (pad) " + Pad + ";", db);
                    if (grown.Status != "completed") throw new InvalidOperationException("Action progress setup failed: " + grown.Error);
                    attempt = await BackUp();
                }
            }
            finally { await backup.ForgetAsync((text, database) => Sql(text, database)); }
            var (result, duringStep, seen, backupMs) = attempt;
            var spread = Spread(seen);
            check(duringStep && seen.Length >= 3 && seen[0] is (0, 0, _) && seen.All(item => item.Step == 0) && seen.Zip(seen.Skip(1)).All(pair => pair.Second.Percent >= pair.First.Percent)
                && result is { Error: null, Steps: [{ Status: "done", Title: "Back up", Progress: 100 }] }
                && !result.Messages.Any(message => message.Contains("percent processed", StringComparison.OrdinalIgnoreCase)),
                "a long step announces its start, its BACKUP … STATS = 5 sends rising action.progress EVENTs while the step still runs (through a reader), "
                + "the reply's step carries 100, and its 3211 lines are not among the kept messages: " + string.Join(" ", seen.Select(item => item.Percent)) + " | " + result?.Error?.Message);
            check(spread >= SpreadMs,
                $"a BACKUP's progress EVENTs arrive while that one statement runs, spread over it, not together at its end: {spread} ms from the first to the last, the BACKUP took {backupMs} ms");

            // A closing backend: CancelAll stops the long job, whose cleanup step (held 2 s) still runs before DrainCommitted returns.
            var cleaned = 0;
            IReadOnlyList<RunStep> Stopped(SqlConnection connection) =>
            [
                new("Wait for the lock", async context =>
                {
                    await using var command = new SqlCommand(readHeld, connection) { CommandTimeout = 0 };
                    await ActionService.ReadAllAsync(command, context.Token);
                }),
                new("Clean up", async context =>
                {
                    await using var command = new SqlCommand("WAITFOR DELAY '00:00:02'; SELECT N'cleaned';", connection) { CommandTimeout = 0 };
                    if ((await ActionService.ReadAllAsync(command, context.Token)) is ["cleaned"]) Interlocked.Exchange(ref cleaned, 1);
                }, StepKind.Cleanup)
            ];
            var drainedMs = -1L;
            var cleanedBeforeReturn = false;
            await Hold();
            try
            {
                var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                actions.Options.BeforeStep = (title, _) => { if (title == "Wait for the lock") started.TrySetResult(); return Task.CompletedTask; };
                var stopped = actions.ExecuteStepsAsync(longInfo.Id, Guid.NewGuid().ToString(), "delete", Stopped, null, CancellationToken.None);
                await started.Task.WaitAsync(Bound);
                await Task.Delay(500);
                longService.CancelAll();
                var watch = Stopwatch.StartNew();
                longService.DrainCommitted();
                drainedMs = watch.ElapsedMilliseconds;
                cleanedBeforeReturn = Volatile.Read(ref cleaned) == 1;
                try { await stopped.WaitAsync(Bound); } catch (RequestException) { }
            }
            finally
            {
                actions.Options.BeforeStep = null;
                await LetGo();
            }
            check(cleanedBeforeReturn && drainedMs is >= 1_500 and < 30_000,
                $"a closing backend stops a long action and waits for its cleanup step before it exits (CancelAll, then DrainCommitted): cleaned {cleanedBeforeReturn} after {drainedMs} ms");
        }
        finally { await longService.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(longInfo.Id), json), json); }
    }
}
