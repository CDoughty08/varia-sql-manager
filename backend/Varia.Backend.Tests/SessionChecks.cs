using System.Data;
using Microsoft.Data.SqlClient;

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

        // What a lost session says became of its transaction (the live checks drive each path in a real session).
        using var connection = new SqlConnection();
        var session = new QuerySession(Guid.NewGuid().ToString(), connection);
        check(SqlService.LostMessage(session, committing: false, commit: false) == SqlService.LostRolledBack
            && SqlService.LostMessage(session, committing: false, commit: true) == SqlService.LostNothingCommitted
            && SqlService.LostMessage(session, committing: true, commit: true) == SqlService.LostWhileCommitting,
            "a session lost before a commit was sent says SQL Server rolled back its transaction, and one lost while the commit ran that the outcome is unknown");
        session.CommitInDoubt = true;
        check(SqlService.LostMessage(session, committing: false, commit: false) == SqlService.LostAfterUnfinishedCommit
            && SqlService.LostMessage(session, committing: false, commit: true) == SqlService.LostAfterUnfinishedCommit
            && SqlService.LostMessage(session, committing: true, commit: true) == SqlService.LostWhileCommitting
            && !SqlService.LostAfterUnfinishedCommit.Contains("Nothing was committed", StringComparison.Ordinal),
            "after a commit that never answered, a session found lost never says that nothing was committed");
    }
}
