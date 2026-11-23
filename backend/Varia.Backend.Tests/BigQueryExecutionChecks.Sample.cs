using System.Text.Json.Nodes;
using Google.Apis.Bigquery.v2.Data;
using Varia.Backend.BigQuery;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>
/// Load sample and Re-run of a windowed result offline (docs/bigquery.md, Load a sample, Expiry): the random sample's SQL,
/// results.remoteQuery's sample and rerun kinds and their estimates through the scripted fake, their refusals, and Stop or the
/// source's release cancelling them. No request leaves the process.
/// </summary>
internal static partial class BigQueryExecutionChecks
{
    static async Task SamplesAsync(Action<bool, string> check)
    {
        SampleSqlShapes(check);
        await FirstRowsSampleAsync(check);
        await RandomSampleAsync(check);
        await RerunAsync(check);
        await AttachedRerunAsync(check);
        await ScriptChildRerunAsync(check);
        await SampleRefusalsAsync(check);
        await SampleStopsAsync(check);
    }

    static JsonObject Sample(uint resultId, int rows, string method, string? queryId = null) => new()
    {
        ["queryId"] = queryId ?? Guid.NewGuid().ToString(), ["resultId"] = resultId, ["generation"] = 1, ["kind"] = "sample", ["rows"] = rows, ["method"] = method
    };

    static JsonObject Rerun(uint resultId, string? queryId = null) => new() { ["queryId"] = queryId ?? Guid.NewGuid().ToString(), ["resultId"] = resultId, ["generation"] = 1, ["kind"] = "rerun" };

    static JsonObject RemoteDryRun(Harness harness, JsonObject remote)
    {
        var copy = (JsonObject)remote.DeepClone();
        copy.Remove("queryId");
        return new JsonObject { ["connectionId"] = harness.ConnectionId, ["remote"] = copy };
    }

    static void SampleSqlShapes(Action<bool, string> check)
    {
        check(BigQueryViewSql.SamplePercent(1000, 3000) == 36.666667 && BigQueryViewSql.SamplePercent(3000, 3000) == 100 && BigQueryViewSql.SamplePercent(5000, 3000) == 100
            && BigQueryViewSql.SamplePercent(1, 1_000_000_000_000) == 0.000001 && BigQueryViewSql.SamplePercent(10, 0) == 100 && BigQueryViewSql.SamplePercent(95, 100) == 100,
            "a random sample asks for the rows' share with 10% to spare, rounded up to a millionth, from a millionth to 100: " + BigQueryViewSql.SamplePercent(1000, 3000));
        var parameters = new List<QueryParameter>();
        var sql = BigQueryViewSql.Sample(ViewTable, 1000, 3000, parameters);
        check(sql == "SELECT * FROM `varia-emulator`.`_anon0123`.`anon_result_1` TABLESAMPLE SYSTEM (@percent PERCENT) LIMIT @rows"
            && parameters.Count == 2 && parameters[0] is { Name: "percent", ParameterType.Type: "FLOAT64", ParameterValue.Value: "36.666667" }
            && parameters[1] is { Name: "rows", ParameterType.Type: "INT64", ParameterValue.Value: "1000" },
            "a random sample reads the result table with TABLESAMPLE SYSTEM, its percent and rows as parameters: " + sql + " " + string.Join(", ", parameters.Select(p => p.Name + "=" + p.ParameterValue.Value)));
        check(new[] { BigQuerySql.SampleOpen, BigQuerySql.SamplePercentParameter, BigQuerySql.SampleLimit, BigQuerySql.SampleRowsParameter }.All(BigQuerySql.ViewFragments.Contains),
            "the sample's fragments are in the linted view fragments");
    }

