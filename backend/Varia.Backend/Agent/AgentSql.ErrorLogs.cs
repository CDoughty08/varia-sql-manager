using System.Data;

namespace Varia.Backend.Agent;

/// <summary>SQL Server Agent's error logs in the Log File Viewer (AG-5b, docs/sql-server-agent.md): the list (<see cref="ErrorLogs"/>) and one log's
/// rows (<see cref="ErrorLog"/>, or on Managed Instance <see cref="ErrorLogMi"/>), both run by <see cref="AgentReader"/> under <see cref="LintRead"/>,
/// and Recycle's write: one call of msdb.dbo.sp_cycle_agent_errorlog, which takes no argument and which msdb grants to sysadmin alone, checked by
/// <see cref="LintRecycle"/>, which admits exactly <see cref="Recycle"/>.</summary>
internal static partial class AgentSql
{
    /// <summary>One Agent error log on Managed Instance, whose sp_readmierrorlog takes no sort argument: oldest first, so a capped read keeps the
    /// oldest rows (the viewer says so). Not run here: no Managed Instance was at hand (docs/sql-server-agent.md).</summary>
    public static readonly AgentStatement ErrorLogMi = new("errorLogMi", "EXEC master.dbo.sp_readmierrorlog @log, 2, @search1, @search2;", ["LogDate", "ErrorLevel", "Text"],
        [new("@log", SqlDbType.Int), new("@search1", SqlDbType.NVarChar, SearchChars), new("@search2", SqlDbType.NVarChar, SearchChars)], "logRows");

    /// <summary>Recycle: close the current Agent error log and start a new one. sp_cycle_agent_errorlog notifies SQL Server Agent, which renames the
    /// logs itself; msdb raises 22022 when Agent is not running and 229 below sysadmin. The return-code check is the shape every Agent write ends with.</summary>
    public const string Recycle = "DECLARE @rc int;\nEXEC @rc = msdb.dbo.sp_cycle_agent_errorlog;" + Check;

    /// <summary>Problems with Recycle's batch; empty when it passes: exactly <see cref="Recycle"/>, and the catalogue lists sp_cycle_agent_errorlog as a
    /// write with no arguments.</summary>
    public static List<string> LintRecycle(string text, AgentCatalog? catalog = null)
    {
        catalog ??= AgentCatalog.Current;
        var problems = new List<string>();
        if (text.Contains("xp_servicecontrol", StringComparison.OrdinalIgnoreCase)) problems.Add("uses xp_servicecontrol");
        if (text != Recycle) problems.Add("is not Recycle's one guarded call of sp_cycle_agent_errorlog");
        if (!catalog.WriteArguments.TryGetValue("sp_cycle_agent_errorlog", out var allowed)) problems.Add("EXECs sp_cycle_agent_errorlog, which the catalogue does not list as a write");
        else if (allowed.Count > 0) problems.Add("the catalogue lists arguments for sp_cycle_agent_errorlog, which Recycle never passes");
        return problems;
    }

    /// <summary>Recycle's batch under <see cref="LintRecycle"/>.</summary>
    public static IEnumerable<(string Name, List<string> Problems)> LintRecycleWrites()
    {
        yield return ("recycle error log", LintRecycle(Recycle));
    }
}
