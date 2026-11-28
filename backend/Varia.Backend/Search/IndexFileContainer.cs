using System.Buffers.Binary;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace Varia.Backend.Search;

/// <summary>Why a unit was not saved or not loaded (<see cref="IndexFile"/>): a value, never an exception, and never a name, a
/// path or any of the file's content.</summary>
internal enum IndexFileProblem
{
    None,
    /// <summary>The caller's token stopped it.</summary>
    Cancelled,
    /// <summary>The file could not be read or written (missing, locked, the disk full).</summary>
    Io,
    /// <summary>The bytes do not start as an index file does.</summary>
    NotIndexFile,
    /// <summary>Written by another version of the format, older or newer: this reader takes only its own.</summary>
    Version,
    /// <summary>Encrypted where the caller gave no key, or clear text where it gave one: never read as the other.</summary>
    Mode,
    /// <summary>The header does not open with the caller's key: another key, or a header that was changed.</summary>
    Key,
    /// <summary>The file ends before its last chunk.</summary>
    Truncated,
    /// <summary>A check failed: a chunk that is not this file's at this place, or content that breaks a rule the index relies on.</summary>
    Corrupt,
    /// <summary>Larger than <see cref="IndexFileLimits"/> allows.</summary>
    Limits,
    /// <summary>Another kind of unit than the caller asked for.</summary>
    Kind,
    /// <summary>Another identity than the caller gave.</summary>
    Identity,
    /// <summary>It does not fit in the index's memory; everything the load took is given back.</summary>
    Budget,
    /// <summary>The unit holds something the format cannot carry, so nothing was written.</summary>
    Unsupported
}

/// <summary>What one file holds.</summary>
internal enum IndexUnitKind : byte
{
    /// <summary>A SQL Server database's read.</summary>
    Database = 1,
    /// <summary>A server's own objects.</summary>
    Server = 2,
    /// <summary>SQL Server Agent's objects.</summary>
    Agent = 3,
    /// <summary>A BigQuery dataset's read.</summary>
    Dataset = 4,
    /// <summary>The resource database's objects, shared by fingerprint.</summary>
    Resource = 5
}

internal enum IndexProvider : byte
{
    SqlServer = 1,
    BigQuery = 2
}

/// <summary>A file's header: what a store reads of each file without reading its body. Identity and Sync are the caller's own
/// bytes: the identity is given again to load the file and must match, the sync state comes back with the load.
/// Objects and MemoryBytes are what the unit held when it was saved (its entries, and its share of the index's budget).</summary>
internal sealed record IndexFileHeader(ushort Version, bool Encrypted, IndexUnitKind Kind, IndexProvider Provider, DateTime ReadAt, bool Definitions, bool Children,
    int Objects, long MemoryBytes, byte[] Identity, byte[] Sync);

/// <summary>A refusal on its way to the boundary (<see cref="IndexFile"/>), which answers it as a value.</summary>
internal sealed class IndexFileRefused(IndexFileProblem problem) : Exception
{
    public IndexFileProblem Problem => problem;
}

