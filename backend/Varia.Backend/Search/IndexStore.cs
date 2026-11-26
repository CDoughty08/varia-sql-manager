using System.Runtime.CompilerServices;
using System.Security.Cryptography;

namespace Varia.Backend.Search;

/// <summary>How the store stands. Only the first two save anything.</summary>
internal enum IndexStoreMode
{
    /// <summary>Files are AES-256-GCM under the key main holds as safeStorage ciphertext.</summary>
    Encrypted,
    /// <summary>The system has no key store and the user chose to keep the index unencrypted.</summary>
    ClearText,
    /// <summary>Saving is turned off in Options: nothing is saved and what was saved is removed.</summary>
    Disabled,
    /// <summary>The system has no key store and the user did not choose clear text: nothing is saved.</summary>
    NoKeyStore,
    /// <summary>The folder cannot be used (it could not be made, or it is a link): nothing is saved or deleted.</summary>
    Unavailable
}

/// <summary>One saved unit as its header describes it, without its body: what a connection learns of its saved index before it
/// loads any of it. <paramref name="Sync"/> is the builder's own bytes (<see cref="DatabaseIndex.Sync"/>); empty when the read
/// that was saved set none, which for a SQL Server unit means nothing says how to check it against the server.</summary>
internal sealed record SavedUnit(IndexUnitKind Kind, string Database, string? Dataset, IndexFileHeader Header, byte[] Sync, long FileBytes, DateTime UsedAt)
{
    internal string Name { get; init; } = "";
    internal byte[] Identity { get; init; } = [];
    internal long Epoch { get; init; }
}

/// <summary>What the store's work has come to (the checks read it): never a name or a path.</summary>
internal readonly record struct IndexStoreCounts(long Saved, long Failed, long Deleted, long Skipped, long Sweeps);

/// <summary>
/// The Search Objects index on disk (docs/object-search.md, Saved index): one file per unit (<see cref="IndexFile"/>) in one
/// folder main names under the user-data directory, bounded by a limit and swept. Main configures it each time a backend starts
/// (explorer.indexStore.configure, which only main sends): the folder, the key, the limit, and whether anything is saved at all.
/// <para><b>Saving.</b> A connection's index tells its sink (<see cref="IndexStoreSink"/>) of every read it holds; the sink
/// queues a save. One thread writes, one file at a time, below normal priority, so a save never delays a build, a search or a
/// disconnect. The queue holds one entry per unit: a newer read of a unit replaces the queued one and stops the one being
/// written, and a unit dropped as gone (or marked stale) replaces its entry with the file's deletion. A read its index drops
/// (replaced, left out, disconnected) is withdrawn from the queue, so the queue never keeps alive what the index budget gave
/// back; a stop cancels the write, which leaves the earlier file or none (<see cref="IndexFile.Replace"/>). A deletion asked for
/// while the store does not save (before main configures it, without a key store) is remembered and done when it next saves,
/// so a file a later session would load never outlives what made it stale.</para>
/// <para><b>The sweep</b> only deletes. When the store opens: temporary files older than an hour, files not used for 30 days
/// (a file's last write time is when it was last saved, loaded or marked used), files that do not open under the current key,
/// mode or format version or whose header is not the unit their name says, then the least recently used until the store is
/// under its limit. While saving, the age and limit rules run again whenever the tally passes the limit, the folder has not
/// been listed for a minute, or the queue runs dry. It deletes only regular files directly in the store's folder whose names
/// the store gives (<see cref="IndexStoreNames.IsUnit"/>, <see cref="IndexStoreNames.IsTemporary"/>): a link, a reparse point,
/// a directory or a unit shorter than a header is neither opened nor deleted, the folder itself must be a real directory, and
/// a file that cannot be deleted is counted and left. Two Varias on one user-data directory only ever replace whole files and
/// delete, so neither corrupts the other.</para>
/// Nothing here logs: no name, path, key or content leaves through anything but the files themselves.
/// </summary>
internal sealed class IndexStore : IDisposable
{
    private sealed record Open(string Folder, IndexStoreMode Mode, IndexFileProtection? Protection, byte[] Key, byte[]? NameKey, long LimitBytes, long Epoch)
    {
        public bool Saves => Protection is not null && NameKey is not null;
    }

    private abstract record Work(long Epoch);
    /// <summary>A unit's save. <paramref name="TouchFirst"/>: a shared set this store saved already, whose file is only marked
    /// used, and saved again when it is no longer there.</summary>
    private sealed record SaveWork(long Epoch, string Name, IndexUnitKind Kind, DatabaseIndex? Read, ResourceSet? Set, byte[] Identity, byte[] Sync, byte[] Extra,
        IndexStoreScope? Scope = null, bool TouchFirst = false) : Work(Epoch);
    private sealed record DropProjectWork(long Epoch, IndexStoreScope Scope, string Project) : Work(Epoch);
    private sealed record DeleteWork(long Epoch, string Name) : Work(Epoch);
    private sealed record SweepWork(long Epoch, bool Full) : Work(Epoch);
    private sealed record ClearWork(TaskCompletionSource<IndexStoreClearResult> Done, long QueuedIn = 0) : Work(QueuedIn);

