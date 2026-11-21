namespace Varia.Backend.Search;

/// <summary>How far the index can answer for one database.</summary>
internal enum LookupState
{
    /// <summary>Read whole by the last build (or this one).</summary>
    Ready,
    /// <summary>Read, with something left out (<see cref="LookupGaps"/>).</summary>
    Partial,
    /// <summary>A build is running and has not read it yet; what an earlier build read, if anything, still answers.</summary>
    Building,
    /// <summary>The last read of it failed (<see cref="LookupDatabase.Skip"/>); an earlier read, if any, still answers.</summary>
    Skipped,
    /// <summary>The index knows no such database.</summary>
    Absent
}

/// <summary>What a read left out of a database.</summary>
[Flags]
internal enum LookupGaps : byte
{
    None = 0,
    /// <summary>No columns, indexes, keys, statistics or parameters: with them it did not fit (CHILDREN_LEFT_OUT).</summary>
    ChildrenLeftOut = 1,
    /// <summary>Read by a build without definitions.</summary>
    DefinitionsLeftOut = 2,
    /// <summary>Some definitions cut at the per-module limit, or left out once the budget was spent.</summary>
    DefinitionsCut = 4
}

/// <summary>What the index knows of one database: its state and gaps, the skip of its last read, when the read it answers from
/// finished, and whether its names tell case apart (null: not known, compared without case).</summary>
internal sealed record LookupDatabase(string Database, LookupState State, LookupGaps Gaps, ObjectIndexSkip? Skip, DateTime? ReadAt, bool? CaseSensitive)
{
    /// <summary>The read the database answers from, or null.</summary>
    internal DatabaseIndex? Held { get; init; }
}

/// <summary>One indexed object: the table that holds it, its entry, the database it shows in, and (for a database's own objects,
/// not the shared resource database's) the read it came from, whose lookup arrays find its children.</summary>
internal readonly record struct LookupObject(string Database, ObjectTable Table, int At, DatabaseIndex? Source)
{
    public string Kind => Table.Kind(At);
    public string? Subtype => Table.Subtype(At);
    public string? Schema => Table.Schema(At);
    public string Name => Table.Name(At);
    /// <summary>A column's, parameter's or scalar function's type, or null.</summary>
    public TypedDetail? Type => Table.Typed(At);
}

/// <summary>A column or parameter of an object, by ordinal (column_id, parameter_id).</summary>
internal sealed record LookupColumn(LookupObject Entry, string Name, short Ordinal, TypedDetail? Type);

/// <summary>A column of an index or key, by name (null where the index holds no column with its column_id).</summary>
internal sealed record LookupKeyColumn(string? Name, short ColumnId, bool Descending, bool Included);

/// <summary>An index (Kind index) or primary or unique key (Kind key) of a table, view or table type, with its columns: key
/// columns in key order, then included ones.</summary>
internal sealed record LookupIndex(LookupObject Entry, string Kind, string? Subtype, IReadOnlyList<LookupKeyColumn> Columns);

/// <summary>A foreign key: its table, the table it references (null where the index does not hold it) and its column pairs.</summary>
internal sealed record LookupForeignKey(LookupObject Entry, LookupObject Table, LookupObject? Referenced, IReadOnlyList<(string? Column, string? ReferencedColumn)> Pairs);

/// <summary>An answer with the state of the database it came from, so a caller tells "none" from "not known yet".</summary>
internal sealed record LookupAnswer<T>(LookupDatabase Database, T Value);

/// <summary>
/// One table's lookup arrays, 4 bytes per entry and per foreign key: its entries without a parent sorted by name (case ignored),
/// its children sorted by parent, and its foreign keys sorted by the table they reference. Each range is found by binary search
/// against the table itself, so the arrays hold only entry indexes. Built once per read, on its first lookup.
/// </summary>
internal sealed class TableLookup
{
    private readonly ObjectTable table;
    private readonly int[] byName, children, foreignKeys;