/// <summary>
/// The layers of an index file below its content (<see cref="IndexFileUnit"/>). All integers are little-endian.
/// <code>
/// prefix (52 bytes, clear):  "VARIAIDX" | u16 version | u8 mode (0 clear text, 1 AES-256-GCM) | u8 0 | u32 chunk bytes |
///                            u32 header bytes | salt[32]
/// header (sealed):           u8 kind | u8 provider | u8 flags (1 definitions, 2 children) | u8 0 | i64 read at (UTC ticks) |
///                            i32 objects | i64 memory bytes | u16 n, identity[n] | i32 n, sync[n]
///                            then its tag: 16 bytes (GCM), or SHA-256(prefix | header) in clear text
/// body:                      chunks, each u32 n | u8 last | data[n] | tag[16]; every chunk but the last is full
/// </code>
/// Encrypted, a file has keys of its own: HKDF-SHA256 of the caller's key and the file's random salt gives one key for the
/// header (used once, with a zero nonce, the prefix as associated data) and one for the body, whose chunk nonce is the chunk's
/// index and whether it is the last, with SHA-256(prefix | sealed header) as associated data. A nonce so never repeats under a
/// key: within a file the index counts up, and no two files share a key unless their 256-bit salts collide. A chunk moved,
/// dropped, repeated or taken from another file fails its tag, as does a file cut short (its last chunk says it is the last).
/// In clear text each tag is a SHA-256 over the same things instead: it catches damage, not a forger, so the content's own
/// checks must stand alone. Inside the chunks the body is a run of blocks, each u8 codec (0 stored, 1 zstd) | u32 raw bytes |
/// (zstd: u32 stored bytes) | bytes, so what is already compressed (a <see cref="PackedText"/> frame) is stored as it is.
/// A zstd block that packs better than <see cref="MaxRatio"/> to one is followed by padding up to that ratio, so a file never
/// unpacks to more than that many times its size, and a packed definition's frame is padded by the same rule
/// (<see cref="IndexFileUnit"/>), which bounds the work a file can make a load do by the file's own size
/// (<see cref="PayloadReader.Backed"/>). What a load keeps or allocates is bounded by the budget, not by this.
/// </summary>
internal static class IndexFileContainer
{
    public const ushort Version = 2;
    public static ReadOnlySpan<byte> Magic => "VARIAIDX"u8;
    public const byte ClearMode = 0, SealedMode = 1;
    public const int KeyBytes = 32, SaltBytes = 32, TagBytes = 16, ClearHeaderTagBytes = 32;
    public const int PrefixBytes = 8 + 2 + 1 + 1 + 4 + 4 + SaltBytes;
    /// <summary>A chunk's plain bytes: what one buffer holds however large the file.</summary>
    public const int ChunkBytes = 1 << 18;
    /// <summary>A block's raw bytes: what is compressed, and unpacked, at once.</summary>
    public const int BlockBytes = 1 << 20;
    /// <summary>The most a block unpacks to for each byte it takes in the file. Real content stays far below it (names and
    /// entries pack a few times over); only runs of one repeated value reach it, and they pay a sixty-fourth of their size.</summary>
    public const int MaxRatio = 64;
    private const int ChunkHeadBytes = 5;
    /// <summary>The header without the caller's identity and sync state.</summary>
    public const int FixedHeaderBytes = 4 + 8 + 4 + 8 + 2 + 4;
    public const int MaxHeaderBytes = FixedHeaderBytes + IndexFileLimits.IdentityBytes + IndexFileLimits.SyncBytes;
    /// <summary>zstd's level for the blocks: its default, as <see cref="PackedText"/> packs.</summary>
    private const int Level = 3;

    public static IndexFileRefused Refused(IndexFileProblem problem) => new(problem);

    /// <summary>The padding after a zstd block, or a packed definition's frame, of <paramref name="raw"/> bytes stored in
    /// <paramref name="stored"/>.</summary>
    public static int Padding(uint raw, uint stored) => (int)Math.Max(0, (raw + MaxRatio - 1) / MaxRatio - (long)stored);

    /// <summary>Room for <paramref name="bytes"/> in <paramref name="buffer"/>, keeping what it holds: buffers start small and
    /// grow to their fixed size only for a file that needs it, since most units are a few KiB.</summary>
    private static void Grow(ref byte[] buffer, int bytes, int most)
    {
        if (buffer.Length >= bytes) return;
        Array.Resize(ref buffer, (int)Math.Min(most, Math.Max(bytes, Math.Max(4096L, 2L * buffer.Length))));
    }

    /// <summary>A file's keys and what binds its chunks to its header. Clear text has no keys: its tags are hashes.</summary>
    internal sealed class Seal : IDisposable
    {
        private readonly AesGcm? header, body;
        private readonly IncrementalHash? hash;
        private readonly byte[] digest = new byte[SHA256.HashSizeInBytes];

        public Seal(ReadOnlySpan<byte> key, ReadOnlySpan<byte> salt)
        {
            if (key.IsEmpty)
            {
                hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                return;
            }
            Span<byte> derived = stackalloc byte[KeyBytes];
            HKDF.DeriveKey(HashAlgorithmName.SHA256, key, derived, salt, "Varia index file v1 header"u8);
            header = new AesGcm(derived, TagBytes);
            HKDF.DeriveKey(HashAlgorithmName.SHA256, key, derived, salt, "Varia index file v1 body"u8);
            body = new AesGcm(derived, TagBytes);
            CryptographicOperations.ZeroMemory(derived);
        }

