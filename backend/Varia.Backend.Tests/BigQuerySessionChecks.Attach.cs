using System.Text.Json.Nodes;
using Varia.Backend.BigQuery;

namespace Varia.Backend.Tests;

/// <summary>
/// Re-attaching to BigQuery jobs offline (docs/bigquery.md, Re-attaching to jobs), on the scripted BigQuery: Leave it running
/// (query.cancel's detach, keepJob), Cancel the job (cancelJob), query.session.state's job, query.attach with every outcome,
/// the idle sessions Disconnect and bigquery.endIdleSessions end, the failed-abort retry and bigquery.cancelJobs.
/// </summary>
internal static partial class BigQuerySessionChecks
{
    static string JobOf(JsonNode body) => body["jobReference"]!["jobId"]!.GetValue<string>();

    /// <summary>Starts a held query in <paramref name="tab"/> and waits until BigQuery is polled for it.</summary>
    static async Task<(JsonObject Args, Task<(string Code, object? Result, string Message)> Run, string JobId)> HeldAsync(Harness harness, string tab, string sql = "SELECT slow")
    {
        var bq = harness.Bq;
        bq.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        bq.HoldQueries = true;
        var args = harness.Query(tab, sql, item => item["jobKey"] = Guid.NewGuid().ToString());
        var run = harness.Call("query.execute", args);
        await Task.WhenAny(bq.Polling.Task, run).WaitAsync(TimeSpan.FromSeconds(30));
        bq.HoldQueries = false;
        return (args, run, JobOf(bq.UserInserts.Last()));
    }

    static JsonObject AttachArgs(Harness harness, string tab, string jobId, Action<JsonObject>? change = null)
    {
        var args = new JsonObject
        {
            ["connectionId"] = harness.ConnectionId, ["sessionId"] = tab, ["queryId"] = Guid.NewGuid().ToString(), ["jobKey"] = Guid.NewGuid().ToString(),
            ["jobId"] = jobId, ["project"] = "varia-alpha", ["location"] = "US", ["maxRows"] = 0, ["maxResultSets"] = 10, ["adoptSession"] = true
        };
        change?.Invoke(args);
        return args;
    }

    /// <summary>Leave it running (query.cancel with detach, keepJob) and Cancel the job (cancelJob), and the state's job.</summary>
    static async Task DetachAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new Bq();
        using var harness = new Harness(bq);
        harness.BigQuery.CloseWaitLimit = TimeSpan.FromSeconds(5);
        await harness.ConnectAsync(key);
        bq.Statements["BEGIN TRANSACTION"] = "BEGIN_TRANSACTION";

