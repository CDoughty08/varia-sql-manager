using System.Data;
using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Live;

namespace Varia.Backend.Plans;

internal sealed record LivePlanArgs(string QueryId);
internal sealed record LivePlanTarget(int Spid, Guid ServerConnectionId, string Database, int Batch, int Iteration);
internal sealed record LivePlanCounter(string Id, double? Rows, double? ElapsedMs, double? CpuMs, double? Executions);
internal sealed record LivePlanFrame(int Batch, int Iteration, int Revision, PlanDocument? Document, List<LivePlanCounter> Counters);

/// <summary>The live scheduler owns timing, gates and credit. No timer or work runs in the executing session.
/// Reading XML works with lightweight profiling without the additional database privileges of query_profiles.</summary>
internal sealed class LivePlanSampler(ILiveHost host, LiveGates gates, string connectionId, LivePlanArgs args) : ILiveSampler
{
    internal const string Probe = "query.plan.operators";
    private const int MaxXml = 1_048_576, MaxPayload = 196_608, MaxNodes = 2000;
    private string topology = "";
    private int revision;
    private bool seen;
    public int? PeriodMs => null;
    public bool Ended { get; private set; }
    public static LivePlanArgs Check(LivePlanArgs args) => Guid.TryParseExact(args.QueryId, "D", out _) ? args
        : throw new RequestException("INVALID_PARAMS", "A valid query id is required.");
    public Task<LiveOpening> OpenAsync(IReadOnlyList<LiveProbeState> probes, IReadOnlyList<LiveCursor> resume, CancellationToken token)
    {
        var profile = host.Profile(connectionId);
        var unsupported = profile is null || profile.Major < 14 && profile.EngineEdition is not (5 or 8) || profile.EngineEdition is not (1 or 2 or 3 or 4 or 5 or 8);
        return Task.FromResult(new LiveOpening([.. probes.Select(p => new LiveOpenedProbe(p.Spec.Id, p.IntervalMs, p.Spec.IntervalMs.Min, p.Spec.IntervalMs.Max,
            unsupported ? "unavailable" : "ok", unsupported ? "NOT_SUPPORTED" : null,
            unsupported ? "Live Plan requires SQL Server 2017 CU14 or later, or Azure SQL, with lightweight profiling available." : null))]));
    }

