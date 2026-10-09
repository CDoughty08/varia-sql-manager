using System.Buffers;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace Varia.Backend.Protocol;

/// <summary>Transcodes control bodies between MessagePack and System.Text.Json, so request and result records keep their
/// STJ contracts (unknown members rejected) without MessagePack attributes.</summary>
internal static class JsonBridge
{
    public const int MaxDepth = 16;
    public const int MaxMapEntries = 4096;
    public const int MaxArrayLength = 1_048_576;
    public const int MaxKeyBytes = 128;
    private static readonly JsonWriterOptions WriterOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    /// <summary>Decodes a control body (JSON-shaped: string keys, no bin, no duplicate or prototype keys, finite numbers,
    /// strict UTF-8, bounded depth and sizes, fully consumed). Throws only <see cref="ProtocolException"/>.
    /// With <paramref name="sensitive"/> (connect requests) the intermediate JSON is sized never to regrow and is zeroed
    /// afterwards; the returned element's own copy and any managed strings cannot be zeroed.</summary>
    public static JsonElement ParseControl(ReadOnlySpan<byte> body, bool sensitive = false)
    {
        // JSON needs at most 6 bytes per MessagePack byte (a control character becomes \u00XX).
        var buffer = new ArrayBufferWriter<byte>(sensitive ? body.Length * 6 + 1024 : Math.Clamp(body.Length * 2, 256, 1 << 20));
        try
        {
            var reader = new MsgPackReader(body);
            using (var writer = new Utf8JsonWriter(buffer, WriterOptions)) ToJson(ref reader, writer);
            if (reader.Remaining > 0) throw new ProtocolException("TRAILING", reader.Consumed);
            using var document = JsonDocument.Parse(buffer.WrittenMemory);
            return document.RootElement.Clone();
        }
        finally
        {
            if (sensitive) CryptographicOperations.ZeroMemory(MemoryMarshal.AsMemory(buffer.WrittenMemory).Span);
        }
    }

    /// <summary>Transcodes one MessagePack value to JSON under the control limits.</summary>
    public static void ToJson(ref MsgPackReader reader, Utf8JsonWriter writer) => Write(ref reader, writer, 0);

    private static void Write(ref MsgPackReader reader, Utf8JsonWriter writer, int depth)
    {
        var at = reader.Consumed;
        switch (reader.PeekType())
        {
            case MsgPackType.Nil: reader.ReadNil(); writer.WriteNullValue(); return;
            case MsgPackType.Boolean: writer.WriteBooleanValue(reader.ReadBoolean()); return;
            case MsgPackType.Integer: writer.WriteNumberValue(reader.ReadInt64()); return;
            case MsgPackType.Float: writer.WriteNumberValue(reader.ReadDouble()); return;
            case MsgPackType.String: writer.WriteStringValue(reader.ReadStringUtf8()); return;
            case MsgPackType.Binary: throw new ProtocolException("TYPE", at);
            case MsgPackType.Array:
            {
                var count = reader.ReadArrayHeader();
                Open(ref reader, depth, count, MaxArrayLength, 1, at);
                writer.WriteStartArray();
                for (var i = 0u; i < count; i++) Write(ref reader, writer, depth + 1);
                writer.WriteEndArray();
                return;
            }
            default:
            {
                var count = reader.ReadMapHeader();
                Open(ref reader, depth, count, MaxMapEntries, 2, at);
                writer.WriteStartObject();
                var keys = count > 1 ? new HashSet<string>(StringComparer.Ordinal) : null;
                for (var i = 0u; i < count; i++)
                {
                    var keyAt = reader.Consumed;
                    if (reader.PeekByte() is not (>= 0xa0 and <= 0xbf or 0xd9 or 0xda or 0xdb)) throw new ProtocolException("KEY_TYPE", keyAt);
                    var length = reader.ReadStringHeader();
                    if (length > MaxKeyBytes) throw new ProtocolException("KEY_LENGTH", keyAt);
                    var key = reader.ReadUtf8Payload(length, keyAt);
                    var name = Encoding.UTF8.GetString(key);
                    // Rejected here too so both decoders accept exactly the same bodies (tests/fixtures/ipc-vectors.json).
                    if (name is "__proto__" or "constructor" or "prototype") throw new ProtocolException("KEY_FORBIDDEN", keyAt);
                    if (keys is not null && !keys.Add(name)) throw new ProtocolException("KEY_DUPLICATE", keyAt);
                    writer.WritePropertyName(key);
                    Write(ref reader, writer, depth + 1);
                }
                writer.WriteEndObject();
                return;
            }
        }
    }

    private static void Open(ref MsgPackReader reader, int depth, uint count, int limit, int minimumBytes, int at)
    {
        if (depth >= MaxDepth) throw new ProtocolException("DEPTH", at);
        if (count > limit) throw new ProtocolException("LIMIT", at);
        reader.EnsureItems(count, minimumBytes, at);
    }

    /// <summary>Serializes a result with STJ, then transcodes it to a MessagePack control body.</summary>
    public static byte[] Encode<T>(T value, JsonSerializerOptions options)
    {
        var buffer = new ArrayBufferWriter<byte>();
        FromJson(JsonSerializer.SerializeToUtf8Bytes(value, options), new MsgPackWriter(buffer));
        return buffer.WrittenSpan.ToArray();
    }

    /// <summary><paramref name="depth"/> is where the value sits in the body: 1 inside a RESPONSE's { result } wrapper.</summary>
    public static void FromJson(ReadOnlyMemory<byte> utf8, MsgPackWriter writer, int depth = 0)
    {
        using var document = JsonDocument.Parse(utf8);
        FromJson(document.RootElement, writer, depth);
    }

    /// <summary>Integral numbers within ±(2^53 − 1) become integers and other numbers float64, matching the TypeScript
    /// encoder; output that the TypeScript decoder would reject (depth, sizes, long keys) throws instead.</summary>
    public static void FromJson(JsonElement element, MsgPackWriter writer, int depth = 0)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                if (depth >= MaxDepth) throw new InvalidOperationException("The value is nested too deeply for the protocol.");
                var count = 0;
                foreach (var property in element.EnumerateObject())
                    if (++count > MaxMapEntries || Encoding.UTF8.GetByteCount(property.Name) > MaxKeyBytes) throw new InvalidOperationException("The object cannot be encoded for the protocol.");
                writer.WriteMapHeader(count);
                foreach (var property in element.EnumerateObject())
                {
                    writer.WriteString(property.Name);
                    FromJson(property.Value, writer, depth + 1);
                }
                break;
            case JsonValueKind.Array:
                if (depth >= MaxDepth || element.GetArrayLength() > MaxArrayLength) throw new InvalidOperationException("The array cannot be encoded for the protocol.");
                writer.WriteArrayHeader(element.GetArrayLength());
                foreach (var item in element.EnumerateArray()) FromJson(item, writer, depth + 1);
                break;
            case JsonValueKind.String: writer.WriteString(element.GetString()!); break;
            case JsonValueKind.Number:
                if (element.TryGetInt64(out var integer) && integer is >= -MsgPackReader.MaxSafeInteger and <= MsgPackReader.MaxSafeInteger) writer.WriteInt64(integer);
                else writer.WriteNumber(element.GetDouble());
                break;
            case JsonValueKind.True: writer.WriteBoolean(true); break;
            case JsonValueKind.False: writer.WriteBoolean(false); break;
            default: writer.WriteNil(); break;
        }
    }
}
