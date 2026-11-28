namespace Varia.Backend.Search;

/// <summary>One BigQuery dataset as the editor's lookup knows it: its name as the index holds it, its state, the read it answers
/// from (null when none is held) and the skip of its last read.</summary>
internal sealed record BigQueryLookupDataset(string Project, string Dataset, LookupState State, DatabaseIndex? Held, ObjectIndexSkip? Skip);

/// <summary>One cross-project fuzzy table/object jump match ranked Default dataset → Billing → ★ Starred → Recent → Discovered.</summary>
internal sealed record BigQueryJumpHit(string Project, string Dataset, LookupObject Entry, string Tier, bool Recent, bool NamesOnly, int TierRank, int MatchRank);

/// <summary>
/// The editor's in-process view of a BigQuery connection's index (docs/object-search.md, Editor lookup), the reader SQL Server's
/// <see cref="IndexLookup"/> is for its databases: projects, each project's datasets, a dataset's objects, a table's columns and
/// nested fields by path with their types and descriptions, and an object's facts (rows, size, partitioning, clustering, a
/// routine's signature, a sharded group). A snapshot of the build's state and the reads held when it is made; make one per request.
/// Projects match exactly, else the one that differs only in case; datasets and objects the same way (BigQuery tells their case
/// apart unless a dataset says otherwise); columns without case, as GoogleSQL reads them.
/// </summary>
internal sealed class BigQueryLookup
{
    private readonly IndexBudget budget;
    /// <summary>What a lookup array leaves free of the budget: BigQuery's names floor, as its reads do.</summary>
    private readonly long keepFree;
    private readonly string billing;
    private readonly HashSet<string> starred;
    private readonly HashSet<string> recent;
    private readonly HashSet<string> externalHydrated;
    private readonly HashSet<(string Project, string Dataset)> hydratedOnlyDatasets;
    private readonly Dictionary<string, string?> externalIgnoreCase = new(StringComparer.OrdinalIgnoreCase);
    private readonly Action? arraysBuilt;
    private readonly Dictionary<string, Dictionary<string, DatabaseIndex>> reads = new(StringComparer.Ordinal);
    private readonly HashSet<string> projectSet;
    private readonly Dictionary<string, string?> projectIgnoreCase = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> namesOnly;
    private readonly HashSet<string> partialProjects;
    private readonly Dictionary<string, ObjectIndexSkip> projectListingSkips;
    private readonly Dictionary<(string Project, string Dataset), ObjectIndexSkip> datasetSkips;
    private readonly List<ObjectIndexSkip> skips;
    private readonly HashSet<string> projectsWithListingSkip = new(StringComparer.Ordinal);
    private readonly HashSet<string> projectsWithAnyDatasetSkip = new(StringComparer.Ordinal);
    private readonly HashSet<string> projectsWithUnreadDatasetSkip = new(StringComparer.Ordinal);
    private readonly bool building, built;
    private readonly string? phase;

