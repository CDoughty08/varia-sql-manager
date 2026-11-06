using System.Data;
using System.Globalization;
using System.Xml;
using System.Xml.Linq;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Plans;

/// <summary>Collects completed plans through a separate connection. The executing session receives only the user's SQL.</summary>
internal sealed class ActualPlanCapture(SqlConnection observer, bool databaseScoped)
{
    private const string PlanEvent = "query_post_execution_plan_profile";
    private const string BatchEvent = "sql_batch_starting";
    private const int MaxTargetCharacters = 4 * 1024 * 1024;
    private readonly string name = "VariaActual_" + Guid.NewGuid().ToString("N");
    private readonly List<(int Batch, int Iteration)> submitted = [];
    private string Scope => databaseScoped ? "DATABASE" : "SERVER";
    private string Dmv => databaseScoped ? "dm_xe_database_session" : "dm_xe_session";
    private bool attempted;
    public bool Started { get; private set; }

    public async Task<string?> StartAsync(int spid, Guid clientId, int major, int timeout, CancellationToken token)
    {
        if (clientId == Guid.Empty) return "This connection does not expose an identifier for actual plan capture.";

        // Check every privilege before creating a session, including the one needed to remove it.
        var permissionScope = databaseScoped ? "DB_NAME(), 'DATABASE'" : "NULL, NULL";
        var eventScope = databaseScoped ? "DATABASE " : "";
        string Permission(string permission) => $"HAS_PERMS_BY_NAME({permissionScope}, '{permission}')";
        var administer = Permission($"ALTER ANY {eventScope}EVENT SESSION");
        var create = Permission($"CREATE ANY {eventScope}EVENT SESSION");
        var enable = Permission($"ALTER ANY {eventScope}EVENT SESSION ENABLE");
        var drop = Permission($"DROP ANY {eventScope}EVENT SESSION");
        // A granular DENY overrides the parent grant. Use the parent only on engines without granular permissions.
        var manage = $"(({create}=1 AND {enable}=1 AND {drop}=1) OR ({drop} IS NULL AND {administer}=1))";
        var performance = Permission("VIEW SERVER PERFORMANCE STATE");
        var inspect = databaseScoped ? $"{Permission("VIEW DATABASE STATE")}=1"
            : $"({performance}=1 OR ({performance} IS NULL AND {Permission("VIEW SERVER STATE")}=1))";

        await using var command = observer.CreateCommand();
        command.CommandTimeout = 0;
        command.CommandText = $"SELECT CASE WHEN {manage} AND {inspect} THEN 1 ELSE 0 END;";
        if (await command.ExecuteScalarAsync(token) is not 1)
            return "Actual plan capture requires permission to create, start, read and drop Extended Events sessions.";

        // A disconnected session's SPID can be reused. Match the physical connection ID as well so an abandoned
        // collector cannot read plans from any other connection.
        var predicate = FormattableString.Invariant($"[sqlserver].[session_id]=({spid}) AND [package0].[equal_guid]([sqlserver].[client_connection_id],'{clientId:D}')");
        var duration = major >= 17 || databaseScoped
            ? FormattableString.Invariant($", MAX_DURATION = {(timeout > 0 ? timeout + 15 : 86_400)} SECONDS") : "";
        command.CommandText = $"""
            CREATE EVENT SESSION [{name}] ON {Scope}
                ADD EVENT sqlserver.{BatchEvent}(SET collect_batch_text=(0) ACTION(package0.event_sequence) WHERE ({predicate})),
                ADD EVENT sqlserver.{PlanEvent}(ACTION(package0.event_sequence) WHERE ({predicate} AND [sqlserver].[is_system]=(0)))
                ADD TARGET package0.ring_buffer(SET max_memory=(4096), max_events_limit=(2048))
                WITH (MAX_MEMORY=4096 KB, MAX_EVENT_SIZE=4096 KB, MAX_DISPATCH_LATENCY=1 SECONDS, STARTUP_STATE=OFF{duration});
            ALTER EVENT SESSION [{name}] ON {Scope} STATE=START;
            """;
        attempted = true;
        await command.ExecuteNonQueryAsync(token);
        Started = true;
        return null;
    }

    public void BatchSubmitted(int batch, int iteration) => submitted.Add((batch, iteration));

