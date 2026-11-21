namespace Varia.Backend.Search;

/// <summary>How far the index can answer for one database.</summary>
internal enum LookupState
{
    /// <summary>Its last read was whole.</summary>
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
    DefinitionsCut = 4,
    /// <summary>The connection holds no resource database set (its read failed), so sys and INFORMATION_SCHEMA objects are unknown.</summary>
    SystemObjectsLeftOut = 8
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

    /// <summary>Every object that is not a child, for a comparison the name ranges cannot narrow.</summary>
    public static IEnumerable<int> ScanTop(ObjectTable table)
    {
        for (var at = 0; at < table.Count; at++)
            if (table.Parent(at) < 0) yield return at;
    }

    public static IEnumerable<int> ScanChildren(ObjectTable table, int parent)
    {
        for (var at = 0; at < table.Count; at++)
            if (table.Parent(at) == parent) yield return at;
    }

    public static IEnumerable<int> ScanReferencing(ObjectTable table, int referenced) =>
        table.Details?.ForeignKeys().Where(key => key.Referenced == referenced).Select(key => key.At) ?? [];
}

/// <summary>Case-insensitive equality as Turkish and Azeri collations have it: i and İ are one letter, ı and I another.</summary>
internal static class TurkishCase
{
    private static char Fold(char letter) => letter switch { 'i' => 'İ', 'ı' => 'I', _ => char.ToUpperInvariant(letter) };

    public static bool Same(string left, string right)
    {
        if (left.Length != right.Length) return false;
        for (var at = 0; at < left.Length; at++)
            if (Fold(left[at]) != Fold(right[at])) return false;
        return true;
    }
}

/// <summary>
/// What the editor's lookup needs to know of a connection's builds, kept across them (the state's gate guards it): when the
/// running or last build started, the databases its listing named, and each database whose last read failed, with that skip
/// and when. A database's next whole read (or one without its children, which is partial, not failed) clears its skip; a build
/// that is stopped, or whose listing fails, leaves the skips of the databases it did not reach as they were; a listing drops
/// the skips of databases it no longer names.
/// </summary>
internal sealed class LookupLedger
{
    private long? started;
    private HashSet<string> listed = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (ObjectIndexSkip Skip, long At)> skips = new(StringComparer.Ordinal);

    /// <summary>What a lookup reads, copied. Times are <see cref="IndexClock"/> stamps.</summary>
    internal sealed record View(long? Started, IReadOnlySet<string> Listed, IReadOnlyDictionary<string, (ObjectIndexSkip Skip, long At)> Skips);

    public void Start() => started = IndexClock.Next();

    public void List(IEnumerable<string> names)
    {
        listed = names.ToHashSet(StringComparer.Ordinal);
        foreach (var name in skips.Keys.Where(name => !listed.Contains(name)).ToList()) skips.Remove(name);
    }

    public void Done(string database, ObjectIndexSkip? skip)
    {
        if (skip is null or { Code: ObjectSearchService.ChildrenLeftOut }) skips.Remove(database);
        else skips[database] = (skip, IndexClock.Next());
    }

    public View Snapshot() => new(started, listed.ToHashSet(StringComparer.Ordinal), new Dictionary<string, (ObjectIndexSkip, long)>(skips, StringComparer.Ordinal));
}

/// <summary>
/// The editor's in-process view of a connection's index (no IPC): objects by database, schema and name, their columns,
/// parameters, indexes, keys and foreign keys in and out. <see cref="Database"/> and <see cref="Objects"/> answer with the
/// database's state; the other calls take an object one of them found. A snapshot of the build's state when it was made; the
/// databases it answers from are the reads held then, which never change. Make one per request and let it go: one kept across a
/// rebuild or a disconnect keeps the reads it holds alive outside the index's memory budget.
/// Names compare as the database's catalog collation does for case (<see cref="DatabaseIndex.CaseSensitive"/>; without case where
/// that is unknown), ordinally otherwise: only case (and the Turkish i) is followed, not accent, kana or width insensitivity or
/// characters a collation ignores.
/// </summary>
internal sealed class IndexLookup
{
    private readonly IndexBudget budget;
    private readonly Dictionary<string, DatabaseIndex> held;
    private readonly ResourceSet? resource;
    private readonly bool building;
    private readonly long? buildStarted;
    private readonly IReadOnlySet<string> listed;
    private readonly IReadOnlyDictionary<string, (ObjectIndexSkip Skip, long At)> skipped;
    private readonly Action? arraysBuilt;