    internal BigQueryLookup(string billing, IReadOnlyList<string> extras, IEnumerable<DatabaseIndex> held, IEnumerable<string>? namesOnly, IEnumerable<ObjectIndexSkip> skips,
        bool building, bool built, IndexBudget budget, Action? arraysBuilt = null, IEnumerable<string>? partialProjects = null,
        IReadOnlyDictionary<string, ObjectIndexSkip>? projectListingSkips = null, IReadOnlyDictionary<(string Project, string Dataset), ObjectIndexSkip>? datasetSkips = null,
        long keepFree = 0, IEnumerable<string>? starredProjects = null, IEnumerable<string>? recentProjects = null, string? phase = null,
        IEnumerable<string>? externalHydratedProjects = null, IEnumerable<(string Project, string Dataset)>? hydratedOnlyDatasets = null)
    {
        this.billing = billing;
        this.phase = phase;
        this.keepFree = keepFree;
        var starredList = (starredProjects ?? []).Where(project => !string.IsNullOrEmpty(project) && project != billing).Distinct(StringComparer.Ordinal).ToList();
        this.starred = new HashSet<string>(starredList, StringComparer.Ordinal);
        this.externalHydrated = new HashSet<string>(externalHydratedProjects ?? [], StringComparer.Ordinal);
        this.hydratedOnlyDatasets = new HashSet<(string Project, string Dataset)>(hydratedOnlyDatasets ?? []);
        foreach (var read in held)
        {
            if (read.Dataset is not { } dataset) continue;
            if (!reads.TryGetValue(read.Database, out var datasets)) reads[read.Database] = datasets = new(StringComparer.Ordinal);
            datasets[dataset] = read;
        }
        // Tracked projects available for top-level listing: Billing → ★ Starred → Recently Queried → Discovered.
        // External-only hydrated projects stay out of top-level Projects until starred/discovered, while still resolving by path.
        var knownExtras = new HashSet<string>(extras, StringComparer.Ordinal);
        foreach (var project in reads.Keys)
            if (!this.externalHydrated.Contains(project)) knownExtras.Add(project);
        var ordered = new List<string>(1 + starredList.Count + extras.Count) { billing };
        var seen = new HashSet<string>(StringComparer.Ordinal) { billing };
        foreach (var project in starredList)
            if (seen.Add(project)) ordered.Add(project);
        var recentSet = new HashSet<string>(StringComparer.Ordinal);
        if (recentProjects is not null)
        {
            foreach (var project in recentProjects)
            {
                if (string.IsNullOrEmpty(project) || !knownExtras.Contains(project) || this.externalHydrated.Contains(project)) continue;
                if (seen.Add(project))
                {
                    ordered.Add(project);
                    recentSet.Add(project);
                }
            }
        }
        foreach (var extra in extras)
            if (!string.IsNullOrEmpty(extra) && !this.externalHydrated.Contains(extra) && seen.Add(extra)) ordered.Add(extra);
        this.recent = recentSet;
        Projects = ordered;
        this.projectSet = seen;
        foreach (var project in Projects)
        {
            if (projectIgnoreCase.TryGetValue(project, out var existing))
            {
                if (existing is not null && existing != project) projectIgnoreCase[project] = null;
            }
            else
            {
                projectIgnoreCase[project] = project;
            }
        }
        foreach (var project in this.externalHydrated)
        {
            if (seen.Contains(project)) continue;
            if (externalIgnoreCase.TryGetValue(project, out var existing))
            {
                if (existing is not null && existing != project) externalIgnoreCase[project] = null;
            }
            else
            {
                externalIgnoreCase[project] = project;
            }
        }
        this.namesOnly = new HashSet<string>(namesOnly ?? [], StringComparer.Ordinal);
        this.partialProjects = new HashSet<string>(partialProjects ?? [], StringComparer.Ordinal);
        this.projectListingSkips = projectListingSkips is null ? new(StringComparer.Ordinal) : new(projectListingSkips, StringComparer.Ordinal);
        this.datasetSkips = datasetSkips is null ? new() : new(datasetSkips);
        this.skips = [.. skips];
        foreach (var project in this.projectListingSkips.Keys) projectsWithListingSkip.Add(project);
        foreach (var key in this.datasetSkips.Keys)
        {
            projectsWithAnyDatasetSkip.Add(key.Project);
            if (!reads.TryGetValue(key.Project, out var datasets) || !datasets.ContainsKey(key.Dataset)) projectsWithUnreadDatasetSkip.Add(key.Project);
        }
        foreach (var skip in this.skips)
        {
            if (skip.Project is not { } proj) continue;
            if (skip.Database == "") projectsWithListingSkip.Add(proj);
            else
            {
                projectsWithAnyDatasetSkip.Add(proj);
                if (!reads.TryGetValue(proj, out var datasets) || !datasets.ContainsKey(skip.Database)) projectsWithUnreadDatasetSkip.Add(proj);
            }
        }
        (this.building, this.built, this.budget, this.arraysBuilt) = (building, built, budget, arraysBuilt);
    }

    /// <summary>The connection's billing project, then its starred, recently queried, and discovered projects.</summary>
    public IReadOnlyList<string> Projects { get; }

    /// <summary>Whether the connection has an index: none (never built), building, or ready (a build finished, or reads are held).</summary>
    public string Index => building ? "building" : built || reads.Count > 0 ? "ready" : "none";

