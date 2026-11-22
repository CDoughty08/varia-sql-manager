using System.Text.Json;
using Varia.Backend;
using Varia.Backend.Agent;

namespace Varia.Backend.Tests;

/// <summary>
/// The job document (AG-6a) on the scratch job: its describe, a save under the STALE guard and the refusal of one that read an older
/// version, a save whose later call fails committing nothing, a hostile name round trip, Script's batch run back against msdb, and (where
/// the platform has alerts) Remove detaching a scratch alert. <see cref="CreateAsync"/> runs after the job verbs delete the job, so New
/// Job's save can reuse the run's job name and the stale-object sweep finds it if the run dies.
/// </summary>
internal static class AgentJobDocumentLiveChecks
{
    private static string Quote(string value) => "N'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
    private static string Said(ActionExecuteResult result) => string.Join(", ", result.Steps.Select(step => step.Status + ":" + step.Title)) + (result.Error is { } error ? " " + error.Code + " " + error.Field + " " + error.Message : "");

    public static async Task RunAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, ScratchDatabase scratch, string job, Guid id,
        Func<string, string, Task<SqlRun>> sql)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<AgentJobDocumentDto?> Describe(string name) =>
            (await Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "agentJob", new ObjectRefDto("agentJob", Name: name)))).AgentJobDocument;
        Task<ActionExecuteResult> Save(string name, string jobId, AgentJobSaveDto save) =>
            Call<ActionExecuteResult>("actions.execute", new ActionArgs("agentJob", info.Id, Guid.NewGuid().ToString(), new ObjectRefDto("agentJob", Name: name), AgentIdentity: new(jobId), AgentJob: save));
        async Task<string?> Column(string column) => (await sql("SELECT CONVERT(nvarchar(512), " + column + ") FROM msdb.dbo.sysjobs WHERE job_id = '" + id.ToString("D") + "';", "msdb")).Scalar;

        var first = await Describe(job);
        check(first is { Job: { } read, Steps: [{ Id: 1, Name: "Step 1" }] } && read.Name == job && read.JobId.Equals(id.ToString("D"), StringComparison.OrdinalIgnoreCase) && read.Description == ScratchDatabase.JobMarker,
            "the job document describes the scratch job: its id, description, version, modified date and its one step: " + JsonSerializer.Serialize(first?.Job));
        if (first?.Job is not { } before) return;
        // sp_help_job names the missing operator of a level-0 notification "(unknown)" (message 14205); the document reads it as no operator.
        check(before is { EmailLevel: 0, EmailOperator: "", PageLevel: 0, PageOperator: "", NetSendLevel: 0, NetSendOperator: "" },
            "the job document reads a notification that is never sent with no operator, not sp_help_job's (unknown): " + JsonSerializer.Serialize(before));

        // sp_add_job's default event log level is 2, so the save sets 3 and the refused save 0: either landing shows.
        // A save carrying the version it read lands, and moves the version on; the same save again is refused STALE and changes nothing.
        var marked = ScratchDatabase.JobMarker;
        var saved = await Save(job, before.JobId, new AgentJobSaveDto(before.Version, before.Modified, EventLogLevel: 3));
        var after = await Describe(job);
        check(saved.Error is null && after?.Job is { EventLogLevel: 3 } now && now.Version > before.Version && await Column("description") == marked,
            "a job document save under the version it read changes the job and its version: " + Said(saved) + " " + JsonSerializer.Serialize(after?.Job));
        var stale = await Save(job, before.JobId, new AgentJobSaveDto(before.Version, before.Modified, EventLogLevel: 0));
        check(stale.Error is { Code: "STALE", Retryable: false } && await Column("notify_level_eventlog") == "3",
            "a job document save under a version the job has moved past is refused STALE and changes nothing: " + Said(stale));
        if (after?.Job is not { } current) return;

        // One transaction: an operator that does not exist fails the notification call after the description's, and nothing commits.
        var failed = await Save(job, current.JobId, new AgentJobSaveDto(current.Version, current.Modified, Description: "rolled back", EmailLevel: 2, EmailOperator: "VariaNoSuchOperator_" + Guid.NewGuid().ToString("N")[..8]));
        var unchanged = await Describe(job);
        check(failed.Error is { Code: not "NOT_FOUND", Field: "email" } && await Column("description") == marked && unchanged?.Job?.Version == current.Version,
            "a job document save whose later call fails commits nothing, lands on the operator's field and is not NOT_FOUND (the job is there): " + Said(failed));

        // A hostile name goes through as a parameter and comes back through sp_help_job; renaming back keeps the identity.
        var hostile = job + "]'; --é";
        var renamed = await Save(job, current.JobId, new AgentJobSaveDto(current.Version, current.Modified, Name: hostile));
        var named = await Column("name");
        var read2 = renamed.Error is null ? await Describe(hostile) : null;
        var back = read2?.Job is { } hostileJob ? await Save(hostile, hostileJob.JobId, new AgentJobSaveDto(hostileJob.Version, hostileJob.Modified, Name: job)) : null;
        if (await Column("name") != job) await sql("EXEC msdb.dbo.sp_update_job @job_id = '" + id.ToString("D") + "', @new_name = " + Quote(job) + ";", "msdb");
        check(renamed.Error is null && named == hostile && read2?.Job?.Name == hostile && back?.Error is null && await Column("name") == job,
            "a job document save renames the job to a hostile name, describes it by that name and renames it back: " + Said(renamed) + " " + (back is null ? "" : Said(back)));

        // Script's text runs back against msdb batch by batch (the shape SSMS's Script Job As gives) and makes the same change.
        var latest = (await Describe(job))?.Job;
        var scripted = await Call<ActionScriptResult>("actions.script", new ActionArgs("agentJob", info.Id, Guid.NewGuid().ToString(), new ObjectRefDto("agentJob", Name: job),
            AgentIdentity: latest is null ? null : new(latest.JobId), AgentJob: new AgentJobSaveDto(latest?.Version, latest?.Modified, DeleteLevel: 0, EventLogLevel: 1)));
        var text = scripted.Text ?? "";
        var batches = text.Replace("\r\n", "\n", StringComparison.Ordinal).Split("\nGO\n").Select(batch => batch.Trim()).Where(batch => batch.Length > 0 && !batch.StartsWith("USE ", StringComparison.Ordinal)).ToList();
        var runs = new List<SqlRun>();
        foreach (var batch in batches) runs.Add(await sql(batch, "msdb"));
        check(scripted.Error is null && text.Contains("BEGIN TRANSACTION", StringComparison.Ordinal) && text.Contains("GOTO QuitWithRollback", StringComparison.Ordinal) && batches.Count == 1
            && runs.All(run => run.Status == "completed") && await Column("notify_level_eventlog") == "1",
            "the job document's script has SSMS's transaction shape and, run back against msdb, makes the change: " + string.Join(" | ", runs.Select(run => run.Status + " " + run.Error)));

        await AlertAsync(check, scratch, job, id, sql, Describe, Save);
    }

    /// <summary>Remove on an alert that runs the job detaches it (the alert stays, running no job), where the platform has alerts.</summary>
    private static async Task AlertAsync(Action<bool, string> check, ScratchDatabase scratch, string job, Guid id, Func<string, string, Task<SqlRun>> sql,
        Func<string, Task<AgentJobDocumentDto?>> describe, Func<string, string, AgentJobSaveDto, Task<ActionExecuteResult>> save)
    {
        if ((await describe(job)) is not { Platform: "windows", Alerts: not null }) return;
        var alert = scratch.AgentObject("al");
        var added = await sql("EXEC msdb.dbo.sp_add_alert @name = " + Quote(alert) + ", @severity = 25, @enabled = 0, @job_id = '" + id.ToString("D") + "';", "msdb");
        try
        {
            var read = await describe(job);
            var listed = read?.Alerts?.FirstOrDefault(item => item.Name == alert);
            var removed = read?.Job is { } held && listed is not null ? await save(job, held.JobId, new AgentJobSaveDto(held.Version, held.Modified, RemoveAlerts: [new(listed.Id, listed.Name)])) : null;
            var jobOf = (await sql("SELECT CONVERT(nvarchar(36), job_id) FROM msdb.dbo.sysalerts WHERE name = " + Quote(alert) + ";", "msdb")).Scalar;
            var reread = await describe(job);
            check(added.Status == "completed" && listed is not null && removed?.Error is null && jobOf == Guid.Empty.ToString("D") && reread?.Alerts?.All(item => item.Name != alert) == true,
                "Remove on the job document's alert detaches the scratch alert, which stays and runs no job: " + added.Error + " " + (removed is null ? "not listed" : Said(removed)) + " " + jobOf);
        }
        finally { await sql("IF EXISTS (SELECT 1 FROM msdb.dbo.sysalerts WHERE name = " + Quote(alert) + ") EXEC msdb.dbo.sp_delete_alert @name = " + Quote(alert) + ";", "msdb"); }
    }

    /// <summary>New Job's save (target the Agent node) creates the job with what it sets, in one transaction; the New Job describe lists it after.</summary>
    public static async Task CreateAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, string job, Func<string, string, Task<SqlRun>> sql)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        var agent = new ObjectRefDto("agent");
        try
        {
            var blank = (await Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "agentJob", agent))).AgentJobDocument;
            // What New Job's Save sends: every field it sets, no version.
            Task<ActionExecuteResult> Create() => Call<ActionExecuteResult>("actions.execute", new ActionArgs("agentJob", info.Id, Guid.NewGuid().ToString(), agent,
                AgentJob: new AgentJobSaveDto(Name: job, Enabled: false, Description: ScratchDatabase.JobMarker, Category: "[Uncategorized (Local)]", EventLogLevel: 1, EmailLevel: 0, EmailOperator: "",
                    PageLevel: 0, PageOperator: "", NetSendLevel: 0, NetSendOperator: "", DeleteLevel: 0)));
            var created = await Create();
            var row = await sql("SELECT CONVERT(nvarchar(1), enabled), CONVERT(nvarchar(1), notify_level_eventlog), description FROM msdb.dbo.sysjobs WHERE name = " + Quote(job) + ";", "msdb");
            var listed = (await Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "agentJob", agent))).AgentJobDocument;
            check(blank is { Job: null } && created.Error is null && row.Sets is [[["0", "1", var description]]] && description == ScratchDatabase.JobMarker && listed?.Jobs?.Contains(job) == true,
                "New Job's save creates the job disabled with its event log level and description, and New Job's describe then lists it: " + Said(created) + " " + row.Error);
            var again = await Create();
            check(again.Error is { Field: "name" } && (await sql("SELECT CONVERT(nvarchar(9), COUNT(*)) FROM msdb.dbo.sysjobs WHERE name = " + Quote(job) + ";", "msdb")).Scalar == "1",
                "New Job's save under a name in use is refused on the Name field and creates nothing: " + Said(again));
            await StepsAsync(check, service, info, json, job, sql);
        }
        finally { await sql("IF EXISTS (SELECT 1 FROM msdb.dbo.sysjobs WHERE name = " + Quote(job) + ") EXEC msdb.dbo.sp_delete_job @job_name = " + Quote(job) + ", @delete_history = 1, @delete_unused_schedule = 1;", "msdb"); }
    }
    /// <summary>Steps (AG-6b) on New Job's job: two steps added whole, swapped (each under a temporary name first, the go-to and the Start step
    /// following) and one deleted with its referrer retargeted, each save in the planner's shape and read back from sysjobsteps.</summary>
    private static async Task StepsAsync(Action<bool, string> check, SqlService service, ConnectionInfo info, JsonSerializerOptions json, string job, Func<string, string, Task<SqlRun>> sql)
    {
        async Task<T> Call<T>(string method, object args) => (T)await service.DispatchAsync(method, JsonSerializer.SerializeToElement(args, json), json);
        async Task<AgentJobRecordDto?> Read() =>
            (await Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "agentJob", new ObjectRefDto("agentJob", Name: job)))).AgentJobDocument?.Job;
        async Task<ActionExecuteResult?> Save(AgentStepsSaveDto steps) => await Read() is { } held
            ? await Call<ActionExecuteResult>("actions.execute", new ActionArgs("agentJob", info.Id, Guid.NewGuid().ToString(), new ObjectRefDto("agentJob", Name: job), AgentIdentity: new(held.JobId),
                AgentJob: new AgentJobSaveDto(held.Version, held.Modified, Steps: steps)))
            : null;
        async Task<string> Rows() => string.Join("|", ((await sql("SELECT CONCAT(s.step_id, ':', s.step_name, ':', s.on_fail_action, '/', s.on_fail_step_id, ':', s.flags, ':', s.database_name, ':', j.start_step_id) "
            + "FROM msdb.dbo.sysjobsteps AS s JOIN msdb.dbo.sysjobs AS j ON j.job_id = s.job_id WHERE j.name = " + Quote(job) + " ORDER BY s.step_id;", "msdb")).Sets.FirstOrDefault() ?? []).Select(row => row[0]));
        static string Temp() => "__varia_step_" + Guid.NewGuid().ToString("N");
        static AgentStepWriteDto Write(int id, string name, int onFail, int onFailStep, int flags) =>
            new(id, name, "TSQL", "SELECT " + id + ";", "master", "", 3, 0, onFail, onFailStep, 0, 0, "", flags, 0, 0, "", 0);

        var added = await Save(new(Adds: [new(1, Temp()), new(2, Temp())], Writes: [Write(1, "First", 4, 2, 8), Write(2, "Second", 2, 0, 0)], StartStepId: 1));
        var addedRows = await Rows();
        check(added?.Error is null && addedRows == "1:First:4/2:8:master:1|2:Second:2/0:0:master:1",
            "a job document save adds two steps whole, a go-to and log-to-table flag included: " + (added is null ? "no job" : Said(added)) + " " + addedRows);
        // The swap: both steps take temporary names, then each is written into the other's id; step 1's go-to and the Start step follow it.
        var swapped = await Save(new(Temporary: [new(1, Temp()), new(2, Temp())], Writes: [Write(1, "Second", 2, 0, 0), Write(2, "First", 4, 1, 8)], StartStepId: 2));
        var swappedRows = await Rows();
        check(swapped?.Error is null && swappedRows == "1:Second:2/0:0:master:2|2:First:4/1:8:master:2",
            "a job document save swaps two steps under temporary names, the go-to and the Start step following: " + (swapped is null ? "no job" : Said(swapped)) + " " + swappedRows);
        // Delete step 1 ("Second"): First moves to id 1 and, having gone to it, quits reporting failure; it is the Start step.
        var deleted = await Save(new(Deletes: [1], Temporary: [new(1, Temp())], Writes: [Write(1, "First", 2, 0, 8)], StartStepId: 1));
        var deletedRows = await Rows();
        check(deleted?.Error is null && deletedRows == "1:First:2/0:8:master:1",
            "a job document save deletes a step, retargeting the step that went to it: " + (deleted is null ? "no job" : Said(deleted)) + " " + deletedRows);

        // A command longer than stepCommandChars (written outside Varia) is cut in the describe and marked, so the document never saves it back.
        var limit = (int)AgentCatalog.Current.Limit("stepCommandChars");
        await sql("UPDATE s SET command = REPLICATE(CONVERT(nvarchar(max), N'x'), " + (limit + 10) + ") FROM msdb.dbo.sysjobsteps AS s JOIN msdb.dbo.sysjobs AS j ON j.job_id = s.job_id WHERE j.name = " + Quote(job) + " AND s.step_id = 1;", "msdb");
        var cut = (await Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "agentJob", new ObjectRefDto("agentJob", Name: job)))).AgentJobDocument?.Steps;
        check(cut is [{ CommandTruncated: true } only] && only.Command?.Length == limit,
            "the job document's describe cuts a step command over stepCommandChars and marks it: " + (cut is null ? "no steps" : string.Join(",", cut.Select(item => item.Command?.Length + "/" + item.CommandTruncated))));

        // More steps than stepsPerJob: the describe lists the first ones and says so, and the document then leaves the steps alone.
        var perJob = (int)AgentCatalog.Current.Limit("stepsPerJob");
        await sql("DECLARE @id uniqueidentifier = (SELECT job_id FROM msdb.dbo.sysjobs WHERE name = " + Quote(job) + "), @at int = 2; "
            + "WHILE @at <= " + (perJob + 1) + " BEGIN DECLARE @name sysname = CONCAT(N'More ', @at); EXEC msdb.dbo.sp_add_jobstep @job_id = @id, @step_id = @at, @step_name = @name, @subsystem = N'TSQL', @command = N'SELECT 1;'; SET @at += 1; END;", "msdb");
        var many = (await Call<ActionDescribeResult>("actions.describe", new ActionDescribeArgs(info.Id, Guid.NewGuid().ToString(), "agentJob", new ObjectRefDto("agentJob", Name: job)))).AgentJobDocument;
        check(many is { StepsTruncated: true } && many.Steps.Count == perJob,
            "the job document's describe of a job with more than stepsPerJob steps lists that many and marks the rest: " + many?.Steps.Count + "/" + many?.StepsTruncated);
    }
}