        public bool Encrypted => body is not null;
        public int HeaderTagBytes => Encrypted ? TagBytes : ClearHeaderTagBytes;

        /// <summary>Seals the header (once per file: its key has no other use) and binds the chunks to it.</summary>
        public void SealHeader(ReadOnlySpan<byte> prefix, ReadOnlySpan<byte> plain, Span<byte> sealedHeader)
        {
            if (header is not null)
            {
                Span<byte> nonce = stackalloc byte[12];
                nonce.Clear();
                header.Encrypt(nonce, plain, sealedHeader[..plain.Length], sealedHeader[plain.Length..], prefix);
            }
            else
            {
                plain.CopyTo(sealedHeader);
                hash!.AppendData(prefix);
                hash.AppendData(plain);
                hash.GetHashAndReset(sealedHeader[plain.Length..]);
            }
            Bind(prefix, sealedHeader);
        }

        /// <summary>Opens the header; false when its tag does not hold (another key, or a changed header).</summary>
        public bool OpenHeader(ReadOnlySpan<byte> prefix, ReadOnlySpan<byte> sealedHeader, Span<byte> plain)
        {
            if (header is not null)
            {
                Span<byte> nonce = stackalloc byte[12];
                nonce.Clear();
                try { header.Decrypt(nonce, sealedHeader[..plain.Length], sealedHeader[plain.Length..], plain, prefix); }
                catch (CryptographicException) { return false; }
            }
            else
            {
                Span<byte> expected = stackalloc byte[ClearHeaderTagBytes];
                hash!.AppendData(prefix);
                hash.AppendData(sealedHeader[..plain.Length]);
                hash.GetHashAndReset(expected);
                if (!CryptographicOperations.FixedTimeEquals(expected, sealedHeader[plain.Length..])) return false;
                sealedHeader[..plain.Length].CopyTo(plain);
            }
            Bind(prefix, sealedHeader);
            return true;
        }

        private void Bind(ReadOnlySpan<byte> prefix, ReadOnlySpan<byte> sealedHeader)
        {
            using var bound = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            bound.AppendData(prefix);
            bound.AppendData(sealedHeader);
            bound.GetHashAndReset(digest);
        }

        /// <summary>A chunk's place: its index, then whether it is the last. The body key's nonce, and part of a clear tag.</summary>
        private static void Place(Span<byte> place, long index, bool last)
        {
            place.Clear();
            BinaryPrimitives.WriteInt64LittleEndian(place, index);
            place[8] = last ? (byte)1 : (byte)0;
        }

        public void SealChunk(long index, bool last, ReadOnlySpan<byte> plain, Span<byte> stored, Span<byte> tag)
        {
            Span<byte> place = stackalloc byte[12];
            Place(place, index, last);
            if (body is not null)
            {
                body.Encrypt(place, plain, stored, tag, digest);
                return;
            }
            plain.CopyTo(stored);
            ClearTag(place, plain, tag);
        }

        public bool OpenChunk(long index, bool last, ReadOnlySpan<byte> stored, ReadOnlySpan<byte> tag, Span<byte> plain)
        {
            Span<byte> place = stackalloc byte[12];
            Place(place, index, last);
            if (body is not null)
            {
                try { body.Decrypt(place, stored, tag, plain, digest); }
                catch (CryptographicException) { return false; }
                return true;
            }
            Span<byte> expected = stackalloc byte[TagBytes];
            ClearTag(place, stored, expected);
            if (!CryptographicOperations.FixedTimeEquals(expected, tag)) return false;
            stored.CopyTo(plain);
            return true;
        }

        private void ClearTag(ReadOnlySpan<byte> place, ReadOnlySpan<byte> data, Span<byte> tag)
        {
            Span<byte> full = stackalloc byte[SHA256.HashSizeInBytes];
            hash!.AppendData(digest);
            hash.AppendData(place);
            hash.AppendData(data);
            hash.GetHashAndReset(full);
            full[..TagBytes].CopyTo(tag);
        }

        public void Dispose()
        {
            header?.Dispose();
            body?.Dispose();
            hash?.Dispose();
        }
    }

