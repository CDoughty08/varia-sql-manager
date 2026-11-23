using System.Data;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Varia.Backend.Agent;

/// <summary>One msdb call of a job save: the procedure, its arguments in order (each bound to the parameter of the same name, or for a
/// removed alert's <c>@name</c> to <c>@name_&lt;index&gt;</c> and its <c>@job_id</c> to <c>@no_job</c>), and the parameters' values.</summary>
/// <remarks>AG-6b: a step call's <paramref name="Part"/> names the step a refusal names. AG-6c: a schedule update or attach carries its
/// <paramref name="Guard"/>, a Schedules document's attach or detach its job's <paramref name="JobVersion"/>; <paramref name="Label"/> names the
/// part a refusal names.</remarks>
internal sealed record AgentSaveCall(string Procedure, IReadOnlyList<AgentSaveArgument> Arguments, int? AlertId = null, string? Part = null, AgentScheduleGuardValues? Guard = null,
    int? JobVersion = null, string? Label = null);
internal sealed record AgentSaveArgument(string Name, AgentParameter Parameter, object? Value, bool Output = false);
/// <summary>A job save's batch: its text, its parameters with their values, and which call each THROW state names (index 1 is the first call).</summary>
internal sealed record AgentSaveBatch(string Text, IReadOnlyList<(AgentParameter Parameter, object? Value)> Parameters, IReadOnlyList<AgentSaveCall> Calls);

/// <summary>The job document (AG-6a): its describe's reads (run by <see cref="AgentReader"/>, each in <see cref="All"/> and so under
/// <see cref="LintRead"/>) and its save. A save is one batch in one transaction (the action's XACT_ABORT prologue and a SqlTransaction):
/// an existing job's resolves the job by name and its immutable job_id (<see cref="Resolve"/>, 50010), then checks that its version_number and
/// date_modified are those the document read (<see cref="StaleGuard"/>, 50011, STALE), then one sp_update_job with only the changed arguments and,
/// per removed alert, a guard that the alert still runs this job (50011) and sp_update_alert with the zero job id; New Job's is sp_add_job with
/// the job id as its OUTPUT and sp_add_jobserver on the local server. Every call is followed by <see cref="CheckAt"/>, whose THROW state is the
/// call's index, so a refusal names the part that failed. <see cref="LintJobSave"/> admits nothing else.</summary>
internal static partial class AgentSql
{
    /// <summary>THROW states carry a save's call index, 1 to 255 (src/shared/agent/catalog.ts agentCallIndexLimit).</summary>
    public const int CallIndexLimit = 255;
    /// <summary>The STALE guard's message (50011).</summary>
    public const string StaleMessage = "Changed by someone else since it was opened. Reload to see the changes.";

    // --- The save --------------------------------------------------------------------------------------------------------

    // UPDLOCK, HOLDLOCK: the guard's read holds the job's row to the end of the transaction, so no other save lands between the check and
    // this one's sp_update_job (two saves of one version: the second waits, then finds the version moved).
    internal const string StaleGuard = "IF NOT EXISTS (SELECT 1 FROM msdb.dbo.sysjobs_view AS j WITH (UPDLOCK, HOLDLOCK) WHERE j.job_id = @job_id AND j.version_number = @version AND j.date_modified = @modified) THROW 50011, N'"
        + StaleMessage + "', 1;\n";
    internal const string NewJobHead = "DECLARE @job_id uniqueidentifier, @rc int;\n";
    private const string AlertGuardHead = "IF NOT EXISTS (SELECT 1 FROM msdb.dbo.sysalerts AS a WHERE a.id = @alert_id_";

    /// <summary>The return-code check after a save's call <paramref name="index"/> (1-255), the THROW's state.</summary>
    internal static string CheckAt(int index) => "\nIF @@ERROR <> 0 OR @rc <> 0 THROW 50012, N'" + RefusedMessage + "', " + index.ToString(CultureInfo.InvariantCulture) + ";\n";
    /// <summary>A removed alert's guard before its call <paramref name="index"/>: the alert still has its id and name and runs this job.</summary>
    internal static string AlertGuard(int index)
    {
        var at = index.ToString(CultureInfo.InvariantCulture);
        return AlertGuardHead + at + " AND a.name = @name_" + at + " AND a.job_id = @job_id) THROW 50011, N'" + StaleMessage + "', " + at + ";\n";
    }