        var tab = Tab();
        await harness.Execute(tab, "SELECT 1");
        var (args, run, jobId) = await HeldAsync(harness, tab);
        var detached = await harness.Call("query.cancel", new JsonObject { ["queryId"] = args["queryId"]!.GetValue<string>(), ["detach"] = true });
        var result = (await run.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        var held = await harness.State(tab);
        check(detached.Code == "ok" && result is { Status: "detached", Error: null } && !bq.Cancels.Contains(jobId) && held.State is { Job: "running", Checked: false }
            && Says(result, "keeps running in BigQuery and holds this tab's BigQuery session"),
            $"query.cancel with detach ends the request detached, leaves the job running and the state says the session holds it: {detached.Code} {result?.Status} {held.State} {Texts(result?.Messages ?? [])}");
        // A backend stop never cancels a BigQuery job: shutdown lets go of it before it cancels every request.
        using (var stopping = new Harness(new Bq()))
        {
            await stopping.ConnectAsync(key);
            var stopTab = Tab();
            await stopping.Execute(stopTab, "SELECT 1");
            var (_, stopRun, stopJob) = await HeldAsync(stopping, stopTab);
            stopping.Service.BeginShutdown();
            stopping.Service.CancelAll();
            await stopRun.WaitAsync(TimeSpan.FromSeconds(30));
            check(!stopping.Bq.Cancels.Contains(stopJob), $"a backend stop leaves a running BigQuery job running: cancels {string.Join(",", stopping.Bq.Cancels)}");
            stopping.Bq.Release(stopping.Bq.Jobs[stopJob]);
        }

        // An execution whose job is DONE but still being read holds nothing in BigQuery: Leave it running on it is a normal
        // close, refused with JOB_FINISHED while the job's transaction may be open, and a plain close then ends the session.
        using (var reading = new Harness(new Bq()))
        {
            await reading.ConnectAsync(key);
            reading.Bq.Statements["BEGIN TRANSACTION"] = "BEGIN_TRANSACTION";
            var readTab = Tab();
            await reading.Execute(readTab, "SELECT 1");
            var hung = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            reading.Bq.AlsoHang = request =>
            {
                if (request.Method != "GET" || !reading.Bq.Jobs.Values.Any(job => job.Sql == "BEGIN TRANSACTION" && request.Url.Contains("/jobs/" + job.Id, StringComparison.Ordinal))) return false;
                hung.TrySetResult();
                return true;
            };
            var begin = reading.Execute(readTab, "BEGIN TRANSACTION");
            await Task.WhenAny(hung.Task, begin).WaitAsync(TimeSpan.FromSeconds(30));
            var kept = await reading.Call("query.session.close", new JsonObject { ["sessionId"] = readTab, ["keepJob"] = true });
            reading.Bq.AlsoHang = null;
            await begin.WaitAsync(TimeSpan.FromSeconds(30));
            var ended = await reading.Close(readTab);
            check(hung.Task.IsCompleted && kept.Code == "JOB_FINISHED" && ended is { Code: "ok", Result.Closed: true } && reading.Bq.Aborts.Contains("sess-1"),
                $"Leave it running on an execution with no job running in BigQuery is not a detach: {kept.Code} {ended.Code} aborts {string.Join(",", reading.Bq.Aborts)}");

            // Nor does bigquery.endIdleSessions keep such a session: nothing of it is running in BigQuery.
            var idleTab = Tab();
            await reading.Execute(idleTab, "SELECT 1");
            var idleHung = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            reading.Bq.AlsoHang = request =>
            {
                if (request.Method != "GET" || !reading.Bq.Jobs.Values.Any(job => job.Sql == "SELECT read" && request.Url.Contains("/jobs/" + job.Id, StringComparison.Ordinal))) return false;
                idleHung.TrySetResult();
                return true;
            };
            reading.BigQuery.CallLimit = TimeSpan.FromMilliseconds(500);
            var readRun = reading.Execute(idleTab, "SELECT read");
            await Task.WhenAny(idleHung.Task, readRun).WaitAsync(TimeSpan.FromSeconds(30));
            var idleBefore = reading.Bq.Aborts.Count;
            var idleEnd = await reading.Call("bigquery.endIdleSessions", new JsonObject());
            reading.Bq.AlsoHang = null;
            try { await readRun.WaitAsync(TimeSpan.FromSeconds(30)); } catch (Exception) when (readRun.IsCompleted) { }
            check(idleHung.Task.IsCompleted && idleEnd.Code == "ok" && reading.Bq.Aborts.Count == idleBefore + 1,
                $"endIdleSessions ends a session whose execution only reads a finished job: {idleEnd.Code} aborts {reading.Bq.Aborts.Count - idleBefore}");
        }

        // A job refused at insert holds nothing, even while the error is still being explained (the dataset's location looked
        // up): Leave it running then asks about the transaction it left (JOB_FINISHED), never keeps the session for a job.
        using (var refusing = new Harness(new Bq()))
        {
            await refusing.ConnectAsync(key);
            refusing.Bq.Statements["BEGIN TRANSACTION"] = "BEGIN_TRANSACTION";
            refusing.Bq.Failures["SELECT elsewhere"] = Failure("notFound", "Not found: Dataset varia-alpha:sales was not found in location US");
            refusing.Bq.FailAtInsert.Add("SELECT elsewhere");
            var refuseTab = Tab();
            await refusing.Execute(refuseTab, "BEGIN TRANSACTION");
            var lookingUp = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            refusing.Bq.AlsoHang = request =>
            {
                if (request.Method != "GET" || !request.Url.Contains("/datasets/sales", StringComparison.Ordinal)) return false;
                lookingUp.TrySetResult();
                return true;
            };
            var refusedRun = refusing.Execute(refuseTab, "SELECT elsewhere");
            await Task.WhenAny(lookingUp.Task, refusedRun).WaitAsync(TimeSpan.FromSeconds(30));
            var refusedClose = await refusing.Call("query.session.close", new JsonObject { ["sessionId"] = refuseTab, ["keepJob"] = true });
            refusing.Bq.AlsoHang = null;
            try { await refusedRun.WaitAsync(TimeSpan.FromSeconds(30)); } catch (Exception) when (refusedRun.IsCompleted) { }
            check(lookingUp.Task.IsCompleted && refusedClose.Code == "JOB_FINISHED",
                $"Leave it running while a refused insert's error is explained asks about the transaction: {refusedClose.Code}");
            await refusing.Close(refuseTab, "rollback");
        }

        // Stop while a re-attach of the tab's own held job is still checking its identity cancels that job.
        using (var following = new Harness(new Bq()))
        {
            await following.ConnectAsync(key);
            var followTab = Tab();
            await following.Execute(followTab, "SELECT 1");
            var (fArgs, fRun, fJob) = await HeldAsync(following, followTab);
            await following.Call("query.cancel", new JsonObject { ["queryId"] = fArgs["queryId"]!.GetValue<string>(), ["detach"] = true });
            await fRun.WaitAsync(TimeSpan.FromSeconds(30));
            following.Bq.Jobs[fJob].Hold = true;
            var checking = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            following.Bq.AlsoHang = request =>
            {
                if (request.Method != "GET" || !request.Url.Contains("/jobs/" + fJob, StringComparison.Ordinal)) return false;
                checking.TrySetResult();
                return true;
            };
            var attachArgs = AttachArgs(following, followTab, fJob);
            var attachRun = following.Call("query.attach", attachArgs);
            await Task.WhenAny(checking.Task, attachRun).WaitAsync(TimeSpan.FromSeconds(30));
            await following.Call("query.cancel", new JsonObject { ["queryId"] = attachArgs["queryId"]!.GetValue<string>() });
            var stoppedAttach = (await attachRun.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
            check(checking.Task.IsCompleted && stoppedAttach is { Status: "cancelled" } && following.Bq.Cancels.Contains(fJob),
                $"Stop during a following attach's identity check cancels the held job: {stoppedAttach?.Status} cancels {string.Join(",", following.Bq.Cancels)}");
            following.Bq.AlsoHang = null;
            following.Bq.Release(following.Bq.Jobs[fJob]);
        }

        // Leave it running on an execution still waiting behind a held job (no job of its own yet) is a stop: nothing of its
        // own keeps running.
        using (var waiting = new Harness(new Bq()))
        {
            await waiting.ConnectAsync(key);
            var waitTab = Tab();
            await waiting.Execute(waitTab, "SELECT 1");
            var (heldArgs, heldRun, heldJob) = await HeldAsync(waiting, waitTab);
            await waiting.Call("query.cancel", new JsonObject { ["queryId"] = heldArgs["queryId"]!.GetValue<string>(), ["detach"] = true });
            await heldRun.WaitAsync(TimeSpan.FromSeconds(30));
            var behindArgs = waiting.Query(waitTab, "SELECT 2");
            var queued = waiting.Call("query.execute", behindArgs);
            await Poll(() => waiting.State(waitTab).Result.Code == "SESSION_BUSY");
            await waiting.Call("query.cancel", new JsonObject { ["queryId"] = behindArgs["queryId"]!.GetValue<string>(), ["detach"] = true });
            var stoppedEarly = (await queued.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
            check(stoppedEarly is { Status: "cancelled" } && !Says(stoppedEarly, "keeps running in BigQuery") && !waiting.Bq.Cancels.Contains(heldJob),
                $"a detach before the execution's own job exists stops it, and the held job is left alone: {stoppedEarly?.Status} {Texts(stoppedEarly?.Messages ?? [])}");
            waiting.Bq.Release(waiting.Bq.Jobs[heldJob]);
        }

        var keep = await harness.Call("query.session.close", new JsonObject { ["sessionId"] = tab, ["keepJob"] = true, ["cancelJob"] = true });
        var both = await harness.Call("query.session.close", new JsonObject { ["sessionId"] = tab, ["keepJob"] = true, ["transaction"] = "rollback" });
        check(keep.Code == "INVALID_PARAMS" && both.Code == "INVALID_PARAMS", $"a close is a job answer or a transaction answer, never both: {keep.Code} {both.Code}");
        bq.Release(bq.Jobs[jobId]);
        var settled = await Poll(() => harness.State(tab).Result.State is { Job: "none", Checked: true });
        check(settled, $"the background poll sees the detached job finish, and its statements settle the transaction: {harness.State(tab).Result.State}");

        // The next Execute waits for a detached job still running.
        var (args2, run2, job2) = await HeldAsync(harness, tab);
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = args2["queryId"]!.GetValue<string>(), ["detach"] = true });
        await run2.WaitAsync(TimeSpan.FromSeconds(30));
        var behind = harness.Execute(tab, "SELECT 1");
        await Task.Delay(100);
        check(!behind.IsCompleted, "the next Execute waits behind a detached job");
        bq.Release(bq.Jobs[job2]);
        var after = await behind.WaitAsync(TimeSpan.FromSeconds(30));
        check(after is { Code: "ok", Result.Status: "completed" } && Says(after.Result, "Waiting for BigQuery job"), $"it runs once the detached job is DONE: {after.Code} {after.Result?.Status}");

        // keepJob on a session holding a detached job: closed, the session not aborted.
        var (args3, run3, job3) = await HeldAsync(harness, tab);
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = args3["queryId"]!.GetValue<string>(), ["detach"] = true });
        await run3.WaitAsync(TimeSpan.FromSeconds(30));
        var aborts = bq.Aborts.Count;
        var left = await harness.Call("query.session.close", new JsonObject { ["sessionId"] = tab, ["keepJob"] = true });
        check(left is { Code: "ok", Result: SessionCloseResult { Closed: true, Note: null } } && bq.Aborts.Count == aborts && !bq.Cancels.Contains(job3) && !harness.BigQuery.OwnsSession(tab),
            $"Leave it running (keepJob) on a detached job closes without ABORT_SESSION or jobs.cancel: {left.Code} {left.Result} aborts {bq.Aborts.Count - aborts}");
        bq.Release(bq.Jobs[job3]);

        // cancelJob on a session holding a detached job: cancelled, waited for and the session aborted.
        var cancelTab = Tab();
        await harness.Execute(cancelTab, "SELECT 1");
        var (args4, run4, job4) = await HeldAsync(harness, cancelTab);
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = args4["queryId"]!.GetValue<string>(), ["detach"] = true });
        await run4.WaitAsync(TimeSpan.FromSeconds(30));
        var cancelled = await harness.Call("query.session.close", new JsonObject { ["sessionId"] = cancelTab, ["cancelJob"] = true });
        check(cancelled is { Code: "ok", Result: SessionCloseResult { Closed: true } } && bq.Cancels.Contains(job4) && bq.Aborts.Contains("sess-2"),
            $"Cancel the job (cancelJob) on a detached job cancels it and ends the session: {cancelled.Code} {cancelled.Result} {string.Join(",", bq.Aborts)}");

        // cancelJob while the execution runs: Stop, then the session's end.
        var runTab = Tab();
        await harness.Execute(runTab, "SELECT 1");
        var (_, run5, job5) = await HeldAsync(harness, runTab);
        var running = await harness.Call("query.session.close", new JsonObject { ["sessionId"] = runTab, ["cancelJob"] = true });
        var stopped = (await run5.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        check(running is { Code: "ok", Result: SessionCloseResult { Closed: true } } && stopped is { Status: "cancelled" } && bq.Cancels.Contains(job5) && bq.Aborts.Contains("sess-3"),
            $"Cancel the job while the query runs stops it and ends the session: {running.Code} {running.Result} {stopped?.Status}");

        // keepJob after the job finished with a transaction left open: JOB_FINISHED, the tab stays, and a rollback ends it.
        var openTab = Tab();
        await harness.Execute(openTab, "SELECT 1");
        await harness.Execute(openTab, "BEGIN TRANSACTION");
        var finished = await harness.Call("query.session.close", new JsonObject { ["sessionId"] = openTab, ["keepJob"] = true });
        var stays = harness.BigQuery.OwnsSession(openTab);
        var rolled = await harness.Close(openTab, "rollback");
        check(finished.Code == "JOB_FINISHED" && stays && rolled is { Code: "ok", Result.Closed: true },
            $"Leave it running on a finished job that left a transaction open is refused with JOB_FINISHED: {finished.Code} {stays} {rolled.Code}");
        // keepJob after the job finished with nothing open: a normal close that ends the session.
        var plainTab = Tab();
        await harness.Execute(plainTab, "SELECT 1");
        var plain = await harness.Call("query.session.close", new JsonObject { ["sessionId"] = plainTab, ["keepJob"] = true });
        check(plain is { Code: "ok", Result: SessionCloseResult { Closed: true } } && bq.Aborts.Contains("sess-5"), $"Leave it running on a finished job with nothing open ends the session: {plain.Code}");

        // A query not running has nothing to leave; job keys are checked.
        var none = await harness.Call("query.cancel", new JsonObject { ["queryId"] = Guid.NewGuid().ToString(), ["detach"] = true });
        var badKey = await harness.Execute(Tab(), "SELECT 1", item => item["jobKey"] = "not-a-key");
        check(none.Code == "ok" && badKey.Code == "INVALID_PARAMS", $"detach of no query answers not cancelled; a bad job key is refused: {none.Code} {badKey.Code}");
    }

    /// <summary>query.attach: a running job adopted with its session and recorded transaction, a finished one read, a script,
    /// superseded, a detached record, another principal's job, results gone, and backend stops never cancelling.</summary>
    static async Task AttachAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new Bq();
        bq.Statements["BEGIN TRANSACTION"] = "BEGIN_TRANSACTION";
        string jobId, tab = Tab();
        using (var first = new Harness(bq))
        {
            await first.ConnectAsync(key);
            await first.Execute(tab, "BEGIN TRANSACTION");
            (_, _, jobId) = await HeldAsync(first, tab);
        }
        check(!bq.Cancels.Contains(jobId) && bq.Aborts.IsEmpty, "stopping the backend cancels no job and ends no session");

        using var harness = new Harness(bq);
        await harness.ConnectAsync(key);
        // A poll held by the fake while the job ran is answered again once its call limit passes.
        harness.BigQuery.CallLimit = TimeSpan.FromMilliseconds(500);
        // A restored tab keeps its id, and re-attaches with the record's transaction (decision 54).
        var events = new System.Collections.Concurrent.ConcurrentQueue<string>();
        using var context = new Protocol.RequestContext(1, "query.attach", Protocol.RequestLane.Query, 0, sendEvent: (_, body, _) =>
            events.Enqueue(System.Text.Json.JsonSerializer.Serialize(body, body.GetType(), new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))));
        var attaching = harness.Call("query.attach", AttachArgs(harness, tab, jobId, args => args["transaction"] = "open"), context);
        await Poll(() => events.Any(item => item.Contains("\"query.job\"", StringComparison.Ordinal)));
        var busy = await harness.State(tab);
        bq.Release(bq.Jobs[jobId]);
        var attached = (await attaching.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        var state = await harness.State(tab);
        check(busy.Code == "SESSION_BUSY" && attached is { Status: "completed", ResultSets.Count: 1 } && Says(attached, "Re-attached to BigQuery job varia-alpha:US." + jobId)
            && Says(attached, "which is still running") && state.State is { TransactionCount: 1, Checked: true }
            && events.Any(item => item.Contains("\"state\":\"running\"", StringComparison.Ordinal) && item.Contains("\"transaction\":\"open\"", StringComparison.Ordinal)),
            $"a running job re-attaches, its results are read when it finishes, and the adopted session keeps the record's open transaction: {busy.Code} {attached?.Status} {state.State} {Texts(attached?.Messages ?? [])}");
        var commit = await harness.Close(tab, "commit");
        check(commit is { Code: "ok", Result.Closed: true } && bq.Commits.Any(body => SessionOf(body) == "sess-1") && bq.Aborts.Contains("sess-1"),
            $"the adopted session commits and ends with the tab: {commit.Code} {commit.Result}");

        // A finished job: its results are read from the result table, without adopting a session.
        var doneTab = Tab();
        await harness.Execute(doneTab, "SELECT 1");
        var doneJob = JobOf(bq.UserInserts.Last());
        var reader = Tab();
        var read = await harness.Call("query.attach", AttachArgs(harness, reader, doneJob, args => args["adoptSession"] = false));
        check(read.Result is QueryResult { Status: "completed", ResultSets.Count: 1 } done && Says(done, "which finished meanwhile") && !harness.BigQuery.OwnsSession(reader),
            $"a finished job's results are read again; without adoptSession the tab takes no session: {read.Code} {(read.Result as QueryResult)?.Status}");
        // A job already DONE is reported done at once, so main's record is dropped even when its results are gone.
        var goneTab = Tab();
        await harness.Execute(goneTab, "SELECT 1");
        var goneJob = JobOf(bq.UserInserts.Last());
        bq.ExpiredResults.Add(goneJob);
        var goneEvents = new System.Collections.Concurrent.ConcurrentQueue<string>();
        using (var goneContext = new Protocol.RequestContext(2, "query.attach", Protocol.RequestLane.Query, 0, sendEvent: (_, body, _) =>
            goneEvents.Enqueue(System.Text.Json.JsonSerializer.Serialize(body, body.GetType(), new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)))))
        {
            var gone = await harness.Call("query.attach", AttachArgs(harness, Tab(), goneJob, args => args["adoptSession"] = false), goneContext);
            var jobEvents = goneEvents.Where(item => item.Contains("\"query.job\"", StringComparison.Ordinal)).ToList();
            check(gone.Result is QueryResult { Error.Code: "REMOTE_EXPIRED" } && jobEvents.Count > 0 && jobEvents.All(item => item.Contains("\"state\":\"done\"", StringComparison.Ordinal)),
                $"a re-attached job that is already DONE is reported done, never running: {(gone.Result as QueryResult)?.Error?.Code} {string.Join(" ", jobEvents)}");
        }
        bq.ExpiredResults.Remove(goneJob);
        // A job refused at insert is DONE with its error: it is reported done, so main never keeps a record of it as running.
        bq.Failures["SELECT refused"] = Failure("invalidQuery", "Unrecognized name: refused");
        bq.FailAtInsert.Add("SELECT refused");
        var refusedEvents = new System.Collections.Concurrent.ConcurrentQueue<string>();
        using (var refusedContext = new Protocol.RequestContext(3, "query.execute", Protocol.RequestLane.Query, 0, sendEvent: (_, body, _) =>
            refusedEvents.Enqueue(System.Text.Json.JsonSerializer.Serialize(body, body.GetType(), new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)))))
        {
            var refusedRun = await harness.Call("query.execute", harness.Query(Tab(), "SELECT refused"), refusedContext);
            var jobEvents = refusedEvents.Where(item => item.Contains("\"query.job\"", StringComparison.Ordinal)).ToList();
            check(refusedRun.Result is QueryResult { Status: "failed" } && jobEvents.Count > 0 && jobEvents.All(item => item.Contains("\"state\":\"done\"", StringComparison.Ordinal)),
                $"a job refused at insert is reported done, never running: {(refusedRun.Result as QueryResult)?.Status} {string.Join(" ", jobEvents)}");
        }

        // A script: its children are listed again and read in statement order.
        bq.Scripts["SCRIPT two"] = [("SELECT", null), ("INSERT", null), ("SELECT", null)];
        var scriptTab = Tab();
        await harness.Execute(scriptTab, "SELECT 1");
        await harness.Execute(scriptTab, "SCRIPT two");
        var scriptJob = JobOf(bq.UserInserts.Last());
        var script = await harness.Call("query.attach", AttachArgs(harness, Tab(), scriptJob, args => args["adoptSession"] = false));
        check(script.Result is QueryResult { Status: "completed", ResultSets.Count: 2 } scripted && Says(scripted, "(2 rows affected)"),
            $"a script's children are read again on attach: {script.Code} {(script.Result as QueryResult)?.ResultSets.Count}");

        // Superseded: a second attach to the same job takes the first's over.
        var raceTab = Tab();
        await harness.Execute(raceTab, "SELECT 1");
        var (raceArgs, raceRun, raceJob) = await HeldAsync(harness, raceTab);
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = raceArgs["queryId"]!.GetValue<string>(), ["detach"] = true });
        await raceRun.WaitAsync(TimeSpan.FromSeconds(30));
        bq.Jobs[raceJob].Hold = true;
        bq.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var one = harness.Call("query.attach", AttachArgs(harness, Tab(), raceJob, args => args["adoptSession"] = false));
        await Task.WhenAny(bq.Polling.Task, one).WaitAsync(TimeSpan.FromSeconds(30));
        var two = harness.Call("query.attach", AttachArgs(harness, Tab(), raceJob, args => args["adoptSession"] = false));
        var firstAnswer = (await one.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        bq.Release(bq.Jobs[raceJob]);
        var secondAnswer = (await two.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        check(firstAnswer is { Status: "superseded" } && secondAnswer is { Status: "completed" } && !bq.Cancels.Contains(raceJob),
            $"a second attach supersedes the first, which leaves the job alone: {firstAnswer?.Status} {secondAnswer?.Status}");

        // A re-attach that follows a job in another tab's session (the tab has a session of its own) leaves that job running when
        // the tab closes, even with Leave it running: the job belongs to the other session.
        var holderTab = Tab();
        await harness.Execute(holderTab, "SELECT 1");
        var (holderArgs, holderRun, holderJob) = await HeldAsync(harness, holderTab);
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = holderArgs["queryId"]!.GetValue<string>(), ["detach"] = true });
        await holderRun.WaitAsync(TimeSpan.FromSeconds(30));
        bq.Jobs[holderJob].Hold = true;
        var foreignTab = Tab();
        await harness.Execute(foreignTab, "SELECT 1");
        bq.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var foreignRun = harness.Call("query.attach", AttachArgs(harness, foreignTab, holderJob));
        await Task.WhenAny(bq.Polling.Task, foreignRun).WaitAsync(TimeSpan.FromSeconds(30));
        var foreignClose = await harness.Call("query.session.close", new JsonObject { ["sessionId"] = foreignTab, ["keepJob"] = true });
        var foreignAnswer = (await foreignRun.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        check(bq.Polling.Task.IsCompleted && foreignClose.Code == "ok" && foreignAnswer is { Status: "detached" } && !bq.Cancels.Contains(holderJob) && !Says(foreignAnswer, "holds this tab"),
            $"closing a tab that follows another session's job leaves the job running: {foreignClose.Code} {foreignAnswer?.Status} cancels {string.Join(",", bq.Cancels)}");
        bq.Release(bq.Jobs[holderJob]);

        // Without bigquery.jobs.list (the Job User role): a re-attach to the tab's own held job needs no listing (this backend
        // inserted it), and one from another tab is PERMISSION_DENIED naming the permission, the job left running.
        var listTab = Tab();
        await harness.Execute(listTab, "SELECT 1");
        var (listArgs, listRun, listJob) = await HeldAsync(harness, listTab);
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = listArgs["queryId"]!.GetValue<string>(), ["detach"] = true });
        await listRun.WaitAsync(TimeSpan.FromSeconds(30));
        bq.Jobs[listJob].Hold = true;
        bq.ListDenied = true;
        var deniedAttach = (await harness.Call("query.attach", AttachArgs(harness, Tab(), listJob, args => args["adoptSession"] = false))).Result as QueryResult;
        bq.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var listAttach = harness.Call("query.attach", AttachArgs(harness, listTab, listJob));
        await Task.WhenAny(bq.Polling.Task, listAttach).WaitAsync(TimeSpan.FromSeconds(30));
        bq.Release(bq.Jobs[listJob]);
        var listAnswer = (await listAttach.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        bq.ListDenied = false;
        check(deniedAttach is { Status: "failed", Error.Code: "PERMISSION_DENIED" } && deniedAttach.Error.Message.Contains("bigquery.jobs.list", StringComparison.Ordinal)
            && listAnswer is { Status: "completed" } && !bq.Cancels.Contains(listJob),
            $"without jobs.list a tab re-attaches to its own held job, and another tab's re-attach names the permission: {deniedAttach?.Status} {deniedAttach?.Error?.Code} {listAnswer?.Status} {Texts(listAnswer?.Messages ?? [])}");

        // Without jobs.list, the tab's own job that the background poll settled meanwhile (no longer its held job) still
        // re-attaches: the session inserted it.
        var settledTab = Tab();
        await harness.Execute(settledTab, "SELECT 1");
        var (settledArgs, settledRun, settledJob) = await HeldAsync(harness, settledTab);
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = settledArgs["queryId"]!.GetValue<string>(), ["detach"] = true });
        await settledRun.WaitAsync(TimeSpan.FromSeconds(30));
        bq.Release(bq.Jobs[settledJob]);
        var settledFree = await Poll(() => harness.State(settledTab).Result.State is { Job: "none" });
        bq.ListDenied = true;
        var settledAttach = (await harness.Call("query.attach", AttachArgs(harness, settledTab, settledJob))).Result as QueryResult;
        bq.ListDenied = false;
        check(settledFree && settledAttach is { Status: "completed" },
            $"without jobs.list a tab re-attaches to its own job after the poll settled it: {settledFree} {settledAttach?.Status} {settledAttach?.Error?.Code}");

        // Stop while a restored tab's re-attach is still checking the job's identity cancels the job once the check passes.
        // The job was left by an earlier backend (stopped), so no session here polls it.
        string stopJob;
        using (var earlier = new Harness(bq))
        {
            await earlier.ConnectAsync(key);
            var earlierTab = Tab();
            await earlier.Execute(earlierTab, "SELECT 1");
            (_, _, stopJob) = await HeldAsync(earlier, earlierTab);
        }
        var stopChecking = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        bq.AlsoHang = request =>
        {
            if (request.Method != "GET" || !request.Url.Contains("/jobs/" + stopJob, StringComparison.Ordinal) || stopChecking.Task.IsCompleted) return false;
            stopChecking.TrySetResult();
            return true;
        };
        var stopAttachArgs = AttachArgs(harness, Tab(), stopJob, args => args["adoptSession"] = false);
        var stopAttach = harness.Call("query.attach", stopAttachArgs);
        await Task.WhenAny(stopChecking.Task, stopAttach).WaitAsync(TimeSpan.FromSeconds(30));
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = stopAttachArgs["queryId"]!.GetValue<string>() });
        var stoppedCheck = (await stopAttach.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        bq.AlsoHang = null;
        check(stopChecking.Task.IsCompleted && stoppedCheck is { Status: "cancelled" } && await Poll(() => bq.Cancels.Contains(stopJob)),
            $"Stop during a restored tab's identity check cancels the job once it proves this account's: {stoppedCheck?.Status} cancels {string.Join(",", bq.Cancels)}");
        bq.Release(bq.Jobs[stopJob]);

        // Cancel the job on a tab closed during that check, when the re-check cannot pass (no jobs.list): the job is left, and
        // the run and the close both say it may still be running, naming it.
        string unsureJob;
        using (var earlier = new Harness(bq))
        {
            await earlier.ConnectAsync(key);
            var earlierTab = Tab();
            await earlier.Execute(earlierTab, "SELECT 1");
            (_, _, unsureJob) = await HeldAsync(earlier, earlierTab);
        }
        var unsureChecking = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        bq.AlsoHang = request =>
        {
            if (request.Method != "GET" || !request.Url.Contains("/jobs/" + unsureJob, StringComparison.Ordinal) || unsureChecking.Task.IsCompleted) return false;
            unsureChecking.TrySetResult();
            return true;
        };
        bq.ListDenied = true;
        var unsureTab = Tab();
        var unsureAttach = harness.Call("query.attach", AttachArgs(harness, unsureTab, unsureJob));
        await Task.WhenAny(unsureChecking.Task, unsureAttach).WaitAsync(TimeSpan.FromSeconds(30));
        var unsureClose = await harness.Call("query.session.close", new JsonObject { ["sessionId"] = unsureTab, ["cancelJob"] = true });
        var unsureRun = (await unsureAttach.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        bq.AlsoHang = null;
        bq.ListDenied = false;
        check(unsureChecking.Task.IsCompleted && unsureClose.Result is SessionCloseResult { Closed: true, Note: { Code: "outcomeUnknown" } unsureNote } && unsureNote.JobId == unsureJob
            && !bq.Cancels.Contains(unsureJob) && Says(unsureRun, "so it was not cancelled; it may still be running"),
            $"Cancel the job during an identity check that cannot pass leaves the job and says so: {unsureClose.Code} {(unsureClose.Result as SessionCloseResult)?.Note} {Texts(unsureRun?.Messages ?? [])}");
        bq.Release(bq.Jobs[unsureJob]);

        // A rate limit answered as 403 during the identity check is QUOTA (the job kept), not another principal's job.
        var limitedTab = Tab();
        await harness.Execute(limitedTab, "SELECT 1");
        var (limitedArgs, limitedRun, limitedJob) = await HeldAsync(harness, limitedTab);
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = limitedArgs["queryId"]!.GetValue<string>(), ["detach"] = true });
        await limitedRun.WaitAsync(TimeSpan.FromSeconds(30));
        var limiting = true;
        harness.Fake.On("GET", Base + "/jobs/[^/]+", request => limiting && request.Url.Contains("/jobs/" + limitedJob, StringComparison.Ordinal)
            ? new(403, Bq.Error(403, "Exceeded rate limits: too many api requests.", "rateLimitExceeded")) : bq.GetReply(request));
        var limited = (await harness.Call("query.attach", AttachArgs(harness, Tab(), limitedJob, args => args["adoptSession"] = false))).Result as QueryResult;
        limiting = false;
        check(limited is { Status: "failed", Error.Code: "QUOTA" } && !bq.Cancels.Contains(limitedJob),
            $"a rate-limited identity check is QUOTA, not another principal's job: {limited?.Status} {limited?.Error?.Code}");
        bq.Release(bq.Jobs[limitedJob]);

        // A re-attach from a tab with no session, to a job whose session another tab still holds, does not adopt that session,
        // nor take it over when the job finishes: closing the attaching tab never ends the other tab's session.
        var keeperTab = Tab();
        await harness.Execute(keeperTab, "SELECT 1");
        var (keeperArgs, keeperRun, keeperJob) = await HeldAsync(harness, keeperTab);
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = keeperArgs["queryId"]!.GetValue<string>(), ["detach"] = true });
        await keeperRun.WaitAsync(TimeSpan.FromSeconds(30));
        bq.Jobs[keeperJob].Hold = true;
        var borrowerTab = Tab();
        bq.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var borrowerRun = harness.Call("query.attach", AttachArgs(harness, borrowerTab, keeperJob));
        await Task.WhenAny(bq.Polling.Task, borrowerRun).WaitAsync(TimeSpan.FromSeconds(30));
        bq.Release(bq.Jobs[keeperJob]);
        var borrowerAnswer = (await borrowerRun.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        var borrowerAborts = bq.Aborts.Count;
        var borrowerClose = await harness.Call("query.session.close", new JsonObject { ["sessionId"] = borrowerTab });
        check(borrowerAnswer is { Status: "completed" } && borrowerClose.Code == "ok" && bq.Aborts.Count == borrowerAborts,
            $"a re-attach that left another tab's session alone never ends it on close: {borrowerAnswer?.Status} {borrowerClose.Code} aborts {string.Join(",", bq.Aborts.Skip(borrowerAborts))}");

        // A re-attach outside any session (adoptSession false, in a tab that never ran anything): Leave it running on its close
        // leaves the job running, and only Cancel the job cancels it.
        var outsideHolder = Tab();
        await harness.Execute(outsideHolder, "SELECT 1");
        var (outsideArgs, outsideHeld, outsideJob) = await HeldAsync(harness, outsideHolder);
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = outsideArgs["queryId"]!.GetValue<string>(), ["detach"] = true });
        await outsideHeld.WaitAsync(TimeSpan.FromSeconds(30));
        bq.Jobs[outsideJob].Hold = true;
        foreach (var cancelling in new[] { false, true })
        {
            var outsideTab = Tab();
            bq.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
            var outsideRun = harness.Call("query.attach", AttachArgs(harness, outsideTab, outsideJob, args => args["adoptSession"] = false));
            await Task.WhenAny(bq.Polling.Task, outsideRun).WaitAsync(TimeSpan.FromSeconds(30));
            var outsideClose = await harness.Call("query.session.close", new JsonObject { ["sessionId"] = outsideTab, [cancelling ? "cancelJob" : "keepJob"] = true });
            var outsideAnswer = (await outsideRun.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
            // The cancel is sent in the background.
            if (cancelling) await Poll(() => bq.Cancels.Contains(outsideJob), 10);
            check(bq.Polling.Task.IsCompleted && outsideClose.Code == "ok" && outsideAnswer?.Status == (cancelling ? "cancelled" : "detached") && bq.Cancels.Contains(outsideJob) == cancelling,
                $"closing a tab whose re-attach reads outside any session {(cancelling ? "cancels the job only for Cancel the job" : "leaves the job running")}: {outsideClose.Code} {outsideAnswer?.Status} cancels {string.Join(",", bq.Cancels)}");
        }
        bq.Release(bq.Jobs[outsideJob]);

        // Leave it running while the insert is still on its way: BigQuery may have the job, so it is left, never cancelled.
        var insertTab = Tab();
        await harness.Execute(insertTab, "SELECT 1");
        var inserting = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        bq.AlsoHang = request =>
        {
            if (request.Method != "POST" || !request.Body.Contains("SELECT inflight", StringComparison.Ordinal)) return false;
            inserting.TrySetResult();
            return true;
        };
        var cancelsBefore = bq.Cancels.Count;
        var insertRun = harness.Execute(insertTab, "SELECT inflight");
        await Task.WhenAny(inserting.Task, insertRun).WaitAsync(TimeSpan.FromSeconds(30));
        var insertClose = await harness.Call("query.session.close", new JsonObject { ["sessionId"] = insertTab, ["keepJob"] = true });
        try { await insertRun.WaitAsync(TimeSpan.FromSeconds(30)); } catch (Exception) when (insertRun.IsCompleted) { }
        bq.AlsoHang = null;
        check(inserting.Task.IsCompleted && insertClose.Code == "ok" && bq.Cancels.Count == cancelsBefore,
            $"Leave it running during the insert never cancels the job: {insertClose.Code} cancels {bq.Cancels.Count - cancelsBefore}");

        // Leave it running on a re-attach that only reads a DONE job's rows is a stop: nothing is left running.
        var readTab = Tab();
        await harness.Execute(readTab, "SELECT 1");
        var readJob = JobOf(bq.UserInserts.Last());
        var readHung = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        bq.AlsoHang = request =>
        {
            if (!request.Url.Contains("/queries/" + readJob, StringComparison.Ordinal)) return false;
            readHung.TrySetResult();
            return true;
        };
        var readArgs = AttachArgs(harness, Tab(), readJob, args => args["adoptSession"] = false);
        var readRun = harness.Call("query.attach", readArgs);
        await Task.WhenAny(readHung.Task, readRun).WaitAsync(TimeSpan.FromSeconds(30));
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = readArgs["queryId"]!.GetValue<string>(), ["detach"] = true });
        var readAnswer = (await readRun.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        bq.AlsoHang = null;
        check(readHung.Task.IsCompleted && readAnswer is { Status: "cancelled" } && !Says(readAnswer, "keeps running"),
            $"Leave it running on a DONE job being read stops the read: {readAnswer?.Status} {Texts(readAnswer?.Messages ?? [])}");

        // The tab's own held job: a re-attach follows it at once (no wait for DONE), and when a later attach supersedes it and
        // then fails its identity check, the session still holds the job, so no close or idle end aborts it.
        var ownTab = Tab();
        await harness.Execute(ownTab, "SELECT 1");
        var (ownArgs, ownRun, ownJob) = await HeldAsync(harness, ownTab);
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = ownArgs["queryId"]!.GetValue<string>(), ["detach"] = true });
        await ownRun.WaitAsync(TimeSpan.FromSeconds(30));
        bq.Jobs[ownJob].Hold = true;
        bq.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var follow = harness.Call("query.attach", AttachArgs(harness, ownTab, ownJob));
        await Task.WhenAny(bq.Polling.Task, follow).WaitAsync(TimeSpan.FromSeconds(30));
        check(!follow.IsCompleted, $"a re-attach of the tab's own held job follows it rather than waiting for DONE: {(follow.IsCompleted ? follow.Result.Code : "running")}");
        bq.Foreign.Add(ownJob);
        var refused = await harness.Call("query.attach", AttachArgs(harness, ownTab, ownJob));
        var superseded = (await follow.WaitAsync(TimeSpan.FromSeconds(30))).Result as QueryResult;
        var stillHeld = await harness.State(ownTab);
        check(superseded is { Status: "superseded" } && refused.Result is QueryResult { Error.Code: "AUTH_IDENTITY" } && stillHeld.State is { Job: "running" },
            $"a superseded attach leaves the job held by the session when the attach that took over fails: {superseded?.Status} {(refused.Result as QueryResult)?.Error?.Code} {stillHeld.State}");
        bq.Foreign.Remove(ownJob);
        bq.Release(bq.Jobs[ownJob]);

        // A detached record: the attach holds the session's queue until DONE and reads no results.
        var heldTab = Tab();
        await harness.Execute(heldTab, "SELECT 1");
        var (heldArgs, heldRun, heldJob) = await HeldAsync(harness, heldTab);
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = heldArgs["queryId"]!.GetValue<string>(), ["detach"] = true });
        await heldRun.WaitAsync(TimeSpan.FromSeconds(30));
        bq.Release(bq.Jobs[heldJob]);
        var quiet = await harness.Call("query.attach", AttachArgs(harness, Tab(), heldJob, args => { args["adoptSession"] = false; args["detached"] = true; }));
        check(quiet.Result is QueryResult { Status: "completed", ResultSets.Count: 0 } detachedResult && Says(detachedResult, "reads no results") && !Says(detachedResult, "discarded"),
            $"a detached record's attach reads no results: {quiet.Code} {(quiet.Result as QueryResult)?.ResultSets.Count}");

        // Another principal's job, a job that does not exist and another project's job: AUTH_IDENTITY, the job left alone.
        var otherTab = Tab();
        await harness.Execute(otherTab, "SELECT 1");
        var foreignJob = JobOf(bq.UserInserts.Last());
        bq.Foreign.Add(foreignJob);
        var foreign = await harness.Call("query.attach", AttachArgs(harness, Tab(), foreignJob));
        var missing = await harness.Call("query.attach", AttachArgs(harness, Tab(), "varia_missing"));
        var project = await harness.Call("query.attach", AttachArgs(harness, Tab(), foreignJob, args => args["project"] = "varia-beta"));
        var invalid = await harness.Call("query.attach", AttachArgs(harness, Tab(), "bad id!"));
        check(foreign.Result is QueryResult { Error.Code: "AUTH_IDENTITY" } && missing.Result is QueryResult { Error.Code: "AUTH_IDENTITY" } && project.Code == "AUTH_IDENTITY" && invalid.Code == "INVALID_PARAMS" && !bq.Cancels.Contains(foreignJob),
            $"the identity check refuses another principal's, a missing and another project's job: {foreign.Code} {missing.Code} {project.Code} {invalid.Code}");

        // Results gone: REMOTE_EXPIRED.
        var expiredTab = Tab();
        await harness.Execute(expiredTab, "SELECT 1");
        var expiredJob = JobOf(bq.UserInserts.Last());
        bq.ExpiredResults.Add(expiredJob);
        var expired = await harness.Call("query.attach", AttachArgs(harness, Tab(), expiredJob, args => args["adoptSession"] = false));
        check(expired.Result is QueryResult { Error.Code: "REMOTE_EXPIRED" }, $"a job whose results are gone answers REMOTE_EXPIRED: {expired.Code} {(expired.Result as QueryResult)?.Error?.Code}");
    }

    /// <summary>Disconnect and bigquery.endIdleSessions end idle sessions and leave those holding a job; keepJobKeys keeps a
    /// kept tab's open transaction; failed aborts are counted and retried once a handle reaches BigQuery.</summary>
    static async Task IdleEndsAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new Bq();
        bq.Statements["BEGIN TRANSACTION"] = "BEGIN_TRANSACTION";
        using var harness = new Harness(bq);
        await harness.ConnectAsync(key);
        var idle = Tab();
        await harness.Execute(idle, "SELECT 1");
        var holder = Tab();
        await harness.Execute(holder, "SELECT 1");
        var (args, run, job) = await HeldAsync(harness, holder);
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = args["queryId"]!.GetValue<string>(), ["detach"] = true });
        await run.WaitAsync(TimeSpan.FromSeconds(30));
        var kept = Tab();
        var keptKey = Guid.NewGuid().ToString();
        await harness.Execute(kept, "BEGIN TRANSACTION", item => item["jobKey"] = keptKey);
        var keptIdle = Tab();
        var keptIdleKey = Guid.NewGuid().ToString();
        await harness.Execute(keptIdle, "SELECT 1", item => item["jobKey"] = keptIdleKey);

        var badKeys = await harness.Call("bigquery.endIdleSessions", new JsonObject { ["keepJobKeys"] = new JsonArray("nope") });
        var ended = await harness.Call("bigquery.endIdleSessions", new JsonObject { ["keepJobKeys"] = new JsonArray(keptKey, keptIdleKey) });
        check(badKeys.Code == "INVALID_PARAMS" && ended.Result is BigQueryEndIdleResult { FailedAborts: 0 } && bq.Aborts.Contains("sess-1") && bq.Aborts.Contains("sess-4")
            && !bq.Aborts.Contains("sess-2") && !bq.Aborts.Contains("sess-3") && harness.BigQuery.OwnsSession(holder) && harness.BigQuery.OwnsSession(kept) && !harness.BigQuery.OwnsSession(idle),
            $"endIdleSessions ends idle sessions, leaves one holding a job and a kept tab's open transaction: {ended.Code} {string.Join(",", bq.Aborts)}");

        // Disconnect: the idle session ends (failing here, counted), the one holding a job is left.
        bq.Release(bq.Jobs[job]);
        await Poll(() => harness.State(holder).Result.State is { Job: "none" });
        var (args2, run2, job2) = await HeldAsync(harness, holder);
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = args2["queryId"]!.GetValue<string>(), ["detach"] = true });
        await run2.WaitAsync(TimeSpan.FromSeconds(30));
        bq.AbortError = Failure("backendError", "BigQuery could not end the session.");
        var aborts = bq.Aborts.Count;
        var disconnected = await harness.Call("connections.disconnect", new JsonObject { ["connectionId"] = harness.ConnectionId });
        bq.AbortError = null;
        check(disconnected.Result is DisconnectResult { Disconnected: true, FailedAborts: 1 } && bq.Aborts.Skip(aborts).SequenceEqual(["sess-3"]) && harness.BigQuery.FailedAbortCount == 1,
            $"Disconnect ends the idle session, leaves the one holding a job and counts a failed abort: {disconnected.Result} {string.Join(",", bq.Aborts.Skip(aborts))}");
        bq.Release(bq.Jobs[job2]);

        // The failed abort is retried once the next time a handle reaches BigQuery.
        await harness.ConnectAsync(key);
        await harness.Execute(Tab(), "SELECT 1");
        check(await Poll(() => bq.Aborts.Count(id => id == "sess-3") == 2) && harness.BigQuery.FailedAbortCount == 0,
            $"a failed abort is retried once a handle reaches BigQuery: {string.Join(",", bq.Aborts)}");
    }

    /// <summary>bigquery.cancelJobs: a held script that committed is cancelled, waited for, reported and its session ended.</summary>
    static async Task CancelJobsAsync(Action<bool, string> check, JsonObject key)
    {
        var bq = new Bq();
        bq.KeepRunningAfterCancel = false;
        bq.Scripts["SCRIPT commits"] = [("BEGIN_TRANSACTION", null), ("INSERT", null), ("COMMIT_TRANSACTION", null)];
        using var harness = new Harness(bq);
        await harness.ConnectAsync(key);
        var tab = Tab();
        await harness.Execute(tab, "SELECT 1");
        var (args, run, job) = await HeldAsync(harness, tab, "SCRIPT commits");
        await harness.Call("query.cancel", new JsonObject { ["queryId"] = args["queryId"]!.GetValue<string>(), ["detach"] = true });
        await run.WaitAsync(TimeSpan.FromSeconds(30));
        var request = new JsonObject
        {
            ["authentication"] = "serviceAccountKey", ["project"] = "varia-alpha", ["keyFile"] = Guid.NewGuid().ToString(),
            ["credential"] = new JsonObject { ["source"] = "file", ["json"] = key.ToJsonString() },
            ["jobs"] = new JsonArray(new JsonObject { ["jobId"] = job, ["location"] = "US" })
        };
        var answer = await harness.Call("bigquery.cancelJobs", request);
        var cancelled = answer.Result as BigQueryCancelJobsResult;
        check(cancelled?.Jobs is [{ Cancelled: true, Note.Code: "committedBeforeCancel" } one] && one.JobId == job && bq.Cancels.Contains(job) && bq.Aborts.Contains("sess-1"),
            $"bigquery.cancelJobs cancels the job, reports its commit and ends its session: {answer.Code} {answer.Message} {cancelled?.Jobs.FirstOrDefault()}");
        var empty = await harness.Call("bigquery.cancelJobs", new JsonObject { ["authentication"] = "serviceAccountKey", ["project"] = "varia-alpha", ["keyFile"] = Guid.NewGuid().ToString(),
            ["credential"] = new JsonObject { ["source"] = "file", ["json"] = key.ToJsonString() }, ["jobs"] = new JsonArray() });
        check(empty.Code == "INVALID_PARAMS", $"bigquery.cancelJobs needs jobs: {empty.Code}");
    }
}
