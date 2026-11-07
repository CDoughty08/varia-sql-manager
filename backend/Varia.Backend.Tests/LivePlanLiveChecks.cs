using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Live;
using Varia.Backend.Plans;
using Varia.Backend.Protocol;

namespace Varia.Backend.Tests;

internal static class LivePlanLiveChecks
{
    private sealed class ObserverHost(ILiveHost inner, string mode) : ILiveHost
    {
        public bool TestHooks => false;
        public bool IsConnected(string id) => inner.IsConnected(id);
        public string? ServerOf(string id) => inner.ServerOf(id);
        public Results.ResultStore Store => inner.Store;
        public Explorer.ServerProfile? Profile(string id) => mode == "old" ? inner.Profile(id)! with { Major = 13 }
            : mode == "azure" ? inner.Profile(id)! with { Major = 12, EngineEdition = 5 } : inner.Profile(id);
        public LivePlanTarget? QueryPlan(string connection, string query) => inner.QueryPlan(connection, query) is { } target
            ? mode == "wrong" ? target with { ServerConnectionId = Guid.NewGuid() } : target : null;
        public SqlConnection PoolConnection(string id, string? database, string suffix)
        {
            using var source = inner.PoolConnection(id, database, suffix);
            return new SqlConnection(new SqlConnectionStringBuilder(source.ConnectionString) { Pooling = false }.ConnectionString);
        }
        public async Task OpenAsync(SqlConnection connection, CancellationToken token)
        {
            if (mode == "auth") throw new RequestException("AUTH_ENTRA", "The observer could not sign in.");
            await inner.OpenAsync(connection, token);
            if (mode != "denied") return;
            await using var command = connection.CreateCommand();
            command.CommandText = "EXECUTE AS USER='guest';";
            await command.ExecuteNonQueryAsync(token);
        }
    }
    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        if (((ILiveHost)service).Profile(info.Id) is not { Major: >= 14 }) return;
        var session = Guid.NewGuid().ToString();
        var query = Guid.NewGuid().ToString();
        var subscription = Guid.NewGuid().ToString();
        Task<object> Call(string method, object value) => service.DispatchAsync(method, JsonSerializer.SerializeToElement(value, json), json);
        using var recorder = new LiveRecorder(9800);
        var stream = service.Live.SubscribeAsync(new(subscription, info.Id, "query.plan", [new(LivePlanSampler.Probe, 1000)],
            JsonSerializer.SerializeToElement(new LivePlanArgs(query), json)), recorder.Context, json);
        // A short completed statement for each GO iteration precedes the cancellable, CPU-bound aggregate.
        var execution = Call("query.execute", new QueryArgs(info.Id, session, "master", "SELECT TOP (1) name AS before_live FROM sys.all_objects ORDER BY object_id;\nGO 2\n"
            + "SELECT SUM(CONVERT(bigint,CHECKSUM(HASHBYTES('SHA2_256',CONCAT(a.object_id,':',b.object_id,':',c.object_id))))) AS measured "
            + "FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c OPTION(MAXDOP 2);", query, 100, 40, IncludeLivePlan: true));
        List<LivePlanFrame> Frames() => [.. recorder.Ticks.SelectMany(t => t.Samples).Where(s => s.Plan is not null).Select(s => s.Plan!)];
        try
        {
            var sampled = await recorder.WaitAsync(_ => Frames().Count(f => f.Batch == 2 && f.Iteration == 1) >= 2 || recorder.Ticks.Any(t => t.Errors?.Count > 0), 15_000);
            var frames = Frames().Where(f => f.Batch == 2 && f.Iteration == 1).ToList();
            var errors = string.Join(" | ", recorder.Ticks.SelectMany(t => t.Errors ?? []).Select(e => e.Code + ": " + e.Message));
            check(sampled && frames.Count >= 2 && frames[0].Document is { Statements.Count: > 0 } && frames.Skip(1).Any(f => f.Document is null)
                && frames.All(f => f.Batch == 2 && f.Iteration == 1), "live XML topology then counter-only frames identify the submitted GO batch: " + errors
                + "; frames=" + frames.Count + "; ticks=" + recorder.Ticks.Count + "; opened=" + JsonSerializer.Serialize(recorder.Opened, json)
                + "; phases=" + string.Join(',', recorder.Ticks.SelectMany(t => t.Samples).SelectMany(s => s.Status ?? []).Select(s => s.Value))
                + "; target=" + JsonSerializer.Serialize(((ILiveHost)service).QueryPlan(info.Id, query), json));
            check(frames.Any(f => f.Counters.Any(c => c.Rows > 0)) && frames.Select(f => f.Counters.Sum(c => c.Rows ?? 0)).Distinct().Count() > 1,
                "real live operator counters change while the aggregate runs");
            var host = (ILiveHost)service;
            check(host.QueryPlan(Guid.NewGuid().ToString(), query) is null && host.QueryPlan(info.Id, query) is { Spid: > 0, ServerConnectionId: var client } && client != Guid.Empty,
                "only the run's own connection can resolve the live profiling target");
            var spec = new LiveProbeState(LiveCatalog.Current.Probes[LivePlanSampler.Probe], 1000);
            var due = new LiveDue(spec, null, null, null, null, new Dictionary<int, LiveTrackArgs>(), BudgetMs: 1000);
            using (var denied = new LivePlanSampler(new ObserverHost(host, "denied"), service.Live.Gates, info.Id, new(query)))
            {
                var sample = await denied.SampleAsync([due], CancellationToken.None);
                check(sample.Errors is [{ Code: "PERMISSION_DENIED", Terminal: true }], "restricted real SQL Server observer reports a terminal permission state without affecting the query");
            }
            using (var wrong = new LivePlanSampler(new ObserverHost(host, "wrong"), service.Live.Gates, info.Id, new(query)))
                check((await wrong.SampleAsync([due], CancellationToken.None)).Samples.All(s => s.Plan is null), "a reused SPID with a different server connection never exposes its plan");
            using (var old = new LivePlanSampler(new ObserverHost(host, "old"), service.Live.Gates, info.Id, new(query)))
                check((await old.OpenAsync([spec], [], CancellationToken.None)).Probes is [{ State: "unavailable", Reason: "NOT_SUPPORTED" }], "unsupported SQL Server version opens unavailable without running profiling SQL");
            using (var azure = new LivePlanSampler(new ObserverHost(host, "azure"), service.Live.Gates, info.Id, new(query)))
                check((await azure.OpenAsync([spec], [], CancellationToken.None)).Probes is [{ State: "ok" }], "Azure SQL's reported major version 12 does not trigger the box-server version gate");
            using (var auth = new LivePlanSampler(new ObserverHost(host, "auth"), service.Live.Gates, info.Id, new(query)))
                check((await auth.SampleAsync([due], CancellationToken.None)).Errors is [{ Code: "AUTH_ENTRA" }], "observer authentication failures retain their actionable sign-in state");
            var beforeHold = recorder.Ticks.Count;
            recorder.Acknowledge = false;
            check(await recorder.WaitAsync(_ => recorder.Ticks.Count > beforeHold), "a real live frame arrives before withholding its acknowledgement");
            var held = recorder.Ticks.Count;
            await Task.Delay(1300);
            check(recorder.Ticks.Count == held, "withheld renderer credit stops real SQL sampling and further live frames");
            service.Live.Update(new(subscription, "query.plan", Paused: true), json);
            recorder.Acknowledge = true;
            recorder.Grant();
            await Task.Delay(1300);
            check(recorder.Ticks.Count == held, "a hidden/paused plan view does not sample the executing query");
            service.Live.Update(new(subscription, "query.plan", Paused: false), json);
            check(await recorder.WaitAsync(_ => recorder.Ticks.Count > held), "resuming the plan view continues the same run");
            await Call("query.cancel", new CancelArgs(query));
            var result = (QueryResult)await execution;
            check(result.Status == "cancelled" && result.PlanSets is { Count: > 0 } plans && plans.Where(p => p.BatchNumber == 1).Select(p => p.Iteration).Distinct().Order().SequenceEqual([1, 2]),
                "cancellation keeps actual plans for both completed GO repetitions beside the partial live sample: " + result.Status + "; "
                + string.Join(',', result.PlanSets?.Select(p => p.BatchNumber + ":" + p.Iteration) ?? []) + "; " + string.Join(" | ", LiveResultChecks.Texts(result)));
            check(host.QueryPlan(info.Id, query) is null, "a finished query no longer resolves to a live SPID");
            check((await stream.WaitAsync(TimeSpan.FromSeconds(5))).Ended == "sourceEnded", "live stream ends after its executing query leaves the registry");
        }
        finally
        {
            recorder.Context.Cancel(CancelReason.User);
            await Call("query.cancel", new CancelArgs(query));
            await execution;
            await stream;
            await Call("query.session.close", new SessionArgs(session));
        }
    }
}
