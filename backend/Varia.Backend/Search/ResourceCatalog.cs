namespace Varia.Backend.Search;

/// <summary>What identifies one resource database's objects: the server's version and edition, and the fingerprint
/// (<see cref="ObjectSearchSql.ResourceFingerprint"/>) of the objects the login sees, plus whether definitions were read.</summary>
internal sealed record ResourceKey(string Version, int Edition, long Count, DateTime? Latest, int Checksum, bool Definitions);

/// <summary>The resource database's objects for one key: the sys and INFORMATION_SCHEMA views, procedures and functions that
/// every database of every server with that key shows. Search lists them once per connection, not once per database.</summary>
internal sealed class ResourceSet(ResourceKey key, ObjectTable table, int modules, int cut, long bytes = 0, int leftOut = 0)
{
    public ResourceKey Key { get; } = key;
    /// <summary>The memory its records hold, charged once whatever the connections that share it; its names and definitions are
    /// the pool's.</summary>
    public long Bytes { get; } = bytes;
    public ObjectTable Table { get; } = table;
    public int Modules { get; } = modules;
    public int Cut { get; } = cut;
    /// <summary>The part of <see cref="Cut"/> left out whole because the index's memory ran out.</summary>
    public int LeftOut { get; } = leftOut;
}

/// <summary>What a shared read answers: the objects, and for a set loaded from a file (<see cref="IndexFile.LoadResource"/>) how
/// many definitions it had left out for memory when it was saved.</summary>
internal readonly record struct SavedResource(ObjectTable Table, int LeftOut = 0);

/// <summary>
/// The resource database's objects, shared by every connection whose server has the same key, reference counted and dropped
/// when the last connection lets go. Its names and definitions come from the <see cref="StringPool"/>, so two builds whose
/// system modules overlap (a cumulative update changes few of them), and the databases that hold the same text, share each
/// identical text. A set's records and names are charged whatever the budget holds (every connection needs them, and they are a
/// few MiB); a definition is left out when less than <paramref name="keepFree"/> (the names' reserve, read as each set is
/// shared, since a build may change the limit) is free.
/// </summary>
internal sealed class ResourceCatalog(StringPool pool, Func<long>? keepFree = null)
{
    private readonly object gate = new();
    private readonly Dictionary<ResourceKey, Entry> sets = [];
    /// <summary>Sets a newer read of the same key replaces (<see cref="Retire"/>), kept charged until their last holder lets go.</summary>
    private readonly Dictionary<ResourceSet, Entry> retired = new(ReferenceEqualityComparer.Instance);

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

    /// <summary>The sets read and charged to the budget, each once however many connections hold it (the Memory panel's Nerd metrics).</summary>
    public List<ResourceSet> Held { get { lock (gate) return [.. sets.Values.Select(entry => entry.Shared).OfType<ResourceSet>(), .. retired.Keys]; } }

    /// <summary>Whether <paramref name="set"/> is the one its key is shared as now (not retired for a newer read).</summary>
    public bool Current(ResourceSet set)
    {
        lock (gate) return sets.TryGetValue(set.Key, out var entry) && ReferenceEquals(entry.Shared, set);
    }

    /// <summary>Stops sharing <paramref name="set"/>, so the next <see cref="AcquireAsync"/> for its key reads the objects again: for
    /// a set whose definitions were left out for memory, once there is room. Connections that hold it keep it, charged, until
    /// each lets go (its own next build takes the newer set).</summary>
    public void Retire(ResourceSet set)
    {
        lock (gate)
        {
            if (!sets.TryGetValue(set.Key, out var entry) || !ReferenceEquals(entry.Shared, set)) return;
            sets.Remove(set.Key);
            retired[set] = entry;
        }
    }

    /// <summary>The set for <paramref name="key"/>, read by <paramref name="read"/> only when no connection holds it (or is reading
    /// it); a caller that shares a read waits for it. The read runs under its own token, limited to <paramref name="limit"/> and
    /// cancelled only when every caller waiting for it has stopped (<paramref name="token"/>); a read past its limit throws
    /// <see cref="TimeoutException"/>. Each successful call takes a reference that <see cref="Release"/> gives back.</summary>
    public Task<ResourceSet> AcquireAsync(ResourceKey key, Func<CancellationToken, Task<ObjectTable>> read, TimeSpan? limit = null, CancellationToken token = default) =>
        AcquireSavedAsync(key, async readToken => new SavedResource(await read(readToken)), limit, token);

    /// <summary>As <see cref="AcquireAsync"/>, for a read that may answer a set <see cref="IndexFile"/> loaded: such a set is shared
    /// exactly as a read's is (its names taken whatever the budget holds, a definition left out below the reserve), and the
    /// definitions it had already left out for memory when it was saved stay counted.</summary>
    public async Task<ResourceSet> AcquireSavedAsync(ResourceKey key, Func<CancellationToken, Task<SavedResource>> read, TimeSpan? limit = null, CancellationToken token = default)
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
                // The same, for a set retired meanwhile.
                else if (entry.Refs == 0 && entry.Shared is { } gone && retired.Remove(gone)) Drop(gone);
            }
            try { stop?.Cancel(); } catch (ObjectDisposedException) { }
            throw;
        }
    }

    /// <summary>Runs the shared read and completes <see cref="Entry.Load"/>; it never throws.</summary>
    private async Task RunAsync(ResourceKey key, Entry entry, Func<CancellationToken, Task<SavedResource>> read)
    {
        try
        {
            var objects = await read(entry.Lifetime.Token);
            lock (gate)
            {
                if (entry.Abandoned) throw new OperationCanceledException(entry.Lifetime.Token);
                entry.Shared = Share(key, objects.Table, objects.LeftOut);
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
            if (sets.TryGetValue(set.Key, out var entry) && ReferenceEquals(entry.Shared, set))
            {
                if (--entry.Refs > 0) return;
                sets.Remove(set.Key);
                Drop(set);
            }
            else if (retired.TryGetValue(set, out var old) && --old.Refs <= 0)
            {
                retired.Remove(set);
                Drop(set);
            }
        }
    }

    private void Drop(ResourceSet set)
    {
        pool.Budget.Release(set.Bytes);
        pool.Release(set.Table.Texts);
    }

    /// <summary>The set with each distinct text swapped for the pool's copy, one reference per set: names are taken whatever the
    /// budget holds, and a definition the budget refuses is left out and counted as cut.</summary>
    private ResourceSet Share(ResourceKey key, ObjectTable table, int alreadyLeftOut)
    {
        var bytes = table.Count * IndexMemory.RecordBytes + (table.Details?.Bytes ?? 0);
        pool.Budget.Force(bytes);
        var names = table.NameTexts();
        var texts = table.Texts;
        var copies = new object?[texts.Count];
        var reserve = keepFree?.Invoke() ?? 0;
        for (var at = 0; at < copies.Length; at++)
            if (texts[at] is { } text) copies[at] = names[at] ? pool.TryAcquire(text, force: true) : pool.TryAcquire(text, reserve);
        var shared = table.WithTexts(copies);
        var modules = 0;
        // A saved set's entries no longer say which of them lost a definition to memory before it was saved: only how many.
        var cut = alreadyLeftOut;
        var leftOut = alreadyLeftOut;
        for (var at = 0; at < shared.Count; at++)
        {
            if (shared.HasDefinition(at)) { modules++; if (shared.DefinitionCut(at)) cut++; }
            else if (table.HasDefinition(at)) { cut++; leftOut++; }
        }
        return new ResourceSet(key, shared, modules, cut, bytes, leftOut);
    }
}
