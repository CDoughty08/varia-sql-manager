using System.Globalization;
using System.Text.RegularExpressions;

namespace Varia.Backend.Plans;

/// <summary>Actual plan capture's SQL (<see cref="ActualPlanCapture"/>). Extended Events DDL takes no parameters, so the
/// session's name and the predicate's values are part of the text: the name only as <see cref="IsName"/> allows it (the
/// prefix and 32 hexadecimal digits) inside brackets, the session id and durations as invariant integers, and the client
/// connection id as a formatted GUID. Server-scoped sessions are named by the executing connection's
/// <c>sys.dm_exec_connections.connection_id</c> (<see cref="NameQuery"/>), so <see cref="Sweep"/> can tell one whose
/// connection is gone, left by a backend that died before it dropped it: SQL Server before 2025 keeps such a session (no
/// MAX_DURATION), with its buffers and the plans it captured. The sweep builds each DROP on the server from QUOTENAME.
/// <see cref="Lint"/> holds every text to that.</summary>
internal static partial class ActualPlanSql
{
    public const string Prefix = "VariaActual_";
    public const string PlanEvent = "query_post_execution_plan_profile";
    public const string BatchEvent = "sql_batch_starting";
    /// <summary>The most sessions one sweep drops (or fails to), so a backlog cannot hold up a capture's start.</summary>
    public const int SweepLimit = 16;

    [GeneratedRegex("^VariaActual_[0-9A-F]{32}$")]
    private static partial Regex NamePattern();

    /// <summary>A session name this file puts in brackets: the prefix and 32 uppercase hexadecimal digits.</summary>
    public static bool IsName(string? name) => name is not null && NamePattern().IsMatch(name);

    /// <summary>The name of a session for a connection id, as <see cref="NameQuery"/> and <see cref="Sweep"/> build it.</summary>
    public static string NameFor(Guid connectionId) => Prefix + connectionId.ToString("N").ToUpperInvariant();

    private const string ConnectionName = "N'VariaActual_' + REPLACE(CONVERT(nchar(36), c.connection_id), N'-', N'')";

    /// <summary>The name for the session that captures @spid's plans, from its connection's id, or no row when this login cannot
    /// see that connection.</summary>
    public const string NameQuery = "SELECT TOP (1) " + ConnectionName + " FROM sys.dm_exec_connections AS c\n"
        + "WHERE c.session_id = @spid AND c.parent_connection_id IS NULL ORDER BY c.connect_time DESC;";

    /// <summary>Drops server-scoped sessions named as <see cref="NameFor"/> names them (so never one an older build named
    /// with a random GUID, which may still be capturing) whose connection is gone (never @own), at most
    /// <see cref="SweepLimit"/>, each under a one-second lock timeout; returns the sessions dropped and those that failed. It
    /// runs only where this login sees the executing session's connection (@spid), so a login that saw only its own
    /// connections never takes another's live session for an orphan.</summary>
    public static readonly string Sweep = string.Join('\n',
        "SET LOCK_TIMEOUT 1000;",
        "DECLARE @victim sysname, @last sysname = N'', @dropped int = 0, @failed int = 0, @drop nvarchar(300);",
        "IF EXISTS (SELECT 1 FROM sys.dm_exec_connections AS c WHERE c.session_id = @spid)",
        "WHILE @dropped + @failed < " + SweepLimit.ToString(CultureInfo.InvariantCulture),
        "BEGIN",
        "    SET @victim = NULL;",
        "    SELECT TOP (1) @victim = s.name FROM sys.server_event_sessions AS s",
        "    WHERE s.name COLLATE Latin1_General_BIN2 LIKE N'VariaActual[_]' + REPLICATE(N'[0-9A-F]', 32) AND s.name > @last AND s.name <> @own",
        "        AND NOT EXISTS (SELECT 1 FROM sys.dm_exec_connections AS c WHERE " + ConnectionName + " = s.name)",
        "    ORDER BY s.name;",
        "    IF @victim IS NULL BREAK;",
        "    SET @last = @victim;",
        "    SET @drop = N'DROP EVENT SESSION ' + QUOTENAME(@victim) + N' ON SERVER;';",
        "    BEGIN TRY",
        "        EXEC sys.sp_executesql @drop;",
        "        SET @dropped += 1;",
        "    END TRY",
        "    BEGIN CATCH",
        "        SET @failed += 1;",
        "    END CATCH;",
        "END;",
        "SELECT @dropped, @failed;");

