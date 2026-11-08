using System.Text.Json;
using Varia.Backend.Plans;

namespace Varia.Backend.Tests;

internal static class PlanDiagnosticLiveChecks
{
    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        var session = Guid.NewGuid().ToString();
        Task<object> Call(string method, object value) => service.DispatchAsync(method, JsonSerializer.SerializeToElement(value, json), json);
        async Task<QueryResult> Run(string sql, bool capture = false) => (QueryResult)await Call("query.execute", new QueryArgs(info.Id, session, "tempdb", sql,
            Guid.NewGuid().ToString(), 1, 60, IncludeActualPlan: capture));
        List<PlanStatement> Statements(QueryResult result) => (result.PlanSets ?? []).SelectMany(set =>
            PlanParser.Parse(new StringReader(LiveResultChecks.RowsOf(service.Results, set)[0][0]!)).Statements).ToList();
        try
        {
            var setup = await Run("CREATE TABLE #diagnostic(n int NOT NULL, pad char(256) NOT NULL); "
                + "INSERT #diagnostic SELECT TOP (60000) ROW_NUMBER() OVER (ORDER BY a.object_id,b.object_id), CONVERT(char(256), HASHBYTES('SHA2_256',CONCAT(a.object_id,':',b.object_id)),2) "
                + "FROM sys.all_objects a CROSS JOIN sys.all_objects b; CREATE INDEX ix_diagnostic ON #diagnostic(n);");
            check(setup.Status == "completed", "diagnostic capture creates only session-local fixture data");
            var selected = await Run("EXEC sp_executesql N'SELECT n,pad FROM #diagnostic WHERE n=@p AND pad<>'''' OPTION(MAXDOP 2)',N'@p int',@p=123;\nGO 2", true);
            var seeks = Statements(selected);
            check(selected.Status == "completed" && selected.PlanSets?.Select(p => p.Iteration).Distinct().Count() == 2
                && seeks.SelectMany(s => s.Nodes).Any(n => n.Diagnostics.Predicates.Any(p => p.Kind.StartsWith("Seek", StringComparison.Ordinal) && p.Columns.Count > 0)),
                "real parameterized seek diagnostics survive repeated GO executions and actual capture");
            check(seeks.Any(s => s.Diagnostics.Parameters.Any(p => p.Name == "@p" && p.RuntimeValue is not null))
                && seeks.SelectMany(s => s.Nodes).Any(n => n.Diagnostics.OutputColumns.Count > 0 && n.Diagnostics.Threads.Count > 0),
                "real actual XML exposes parameters, output columns and thread counters");
            var sorted = await Run("SELECT n,pad FROM #diagnostic ORDER BY pad,n OPTION(MAX_GRANT_PERCENT=0.01,MAXDOP 2,RECOMPILE);", true);
            var statements = Statements(sorted);
            check(sorted.Status == "completed" && statements.Any(s => s.Diagnostics.MemoryGrant.Count > 0)
                && statements.SelectMany(s => s.Nodes).Any(n => n.Diagnostics.Spills.Count > 0), "real constrained-memory sort exposes memory grant and spill details");
            foreach (var node in statements.SelectMany(s => s.Nodes).Where(n => n.Diagnostics.Threads.Count > 0))
            {
                var threads = node.Diagnostics.Threads;
                check(node.ActualRows == (threads.All(t => t.Rows.HasValue) ? threads.Sum(t => t.Rows!.Value) : null)
                    && node.CpuMs == (threads.All(t => t.CpuMs.HasValue) ? threads.Sum(t => t.CpuMs!.Value) : null)
                    && node.ElapsedMs == (threads.All(t => t.ElapsedMs.HasValue) ? threads.Max(t => t.ElapsedMs!.Value) : null),
                    "real operator aggregates equal cumulative worker rows/CPU and maximum worker elapsed");
            }
            Console.WriteLine("Diagnostic actual capture: " + statements.Sum(s => s.Nodes.Count) + " operators; "
                + statements.SelectMany(s => s.Nodes).Count(n => n.Diagnostics.Parallel == true) + " parallel; "
                + statements.SelectMany(s => s.Nodes).Sum(n => n.Diagnostics.Spills.Count) + " spill records.");
        }
        finally { await Call("query.session.close", new SessionArgs(session)); }
    }
}
