using System.Buffers;
using System.Buffers.Text;
using System.Text;
using System.Text.Json;

namespace Varia.Backend.Live;

/// <summary>Where an append table of a probe goes on from: the highest id it has settled.</summary>
internal sealed record LiveCursor(string Probe, int Table, long SettledId);

/// <summary>Resume tokens (docs/ipc.md, Live subscriptions): what a subscription that ended (hidden too long, a backend
/// restart, a reconnect) needs to go on where it was: for each append table, the id it had settled. Opaque to the renderer:
/// base64url of {"v":1,"source":…,"cursors":[[probe,table,id],…]}, at most 256 characters, parsed strictly (any other
/// shape, source, probe or table is INVALID_PARAMS). It carries ids only, never names or values.</summary>
internal static class LiveResume
{
    public const int Version = 1;

    /// <summary>The token for these cursors, or null when it would be longer than <paramref name="maxCharacters"/> (the
    /// subscription then cannot be resumed past them; it starts again from its source's own start).</summary>
    public static string? Encode(string source, IReadOnlyList<LiveCursor> cursors, int maxCharacters)
    {
        var buffer = new ArrayBufferWriter<byte>();
        using (var writer = new Utf8JsonWriter(buffer))
        {
            writer.WriteStartObject();
            writer.WriteNumber("v", Version);
            writer.WriteString("source", source);
            writer.WriteStartArray("cursors");
            foreach (var cursor in cursors.OrderBy(cursor => cursor.Probe, StringComparer.Ordinal).ThenBy(cursor => cursor.Table))
            {
                writer.WriteStartArray();
                writer.WriteStringValue(cursor.Probe);
                writer.WriteNumberValue(cursor.Table);
                writer.WriteNumberValue(cursor.SettledId);
                writer.WriteEndArray();
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
        }
        var token = Base64Url.EncodeToString(buffer.WrittenSpan);
        return token.Length <= maxCharacters ? token : null;
    }

    /// <summary>The cursors of a token for this source's subscription: every probe one it subscribed, every table an append
    /// table of that probe, each named once, every id a safe integer.</summary>
    public static IReadOnlyList<LiveCursor> Parse(string token, string source, IReadOnlyList<LiveProbeJson> probes, int maxCharacters)
    {
        static RequestException Invalid() => new("INVALID_PARAMS", "Invalid resume token.");
        if (token.Length is 0 || token.Length > maxCharacters || !LiveService.IsResumeToken(token)) throw Invalid();
        byte[] bytes;
        try { bytes = Base64Url.DecodeFromChars(token); }
        catch (FormatException) { throw Invalid(); }
        // Canonical only: one token per state, so a token is never two spellings of the same cursors.
        if (Base64Url.EncodeToString(bytes) != token) throw Invalid();
        try
        {
            using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 4 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Select(member => member.Name).Order(StringComparer.Ordinal).SequenceEqual(["cursors", "source", "v"]) is false
                || root.GetProperty("v") is not { ValueKind: JsonValueKind.Number } version || !version.TryGetInt32(out var v) || v != Version
                || root.GetProperty("source").ValueKind != JsonValueKind.String || root.GetProperty("source").GetString() != source
                || root.GetProperty("cursors").ValueKind != JsonValueKind.Array)
                throw Invalid();
            var cursors = new List<LiveCursor>();
            foreach (var item in root.GetProperty("cursors").EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Array || item.GetArrayLength() != 3) throw Invalid();
                var name = item[0].ValueKind == JsonValueKind.String ? item[0].GetString() : null;
                var probe = probes.FirstOrDefault(probe => probe.Id == name);
                if (probe is null || !item[1].TryGetInt32(out var table) || table < 0 || table >= probe.Tables.Count || probe.Tables[table].Mode != "append"
                    || !item[2].TryGetInt64(out var id) || id < 0 || id > (1L << 53) - 1 || cursors.Any(cursor => cursor.Probe == probe.Id && cursor.Table == table))
                    throw Invalid();
                cursors.Add(new(probe.Id, table, id));
            }
            return cursors;
        }
        catch (JsonException) { throw Invalid(); }
        catch (InvalidOperationException) { throw Invalid(); }
        catch (FormatException) { throw Invalid(); }
        catch (KeyNotFoundException) { throw Invalid(); }
    }

    /// <summary>For diagnostics in the checks only: the token's JSON text.</summary>
    internal static string Decode(string token) => Encoding.UTF8.GetString(Base64Url.DecodeFromChars(token));
}