    static async Task FirstRowsSampleAsync(Action<bool, string> check)
    {
        var (harness, id) = await WindowedAsync();
        using var _ = harness;
        var inserts = harness.Jobs.InsertedIds.Count;
        // Its estimate is free and asks nothing of BigQuery.
        var reads = harness.Jobs.TableReads.Count;
        var (dry, estimate, dryMessage) = await harness.Call("bigquery.dryRun", RemoteDryRun(harness, Sample(id, 100, "first")));
        check(dry == "ok" && estimate is BigQueryDryRunResult { BytesProcessed: 0, Faked: false } && harness.Jobs.TableReads.Count == reads && harness.Jobs.InsertedIds.Count == inserts,
            $"a first-rows sample's estimate is 0 bytes, asked of no one: {dry} {dryMessage} {estimate} {harness.Jobs.TableReads.Count - reads}");
        var (code, result, events, message) = await Run(harness, "results.remoteQuery", Sample(id, 100, "first"));
        var set = result?.ResultSets.SingleOrDefault();
        var stored = set is null ? null : harness.Service.Results.Find(set.ResultId);
        var rows = set is null ? [] : harness.Rows(set);
        var tableReads = harness.Jobs.TableReads.Skip(reads).ToList();
        check(code == "ok" && result?.Status == "completed" && set is { Residence: "memory", RowsStored: 100 } && stored is { Derived: true } && set.ResultId != id
            && harness.Service.Results.Find(id)?.IsRemote == true && harness.Jobs.InsertedIds.Count == inserts
            && rows.Select(row => row[0].Text).SequenceEqual(Enumerable.Range(0, 100).Select(i => i.ToString(Inv)))
            && tableReads.Count > 0 && tableReads[0].StartIndex == 0 && tableReads.All(read => read.MaxResults <= 100)
            && Types(events).Contains("resultSet.opened") && Types(events).Contains("resultSet.closed"),
            $"a first-rows sample reads the table's first rows into a new result in memory, with no job: {code} {message} {result?.Status} {set?.Residence} {set?.RowsStored} {stored?.Derived} inserts={harness.Jobs.InsertedIds.Count - inserts} reads={string.Join(";", tableReads)}");
        check(Says(result, "The sample holds 100 of 3,000 rows.") && Says(result, "tabledata.list") && result?.Job is null,
            "a first-rows sample says what it holds and that it ran no job: " + Texts(result?.Messages ?? []));
        // One that does not fit stops only itself: its source's budget keeps running.
        var (big, bigResult, _, bigMessage) = await Run(harness, "results.remoteQuery", Sample(id, 3000, "first"));
        var bigSet = bigResult?.ResultSets.SingleOrDefault();
        check(big == "ok" && bigSet is { Residence: "memory" } && bigSet.RowsStored < 3000 && bigSet.Truncated is not null
            && harness.Service.Results.Find(id)!.Budget.Stopped == TruncationReason.None,
            $"a first-rows sample past the budget keeps the rows read and never stops its source: {big} {bigMessage} {bigResult?.Status} {bigSet?.RowsStored} {bigSet?.Truncated} {harness.Service.Results.Find(id)!.Budget.Stopped}");
        // An expired table answers REMOTE_EXPIRED.
        harness.Jobs.TableDataStatus = 404;
        var (gone, goneResult, _, goneMessage) = await Run(harness, "results.remoteQuery", Sample(id, 100, "first"));
        check(gone == "ok" && goneResult is { Status: "failed", Error.Code: "REMOTE_EXPIRED" } && goneResult.ResultSets.Count == 0,
            $"a first-rows sample of an expired table answers REMOTE_EXPIRED: {gone} {goneMessage} {goneResult?.Status} {goneResult?.Error?.Code} {goneResult?.Error?.Message}");
    }

