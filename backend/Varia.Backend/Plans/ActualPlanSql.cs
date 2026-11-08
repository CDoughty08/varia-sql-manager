using System.Text.RegularExpressions;

namespace Varia.Backend.Plans;

/// <summary>Collector SQL is constant text per scope and version variant, rendered once and held to <see cref="Lint"/>.
/// Identifiers are quoted by SQL Server; all values are parameters.</summary>
internal static class ActualPlanSql
{
    internal const string PlanEvent = "query_post_execution_plan_profile";
    internal const string BatchEvent = "sql_batch_starting";
    internal const int RecoveryLimit = 16;

    private static readonly bool[] Scopes = [false, true];
    private static readonly string[] permissions = [.. Scopes.Select(BuildPermissions)];
    private static readonly string[] reads = [.. Scopes.Select(BuildRead)];
    private static readonly string[] drops = [.. Scopes.Select(BuildDrop)];
    private static readonly string[] creates = [.. Scopes.SelectMany(database => Scopes.Select(duration => BuildCreate(database, duration)))];

    public static string Permissions(bool databaseScoped) => permissions[databaseScoped ? 1 : 0];

    /// <summary>The session's ring buffer and drop counts, by @name.</summary>
    public static string Read(bool databaseScoped) => reads[databaseScoped ? 1 : 0];

    internal static string Create(bool databaseScoped, bool duration) => creates[(databaseScoped ? 2 : 0) + (duration ? 1 : 0)];

    internal static string Drop(bool databaseScoped) => drops[databaseScoped ? 1 : 0];

    private static string BuildPermissions(bool databaseScoped)
    {
        var permissionScope = databaseScoped ? "DB_NAME(), 'DATABASE'" : "NULL, NULL";
        var eventScope = databaseScoped ? "DATABASE " : "";
        string Permission(string permission) => $"HAS_PERMS_BY_NAME({permissionScope}, '{permission}')";
        var administer = Permission($"ALTER ANY {eventScope}EVENT SESSION");
        var create = Permission($"CREATE ANY {eventScope}EVENT SESSION");
        var enable = Permission($"ALTER ANY {eventScope}EVENT SESSION ENABLE");
        var drop = Permission($"DROP ANY {eventScope}EVENT SESSION");
        // A granular DENY overrides the parent grant. Use the parent only on engines without granular permissions.
        var manage = $"(({create}=1 AND {enable}=1 AND {drop}=1) OR ({drop} IS NULL AND {administer}=1))";
        var performance = Permission("VIEW SERVER PERFORMANCE STATE");
        var inspect = databaseScoped ? $"{Permission("VIEW DATABASE STATE")}=1"
            : $"({performance}=1 OR ({performance} IS NULL AND {Permission("VIEW SERVER STATE")}=1))";
        return $"SELECT CASE WHEN {manage} AND {inspect} THEN 1 ELSE 0 END;";
    }

    private static string BuildRead(bool databaseScoped)
    {
        var dmv = databaseScoped ? "dm_xe_database_session" : "dm_xe_session";
        return $"""
            SELECT CONVERT(bigint,s.dropped_event_count), CONVERT(bigint,s.dropped_buffer_count), t.target_data
            FROM sys.{dmv}s AS s JOIN sys.{dmv}_targets AS t ON s.address=t.event_session_address
            WHERE s.name=@name AND t.target_name=N'ring_buffer';
            """;
    }

    private static string BuildCreate(bool databaseScoped, bool duration) => $$"""
        DECLARE @predicate nvarchar(3000) = N'[sqlserver].[session_id]=(' + CONVERT(nvarchar(11),@spid)
            + N') AND [package0].[equal_guid]([sqlserver].[client_connection_id],''' + CONVERT(nvarchar(36),@client) + N''')';
        DECLARE @sql nvarchar(max) = N'CREATE EVENT SESSION ' + QUOTENAME(@name) + N' ON {{Scope(databaseScoped)}}
            ADD EVENT sqlserver.sql_batch_starting(SET collect_batch_text=(0) ACTION(package0.event_sequence) WHERE (' + @predicate + N')),
            ADD EVENT sqlserver.query_post_execution_plan_profile(ACTION(package0.event_sequence) WHERE (' + @predicate + N' AND [sqlserver].[is_system]=(0)))
            ADD TARGET package0.ring_buffer(SET max_memory=(4096), max_events_limit=(2048))
            WITH (MAX_MEMORY=4096 KB, MAX_EVENT_SIZE=4096 KB, MAX_DISPATCH_LATENCY=1 SECONDS, STARTUP_STATE=OFF{{(duration ? ", MAX_DURATION = ' + CONVERT(nvarchar(11),@duration) + N' SECONDS" : "")}});
            ALTER EVENT SESSION ' + QUOTENAME(@name) + N' ON {{Scope(databaseScoped)}} STATE=START;';
        EXEC sys.sp_executesql @sql;
        """;

