namespace Varia.Backend.Live;

/// <summary>SQL Server Agent's Object Explorer change source (AG-12, <c>agent.tree</c>): one probe, <c>agent.treeProbe</c>, whose
/// text reads Agent XPs and the service state as <c>explorer.agentService</c> does, then a fingerprint of each msdb table the
/// Agent node's folders list (src/shared/agent/tree.ts agentTreeFingerprints, which the checks compare): its rows and a
/// checksum of the columns the tree shows, over what the login may see. Object Explorer reloads only what changed.</summary>
internal static partial class LiveSql
{
    public const string AgentTreeProbe = "agent.treeProbe";

    /// <summary>The tables, in the catalogue's order, and the columns of each the tree shows (a job's owner by its sid, its
    /// creation date to the millisecond). sysjobs_view filters a SQLAgentUserRole login to its own jobs; a table the login may
    /// not select (Alerts and Operators below SQLAgentOperatorRole, the proxy tables below sysadmin) reads 0 and 0, guarded by
    /// HAS_PERMS_BY_NAME in an IF, so a refused SELECT never ends the view.</summary>
    internal static readonly (string Id, string Table, string[] Columns)[] AgentTreeFingerprints =
    [
        ("jobs", "msdb.dbo.sysjobs_view", ["x.job_id", "x.name", "x.enabled", "x.description", "CONVERT(nvarchar(30), x.date_created, 126)", "CONVERT(nvarchar(172), x.owner_sid, 1)"]),
        ("alerts", "msdb.dbo.sysalerts", ["x.id", "x.name", "x.enabled"]),
        ("operators", "msdb.dbo.sysoperators", ["x.id", "x.name", "x.enabled"]),
        ("proxies", "msdb.dbo.sysproxies", ["x.proxy_id", "x.name", "x.enabled"]),
        ("assignments", "msdb.dbo.sysproxysubsystem", ["x.proxy_id", "x.subsystem_id"])
    ];

    private static readonly string[] AgentTreeColumns = ["agent_xps", "service_state", .. AgentTreeFingerprints.SelectMany(table => new[] { table.Id + "_count", table.Id + "_checksum" })];
    private static readonly LiveStatusColumn[] AgentTreeStatus = [new("agentXps", "agent_xps"), new("serviceState", "service_state"),
        .. AgentTreeFingerprints.SelectMany(table => new LiveStatusColumn[] { new(table.Id + "Count", table.Id + "_count"), new(table.Id + "Checksum", table.Id + "_checksum") })];

    /// <summary>The probe's text at a band: explorer.agentService's state lines (its declarations and reads, without its final
    /// SELECT), then one guarded read per table into its two variables, then one row. The checksum is ssis.catalogProbe's: the
    /// sum of the first 3 bytes of each row's SHA-256 (exact in JavaScript below 2^29 rows), since CHECKSUM_AGG's XOR cancels
    /// two equal rows.</summary>
    internal static string AgentTreeAt(int band)
    {
        var service = AgentServiceAt(band);
        var state = service[..service.LastIndexOf("SELECT @xps AS agent_xps", StringComparison.Ordinal)];
        var text = new System.Text.StringBuilder(state);
        text.Append("DECLARE ").AppendJoin(", ", AgentTreeFingerprints.Select(table => "@" + table.Id + "_n bigint = 0, @" + table.Id + "_h bigint = 0")).Append(";\n");
        foreach (var (id, table, columns) in AgentTreeFingerprints)
        {
            var row = "CONVERT(varbinary(max), CONCAT(" + string.Join(", NCHAR(31), ", columns) + "))";
            text.Append("IF ISNULL(HAS_PERMS_BY_NAME(N'").Append(table).Append("', N'OBJECT', N'SELECT'), 0) = 1\n")
                .Append("    SELECT @").Append(id).Append("_n = COUNT_BIG(*), @").Append(id).Append("_h = ISNULL(SUM(CONVERT(bigint, SUBSTRING(HASHBYTES('SHA2_256', ").Append(row)
                .Append("), 1, 3))), 0) FROM ").Append(table).Append(" AS x;\n");
        }
        text.Append("SELECT @xps AS agent_xps, @state AS service_state, ")
            .AppendJoin(", ", AgentTreeFingerprints.Select(table => "@" + table.Id + "_n AS " + table.Id + "_count, @" + table.Id + "_h AS " + table.Id + "_checksum")).Append(';');
        return text.ToString();
    }

    private static LiveQuery AgentTree(string probe, int band) => new(probe, band, AgentTreeAt(band), AgentTreeColumns, null, null, [], AgentTreeStatus);
}