    /// <summary>Writes the prefix and the sealed header, under a salt made here: every file written has keys of its own.</summary>
    public static (Seal Seal, long Bytes) WriteHeader(Stream stream, IndexFileHeader header, ReadOnlySpan<byte> key)
    {
        if (header.Identity.Length > IndexFileLimits.IdentityBytes || header.Sync.Length > IndexFileLimits.SyncBytes) throw Refused(IndexFileProblem.Limits);
        var plain = new byte[FixedHeaderBytes + header.Identity.Length + header.Sync.Length];
        plain[0] = (byte)header.Kind;
        plain[1] = (byte)header.Provider;
        plain[2] = (byte)((header.Definitions ? 1 : 0) | (header.Children ? 2 : 0));
        BinaryPrimitives.WriteInt64LittleEndian(plain.AsSpan(4), header.ReadAt.Ticks);
        BinaryPrimitives.WriteInt32LittleEndian(plain.AsSpan(12), header.Objects);
        BinaryPrimitives.WriteInt64LittleEndian(plain.AsSpan(16), header.MemoryBytes);
        BinaryPrimitives.WriteUInt16LittleEndian(plain.AsSpan(24), (ushort)header.Identity.Length);
        header.Identity.CopyTo(plain.AsSpan(26));
        BinaryPrimitives.WriteInt32LittleEndian(plain.AsSpan(26 + header.Identity.Length), header.Sync.Length);
        header.Sync.CopyTo(plain.AsSpan(30 + header.Identity.Length));

        Span<byte> prefix = stackalloc byte[PrefixBytes];
        prefix.Clear();
        Magic.CopyTo(prefix);
        BinaryPrimitives.WriteUInt16LittleEndian(prefix[8..], Version);
        prefix[10] = key.IsEmpty ? ClearMode : SealedMode;
        BinaryPrimitives.WriteUInt32LittleEndian(prefix[12..], ChunkBytes);
        BinaryPrimitives.WriteUInt32LittleEndian(prefix[16..], (uint)plain.Length);
        RandomNumberGenerator.Fill(prefix[20..]);
        var seal = new Seal(key, prefix[20..]);
        try
        {
            var sealedHeader = new byte[plain.Length + seal.HeaderTagBytes];
            seal.SealHeader(prefix, plain, sealedHeader);
            stream.Write(prefix);
            stream.Write(sealedHeader);
            return (seal, PrefixBytes + sealedHeader.Length);
        }
        catch
        {
            seal.Dispose();
            throw;
        }
    }

    /// <summary>Reads and checks the prefix and the header, leaving the stream at the body. Reads nothing past the header.</summary>
    public static (IndexFileHeader Header, Seal Seal, long Bytes) ReadHeader(Stream stream, ReadOnlySpan<byte> key)
    {
        Span<byte> prefix = stackalloc byte[PrefixBytes];
        var got = stream.ReadAtLeast(prefix, PrefixBytes, throwOnEndOfStream: false);
        var magic = Math.Min(got, Magic.Length);
        if (!prefix[..magic].SequenceEqual(Magic[..magic])) throw Refused(IndexFileProblem.NotIndexFile);
        if (got < PrefixBytes) throw Refused(IndexFileProblem.Truncated);
        // The version comes first: another version may lay out everything after it differently.
        if (BinaryPrimitives.ReadUInt16LittleEndian(prefix[8..]) != Version) throw Refused(IndexFileProblem.Version);
        var mode = prefix[10];
        if (mode > SealedMode || prefix[11] != 0 || BinaryPrimitives.ReadUInt32LittleEndian(prefix[12..]) != ChunkBytes) throw Refused(IndexFileProblem.Corrupt);
        if (mode == SealedMode == key.IsEmpty) throw Refused(IndexFileProblem.Mode);
        var length = BinaryPrimitives.ReadUInt32LittleEndian(prefix[16..]);
        if (length < FixedHeaderBytes || length > MaxHeaderBytes) throw Refused(IndexFileProblem.Corrupt);
        var seal = new Seal(key, prefix[20..]);
        try
        {
            var sealedHeader = new byte[(int)length + seal.HeaderTagBytes];
            if (stream.ReadAtLeast(sealedHeader, sealedHeader.Length, throwOnEndOfStream: false) < sealedHeader.Length) throw Refused(IndexFileProblem.Truncated);
            var plain = new byte[(int)length];
            if (!seal.OpenHeader(prefix, sealedHeader, plain)) throw Refused(seal.Encrypted ? IndexFileProblem.Key : IndexFileProblem.Corrupt);
            // A file past the format's size is refused here, not after the limit's worth of chunks is read.
            if (stream.CanSeek && stream.Length > IndexFileLimits.FileBytes) throw Refused(IndexFileProblem.Limits);
            return (ParseHeader(plain, seal.Encrypted), seal, PrefixBytes + sealedHeader.Length);
        }
        catch
        {
            seal.Dispose();
            throw;
        }
    }