    private static readonly AgentParameter NameParameter = new("@name", SqlDbType.NVarChar, 128);
    private static readonly AgentParameter ExpectedJobIdParameter = new("@expected_job_id", SqlDbType.UniqueIdentifier);
    private static readonly AgentParameter VersionParameter = new("@version", SqlDbType.Int);
    private static readonly AgentParameter ModifiedParameter = new("@modified", SqlDbType.DateTime);
    private static readonly AgentParameter NoJobParameter = new("@no_job", SqlDbType.UniqueIdentifier);

    /// <summary>The arguments sp_update_job and sp_add_job take from a save, in the order they are passed, with the field each one is (the
    /// renderer's agentJobFields, where a refusal naming the argument lands).</summary>
    internal static readonly IReadOnlyList<(string Argument, SqlDbType Type, int Size, string Field)> JobArguments =
    [
        ("@enabled", SqlDbType.TinyInt, 0, "enabled"), ("@description", SqlDbType.NVarChar, 512, "description"), ("@category_name", SqlDbType.NVarChar, 128, "category"),
        ("@owner_login_name", SqlDbType.NVarChar, 128, "owner"), ("@notify_level_eventlog", SqlDbType.Int, 0, "eventLog"), ("@notify_level_email", SqlDbType.Int, 0, "email"),
        ("@notify_level_netsend", SqlDbType.Int, 0, "netSend"), ("@notify_level_page", SqlDbType.Int, 0, "page"), ("@notify_email_operator_name", SqlDbType.NVarChar, 128, "email"),
        ("@notify_netsend_operator_name", SqlDbType.NVarChar, 128, "netSend"), ("@notify_page_operator_name", SqlDbType.NVarChar, 128, "page"), ("@delete_level", SqlDbType.Int, 0, "delete")
    ];
    /// <summary>The field an msdb argument is, for a refusal whose text names it (14234 "The specified '@category_name' is invalid").</summary>
    internal static string? FieldOfArgument(string argument) => argument is "@new_name" or "@job_name" ? "name" : JobArguments.FirstOrDefault(entry => entry.Argument == argument).Field;

    private static string Call(AgentSaveCall call) =>
        "EXEC @rc = msdb.dbo." + call.Procedure + " " + string.Join(", ", call.Arguments.Select(argument => argument.Name + " = " + argument.Parameter.Name + (argument.Output ? " OUTPUT" : ""))) + ";";

    /// <summary>The batch for <paramref name="calls"/>: New Job's (<paramref name="create"/>: sp_add_job then sp_add_jobserver) or an existing job's
    /// (resolve, STALE guard, then the calls). <paramref name="name"/>, <paramref name="jobId"/>, <paramref name="version"/> and
    /// <paramref name="modified"/> bind the guards of an existing job's.</summary>
    public static AgentSaveBatch JobSave(bool create, IReadOnlyList<AgentSaveCall> calls, string? name = null, Guid? jobId = null, int? version = null, DateTime? modified = null)
    {
        if (calls.Count == 0 || calls.Count > CallIndexLimit) throw new InvalidOperationException("A job save makes 1 to 255 calls.");
        var text = new StringBuilder(create ? NewJobHead : Resolve + StaleGuard);
        var parameters = new List<(AgentParameter, object?)>();
        if (!create) parameters.AddRange([(NameParameter, name), (ExpectedJobIdParameter, jobId), (VersionParameter, version), (ModifiedParameter, modified)]);
        if (calls.Any(call => call.AlertId is not null)) parameters.Add((NoJobParameter, Guid.Empty));
        for (var i = 0; i < calls.Count; i++)
        {
            var call = calls[i];
            if (call.AlertId is { } alert)
            {
                text.Append(AlertGuard(i + 1));
                parameters.Add((new AgentParameter("@alert_id_" + (i + 1).ToString(CultureInfo.InvariantCulture), SqlDbType.Int), alert));
            }
            if (call.Guard is { } guard)
            {
                text.Append(ScheduleGuard(i + 1));
                parameters.AddRange([(Indexed("@schedule_version", i + 1, SqlDbType.Int), guard.Version), (Indexed("@schedule_modified", i + 1, SqlDbType.DateTime), guard.Modified)]);
            }
            text.Append(Call(call)).Append(CheckAt(i + 1));
            foreach (var argument in call.Arguments)
                if (argument.Parameter.Name is not ("@job_id" or "@no_job")) parameters.Add((argument.Parameter, argument.Value));
        }
        return new(text.ToString(), parameters, calls);
    }