    private readonly object gate = new();
    private readonly Dictionary<string, Work> pending = new(StringComparer.Ordinal);
    private readonly Queue<string> order = new();
    /// <summary>Names whose deletion is queued: served before any save, so what DDL or a listing made stale goes at once rather
    /// than behind a backlog of saves, and <see cref="Dispose"/> does them even then.</summary>
    private readonly Queue<string> deletions = new();
    /// <summary>What a stop deleted (unit names, and projects' stale keys): a write already past its last cancellation check that
    /// lands after the stop removes its own file if the stop meant to delete it.</summary>
    private readonly HashSet<string> retired = new(StringComparer.Ordinal);
    /// <summary>A stop ran a queued clear: any write that lands after it goes too.</summary>
    private bool retireAll;
    private readonly Queue<Work> controls = new();
    private readonly CancellationTokenSource lifetime = new();
    /// <summary>The shared sets this store has saved: a build that holds the same set again marks its file used instead of
    /// writing it again. Emptied when the store starts afresh or is cleared.</summary>
    private readonly ConditionalWeakTable<ResourceSet, object> savedSets = [];
    /// <summary>The reads a queued save holds, by reference: a read its index drops (replaced, disconnected, left out) has its
    /// queued save withdrawn, so the queue never keeps alive memory the index budget no longer counts.</summary>
    private readonly Dictionary<DatabaseIndex, string> queuedReads = new(ReferenceEqualityComparer.Instance);
    /// <summary>When DDL last marked a BigQuery dataset, or a whole project, stale, per principal (the files' scope) rather
    /// than per connection: a read of it begun before the mark is not saved, by whichever connection of the principal holds
    /// it. Bounded: past <see cref="MaxStaleMarks"/> the marks are forgotten and every read begun before is refused instead.</summary>
    private readonly Dictionary<string, long> staleMarks = new(StringComparer.Ordinal);
    private long staleSeq, staleFloor;
    internal const int MaxStaleMarks = 4096;
    /// <summary>Deletions asked for while the store did not save (no configuration yet, no key store, saving off): done when a
    /// configuration next opens a saving store. Past <see cref="MaxStaleMarks"/> they are forgotten and every file is cleared then.</summary>
    private readonly List<LaterDrop> later = [];
    private bool laterOverflow;
    private sealed record LaterDrop(IndexStoreScope Scope, IndexUnitKind Kind, string Database, string? Dataset, bool Project)
    {
        /// <summary>A deletion carried from an epoch that ended: its file's name, which stands only under the same key.</summary>
        public string? Name { get; init; }
        public byte[]? Key { get; init; }
    }
    private Open? open;
    private long epochs;
    private string? currentName;
    private CancellationTokenSource? currentStop;
    private Thread? worker;
    private TaskCompletionSource idle = Completed();
    private bool disposed;
    private bool unswept;
    private int files;
    private long bytes;
    private long changes;
    private DateTime listedAt = DateTime.MinValue;
    private long saved, failed, deleted, skipped, sweeps;

    private static TaskCompletionSource Completed()
    {
        var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        done.SetResult();
        return done;
    }

    /// <summary>Called, outside the store's own lock, when a configuration starts the store saving (its first one, another key,
    /// another folder, or saving turned on again): whoever holds reads announces them again, so a read held before main had
    /// configured the store, or saved under a key that is gone, is saved now rather than at its next build.</summary>
    internal Action? Opened { get; set; }
    /// <summary>A check's hook: called on the writing thread as a save is about to write, with the file's name.</summary>
    internal Action<string>? Saving { get; set; }
    /// <summary>How a file is deleted (the checks make one undeletable).</summary>
    internal Action<string> DeleteFile { get; set; } = File.Delete;
    /// <summary>The time the sweep compares files' last use with (the checks move it).</summary>
    internal Func<DateTime> Clock { get; set; } = () => DateTime.UtcNow;

    /// <summary>Counts every change to what the status says: the memory report sends again when it moves.</summary>
    public long Changes => Interlocked.Read(ref changes);
    internal IndexStoreCounts Counts => new(Interlocked.Read(ref saved), Interlocked.Read(ref failed), Interlocked.Read(ref deleted), Interlocked.Read(ref skipped), Interlocked.Read(ref sweeps));

    /// <summary>The store as the Memory panel shows it; null until main has configured it.</summary>
    public IndexStoreStatus? Status
    {
        get
        {
            lock (gate) return open is null ? null : new(ModeName(open.Mode), files, bytes, open.LimitBytes);
        }
    }

    internal IndexStoreMode? Mode { get { lock (gate) return open?.Mode; } }
    /// <summary>Whether main has configured the store (it then knows its folder, and Clear can delete).</summary>
    public bool Configured { get { lock (gate) return open is not null && !disposed; } }
    /// <summary>Whether the store was stopped (the checks wait on it).</summary>
    internal bool Stopped { get { lock (gate) return disposed; } }

    private static string ModeName(IndexStoreMode mode) => mode switch
    {
        IndexStoreMode.Encrypted => "encrypted",
        IndexStoreMode.ClearText => "clearText",
        IndexStoreMode.Disabled => "disabled",
        IndexStoreMode.NoKeyStore => "noKeyStore",
        _ => "unavailable"
    };

    // ---- Configuration ----

    private static RequestException Invalid(string what) => new("INVALID_PARAMS", "Invalid index store request: " + what);

    /// <summary>explorer.indexStore.configure. Every value is checked before anything is touched: the mode is one of four; the
    /// folder is a full path of at most <see cref="IndexStoreLimits.FolderChars"/> whose last part is
    /// <see cref="IndexStoreLimits.FolderName"/> (so nothing can point the sweep at another folder); the key is 32 bytes in
    /// base64, given exactly when the mode saves; the limit is within its bounds. The same folder, mode and key again only
    /// applies the limit; anything else starts the store afresh (queued saves are dropped, then the opening sweep runs).</summary>
    public IndexStoreStatus Configure(IndexStoreConfigureArgs args)
    {
        var mode = args.Mode switch
        {
            "encrypted" => IndexStoreMode.Encrypted,
            "clearText" => IndexStoreMode.ClearText,
            "disabled" => IndexStoreMode.Disabled,
            "noKeyStore" => IndexStoreMode.NoKeyStore,
            _ => throw Invalid("mode.")
        };
        var folder = CheckFolder(args.Folder);
        if (args.LimitMiB is not (>= IndexStoreLimits.MinDiskMiB and <= IndexStoreLimits.MaxDiskMiB)) throw Invalid("limitMiB.");
        var saves = mode is IndexStoreMode.Encrypted or IndexStoreMode.ClearText;
        if (saves != args.Key is not null) throw Invalid("key.");
        byte[] key = [];
        if (args.Key is { } text)
        {
            key = new byte[IndexFileContainer.KeyBytes];
            if (text.Length != IndexStoreLimits.KeyChars || !Convert.TryFromBase64String(text, key, out var written) || written != key.Length) throw Invalid("key.");
        }
        var limit = args.LimitMiB.Value * 1024L * 1024;
        if (!Prepare(folder)) mode = IndexStoreMode.Unavailable;
        var opened = false;
        IndexStoreStatus status;
        lock (gate)
        {
            // A stopped store answers as one that cannot be used; nothing is queued.
            if (disposed) return new(ModeName(IndexStoreMode.Unavailable), 0, 0, limit);
            if (open is { } current && current.Mode == mode && current.Folder == folder && CryptographicOperations.FixedTimeEquals(current.Key, key))
            {
                open = current with { LimitBytes = limit };
                if (current.LimitBytes != limit)
                {
                    Interlocked.Increment(ref changes);
                    if (mode != IndexStoreMode.Unavailable) Control(new SweepWork(current.Epoch, Full: false));
                }
            }
            else
            {
                // Another key, mode or folder: nothing queued under the old one is written, and the write in progress stops. Its
                // deletions are remembered: should the same key save again, a file they meant to remove must not come back.
                if (open is { Saves: true } outgoing)
                {
                    foreach (var work in pending.Values)
                        if (work is DeleteWork delete) Remember(new(IndexStoreScope.Resource, IndexUnitKind.Database, "", null, Project: false) { Name = delete.Name, Key = outgoing.Key });
                    foreach (var work in controls)
                        if (work is DropProjectWork drop) Remember(new(drop.Scope, IndexUnitKind.Dataset, drop.Project, null, Project: true));
                }
                unswept = false;
                pending.Clear();
                order.Clear();
                deletions.Clear();
                queuedReads.Clear();
                savedSets.Clear();
                try { currentStop?.Cancel(); } catch (ObjectDisposedException) { }
                var epoch = ++epochs;
                // In clear text the key only names files: it is main's own random value, kept in clear beside nothing secret.
                var protection = mode == IndexStoreMode.Encrypted ? IndexFileProtection.Encrypted(key) : mode == IndexStoreMode.ClearText ? IndexFileProtection.ClearText : null;
                open = new(folder, mode, protection, key, saves && mode != IndexStoreMode.Unavailable ? IndexStoreNames.NameKey(key) : null, limit, epoch);
                (files, bytes) = (0, 0);
                Interlocked.Increment(ref changes);
                if (mode != IndexStoreMode.Unavailable) Control(new SweepWork(epoch, Full: true));
                opened = open.Saves;
                // After the opening sweep, before what is announced: what went stale meanwhile goes first.
                if (opened) DropRemembered(open);
            }
            status = new(ModeName(open.Mode), files, bytes, open.LimitBytes);
        }
        // After the opening sweep is queued, so what is announced is written once the folder has been swept.
        if (opened) Opened?.Invoke();
        return status;
    }