    /// <summary>Whether a project's datasets were read by name only (no columns, view text or signatures).</summary>
    public bool NamesOnly(string project) => namesOnly.Contains(project);

    /// <summary>Whether a discovered project was recently queried in this connection.</summary>
    public bool IsRecent(string project) => recent.Contains(project);

    /// <summary>Whether a non-billing project is waiting for Wave 3 details while a full build is still running.</summary>
    public bool Wave3Pending(string project)
    {
        if (!building || phase is not ("projects" or "names" or "details") || string.Equals(project, billing, StringComparison.Ordinal) || namesOnly.Contains(project)) return false;
        if (reads.TryGetValue(project, out var datasets))
            return datasets.Values.Any(read => !read.Detailed && read.Table.Count > 1);
        return !projectsWithListingSkip.Contains(project);
    }

    /// <summary>Whether a dataset currently holds only individual JIT-hydrated objects rather than a full dataset listing.</summary>
    public bool IsHydratedOnly(string project, string dataset) => hydratedOnlyDatasets.Contains((project, dataset));

    /// <summary>Whether the index holds at least one top-level object in any tracked project (O(datasets), zero allocation).</summary>
    public bool HasAnyHeldObject()
    {
        foreach (var project in Projects)
        {
            if (!reads.TryGetValue(project, out var datasets)) continue;
            foreach (var read in datasets.Values)
                if (read.Facts is { Objects.Count: > 0 } || read.Table.Count > 1) return true;
        }
        return false;
    }

    /// <summary>The project's discovery tier: billing, starred, or discovered.</summary>
    public string ProjectTier(string project) =>
        string.Equals(project, billing, StringComparison.Ordinal) ? "billing"
        : starred.Contains(project) ? "starred"
        : "discovered";

    /// <summary>The project as the connection names it: exact, else the one that differs only in case; falls back to externally hydrated projects; null when unknown.</summary>
    public string? Project(string name) =>
        projectSet.TryGetValue(name, out var exact) ? exact
        : projectIgnoreCase.GetValueOrDefault(name)
        ?? (externalHydrated.TryGetValue(name, out var extExact) ? extExact : externalIgnoreCase.GetValueOrDefault(name));

    /// <summary>The state of a project as a whole: Absent when the connection has no such project, Skipped when its datasets could
    /// not be listed and none was read, Partial when its list may be short (a listing or a dataset's read failed), Building while a
    /// build that has read none of it runs, otherwise Ready.</summary>
    public LookupState ProjectState(string project)
    {
        if (Project(project) is not { } known) return LookupState.Absent;
        if (!projectSet.Contains(known) && externalHydrated.Contains(known)) return LookupState.Partial;
        var listing = projectsWithListingSkip.Contains(known);
        // Datasets read before a listing that failed (or was cut) still answer, but the list may be short; so it is when a dataset
        // listed but never read is left out of it.
        if (reads.ContainsKey(known))
            return listing || partialProjects.Contains(known) || projectsWithUnreadDatasetSkip.Contains(known) ? LookupState.Partial : LookupState.Ready;
        if (listing) return LookupState.Skipped;
        // Listed, but every dataset's read failed (or was refused for the budget): none answers.
        if (partialProjects.Contains(known) || projectsWithAnyDatasetSkip.Contains(known)) return building ? LookupState.Building : LookupState.Partial;
        return building ? LookupState.Building : Index == "none" ? LookupState.Absent : LookupState.Ready;
    }

    /// <summary>A project's datasets the index holds a read of, by name.</summary>
    public IReadOnlyList<string> Datasets(string project) =>
        Project(project) is { } known && reads.TryGetValue(known, out var datasets) ? [.. datasets.Keys.Order(StringComparer.Ordinal)] : [];

