using System.Text.RegularExpressions;
using System.Threading.Channels;
using Google;
using Google.Apis.Bigquery.v2.Data;
using Google.Cloud.BigQuery.Storage.V1;
using Varia.Backend.BigQuery;
using Varia.Backend.Results;

namespace Varia.Backend;

/// <summary>
/// Storage Read into memory (docs/bigquery.md, Storage Read): when a finished query's rows did not all arrive in its first
/// answer and its result is large enough, they are read from the job's destination table through Storage Read (Arrow)
/// into the same result set, budget and limits as REST's, by <see cref="ArrowColumnPlan"/>. Each stream is read on its own
/// task into a bounded queue, its batch charged to the query's budget before it is queued, and one reader appends the
/// batches as they come, so the store keeps one writer. A stream that fails transiently is read again from its offset.
/// </summary>
internal sealed partial class SqlService
{
    [GeneratedRegex(@"^[A-Za-z0-9_\-$]{1,1024}$")]
    private static partial Regex StorageTableId();

    /// <summary>A batch a stream read, with the bytes charged for it; or a refusal of the budget, which stops the read.</summary>
    private sealed record ArrowChunk(ReadOnlyMemory<byte> Batch, long Rows, long Charge, TruncationReason Refusal = TruncationReason.None);

    /// <summary>The read session for a result REST would page through, or null to read it through REST: a script (whose
    /// rows are its last statement's), a result smaller than StorageReadMinBytes, Storage Read off, or a fallback, which
    /// Messages names once per connection.</summary>
    private async Task<BigQueryReadSession?> BigQueryStorageSessionAsync(QueryArgs args, BigQueryConnection connection, string project, string jobId, string? location,
        BigQueryColumnPlan plan, BigQueryPage first, QueryMessages messages, CancellationToken token)
    {
        if (!bigQuery.Environment.StorageRead || connection.StorageRefused is not null || first.PageToken is null) return null;
        var job = await bigQuery.GetJobAsync(connection, project, jobId, location, token);
        if (job.Statistics?.Query?.StatementType is { } statement && statement != "SELECT") return null;
        if (job.Configuration?.Query?.DestinationTable is not { } table || !BigQueryLimits.IsProject(table.ProjectId) || table.DatasetId is not { Length: > 0 and <= BigQueryLimits.Dataset } dataset
            || !BigQueryLimits.DatasetId().IsMatch(dataset) || table.TableId is not { } tableId || !StorageTableId().IsMatch(tableId)) return null;
        long? numBytes = null, numRows = null;
        try
        {
            var details = await bigQuery.TableAsync(connection, table, token);
            numBytes = details.NumBytes is >= 0 ? (long)details.NumBytes.Value : null;
            numRows = details.NumRows is { } rows ? (long)rows : null;
        }
        catch (GoogleApiException) when (!token.IsCancellationRequested) { }
        // BigQuery's size when it reports one, else the first page's JSON per row; only the rows the row limit keeps count.
        var total = first.TotalRows ?? numRows ?? 0;
        var wanted = args.MaxRows > 0 ? Math.Min(total, args.MaxRows) : total;
        var perRow = numBytes is { } size && numRows is > 0 ? (double)size / numRows.Value : first.RowCount > 0 ? (double)first.Bytes / first.RowCount : 0;
        if (perRow * wanted < bigQuery.StorageReadMinBytes) return null;
        var (session, fallback) = await bigQuery.OpenReadSessionAsync(connection, table, plan, GoogleSqlScanner.HasTopLevelOrderBy(args.Sql), token);
        if (fallback is not null)
        {
            if (fallback.Lasting) connection.StorageRefused = fallback.Reason;
            if (connection.StorageNotices.TryAdd(fallback.Reason, 0)) messages.Add(fallback.Sentence);
        }
        return session;
    }

