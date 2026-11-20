using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using Apache.Arrow;
using Apache.Arrow.Ipc;
using Google.Cloud.BigQuery.Storage.V1;
using Google.Protobuf;
using Grpc.Core;
using Varia.Backend.BigQuery;

namespace Varia.Backend.Tests;

/// <summary>
/// The offline Storage Read fake (docs/bigquery.md, Testing): answers CreateReadSession and ReadRows from Arrow record
/// batches built in the checks, serialized as Google sends them (the schema's IPC message in the session, each batch's in
/// a ReadRows response). Batch k goes to stream k mod the session's stream count, so a session of one stream keeps the
/// batches' order. It records every request and fails on demand.
/// </summary>
internal sealed class BigQueryStorageFake(Schema schema, IReadOnlyList<RecordBatch> batches) : IBigQueryStorageRead
{
    public Schema Schema => schema;
    public IReadOnlyList<RecordBatch> Batches => batches;
    public ConcurrentQueue<CreateReadSessionRequest> Sessions { get; } = new();
    public ConcurrentQueue<ReadRowsRequest> Reads { get; } = new();
    /// <summary>Thrown by CreateReadSession, when set.</summary>
    public Func<CreateReadSessionRequest, Exception?>? SessionFault { get; set; }
    /// <summary>Thrown before a ReadRows response (its request and the index of the response in that call), when set.</summary>
    public Func<ReadRowsRequest, int, Exception?>? ReadFault { get; set; }
    /// <summary>Awaited before a ReadRows response (its request and index), when set: a stream that is slow to answer.</summary>
    public Func<ReadRowsRequest, int, CancellationToken, Task>? ReadWait { get; set; }
    /// <summary>How many streams the session answers, whatever was asked (an endpoint that answers more).</summary>
    public int? AnswerStreams { get; set; }
    /// <summary>The most streams a session gets, whatever the request asks.</summary>
    public int MaxStreams { get; set; } = int.MaxValue;
    /// <summary>The schema the session reports, when it should differ from the batches'.</summary>
    public Schema? SessionSchema { get; set; }
    /// <summary>Sends each batch as a whole stream (schema, batch, end), as the emulator does.</summary>
    public bool WholeStreams { get; set; }
    public int Disposed;
    int streams;

    public static byte[] SchemaBytes(Schema schema)
    {
        using var stream = new MemoryStream();
        using (var writer = new ArrowStreamWriter(stream, schema, leaveOpen: true))
        {
            writer.WriteStart();
            writer.WriteEnd();
        }
        // The schema message, without the end-of-stream marker (8 bytes).
        return stream.ToArray()[..^8];
    }

    public static byte[] BatchBytes(RecordBatch batch)
    {
        var schemaLength = SchemaBytes(batch.Schema).Length;
        using var stream = new MemoryStream();
        using (var writer = new ArrowStreamWriter(stream, batch.Schema, leaveOpen: true))
        {
            writer.WriteRecordBatch(batch);
            writer.WriteEnd();
        }
        return stream.ToArray()[schemaLength..^8];
    }

    public static byte[] StreamBytes(RecordBatch batch)
    {
        using var stream = new MemoryStream();
        using (var writer = new ArrowStreamWriter(stream, batch.Schema, leaveOpen: true))
        {
            writer.WriteRecordBatch(batch);
            writer.WriteEnd();
        }
        return stream.ToArray();
    }

    public Task<ReadSession> CreateReadSessionAsync(CreateReadSessionRequest request, CancellationToken token)
    {
        Sessions.Enqueue(request);
        if (SessionFault?.Invoke(request) is { } fault) return Task.FromException<ReadSession>(fault);
        var asked = request.MaxStreamCount <= 0 ? 1000 : request.MaxStreamCount;
        streams = Math.Max(batches.Count == 0 ? 0 : 1, Math.Min(Math.Min(asked, MaxStreams), batches.Count));
        if (AnswerStreams is { } answer) streams = answer;
        var session = new ReadSession
        {
            Name = "projects/varia-emulator/locations/us/sessions/fake", Table = request.ReadSession.Table, DataFormat = DataFormat.Arrow,
            ArrowSchema = new ArrowSchema { SerializedSchema = ByteString.CopyFrom(SchemaBytes(SessionSchema ?? schema)) }
        };
        for (var i = 0; i < streams; i++) session.Streams.Add(new ReadStream { Name = session.Name + "/streams/" + i });
        return Task.FromResult(session);
    }

    public async IAsyncEnumerable<ReadRowsResponse> ReadRowsAsync(ReadRowsRequest request, [EnumeratorCancellation] CancellationToken token)
    {
        Reads.Enqueue(request);
        var index = int.Parse(request.ReadStream[(request.ReadStream.LastIndexOf('/') + 1)..], System.Globalization.CultureInfo.InvariantCulture);
        long skipped = 0;
        var answered = 0;
        for (var k = index; k < batches.Count; k += streams)
        {
            var batch = batches[k];
            if (skipped < request.Offset)
            {
                skipped += batch.Length;
                if (skipped > request.Offset) throw new RpcException(new Status(StatusCode.InvalidArgument, "The offset is inside a batch."));
                continue;
            }
            await Task.Yield();
            if (ReadWait is not null) await ReadWait(request, answered, token);
            token.ThrowIfCancellationRequested();
            if (ReadFault?.Invoke(request, answered) is { } fault) throw fault;
            answered++;
            yield return new ReadRowsResponse
            {
                RowCount = batch.Length,
                ArrowRecordBatch = new ArrowRecordBatch { SerializedRecordBatch = ByteString.CopyFrom(WholeStreams ? StreamBytes(batch) : BatchBytes(batch)) }
            };
        }
    }

    public void Dispose() => Interlocked.Increment(ref Disposed);
}