    /// <summary>One dataset: Ready when read whole; Partial when its columns were left out (the budget, or a project read by name
    /// only), some objects' details could not be read or a later read failed (or was cut) with an earlier one kept; Building while a
    /// build has not reached it; Skipped with its last read's skip; Absent otherwise. A name differing only in case finds its skip.</summary>
    public BigQueryLookupDataset Dataset(string project, string dataset)
    {
        var known = Project(project);
        if (known is null) return new(project, dataset, LookupState.Absent, null, null);
        reads.TryGetValue(known, out var datasets);
        // A skip spelled exactly as asked wins over a held dataset differing from it only in case.
        var exactSkip = datasets?.ContainsKey(dataset) != true
            && (datasetSkips.ContainsKey((known, dataset)) || skips.Any(item => item.Project == known && item.Database == dataset));
        var name = datasets is null || exactSkip ? dataset : Resolve(datasets.Keys, dataset) ?? dataset;
        var read = datasets?.GetValueOrDefault(name);
        var own = datasetSkips.GetValueOrDefault((known, name))
            ?? skips.LastOrDefault(item => item.Project == known && item.Database == name)
            ?? (read is null
                ? datasetSkips.FirstOrDefault(pair => pair.Key.Project == known && string.Equals(pair.Key.Dataset, name, StringComparison.OrdinalIgnoreCase)).Value
                    ?? skips.LastOrDefault(item => item.Project == known && item.Database != "" && string.Equals(item.Database, name, StringComparison.OrdinalIgnoreCase))
                : null);
        if (read is not null)
            return new(known, name, read.ChildrenLeftOut || namesOnly.Contains(known) || hydratedOnlyDatasets.Contains((known, name)) || own is not null ? LookupState.Partial : LookupState.Ready, read, own);
        var skip = own ?? projectListingSkips.GetValueOrDefault(known) ?? skips.LastOrDefault(item => item.Project == known && item.Database == "");
        if (skip is not null) return new(known, own?.Database ?? name, LookupState.Skipped, null, skip);
        if (partialProjects.Contains(known))
        {
            var budgetSkip = skips.LastOrDefault(item => item is { Project: "", Database: "", Code: "TOO_LARGE" } && item.Message.Contains("memory limit", StringComparison.OrdinalIgnoreCase))
                ?? new ObjectIndexSkip("", "TOO_LARGE", "The project was only partially indexed because the index reached its memory limit.", Project: "");
            return new(known, name, LookupState.Skipped, null, budgetSkip);
        }
        return new(known, name, building ? LookupState.Building : LookupState.Absent, null, null);
    }

