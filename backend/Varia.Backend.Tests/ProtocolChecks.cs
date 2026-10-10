using System.Buffers;
using System.Text.Json;
using Varia.Backend.Protocol;
using Varia.Backend.Results;

namespace Varia.Backend.Tests;

/// <summary>Offline checks of the MessagePack subset, JsonBridge and framing, against the vectors shared with vitest.</summary>
internal static class ProtocolChecks
{
    private static string Hex(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(bytes);
    private static string Listed(string name, List<string> failures) => failures.Count == 0 ? name : name + ": " + string.Join("; ", failures.Take(10));

    private static byte[] Encode(Action<MsgPackWriter> write)
    {
        var buffer = new ArrayBufferWriter<byte>();
        write(new MsgPackWriter(buffer));
        return buffer.WrittenSpan.ToArray();
    }

    private static string? Code(Action action)
    {
        try { action(); }
        catch (ProtocolException error) { return error.Code; }
        catch (PageFormatException error) { return error.Code; }
        return null;
    }

    /// <summary>JSON equality with numbers compared by value, so 1.0 and 1 are equal, as in JavaScript.</summary>
    internal static bool JsonEquals(JsonElement left, JsonElement right)
    {
        if (left.ValueKind != right.ValueKind) return false;
        switch (left.ValueKind)
        {
            case JsonValueKind.Number: return left.GetDouble() == right.GetDouble();
            case JsonValueKind.String: return left.GetString() == right.GetString();
            case JsonValueKind.Array:
                return left.GetArrayLength() == right.GetArrayLength() && left.EnumerateArray().Zip(right.EnumerateArray()).All(pair => JsonEquals(pair.First, pair.Second));
            case JsonValueKind.Object:
                var properties = right.EnumerateObject().ToDictionary(property => property.Name, property => property.Value, StringComparer.Ordinal);
                return left.EnumerateObject().Count() == properties.Count
                    && left.EnumerateObject().All(property => properties.TryGetValue(property.Name, out var value) && JsonEquals(property.Value, value));
            default: return true;
        }
    }

    public static void Run(Action<bool, string> check)
    {
        using var vectors = JsonDocument.Parse(File.ReadAllText(Fixtures.Path("tests/fixtures/ipc-vectors.json")));
        var root = vectors.RootElement;
        List<string> decoded = [], encoded = [], rejected = [];
        var controls = root.GetProperty("control").EnumerateArray().ToList();
        foreach (var vector in controls)
        {
            var name = vector.GetProperty("name").GetString()!;
            var bytes = Convert.FromHexString(vector.GetProperty("hex").GetString()!);
            if (vector.TryGetProperty("error", out var error))
            {
                var code = Code(() => JsonBridge.ParseControl(bytes));
                if (code != error.GetString()) rejected.Add(name + " gave " + (code ?? "no error"));
                continue;
            }
            JsonElement value;
            try { value = JsonBridge.ParseControl(bytes); }
            catch (ProtocolException exception) { decoded.Add(name + " failed with " + exception.Code); continue; }
            if (!JsonEquals(value, vector.GetProperty("value"))) decoded.Add(name);
            var canonical = vector.TryGetProperty("reencoded", out var reencoded) ? reencoded.GetString() : vector.GetProperty("hex").GetString();
            if (Hex(Encode(writer => JsonBridge.FromJson(value, writer))) != canonical) encoded.Add(name);
        }
        check(decoded.Count == 0, Listed("shared control vectors decode to their values", decoded));
        check(encoded.Count == 0, Listed("decoded control vectors re-encode canonically, byte for byte with TypeScript", encoded));
        check(rejected.Count == 0, Listed("invalid control vectors fail with their shared error codes", rejected));

        List<string> frames = [];
        foreach (var vector in root.GetProperty("frames").EnumerateArray())
        {
            var name = vector.GetProperty("name").GetString()!;
            var bytes = Convert.FromHexString(vector.GetProperty("hex").GetString()!);
            var direction = vector.GetProperty("direction").GetString() == "toBackend" ? FrameDirection.ToBackend : FrameDirection.ToMain;
            Frame? frame = null;
            var code = Code(() => frame = new FrameReader(new MemoryStream(bytes), direction, ProtocolLimits.ResponseBody).Read());
            if (vector.TryGetProperty("error", out var error)) { if (code != error.GetString()) frames.Add(name + " gave " + (code ?? "no error")); continue; }
            var header = frame?.Header;
            if (code is not null || header is null || (int)header.Value.Kind != vector.GetProperty("kind").GetInt32() || header.Value.Id != vector.GetProperty("id").GetUInt32()
                || header.Value.Arg != vector.GetProperty("arg").GetUInt32() || frame!.Value.Body.Length != vector.GetProperty("length").GetInt32() || Hex(frame.Value.Body) != Hex(bytes.AsSpan(16)))
                frames.Add(name);
        }
        check(frames.Count == 0, Listed("shared frame vectors parse, or fail with their codes, in both directions", frames));

        List<string> pages = [];
        foreach (var vector in root.GetProperty("pages").EnumerateArray())
        {
            var name = vector.GetProperty("name").GetString()!;
            var bytes = Convert.FromHexString(vector.GetProperty("hex").GetString()!);
            var wires = vector.GetProperty("wires").EnumerateArray().Select(wire => wire.GetString() == "text" ? WireKind.Text : WireKind.Binary).ToList();
            DecodedPage? page = null;
            var code = Code(() => page = PageReader.Read(bytes, wires));
            if (vector.TryGetProperty("error", out var error)) { if (code != error.GetString()) pages.Add(name + " gave " + (code ?? "no error")); continue; }
            var rows = page?.Rows.Select(row => row.Select(cell => new object?[] { cell.Text, cell.Flags })).ToList();
            if (page is null || page.ResultId != vector.GetProperty("resultId").GetUInt32() || page.FirstRow != vector.GetProperty("firstRow").GetInt64()
                || !JsonEquals(JsonSerializer.SerializeToElement(rows), vector.GetProperty("rows")))
                pages.Add(name);
        }
        check(pages.Count == 0, Listed("shared page vectors decode with the test reader, or fail with their codes", pages));

        check(Hex(Encode(writer => writer.WriteString(new string('x', 65_535))))[..6] == "daffff" && Hex(Encode(writer => writer.WriteString(new string('x', 65_536))))[..10] == "db00010000"
            && Hex(Encode(writer => writer.WriteString("€€€€€€€€€€€")))[..4] == "d921" && Hex(Encode(writer => writer.WriteArrayHeader(65_536))) == "dd00010000"
            && Hex(Encode(writer => writer.WriteBinaryHeader(255))) == "c4ff" && Hex(Encode(writer => writer.WriteBinaryHeader(1, bin32: true))) == "c600000001",
            "the writer uses the smallest str, array and bin headers, sized in UTF-8 bytes");
        check(Hex(Encode(writer => writer.WriteString("a\uD800"))) == "a461efbfbd" && Hex(Encode(writer => writer.WriteNumber(-0.0))) == "00"
            && Hex(Encode(writer => writer.WriteNumber(2.0))) == "02" && Hex(Encode(writer => writer.WriteNumber(9_007_199_254_740_992))) == "cb4340000000000000"
            && Throws<ArgumentOutOfRangeException>(() => Encode(writer => writer.WriteInt64(9_007_199_254_740_992))) && Throws<ArgumentOutOfRangeException>(() => Encode(writer => writer.WriteInt64(-9_007_199_254_740_992))),
            "the writer replaces lone surrogates, writes integral numbers as integers, and refuses integers JavaScript cannot hold");
        check(Code(() => JsonBridge.ParseControl([.. Enumerable.Repeat((byte)0x91, 16), 0x90])) == "DEPTH" && Code(() => JsonBridge.ParseControl([.. Enumerable.Repeat((byte)0x91, 15), 0x90])) is null
            && Code(() => JsonBridge.ParseControl(Convert.FromHexString("82a16101a16102"))) == "KEY_DUPLICATE" && Code(() => JsonBridge.ParseControl(Convert.FromHexString("cb7ff8000000000000"))) == "NUMBER"
            && Code(() => JsonBridge.ParseControl([.. Enumerable.Repeat((byte)0x91, 1_000_000)])) == "DEPTH",
            "JsonBridge rejects duplicate keys, depth 17 (without deep recursion) and NaN");

        // The backend's options (Program.cs).
        var json = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
            UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Disallow
        };
        var options = JsonBridge.ParseControl(JsonBridge.Encode(new { server = "localhost", database = "master", authentication = "sql", username = "sa", password = "secret", trustServerCertificate = true }, json), sensitive: true)
            .Deserialize<ConnectOptions>(json);
        var unknown = Throws<JsonException>(() => JsonBridge.ParseControl(JsonBridge.Encode(new { sessionId = "s", extra = 1 }, json)).Deserialize<SessionArgs>(json));
        check(options is { Server: "localhost", Password: "secret", TrustServerCertificate: true } && unknown, "params transcoded from MessagePack bind to the existing records and keep unknown members rejected");
        var summary = JsonBridge.ParseControl(JsonBridge.Encode(new QueryResult([], 0, ["(1 rows affected)"], 9_007_199_254_740_993, 12, "completed", null, 1, 1, "master", false, new ResultBudget(0, 1, 1)), json));
        check(summary.GetProperty("messages")[0].GetString() == "(1 rows affected)" && summary.GetProperty("recordsAffected").GetDouble() == 9_007_199_254_740_993d
            && !summary.TryGetProperty("error", out _) && summary.GetProperty("database").GetString() == "master",
            "results serialized by System.Text.Json round-trip through MessagePack, with integers beyond 2^53 as float64");

        var oversize = new MemoryStream([.. Frames.Encode(FrameKind.Request, 7, 0, new byte[ProtocolLimits.RequestBody + 1]), .. Frames.Encode(FrameKind.Ping, 0, 42, [])]);
        var reader = new FrameReader(oversize, FrameDirection.ToBackend, ProtocolLimits.RequestBody);
        var skipped = reader.Read();
        var ping = reader.Read();
        check(skipped is { Oversize: true, Header: { Kind: FrameKind.Request, Id: 7, Length: ProtocolLimits.RequestBody + 1 } } && skipped.Value.Body.Length == 0
            && ping is { Oversize: false, Header: { Kind: FrameKind.Ping, Arg: 42 } } && reader.Read() is null,
            "an oversized request body is skipped and reported with its id, and the next frame still parses");
        var stream = new MemoryStream([.. Frames.Encode(FrameKind.Ping, 0, 1, []), 0x56, 0x0a, 0x09, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        reader = new FrameReader(stream, FrameDirection.ToBackend, ProtocolLimits.RequestBody);
        var first = reader.Read();
        var failure = (ProtocolException?)null;
        try { reader.Read(); } catch (ProtocolException error) { failure = error; }
        check(first is { Header.Kind: FrameKind.Ping } && failure is { Code: "BAD_DIRECTION", Offset: 16 }
            && Code(() => new FrameReader(new MemoryStream(Frames.Encode(FrameKind.Request, 1, 0, [0x80])[..17]), FrameDirection.ToBackend, 64).Read()) is null
            && Code(() => new FrameReader(new MemoryStream(Frames.Encode(FrameKind.Request, 1, 0, [0x80, 0x80])[..17]), FrameDirection.ToBackend, 64).Read()) == "TRUNCATED"
            && Code(() => new FrameReader(new MemoryStream(Frames.Encode(FrameKind.Request, 1, 0, new byte[100])[..40]), FrameDirection.ToBackend, 64).Read()) == "TRUNCATED"
            && Throws<ArgumentException>(() => Frames.Encode(FrameKind.Cancel, 1, 1, [1])),
            "the frame reader reports malformed frames with their stream offset and truncation inside a body or a skipped body");

        Fuzz(check, controls.Where(vector => !vector.TryGetProperty("error", out _)).Select(vector => Convert.FromHexString(vector.GetProperty("hex").GetString()!)).ToList(),
            root.GetProperty("frames").EnumerateArray().Select(vector => Convert.FromHexString(vector.GetProperty("hex").GetString()!)).ToList());
    }

    private static bool Throws<T>(Action action) where T : Exception
    {
        try { action(); }
        catch (T) { return true; }
        return false;
    }

    /// <summary>Mutated vectors: only ProtocolException may escape, and decoding allocates at most 4 × input + 64 KiB.</summary>
    private static void Fuzz(Action<bool, string> check, List<byte[]> controls, List<byte[]> frames)
    {
        var seed = int.TryParse(Environment.GetEnvironmentVariable("VARIA_FUZZ_SEED"), out var fixedSeed) ? fixedSeed : Random.Shared.Next();
        var iterations = Math.Max(20_000, int.TryParse(Environment.GetEnvironmentVariable("VARIA_FUZZ_ITERATIONS"), out var requested) ? requested : 0);
        var random = new Random(seed);
        string? escaped = null;
        long worstExcess = 0;
        for (var i = 0; i < iterations && escaped is null; i++)
        {
            var input = Mutate(random, controls[random.Next(controls.Count)]);
            var before = GC.GetAllocatedBytesForCurrentThread();
            try { JsonBridge.ParseControl(input); }
            catch (ProtocolException) { }
            catch (Exception error) { escaped = error.GetType().Name + " from control input " + Convert.ToHexString(input); }
            worstExcess = Math.Max(worstExcess, GC.GetAllocatedBytesForCurrentThread() - before - 4L * input.Length);
            var stream = Mutate(random, frames[random.Next(frames.Count)]);
            try
            {
                var reader = new FrameReader(new MemoryStream(stream), random.Next(2) == 0 ? FrameDirection.ToBackend : FrameDirection.ToMain, 64 * 1024);
                while (reader.Read() is not null) { }
            }
            catch (ProtocolException) { }
            catch (Exception error) { escaped = error.GetType().Name + " from frame input " + Convert.ToHexString(stream); }
        }
        check(escaped is null, "fuzzed control bodies and frame streams throw only ProtocolException (seed " + seed + ")" + (escaped is null ? "" : ": " + escaped));
        check(worstExcess <= 64 * 1024, "fuzzed control decoding allocates at most 4 × input + 64 KiB (seed " + seed + ", worst excess " + worstExcess + " bytes)");
    }

    private static readonly byte[][] Inflated = [[0xdb, 0xff, 0xff, 0xff, 0xff], [0xdd, 0xff, 0xff, 0xff, 0xff], [0xdf, 0xff, 0xff, 0xff, 0xff], [0xc6, 0xff, 0xff, 0xff, 0xff], [0xdd, 0x00, 0x10, 0x00, 0x01]];

    /// <summary>The same mutations as tests/fuzz/prng.ts: bit flips, insertions, deletions, inflated lengths, truncation, nesting.</summary>
    internal static byte[] Mutate(Random random, byte[] input)
    {
        var bytes = input.ToList();
        for (var edits = 1 + random.Next(4); edits > 0; edits--)
        {
            var at = random.Next(bytes.Count + 1);
            switch (random.Next(6))
            {
                case 0: if (bytes.Count > 0) bytes[Math.Min(at, bytes.Count - 1)] ^= (byte)(1 << random.Next(8)); break;
                case 1: bytes.Insert(at, (byte)random.Next(256)); break;
                case 2: bytes.RemoveRange(at, Math.Min(1 + random.Next(4), bytes.Count - at)); break;
                case 3: bytes.InsertRange(at, Inflated[random.Next(Inflated.Length)]); break;
                case 4: bytes.RemoveRange(at, bytes.Count - at); break;
                default: bytes.InsertRange(at, Enumerable.Repeat(new byte[] { 0x91, 0x81, 0xdc, 0xa1 }[random.Next(4)], 1 + random.Next(8))); break;
            }
        }
        return [.. bytes];
    }
}
