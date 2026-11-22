using Google;
using Google.Cloud.BigQuery.Storage.V1;
using Varia.Backend.BigQuery;
using Varia.Backend.Results;

namespace Varia.Backend;

/// <summary>
/// Save Results As of a windowed BigQuery result (docs/bigquery.md, Save): every row its query keeps (Maximum rows honoured,
/// the grid's 32-bit cap not) streams from the job's destination table to <see cref="ResultTextWriter"/>, never through the
/// block cache or the store. Storage Read reads it (one stream after another, one stream when the statement orders its rows,
/// as a load reads it), and free REST tabledata.list pages when Storage Read is off, refused or the result is a script
/// child's (whose order its text cannot tell). Each batch or page becomes pages built for the one write, charged to the
/// result's budget as working memory while they are written, and dropped.
/// </summary>
internal sealed partial class SqlService
{
    /// <summary>Checks only: called before a save of a windowed result reads each batch or page.</summary>
    internal Action? ExportReading { get; set; }

    /// <summary>Rows a Save page holds at most before it is handed to the writer: the pages a batch makes stay small.</summary>
    private const int ExportPageRows = 4096;

    private sealed class BigQueryRemoteRows(SqlService service, BigQueryWindow window, ResultSetBuffer set) : IRemoteRows
    {
        public long Rows => Wanted(window.Args, window.TotalRows);

        public RequestException Failure(Exception error) => service.ReadFailure(error, window.Project);

        public async Task ExportAsync(Func<RemotePage, ValueTask> page, CancellationToken token)
        {
            if (Rows <= 0) return;
            var session = window.Child ? null : await service.ExportSessionAsync(window, token);
            if (session is null) await service.ExportRestAsync(window, set, Rows, page, token);
            else await service.ExportArrowAsync(window, session, set, Rows, page, token);
        }
    }

    /// <summary>The engine's error value for a failure reading a windowed result's rows (a block, a load, a save).</summary>
    private RequestException ReadFailure(Exception error, string project) => error switch
    {
        RequestException request => request,
        RemoteExpiredException => Expired(),
        // The connection closed under the read (its clients disposed), as the REST path says.
        ObjectDisposedException => new RequestException("NOT_CONNECTED", "The connection was closed."),
        _ when NotFound(error) => Expired(),
        Grpc.Core.RpcException { StatusCode: Grpc.Core.StatusCode.NotFound } => Expired(),
        Grpc.Core.RpcException rpc => BigQueryService.ReadFailure(rpc, project),
        _ => BigQueryErrors.Map(error, project) as RequestException
            ?? new RequestException("BACKEND_ERROR", "BigQuery's rows could not be read: " + BigQueryErrors.Sanitize(error.Message))
    };

    /// <summary>A read session for a save, or null to read it through REST: Storage Read off, refused for the connection, or
    /// not opening (the table gone, which REST then reports).</summary>
    private async Task<BigQueryReadSession?> ExportSessionAsync(BigQueryWindow window, CancellationToken token)
    {
        var connection = window.Connection;
        if (!bigQuery.Environment.StorageRead || connection.StorageRefused is not null || Environment.TickCount64 < Interlocked.Read(ref connection.StoragePausedUntil)) return null;
        try
        {
            var (session, _) = await bigQuery.OpenReadSessionAsync(connection, window.Table, window.Plan, GoogleSqlScanner.HasTopLevelOrderBy(window.Args.Sql), token);
            return session;
        }
        catch (Exception error) when (!token.IsCancellationRequested && error is not OutOfMemoryException) { return null; }
    }

    /// <summary>Charges a batch or page's working memory to the result's budget while it is written; TOO_LARGE without room.</summary>
    private static void ReserveExport(ResultSetBuffer set, long bytes)
    {
        if (!set.TryReserveWork(bytes))
            throw new RequestException("TOO_LARGE", "There is not enough result memory to save these rows. Close other results and try again.");
    }

    /// <summary>The table's rows through tabledata.list (free), a page at a time; a rate limit backs off and asks again.</summary>
    private async Task ExportRestAsync(BigQueryWindow window, ResultSetBuffer set, long rows, Func<RemotePage, ValueTask> each, CancellationToken token)
    {
        var plan = window.Plan.Fork();
        string? pageToken = null;
        long written = 0;
        for (var attempt = 1; written < rows;)
        {
            ExportReading?.Invoke();
            BigQueryPage page;
            try { page = await bigQuery.TableRowsAsync(window.Connection, window.Table, pageToken is null ? written : null, (int)Math.Min(rows - written, bigQuery.PageRows), pageToken, token); }
            catch (Exception error) when (!token.IsCancellationRequested && RateLimited(error) && attempt < RateLimitAttempts)
            {
                await Task.Delay(bigQuery.RetryDelay * (1 << Math.Min(attempt - 1, 5)) * (0.5 + Random.Shared.NextDouble()), token);
                attempt++;
                continue;
            }
            catch (ObjectDisposedException) when (!token.IsCancellationRequested) { throw new RequestException("NOT_CONNECTED", "The connection was closed."); }
            catch (Exception error) when (!token.IsCancellationRequested && error is not (RequestException or OperationCanceledException)) { throw ReadFailure(error, window.Project); }
            attempt = 1;
            using (page)
            {
                var count = page.RowCount;
                var charge = 2L * page.Bytes;
                ReserveExport(set, charge);
                try
                {
                    var writer = new RemoteBlockWriter(set.ResultId, set.Wires, written);
                    // A row Varia cannot decode is BigQuery's answer at fault, not the file: never EXPORT_FAILED.
                    try { WriteRows(page, plan, writer, (int)Math.Min(rows - written, int.MaxValue)); }
                    catch (Exception error) when (error is not (RequestException or OperationCanceledException)) { throw Unreadable(); }
                    foreach (var built in writer.Finish()) await each(built);
                    written += writer.Rows;
                }
                finally { set.ReturnWork(charge); }
                pageToken = page.PageToken;
                if (count == 0 || pageToken is null) break;
            }
        }
    }