    static async Task RandomSampleAsync(Action<bool, string> check)
    {
        var (harness, id) = await WindowedAsync();
        using var _ = harness;
        var (dry, estimate, dryMessage) = await harness.Call("bigquery.dryRun", RemoteDryRun(harness, Sample(id, 1000, "random")));
        check(dry == "ok" && estimate is BigQueryDryRunResult { Faked: true }, $"a random sample is estimated (faked in emulator mode): {dry} {dryMessage} {estimate}");
        // The fake answers the sample's rows: BigQuery's pick of about a third of the table, cut at LIMIT.
        harness.Jobs.Rows = [.. harness.Jobs.Rows.Take(200)];
        var (code, result, _, message) = await Run(harness, "results.remoteQuery", Sample(id, 1000, "random"));
        var set = result?.ResultSets.SingleOrDefault();
        var body = harness.Jobs.InsertBodies.Last();
        var query = body["configuration"]!["query"]!;
        var parameters = query["queryParameters"]!.AsArray().Select(p => p!["name"]!.GetValue<string>() + ":" + p["parameterType"]!["type"]!.GetValue<string>() + "=" + p["parameterValue"]!["value"]!.GetValue<string>()).ToArray();
        check(code == "ok" && result?.Status == "completed" && set is { Residence: "memory", RowsStored: 200 } && harness.Service.Results.Find(set.ResultId) is { Derived: true }
            && InsertedSql(harness) == "SELECT * FROM `varia-emulator`.`_anon0123`.`anon_result_1` TABLESAMPLE SYSTEM (@percent PERCENT) LIMIT @rows"
            && parameters.SequenceEqual(["percent:FLOAT64=36.666667", "rows:INT64=1000"]) && query["createSession"] is null && query["connectionProperties"] is null
            && body["configuration"]!["labels"]?["varia_client"]?.GetValue<string>() == "varia",
            $"a random sample runs TABLESAMPLE over the result table outside any session, into memory: {code} {message} {result?.Status} {set?.Residence} {set?.RowsStored} {InsertedSql(harness)} {string.Join(",", parameters)}");
        check(Says(result, "The sample holds 200 of 3,000 rows.") && Says(result, "BigQuery job ") && result?.Job is not null,
            "a random sample names its job and what it holds in Messages: " + Texts(result?.Messages ?? []));
        // Once the table has expired the estimate says so, and the run answers REMOTE_EXPIRED: TABLESAMPLE has no fallback.
        harness.Jobs.TableDataStatus = 404;
        var (goneDry, _, goneDryMessage) = await harness.Call("bigquery.dryRun", RemoteDryRun(harness, Sample(id, 1000, "random")));
        harness.Jobs.Failure = new JsonObject { ["reason"] = "notFound", ["message"] = "Not found: Table varia-emulator:_anon0123.anon_result_1 was not found in location US" };
        var (gone, goneResult, _, _) = await Run(harness, "results.remoteQuery", Sample(id, 1000, "random"));
        var fallback = Sample(id, 1000, "random");
        fallback["fallback"] = true;
        var (refusedFallback, _, _, _) = await Run(harness, "results.remoteQuery", fallback);
        check(goneDry == "REMOTE_EXPIRED" && gone == "ok" && goneResult is { Status: "failed", Error.Code: "REMOTE_EXPIRED" } && refusedFallback == "INVALID_PARAMS",
            $"a random sample of an expired table answers REMOTE_EXPIRED, with no fallback: {goneDry} {goneDryMessage} {gone} {goneResult?.Error?.Code} {refusedFallback}");
    }

    static async Task RerunAsync(Action<bool, string> check)
    {
        var (harness, id) = await WindowedAsync();
        using var _ = harness;
        var (dry, estimate, dryMessage) = await harness.Call("bigquery.dryRun", RemoteDryRun(harness, Rerun(id)));
        check(dry == "ok" && estimate is BigQueryDryRunResult { Faked: true }, $"a rerun is estimated: {dry} {dryMessage} {estimate}");
        // Its table gone, the rerun still runs: it reads the query's own tables, not the result's.
        harness.Jobs.TableDataStatus = 404;
        var (code, result, _, message) = await Run(harness, "results.remoteQuery", Rerun(id));
        harness.Jobs.TableDataStatus = 0;
        var set = result?.ResultSets.SingleOrDefault();
        var query = harness.Jobs.InsertBodies.Last()["configuration"]!["query"]!;
        var stored = set is null ? null : harness.Service.Results.Find(set.ResultId);
        check(code == "ok" && result?.Status == "completed" && set is { Residence: "remote", RowsAvailable: 3000 } && set.ResultId != id && stored is { Derived: true, Reran: true }
            && InsertedSql(harness) == "SELECT n, s FROM t" && query["defaultDataset"]?["datasetId"]?.GetValue<string>() == "varia_fixture" && query["createSession"] is null
            && query["connectionProperties"] is null && result.Job is not null,
            $"a rerun runs the result's own statement in its dataset, outside the session, into a result of its own: {code} {message} {result?.Status} {set?.Residence} {set?.RowsAvailable} {stored?.Reran} {InsertedSql(harness)} {query.ToJsonString()}");
        // A rerun's result runs again in its turn.
        if (set is null) return;
        var (again, againResult, _, againMessage) = await Run(harness, "results.remoteQuery", Rerun(set.ResultId));
        check(again == "ok" && againResult?.Status == "completed" && InsertedSql(harness) == "SELECT n, s FROM t",
            $"a rerun's result runs again: {again} {againMessage} {againResult?.Status} {InsertedSql(harness)}");
        // The release of the result it replaces leaves it standing.
        await harness.Call("results.close", new JsonObject { ["resultIds"] = new JsonArray(id) });
        check(harness.Service.Results.Find(set.ResultId) is { IsRemote: true }, "a rerun's result outlives the source it replaces, which the renderer closes once it shows the new one");
    }