    internal IndexLookup(ConnectionIndex index, IndexBudget budget, bool building, LookupLedger.View builds, Action? arraysBuilt = null)
    {
        this.budget = budget;
        this.arraysBuilt = arraysBuilt;
        held = index.Databases.ToDictionary(value => value.Database, StringComparer.Ordinal);
        resource = index.Resource;
        this.building = building;
        (buildStarted, listed, skipped) = (builds.Started, builds.Listed, builds.Skips);
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
        var failed = skipped.TryGetValue(database, out var last) ? last : ((ObjectIndexSkip Skip, long At)?)null;
        // A read held since the skip was recorded supersedes it (the build records its outcome just after holding it).
        if (failed is { } skip && read is not null && skip.At < read.Stamp) failed = null;
        var gaps = read is null ? LookupGaps.None
            : (read.ChildrenLeftOut ? LookupGaps.ChildrenLeftOut : 0) | (read.DefinitionsLeftOut ? LookupGaps.DefinitionsLeftOut : 0) | (read.Cut > 0 ? LookupGaps.DefinitionsCut : 0)
                | (resource is null ? LookupGaps.SystemObjectsLeftOut : 0);
        // A running build has reached a database once it has an outcome in it: a read, or a skip, since it started.
        var reached = buildStarted is not { } started || read?.Stamp >= started || failed?.At >= started;
        var known = read is not null || failed is not null || listed.Contains(database);
        var state = building && known && !reached ? LookupState.Building
            : failed is not null || read?.FailedPart == true ? LookupState.Skipped
            : read is null ? LookupState.Absent
            : gaps != LookupGaps.None ? LookupState.Partial : LookupState.Ready;
        return new(database, state, gaps, failed?.Skip, read?.ReadAt, read?.CaseSensitive) { Held = read };
    }

    /// <summary>The objects named <paramref name="name"/> in <paramref name="schema"/> (any schema when null) of a database, its own
    /// and the resource database's (sys, INFORMATION_SCHEMA), optionally only of <paramref name="kinds"/>. Children (columns, keys)
    /// are found through their object. Several answers mean the name is ambiguous (no schema given) or the kinds overlap.</summary>
    public LookupAnswer<IReadOnlyList<LookupObject>> Objects(string database, string? schema, string name, IReadOnlySet<string>? kinds = null)
    {
        var known = Database(database);
        var found = new List<LookupObject>();
        // Turkish and Azeri collations pair i with İ and ı with I, which OrdinalIgnoreCase (and so the name arrays) does not.
        var dotted = known.CaseSensitive != true && known.Held?.DottedI == true;
        Func<string, string, bool> same = known.CaseSensitive == true ? string.Equals
            : dotted ? TurkishCase.Same : (left, right) => string.Equals(left, right, StringComparison.OrdinalIgnoreCase);
        void Collect(ObjectTable table, IEnumerable<int> named, DatabaseIndex? source)
        {
            foreach (var at in named)
                if (same(table.Name(at), name) && (schema is null || same(table.Schema(at) ?? "", schema)) && (kinds is null || kinds.Contains(table.Kind(at))))
                    found.Add(new(known.Database, table, at, source));
        }
        IEnumerable<int> Scan(ObjectTable table) => dotted ? TableLookup.ScanTop(table) : TableLookup.ScanNamed(table, name);
        if (known.Held is { } read) Collect(read.Table, !dotted && read.Lookup(budget, arraysBuilt) is { } lookup ? lookup.Named(name) : Scan(read.Table), read);
        if (resource is not null && known.State != LookupState.Absent) Collect(resource.Table, Scan(resource.Table), null);
        return new(known, found);
    }

    private IEnumerable<int> Children(LookupObject owner) =>
        owner.Source?.Lookup(budget, arraysBuilt) is { } lookup ? lookup.Children(owner.At) : TableLookup.ScanChildren(owner.Table, owner.At);

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
        var keys = owner.Source?.Lookup(budget, arraysBuilt) is { } lookup ? lookup.Referencing(owner.At) : TableLookup.ScanReferencing(owner.Table, owner.At);
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
