using System.Globalization;
using Varia.Backend.BigQuery;

namespace Varia.Backend.Search;

/// <summary>What BigQuery builds took from the saved index (the checks read it; never a name).</summary>
/// <param name="Loaded">Datasets loaded from their files and held.</param>
/// <param name="Refused">Files passed over as unreadable: a header or body that does not open (another key, damage, another
/// version's sync bytes), or a file that is not the unit it says.</param>
/// <param name="Budget">Files that did not fit the index's memory (or BigQuery's part of it) and stayed on disk.</param>
/// <param name="Stale">Files left because DDL marked the dataset stale, a newer save or a deletion of it is queued, or the file was
/// written again after it was listed.</param>
/// <param name="Unchanged">Datasets a listing found unchanged: held as loaded (or as read before), the file only marked used.</param>
/// <param name="Pruned">Files deleted because their project's listing no longer names the dataset (and no read of it was held).</param>
internal readonly record struct SavedLoadCounts(long Loaded, long Refused, long Budget, long Stale, long Unchanged, long Pruned);

internal sealed partial class ObjectSearchService
{
    private long savedLoaded, savedRefused, savedBudget, savedStale, savedUnchanged, savedPruned;

    /// <summary>Checks: how many loaded reads the connection still remembers as unchecked.</summary>
    internal int SavedEntries(string connectionId)
    {
        if (!states.TryGetValue(connectionId, out var state)) return 0;
        lock (state.Gate) return state.Saved.Count;
    }

    /// <summary>Checks: called with a saved dataset's project and name just before it is loaded.</summary>
    internal Action<string, string>? SavedLoading { get; set; }

    internal SavedLoadCounts SavedLoads => new(Interlocked.Read(ref savedLoaded), Interlocked.Read(ref savedRefused), Interlocked.Read(ref savedBudget),
        Interlocked.Read(ref savedStale), Interlocked.Read(ref savedUnchanged), Interlocked.Read(ref savedPruned));

    /// <summary>
    /// The first full build of a BigQuery connection loads what its principal saved (docs/object-search.md, Saved index) before it
    /// makes any call: every dataset of the billing project and the starred ones, and with AllProjects every other project's,
    /// which wave 2 then keeps or drops as discovery says. Each is held as it loads, so a search finds it at once, and the
    /// build's listings then check it (<see cref="Unchanged"/>). The billing project's datasets load first, then the starred
    /// projects', then the rest, each charged as a read is, under BigQuery's floors; what does not fit stays on disk and is read
    /// as if nothing were saved, and once one discovered dataset does not fit, no other discovered one is tried. A dataset DDL
    /// marked stale, or whose file a newer save or a deletion is queued for, is never loaded. Every failure is a value: the
    /// dataset is read as if nothing were saved. Answers the units listed, by project, so a listing can delete those of datasets
    /// it no longer names that were not loaded.
    /// </summary>
    private Dictionary<string, List<SavedUnit>> LoadSaved(State state, CancellationTokenSource owner, string billing, IReadOnlySet<string> starred, bool allProjects,
        CancellationToken token)
    {
        var byProject = new Dictionary<string, List<SavedUnit>>(StringComparer.Ordinal);
        if (state.Index.Sink?.Scope is not { Provider: IndexProvider.BigQuery } scope) return byProject;
        lock (state.Gate)
        {
            // Loaded once per connection; a build that replaced the one still loading (which holds nothing more once replaced) loads
            // in its place, without waiting for it to notice.
            if (state.SavedLoaded || !ReferenceEquals(state.Build, owner) || state.SavedLoader is { } loader && ReferenceEquals(loader, state.Build)) return byProject;
            // Looked for once a store reads: one not configured yet (main configures it a moment after the backend starts) is
            // looked in by the next full build.
            if (!Store.Configured || Store.Mode is not (IndexStoreMode.Encrypted or IndexStoreMode.ClearText)) return byProject;
            state.SavedLoader = owner;
        }
        var done = false;
        try
        {
            var units = LoadSaved(state, owner, scope, billing, starred, allProjects, token);
            done = true;
            return units;
        }
        finally
        {
            // A build stopped or replaced while it loaded leaves the rest to the next full build (what landed stays held).
            lock (state.Gate)
            {
                if (ReferenceEquals(state.SavedLoader, owner)) state.SavedLoader = null;
                // A build replaced after its last load (that load left on disk) leaves the reload to the build that replaced it.
                if (done && ReferenceEquals(state.Build, owner)) state.SavedLoaded = true;
            }
        }
    }

