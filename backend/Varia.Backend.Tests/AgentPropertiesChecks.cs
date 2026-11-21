using Microsoft.Data.SqlClient;
using Varia.Backend;
using Varia.Backend.Actions;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;

namespace Varia.Backend.Tests;

/// <summary>SQL Server Agent Properties (AG-8a), offline: the server-scope write lint and its near misses, the action's validation, its plans and
/// scripts, and Managed Instance's refusal before any connection opens.</summary>
internal static class AgentPropertiesChecks
{
    private static readonly ServerProfile Box2022 = new(16, "16.0.4135.4", 3, "sa", false, true, false, 16);
    private static readonly ObjectRefDto AgentNode = new("agent");

    private sealed class Host(ServerProfile profile) : IActionHost
    {
        public int Connections;
        public ServerProfile Profile(string connectionId) => profile;
        public SqlConnection Connection(string connectionId)
        {
            Interlocked.Increment(ref Connections);
            return new SqlConnection("Data Source=" + Unreachable.Source + ";Connect Timeout=1;Pooling=false;Encrypt=false");
        }
        public Task OpenAsync(SqlConnection connection, CancellationToken token) => connection.OpenAsync(token);
        public bool ClearPoolsFor(string connectionId, string database) => true;
        public bool FreeDatabase(string connectionId, string database) => true;
        public IReadOnlySet<int> PoolSessions(string connectionId) => new HashSet<int>();
        public IReadOnlyList<string> SameServer(string connectionId) => [connectionId];
        public void DatabaseChanged(string connectionId, string database, string? newName) { }
    }

