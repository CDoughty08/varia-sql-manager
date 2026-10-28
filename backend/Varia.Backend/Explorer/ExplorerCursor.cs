using System.Buffers.Binary;

namespace Varia.Backend.Explorer;

/// <summary>How a listing pages: by name, by (schema, name), by an ordinal such as column_id, or by a bigint id (an SSIS
/// package's package_id, since package names can exceed sysname).</summary>
internal enum Keyset { Name, SchemaName, Ordinal, Id }

/// <summary>The last row a page emitted; the next page starts after it.</summary>
internal readonly record struct CursorKey(string? K1, string? K2, int? Kn, long? Kb = null);

/// <summary>Opaque page cursors: <c>v1.&lt;queryId&gt;.&lt;base64url payload&gt;</c>. The payload holds the keys as UTF-16 code
/// units, so any sysname round-trips exactly (lone surrogates included) within 687 characters. Keys only ever become
/// parameters, so a forged cursor can at most skip rows.</summary>
internal static class ExplorerCursor
{
    public const int MaxLength = 1650;
    private const byte OneName = 1, TwoNames = 2, Ordinal = 3, Id = 4;

    public static string Encode(string queryId, CursorKey key)
    {
        var bytes = new List<byte>();
        if (key.Kb is { } id)
        {
            bytes.Add(Id);
            var buffer = new byte[8];
            BinaryPrimitives.WriteInt64LittleEndian(buffer, id);
            bytes.AddRange(buffer);
        }
        else if (key.Kn is { } ordinal)
        {
            bytes.Add(Ordinal);
            var buffer = new byte[4];
            BinaryPrimitives.WriteInt32LittleEndian(buffer, ordinal);
            bytes.AddRange(buffer);
        }
        else
        {
            bytes.Add(key.K2 is null ? OneName : TwoNames);
            Name(bytes, key.K1!);
            if (key.K2 is not null) Name(bytes, key.K2);
        }
        return "v1." + queryId + "." + Convert.ToBase64String([.. bytes]).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static void Name(List<byte> bytes, string name)
    {
        if (name.Length is < 1 or > ExplorerRefs.MaxIdentifier) throw new InvalidOperationException("A keyset name must be 1 to 128 characters.");
        bytes.Add((byte)name.Length);
        foreach (var unit in name) { bytes.Add((byte)unit); bytes.Add((byte)(unit >> 8)); }
    }

    /// <summary>Checks the version, query id, alphabet, length, payload shape and ranges; any failure is INVALID_PARAMS.</summary>
    public static CursorKey Parse(string cursor, string queryId, Keyset keyset)
    {
        var invalid = new RequestException("INVALID_PARAMS", "Invalid Object Explorer request: cursor.");
        var prefix = "v1." + queryId + ".";
        if (cursor.Length > MaxLength || !cursor.StartsWith(prefix, StringComparison.Ordinal)) throw invalid;
        var text = cursor[prefix.Length..];
        if (text.Length is 0 or > 1600 || text.Length % 4 == 1 || text.Any(c => !(c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '-' or '_'))) throw invalid;
        byte[] bytes;
        try { bytes = Convert.FromBase64String(text.Replace('-', '+').Replace('_', '/') + new string('=', (4 - text.Length % 4) % 4)); }
        catch (FormatException) { throw invalid; }
        var at = 1;
        string? ReadName()
        {
            if (at >= bytes.Length) return null;
            var length = bytes[at++];
            if (length is < 1 or > ExplorerRefs.MaxIdentifier || at + length * 2 > bytes.Length) return null;
            var chars = new char[length];
            for (var i = 0; i < length; i++) chars[i] = (char)(bytes[at + 2 * i] | bytes[at + 2 * i + 1] << 8);
            at += length * 2;
            return new string(chars);
        }
        if (bytes.Length == 0) throw invalid;
        CursorKey? key = null;
        if (bytes[0] == Ordinal && keyset == Keyset.Ordinal && bytes.Length == 5)
        {
            var ordinal = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(1));
            if (ordinal >= 0) key = new CursorKey(null, null, ordinal);
            at = 5;
        }
        else if (bytes[0] == Id && keyset == Keyset.Id && bytes.Length == 9)
        {
            var id = BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(1));
            if (id >= 0) key = new CursorKey(null, null, null, id);
            at = 9;
        }
        else if (bytes[0] == OneName && keyset == Keyset.Name && ReadName() is { } name) key = new CursorKey(name, null, null);
        else if (bytes[0] == TwoNames && keyset == Keyset.SchemaName && ReadName() is { } schema && ReadName() is { } second) key = new CursorKey(schema, second, null);
        if (key is null || at != bytes.Length) throw invalid;
        return key.Value;
    }
}
