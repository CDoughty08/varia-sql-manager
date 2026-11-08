using System.Data;
using System.Globalization;
using System.Xml;
using System.Xml.Linq;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Plans;

/// <summary>Collects completed plans through a separate connection. The executing session receives only the user's SQL.</summary>
internal sealed class ActualPlanCapture(SqlConnection observer, bool databaseScoped)
{
    private const string PlanEvent = ActualPlanSql.PlanEvent;
    private const string BatchEvent = ActualPlanSql.BatchEvent;
    private const int MaxTargetCharacters = 4 * 1024 * 1024;
    private static readonly XName AggregateName = PlanParser.ShowplanName.Namespace + "Aggregate";
    // Database-scoped sessions (Azure SQL Database) end by MAX_DURATION and are never swept, so a random name serves them.
    private string name = ActualPlanSql.NameFor(Guid.NewGuid());
    private readonly List<(int Batch, int Iteration)> submitted = [];
    private bool attempted;
    public bool Started { get; private set; }

    /// <summary>Creates and starts the session; returns why capture is unavailable, or after it started, a notice that the
    /// sweep of sessions left by earlier captures failed; otherwise null.</summary>
    public async Task<string?> StartAsync(int spid, Guid clientId, int major, int timeout, CancellationToken token)
    {
        if (clientId == Guid.Empty) return "This connection does not expose an identifier for actual plan capture.";

        // Check every privilege before creating a session, including the one needed to remove it.
        await using var command = observer.CreateCommand();
        command.CommandTimeout = 0;
        command.CommandText = ActualPlanSql.Permissions(databaseScoped);
        if (await command.ExecuteScalarAsync(token) is not 1)
            return "Actual plan capture requires permission to create, start, read and drop Extended Events sessions.";

        command.Parameters.Add("@spid", SqlDbType.Int).Value = spid;
        if (!databaseScoped)
        {
            command.CommandText = ActualPlanSql.NameQuery;
            if (await command.ExecuteScalarAsync(token) is not string named || !ActualPlanSql.IsName(named))
                return "Actual plan capture could not identify the connection it observes.";
            name = named;
        }
        var duration = major >= 17 || databaseScoped ? (timeout > 0 ? timeout + 15 : 86_400) : (int?)null;
        command.Parameters.Add("@name", SqlDbType.NVarChar, 128).Value = name;
        command.CommandText = ActualPlanSql.Create(name, databaseScoped, spid, clientId, duration);
        attempted = true;
        await command.ExecuteNonQueryAsync(token);
        Started = true;
        return databaseScoped ? null : await SweepAsync(command, token);
    }

    /// <summary>Drops sessions that earlier captures left when their backend died (<see cref="ActualPlanSql.Sweep"/>), once this
    /// capture has started, within what is left of its start's budget. A failure only costs a notice.</summary>
    private async Task<string?> SweepAsync(SqlCommand command, CancellationToken token)
    {
        try
        {
            command.Parameters.Add("@own", SqlDbType.NVarChar, 128).Value = name;
            command.CommandText = ActualPlanSql.Sweep;
            await using var reader = await command.ExecuteReaderAsync(token);
            return await reader.ReadAsync(token) && reader.GetInt32(1) == 0 ? null : SweepNotice;
        }
        catch (Exception error) when (error is SqlException or InvalidOperationException or OperationCanceledException or IOException)
        {
            return SweepNotice;
        }
    }

    internal const string SweepNotice = "Actual plan capture could not remove Extended Events sessions that earlier captures left behind.";

    public void BatchSubmitted(int batch, int iteration) => submitted.Add((batch, iteration));

    public async Task<Snapshot> ReadAsync(CancellationToken token)
    {
        await using var command = observer.CreateCommand();
        command.CommandTimeout = 0;
        command.CommandText = ActualPlanSql.Read(databaseScoped);
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
            // Auto-statistics can run in the user session with is_system=0. Match the internal aggregate, not SQL text.
            if (showplan.Descendants(AggregateName).Any(aggregate => (string?)aggregate.Attribute("AggType") == "STATMAN")) continue;
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
                command.CommandText = ActualPlanSql.Drop(name, databaseScoped);
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
