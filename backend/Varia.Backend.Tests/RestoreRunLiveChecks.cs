using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;

namespace Varia.Backend.Tests;

/// <summary>Live checks of Restore Database's run (D1f), after RestoreLiveChecks has made its scratch source's backups: the runner
/// leaves out a step that is not due; refusals before any statement (another database's backup without WITH REPLACE, a database
/// created since, sets that do not chain); a new database restored for real through actions.execute with its steps, progress and
/// final state; the cleanup's DROP refusing an online database; the tail-log backup's compensation when the first RESTORE is refused
/// (critic A11d); a restore in place with Close existing connections and a tail-log backup; and Stop mid-RESTORE, which removes a
/// database the restore created and leaves one it replaced RESTORING (critic A11a, A12, A25). Stop needs a RESTORE that is still
/// running when the cancel arrives: a 64 MB fill, grown once to 256 MB when the run finished first, else the check is inconclusive.</summary>
internal static class RestoreRunLiveChecks
{
    /// <summary>Runner v2's after-steps: one that finds it has nothing to do (StepNotDueException) is not listed, and the rest still run.</summary>
    public static async Task RunnerAsync(Action<bool, string> check, SqlService service, ConnectionInfo info)
    {
        IReadOnlyList<RunStep> Plan(SqlConnection connection) =>
        [
            new("Fail", async context =>
            {
                await using var command = new SqlCommand("THROW 50000, N'Failed on purpose.', 1;", connection) { CommandTimeout = 0 };
                await ActionService.ReadAllAsync(command, context.Token);
            }),
            new("Not due", _ => throw new StepNotDueException(), StepKind.Cleanup),
            new("Due", async context =>
            {
                await using var command = new SqlCommand("SELECT N'x';", connection) { CommandTimeout = 0 };
                await ActionService.ReadAllAsync(command, context.Token);
            }, StepKind.Cleanup)
        ];
        var result = await service.Actions.ExecuteStepsAsync(info.Id, Guid.NewGuid().ToString(), "restore", Plan, null, CancellationToken.None);
        check(result is { Error.Code: "SQL_ERROR", Steps: [{ Status: "failed", Title: "Fail" }, { Status: "done", Title: "Due", Compensates: true }] }
            && !result.Error.Message.Contains("Not due", StringComparison.Ordinal),
            "a cleanup step that finds it has nothing to do is neither listed nor reported, and the steps after it still run: " + string.Join(", ", result.Steps.Select(step => step.Title + " " + step.Status)));
    }

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, Func<string, string, Task<SqlRun>> sql,
        ScratchDatabase scratch, IReadOnlyList<BackupSetDto> sets, IReadOnlyList<RestoreMoveDto> relocated)
    {
        var restore = ActionsCatalog.Current.Restore;
        var db = scratch.RestoreSource;
        var target = scratch.RestoreTarget;
        static string Q(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
        RestorePlanSetDto Planned(string name, string? type = null) => sets.FirstOrDefault(set => set.Name == name) is { } set
            ? new(set.Id, [.. set.Devices], set.Position, type ?? set.Type, set.Name) : throw new InvalidOperationException("No set " + name);
        var last = new List<RestorePlanSetDto> { Planned("full"), Planned("diff"), Planned("log3") };
        RestoreOptionsDto Options(List<RestorePlanSetDto> chain, IReadOnlyList<RestoreMoveDto>? moves = null, bool replace = false, bool close = false, RestoreTailLogDto? tail = null, string recovery = "recovery") =>
            new(chain, [.. moves ?? []], replace, false, false, recovery, close, TailLog: tail);
        async Task<DatabaseIdentityDto?> Identity(string name)
        {
            var described = (ActionDescribeResult)await service.DispatchAsync("actions.describe", JsonSerializer.SerializeToElement(
                new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "restoreDatabase", new ObjectRefDto("server"), null, new RestoreSourceDto("history")), json), json);
            return described.Restore?.Server?.Destinations.FirstOrDefault(destination => destination.Name == name) is { } found ? new(found.Id, found.Created) : null;
        }
        ActionArgs Args(string name, RestoreOptionsDto options, DatabaseIdentityDto? identity) =>
            new("restore", info.Id, Guid.NewGuid().ToString(), new ObjectRefDto("database", Name: name), Identity: identity, Restore: options);
        async Task<ActionExecuteResult> Wire(string name, RestoreOptionsDto options, DatabaseIdentityDto? identity) =>
            (ActionExecuteResult)await service.DispatchAsync("actions.execute", JsonSerializer.SerializeToElement(Args(name, options, identity), json), json);
        async Task<string?> State(string name) => (await sql("SELECT CONVERT(nvarchar(20), state) + N'/' + CONVERT(nvarchar(20), user_access) FROM sys.databases WHERE name = " + Q(name) + ";", "master")).Scalar;
        async Task<string?> Rows(string name) => (await sql("SELECT CONVERT(nvarchar(20), COUNT(*)) FROM dbo.t;", name)).Scalar;
        static string Show(ActionExecuteResult result) => (result.Error is { } error ? error.Code + " " + error.Message + " | " : "")
            + string.Join(", ", result.Steps.Select(step => step.Title + " " + step.Status + (step.Compensates == true ? " (c)" : ""))) + (result.Restored is { } now ? " | " + now.State + "/" + now.UserAccess : "");
        scratch.Adopt(target);

        // A new database through the wire: its steps in order, done, with their files as details, the progress the long action
        // sends, and the database online with the backup's rows.
        var progress = new ConcurrentQueue<(int Step, int Percent)>();
        void Event(object value)
        {
            var element = JsonSerializer.SerializeToElement(value, json);
            if (element.GetProperty("type").GetString() == "action.progress") progress.Enqueue((element.GetProperty("step").GetInt32(), element.GetProperty("percent").GetInt32()));
        }
        var created = await service.Actions.ExecuteAsync(Args(target, Options(last, relocated), null), CancellationToken.None, Event);
        var seen = progress.ToArray();
        check(created is { Error: null, Restored: { State: 0, UserAccess: 0 } } && created.Steps.Select(step => (step.Status, step.Title)).SequenceEqual(
                [("done", restore.Step("full")), ("done", restore.Step("differential")), ("done", restore.Step("log"))])
            && created.Steps[0].Detail is { } detail && detail.EndsWith(", position 1", StringComparison.Ordinal) && detail.Contains("(+1 files)", StringComparison.Ordinal)
            && seen.Where(item => item.Percent == 0).Select(item => item.Step).SequenceEqual([0, 1, 2]) && seen.Any(item => item.Percent > 0) && created.Steps.All(step => step.Progress == 100)
            && await Rows(target) == "5" && await State(target) == "0/0",
            "a restore to a new database runs its full, differential and log backups as the reply's steps, sends each step's start and its STATS percents, and leaves the database online "
            + "with the backup's rows: " + Show(created) + " | " + string.Join(" ", seen.Select(item => item.Step + ":" + item.Percent)));

        // Refusals before any statement: a database created since the server was read; another database's backup over it without
        // WITH REPLACE (SQL Server's 3154, checked first); sets that do not chain. Nothing runs, so the reply lists no step.
        var targetIdentity = await Identity(target);
        var sinceRead = await Wire(target, Options(last, relocated), null);
        var mismatch = await Wire(target, Options(last, relocated), targetIdentity);
        var stale = await Wire(target, Options(last, relocated, replace: true), targetIdentity! with { Id = targetIdentity.Id + 100_000 });
        var notKind = await Wire(target, Options([Planned("full"), Planned("log1", "differential")], relocated, replace: true), targetIdentity);
        var gap = await Wire(target, Options([Planned("full"), Planned("log3")], relocated, replace: true), targetIdentity);
        check(sinceRead is { Error.Code: "NAME_IN_USE", Steps: [] } && mismatch is { Error.Code: "BACKUP_MISMATCH", Steps: [] } && stale is { Error.Code: "NOT_FOUND", Steps: [] }
            && notKind is { Error.Code: "RESTORE_SEQUENCE", Steps: [] } && gap is { Error.Code: "RESTORE_SEQUENCE", Steps: [] } && await State(target) == "0/0" && await Rows(target) == "5",
            "the run refuses before any statement a database created since the read, another database's backup without WITH REPLACE, a database that is not the one read, "
            + "and sets the media say are of another kind or do not chain: " + string.Join(" | ", new[] { sinceRead, mismatch, stale, notKind, gap }.Select(Show)));

        // The cleanup's DROP checks the database itself: an online database (here one this check just restored) is never dropped.
        var id = (await sql("SELECT CONVERT(nvarchar(20), DB_ID(" + Q(target) + "));", "master")).Scalar;
        var guarded = await service.Actions.ExecutePlanAsync(info.Id, Guid.NewGuid().ToString(), "restore", [ActionSql.DropRestoring(target, int.Parse(id!, System.Globalization.CultureInfo.InvariantCulture), StepKind.Main)],
            CancellationToken.None);
        check(guarded is { Steps: [{ Status: "failed" } refused] } && refused.Message is { } why && why.Contains(ActionSql.NotRestoring[2..^1], StringComparison.Ordinal) && await State(target) == "0/0",
            "the cleanup's DROP refuses a database that is not RESTORING, so an online one stays: " + Show(guarded));

        // The tail-log backup's compensation (critic A11d): Close existing connections and a tail-log backup WITH NORECOVERY, then a
        // RESTORE SQL Server refuses before it writes (a folder that does not exist): Varia brings the database back online and back
        // to multi-user access, and nothing else changed.
        var sourceRows = await Rows(db);
        var nowhere = new List<RestoreMoveDto> { new(db, relocated[0].Physical[..(relocated[0].Physical.LastIndexOfAny(['\\', '/']) + 1)] + "VariaMissing_" + Guid.NewGuid().ToString("N") + relocated[0].Physical[relocated[0].Physical.LastIndexOfAny(['\\', '/'])] + "x.mdf") };
        var compensated = await Wire(db, Options(last, nowhere, close: true, tail: new(scratch.RestoreFile("tail1.bak"), true)), await Identity(db));
        check(compensated is { Error: { } error, Restored: { State: 0, UserAccess: 0 } } && error.Code != "CANCELLED"
            && compensated.Steps.Select(step => (step.Status, step.Title, step.Compensates)).SequenceEqual([("done", restore.Step("close"), (bool?)null), ("done", restore.Step("tailLog"), null),
                ("failed", restore.Step("full"), null), ("skipped", restore.Step("differential"), null), ("skipped", restore.Step("log"), null), ("skipped", restore.Step("multiUser"), null),
                ("done", restore.Step("recover"), true), ("done", restore.Step("multiUserBack"), true)])
            && await State(db) == "0/0" && await Rows(db) == sourceRows,
            "a RESTORE refused before it writes, after a tail-log backup WITH NORECOVERY and Close existing connections, brings the database back online and multi-user: " + Show(compensated));

        // In place with Close existing connections and a tail-log backup: the steps Script shows, and the database online with the last backup's rows.
        var inPlace = await Wire(db, Options(last, close: true, tail: new(scratch.RestoreFile("tail2.bak"), true)), await Identity(db));
        check(inPlace is { Error: null, Restored: { State: 0, UserAccess: 0 } } && inPlace.Steps.Select(step => step.Title).SequenceEqual([restore.Step("close"), restore.Step("tailLog"), restore.Step("full"),
                restore.Step("differential"), restore.Step("log"), restore.Step("multiUser")]) && inPlace.Steps.All(step => step.Status == "done") && await Rows(db) == "5" && await State(db) == "0/0",
            "a restore over the database it was taken from closes its connections, backs up the tail of its log, restores and gives it back multi-user: " + Show(inPlace));

        // Stop mid-RESTORE (critic A25): a copy-only full of a filled source restored as a new database is removed; over the database
        // this check restored above, WITH REPLACE, it is left RESTORING (owner decision 5: Varia never drops a database that existed).
        var big = scratch.RestoreFile("big.bak");
        var fill = await sql("CREATE TABLE dbo.fill (v char(8000) NOT NULL);", db);
        if (fill.Status != "completed") throw new InvalidOperationException("Restore fill setup failed: " + fill.Error);
        async Task Fill(int megabytes)
        {
            var ran = await sql("INSERT dbo.fill SELECT TOP (" + (megabytes * 128).ToString(System.Globalization.CultureInfo.InvariantCulture) + ") REPLICATE('x', 8000) FROM sys.all_columns AS a CROSS JOIN sys.all_columns AS b;", db);
            if (ran.Status != "completed") throw new InvalidOperationException("Restore fill failed: " + ran.Error);
            ran = await sql("BACKUP DATABASE [" + db + "] TO DISK = " + Q(big) + " WITH COPY_ONLY, FORMAT, INIT, NO_COMPRESSION, NAME = N'big';", "master");
            if (ran.Status != "completed") throw new InvalidOperationException("Restore fill backup failed: " + ran.Error);
        }
        RestorePlanSetDto Big() => new("1:1", [big], 1, "full", "big");
        async Task<(ActionExecuteResult Result, bool StoppedDuring)> Stop(string name, DatabaseIdentityDto? identity, bool replace)
        {
            using var stop = new CancellationTokenSource();
            var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            void Watch(object value)
            {
                var element = JsonSerializer.SerializeToElement(value, json);
                if (element.GetProperty("type").GetString() == "action.progress" && element.GetProperty("percent").GetInt32() > 0) started.TrySetResult();
            }
            var run = service.Actions.ExecuteAsync(Args(name, Options([Big()], relocated, replace: replace), identity), stop.Token, Watch);
            await Task.WhenAny(started.Task, run);
            var during = started.Task.IsCompleted && !run.IsCompleted;
            stop.Cancel();
            return (await run, during);
        }
        await sql("DROP DATABASE [" + target + "];", "master");
        await Fill(64);
        // A RESTORE that finished before the cancel reached SQL Server leaves the database online, and the reply says so.
        bool Finished(ActionExecuteResult result) => result.Error is null || result.Restored is { State: 0 };
        void FinishedSays(ActionExecuteResult result)
        {
            if (result.Error is { } error)
                check(error.Message == restore.Message("finishedAtStop").Replace("{database}", target, StringComparison.Ordinal),
                    "a Stop that reached SQL Server only as the restore finished says the database is restored and online: " + Show(result));
        }
        var (fresh, freshDuring) = await Stop(target, null, replace: false);
        if (Finished(fresh) || !freshDuring)
        {
            // The RESTORE finished before the cancel reached it: once more with four times the data.
            FinishedSays(fresh);
            await sql("IF DB_ID(" + Q(target) + ") IS NOT NULL DROP DATABASE [" + target + "];", "master");
            await Fill(192);
            (fresh, freshDuring) = await Stop(target, null, replace: false);
        }
        if (Finished(fresh) || !freshDuring)
        {
            FinishedSays(fresh);
            Console.WriteLine("Restore Database's Stop checks inconclusive: the 256 MB restore finished before Stop reached it.");
            await sql("IF DB_ID(" + Q(target) + ") IS NOT NULL DROP DATABASE [" + target + "];", "master");
            return;
        }
        check(fresh is { Error.Code: "CANCELLED", Restored: null } && fresh.Steps.Select(step => (step.Status, step.Title, step.Compensates)).SequenceEqual([("cancelled", restore.Step("full"), (bool?)null),
                ("done", restore.Step("remove"), true)]) && await State(target) is null,
            "Stop mid-RESTORE of a new database cancels the RESTORE and removes the partly restored database: " + Show(fresh));

        var replaced = await Wire(target, Options(last, relocated), null);
        if (replaced.Error is not null) throw new InvalidOperationException("Restore setup failed: " + Show(replaced));
        var (over, overDuring) = await Stop(target, await Identity(target), replace: true);
        if (Finished(over) || !overDuring) { FinishedSays(over); Console.WriteLine("Restore Database's Stop over an existing database inconclusive: the restore finished before Stop reached it."); }
        else check(over is { Error.Code: "CANCELLED", Restored: { State: 1 } } && over.Steps is [{ Status: "cancelled" }] && await State(target) is { } left && left.StartsWith("1/", StringComparison.Ordinal),
            "Stop mid-RESTORE WITH REPLACE over a database that existed leaves it RESTORING and never drops it, and the reply says so: " + Show(over));
        await sql("IF DB_ID(" + Q(target) + ") IS NOT NULL DROP DATABASE [" + target + "];", "master");
    }
}