    private static string Scope(bool databaseScoped) => databaseScoped ? "DATABASE" : "SERVER";

    /// <summary>Whether the login may create, start, read and drop a session, checked before creating one.</summary>
    public static string Permissions(bool databaseScoped)
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

    /// <summary>Creates and starts session <paramref name="name"/> for the executing session's batches and plans, first
    /// dropping one of that name: an earlier capture on the same connection that could not drop its own.</summary>
    public static string Create(string name, bool databaseScoped, int spid, Guid clientId, int? maxDurationSeconds)
    {
        if (!IsName(name)) throw new ArgumentException("Not an actual plan capture session name.", nameof(name));
        ArgumentOutOfRangeException.ThrowIfNegative(spid);
        if (maxDurationSeconds is <= 0) throw new ArgumentOutOfRangeException(nameof(maxDurationSeconds));
        var scope = Scope(databaseScoped);
        var sessions = databaseScoped ? "database_event_sessions" : "server_event_sessions";
        // A disconnected session's SPID can be reused. Match the physical connection ID as well so an abandoned
        // collector cannot read plans from any other connection.
        var predicate = FormattableString.Invariant($"[sqlserver].[session_id]=({spid}) AND [package0].[equal_guid]([sqlserver].[client_connection_id],'{clientId:D}')");
        var duration = maxDurationSeconds is { } seconds ? FormattableString.Invariant($", MAX_DURATION = {seconds} SECONDS") : "";
        return $"""
            IF EXISTS (SELECT 1 FROM sys.{sessions} WHERE name = @name) DROP EVENT SESSION [{name}] ON {scope};
            CREATE EVENT SESSION [{name}] ON {scope}
                ADD EVENT sqlserver.{BatchEvent}(SET collect_batch_text=(0) ACTION(package0.event_sequence) WHERE ({predicate})),
                ADD EVENT sqlserver.{PlanEvent}(ACTION(package0.event_sequence) WHERE ({predicate} AND [sqlserver].[is_system]=(0)))
                ADD TARGET package0.ring_buffer(SET max_memory=(4096), max_events_limit=(2048))
                WITH (MAX_MEMORY=4096 KB, MAX_EVENT_SIZE=4096 KB, MAX_DISPATCH_LATENCY=1 SECONDS, STARTUP_STATE=OFF{duration});
            ALTER EVENT SESSION [{name}] ON {scope} STATE=START;
            """;
    }

    /// <summary>The session's ring buffer and drop counts, by @name.</summary>
    public static string Read(bool databaseScoped)
    {
        var dmv = databaseScoped ? "dm_xe_database_session" : "dm_xe_session";
        return $"""
            SELECT CONVERT(bigint,s.dropped_event_count), CONVERT(bigint,s.dropped_buffer_count), t.target_data
            FROM sys.{dmv}s AS s JOIN sys.{dmv}_targets AS t ON s.address=t.event_session_address
            WHERE s.name=@name AND t.target_name=N'ring_buffer';
            """;
    }

    public static string Drop(string name, bool databaseScoped) => IsName(name)
        ? $"DROP EVENT SESSION [{name}] ON {Scope(databaseScoped)};"
        : throw new ArgumentException("Not an actual plan capture session name.", nameof(name));

    [GeneratedRegex(@"N?'(?:[^']|'')*'")]
    private static partial Regex Literal();

    [GeneratedRegex(@"\[[^\]]*\]")]
    private static partial Regex Bracketed();

    [GeneratedRegex(@"^'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'$")]
    private static partial Regex GuidLiteral();

