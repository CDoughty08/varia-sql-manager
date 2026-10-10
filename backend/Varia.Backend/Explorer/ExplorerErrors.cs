using Microsoft.Data.SqlClient;

namespace Varia.Backend.Explorer;

/// <summary>Where a SQL error came from: the scope wrapper (EXEC [db].sys.sp_executesql, so 2812 means the database is
/// gone) or a catalog statement.</summary>
internal enum ErrorPhase { Scope, Statement }

/// <summary>Maps SQL Server errors to Object Explorer error values. Messages name only the folder or object the user
/// expanded and SQL Server's own text; never SQL text or stack traces.</summary>
internal static class ExplorerErrors
{
    public const int MaxMessage = 512;
    private static readonly int[] Permission = [229, 230, 262, 297, 300];
    private static readonly int[] NoAccess = [916, 4060];
    private static readonly int[] Unavailable = [922, 924, 926, 927, 942, 945, 952, 976, 978];
    private static readonly int[] Blocked = [1222, 1205];
    private static readonly int[] Lost = [-1, 2, 53, 64, 121, 233, 10053, 10054, 10060];

    public static string Classify(int number, byte severity, ErrorPhase phase) => number switch
    {
        _ when Permission.Contains(number) => "PERMISSION_DENIED",
        _ when NoAccess.Contains(number) => "NO_DB_ACCESS",
        _ when Unavailable.Contains(number) => "DATABASE_UNAVAILABLE",
        911 => "NOT_FOUND",
        2812 when phase == ErrorPhase.Scope => "NOT_FOUND",
        _ when Blocked.Contains(number) => "BLOCKED",
        -2 => "TIMEOUT",
        _ when severity >= 20 || Lost.Contains(number) => "CONNECTION_LOST",
        _ => "SQL_ERROR"
    };

    /// <param name="subject">The folder or object being loaded, as the tree labels it.</param>
    /// <param name="database">The database the request reads, if any.</param>
    public static ExplorerError From(SqlException error, ErrorPhase phase, string subject, string? database)
    {
        var first = error.Errors.Cast<SqlError>().Where(item => item.Class > 10).FirstOrDefault() ?? (error.Errors.Count > 0 ? error.Errors[0] : null);
        var number = first?.Number ?? error.Number;
        var text = first?.Message ?? error.Message;
        var code = Classify(number, first?.Class ?? error.Class, phase);
        // A missing parent object is detected by the statements themselves; a SQL NOT_FOUND is always the database.
        return Create(code, code == "NOT_FOUND" && database is not null ? "Database " + database : subject, database, number, text);
    }

    public static ExplorerError Create(string code, string subject, string? database, int number = 0, string? serverText = null)
    {
        var name = database ?? subject;
        var message = code switch
        {
            "PERMISSION_DENIED" => "You do not have permission to view " + subject + ".",
            "NO_DB_ACCESS" => "The current login cannot access database " + name + ".",
            "DATABASE_UNAVAILABLE" => "Database " + name + " is not available" + (string.IsNullOrEmpty(serverText) ? "." : " (" + Clip(serverText, 200) + ")."),
            "NOT_FOUND" => subject + " no longer exists.",
            "BLOCKED" => "Another session holds a lock on this metadata (for example an uncommitted CREATE or ALTER). Retry after it commits.",
            "TIMEOUT" => "Loading took longer than 30 seconds. Retry, or filter this folder.",
            "CONNECTION_LOST" => "The connection to the server was lost.",
            _ => "Msg " + number + ": " + serverText
        };
        return new(code, Clip(message, MaxMessage), code is not ("NO_DB_ACCESS" or "NOT_FOUND"), code == "NOT_FOUND" ? "refreshParent" : null);
    }

    private static string Clip(string text, int max) => text.Length <= max ? text : text[..(max - 1)] + "…";
}