    private static IndexFileHeader ParseHeader(ReadOnlySpan<byte> plain, bool encrypted)
    {
        var kind = plain[0];
        var provider = plain[1];
        var flags = plain[2];
        var ticks = BinaryPrimitives.ReadInt64LittleEndian(plain[4..]);
        var objects = BinaryPrimitives.ReadInt32LittleEndian(plain[12..]);
        var memory = BinaryPrimitives.ReadInt64LittleEndian(plain[16..]);
        int identity = BinaryPrimitives.ReadUInt16LittleEndian(plain[24..]);
        if (kind is < (byte)IndexUnitKind.Database or > (byte)IndexUnitKind.Resource || provider is < (byte)IndexProvider.SqlServer or > (byte)IndexProvider.BigQuery
            || flags > 3 || plain[3] != 0 || ticks < 0 || ticks > DateTime.MaxValue.Ticks || objects < 0 || memory < 0
            || identity > IndexFileLimits.IdentityBytes || plain.Length < FixedHeaderBytes + identity) throw Refused(IndexFileProblem.Corrupt);
        var sync = BinaryPrimitives.ReadInt32LittleEndian(plain[(26 + identity)..]);
        if (sync < 0 || sync > IndexFileLimits.SyncBytes || plain.Length != FixedHeaderBytes + identity + sync) throw Refused(IndexFileProblem.Corrupt);
        return new(Version, encrypted, (IndexUnitKind)kind, (IndexProvider)provider, new DateTime(ticks, DateTimeKind.Utc), (flags & 1) != 0, (flags & 2) != 0, objects, memory,
            plain.Slice(26, identity).ToArray(), plain.Slice(30 + identity, sync).ToArray());
    }

    /// <summary>Cuts the body into chunks and seals each. A full buffer is written only once more follows, so the last chunk,
    /// which <see cref="Finish"/> writes, is the only one that may be short (or empty).</summary>
    internal sealed class ChunkWriter(Stream stream, Seal seal, long headerBytes, CancellationToken token)
    {
        private byte[] plain = [];
        private byte[] record = [];
        private int used;
        private long index;
        private long written = headerBytes;

        public void Write(ReadOnlySpan<byte> data)
        {
            while (!data.IsEmpty)
            {
                if (used == ChunkBytes) Emit(false);
                var take = Math.Min(data.Length, ChunkBytes - used);
                Grow(ref plain, used + take, ChunkBytes);
                data[..take].CopyTo(plain.AsSpan(used));
                used += take;
                data = data[take..];
            }
        }

        public void Finish() => Emit(true);

        private void Emit(bool last)
        {
            token.ThrowIfCancellationRequested();
            Grow(ref record, ChunkHeadBytes + used + TagBytes, ChunkHeadBytes + ChunkBytes + TagBytes);
            BinaryPrimitives.WriteUInt32LittleEndian(record, (uint)used);
            record[4] = last ? (byte)1 : (byte)0;
            seal.SealChunk(index++, last, plain.AsSpan(0, used), record.AsSpan(ChunkHeadBytes, used), record.AsSpan(ChunkHeadBytes + used, TagBytes));
            var size = ChunkHeadBytes + used + TagBytes;
            written += size;
            if (written > IndexFileLimits.FileBytes) throw Refused(IndexFileProblem.Limits);
            stream.Write(record, 0, size);
            used = 0;
        }
    }

    /// <summary>Reads the body chunk by chunk, each checked before a byte of it is handed on: its length against the fixed chunk
    /// size, its tag against its place. Nothing may follow the last chunk.</summary>
    internal sealed class ChunkReader(Stream stream, Seal seal, long headerBytes, CancellationToken token)
    {
        private byte[] plain = [];
        private byte[] record = [];
        private int at, length;
        private long index;
        private long read = headerBytes;
        private bool ended;
        // What the stream had left when the body began; a stream that cannot say is taken to hold the largest file.
        private readonly long body = stream.CanSeek ? Math.Max(0, stream.Length - stream.Position) : IndexFileLimits.FileBytes;
        private long consumed;