    /// <summary>The folder as main named it, refused unless it is a full, normal path to a folder of the store's own name.</summary>
    internal static string CheckFolder(string? folder)
    {
        if (folder is not { Length: > 0 and <= IndexStoreLimits.FolderChars } || folder.Contains('\0')) throw Invalid("folder.");
        try
        {
            if (!Path.IsPathFullyQualified(folder) || Path.GetFullPath(folder) != folder || Path.GetFileName(folder) != IndexStoreLimits.FolderName) throw Invalid("folder.");
        }
        catch (Exception error) when (error is ArgumentException or NotSupportedException or PathTooLongException or System.Security.SecurityException) { throw Invalid("folder."); }
        return folder;
    }

    /// <summary>Makes the folder (the user's alone where the system has such modes) and checks it is a directory of its own, not
    /// a link to one: the sweep deletes in it.</summary>
    private static bool Prepare(string folder)
    {
        try
        {
            if (!Directory.Exists(folder))
            {
                if (OperatingSystem.IsWindows()) Directory.CreateDirectory(folder);
                else Directory.CreateDirectory(folder, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            }
            return RealFolder(folder);
        }
        catch (Exception error) when (IsIo(error)) { return false; }
    }

    private static bool RealFolder(string folder)
    {
        try
        {
            var info = new DirectoryInfo(folder);
            return info.Exists && (info.Attributes & FileAttributes.ReparsePoint) == 0 && info.LinkTarget is null;
        }
        catch (Exception error) when (IsIo(error)) { return false; }
    }

    private static bool IsIo(Exception error) =>
        error is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException or System.Security.SecurityException;

    // ---- The queue ----

    /// <summary>A connection's sink for <paramref name="scope"/>; null without one (nothing of that connection is saved).</summary>
    public IndexStoreSink? Sink(IndexStoreScope? scope) => scope is null ? null : new(this, scope);

    /// <summary>The store as configured, when it saves and reads (encrypted, or clear text by choice); else null.</summary>
    private Open? Active()
    {
        lock (gate) return open is { Saves: true } at && !disposed ? at : null;
    }

    private static (string Name, byte[] Identity) Unit(Open at, IndexStoreScope scope, IndexUnitKind kind, string database, string? dataset)
    {
        var scopeId = IndexStoreNames.ScopeId(at.NameKey!, scope);
        var unitId = IndexStoreNames.UnitId(at.NameKey!, scopeId, kind, database, dataset);
        return (IndexStoreNames.FileName(scopeId, unitId), IndexStoreNames.Identity(kind, scopeId, unitId));
    }

    private static (string Name, byte[] Identity) Unit(Open at, ResourceKey key)
    {
        var scopeId = IndexStoreNames.ScopeId(at.NameKey!, IndexStoreScope.Resource);
        var unitId = IndexStoreNames.UnitId(at.NameKey!, scopeId, key);
        return (IndexStoreNames.FileName(scopeId, unitId), IndexStoreNames.Identity(IndexUnitKind.Resource, scopeId, unitId));
    }

    /// <summary>Queues <paramref name="read"/>'s save as a unit of <paramref name="scope"/>, in place of any save or deletion
    /// queued for the same unit. A read whose own sync state is past <see cref="IndexStoreLimits.SyncBytes"/> is not saved.</summary>
    public void Save(IndexStoreScope scope, IndexUnitKind kind, DatabaseIndex read)
    {
        if (kind == IndexUnitKind.Resource || read.Sync.Length > IndexStoreLimits.SyncBytes || Active() is not { } at) return;
        if (read.Database.Length > IndexFileLimits.NameChars || read.Dataset is { Length: > IndexFileLimits.NameChars }) return;
        var (name, identity) = Unit(at, scope, kind, read.Database, read.Dataset);
        Queue(at, name, new SaveWork(at.Epoch, name, kind, read, null, identity, IndexStoreNames.Sync(read.Database, read.Dataset, read.Sync.Span), read.Extra.ToArray(), scope));
    }

    /// <summary>The store's count of stale marks now: a BigQuery read records it as it begins (<see cref="DatabaseIndex.StaleSeen"/>).</summary>
    public long StaleSeq
    {
        get { lock (gate) return staleSeq; }
    }

    private static string StaleKey(IndexStoreScope scope, string project, string? dataset) => Convert.ToHexString(scope.Seed) + "\n" + project + "\n" + dataset;

    /// <summary>DDL changed a BigQuery dataset (or, with no dataset, any dataset of a project): its file and its queued save go,
    /// and no read of it begun before now is saved by any connection of the principal.</summary>
    public void MarkStale(IndexStoreScope scope, string project, string? dataset)
    {
        if (scope.Provider != IndexProvider.BigQuery) return;
        Open? at;
        lock (gate)
        {
            if (staleMarks.Count >= MaxStaleMarks && !staleMarks.ContainsKey(StaleKey(scope, project, dataset)))
            {
                staleMarks.Clear();
                staleFloor = staleSeq + 1;
            }
            staleMarks[StaleKey(scope, project, dataset)] = ++staleSeq;
            // Whatever is queued of it was read before the mark.
            foreach (var (name, work) in pending.Where(pair => pair.Value is SaveWork { Read: { } read, Scope: { } of } && Stale(of, read)).ToList())
                Unqueue(name, work);
            at = open is { Saves: true } current && !disposed ? current : null;
            if (dataset is null)
            {
                if (at is not null) Control(new DropProjectWork(at.Epoch, scope, project));
                else Remember(new(scope, IndexUnitKind.Dataset, project, null, Project: true));
            }
        }
        if (dataset is not null) Drop(scope, IndexUnitKind.Dataset, project, dataset);
    }

    /// <summary>Whether DDL marked <paramref name="read"/>'s dataset or project stale after the read began (under the gate).</summary>
    private bool Stale(IndexStoreScope scope, DatabaseIndex read)
    {
        if (scope.Provider != IndexProvider.BigQuery || read.Dataset is not { } dataset || read.StaleSeen == long.MaxValue) return false;
        if (read.StaleSeen < staleFloor) return true;
        return staleMarks.TryGetValue(StaleKey(scope, read.Database, dataset), out var mark) && mark > read.StaleSeen
            || staleMarks.TryGetValue(StaleKey(scope, read.Database, null), out var whole) && whole > read.StaleSeen;
    }

    /// <summary>Withdraws <paramref name="read"/>'s queued save: its index no longer holds it (ConnectionIndex.Drop). A newer read of
    /// the unit, queued by the same Put, takes its place; the write in progress, if it is this read's, finishes.</summary>
    public void Released(DatabaseIndex read)
    {
        lock (gate)
            if (queuedReads.TryGetValue(read, out var name) && pending.TryGetValue(name, out var work)) Unqueue(name, work);
    }

    /// <summary>Takes a queued entry out (under the gate); its name stays in the order, which skips names with nothing queued.</summary>
    private void Unqueue(string name, Work work)
    {
        pending.Remove(name);
        if (work is SaveWork { Read: { } read }) queuedReads.Remove(read);
    }

    /// <summary>Queues the shared resource set's save, once per set: a set already saved by this store has its file marked used.</summary>
    public void SaveResource(ResourceSet set)
    {
        if (Active() is not { } at) return;
        var (name, identity) = Unit(at, set.Key);
        // Saved already: the writer marks the file used, off the index's lock, and saves it again if the file has gone.
        Queue(at, name, new SaveWork(at.Epoch, name, IndexUnitKind.Resource, null, set, identity, IndexStoreNames.Sync("", null, []), [], TouchFirst: savedSets.TryGetValue(set, out _)));
    }

    /// <summary>Queues the deletion of a unit's file, in place of any save queued for it, and stops one being written: the
    /// unit is gone from its source, or what was saved of it is known to be stale.</summary>
    public void Drop(IndexStoreScope scope, IndexUnitKind kind, string database, string? dataset)
    {
        if (kind == IndexUnitKind.Resource || Remembered(new(scope, kind, database, dataset, Project: false)) is not { } at) return;
        var (name, _) = Unit(at, scope, kind, database, dataset);
        Queue(at, name, new DeleteWork(at.Epoch, name));
    }

    /// <summary>The store as it saves now; when it does not, remembers <paramref name="drop"/> for when it next does and answers null.</summary>
    private Open? Remembered(LaterDrop drop)
    {
        lock (gate)
        {
            if (disposed) return null;
            if (open is { Saves: true } at) return at;
            Remember(drop);
            return null;
        }
    }

    /// <summary>Remembers a deletion for the next saving epoch (under the gate). Saving off needs none: its sweep deletes every unit.</summary>
    private void Remember(LaterDrop drop)
    {
        if (disposed || open is { Mode: IndexStoreMode.Disabled }) return;
        if (later.Count >= MaxStaleMarks) laterOverflow = true;
        else later.Add(drop);
    }

    /// <summary>Queues what was remembered while the store did not save (under the gate, as a saving epoch opens).</summary>
    private void DropRemembered(Open at)
    {
        if (laterOverflow) Control(new ClearWork(new TaskCompletionSource<IndexStoreClearResult>(TaskCreationOptions.RunContinuationsAsynchronously), at.Epoch));
        else
            foreach (var drop in later)
                if (drop.Project) Control(new DropProjectWork(at.Epoch, drop.Scope, drop.Database));
                else if (drop.Name is not null && (drop.Key is null || !CryptographicOperations.FixedTimeEquals(drop.Key, at.Key))) continue;
                else
                {
                    var name = drop.Name ?? Unit(at, drop.Scope, drop.Kind, drop.Database, drop.Dataset).Name;
                    if (!pending.ContainsKey(name)) order.Enqueue(name);
                    else Unqueue(name, pending[name]);
                    pending[name] = new DeleteWork(at.Epoch, name);
                    deletions.Enqueue(name);
                }
        later.Clear();
        laterOverflow = false;
    }

    private void Queue(Open at, string name, Work work)
    {
        lock (gate)
        {
            if (disposed || open is null || open.Epoch != at.Epoch) return;
            if (work is SaveWork { Read: { } read, Scope: { } scope } && Stale(scope, read)) return;
            var queued = pending.TryGetValue(name, out var earlier);
            // Marking a saved set used never displaces a save or deletion queued for it, nor stops one being written.
            if (work is SaveWork { TouchFirst: true } && (queued || currentName == name)) return;
            if (queued) Unqueue(name, earlier!);
            else order.Enqueue(name);
            if (work is DeleteWork) deletions.Enqueue(name);
            pending[name] = work;
            if (work is SaveWork { Read: { } held }) queuedReads[held] = name;
            // The unit being written is no longer the one to keep: stop it, and this entry takes its place.
            if (currentName == name) try { currentStop?.Cancel(); } catch (ObjectDisposedException) { }
            Wake();
        }
    }

    private void Control(Work work)
    {
        controls.Enqueue(work);
        Wake();
    }

    /// <summary>Starts the writing thread when it is not running (under the gate).</summary>
    private void Wake()
    {
        if (worker is not null) return;
        idle = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        worker = new Thread(Run) { IsBackground = true, Name = "Index store", Priority = ThreadPriority.BelowNormal };
        worker.Start();
    }

    /// <summary>Completes when nothing is queued and nothing is being written (the checks and Clear wait on it).</summary>
    internal Task Idle()
    {
        lock (gate) return idle.Task;
    }

    private void Run()
    {
        while (true)
        {
            Work? work = null;
            Open? at;
            CancellationTokenSource? stop = null;
            lock (gate)
            {
                at = open;
                if (disposed)
                {
                    pending.Clear();
                    order.Clear();
                    deletions.Clear();
                    queuedReads.Clear();
                    while (controls.TryDequeue(out var dropped))
                        if (dropped is ClearWork clear) clear.Done.TrySetResult(new(0, 0, 0));
                }
                else if (!controls.TryDequeue(out work))
                {
                    // Deletions first; a name whose entry was taken already is skipped wherever it is met again.
                    while (work is null && deletions.TryDequeue(out var urgent)) pending.Remove(urgent, out work);
                    if (work is SaveWork { Read: { } urgentRead }) queuedReads.Remove(urgentRead);
                    while (work is null && order.TryDequeue(out var name))
                        if (pending.Remove(name, out work) && work is SaveWork { Read: { } read } save)
                        {
                            queuedReads.Remove(read);
                            if (save.Scope is { } scope && Stale(scope, read)) work = null;
                        }
                    // The queue ran dry after saves: the age and limit rules run once more over what they left.
                    if (work is null && unswept && at is { Saves: true }) work = new SweepWork(at.Epoch, Full: false);
                    // Whatever a dry sweep finds, it runs once: a folder that went away must not have the thread sweep again at once.
                    if (work is SweepWork) unswept = false;
                }
                if (work is null)
                {
                    worker = null;
                    idle.TrySetResult();
                    return;
                }
                if (work is SaveWork or DeleteWork)
                {
                    stop = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                    (currentName, currentStop) = (work is SaveWork save ? save.Name : ((DeleteWork)work).Name, stop);
                }
            }
            try
            {
                switch (work)
                {
                    case ClearWork clear: clear.Done.TrySetResult(at is null ? new(0, 0, 0) : Clear(at, clear.QueuedIn == at.Epoch)); break;
                    case SweepWork sweep when at is not null && sweep.Epoch == at.Epoch: Sweep(at, sweep.Full); break;
                    case SaveWork save when at is not null && save.Epoch == at.Epoch: Write(at, save, stop!.Token); break;
                    case DeleteWork delete when at is not null && delete.Epoch == at.Epoch: Remove(at, delete); break;
                    case DropProjectWork drop when at is not null && drop.Epoch == at.Epoch: DropProject(at, drop); break;
                }
            }
            // Nothing a file or a folder does stops the thread: what failed is counted, and the next entry runs.
            catch (Exception)
            {
                Interlocked.Increment(ref failed);
                if (work is ClearWork clear) clear.Done.TrySetResult(new(0, 0, 0));
            }
            finally
            {
                lock (gate) (currentName, currentStop) = (null, null);
                stop?.Dispose();
            }
        }
    }

    private void Write(Open at, SaveWork work, CancellationToken token)
    {
        if (!at.Saves || !RealFolder(at.Folder)) { Interlocked.Increment(ref failed); return; }
        var path = Path.Combine(at.Folder, work.Name);
        if (work.TouchFirst && Touch(path)) return;
        Saving?.Invoke(work.Name);
        var before = Length(path);
        var options = new IndexSaveOptions(at.Protection!, work.Identity, work.Sync, work.Extra);
        var problem = work.Set is { } set ? IndexFile.SaveResourceFile(path, set, set.ReadAt, options, token) : IndexFile.SaveFile(path, work.Read!, work.Kind, options, token);
        if (problem != IndexFileProblem.None)
        {
            // Cancelled for a newer read of the unit, its deletion or a stop: not a failure.
            if (problem != IndexFileProblem.Cancelled) Interlocked.Increment(ref failed);
            return;
        }
        bool retire;
        lock (gate)
            retire = disposed && (retireAll || retired.Contains(work.Name) || work is { Scope: { } scope, Read: { Dataset: not null } read } && retired.Contains(StaleKey(scope, read.Database, null)));
        // Renamed into place after a stop deleted what it replaces: the stop meant this unit gone.
        if (retire) { Delete(path); return; }
        Interlocked.Increment(ref saved);
        var after = Length(path);
        bool sweep;
        lock (gate)
        {
            if (open?.Epoch != at.Epoch) return;
            // Under the epoch's check: a set written under a key that has just gone is not taken as saved under the new one.
            if (work.Set is { } savedSet) savedSets.AddOrUpdate(savedSet, savedSet);
            if (before < 0) files++;
            bytes += Math.Max(0, after) - Math.Max(0, before);
            unswept = true;
            sweep = bytes > open.LimitBytes || Clock() - listedAt >= IndexStoreLimits.ListEvery;
            at = open;
        }
        Interlocked.Increment(ref changes);
        if (sweep) Sweep(at, full: false);
    }

    private void Remove(Open at, DeleteWork work)
    {
        if (!RealFolder(at.Folder)) return;
        var info = new FileInfo(Path.Combine(at.Folder, work.Name));
        long length;
        try
        {
            if (!info.Exists || !Regular(info)) return;
            length = info.Length;
        }
        catch (Exception error) when (IsIo(error)) { return; }
        if (!Delete(info.FullName)) return;
        lock (gate)
        {
            if (open?.Epoch != at.Epoch) return;
            files = Math.Max(0, files - 1);
            bytes = Math.Max(0, bytes - length);
        }
        Interlocked.Increment(ref changes);
    }

    /// <summary>Deletes the files of a project's datasets in a scope, which DDL may all have changed (on the writer, which reads
    /// their headers).</summary>
    private void DropProject(Open at, DropProjectWork work, CancellationToken token = default)
    {
        // Not cut short by a stop's own cancellation: Dispose does the queued ones itself, within its budget (token).
        foreach (var unit in List(at, work.Scope, token))
        {
            token.ThrowIfCancellationRequested();
            if (unit.Kind == IndexUnitKind.Dataset && unit.Database == work.Project) Remove(at, new DeleteWork(at.Epoch, unit.Name));
        }
        // Another configuration came meanwhile: the drop is done again under it, at once if it saves, else when one does.
        lock (gate)
            if (open is { } current && current.Epoch != at.Epoch && !disposed)
            {
                if (current.Saves) Control(new DropProjectWork(current.Epoch, work.Scope, work.Project));
                else Remember(new(work.Scope, IndexUnitKind.Dataset, work.Project, null, Project: true));
            }
    }

    private static long Length(string path)
    {
        try
        {
            var info = new FileInfo(path);
            return info.Exists ? info.Length : -1;
        }
        catch (Exception error) when (IsIo(error)) { return -1; }
    }

    // ---- The sweep ----

    /// <summary>A file the store may read, count and delete: a regular file, and a unit of at least a header's size (a temporary
    /// file a crash left may be empty). A link or reparse point is never followed, and on Unix a FIFO or a device is never opened.</summary>
    private static bool Regular(FileInfo info, bool unit = true) =>
        (info.Attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory | FileAttributes.Device)) == 0 && info.LinkTarget is null && (!unit || info.Length >= IndexFileContainer.PrefixBytes);

