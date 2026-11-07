using System.Collections;
using System.Diagnostics;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Statistics;

/// <summary>A single script's provider counters, on the exclusively held query connection. No SQL is issued here.</summary>
internal sealed class ClientStatisticsCollector
{
    // ExecutionTime is intentionally excluded: ExecuteReaderAsync does not reliably update it (live regression checks).
    internal static readonly string[] Keys = ["BytesSent", "BytesReceived", "BuffersSent", "BuffersReceived", "ServerRoundtrips",
        "SelectCount", "SelectRows", "IduCount", "IduRows", "SumResultSets", "Transactions", "CursorOpens", "Prepares", "PreparedExecs", "UnpreparedExecs",
        "NetworkServerTime"];
    private readonly SqlConnection connection;
    private readonly Stopwatch watch = new();
    private bool started;
    private string? unavailable;

    public ClientStatisticsCollector(SqlConnection connection)
    {
        this.connection = connection;
        try
        {
            connection.StatisticsEnabled = true;
            connection.ResetStatistics();
            started = true;
            watch.Start();
        }
        catch (Exception error) when (error is InvalidOperationException or NotSupportedException or SqlException)
        { unavailable = "The provider could not start statistics collection."; }
    }

    // The wire uses JS numbers: absent, negative, saturated and unsafe values are unavailable, never fabricated zeros.
    internal static Dictionary<string, long> Read(IDictionary values) => Keys
        .Where(key => values[key] is long value && value >= 0 && value <= 9_007_199_254_740_991)
        .ToDictionary(key => key, key => (long)values[key]!);

    public ClientStatisticsSample Finish()
    {
        watch.Stop();
        Dictionary<string, long> counters = [];
        try { if (started) counters = Read(connection.RetrieveStatistics()); }
        catch (Exception error) when (error is InvalidOperationException or NotSupportedException or SqlException)
        { unavailable = "The provider could not retrieve statistics for this execution."; }
        finally
        {
            try { connection.StatisticsEnabled = false; }
            catch (Exception error) when (error is InvalidOperationException or NotSupportedException or SqlException) { }
        }
        return new(counters, started ? watch.ElapsedMilliseconds : null, unavailable);
    }
}

internal sealed record ClientStatisticsSample(Dictionary<string, long> Counters, long? CollectionElapsedMs, string? Unavailable = null);
