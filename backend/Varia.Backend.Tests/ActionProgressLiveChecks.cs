using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;

namespace Varia.Backend.Tests;

/// <summary>Live checks of D1c, with VARIA_TEST_SQL_SCRATCH=1 in a marked VariaScratch_…_ap database. A long action's step runs a
/// BACKUP DATABASE … WITH STATS = 5 and then reads a table another session holds locked; that session lets go only once two
/// rising action.progress EVENTs arrived. So the EVENTs must arrive while the step still runs: an action statement run through
/// ExecuteNonQueryAsync, whose info messages SqlClient holds until the statement ends, waits out the bound and fails (D1 risk:
/// "a refactor back to ExecuteNonQueryAsync silently kills progress"). Then a long job stopped by a closing backend (CancelAll)
/// still runs its cleanup step before SqlService.DrainCommitted returns.</summary>
internal static class ActionProgressLiveChecks
{
    private static string Bracket(string name) => "[" + name.Replace("]", "]]", StringComparison.Ordinal) + "]";
    private static readonly TimeSpan Bound = TimeSpan.FromSeconds(60);

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
        var created = await Sql("CREATE TABLE dbo.Held (id int NOT NULL); INSERT dbo.Held (id) SELECT TOP (20000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) FROM sys.all_columns AS a CROSS JOIN sys.all_columns AS b;", db);
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
            var actions = longService.Actions;
            actions.Options.ProgressInterval = TimeSpan.Zero;
            var percents = new ConcurrentQueue<(int Step, int Percent)>();
            var rising = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            void Event(object value)
            {
                var element = JsonSerializer.SerializeToElement(value, json);
                if (element.GetProperty("type").GetString() != "action.progress") return;
                percents.Enqueue((element.GetProperty("step").GetInt32(), element.GetProperty("percent").GetInt32()));
                var seen = percents.ToArray();
                if (seen.Length >= 2 && seen[^1].Percent > seen[0].Percent) rising.TrySetResult();
            }
            IReadOnlyList<RunStep> Plan(SqlConnection connection) =>
            [
                new("Back up", async context =>
                {
                    await using var command = new SqlCommand(backup.DatabaseSql("COPY_ONLY, STATS = 5") + "\n" + readHeld, connection) { CommandTimeout = 0 };
                    await ActionService.ReadAllAsync(command, context.Token);
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
            finally
            {
                await LetGo();
                await backup.ForgetAsync((text, database) => Sql(text, database));
            }
            var seen = percents.ToArray();
            check(duringStep && seen.Length >= 2 && seen.All(item => item.Step == 0) && seen.Zip(seen.Skip(1)).All(pair => pair.Second.Percent >= pair.First.Percent)
                && result is { Error: null, Steps: [{ Status: "done", Title: "Back up", Progress: 100 }] }
                && !result.Messages.Any(message => message.Contains("percent processed", StringComparison.OrdinalIgnoreCase)),
                "a long step's BACKUP … STATS = 5 sends rising action.progress EVENTs while the step still runs (through a reader), the reply's step carries 100, "
                + "and its 3211 lines are not among the kept messages: " + string.Join(" ", seen.Select(item => item.Percent)) + " | " + result?.Error?.Message);

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
