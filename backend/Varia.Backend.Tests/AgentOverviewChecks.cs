using Varia.Backend.Agent;
using Varia.Backend.Live;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of SQL Server Agent's overview (AG-15): its reads under the Agent read lint and their near misses, and
/// AgentOverviewReader against a fake server: which reads run for sysadmin and below it (role), alerts skipped off Windows (platform), a refused
/// read as a reads table value, the owner and history facts merged into the job rows, the status values, and msdb's int dates.</summary>
internal static class AgentOverviewChecks
{
    private static readonly Guid Nightly = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid Purge = Guid.Parse("22222222-2222-2222-2222-222222222222");
    private static readonly DateTime Now = new(2026, 11, 23, 12, 0, 0);

    public static async Task RunAsync(Action<bool, string> check)
    {
        Lint(check);
        Dates(check);
        await ReaderAsync(check);
    }

    private static void Lint(Action<bool, string> check)
    {
        AgentStatement[] statements = [AgentSql.OverviewJobs, AgentSql.OverviewOwners, AgentSql.OverviewHistory, AgentSql.OverviewAlerts, AgentSql.OverviewService];
        var problems = statements.SelectMany(statement => AgentSql.Callers.SelectMany(caller => AgentSql.Lint(statement, caller.Prologue).Select(problem => statement.Id + " (" + caller.Caller + "): " + problem))).ToList();
        check(problems.Count == 0 && statements.All(AgentSql.Known), "the overview's reads pass the Agent read lint under every caller and are in AgentSql.All: " + string.Join("; ", problems));
        bool Refused(AgentStatement statement, string text) => AgentSql.Lint(statement with { Text = text }, LiveSql.UncommittedPrologue).Count > 0;
        check(Refused(AgentSql.OverviewOwners, AgentSql.OverviewOwners.Text.Replace("CONVERT(int, SUBSTRING(j.owner_sid, 1, 1)) = 1", "SUBSTRING(j.owner_sid, 1, 1) = 0x01", StringComparison.Ordinal))
            && Refused(AgentSql.OverviewHistory, AgentSql.OverviewHistory.Text + "\nDELETE FROM msdb.dbo.sysjobhistory;")
            && Refused(AgentSql.OverviewJobs, "EXEC msdb.dbo.sp_help_job @job_name = N'x';")
            && Refused(AgentSql.OverviewAlerts, "EXEC msdb.dbo.sp_update_alert;")
            && Refused(AgentSql.OverviewService, "SELECT s.service_account, s.startup_type FROM sys.dm_server_services AS s; EXEC master.dbo.xp_servicecontrol N'Stop', N'SQLServerAgent';"),
            "the lint refuses the overview's near misses: a hex literal glued to a word, a second statement that writes, a literal argument, a write procedure and a service control call");
        check(LiveCatalog.Current.Probes[AgentOverviewReader.ReadProbe].Tables is { Count: 4 } tables && tables[3].Id == "reads"
            && AgentOverviewReader.Reads.Distinct().Count() == AgentOverviewReader.Reads.Length,
            "agent.overview.read has the jobs, alerts, schedules and reads tables, and the reads table's ids are distinct");
    }

    private static void Dates(Action<bool, string> check)
    {
        check(AgentOverviewReader.RunTime(20261123, 61500) == new DateTime(2026, 11, 23, 6, 15, 0) && AgentOverviewReader.RunTime(20261123, null) == new DateTime(2026, 11, 23)
            && AgentOverviewReader.RunTime(0, 0) is null && AgentOverviewReader.RunTime(null, 10) is null && AgentOverviewReader.RunTime(20261341, 0) is null
            && AgentOverviewReader.Stamp(new DateTime(2026, 1, 2, 3, 4, 5)) == "2026-01-02T03:04:05",
            "msdb's int dates read as server-local times (0, missing and impossible ones as none) and are sent as yyyy-mm-ddThh:mm:ss");
    }

