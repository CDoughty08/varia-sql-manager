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

    private sealed class Entry(Task<ResourceSet> load)
    {
        public Task<ResourceSet> Load { get; } = load;
        public int Refs;
    }

    /// <summary>Sets held (the checks read it).</summary>
    public int Sets { get { lock (gate) return sets.Count; } }

    /// <summary>The set for <paramref name="key"/>, read by <paramref name="read"/> only when no connection holds it (or is reading
    /// it); a caller that shares a read waits for it. Each successful call takes a reference that <see cref="Release"/> gives back.</summary>
    public async Task<ResourceSet> AcquireAsync(ResourceKey key, Func<Task<IndexedObject[]>> read)
    {
        TaskCompletionSource<ResourceSet>? reading = null;
        Entry entry;
        lock (gate)
        {
            if (!sets.TryGetValue(key, out entry!))
            {
                reading = new(TaskCreationOptions.RunContinuationsAsynchronously);
                entry = new Entry(reading.Task);
                sets[key] = entry;
            }
            entry.Refs++;
        }
        if (reading is not null)
        {
            try { reading.SetResult(Share(key, await read())); }
            catch (Exception error)
            {
                // A failed read is not kept: the next build reads again.
                lock (gate) if (sets.TryGetValue(key, out var current) && ReferenceEquals(current, entry)) sets.Remove(key);
                reading.SetException(error);
            }
        }
        try { return await entry.Load; }
        catch
        {
            lock (gate) entry.Refs--;
            throw;
        }
    }

    /// <summary>Gives back one reference; the last one drops the set and its references to pooled texts.</summary>
    public void Release(ResourceSet set)
    {
        lock (gate)
        {
            if (!sets.TryGetValue(set.Key, out var entry) || !entry.Load.IsCompletedSuccessfully || !ReferenceEquals(entry.Load.Result, set)) return;
            if (--entry.Refs > 0) return;
            sets.Remove(set.Key);
            pool.Budget.Release(set.Bytes);
            pool.Release(set.Objects.SelectMany(Texts));
        }
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
