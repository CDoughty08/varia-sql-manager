using System.Collections.Concurrent;
using System.Data;
using System.Reflection;
using System.Text.Json;
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

    /// <summary>A tab's first execute stores its new session under sessionGate after checking the target; a disconnect landing
    /// in between must still find and close it, not leave a session that counts against the limit until the tab closes.
    /// Its own suite in OfflineSuites.Alone: it reads the process-wide Monitor.LockContentionCount, which another suite's
    /// contention could satisfy early and let the race go unseen.</summary>
    public static void DisconnectDuringSessionOpen(Action<bool, string> check)
    {
        using var sql = new SqlService();
        var flags = BindingFlags.Instance | BindingFlags.NonPublic;
        var connectionId = Guid.NewGuid().ToString();
        ((ConcurrentDictionary<string, string>)typeof(SqlService).GetField("connections", flags)!.GetValue(sql)!)[connectionId] = "Data Source=offline";
        var sessions = (ConcurrentDictionary<string, QuerySession>)typeof(SqlService).GetField("sessions", flags)!.GetValue(sql)!;
        var gate = typeof(SqlService).GetField("sessionGate", flags)!.GetValue(sql)!;
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        using var stored = new SqlConnection("Data Source=offline");
        Task<object> disconnect;
        bool waited;
        // Held as Session() holds it between its target check and storing the session. The disconnect either finishes first
        // (the race) or contends for the gate (the fix); either way the session is stored only after that.
        lock (gate)
        {
            var contended = Monitor.LockContentionCount;
            disconnect = Task.Run(() => sql.DispatchAsync("connections.disconnect", JsonSerializer.SerializeToElement(new ConnectionArgs(connectionId), json), json));
            waited = SpinWait.SpinUntil(() => disconnect.IsCompleted || Monitor.LockContentionCount > contended, 15000);
            sessions[Guid.NewGuid().ToString()] = new QuerySession(connectionId, stored);
        }
        var answer = JsonSerializer.Serialize(disconnect.GetAwaiter().GetResult(), json);
        check(waited && answer == "{\"disconnected\":true}" && sessions.IsEmpty && stored.ConnectionString.Length == 0,
            "a disconnect while a tab's session is being stored closes that session too, never leaving it behind (" + answer + ", sessions " + sessions.Count + ")");
    }
}