    /// <summary>The table's rows through Storage Read, one stream after another (their order is the session's: one stream when
    /// the statement orders its rows). A stream whose read fails transiently is read again from its offset; only the stream's
    /// own call is retried, never the writing of its rows (a file write's IOException would otherwise repeat rows).</summary>
    private async Task ExportArrowAsync(BigQueryWindow window, BigQueryReadSession session, ResultSetBuffer set, long rows, Func<RemotePage, ValueTask> each, CancellationToken token)
    {
        long written = 0;
        foreach (var stream in session.Streams)
        {
            long offset = 0;
            var attempt = 1;
            var ended = false;
            while (!ended && written < rows)
            {
                var responses = session.Client.ReadRowsAsync(new ReadRowsRequest { ReadStream = stream, Offset = offset }, token).GetAsyncEnumerator(token);
                try
                {
                    while (written < rows)
                    {
                        ExportReading?.Invoke();
                        bool more;
                        try { more = await responses.MoveNextAsync(); }
                        catch (Exception error) when (attempt < bigQuery.ReadAttempts && BigQueryService.TransientRead(error, token))
                        {
                            await Task.Delay(bigQuery.ReadBackoff(attempt++), token);
                            break;
                        }
                        catch (Exception error) when (!token.IsCancellationRequested && error is not (RequestException or OperationCanceledException)) { throw ReadFailure(error, window.Project); }
                        if (!more) { ended = true; break; }
                        attempt = 1;
                        var response = responses.Current;
                        if (response.ArrowRecordBatch is not { } batch || batch.SerializedRecordBatch.IsEmpty)
                        {
                            if (response.RowCount > 0) throw Unreadable();
                            continue;
                        }
                        written += await WriteBatchAsync(session, set, batch.SerializedRecordBatch.Memory, written, rows - written, each, token);
                        offset += response.RowCount;
                    }
                }
                finally { await responses.DisposeAsync(); }
            }
        }
    }

    private static RequestException Unreadable() => new("BACKEND_ERROR", "BigQuery answered rows Varia cannot read.");

    /// <summary>Writes one Arrow batch's rows (at most <paramref name="left"/>) as pages from row <paramref name="first"/>,
    /// charged while they are built; answers the rows written.</summary>
    private static async Task<long> WriteBatchAsync(BigQueryReadSession session, ResultSetBuffer set, ReadOnlyMemory<byte> bytes, long first, long left, Func<RemotePage, ValueTask> each, CancellationToken token)
    {
        var charge = 2L * bytes.Length;
        ReserveExport(set, charge);
        long extra = 0;
        try
        {
            Apache.Arrow.RecordBatch decoded;
            try { decoded = session.Plan.Decode(bytes.Span); }
            catch (Exception error) when (error is InvalidDataException or ArgumentException or IndexOutOfRangeException) { throw Unreadable(); }
            using (decoded)
            {
                var more = ArrowColumnPlan.DecodedBytes(decoded);
                if (more > bytes.Length)
                {
                    ReserveExport(set, more);
                    extra = more;
                }
                var writer = new RemoteBlockWriter(set.ResultId, set.Wires, first);
                for (var row = 0; row < decoded.Length && writer.Rows < left; row++)
                {
                    token.ThrowIfCancellationRequested();
                    WriteArrowRow(session, decoded, row, writer);
                    if (writer.Rows % ExportPageRows == 0) foreach (var built in writer.TakeSealed()) await each(built);
                }
                foreach (var built in writer.Finish()) await each(built);
                return writer.Rows;
            }
        }
        finally { set.ReturnWork(charge + extra); }
    }

    private static void WriteArrowRow(BigQueryReadSession session, Apache.Arrow.RecordBatch batch, int row, RemoteBlockWriter writer)
    {
        var builder = writer.BeginRow();
        try { session.Plan.ReadRow(batch, row, builder, NoWarning); }
        catch (Exception error) when (error is not (RequestException or OperationCanceledException)) { writer.AbortRow(); throw Unreadable(); }
        catch { writer.AbortRow(); throw; }
        writer.CommitRow();
    }
}
