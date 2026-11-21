using System.Data;
using System.Text.RegularExpressions;

namespace Varia.Backend.Agent;

/// <summary>SQL Server Agent Properties (AG-8a): its two server-scope writes, which name no job and so have no identity guard, and its reads.
/// <see cref="SetProperties"/> passes every setting it may change, NULL for those that stay as they are (msdb leaves a NULL argument alone);
/// <see cref="PurgeHistory"/> deletes every job's history older than a cut-off the server computes from its own clock (<see cref="PurgeCutoff"/>,
/// in the local time sysjobhistory uses, so a client in another time zone cannot shift it), and THROWs before the call when that cut-off is
/// NULL, since sp_purge_jobhistory reads a NULL @oldest_date as "all history". Both end with <see cref="Check"/>. <see cref="LintServerExecutable"/>
/// admits nothing else: one call of a write procedure that names no @job_id, and the purge's cut-off and guard exactly, only before the purge.</summary>
internal static partial class AgentSql
{
    /// <summary>The purge's NULL-cut-off guard's message (50013).</summary>
    public const string CutoffMessage = "The cut-off date could not be computed, so no history was deleted.";

    internal const string ServerHead = "DECLARE @rc int;\n";
    internal const string PurgeHead = "DECLARE @rc int, @oldest_date datetime;\n";
    /// <summary>The cut-off from the server's clock: @count days, weeks or months back (@unit 1, 2, 3). Delete History (AG-5a) shares it.</summary>
    internal const string PurgeCutoff = "SET @oldest_date = CASE @unit WHEN 1 THEN DATEADD(day, -@count, GETDATE()) WHEN 2 THEN DATEADD(week, -@count, GETDATE()) WHEN 3 THEN DATEADD(month, -@count, GETDATE()) END;\n";
    internal const string PurgeGuard = "IF @oldest_date IS NULL THROW 50013, N'" + CutoffMessage + "', 1;\n";

    private static readonly AgentParameter[] PropertyParameters =
        [new("@sqlserver_restart", SqlDbType.Int), new("@monitor_autostart", SqlDbType.Int), new("@jobhistory_max_rows", SqlDbType.Int), new("@jobhistory_max_rows_per_job", SqlDbType.Int)];

    public static readonly AgentWrite SetProperties = new("setProperties", "sp_set_sqlagent_properties",
        ServerHead + "EXEC @rc = msdb.dbo.sp_set_sqlagent_properties " + string.Join(", ", PropertyParameters.Select(parameter => parameter.Name + " = " + parameter.Name)) + ";" + Check, PropertyParameters);

    public static readonly AgentWrite PurgeHistory = new("purgeHistory", "sp_purge_jobhistory",
        PurgeHead + PurgeCutoff + PurgeGuard + "EXEC @rc = msdb.dbo.sp_purge_jobhistory @oldest_date = @oldest_date;" + Check,
        [new("@count", SqlDbType.Int), new("@unit", SqlDbType.Int)]);

    public static IReadOnlyList<AgentWrite> ServerWrites { get; } = [SetProperties, PurgeHistory];

    /// <summary>The server's clock as sysjobhistory uses it (local), its offset from UTC, and whether the login is sysadmin.</summary>
    public const string Clock = "SELECT CONVERT(char(19), GETDATE(), 126) AS server_now, DATEDIFF(minute, GETUTCDATE(), GETDATE()) AS offset_minutes,\n"
        + "CONVERT(int, ISNULL(IS_SRVROLEMEMBER(N'sysadmin'), 0)) AS is_sysadmin;";

    /// <summary>Every job's history for "What this keeps" and the purge's estimate (sysadmin: other logins cannot read sysjobhistory). Three
    /// result sets: the total and the rows the last @days days wrote; the @jobs jobs with the most rows (one more is read to tell truncation);
    /// the rows by age in whole days, ages past @ages counted at @ages. Run times compare as yyyymmddhhmmss numbers, as msdb stores them.</summary>
    public const string HistoryCounts = "DECLARE @since datetime = DATEADD(day, -@days, GETDATE());\n"
        + "DECLARE @stamp bigint = CONVERT(bigint, CONVERT(char(8), @since, 112)) * 1000000 + DATEPART(hour, @since) * 10000 + DATEPART(minute, @since) * 100 + DATEPART(second, @since);\n"
        + "SELECT COUNT_BIG(*) AS total_rows, ISNULL(SUM(CASE WHEN CONVERT(bigint, h.run_date) * 1000000 + h.run_time >= @stamp THEN CONVERT(bigint, 1) ELSE 0 END), 0) AS recent_rows\n"
        + "FROM msdb.dbo.sysjobhistory AS h;\n"
        + "SELECT TOP (@jobs) j.name, COUNT_BIG(*) AS total_rows, ISNULL(SUM(CASE WHEN CONVERT(bigint, h.run_date) * 1000000 + h.run_time >= @stamp THEN CONVERT(bigint, 1) ELSE 0 END), 0) AS recent_rows\n"
        + "FROM msdb.dbo.sysjobhistory AS h JOIN msdb.dbo.sysjobs AS j ON j.job_id = h.job_id\nGROUP BY j.job_id, j.name ORDER BY total_rows DESC, j.name;\n"
        + "SELECT a.age_days, COUNT_BIG(*) AS age_rows FROM (SELECT CASE WHEN x.age IS NULL OR x.age > @ages THEN @ages WHEN x.age < 0 THEN 0 ELSE x.age END AS age_days\n"
        + "FROM (SELECT DATEDIFF(day, TRY_CONVERT(date, CONVERT(char(8), h.run_date), 112), GETDATE()) AS age FROM msdb.dbo.sysjobhistory AS h) AS x) AS a\nGROUP BY a.age_days;";