    static async Task AttachedRerunAsync(Action<bool, string> check)
    {
        // A re-attached result keeps no statement text: its rerun reads the job's, and the dataset it ran with.
        var (harness, _) = await WindowedAsync();
        using var _ = harness;
        var jobId = harness.Jobs.InsertedIds.Last();
        var attach = new JsonObject
        {
            ["connectionId"] = harness.ConnectionId, ["sessionId"] = Guid.NewGuid().ToString(), ["queryId"] = Guid.NewGuid().ToString(), ["jobKey"] = Guid.NewGuid().ToString(),
            ["jobId"] = jobId, ["project"] = "varia-emulator", ["maxRows"] = 0, ["maxResultSets"] = 10, ["adoptSession"] = false
        };
        var (attached, result, attachMessage) = await harness.Call("query.attach", attach);
        var set = (result as QueryResult)?.ResultSets.SingleOrDefault();
        var inserts = harness.Jobs.InsertedIds.Count;
        var (code, rerun, _, message) = await Run(harness, "results.remoteQuery", Rerun(set?.ResultId ?? 0));
        var query = harness.Jobs.InsertBodies.Last()["configuration"]!["query"]!;
        check(attached == "ok" && set is { Residence: "remote" } && code == "ok" && rerun?.Status == "completed" && harness.Jobs.InsertedIds.Count == inserts + 1
            && InsertedSql(harness) == "SELECT n, s FROM t" && query["defaultDataset"]?["datasetId"]?.GetValue<string>() == "varia_fixture",
            $"a re-attached result's rerun runs the job's own statement in its dataset: {attached} {attachMessage} {set?.Residence} {code} {message} {rerun?.Status} {rerun?.Error?.Message} {InsertedSql(harness)}");
    }

    static async Task ScriptChildRerunAsync(Action<bool, string> check)
    {
        var jobs = Lines(3000);
        jobs.StatementType = "SCRIPT";
        jobs.ScriptChild = true;
        jobs.ChildQuery = "SELECT n, s FROM t ORDER BY n";
        using var harness = new Harness(jobs, new ResultStore(4L << 20, 32 * 1024));
        await harness.ConnectAsync();
        var (_, executed, executeMessage) = await harness.Execute("DECLARE x INT64 DEFAULT 1; SELECT n, s FROM t ORDER BY n", Windowed);
        var id = executed?.ResultSets.SingleOrDefault()?.ResultId ?? 0;
        // The rerun is one SELECT: BigQuery answers it as such.
        jobs.StatementType = "SELECT";
        jobs.ScriptChild = false;
        var (code, result, _, message) = await Run(harness, "results.remoteQuery", Rerun(id));
        check(id != 0 && code == "ok" && result?.Status == "completed" && InsertedSql(harness) == "SELECT n, s FROM t ORDER BY n",
            $"a script statement's rerun runs that statement alone, read from its job: {executeMessage} {id} {code} {message} {result?.Status} {result?.Error?.Message} {(harness.Jobs.InsertBodies.IsEmpty ? "" : InsertedSql(harness))}");
        // A job that does not say its statement cannot run again in place.
        jobs.ChildQuery = " ";
        var (_, blank, _, _) = await Run(harness, "results.remoteQuery", Rerun(id));
        check(blank is { Status: "failed", Error.Code: "BACKEND_ERROR" } && blank.Error.Message.Contains("Run the query again", StringComparison.Ordinal),
            $"a statement BigQuery does not name is refused: {blank?.Status} {blank?.Error?.Code} {blank?.Error?.Message}");
    }

