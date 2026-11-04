namespace Varia.Backend.Search;

/// <summary>What identifies one resource database's objects: the server's version and edition, and the fingerprint
/// (<see cref="ObjectSearchSql.ResourceFingerprint"/>) of the objects the login sees, plus whether definitions were read.</summary>
internal sealed record ResourceKey(string Version, int Edition, long Count, DateTime? Latest, int Checksum, bool Definitions);

/// <summary>The resource database's objects for one key: the sys and INFORMATION_SCHEMA views, procedures and functions that
/// every database of every server with that key shows. Search lists them once per connection, not once per database.</summary>
internal sealed class ResourceSet(ResourceKey key, IndexedObject[] objects, int modules, int cut)
{
    public ResourceKey Key { get; } = key;
    public IndexedObject[] Objects { get; } = objects;
    public int Modules { get; } = modules;
    public int Cut { get; } = cut;
}

/// <summary>
/// The resource database's objects, shared by every connection whose server has the same key, reference counted and dropped
/// when the last connection lets go. Definitions are interned across sets too: two builds whose system modules overlap (a
/// cumulative update changes few of them) hold and charge each identical text once against the shared budget.
/// </summary>
internal sealed class ResourceCatalog(IndexBudget budget)
{
    private readonly object gate = new();
    private readonly Dictionary<ResourceKey, Entry> sets = [];
    private readonly Dictionary<string, Shared> texts = new(StringComparer.Ordinal);

    private sealed class Entry(Task<ResourceSet> load)
    {
        public Task<ResourceSet> Load { get; } = load;
        public int Refs;
    }
    private sealed class Shared(string value)
    {
        public string Value { get; } = value;
        public int Refs;
    }

    /// <summary>Sets held (the checks read it).</summary>
    public int Sets { get { lock (gate) return sets.Count; } }
    /// <summary>Distinct definition texts held (the checks read it).</summary>
    public int Texts { get { lock (gate) return texts.Count; } }

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

    /// <summary>Gives back one reference; the last one drops the set and the definitions no other set holds.</summary>
    public void Release(ResourceSet set)
    {
        lock (gate)
        {
            if (!sets.TryGetValue(set.Key, out var entry) || !entry.Load.IsCompletedSuccessfully || !ReferenceEquals(entry.Load.Result, set)) return;
            if (--entry.Refs > 0) return;
            sets.Remove(set.Key);
            foreach (var item in set.Objects)
            {
                if (item.Definition is not { } text || !texts.TryGetValue(text, out var shared) || --shared.Refs > 0) continue;
                texts.Remove(text);
                budget.Release(text.Length);
            }
        }
    }

    /// <summary>The set with each definition swapped for the one already held, or charged to the budget when new; one the budget
    /// refuses is left out and counted as cut.</summary>
    private ResourceSet Share(ResourceKey key, IndexedObject[] objects)
    {
        var modules = 0;
        var cut = 0;
        lock (gate)
        {
            for (var at = 0; at < objects.Length; at++)
            {
                if (objects[at].Definition is not { } text) continue;
                if (!texts.TryGetValue(text, out var shared))
                {
                    if (!budget.TryTake(text.Length)) { objects[at] = objects[at] with { Definition = null, DefinitionCut = false }; cut++; continue; }
                    shared = new Shared(text);
                    texts[text] = shared;
                }
                shared.Refs++;
                modules++;
                if (objects[at].DefinitionCut) cut++;
                objects[at] = objects[at] with { Definition = shared.Value };
            }
        }
        return new ResourceSet(key, objects, modules, cut);
    }
}
