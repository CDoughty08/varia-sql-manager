using System.Data;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Varia.Backend.Agent;

/// <summary>The Log File Viewer's job history (AG-5a): its reads, run by <see cref="AgentReader"/> under <see cref="LintRead"/> like every Agent
/// read, and Delete History's write. The reads go through msdb.dbo.sp_help_jobhistory in FULL mode, which every Agent role may run and which
/// filters a SQLAgentUserRole login to its own jobs: one job by @job_id, else every job, and with a date window from a start date the server
/// computes from its own clock. One row's whole message reads sysjobhistory directly (sysadmin; other roles read the captured row through
/// sp_help_jobhistory). Delete History is one batch in one transaction: per checked job, the job resolved by its id through sysjobs_view (50010
/// when it is gone or hidden), then sp_purge_jobhistory with @job_id, never without (msdb would purge every job's history), and the return-code
/// check whose THROW carries the job's index. "Older than" computes and guards the cut-off as SQL Server Agent Properties' purge does
/// (<see cref="PurgeCutoff"/>, <see cref="PurgeGuard"/>, <see cref="PurgeClamp"/>). <see cref="LintHistoryDelete"/> admits nothing else.</summary>
internal static partial class AgentSql
{
    private static readonly string[] HistoryColumns = ["instance_id", "job_id", "step_id", "step_name", "sql_message_id", "sql_severity", "message", "run_status", "run_date", "run_time", "run_duration",
        "retries_attempted"];

    /// <summary>The window's first day as msdb stores run_date (yyyymmdd), @days back from the server's clock, a day early so the outcome row of a
    /// run that started just before the window still groups its steps.</summary>
    private const string HistoryStart = "DECLARE @start_date int = CONVERT(int, CONVERT(char(8), DATEADD(day, -@days - 1, CONVERT(datetime, SYSDATETIME())), 112));\n";
    private static readonly AgentParameter Days = new("@days", SqlDbType.Int);
    private static readonly AgentParameter JobId = new("@job_id", SqlDbType.UniqueIdentifier);

    /// <summary>Every job's history the login may see, newest first.</summary>
    public static readonly AgentStatement HistoryAll = new("historyAll", "EXEC msdb.dbo.sp_help_jobhistory @mode = N'FULL';", HistoryColumns, [], "historyRows");
    /// <summary>Every job's history from the window's start.</summary>
    public static readonly AgentStatement HistoryAllSince = new("historyAllSince", HistoryStart + "EXEC msdb.dbo.sp_help_jobhistory @start_run_date = @start_date, @mode = N'FULL';", HistoryColumns,
        [Days], "historyRows");
    /// <summary>One job's history from the window's start (<see cref="History"/> reads it whole).</summary>
    public static readonly AgentStatement HistorySince = new("historySince", HistoryStart + "EXEC msdb.dbo.sp_help_jobhistory @job_id = @job_id, @start_run_date = @start_date, @mode = N'FULL';",
        HistoryColumns, [JobId, Days], "historyRows");
    /// <summary>One history row's whole message (sysadmin: no Agent role may read sysjobhistory).</summary>
    public static readonly AgentStatement HistoryMessage = new("historyMessage", "SELECT h.message FROM msdb.dbo.sysjobhistory AS h WHERE h.instance_id = @instance_id AND h.job_id = @job_id;",
        ["message"], [new("@instance_id", SqlDbType.Int), JobId], "listRows");

    // --- Delete History -------------------------------------------------------------------------------------------------

    /// <summary>The job guard's message (50010, NOT_FOUND).</summary>
    public const string HistoryJobGoneMessage = "A checked job no longer exists, or this login no longer sees it. Refresh the Log File Viewer and try again; no history was deleted.";
    internal const string HistoryAllHead = "DECLARE @job_id uniqueidentifier, @rc int;\nBEGIN TRANSACTION;\n";
    internal const string HistoryOlderHead = "DECLARE @job_id uniqueidentifier, @rc int, @oldest_date datetime;\n" + PurgeCutoff + PurgeGuard + PurgeClamp + "BEGIN TRANSACTION;\n";
    internal const string HistoryTail = "COMMIT TRANSACTION;";

    /// <summary>One checked job's part: resolve it by its id (@job1, @job2, …), purge its history (only before the cut-off with
    /// <paramref name="older"/>), check the return code. The THROW states are the job's index, so a refusal names which call it was.</summary>
    internal static string HistoryJobPart(int index, bool older)
    {
        var n = index.ToString(CultureInfo.InvariantCulture);
        return "SELECT @job_id = NULL;\n"
            + "SELECT @job_id = j.job_id FROM msdb.dbo.sysjobs_view AS j WHERE j.job_id = @job" + n + ";\n"
            + "IF @job_id IS NULL THROW 50010, N'" + HistoryJobGoneMessage + "', " + n + ";\n"
            + "EXEC @rc = msdb.dbo.sp_purge_jobhistory @job_id = @job_id" + (older ? ", @oldest_date = @oldest_date" : "") + ";\n"
            + "IF @@ERROR <> 0 OR @rc <> 0 THROW 50012, N'" + RefusedMessage + "', " + n + ";\n";
    }