    private static readonly EnumerationOptions Listing = new() { AttributesToSkip = 0, IgnoreInaccessible = true, RecurseSubdirectories = false, MatchType = MatchType.Simple };

    private bool Delete(string path)
    {
        try
        {
            DeleteFile(path);
            Interlocked.Increment(ref deleted);
            return true;
        }
        catch (Exception error) when (IsIo(error))
        {
            Interlocked.Increment(ref skipped);
            return false;
        }
    }

    /// <summary>Whether a file is not this store's to keep: it does not open under the current key, mode and version, or its
    /// header is another unit's than its name says. A file that could not be read at all (locked, gone) is kept for now.</summary>
    private static bool Unopenable(Open at, FileInfo info)
    {
        if (at.Mode == IndexStoreMode.NoKeyStore)
        {
            // No key to judge an encrypted file by, and it may open again when the key store is back: only what is not one goes
            // (clear text the user has not chosen to keep, and anything that is no index file).
            return IndexFile.ReadHeaderFile(info.FullName, IndexFileProtection.ClearText).Problem is not (IndexFileProblem.Mode or IndexFileProblem.Io);
        }
        var read = IndexFile.ReadHeaderFile(info.FullName, at.Protection!);
        if (read.Problem == IndexFileProblem.Io) return false;
        // Unencrypted by choice where there is no key store: an encrypted file may open again once there is one.
        if (at.Mode == IndexStoreMode.ClearText && read.Problem == IndexFileProblem.Mode) return false;
        return read.Value is not { } header || !IndexStoreNames.Names(header.Identity, info.Name);
    }