    private static ActionArgs Args(AgentPropertiesChangesDto? changes = null, AgentHistoryPurgeDto? purge = null, ObjectRefDto? target = null) =>
        new("agentProperties", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), target ?? AgentNode) { AgentProperties = changes, AgentPurge = purge };

    public static async Task RunAsync(Action<bool, string> check)
    {
        Lint(check);
        Validation(check);
        PlansAndScripts(check);
        await ManagedInstanceAsync(check);
    }

    private static void Lint(Action<bool, string> check)
    {
        var results = AgentSql.LintServerWrites().ToList();
        var failures = results.Where(item => item.Problems.Count > 0).Select(item => item.Name + ": " + string.Join(", ", item.Problems)).ToList();
        check(failures.Count == 0 && results.Count == AgentSql.ServerWrites.Count + 2, "SQL Server Agent Properties' two server writes and its two reads pass their lint" + (failures.Count == 0 ? "" : ": " + string.Join("; ", failures)));
        check(AgentSql.LintWrites().Count(item => item.Name.StartsWith("server write ", StringComparison.Ordinal)) == AgentSql.ServerWrites.Count, "the Agent write lint (and so the object actions' lint) runs the server writes too");
        var set = AgentSql.SetProperties.Text;
        var purge = AgentSql.PurgeHistory.Text;
        string Server(string call) => AgentSql.ServerHead + call + AgentSql.Check;
        string Purge(string call) => AgentSql.PurgeHead + AgentSql.PurgeCutoff + AgentSql.PurgeGuard + call + AgentSql.Check;
        var misses = new (string Text, string Problem)[]
        {
            (Server("EXEC @rc = msdb.dbo.sp_purge_jobhistory @oldest_date = @oldest_date;"), "purges history without the guarded cut-off"),
            (purge.Replace(AgentSql.PurgeGuard, "", StringComparison.Ordinal), "does not compute and guard the cut-off before the purge"),
            (Purge("EXEC @rc = msdb.dbo.sp_purge_jobhistory @job_id = @job_id;"), "names a job in a server write"),
            (Purge("EXEC @rc = msdb.dbo.sp_set_sqlagent_properties @jobhistory_max_rows = @jobhistory_max_rows;"), "computes a cut-off for sp_set_sqlagent_properties"),
            (Server("EXEC @rc = msdb.dbo.sp_set_sqlagent_properties @errorlog_file = @errorlog_file;"), "passes @errorlog_file to sp_set_sqlagent_properties"),
            (Server("EXEC @rc = msdb.dbo.sp_set_sqlagent_properties @jobhistory_max_rows = @jobhistory_max_rows_per_job;"), "passes @jobhistory_max_rows another parameter's value"),
            (Server("EXEC @rc = msdb.dbo.sp_set_sqlagent_properties @monitor_autostart = @monitor_autostart, @monitor_autostart = @monitor_autostart;"), "passes @monitor_autostart twice"),
            (Server("EXEC @rc = msdb.dbo.sp_set_sqlagent_properties @monitor_autostart = 1;"), "is not one msdb call in the server write shape"),
            (Server("EXEC @rc = msdb.dbo.sp_set_sqlagent_properties @monitor_autostart = @monitor_autostart; DROP TABLE dbo.t;"), "is not one msdb call in the server write shape"),
            (Server("EXEC @rc = msdb.dbo.sp_add_job @job_name = @job_name;"), "EXECs sp_add_job, which is not an Agent write procedure"),
            (Server("EXEC @rc = master.dbo.xp_servicecontrol @a = @a;"), "uses xp_servicecontrol"),
            (set[AgentSql.ServerHead.Length..], "does not open with the server write's declaration"),
            (set[..^AgentSql.Check.Length] + ";", "does not check the return code last")
        };
        foreach (var (text, problem) in misses) check(AgentSql.LintServerExecutable(text).Contains(problem), "the server write lint refuses a write that " + problem);
        check(AgentSql.LintExecutable(AgentSql.Resolve + "EXEC @rc = msdb.dbo.sp_purge_jobhistory @job_id = @job_id;" + AgentSql.Check).Count > 0,
            "a job-shaped write may not purge with this lane's arguments: sp_purge_jobhistory takes only @oldest_date until Delete History adds its own template");
        check(purge.Contains("IF @oldest_date IS NULL THROW 50013", StringComparison.Ordinal) && purge.IndexOf("THROW 50013", StringComparison.Ordinal) < purge.IndexOf("sp_purge_jobhistory", StringComparison.Ordinal)
            && purge.Contains("DATEADD(month, -@count, GETDATE())", StringComparison.Ordinal),
            "the purge computes its cut-off from the server's own clock and THROWs before the call when it is NULL, which msdb would read as all history");
        check(ActionErrors.Numbers["PERMISSION_DENIED"].Contains(14392), "sp_purge_jobhistory's 14392 (not sysadmin or SQLAgentOperatorRole) maps to PERMISSION_DENIED");
    }

    private static void Validation(Action<bool, string> check)
    {
        using var service = new ActionService(new Host(Box2022));
        string Answer(ActionArgs args, bool script = false)
        {
            try { service.Validate(args, script); return "accepted"; }
            catch (RequestException error) { return error.Code; }
        }
        var valid = new (string Name, ActionArgs Args)[]
        {
            ("a restart box", Args(new(false, null, null, null))), ("the sizes", Args(new(null, null, 5000, 500))), ("no limit", Args(new(null, null, -1, null))),
            ("the largest log", Args(new(null, null, 999_999, 999_999))), ("a purge", Args(purge: new(4, 2))), ("the longest purge", Args(purge: new(999, 3)))
        };
        foreach (var (name, args) in valid) check(Answer(args) == "accepted" && Answer(args, script: true) == "accepted", "SQL Server Agent Properties validates: " + name);
        var invalid = new (string Name, ActionArgs Args)[]
        {
            ("nothing", Args()), ("both", Args(new(true, null, null, null), new(1, 1))), ("no change", Args(new(null, null, null, null))),
            ("a log of 0 rows", Args(new(null, null, 0, null))), ("a log of 1 row", Args(new(null, null, 1, null))), ("a log of -2", Args(new(null, null, -2, null))),
            ("a log past the cap", Args(new(null, null, 1_000_000, null))), ("rows per job without a limit", Args(new(null, null, -1, 10))),
            ("rows per job above the log", Args(new(null, null, 100, 101))), ("rows per job of 0", Args(new(null, null, 10, 0))), ("rows per job without the log size", Args(new(null, null, null, 10))),
            ("a purge of 0", Args(purge: new(0, 1))), ("a purge past the cap", Args(purge: new(1000, 3))), ("a purge unit of 4", Args(purge: new(1, 4))),
            ("a job's target", Args(purge: new(1, 1), target: new ObjectRefDto("agentJob", Name: "Nightly"))), ("a named agent", Args(purge: new(1, 1), target: new ObjectRefDto("agent", Name: "x"))),
            ("another member", Args(purge: new(1, 1)) with { NewName = "x" }),
            ("the members on another action", new ActionArgs("restartAgent", Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), AgentNode) { AgentPurge = new(1, 1) })
        };
        foreach (var (name, args) in invalid) check(Answer(args) == "INVALID_PARAMS", "SQL Server Agent Properties is refused: " + name);
    }

    private static void PlansAndScripts(Action<bool, string> check)
    {
        check(ActionService.AgentPropertiesPlan(Args(new(true, false, null, null))) is { Write: var set, Title: ActionService.SavePropertiesStep, Values: [1, 0, null, null] } && set == AgentSql.SetProperties
            && ActionService.AgentPropertiesPlan(Args(new(null, null, 5000, 500))).Values is [null, null, 5000, 500]
            && ActionService.AgentPropertiesPlan(Args(purge: new(6, 3))) is { Write: var purge, Title: ActionService.PurgeHistoryStep, Values: [6, 3] } && purge == AgentSql.PurgeHistory,
            "OK sends the changed settings, NULL for those that stay; Delete old history sends its count and unit for the server to compute the cut-off");
        check(ActionService.AgentPropertiesScript(Args(new(null, false, 5000, 500))) == "USE [msdb]\nGO\nEXEC msdb.dbo.sp_set_sqlagent_properties @monitor_autostart=0, @jobhistory_max_rows=5000, @jobhistory_max_rows_per_job=500\nGO\n"
            && ActionService.AgentPropertiesScript(Args(new(null, null, -1, null))) == "USE [msdb]\nGO\nEXEC msdb.dbo.sp_set_sqlagent_properties @jobhistory_max_rows=-1\nGO\n"
            && ActionService.AgentPropertiesScript(Args(purge: new(4, 2))) == "USE [msdb]\nGO\nDECLARE @oldest_date datetime = DATEADD(week, -4, GETDATE());\nEXEC msdb.dbo.sp_purge_jobhistory @oldest_date=@oldest_date\nGO\n",
            "Script writes the changed arguments as SSMS does, and the purge with the cut-off from the server's clock");
    }

    private static async Task ManagedInstanceAsync(Action<bool, string> check)
    {
        var host = new Host(Box2022 with { EngineEdition = 8 });
        using var service = new ActionService(host);
        var executed = await service.ExecuteAsync(Args(new(true, null, null, null)), CancellationToken.None);
        var scripted = await service.ScriptAsync(Args(purge: new(1, 1)), CancellationToken.None);
        check(executed.Error is { Code: "NOT_SUPPORTED" } && executed.Error.Message == ActionService.AgentPropertiesManagedInstance && scripted.Error is { Code: "NOT_SUPPORTED" } && host.Connections == 0,
            "Managed Instance refuses sp_set_sqlagent_properties, so the action and its Script answer NOT_SUPPORTED before any connection opens");
    }
}