    private Dictionary<string, List<SavedUnit>> LoadSaved(State state, CancellationTokenSource owner, IndexStoreScope scope, string billing, IReadOnlySet<string> starred,
        bool allProjects, CancellationToken token)
    {
        var byProject = new Dictionary<string, List<SavedUnit>>(StringComparer.Ordinal);
        // Marks made after this are DDL the listed files may predate.
        var since = Store.StaleSeq;
        var units = Store.List(scope, out var unreadable, token);
        Interlocked.Add(ref savedRefused, unreadable);
        int Rank(string project) => project == billing ? 0 : starred.Contains(project) ? 1 : 2;
        var wanted = units.Where(unit => unit is { Kind: IndexUnitKind.Dataset, Dataset: { } dataset } && BqNames.IsProject(unit.Database) && BqNames.IsDataset(dataset)
                && (allProjects || Rank(unit.Database) < 2))
            .OrderBy(unit => Rank(unit.Database)).ThenBy(unit => unit.Database, StringComparer.Ordinal).ThenBy(unit => unit.Dataset, StringComparer.Ordinal).ToList();
        foreach (var unit in wanted)
        {
            if (!byProject.TryGetValue(unit.Database, out var list)) byProject[unit.Database] = list = [];
            list.Add(unit);
        }
        var discoveredFull = false;
        foreach (var unit in wanted)
        {
            token.ThrowIfCancellationRequested();
            var (project, dataset) = (unit.Database, unit.Dataset!);
            var key = project + "\u0001" + dataset;
            var discovered = Rank(project) == 2;
            if (discovered && discoveredFull) { Interlocked.Increment(ref savedBudget); continue; }
            // Another version's sync bytes say nothing this build can check the file with: the dataset is read again.
            if (BigQuerySync.From(unit.Sync) is null) { Interlocked.Increment(ref savedRefused); continue; }
            bool Standing()
            {
                // Under state.Gate.
                return ReferenceEquals(state.Build, owner) && state.Index.Get(key) is null && !state.Stale.ContainsKey((project, dataset))
                    && !state.StaleProjects.ContainsKey(project) && Store.Settled(unit, scope, since);
            }
            lock (state.Gate)
            {
                if (!ReferenceEquals(state.Build, owner)) throw new OperationCanceledException(token);
                if (!Standing()) { Interlocked.Increment(ref savedStale); continue; }
            }
            SavedLoading?.Invoke(project, dataset);
            var loaded = Store.Load(unit, state.Index, Limits, pool, discovered: discovered, childrenFallback: true, token: token);
            if (loaded.Value is not { } read)
            {
                switch (loaded.Problem)
                {
                    case IndexFileProblem.Cancelled: throw new OperationCanceledException(token);
                    case IndexFileProblem.Budget:
                        Interlocked.Increment(ref savedBudget);
                        // As wave 2 stops reading new discovered datasets once one does not fit: the others would not either.
                        if (discovered) discoveredFull = true;
                        break;
                    // Deleted since it was listed (DDL from another connection, a prune): gone, not unreadable.
                    case IndexFileProblem.Io when Store.Find(scope, IndexUnitKind.Dataset, project, dataset) is null:
                        Interlocked.Increment(ref savedStale);
                        break;
                    default: Interlocked.Increment(ref savedRefused); break;
                }
                continue;
            }
            // A newer file written since the listing (another connection's save) is not the one its sync bytes describe.
            if (loaded.Header is not { } header || header.ReadAt != unit.Header.ReadAt || header.Objects != unit.Header.Objects)
            {
                state.Index.Abandon(read);
                Interlocked.Increment(ref savedStale);
                continue;
            }
            // The read compares a later listing with what its file says (it is the file's: a load is never saved again).
            read.Sync = unit.Sync;
            // As a read begun now: DDL any connection of the principal marks after this has its listing read the dataset whole.
            read.StaleSeen = since;
            var held = false;
            lock (state.Gate)
            {
                // DDL that landed while it loaded, or a build that replaced this one, leaves it on disk.
                if (Standing())
                {
                    state.Index.Put(read);
                    var ticks = Utc(read.ReadAt).Ticks;
                    state.Saved[key] = (new WeakReference<DatabaseIndex>(read), unit, ticks);
                    state.SavedOrder.Add((ticks, key));
                    SavedAtLocked(state);
                    held = true;
                }
            }
            if (held) Interlocked.Increment(ref savedLoaded);
            else
            {
                state.Index.Abandon(read);
                Interlocked.Increment(ref savedStale);
                token.ThrowIfCancellationRequested();
            }
        }
        return byProject;
    }

