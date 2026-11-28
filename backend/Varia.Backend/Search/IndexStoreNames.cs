using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace Varia.Backend.Search;

/// <summary>Bounds on the saved index (objectSearchLimits.store in src/shared/explorer/search.ts).</summary>
internal static class IndexStoreLimits
{
    /// <summary>The disk limit in MiB as Options sets it (objectExplorer.search.diskLimitMiB): its default and bounds.</summary>
    public const int DefaultDiskMiB = 2048;
    public const int MinDiskMiB = 64;
    public const int MaxDiskMiB = 262_144;
    /// <summary>The store's folder as main names it: its longest path, and the only name its last part may have.</summary>
    public const int FolderChars = 2048;
    public const string FolderName = "SearchIndex";
    /// <summary>The key as main sends it: 32 bytes in base64.</summary>
    public const int KeyChars = 44;
    /// <summary>A file nobody saved, loaded or marked used for this long is removed.</summary>
    public const int UnusedDays = 30;
    /// <summary>A temporary file younger than this may be another Varia's save still being written: it is left alone.</summary>
    public static readonly TimeSpan TemporaryGrace = TimeSpan.FromHours(1);
    /// <summary>The longest the store goes, while it saves, without listing its folder again (another Varia may write there too).</summary>
    public static readonly TimeSpan ListEvery = TimeSpan.FromSeconds(60);
    /// <summary>What a read's builder may keep in a file's header beside the store's own (<see cref="DatabaseIndex.Sync"/>).</summary>
    public const int SyncBytes = 1 << 19;
}

/// <summary>
/// Whose units a file holds, as the connection itself established it: never a connection profile's id or anything the user
/// typed. A SQL Server scope is the server as it names itself (SERVERPROPERTY('ServerName'), probed at connect) and the account
/// that signed in (its SID, or an Entra account's tenant and object ids), so two profiles that reach one server as one login
/// share files, and another login (whose metadata visibility is its own) or another server never does. Where a connection's
/// view depends on the database it opened (a contained database user, whose SID is that database's own, and Azure SQL
/// Database, whose catalog a connection sees from one database), the scope also names that database. A BigQuery scope
/// is the verified principal alone, whatever billing project a connection uses. The seed holds those names only in memory; a
/// file's name and header hold keyed hashes of it (<see cref="IndexStoreNames"/>).
/// </summary>
internal sealed class IndexStoreScope
{
    private IndexStoreScope(IndexProvider provider, byte[] seed) => (Provider, Seed) = (provider, seed);

    public IndexProvider Provider { get; }
    internal byte[] Seed { get; }

    /// <summary>The shared resource sets' own scope: a set is the same for every server and login its key matches.</summary>
    internal static IndexStoreScope Resource { get; } = new(IndexProvider.SqlServer, new IndexStoreNames.Canon().Text("resource").Bytes());

    /// <summary>Null when the connect probe could not establish the server's own name or the account (nothing is then saved),
    /// or when the scope is one database's (<paramref name="ownDatabase"/>) and that database is unknown.</summary>
    public static IndexStoreScope? SqlServer(string? server, string? principal, bool ownDatabase = false, string? database = null)
    {
        if (string.IsNullOrWhiteSpace(server) || string.IsNullOrEmpty(principal) || ownDatabase && string.IsNullOrEmpty(database)) return null;
        // The server's name as the live views compare it (SqlService.ServerOf): trimmed, without case.
        return new(IndexProvider.SqlServer, new IndexStoreNames.Canon().Text("sqlserver").Text(server.Trim().ToUpperInvariant()).Text(principal).Text(ownDatabase ? database : null).Bytes());
    }

    /// <summary>Null without a verified principal.</summary>
    public static IndexStoreScope? BigQuery(string? principal) =>
        string.IsNullOrEmpty(principal) ? null : new(IndexProvider.BigQuery, new IndexStoreNames.Canon().Text("bigquery").Text(principal).Bytes());
}