    /// <summary>The sp_update_alert call that detaches a removed alert (call <paramref name="index"/>): by its name, with the zero job id.</summary>
    public static AgentSaveCall DetachAlert(int index, int alertId, string alertName) =>
        new("sp_update_alert", [new("@name", new("@name_" + index.ToString(CultureInfo.InvariantCulture), SqlDbType.NVarChar, 128), alertName), new("@job_id", NoJobParameter, Guid.Empty)], alertId);

    // --- The steps (AG-6b, src/shared/agent/steps.ts planAgentSteps) -------------------------------------------------------

    /// <summary>The arguments of a step's whole content, in the order sp_update_jobstep and sp_add_jobstep are passed them, then the proxy: @proxy_id,
    /// or @proxy_name = N'' for the service account (sp_update_jobstep's way to clear a proxy; sp_add_jobstep takes N'' as none).</summary>
    internal static readonly IReadOnlyList<(string Argument, SqlDbType Type, int Size)> StepWriteArguments =
    [
        ("@step_id", SqlDbType.Int, 0), ("@step_name", SqlDbType.NVarChar, 128), ("@subsystem", SqlDbType.NVarChar, 40), ("@command", SqlDbType.NVarChar, -1),
        ("@cmdexec_success_code", SqlDbType.Int, 0), ("@on_success_action", SqlDbType.TinyInt, 0), ("@on_success_step_id", SqlDbType.Int, 0), ("@on_fail_action", SqlDbType.TinyInt, 0),
        ("@on_fail_step_id", SqlDbType.Int, 0), ("@server", SqlDbType.NVarChar, 128), ("@database_name", SqlDbType.NVarChar, 128), ("@database_user_name", SqlDbType.NVarChar, 128),
        ("@retry_attempts", SqlDbType.Int, 0), ("@retry_interval", SqlDbType.Int, 0), ("@os_run_priority", SqlDbType.Int, 0), ("@output_file_name", SqlDbType.NVarChar, 200),
        ("@flags", SqlDbType.Int, 0)
    ];
    /// <summary>The prefix of the temporary names a renumbering save gives steps (steps.ts temporaryStepPrefix); a step's own name never starts with it.</summary>
    public const string TemporaryStepPrefix = "__varia_step_";
    private static readonly HashSet<string> StepProcedures = new(["sp_delete_jobstep", "sp_update_jobstep", "sp_add_jobstep"], StringComparer.Ordinal);
    private static readonly AgentParameter StartStepParameter = new("@start_step_id", SqlDbType.Int);
    /// <summary>A step call's argument, bound to its own parameter suffixed with the call's index, so each call's values stay apart.</summary>
    private static AgentSaveArgument Indexed(int index, string argument, SqlDbType type, int size, object? value) =>
        new(argument, new(argument + "_" + index.ToString(CultureInfo.InvariantCulture), type, size), value);
    private static AgentSaveArgument JobOf(AgentParameter jobId) => new("@job_id", jobId, null);

