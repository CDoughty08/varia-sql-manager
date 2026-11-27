using System.Buffers.Binary;
using System.Data.Common;
using System.Security.Cryptography;

namespace Varia.Backend.Search;

/// <summary>
/// What a SQL Server database's file says beside its unit (<see cref="DatabaseIndex.Sync"/>): the fingerprint
/// (<see cref="ObjectSearchSql.Fingerprint"/>) taken before the read whose content the file holds, and how that read was made.
/// A later fingerprint whose identity differs means another database (re-created, restored over, or another server's of the
/// same name): read whole. One whose identity matches but whose digest differs means something changed: compare the listings
/// (<see cref="SqlListing"/>) and read only what changed. Equal means the saved read still stands. Empty or unparseable bytes
/// (a file saved before fingerprints, or by another version) say nothing: read whole.
/// <code>u8 1 | u8 flags (1 definitions, 2 children) | i32 database_id | i64 create_date ticks | 16 bytes broker GUID | i32 collation checksum | 16 bytes digest</code>
/// </summary>
internal readonly record struct SqlSync(bool Definitions, bool Children, int DatabaseId, long Created, Guid Broker, int Collation, byte[] Digest)
{
    public const byte Version = 1;
    public const int Bytes = 50;
    public const int DigestBytes = 16;

    /// <summary>Whether <paramref name="other"/> is the same database (identity), whatever changed in it.</summary>
    public bool SameDatabase(SqlSync other) => DatabaseId == other.DatabaseId && Created == other.Created && Broker == other.Broker && Collation == other.Collation;

    /// <summary>Whether <paramref name="other"/> is the same database with the same objects, as far as the fingerprint tells.</summary>
    public bool Unchanged(SqlSync other) => SameDatabase(other) && Digest.AsSpan().SequenceEqual(other.Digest);

    public byte[] ToBytes()
    {
        var bytes = new byte[Bytes];
        bytes[0] = Version;
        bytes[1] = (byte)((Definitions ? 1 : 0) | (Children ? 2 : 0));
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(2), DatabaseId);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(6), Created);
        Broker.TryWriteBytes(bytes.AsSpan(14, 16));
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(30), Collation);
        Digest.AsSpan(0, DigestBytes).CopyTo(bytes.AsSpan(34));
        return bytes;
    }

    /// <summary>The sync state a file holds, or null when it holds none this version reads.</summary>
    public static SqlSync? From(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length != Bytes || bytes[0] != Version || (bytes[1] & ~3) != 0) return null;
        return new((bytes[1] & 1) != 0, (bytes[1] & 2) != 0, BinaryPrimitives.ReadInt32LittleEndian(bytes[2..]), BinaryPrimitives.ReadInt64LittleEndian(bytes[6..]),
            new Guid(bytes.Slice(14, 16)), BinaryPrimitives.ReadInt32LittleEndian(bytes[30..]), bytes.Slice(34, DigestBytes).ToArray());
    }
}