    /// <summary>The delete-only sweep (the class comment has its rules). <paramref name="full"/> also opens every file's header.</summary>
    private void Sweep(Open at, bool full)
    {
        if (!RealFolder(at.Folder)) return;
        var now = Clock();
        var kept = new List<(string Path, long Length, DateTime Used)>();
        IEnumerable<FileInfo> listed;
        try { listed = new DirectoryInfo(at.Folder).EnumerateFiles("*", Listing); }
        catch (Exception error) when (IsIo(error)) { return; }
        try
        {
            foreach (var info in listed)
            {
                var unit = IndexStoreNames.IsUnit(info.Name);
                // Not the store's own name: never read, counted or deleted.
                if (!unit && !IndexStoreNames.IsTemporary(info.Name)) continue;
                long length;
                DateTime used;
                try
                {
                    if (!Regular(info, unit)) continue;
                    (length, used) = (info.Length, info.LastWriteTimeUtc);
                }
                catch (Exception error) when (IsIo(error)) { continue; }
                if (!unit)
                {
                    if (now - used >= IndexStoreLimits.TemporaryGrace) Delete(info.FullName);
                    continue;
                }
                var gone = at.Mode == IndexStoreMode.Disabled || now - used >= TimeSpan.FromDays(IndexStoreLimits.UnusedDays) || full && Unopenable(at, info);
                if (!gone || !Delete(info.FullName)) kept.Add((info.FullName, length, used));
            }
        }
        catch (Exception error) when (IsIo(error)) { /* The folder went away mid-listing: what was listed stands. */ }
        var total = kept.Sum(file => file.Length);
        var count = kept.Count;
        if (at.Saves)
        {
            long limit;
            lock (gate) limit = open?.Epoch == at.Epoch ? open.LimitBytes : at.LimitBytes;
            // The least recently used first, until the store is under its limit.
            foreach (var file in kept.OrderBy(file => file.Used).ThenBy(file => file.Path, StringComparer.Ordinal))
            {
                if (total <= limit) break;
                if (!Delete(file.Path)) continue;
                total -= file.Length;
                count--;
            }
        }
        Interlocked.Increment(ref sweeps);
        lock (gate)
        {
            if (open?.Epoch != at.Epoch) return;
            if (files != count || bytes != total) Interlocked.Increment(ref changes);
            (files, bytes, listedAt, unswept) = (count, total, now, false);
        }
    }