    private static string BuildDrop(bool databaseScoped) => $$"""
        DECLARE @sql nvarchar(max) = N'DROP EVENT SESSION ' + QUOTENAME(@name) + N' ON {{Scope(databaseScoped)}};';
        EXEC sys.sp_executesql @sql;
        """;

    private static string Scope(bool databaseScoped) => databaseScoped ? "DATABASE" : "SERVER";

    // Database-scoped connection DMVs cannot prove absence after USE moves a live query to a different database.
    // Recovery is deliberately server-scoped; database collectors retain MAX_DURATION and their normal cleanup.
    private const string Shape = """
        s.startup_state=0
        AND (SELECT COUNT(*) FROM sys.server_event_session_events e WHERE e.event_session_id=s.event_session_id)=2
        AND b.package=N'sqlserver' AND p.package=N'sqlserver'
        AND (SELECT COUNT(*) FROM sys.server_event_session_actions a WHERE a.event_session_id=s.event_session_id)=2
        AND (SELECT COUNT(*) FROM sys.server_event_session_actions a WHERE a.event_session_id=s.event_session_id
            AND a.package=N'package0' AND a.name=N'event_sequence' AND a.event_id IN (b.event_id,p.event_id))=2
        AND (SELECT COUNT(*) FROM sys.server_event_session_targets t WHERE t.event_session_id=s.event_session_id)=1
        AND EXISTS (SELECT 1 FROM sys.server_event_session_targets t WHERE t.event_session_id=s.event_session_id
            AND t.package=N'package0' AND t.name=N'ring_buffer')
        """;

    private const string Events = """
        FROM sys.server_event_sessions s
        JOIN sys.server_event_session_events b ON b.event_session_id=s.event_session_id AND b.name=N'sql_batch_starting'
        JOIN sys.server_event_session_events p ON p.event_session_id=s.event_session_id AND p.name=N'query_post_execution_plan_profile'
        """;

    // Test isolation: the live checks scope recovery to names that start with their own random prefix.
    private const string Only = "(@only IS NULL OR LEFT(s.name,LEN(@only)) COLLATE Latin1_General_100_BIN2=@only)";

    // Builds before the three-GUID names (a random GUID, or the query connection's ID) named server collectors
    // VariaActual_ plus 32 hex digits; this build names only database-scoped collectors so, and those are never swept.
    // Such a name cannot prove its observer is gone, so it is swept only when clearly abandoned: stopped (defined but not
    // running) while no connection holds the session id its predicates watch, or running for more than a day (create_time
    // is the server's local time). Every such build created the session and then started it in a second statement, sent
    // while its query connection was open, so that connection's session id protects a session between the two.
    internal static readonly string LegacyName = "DATALENGTH(s.name)=88 AND s.name COLLATE Latin1_General_100_BIN2 LIKE N'VariaActual[_]"
        + string.Concat(Enumerable.Repeat("[0-9A-Fa-f]", 32)) + "'";
    internal static string LegacyAbandoned(string spid) => $"""
        ((NOT EXISTS (SELECT 1 FROM sys.dm_xe_sessions x WHERE x.name COLLATE Latin1_General_100_BIN2=s.name COLLATE Latin1_General_100_BIN2)
                AND {spid} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sys.dm_exec_connections c WHERE c.session_id={spid}))
            OR EXISTS (SELECT 1 FROM sys.dm_xe_sessions x WHERE x.name COLLATE Latin1_General_100_BIN2=s.name COLLATE Latin1_General_100_BIN2 AND x.create_time<DATEADD(day,-1,GETDATE())))
        """;
    // The batch event's first predicate value: the session id every legacy build watched. C# proves the whole shape.
    internal const string LegacySpid = "TRY_CONVERT(int,TRY_CONVERT(xml,b.predicate_xml).value(N'(/and/leaf/value/text())[1]',N'nvarchar(11)'))";