    /// <summary>Reads a session's streams into the set until they end or the set stores no more (the row limit, the budget).
    /// Rows not read are counted from BigQuery's total, as REST's reader counts them.</summary>
    private async Task ReadBigQueryArrowAsync(QueryArgs args, BigQueryReadSession session, ResultSetBuffer set, QueryBudget budget, long totalRows, RoomWaited roomWaited,
        QueryEventSink events, Action<string> warn, CancellationToken token)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        var queue = Channel.CreateBounded<ArrowChunk>(new BoundedChannelOptions(Math.Max(1, session.Streams.Count)) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
        var producers = session.Streams.Select(stream => Task.Run(() => ProduceArrowAsync(session.Client, stream, budget, queue.Writer, stop.Token))).ToArray();
        var finished = Task.WhenAll(producers).ContinueWith(done => queue.Writer.TryComplete(done.Exception?.GetBaseException()), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        long counted = 0;
        long storedRows = 0;
        var storing = true;
        try
        {
            await foreach (var chunk in queue.Reader.ReadAllAsync(stop.Token))
            {
                try
                {
                    if (chunk.Refusal != TruncationReason.None)
                    {
                        set.Skip(chunk.Refusal);
                        budget.Stop(chunk.Refusal);
                        storing = false;
                        break;
                    }
                    using var batch = session.Plan.Decode(chunk.Batch.Span);
                    for (var row = 0; row < batch.Length; row++)
                    {
                        token.ThrowIfCancellationRequested();
                        set.CountRow();
                        counted++;
                        if (!storing) continue;
                        if (args.MaxRows > 0 && storedRows >= args.MaxRows) { set.Skip(TruncationReason.RowLimit); storing = false; continue; }
                        var builder = set.BeginRow();
                        if (builder is null) { storing = false; continue; }
                        int truncatedCells;
                        try { truncatedCells = session.Plan.ReadRow(batch, row, builder, warn); }
                        catch { set.AbortRow(); throw; }
                        var sealedBefore = set.SealedPages;
                        var committed = set.TryCommitRow(truncatedCells, mayWait: true);
                        if (!committed && set.RoomWanted > 0) committed = await WaitAndCommitAsync(store, set, truncatedCells, roomWaited, token);
                        if (committed) storedRows++;
                        else storing = false;
                        if (set.SealedPages != sealedBefore) events.Sealed(set);
                    }
                }
                finally { store.Return(budget, chunk.Charge); }
                events.RowsChanged();
                // The rows so far become readable while the next batch arrives.
                if (set.HasPendingRows)
                {
                    set.Seal();
                    events.Sealed(set);
                }
                // A limit reached on a batch's last row stops here; the rest is counted from BigQuery's total.
                if (storing && args.MaxRows > 0 && storedRows >= args.MaxRows && counted < totalRows) { set.Skip(TruncationReason.RowLimit); storing = false; }
                if (!storing) break;
            }
            // A stream's failure ends the queue with its error once the batches before it are read.
            if (storing) await queue.Reader.Completion;
        }
        finally
        {
            stop.Cancel();
            // A producer's failure has already ended the read (or the read stopped first); only its end is awaited here.
            try { await Task.WhenAll(producers); } catch (Exception) { }
            await finished;
            // Batches queued but never read give their charge back.
            while (queue.Reader.TryRead(out var left)) store.Return(budget, left.Charge);
        }
        if (totalRows > counted) set.CountRows(totalRows - counted);
        events.RowsChanged();
    }

    /// <summary>One stream's batches into the queue, each charged first (its message and the decoded copy). A refused charge
    /// ends the read; a transient failure reads the stream again from the rows already queued.</summary>
    private async Task ProduceArrowAsync(IBigQueryStorageRead client, string stream, QueryBudget budget, ChannelWriter<ArrowChunk> queue, CancellationToken token)
    {
        long offset = 0;
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                await foreach (var response in client.ReadRowsAsync(new ReadRowsRequest { ReadStream = stream, Offset = offset }, token))
                {
                    if (response.ArrowRecordBatch is not { } batch || batch.SerializedRecordBatch.IsEmpty)
                    {
                        if (response.RowCount > 0) throw new InvalidDataException("BigQuery answered rows Varia cannot read.");
                        continue;
                    }
                    var bytes = batch.SerializedRecordBatch.Memory;
                    var charge = 2L * bytes.Length;
                    if (!store.TryReserve(budget, charge, true, out var refusal))
                    {
                        await queue.WriteAsync(new ArrowChunk(default, 0, 0, refusal), token);
                        return;
                    }
                    try { await queue.WriteAsync(new ArrowChunk(bytes, response.RowCount, charge), token); }
                    catch { store.Return(budget, charge); throw; }
                    offset += response.RowCount;
                    attempt = 0;
                }
                return;
            }
            catch (Exception error) when (attempt < bigQuery.ReadAttempts && BigQueryService.TransientRead(error, token))
            {
                await Task.Delay(bigQuery.ReadBackoff(Math.Max(1, attempt)), token);
            }
            catch (Grpc.Core.RpcException error) when (!token.IsCancellationRequested) { throw BigQueryService.ReadFailure(error); }
        }
    }
}