    /// <summary>explorer.indexStore.clear (Clear Saved Search Indexes): drops everything queued, stops the write in progress and
    /// deletes every file of the store's own, temporary ones whatever their age. What an index holds in memory is untouched,
    /// and its next build saves again.</summary>
    public Task<IndexStoreClearResult> ClearAsync()
    {
        var done = new TaskCompletionSource<IndexStoreClearResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (gate)
        {
            if (disposed || open is null) return Task.FromResult(new IndexStoreClearResult(0, 0, 0));
            pending.Clear();
            order.Clear();
            deletions.Clear();
            queuedReads.Clear();
            try { currentStop?.Cancel(); } catch (ObjectDisposedException) { }
            Control(new ClearWork(done, open.Epoch));
        }
        return done.Task;
    }

    private IndexStoreClearResult Clear(Open at, bool sameEpoch = true, CancellationToken token = default)
    {
        if (at.Mode == IndexStoreMode.Unavailable || !RealFolder(at.Folder)) return new(0, 0, 0);
        int removed = 0, left = 0;
        long freed = 0, leftBytes = 0;
        try
        {
            foreach (var info in new DirectoryInfo(at.Folder).EnumerateFiles("*", Listing))
            {
                token.ThrowIfCancellationRequested();
                var unit = IndexStoreNames.IsUnit(info.Name);
                if (!unit && !IndexStoreNames.IsTemporary(info.Name)) continue;
                long length;
                try
                {
                    if (!Regular(info, unit)) continue;
                    length = info.Length;
                }
                catch (Exception error) when (IsIo(error)) { continue; }
                if (Delete(info.FullName)) { removed++; freed += length; }
                else if (unit) { left++; leftBytes += length; }
            }
        }
        catch (Exception error) when (IsIo(error)) { }
        // The shared sets held now are saved again by the next build that holds them (a clear queued under an earlier
        // configuration leaves the sets this one has saved since alone: their files may be newer than the clear).
        if (sameEpoch) savedSets.Clear();
        lock (gate)
        {
            if (open?.Epoch == at.Epoch) (files, bytes, listedAt, unswept) = (left, leftBytes, Clock(), false);
        }
        Interlocked.Increment(ref changes);
        return new(removed, freed, left);
    }