    static async Task SampleRefusalsAsync(Action<bool, string> check)
    {
        var (harness, id) = await WindowedAsync();
        using var _ = harness;
        var (_, viewResult, _, _) = await Run(harness, "results.remoteQuery", View(id, sort: [Key(0)]));
        var viewId = viewResult?.ResultSets.SingleOrDefault()?.ResultId ?? 0;
        var inserts = harness.Jobs.InsertedIds.Count;
        async Task<string> Refused(JsonObject request) => (await Run(harness, "results.remoteQuery", request)).Code;
        var none = await Refused(new JsonObject { ["queryId"] = Guid.NewGuid().ToString(), ["resultId"] = id, ["generation"] = 1, ["kind"] = "sample", ["rows"] = 10 });
        var zero = await Refused(Sample(id, 0, "first"));
        var tooMany = await Refused(Sample(id, 10_000_001, "random"));
        var method = await Refused(Sample(id, 10, "last"));
        var sorted = Sample(id, 10, "random");
        sorted["sort"] = new JsonArray(Key(0));
        var withSort = await Refused(sorted);
        var rerunRows = Rerun(id);
        rerunRows["rows"] = 10;
        var rerunWithRows = await Refused(rerunRows);
        var rerunView = await Refused(Rerun(viewId));
        var sampleView = viewId == 0 ? "" : await Refused(Sample(viewId, 10, "first"));
        check(none == "INVALID_PARAMS" && zero == "INVALID_PARAMS" && tooMany == "INVALID_PARAMS" && method == "INVALID_PARAMS" && withSort == "INVALID_PARAMS"
            && rerunWithRows == "INVALID_PARAMS" && rerunView == "INVALID_PARAMS" && harness.Jobs.InsertedIds.Count == inserts,
            $"a malformed sample or rerun, or a rerun of a view, is refused before any job: {none} {zero} {tooMany} {method} {withSort} {rerunWithRows} {rerunView} {sampleView}");
        var (dryView, _, _) = await harness.Call("bigquery.dryRun", RemoteDryRun(harness, Rerun(viewId)));
        check(dryView == "INVALID_PARAMS" && harness.Jobs.InsertedIds.Count == inserts, "a rerun of a view is refused at its estimate too: " + dryView);
        using var memory = new Harness(Lines(20));
        await memory.ConnectAsync();
        var (_, executed, _) = await memory.Execute("SELECT n, s FROM t");
        var memoryId = executed!.ResultSets.Single().ResultId;
        var (sampleMemory, _, _, _) = await Run(memory, "results.remoteQuery", Sample(memoryId, 10, "first"));
        var (rerunMemory, _, _, _) = await Run(memory, "results.remoteQuery", Rerun(memoryId));
        check(sampleMemory == "INVALID_PARAMS" && rerunMemory == "INVALID_PARAMS", $"a result in memory neither samples nor runs again in place: {sampleMemory} {rerunMemory}");
    }

    static async Task SampleStopsAsync(Action<bool, string> check)
    {
        // Stop, and the source's release, cancel a random sample's or a rerun's job and keep no result.
        foreach (var kind in new[] { "random", "rerun" })
            foreach (var release in new[] { false, true })
            {
                var (harness, id) = await WindowedAsync();
                using var _ = harness;
                harness.Jobs.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
                harness.Jobs.Hang = true;
                var queryId = Guid.NewGuid().ToString();
                var running = Run(harness, "results.remoteQuery", kind == "rerun" ? Rerun(id, queryId) : Sample(id, 100, "random", queryId));
                var held = await Task.WhenAny(harness.Jobs.Polling.Task, Task.Delay(15_000)) == harness.Jobs.Polling.Task;
                if (release) await harness.Call("results.close", new JsonObject { ["resultIds"] = new JsonArray(id) });
                else await harness.Call("query.cancel", new JsonObject { ["queryId"] = queryId });
                var (code, result, _, message) = await running;
                var job = harness.Jobs.InsertedIds.Last();
                var cancelled = await BigQuerySessionChecks.Poll(() => harness.Jobs.Cancels.Contains(job));
                check(held && code == "ok" && result?.Status == (release ? "failed" : "cancelled") && (!release || result?.Error?.Code == "RESULT_RELEASED") && result?.ResultSets.Count == 0
                    && cancelled && harness.Service.Results.Find(id + 1) is null,
                    $"{(release ? "closing the source" : "Stop")} cancels a {kind}'s job and keeps no result: {held} {code} {message} {result?.Status} {result?.Error?.Code} {string.Join(",", harness.Jobs.Cancels)}");
            }
        // A first-rows sample has no job: Stop and the release end its tabledata.list read.
        foreach (var release in new[] { false, true })
        {
            var (harness, id) = await WindowedAsync();
            using var _ = harness;
            harness.Jobs.Polling = new(TaskCreationOptions.RunContinuationsAsynchronously);
            harness.Jobs.HangTable = true;
            var queryId = Guid.NewGuid().ToString();
            var running = Run(harness, "results.remoteQuery", Sample(id, 100, "first", queryId));
            var held = await Task.WhenAny(harness.Jobs.Polling.Task, Task.Delay(15_000)) == harness.Jobs.Polling.Task;
            if (release) await harness.Call("results.close", new JsonObject { ["resultIds"] = new JsonArray(id) });
            else await harness.Call("query.cancel", new JsonObject { ["queryId"] = queryId });
            var (code, result, _, message) = await running;
            harness.Jobs.HangTable = false;
            check(held && code == "ok" && result?.Status == (release ? "failed" : "cancelled") && (!release || result?.Error?.Code == "RESULT_RELEASED") && result?.ResultSets.Count == 0
                && harness.Service.Results.Find(id + 1) is null,
                $"{(release ? "closing the source" : "Stop")} ends a first-rows sample's read and keeps no result: {held} {code} {message} {result?.Status} {result?.Error?.Code}");
        }
    }
}
