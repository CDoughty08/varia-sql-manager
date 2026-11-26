using Google.Api.Gax.Grpc;
using Google.Apis.Bigquery.v2.Data;
using Google.Cloud.BigQuery.Storage.V1;
using Grpc.Core;

namespace Varia.Backend.BigQuery;

/// <summary>An open read session over a query's destination table: its streams, and the plan that decodes their batches.</summary>
internal sealed record BigQueryReadSession(IBigQueryStorageRead Client, IReadOnlyList<string> Streams, ArrowColumnPlan Plan, bool Ordered, string Project);

/// <summary>Why a result is read through REST rather than Storage Read, with the sentence Messages gives once per connection.
/// <see cref="Lasting"/> reasons hold for the connection, which then stops asking.</summary>
internal sealed record BigQueryStorageFallback(string Reason, string Sentence, bool Lasting);

/// <summary>
/// Storage Read (docs/bigquery.md, Storage Read): a read session over a finished query's destination table, in Arrow,
/// with one stream when the statement orders its rows at the top level (GoogleSqlScanner) and up to
/// <see cref="MaxStreams"/> otherwise. Reads of a query's temporary result table are free (Google's pricing page), so no
/// setting keeps reads on REST. REST (tabledata through jobs.getQueryResults) reads a result instead when it arrived
/// whole in the first answer, when it is smaller than <see cref="StorageReadMinBytes"/> (a session costs more than it
/// saves), or when the project has the API off, the principal may not create read sessions, or the endpoint cannot be
/// reached.
/// </summary>
internal sealed partial class BigQueryService
{
    /// <summary>Results under about 20 MB are read through REST: a read session costs more than it saves. The checks lower it.</summary>
    internal long StorageReadMinBytes { get; set; } = 20_000_000;
    /// <summary>The most streams one result is read with, appended as they come.</summary>
    internal const int MaxStreams = 4;
    /// <summary>Read sessions opened, for the checks to tell which reader read a result.</summary>
    internal int StorageSessions;
    /// <summary>How many times creating a session is tried before reading through REST.</summary>
    internal int SessionAttempts { get; set; } = 2;
    /// <summary>How long a connection reads through REST after the Storage API could not be reached, so each large result
    /// does not wait for it again.</summary>
    internal TimeSpan UnreachablePause { get; set; } = TimeSpan.FromMinutes(10);

    /// <summary>tables.get (free): a destination table's size and row count.</summary>
    internal Task<Table> TableAsync(BigQueryConnection connection, TableReference table, CancellationToken token) =>
        ReadAsync(t => connection.Client.Service.Tables.Get(table.ProjectId, table.DatasetId, table.TableId).ExecuteAsync(t), token);

