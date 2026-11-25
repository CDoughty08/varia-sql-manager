namespace Varia.Backend.Agent;

/// <summary>The SQL Server Agent overview's reads (AG-15, docs/sql-server-agent.md › Agent overview): constant text in <see cref="All"/>, so
/// under <see cref="LintRead"/> like every Agent read. The jobs, alerts and history caps come through msdb's own procedures (every Agent role
/// sees what msdb shows it); the job owners' logins, the history counts, the schedules' use, Agent's mail settings and its service account are
/// sysadmin reads, which <see cref="AgentOverviewReader"/> runs only for sysadmin (below it those checks say so, never guess).</summary>
internal static partial class AgentSql
{
    /// <summary>Every job the login may see with what the checks need: last run, state, failure notifications, whether it is scheduled and when it was created.</summary>
    public static readonly AgentStatement OverviewJobs = new("overviewJobs", "EXEC msdb.dbo.sp_help_job;",
        ["job_id", "name", "enabled", "owner", "category", "last_run_date", "last_run_time", "last_run_outcome", "current_execution_status", "notify_level_email",
            "notify_level_page", "notify_level_netsend", "has_schedule", "date_created"], [], "listRows");

    /// <summary>Whether each job's owner can log in (sysadmin: msdb grants the Agent roles no SELECT on sysjobs): 0 yes, 1 a disabled login,
    /// 2 no login for the owner's SID, 3 a login denied CONNECT SQL. A sysadmin owner reads 0 whatever its login's state: Agent runs a
    /// sysadmin-owned job's steps as its own service account and never logs the owner in (the usual hardening disables sa, which owns jobs). The role test runs only for an owner that would fail otherwise, as a Windows
    /// login's membership may ask the domain. A Windows-shaped SID with no login of its own (revision 1, eight bytes
    /// and four a sub-authority) may log in through a Windows group, so it reads 0: the engine alone knows, and the check never guesses.</summary>
    public static readonly AgentStatement OverviewOwners = new("overviewOwners",
        "SELECT j.job_id, CONVERT(int, CASE\n"
        + "WHEN p.principal_id IS NULL THEN CASE WHEN CONVERT(int, SUBSTRING(j.owner_sid, 1, 1)) = 1 AND DATALENGTH(j.owner_sid) = 8 + 4 * CONVERT(int, SUBSTRING(j.owner_sid, 2, 1)) THEN 0 ELSE 2 END\n"
        + "WHEN p.is_disabled = 1 THEN CASE WHEN IS_SRVROLEMEMBER(N'sysadmin', p.name) = 1 THEN 0 ELSE 1 END\n"
        + "WHEN EXISTS (SELECT 1 FROM sys.server_permissions AS d WHERE d.grantee_principal_id = p.principal_id AND d.type = 'COSQ' AND d.state = 'D')\n"
        + "THEN CASE WHEN IS_SRVROLEMEMBER(N'sysadmin', p.name) = 1 THEN 0 ELSE 3 END\n"
        + "ELSE 0 END) AS owner_state\n"
        + "FROM msdb.dbo.sysjobs AS j LEFT JOIN sys.server_principals AS p ON p.sid = j.owner_sid;", ["job_id", "owner_state"], [], "listRows");

    /// <summary>How much history each job keeps (sysadmin: sysjobhistory is not granted to the Agent roles): its rows, its runs (job outcome
    /// rows) and its oldest row's start as yyyymmddhhmmss, aggregated on the server so no history row crosses the wire.</summary>
    public static readonly AgentStatement OverviewHistory = new("overviewHistory",
        "SELECT h.job_id, COUNT_BIG(*) AS history_rows, SUM(CASE WHEN h.step_id = 0 THEN 1 ELSE 0 END) AS history_runs,\n"
        + "MIN(CONVERT(bigint, h.run_date) * 1000000 + h.run_time) AS oldest_run\n"
        + "FROM msdb.dbo.sysjobhistory AS h GROUP BY h.job_id;", ["job_id", "history_rows", "history_runs", "oldest_run"], [], "listRows");

    /// <summary>Every alert with what raises it, when it last fired and whether it notifies anyone (SQLAgentOperatorRole and sysadmin).</summary>
    public static readonly AgentStatement OverviewAlerts = new("overviewAlerts", "EXEC msdb.dbo.sp_help_alert;",
        ["name", "enabled", "message_id", "severity", "last_occurrence_date", "last_occurrence_time", "has_notification"], [], "listRows");

    /// <summary>SQL Server Agent's service account and startup type (sysadmin; Managed Instance and some Linux builds have no row).</summary>
    public static readonly AgentStatement OverviewService = new("overviewService",
        "SELECT s.service_account, s.startup_type FROM sys.dm_server_services AS s WHERE s.servicename LIKE N'SQL Server Agent%';", ["service_account", "startup_type"], [], "listRows");
}