    // @after rotates the scan: definitions after the last one examined come first, then the scan wraps. Refused or failing
    // definitions at the front therefore cannot hide later ones from every capture.
    internal static readonly string Candidates = $$"""
        SELECT TOP ({{RecoveryLimit + 1}}) c.id,c.name,c.batch_xml,c.plan_xml,c.batch_text,c.plan_text,c.legacy
        FROM (
            SELECT s.event_session_id AS id,s.name,b.predicate_xml AS batch_xml,p.predicate_xml AS plan_xml,b.predicate AS batch_text,
                p.predicate AS plan_text,CONVERT(bit,0) AS legacy
            {{Events}}
            CROSS APPLY (SELECT TRY_CONVERT(uniqueidentifier, SUBSTRING(s.name,13,8)+N'-'+SUBSTRING(s.name,21,4)+N'-'
                +SUBSTRING(s.name,25,4)+N'-'+SUBSTRING(s.name,29,4)+N'-'+SUBSTRING(s.name,33,12)) AS client,
                TRY_CONVERT(uniqueidentifier, SUBSTRING(s.name,46,8)+N'-'+SUBSTRING(s.name,54,4)+N'-'
                +SUBSTRING(s.name,58,4)+N'-'+SUBSTRING(s.name,62,4)+N'-'+SUBSTRING(s.name,66,12)) AS target,
                TRY_CONVERT(uniqueidentifier, SUBSTRING(s.name,79,8)+N'-'+SUBSTRING(s.name,87,4)+N'-'
                +SUBSTRING(s.name,91,4)+N'-'+SUBSTRING(s.name,95,4)+N'-'+SUBSTRING(s.name,99,12)) AS owner) ids
            WHERE s.name COLLATE Latin1_General_100_BIN2 LIKE N'VariaActual[_]%'
                AND {{Only}}
                AND DATALENGTH(s.name)=220 AND SUBSTRING(s.name,45,1)=N'_' AND SUBSTRING(s.name,78,1)=N'_'
                AND ids.client IS NOT NULL AND ids.target IS NOT NULL AND ids.owner IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM sys.dm_exec_connections c
                    WHERE c.connection_id IN (ids.target,ids.owner) OR c.parent_connection_id IN (ids.target,ids.owner))
                AND {{Shape}}
            UNION ALL
            SELECT s.event_session_id,s.name,b.predicate_xml,p.predicate_xml,b.predicate,p.predicate,CONVERT(bit,1)
            {{Events}}
            WHERE {{LegacyName}}
                AND {{Only}}
                AND {{Shape}}
                AND {{LegacyAbandoned(LegacySpid)}}
        ) c
        ORDER BY CASE WHEN c.id>@after THEN 0 ELSE 1 END, c.id;
        """;

    // Recheck the exact definition and both physical connections immediately before each drop. A concurrent sweep
    // may already have removed it; an administrator may have replaced/modified it. Neither case authorizes a drop.
    internal static readonly string DropAbandoned = $$"""
        IF EXISTS (SELECT 1 {{Events}}
            WHERE s.event_session_id=@id AND s.name=@name AND b.predicate=@batch AND p.predicate=@plan
                AND {{Shape}}
                AND NOT EXISTS (SELECT 1 FROM sys.dm_exec_connections c
                    WHERE c.connection_id IN (@target,@owner) OR c.parent_connection_id IN (@target,@owner)))
        BEGIN
            {{Drop(false)}}
        END;
        """;

    // The same recheck for a legacy name: still the definition whose predicates C# proved (watching @spid),
    // collector-shaped, and still abandoned.
    internal static readonly string DropLegacy = $$"""
        IF EXISTS (SELECT 1 {{Events}}
            WHERE s.event_session_id=@id AND s.name=@name AND {{LegacyName}} AND b.predicate=@batch AND p.predicate=@plan
                AND {{Shape}}
                AND {{LegacyAbandoned("@spid")}})
        BEGIN
            {{Drop(false)}}
        END;
        """;