    /// <summary>Planner step (1): sp_delete_jobstep of described step <paramref name="stepId"/> (call <paramref name="index"/>).</summary>
    public static AgentSaveCall DeleteStep(int index, AgentParameter jobId, int stepId) =>
        new("sp_delete_jobstep", [JobOf(jobId), Indexed(index, "@step_id", SqlDbType.Int, 0, stepId)], Part: "the delete of step " + stepId.ToString(CultureInfo.InvariantCulture));
    /// <summary>What a temporary name's call sets besides the name. sp_update_jobstep fills every argument it is not given from the stored
    /// step and checks the result (sp_verify_jobstep), so a rename alone is refused for content the draft already fixed (a dropped database,
    /// an output file below sysadmin, a proxy or server gone). This content always passes; planner step (4) writes every step's own over it.</summary>
    internal static readonly IReadOnlyList<(string Argument, SqlDbType Type, int Size, object Value)> TemporaryStepContent =
    [
        ("@subsystem", SqlDbType.NVarChar, 40, "TSQL"), ("@database_name", SqlDbType.NVarChar, 128, "master"), ("@database_user_name", SqlDbType.NVarChar, 128, ""),
        ("@server", SqlDbType.NVarChar, 128, ""), ("@output_file_name", SqlDbType.NVarChar, 200, ""), ("@proxy_name", SqlDbType.NVarChar, 128, ""), ("@flags", SqlDbType.Int, 0, 0),
        ("@os_run_priority", SqlDbType.Int, 0, 0), ("@on_success_action", SqlDbType.TinyInt, 0, (byte)1), ("@on_success_step_id", SqlDbType.Int, 0, 0),
        ("@on_fail_action", SqlDbType.TinyInt, 0, (byte)2), ("@on_fail_step_id", SqlDbType.Int, 0, 0)
    ];
    /// <summary>Planner step (2): a surviving step's temporary name, at its id after the deletes, with <see cref="TemporaryStepContent"/>.</summary>
    public static AgentSaveCall RenameStep(int index, AgentParameter jobId, int stepId, string name) =>
        new("sp_update_jobstep", [JobOf(jobId), Indexed(index, "@step_id", SqlDbType.Int, 0, stepId), Indexed(index, "@step_name", SqlDbType.NVarChar, 128, name),
            .. TemporaryStepContent.Select(entry => Indexed(index, entry.Argument, entry.Type, entry.Size, entry.Value))], Part: "the renumbered steps");
    /// <summary>Planner step (3): a new step inserted at its final id under a temporary name (msdb shifts the later steps up).</summary>
    public static AgentSaveCall InsertStep(int index, AgentParameter jobId, int stepId, string name) =>
        new("sp_add_jobstep", [JobOf(jobId), Indexed(index, "@step_id", SqlDbType.Int, 0, stepId), Indexed(index, "@step_name", SqlDbType.NVarChar, 128, name)],
            Part: "new step " + stepId.ToString(CultureInfo.InvariantCulture));
    /// <summary>Planner step (4): a step's whole content into its final id: sp_update_jobstep, or New Job's sp_add_jobstep (<paramref name="add"/>).</summary>
    /// <remarks>sp_add_jobstep refuses a non-sysadmin any non-NULL @database_user_name (14583) before it turns N'' into NULL, so New Job sends an
    /// empty optional string as NULL; sp_update_jobstep reads NULL as "keep", so it is sent N'' to clear.</remarks>
    public static AgentSaveCall WriteStep(int index, AgentParameter jobId, AgentStepWriteDto write, bool add)
    {
        object? Optional(string text) => add && text.Length == 0 ? null : text;
        object?[] values = [write.Id, write.Name, write.Subsystem, write.Command, write.CmdexecSuccessCode, (byte)write.OnSuccessAction, write.OnSuccessStepId, (byte)write.OnFailAction,
            write.OnFailStepId, Optional(write.Server), write.DatabaseName, Optional(write.DatabaseUserName), write.RetryAttempts, write.RetryInterval, write.OsRunPriority, Optional(write.OutputFileName), write.Flags];
        var arguments = new List<AgentSaveArgument> { JobOf(jobId) };
        arguments.AddRange(StepWriteArguments.Select((entry, at) => Indexed(index, entry.Argument, entry.Type, entry.Size, values[at])));
        arguments.Add(write.ProxyId > 0 ? Indexed(index, "@proxy_id", SqlDbType.Int, 0, write.ProxyId) : Indexed(index, "@proxy_name", SqlDbType.NVarChar, 128, Optional("")));
        var id = write.Id.ToString(CultureInfo.InvariantCulture);
        return new(add ? "sp_add_jobstep" : "sp_update_jobstep", arguments, Part: "step " + id);
    }
    /// <summary>Planner step (5): the Start step, set last in a sp_update_job of its own once the steps are in place.</summary>
    public static AgentSaveCall StartStep(AgentParameter jobId, int stepId) => new("sp_update_job", [JobOf(jobId), new("@start_step_id", StartStepParameter, stepId)], Part: "the Start step");

    [GeneratedRegex(@"^EXEC @rc = msdb\.dbo\.(?<proc>\w+) (?<arg>@\w+) = (?<value>@\w+)(?<out> OUTPUT)?(?:, (?<arg>@\w+) = (?<value>@\w+)(?<out> OUTPUT)?)*;$", RegexOptions.CultureInvariant)]
    private static partial Regex SaveCall();
    private static readonly HashSet<string> SaveProcedures = new(["sp_update_job", "sp_update_alert", "sp_add_job", "sp_add_jobserver", "sp_delete_jobstep", "sp_update_jobstep", "sp_add_jobstep",
        // AG-6c (AgentSql.Schedules.cs JobScheduleProcedures; spelled out, as field initialisers of another part of this class may not have run).
        "sp_detach_schedule", "sp_attach_schedule", "sp_update_schedule", "sp_add_jobschedule"], StringComparer.Ordinal);
    /// <summary>The procedures only a job save calls, in its own shape: the one-call write lints refuse them (New Job's id is an OUTPUT, a
    /// detach needs its alert guard, steps are renumbered only by the planner's whole sequence, and schedules change only in a job save's or
    /// the Schedules document's guarded batch).</summary>
    internal static readonly IReadOnlySet<string> SaveOnly = new HashSet<string>(["sp_add_job", "sp_add_jobserver", "sp_update_alert", "sp_delete_jobstep", "sp_update_jobstep", "sp_add_jobstep",
        "sp_add_jobschedule", "sp_attach_schedule", "sp_detach_schedule", "sp_add_schedule", "sp_update_schedule", "sp_delete_schedule"], StringComparer.Ordinal);