/// <summary>
/// How the store names a unit. Nothing a file is called, and nothing in its header's identity, is a server's, database's,
/// project's, dataset's, login's or principal's name: both are HMAC-SHA256 under a key derived from the store's key
/// (<see cref="NameKey"/>), so a name cannot be guessed from the folder's listing, and two stores (two Varia profiles) name the
/// same unit differently.
/// <code>
/// scope id  = HMAC(name key, "scope" | the scope's seed)
/// unit id   = HMAC(name key, "unit" | scope id | kind | the unit's names)
/// file name = hex(scope id[0..16]) "-" hex(unit id[0..16]) ".vidx"
/// identity  = u8 1 | u8 kind | scope id[32] | unit id[32]          (the header's, sealed with it)
/// sync      = u8 1 | text database | u8 has dataset | (text dataset) | the builder's own bytes
/// </code>
/// The scope's part comes first so one connection's units are found by prefix without opening anyone else's. The unit's own
/// names are in the header's sync state (sealed with the header when the store encrypts), which is how a listing says what
/// each file is without reading its body.
/// </summary>
internal static class IndexStoreNames
{
    public const string Extension = ".vidx";
    private const int TagChars = 32;
    /// <summary>A unit's file name: two tags, a hyphen and the extension.</summary>
    public const int NameChars = TagChars + 1 + TagChars + 5;
    /// <summary>A temporary file's (<see cref="IndexFile.Replace"/>): the unit's name, a dot, 16 hex digits, then .tmp.</summary>
    private const int TemporaryChars = NameChars + 1 + 16 + 4;
    public const int IdentityBytes = 2 + 32 + 32;
    private const byte IdentityVersion = 1, SyncVersion = 1;

    /// <summary>Length-prefixed fields, so no two different lists of values give the same bytes. A text is its UTF-16 code
    /// units: a name may hold an unpaired surrogate, which UTF-8 would fold into another name's bytes.</summary>
    internal sealed class Canon
    {
        private readonly MemoryStream stream = new();

        public Canon Text(string? value)
        {
            Span<byte> length = stackalloc byte[4];
            BinaryPrimitives.WriteInt32LittleEndian(length, value?.Length ?? -1);
            stream.Write(length);
            if (value is null) return this;
            if (BitConverter.IsLittleEndian) stream.Write(MemoryMarshal.AsBytes(value.AsSpan()));
            else
                foreach (var unit in value) { stream.WriteByte((byte)unit); stream.WriteByte((byte)(unit >> 8)); }
            return this;
        }

        public Canon Raw(ReadOnlySpan<byte> value)
        {
            Span<byte> length = stackalloc byte[4];
            BinaryPrimitives.WriteInt32LittleEndian(length, value.Length);
            stream.Write(length);
            stream.Write(value);
            return this;
        }

        public Canon Number(long value)
        {
            Span<byte> bytes = stackalloc byte[8];
            BinaryPrimitives.WriteInt64LittleEndian(bytes, value);
            stream.Write(bytes);
            return this;
        }

        public byte[] Bytes() => stream.ToArray();
    }

    /// <summary>The key names are hashed under: derived from the store's key, so it is no file's encryption key.</summary>
    public static byte[] NameKey(ReadOnlySpan<byte> key)
    {
        var derived = new byte[32];
        HKDF.DeriveKey(HashAlgorithmName.SHA256, key, derived, [], "Varia index store v1 names"u8);
        return derived;
    }

    public static byte[] ScopeId(byte[] nameKey, IndexStoreScope scope) => HMACSHA256.HashData(nameKey, new Canon().Text("scope").Raw(scope.Seed).Bytes());

    /// <summary>A read's unit: a database's, a server's or Agent's by its kind and database, a BigQuery dataset's by its project and name.</summary>
    public static byte[] UnitId(byte[] nameKey, byte[] scopeId, IndexUnitKind kind, string database, string? dataset) =>
        HMACSHA256.HashData(nameKey, new Canon().Text("unit").Raw(scopeId).Number((byte)kind).Text(database).Text(dataset).Bytes());

    /// <summary>The shared resource set's unit: every field of its key.</summary>
    public static byte[] UnitId(byte[] nameKey, byte[] scopeId, ResourceKey key) =>
        HMACSHA256.HashData(nameKey, new Canon().Text("unit").Raw(scopeId).Number((byte)IndexUnitKind.Resource).Text(key.Version).Number(key.Edition).Number(key.Count)
            .Number(key.Latest?.Ticks ?? -1).Number(key.Checksum).Number(key.Definitions ? 1 : 0).Bytes());

    public static string ScopeTag(byte[] scopeId) => Convert.ToHexStringLower(scopeId.AsSpan(0, TagChars / 2));

    public static string FileName(byte[] scopeId, byte[] unitId) => ScopeTag(scopeId) + "-" + Convert.ToHexStringLower(unitId.AsSpan(0, TagChars / 2)) + Extension;