    /// <summary>
    /// Opens a read session on <paramref name="table"/> for <paramref name="plan"/>'s columns (the first 4,096 when the
    /// schema has more), billed to the connection's project. Answers the fallback instead when Storage Read cannot read it.
    /// </summary>
    internal async Task<(BigQueryReadSession? Session, BigQueryStorageFallback? Fallback)> OpenReadSessionAsync(BigQueryConnection connection, TableReference table,
        BigQueryColumnPlan plan, bool ordered, CancellationToken token)
    {
        var project = connection.Options.Project;
        var request = new CreateReadSessionRequest
        {
            Parent = "projects/" + project,
            ReadSession = new ReadSession
            {
                Table = "projects/" + table.ProjectId + "/datasets/" + table.DatasetId + "/tables/" + table.TableId,
                DataFormat = DataFormat.Arrow
            },
            MaxStreamCount = StreamCount(environment, ordered)
        };
        // Zstandard buffers: a fifth to two fifths of the bytes for little CPU (docs/bigquery.md, Throughput). The reader reads
        // uncompressed batches too, which an endpoint that ignores the option sends.
        request.ReadSession.ReadOptions = new ReadSession.Types.TableReadOptions
        {
            ArrowSerializationOptions = new ArrowSerializationOptions { BufferCompression = ArrowSerializationOptions.Types.CompressionCodec.Zstd }
        };
        if (plan.TruncatedColumns) request.ReadSession.ReadOptions.SelectedFields.AddRange(plan.Fields.Select(field => field.Name));
        var client = connection.Storage(environment.StorageClient);
        ReadSession session;
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                session = await CallAsync(t => client.CreateReadSessionAsync(request, t), token);
                break;
            }
            catch (Exception error) when (!token.IsCancellationRequested && Fallback(error, project) is { } fallback)
            {
                if (fallback.Reason != "unreachable" || attempt >= SessionAttempts) return (null, fallback);
                await Task.Delay(Backoff(attempt), token);
            }
        }
        var arrow = ArrowColumnPlan.From(plan, session.ArrowSchema?.SerializedSchema.Memory ?? ReadOnlyMemory<byte>.Empty);
        if (arrow is null) return (null, Refused(project));
        Interlocked.Increment(ref StorageSessions);
        // Never more streams than asked for (each is a task and a queue slot): an endpoint that answers more is refused, since
        // reading only some of its streams would lose rows.
        var streams = session.Streams.Select(stream => stream.Name).ToList();
        if (streams.Count == 0 || streams.Count > request.MaxStreamCount) return (null, Refused(project));
        return (new BigQueryReadSession(client, streams, arrow, ordered, project), null);
    }

    /// <summary>The streams a session asks for: one keeps a top-level ORDER BY's order; the emulator serves only one.</summary>
    internal static int StreamCount(BigQueryEnvironment environment, bool ordered) =>
        ordered || (environment.Emulator && environment.Storage is null) ? 1 : MaxStreams;

    const string Slower = "Large results are read through the BigQuery API, which is slower: ";

    /// <summary>The fallback for a failed CreateReadSession; null for a failure that is not about Storage Read.</summary>
    internal static BigQueryStorageFallback? Fallback(Exception error, string project)
    {
        if (error is TimeoutException or HttpRequestException or IOException) return Unreachable();
        // Anything else (a disconnect's disposed client, say) leaves the result to REST, which reports what it finds.
        if (error is not RpcException rpc) return error is OperationCanceledException ? null : Refused(project);
        // A sign-in failure is not about Storage Read: REST reads the result and reports it.
        if (SignIn(rpc) is not null || rpc.StatusCode == StatusCode.Unauthenticated) return null;
        var detail = rpc.Status.Detail ?? "";
        if (rpc.StatusCode == StatusCode.PermissionDenied && Perimeter(rpc, out var identifier))
            return new("perimeter", Slower + "VPC Service Controls blocked the BigQuery Storage API from this network or account. " + BigQueryErrors.PerimeterAdvice(identifier), true);
        return rpc.StatusCode switch
        {
            StatusCode.PermissionDenied when detail.Contains("SERVICE_DISABLED", StringComparison.Ordinal) || detail.Contains("has not been used", StringComparison.Ordinal)
                || detail.Contains("is disabled", StringComparison.Ordinal) || Disabled(rpc)
                => new("disabled", Slower + "the BigQuery Storage API is not enabled in project " + project + ". Enabling it there lets Varia read them faster.", true),
            StatusCode.PermissionDenied
                => new("permission", Slower + "the account may not create read sessions in project " + project
                    + " (bigquery.readsessions.create, which the BigQuery Read Session User role grants).", true),
            StatusCode.Unavailable or StatusCode.DeadlineExceeded or StatusCode.Internal or StatusCode.Unknown => Unreachable(),
            // Called only while the query runs: a call the library cancelled at its own limit, as an endpoint it never reached.
            StatusCode.Cancelled => Unreachable(),
            _ => Refused(project)
        };
    }

    /// <summary>Google's ErrorInfo reason in the status details, when the trailers carry it.</summary>
    static bool Disabled(RpcException rpc)
    {
        try
        {
            var status = rpc.GetRpcStatus();
            return status?.Details.Any(detail => detail.TryUnpack<Google.Rpc.ErrorInfo>(out var info) && info.Reason == "SERVICE_DISABLED") == true;
        }
        catch (Exception error) when (error is Google.Protobuf.InvalidProtocolBufferException or InvalidOperationException) { return false; }
    }

    /// <summary>Whether a refused RPC is VPC Service Controls' (docs/bigquery.md, Errors): its message, or an ErrorInfo detail
    /// in its trailers, read as REST's error body is.</summary>
    internal static bool Perimeter(RpcException rpc, out string? identifier)
    {
        string? raw = null;
        try
        {
            if (rpc.GetRpcStatus() is { } status)
                raw = string.Join(' ', status.Details.Select(detail => detail.TryUnpack<Google.Rpc.ErrorInfo>(out var info) ? Google.Protobuf.JsonFormatter.Default.Format(info) : null).Where(text => text is not null));
        }
        catch (Exception error) when (error is Google.Protobuf.InvalidProtocolBufferException or InvalidOperationException) { }
        return BigQueryErrors.IsPerimeter(rpc.Status.Detail, raw, out identifier);
    }

    static BigQueryStorageFallback Unreachable() =>
        new("unreachable", Slower + "Varia could not reach the BigQuery Storage API (bigquerystorage.googleapis.com, over HTTP/2). A proxy or firewall may block it.", false);

    static BigQueryStorageFallback Refused(string project) =>
        new("refused", Slower + "the BigQuery Storage API could not read this result in project " + project + ".", false);

    /// <summary>A ReadRows failure after which the stream is read again from its offset.</summary>
    internal static bool TransientRead(Exception error, CancellationToken token) => !token.IsCancellationRequested && error switch
    {
        RpcException rpc => SignIn(rpc) is null
            && rpc.StatusCode is StatusCode.Unavailable or StatusCode.Internal or StatusCode.Unknown or StatusCode.ResourceExhausted or StatusCode.DeadlineExceeded,
        _ => error is TimeoutException or HttpRequestException or IOException
    };

    /// <summary>A sign-in failure behind an RPC's status: the channel refreshes the connection's token itself, and a refused
    /// refresh reaches Varia only as the status's debug exception (with status Internal), which REST's mapping reads.</summary>
    internal static RequestException? SignIn(RpcException rpc) =>
        rpc.Status.DebugException is { } cause && BigQueryErrors.Map(cause) is RequestException { Code: "AUTH_EXPIRED" or "AUTH_KEY_FILE" or "AUTH_IDENTITY" } mapped ? mapped : null;

    /// <summary>The error value for a stream that failed past its retries, as REST would report it: a sign-in, the network,
    /// a refused permission, or Google's refusal in its words.</summary>
    internal static RequestException ReadFailure(RpcException error, string project) => SignIn(error) ?? error.StatusCode switch
    {
        StatusCode.Unavailable or StatusCode.DeadlineExceeded => new RequestException("CONNECTION_LOST", BigQueryErrors.Unreachable),
        StatusCode.Unauthenticated => new RequestException("AUTH_EXPIRED", BigQueryErrors.Expired),
        StatusCode.PermissionDenied when Perimeter(error, out var identifier) => BigQueryErrors.Perimeter(identifier),
        StatusCode.PermissionDenied => new RequestException("PERMISSION_DENIED", "The account may not read this result through the BigQuery Storage API in project " + project + "."),
        _ => new RequestException("BACKEND_ERROR", "Reading the result through the BigQuery Storage API failed: " + BigQueryErrors.Sanitize(error.Status.Detail is { Length: > 0 } detail ? detail : error.StatusCode.ToString()))
    };

    /// <summary>The backoff before reading a stream again.</summary>
    internal TimeSpan ReadBackoff(int attempt) => Backoff(attempt);
}
