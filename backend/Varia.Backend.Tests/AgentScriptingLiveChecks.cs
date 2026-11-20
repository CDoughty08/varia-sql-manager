using System.Text.Json;
using Microsoft.Data.SqlClient;
using Microsoft.SqlServer.Management.Common;
using Microsoft.SqlServer.Management.Smo;
using Microsoft.SqlServer.Management.Smo.Agent;
using Varia.Backend.Actions;
using Varia.Backend.Explorer;
using Varia.Backend.Scripting;

namespace Varia.Backend.Tests;

/// <summary>Script As for SQL Server Agent's objects (AG-4), live in the Agent suite with VARIA_TEST_SQL_SCRATCH=1: this run's
/// scratch job (a step and a schedule), operator, alert (Windows, where alerts are served) and proxy with its credential are
/// scripted CREATE, DROP and DROP And CREATE through scripting.script; the job's script without headers is SMO's own Job.Script
/// framed; its DROP And CREATE runs and leaves the job as it was; and a SQLAgentUserRole login scripts its own job but is
/// refused an alert as a value. Every object is dropped in finally.</summary>
internal static class AgentScriptingLiveChecks
{
    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, ScratchDatabase scratch,
        Func<string, string, Task<SqlRun>> sql)
    {
        var host = (IActionHost)service;
        var profile = host.Profile(info.Id);
        var defaults = ScriptingLiveChecks.Defaults(json);
        async Task<ScriptResult> Script(string kind, string name, string verb, ScriptingOptionsDto? options = null) =>
            (ScriptResult)await service.DispatchAsync("scripting.script", JsonSerializer.SerializeToElement(
                new ScriptArgs(info.Id, Guid.NewGuid().ToString(), [new ObjectRefDto(kind, Name: name)], verb, options ?? defaults), json), json);

        var job = scratch.AgentObject("job");
        var schedule = scratch.AgentObject("sch");
        var op = scratch.AgentObject("op");
        var alert = scratch.AgentObject("al");
        var proxy = scratch.AgentObject("px");
        var credential = scratch.AgentObject("cr");
        var alerts = !profile.Linux;
        // SMO writes the step's name into its step header as is, so the line break breaks that header over lines.
        var made = await sql("DECLARE @id uniqueidentifier, @step sysname = N'Step ''1'' --' + NCHAR(10) + N'x';\n"
            + "EXEC msdb.dbo.sp_add_job @job_name = " + Quote(job) + ", @description = " + Quote(ScratchDatabase.JobMarker) + ", @job_id = @id OUTPUT;\n"
            + "EXEC msdb.dbo.sp_add_jobstep @job_id = @id, @step_name = @step, @subsystem = N'TSQL', @command = N'SELECT 1;', @database_name = N'master';\n"
            + "EXEC msdb.dbo.sp_add_jobschedule @job_id = @id, @name = " + Quote(schedule) + ", @freq_type = 4, @freq_interval = 1, @active_start_time = 30000;\n"
            + "EXEC msdb.dbo.sp_add_jobserver @job_id = @id;\n"
            + "EXEC msdb.dbo.sp_add_operator @name = " + Quote(op) + ", @email_address = N'dba@example.invalid';", "msdb");
        try
        {
            check(made.Status == "completed", "this run's scratch Agent job (a step and a schedule) and operator can be created: " + made.Error);
            if (made.Status != "completed") return;
            var others = await sql((alerts ? "EXEC msdb.dbo.sp_add_alert @name = " + Quote(alert) + ", @severity = 0, @message_id = 0, "
                    + "@performance_condition = N'SQLServer:General Statistics|User Connections||>|1000000', @enabled = 0;\n"
                    + "EXEC msdb.dbo.sp_add_notification @alert_name = " + Quote(alert) + ", @operator_name = " + Quote(op) + ", @notification_method = 1;\n" : "")
                // sp_add_proxy refuses a credential whose identity is not a Windows account (14529).
                + "CREATE CREDENTIAL " + Bracket(credential) + " WITH IDENTITY = N'NT AUTHORITY\\SYSTEM', SECRET = " + Quote(ScratchDatabase.Throwaway()) + ";\n"
                + "EXEC msdb.dbo.sp_add_proxy @proxy_name = " + Quote(proxy) + ", @credential_name = " + Quote(credential) + ", @enabled = 0;\n"
                + "EXEC msdb.dbo.sp_grant_proxy_to_subsystem @proxy_name = " + Quote(proxy) + ", @subsystem_id = 3;"
                // A CmdExec step that runs as the proxy (Windows: Linux's Agent runs no CmdExec steps).
                + (alerts ? "\nEXEC msdb.dbo.sp_add_jobstep @job_name = " + Quote(job) + ", @step_name = N'Run as proxy', @subsystem = N'CmdExec', @command = N'cmd /c exit 0', @proxy_name = " + Quote(proxy) + ";" : ""), "msdb");
            check(others.Status == "completed", "this run's scratch " + (alerts ? "alert (a performance condition notifying the operator), " : "") + "credential and proxy "
                + (alerts ? "(a job step running as it) " : "") + "can be created: " + others.Error);

            // CREATE, DROP and DROP And CREATE of each kind: SMO's msdb procedures, named for this object, in msdb, headed and framed.
            var kinds = new List<(string Kind, string Name, string Noun, string Add, string Delete)>
            {
                ("agentJob", job, "Job", "sp_add_job", "sp_delete_job"), ("agentOperator", op, "Operator", "sp_add_operator", "sp_delete_operator"),
                ("agentProxy", proxy, "ProxyAccount", "sp_add_proxy", "sp_delete_proxy")
            };
            if (alerts) kinds.Add(("agentAlert", alert, "Alert", "sp_add_alert", "sp_delete_alert"));
            var failures = new List<string>();
            foreach (var (kind, name, noun, add, delete) in kinds)
            {
                var create = await Script(kind, name, "create");
                var drop = await Script(kind, name, "drop");
                var both = await Script(kind, name, "dropAndCreate");
                bool Has(ScriptResult result, string text) => result.Text?.Contains(text, StringComparison.Ordinal) == true;
                var named = "N'" + name + "'";
                if (!(create.Error is null && drop.Error is null && both.Error is null && create.Database == "msdb"
                    && Has(create, "USE [msdb]") && Has(create, "msdb.dbo." + add + " ") && Has(create, named) && !Has(create, delete)
                    // The job's step name breaks its step header, so its script comes without headers (checked below).
                    && (kind == "agentJob" || Has(create, "/****** Object:  " + noun + " [" + name + "]"))
                    && Has(drop, "msdb.dbo." + delete + " ") && !Has(drop, add + " ")
                    && both.Text!.IndexOf(delete + " ", StringComparison.Ordinal) is var at and >= 0 && both.Text.IndexOf(add + " ", StringComparison.Ordinal) > at))
                    failures.Add(kind + ": " + (create.Error ?? drop.Error ?? both.Error)?.Message + " " + Excerpt(create.Text));
            }
            check(failures.Count == 0, "Script As writes each Agent kind's CREATE (its msdb add procedure, in msdb, with SMO's header), DROP (its delete procedure) and DROP And CREATE "
                + "(delete, then add) for this run's objects: " + string.Join(" | ", failures));

            var jobCreate = await Script("agentJob", job, "create");
            var alertCreate = alerts ? await Script("agentAlert", alert, "create") : null;
            var proxyCreate = await Script("agentProxy", proxy, "create");
            var jobText = jobCreate.Text ?? "";
            var parts = new (string Name, bool Ok)[]
            {
                ("job step quoted", jobText.Contains("msdb.dbo.sp_add_jobstep ", StringComparison.Ordinal) && jobText.Contains("@step_name=N'Step ''1'' --", StringComparison.Ordinal)),
                ("job headers left out, with a warning", !jobText.Contains(HeaderGuard.Opening, StringComparison.Ordinal) && jobCreate.Warnings.Contains(HeaderGuard.Warning)),
                ("job step's proxy named", !alerts || jobText.Contains("@proxy_name=N'" + proxy + "'", StringComparison.Ordinal)),
                ("no proxy warning for sysadmin", !jobCreate.Warnings.Contains(SmoScriptRunner.ProxyWarning)),
                ("job schedule", jobText.Contains("msdb.dbo.sp_add_jobschedule ", StringComparison.Ordinal) && jobText.Contains("N'" + schedule + "'", StringComparison.Ordinal)),
                ("job server in a transaction", jobText.Contains("msdb.dbo.sp_add_jobserver ", StringComparison.Ordinal) && jobText.Contains("BEGIN TRANSACTION", StringComparison.Ordinal)),
                // SMO scripts an alert's condition and response job, not its notifications (AgentNotify stays off, as in SSMS's Script As).
                ("alert condition without notifications", alertCreate is null || alertCreate.Text?.Contains("@performance_condition=N'SQLServer:General Statistics|User Connections||>|1000000'", StringComparison.Ordinal) == true
                    && !alertCreate.Text.Contains("sp_add_notification", StringComparison.Ordinal)),
                ("proxy credential", proxyCreate.Text?.Contains("N'" + credential + "'", StringComparison.Ordinal) == true),
                // SMO scripts a proxy's subsystem grants on Windows only: against Linux it writes none, though msdb lists the grant.
                ("proxy subsystem granted (Windows)", !alerts || proxyCreate.Text?.Contains("sp_grant_proxy_to_subsystem @proxy_name=N'" + proxy + "', @subsystem_id=3", StringComparison.Ordinal) == true),
                ("no secret", proxyCreate.Text?.Contains("SECRET", StringComparison.OrdinalIgnoreCase) == false)
            };
            check(jobCreate.Error is null && proxyCreate.Error is null && parts.All(part => part.Ok),
                "a job's script holds its steps (quotes doubled; a name with a line break leaves the headers out, with a warning; a step's proxy by name), schedule and target server in SMO's transaction; an alert's its condition without notifications; a proxy's its "
                + "credential by name and (on Windows) its subsystem, never a secret. Failed: " + string.Join(", ", parts.Where(part => !part.Ok).Select(part => part.Name)) + " "
                + Excerpt(jobCreate.Text) + " " + Excerpt(alertCreate?.Text) + " " + Excerpt(proxyCreate.Text) + " " + jobCreate.Error?.Message + " " + proxyCreate.Error?.Message);

            await SmoAsync(check, host, info, defaults, Script, job);

            // The script runs: DROP And CREATE replaces the job with one equal to it (the marker kept, so the sweep still knows it).
            var replace = await Script("agentJob", job, "dropAndCreate");
            var ran = replace.Text is { } script ? await sql(script, "msdb") : null;
            var after = await sql("SELECT COUNT(*), MIN(j.description), (SELECT COUNT(*) FROM msdb.dbo.sysjobsteps AS s JOIN msdb.dbo.sysjobs AS k ON k.job_id = s.job_id WHERE k.name = "
                + Quote(job) + "), (SELECT COUNT(*) FROM msdb.dbo.sysjobschedules AS js JOIN msdb.dbo.sysjobs AS k ON k.job_id = js.job_id WHERE k.name = " + Quote(job)
                + ") FROM msdb.dbo.sysjobs AS j WHERE j.name = " + Quote(job) + ";", "msdb");
            check(ran?.Status == "completed" && after.Sets is [[[var count, var description, var steps, var schedules], ..], ..] && count == "1" && description == ScratchDatabase.JobMarker
                && steps == (alerts ? "2" : "1") && schedules == "1",
                "the job's DROP And CREATE script runs and leaves one job of that name with its description, steps and schedule: " + ran?.Error + " " + replace.Error?.Message);

            await RoleAsync(check, service, host, info, profile, scratch, sql, defaults, job, alert, alerts);
        }
        finally
        {
            await sql("IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = " + Quote(job) + ") EXEC msdb.dbo.sp_delete_job @job_name = " + Quote(job) + ", @delete_history = 1, @delete_unused_schedule = 1;\n"
                + "IF EXISTS (SELECT 1 FROM msdb.dbo.sysschedules WHERE name = " + Quote(schedule) + ") EXEC msdb.dbo.sp_delete_schedule @schedule_name = " + Quote(schedule) + ", @force_delete = 1;\n"
                + "IF EXISTS (SELECT 1 FROM msdb.dbo.sysproxies WHERE name = " + Quote(proxy) + ") EXEC msdb.dbo.sp_delete_proxy @proxy_name = " + Quote(proxy) + ";\n"
                + "IF EXISTS (SELECT 1 FROM sys.credentials WHERE name = " + Quote(credential) + ") DROP CREDENTIAL " + Bracket(credential) + ";\n"
                + "IF EXISTS (SELECT 1 FROM msdb.dbo.sysalerts WHERE name = " + Quote(alert) + ") EXEC msdb.dbo.sp_delete_alert @name = " + Quote(alert) + ";\n"
                + "IF EXISTS (SELECT 1 FROM msdb.dbo.sysoperators WHERE name = " + Quote(op) + ") EXEC msdb.dbo.sp_delete_operator @name = " + Quote(op) + ";", "msdb");
        }
    }

    /// <summary>The job's CREATE without headers or USE is SMO's own Job.Script with the same switches, batch for batch.</summary>
    private static async Task SmoAsync(Action<bool, string> check, IActionHost host, ConnectionInfo info, ScriptingOptionsDto defaults,
        Func<string, string, string, ScriptingOptionsDto?, Task<ScriptResult>> script, string job)
    {
        var plain = defaults with { IncludeHeaders = false, ScriptUseDatabase = false };
        var varia = await script("agentJob", job, "create", plain);
        await using var connection = host.Connection(info.Id);
        await host.OpenAsync(connection, CancellationToken.None);
        var server = new Server(new ServerConnection(connection) { AutoDisconnectMode = AutoDisconnectMode.NoAutoDisconnect });
        var smoJob = server.JobServer.Jobs[job];
        var batches = smoJob?.Script(new ScriptingOptions { IncludeHeaders = false, IncludeDatabaseContext = false, AgentAlertJob = false });
        var expected = batches is null ? null : string.Concat(batches.Cast<string>().Where(batch => !string.IsNullOrWhiteSpace(batch)).Select(batch => ScriptFormatter.Frame(batch, true)));
        check(varia.Error is null && expected is not null && varia.Text == expected,
            "a job's CREATE without headers or USE is SMO's own Job.Script, framed: " + varia.Error?.Message + " " + Excerpt(varia.Text) + " vs " + Excerpt(expected));
    }

    /// <summary>A login in SQLAgentUserRole alone, impersonated on a pool connection: its own job scripts through the preflight
    /// and SMO as the service runs them (docs/agent-plan.md › Script As asks AG-4 to verify it), while msdb refuses it an alert:
    /// the preflight throws 229, which ScriptingService reports as a PERMISSION_DENIED value.</summary>
    private static async Task RoleAsync(Action<bool, string> check, SqlService service, IActionHost host, ConnectionInfo info, ServerProfile profile, ScratchDatabase scratch,
        Func<string, string, Task<SqlRun>> sql, ScriptingOptionsDto defaults, string job, string alert, bool alerts)
    {
        var login = scratch.OwnLogin("ags");
        var made = await sql("CREATE LOGIN " + Bracket(login) + " WITH PASSWORD = " + Quote(ScratchDatabase.Throwaway()) + ", CHECK_POLICY = OFF;", "master");
        try
        {
            var mapped = await sql("CREATE USER " + Bracket(login) + " FOR LOGIN " + Bracket(login) + ";\nALTER ROLE SQLAgentUserRole ADD MEMBER " + Bracket(login) + ";\n"
                + "EXEC msdb.dbo.sp_update_job @job_name = " + Quote(job) + ", @owner_login_name = " + Quote(login) + ";", "msdb");
            var catalog = service.Scripting.Catalog;
            var served = profile.Explorer(ExplorerCatalog.Current);
            string? text = null, refused = null, failure = null;
            var warnings = new List<string>();
            bool? sees = null;
            await using var connection = host.Connection(info.Id);
            await host.OpenAsync(connection, CancellationToken.None);
            await Run(connection, ScriptPreflight.Prologue + "\nEXECUTE AS LOGIN = " + Quote(login) + ";");
            try
            {
                var verb = catalog.Verb("create")!;
                var preflight = await ScriptPreflight.RunAsync(connection, catalog, new ObjectRefDto("agentJob", Name: job), verb, served.Band, false, null, CancellationToken.None);
                if (preflight.Target is { } target)
                {
                    sees = target.SeesProxies;
                    var runner = new SmoScriptRunner(new ScriptSession(connection, profile, false), CancellationToken.None);
                    try { text = await Task.Run(() => runner.Script(target, ScriptVerb.Create, defaults, 4_000_000, warnings)); }
                    catch (Exception error) { failure = error.GetType().Name + ": " + error.Message; }
                }
                else failure = preflight.Error?.Code + " " + preflight.Error?.Message;
                if (alerts)
                {
                    try
                    {
                        var other = await ScriptPreflight.RunAsync(connection, catalog, new ObjectRefDto("agentAlert", Name: alert), verb, served.Band, false, null, CancellationToken.None);
                        refused = other.Error?.Code ?? "scripted";
                    }
                    catch (SqlException error) { refused = "SqlException " + error.Number; }
                }
            }
            finally { await Run(connection, "REVERT;"); }
            check(made.Status == "completed" && mapped.Status == "completed" && text?.Contains("msdb.dbo.sp_add_job ", StringComparison.Ordinal) == true
                && text.Contains("N'" + job + "'", StringComparison.Ordinal) && text.Contains("sp_add_jobstep", StringComparison.Ordinal) && sees == false
                // Its step that runs as a proxy it was not granted is scripted without the proxy, and the script says so.
                && (!alerts || refused == "SqlException 229" && !text.Contains("@proxy_name=", StringComparison.Ordinal) && warnings.Contains(SmoScriptRunner.ProxyWarning)),
                "a SQLAgentUserRole login scripts its own job's CREATE (preflight through sysjobs_view, then SMO), a step's proxy it cannot see left out with a warning, and msdb refuses it an alert's preflight (229): "
                + made.Error + " " + mapped.Error + " " + failure + " " + refused + " " + sees + " " + string.Join(" | ", warnings) + " " + Excerpt(text));
        }
        finally
        {
            // The job it owns is deleted by the caller's finally, before the run's logins are dropped.
            await sql("IF USER_ID(" + Quote(login) + ") IS NOT NULL DROP USER " + Bracket(login) + ";", "msdb");
        }

        static async Task Run(SqlConnection connection, string text)
        {
            await using var command = new SqlCommand(text, connection);
            await command.ExecuteNonQueryAsync();
        }
    }

    private static string Excerpt(string? text) => text is null ? "(none)" : text.Length <= 400 ? text : text[..400] + "…";
    private static string Quote(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Bracket(string value) => "[" + value.Replace("]", "]]", StringComparison.Ordinal) + "]";
}