/// <summary>A fingerprint row as read (<see cref="ObjectSearchSql.Fingerprint"/>): the database's identity, its compatibility
/// level, and a digest of every count, latest date and checksum after them.</summary>
internal readonly record struct SqlFingerprint(int DatabaseId, long Created, Guid Broker, int Collation, int Compatibility, byte[] Digest)
{
    /// <summary>The aggregate columns after the identity and the compatibility level.</summary>
    public const int Aggregates = 15;

    /// <summary>The sync state a read made after this fingerprint, in this mode, saves.</summary>
    public SqlSync Sync(bool definitions, bool children) => new(definitions, children, DatabaseId, Created, Broker, Collation, Digest);

    /// <summary>A selective re-read names its ids through OPENJSON, which needs compatibility level 130.</summary>
    public bool Selective => Compatibility >= 130;

    /// <summary>Reads the fingerprint's one row, in column order (sequential access); null when there is none.</summary>
    public static async Task<SqlFingerprint?> ReadAsync(DbDataReader reader, CancellationToken token)
    {
        if (!await reader.ReadAsync(token)) return null;
        var id = reader.GetInt32(0);
        var created = reader.GetDateTime(1).Ticks;
        var broker = reader.IsDBNull(2) ? Guid.Empty : reader.GetGuid(2);
        var collation = reader.IsDBNull(3) ? 0 : reader.GetInt32(3);
        var compatibility = reader.IsDBNull(4) ? 0 : Convert.ToInt32(reader.GetValue(4), System.Globalization.CultureInfo.InvariantCulture);
        var values = new object?[Aggregates];
        for (var at = 0; at < Aggregates; at++) values[at] = reader.IsDBNull(5 + at) ? null : reader.GetValue(5 + at);
        while (await reader.ReadAsync(token)) { }
        return new(id, created, broker, collation, compatibility, DigestOf(values));
    }

    /// <summary>A digest of the aggregate values, each written in a fixed form (null, a long, a date's ticks or an int), so it is
    /// the same on every platform, culture and time zone.</summary>
    internal static byte[] DigestOf(IReadOnlyList<object?> values)
    {
        var bytes = new byte[values.Count * 9];
        for (var at = 0; at < values.Count; at++)
        {
            var slot = bytes.AsSpan(at * 9, 9);
            switch (values[at])
            {
                case null: slot[0] = 0; break;
                case long number: slot[0] = 1; BinaryPrimitives.WriteInt64LittleEndian(slot[1..], number); break;
                case int number: slot[0] = 2; BinaryPrimitives.WriteInt64LittleEndian(slot[1..], number); break;
                case DateTime date: slot[0] = 3; BinaryPrimitives.WriteInt64LittleEndian(slot[1..], date.Ticks); break;
                default: throw new InvalidOperationException("A fingerprint column of an unexpected type.");
            }
        }
        return SHA256.HashData(bytes)[..SqlSync.DigestBytes];
    }
}

/// <summary>One indexed sys.objects row as a read saw it: its id, parent (0 for none), date ticks, <see cref="ObjectSearchSql.RowChecksum"/>,
/// and the entry it is in the read's table (-1 where the read kept no entry for it).</summary>
internal readonly record struct SqlListingRow(int Id, int Parent, long Modified, int Checksum, int Entry)
{
    /// <summary>Whether the row is as <paramref name="other"/> was: same date and checksum (the id is the key).</summary>
    public bool Same(SqlListingRow other) => Modified == other.Modified && Checksum == other.Checksum && Parent == other.Parent;
}

/// <summary>
/// A SQL Server read's listing of its sys.objects rows, kept in its file's body (<see cref="DatabaseIndex.Extra"/>): what a
/// later listing is compared with to find what changed, and which entry each saved object is.
/// <code>u8 1 | i32 count | count × (i32 id | i32 parent | i64 date ticks | i32 checksum | i32 entry), by id</code>
/// </summary>
internal static class SqlListing
{
    public const byte Version = 1;
    public const int RowBytes = 24;
    /// <summary>The most rows a listing holds (a file's extra bytes are bounded too, <see cref="IndexFileLimits.ExtraBytes"/>).</summary>
    public const int MostRows = IndexFileLimits.Objects;

    public static long BytesFor(int rows) => 5 + (long)rows * RowBytes;

