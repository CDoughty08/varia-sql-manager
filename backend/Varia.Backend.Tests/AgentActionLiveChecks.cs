using System.Text.Json;
using Varia.Backend.Agent;

namespace Varia.Backend.Tests;

/// <summary>Live checks of AG-2's verbs, part of the Agent suite. The job verbs (VARIA_TEST_SQL_AGENT=1 with VARIA_TEST_SQL_SCRATCH=1) run on
/// this run's scratch job through actions.describe and actions.execute: Start Job at Step's facts, Stop on an idle job (JOB_STATE),
/// Disable and Enable, a stale identity (NOT_FOUND), Rename and back, Start, and Delete. The service verbs are the AgentService suite
/// (VARIA_TEST_SQL_AGENT_SERVICE=1), which only `--live-suite AgentService` runs (npm run backend:test:agent-service, under the exclusive
/// machine lock, and .github/workflows/agent-service.yml on Windows): it stops, starts and restarts the server's real SQL Server Agent
/// through the Service Control Manager and leaves it running.</summary>
internal static class AgentActionLiveChecks
{
    /// <summary>Whether this run may stop and start the server's SQL Server Agent (VARIA_TEST_SQL_AGENT_SERVICE=1).</summary>
    public static bool ServiceRequired => Environment.GetEnvironmentVariable("VARIA_TEST_SQL_AGENT_SERVICE") == "1";

    private static string Quote(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Steps(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title)) + (result.Error is { } error ? " " + error.Code + " " + error.Message : "");

