using System.Data;

namespace Varia.Backend.Tests;

internal static class SessionChecks
{
    public static void Run(Action<bool, string> check)
    {
        var terminated = ConnectionFailureChecks.Sql(0, 0, 20, "", "Connection was terminated.");
        check(SqlService.IsSessionLost(terminated, ConnectionState.Open),
            "a fatal transport error loses the session before managed SNI updates its connection state");
        var statement = ConnectionFailureChecks.Sql(8134, 1, 16, "", "Divide by zero error encountered.");
        var cancelled = ConnectionFailureChecks.Sql(0, 0, 11, "", "Operation cancelled by user.");
        check(!SqlService.IsSessionLost(statement, ConnectionState.Open) && !SqlService.IsSessionLost(cancelled, ConnectionState.Open)
            && !SqlService.IsSessionLost(new InvalidOperationException(), ConnectionState.Open),
            "a statement error, cancellation or invalid operation alone does not lose an open session");
        check(SqlService.IsSessionLost(statement, ConnectionState.Broken) && SqlService.IsSessionLost(new InvalidOperationException(), ConnectionState.Closed),
            "a connection already closed or broken loses the session regardless of the error severity");
    }
}
