using System.Runtime.InteropServices;

namespace Varia.Backend.Search;

/// <summary>The kind, folder and subtype combinations the index holds, each given a small id once per process: an object stores the
/// id, not three references. There are a few hundred combinations at most (kinds times the folders Object Explorer lists them in).</summary>
internal static class ObjectShapes
{
    /// <summary>One combination. Kind, folder and subtype are the reader's literals, so equal ones share one string.</summary>
    internal sealed record Shape(string Kind, string Folder, string? Subtype);

    private static readonly object gate = new();
    private static readonly Dictionary<(string, string, string?), ushort> ids = [];
    private static Shape[] shapes = [];

    /// <summary>The shapes known so far: a table keeps the array it was built with, which holds every id it uses.</summary>
    public static Shape[] Snapshot => Volatile.Read(ref shapes);

    public static ushort Id(string kind, string folder, string? subtype)
    {
        lock (gate)
        {
            if (ids.TryGetValue((kind, folder, subtype), out var id)) return id;
            if (shapes.Length == ushort.MaxValue) throw new InvalidOperationException("Too many object shapes.");
            id = (ushort)shapes.Length;
            Volatile.Write(ref shapes, [.. shapes, new Shape(kind, folder, subtype)]);
            ids[(kind, folder, subtype)] = id;
            return id;
        }
    }
}

/// <summary>One object in an <see cref="ObjectTable"/>: 24 bytes, against about 136 for a record of string references. Texts are
/// ids into the table's text array (-1 for none); Owner is a child's parent or a history table's table (Via), told apart by
/// <see cref="ObjectTable.ChildFlag"/>, so a child's parent kind, schema, name and folder, and the table a history table's children
/// are shown below, come from the parent instead of being stored again.</summary>
[StructLayout(LayoutKind.Sequential)]
internal struct ObjectEntry
{
    public int Name;
    public int Schema;
    public int Owner;
    public int Definition;
    /// <summary>Seconds since 1970 plus one (0: no date); a date outside what that holds is kept in the table's side list.</summary>
    public uint Modified;
    public ushort Shape;
    public byte Flags;
}

/// <summary>
/// One database's (or the server's, or the resource database's) objects, packed: an array of <see cref="ObjectEntry"/> and the
/// distinct texts they name, each once. A database read's texts are the <see cref="StringPool"/>'s copies, so the text array is
/// also the set of pool references the read holds. Read only once built; a search reads it from any thread.
/// </summary>
internal sealed class ObjectTable
{
    public const byte SystemFlag = 1, CutFlag = 2, ChildFlag = 4, RemovedFlag = 128;

    public static readonly ObjectTable Empty = new([], [], ObjectShapes.Snapshot, null);

    private readonly ObjectEntry[] entries;
    private readonly string?[] texts;
    private readonly ObjectShapes.Shape[] shapes;
    private readonly Dictionary<int, DateTime>? dates;

    private ObjectTable(ObjectEntry[] entries, string?[] texts, ObjectShapes.Shape[] shapes, Dictionary<int, DateTime>? dates)
    {
        this.entries = entries;
        this.texts = texts;
        this.shapes = shapes;
        this.dates = dates;
    }

    public int Count => entries.Length;
    /// <summary>The distinct texts the entries name (null where one was given back, see <see cref="WithTexts"/>).</summary>
    public IReadOnlyList<string?> Texts => texts;
    /// <summary>The shapes the entries' ids index (for a per-search lookup such as which kinds a search keeps).</summary>
    public IReadOnlyList<ObjectShapes.Shape> Shapes => shapes;

