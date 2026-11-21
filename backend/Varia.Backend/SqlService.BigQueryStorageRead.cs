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

    /// <summary>Batches charged to the budget but not yet stored, at most: a little more than REST's one page.</summary>
    internal const int InFlightBatches = 2;

    /// <summary>A batch a stream read, with the bytes charged for it; or a refusal of the budget, which stops the read.</summary>
    private sealed record ArrowChunk(ReadOnlyMemory<byte> Batch, long Rows, long Charge, TruncationReason Refusal = TruncationReason.None);

    /// <summary>The read session for a result REST would page through, or null to read it through REST: a script (whose
    /// rows are its last statement's), a result smaller than StorageReadMinBytes, Storage Read off, or a fallback, which
    /// Messages names once per connection.</summary>
    private async Task<BigQueryReadSession?> BigQueryStorageSessionAsync(QueryArgs args, BigQueryConnection connection, string project, string jobId, string? location,
        BigQueryColumnPlan plan, BigQueryPage first, QueryMessages messages, CancellationToken token)
    {
        if (!bigQuery.Environment.StorageRead || connection.StorageRefused is not null || first.PageToken is null
            || Environment.TickCount64 < Interlocked.Read(ref connection.StoragePausedUntil)) return null;
        // Storage Read only speeds a result up: a failure deciding on it leaves the result to REST, which reports what it finds.
        try { return await OpenStorageSessionAsync(args, connection, project, jobId, location, plan, first, messages, token); }
        catch (Exception error) when (!token.IsCancellationRequested && error is not OutOfMemoryException) { return null; }
    }

    private async Task<BigQueryReadSession?> OpenStorageSessionAsync(QueryArgs args, BigQueryConnection connection, string project, string jobId, string? location,
        BigQueryColumnPlan plan, BigQueryPage first, QueryMessages messages, CancellationToken token)
    {
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
        catch (Exception error) when (!token.IsCancellationRequested && error is GoogleApiException or TimeoutException or HttpRequestException or IOException) { }
        // BigQuery's size when it reports one, else the first page's JSON per row; only the rows the row limit keeps count.
        var total = first.TotalRows ?? numRows ?? 0;
        var wanted = args.MaxRows > 0 ? Math.Min(total, args.MaxRows) : total;
        var perRow = numBytes is { } size && numRows is > 0 ? (double)size / numRows.Value : first.RowCount > 0 ? (double)first.Bytes / first.RowCount : 0;
        if (perRow * wanted < bigQuery.StorageReadMinBytes) return null;
        var (session, fallback) = await bigQuery.OpenReadSessionAsync(connection, table, plan, GoogleSqlScanner.HasTopLevelOrderBy(args.Sql), token);
        if (fallback is not null)
        {
            if (fallback.Lasting) connection.StorageRefused = fallback.Reason;
            else if (fallback.Reason == "unreachable") Interlocked.Exchange(ref connection.StoragePausedUntil, Environment.TickCount64 + (long)bigQuery.UnreachablePause.TotalMilliseconds);
            if (connection.StorageNotices.TryAdd(fallback.Reason, 0)) messages.Add(fallback.Sentence);
        }
        return session;
    }

    /// <summary>Reads a session's streams into the set until they end or the set stores no more (the row limit, the budget).
    /// Rows not read are counted from BigQuery's total, as REST's reader counts them.</summary>
    private async Task ReadBigQueryArrowAsync(QueryArgs args, BigQueryReadSession session, ResultSetBuffer set, QueryBudget budget, long totalRows, RoomWaited roomWaited,
        QueryEventSink events, Action<string> warn, CancellationToken token,
        BigQueryWindow? window = null, QueryMessages? messages = null)
    {
        using var stop = CancellationTokenSource.CreateLinkedTokenSource(token);
        // Batches charged but not yet stored, whatever the stream count: one being read and one ready. A stream takes a slot
        // before it charges a batch and the reader gives it back after storing it, so waiting streams hold no budget.
        using var slots = new SemaphoreSlim(InFlightBatches);
        var queue = Channel.CreateBounded<ArrowChunk>(new BoundedChannelOptions(InFlightBatches) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
        // A stream's failure ends the queue at once (after the batches already queued), not when the other streams end.
        var producers = session.Streams.Select(stream => Task.Run(async () =>
        {
            try { await ProduceArrowAsync(session, stream, budget, slots, queue.Writer, stop.Token); }
            catch (Exception error) { queue.Writer.TryComplete(error); throw; }
        })).ToArray();
        var finished = Task.WhenAll(producers).ContinueWith(done => queue.Writer.TryComplete(done.Exception?.GetBaseException()), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        long counted = 0;
        long storedRows = 0;
        var storing = true;
        long extra = 0;
        // An Automatic read the budget refused: the set switches to windowed once the read has stopped.
        var switched = false;
        try
        {
            await foreach (var chunk in queue.Reader.ReadAllAsync(stop.Token))
            {
                try
                {
                    if (chunk.Refusal != TruncationReason.None)
                    {
                        if (window is not null && SwitchesOn(set, chunk.Refusal)) { switched = true; break; }
                        set.Skip(chunk.Refusal);
                        budget.Stop(chunk.Refusal);
                        storing = false;
                        break;
                    }
                    using var batch = session.Plan.Decode(chunk.Batch.Span);
                    // A compressed batch decodes into new buffers the chunk's charge does not cover (an uncompressed one is read
                    // in place): they are charged while the batch is stored, and a refusal stops the read as the stream's would.
                    var decoded = ArrowColumnPlan.DecodedBytes(batch);
                    if (decoded > chunk.Batch.Length)
                    {
                        if (!store.TryReserve(budget, decoded, true, out var refusal))
                        {
                            if (window is not null && SwitchesOn(set, refusal)) { switched = true; break; }
                            set.Skip(refusal);
                            budget.Stop(refusal);
                            storing = false;
                            break;
                        }
                        extra = decoded;
                    }
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
                finally
                {
                    store.Return(budget, chunk.Charge + extra);
                    extra = 0;
                    slots.Release();
                }
                events.RowsChanged();
                // The rows so far become readable while the next batch arrives.
                if (set.HasPendingRows)
                {
                    set.Seal();
                    events.Sealed(set);
                }
                // A limit reached on a batch's last row stops here; the rest is counted from BigQuery's total.
                if (storing && args.MaxRows > 0 && storedRows >= args.MaxRows && counted < totalRows) { set.Skip(TruncationReason.RowLimit); storing = false; }
                if (!storing && Switches(set, window)) switched = true;
                if (!storing || switched) break;
            }
            // A stream's failure ends the queue with its error once the batches before it are read.
            if (storing && !switched) await queue.Reader.Completion;
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
        if (switched && SwitchToWindowed(set, window!, events, messages!)) return;
        if (totalRows > counted) set.CountRows(totalRows - counted);
        events.RowsChanged();
    }

    /// <summary>One stream's batches into the queue, each charged first (its message and the decoded copy). A refused charge
    /// ends the read; a transient failure reads the stream again from the rows already queued.</summary>
    private async Task ProduceArrowAsync(BigQueryReadSession session, string stream, QueryBudget budget, SemaphoreSlim slots, ChannelWriter<ArrowChunk> queue, CancellationToken token)
    {
        var client = session.Client;
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
                    await slots.WaitAsync(token);
                    // The slot goes with the chunk to the reader, which gives it back; a chunk never queued gives it back here.
                    if (!store.TryReserve(budget, charge, true, out var refusal))
                    {
                        try { await queue.WriteAsync(new ArrowChunk(default, 0, 0, refusal), token); }
                        catch { slots.Release(); throw; }
                        return;
                    }
                    try { await queue.WriteAsync(new ArrowChunk(bytes, response.RowCount, charge), token); }
                    catch
                    {
                        store.Return(budget, charge);
                        slots.Release();
                        throw;
                    }
                    offset += response.RowCount;
                    attempt = 0;
                }
                return;
            }
            catch (Exception error) when (attempt < bigQuery.ReadAttempts && BigQueryService.TransientRead(error, token))
            {
                await Task.Delay(bigQuery.ReadBackoff(Math.Max(1, attempt)), token);
            }
            catch (Grpc.Core.RpcException error) when (!token.IsCancellationRequested) { throw BigQueryService.ReadFailure(error, session.Project); }
        }
    }
}
