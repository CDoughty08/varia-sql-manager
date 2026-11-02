using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;

namespace Varia.Backend.Tests;

/// <summary>Live checks of Restore Database's run (D1f), after RestoreLiveChecks has made its scratch source's backups: the runner
/// leaves out a step that is not due; refusals before any statement (another database's backup without WITH REPLACE, a database
/// created since, sets that do not chain); a new database restored for real through actions.execute with its steps, progress and
/// final state; the cleanup's DROP refusing an online database; the tail-log backup's compensation when the first RESTORE is refused,
/// or when Stop reached the BACKUP LOG only as it finished, and neither RECOVERY nor multi-user access once a RESTORE wrote (critic
/// A11d); Close existing connections refused over a RESTORING database, which restores again without it; a Stop before the RESTORE was
/// sent never reported as one that came as it finished; files the restore would overwrite that are not the destination's refused,
/// however spelled; a restore in place with Close existing connections and a tail-log backup; and Stop mid-RESTORE, which removes a
/// database the restore created, naming the files SQL Server left, and leaves one it replaced RESTORING (critic A11a, A12, A25). Stop
/// goes out on the first STATS message and needs a RESTORE still running then: a 64 MB fill, grown once to 256 MB when the run
/// finished first, else the check is inconclusive.</summary>
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
            + string.Join(", ", result.Steps.Select(step => step.Title + " " + step.Status + (step.Compensates == true ? " (c)" : "") + (step.Message is { } note ? " [" + note + "]" : "")))
            + (result.Restored is { Absent: true } gone ? " | absent" + (gone.FilesLeft is { } kept ? ", left " + string.Join(", ", kept) : "") : result.Restored is { } now ? " | " + now.State + "/" + now.UserAccess : "");
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

        // Once a RESTORE has written to the database, Varia gives back neither RECOVERY nor multi-user access (owner decision 5, critic
        // A11d): stopped before the differential, the full backup restored WITH NORECOVERY over the database leaves it RESTORING.
        static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title + (step.Compensates == true ? "*" : "")));
        string Listed(params (string Status, string Key)[] steps) => string.Join(", ", steps.Select(step => step.Status + ":" + (step.Key.StartsWith('*') ? restore.Step(step.Key[1..]) + "*" : restore.Step(step.Key))));
        RestoreOptionsDto Tailed(List<RestorePlanSetDto> chain, string file, bool close = true) => Options(chain, close: close, tail: new(scratch.RestoreFile(file), true));
        // Runs the restore with a hook before (or after) the step titled so; Stop there stands for one that came between statements
        // (or, after, one that reached SQL Server only as the statement finished).
        async Task<ActionExecuteResult?> Hooked(string name, RestoreOptionsDto options, string title, Func<CancellationTokenSource, CancellationToken, Task>? hook = null, bool after = false)
        {
            using var stop = new CancellationTokenSource();
            async Task Run(string step, CancellationToken token)
            {
                if (step != title) return;
                if (hook is not null) { await hook(stop, token); return; }
                await stop.CancelAsync();
                token.ThrowIfCancellationRequested();
            }
            if (after) service.Actions.Options.AfterStep = Run; else service.Actions.Options.BeforeStep = Run;
            try { return await service.Actions.ExecuteAsync(Args(name, options, await Identity(name)), stop.Token, null); }
            catch (OperationCanceledException) { return null; }
            finally { service.Actions.Options.AfterStep = null; service.Actions.Options.BeforeStep = null; }
        }
        string Show2(ActionExecuteResult? result) => result is null ? "no reply (an unknown outcome)" : Show(result);
        var between = await Hooked(db, Tailed(last, "tail3.bak"), restore.Step("differential"));
        check(between is { Error.Code: "CANCELLED", Restored: { State: 1 } } && Steps(between) == Listed(("done", "close"), ("done", "tailLog"), ("done", "full"), ("cancelled", "differential"), ("skipped", "log"), ("skipped", "multiUser"))
            && await State(db) is { } restoring && restoring.StartsWith("1/", StringComparison.Ordinal),
            "a Stop after the first RESTORE wrote over the database leaves it RESTORING: no RECOVERY and no multi-user access are given back: " + Show2(between));

        // Restore again over that RESTORING database: Close existing connections is refused before anything (SET SINGLE_USER fails with
        // 5069 on a database that is not online, which has no connections anyway), and without it the restore runs.
        var closing = await Wire(db, Options(last, close: true), await Identity(db));
        var again = await Wire(db, Options(last), await Identity(db));
        check(closing is { Error.Code: "DATABASE_UNAVAILABLE", Steps: [] } && again is { Error: null, Restored: { State: 0, UserAccess: 0 } } && await Rows(db) == "5",
            "over a RESTORING database Close existing connections is refused before any statement, and Restore again without it restores the database: " + Show(closing) + " | " + Show(again));

        // A later RESTORE that SQL Server refuses before it writes (4305: this test's own session restored the full backup again, so
        // the run's log is too recent for it) after one that wrote: the database stays RESTORING, and the tail-log backup's RECOVERY
        // is not run. (A log restored twice is no refusal: SQL Server answers 4326 and, WITH RECOVERY, recovers the database.)
        static string From(RestorePlanSetDto set) => "FROM " + string.Join(", ", set.Devices.Select(device => "DISK = " + Q(device))) + " WITH FILE = " + set.File.ToString(System.Globalization.CultureInfo.InvariantCulture);
        async Task Setup(string text, string what) { var ran = await sql(text, "master"); if (ran.Status != "completed") throw new InvalidOperationException(what + " setup failed: " + ran.Error); }
        var refusedLater = await Hooked(db, Tailed(last, "tail4.bak", close: false), restore.Step("log"),
            (_, _) => Setup("RESTORE DATABASE [" + db + "] " + From(Planned("full")) + ", NORECOVERY, REPLACE;", "Restore full"));
        check(refusedLater is { Error.Code: "RESTORE_SEQUENCE", Restored: { State: 1 } } && Steps(refusedLater) == Listed(("done", "tailLog"), ("done", "full"), ("done", "differential"), ("failed", "log"))
            && await State(db) is { } stillRestoring && stillRestoring.StartsWith("1/", StringComparison.Ordinal),
            "a RESTORE refused before it writes, after another RESTORE wrote, leaves the database RESTORING without the tail-log backup's RECOVERY: " + Show2(refusedLater));
        await Setup("RESTORE DATABASE [" + db + "] " + From(Planned("diff")) + ", NORECOVERY;", "Restore differential");
        await Setup("RESTORE LOG [" + db + "] " + From(Planned("log3")) + ", RECOVERY;", "Restore log");
        if (await Rows(db) != "5") throw new InvalidOperationException("Restore recovery setup failed.");

        // A Stop that reaches the tail-log BACKUP LOG only as it finishes marks it cancelled, but the database is RESTORING and no RESTORE
        // started: RECOVERY brings it back online as it was, then multi-user access.
        var tailRace = await Hooked(db, Tailed(last, "tail5.bak"), restore.Step("tailLog"), after: true);
        check(tailRace is { Error.Code: "CANCELLED", Restored: { State: 0, UserAccess: 0 } } && Steps(tailRace) == Listed(("done", "close"), ("cancelled", "tailLog"), ("skipped", "full"), ("skipped", "differential"),
                ("skipped", "log"), ("skipped", "multiUser"), ("done", "*recover"), ("done", "*multiUserBack")) && await State(db) == "0/0" && await Rows(db) == "5",
            "a tail-log backup Stop reached only as it finished still has RECOVERY bring the database back online, then multi-user access: " + Show2(tailRace));

        // A Stop before the last RESTORE was sent, over an online database: it is online because nothing restored it, so the reply says
        // it was stopped, never that the restore finished.
        // Its Stop also returns at once though a callback on the job's token blocks, as SqlClient's does while a RESTORE sends STATS:
        // the canceller is the backend's frame loop, which must keep reading frames (ActionService runs the job's callbacks off it).
        var cancelMs = long.MaxValue;
        var early = await Hooked(db, Options([Planned("full")], close: true), restore.Step("full"), (stop, token) =>
        {
            using var held = new ManualResetEventSlim();
            using var blocking = token.Register(() => held.Wait(TimeSpan.FromSeconds(10)));
            var clock = System.Diagnostics.Stopwatch.StartNew();
            stop.Cancel();
            cancelMs = clock.ElapsedMilliseconds;
            held.Set();
            token.WaitHandle.WaitOne(TimeSpan.FromSeconds(10));
            token.ThrowIfCancellationRequested();
            return Task.CompletedTask;
        });
        check(cancelMs < 2000, "a Stop returns to its canceller at once, though a callback on the job's token blocks (SqlClient's, while a RESTORE sends STATS): " + cancelMs + " ms");
        check(early is { Error: { Code: "CANCELLED" } stopped, Restored: { State: 0, UserAccess: 0 } } && stopped.Message != restore.Message("finishedAtStop").Replace("{database}", db, StringComparison.Ordinal)
            && Steps(early) == Listed(("done", "close"), ("cancelled", "full"), ("skipped", "multiUser"), ("done", "*multiUserBack")) && await Rows(db) == "5",
            "a Stop before the RESTORE was sent says the restore was stopped, not that it finished, though the database is online: " + Show2(early));

        // In place with Close existing connections and a tail-log backup: the steps Script shows, and the database online with the last backup's rows.
        var inPlace = await Wire(db, Options(last, close: true, tail: new(scratch.RestoreFile("tail2.bak"), true)), await Identity(db));
        check(inPlace is { Error: null, Restored: { State: 0, UserAccess: 0 } } && inPlace.Steps.Select(step => step.Title).SequenceEqual([restore.Step("close"), restore.Step("tailLog"), restore.Step("full"),
                restore.Step("differential"), restore.Step("log"), restore.Step("multiUser")]) && inPlace.Steps.All(step => step.Status == "done") && await Rows(db) == "5" && await State(db) == "0/0",
            "a restore over the database it was taken from closes its connections, backs up the tail of its log, restores and gives it back multi-user: " + Show(inPlace));

        await sql("DROP DATABASE [" + target + "];", "master");
        var fileViews = (await sql("SELECT CONVERT(nvarchar(10), COUNT(*)) FROM sys.system_objects WHERE name = N'dm_os_file_exists';", "master")).Scalar == "1";
        async Task<bool> Exists(string path) => (await sql("SELECT CONVERT(nvarchar(10), file_exists) FROM sys.dm_os_file_exists(" + Q(path) + ");", "master")).Scalar == "1";

        // Files the restore would overwrite that are not the destination's, however spelled (WITH REPLACE, which SQL Server does not
        // check against an offline database's files): an offline database's files through a '.' segment and a doubled separator, its
        // .mdf as the standby file or the tail-log backup, and a file already on disk. Each is refused before any statement.
        var offline = scratch.Offline;
        scratch.Adopt(offline);
        var made = await sql("CREATE DATABASE [" + offline + "];", "master");
        if (made.Status != "completed") throw new InvalidOperationException("Restore offline setup failed: " + made.Error);
        await sql("CREATE TABLE dbo.t (i int); INSERT dbo.t VALUES (1);", offline);
        var offFiles = (await sql("SELECT physical_name FROM sys.master_files WHERE database_id = DB_ID(" + Q(offline) + ") ORDER BY file_id;", "master")).Sets[0].Select(row => row[0]!).ToList();
        await sql("ALTER DATABASE [" + offline + "] SET OFFLINE WITH ROLLBACK IMMEDIATE;", "master");
        static string Spelled(string path, string insert)
        {
            var at = path.LastIndexOfAny(['\\', '/']);
            return path[..(at + 1)] + insert + path[(at + 1)..];
        }
        var separator = offFiles[0][offFiles[0].LastIndexOfAny(['\\', '/'])].ToString();
        var dotted = await Wire(target, Options(last, [new(db, Spelled(offFiles[0], "." + separator)), relocated[1]], replace: true), null);
        var doubled = await Wire(target, Options(last, [relocated[0], new(db + "_log", Spelled(offFiles[1], separator))], replace: true), null);
        var standby = await Wire(target, new(last, [.. relocated], true, false, false, "standby", false, StandbyFile: offFiles[0]), null);
        var tailOver = await Wire(db, Options(last, tail: new(offFiles[1], true)), await Identity(db));
        var onDisk = await Wire(target, Options(last, [new(db, scratch.RestoreFile("full2.bak")), relocated[1]], replace: true), null);
        await sql("ALTER DATABASE [" + offline + "] SET ONLINE;", "master");
        check(dotted is { Error.Code: "NAME_IN_USE", Steps: [] } && doubled is { Error.Code: "NAME_IN_USE", Steps: [] } && standby is { Error.Code: "NAME_IN_USE", Steps: [] } && tailOver is { Error.Code: "NAME_IN_USE", Steps: [] }
            && (!fileViews || onDisk is { Error.Code: "NAME_IN_USE", Steps: [] }) && await State(target) is null && (await sql("SELECT CONVERT(nvarchar(10), COUNT(*)) FROM dbo.t;", offline)).Scalar == "1",
            "a Restore As path to an offline database's file however spelled, its file as the standby file or the tail-log backup, and a file already on disk are refused before any statement: "
            + string.Join(" | ", new[] { dotted, doubled, standby, tailOver, onDisk }.Select(Show)));

        // Stop mid-RESTORE (critic A25): a copy-only full of a filled source restored as a new database is removed; over the database
        // this check restored above, WITH REPLACE, it is left RESTORING (owner decision 5: Varia never drops a database that existed).
        // The test's Stop goes out on the first STATS message (3211): EVENTs are sent as they come for this check, not once per interval.
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
        // What the run's EVENTs said, for the messages: each percent with its time, and when the Stop's canceller returned.
        var stopSeen = new List<string>();
        // The Stop goes out from another thread, as main's CANCEL frame does. The first percent of the RESTORE that SQL Server sent
        // after the canceller returned is `After`: from then on the Stop must land at the next STATS message (ActionService's
        // StatementStop), so a Stop made known by 80 percent never lets the RESTORE run to 100.
        async Task<(ActionExecuteResult Result, bool StoppedDuring, int? After)> Stop(string name, DatabaseIdentityDto? identity, bool replace)
        {
            using var stop = new CancellationTokenSource();
            var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var clock = System.Diagnostics.Stopwatch.StartNew();
            var returned = 0;
            int? first = null, after = null;
            stopSeen.Clear();
            void Watch(object value)
            {
                var element = JsonSerializer.SerializeToElement(value, json);
                if (element.GetProperty("type").GetString() != "action.progress") return;
                var (step, percent) = (element.GetProperty("step").GetInt32(), element.GetProperty("percent").GetInt32());
                lock (stopSeen)
                {
                    stopSeen.Add(percent + "% at " + clock.ElapsedMilliseconds + " ms");
                    if (Volatile.Read(ref returned) == 1 && after is null && step == first && percent > 0) after = percent;
                }
                if (percent == 0 || !started.TrySetResult()) return;
                first = step;
                // Off the message's own thread, which holds the progress lock, as the frame loop is.
                _ = Task.Run(() => { stop.Cancel(); Volatile.Write(ref returned, 1); lock (stopSeen) stopSeen.Add("Stop returned at " + clock.ElapsedMilliseconds + " ms"); });
            }
            var run = service.Actions.ExecuteAsync(Args(name, Options([Big()], relocated, replace: replace), identity), stop.Token, Watch);
            await Task.WhenAny(started.Task, run);
            var during = started.Task.IsCompleted;
            var result = await run;
            lock (stopSeen) return (result, during && result.Error?.Code == "CANCELLED", after);
        }
        void Landed(ActionExecuteResult result, int? after, bool finished) =>
            check(after is not { } percent || percent > 80 || (!finished && result.Steps.FirstOrDefault(step => step.Status == "cancelled") is { Progress: < 100 }),
                "a Stop from another thread lands at the RESTORE's next STATS message, not when it ends: " + Show(result) + " | progress: " + string.Join(", ", stopSeen));
        var interval = service.Actions.Options.ProgressInterval;
        service.Actions.Options.ProgressInterval = TimeSpan.Zero;
        try
        {
            await Fill(64);
            // A RESTORE that finished before the cancel reached SQL Server leaves the database online, and only then does the reply say so.
            var finishedAtStop = restore.Message("finishedAtStop").Replace("{database}", target, StringComparison.Ordinal);
            bool Finished(ActionExecuteResult result) => result.Error is null || result.Error.Message == finishedAtStop;
            var (fresh, freshDuring, freshAfter) = await Stop(target, null, replace: false);
            Landed(fresh, freshAfter, Finished(fresh));
            if (Finished(fresh) || !freshDuring)
            {
                // The RESTORE finished before the cancel reached it: once more with four times the data.
                await sql("IF DB_ID(" + Q(target) + ") IS NOT NULL DROP DATABASE [" + target + "];", "master");
                await Fill(192);
                (fresh, freshDuring, freshAfter) = await Stop(target, null, replace: false);
                Landed(fresh, freshAfter, Finished(fresh));
            }
            if (Finished(fresh) || !freshDuring)
            {
                Console.WriteLine("Restore Database's Stop checks inconclusive: the 256 MB restore finished before Stop reached it (" + (freshDuring ? "stopped as it finished" : "no STATS message before it ended") + "): " + Show(fresh) + " | progress: " + string.Join(", ", stopSeen));
                return;
            }
            // SQL Server may leave a cancelled RESTORE's files on disk though the DROP removes the database: the reply names exactly those.
            var left = fresh.Restored?.FilesLeft ?? [];
            var onServer = new List<string>();
            if (fileViews) foreach (var move in relocated) if (await Exists(move.Physical)) onServer.Add(move.Physical);
            check(fresh is { Error.Code: "CANCELLED", Restored: { Absent: true, State: null } } && Steps(fresh) == Listed(("cancelled", "full"), ("done", "*remove")) && await State(target) is null
                && (!fileViews || (left.Order(StringComparer.Ordinal).SequenceEqual(onServer.Order(StringComparer.Ordinal)) && fresh.Restored.FilesUnknown is null))
                && (left.Count == 0 ? fresh.Steps[1].Message is null : fresh.Steps[1].Message == ActionService.LeftoversNote(left, false) && fresh.Error.Message.EndsWith(ActionService.LeftoversNote(left, false), StringComparison.Ordinal)),
                "Stop mid-RESTORE of a new database cancels the RESTORE, removes the partly restored database and names the files SQL Server left on disk: " + Show(fresh) + " | on disk: " + string.Join(", ", onServer));

            if (left.Count > 0)
            {
                // A restore to those paths again is refused (SQL Server's 3142 without WITH REPLACE; Varia's own check with it), so
                // this check restores over them itself, then the database can be replaced through the run.
                var blocked = await Wire(target, Options(last, relocated, replace: true), null);
                check(blocked is { Error.Code: "NAME_IN_USE", Steps: [] }, "a restore to the files a stopped restore left is refused before any statement: " + Show(blocked));
                var over = await sql(string.Join("\n", RestoreSql.Statements(restore, target, Options(last, relocated, replace: true), exists: false)), "master");
                if (over.Status != "completed") throw new InvalidOperationException("Restore leftover setup failed: " + over.Error);
            }
            else
            {
                var replaced = await Wire(target, Options(last, relocated), null);
                if (replaced.Error is not null) throw new InvalidOperationException("Restore setup failed: " + Show(replaced));
            }
            var (stoppedOver, overDuring, overAfter) = await Stop(target, await Identity(target), replace: true);
            Landed(stoppedOver, overAfter, Finished(stoppedOver));
            if (Finished(stoppedOver) || !overDuring) Console.WriteLine("Restore Database's Stop over an existing database inconclusive: the restore finished before Stop reached it.");
            else check(stoppedOver is { Error.Code: "CANCELLED", Restored: { State: 1 } } && stoppedOver.Steps is [{ Status: "cancelled" }] && await State(target) is { } leftState && leftState.StartsWith("1/", StringComparison.Ordinal),
                "Stop mid-RESTORE WITH REPLACE over a database that existed leaves it RESTORING and never drops it, and the reply says so: " + Show(stoppedOver));
        }
        finally
        {
            service.Actions.Options.ProgressInterval = interval;
            // A database a stopped RESTORE left RESTORING may keep its files on disk when dropped: restored over first, it drops with them.
            if (await State(target) is { } state && !state.StartsWith("0/", StringComparison.Ordinal))
                await sql(string.Join("\n", RestoreSql.Statements(restore, target, Options(last, relocated, replace: true), exists: true)), "master");
            await sql("IF DB_ID(" + Q(target) + ") IS NOT NULL DROP DATABASE [" + target + "];", "master");
        }
    }
}
