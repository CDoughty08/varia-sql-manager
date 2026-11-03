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
    /// <summary>SQL Server error numbers by the code they map to (Lost also covers severity 20 and above), one mapping per line.</summary>
    public static readonly IReadOnlyDictionary<string, int[]> Numbers = new Dictionary<string, int[]>(StringComparer.Ordinal)
    {
        ["BLOCKED"] = [1222],
        // 3702 drop, 5030 rename or collation (exclusive lock), 5061 and 5070 state changes, 924 single-user, 3101 a restore's exclusive access.
        ["IN_USE"] = [3702, 5030, 5061, 5070, 924, 3101],
        // 3726 a foreign key, 3729 a schema-bound module, 15336 sp_rename on an object schema binding holds, 5042 a non-empty file or filegroup,
        // 3709 a database snapshot of the database being dropped.
        ["DEPENDENTS"] = [3726, 3729, 15336, 5042, 3709],
        // 1828 and 5170: a logical file name or a physical file is taken; 15025 a login, 15023 a user.
        ["NAME_IN_USE"] = [2714, 1801, 15335, 1828, 5170, 15025, 15023],
        // 15007: the login is not valid; 15010 a default database, 15033 a language and 15401 a Windows account that does not exist.
        ["NOT_FOUND"] = [15225, 15007, 15010, 15033, 15401],
        // 5058: the option cannot be set in this database. (948, a database from a newer SQL Server, is severity 20: it ends the
        // session, so it is CONNECTION_LOST, and Attach refuses such a database itself before it runs anything.) New Login (probed
        // by D2): 15099 MUST_CHANGE without CHECK_EXPIRATION, 15122 CHECK_EXPIRATION without CHECK_POLICY, 15006 a backslash in a
        // SQL login, 15407 not DOMAIN\name, 37525 Microsoft Entra not set up on the server.
        ["NOT_SUPPORTED"] = [5058, 15099, 15122, 15006, 15407, 37525],
        // The password policy: 15114 too recent, 15115 not usable now, 15116 too short, 15117 too long, 15118 not complex enough
        // (Windows' policy); SQL Server's own policy, which SQL Server on Linux applies, answers 33062 too short, 33063 too long and
        // 33064 not complex enough (a password that contains the login name too).
        ["PASSWORD_POLICY"] = [15114, 15115, 15116, 15117, 15118, 33062, 33063, 33064],
        // 5133: a file's folder does not exist (attach).
        ["PATH_NOT_FOUND"] = [5133],
        // 5120 and 5123: SQL Server could not open a database or backup file (missing, in use, or denied to its service account).
        ["FILE_ACCESS"] = [5120, 5123],
        // 2571: DBCC CHECKPRIMARYFILE (Attach's Add) outside sysadmin; 5011: ALTER DATABASE without ALTER on it (Take Offline and
        // Bring Online refused in SQL Server).
        ["PERMISSION_DENIED"] = [229, 262, 297, 3701, 15247, 15151, 2571, 5011],
        ["DATABASE_UNAVAILABLE"] = [942, 952, 976, 978, 4060, 916],
        // Backup media a restore cannot use: a family misformed or missing (3241, 3242), a damaged or unreadable set (3183, 3189).
        // 3201, a device that cannot be opened, is PATH_NOT_FOUND (not there) or FILE_ACCESS (any other reason) by its operating system
        // error (RestoreDescribe.MediaError).
        ["MEDIA"] = [3241, 3242, 3183, 3189],
        // A restore over a database the backup is not of without WITH REPLACE (3154); over the database itself without its tail-log
        // backup (3159); sets out of sequence: too early or too late in the chain (4305, 4326), or no restore to continue (3117).
        ["BACKUP_MISMATCH"] = [3154],
        ["TAIL_LOG_NEEDED"] = [3159],
        ["RESTORE_SEQUENCE"] = [4305, 4326, 3117],
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
