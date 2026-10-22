using Microsoft.Data.SqlClient;

namespace Varia.Backend.Live;

/// <summary>A probe's failure as a value (docs/ipc.md, Live subscriptions): its code, whether it stops the probe for good,
/// and a complete sentence. Messages name no object, database or value; SQL Server's own text appears only for an
/// unclassified error (SQL_ERROR), as SqlClient gives it.</summary>
internal static class LiveErrors
{
    private static readonly int[] Blocked = [1222, 1205];
    private static readonly int[] Permission = [297, 300, 229, 262];
    private static readonly int[] Unsupported = [207, 208];
    private static readonly int[] Unavailable = [4060, 911, 942, 952, 922, 924, 926, 927, 945, 976, 978];
    /// <summary>Login failed, locked out, password expired or must change, untrusted domain: retrying alone would only count
    /// more failures against the login (and lock it out), so the probe stops until the user acts.</summary>
    private static readonly int[] LoginFailed = [18456, 18486, 18487, 18488, 18452];
    private static readonly int[] Lost = [-1, 2, 53, 64, 121, 233, 10053, 10054, 10060];

    public const string BlockedMessage = "Another session held a lock this view needed for more than a second. It tries again.";
    public const string TimeoutMessage = "The server took longer than this view's time budget. It tries again, less often while that repeats.";
    public const string PermissionMessage = "This view needs the VIEW SERVER STATE permission (VIEW SERVER PERFORMANCE STATE on SQL Server 2022 and later).";
    public const string UnsupportedMessage = "This server does not support this view.";
    public const string UnavailableMessage = "A database this view reads is not available. It tries again.";
    public const string LostMessage = "The connection for this view was lost. It reconnects on its own.";
    public const string LoginFailedMessage = "SQL Server refused this view's sign-in (the password may have changed, or the login is locked or disabled). Refresh or reconnect to sign in again.";
    public const string BusyMessage = "Too many live views are reading this server at once. It tries again.";

    /// <summary>The live error code of a SQL Server error number and severity.</summary>
    public static string Classify(int number, byte severity) => number switch
    {
        _ when Blocked.Contains(number) => "BLOCKED",
        _ when Permission.Contains(number) => "PERMISSION_DENIED",
        _ when Unsupported.Contains(number) => "NOT_SUPPORTED",
        _ when Unavailable.Contains(number) => "DATABASE_UNAVAILABLE",
        _ when LoginFailed.Contains(number) => "LOGIN_FAILED",
        -2 => "TIMEOUT",
        _ when severity >= 20 || Lost.Contains(number) => "CONNECTION_LOST",
        _ => "SQL_ERROR"
    };

    public static bool IsTerminal(string code) => code is "PERMISSION_DENIED" or "NOT_SUPPORTED" or "LOGIN_FAILED";

    /// <summary>The connection cannot be used again: it is dropped (and never returned to the pool).</summary>
    public static bool Breaks(string code) => code is "CONNECTION_LOST" or "TIMEOUT";

    public static LiveProbeError From(string probe, SqlException error, int maxCharacters = 2000)
    {
        var first = error.Errors.Cast<SqlError>().FirstOrDefault(item => item.Class > 10) ?? (error.Errors.Count > 0 ? error.Errors[0] : null);
        var number = first?.Number ?? error.Number;
        var code = Classify(number, first?.Class ?? error.Class);
        var message = code switch
        {
            "BLOCKED" => BlockedMessage,
            "PERMISSION_DENIED" => PermissionMessage,
            "NOT_SUPPORTED" => UnsupportedMessage,
            "DATABASE_UNAVAILABLE" => UnavailableMessage,
            "TIMEOUT" => TimeoutMessage,
            "CONNECTION_LOST" => LostMessage,
            "LOGIN_FAILED" => LoginFailedMessage,
            _ => "Msg " + number + ": " + (first?.Message ?? error.Message)
        };
        return Create(probe, code, message, number == 0 ? null : number, maxCharacters);
    }

    public static LiveProbeError Create(string probe, string code, string message, int? number = null, int maxCharacters = 2000) =>
        new(probe, code, Clip(message, maxCharacters), number, 0, IsTerminal(code));

    /// <summary>A sign-in that failed while the view reconnected (Kerberos or Entra): the sign-in's own message, which says
    /// what to fix; it retries with back-off.</summary>
    public static LiveProbeError SignIn(string probe, RequestException error, int maxCharacters = 2000) =>
        Create(probe, error.Code == "AUTH_ENTRA" ? "AUTH_ENTRA" : "AUTH_KERBEROS", error.Message.Length > 0 ? error.Message : "Signing in to the server failed. It tries again.", null, maxCharacters);

    private static string Clip(string text, int max) => text.Length <= max ? text : text[..(max - 1)] + "…";
}