    private TableLookup(ObjectTable table, int[] byName, int[] children, int[] foreignKeys) =>
        (this.table, this.byName, this.children, this.foreignKeys) = (table, byName, children, foreignKeys);

    /// <summary>What <see cref="Build"/> holds for <paramref name="table"/>, before it is built (so the budget can refuse it).</summary>
    public static long BytesFor(ObjectTable table) => 4L * (table.Count + (table.Details?.ForeignKeyCount ?? 0));

    public static TableLookup Build(ObjectTable table)
    {
        var top = new List<int>();
        var childKeys = new List<long>();
        for (var at = 0; at < table.Count; at++)
        {
            var parent = table.Parent(at);
            if (parent < 0) top.Add(at);
            else childKeys.Add(((long)parent << 32) | (uint)at);
        }
        var names = top.ToArray();
        Array.Sort(names, (a, b) => StringComparer.OrdinalIgnoreCase.Compare(table.Name(a), table.Name(b)) is var order and not 0 ? order : a.CompareTo(b));
        var sorted = childKeys.ToArray();
        Array.Sort(sorted);
        var kids = Array.ConvertAll(sorted, key => (int)(key & 0xFFFFFFFF));
        var keys = table.Details?.ForeignKeys().OrderBy(key => key.Referenced).ThenBy(key => key.At).Select(key => key.At).ToArray() ?? [];
        return new(table, names, kids, keys);
    }

    /// <summary>The entries without a parent whose name equals <paramref name="name"/> with case ignored, in entry order.</summary>
    public IEnumerable<int> Named(string name)
    {
        for (var item = LowerBound(byName, at => StringComparer.OrdinalIgnoreCase.Compare(table.Name(at), name)); item < byName.Length && string.Equals(table.Name(byName[item]), name, StringComparison.OrdinalIgnoreCase); item++)
            yield return byName[item];
    }

    /// <summary>The children of <paramref name="parent"/>, in entry order.</summary>
    public IEnumerable<int> Children(int parent)
    {
        for (var item = LowerBound(children, at => table.Parent(at).CompareTo(parent)); item < children.Length && table.Parent(children[item]) == parent; item++)
            yield return children[item];
    }

    /// <summary>The foreign keys that reference <paramref name="referenced"/>, in entry order.</summary>
    public IEnumerable<int> Referencing(int referenced)
    {
        for (var item = LowerBound(foreignKeys, at => table.Referenced(at).CompareTo(referenced)); item < foreignKeys.Length && table.Referenced(foreignKeys[item]) == referenced; item++)
            yield return foreignKeys[item];
    }