        /// <summary>The body's bytes not yet handed on: what is left of this chunk, and of the file.</summary>
        public long Unread => length - at + (ended ? 0 : Math.Max(0, body - consumed));

        public void Check() => token.ThrowIfCancellationRequested();

        /// <summary>Up to <paramref name="destination"/>'s length of the body; 0 once the last chunk is read.</summary>
        public int Read(Span<byte> destination)
        {
            while (at == length)
                if (!Refill()) return 0;
            var take = Math.Min(destination.Length, length - at);
            plain.AsSpan(at, take).CopyTo(destination);
            at += take;
            return take;
        }

        private bool Refill()
        {
            if (ended) return false;
            token.ThrowIfCancellationRequested();
            Span<byte> head = stackalloc byte[ChunkHeadBytes];
            if (stream.ReadAtLeast(head, ChunkHeadBytes, throwOnEndOfStream: false) < ChunkHeadBytes) throw Refused(IndexFileProblem.Truncated);
            var size = BinaryPrimitives.ReadUInt32LittleEndian(head);
            var last = head[4];
            if (last > 1 || size > ChunkBytes || last == 0 && size != ChunkBytes) throw Refused(IndexFileProblem.Corrupt);
            Grow(ref record, (int)size + TagBytes, ChunkBytes + TagBytes);
            Grow(ref plain, (int)size, ChunkBytes);
            var stored = record.AsSpan(0, (int)size + TagBytes);
            if (stream.ReadAtLeast(stored, stored.Length, throwOnEndOfStream: false) < stored.Length) throw Refused(IndexFileProblem.Truncated);
            read += ChunkHeadBytes + stored.Length;
            consumed += ChunkHeadBytes + stored.Length;
            if (read > IndexFileLimits.FileBytes) throw Refused(IndexFileProblem.Limits);
            if (!seal.OpenChunk(index++, last == 1, stored[..(int)size], stored[(int)size..], plain.AsSpan(0, (int)size))) throw Refused(IndexFileProblem.Corrupt);
            (at, length) = (0, (int)size);
            if (last == 1)
            {
                ended = true;
                if (stream.ReadByte() >= 0) throw Refused(IndexFileProblem.Corrupt);
            }
            return true;
        }
    }

    /// <summary>The body's content as the unit writes it: values into blocks, each compressed when that makes it smaller, and
    /// bytes that are compressed already (<see cref="AsIs"/>) as they are.</summary>
    internal sealed class PayloadWriter(ChunkWriter chunks)
    {
        private static readonly int MostPacked = (int)ZstandardEncoder.GetMaxCompressedLength(BlockBytes);
        private static readonly byte[] Zeros = new byte[BlockBytes / MaxRatio];
        private byte[] block = [];
        private byte[] packed = [];
        private int used;
        private bool asIs;

        public void Bytes(ReadOnlySpan<byte> data)
        {
            while (!data.IsEmpty)
            {
                if (used == BlockBytes) Flush();
                var take = Math.Min(data.Length, BlockBytes - used);
                Grow(ref block, used + take, BlockBytes);
                data[..take].CopyTo(block.AsSpan(used));
                used += take;
                data = data[take..];
            }
        }

        /// <summary>Whether what follows is written as it is, in stored blocks: bytes no compressor would shrink (packed
        /// definitions' frames), not put through zstd again.</summary>
        public void AsIs(bool on)
        {
            if (on == asIs) return;
            Flush();
            asIs = on;
        }

        private void Flush()
        {
            if (used == 0) return;
            Span<byte> head = stackalloc byte[9];
            BinaryPrimitives.WriteUInt32LittleEndian(head[1..], (uint)used);
            var size = 0;
            if (!asIs)
            {
                Grow(ref packed, (int)ZstandardEncoder.GetMaxCompressedLength(used), MostPacked);
                if (!ZstandardEncoder.TryCompress(block.AsSpan(0, used), packed, out size, Level, 0) || size >= used) size = 0;
            }
            if (size > 0)
            {
                head[0] = 1;
                BinaryPrimitives.WriteUInt32LittleEndian(head[5..], (uint)size);
                chunks.Write(head);
                chunks.Write(packed.AsSpan(0, size));
                chunks.Write(Zeros.AsSpan(0, Padding((uint)used, (uint)size)));
            }
            else
            {
                head[0] = 0;
                chunks.Write(head[..5]);
                chunks.Write(block.AsSpan(0, used));
            }
            used = 0;
        }