    /// <summary>Bounded cross-project fuzzy table/object jump across RAM-indexed datasets, ranked
    /// Default dataset → Billing → ★ Starred → Recently Queried → Discovered. Strictly capped at <paramref name="limit"/>
    /// (at most <see cref="JumpLookupLimits.Items"/>) and <see cref="JumpLookupLimits.MaxScanObjects"/> scanned entries.
    /// Lazily visits tiers and keeps a bounded top-K list (&lt;= 50) per tier so large 5,000-project orgs stay fast and low-allocation.</summary>
    public IReadOnlyList<BigQueryJumpHit> JumpObjects(string query, string? defaultDataset, int limit, out bool truncated)
    {
        truncated = false;
        if (string.IsNullOrWhiteSpace(query) || reads.Count == 0) return [];
        var needle = query.Trim();
        if (needle.Length < JumpLookupLimits.MinPrefixChars) return [];
        if (limit <= 0)
        {
            truncated = HasAnyHeldObject();
            return [];
        }
        var cap = Math.Clamp(limit, 1, JumpLookupLimits.Items);

        var results = new List<BigQueryJumpHit>(cap);
        var scanned = 0;
        var anyTruncated = false;

        var billingRead = reads.GetValueOrDefault(billing);
        string? resolvedDefault = null;
        if (billingRead is not null && !string.IsNullOrEmpty(defaultDataset))
            resolvedDefault = Resolve(billingRead.Keys, defaultDataset);

        var tierHits = new List<(BigQueryJumpHit Hit, int ProjectOrder)>(cap);

        bool CompareBetter(int score, int pIdx, string dsName, string name, in (BigQueryJumpHit Hit, int ProjectOrder) other)
        {
            var cmp = score.CompareTo(other.Hit.MatchRank);
            if (cmp != 0) return cmp < 0;
            cmp = pIdx.CompareTo(other.ProjectOrder);
            if (cmp != 0) return cmp < 0;
            cmp = StringComparer.OrdinalIgnoreCase.Compare(dsName, other.Hit.Dataset);
            if (cmp != 0) return cmp < 0;
            cmp = StringComparer.OrdinalIgnoreCase.Compare(name, other.Hit.Entry.Name);
            return cmp != 0 ? cmp < 0 : StringComparer.Ordinal.Compare(name, other.Hit.Entry.Name) < 0;
        }

        bool ScanDataset(int tierRank, int remaining, string project, string dsName, DatabaseIndex read, int pIdx, bool alreadyTruncated)
        {
            var table = read.Table;
            var tierLabel = ProjectTier(project);
            var isRecent = recent.Contains(project);
            var isNamesOnly = namesOnly.Contains(project);
            var dsTruncated = alreadyTruncated;

            void Consider(int at)
            {
                var kind = table.Kind(at);
                if (kind is "bqDataset" or "bqColumn") return;
                var name = table.Name(at);
                var full = tierHits.Count >= remaining;
                var worstScore = full ? tierHits[^1].Hit.MatchRank : 4;
                // Only skip subsequence checks once the tier is both full with better-than-subsequence hits AND already marked truncated.
                var allowSubsequence = !full || worstScore >= 4 || !dsTruncated;
                var score = JumpMatchScore(name, needle, allowSubsequence);
                if (score < 0) return;
                if (full)
                {
                    dsTruncated = true;
                    if (score > worstScore || !CompareBetter(score, pIdx, dsName, name, tierHits[^1])) return;
                }
                var candidate = (new BigQueryJumpHit(project, dsName, new LookupObject(project, table, at, read), tierLabel, isRecent, isNamesOnly, tierRank, score), pIdx);
                var insertAt = tierHits.Count;
                while (insertAt > 0 && CompareBetter(score, pIdx, dsName, name, tierHits[insertAt - 1])) insertAt--;
                if (full)
                {
                    tierHits.RemoveAt(tierHits.Count - 1);
                    tierHits.Insert(insertAt, candidate);
                }
                else
                {
                    tierHits.Insert(insertAt, candidate);
                }
            }

            if (read.Facts?.Objects is Dictionary<int, BigQueryObjectFacts> objDict && objDict.Count > 0)
            {
                // Concrete Dictionary<int, T>.KeyCollection enumerator avoids boxing.
                foreach (var at in objDict.Keys)
                {
                    if (++scanned > JumpLookupLimits.MaxScanObjects) { dsTruncated = true; return dsTruncated; }
                    Consider(at);
                }
            }
            else if (read.Facts is { Objects.Count: > 0 } facts)
            {
                foreach (var pair in facts.Objects)
                {
                    if (++scanned > JumpLookupLimits.MaxScanObjects) { dsTruncated = true; return dsTruncated; }
                    Consider(pair.Key);
                }
            }
            else
            {
                for (var at = 0; at < table.Count; at++)
                {
                    if (table.Parent(at) >= 0 || table.Kind(at) == "bqDataset") continue;
                    if (++scanned > JumpLookupLimits.MaxScanObjects) { dsTruncated = true; return dsTruncated; }
                    Consider(at);
                }
            }
            return dsTruncated;
        }

        void FlushTier(bool tierTruncated)
        {
            if (tierTruncated) anyTruncated = true;
            for (var i = 0; i < tierHits.Count; i++) results.Add(tierHits[i].Hit);
            tierHits.Clear();
        }

        // Lazy tier walk: lower tiers are never sorted or enumerated when higher tiers fill the cap.
        for (var tierRank = 0; tierRank < 5; tierRank++)
        {
            var remaining = cap - results.Count;
            if (remaining <= 0)
            {
                if (TierHasAnyObject(tierRank, billingRead, resolvedDefault)) { anyTruncated = true; break; }
                continue;
            }
            var tierTruncated = false;
            switch (tierRank)
            {
                case 0:
                    if (billingRead is not null && resolvedDefault is not null && billingRead.TryGetValue(resolvedDefault, out var defRead))
                        tierTruncated = ScanDataset(0, remaining, billing, resolvedDefault, defRead, 0, tierTruncated);
                    break;
                case 1:
                    if (billingRead is not null)
                    {
                        var billingDatasets = billingRead.Keys.Where(ds => ds != resolvedDefault).Order(StringComparer.Ordinal).ToList();
                        foreach (var dsName in billingDatasets)
                        {
                            tierTruncated = ScanDataset(1, remaining, billing, dsName, billingRead[dsName], 0, tierTruncated);
                            if (scanned > JumpLookupLimits.MaxScanObjects) break;
                        }
                    }
                    break;
                default:
                    for (var pIdx = 1; pIdx < Projects.Count; pIdx++)
                    {
                        var project = Projects[pIdx];
                        var pTier = starred.Contains(project) ? 2 : recent.Contains(project) ? 3 : 4;
                        if (pTier != tierRank || !reads.TryGetValue(project, out var datasets) || datasets.Count == 0) continue;
                        var orderedDatasets = datasets.Count == 1 ? null : datasets.Keys.Order(StringComparer.Ordinal).ToList();
                        if (orderedDatasets is null)
                        {
                            foreach (var pair in datasets)
                                tierTruncated = ScanDataset(tierRank, remaining, project, pair.Key, pair.Value, pIdx, tierTruncated);
                        }
                        else
                        {
                            foreach (var dsName in orderedDatasets)
                            {
                                tierTruncated = ScanDataset(tierRank, remaining, project, dsName, datasets[dsName], pIdx, tierTruncated);
                                if (scanned > JumpLookupLimits.MaxScanObjects) break;
                            }
                        }
                        if (scanned > JumpLookupLimits.MaxScanObjects) break;
                    }
                    break;
            }
            FlushTier(tierTruncated);
            if (scanned > JumpLookupLimits.MaxScanObjects) break;
        }

        truncated = anyTruncated;
        return results;
    }