    /// <summary>Problems with a job save's full text; empty when it passes. It opens with <see cref="NewJobHead"/> (New Job: sp_add_job, its steps'
    /// sp_add_jobstep with their whole content, sp_add_jobserver, then at most the Start step's sp_update_job) or with <see cref="Resolve"/> and
    /// <see cref="StaleGuard"/> exactly, then in this order: the job's own sp_update_job at most once, each sp_update_alert after its own
    /// <see cref="AlertGuard"/>, the steps' sp_delete_jobstep, their temporary names (sp_update_jobstep with only the step id and name), the new
    /// steps' sp_add_jobstep (step id and name only), each step's whole content (sp_update_jobstep), and the Start step's sp_update_job (only
    /// <c>@start_step_id</c>). The Schedules section's calls (AG-6c) come last in both, in the order detach (never for New Job), attach and update
    /// (each after its own <see cref="ScheduleGuard"/>), add. Each call is one msdb call of the catalogue's write procedures and arguments, each
    /// argument once and by the parameter of its own name (a removed alert's <c>@name</c> by <c>@name_&lt;index&gt;</c> and <c>@job_id</c> by
    /// <c>@no_job</c>; a step or schedule call's arguments but <c>@job_id</c> by <c>&lt;argument&gt;_&lt;index&gt;</c>; sp_add_job's <c>@job_id</c> only
    /// as its OUTPUT), followed by <see cref="CheckAt"/> with its index, counting from 1. No other statement, literal or procedure, and never
    /// xp_servicecontrol.</summary>
    public static List<string> LintJobSave(string text, AgentCatalog? catalog = null)
    {
        catalog ??= AgentCatalog.Current;
        var problems = new List<string>();
        if (text.Contains("xp_servicecontrol", StringComparison.OrdinalIgnoreCase)) problems.Add("uses xp_servicecontrol");
        // Resolve opens with New Job's declaration too, so an existing job's head is tried first.
        var create = !text.StartsWith(Resolve, StringComparison.Ordinal) && text.StartsWith(NewJobHead, StringComparison.Ordinal);
        string rest;
        if (create) rest = text[NewJobHead.Length..];
        else if (text.StartsWith(Resolve + StaleGuard, StringComparison.Ordinal)) rest = text[(Resolve + StaleGuard).Length..];
        else { problems.Add("does not open with New Job's declaration or the job's identity and STALE guards"); return problems; }
        var procedures = new List<string>();
        var phases = new List<int>();
        var stepWhole = StepWriteArguments.Select(entry => entry.Argument).Append("@job_id").ToHashSet(StringComparer.Ordinal);
        for (var index = 1; rest.Length > 0; index++)
        {
            if (index > CallIndexLimit) { problems.Add("makes more than 255 calls"); return problems; }
            var guarded = rest.StartsWith(AlertGuardHead, StringComparison.Ordinal);
            if (guarded)
            {
                var guard = AlertGuard(index);
                if (!rest.StartsWith(guard, StringComparison.Ordinal)) { problems.Add("call " + index + " has an alert guard that is not exactly its own"); return problems; }
                rest = rest[guard.Length..];
            }
            var scheduleGuarded = rest.StartsWith(ScheduleGuardHead, StringComparison.Ordinal);
            if (scheduleGuarded)
            {
                var guard = ScheduleGuard(index);
                if (!rest.StartsWith(guard, StringComparison.Ordinal)) { problems.Add("call " + index + " has a schedule guard that is not exactly its own"); return problems; }
                rest = rest[guard.Length..];
            }
            var end = rest.IndexOf('\n', StringComparison.Ordinal);
            if (end < 0) { problems.Add("call " + index + " is not followed by its return-code check"); return problems; }
            var call = rest[..end];
            rest = rest[end..];
            var check = CheckAt(index);
            if (!rest.StartsWith(check, StringComparison.Ordinal)) { problems.Add("call " + index + " is not followed by its return-code check"); return problems; }
            rest = rest[check.Length..];
            var match = SaveCall().Match(call);
            if (!match.Success) { problems.Add("call " + index + " is not one msdb call in the save shape"); return problems; }
            var procedure = match.Groups["proc"].Value;
            procedures.Add(procedure);
            if (!SaveProcedures.Contains(procedure) || !catalog.WriteArguments.TryGetValue(procedure, out var allowed)) { problems.Add("EXECs " + procedure + ", which a job save does not call"); continue; }
            if (guarded != (procedure == "sp_update_alert")) problems.Add(guarded ? "guards a call that is not sp_update_alert" : "detaches an alert without its guard");
            if (scheduleGuarded != (procedure is "sp_update_schedule" or "sp_attach_schedule")) problems.Add(scheduleGuarded ? "guards a call that does not change or attach a schedule" : "changes or attaches a schedule without its guard");
            var schedule = JobScheduleProcedures.Contains(procedure);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 0; i < match.Groups["arg"].Captures.Count; i++)
            {
                var argument = match.Groups["arg"].Captures[i].Value;
                var value = match.Groups["value"].Captures[i].Value;
                var output = match.Groups["out"].Captures.Any(capture => capture.Index > match.Groups["value"].Captures[i].Index
                    && (i + 1 == match.Groups["arg"].Captures.Count || capture.Index < match.Groups["arg"].Captures[i + 1].Index));
                if (!allowed.Contains(argument)) problems.Add("passes " + argument + " to " + procedure);
                if (!seen.Add(argument)) problems.Add("passes " + argument + " twice");
                var at = index.ToString(CultureInfo.InvariantCulture);
                var expected = procedure == "sp_update_alert"
                    ? argument == "@name" ? "@name_" + at : argument == "@job_id" ? "@no_job" : argument
                    // A step or schedule call's arguments are indexed by the call, all but the job's own id.
                    : (schedule || StepProcedures.Contains(procedure)) && argument != "@job_id" ? argument + "_" + at : argument;
                if (value != expected) problems.Add("passes " + argument + " another parameter's value");
                if (output != (procedure == "sp_add_job" && argument == "@job_id")) problems.Add(output ? "passes " + argument + " as an OUTPUT" : "does not take the new job's id as sp_add_job's OUTPUT");
            }
            if (procedure is "sp_update_job" or "sp_add_jobserver" && !seen.Contains("@job_id")) problems.Add(procedure + " does not name the job");
            if (procedure == "sp_add_job" && !seen.Contains("@job_id")) problems.Add("does not take the new job's id as sp_add_job's OUTPUT");
            if (procedure == "sp_update_alert" && !(seen.Contains("@name") && seen.Contains("@job_id"))) problems.Add("detaches an alert without its name and the zero job id");
            if (procedure is "sp_detach_schedule" or "sp_attach_schedule" or "sp_add_jobschedule" && !seen.Contains("@job_id")) problems.Add(procedure + " does not name the job");
            if (procedure is "sp_detach_schedule" or "sp_attach_schedule" or "sp_update_schedule" && !seen.Contains("@schedule_id")) problems.Add(procedure + " does not name the schedule");
            if (procedure == "sp_add_jobschedule" && !seen.Contains("@name")) problems.Add("adds a schedule without its name");
            // The step calls' shapes (AG-6b): an id and name only (a temporary name, or a step inserted under one), a delete by id, or the whole content.
            var whole = seen.IsSupersetOf(stepWhole) && seen.Count == stepWhole.Count + 1 && seen.Contains("@proxy_id") != seen.Contains("@proxy_name");
            var named = seen.SetEquals(["@job_id", "@step_id", "@step_name"]);
            var renamed = seen.SetEquals(TemporaryStepContent.Select(entry => entry.Argument).Concat(["@job_id", "@step_id", "@step_name"]));
            var startOnly = procedure == "sp_update_job" && seen.SetEquals(["@job_id", "@start_step_id"]);
            if (procedure == "sp_update_job" && seen.Contains("@start_step_id") && !startOnly) problems.Add("sets the Start step with other job settings");
            if (procedure == "sp_delete_jobstep" && !seen.SetEquals(["@job_id", "@step_id"])) problems.Add("deletes a step without its job and id alone");
            if (procedure == "sp_update_jobstep" && !whole && !renamed) problems.Add("updates a step with neither its whole content nor only a temporary name");
            if (procedure == "sp_add_jobstep" && !(create ? whole : named)) problems.Add(create ? "adds a new job's step without its whole content" : "inserts a step with more than its id and temporary name");
            // Schedule calls follow everything else (their own order is checked below).
            phases.Add(schedule ? (create ? 4 : 7) : create
                ? procedure switch { "sp_add_job" => 0, "sp_add_jobstep" => 1, "sp_add_jobserver" => 2, _ => startOnly ? 3 : -1 }
                : procedure switch
                {
                    "sp_update_job" => startOnly ? 6 : 0,
                    "sp_update_alert" => 1,
                    "sp_delete_jobstep" => 2,
                    "sp_update_jobstep" => renamed ? 3 : 5,
                    "sp_add_jobstep" => 4,
                    _ => -1
                });
        }
        // The Schedules section's calls come last, in the order detach, attach, update, add.
        var ranks = procedures.Select(procedure => JobScheduleProcedures.ToList().IndexOf(procedure)).ToList();
        if (ranks.SkipWhile(rank => rank < 0).Any(rank => rank < 0)) problems.Add("makes a job or alert call after a schedule call");
        var scheduleRanks = ranks.Where(rank => rank >= 0).ToList();
        if (scheduleRanks.Zip(scheduleRanks.Skip(1)).Any(pair => pair.Second < pair.First)) problems.Add("makes its schedule calls out of order (detach, attach, update, add)");
        if (create && scheduleRanks.Contains(0)) problems.Add("detaches a schedule from a new job");
        if (procedures.Count == 0) problems.Add("makes no call");
        var ordered = !phases.Contains(-1) && phases.Zip(phases.Skip(1)).All(pair => pair.First <= pair.Second);
        if (create && !(ordered && phases.Count > 0 && phases[0] == 0 && phases.Count(phase => phase == 0) == 1 && phases.Count(phase => phase == 2) == 1 && phases.Count(phase => phase == 3) <= 1))
            problems.Add("New Job's save is not sp_add_job, its steps, sp_add_jobserver, at most the Start step, then its schedules");
        if (!create)
        {
            if (procedures.Any(procedure => procedure is "sp_add_job" or "sp_add_jobserver")) problems.Add("adds a job in an existing job's save");
            if (phases.Count(phase => phase == 0) > 1 || phases.Count(phase => phase == 6) > 1 || !ordered)
                problems.Add("updates the job more than once, or calls out of the save's order (job, alerts, step deletes, temporary names, inserts, step contents, Start step, schedules)");
        }
        return problems;
    }

    /// <summary>The job document's batches in their shapes (New Job's with every argument; an existing job's with every argument and two removed
    /// alerts) under <see cref="LintJobSave"/>, each binding exactly the parameters it uses.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> LintJobSaves()
    {
        static IReadOnlyList<AgentSaveArgument> Every(bool create) =>
        [
            create ? new("@job_name", new("@job_name", SqlDbType.NVarChar, 128), "x") : new("@job_id", new("@job_id", SqlDbType.UniqueIdentifier), null),
            ..(create ? [] : new AgentSaveArgument[] { new("@new_name", new("@new_name", SqlDbType.NVarChar, 128), "x") }),
            ..JobArguments.Select(entry => new AgentSaveArgument(entry.Argument, new(entry.Argument, entry.Type, entry.Size), null)),
            ..(create ? new AgentSaveArgument[] { new("@job_id", new("@job_id", SqlDbType.UniqueIdentifier), null, Output: true) } : [])
        ];
        var job = new AgentParameter("@job_id", SqlDbType.UniqueIdentifier);
        static AgentStepWriteDto Write(int id, int proxy) => new(id, "s" + id, "TSQL", "", "master", "", 3, 0, 4, 1, 0, 0, "", 0, 0, proxy, "", 0);
        var batches = new (string Name, AgentSaveBatch Batch)[]
        {
            ("new job", JobSave(true, [new("sp_add_job", Every(true)), new("sp_add_jobserver", [new("@job_id", new("@job_id", SqlDbType.UniqueIdentifier), null)])])),
            ("job update", JobSave(false, [new("sp_update_job", Every(false)), DetachAlert(2, 7, "a"), DetachAlert(3, 8, "b")], "x", Guid.Empty, 1, DateTime.UnixEpoch)),
            // AG-6c: the Schedules section's calls after the job's own, every kind with every value.
            ("job update with schedules", JobSave(false, [new("sp_update_job", Every(false)), DetachAlert(2, 7, "a"), DetachSchedule(3, 4, true), DetachSchedule(4, 5, false),
                AttachSchedule(5, 7, new(1, DateTime.UnixEpoch)), UpdateSchedule(6, 6, new(1, DateTime.UnixEpoch), "x", true, new int[TimingArguments.Count]),
                AddJobSchedule(7, "x", true, new int[TimingArguments.Count])], "x", Guid.Empty, 1, DateTime.UnixEpoch)),
            ("schedules only", JobSave(false, [UpdateSchedule(1, 6, new(1, DateTime.UnixEpoch), null, false, null)], "x", Guid.Empty, 1, DateTime.UnixEpoch)),
            ("new job with schedules", JobSave(true, [new("sp_add_job", Every(true)), new("sp_add_jobserver", [new("@job_id", new("@job_id", SqlDbType.UniqueIdentifier), null)]),
                AttachSchedule(3, 6, new(1, DateTime.UnixEpoch)), UpdateSchedule(4, 6, new(1, DateTime.UnixEpoch), null, null, new int[TimingArguments.Count]),
                AddJobSchedule(5, "x", false, new int[TimingArguments.Count])])),
            // AG-6b: New Job with two steps (a proxy and the service account) and a Start step; an existing job's renumbering save in the planner's order.
            ("new job with steps", JobSave(true, [new("sp_add_job", Every(true)), WriteStep(2, job, Write(1, 3), true), WriteStep(3, job, Write(2, 0), true),
                new("sp_add_jobserver", [new("@job_id", job, null)]), StartStep(job, 2)])),
            ("job steps renumbered", JobSave(false, [new("sp_update_job", Every(false)), DetachAlert(2, 7, "a"), DeleteStep(3, job, 3), RenameStep(4, job, 1, "t1"), RenameStep(5, job, 2, "t2"),
                InsertStep(6, job, 1, "t3"), WriteStep(7, job, Write(1, 0), false), WriteStep(8, job, Write(2, 5), false), WriteStep(9, job, Write(3, 0), false), StartStep(job, 2)],
                "x", Guid.Empty, 1, DateTime.UnixEpoch)),
            // Both: New Job's steps and Start step before its schedules; an existing job's renumbering before its schedule calls.
            ("new job with steps and schedules", JobSave(true, [new("sp_add_job", Every(true)), WriteStep(2, job, Write(1, 0), true), new("sp_add_jobserver", [new("@job_id", job, null)]),
                StartStep(job, 1), AttachSchedule(5, 6, new(1, DateTime.UnixEpoch)), AddJobSchedule(6, "x", true, new int[TimingArguments.Count])])),
            ("job steps and schedules", JobSave(false, [DeleteStep(1, job, 2), WriteStep(2, job, Write(1, 0), false), StartStep(job, 1), DetachSchedule(4, 4, false),
                UpdateSchedule(5, 6, new(1, DateTime.UnixEpoch), "x", null, null)], "x", Guid.Empty, 1, DateTime.UnixEpoch))
        };
        foreach (var (name, batch) in batches)
        {
            var problems = LintJobSave(batch.Text);
            var used = Variable().Matches(Literal().Replace(batch.Text, "''")).Select(match => match.Value).Where(variable => variable is not ("@rc" or "@job_id")).ToHashSet(StringComparer.Ordinal);
            // An msdb call names the procedure's argument on the left of each '='; those are not the batch's variables.
            var values = Variable().Matches(Regex.Replace(Literal().Replace(batch.Text, "''"), @"@\w+ = (?=@)", "= ")).Select(match => match.Value).Where(variable => variable is not ("@rc" or "@job_id")).ToHashSet(StringComparer.Ordinal);
            var bound = batch.Parameters.Select(parameter => parameter.Parameter.Name).ToHashSet(StringComparer.Ordinal);
            foreach (var variable in values.Except(bound)) problems.Add("binds the undeclared " + variable);
            foreach (var variable in bound.Except(used)) problems.Add("declares the unused " + variable);
            if (batch.Parameters.Select(parameter => parameter.Parameter.Name).Distinct(StringComparer.Ordinal).Count() != batch.Parameters.Count) problems.Add("binds a parameter twice");
            yield return ("job save " + name, problems);
        }
    }
}
