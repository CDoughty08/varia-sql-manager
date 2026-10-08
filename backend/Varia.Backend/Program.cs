using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.SqlClient;
using Varia.Backend;

Console.InputEncoding = Encoding.UTF8;
Console.OutputEncoding = new UTF8Encoding(false);
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web)
{
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
};
using var service = new SqlService();
// Responses are written as whole UTF-8 lines ending in LF, so the reader never sees a CR split from its LF.
using var stdout = Console.OpenStandardOutput();
using var outputGate = new SemaphoreSlim(1);
using var metadataSlots = new SemaphoreSlim(8);
var work = new ConcurrentDictionary<long, Task>();
long sequence = 0;

async Task Handle(string line)
{
    RpcRequest? request = null;
    string? id = null;
    RpcResponse response;
    var slotTaken = false;
    try
    {
        if (line.Length > 1_100_000) throw new RequestException("INVALID_REQUEST", "Request exceeds the protocol size limit.");
        request = JsonSerializer.Deserialize<RpcRequest>(line, json);
        id = request?.Id;
        if (request is null || !Guid.TryParse(request.Id, out _) || string.IsNullOrWhiteSpace(request.Method))
            throw new RequestException("INVALID_REQUEST", "A request ID and method are required.");
        // Scripts are bounded by the per-tab session limit, and cancellation/cleanup must never wait,
        // so long-running queries cannot starve Object Explorer and connection requests of slots.
        if (request.Method is not ("query.execute" or "query.cancel" or "query.session.close"))
        {
            slotTaken = await metadataSlots.WaitAsync(TimeSpan.FromSeconds(30));
            if (!slotTaken) throw new RequestException("BUSY", "The backend is busy. Retry after a running operation finishes.");
        }
        var result = await service.DispatchAsync(request.Method, request.Params, json);
        response = new RpcResponse(request.Id, result, null);
    }
    // Rejections before the envelope is read still echo its id, so the client can settle the request.
    catch (RequestException ex) { response = new(id ?? PeekId(line), null, new(ex.Code, ex.Message)); }
    catch (JsonException) { response = new(id ?? PeekId(line), null, new("INVALID_REQUEST", "Invalid JSON request or parameters.")); }
    catch (OperationCanceledException) { response = new(id, null, new("CANCELLED", "The operation was cancelled or exceeded its time limit.")); }
    catch (Exception ex) when (Find<SqlException>(ex) is { } sql) { response = new(id, null, new("SQL_ERROR", sql.Message)); }
    // SMO wraps server failures (permissions, missing objects) in its own exception types.
    catch (Exception ex) when (ex.GetType().Namespace?.StartsWith("Microsoft.SqlServer.Management", StringComparison.Ordinal) == true)
    { response = new(id, null, new("SMO_ERROR", ex.GetBaseException().Message)); }
    catch (Exception) { response = new(id, null, new("BACKEND_ERROR", "The backend operation failed. Verify the connection and object permissions.")); }
    finally { if (slotTaken) metadataSlots.Release(); }

    var bytes = JsonSerializer.SerializeToUtf8Bytes(response, json);
    await outputGate.WaitAsync();
    try
    {
        await stdout.WriteAsync(bytes);
        await stdout.WriteAsync("\n"u8.ToArray());
        await stdout.FlushAsync();
    }
    finally { outputGate.Release(); }
}

while (await Console.In.ReadLineAsync() is { } line)
{
    if (string.IsNullOrWhiteSpace(line)) continue;
    var key = Interlocked.Increment(ref sequence);
    var task = Task.Run(() => Handle(line));
    work[key] = task;
    _ = task.ContinueWith(completed => { work.TryRemove(key, out _); }, TaskScheduler.Default);
}
service.CancelAll();
await Task.WhenAll(work.Values);

static string? PeekId(string line)
{
    try
    {
        var reader = new Utf8JsonReader(Encoding.UTF8.GetBytes(line));
        if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject) return null;
        while (reader.Read() && reader.TokenType == JsonTokenType.PropertyName)
        {
            var isId = reader.ValueTextEquals("id");
            if (!reader.Read()) return null;
            if (isId) return reader.TokenType == JsonTokenType.String && Guid.TryParse(reader.GetString(), out _) ? reader.GetString() : null;
            reader.Skip();
        }
    }
    catch (JsonException) { }
    return null;
}

static T? Find<T>(Exception? error) where T : Exception
{
    for (; error is not null; error = error.InnerException) if (error is T match) return match;
    return null;
}
