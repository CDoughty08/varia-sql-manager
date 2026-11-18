using System.Globalization;
using System.Text.RegularExpressions;

namespace Varia.Backend.Tests;

/// <summary>Scratch SQL Server Agent objects (docs/agent-plan.md › Testing): server-level objects in msdb named with the run
/// prefix and a kind tag (<see cref="AgentKinds"/>), carrying <see cref="JobMarker"/> where the object has a description,
/// dropped in finally by the suite that made them, and swept by <see cref="SweepAsync"/> once the prefix's timestamp is more
/// than 6 hours old (kinds without a creation date included).</summary>
internal sealed partial class ScratchDatabase
{
    /// <summary>The kind tags, in the order the sweep drops them (dependencies first): proxies before their credentials, jobs
    /// (and the schedules they alone use) before schedules, alerts before operators.</summary>
    public static readonly IReadOnlyList<string> AgentKinds = ["px", "cr", "job", "sch", "al", "op"];

    /// <summary>This run's Agent object of a kind (job, sch, op, al, px, cr).</summary>
    public string AgentObject(string kind) => AgentKinds.Contains(kind) ? Name + "_" + kind : throw new ArgumentException("Unknown scratch Agent kind.", nameof(kind));

    [GeneratedRegex(@"^VariaScratch_(\d{14})_[0-9a-f]{8}_(job|sch|op|al|px|cr)$")]
    private static partial Regex AgentPattern();

    /// <summary>The kind tag of a scratch Agent object's name, or null when the name is not exactly one a run gives.</summary>
    internal static string? AgentKindOf(string name) => AgentPattern().Match(name) is { Success: true } match ? match.Groups[2].Value : null;

    /// <summary>Whether a scratch Agent object of this name was made more than 6 hours before <paramref name="now"/> (UTC), by
    /// its prefix's timestamp.</summary>
    internal static bool StaleAgentObject(string name, DateTime now) => AgentPattern().Match(name) is { Success: true } match
        && DateTime.TryParseExact(match.Groups[1].Value, "yyyyMMddHHmmss", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var created)
        && created < now.AddHours(-6);

    /// <summary>Every scratch-named Agent object with its kind, id and, for jobs, the description that must be the marker. A
    /// server without msdb's Agent tables (or a login that cannot read them) fails the read, which sweeps nothing.</summary>
    internal const string StaleAgentSql = "SELECT N'px', CONVERT(nvarchar(36), p.proxy_id), p.name, NULL FROM msdb.dbo.sysproxies AS p WHERE p.name LIKE N'VariaScratch[_]%'\n"
        + "UNION ALL SELECT N'cr', CONVERT(nvarchar(36), c.credential_id), c.name, NULL FROM sys.credentials AS c WHERE c.name LIKE N'VariaScratch[_]%'\n"
        + "UNION ALL SELECT N'job', CONVERT(nvarchar(36), j.job_id), j.name, j.description FROM msdb.dbo.sysjobs AS j WHERE j.name LIKE N'VariaScratch[_]%'\n"
        + "UNION ALL SELECT N'sch', CONVERT(nvarchar(36), s.schedule_id), s.name, NULL FROM msdb.dbo.sysschedules AS s WHERE s.name LIKE N'VariaScratch[_]%'\n"
        + "UNION ALL SELECT N'al', CONVERT(nvarchar(36), a.id), a.name, NULL FROM msdb.dbo.sysalerts AS a WHERE a.name LIKE N'VariaScratch[_]%'\n"
        + "UNION ALL SELECT N'op', CONVERT(nvarchar(36), o.id), o.name, NULL FROM msdb.dbo.sysoperators AS o WHERE o.name LIKE N'VariaScratch[_]%';";

    /// <summary>The statement that drops one stale scratch Agent object, or null when its id does not parse.</summary>
    internal static string? DropAgentSql(string kind, string id, string name) => kind switch
    {
        "px" when int.TryParse(id, CultureInfo.InvariantCulture, out var proxy) => "EXEC msdb.dbo.sp_delete_proxy @proxy_id = " + proxy.ToString(CultureInfo.InvariantCulture) + ";",
        "cr" => "DROP CREDENTIAL " + Bracket(name) + ";",
        "job" when Guid.TryParse(id, out var job) => "EXEC msdb.dbo.sp_delete_job @job_id = '" + job.ToString("D") + "', @delete_history = 1, @delete_unused_schedule = 1;",
        "sch" when int.TryParse(id, CultureInfo.InvariantCulture, out var schedule) => "EXEC msdb.dbo.sp_delete_schedule @schedule_id = " + schedule.ToString(CultureInfo.InvariantCulture) + ", @force_delete = 1;",
        "al" => "EXEC msdb.dbo.sp_delete_alert @name = " + Quote(name) + ";",
        "op" => "EXEC msdb.dbo.sp_delete_operator @name = " + Quote(name) + ";",
        _ => null
    };

    /// <summary>Drops stale scratch Agent objects, kind by kind in <see cref="AgentKinds"/> order (names only are logged).</summary>
    private static async Task SweepAgentAsync(Func<string, string, Task<SqlRun>> run, Action<string> log)
    {
        var found = await run(StaleAgentSql, "msdb");
        if (found.Status != "completed" || found.Sets.Count == 0) return;
        var now = DateTime.UtcNow;
        foreach (var kind in AgentKinds)
            foreach (var row in found.Sets[0].Where(row => row[0] == kind && row[1] is not null && row[2] is { } name && AgentKindOf(name) == kind && StaleAgentObject(name, now) && (kind != "job" || row[3] == JobMarker)))
                if (DropAgentSql(kind, row[1]!, row[2]!) is { } drop)
                {
                    log("Dropping stale scratch Agent object " + row[2]);
                    await run(drop, "msdb");
                }
    }
}
