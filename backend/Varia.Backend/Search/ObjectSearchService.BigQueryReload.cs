using System.Globalization;
using Varia.Backend.BigQuery;

namespace Varia.Backend.Search;

/// <summary>What BigQuery builds took from the saved index (the checks read it; never a name).</summary>
/// <param name="Loaded">Datasets loaded from their files and held.</param>
/// <param name="Refused">Files passed over as unreadable: a header or body that does not open (another key, damage, another
/// version's sync bytes), or a file that is not the unit it says.</param>
/// <param name="Budget">Files that did not fit the index's memory (or BigQuery's part of it) and stayed on disk.</param>
/// <param name="Stale">Files left because DDL marked the dataset stale, or a newer save or a deletion of it is queued.</param>
/// <param name="Unchanged">Datasets a listing found unchanged: held as loaded (or as read before), the file only marked used.</param>
/// <param name="Pruned">Files deleted because their project's listing no longer names the dataset (and no read of it was held).</param>
internal readonly record struct SavedLoadCounts(long Loaded, long Refused, long Budget, long Stale, long Unchanged, long Pruned);

internal sealed partial class ObjectSearchService
{
    private long savedLoaded, savedRefused, savedBudget, savedStale, savedUnchanged, savedPruned;

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
            if (state.SavedLooked || !ReferenceEquals(state.Build, owner)) return byProject;
            // Looked for once a store reads: one not configured yet (main configures it a moment after the backend starts) is
            // looked in by the next full build.
            if (!Store.Configured || Store.Mode is not (IndexStoreMode.Encrypted or IndexStoreMode.ClearText)) return byProject;
            state.SavedLooked = true;
        }
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
                    default: Interlocked.Increment(ref savedRefused); break;
                }
                continue;
            }
            // The read compares a later listing with what its file says (it is the file's: a load is never saved again).
            read.Sync = unit.Sync;
            var held = false;
            lock (state.Gate)
            {
                // DDL that landed while it loaded, or a build that replaced this one, leaves it on disk.
                if (Standing())
                {
                    state.Index.Put(read);
                    state.Saved[key] = (read, unit);
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
        lock (state.Gate) unit = state.Saved.TryGetValue(key, out var saved) && ReferenceEquals(saved.Read, earlier) ? saved.Unit : null;
        // A read this session made: its file, if it is the one that read wrote.
        unit ??= Store.Find(scope, IndexUnitKind.Dataset, project, dataset) is { } found && BigQuerySync.From(found.Sync) == sync ? found : null;
        if (unit is null || !Store.MarkUsed(unit)) return false;
        lock (state.Gate)
        {
            if (!ReferenceEquals(state.Build, owner) || !ReferenceEquals(state.Index.Get(key), earlier)) return false;
            if (state.Saved.Remove(key)) SavedAtLocked(state);
        }
        Interlocked.Increment(ref savedUnchanged);
        return true;
    }

    /// <summary>Deletes the files of a project's datasets its listing no longer names that were listed at load and are not held
    /// (a held one's file goes as its read is dropped).</summary>
    private void PruneSaved(State state, Dictionary<string, List<SavedUnit>>? saved, string project, HashSet<string> names)
    {
        if (saved is null || !saved.TryGetValue(project, out var units)) return;
        foreach (var unit in units)
        {
            if (names.Contains(unit.Dataset!) || state.Index.Get(project + "\u0001" + unit.Dataset) is not null) continue;
            Store.Delete(unit);
            Interlocked.Increment(ref savedPruned);
        }
        saved.Remove(project);
    }

    /// <summary>Under state.Gate: forgets the loaded reads no longer held (replaced by a new read, or dropped) and answers when
    /// the oldest one still held was read, which the status and the build's progress say while it has not been checked.</summary>
    private static DateTime? SavedAtLocked(State state)
    {
        DateTime? oldest = null;
        foreach (var (key, (read, _)) in state.Saved.ToList())
        {
            if (!ReferenceEquals(state.Index.Get(key), read)) { state.Saved.Remove(key); continue; }
            var at = read.ReadAt.Kind == DateTimeKind.Local ? read.ReadAt.ToUniversalTime() : DateTime.SpecifyKind(read.ReadAt, DateTimeKind.Utc);
            if (oldest is null || at < oldest) oldest = at;
        }
        state.SavedAt = oldest;
        state.SavedAtText = SavedAtText(oldest);
        return oldest;
    }

    /// <summary>The status's and the progress's savedAt: UTC to the second, the same text whatever the culture.</summary>
    internal static string? SavedAtText(DateTime? at) => at?.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
}
