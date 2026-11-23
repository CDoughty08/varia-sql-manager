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
    /// not be listed, Building while a build that has read none of it runs, otherwise Ready.</summary>
    public LookupState ProjectState(string project)
    {
        if (Project(project) is not { } known) return LookupState.Absent;
        if (reads.ContainsKey(known)) return LookupState.Ready;
        if (skips.Any(skip => skip.Project == known && skip.Database == "")) return LookupState.Skipped;
        return building ? LookupState.Building : Index == "none" ? LookupState.Absent : LookupState.Ready;
    }

    /// <summary>A project's datasets the index holds a read of, by name.</summary>
    public IReadOnlyList<string> Datasets(string project) =>
        Project(project) is { } known && reads.TryGetValue(known, out var datasets) ? [.. datasets.Keys.Order(StringComparer.Ordinal)] : [];

    /// <summary>One dataset: Ready when read whole; Partial when its columns were left out (the budget, or a project read by name
    /// only) or some objects' details could not be read; Building while a build has not reached it; Skipped with its last read's
    /// skip; Absent otherwise.</summary>
    public BigQueryLookupDataset Dataset(string project, string dataset)
    {
        var known = Project(project);
        if (known is null) return new(project, dataset, LookupState.Absent, null, null);
        reads.TryGetValue(known, out var datasets);
        var name = datasets is null ? dataset : Resolve(datasets.Keys, dataset) ?? dataset;
        var read = datasets?.GetValueOrDefault(name);
        var skip = skips.LastOrDefault(item => item.Project == known && item.Database == name) ?? skips.LastOrDefault(item => item.Project == known && item.Database == "");
        if (read is not null)
            return new(known, name, read.ChildrenLeftOut || namesOnly.Contains(known) || skip?.Details == true ? LookupState.Partial : LookupState.Ready, read, skip?.Details == true ? skip : null);
        if (skip is not null) return new(known, name, LookupState.Skipped, null, skip);
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

    /// <summary>The object named <paramref name="name"/>: exact, else the one that differs only in case.</summary>
    public LookupObject? Object(BigQueryLookupDataset dataset, string name)
    {
        if (dataset.Held is not { } read) return null;
        var table = read.Table;
        var named = (read.Lookup(budget, arraysBuilt) is { } lookup ? lookup.Named(name) : TableLookup.ScanNamed(table, name)).Where(at => table.Kind(at) != "bqDataset").ToList();
        var exact = named.Where(at => table.Name(at) == name).ToList();
        var at = exact.Count > 0 ? exact[0] : named.Count == 1 ? named[0] : -1;
        return at < 0 ? null : new(dataset.Project, table, at, read);
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
    public static BigQueryShardsDto? Shards(LookupObject entry) => entry.Source?.Facts?.Shards(entry.At);

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
