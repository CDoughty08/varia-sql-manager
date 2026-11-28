using System.Security.Cryptography;

namespace Varia.Backend.Search;

/// <summary>How a file is protected: encrypted under a key the caller keeps, or clear text, which is a choice the caller makes
/// by name (never the absence of a key). A file written one way is never read the other way.</summary>
internal sealed class IndexFileProtection
{
    private readonly byte[] key;

    private IndexFileProtection(byte[] key) => this.key = key;

    /// <summary>No encryption: each chunk carries a hash that catches damage, and nothing more.</summary>
    public static IndexFileProtection ClearText { get; } = new([]);

    /// <summary>AES-256-GCM under <paramref name="key"/> (32 bytes, copied): the key every file's own keys are derived from.</summary>
    public static IndexFileProtection Encrypted(ReadOnlySpan<byte> key) =>
        key.Length == IndexFileContainer.KeyBytes ? new(key.ToArray()) : throw new ArgumentException("An index file key is 32 bytes.", nameof(key));

    public bool IsEncrypted => key.Length > 0;
    internal ReadOnlySpan<byte> Key => key;
}

/// <summary>What a save writes beside the unit. <paramref name="Identity"/> says which unit of which connection the file is (the
/// loader is given it again and refuses another); <paramref name="Sync"/> is what the caller will compare with the source to
/// tell how stale the file is; <paramref name="Extra"/> is more of the caller's own bytes, kept in the body (compressed, and
/// encrypted with it), for what is too large to read with every header. All three are opaque here.</summary>
internal sealed record IndexSaveOptions(IndexFileProtection Protection, ReadOnlyMemory<byte> Identity, ReadOnlyMemory<byte> Sync = default, ReadOnlyMemory<byte> Extra = default);

/// <summary>What a load expects and how it charges. <paramref name="Credit"/> is the read the loaded one will replace, whose
/// share it uses first, as a rebuild does. Without <paramref name="Children"/> the unit is loaded as a read without children
/// is made (no columns, indexes, statistics or parameters, and no details), which is what a caller falls back to when the unit
/// does not fit whole. <paramref name="Discovered"/> picks a BigQuery dataset's details floor
/// (<see cref="ObjectIndexLimits.BigQueryDetailsFloor"/>): the higher one unless the caller says the project is the billing or a starred one.</summary>
internal sealed record IndexLoadOptions(IndexFileProtection Protection, IndexUnitKind Kind, ReadOnlyMemory<byte> Identity, DatabaseIndex? Credit = null, bool Children = true,
    bool Discovered = true);

/// <summary>A load's answer: the unit, or why not; with the file's header (whenever it could be read) and the caller's extra bytes.</summary>
internal readonly record struct IndexLoad<T>(T? Value, IndexFileProblem Problem, IndexFileHeader? Header = null, byte[]? Extra = null) where T : class;

/// <summary>The shared resource set as a file held it: what <see cref="ResourceCatalog.AcquireSavedAsync"/> shares, under its key.</summary>
internal sealed record SavedResourceSet(ResourceKey Key, SavedResource Read);

/// <summary>
/// Saves and loads one unit of the Search Objects index: a database's, a server's or SQL Server Agent's read, a BigQuery
/// dataset's read (each a <see cref="DatabaseIndex"/>), or the shared resource set. The layout is <see cref="IndexFileContainer"/>'s
/// (header, encryption, chunks) around <see cref="IndexFileUnit"/>'s (the content). Nothing here chooses a path, a key or when
/// to save, and nothing calls it yet.
/// <para>A save reads a unit that is never changed once built (a table's arrays, the pool's texts, a read's facts), so it takes
/// no lock and a search of the unit runs beside it; the flags a read may still set are read once, first. It answers a problem
/// as a value. Saving to a path writes a temporary file beside the target (<see cref="TemporaryExtension"/>), flushes it and
/// renames it over the target, so the target is never part of a file: a crash or a stop leaves the earlier file or, at worst
/// (Windows, replacing a file a load has open), none for a moment.</para>
/// <para>A load trusts nothing in the file. Every length is checked against <see cref="IndexFileLimits"/>, what a load keeps
/// is charged to the budget before there is anywhere to keep it, every text is taken from the <see cref="StringPool"/> and
/// charged as the read that made the unit charged it, and every reference the table's readers follow is checked before a
/// table exists. Whatever goes wrong is answered as a value, with everything the load took given back. Loads are given files:
/// a stream that cannot seek loads too, without the early refusal of counts its length could not back.</para>
/// Names, definitions and paths are never logged: this code logs nothing.
/// </summary>
internal static class IndexFile
{
    /// <summary>The extension of a file being written: the target's name, a random part, then this. One left behind by a crash
    /// is never read as a unit, and a store may sweep it.</summary>
    public const string TemporaryExtension = ".tmp";