    public static async Task JobVerbsAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, string job, Guid id, Func<string, string, Task<SqlRun>> sql)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        ObjectRefDto Job(string name) => new("agentJob", Name: name);
        Task<ActionExecuteResult> Execute(string action, string name, string created, string? newName = null, string? stepName = null) =>
            Call<ActionExecuteResult>("actions.execute", new ActionArgs(action, info.Id, Guid.NewGuid().ToString(), Job(name), NewName: newName, AgentIdentity: new(created), StepName: stepName));
        async Task<string?> Enabled() => (await sql("SELECT CONVERT(nvarchar(1), enabled) FROM msdb.dbo.sysjobs WHERE job_id = '" + id.ToString("D") + "';", "msdb")).Scalar;

        // The service verbs' host read runs on every server, so the Linux live job parses it too (only Windows runs the service verbs).
        var host = await sql(AgentSql.ServiceHost, "master");
        check(host.Status == "completed" && host.Sets is [[[_, _, "0" or "1"], ..], ..], "the service verbs' host read (machine, instance, IsClustered) runs on this server: " + host.Error);

        var created = (await sql("SELECT CONVERT(char(19), date_created, 126) FROM msdb.dbo.sysjobs WHERE job_id = '" + id.ToString("D") + "';", "msdb")).Scalar ?? "";
        var described = await Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "startJobAtStep", Job(job)));
        check(described is { Error: null, AgentJob: { Enabled: true, Running: false, StepsTruncated: false, Steps: [{ Id: 1, Name: "Step 1" }] } facts } && facts.AgentIdentity.Created == created && facts.Name == job,
            "Start Job at Step describes the scratch job: enabled, idle, its one step, and the creation time the tree lists: " + JsonSerializer.Serialize(described.AgentJob) + " " + described.Error?.Message);

        // Agent's message 22022 on an idle job is read again: the job is idle, so JOB_STATE in Varia's words.
        var idle = await Execute("stopJob", job, created);
        check(idle.Error?.Code == "JOB_STATE", "Stop Job on an idle job answers JOB_STATE: " + Steps(idle));

        var disabled = await Execute("disable", job, created);
        var off = await Enabled();
        var enabled = await Execute("enable", job, created);
        var on = await Enabled();
        check(disabled.Error is null && off == "0" && enabled.Error is null && on == "1", "a job's Disable and Enable change sysjobs.enabled: " + Steps(disabled) + " / " + Steps(enabled));

        // A job created at another time under the name is not the one the tree read: refused before msdb runs anything.
        var stale = await Execute("disable", job, "2000-01-01T00:00:00");
        check(stale.Error?.Code == "NOT_FOUND" && await Enabled() == "1", "a job's verb with a stale identity is refused NOT_FOUND and changes nothing: " + Steps(stale));

        var renamedName = job + "_r";
        var renamed = await Execute("rename", job, created, newName: renamedName);
        var named = (await sql("SELECT name FROM msdb.dbo.sysjobs WHERE job_id = '" + id.ToString("D") + "';", "msdb")).Scalar;
        var back = await Execute("rename", renamedName, created, newName: job);
        check(renamed.Error is null && named == renamedName && back.Error is null, "a job's Rename runs sp_update_job @new_name and keeps the job's identity: " + Steps(renamed) + " / " + Steps(back));

        var started = await Execute("startJob", job, created);
        check(started.Error is null && started.Steps is [{ Status: "done" }], "Start Job asks SQL Server Agent to start the job: " + Steps(started));
        // Wait for the run to end before Delete, so it deletes an idle job (Agent's own session's activity row has a stop time).
        var deadline = Environment.TickCount64 + 30_000;
        while (Environment.TickCount64 < deadline)
        {
            var running = await sql("SELECT COUNT(*) FROM msdb.dbo.sysjobactivity AS a WHERE a.job_id = '" + id.ToString("D") + "' AND a.session_id = (SELECT MAX(s.session_id) FROM msdb.dbo.syssessions AS s) "
                + "AND a.start_execution_date IS NOT NULL AND a.stop_execution_date IS NULL;", "msdb");
            if (running.Scalar == "0") break;
            await Task.Delay(250);
        }

        var target = await Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "deleteObject", Job(job)));
        var deleted = await Call<ActionExecuteResult>("actions.execute", new ActionArgs("delete", info.Id, Guid.NewGuid().ToString(), Job(job), CloseConnections: false, DeleteHistory: true,
            AgentIdentity: target.DeleteTarget?.AgentIdentity ?? new(created), DeleteUnusedSchedule: true));
        var gone = (await sql("SELECT COUNT(*) FROM msdb.dbo.sysjobs WHERE job_id = '" + id.ToString("D") + "';", "msdb")).Scalar;
        check(target.DeleteTarget?.AgentIdentity?.Created == created && deleted.Error is null && gone == "0",
            "Delete Object describes the job with its identity and deletes it with its history: " + Steps(deleted) + " " + target.Error?.Message);
    }

    /// <summary>Stop, Start and Restart of the server's real SQL Server Agent through actions.execute, each confirmed by the Service Control
    /// Manager's state in the reply and by Agent's sessions in SQL Server. Windows only (the workflow's named instance).</summary>
    public static async Task ServiceAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        if (!ServiceRequired)
        {
            Console.WriteLine("SQL Server Agent service control checks skipped. Set VARIA_TEST_SQL_AGENT_SERVICE=1 on a disposable Windows server whose Agent this account may stop and start.");
            return;
        }
        if (!OperatingSystem.IsWindows()) { check(false, "VARIA_TEST_SQL_AGENT_SERVICE=1 needs the checks to run on Windows"); return; }
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<SqlRun> Sql(string text, string database)
        {
            var session = Guid.NewGuid().ToString();
            try
            {
                var result = await Call<QueryResult>("query.execute", new QueryArgs(info.Id, session, database, text, Guid.NewGuid().ToString(), 1000, 60, StopOnError: true));
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await Call<object>("query.session.close", new SessionArgs(session)); }
        }
        Func<string, string, Task<SqlRun>> sql = Sql;
        var wait = (int)AgentCatalog.Current.Limit("agentUpWaitMs");
        var upFirst = await AgentLiveChecks.UpAsync(sql, wait);
        check(upFirst, "SQL Server Agent is up before the service checks, within " + wait / 1000 + " s");
        if (!upFirst) return;
        Task<ActionExecuteResult> Run(string action) => Call<ActionExecuteResult>("actions.execute", new ActionArgs(action, info.Id, Guid.NewGuid().ToString(), new ObjectRefDto("agent")));

        var described = await Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "stopAgent", new ObjectRefDto("agent")));
        check(described is { Error: null, AgentService: { State: "running" } facts } && (facts.Service.StartsWith("SQLAgent$", StringComparison.Ordinal) || facts.Service == "SQLSERVERAGENT"),
            "Stop SQL Server Agent describes the service on the server's machine, running: " + JsonSerializer.Serialize(described.AgentService) + " " + described.Error?.Message);
        try
        {
            var stopped = await Run("stopAgent");
            var down = !await AgentLiveChecks.UpAsync(sql, 0);
            check(stopped is { Error: null, AgentService: "stopped" } && down, "Stop SQL Server Agent stops the service and waits for Stopped: " + Steps(stopped));
            var startedAgain = await Run("startAgent");
            var up = await AgentLiveChecks.UpAsync(sql, wait);
            check(startedAgain is { Error: null, AgentService: "running" } && up, "Start SQL Server Agent starts it and waits for Running, and Agent connects again: " + Steps(startedAgain));
            var restarted = await Run("restartAgent");
            var upAgain = await AgentLiveChecks.UpAsync(sql, wait);
            check(restarted is { Error: null, AgentService: "running" } && restarted.Steps.Count == 4 && restarted.Steps.All(step => step.Status == "done") && upAgain,
                "Restart SQL Server Agent stops it, waits, starts it and waits, four steps, and Agent connects again: " + Steps(restarted));
            var again = await Run("startAgent");
            check(again.Error is null && again.AgentService == "running", "Start on a running Agent is not a failure: " + Steps(again));
        }
        finally
        {
            // Leave Agent running for whatever runs next on this server, whatever failed above.
            if (!await AgentLiveChecks.UpAsync(sql, 0)) await Run("startAgent");
        }
    }
}
