using System.Data;
using System.Text.RegularExpressions;

namespace Varia.Backend.Agent;

/// <summary>One msdb write a job verb runs (AG-2): its batch text and the parameters it binds besides @name and @expected_job_id.</summary>
internal sealed record AgentWrite(string Id, string Procedure, string Text, IReadOnlyList<AgentParameter> Parameters);

/// <summary>SQL Server Agent's writes (docs/agent-plan.md › SQL rules) and the reads the job verbs and the service dialogs make outside
/// <see cref="AgentReader"/>. Every write is one batch of exactly this shape: <see cref="Resolve"/> finds the job by name and the
/// job_id the tree listed (the identity guard: 50010 when another job has taken the name since), one
/// <c>EXEC @rc = msdb.dbo.&lt;procedure&gt; @arg = @arg, …;</c> of a procedure and arguments the catalogue lists
/// (<see cref="AgentCatalog.WriteArguments"/>), then <see cref="Check"/>: msdb's procedures fail with RAISERROR and a return code of 1,
/// leaving @@ERROR 0 and no TRY to catch (AG-0), so the batch THROWs 50012 itself. <see cref="LintExecutable"/> admits nothing else:
/// no other statement, no literal value and never <c>xp_servicecontrol</c>, whose Start and Stop Varia does not use.</summary>
internal static partial class AgentSql
{
    /// <summary>The identity guard's message (50010, NOT_FOUND).</summary>
    public const string ChangedMessage = "This job is not the one Object Explorer listed: it was deleted or replaced since. Refresh Object Explorer and try again.";
    /// <summary>The return-code check's message (50012), which follows msdb's own error when it sent one.</summary>
    public const string RefusedMessage = "SQL Server Agent did not make the change.";

    internal const string Resolve = "DECLARE @job_id uniqueidentifier, @rc int;\n"
        + "SELECT @job_id = j.job_id FROM msdb.dbo.sysjobs_view AS j WHERE j.name = @name AND j.job_id = @expected_job_id;\n"
        + "IF @job_id IS NULL THROW 50010, N'" + ChangedMessage + "', 1;\n";
    internal const string Check = "\nIF @@ERROR <> 0 OR @rc <> 0 THROW 50012, N'" + RefusedMessage + "', 1;";

    private static AgentWrite Write(string id, string procedure, params AgentParameter[] parameters) =>
        new(id, procedure, Resolve + "EXEC @rc = msdb.dbo." + procedure + " @job_id = @job_id" + string.Concat(parameters.Select(parameter => ", " + parameter.Name + " = " + parameter.Name)) + ";" + Check,
            parameters);

    private static readonly AgentParameter StepName = new("@step_name", SqlDbType.NVarChar, 128);
    public static readonly AgentWrite StartJob = Write("startJob", "sp_start_job");
    public static readonly AgentWrite StartJobAtStep = Write("startJobAtStep", "sp_start_job", StepName);
    public static readonly AgentWrite StopJob = Write("stopJob", "sp_stop_job");
    public static readonly AgentWrite SetEnabled = Write("setEnabled", "sp_update_job", new AgentParameter("@enabled", SqlDbType.TinyInt));
    public static readonly AgentWrite RenameJob = Write("renameJob", "sp_update_job", new AgentParameter("@new_name", SqlDbType.NVarChar, 128));
    public static readonly AgentWrite DeleteJob = Write("deleteJob", "sp_delete_job", new AgentParameter("@delete_history", SqlDbType.Bit), new AgentParameter("@delete_unused_schedule", SqlDbType.Bit));

    public static IReadOnlyList<AgentWrite> Writes { get; } = [StartJob, StartJobAtStep, StopJob, SetEnabled, RenameJob, DeleteJob];

    /// <summary>A job by name, for Delete Object, Start Job at Step and the job document: its immutable job id, its date_created to the second (shown, not compared), whether it is
    /// enabled, and its owner where the login may see that principal. sysjobs_view filters by role itself.</summary>
    public const string JobByName = "SELECT j.job_id, j.name, CONVERT(char(19), j.date_created, 126) AS created, j.enabled, own.name AS owner\n"
        + "FROM msdb.dbo.sysjobs_view AS j LEFT JOIN sys.server_principals AS own ON own.sid = j.owner_sid\nWHERE j.name = @name;";