    public ushort ShapeOf(int at) => entries[at].Shape;
    public string Kind(int at) => shapes[entries[at].Shape].Kind;
    public string Folder(int at) => shapes[entries[at].Shape].Folder;
    public string? Subtype(int at) => shapes[entries[at].Shape].Subtype;
    public string Name(int at) => texts[entries[at].Name]!;
    public string? Schema(int at) => Text(entries[at].Schema);
    public string? Definition(int at) => Text(entries[at].Definition);
    public bool DefinitionCut(int at) => (entries[at].Flags & CutFlag) != 0;
    public bool System(int at) => (entries[at].Flags & SystemFlag) != 0;
    public DateTime? Modified(int at) => Date(entries[at].Modified, at, dates);
    /// <summary>A child's parent (a column's table, a parameter's procedure), or -1.</summary>
    public int Parent(int at) => (entries[at].Flags & ChildFlag) != 0 ? entries[at].Owner : -1;
    /// <summary>The table a history table, or a history table's child, is shown below, or -1.</summary>
    public int Via(int at)
    {
        ref readonly var entry = ref entries[at];
        // A child's parent is never a child itself, so its owner is the table it is shown below, if any.
        return (entry.Flags & ChildFlag) == 0 ? entry.Owner : entries[entry.Owner].Owner;
    }
    public string? ParentKind(int at) => Parent(at) is var parent and >= 0 ? Kind(parent) : null;
    public string? ParentSchema(int at) => Parent(at) is var parent and >= 0 ? Schema(parent) : null;
    public string? ParentName(int at) => Parent(at) is var parent and >= 0 ? Name(parent) : null;
    public string? ParentFolder(int at) => Parent(at) is var parent and >= 0 ? Folder(parent) : null;

    /// <summary>What the results show and a name search with a dot matches: schema.name, or the parent's for a child.</summary>
    public string Label(int at) => Schema(at) is { } schema ? schema + "." + Name(at) : Parent(at) is var parent and >= 0 ? Schema(parent) + "." + Name(parent) + "." + Name(at) : Name(at);

    /// <summary><see cref="Label"/>'s length, without building it: a search reads it for every name it scans.</summary>
    public int LabelLength(int at)
    {
        ref readonly var entry = ref entries[at];
        var name = texts[entry.Name]!.Length;
        if (entry.Schema >= 0) return texts[entry.Schema]!.Length + 1 + name;
        if ((entry.Flags & ChildFlag) == 0) return name;
        ref readonly var parent = ref entries[entry.Owner];
        return (parent.Schema >= 0 ? texts[parent.Schema]!.Length : 0) + texts[parent.Name]!.Length + 2 + name;
    }

    private string? Text(int id) => id < 0 ? null : texts[id];

    /// <summary>The object as a record: for checks and diagnostics, never a search's scan.</summary>
    public IndexedObject Row(int at)
    {
        var via = Via(at);
        return new(Kind(at), Folder(at), Schema(at), Name(at), ParentKind(at), ParentSchema(at), ParentName(at), Modified(at), Definition(at), DefinitionCut(at), System(at),
            Subtype(at), ParentFolder(at), via >= 0 ? Row(via) : null);
    }

    public IEnumerable<IndexedObject> Rows()
    {
        for (var at = 0; at < entries.Length; at++) yield return Row(at);
    }

    /// <summary>This table with each text swapped for <paramref name="swap"/>'s (the pool's copy). Where the swap answers null for
    /// a definition, the entries that named it keep no definition. A text that is also a name must be swapped.</summary>
    public ObjectTable WithTexts(string?[] swap)
    {
        var copy = (ObjectEntry[])entries.Clone();
        for (var at = 0; at < copy.Length; at++)
        {
            if (copy[at].Name >= 0 && swap[copy[at].Name] is null || copy[at].Schema >= 0 && swap[copy[at].Schema] is null) throw new ArgumentException("A name has no text.");
            if (copy[at].Definition >= 0 && swap[copy[at].Definition] is null) { copy[at].Definition = -1; copy[at].Flags &= unchecked((byte)~CutFlag); }
        }
        return new(copy, swap, shapes, dates);
    }