    private static AgentReader Fake(List<string> ran, bool sysadmin, Func<AgentStatement, AgentResult?>? answer = null) => new()
    {
        TestRun = (statement, values, cap) =>
        {
            ran.Add(statement.Id);
            if (answer?.Invoke(statement) is { } given) return Task.FromResult(given);
            List<object?[]> rows = statement.Id switch
            {
                "jobDocumentFacts" => [["sa", sysadmin ? 1 : 0, 1]],
                "clock" => [[Now]],
                // job_id, name, enabled, owner, category, last_run_date, last_run_time, last_run_outcome, status, email, page, netsend, has_schedule
                "overviewJobs" => [[Nightly, "Nightly", 1, "sa", "[Uncategorized]", 20261123, 30000, 0, 4, 2, 0, 0, 1], [Purge, "Purge", 1, "CONTOSO\\jsmith", "[Uncategorized]", 0, 0, 5, 4, 0, 0, 0, 0]],
                "properties" => [[1000, 100, 10, 600]],
                "overviewAlerts" => [["Severity 017", 1, 0, 17, 20261120, 101010, 1]],
                "mailProfiles" => [[1, "AgentMail"]],
                "overviewOwners" => [[Nightly, 0], [Purge, 1]],
                "overviewHistory" => [[Nightly, 98L, 49, 20261122150000L]],
                "schedules" => [[7, "Quarter end", 1, 4, 1, 0, 0, 0, 0, 20260101, 99991231, 0, 235959, 0]],
                "agentMail" => [[1, "AgentMail"]],
                "overviewService" => [["NT SERVICE\\SQLSERVERAGENT", 2]],
                _ => []
            };
            return Task.FromResult(new AgentResult(statement.Columns, rows, false));
        }
    };

    private static Dictionary<string, (string State, string Message)> Reads(LiveReaderSample sample) =>
        sample.Tables[3].Rows.ToDictionary(row => row.Cells[0].Text!, row => (row.Cells[1].Text!, row.Cells[2].Text ?? ""));