    public async Task<LiveSampleBatch> SampleAsync(IReadOnlyList<LiveDue> due, CancellationToken token)
    {
        var clock = Stopwatch.StartNew();
        var target = host.QueryPlan(connectionId, args.QueryId);
        if (target is null)
        {
            Ended = seen;
            return Phase(seen ? "ended" : "waiting");
        }
        seen = true;
        using var budget = CancellationTokenSource.CreateLinkedTokenSource(token);
        budget.CancelAfter(due[0].BudgetMs);
        try
        {
            using var lease = await gates.WaitAsync(connectionId, due[0].BudgetMs, budget.Token)
                ?? throw new RequestException("BUSY", LiveErrors.BusyMessage);
            // Server scope uses the existing monitor pool in master where permitted. Never leave a pooled observer
            // holding the user's database after a run; Azure/contained logins keep their own database scope.
            var database = host.Profile(connectionId)?.EngineEdition == 5 ? target.Database : null;
            await using var observer = host.PoolConnection(connectionId, database, LiveConnections.ServerSuffix);
            await host.OpenAsync(observer, budget.Token);
            await using var command = observer.CreateCommand();
            command.CommandTimeout = 0;
            var profile = host.Profile(connectionId);
            var scope = profile?.EngineEdition == 5 ? "DB_NAME(),'DATABASE','VIEW DATABASE STATE'"
                : profile?.Major >= 16 ? "NULL,NULL,'VIEW SERVER PERFORMANCE STATE'" : "NULL,NULL,'VIEW SERVER STATE'";
            // A SPID alone is reusable. The physical connection and the backend's immutable batch token must both match.
            command.CommandText = LiveSql.UncommittedPrologue + $"""
                IF ISNULL(HAS_PERMS_BY_NAME({scope}),0)<>1 SELECT CAST(0 AS int);
                ELSE BEGIN
                SELECT CAST(1 AS int);
                SELECT CONVERT(nvarchar(max),q.query_plan)
                FROM sys.dm_exec_requests r JOIN sys.dm_exec_connections c ON r.connection_id=c.connection_id
                CROSS APPLY sys.dm_exec_query_statistics_xml(r.session_id) q
                WHERE r.session_id=@spid AND c.connection_id=@client AND q.request_id=r.request_id;
                END;
                """;
            command.Parameters.Add("@spid", SqlDbType.Int).Value = target.Spid;
            command.Parameters.Add("@client", SqlDbType.UniqueIdentifier).Value = target.ServerConnectionId;
            using var cancel = budget.Token.Register(() => { try { command.Cancel(); } catch (Exception e) when (e is SqlException or InvalidOperationException) { } });
            await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, budget.Token);
            if (!await reader.ReadAsync(budget.Token) || reader.GetInt32(0) != 1)
                return Error("PERMISSION_DENIED", profile?.EngineEdition == 5 ? "Live Plan requires VIEW DATABASE STATE or an administrator on this Azure SQL tier." : LiveErrors.PermissionMessage);
            await reader.NextResultAsync(budget.Token);
            if (!await reader.ReadAsync(budget.Token) || await reader.IsDBNullAsync(0, budget.Token)) return Phase("waiting");
            using var text = reader.GetTextReader(0);
            var xml = new StringBuilder();
            var buffer = new char[8192];
            int length;
            while ((length = await text.ReadAsync(buffer.AsMemory(), budget.Token)) > 0)
            {
                if (xml.Length + length > MaxXml) return Error("NOT_SUPPORTED", "This live plan exceeds the 1,048,576-character sampling limit. Captured actual plans remain available after execution.");
                xml.Append(buffer, 0, length);
            }
            var document = PlanParser.Parse(new StringReader(xml.ToString()), budget.Token);
            if (!ReferenceEquals(target, host.QueryPlan(connectionId, args.QueryId))) return Phase("waiting");
            var nodes = document.Statements.SelectMany(s => s.Nodes).ToList();
            if (nodes.Count > MaxNodes) return Error("NOT_SUPPORTED", "Live Plan supports up to 2,000 operators. Captured actual plans remain available after execution.");
            // Per-thread raw properties would become stale in counter-only frames. Live exposes current aggregate
            // counters; captured actual XML retains the full thread details at completion.
            foreach (var node in nodes) node.Properties.RemoveAll(p => p.Name.StartsWith("RunTimeCountersPerThread", StringComparison.Ordinal));
            var signature = Signature(target, document);
            var changed = signature != topology;
            var counters = nodes.Select(n => new LivePlanCounter(n.Id, n.ActualRows, n.ElapsedMs, n.CpuMs, n.Executions)).ToList();
            var frame = new LivePlanFrame(target.Batch, target.Iteration, changed ? revision + 1 : revision, changed ? document : null, counters);
            if (JsonSerializer.SerializeToUtf8Bytes(frame).Length > MaxPayload) return Error("NOT_SUPPORTED", "This live plan exceeds the sampling payload limit. Captured actual plans remain available after execution.");
            if (changed) { topology = signature; revision++; }
            return new([new(Probe, (int)clock.ElapsedMilliseconds, 0, Plan: frame, Status: [new("phase", "running")])], []);
        }
        catch (SqlException error) { return new([], [LiveErrors.From(Probe, error)]); }
        catch (OperationCanceledException) when (!token.IsCancellationRequested) { return Error("TIMEOUT", LiveErrors.TimeoutMessage); }
        catch (RequestException error) when (error.Code is "AUTH_ENTRA" or "AUTH_KERBEROS") { return new([], [LiveErrors.SignIn(Probe, error)]); }
        catch (RequestException error) when (error.Code == "NOT_CONNECTED") { throw; }
        catch (RequestException error) { return Error(error.Code == "BUSY" ? "BUSY" : "NOT_SUPPORTED", error.Code == "BUSY" ? LiveErrors.BusyMessage : "The server could not provide a live plan within the sampling limits."); }
        catch (InvalidOperationException) { return Error("CONNECTION_LOST", LiveErrors.LostMessage); }
        catch (IOException) { return Error("CONNECTION_LOST", LiveErrors.LostMessage); }

        LiveSampleBatch Phase(string phase) => new([new(Probe, (int)clock.ElapsedMilliseconds, 0, Status: [new("phase", phase)])], []);
        LiveSampleBatch Error(string code, string message) => new([], [LiveErrors.Create(Probe, code, message)]);
    }
    public void Apply(object value) { if (value is not LivePlanArgs next || next != args) throw new RequestException("INVALID_PARAMS", "A live plan cannot change its query identity."); }
    internal static string Signature(LivePlanTarget target, PlanDocument document) => JsonSerializer.Serialize(new
    {
        target.Batch, target.Iteration,
        Statements = document.Statements.Select(s => new
        {
            s.Id, s.StatementId, s.QueryHash, s.Text,
            Nodes = s.Nodes.Select(n => new
            {
                n.Id, n.ParentId, n.PhysicalOp, n.LogicalOp, n.Object, n.EstimatedRows, n.EstimatedCost,
                Literals = n.Properties.Where(p => p.Name is "ScalarOperator.ScalarString" or "Const.ConstValue")
            })
        })
    });
    public uint[] Keep() => [];
    public void Release() { }
    public void Dispose() { }
}