    /// <summary>
    /// Whether a dataset's listing leaves its held read as it is: not forced (DDL, a refresh), no object's details to read
    /// again, the earlier read whole (its columns held, nothing pending, failed or left out, definitions as this build keeps them) and made from a listing with the same
    /// digest. Then nothing is read or held anew and the dataset's file is only marked used, so an unchanged dataset is never
    /// saved again; a file that is gone (deleted by DDL from another connection, or never written) is saved by the usual read.
    /// </summary>
    private bool Unchanged(State state, CancellationTokenSource owner, string project, string dataset, DatabaseIndex? earlier, string digest, bool definitions)
    {
        // A read with definitions stays one only for a build that keeps them (one without them reads its objects bare).
        if (earlier is not { ChildrenLeftOut: false, FailedPart: false } || earlier.DefinitionsLeftOut == definitions || BigQuerySync.From(earlier.Sync.Span) is not { Whole: true } sync || sync.Listing != digest
            || state.Index.Sink?.Scope is not { } scope) return false;
        var key = project + "\u0001" + dataset;
        SavedUnit? unit;
        lock (state.Gate) unit = state.Saved.TryGetValue(key, out var saved) && saved.Read.TryGetTarget(out var loaded) && ReferenceEquals(loaded, earlier) ? saved.Unit : null;
        // A read this session made: its file, if it is the one that read wrote.
        unit ??= Store.Find(scope, IndexUnitKind.Dataset, project, dataset) is { } found && BigQuerySync.From(found.Sync) == sync ? found : null;
        if (unit is null || !Store.MarkUsed(unit)) return false;
        lock (state.Gate)
        {
            if (!ReferenceEquals(state.Build, owner) || !ReferenceEquals(state.Index.Get(key), earlier)) return false;
            if (state.Saved.Remove(key, out var checkedRead))
            {
                state.SavedOrder.Remove((checkedRead.Ticks, key));
                SavedAtLocked(state);
            }
        }
        Interlocked.Increment(ref savedUnchanged);
        return true;
    }

    /// <summary>Deletes the files of a project's datasets its listing no longer names that were listed at load and were not held
    /// as the listing landed (<paramref name="held"/>: a held one's file goes as its read is dropped).</summary>
    private void PruneSaved(State state, Dictionary<string, List<SavedUnit>>? saved, string project, HashSet<string> names, IReadOnlySet<string> held)
    {
        if (saved is null || !saved.TryGetValue(project, out var units)) return;
        foreach (var unit in units)
        {
            if (names.Contains(unit.Dataset!) || held.Contains(unit.Dataset!) || state.Index.Get(project + "\u0001" + unit.Dataset) is not null) continue;
            Store.Delete(unit);
            Interlocked.Increment(ref savedPruned);
        }
        saved.Remove(project);
    }

    /// <summary>Under state.Gate: answers when the oldest loaded read still held was read, which the status and the build's progress
    /// say while it has not been checked. Only the oldest entries are looked at: those no longer held (replaced by a new read, or
    /// dropped) are forgotten as they come up, so a build with thousands of loaded datasets pays little per hold.</summary>
    private static DateTime? SavedAtLocked(State state)
    {
        DateTime? oldest = null;
        while (state.SavedOrder.Count > 0)
        {
            var (ticks, key) = state.SavedOrder.Min;
            var entry = state.Saved.TryGetValue(key, out var saved) && saved.Ticks == ticks;
            if (entry && saved.Read.TryGetTarget(out var read) && ReferenceEquals(state.Index.Get(key), read))
            {
                oldest = new DateTime(ticks, DateTimeKind.Utc);
                break;
            }
            state.SavedOrder.Remove((ticks, key));
            if (entry) state.Saved.Remove(key);
        }
        state.SavedAt = oldest;
        state.SavedAtText = SavedAtText(oldest);
        return oldest;
    }

    private static DateTime Utc(DateTime at) => at.Kind == DateTimeKind.Local ? at.ToUniversalTime() : DateTime.SpecifyKind(at, DateTimeKind.Utc);

    /// <summary>The status's and the progress's savedAt: UTC to the second, the same text whatever the culture.</summary>
    internal static string? SavedAtText(DateTime? at) => at?.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
}