    // ---- Saving ----

    /// <summary>Writes <paramref name="read"/> to <paramref name="stream"/> as a unit of <paramref name="kind"/>.</summary>
    public static IndexFileProblem Save(Stream stream, DatabaseIndex read, IndexUnitKind kind, IndexSaveOptions options, CancellationToken token = default) =>
        kind == IndexUnitKind.Resource ? IndexFileProblem.Unsupported : Save(stream, IndexUnit.Of(read, kind), options, token);

    /// <summary>Writes the shared resource set; <paramref name="readAt"/> (UTC) is when its read finished, which a set does not keep.</summary>
    public static IndexFileProblem SaveResource(Stream stream, ResourceSet set, DateTime readAt, IndexSaveOptions options, CancellationToken token = default) =>
        Save(stream, IndexUnit.Of(set, readAt), options, token);

    public static IndexFileProblem SaveFile(string path, DatabaseIndex read, IndexUnitKind kind, IndexSaveOptions options, CancellationToken token = default) =>
        kind == IndexUnitKind.Resource ? IndexFileProblem.Unsupported : SaveFile(path, IndexUnit.Of(read, kind), options, token);

    public static IndexFileProblem SaveResourceFile(string path, ResourceSet set, DateTime readAt, IndexSaveOptions options, CancellationToken token = default) =>
        SaveFile(path, IndexUnit.Of(set, readAt), options, token);

    internal static IndexFileProblem Save(Stream stream, IndexUnit unit, IndexSaveOptions options, CancellationToken token)
    {
        try
        {
            token.ThrowIfCancellationRequested();
            // Everything that could refuse the unit is checked before a byte is written, but the file's size, which only the
            // writing finds (a caller's stream is then left part-written; a path's target is untouched).
            var plan = IndexFileUnit.Prepare(unit, options.Extra.Length);
            var header = new IndexFileHeader(IndexFileContainer.Version, options.Protection.IsEncrypted, unit.Kind, unit.Provider, unit.ReadAt, !unit.DefinitionsLeftOut,
                !unit.ChildrenLeftOut, unit.Table.Count, plan.Charge, options.Identity.ToArray(), options.Sync.ToArray());
            var (seal, headerBytes) = IndexFileContainer.WriteHeader(stream, header, options.Protection.Key);
            using var sealing = seal;
            var chunks = new IndexFileContainer.ChunkWriter(stream, seal, headerBytes, token);
            IndexFileUnit.Write(new IndexFileContainer.PayloadWriter(chunks), unit, plan, options.Extra.Span, token);
            return IndexFileProblem.None;
        }
        catch (IndexFileRefused refused) { return refused.Problem; }
        catch (OperationCanceledException) { return IndexFileProblem.Cancelled; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or NotSupportedException or ObjectDisposedException) { return IndexFileProblem.Io; }
        catch (OutOfMemoryException) { return IndexFileProblem.Limits; }
        // Whatever else stopped it (a platform without AES-GCM, say), nothing loadable was written: a value, as every other.
        catch (Exception) { return IndexFileProblem.Unsupported; }
    }

    /// <summary>Writes to a temporary file in the target's folder, flushes it to disk, then renames it over the target: the
    /// target is the earlier file or the new one, never part of either, and a save that stops or fails leaves no temporary file.</summary>
    internal static IndexFileProblem SaveFile(string path, IndexUnit unit, IndexSaveOptions options, CancellationToken token) =>
        Replace(path, stream => Save(stream, unit, options, token), token);