    /// <summary>What the service verbs act on: the machine SQL Server runs on (a failover cluster instance names its active node; the
    /// verbs refuse one), the instance (null for the default), and whether it is clustered.</summary>
    public const string ServiceHost = "SELECT CONVERT(nvarchar(128), SERVERPROPERTY('ComputerNamePhysicalNetBIOS')) AS machine, CONVERT(nvarchar(128), SERVERPROPERTY('InstanceName')) AS instance,\n"
        + "CONVERT(int, SERVERPROPERTY('IsClustered')) AS is_clustered;";

    [GeneratedRegex(@"^EXEC @rc = msdb\.dbo\.(?<proc>\w+) @job_id = @job_id(?:, (?<arg>@\w+) = (?<value>@\w+))*;$", RegexOptions.CultureInvariant)]
    private static partial Regex WriteCall();

    /// <summary>Problems with a write's full text; empty when it passes. The batch must be <see cref="Resolve"/>, one call and
    /// <see cref="Check"/> exactly, the call's procedure one the catalogue lists for writes with each argument its own and passed once, by
    /// the parameter of its own name.</summary>
    public static List<string> LintExecutable(string text, AgentCatalog? catalog = null)
    {
        catalog ??= AgentCatalog.Current;
        var problems = new List<string>();
        if (text.Contains("xp_servicecontrol", StringComparison.OrdinalIgnoreCase)) problems.Add("uses xp_servicecontrol");
        if (!text.StartsWith(Resolve, StringComparison.Ordinal)) { problems.Add("does not resolve the job by its identity first"); return problems; }
        if (!text.EndsWith(Check, StringComparison.Ordinal)) { problems.Add("does not check the return code last"); return problems; }
        var call = text[Resolve.Length..^Check.Length];
        var match = WriteCall().Match(call);
        if (!match.Success) { problems.Add("is not one msdb call in the write shape"); return problems; }
        var procedure = match.Groups["proc"].Value;
        if (SaveOnly.Contains(procedure)) { problems.Add("EXECs " + procedure + ", which only a job save calls"); return problems; }
        if (!catalog.WriteArguments.TryGetValue(procedure, out var allowed)) { problems.Add("EXECs " + procedure + ", which is not an Agent write procedure"); return problems; }
        var seen = new HashSet<string>(StringComparer.Ordinal) { "@job_id" };
        // sp_purge_jobhistory lists @job_id for Delete History, whose batch has its own lint (LintHistoryDelete); a job verb never purges.
        if (!allowed.Contains("@job_id") || procedure == "sp_purge_jobhistory") problems.Add("passes @job_id to " + procedure);
        for (var i = 0; i < match.Groups["arg"].Captures.Count; i++)
        {
            var argument = match.Groups["arg"].Captures[i].Value;
            if (!allowed.Contains(argument)) problems.Add("passes " + argument + " to " + procedure);
            if (!seen.Add(argument)) problems.Add("passes " + argument + " twice");
            if (match.Groups["value"].Captures[i].Value != argument) problems.Add("passes " + argument + " another parameter's value");
        }
        return problems;
    }

    /// <summary>Every write with its lint problems, and the job verbs' and service dialogs' own reads under <see cref="LintRead"/>.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> LintWrites()
    {
        foreach (var write in Writes)
        {
            var problems = LintExecutable(write.Text);
            // Every parameter it declares is used, and it binds only @name, @expected_job_id and its own.
            var used = Variable().Matches(Literal().Replace(write.Text, "''")).Select(match => match.Value).ToHashSet(StringComparer.Ordinal);
            foreach (var parameter in write.Parameters) if (!used.Contains(parameter.Name)) problems.Add("declares the unused " + parameter.Name);
            yield return ("write " + write.Id, problems);
        }
        yield return ("job by name", LintRead(JobByName, null));
        yield return ("service host", LintRead(ServiceHost, null));
        // SQL Server Agent Properties' server-scope writes and reads (AG-8a, AgentSql.Properties.cs).
        foreach (var item in LintServerWrites()) yield return item;
        // The job document's saves (AG-6a, AgentSql.JobDocument.cs).
        foreach (var item in LintJobSaves()) yield return item;
        // Delete History's batches (AG-5a, AgentSql.History.cs).
        foreach (var item in LintHistoryWrites()) yield return item;
        // The Schedules document's saves (AG-6c, AgentSql.Schedules.cs).
        foreach (var item in LintScheduleSaves()) yield return item;
        // The proxy document's Save, Rename and Delete (AG-8b, AgentSql.Proxy.cs).
        foreach (var item in LintProxySaves()) yield return item;
    }
}
