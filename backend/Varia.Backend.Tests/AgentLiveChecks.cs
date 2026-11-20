using System.Text;
using System.Text.Json;
using Microsoft.Data.SqlClient;
using Varia.Backend.Actions;
using Varia.Backend.Agent;
using Varia.Backend.Explorer;
using Varia.Backend.Live;

namespace Varia.Backend.Tests;

/// <summary>Live SQL Server Agent checks (AG-0a's skeleton, VARIA_TEST_SQL_AGENT=1): Agent must come up within the catalogue's
/// wait or the suite fails; then the reader runs every Agent read statement against the real server as sysadmin, each a
/// result or a value; a capped read is cut and cancelled with its connection still usable; with VARIA_TEST_SQL_SCRATCH=1 a
/// scratch job of this run's own runs once and its history, row and activity are read back through msdb's procedures, and
/// a scratch login in SQLAgentUserRole alone (impersonated) is refused the error logs but reads its own jobs and Agent's
/// properties, as AG-0 found. Only this run's job and login are created, each dropped in finally. Later lanes add the
/// Agent, AgentJobs, AgentActions and AgentRoles suites (docs/agent-plan.md › Testing).</summary>
internal static class AgentLiveChecks
{
    /// <summary>Agent is up when Agent XPs is on and an Agent session is connected (Agent starts after the container's health
    /// check passes, so CI waits on this, not on the server).</summary>
    public const string UpSql = "SELECT CONVERT(int, c.value_in_use), (SELECT COUNT(*) FROM sys.dm_exec_sessions AS s WHERE s.program_name LIKE N'SQLAgent - %') "
        + "FROM sys.configurations AS c WHERE c.configuration_id = 16384;";

    /// <summary>Whether this run requires SQL Server Agent (VARIA_TEST_SQL_AGENT=1).</summary>
    public static bool Required => Environment.GetEnvironmentVariable("VARIA_TEST_SQL_AGENT") == "1";

