using System.Data;
using Microsoft.Data.SqlClient;
using Varia.Backend.Scripting;

namespace Varia.Backend.Actions;

/// <summary>Object action failures as values. Messages name only the object as Object Explorer shows it and carry SQL
/// Server's own text; never SQL text, connection strings or stack traces, and nothing is logged.</summary>
internal static class ActionErrors
{
    public const int MaxMessage = 2048;
    /// <summary>Delete Object's advice for a database other connections use.</summary>
    public const string CloseConnectionsAdvice = "Close its connections, or check Close existing connections.";
    /// <summary>Database Properties' advice when other connections are in the way of an option it asks Open Connections for:
    /// WITH NO_WAIT finds them (5061, 5070), or the preflight counts them.</summary>
    public const string OpenConnectionsAdvice = "Other connections use the database. Choose Yes when asked to close them, or close them first.";
    /// <summary>Its advice for any other change other connections are in the way of (Broker Enabled, Containment type, COLLATE's
    /// 5030, a single-user database's 924), which Open Connections never asks about.</summary>
    public const string OtherConnectionsAdvice = "Other connections use the database. Close them first.";
    /// <summary>What a login action's PERMISSION_DENIED adds (D4 P4, P7): SQL Server's 15151 also says the login may not exist,
    /// which the preflight has just ruled out.</summary>
    public const string LoginPermissionAdvice = "Changing a login needs ALTER ANY LOGIN, and CONTROL SERVER for a member of sysadmin.";
    /// <summary>A login's Delete when a session connected as it fails the DROP (15434): the sessions a preflight could not see
    /// (without VIEW SERVER STATE), or one that signed in after it (D4c).</summary>
    public const string LoginSessionsAdvice = "End the login's sessions first; Activity Monitor can end them.";
    /// <summary>SQL Server error numbers by the code they map to (Lost also covers severity 20 and above), one mapping per line.</summary>
    public static readonly IReadOnlyDictionary<string, int[]> Numbers = new Dictionary<string, int[]>(StringComparer.Ordinal)
    {
        ["BLOCKED"] = [1222],
        // 3702 drop, 5030 rename or collation (exclusive lock), 5061 and 5070 state changes, 924 single-user.
        // 15434: a login with sessions (DROP LOGIN, D4c).
        ["IN_USE"] = [3702, 5030, 5061, 5070, 924, 15434],
        // 3726 a foreign key, 3729 a schema-bound module, 15336 sp_rename on an object schema binding holds, 5042 a non-empty file or filegroup,
        // 3709 a database snapshot of the database being dropped.
        // From 15174: what a login owns or is mapped to, which DROP LOGIN fails on (D4 §5.4's error map, for D4c); 15173: the server
        // permissions a login granted.
        ["DEPENDENTS"] = [3726, 3729, 15336, 5042, 3709, 15174, 15170, 15141, 15155, 15186, 15144, 15138, 15421, 15284, 15183, 15173],
        // 1828 and 5170: a logical file name or a physical file is taken; 15025 a server principal (a new login, or a login's
        // rename), 15023 a user.
        ["NAME_IN_USE"] = [2714, 1801, 15335, 1828, 5170, 15025, 15023],
        // 15007: the login is not valid; 15010 a default database, 15033 a language and 15401 a Windows account that does not exist.
        // 50010: a guarded DROP's principal is not the one it was planned for (ActionSql.UserCheck, LoginCheck).
        ["NOT_FOUND"] = [15225, 15007, 15010, 15033, 15401, 50010],
        // 5058: the option cannot be set in this database (SQL Server's own). New Login (probed by D2): 15099 MUST_CHANGE without
        // CHECK_EXPIRATION, 15122 CHECK_EXPIRATION without CHECK_POLICY, 15006 a backslash in a SQL login, 15407 not DOMAIN\name,
        // 37525 Microsoft Entra not set up on the server. 15405, 15021 (a SQL login's name with a backslash, D4 P3): changes to
        // logins SQL Server refuses outright.
        ["NOT_SUPPORTED"] = [5058, 15099, 15122, 15006, 15407, 37525, 15405, 15021],
        // The password policy: 15114 too recent, 15115 not usable now, 15116 too short, 15117 too long, 15118 not complex enough.
        ["PASSWORD_POLICY"] = [15114, 15115, 15116, 15117, 15118],
        ["PERMISSION_DENIED"] = [229, 262, 297, 3701, 15247, 15151],
        ["DATABASE_UNAVAILABLE"] = [942, 952, 976, 978, 4060, 916],
        ["CONNECTION_LOST"] = [-1, 2, 53, 64, 121, 233, 10053, 10054, 10060]
    };
    public static ActionError Create(ActionsCatalog catalog, string code, string message) =>
        new(code, ScriptingErrors.Clip(message, MaxMessage), catalog.Retryable(code));

    /// <summary>The code of a SqlException, by its number (and severity: 20 and above loses the connection).</summary>
    public static string CodeOf(SqlException error, SqlConnection? connection)
    {
        if (connection?.State is ConnectionState.Broken or ConnectionState.Closed || error.Class >= 20) return "CONNECTION_LOST";
        foreach (var (code, numbers) in Numbers) if (numbers.Contains(error.Number)) return code;
        return "SQL_ERROR";
    }

    /// <summary>A failure as a value: SQL Server's message, with advice where one helps. <paramref name="ddl"/>: the
    /// connection broke while DDL may have run; <paramref name="inUseAdvice"/>: what to do when other connections use the database;
    /// <paramref name="serverText"/>: applied to SQL Server's own text only (New Login's scrubber).</summary>
    public static ActionError FromSql(ActionsCatalog catalog, SqlException error, SqlConnection? connection, bool ddl, string? inUseAdvice, Func<string, string>? serverText = null)
    {
        var code = CodeOf(error, connection);
        var text = string.Join(" ", error.Errors.Cast<SqlError>().Where(item => item.Class > 10).Select(item => item.Message).Distinct());
        if (text.Length == 0) text = error.Message;
        if (serverText is not null) text = serverText(text);
        var message = code switch
        {
            "CONNECTION_LOST" => ddl ? "The connection to the server was lost while the action ran, so whether it completed is unknown. Refresh Object Explorer to check." : "The connection to the server was lost. Try again.",
            "BLOCKED" => "Another session holds a lock on the object; try again when it finishes.",
            "IN_USE" when inUseAdvice is not null => text + " " + inUseAdvice,
            _ => text
        };
        return Create(catalog, code, message);
    }
}