    private bool TierHasAnyObject(int tierRank, Dictionary<string, DatabaseIndex>? billingRead, string? resolvedDefault)
    {
        static bool ReadHasObject(DatabaseIndex read) => read.Facts is { Objects.Count: > 0 } || read.Table.Count > 1;
        switch (tierRank)
        {
            case 0:
                return billingRead is not null && resolvedDefault is not null && billingRead.TryGetValue(resolvedDefault, out var defRead) && ReadHasObject(defRead);
            case 1:
                if (billingRead is null) return false;
                foreach (var pair in billingRead)
                    if (pair.Key != resolvedDefault && ReadHasObject(pair.Value)) return true;
                return false;
            default:
                for (var pIdx = 1; pIdx < Projects.Count; pIdx++)
                {
                    var project = Projects[pIdx];
                    var pTier = starred.Contains(project) ? 2 : recent.Contains(project) ? 3 : 4;
                    if (pTier != tierRank || !reads.TryGetValue(project, out var datasets)) continue;
                    foreach (var read in datasets.Values)
                        if (ReadHasObject(read)) return true;
                }
                return false;
        }
    }

    /// <summary>Allocation-free fuzzy score for cross-project jump: 0 exact, 1 prefix, 2 word-boundary substring, 3 substring, 4 subsequence, -1 no match.</summary>
    internal static int JumpMatchScore(string name, string query, bool allowSubsequence = true)
    {
        if (name.Length < query.Length) return -1;
        if (string.Equals(name, query, StringComparison.OrdinalIgnoreCase)) return 0;
        if (name.StartsWith(query, StringComparison.OrdinalIgnoreCase)) return 1;
        var index = name.IndexOf(query, StringComparison.OrdinalIgnoreCase);
        if (index > 0)
        {
            var prev = name[index - 1];
            var boundary = prev is '_' or '-' or ' ' or '.' || (char.IsLower(prev) && char.IsUpper(name[index]));
            return boundary ? 2 : 3;
        }
        if (!allowSubsequence) return -1;
        var qi = 0;
        var qc = FoldAscii(query[0]);
        for (var ni = 0; ni < name.Length; ni++)
        {
            if (FoldAscii(name[ni]) == qc)
            {
                if (++qi == query.Length) return 4;
                qc = FoldAscii(query[qi]);
            }
        }
        return -1;
    }

    private static char FoldAscii(char c) => c is >= 'A' and <= 'Z' ? (char)(c | 0x20) : char.ToLowerInvariant(c);