    /// <summary>For each text, whether an entry names it as a name or schema (as against only as a definition).</summary>
    public bool[] NameTexts()
    {
        var names = new bool[texts.Length];
        foreach (var entry in entries)
        {
            names[entry.Name] = true;
            if (entry.Schema >= 0) names[entry.Schema] = true;
        }
        return names;
    }

    private static uint Encode(DateTime? value)
    {
        if (value is not { } date) return 0;
        var seconds = (date - DateTime.UnixEpoch).Ticks / TimeSpan.TicksPerSecond;
        return date >= DateTime.UnixEpoch && seconds < uint.MaxValue ? (uint)(seconds + 1) : uint.MaxValue;
    }

    private static DateTime? Date(uint value, int at, Dictionary<int, DateTime>? dates) => value switch
    {
        0 => null,
        uint.MaxValue => dates![at],
        _ => DateTime.UnixEpoch.AddSeconds(value - 1)
    };

    /// <summary>A table of <paramref name="rows"/> as they are (for checks, benchmarks and tests): a child's parent is the row
    /// before it with the parent's kind, schema and name that is not itself a child, and a history table's Via is found by equality.
    /// A child whose parent is not among the rows, or a Via that is not, is refused.</summary>
    public static ObjectTable Of(IEnumerable<IndexedObject> rows)
    {
        var list = rows.ToList();
        var builder = new Builder();
        foreach (var row in list)
        {
            builder.Text(row.Name);
            if (row.Schema is not null) builder.Text(row.Schema);
            if (row.Definition is not null) builder.Text(row.Definition);
        }
        var parents = new Dictionary<(string, string?, string), int>();
        for (var at = 0; at < list.Count; at++)
        {
            var row = list[at];
            var added = builder.Add(row);
            if (row.Definition is not null) builder.SetDefinition(added, row.Definition, row.DefinitionCut);
            if (row.ParentName is null) { parents.TryAdd((row.Kind, row.Schema, row.Name), added); continue; }
            if (!parents.TryGetValue((row.ParentKind!, row.ParentSchema, row.ParentName), out var parent)) throw new ArgumentException("A child's parent is not in the table: " + row.Label);
            builder.Attach(added, parent, row.System);
        }
        for (var at = 0; at < list.Count; at++)
            if (list[at] is { ParentName: null, Via: { } via })
            {
                var found = list.FindIndex(row => row == via);
                if (found < 0) throw new ArgumentException("A history table's table is not in the table: " + list[at].Label);
                builder.SetVia(at, found);
            }
        return builder.Build();
    }

    /// <summary>Builds a table: texts first take ids, then entries name them. Entries may be attached to their owner later (a read
    /// places children once every parent is read) and removed (a child whose parent the login cannot see); <see cref="Build"/>
    /// leaves removed entries out.</summary>
    internal sealed class Builder
    {
        private ObjectEntry[] entries = new ObjectEntry[64];
        private readonly List<string?> texts = [];
        private readonly Dictionary<string, int> ids = new(StringComparer.Ordinal);
        private Dictionary<int, DateTime>? dates;
        private int removed;

        public int Count { get; private set; }
        /// <summary>Every text that took an id, in id order.</summary>
        public IReadOnlyList<string?> Texts => texts;

        /// <summary>The id of <paramref name="value"/>, taking one when it has none.</summary>
        public int Text(string value)
        {
            if (ids.TryGetValue(value, out var id)) return id;
            ids[value] = texts.Count;
            texts.Add(value);
            return texts.Count - 1;
        }

        public bool TryText(string value, out string held)
        {
            if (ids.TryGetValue(value, out var id)) { held = texts[id]!; return true; }
            held = "";
            return false;
        }

        public bool TryText(ReadOnlySpan<char> value, out string held)
        {
            if (ids.GetAlternateLookup<ReadOnlySpan<char>>().TryGetValue(value, out var id)) { held = texts[id]!; return true; }
            held = "";
            return false;
        }