    private static readonly HashSet<string> Literals =
    [
        "N'VariaActual_'", "N'-'", "N''", "N'VariaActual[_]'", "N'[0-9A-F]'", "N'DROP EVENT SESSION '", "N' ON SERVER;'", "N'ring_buffer'", "'DATABASE'",
        "'ALTER ANY EVENT SESSION'", "'CREATE ANY EVENT SESSION'", "'ALTER ANY EVENT SESSION ENABLE'", "'DROP ANY EVENT SESSION'",
        "'ALTER ANY DATABASE EVENT SESSION'", "'CREATE ANY DATABASE EVENT SESSION'", "'ALTER ANY DATABASE EVENT SESSION ENABLE'", "'DROP ANY DATABASE EVENT SESSION'",
        "'VIEW SERVER PERFORMANCE STATE'", "'VIEW SERVER STATE'", "'VIEW DATABASE STATE'"
    ];

    private static readonly HashSet<string> Identifiers = ["[sqlserver]", "[session_id]", "[package0]", "[equal_guid]", "[client_connection_id]", "[is_system]"];

    /// <summary>Problems with a rendered text; empty when it passes: string literals only from this file's constants or the
    /// client connection's GUID, brackets only around this file's identifiers or a session name <see cref="IsName"/> allows, no
    /// comments, and dynamic SQL only as the sweep builds it, from QUOTENAME.</summary>
    public static List<string> Lint(string text)
    {
        var problems = new List<string>();
        foreach (Match literal in Literal().Matches(text))
            if (!Literals.Contains(literal.Value) && !GuidLiteral().IsMatch(literal.Value)) problems.Add("has the literal " + literal.Value);
        var bare = Literal().Replace(text, "@literal");
        if (bare.Contains('\'')) problems.Add("has an unclosed literal");
        foreach (Match bracketed in Bracketed().Matches(bare))
            if (!Identifiers.Contains(bracketed.Value) && !IsName(bracketed.Value[1..^1])) problems.Add("brackets " + bracketed.Value);
        if (Regex.IsMatch(bare, @"\[[^\]]*$|^[^\[]*\]")) problems.Add("has an unbalanced bracket");
        if (bare.Contains("--", StringComparison.Ordinal) || bare.Contains("/*", StringComparison.Ordinal)) problems.Add("has a comment");
        if (Regex.IsMatch(bare, @"\bEXEC(UTE)?\s*\(", RegexOptions.IgnoreCase)) problems.Add("uses EXEC (string)");
        var dynamic = Regex.Count(bare, @"sp_executesql", RegexOptions.IgnoreCase);
        if (dynamic > 0 && (dynamic != 1 || !text.Contains("SET @drop = N'DROP EVENT SESSION ' + QUOTENAME(@victim) + N' ON SERVER;';", StringComparison.Ordinal)
            || Regex.Count(text, @"SET\s+@drop\b|SELECT\s+@drop\s*=|@drop\s*(\+|-|\|)=", RegexOptions.IgnoreCase) != 1 || !text.Contains("EXEC sys.sp_executesql @drop;", StringComparison.Ordinal)))
            problems.Add("runs dynamic SQL other than the sweep's DROP");
        if (Regex.IsMatch(text, @"QUOTENAME\((?!@victim\))", RegexOptions.IgnoreCase)) problems.Add("quotes something other than @victim");
        return problems;
    }

    /// <summary>Every text this file renders, for <see cref="Lint"/>: each scope, with and without MAX_DURATION, at the
    /// largest session id and duration.</summary>
    public static IEnumerable<(string Name, string Text)> Corpus()
    {
        var name = NameFor(Guid.Parse("0f8fad5b-d9cb-469f-a165-70867728950e"));
        var client = Guid.Parse("7c9e6679-7425-40de-944b-e07fc1f90ae7");
        yield return ("name", NameQuery);
        yield return ("sweep", Sweep);
        foreach (var scoped in new[] { false, true })
        {
            var scope = scoped ? "database" : "server";
            yield return ("permissions " + scope, Permissions(scoped));
            yield return ("create " + scope, Create(name, scoped, 32_767, client, null));
            yield return ("create " + scope + " with a duration", Create(name, scoped, 51, client, 86_400));
            yield return ("read " + scope, Read(scoped));
            yield return ("drop " + scope, Drop(name, scoped));
        }
    }
}