    [GeneratedRegex(@"^EXEC @rc = msdb\.dbo\.(?<proc>\w+) (?<arg>@\w+) = (?<value>@\w+)(?:, (?<arg>@\w+) = (?<value>@\w+))*;$", RegexOptions.CultureInvariant)]
    private static partial Regex ServerCall();

    /// <summary>Problems with a server-scope write's full text; empty when it passes: <see cref="ServerHead"/>, or <see cref="PurgeHead"/> with the
    /// cut-off and its guard, then one call and <see cref="Check"/> exactly. The call's procedure is one the catalogue lists for writes, each argument
    /// its own, once, by the parameter of its own name, never @job_id (a job's write resolves the job first: <see cref="LintExecutable"/>); the purge
    /// head goes only with sp_purge_jobhistory, and sp_purge_jobhistory only with it.</summary>
    public static List<string> LintServerExecutable(string text, AgentCatalog? catalog = null)
    {
        catalog ??= AgentCatalog.Current;
        var problems = new List<string>();
        if (text.Contains("xp_servicecontrol", StringComparison.OrdinalIgnoreCase)) problems.Add("uses xp_servicecontrol");
        var purge = text.StartsWith(PurgeHead, StringComparison.Ordinal);
        string body;
        if (purge)
        {
            body = text[PurgeHead.Length..];
            if (!body.StartsWith(PurgeCutoff + PurgeGuard, StringComparison.Ordinal)) { problems.Add("does not compute and guard the cut-off before the purge"); return problems; }
            body = body[(PurgeCutoff + PurgeGuard).Length..];
        }
        else if (text.StartsWith(ServerHead, StringComparison.Ordinal)) body = text[ServerHead.Length..];
        else { problems.Add("does not open with the server write's declaration"); return problems; }
        if (!body.EndsWith(Check, StringComparison.Ordinal)) { problems.Add("does not check the return code last"); return problems; }
        var match = ServerCall().Match(body[..^Check.Length]);
        if (!match.Success) { problems.Add("is not one msdb call in the server write shape"); return problems; }
        var procedure = match.Groups["proc"].Value;
        if (!catalog.WriteArguments.TryGetValue(procedure, out var allowed)) { problems.Add("EXECs " + procedure + ", which is not an Agent write procedure"); return problems; }
        if (purge != (procedure == "sp_purge_jobhistory")) problems.Add(purge ? "computes a cut-off for " + procedure : "purges history without the guarded cut-off");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (var i = 0; i < match.Groups["arg"].Captures.Count; i++)
        {
            var argument = match.Groups["arg"].Captures[i].Value;
            if (argument == "@job_id") problems.Add("names a job in a server write");
            else if (!allowed.Contains(argument)) problems.Add("passes " + argument + " to " + procedure);
            if (!seen.Add(argument)) problems.Add("passes " + argument + " twice");
            if (match.Groups["value"].Captures[i].Value != argument) problems.Add("passes " + argument + " another parameter's value");
        }
        return problems;
    }

    /// <summary>The server writes under <see cref="LintServerExecutable"/>, each binding exactly its parameters, and the dialog's own reads under
    /// <see cref="LintRead"/> (describes: no prologue in the text).</summary>
    public static IEnumerable<(string Name, List<string> Problems)> LintServerWrites()
    {
        foreach (var write in ServerWrites)
        {
            var problems = LintServerExecutable(write.Text);
            // The batch's own locals are @rc and the purge's @oldest_date; every other variable is a bound parameter.
            var used = Variable().Matches(Literal().Replace(write.Text, "''")).Select(match => match.Value).Where(name => name is not ("@rc" or "@oldest_date")).ToHashSet(StringComparer.Ordinal);
            var declared = write.Parameters.Select(parameter => parameter.Name).ToHashSet(StringComparer.Ordinal);
            foreach (var name in declared.Except(used)) problems.Add("declares the unused " + name);
            foreach (var name in used.Except(declared)) problems.Add("binds the undeclared " + name);
            yield return ("server write " + write.Id, problems);
        }
        yield return ("properties clock", LintRead(Clock, null));
        yield return ("properties history counts", LintRead(HistoryCounts, null));
    }
}
