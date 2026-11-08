using System.Data;
using System.Text;
using Microsoft.Data.SqlClient;

namespace Varia.Backend.Plans;

internal sealed record EstimatedPlanArgs(string ConnectionId, string SessionId, string RequestId, string Database, string Sql, int StartLine = 1, string Mode = "isolated");
internal sealed record EstimatedPlanXml(string Xml, int BatchNumber, int Iteration);
internal sealed record EstimatedPlanSession(int Spid, string? Login);
internal sealed record EstimatedPlanResult(List<EstimatedPlanXml> Plans, string Database, EstimatedPlanSession? Session = null);

internal sealed class EstimatedPlanCleanupException(Exception inner) : Exception("Estimated plan capture cleanup failed.", inner);

/// <summary>The caller owns the physical connection, or holds the query session gate until cleanup completes.
/// A borrowed session must be closed if cleanup cannot be confirmed.</summary>
internal static class EstimatedPlanCapture
{
    internal const int MaxDocuments = 64;
    internal const int MaxCharacters = 2_097_152;
    internal static readonly TimeSpan Budget = TimeSpan.FromSeconds(30);

    public static async Task<EstimatedPlanResult> ReadAsync(SqlConnection connection, List<EstimatedPlanScript.Batch> batches, int startLine, CancellationToken token,
        string? sessionDatabase = null, Func<string, Exception?>? fault = null)
    {
        var plans = new List<EstimatedPlanXml>();
        var characters = 0;
        var originalDatabase = connection.Database;
        // Do not reset any existing capture/NOEXEC/PARSEONLY/FMTONLY state. A constant SELECT must really execute before
        // we can safely take over SHOWPLAN. It does not open an implicit transaction or inspect user data.
        (int Options, int TextSize)? options = sessionDatabase is null ? null : await Options(token);
        if (sessionDatabase is null) await Run(SqlService.SessionPrologue, token);
        try
        {
            // SHOWPLAN is nvarchar(max), so the user's TEXTSIZE would otherwise silently truncate XML on the server.
            if (options is not null) await Run("SET TEXTSIZE 2147483647", token);
            if (sessionDatabase is not null && connection.Database != sessionDatabase)
                await connection.ChangeDatabaseAsync(sessionDatabase, token);
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
                        // Attention also interrupts the reader's tokenless result transitions and provider reads.
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
                        if (sessionDatabase is not null && SqlService.IsSessionLost(error, connection.State)) throw;
                        var line = startLine + batch.Source.StartLine + Math.Max(1, error.LineNumber) - 2;
                        var message = $"Estimated plan, batch {b + 1}, repetition {iteration}, line {line}: {error.Message}";
                        throw new RequestException("SQL_ERROR", message.Length > 16_384 ? message[..16_384] : message);
                    }
                    finally { if (token.IsCancellationRequested) Cancel(command); }
                }
            }
            token.ThrowIfCancellationRequested();
            return new(plans, connection.Database);
        }
        finally
        {
            // Never use the cancelled acquisition token for cleanup. A borrowed connection can be reused only after OFF,
            // an executing sentinel, and context restoration succeed. Failed cleanup must win over any acquisition error.
            if (connection.State == ConnectionState.Open)
            {
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                try
                {
                    await Run("SET SHOWPLAN_XML OFF", cleanup.Token);
                    if (options is { } prior)
                    {
                        await Options(cleanup.Token);
                        await Run("SET QUOTED_IDENTIFIER " + ((prior.Options & 256) != 0 ? "ON" : "OFF") + "; SET TEXTSIZE "
                            + prior.TextSize.ToString(System.Globalization.CultureInfo.InvariantCulture), cleanup.Token);
                        if (connection.Database != originalDatabase) await connection.ChangeDatabaseAsync(originalDatabase, cleanup.Token);
                    }
                }
                catch (Exception error)
                { if (sessionDatabase is not null) throw new EstimatedPlanCleanupException(error); }
            }
            else if (sessionDatabase is not null) throw new EstimatedPlanCleanupException(new IOException("The SQL connection closed during estimation."));
        }

        async Task<(int Options, int TextSize)> Options(CancellationToken cancellation)
        {
            const string sql = "SELECT @@OPTIONS AS [__varia_estimate_options], @@TEXTSIZE;";
            if (fault?.Invoke(sql) is { } error) throw error;
            await using var command = connection.CreateCommand();
            command.CommandText = sql;
            command.CommandTimeout = 0;
            await using var reader = await command.ExecuteReaderAsync(cancellation);
            if (reader.FieldCount == 2 && reader.GetName(0) == "__varia_estimate_options" && reader.GetFieldType(0) == typeof(int) && reader.GetFieldType(1) == typeof(int)
                && await reader.ReadAsync(cancellation)) return (reader.GetInt32(0), reader.GetInt32(1));
            throw new RequestException("SQL_ERROR", "The query session's capture, NOEXEC, PARSEONLY or FMTONLY options prevent session-aware estimation. Turn them off explicitly, or use an isolated estimate. Existing capture options were left unchanged.");
        }

        async Task Run(string sql, CancellationToken cancellation)
        {
            if (fault?.Invoke(sql) is { } error) throw error;
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