    /// <summary>A dataset's objects (tables, views, materialized views, external tables, routines and models), in entry order.</summary>
    public IEnumerable<LookupObject> Objects(BigQueryLookupDataset dataset)
    {
        if (dataset.Held is not { } read) yield break;
        var table = read.Table;
        for (var at = 0; at < table.Count; at++)
            if (table.Parent(at) < 0 && table.Kind(at) != "bqDataset") yield return new(dataset.Project, table, at, read);
    }

    /// <summary>The object named <paramref name="name"/>: exact, else the one that differs only in case; else, for a wildcard
    /// (<c>events_*</c>, <c>events_2026*</c>) or one shard of a date-sharded group (<c>events_20260101</c>), the group's entry (its
    /// newest shard), whose columns stand for the group's.</summary>
    public LookupObject? Object(BigQueryLookupDataset dataset, string name)
    {
        if (dataset.Held is not { } read) return null;
        var table = read.Table;
        var named = (read.Lookup(budget, arraysBuilt, keepFree) is { } lookup ? lookup.Named(name) : TableLookup.ScanNamed(table, name)).Where(at => table.Kind(at) != "bqDataset").ToList();
        var exact = named.Where(at => table.Name(at) == name).ToList();
        var at = exact.Count > 0 ? exact[0] : named.Count == 1 ? named[0] : -1;
        if (at >= 0) return new(dataset.Project, table, at, read);
        // Fast exit: only datasets with shard groups can match a wildcard (*) or an 8-digit shard suffix.
        var shardGroups = read.Facts?.ShardGroups;
        if (shardGroups is null || shardGroups.Count == 0) return null;
        var isWildcard = name.EndsWith('*');
        if (!isWildcard && !HasEightDigitSuffix(name)) return null;
        if (!isWildcard)
        {
            // A concrete 8-digit shard name can only match a shard group (never a plain table).
            int found = -1, matches = 0;
            foreach (var (index, shards) in shardGroups)
            {
                if (table.Kind(index) is "bqDataset" or "bqRoutine" or "bqModel" || !ValidShards(shards)) continue;
                if (Shard(shards, name))
                {
                    found = index;
                    if (++matches > 1) return null;
                }
            }
            return matches == 1 ? new(dataset.Project, table, found, read) : null;
        }
        // Wildcard (*): check shard groups first; a whole-group match beats plain tables without scanning them.
        var stem = name[..^1];
        int whole = -1, begun = -1, wholes = 0, begins = 0;
        foreach (var (index, shards) in shardGroups)
        {
            if (table.Kind(index) is "bqDataset" or "bqRoutine" or "bqModel" || !ValidShards(shards)) continue;
            if (Shard(shards, name)) { whole = index; wholes++; }
            else if (shards.Prefix.Length > stem.Length && shards.Prefix.StartsWith(stem, StringComparison.Ordinal)) { begun = index; begins++; }
        }
        if (wholes > 0) return wholes == 1 ? new(dataset.Project, table, whole, read) : null;
        if (begins != 1) return null;
        // One group begins with stem: verify no plain table also begins with stem, without materializing all objects.
        for (var i = 0; i < table.Count; i++)
        {
            if (table.Parent(i) >= 0) continue;
            var kind = table.Kind(i);
            if (kind is "bqDataset" or "bqRoutine" or "bqModel" || (shardGroups.TryGetValue(i, out var group) && ValidShards(group))) continue;
            if (table.Name(i).StartsWith(stem, StringComparison.Ordinal)) return null;
        }
        return new(dataset.Project, table, begun, read);
    }

    private static bool ValidShards(BigQueryShardsDto shards) => shards is { First.Length: 8, Last.Length: 8 };

    private static bool HasEightDigitSuffix(string name)
    {
        if (name.Length < 9) return false;
        for (var i = name.Length - 8; i < name.Length; i++)
            if (!char.IsAsciiDigit(name[i])) return false;
        return true;
    }