    /// <summary>Delete History's batch for <paramref name="jobs"/> checked jobs: all of their history, or (<paramref name="older"/>) only rows
    /// older than the server-computed cut-off. Its parameters are @job1 … @jobN, and with <paramref name="older"/> @count, @unit and @before.</summary>
    public static string HistoryDelete(int jobs, bool older)
    {
        if (jobs < 1 || jobs > AgentCatalog.Current.Limit("historyJobs")) throw new ArgumentOutOfRangeException(nameof(jobs));
        var text = new StringBuilder(older ? HistoryOlderHead : HistoryAllHead);
        for (var index = 1; index <= jobs; index++) text.Append(HistoryJobPart(index, older));
        return text.Append(HistoryTail).ToString();
    }

    /// <summary>Delete History's parameters for <paramref name="jobs"/> jobs, in the order <see cref="HistoryDelete"/> binds them.</summary>
    public static IReadOnlyList<AgentParameter> HistoryDeleteParameters(int jobs, bool older) =>
        [.. Enumerable.Range(1, jobs).Select(index => new AgentParameter("@job" + index.ToString(CultureInfo.InvariantCulture), SqlDbType.UniqueIdentifier)),
            .. older ? new[] { new AgentParameter("@count", SqlDbType.Int), new AgentParameter("@unit", SqlDbType.Int), new AgentParameter("@before", SqlDbType.DateTime) } : []];

    [GeneratedRegex(@"\ASELECT @job_id = NULL;\nSELECT @job_id = j\.job_id FROM msdb\.dbo\.sysjobs_view AS j WHERE j\.job_id = @job(?<n>[1-9][0-9]{0,2});\nIF @job_id IS NULL THROW 50010, N'(?<gone>[^']*)', (?<g>[1-9][0-9]{0,2});\nEXEC @rc = msdb\.dbo\.(?<proc>\w+) @job_id = @job_id(?<older>, @oldest_date = @oldest_date)?;\nIF @@ERROR <> 0 OR @rc <> 0 THROW 50012, N'(?<refused>[^']*)', (?<r>[1-9][0-9]{0,2});\n",
        RegexOptions.CultureInvariant)]
    private static partial Regex HistoryPart();

    /// <summary>Problems with a Delete History batch; empty when it passes. It opens with one of the two heads (older-than's computes, guards and
    /// bounds the cut-off first), then BEGIN TRANSACTION, then 1 to historyJobs parts numbered 1, 2, … each resolving its own job parameter and
    /// calling sp_purge_jobhistory with @job_id (and @oldest_date exactly with the older-than head), and ends with COMMIT TRANSACTION.</summary>
    public static List<string> LintHistoryDelete(string text, AgentCatalog? catalog = null)
    {
        catalog ??= AgentCatalog.Current;
        var problems = new List<string>();
        if (text.Contains("xp_servicecontrol", StringComparison.OrdinalIgnoreCase)) problems.Add("uses xp_servicecontrol");
        var older = text.StartsWith(HistoryOlderHead, StringComparison.Ordinal);
        if (!older && !text.StartsWith(HistoryAllHead, StringComparison.Ordinal)) { problems.Add("does not open with Delete History's declaration and transaction"); return problems; }
        if (!text.EndsWith(HistoryTail, StringComparison.Ordinal)) { problems.Add("does not commit last"); return problems; }
        var body = text[(older ? HistoryOlderHead : HistoryAllHead).Length..^HistoryTail.Length];
        var index = 0;
        while (body.Length > 0)
        {
            var match = HistoryPart().Match(body);
            if (!match.Success) { problems.Add("has a statement outside a job's guarded purge"); return problems; }
            index++;
            var n = index.ToString(CultureInfo.InvariantCulture);
            if (match.Groups["n"].Value != n || match.Groups["g"].Value != n || match.Groups["r"].Value != n) problems.Add("numbers job " + n + " out of order");
            if (match.Groups["gone"].Value != HistoryJobGoneMessage || match.Groups["refused"].Value != RefusedMessage) problems.Add("throws another message for job " + n);
            var procedure = match.Groups["proc"].Value;
            if (procedure != "sp_purge_jobhistory") problems.Add("EXECs " + procedure + " in Delete History");
            else if (!catalog.WriteArguments.TryGetValue(procedure, out var allowed) || !allowed.Contains("@job_id") || !allowed.Contains("@oldest_date")) problems.Add("passes arguments the catalogue does not list for " + procedure);
            if (match.Groups["older"].Success != older) problems.Add(older ? "purges job " + n + " without the cut-off" : "passes a cut-off it never computed");
            body = body[match.Length..];
        }
        if (index == 0) problems.Add("names no job");
        if (index > catalog.Limit("historyJobs")) problems.Add("names more than historyJobs jobs");
        return problems;
    }

    /// <summary>Delete History's batches at their bounds under <see cref="LintHistoryDelete"/>, each binding exactly its parameters.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> LintHistoryWrites()
    {
        foreach (var older in new[] { false, true })
            foreach (var jobs in new[] { 1, 2, (int)AgentCatalog.Current.Limit("historyJobs") })
            {
                var text = HistoryDelete(jobs, older);
                var problems = LintHistoryDelete(text);
                var used = Variable().Matches(Literal().Replace(text, "''")).Select(match => match.Value).Where(name => name is not ("@rc" or "@oldest_date" or "@job_id")).ToHashSet(StringComparer.Ordinal);
                var declared = HistoryDeleteParameters(jobs, older).Select(parameter => parameter.Name).ToHashSet(StringComparer.Ordinal);
                foreach (var name in declared.Except(used)) problems.Add("declares the unused " + name);
                foreach (var name in used.Except(declared)) problems.Add("binds the undeclared " + name);
                yield return ("delete history " + (older ? "older than" : "all") + " x" + jobs.ToString(CultureInfo.InvariantCulture), problems);
            }
    }
}