    /// <summary>Every statement this class renders, each variant once.</summary>
    internal static IEnumerable<string> All() =>
        [.. permissions, .. reads, .. drops, .. creates, Candidates, DropAbandoned, DropLegacy];

    private static readonly HashSet<string> Variables = new(StringComparer.Ordinal)
        { "@name", "@spid", "@client", "@duration", "@only", "@after", "@id", "@batch", "@plan", "@target", "@owner", "@predicate", "@sql" };
    // The only non-literal pieces dynamic SQL may be built from: a server-quoted identifier, typed values converted on
    // the server, and the predicate built from those.
    private static readonly HashSet<string> Pieces = new(StringComparer.Ordinal)
        { "QUOTENAME(@name)", "CONVERT(nvarchar(11),@spid)", "CONVERT(nvarchar(36),@client)", "CONVERT(nvarchar(11),@duration)", "@predicate" };
    private static readonly Regex Literal = new("N?'(?:[^']|'')*'", RegexOptions.CultureInvariant);
    private static readonly Regex Declare = new(@"\bDECLARE\s+(@\w+)\s+nvarchar\((?:max|\d+)\)\s*=\s*([^;]*);", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex Verb = new(@"\b(?:CREATE|ALTER|DROP)\b", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex SessionVerb = new(@"\b(?:CREATE|ALTER|DROP)\s+(?:ANY\s+(?:DATABASE\s+)?)?EVENT\s+SESSION\b", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    private static readonly Regex Forbidden = new(@"\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE|GRANT|REVOKE|DENY|KILL|SHUTDOWN|RECONFIGURE|OPENROWSET|OPENQUERY|xp_\w+)\b",
        RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);

    /// <summary>Problems with a collector statement: dynamic SQL only through <c>sp_executesql</c> of text built from
    /// literals and <see cref="Pieces"/>, only known variables, and no DDL but event sessions'.</summary>
    internal static List<string> Lint(string sql)
    {
        var problems = new List<string>();
        var literals = Literal.Matches(sql).Select(match => match.Value).ToList();
        var code = Literal.Replace(sql, "L");
        if (code.Contains('\'')) problems.Add("unterminated literal");
        if (sql.IndexOfAny(['{', '}']) >= 0) problems.Add("unrendered interpolation");
        foreach (Match variable in Regex.Matches(code, @"@@?\w+"))
            if (!Variables.Contains(variable.Value)) problems.Add("unknown variable " + variable.Value);
        if (Regex.IsMatch(code, @"\bSET\s+@", RegexOptions.IgnoreCase)) problems.Add("variable assigned outside its declaration");
        var executes = Regex.Matches(code, @"\bEXEC(?:UTE)?\b", RegexOptions.IgnoreCase).Count;
        if (executes != Regex.Matches(code, @"\bEXEC sys\.sp_executesql @sql;").Count) problems.Add("EXEC other than sys.sp_executesql @sql");
        var declares = Declare.Matches(code);
        if (declares.Count != Regex.Matches(code, @"\bDECLARE\b", RegexOptions.IgnoreCase).Count) problems.Add("DECLARE other than an nvarchar text");
        foreach (Match declare in declares)
            foreach (var piece in declare.Groups[2].Value.Split('+').Select(part => Regex.Replace(part, @"\s+", "")))
                if (piece != "L" && !Pieces.Contains(piece)) problems.Add("dynamic SQL built from " + piece);
        if (Verb.IsMatch(code) || Forbidden.IsMatch(code)) problems.Add("statement outside dynamic event session DDL");
        foreach (var literal in literals)
        {
            if (Verb.Matches(literal).Count != SessionVerb.Matches(literal).Count) problems.Add("DDL other than an event session's");
            if (Forbidden.IsMatch(literal) || Regex.IsMatch(literal, @"\bEXEC(?:UTE)?\b", RegexOptions.IgnoreCase)) problems.Add("forbidden statement in literal");
        }
        return problems;
    }
}