    /// <summary>The replacement itself, whatever <paramref name="write"/> writes (the checks drive it with writes that stop and fail).</summary>
    internal static IndexFileProblem Replace(string path, Func<Stream, IndexFileProblem> write, CancellationToken token)
    {
        string temporary;
        try { temporary = path + "." + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)) + TemporaryExtension; }
        catch (Exception error) when (error is ArgumentException or CryptographicException) { return IndexFileProblem.Io; }
        var problem = IndexFileProblem.Io;
        try
        {
            // The file is the user's alone where the system has such modes: in clear text it holds names and definitions.
            var create = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None, BufferSize = 0 };
            if (!OperatingSystem.IsWindows()) create.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
            using (var stream = new FileStream(temporary, create))
            {
                problem = write(stream);
                if (problem == IndexFileProblem.None) stream.Flush(flushToDisk: true);
            }
            if (problem == IndexFileProblem.None && token.IsCancellationRequested) problem = IndexFileProblem.Cancelled;
            if (problem == IndexFileProblem.None)
            {
                problem = IndexFileProblem.Io;
                try { File.Move(temporary, path, overwrite: true); }
                catch (Exception error) when (OperatingSystem.IsWindows() && error is IOException or UnauthorizedAccessException)
                {
                    // Windows does not rename over a file that is open, even one opened to share its deletion (as a load
                    // opens it); it does replace one, and the load goes on reading the file it opened.
                    File.Replace(temporary, path, null);
                }
                return IndexFileProblem.None;
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException or System.Security.SecurityException)
        {
            problem = IndexFileProblem.Io;
        }
        try { File.Delete(temporary); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException) { }
        return problem;
    }

    // ---- Reading a header ----

    /// <summary>Reads a file's header and nothing of its body: what a store reads of every file it scans.</summary>
    public static IndexLoad<IndexFileHeader> ReadHeader(Stream stream, IndexFileProtection protection)
    {
        try
        {
            var (header, seal, _) = IndexFileContainer.ReadHeader(stream, protection.Key);
            seal.Dispose();
            return new(header, IndexFileProblem.None, header);
        }
        catch (Exception error) { return new(null, Problem(error)); }
    }

    public static IndexLoad<IndexFileHeader> ReadHeaderFile(string path, IndexFileProtection protection)
    {
        try
        {
            using var stream = Open(path);
            return ReadHeader(stream, protection);
        }
        catch (Exception error) when (IsIo(error)) { return new(null, IndexFileProblem.Io); }
    }

    // ---- Loading ----

    /// <summary>Loads a read. Its texts are the pool's and its share is charged to the pool's budget, so the caller holds it as
    /// it holds a read (<see cref="ConnectionIndex.Put"/>) or gives it back (<see cref="ConnectionIndex.Abandon"/>). The unit's
    /// database and dataset are the file's own, and the index holds a read under them (<see cref="DatabaseIndex.Key"/>): the
    /// identity says the file is the one asked for, and in clear text only the caller comparing those names with what it asked
    /// for says the content is. The unit is stamped as read now (<see cref="DatabaseIndex.Stamp"/>), as any new read is.</summary>
    public static IndexLoad<DatabaseIndex> Load(Stream stream, IndexLoadOptions options, ObjectIndexLimits limits, StringPool pool, CancellationToken token = default)
    {
        if (options.Kind == IndexUnitKind.Resource) return new(null, IndexFileProblem.Kind);
        IndexFileHeader? header = null;
        var held = new IndexFileUnit.Segments<object?>();
        IndexFileUnit.PooledAccount? account = null;
        try
        {
            token.ThrowIfCancellationRequested();
            var (read, seal, headerBytes) = IndexFileContainer.ReadHeader(stream, options.Protection.Key);
            using var _ = seal;
            header = read;
            Expect(header, options.Kind, options.Identity.Span);
            var bigQuery = header.Provider == IndexProvider.BigQuery;
            account = new(limits, pool, options.Credit, bigQuery, bigQuery ? limits.BigQueryNamesFloorBytes : 0,
                bigQuery ? limits.BigQueryDetailsFloor(options.Discovered, options.Credit is { Detailed: true }) : 0);
            var reader = new IndexFileContainer.PayloadReader(new IndexFileContainer.ChunkReader(stream, seal, headerBytes, token));
            var unit = IndexFileUnit.Load(reader, header, account, options.Children, held, token);
            var index = new DatabaseIndex(unit.Name, unit.Table, account.Taken + account.Credited, unit.Modules, unit.Cut, account.Credited,
                account.Credited > 0 ? account.Credit : null, pooled: true, readAt: header.ReadAt)
            {
                Dataset = unit.Dataset, Facts = unit.Facts, LeftOut = unit.LeftOut, ChildrenLeftOut = unit.ChildrenLeftOut, DefinitionsLeftOut = unit.DefinitionsLeftOut,
                Detailed = unit.Detailed, FailedPart = unit.FailedPart, CaseSensitive = unit.CaseSensitive, DottedI = unit.DottedI, NameBytes = account.NameBytes, Loaded = true
            };
            return new(index, IndexFileProblem.None, header, unit.Extra);
        }
        catch (Exception error)
        {
            // Whatever stopped the load, nothing of it stays charged or pooled.
            account?.Abandon(held);
            return new(null, Problem(error), header);
        }
    }

    /// <summary>Loads the shared resource set as a read answers it: a table that <see cref="ResourceCatalog.AcquireSavedAsync"/>
    /// pools and charges. A set whose records, details and texts would cost more than <paramref name="mostBytes"/> is refused.</summary>
    public static IndexLoad<SavedResourceSet> LoadResource(Stream stream, IndexFileProtection protection, ReadOnlyMemory<byte> identity, long mostBytes, CancellationToken token = default)
    {
        IndexFileHeader? header = null;
        try
        {
            token.ThrowIfCancellationRequested();
            var (read, seal, headerBytes) = IndexFileContainer.ReadHeader(stream, protection.Key);
            using var _ = seal;
            header = read;
            Expect(header, IndexUnitKind.Resource, identity.Span);
            var reader = new IndexFileContainer.PayloadReader(new IndexFileContainer.ChunkReader(stream, seal, headerBytes, token));
            var unit = IndexFileUnit.Load(reader, header, new IndexFileUnit.PlainAccount(mostBytes), true, new IndexFileUnit.Segments<object?>(), token);
            if (unit.LeftOut > unit.Table.Count) return new(null, IndexFileProblem.Corrupt, header);
            return new(new(unit.Resource!, new SavedResource(unit.Table, unit.LeftOut)), IndexFileProblem.None, header, unit.Extra);
        }
        catch (Exception error) { return new(null, Problem(error), header); }
    }

    /// <summary>Loads a read from a path. With <paramref name="childrenFallback"/>, a unit that does not fit whole is loaded
    /// again without its children, as a read too large with them is read again without (CHILDREN_LEFT_OUT): the unit says so.</summary>
    public static IndexLoad<DatabaseIndex> LoadFile(string path, IndexLoadOptions options, ObjectIndexLimits limits, StringPool pool, bool childrenFallback = false, CancellationToken token = default)
    {
        try
        {
            IndexLoad<DatabaseIndex> loaded;
            using (var stream = Open(path)) loaded = Load(stream, options, limits, pool, token);
            if (loaded.Problem != IndexFileProblem.Budget || !childrenFallback || !options.Children) return loaded;
            using (var stream = Open(path)) return Load(stream, options with { Children = false }, limits, pool, token);
        }
        catch (Exception error) when (IsIo(error)) { return new(null, IndexFileProblem.Io); }
    }

    public static IndexLoad<SavedResourceSet> LoadResourceFile(string path, IndexFileProtection protection, ReadOnlyMemory<byte> identity, long mostBytes, CancellationToken token = default)
    {
        try
        {
            using var stream = Open(path);
            return LoadResource(stream, protection, identity, mostBytes, token);
        }
        catch (Exception error) when (IsIo(error)) { return new(null, IndexFileProblem.Io); }
    }

    /// <summary>The file, shared with other readers and with a save that renames a newer file over it meanwhile.</summary>
    private static FileStream Open(string path) => new(path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete, 1, FileOptions.SequentialScan);

    private static bool IsIo(Exception error) =>
        error is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException or System.Security.SecurityException or ObjectDisposedException;

    private static void Expect(IndexFileHeader header, IndexUnitKind kind, ReadOnlySpan<byte> identity)
    {
        if (header.Kind != kind) throw IndexFileContainer.Refused(IndexFileProblem.Kind);
        if (!CryptographicOperations.FixedTimeEquals(header.Identity, identity)) throw IndexFileContainer.Refused(IndexFileProblem.Identity);
    }

    /// <summary>A load's failure as a value. Anything unforeseen in a file's content is the file's fault, not a crash.</summary>
    private static IndexFileProblem Problem(Exception error) => error switch
    {
        IndexFileRefused refused => refused.Problem,
        OperationCanceledException => IndexFileProblem.Cancelled,
        OutOfMemoryException => IndexFileProblem.Limits,
        _ when IsIo(error) && error is not ArgumentException => IndexFileProblem.Io,
        _ => IndexFileProblem.Corrupt
    };
}
