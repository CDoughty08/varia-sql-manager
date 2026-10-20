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
    /// <summary>Database Properties' advice when WITH NO_WAIT finds other connections (5061, 5070) or COLLATE cannot lock the database (5030).</summary>
    public const string OpenConnectionsAdvice = "Other connections use the database. Choose Yes when asked to close them, or close them first.";
    /// <summary>SQL Server error numbers by the code they map to (Lost also covers severity 20 and above), one mapping per line.</summary>
    public static readonly IReadOnlyDictionary<string, int[]> Numbers = new Dictionary<string, int[]>(StringComparer.Ordinal)
    {
        ["BLOCKED"] = [1222],
        // 3702 drop, 5030 rename or collation (exclusive lock), 5061 and 5070 state changes, 924 single-user.
        ["IN_USE"] = [3702, 5030, 5061, 5070, 924],
        // 3726 a foreign key, 3729 a schema-bound module, 15336 sp_rename on an object schema binding holds, 5042 a non-empty file or filegroup.
        ["DEPENDENTS"] = [3726, 3729, 15336, 5042],
        // 1828 and 5170: a logical file name or a physical file is taken.
        ["NAME_IN_USE"] = [2714, 1801, 15335, 1828, 5170],
        // 15007: the login is not valid.
        ["NOT_FOUND"] = [15225, 15007],
        // 5058: the option cannot be set in this database (SQL Server's own).
        ["NOT_SUPPORTED"] = [5058],
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
    /// connection broke while DDL may have run; <paramref name="inUseAdvice"/>: what to do when other connections use the database.</summary>
    public static ActionError FromSql(ActionsCatalog catalog, SqlException error, SqlConnection? connection, bool ddl, string? inUseAdvice)
    {
        var code = CodeOf(error, connection);
        var text = string.Join(" ", error.Errors.Cast<SqlError>().Where(item => item.Class > 10).Select(item => item.Message).Distinct());
        if (text.Length == 0) text = error.Message;
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