    // ---- Reading what was saved (the next builds' reloads call these) ----

    private static SavedUnit? Describe(Open at, FileInfo info)
    {
        try
        {
            if (!info.Exists || !Regular(info)) return null;
            var read = IndexFile.ReadHeaderFile(info.FullName, at.Protection!);
            if (read.Value is not { } header || !IndexStoreNames.Names(header.Identity, info.Name)) return null;
            if (!IndexStoreNames.TryReadSync(header.Sync, out var database, out var dataset, out var own)) return null;
            return new(header.Kind, database, dataset, header, own, info.Length, info.LastWriteTimeUtc) { Name = info.Name, Identity = header.Identity, Epoch = at.Epoch };
        }
        catch (Exception error) when (IsIo(error)) { return null; }
    }

    /// <summary>A scope's saved units by their headers, reading no body: only files that open under the current key and whose
    /// identity is the scope's own. The names each one states are checked against its identity, so a unit is what it says.</summary>
    public List<SavedUnit> List(IndexStoreScope scope, CancellationToken token = default) =>
        Active() is { } at ? List(at, scope, token) : [];

    private static List<SavedUnit> List(Open at, IndexStoreScope scope, CancellationToken token)
    {
        var units = new List<SavedUnit>();
        if (!at.Saves || !RealFolder(at.Folder)) return units;
        var scopeId = IndexStoreNames.ScopeId(at.NameKey!, scope);
        try
        {
            foreach (var info in new DirectoryInfo(at.Folder).EnumerateFiles(IndexStoreNames.ScopeTag(scopeId) + "-*" + IndexStoreNames.Extension, Listing))
            {
                token.ThrowIfCancellationRequested();
                if (!IndexStoreNames.IsUnit(info.Name) || Describe(at, info) is not { } unit || unit.Kind == IndexUnitKind.Resource) continue;
                var unitId = IndexStoreNames.UnitId(at.NameKey!, scopeId, unit.Kind, unit.Database, unit.Dataset);
                if (CryptographicOperations.FixedTimeEquals(unit.Identity, IndexStoreNames.Identity(unit.Kind, scopeId, unitId))) units.Add(unit);
            }
        }
        catch (Exception error) when (IsIo(error)) { }
        return units;
    }

    /// <summary>One unit of a scope by its header, or null when no file holds it.</summary>
    public SavedUnit? Find(IndexStoreScope scope, IndexUnitKind kind, string database, string? dataset = null)
    {
        if (kind == IndexUnitKind.Resource || Active() is not { } at || !RealFolder(at.Folder)) return null;
        var (name, identity) = Unit(at, scope, kind, database, dataset);
        return Describe(at, new FileInfo(Path.Combine(at.Folder, name))) is { } unit && unit.Kind == kind && unit.Database == database && unit.Dataset == dataset
            && CryptographicOperations.FixedTimeEquals(unit.Identity, identity) ? unit : null;
    }

    /// <summary>Loads a listed unit (<see cref="IndexFile.LoadFile"/>) and marks it used. The loaded read is the caller's to
    /// hold in <paramref name="index"/> (Put, which does not save it again) or give back (Abandon); one whose content names another database or dataset than
    /// its header (possible only in clear text, where nothing binds the two) is given back here and answered as Identity.</summary>
    public IndexLoad<DatabaseIndex> Load(SavedUnit unit, ConnectionIndex index, ObjectIndexLimits limits, StringPool pool, DatabaseIndex? credit = null, bool children = true,
        bool discovered = true, bool childrenFallback = false, CancellationToken token = default)
    {
        if (Active() is not { } at || at.Epoch != unit.Epoch || !RealFolder(at.Folder)) return new(null, IndexFileProblem.Io);
        var path = Path.Combine(at.Folder, unit.Name);
        var loaded = IndexFile.LoadFile(path, new IndexLoadOptions(at.Protection!, unit.Kind, unit.Identity, credit, children, discovered), limits, pool, childrenFallback, token);
        if (loaded.Value is not { } read) return loaded;
        if (read.Database != unit.Database || read.Dataset != unit.Dataset)
        {
            index.Abandon(read);
            return new(null, IndexFileProblem.Identity, loaded.Header);
        }
        // Holding it queues no save: the file is this read already.
        read.SaveWhenHeld = false;
        Touch(path);
        return loaded;
    }

    /// <summary>Loads the shared resource set saved for <paramref name="key"/>, for <see cref="ResourceCatalog.AcquireSavedAsync"/>
    /// to share; a file whose content is another key's is answered as Identity.</summary>
    public IndexLoad<SavedResourceSet> LoadResource(ResourceKey key, long mostBytes, CancellationToken token = default)
    {
        if (Active() is not { } at || !RealFolder(at.Folder)) return new(null, IndexFileProblem.Io);
        var (name, identity) = Unit(at, key);
        var path = Path.Combine(at.Folder, name);
        var loaded = IndexFile.LoadResourceFile(path, at.Protection!, identity, mostBytes, token);
        if (loaded.Value is { } set && set.Key != key) return new(null, IndexFileProblem.Identity, loaded.Header);
        if (loaded.Value is not null) Touch(path);
        return loaded;
    }

    /// <summary>Marks a unit used now, so the 30 days and the limit count from here: for a unit a connection keeps relying on
    /// without loading or saving it again.</summary>
    public bool MarkUsed(SavedUnit unit) => Active() is { } at && at.Epoch == unit.Epoch && RealFolder(at.Folder) && Touch(Path.Combine(at.Folder, unit.Name));

    /// <summary>Queues a listed unit's deletion (it no longer matches its source), in order with the saves.</summary>
    public void Delete(SavedUnit unit)
    {
        if (Active() is not { } at || at.Epoch != unit.Epoch) return;
        Queue(at, unit.Name, new DeleteWork(at.Epoch, unit.Name));
    }

