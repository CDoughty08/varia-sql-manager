using Microsoft.Data.SqlClient;

namespace Varia.Backend.Ssis;

/// <summary>SSIS Catalog failures as values (D-ssis 5.2). Messages name only what the user opened and carry SQL Server's own
/// text; never SQL text, connection strings or stack traces, and nothing is logged.</summary>
internal static class SsisErrors
{
    /// <summary>SQL Server error numbers by the code they map to (Lost also covers severity 20 and above), one mapping per line.</summary>
    public static readonly IReadOnlyDictionary<string, int[]> Numbers = new Dictionary<string, int[]>(StringComparer.Ordinal)
    {
        // A lock timeout, or a deadlock the read (DEADLOCK_PRIORITY LOW) lost: the catalog's own writes and cleanup win.
        ["BLOCKED"] = [1222, 1205],
        ["PERMISSION_DENIED"] = [229, 230, 262, 297, 300],
        ["NO_DB_ACCESS"] = [4060, 916],
        // The database is offline, restoring, recovering, in transition, or single-user in use (Object Explorer's own list).
        ["DATABASE_UNAVAILABLE"] = [922, 924, 926, 927, 942, 945, 952, 976, 978],
        // A catalog view that is not there: the database is not an SSIS Catalog, or an incomplete one.
        ["CATALOG_MISSING"] = [208],
        // "The operation cannot be started by an account that uses SQL Server Authentication" (S0: every catalog procedure that
        // changes something raises it for a SQL Server login).
        ["WINDOWS_AUTH_REQUIRED"] = [27123],
        ["TIMEOUT"] = [-2],
        ["CONNECTION_LOST"] = [-1, 2, 53, 64, 121, 233, 10053, 10054, 10060]
    };
    /// <summary>catalog.stop_operation's refusals: the operation is not running (or not valid), or it is already stopping. The
    /// action reads the operation again to say which.</summary>
    public static readonly int[] NotStoppable = [27124, 27126];
    /// <summary>"Could not continue scan with NOLOCK due to data movement": a READ UNCOMMITTED read met the catalog's cleanup
    /// deleting rows; a describe reads once more (D-ssis 4.2).</summary>
    public const int DataMovement = 601;

    public static SsisError Create(SsisCatalog catalog, string code, string message) => new(code, Clip(message, catalog.Limit("messageChars")), catalog.Retryable(code));

    public static string CodeOf(SqlException error, SqlConnection? connection) =>
        CodeOf(error.Number, error.Class, connection?.State is System.Data.ConnectionState.Broken or System.Data.ConnectionState.Closed);

    /// <summary>The code of a SQL Server error by its number and severity (20 and above loses the connection), or of a broken connection.</summary>
    public static string CodeOf(int number, byte severity, bool broken)
    {
        if (severity >= 20) return "CONNECTION_LOST";
        foreach (var (code, numbers) in Numbers) if (numbers.Contains(number)) return code;
        return broken ? "CONNECTION_LOST" : "SQL_ERROR";
    }

    /// <param name="subject">What the request read, as the tree labels it ("Folder Finance").</param>
    /// <param name="action">For a write, what it does ("stop operation 42"): permission errors name it, and a lost connection
    /// leaves its outcome unknown.</param>
    public static SsisError FromSql(SsisCatalog catalog, SqlException error, SqlConnection? connection, string catalogName, string subject, string? action = null)
    {
        var code = CodeOf(error, connection);
        var text = string.Join(" ", error.Errors.Cast<SqlError>().Where(item => item.Class > 10).Select(item => item.Message).Distinct());
        if (text.Length == 0) text = error.Message;
        var message = code switch
        {
            "BLOCKED" => "Another session holds a lock in " + catalogName + " (a deployment, an execution starting, or the catalog's cleanup). Retry when it finishes.",
            "PERMISSION_DENIED" => "You do not have permission to " + (action ?? "read " + subject) + " (" + text + ").",
            "WINDOWS_AUTH_REQUIRED" => WindowsAuthRequired,
            "NO_DB_ACCESS" => NoAccess(catalogName),
            "DATABASE_UNAVAILABLE" => NotAvailable(catalogName, text),
            "CATALOG_MISSING" => catalogName + " is not a complete SSIS Catalog (" + text + ").",
            "TIMEOUT" => Timeout(catalog),
            "CONNECTION_LOST" => action is null ? "The connection to the server was lost. Try again."
                : "The connection to the server was lost before SQL Server answered, so whether it did " + action + " is not known. Check before you retry.",
            _ => "Msg " + error.Number + ": " + text
        };
        return Create(catalog, code, message);
    }

    /// <summary>D-ssis 5.2's wording for 27123 and for a verb refused before it connects.</summary>
    public const string WindowsAuthRequired = "SSISDB on SQL Server needs Windows authentication for this. Reconnect with Windows authentication.";
    public static string NotAvailable(string catalogName, string reason) => "Database " + catalogName + " is not available (" + Clip(reason, 200) + "). Retry when it is back online.";
    public static string NoAccess(string catalogName) => "The current login cannot access database " + catalogName + ".";
    public static string Missing(string catalogName) => "The SSIS Catalog (" + catalogName + ") does not exist on this server.";
    public static string Timeout(SsisCatalog catalog) => "Reading the SSIS Catalog took longer than " + catalog.Limit("describeMs") / 1000 + " seconds. Try again.";

    private static string Clip(string text, int max) => text.Length <= max ? text : text[..(max - 1)] + "…";
}