        /// <summary>Adds <paramref name="row"/>, whose texts already have ids; its parent and Via are attached separately.</summary>
        public int Add(IndexedObject row) =>
            Add(row.Kind, row.Folder, row.Subtype, row.Schema, row.Name, row.Modified, row.System);

        public int Add(string kind, string folder, string? subtype, string? schema, string name, DateTime? modified, bool system)
        {
            if (Count == entries.Length) Array.Resize(ref entries, entries.Length * 2);
            var encoded = Encode(modified);
            if (encoded == uint.MaxValue) (dates ??= [])[Count] = modified!.Value;
            entries[Count] = new ObjectEntry
            {
                Name = ids[name], Schema = schema is null ? -1 : ids[schema], Owner = -1, Definition = -1, Modified = encoded,
                Shape = ObjectShapes.Id(kind, folder, subtype), Flags = system ? SystemFlag : (byte)0
            };
            return Count++;
        }

        public string Kind(int at) => ObjectShapes.Snapshot[entries[at].Shape].Kind;
        public string Folder(int at) => ObjectShapes.Snapshot[entries[at].Shape].Folder;
        public string? Subtype(int at) => ObjectShapes.Snapshot[entries[at].Shape].Subtype;
        public bool HasSchema(int at) => entries[at].Schema >= 0;
        public bool System(int at) => (entries[at].Flags & SystemFlag) != 0;
        public bool Removed(int at) => (entries[at].Flags & RemovedFlag) != 0;
        public bool HasDefinition(int at) => entries[at].Definition >= 0;

        /// <summary>Makes <paramref name="at"/> a child of <paramref name="parent"/>, with the system flag a child takes from it.</summary>
        public void Attach(int at, int parent, bool system)
        {
            entries[at].Owner = parent;
            entries[at].Flags = (byte)((entries[at].Flags & ~SystemFlag & ~ChildFlag) | ChildFlag | (system ? SystemFlag : 0));
        }

        /// <summary>Names the table a history table is shown below.</summary>
        public void SetVia(int at, int table) => entries[at].Owner = table;

        public void SetDefinition(int at, string text, bool cut)
        {
            entries[at].Definition = ids[text];
            entries[at].Flags = (byte)(cut ? entries[at].Flags | CutFlag : entries[at].Flags & ~CutFlag);
        }

        public void Remove(int at)
        {
            if (Removed(at)) return;
            entries[at].Flags |= RemovedFlag;
            removed++;
        }

        /// <summary>The table, without removed entries (or entries whose owner was removed), its owners renumbered.</summary>
        public ObjectTable Build()
        {
            // An owner removed after its child was attached takes the child with it (a child's own owner is never a child).
            for (var pass = 0; pass < 2 && removed > 0; pass++)
                for (var at = 0; at < Count; at++)
                    if (!Removed(at) && entries[at].Owner >= 0 && Removed(entries[at].Owner)) Remove(at);
            var map = removed == 0 ? null : new int[Count];
            var kept = new ObjectEntry[Count - removed];
            Dictionary<int, DateTime>? keptDates = null;
            for (int at = 0, to = 0; at < Count; at++)
            {
                if (Removed(at)) continue;
                if (map is not null) map[at] = to;
                kept[to] = entries[at];
                if (kept[to].Modified == uint.MaxValue) (keptDates ??= [])[to] = dates![at];
                to++;
            }
            if (map is not null)
                for (var at = 0; at < kept.Length; at++)
                    if (kept[at].Owner >= 0) kept[at].Owner = map[kept[at].Owner];
            return new(kept, [.. texts], ObjectShapes.Snapshot, keptDates);
        }

        /// <summary>Forgets every entry and text (after the read handed them over or gave them back).</summary>
        public void Clear()
        {
            entries = new ObjectEntry[64];
            texts.Clear();
            ids.Clear();
            dates = null;
            removed = 0;
            Count = 0;
        }
    }
}