    /// <summary>The first item whose entry compares at or after the key (<paramref name="compare"/> answers entry minus key).</summary>
    private static int LowerBound(int[] items, Func<int, int> compare)
    {
        int low = 0, high = items.Length;
        while (low < high)
        {
            var middle = low + (high - low) / 2;
            if (compare(items[middle]) < 0) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    /// <summary>The same ranges, by scanning a table with no lookup arrays (the shared resource database's, or a read whose arrays
    /// the budget refused).</summary>
    public static IEnumerable<int> ScanNamed(ObjectTable table, string name)
    {
        for (var at = 0; at < table.Count; at++)
            if (table.Parent(at) < 0 && string.Equals(table.Name(at), name, StringComparison.OrdinalIgnoreCase)) yield return at;
    }

    public static IEnumerable<int> ScanChildren(ObjectTable table, int parent)
    {
        for (var at = 0; at < table.Count; at++)
            if (table.Parent(at) == parent) yield return at;
    }

    public static IEnumerable<int> ScanReferencing(ObjectTable table, int referenced) =>
        table.Details?.ForeignKeys().Where(key => key.Referenced == referenced).Select(key => key.At) ?? [];
}

/// <summary>
/// The editor's in-process view of a connection's index (no IPC): objects by database, schema and name, their columns,
/// parameters, indexes, keys and foreign keys in and out, each answer with its database's state. A snapshot of the build's state
/// when it was made; the databases it answers from are the reads held then, which never change.
/// Names compare as the database's catalog collation does for case (<see cref="DatabaseIndex.CaseSensitive"/>; without case where
/// that is unknown), ordinally otherwise: an accent- or kana-insensitive collation is not followed.
/// </summary>
internal sealed class IndexLookup
{
    private readonly IndexBudget budget;
    private readonly Dictionary<string, DatabaseIndex> held;
    private readonly ResourceSet? resource;
    private readonly bool building;
    private readonly DateTime? buildStarted;
    private readonly IReadOnlySet<string> listed;
    private readonly IReadOnlyDictionary<string, ObjectIndexSkip> skipped;

    internal IndexLookup(ConnectionIndex index, IndexBudget budget, bool building, DateTime? buildStarted, IReadOnlySet<string> listed, IReadOnlyDictionary<string, ObjectIndexSkip> skipped)
    {
        this.budget = budget;
        held = index.Databases.ToDictionary(value => value.Database, StringComparer.Ordinal);
        resource = index.Resource;
        this.building = building;
        this.buildStarted = buildStarted;
        this.listed = listed;
        this.skipped = skipped;
    }

    /// <summary>The database's name as the index knows it: as given, else the one name that differs from it only in case.</summary>
    private string Resolve(string name)
    {
        if (held.ContainsKey(name) || listed.Contains(name) || skipped.ContainsKey(name)) return name;
        var close = held.Keys.Concat(listed).Concat(skipped.Keys).Where(known => string.Equals(known, name, StringComparison.OrdinalIgnoreCase)).Distinct(StringComparer.Ordinal).ToList();
        return close.Count == 1 ? close[0] : name;
    }

    public LookupDatabase Database(string name)
    {
        var database = Resolve(name);
        held.TryGetValue(database, out var read);
        // A read without children is reported as a skip too, but it is a partial read: its gap says so.
        if (skipped.TryGetValue(database, out var skip) && skip.Code == ObjectSearchService.ChildrenLeftOut) skip = null;
        var gaps = read is null ? LookupGaps.None
            : (read.ChildrenLeftOut ? LookupGaps.ChildrenLeftOut : 0) | (read.DefinitionsLeftOut ? LookupGaps.DefinitionsLeftOut : 0) | (read.Cut > 0 ? LookupGaps.DefinitionsCut : 0);
        var state = read is null ? skip is not null ? LookupState.Skipped : building && listed.Contains(database) ? LookupState.Building : LookupState.Absent
            : skip is not null ? LookupState.Skipped
            : building && (buildStarted is not { } started || read.ReadAt < started) ? LookupState.Building
            : gaps != LookupGaps.None ? LookupState.Partial : LookupState.Ready;
        return new(database, state, gaps, skip, read?.ReadAt, read?.CaseSensitive) { Held = read };
    }

    /// <summary>The objects named <paramref name="name"/> in <paramref name="schema"/> (any schema when null) of a database, its own
    /// and the resource database's (sys, INFORMATION_SCHEMA), optionally only of <paramref name="kinds"/>. Children (columns, keys)
    /// are found through their object. Several answers mean the name is ambiguous (no schema given) or the kinds overlap.</summary>
    public LookupAnswer<IReadOnlyList<LookupObject>> Objects(string database, string? schema, string name, IReadOnlySet<string>? kinds = null)
    {
        var known = Database(database);
        var found = new List<LookupObject>();
        var comparison = known.CaseSensitive == true ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;
        void Collect(ObjectTable table, IEnumerable<int> named, DatabaseIndex? source)
        {
            foreach (var at in named)
                if (string.Equals(table.Name(at), name, comparison) && (schema is null || string.Equals(table.Schema(at), schema, comparison))
                    && (kinds is null || kinds.Contains(table.Kind(at))))
                    found.Add(new(known.Database, table, at, source));
        }
        if (known.Held is { } read) Collect(read.Table, read.Lookup(budget) is { } lookup ? lookup.Named(name) : TableLookup.ScanNamed(read.Table, name), read);
        if (resource is not null && known.State != LookupState.Absent) Collect(resource.Table, TableLookup.ScanNamed(resource.Table, name), null);
        return new(known, found);
    }

    private IEnumerable<int> Children(LookupObject owner) =>
        owner.Source?.Lookup(budget) is { } lookup ? lookup.Children(owner.At) : TableLookup.ScanChildren(owner.Table, owner.At);

    private List<LookupColumn> Typed(LookupObject owner, string kind) =>
        [.. Children(owner).Where(at => owner.Table.Kind(at) == kind)
            .Select(at => new LookupColumn(owner with { At = at }, owner.Table.Name(at), owner.Table.Typed(at)?.Ordinal ?? 0, owner.Table.Typed(at)))
            .OrderBy(column => column.Ordinal).ThenBy(column => column.Entry.At)];

    /// <summary>A table's, view's, table type's or table-valued function's columns, by column_id.</summary>
    public IReadOnlyList<LookupColumn> Columns(LookupObject owner) => Typed(owner, "column");

    /// <summary>A procedure's or function's parameters, by parameter_id (a scalar function's return is the function's own type).</summary>
    public IReadOnlyList<LookupColumn> Parameters(LookupObject owner) => Typed(owner, "parameter");

    /// <summary>Each column's name by column_id.</summary>
    private Dictionary<short, string> ColumnNames(LookupObject owner)
    {
        var names = new Dictionary<short, string>();
        foreach (var column in Columns(owner)) names.TryAdd(column.Ordinal, column.Name);
        return names;
    }

    /// <summary>A table's, view's or table type's indexes and primary and unique keys, in entry order.</summary>
    public IReadOnlyList<LookupIndex> Indexes(LookupObject owner)
    {
        var names = ColumnNames(owner);
        var table = owner.Table;
        return [.. Children(owner).Where(at => table.Kind(at) == "index" || table.Kind(at) == "key" && table.Subtype(at) is "primary" or "unique")
            .Select(at => new LookupIndex(owner with { At = at }, table.Kind(at), table.Subtype(at),
                [.. table.KeyColumns(at).Select(column => new LookupKeyColumn(names.GetValueOrDefault(column.Column), column.Column,
                    (column.Flags & KeyColumnFlags.Descending) != 0, (column.Flags & KeyColumnFlags.Included) != 0))]))];
    }

    /// <summary>The foreign keys of a table, to the tables they reference.</summary>
    public IReadOnlyList<LookupForeignKey> ForeignKeys(LookupObject owner)
    {
        var table = owner.Table;
        return [.. Children(owner).Where(at => table.Kind(at) == "key" && table.Subtype(at) == "foreign").Select(at => ForeignKey(owner, at))];
    }

    /// <summary>The foreign keys of other tables (and the table's own, if it references itself) that reference a table.</summary>
    public IReadOnlyList<LookupForeignKey> ReferencedBy(LookupObject owner)
    {
        var keys = owner.Source?.Lookup(budget) is { } lookup ? lookup.Referencing(owner.At) : TableLookup.ScanReferencing(owner.Table, owner.At);
        return [.. keys.Select(at => ForeignKey(owner with { At = owner.Table.Parent(at) }, at))];
    }

    private LookupForeignKey ForeignKey(LookupObject owner, int at)
    {
        var table = owner.Table;
        var target = table.Referenced(at);
        LookupObject? referenced = target >= 0 ? owner with { At = target } : null;
        var names = ColumnNames(owner);
        var otherNames = referenced is { } other ? other.At == owner.At ? names : ColumnNames(other) : new Dictionary<short, string>();
        return new(owner with { At = at }, owner, referenced,
            [.. table.KeyColumns(at).Select(column => (names.GetValueOrDefault(column.Column), otherNames.GetValueOrDefault(column.Referenced)))]);
    }
}
