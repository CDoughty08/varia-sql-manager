using System.Data;
using System.Text;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Plans;

internal sealed record EstimatedPlanArgs(string ConnectionId, string SessionId, string RequestId, string Database, string Sql, int StartLine = 1);
internal sealed record EstimatedPlanXml(string Xml, int BatchNumber, int Iteration);
internal sealed record EstimatedPlanResult(List<EstimatedPlanXml> Plans, string Database);

/// <summary>Only called with a fresh, unpooled, non-reconnecting connection. Never borrows or resets a query session.
/// SHOWPLAN changes (including USE and SET) must not contaminate the user's transaction or a later execution.</summary>
internal static class EstimatedPlanCapture
{
    internal const int MaxDocuments = 64;
    internal const int MaxCharacters = 2_097_152;
    internal static readonly TimeSpan Budget = TimeSpan.FromSeconds(30);

    public static async Task<EstimatedPlanResult> ReadAsync(SqlConnection connection, List<EstimatedPlanScript.Batch> batches, int startLine, CancellationToken token)
    {
        var plans = new List<EstimatedPlanXml>();
        var characters = 0;
        await Run(SqlService.SessionPrologue, token);
        try
        {
            // Alone in its own batch, on a connection whose compile options no submitted SQL has touched.
            await Run("SET SHOWPLAN_XML ON", token);
            for (var b = 0; b < batches.Count; b++)
            {
                var batch = batches[b];
                for (var iteration = 1; iteration <= batch.Source.RepeatCount; iteration++)
                {
                    token.ThrowIfCancellationRequested();
                    if (batch.Database is { } database)
                    {
                        // USE itself is not executed under SHOWPLAN. Apply only a validated standalone USE, through
                        // SqlClient's identifier-safe API, with SHOWPLAN off, then re-enable it before any user SQL.
                        await Run("SET SHOWPLAN_XML OFF", token);
                        await connection.ChangeDatabaseAsync(database, token);
                        await Run("SET SHOWPLAN_XML ON", token);
                        continue;
                    }
                    await using var command = connection.CreateCommand();
                    command.CommandTimeout = 0;
                    command.CommandText = batch.Source.Sql;
                    using var cancel = token.Register(() => Cancel(command));
                    token.ThrowIfCancellationRequested();
                    try
                    {
                        // Cancel bounds TextReader reads too, which do not accept a cancellation token.
                        await using var reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, CancellationToken.None);
                        try
                        {
                            do
                            {
                                while (await reader.ReadAsync(CancellationToken.None))
                                {
                                    token.ThrowIfCancellationRequested();
                                    if (reader.FieldCount != 1 || !reader.GetName(0).Equals("Microsoft SQL Server 2005 XML Showplan", StringComparison.Ordinal)
                                        || reader.IsDBNull(0)) throw new RequestException("SQL_ERROR", "SQL Server did not return XML Showplan. No submitted SQL was executed.");
                                    if (plans.Count == MaxDocuments) throw TooLarge();
                                    using var text = reader.GetTextReader(0);
                                    var xml = new StringBuilder();
                                    var buffer = new char[8192];
                                    int count;
                                    while ((count = await text.ReadAsync(buffer.AsMemory(), token)) > 0)
                                    {
                                        characters += count;
                                        if (characters > MaxCharacters) throw TooLarge();
                                        xml.Append(buffer, 0, count);
                                    }
                                    plans.Add(new(xml.ToString(), b + 1, iteration));
                                }
                            } while (await reader.NextResultAsync(CancellationToken.None));
                        }
                        // Cancel before disposing a partially consumed reader: disposal must not drain an oversized XML
                        // document (or any later result sets) after the response budget has already been exceeded.
                        catch { Cancel(command); throw; }
                    }
                    catch (SqlException error) when (!token.IsCancellationRequested)
                    {
                        var line = startLine + batch.Source.StartLine + Math.Max(1, error.LineNumber) - 2;
                        var message = $"Estimated plan, batch {b + 1}, repetition {iteration}, line {line}: {error.Message}";
                        throw new RequestException("SQL_ERROR", message.Length > 16_384 ? message[..16_384] : message);
                    }
                    finally { if (token.IsCancellationRequested) Cancel(command); }
                }
            }
            return new(plans, connection.Database);
        }
        finally
        {
            // Never use the cancelled acquisition token for cleanup. Disposal by the caller ends the physical session
            // even if attention, transport failure or the server prevents OFF from completing.
            if (connection.State == ConnectionState.Open)
            {
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                try { await Run("SET SHOWPLAN_XML OFF", cleanup.Token); }
                catch (Exception error) when (error is SqlException or InvalidOperationException or OperationCanceledException or IOException) { }
            }
        }

        async Task Run(string sql, CancellationToken cancellation)
        {
            await using var command = connection.CreateCommand();
            command.CommandText = sql;
            command.CommandTimeout = 0;
            await command.ExecuteNonQueryAsync(cancellation);
        }
    }

    private static RequestException TooLarge() => new("TOO_LARGE", "Estimated plans are limited to 64 XML documents and 2,097,152 total XML characters. Estimate a smaller selection.");
    private static void Cancel(SqlCommand command)
    {
        try { command.Cancel(); }
        catch (Exception error) when (error is SqlException or InvalidOperationException) { }
    }
}
