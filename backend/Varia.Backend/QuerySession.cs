using Microsoft.Data.SqlClient;

namespace Varia.Backend;

internal sealed class QuerySession(string connectionId, SqlConnection connection)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private int closed;
    public string ConnectionId { get; } = connectionId;
    public SqlConnection Connection { get; } = connection;
    public bool HasOpened { get; set; }
    /// <summary>The session's SPID and login, read once when it opened, as SSMS shows them from the connection.</summary>
    public int? Spid { get; set; }
    public string? Login { get; set; }

    public bool TryEnter()
    {
        if (!gate.Wait(0)) return false;
        if (Volatile.Read(ref closed) == 0) return true;
        gate.Release();
        throw new RequestException("SESSION_CLOSED", "This query session was closed. Execute again to open a new session.");
    }

    public void Exit()
    {
        gate.Release();
        if (Volatile.Read(ref closed) != 0) Close();
    }

    public void Close()
    {
        Interlocked.Exchange(ref closed, 1);
        // An active command owns the connection until it observes cancellation and exits.
        if (!gate.Wait(0)) return;
        try { Connection.Dispose(); }
        finally { gate.Release(); }
    }
}