    private static async Task ReaderAsync(Action<bool, string> check)
    {
        var spec = LiveCatalog.Current.Probes[AgentOverviewReader.ReadProbe];
        var ran = new List<string>();
        var reader = new AgentOverviewReader { Reader = Fake(ran, sysadmin: true), Platform = "windows", TestService = () => (1, 4, 2) };
        var sample = await reader.SampleAsync(null, LiveSql.UncommittedPrologue, null, CancellationToken.None);
        var reads = Reads(sample);
        var status = (sample.Status ?? []).ToDictionary(item => item.Id, item => item.Value);
        check(sample.Sampled && sample.Errors.Count == 0 && sample.Tables.Count == 4
            && ran.SequenceEqual(["jobDocumentFacts", "clock", "overviewJobs", "properties", "overviewAlerts", "mailProfiles", "overviewOwners", "overviewHistory", "schedules", "agentMail", "overviewService"])
            && AgentOverviewReader.Reads.All(reads.ContainsKey) && reads.Values.All(read => read.State == "ok"),
            "for sysadmin every read runs, each through the Agent reader, and the reads table says each was read: " + string.Join(", ", ran));
        check(sample.Tables.Select((table, index) => table.Rows.All(row => row.Cells.Length == spec.Tables[index].Columns.Count)).All(ok => ok)
            && status.Keys.All(id => spec.Status.Contains(id)) && status.Count <= 16,
            "every row has its catalogue table's column count and every status value is one the catalogue declares");
        check(status["isSysadmin"] is 1L && status["agentXps"] is 1L && status["serviceState"] is 4L && status["startupType"] is 2L && status["serverNow"] is "2026-11-23T12:00:00"
            && status["historyMaxRows"] is 1000L && status["historyMaxRowsPerJob"] is 100L && status["mailProfiles"] is 1L && status["agentProfile"] is "AgentMail" && status["agentProfileFound"] is 1L
            && status["useDatabaseMail"] is 1L && status["serviceAccount"] is "NT SERVICE\\SQLSERVERAGENT" && status["platform"] is "windows" && status["mailXps"] is 1L,
            "the status values carry who reads, Agent's state, the server's clock, the history caps, Agent mail and the service account: " + string.Join(", ", status.Select(item => item.Key + "=" + item.Value)));
        var jobs = sample.Tables[0].Rows.Select(row => row.Cells.Select(cell => cell.Text ?? "NULL").ToArray()).ToList();
        var nightly = jobs.Single(row => row[1] == "Nightly");
        var purge = jobs.Single(row => row[1] == "Purge");
        check(nightly[6] == "2026-11-23T03:00:00" && nightly[5] == "0" && nightly[8] == "2" && nightly[12] == "0" && nightly[13] == "98" && nightly[14] == "49" && nightly[15] == "2026-11-22T15:00:00"
            && purge[6] == "NULL" && purge[12] == "1" && purge[13] == "0" && purge[14] == "0" && purge[15] == "NULL",
            "a job row carries its last run as a stamp, its notify levels, its owner's login state and its history counts (0 for a job with none): " + string.Join(" | ", jobs.Select(row => string.Join(",", row))));

        var below = new List<string>();
        var role = new AgentOverviewReader { Reader = Fake(below, sysadmin: false), Platform = "windows", TestService = () => (1, null, null) };
        var roleSample = await role.SampleAsync(null, LiveSql.UncommittedPrologue, null, CancellationToken.None);
        var roleReads = Reads(roleSample);
        check(below.SequenceEqual(["jobDocumentFacts", "clock", "overviewJobs", "properties", "overviewAlerts", "mailProfiles"])
            && new[] { "owners", "history", "schedules", "mail", "service" }.All(id => roleReads[id].State == "role")
            && roleSample.Tables[0].Rows.All(row => row.Cells[12].Text is null && row.Cells[13].Text is null) && roleSample.Tables[2].Rows.Count == 0
            && !(roleSample.Status ?? []).Any(item => item.Id is "serviceState" or "serviceAccount" or "agentProfile"),
            "below sysadmin the sysadmin reads never run: the reads table says role, and the job rows leave the owner and history facts unknown (NULL), not zero: " + string.Join(", ", below));

        // A read msdb refuses: the fake throws a shape error for alerts, which the reader records as a value like any refusal.
        var shaped = new AgentOverviewReader
        {
            Reader = new AgentReader { TestRun = (statement, values, cap) => statement.Id == "overviewAlerts" ? throw new AgentShapeException("PERMISSION_DENIED", AgentReader.RefusedMessage) : Fake([], false).TestRun!(statement, values, cap) },
            Platform = "windows", TestService = () => (1, null, null)
        };
        var shapedSample = await shaped.SampleAsync(null, LiveSql.UncommittedPrologue, null, CancellationToken.None);
        var shapedReads = Reads(shapedSample);
        check(shapedSample.Sampled && shapedSample.Errors.Count == 0 && shapedReads["alerts"] == ("PERMISSION_DENIED", AgentReader.RefusedMessage) && shapedReads["jobs"].State == "ok"
            && shapedSample.Tables[1].Rows.Count == 0 && shapedSample.Tables[0].Rows.Count == 2,
            "a refused read is a reads table row with its code and message, never a failed probe, and the other reads still show");

        var linuxRan = new List<string>();
        var linux = new AgentOverviewReader { Reader = Fake(linuxRan, sysadmin: true), Platform = "linux", TestService = () => (1, 4, null) };
        var linuxReads = Reads(await linux.SampleAsync(null, LiveSql.UncommittedPrologue, null, CancellationToken.None));
        var miRan = new List<string>();
        var mi = new AgentOverviewReader { Reader = Fake(miRan, sysadmin: true), Platform = "managedInstance", TestService = () => (1, 4, null) };
        var miReads = Reads(await mi.SampleAsync(null, LiveSql.UncommittedPrologue, null, CancellationToken.None));
        check(!linuxRan.Contains("overviewAlerts") && linuxReads["alerts"].State == "platform" && !miRan.Contains("overviewAlerts") && miReads["alerts"].State == "platform",
            "off Windows (Linux, Managed Instance) alerts are not read: the reads table says platform");
    }
}