    /// <summary>Waits up to <paramref name="waitMs"/> for <see cref="UpSql"/> to say Agent is up, returning as soon as it does;
    /// 0 checks once.</summary>
    public static async Task<bool> UpAsync(Func<string, string, Task<SqlRun>> sql, int waitMs)
    {
        var deadline = Environment.TickCount64 + waitMs;
        while (true)
        {
            var result = await sql(UpSql, "master");
            if (result.Status == "completed" && result.Sets is [[[var xps, var sessions, ..], ..], ..] && xps == "1" && sessions is not null and not "0") return true;
            if (Environment.TickCount64 >= deadline) return false;
            await Task.Delay(500);
        }
    }

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json)
    {
        if (!Required)
        {
            Console.WriteLine("SQL Server Agent live checks skipped. Set VARIA_TEST_SQL_AGENT=1 on a server whose SQL Server Agent runs (MSSQL_AGENT_ENABLED=true for the Linux container).");
            return;
        }
        async Task<SqlRun> Sql(string text, string database = "master")
        {
            var session = Guid.NewGuid().ToString();
            try
            {
                var result = (QueryResult)await service.DispatchAsync("query.execute", JsonSerializer.SerializeToElement(
                    new QueryArgs(info.Id, session, database, text, Guid.NewGuid().ToString(), 1000, 60, StopOnError: true), json), json);
                return new(result.Status, result.Error?.Message, [.. result.ResultSets.Select(set => LiveResultChecks.RowsOf(service.Results, set))]);
            }
            finally { await service.DispatchAsync("query.session.close", JsonSerializer.SerializeToElement(new SessionArgs(session), json), json); }
        }
        var wait = (int)AgentCatalog.Current.Limit("agentUpWaitMs");
        var up = await UpAsync(Sql, wait);
        check(up, "SQL Server Agent is up (Agent XPs on and an Agent session connected) within " + wait / 1000 + " s, as VARIA_TEST_SQL_AGENT=1 requires");
        if (!up) return;

        var host = (IActionHost)service;
        var profile = host.Profile(info.Id);
        await ProfileAsync(check, service, info, json, profile, Sql);
        await using var connection = host.Connection(info.Id);
        await host.OpenAsync(connection, CancellationToken.None);
        var reader = new AgentReader();
        object? None(AgentStatement statement, AgentParameter parameter) => parameter.Name == "@log" ? 0 : null;
        await ReadsAsync(check, connection, reader, profile, None);
        await CapAsync(check, connection, None);

        if (Environment.GetEnvironmentVariable("VARIA_TEST_SQL_SCRATCH") != "1")
        {
            Console.WriteLine("SQL Server Agent job and role checks skipped. Set VARIA_TEST_SQL_SCRATCH=1 to allow creating and dropping a uniquely named Agent job and login on a disposable development server.");
            return;
        }
        await using var scratch = ScratchDatabase.Bare((text, database) => Sql(text, database));
        // A killed earlier run's job, login user or other Agent object goes first, so this suite alone keeps a shared server clean.
        await ScratchDatabase.SweepAgentAsync(Sql, Console.WriteLine);
        await JobAsync(check, connection, reader, scratch, Sql);
        await RolesAsync(check, connection, reader, scratch, Sql, None, profile.Explorer(ExplorerCatalog.Current).Band);
    }

    /// <summary>Every statement that needs no job, under each caller's prologue: each answers with its declared columns or
    /// fails alone as a value, and none throws.</summary>
    private static async Task ReadsAsync(Action<bool, string> check, SqlConnection connection, AgentReader reader, ServerProfile profile, Func<AgentStatement, AgentParameter, object?> values)
    {
        AgentStatement[] standalone = [AgentSql.State, AgentSql.Jobs, AgentSql.Subsystems, AgentSql.Properties, AgentSql.ErrorLogs, AgentSql.ErrorLog, AgentSql.ServiceState];
        foreach (var (caller, prologue) in AgentSql.Callers)
        {
            var (results, errors) = await reader.ReadAsync(connection, prologue, standalone, values, CancellationToken.None);
            var state = results.GetValueOrDefault("state");
            var subsystems = results.GetValueOrDefault("subsystems")?.Rows.Select(row => row[0] as string).ToList() ?? [];
            var logs = results.GetValueOrDefault("errorLogs")?.Rows.Select(row => Convert.ToInt32(row[0], System.Globalization.CultureInfo.InvariantCulture)).ToList() ?? [];
            // Service control is Windows only; elsewhere the engine may refuse the read, which is a value too. SQL Server 2022 on
            // Linux answers xp_enumerrorlogs 2 with no result set (NOT_SUPPORTED); its current log still reads.
            var service = results.GetValueOrDefault("serviceState")?.Rows.FirstOrDefault()?[0] as string;
            check(state is { Rows: [[1, int sessions]] } && sessions > 0 && results.ContainsKey("jobs") && subsystems.Contains("TSQL") && (profile.Linux || logs.Contains(0)) && results.ContainsKey("errorLog")
                && results.ContainsKey("properties") && (profile.Linux ? service is null or "Running." : service == "Running.")
                && errors.All(error => profile.Linux && (error.Statement == "serviceState" || error is { Statement: "errorLogs", Code: "NOT_SUPPORTED" })),
                "as sysadmin under the " + caller + " caller's prologue, every Agent read answers: Agent XPs on with Agent sessions, the jobs, TSQL among the subsystems, the current error log, "
                + "Agent's properties and the service's Running state (Windows): " + string.Join(", ", errors.Select(error => error.Statement + " " + error.Code + " " + error.Number + (error.Code == "BACKEND_ERROR" ? " (" + error.Message + ")" : ""))) + (service is null ? "" : " service " + service));
        }
    }

    /// <summary>A read at its cap is cut there and the rest cancelled, and the connection runs the next statement.</summary>
    private static async Task CapAsync(Action<bool, string> check, SqlConnection connection, Func<AgentStatement, AgentParameter, object?> values)
    {
        string text;
        using (var stream = typeof(AgentCatalog).Assembly.GetManifestResourceStream("Varia.Backend.Agent.agent-catalog.json")!)
        using (var source = new StreamReader(stream)) text = await source.ReadToEndAsync();
        var limit = "\"listRows\":" + AgentCatalog.Current.Limit("listRows");
        using var small = new MemoryStream(Encoding.UTF8.GetBytes(text.Replace(limit, "\"listRows\":2", StringComparison.Ordinal)));
        var capped = new AgentReader(AgentCatalog.Parse(small));
        var (results, errors) = await capped.ReadAsync(connection, null, [AgentSql.Subsystems, AgentSql.State], values, CancellationToken.None);
        check(text.Contains(limit, StringComparison.Ordinal) && errors.Count == 0 && results["subsystems"] is { Truncated: true, Rows.Count: 2 } && results["state"] is { Truncated: false, Rows.Count: 1 },
            "an Agent read at its cap keeps that many rows, says it was truncated and cancels the rest, and the same connection then runs the next statement");
    }

    /// <summary>A scratch job of this run's own runs once; msdb's procedures then read its row, its activity and its history.</summary>
    private static async Task JobAsync(Action<bool, string> check, SqlConnection connection, AgentReader reader, ScratchDatabase scratch, Func<string, string, Task<SqlRun>> sql)
    {
        var job = scratch.AgentObject("job");
        var created = await sql("DECLARE @id uniqueidentifier;\n"
            + "EXEC msdb.dbo.sp_add_job @job_name = " + Quote(job) + ", @description = " + Quote(ScratchDatabase.JobMarker) + ", @job_id = @id OUTPUT;\n"
            + "EXEC msdb.dbo.sp_add_jobstep @job_id = @id, @step_name = N'Step 1', @subsystem = N'TSQL', @command = N'SELECT 1;';\n"
            + "EXEC msdb.dbo.sp_add_jobserver @job_id = @id;\nSELECT CONVERT(nvarchar(36), @id);", "msdb");
        if (created.Status != "completed" || !Guid.TryParse(created.Scalar, out var id))
        {
            // sp_add_job commits alone, so a later call's failure leaves the job: drop it by its run-unique name.
            await sql("IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = " + Quote(job) + ") EXEC msdb.dbo.sp_delete_job @job_name = " + Quote(job) + ", @delete_history = 1, @delete_unused_schedule = 1;", "msdb");
            check(false, "a scratch Agent job can be created: " + created.Error);
            return;
        }
        try
        {
            var started = await sql("EXEC msdb.dbo.sp_start_job @job_id = '" + id.ToString("D") + "';", "msdb");
            object? Values(AgentStatement statement, AgentParameter parameter) => parameter.Name == "@job_id" ? id : null;
            AgentResult? history = null;
            var deadline = Environment.TickCount64 + 60_000;
            while (started.Status == "completed" && Environment.TickCount64 < deadline)
            {
                // Agent writes the job outcome's history row and the job's last outcome (sysjobservers, Unknown 5 until then) in
                // separate calls, so the wait ends once both are in.
                var (results, _) = await reader.ReadAsync(connection, null, [AgentSql.History, AgentSql.Job], Values, CancellationToken.None);
                history = results.GetValueOrDefault("history");
                var last = results.GetValueOrDefault("job") is { Rows: [var only] } listed ? Convert.ToInt32(listed.Value(only, "last_run_outcome"), System.Globalization.CultureInfo.InvariantCulture) : 5;
                if (last != 5 && history is not null && history.Rows.Any(row => Convert.ToInt32(history.Value(row, "step_id"), System.Globalization.CultureInfo.InvariantCulture) == 0)) break;
                await Task.Delay(500);
            }
            var outcome = history?.Rows.FirstOrDefault(row => Convert.ToInt32(history.Value(row, "step_id"), System.Globalization.CultureInfo.InvariantCulture) == 0);
            var status = outcome is null ? -1 : Convert.ToInt32(history!.Value(outcome, "run_status"), System.Globalization.CultureInfo.InvariantCulture);
            var (rows, errors) = await reader.ReadAsync(connection, null, [AgentSql.Job, AgentSql.Activity], Values, CancellationToken.None);
            var row = rows.GetValueOrDefault("job")?.Rows.SingleOrDefault();
            check(started.Status == "completed" && outcome is not null && AgentCatalog.Current.RunStatuses.GetValueOrDefault(status) == "Succeeded" && history!.Rows.Count == 2
                && errors.Count == 0 && row is not null && (string?)rows["job"].Value(row, "name") == job && Convert.ToInt32(rows["job"].Value(row, "last_run_outcome"), System.Globalization.CultureInfo.InvariantCulture) == 1
                && rows["activity"].Rows.Any(activity => activity[2] is DateTime),
                "a scratch job run once reads back through msdb's procedures: its history's job outcome (step 0) Succeeded with one step row, its row's last outcome Succeeded, and its activity's start time: "
                + started.Error + " " + string.Join(", ", errors.Select(error => error.Statement + " " + error.Code)));
        }
        finally { await sql("EXEC msdb.dbo.sp_delete_job @job_id = '" + id.ToString("D") + "', @delete_history = 1, @delete_unused_schedule = 1;", "msdb"); }
    }

    /// <summary>A login in SQLAgentUserRole alone, impersonated on the reader's connection: the master error-log procedures
    /// are refused as values, while its own (no) jobs and Agent's properties read, as AG-0 found on SQL Server 2025.</summary>
    private static async Task RolesAsync(Action<bool, string> check, SqlConnection connection, AgentReader reader, ScratchDatabase scratch, Func<string, string, Task<SqlRun>> sql,
        Func<AgentStatement, AgentParameter, object?> values, int band)
    {
        var login = scratch.OwnLogin("agu");
        var made = await sql("CREATE LOGIN " + Bracket(login) + " WITH PASSWORD = " + Quote(ScratchDatabase.Throwaway()) + ", CHECK_POLICY = OFF;", "master");
        try
        {
            var mapped = await sql("CREATE USER " + Bracket(login) + " FOR LOGIN " + Bracket(login) + ";\nALTER ROLE SQLAgentUserRole ADD MEMBER " + Bracket(login) + ";", "msdb");
            Dictionary<string, AgentResult> results = [];
            List<AgentReadError> errors = [];
            AgentProfileDto? facts = null, serverFacts = null;
            await Run("EXECUTE AS LOGIN = " + Quote(login) + ";");
            try
            {
                (results, errors) = await reader.ReadAsync(connection, null, [AgentSql.Jobs, AgentSql.Properties, AgentSql.ErrorLogs, AgentSql.ServiceState], values, CancellationToken.None);
                // agent.profile's batch as the explorer pool runs it (in msdb through sp_executesql), under the impersonated login.
                await using var command = new SqlCommand("EXEC msdb.sys.sp_executesql @stmt;", connection);
                command.Parameters.Add(new SqlParameter("@stmt", System.Data.SqlDbType.NVarChar, -1) { Value = AgentProfileSql.Render(new SqlRender(band)) });
                await using (var read = await command.ExecuteReaderAsync()) facts = await AgentProfileSql.ReadAsync(read, "windows", 3, CancellationToken.None);
                // The server-scope batch agent.profile falls back to when msdb refuses a login reads the same server facts, and no role.
                await using var server = new SqlCommand(AgentProfileSql.Render(new SqlRender(band), msdb: false), connection);
                await using (var read = await server.ExecuteReaderAsync()) serverFacts = await AgentProfileSql.ReadServerAsync(read, "windows", 3, CancellationToken.None);
            }
            finally { await Run("REVERT;"); }
            check(facts is { MsdbAccess: true, Sysadmin: false, UserRole: true, ReaderRole: false, OperatorRole: false, PurgeHistory: false, ServerServices: false, Sessions: false, AlterAnyCredential: false, AgentXps: true },
                "agent.profile's batch reads a SQLAgentUserRole login as that role alone, with no EXECUTE on sp_purge_jobhistory, no server state and no ALTER ANY CREDENTIAL, and Agent XPs on: "
                + (facts is null ? "no row" : JsonSerializer.Serialize(facts)));
            check(facts is not null && serverFacts == facts with { MsdbAccess = false, UserRole = false, ReaderRole = false, OperatorRole = false, PurgeHistory = false, DatabaseMail = false },
                "agent.profile's server-scope batch reads the same server facts as the msdb batch, with msdb access, every Agent role and the msdb permissions off: "
                + (serverFacts is null ? "no row" : JsonSerializer.Serialize(serverFacts)));
            check(made.Status == "completed" && mapped.Status == "completed" && results.TryGetValue("jobs", out var jobs) && jobs.Rows.Count == 0 && results.ContainsKey("properties")
                && errors.Select(error => error.Statement + " " + error.Code).SequenceEqual(["errorLogs PERMISSION_DENIED", "serviceState PERMISSION_DENIED"]),
                "a SQLAgentUserRole login reads its own jobs (none) and Agent's properties, and is refused xp_enumerrorlogs and xp_servicecontrol as PERMISSION_DENIED values: "
                + made.Error + mapped.Error + " " + string.Join(", ", errors.Select(error => error.Statement + " " + error.Code + " " + error.Number)));
        }
        finally { await sql("IF USER_ID(" + Quote(login) + ") IS NOT NULL DROP USER " + Bracket(login) + ";", "msdb"); }

        async Task Run(string text)
        {
            await using var command = new SqlCommand(text, connection);
            await command.ExecuteNonQueryAsync();
        }
    }

    /// <summary>agent.profile (AG-0b) as the suite's own login: msdb access, Agent XPs on (Agent is up), the platform the server
    /// profile says, sysadmin as the server says, and for sysadmin every permission but no role membership: sysadmin is dbo in msdb,
    /// and IS_ROLEMEMBER counts dbo in no role, so the role facts mean real membership and agentRoleOf ranks sysadmin first.</summary>
    private static async Task ProfileAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, ServerProfile server,
        Func<string, string, Task<SqlRun>> sql)
    {
        var result = (AgentProfileResult)await service.DispatchAsync("agent.profile", JsonSerializer.SerializeToElement(new AgentProfileArgs(info.Id, Guid.NewGuid().ToString()), json), json);
        var sysadmin = (await sql("SELECT CONVERT(int, IS_SRVROLEMEMBER(N'sysadmin'));", "master")).Scalar == "1";
        var platform = server.EngineEdition == 8 ? "managedInstance" : server.Linux ? "linux" : "windows";
        check(result is { Error: null, Profile: { MsdbAccess: true, AgentXps: true } facts } && facts.Sysadmin == sysadmin && facts.Platform == platform && facts.EngineEdition == server.EngineEdition
            && (!sysadmin || facts is { UserRole: false, ReaderRole: false, OperatorRole: false, PurgeHistory: true, ServerServices: true, Sessions: true, AlterAnyCredential: true })
            && result.ElapsedMs < AgentCatalog.Current.Limit("profileMs"),
            "agent.profile reads this login's Agent facts on the Object Explorer pool: msdb access, Agent XPs on, the " + platform + " platform, sysadmin " + sysadmin
            + " with every permission but no Agent role membership when sysadmin (dbo is no role's member), within its budget: " + JsonSerializer.Serialize(result));

        // Past its budget the read is a retryable TIMEOUT value; a disconnect meanwhile cancels it instead. Either way it unregisters.
        var options = service.Explorer.Options;
        options.TestDelay = TimeSpan.FromSeconds(3);
        options.AgentProfileBudget = TimeSpan.FromMilliseconds(400);
        try
        {
            var slow = await service.Explorer.AgentProfileAsync(new AgentProfileArgs(info.Id, Guid.NewGuid().ToString()), CancellationToken.None);
            check(slow is { Profile: null, Error: { Code: "TIMEOUT", Retryable: true } } && !slow.Error.Message.Contains("Refresh", StringComparison.Ordinal) && slow.ElapsedMs < 2500 && service.Explorer.RunningCount == 0,
                "agent.profile past its budget is a retryable TIMEOUT value, and unregisters (" + slow.ElapsedMs + " ms): " + slow.Error?.Code);
            options.AgentProfileBudget = TimeSpan.FromSeconds(30);
            // The call registers before its first await, so a Forget straight after it finds the request running.
            var pending = service.Explorer.AgentProfileAsync(new AgentProfileArgs(info.Id, Guid.NewGuid().ToString()), CancellationToken.None);
            service.Explorer.Forget(info.Id);
            var code = "completed";
            try { await pending; }
            catch (RequestException error) { code = error.Code; }
            check(code == "CANCELLED" && service.Explorer.RunningCount == 0, "a disconnect cancels a running agent.profile (CANCELLED, not TIMEOUT), and it unregisters: " + code);
        }
        finally { options.TestDelay = null; options.AgentProfileBudget = null; }
    }

    private static string Quote(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Bracket(string value) => "[" + value.Replace("]", "]]", StringComparison.Ordinal) + "]";
}