    private bool Touch(string path)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists || !Regular(info)) return false;
            File.SetLastWriteTimeUtc(path, Clock());
            return true;
        }
        catch (Exception error) when (IsIo(error)) { return false; }
    }

    /// <summary>Stops the store: nothing queued is written, and the write in progress is cancelled, which leaves the earlier
    /// file or none. The deletions queued are done first; then it waits a moment for that write to clear its temporary file
    /// away, never for a save to finish.</summary>
    public void Dispose()
    {
        Thread? thread;
        Open? at;
        List<DeleteWork> deleting;
        List<DropProjectWork> projects;
        bool clearing;
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            at = open;
            deleting = [.. pending.Values.OfType<DeleteWork>().Where(work => work.Epoch == at?.Epoch)];
            projects = [.. controls.OfType<DropProjectWork>().Where(work => work.Epoch == at?.Epoch)];
            clearing = controls.Any(work => work is ClearWork clear && clear.QueuedIn == at?.Epoch);
            retireAll = clearing;
            foreach (var work in deleting) retired.Add(work.Name);
            foreach (var work in projects) retired.Add(StaleKey(work.Scope, work.Project, null));
            pending.Clear();
            order.Clear();
            deletions.Clear();
            queuedReads.Clear();
            thread = worker;
        }
        try { lifetime.Cancel(); } catch (ObjectDisposedException) { }
        // A queued deletion is a file a later session must not load: done first, each only a delete, for at most a second, so
        // it is done well within the grace main gives a backend that is stopping (wire.timers.stopGraceMs) whatever the writer
        // is busy with. Only then does it wait, briefly, for the writer to clear its temporary file away.
        if (at is not null && (deleting.Count + projects.Count > 0 || clearing) && RealFolder(at.Folder))
        {
            using var budget = new CancellationTokenSource(TimeSpan.FromSeconds(1));
            try
            {
                // A clear standing for more remembered deletions than were kept does them all.
                if (clearing) Clear(at, sameEpoch: false, budget.Token);
                foreach (var work in deleting)
                {
                    budget.Token.ThrowIfCancellationRequested();
                    Remove(at, work);
                }
                foreach (var work in projects) DropProject(at, work, budget.Token);
            }
            catch (OperationCanceledException) { /* The second is up: main's grace is the bound. */ }
        }
        if (thread is not null && thread != Thread.CurrentThread) thread.Join(TimeSpan.FromMilliseconds(500));
    }
}

/// <summary>What a connection's index tells the store (<see cref="ConnectionIndex.Sink"/>): each read as it is held, each unit
/// dropped because its source no longer has it. It decides what is saved:
/// <list type="bullet">
/// <item>a read is saved when its index holds it, with what its header must say: a read without children (CHILDREN_LEFT_OUT)
/// and a read without definitions are saved as such (<see cref="IndexFileHeader.Children"/>, <see cref="IndexFileHeader.Definitions"/>),
/// so no load takes one for a whole read;</item>
/// <item>a read that failed part way (<see cref="DatabaseIndex.FailedPart"/>) is never saved, and leaves any earlier file as it is;</item>
/// <item>a BigQuery dataset is saved after each pass with its own facts (which objects have details, which are carried from an
/// earlier read) and a sync state that says what the pass left to do (<see cref="BigQuerySync"/>); a project's own entry, which is
/// no dataset, is not a unit;</item>
/// <item>a read its builder marks as not to be saved (<see cref="DatabaseIndex.SaveWhenHeld"/>: a dataset DDL marked stale
/// while it was being read) is not, nor is one the store itself loaded.</item>
/// </list></summary>
internal sealed class IndexStoreSink(IndexStore store, IndexStoreScope scope)
{
    public IndexStoreScope Scope => scope;

    private IndexUnitKind? KindOf(DatabaseIndex read) =>
        scope.Provider == IndexProvider.BigQuery ? read.Dataset is null ? null : IndexUnitKind.Dataset : read.Dataset is null ? IndexUnitKind.Database : null;

    /// <summary>A database's or a dataset's read is held.</summary>
    public void Held(DatabaseIndex read)
    {
        if (KindOf(read) is { } kind) Held(kind, read);
    }

    /// <summary>The server's or Agent's read is held (a SQL Server connection's only).</summary>
    public void Held(IndexUnitKind kind, DatabaseIndex read)
    {
        if (read.FailedPart || !read.SaveWhenHeld || scope.Provider == IndexProvider.BigQuery != (kind == IndexUnitKind.Dataset)) return;
        store.Save(scope, kind, read);
    }

    public void HeldResource(ResourceSet set)
    {
        if (scope.Provider == IndexProvider.SqlServer) store.SaveResource(set);
    }

    /// <summary>A database or dataset the source no longer lists: its queued save and its file go.</summary>
    public void Gone(DatabaseIndex read)
    {
        if (KindOf(read) is { } kind) store.Drop(scope, kind, read.Database, read.Dataset);
    }

    /// <summary>A BigQuery dataset DDL changed: what was saved of it is stale until a build reads it again.</summary>
    public void Stale(string project, string dataset) => store.MarkStale(scope, project, dataset);

    /// <summary>The index no longer holds <paramref name="read"/>: a save still queued for it is withdrawn.</summary>
    public void Released(DatabaseIndex read) => store.Released(read);

    /// <summary>The store's stale count as a BigQuery read begins.</summary>
    public long StaleSeq => store.StaleSeq;
}

/// <summary>
/// What a BigQuery dataset's file says beside its unit (<see cref="DatabaseIndex.Sync"/>): what the listing and the details pass
/// left, which the unit's own facts do not say as a whole. The unit already holds, per object, what a later listing is compared
/// with (its creation time, a routine's or model's last change, whether its details are whole, carried or stale).
/// <code>u8 1 | u8 flags (1 the listing was cut, 2 details still to read, 4 details failed or left out) | i32 to read | i32 failed | i32 left out</code>
/// </summary>
internal readonly record struct BigQuerySync(bool ListingCut, int Pending, int Failed, int LeftOut)
{
    public const int Bytes = 14;

    public byte[] ToBytes()
    {
        var bytes = new byte[Bytes];
        bytes[0] = 1;
        bytes[1] = (byte)((ListingCut ? 1 : 0) | (Pending > 0 ? 2 : 0) | (Failed > 0 || LeftOut > 0 ? 4 : 0));
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(2), Pending);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(6), Failed);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(10), LeftOut);
        return bytes;
    }

    /// <summary>Null for bytes this version did not write (a loader then reads the dataset's details again).</summary>
    public static BigQuerySync? From(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length != Bytes || bytes[0] != 1 || bytes[1] > 7) return null;
        var (pending, failed, leftOut) = (System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(bytes[2..]), System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(bytes[6..]),
            System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(bytes[10..]));
        return pending < 0 || failed < 0 || leftOut < 0 ? null : new((bytes[1] & 1) != 0, pending, failed, leftOut);
    }
}