    /// <summary>The listing's bytes, its rows by id; null when they are too many.</summary>
    public static byte[]? ToBytes(IReadOnlyList<SqlListingRow> rows)
    {
        if (rows.Count > MostRows || BytesFor(rows.Count) > IndexFileLimits.ExtraBytes) return null;
        var sorted = rows.OrderBy(row => row.Id).ToArray();
        var bytes = new byte[BytesFor(sorted.Length)];
        bytes[0] = Version;
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(1), sorted.Length);
        for (var at = 0; at < sorted.Length; at++)
        {
            var slot = bytes.AsSpan(5 + at * RowBytes, RowBytes);
            BinaryPrimitives.WriteInt32LittleEndian(slot, sorted[at].Id);
            BinaryPrimitives.WriteInt32LittleEndian(slot[4..], sorted[at].Parent);
            BinaryPrimitives.WriteInt64LittleEndian(slot[8..], sorted[at].Modified);
            BinaryPrimitives.WriteInt32LittleEndian(slot[16..], sorted[at].Checksum);
            BinaryPrimitives.WriteInt32LittleEndian(slot[20..], sorted[at].Entry);
        }
        return bytes;
    }

    /// <summary>The rows a file's extra bytes hold, by id; null when they are not a listing this version reads, repeat an id, or
    /// name an entry outside a table of <paramref name="entries"/>.</summary>
    public static Dictionary<int, SqlListingRow>? From(ReadOnlySpan<byte> bytes, int entries)
    {
        if (bytes.Length < 5 || bytes[0] != Version) return null;
        var count = BinaryPrimitives.ReadInt32LittleEndian(bytes[1..]);
        if (count < 0 || count > MostRows || bytes.Length != BytesFor(count)) return null;
        var rows = new Dictionary<int, SqlListingRow>(count);
        for (var at = 0; at < count; at++)
        {
            var slot = bytes.Slice(5 + at * RowBytes, RowBytes);
            var row = new SqlListingRow(BinaryPrimitives.ReadInt32LittleEndian(slot), BinaryPrimitives.ReadInt32LittleEndian(slot[4..]), BinaryPrimitives.ReadInt64LittleEndian(slot[8..]),
                BinaryPrimitives.ReadInt32LittleEndian(slot[16..]), BinaryPrimitives.ReadInt32LittleEndian(slot[20..]));
            if (row.Entry < -1 || row.Entry >= entries || !rows.TryAdd(row.Id, row)) return null;
        }
        return rows;
    }
}

/// <summary>
/// What a selective re-read reads and keeps (<see cref="Of"/>): an object changed when it is new, gone, or its date or checksum
/// differs; a changed child (a trigger, key or constraint) changes its parent; each changed top-level object is read again with
/// every child the listing gives it now, and every other saved object is kept as it was.
/// </summary>
internal sealed record SqlReloadPlan(HashSet<int> Units, HashSet<int> Reread, HashSet<int> Current, int Changed)
{
    /// <summary>Whether reading <see cref="Reread"/> costs little enough against a whole read of <paramref name="objects"/>.</summary>
    public bool Worth(int objects) => Reread.Count <= MostReread && Reread.Count <= Math.Max(MinShare, objects / 4);

    /// <summary>The most ids one selective re-read names (its JSON parameter stays a few hundred KB).</summary>
    public const int MostReread = 20_000;
    /// <summary>A database this small is read selectively whatever share of it changed.</summary>
    public const int MinShare = 256;

    /// <summary>Whether the saved object <paramref name="id"/> is kept as it was: the listing still has it, and it is not read again.</summary>
    public bool Keeps(int id) => Current.Contains(id) && !Reread.Contains(id);

    public static SqlReloadPlan Of(IReadOnlyDictionary<int, SqlListingRow> saved, IReadOnlyList<SqlListingRow> current)
    {
        var units = new HashSet<int>();
        var changed = 0;
        void Change(SqlListingRow row) => units.Add(row.Parent != 0 ? row.Parent : row.Id);
        var seen = new HashSet<int>();
        foreach (var row in current)
        {
            seen.Add(row.Id);
            if (saved.TryGetValue(row.Id, out var before) && before.Same(row)) continue;
            changed++;
            Change(row);
            if (saved.TryGetValue(row.Id, out var old)) Change(old);
        }
        foreach (var (id, row) in saved)
            if (!seen.Contains(id)) { changed++; Change(row); }
        var reread = new HashSet<int>(units);
        foreach (var row in current)
            if (row.Parent != 0 && units.Contains(row.Parent)) reread.Add(row.Id);
        return new(units, reread, seen, changed);
    }
}
