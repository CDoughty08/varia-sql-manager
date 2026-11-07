using System.Collections;
using System.Text.Json;
using Varia.Backend.Statistics;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

internal static class ClientStatisticsChecks
{
    public static void Run(Action<bool, string> check)
    {
        var values = ClientStatisticsCollector.Read(new Hashtable { ["BytesSent"] = 12L, ["BytesReceived"] = -1L,
            ["ServerRoundtrips"] = long.MaxValue, ["SelectRows"] = 1, ["Unknown"] = 4L });
        check(values.Count == 1 && values["BytesSent"] == 12 && !values.ContainsKey("ExecutionTime"), "statistics omit missing, negative, unsafe, wrongly typed and unknown counters");
    }

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var session = Guid.NewGuid().ToString();
        async Task<QueryResult> Query(string sql, bool include = true, string? queryId = null, bool plan = false, int timeout = 10, RequestContext? context = null) =>
            (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(new QueryArgs(info.Id, session, "master", sql,
                queryId ?? Guid.NewGuid().ToString(), 1, timeout, MaxResultSets: 1, IncludeActualPlan: plan, IncludeClientStatistics: include), json), json, context);
        long Counter(QueryResult result, string key) => result.ClientStatistics?.Counters.GetValueOrDefault(key, -1) ?? -1;
        try
        {
            var sql = "SET NOCOUNT OFF; SELECT n FROM (VALUES(1),(2),(3)) v(n);";
            var first = await Query(sql);
            check(first.Status == "completed" && first.ClientStatistics is { Unavailable: null, CollectionElapsedMs: >= 0 }, "statistics collected on first session execution");
            check(Counter(first, "BytesSent") > 0 && Counter(first, "BytesReceived") > 0 && Counter(first, "ServerRoundtrips") == 1, "statistics exclude login and SET prologue round trips");
            check(Counter(first, "SelectRows") == 3 && first.ResultSets[0].RowsStored == 1, "provider SELECT count includes rows past display limit");
            var timed = await Query("WAITFOR DELAY '00:00:00.150'; SELECT 1;");
            Console.WriteLine("Client statistics async timing: wall=" + timed.ClientStatistics?.CollectionElapsedMs + " provider=" + Counter(timed, "ExecutionTime") + " replyWait=" + Counter(timed, "NetworkServerTime") + " ms");
            check(Counter(timed, "ExecutionTime") == -1 && Counter(timed, "NetworkServerTime") >= 100, "async reply wait is measured; unreliable provider execution timer stays unavailable");
            check((await Query(sql, false)).ClientStatistics is null, "statistics off preserves optional summary contract");
            var second = await Query(sql);
            check(Counter(second, "ServerRoundtrips") == 1 && Counter(second, "SelectRows") == 3 && Counter(second, "BytesSent") == Counter(first, "BytesSent"), "successive statistics reset independently, excluding intervening unmeasured execution");
            var state = await Query("SELECT @@ROWCOUNT, @@ERROR;");
            check(LiveResultChecks.RowsOf(service.Results, state.ResultSets[0])[0] is ["3", "0"], "statistics retrieval preserves ROWCOUNT and ERROR on the user session");
            var repeated = await Query("SELECT 1;\nGO 2\nSELECT 2;");
            check(Counter(repeated, "ServerRoundtrips") == 3 && Counter(repeated, "SelectRows") == 3, "one sample spans GO repeats and discarded result sets");
            var noCount = await Query("SET NOCOUNT ON; SELECT 1; SET NOCOUNT OFF;");
            check(Counter(noCount, "SelectRows") == 0 && noCount.ResultSets[0].RowsRead == 1, "NOCOUNT suppresses provider row count without suppressing returned rows");
            var dml = await Query("SET NOCOUNT OFF; CREATE TABLE #stats(n int); INSERT #stats VALUES(1),(2); UPDATE #stats SET n=n+1; DELETE #stats; DROP TABLE #stats;");
            check(Counter(dml, "IduRows") == 6, "provider DML rows include insert update delete completion counts");
            var failed = await Query("SELECT 1; THROW 50000, 'statistics failure', 1;");
            check(failed.Status != "completed" && failed.ClientStatistics is not null && Counter(failed, "ServerRoundtrips") == 1, "failed execution retains partial statistics");
            var id = Guid.NewGuid().ToString();
            var opened = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            using var context = new RequestContext(1, "query.execute", RequestLane.Query, 0, sendEvent: (_, value, _) =>
            {
                if (JsonSerializer.SerializeToElement(value, json).GetProperty("type").GetString() == "resultSet.opened") opened.TrySetResult();
            });
            var pending = Query("SELECT 1; RAISERROR('ready',0,1) WITH NOWAIT; WAITFOR DELAY '00:00:05'; SELECT 2;", queryId: id, context: context);
            await opened.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await service.DispatchAsync("query.cancel", JsonSerializer.SerializeToElement(new CancelArgs(id), json), json);
            var cancelled = await pending;
            check(cancelled.Status == "cancelled" && cancelled.ClientStatistics is not null, "cancelled execution retains its own partial statistics");
            var after = await Query(sql);
            check(Counter(after, "SelectRows") == 3 && Counter(after, "ServerRoundtrips") == 1, "statistics after cancel exclude prior attention and rows");
            var plan = await Query(sql, plan: true);
            check(Counter(plan, "ServerRoundtrips") == 1 && Counter(plan, "BytesSent") == Counter(first, "BytesSent"), "actual plan observer traffic stays outside query statistics");
            var timeout = await Query("WAITFOR DELAY '00:00:05';", timeout: 1);
            check(timeout.Status == "timedOut" && timeout.ClientStatistics is not null, "timeout keeps partial statistics");
        }
        finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(session), json), json); }
    }
}