    public async Task<Snapshot> ReadAsync(CancellationToken token)
    {
        await using var command = observer.CreateCommand();
        command.CommandTimeout = 0;
        command.CommandText = $"""
            SELECT CONVERT(bigint,s.dropped_event_count), CONVERT(bigint,s.dropped_buffer_count), t.target_data
            FROM sys.{Dmv}s AS s JOIN sys.{Dmv}_targets AS t ON s.address=t.event_session_address
            WHERE s.name=@name AND t.target_name=N'ring_buffer';
            """;
        command.Parameters.Add("@name", SqlDbType.NVarChar, 128).Value = name;
        // XmlReader's underlying TextReader reads do not take a token. Bound those reads with a SQL attention.
        using var cancel = token.Register(() =>
        {
            try { command.Cancel(); }
            catch (Exception error) when (error is SqlException or InvalidOperationException) { }
        });
        token.ThrowIfCancellationRequested();
        await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, CancellationToken.None);
        if (!await reader.ReadAsync(CancellationToken.None)) return new([], true);
        var lost = reader.GetInt64(0) > 0 || reader.GetInt64(1) > 0;
        if (await reader.IsDBNullAsync(2, CancellationToken.None)) return new([], lost);
        using var text = reader.GetTextReader(2);
        using var xml = XmlReader.Create(text, new XmlReaderSettings
        {
            Async = true, DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = MaxTargetCharacters
        });
        var root = await XElement.LoadAsync(xml, LoadOptions.None, token);
        lost |= (string?)root.Attribute("truncated") == "1" || (long?)root.Attribute("droppedCount") > 0
            || (long?)root.Attribute("totalEventsProcessed") > (long?)root.Attribute("eventCount");
        var events = root.Elements("event").OrderBy(Sequence).ToArray();
        // A missing batch marker makes ordinals ambiguous. Retain the plans in sequence with an unknown batch.
        var haveMarkers = !lost && events.Count(entry => (string?)entry.Attribute("name") == BatchEvent) == submitted.Count;
        var batch = -1;
        var plans = new List<CapturedPlan>();
        foreach (var entry in events)
        {
            token.ThrowIfCancellationRequested();
            if ((string?)entry.Attribute("name") == BatchEvent) { batch++; continue; }
            if ((string?)entry.Attribute("name") != PlanEvent) continue;
            var value = entry.Elements("data").FirstOrDefault(data => (string?)data.Attribute("name") == "showplan_xml")?.Element("value");
            if (value?.Element(PlanParser.ShowplanName) is not { } showplan) { lost = true; continue; }
            var position = haveMarkers && batch >= 0 && batch < submitted.Count ? submitted[batch] : default;
            plans.Add(new(showplan.ToString(SaveOptions.DisableFormatting), position.Batch, position.Iteration));
        }
        return new(plans, lost);
    }

    private static long Sequence(XElement entry) =>
        long.TryParse(entry.Elements("action").FirstOrDefault(action => (string?)action.Attribute("name") == "event_sequence")?.Element("value")?.Value,
            NumberStyles.None, CultureInfo.InvariantCulture, out var sequence) ? sequence : long.MaxValue;

    public async Task<string?> CloseAsync(CancellationToken token)
    {
        string? notice = null;
        try
        {
            if (attempted)
            {
                if (observer.State != ConnectionState.Open)
                {
                    observer.Close();
                    await observer.OpenAsync(token);
                }
                await using var command = observer.CreateCommand();
                command.CommandTimeout = 0;
                command.CommandText = $"DROP EVENT SESSION [{name}] ON {Scope};";
                await command.ExecuteNonQueryAsync(token);
            }
        }
        catch (SqlException error) when (!Started && error.Number == 15151) { }
        catch (Exception error) when (error is SqlException or InvalidOperationException or OperationCanceledException or IOException)
        {
            notice = $"Actual plan capture could not remove its Extended Events session ({name}).";
        }
        finally
        {
            try { await observer.DisposeAsync(); }
            catch (Exception error) when (error is SqlException or InvalidOperationException or OperationCanceledException or IOException)
            { notice ??= "Actual plan capture could not close its observer connection."; }
        }
        return notice;
    }

    internal sealed record Snapshot(List<CapturedPlan> Plans, bool Incomplete);
    internal sealed record CapturedPlan(string Xml, int Batch, int Iteration);
}
