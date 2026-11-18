using Varia.Backend.Live;

namespace Varia.Backend.Plans;

/// <summary>The Live Plan probe's SQL (query.plan.operators): one constant text per permission scope, held to
/// <see cref="LiveSql.Lint"/> by <see cref="Lint"/> offline. A SPID alone is reusable, so the physical connection (@client)
/// and the session (@spid) are both parameters. Azure SQL Database checks VIEW DATABASE STATE in the connection's own
/// database, the one place DB_NAME() is allowed: without an argument it reads no metadata, so it takes no lock that
/// LOCK_TIMEOUT or the isolation level would govern.</summary>
internal static class LivePlanSql
{
    internal const string DatabaseScope = "HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','VIEW DATABASE STATE')";
    internal const string PerformanceScope = "HAS_PERMS_BY_NAME(NULL,NULL,'VIEW SERVER PERFORMANCE STATE')";
    internal const string ServerScope = "HAS_PERMS_BY_NAME(NULL,NULL,'VIEW SERVER STATE')";

    internal static readonly string Database = Build(DatabaseScope);
    internal static readonly string Performance = Build(PerformanceScope);
    internal static readonly string Server = Build(ServerScope);
    internal static readonly string[] All = [Database, Performance, Server];

    /// <summary>Azure SQL Database (engine edition 5) checks its database; SQL Server 2022 and later the granular server
    /// permission; older versions and Managed Instance VIEW SERVER STATE.</summary>
    public static string For(int? engineEdition, int? major) => engineEdition == 5 ? Database : major >= 16 ? Performance : Server;

    private static string Build(string scope) => LiveSql.UncommittedPrologue + $"""
        IF ISNULL({scope},0)<>1 SELECT CAST(0 AS int);
        ELSE BEGIN
        SELECT CAST(1 AS int);
        SELECT CONVERT(nvarchar(max),q.query_plan)
        FROM sys.dm_exec_requests r JOIN sys.dm_exec_connections c ON r.connection_id=c.connection_id
        CROSS APPLY sys.dm_exec_query_statistics_xml(r.session_id) q
        WHERE r.session_id=@spid AND c.connection_id=@client AND q.request_id=r.request_id;
        END;
        """;

    /// <summary>Problems with one text; empty when it passes. The live probe lint applies in full, except that the
    /// database-scoped text may name DB_NAME() once, in its permission check.</summary>
    public static List<string> Lint(string text)
    {
        var at = text.IndexOf(DatabaseScope, StringComparison.Ordinal);
        var checkedText = at < 0 ? text : string.Concat(text.AsSpan(0, at), ServerScope, text.AsSpan(at + DatabaseScope.Length));
        var problems = LiveSql.Lint(checkedText);
        if (!text.Contains("@spid", StringComparison.Ordinal) || !text.Contains("@client", StringComparison.Ordinal)) problems.Add("does not match the session and its connection");
        return problems;
    }
}
