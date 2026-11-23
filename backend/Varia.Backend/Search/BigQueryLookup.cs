namespace Varia.Backend.Search;

/// <summary>One BigQuery dataset as the editor's lookup knows it: its name as the index holds it, its state, the read it answers
/// from (null when none is held) and the skip of its last read.</summary>
internal sealed record BigQueryLookupDataset(string Project, string Dataset, LookupState State, DatabaseIndex? Held, ObjectIndexSkip? Skip);

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
    private readonly Action? arraysBuilt;
    private readonly Dictionary<string, Dictionary<string, DatabaseIndex>> reads = new(StringComparer.Ordinal);
    private readonly HashSet<string> namesOnly;
    private readonly List<ObjectIndexSkip> skips;
    private readonly bool building, built;

    internal BigQueryLookup(string billing, IReadOnlyList<string> extras, IEnumerable<DatabaseIndex> held, IEnumerable<string>? namesOnly, IEnumerable<ObjectIndexSkip> skips,
        bool building, bool built, IndexBudget budget, Action? arraysBuilt = null)
    {
        Projects = [billing, .. extras.Where(extra => extra != billing).Distinct(StringComparer.Ordinal)];
        foreach (var read in held)
        {
            if (read.Dataset is not { } dataset) continue;
            if (!reads.TryGetValue(read.Database, out var datasets)) reads[read.Database] = datasets = new(StringComparer.Ordinal);
            datasets[dataset] = read;
        }
        this.namesOnly = [.. namesOnly ?? []];
        this.skips = [.. skips];
        (this.building, this.built, this.budget, this.arraysBuilt) = (building, built, budget, arraysBuilt);
    }

    /// <summary>The connection's billing project, then its extra projects.</summary>
    public IReadOnlyList<string> Projects { get; }

    /// <summary>Whether the connection has an index: none (never built), building, or ready (a build finished, or reads are held).</summary>
    public string Index => building ? "building" : built || reads.Count > 0 ? "ready" : "none";

    /// <summary>Whether a project's datasets were read by name only (no columns, view text or signatures).</summary>
    public bool NamesOnly(string project) => namesOnly.Contains(project);

    /// <summary>The project as the connection names it: exact, else the one that differs only in case; null when the connection has none such.</summary>
    public string? Project(string name) => Resolve(Projects, name);

    /// <summary>The state of a project as a whole: Absent when the connection has no such project, Skipped when its datasets could
    /// not be listed and none was read, Partial when its list may be short (a listing or a dataset's read failed), Building while a
    /// build that has read none of it runs, otherwise Ready.</summary>
    public LookupState ProjectState(string project)
    {
        if (Project(project) is not { } known) return LookupState.Absent;
        var listing = skips.Any(skip => skip.Project == known && skip.Database == "");
        // Datasets read before a listing that failed (or was cut) still answer, but the list may be short; so it is when a dataset
        // listed but never read is left out of it.
        if (reads.TryGetValue(known, out var held))
            return listing || skips.Any(skip => skip.Project == known && skip.Database != "" && !held.ContainsKey(skip.Database)) ? LookupState.Partial : LookupState.Ready;
        if (listing) return LookupState.Skipped;
        // Listed, but every dataset's read failed (or was refused for the budget): none answers.
        if (skips.Any(skip => skip.Project == known && skip.Database != "")) return building ? LookupState.Building : LookupState.Partial;
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
        var exactSkip = datasets?.ContainsKey(dataset) != true && skips.Any(item => item.Project == known && item.Database == dataset);
        var name = datasets is null || exactSkip ? dataset : Resolve(datasets.Keys, dataset) ?? dataset;
        var read = datasets?.GetValueOrDefault(name);
        var own = skips.LastOrDefault(item => item.Project == known && item.Database == name)
            ?? (read is null ? skips.LastOrDefault(item => item.Project == known && item.Database != "" && string.Equals(item.Database, name, StringComparison.OrdinalIgnoreCase)) : null);
        if (read is not null)
            return new(known, name, read.ChildrenLeftOut || namesOnly.Contains(known) || own is not null ? LookupState.Partial : LookupState.Ready, read, own);
        var skip = own ?? skips.LastOrDefault(item => item.Project == known && item.Database == "");
        if (skip is not null) return new(known, own?.Database ?? name, LookupState.Skipped, null, skip);
        return new(known, name, building ? LookupState.Building : LookupState.Absent, null, null);
    }

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
        var named = (read.Lookup(budget, arraysBuilt) is { } lookup ? lookup.Named(name) : TableLookup.ScanNamed(table, name)).Where(at => table.Kind(at) != "bqDataset").ToList();
        var exact = named.Where(at => table.Name(at) == name).ToList();
        var at = exact.Count > 0 ? exact[0] : named.Count == 1 ? named[0] : -1;
        if (at >= 0) return new(dataset.Project, table, at, read);
        // A wildcard reads tables only: routines and models neither match nor stand in its way.
        var entries = Objects(dataset).Where(entry => entry.Kind is not ("bqRoutine" or "bqModel")).ToList();
        var pick = PickShardGroup(name, [.. entries.Select(entry => (entry.Name, Shards(entry)))]);
        return pick >= 0 ? entries[pick] : null;
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
        var children = owner.Source?.Lookup(budget, arraysBuilt) is { } lookup ? lookup.Children(owner.At) : TableLookup.ScanChildren(table, owner.At);
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
