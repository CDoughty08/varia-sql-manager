namespace Varia.Backend.Search;

/// <summary>What identifies one resource database's objects: the server's version and edition, and the fingerprint
/// (<see cref="ObjectSearchSql.ResourceFingerprint"/>) of the objects the login sees, plus whether definitions were read.</summary>
internal sealed record ResourceKey(string Version, int Edition, long Count, DateTime? Latest, int Checksum, bool Definitions);

/// <summary>The resource database's objects for one key: the sys and INFORMATION_SCHEMA views, procedures and functions that
/// every database of every server with that key shows. Search lists them once per connection, not once per database.</summary>
internal sealed class ResourceSet(ResourceKey key, IndexedObject[] objects, int modules, int cut, long bytes = 0)
{
    public ResourceKey Key { get; } = key;
    /// <summary>The memory its records hold, charged once whatever the connections that share it; its names and definitions are
    /// the pool's.</summary>
    public long Bytes { get; } = bytes;
    public IndexedObject[] Objects { get; } = objects;
    public int Modules { get; } = modules;
    public int Cut { get; } = cut;
}

/// <summary>
/// The resource database's objects, shared by every connection whose server has the same key, reference counted and dropped
/// when the last connection lets go. Its names and definitions come from the <see cref="StringPool"/>, so two builds whose
/// system modules overlap (a cumulative update changes few of them), and the databases that hold the same text, share each
/// identical text. A set's records and names are charged whatever the budget holds (every connection needs them, and they are a
/// few MiB); a definition is left out when less than <paramref name="keepFree"/> is free.
/// </summary>
internal sealed class ResourceCatalog(StringPool pool, long keepFree = 0)
{
    private readonly object gate = new();
    private readonly Dictionary<ResourceKey, Entry> sets = [];

    private sealed class Entry(CancellationTokenSource lifetime)
    {
        /// <summary>The shared read's own lifetime: its limit, or the last waiter leaving. No caller's token stops it, so a
        /// connection that stops its build (or disconnects) never aborts another's wait.</summary>
        public CancellationTokenSource Lifetime { get; } = lifetime;
        public TaskCompletionSource<ResourceSet> Load { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        /// <summary>References: callers waiting or holding the set.</summary>
        public int Refs;
        /// <summary>The read finished and its set is charged to the pool (under the gate).</summary>
        public ResourceSet? Shared;
        /// <summary>Every waiter left before the read finished: its result is not kept.</summary>
        public bool Abandoned;
    }

    /// <summary>Sets held (the checks read it).</summary>
    public int Sets { get { lock (gate) return sets.Count; } }

    /// <summary>The set for <paramref name="key"/>, read by <paramref name="read"/> only when no connection holds it (or is reading
    /// it); a caller that shares a read waits for it. The read runs under its own token, limited to <paramref name="limit"/> and
    /// cancelled only when every caller waiting for it has stopped (<paramref name="token"/>); a read past its limit throws
    /// <see cref="TimeoutException"/>. Each successful call takes a reference that <see cref="Release"/> gives back.</summary>
    public async Task<ResourceSet> AcquireAsync(ResourceKey key, Func<CancellationToken, Task<IndexedObject[]>> read, TimeSpan? limit = null, CancellationToken token = default)
    {
        token.ThrowIfCancellationRequested();
        Entry entry;
        var start = false;
        lock (gate)
        {
            if (!sets.TryGetValue(key, out entry!))
            {
                entry = new Entry(new CancellationTokenSource());
                if (limit is { } bound) entry.Lifetime.CancelAfter(bound);
                sets[key] = entry;
                start = true;
            }
            entry.Refs++;
        }
        if (start) _ = RunAsync(key, entry, read);
        try { return await entry.Load.Task.WaitAsync(token); }
        catch
        {
            CancellationTokenSource? stop = null;
            lock (gate)
            {
                if (--entry.Refs == 0 && entry.Shared is null && !entry.Abandoned)
                {
                    // The last waiter left a read still running: stop it and let the next build read again.
                    entry.Abandoned = true;
                    if (sets.TryGetValue(key, out var current) && ReferenceEquals(current, entry)) sets.Remove(key);
                    stop = entry.Lifetime;
                }
                else if (entry.Refs == 0 && entry.Shared is { } set && sets.TryGetValue(key, out var current) && ReferenceEquals(current, entry))
                {
                    // The read finished as the last waiter left: nobody holds the set.
                    sets.Remove(key);
                    Drop(set);
                }
            }
            try { stop?.Cancel(); } catch (ObjectDisposedException) { }
            throw;
        }
    }

    /// <summary>Runs the shared read and completes <see cref="Entry.Load"/>; it never throws.</summary>
    private async Task RunAsync(ResourceKey key, Entry entry, Func<CancellationToken, Task<IndexedObject[]>> read)
    {
        try
        {
            var objects = await read(entry.Lifetime.Token);
            lock (gate)
            {
                if (entry.Abandoned) throw new OperationCanceledException(entry.Lifetime.Token);
                entry.Shared = Share(key, objects);
            }
            entry.Load.SetResult(entry.Shared);
        }
        catch (Exception error)
        {
            // A failed read is not kept: the next build reads again.
            bool abandoned;
            lock (gate)
            {
                abandoned = entry.Abandoned;
                if (sets.TryGetValue(key, out var current) && ReferenceEquals(current, entry)) sets.Remove(key);
            }
            entry.Load.SetException(!abandoned && entry.Lifetime.IsCancellationRequested ? new TimeoutException("The shared read took longer than its limit.", error) : error);
        }
        finally { entry.Lifetime.Dispose(); }
    }

    /// <summary>Gives back one reference; the last one drops the set and its references to pooled texts.</summary>
    public void Release(ResourceSet set)
    {
        lock (gate)
        {
            if (!sets.TryGetValue(set.Key, out var entry) || !ReferenceEquals(entry.Shared, set)) return;
            if (--entry.Refs > 0) return;
            sets.Remove(set.Key);
            Drop(set);
        }
    }

    private void Drop(ResourceSet set)
    {
        pool.Budget.Release(set.Bytes);
        pool.Release(set.Objects.SelectMany(Texts));
    }

    /// <summary>The texts of an object a set holds one pool reference to each.</summary>
    private static IEnumerable<string?> Texts(IndexedObject item) => [item.Name, item.Schema, item.ParentSchema, item.ParentName, item.Definition];

    /// <summary>The set with each text swapped for the pool's copy, one reference per use; a definition the budget refuses is left
    /// out and counted as cut.</summary>
    private ResourceSet Share(ResourceKey key, IndexedObject[] objects)
    {
        var modules = 0;
        var cut = 0;
        var bytes = objects.Length * IndexMemory.RecordBytes;
        pool.Budget.Force(bytes);
        string? Name(string? value) => value is null ? null : pool.TryAcquire(value, force: true);
        for (var at = 0; at < objects.Length; at++)
        {
            var item = objects[at];
            var definition = item.Definition is { } text ? pool.TryAcquire(text, keepFree) : null;
            if (item.Definition is not null && definition is null) cut++;
            else if (definition is not null) { modules++; if (item.DefinitionCut) cut++; }
            objects[at] = item with
            {
                Name = Name(item.Name)!, Schema = Name(item.Schema), ParentSchema = Name(item.ParentSchema), ParentName = Name(item.ParentName),
                Definition = definition, DefinitionCut = definition is not null && item.DefinitionCut
            };
        }
        return new ResourceSet(key, objects, modules, cut, bytes);
    }
}