    public static byte[] Identity(IndexUnitKind kind, byte[] scopeId, byte[] unitId)
    {
        var identity = new byte[IdentityBytes];
        identity[0] = IdentityVersion;
        identity[1] = (byte)kind;
        scopeId.CopyTo(identity, 2);
        unitId.CopyTo(identity, 34);
        return identity;
    }

    /// <summary>Whether a header's identity is the one a file of this name holds: a file something renamed or copied over
    /// another's name is not the unit its name says.</summary>
    public static bool Names(ReadOnlySpan<byte> identity, ReadOnlySpan<char> fileName) =>
        identity.Length == IdentityBytes && identity[0] == IdentityVersion && IsUnit(fileName)
        && fileName[..TagChars].SequenceEqual(Convert.ToHexStringLower(identity.Slice(2, TagChars / 2)))
        && fileName.Slice(TagChars + 1, TagChars).SequenceEqual(Convert.ToHexStringLower(identity.Slice(34, TagChars / 2)));

    private static bool Hex(ReadOnlySpan<char> value)
    {
        foreach (var unit in value)
            if (unit is not (>= '0' and <= '9' or >= 'a' and <= 'f')) return false;
        return true;
    }

    /// <summary>Whether a file's name is one the store gives a unit. Everything the store reads, counts or deletes has such a
    /// name (or a temporary file's); any other file in its folder is not its own and is never touched.</summary>
    public static bool IsUnit(ReadOnlySpan<char> name) =>
        name.Length == NameChars && name[TagChars] == '-' && name[(NameChars - Extension.Length)..].SequenceEqual(Extension) && Hex(name[..TagChars]) && Hex(name.Slice(TagChars + 1, TagChars));

    /// <summary>Whether a file's name is that of a unit's save in progress, or of one a crash left behind.</summary>
    public static bool IsTemporary(ReadOnlySpan<char> name) =>
        name.Length == TemporaryChars && IsUnit(name[..NameChars]) && name[NameChars] == '.' && Hex(name.Slice(NameChars + 1, 16))
        && name[(TemporaryChars - IndexFile.TemporaryExtension.Length)..].SequenceEqual(IndexFile.TemporaryExtension);

    /// <summary>The header's sync state as the store writes it: the unit's own names, then the builder's bytes.</summary>
    public static byte[] Sync(string database, string? dataset, ReadOnlySpan<byte> own)
    {
        var bytes = new byte[1 + 2 + 2 * database.Length + 1 + (dataset is null ? 0 : 2 + 2 * dataset.Length) + own.Length];
        var at = 0;
        bytes[at++] = SyncVersion;
        Put(bytes, ref at, database);
        bytes[at++] = dataset is null ? (byte)0 : (byte)1;
        if (dataset is not null) Put(bytes, ref at, dataset);
        own.CopyTo(bytes.AsSpan(at));
        return bytes;

        static void Put(byte[] bytes, ref int at, string text)
        {
            BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(at), (ushort)text.Length);
            at += 2;
            foreach (var unit in text)
            {
                BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(at), unit);
                at += 2;
            }
        }
    }

    /// <summary>Reads a header's sync state back; false for one the store did not write.</summary>
    public static bool TryReadSync(ReadOnlySpan<byte> bytes, out string database, out string? dataset, out byte[] own)
    {
        (database, dataset, own) = ("", null, []);
        var at = 1;
        if (bytes.Length < 4 || bytes[0] != SyncVersion || !Take(bytes, ref at, out database) || at >= bytes.Length || bytes[at] > 1) return false;
        if (bytes[at++] == 1 && !Take(bytes, ref at, out dataset!)) return false;
        own = bytes[at..].ToArray();
        return true;

        static bool Take(ReadOnlySpan<byte> bytes, ref int at, out string text)
        {
            text = "";
            if (bytes.Length - at < 2) return false;
            int chars = BinaryPrimitives.ReadUInt16LittleEndian(bytes[at..]);
            at += 2;
            if (chars > IndexFileLimits.NameChars || bytes.Length - at < 2 * chars) return false;
            var from = bytes.Slice(at, 2 * chars);
            text = string.Create(chars, from.ToArray(), static (span, units) =>
            {
                for (var index = 0; index < span.Length; index++) span[index] = (char)BinaryPrimitives.ReadUInt16LittleEndian(units.AsSpan(2 * index));
            });
            at += 2 * chars;
            return true;
        }
    }
}
