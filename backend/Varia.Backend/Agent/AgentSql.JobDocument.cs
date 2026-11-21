using System.Data;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Varia.Backend.Agent;

/// <summary>One msdb call of a job save: the procedure, its arguments in order (each bound to the parameter of the same name, or for a
/// removed alert's <c>@name</c> to <c>@name_&lt;index&gt;</c> and its <c>@job_id</c> to <c>@no_job</c>), and the parameters' values.</summary>
internal sealed record AgentSaveCall(string Procedure, IReadOnlyList<AgentSaveArgument> Arguments, int? AlertId = null);
internal sealed record AgentSaveArgument(string Name, AgentParameter Parameter, object? Value, bool Output = false);
/// <summary>A job save's batch: its text, its parameters with their values, and which call each THROW state names (index 1 is the first call).</summary>
internal sealed record AgentSaveBatch(string Text, IReadOnlyList<(AgentParameter Parameter, object? Value)> Parameters, IReadOnlyList<AgentSaveCall> Calls);

/// <summary>The job document (AG-6a): its describe's reads (run by <see cref="AgentReader"/>, each in <see cref="All"/> and so under
/// <see cref="LintRead"/>) and its save. A save is one batch in one transaction (the action's XACT_ABORT prologue and a SqlTransaction):
/// an existing job's resolves the job by name and date_created (<see cref="Resolve"/>, 50010), then checks that its version_number and
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

    internal const string StaleGuard = "IF NOT EXISTS (SELECT 1 FROM msdb.dbo.sysjobs_view AS j WHERE j.job_id = @job_id AND j.version_number = @version AND j.date_modified = @modified) THROW 50011, N'"
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
    private static readonly AgentParameter CreatedParameter = new("@created", SqlDbType.Char, 19);
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
    /// (resolve, STALE guard, then the calls). <paramref name="name"/>, <paramref name="created"/>, <paramref name="version"/> and
    /// <paramref name="modified"/> bind the guards of an existing job's.</summary>
    public static AgentSaveBatch JobSave(bool create, IReadOnlyList<AgentSaveCall> calls, string? name = null, string? created = null, int? version = null, DateTime? modified = null)
    {
        if (calls.Count == 0 || calls.Count > CallIndexLimit) throw new InvalidOperationException("A job save makes 1 to 255 calls.");
        var text = new StringBuilder(create ? NewJobHead : Resolve + StaleGuard);
        var parameters = new List<(AgentParameter, object?)>();
        if (!create) parameters.AddRange([(NameParameter, name), (CreatedParameter, created), (VersionParameter, version), (ModifiedParameter, modified)]);
        if (calls.Any(call => call.AlertId is not null)) parameters.Add((NoJobParameter, Guid.Empty));
        for (var i = 0; i < calls.Count; i++)
        {
            var call = calls[i];
            if (call.AlertId is { } alert)
            {
                text.Append(AlertGuard(i + 1));
                parameters.Add((new AgentParameter("@alert_id_" + (i + 1).ToString(CultureInfo.InvariantCulture), SqlDbType.Int), alert));
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

    [GeneratedRegex(@"^EXEC @rc = msdb\.dbo\.(?<proc>\w+) (?<arg>@\w+) = (?<value>@\w+)(?<out> OUTPUT)?(?:, (?<arg>@\w+) = (?<value>@\w+)(?<out> OUTPUT)?)*;$", RegexOptions.CultureInvariant)]
    private static partial Regex SaveCall();
    private static readonly HashSet<string> SaveProcedures = new(["sp_update_job", "sp_update_alert", "sp_add_job", "sp_add_jobserver"], StringComparer.Ordinal);
    /// <summary>The procedures only a job save calls, in its own shape: the one-call write lints refuse them (New Job's id is an OUTPUT, and a
    /// detach needs its alert guard).</summary>
    internal static readonly IReadOnlySet<string> SaveOnly = new HashSet<string>(["sp_add_job", "sp_add_jobserver", "sp_update_alert"], StringComparer.Ordinal);

    /// <summary>Problems with a job save's full text; empty when it passes. It opens with <see cref="NewJobHead"/> (New Job: sp_add_job, then
    /// sp_add_jobserver, nothing else) or with <see cref="Resolve"/> and <see cref="StaleGuard"/> exactly (sp_update_job at most once, first, and
    /// sp_update_alert, each after its own <see cref="AlertGuard"/>); then each call is one msdb call of the catalogue's write procedures and
    /// arguments, each argument once and by the parameter of its own name (a removed alert's <c>@name</c> by <c>@name_&lt;index&gt;</c> and
    /// <c>@job_id</c> by <c>@no_job</c>; sp_add_job's <c>@job_id</c> only as its OUTPUT), followed by <see cref="CheckAt"/> with its index,
    /// counting from 1. No other statement, literal or procedure, and never xp_servicecontrol.</summary>
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
            var seen = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 0; i < match.Groups["arg"].Captures.Count; i++)
            {
                var argument = match.Groups["arg"].Captures[i].Value;
                var value = match.Groups["value"].Captures[i].Value;
                var output = match.Groups["out"].Captures.Any(capture => capture.Index > match.Groups["value"].Captures[i].Index
                    && (i + 1 == match.Groups["arg"].Captures.Count || capture.Index < match.Groups["arg"].Captures[i + 1].Index));
                if (!allowed.Contains(argument)) problems.Add("passes " + argument + " to " + procedure);
                if (!seen.Add(argument)) problems.Add("passes " + argument + " twice");
                var expected = procedure == "sp_update_alert"
                    ? argument == "@name" ? "@name_" + index.ToString(CultureInfo.InvariantCulture) : argument == "@job_id" ? "@no_job" : argument
                    : argument;
                if (value != expected) problems.Add("passes " + argument + " another parameter's value");
                if (output != (procedure == "sp_add_job" && argument == "@job_id")) problems.Add(output ? "passes " + argument + " as an OUTPUT" : "does not take the new job's id as sp_add_job's OUTPUT");
            }
            if (procedure is "sp_update_job" or "sp_add_jobserver" && !seen.Contains("@job_id")) problems.Add(procedure + " does not name the job");
            if (procedure == "sp_add_job" && !seen.Contains("@job_id")) problems.Add("does not take the new job's id as sp_add_job's OUTPUT");
            if (procedure == "sp_update_alert" && !(seen.Contains("@name") && seen.Contains("@job_id"))) problems.Add("detaches an alert without its name and the zero job id");
        }
        if (procedures.Count == 0) problems.Add("makes no call");
        if (create && !procedures.SequenceEqual(["sp_add_job", "sp_add_jobserver"])) problems.Add("New Job's save is not sp_add_job then sp_add_jobserver");
        if (!create)
        {
            if (procedures.Any(procedure => procedure is "sp_add_job" or "sp_add_jobserver")) problems.Add("adds a job in an existing job's save");
            if (procedures.Count(procedure => procedure == "sp_update_job") > 1 || procedures.Skip(1).Contains("sp_update_job")) problems.Add("updates the job more than once, or after an alert");
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
        var batches = new (string Name, AgentSaveBatch Batch)[]
        {
            ("new job", JobSave(true, [new("sp_add_job", Every(true)), new("sp_add_jobserver", [new("@job_id", new("@job_id", SqlDbType.UniqueIdentifier), null)])])),
            ("job update", JobSave(false, [new("sp_update_job", Every(false)), DetachAlert(2, 7, "a"), DetachAlert(3, 8, "b")], "x", "2026-01-01T00:00:00", 1, DateTime.UnixEpoch))
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
            yield return ("job save " + name, problems);
        }
    }
}