    /// <summary>Which shard group a written name means, by its index among <paramref name="entries"/> (a dataset's objects, each
    /// with its group or null), or -1. A group the name covers whole (<c>events_*</c> over <c>events_YYYYMMDD</c>) wins over the
    /// tables and groups the stem only begins (<c>events_summary</c>, <c>events_intraday_</c>): it is what such a wildcard is written
    /// for. Otherwise a stem that begins two groups, or a group and a plain table, could mean either, so it means none.</summary>
    internal static int PickShardGroup(string name, IReadOnlyList<(string Name, BigQueryShardsDto? Shards)> entries)
    {
        int whole = -1, begun = -1, wholes = 0, begins = 0, plain = 0;
        var stem = name.EndsWith('*') ? name[..^1] : null;
        for (var index = 0; index < entries.Count; index++)
        {
            var (entryName, shards) = entries[index];
            if (shards is null)
            {
                if (stem is not null && entryName.StartsWith(stem, StringComparison.Ordinal)) plain++;
                continue;
            }
            if (Shard(shards, name)) { whole = index; wholes++; }
            else if (stem is not null && shards.Prefix.Length > stem.Length && shards.Prefix.StartsWith(stem, StringComparison.Ordinal)) { begun = index; begins++; }
        }
        if (wholes > 0) return wholes == 1 ? whole : -1;
        return begins == 1 && plain == 0 ? begun : -1;
    }

    /// <summary>Whether a written name covers a shard group whole: a wildcard of its prefix and up to 8 digits within the group's range
    /// (<c>events_*</c>, <c>events_2026*</c>), or one of its shards within the range. Table names tell case apart, so the prefix
    /// compares exactly.</summary>
    private static bool Shard(BigQueryShardsDto shards, string name)
    {
        var prefix = shards.Prefix;
        if (name.EndsWith('*'))
        {
            var stem = name[..^1];
            if (!stem.StartsWith(prefix, StringComparison.Ordinal)) return false;
            var digits = stem[prefix.Length..];
            return digits.Length <= 8 && digits.All(char.IsAsciiDigit)
                && string.CompareOrdinal(digits, shards.Last[..digits.Length]) <= 0 && string.CompareOrdinal(digits, shards.First[..digits.Length]) >= 0;
        }
        var suffix = name.Length == prefix.Length + 8 && name.StartsWith(prefix, StringComparison.Ordinal) ? name[prefix.Length..] : "";
        return suffix.Length == 8 && suffix.All(char.IsAsciiDigit) && string.CompareOrdinal(suffix, shards.First) >= 0 && string.CompareOrdinal(suffix, shards.Last) <= 0;
    }

    /// <summary>A table's columns and nested fields by path (address, address.city), depth first in schema order, with their types.</summary>
    public IReadOnlyList<LookupColumn> Columns(LookupObject owner)
    {
        var table = owner.Table;
        var children = owner.Source?.Lookup(budget, arraysBuilt, keepFree) is { } lookup ? lookup.Children(owner.At) : TableLookup.ScanChildren(table, owner.At);
        return [.. children.Where(at => table.Kind(at) == "bqColumn")
            .Select(at => new LookupColumn(owner with { At = at }, table.Name(at), table.Typed(at)?.Ordinal ?? 0, table.Typed(at)))
            .OrderBy(column => column.Ordinal).ThenBy(column => column.Entry.At)];
    }

    /// <summary>An object's facts beside its entry (whether pass 2 read it, rows, size, layout, a routine's signature), or null.</summary>
    public static BigQueryObjectFacts? Facts(LookupObject entry) => entry.Source?.Facts?.Of(entry.At);

    /// <summary>A sharded group's prefix, count and date range, for its newest shard's entry; null otherwise.</summary>
    public static BigQueryShardsDto? Shards(LookupObject entry) =>
        // A shard suffix is eight digits; one the regex took from another script (two UTF-16 units a digit) is left out, not sent.
        entry.Source?.Facts?.Shards(entry.At) is { First.Length: 8, Last.Length: 8 } shards ? shards : null;

    /// <summary>A column's description, or null.</summary>
    public static string? Description(LookupColumn column) => column.Entry.Source?.Facts?.Description(column.Entry.At);

    /// <summary>The name as given when <paramref name="names"/> holds it, else the one name that differs from it only in case.</summary>
    private static string? Resolve(IEnumerable<string> names, string name)
    {
        string? close = null;
        var count = 0;
        foreach (var known in names)
        {
            if (known == name) return known;
            if (string.Equals(known, name, StringComparison.OrdinalIgnoreCase) && known != close) { close = known; count++; }
        }
        return count == 1 ? close : null;
    }
}