        public void Finish()
        {
            Flush();
            chunks.Finish();
        }

        private Span<byte> Room(int bytes)
        {
            if (BlockBytes - used < bytes) Flush();
            Grow(ref block, used + bytes, BlockBytes);
            var room = block.AsSpan(used, bytes);
            used += bytes;
            return room;
        }

        public void Byte(byte value) => Room(1)[0] = value;
        public void UInt16(ushort value) => BinaryPrimitives.WriteUInt16LittleEndian(Room(2), value);
        public void Int32(int value) => BinaryPrimitives.WriteInt32LittleEndian(Room(4), value);
        public void Int64(long value) => BinaryPrimitives.WriteInt64LittleEndian(Room(8), value);

        public void Int32s(ReadOnlySpan<int> values)
        {
            if (BitConverter.IsLittleEndian) Bytes(MemoryMarshal.AsBytes(values));
            else foreach (var value in values) Int32(value);
        }

        public void Int16s(ReadOnlySpan<short> values)
        {
            if (BitConverter.IsLittleEndian) Bytes(MemoryMarshal.AsBytes(values));
            else foreach (var value in values) UInt16((ushort)value);
        }

        public void UInt16s(ReadOnlySpan<ushort> values)
        {
            if (BitConverter.IsLittleEndian) Bytes(MemoryMarshal.AsBytes(values));
            else foreach (var value in values) UInt16(value);
        }

        /// <summary>A text: its length in UTF-16 code units, then the units. Not UTF-8: a name or a definition may hold an
        /// unpaired surrogate, which must come back as it was.</summary>
        public void Text(string value)
        {
            Int32(value.Length);
            if (BitConverter.IsLittleEndian) Bytes(MemoryMarshal.AsBytes(value.AsSpan()));
            else foreach (var unit in value) UInt16(unit);
        }
    }

    /// <summary>Reads the body's content back. A block is unpacked into a buffer of at most the fixed block size, so no length a file
    /// states makes it allocate more than that; a value that runs past the content's end is a refusal.</summary>
    internal sealed class PayloadReader(ChunkReader chunks)
    {
        private byte[] block = [];
        private byte[] packed = [];
        private int at, length;
        private bool compressed, plain;

        /// <summary>Whether what follows must come from stored blocks: the bytes the unit puts in as they are (packed
        /// definitions' frames), which are unpacked again. A frame inside a compressed block would let a file's padding pack
        /// too, and so its frames cost far more than the ratio's share of the file to unpack.</summary>
        public void Plain(bool on)
        {
            if (on && compressed && at < length) throw Refused(IndexFileProblem.Corrupt);
            plain = on;
        }

        /// <summary>Refuses a size the file cannot hold: the content still to come is at most what this block has left and
        /// <see cref="MaxRatio"/> times the file's unread bytes. An early refusal of a count no file of this size could back,
        /// with the fewest bytes that many items take; it is not what bounds a load's memory (a file may be large), the budget
        /// is. A stream that cannot seek is taken to be as long as the largest file.</summary>
        public void Backed(long bytes)
        {
            if (bytes > length - at + MaxRatio * chunks.Unread) throw Refused(IndexFileProblem.Corrupt);
        }

        public void Bytes(Span<byte> destination)
        {
            while (!destination.IsEmpty)
            {
                if (at == length) Refill();
                var take = Math.Min(destination.Length, length - at);
                block.AsSpan(at, take).CopyTo(destination);
                at += take;
                destination = destination[take..];
            }
        }

        /// <summary>Reads past <paramref name="bytes"/> of content (a section a load without children does not keep).</summary>
        public void Skip(long bytes)
        {
            while (bytes > 0)
            {
                if (at == length) Refill();
                var take = (int)Math.Min(bytes, length - at);
                at += take;
                bytes -= take;
            }
        }

        private void Fill(Span<byte> destination)
        {
            while (!destination.IsEmpty)
            {
                var got = chunks.Read(destination);
                // The chunks ended, each one whole: the content itself is short.
                if (got == 0) throw Refused(IndexFileProblem.Corrupt);
                destination = destination[got..];
            }
        }

        private void Refill()
        {
            chunks.Check();
            Span<byte> head = stackalloc byte[5];
            Fill(head);
            var raw = BinaryPrimitives.ReadUInt32LittleEndian(head[1..]);
            if (head[0] > 1 || raw == 0 || raw > BlockBytes || plain && head[0] == 1) throw Refused(IndexFileProblem.Corrupt);
            compressed = head[0] == 1;
            Grow(ref block, (int)raw, BlockBytes);
            if (head[0] == 0) Fill(block.AsSpan(0, (int)raw));
            else
            {
                Span<byte> size = stackalloc byte[4];
                Fill(size);
                var stored = BinaryPrimitives.ReadUInt32LittleEndian(size);
                // The writer keeps a block compressed only when that is smaller.
                if (stored == 0 || stored >= raw) throw Refused(IndexFileProblem.Corrupt);
                Grow(ref packed, (int)stored, BlockBytes);
                Fill(packed.AsSpan(0, (int)stored));
                // The padding that keeps the block within the ratio: read past, into the room the block is about to fill.
                Fill(block.AsSpan(0, Padding(raw, stored)));
                if (!ZstandardDecoder.TryDecompress(packed.AsSpan(0, (int)stored), block.AsSpan(0, (int)raw), out var written) || written != raw) throw Refused(IndexFileProblem.Corrupt);
            }
            (at, length) = (0, (int)raw);
        }

        /// <summary>The content must end here, and the chunks with it.</summary>
        public void End()
        {
            Span<byte> one = stackalloc byte[1];
            if (at != length || chunks.Read(one) != 0) throw Refused(IndexFileProblem.Corrupt);
        }

        public byte Byte()
        {
            if (at == length) Refill();
            return block[at++];
        }

        public ushort UInt16()
        {
            Span<byte> value = stackalloc byte[2];
            Bytes(value);
            return BinaryPrimitives.ReadUInt16LittleEndian(value);
        }

        public int Int32()
        {
            Span<byte> value = stackalloc byte[4];
            Bytes(value);
            return BinaryPrimitives.ReadInt32LittleEndian(value);
        }

        public long Int64()
        {
            Span<byte> value = stackalloc byte[8];
            Bytes(value);
            return BinaryPrimitives.ReadInt64LittleEndian(value);
        }

        /// <summary>A count the content states, refused unless it is within <paramref name="most"/>.</summary>
        public int Count(int most, IndexFileProblem past = IndexFileProblem.Limits)
        {
            var count = Int32();
            if (count < 0) throw Refused(IndexFileProblem.Corrupt);
            if (count > most) throw Refused(past);
            return count;
        }

        public void Int32s(Span<int> values)
        {
            Bytes(MemoryMarshal.AsBytes(values));
            if (!BitConverter.IsLittleEndian) BinaryPrimitives.ReverseEndianness(values, values);
        }

        public void Int16s(Span<short> values)
        {
            Bytes(MemoryMarshal.AsBytes(values));
            if (!BitConverter.IsLittleEndian) BinaryPrimitives.ReverseEndianness(values, values);
        }

        public void UInt16s(Span<ushort> values)
        {
            Bytes(MemoryMarshal.AsBytes(values));
            if (!BitConverter.IsLittleEndian) BinaryPrimitives.ReverseEndianness(values, values);
        }

        /// <summary>A text of <paramref name="chars"/> UTF-16 code units, read straight into the string.</summary>
        public string Chars(int chars)
        {
            if (chars == 0) return "";
            Backed(2L * chars);
            return string.Create(chars, this, static (span, reader) => reader.Units(span));
        }

        private void Units(Span<char> span)
        {
            Bytes(MemoryMarshal.AsBytes(span));
            if (BitConverter.IsLittleEndian) return;
            var units = MemoryMarshal.Cast<char, ushort>(span);
            BinaryPrimitives.ReverseEndianness(units, units);
        }

        /// <summary>A text with its length, refused past <paramref name="most"/> code units.</summary>
        public string Text(int most) => Chars(Count(most));
    }
}
